"""The dispatcher owns the tables. It does not know or care which format a
match came from, which is the whole reason two formats can share a table pool:
run the knockout on tables 1 and 2 while everyone already eliminated keeps
playing open queue on table 3.
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
            for forced in (False, True):
                for tnum in free:
                    mid = None
                    for f in by_priority():
                        mid = f.next_match(store, busy, force=forced)
                        if mid:
                            break
                    if mid:
                        break
                if mid:
                    break
            if not mid:
                return
            store.append("match_assign", {"match_id": mid, "table": tnum})
            waiting = [q.entrant_id for q in store.queue]
            if waiting:
                # everyone still queued moves one step closer to a wider
                # strength tolerance; this is what stops outliers starving
                store.append("queue_pass", {"entrant_ids": waiting})
