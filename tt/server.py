"""Stdlib-only HTTP server.

No pip install, no build step, no internet. That matters: this runs on a
laptop in a sports hall, and every dependency is one more thing that can fail
on the night.
"""

import json
import mimetypes
import os
import secrets
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

from .store import Store
from .models import Scoring, decide_winner
from . import dispatch, board

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "static")

ROLES = {"public": 0, "referee": 1, "admin": 2}


class App:
    def __init__(self, data_dir):
        os.makedirs(data_dir, exist_ok=True)
        self.data_dir = data_dir
        self.store = Store(os.path.join(data_dir, "event.db"))
        self.keys = self._load_keys()
        self._cache = {}          # (version, role) -> encoded state JSON
        self._reg_hits = {}       # ip -> recent registration timestamps
        if not self.store.tables:
            for n in (1, 2, 3):
                self.store.append("table_set", {"number": n, "name": f"Table {n}"})

    def _load_keys(self):
        path = os.path.join(self.data_dir, "keys.json")
        if os.path.exists(path):
            return json.load(open(path))
        # these live on the public internet now, not just the hall LAN
        keys = {"admin": secrets.token_urlsafe(12), "referee": secrets.token_urlsafe(9)}
        json.dump(keys, open(path, "w"), indent=2)
        return keys

    # A phone filling in a form does this once or twice. Anything hammering
    # it is not a person, and a cheap ceiling here beats a CAPTCHA on a page
    # that club members have to get through.
    REG_BURST, REG_WINDOW = 6, 600

    def registration_allowed(self, ip) -> bool:
        now = time.time()
        if len(self._reg_hits) > 512:            # never grow without bound
            self._reg_hits = {k: v for k, v in self._reg_hits.items()
                              if v and now - v[-1] < self.REG_WINDOW}
        hits = [t for t in self._reg_hits.get(ip, []) if now - t < self.REG_WINDOW]
        if len(hits) >= self.REG_BURST:
            self._reg_hits[ip] = hits
            return False
        hits.append(now)
        self._reg_hits[ip] = hits
        return True

    def role_for(self, token):
        if token and secrets.compare_digest(token, self.keys["admin"]):
            return "admin"
        if token and secrets.compare_digest(token, self.keys["referee"]):
            return "referee"
        return "public"

    # ------------------------------------------------------------ read side

    def entrant_status(self, e):
        """Where this entrant is in the evening, in the words the roster uses.

        playing   on a table now
        resting   sat out by hand; nobody will pair them until they are back
        waiting   in the queue, next in line for a table
        drawn     in a draw that is running but has nobody for them right
                  now — between the fixtures a group stage or bracket set
        entered   in a draw that has not started yet
        outside   admitted to a cup that has no draw taking them: none set
                  up yet, or one that started without them"""
        s = self.store
        for t in s.tables.values():
            m = s.matches.get(t.match_id) if t.match_id else None
            if m and e.id in (m.entrant_a, m.entrant_b, *(m.meta.get("queued") or [])):
                return "playing"
        if e.id in s.opted_out:
            return "resting"
        if any(q.entrant_id == e.id for q in s.queue):
            return "waiting"
        for f in s.formats.values():
            if e.id in f.entrant_ids:
                return "entered" if f.status == "setup" else "drawn"
        return "outside"

    def side_name(self, m, which):
        """What to call one side of a match: the pair's name, the entrant's,
        or the players drawn into it for a scramble."""
        s = self.store
        named = m.meta.get("name_" + which)
        if named:
            return named
        eid = m.entrant_a if which == "a" else m.entrant_b
        if eid:
            return s.entrant_name(eid)
        ids = m.side_a if which == "a" else m.side_b
        return " / ".join(s.players[p].name for p in ids if p in s.players) or "—"
    FORMAT_LINE = {
        "open_play": "Open play — a queue, paired on strength",
        "groups": "Group stage, then a knockout",
        "single_elim": "Straight knockout",
        "swiss": "Swiss — everyone plays every round",
    }

    def _podium(self, f):
        """Who won, for the page the event leaves behind.

        A draw that ended in a bracket is decided by its final; anything else
        by its own standings, merged across groups so the answer is the
        event's, not group A's."""
        s = self.store
        done = [m for m in s.matches.values()
                if m.format_id == f.id and m.status == "done"]
        if not done:
            return []
        if f.phase == "ko" or f.kind == "single_elim":
            final = max(done, key=lambda m: (m.meta.get("round", 0), m.seq))
            win, lose = ((final.entrant_a, final.entrant_b) if final.winner == "a"
                         else (final.entrant_b, final.entrant_a))
            out = [{"place": 1, "name": s.entrant_name(win)}]
            if lose:
                out.append({"place": 2, "name": s.entrant_name(lose)})
            return out
        rows = [r for sec in f.standings(s) for r in sec["rows"]]
        rows.sort(key=lambda r: (-r["won"], -r["game_diff"], -r["point_diff"], r["name"]))
        return [{"place": i, "name": r["name"], "record": f"{r['won']}–{r['lost']}"}
                for i, r in enumerate(rows[:3], 1)]

    def public_state(self):
        """What the landing page gets. Deliberately not `state()`: no roster,
        no strengths, no contact details, nothing admin-shaped — so the
        public page cannot leak anything, and loads fast on hall wifi."""
        s = self.store
        with s.lock:
            phase = s.phase()
            return {
                "phase": phase,
                "now": time.time(),
                "name": s.event.get("name") or "Table tennis",
                "blurb": s.event.get("blurb") or "",
                "venue": s.event.get("venue") or "",
                "starts_at": s.event.get("starts_at") or "",
                "starts_ts": s.starts_at_ts(),
                "open": phase == "registration",
                "cups": [self._public_cup(c, phase)
                         for c in (s.cups[i] for i in s.cup_order if i in s.cups)],
            }

    def _public_cup(self, c, phase):
        s = self.store
        f = s.formats.get(c.format_id)
        sc = (f.config.get("scoring") if f else None) or {}
        out = {
            "id": c.id, "name": c.name, "blurb": c.blurb,
            "entry": c.entry,
            "registration": c.registration,
            "format": f.kind if f else "",
            "format_line": self.FORMAT_LINE.get(f.kind, "") if f else "",
            "scoring": (f"Best of {sc.get('best_of', 3)} to {sc.get('points_to', 11)}"
                        if f else ""),
        }
        if phase == "done" and f:
            out["podium"] = self._podium(f)
        return out

    def match_dto(self, m):
        s = self.store
        names = lambda ids: " / ".join(
            s.players[p].name for p in ids if p in s.players) or "—"
        return {
            "id": m.id, "format_id": m.format_id, "label": m.label,
            "a": self.side_name(m, "a"), "b": self.side_name(m, "b"),
            "players_a": names(m.side_a), "players_b": names(m.side_b),
            "entrant_a": m.entrant_a, "entrant_b": m.entrant_b,
            "table": m.table, "status": m.status, "games": m.games,
            "winner": m.winner, "scoring": m.scoring.to_dict(),
            "meta": m.meta, "seq": m.seq,
            "cup_id": s.cup_of_format(s.formats.get(m.format_id)),
        }

    def state_json(self, role):
        """Encoded state, cached per version. Forty phones asking the same
        question between two results should cost one computation, not forty."""
        v = self.store.version
        hit = self._cache.get((v, role))
        if hit is None:
            hit = json.dumps(self.state(role)).encode()
            self._cache = {(v, role): hit}      # only the current version matters
        return v, hit

    def state(self, role):
        s = self.store
        with s.lock:
            tables = []
            for n, t in sorted(s.tables.items()):
                m = s.matches.get(t.match_id) if t.match_id else None
                tables.append({
                    "number": n, "name": t.name, "paused": t.paused,
                    "cup_id": s.cup_of_table(t),
                    "match": self.match_dto(m) if m else None,
                })

            # Who plays next, and roughly when — see tt/board.py. This
            # replaces a flat "still to play" list that was cut off at 24
            # matches and, for open play, was always empty, because those
            # matches do not exist until the moment they are dispatched.
            boards = board.boards(s, self)

            recent = sorted([m for m in s.matches.values() if m.status == "done"],
                            key=lambda m: -m.seq)[:15]

            return {
                "version": s.version, "seq": s.seq, "role": role,
                "event": s.event, "phase": s.phase(),
                "now": time.time(),
                "tables": tables,
                "cups": [s.cups[c].to_dict() for c in s.cup_order if c in s.cups],
                "board": boards,
                "idle_tables": board.idle_reservations(s) if role == "admin" else [],
                "recent": [self.match_dto(m) for m in recent],
                "formats": [s.formats[f].to_dict(s) for f in s.format_order
                            if f in s.formats],
                "players": [p.to_dict() for p in sorted(
                    s.players.values(), key=lambda p: p.name.lower())],
                "entrants": [{**e.to_dict(),
                              "strength": round(s.entrant_strength(e.id), 1),
                              "status": self.entrant_status(e),
                              "resting": e.id in s.opted_out}
                             for e in sorted(s.entrants.values(),
                                             key=lambda e: e.name.lower())],
                "people": [{**s.people[i].to_dict(),
                            "playing": bool(s.person_playing(i))}
                           for i in s.people_order if i in s.people]
                          if role == "admin" else [],
                "registrations": [r.to_dict() for r in (
                    s.registrations[i] for i in s.registration_order
                    if i in s.registrations)] if role == "admin" else [],
                "history": s.history(40) if role == "admin" else [],
                "keys": self.keys if role == "admin" else {},
            }

    # ----------------------------------------------------------- write side

    def act(self, role, op, p):
        s = self.store
        lvl = ROLES[role]
        need = OP_LEVEL.get(op)
        if need is None:
            raise KeyError(f"unknown action {op!r}")
        if lvl < need:
            raise PermissionError(f"{role} cannot {op}")
        with s.lock:
            fn = getattr(self, "op_" + op)
            out = fn(p)
            dispatch.tick(s)
            return out or {}

    # players & entrants
    def _resolve_cup(self, cup_id):
        """The cup somebody is being admitted to. Every way in goes through
        here, because "which cup" is the one thing the pool needs to know.

        Named, it must exist. Unnamed, it is only guessable when there is
        exactly one; with several, guessing puts somebody in the wrong
        tournament without a word, so it is an error instead. An event with
        no cups at all is the old kind of evening, and stays cupless."""
        s = self.store
        if cup_id:
            if cup_id not in s.cups:
                raise ValueError("no such cup")
            return s.cups[cup_id]
        if len(s.cups) == 1:
            return s.cups[s.cup_order[0]]
        if s.cups:
            raise ValueError("which cup is this for?")
        return None

    def op_add_player(self, p):
        s = self.store
        cup = self._resolve_cup(p.get("cup_id"))
        pid = self._make_player(p["name"].strip(), float(p.get("strength", 5)))
        if p.get("solo", True):
            eid = s.new_id("E", s.entrants)
            s.append("entrant_add", {"id": eid, "name": p["name"].strip(),
                                     "player_ids": [pid],
                                     "cup_id": cup.id if cup else ""})
        return {"player_id": pid}

    def op_update_player(self, p):
        s = self.store
        s.append("player_update", p)
        pl = s.players.get(p.get("id"))
        if pl and pl.person_id and pl.person_id in s.people and "strength" in p:
            # the whole point of the directory: tonight's tuning is next
            # month's starting point
            s.append("person_update", {"id": pl.person_id,
                                       "strength": float(p["strength"]),
                                       "last_seen": s.event.get("id", "")})
        if pl and pl.person_id and "name" in p:
            s.append("person_update", {"id": pl.person_id, "name": p["name"]})

    def op_add_team(self, p):
        s = self.store
        cup = self._resolve_cup(p.get("cup_id"))
        pids = [self._make_player(name.strip(), float(strength))
                for name, strength in p["members"]]
        eid = s.new_id("E", s.entrants)
        label = p.get("name") or " / ".join(n for n, _ in p["members"])
        s.append("entrant_add", {"id": eid, "name": label, "player_ids": pids,
                                 "cup_id": cup.id if cup else ""})
        return {"entrant_id": eid}

    def op_update_entrant(self, p):
        if p.get("cup_id"):
            self._resolve_cup(p["cup_id"])
        self.store.append("entrant_update", p)

    def op_set_resting(self, p):
        """Sit somebody out, or bring them back. The queue itself is never
        edited by hand any more — it is whoever in the cup's pool is free
        and not resting."""
        if p["entrant_id"] not in self.store.entrants:
            raise ValueError("no such entrant")
        self.store.append("rest_set", {"entrant_id": p["entrant_id"],
                                       "resting": bool(p.get("resting", True))})

    def op_set_table(self, p):
        self.store.append("table_set", p)

    def op_remove_table(self, p):
        self.store.append("table_remove", p)

    def op_share_tables(self, p):
        """Every table back into the shared pool.

        Shared and split are not a stored setting — they are read off the
        tables themselves. No table tagged means shared, any table tagged
        means split. One source of truth, so the mode can never disagree
        with what the tables actually say."""
        for n in sorted(self.store.tables):
            self.store.append("table_set", {"number": n, "cup_id": ""})

    def op_split_tables(self, p):
        """Reserve tables for cups in one go: {"assignments": {"1": "C1"}}.
        A table left out of the mapping goes back to shared."""
        s = self.store
        given = {int(k): (v or "") for k, v in (p.get("assignments") or {}).items()}
        for cid in given.values():
            if cid and cid not in s.cups:
                raise ValueError("unknown cup")
        for n in sorted(s.tables):
            s.append("table_set", {"number": n, "cup_id": given.get(n, "")})

    # formats
    def op_add_format(self, p):
        s = self.store
        fid = s.new_id("F", s.formats)
        cfg = dict(p.get("config", {}))
        cfg["entrant_ids"] = list(p.get("entrant_ids", []))
        if cfg.get("cup_id") in s.cups:
            cfg["entrant_ids"] = []          # a cup's draw is its pool, see dispatch
        s.append("format_add", {"id": fid, "kind": p["kind"],
                                "name": p.get("name") or "", "config": cfg})
        return {"format_id": fid}

    def op_update_format(self, p):
        p = dict(p)
        f = self.store.formats.get(p.get("id"))
        if f and self.store.cup_of_format(f):
            p.pop("entrant_ids", None)       # the pool decides, not the form
        self.store.append("format_update", p)

    def op_start_format(self, p):
        s = self.store
        f = s.formats[p["id"]]
        if f.status == "running":
            return
        dispatch.sync_pools(s)               # start on the pool as it is now
        if "entrant_ids" in p and not s.cup_of_format(f):
            f.entrant_ids = list(p["entrant_ids"])
            s.append("format_update", {"id": f.id, "entrant_ids": f.entrant_ids})
        f.start(s)
        s.append("format_update", {"id": f.id, "status": "running",
                                   "phase": f.phase})

    def op_remove_format(self, p):
        self.store.append("format_remove", p)

    def op_reset_format(self, p):
        self.store.append("format_reset", p)

    def op_swiss_cut_ko(self, p):
        s = self.store
        f = s.formats[p["id"]]
        f.cut_to_ko(s)

    # cups
    def op_add_cup(self, p):
        s = self.store
        cid = s.new_id("C", s.cups)
        s.append("cup_add", {"id": cid, "name": p.get("name") or "Cup"})
        return {"cup_id": cid}

    def op_update_cup(self, p):
        self.store.append("cup_update", p)

    def op_remove_cup(self, p):
        self.store.append("cup_remove", p)

    # queue — the console does not use these any more: who waits is worked
    # out from the pool (dispatch.sync_queues), and sitting out is
    # set_resting. They stay as the low-level way to force an entry.
    def op_join_queue(self, p):
        self.store.append("queue_join", {"entrant_id": p["entrant_id"],
                                         "format_id": p["format_id"]})

    def op_leave_queue(self, p):
        self.store.append("queue_leave", {"entrant_id": p["entrant_id"],
                                          "opt_out": p.get("opt_out", True)})

    # matches
    def op_report(self, p):
        s = self.store
        m = s.matches[p["match_id"]]
        games = [[int(a), int(b)] for a, b in p["games"]]
        winner = p.get("winner") or decide_winner(games, m.scoring)
        if not winner:
            raise ValueError("that score does not decide the match")
        involved = list(dict.fromkeys(
            (m.meta.get("queued") or []) + [x for x in (m.entrant_a, m.entrant_b) if x]))
        s.append("match_result", {"match_id": m.id, "games": games,
                                  "winner": winner})
        # everyone is back in the queue by default — that is just what being
        # free means now. Unticking "back in queue" is sitting them out.
        if not p.get("requeue", True):
            for eid in involved:
                s.append("rest_set", {"entrant_id": eid, "resting": True})

    def op_void_match(self, p):
        self.store.append("match_void", {"match_id": p["match_id"]})

    def op_put_back(self, p):
        """Free the table and put this match back in the queue.

        One button, because the two halves of it are never wanted apart: an
        organiser clicking this has two people standing at a table who are
        not going to play right now, and wants the table used.

        Unseating alone was not enough. For a scheduled fixture the
        dispatcher runs again in the same request and put the identical
        match straight back on the identical table, so the button looked
        broken — it is deferred now, which sends it behind the other
        fixtures and gives the table to the next one. For anything that
        pairs on demand there is no fixture to defer: the match was invented
        at the moment it was seated, so it is scrapped and its players go
        back to the queue they came out of."""
        s = self.store
        m = s.matches[p["match_id"]]
        f = s.formats.get(m.format_id)
        pair = {x for x in (m.entrant_a, m.entrant_b) if x}
        if f and not f.can_redispatch_pending():
            s.append("match_void", {"match_id": m.id})
        else:
            s.append("match_defer", {"match_id": m.id})
        # Say what actually happened. When nobody else can use the table the
        # same two come straight back, and a toast claiming they went to the
        # back of the queue is a lie the organiser can see for themselves.
        dispatch.tick(s)
        seated = [s.matches[t.match_id] for t in s.tables.values() if t.match_id]
        return {"reseated": any(pair and pair == {x.entrant_a, x.entrant_b} - {None}
                                for x in seated)}

    def op_reopen_match(self, p):
        """Undo a result. The match becomes unplayed again and anything it
        decided in later rounds is taken back with it."""
        self.store.append("match_reopen", {"match_id": p["match_id"]})

    def op_assign(self, p):
        s = self.store
        m = s.matches[p["match_id"]]
        n = int(p["table"])
        t = s.tables.get(n)
        if not t:
            raise ValueError(f"there is no table {n}")
        if t.paused:
            raise ValueError(f"table {n} is paused")
        if t.match_id and t.match_id != m.id:
            raise ValueError(f"table {n} is already playing")
        tcup = s.cup_of_table(t)
        if tcup is not None and tcup != s.cup_of_format(s.formats.get(m.format_id)):
            raise ValueError(f"table {n} is reserved for {s.cups[tcup].name}")
        s.append("match_assign", {"match_id": m.id, "table": n})

    def op_manual_result(self, p):
        """Record a result for a match that never went through the queue or
        a table — a walk-up game, or backfilling something that already
        happened. Creates the match and its result in one step."""
        s = self.store
        a, b = p.get("entrant_a"), p.get("entrant_b")
        if not a or not b or a == b:
            raise ValueError("pick two different entrants")
        if a not in s.entrants or b not in s.entrants:
            raise ValueError("unknown entrant")
        scoring = Scoring.from_dict(p.get("scoring"))
        games = [[int(x), int(y)] for x, y in p["games"]]
        winner = p.get("winner") or decide_winner(games, scoring)
        if not winner:
            raise ValueError("that score does not decide the match")
        mid = s.create_match(
            format_id=p.get("format_id") or "manual",
            entrant_a=a, entrant_b=b,
            label=p.get("label") or "Manual entry", meta={"phase": "manual"},
            scoring=scoring.to_dict())
        s.append("match_result", {"match_id": mid, "games": games, "winner": winner})
        return {"match_id": mid}

    def op_manual_match(self, p):
        s = self.store
        mid = s.create_match(
            format_id=p.get("format_id") or (s.format_order[0] if s.format_order else "manual"),
            entrant_a=p["entrant_a"], entrant_b=p["entrant_b"],
            label="Manual", meta={"phase": "manual"},
            scoring=Scoring.from_dict(p.get("scoring")).to_dict())
        if p.get("table"):
            s.append("match_assign", {"match_id": mid, "table": int(p["table"])})
        return {"match_id": mid}

    # the event itself
    def op_event_meta(self, p):
        self.store.append("event_meta", p)

    def op_new_event(self, p):
        """Start a new event. Players, teams, matches and formats go; tables,
        cups and your access keys carry forward. This is what the old
        danger-zone resets were reaching for."""
        s = self.store
        s.append("event_new", {
            "name": (p.get("name") or "").strip() or "Table tennis evening",
            "blurb": p.get("blurb", ""), "venue": p.get("venue", ""),
            "starts_at": p.get("starts_at", ""),
            "keep_cups": bool(p.get("keep_cups", True)),
        })
        return {"event_id": s.event["id"]}

    def op_create_event(self, p):
        """Everything the wizard collected, written in one go.

        It emits exactly the events the Setup tabs emit — event_new, cup_add,
        format_add, table_set — so there is no second configuration path and
        anything it sets stays correctable in the normal place afterwards.
        Doing it as one action rather than a dozen round trips also means it
        cannot half-fail and leave a mangled event behind."""
        s = self.store
        cups = p.get("cups") or []
        tables = p.get("tables") or []

        # the wizard is authoritative over cups: it clears them and writes
        # the ones it was given, rather than merging into whatever was there
        s.append("event_new", {
            "name": (p.get("name") or "").strip() or "Table tennis evening",
            "blurb": p.get("blurb", ""), "venue": p.get("venue", ""),
            "starts_at": p.get("starts_at", ""),
            "keep_cups": False,
        })

        cup_ids = []
        for c in cups:
            cid = s.new_id("C", s.cups)
            s.append("cup_add", {
                "id": cid, "name": (c.get("name") or "").strip() or "Cup",
                "blurb": c.get("blurb", ""),
                "entry": c.get("entry") or "single",
                "registration": c.get("registration") or "closed",
            })
            cup_ids.append(cid)

        for c, cid in zip(cups, cup_ids):
            kind = c.get("kind")
            if not kind:
                continue
            cfg = dict(c.get("config") or {})
            cfg["cup_id"] = cid
            cfg["entrant_ids"] = []          # nobody is in it until the door
            fid = s.new_id("F", s.formats)
            s.append("format_add", {
                "id": fid, "kind": kind,
                "name": c.get("format_name") or c.get("name") or "",
                "config": cfg,
            })
            s.append("cup_update", {"id": cid, "format_id": fid})

        if tables:
            wanted = {}
            for n, t in enumerate(tables, start=1):
                ci = t.get("cup")
                wanted[n] = {
                    "number": n, "name": (t.get("name") or "").strip() or f"Table {n}",
                    "cup_id": cup_ids[ci] if isinstance(ci, int) and 0 <= ci < len(cup_ids) else "",
                    "paused": False,
                }
            for n in list(s.tables):
                if n not in wanted:
                    s.append("table_remove", {"number": n})
            for spec in wanted.values():
                s.append("table_set", spec)

        return {"event_id": s.event["id"], "cup_ids": cup_ids}

    # registration — the one thing the public side of the wall can write
    MAX_PER_CUP = 300

    def op_register(self, p):
        """Take an entry from the landing page.

        Everything here is a claim, including the strength: it creates a
        Registration and nothing else, so no amount of nonsense arriving on
        this path can reach the dispatcher. It becomes a player when somebody
        confirms it at the door.

        Duplicates are deliberately allowed here. Two phones, or one phone
        twice, is normal, and the notes box is the correction channel; the
        person who can tell two Jana Bergers apart is at the door, so that is
        where the check lives (op_admit)."""
        cup = self.store.cups.get(p.get("cup_id") or "")
        if not cup:
            raise ValueError("pick which cup you are entering")
        if cup.registration != "open" or self.store.shows_console():
            raise ValueError("that cup is not taking entries")
        return self._take_registration(cup, p)

    def op_add_registration(self, p):
        """The door putting somebody down as looking for a partner: the same
        thing the landing page does, without needing the cup to be open."""
        cup = self.store.cups.get(p.get("cup_id") or "")
        if not cup:
            raise ValueError("pick which cup")
        if cup.entry != "pair":
            raise ValueError("only a doubles cup has partners to look for")
        p = dict(p, kind="seeking")
        return self._take_registration(cup, p)

    def _take_registration(self, cup, p):
        s = self.store
        text = lambda v, n: " ".join(str(v or "").split())[:n]
        name = text(p.get("name"), 60)
        if not name:
            raise ValueError("we need a name to put down")

        kind = p.get("kind") or "single"
        if cup.entry != "pair":
            kind = "single"
        elif kind not in ("pair", "seeking"):
            kind = "seeking"

        partner = text(p.get("partner_name"), 60)
        if kind == "pair" and not partner:
            raise ValueError("a pair needs both names — or pick "
                             "\u201clooking for a partner\u201d")

        if len(s.regs_for_cup(cup.id, status=None)) >= self.MAX_PER_CUP:
            raise ValueError("that cup is full")

        clamp = lambda v: max(1.0, min(10.0, float(v)))
        try:
            strength = clamp(p.get("strength", 5))
            partner_strength = clamp(p.get("partner_strength", 5))
        except (TypeError, ValueError):
            raise ValueError("strength should be a number from 1 to 10")

        rid = s.new_id("R", s.registrations)
        s.append("registration_add", {
            "id": rid, "cup_id": cup.id, "kind": kind,
            "name": name, "strength": strength,
            "partner_name": partner if kind == "pair" else "",
            "partner_strength": partner_strength if kind == "pair" else 5.0,
            "team_name": text(p.get("team_name"), 60) if kind == "pair" else "",
            "note": text(p.get("note"), 500),
            "ts": time.time(),
        })
        self._match_seekers(cup.id)
        mate = s.registrations.get(s.registrations[rid].matched_with or "")
        return {"registration_id": rid, "cup": cup.name,
                "matched_with": mate.name if mate else ""}

    def _match_seekers(self, cup_id):
        """Pair up people who registered alone for a doubles cup.

        First come, first matched: the two longest-waiting are a team, and a
        lone third stays looking until a fourth arrives. The match is written
        down (matched_with) rather than worked out on the fly, because
        somebody gets told at the door who they are playing with, and that
        has to still be true when the next entry comes in."""
        s = self.store
        free = [r for r in s.regs_for_cup(cup_id)
                if r.kind == "seeking" and not r.matched_with]
        while len(free) >= 2:
            a, b = free.pop(0), free.pop(0)
            s.append("registration_update", {"id": a.id, "matched_with": b.id})
            s.append("registration_update", {"id": b.id, "matched_with": a.id})

    # -------------------------------------------------------------- the door

    def _person_for(self, name, strength, person_id=None):
        """Find this person in the club directory, or add them to it.

        Every admin path that creates a player comes through here, so the
        directory fills itself up over an evening rather than being a list
        somebody has to maintain."""
        s = self.store
        who = s.people.get(person_id) if person_id else s.person_by_name(name)
        if who is None:
            pid = s.new_id("N", s.people)
            s.append("person_add", {"id": pid, "name": name,
                                    "strength": float(strength)})
            return s.people[pid]
        s.append("person_update", {"id": who.id, "strength": float(strength),
                                   "last_seen": s.event.get("id", "")})
        return who

    def _make_player(self, name, strength, person_id=None):
        s = self.store
        who = self._person_for(name, strength, person_id)
        pid = s.new_id("P", s.players)
        s.append("player_add", {"id": pid, "name": name,
                                "strength": float(strength),
                                "person_id": who.id})
        return pid

    def _intake(self, cup):
        """What becoming part of this cup will mean for somebody: in the
        draw, or on the cup's roster with nothing to play yet. The pool
        carries them into the draw (dispatch.sync_pools); this only says so
        out loud, because quietly dropping somebody into a knockout that has
        already been drawn would be worse than telling the organiser."""
        s = self.store
        f = s.formats.get(cup.format_id) if cup else None
        if not f:
            return "roster", "no draw set up for that cup yet"
        if f.takes_new_entrants():
            return "entered", ""
        return "roster", f"{f.name or f.kind} has already started"

    def op_admit(self, p):
        """Confirm somebody at the door — pre-registered or a walk-in.

        This is where an intent becomes a player. One path for both, because
        a walk-in is just a confirmation with no registration behind it."""
        s = self.store
        reg = s.registrations.get(p.get("registration_id") or "")
        if p.get("registration_id") and not reg:
            raise ValueError("no such entry")
        if reg and reg.status == "confirmed":
            raise ValueError("that one is already in")

        cup = self._resolve_cup(p.get("cup_id") or (reg.cup_id if reg else ""))
        kind = p.get("kind") or (reg.kind if reg else "single")
        name = " ".join(str(p.get("name") or (reg.name if reg else "")).split())[:60]
        if not name:
            raise ValueError("we need a name")
        # a matched team comes in together, whichever of the two was clicked
        mate = s.registrations.get(reg.matched_with) if reg and reg.matched_with else None
        if mate and (mate.status != "pending" or p.get("kind") == "single"):
            mate = None
        if mate:
            kind = "pair"
        partner = " ".join(str(p.get("partner_name")
                                or (reg.partner_name if reg else "")
                                or (mate.name if mate else "")).split())[:60]
        if kind == "pair" and not partner:
            raise ValueError("a pair needs both names")

        num = lambda v, dflt: max(1.0, min(10.0, float(v if v not in (None, "") else dflt)))
        strength = num(p.get("strength"), reg.strength if reg else 5.0)

        if not (cup and cup.entry == "pair" and kind != "pair"):   # doubles: no name check
            self._refuse_duplicate(kind, name, partner)

        ids = [self._make_player(name, strength, p.get("person_id"))]
        if kind == "pair":
            ps = num(p.get("partner_strength"),
                     mate.strength if mate else reg.partner_strength if reg else 5.0)
            ids.append(self._make_player(partner, ps, p.get("partner_person_id")))

        label = (p.get("team_name") or (reg.team_name if reg else "")
                 or (mate.team_name if mate else "")
                 or " / ".join(s.players[i].name for i in ids))
        eid = s.new_id("E", s.entrants)
        s.append("entrant_add", {"id": eid, "name": label, "player_ids": ids,
                                 "cup_id": cup.id if cup else ""})

        where, why = self._intake(cup)
        if reg:
            s.append("registration_update", {"id": reg.id, "status": "confirmed",
                                             "entrant_id": eid})
        if mate:
            s.append("registration_update", {"id": mate.id, "status": "confirmed",
                                             "entrant_id": eid})
        return {"entrant_id": eid, "where": where, "why": why,
                "cup": cup.name if cup else ""}

    def _refuse_duplicate(self, kind, name, partner=""):
        """Two people with the same name is how the wrong strength ends up
        on the wrong person, so the second one has to be told apart before
        they are saved. Singles: the name must be new tonight. Doubles: only
        the same two people together count — a person is allowed to be in a
        singles cup and a doubles cup, and to change partners."""
        s = self.store
        if kind == "pair":
            if s.pair_named(name, partner):
                raise ValueError(f"{name} & {partner} are already a team tonight")
        elif s.solo_named(name):
            raise ValueError(
                f"There is already a {name} tonight — add something to tell "
                f"them apart, like \u201c{name} (blue shirt)\u201d")

    def op_remove_entrant(self, p):
        """Take somebody out of the pool — a mistaken confirm, a duplicate, a
        person who went home before their first game.

        Only while nothing depends on them. Once they have played, their
        results are in somebody else's standings and a bracket has been drawn
        around them; deleting them would rewrite that, so it is Sit out
        instead."""
        s = self.store
        e = s.entrants.get(p.get("id") or "")
        if not e:
            raise ValueError("no such player")
        mine = set(e.player_ids)
        for m in s.matches.values():
            if e.id in (m.entrant_a, m.entrant_b, *(m.meta.get("queued") or [])) \
                    or mine & set(m.players()):
                raise ValueError(f"{e.name} has already been drawn into a match — "
                                 "use Sit out instead")
        for f in s.formats.values():
            if e.id in f.entrant_ids and not f.takes_new_entrants():
                raise ValueError(f"{e.name} is in a draw that has started — "
                                 "use Sit out instead")
        s.append("entrant_remove", {"id": e.id})

    def op_update_person(self, p):
        self.store.append("person_update", p)

    def op_remove_person(self, p):
        self.store.append("person_remove", p)

    def op_add_from_directory(self, p):
        """Put a known player into tonight's event without retyping them."""
        s = self.store
        who = s.people.get(p.get("person_id") or "")
        if not who:
            raise ValueError("no such person")
        if s.person_playing(who.id):
            raise ValueError(f"{who.name} is already in this event")
        cup = self._resolve_cup(p.get("cup_id"))     # before anything is written
        pid = self._make_player(who.name, p.get("strength", who.strength), who.id)
        eid = s.new_id("E", s.entrants)
        s.append("entrant_add", {"id": eid, "name": who.name, "player_ids": [pid],
                                 "cup_id": cup.id if cup else ""})
        where, why = self._intake(cup) if cup else ("roster", "")
        return {"entrant_id": eid, "where": where, "why": why}

    def op_update_registration(self, p):
        s = self.store
        reg = s.registrations.get(p.get("id") or "")
        s.append("registration_update", p)
        if reg:
            self._match_seekers(reg.cup_id)     # whoever was left alone may have a new match

    def op_set_phase(self, p):
        """Pin the phase, or clear the pin and go back to the clock."""
        from .store import PHASES
        ph = p.get("phase") or ""
        if ph and ph not in PHASES:
            raise ValueError(f"unknown phase {ph!r}")
        self.store.append("event_meta", {"phase_pin": ph})

    def op_rewind(self, p):
        self.store.rewind(int(p["seq"]))


OP_LEVEL = {
    "add_player": 2, "update_player": 2, "add_team": 2, "update_entrant": 2,
    "set_table": 2, "remove_table": 2, "share_tables": 2, "split_tables": 2,
    "add_format": 2, "update_format": 2, "start_format": 2, "remove_format": 2,
    "reset_format": 2, "swiss_cut_ko": 2, "set_resting": 1,
    "add_cup": 2, "update_cup": 2, "remove_cup": 2,
    "join_queue": 1, "leave_queue": 1,
    "report": 1, "void_match": 1, "reopen_match": 1, "put_back": 2, "assign": 2,
    "manual_match": 2, "manual_result": 1, "event_meta": 2, "rewind": 2,
    "new_event": 2, "create_event": 2, "set_phase": 2,
    "register": 0, "update_registration": 2,
    "admit": 2, "add_registration": 2, "remove_entrant": 2, "update_person": 2, "remove_person": 2, "add_from_directory": 2,
}


class Handler(BaseHTTPRequestHandler):
    app: App = None
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _send(self, code, body, ctype="application/json; charset=utf-8", etag=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if etag:
            self.send_header("ETag", etag)
        self.end_headers()
        self.wfile.write(body)

    def _token(self, q):
        t = self.headers.get("X-Key") or ""
        if not t and "token" in q:
            t = q["token"][0]
        return t

    def do_GET(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        path = u.path

        if path == "/api/state":
            role = self.app.role_for(self._token(q))
            v, body = self.app.state_json(role)
            tag = f'W/"{v}-{role}"'
            if self.headers.get("If-None-Match") == tag:
                self.send_response(304)
                self.send_header("ETag", tag)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            return self._send(200, body, etag=tag)

        if path == "/api/public":
            return self._send(200, self.app.public_state())

        if path == "/api/stream":
            return self._stream()

        if path == "/board":
            return self._static("board.html")

        if path == "/print":
            return self._print_page(q)

        if path == "/api/qr.svg":
            return self._qr(q.get("u", [""])[0])

        if path.startswith("/static/"):
            return self._static(path[len("/static/"):])

        if path == "/join":
            return self._site_page()

        # Role-scoped entry points always get the console: an admin holding
        # the key wants the console whatever phase the event is in. The key
        # is in the path on this first load — the client only starts sending
        # it as a header once the page it is asking for is running — so the
        # prefix is what we have to go on here.
        #
        # The bare root is phase-driven: the site before the doors open, the
        # console once they have.
        if path.startswith(("/a/", "/r/")) or self.app.store.shows_console():
            return self._static("index.html")
        return self._site_page()

    def do_POST(self):
        u = urlparse(self.path)
        q = parse_qs(u.query)
        if u.path != "/api/action":
            return self._send(404, {"error": "not found"})
        n = int(self.headers.get("Content-Length", 0))
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except Exception:
            return self._send(400, {"error": "bad json"})
        role = self.app.role_for(self._token(q) or body.get("token", ""))
        if body.get("op") == "register" and role == "public" \
                and not self.app.registration_allowed(self.client_address[0]):
            return self._send(429, {"error": "too many entries from here just now — "
                                             "give it a few minutes"})
        try:
            out = self.app.act(role, body["op"], body.get("data", {}))
        except PermissionError as e:
            return self._send(403, {"error": str(e)})
        except KeyError as e:
            return self._send(404, {"error": f"not found: {e}"})
        except Exception as e:
            return self._send(400, {"error": str(e)})
        return self._send(200, {"ok": True, **out})

    def _stream(self):
        """Server-sent events. Pushes a version number the moment anything
        changes, so a referee saving a score updates every other screen in the
        room immediately instead of up to two seconds later."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")     # tell proxies not to buffer
        self.send_header("Connection", "close")
        self.end_headers()
        last, started, beat = None, time.time(), 0.0
        try:
            while time.time() - started < 900:          # recycle every 15 min
                v = self.app.store.version
                now = time.time()
                if v != last:
                    last = v
                    self.wfile.write(f"data: {v}\n\n".encode())
                    self.wfile.flush()
                    beat = now
                elif now - beat > 20:                   # keep proxies from timing out
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    beat = now
                time.sleep(0.25)
        except (BrokenPipeError, ConnectionResetError, OSError):
            return

    def _qr(self, url):
        try:
            import segno
        except ImportError:
            return self._send(501, "install segno for QR codes", "text/plain")
        if not url.startswith(("http://", "https://")):
            return self._send(400, "bad url", "text/plain")
        import io
        try:
            buf = io.BytesIO()          # segno writes bytes, not text
            segno.make(url, error="m").save(
                buf, kind="svg", scale=8, border=2, dark="#10211f",
                light="#ffffff", svgclass=None, lineclass=None)
            svg = buf.getvalue().decode()
        except Exception as e:
            return self._send(500, f"could not build a QR code: {e}", "text/plain")
        self._send(200, svg, "image/svg+xml")

    def _site_page(self):
        """The landing page, with its head filled in from the event.

        Pasted into a club chat, a bare link is a bare link — these tags are
        what turn it into a card with the name, the date and the blurb, which
        is most of what advertising an event actually is."""
        s = self.app.store
        ev = s.event
        name = ev.get("name") or "Table tennis"
        bits = []
        ts = s.starts_at_ts()
        if ts:
            bits.append(time.strftime("%A %d %B, %H:%M", time.localtime(ts)))
        if ev.get("venue"):
            bits.append(ev["venue"])
        desc = ev.get("blurb") or " · ".join(bits) or "Table tennis"
        if bits and ev.get("blurb"):
            desc = " · ".join(bits) + " — " + desc
        esc = lambda t: (str(t).replace("&", "&amp;").replace("<", "&lt;")
                         .replace(">", "&gt;").replace('"', "&quot;"))
        meta = (
            f'<title>{esc(name)}</title>\n'
            f'<meta name="description" content="{esc(desc)}">\n'
            f'<meta property="og:type" content="website">\n'
            f'<meta property="og:title" content="{esc(name)}">\n'
            f'<meta property="og:description" content="{esc(desc)}">\n'
            f'<meta name="twitter:card" content="summary">\n'
            f'<meta name="twitter:title" content="{esc(name)}">\n'
            f'<meta name="twitter:description" content="{esc(desc)}">'
        )
        path = os.path.join(STATIC, "site.html")
        with open(path, encoding="utf-8") as fh:
            html = fh.read()
        html = html.replace("<!--META-->", meta)
        self._send(200, html, "text/html; charset=utf-8")

    def _print_page(self, q):
        """A sheet to print and tape to the wall."""
        base = q.get("base", [""])[0] or ""
        ev = self.app.store.event
        name = ev.get("name") or "Table tennis"
        # two posters, one page: the live link for the wall during the
        # evening, and the event itself for the noticeboard beforehand
        announce = q.get("mode", [""])[0] == "event"
        ts = self.app.store.starts_at_ts()
        when = time.strftime("%A %d %B · %H:%M", time.localtime(ts)) if ts else ""
        lead = ("Scan to see what is on and enter your name"
                if announce else
                "Scan for live tables, the queue and results")
        detail = ""
        if announce:
            detail = "".join(
                f'<div class="detail">{x}</div>'
                for x in (when, ev.get("venue") or "", ev.get("blurb") or "") if x)
        has_qr = True
        try:
            import segno  # noqa
        except ImportError:
            has_qr = False
        from urllib.parse import quote
        qr = (f'<img src="/api/qr.svg?u={quote(base, safe="")}" '
              f'alt="QR code" style="width:330px;height:330px">'
              ) if (has_qr and base) else ""
        html = f"""<!doctype html><meta charset="utf-8">
<title>{name}</title>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@400..800&display=swap" rel="stylesheet" media="print" onload="this.media='all'">
<style>
 body{{font-family:"Syne",ui-sans-serif,system-ui,sans-serif;color:#0a0a0a;background:#fff;
      margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}}
 .sheet{{text-align:center;padding:40px}}
 h1{{font-size:38px;font-weight:800;margin:0 0 6px;letter-spacing:-.03em}}
 p{{color:#5f5f5f;margin:0 0 28px;font-size:17px}}
 .url{{font-size:23px;margin-top:22px;font-weight:700;color:#d8241a;word-break:break-all}}
 .detail{{font-size:19px;margin-bottom:8px;max-width:30em}}
 .detail:last-of-type{{color:#5f5f5f;font-size:16px;margin-bottom:24px}}
 @media print{{.sheet{{padding:0}}}}
</style>
<div class="sheet"><h1>{name}</h1>
<p>{lead}</p>
{detail}
{qr}<div class="url">{base.replace('https://','')}</div></div>"""
        self._send(200, html, "text/html; charset=utf-8")

    def _static(self, rel):
        rel = rel.lstrip("/") or "index.html"
        p = os.path.normpath(os.path.join(STATIC, rel))
        if not p.startswith(STATIC) or not os.path.isfile(p):
            return self._send(404, "not found", "text/plain")
        ctype = mimetypes.guess_type(p)[0] or "application/octet-stream"
        with open(p, "rb") as fh:
            data = fh.read()
        self._send(200, data, ctype + ("; charset=utf-8" if "text" in ctype
                                       or "javascript" in ctype else ""))


def lan_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def serve(data_dir="data", host="0.0.0.0", port=8000):
    app = App(data_dir)
    Handler.app = app
    srv = ThreadingHTTPServer((host, port), Handler)
    ip = lan_ip()
    print(f"\n  Table tennis console\n")
    print(f"  Everyone   http://{ip}:{port}/")
    print(f"  Referees   http://{ip}:{port}/r/{app.keys['referee']}")
    print(f"  Admin      http://{ip}:{port}/a/{app.keys['admin']}\n")
    print(f"  Data in {os.path.abspath(data_dir)}  (delete event.db to reset)\n")
    srv.serve_forever()
