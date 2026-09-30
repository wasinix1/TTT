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

import http.client
import json
import os
import secrets
import socket
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from concurrent.futures import ThreadPoolExecutor

from . import notify
from .bot import Conversation, esc

API = "https://api.telegram.org"
RATE = 25                  # messages a second, well under Telegram's 30
CARD_PRIO = 3              # a card keeping itself current goes after anything said
TOKEN_TTL = 12 * 3600      # a door QR code is good for the evening


def log(*a):
    print("[telegram]", *a, file=sys.stderr, flush=True)


class TgError(Exception):
    def __init__(self, code, desc, retry_after=None):
        super().__init__(f"{code} {desc}")
        self.code, self.desc, self.retry_after = code, desc or "", retry_after


HOST = "api.telegram.org"
CONNECT_TIMEOUT = 4        # per address; a route that eats packets costs this, once


class _Conn(http.client.HTTPSConnection):
    """A connection that tries IPv4 first, and gives up on an address fast.

    Python tries addresses one after another with the full timeout each, so
    a server whose IPv6 route silently drops packets waited that long on
    every single call before falling back — the difference between a bot
    that answers at once and one that feels broken. IPv4 first, a short
    connect timeout, and the reads get the call's own timeout."""

    def connect(self):
        infos = socket.getaddrinfo(self.host, self.port, type=socket.SOCK_STREAM)
        infos.sort(key=lambda i: i[0] != socket.AF_INET)
        err = None
        for fam, typ, proto, _, addr in infos:
            sock = socket.socket(fam, typ, proto)
            sock.settimeout(CONNECT_TIMEOUT)
            try:
                sock.connect(addr)
            except OSError as e:
                err = e
                sock.close()
                continue
            sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            sock.settimeout(self.timeout)
            self.sock = self._context.wrap_socket(sock, server_hostname=self.host)
            return
        raise err or OSError("no address for " + self.host)


def _answer(status, raw):
    try:
        body = json.loads(raw)
    except ValueError:
        raise TgError(status, "bad response from Telegram")
    if not body.get("ok"):
        raise TgError(body.get("error_code", status), body.get("description", ""),
                      (body.get("parameters") or {}).get("retry_after"))
    return body["result"]


def http_transport(token):
    """The real thing: JSON POSTs over a connection each thread keeps open.

    A fresh connection is a TCP and a TLS handshake before Telegram even sees
    the request — several round trips, on every call, and a tap costs two
    calls. Keeping one open per thread makes a call one round trip. Behind a
    proxy (HTTPS_PROXY set) it falls back to urllib, which knows how to use
    one."""
    if os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy"):
        return _urllib_transport(token)
    local = threading.local()

    def call(method, params, timeout=15):
        body = json.dumps(params).encode()
        for attempt in (0, 1):
            conn = getattr(local, "conn", None)
            reused = conn is not None
            if conn is None:
                conn = local.conn = _Conn(HOST, timeout=timeout)
            conn.timeout = timeout
            if conn.sock:
                conn.sock.settimeout(timeout)
            try:
                conn.request("POST", f"/bot{token}/{method}", body,
                             {"Content-Type": "application/json"})
                r = conn.getresponse()
                return _answer(r.status, r.read())
            except (http.client.HTTPException, OSError) as e:
                conn.close()
                local.conn = None
                # a kept connection Telegram closed while it sat idle: the
                # request never got there, so once more on a new one
                if reused and attempt == 0 and not isinstance(e, socket.timeout):
                    continue
                raise TgError(0, f"network: {e}")
    return call


def _urllib_transport(token):
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
  side TEXT, chat_id INTEGER, games TEXT, ts REAL, state TEXT DEFAULT 'open',
  msgs TEXT DEFAULT '[]');
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
        # this file is conversation, not the event log: a power cut may cost
        # the last outbox write, never the evening. WAL and NORMAL make every
        # write here a memory copy instead of a disk flush
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA synchronous=NORMAL")
        self.conn.executescript(SCHEMA)
        self._migrate()
        self.conn.commit()

    def _migrate(self):
        """Columns added after a telegram.db was first created. Adding is the
        only change ever made, so an older file just gains them."""
        want = {"chats": {"card_hash": "TEXT DEFAULT ''", "last_ack": "REAL DEFAULT 0"},
                "claims": {"msgs": "TEXT DEFAULT '[]'"},
                "outbox": {"after": "REAL"}}
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

    def enqueue_many(self, items):
        """Queue a plan's worth of notices in one write. Each is (key, chat,
        method, params, prio, ttl, ref); a notice that was taken back and is
        true again gets a new key, so it is said again. Returns how many are new."""
        now, new = time.time(), 0
        with self.lock:
            for key, chat, method, params, prio, ttl, ref in items:
                if (ref or {}).get("kind"):
                    while True:
                        row = self.conn.execute("SELECT closed FROM outbox WHERE key=?",
                                                (key,)).fetchone()
                        if not row or not row[0]:
                            break
                        key += "+"
                cur = self.conn.execute(
                    "INSERT OR IGNORE INTO outbox (key, chat_id, method, payload, prio,"
                    " created, expires, ref) VALUES (?,?,?,?,?,?,?,?)",
                    (key, chat, method, json.dumps(params), prio, now,
                     now + ttl if ttl else None, json.dumps(ref or {})))
                new += cur.rowcount > 0
            self.conn.commit()
        return new

    def later(self, row_id, secs):
        """Telegram said slow down for this one: keep it, try it again after."""
        self._q("UPDATE outbox SET after=? WHERE id=?", (time.time() + secs, row_id))

    def due(self, limit=20):
        rows = self._all("SELECT * FROM outbox WHERE state='queued'"
                         " AND (after IS NULL OR after <= ?) ORDER BY prio, id LIMIT ?",
                         (time.time(), limit))
        for r in rows:
            r["params"] = json.loads(r.pop("payload"))
            r["ref"] = json.loads(r["ref"] or "{}")
        return rows

    def mark(self, row_id, state, message_id=None, error="", tries=None):
        self._q("UPDATE outbox SET state=?, message_id=COALESCE(?, message_id), error=?,"
                " tries=COALESCE(?, tries) WHERE id=?",
                (state, message_id, error[:300], tries, row_id))

    def open_sent(self):
        rows = self._all("SELECT id, key, chat_id, message_id, ref FROM outbox"
                         " WHERE state='sent' AND closed=0 AND method='sendMessage'"
                         " AND (key LIKE 'go:%' OR key LIKE 'next:%')")
        return [{"id": r["id"], "key": r["key"], "chat": r["chat_id"],
                 "message_id": r["message_id"], "ref": json.loads(r["ref"] or "{}")}
                for r in rows]

    def close(self, row_id):
        self._q("UPDATE outbox SET closed=1 WHERE id=?", (row_id,))

    def keep(self, chat_id, message_id):
        """A player acted on this message, so it is theirs now: never tidy
        it away underneath them."""
        self._q("UPDATE outbox SET closed=1 WHERE chat_id=? AND message_id=?",
                (chat_id, message_id))

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

    def mark_all_read(self):
        self._q("UPDATE inbox SET read=1")

    def inbox(self, limit=400):
        return self._all("SELECT * FROM inbox ORDER BY id DESC LIMIT ?", (limit,))

    # claims
    def add_claim(self, match_id, qseq, side, chat_id, games):
        return self._q("INSERT INTO claims (match_id, qseq, side, chat_id, games, ts)"
                       " VALUES (?,?,?,?,?,?)",
                       (match_id, qseq, side, chat_id, json.dumps(games), time.time())).lastrowid

    def _claim(self, r):
        r["games"] = json.loads(r["games"])
        r["msgs"] = json.loads(r.get("msgs") or "[]")
        return r

    def set_claim_msgs(self, cid, msgs):
        self._q("UPDATE claims SET msgs=? WHERE id=?", (json.dumps(msgs), cid))

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
        self._times = deque(maxlen=60)   # recent call durations, for the console
        self.call = self._timed(transport or (http_transport(self.cfg["token"])
                                              if self.cfg.get("token") else None))
        self.convo = Conversation(self)
        self.status = {"ok": None, "error": "", "last_ok": 0}
        self._stop = threading.Event()
        self._kick = threading.Event()
        self._threads = []
        self._gen = 0             # bumped on every start: an old thread still in a
                                  # long poll sees it has been replaced and leaves
        self._last_plan = (None, 0.0)
        # Players are handled side by side, each chat in its own order: one
        # listener working through updates one at a time made the fortieth
        # tap after an announcement wait for the thirty-nine before it
        self._pool = ThreadPoolExecutor(max_workers=8, thread_name_prefix="tg-chat")
        self._lines = {}                 # chat -> updates waiting, while one runs
        self._lines_lock = threading.Lock()

    SLOW = 2.0      # a call taking longer than this is worth a line in the log

    def _timed(self, call):
        """Every call, timed. The console shows the typical one, which is the
        first thing to look at when the bot feels slow."""
        if call is None:
            return None

        def timed(method, params, timeout=15):
            t = time.monotonic()
            try:
                return call(method, params, timeout=timeout)
            finally:
                if method != "getUpdates":
                    took = time.monotonic() - t
                    self._times.append(took)
                    if took > self.SLOW:
                        log(f"{method} took {took:.1f}s")
        return timed

    def latency_ms(self):
        xs = sorted(self._times)
        return int(xs[len(xs) // 2] * 1000) if xs else None

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
        """The console's public address, for the Live button. Only a public
        https one: Telegram refuses a button pointing at a LAN address, and
        would take the whole message down with it."""
        url = self.cfg.get("url", "")
        return url if url.startswith("https://") else ""

    def connect(self, token, url=""):
        """Check the token with Telegram, keep it, and start listening."""
        token = (token or "").strip()
        if not token or ":" not in token:
            raise ValueError("that does not look like a bot token — it is the long "
                             "line @BotFather sends, with a colon in it")
        call = self._timed(self._transport or http_transport(token))
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
                    "url": url if url.startswith("https://") else self.cfg.get("url", "")}
        self._save()
        self.call = call
        self.status = {"ok": True, "error": "", "last_ok": time.time()}
        self.set_menu()
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

    def app_url(self):
        """The Mini App, if there is a public address to serve it from."""
        url = self.public_url()
        return url + "tg" if url else ""

    def set_menu(self):
        """The button beside every player's message box: the Mini App when
        there is one to open, Telegram's own command list when there is not."""
        url = self.app_url()
        self.api("setChatMenuButton", {"menu_button": {
            "type": "web_app", "text": "Mein Abend", "web_app": {"url": url}}
            if url else {"type": "commands"}}, quiet=True)

    def remember_url(self, url):
        if url and url.startswith("https://") and url != self.cfg.get("url") \
                and self.cfg.get("token"):
            self.cfg["url"] = url.rstrip("/") + "/"
            self._save()
            self.set_menu()

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
        self._gen += 1
        for fn in (self._poll_loop, self._plan_loop, self._send_loop):
            t = threading.Thread(target=fn, args=(self._gen,), daemon=True,
                                 name="tg-" + fn.__name__)
            t.start()
            self._threads.append(t)
        log(f"listening as @{self.username}")
        threading.Thread(target=self.set_menu, daemon=True).start()

    def stop(self):
        self._stop.set()
        self._kick.set()
        for t in self._threads:
            t.join(timeout=2)
        self._threads = []
        self._kick.clear()

    def _live(self, gen):
        return gen == self._gen and not self._stop.is_set()

    def _poll_loop(self, gen):
        back = 1
        while self._live(gen):
            try:
                if not self.poll(timeout=25, gen=gen) and not self.on:
                    self._stop.wait(1)
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

    def _plan_loop(self, gen):
        while self._live(gen):
            try:
                self.plan()
            except Exception as e:
                log("plan:", repr(e))
            self._stop.wait(0.5)

    def _send_loop(self, gen):
        while self._live(gen):
            try:
                if not self.flush():
                    self._kick.wait(1)
                    self._kick.clear()
            except Exception as e:
                log("send:", repr(e))
                self._stop.wait(2)

    # ------------------------------------------------------------ the work

    def poll(self, timeout=0, gen=None):
        """Fetch and handle whatever players sent since last time."""
        if not self.on:
            return 0
        off = self.wire.get("offset", 0)
        ups = self.call("getUpdates", {
            "offset": off, "timeout": timeout,
            "allowed_updates": ["message", "callback_query", "my_chat_member"]},
            timeout=timeout + 10)
        if gen is not None and gen != self._gen:
            return 0              # replaced while waiting; the new listener has these
        self._ok()
        for u in ups:
            if gen is None:
                self._handle(u)   # stepping through by hand (pump): in order, now
            else:
                self._hand_off(u)
        if ups:
            self.wire.put("offset", ups[-1]["update_id"] + 1)
        return len(ups)

    def _handle(self, u):
        try:
            self.convo.on_update(u)
        except Exception as e:
            log("update:", repr(e))

    @staticmethod
    def _chat_of(u):
        for k in ("message", "callback_query", "my_chat_member"):
            if k in u:
                body = u[k]
                return (body.get("from") or body.get("chat") or {}).get("id")
        return None

    def _hand_off(self, u):
        """Run this update beside everybody else's, but after anything still
        running for the same chat — a tap must not overtake the one before."""
        chat = self._chat_of(u)
        with self._lines_lock:
            line = self._lines.get(chat)
            if line is not None:
                line.append(u)
                return
            self._lines[chat] = deque([u])
        self._pool.submit(self._drain, chat)

    def _drain(self, chat):
        while True:
            with self._lines_lock:
                line = self._lines[chat]
                if not line:
                    del self._lines[chat]
                    return
                u = line.popleft()
            self._handle(u)

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
        items = [(n["key"], n["chat"], n["method"], n["params"], n["prio"], n["ttl"],
                  n["ref"]) for n in notices]
        items += [(f"{'del' if a['method'] == 'deleteMessage' else 'end'}:{a['row']['key']}",
                   a["row"]["chat"], a["method"], a["params"], 0, None, None)
                  for a in after]
        new = self.wire.enqueue_many(items) if items else 0
        for a in after:
            self.wire.close(a["row"]["id"])
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
                prio=CARD_PRIO, ttl=3600, ref={"card": h})
        return n

    def flush(self, limit=4):
        """Send what is due. Returns how many went, so the loop can idle.

        A few at a time, asked for again each round: anything queued while
        this round was sending — a table call after a result — goes ahead of
        the card edits and newsletters still waiting, instead of behind the
        whole batch they were fetched in."""
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
                sent += 1
            except TgError as e:
                if e.code == 429:
                    # usually one chat getting too much at once: hold that
                    # message, not the whole queue behind it
                    self.wire.later(row["id"], min(60, e.retry_after or 5))
                    continue
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
        while self.flush(limit=40):
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
            # the thread shows what was written, not how it was dressed up
            self.wire.note(chat_id, "out", text)
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
                th = threads[k] = {"chat_id": k, "name": name if k else "From the tables",
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
            "ms": self.latency_ms(),
            "followers": len(self.wire.chats(news_only=True)),
            "audiences": self.audiences(),
            "threads": sorted(threads.values(), key=lambda t: -t["last"])[:40],
            "unread": sum(t["unread"] for t in threads.values()),
        }
