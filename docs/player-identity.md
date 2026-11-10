# Player identity across cups

The next event lets one person play in several cups. That makes one
question unavoidable, and the console currently answers it by guessing:
**is this the same human as somebody already playing tonight?**

- *One person, two cups.* Max plays Open singles and Doubles. He must never
  be called to two tables at once, his Telegram calls and his own page must
  cover both, and "gone home" must be able to reach both.
- *Two people, one name.* A Max in Open singles and a different Max in U18.
  They must never block each other, never share a Telegram link, and never
  be mixed up on the wall.

Today both are handled wrongly, in opposite directions:

- Every admission mints a fresh `Player`, and `busy_players` compares player
  ids, so the same person in two cups is two strangers to the dispatcher and
  gets seated twice (`sim.py` `test_one_person_two_cups` asserts exactly
  that).
- `_person_for` links every new player to whoever in the directory has the
  same name (`person_by_name`), so two different Maxes share one person and
  one Telegram account. This is why `busy_players` stopped using the person
  id: it made namesakes block each other.
- The duplicate checks (`solo_named`, `pair_named`, the desk's `clashFor`,
  "already in this event" in `op_add_from_directory`) run over the whole
  event, so a second singles cup, or the same pair in a second doubles cup,
  is refused outright. The way round they suggest ("Max (2)") makes a second
  directory entry and splits the person in two.

## The rule

**Identity is decided by evidence or by the desk, never by a name alone.**

A name match is a reason to ask, not an answer.

## Model

No new entities. The pieces already exist; what changes is how far they can
be trusted.

- `Person`: who somebody is. It outlives the event, as now.
- `Player`: one per entry, as now. `player.person_id` becomes **the identity
  for tonight**. Two players with the same `person_id` are one human.
- `Entrant`: one per cup entry, as now.

Invariants, enforced at every way in:

1. **One person, one entry per cup.** A person may not be in two active
   entrants of the same cup, whether singles or as either member of a pair.
2. **One name, one person tonight.** Two different people playing tonight
   never share a display name (`name_key`). This holds in doubles cups too,
   which today skip the check. The wall, the scoresheet and the referee
   phone can then never be ambiguous.
3. **The dispatcher holds back people, not entries.** `busy_players` returns
   the person ids on a table (player id for a player without a person), and
   `entrant_available` checks the same. One human is never on two tables.

The rejected alternative was one shared `Player` across a person's
entrants. It also works, but it changes what `entrant_remove`, renames and
match history assume. The person id gives the same result with plumbing that
already exists, and merge/split become an ordinary `player_update` of
`person_id`.

## Deciding identity: the evidence ladder

Each name slot of an admission is decided on its own: the single, or each of
the two names of a pair. That covers the door (`admit`), console add player
and add team, and add from directory. Take the first rung that applies.

| # | Evidence | Result |
|---|---|---|
| 1 | The request says so: `same_as: <player_id>` (the desk answered "same"), or a new name with `distinct: true` | Do what it says |
| 2 | **Witnessed key matches.** The registration's `tg_id` is the Telegram account of a person already playing tonight, or its `person_id` is, or its `holder` (below) is shared with an already confirmed registration | **Same person**, automatically |
| 3 | **Witnessed keys conflict.** Both sides carry a Telegram account and they differ | **Different person**. No question; they need a distinguishing name (invariant 2) |
| 4 | Name matches a person already playing tonight, nothing else known | **Ask.** Nothing is written |
| 5 | Name matches nobody tonight | New player. The person comes from the directory as now (`_person_for`) |

At rung 2 or 4, if the person is already in *this* cup, admission is refused:
"Max is already in Open singles". Invariant 1.

Automatic answers (rung 2) are shown on the entry as "same person as in
Open singles · via Telegram" and can be undone with Split. They are evidence,
not a registrant's claim, but the desk still sees them.

### The question

On a rung-4 match, the server writes nothing and returns:

```json
{"ask": "same_person",
 "slot": "a",                       // a = the name, b = the partner
 "name": "Max",
 "player_id": "P3",
 "cups": ["Open singles"]}
```

The desk (and the console's add form) puts it to the organiser:

> **Max is already playing in Open singles. Same person?**
> [ Yes, same Max ]   [ No, someone else ]

- **Yes**: resend with `same_as: {"a": "P3"}`. The new player takes
  `person_id` of P3.
- **No**: the desk asks for a name that tells them apart, prefilled from
  `freeName` ("Max (2)"), and resends with that name and `distinct: {"a":
  true}`. Resending the *same* name with `distinct` is refused (invariant 2).

A pair with both names known tonight asks once per name.

The answer is symmetric: whichever cup Max is checked into first, the second
check-in asks.

## The web form's identity key: `holder`

New field `Registration.holder`, never sent to the public side.

- The landing page already keeps this event's earlier tokens in
  `localStorage` (`tt_regs`). It sends them with the next sign-up as `prev`.
- `_take_registration` looks up those registrations. If one has the **same
  name** (`name_key`) as the new entry, the new one takes its `holder`.
  Otherwise it gets a fresh one.
  The name condition is what keeps a family phone (a parent registering
  two children) from linking different people.
- Unknown or wrong tokens are ignored without a word, so the field reveals
  nothing about other entries.
- At the door, rung 2 applies: if a registration with the same `holder` was
  already confirmed, this one is the same person.

From Telegram the account is the key already (`tg_id`), so no `holder` is
needed. A web entry later opened in the bot (`tg_attach`) gets the account
as well.

### Partners

The partner named in a pair entry starts with no key: only the registrant
filled in the form. Three things close the gap, cheapest first.

**1. Most of the time there is no question at all.** The ladder only asks
when the name is already playing tonight. A partner who plays only in this
doubles cup is rung 5, a new player, and nothing is asked.

**2. When it does ask, the partner is standing there.** A pair checks in
together. The door has the person in front of it, which is better evidence
than any key, so the question costs one tap. The likely answer is "same":
somebody already in Open singles also playing doubles is exactly the case
this event is for. So when the matched person is checked in tonight,
"Yes, same" comes first and is highlighted. It is still a question, never
assumed, because two people with one name is the case that must not be
merged.

**3. The partner can pick up their own key, if they want to.** A pair
entry gets a second secret, `partner_token`, next to `token`:

- The confirmation (web and bot) offers "Send this to Tom", a link the
  registrant forwards: `/me/<partner_token>` on the web, `p2_<partner_token>`
  in the bot.
- Opening it in the bot sets `partner_tg_id`. Opening it in the browser
  stores the token in that browser's `tt_regs`, so Tom's own later sign-ups
  carry it as `prev` and give him a `partner_holder` key.
- Tom's view of the entry is read-only, apart from the Telegram link and
  "I'm not playing": that writes a note for the desk and cancels nothing.
  The entry still belongs to the registrant.
- At the door, `partner_tg_id` and `partner_holder` are rung-2 evidence for
  the partner slot, the same as the registrant's keys are for theirs.
- Side benefit: Tom gets table calls on Telegram from the first match,
  rather than only once the door has linked him.

It is opt-in. Nothing breaks if the link is never forwarded; the door asks,
as above.

**When the partner registered too.** If Tom also signed up himself in
another cup, his own registration has a key, but the pair entry only has
his name. A name pointing at a keyed registration is still only a name, so
the door asks (case 2). If Tom signed up for the *same* doubles team, the
existing duplicate handling (`_team_entered`, `_carry_tg`) already folds
the two together and carries his Telegram account across.

## Renames

`op_update_player` today re-points the player at whoever the new name is in
the directory (a substitution) or makes a new person. With a person in
several cups that is ambiguous, so when the player's person plays in another
cup tonight the console asks:

> **Rename Max in Open singles only, or everywhere?**
> [ Fix the name everywhere ]   [ Someone else is stepping in here ]

- **Everywhere** (a typo): `player_update` of the name on every player of
  that person tonight. `person_id` stays the same, and the person's
  directory name is updated.
- **Someone else**: this player only. The new name then goes through the
  ladder like an admission, rungs 4 and 5.

A person playing in only one cup keeps today's behaviour.

## Wanted by two cups at once

A true double call cannot happen: the dispatcher seats one table per pass
and recomputes who is busy each time, so once the first match takes Max,
the second simply cannot. The real question is what happens to the second.

**It keeps its place and is skipped while he plays. It does not go to the
back.**

- Sending it to the back would punish everyone who plays in two cups, and
  their opponents as well. Over an evening it costs them matches in the
  second cup every single time.
- In a fixed draw (groups, Swiss, knockout) the back of the line helps
  nobody. The round still cannot close without that match, so pushing it
  back only makes the cup finish later. Meanwhile the dispatcher already
  seats whatever else in that cup is ready, so the table is not wasted.
- The existing Put back (`match_defer`) stays for the organiser to use by
  hand.

Two soft rules stop the rebound, where Max finishes one match and is
immediately called to the next:

1. **Alternate.** When a free person is wanted by more than one cup, prefer
   the cup he did not just play in. Otherwise cup ranking decides, as
   now: scheduled draws before open play, and the cup furthest from
   finishing first.
2. **Breather.** For a short time after a match (setting, default 2
   minutes), a person is only called if nothing else can use the table.
   An idle table is still worse than a tired player, which is the same
   trade the strength tolerance already makes (`force` in `dispatch.tick`).

What everyone sees:

- Up next and the desk show "playing in Open singles, T3" instead of a
  plain blocked row.
- His opponent's waiting time takes Max's current match into account.
- Telegram tells Max "Doubles next, after your singles match".

## Gone home and sitting out

- **Gone home** (`op_withdraw`) gains `everywhere: true`. The desk and
  console offer it when the person has other active entries: "Gone home
  from all 2 cups". It withdraws every entrant of that person and settles
  all their owed fixtures as walkovers, as it does today for one.
- **Sit out** (`rest_set`) stays per entry. Resting from the singles to
  play the doubles is a real thing to want.

## Fixing a wrong answer

Two desk actions, both plain `player_update` events, so Undo and the log
cover them:

- **Merge** "these two are the same person": set the second player's
  `person_id` to the first's. Refused if both are on a table right now, or
  both are in the same cup (invariant 1). If their names differ, the second
  takes the first's name.
- **Split** "these are two people": the desk asks for a distinguishing
  name, and the player gets a new person (`person_add`) under it.

A wrong "same" shows itself fast: one Max waits for a table that the other
Max is holding. A wrong "different" shows as one person called to two
tables. Both are visible on the desk, and both are a single tap to fix.

## Personal views and Telegram

Nothing new needed. `notify`, `me.py` and the bot already work by
`person_id` and gather every entry of a person. They become correct once
`person_id` is.

One fix on the way: `who()` in `tt/bot.py:340` takes `e.player_ids[0]` for a
Telegram registration that was confirmed before the account was linked. For
a pair entered by the partner that is the wrong person. Use the player whose
name matches the registration's `name`, as `_carry_tg` already does.

## What does not change

- Replay. Dispatcher decisions are logged `match_assign`s, so old logs
  replay as they were. The new busy rule only affects seating from the
  moment it is deployed.
- Strength stays parked (CLAUDE.md). Each entry keeps its own stored number.
- Across events the directory still links a returning name to its person
  by exact name (`person_by_name`). A wrongly shared person from the past
  is caught tonight by rung 4 the moment a second same-named person turns
  up, so it cannot block anybody.

## Deploying

Deploy between events. An event already under way may have namesakes
sharing a person id from the old name lookup, and the new busy rule would
make them block each other for the rest of that night.

## Tests (`sim.py`)

- `test_one_person_two_cups`: rewrite to assert the person is **never** on
  two tables at once, and that both cups still finish.
- Two singles cups, one person: the second check-in asks. "Same" links them
  and they are never seated twice.
- Two different Maxes, one per cup: "different" forces a new name. Both are
  seated at the same time; separate people, separate Telegram.
- Telegram: the same account in two cups links without a question. Two
  different accounts with the same name are refused the "same" answer.
- Web `holder`: a second sign-up from the same browser, same name, links.
  A different name from the same browser does not.
- Same person twice in one cup: refused. Same pair in two doubles cups:
  allowed.
- Rename everywhere vs substitution. Gone home everywhere. Merge, Split,
  and Undo of each.
- Removing one of a person's entries leaves the other intact.
- Wanted by two cups: the second match keeps its place and is seated as soon
  as he is free. He alternates cups. The breather yields to anyone else ready,
  but never leaves a table idle.
- Partner link: opening `p2_<partner_token>` in the bot links that partner
  without a question, and they get table calls. A partner with no link who
  already plays tonight is asked at the door, with "same" highlighted. A
  partner who plays nowhere else tonight is not asked.
