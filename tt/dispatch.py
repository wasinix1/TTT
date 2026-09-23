"""The dispatcher owns the tables. It does not know or care which format a
match came from, which is the whole reason two formats can share a table pool:
run the knockout on tables 1 and 2 while everyone already eliminated keeps
playing open queue on table 3.

Two things decide where a match goes.

*Reservations.* A table tagged for a cup is reserved for that cup's formats
only, so two tournaments running at once don't cross-pollinate each other's
tables. An untagged table stays shared.

*Fair share of the shared pool.* Cups used to be served in creation order,
which is not a bias but outright starvation: whichever cup was made first
took every free table until it ran out of matches. Instead every cup makes
an offer and the table goes to the cup that is furthest from finishing —
matches left to play, times how long a match actually takes here tonight,
divided by the tables it already holds.

Equal table share would be the obvious rule and it is the wrong one. A Swiss
cup's demand is bursty: it wants every table at once and then none while the
last long match of a round finishes, so an equal share hands the idle
capacity to the smaller cup permanently and the smaller cup reaches its
knockout while the big one is still in round one. Ranking on time-to-finish
fixes that by construction — a cup that gets ahead of schedule has less work
left, so it starts losing every table it competes for until the other catches
up.
"""

MAX_SEATS_PER_TICK = 96


def resolve_walkovers(store):
    """Make a withdrawal reach the fixtures that were already on the books.

    Taking somebody out of the pool is not enough on its own: a group or a
    bracket has already written down matches they owe, and those sit there
    blocked — holding a table if one was seated, stopping the round from
    closing, stopping the bracket from resolving. Somebody who has gone
    home is not going to play them.

    So every fixture a withdrawn entrant still owes is recorded as a
    walkover to whoever was waiting on them. The table frees, the round
    closes, the bracket advances, and the result says what it was rather
    than looking like a whitewash nobody saw. If both sides are gone there
    is nobody to walk over, so the match is scrapped instead.

    Run to a fixed point, because a walkover can fill the next round's slot
    with somebody who has also withdrawn."""
    for _ in range(64):
        if not _walkover_pass(store):
            return


def _walkover_pass(store):
    for m in list(store.matches.values()):
        if m.status not in ("pending", "live") or not m.is_filled():
            continue
        a_out, b_out = store.withdrawn(m.entrant_a), store.withdrawn(m.entrant_b)
        if not (a_out or b_out):
            continue
        if a_out and b_out:
            if not m.meta.get("feeds"):
                store.append("match_void", {"match_id": m.id})
                return True
            # Both gone, but a bracket slot below is waiting on this one and
            # voiding would leave it unfillable for the rest of the evening.
            # Push one of them through instead — which side makes no odds,
            # since the next pass walks them over again to whoever is there.
            a_out = False
        games = store.walkover_games(m.scoring)
        if a_out:
            games = [[b, a] for a, b in games]
        store.append("match_result", {
            "match_id": m.id, "games": games,
            "winner": "b" if a_out else "a",
            "walkover": m.entrant_a if a_out else m.entrant_b,
        })
        return True
    return False


def sync_pools(store):
    """A cup has one list of people, and its draws read it.

    Everything that admits somebody — the door, a registration, a walk-in,
    the directory — only says which cup they are in. Getting them into the
    draw is done here, from that one fact, on every tick, so it cannot be
    forgotten by one of the paths in. That is the failure this replaces:
    each path used to reach into the format itself, and the ones that did
    not left people sitting on a roster the draw never saw.

    Before a draw starts its members are exactly the pool. Once it is under
    way they can only grow, and only if the format can still take somebody.
    A draw with no cup keeps whatever it was given."""
    for fid in list(store.format_order):
        f = store.formats.get(fid)
        cup = store.cup_of_format(f) if f else None
        if not f or cup is None:
            continue
        pool = store.cup_pool(cup)
        if f.status == "setup":
            want = pool
        elif f.takes_new_entrants():
            want = f.entrant_ids + [e for e in pool if e not in f.entrant_ids]
        else:
            continue
        if want != f.entrant_ids:
            f.entrant_ids = want
            store.append("format_update", {"id": f.id, "entrant_ids": want})


def sync_queues(store):
    """Who is waiting is a fact about the pool, not a list somebody keeps.

    Everyone in a running draw that pairs on demand is waiting unless they
    are on a table or sitting out. Finishing a match, being put back, and
    being admitted mid-evening all therefore end the same way, with nobody
    to remember to queue them. Adds only: the events that take somebody out
    (a match seating them, resting, leaving the cup) already do it."""
    busy = store.busy_players()
    queued = {q.entrant_id for q in store.queue}
    for fid in list(store.format_order):
        f = store.formats.get(fid)
        if not f or f.status != "running" or not f.uses_queue():
            continue
        cands = f.queue_candidates(store)
        if store.cup_of_format(f) is None:
            # a draw outside any cup has no pool to read, so it is whoever
            # was put in its queue by hand — and they go back where they came
            # from, as they always did
            cands += [e for e, fmt in store.came_from.items()
                      if fmt == f.id and e not in cands and e in store.entrants]
        for eid in cands:
            if eid in queued or eid in store.opted_out:
                continue
            if not store.entrant_available(eid, busy):
                continue
            store.append("queue_join", {"entrant_id": eid, "format_id": f.id})
            queued.add(eid)


def _offers(store, busy, force):
    """What each cup wants to put on a table. Nothing is committed here."""
    out = {}
    running = [store.formats[i] for i in store.format_order
               if i in store.formats and store.formats[i].status == "running"]
    for f in sorted(running, key=lambda f: (f.priority(),
                                            store.format_order.index(f.id))):
        key = store.cup_key(f)
        if key in out:
            continue                      # a cup offers one match at a time,
        p = f.propose(store, busy, force=force)   # its highest priority one
        if p:
            out[key] = p
    return out


def _time_to_finish(store, cup_id, formats):
    """Roughly how long this cup still needs, in seconds. None means
    open-ended — a filler that only takes tables nobody else wants."""
    left = 0
    bounded = False
    for f in formats:
        if store.cup_key(f) != cup_id:
            continue
        n = f.remaining_work(store)
        if n is None:
            continue
        bounded = True
        left += n
    if not bounded:
        return None
    per = store.median_match_seconds(cup_id)
    return left * per / max(1, store.tables_held(cup_id))


def _rank(store, running):
    """Sort key per cup: furthest from finishing goes first, then whoever is
    holding fewest tables, then creation order so the result is stable."""
    def key(cup_id):
        t = _time_to_finish(store, cup_id, running)
        return (0 if t is not None else 1,      # open-ended cups fill gaps
                -(t or 0),
                store.tables_held(cup_id),
                next((i for i, fid in enumerate(store.format_order)
                      if fid in store.formats
                      and store.cup_key(store.formats[fid]) == cup_id), 99))
    return key


def tick(store):
    """Advance phases, then fill every free table. Safe to call on any request."""
    with store.lock:
        # before anything else: a fixture owed by somebody who has gone home
        # is a blocked table, a round that cannot close and a bracket that
        # cannot resolve, so settle those first and let the rest proceed
        resolve_walkovers(store)
        sync_pools(store)
        for fid in list(store.format_order):
            f = store.formats.get(fid)
            if f and f.status == "running":
                f.tick(store)
        sync_queues(store)

        for _ in range(MAX_SEATS_PER_TICK):       # bounded, one seat per pass
            free = [n for n, t in sorted(store.tables.items())
                    if not t.paused and t.match_id is None]
            if not free:
                return
            busy = store.busy_players()
            running = [store.formats[i] for i in store.format_order
                       if i in store.formats
                       and store.formats[i].status == "running"]

            # first pass respects each format's strength tolerance; if that
            # leaves a table empty, go round again ignoring it, because an
            # idle table is worse than an imperfect pairing
            seated = None
            for force in (False, True):
                offers = _offers(store, busy, force)
                if not offers:
                    continue
                key = _rank(store, running)
                for tnum in free:
                    tcup = store.cup_of_table(store.tables[tnum])
                    can = [c for c in offers
                           if tcup is None or c == tcup]
                    if not can:
                        continue
                    pick = min(can, key=key)
                    seated = (tnum, offers[pick])
                    break
                if seated:
                    break
            if not seated:
                return

            tnum, proposal = seated
            mid = proposal.commit(store)
            store.append("match_assign", {"match_id": mid, "table": tnum})
            _pass_over(store, store.formats.get(proposal.format_id))


def _pass_over(store, seated_format):
    """Everyone still queued for a table that match could have taken moves one
    step closer to a wider strength tolerance; this is what stops outliers
    starving. Scoped to the cup that was actually served: a match on Cup A's
    table is not a turn of the room Cup B was passed over for, and counting it
    quietly widened the other cup's pairings for no reason.
    """
    if not seated_format:
        return
    cup = store.cup_key(seated_format)
    waiting = [q.entrant_id for q in store.queue
               if q.format_id in store.formats
               and store.cup_key(store.formats[q.format_id]) == cup]
    if waiting:
        store.append("queue_pass", {"entrant_ids": waiting})
