# The phone page — TTT Focus + TTT Tables, one layout

This is the spec for the new mobile layout. It brings together the Focus hero
(one person's evening) and the Tables spectator view (the room) into a single
page, for both the web (`live.html`, at `/` during the doors and the evening)
and the Telegram Mini App (`me.html`). One stylesheet (`mobile.css`) and one
script (`mobile.js`, which replaced `me.js`) serve both shells; the fonts are
self-hosted (`fonts.css`, `fonts/`).

Checked: `python3 sim.py` and `python3 sim_telegram.py` pass, and `live.html`
was run against a server holding simulated evenings, with no console errors.

---

## 1. One page, two shells

| | web | tg |
|---|---|---|
| URL | `/` in the `doors` and `live` phases | `/tg` (Mini App), every phase |
| who | a name picked once on this phone (`localStorage`) | whoever Telegram signed (`/api/me`) |
| data | `/api/state` (role public) | `/api/state` (role public) **and** `/api/me` |
| can act | no, read-only | yes: break, go home, report score, confirm, message, news, unlink, sign up |
| language default | English (as the public console was) | German (as the Mini App was) |

Both shells draw the same thing:

1. **Bar:** TTT, the event name, and a live dot that blinks once on each update.
2. **Opponent's claim (tg):** if the other side has reported a result, it goes
   first because it needs you.
3. **Hero (Focus):** shown when the person is known.
   - Web: before a name is picked, the pill *Playing tonight? Tap your name →*
     takes its place.
4. **Under the hero:**
   - other entries ("Einzel · 3 before yours")
   - actions (tg)
5. **Personal section (tg):**
   - registration, before the night
   - *Dein Abend*: their results, and who they still have to play
6. **The room:**
   - cup strip
   - tables
   - up next
   - standings
   - results
7. **Message to the organisers + settings (tg).**

Nothing in the room is red unless it is you.

### Routing

- `/`, while the console is up → `live.html`.
  - `?console`, `?sim=…` and `?past=…` still get `index.html`. The sandbox and
    the archive are console features, and a desktop can still open the old
    view.
- `/a/…` and `/r/…` → unchanged (`index.html`).
- `/tg` → `me.html`, which is now the same page in its Telegram shell.
- `.woff2` gets a MIME type.

---

## 2. Data → screen

Every field below is something the server already sends, except the five
marked **PROPOSED**. All five are now in the server, and the client works
without them.

### The person's state ("tonight")

The tg shell gets `tonight[]` from `/api/me` (`bot.state_of`, ordered by
`me._rank`).

The web shell builds the identical object client-side (`stateOf()` in
`mobile.js`) from `/api/state`:

| field | from |
|---|---|
| `state` | `entrants[].status` |
| `table`, `table_no`, `opponent`, `partners`, `label`, `best_of`, `bo`, `need` | the table whose `match.entrant_a/b` or `match.meta.queued` holds the entrant |
| `since` | `match.started_ts` — **PROPOSED** in `match_dto` |
| `on_deck`, `position`, `eta_min`, `label` | the entrant's row in `board[cup].up` |
| `ahead` | `row.ahead` — **PROPOSED**. Fallback: the slot worked out client-side with the same seat loop as `board.cup_board` (`slots()`) |
| `opponent` (waiting) | the other entrant of a `fixture` **or `pairing`** row. Pairing is **PROPOSED** for `state_of`; it already knows the opponent |
| `won`, `lost` | `recent[]` |
| `tables` | `board.tables` + `reserved` → "Tables 1–3" / "All tables", in the page's language. The board's own `tables_label` is German only |

In the tg shell, `table_no`, `since` and `ahead` come from `state_of`. If they
are ever missing:

- the table number falls back to `/api/me` `tables[].mine`;
- `cup_id` and `tables` are filled from `/api/state`.

### Hero

The hero picks the most urgent entry (`tonight[0]`), and every other entry
becomes a line under the hero.

| state | big | line | facts | foot | table |
|---|---|---|---|---|---|
| waiting/drawn, row found, not on deck | **`ahead`** ("3") | match(es) before yours | tables · label · record | Next against *opponent* / *drawn when a table comes free* | blur 9/18/27/35/42 px for 0…4+ ahead, lines .5 |
| waiting/drawn, `on_deck` | **Next / Gleich** | first free table is yours | Stay close · tables · label | Against *opponent* | blur 5, lines .55, closer |
| playing | **table number**, painted on | Your table (+ custom table name) | Since 21:52 · Best of 3 to 11 · label · with *partner* | Against *opponent* | sharp, lines .9, vibrate once |
| a result just landed (6 s) | **2–1** | You won / You lost | Now 1st in group A · up from 2nd | Played *opponent* | blur 30 |
| drawn, no row | **Later / Später** | No match for you right now | Your next one is not drawn yet | So far *w : l* | far |
| resting | **Break / Pause** | You won't be called | tell the desk (web) / until you're back (tg) | So far | far, lines .35 |
| withdrawn | **Home / Daheim** | Signed out for tonight | open matches went to opponents | So far | far, lines .35 |
| entered (draw not started) | **Soon / Bald** | Starting soon | | In *cup* | far |
| outside | **In / Dabei** | You're in | Your draw is still to come | In *cup* | far |
| tg, nothing tonight, pending registration | **Fast** | Du stehst auf der Liste | *cup* · am Eingang bestätigen wir dich | | far |
| tg, nothing tonight | **Heute nicht** | … | Sag am Eingang Bescheid | | far |
| tg, `announced`/`registration` | **days / hours / minutes** to `starts_ts` | Tage bis zum Abend | `event.when` | Angemeldet *cups* | far |
| tg, `done` | **Danke** | Danke fürs Mitspielen! | places | Heute *w : l* | blur 18 |

How the hero behaves:

- **Moving between states:** the number only replays its focus-in when the
  state actually changes; a re-render with the same state leaves it alone.
  Between states, the table glides to its new size and sharpness over 1.5 s.
- **Detecting a result:** a result is spotted client-side. A done match of
  yours appears in `recent` that was not there on the previous load. Walkovers
  and byes are not announced.
- **Rank line:** compares the rank in `formats[].standings` before and after
  the result.
- **Fitting the big text:** long words shrink to fit with air on the right;
  two-digit numbers shrink to fit the width.

### Actions (tg only — the same `act` ops as today, unchanged)

| state | buttons |
|---|---|
| playing, `V.scores` | **Ergebnis eintragen** → score pad → `score`. Once reported: "Gemeldet: 11:7 · … — X bestätigt noch" |
| waiting / drawn / entered | **Pause** → `rest {on:1}` |
| resting | **Ich bin wieder da** → `rest {on:0}` · **Ich gehe heim** → confirm → `leave {on:1}` |
| withdrawn | **Doch noch da** → `leave {on:0}` |
| other entries on a break / gone | inline *Ich bin wieder da* / *Doch noch da* on their line (new; before, only the top entry could be brought back) |
| claim card | **Stimmt** / **Stimmt nicht** → `confirm` |
| before the night | sign-up cards — `enter`, `rsvp`, `drop`, exactly as `me.js` did |
| always | message → `message`; news toggle → `news`; Lösen → confirm → `unlink` |

The score pad is `me.js`'s logic, ported unchanged:

- rows appear as the games are entered;
- two digits jump to the next box;
- the verdict appears once a winner is decided;
- *Senden* sends the score.

### Web: who you are

- The pill opens the name sheet. It lists everyone in `players[]` who has an
  entrant, with their partner, their cups, and live status (*now at table 1*,
  *next*, *3 before yours*). There is a search field.
- Picking a name is the **focus pull**: the room blurs out, the hero comes in
  from far and soft, and the room comes back.
- The choice is stored as `ttt_me = {event, player}` in `localStorage`.
  - A different `event.id` on the next visit means a different evening, so the
    name is forgotten.
  - *Not you?* reverses the pull and opens the sheet again.
- The strip's choice is stored as `ttt_cup`.

---

## 3. Scaling

### Cups

- **One cup:** no strip. Every section shows that cup.
- **Two or more cups:** the strip has *Everyone* (full width) plus one tile per
  cup, two per row. The strip is both the progress display and the filter.
  - Tile: name, progress, a 3 px bar, and the cup's tables — or *you play
    here* in red.
  - Progress is `done / (done + playing + board.fixtures)` for draws that know
    their matches (groups, KO, Swiss round).
  - Open play has no total, so it shows *N played* and no bar.
- **Default selection:**
  - the saved choice, otherwise
  - if the person plays in exactly one cup → that cup;
  - otherwise *Everyone*.
- **Filter rule** (same as `app.js`):
  - shared items always show;
  - a busy table follows the cup of its match;
  - a free table follows its tag;
  - a table reserved for this cup but still finishing another cup's match
    shows as dashed *finishing a Doppel match*.
- **Everyone with several cups:**
  - tables show the cup name above the net instead of the match label;
  - **Up next** shows 3 rows per cup, so the cups line up. Your row is kept
    below a `···` if it is further down, and *+ N more* selects that cup;
  - **Standings** fold to one line per cup: *You're 2nd* or *X leads*;
  - **Results** carry the cup name.

### Tables

| count | layout |
|---|---|
| 1 | one large table, 72 % wide, centred |
| 2–6 | two columns |
| 7+ | three columns, smaller; names shortened to "Maximilian H."; label above the net hidden |

Rules that hold at every count:

- every table is the same size, so the nets line up;
- an odd last row is centred under the others (`o1`, `o2a`/`o2b`);
- a pair stacks with "&". One person stacks first name over last name;
- table states:
  - free / break: dashed
  - finishing another cup's match: dashed with a note
  - yours: full red with a shadow
- once a name is known, the other tables step back (opacity .72).

### Lists

- **Up next:** position, names, and *vs*/*gegen*, with one chip on the right:
  - *Get ready* (red, `on_deck`)
  - *next* (an open-play `pairing`, worked out by the same rule that will seat
    it)
  - *put back* (`deferred`)

  Waiting entrants read *waiting for a match*. Past the 24 rows the server
  sends: *and N more after that*.
- **Standings, by format kind:**
  - Groups: per group, W L ±. If `then_ko`, *Top 2 go through* with a dashed
    cut after the last qualifier. Qualifiers are in ink, not red.
  - Swiss: W Bh ±.
  - Open play: *Wins tonight*, sorted by wins.
  - Bracket (`view.bracket`): drawn as a **tree**, before the group tables.
    - Rounds run left to right, and each match sits level with the matches
      that feed it.
    - Placement goes by bracket `slot` (slot *i* feeds slot *i*>>1). Byes are
      not matches, so a match fed by a bye takes the next free row; no empty
      rows.
    - Your road through the draw is drawn in red, and a live match carries a
      *table N* tag.
    - The winner is named in Syne under the final.
    - The match for third sits under the tree.
    - Up to 8 entrants (three rounds) fits the phone. A 16-draw scrolls
      sideways and opens at the round being played.
    - Once a bracket exists, the *go through* line is dropped.
- **Results:**
  - the winner is named first;
  - games are read from the winner's side;
  - a walkover reads *walkover*, a bye reads as just the name;
  - the latest 8, then *Show all N*;
  - a search box appears past 8.

---

## 4. Deliberately dropped or changed

| what | why |
|---|---|
| ETA as the headline ("~12 Min"), "circa! in 15min." chips | Order is exact; time is a guess. The hero counts matches before yours. `eta_min` is still sent and still decides urgency order. |
| Live score | Nobody types it during play; it would always be stale. |
| A separate "playing — confirmed" step | A match is live the moment it is assigned (`match_assign` sets `started_ts`). |
| The "Last:" line under the hero | Replaced by the 6-second result moment. |
| Pulsing hero, Telegram dark theme | The page is bone in every theme; it tells Telegram to colour its own bars to match (`setHeaderColor`, `setBackgroundColor`). |
| `me.py` `standings[]` and `tables[]` | No longer read: the room comes from `/api/state` and marks you in it. They stay in `/api/me` for the chat card and older clients. |
| Google Fonts | Self-hosted, so the page never waits on hall wifi, and the ampersand is the chosen one. |
| `me.js` | Replaced by `mobile.js`. Every `act` op and string carried over. |
| The public console's phone layout | Replaced. Admin, referee, desk, wall (`/board`) and the site are unchanged. |

Strength is not shown and not asked for (CLAUDE.md).

---

## 5. Server changes

1. `server.match_dto` → `started_ts`. Gives "Since 21:52".
2. `board.cup_board` → each row keeps its slot as `ahead`. This is the number
   in the hero, and it is exact.
3. `bot.state_of` → `table_no`, `since`, `ahead`, and the opponent for
   open-play `pairing` rows too.
4. `formats.bracket_view` → each match carries its `slot`, so the tree can
   place it. Without it, the client falls back to list order, which is wrong
   once there are byes.
5. `server` routing → `live.html` at `/`, plus `.woff2` MIME.
6. `sim.py` → five new checks for the routing and `ahead`.

Nothing else changes: no new endpoint, no new op, no change to `/api/me`'s
existing fields.

---

## 6. Trying it

1. `python3 sim.py && python3 sim_telegram.py`.
2. Try it on a phone against a played-forward evening: `tt.simulate.build()`
   on an event with cups, served by `Handler`, then open `/`. For `/tg`,
   `me.sign()` makes an initData for a linked test account.
3. Run an evening.

### Accessibility and motion

- The hero is `aria-live="polite"`.
- Closed sheets are `visibility:hidden`, so they are out of the tab order.
- `prefers-reduced-motion` turns off every transition and the focus-in.
- Haptics:
  - Telegram's `HapticFeedback` for the table call, results, and errors;
  - `navigator.vibrate` on the web shell for the table call.

---

## 7. Open decisions

- **Language per event rather than per shell.** All strings are in `STR`
  (`en`, `de`); a setting would be one line.
- **Places after the night** (`me.py` `places`) don't name the cup. With
  several cups, "1. Platz" alone is ambiguous; worth adding the cup name there.
- **Desktop at `/`.** The new page is a centred 460 px column. A wide layout
  (tables row, three columns below) would be a later step; `?console` covers
  it until then.

---

## 8. Since: shared with the console

The console redesign (`docs/console-redesign.md`, section 2) brought the two
into one set of parts. On the phone page that changed four things.

- **The cup switch** is the console's: each tile is the cup's name, centred and bold, on a firm outlined tile, the chosen one filled ink; no counts, no progress bar (they each have their place below). Your own cup's name is red; an odd last cup takes the whole row.
- **Five rows, then *+ N more*:** Up next with one cup in view (your row kept if it is further down, after a `···`), Results (*Show all N*), and the Mini App's *Dein Abend* (the latest five).
- **A standings table shows ten**, then the rest.
- **The dotted line under the places that go through** stays once the knockout is drawn, as the record of who went through.
