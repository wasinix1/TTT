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
| Already linked (last month) | Recognised on sight | — |

A linked account is recognised from then on: its next registration is one
tap, carries the person, and shows at the door as known.

`person_link` is the one new event. It sets or clears an account on a person
and takes it off anybody else, so an account is always exactly one person.

## Notifications

| When | Message | Afterwards |
|---|---|---|
| Your match is in the next wave (the board's *get ready*) | ⏳ **Gleich bist du dran** — opponent if known, rough time, which tables. Button: *Kann gerade nicht* (sits you out). | Deleted when the table call arrives, or when you are no longer waiting. |
| Your match is seated | 🏓 **Du bist dran! Tisch 2** — opponent, partner, best of. | Edited to the result when it is in; to *zurückgestellt* if it is put back. |

Keys: the table call is keyed on the match and the moment it was seated
(`queued_seq`), so a match that is put back and re-seated calls again, and
nothing else ever does. The next-wave message is keyed on the fixture, or on
the entrant's current stint in the queue for open play and Swiss.

A table call older than fifteen minutes is not sent: a server that was down
should not tell somebody to go to a table they have long since left.

## Coms

**Newsletter.** Everyone who has started the bot and not turned it off. The
*Announce* button writes the event card itself: name, date, venue and one
entry button per open cup — the one-tap registration arrives in the message
that advertises the night.

**Live.** Tonight's players, one cup, or the pre-registered, from the Chat
tab. One person, from their row at the door.

**Back.** Anything a player types that is not a score is a message to the
organisers. It lands in the Chat tab with their name on it, and a reply from
there goes straight back.

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
