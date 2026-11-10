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

# How long after a result it can still be corrected from a phone: long
# enough to notice on the walk back from the table, short enough that last
# hour's match is not reopened because somebody had second thoughts.
FIX_WINDOW = 30 * 60

# How long a match has to have been on the table before one side can say
# the other never came. Walking over from the bar takes a minute.
NO_SHOW_AFTER = 3 * 60

# The ops a phone may run, once its key says whose phone it is.
PHONE_OPS = ("score_claim", "score_answer", "score_withdraw", "no_show", "score_fix")


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
    cup taking scores is enough to explain scores. `breaks` lists the
    entries they may take a break from or go home from themselves — only
    in cups where they check themselves in."""
    ents = [e for e in entrants_of(store, person_id) if e.active]
    cups = {e.cup_id for e in ents}
    fmts = [store.formats.get(store.cups[c].format_id or "") for c in cups if c in store.cups]
    return {"balanced": any(f is not None and f.kind == "open_play" and f.by_results()
                            for f in fmts),
            "scores": any(store.cup_rule(c, "player_scores") for c in cups),
            "breaks": [e.id for e in ents if store.cup_rule(e.cup_id, "self_checkin")],
            "auto_min": max([int(store.cup_rule(c, "score_auto_min") or 0) for c in cups] or [0]),
            "queue": any(f is not None and f.uses_queue() for f in fmts)}


def side_in(store, m, person_id):
    """Which side of this match a person played on, or None."""
    pids = player_ids(store, person_id)
    return "a" if pids & set(m.side_a) else "b" if pids & set(m.side_b) else None


def fixable(store, person_id, now=None):
    """The one result this person may still correct from their phone: their
    latest, finished inside FIX_WINDOW, in a cup where players enter their
    own scores, and an actual game (not a walkover or a bye)."""
    now = now or store.clock()
    best = None
    pids = player_ids(store, person_id)
    for m in store.matches.values():
        if m.status != "done" or not (pids & set(m.players())) or not m.done_ts:
            continue
        if not best or m.done_ts > best.done_ts:
            best = m
    if not best or now - best.done_ts > FIX_WINDOW:
        return None, None
    if best.meta.get("walkover") or best.meta.get("bye") or not best.games:
        return None, None
    if not store.match_rule(best, "player_scores"):
        return None, None
    return best, side_in(store, best, person_id)


def pending(app, person_id):
    """Reports about this person's matches: the ones they are asked to
    confirm, and their side's own still waiting for an answer — for the
    match on their table, and corrections to the one they just finished.
    Each shown the way round they played it."""
    s = app.store
    ask, own = [], []

    def add(m, side, c, auto):
        view = mine(c["games"], side)
        won = sum(1 for x, y in view if x > y)
        item = {"id": c["id"], "by": app.side_name(m, c["side"]), "games": view,
                "sets": [won, len(view) - won],
                "counts_at": c["ts"] + auto * 60 if auto else None}
        if c.get("fix"):
            item.update(fix=True, was=mine(m.games, side),
                        opponent=app.side_name(m, "b" if side == "a" else "a"))
        (own if c["side"] == side else ask).append(item)

    m, side = live_match(s, person_id)
    if m:
        auto = int(s.match_rule(m, "score_auto_min") or 0)
        for c in s.open_claims(m):
            add(m, side, c, auto)
    f, fside = fixable(s, person_id)
    if f:
        for c in s.open_fixes(f):
            add(f, fside, c, 0)
    return ask, own


def fix_view(app, person_id):
    """What the phone needs to offer "wrong result?": the match, who it
    was against, and the score the way round this person played it."""
    s = app.store
    m, side = fixable(s, person_id)
    if not m:
        return None
    return {"match_id": m.id, "opponent": app.side_name(m, "b" if side == "a" else "a"),
            "games": mine(m.games, side), "bo": m.scoring.best_of,
            "pts": m.scoring.points_to, "need": m.scoring.games_to_win(),
            "until": m.done_ts + FIX_WINDOW}


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
    if c.get("fix"):
        m = s.matches.get(c["match_id"])
        side = side_in(s, m, p["person_id"]) if m else None
        if not m or m.status != "done" or not side or side == c["side"]:
            return {"status": "stale"}
        if p.get("yes"):
            _close(app, c, "agreed")
            _write(app, m, c["games"], "corrected")
            return {"status": "agreed"}
        _close(app, c, "disputed")
        return {"status": "disputed", "by": app.side_name(m, c["side"])}
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


def fix(app, p):
    """A correction to a result already written: the same as a report, on
    a finished match — the other side confirms it, and only then is the
    result rewritten (re-resolving whatever it decided). Unlike a score for
    a match still on its table it never counts on time alone: a result
    that was agreed is not changed on one side's word.

      invalid  it does not decide the match
      same     it is what is already written
      sent     the other side is asked
      agreed   the other side had asked for the same correction
      disputed the other side had asked for a different one"""
    s = app.store
    m, side = fixable(s, p["person_id"])
    if not m or m.id != p.get("match_id"):
        raise ValueError("that result can't be corrected from here any more — ask the organisers")
    games = mine([[int(a), int(b)] for a, b in p["games"]], side)
    if not decide_winner(games, m.scoring) or any(not (0 <= x <= 99) for g in games for x in g):
        return {"status": "invalid", "need": m.scoring.games_to_win()}
    if games == m.games:
        return {"status": "same"}
    other = "b" if side == "a" else "a"
    opp = app.side_name(m, other)
    for c in s.open_fixes(m):
        if c["side"] != side:
            if c["games"] == games:
                _close(app, c, "agreed")
                _write(app, m, games, "corrected")
                return {"status": "agreed", "opponent": opp}
            _close(app, c, "disputed")
            return {"status": "disputed", "opponent": opp}
        _close(app, c, "replaced")
    cid = s.append("claim_open", {"match_id": m.id, "qseq": m.queued_seq, "side": side,
                                  "person_id": p["person_id"], "via": p.get("via", ""),
                                  "games": games, "fix": True})
    return {"status": "sent", "id": cid, "opponent": opp, "reachable": reachable(app, m, other)}


def dismiss(app, p):
    """The organisers closing a correction they will not make."""
    c = app.store.claims.get(int(p.get("claim_id") or 0))
    if c and c["state"] in ("open", "disputed"):
        app.store.append("claim_close", {"id": c["id"], "state": "dismissed", "force": True})
    return {}


def corrections(app, now=None):
    """Corrections the console should see: asked and unanswered, or
    disagreed about, on results from the last while."""
    s = app.store
    now = now or s.clock()
    out = []
    for c in s.claims.values():
        if not c.get("fix") or c["state"] not in ("open", "disputed"):
            continue
        m = s.matches.get(c["match_id"])
        if not m or m.status != "done" or now - c["ts"] > 3 * FIX_WINDOW:
            continue
        out.append({"claim_id": c["id"], "match_id": m.id, "state": c["state"],
                    "by": app.side_name(m, c["side"]), "a": app.side_name(m, "a"),
                    "b": app.side_name(m, "b"), "games": c["games"], "was": m.games})
    return out


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
    if not s.match_rule(m, "player_scores"):
        # scrapping a match is for a night the players run themselves
        raise ValueError("Sag das hier bitte am Eingang.")
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
        if c.get("fix"):
            # a correction waits for the other side or the organisers, but
            # not past the evening: once well outside the window it is dropped
            if not m or m.status != "done" or now - c["ts"] > 3 * FIX_WINDOW:
                _close(app, c, "stale")
            continue
        if not m or m.status != "live" or m.queued_seq != c["qseq"]:
            _close(app, c, "stale")
            continue
        auto = int(s.match_rule(m, "score_auto_min") or 0)
        if auto and now - c["ts"] >= auto * 60:
            _close(app, c, "timed")
            _write(app, m, c["games"], "timed")
            wrote = True
    return wrote
