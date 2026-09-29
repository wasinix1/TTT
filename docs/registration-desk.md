# The registration desk

The Door tab grows into a page of its own: a desk for everything about who is
in the event. It opens in its own browser tab, is built for a laptop at the
entrance and still works on a phone, and has its own key so the job can be
handed to somebody else.

This builds on `docs/events-and-registration.md`, it does not replace it. The
timeline, the decision rules and the model there all stand. What changes is
where the door lives, who may run it, and three gaps the last event showed:
teams registered twice, no way to cancel, and duplicates cluttering the list.

The clickable mockup is `docs/registration-desk-mockup.html` (open it in a
browser; the black bar switches screens, key and phase).

## What stays

The point of this is a better desk, not a rewrite. These are kept as they are
and carried into the desk rather than re-invented:

- **The model and the log.** A registration is an intent, attendance is a
  fact; confirming mints the player and the entrant; the cup's pool is its
  only list; every change is a log event, so Undo and More → Log keep working.
- **The server stays the one that refuses.** `_refuse_duplicate` still keeps
  two identical names out of one pool (the board and the referees need to
  tell them apart). What changes is the desk's side: instead of a disabled
  button and "add something like (blue shirt)", it offers the choice and
  proposes a name ("Tom Kraus (2)"), editable afterwards.
- **Automatic partner matching.** First come, first matched, written down as
  `matched_with`; dropping one half sets the other looking again.
- **The status vocabulary** of `entrant_status` (playing, waiting, resting,
  drawn, entered, outside, withdrawn) and the sentence each one carries.
- **Remove vs. Gone home.** Remove only while nothing depends on them;
  afterwards it is Gone home, which settles what they owe as walkovers.
- **The door's bulk and last-minute tools:** Confirm all (as "Check in
  everyone expected"), Merge into… (admin only), Remove all (admin only,
  tucked away), Add from the directory.
- **The explanations.** The console's habit of saying *why* (the `why()`
  blocks, the tooltips on status chips) carries over as the detail panel's
  one-line explanations under each action.
- **The public site** keeps its look, its German copy and its structure. It
  gets three small additions, listed below, and nothing else.
- **The Door tab** keeps working until the desk has run a real event. It
  then shrinks to the counts and an "Open registration desk" link.

## The door key

A third link next to admin and referee: `/d/<key>`, generated like the others
and listed in Links.

The levels today are a ladder (public 0, referee 1, admin 2). The door does
not fit on it — it needs registration and roster ops but not scoring — so
roles get an explicit set of allowed ops alongside the ladder:

| Door can | Door cannot |
|---|---|
| check in, walk-ins, no-show, undo check-in, remove before drawn | score, void, put back, assign |
| rename, swap a partner, team name, move cup before playing | draws, cups, tables, phase, event |
| sit out / back in, gone home, bring back | merge cups, remove all |
| clear or keep duplicates, put back a resolved entry | forget someone from the directory |
| add from the directory | rewind the log, sim |

Every logged event records who wrote it (`admin`, `door`, `referee`,
`public`, or `system` for what the dispatcher does on its own), so the desk's
activity list and More → Log can say who did it. Events from before this
existed carry no author and are shown without one, rather than guessed.

The door link opens the desk and nothing else; there is no console for it.
The server refuses everything outside the list above to that key regardless
of what any page shows.

## The desk page

`tt/static/desk.html` + `desk.js` + `desk.css`, served at `/d/<key>` (the
door link) and `/a/<key>/desk` (the admin's way in), in the console's palette
and type. It is the same kind of standalone page as `/board` and the public
site.

It reads its own payload, `/api/desk`: cups, registrations (without their
secret tokens), entrants with status and table, the directory, the last
activity lines. It re-renders only when that changes, and never while an input
in it has focus. That is what removes the doubles modal: the forms are plain
inline forms because nothing redraws under them.

Layout, as in the mockup:

- **Header:** event, phase, counts (expected · here · playing), key badge.
- **Cup tabs**, each with its own counts, plus **Club directory**.
- **Expected** | **Here** | **Detail**, three columns on a laptop. Below
  ~1000px the detail slides up from the bottom; at phone width the two lists
  sit behind an Expected / Here switch.
- **Filter** searches both lists across *all* cups, not just the open tab,
  and every result carries a chip naming its cup.
- **Keys:** `/` filter, `n` walk-in, ↑ ↓ move through Expected, Enter check
  in, Esc close.
- **Undo** on every action as a toast, instead of `confirm()` dialogs. The one
  exception is Gone home, which asks inside the detail panel.

### Expected

- **One card per team or person.** Entries with the same names in the same
  cup are *grouped*, never merged: one card, "registered 2×", every entry
  listed with its time and note in the detail panel.
- **Check in uses one entry** (the newest is preselected). The others stay,
  marked "possible duplicate of … checked in at 18:32", until somebody
  presses **Same team — clear it** or **Different team**.
- An entry whose sender said "we are a different team" on the public form is
  its own card with a hint, never grouped.
- **Near matches get a hint only:** a person looking for a partner who is
  already named in another team's entry; somebody who is also in the other
  cup ("also in Doppel").
- **Looking for a partner** is its own section in a doubles cup; matched
  pairs appear as one team card with one Check in.
- **Resolved** at the bottom: cleared duplicates, no-shows, cancellations by
  the registrant, each with **Put back**. Nothing leaves the list without
  landing here.
- Before the doors open the column is "Registered", Check in is hidden and
  No show reads Remove.

### Here

- A walk-in form at the top. Doubles shows two name fields and "No partner
  yet — match them with the next person looking". Names suggest from the
  directory.
- A walk-in whose name matches is told so, never blocked: a matching
  registration offers "Check in the registration instead"; somebody already
  here offers "Show them" or "Add as someone else".
- Filter chips by status with counts.
- Status is read from the console, never set by hand. A player in both cups
  shows where they are ("playing in Doppel · T3").

### Detail

- For a person or team: names, team name, cup, status, and the actions
  valid right now — Sit out / Back in (while playing: after this match),
  Undo check-in or Remove before their first match, Gone home after it,
  Bring back. Moving cup only before their first match.
- For an Expected card: every entry behind it, which one to use, No show per
  entry, Check in.
- When nothing is selected: the activity list and the keys.

## The public site — what changes

Three additions, no redesign. Everything is German, matching the site.

1. **One line on the team form:** "Eine Anmeldung reicht fürs ganze Team."
2. **The duplicate question.** When a team is sent and a waiting entry has
   exactly the same two names in that cup, the send button is replaced by:
   *"Für Lea & Ben gibt es schon eine Anmeldung im Doppel. Kann es sein, dass
   dein:e Partner:in euch schon angemeldet hat?"* with **Ja, dann nicht
   nochmal** / **Nein, wir sind ein anderes Team**. The second sends with
   `distinct: true`. Only an exact match of both names triggers it, and it
   reveals nothing else.
3. **The personal link.** The done card gains the link (`/me/<token>`), a
   copy button and "Dein:e Partner:in muss sich nicht extra anmelden." The
   phone already remembers the registration (`tt_reg` in localStorage); it
   now remembers the token too, so returning shows "Du bist angemeldet —
   Anmeldung ansehen".

`/me/<token>` is one small page in the site's style: the entry, its status,
the note (editable), **Abmelden** with an inline confirmation, and **Doch
wieder anmelden** after cancelling (while registration is open).

## Server changes

- `Registration` gains `token` (random, never sent to anyone but its owner),
  `distinct` (bool), and statuses `duplicate` and `cancelled` beside
  `pending | confirmed | dropped`.
- `register` returns the token. It answers `{"possible_duplicate": true}`
  without writing anything when both names match a pending pair entry in
  the cup and `distinct` is not set.
- New public ops, authorised by the token instead of a key: `reg_view`,
  `reg_note`, `reg_cancel`, `reg_restore`. They touch only that one
  registration. This widens decision rule 2 from "public can only append a
  registration" to "public can append a registration and change or cancel
  its own"; registrations are still not live state, so the rule's point
  holds.
- New desk ops: `reg_same_team` (mark leftovers `duplicate`), `reg_distinct`,
  `reg_restore` (admin/door version). Existing ops are reused for everything
  else (`admit`, `update_registration`, `update_player`, `update_entrant`,
  `set_resting`, `withdraw`, `remove_entrant`, `add_from_directory`).
- `/api/desk` for the desk payload; `/api/state` for admin stops carrying
  registration tokens.
- The `by` field on every event, set from the role in `act`.

## Build order

Each step ships on its own and keeps the old Door tab working.

1. **Door role and `by`.** Third key, op sets, `by` on events, Links tab
   entry. Nothing visible changes except the new link. *Done.*
2. **Desk, read-only.** `/api/desk`, the three columns with real data,
   filter across cups. Proves the payload and the layout on a laptop. *Done.*
3. **Desk actions.** Check in, walk-ins, no-show, detail panel edits, sit
   out / gone home, undo toasts, directory tab, keys; `/d/<key>` opens the
   desk. From here the desk can run an evening. *Done.* Two things from step
   4 came along because they fell out of it: **Put back** under "Taken off
   the list", and the "already here" choice on a second entry with the same
   name (same person — take it off, or someone else — check in as
   "Name (2)").
4. **Duplicates.** Grouping, leftovers, Same team / Different team,
   Resolved with Put back, near-match hints. *Done.* Entries are grouped by
   the same names in the same cup (either order for a team); the panel picks
   which entry a check-in uses, newest by default. What is left once one is
   in is washed amber and asks: same — cleared as `duplicate`, kept under
   Taken off the list; or different — `distinct`, never grouped again, and
   checked in under "Name (2)" if the other is already here. Check in all
   takes one entry per name and skips anything already here.
   `update_registration` now refuses to set `confirmed` or to reopen a
   checked-in entry; undoing a check-in is removing the entrant.
5. **Public additions.** The team-form line, the duplicate question,
   `distinct`.
6. **Personal link.** Token, `/me/<token>`, the public reg ops,
   remembering it on the phone.
7. **Console Door tab shrinks** to counts and a link, after the desk has run
   one real event.

`sim.py` gets a case per step: the door key refused on scoring ops; the
duplicate question on exact matches only; a leftover never disappearing
without `reg_same_team`; a cancelled entry never reaching the pool; tokens
absent from every payload but their owner's.

## Strength

Parked, as everywhere (see `CLAUDE.md`). The desk neither shows nor asks for
it; `admit` keeps sending the directory's or the default number so the
plumbing stays whole.
