# Events, pre-registration and the landing page

The console stops being an evening that is always running, and becomes an
event with a timeline. Pre-registration is the first phase of that timeline.
The landing page, the confirm-at-the-door list, the admin/public split and
the replacement for the reset hotfixes are not four features — they are four
consequences of the timeline existing.

The permanent URL becomes the club's page: upcoming event, register, live
while it runs, results after. The console is one phase of that page rather
than the whole of it.

## The three concepts

**The event has a phase.**

```
announced → registration → doors → live → done
```

Phase picks the content, role picks the controls. The public root shows the
landing page in `announced` and `registration`, today's console in `doors`
and `live`, results in `done`. Admin sees the admin console in every phase,
with a switcher to preview the public view.

The phase is derived, not stored: it follows the registration window and the
event start time, unless an admin has pinned it. Pinning is how you start
early, hold the doors, or put the page back to the landing view.

**A registration is an intent. Attendance is a fact.**

A registration creates no `Player`, no `Entrant`, nothing the dispatcher can
see. At the door you confirm whoever actually showed up, and *that* mints
the player, the entrant and the format entry.

This is the keystone. It makes auto-accept safe — accepted is not playing,
so a junk entry is a row you never confirm rather than a ghost in the
bracket. It makes a correction trivial: someone re-registers with a note,
you confirm one of the two. And a walk-in stops being a special case, it is
just a confirmation with no registration behind it.

**The cup is the unit of entry.**

A registration names exactly one cup. Confirming it puts the entrant in that
cup's **pool**: the one list a cup has. Every way in — a registration, a
walk-in, the directory — says only which cup somebody is in (`entrant.cup_id`),
and asking "which cup?" is mandatory when there is more than one.

The draw is fed from the pool, not the other way round. Each tick
(`dispatch.sync_pools`) makes a cup's draw read its pool: before it starts the
draw's members are exactly the pool; once it is under way they can only grow,
and only if the format can still take somebody. Nothing reaches into a format
by hand, so no path in can forget to. Who is *waiting* is likewise worked out
(`dispatch.sync_queues`): everybody in a running pairing-on-demand draw who is
not on a table and not resting. Sitting somebody out (`rest_set`) is the only
thing an organiser says about the queue.

**The club's directory outlives the event.**

An event clears its roster completely — a person is a human the club knows,
a player is an entry in *this* event. What persists is a directory of people
carrying the strength you tuned by eye last time, because that judgement is
the asset; the name is not, and typing a name is as fast as searching for
one. It is venue-level state, like tables and cups: it lives in the same log
and `event_new` simply does not clear it.

At the door it turns a registrant's claimed 1-10 into a choice between their
claim and last month's settled number, which is how seeding gets good over
three or four events without anything resembling a rating system.

## Decision rules

Details not written down here get resolved by these, not by guesswork.

1. Anything a registrant types is a claim, never authoritative. The
   self-assigned 1–10 is a suggestion, overwritable at the moment of
   confirmation.
2. Nothing public ever writes to live state. The public write path can only
   append a registration. That is the security model; it replaces rate-limit
   theatre.
3. The public pages never call `/api/state`. They get their own minimal
   payload, so nothing admin-shaped can leak and a cold phone on hall wifi
   loads fast.
4. Every new thing is a log event. Undo and Setup → Log keep working by
   construction.
5. The wizard writes the same events the Setup tabs write. One source of
   truth; anything it sets stays correctable afterwards.
6. An event that does not use pre-registration behaves exactly as today.
7. Where a detail is genuinely 50/50, take the reversible option and write it
   down at the bottom of this file.

## Model

`Registration` — derived state like everything else.

```
id, cup_id, kind: single | pair | seeking
name, strength                     # claimed
partner_name, partner_strength     # kind = pair
team_name                          # kind = pair, optional
note                               # "Anything you want to tell us?"
status: pending | confirmed | dropped
entrant_id                         # set on confirmation
created_seq
```

`Cup` gains:

```
entry: single | pair             # what the form asks for
registration: open | closed
format_id                        # where confirmations land
```

`store.event` gains `starts_at`, `blurb`, `phase_pin`, and an `id` for the
current span of the log.

## Events

| Event | Written by | Does |
|---|---|---|
| `event_new` | wizard | Marks a new span. Clears evening-level state — players, entrants, matches, queue, registrations, format instances. Carries forward tables, cups, scoring defaults. |
| `event_meta` | wizard, Setup → Event | Name, blurb, start time, phase pin. Already exists; gains fields. |
| `cup_add` / `cup_update` | wizard, Setup → Cups | Gains the registration block. |
| `registration_add` | **public**, level 0 | The only public write. |
| `person_*` | admin | The club directory. Venue-level: `event_new` leaves it alone. |
| `registration_update` | admin | Revise a claimed strength or name; drop an entry. |

Confirmation is not a new event. It appends `player_add`, `entrant_add`
(carrying `cup_id`) and a `registration_update` recording the resulting
`entrant_id`. The draw picks the entrant up from the pool on the next tick
(a logged `format_update` when its member list changes). `rest_set` sits an
entrant out or brings them back.

`event_new` replaces both `players_reset` and `reset_event`. The log is never
truncated, so rewind still crosses the boundary, and because each event is a
marked span, a real multi-event entity later is additive rather than a
rewrite.

## Routes

| Route | Serves |
|---|---|
| `/` | Phase-dependent: the site in `announced`/`registration`/`done`, the console in `doors`/`live`. |
| `/join` | The registration form. Closed registration says so and links to the live page. |
| `/api/public` | Landing payload: event name, blurb, start time, open cups and their entry type. No names, no counts, no strengths. |
| `/api/action` | Unchanged, except `register` is the one op at level 0. |
| `/r/<key>`, `/a/<key>` | Unchanged. |

The public site is `tt/static/site.html` + `site.js`, separate from the
console SPA — structurally incapable of leaking admin markup, and a fraction
of the payload.

## Screens

**The site.** Event name, blurb, date and start time, a countdown to the
switch, a card per open cup showing its name, format and entry type, and a
register button. One open cup skips the picker.

**The form.** Cup, then name and strength 1–10. For a pairs cup: both names
and strengths, an optional team name, or *Looking for a partner* which
submits as a single. Then the notes box, then submit. A confirmation screen
and a local token, so returning on the same phone says "you're registered"
rather than silently duplicating.

**Setup → Entries.** The pre-registration list, with the claimed strength
editable inline and a Confirm button per row. Becomes the door list on the
night. Add-walk-in sits at the top of the same list. Pending count badges the
Setup button.

**Setup → Event.** Name, blurb, start time, phase pin, and the New event
button.

**The wizard.** Event basics → cups (name, entry type, format and its
settings, registration on/off) → tables → review. Tables and cups default to
last time's, which is what stops it being a weekly chore.

## Build order

The wizard comes first, and everything else is built on top of it. That is
not a scheduling preference — it decides the shape of the code. The wizard is
the CMS for the site: it authors the event, the cups and the copy that the
landing page renders. Building registration first would mean writing the
config by hand in Setup tabs and then retrofitting an authoring layer over
it; building the wizard first means every later feature is configured the
moment it exists.

- **A — The spine.** Phase, the event fields the site will advertise
  (blurb, venue, start time), `event_new` replacing both resets,
  phase-driven root.
- **B — The wizard.** Guided new event: basics and copy, cups with entry type
  and format, tables, review. Carry-forward from last time. Replaces the
  danger-zone resets with the operation you actually wanted.
- **C — The site.** The landing page rendering what the wizard authored:
  event details, countdown, cup cards. This is the advertising surface.
- **D — Registration.** `/join`, the public payload, the level-0 op. The
  register button on the site lights up here.
- **E — The door.** Setup → Entries, confirmation, walk-ins, and the
  club directory that confirmation matches against.

A–C is a page you would send people to before a single registration exists.
D–E is the pre-registration feature proper. Each step ships something
visible on its own.

Later, deliberately not now: waitlists and caps, entry codes, pairing up the
"looking for a partner" pool, a multi-event picker, German or bilingual copy.

## Decisions taken under rule 7

- English throughout for now, including the public site.
- The landing page publishes no entry list and no counts.
- Registration is auto-accepted; there is no approval step, because
  confirmation at the door already is one.
- Confirming into a format that has already started works only where the
  format allows it (Swiss, open play); otherwise the entrant stays in the cup's
  pool with status "no draw" and the door says why.
- A second draw in the same cup (a consolation bracket, say) reads the same
  pool. There is no per-draw entrant picker any more; that was a second source
  of truth.
- Draws outside any cup keep an explicit `entrant_ids` and are queued only
  from it (and from whichever queue somebody came out of).
- A second registration from the same phone is allowed, not blocked — the
  notes box is the correction channel, and you resolve it at the door.
- `event_new` keeps tables and cup definitions, drops format instances.
- The roster does not carry forward and the wizard offers no "keep players"
  checkbox. The directory is the answer to "the same forty faces".
- The wizard is authoritative over cups: it clears them and writes the ones
  it was given, rather than merging into what was there.
- Duplicates are allowed at public registration and checked at the door, where
  somebody can tell two people apart. Singles: a name already in tonight's pool
  blocks the save until it is made distinct ("Jana Berger (blue shirt)"). Doubles:
  only the same two people together are a duplicate.
- "Looking for a partner" entries are matched first-come, first-matched, and the
  match is written to the log (`matched_with`), so what the door told somebody
  stays true. A matched team is one row, one confirm; dropping one of the two
  sets the other looking again.
- Removing somebody from the pool is only possible before they have been drawn
  into a match or a started draw; after that it is Sit out. A confirmed
  registration goes back on the pre-registered list.
