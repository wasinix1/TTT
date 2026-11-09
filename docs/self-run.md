# A night nobody referees

Open play on three tables, with nobody at the desk and nobody walking round
with a score pad. People turn up, get in the line from their phone, see on
the wall and on their phone when they are on, enter the result themselves,
and take a break or go home without asking anyone. The organiser is playing
too.

Everything here is open play. Groups, knockouts and Swiss still run as they
always did, and a phone can only check itself in to an open-play cup.

## Switching it on

Setup → Event → **Players on their own**:

- **Players check themselves in to open play from their phone.** While the
  doors are open, the phone page offers *Check in* next to *Tap your name*.
- **Players enter their own scores.** The same switch the Telegram section
  has always had. It now covers web phones as well as Telegram.
- **A report nobody answers counts after** *never / 2 / 3 / 5 / 10 min*.
  This is the trust setting. *Never* means one side's word waits for the
  other side, however long that takes. With a time set, a report nobody
  contradicts is written once the time is up, so a table never stays blocked
  by somebody without a phone.

All three carry over to the next event, like the other club habits.

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

## What it does not do

- **Calls when the phone is locked.** Without Telegram, the page only buzzes
  while it is open. The wall is still the main way people find out they're
  on. Real web push would need elliptic-curve signing, which Python's
  standard library doesn't have, and this server installs nothing.
- **Checking in to anything but open play.** A bracket that people could
  join from the car park is not a bracket.
