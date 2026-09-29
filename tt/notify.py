"""Who to tell what, worked out from the state.

Notifications are derived the way the board is: from what is true now, not
from the events that made it true. That is what makes them safe across a
restart, a replay or a rewind — each notice has a key, the outbox remembers
every key it was ever given, and recomputing the plan simply finds nothing
new to say.

Two messages per match, no more:

  next   the board's *get ready* — your match is in the next wave
  go     your match is on a table

Everything after that edits them in place (a result, a match put back) or
deletes them (a next-wave notice once the table call has replaced it). The
copy lives in bot.py; this module only decides.
"""

from . import board
from . import bot as copy

STALE = 15 * 60          # a table call older than this is not worth sending
REMIND_BEFORE = 26 * 3600
REMIND_NOT_WITHIN = 6 * 3600     # somebody who entered this afternoon needs no reminder


def reach_map(store, ok_chats):
    """player id -> the chat that is that player, for everyone reachable."""
    by_person = {p.id: p.tg_id for p in store.people.values()
                 if p.tg_id and p.tg_id in ok_chats}
    return {pl.id: by_person[pl.person_id] for pl in store.players.values()
            if pl.person_id in by_person}


def _notice(key, chat, text, keyboard=None, prio=0, ttl=None, ref=None):
    params = {"chat_id": chat, "text": text, "parse_mode": "HTML",
              "link_preview_options": {"is_disabled": True}}
    if keyboard:
        params["reply_markup"] = {"inline_keyboard": keyboard}
    return {"key": key, "chat": chat, "method": "sendMessage", "params": params,
            "prio": prio, "ttl": ttl, "ref": ref or {}}


def _cup_boards(store, app):
    keys = []
    for fid in store.format_order:
        f = store.formats.get(fid)
        if f and f.status == "running":
            k = store.cup_key(f)
            if k not in keys:
                keys.append(k)
    return [board.cup_board(store, k, app) for k in keys]


def _stint(store, eid):
    """Which turn in the queue this is: a new one after every match, so the
    next-wave message for the next game is a new message."""
    return next((q.joined_seq for q in store.queue if q.entrant_id == eid), None)


def plan(app, ok_chats, now):
    """Every message that should exist right now. The outbox drops the
    ones it has already been given."""
    s = app.store
    reach = reach_map(s, ok_chats)
    out = []
    multi = len(s.cups) > 1
    scores = bool(s.event.get("player_scores"))

    # -- your turn: a match on a table
    for n, t in sorted(s.tables.items()):
        m = s.matches.get(t.match_id) if t.match_id else None
        if not m or m.status != "live":
            continue
        if m.started_ts and now - m.started_ts > STALE:
            continue
        for pid in m.players():
            chat = reach.get(pid)
            if not chat:
                continue
            out.append(_notice(
                f"go:{m.id}:{m.queued_seq}:{chat}", chat,
                copy.text_go(app, m, pid, t, multi, scores),
                prio=0, ttl=STALE,
                ref={"kind": "go", "m": m.id, "q": m.queued_seq, "p": pid}))

    # -- up next: the board's own "get ready", so it is never a second guess
    for b in _cup_boards(s, app):
        cup = s.cups.get(b["cup_id"]) if b["cup_id"] else None
        for r in b["up"]:
            if not r.get("on_deck"):
                continue
            ents = [e for e in r.get("entrants") or [] if e]
            for eid in ents:
                e = s.entrants.get(eid)
                if not e:
                    continue
                if r["kind"] == "fixture":
                    tag = f"m:{r['id']}"
                else:
                    stint = _stint(s, eid)
                    if stint is None:
                        continue
                    tag = f"q:{eid}:{stint}"
                opp = [s.entrant_name(x) for x in ents if x != eid]
                for pid in e.player_ids:
                    chat = reach.get(pid)
                    if not chat:
                        continue
                    out.append(_notice(
                        f"next:{tag}:{chat}", chat,
                        copy.text_next(opp[0] if opp else "", r.get("eta_min"),
                                       b.get("tables_label", ""),
                                       copy.label_de(r.get("label", "")),
                                       cup.name if (cup and multi) else ""),
                        keyboard=[[copy.button("⏸ Kann gerade nicht", f"p:{eid}:1")]],
                        prio=0, ttl=STALE,
                        ref={"kind": "next", "e": eid}))

    out += _reminders(app, ok_chats, now)
    out += _thanks(app, reach)
    return out


def _reg_chat(store, r, ok_chats):
    if r.tg_id and r.tg_id in ok_chats:
        return r.tg_id
    who = store.people.get(r.person_id) if r.person_id else None
    if who and who.tg_id in ok_chats:
        return who.tg_id
    return None


def _reminders(app, ok_chats, now):
    """The day before: everyone who entered through Telegram is asked if
    they are coming. Yes shows at the door; no drops the entry in one tap."""
    s = app.store
    start = s.starts_at_ts()
    if not start or s.phase() not in ("announced", "registration"):
        return []
    if not 0 < start - now <= REMIND_BEFORE:
        return []
    out = []
    ev = s.event.get("id") or "EV0"
    for r in s.pending_regs():
        chat = _reg_chat(s, r, ok_chats)
        if not chat or now - (r.created_ts or 0) < REMIND_NOT_WITHIN:
            continue
        cup = s.cups.get(r.cup_id)
        text, kb = copy.reminder(app, r, cup, start, now)
        out.append(_notice(f"rem:{ev}:{r.id}", chat, text, kb, prio=1,
                           ttl=max(60, start - now)))
    return out


def _thanks(app, reach):
    """When the event is over: each player's evening, once."""
    s = app.store
    if s.phase() != "done":
        return []
    ev = s.event.get("id") or "EV0"
    per_chat = {}
    for e in s.entrants.values():
        played = [m for m in s.matches.values()
                  if m.status == "done" and e.id in (m.entrant_a, m.entrant_b)]
        if not played:
            continue
        for pid in e.player_ids:
            chat = reach.get(pid)
            if chat:
                per_chat.setdefault(chat, []).append(e)
    return [_notice(f"bye:{ev}:{chat}", chat, copy.thanks(app, ents), prio=2)
            for chat, ents in per_chat.items()]


# ---------------------------------------------------------------- afterwards

def _chats_now(app, ok_chats):
    """Who is on a table, and who is anywhere in a running order."""
    s = app.store
    reach = reach_map(s, ok_chats)
    playing, waiting = set(), set()
    for t in s.tables.values():
        m = s.matches.get(t.match_id) if t.match_id else None
        if m and m.status == "live":
            playing.update(reach[p] for p in m.players() if p in reach)
    for b in _cup_boards(s, app):
        for r in b["up"]:
            for eid in r.get("entrants") or []:
                e = s.entrants.get(eid)
                if e:
                    waiting.update(reach[p] for p in e.player_ids if p in reach)
    return playing, waiting


def settle(app, open_rows, ok_chats):
    """What to do about messages already out: a table call becomes its
    result, or says it was put back; a next-wave notice goes once the table
    call has replaced it, or once they are no longer waiting at all."""
    s = app.store
    out = []
    playing = waiting = None
    for row in open_rows:
        ref = row["ref"]
        kind = ref.get("kind")
        if kind == "go":
            m = s.matches.get(ref.get("m"))
            if m and m.status == "live" and m.queued_seq == ref.get("q"):
                continue
            text = copy.text_after(app, m, ref.get("p"))
            out.append({"row": row, "method": "editMessageText", "params": {
                "chat_id": row["chat"], "message_id": row["message_id"],
                "text": text, "parse_mode": "HTML",
                "link_preview_options": {"is_disabled": True}}})
        elif kind == "next":
            if playing is None:
                playing, waiting = _chats_now(app, ok_chats)
            if row["chat"] in playing or row["chat"] not in waiting:
                out.append({"row": row, "method": "deleteMessage", "params": {
                    "chat_id": row["chat"], "message_id": row["message_id"]}})
    return out


def still_true(app, ref):
    """Checked just before a queued notice goes out, so one that was planned
    a moment before its match was put back is never sent."""
    s = app.store
    kind = ref.get("kind")
    if kind == "go":
        m = s.matches.get(ref.get("m"))
        return bool(m and m.status == "live" and m.queued_seq == ref.get("q"))
    if kind == "next":
        e = s.entrants.get(ref.get("e"))
        return bool(e) and app.entrant_status(e) in ("waiting", "drawn")
    return True
