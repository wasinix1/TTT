"""Who plays next, and roughly when.

The point of this module is one question asked out loud all evening: "when am
I playing?". Answering it badly is worse than not answering it. So the board
commits to *order* and never to *place*.

Order is a promise that can be kept. It is read from the same function the
dispatcher seats matches with, so what a spectator is shown is what actually
happens, not a second guess at it.

Place is not. Pre-assigning a table is what creates idle-table time: table 2
comes free but the next match is "on table 3", so table 2 waits. The table is
decided at the instant one frees up, and until then a match shows the set of
tables it could land on — which, when cups have reserved tables, is already a
definite answer.

Times are measured, not guessed: how long a match is actually taking tonight,
from the event log, divided by the tables serving that cup. They drift as the
evening speeds up or slows down, which is the point.
"""

ROUGH = 5 * 60          # round displayed times to five minutes


def _tables_serving(store, cup_id):
    return [n for n in store.tables_for_cup(cup_id)
            if not store.tables[n].paused]


def _range_label(nums):
    """[1,2,3] -> "Tables 1-3"; [1,3,4,7] -> "Tables 1, 3-4, 7".

    Which table you are on is the other half of "when am I playing", and a
    cup with its own tables can answer it exactly. Collapsing runs is what
    makes that readable across a hall instead of "table 1 or 2 or 3"."""
    nums = sorted(nums)
    if not nums:
        return "No table"
    runs, start, prev = [], nums[0], nums[0]
    for n in nums[1:]:
        if n == prev + 1:
            prev = n
            continue
        runs.append((start, prev))
        start = prev = n
    runs.append((start, prev))
    parts = [str(a) if a == b else f"{a}\u2013{b}" for a, b in runs]
    return ("Table " if len(nums) == 1 else "Tables ") + ", ".join(parts)


def _reserved_for(store, cup_id, tables):
    """True when every table this cup can use is held for it, so naming
    them is a promise rather than a guess at the shared pool."""
    return bool(tables) and cup_id is not None and all(
        store.cup_of_table(store.tables[n]) == cup_id for n in tables)


def _share(store, cup_id, tables):
    """How many tables this cup can really expect to be using at once.

    Not the same as the tables it is allowed on. A cup with nothing reserved
    is competing for the shared pool, and saying "get ready" to everyone who
    could theoretically be on the next free table is how you get six people
    standing around while another cup plays on all three. Reserved tables
    count in full; shared ones are divided between the cups contending for
    them."""
    reserved = [n for n in tables if store.cup_of_table(store.tables[n]) == cup_id]
    shared = len(tables) - len(reserved)
    if not shared:
        return float(len(reserved))
    rivals = {store.cup_key(store.formats[i]) for i in store.format_order
              if i in store.formats and store.formats[i].status == "running"}
    return len(reserved) + shared / max(1, len(rivals))


def _eta(index, share, per, a_table_is_free):
    """Seconds until the match at this position is likely to start."""
    if share <= 0:
        return None
    waves = int(index // share)
    # if every table is busy, the first one off still has to finish; on
    # average that is half a match away
    head = 0 if a_table_is_free else per / 2
    return head + waves * per


def _round_to(seconds):
    if seconds is None:
        return None
    return int(round(seconds / ROUGH) * ROUGH // 60)


def cup_board(store, cup_id, app):
    """The running order for one cup: playing now, then everyone waiting."""
    running = [store.formats[i] for i in store.format_order
               if i in store.formats and store.formats[i].status == "running"
               and store.cup_key(store.formats[i]) == cup_id]
    running.sort(key=lambda f: (f.priority(), store.format_order.index(f.id)))

    tables = _tables_serving(store, cup_id)
    share = _share(store, cup_id, tables)
    per = store.median_match_seconds(cup_id)
    free = any(store.tables[n].match_id is None for n in tables)
    busy = store.busy_players()

    now = []
    for n in sorted(store.tables):
        t = store.tables[n]
        m = store.matches.get(t.match_id) if t.match_id else None
        if m and store.cup_key(store.formats.get(m.format_id)) == cup_id:
            now.append({"kind": "playing", "id": m.id, "table": n,
                        "a": app.side_name(m, "a"), "b": app.side_name(m, "b"),
                        "label": m.label})

    rows = []
    # scheduled fixtures first — they outrank open play for a table, so they
    # outrank it on the board too
    for f in running:
        if f.uses_queue():
            continue
        for m in f.pending_fixtures(store):
            rows.append({
                "kind": "fixture", "id": m.id, "format_name": f.name,
                "a": app.side_name(m, "a"), "b": app.side_name(m, "b"),
                "label": m.label, "scoring": m.scoring.to_dict(),
                "blocked": not (store.entrant_available(m.entrant_a, busy)
                                and store.entrant_available(m.entrant_b, busy)),
            })
    # then whoever is waiting in a queue; two of them make one match, so a
    # person's wait is set by their pair's position, not their own
    for f in running:
        if not f.uses_queue():
            continue
        qs = sorted([q for q in store.queue if q.format_id == f.id],
                    key=lambda q: (-q.passes, q.joined_seq))
        for q in qs:
            rows.append({
                "kind": "waiting", "id": q.entrant_id, "format_name": f.name,
                "a": store.entrant_name(q.entrant_id), "b": None,
                "label": f.name,
                "blocked": not store.entrant_available(q.entrant_id, busy),
            })

    seat = 0                     # which match-slot this row is waiting for
    half = None                  # a queued entrant half-way to a pairing
    for i, r in enumerate(rows):
        r["position"] = i + 1
        if r["kind"] == "waiting":
            if half is None:
                half = seat
                r["_slot"] = seat
            else:
                r["_slot"] = half
                half = None
                seat += 1
        else:
            r["_slot"] = seat
            seat += 1
    for r in rows:
        secs = _eta(r.pop("_slot"), share, per, free)
        r["eta_min"] = _round_to(secs)
        r["tables"] = tables
        r["on_deck"] = (not r["blocked"]) and secs is not None and secs < per

    reserved = _reserved_for(store, cup_id, tables)
    return {
        "cup_id": cup_id,
        "playing": now,
        "up": rows,
        "tables": tables,
        # the set a match here could land on: named, because that is the
        # other half of the question, and a cup with its own tables can
        # answer it exactly. Only a cup that could turn up anywhere gets
        # the vague version.
        "tables_label": ("Any table"
                         if not reserved and len(tables) == len(store.tables)
                         else _range_label(tables)),
        "reserved": reserved,
        "match_minutes": int(per // 60),
        "waiting": sum(1 for r in rows if r["kind"] == "waiting"),
        "fixtures": sum(1 for r in rows if r["kind"] == "fixture"),
    }


def boards(store, app, limit=24):
    """One board per cup, plus one for anything not in a cup."""
    keys = []
    for fid in store.format_order:
        f = store.formats.get(fid)
        if f and f.status == "running":
            k = store.cup_key(f)
            if k not in keys:
                keys.append(k)
    out = []
    for k in keys:
        b = cup_board(store, k, app)
        b["total"] = len(b["up"])
        # the tail is nobody's next question, and forty phones refetching it
        # after every single result is how the wire bill gets paid twice
        b["up"] = b["up"][:limit]
        out.append(b)
    return out


def idle_reservations(store):
    """Reserved tables sitting empty while another cup has people waiting.

    Strict reservations are the right default — a spectator told "table 3,
    Cup B" should not find Cup A on it — but an idle reserved table with a
    queue next to it is worth an admin's attention rather than silence.
    """
    waiting = set()
    for q in store.queue:
        f = store.formats.get(q.format_id)
        if f:
            waiting.add(store.cup_key(f))
    for m in store.matches.values():
        if m.status == "pending" and m.is_filled():
            waiting.add(store.cup_key(store.formats.get(m.format_id)))
    out = []
    for n, t in sorted(store.tables.items()):
        cup = store.cup_of_table(t)
        if cup is None or t.paused or t.match_id:
            continue
        others = [c for c in waiting if c != cup]
        if others:
            names = [store.cups[c].name for c in others if c in store.cups]
            out.append({"table": n, "cup_id": cup,
                        "waiting_for": names or ["another format"]})
    return out
