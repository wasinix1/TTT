/* Table tennis console — client.
   Polls /api/state, re-renders, keeps score drafts alive across renders. */

const TOKEN = (() => {
  const m = location.pathname.match(/^\/[ar]\/([^/]+)/);
  return m ? m[1] : '';
})();

/* The sandbox. This same console, pointed at a throwaway copy of the event —
   see tt/simulate.py. Every request the tab makes carries the flag, so the
   store it talks to is decided per request rather than being a mode the tab
   is left in: there is no state to go stale and no way to end up entering a
   real result into a simulated evening or the other way round. */
const SIM = new URLSearchParams(location.search).get('sim') === '1';
/* A past event, opened read-only from More → Past events. Same idea as the
   sandbox: the target rides on every request, and the server refuses writes
   to it, so the read-only-ness does not depend on this file hiding buttons. */
const PAST = new URLSearchParams(location.search).get('past') || '';
const simq = sep => (SIM ? sep + 'sim=1' : PAST ? sep + 'past=' + encodeURIComponent(PAST) : '');

// Strength is parked: hidden everywhere, still stored and still used by the
// matchmaker at its default. Flip to bring the inputs back.
const SHOW_STRENGTH = false;

let S = null;              // last state
let drafts = {};           // matchId -> [[a,b], ...]
let sheetTab = 'people';
let sheetOpen = false;
const form = {};           // sticky admin form values

// which match's score is open in the editor: a fixture being entered
// straight off the board, or a finished one being put right
let editing = null;

// manual result entry — a match that never touched the queue or a table
let manualDraft = { a: '', b: '', format_id: '', bo: 3, pts: 11 };
let manualGames = [['', '']];
let manualOpen = false;
let recentAll = false;     // Results panel: show every result, not the latest
let recentQuery = '';      // Results panel: name filter

// which cup this browser is looking at — per-viewer, not shared with the
// server, so admin and every spectator can each pick their own
// the sim keeps its own, so switching cups in the sandbox does not move the
// real console's tab out from under whoever is running the night
const CUP_KEY = SIM ? 'tt_cup_sim' : PAST ? 'tt_cup_past' : 'tt_cup';
let selectedCup = localStorage.getItem(CUP_KEY) || '';
function setCup(id) {
  selectedCup = id || '';
  try { localStorage.setItem(CUP_KEY, selectedCup); } catch (e) { }
  render();
}
// true if an item with this cup_id (null = shared/ungrouped) belongs in the
// current view: shared items always show, cup-specific ones only in "All"
// or their own tab
const inView = cupId => !selectedCup || cupId == null || cupId === selectedCup;

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// a past event has neither: nothing in it can be entered, paused or put back
const isAdmin = () => S && S.role === 'admin' && !PAST;
const canScore = () => S && !PAST && (S.role === 'admin' || S.role === 'referee');

/* ------------------------------------------------------------------ net */

async function api(op, data) {
  const r = await fetch('/api/action' + simq('?'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Key': TOKEN },
    body: JSON.stringify({ op, data: data || {} }),
  });
  const j = await r.json().catch(() => ({ error: 'bad response' }));
  if (!r.ok) { toast(j.error || 'That did not work'); return null; }
  await poll(true);
  return j;
}

let lastVersion = -1, polling = false, etag = null, dead = false;
const ticks = [];
async function poll(force) {
  if (polling || dead) return;
  polling = true;
  try {
    const h = { 'X-Key': TOKEN };
    if (etag && !force) h['If-None-Match'] = etag;
    const r = await fetch('/api/state?token=' + encodeURIComponent(TOKEN) + simq('&'),
                          { headers: h });
    if (r.status === 404 && (SIM || PAST)) return simGone();
    if (r.status === 304) return;
    etag = r.headers.get('ETag');
    const s = await r.json();
    if (force || s.version !== lastVersion) {
      lastVersion = s.version;
      S = s;
      render();
    }
  } catch (e) { /* transient; the next tick will catch up */ }
  finally { polling = false; }
}

/* Live updates over server-sent events: the server pushes a version number
   the instant anything changes, and we only refetch state when it moves.
   Polling stays on as a slow safety net for networks that eat SSE. */
let stream = null, streamOk = false;
function connectStream() {
  try {
    stream = new EventSource('/api/stream' + simq('?'));
  } catch (e) { return; }
  stream.onopen = () => { streamOk = true; };
  stream.onmessage = e => {
    streamOk = true;
    if (+e.data !== lastVersion) poll();
  };
  stream.onerror = () => {
    streamOk = false;
    stream.close();
    setTimeout(connectStream, 3000);   // EventSource retries, but be explicit
  };
}

/* The sandbox is torn down from the real console, which can happen while this
   tab is open. Say so and stop, rather than retrying into a 404 forever. */
function simGone() {
  const b = $('sim-bar');
  if (b) { b.hidden = false; b.className = 'sim-bar over'; b.textContent = PAST
    ? 'This past event is no longer available (rewound, or the link is not an admin one). Close the tab.'
    : 'This sim has been stopped from the real console. Close the tab.'; }
  if (stream) { stream.close(); stream = null; }
  ticks.forEach(clearInterval);
  dead = true;
}

/* The toast: what just happened in bold, what it means under it, and Undo
   when it can be taken back — the TTT Admin toast. Called with one string it
   is the plain note it always was. */
let toastUndo = null;
function toast(msg, sub, undo) {
  const t = $('toast');
  t.innerHTML = `<span class="tt2"><b>${esc(msg)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</span>${
    undo ? '<button class="tundo" type="button" data-act="toast-undo">Undo</button>' : ''}`;
  toastUndo = undo || null;
  t.classList.toggle('rich', !!(sub || undo));
  t.hidden = false;
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.hidden = true; toastUndo = null; }, undo ? 5000 : 3800);
}

/* On a touch screen there is no hover, so the actions a mouse finds by
   hovering a row (Edit result, Seat now · Sit out · Enter result, a
   knockout match's Edit) stay out of sight until the row is tapped: the row
   takes a faint ground and its actions open on a line beneath it. Tapping
   it again, or another row, closes it; doing one of them closes it too. The
   open row survives the redraws a result or a poll brings. */
const touch = () => matchMedia('(hover: none)').matches;
let tapKey = null;
const tapKeyOf = el => { const b = el.querySelector('[data-m],[data-e]'); return b ? (b.dataset.m || b.dataset.e) : null; };
function applyTap() {
  document.querySelectorAll('#live .tapped').forEach(x => x.classList.remove('tapped'));
  if (!tapKey) return;
  for (const el of document.querySelectorAll('#live .hoverable, #live .kc'))
    if (tapKeyOf(el) === tapKey && el.querySelector('.on-hover, .ac')) { el.classList.add('tapped'); return; }
}
document.addEventListener('click', e => {
  if (!touch()) return;
  if (e.target.closest('.tapped [data-act]')) { tapKey = null; return; }
  if (e.target.closest('button, a, input, select, label, textarea, summary')) return;
  const row = e.target.closest('#live .hoverable, #live .kc');
  if (!row || !row.querySelector('.on-hover, .ac')) return;
  const k = tapKeyOf(row);
  tapKey = tapKey === k ? null : k;
  applyTap();
});
addEventListener('DOMContentLoaded', () => {
  const live = $('live');
  if (live) new MutationObserver(() => { if (tapKey) requestAnimationFrame(applyTap); })
    .observe(live, { childList: true, subtree: true });
});

/* ----------------------------------------------------------------- modes

   The admin's console is three rooms behind one switch: Live (the tables and
   everything about the play), Door (the registration desk, embedded — the
   same page the door key opens) and Setup (the evening's shape). Referees and
   the public only ever have Live. The mode rides in the URL hash so a reload
   lands where it was. */

let mode = 'live', modeSet = false;
function setMode(m, quiet) {
  if (m !== 'live' && !isAdmin()) m = 'live';
  mode = m;
  $('live').hidden = m !== 'live';
  $('door').hidden = m !== 'door';
  sheetOpen = m === 'setup';
  $('sheet').hidden = !sheetOpen;
  document.body.dataset.mode = m;
  if (m === 'door') openDesk();
  if (!quiet) {
    try { history.replaceState(null, '', location.pathname + location.search + (m === 'live' ? '' : '#' + m)); } catch (e) { }
  }
  if (S) render();
  scrollTo({ top: 0 });
}

/* The desk is its own page with its own payload (/api/desk, see desk.js),
   so it is framed rather than re-implemented: one door, two ways in. */
function openDesk() {
  const box = $('door');
  if (box.firstElementChild) return;
  const src = location.pathname.replace(/\/$/, '') + '/desk?embed=1' + (SIM ? '&sim=1' : '');
  box.innerHTML = `<iframe id="desk-frame" title="Registration desk" src="${esc(src)}"></iframe>`;
}

function renderModes() {
  const nav = $('modes');
  nav.hidden = !isAdmin();
  if (nav.hidden) return;
  const waiting = (S.registrations || []).filter(r => r.status === 'pending').length;
  const unread = tgOn() ? S.telegram.unread : 0;
  nav.innerHTML = [['live', 'Live'], ['door', 'Door'], ['setup', 'Setup']].map(([k, l]) =>
    `<button type="button" data-mode="${k}" class="${mode === k ? 'on' : ''}" aria-pressed="${mode === k}">${l}${
      k === 'door' && waiting ? ` <span class="count" title="${waiting} still expected">${waiting}</span>` : ''}${
      k === 'setup' && unread ? ` <span class="count" title="${unread} unread on Telegram">${unread}</span>` : ''}</button>`).join('');
}

/* Where the evening is, as a stepper — in Setup → Event, where it is set.
   A step pins the evening there; "Follow the clock" lets the start and end
   times move it again. Changing it has consequences (the public URL turns
   into the console or back), which is why it lives in Setup and not in the
   header. */
const PHASES = ['announced', 'registration', 'doors', 'live', 'done'];
function phaseStep() {
  const at = PHASES.indexOf(S.phase);
  const pinned = !!(S.event || {}).phase_pin;
  return `<div class="phase-step" role="group" aria-label="Phase">${PHASES.map((p, i) => `${i ? '<i></i>' : ''}<button type="button" data-phase-pin="${p}"
      class="${i === at ? 'on' : i < at ? 'past' : ''}" aria-pressed="${i === at}" title="${i === at ? (pinned ? 'Pinned here' : 'Here, following the clock') : 'Pin the evening to ' + esc(cap(p))}">${esc(cap(p))}</button>`).join('')}</div>`;
}
const cap = s => { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); };

/* "Thu 2 Oct · 19:00 · Prater Halle" — what the bar says under the name. */
function whenLine() {
  const ev = S.event || {};
  const bits = [];
  const d = ev.starts_at ? new Date(ev.starts_at) : null;
  if (d && !isNaN(d)) {
    bits.push(d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }));
    bits.push(d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0'));
  }
  if (ev.venue) bits.push(ev.venue);
  return bits.join(' · ');
}

/* --------------------------------------------------------------- render */

function render() {
  const focus = document.activeElement;
  const fid = focus && focus.id ? focus.id : null;
  const sel = focus && focus.selectionStart != null ? focus.selectionStart : null;

  $('ev-name').textContent = S.event.name || 'Table tennis';
  $('ev-when').textContent = whenLine();
  const base = PAST ? 'Past event' : S.role === 'admin' ? 'Admin' : S.role === 'referee' ? 'Referee' : 'Live';
  // the admin sets the phase in Setup → Event; the referee sees it here
  $('role-tag').textContent =
    (S.phase && S.phase !== 'live' && S.role === 'referee' && !PAST)
      ? base + ' · ' + S.phase : base;
  $('role-tag').className = 'role-tag ' + (PAST ? 'past' : S.role);
  if (!modeSet) {                // a reload keeps the mode it was in
    modeSet = true;
    const h = location.hash.slice(1);
    if (h === 'door' || h === 'setup') return setMode(h, true);
  }
  renderModes();

  renderNudge();
  refShell();
  renderCupTabs();
  renderTables();
  renderBelow();
  renderEditor();
  renderManual();
  renderRecent();
  refFolds();
  renderJump();
  spyJump();
  if (sheetOpen) renderSheet();

  if (fid) {
    const back = document.getElementById(fid);
    if (back) {
      back.focus();
      if (sel != null && back.setSelectionRange) {
        try { back.setSelectionRange(sel, sel); } catch (e) { }
      }
    }
  }
}

/* -- v2: the phone's section bar ---------------------------------------- */

/* Counts and visibility follow what actually rendered; the sticky offset
   follows the bar and cup tabs above it, which change height with the
   event name and the number of cups. */
function renderJump() {
  const nav = $('jump');
  if (!nav) return;
  const has = id => { const el = $(id); return !!el && el.innerHTML.trim() !== ''; };
  nav.querySelectorAll('a[data-to]').forEach(a => { a.hidden = !has(a.dataset.to); });
  const n = (S.board || []).filter(b => inView(b.cup_id)).reduce((s, b) => s + (b.total || 0), 0);
  const c = nav.querySelector('.count');
  if (c) c.textContent = n ? String(n) : '';
  // the section bar sticks directly under the header, and only there. It
  // used to add the cup strip's height too, which (the strip not being
  // sticky) left the bar floating a strip's height down the screen, over
  // whatever scrolled beneath it.
  const bar = document.querySelector('.bar');
  const top = (parseFloat(getComputedStyle(bar).top) || 0) + bar.getBoundingClientRect().height;
  document.documentElement.style.setProperty('--jump-top', Math.round(top) + 'px');
}

function spyJump() {
  const nav = $('jump');
  if (!nav || getComputedStyle(nav).display === 'none') return;
  const line = nav.getBoundingClientRect().bottom + 8;
  const links = [...nav.querySelectorAll('a[data-to]:not([hidden])')];
  let on = links[0] || null;
  for (const a of links) {
    const el = $(a.dataset.to);
    if (el && el.getBoundingClientRect().top <= line) on = a;
  }
  links.forEach(a => a.classList.toggle('on', a === on));
}
addEventListener('scroll', spyJump, { passive: true });
addEventListener('resize', () => { if (S) { renderJump(); spyJump(); } });

/* -- the cup strip ------------------------------------------------------

   One strip that is both the progress and the filter: Everyone, then one
   tile per cup with how far it has got. Two to four sit in a row, more wrap,
   one cup is a single tile (and no Everyone). A draw that knows its matches
   shows a fraction and a bar; open play has no total, so it says how many
   are playing and how many have been played. Clicking the open cup again
   goes back to Everyone. */

const nm = name => String(name ?? '').split(' / ').join(' & ');
/* In lists a pair is its two first names ("Jonas & Ana"), as on the phone
   page; a team name somebody chose stays whole. On the table faces and at
   the door, names are given in full. */
const sidesOf = name => String(name ?? '').split(' / ').map(x => x.trim()).filter(Boolean);
const nice = name => { const p = sidesOf(name); return p.length > 1 ? p.map(x => x.split(/\s+/)[0]).join(' & ') : (p[0] || ''); };
/* Every list is five rows, then "+ N more"; a standings table is ten. */
const LIST_ROWS = 5, TABLE_ROWS = 10;   // "A / B" -> "A & B"

function tablesLabelOf(b) {
  if (!b) return '';
  const nums = (b.tables || []).slice().sort((x, y) => x - y);
  if (!nums.length) return 'no table';
  if (!b.reserved && nums.length === S.tables.length) return 'all tables';
  const runs = [];
  let a = nums[0], p = nums[0];
  for (const n of nums.slice(1)) { if (n === p + 1) { p = n; continue; } runs.push([a, p]); a = p = n; }
  runs.push([a, p]);
  const txt = runs.map(([x, y]) => x === y ? x : `${x}–${y}`).join(', ');
  return (nums.length === 1 ? 'table ' : 'tables ') + txt;
}

/* Several reserved tables standing empty for the same reason are one note,
   not a stack of identical ones: "Tables 2, 3, 7 and 8 are reserved…" */
function idleNotes(idle) {
  const groups = new Map();
  idle.forEach(w => {
    const k = w.waiting_for.join(' and ');
    if (!groups.has(k)) groups.set(k, { who: w.waiting_for, tables: [] });
    groups.get(k).tables.push(w.table);
  });
  const and = xs => xs.length < 2 ? String(xs[0]) : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1];
  return [...groups.values()].map(g => `<div class="warn">
      ${g.tables.length > 1 ? 'Tables ' + esc(and(g.tables)) + ' are' : 'Table ' + esc(g.tables[0]) + ' is'} reserved and standing empty while
      ${esc(g.who.join(' and '))} ${g.who.length > 1 ? 'have' : 'has'}
      people waiting.
      <div class="inline">${g.tables.map(t => `<button class="primary tiny" data-act="lend-table"
        data-t="${t}">Share table ${esc(t)} for 1 game</button>`).join(' ')}</div></div>`).join('');
}

function cupProgress(cid) {
  const f = S.formats.find(x => (x.cup_id || '') === (cid || '') && x.status !== 'setup')
    || S.formats.find(x => (x.cup_id || '') === (cid || ''));
  const b = (S.board || []).find(x => (x.cup_id || '') === (cid || ''));
  const done = S.recent.filter(m => (m.cup_id || '') === (cid || '') && !(m.meta && m.meta.bye)).length;
  const playing = S.tables.filter(t => t.match && (t.match.cup_id || '') === (cid || '')).length;
  const open = !f || f.uses_queue || f.kind === 'open_play';
  return { f, b, done, playing, total: open ? null : done + playing + (b ? b.fixtures : 0) };
}

function renderCupTabs() {
  const bar = $('cup-tabs');
  if (!S.cups.length) { bar.hidden = true; selectedCup = ''; return; }
  if (selectedCup && !S.cups.some(c => c.id === selectedCup)) selectedCup = '';
  const n = S.cups.length;
  // one cup: nothing to switch between, so no switch
  bar.hidden = n < 2;
  if (n < 2) { selectedCup = ''; return; }
  bar.className = 'strip' + (n === 1 ? ' one' : n > 4 ? ' many' : '');
  bar.style.setProperty('--n', n);
  /* A switch, not a scoreboard: the cup's name, centred, and nothing else. The counts that used to sit here ("4 playing",
     "9 up next", "22 / 23 played", the format, the tables) each already have
     their place below, in the Tables header, Up next and the cup's own
     column, so here they were only noise. The numbers stay in the tooltip. */
  const tile = (id, name, frac, on, cls, tip) => `<button type="button" class="${cls || ''}${on ? ' on' : ''}"
      data-cup="${esc(on && n > 1 ? '' : id)}" aria-pressed="${!!on}"${tip ? ` title="${esc(tip)}"` : ''}>
      <span class="t"><span>${esc(name)}</span></span></button>`;
  bar.innerHTML = (n > 1 ? tile('', 'Everyone', null, !selectedCup, 'all') : '')
    + S.cups.map(c => {
      const p = cupProgress(c.id);
      const tip = p.total ? `${p.done} of ${p.total} played` : `${p.done} played · open play`;
      return tile(c.id, c.name, p.total ? p.done / p.total : null, selectedCup === c.id || n === 1, '', tip);
    }).join('');
}

/* -- tables ------------------------------------------------------------

   Every table is the table from Focus and the spectator view: painted red,
   one side of the net per side of the match, the number on the net. On a
   console that can score, each side carries its games as cells painted onto
   it, so a result is typed the way it is read out — "eleven eight" — and the
   winner of each game shows at a glance. Every live table is the same full
   red: nothing is greyed while it is being played. Free, paused, and
   reserved-but-finishing-another-cup's tables are dashed outlines. */

function renderTables() {
  const all = S.tables;
  // A table belongs to the cup of the match on it, not only to its tag.
  // Retagging a table mid-match (Cup A -> Cup B) used to show A's match,
  // score pad and all, in B's tab and drop it from A's, so A's referee
  // could not find it. A busy table follows its match; a free one follows
  // its tag. B still sees its own table, just not A's players on it.
  const vis = S._visibleTables = all.filter(t => t.match
    ? inView(t.match.cup_id) || (t.cup_id != null && inView(t.cup_id))
    : inView(t.cup_id));
  const head = note => `<div class="h"><b>On the tables</b>${note ? `<span class="note micro">${esc(note)}</span>` : ''}</div>`;
  if (!all.length) {
    $('warn').innerHTML = '';
    $('tables').innerHTML = head('') + `<p class="blank">No tables yet.${isAdmin() ? ' Add them in Setup.' : ''}</p>`;
    return;
  }
  if (!vis.length) {
    $('warn').innerHTML = '';
    $('tables').innerHTML = head('') +
      `<p class="blank">No tables reserved for this cup — they're all on the other side.</p>`;
    return;
  }
  const notes = S.formats.filter(f => inView(f.cup_id))
    .flatMap(f => (f.warnings || []).map(w => [f, w]));
  const idle = (S.idle_tables || []).filter(w => inView(w.cup_id));
  $('warn').innerHTML = notes.map(([f, w]) => `<div class="warn">
      <b>${esc(f.name)}</b> ${esc(w)}
      ${f.kind === 'swiss' && f.status === 'running' && f.phase !== 'ko'
        ? `<div class="inline"><button class="primary tiny" data-act="cut-ko"
             data-i="${f.id}">Cut to knockout now</button></div>` : ''}
    </div>`).join('')
    + idleNotes(idle);
  const busy = vis.filter(t => t.match && inView(t.match.cup_id)).length;
  const free = vis.filter(t => !t.match && !t.paused).length;
  const paused = vis.filter(t => !t.match && t.paused).length;
  const note = [busy ? `${busy} playing` : '', free ? `${free} free` : '', paused ? `${paused} on break` : '']
    .filter(Boolean).join(' · ');
  // more than four at once: smaller tables, same parts
  $('tables').innerHTML = head(note) +
    (isRef()
      ? `<div class="tiles plain">${vis.map(t => swapTile(t, sheetTile(t))).join('')}</div>`
      : `<div class="tiles${vis.length > 4 ? ' compact' : ''}${vis.length > 6 ? ' c3' : ''}${canScore() ? ' scoring' : ''}">${vis.map(t => swapTile(t, tile(t))).join('')}</div>`);
}

/* A game is over at 11 (or 21) by two, or past it by exactly two. */
function gameOk(a, b, sc) {
  const hi = Math.max(a, b), lo = Math.min(a, b), pts = sc.points_to || 11, by = sc.win_by || 2;
  return hi >= pts && hi - lo >= by && (hi === pts || hi - lo === by);
}

/* The draft behind a table's cells: games typed so far, who leads, whether
   it is decided, and one empty game more while it is not. The same rule
   scorePad uses for the editor. */
function draftOf(m) {
  const s = m.scoring;
  const need = Math.floor(s.best_of / 2) + 1;
  const d = drafts[m.id] || (drafts[m.id] = [['', '']]);
  let wa = 0, wb = 0, bad = false;
  d.forEach(([a, b]) => {
    if (a === '' || b === '') return;
    if (!gameOk(+a, +b, s)) bad = true;
    +a > +b ? wa++ : +b > +a ? wb++ : 0;
  });
  const decided = wa >= need || wb >= need;
  const lastFilled = d.length && d[d.length - 1][0] !== '' && d[d.length - 1][1] !== '';
  if (!decided && lastFilled && d.length < s.best_of) d.push(['', '']);
  return { d, wa, wb, decided, bad, need };
}

/* The referee's table: the plain scoresheet from the first admin mockup.
   The referee's one job is entering results, so the table is a card to fill
   in rather than a picture of the room: the small painted table with its
   number, what is being played and since when, then the two sides as rows
   with a cell per game under G1 G2 G3. The cells are the same inputs as on
   the painted tiles (same ids, same drafts), so nothing else changes. */
const isRef = () => !!S && S.role === 'referee' && !PAST;
function sheetTile(t) {
  const m = t.match;
  const custom = t.name && !/^Table\s+\d+$/.test(t.name) ? t.name : '';
  const mt = off => `<span class="mt${off ? ' off' : ''}"><span>${t.number}</span></span>`;
  if (!m || !inView(m.cup_id)) return `<div class="tile pcard off"><div class="top">${mt(true)}<span class="what"><b>${
      !m ? (t.paused ? 'On break' : 'Free') : `Finishing a ${esc(cupName(m.cup_id) || 'other')} match`}</b>${
      custom ? `<span class="micro">${esc(custom)}</span>` : ''}</span></div></div>`;
  const st = draftOf(m), s = m.scoring;
  const winner = st.decided ? (st.wa > st.wb ? 'a' : 'b') : '';
  const what = [S.cups.length > 1 ? cupName(m.cup_id) : '', m.label].filter(Boolean).join(' · ');
  const sub = [`Best of ${s.best_of} to ${s.points_to}`, m.started_ts ? 'since ' + hhmm(m.started_ts) : '', custom, t.paused ? 'table on break' : '']
    .filter(Boolean).join(' · ');
  const cells = side => st.d.map(([a, b], i) => {
    const done = a !== '' && b !== '';
    const ok = done && gameOk(+a, +b, s);
    const won = ok && (side === 'a' ? +a > +b : +b > +a);
    return `<input class="cell${won ? ' won' : ''}${done && !ok ? ' bad' : ''}" id="g-${m.id}-${i}-${side}"
      data-g="${m.id}|${i}|${side === 'a' ? 0 : 1}" inputmode="numeric" maxlength="2"
      value="${esc(side === 'a' ? a : b)}" aria-label="Game ${i + 1}, ${esc(side === 'a' ? m.a : m.b)}">`;
  }).join('');
  const rq = m.meta && (m.meta.phase === 'open' || m.meta.queued);
  const typed = st.d.some(g => g[0] !== '' || g[1] !== '');
  return `<div class="tile pcard${winner ? ' decided' : ''}">
    <div class="top">${mt(false)}<span class="what"><b>${esc(what || 'Match')}</b><span class="micro">${esc(sub)}</span></span></div>
    <div class="sheet" style="--g:${st.d.length}"><span></span>${st.d.map((_, i) => `<span class="gh">G${i + 1}</span>`).join('')}
      <span class="nm${winner === 'a' ? ' win' : ''}">${esc(nm(m.a))}</span>${cells('a')}
      <span class="nm${winner === 'b' ? ' win' : ''}">${esc(nm(m.b))}</span>${cells('b')}</div>
    ${st.bad ? `<div class="warn2">A game goes to ${s.points_to} and has to be won by ${s.win_by || 2}.</div>` : ''}
    <div class="acts">
      <button class="save${st.decided ? ' ready' : ''}" data-act="report" data-m="${m.id}" ${st.decided ? '' : 'disabled'}>${
        st.decided ? `Save ${esc(nice(winner === 'a' ? m.a : m.b))} win <span class="ar">→</span>` : 'Save result'}</button>
      ${rq ? `<label class="rq"><input type="checkbox" id="rq-${m.id}" ${(drafts['rq-' + m.id] !== false) ? 'checked' : ''} data-rq="${m.id}"> back in the queue</label>` : ''}
      ${typed ? `<button class="link" data-act="clear" data-m="${m.id}">Clear</button>` : ''}
    </div></div>`;
}

/* When a result is saved or a match put back, the table does what TTT
   Admin showed: the match slides out, the table stands free for a moment
   ("Seating the next match…"), and whoever the dispatcher seated slides in.
   The server has already decided by the time the first frame is drawn; this
   only lets the eye follow it. Re-renders during the swap (a poll, a
   keystroke elsewhere) keep their place in the animation rather than
   restarting it. */
const swaps = {};                  // table number -> { phase, at, html }
const SWAP = { leaving: 430, free: 650, arriving: 600 };
const sleep = ms => new Promise(r => setTimeout(r, ms));
function freeTile(t) {
  if (isRef()) return `<div class="tile pcard off"><div class="top"><span class="mt off"><span>${t.number}</span></span>
    <span class="what"><b>Free</b><span class="micro">Seating the next match…</span></span></div></div>`;
  return `<div class="tile"><div class="ptable off"><span class="skin"></span>
    <div class="half a"><span class="lab">free</span></div><div class="net"><span class="no">${t.number}</span></div>
    <div class="half b"><span class="lab">Seating the next match…</span></div></div></div>`;
}
function swapTile(t, html) {
  const w = swaps[t.number];
  const tag = h => h.replace(/^\s*<div class="tile/, `<div data-tno="${t.number}" class="tile`);
  if (!w) return tag(html);
  const late = `style="animation-delay:-${Math.min(Date.now() - w.at, 2000)}ms"`;
  if (w.phase === 'leaving') return w.html.replace(/^\s*<div /, `<div ${late} `).replace('class="tile', 'class="tile leaving');
  if (w.phase === 'free') return tag(freeTile(t));
  return tag(html).replace(/^<div /, `<div ${late} `).replace('class="tile', 'class="tile arriving');
}
async function swapTable(n, run) {
  const el = document.querySelector(`#tables [data-tno="${n}"]`);
  if (el) swaps[n] = { phase: 'leaving', at: Date.now(), html: el.outerHTML };
  renderTables();
  const t0 = Date.now();
  let out;
  try { out = await run(); } catch (e) { out = null; }
  if (!out) { delete swaps[n]; renderTables(); return out; }
  await sleep(Math.max(0, SWAP.leaving - (Date.now() - t0)));
  if (swaps[n]) { swaps[n] = { phase: 'free', at: Date.now() }; renderTables(); }
  await sleep(SWAP.free);
  if (swaps[n]) { swaps[n] = { phase: 'arriving', at: Date.now() }; renderTables(); }
  setTimeout(() => { delete swaps[n]; renderTables(); }, SWAP.arriving);
  return out;
}
// what is on a table now, for the toast
function nowOn(n) {
  const t = S.tables.find(x => x.number === n);
  return t && t.match ? `Table ${n}: ${nm(t.match.a)} vs ${nm(t.match.b)} are on` : `Table ${n} is free`;
}

/* A side's names on the table face, as the phone page sets them: one
   person as first name over last, a pair as two names with the ampersand
   between them on its own line. */
function face(name) {
  const p = sidesOf(name);
  if (p.length === 1) {
    const w = p[0].split(/\s+/);
    if (w.length > 1) return `<span>${esc(w[0])}</span><span>${esc(w.slice(1).join(' '))}</span>`;
  }
  return p.map(x => `<span>${esc(x)}</span>`).join('<span class="amp">&amp;</span>');
}

function tile(t) {
  const m = t.match;
  const custom = t.name && !/^Table\s+\d+$/.test(t.name) ? t.name : '';
  const net = `<div class="net"><span class="no">${t.number}</span></div>`;
  const pause = isAdmin() ? `<button class="link" data-act="pause" data-t="${t.number}">${t.paused ? 'Resume' : 'Pause'}</button>` : '';
  const off = (top, bottom) => `<div class="tile"><div class="ptable off">
      <span class="skin"></span>
      <div class="half a"><span class="lab">${top}</span></div>${net}
      <div class="half b"><span class="lab">${bottom}</span></div></div>
      ${pause ? `<div class="acts">${pause}</div>` : ''}</div>`;
  // Pausing only stops the dispatcher sending more work here; it does not
  // stop the match already on the table. Hiding that match took the score
  // pad and Put back with it, which is exactly the moment you reach for
  // them: pause the table, put the match back, seat the one you want.
  if (!m) return off(t.paused ? 'break' : 'free', custom ? esc(custom) : '');
  if (!inView(m.cup_id)) return off(`finishing a ${esc(cupName(m.cup_id) || 'other')} match`, '');

  const sc = canScore();
  const st = sc ? draftOf(m) : null;
  const showCup = S.cups.length > 1 && !selectedCup;
  // what is being played: the cup in Everyone, the round in a cup — and,
  // for whoever enters results, since when and the table's own name
  const top = [showCup ? cupName(m.cup_id) : m.label, sc && m.started_ts ? 'since ' + hhmm(m.started_ts) : '',
    sc ? custom : '', sc && t.paused ? 'table on break' : ''].filter(Boolean).map(esc).join(' · ');
  const winner = st && st.decided ? (st.wa > st.wb ? 'a' : 'b') : '';
  const cells = side => !sc ? '' : `<div class="cells">${st.d.map(([a, b], i) => {
      const done = a !== '' && b !== '';
      const ok = done && gameOk(+a, +b, m.scoring);
      const won = ok && (side === 'a' ? +a > +b : +b > +a);
      return `<input class="cell${won ? ' won' : ''}${done && !ok ? ' bad' : ''}" id="g-${m.id}-${i}-${side}"
        data-g="${m.id}|${i}|${side === 'a' ? 0 : 1}" inputmode="numeric" maxlength="2" placeholder="–"
        value="${esc(side === 'a' ? a : b)}" aria-label="Game ${i + 1}, ${esc(side === 'a' ? m.a : m.b)}">`;
    }).join('')}</div>`;
  const rq = m.meta && (m.meta.phase === 'open' || m.meta.queued);
  const typed = st && st.d.some(g => g[0] !== '' || g[1] !== '');
  const s = m.scoring;
  return `<div class="tile${winner ? ' decided' : ''}"><div class="ptable">
      <span class="skin"></span><span class="edge"></span><span class="cl"></span>
      <div class="half a">${top ? `<span class="lab">${top}</span>` : ''}<span class="pn${winner === 'a' ? ' win' : ''}">${face(m.a)}</span>${cells('a')}</div>
      ${net}
      <div class="half b">${cells('b')}<span class="pn${winner === 'b' ? ' win' : ''}">${face(m.b)}</span>
        ${sc ? `<span class="lab">Best of ${s.best_of} to ${s.points_to}</span>` : ''}</div>
    </div>
    ${st && st.bad ? `<div class="warn2">A game goes to ${s.points_to} and has to be won by ${s.win_by || 2}.</div>` : ''}
    ${sc ? `<div class="acts">
      <button class="save${st.decided ? ' ready' : ''}" data-act="report" data-m="${m.id}" ${st.decided ? '' : 'disabled'}>${
        st.decided ? `Save ${esc(nice(winner === 'a' ? m.a : m.b))} win <span class="ar">→</span>` : 'Save result'}</button>
      ${rq ? `<label class="rq"><input type="checkbox" id="rq-${m.id}" ${(drafts['rq-' + m.id] !== false) ? 'checked' : ''} data-rq="${m.id}"> back in the queue</label>` : ''}
      ${typed ? `<button class="link" data-act="clear" data-m="${m.id}">Clear</button>` : ''}
      ${isAdmin() && m.table ? `<button class="link" data-act="put-back" data-m="${m.id}"
         title="Free this table and send the match to the back of the queue">Put back</button>` : ''}
      ${pause}
    </div>` : ''}
  </div>`;
}

function bestOfLine(m) {
  const s = m.scoring;
  return `<div class="table-state">Best of ${s.best_of} to ${s.points_to}</div>`;
}

function scorePad(m) {
  const s = m.scoring;
  const need = Math.floor(s.best_of / 2) + 1;
  const d = drafts[m.id] || (drafts[m.id] = [['', '']]);
  let wa = 0, wb = 0;
  d.forEach(([a, b]) => {
    if (a !== '' && b !== '') { +a > +b ? wa++ : +b > +a ? wb++ : 0; }
  });
  const decided = wa >= need || wb >= need;
  const lastFilled = d.length && d[d.length - 1][0] !== '' && d[d.length - 1][1] !== '';
  if (!decided && lastFilled && d.length < s.best_of) d.push(['', '']);

  const games = d.map((g, i) => `<span class="game">
      <input id="g-${m.id}-${i}-a" data-g="${m.id}|${i}|0" inputmode="numeric"
             value="${esc(g[0])}" aria-label="Game ${i + 1}, ${esc(m.a)}">
      <span class="sep">:</span>
      <input id="g-${m.id}-${i}-b" data-g="${m.id}|${i}|1" inputmode="numeric"
             value="${esc(g[1])}" aria-label="Game ${i + 1}, ${esc(m.b)}">
    </span>`).join('');

  const rq = m.meta && (m.meta.phase === 'open' || m.meta.queued);
  const done = m.status === 'done';
  const typed = d.some(g => g[0] !== '' || g[1] !== '');
  return `<div class="pad">
    <div class="games">${games}</div>
    <div class="pad-row">
      <button class="primary" data-act="report" data-m="${m.id}" ${decided ? '' : 'disabled'}>
        ${decided ? `Save ${wa > wb ? esc(m.a) : esc(m.b)} win` : 'Save result'}</button>
      ${rq && !done ? `<label class="hint"><input type="checkbox" id="rq-${m.id}" ${(drafts['rq-' + m.id] !== false) ? 'checked' : ''} data-rq="${m.id}"> back in queue</label>` : ''}
      ${typed ? `<button class="ghost tiny" data-act="clear" data-m="${m.id}">Clear</button>` : ''}
      ${done ? `<button class="ghost tiny" data-act="undo" data-m="${m.id}">Undo result</button>` : ''}
      ${isAdmin() && m.table ? `<button class="ghost tiny" data-act="put-back" data-m="${m.id}"
         title="Free this table and send the match to the back of the queue">Put back</button>` : ''}
    </div>
    <div class="hint">Best of ${s.best_of} to ${s.points_to}</div>
  </div>`;
}

/* -- the board: who plays next, and roughly when ---------------------- */

function whenLabel(r) {
  // r.blocked (a player is on another table, sitting out or withdrawn) is
  // not shown: the dispatcher already skips them, and the label read as an
  // error to organisers when nothing was actually wrong
  if (r.on_deck) return 'get ready';
  if (r.eta_min == null) return '';
  return 'circa! in ' + r.eta_min + 'min.';
}

function cupName(id) {
  const c = S.cups.find(x => x.id === id);
  return c ? c.name : '';
}

/* Who plays next, in order. One row a match: position, the two sides, and
   on the right either "Get ready" (the first wave) or nothing — the rough
   time stays a quiet hint for whoever runs the night, never a promise on
   the row. Seat now / Sit out / Enter result appear on hover. */
/* An Up next row, as TTT Admin has it: the match the next table goes to is
   marked Next in red; on any other, hovering shows what can be done with it
   — Seat now (to the front of the line) and Sit out. Whoever only watches
   sees Get ready, the players' word, and no actions. */
function upTail(r) {
  // the front of the line is Next, as are any that will go on as soon as a
  // table frees (the board's on_deck); a pair still playing elsewhere is not
  const next = !r.blocked && (r.on_deck || r.position === 1);
  const acts = [
    r.kind === 'fixture' && isAdmin() && !next
      ? `<button class="link" data-act="seat" data-m="${r.id}">Seat now</button>` : '',
    r.kind === 'fixture' && isAdmin()
      ? `<button class="link" data-act="put-back" data-m="${r.id}">Put back</button>` : '',
    r.kind === 'waiting' && canScore()
      ? `<button class="link" data-act="rest" data-e="${r.id}" data-n="${esc(nice(r.a))}">Sit out</button>` : '',
    r.kind === 'fixture' && canScore()
      ? `<button class="link" data-act="score" data-m="${r.id}">Enter result</button>` : '',
  ].filter(Boolean).join('');
  return `<span class="tail">
      ${r.kind === 'pairing' && !(canScore() && next) ? `<span class="chip" title="Worked out by the same rule that will seat them">next</span>` : ''}
      ${r.deferred > 0 ? `<span class="chip">put back</span>` : ''}
      ${canScore() ? (next ? '<span class="tag-next">Next</span>' : '') : r.on_deck ? '<span class="ready">Get ready</span>' : ''}
      ${acts ? `<span class="ac">${acts}</span>` : ''}
    </span>`;
}
function boardRow(r) {
  return `<div class="r hoverable ${r.on_deck ? 'ondeck' : ''}">
    <span class="i">${String(r.position).padStart(2, '0')}</span>
    <span class="nm">${esc(nice(r.a))}${r.b ? `<span class="v">vs ${esc(nice(r.b))}</span>` : '<span class="v">waiting for a match</span>'}</span>
    ${upTail(r)}
  </div>`;
}

let boardAll = false;
function renderBoard() {
  const bs = (S.board || []).filter(b => inView(b.cup_id));
  if (!bs.length) { $('board').innerHTML = ''; return; }
  $('board').innerHTML = bs.map(b => {
    const name = cupName(b.cup_id);
    // a long queue is twelve rows and a button, so Standings and Results
    // stay within reach; the rest unfolds on request
    const shown = boardAll ? b.up : b.up.slice(0, LIST_ROWS);
    const hidden = b.up.length - shown.length;
    const more = hidden > 0 ? `<button class="link more" data-act="board-all">+ ${hidden} more</button>`
      : boardAll && b.up.length > LIST_ROWS ? `<button class="link more" data-act="board-all">Show fewer</button>`
      : b.total > b.up.length ? `<p class="blank">and ${b.total - b.up.length} more after that</p>` : '';
    const note = [
      b.fixtures ? b.fixtures + ' to play' : '',
      b.waiting ? b.waiting + ' waiting' : '',
      // the exact table is only picked the instant one frees up, so a cup
      // on the shared pool gets no number; its own tables are a promise
      tablesLabelOf(b),
    ].filter(Boolean).join(' · ');
    return `<div class="panel">
      <div class="panel-head"><h2>Up next${bs.length > 1 && name ? ' · ' + esc(name) : ''}</h2>
        <span class="note micro">${esc(note)}</span></div>
      <div class="panel-body flush"><div class="list">${shown.map(boardRow).join('') || '<p class="blank">Nothing queued.</p>'}</div>${more}</div>
    </div>`;
  }).join('');
}

/* -- below the tables ----------------------------------------------------

   One cup in view: three chapters side by side — Up next, Standings (and the
   knockout), Results. Everyone, with several cups: one column per cup with
   the same blocks and the same row counts (three up next, four in the
   table), so the cups line up and can be compared at a glance; "Open →"
   switches the view to that cup. Results run underneath, across all cups. */

function renderBelow() {
  const many = S.cups.length > 1 && !selectedCup;
  document.querySelector('.cols').classList.toggle('bycup-mode', many);
  if (!many) {
    $('bycup').innerHTML = '';
    renderBoard(); renderStandings(); renderBrackets();
    return;
  }
  ['board', 'standings', 'brackets'].forEach(id => { $(id).innerHTML = ''; });
  $('bycup').innerHTML = `<div class="bycup" style="--n:${S.cups.length}">${S.cups.map(cupColumn).join('')}</div>`;
}

/* For the referee everything below the tables is a folded row, opened on
   demand — the phone page's fold (title, a short note, +). The sections'
   own containers move into the folds once, so every partial re-render keeps
   landing in the right place and an open fold stays open. */
let refBuilt = false;
function refShell() {
  if (refBuilt || !isRef()) return;
  refBuilt = true;
  document.body.classList.add('ref');
  const cols = document.querySelector('.cols');
  const mk = (key, title, ids) => {
    const d = document.createElement('details');
    d.className = 'fold'; d.id = 'fold-' + key;
    d.innerHTML = `<summary><b>${esc(title)}</b><span><em class="fnote"></em><i aria-hidden="true">+</i></span></summary><div class="in"></div>`;
    ids.forEach(id => d.querySelector('.in').appendChild($(id)));
    cols.appendChild(d);
  };
  mk('board', 'Up next', ['board']);
  mk('ko', 'Knockout', ['brackets']);
  mk('stand', 'Standings', ['standings']);
  mk('recent', 'Results', ['manual-entry', 'recent']);
  cols.querySelectorAll(':scope > .col').forEach(c => c.remove());
}
function refFolds() {
  if (!isRef()) return;
  const set = (key, note, show) => {
    const d = $('fold-' + key); if (!d) return;
    d.hidden = !show; d.querySelector('.fnote').textContent = note || '';
  };
  const filled = id => !!$(id) && $(id).innerHTML.trim() !== '';
  const bs = (S.board || []).filter(b => inView(b.cup_id));
  const next = bs.flatMap(b => b.up)[0];
  set('board', next ? (next.b ? `${nice(next.a)} vs ${nice(next.b)}` : nice(next.a)) : 'nothing queued', filled('board'));
  const fs = S.formats.filter(f => inView(f.cup_id));
  const br = fs.map(f => f.view && f.view.bracket).find(Boolean);
  const rd = br && (br.find(r => r.matches.some(m => !m.winner)) || br[br.length - 1]);
  set('ko', rd ? rd.name : '', filled('brackets'));
  const lead = fs.map(f => (f.standings || []).find(g => g.rows.some(r => r.played))).find(Boolean);
  set('stand', lead && lead.rows[0] ? `${nice(lead.rows[0].name)} leads` : '', filled('standings'));
  const last = S.recent.find(m => inView(m.cup_id) && !(m.meta && m.meta.bye));
  set('recent', last ? `${nice(last.winner === 'a' ? last.a : last.b)} beat ${nice(last.winner === 'a' ? last.b : last.a)}` : '', filled('recent') || filled('manual-entry'));
}

/* A cup's column in Everyone. One skeleton for every cup, so the columns
   read across as well as down: the cup's name (the anchor) with Open →, then
   two blocks, each a small heading in ink on the ink rule — Up next, then
   the standings — and each block a fixed number of slots (three, four), so
   the second block starts at the same height in every column whatever is in
   the first. Anything extra sits on the heading's line, never between rows:
   "+ 4 more" beside Up next, the column labels beside the standings. Empty
   slots stay empty; there are no placeholder dashes. */
function cupColumn(c) {
  const p = cupProgress(c.id);
  const b = p.b;
  const rows = b ? b.up.slice(0, 3) : [];
  const rest = b ? b.total - rows.length : 0;
  const f = p.f;
  const body = `<section class="cupcol">
    <header class="ch"><b>${esc(c.name)}</b><button class="link" data-cup="${c.id}">Open →</button></header>
    <div class="blk">
      <div class="bh"><span class="bt">Up next</span>${rest > 0 ? `<button class="link" data-cup="${c.id}">+ ${rest} more</button>` : ''}</div>
      <div class="list slots3">${rows.map(r => `<div class="r hoverable${r.on_deck ? ' ondeck' : ''}">
          <span class="i">${String(r.position).padStart(2, '0')}</span>
          <span class="nm">${esc(nice(r.a))}<span class="v">${r.b ? 'vs ' + esc(nice(r.b)) : 'waiting for a match'}</span></span>
          ${upTail(r)}</div>`).join('') || `<p class="blank">${f && f.complete ? 'All played.' : 'Nothing queued.'}</p>`}</div>
    </div>
    <div class="blk">${standTop(f)}</div>
  </section>`;
  if (!isRef()) return body;
  const k = 'ref_cup_' + c.id, nx = rows[0];
  return `<details class="fold" data-keep="${k}"${form[k] ? ' open' : ''}><summary><b>${esc(c.name)}</b><span><em class="fnote">${
    esc(nx ? (nx.b ? `${nice(nx.a)} vs ${nice(nx.b)}` : nice(nx.a)) : 'nothing queued')}</em><i aria-hidden="true">+</i></span></summary><div class="in">${body}</div></details>`;
}

/* The second block: at most four one-line rows, whatever the format —
   groups: who is through so far (A1, A2, B1, B2); Swiss: the top four;
   open play: wins tonight; a knockout: the round being played, a match a
   line, its table or its score on the right. */
function standTop(f) {
  const head = (lbl, cols) => `<div class="bh sth"><span class="bt">${esc(lbl)}</span>${
    cols ? cols.map(x => `<span class="hc">${x}</span>`).join('') : ''}</div>`;
  const row = (pos, r, cls, c2) => `<div class="st ${cls || ''}"><span class="pos">${esc(pos)}</span><span>${esc(nice(r.name))}</span>
    <span>${r.won}</span><span>${c2}</span><span>${r.point_diff > 0 ? '+' : ''}${r.point_diff ?? ''}</span></div>`;
  const slots = inner => `<div class="slots4">${inner}</div>`;
  if (!f || f.status === 'setup') return head('Standings') + slots('<p class="blank">Not started.</p>');
  const br = f.view && f.view.bracket;
  if (br) {
    const rd = br.find(r => r.matches.some(m => !m.winner)) || br[br.length - 1];
    // a match as Up next draws one — side over side — so a narrow column
    // never cuts both names short; its table or its score on the right
    return head('Knockout · ' + rd.name) + slots(`<div class="list">${rd.matches.slice(0, 4).map(m => {
      const nmOf = n => n ? esc(nice(n)) : 'to be decided';
      const [ga, gb] = (m.games || []).reduce(([x, y], [p, q]) => [x + (p > q), y + (q > p)], [0, 0]);
      const aW = m.winner === 'a';
      const top = m.winner ? (aW ? m.a : m.b) : m.a, bot = m.winner ? (aW ? m.b : m.a) : m.b;
      const tag = m.winner ? `<b class="ks">${aW ? ga + ':' + gb : gb + ':' + ga}</b>` : m.table ? `<span class="tagt">Table ${m.table}</span>` : '';
      return `<div class="r kr${m.winner ? ' done' : ''}"><span class="i"></span>
        <span class="nm">${nmOf(top)}<span class="v">${m.winner ? 'beat ' : 'vs '}${nmOf(bot)}</span></span><span class="tail">${tag}</span></div>`;
    }).join('')}</div>`);
  }
  const groups = (f.standings || []).filter(g => g.rows.length);
  const label = f.kind === 'open_play' ? 'Wins tonight' : groups.length > 1 ? 'Through so far' : 'Standings';
  const c2 = f.kind === 'swiss' ? 'Bh' : 'L';
  if (!groups.length || !groups.some(g => g.rows.some(r => r.played))) return head(label) + slots('<p class="blank">Nothing played yet.</p>');
  let rows;
  if (f.kind === 'open_play') {
    rows = groups[0].rows.slice().sort((a, b) => b.won - a.won || a.lost - b.lost).slice(0, 4).map((r, i) => row(i + 1, r, '', r.lost));
  } else if (f.kind === 'swiss') {
    rows = groups[0].rows.slice(0, 4).map(r => row(r.rank, r, '', r.buchholz ?? 0));
  } else if (groups.length > 1) {
    const adv = +(f.config.advance_per_group || 2);
    const per = Math.max(1, Math.floor(4 / groups.length));
    rows = groups.flatMap(g => g.rows.slice(0, Math.min(adv, per)).map(r =>
      row(String(g.group).replace(/^Group\s+/, '') + r.rank, r, 'q', r.lost))).slice(0, 4);
  } else {
    rows = groups[0].rows.slice(0, 4).map(r => row(r.rank, r, '', r.lost));
  }
  return head(label, ['W', c2, '±']) + slots(rows.join(''));
}

/* -- one score editor, for entering, correcting and undoing ------------- */

/* Correcting a result used to mean undoing it and rebuilding the match from
   the manual-entry form. Re-saving a finished match already rewrites it and
   re-resolves whatever it decided downstream, so editing is just the same
   pad opened again with the old score in it. */
function findMatch(id) {
  for (const t of S.tables) if (t.match && t.match.id === id) return t.match;
  for (const m of S.recent) if (m.id === id) return m;
  for (const b of (S.board || [])) for (const r of b.up)
    if (r.id === id) return { id: r.id, a: r.a, b: r.b, label: r.label,
                              scoring: r.scoring, games: [], status: 'pending' };
  return null;
}

function openEditor(id) {
  const m = findMatch(id);
  if (!m) return toast('That match is no longer on the board');
  editing = id;
  drafts[id] = (m.games && m.games.length)
    ? m.games.map(g => [String(g[0]), String(g[1])]) : [['', '']];
  render();
}

function closeEditor() { editing = null; render(); }

function renderEditor() {
  const el = $('editor');
  if (!editing || !canScore()) { el.hidden = true; el.innerHTML = ''; return; }
  const m = findMatch(editing);
  if (!m) { editing = null; el.hidden = true; el.innerHTML = ''; return; }
  const done = m.status === 'done';
  el.hidden = false;
  el.innerHTML = `<div class="sheet-inner narrow">
    <div class="sheet-head">
      <h2 style="margin:0;font-size:15px">${done ? 'Edit result' : 'Enter result'}</h2>
      <button class="ghost" data-act="close-editor">Close</button>
    </div>
    <div class="sheet-body">
      <div class="versus">
        <div class="side"><span class="side-name">${esc(m.a)}</span></div>
        <div class="vs">plays</div>
        <div class="side"><span class="side-name">${esc(m.b)}</span></div>
      </div>
      ${scorePad(m)}
      ${done ? `<p class="sub">Saving a different score puts the match right and
        re-resolves anything it decided in later rounds. "Undo" takes the result
        back altogether and leaves the match to be played again.</p>` : ''}
    </div>
  </div>`;
}

/* -- manual result entry ------------------------------------------------ */

function renderManual() {
  const el = $('manual-entry');
  if (!el) return;
  if (!canScore()) { el.innerHTML = ''; return; }
  const entrants = S.entrants.slice().sort((a, b) => a.name.localeCompare(b.name));
  if (entrants.length < 2) { el.innerHTML = ''; return; }
  // closed, it lives as one button in the Results header (renderRecent) —
  // it is for the game nobody arranged, which should not need its own panel
  if (!manualOpen) { el.innerHTML = ''; return; }
  const runningFormats = S.formats.filter(f => f.status === 'running');
  const need = Math.floor(+manualDraft.bo / 2) + 1;
  let wa = 0, wb = 0;
  manualGames.forEach(([a, b]) => { if (a !== '' && b !== '') { +a > +b ? wa++ : +b > +a ? wb++ : 0; } });
  const decided = wa >= need || wb >= need;
  const lastFilled = manualGames.length && manualGames[manualGames.length - 1][0] !== '' && manualGames[manualGames.length - 1][1] !== '';
  if (!decided && lastFilled && manualGames.length < +manualDraft.bo) manualGames.push(['', '']);

  const nameOf = id => (S.entrants.find(x => x.id === id) || {}).name || '';
  const games = manualGames.map((g, i) => `<span class="game">
      <input id="mg-${i}-a" data-mg="${i}|0" inputmode="numeric" value="${esc(g[0])}" aria-label="Game ${i + 1}, side A">
      <span class="sep">:</span>
      <input id="mg-${i}-b" data-mg="${i}|1" inputmode="numeric" value="${esc(g[1])}" aria-label="Game ${i + 1}, side B">
    </span>`).join('');

  const ready = decided && manualDraft.a && manualDraft.b && manualDraft.a !== manualDraft.b;
  el.innerHTML = `<div class="panel">
    <div class="panel-head"><h2>Add a result by hand</h2>
      <button class="ghost tiny" data-act="manual-close">Close</button></div>
    <div class="panel-body">
      <div class="inline">
        <div class="field"><label for="man-a">Side A</label>
          <select id="man-a" data-mf="a">
            <option value="">Pick…</option>
            ${entrants.map(e => `<option value="${e.id}" ${manualDraft.a === e.id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}
          </select></div>
        <div class="field"><label for="man-b">Side B</label>
          <select id="man-b" data-mf="b">
            <option value="">Pick…</option>
            ${entrants.map(e => `<option value="${e.id}" ${manualDraft.b === e.id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}
          </select></div>
      </div>
      <div class="inline">
        ${runningFormats.length ? `<div class="field"><label for="man-fmt">Counts towards</label>
          <select id="man-fmt" data-mf="format_id">
            <option value="">Friendly — no format</option>
            ${runningFormats.map(f => `<option value="${f.id}" ${manualDraft.format_id === f.id ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}
          </select></div>` : ''}
        <div class="field" style="max-width:100px"><label for="man-bo">Best of</label>
          <select id="man-bo" data-mf="bo">${[1, 3, 5, 7].map(n =>
            `<option value="${n}" ${+manualDraft.bo === n ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
        <div class="field" style="max-width:100px"><label for="man-pts">Points to</label>
          <select id="man-pts" data-mf="pts">${[11, 21].map(n =>
            `<option value="${n}" ${+manualDraft.pts === n ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
      </div>
      <div class="games">${games}</div>
      <div class="pad-row">
        <button class="primary" data-act="manual-result" ${ready ? '' : 'disabled'}>
          ${decided ? `Save ${esc(wa > wb ? (nameOf(manualDraft.a) || 'side A') : (nameOf(manualDraft.b) || 'side B'))} win` : 'Save result'}</button>
        <button class="ghost tiny" data-act="manual-clear">Clear</button>
      </div>
      <p class="sub">Both sides drop straight into results — nobody needs to have queued or been dispatched to a table first.</p>
    </div>
  </div>`;
}

/* -- standings --------------------------------------------------------- */

/* Standings, as the phone page has them: per group a small heading (with
   how many go through), W · L · ± (W · Bh · ± in a Swiss), pairs by first
   names, the places that go through with their number in ink and a dotted
   line under the last of them — kept once the knockout is drawn, as the
   record of who went through. A long table shows ten, then the rest. */
let standAll = {};
function renderStandings() {
  const blocks = [];
  for (const f of S.formats) {
    if (!inView(f.cup_id)) continue;
    if (!f.standings || !f.standings.length) continue;
    const adv = f.kind === 'groups' && f.config.then_ko ? +(f.config.advance_per_group || 2) : 0;
    const swiss = f.kind === 'swiss';
    const open = f.kind === 'open_play';
    const groups = f.standings.filter(g => g.rows.length && g.rows.some(r => r.played));
    if (!groups.length) continue;
    const many = groups.length > 1;
    // the column labels ride in the chapter's head, on the title's baseline,
    // so the ink rule under every chapter sits at the same height and the
    // first rows of Up next, Standings and Results line up across the page
    blocks.push(`<div class="panel">
      <div class="panel-head sth"><h2>${open ? 'Wins tonight' : 'Standings'}</h2><span class="ch">W</span><span class="ch">${swiss ? 'Bh' : 'L'}</span><span class="ch">±</span></div>
      <div class="panel-body">${groups.map(g => {
        const rows = open ? g.rows.slice().sort((a, b) => b.won - a.won || a.lost - b.lost) : g.rows;
        const key = f.id + '|' + g.group, all = standAll[key];
        const more = rows.length > TABLE_ROWS
          ? `<button class="link more" data-act="st-all" data-k="${esc(key)}">${all ? 'Show fewer' : `+ ${rows.length - TABLE_ROWS} more`}</button>` : '';
        return `${many || adv ? `<div class="grp micro">${esc(g.group)}${adv ? ` · Top ${adv} go through` : ''}</div>` : ''}${
          rows.slice(0, all ? rows.length : TABLE_ROWS).map((r, i) => {
            const rank = open ? i + 1 : r.rank;
            return `<div class="st${adv && rank <= adv ? ' q' : ''}${adv && rank === adv ? ' cut' : ''}">
              <span class="pos">${rank}</span><span>${esc(nice(r.name))}</span><span>${r.won}</span>
              <span>${swiss ? (r.buchholz ?? 0) : r.lost}</span><span>${r.point_diff > 0 ? '+' : ''}${r.point_diff ?? ''}</span></div>`;
          }).join('')}${more}`; }).join('')}</div></div>`);
  }
  $('standings').innerHTML = blocks.join('');
}

/* -- the knockout, as a tree ---------------------------------------------

   Rounds left to right, each match level with the two that feed it, thin
   ink brackets joining them; the match being played carries its table, the
   winner is named under the final, the match for third sits underneath.
   Placed by bracket slot (slot i feeds slot i>>1), so a match fed by a bye
   just takes the next free row. Wider than its column it scrolls sideways,
   opened at the round being played. Same rules as mobile.js koBlock. */

const KO = { mh: 50, gap: 12, cg: 18, top: 22 };   // as mobile.js
function koTree(rounds, width) {
  const fi = rounds.findIndex(rd => rd.matches.length === 1);
  const tree = fi < 0 ? rounds : rounds.slice(0, fi + 1), extra = fi < 0 ? [] : rounds.slice(fi + 1);
  const R = tree.length;
  const { mh, gap, cg, top } = KO;
  let cw = Math.floor((width - (R - 1) * cg) / R);
  const wide = cw < 150;
  if (wide) cw = 170;
  cw = Math.min(cw, 240);
  const slotOf = (m, i) => m.slot ?? i;
  const bySlot = tree.map(rd => new Map(rd.matches.map((m, i) => [slotOf(m, i), m])));
  const Y = tree.map(() => new Map());
  let rows = 0;
  const place = (r, sl) => {
    if (!bySlot[r].has(sl)) return null;
    const kids = r > 0 ? [place(r - 1, 2 * sl), place(r - 1, 2 * sl + 1)].filter(v => v != null) : [];
    const y = kids.length ? kids.reduce((a, b) => a + b, 0) / kids.length : top + (rows++) * (mh + gap) + mh / 2;
    Y[r].set(sl, y);
    return y;
  };
  tree[R - 1].matches.forEach((m, i) => place(R - 1, slotOf(m, i)));
  tree.forEach((rd, r) => rd.matches.forEach((m, i) => {
    if (!Y[r].has(slotOf(m, i))) Y[r].set(slotOf(m, i), top + (rows++) * (mh + gap) + mh / 2);
  }));
  const fin = tree[R - 1].matches.length === 1 ? tree[R - 1].matches[0] : null;
  const champ = fin && fin.winner ? (fin.winner === 'a' ? fin.a : fin.b) : null;
  let H = top + rows * (mh + gap) - gap;
  if (champ) H = Math.max(H, Y[R - 1].get(slotOf(fin, 0)) + mh / 2 + 62);
  const Wt = R * cw + (R - 1) * cg;
  const x = r => r * (cw + cg);
  const lines = [];
  for (let r = 1; r < R; r++) tree[r].matches.forEach((m, i) => {
    const sl = slotOf(m, i);
    [2 * sl, 2 * sl + 1].forEach(k => {
      const f = bySlot[r - 1].get(k);
      if (!f) return;
      const x1 = x(r - 1) + cw, xm = x1 + cg / 2;
      lines.push(`<path class="${f.winner ? 'done' : ''}" d="M${x1} ${Y[r - 1].get(k)}H${xm}V${Y[r].get(sl)}H${x(r)}"/>`);
    });
  });
  const card = (m, style) => {
    const live = m.table && !m.winner;
    const open = !m.a || !m.b;
    const sd = (n, which) => {
      if (!n) return `<div class="s tbd"><span>${m.winner ? 'bye' : 'to be decided'}</span><b></b></div>`;
      const cls = m.winner ? (m.winner === which ? ' w' : ' l') : '';
      const g = m.games && m.games.length ? m.games.filter(x => which === 'a' ? x[0] > x[1] : x[1] > x[0]).length : '';
      return `<div class="s${cls}"><span>${esc(nice(n))}</span><b>${g}</b></div>`;
    };
    return `<div class="kc${live ? ' live' : ''}${open && !m.winner ? ' tbd' : ''}"${style ? ` style="${style}"` : ''}>${sd(m.a, 'a')}${sd(m.b, 'b')}${
      live ? `<i class="kl">Table ${m.table}</i>` : ''}${
      canScore() && m.winner && m.id ? `<button class="link on-hover ked" data-act="edit" data-m="${m.id}">Edit</button>` : ''}</div>`;
  };
  const at = Math.max(0, tree.findIndex(rd => rd.matches.some(m => !m.winner)));
  return `<div class="ko${wide ? ' wide' : ''}" data-at="${at * (cw + cg)}"><div class="kt" style="width:${Wt}px;height:${H}px">
      <svg width="${Wt}" height="${H}" aria-hidden="true">${lines.join('')}</svg>
      ${tree.map((rd, r) => `<span class="kh" style="left:${x(r)}px;width:${cw}px">${esc(rd.name)}</span>`).join('')}
      ${tree.map((rd, r) => rd.matches.map((m, i) => card(m, `left:${x(r)}px;top:${Y[r].get(slotOf(m, i)) - mh / 2}px;width:${cw}px`)).join('')).join('')}
      ${champ ? `<div class="kw" style="left:${x(R - 1)}px;top:${Y[R - 1].get(slotOf(fin, 0)) + mh / 2 + 12}px;width:${cw}px">
        <span>Winner</span><b>${esc(nice(champ))}</b></div>` : ''}
    </div></div>${extra.map(rd => `<div class="ko-x"><span class="kh">${esc(rd.name)}</span>${
      rd.matches.map(m => card(m, `width:${cw}px`)).join('')}</div>`).join('')}`;
}

function renderBrackets() {
  const box = $('brackets');
  const out = [];
  const width = Math.max(260, (box.clientWidth || box.parentElement.clientWidth || 360));
  for (const f of S.formats) {
    if (!inView(f.cup_id)) continue;
    const b = f.view && f.view.bracket;
    if (!b || !b.length) continue;
    out.push(`<div class="panel">
      <div class="panel-head"><h2>Knockout</h2></div>
      <div class="panel-body">${koTree(b, width)}</div></div>`);
  }
  box.innerHTML = out.join('');
  // a bracket wider than its column opens at the round being played
  box.querySelectorAll('.ko.wide').forEach(k => { k.scrollLeft = +k.dataset.at || 0; });
}

/* -- recent ------------------------------------------------------------ */

/* The server sends every result; the wall only needs the latest few. The
   rest stay one click away, and the search reaches any of them by name, so
   a score entered wrong an hour ago can still be found and put right. */
const RECENT_SHOWN = LIST_ROWS;     // the latest five; everything else is one click away

function renderRecent() {
  const all = S.recent.filter(m => inView(m.cup_id));
  const canAdd = canScore() && !manualOpen && S.entrants.length >= 2;
  if (!all.length && !canAdd) { $('recent').innerHTML = ''; return; }
  const q = recentQuery.trim().toLowerCase();
  const hits = q ? all.filter(m => [m.a, m.b, m.label].some(
    x => x && String(x).toLowerCase().includes(q))) : all;
  const r = q || recentAll ? hits : hits.slice(0, RECENT_SHOWN);
  const hidden = hits.length - r.length;
  // a poll re-renders this panel; keep the search box focused through it
  const had = document.activeElement && document.activeElement.id === 'recent-q';
  const caret = had ? document.activeElement.selectionStart : 0;
  // the search only appears once the list is opened up: five rows need no
  // search, and a box in the header was furniture the rest of the time
  const open = recentAll || !!q;
  $('recent').innerHTML = `<div class="panel">
    <div class="panel-head"><h2>Results</h2>
      ${canAdd ? `<button class="link" data-act="manual-open"
        title="For a game nobody arranged — a walk-up match, or one played before anyone was keeping track">+ Add a result</button>` : ''}</div>
    ${open && all.length > RECENT_SHOWN ? `<label class="find-res"><span aria-hidden="true">⌕</span><input id="recent-q" type="search"
        placeholder="Find a player" aria-label="Find a player in the results" value="${esc(recentQuery)}" autocomplete="off"></label>` : ''}
    <div class="panel-body flush">${all.length ? '' : '<p class="blank">Nothing played yet.</p>'}${
      all.length && !hits.length ? '<p class="blank">No result with that name.</p>' : ''}${r.map(m => {
      // as the phone page has it: "Winner beat Loser", the games won, and
      // under it the cup, the round and the games from the winner's side
      const meta = m.meta || {};
      const showCup = S.cups.length > 1 && !selectedCup;
      const lb = m.label && m.label.toLowerCase() !== (cupName(m.cup_id) || '').toLowerCase() ? m.label : '';
      if (meta.bye) return `<div class="row result"><span class="rt"><span class="w">${esc(nice(m.a))}</span>
        <span class="meta">${esc([showCup ? cupName(m.cup_id) : '', m.label || 'bye'].filter(Boolean).join(' · '))}</span></span><span class="s"></span></div>`;
      const aW = m.winner === 'a';
      const [sa, sb] = (m.games || []).reduce(([x, y], [p, q]) => [x + (p > q), y + (q > p)], [0, 0]);
      const sc = meta.walkover ? 'walkover' : (m.games || []).map(g => aW ? `${g[0]}:${g[1]}` : `${g[1]}:${g[0]}`).join(' ');
      const where = [showCup ? cupName(m.cup_id) : '', lb, sc].filter(Boolean).join(' · ');
      return `<div class="row hoverable result"><span class="rt"><span class="w">${esc(nice(aW ? m.a : m.b))}</span>
        <span class="l">beat ${esc(nice(aW ? m.b : m.a))}</span><span class="meta">${esc(where)}</span></span>
        <span class="s">${meta.walkover ? '' : (aW ? `${sa}:${sb}` : `${sb}:${sa}`)}</span>
        ${canScore() ? `<button class="link on-hover" data-act="edit" data-m="${m.id}">Edit result</button>` : ''}
      </div>`;
    }).join('')}</div>${hidden > 0
      ? `<button class="link more" data-act="recent-all">Show all ${hits.length}</button>`
      : recentAll && !q && all.length > RECENT_SHOWN
        ? `<button class="link more" data-act="recent-all">Show fewer</button>` : ''}</div>`;
  if (had) {
    const back = $('recent-q');
    if (back) { back.focus(); try { back.setSelectionRange(caret, caret); } catch (x) { } }
  }
}

/* ---------------------------------------------------------------- sheet */
/* ===================================================================== setup

   Four tabs, not nine, and they are grouped by when you touch them rather
   than by which table they write to. Door is the night; Event is everything
   you set up before it; Links is the three URLs; More is the two things you
   reach for once a month.

   The organising idea is that a cup is a container, not a foreign key. Its
   name, how you enter it, whether the form is open and the draw that
   confirmations land in are one decision, so they are one card. Spread
   across a Cups tab, a Formats tab and a Tables tab they were three, and
   the edge that mattered most — which draw the door feeds — was reachable
   from none of them. */

/* Chat only exists once a Telegram bot is connected: an optional layer
   stays out of sight until it is switched on. */
const sheetTabs = () => [['event', 'Event'], ['door', 'At the door']]
  .concat(tgOn() ? [['chat', 'Chat']] : [])
  .concat([['links', 'Links'], ['more', 'More']]);

/* Setup always opens on Event, the first page. Letting people in has its
   own mode (Door), so the door page here is only the count and the list. */
const defaultTab = () => 'event';

let sheetTabSet = false;

function renderSheet() {
  if (wiz) return renderWizard();
  if (!sheetTabSet) { sheetTab = defaultTab(); sheetTabSet = true; }
  // never rebuild the sheet out from under a half-typed field
  if (dirtyFocus()) return;
  const waiting = (S.registrations || []).filter(r => r.status === 'pending').length;
  const unread = tgOn() ? S.telegram.unread : 0;
  if (sheetTab === 'chat' && !tgOn()) sheetTab = 'links';
  $('tabs').innerHTML = sheetTabs().map(([k, l]) =>
    `<button class="${sheetTab === k ? 'on' : ''}" data-tab="${k}">${l}${
      k === 'door' && waiting ? ` <span class="count">${waiting}</span>` : ''}${
      k === 'chat' && unread ? ` <span class="count">${unread}</span>` : ''}</button>`).join('');
  // a result coming in on another table re-renders everything, and without
  // this the sheet jumps back to the top under whoever is reading it
  const body = $('sheet-body');
  const top = body.scrollTop;
  const [h1, lede] = TAB_HEAD[sheetTab] || TAB_HEAD.event;
  body.innerHTML = `<header class="page-head"><h1>${esc(h1)}</h1><p class="lede">${esc(lede)}</p></header>` + ({
    door: tabDoor, event: tabEvent, chat: tabChat, links: tabLinks, more: tabMore,
  }[sheetTab] || tabEvent)();
  body.scrollTop = top;
}

/* What each page of Setup is for, in one line under its title. */
const TAB_HEAD = {
  door: ['At the door', 'Who is expected, who is here. The desk is where check-in happens; this is the count and the roster as a list.'],
  event: ['Event', 'What the landing page shows, the cups and their draws, the tables, and the next event.'],
  chat: ['Chat', 'Write to tonight’s players or everyone following, and read what they write back.'],
  links: ['Links & posters', 'One link per job, no accounts. Hand out the referee one at the tables; keep this one to yourself.'],
  more: ['More', 'The club directory, past events, the log you can rewind, and a sandbox to rehearse in.'],
};

/* ------------------------------------------------------------ small parts */

const sec = (title, extra) => `<div class="sec"><h2>${esc(title)}</h2>
  <span class="line"></span>${extra || ''}</div>`;

/* v2: a section of the Event tab — title, one line saying what it is, the
   Why behind its toggle, any section-level action, then the body. On a wide
   sheet style.css (.sblock) puts the head in a 200px left column. */
const sblock = (title, desc, whyHtml, tools, body) => `<section class="sblock">
  <header class="shead"><h2>${esc(title)}</h2>
    ${tools ? `<div class="stools">${tools}</div>` : ''}
    ${whyHtml || ''}
    <p class="sdesc">${esc(desc)}</p></header>
  <div class="sbody">${body}</div></section>`;

/* Prose that is true but not needed every time. It stays — it is the only
   documentation this thing has — it just stops being wallpaper. */
const why = (...paras) => `<details class="why"><summary>Why</summary>${
  paras.map(p => `<p>${p}</p>`).join('')}</details>`;

/* An autosaving field. `data-was` carries what the server currently holds,
   so blur can tell a real edit from a visit and we never append a no-op to
   the log — which is also the rewind timeline, so noise in it is not free. */
const auto = (id, op, key, val, attrs) =>
  `<input id="${id}" value="${esc(val ?? '')}" data-was="${esc(val ?? '')}"
     data-save="${op}" data-key="${key}" ${attrs || ''}>`;

const autoArea = (id, op, key, val, attrs) =>
  `<textarea id="${id}" data-was="${esc(val ?? '')}" data-save="${op}"
     data-key="${key}" ${attrs || ''}>${esc(val ?? '')}</textarea>`;

const pick = (id, op, key, val, opts, attrs) =>
  `<select id="${id}" data-was="${esc(val ?? '')}" data-save="${op}"
     data-key="${key}" ${attrs || ''}>${opts.map(([v, l]) =>
    `<option value="${esc(v)}" ${String(val ?? '') === String(v) ? 'selected' : ''}>${esc(l)}</option>`
  ).join('')}</select>`;

function dirtyFocus() {
  const el = document.activeElement;
  if (!el || !el.dataset || el.dataset.was === undefined) return false;
  const sheet = $('sheet');
  return !!(sheet && sheet.contains(el) && el.value !== el.dataset.was);
}

const KIND_NAME_ALL = {
  open_play: 'Open play', groups: 'Groups', single_elim: 'Knockout', swiss: 'Swiss',
};

/* One line that says what a draw is, so the settings can stay shut. Takes
   a config, not a format, so the wizard can describe a draw it has not
   created yet from the same function that describes a running one. */
const formatSummary = f => summaryOf(f.kind, f.config);

function summaryOf(kind, cfg) {
  const f = { kind };
  const c = cfg || {};
  const sc = c.scoring || {};
  const bits = [];
  if (f.kind === 'open_play') bits.push({ pairs: 'fixed pairs', singles: 'singles',
    scramble: 'scramble doubles' }[c.mode] || c.mode || 'fixed pairs');
  if (f.kind === 'groups') {
    bits.push((c.n_groups || 2) + ' groups');
    if (c.then_ko !== false) bits.push('top ' + (c.advance_per_group || 2) + ' to a knockout');
  }
  if (f.kind === 'swiss') {
    bits.push(c.continuous === false ? 'strict rounds'
      : (c.paced ? 'paced' : 'free-running'));
    if (c.continuous !== false && !c.paced) { /* free-running has no round count */ }
    else bits.push((c.rounds || 5) + ' rounds');
    if (c.then_ko) bits.push('top ' + (c.advance || 4) + ' to a knockout');
  }
  if (f.kind === 'single_elim' && c.third_place) bits.push('third place match');
  bits.push('best of ' + (sc.best_of ?? 3));
  if ((sc.points_to ?? 11) !== 11) bits.push('to ' + sc.points_to);
  return bits.join(' · ');
}

/* the new-event wizard, unchanged: it is the one thing that is
   genuinely wizard-shaped — clear the old event and write the next
   one in a single reviewed commit. */

let wiz = null;              // null = closed
const WIZ_STEPS = ['Event', 'Cups', 'Tables', 'Review'];
function openWizard() {
  // carry forward: last event's cups, their formats and the table layout
  const cups = S.cups.map((c, i) => {
    const f = S.formats.find(x => x.id === c.format_id)
           || S.formats.find(x => x.cup_id === c.id);
    seedFormat('w' + i + '_', f ? f.kind : '', f ? f.config : null);
    return {
      name: c.name, blurb: c.blurb || '',
      entry: c.entry || 'single',
      registration: c.registration || 'closed',
      kind: f ? f.kind : 'swiss',
    };
  });
  if (!cups.length) {
    seedFormat('w0_', 'swiss', null);
    cups.push({ name: '', blurb: '', entry: 'single', registration: 'open', kind: 'swiss' });
  }
  wiz = {
    step: 0,
    name: '', venue: S.event.venue || '', blurb: S.event.blurb || '', starts_at: '',
    cups,
    tables: S.tables.length
      ? S.tables.map(t => ({ name: t.name, cup: S.cups.findIndex(c => c.id === t.cup_id) }))
      : [1, 2, 3].map(n => ({ name: 'Table ' + n, cup: -1 })),
  };
  setMode('setup');
}

function wizCarried() {
  return S.cups.length || S.formats.length || S.tables.length;
}

function renderWizard() {
  $('tabs').innerHTML = WIZ_STEPS.map((l, i) =>
    `<button class="${wiz.step === i ? 'on' : ''}" data-wstep="${i}">${i + 1}. ${l}</button>`).join('');
  const body = $('sheet-body');
  const top = body.scrollTop;
  body.innerHTML = `<header class="page-head"><h1>New event</h1><p class="lede">Step ${wiz.step + 1} of ${WIZ_STEPS.length}. Nothing changes until you create it on the last step.</p></header>` +
    [wizEvent, wizCups, wizTables, wizReview][wiz.step]() + wizNav();
  body.scrollTop = top;
}

function wizNav() {
  const last = wiz.step === WIZ_STEPS.length - 1;
  return `<div class="hr"></div><div class="inline" style="align-items:center">
    <button class="ghost" data-act="wiz-cancel">Cancel</button>
    <span style="flex:1"></span>
    ${wiz.step ? `<button class="ghost" data-act="wiz-back">Back</button>` : ''}
    ${last ? `<button class="danger" data-act="wiz-create">Create the event</button>`
           : `<button class="primary" data-act="wiz-next">Next</button>`}
  </div>`;
}

function wizEvent() {
  return `<div class="form">
    ${sec('The event')}
    <div class="inline">
      <div class="field"><label for="w-name">Name</label>
        <input id="w-name" value="${esc(wiz.name)}" data-w="name" placeholder="October open"></div>
      <div class="field" style="max-width:230px"><label for="w-start">Starts at</label>
        <input id="w-start" type="datetime-local" value="${esc(wiz.starts_at)}" data-w="starts_at"></div>
    </div>
    <div class="field"><label for="w-venue">Venue</label>
      <input id="w-venue" value="${esc(wiz.venue)}" data-w="venue"
             placeholder="Turnhalle, Hauptstraße 3"></div>
    <div class="field"><label for="w-blurb">Blurb</label>
      <textarea id="w-blurb" rows="2" data-w="blurb"
        placeholder="Open to everyone, bats provided, first match at seven.">${esc(wiz.blurb)}</textarea></div>
    ${why('Name and blurb are what the landing page shows. Until the start time the plain ' +
          'URL is that page; at the start time it becomes the console on its own.')}
    ${wizCarried() ? `<p class="sub">Cups, tables and their settings on the next two steps
      are carried over from ${esc(S.event.name || 'the last event')} — change what moved,
      leave the rest.</p>` : ''}
  </div>`;
}

/* The same card the Event tab uses, minus everything that only means
   something once the thing exists: no status, no Start, no entrants. What
   is left is the shape of the decision, which is the part worth keeping
   the same in both places. */
function wizCups() {
  return `<div class="form">
    ${sec('Cups')}
    ${wiz.cups.map((c, i) => {
      const pfx = 'w' + i + '_';
      const open = !!form['wfx_' + i];
      return `<div class="card"><div class="card-body">
        <div class="inline">
          <div class="field"><label for="wc-name-${i}">Name</label>
            <input id="wc-name-${i}" value="${esc(c.name)}" data-wc="${i}|name"
                   placeholder="Singles cup"></div>
          <div class="field" style="max-width:135px"><label for="wc-entry-${i}">Entry</label>
            <select id="wc-entry-${i}" data-wc="${i}|entry">
              <option value="single" ${c.entry === 'single' ? 'selected' : ''}>On your own</option>
              <option value="pair" ${c.entry === 'pair' ? 'selected' : ''}>As a pair</option>
            </select></div>
          <div class="field" style="max-width:135px"><label for="wc-reg-${i}">Sign-ups</label>
            <select id="wc-reg-${i}" data-wc="${i}|registration">
              <option value="open" ${c.registration === 'open' ? 'selected' : ''}>Open</option>
              <option value="closed" ${c.registration === 'closed' ? 'selected' : ''}>Closed</option>
            </select></div>
          ${wiz.cups.length > 1
            ? `<button class="ghost tiny" data-act="wiz-rm-cup" data-i="${i}">Remove</button>` : ''}
        </div>
        <div class="field"><label for="wc-blurb-${i}">One line for the landing page</label>
          <input id="wc-blurb-${i}" value="${esc(c.blurb)}" data-wc="${i}|blurb"
                 placeholder="Five rounds, then a cut to the last eight."></div>
      </div>
      <div class="card-sub">
        <div class="sumline">
          <div class="field" style="max-width:180px"><label for="wc-kind-${i}">Draw</label>
            <select id="wc-kind-${i}" data-wc="${i}|kind">
              <option value="" ${!c.kind ? 'selected' : ''}>Decide later</option>
              ${Object.entries(KIND_NAME_ALL).map(([k, l]) =>
                `<option value="${k}" ${c.kind === k ? 'selected' : ''}>${l}</option>`).join('')}
            </select></div>
          <span class="cfg">${c.kind ? esc(summaryOf(c.kind, formatConfig(pfx, c.kind))) : ''}</span>
          ${c.kind ? `<button class="ghost tiny" data-act="wiz-fx" data-i="${i}">${
            open ? 'Done' : 'Change'}</button>` : ''}
        </div>
      </div>
      ${c.kind && open ? `<div class="card-sub muted">
        <div class="inline">
          <div class="field" style="max-width:105px"><label for="${pfx}f-bo">Best of</label>
            <select id="${pfx}f-bo" data-f="${pfx}f_bo">${[1, 3, 5, 7].map(n =>
              `<option value="${n}" ${+(form[pfx + 'f_bo'] ?? 3) === n ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
          <div class="field" style="max-width:105px"><label for="${pfx}f-pts">Points to</label>
            <select id="${pfx}f-pts" data-f="${pfx}f_pts">${[11, 21].map(n =>
              `<option value="${n}" ${+(form[pfx + 'f_pts'] ?? 11) === n ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
        </div>
        ${(fieldsFor(pfx)[c.kind] || (() => ''))()}
      </div>` : ''}
      </div>`;
    }).join('')}
    <div class="inline"><button class="ghost" data-act="wiz-add-cup">Add another cup</button></div>
    ${why('A cup is a sub-tournament and the unit of entry: a registration names one cup, ' +
          'and whoever you confirm at the door lands in that cup’s draw. One cup is the ' +
          'normal case; two is how you run singles and doubles side by side.',
          'Nobody is entered yet — a draw starts empty and fills up as you confirm people ' +
          'at the door.')}
  </div>`;
}

function wizTables() {
  const many = wiz.cups.length > 1;
  const cell = (t, i) => `<div class="tcell">
      <span class="mt" aria-hidden="true"><span>${i + 1}</span></span>
      <input id="wt-name-${i}" class="tname" value="${esc(t.name)}" data-wt="${i}|name"
        aria-label="Name of table ${i + 1}" placeholder="Table ${i + 1}">
      ${many ? `<select id="wt-cup-${i}" class="tcup" data-wt="${i}|cup" aria-label="Table ${i + 1} goes to">
        <option value="-1" ${t.cup < 0 ? 'selected' : ''}>Shared</option>
        ${wiz.cups.map((c, ci) =>
          `<option value="${ci}" ${t.cup === ci ? 'selected' : ''}>${
            esc(c.name || 'Cup ' + (ci + 1))}</option>`).join('')}
      </select>` : ''}
      <span class="tacts"><button class="link" data-act="wiz-rm-table" data-i="${i}">Remove</button></span>
    </div>`;
  return `<div class="form">
    ${sec('Tables')}
    <div class="tset">${wiz.tables.map(cell).join('')}
      <button class="tcell addt" data-act="wiz-add-table">+ Add a table</button></div>
    ${wiz.tables.length ? '' : '<p class="blank">No tables yet. Add at least one, or no match can be sent anywhere.</p>'}
    ${why('A table with no cup is shared by everything running. Give it a cup and it is ' +
          'reserved for that cup — that is how you split the hall between two draws going ' +
          'at once.')}
  </div>`;
}

function wizReview() {
  const gone = [
    S.players.length ? S.players.length + (S.players.length === 1 ? ' player' : ' players') : '',
    S.entrants.length ? S.entrants.length + ' teams and entries' : '',
    S.formats.length ? S.formats.length + (S.formats.length === 1 ? ' draw' : ' draws')
      + ' and all their matches' : '',
    (() => {
      const n = (S.registrations || []).filter(r => r.status === 'pending').length;
      return n ? `${n} ${n === 1 ? 'entry' : 'entries'} nobody has confirmed yet` : '';
    })(),
  ].filter(Boolean);
  return `<div class="form">
    ${sec('About to create')}
    <div class="card"><div class="card-body">
      <div class="inline" style="align-items:baseline">
        <h2 style="font-size:19px;margin:0">${esc(wiz.name || 'Untitled event')}</h2>
        <span class="sub" style="margin:0">${esc(wiz.starts_at
          ? new Date(wiz.starts_at).toLocaleString()
          : 'no start time — the console shows immediately')}</span>
      </div>
      ${wiz.venue ? `<p class="sub">${esc(wiz.venue)}</p>` : ''}
    </div>
    ${wiz.cups.map((c, i) => `<div class="card-sub">
      <div class="sumline">
        <span class="what">${esc(c.name || 'Unnamed cup')}</span>
        <span class="cfg">${c.kind
          ? esc(KIND_NAME_ALL[c.kind] + ' · ' + summaryOf(c.kind, formatConfig('w' + i + '_', c.kind)))
          : 'no draw yet'}</span>
        <span class="chip">${c.entry === 'pair' ? 'pairs' : 'singles'}</span>
        <span class="chip${c.registration === 'open' ? ' hot' : ''}">${
          c.registration === 'open' ? 'taking entries' : 'sign-ups closed'}</span>
      </div></div>`).join('')}
    <div class="card-sub muted"><span class="sub">${wiz.tables.length} table${
      wiz.tables.length === 1 ? '' : 's'}${wiz.tables.some(t => t.cup >= 0)
        ? ', some reserved for a cup' : ', all shared'}.</span></div>
    </div>

    ${sec('And clearing')}
    ${gone.length
      ? `<div class="warn-in">${esc(gone.join(', '))} — gone from the live state.</div>
         ${why('Tables and your access links stay, and nothing is deleted from the log, so ' +
               'More → Log still rewinds back across this.')}`
      : `<p class="sub">Nothing to clear — the event is already empty.</p>`}
  </div>`;
}


/* ------------------------------------------------------------ Event tab */

const PHASE_LABEL = {
  announced: 'the site shows the event, registration is shut',
  registration: 'the site is taking entries',
  doors: 'the console is up, confirming who showed',
  live: 'the console is the public page',
  done: 'the site shows results',
};

const fmtsOfCup = cid => S.formats.filter(f => (f.cup_id || '') === (cid || ''));
const tablesOfCup = cid => S.tables.filter(t => (t.cup_id || '') === (cid || ''));

function tabEvent() {
  const ev = S.event || {};
  const loose = fmtsOfCup('');
  const pl = PHASE_LABEL[S.phase] || '';
  const phase = `<div class="phase">
      <span class="plabel">Phase</span>
      ${phaseStep()}
      <span class="sub">${esc(pl.charAt(0).toUpperCase() + pl.slice(1))} · ${ev.phase_pin
        ? `pinned <button type="button" class="link" data-phase-pin="">Follow the clock</button>`
        : 'following the clock'}</span>
    </div>`;

  const event = sblock('The event',
    'What the landing page shows, and when the URL turns into the console.',
    why('Name and blurb are what the landing page shows. Until the start time the plain ' +
        'URL is that page; at the start time it becomes the console on its own — no button ' +
        'to remember to press.',
        'Pin the phase to open the doors early, hold them, or put the landing page back up ' +
        'afterwards. Your admin and referee links always show the console, whatever the phase.'),
    '',
    `${phase}
    <div class="inline">
      <div class="field"><label for="ev-title">Name</label>
        ${auto('ev-title', 'event_meta', 'name', ev.name, 'placeholder="October open"')}</div>
      <div class="field" style="max-width:200px"><label for="ev-start">Starts at</label>
        ${auto('ev-start', 'event_meta', 'starts_at', ev.starts_at, 'type="datetime-local"')}</div>
      <div class="field" style="max-width:110px;min-width:110px"><label for="ev-end">Ends at</label>
        ${auto('ev-end', 'event_meta', 'ends_at', ev.ends_at || '', 'type="time"')}</div>
    </div>
    <div class="inline">
      <div class="field"><label for="ev-venue">Venue</label>
        ${auto('ev-venue', 'event_meta', 'venue', ev.venue,
               'placeholder="Turnhalle, Hauptstraße 3"')}</div>
    </div>
    <div class="field"><label for="ev-blurb">Blurb</label>
      ${autoArea('ev-blurb', 'event_meta', 'blurb', ev.blurb, 'rows="2" ' +
        'placeholder="Open to everyone, bats provided, first match at seven."')}</div>`);

  const cups = sblock('Cups',
    'Each cup is one entry form and one draw. Confirmed people land in its draw.',
    why('A cup is a sub-tournament and the unit of entry: a registration names one cup, ' +
        'and whoever you confirm at the door lands in that cup’s draw. One cup is the ' +
        'normal case; two is how you run singles and doubles side by side.',
        'A cup that is open appears on the landing page with a button to enter.'),
    '',
    `${S.cups.map(cupCard).join('')}
    ${!S.cups.length ? `<p class="blank">No cups yet. Everything runs in one view until you add one.</p>` : ''}
    <div class="inline">
      <div class="field" style="max-width:230px">
        <input id="cup-name" value="${esc(form.cupname || '')}" data-f="cupname"
               placeholder="Name another cup" aria-label="Name another cup"></div>
      <button data-act="add-cup">Add</button>
    </div>`).replace('<section class="sblock">', '<section class="sblock wide">');   // the cups take the page's full width

  const notInCup = loose.length ? sblock('Not in a cup',
    'These run and share the tables like any other draw, they just have no cup of their own and no door feeding them.',
    '', '',
    loose.map(f => `<div class="card"><div class="card-body">
        ${formatBlock(f, null)}</div></div>`).join('')) : '';

  const next = sblock('Next event',
    'Opens pre-filled from this one, with a review before anything is cleared.',
    why('Players, teams, matches and formats are cleared. Your access links stay, and ' +
        'nothing is deleted from the log — More → Log still rewinds back across it.'),
    '',
    `<div class="inline"><button data-act="wiz-open">Set up a new event</button></div>`);

  return `<div class="form">${event}${cups}${notInCup}${tablesSection()}${next}</div>`;
}

/* A cup and everything that is true of it. The draw lives here rather than
   on a tab of its own, which is what lets creating one bind both edges:
   the format's cup_id, and the cup's format_id — the draw the door feeds. */
function cupCard(c) {
  const fs = fmtsOfCup(c.id);
  const intake = c.format_id || '';
  const orphan = fs.length && !intake;
  const mine = tablesOfCup(c.id);
  const taking = (c.registration || 'closed') === 'open';
  return `<div class="card cupcard"><div class="card-body">
    <div class="cuphead">
      <div class="field cname">
        ${auto('cn-' + c.id, 'update_cup:' + c.id, 'name', c.name, 'aria-label="Cup name"')}</div>
      ${taking ? `<span class="chip hot">taking entries</span>` : ''}
      <button class="ghost tiny" data-act="rm-cup" data-c="${c.id}">Remove</button>
    </div>
    <div class="inline">
      <div class="field" style="max-width:190px"><label for="ce-${c.id}">Entry</label>
        ${pick('ce-' + c.id, 'update_cup:' + c.id, 'entry', c.entry || 'single',
          [['single', 'On your own'], ['pair', 'As a pair']])}</div>
      <div class="field" style="max-width:190px"><label for="cr-${c.id}">Sign-ups</label>
        ${pick('cr-' + c.id, 'update_cup:' + c.id, 'registration', c.registration || 'closed',
          [['open', 'Open'], ['closed', 'Closed']])}</div>
      <div class="field" style="min-width:240px"><label for="cb-${c.id}">One line for the landing page</label>
        ${auto('cb-' + c.id, 'update_cup:' + c.id, 'blurb', c.blurb || '',
               'placeholder="Five rounds, then a cut to the last eight."')}</div>
    </div>
    ${mine.length ? `<p class="sub">Reserved tables: ${
      mine.map(t => esc(t.name)).join(', ')}</p>` : ''}
    </div>

    ${orphan ? `<div class="card-sub"><div class="warn-in">
      This cup has a draw but nothing points the door at it, so confirming somebody
      leaves them on the roster instead of entering them.
      <div class="inline"><button class="primary tiny" data-act="set-intake"
        data-c="${c.id}" data-i="${fs[0].id}">Send entries to ${esc(fs[0].name || KIND_NAME_ALL[fs[0].kind])}</button></div>
    </div></div>` : ''}

    ${fs.map(f => `<div class="card-sub">${formatBlock(f, c)}</div>`).join('')}
    ${newDrawBlock(c)}
  </div>`;
}

/* A draw, shut by default: one line that says what it is, and its settings
   behind "Change". Settings are the one place a Save button still earns its
   keep — blurring "rounds" half way through changing the kind would
   otherwise write a config that is neither. */
function formatBlock(f, cup) {
  const open = !!form['fx_' + f.id];
  const pfx = 'fe' + f.id + '_';
  const running = f.status === 'running';
  const canCut = f.kind === 'swiss' && running && f.phase !== 'ko';
  const isIntake = cup && cup.format_id === f.id;
  const many = cup && fmtsOfCup(cup.id).length > 1;
  return `<div class="sumline">
      <span class="lbl">Draw</span>
      <span class="what">${esc(KIND_NAME_ALL[f.kind] || f.kind)}</span>
      <span class="cfg">${esc(f.name && f.name !== (cup || {}).name ? f.name + ' · ' : '')}${
        esc(formatSummary(f))}</span>
      ${f.status !== 'setup' ? `<span class="chip${running ? ' hot' : ''}">${esc(f.status)}${
        f.phase ? ' · ' + esc(f.phase) : ''}</span>` : ''}
      ${many ? (isIntake
        ? `<span class="chip state">entries land here</span>`
        : `<button class="ghost tiny" data-act="set-intake" data-c="${cup.id}" data-i="${f.id}"
            >send entries here</button>`) : ''}
      <div class="acts">
        ${!running ? `<button class="primary tiny" data-act="start-format" data-i="${f.id}">Start</button>` : ''}
        ${canCut ? `<button class="ghost tiny" data-act="cut-ko" data-i="${f.id}">Cut to knockout now</button>` : ''}
        ${f.status !== 'setup' ? `<button class="ghost tiny" data-act="reset-format" data-i="${f.id}">Reset</button>` : ''}
        <button class="tiny solid" data-act="fx" data-i="${f.id}">${open ? 'Done' : 'Change'}</button>
        <button class="ghost tiny" data-act="rm-format" data-i="${f.id}">Remove</button>
      </div>
    </div>
    ${open ? drawSettings(f, pfx) : ''}`;
}

/* Scoring sits inside the disclosure with everything else: it is 3 and 11
   almost every time, and a control you never change is still a control you
   have to read past. */
function drawSettings(f, pfx) {
  return `<div class="card-sub muted">
    <div class="inline">
      <div class="field" style="max-width:190px"><label for="${pfx}name">Name</label>
        <input id="${pfx}name" value="${esc(form[pfx + 'name'] ?? f.name)}" data-f="${pfx}name"></div>
      <div class="field" style="max-width:105px"><label for="${pfx}f-bo">Best of</label>
        <select id="${pfx}f-bo" data-f="${pfx}f_bo">${[1, 3, 5, 7].map(n =>
          `<option value="${n}" ${+(form[pfx + 'f_bo'] ?? 3) === n ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
      <div class="field" style="max-width:105px"><label for="${pfx}f-pts">Points to</label>
        <select id="${pfx}f-pts" data-f="${pfx}f_pts">${[11, 21].map(n =>
          `<option value="${n}" ${+(form[pfx + 'f_pts'] ?? 11) === n ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
    </div>
    ${(fieldsFor(pfx)[f.kind] || (() => ''))()}
    ${f.cup_id ? '' : `<p class="sub">Not in a cup, so nobody is sent here automatically.</p>`}
    <div class="inline">
      <button class="primary tiny" data-act="save-format" data-i="${f.id}">Save these settings</button>
    </div>
  </div>`;
}

/* Adding a draw to a cup. The kind select is the prior step: nothing below
   it exists until you have answered it, and answering it is what makes the
   cup's door have somewhere to point. */
function newDrawBlock(c) {
  const kind = form['nk_' + c.id] || '';
  const pfx = 'nf' + c.id + '_';
  const has = fmtsOfCup(c.id).length;
  if (!kind) {
    return `<div class="card-sub"><div class="inline" style="align-items:center">
      <span class="sub" style="flex:1;margin:0">${has
        ? 'Another draw in this cup — a consolation bracket, say.'
        : 'No draw yet. Entries confirmed at the door will sit on the roster until there is one.'}</span>
      <div class="field" style="max-width:190px">
        <select data-nk="${c.id}">
          <option value="">${has ? 'Add another draw…' : 'Choose a format…'}</option>
          ${Object.entries(KIND_NAME_ALL).map(([k, l]) =>
            `<option value="${k}">${l}</option>`).join('')}
        </select></div>
    </div></div>`;
  }
  return `<div class="card-sub muted">
    <div class="inline">
      <div class="field" style="max-width:190px"><label>Format</label>
        <select data-nk="${c.id}">
          <option value="">Cancel</option>
          ${Object.entries(KIND_NAME_ALL).map(([k, l]) =>
            `<option value="${k}" ${kind === k ? 'selected' : ''}>${l}</option>`).join('')}
        </select></div>
      <div class="field" style="max-width:105px"><label for="${pfx}f-bo">Best of</label>
        <select id="${pfx}f-bo" data-f="${pfx}f_bo">${[1, 3, 5, 7].map(n =>
          `<option value="${n}" ${+(form[pfx + 'f_bo'] ?? 3) === n ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
      <div class="field" style="max-width:105px"><label for="${pfx}f-pts">Points to</label>
        <select id="${pfx}f-pts" data-f="${pfx}f_pts">${[11, 21].map(n =>
          `<option value="${n}" ${+(form[pfx + 'f_pts'] ?? 11) === n ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
    </div>
    ${(fieldsFor(pfx)[kind] || (() => ''))()}
    <div class="inline">
      <button class="primary tiny" data-act="add-draw" data-c="${c.id}">Create the draw</button>
      <span class="sub" style="margin:0">Starts empty and fills up as you confirm people.</span>
    </div>
  </div>`;
}

/* Tables stay one flat list rather than moving inside the cup cards:
   reassigning is the common operation, and "drag it to the other card" is a
   worse answer to that than a column. The column only exists when there is
   more than one cup to choose between. */
/* Shared and split are not a setting — they are read off the tables. No
   table tagged means shared; any table tagged means split. Keeping it
   derived is what stops a stored mode from disagreeing with the tables it
   is supposed to describe. */
const tablesAreSplit = () => S.tables.some(t => t.cup_id);

function tablesSection() {
  const split = tablesAreSplit();
  const many = S.cups.length > 1;
  const tools = many ? `<button class="ghost tiny" data-act="${
    split ? 'share-tables' : 'split-tables'}">${
    split ? 'Share them all' : 'Split between cups'}</button>` : '';
  /* One cell per table, laid out like the hall: the painted table with its
     number, its name, the cup it goes to, and what it is doing now. A paused
     table is drawn dashed. Remove only shows on a table with nothing on it
     (the server refuses the other case anyway). */
  const cell = t => {
    const busy = !!t.match;
    // the cup is only worth naming when the cell's own select doesn't say it
    const own = !many || (t.cup_id && t.cup_id === t.match?.cup_id);
    const state = t.paused ? 'Paused' : busy ? (own ? 'Playing' : `Playing · ${esc(cupName(t.match.cup_id) || 'a match')}`) : 'Free';
    return `<div class="tcell${t.paused ? ' paused' : ''}${busy ? ' busy' : ''}">
      <span class="mt" aria-hidden="true"><span>${t.number}</span></span>
      ${auto('tn-' + t.number, 'set_table:' + t.number, 'name', t.name,
        `class="tname" aria-label="Name of table ${t.number}" placeholder="Table ${t.number}"`)}
      ${many ? pick('tc-' + t.number, 'set_table:' + t.number, 'cup_id', t.cup_id || '',
        [['', 'Shared']].concat(S.cups.map(c => [c.id, c.name])),
        `class="tcup" aria-label="Table ${t.number} goes to"`) : ''}
      <span class="tstate micro">${state}</span>
      <span class="tacts">
        <button class="link" data-act="pause" data-t="${t.number}">${t.paused ? 'Resume' : 'Pause'}</button>
        ${busy ? '' : `<button class="link" data-act="rm-table" data-t="${t.number}">Remove</button>`}
      </span></div>`;
  };
  const body = `<div class="tset">${S.tables.map(cell).join('')}
      <button class="tcell addt" data-act="add-table">+ Add a table</button></div>
    ${S.tables.length ? '' : '<p class="blank">No tables yet. Add at least one, or no match can be sent anywhere.</p>'}`;
  return sblock('Tables',
    many ? 'Where matches are sent. Give a table to one cup, or leave it shared. Pause one to stop matches going to it.'
         : 'Where matches are sent. Pause one to stop matches going to it.',
    why('Pausing a table stops the dispatcher sending matches to it. Changing a table’s ' +
        'cup takes effect straight away.',
        many && split
          ? 'Each cup only ever plays on its own tables, so “which table” is a real ' +
            'answer for a spectator. A cup with nothing ready leaves its tables standing empty.'
          : 'A shared table goes to whichever cup is furthest from finishing, so a big cup ' +
            'can’t starve a small one and nothing stands idle — but you cannot tell anyone ' +
            'which table they are on until they are called.'),
    tools, body + (many ? `<label class="pick"><input type="checkbox" data-autolend="1"
      ${S.event.auto_lend !== false ? 'checked' : ''}> Lend an idle reserved table to a waiting cup for one game</label>
      ${why('A cup with nothing ready — a Swiss round waiting on its last match — would leave ' +
            'its tables empty. This seats whoever is waiting there for one game; the table ' +
            'is the owner’s again after it.')}` : ''));
}

/* Format settings, defined once and bound to a prefix, so the Formats tab
   and the new-event wizard render the same controls instead of two copies
   that drift apart. `v` reads a value, `k` names the sticky form key. */
const fieldsFor = pfx => {
  const k = key => pfx + key;
  const v = (key, dflt) => form[pfx + key] ?? dflt;
  const id = name => pfx + name;
  return {
    open_play: () => `
    <div class="inline">
      <div class="field"><label for="${id('c-mode')}">Who plays whom</label>
        <select id="${id('c-mode')}" data-f="${k('c_mode')}">
          <option value="pairs" ${v('c_mode') === 'pairs' ? 'selected' : ''}>Fixed pairs</option>
          <option value="singles" ${v('c_mode') === 'singles' ? 'selected' : ''}>Singles</option>
          <option value="scramble" ${v('c_mode') === 'scramble' ? 'selected' : ''}>Scramble doubles</option>
        </select></div>
      ${SHOW_STRENGTH ? `<div class="field" style="max-width:120px"><label for="${id('c-gap')}">Strength gap</label>
        <input id="${id('c-gap')}" value="${esc(v('c_gap', 1.5))}" data-f="${k('c_gap')}" inputmode="decimal"></div>` : ''}
      <div class="field" style="max-width:130px"><label for="${id('c-widen')}">Widen after</label>
        <input id="${id('c-widen')}" value="${esc(v('c_widen', 3))}" data-f="${k('c_widen')}" inputmode="numeric"></div>
      <div class="field" style="max-width:150px"><label for="${id('c-rw')}">Avoid rematches</label>
        <select id="${id('c-rw')}" data-f="${k('c_rw')}">
          <option value="0" ${v('c_rw') === '0' ? 'selected' : ''}>Off — closest match always</option>
          <option value="0.6" ${v('c_rw', '0.6') === '0.6' ? 'selected' : ''}>Balanced</option>
          <option value="1.2" ${v('c_rw') === '1.2' ? 'selected' : ''}>Strong</option>
        </select></div>
    </div>
    ${SHOW_STRENGTH ? why('The gap widens by one every few times a waiting entrant is passed over, so ' +
          'nobody sits all night waiting for a perfect match.',
          'Avoiding rematches is priced in strength points: on a lopsided field, ' +
          '<b>strong</b> buys variety by pairing people further apart.') : ''}`,
    groups: () => `
    <div class="inline">
      <div class="field" style="max-width:110px"><label for="${id('c-groups')}">Groups</label>
        <input id="${id('c-groups')}" value="${esc(v('c_groups', 2))}" data-f="${k('c_groups')}" inputmode="numeric"></div>
      <div class="field" style="max-width:150px"><label for="${id('c-adv')}">Advance per group</label>
        <input id="${id('c-adv')}" value="${esc(v('c_adv', 2))}" data-f="${k('c_adv')}" inputmode="numeric"></div>
      <label class="pick"><input type="checkbox" id="${id('c-ko')}" data-f="${k('c_ko')}" ${v('c_ko') !== false ? 'checked' : ''}> then a knockout</label>
      <label class="pick"><input type="checkbox" id="${id('c-third')}" data-f="${k('c_third')}" ${v('c_third') ? 'checked' : ''}> third place match</label>
    </div>`,
    single_elim: () => `<label class="pick"><input type="checkbox" id="${id('c-third')}" data-f="${k('c_third')}" ${v('c_third') ? 'checked' : ''}> third place match</label>`,
    swiss: () => `
    <div class="inline">
      <div class="field" style="max-width:110px"><label for="${id('c-rounds')}">Rounds</label>
        <input id="${id('c-rounds')}" value="${esc(v('c_rounds', 5))}" data-f="${k('c_rounds')}" inputmode="numeric"></div>
      <div class="field"><label for="${id('c-pace')}">Pairing</label>
        <select id="${id('c-pace')}" data-f="${k('c_pace')}">
          <option value="paced" ${v('c_pace', 'paced') === 'paced' ? 'selected' : ''}>Paced — on demand, same games played only</option>
          <option value="strict" ${v('c_pace') === 'strict' ? 'selected' : ''}>Strict rounds — everyone waits for the round</option>
          <option value="free" ${v('c_pace') === 'free' ? 'selected' : ''}>Free-running — on demand, no round limit</option>
        </select></div>
    </div>
    ${why('<b>Paced</b> pairs people the moment a table frees up, but only against ' +
          'someone who has played the same number of games, and stops them at the round ' +
          'count — never across tiers, except someone left alone in theirs playing up to ' +
          'catch up. No table ever waits on the one match that went to deuce in the fifth, ' +
          'and the field stays close — which also matters when you are sharing tables, ' +
          'because a draw that races ahead takes tables from the one that hasn\'t.',
          '<b>Strict rounds</b> is classic Swiss and will idle tables at the end of every ' +
          'round. <b>Free-running</b> never ends on its own — cut it to a knockout when ' +
          'you are ready.')}
    <div class="inline">
      <label class="pick"><input type="checkbox" id="${id('c-swko')}" data-f="${k('c_swko')}" ${v('c_swko') ? 'checked' : ''}> then a knockout</label>
      <div class="field" style="max-width:150px"><label for="${id('c-swadv')}">Advance to KO</label>
        <input id="${id('c-swadv')}" value="${esc(v('c_swadv', 4))}" data-f="${k('c_swadv')}" inputmode="numeric"></div>
      <label class="pick"><input type="checkbox" id="${id('c-third')}" data-f="${k('c_third')}" ${v('c_third') ? 'checked' : ''}> third place match</label>
    </div>
    ${why('The top finishers cross into a bracket the moment the Swiss is done. A ' +
          'free-running Swiss has no finish of its own — use \u201cCut to knockout now\u201d ' +
          'on the running draw when you are ready, which also works part-way through if ' +
          'you are short on time.')}`,
  };
};

const KIND_FIELDS = fieldsFor('');

/* The inverse pair: read the form back into a format config, and seed the
   form from one. Carry-forward in the wizard is `seedFormat` over last
   event's settings — nothing is inherited invisibly, it is just the form
   arriving filled in. */
function formatConfig(pfx, kind) {
  const n = key => { const x = parseFloat(form[pfx + key]); return isNaN(x) ? null : x; };
  const v = (key, dflt) => form[pfx + key] ?? dflt;
  const cfg = {
    scoring: { best_of: +v('f_bo', 3), points_to: +v('f_pts', 11) },
  };
  if (kind === 'open_play') Object.assign(cfg, {
    mode: v('c_mode', 'pairs'),
    base_gap: n('c_gap') ?? 1.5,
    widen_every: n('c_widen') || 3,
    rematch_weight: n('c_rw') ?? 0.6,
    avoid_rematch: (n('c_rw') ?? 0.6) > 0,
  });
  if (kind === 'groups') Object.assign(cfg, {
    n_groups: n('c_groups') || 2, then_ko: v('c_ko') !== false,
    advance_per_group: n('c_adv') || 2, third_place: !!v('c_third'),
  });
  if (kind === 'single_elim') cfg.third_place = !!v('c_third');
  if (kind === 'swiss') {
    const pace = v('c_pace', 'paced');
    Object.assign(cfg, {
      rounds: n('c_rounds') || 5,
      continuous: pace !== 'strict', paced: pace === 'paced',
      then_ko: !!v('c_swko'), advance: n('c_swadv') || 4,
      third_place: !!v('c_third'),
    });
  }
  return cfg;
}

function seedFormat(pfx, kind, cfg) {
  cfg = cfg || {};
  const set = (key, val) => { if (val !== undefined && val !== null) form[pfx + key] = val; };
  const sc = cfg.scoring || {};
  set('f_bo', sc.best_of ?? 3);
  set('f_pts', sc.points_to ?? 11);
  if (kind === 'open_play') {
    set('c_mode', cfg.mode); set('c_gap', cfg.base_gap);
    set('c_widen', cfg.widen_every);
    if (cfg.rematch_weight !== undefined) form[pfx + 'c_rw'] = String(cfg.rematch_weight);
  }
  if (kind === 'groups') {
    set('c_groups', cfg.n_groups); set('c_adv', cfg.advance_per_group);
    form[pfx + 'c_ko'] = cfg.then_ko !== false;
    form[pfx + 'c_third'] = !!cfg.third_place;
  }
  if (kind === 'single_elim') form[pfx + 'c_third'] = !!cfg.third_place;
  if (kind === 'swiss') {
    set('c_rounds', cfg.rounds);
    form[pfx + 'c_pace'] = cfg.continuous === false ? 'strict' : (cfg.paced ? 'paced' : 'free');
    form[pfx + 'c_swko'] = !!cfg.then_ko;
    set('c_swadv', cfg.advance);
    form[pfx + 'c_third'] = !!cfg.third_place;
  }
}

/* -------------------------------------------------------------- Door tab

   The night. An entry is an intention; this is where whoever actually
   walked in becomes a player. Per cup, in the order it happens:
   Pre-registered (each with its own Confirm), then the pool they join.
   The claimed strength sits next to what we remember about them, and what
   you type wins over both. */

const nameKey = n => (n || '').trim().toLowerCase().replace(/\s+/g, ' ');

function knownFor(name) {
  const k = nameKey(name);
  return (S.people || []).find(p => nameKey(p.name) === k);
}

const playerName = id => (S.players.find(p => p.id === id) || {}).name || '';
const cupById = id => S.cups.find(c => c.id === id);
const regById = id => (S.registrations || []).find(r => r.id === id);

/* The mirror of the server's check (App._refuse_duplicate), so the door can
   say so while you type instead of after you press the button. The server
   is still the one that refuses.

   Singles: the name must be new tonight. Doubles: only the same two people
   together are a duplicate — somebody can be in a singles cup and a doubles
   cup, and can change partners. Pre-registrations are not checked; they
   are allowed to overlap, and this is where the overlap is sorted out. */
function dupMsg(cupId, kind, name, partner) {
  const cup = cupById(cupId);
  if (!nameKey(name)) return '';
  if (kind === 'pair') {
    if (!nameKey(partner)) return '';
    const want = [nameKey(name), nameKey(partner)].sort().join('|');
    const hit = S.entrants.some(e => e.player_ids.length === 2 &&
      e.player_ids.map(i => nameKey(playerName(i))).sort().join('|') === want);
    return hit ? `${name.trim()} & ${partner.trim()} are already a team tonight.` : '';
  }
  if (cup && cup.entry === 'pair') return '';
  const hit = S.entrants.some(e => e.player_ids.length === 1 &&
    nameKey(playerName(e.player_ids[0])) === nameKey(name));
  return hit ? `There is already a “${name.trim()}” tonight — add something to tell them ` +
    `apart, like “${name.trim()} (blue shirt)”.` : '';
}

/* What the door will actually use, before anyone touches the box. Rendering
   and submitting both go through this: the first version of it worked these
   out separately, so the box showed what we remembered and then sent what
   they claimed. */
function admitDefaults(r) {
  const mate = r.matched_with ? regById(r.matched_with) : null;
  const pName = r.partner_name || (mate && mate.status === 'pending' ? mate.name : '');
  const pStr = r.partner_name ? r.partner_strength : (mate ? mate.strength : r.partner_strength);
  const k = knownFor(r.name);
  const pk = pName ? knownFor(pName) : null;
  return {
    strength: form['rs-' + r.id] ?? (k ? k.strength : r.strength),
    partner_strength: form['rps-' + r.id] ?? (pk ? pk.strength : pStr),
    name: form['rn-' + r.id] ?? r.name,
    partner_name: form['rp-' + r.id] ?? pName,
  };
}

/* The registration that comes in together with this one: the other half of
   a matched team, if it is still waiting. */
function mateOf(r) {
  const m = r.matched_with ? regById(r.matched_with) : null;
  return m && m.status === 'pending' ? m : null;
}

function admitPayload(r) {
  const d = admitDefaults(r);
  return {
    registration_id: r.id,
    name: d.name,
    strength: parseFloat(d.strength),
    partner_name: d.partner_name,
    partner_strength: parseFloat(d.partner_strength),
    kind: d.partner_name ? 'pair' : 'single',
  };
}

const regDup = r => {
  const d = admitDefaults(r);
  return dupMsg(r.cup_id, d.partner_name ? 'pair' : 'single', d.name, d.partner_name);
};

/* One pending entry. Two lines at most, and the strength box carries what
   we know beside it rather than in a paragraph underneath. */
function regRow(r) {
  const mate = mateOf(r);
  const seeking = r.kind === 'seeking';
  const d = admitDefaults(r);
  const known = knownFor(d.name);
  const pKnown = d.partner_name ? knownFor(d.partner_name) : null;
  const note = n => n ? `<span class="sub" style="margin:0;white-space:nowrap">${esc(n)}</span>` : '';
  const seen = (k, claimed) => !SHOW_STRENGTH ? '' : note(
    k ? `last time ${k.strength}${+k.strength !== +claimed ? ` · said ${claimed}` : ''}`
      : `said ${claimed}`);
  // registered twice: not blocked, just said, because one of them is a no-show
  const twice = (S.registrations || []).some(o => o.id !== r.id && o.status === 'pending'
    && nameKey(o.name) === nameKey(r.name) && (!mate || o.id !== mate.id));
  const dup = regDup(r);
  const tag = mate
    ? `<span class="chip hot">MATCHED TEAM</span>
       <span class="sub">${esc(r.name)} plays with <b>${esc(mate.name)}</b></span>`
    : seeking && !d.partner_name
      ? `<span class="chip warn">LOOKING FOR PARTNER</span>
         <span class="sub">nobody to match with yet</span>`
      : r.kind === 'pair'
        ? `<span class="chip state">TEAM</span>${r.team_name
          ? ` <span class="sub"><b>${esc(r.team_name)}</b></span>` : ''}` : '';
  const tg = r.tg_id ? tgChip(r.person_id ? 'Entered on Telegram, and known'
    : 'Entered on Telegram — confirming links the account to this person') : '';
  const rsvp = r.rsvp === 'yes'
    ? '<span class="chip state" title="Said yes to the reminder">coming</span>' : '';
  return `<div class="entry" id="reg-${r.id}">
    ${tag || twice || tg || rsvp ? `<div class="tag">${tag}${twice
      ? ' <span class="chip dim">registered twice</span>' : ''}${tg}${rsvp}</div>` : ''}
    <div class="drow" style="--cols:${SHOW_STRENGTH ? '1fr 76px 150px auto' : '1fr auto'}">
      <input id="rn-${r.id}" value="${esc(d.name)}" data-f="rn-${r.id}">
      ${SHOW_STRENGTH ? `<input id="rs-${r.id}" value="${esc(d.strength)}" data-f="rs-${r.id}" inputmode="decimal">
      ${seen(known, r.strength)}` : ''}
      <span class="acts">
        <button class="primary tiny" id="ok-${r.id}" data-act="admit" data-r="${r.id}"
          ${dup ? 'disabled' : ''}>${mate ? 'Confirm team' : 'Confirm'}</button>
        <button class="ghost tiny" data-act="drop-reg" data-r="${r.id}">No show</button>
      </span>
    </div>
    ${r.kind === 'pair' || seeking ? `<div class="drow" style="--cols:${SHOW_STRENGTH ? '1fr 76px 150px auto' : '1fr auto'}">
      <input id="rp-${r.id}" value="${esc(d.partner_name)}" data-f="rp-${r.id}"
             placeholder="${seeking ? 'partner — blank enters them alone' : 'partner'}">
      ${SHOW_STRENGTH ? `<input id="rps-${r.id}" value="${esc(d.partner_strength)}" data-f="rps-${r.id}" inputmode="decimal">
      ${mate ? seen(pKnown, mate.strength) : seen(pKnown, r.partner_strength)}` : ''}
      <span class="acts">${mate
        ? `<button class="ghost tiny" data-act="drop-reg" data-r="${mate.id}"
             title="${esc(mate.name)} did not turn up — ${esc(r.name)} goes back to looking">No show</button>`
        : ''}</span>
    </div>` : ''}
    <div class="dupnote" id="dup-${r.id}" ${dup ? '' : 'hidden'}>${esc(dup)}</div>
    ${r.note ? `<div class="drow" style="--cols:1fr"><span class="sub"
      >“${esc(r.note)}”</span></div>` : ''}
  </div>`;
}

/* Typing into a row's name boxes re-checks that row in place. Re-rendering
   the sheet under a half-typed name would take the cursor with it. */
function refreshDup(f) {
  const m = /^r[np]-(.+)$/.exec(f);
  if (m) {
    const r = regById(m[1]);
    if (!r) return;
    const dup = regDup(r);
    const box = document.getElementById('dup-' + r.id);
    const ok = document.getElementById('ok-' + r.id);
    if (box) { box.textContent = dup; box.hidden = !dup; }
    if (ok) ok.disabled = !!dup;
    return;
  }
  if (/^(w_|t_)/.test(f)) {
    const dup = walkDup();
    document.querySelectorAll('[data-dupfor="walk"]').forEach(b => { b.textContent = dup; b.hidden = !dup; });
    document.querySelectorAll('[data-okfor="walk"]').forEach(b => { b.disabled = !!dup; });
  }
}

function doorMatch(q, ...names) {
  return !q || names.some(n => nameKey(n).includes(q));
}

/* The door itself is the desk (Door, in the bar). Setup keeps the count,
   the way in, and the roster as one long editable list — the old Door tab,
   folded away, because everything in it still works and some of it (merge
   cups, remove all) lives nowhere else. */
function tabDoor() {
  const regs = S.registrations || [];
  const pending = regs.filter(r => r.status === 'pending').length;
  const here = S.entrants.filter(e => e.status !== 'withdrawn').length;
  const playing = S.entrants.filter(e => e.status === 'playing').length;
  const door = location.origin + '/d/' + (S.keys.door || '');
  return `<div class="doorbox">
      <div class="dcount">${[[pending, 'Still expected'], [here, 'Here'], [playing, 'Playing']].map(([n, l]) =>
        `<div><b>${n}</b><span class="micro">${l}</span></div>`).join('')}</div>
      <div class="dgo"><button class="primary" data-mode="door">Open the desk →</button>
        <span class="key">${esc(door)}</span></div>
    </div>
    ${why('The door link opens the desk and nothing else: check-in, walk-ins, no-shows, names and ' +
          'partners, sitting out and going home. It cannot score or change draws, cups, tables or ' +
          'the event, and the log shows what was done with it.')}
    <details class="fold-old" data-keep="door_old"${form.door_old ? ' open' : ''}>
      <summary>The roster as a list <span class="micro">every entry and everyone here, editable in place</span></summary>
      ${tabDoorList()}
    </details>`;
}

function tabDoorList() {
  const regs = S.registrations || [];
  const pending = regs.filter(r => r.status === 'pending');
  const walkOpen = !!form.walk_open || !S.entrants.length && !pending.length;
  const q = nameKey(form.door_q);
  return `<div class="form">
    ${sec('At the door', `<a class="desk-link" href="${location.pathname.replace(/\/$/, '')}/desk${simq('?')}"
        target="_blank"><button class="ghost tiny">Open the desk ↗</button></a>
      <button class="${walkOpen ? 'ghost' : ''} tiny" data-act="walk-toggle">${
      walkOpen ? 'Hide' : 'Add somebody'}</button>`)}
    ${walkOpen ? walkInForm() : ''}
    ${S.entrants.length || pending.length ? `<div class="field door-search">
      <label for="door-q">Search</label>
      <input id="door-q" type="search" value="${esc(form.door_q || '')}" data-f="door_q" data-was=""
             placeholder="Name, partner or team" autocomplete="off"></div>` : ''}
    <div id="door-lists">${doorLists()}</div>
  </div>`;
}

function doorLists() {
  const regs = S.registrations || [];
  const pending = regs.filter(r => r.status === 'pending');
  const q = nameKey(form.door_q);
  const cups = S.cups.length ? S.cups : [{ id: '', name: 'This event' }];
  const known = new Set(cups.map(c => c.id));
  // somebody whose cup was removed under them still has to be findable
  const stray = S.entrants.filter(e => !known.has(e.cup_id || ''));
  if (!S.entrants.length && !pending.length)
    return `<p class="blank">Nobody yet${regs.length ? '' : ` — entries arrive from ${location.origin}/join`}.</p>`;
  const out = cups.map(c => cupPeople(c, pending, S.entrants.filter(e => (e.cup_id || '') === c.id), q))
    .concat(stray.length ? [cupPeople({ id: '__none', name: 'Not in a cup' }, [], stray, q)] : [])
    .filter(Boolean);
  return out.join('') || `<p class="blank">Nobody matches “${esc(form.door_q)}”.</p>`;
}

/* Everything about who is in one cup, in one place, in the order it happens:
   entries waiting to be confirmed, then the pool they join. The pool is the
   cup's only list — its draw is fed from it — so what this shows is also
   what the draw will play, with nothing to put anywhere by hand. */
const STATUS = {
  playing: ['playing', 'hot', 'On a table now'],
  waiting: ['waiting', 'state', 'In line for a table'],
  resting: ['resting', 'dim', 'Sat out — nobody will pair them until they are back'],
  entered: ['in the draw', 'state', 'In the draw, which has not started'],
  drawn: ['in the draw', 'state', 'In the draw, between matches'],
  outside: ['no draw', 'warn', 'In this cup, but there is no draw taking them: none set up yet, or it started without them'],
  withdrawn: ['withdrawn', 'dim', 'Gone for the night — every fixture they owed was given to their opponent'],
};

function cupPeople(c, pending, allEnts, q) {
  const allRows = pending.filter(r => r.cup_id === c.id);
  const rows = allRows.filter(r => doorMatch(q, r.name, r.partner_name, r.team_name,
    (mateOf(r) || {}).name));
  const ents = allEnts.filter(e => doorMatch(q, e.name, ...e.player_ids.map(playerName)));
  if (q && !rows.length && !ents.length) return '';
  const count = k => allEnts.filter(e => e.status === k).length;
  const bits = [
    allEnts.length ? allEnts.length + (allEnts.length === 1 ? ' person' : ' people') : '',
    count('playing') ? count('playing') + ' playing' : '',
    count('waiting') ? count('waiting') + ' waiting' : '',
    count('resting') ? count('resting') + ' resting' : '',
  ].filter(Boolean).join(' · ');
  // a matched team is one row and one confirm, so it counts once
  const teams = rows.filter(r => { const m = mateOf(r); return !(m && rows.includes(m) && m.id < r.id); });
  const into = mergeTargets(c);
  const merging = !!form['mg_' + c.id];
  const mergeBtn = !into.length ? '' : into.length === 1
    ? `<button class="ghost tiny" data-act="merge-cup" data-c="${c.id}" data-i="${into[0].id}">Merge into ${esc(into[0].name)}</button>`
    : `<button class="ghost tiny" data-act="merge-open" data-c="${c.id}">${merging ? 'Cancel' : 'Merge into…'}</button>`;
  return `${sec(c.name + (bits ? ' · ' + bits : ''), mergeBtn)}
    ${merging && into.length > 1 ? `<div class="inline">${into.map(t =>
      `<button class="tiny" data-act="merge-cup" data-c="${c.id}" data-i="${t.id}">${esc(t.name)}</button>`).join('')}</div>` : ''}
    ${c.id === '__none' ? '' : `<div class="subsec"><h3>Pre-registered${allRows.length
        ? ` <span class="count">${allRows.length}</span>` : ''}</h3>${teams.length > 1
        ? `<button class="ghost tiny" data-act="admit-all" data-c="${c.id}">Confirm all ${teams.length}</button>` : ''}</div>
      ${teams.length ? `<div class="rows">${teams.map(regRow).join('')}</div>`
        : `<p class="blank">${allRows.length ? 'None match.' : 'Nobody pre-registered for this cup.'}</p>`}
      <div class="subsec"><h3>In the pool${allEnts.length
        ? ` <span class="count">${allEnts.length}</span>` : ''}</h3>${allEnts.length > 1
        ? `<button class="ghost tiny" data-act="rm-all" data-c="${c.id}">Remove all ${allEnts.length}</button>` : ''}</div>`}
    ${ents.length ? `<div class="rows">${ents.map(e => personRow(e)).join('')}</div>`
      : `<p class="blank">${allEnts.length ? 'None match.' : 'Nobody in this cup yet.'}</p>`}`;
}

/* Where this cup could be folded at the last minute: another cup taking the
   same kind of entry, and only while this one has not started — once it has
   matches there is nothing honest to carry over. The server checks the same
   (App.op_merge_cups), plus that the other cup's draw can still take them. */
function mergeTargets(c) {
  if (!c.id || c.id === '__none' || S.cups.length < 2) return [];
  if (fmtsOfCup(c.id).some(f => f.status !== 'setup')) return [];
  return S.cups.filter(o => o.id !== c.id && (o.entry || 'single') === (c.entry || 'single'));
}

/* Everyone here is editable, including both halves of a pair.

   A pair used to be a name and a number you could only read, which is the
   wrong way round: a doubles cup is *all* pairs, so on a doubles night
   nothing about anybody could be corrected at all. And correcting a name in
   place is also how a substitute gets in when somebody's partner drops out,
   which is the one thing you actually want to be fast. */
function memberRows(e) {
  const players = e.player_ids.map(id => S.players.find(p => p.id === id)).filter(Boolean);
  if (players.length < 2) return '';
  const cols = SHOW_STRENGTH ? '1fr 60px auto' : '1fr auto';
  return players.map(p => `<div class="drow member" style="--cols:${cols}">
      ${auto('pn-' + p.id, 'update_player:' + p.id, 'name', p.name,
             'aria-label="Player name"')}
      ${SHOW_STRENGTH ? auto('ps-' + p.id, 'update_player:' + p.id, 'strength',
             p.strength, 'inputmode="decimal" aria-label="Strength"') : ''}
      <span></span>
    </div>`).join('');
}

function personRow(e) {
  const solo = e.player_ids.length === 1
    ? S.players.find(p => p.id === e.player_ids[0]) : null;
  const [label, cls, tip] = STATUS[e.status] || [e.status, '', ''];
  const many = S.cups.length > 1;
  const out = e.status === 'withdrawn';
  const cols = (SHOW_STRENGTH ? '1fr 60px ' : '1fr ') + (many ? '112px 130px auto' : '112px auto');
  return `<div class="entry"><div class="drow" style="--cols:${cols}"${
      e.resting || out ? ' data-dim="1"' : ''}>
    ${solo ? auto('pn-' + solo.id, 'update_player:' + solo.id, 'name', solo.name)
           : auto('en-' + e.id, 'update_entrant:' + e.id, 'name', e.name,
                  'aria-label="Team name"')}
    ${!SHOW_STRENGTH ? '' : solo
        ? auto('ps-' + solo.id, 'update_player:' + solo.id, 'strength', solo.strength,
               'inputmode="decimal"')
        : `<span class="num" title="The average of the two">${e.strength}</span>`}
    <span class="stat"><span class="chip ${cls}" title="${esc(tip)}">${esc(label)}</span>${
      tgLinked(e).length ? '<span class="tgmark" title="Gets table calls on Telegram">✈︎</span>' : ''}</span>
    ${many ? pick('ec-' + e.id, 'update_entrant:' + e.id, 'cup_id', e.cup_id || '',
        S.cups.map(c => [c.id, c.name]), 'title="Move to another cup"') : ''}
    <span class="acts">${tgButton(e)}${out
      ? `<button class="tiny" data-act="rejoin" data-e="${e.id}">Bring back</button>`
      : `${e.resting
          ? `<button class="tiny" data-act="unrest" data-e="${e.id}">Back in</button>`
          : `<button class="ghost tiny" data-act="rest" data-e="${e.id}">Sit out</button>`}
         ${e.removable
           ? `<button class="ghost tiny" data-act="rm-entrant" data-e="${e.id}"
                title="Take them out of the pool — nothing depends on them yet">Remove</button>`
           : `<button class="ghost tiny" data-act="withdraw" data-e="${e.id}"
                title="They have gone home. Everything they still owe is given to their opponent and any table they are on is freed">Gone home</button>`}`}</span>
  </div>${out ? '' : memberRows(e)}</div>`;
}

/* ---- walk-ins */

const walkCup = () => form.w_cup ?? (S.cups[0] ? S.cups[0].id : '');
const walkIsPair = () => (cupById(walkCup()) || {}).entry === 'pair';

/* The one check both walk-in forms share. Looking for a partner is a
   registration, not an entry, so it has nothing to collide with. */
function walkDup() {
  if (walkIsPair()) {
    return form.t_seek ? '' : dupMsg(walkCup(), 'pair', form.w_name, form.w_pname);
  }
  return dupMsg(walkCup(), 'single', form.w_name);
}

function walkInForm() {
  const wcup = walkCup();
  const dup = walkDup();
  const pair = walkIsPair();
  return `<div class="inline" style="align-items:flex-end">
      ${S.cups.length > 1 ? `<div class="field" style="max-width:160px"><label for="w-cup">Cup</label>
        <select id="w-cup" data-f="w_cup">${S.cups.map(c =>
          `<option value="${c.id}" ${wcup === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>` : ''}
      ${pair ? `<button class="primary" data-act="team-open">Enter a team…</button>` : `
      <div class="field"><label for="w-name">Name</label>
        <input id="w-name" value="${esc(form.w_name || '')}" data-f="w_name"
               list="known-people" placeholder="Jana Berger"></div>
      ${SHOW_STRENGTH ? `<div class="field" style="max-width:76px"><label for="w-str">Strength</label>
        <input id="w-str" value="${esc(form.w_str ?? (knownFor(form.w_name) || {}).strength ?? 5)}"
               data-f="w_str" inputmode="decimal"></div>` : ''}
      <button class="primary" data-act="walk-in" data-okfor="walk" ${dup ? 'disabled' : ''}>Add</button>`}
    </div>
    <datalist id="known-people">${(S.people || []).map(p =>
      `<option value="${esc(p.name)}">`).join('')}</datalist>
    ${pair ? '' : `<div class="dupnote" data-dupfor="walk" ${dup ? '' : 'hidden'}>${esc(dup)}</div>
    ${SHOW_STRENGTH && knownFor(form.w_name) ? `<p class="sub">${esc(form.w_name)} is in the directory — last
      played at ${knownFor(form.w_name).strength}.</p>` : ''}`}`;
}

/* Choosing a doubles cup opens this. It is a layer of its own rather than
   part of the sheet: the sheet re-renders whenever anything changes on
   another table, and that must not eat a half-typed team. */
function renderTeamModal() {
  const el = $('team-modal');
  if (!form.team_open) { el.hidden = true; el.innerHTML = ''; return; }
  const cup = cupById(walkCup()) || {};
  const seek = !!form.t_seek;
  const dup = walkDup();
  const strOf = (key, nameKey_) => form[key] ?? (knownFor(form[nameKey_]) || {}).strength ?? 5;
  el.hidden = false;
  el.innerHTML = `<div class="sheet-inner narrow">
    <div class="sheet-head">
      <h2 style="margin:0;font-size:15px">Doubles · ${esc(cup.name || '')}</h2>
      <button class="ghost" data-act="team-close">Close</button>
    </div>
    <div class="sheet-body"><div class="form">
      <div class="inline">
        <button class="${seek ? 'ghost' : 'primary'} tiny" data-act="team-seek" data-v="">Team of two</button>
        <button class="${seek ? 'primary' : 'ghost'} tiny" data-act="team-seek" data-v="1">Looking for a partner</button>
      </div>
      ${seek ? '' : `<div class="field"><label for="tm-team">Team name</label>
        <input id="tm-team" value="${esc(form.t_team || '')}" data-f="t_team"
               placeholder="optional — otherwise both names"></div>`}
      <div class="inline">
        <div class="field"><label for="tm-name">${seek ? 'Name' : 'Player 1'}</label>
          <input id="tm-name" value="${esc(form.w_name || '')}" data-f="w_name" list="known-people"></div>
        ${SHOW_STRENGTH ? `<div class="field" style="max-width:76px"><label for="tm-str">Strength</label>
          <input id="tm-str" value="${esc(strOf('w_str', 'w_name'))}" data-f="w_str" inputmode="decimal"></div>` : ''}
      </div>
      ${seek ? `<p class="sub">They go on the pre-registered list as looking for a partner. The
        next person who comes in alone is matched with them, and the door can tell each of
        them who they are playing with.</p>` : `<div class="inline">
        <div class="field"><label for="tm-pname">Partner:in</label>
          <input id="tm-pname" value="${esc(form.w_pname || '')}" data-f="w_pname" list="known-people"></div>
        ${SHOW_STRENGTH ? `<div class="field" style="max-width:76px"><label for="tm-pstr">Strength</label>
          <input id="tm-pstr" value="${esc(strOf('w_pstr', 'w_pname'))}" data-f="w_pstr" inputmode="decimal"></div>` : ''}
      </div>`}
      <div class="dupnote" data-dupfor="walk" ${dup ? '' : 'hidden'}>${esc(dup)}</div>
      <div class="inline" style="justify-content:flex-end">
        <button class="ghost" data-act="team-close">Cancel</button>
        <button class="primary" data-act="team-add" data-okfor="walk" ${dup ? 'disabled' : ''}>${
          seek ? 'Put down as looking' : 'Add team'}</button>
      </div>
    </div></div>
  </div>`;
  const first = $(seek || !form.w_name ? 'tm-name' : 'tm-pname');
  if (first && !el.dataset.shown) first.focus();
  el.dataset.shown = '1';
}

/* ------------------------------------------------------------- Links tab */

function tabLinks() {
  const base = location.origin;
  return `<div class="form">
    ${sec('Who gets which link')}
    <div class="rows">
      <div class="hrow" style="--cols:170px 1fr"><span>Role</span><span>URL</span></div>
      <div class="drow" style="--cols:170px 1fr"><span>Everyone, read only</span>
        <span class="key">${base}/</span></div>
      <div class="drow" style="--cols:170px 1fr"><span>Referees — can score</span>
        <span class="key">${base}/r/${esc(S.keys.referee || '')}</span></div>
      <div class="drow" style="--cols:170px 1fr"><span>Door — the registration desk</span>
        <span class="key">${base}/d/${esc(S.keys.door || '')}</span></div>
      <div class="drow" style="--cols:170px 1fr"><span>The desk, as admin</span>
        <span class="key">${base}/a/${esc(S.keys.admin || '')}/desk</span></div>
      <div class="drow" style="--cols:170px 1fr"><span>Admin — this page</span>
        <span class="key">${base}/a/${esc(S.keys.admin || '')}</span></div>
      <div class="drow" style="--cols:170px 1fr"><span>Wall display</span>
        <span class="key">${base}/board</span></div>
    </div>
    ${why('No accounts, no logins. Keep the referee link to the people running tables — ' +
          'anyone who has it can enter results. The door link is for whoever lets people in: ' +
          'check-in, walk-ins and the roster, but no scores, draws or setup, and the log ' +
          'shows what was done with it.',
          'The wall display needs no key and has no controls, so it is safe on a screen ' +
          'anyone can reach. It answers “when am I playing” by itself: who is on ' +
          'which table now, then the running order with a rough time against each one.')}

    ${tgSection()}

    ${sec('Print and show')}
    <div class="inline">
      <a href="/print?mode=event&base=${encodeURIComponent(base + '/')}" target="_blank"
        ><button>Poster for this event</button></a>
      <a href="/print?base=${encodeURIComponent(base + '/')}" target="_blank"
        ><button>Poster for the live link</button></a>
      <a href="/board" target="_blank"><button>Open the wall display</button></a>
    </div>
    ${why('The event poster carries the name, the date, the venue and a QR code — that is ' +
          'the one for the noticeboard beforehand. The live-link poster is the plain one for ' +
          'the wall on the night. Both point at the same permanent URL, which serves the ' +
          'landing page before the event and the console once it starts.',
          'Pasting that URL into a chat shows the event name, date and blurb as a card, so ' +
          'the link does the advertising on its own.')}
  </div>`;
}

/* ------------------------------------------------------------- Telegram

   An optional layer. None of this shows until a bot is connected, and
   nothing else in the console depends on it. Players get two messages per
   match, enter with one tap and can write back; see docs/telegram.md. */

const tgOn = () => !!(S && S.telegram && S.telegram.on);
const tgChip = title => `<span class="chip tg" title="${esc(title)}">Telegram</span>`;

/* The people an entrant is made of, as the directory knows them. */
function peopleOf(e) {
  return e.player_ids.map(id => {
    const p = S.players.find(x => x.id === id);
    return p && (S.people || []).find(n => n.id === p.person_id);
  }).filter(Boolean);
}
const tgLinked = e => peopleOf(e).filter(p => p.tg_id);

/* One button per row, whichever is the useful one: link somebody who is
   not on Telegram yet, or write to somebody who is. */
function tgButton(e) {
  if (!tgOn() || e.status === 'withdrawn') return '';
  const ppl = peopleOf(e);
  const todo = ppl.find(p => !p.tg_id);
  const night = S.phase === 'doors' || S.phase === 'live';
  if (todo && night) return `<button class="ghost tiny" data-act="tg-link" data-n="${todo.id}"
    title="Show ${esc(todo.name)} a code to scan — their table calls come to their phone">Link</button>`;
  if (ppl.some(p => p.tg_id)) return `<button class="ghost tiny" data-act="tg-msg" data-e="${e.id}"
    title="Write to ${esc(e.name)} on Telegram">Message</button>`;
  return '';
}

function tgSection() {
  const t = S.telegram || {};
  if (!t.on) return `${sec('Telegram')}
    <p class="sub">Players get two messages per match on their phone — up next, and your
      table — enter with one tap, and can write to you. Optional: without it nothing changes.</p>
    <div class="inline" style="align-items:flex-end">
      <div class="field"><label for="tg-token">Bot token</label>
        <input id="tg-token" value="${esc(form.tg_token || '')}" data-f="tg_token"
               placeholder="123456789:AAE…" autocomplete="off" spellcheck="false"></div>
      <button class="primary" data-act="tg-connect" ${form.tg_busy ? 'disabled' : ''}>${
        form.tg_busy ? 'Connecting…' : 'Connect'}</button>
    </div>
    ${why('In Telegram, open @BotFather, send /newbot and give it a name. It answers with a ' +
          'token — a long line with a colon in it. Paste that here. That is all the setup there is: ' +
          'the server talks to Telegram itself, so there is nothing to change on the server or in DNS.',
          'The token is kept in telegram.json beside your keys and never shown again, not even here.')}`;
  const health = t.ok === false
    ? `<span class="chip warn">${esc(t.error || 'Telegram is not reachable')}</span>`
    : `<span class="chip state">working</span>`;
  return `${sec('Telegram', `<button class="ghost tiny" data-act="tg-disconnect">Disconnect</button>`)}
    <div class="rows">
      <div class="drow" style="--cols:170px 1fr"><span>Bot</span>
        <span><b>@${esc(t.username)}</b> ${health}${t.ms != null
          ? ` <span class="sub" style="display:inline" title="How long a typical call to Telegram takes from this server. Under 300 ms feels instant; over a second, the network between the two is the problem.">· ${t.ms} ms per call</span>` : ''}</span></div>
      <div class="drow" style="--cols:170px 1fr"><span>Following</span>
        <span>${t.followers}${t.queued ? ` <span class="sub" style="display:inline">· ${t.queued} waiting to go out</span>` : ''}</span></div>
      <div class="drow" style="--cols:170px 1fr"><span>Link for posters and chats</span>
        <span class="key">${esc(t.link)}</span></div>
    </div>
    <label class="pick"><input type="checkbox" id="tg-scores" data-tgscores="1"
      ${S.event.player_scores ? 'checked' : ''}> Players enter their own scores — the other side confirms</label>
    ${why('Anyone who opens the link starts following: they hear about new events and can ' +
          'enter with one tap. Somebody is only linked to a player — and gets their table calls — ' +
          'when the door has seen them: by confirming an entry they made in Telegram, or by them ' +
          'scanning the code on their row at the door. A name alone is never enough.',
          'With players entering scores, the table call tells them to type the result into the ' +
          'chat. The other side is asked to confirm, and only then is it written. Two different ' +
          'answers write nothing and show up in Chat as a table that needs a referee.')}`;
}

function tabChat() {
  const t = S.telegram || {};
  const auds = t.audiences || [];
  const live = S.phase === 'doors' || S.phase === 'live';
  const aud = form.tg_aud || (live ? 'tonight' : 'followers');
  const canAnnounce = !live && S.cups.some(c => c.registration === 'open');
  const n = (auds.find(a => a.id === aud) || {}).n || 0;
  const threads = t.threads || [];
  return `<div class="form">
    ${sec('Send')}
    <div class="inline" style="align-items:flex-end">
      <div class="field" style="max-width:300px"><label for="tg-aud">To</label>
        <select id="tg-aud" data-f="tg_aud">${auds.map(a =>
          `<option value="${a.id}" ${a.id === aud ? 'selected' : ''}>${esc(a.label)} · ${a.n}</option>`).join('')}</select></div>
    </div>
    <div class="field"><label for="tg-text">Message</label>
      <textarea id="tg-text" rows="3" data-f="tg_text"
        placeholder="${live ? 'Table 3 is out of balls — back in five.' : 'Friday is on — doors at seven.'}">${esc(form.tg_text || '')}</textarea></div>
    <div class="inline">
      <button class="primary" data-act="tg-send" ${n ? '' : 'disabled'}>Send to ${n}</button>
      ${canAnnounce ? `<button data-act="tg-announce" title="Each follower gets the event with its own entry buttons">Announce the event</button>` : ''}
    </div>
    ${why('Following is everyone who opened the bot and did not switch the news off. ' +
          'Tonight’s players and a cup reach whoever is playing and linked, news or not — ' +
          'that is the evening talking, not a newsletter.',
          canAnnounce ? 'Announce sends the event itself — name, date, place and an entry button ' +
            'per open cup — with your message on top, so entering is one tap from the announcement.' : '')}

    ${sec('Messages')}
    ${threads.length ? threads.map(threadCard).join('')
      : `<p class="blank">Nothing yet. Whatever players write to @${esc(t.username)} lands here.</p>`}
  </div>`;
}

// 9:05, not 09:05 — as the phone page writes it
const hhmm = ts => { const d = new Date(ts * 1000); return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0'); };

function threadCard(th) {
  const key = th.chat_id == null ? 'sys' : th.chat_id;
  const all = !!form['th_' + key];
  const msgs = all ? th.messages : th.messages.slice(-4);
  return `<div class="card thread${th.unread ? ' unread' : ''}"><div class="card-body">
    <div class="thead"><b>${esc(th.name)}</b>${th.handle && th.handle !== th.name
      ? ` <span class="sub">${esc(th.handle)}</span>` : ''}${th.unread
      ? ` <span class="count">${th.unread}</span>` : ''}<span class="sub when">${ago(th.last)}</span></div>
    ${th.messages.length > 4 ? `<button class="ghost tiny" data-act="th-more" data-c="${key}">${
      all ? 'Only the latest' : `Earlier (${th.messages.length - 4})`}</button>` : ''}
    <div class="msgs">${msgs.map(m => `<div class="msg ${m.dir}"><span>${esc(m.text)}</span>
      <i>${hhmm(m.ts)}</i></div>`).join('')}</div>
    ${th.system ? '' : !th.reachable ? `<p class="sub">Not reachable — they blocked the bot.</p>`
      : `<div class="inline reply">
      <div class="field"><input id="rep-${key}" data-f="rep_${key}" value="${esc(form['rep_' + key] || '')}"
        placeholder="Reply to ${esc(th.name)}" aria-label="Reply to ${esc(th.name)}" enterkeyhint="send"></div>
      <button data-act="tg-reply" data-c="${key}">Send</button></div>`}
  </div></div>`;
}

/* The two small layers the door opens: a code to scan, or a message. */
function renderTgModal() {
  const el = $('tg-modal');
  const m = form.tgm;
  if (!m) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  const body = m.kind === 'link' ? `
      <div class="qr"><img src="/api/qr.svg?u=${encodeURIComponent(m.url)}" alt="QR code"
        onerror="this.parentNode.hidden=true"></div>
      <p class="sub">${esc(m.name)} scans this with their phone camera, Telegram opens, they tap
        Start — from then on their table calls come to their phone. Works once, tonight.</p>
      <div class="key">${esc(m.url)}</div>
      <div class="inline" style="justify-content:flex-end">
        <button class="primary" data-act="tgm-close">Done</button></div>` : `
      <div class="field"><label for="tgm-text">Message</label>
        <textarea id="tgm-text" rows="3" data-f="tgm_text">${esc(form.tgm_text || '')}</textarea></div>
      <div class="inline" style="justify-content:flex-end">
        <button class="ghost" data-act="tgm-close">Cancel</button>
        <button class="primary" data-act="tgm-send">Send</button></div>`;
  el.innerHTML = `<div class="sheet-inner narrow">
    <div class="sheet-head">
      <h2 style="margin:0;font-size:15px">${m.kind === 'link' ? 'Link ' + esc(m.name) + ' to Telegram'
        : 'Write to ' + esc(m.name)}</h2>
      <button class="ghost" data-act="tgm-close">Close</button>
    </div>
    <div class="sheet-body"><div class="form">${body}</div></div></div>`;
  const t = $('tgm-text');
  if (t) t.focus();
}

/* ------------------------------------------------------ Telegram, for players

   On the live page, once per phone and event: find your name, tap it, and
   Telegram opens on the bot, which links you and calls you to your table.
   Taken on trust — a score still needs both sides — but a name already
   linked to another phone stays with it (tt/bot.py, on_claim_self). German,
   like the bot it leads to. */

const NUDGE_NEVER = 'tt_tg_nudge_never';
const nudgeKey = () => 'tt_tg_nudge_' + ((S && S.event && S.event.id) || '');
let nudgeOpen = false, nudgeQ = '', nudgeTimer = null;

const nudgeWanted = () => !!(S && S.role === 'public' && !PAST && !SIM
  && S.telegram && S.telegram.on && S.telegram.username
  && (S.phase === 'doors' || S.phase === 'live') && (S.players || []).length);

function nudgeSeen() {
  try { return !!(localStorage.getItem(nudgeKey()) || localStorage.getItem(NUDGE_NEVER)); }
  catch (e) { return false; }
}
function nudgeClose(how) {
  try {
    if (how === 'never') localStorage.setItem(NUDGE_NEVER, '1');
    else if (how) localStorage.setItem(nudgeKey(), '1');
  } catch (e) { }
  nudgeOpen = false;
  drawNudge();
}

function renderNudge() {
  const want = nudgeWanted();
  $('tg-btn').hidden = !want;
  // a moment after the page settles, not in the face of whoever just opened it
  if (want && !nudgeSeen() && !nudgeOpen && !nudgeTimer) {
    nudgeTimer = setTimeout(() => { if (nudgeWanted() && !nudgeSeen()) { nudgeOpen = true; drawNudge(); } }, 4000);
  }
  if (nudgeOpen) drawNudgeList();
}

function drawNudge() {
  const el = $('tg-nudge');
  if (!nudgeOpen || !nudgeWanted()) { el.hidden = true; el.innerHTML = ''; return; }
  if (!el.hidden && el.innerHTML) return drawNudgeList();
  el.hidden = false;
  el.innerHTML = `<div class="nudge-card" role="dialog" aria-label="Benachrichtigung">
    <button class="nudge-x" data-nudge="later" aria-label="Schließen">×</button>
    <h2>Wann bist du dran?</h2>
    <p>Wir schreiben dir auf Telegram — wenn du gleich dran bist, und wenn dein Tisch frei ist.</p>
    <input id="nudge-q" value="${esc(nudgeQ)}" placeholder="Dein Name" autocomplete="off"
           autocapitalize="words" aria-label="Dein Name">
    <div id="nudge-list" class="nudge-list"></div>
    <div class="nudge-foot">
      <button class="ghost tiny" data-nudge="later">Später</button>
      <button class="ghost tiny" data-nudge="never">Nicht mehr fragen</button>
    </div></div>`;
  drawNudgeList();
}

function drawNudgeList() {
  const box = $('nudge-list');
  if (!box) return;
  const q = nameKey(nudgeQ);
  const all = (S.players || []).filter(p => p.active !== false)
    .sort((a, b) => a.name.localeCompare(b.name));
  // a short field is quicker to tap than to type; a long one would bury the page
  const hits = q ? all.filter(p => nameKey(p.name).includes(q)) : all.length <= 6 ? all : [];
  const link = p => `https://t.me/${encodeURIComponent(S.telegram.username)}?start=c_${
    encodeURIComponent((S.event.id || '') + '_' + p.id)}`;
  box.innerHTML = hits.slice(0, 8).map(p => `<a class="nudge-name" href="${link(p)}"
      target="_blank" rel="noopener" data-nudge="picked"><span>${esc(p.name)}</span><b>→</b></a>`).join('')
    || `<p class="sub">${q ? 'Niemand mit diesem Namen heute.' : 'Tipp die ersten Buchstaben deines Namens.'}</p>`;
}

/* -------------------------------------------------------------- More tab

   The things you reach for once a month: who the club knows, the undo of
   last resort, and a rehearsal of the night that costs nothing. */

/* Who played at earlier events. The log keeps every event, but live state
   only knows tonight, so this asks the server to replay it — read-only, and
   only when asked, because it walks the whole log. */
function pastEventsBlock() {
  const pe = form.past_events;
  if (!pe) return `<p class="sub">Every earlier event is still in the log. Load the
    list to see who played at each.</p>
    <button class="ghost" data-act="past-load">${form.past_busy ? 'Loading…' : 'Load past events'}</button>`;
  const rows = pe.filter(e => !e.current);
  if (!rows.length) return '<p class="sub">No earlier events yet.</p>';
  return `<div class="rows">${rows.map(e => {
    const open = form['pe_' + e.first_seq];
    return `<div class="drow" style="--cols:1fr auto">
      <span style="min-width:0"><b>${esc(e.name || e.id || 'Event')}</b>
        <span style="color:var(--muted)">${esc((e.starts_at || '').replace('T', ' '))}
          · ${e.played.length} played</span></span>
      <span class="acts"><button class="ghost tiny" data-act="past-toggle"
        data-i="${e.first_seq}">${open ? 'Hide' : 'Players'}</button>
        <button class="ghost tiny" data-act="past-open"
        data-i="${e.first_seq}">Open</button></span>
    </div>${open ? `<div style="padding:4px 12px 10px;font-size:13px">${
      e.played.map(p => `${esc(p.name)} <span style="color:var(--muted)">${
        p.won}/${p.played}</span>`).join(' · ') || 'Nobody played.'}</div>` : ''}`;
  }).join('')}</div>`;
}

function tabMore() {
  return `<div class="form">
    ${sec('Club directory')}
    <div class="inline">
      <div class="field" style="max-width:280px"><label for="dir-q">Search</label>
        <input id="dir-q" value="${esc(form.dir_q || '')}" data-f="dir_q"
               placeholder="Name"></div>
    </div>
    ${directoryRows()}
    ${why(SHOW_STRENGTH
      ? 'Everyone the club has seen, and the strength you last settled on for them. This ' +
        'outlives the event — a new event clears tonight’s roster, never this. Adding ' +
        'a regular from here starts them at the number you tuned last time instead of a guess.'
      : 'Everyone the club has seen. This outlives the event — a new event clears ' +
        'tonight’s roster, never this.')}

    ${sec('Past events')}
    ${pastEventsBlock()}

    ${sec('Log')}
    <p class="sub">Every change is an event. Rewinding drops everything after that point and
      rebuilds the evening from scratch.</p>
    <div class="rows">
      <div class="hrow" style="--cols:44px 1fr auto"><span>#</span><span>What</span><span></span></div>
      ${S.history.map(h => `<div class="drow" style="--cols:44px 1fr auto">
        <span class="num">${h.seq}</span>
        <span style="font-size:13px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
          >${h.by && h.by !== 'system' ? `<b>${esc(h.by)}</b> · ` : ''}${esc(h.type)} <span style="color:var(--muted)">${esc(JSON.stringify(h.payload).slice(0, 70))}</span></span>
        <span class="acts"><button class="ghost tiny" data-act="rewind" data-s="${h.seq}">Rewind here</button></span>
      </div>`).join('')}
    </div>
    ${why('To start the next evening clean, Event → next event does it properly: one ' +
          'pass that clears the old one and sets up the next, instead of a wipe you then ' +
          'have to rebuild from.')}

    ${simBlock()}
  </div>`;
}

/* ------------------------------------------------------------------ sim

   Everything the console does interestingly, it does an hour in: standings
   that mean something, a bracket half full, three matches running and a
   queue behind them. Getting there by hand is forty results, so this builds
   the same evening somewhere else and plays it for you. */

const simUrl = () => location.pathname + '?sim=1';

function simBlock() {
  const sim = S.sim || {};
  if (sim.is_sim) return '';               // no sandboxes inside the sandbox
  const nothing = !S.cups.length && !S.formats.length;
  const built = sim.running
    ? `<p class="sub">Running — ${sim.entrants} entrants, ${sim.played} played,
       ${sim.live} on a table, built ${ago(sim.built_ts)}.</p>` : '';
  return `${sec('Sim')}
    <p class="sub">A copy of this event with a made-up field in it, played a few rounds
      in, in its own tab. It is a separate store on a separate file: nothing in there
      can reach tonight, and nothing tonight can see it.</p>
    ${nothing ? '<p class="blank">Set up a cup with a draw in it first — there is nothing to copy yet.</p>' : `
    <div class="inline">
      <div class="field" style="max-width:150px"><label for="sim-n">Entrants per cup</label>
        <input id="sim-n" value="${esc(form.sim_n ?? 18)}" data-f="sim_n" inputmode="numeric"></div>
      <div class="field" style="max-width:110px"><label for="sim-r">Rounds</label>
        <input id="sim-r" value="${esc(form.sim_r ?? 3)}" data-f="sim_r" inputmode="numeric"></div>
      <button data-act="sim-run" ${form.sim_busy ? 'disabled' : ''}>${
        form.sim_busy ? 'Building…' : sim.running ? 'Build a new one' : 'Run a sim'}</button>
      ${sim.running ? `<button class="ghost" data-act="sim-open">Open the tab</button>
        <button class="ghost" data-act="sim-board">Wall display</button>
        <button class="ghost" data-act="sim-stop">Stop it</button>` : ''}
    </div>
    ${built}`}
    ${why('A pair cup counts pairs, so 18 there is 36 people. Rounds is how far in to ' +
      'stop: three leaves a group stage part-played and a bracket at the semis, with ' +
      'matches still live on the tables, which is where the screens are worth looking at.',
      'It stops at the first restart either way — the sandbox lives in a temp file that ' +
      'is never written to the data directory.')}`;
}

/* Rough age of something, for the one place that needs it. */
function ago(ts) {
  const m = Math.max(0, Math.round((Date.now() / 1000 - (ts || 0)) / 60));
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago`
    : `${Math.round(m / 60)} h ago`;
}

/* Search first. Rendering sixty people, each with an editable box and three
   buttons, was the old default and nobody was reading it. */
function directoryRows() {
  const all = S.people || [];
  const q = (form.dir_q || '').trim().toLowerCase();
  if (!all.length) return `<p class="blank">Empty until you confirm somebody — everyone you
    add gets remembered.</p>`;
  if (!q) return `<p class="blank">${all.length} ${all.length === 1 ? 'person' : 'people'}
    on file. Type a name to find one.</p>`;
  const list = all.filter(p => p.name.toLowerCase().includes(q));
  if (!list.length) return '<p class="blank">Nobody by that name.</p>';
  return `<div class="rows">
    ${SHOW_STRENGTH ? '<div class="hrow" style="--cols:1fr 76px auto"><span>Name</span><span>Strength</span><span></span></div>' : ''}
    ${list.slice(0, 40).map(p => `<div class="drow" style="--cols:${SHOW_STRENGTH ? '1fr 76px auto' : '1fr auto'}">
      <span>${esc(p.name)}${p.playing
        ? ' <span style="color:var(--signal);font-size:12px">playing tonight</span>' : ''}</span>
      ${SHOW_STRENGTH ? auto('nn-' + p.id, 'update_person:' + p.id, 'strength', p.strength, 'inputmode="decimal"') : ''}
      <span class="acts">
        ${p.playing ? '' : `<button class="tiny" data-act="from-directory" data-n="${p.id}">Add to tonight</button>`}
        <button class="ghost tiny" data-act="rm-person" data-n="${p.id}">Forget</button>
      </span></div>`).join('')}
  </div>${list.length > 40 ? `<p class="sub">…and ${list.length - 40} more. Narrow the search.</p>` : ''}`;
}

/* --------------------------------------------------------------- events */

/* Typing a score moves on by itself: a digit that cannot begin a two-digit
   score in this game (anything but 1 when games go to 11, anything but 1 or
   2 when they go to 21) is the whole number, so the cursor goes on at once;
   otherwise it waits for the second digit. A to B, then the next game's A,
   then Save once the result is decided. Deleting never moves it. */
function scoreDone(v, pts, ev) {
  if (!ev || !/^insert/.test(ev.inputType || 'insert')) return false;
  if (v.length >= 2) return true;
  return v.length === 1 && +v * 10 > (pts || 11) + 8;
}
function hopTo(ids, save) {
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el) { el.focus(); try { el.select(); } catch (x) { } return; }
  }
  const b = save && document.querySelector(save);
  if (b && !b.disabled) b.focus();
}

document.addEventListener('input', e => {
  if (e.target.id === 'nudge-q') { nudgeQ = e.target.value; drawNudgeList(); return; }
  if (e.target.id === 'recent-q') { recentQuery = e.target.value; renderRecent(); return; }
  const mg = e.target.dataset.mg;
  if (mg) {
    const [i, side] = mg.split('|');
    const v = e.target.value.replace(/[^0-9]/g, '').slice(0, 2);
    e.target.value = v;
    while (manualGames.length <= +i) manualGames.push(['', '']);
    manualGames[+i][+side] = v;
    renderManual();
    if (scoreDone(v, +manualDraft.pts, e))
      return hopTo(+side === 0 ? [`mg-${i}-b`] : [`mg-${+i + 1}-a`], '[data-act="manual-result"]');
    const back = document.getElementById(e.target.id);
    if (back) { back.focus(); try { back.setSelectionRange(99, 99); } catch (x) { } }
    return;
  }
  const g = e.target.dataset.g;
  if (g) {
    const [mid, i, side] = g.split('|');
    const v = e.target.value.replace(/[^0-9]/g, '').slice(0, 2);
    e.target.value = v;
    drafts[mid] = drafts[mid] || [];
    while (drafts[mid].length <= +i) drafts[mid].push(['', '']);
    drafts[mid][+i][+side] = v;
    if (editing === mid) renderEditor(); else renderTables();
    const m = findMatch(mid);
    if (scoreDone(v, m && m.scoring && m.scoring.points_to, e))
      return hopTo(+side === 0 ? [`g-${mid}-${i}-b`] : [`g-${mid}-${+i + 1}-a`],
        `[data-act="report"][data-m="${mid}"]`);
    const back = document.getElementById(e.target.id);
    if (back) { back.focus(); try { back.setSelectionRange(99, 99); } catch (x) { } }
    return;
  }
  if (wizInput(e)) return;
  const f = e.target.dataset.f;
  if (f) {
    form[f] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    // typing a name the club already knows should bring their number with it —
    // written into the box directly, since re-rendering would drop the cursor
    if (f === 'w_name' || f === 'w_pname') {
      const k = knownFor(form[f]);
      const key = f === 'w_name' ? 'w_str' : 'w_pstr';
      if (k) {
        form[key] = k.strength;
        document.querySelectorAll(`[data-f="${key}"]`).forEach(i => { i.value = k.strength; });
      }
    }
    if (f === 'door_q') { const l = $('door-lists'); if (l) l.innerHTML = doorLists(); }
    else refreshDup(f);
  }
  const rq = e.target.dataset.rq;
  if (rq) drafts['rq-' + rq] = e.target.checked;
});

/* The wizard keeps its own draft rather than writing through to the server:
   nothing exists until you confirm on the review step. */
function wizInput(e) {
  if (!wiz) return false;
  const val = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  const w = e.target.dataset.w;
  if (w) { wiz[w] = val; return true; }
  const wc = e.target.dataset.wc;
  if (wc) {
    const [i, key] = wc.split('|');
    wiz.cups[+i][key] = val;
    if (key === 'kind') { seedFormat('w' + i + '_', val, null); renderSheet(); }
    return true;
  }
  const wt = e.target.dataset.wt;
  if (wt) {
    const [i, key] = wt.split('|');
    wiz.tables[+i][key] = key === 'cup' ? +val : val;
    return true;
  }
  return false;
}

/* ------------------------------------------------------------- autosave

   A field carries what the server currently holds in `data-was`, so blur
   can tell a real edit from a visit. That matters more than saving the
   round trip: every write is an entry in the log, and the log is the
   rewind timeline, so a no-op append is noise in the one place you go
   when something has gone wrong.

   `data-save` is the op, optionally with the row id after a colon —
   "update_player:P3" — and `data-key` the field it sets. */
function autoSave(el) {
  const spec = el.dataset.save;
  if (!spec || el.value === el.dataset.was) return false;
  const [op, id] = spec.split(':');
  const key = el.dataset.key;
  let val = el.value;

  // a number that is not one goes back to what it was rather than being
  // clamped into something you did not ask for
  if (key === 'strength') {
    const n = parseFloat(val);
    if (isNaN(n) || n < 1 || n > 10) {
      el.value = el.dataset.was;
      toast('Strength is a number from 1 to 10');
      return false;
    }
    val = n;
  }
  if (key === 'name' && !String(val).trim()) {
    el.value = el.dataset.was;
    return false;
  }

  const data = { [key]: val };
  if (op === 'event_meta') {                // whole-record op: send it all
    const ev = S.event || {};
    Object.assign(data, {
      name: ev.name || '', venue: ev.venue || '',
      blurb: ev.blurb || '', starts_at: ev.starts_at || '',
    }, { [key]: val });
  } else if (op === 'update_cup') {
    const c = S.cups.find(x => x.id === id) || {};
    Object.assign(data, {
      id, name: c.name, blurb: c.blurb || '',
      entry: c.entry || 'single', registration: c.registration || 'closed',
    }, { [key]: val });
  } else if (op === 'set_table') {
    const t = S.tables.find(x => x.number === +id) || {};
    Object.assign(data, { number: +id, name: t.name }, { [key]: val });
  } else if (id) {
    data.id = id;
  }

  el.dataset.was = el.value;               // so a re-render does not re-fire
  api(op, data);
  flashSaved(el);
  return true;
}

function flashSaved(el) {
  el.classList.add('just-saved');
  clearTimeout(el._s);
  el._s = setTimeout(() => el.classList.remove('just-saved'), 900);
}

// a fold that survives the re-render under it
document.addEventListener('toggle', e => {
  const k = e.target.dataset && e.target.dataset.keep;
  if (k) form[k] = e.target.open;
  // a knockout opened from its fold is drawn at the width it now has
  if (e.target.id === 'fold-ko' && e.target.open) renderBrackets();
}, true);

document.addEventListener('focusout', e => {
  if (e.target.dataset && e.target.dataset.save && e.target.tagName !== 'SELECT') autoSave(e.target);
});

document.addEventListener('change', e => {
  const mf = e.target.dataset.mf;
  if (mf) {
    manualDraft[mf] = e.target.value;
    if (mf === 'bo') manualGames = [['', '']];
    renderManual();
    return;
  }
  if (wizInput(e)) return;
  if (e.target.dataset.autolend) {
    api('event_meta', { auto_lend: e.target.checked });
    return;
  }
  if (e.target.dataset.tgscores) {
    api('event_meta', { player_scores: e.target.checked });
    return;
  }
  // selects commit the moment they change — there is nothing to finish typing
  if (e.target.dataset.save) { autoSave(e.target); return; }
  const f = e.target.dataset.f;
  if (f) {
    form[f] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    if (f === 'f_kind' || /c_mode$/.test(f) || /c_pace$/.test(f)) renderSheet();
    if (f === 'w_cup') {
      renderSheet();
      // a doubles cup needs a team, not a name: ask for it straight away
      if (walkIsPair()) { form.team_open = true; renderTeamModal(); }
    }
  }
  // which format a cup's new draw will be, and what settings to show for it
  const nk = e.target.dataset.nk;
  if (nk) {
    form['nk_' + nk] = e.target.value;
    if (e.target.value) seedFormat('nf' + nk + '_', e.target.value, null);
    renderSheet();
    return;
  }
});

document.addEventListener('click', async e => {
  const nudge = e.target.closest('[data-nudge]');
  if (nudge) {
    const how = nudge.dataset.nudge;
    // a picked name opens Telegram through its own link; the sheet has done its job
    if (how === 'picked') { setTimeout(() => nudgeClose('done'), 300); return; }
    return nudgeClose(how);
  }
  if (e.target.closest('#tg-btn')) { nudgeOpen = true; drawNudge(); const q = $('nudge-q'); if (q) q.focus(); return; }
  const tab = e.target.dataset.tab;
  if (tab) {
    sheetTab = tab; renderSheet();
    if (tab === 'chat' && tgOn() && S.telegram.unread) api('tg_read', { all: true });
    return;
  }
  const wstep = e.target.dataset.wstep;
  if (wstep && wiz) { wiz.step = +wstep; renderSheet(); return; }
  const cup = e.target.closest('button[data-cup]');
  if (cup) { setCup(cup.dataset.cup); return; }
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const a = b.dataset.act;
  const num = v => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };

  if (a === 'admit') {
    const r = (S.registrations || []).find(x => x.id === b.dataset.r);
    const out = await api('admit', admitPayload(r));
    if (out && out.where === 'roster') toast(`Added to the roster — ${out.why}`);
    return;
  }
  if (a === 'admit-all') {
    const all = (S.registrations || []).filter(
      r => r.status === 'pending' && r.cup_id === b.dataset.c);
    // a matched team is confirmed through one of its two entries
    const rows = all.filter(r => { const m = mateOf(r); return !(m && all.includes(m) && m.id < r.id); });
    const clash = rows.filter(regDup);
    const go = rows.filter(r => !regDup(r));
    if (!go.length) return toast('Every one of them needs telling apart first');
    if (!confirm(`Confirm ${go.length}${clash.length ? ` (${clash.length} skipped: same name as somebody already in)` : ''}? ` +
      'You can still sit anyone out afterwards.')) return;
    const payloads = go.map(admitPayload);   // before the list re-renders under us
    let stranded = 0, why = '';
    for (const data of payloads) {
      const out = await api('admit', data);
      if (out && out.where === 'roster') { stranded++; why = out.why; }
    }
    // silently landing twenty people on the roster instead of in the draw is
    // exactly the failure that is worth a sentence
    if (stranded) toast(`${stranded} of ${payloads.length} went to the roster — ${why}`);
    return;
  }
  if (a === 'walk-in') {
    if (!form.w_name) return toast('Give them a name');
    const known = knownFor(form.w_name);
    const out = await api('admit', {
      cup_id: walkCup(),
      name: form.w_name, strength: num(form.w_str ?? (known ? known.strength : 5)),
      kind: 'single',
      person_id: known ? known.id : undefined,
    });
    if (out) {
      form.w_name = ''; form.w_str = undefined;
      renderSheet();
      if (out.where === 'roster') toast(`Added to the roster — ${out.why}`);
    }
    return;
  }
  if (a === 'team-open') { form.team_open = true; return renderTeamModal(); }
  if (a === 'team-close') { closeTeamModal(); return; }
  if (a === 'team-seek') { form.t_seek = !!b.dataset.v; return renderTeamModal(); }
  if (a === 'team-add') {
    if (!form.w_name) return toast('Give them a name');
    const known = knownFor(form.w_name);
    const strength = num(form.w_str ?? (known ? known.strength : 5));
    if (form.t_seek) {
      const out = await api('add_registration', {
        cup_id: walkCup(), name: form.w_name, strength });
      if (out) {
        closeTeamModal();
        toast(out.matched_with ? `Matched with ${out.matched_with}` : 'Down as looking for a partner');
      }
      return;
    }
    if (!form.w_pname) return toast('Who is the partner?');
    const pKnown = knownFor(form.w_pname);
    const out = await api('admit', {
      cup_id: walkCup(), kind: 'pair', team_name: form.t_team || '',
      name: form.w_name, strength,
      partner_name: form.w_pname,
      partner_strength: num(form.w_pstr ?? (pKnown ? pKnown.strength : 5)),
      person_id: known ? known.id : undefined,
      partner_person_id: pKnown ? pKnown.id : undefined,
    });
    if (out) {
      closeTeamModal();
      if (out.where === 'roster') toast(`Added to the roster — ${out.why}`);
    }
    return;
  }
  if (a === 'merge-open') { form['mg_' + b.dataset.c] = !form['mg_' + b.dataset.c]; return renderSheet(); }
  if (a === 'merge-cup') {
    const from = cupById(b.dataset.c), into = cupById(b.dataset.i);
    if (!from || !into) return;
    const n = S.entrants.filter(e => e.cup_id === from.id).length;
    const r = (S.registrations || []).filter(x => x.cup_id === from.id && x.status === 'pending').length;
    if (!confirm(`Merge ${from.name} into ${into.name}? ` +
      `${n} in the pool${r ? ` and ${r} pre-registered` : ''} move across, with any tables reserved for ${from.name}. ` +
      `${from.name} and its draw are removed; ${into.name}'s draw and settings are kept.`)) return;
    const out = await api('merge_cups', { from: from.id, into: into.id });
    if (out) { form['mg_' + from.id] = false; toast(`${from.name} merged into ${into.name}`); }
    return;
  }
  if (a === 'rm-all') {
    const cup = cupById(b.dataset.c);
    const n = S.entrants.filter(e => (e.cup_id || '') === b.dataset.c).length;
    if (!confirm(`Remove all ${n} from ${cup ? cup.name : 'this cup'}? Anybody already drawn into a match stays.`)) return;
    const out = await api('remove_entrants', { cup_id: b.dataset.c });
    if (out) toast(`Removed ${out.removed}` + (out.kept ? ` — ${out.kept} stayed, already in a match` : ''));
    return;
  }
  if (a === 'rm-entrant') {
    const e = S.entrants.find(x => x.id === b.dataset.e);
    if (!e) return;
    const back = (S.registrations || []).some(r => r.entrant_id === e.id && r.status === 'confirmed');
    if (!confirm(`Remove ${e.name} from the pool?` +
      (back ? ' Their pre-registration goes back on the list.' : ''))) return;
    return void api('remove_entrant', { id: e.id });
  }
  if (a === 'from-directory') {
    const out = await api('add_from_directory', {
      person_id: b.dataset.n,
      cup_id: S.cups.length === 1 ? S.cups[0].id : (form.w_cup || ''),
    });
    if (out && out.where === 'roster' && out.why) toast(out.why);
    return;
  }
  if (a === 'rm-person') {
    if (!confirm('Forget this player? Tonight\'s roster is untouched; we just stop remembering them between events.')) return;
    return void api('remove_person', { id: b.dataset.n });
  }
  if (a === 'drop-reg') {
    if (!confirm('Remove this entry from the list?')) return;
    return void api('update_registration', { id: b.dataset.r, status: 'dropped' });
  }
  if (a === 'wiz-open') { openWizard(); return; }
  if (a === 'board-all') { boardAll = !boardAll; renderBoard(); return; }
  if (a === 'st-all') { standAll[b.dataset.k] = !standAll[b.dataset.k]; renderStandings(); return; }
  if (a === 'wiz-cancel') { wiz = null; renderSheet(); return; }
  if (a === 'wiz-fx') { form['wfx_' + b.dataset.i] = !form['wfx_' + b.dataset.i];
    return renderSheet(); }
  if (a === 'wiz-back') { wiz.step = Math.max(0, wiz.step - 1); renderSheet(); return; }
  if (a === 'wiz-next') {
    if (wiz.step === 0 && !wiz.name.trim()) return toast('Give the event a name');
    if (wiz.step === 1 && wiz.cups.some(c => !c.name.trim()))
      return toast('Every cup needs a name');
    wiz.step = Math.min(WIZ_STEPS.length - 1, wiz.step + 1);
    renderSheet();
    return;
  }
  if (a === 'wiz-add-cup') {
    seedFormat('w' + wiz.cups.length + '_', 'swiss', null);
    wiz.cups.push({ name: '', blurb: '', entry: 'single', registration: 'open', kind: 'swiss' });
    renderSheet();
    return;
  }
  if (a === 'wiz-rm-cup') {
    const gone = +b.dataset.i;
    wiz.cups.splice(gone, 1);
    // format settings are keyed by position, so re-seat what is left
    wiz.cups.forEach((c, i) => seedFormat('w' + i + '_', c.kind, null));
    wiz.tables.forEach(t => {
      if (t.cup === gone) t.cup = -1;
      else if (t.cup > gone) t.cup -= 1;
    });
    renderSheet();
    return;
  }
  if (a === 'wiz-add-table') {
    wiz.tables.push({ name: 'Table ' + (wiz.tables.length + 1), cup: -1 });
    renderSheet();
    return;
  }
  if (a === 'wiz-rm-table') { wiz.tables.splice(+b.dataset.i, 1); renderSheet(); return; }
  if (a === 'wiz-create') {
    if (!confirm('Create "' + wiz.name + '"? The current players, teams, formats and matches go.')) return;
    const ok = await api('create_event', {
      name: wiz.name, venue: wiz.venue, blurb: wiz.blurb, starts_at: wiz.starts_at,
      cups: wiz.cups.map((c, i) => ({
        name: c.name, blurb: c.blurb, entry: c.entry, registration: c.registration,
        kind: c.kind || '',
        config: c.kind ? formatConfig('w' + i + '_', c.kind) : {},
      })),
      tables: wiz.tables.map(t => ({ name: t.name, cup: t.cup })),
    });
    if (ok) { wiz = null; sheetTab = 'event'; renderSheet(); toast('Event created'); }
    return;
  }

  if (a === 'clear') { drafts[b.dataset.m] = [['', '']]; render(); return; }
  if (a === 'edit' || a === 'score') return openEditor(b.dataset.m);
  if (a === 'close-editor') return closeEditor();
  if (a === 'undo') {
    if (!confirm('Take this result back? The match can be played again, and anything it decided in a later round is undone with it.')) return;
    const ok = await api('reopen_match', { match_id: b.dataset.m });
    if (ok) closeEditor();
    return;
  }

  if (a === 'report') {
    const mid = b.dataset.m;
    const games = (drafts[mid] || []).filter(g => g[0] !== '' && g[1] !== '')
      .map(g => [+g[0], +g[1]]);
    const m = findMatch(mid);
    const wa = games.filter(g => g[0] > g[1]).length, wb = games.length - wa;
    const who = m ? nm(wa > wb ? m.a : m.b) : '';
    const sc = `${Math.max(wa, wb)}–${Math.min(wa, wb)}`;
    const send = () => api('report', { match_id: mid, games, requeue: drafts['rq-' + mid] !== false });
    const onTable = m && m.table && editing !== mid;
    const ok = onTable ? await swapTable(m.table, send) : await send();
    if (ok) {
      delete drafts[mid]; delete drafts['rq-' + mid]; if (editing === mid) closeEditor();
      toast(`Saved · ${who} win ${sc}`, onTable ? nowOn(m.table) : '', async () => {
        if (await api('reopen_match', { match_id: mid })) toast('Result taken back', 'The match is waiting to be played again');
      });
    }
    return;
  }
  if (a === 'manual-result') {
    const games = manualGames.filter(g => g[0] !== '' && g[1] !== '').map(g => [+g[0], +g[1]]);
    const ok = await api('manual_result', {
      entrant_a: manualDraft.a, entrant_b: manualDraft.b,
      format_id: manualDraft.format_id || undefined,
      games,
      scoring: { best_of: +manualDraft.bo, points_to: +manualDraft.pts, win_by: 2 },
    });
    if (ok) { manualDraft.a = ''; manualDraft.b = ''; manualGames = [['', '']]; manualOpen = false; renderManual(); }
    return;
  }
  if (a === 'manual-clear') { manualGames = [['', '']]; renderManual(); return; }
  if (a === 'recent-all') { recentAll = !recentAll; renderRecent(); return; }
  if (a === 'manual-open') { manualOpen = true; renderManual(); return; }
  if (a === 'manual-close') { manualOpen = false; renderManual(); return; }
  if (a === 'put-back') {
    const m = findMatch(b.dataset.m);
    const send = () => api('put_back', { match_id: b.dataset.m });
    const ok = m && m.table ? await swapTable(m.table, send) : await send();
    if (ok) toast(ok.reseated ? 'Put back' : 'Put back',
      ok.reseated ? 'Nobody else could take the table, so the same pair went straight back on'
        : 'Sent to the end of the queue' + (m && m.table ? ' · ' + nowOn(m.table) : ''));
    return;
  }
  if (a === 'seat') {
    const mid = b.dataset.m;
    const row = (S.board || []).flatMap(x => x.up || []).find(r => r.id === mid) || {};
    const out = await api('queue_front', { match_id: mid });
    if (!out) return;
    if (out.table) return toast(`Seated on table ${out.table}`, `${nm(row.a)} vs ${nm(row.b)} are on`);
    return toast('Moved to the front', 'The next free table goes to them',
      () => api('queue_front', { match_id: mid, restore: out.was }));
  }
  if (a === 'toast-undo') {
    const f = toastUndo; toastUndo = null; $('toast').hidden = true;
    if (f) await f();
    return;
  }
  if (a === 'jump') {
    // board.tables leaves paused tables out, because they are not serving and
    // should not count towards a wait. A table you paused and emptied on
    // purpose is exactly the one you mean here, though, so work the candidates
    // out from the reservations instead: shared, or held for this match's cup.
    const blk = (S.board || []).find(x => (x.up || []).some(r => r.id === b.dataset.m));
    const cup = blk ? blk.cup_id : null;
    const open = S.tables.filter(t => !t.match && (!t.cup_id || t.cup_id === cup));
    const free = open.find(t => !t.paused) || open[0];
    if (!free) return toast('No table free that this match can use');
    const held = free.paused;
    const out = await api('assign', { match_id: b.dataset.m, table: free.number });
    if (out && held) toast(`Seated on table ${free.number}, which is back in service`);
    return;
  }
  if (a === 'withdraw') {
    const e = S.entrants.find(x => x.id === b.dataset.e) || {};
    if (!confirm(`${e.name} has gone home?\n\nEvery match they still owe is given `
      + `to their opponent as a walkover, any table they are on is freed straight away, `
      + `and they take no place into the knockout. What they already played still counts `
      + `for the people they played. You can bring them back.`)) return;
    const out = await api('withdraw', { entrant_id: b.dataset.e });
    if (out) toast(out.walkovers
      ? `${out.name} is out — ${out.walkovers} ${out.walkovers === 1 ? 'match' : 'matches'} `
        + `given to their opponents` + (out.freed_tables.length
          ? `, table ${out.freed_tables.join(' and ')} freed` : '')
      : `${out.name} is out`);
    return;
  }
  if (a === 'rejoin') return void api('withdraw', { entrant_id: b.dataset.e, withdrawn: false });
  if (a === 'rest') {
    const e = b.dataset.e;
    const ok = await api('set_resting', { entrant_id: e, resting: true });
    if (ok) toast(`${b.dataset.n || 'They'} sit out`, "Nobody pairs them until they're back",
      () => api('set_resting', { entrant_id: e, resting: false }));
    return;
  }
  if (a === 'unrest') return void api('set_resting', { entrant_id: b.dataset.e, resting: false });
  if (a === 'pause') {
    const t = S.tables.find(x => x.number == b.dataset.t);
    return void api('set_table', { number: +b.dataset.t, paused: !t.paused });
  }
  if (a === 'add-table') {
    const n = S.tables.length ? Math.max(...S.tables.map(t => t.number)) + 1 : 1;
    return void api('set_table', { number: n, name: 'Table ' + n });
  }
  if (a === 'rm-table') return void api('remove_table', { number: +b.dataset.t });
  if (a === 'lend-table') return void api('lend_table', { number: +b.dataset.t });
  if (a === 'share-tables') {
    if (!confirm('Put every table back into the shared pool?')) return;
    return void api('share_tables', {});
  }
  if (a === 'split-tables') {
    // deal the tables round-robin as a starting point; the selects below
    // are the assignment dialog, and they apply as you change them
    const assignments = {};
    S.tables.forEach((t, i) => { assignments[t.number] = S.cups[i % S.cups.length].id; });
    await api('split_tables', { assignments });
    renderSheet();
    return;
  }

  if (a === 'add-cup') {
    if (!form.cupname) return toast('Give the cup a name');
    await api('add_cup', { name: form.cupname });
    form.cupname = ''; renderSheet();
    return;
  }
  // the edge no tab could reach before: which draw the door feeds
  if (a === 'set-intake') return void api('update_cup', {
    id: b.dataset.c, format_id: b.dataset.i });
  if (a === 'fx') { form['fx_' + b.dataset.i] = !form['fx_' + b.dataset.i];
    if (form['fx_' + b.dataset.i]) {
      const f = S.formats.find(x => x.id === b.dataset.i);
      seedFormat('fe' + f.id + '_', f.kind, f.config);
      form['fe' + f.id + '_name'] = f.name;
    }
    return renderSheet();
  }
  if (a === 'walk-toggle') {
    form.walk_open = !form.walk_open;
    renderSheet();
    if (form.walk_open && walkIsPair()) { form.team_open = true; renderTeamModal(); }
    return;
  }
  if (a === 'rm-cup') {
    if (!confirm('Remove this cup? Its tables and formats stay, just ungrouped.')) return;
    return void api('remove_cup', { id: b.dataset.c });
  }


  /* Creating a draw inside a cup writes both edges at once: the format's
     cup_id, and — if the cup has nowhere for the door to send people yet —
     the cup's format_id. Pointing one at the other and not the other way
     round is what used to leave everybody stranded on the roster. */
  if (a === 'add-draw') {
    const cid = b.dataset.c;
    const kind = form['nk_' + cid];
    if (!kind) return;
    const cup = S.cups.find(x => x.id === cid) || {};
    const cfg = formatConfig('nf' + cid + '_', kind);
    cfg.cup_id = cid;
    const out = await api('add_format', {
      kind, name: cup.name || '', config: cfg });
    if (!out) return;
    if (!cup.format_id) await api('update_cup', { id: cid, format_id: out.format_id });
    form['nk_' + cid] = '';
    renderSheet();
    return;
  }
  if (a === 'save-format') {
    const fid = b.dataset.i;
    const f = S.formats.find(x => x.id === fid);
    if (!f) return;
    const pfx = 'fe' + fid + '_';
    const cfg = formatConfig(pfx, f.kind);
    cfg.cup_id = f.cup_id || '';
    const data = { id: fid, name: form[pfx + 'name'] ?? f.name, config: cfg };
    await api('update_format', data);
    form['fx_' + fid] = false;
    renderSheet();
    return;
  }
  if (a === 'start-format') return void api('start_format', { id: b.dataset.i });
  if (a === 'rm-format') {
    if (!confirm('Remove this format and void all of its matches?')) return;
    return void api('remove_format', { id: b.dataset.i });
  }
  if (a === 'reset-format') {
    if (!confirm('Clear this format\'s matches and results? Its settings and entrants stay, ready to start again.')) return;
    return void api('reset_format', { id: b.dataset.i });
  }
  if (a === 'cut-ko') {
    if (!confirm('Stop this Swiss now and build the knockout from current standings?')) return;
    return void api('swiss_cut_ko', { id: b.dataset.i });
  }
  if (a === 'past-load') {
    form.past_busy = true; renderSheet();
    const out = await api('past_events');
    form.past_busy = false;
    if (out) form.past_events = out.events;
    renderSheet();
    return;
  }
  if (a === 'past-open') {
    window.open(location.pathname + '?past=' + b.dataset.i, 'tt-past-' + b.dataset.i);
    return;
  }
  if (a === 'past-toggle') {
    form['pe_' + b.dataset.i] = !form['pe_' + b.dataset.i];
    renderSheet();
    return;
  }
  if (a === 'rewind') {
    if (!confirm('Drop everything after event ' + b.dataset.s + '?')) return;
    return void api('rewind', { seq: +b.dataset.s });
  }
  if (a === 'sim-run') {
    // opened on the click itself: a window.open after the await is a pop-up
    // as far as the browser is concerned, and gets blocked
    const w = window.open('', 'tt-sim');
    form.sim_busy = true; renderSheet();
    const out = await api('sim_start', {
      per_cup: num(form.sim_n ?? 18), rounds: num(form.sim_r ?? 3) });
    form.sim_busy = false; renderSheet();
    if (!out) { if (w) w.close(); return; }
    if (w) w.location = simUrl();
    else toast('Built it — allow pop-ups, or use “Open the tab”');
    return;
  }
  if (a === 'sim-open') { window.open(simUrl(), 'tt-sim'); return; }
  if (a === 'sim-board') { window.open('/board?sim=1', 'tt-sim-board'); return; }
  if (a === 'tg-connect') {
    if (!(form.tg_token || '').trim()) return toast('Paste the token from @BotFather first');
    form.tg_busy = true; renderSheet();
    const out = await api('tg_connect', { token: form.tg_token, url: location.origin + '/' });
    form.tg_busy = false;
    if (out) { form.tg_token = ''; toast(`Connected as @${out.username}`); }
    renderSheet();
    return;
  }
  if (a === 'tg-disconnect') {
    if (!confirm('Disconnect the bot? Players stop getting table calls until you connect it ' +
      'again. Who is linked to whom is kept.')) return;
    return void api('tg_disconnect', {});
  }
  if (a === 'tg-send' || a === 'tg-announce') {
    const t = S.telegram || {};
    const aud = form.tg_aud || ((S.phase === 'doors' || S.phase === 'live') ? 'tonight' : 'followers');
    const announce = a === 'tg-announce';
    const text = (form.tg_text || '').trim();
    if (!announce && !text) return toast('Write something first');
    const n = (((t.audiences || []).find(x => x.id === (announce ? 'followers' : aud))) || {}).n || 0;
    if (!confirm(announce ? `Send the event with its entry buttons to ${n} following?`
                          : `Send this to ${n}?`)) return;
    const out = await api('tg_send', { audience: announce ? 'followers' : aud, text,
                                       announce, url: location.origin + '/' });
    if (out) { form.tg_text = ''; toast(`On its way to ${out.sent}`); renderSheet(); }
    return;
  }
  if (a === 'tg-reply') {
    const key = b.dataset.c;
    const text = (form['rep_' + key] || '').trim();
    if (!text) return;
    const out = await api('tg_send', { audience: 'chat', chat_id: +key, text });
    if (out) { form['rep_' + key] = ''; renderSheet(); }
    return;
  }
  if (a === 'th-more') { form['th_' + b.dataset.c] = !form['th_' + b.dataset.c]; return renderSheet(); }
  if (a === 'tg-link') {
    const who = (S.people || []).find(p => p.id === b.dataset.n);
    const out = await api('tg_door_link', { person_id: b.dataset.n, url: location.origin + '/' });
    if (out) { form.tgm = { kind: 'link', name: who ? who.name : '', url: out.url }; renderTgModal(); }
    return;
  }
  if (a === 'tg-msg') {
    const e = S.entrants.find(x => x.id === b.dataset.e);
    if (!e) return;
    form.tgm = { kind: 'msg', name: e.name, chats: tgLinked(e).map(p => p.tg_id) };
    form.tgm_text = '';
    renderTgModal();
    return;
  }
  if (a === 'tgm-close') { form.tgm = null; renderTgModal(); return; }
  if (a === 'tgm-send') {
    const text = (form.tgm_text || '').trim();
    if (!text) return toast('Write something first');
    for (const c of form.tgm.chats) await api('tg_send', { audience: 'chat', chat_id: c, text });
    toast(`Sent to ${form.tgm.name}`);
    form.tgm = null; renderTgModal();
    return;
  }
  if (a === 'sim-stop') {
    if (!confirm('Stop the sim? Any tab showing it goes dead.')) return;
    return void api('sim_stop', {});
  }
});

$('sheet-close').onclick = () => setMode('live');
document.addEventListener('click', e => {
  const m = e.target.closest('button[data-mode]');
  if (m) { setMode(m.dataset.mode); return; }
  const pin = e.target.closest('[data-phase-pin]');
  if (pin) {                                          // Setup → Event: the stepper
    const p = pin.dataset.phasePin;
    if (p === ((S.event || {}).phase_pin || '')) return;
    api('set_phase', { phase: p });
    return;
  }
});
function closeTeamModal() {
  form.team_open = false;
  form.w_name = form.w_pname = form.t_team = '';
  form.w_str = form.w_pstr = undefined;
  form.t_seek = false;
  delete $('team-modal').dataset.shown;
  renderTeamModal();
  renderSheet();
}
$('team-modal').addEventListener('click', e => {
  if (e.target.id === 'team-modal') closeTeamModal();
});
$('tg-modal').addEventListener('click', e => {
  if (e.target.id === 'tg-modal') { form.tgm = null; renderTgModal(); }
});

document.addEventListener('keydown', e => {
  const rep = e.key === 'Enter' && e.target.id && /^rep-/.test(e.target.id);
  if (rep) {
    const btn = e.target.closest('.reply') && e.target.closest('.reply').querySelector('[data-act="tg-reply"]');
    if (btn) { e.preventDefault(); btn.click(); }
    return;
  }
  if (e.key !== 'Escape') return;
  if (nudgeOpen) return nudgeClose('later');
  if (form.tgm) { form.tgm = null; return renderTgModal(); }
  if (form.team_open) return closeTeamModal();
  if (editing) return closeEditor();
  if (sheetOpen && !wiz) setMode('live');
});
$('editor').addEventListener('click', e => {
  if (e.target.id === 'editor') closeEditor();
});

if (PAST) {
  const b = $('sim-bar');
  document.body.classList.add('sim');       // same stripe, same room for it
  if (b) { b.hidden = false; b.textContent =
    'Past event — read only. This is how the evening ended; nothing here can be changed.'; }
  document.title = 'PAST · ' + document.title;
  // The server refuses every write; this just stops the buttons pretending.
  const VIEW = new Set(['recent-all', 'jump', 'close-editor']);
  document.addEventListener('click', e => {
    const b = e.target.closest('button[data-act]');
    if (b && !VIEW.has(b.dataset.act)) {
      e.stopImmediatePropagation(); e.preventDefault();
      toast('Past event — read only');
    }
  }, true);
}

if (SIM) {
  const b = $('sim-bar');
  document.body.classList.add('sim');
  if (b) { b.hidden = false; b.textContent =
    'Sandbox — a simulated copy of the event. Nothing here is real, and ' +
    'nothing you do here reaches the night.'; }
  document.title = 'SIM · ' + document.title;
}

poll(true);
connectStream();
ticks.push(setInterval(() => { if (!streamOk) poll(); }, 2500));   // fallback only
ticks.push(setInterval(() => { if (streamOk) poll(); }, 20000));   // slow reconcile
