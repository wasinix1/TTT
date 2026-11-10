# A night nobody referees

Open play on three tables, with nobody at the desk and nobody walking round
with a score pad. People turn up, get in the line from their phone, see on
the wall and on their phone when they are on, enter the result themselves,
and take a break or go home without asking anyone. The organiser is playing
too.

Everything here is open play. Groups, knockouts and Swiss still run as they
always did, and a phone can only check itself in to an open-play cup.

## Switching it on

Setup → Event → **Players on their own** has one row per cup, so the
doubles can run themselves while the singles have a desk:

| Cup | Check in | Own results | Unanswered |
|---|---|---|---|
| Open play | ✓ | ✓ | after 3 min |
| Singles cup | | | waits |

- **Check in.** While the doors are open, the phone page offers *Check in*
  next to *Tap your name* for this cup.
- **Own results.** Players enter their own scores, from the web page or
  Telegram.
- **Unanswered.** *Waits* means one side's word waits for the other side,
  however long that takes. With a time set, a result nobody contradicts is
  written once the time is up, so a table never stays blocked by somebody
  without a phone.

The settings live on the cup (`Cup.self_checkin`, `player_scores`,
`score_auto_min`), so they carry over with the cup to the next event, and
the new-event wizard keeps them. A cup that never set one falls back on the
old event-wide setting. That is also what a draw outside any cup uses.

## Who a phone is

Trust, the same as the desk. A phone either picks a name off tonight's list
or checks itself in with a name, and the server hands it a key for that
person. The key is the person's id plus an HMAC signed with the `player`
secret in `keys.json`. Nothing is stored. The same person always gets the
same key, on any phone, and it survives a restart and the next event. A key
that wasn't signed here is turned away.

The key doesn't prove who you are. Anybody can pick anybody's name, just as
anybody can tell the desk any name. What it does is keep the two sides of a
score separate: a report and its confirmation have to come from opposite
sides of the table. Every change a phone makes is logged as `phone`.

## The line

- **Checking in.** A walk-in types a name (two names for a doubles cup). The
  door's own `admit` makes the entry, so it is exactly what the desk would
  have made. An entry made ahead turns up once you search for your name. The
  list of who signed up is never shown whole.
- **Break / I'm back.** A break takes you out of the line, and coming back
  puts you at the end of it. The button is there straight after a result as
  well, which is when most people want it.
- **Going home.** Signs you out. Anything you still owed goes as a walkover.
- **The other side never came.** Three minutes after a match is called,
  either side can say so. The match is scrapped, and whoever didn't come is
  put on a break, so they aren't called again until they say they're back.
  The one who waited goes back in the line, and the table goes to the next
  match.

## Scores

A report is a claim (`claim_open` in the event log) and writes nothing until
it is settled:

| what happens | result |
|---|---|
| the other side taps *Right*, or reports the same score | written (`how: agreed`) |
| the other side taps *Not right*, or reports a different one | nothing; both are asked to enter it again |
| the wait runs out with no answer | written (`how: timed`) |
| the reporter takes it back | nothing |
| anyone enters it on the console | the console wins; the report is dropped |

Telegram and the web page share these reports. A score typed in the bot can
be confirmed on a web phone, and the other way round. The bot's *Stimmt
das?* message is now planned like table calls are (`tt/notify.py`), so it
turns into the answer wherever the answer came from.

The console shows each table's state: *X reported 11:7 11:5 — counts at
21:40*, with an *Accept* button, or *the players' scores don't match*. If a
match runs far longer than matches take tonight (twice the median, and at
least ten minutes over), it shows *Running long — finished with nobody
entering it?*. On a night players enter their own scores, the wall says
*Tisch 2 · Ergebnis eintragen!* for that table too.

## Scramble doubles on the board

The board now shows scramble's next match as its two teams of two. The
numbers on phones count four people to a match, not two, so *2 before
yours* is true for scramble as well as for singles and pairs.

## Correcting a result

Got the score the wrong way round? For 30 minutes after a match, the phone
offers *Wrong result against Ben?* under the main display. It opens the
score pad with what was entered already filled in. A correction is a report
like any other, but on a finished match:

- The other side is asked on their phone, or in Telegram, or by a push
  call. They see what was entered next to what it would become.
- Confirmed, the result is rewritten, and anything it decided further on is
  re-resolved, as when the console corrects a result. The log marks it
  `how: corrected`.
- **It never counts on the wait alone,** whatever the cup's setting. A
  result both sides agreed isn't changed on one side's word.
- Two corrections that disagree change nothing. The console lists open and
  disputed corrections above Results, with **Accept** and **Dismiss**;
  entering the result there settles it too.
- Only your latest result can be corrected, only in a cup where players
  enter their own scores, and only for 30 minutes. After that it's the
  organisers' to change.

## Calls on a locked phone: Web Push

Once the phone page knows who you are, it offers **Turn on calls**. The
phone then gets the same calls the bot sends: *Get ready* when you're in
the next wave, *Table 2 — you're on* when the table is yours, and *Ana
reported a result — is that right?* when the other side reported a score.
A newer call replaces the older one on the lock screen.

- `tt/webpush.py` is Web Push in the standard library: P-256 ECDSA and
  ECDH, HKDF-SHA256 and AES-128-GCM, written out. It reproduces the RFC 8291
  test vector byte for byte (in `sim.py`), and its VAPID signatures verify
  with Node's own crypto.
- `tt/push.py` plans calls from the state the way `tt/notify.py` does for
  Telegram: each call has a key, and a key is sent once. A restart, a replay
  or a rewind sends nothing twice. Subscriptions and sent keys are in
  `push.db`, and the server's VAPID key is generated there on first start.
- Only the push services browsers actually use (Google, Mozilla, Apple,
  Microsoft) are accepted as endpoints. A subscription is something a phone
  hands in, and the server shouldn't post wherever it's told to.
- `static/sw.js` is the service worker. It only shows pushes and caches
  nothing.
- **iPhone:** iOS only allows pushes for a page added to the home screen, so
  there the page says *Share → Add to Home Screen*. It ships a manifest and
  an icon for that.
- **HTTPS only.** Push works on the deployed server, and on `localhost`, but
  not over plain `http://` on the hall LAN.

## Players know what to do without asking

- **One line under the big number** says what to do right now: in the
  line, *step away? tap Break*; called, *head over now*; on a table, *after
  the match one of you enters the result*; on a break, *tap I'm back*.
- **How tonight works:** five lines, shown once per evening when someone
  first opens the page, and any time from the link at the bottom.
- **The wall** shows a dark strip along the bottom whenever a cup on it lets
  players check in or enter results. It has three steps — open the page,
  tap Break when you step away, enter your result after the match — and a
  QR code for the page if `segno` is installed.

## What it does not do

- **Checking in to a draw that has started.** A cup can allow checking in,
  but somebody arriving after a bracket is drawn lands on its roster, not in
  the bracket, just as they would at the desk.
