"""The Mini App: one player's evening, on their phone, inside Telegram.

The same person the bot knows, seen as a page instead of a chat: what is on,
their entries, where they are tonight, their matches, their table, the
tables, and a line to the organisers. It is a view of the bot, not a second
console — every action goes through the Conversation's own checks and the
same ops, so the chat card and this page cannot disagree about anything.

Who is asking comes from Telegram itself. A Mini App is handed `initData`,
signed with the bot's token; the server checks that signature (HMAC-SHA256,
keyed with HMAC("WebAppData", token)) on every request, so a page opened
anywhere but in Telegram, or with somebody else's data, sees nothing. No
cookie, no session, nothing to log in to.
"""

import hashlib
import hmac
import html
import json
import time
from urllib.parse import parse_qsl

from .bot import KIND_DE, _mine, _record, _place, label_de, table_de, when_line

MAX_AGE = 24 * 3600      # a Mini App left open over an evening keeps working


def verify(init_data, token, now=None, max_age=MAX_AGE):
    """The Telegram user this initData was signed for, or None."""
    if not init_data or not token:
        return None
    try:
        data = dict(parse_qsl(init_data, strict_parsing=True, keep_blank_values=True))
    except ValueError:
        return None
    got = data.pop("hash", "")
    if not got:
        return None
    check = "\n".join(f"{k}={v}" for k, v in sorted(data.items()))
    secret = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
    want = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(want, got):
        return None
    try:
        age = (now or time.time()) - int(data.get("auth_date", "0"))
        user = json.loads(data.get("user") or "{}")
    except ValueError:
        return None
    if age > max_age or not isinstance(user, dict) or not user.get("id"):
        return None
    return user


def sign(user, token, auth_date=None):
    """initData for a user, signed the way Telegram signs it. For tests and
    for trying the page locally — the server never needs to make one."""
    from urllib.parse import urlencode
    data = {"auth_date": str(int(auth_date or time.time())),
            "query_id": "local", "user": json.dumps(user, separators=(",", ":"))}
    check = "\n".join(f"{k}={v}" for k, v in sorted(data.items()))
    secret = hmac.new(b"WebAppData", token.encode(), hashlib.sha256).digest()
    data["hash"] = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    return urlencode(data)


# --------------------------------------------------------------------- view

URGENT = {"playing": 0, "waiting": 1, "drawn": 1, "entered": 2, "resting": 3,
          "outside": 4, "withdrawn": 5}


def _rank(x):
    base = URGENT.get(x["state"], 9)
    if x["state"] in ("waiting", "drawn"):
        return (base, 0 if x["on_deck"] else 1, x["eta_min"] if x["eta_min"] is not None else 999)
    return (base, 0, 0)


def view(bot, uid):
    c, app = bot.convo, bot.app
    s = app.store
    chat = bot.wire.chat(uid) or {}
    ask, mine = c.pending_claims(uid)
    with s.lock:
        me = c.who(uid)
        phase = s.phase()
        ev = s.event
        full = " ".join(x for x in (chat.get("first_name"), chat.get("last_name")) if x)
        out = {
            "phase": phase,
            "now": time.time(),
            "event": {"name": ev.get("name") or "Tischtennis",
                      "when": html.unescape(when_line(s)),
                      "blurb": ev.get("blurb") or "",
                      "starts_ts": s.starts_at_ts()},
            "me": {"first": chat.get("first_name") or "",
                   "name": me.person.name if me.person else (chat.get("name") or full),
                   "known": bool(me.person),
                   "news": bool(chat.get("news", 1)),
                   "linked": bool(me.person) or any(r.tg_id == uid for r in me.regs)},
            "scores": bool(ev.get("player_scores")),
            "entries": [],
            "open": [],
            "tonight": [],
            "matches": [],
            "upcoming": [],
            "standings": [],
            "tables": [],
            "confirm": ask,
            "reported": mine,
            "bot": bot.username,
        }

        # before the night: what they are in, and what they could be in
        for r in me.regs:
            cup = s.cups.get(r.cup_id)
            mate = s.registrations.get(r.matched_with or "")
            out["entries"].append({
                "id": r.id, "cup_id": r.cup_id, "cup": cup.name if cup else "",
                "kind": r.kind, "status": r.status, "rsvp": r.rsvp,
                "partner": r.partner_name or (mate.name if mate else ""),
                "drawn": bool(mate)})
        if phase in ("announced", "registration"):
            taken = {r.cup_id for r in me.regs}
            for cid in s.cup_order:
                cup = s.cups.get(cid)
                if not cup or cid in taken or cup.registration != "open":
                    continue
                f = s.formats.get(cup.format_id or "")
                out["open"].append({"id": cid, "name": cup.name, "entry": cup.entry,
                                    "about": KIND_DE.get(f.kind, "") if f else "",
                                    "blurb": cup.blurb})

        # tonight: where each of their entrants is, most urgent first
        multi = len(s.cups) > 1 or len(me.ents) > 1
        for e in me.ents:
            cup = s.cups.get(e.cup_id)
            x = c.state_of(e)
            x.update(eid=e.id, cup=cup.name if cup and multi else "")
            out["tonight"].append(x)
        out["tonight"].sort(key=_rank)

        for e in me.ents:
            out["matches"] += _matches(app, e, multi)
            out["upcoming"] += _upcoming(app, e)
            table = _standing(app, e, multi)
            if table:
                out["standings"].append(table)
        out["matches"].sort(key=lambda m: -m["seq"])
        if phase == "done":
            out["places"] = [p for p in (_place(app, e) for e in me.ents) if p]

        mine_ids = {p.id for p in s.players.values()
                    if me.person and p.person_id == me.person.id}
        for n, t in sorted(s.tables.items()):
            m = s.matches.get(t.match_id) if t.match_id else None
            out["tables"].append({
                "name": table_de(t), "number": n, "paused": t.paused,
                "a": app.side_name(m, "a") if m else "",
                "b": app.side_name(m, "b") if m else "",
                "mine": bool(m and mine_ids & set(m.players()))})
    return out


def _matches(app, e, multi):
    s = app.store
    cup = s.cups.get(e.cup_id)
    out = []
    for m in s.matches.values():
        if m.status != "done" or e.id not in (m.entrant_a, m.entrant_b):
            continue
        side = "a" if m.entrant_a == e.id else "b"
        out.append({
            "seq": m.seq, "cup": cup.name if cup and multi else "",
            "label": label_de(m.label),
            "opponent": app.side_name(m, "b" if side == "a" else "a"),
            "games": _mine(m.games, side), "won": m.winner == side,
            "walkover": bool(m.meta.get("walkover"))})
    return out


def _upcoming(app, e):
    """Fixtures still to play — a group stage says who is left."""
    s = app.store
    out = []
    for f in s.formats.values():
        if f.status != "running" or f.uses_queue() or e.id not in f.entrant_ids:
            continue
        for m in f.pending_fixtures(s):
            if e.id in (m.entrant_a, m.entrant_b) and m.status == "pending":
                side = "a" if m.entrant_a == e.id else "b"
                out.append({"opponent": app.side_name(m, "b" if side == "a" else "a"),
                            "label": label_de(m.label)})
    return out[:6]


def _standing(app, e, multi):
    """The table they are in: their group, or the whole field. Long ones
    are cut to the top and the rows around them."""
    s = app.store
    cup = s.cups.get(e.cup_id)
    f = s.formats.get(cup.format_id) if cup and cup.format_id else None
    if not f or f.status == "setup":
        return None
    try:
        sections = f.standings(s)
    except Exception:
        return None
    sec = next((x for x in sections if any(r.get("entrant_id") == e.id for r in x["rows"])),
               None)
    if not sec or not any(r["played"] for r in sec["rows"]):
        return None
    rows = [{"rank": r.get("rank") or i, "name": r["name"], "won": r["won"],
             "lost": r["lost"], "me": r.get("entrant_id") == e.id}
            for i, r in enumerate(sec["rows"], 1)]
    if len(rows) > 12:
        at = next(i for i, r in enumerate(rows) if r["me"])
        keep = set(range(8)) | set(range(max(0, at - 1), at + 2))
        rows = [dict(r, gap=(i - 1 not in keep and i > 0)) for i, r in enumerate(rows)
                if i in keep]
    group = sec.get("group")
    title = " · ".join(x for x in ((cup.name if multi else ""),
                                   (f"Gruppe {group}" if group and len(sections) > 1 else ""))
                       if x)
    return {"title": title or "Tabelle", "rows": rows}


# ------------------------------------------------------------------ actions

def act(bot, user, op, d):
    """One thing the player did on the page. Every check that matters is
    the Conversation's — this only translates."""
    c = bot.convo
    uid = user["id"]
    d = d or {}
    toast = ""
    if op == "enter":
        name = " ".join(str(d.get("name") or "").split())[:60]
        if name:
            bot.wire.set_chat(uid, name=name)
        out = c.register(uid, d.get("cup_id") or "", d.get("kind") or "s", name,
                         " ".join(str(d.get("partner") or "").split())[:60])
        toast = ("Du bist schon dabei" if out.get("already")
                 else f"Mit {out['matched_with']} zugelost ✓" if out.get("matched_with")
                 else "Angemeldet ✓")
    elif op == "drop":
        reg = c._my_reg(uid, d.get("id") or "")
        bot.system("update_registration", {"id": reg.id, "status": "cancelled"})
        toast = "Abgemeldet"
    elif op == "rsvp":
        reg = c._my_reg(uid, d.get("id") or "", any_status=True)
        if d.get("yes"):
            bot.system("tg_rsvp", {"id": reg.id, "rsvp": "yes"})
            toast = "Super, bis dann!"
        else:
            bot.system("update_registration", {"id": reg.id, "status": "cancelled"})
            toast = "Schade — abgemeldet"
    elif op in ("rest", "leave"):
        e, _ = c._mine(uid, d.get("eid") or "")
        if not e:
            raise ValueError("Das kannst nur du selbst ändern.")
        if op == "rest":
            bot.system("set_resting", {"entrant_id": e.id, "resting": bool(d.get("on"))})
            toast = "Pause — wir rufen dich nicht auf" if d.get("on") else "Willkommen zurück"
        else:
            bot.system("withdraw", {"entrant_id": e.id, "withdrawn": bool(d.get("on"))})
            toast = "Gute Heimfahrt!" if d.get("on") else "Schön, dass du noch da bist"
    elif op == "score":
        try:
            games = [[int(a), int(b)] for a, b in d.get("games") or []]
        except (TypeError, ValueError):
            raise ValueError("Das sind keine Punkte.")
        if not games or any(not (0 <= x <= 99) for g in games for x in g):
            raise ValueError("Das sind keine Punkte.")
        r = c.claim(uid, games)
        st = r["status"]
        if st == "not_playing":
            raise ValueError("Gerade läuft kein Spiel von dir.")
        if st == "invalid":
            raise ValueError(f"Das ergibt noch keinen Sieg — {r['need']} Gewinnsätze braucht es.")
        if st == "no_opponent":
            raise ValueError(f"{r['opponent']} ist nicht über Telegram verbunden — "
                             "bitte beim Schiri eintragen.")
        toast = {"sent": f"Gesendet — {r.get('opponent', '')} bestätigt",
                 "agreed": "Eingetragen ✓",
                 "disputed": "Passt nicht zusammen — ab zum Schiri"}[st]
    elif op == "withdraw":
        toast = ("Zurückgezogen" if c.withdraw(uid, int(d.get("id") or 0))
                 else "Schon erledigt")
    elif op == "confirm":
        r = c.answer(uid, int(d.get("id") or 0), bool(d.get("yes")))
        toast = {"agreed": "Eingetragen ✓", "disputed": "Okay — ab zum Schiri",
                 "stale": "Schon eingetragen", "gone": "Schon erledigt"}[r["status"]]
    elif op == "message":
        text = str(d.get("text") or "").strip()[:2000]
        if not text:
            raise ValueError("Schreib erst etwas.")
        bot.wire.note(uid, "in", text)
        bot.changed()
        toast = "Ist bei der Orga angekommen ✓"
    elif op == "news":
        bot.wire.set_chat(uid, news=int(bool(d.get("on"))))
        bot.changed()
        toast = "Neuigkeiten an" if d.get("on") else "Keine Neuigkeiten mehr"
    elif op == "unlink":
        s = bot.app.store
        with s.lock:
            me = c.who(uid)
        if me.person:
            bot.system("tg_link", {"person_id": me.person.id, "tg_id": None})
        for r in me.regs:
            if r.tg_id == uid and r.status == "pending":
                bot.system("tg_detach", {"id": r.id})
        toast = "Verknüpfung gelöst"
    else:
        raise ValueError("Das gibt es nicht.")
    return {"toast": toast, "view": view(bot, uid)}
