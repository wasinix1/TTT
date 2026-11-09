"""A player acting for themselves: from Telegram, or from their own phone.

Open play on a night nobody is refereeing runs on three things the players
do on their own — come and go, report a score, and say when the other side
has not turned up. They are the same whichever screen they come from, so
they live here, keyed by the person, and both the bot (tt/bot.py) and the
phone page (/api/player in tt/server.py) only say who is asking.

Who is asking is established by the caller: Telegram signs its requests, a
phone holds a key the server gave it for a name (`key_for`). The phone key
is trust, not proof — anybody can pick any name, the way anybody can tell
the desk any name — and it is what lets a confirmation come from the other
side of the table rather than the same thumb.

Scores are claims (store.claims) until the other side agrees. With
`score_auto_min` set, a claim nobody has answered counts once that long has
passed, so a table never sits blocked on somebody without a phone.
"""

import hashlib
import hmac

from .models import decide_winner

# How long a match has to have been on the table before one side can say
# the other never came. Walking over from the bar takes a minute.
NO_SHOW_AFTER = 3 * 60

# The ops a phone may run, once its key says whose phone it is.
PHONE_OPS = ("score_claim", "score_answer", "score_withdraw", "no_show")


# ------------------------------------------------------------------ keys

def key_for(secret, person_id):
    """A phone's key for a person: their id and a MAC over it. Nothing is
    stored — the same person always gets the same key, it survives a
    restart, and it carries over to the next event like the person does."""
    mac = hmac.new(secret.encode(), b"player:" + person_id.encode(),
                   hashlib.sha256).hexdigest()[:20]
    return f"{person_id}.{mac}"


def person_from_key(secret, key):
    pid, _, _ = str(key or "").rpartition(".")
    if not pid or not hmac.compare_digest(key_for(secret, pid), str(key)):
        return None
    return pid


# ---------------------------------------------------------------- lookups

def player_ids(store, person_id):
    return {p.id for p in store.players.values()
            if person_id and p.person_id == person_id}


def entrants_of(store, person_id):
    pids = player_ids(store, person_id)
    return [e for e in sorted(store.entrants.values(), key=lambda e: e.id)
            if pids & set(e.player_ids)]


def live_match(store, person_id):
    """The match this person is on a table for, and which side they are."""
    pids = player_ids(store, person_id)
    for t in store.tables.values():
        m = store.matches.get(t.match_id) if t.match_id else None
        if m and m.status == "live":
            if pids & set(m.side_a):
                return m, "a"
            if pids & set(m.side_b):
                return m, "b"
    return None, None


def mine(games, side):
    """a/b games as the given side reads them: their points first."""
    return [list(g) if side == "a" else [g[1], g[0]] for g in games]


def side_entrants(store, m, side):
    """The entrants standing on one side of a match. A scramble match has
    no entrant per side, only the four it drew, so they are found by their
    players."""
    if not m.meta.get("queued"):
        e = m.entrant_a if side == "a" else m.entrant_b
        return [e] if e else []
    ps = set(m.side_a if side == "a" else m.side_b)
    return [eid for eid in m.meta["queued"]
            if eid in store.entrants and ps & set(store.entrants[eid].player_ids)]


def reachable(app, m, side):
    """Whether anybody on this side of the table can be asked on a phone:
    linked to Telegram, or seen on their phone page tonight."""
    s = app.store
    ps = set(m.side_a if side == "a" else m.side_b)
    people = {s.players[p].person_id for p in ps if p in s.players}
    ok = app.telegram.ok_chats() if app.telegram and app.telegram.on else set()
    for pid in people:
        who = s.people.get(pid)
        if who and ((who.tg_id and who.tg_id in ok) or app.phone_seen(pid)
                    or (app.push and app.push.has(pid))):
            return True
    return False


def rules_for(store, person_id):
    """What this person's cups let them do, for the phone's own words: one
    cup taking scores is enough to explain scores."""
    cups = {e.cup_id for e in entrants_of(store, person_id) if e.active}
    return {"scores": any(store.cup_rule(c, "player_scores") for c in cups),
            "auto_min": max([int(store.cup_rule(c, "score_auto_min") or 0) for c in cups] or [0]),
            "queue": any((store.formats.get(store.cups[c].format_id or "") or None) is not None
                         and store.formats[store.cups[c].format_id].uses_queue()
                         for c in cups if c in store.cups)}


def pending(app, person_id):
    """Reports about this person's current match: the ones they are asked
    to confirm, and their side's own still waiting for an answer. Each
    shown the way round they played it."""
    s = app.store
    m, side = live_match(s, person_id)
    if not m:
        return [], []
    auto = int(s.match_rule(m, "score_auto_min") or 0)
    ask, own = [], []
    for c in s.open_claims(m):
        view = mine(c["games"], side)
        won = sum(1 for x, y in view if x > y)
        item = {"id": c["id"], "by": app.side_name(m, c["side"]), "games": view,
                "sets": [won, len(view) - won],
                "counts_at": c["ts"] + auto * 60 if auto else None}
        (own if c["side"] == side else ask).append(item)
    return ask, own


# ---------------------------------------------------------------- the ops
# Each runs inside App.act: under the store lock, with the dispatcher
# ticking afterwards. `p` carries the person the caller vouched for.

def _close(app, c, state):
    app.store.append("claim_close", {"id": c["id"], "state": state})


def _write(app, m, games, how):
    app.op_report({"match_id": m.id, "games": games, "by": "players", "how": how})


def _disputed(app, m, says):
    """No referee to send them to: both are asked to enter it again, and
    the console shows the table until they agree. Telegram's chat with the
    organisers hears about it too, as it always did."""
    tg = app.telegram
    if tg and tg.on:
        t = app.store.tables.get(m.table)
        where = (t.name or f"Table {t.number}") if t else "A table"
        tg.wire.note(None, "sys", f"{where} needs a referee: " + ", ".join(
            f"{name} says {what}" for name, what in says) + ".")


def games_line(games):
    return " ".join(f"{a}:{b}" for a, b in games)


def claim(app, p):
    """A score from one side of a table, the reporter's points first.

      not_playing   they are on no table, so it was not a score
      off           their cup does not take scores from players
      invalid       it does not decide the match
      sent          waiting for the other side (or for time to run out)
      agreed        the other side had said the same; it is written
      disputed      the other side had said something else"""
    s = app.store
    m, side = live_match(s, p["person_id"])
    if not m:
        return {"status": "not_playing"}
    if not s.match_rule(m, "player_scores"):
        return {"status": "off"}
    games_mine = [[int(a), int(b)] for a, b in p["games"]]
    if not games_mine or any(not (0 <= x <= 99) for g in games_mine for x in g):
        return {"status": "invalid", "need": m.scoring.games_to_win(),
                "best_of": m.scoring.best_of}
    games = mine(games_mine, side)               # back to a/b
    if not decide_winner(games, m.scoring):
        return {"status": "invalid", "need": m.scoring.games_to_win(),
                "best_of": m.scoring.best_of}
    other = "b" if side == "a" else "a"
    opp, me_name = app.side_name(m, other), app.side_name(m, side)
    for c in s.open_claims(m):
        if c["side"] != side:
            if c["games"] == games:
                _close(app, c, "agreed")
                _write(app, m, games, "agreed")
                return {"status": "agreed", "opponent": opp}
            _close(app, c, "disputed")
            _disputed(app, m, [(opp, games_line(mine(c["games"], c["side"]))),
                               (me_name, games_line(games_mine))])
            return {"status": "disputed", "opponent": opp}
        _close(app, c, "replaced")             # their own side, said again
    cid = s.append("claim_open", {"match_id": m.id, "qseq": m.queued_seq,
                                  "side": side, "person_id": p["person_id"],
                                  "via": p.get("via", ""), "games": games})
    return {"status": "sent", "id": cid, "opponent": opp,
            "reachable": reachable(app, m, other),
            "auto_min": int(s.match_rule(m, "score_auto_min") or 0)}


def answer(app, p):
    """The other side's answer to a score: gone, stale, agreed, disputed."""
    s = app.store
    c = s.claims.get(int(p.get("claim_id") or 0))
    if not c or c["state"] != "open":
        return {"status": "gone"}
    m, side = live_match(s, p["person_id"])
    if not m or m.id != c["match_id"] or m.queued_seq != c["qseq"] or side == c["side"]:
        if not s.open_claims(s.matches.get(c["match_id"])):
            _close(app, c, "stale")
        return {"status": "stale"}
    if p.get("yes"):
        _close(app, c, "agreed")
        _write(app, m, c["games"], "agreed")
        return {"status": "agreed"}
    _close(app, c, "disputed")
    _disputed(app, m, [(app.side_name(m, c["side"]), games_line(mine(c["games"], c["side"]))),
                       (app.side_name(m, side), "that is wrong")])
    return {"status": "disputed", "by": app.side_name(m, c["side"])}


def withdraw(app, p):
    """Take back a score your side sent, before the other side answered —
    a typo should not need anybody."""
    s = app.store
    c = s.claims.get(int(p.get("claim_id") or 0))
    if not c:
        raise ValueError("that report is gone")
    m, side = live_match(s, p["person_id"])
    if c["person_id"] != p["person_id"] and not (m and m.id == c["match_id"]
                                                 and side == c["side"]):
        raise ValueError("that is not your report")
    if c["state"] != "open":
        return {"withdrawn": False}
    _close(app, c, "withdrawn")
    return {"withdrawn": True}


def no_show(app, p):
    """The other side never came to the table. Their match is put back —
    which in open play means it is scrapped and the table goes to whoever
    is next, this player included — and whoever did not come is sat out,
    so they are not called again until they say they are back."""
    s = app.store
    m, side = live_match(s, p["person_id"])
    if not m:
        raise ValueError("you are not on a table")
    if m.started_ts and s.clock() - m.started_ts < NO_SHOW_AFTER:
        raise ValueError("give them a couple of minutes to get to the table")
    other = "b" if side == "a" else "a"
    gone = side_entrants(s, m, other)
    app.op_put_back({"match_id": m.id})
    for eid in gone:
        if eid in s.entrants:
            s.append("rest_set", {"entrant_id": eid, "resting": True})
    return {"rested": [s.entrant_name(e) for e in gone]}


def sweep(app, now):
    """Settle what time has settled: a report nobody answered counts once
    `score_auto_min` has passed; a report on a match that is no longer on
    its table is closed. Run by App.sweep, every few seconds."""
    s = app.store
    wrote = False
    for c in list(s.claims.values()):
        if c["state"] != "open":
            continue
        m = s.matches.get(c["match_id"])
        if not m or m.status != "live" or m.queued_seq != c["qseq"]:
            _close(app, c, "stale")
            continue
        auto = int(s.match_rule(m, "score_auto_min") or 0)
        if auto and now - c["ts"] >= auto * 60:
            _close(app, c, "timed")
            _write(app, m, c["games"], "timed")
            wrote = True
    return wrote
