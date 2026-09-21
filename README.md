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
- **Swiss** — Buchholz, in one of three shapes. *Paced* is the default for a
  new one: pair on demand the moment a table frees up, but only against
  someone who has played the same number of games, and stop at the round
  count. *Strict rounds* is classic lockstep Swiss. *Free-running* pairs on
  demand with no round limit and ends when you cut it to a knockout. A Swiss
  set up before paced mode existed keeps running free — an event already
  under way does not change shape because the server was updated.

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
| `/board` | the wall display |

## Sharing tables between cups

Group formats into **cups** and each gets its own tab, standings and bracket.
Two cups can share one set of tables, and the question is who gets the next
one free.

Not the cup that asked first — that is not a bias, it is starvation. Not an
equal share either, and this is the part that matters. A Swiss cup's demand
is bursty: it wants every table at once and then none while the last long
match of a round finishes. Hand that idle capacity to the smaller cup on an
equal share and the smaller cup reaches its knockout while the big one is
still in round one.

So the table goes to whichever cup is **furthest from finishing** — matches
left, times how long a match is actually taking tonight, over the tables it
already holds. A cup that gets ahead of schedule has less left to do, so it
starts losing every table it contests until the other catches up. Both
finish around the same time, which is the thing you actually wanted.

Paced Swiss attacks the same problem from the other end: with no round
barrier there is no burst to absorb.

Tables are **shared** or **split**, and that is read off the tables
themselves rather than stored as a mode — no table tagged with a cup means
shared, any table tagged means split, so the two can never disagree. Split
makes "which table" a real answer for a spectator, at the cost of a reserved
table standing idle when its own cup has nothing ready. It tells you when
that happens rather than quietly wasting it.

## When am I playing

`/board` is a wall display for that question, so people stop asking it. Who
is on which table now, then the running order with a rough time against each
name. No key, no controls.

It commits to **order** and never to **place**. Order is a promise that can
be kept: it is read from the same function the dispatcher seats matches
with, so what a spectator sees is what actually happens. Pre-assigning a
table is what creates idle-table time — table 2 comes free but the next
match is "on table 3", so table 2 waits. The table is decided the instant
one frees up; until then a match shows the set it could land on, which for a
cup with reserved tables is already a definite answer.

Times are measured, not guessed: the median of what matches have actually
taken tonight, divided by the tables serving that cup. They drift as the
evening speeds up or slows down. The next wave is flagged *get ready*
instead, which is what a tournament desk would call out anyway.

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
replay of that log. Nothing is updated in place. A crashed laptop loses
nothing but the last request.

Hover any result and *Edit result* reopens the same pad it was entered on.
Saving a different score puts it right and re-resolves whatever it decided
in later rounds — a first-round score entered backwards fixes the bracket
under it. *Undo result* takes it back altogether and leaves the match to be
played again, taking the player it advanced back out of the next round with
it. Setup → Log still rewinds the whole evening to any point.

## Hosting

One small server, one permanent URL, HTTPS handled for you.

```
scp -r . root@your-server:/opt/tt-console
ssh root@your-server 'cd /opt/tt-console && deploy/install.sh'
```

That installs Caddy, creates a service user, wires up systemd and gets a TLS
certificate. About €4/month for the box and €10/year for the domain.

- Set your address in `deploy/domains.conf` and point an A record at the
  server's IP before running it.
- Your keys land in `/var/lib/tt-console/keys.json`.
- Ship changes later with `deploy/update.sh root@your-server`. The event log
  lives in `/var/lib` and is never touched by a deploy.

### Changing the address

The address lives in one file, `deploy/domains.conf`, and nowhere in the app:
pages, print sheets and QR codes use whatever address they were opened from.

1. Add a DNS A record for the new name pointing at the server. Keep the old
   record.
2. In `domains.conf`, set `PRIMARY` to the new name and put the old one in
   `ALIASES`, so both serve the app while old posters are still around.
3. `deploy/update.sh root@your-server`. This rebuilds the Caddyfile, checks it
   with `caddy validate` (the live file is untouched if it fails), reloads
   Caddy, and Caddy fetches the certificate for the new name.
4. Open Setup → Access on the new address and reprint the poster.
5. Later, move the old name from `ALIASES` to `REDIRECTS` and deploy again. It
   then forwards to the new address, keeping the path, so old referee and
   admin links still land in the right place. Delete it once nobody uses it.

Don't edit `/etc/caddy/Caddyfile` on the server; the next deploy rebuilds it.

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
tt/dispatch.py   tables, and which cup gets the next one
tt/board.py      who plays next, and roughly when
tt/server.py     HTTP, roles, JSON state
tt/static/       the client
sim.py           plays full events through every format
```

`python3 sim.py` runs the lot: starvation, rematch bounds, byes, bracket
byes, Swiss byes scoring a point, two formats sharing tables, replay
determinism, correcting a result mid-bracket, fair table share between cups,
a small draw not outrunning a big one, and paced Swiss holding the field to
within one game of itself.

Adding a format means implementing `propose`, `on_result` and `standings`,
then adding it to `KINDS`. The dispatcher does not need to know it exists.
`propose` must not change anything — it is asked speculatively, and only one
answer per pass is committed.
