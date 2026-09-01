# Table tennis console

Runs an evening on three tables: registration, pairing, dispatch, results,
standings and brackets, on any phone in the room.

```
python3 run.py
```

Python 3.10 or newer. No pip install, no build step, no internet. It prints
three URLs — hand out the referee one at the tables, keep the admin one.

## What it does

Formats:

- **Open play** — a queue. Fixed pairs, singles, or scramble doubles where
  partners get drawn each time. Pairs on strength with a tolerance that widens
  the longer you wait.
- **Groups** — snake-seeded round robin, optionally feeding a knockout that
  builds itself when the last group match finishes.
- **Knockout** — seeded single elimination, byes handled, optional third place.
- **Swiss** — fixed rounds with Buchholz, or continuous, which pairs on demand
  instead of in lockstep so tables never idle waiting on one long match.

Any two can run at once and share the same tables. A knockout on tables 1 and
2 while everyone already eliminated keeps playing open queue on table 3.
Scheduled draws outrank open play for both tables and players, and anyone a
draw releases drops back into the queue they came from.

Roles are three URLs, no accounts:

| URL | Can |
|---|---|
| `/` | watch |
| `/r/<key>` | enter results, manage the queue |
| `/a/<key>` | everything |

## How the pairing works

Longest waiter anchors, then takes the best available opponent within a
strength tolerance. Not a global optimum: minimum-weight matching over the
whole queue will starve an outlier all evening because the optimum keeps
pairing everyone else.

Two knobs, both under Setup → Formats:

- **Strength gap** and **widen after** — the tolerance and how fast it grows.
  A "pass" is one match dispatched anywhere while you waited, so on three
  tables one turn of the room is about three passes.
- **Avoid rematches** — priced in strength points and counted against the
  tolerance, not just the ranking. That interaction is load-bearing: with a
  hard distance limit alone, the two weakest teams in a lopsided field sit
  permanently inside each other's tolerance, never get passed over, so the
  tolerance never widens and they play each other all night.

Measured on a deliberately nasty field (ten pairs at 9, 8.5, 8, 5, 5, 5, 5,
4.5, 2, 1 — two isolated outliers and a fat middle), 120 matches:

| Avoid rematches | Mean gap | Worst gap | Most repeats | Play spread |
|---|---|---|---|---|
| off | 0.44 | 3.0 | 21 | 20 |
| balanced *(default)* | 1.41 | 4.0 | 7 | 14 |
| strong | 1.90 | 4.5 | 5 | 12 |

Off gives perfect pairings and a boring evening. That is the whole tradeoff;
the default sits where it does on purpose.

Scramble doubles balances on `mean − λ·|difference|` rather than a sum,
because a 5 with a 1 plays below two 3s — the weak partner gets served at
until they crack. λ is `imbalance_lambda`, default 0.5.

If the tolerance leaves a table empty, the dispatcher goes round again
ignoring it. An idle table is worse than an imperfect pairing.

## Corrections

Every change is an event appended to `data/event.db`; the live state is a
replay of that log. Nothing is updated in place. So *Undo* on a result works,
and Setup → Log rewinds to any point and rebuilds the evening from there,
including re-resolving a bracket after a first-round score was entered
backwards. A crashed laptop loses nothing but the last request.

## Hosting

One small server, one permanent URL, HTTPS handled for you.

```
scp -r . root@your-server:/opt/tt-console
ssh root@your-server 'cd /opt/tt-console && deploy/install.sh tt.yourdomain.at'
```

That installs Caddy, creates a service user, wires up systemd and gets a TLS
certificate. About €4/month for the box and €10/year for the domain.

- Point an A record at the server's IP before running it.
- Your keys land in `/var/lib/tt-console/keys.json`.
- Ship changes later with `deploy/update.sh root@your-server`. The event log
  lives in `/var/lib` and is never touched by a deploy.

Because the URL is permanent, Setup → Access has a printable poster with a QR
code for the spectator link. Print it once and it works for every future
event. That page needs `segno` (`pip install segno`); without it you get the
URL and no QR.

The referee link is now on the public internet. Anyone holding it can enter
results, which is fine within a club, but don't put it on the poster.

## Live updates

The server pushes a version number over server-sent events the moment
anything changes, and clients refetch state only when it moves. A referee
saving a score lands on every other screen in about 130 ms rather than up to
two seconds later. Plain polling stays on underneath as a fallback for
networks that block SSE.

State is cached per version and served with an ETag, so unchanged polls cost
a 304 with an empty body. For forty phones over a half-hour session that is
roughly 8 MB of traffic instead of 350 MB.

If you put anything other than Caddy in front of it, server-sent events must
not be buffered or updates arrive in batches. `deploy/Caddyfile` sets
`flush_interval -1` on `/api/stream` for exactly this reason.

Strength is your estimate on a 1–10 scale, editable mid-event. Resist bolting
Elo onto it: with six or eight games each, a K-factor big enough to move the
needle is also big enough to be noise. Nudge two or three numbers by eye after
the first round instead.

## Layout

```
tt/models.py     dataclasses
tt/store.py      event log, replay, derived state
tt/formats.py    the four formats behind one interface
tt/dispatch.py   tables
tt/server.py     HTTP, roles, JSON state
tt/static/       the client
sim.py           plays full events through every format
```

`python3 sim.py` runs the lot: starvation, rematch bounds, byes, bracket
byes, Swiss byes scoring a point, two formats sharing tables, replay
determinism, and correcting a result mid-bracket.

Adding a format means implementing `next_match`, `on_result` and `standings`,
then adding it to `KINDS`. The dispatcher does not need to know it exists.
