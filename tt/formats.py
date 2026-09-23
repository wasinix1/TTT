"""Formats.

Every format answers one question: which match is ready to go on a table now?
That is the whole interface. Group stage, bracket, Swiss and open play differ
only in how they answer it, which is why they can share a table pool.

Replay safety: `on_result` may only mutate existing matches (filling bracket
slots). Anything that *creates* a match happens in `start` / `tick` /
`commit`, which run at request time and emit events into the log.

Deciding and committing are deliberately separate. `propose` works out what
this format would put on a table and changes nothing; `Proposal.commit` is
what actually writes it to the log. That split is what lets the dispatcher
ask every cup what it wants *before* choosing between them, instead of
handing the table to the first format that answered — which is how one cup
used to take every table all evening.
"""

import math
from collections import defaultdict

from .models import Scoring


class Proposal:
    """A match a format is offering to put on a table. Nothing is written
    until `commit`, so proposals can be compared, ranked and thrown away."""

    __slots__ = ("format_id", "match_id", "create", "entrants")

    def __init__(self, format_id, match_id=None, create=None, entrants=()):
        self.format_id = format_id
        self.match_id = match_id          # an already-scheduled fixture
        self.create = create              # or kwargs for a new pairing
        self.entrants = tuple(entrants)   # who it takes out of the queue

    def commit(self, store) -> str:
        if self.match_id:
            return self.match_id
        return store.create_match(**self.create)


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

    def takes_new_entrants(self) -> bool:
        """Whether somebody admitted now can still join this draw. A group
        stage or a bracket that has been drawn cannot: its fixtures already
        exist. Pairing-on-demand formats can, right up to the last match."""
        return self.status == "setup"

    def queue_candidates(self, store):
        """Who belongs in this format's queue when they are not on a table:
        the whole draw, unless the format has a reason to say otherwise."""
        return list(self.entrant_ids)

    # -- lifecycle
    def start(self, store):
        self.status = "running"

    def tick(self, store):
        """Phase transitions and round generation. Runtime only."""
        return

    def propose(self, store, busy, force=False):
        """Return a Proposal for the match this format wants to seat, or None.

        Must not change anything: the dispatcher asks several formats and
        uses at most one answer. `force` means a table is free and nothing
        else could fill it, so offer the best available pairing regardless
        of the strength tolerance."""
        return None

    def remaining_work(self, store):
        """Matches this format still has to play, or None if it is open-ended.

        Drives the share of tables it gets when cups compete: the cup with
        the most left to do is furthest from finishing, so it needs them
        most. An open-ended format returns None and only fills gaps."""
        return None

    def can_redispatch_pending(self) -> bool:
        """Whether a match of this format, left pending, will find its way
        onto a table again. False for anything that pairs on demand: those
        matches are created at the moment they are seated, so one that gets
        unseated is an orphan nothing will ever pick up."""
        return True

    def _scheduled_remaining(self, store):
        return sum(1 for m in store.matches.values()
                   if m.format_id == self.id and m.status in ("pending", "live"))

    def on_result(self, store, match):
        return

    # -- the cut into a knockout, and keeping it honest afterwards
    def _qualifiers(self, store):
        """Who the bracket would be drawn from if it were drawn right now,
        in seed order. None for a format that has no cut."""
        return None

    def _build_ko(self, store, seeded):
        """Draw the bracket and remember what it was drawn from, so a later
        correction can be noticed rather than silently disagreed with."""
        ko_sc = Scoring.from_dict(self.config.get("ko_scoring")
                                  or self.config.get("scoring"))
        build_bracket(store, self.id, seeded, ko_sc,
                      third_place=bool(self.config.get("third_place")))
        self.phase = "ko"
        self.config["ko_seeds"] = list(seeded)
        store.append("format_update", {"id": self.id, "phase": "ko",
                                       "config": {"ko_seeds": list(seeded)}})

    def _ko_matches(self, store):
        return [m for m in store.matches.values()
                if m.format_id == self.id and m.meta.get("phase") == "ko"
                and m.status != "void"]

    def bracket_stale(self, store) -> bool:
        """True when the standings no longer agree with who is in the draw.

        A group score entered backwards and put right an hour later changes
        who should have qualified, and nothing downstream noticed: group and
        Swiss matches carry no bracket wiring, so there is nothing for an
        undo to unwind. The table and the bracket just quietly disagreed."""
        if self.phase != "ko":
            return False
        want = self._qualifiers(store)
        if want is None:
            return False
        have = self.config.get("ko_seeds")
        if have is None:
            return False            # drawn before this was recorded
        return list(want) != list(have)

    def _maybe_redraw(self, store):
        """Redraw the bracket after a correction — but only while nobody has
        played in it. Once a knockout match is under way, a wrong seed is a
        far smaller problem than wiping a round people already played, so it
        is reported to the organiser instead and left for them to decide."""
        if not self.bracket_stale(store):
            return
        if any(m.status in ("done", "live") for m in self._ko_matches(store)):
            return
        want = self._qualifiers(store)
        if len(want) < 2:
            return
        for m in self._ko_matches(store):
            store.append("match_void", {"match_id": m.id})
        self._build_ko(store, want)

    def is_complete(self, store) -> bool:
        ms = [m for m in store.matches.values()
              if m.format_id == self.id and m.status != "void"]
        return bool(ms) and all(m.status == "done" for m in ms)

    def warnings(self, store):
        """Things about this draw an organiser would want to know before
        they bite, in plain words. Information only — nothing here changes
        what the draw does, because the shape of somebody's tournament is
        not a decision this should be making on its own at ten past seven."""
        return []

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
            "bracket_stale": self.bracket_stale(store),
            "warnings": self.warnings(store),
        }

    def order_key(self, m):
        """The order this format wants its fixtures seated in. The board
        shows people their place in exactly this order, so it has to be the
        same function the dispatcher uses, not a second guess at it.

        A match put back goes behind everything else, which is the whole
        point of putting it back."""
        return (m.meta.get("deferred", 0), m.meta.get("round", 0), m.seq)

    def pending_fixtures(self, store):
        return sorted((m for m in store.matches.values()
                       if m.format_id == self.id and m.status == "pending"
                       and m.is_filled()), key=self.order_key)

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
        cands.sort(key=order_key or self.order_key)
        m = cands[0]
        return Proposal(self.id, match_id=m.id,
                        entrants=[e for e in (m.entrant_a, m.entrant_b) if e])


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
        row["withdrawn"] = store.withdrawn(eid)
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
    # A semi-final that is a bye is not a match, so it has no loser to send
    # to the third-place play-off — which then sits half-filled for ever,
    # keeps the draw from ever reading as complete, and shows a permanent
    # "to be decided" on the wall. Only offer it when both semis are real.
    third_place = bool(third_place) and rounds >= 2 and (rounds > 2 or n == size)
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
    # a voided bracket is a bracket that was thrown away — a reset or a redo —
    # and drawing it is how an old run kept haunting the next one
    ms = [m for m in store.matches.values()
          if m.format_id == fid and m.meta.get("phase") == "ko"
          and m.status != "void"]
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

    def takes_new_entrants(self):
        return self.status != "done"

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

    def can_redispatch_pending(self):
        return False          # open play pairs at the moment of seating

    def propose(self, store, busy, force=False):
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
        return Proposal(self.id, create=dict(
            format_id=self.id, entrant_a=a.entrant_id, entrant_b=b.entrant_id,
            label="Open play", meta={"phase": "open"},
            scoring=self.scoring().to_dict(),
        ), entrants=[a.entrant_id, b.entrant_id])

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
        drawn = [q.entrant_id for q in pa + pb]
        return Proposal(self.id, create=dict(
            format_id=self.id, side_a=side_a, side_b=side_b,
            label="Scramble doubles",
            meta={"phase": "open", "scramble": True,
                  "queued": drawn,
                  "name_a": names_a, "name_b": names_b},
            scoring=self.scoring().to_dict(),
        ), entrants=drawn)

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
        ids = [e for e in self.entrant_ids if not store.withdrawn(e)]
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

    def warnings(self, store):
        n = max(1, int(self.config.get("n_groups", 1)))
        field = len([e for e in self.entrant_ids if not store.withdrawn(e)])
        out = []
        if field and field < 2 * n:
            short = n - field // 2
            out.append(
                f"{field} in {n} groups leaves {short} group"
                f"{'' if short == 1 else 's'} with one entrant and nobody to "
                f"play — they get no matches at all and cannot qualify. "
                f"{max(1, field // 2)} groups or fewer fits this field.")
        return out

    def _group_names(self, store):
        return sorted({m.meta.get("group") for m in store.matches.values()
                       if m.format_id == self.id and m.meta.get("phase") == "groups"}
                      - {None})

    def _qualifiers(self, store):
        adv = max(1, int(self.config.get("advance_per_group", 2)))
        blocks = self.standings(store)
        qualified = []
        for gname in self._group_names(store):
            rows = next((g["rows"] for g in blocks
                         if g["group"] == f"Group {gname}"), [])
            # somebody who went home does not take a place in the bracket
            # with them, or the first thing the knockout does is walk them over
            live = [r["entrant_id"] for r in rows
                    if not store.withdrawn(r["entrant_id"])]
            qualified.append(live[:adv])
        # cross-seed: all group winners first, then all runners-up reversed
        seeded = []
        for place in range(adv):
            tier = [g[place] for g in qualified if len(g) > place]
            seeded.extend(tier if place % 2 == 0 else list(reversed(tier)))
        return seeded

    def tick(self, store):
        if not self.config.get("then_ko"):
            return
        if self.phase == "ko":
            self._maybe_redraw(store)
            return
        if self.phase != "groups":
            return
        gm = [m for m in store.matches.values()
              if m.format_id == self.id and m.meta.get("phase") == "groups"]
        # a voided group match is one that was thrown away, not one still to
        # be played; treating it as outstanding held the knockout for ever
        if not gm or any(m.status not in ("done", "void") for m in gm):
            return
        seeded = self._qualifiers(store)
        if len(seeded) < 2:
            return
        self._build_ko(store, seeded)

    def order_key(self, m):
        return (m.meta.get("deferred", 0),
                0 if m.meta.get("phase") == "groups" else 1,
                m.meta.get("round", 0), m.meta.get("group", ""), m.seq)

    def propose(self, store, busy, force=False):
        return self._pending(store, busy)

    def remaining_work(self, store):
        left = self._scheduled_remaining(store)
        if self.phase == "groups" and self.config.get("then_ko"):
            # the bracket does not exist yet, but it is still work this cup
            # has to get through, and the table share has to account for it
            adv = max(1, int(self.config.get("advance_per_group", 2)))
            n = adv * max(1, len(self._group_names(store)))
            left += max(0, n - 1) + (1 if self.config.get("third_place") else 0)
        return left

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
        ids = [e for e in self.entrant_ids if not store.withdrawn(e)]
        ids.sort(key=lambda e: -store.entrant_strength(e))
        build_bracket(store, self.id, ids, self.scoring(),
                      third_place=bool(self.config.get("third_place")))

    def propose(self, store, busy, force=False):
        return self._pending(store, busy)

    def remaining_work(self, store):
        return self._scheduled_remaining(store)

    def on_result(self, store, m):
        ko_on_result(store, m)

    def view(self, store):
        return {"bracket": bracket_view(store, self.id)}


# --------------------------------------------------------------------- swiss

class Swiss(Format):
    kind = "swiss"
    label = "Swiss"

    def uses_queue(self):
        # once the bracket is up the queue is over: leaving it open meant
        # every knockout match that finished put both players back into a
        # queue nothing would ever dispatch them from again
        return bool(self.config.get("continuous")) and self.phase != "ko"

    def takes_new_entrants(self):
        # a newcomer starts on 0 and is paired like anyone else on 0, so this
        # is right up to the cut; after it the bracket is already drawn
        return self.status == "setup" or (self.status == "running" and self.phase != "ko")

    def queue_candidates(self, store):
        budget = self._round_budget()
        if not budget:
            return list(self.entrant_ids)
        played = self._played(store)
        return [e for e in self.entrant_ids if played.get(e, 0) < budget]

    def paced(self):
        """Continuous pairing, but nobody gets ahead: an entrant is only
        paired against someone who has played the same number of matches,
        and stops at the round budget.

        This is the answer to the round barrier. Strict rounds make a cup's
        demand bursty — it wants every table at once, then none while the
        last long match finishes — and whoever it shares tables with soaks
        up the idle capacity and runs away to their own knockout. Pairing on
        demand within a games-played tier keeps the structure without ever
        making a table wait.

        Off unless the format says otherwise. The console always writes
        this key, so the only configs missing it were written before paced
        mode existed — and an event already under way must not change shape
        because the server was updated between rounds."""
        return bool(self.config.get("continuous")) and \
            bool(self.config.get("paced")) and \
            int(self.config.get("rounds", 0) or 0) > 0

    def _played(self, store):
        """Swiss games played, which is what the round count is counting.

        Only the Swiss phase: once the bracket is up, knockout matches would
        otherwise push everybody past their round budget and make it look
        like nobody ever finished short. A friendly entered by hand against
        this draw does not eat somebody's round either."""
        n = {e: 0 for e in self.entrant_ids}
        for m in store.matches.values():
            if m.format_id != self.id or m.status != "done":
                continue
            if m.meta.get("phase") != "swiss":
                continue
            bye = m.meta.get("bye")
            if bye:
                if bye in n:
                    n[bye] += 1
                continue
            for e in (m.entrant_a, m.entrant_b):
                if e in n:
                    n[e] += 1
        return n

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
        if not ent or not ent.active or e in store.opted_out:
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
        if self.status != "running":
            return
        if self.phase == "ko":
            self._maybe_redraw(store)
            return
        if self.config.get("continuous"):
            if self._budget_spent(store) and self.config.get("then_ko"):
                self._start_ko(store)
            return
        total = int(self.config.get("rounds", 5))
        cur = self._rounds_done(store)
        if cur == 0:
            return
        if cur >= total:
            if self.config.get("then_ko"):
                live = [m for m in store.matches.values()
                        if m.format_id == self.id and m.meta.get("round") == total - 1
                        and m.status not in ("done", "void")]
                if not live:
                    self._start_ko(store)
            return
        live = [m for m in store.matches.values()
                if m.format_id == self.id and m.meta.get("round") == cur - 1
                and m.status not in ("done", "void")]
        if not live:
            self._generate_round(store, cur)

    def _budget_spent(self, store):
        """Paced Swiss is over when everyone has had their rounds and no
        match is still out on a table — or when it cannot give anybody
        another one.

        That second clause is arithmetic, not indulgence. Every match is
        worth two games played, so a field can only all reach the round
        count when entrants times rounds is even. An odd pair of numbers
        leaves exactly one person a game short, and a withdrawal part-way
        through can flip the parity of a field that was going to come out
        fine. Without this the draw simply stopped: one person waiting for
        an opponent who cannot exist, every table idle, and no knockout —
        silently, at the one moment you wanted it. Ending when there is
        nothing left to give anybody is the honest reading of "everyone has
        had their rounds", and the console says who finished short."""
        budget = self._round_budget()
        if not budget:
            return False
        if any(m.format_id == self.id and m.status in ("pending", "live")
               for m in store.matches.values()):
            return False
        played = self._played(store)
        field = [e for e in self.entrant_ids if self._eligible(store, e)]
        if not field:
            return False
        under = [e for e in field if played.get(e, 0) < budget]
        # Fewer than two still owed a game means there is nobody to play
        # whoever is left. Counted off the field rather than off the queue:
        # the queue is rebuilt after this runs, so reading it here sees an
        # empty one between a result and the next seating and ends the draw
        # in its first five minutes.
        return len(under) < 2

    def short_of_budget(self, store):
        """Who ended up a game or more short, once it is over."""
        budget = self._round_budget()
        if not budget:
            return []
        played = self._played(store)
        return [e for e in self.entrant_ids
                if self._eligible(store, e) and played.get(e, 0) < budget]

    def _qualifiers(self, store):
        blocks = self.standings(store)
        rows = blocks[0]["rows"] if blocks else []
        adv = max(2, int(self.config.get("advance", 4)))
        # somebody who went home does not take a bracket place with them
        return [r["entrant_id"] for r in rows
                if not store.withdrawn(r["entrant_id"])][:adv]

    def _start_ko(self, store):
        """Cross into the knockout stage: top N by standings, seeded bracket.
        Shared by the normal end-of-rounds transition and the manual cut.
        Whatever path got us here, a swiss match still sitting in "pending"
        would otherwise keep getting dispatched to tables forever — nothing
        ever marks it done or void once the format has moved past it — so
        it's scrapped here rather than trusting every caller to have done
        that already."""
        if self.phase == "ko":
            return
        seeded = self._qualifiers(store) or []
        if len(seeded) < 2:
            # bail out before scrapping anything: voiding first and then
            # returning left the format mid-Swiss with its fixtures gone,
            # happily generating replacements for the rest of the evening
            return
        stray = [m for m in store.matches.values()
                 if m.format_id == self.id and m.status == "pending"]
        for m in stray:
            store.append("match_void", {"match_id": m.id})
        for q in [q.entrant_id for q in store.queue if q.format_id == self.id]:
            store.append("queue_leave", {"entrant_id": q, "opt_out": False})
        self._build_ko(store, seeded)

    def cut_to_ko(self, store):
        """Admin override: stop the Swiss short of its planned rounds (or end
        a continuous one) and build the bracket from standings as they stand
        right now. Anything not yet seated on a table is scrapped."""
        if self.phase == "ko" or self.status != "running":
            return
        self._start_ko(store)

    def can_redispatch_pending(self):
        # while it is pairing on demand, a pending match is one nothing will
        # pick up again; once the bracket is up, fixtures are real again
        return self.phase == "ko" or not self.config.get("continuous")

    def propose(self, store, busy, force=False):
        if self.phase == "ko" or not self.config.get("continuous"):
            return self._pending(store, busy)
        # A fixture left pending while this draw pairs on demand is an
        # orphan: nothing here ever looks at pending matches, so it would
        # sit there for the rest of the evening — and in a paced draw it
        # also holds back the cut to the knockout, because that waits for
        # nothing to be outstanding. Undoing a result and removing a table
        # from under a live match both produce one. Re-seat it before
        # inventing a new pairing: two people were told they were playing.
        orphan = self._pending(store, busy)
        if orphan:
            return orphan
        entries = [q for q in store.queue
                   if q.format_id == self.id
                   and store.entrant_available(q.entrant_id, busy)]
        played, budget = self._played(store), self._round_budget()
        if budget:
            entries = [q for q in entries
                       if played.get(q.entrant_id, 0) < budget]
        entries.sort(key=lambda q: (-q.passes, q.joined_seq))
        if len(entries) < 2:
            return None
        score = self._score(store)
        meets = store.meetings()
        gap = float(self.config.get("base_gap", 1.0))
        widen = max(1, int(self.config.get("widen_every", 3)))
        tiered = self.paced()

        def penalty(a, b):
            rep = 1.2 * meets.get(frozenset((a.entrant_id, b.entrant_id)), 0)
            if not tiered:
                return rep
            behind = abs(played.get(a.entrant_id, 0) - played.get(b.entrant_id, 0))
            # same number of games played, or close enough that waiting for a
            # better tier would cost a table more than the mismatch is worth
            allowed = 99 if force else a.passes // widen
            return rep if behind <= allowed else 1e6

        found = anchor_pair(
            entries,
            dist=lambda a, b: abs(score.get(a.entrant_id, 0) - score.get(b.entrant_id, 0)),
            tol=lambda a: 99.0 if force else min(gap + a.passes // widen, 6.0),
            penalty=penalty,
        )
        if not found:
            return None
        a, b = found
        return Proposal(self.id, create=dict(
            format_id=self.id, entrant_a=a.entrant_id, entrant_b=b.entrant_id,
            label="Swiss", meta={"phase": "swiss", "round": self._rounds_done(store)},
            scoring=self.scoring().to_dict(),
        ), entrants=[a.entrant_id, b.entrant_id])

    def warnings(self, store):
        """The paced draw has one arithmetic trap and one way of getting
        stuck in it, and both are silent — which is the worst part, because
        they only show up at the moment you want the knockout."""
        if not self.paced():
            return []
        out = []
        field = [e for e in self.entrant_ids if self._eligible(store, e)]
        rounds = int(self.config.get("rounds", 0) or 0)
        n = len(field)
        # every match adds two to the total games played, so the field can
        # only all reach the round count if n * rounds is even
        if n and rounds and (n * rounds) % 2:
            out.append(
                f"{n} entrants over {rounds} rounds cannot come out even — "
                f"every match is worth two games played, so one of them will "
                f"finish a game short. Nothing stops: the knockout is drawn "
                f"when there is nobody left to pair, and you are told who it "
                f"was. An even number of rounds avoids it altogether; so does "
                f"strict rounds, which hands out a bye instead.")
        short = self.short_of_budget(store) if self.phase == "ko" else []
        if short:
            who = " and ".join(store.entrant_name(e) for e in short)
            out.append(
                f"{who} finished a game short — the field could not come out "
                f"even, so there was nobody left to play. Everything else ran "
                f"to its round count.")
        return out

    def _round_budget(self):
        if not self.config.get("continuous"):
            return 0
        return int(self.config.get("rounds", 0) or 0) if self.paced() else 0

    def remaining_work(self, store):
        if self.phase == "ko":
            return self._scheduled_remaining(store)
        field = [e for e in self.entrant_ids if store.entrants.get(e)]
        if self.config.get("continuous"):
            budget = self._round_budget()
            if not budget:
                return None                 # free-running: never finishes
            played = self._played(store)
            return sum(max(0, budget - played.get(e, 0)) for e in field) // 2
        total = int(self.config.get("rounds", 5)) * (len(field) // 2)
        return max(0, total - len(store.done_matches(self.id)))

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
            return self._budget_spent(store)
        return super().is_complete(store) and \
            self._rounds_done(store) >= int(self.config.get("rounds", 5))


KINDS = {f.kind: f for f in (OpenPlay, GroupStage, SingleElim, Swiss)}


def build_format(fid, kind, name, config):
    cls = KINDS.get(kind)
    if not cls:
        raise ValueError(f"unknown format kind {kind!r}")
    return cls(fid, name, config)
