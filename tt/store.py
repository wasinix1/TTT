"""Append-only event log with derived state.

Nothing is ever updated in place on disk. Every change is an event; the live
state is a replay of the log. That gives correction and undo for free, and
means a crashed laptop loses nothing but the last request.
"""

import json
import os
import sqlite3
import threading
import time
from collections import defaultdict
from typing import Optional

from .models import (
    Player, Entrant, Match, Table, QueueEntry, Scoring, Cup, decide_winner,
)


class Store:
    def __init__(self, db_path: str):
        self.db_path = db_path
        self.lock = threading.RLock()
        self.conn = sqlite3.connect(db_path, check_same_thread=False)
        self.conn.execute(
            "CREATE TABLE IF NOT EXISTS events ("
            " seq INTEGER PRIMARY KEY AUTOINCREMENT,"
            " ts REAL NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL)"
        )
        self.conn.commit()
        self._replaying = False
        self.reset_state()
        self.replay()

    # ---------------------------------------------------------------- state

    def reset_state(self):
        self.players: dict[str, Player] = {}
        self.entrants: dict[str, Entrant] = {}
        self.matches: dict[str, Match] = {}
        self.tables: dict[int, Table] = {}
        self.cups: dict[str, Cup] = {}
        self.cup_order: list[str] = []
        self.formats = {}            # id -> Format instance
        self.format_order: list[str] = []
        self.queue: list[QueueEntry] = []
        self.opted_out: set[str] = set()
        # who was pulled out of which queue, so a scheduled match can hand
        # them back to open play when it finishes
        self.came_from: dict[str, str] = {}
        self.event: dict = {"name": "Table tennis evening", "note": ""}
        # admin override: try this cup's formats first on every *shared*
        # table (reserved tables are unaffected). None = normal priority
        # order, unchanged from before this existed.
        self.priority_cup: Optional[str] = None
        self.seq = 0
        self.version = 0             # bumped on every applied event, for polling

    # ------------------------------------------------------------- log core

    def append(self, etype: str, payload: dict):
        """Record a decision and apply it. The only way state ever changes."""
        with self.lock:
            ts = time.time()
            cur = self.conn.execute(
                "INSERT INTO events (ts, type, payload) VALUES (?,?,?)",
                (ts, etype, json.dumps(payload)),
            )
            self.conn.commit()
            self.seq = cur.lastrowid
            self.apply(etype, payload, self.seq)
            self.version += 1
            return self.seq

    def replay(self):
        with self.lock:
            self._replaying = True
            self.reset_state()
            for seq, etype, payload in self.conn.execute(
                "SELECT seq, type, payload FROM events ORDER BY seq"
            ):
                self.apply(etype, json.loads(payload), seq)
                self.seq = seq
            self._replaying = False
            self.version += 1

    def rewind(self, to_seq: int):
        """Drop every event after to_seq. Admin undo."""
        with self.lock:
            self.conn.execute("DELETE FROM events WHERE seq > ?", (to_seq,))
            self.conn.commit()
            self.replay()

    def history(self, limit=60):
        rows = self.conn.execute(
            "SELECT seq, ts, type, payload FROM events ORDER BY seq DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [
            {"seq": s, "ts": t, "type": ty, "payload": json.loads(p)}
            for s, t, ty, p in rows
        ]

    # ---------------------------------------------------------------- apply

    def apply(self, etype: str, p: dict, seq: int):
        fn = getattr(self, "_ev_" + etype, None)
        if fn is None:
            raise ValueError(f"unknown event type {etype!r}")
        fn(p, seq)

    def _ev_event_meta(self, p, seq):
        self.event.update(p)

    def _ev_player_add(self, p, seq):
        self.players[p["id"]] = Player(
            id=p["id"], name=p["name"],
            strength=float(p.get("strength", 5.0)),
            active=p.get("active", True),
        )

    def _ev_player_update(self, p, seq):
        pl = self.players.get(p["id"])
        if not pl:
            return
        if "name" in p:
            pl.name = p["name"]
            # a solo entrant's name is just its one player's name at the
            # time it was created; keep it in sync or every picker (format
            # entry, queue, match labels) keeps showing the old name forever
            for e in self.entrants.values():
                if e.player_ids == [pl.id]:
                    e.name = pl.name
        if "strength" in p:
            pl.strength = float(p["strength"])
        if "active" in p:
            pl.active = bool(p["active"])

    def _ev_entrant_add(self, p, seq):
        self.entrants[p["id"]] = Entrant(
            id=p["id"], name=p["name"], player_ids=list(p["player_ids"]),
            active=p.get("active", True),
        )

    def _ev_entrant_update(self, p, seq):
        e = self.entrants.get(p["id"])
        if not e:
            return
        if "name" in p:
            e.name = p["name"]
        if "player_ids" in p:
            e.player_ids = list(p["player_ids"])
        if "active" in p:
            e.active = bool(p["active"])
            if not e.active:
                self.queue = [q for q in self.queue if q.entrant_id != e.id]

    def _ev_table_set(self, p, seq):
        n = int(p["number"])
        t = self.tables.get(n) or Table(number=n)
        t.name = p.get("name", t.name)
        if "paused" in p:
            t.paused = bool(p["paused"])
        if "cup_id" in p:
            t.cup_id = p["cup_id"] or None
        self.tables[n] = t

    def _ev_table_remove(self, p, seq):
        self.tables.pop(int(p["number"]), None)

    def _ev_cup_add(self, p, seq):
        self.cups[p["id"]] = Cup(id=p["id"], name=p.get("name") or "Cup")
        if p["id"] not in self.cup_order:
            self.cup_order.append(p["id"])

    def _ev_cup_update(self, p, seq):
        c = self.cups.get(p["id"])
        if not c:
            return
        if "name" in p:
            c.name = p["name"]

    def _ev_cup_remove(self, p, seq):
        self.cups.pop(p["id"], None)
        self.cup_order = [i for i in self.cup_order if i != p["id"]]
        # tables/formats that pointed at it fall back to shared/ungrouped —
        # cup_of_table / cup_of_format only trust ids still present in self.cups

    def _ev_priority_cup_set(self, p, seq):
        self.priority_cup = p.get("cup_id") or None

    def _ev_format_add(self, p, seq):
        from .formats import build_format
        f = build_format(p["id"], p["kind"], p.get("name", ""), p.get("config", {}))
        self.formats[f.id] = f
        if f.id not in self.format_order:
            self.format_order.append(f.id)

    def _ev_format_update(self, p, seq):
        f = self.formats.get(p["id"])
        if not f:
            return
        if "config" in p:
            f.config.update(p["config"])
        if "name" in p:
            f.name = p["name"]
        if "status" in p:
            f.status = p["status"]
        if "entrant_ids" in p:
            f.entrant_ids = list(p["entrant_ids"])
        if "phase" in p:
            f.phase = p["phase"]

    def _ev_format_remove(self, p, seq):
        self._purge_format_matches(p["id"])
        self.formats.pop(p["id"], None)
        self.format_order = [i for i in self.format_order if i != p["id"]]

    def _ev_format_reset(self, p, seq):
        """Clear a format's matches/queue in place, keep its config so it
        can be started again without recreating entrants or settings."""
        fid = p["id"]
        self._purge_format_matches(fid)
        f = self.formats.get(fid)
        if f:
            f.status = "setup"
            f.phase = ""

    def _purge_format_matches(self, fid):
        """Void every match still hanging off a format — done or not — so
        removing/resetting a format leaves no residue in results, standings
        or rematch-avoidance history, and frees any table it was holding."""
        for m in self.matches.values():
            if m.format_id != fid or m.status == "void":
                continue
            if m.table in self.tables and self.tables[m.table].match_id == m.id:
                self.tables[m.table].match_id = None
            m.table = None
            m.status = "void"
            m.games = []
            m.winner = None
        self.queue = [q for q in self.queue if q.format_id != fid]

    def _ev_players_reset(self, p, seq):
        """Wipe the whole roster — players, entrants, and every match/queue
        entry that depends on them — so a stale player list doesn't linger
        between events. Tables, cups and format settings are untouched, so
        formats just drop back to 'setup' with nobody entered yet rather
        than needing to be rebuilt."""
        for fid in list(self.formats.keys()):
            self._purge_format_matches(fid)
            f = self.formats[fid]
            f.entrant_ids = []
            f.status = "setup"
            f.phase = ""
        self.players = {}
        self.entrants = {}
        self.opted_out = set()
        self.came_from = {}

    def _ev_queue_join(self, p, seq):
        eid = p["entrant_id"]
        self.opted_out.discard(eid)
        if any(q.entrant_id == eid for q in self.queue):
            return
        self.queue.append(QueueEntry(
            entrant_id=eid, format_id=p["format_id"], joined_seq=seq,
        ))

    def _ev_queue_leave(self, p, seq):
        self.queue = [q for q in self.queue if q.entrant_id != p["entrant_id"]]
        if p.get("opt_out"):
            self.opted_out.add(p["entrant_id"])

    def _ev_queue_pass(self, p, seq):
        ids = set(p["entrant_ids"])
        for q in self.queue:
            if q.entrant_id in ids:
                q.passes += 1

    def _ev_match_create(self, p, seq):
        m = Match(
            id=p["id"], format_id=p["format_id"],
            side_a=list(p.get("side_a", [])), side_b=list(p.get("side_b", [])),
            entrant_a=p.get("entrant_a"), entrant_b=p.get("entrant_b"),
            label=p.get("label", ""), meta=dict(p.get("meta", {})),
            scoring=Scoring.from_dict(p.get("scoring")),
            status=p.get("status", "pending"), seq=seq,
        )
        self.matches[m.id] = m
        # scramble matches carry no entrant_a/entrant_b, so the four players
        # they drew are listed in meta["queued"]; all of them leave the queue
        leaving = set(m.meta.get("queued") or [])
        leaving.update(x for x in (m.entrant_a, m.entrant_b) if x)
        for q in self.queue:
            if q.entrant_id in leaving:
                self.came_from[q.entrant_id] = q.format_id
        self.queue = [q for q in self.queue if q.entrant_id not in leaving]

    def _ev_match_fill(self, p, seq):
        """Fill a bracket slot. Emitted by format.on_result during replay too."""
        m = self.matches.get(p["match_id"])
        if not m:
            return
        self._fill_slot(m, p["slot"], p.get("entrant_id"))

    def _fill_slot(self, m: Match, slot: str, entrant_id):
        e = self.entrants.get(entrant_id) if entrant_id else None
        if slot == "a":
            m.entrant_a = entrant_id
            m.side_a = list(e.player_ids) if e else []
        else:
            m.entrant_b = entrant_id
            m.side_b = list(e.player_ids) if e else []

    def _ev_match_assign(self, p, seq):
        m = self.matches.get(p["match_id"])
        if not m:
            return
        n = int(p["table"])
        for t in self.tables.values():
            if t.match_id == m.id:
                t.match_id = None
        m.table = n
        m.status = "live"
        m.queued_seq = seq
        if n in self.tables:
            self.tables[n].match_id = m.id

    def _ev_match_unassign(self, p, seq):
        m = self.matches.get(p["match_id"])
        if not m:
            return
        if m.table in self.tables and self.tables[m.table].match_id == m.id:
            self.tables[m.table].match_id = None
        m.table = None
        if m.status == "live":
            m.status = "pending"

    def _ev_match_result(self, p, seq):
        m = self.matches.get(p["match_id"])
        if not m:
            return
        m.games = [list(g) for g in p["games"]]
        m.winner = p.get("winner") or decide_winner(m.games, m.scoring)
        m.status = "done"
        if m.table in self.tables and self.tables[m.table].match_id == m.id:
            self.tables[m.table].match_id = None
        m.table = None
        f = self.formats.get(m.format_id)
        if f:
            f.on_result(self, m)

    def _ev_match_void(self, p, seq):
        m = self.matches.get(p["match_id"])
        if not m:
            return
        if m.table in self.tables and self.tables[m.table].match_id == m.id:
            self.tables[m.table].match_id = None
        m.table = None
        m.status = "void"
        m.games = []
        m.winner = None

    # ------------------------------------------------------------- helpers

    def new_id(self, prefix: str, pool: dict) -> str:
        n = 1
        while f"{prefix}{n}" in pool:
            n += 1
        return f"{prefix}{n}"

    def create_match(self, **kw) -> str:
        mid = kw.get("id") or self.new_id("M", self.matches)
        kw["id"] = mid
        if isinstance(kw.get("scoring"), Scoring):
            kw["scoring"] = kw["scoring"].to_dict()
        for slot in ("a", "b"):
            eid = kw.get(f"entrant_{slot}")
            if eid and not kw.get(f"side_{slot}"):
                e = self.entrants.get(eid)
                kw[f"side_{slot}"] = list(e.player_ids) if e else []
        self.append("match_create", kw)
        return mid

    def fill_slot(self, match_id: str, slot: str, entrant_id):
        """Called from format.on_result. Mutates directly during replay."""
        m = self.matches.get(match_id)
        if not m:
            return
        self._fill_slot(m, slot, entrant_id)

    # ------------------------------------------------------------ cups

    def cup_of_table(self, t: Table):
        """A table's cup, or None if shared — self-heals if the cup was removed."""
        return t.cup_id if t.cup_id in self.cups else None

    def cup_of_format(self, f):
        c = f.config.get("cup_id") if f else None
        return c if c in self.cups else None

    def active_priority_cup(self):
        return self.priority_cup if self.priority_cup in self.cups else None

    def tables_for_cup(self, cup_id):
        """Table numbers a format tagged `cup_id` may be dispatched to: the
        shared pool plus any table reserved for that same cup."""
        return [n for n, t in sorted(self.tables.items())
                if self.cup_of_table(t) in (None, cup_id)]

    def busy_players(self) -> set[str]:
        out = set()
        for t in self.tables.values():
            if t.match_id and t.match_id in self.matches:
                out.update(self.matches[t.match_id].players())
        return out

    def entrant_available(self, eid: str, busy: set[str]) -> bool:
        e = self.entrants.get(eid)
        if not e or not e.active:
            return False
        if any(pid in busy for pid in e.player_ids):
            return False
        return all(self.players[p].active for p in e.player_ids if p in self.players)

    def entrant_strength(self, eid: str) -> float:
        e = self.entrants.get(eid)
        if not e or not e.player_ids:
            return 5.0
        vals = [self.players[p].strength for p in e.player_ids if p in self.players]
        return sum(vals) / len(vals) if vals else 5.0

    def entrant_name(self, eid) -> str:
        e = self.entrants.get(eid)
        return e.name if e else "—"

    def done_matches(self, format_id=None):
        return [m for m in self.matches.values()
                if m.status == "done" and (format_id is None or m.format_id == format_id)]

    def meetings(self) -> dict:
        c = defaultdict(int)
        for m in self.matches.values():
            if m.status in ("done", "live") and m.entrant_a and m.entrant_b:
                c[frozenset((m.entrant_a, m.entrant_b))] += 1
        return c

    def partnerships(self) -> dict:
        c = defaultdict(int)
        for m in self.matches.values():
            if m.status in ("done", "live"):
                for side in (m.side_a, m.side_b):
                    if len(side) == 2:
                        c[frozenset(side)] += 1
        return c
