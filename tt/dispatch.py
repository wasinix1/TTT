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
        for fid in list(store.format_order):
            f = store.formats.get(fid)
            if f and f.status == "running":
                f.tick(store)

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
