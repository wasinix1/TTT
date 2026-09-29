"""Telegram: the wire.

The Bot API over plain `urllib`, a small sqlite file of its own, and three
threads — one listening, one working out what to say, one saying it. Still
no pip install: the only thing this needs is the token from @BotFather.

What lives where (docs/telegram.md, principle 3):

  event.db      decisions — who a Telegram account is, entries, results
  telegram.db   conversation — who follows the bot, what was sent, what was
                said back, and the outbox that remembers every notice key

The server long-polls Telegram rather than taking a webhook, so it needs no
inbound port, no Caddy change and works the same on a laptop in the hall.
Every failure here is contained: a dead network, a revoked token or a user
who blocked the bot shows up as a status line in the console, never as an
error on the night.
"""

import json
import os
import secrets
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.request

from . import notify
from .bot import Conversation, esc

API = "https://api.telegram.org"
RATE = 25                  # messages a second, well under Telegram's 30
TOKEN_TTL = 12 * 3600      # a door QR code is good for the evening


def log(*a):
    print("[telegram]", *a, file=sys.stderr, flush=True)


class TgError(Exception):
    def __init__(self, code, desc, retry_after=None):
        super().__init__(f"{code} {desc}")
        self.code, self.desc, self.retry_after = code, desc or "", retry_after


def http_transport(token):
    """The real thing: one JSON POST per call. Proxies come from the
    environment, as urllib always does."""
    def call(method, params, timeout=15):
        req = urllib.request.Request(
            f"{API}/bot{token}/{method}", data=json.dumps(params).encode(),
            headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                body = json.load(r)
        except urllib.error.HTTPError as e:
            try:
                body = json.load(e)
            except Exception:
                raise TgError(e.code, e.reason)
        except (urllib.error.URLError, OSError, ValueError) as e:
            raise TgError(0, f"network: {getattr(e, 'reason', e)}")
        if not body.get("ok"):
            raise TgError(body.get("error_code", 0), body.get("description", ""),
                          (body.get("parameters") or {}).get("retry_after"))
        return body["result"]
    return call


# --------------------------------------------------------------------- wire

SCHEMA = """
CREATE TABLE IF NOT EXISTS chats (
  chat_id INTEGER PRIMARY KEY, first_name TEXT, last_name TEXT, username TEXT,
  name TEXT DEFAULT '', started REAL, blocked INTEGER DEFAULT 0,
  news INTEGER DEFAULT 1, pending TEXT DEFAULT '', card_msg INTEGER,
  card_hash TEXT DEFAULT '', last_ack REAL DEFAULT 0);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE, chat_id INTEGER,
  method TEXT, payload TEXT, prio INTEGER DEFAULT 1, created REAL,
  expires REAL, state TEXT DEFAULT 'queued', message_id INTEGER,
  tries INTEGER DEFAULT 0, error TEXT DEFAULT '', ref TEXT DEFAULT '{}',
  closed INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS outbox_due ON outbox (state, prio, id);
CREATE TABLE IF NOT EXISTS inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER, ts REAL,
  dir TEXT, text TEXT, read INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS claims (
  id INTEGER PRIMARY KEY AUTOINCREMENT, match_id TEXT, qseq INTEGER,
  side TEXT, chat_id INTEGER, games TEXT, ts REAL, state TEXT DEFAULT 'open');
CREATE TABLE IF NOT EXISTS tokens (token TEXT PRIMARY KEY, person_id TEXT, created REAL);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
"""


class Wire:
    """telegram.db. Every method takes its own short lock, and nothing here
    ever reaches back into the store, so the lock order is always
    store -> wire and can never deadlock."""

    def __init__(self, path):
        self.lock = threading.RLock()
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(SCHEMA)
        self._migrate()
        self.conn.commit()

    def _migrate(self):
        """Columns added after a telegram.db was first created. Adding is the
        only change ever made, so an older file just gains them."""
        want = {"chats": {"card_hash": "TEXT DEFAULT ''", "last_ack": "REAL DEFAULT 0"}}
        for table, cols in want.items():
            have = {r[1] for r in self.conn.execute(f"PRAGMA table_info({table})")}
            for col, decl in cols.items():
                if col not in have:
                    self.conn.execute(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")

    def _q(self, sql, args=()):
        with self.lock:
            cur = self.conn.execute(sql, args)
            self.conn.commit()
            return cur

    def _all(self, sql, args=()):
        with self.lock:
            return [dict(r) for r in self.conn.execute(sql, args).fetchall()]

    # chats
    def chat(self, chat_id):
        rows = self._all("SELECT * FROM chats WHERE chat_id=?", (chat_id,))
        return rows[0] if rows else None

    def upsert_chat(self, user):
        with self.lock:
            if self.chat(user["id"]) is None:
                self._q("INSERT INTO chats (chat_id, first_name, last_name, username, started)"
                        " VALUES (?,?,?,?,?)",
                        (user["id"], user.get("first_name", ""), user.get("last_name", ""),
                         user.get("username", ""), time.time()))
            else:
                self._q("UPDATE chats SET first_name=?, last_name=?, username=?, blocked=0"
                        " WHERE chat_id=?",
                        (user.get("first_name", ""), user.get("last_name", ""),
                         user.get("username", ""), user["id"]))

    CHAT_FIELDS = ("name", "blocked", "news", "pending", "card_msg", "card_hash",
                   "last_ack")

    def set_chat(self, chat_id, **kw):
        kw = {k: v for k, v in kw.items() if k in self.CHAT_FIELDS}
        if not kw:
            return
        self._q(f"UPDATE chats SET {', '.join(k + '=?' for k in kw)} WHERE chat_id=?",
                (*kw.values(), chat_id))

    def chats(self, news_only=False):
        return self._all("SELECT * FROM chats WHERE blocked=0"
                         + (" AND news=1" if news_only else ""))

    def ok_chats(self):
        with self.lock:
            return {r[0] for r in self.conn.execute(
                "SELECT chat_id FROM chats WHERE blocked=0")}

    # outbox
    def enqueue(self, key, chat_id, method, params, prio=1, ttl=None, ref=None):
        """Queue a message under a key. A key is only ever queued once — that
        is the whole de-duplication, and it survives a restart."""
        now = time.time()
        cur = self._q("INSERT OR IGNORE INTO outbox (key, chat_id, method, payload, prio,"
                      " created, expires, ref) VALUES (?,?,?,?,?,?,?,?)",
                      (key, chat_id, method, json.dumps(params), prio, now,
                       now + ttl if ttl else None, json.dumps(ref or {})))
        return cur.rowcount > 0

    def due(self, limit=20):
        rows = self._all("SELECT * FROM outbox WHERE state='queued' ORDER BY prio, id LIMIT ?",
                         (limit,))
        for r in rows:
            r["params"] = json.loads(r.pop("payload"))
            r["ref"] = json.loads(r["ref"] or "{}")
        return rows

    def mark(self, row_id, state, message_id=None, error="", tries=None):
        self._q("UPDATE outbox SET state=?, message_id=COALESCE(?, message_id), error=?,"
                " tries=COALESCE(?, tries) WHERE id=?",
                (state, message_id, error[:300], tries, row_id))

    def fresh_key(self, key):
        """The key to plan a notice under. Normally the key itself; but a
        notice already taken back (a table call edited to "put back") that
        is true again — a rewind reinstated the seating — has to be said
        again, and the old key would swallow it."""
        with self.lock:
            while True:
                row = self.conn.execute("SELECT closed FROM outbox WHERE key=?",
                                        (key,)).fetchone()
                if not row or not row[0]:
                    return key
                key += "+"

    def open_sent(self):
        rows = self._all("SELECT id, key, chat_id, message_id, ref FROM outbox"
                         " WHERE state='sent' AND closed=0 AND method='sendMessage'"
                         " AND (key LIKE 'go:%' OR key LIKE 'next:%')")
        return [{"id": r["id"], "key": r["key"], "chat": r["chat_id"],
                 "message_id": r["message_id"], "ref": json.loads(r["ref"] or "{}")}
                for r in rows]

    def close(self, row_id):
        self._q("UPDATE outbox SET closed=1 WHERE id=?", (row_id,))

    def queued_count(self):
        with self.lock:
            return self.conn.execute(
                "SELECT COUNT(*) FROM outbox WHERE state='queued'").fetchone()[0]

    # inbox
    def note(self, chat_id, direction, text):
        self._q("INSERT INTO inbox (chat_id, ts, dir, text, read) VALUES (?,?,?,?,?)",
                (chat_id, time.time(), direction, text, int(direction != "in")))

    def mark_read(self, chat_id=None):
        if chat_id is None:
            self._q("UPDATE inbox SET read=1 WHERE chat_id IS NULL")
        else:
            self._q("UPDATE inbox SET read=1 WHERE chat_id=?", (chat_id,))

    def inbox(self, limit=400):
        return self._all("SELECT * FROM inbox ORDER BY id DESC LIMIT ?", (limit,))

    # claims
    def add_claim(self, match_id, qseq, side, chat_id, games):
        return self._q("INSERT INTO claims (match_id, qseq, side, chat_id, games, ts)"
                       " VALUES (?,?,?,?,?,?)",
                       (match_id, qseq, side, chat_id, json.dumps(games), time.time())).lastrowid

    def _claim(self, r):
        r["games"] = json.loads(r["games"])
        return r

    def claim(self, cid):
        rows = self._all("SELECT * FROM claims WHERE id=?", (cid,))
        return self._claim(rows[0]) if rows else None

    def claims_for(self, match_id, qseq):
        return [self._claim(r) for r in self._all(
            "SELECT * FROM claims WHERE match_id=? AND qseq=? AND state='open'",
            (match_id, qseq))]

    def close_claim(self, cid, state):
        self._q("UPDATE claims SET state=? WHERE id=?", (state, cid))

    # door tokens
    def new_token(self, person_id):
        tok = secrets.token_urlsafe(12)
        self._q("DELETE FROM tokens WHERE created < ?", (time.time() - TOKEN_TTL,))
        self._q("INSERT INTO tokens VALUES (?,?,?)", (tok, person_id, time.time()))
        return tok

    def take_token(self, tok):
        with self.lock:
            rows = self._all("SELECT * FROM tokens WHERE token=?", (tok,))
            self._q("DELETE FROM tokens WHERE token=?", (tok,))
        if not rows or time.time() - rows[0]["created"] > TOKEN_TTL:
            return None
        return rows[0]["person_id"]

    # kv
    def get(self, k, default=None):
        rows = self._all("SELECT v FROM kv WHERE k=?", (k,))
        return json.loads(rows[0]["v"]) if rows else default

    def put(self, k, v):
        self._q("INSERT OR REPLACE INTO kv VALUES (?,?)", (k, json.dumps(v)))


# ---------------------------------------------------------------------- bot

class Bot:
    """The bot for one live App. The sandbox never gets one."""

    def __init__(self, app, data_dir, transport=None):
        self.app = app
        self.data_dir = data_dir
        self.cfg_path = os.path.join(data_dir, "telegram.json")
        self.cfg = self._load()
        self.wire = Wire(os.path.join(data_dir, "telegram.db"))
        self._transport = transport
        self.call = transport or (http_transport(self.cfg["token"])
                                  if self.cfg.get("token") else None)
        self.convo = Conversation(self)
        self.status = {"ok": None, "error": "", "last_ok": 0}
        self._stop = threading.Event()
        self._kick = threading.Event()
        self._threads = []
        self._last_plan = (None, 0.0)

    # ------------------------------------------------------------ config

    def _load(self):
        try:
            with open(self.cfg_path) as fh:
                return json.load(fh)
        except (OSError, ValueError):
            return {}

    def _save(self):
        tmp = self.cfg_path + ".tmp"
        with open(tmp, "w") as fh:
            json.dump(self.cfg, fh, indent=2)
        os.chmod(tmp, 0o600)          # the token is a password
        os.replace(tmp, self.cfg_path)

    @property
    def on(self):
        return bool(self.cfg.get("token") and self.call)

    @property
    def username(self):
        return self.cfg.get("username", "") if self.on else ""

    def link(self, payload=""):
        if not self.username:
            return ""
        return f"https://t.me/{self.username}" + (f"?start={payload}" if payload else "")

    def public_url(self):
        return self.cfg.get("url", "")

    def connect(self, token, url=""):
        """Check the token with Telegram, keep it, and start listening."""
        token = (token or "").strip()
        if not token or ":" not in token:
            raise ValueError("that does not look like a bot token — it is the long "
                             "line @BotFather sends, with a colon in it")
        call = self._transport or http_transport(token)
        try:
            me = call("getMe", {})
            call("deleteWebhook", {"drop_pending_updates": False})
            call("setMyCommands", {"commands": [
                {"command": "start", "description": "Mein Abend"},
                {"command": "stop", "description": "Keine Neuigkeiten mehr"}]})
        except TgError as e:
            if e.code in (401, 404):
                raise ValueError("Telegram does not know that token — copy it again "
                                 "from @BotFather")
            raise ValueError(f"could not reach Telegram: {e.desc or e}")
        self.stop()
        self.cfg = {"token": token, "username": me.get("username", ""),
                    "url": url or self.cfg.get("url", "")}
        self._save()
        self.call = call
        self.status = {"ok": True, "error": "", "last_ok": time.time()}
        if not self._transport:
            self.start()
        self.changed()
        return self.cfg["username"]

    def disconnect(self):
        self.stop()
        self.cfg = {}
        try:
            os.remove(self.cfg_path)
        except OSError:
            pass
        self.call = None
        self.changed()

    def remember_url(self, url):
        if url and url.startswith(("http://", "https://")) and url != self.cfg.get("url") \
                and self.cfg.get("token"):
            self.cfg["url"] = url.rstrip("/") + "/"
            self._save()

    # ------------------------------------------------------------- calls

    def api(self, method, params, quiet=False):
        """A call made in answer to something a player did. Failures are
        logged and swallowed: a missed edit is not worth an exception."""
        if not self.on:
            return None
        try:
            out = self.call(method, params)
            self._ok()
            return out
        except TgError as e:
            if e.code == 403 and "chat_id" in params:
                self.wire.set_chat(params["chat_id"], blocked=1)
            elif not (quiet or "not modified" in e.desc):
                log(method, e)
            if e.code == 0:
                self._fail(e.desc)
            return None

    def system(self, op, p):
        """A player action, already checked to be theirs, through the same op
        the console would use."""
        try:
            return self.app.act("system", op, p)
        except (ValueError, KeyError) as e:
            raise ValueError(str(e))

    def ok_chats(self):
        return self.wire.ok_chats()

    def changed(self):
        """Something the console shows about Telegram moved."""
        self.app.store.touch()

    def _ok(self):
        self.status.update(ok=True, error="", last_ok=time.time())

    def _fail(self, why):
        if self.status.get("error") != why:
            log(why)
        self.status.update(ok=False, error=why)

    # ------------------------------------------------------------ threads

    def start(self):
        if self._threads or not self.on:
            return
        self._stop.clear()
        for fn in (self._poll_loop, self._plan_loop, self._send_loop):
            t = threading.Thread(target=fn, daemon=True, name="tg-" + fn.__name__)
            t.start()
            self._threads.append(t)
        log(f"listening as @{self.username}")

    def stop(self):
        self._stop.set()
        self._kick.set()
        for t in self._threads:
            t.join(timeout=2)
        self._threads = []
        self._kick.clear()

    def _poll_loop(self):
        back = 1
        while not self._stop.is_set():
            try:
                self.poll(timeout=25)
                back = 1
            except TgError as e:
                if e.code in (401, 404):
                    self._fail("Telegram rejected the token — connect the bot again")
                    self._stop.wait(60)
                elif e.code == 409:
                    self._fail("another copy of this bot is running somewhere — "
                               "only one server can listen to it")
                    self._stop.wait(20)
                else:
                    self._fail(e.desc or "cannot reach Telegram")
                    self._stop.wait(back)
                    back = min(60, back * 2)
            except Exception as e:           # never let the listener die
                log("poll:", repr(e))
                self._stop.wait(5)

    def _plan_loop(self):
        while not self._stop.is_set():
            try:
                self.plan()
            except Exception as e:
                log("plan:", repr(e))
            self._stop.wait(0.5)

    def _send_loop(self):
        while not self._stop.is_set():
            try:
                if not self.flush():
                    self._kick.wait(1)
                    self._kick.clear()
            except Exception as e:
                log("send:", repr(e))
                self._stop.wait(2)

    # ------------------------------------------------------------ the work

    def poll(self, timeout=0):
        """Fetch and handle whatever players sent since last time."""
        if not self.on:
            return 0
        off = self.wire.get("offset", 0)
        ups = self.call("getUpdates", {
            "offset": off, "timeout": timeout,
            "allowed_updates": ["message", "callback_query", "my_chat_member"]},
            timeout=timeout + 10)
        self._ok()
        for u in ups:
            try:
                self.convo.on_update(u)
            except Exception as e:
                log("update:", repr(e))
            self.wire.put("offset", u["update_id"] + 1)
        return len(ups)

    PLAN_EVERY = 15      # the board's times drift even when nothing happens

    def plan(self, force=False):
        """Work out what should have been said and queue what has not. Runs
        whenever the state moves, and every few seconds regardless."""
        if not self.on:
            return
        s = self.app.store
        v, when = self._last_plan
        now = time.time()
        if not force and v == s.version and now - when < self.PLAN_EVERY:
            return
        self._last_plan = (s.version, now)
        ok = self.ok_chats()
        with s.lock:
            notices = notify.plan(self.app, ok, now)
            after = notify.settle(self.app, self.wire.open_sent(), ok)
        new = 0
        for n in notices:
            key = self.wire.fresh_key(n["key"]) if n["ref"].get("kind") else n["key"]
            new += self.wire.enqueue(key, n["chat"], n["method"], n["params"],
                                     n["prio"], n["ttl"], n["ref"])
        for a in after:
            row = a["row"]
            verb = "del" if a["method"] == "deleteMessage" else "end"
            self.wire.enqueue(f"{verb}:{row['key']}", row["chat"], a["method"],
                              a["params"], prio=0)
            self.wire.close(row["id"])
        new += self.refresh_cards(ok)
        if new or after:
            self._kick.set()

    def refresh_cards(self, ok):
        """Keep each player's card true, silently: an edit, never a new
        message, and only when what it says about them has changed. Only
        for people with something going on — an entry or a match tonight."""
        s = self.app.store
        with s.lock:
            chats = set(notify.reach_map(s, ok).values())
            chats.update(c for c in (notify._reg_chat(s, r, ok)
                                     for r in s.registrations.values()) if c)
        n = 0
        for chat_id in chats:
            c = self.wire.chat(chat_id)
            if not c or not c.get("card_msg"):
                continue
            h = self.convo.card_hash(chat_id)
            if h == c.get("card_hash"):
                continue
            text, kb = self.convo.card(chat_id)
            self.wire.set_chat(chat_id, card_hash=h)
            n += self.wire.enqueue(
                f"card:{chat_id}:{c['card_msg']}:{h}", chat_id, "editMessageText",
                {"chat_id": chat_id, "message_id": c["card_msg"], "text": text,
                 "parse_mode": "HTML", "link_preview_options": {"is_disabled": True},
                 "reply_markup": {"inline_keyboard": kb}},
                prio=1, ttl=3600, ref={"card": h})
        return n

    def flush(self, limit=40):
        """Send what is due. Returns how many went, so the loop can idle."""
        if not self.on:
            return 0
        sent = 0
        for row in self.wire.due(limit):
            if self._stop.is_set() and self._threads:
                break
            now = time.time()
            if row["expires"] and now > row["expires"]:
                self.wire.mark(row["id"], "skipped", error="expired")
                continue
            if row["ref"].get("kind"):
                with self.app.store.lock:
                    true = notify.still_true(self.app, row["ref"])
                if not true:
                    self.wire.mark(row["id"], "skipped", error="no longer true")
                    continue
            if row["ref"].get("card") and \
                    row["ref"]["card"] != (self.wire.chat(row["chat_id"]) or {}).get("card_hash"):
                self.wire.mark(row["id"], "skipped", error="a newer card replaced it")
                continue
            try:
                out = self.call(row["method"], row["params"])
                self._ok()
                mid = out.get("message_id") if isinstance(out, dict) else None
                self.wire.mark(row["id"], "sent", message_id=mid)
                if row["key"].startswith("bc:"):
                    self.wire.note(row["chat_id"], "out", row["params"].get("text", ""))
                sent += 1
            except TgError as e:
                if e.code == 429:
                    self._stop.wait(min(60, e.retry_after or 5))
                    return sent
                if e.code == 403:
                    self.wire.set_chat(row["chat_id"], blocked=1)
                    self.wire.mark(row["id"], "dead", error=e.desc)
                elif e.code == 400 and ("not modified" in e.desc or "not found" in e.desc
                                        or "can't be deleted" in e.desc):
                    self.wire.mark(row["id"], "sent")
                elif e.code == 0 or e.code >= 500:
                    tries = row["tries"] + 1
                    self._fail(e.desc or "cannot reach Telegram")
                    self.wire.mark(row["id"], "dead" if tries > 20 else "queued",
                                   error=e.desc, tries=tries)
                    self._stop.wait(min(30, tries))
                    return sent
                else:
                    self.wire.mark(row["id"], "dead", error=e.desc)
                    log(row["method"], e)
            if self._threads:
                self._stop.wait(1 / RATE)
        return sent

    def pump(self):
        """Everything the threads do, once, in order. For tests and for the
        sandbox-free way of stepping through a conversation."""
        self.poll()
        self.plan(force=True)
        while self.flush():
            pass

    # ------------------------------------------------------------ console

    def audience(self, kind, cup_id="", chat_id=None):
        """Who a message to this audience would reach, as chat ids."""
        s = self.app.store
        ok = self.ok_chats()
        if kind == "chat":
            return [chat_id] if chat_id in ok else []
        if kind == "followers":
            return sorted(c["chat_id"] for c in self.wire.chats(news_only=True))
        with s.lock:
            if kind == "registered":
                return sorted({c for c in (notify._reg_chat(s, r, ok)
                                           for r in s.pending_regs()) if c})
            reach = notify.reach_map(s, ok)
            out = set()
            for e in s.entrants.values():
                if not e.active or (kind == "cup" and e.cup_id != cup_id):
                    continue
                out.update(reach[p] for p in e.player_ids if p in reach)
            return sorted(out)

    def audiences(self):
        s = self.app.store
        out = [{"id": "followers", "label": "Everyone following the bot",
                "n": len(self.audience("followers"))},
               {"id": "registered", "label": "Pre-registered",
                "n": len(self.audience("registered"))},
               {"id": "tonight", "label": "Tonight's players",
                "n": len(self.audience("tonight"))}]
        if len(s.cups) > 1:
            for cid in s.cup_order:
                if cid in s.cups:
                    out.append({"id": "cup:" + cid, "label": s.cups[cid].name,
                                "n": len(self.audience("cup", cid))})
        return out

    def broadcast(self, audience, text, announce=False, chat_id=None):
        text = (text or "").strip()
        if not text and not announce:
            raise ValueError("write something first")
        if len(text) > 3500:
            raise ValueError("that is too long for one message")
        kind, _, cup = audience.partition(":")
        chats = self.audience(kind, cup, chat_id)
        if not chats:
            raise ValueError("nobody to send that to yet")
        batch = secrets.token_hex(4)
        head = "💬 <b>Orga:</b> " if kind == "chat" else "📣 "
        for c in chats:
            if announce:
                card, kb = self.convo.card(c, esc(text) if text else "")
                params = {"chat_id": c, "text": "📣 <b>Neuer Termin!</b>\n\n" + card,
                          "parse_mode": "HTML", "link_preview_options": {"is_disabled": True},
                          "reply_markup": {"inline_keyboard": kb}}
            else:
                params = {"chat_id": c, "text": head + esc(text), "parse_mode": "HTML",
                          "link_preview_options": {"is_disabled": True}}
            self.wire.enqueue(f"bc:{batch}:{c}", c, "sendMessage", params,
                              prio=1 if kind in ("chat", "tonight", "cup") else 2)
        if kind == "chat":
            self.wire.mark_read(chat_id)
        self._kick.set()
        self.changed()
        return len(chats)

    def door_link(self, person_id):
        if person_id not in self.app.store.people:
            raise ValueError("no such person")
        return self.link("p_" + self.wire.new_token(person_id))

    def admin_state(self):
        if not self.on:
            return {"on": False}
        s = self.app.store
        people = {p.tg_id: p for p in s.people.values() if p.tg_id}
        chats = {c["chat_id"]: c for c in self.wire.chats()}
        threads = {}
        for m in self.wire.inbox():
            k = m["chat_id"]
            th = threads.get(k)
            if th is None:
                c = chats.get(k) or self.wire.chat(k) or {}
                who = people.get(k)
                handle = ("@" + c["username"]) if c.get("username") else ""
                name = who.name if who else (c.get("name") or " ".join(
                    x for x in (c.get("first_name"), c.get("last_name")) if x) or handle)
                th = threads[k] = {"chat_id": k, "name": name if k else "Telegram",
                                   "handle": handle, "person_id": who.id if who else None,
                                   "unread": 0, "last": m["ts"], "messages": [],
                                   "system": k is None,
                                   "reachable": bool(k) and not c.get("blocked")}
            if len(th["messages"]) < 30:
                th["messages"].append({"dir": m["dir"], "text": m["text"], "ts": m["ts"]})
            if m["dir"] == "in" and not m["read"]:
                th["unread"] += 1
            if m["dir"] == "sys" and not m["read"]:
                th["unread"] += 1
        for th in threads.values():
            th["messages"].reverse()
        return {
            "on": True, "username": self.username, "link": self.link("join"),
            "ok": self.status.get("ok"), "error": self.status.get("error", ""),
            "last_ok": self.status.get("last_ok", 0),
            "queued": self.wire.queued_count(),
            "followers": len(self.wire.chats(news_only=True)),
            "audiences": self.audiences(),
            "threads": sorted(threads.values(), key=lambda t: -t["last"])[:40],
            "unread": sum(t["unread"] for t in threads.values()),
        }
