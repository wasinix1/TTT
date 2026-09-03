"""Plays complete events through every format and checks the invariants."""

import os, random, shutil, sys, tempfile
from tt.server import App
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
    print("\nall good\n")
