"""The dispatcher owns the tables. It does not know or care which format a
match came from, which is the whole reason two formats can share a table pool:
run the knockout on tables 1 and 2 while everyone already eliminated keeps
playing open queue on table 3.

The one exception is cups: a table tagged for a cup is reserved for that
cup's formats only, so two tournaments running at once don't cross-pollinate
each other's tables. An untagged table stays shared, exactly as before.
"""


def tick(store):
    """Advance phases, then fill every free table. Safe to call on any request."""
    with store.lock:
        for fid in list(store.format_order):
            f = store.formats.get(fid)
            if f and f.status == "running":
                f.tick(store)

        def by_priority():
            fs = [store.formats[i] for i in store.format_order if i in store.formats]
            fs = [f for f in fs if f.status == "running"]
            return sorted(fs, key=lambda f: (f.priority(),
                                             store.format_order.index(f.id)))

        for _ in range(96):                       # bounded, one seat per pass
            free = [n for n, t in sorted(store.tables.items())
                    if not t.paused and t.match_id is None]
            if not free:
                return
            busy = store.busy_players()
            # first pass respects each format's strength tolerance; if that
            # leaves a table empty, go round again ignoring it, because an idle
            # table is worse than an imperfect pairing
            assigned = None
            for forced in (False, True):
                for tnum in free:
                    tcup = store.cup_of_table(store.tables[tnum])
                    mid = None
                    for f in by_priority():
                        if tcup is not None and store.cup_of_format(f) != tcup:
                            continue          # this table is reserved for another cup
                        mid = f.next_match(store, busy, force=forced)
                        if mid:
                            break
                    if mid:
                        assigned = (tnum, mid)
                        break
                if assigned:
                    break
            if not assigned:
                return
            tnum, mid = assigned
            store.append("match_assign", {"match_id": mid, "table": tnum})
            waiting = [q.entrant_id for q in store.queue]
            if waiting:
                # everyone still queued moves one step closer to a wider
                # strength tolerance; this is what stops outliers starving
                store.append("queue_pass", {"entrant_ids": waiting})
