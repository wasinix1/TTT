"""Plays complete events through every format and checks the invariants."""

import http.client, json, os, random, shutil, sys, tempfile, threading
from datetime import datetime, timedelta
from http.server import ThreadingHTTPServer
from tt.server import App, Handler
from tt import dispatch

random.seed(7)


def fresh():
    d = tempfile.mkdtemp()
    return App(d), d


def add_player(app, name, s):
    return app.act("admin", "add_player", {"name": name, "strength": s, "solo": True})["player_id"]


def add_pair(app, n1, s1, n2, s2, label=None):
    return app.act("admin", "add_team",
                   {"name": label, "members": [[n1, s1], [n2, s2]]})["entrant_id"]


def play_one(app, table_no, upset=0.15):
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
    if random.random() < upset:
        a_better = not a_better
    need = m.scoring.games_to_win()
    games, wa, wb = [], 0, 0
    while wa < need and wb < need:
        a_wins = random.random() < (0.68 if a_better else 0.32)
        top = m.scoring.points_to
        lose = random.choice([3, 5, 7, 8, 9, 9])
        if lose == 9 and random.random() < 0.35:        # deuce
            top, lose = m.scoring.points_to + 2, m.scoring.points_to
        games.append([top, lose] if a_wins else [lose, top])
        wa += a_wins
        wb += not a_wins
    app.act("referee", "report", {"match_id": m.id, "games": games})
    return True


def drain(app, limit=600):
    """Play until no table has a match."""
    for _ in range(limit):
        played = any(play_one(app, n) for n in sorted(app.store.tables))
        if not played:
            return
    raise AssertionError("did not settle")


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

    a_ents = [add_pair(app, f"A{i}a", 5, f"A{i}b", 5, f"A{i}") for i in range(6)]
    b_ents = [add_pair(app, f"B{i}a", 5, f"B{i}b", 5, f"B{i}") for i in range(6)]
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


def test_fair_cup_share():
    print("\n[two cups sharing tables get served fairly]")
    app, d = fresh()
    ca = app.act("admin", "add_cup", {"name": "Cup A"})["cup_id"]
    cb = app.act("admin", "add_cup", {"name": "Cup B"})["cup_id"]
    solo_field(app, 16)
    es = entrant_ids(app)
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
    big = app.act("admin", "add_cup", {"name": "Big"})["cup_id"]
    small = app.act("admin", "add_cup", {"name": "Small"})["cup_id"]
    solo_field(app, 20)
    es = entrant_ids(app)
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
    check(not [e for q in app.state("admin")["queues"]
               for e in q["entries"] if e["blocked"]],
          "no permanently blocked ghost rows are left in the queue")

    mid = s.tables[1].match_id
    app.act("admin", "remove_table", {"number": 1})
    check(s.matches[mid].status != "live",
          "removing a table does not strand its match as unscoreable")

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
    print("\nall good\n")
