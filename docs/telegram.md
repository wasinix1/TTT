# Telegram

The console gains a companion in every player's pocket without anyone
installing anything new. Telegram is the app: it already does push that
arrives, accounts people already have, and a chat window that is the most
familiar interface there is. The bot is a layer on top of the console, never
a second console — switch it off and the evening runs exactly as it did.

What it is for, in the order it matters:

1. **Two messages per match.** *Gleich bist du dran* when you are in the next
   wave, *Du bist dran — Tisch 2* when the table is yours. Nothing else is
   pushed during play; everything after that edits those two in place.
2. **One-tap entry.** A returning player's registration is one button.
3. **Talking to the room.** A newsletter before the night, live messages
   during it, and players able to write back.
4. **Players entering their own scores**, when both sides agree. Opt-in.

## Principles

These extend the decision rules in `events-and-registration.md`; nothing
here overrides them.

1. **Optional by construction.** No bot token, no behaviour change. Every
   Telegram path is additive; the web form, the door and the wall stay
   complete on their own.
2. **Identity is witnessed, never inferred.** A Telegram account is attached
   to a person in the club directory only by something a human at the door
   saw happen: confirming a registration that was made from that account, or
   the account opening a link the door showed it. Never by name — calling
   yourself "Jana Berger" on Telegram gets you nothing of Jana's.
3. **The log holds decisions, the wire holds conversation.** Links, entries,
   results and sitting out are log events: undo and Setup → Log keep working.
   What was sent, who follows the bot and what they wrote live in
   `telegram.db` next to the log. Rewinding the evening re-decides; it cannot
   unsend a message, and it does not pretend to.
4. **Notifications are derived, like the board.** They are computed from the
   state, not fired from events, and every one has a key that is remembered
   once it is queued. A restart, a replay or a rewind recomputes what should
   have been said, and the outbox knows what already was — so nobody is told
   anything twice, and nothing is lost because the server was down for a
   minute.
5. **A linked player speaks for themselves, and only themselves.** From the
   bot they can sit out, come back, drop their own entry, or say they are
   going home. A result needs both sides: one phone never decides a match.
6. **The bot never answers what the wall answers.** Order and rough times come
   from the same functions the board and the dispatcher use.

## Identity across web, Telegram and the room

The person in the club directory is the identity. Everything else points
at it.

```
Telegram account ──(witnessed link)──▶ Person ◀── Player tonight ◀── Entrant
                                          ▲
Registration ──(confirmed at the door)────┘
```

How a Telegram account becomes somebody:

| Way in | What happens | Linked when |
|---|---|---|
| Registers in the bot | Registration carries the account | The door confirms that registration |
| Registers on the web, then taps *Per Telegram Bescheid bekommen* | The registration's private token carries the account onto it | The door confirms that registration |
| Walk-in, or linking later | The door shows a QR code for that person | The account opens it |
| Taps their own name on the live page (doors or live) | The bot opens with that name | Straight away — taken on trust, see below |
| Already linked (last month) | Recognised on sight | — |

A linked account is recognised from then on: its next registration is one
tap, carries the person, and shows at the door as known.

**On the night, a name is taken on trust.** During the doors and the
evening, the public live page offers a one-time panel: *Wann bist du dran?*
Type the first letters of your name, tap it, and Telegram opens on the bot,
which links you there and then. That is a deliberate exception to "never by
name": what a player account can do is get its table calls, sit itself out
and report scores — and a score is only written when the other side says the
same. Two limits keep it honest: a name already linked to another phone is
never taken over (the door sorts that out), and the link carries the event,
so last month's page links nobody. Tapping a different name moves the
account, which is how a wrong tap is undone. The panel shows once per phone
per event, never in the sandbox or a past event, and *📲 Aufs Handy* in the
header brings it back.

Since the redesign, phones at the plain URL get the phone page rather than
the console. There the same link is offered once the phone knows who it is
(*Playing tonight? Tap your name*): under your table or your place in the
queue, *Tischaufrufe aufs Handy* opens the bot with your name, on the same
terms. The console's panel stays for a screen showing the public console.

`person_link` is the one new event. It sets or clears an account on a person
and takes it off anybody else, so an account is always exactly one person.

## Notifications

| When | Message | Afterwards |
|---|---|---|
| Your match is in the next wave (the board's *get ready*) | ⏳ **Gleich bist du dran** — rough time, which tables, and the opponent when it is a fixed fixture. Button: *Kann gerade nicht* (sits you out, and the same message then offers the way back). | Deleted when the table call arrives, or when you are no longer waiting. |
| Your match is seated | 🏓 **Du bist dran! Tisch 2** — opponent, partner, best of. | Edited to the result when it is in; to *zurückgestellt* if it is put back. |

Keys: the table call is keyed on the match and the moment it was seated
(`queued_seq`), so a match that is put back and re-seated calls again, and
nothing else ever does. The next-wave message is keyed on the fixture, or on
the entrant's current stint in the queue for open play and Swiss.

A table call older than fifteen minutes is not sent: a server that was down
should not tell somebody to go to a table they have long since left.

Out of a queue (open play, a paced Swiss) the get-ready message names no
opponent. The board shows the likeliest pairing, but results still to come
can change it, and a pushed message cannot take a promise back.

A notice that was taken back — a table call edited to *put back* — and then
becomes true again, because a rewind reinstated the seating, is said again
under a new key rather than swallowed by the old one.

## The card

`/start` shows one message that is the player's view of the evening: the
event, their entries and an entry button per open cup before the night;
where they are tonight during it (on a table, roughly when, sat out); their
record after. It keeps itself current by editing, silently, whenever what it
says about them changes — so it is a live status, not a snapshot, and never
a stream of messages. Asking for it again replaces the old one.

Everything a player can do is on it, one level deep at most: *Pause*, and
behind a pause *Ich gehe heim*; *abmelden* behind a confirmation; news and
unlinking behind ⚙️.

## The Mini App

The same person the bot knows, as a page inside Telegram: `/tg`, opened from
the *Mein Abend* button beside the message box (set for every player with
`setChatMenuButton`) or from the card. It shows the one thing that matters
most right now, big — *Tisch 2* on red when it is your turn, *Mach dich
bereit* on black when you are next, your place in the running order, or the
event and its entry buttons before the night — and under it your evening,
your table in the standings, who is on which table, a line to the organisers
and your settings. It follows Telegram's light or dark theme and updates
live off the same stream the console uses.

It is a view of the bot, not a second console. Every action goes through the
Conversation's own checks and the same ops (`tt/me.py`), so the chat and the
page cannot disagree. Entering a score has a proper pad here — a row per
game, the verdict as you type — and the other side can confirm in the app or
in the chat; whichever they use, the question turns into its answer in both.

**Who is asking.** Telegram hands the page `initData`, signed with the bot's
token. The server checks that signature on every request (HMAC-SHA256 keyed
with HMAC("WebAppData", token), every field but `hash`, sorted) and refuses
anything older than a day. No cookie, no login, and opened outside Telegram
the page shows nothing but a link to the bot. The sandbox has no bot, so it
has no Mini App either.

It needs a public `https://` address — Telegram only opens Mini Apps from
one. On a hall LAN without one, the menu button stays Telegram's own command
list and everything else works as before.

## Coms

**Newsletter.** Everyone who has started the bot and not turned it off. The
*Announce* button writes the event card itself: name, date, venue and one
entry button per open cup — the one-tap registration arrives in the message
that advertises the night.

**Live.** Tonight's players, one cup, or the pre-registered, from the Chat
tab. One person, from their row at the door.

**Back.** Anything a player types that is not a score is a message to the
organisers. It lands in Setup → Chat with their name on it, and a reply from
there goes straight back. A table whose players disagree on the score shows
up there too, as *From the tables*.

**Reminder.** The day before, everybody registered through Telegram is asked
*Kommst du?* — yes, or drop the entry in one tap. The door sees who said yes.

## Players entering scores

Off by default; one switch in Setup → Links → Telegram. The table call then
says: *Nach dem Spiel einfach das Ergebnis hier eintippen, z. B. 11:7 9:11
11:5.*

A score typed by one side goes to the other as a question with *Stimmt* and
*Stimmt nicht*. *Stimmt* writes the result, marked as entered by players in
the log. Both sides typing the same score is agreement too. *Stimmt nicht*,
or two different scores, writes nothing and tells the organisers which table
needs a referee. A referee entering the score always wins; a pending report
for a match that already has a result is dropped.

## Speed

A tap has to feel instant, and the first version did not. What it takes:

- **One connection, kept open.** Every call used to open a new TCP and TLS
  connection to Telegram — several round trips before the request itself,
  and a tap is two calls. Each thread now keeps one open. It also tries IPv4
  first with a short connect timeout: a server whose IPv6 route silently
  drops packets used to wait out the whole timeout on every call.
- **Answer, then redraw.** The button spins until Telegram hears back, so the
  tap is acknowledged the moment the action is done, and the card is redrawn
  after.
- **Side by side.** Updates are handled by a small pool, each chat in its own
  order. One listener working through them one at a time made the fortieth
  tap after an announcement wait for the other thirty-nine.
- **Table calls first.** The sender takes a few messages at a time and asks
  again, so a table call queued after a result goes ahead of card edits and
  newsletters. Card edits are the lowest priority, and only happen when a
  player's situation changes, or the rough time moves by ten minutes, not
  after every result for everyone.
- **Work once.** The running order is worked out once per state of the event
  and shared, not once per player; the outbox is written in one go.

Setup → Links → Telegram shows how long a typical call to Telegram takes from
the server. Under 300 ms a tap feels instant; if it says seconds, the network
between the server and Telegram is the problem, not the bot. Calls over two
seconds are logged (`journalctl -u tt-console | grep telegram`).

## Setup

1. In Telegram, open @BotFather, send `/newbot`, pick a name.
2. Paste the token into Setup → Links → Telegram.

That is all. The server long-polls Telegram, so there is no webhook, no Caddy
change and no inbound port. The token is kept in `telegram.json` beside
`keys.json` and never appears in the log or in any state sent to a browser.

## Build

- `tt/telegram.py` — the wire: the Bot API over `urllib`, `telegram.db`, the
  poll / notify / send threads, status and backoff.
- `tt/notify.py` — who to tell what, from the state. Pure: store in,
  notices out.
- `tt/bot.py` — the conversation: cards, buttons, copy, and the checks that a
  player only ever acts for themselves.
- `tt/me.py` + `tt/static/me.html`, `me.js` — the Mini App: the signed door,
  one player's view, and their actions through the Conversation.

Order, each step shipping something usable:

- **A — Connect and link.** Token in the console, `person_link`, the three
  ways in, chips at the door.
- **B — The two messages.** Planning, outbox, edits and deletes.
- **C — The player's card.** Status, one-tap entry, sit out and back.
- **D — Coms.** Newsletter and announce, live messages, the inbox, the
  reminder.
- **E — Scores.** Reports, confirmation, disagreement to the organisers.

## Decisions taken under rule 7

- The bot speaks German, like the landing page and the wall; the console
  stays English.
- Player-facing actions go through the same ops the console uses, under an
  internal `system` role that no URL key can reach. The ownership check
  happens in `bot.py` before the op is called.
- Unlinking is always allowed from the player's side (`/stop` or the
  settings button). Linking never is without a witness.
- A registration made in the bot by a linked person is not duplicated: the
  bot shows the existing one instead. The web form keeps allowing duplicates,
  because it cannot tell two phones apart.
- The newsletter is opt-out, and the first message says how.
- Rate: at most 25 messages a second overall. Table calls and replies go
  ahead of newsletters in the queue.
- `player_scores` is an event setting carried forward by `event_new`, like
  the tables — a club decides this once.
- The Live button on the card only appears for a public `https://` address:
  Telegram refuses buttons pointing at a LAN address, and would reject the
  whole message with them.
- Linking at the door (the QR code on a person's row) is offered only while
  the doors are open or the event is live — that is when it can be witnessed.
  The code works once and for twelve hours. The QR image needs `segno`, which
  `deploy/install.sh` already installs; without it the link is shown as text.
