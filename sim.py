"""Plays complete events through every format and checks the invariants."""

import http.client, json, os, random, shutil, sys, tempfile, threading, time
from datetime import datetime, timedelta
from http.server import ThreadingHTTPServer
from tt.server import App, Handler
from tt import dispatch, simulate
from tt.simulate import play_one, drain

random.seed(7)


def fresh():
    d = tempfile.mkdtemp()
    return App(d), d


def add_player(app, name, s, cup=None):
    return app.act("admin", "add_player", {"name": name, "strength": s, "solo": True,
                                           "cup_id": cup})["player_id"]


def add_pair(app, n1, s1, n2, s2, label=None, cup=None):
    return app.act("admin", "add_team",
                   {"name": label, "members": [[n1, s1], [n2, s2]],
                    "cup_id": cup})["entrant_id"]


# The two of these that the server also needs — a plausible result, and
# playing until the tables are empty — live in tt/simulate.py, which is where
# the sandbox uses them from. One copy, so a change to how a simulated match
# goes cannot be true here and false in the preview.


def check(cond, msg):
    if not cond:
        print("  FAIL:", msg)
        sys.exit(1)
    print("  ok:", msg)


# --------------------------------------------------------------- open play
def test_open_play():
    print("\n[open play, fixed pairs, wide strength spread]")
    app, d = fresh()
    ents = []
    spread = [9, 8.5, 8, 5, 5, 5, 5, 4.5, 2, 1]      # two outliers at each end
    for i, s in enumerate(spread):
        ents.append(add_pair(app, f"A{i}", s, f"B{i}", s, f"Pair {i} ({s})"))
    fid = app.act("admin", "add_format", {
        "kind": "open_play", "name": "Open",
        "config": {"mode": "pairs", "base_gap": 1.0, "widen_every": 3,
                   "avoid_rematch": True, "scoring": {"best_of": 3, "points_to": 11}},
    })["format_id"]
    app.act("admin", "start_format", {"id": fid})
    for e in ents:
        app.act("admin", "join_queue", {"entrant_id": e, "format_id": fid})

    for _ in range(40):
        for n in sorted(app.store.tables):
            play_one(app, n)

    s = app.store
    counts = {e: 0 for e in ents}
    gaps = []
    for m in s.done_matches():
        counts[m.entrant_a] += 1
        counts[m.entrant_b] += 1
        gaps.append(abs(s.entrant_strength(m.entrant_a) - s.entrant_strength(m.entrant_b)))
    print("   matches per pair:", sorted(counts.values()))
    print(f"   mean strength gap {sum(gaps)/len(gaps):.2f}, worst {max(gaps):.1f}")
    check(min(counts.values()) > 0, "nobody starved, including the 1 and the 9")
    check(max(counts.values()) - min(counts.values()) <= 16, "play is roughly evenly spread")
    check(sum(gaps) / len(gaps) < 1.8, "average pairing stays close in strength")
    check(max(gaps) <= 5.0, "even the worst pairing stays inside a sane spread")

    meets = {}
    for m in s.done_matches():
        k = frozenset((m.entrant_a, m.entrant_b))
        meets[k] = meets.get(k, 0) + 1
    print("   worst rematch count:", max(meets.values()))
    check(max(meets.values()) <= 9, "rematches stay bounded even in a lopsided field")
    shutil.rmtree(d)


def test_scramble():
    print("\n[open play, scramble doubles]")
    app, d = fresh()
    for i, s in enumerate([9, 8, 7, 6, 5, 5, 4, 3, 2, 1, 6, 7, 5, 4, 8, 3]):
        add_player(app, f"P{i}", s)
    fid = app.act("admin", "add_format", {
        "kind": "open_play", "name": "Scramble",
        "config": {"mode": "scramble", "base_gap": 1.0, "imbalance_lambda": 0.5,
                   "scoring": {"best_of": 3, "points_to": 11}},
    })["format_id"]
    app.act("admin", "start_format", {"id": fid})
    for e in app.store.entrants:
        app.act("admin", "join_queue", {"entrant_id": e, "format_id": fid})
    for _ in range(30):
        for n in sorted(app.store.tables):
            play_one(app, n)

    s = app.store
    played = {p: 0 for p in s.players}
    partners = {}
    for m in s.done_matches():
        check(len(m.side_a) == 2 and len(m.side_b) == 2, "") if False else None
        for side in (m.side_a, m.side_b):
            assert len(side) == 2
            partners[frozenset(side)] = partners.get(frozenset(side), 0) + 1
        for p in m.players():
            played[p] += 1
    print("   matches per player:", sorted(played.values()))
    print("   most repeated partnership:", max(partners.values()))
    check(min(played.values()) > 0, "every player got games")
    check(max(partners.values()) <= 4, "partners rotate rather than sticking")
    shutil.rmtree(d)


# --------------------------------------------------------------- groups+ko
def test_groups_ko():
    print("\n[groups of 4 into a knockout, with third place]")
    app, d = fresh()
    ents = [add_pair(app, f"G{i}a", 9 - i * 0.6, f"G{i}b", 9 - i * 0.6, f"Team {i}")
            for i in range(12)]
    fid = app.act("admin", "add_format", {
        "kind": "groups", "name": "Main draw", "entrant_ids": ents,
        "config": {"n_groups": 3, "then_ko": True, "advance_per_group": 2,
                   "third_place": True,
                   "scoring": {"best_of": 3, "points_to": 11},
                   "ko_scoring": {"best_of": 5, "points_to": 11}},
    })["format_id"]
    app.act("admin", "start_format", {"id": fid})
    s = app.store
    group_matches = [m for m in s.matches.values() if m.meta.get("phase") == "groups"]
    check(len(group_matches) == 3 * 6, "3 groups of 4 produce 18 group matches")
    drain(app)
    f = s.formats[fid]
    check(f.phase == "ko", "knockout built automatically once groups finished")
    ko = [m for m in s.matches.values() if m.meta.get("phase") == "ko"]
    check(all(m.scoring.best_of == 5 for m in ko), "knockout uses its own best-of-5")
    finals = [m for m in ko if m.meta.get("round_name") == "Final"]
    third = [m for m in ko if m.meta.get("round_name") == "Third place"]
    check(len(finals) == 1 and finals[0].status == "done", "a final was played")
    check(len(third) == 1 and third[0].status == "done", "third place was played")
    champ = finals[0].entrant_a if finals[0].winner == "a" else finals[0].entrant_b
    print("   champion:", s.entrant_name(champ))
    check(f.is_complete(s), "format reports complete")

    # every group table should be full and consistent
    for g in f.standings(s):
        tot = sum(r["played"] for r in g["rows"])
        check(tot == 12, f"{g['group']} played counts add up")
    shutil.rmtree(d)


def test_single_elim_byes():
    print("\n[straight knockout with an awkward field of 6]")
    app, d = fresh()
    ents = [add_pair(app, f"K{i}a", 8 - i, f"K{i}b", 8 - i, f"Seed {i+1}") for i in range(6)]
    fid = app.act("admin", "add_format", {
        "kind": "single_elim", "name": "Cup", "entrant_ids": ents,
        "config": {"scoring": {"best_of": 3, "points_to": 11}},
    })["format_id"]
    app.act("admin", "start_format", {"id": fid})
    s = app.store
    r0 = [m for m in s.matches.values() if m.meta.get("round") == 0]
    check(len(r0) == 2, "the two byes create no phantom matches")
    drain(app)
    finals = [m for m in s.matches.values() if m.meta.get("round_name") == "Final"]
    check(len(finals) == 1 and finals[0].status == "done", "bracket resolved to a final")
    total = len([m for m in s.matches.values() if m.status == "done"])
    check(total == 5, "6 entrants need exactly 5 matches")
    shutil.rmtree(d)


def test_swiss():
    print("\n[Swiss, 7 entrants so somebody gets a bye every round]")
    app, d = fresh()
    ents = [add_pair(app, f"S{i}a", 8 - i * 0.8, f"S{i}b", 8 - i * 0.8, f"Sw {i}")
            for i in range(7)]
    fid = app.act("admin", "add_format", {
        "kind": "swiss", "name": "Swiss", "entrant_ids": ents,
        "config": {"rounds": 5, "scoring": {"best_of": 3, "points_to": 11}},
    })["format_id"]
    app.act("admin", "start_format", {"id": fid})
    drain(app)
    s, f = app.store, app.store.formats[fid]
    check(f._rounds_done(s) == 5, "all five rounds generated and played")
    byes = [m.meta["bye"] for m in s.matches.values() if m.meta.get("bye")]
    check(len(byes) == len(set(byes)), "nobody got two byes")
    rows = f.standings(s)[0]["rows"]
    print("   top three:", [(r["name"], r["won"], r["buchholz"]) for r in rows[:3]])
    check(all(r["played"] >= 4 for r in rows), "everyone played at least four")
    check(rows[0]["won"] >= rows[-1]["won"], "table is sorted by wins")
    shutil.rmtree(d)


def test_parallel():
    print("\n[knockout and open play sharing three tables]")
    app, d = fresh()
    ko_ents = [add_pair(app, f"X{i}a", 8, f"X{i}b", 8, f"Cup {i}") for i in range(4)]
    open_ents = [add_pair(app, f"Y{i}a", 5, f"Y{i}b", 5, f"Open {i}") for i in range(4)]
    kf = app.act("admin", "add_format", {
        "kind": "single_elim", "name": "Cup", "entrant_ids": ko_ents,
        "config": {"scoring": {"best_of": 3, "points_to": 11}}})["format_id"]
    of = app.act("admin", "add_format", {
        "kind": "open_play", "name": "Side tables",
        "config": {"mode": "pairs", "scoring": {"best_of": 3, "points_to": 11}}})["format_id"]
    app.act("admin", "start_format", {"id": kf})
    app.act("admin", "start_format", {"id": of})
    for e in open_ents:
        app.act("admin", "join_queue", {"entrant_id": e, "format_id": of})

    s = app.store
    busy_formats = {s.matches[t.match_id].format_id
                    for t in s.tables.values() if t.match_id}
    check(len(busy_formats) == 2, "both formats got a table straight away")
    for _ in range(25):
        for n in sorted(s.tables):
            play_one(app, n)
    kdone = len([m for m in s.done_matches(kf)])
    odone = len([m for m in s.done_matches(of)])
    print(f"   cup matches {kdone}, open play matches {odone}")
    check(kdone == 3, "the four-team cup finished")
    check(odone > 3, "open play kept the spare table busy throughout")
    shutil.rmtree(d)


def test_replay_and_undo():
    print("\n[log replay and correcting a wrong score]")
    app, d = fresh()
    ents = [add_pair(app, f"R{i}a", 7 - i, f"R{i}b", 7 - i, f"R{i}") for i in range(8)]
    fid = app.act("admin", "add_format", {
        "kind": "single_elim", "name": "Cup", "entrant_ids": ents,
        "config": {"scoring": {"best_of": 3, "points_to": 11}}})["format_id"]
    app.act("admin", "start_format", {"id": fid})
    drain(app)
    s = app.store
    before = {m.id: (m.status, m.winner, tuple(map(tuple, m.games)))
              for m in s.matches.values()}
    s.replay()
    after = {m.id: (m.status, m.winner, tuple(map(tuple, m.games)))
             for m in s.matches.values()}
    check(before == after, "replaying the whole log reproduces the state exactly")

    # someone entered a first-round score backwards
    r0 = sorted([m for m in s.matches.values() if m.meta.get("round") == 0],
                key=lambda m: m.id)[0]
    seq_before = r0.seq
    old_winner = r0.winner
    ev = [h for h in s.history(500) if h["type"] == "match_result"
          and h["payload"]["match_id"] == r0.id][0]
    s.rewind(ev["seq"] - 1)
    check(s.matches[r0.id].status in ("pending", "live"), "rewind reopened that match")
    flipped = [[g[1], g[0]] for g in before[r0.id][2]]
    app.act("referee", "report", {"match_id": r0.id, "games": flipped})
    check(s.matches[r0.id].winner != old_winner, "corrected result flipped the winner")
    drain(app)
    finals = [m for m in s.matches.values() if m.meta.get("round_name") == "Final"]
    check(finals[0].status == "done", "bracket re-resolved after the correction")
    shutil.rmtree(d)


def test_cups_and_tables():
    print("\n[cups: two tournaments sharing five tables with a strict split]")
    app, d = fresh()
    s = app.store
    app.act("admin", "set_table", {"number": 4, "name": "Table 4"})
    app.act("admin", "set_table", {"number": 5, "name": "Table 5"})
    cup_a = app.act("admin", "add_cup", {"name": "Cup A"})["cup_id"]
    cup_b = app.act("admin", "add_cup", {"name": "Cup B"})["cup_id"]
    for n in (1, 2, 3):
        app.act("admin", "set_table", {"number": n, "cup_id": cup_a})
    for n in (4, 5):
        app.act("admin", "set_table", {"number": n, "cup_id": cup_b})

    a_ents = [add_pair(app, f"A{i}a", 5, f"A{i}b", 5, f"A{i}", cup=cup_a) for i in range(6)]
    b_ents = [add_pair(app, f"B{i}a", 5, f"B{i}b", 5, f"B{i}", cup=cup_b) for i in range(6)]
    fa = app.act("admin", "add_format", {
        "kind": "open_play", "name": "Cup A open",
        "config": {"mode": "pairs", "cup_id": cup_a,
                   "scoring": {"best_of": 3, "points_to": 11}}})["format_id"]
    fb = app.act("admin", "add_format", {
        "kind": "open_play", "name": "Cup B open",
        "config": {"mode": "pairs", "cup_id": cup_b,
                   "scoring": {"best_of": 3, "points_to": 11}}})["format_id"]
    app.act("admin", "start_format", {"id": fa})
    app.act("admin", "start_format", {"id": fb})
    for e in a_ents:
        app.act("admin", "join_queue", {"entrant_id": e, "format_id": fa})
    for e in b_ents:
        app.act("admin", "join_queue", {"entrant_id": e, "format_id": fb})

    for _ in range(40):
        for n in sorted(s.tables):
            play_one(app, n)

    bad = [(h["payload"]["match_id"], h["payload"]["table"])
           for h in s.history(5000) if h["type"] == "match_assign"
           and s.matches.get(h["payload"]["match_id"])
           and ((s.matches[h["payload"]["match_id"]].format_id == fa
                 and h["payload"]["table"] not in (1, 2, 3))
                or (s.matches[h["payload"]["match_id"]].format_id == fb
                    and h["payload"]["table"] not in (4, 5)))]
    check(not bad, f"cup-tagged matches only ever used their own cup's tables (bad={bad[:5]})")
    check(len(s.done_matches(fa)) > 5, "Cup A matches were played")
    check(len(s.done_matches(fb)) > 5, "Cup B matches were played")
    shutil.rmtree(d)


def test_format_cleanup():
    print("\n[removing/resetting a format leaves no residue]")
    app, d = fresh()
    s = app.store
    ents = [add_pair(app, f"C{i}a", 5, f"C{i}b", 5, f"C{i}") for i in range(4)]
    fid = app.act("admin", "add_format", {
        "kind": "single_elim", "name": "Cup", "entrant_ids": ents,
        "config": {"scoring": {"best_of": 3, "points_to": 11}}})["format_id"]
    app.act("admin", "start_format", {"id": fid})
    play_one(app, sorted(s.tables)[0])          # finish one, leave the other live/pending
    app.act("admin", "remove_format", {"id": fid})
    check(all(m.status == "void" for m in s.matches.values() if m.format_id == fid),
          "every match from a removed format is voided")
    check(all(t.match_id is None for t in s.tables.values()), "tables freed by the removal")
    check(fid not in s.formats, "format itself is gone")

    fid2 = app.act("admin", "add_format", {
        "kind": "single_elim", "name": "Cup2", "entrant_ids": ents,
        "config": {"scoring": {"best_of": 3, "points_to": 11}}})["format_id"]
    app.act("admin", "start_format", {"id": fid2})
    play_one(app, sorted(s.tables)[0])
    app.act("admin", "reset_format", {"id": fid2})
    check(all(m.status == "void" for m in s.matches.values() if m.format_id == fid2),
          "reset voids the format's matches")
    check(s.formats[fid2].status == "setup", "reset puts the format back in setup")
    app.act("admin", "start_format", {"id": fid2})
    check(any(m.status != "void" for m in s.matches.values() if m.format_id == fid2),
          "format can be started again after a reset")
    shutil.rmtree(d)


def test_swiss_ko():
    print("\n[Swiss into a knockout once rounds finish]")
    app, d = fresh()
    ents = [add_pair(app, f"W{i}a", 8 - i * 0.5, f"W{i}b", 8 - i * 0.5, f"W{i}")
            for i in range(8)]
    fid = app.act("admin", "add_format", {
        "kind": "swiss", "name": "Swiss+KO", "entrant_ids": ents,
        "config": {"rounds": 3, "then_ko": True, "advance": 4,
                   "scoring": {"best_of": 3, "points_to": 11}}})["format_id"]
    app.act("admin", "start_format", {"id": fid})
    s, f = app.store, app.store.formats[fid]
    drain(app)
    check(f.phase == "ko", "Swiss crossed into the knockout once rounds finished")
    ko = [m for m in s.matches.values() if m.format_id == fid and m.meta.get("phase") == "ko"]
    check(len(ko) == 3, "4 advancers need exactly 3 knockout matches")
    check(all(m.status == "done" for m in ko), "the bracket played out")
    check(f.is_complete(s), "format reports complete once the bracket is done")
    shutil.rmtree(d)


def test_swiss_cut_ko():
    print("\n[Swiss cut short into a knockout on demand]")
    app, d = fresh()
    ents = [add_pair(app, f"Z{i}a", 8 - i * 0.4, f"Z{i}b", 8 - i * 0.4, f"Z{i}")
            for i in range(8)]
    fid = app.act("admin", "add_format", {
        "kind": "swiss", "name": "Continuous Swiss", "entrant_ids": ents,
        "config": {"continuous": True, "advance": 4,
                   "scoring": {"best_of": 3, "points_to": 11}}})["format_id"]
    app.act("admin", "start_format", {"id": fid})
    s, f = app.store, app.store.formats[fid]
    for e in ents:
        app.act("admin", "join_queue", {"entrant_id": e, "format_id": fid})
    for _ in range(15):
        for n in sorted(s.tables):
            play_one(app, n)
    check(f.phase != "ko", "still mid-Swiss before the cut")
    app.act("admin", "swiss_cut_ko", {"id": fid})
    check(f.phase == "ko", "cutting short built the knockout immediately")
    stray = [m for m in s.matches.values() if m.format_id == fid
             and m.meta.get("phase") == "swiss" and m.status == "pending"]
    check(not stray, "no leftover swiss pending matches after the cut")
    drain(app)
    check(f.is_complete(s), "the cut-short knockout still finishes cleanly")
    shutil.rmtree(d)


def test_swiss_respects_sitout():
    print("\n[Swiss stops pairing someone once they sit out]")
    app, d = fresh()
    s = app.store
    for i in range(6):
        add_player(app, f"P{i}", 5)
    ents = [e.id for e in sorted(s.entrants.values(), key=lambda e: e.name)]
    fid = app.act("admin", "add_format", {
        "kind": "swiss", "name": "Swiss", "entrant_ids": ents,
        "config": {"rounds": 3, "scoring": {"best_of": 3, "points_to": 11}}})["format_id"]
    app.act("admin", "start_format", {"id": fid})
    r0 = [m for m in s.matches.values() if m.format_id == fid and m.meta.get("round") == 0]
    target = r0[0]
    sitout_pid = s.entrants[target.entrant_a].player_ids[0]
    for m in r0:
        if m.id != target.id:
            play_one(app, m.table)
    app.act("admin", "update_player", {"id": sitout_pid, "active": False})
    play_one(app, target.table)          # last round-0 result triggers round 1
    round1 = [m for m in s.matches.values() if m.format_id == fid and m.meta.get("round") == 1]
    check(bool(round1), "round 1 was generated")
    check(not any(sitout_pid in m.players() for m in round1),
          "the player who sat out mid-round-0 was excluded from round 1")
    shutil.rmtree(d)


def test_permissions():
    print("\n[roles]")
    app, d = fresh()
    add_pair(app, "a", 5, "b", 5)
    ok = True
    try:
        app.act("public", "add_player", {"name": "x"})
        ok = False
    except PermissionError:
        pass
    check(ok, "spectators cannot change anything")
    try:
        app.act("referee", "add_format", {"kind": "open_play"})
        ok = False
    except PermissionError:
        pass
    check(ok, "referees cannot create formats")
    shutil.rmtree(d)


def solo_field(app, n, base=5.0, step=0.0):
    return [add_player(app, f"P{i}", base + i * step) for i in range(n)]


def entrant_ids(app):
    return [e.id for e in app.store.entrants.values()]


def into_cups(app, mapping):
    """Put already-admitted entrants into cups, the way the console does: by
    saying which cup they are in, and nothing else."""
    for cid, eids in mapping.items():
        for e in eids:
            app.act("admin", "update_entrant", {"id": e, "cup_id": cid})


def test_fair_cup_share():
    print("\n[two cups sharing tables get served fairly]")
    app, d = fresh()
    solo_field(app, 16)
    ca = app.act("admin", "add_cup", {"name": "Cup A"})["cup_id"]
    cb = app.act("admin", "add_cup", {"name": "Cup B"})["cup_id"]
    es = entrant_ids(app)
    into_cups(app, {ca: es[:8], cb: es[8:]})
    fa = app.act("admin", "add_format", {"kind": "groups", "name": "A",
         "config": {"n_groups": 1, "then_ko": False, "cup_id": ca},
         "entrant_ids": es[:8]})["format_id"]
    fb = app.act("admin", "add_format", {"kind": "groups", "name": "B",
         "config": {"n_groups": 1, "then_ko": False, "cup_id": cb},
         "entrant_ids": es[8:]})["format_id"]
    app.act("admin", "start_format", {"id": fa})
    app.act("admin", "start_format", {"id": fb})
    seen = []
    for _ in range(300):
        moved = False
        for n in sorted(app.store.tables):
            t = app.store.tables[n]
            if t.match_id:
                seen.append("A" if app.store.matches[t.match_id].format_id == fa else "B")
                play_one(app, n)
                moved = True
        if not moved:
            break
    first = "".join(seen[:20])
    print("   first twenty dispatched:", first)
    # the old dispatcher handed every table to whichever cup was created
    # first until it ran out of matches entirely
    check(6 <= first.count("B") <= 14, "neither cup starves early on")
    check(seen.count("A") > 0 and seen.count("B") > 0, "both cups played out")
    shutil.rmtree(d)


def test_swiss_does_not_outrun_a_bigger_cup():
    print("\n[a small cup cannot reach its knockout while a big one is in round one]")
    app, d = fresh()
    solo_field(app, 20)
    big = app.act("admin", "add_cup", {"name": "Big"})["cup_id"]
    small = app.act("admin", "add_cup", {"name": "Small"})["cup_id"]
    es = entrant_ids(app)
    into_cups(app, {big: es[:16], small: es[16:]})
    fbig = app.act("admin", "add_format", {"kind": "swiss", "name": "Big draw",
           "config": {"continuous": True, "paced": True, "rounds": 4,
                      "cup_id": big}, "entrant_ids": es[:16]})["format_id"]
    fsm = app.act("admin", "add_format", {"kind": "swiss", "name": "Small draw",
          "config": {"continuous": True, "paced": True, "rounds": 4,
                     "cup_id": small}, "entrant_ids": es[16:]})["format_id"]
    for f in (fbig, fsm):
        app.act("admin", "start_format", {"id": f})
        for e in app.store.formats[f].entrant_ids:
            app.act("admin", "join_queue", {"entrant_id": e, "format_id": f})
    worst = 0
    for _ in range(400):
        moved = False
        for n in sorted(app.store.tables):
            if app.store.tables[n].match_id:
                play_one(app, n)
                moved = True
        s = app.store
        pb = s.formats[fbig].remaining_work(s)
        ps = s.formats[fsm].remaining_work(s)
        big_frac = 1 - pb / 32.0
        small_frac = 1 - ps / 8.0
        worst = max(worst, small_frac - big_frac)
        if not moved:
            break
    print(f"   worst lead the small cup ever built: {worst:.0%} of its draw")
    check(worst < 0.60, "the small draw never runs away with the tables")
    check(app.store.formats[fbig].is_complete(app.store), "the big draw finished too")
    shutil.rmtree(d)


def test_paced_swiss_keeps_the_field_level():
    print("\n[paced Swiss: on demand, but nobody gets ahead]")
    app, d = fresh()
    solo_field(app, 8, 5.0, 0.2)
    f = app.act("admin", "add_format", {"kind": "swiss", "name": "Swiss",
        "config": {"continuous": True, "paced": True, "rounds": 4},
        "entrant_ids": entrant_ids(app)})["format_id"]
    app.act("admin", "start_format", {"id": f})
    for e in entrant_ids(app):
        app.act("admin", "join_queue", {"entrant_id": e, "format_id": f})
    worst = 0
    for _ in range(120):
        moved = False
        for n in sorted(app.store.tables):
            if app.store.tables[n].match_id:
                play_one(app, n)
                moved = True
        pl = app.store.formats[f]._played(app.store)
        if pl:
            worst = max(worst, max(pl.values()) - min(pl.values()))
        if not moved:
            break
    played = app.store.formats[f]._played(app.store)
    print("   games played per entrant:", sorted(played.values()))
    check(worst <= 1, f"nobody ever got more than one game ahead (worst {worst})")
    check(set(played.values()) == {4}, "everyone played exactly the round budget")
    check(app.store.formats[f].is_complete(app.store), "it knows when it is done")
    shutil.rmtree(d)


def test_lowering_the_round_count_cuts_off():
    print("\n[a round count lowered mid-event cuts off what was drawn past it]")
    for pace in ("paced", "strict"):
        app, d = fresh()
        s = app.store
        solo_field(app, 8, 5.0, 0.2)
        cfg = {"rounds": 4, "continuous": pace != "strict", "paced": pace == "paced",
               "then_ko": True, "advance": 4}
        f = app.act("admin", "add_format", {"kind": "swiss", "name": "Swiss",
            "config": cfg, "entrant_ids": entrant_ids(app)})["format_id"]
        app.act("admin", "start_format", {"id": f})
        if pace != "strict":
            for e in entrant_ids(app):
                app.act("admin", "join_queue", {"entrant_id": e, "format_id": f})
        fo = s.formats[f]
        # play three rounds' worth; round four is then already under way
        while sum(1 for m in s.matches.values() if m.format_id == f
                  and m.status == "done" and m.meta.get("phase") == "swiss") < 12:
            for n in sorted(s.tables):
                if s.tables[n].match_id:
                    play_one(app, n)
        check(any(m.format_id == f and m.status == "live"
                  and m.meta.get("phase") == "swiss" for m in s.matches.values()),
              f"{pace}: a fourth-round match is on a table")
        before = fo._played(s)
        app.act("admin", "update_format", {"id": f, "config": dict(cfg, rounds=3)})
        check(not [m for m in s.matches.values() if m.format_id == f
                   and m.meta.get("phase") == "swiss" and m.status in ("pending", "live")],
              f"{pace}: lowering to three takes it back off the table")
        check(fo.phase == "ko", f"{pace}: and the knockout is drawn straight away")
        drain(app)
        # a fourth game already finished stays: it was played
        after = fo._played(s)
        check(all(after[e] <= max(before[e], 3) for e in after),
              f"{pace}: nobody played past three after the change")
        shutil.rmtree(d)


def test_swiss_ko_drops_the_queue():
    print("\n[cutting a continuous Swiss to a knockout closes its queue]")
    app, d = fresh()
    solo_field(app, 8, 5.0, 0.1)
    f = app.act("admin", "add_format", {"kind": "swiss", "name": "Swiss",
        "config": {"continuous": True, "then_ko": True, "advance": 4},
        "entrant_ids": entrant_ids(app)})["format_id"]
    app.act("admin", "start_format", {"id": f})
    for e in entrant_ids(app):
        app.act("admin", "join_queue", {"entrant_id": e, "format_id": f})
    for _ in range(12):
        for n in sorted(app.store.tables):
            play_one(app, n)
    app.act("admin", "swiss_cut_ko", {"id": f})
    check(not app.store.queue, "the cut empties the Swiss queue")
    drain(app)
    check(not app.store.queue,
          "no knockout player gets dropped back into a queue nothing dispatches")
    check(not [m for m in app.store.matches.values()
               if m.format_id == f and m.status == "pending"
               and m.meta.get("phase") == "swiss"],
          "no stray Swiss fixtures survive the cut")
    shutil.rmtree(d)


def test_put_back_returns_players():
    print("\n[putting an open-play match back off its table]")
    app, d = fresh()
    solo_field(app, 10)
    f = app.act("admin", "add_format", {"kind": "open_play", "name": "Open",
        "config": {"mode": "singles"}})["format_id"]
    app.act("admin", "start_format", {"id": f})
    for e in entrant_ids(app):
        app.act("admin", "join_queue", {"entrant_id": e, "format_id": f})
    s = app.store
    m = [x for x in s.matches.values() if x.status == "live"][0]
    pair = [m.entrant_a, m.entrant_b]
    app.act("admin", "put_back", {"match_id": m.id})
    queued = {q.entrant_id for q in s.queue}
    playing = set()
    for t in s.tables.values():
        if t.match_id:
            mm = s.matches[t.match_id]
            playing |= {mm.entrant_a, mm.entrant_b}
    check(all(e in queued or e in playing for e in pair),
          "both players land back in the queue instead of vanishing")
    check(not [x for x in s.matches.values()
               if x.status == "pending" and x.format_id == f],
          "no un-seatable open-play match is left behind")
    shutil.rmtree(d)


def test_put_back_frees_the_table():
    print("\n[putting a scheduled fixture back gives the table to the next one]")
    app, d = fresh()
    solo_field(app, 16)
    f = app.act("admin", "add_format", {"kind": "groups", "name": "Main",
        "config": {"n_groups": 1, "then_ko": False},
        "entrant_ids": entrant_ids(app)})["format_id"]
    app.act("admin", "start_format", {"id": f})
    s = app.store
    first = s.tables[1].match_id
    app.act("admin", "put_back", {"match_id": first})
    # unseating alone put the identical fixture straight back on the same
    # table, because it was still the next one due
    check(s.tables[1].match_id != first, "the table goes to a different match")
    check(s.matches[first].status == "pending", "the put-back match is still to be played")
    check(s.matches[first].table is None, "and is not holding a table")
    check(s.matches[first].meta.get("deferred") == 1, "it is marked as put back once")

    order = app.store.formats[f].pending_fixtures(s)
    check(order and order[-1].id == first, "it sits at the back of the queue")

    app.act("admin", "put_back", {"match_id": s.tables[1].match_id})
    check(s.matches[first].meta.get("deferred") == 1, "putting another back leaves the first alone")

    # it must still get played rather than being lost
    drain(app)
    check(s.matches[first].status == "done", "a put-back match still gets played in the end")
    check(all(m.status == "done" for m in s.matches.values()
              if m.format_id == f and m.status != "void"),
          "and the draw finishes completely")
    shutil.rmtree(d)


def test_put_back_comes_round_again():
    print("\n[a put-back match returns when nothing else can use the table]")
    app, d = fresh()
    solo_field(app, 2)
    f = app.act("admin", "add_format", {"kind": "groups", "name": "Solo",
        "config": {"n_groups": 1, "then_ko": False},
        "entrant_ids": entrant_ids(app)})["format_id"]
    app.act("admin", "start_format", {"id": f})
    s = app.store
    mid = s.tables[1].match_id
    app.act("admin", "put_back", {"match_id": mid})
    check(s.matches[mid].meta.get("deferred") == 1, "it was put back once")
    # the only fixture there is, so the table has nothing else to offer and
    # it comes straight back rather than the evening stalling
    check(s.tables[1].match_id == mid,
          "with nothing else to play it comes round again by itself")
    app.act("admin", "put_back", {"match_id": mid})
    check(s.matches[mid].meta.get("deferred") == 2, "putting it back again counts again")
    drain(app)
    check(s.matches[mid].status == "done", "and it still gets played")
    shutil.rmtree(d)


def test_undo_unwinds_a_bracket():
    print("\n[undoing a result takes back what it decided]")
    app, d = fresh()
    solo_field(app, 4, 8.0, -1.0)
    f = app.act("admin", "add_format", {"kind": "single_elim", "name": "KO",
        "config": {}, "entrant_ids": entrant_ids(app)})["format_id"]
    app.act("admin", "start_format", {"id": f})
    s = app.store
    semi = [m for m in s.matches.values()
            if m.format_id == f and m.meta.get("round") == 0][0]
    app.act("referee", "report", {"match_id": semi.id, "games": [[11, 5], [11, 5]]})
    feeds = semi.meta["feeds"]
    advanced = getattr(s.matches[feeds[0]], "entrant_" + feeds[1])
    check(advanced is not None, "the winner went through to the next round")
    app.act("referee", "reopen_match", {"match_id": semi.id})
    check(getattr(s.matches[feeds[0]], "entrant_" + feeds[1]) is None,
          "undoing it takes that player back out of the next round")
    check(s.matches[semi.id].status in ("pending", "live"),
          "and the match can be played again")
    app.act("referee", "report", {"match_id": semi.id, "games": [[5, 11], [5, 11]]})
    check(getattr(s.matches[feeds[0]], "entrant_" + feeds[1]) not in (None, advanced),
          "re-scoring it sends the other player through")
    shutil.rmtree(d)


def test_correcting_a_result_in_place():
    print("\n[fixing a score without undoing it first]")
    app, d = fresh()
    solo_field(app, 4, 8.0, -1.0)
    f = app.act("admin", "add_format", {"kind": "single_elim", "name": "KO",
        "config": {}, "entrant_ids": entrant_ids(app)})["format_id"]
    app.act("admin", "start_format", {"id": f})
    s = app.store
    semi = [m for m in s.matches.values()
            if m.format_id == f and m.meta.get("round") == 0][0]
    app.act("referee", "report", {"match_id": semi.id, "games": [[11, 5], [11, 5]]})
    feeds = semi.meta["feeds"]
    before = getattr(s.matches[feeds[0]], "entrant_" + feeds[1])
    app.act("referee", "report", {"match_id": semi.id, "games": [[5, 11], [5, 11]]})
    check(getattr(s.matches[feeds[0]], "entrant_" + feeds[1]) != before,
          "entering it the right way round re-resolves the bracket")
    check(s.matches[semi.id].games == [[5, 11], [5, 11]], "the corrected score is stored")
    shutil.rmtree(d)


def test_housekeeping():
    print("\n[sitting out, removing a table, seating by hand]")
    app, d = fresh()
    solo_field(app, 12)
    f = app.act("admin", "add_format", {"kind": "open_play", "name": "Open",
        "config": {"mode": "singles"}})["format_id"]
    app.act("admin", "start_format", {"id": f})
    for e in entrant_ids(app):
        app.act("admin", "join_queue", {"entrant_id": e, "format_id": f})
    s = app.store
    waiting = [q.entrant_id for q in s.queue][0]
    app.act("admin", "update_player",
            {"id": s.entrants[waiting].player_ids[0], "active": False})
    check(not any(q.entrant_id == waiting for q in s.queue),
          "sitting a waiting player out takes them out of the queue")
    busy = s.busy_players()
    check(not [q for q in s.queue if not s.entrant_available(q.entrant_id, busy)],
          "no permanently blocked ghost rows are left in the queue")

    # A table with a live match on it can no longer be removed. It used to
    # be allowed and left the match with no table and no way to score it —
    # and, in a draw that pairs on demand, nothing that would ever pick it
    # up again. Free it first; that is one click either way.
    mid = s.tables[1].match_id
    refused = False
    try:
        app.act("admin", "remove_table", {"number": 1})
    except Exception:
        refused = True
    check(refused, "a table holding a live match cannot be removed")
    check(s.tables[1].match_id == mid, "and the match is still on it, scoreable")
    app.act("admin", "set_table", {"number": 1, "paused": True})
    app.act("admin", "put_back", {"match_id": mid})
    app.act("admin", "remove_table", {"number": 1})
    check(1 not in s.tables, "once it is free the table goes")

    cup = app.act("admin", "add_cup", {"name": "Cup A"})["cup_id"]
    app.act("admin", "set_table", {"number": 2, "cup_id": cup})
    pend = [m for m in s.matches.values() if m.status == "pending"]
    if pend:
        blocked = False
        try:
            app.act("admin", "assign", {"match_id": pend[0].id, "table": 2})
        except Exception:
            blocked = True
        check(blocked or s.tables[2].match_id != pend[0].id,
              "seating by hand respects another cup's reserved table")
    shutil.rmtree(d)


def test_table_split_and_share():
    print("\n[splitting tables between cups, and sharing them again]")
    app, d = fresh()
    ca = app.act("admin", "add_cup", {"name": "A"})["cup_id"]
    cb = app.act("admin", "add_cup", {"name": "B"})["cup_id"]
    app.act("admin", "split_tables", {"assignments": {"1": ca, "2": cb}})
    s = app.store
    check(s.tables[1].cup_id == ca and s.tables[2].cup_id == cb,
          "split assigns the tables it was given")
    check(s.tables[3].cup_id is None, "a table left out of the split stays shared")
    app.act("admin", "share_tables", {})
    check(all(t.cup_id is None for t in s.tables.values()),
          "sharing again clears every reservation")
    shutil.rmtree(d)


def test_phase():
    print("\n[event phase]")
    app, d = fresh()
    s = app.store
    check(s.phase() == "live",
          "an unscheduled event behaves exactly as it did before")

    soon = (datetime.now() + timedelta(days=3)).strftime("%Y-%m-%dT%H:%M")
    app.act("admin", "event_meta", {"starts_at": soon})
    check(s.phase() == "announced", "scheduled ahead with nothing open — announced")

    cid = app.act("admin", "add_cup", {"name": "Singles"})["cup_id"]
    app.act("admin", "update_cup", {"id": cid, "registration": "open"})
    check(s.phase() == "registration", "a cup taking entries — registration")

    past = (datetime.now() - timedelta(minutes=5)).strftime("%Y-%m-%dT%H:%M")
    app.act("admin", "event_meta", {"starts_at": past})
    check(s.phase() == "live", "the clock flips it on its own at the start time")

    app.act("admin", "set_phase", {"phase": "doors"})
    check(s.phase() == "doors" and s.shows_console(), "a pin outranks the clock")
    app.act("admin", "set_phase", {"phase": ""})
    check(s.phase() == "live", "clearing the pin hands it back to the clock")
    shutil.rmtree(d)


def test_public_payload():
    print("\n[the public payload]")
    app, d = fresh()
    app.act("admin", "event_meta", {"blurb": "Bats provided.", "venue": "Turnhalle"})
    app.act("admin", "add_cup", {"name": "Singles"})
    add_player(app, "Jana", 7)
    pub = app.public_state()
    flat = json.dumps(pub)
    check(pub["blurb"] == "Bats provided." and pub["venue"] == "Turnhalle",
          "carries what the landing page needs")
    check([c["name"] for c in pub["cups"]] == ["Singles"], "lists the cups")
    check("Jana" not in flat, "leaks no roster")
    check("strength" not in flat, "leaks no strengths")
    check(app.keys["admin"] not in flat, "leaks no keys")
    shutil.rmtree(d)


def test_new_event():
    print("\n[new event]")
    app, d = fresh()
    s = app.store
    add_pair(app, "a", 5, "b", 5)
    cid = app.act("admin", "add_cup", {"name": "Singles"})["cup_id"]
    app.act("admin", "update_cup", {"id": cid, "registration": "open"})
    fid = app.act("admin", "add_format",
                  {"kind": "open_play", "config": {"cup_id": cid}})["format_id"]
    app.act("admin", "update_cup", {"id": cid, "format_id": fid})
    app.act("admin", "set_table", {"number": 2, "name": "Far table", "cup_id": cid})
    before = s.seq

    app.act("admin", "new_event", {"name": "October open"})
    check(not s.players and not s.entrants, "players and teams cleared")
    check(not s.formats and not s.format_order, "formats cleared")
    check(not s.queue, "queue cleared")
    check(s.tables[2].name == "Far table", "tables carry forward")
    check(cid in s.cups and s.cups[cid].registration == "open",
          "cups carry forward with their registration setup")
    check(s.cups[cid].format_id is None, "the cup's dead format pointer was cleared")
    check(s.event["name"] == "October open" and s.event["id"], "the new event is named")
    check(s.seq > before, "nothing was deleted from the log")

    eid = s.event["id"]
    s.replay()
    check(s.event["id"] == eid and not s.players, "replay is deterministic across it")
    s.rewind(before)
    check(any(p.name == "a" for p in s.players.values()),
          "rewinding back past it restores the old event")
    shutil.rmtree(d)


def test_wizard():
    print("\n[the new-event wizard]")
    app, d = fresh()
    s = app.store

    # last month: a roster, a cup, a format, a reserved table
    add_pair(app, "a", 5, "b", 5)
    old_cup = app.act("admin", "add_cup", {"name": "Singles"})["cup_id"]
    app.act("admin", "add_format", {"kind": "swiss", "config": {"cup_id": old_cup}})
    app.act("admin", "set_table", {"number": 1, "name": "By the door"})

    out = app.act("admin", "create_event", {
        "name": "October open", "venue": "Turnhalle", "blurb": "Bats provided.",
        "starts_at": "2026-10-04T19:00",
        "cups": [
            {"name": "Singles cup", "entry": "single", "registration": "open",
             "blurb": "Five rounds.", "kind": "swiss",
             "config": {"rounds": 5, "paced": True, "continuous": True,
                        "scoring": {"best_of": 5, "points_to": 11}}},
            {"name": "Doubles cup", "entry": "pair", "registration": "closed",
             "kind": "groups", "config": {"n_groups": 2, "then_ko": True}},
        ],
        "tables": [{"name": "Table 1", "cup": -1}, {"name": "Table 2", "cup": 0},
                   {"name": "Table 3", "cup": 1}],
    })

    check(s.event["name"] == "October open" and s.event["venue"] == "Turnhalle",
          "the event is what the wizard was given")
    check(s.event["starts_at"] == "2026-10-04T19:00", "with its start time")
    check(not s.players and not s.entrants, "last month's roster is gone")
    check("Singles" not in [c.name for c in s.cups.values()],
          "and so are the cups it replaced — ids recycle, names do not lie")
    check([c.name for c in s.cups.values()] == ["Singles cup", "Doubles cup"],
          "the cups it was given exist, in order")

    a, b = out["cup_ids"]
    check(s.cups[a].registration == "open" and s.cups[a].entry == "single",
          "a cup keeps its entry setup")
    fa = s.formats[s.cups[a].format_id]
    check(fa.kind == "swiss" and fa.config["rounds"] == 5,
          "each cup got its format, configured")
    check(fa.config["scoring"]["best_of"] == 5, "including its scoring")
    check(s.cup_of_format(fa) == a, "and the format points back at its cup")
    check(fa.entrant_ids == [], "nobody is entered until the door")

    check(len(s.tables) == 3, "the tables it was given")
    check(s.cup_of_table(s.tables[1]) is None, "a shared table stays shared")
    check(s.cup_of_table(s.tables[2]) == a, "a reserved one is reserved")
    check(s.tables[1].name == "Table 1", "the old table name was replaced, not merged")

    check(s.phase() == "announced" or s.phase() == "registration",
          "a scheduled event comes up on the site, not the console")

    s.replay()
    check(len(s.cups) == 2 and s.event["name"] == "October open",
          "the whole thing replays from the log")
    shutil.rmtree(d)


def test_wizard_writes_ordinary_events():
    print("\n[the wizard is not a second config path]")
    app, d = fresh()
    app.act("admin", "create_event", {
        "name": "Test", "cups": [{"name": "Cup", "kind": "single_elim",
                                  "config": {"third_place": True}}],
        "tables": [{"name": "T1", "cup": 0}]})
    kinds = [h["type"] for h in app.store.history(40)]
    check(set(kinds) <= {"event_new", "cup_add", "format_add", "cup_update",
                         "table_set", "table_remove"},
          "it emits only the events the Setup tabs already emit")
    check("event_new" in kinds, "starting with the event_new marker")
    shutil.rmtree(d)


def test_site():
    print("\n[the site]")
    app, d = fresh()
    s = app.store
    app.act("admin", "create_event", {
        "name": "October open", "venue": "Turnhalle", "blurb": "Bats provided.",
        "starts_at": "2026-10-04T19:00",
        "cups": [{"name": "Singles cup", "entry": "single", "registration": "open",
                  "kind": "swiss", "config": {"rounds": 3,
                                              "scoring": {"best_of": 5, "points_to": 11}}}],
        "tables": [{"name": "Table 1", "cup": -1}, {"name": "Table 2", "cup": -1}]})

    pub = app.public_state()
    cup = pub["cups"][0]
    check(cup["format_line"] and cup["scoring"] == "Best of 5 to 11",
          "a cup explains its own format and scoring")
    check(pub["open"] is True, "the payload says entries are open")
    check("podium" not in cup, "no results while it has not been played")

    # play it out, then put the site back up
    eids = [add_pair(app, f"p{i}", 5, f"q{i}", 5) for i in range(4)]
    fid = s.cups[pub["cups"][0]["id"]].format_id
    app.act("admin", "start_format", {"id": fid, "entrant_ids": eids})
    drain(app)
    app.act("admin", "set_phase", {"phase": "done"})

    pub = app.public_state()
    podium = pub["cups"][0].get("podium") or []
    check(podium and podium[0]["place"] == 1, "afterwards the site says who won")
    check(all(p["name"] for p in podium), "with real names on it")
    check(len(podium) <= 3, "and stops at three")

    flat = json.dumps(pub)
    check(app.keys["admin"] not in flat and "strength" not in flat,
          "the results face leaks no more than the rest of it")
    shutil.rmtree(d)


def test_link_preview():
    print("\n[a pasted link]")
    app, d = fresh()
    Handler.app = app
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    port = srv.server_address[1]

    def get(path):
        c = http.client.HTTPConnection("127.0.0.1", port)
        c.request("GET", path)
        return c.getresponse().read().decode()

    app.act("admin", "create_event", {
        "name": "October open", "venue": "Turnhalle",
        "blurb": 'Bats & "everything" provided.',
        "starts_at": "2026-10-04T19:00", "cups": [], "tables": []})
    html = get("/")
    check("<title>October open</title>" in html, "the page is titled after the event")
    check('og:title" content="October open"' in html, "and carries a link-preview card")
    check("Turnhalle" in html and "October" in html,
          "with the date and venue in the description")
    check("&quot;everything&quot;" in html and '"everything"' not in html.split("og:description")[1][:200],
          "a blurb with quotes in it cannot break out of the tag")
    check("<!--META-->" not in html, "the placeholder is gone")

    poster = get("/print?mode=event&base=http%3A%2F%2Fx%2F")
    check("October open" in poster and "Turnhalle" in poster,
          "the noticeboard poster advertises the event")
    check("enter your name" in poster, "and says what the QR code is for")
    srv.shutdown()
    shutil.rmtree(d)


def test_registration():
    print("\n[registration]")
    app, d = fresh()
    s = app.store
    app.act("admin", "create_event", {
        "name": "October open", "starts_at": "2099-10-04T19:00",
        "cups": [{"name": "Singles", "entry": "single", "registration": "open",
                  "kind": "swiss", "config": {"rounds": 3}},
                 {"name": "Doubles", "entry": "pair", "registration": "open",
                  "kind": "groups", "config": {}},
                 {"name": "Veterans", "entry": "single", "registration": "closed",
                  "kind": "swiss", "config": {}}],
        "tables": [{"name": "T1", "cup": -1}]})
    singles, doubles, shut = [c["id"] for c in app.public_state()["cups"]]

    out = app.act("public", "register",
                  {"cup_id": singles, "name": "Jana Berger", "strength": 7,
                   "note": "Arriving a bit late."})
    r = s.registrations[out["registration_id"]]
    check(r.name == "Jana Berger" and r.strength == 7.0, "an entry is taken")
    check(r.status == "pending", "and sits pending")
    check(not s.players and not s.entrants,
          "it creates no player and no entrant — nothing the dispatcher sees")

    app.act("public", "register", {"cup_id": doubles, "kind": "pair",
                                   "name": "Ada", "partner_name": "Ben",
                                   "team_name": "Two Left Hands"})
    app.act("public", "register", {"cup_id": doubles, "kind": "seeking", "name": "Milo"})
    check(len(s.regs_for_cup(doubles)) == 2, "pairs and lone entrants both land")
    check(s.regs_for_cup(doubles)[1].kind == "seeking",
          "somebody without a partner says so")

    def refused(data, why):
        try:
            app.act("public", "register", data)
        except ValueError:
            return True
        print("   (accepted when it should not have:", why + ")")
        return False

    check(refused({"cup_id": shut, "name": "X"}, "closed cup"),
          "a cup that is not taking entries refuses")
    check(refused({"cup_id": singles, "name": "  "}, "blank name"),
          "so does a blank name")
    check(refused({"cup_id": "nope", "name": "X"}, "unknown cup"),
          "and an unknown cup")
    check(refused({"cup_id": doubles, "kind": "pair", "name": "A"}, "half a pair"),
          "a pair needs both names")

    # claims are claims: clamped and trimmed, never trusted
    out = app.act("public", "register",
                  {"cup_id": singles, "name": "  Spacey   Name  ", "strength": 99,
                   "note": "x" * 900})
    r = s.registrations[out["registration_id"]]
    check(r.strength == 10.0, "a silly strength is clamped, not believed")
    check(r.name == "Spacey Name", "whitespace is tidied")
    check(len(r.note) == 500, "the notes box has a ceiling")

    # entering a singles cup as a pair cannot smuggle a second player in
    out = app.act("public", "register", {"cup_id": singles, "kind": "pair",
                                         "name": "Solo", "partner_name": "Ghost"})
    check(s.registrations[out["registration_id"]].partner_name == "",
          "a singles cup takes one name however the form is filled in")

    check(app.public_state().get("registrations") is None
          and "Jana" not in json.dumps(app.public_state()),
          "the public payload gives no entry list away")
    check(len(app.state("admin")["registrations"]) == 5, "the admin sees them all")
    check(app.state("public")["registrations"] == [], "a spectator sees none")

    s.replay()
    check(len(s.registrations) == 5, "they replay from the log")
    shutil.rmtree(d)


def test_registration_closes():
    print("\n[registration and the clock]")
    app, d = fresh()
    s = app.store
    app.act("admin", "create_event", {
        "name": "E", "starts_at": "2099-10-04T19:00",
        "cups": [{"name": "Singles", "registration": "open", "kind": "swiss",
                  "config": {}}], "tables": []})
    cid = app.public_state()["cups"][0]["id"]
    app.act("admin", "set_phase", {"phase": "live"})
    ok = True
    try:
        app.act("public", "register", {"cup_id": cid, "name": "Late"})
        ok = False
    except ValueError:
        pass
    check(ok, "once the console is up the form stops taking entries")

    app.act("admin", "set_phase", {"phase": ""})
    app.act("public", "register", {"cup_id": cid, "name": "Early"})
    check(len(s.pending_regs()) == 1, "and takes them again when it is not")

    app.act("admin", "new_event", {"name": "Next one"})
    check(not s.registrations, "a new event does not inherit last event's entries")
    shutil.rmtree(d)


def test_registration_throttle():
    print("\n[the public write path has a ceiling]")
    app, d = fresh()
    Handler.app = app
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    port = srv.server_address[1]
    app.act("admin", "create_event", {
        "name": "E", "starts_at": "2099-10-04T19:00",
        "cups": [{"name": "Singles", "registration": "open", "kind": "swiss",
                  "config": {}}], "tables": []})
    cid = app.public_state()["cups"][0]["id"]

    def post(name):
        c = http.client.HTTPConnection("127.0.0.1", port)
        c.request("POST", "/api/action", json.dumps(
            {"op": "register", "data": {"cup_id": cid, "name": name}}),
            {"Content-Type": "application/json"})
        return c.getresponse().status

    codes = [post(f"P{i}") for i in range(9)]
    check(codes[0] == 200, "the first one goes through")
    check(429 in codes, "hammering it gets cut off")
    check(len(app.store.pending_regs()) == app.REG_BURST,
          "and no more than the burst was ever written")
    srv.shutdown()
    shutil.rmtree(d)


def door_event(app, entry="single", kind="swiss"):
    app.act("admin", "create_event", {
        "name": "October open", "starts_at": "2099-10-04T19:00",
        "cups": [{"name": "Cup", "entry": entry, "registration": "open",
                  "kind": kind, "config": {"rounds": 3}}],
        "tables": [{"name": "T1", "cup": -1}]})
    return app.public_state()["cups"][0]["id"]


def test_the_door():
    print("\n[the door]")
    app, d = fresh()
    s = app.store
    cup = door_event(app)
    rid = app.act("public", "register",
                  {"cup_id": cup, "name": "Jana Berger", "strength": 9})["registration_id"]

    out = app.act("admin", "admit", {"registration_id": rid, "strength": 7})
    check(s.registrations[rid].status == "confirmed", "confirming marks the entry")
    check(s.registrations[rid].entrant_id == out["entrant_id"],
          "and records what it became")
    e = s.entrants[out["entrant_id"]]
    check(e.name == "Jana Berger" and len(e.player_ids) == 1, "a player exists now")
    check(s.players[e.player_ids[0]].strength == 7.0,
          "at the strength the door set, not the one they claimed")
    f = s.formats[s.cups[cup].format_id]
    check(out["entrant_id"] in f.entrant_ids, "and they are in the draw")
    check(out["where"] == "entered", "which the door is told")

    ok = True
    try:
        app.act("admin", "admit", {"registration_id": rid})
        ok = False
    except ValueError:
        pass
    check(ok, "confirming twice is refused")

    # a walk-in is the same thing with no entry behind it
    out = app.act("admin", "admit", {"cup_id": cup, "name": "Ilya Marek", "strength": 6})
    check(out["where"] == "entered" and len(s.entrants) == 2,
          "a walk-in goes in the same way")
    check(not s.pending_regs(), "and leaves no phantom entry behind")
    shutil.rmtree(d)


def test_the_door_pairs():
    print("\n[the door, pairs]")
    app, d = fresh()
    s = app.store
    cup = door_event(app, entry="pair", kind="groups")
    rid = app.act("public", "register",
                  {"cup_id": cup, "kind": "pair", "name": "Ada", "strength": 6,
                   "partner_name": "Ben", "partner_strength": 4,
                   "team_name": "Two Left Hands"})["registration_id"]
    out = app.act("admin", "admit", {"registration_id": rid})
    e = s.entrants[out["entrant_id"]]
    check(len(e.player_ids) == 2, "a pair confirms as two players")
    check(e.name == "Two Left Hands", "under the name they gave themselves")
    check(sorted(s.players[i].strength for i in e.player_ids) == [4.0, 6.0],
          "each with their own strength")

    rid2 = app.act("public", "register",
                   {"cup_id": cup, "kind": "seeking", "name": "Milo"})["registration_id"]
    out = app.act("admin", "admit", {"registration_id": rid2,
                                     "kind": "pair", "partner_name": "Sofia"})
    check(len(s.entrants[out["entrant_id"]].player_ids) == 2,
          "somebody who wanted a partner can be paired up at the door")
    shutil.rmtree(d)


def test_the_door_after_the_draw_starts():
    print("\n[confirming late]")
    app, d = fresh()
    s = app.store
    cup = door_event(app, kind="single_elim")
    fid = s.cups[cup].format_id
    for n in ("A", "B", "C", "D"):
        app.act("admin", "admit", {"cup_id": cup, "name": n})
    app.act("admin", "start_format", {"id": fid})

    out = app.act("admin", "admit", {"cup_id": cup, "name": "Latecomer"})
    check(out["where"] == "roster", "a started knockout does not silently take them")
    check(out["why"], "and the door is told why")
    check(any(e.name == "Latecomer" for e in s.entrants.values()),
          "they are still in the roster, not dropped on the floor")
    shutil.rmtree(d)


def test_directory():
    print("\n[the club directory]")
    app, d = fresh()
    s = app.store
    cup = door_event(app)
    rid = app.act("public", "register",
                  {"cup_id": cup, "name": "Jana Berger", "strength": 9})["registration_id"]
    app.act("admin", "admit", {"registration_id": rid, "strength": 7})
    who = s.person_by_name("Jana Berger")
    check(who is not None, "confirming somebody adds them to the directory")
    check(who.strength == 7.0, "at the strength the door settled on")

    # tuning during the evening is what next month starts from
    pl = [p for p in s.players.values() if p.name == "Jana Berger"][0]
    app.act("admin", "update_player", {"id": pl.id, "strength": 8})
    check(s.people[who.id].strength == 8.0, "a strength tuned tonight writes back")

    app.act("admin", "new_event", {"name": "November open"})
    check(not s.players, "a new event clears the roster")
    check(s.person_by_name("Jana Berger").strength == 8.0,
          "but the directory outlives it, with the number still on it")

    out = app.act("admin", "add_from_directory", {"person_id": who.id})
    check(s.players[s.entrants[out["entrant_id"]].player_ids[0]].strength == 8.0,
          "adding her back starts from what we learned, not from five")
    check(s.person_playing(who.id) is not None, "and she counts as playing")

    ok = True
    try:
        app.act("admin", "add_from_directory", {"person_id": who.id})
        ok = False
    except ValueError:
        pass
    check(ok, "adding the same person twice is refused")

    check("  jana   BERGER " and s.person_by_name("  jana   BERGER ") is not None,
          "matching ignores case and stray spaces")
    check(s.person_by_name("J. Berger") is None,
          "and does not guess at near misses")

    flat = json.dumps(app.public_state())
    check("Jana" not in flat, "the directory never reaches the public page")
    check(len(app.state("admin")["people"]) >= 1, "the admin sees it")
    check(app.state("referee")["people"] == [], "a referee does not")
    shutil.rmtree(d)


def test_routing():
    print("\n[phase-driven root]")
    app, d = fresh()
    Handler.app = app
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    port = srv.server_address[1]

    def get(path):
        c = http.client.HTTPConnection("127.0.0.1", port)
        c.request("GET", path)
        r = c.getresponse()
        return r.status, r.read().decode()

    soon = (datetime.now() + timedelta(days=3)).strftime("%Y-%m-%dT%H:%M")
    app.act("admin", "event_meta", {"starts_at": soon})
    check("site.js" in get("/")[1], "the plain URL is the site before the doors open")
    check("app.js" in get("/a/" + app.keys["admin"])[1],
          "the admin link is the console whatever the phase")
    check("app.js" in get("/r/" + app.keys["referee"])[1],
          "so is the referee link")
    check("site.js" in get("/join")[1], "/join is the site")
    check(get("/api/public")[0] == 200, "/api/public answers")
    app.act("admin", "set_phase", {"phase": "live"})
    check("app.js" in get("/")[1], "once live the plain URL is the console")
    app.act("admin", "set_phase", {"phase": "done"})
    check("site.js" in get("/")[1], "afterwards the site comes back")
    srv.shutdown()
    shutil.rmtree(d)


def test_a_bad_event_never_reaches_the_log():
    """The log is the truth, so nothing that cannot be replayed may enter it.

    Committing before applying meant a payload the handler could not read
    was already written by the time it raised: the caller saw an error and
    assumed nothing had happened, and the store then refused to load on the
    next restart. Days later, in the hall."""
    print("\n[a bad event never reaches the log]")
    app, d = fresh()
    app.act("admin", "add_cup", {"name": "Singles"})
    good = app.store.seq

    # "cup_id" is not the key the handler reads; it wants "id"
    try:
        app.act("admin", "update_cup", {"cup_id": "C1", "registration": "open"})
        check(False, "a payload the handler cannot read is refused")
    except Exception:
        check(True, "a payload the handler cannot read is refused")

    check(app.store.seq == good, "and the log did not grow")
    rows = app.store.conn.execute(
        "SELECT COUNT(*) FROM events WHERE type='cup_update'").fetchone()[0]
    check(rows == 0, "nothing was written to take back")

    # the state it half-touched is still sound, and still writable
    app.act("admin", "update_cup", {"id": "C1", "registration": "open"})
    check(app.store.cups["C1"].registration == "open", "the correct call still works")

    # and the whole point: it still opens next time
    app.store.conn.close()
    reopened = App(d)
    check(reopened.store.cups["C1"].registration == "open",
          "and the store still replays from cold")
    shutil.rmtree(d)


def test_a_failed_cascade_is_all_or_nothing():
    """Applying can append — a result that ends a Swiss builds the knockout.
    Those inner writes belong to the outer one."""
    print("\n[a failed cascade leaves nothing behind]")
    app, d = fresh()
    app.act("admin", "add_cup", {"name": "Cup"})
    before = app.store.seq
    try:
        app.act("admin", "update_cup", {})          # no id at all
    except Exception:
        pass
    check(app.store.seq == before, "a throwing apply advances nothing")
    n = app.store.conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
    check(n == before, "and the log holds exactly what succeeded")
    shutil.rmtree(d)



def pool_event(app, cups=1, kind="swiss", config=None):
    app.act("admin", "create_event", {
        "name": "Pool night", "starts_at": "2099-10-04T19:00",
        "cups": [{"name": f"Cup {chr(65 + i)}", "entry": "single", "registration": "open",
                  "kind": kind, "config": config or {"continuous": True, "paced": True,
                                                     "rounds": 3}}
                 for i in range(cups)],
        "tables": [{"name": "T1", "cup": -1}, {"name": "T2", "cup": -1}]})
    return list(app.store.cup_order)


def admit(app, name, cup=None, **kw):
    return app.act("admin", "admit", {"name": name, "cup_id": cup, "kind": "single",
                                      "strength": 5, **kw})


def test_the_pool():
    print("\n[a cup has one list of people, and the draw is fed from it]")
    app, d = fresh()
    s = app.store
    (cup,) = pool_event(app)
    f = s.formats[s.cups[cup].format_id]

    # people arrive by every route before the draw starts: the door (a
    # registration), a walk-in, the directory, and add-by-hand
    reg = app.act("public", "register", {"cup_id": cup, "name": "Reg Ina", "strength": 5,
                                         "kind": "single"})["registration_id"]
    admit(app, "", cup, registration_id=reg)
    admit(app, "Walk Ulf", cup)
    app.act("admin", "add_player", {"name": "Hand Hedda", "strength": 5, "cup_id": cup})
    check(len(s.cup_pool(cup)) == 3, "every way in lands in the cup's pool")
    check(f.entrant_ids == s.cup_pool(cup), "and the draw reads the same list")

    app.act("admin", "start_format", {"id": f.id})
    check(sum(1 for t in s.tables.values() if t.match_id) == 1,
          "starting it seats a match straight away")
    playing = {x for t in s.tables.values() if t.match_id
               for x in (s.matches[t.match_id].entrant_a, s.matches[t.match_id].entrant_b)}
    waiting = {q.entrant_id for q in s.queue}
    check(playing | waiting == set(s.cup_pool(cup)),
          "everybody is either playing or waiting — nobody was left off the queue")

    admit(app, "Late Lena", cup)
    late = s.cup_pool(cup)[-1]
    on_a_table = {x for t in s.tables.values() if t.match_id
                  for x in (s.matches[t.match_id].entrant_a, s.matches[t.match_id].entrant_b)}
    check(late in f.entrant_ids and (late in {q.entrant_id for q in s.queue}
                                     or late in on_a_table),
          "somebody admitted mid-evening goes straight into the pairing pool")
    check(len(on_a_table) == 4, "and with a second free table they are paired at once")

    # finishing a match puts both back without anyone doing anything
    m = s.matches[[t.match_id for t in s.tables.values() if t.match_id][0]]
    app.act("referee", "report", {"match_id": m.id, "games": [[11, 5], [11, 5]]})
    back = {q.entrant_id for q in s.queue} | {
        x for t in s.tables.values() if t.match_id
        for x in (s.matches[t.match_id].entrant_a, s.matches[t.match_id].entrant_b)}
    check({m.entrant_a, m.entrant_b} <= back, "finishing a match returns both players to the pool")
    shutil.rmtree(d)


def test_the_pool_rules():
    print("\n[which cup — the one thing every way in has to say]")
    app, d = fresh()
    s = app.store
    a, b = pool_event(app, cups=2)
    for op, body in (("add_player", {"name": "X", "strength": 5}),
                     ("admit", {"name": "X", "kind": "single"})):
        try:
            app.act("admin", op, body)
            ok = False
        except ValueError:
            ok = True
        check(ok, f"{op} with two cups and no cup named is refused, not guessed")
    check(not s.players and not s.entrants,
          "and the refusal leaves nothing half-written behind")
    admit(app, "Ana", a)
    e = s.cup_pool(a)[0]
    fa, fb = (s.formats[s.cups[c].format_id] for c in (a, b))
    check(fa.entrant_ids == [e] and fb.entrant_ids == [], "each draw sees only its own cup")
    app.act("admin", "update_entrant", {"id": e, "cup_id": b})
    check(fa.entrant_ids == [] and fb.entrant_ids == [e],
          "moving somebody to the other cup moves them between the draws")
    shutil.rmtree(d)

    app, d = fresh()
    (only,) = pool_event(app)
    app.act("admin", "add_player", {"name": "Solo", "strength": 5})
    check(app.store.entrants["E1"].cup_id == only,
          "with exactly one cup there is nothing to ask")
    shutil.rmtree(d)


def test_resting_and_put_back():
    print("\n[resting, and putting a match back]")
    app, d = fresh()
    s = app.store
    (cup,) = pool_event(app, config={"continuous": True, "paced": False})
    for n in "ABCDEF":
        admit(app, n, cup)
    f = s.formats[s.cups[cup].format_id]
    app.act("admin", "start_format", {"id": f.id})
    waiting = [q.entrant_id for q in s.queue][0]
    app.act("referee", "set_resting", {"entrant_id": waiting})
    check(waiting not in {q.entrant_id for q in s.queue}, "resting takes somebody out of the queue")
    for _ in range(4):
        for n in sorted(s.tables):
            play_one(app, n)
    check(waiting not in {q.entrant_id for q in s.queue}
          and not any(waiting in (s.matches[t.match_id].entrant_a, s.matches[t.match_id].entrant_b)
                      for t in s.tables.values() if t.match_id),
          "and they stay out however many matches finish around them")
    app.act("referee", "set_resting", {"entrant_id": waiting, "resting": False})
    check(waiting in {q.entrant_id for q in s.queue} or any(
        waiting in (s.matches[t.match_id].entrant_a, s.matches[t.match_id].entrant_b)
        for t in s.tables.values() if t.match_id), "bringing them back puts them in the pool")

    old = s.tables[1].match_id
    out = app.act("admin", "put_back", {"match_id": old})
    check(out["reseated"] is False and s.tables[1].match_id != old,
          "putting a match back gives the table to somebody else when there is somebody")
    shutil.rmtree(d)

    app, d = fresh()
    s = app.store
    (cup,) = pool_event(app)
    admit(app, "P", cup); admit(app, "Q", cup)
    app.act("admin", "start_format", {"id": s.cups[cup].format_id})
    out = app.act("admin", "put_back", {"match_id": s.tables[1].match_id})
    check(out["reseated"] is True,
          "and says so when nobody else can play, instead of pretending they went away")
    shutil.rmtree(d)


def test_a_reset_draw_leaves_no_old_bracket():
    print("\n[a draw that was reset does not show its old bracket]")
    from tt.formats import bracket_view
    app, d = fresh()
    s = app.store
    (cup,) = pool_event(app, config={"continuous": True, "paced": True, "rounds": 3,
                                     "then_ko": True, "advance": 4})
    for n in "ABCDEF":
        admit(app, n, cup)
    f = s.formats[s.cups[cup].format_id]
    app.act("admin", "start_format", {"id": f.id})
    app.act("admin", "swiss_cut_ko", {"id": f.id})
    check(bracket_view(s, f.id) is not None, "a real bracket is shown")
    app.act("admin", "reset_format", {"id": f.id})
    check(bracket_view(s, f.id) is None, "a reset draw shows none")
    shutil.rmtree(d)


def test_the_board_shows_the_next_pairing():
    print("\n[coming up shows a pairing, not a list of strangers]")
    app, d = fresh()
    s = app.store
    (cup,) = pool_event(app)
    for n in "ABCDEF":
        admit(app, n, cup)
    app.act("admin", "start_format", {"id": s.cups[cup].format_id})
    rows = app.state("admin")["board"][0]["up"]
    check(rows and rows[0]["kind"] == "pairing" and rows[0]["b"],
          "the head of the list is the pair that will play next")
    check(all(r["kind"] != "waiting" or r["a"] not in (rows[0]["a"], rows[0]["b"]) for r in rows),
          "and nobody appears twice")
    seated = s.tables[1].match_id
    check(seated is not None, "sanity: a match is on a table")
    shutil.rmtree(d)


def test_merging_cups():
    print("\n[two thin cups folded into one at the last minute]")
    app, d = fresh()
    s = app.store
    a, b = pool_event(app, cups=2)
    app.act("admin", "split_tables", {"assignments": {"1": a, "2": b}})
    for n in ("Ana", "Ben"):
        admit(app, n, a)
    for n in ("Cleo", "Dan", "Eve"):
        admit(app, n, b)
    reg = app.act("public", "register", {"cup_id": b, "name": "Late Fritz", "strength": 5,
                                         "kind": "single"})["registration_id"]
    fb = s.cups[b].format_id
    app.act("admin", "merge_cups", {"from": b, "into": a})
    fa = s.formats[s.cups[a].format_id]
    check(b not in s.cups and fb not in s.formats, "the merged cup and its draw are gone")
    check(len(s.cup_pool(a)) == 5 and fa.entrant_ids == s.cup_pool(a),
          "everyone in it is in the other cup's pool, and its draw")
    check(s.registrations[reg].cup_id == a, "pre-registered entries follow them")
    check(s.tables[2].cup_id == a, "and so do the tables reserved for it")

    c = app.act("admin", "add_cup", {"name": "Doubles"})["cup_id"]
    app.act("admin", "update_cup", {"id": c, "entry": "pair"})
    for body, why in (({"from": c, "into": a}, "singles and pairs do not merge"),
                      ({"from": a, "into": a}, "a cup does not merge into itself")):
        try:
            app.act("admin", "merge_cups", body)
            ok = False
        except ValueError:
            ok = True
        check(ok, why)

    g = app.act("admin", "add_cup", {"name": "Late"})["cup_id"]
    admit(app, "Gus", g)
    app.act("admin", "start_format", {"id": fa.id})
    try:
        app.act("admin", "merge_cups", {"from": a, "into": g})
        ok = False
    except ValueError:
        ok = True
    check(ok and a in s.cups, "a cup that has started cannot be merged away")
    app.act("admin", "merge_cups", {"from": g, "into": a})
    check(s.entrants[s.cup_pool(a)[-1]].name == "Gus" and s.cup_pool(a)[-1] in fa.entrant_ids,
          "but a running Swiss can still take a cup folded into it")

# ------------------------------------------------- somebody goes home early
def test_withdrawal_walks_over_and_frees_the_table():
    print("\n[somebody goes home, mid-match]")
    app, d = fresh()
    cup = app.act("admin", "add_cup", {"name": "Cup"})["cup_id"]
    for i in range(10):
        add_player(app, f"W{i}", 9 - i * 0.4, cup)
    fid = app.act("admin", "add_format", {"kind": "swiss", "name": "S", "config": {
        "cup_id": cup, "rounds": 4, "continuous": False, "then_ko": True,
        "advance": 4, "scoring": {"best_of": 3, "points_to": 11}}})["format_id"]
    app.act("admin", "update_cup", {"id": cup, "format_id": fid})
    app.act("admin", "start_format", {"id": fid})
    s = app.store
    m = s.matches[s.tables[2].match_id]
    gone, opp = m.entrant_a, m.entrant_b
    out = app.act("admin", "withdraw", {"entrant_id": gone})
    check(out["walkovers"] == 1 and out["freed_tables"] == [2],
          "withdrawing says what it settled and which table it freed")
    check(m.status == "done" and m.winner == "b",
          "the match they were in is a walkover to the other side")
    check(m.meta.get("walkover") == gone,
          "and it is recorded as a walkover, not as a whitewash")
    check(s.tables[2].match_id and s.tables[2].match_id != m.id,
          "the table did not stand empty — it was reseated at once")
    check(gone not in s.cup_pool(cup), "they are out of the cup's pool")
    drain(app)
    f = s.formats[fid]
    check(f.is_complete(s) and f.phase == "ko", "the evening still finishes on its own")
    check(not any(gone in (x.entrant_a, x.entrant_b)
                  for x in s.matches.values() if x.meta.get("phase") == "ko"),
          "and they take no place in the bracket with them")
    row = next(r for r in f.standings(s)[0]["rows"] if r["entrant_id"] == gone)
    check(row["withdrawn"], "standings say they withdrew rather than quietly ranking them")
    check(len([x for x in s.matches.values()
               if x.status == "done" and opp in (x.entrant_a, x.entrant_b)]) >= 1,
          "their opponent keeps the matches they played")
    app.act("admin", "withdraw", {"entrant_id": gone, "withdrawn": False})
    check(gone in s.cup_pool(cup), "and it is reversible")
    shutil.rmtree(d)


def test_withdrawal_resolves_a_bracket():
    print("\n[somebody goes home with a bracket match outstanding]")
    app, d = fresh()
    cup = app.act("admin", "add_cup", {"name": "Cup"})["cup_id"]
    for i in range(8):
        add_player(app, f"K{i}", 9 - i * 0.4, cup)
    fid = app.act("admin", "add_format", {"kind": "single_elim", "name": "KO", "config": {
        "cup_id": cup, "scoring": {"best_of": 3, "points_to": 11}}})["format_id"]
    app.act("admin", "update_cup", {"id": cup, "format_id": fid})
    app.act("admin", "start_format", {"id": fid})
    s = app.store
    m = s.matches[s.tables[1].match_id]
    gone, opp = m.entrant_a, m.entrant_b
    app.act("admin", "withdraw", {"entrant_id": gone})
    nxt = s.matches[m.meta["feeds"][0]]
    check(opp in (nxt.entrant_a, nxt.entrant_b),
          "the walkover advances their opponent into the next round")
    drain(app)
    check(s.formats[fid].is_complete(s), "and the bracket plays itself out")
    shutil.rmtree(d)


# --------------------------------------------- resting means what it says
def test_resting_holds_a_scheduled_fixture():
    print("\n[sitting out holds a fixture instead of being ignored]")
    app, d = fresh()
    cup = app.act("admin", "add_cup", {"name": "Cup"})["cup_id"]
    for i in range(8):
        add_player(app, f"T{i}", 9 - i, cup)
    fid = app.act("admin", "add_format", {"kind": "groups", "name": "G", "config": {
        "cup_id": cup, "n_groups": 1, "advance_per_group": 2, "then_ko": False,
        "scoring": {"best_of": 3, "points_to": 11}}})["format_id"]
    app.act("admin", "update_cup", {"id": cup, "format_id": fid})
    app.act("admin", "start_format", {"id": fid})
    s = app.store
    seated = set()
    for t in s.tables.values():
        if t.match_id:
            seated |= {s.matches[t.match_id].entrant_a, s.matches[t.match_id].entrant_b}
    idle = [e for e in s.cup_pool(cup) if e not in seated][0]
    app.act("admin", "set_resting", {"entrant_id": idle, "resting": True})
    for _ in range(14):
        for n in sorted(s.tables):
            t = s.tables.get(n)
            if t and t.match_id:
                app.act("referee", "report", {"match_id": t.match_id,
                                              "games": [[11, 5], [11, 6]]})
    check(not [m for m in s.matches.values()
               if idle in (m.entrant_a, m.entrant_b) and m.status in ("live", "done")],
          "a rested player is not called to a group fixture behind their back")
    board = app.state("admin")["board"][0]
    name = s.entrant_name(idle)
    check(all(r["blocked"] for r in board["up"] if name in (r["a"], r["b"])),
          "and the board says why those fixtures are not moving")
    app.act("admin", "set_resting", {"entrant_id": idle, "resting": False})
    for _ in range(16):
        for n in sorted(s.tables):
            t = s.tables.get(n)
            if t and t.match_id:
                app.act("referee", "report", {"match_id": t.match_id,
                                              "games": [[11, 5], [11, 6]]})
    check(s.formats[fid].is_complete(s), "bringing them back finishes the group")
    shutil.rmtree(d)


# ------------------------------------- one human, two cups, one table each
def test_one_person_two_cups():
    print("\n[the same name in a singles cup and a doubles cup does not hold either up]")
    app, d = fresh()
    for t in (4, 5, 6):
        app.act("admin", "set_table", {"number": t, "name": f"T{t}"})
    c1 = app.act("admin", "add_cup", {"name": "Singles"})["cup_id"]
    c2 = app.act("admin", "add_cup", {"name": "Doubles"})["cup_id"]
    app.act("admin", "admit", {"cup_id": c1, "name": "Jana Berger", "strength": 7})
    app.act("admin", "admit", {"cup_id": c2, "name": "Jana Berger", "strength": 7,
                               "partner_name": "Tom Frei", "partner_strength": 6,
                               "kind": "pair"})
    for i in range(5):
        app.act("admin", "admit", {"cup_id": c1, "name": f"S{i}", "strength": 6})
    for i in range(3):
        app.act("admin", "admit", {"cup_id": c2, "name": f"D{i}", "strength": 6,
                                   "partner_name": f"E{i}", "partner_strength": 6,
                                   "kind": "pair"})
    s = app.store
    for cup in (c1, c2):
        fid = app.act("admin", "add_format", {"kind": "swiss", "name": "S", "config": {
            "cup_id": cup, "rounds": 4, "continuous": False,
            "scoring": {"best_of": 3, "points_to": 11}}})["format_id"]
        app.act("admin", "update_cup", {"id": cup, "format_id": fid})
        app.act("admin", "start_format", {"id": fid})
    dispatch.tick(s)
    jana = [p.id for p in s.players.values() if p.name.startswith("Jana")]
    on = [n for n, t in sorted(s.tables.items())
          if t.match_id and any(j in s.matches[t.match_id].players() for j in jana)]
    # a shared name across cups used to block one of them; organisers want
    # matches seated as they are queued, so both go on
    check(len(on) == 2, "both of her matches are seated, one per cup")
    drain(app)
    check(all(f.is_complete(s) for f in s.formats.values()),
          "and both cups still finish")
    shutil.rmtree(d)


# ---------------------------------------- Best of changed after the draw
def test_best_of_change_mid_event():
    print("\n[changing Best of mid-event reaches matches already drawn]")
    app, d = fresh()
    for t in (1, 2):
        app.act("admin", "set_table", {"number": t, "name": f"T{t}"})
    c = app.act("admin", "add_cup", {"name": "S"})["cup_id"]
    for i in range(6):
        app.act("admin", "admit", {"cup_id": c, "name": f"X{i}", "strength": 5})
    fid = app.act("admin", "add_format", {"kind": "swiss", "name": "S", "config": {
        "cup_id": c, "rounds": 3, "continuous": False,
        "scoring": {"best_of": 1, "points_to": 11}}})["format_id"]
    app.act("admin", "update_cup", {"id": c, "format_id": fid})
    app.act("admin", "start_format", {"id": fid})
    s = app.store
    dispatch.tick(s)
    first = next(m for m in s.matches.values() if m.status == "live")
    app.act("admin", "report", {"match_id": first.id, "games": [[11, 5]]})
    app.act("admin", "update_format", {"id": fid, "config": {
        "scoring": {"best_of": 3, "points_to": 11}}})
    open_ = [m for m in s.matches.values() if m.status in ("pending", "live")]
    check(open_ and all(m.scoring.best_of == 3 for m in open_),
          "unplayed matches take the new Best of")
    check(s.matches[first.id].scoring.best_of == 1,
          "a finished match keeps the rules it was played under")
    n = s.seq
    app.act("admin", "update_format", {"id": fid, "config": {
        "scoring": {"best_of": 3, "points_to": 11}}})
    check(not any(r[1] == "format_rescore" for r in s.conn.execute(
        "SELECT seq, type FROM events WHERE seq > ?", (n,))),
          "saving it again with nothing left to change logs nothing extra")
    s.replay()
    check(all(m.scoring.best_of == 3 for m in s.matches.values()
              if m.status in ("pending", "live"))
          and s.matches[first.id].status == "done",
          "and a restart replays it the same way")
    drain(app)
    check(all(f.is_complete(s) for f in s.formats.values()), "and the cup finishes")
    shutil.rmtree(d)


# ------------------------------- a correction that changes who qualified
def _groups_to_the_cut(app, cup, n=8):
    fid = app.act("admin", "add_format", {"kind": "groups", "name": "G", "config": {
        "cup_id": cup, "n_groups": 2, "advance_per_group": 2, "then_ko": True,
        "scoring": {"best_of": 3, "points_to": 11}}})["format_id"]
    app.act("admin", "update_cup", {"id": cup, "format_id": fid})
    app.act("admin", "start_format", {"id": fid})
    s = app.store
    left = lambda: [m for m in s.matches.values()
                    if m.meta.get("phase") == "groups" and m.status != "done"]
    while len(left()) > 1:
        for m in list(s.matches.values()):
            if m.meta.get("phase") == "groups" and m.status == "live":
                play_one(app, m.table)
                break
    for t in list(s.tables):                 # shut the hall before the cut,
        app.act("admin", "set_table", {"number": t, "paused": True})
    app.act("referee", "report", {"match_id": left()[0].id,
                                  "games": [[11, 6], [11, 8]]})
    return fid


def test_a_correction_redraws_an_unplayed_bracket():
    print("\n[a group score put right after the cut]")
    app, d = fresh()
    cup = app.act("admin", "add_cup", {"name": "Cup"})["cup_id"]
    for i, st in enumerate([9, 8, 7, 6, 5, 4, 3, 2]):
        add_player(app, f"C{i}", st, cup)
    fid = _groups_to_the_cut(app, cup)
    s, f = app.store, app.store.formats[fid]
    check(f.phase == "ko", "the bracket is drawn")
    drawn = list(f.config["ko_seeds"])
    # re-enter group scores the other way round until one of them actually
    # changes who goes through — which one depends on how the night fell
    changed = None
    for m in sorted((x for x in s.matches.values()
                     if x.meta.get("phase") == "groups" and x.status == "done"),
                    key=lambda x: x.seq):
        before = m.winner
        app.act("referee", "report", {"match_id": m.id,
            "games": [[0, 11], [0, 11]] if before == "a" else [[11, 0], [11, 0]]})
        if f._qualifiers(s) != drawn:
            changed = m
            break
    check(changed is not None, "a corrected group score can change who qualifies")
    check(list(f.config["ko_seeds"]) == f._qualifiers(s),
          "putting the score right redraws the bracket around who qualified now")
    check(not f.bracket_stale(s), "and the draw and the table agree again")
    for t in list(s.tables):
        app.act("admin", "set_table", {"number": t, "paused": False})
    drain(app)
    check(f.is_complete(s), "the redrawn bracket plays out")
    shutil.rmtree(d)


def test_a_late_correction_is_reported_not_forced():
    print("\n[the same correction, once the knockout is under way]")
    app, d = fresh()
    cup = app.act("admin", "add_cup", {"name": "Cup"})["cup_id"]
    for i, st in enumerate([9, 8, 7, 6, 5, 4, 3, 2]):
        add_player(app, f"L{i}", st, cup)
    fid = _groups_to_the_cut(app, cup)
    s, f = app.store, app.store.formats[fid]
    for t in list(s.tables):
        app.act("admin", "set_table", {"number": t, "paused": False})
    play_one(app, 1)                                   # a knockout match played
    seeds_before = list(f.config["ko_seeds"])
    rows = f.standings(s)[0]["rows"]
    second, third = rows[1]["entrant_id"], rows[2]["entrant_id"]
    m = next((x for x in s.matches.values()
              if x.meta.get("phase") == "groups" and x.status == "done"
              and {x.entrant_a, x.entrant_b} == {second, third}), None)
    if m:
        app.act("referee", "report", {"match_id": m.id,
            "games": [[0, 11], [0, 11]] if m.entrant_a == second else [[11, 0], [11, 0]]})
        check(list(f.config["ko_seeds"]) == seeds_before,
              "a bracket people are already playing in is not torn up under them")
        check(f.bracket_stale(s), "it is flagged for the organiser instead")
        check(any(x["bracket_stale"] for x in app.state("admin")["formats"]),
              "and the flag reaches the console")
    drain(app)
    check(f.is_complete(s), "the evening still finishes")
    shutil.rmtree(d)


# ----------------------------------------------- brackets of awkward sizes
def test_third_place_with_an_odd_bracket():
    print("\n[third place, in a bracket that has a bye in the semis]")
    app, d = fresh()
    cup = app.act("admin", "add_cup", {"name": "Cup"})["cup_id"]
    for i, st in enumerate([8, 6, 4]):
        add_player(app, f"B{i}", st, cup)
    fid = app.act("admin", "add_format", {"kind": "single_elim", "name": "KO", "config": {
        "cup_id": cup, "third_place": True,
        "scoring": {"best_of": 3, "points_to": 11}}})["format_id"]
    app.act("admin", "update_cup", {"id": cup, "format_id": fid})
    app.act("admin", "start_format", {"id": fid})
    drain(app)
    s, f = app.store, app.store.formats[fid]
    check(not [m for m in s.matches.values()
               if m.status != "void" and not m.is_filled()],
          "no half-filled play-off is left that nothing can ever fill")
    check(f.is_complete(s), "and the draw reads as finished")
    shutil.rmtree(d)


def test_the_podium_names_the_actual_winner():
    print("\n[who the results page says won]")
    app, d = fresh()
    cup = app.act("admin", "add_cup", {"name": "Cup"})["cup_id"]
    for i, st in enumerate([9, 7, 5, 3]):
        add_player(app, f"F{i}", st, cup)
    fid = app.act("admin", "add_format", {"kind": "single_elim", "name": "KO", "config": {
        "cup_id": cup, "third_place": True,
        "scoring": {"best_of": 3, "points_to": 11}}})["format_id"]
    app.act("admin", "update_cup", {"id": cup, "format_id": fid})
    app.act("admin", "start_format", {"id": fid})
    drain(app)
    s, f = app.store, app.store.formats[fid]
    final = next(m for m in s.matches.values()
                 if m.meta.get("round_name") == "Final")
    won = s.entrant_name(final.entrant_a if final.winner == "a" else final.entrant_b)
    pod = app._podium(f)
    check(pod[0]["name"] == won,
          "the winner of the final, not the winner of the third-place match")
    third = next(m for m in s.matches.values()
                 if m.meta.get("round_name") == "Third place")
    check(pod[2]["name"] == s.entrant_name(
              third.entrant_a if third.winner == "a" else third.entrant_b),
          "and third place is third")
    shutil.rmtree(d)


# ------------------------------------- a fixture nothing would pick up again
def test_an_undone_result_is_not_an_orphan():
    print("\n[undoing a result in a draw that pairs on demand]")
    app, d = fresh()
    cup = app.act("admin", "add_cup", {"name": "Cup"})["cup_id"]
    for i in range(8):
        add_player(app, f"O{i}", 9 - i * 0.4, cup)
    fid = app.act("admin", "add_format", {"kind": "swiss", "name": "S", "config": {
        "cup_id": cup, "rounds": 4, "continuous": True, "paced": True,
        "then_ko": True, "advance": 4,
        "scoring": {"best_of": 3, "points_to": 11}}})["format_id"]
    app.act("admin", "update_cup", {"id": cup, "format_id": fid})
    app.act("admin", "start_format", {"id": fid})
    s = app.store
    m = s.matches[s.tables[1].match_id]
    app.act("referee", "report", {"match_id": m.id, "games": [[11, 5], [11, 7]]})
    app.act("referee", "reopen_match", {"match_id": m.id})
    drain(app)
    f = s.formats[fid]
    check(m.status == "done", "the match comes back round and gets played again")
    check(f.phase == "ko" and f.is_complete(s),
          "and the cut to the knockout still happens")
    shutil.rmtree(d)


# --------------------------------------------- saying so before it bites
def test_a_paced_swiss_says_when_it_cannot_come_out_even():
    print("\n[a draw that warns instead of quietly stopping]")
    app, d = fresh()
    cup = app.act("admin", "add_cup", {"name": "Cup"})["cup_id"]
    for i in range(9):
        add_player(app, f"N{i}", 9 - i * 0.4, cup)
    fid = app.act("admin", "add_format", {"kind": "swiss", "name": "S", "config": {
        "cup_id": cup, "rounds": 5, "continuous": True, "paced": True,
        "then_ko": True, "advance": 4,
        "scoring": {"best_of": 3, "points_to": 11}}})["format_id"]
    app.act("admin", "update_cup", {"id": cup, "format_id": fid})
    app.act("admin", "start_format", {"id": fid})
    s, f = app.store, app.store.formats[fid]
    check(any("cannot come out even" in w for w in f.warnings(s)),
          "nine over five rounds is flagged the moment the draw starts")
    drain(app)
    check(f.phase == "ko", "it reaches its knockout anyway rather than stopping dead")
    short = f.short_of_budget(s)
    check(len(short) == 1, "exactly one of them is a game short, as the arithmetic says")
    check(any("finished a game short" in w for w in f.warnings(s)),
          "and the console says who, rather than leaving it to be noticed")
    check(any(x["warnings"] for x in app.state("admin")["formats"]),
          "the console is told")
    check(f.is_complete(s), "the evening finishes on its own")
    shutil.rmtree(d)


def test_an_even_round_count_does_not_warn():
    print("\n[the same field over an even number of rounds]")
    app, d = fresh()
    cup = app.act("admin", "add_cup", {"name": "Cup"})["cup_id"]
    for i in range(9):
        add_player(app, f"M{i}", 9 - i * 0.4, cup)
    fid = app.act("admin", "add_format", {"kind": "swiss", "name": "S", "config": {
        "cup_id": cup, "rounds": 4, "continuous": True, "paced": True,
        "then_ko": True, "advance": 4,
        "scoring": {"best_of": 3, "points_to": 11}}})["format_id"]
    app.act("admin", "update_cup", {"id": cup, "format_id": fid})
    app.act("admin", "start_format", {"id": fid})
    s, f = app.store, app.store.formats[fid]
    check(not f.warnings(s), "nothing to warn about")
    drain(app)
    check(f.phase == "ko" and f.is_complete(s),
          "and it reaches its knockout on its own")
    shutil.rmtree(d)


def test_too_many_groups_is_flagged():
    print("\n[more groups than the field can fill]")
    app, d = fresh()
    cup = app.act("admin", "add_cup", {"name": "Cup"})["cup_id"]
    for i in range(5):
        add_player(app, f"G{i}", 9 - i, cup)
    fid = app.act("admin", "add_format", {"kind": "groups", "name": "G", "config": {
        "cup_id": cup, "n_groups": 4, "advance_per_group": 2, "then_ko": True,
        "scoring": {"best_of": 3, "points_to": 11}}})["format_id"]
    app.act("admin", "update_cup", {"id": cup, "format_id": fid})
    dispatch.tick(app.store)
    f = app.store.formats[fid]
    check(any("nobody to play" in w for w in f.warnings(app.store)),
          "five in four groups is flagged before the draw is ever started")
    shutil.rmtree(d)


# ------------------------------------------------------------------ sandbox

def sim_event(app, kind="groups", entry="single", config=None, tables=3):
    app.act("admin", "create_event", {
        "name": "Thursday",
        "cups": [{"name": "Open", "entry": entry, "kind": kind,
                  "config": config or {"n_groups": 4, "then_ko": True}}],
        "tables": [{"name": f"Table {n}"} for n in range(1, tables + 1)]})


def test_the_sandbox_copies_the_shape_and_none_of_the_people():
    print("\n[sandbox]")
    app, d = fresh()
    sim_event(app)
    add_player(app, "Real Person", 6)
    before = app.store.seq

    sb = simulate.build(app, App, per_cup=12, rounds=3, seed=5)
    s = sb.app.store
    check(app.store.seq == before, "nothing about building one reaches the live log")
    check(len(app.store.entrants) == 1, "the live event still has only its own entrant")
    check(sb.app.store.db_path != app.store.db_path, "and it is a different file")

    check(len(s.cups) == 1 and s.cups[list(s.cups)[0]].name == "Open",
          "the sandbox has the same cup")
    check(len(s.tables) == 3, "and the same tables")
    check([e.name for e in s.entrants.values()].count("Real Person") == 0,
          "and nobody real in it")
    check(len(s.entrants) == 12, "twelve made-up entrants went in")
    f = s.formats[s.format_order[0]]
    check(f.status == "running", "the draw is under way")
    check(simulate.rounds_played(s, f) == 3, "three rounds deep")
    check(any(t.match_id for t in s.tables.values()), "with matches still on the tables")
    sb.close()
    shutil.rmtree(d)


def test_the_sandbox_looks_like_time_passed():
    """The board's times are the median of what matches actually took, so a
    sandbox where every match started and finished at the same instant is
    the one thing it must not be."""
    print("\n[sandbox clock]")
    app, d = fresh()
    sim_event(app)
    sb = simulate.build(app, App, per_cup=12, rounds=3, seed=5)
    s = sb.app.store
    med = s.median_match_seconds()
    check(300 < med < 1500, f"a match took about as long as a match does ({round(med)}s)")
    now = time.time()
    done = [m for m in s.matches.values() if m.status == "done"]
    check(all(m.done_ts <= now + 1 for m in done), "and the evening ends now, not later")
    check(max(m.done_ts for m in done) > now - 1800,
          "with the last result a few minutes old")
    live = [m for m in s.matches.values() if m.status == "live"]
    check(live and all(0 <= now - m.started_ts < 3600 for m in live),
          "and whatever is on a table started within the hour")
    sb.close()
    shutil.rmtree(d)


def test_every_format_stops_where_it_was_told():
    print("\n[sandbox rounds]")
    for kind, cfg, entry in (
            ("open_play", {"mode": "singles"}, "single"),
            ("groups", {"n_groups": 4, "then_ko": True}, "single"),
            ("single_elim", {"third_place": True}, "single"),
            ("swiss", {"rounds": 5}, "single"),
            ("swiss", {"rounds": 5, "continuous": True, "paced": True}, "pair"),
    ):
        app, d = fresh()
        sim_event(app, kind=kind, entry=entry, config=cfg)
        sb = simulate.build(app, App, per_cup=16, rounds=3, seed=9)
        s = sb.app.store
        f = s.formats[s.format_order[0]]
        what = f"{kind}{' in pairs' if entry == 'pair' else ''}"
        n = simulate.rounds_played(s, f)
        check(n == 3, f"{what} stopped 3 rounds in, at {n}")
        check(len(s.entrants) == 16, f"{what} got its 16 entrants")
        sb.close()
        shutil.rmtree(d)


def test_the_sandbox_is_reachable_only_by_asking_for_it():
    print("\n[sandbox routing]")
    app, d = fresh()
    sim_event(app)
    Handler.app = app
    srv = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    port = srv.server_address[1]
    key = app.keys["admin"]

    def call(method, path, body=None):
        c = http.client.HTTPConnection("127.0.0.1", port)
        h = {"X-Key": key}
        if body is not None:
            h["Content-Type"] = "application/json"
        c.request(method, path, json.dumps(body) if body is not None else None, h)
        r = c.getresponse()
        raw = r.read()
        try:
            return r.status, json.loads(raw)
        except Exception:
            return r.status, raw.decode()

    check(call("GET", "/api/state?sim=1")[0] == 404,
          "asking for a sandbox that is not there is a 404, never the real event")
    check(call("POST", "/api/action",
               {"op": "sim_start", "data": {"per_cup": 8, "rounds": 2}})[0] == 200,
          "an admin can build one")
    sim = call("GET", "/api/state?sim=1")[1]
    live = call("GET", "/api/state")[1]
    check(len(sim["entrants"]) == 8 and not live["entrants"],
          "the flagged request gets the sandbox and the plain one does not")
    check(live["sim"]["running"] and sim["sim"]["is_sim"],
          "each one says which it is")

    seq = live["seq"]
    m = next(t["match"] for t in sim["tables"] if t["match"])
    check(call("POST", "/api/action?sim=1",
               {"op": "report", "data": {"match_id": m["id"],
                                         "games": [[11, 3], [11, 5]]}})[0] == 200,
          "a result can be entered in the sandbox")
    check(call("GET", "/api/state")[1]["seq"] == seq,
          "and the live log did not move")
    check(call("POST", "/api/action?sim=1", {"op": "sim_start", "data": {}})[0] == 400,
          "there is no sandbox inside the sandbox")
    check(call("POST", "/api/action", {"op": "sim_stop", "data": {}})[0] == 200
          and call("GET", "/api/state?sim=1")[0] == 404,
          "stopping it takes it away")
    srv.shutdown()
    shutil.rmtree(d)


def test_nobody_in_a_sandbox_shares_a_name():
    """Two people with the same name is refused at the door, for a good
    reason — it is how the wrong strength ends up on the wrong person — so a
    generated field that draws one twice does not fail the draw, it fails the
    build. The hat is small and the fields are not."""
    print("\n[sandbox names]")
    app, d = fresh()
    app.act("admin", "create_event", {
        "name": "Big",
        "cups": [{"name": f"Cup {i}", "entry": "pair" if i % 2 else "single",
                  "kind": "swiss", "config": {"rounds": 5}} for i in range(3)],
        "tables": [{"name": f"Table {n}"} for n in range(1, 5)]})
    sb = simulate.build(app, App, per_cup=32, rounds=1, seed=2)
    names = [p.name for p in sb.app.store.players.values()]
    check(len(names) == 128, f"a big field went in whole ({len(names)} players)")
    check(len(set(names)) == len(names), "and no two of them are the same person")
    sb.close()
    shutil.rmtree(d)


def test_a_sandbox_needs_something_to_copy():
    print("\n[sandbox with nothing to copy]")
    app, d = fresh()
    try:
        simulate.build(app, App)
        check(False, "an empty event refuses")
    except ValueError as e:
        check("nothing to simulate" in str(e), f"an empty event refuses: {e}")
    shutil.rmtree(d)


def test_three_cups_sharing_tables_all_finish():
    """The evening this is actually for: a singles cup and two doubles cups,
    all Swiss into a knockout, contending for one pool of tables."""
    print("\n[one singles and two doubles cups, sharing six tables]")
    app, d = fresh()
    for t in (4, 5, 6):
        app.act("admin", "set_table", {"number": t, "name": f"Table {t}"})
    cups = [app.act("admin", "add_cup", {"name": n})["cup_id"]
            for n in ("Singles", "Doubles A", "Doubles B")]
    for i in range(14):
        app.act("admin", "admit", {"cup_id": cups[0], "name": f"S{i}",
                                   "strength": 8 - i * 0.4})
    for ci, cup in ((0, cups[1]), (1, cups[2])):
        for i in range(6):
            app.act("admin", "admit", {
                "cup_id": cup, "kind": "pair", "name": f"{'AB'[ci]}{i}a",
                "strength": 7 - i * 0.5, "partner_name": f"{'AB'[ci]}{i}b",
                "partner_strength": 6 - i * 0.4})
    # one person playing in the singles and in a doubles cup
    app.act("admin", "admit", {"cup_id": cups[0], "name": "Jana Berger",
                               "strength": 7})
    app.act("admin", "admit", {"cup_id": cups[1], "kind": "pair",
                               "name": "Jana Berger", "strength": 7,
                               "partner_name": "Tom Frei", "partner_strength": 6})
    s = app.store
    for cup in cups:
        fid = app.act("admin", "add_format", {"kind": "swiss", "name": "Swiss",
            "config": {"cup_id": cup, "rounds": 4, "continuous": False,
                       "then_ko": True, "advance": 4, "third_place": True,
                       "scoring": {"best_of": 5, "points_to": 11}}})["format_id"]
        app.act("admin", "update_cup", {"id": cup, "format_id": fid})
        app.act("admin", "start_format", {"id": fid})
    # somebody goes home part-way through
    for _ in range(6):
        for n in sorted(s.tables):
            play_one(app, n)
    victim = [m for m in s.matches.values() if m.status == "live"][0].entrant_a
    app.act("admin", "withdraw", {"entrant_id": victim})
    drain(app)
    check(all(f.is_complete(s) for f in s.formats.values()),
          "all three cups finish, with a withdrawal in the middle of it")
    check(all(f.phase == "ko" for f in s.formats.values()),
          "each one crossed into its knockout by itself")
    check(not [m for m in s.matches.values() if m.status in ("pending", "live")],
          "and nothing is left hanging")
    for f in s.formats.values():
        pod = app._podium(f)
        check(len(pod) >= 2, f"{s.cups[f.cup_id()].name} has a winner and a runner-up")
    before = sorted((m.id, m.status, m.winner) for m in s.matches.values())
    s.replay()
    check(before == sorted((m.id, m.status, m.winner) for m in s.matches.values()),
          "the whole evening replays identically")
    shutil.rmtree(d)
def test_the_door_flags_a_name_already_playing():
    print("\n[a name that is already on tonight's roster]")
    app, d = fresh()
    c1 = app.act("admin", "add_cup", {"name": "Singles"})["cup_id"]
    c2 = app.act("admin", "add_cup", {"name": "Doubles"})["cup_id"]
    first = app.act("admin", "admit", {"cup_id": c1, "name": "Jana Berger",
                                       "strength": 6})
    check(not first["already"], "the first Jana Berger is unremarkable")
    again = app.act("admin", "admit", {"cup_id": c1, "name": "Jana Berger",
                                       "strength": 6})
    check(again["already"] == ["Jana Berger"],
          "a second one is flagged rather than quietly admitted twice")
    across = app.act("admin", "admit", {
        "cup_id": c2, "kind": "pair", "name": "Jana Berger", "strength": 6,
        "partner_name": "Tom Frei", "partner_strength": 5})
    check(across["already"] == ["Jana Berger"],
          "and flagged across cups too, where it matters most")
    other = app.act("admin", "admit", {"cup_id": c1, "name": "Bo Lind",
                                       "strength": 5})
    check(not other["already"], "somebody new is not")
    shutil.rmtree(d)


if __name__ == "__main__":
    test_open_play()
    test_scramble()
    test_groups_ko()
    test_single_elim_byes()
    test_swiss()
    test_parallel()
    test_replay_and_undo()
    test_cups_and_tables()
    test_format_cleanup()
    test_swiss_ko()
    test_swiss_cut_ko()
    test_swiss_respects_sitout()
    test_permissions()
    test_fair_cup_share()
    test_swiss_does_not_outrun_a_bigger_cup()
    test_paced_swiss_keeps_the_field_level()
    test_swiss_ko_drops_the_queue()
    test_put_back_returns_players()
    test_put_back_frees_the_table()
    test_put_back_comes_round_again()
    test_undo_unwinds_a_bracket()
    test_correcting_a_result_in_place()
    test_housekeeping()
    test_table_split_and_share()
    test_phase()
    test_public_payload()
    test_new_event()
    test_wizard()
    test_wizard_writes_ordinary_events()
    test_site()
    test_link_preview()
    test_registration()
    test_registration_closes()
    test_registration_throttle()
    test_the_door()
    test_the_door_pairs()
    test_the_door_after_the_draw_starts()
    test_directory()
    test_routing()
    test_a_bad_event_never_reaches_the_log()
    test_a_failed_cascade_is_all_or_nothing()
    test_the_pool()
    test_the_pool_rules()
    test_merging_cups()
    test_resting_and_put_back()
    test_a_reset_draw_leaves_no_old_bracket()
    test_the_board_shows_the_next_pairing()
    test_withdrawal_walks_over_and_frees_the_table()
    test_withdrawal_resolves_a_bracket()
    test_resting_holds_a_scheduled_fixture()
    test_one_person_two_cups()
    test_best_of_change_mid_event()
    test_a_correction_redraws_an_unplayed_bracket()
    test_a_late_correction_is_reported_not_forced()
    test_third_place_with_an_odd_bracket()
    test_the_podium_names_the_actual_winner()
    test_an_undone_result_is_not_an_orphan()
    test_a_paced_swiss_says_when_it_cannot_come_out_even()
    test_lowering_the_round_count_cuts_off()
    test_an_even_round_count_does_not_warn()
    test_too_many_groups_is_flagged()
    test_three_cups_sharing_tables_all_finish()
    test_the_sandbox_copies_the_shape_and_none_of_the_people()
    test_the_sandbox_looks_like_time_passed()
    test_every_format_stops_where_it_was_told()
    test_the_sandbox_is_reachable_only_by_asking_for_it()
    test_nobody_in_a_sandbox_shares_a_name()
    test_a_sandbox_needs_something_to_copy()
    print("\nall good\n")
