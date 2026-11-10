"""Table calls on the phone itself, without Telegram: Web Push.

The same two calls the bot sends (tt/notify.py) — *get ready* when you are
in the next wave, *your table* when it is yours — plus the one thing a self-
run night needs answered: the other side reported a score, is it right?

Planned the way the bot plans: from what is true now, each call with a key,
and a key is sent once. So a restart, a replay or a rewind sends nothing
twice. A later call replaces an earlier one on the lock screen (the
notification's tag) and, while still undelivered, at the push service too
(its Topic), so a phone that was offline for a while wakes up to where
things are now rather than to the whole evening.

A subscription belongs to a person, made from a phone that holds their key
(tt/play.py). The browser's push service is the only thing the server talks
to, and only the push services browsers actually use are allowed as
endpoints — a subscription is something a phone hands in, and the server
should not be talked into posting to wherever it is told.
"""

import json
import os
import sqlite3
import threading
import time
from urllib.parse import urlparse

from . import board, webpush
from .bot import label_de, table_de

STALE = 15 * 60          # a call older than this is not worth sending
CALL_TTL = 10 * 60       # how long a push service may hold a call for an offline phone

# The push services of Chrome/Android, Firefox, Safari/iOS and Edge.
PUSH_HOSTS = ("fcm.googleapis.com", "android.googleapis.com", ".push.services.mozilla.com",
              "push.services.mozilla.com", ".push.apple.com", ".notify.windows.com")

WORDS = {
    "en": {"go": lambda t: f"{t} — you’re on", "against": lambda o: f"against {o}",
           "next": "Get ready — you’re next", "next_b": lambda t: f"The first free table is yours · {t}",
           "claim": lambda b: f"{b} reported a result", "claim_b": lambda g: f"{g} — is that right?",
           "fix": lambda b: f"{b} says your last result was wrong",
           "fix_b": lambda g: f"It should be {g} — is that right?",
           "table": lambda n: f"Table {n}"},
    "de": {"go": lambda t: f"{t} — du bist dran", "against": lambda o: f"gegen {o}",
           "next": "Gleich bist du dran", "next_b": lambda t: f"Der erste freie Tisch ist deiner · {t}",
           "claim": lambda b: f"{b} meldet ein Ergebnis", "claim_b": lambda g: f"{g} — stimmt das?",
           "fix": lambda b: f"{b} meldet einen Fehler im letzten Ergebnis",
           "fix_b": lambda g: f"Richtig wäre {g} — stimmt das?",
           "table": lambda n: f"Tisch {n}"},
}


def allowed_endpoint(url):
    u = urlparse(url or "")
    host = (u.hostname or "").lower()
    return u.scheme == "https" and any(host == h.lstrip(".") or host.endswith(h)
                                       for h in PUSH_HOSTS)


class Push:
    PLAN_EVERY = 20        # seconds between plans when nothing has changed

    def __init__(self, app, data_dir, sender=None):
        self.app = app
        self.lock = threading.RLock()
        self.conn = sqlite3.connect(os.path.join(data_dir, "push.db"), check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript("""
            CREATE TABLE IF NOT EXISTS subs (endpoint TEXT PRIMARY KEY, person_id TEXT,
              p256dh TEXT, auth TEXT, lang TEXT DEFAULT 'en', created REAL);
            CREATE TABLE IF NOT EXISTS sent (key TEXT PRIMARY KEY, ts REAL);
            CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
        """)
        self.conn.commit()
        self.send = sender or webpush.send
        self.allow_any = False         # tests post to a local fake push service
        d = self._get("vapid")
        if d is None:
            d, _ = webpush.new_key()
            self._put("vapid", hex(d))
        else:
            d = int(d, 16)
        self.vapid = d
        self.public = webpush.b64u(webpush.public_of(d))
        self._wake = threading.Event()
        self._last = (-1, 0.0)

    # -- storage
    def _q(self, sql, args=()):
        with self.lock:
            cur = self.conn.execute(sql, args)
            self.conn.commit()
            return cur

    def _all(self, sql, args=()):
        with self.lock:
            return [dict(r) for r in self.conn.execute(sql, args).fetchall()]

    def _get(self, k):
        rows = self._all("SELECT v FROM kv WHERE k=?", (k,))
        return rows[0]["v"] if rows else None

    def _put(self, k, v):
        self._q("INSERT OR REPLACE INTO kv VALUES (?,?)", (k, v))

    # -- subscriptions
    def subscribe(self, person_id, sub, lang="en", origin=""):
        endpoint = str((sub or {}).get("endpoint") or "")
        keys = (sub or {}).get("keys") or {}
        if not (self.allow_any or allowed_endpoint(endpoint)):
            raise ValueError("that is not a push service this server knows")
        try:
            webpush.point(webpush.unb64u(keys.get("p256dh") or ""))
            if len(webpush.unb64u(keys.get("auth") or "")) < 16:
                raise ValueError
        except Exception:
            raise ValueError("that subscription's keys do not look right")
        if origin.startswith("https://") and not self._get("subject"):
            # who to contact about this sender, as push services ask; the
            # address the club's page is served from is the honest answer
            self._put("subject", origin)
        self._q("INSERT OR REPLACE INTO subs VALUES (?,?,?,?,?,?)",
                (endpoint, person_id, keys["p256dh"], keys["auth"],
                 "de" if lang == "de" else "en", time.time()))
        self.changed()

    def unsubscribe(self, endpoint, person_id=None):
        if person_id:
            self._q("DELETE FROM subs WHERE endpoint=? AND person_id=?", (endpoint, person_id))
        else:
            self._q("DELETE FROM subs WHERE endpoint=?", (endpoint,))

    def subs(self, person_id=None):
        if person_id:
            return self._all("SELECT * FROM subs WHERE person_id=?", (person_id,))
        return self._all("SELECT * FROM subs")

    def has(self, person_id):
        return bool(self._all("SELECT 1 FROM subs WHERE person_id=? LIMIT 1", (person_id,)))

    def subject(self):
        return self._get("subject") or "mailto:push@localhost"

    # -- what should have been said
    def plan(self, now=None):
        """(key, person_id, words) for every call that is true now, for
        people with a phone subscribed."""
        s = self.app.store
        now = now or time.time()
        people = {r["person_id"] for r in self.subs()}
        if not people:
            return []
        person = lambda pid: s.players[pid].person_id if pid in s.players else None
        out = []
        with s.lock:
            for n, t in sorted(s.tables.items()):
                m = s.matches.get(t.match_id) if t.match_id else None
                if not m or m.status != "live":
                    continue
                if m.started_ts and now - m.started_ts > STALE:
                    continue
                for side in ("a", "b"):
                    other = self.app.side_name(m, "b" if side == "a" else "a")
                    for pid in (m.side_a if side == "a" else m.side_b):
                        who = person(pid)
                        if who in people:
                            out.append((f"go:{m.id}:{m.queued_seq}:{who}", who,
                                        {"kind": "go", "table": t, "opp": other}))
            for b in self._boards():
                for r in b["up"]:
                    if not r.get("on_deck"):
                        continue
                    for eid in [e for e in r.get("entrants") or [] if e]:
                        e = s.entrants.get(eid)
                        if not e:
                            continue
                        stint = next((q.joined_seq for q in s.queue if q.entrant_id == eid), None)
                        tag = f"m:{r['id']}" if r["kind"] == "fixture" else f"q:{eid}:{stint}"
                        if r["kind"] != "fixture" and stint is None:
                            continue
                        for pid in e.player_ids:
                            who = person(pid)
                            if who in people:
                                out.append((f"next:{tag}:{who}", who,
                                            {"kind": "next", "tables": b.get("tables", [])}))
            for c in s.claims.values():
                m = s.matches.get(c["match_id"])
                if c["state"] != "open" or (c not in s.open_claims(m)
                                            and c not in s.open_fixes(m)):
                    continue
                other = "b" if c["side"] == "a" else "a"
                for pid in (m.side_b if other == "b" else m.side_a):
                    who = person(pid)
                    if who in people:
                        view = [list(g) if other == "a" else [g[1], g[0]] for g in c["games"]]
                        out.append((f"claim:{c['id']}:{who}", who,
                                    {"kind": "claim", "by": self.app.side_name(m, c["side"]),
                                     "games": view, "fix": bool(c.get("fix"))}))
        return out

    def _boards(self):
        s = self.app.store
        keys = []
        for fid in s.format_order:
            f = s.formats.get(fid)
            if f and f.status == "running" and s.cup_key(f) not in keys:
                keys.append(s.cup_key(f))
        return [board.cup_board_cached(s, k, self.app) for k in keys]

    @staticmethod
    def words(what, lang):
        W = WORDS.get(lang, WORDS["en"])
        if what["kind"] == "go":
            t = what["table"]
            name = (t.name or "").strip()
            label = table_de(t) if lang == "de" else \
                (name if name and not name.startswith("Table ") else W["table"](t.number))
            return {"title": W["go"](label), "body": W["against"](what["opp"]),
                    "tag": "ttt-call", "topic": "call", "sticky": True}
        if what["kind"] == "next":
            nums = what["tables"]
            t = (W["table"](nums[0]) if len(nums) == 1 else
                 (("Tische " if lang == "de" else "Tables ") + f"{min(nums)}–{max(nums)}")
                 if nums else "")
            return {"title": W["next"], "body": W["next_b"](t).rstrip(" ·"),
                    "tag": "ttt-call", "topic": "call"}
        g = " ".join(f"{a}:{b}" for a, b in what["games"])
        if what.get("fix"):
            return {"title": W["fix"](what["by"]), "body": W["fix_b"](g),
                    "tag": "ttt-claim", "topic": "claim", "sticky": True}
        return {"title": W["claim"](what["by"]), "body": W["claim_b"](g),
                "tag": "ttt-claim", "topic": "claim", "sticky": True}

    # -- sending
    def changed(self):
        self._wake.set()

    def pump(self, now=None):
        """Plan, and send whatever has not been sent. Returns how many went."""
        sent = 0
        for key, who, what in self.plan(now):
            if self._all("SELECT 1 FROM sent WHERE key=?", (key,)):
                continue
            # a call that reached a push service, or was refused by one, is
            # done; one the network ate is tried again next time round
            # (until it goes stale, which plan() sees to)
            lost = 0
            subs = self.subs(who)
            for sub in subs:
                w = self.words(what, sub["lang"])
                payload = {k: w[k] for k in ("title", "body", "tag")}
                payload.update(url="/", sticky=bool(w.get("sticky")))
                try:
                    status = self.send(sub, payload, self.vapid, self.subject(),
                                       ttl=CALL_TTL, topic=w["topic"])
                except Exception as e:          # a dead network is the next pump's problem
                    print("[push]", repr(e), flush=True)
                    lost += 1
                    continue
                if status in (404, 410):        # the phone unsubscribed, or the app was removed
                    self.unsubscribe(sub["endpoint"])
                elif 200 <= status < 300:
                    sent += 1
            if not subs or lost < len(subs):
                self._q("INSERT OR IGNORE INTO sent VALUES (?,?)", (key, time.time()))
        self._q("DELETE FROM sent WHERE ts < ?", (time.time() - 2 * 86400,))
        return sent

    def loop(self):
        while True:
            self._wake.wait(2)
            self._wake.clear()
            v = self.app.store.version
            if v == self._last[0] and time.time() - self._last[1] < self.PLAN_EVERY:
                continue
            self._last = (v, time.time())
            try:
                self.pump()
            except Exception as e:
                print("[push]", repr(e), flush=True)

    def start(self):
        threading.Thread(target=self.loop, daemon=True).start()
