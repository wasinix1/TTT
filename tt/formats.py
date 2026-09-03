"""Formats.

Every format answers one question: which match is ready to go on a table now?
That is the whole interface. Group stage, bracket, Swiss and open play differ
only in how they answer it, which is why they can share a table pool.

Replay safety: `on_result` may only mutate existing matches (filling bracket
slots). Anything that *creates* a match happens in `start` / `tick` /
`next_match`, which run at request time and emit events into the log.
"""

import math
from collections import defaultdict

from .models import Scoring


# ----------------------------------------------------------------- matching

def anchor_pair(entries, dist, tol, penalty):
    """Pair the longest waiter with its best available opponent.

    Deliberately not a global optimum. Minimum-weight matching over the whole
    queue will happily starve an outlier all evening because the optimum keeps
    pairing everyone else. Anchoring on wait time and widening the tolerance is
    what guarantees everybody plays.

    The rematch penalty is priced in strength units and counts against the
    tolerance itself, not just the ranking. That interaction matters: with a
    hard distance limit alone, the two weakest teams in a lopsided field sit
    permanently inside each other's tolerance, never get passed over, so the
    tolerance never widens and they play each other all night.
    """
    for a in entries:
        limit = tol(a)
        best, best_key = None, None
        for b in entries:
            if b is a:
                continue
            cost = dist(a, b) + penalty(a, b)
            if cost > limit:
                continue
            key = (cost, -b.passes, b.joined_seq)
            if best_key is None or key < best_key:
                best, best_key = b, key
        if best is not None:
            return a, best
    return None


def seed_positions(size: int) -> list[int]:
    """Standard bracket order: 1 plays the lowest seed, 2 sits in the far half."""
    order = [0]
    while len(order) < size:
        m = len(order) * 2
        nxt = []
        for x in order:
            nxt.append(x)
            nxt.append(m - 1 - x)
        order = nxt
    return order


def round_name(remaining: int) -> str:
    return {2: "Final", 4: "Semi-final", 8: "Quarter-final"}.get(
        remaining, f"Round of {remaining}")


def circle_fixtures(ids: list[str]) -> list[tuple[int, str, str]]:
    """Round-robin schedule. Returns (round, a, b)."""
    ps = list(ids)
    if len(ps) < 2:
        return []
    bye = None
    if len(ps) % 2:
        bye = "__bye__"
        ps.append(bye)
    n = len(ps)
    out = []
    for r in range(n - 1):
        for i in range(n // 2):
            a, b = ps[i], ps[n - 1 - i]
            if bye not in (a, b):
                out.append((r, a, b) if r % 2 == 0 else (r, b, a))
        ps = [ps[0]] + [ps[-1]] + ps[1:-1]
    return out


# -------------------------------------------------------------- base format

class Format:
    kind = "base"
    label = "Format"
    default_priority = 0        # lower goes first when tables are scarce

    def __init__(self, fid, name, config):
        self.id = fid
        self.name = name or self.label
        self.config = dict(config or {})
        self.status = self.config.get("status", "setup")
        self.phase = self.config.get("phase", "")
        self.entrant_ids = list(self.config.get("entrant_ids", []))

    def priority(self) -> int:
        return int(self.config.get("priority", self.default_priority))

    def cup_id(self):
        return self.config.get("cup_id") or None

    # -- config helpers
    def scoring(self) -> Scoring:
        return Scoring.from_dict(self.config.get("scoring"))

    def uses_queue(self) -> bool:
        return False

    # -- lifecycle
    def start(self, store):
        self.status = "running"

    def tick(self, store):
        """Phase transitions and round generation. Runtime only."""
        return

    def next_match(self, store, busy, force=False):
        """Return a match id ready to be seated, or None.

        `force` means a table is free and nothing else could fill it, so pair
        the best available option regardless of the strength tolerance."""
        return None

    def on_result(self, store, match):
        return

    def is_complete(self, store) -> bool:
        ms = [m for m in store.matches.values()
              if m.format_id == self.id and m.status != "void"]
        return bool(ms) and all(m.status == "done" for m in ms)

    # -- reporting
    def standings(self, store):
        return []

    def view(self, store):
        return {}

    def to_dict(self, store):
        return {
            "id": self.id, "kind": self.kind, "name": self.name,
            "status": self.status, "phase": self.phase, "priority": self.priority(),
            "cup_id": self.cup_id(),
            "config": self.config, "entrant_ids": self.entrant_ids,
            "uses_queue": self.uses_queue(),
            "standings": self.standings(store),
            "view": self.view(store),
            "complete": self.is_complete(store),
        }

    # -- shared: pull ready pre-generated matches
    def _pending(self, store, busy, order_key=None):
        cands = [
            m for m in store.matches.values()
            if m.format_id == self.id and m.status == "pending" and m.is_filled()
            and store.entrant_available(m.entrant_a, busy)
            and store.entrant_available(m.entrant_b, busy)
        ]
        if not cands:
            return None
        cands.sort(key=order_key or (lambda m: (m.meta.get("round", 0), m.seq)))
        return cands[0].id


# ------------------------------------------------------------------ helpers

def _record(store, fid, group=None):
    """Per-entrant results table for round robin / Swiss."""
    rec = defaultdict(lambda: dict(
        played=0, won=0, lost=0, gw=0, gl=0, pw=0, pl=0, opp=[]))
    for m in store.matches.values():
        if m.format_id != fid or m.status != "done":
            continue
        if group is not None and m.meta.get("group") != group:
            continue
        if m.meta.get("bye"):
            r = rec[m.meta["bye"]]          # a bye is worth a full point
            r["played"] += 1
            r["won"] += 1
            continue
        if not (m.entrant_a and m.entrant_b):
            continue
        gw = sum(1 for g in m.games if g[0] > g[1])
        gl = sum(1 for g in m.games if g[1] > g[0])
        pa = sum(g[0] for g in m.games)
        pb = sum(g[1] for g in m.games)
        for eid, w, l, pf, pa_, opp in (
            (m.entrant_a, gw, gl, pa, pb, m.entrant_b),
            (m.entrant_b, gl, gw, pb, pa, m.entrant_a),
        ):
            r = rec[eid]
            r["played"] += 1
            r["gw"] += w
            r["gl"] += l
            r["pw"] += pf
            r["pl"] += pa_
            r["opp"].append(opp)
            if (m.winner == "a") == (eid == m.entrant_a):
                r["won"] += 1
            else:
                r["lost"] += 1
    return rec


def _table(store, rec, eids, extra=None):
    rows = []
    for eid in eids:
        r = rec.get(eid, dict(played=0, won=0, lost=0, gw=0, gl=0, pw=0, pl=0))
        row = {
            "entrant_id": eid, "name": store.entrant_name(eid),
            "played": r["played"], "won": r["won"], "lost": r["lost"],
            "games": f"{r['gw']}:{r['gl']}", "game_diff": r["gw"] - r["gl"],
            "points": f"{r['pw']}:{r['pl']}", "point_diff": r["pw"] - r["pl"],
        }
        if extra:
            row.update(extra(eid, r))
        rows.append(row)
    rows.sort(key=lambda x: (-x["won"], -x["game_diff"], -x["point_diff"], x["name"]))
    for i, r in enumerate(rows, 1):
        r["rank"] = i
    return rows


def build_bracket(store, fid, seeded, scoring, third_place=False, prefix="ko"):
    """Create a single-elimination bracket. Byes never become matches."""
    n = len(seeded)
    if n < 2:
        return
    size = 2 ** math.ceil(math.log2(n))
    order = seed_positions(size)
    slots = [seeded[i] if i < n else None for i in range(size)]
    placed = [slots[p] for p in order]

    rounds = int(math.log2(size))
    # wire from the final backwards so ids are deterministic
    ids = {(r, i): f"{fid}_{prefix}r{r}m{i}"
           for r in range(rounds) for i in range(size // 2 ** (r + 1))}

    carry = {}          # (round, index, slot) -> entrant advanced by a bye
    for r in range(rounds):
        count = size // 2 ** (r + 1)
        for i in range(count):
            feeds = None
            if r + 1 < rounds:
                feeds = [ids[(r + 1, i // 2)], "a" if i % 2 == 0 else "b"]
            meta = {"round": r, "slot": i, "phase": "ko",
                    "round_name": round_name(count * 2)}
            if feeds:
                meta["feeds"] = feeds
            if r == 0:
                a, b = placed[2 * i], placed[2 * i + 1]
                if a and not b or b and not a:
                    # bye: push straight through, create nothing
                    if feeds:
                        carry[(feeds[0], feeds[1])] = a or b
                    continue
                if not a and not b:
                    continue
            else:
                a = carry.pop((ids[(r, i)], "a"), None)
                b = carry.pop((ids[(r, i)], "b"), None)
            if third_place and r == rounds - 2 and count == 2:
                meta["loser_feeds"] = [f"{fid}_{prefix}_third",
                                       "a" if i == 0 else "b"]
            store.create_match(
                id=ids[(r, i)], format_id=fid, entrant_a=a, entrant_b=b,
                label=meta["round_name"], meta=meta, scoring=scoring.to_dict(),
            )
    if third_place and rounds >= 2:
        store.create_match(
            id=f"{fid}_{prefix}_third", format_id=fid,
            label="Third place",
            meta={"round": rounds, "slot": 0, "phase": "ko",
                  "round_name": "Third place"},
            scoring=scoring.to_dict(),
        )


def bracket_view(store, fid):
    ms = [m for m in store.matches.values()
          if m.format_id == fid and m.meta.get("phase") == "ko"]
    if not ms:
        return None
    by_round = defaultdict(list)
    for m in ms:
        by_round[m.meta.get("round", 0)].append(m)
    out = []
    for r in sorted(by_round):
        items = sorted(by_round[r], key=lambda m: m.meta.get("slot", 0))
        out.append({
            "round": r,
            "name": items[0].meta.get("round_name", f"Round {r+1}"),
            "matches": [{
                "id": m.id, "status": m.status,
                "a": store.entrant_name(m.entrant_a) if m.entrant_a else None,
                "b": store.entrant_name(m.entrant_b) if m.entrant_b else None,
                "winner": m.winner, "games": m.games, "table": m.table,
            } for m in items],
        })
    return out


def ko_on_result(store, m):
    feeds = m.meta.get("feeds")
    if feeds:
        winner = m.entrant_a if m.winner == "a" else m.entrant_b
        store.fill_slot(feeds[0], feeds[1], winner)
    lf = m.meta.get("loser_feeds")
    if lf:
        loser = m.entrant_b if m.winner == "a" else m.entrant_a
        store.fill_slot(lf[0], lf[1], loser)


# ---------------------------------------------------------------- open play

class OpenPlay(Format):
    kind = "open_play"
    label = "Open play"
    # open play is the filler that keeps spare tables warm; a scheduled draw
    # always gets first call on a free table and on the players it needs
    default_priority = 10

    def uses_queue(self):
        return True

    def start(self, store):
        self.status = "running"

    def mode(self):
        return self.config.get("mode", "pairs")   # pairs | singles | scramble

    def _entries(self, store, busy):
        out = [q for q in store.queue
               if q.format_id == self.id and store.entrant_available(q.entrant_id, busy)]
        out.sort(key=lambda q: (-q.passes, q.joined_seq))
        return out

    def min_entries(self):
        return 4 if self.mode() == "scramble" else 2

    def next_match(self, store, busy, force=False):
        entries = self._entries(store, busy)
        if len(entries) < self.min_entries():
            return None
        if self.mode() == "scramble":
            return self._scramble(store, entries, force)

        gap = float(self.config.get("base_gap", 1.5))
        # a "pass" is one match dispatched to some table while you waited, so
        # with three tables one full turn of the room is about three passes
        widen = max(1, int(self.config.get("widen_every", 3)))
        step = float(self.config.get("widen_step", 1.0))
        w_rematch = (float(self.config.get("rematch_weight", 0.6))
                     if self.config.get("avoid_rematch", True) else 0.0)
        meets = store.meetings()

        def dist(a, b):
            return abs(store.entrant_strength(a.entrant_id)
                       - store.entrant_strength(b.entrant_id))

        cap = float(self.config.get("max_gap", 4.0))

        def tol(a):
            if force:
                return 99.0        # an idle table is worse than a mismatch
            return min(gap + (a.passes // widen) * step, cap)

        def penalty(a, b):
            return w_rematch * meets.get(frozenset((a.entrant_id, b.entrant_id)), 0)

        found = anchor_pair(entries, dist, tol, penalty)
        if not found:
            return None
        a, b = found
        return store.create_match(
            format_id=self.id, entrant_a=a.entrant_id, entrant_b=b.entrant_id,
            label="Open play", meta={"phase": "open"},
            scoring=self.scoring().to_dict(),
        )

    # -- scramble doubles: four solo entrants, partners assigned on the spot
    def _scramble(self, store, entries, force=False):
        lam = float(self.config.get("imbalance_lambda", 0.5))
        w_partner = float(self.config.get("partner_repeat_weight", 1.5))
        pool = entries[:8]
        anchor = pool[0]
        partners = store.partnerships()
        meets = store.meetings()
        tolerance = 99.0 if force else min(
            float(self.config.get("base_gap", 1.5)) +
            (anchor.passes // max(1, int(self.config.get("widen_every", 3)))) *
            float(self.config.get("widen_step", 1.0)),
            float(self.config.get("max_gap", 4.0)))

        def eff(x, y):
            """Doubles strength is not additive: a 5 with a 1 plays below two 3s,
            because the weak partner gets served at until they crack."""
            return (x + y) / 2 - lam * abs(x - y)

        best, best_key = None, None
        rest = pool[1:]
        for i in range(len(rest)):
            for j in range(i + 1, len(rest)):
                for k in range(j + 1, len(rest)):
                    four = [anchor, rest[i], rest[j], rest[k]]
                    for split in ((0, 1, 2, 3), (0, 2, 1, 3), (0, 3, 1, 2)):
                        pa = (four[split[0]], four[split[1]])
                        pb = (four[split[2]], four[split[3]])
                        sa = eff(*[store.entrant_strength(q.entrant_id) for q in pa])
                        sb = eff(*[store.entrant_strength(q.entrant_id) for q in pb])
                        imb = abs(sa - sb)
                        rep = 0.0
                        for p in (pa, pb):
                            ids = frozenset(
                                store.entrants[q.entrant_id].player_ids[0] for q in p)
                            rep += partners.get(ids, 0) * w_partner
                        rep += meets.get(frozenset(
                            (pa[0].entrant_id, pb[0].entrant_id)), 0) * 0.2
                        if imb + rep > tolerance:      # repeats cost tolerance too
                            continue
                        key = (round(imb + rep, 3), -sum(q.passes for q in four),
                               sum(q.joined_seq for q in four))
                        if best_key is None or key < best_key:
                            best, best_key = (pa, pb), key
        if not best:
            return None
        pa, pb = best
        side_a = [store.entrants[q.entrant_id].player_ids[0] for q in pa]
        side_b = [store.entrants[q.entrant_id].player_ids[0] for q in pb]
        names_a = " / ".join(store.entrant_name(q.entrant_id) for q in pa)
        names_b = " / ".join(store.entrant_name(q.entrant_id) for q in pb)
        return store.create_match(
            format_id=self.id, side_a=side_a, side_b=side_b,
            label="Scramble doubles",
            meta={"phase": "open", "scramble": True,
                  "queued": [q.entrant_id for q in pa + pb],
                  "name_a": names_a, "name_b": names_b},
            scoring=self.scoring().to_dict(),
        )

    def standings(self, store):
        rec = _record(store, self.id)
        ids = sorted(rec.keys(), key=lambda e: store.entrant_name(e))
        return [{"group": "Open play", "rows": _table(store, rec, ids)}] if ids else []

    def is_complete(self, store):
        return False


# --------------------------------------------------------------- round robin

class GroupStage(Format):
    kind = "groups"
    label = "Groups"

    def start(self, store):
        self.status = "running"
        self.phase = "groups"
        ids = list(self.entrant_ids)
        ids.sort(key=lambda e: -store.entrant_strength(e))
        n = max(1, int(self.config.get("n_groups", 1)))
        groups = [[] for _ in range(n)]
        for i, eid in enumerate(ids):                    # snake seeding
            row = i // n
            col = i % n if row % 2 == 0 else n - 1 - (i % n)
            groups[col].append(eid)
        sc = self.scoring().to_dict()
        for gi, members in enumerate(groups):
            gname = chr(ord("A") + gi)
            for rnd, a, b in circle_fixtures(members):
                store.create_match(
                    format_id=self.id, entrant_a=a, entrant_b=b,
                    label=f"Group {gname}",
                    meta={"group": gname, "round": rnd, "phase": "groups"},
                    scoring=sc,
                )

    def _group_names(self, store):
        return sorted({m.meta.get("group") for m in store.matches.values()
                       if m.format_id == self.id and m.meta.get("phase") == "groups"}
                      - {None})

    def tick(self, store):
        if self.phase != "groups" or not self.config.get("then_ko"):
            return
        gm = [m for m in store.matches.values()
              if m.format_id == self.id and m.meta.get("phase") == "groups"]
        if not gm or any(m.status != "done" for m in gm):
            return
        adv = max(1, int(self.config.get("advance_per_group", 2)))
        qualified = []
        for gname in self._group_names(store):
            rows = self.standings(store)
            table = next(g["rows"] for g in rows if g["group"] == f"Group {gname}")
            qualified.append([r["entrant_id"] for r in table[:adv]])
        # cross-seed: all group winners first, then all runners-up reversed
        seeded = []
        for place in range(adv):
            tier = [g[place] for g in qualified if len(g) > place]
            seeded.extend(tier if place % 2 == 0 else list(reversed(tier)))
        ko_sc = Scoring.from_dict(self.config.get("ko_scoring") or self.config.get("scoring"))
        build_bracket(store, self.id, seeded, ko_sc,
                      third_place=bool(self.config.get("third_place")))
        self.phase = "ko"
        store.append("format_update", {"id": self.id, "phase": "ko"})

    def next_match(self, store, busy, force=False):
        return self._pending(store, busy, order_key=lambda m: (
            0 if m.meta.get("phase") == "groups" else 1,
            m.meta.get("round", 0), m.meta.get("group", ""), m.seq))

    def on_result(self, store, m):
        if m.meta.get("phase") == "ko":
            ko_on_result(store, m)

    def standings(self, store):
        out = []
        for gname in self._group_names(store):
            rec = _record(store, self.id, group=gname)
            ids = [e for e in self.entrant_ids
                   if any(m.meta.get("group") == gname
                          and e in (m.entrant_a, m.entrant_b)
                          for m in store.matches.values() if m.format_id == self.id)]
            out.append({"group": f"Group {gname}", "rows": _table(store, rec, ids)})
        return out

    def view(self, store):
        return {"bracket": bracket_view(store, self.id)}


class SingleElim(Format):
    kind = "single_elim"
    label = "Knockout"

    def start(self, store):
        self.status = "running"
        self.phase = "ko"
        ids = list(self.entrant_ids)
        ids.sort(key=lambda e: -store.entrant_strength(e))
        build_bracket(store, self.id, ids, self.scoring(),
                      third_place=bool(self.config.get("third_place")))

    def next_match(self, store, busy, force=False):
        return self._pending(store, busy)

    def on_result(self, store, m):
        ko_on_result(store, m)

    def view(self, store):
        return {"bracket": bracket_view(store, self.id)}


# --------------------------------------------------------------------- swiss

class Swiss(Format):
    kind = "swiss"
    label = "Swiss"

    def uses_queue(self):
        return bool(self.config.get("continuous"))

    def start(self, store):
        self.status = "running"
        self.phase = "swiss"
        if not self.config.get("continuous"):
            self._generate_round(store, 0)

    def _score(self, store):
        rec = _record(store, self.id)
        return {e: rec.get(e, {"won": 0})["won"] for e in self.entrant_ids}

    def _rounds_done(self, store):
        rs = [m.meta.get("round", 0) for m in store.matches.values()
              if m.format_id == self.id and m.status != "void"]
        return max(rs) + 1 if rs else 0

    def _eligible(self, store, e):
        """Same bar as entrant_available, minus the busy check: a player sat
        out mid-tournament must not keep getting drawn into new rounds."""
        ent = store.entrants.get(e)
        if not ent or not ent.active:
            return False
        return all(store.players[p].active for p in ent.player_ids if p in store.players)

    def _generate_round(self, store, rnd):
        score = self._score(store)
        meets = store.meetings()
        pool = sorted([e for e in self.entrant_ids if self._eligible(store, e)],
                      key=lambda e: (-score.get(e, 0), -store.entrant_strength(e)))
        byes = {m.meta.get("bye") for m in store.matches.values()
                if m.format_id == self.id and m.meta.get("bye")}
        if len(pool) % 2:
            # prefer someone who hasn't had a bye yet; if the field has
            # shrunk enough that everyone left already has, give it to the
            # weakest-ranked entrant anyway rather than silently dropping them
            pick = next((e for e in reversed(pool) if e not in byes), pool[-1])
            pool.remove(pick)
            store.create_match(
                format_id=self.id, entrant_a=pick, entrant_b=None,
                label=f"Round {rnd+1} bye", status="done",
                meta={"round": rnd, "phase": "swiss", "bye": pick},
                scoring=self.scoring().to_dict(),
            )
        used, pairs = set(), []
        for i, a in enumerate(pool):
            if a in used:
                continue
            used.add(a)
            partner = None
            for b in pool[i + 1:]:
                if b in used:
                    continue
                if meets.get(frozenset((a, b)), 0) == 0:
                    partner = b
                    break
            if partner is None:                     # rematch unavoidable
                for b in pool[i + 1:]:
                    if b not in used:
                        partner = b
                        break
            if partner:
                used.add(partner)
                pairs.append((a, partner))
        sc = self.scoring().to_dict()
        for a, b in pairs:
            store.create_match(
                format_id=self.id, entrant_a=a, entrant_b=b,
                label=f"Round {rnd+1}",
                meta={"round": rnd, "phase": "swiss"}, scoring=sc,
            )

    def tick(self, store):
        if self.status != "running" or self.phase == "ko":
            return
        if self.config.get("continuous"):
            return
        total = int(self.config.get("rounds", 5))
        cur = self._rounds_done(store)
        if cur == 0:
            return
        if cur >= total:
            if self.config.get("then_ko"):
                self._start_ko(store)
            return
        live = [m for m in store.matches.values()
                if m.format_id == self.id and m.meta.get("round") == cur - 1
                and m.status not in ("done", "void")]
        if not live:
            self._generate_round(store, cur)

    def _start_ko(self, store):
        """Cross into the knockout stage: top N by standings, seeded bracket.
        Shared by the normal end-of-rounds transition and the manual cut."""
        if self.phase == "ko":
            return
        blocks = self.standings(store)
        rows = blocks[0]["rows"] if blocks else []
        adv = max(2, int(self.config.get("advance", 4)))
        seeded = [r["entrant_id"] for r in rows[:adv]]
        if len(seeded) < 2:
            return
        ko_sc = Scoring.from_dict(self.config.get("ko_scoring") or self.config.get("scoring"))
        build_bracket(store, self.id, seeded, ko_sc,
                      third_place=bool(self.config.get("third_place")))
        self.phase = "ko"
        store.append("format_update", {"id": self.id, "phase": "ko"})

    def cut_to_ko(self, store):
        """Admin override: stop the Swiss short of its planned rounds (or end
        a continuous one) and build the bracket from standings as they stand
        right now. Anything not yet seated on a table is scrapped."""
        if self.phase == "ko" or self.status != "running":
            return
        stray = [m for m in store.matches.values()
                 if m.format_id == self.id and m.status == "pending"]
        for m in stray:
            store.append("match_void", {"match_id": m.id})
        self._start_ko(store)

    def next_match(self, store, busy, force=False):
        if self.phase == "ko" or not self.config.get("continuous"):
            return self._pending(store, busy)
        entries = [q for q in store.queue
                   if q.format_id == self.id
                   and store.entrant_available(q.entrant_id, busy)]
        entries.sort(key=lambda q: (-q.passes, q.joined_seq))
        if len(entries) < 2:
            return None
        score = self._score(store)
        meets = store.meetings()
        gap = float(self.config.get("base_gap", 1.0))
        widen = max(1, int(self.config.get("widen_every", 3)))

        found = anchor_pair(
            entries,
            dist=lambda a, b: abs(score.get(a.entrant_id, 0) - score.get(b.entrant_id, 0)),
            tol=lambda a: 99.0 if force else min(gap + a.passes // widen, 6.0),
            penalty=lambda a, b: 1.2 * meets.get(
                frozenset((a.entrant_id, b.entrant_id)), 0),
        )
        if not found:
            return None
        a, b = found
        return store.create_match(
            format_id=self.id, entrant_a=a.entrant_id, entrant_b=b.entrant_id,
            label="Swiss", meta={"phase": "swiss", "round": self._rounds_done(store)},
            scoring=self.scoring().to_dict(),
        )

    def standings(self, store):
        rec = _record(store, self.id)
        wins = {e: rec.get(e, {"won": 0})["won"] for e in self.entrant_ids}

        def extra(eid, r):
            buch = sum(wins.get(o, 0) for o in r.get("opp", []))
            return {"buchholz": buch}

        rows = _table(store, rec, self.entrant_ids, extra=extra)
        rows.sort(key=lambda x: (-x["won"], -x.get("buchholz", 0),
                                 -x["game_diff"], -x["point_diff"]))
        for i, r in enumerate(rows, 1):
            r["rank"] = i
        return [{"group": self.name, "rows": rows}]

    def on_result(self, store, m):
        if m.meta.get("phase") == "ko":
            ko_on_result(store, m)

    def view(self, store):
        return {"bracket": bracket_view(store, self.id)}

    def is_complete(self, store):
        if self.phase == "ko":
            return super().is_complete(store)
        if self.config.get("continuous"):
            return False
        return super().is_complete(store) and \
            self._rounds_done(store) >= int(self.config.get("rounds", 5))


KINDS = {f.kind: f for f in (OpenPlay, GroupStage, SingleElim, Swiss)}


def build_format(fid, kind, name, config):
    cls = KINDS.get(kind)
    if not cls:
        raise ValueError(f"unknown format kind {kind!r}")
    return cls(fid, name, config)
