# The console: admin, referee, public view, wall display and door, in the Focus language

This is the spec for the new desktop console. It applies the same rules as the
phone page (`docs/mobile-redesign.md`) to the four big-screen views:

- the **admin** at `/a/<key>`
- the **referee** at `/r/<key>`
- the **public console** at `/?console`
- the **wall display** at `/board`
- the **registration desk** at `/a/<key>/desk` and `/d/<key>`

It is in the code: the console, the desk, the wall display and the phone page
all ship in this form. Every op, endpoint, element id, `data-act`,
`localStorage` key and URL the old console used still works. What changed is
presentation and how the screens are arranged, plus one small server op (Seat
now, 4.8: `queue_front` and its `match_order` event).

Where the files are:

- `index.html`, `console.css`, `app.js` — the console (admin, referee, public view)
- `desk.html`, `desk.css`, `desk.js` — the registration desk
- `board.html`, `board.js` — the wall display
- `live.html`, `me.html`, `mobile.css`, `mobile.js` — the phone page and the Mini App (`docs/mobile-redesign.md`)
- `paint.js` — paint and print (section 11)
- `fonts.css`, `fonts/` — Syne, Archivo, Archivo Amp, self-hosted

Checked: `python3 sim.py` and `python3 sim_telegram.py` pass; every view was
run against a server holding simulated evenings with 1, 3 and 4 cups, at
1440, 1280 and 390 px wide (the wall display at 1920×1080 and in portrait),
with no console errors.

---

## 1. The rules carried over from the phone

- **Bone, ink, one red.** Red means *live*, *you* or *needs you*, nothing else:
  a table being played on, *Get ready*, your own name and cup on the phone,
  the Door count, warnings, *Next* in the new-event wizard.
  Everything else is ink on bone. The match being played in a knockout is
  ink, as on the phone page: it is live, but its red is its table.
- **The painted table** is the unit of the room, drawn the same everywhere:
  the squircle (`38% 38% 36% 36% / 30% 30% 32% 32%`), the `#paint` texture, a
  crisp inner line and a solid net, the number in a bone pill on the net.
- **Tables are bright by default.** Every table with a match on it is full
  red for every role; nothing is greyed out to say "you could enter a score
  here". Scoring is still there: tap a cell and type.
- **Syne for the big words** (chapter heads, table numbers), **Archivo for
  everything else**, with the Archivo Amp subset so the ampersand in pair
  names is the same everywhere. Self-hosted (`/static/fonts.css`).
- **Fonts, tokens and grain** are the phone page's: the same bone, ink,
  rule (`rgba(27,27,27,.14)`) and grain.

## 2. One set of parts, on every page

What the phone page, the Mini App, the console (admin, referee, public) and,
where it applies, the desk and the wall share is now drawn the same way. The
phone page's details lead; the console's own decisions (the quiet cup
switch, five results) carried over to the phone page.

| part | everywhere | differs where, and why |
|---|---|---|
| Event name in the bar | small capitals beside the mark | the console and the desk add the date / the door counts under it |
| Cup switch | the cup's name, centred and bold, on a firm outlined tile; the chosen one filled ink; no strip with one cup; an odd last cup takes the whole row on a phone; your own cup's name red on the phone | the desk keeps one count under the name, *here / expected*, because that is what the door is for |
| Section heads | Syne 26 px, anything else on the title's baseline (a note in small capitals; the standings' column labels W · L · ±; *+ Add a result* as a link), and **one ink rule under the head** — the same height for every chapter, so on the desktop the rules sit at one level across the columns and the first rows start together. Nothing inside a chapter draws a second ink rule. | — |
| Lists | open on an ink rule, rows on hairlines; nothing bold for being next | — |
| Table face | as above; a side is *first name over last name*, a pair is two names with the ampersand on its own line; the label is the cup (Everyone) or the round (one cup) | for the admin the label adds *since 20:14* and the footer *best of 3 to 11*, and the face carries the cells; the referee gets the scoresheet card instead (section 7) |
| Free / on break | the dashed outline with one word, *free* or *break* | entering results on a phone, a free table is one line, not a table-sized outline between the ones that need you |
| Names in lists | a pair by its two first names (*Jonas & Ana*); a chosen team name whole | the table faces, the wall and the desk give names in full |
| Up next row | position, name over *vs* opponent, *Get ready* in red | a rough ETA for whoever enters results |
| Standings | W · L · ± (Swiss W · Bh · ±); a small heading per group with *Top 2 go through*; those places' numbers in ink and a **dotted line under the last of them**, kept after the knockout is drawn, as the record of who went through | — |
| Knockout | the same tree, sizes and names; the match being played in ink with a black *Table 1* tag; knockout above the group tables | *Edit* on hover for whoever enters results |
| Results | *Winner beat Loser*, the games won (2:0), under it the cup, round and games from the winner's side (11:7 11:9) | *Edit result* on hover, in the corner, for whoever enters results |
| Times | 9:05, not 09:05 | — |
| *+ N more*, *Show all N*, *Show fewer* | the same words and the same quiet underlined link | — |

### Five rows

Every list shows **five rows, then *+ N more*** (or *Show all N*), opened in
place and closed with *Show fewer*: Up next with one cup in view, Results,
the Mini App's own evening, and the desk's side lists (Looking for a partner,
Taken off the list, Activity; Just checked in already was).

A **standings table shows ten**, then the rest: a group is rarely longer, a
Swiss or an open play of thirty is.

Where the rule does not apply, and why:

- **Everyone, several cups:** three rows of Up next and four of standings per cup, so the cups line up side by side; *+ N more* opens the cup.
- **The desk's Expected and Here lists:** working lists, searched and checked off, with the letters down the side.
- **The desk's Needs a look:** each row is something to decide, so none is hidden.
- **The wall display:** it fits as many rows as the screen holds, measured.
- **Setup** (cups, tables, people, the log): the whole of what you are editing.

## 3. The frame

One header bar, sticky:

```
TTT  Event name · Thu 20:00      [Live] [Door 12] [Setup 2]      Announced — Registration — Doors — ●Live — Done   ADMIN  •
```

- **Modes** (admin only): Live, Door and Setup.
  - Door shows how many registrations are still expected.
  - Setup shows unread Telegram messages.
  - The mode is kept in the hash (`#door`, `#setup`), so a reload lands where it was.
  - Escape goes back to Live, unless the new-event wizard is open.
  - Referees and the public console only have Live, so they see no mode switch.
- **Phase stepper**: not in the header. It lives in Setup → Event, in place of the old chip-and-dropdown: the five phases, the current one boxed with a red dot. Clicking a step pins the evening there; a line under it says what that phase means and whether it is pinned or following the clock, with "Follow the clock" to unpin.
- **Role tag:** ADMIN, REFEREE or LIVE. The pulse dot blinks once per update, as before.

## 4. Live

### 4.1 The cup strip

A switch, not a scoreboard. One tile per cup, plus *Everyone*; each tile is
the cup's name, centred and bold, on a firm outlined tile, and the chosen
one is filled ink, like the mode switch. No counts and no progress bar: what
they said ("4 playing", "9 up next", "22 / 23 played", the format, the
tables) each have their place below, in the Tables heading, Up next and the
cup's own column. The numbers stay in the tile's tooltip.

- The phone page has the same tiles (and your own cup's name in red there).
- Clicking a cup shows only that cup. Clicking it again goes back to Everyone. This is the old cup-tabs behaviour, and the `tt_cup` key is unchanged.
- With **one cup** there is nothing to switch between, so there is no strip.
- Layout: one row of equal tiles for 2–4 cups; a grid with Everyone on its own row for 5 or more; two per row at 760 px and below, an odd last tile spanning the row.

### 4.2 Warnings

Warnings are the format warnings from the server (with *Cut to knockout now*
on a Swiss round) and idle reserved tables. Idle tables with the same reason
are now **one** note, not one per table: *"Tables 2, 3, 7 and 8 are reserved
and standing empty while Mixed and Einzel have people waiting…"*.

### 4.3 Tables

The heading is *On the tables*, the note *4 playing · 2 free · 1 on break*.
Each tile is the table face of section 2.

| | |
|---|---|
| Score cells | One pair per game, under each name. The ids stay `g-<match>-<game>-a/b`, so drafts survive re-renders as before. Typing moves on by itself: a digit that cannot begin a two-digit score (anything but 1 when games go to 11; but 1 or 2 when they go to 21) moves the cursor at once, a 1 waits for its second digit; A, then B, then the next game, then *Save* once the result is decided (Enter saves). Deleting never moves it. The same in the referee's cards, the editor, manual entry and the Mini App's pad. |
| Save result | Quiet until the draft decides a winner, then ink: *Save Ole & Emil win* (first names, as in lists, so it fits a compact table). |
| Names on a scoring table | On red labels, as in TTT Admin, so the painted line and the centre line never run through them. The cells keep clear of the number on the net (half the pill's height plus a little air). |
| Clear · Put back · Pause | Text links under the tile, admin only where they were admin only. *Back in the queue* is the old requeue tick box (open play). |
| Free table | The dashed outline, *free*. Admin can pause it. |
| Paused table | Dashed, *break*, with *Resume*. |

How the tables scale:

| | |
|---|---|
| ≤ 4 tables | four across, full size (max 330 px) |
| > 4 tables | compact (max 256 px), as many across as fit |
| ≤ 640 px, entering results | one per row, the cells big; a free table is one line |
| ≤ 640 px, anyone else | the phone page's grid: two across, three past six tables, an odd last one centred |

### 4.4 Below the tables: one cup in view

Three chapters side by side, in the phone page's order: Up next; Knockout,
then Standings; Results. At 1180 px and below they become two columns, at
760 px one.

1. **Up next.** Five rows, then *+ N more*, then the server's own "and N more after that". The front of the line is marked *Next* in red; hovering any other row shows *Seat now* and *Sit out* (and *Enter result*) — see 4.8.
2. **Knockout**, then **Standings / Wins tonight**, as in section 2.
3. **Results.** The latest five, then *Show all N*. The header holds only the title and *Add a result* (manual entry, which opens above Results). *Find a player* appears only once the list is opened up, as a full-width underlined field above it.

### 4.5 Below the tables: Everyone, several cups

One column per cup, side by side, all on **one skeleton** so they read across as well as down:

- **The cup's name** (Syne) with *Open →* — the column's anchor. No format line: that lives in the cup's own view and in Setup.
- **Two blocks**, each opened by a small ink heading on the ink rule:
  - **Up next**: three slots; *+ N more* (opens the cup) sits on the heading's line, never between rows. Empty: *Nothing queued.* or *All played.*, and the slots stay empty — no placeholder dashes.
  - **The standings**, four one-line slots, the column labels (W · L · ±, W · Bh · ±) on the heading's line above their columns: *Through so far* (groups: A1, A2, B1, B2), *Standings* (Swiss: the top four), *Wins tonight* (open play), or *Knockout · Final* — the round being played, a match drawn as Up next draws one (side over side, so a narrow column never cuts both names short), its table as a black *Table 1* tag or its score on the right.
- The slots have fixed heights, so the second block starts at the same height in every column whatever is in the first. At 760 px and below the columns stack and the reserved space goes.

Results run across the full width underneath, five of them, in two columns
read left to right, with the cup named on each.

### 4.6 The knockout tree

Each round is a column, and each match is placed by its `slot` (from
`bracket_view`, see the mobile patch), so byes leave a gap rather than
shifting the tree. The match being played has an ink outline and a black
*Table 3* tag; a finished match bolds the winner and shows the games won;
*Edit* appears on hover. Same sizes as the phone page (cards 50 px high).

### 4.7 The editor and manual entry

Both are unchanged in behaviour.

- The editor is a modal sheet. It has *Save … win*, *Clear* and *Undo result*, and explains what saving a different score does.
- Manual entry is a block above Results with these fields:
  - Side A, Side B
  - Counts towards
  - Best of, Points to
  - the cells

### 4.8 Seat now, and a table changing hands

The flow from the TTT Admin mockup, with its mechanics and visuals:

- **Up next rows.** The match at the front of the line, and any the board says will go on as soon as a table frees (`on_deck`), is marked **Next** in red. Hovering any other row shows **Seat now · Sit out** (and *Enter result* for a fixture). The public console keeps *Get ready* and no actions. The same rows, with the same actions, are in the cup columns of Everyone.
- **Seat now** moves the match to the front of its draw's line: *the next free table goes to them*. Toast: **Moved to the front** · *The next free table goes to them* · **Undo** (puts it back exactly where it was). If a table is free for it right now, it goes straight on, and the toast says **Seated on table 3** instead.
  - Server: `queue_front {match_id}` (admin) sets the match's place in the line below every other (`meta.deferred`, the counter put-back already raises and `order_key` already leads with), runs the dispatcher, and answers `{was, table}`. Undo is `queue_front {match_id, restore: was}`. Event: `match_order`. It replaces the old Seat now, which could only act when a table was already free.
- **Sit out** (open play): toast **Ole & Emil sit out** · *Nobody pairs them until they're back* · **Undo**.
- **Saving a result** on a table: the match slides out (blurring, 0.43 s), the table stands free for a moment with *Seating the next match…* (0.65 s), and whoever the dispatcher seated slides in (0.6 s). The server has already decided; the animation only lets the eye follow. Toast: **Saved · Ole & Emil win 2–0** · *Table 3: Pia & Malte vs Bo & Teis are on* (or *Table 3 is free*) · **Undo** (takes the result back; the match waits to be played again).
- **Put back**: the same swap; toast **Put back** · *Sent to the end of the queue · Table 3: … are on*, or, when nobody else could take the table, that the same pair went straight back on.
- The toast is the mockup's: dark, at the bottom, what happened in bold, what it means under it, Undo on the right, five seconds.
- The referee's scoresheet cards get the same swap.

### 4.9 On a touch screen

A phone or a tablet has no hover, so nothing that a mouse finds by hovering
is shown there (*Edit result*, *Seat now · Sit out · Enter result*, a
knockout match's *Edit*). Instead the row is the control: **tap it**, and it
takes a faint ground and opens its actions on a line beneath it. Tapping it
again, or another row, closes it; doing one of the actions closes it too. The
open row survives the redraws a result or a poll brings. The same for admin
on a tablet and the referee on a phone.

## 5. Door (admin)

Door mode frames the registration desk: `/a/<key>/desk?embed=1`, plus
`&sim=1` in the sandbox. It is one desk with two ways in, the same page the
door key opens, minus its own header. The desk itself is redesigned:

- **Search first.**
  - The page opens on a big *Type a name…* field (`/` focuses it).
  - Enter checks in the top match.
  - If nobody matches, Enter hands the name to the walk-in form.
  - ↑/↓ moves the selection.
- **The cup strip** is the shared tile (section 2) with the door's one count under the name: *Everyone · 31 / 42 here*, each cup *here / expected*.
- **Expected / Here.**
  - Expected is everyone who registered and hasn't arrived, grouped by letter. Each row shows the note they left, the time they registered, *No show* on hover, and *Check in*.
  - *Here* is everyone in, with their status (playing at table 4, waiting, sitting out, gone home).
  - *Check in all* asks first.
- **The right column, top to bottom:**
  1. **Walk-in.** It has its own cup switch, so a walk-in can go to another cup than the one in view. `n` focuses it. Pair cups ask for a partner or *No partner yet — match them*, and take an optional *Team name* (sent as `team_name` to `admit`; left empty, the entry is the two names joined, as before). The field is hidden while *No partner yet* is ticked.
  2. **Needs a look.** Possible duplicates (*Same — clear it / Different person*) and entries in a cup whose draw is already running.
  3. **Just checked in.** Five, then *All N here →*.
  4. **Looking for a partner.** Five, then *+ N more*.
  5. **Taken off the list.** Folded; five, then *+ N more*.
  6. **Activity.** Folded; five, then *+ N more*.
  7. **Keys.**
- **Details** open in a drawer from the right. Names, partner, cup, sitting out, going home and Telegram are all there, and every field saves when you leave it.
- **Undo, not "are you sure":** every reversible action toasts with *Undo*. The one exception is *Gone home*, which asks first, as before.
- **The club directory** is behind the link under the strip.

## 6. Setup (admin)

Setup is a full page with a left nav instead of the old sliding sheet. The
sections and their contents are unchanged:

- Event (the landing page text, the cups and their draws, the tables, the next event). Setup always opens here.
- At the door
- Chat (only once Telegram is connected)
- Links
- More

Each page has a Syne title and a one-line lede (`TAB_HEAD`). Blocks are
separated by rules, not cards.

- **At the door** shows the counts and *Open the desk →*, which switches to Door mode. Below that are the door link and the old door list, folded as *The roster as a list* (every entry, editable in place). Whether it is open is remembered.
- **Cups** (on the Event page) take the page's full width: the heading runs above them on one line (title, what a cup is, Why), and each cup card has room, with Entry, Sign-ups and the landing-page line on one grid.
- **Tables** (on the Event page, and step 3 of the wizard) are cells laid out like the hall, one per table:
  - the painted table in small with its number (dashed when paused)
  - its name, editable in place
  - the cup it goes to (*Shared* or a cup; only when there is more than one cup)
  - what it is doing (*Playing*, *Playing · Mixed* on a shared table, *Free*, *Paused*)
  - *Pause / Resume*, and *Remove* on a table with nothing on it (the server refuses the other case anyway)
  - a dashed *+ Add a table* cell closes the grid. *Share them all / Split between cups* stays in the block's header.
- **The new-event wizard** is the same four steps (Event, Cups, Tables, Review), shown in the left nav, with *Next* in red.
- *Back to Live* is in the nav.

## 7. The public console, the referee and the wall display

- **Public console** (`/?console`): Live only, read-only, for a laptop or a spectator who wants the detail. It shows the strip, the tables, the cup columns and the results, with no hover actions.
- **Referee:** Live only, and laid out for its one job, entering results.
  - **The tables are scoresheet cards** (the *plain* design from the first admin mockup): the small painted table with its number, what is being played (*Doppel · Final*) and *best of 3 to 11 · since 16:30*, then the two sides as rows with a cell per game under *G1 G2 G3*, and *Save … win* across the card once the score decides it. *Clear* and *back in the queue* as before. A free table is a one-line outline. The cells are the same inputs as on the painted tables (same ids, same drafts). Cards sit three across on a laptop, one per row on a phone.
  - **Everything else is folded** below the tables, as on the phone page: *Up next*, *Knockout*, *Standings*, *Results* with one cup in view, one row per cup in Everyone. Each row shows a one-line note (who is next, the round, who leads, the latest result) and opens in place; an open row stays open through updates.
  - The referee can still use the editor, *Enter result* or *Sit out* on the board, and *Add a result*. Admin-only actions (Put back, Seat now, Pause) are absent, as before. No jump bar: the folds are the sections.

### 7.1 The wall display (`/board`)

The wall display is not the console made bigger. It answers one question,
*when am I playing*, for a room, from the far side of a hall, so it stays
what it was: bright, bold, big, the main information only, no controls and
no scrolling. Its content, sizes (the 1920×1080 mock in vh), the fitting of
rows, the German wording (*Jetzt · Tisch 3*, *circa! in 15min.*, the footer
line), the portrait layout, the sandbox frame and the hidden dark switch on
the mark are all unchanged. What changed is the language:

- Bone ground and ink type, Syne for the event, the cups and the clock, Archivo for names; self-hosted fonts.
- Each match being played is a **painted red block**, the `#paint` texture and an inner line as on the tables, with **one side per line** and a hairline between them, like the net. Names no longer break around a dash.
- In the queue, the first side is bold and the opponent sits under it, quieter. *Get ready* is a red pill.
- Pairs read "Anna & Max", with the Archivo Amp ampersand.
- The clock is 24-hour (9:05, as everywhere) and keeps time between updates.
- Dark hall: the same layout on an ink ground; the red does not change.

## 8. Breakpoints

| width | change |
|---|---|
| > 1180 | full layout: three chapters, one column per cup |
| ≤ 1180 | chapters in two columns, cup columns two across |
| ≤ 980 | Setup's left nav becomes a row of links above the page |
| ≤ 760 | cup strip two across; chapters and cup columns in one column; the event date drops out of the header; in Setup the phase steps wrap, without their connecting dashes |
| ≤ 640 | phone: entering results, tables one per row and free tables as one line; anyone else, the phone page's table grid; jump bar; forms stack |

## 9. What is deliberately unchanged

- All ops, permissions, endpoints, the SSE stream and polling.
- The ETag handling, the sandbox (`?sim=1`) and past events (`?past=`).
- Telegram, the print pages and the landing page (parked).
- **Strength stays parked** (`SHOW_STRENGTH = false`). Nothing new reads it or shows it.
- `confirm()` prompts where the old console had them.

## 10. The preview

During the design work every page was also run as a hosted preview: the real
pages and scripts, with `/api/*` and `/api/me` answered by the real `tt`
package running in the browser under Pyodide, through every moment of an
evening (announced, registration, doors, live, done) with 1, 3 or 4 cups.
It lives outside the repo; nothing here depends on it.

## 11. Paint and print

One rule across the console, the desk, the phone page and the wall display: anything solid in ink or red is **paint**, anything grey or thin is **print**.

- Paint: the tables; the filled buttons (Check in, Save, Seat now, the chosen cup, the active mode); the ink outlines ("Playing tonight?", the ADMIN / DOOR / REFEREE tag); the heavy ink rules under section heads and over each cup on the wall display.
- Print: the hairlines between rows, the grey outlines (the unchosen cups), all text.
- Left crisp on purpose: the walk-in switch on the desk and the phone's segmented switches (a frame around a choice), and anything inside a table.

Paint marks what you act on and where a section starts; print is the information. `static/paint.js` (loaded by the console, the desk, the phone page and the Mini App) looks the page over after each render and marks each element by what it actually shows, so a Save that turns ink when a score is in turns painted with it. The wall display paints its cup rules in its own CSS. Without the script everything still draws, crisp.
