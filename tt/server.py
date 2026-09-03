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
from . import dispatch

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

    def role_for(self, token):
        if token and secrets.compare_digest(token, self.keys["admin"]):
            return "admin"
        if token and secrets.compare_digest(token, self.keys["referee"]):
            return "referee"
        return "public"

    # ------------------------------------------------------------ read side

    def match_dto(self, m):
        s = self.store
        names = lambda ids: " / ".join(
            s.players[p].name for p in ids if p in s.players) or "—"
        return {
            "id": m.id, "format_id": m.format_id, "label": m.label,
            "a": m.meta.get("name_a") or (s.entrant_name(m.entrant_a)
                                          if m.entrant_a else names(m.side_a)),
            "b": m.meta.get("name_b") or (s.entrant_name(m.entrant_b)
                                          if m.entrant_b else names(m.side_b)),
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

            queues = []
            for fid in s.format_order:
                f = s.formats.get(fid)
                if not f or not f.uses_queue():
                    continue
                qs = [q for q in s.queue if q.format_id == fid]
                qs.sort(key=lambda q: (-q.passes, q.joined_seq))
                busy = s.busy_players()
                queues.append({
                    "format_id": fid, "format_name": f.name,
                    "cup_id": s.cup_of_format(f),
                    "mode": f.config.get("mode", "pairs"),
                    "entries": [{
                        "entrant_id": q.entrant_id,
                        "name": s.entrant_name(q.entrant_id),
                        "strength": round(s.entrant_strength(q.entrant_id), 1),
                        "passes": q.passes,
                        "waiting_long": q.passes >= 2 * max(1, len(s.tables)),
                        "blocked": not s.entrant_available(q.entrant_id, busy),
                    } for q in qs],
                })

            # "Still to play" in real dispatch order: available-now matches
            # first (a match whose players are mid-game elsewhere can't
            # actually be next no matter where it sorts), then by the
            # format's own table priority, then round/seq. Each one also
            # gets the table numbers it could actually land on, which is the
            # honest version of "which table" — the exact table is only
            # decided the instant one frees up, so we show the set it's
            # eligible for rather than guessing a single number.
            busy_now = s.busy_players()
            ranked = []
            for m in s.matches.values():
                if m.status != "pending" or not m.is_filled():
                    continue
                f = s.formats.get(m.format_id)
                avail = (s.entrant_available(m.entrant_a, busy_now)
                        and s.entrant_available(m.entrant_b, busy_now))
                cup = s.cup_of_format(f)
                dto = self.match_dto(m)
                dto["blocked"] = not avail
                dto["cup_id"] = cup
                dto["eligible_tables"] = s.tables_for_cup(cup)
                ranked.append((0 if avail else 1, f.priority() if f else 0,
                              m.meta.get("round", 0), m.seq, dto))
            ranked.sort(key=lambda x: x[:4])
            upcoming = [r[4] for r in ranked]
            flagged_cups = set()
            for dto in upcoming:
                if not dto["blocked"] and dto["cup_id"] not in flagged_cups:
                    dto["next"] = True
                    flagged_cups.add(dto["cup_id"])

            recent = sorted([m for m in s.matches.values() if m.status == "done"],
                            key=lambda m: -m.seq)[:15]

            return {
                "version": s.version, "seq": s.seq, "role": role,
                "event": s.event,
                "tables": tables,
                "cups": [s.cups[c].to_dict() for c in s.cup_order if c in s.cups],
                "queues": queues,
                "upcoming": [u for u in upcoming[:24]],
                "recent": [self.match_dto(m) for m in recent],
                "formats": [s.formats[f].to_dict(s) for f in s.format_order
                            if f in s.formats],
                "players": [p.to_dict() for p in sorted(
                    s.players.values(), key=lambda p: p.name.lower())],
                "entrants": [{**e.to_dict(),
                              "strength": round(s.entrant_strength(e.id), 1),
                              "queued": any(q.entrant_id == e.id for q in s.queue),
                              "playing": any(t.match_id and
                                             e.id in (s.matches[t.match_id].entrant_a,
                                                      s.matches[t.match_id].entrant_b)
                                             for t in s.tables.values() if t.match_id)}
                             for e in sorted(s.entrants.values(),
                                             key=lambda e: e.name.lower())],
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
    def op_add_player(self, p):
        s = self.store
        pid = s.new_id("P", s.players)
        s.append("player_add", {"id": pid, "name": p["name"].strip(),
                                "strength": float(p.get("strength", 5))})
        if p.get("solo", True):
            eid = s.new_id("E", s.entrants)
            s.append("entrant_add", {"id": eid, "name": p["name"].strip(),
                                     "player_ids": [pid]})
        return {"player_id": pid}

    def op_update_player(self, p):
        self.store.append("player_update", p)

    def op_add_team(self, p):
        s = self.store
        pids = []
        for name, strength in p["members"]:
            pid = s.new_id("P", s.players)
            s.append("player_add", {"id": pid, "name": name.strip(),
                                    "strength": float(strength)})
            pids.append(pid)
        eid = s.new_id("E", s.entrants)
        label = p.get("name") or " / ".join(n for n, _ in p["members"])
        s.append("entrant_add", {"id": eid, "name": label, "player_ids": pids})
        return {"entrant_id": eid}

    def op_update_entrant(self, p):
        self.store.append("entrant_update", p)

    def op_add_entrant(self, p):
        """Add a team to a Swiss already in progress. Only makes sense before
        standings have pulled far apart: the newcomer starts at 0 wins and
        joins the next round's pairing pool exactly like anyone else who is
        still on 0, so this is meant for early on (round 1 still live), not
        for dropping someone into round 6 of 8."""
        s = self.store
        f = s.formats[p["id"]]
        if f.kind != "swiss":
            raise ValueError("adding entrants mid-tournament only works for Swiss")
        eid = p["entrant_id"]
        if eid not in f.entrant_ids:
            f.entrant_ids = f.entrant_ids + [eid]
            s.append("format_update", {"id": f.id, "entrant_ids": f.entrant_ids})
        if f.uses_queue() and f.status == "running":
            s.append("queue_join", {"entrant_id": eid, "format_id": f.id})

    def op_reset_players(self, p):
        """Danger zone: wipe players/entrants and void whatever matches or
        queue entries depended on them. Tables, cups and format settings
        are kept, so the event doesn't need rebuilding for a fresh roster."""
        self.store.append("players_reset", {})

    # tables
    def op_set_table(self, p):
        self.store.append("table_set", p)

    def op_remove_table(self, p):
        self.store.append("table_remove", p)

    # formats
    def op_add_format(self, p):
        s = self.store
        fid = s.new_id("F", s.formats)
        cfg = dict(p.get("config", {}))
        cfg["entrant_ids"] = list(p.get("entrant_ids", []))
        s.append("format_add", {"id": fid, "kind": p["kind"],
                                "name": p.get("name") or "", "config": cfg})
        return {"format_id": fid}

    def op_update_format(self, p):
        self.store.append("format_update", p)

    def op_start_format(self, p):
        s = self.store
        f = s.formats[p["id"]]
        if f.status == "running":
            return
        if "entrant_ids" in p:
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

    # queue
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
        if not p.get("requeue", True):
            return
        # Hand players back to whichever queue they came out of. That covers
        # both open play itself and someone who was pulled out of the queue
        # into a scheduled draw match: when the draw is done with them for
        # now, they rejoin the queue rather than standing around.
        for eid in involved:
            if eid in s.opted_out:
                continue
            qf = s.came_from.get(eid, m.format_id)
            f = s.formats.get(qf)
            if f and f.uses_queue() and f.status == "running":
                s.append("queue_join", {"entrant_id": eid, "format_id": qf})

    def op_void_match(self, p):
        self.store.append("match_void", {"match_id": p["match_id"]})

    def op_unassign(self, p):
        self.store.append("match_unassign", {"match_id": p["match_id"]})

    def op_assign(self, p):
        self.store.append("match_assign", {"match_id": p["match_id"],
                                           "table": int(p["table"])})

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

    # admin
    def op_event_meta(self, p):
        self.store.append("event_meta", p)

    def op_rewind(self, p):
        self.store.rewind(int(p["seq"]))

    def op_reset_event(self, p):
        """Danger zone: wipe the whole evening (players, teams, matches,
        formats, cups) and start clean. Access keys live in a separate file
        and are never touched by this."""
        s = self.store
        s.rewind(0)
        for n in (1, 2, 3):
            s.append("table_set", {"number": n, "name": f"Table {n}"})


OP_LEVEL = {
    "add_player": 2, "update_player": 2, "add_team": 2, "update_entrant": 2,
    "reset_players": 2,
    "set_table": 2, "remove_table": 2,
    "add_format": 2, "update_format": 2, "start_format": 2, "remove_format": 2,
    "reset_format": 2, "swiss_cut_ko": 2, "add_entrant": 2,
    "add_cup": 2, "update_cup": 2, "remove_cup": 2,
    "join_queue": 1, "leave_queue": 1,
    "report": 1, "void_match": 1, "unassign": 2, "assign": 2,
    "manual_match": 2, "manual_result": 1, "event_meta": 2, "rewind": 2, "reset_event": 2,
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

        if path == "/api/stream":
            return self._stream()

        if path == "/print":
            return self._print_page(q)

        if path == "/api/qr.svg":
            return self._qr(q.get("u", [""])[0])

        if path.startswith("/static/"):
            return self._static(path[len("/static/"):])

        # role-scoped entry points; all serve the same page
        return self._static("index.html")

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

    def _print_page(self, q):
        """A sheet to print and tape to the wall."""
        base = q.get("base", [""])[0] or ""
        name = self.app.store.event.get("name") or "Table tennis"
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
<style>
 body{{font-family:ui-sans-serif,system-ui,sans-serif;color:#10211f;background:#fff;
      margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}}
 .sheet{{text-align:center;padding:40px}}
 h1{{font-size:34px;margin:0 0 6px;letter-spacing:-.02em}}
 p{{color:#5d7972;margin:0 0 28px;font-size:17px}}
 .url{{font-size:23px;margin-top:22px;font-weight:600;word-break:break-all}}
 @media print{{.sheet{{padding:0}}}}
</style>
<div class="sheet"><h1>{name}</h1>
<p>Scan for live tables, the queue and results</p>
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
