"""A throwaway copy of tonight's event, filled with people who do not exist.

Looking at what the console does an hour into a tournament used to mean being
an hour into a tournament, or typing forty results by hand to get there. This
rebuilds the shape of the evening — the cups, the draws, the tables, the
scoring — in a store the real one cannot see, puts a plausible field in it and
plays it forward a few rounds.

Isolation is structural rather than careful. The sandbox is a second App on
its own sqlite file in its own temp directory, and the only thing that reaches
it is a request that asks for it by name. There is no code path that writes to
both, so there is nothing to get wrong on the night.

What it copies is the setup, never the people: the roster is generated, so
nobody real ever turns up in a simulated draw and no simulated name can end up
in the club directory.
"""

import random
import shutil
import tempfile
import time

from . import dispatch


# ------------------------------------------------------------------ playing

def play_one(app, table_no, upset=0.15, rng=random):
    """Report a plausible result for whatever is on the given table."""
    s = app.store
    t = s.tables[table_no]
    if not t.match_id:
        return False
    m = s.matches[t.match_id]
    sa = sum(s.entrant_strength(e) for e in [m.entrant_a] if e) or \
        sum(s.players[p].strength for p in m.side_a) / max(1, len(m.side_a))
    sb = sum(s.entrant_strength(e) for e in [m.entrant_b] if e) or \
        sum(s.players[p].strength for p in m.side_b) / max(1, len(m.side_b))
    a_better = sa >= sb
    if rng.random() < upset:
        a_better = not a_better
    need = m.scoring.games_to_win()
    games, wa, wb = [], 0, 0
    while wa < need and wb < need:
        a_wins = rng.random() < (0.68 if a_better else 0.32)
        top = m.scoring.points_to
        lose = rng.choice([3, 5, 7, 8, 9, 9])
        if lose == 9 and rng.random() < 0.35:           # deuce
            top, lose = m.scoring.points_to + 2, m.scoring.points_to
        games.append([top, lose] if a_wins else [lose, top])
        wa += a_wins
        wb += not a_wins
    app.act("referee", "report", {"match_id": m.id, "games": games})
    return True


def drain(app, limit=600, rng=random):
    """Play until no table has a match."""
    for _ in range(limit):
        played = any(play_one(app, n, rng=rng) for n in sorted(app.store.tables))
        if not played:
            return
    raise AssertionError("did not settle")


# -------------------------------------------------------------------- clock

class Clock:
    """A fake wall clock, because a night that simulates in a second still has
    to look like it took three hours.

    Durations are not decoration here: the board's "when am I playing" is the
    median of what matches have actually taken, so a store where every match
    started and finished at the same instant answers that question with
    nonsense — which is the one thing a mid-tournament preview is for.
    """

    def __init__(self, start):
        self.t = float(start)

    def __call__(self):
        return self.t

    def step(self, secs):
        self.t += secs


# -------------------------------------------------------------------- field

FIRST = ("Ana Bo Cato Dilan Eva Finn Gitte Hugo Ida Jonas Kira Lars Mette "
         "Noor Otto Pia Quinn Rasmus Sanne Timo Ulla Vera Wim Xenia Ylva Zoe "
         "Aksel Britt Casper Dorte Emil Frida Gustav Hanne Ivar Jette Kasper "
         "Lone Malte Nina Ole Petra Rune Sofie Teis Ulrik Vibeke Yannick"
         ).split()

LAST = ("Aaby Bech Clausen Dahl Egeberg Fisker Gram Holm Iversen Juhl Kofoed "
        "Lund Munk Nissen Olsen Pedersen Riis Storm Thygesen Uhre Vinther "
        "Wagner Bang Friis Hald Krogh Mols Nyborg Ravn Skou"
        ).split()


def _people(rng, n, seen):
    """n names nobody else has, and a strength for each.

    Unique across the whole sandbox, not just this cup: the door refuses two
    people with the same name tonight — that is how the wrong strength ends
    up on the wrong person — so two cups drawing the same name out of the hat
    would fail the build rather than the draw.

    The spread of strengths is the point. A field where everybody is a 5
    pairs cleanly and tells you nothing; the matchmaker, the seeding and the
    standings all look wrong on a field with two outliers and a fat middle,
    which is where they look wrong in a hall too.
    """
    out = []
    while len(out) < n:
        name = f"{rng.choice(FIRST)} {rng.choice(LAST)}"
        if name in seen:
            # the hat is not infinite, and a sandbox big enough to empty it
            # should still build
            name = f"{name} {len(seen)}"
            if name in seen:
                continue
        seen.add(name)
        out.append((name, round(min(10.0, max(1.0, rng.gauss(5.4, 1.9))), 1)))
    return out


# ---------------------------------------------------------------- structure

# format config that belongs to a draw that has run, not to its setup
RUNTIME_KEYS = ("entrant_ids", "cup_id", "status", "phase", "ko_seeds")


def structure(store):
    """The evening's shape, in the shape the wizard's own action takes.

    A payload rather than a copy on purpose. The sandbox is then built by
    exactly the events the Setup tabs emit — event_new, cup_add, format_add,
    table_set — so there is no second way to configure an event, and anything
    the real console can do to a draw it can do to the simulated one.

    What is left out is as deliberate: who is in it, how far it has got, and
    whether the public door is open.
    """
    cups, cup_at = [], {}
    for cid in store.cup_order:
        c = store.cups.get(cid)
        if not c:
            continue
        f = store.formats.get(c.format_id)
        cfg = {k: v for k, v in (f.config if f else {}).items()
               if k not in RUNTIME_KEYS}
        cup_at[cid] = len(cups)
        cups.append({"name": c.name, "blurb": c.blurb, "entry": c.entry,
                     "registration": "closed",     # no public door on a sim
                     "kind": f.kind if f else "",
                     "format_name": f.name if f else "",
                     "config": cfg})

    tables = []
    for n in sorted(store.tables):
        t = store.tables[n]
        tables.append({"name": t.name, "cup": cup_at.get(t.cup_id)})

    loose = [{"kind": f.kind, "name": f.name,
              "config": {k: v for k, v in f.config.items() if k not in RUNTIME_KEYS}}
             for f in (store.formats.get(i) for i in store.format_order)
             if f and not store.cup_of_format(f)]

    return {
        "event": {"name": (store.event.get("name") or "").strip(),
                  "blurb": store.event.get("blurb", ""),
                  "venue": store.event.get("venue", "")},
        "cups": cups, "tables": tables, "loose": loose,
    }


# --------------------------------------------------------------- the rounds

def rounds_played(store, f):
    """How far through this draw we are, in rounds.

    Not read off the round numbers the matches carry: a free-running Swiss
    numbers every match it creates, so those count matches, not rounds. What
    holds across all four formats is games played — a round is everybody
    having had another go, and the middle of the field is what says whether
    that happened.

    A bracket is the exception and has to be counted its own way, because
    half the field is knocked out every round and the median stops moving
    after the first one.
    """
    done = [m for m in store.matches.values()
            if m.format_id == f.id and m.status == "done"]
    if not done:
        return 0
    ko = [m.meta.get("round", 0) for m in done if m.meta.get("phase") == "ko"]
    played = {}
    for m in done:
        for e in (m.entrant_a, m.entrant_b):
            if e:
                played[e] = played.get(e, 0) + 1
    ids = list(f.entrant_ids) or list(played)
    counts = sorted(played.get(e, 0) for e in ids) if ids else [0]
    return max(counts[len(counts) // 2], (max(ko) + 1) if ko else 0)


def far_enough(store, rounds):
    """True once every running draw has had its rounds, or has run out."""
    running = [store.formats[i] for i in store.format_order
               if i in store.formats and store.formats[i].status == "running"]
    if not running:
        return True
    return all(rounds_played(store, f) >= rounds or f.is_complete(store)
               for f in running)


# --------------------------------------------------------------- the thing

class Sandbox:
    """A live App nobody real is playing in."""

    def __init__(self, app, data_dir, note, per_cup, rounds):
        self.app = app
        self.data_dir = data_dir
        self.note = note
        self.per_cup = per_cup
        self.rounds = rounds
        self.built_ts = time.time()

    def close(self):
        try:
            self.app.store.conn.close()
        except Exception:
            pass
        shutil.rmtree(self.data_dir, ignore_errors=True)

    def info(self):
        s = self.app.store
        return {
            "built_ts": self.built_ts,
            "note": self.note,
            "per_cup": self.per_cup,
            "rounds": self.rounds,
            "entrants": len(s.entrants),
            "played": sum(1 for m in s.matches.values() if m.status == "done"),
            "live": sum(1 for m in s.matches.values() if m.status == "live"),
        }


MIN_PER_CUP, MAX_PER_CUP, MAX_ROUNDS = 2, 64, 12


def build(live, make_app, per_cup=18, rounds=3, seed=None):
    """Stand up a sandbox from the live event's setup and play it forward.

    `make_app` is the App constructor, passed in rather than imported so this
    module stays underneath the server rather than beside it.
    """
    per_cup = max(MIN_PER_CUP, min(MAX_PER_CUP, int(per_cup)))
    rounds = max(1, min(MAX_ROUNDS, int(rounds)))
    rng = random.Random(seed if seed is not None else random.randrange(1 << 30))

    with live.store.lock:
        spec = structure(live.store)
    if not any(c["kind"] for c in spec["cups"]) and not spec["loose"]:
        # a cup with no draw in it would copy across as a roster and no
        # matches, which looks like the sim failed rather than like the event
        # is half set up
        raise ValueError("set up a cup with a draw in it first — "
                         "there is nothing to simulate yet")

    data_dir = tempfile.mkdtemp(prefix="tt-sim-")
    try:
        app = make_app(data_dir)
        app.is_sim = True
        app.keys = dict(live.keys)      # the sim tab is the same tab, flagged
        store = app.store
        clock = Clock(time.time())
        store.clock = clock
        _seed_event(app, spec)
        note = _fill(app, spec, per_cup, rng)
        _play(app, clock, rounds, rng)
        _rebase(store, clock)
    except Exception:
        shutil.rmtree(data_dir, ignore_errors=True)
        raise
    return Sandbox(app, data_dir, note, per_cup, rounds)


def _seed_event(app, spec):
    ev = spec["event"]
    app.act("admin", "create_event", {
        "name": (ev["name"] + " (sim)").strip(),
        "blurb": ev["blurb"], "venue": ev["venue"],
        "cups": spec["cups"], "tables": spec["tables"],
    })
    for f in spec["loose"]:
        app.act("admin", "add_format", f)
    # a sandbox is always mid-evening, whatever the real one's clock says
    app.act("admin", "event_meta", {"phase_pin": "live"})


def _fill(app, spec, per_cup, rng):
    """Put a field in every draw, through the door like anybody else."""
    s = app.store
    made, seen = 0, set()
    for cid in list(s.cup_order):
        cup = s.cups.get(cid)
        if not cup:
            continue
        pair = cup.entry == "pair"
        people = _people(rng, per_cup * (2 if pair else 1), seen)
        for i in range(per_cup):
            if pair:
                (n1, s1), (n2, s2) = people[2 * i], people[2 * i + 1]
                app.act("admin", "admit", {
                    "cup_id": cid, "kind": "pair", "name": n1, "strength": s1,
                    "partner_name": n2, "partner_strength": s2})
            else:
                name, st = people[i]
                app.act("admin", "admit", {"cup_id": cid, "kind": "single",
                                           "name": name, "strength": st})
            made += 1

    # an evening with no cups is the old kind: the draw holds its own people
    if not s.cup_order:
        for fid in list(s.format_order):
            ids = []
            for name, st in _people(rng, per_cup, seen):
                ids.append(app.act("admin", "add_player",
                                   {"name": name, "strength": st, "solo": True})
                           ["player_id"])
                made += 1
            ents = [e.id for e in s.entrants.values() if e.player_ids[0] in ids]
            app.act("admin", "start_format", {"id": fid, "entrant_ids": ents})

    for fid in list(s.format_order):
        f = s.formats.get(fid)
        if f and f.status == "setup":
            app.act("admin", "start_format", {"id": fid})
    n = len(s.cup_order) or len(s.format_order)
    return f"{made} entrants across {n} draw{'' if n == 1 else 's'}"


def _play(app, clock, rounds, rng, limit=4000):
    """Play until every draw has had its rounds, or nothing will move.

    Whatever is on a table when it stops is left there, live and unscored,
    because a console with three matches running is the thing being looked at.
    """
    s = app.store
    dispatch.tick(s)
    per = max(1, len(s.tables))
    for _ in range(limit):
        if far_enough(s, rounds):
            return
        played = False
        for n in sorted(s.tables):
            if far_enough(s, rounds):
                return
            if play_one(app, n, rng=rng):
                # each match eats a table for its duration, so wall time moves
                # at a table's share of it
                clock.step(rng.uniform(7 * 60, 15 * 60) / per)
                played = True
        if not played:
            return


def _rebase(store, clock):
    """Slide the simulated evening back so it ends now.

    The fake clock has to run forwards while the sim plays, which leaves the
    whole thing sitting hours in the future — every live match "started" after
    the browser's idea of now, and every elapsed time comes out negative. One
    offset over the log and a replay puts the last event on the real clock,
    with everything before it where it should be.
    """
    delta = clock() - time.time()
    with store.lock:
        if delta > 0:
            store.conn.execute("UPDATE events SET ts = ts - ?", (delta,))
            store.conn.commit()
            store.replay()
        store.clock = time.time      # from here on it is a real console again
