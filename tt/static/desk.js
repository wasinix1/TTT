/* The registration desk — see docs/registration-desk.md.

   Its own page and its own payload (/api/desk), so it redraws when somebody
   is checked in and not every time a point is scored. Everything about who
   is in the event happens here: checking in, walk-ins, no-shows, names and
   partners, sitting out, going home, the directory.

   Every action goes through the same ops the console uses, and every one
   that can be taken back offers Undo instead of asking "are you sure"
   first. The one exception is Gone home, which gives matches away and so
   asks, in the panel, before it happens. */

const PATH = location.pathname.match(/^\/([ad])\/([^/]+)(?:\/desk)?\/?$/) || [];
const TOKEN = PATH[2] || '';
// the admin gets their console; the door key has none, so it gets the live view
const CONSOLE = PATH[1] === 'a' ? { href: `/a/${TOKEN}`, label: 'Console ↗' }
  : { href: '/', label: 'Live view ↗' };
// the sandbox tab is the same desk pointed at a throwaway event
const SIMQ = new URLSearchParams(location.search).get('sim') === '1' ? '?sim=1' : '';

let D = null;              // last payload
let etag = '';
const V = {                // what this viewer is looking at; never sent anywhere
  view: 'desk', cup: '', q: '', filter: 'all', sel: null, phone: 'exp',
  kb: -1, dirQ: '', dirAdd: '', confirm: '', stale: false, pick: {},
  walk: { name: '', partner: '', seek: false },
};
try { V.cup = localStorage.getItem('tt_desk_cup') || ''; } catch (e) { }

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// the server's Store.name_key: case and stray spaces never make two people
const nk = s => String(s || '').trim().split(/\s+/).join(' ').toLowerCase();
const cap = s => { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); };

/* ------------------------------------------------------------------ data */

async function load() {
  try {
    const r = await fetch('/api/desk' + SIMQ, {
      headers: { 'X-Key': TOKEN, ...(etag ? { 'If-None-Match': etag } : {}) },
    });
    if (r.status === 304) return;
    if (r.status === 403) return fatal('This link does not open the desk. Use the admin or the door link.');
    if (r.status === 404) return fatal('This sim has been stopped from the real console. Close the tab.');
    if (!r.ok) return;
    etag = r.headers.get('ETag') || '';
    D = await r.json();
    if (!D.cups.some(c => c.id === V.cup)) V.cup = D.cups.length ? D.cups[0].id : '';
    // never redraw under somebody typing: the walk-in form keeps its draft in
    // V, but a half-typed rename would be lost. Catch up when they leave it.
    if (editing()) { V.stale = true; return; }
    render();
  } catch (e) { /* offline for a moment; the next nudge tries again */ }
}

// the detail panel's fields save on leaving them, so a redraw would take the
// half-typed value; the walk-in form and the filters keep their drafts in V
const editing = () => {
  const a = document.activeElement;
  return !!(a && a.dataset && a.dataset.edit && $('app').contains(a));
};
document.addEventListener('focusout', () => setTimeout(() => {
  if (V.stale && !editing()) { V.stale = false; render(); }
}, 0));

function fatal(msg) {
  D = null;
  $('app').innerHTML = `<p class="fatal"><b>${esc(msg)}</b></p>`;
  if (stream) stream.close();
}

let stream = null;
function listen() {
  // the stream says "something changed"; the ETag makes asking cheap when
  // what changed was only a score
  try {
    stream = new EventSource('/api/stream' + SIMQ);
    stream.onmessage = () => { pulse(true); load(); };
    stream.onerror = () => pulse(false);
  } catch (e) { }
  setInterval(load, 15000);
}
function pulse(on) { const p = $('pulse'); if (p) p.classList.toggle('on', on); }

/* Do one thing on the server. Errors come back as a toast in the server's
   own words, which are written for exactly this. */
async function api(op, data) {
  try {
    const r = await fetch('/api/action' + SIMQ, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Key': TOKEN },
      body: JSON.stringify({ op, data }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { toast(j.error ? cap(j.error) + '.' : 'That did not go through. Try again.'); return null; }
    return j;
  } catch (e) {
    toast('No connection to the server just now. Try again.');
    return null;
  } finally { load(); }
}

/* ------------------------------------------------------------------ toast */

let toastTimer = 0, toastUndo = null;
function toast(msg, undo) {
  let el = $('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; document.body.appendChild(el); }
  toastUndo = undo || null;
  el.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button data-undo="1">Undo</button>' : ''}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; toastUndo = null; }, undo ? 8000 : 5000);
}

/* --------------------------------------------------------------- helpers */

const cupById = id => D.cups.find(c => c.id === id);
const cupName = id => (cupById(id) || {}).name || '';
const regById = id => D.registrations.find(r => r.id === id);
const entById = id => D.entrants.find(e => e.id === id);
const regNames = r => [r.name, r.partner_name].filter(Boolean);
const label = names => names.filter(Boolean).join(' & ');
const entNames = e => e.players.length ? e.players : [e.name];
const beforeDoors = () => D.phase === 'announced' || D.phase === 'registration';
const personNamed = n => D.people.find(p => nk(p.name) === nk(n));
// a team name somebody chose, as opposed to the two names joined up
const teamName = e => e.players.length > 1 && ![label(e.players), e.players.join(' / ')]
  .some(n => nk(n) === nk(e.name)) ? e.name : '';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function when(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000), now = new Date();
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  const day = x => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const ago = Math.round((day(now) - day(d)) / 86400000);
  if (ago === 0) return 'today ' + hm;
  if (ago === 1) return 'yesterday ' + hm;
  if (ago > 1 && ago < 7) return DAYS[d.getDay()] + ' ' + hm;
  return `${d.getDate()}.${d.getMonth() + 1}. ${hm}`;
}
const clock = ts => { if (!ts) return ''; const d = new Date(ts * 1000);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };

/* The console's words for where somebody is (App.entrant_status), and the
   sentence each one carries. */
const STATUS = {
  playing: ['playing', 'hot', 'On a table now.'],
  waiting: ['waiting', '', 'In line for a table.'],
  resting: ['sitting out', 'dim', 'Sat out — nobody will pair them until they are back.'],
  entered: ['in the draw', '', 'In the draw, which has not started yet.'],
  drawn: ['in the draw', '', 'In the draw, between matches.'],
  outside: ['no draw', 'warn', 'In this cup, but no draw is taking them: none is set up yet, or it started without them.'],
  withdrawn: ['gone home', 'dim', 'Gone for the night. Every match they still owed went to their opponent.'],
};
const FILTERS = [
  ['all', 'All', e => e.status !== 'withdrawn'],
  ['playing', 'Playing', e => e.status === 'playing'],
  ['waiting', 'Waiting', e => e.status === 'waiting'],
  ['resting', 'Sitting out', e => e.status === 'resting'],
  ['outside', 'No draw', e => e.status === 'outside'],
  ['withdrawn', 'Gone home', e => e.status === 'withdrawn'],
];

/* While filtering, both lists search every cup and each row names its cup,
   so "is Jana here?" has one answer whichever tab is open. */
const filtering = () => !!nk(V.q);
const matchQ = names => !filtering() || names.some(n => nk(n).includes(nk(V.q)));
const cupChip = id => filtering() && D.cups.length > 1
  ? `<span class="chip dark">${esc(cupName(id))}</span>` : '';

/* The same name somewhere in another cup: a hint, never a block. Being in
   singles and doubles is normal. */
function alsoIn(names, cup) {
  if (filtering()) return '';
  const keys = names.map(nk);
  const other = D.cups.filter(c => c.id !== cup && (
    D.registrations.some(r => r.cup_id === c.id && r.status === 'pending' && regNames(r).some(n => keys.includes(nk(n))))
    || D.entrants.some(e => e.cup_id === c.id && entNames(e).some(n => keys.includes(nk(n))))));
  return other.map(c => `<span class="chip dim">also in ${esc(c.name)}</span>`).join('');
}

/* Who is already here under these names — the mirror of the server's
   _refuse_duplicate, so the desk can offer the way round before the server
   says no. Singles: the same name anywhere tonight. Doubles: the same two
   people together. Somebody in a singles and a doubles cup is fine. */
function clashFor(cup, names) {
  names = names.filter(Boolean);
  if (names.length === 2) {
    const want = names.map(nk).sort().join('|');
    return D.entrants.find(e => e.players.length === 2 && e.players.map(nk).sort().join('|') === want);
  }
  if ((cupById(cup) || {}).entry === 'pair') return null;
  return D.entrants.find(e => e.players.length === 1 && nk(e.players[0]) === nk(names[0]));
}
function freeName(n) {
  const taken = new Set(D.entrants.flatMap(e => e.players.map(nk)));
  let i = 2;
  while (taken.has(nk(`${n} (${i})`))) i++;
  return `${n} (${i})`;
}

/* ------------------------------------------------------------- Expected */

/* A matched pair of people looking for a partner is one team and one card.
   Anybody still looking has their own section.

   Entries with the same names in the same cup are grouped behind one card:
   shown together, never merged. Checking in uses one of them, and the rest
   stay, marked, until somebody at the desk says whether they are the same
   team or another one — so no entry disappears as a side effect. An entry
   somebody said is a different team is never grouped. */
function cardsFor(cup) {
  const pend = D.registrations.filter(r => r.cup_id === cup && r.status === 'pending');
  const seen = new Set(), groups = new Map(), cards = [], seekers = [];
  for (const r of pend) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const mate = r.matched_with && pend.find(x => x.id === r.matched_with);
    if (mate) { seen.add(mate.id); cards.push({ key: r.id, cup, regs: [r, mate], names: [r.name, mate.name], matched: true }); }
    else if (r.kind === 'seeking') seekers.push({ key: r.id, cup, regs: [r], names: [r.name], seeking: true });
    else {
      const k = r.distinct ? 'x:' + r.id : regNames(r).map(nk).sort().join('|');
      if (groups.has(k)) { groups.get(k).regs.push(r); continue; }
      const card = { key: r.id, cup, regs: [r], names: regNames(r), distinct: !!r.distinct };
      groups.set(k, card);
      cards.push(card);
    }
  }
  for (const c of cards) {
    c.stack = !c.matched && c.regs.length > 1;
    if (c.stack) c.names = regNames(c.regs[c.regs.length - 1]);
    c.here = clashFor(cup, c.names) || null;
    c.leftover = !!c.here && !c.distinct;
  }
  // what needs a decision comes first
  cards.sort((a, b) => b.leftover - a.leftover);
  return { cards, seekers };
}

/* Which entry of a card a check-in uses: the one picked in the panel, else
   the newest, since a second entry is usually the correction. */
function pickedReg(card) {
  if (card.matched) return card.regs[0];
  return card.regs.find(r => r.id === V.pick[card.key]) || card.regs[card.regs.length - 1];
}
const allCards = () => D.cups.flatMap(c => { const p = cardsFor(c.id); return p.cards.concat(p.seekers); });
const cardByKey = k => allCards().find(c => c.key === k);

/* What "Check in all" takes: one of each name, and nobody already here.
   Two entries for the same person are left for somebody to look at. */
function readyCards(cup) {
  const seen = new Set();
  return cardsFor(cup).cards.filter(c => {
    const k = c.names.map(nk).sort().join('|');
    if (clashFor(c.cup, c.names) || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/* Near matches get a hint and nothing else: somebody looking for a partner
   who is already named in a team's entry, or an entry kept apart from
   another with the same names. */
function hintsFor(card) {
  const out = [];
  if (card.seeking) {
    const other = D.registrations.find(x => x.cup_id === card.cup && x.status === 'pending'
      && x.kind === 'pair' && regNames(x).some(n => nk(n) === nk(card.names[0])));
    if (other) out.push(`Also named in ${label(regNames(other))}`);
  }
  if (card.distinct && !card.here) {
    const want = card.names.map(nk).sort().join('|');
    if (D.registrations.some(x => x.id !== card.key && x.cup_id === card.cup && x.status === 'pending'
        && regNames(x).map(nk).sort().join('|') === want))
      out.push(card.names.length > 1 ? 'Same names as another entry — kept as a separate team.'
        : 'Same name as another entry — kept as a separate person.');
  }
  return out;
}

function cardHTML(card) {
  const team = card.regs.map(x => x.team_name).filter(Boolean).pop();
  const note = card.regs.map(x => x.note).filter(Boolean).pop();
  const sel = V.sel && V.sel.key === card.key ? ' sel' : '';
  const chips = [
    cupChip(card.cup),
    card.matched ? '<span class="chip dark">matched as partners</span>' : '',
    card.seeking ? '<span class="chip">looking for a partner</span>' : '',
    card.leftover ? '<span class="chip warn">already here — same?</span>'
      : card.stack ? `<span class="chip warn">registered ${card.regs.length}×</span>`
      : card.distinct ? `<span class="chip dim">separate ${card.names.length > 1 ? 'team' : 'person'}</span>` : '',
    alsoIn(card.names, card.cup),
    `<span>${card.regs.map(r => esc(when(r.created_ts))).join(' · ')}</span>`,
  ].filter(Boolean).join('');
  const k = esc(card.key);
  // anything that needs deciding is decided in the panel, where all of it shows
  const acts = card.leftover || (card.distinct && card.here) ? ''
    : beforeDoors() ? (card.stack ? '' : `<button class="btn ghost tiny" data-act="drop" data-k="${k}">Remove</button>`)
    : card.seeking ? `<button class="btn ghost tiny" data-act="drop" data-k="${k}">No show</button>`
    : `${card.matched || card.stack ? '' : `<button class="btn ghost tiny" data-act="drop" data-k="${k}">No show</button>`}
       <button class="btn primary tiny" data-act="checkin" data-k="${k}">Check in</button>`;
  const cls = [card.stack ? ' stack' : '', card.leftover ? ' leftover' : ''].join('');
  return `<div class="card${sel}${cls}" data-sel-reg="${k}">
    <div class="who">${esc(label(card.names))}${team ? `<span class="team">${esc(team)}</span>` : ''}</div>
    <div class="side">${acts}</div>
    <div class="meta">${chips}</div>
    ${note ? `<div class="note">“${esc(note)}”</div>` : ''}
    ${hintsFor(card).map(h => `<div class="hint">${esc(h)}</div>`).join('')}
  </div>`;
}

function renderExpected() {
  const cups = filtering() ? D.cups.map(c => c.id) : [V.cup];
  const parts = cups.map(cardsFor);
  const hit = c => matchQ(c.regs.flatMap(regNames).concat(c.regs.map(r => r.team_name)));
  const cards = parts.flatMap(p => filtering() ? p.cards.concat(p.seekers) : p.cards).filter(hit);
  const seekers = filtering() ? [] : parts[0].seekers;
  const total = parts.reduce((n, p) => n + p.cards.length + p.seekers.length, 0);
  V._cards = cards.concat(seekers);
  const pair = !filtering() && (cupById(V.cup) || {}).entry === 'pair';
  const gone = D.registrations.filter(r => cups.includes(r.cup_id)
    && (r.status === 'dropped' || r.status === 'duplicate') && matchQ(regNames(r)));
  const ready = !filtering() && !beforeDoors() ? readyCards(V.cup) : [];
  const all = V.confirm === 'all:' + V.cup;
  return `<section class="col ${V.phone === 'here' ? 'hideP' : ''}">
    <div class="colhead"><h2>${beforeDoors() ? 'Registered' : 'Expected'}</h2>
      <span class="n">${filtering() ? `${cards.length} found in all cups` : total}</span>
      ${ready.length > 1 && !all ? `<button class="btn ghost tiny push" data-act="all-ask">Check in all ${ready.length}</button>` : ''}</div>
    ${all ? `<div class="confirm"><span>Check in all ${ready.length} expected in ${esc(cupName(V.cup))}?
        ${ready.length < parts[0].cards.length ? 'Entries whose name is already here are left for you to look at.' : ''}
        You can undo it straight after.</span>
      <div class="actions"><button class="btn primary tiny" data-act="all-go">Check in ${ready.length}</button>
        <button class="btn ghost tiny" data-act="unconfirm">Cancel</button></div></div>` : ''}
    <div class="list">${cards.map(cardHTML).join('')
      || `<div class="empty">${filtering() ? 'Nobody matches.' : beforeDoors()
        ? 'No entries yet.' : 'Nobody left to expect.'}</div>`}</div>
    ${pair ? `<div class="sub">Looking for a partner <span class="chip dim">matched automatically</span></div>
      <div class="list">${seekers.map(cardHTML).join('') || '<div class="empty">Nobody waiting for a partner.</div>'}</div>` : ''}
    <details class="resolved" id="resolved"${V.openRes ? ' open' : ''}><summary>Taken off the list · ${gone.length}</summary>
      ${gone.length ? `<ul>${gone.map(r => `<li><span>${cupChip(r.cup_id)} <b>${esc(label(regNames(r)))}</b> · sent ${esc(when(r.created_ts))}
        · ${r.status === 'duplicate' ? 'duplicate' : beforeDoors() ? 'removed' : 'no show'}</span>
        <button class="btn ghost tiny" data-act="putback" data-r="${r.id}">Put back</button></li>`).join('')}</ul>`
        : '<p style="margin:8px 0 0">Nothing yet. No-shows, removed entries and cleared duplicates land here, and can be put back.</p>'}
    </details>
  </section>`;
}

/* ----------------------------------------------------------------- Here */

/* A walk-in whose name is already on a list is told so, with a way out in
   either direction. Nothing is blocked. */
function walkState() {
  const w = V.walk, cup = cupById(V.cup) || {};
  const pair = cup.entry === 'pair' && !w.seek;
  const names = pair ? [w.name, w.partner] : [w.name];
  if (!nk(w.name) || (pair && !nk(w.partner))) return { names };
  const want = names.map(nk).sort().join('|');
  const reg = D.registrations.find(r => r.cup_id === V.cup && r.status === 'pending'
    && (w.seek ? nk(r.name) === nk(w.name) : regNames(r).map(nk).sort().join('|') === want));
  if (reg) return { names, reg };
  const here = !w.seek && clashFor(V.cup, names);
  return { names, here, as: here ? freeName(names[0]) : '' };
}
function walkMsg(st) {
  if (st.reg) {
    const card = allCards().find(c => c.regs.some(r => r.id === st.reg.id));
    return `<div class="msg">${esc(label(regNames(st.reg)))} registered ${esc(when(st.reg.created_ts))}.
      ${card && !card.seeking ? `<button class="btn tiny" type="button" data-act="checkin" data-k="${esc(card.key)}">Check in the registration instead</button>` : ''}</div>`;
  }
  if (st.here) return `<div class="msg">${esc(label(st.names))} ${st.here.players.length > 1 ? 'are' : 'is'} already here, in at ${esc(clock(st.here.added_ts))}.
    <button class="btn tiny" type="button" data-sel-ent="${st.here.id}">Show</button>
    Adding again enters them as “${esc(st.as)}”.</div>`;
  return '';
}
function walkButton(st) {
  if (V.walk.seek) return 'Put down as looking';
  return st.here ? `Add as “${esc(st.as)}”` : 'Add';
}

function renderHere() {
  if (beforeDoors()) return `<section class="col ${V.phone === 'exp' ? 'hideP' : ''}">
    <div class="colhead"><h2>Here</h2></div>
    <div class="empty">Check-in opens with the doors. Until then, tidy the list on the left:
      fix names, take off what will not come. Nothing there reaches a draw.</div></section>`;
  const cup = cupById(V.cup) || {};
  const pool = D.entrants.filter(e => filtering() || e.cup_id === V.cup);
  const shown = FILTERS.filter(([k, , f]) => k === 'all' || k === V.filter || pool.some(f));
  const test = (FILTERS.find(f => f[0] === V.filter) || FILTERS[0])[2];
  const list = pool.filter(test).filter(e => matchQ(entNames(e).concat(e.name)));
  const w = V.walk, st = walkState();
  const pair = cup.entry === 'pair';
  return `<section class="col ${V.phone === 'exp' ? 'hideP' : ''}">
    <div class="colhead"><h2>Here</h2>
      <span class="n">${filtering() ? `${list.length} found in all cups` : pool.filter(FILTERS[0][2]).length}</span></div>
    ${filtering() ? '' : `<form class="walk" id="walkform" autocomplete="off">
      <div class="row">
        <div><label class="l" for="w-name">Walk-in${pair ? ' · player 1' : ''}</label>
          <input type="text" id="w-name" list="dirlist" value="${esc(w.name)}" placeholder="Name   n"></div>
        ${pair ? `<div><label class="l" for="w-partner">Partner</label>
          <input type="text" id="w-partner" list="dirlist" value="${esc(w.seek ? '' : w.partner)}"
            ${w.seek ? 'disabled placeholder="matched automatically"' : 'placeholder="Name"'}></div>` : ''}
        <button class="btn primary" type="submit" id="w-add">${walkButton(st)}</button>
      </div>
      ${pair ? `<label class="chk"><input type="checkbox" id="w-seek" ${w.seek ? 'checked' : ''}>
        No partner yet — match them with the next person looking</label>` : ''}
      <div id="w-msg">${walkMsg(st)}</div>
    </form>
    <datalist id="dirlist">${D.people.map(p => `<option value="${esc(p.name)}">`).join('')}</datalist>`}
    <div class="filters">${shown.map(([k, l, f]) =>
      `<button class="${V.filter === k ? 'on' : ''}${k === 'outside' ? ' warn' : ''}" data-filter="${k}">${l} ${pool.filter(f).length}</button>`).join('')}</div>
    <div class="list">${list.map(e => {
      const [lab, cls] = STATUS[e.status] || [e.status, ''];
      const team = teamName(e);
      return `<div class="card${V.sel && V.sel.ent === e.id ? ' sel' : ''}${['resting', 'withdrawn'].includes(e.status) ? ' faded' : ''}" data-sel-ent="${e.id}">
        <div class="who">${esc(label(entNames(e)))}${team ? `<span class="team">${esc(team)}</span>` : ''}</div>
        <div class="side"><span class="chip ${cls}">${esc(lab)}${e.status === 'playing' && e.table ? ' · T' + e.table : ''}</span></div>
        <div class="meta">${cupChip(e.cup_id)}${e.added_ts ? `<span>in at ${esc(clock(e.added_ts))}</span>` : ''}${
          e.status === 'playing' && e.vs ? `<span>vs ${esc(e.vs)}</span>` : ''}${
          e.registration_id ? '' : '<span>walk-in</span>'}${alsoIn(entNames(e), e.cup_id)}</div>
      </div>`;
    }).join('') || `<div class="empty">${filtering() ? 'Nobody matches.' : 'Nobody in this group.'}</div>`}</div>
  </section>`;
}

/* --------------------------------------------------------------- Detail */

function field(id, lab, value, attrs = '') {
  return `<div><label class="l" for="${id}">${lab}</label>
    <input type="text" id="${id}" value="${esc(value)}" ${attrs}></div>`;
}

function entrantDetail(e, close) {
  const [lab, chip, tip] = STATUS[e.status] || [e.status, '', ''];
  const r = e.registration_id && regById(e.registration_id);
  const pair = e.players.length > 1;
  const cup = cupById(e.cup_id) || {};
  const moves = D.cups.filter(c => c.entry === cup.entry);
  const gone = e.status === 'withdrawn';
  const asking = V.confirm === 'gone:' + e.id;
  return `<div class="top"><h3>${esc(label(entNames(e)))}</h3>${close}</div>
    <div><span class="chip ${chip}">${esc(lab)}${e.status === 'playing' && e.table ? ' · table ' + e.table : ''}</span>
      <span class="small muted"> ${esc(tip)}${e.status === 'playing' && e.vs ? ' Against ' + esc(e.vs) + '.' : ''}</span></div>
    <div class="fields">
      ${e.player_ids.map((pid, i) => field(`e-p-${pid}`, pair ? `Player ${i + 1}` : 'Name', e.players[i],
        `data-edit="player" data-e="${e.id}" data-p="${pid}"`)).join('')}
      ${pair ? field(`e-team-${e.id}`, 'Team name', teamName(e),
        `data-edit="team" data-e="${e.id}" placeholder="optional — otherwise both names"`) : ''}
      ${moves.length > 1 ? `<div><label class="l" for="e-cup-${e.id}">Cup</label>
        <select id="e-cup-${e.id}" data-edit="cup" data-e="${e.id}" ${e.removable ? '' : 'disabled'}>
          ${moves.map(c => `<option value="${c.id}" ${c.id === e.cup_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select></div>` : ''}
    </div>
    ${pair ? '<p class="small muted" style="margin:0">A substitute partner: change the name. Results so far stay with the team.</p>' : ''}
    ${moves.length > 1 && !e.removable ? '<p class="small muted" style="margin:0">Moving cup only works before their first match.</p>' : ''}
    ${asking ? `<div class="confirm"><b>${esc(label(entNames(e)))} ${pair ? 'have' : 'has'} gone home?</b>
        <span>Every match they still owe goes to their opponent${e.status === 'playing' && e.table
          ? `, and table ${e.table} is freed` : ''}. Bring back puts them in the pool again.</span>
        <div class="actions"><button class="btn primary tiny" data-act="gone" data-e="${e.id}">Yes, gone home</button>
          <button class="btn ghost tiny" data-act="unconfirm">Cancel</button></div></div>`
      : `<div class="actions">
        ${gone ? `<button class="btn tiny" data-act="back" data-e="${e.id}">Bring back</button>`
          : e.status === 'resting' ? `<button class="btn tiny" data-act="unrest" data-e="${e.id}">Back in</button>`
          : `<button class="btn tiny" data-act="rest" data-e="${e.id}">Sit out</button>`}
        ${gone ? '' : e.removable
          ? `<button class="btn ghost tiny" data-act="remove" data-e="${e.id}">${r ? 'Undo check-in' : 'Remove'}</button>`
          : `<button class="btn ghost tiny" data-act="gone-ask" data-e="${e.id}">Gone home…</button>`}
      </div>`}
    <dl class="facts">
      <dt>In</dt><dd>${e.added_ts ? 'at ' + esc(clock(e.added_ts)) + ' · ' : ''}${r
        ? 'registered ' + esc(when(r.created_ts)) : 'walk-in'}</dd>
      ${r && r.note ? `<dt>Note</dt><dd>“${esc(r.note)}”</dd>` : ''}
    </dl>
    <p class="small muted" style="margin:0">${gone ? '' : e.removable
      ? (r ? 'Not drawn into a match yet. Undoing the check-in puts their entry back in Expected.'
           : 'Not drawn into a match yet, so removing them leaves no trace.')
      : 'Already drawn into a match, so leaving is “Gone home”, never a silent removal.'}</p>`;
}

function cardDetail(card, close) {
  const here = card.here;
  const k = esc(card.key);
  const doors = !beforeDoors();
  const who = esc(label(card.names)), same = card.names.length > 1 ? 'team' : 'person';
  const n = card.regs.length;
  const where = here ? `in at ${esc(clock(here.added_ts))}${D.cups.length > 1 ? ' · ' + esc(cupName(here.cup_id)) : ''}` : '';
  const pick = card.stack && !card.leftover;
  const chosen = pickedReg(card);
  return `<div class="top"><h3>${who}</h3>${close}</div>
    <div class="kv">${esc(cupName(card.cup))} · ${card.matched
      ? 'two people who were looking for a partner, matched automatically'
      : card.seeking ? 'looking for a partner — matched with the next person who is'
      : n > 1 ? `${n} entries with these names` : card.regs[0].kind === 'pair' ? 'a team' : 'one entry'}</div>
    ${card.leftover ? `<div class="confirm warn"><span><b>${who}</b> ${here.players.length > 1 ? 'are' : 'is'} already here, ${where}.
        Is ${n > 1 ? 'what is left here' : 'this entry'} the same ${same}, sent twice, or another ${same} with the same names?</span>
      <div class="actions">
        <button class="btn tiny" data-act="dup" data-k="${k}">Same ${same} — clear it</button>
        <button class="btn tiny" data-act="distinct" data-k="${k}">Different ${same} — keep it</button>
        <button class="btn ghost tiny" data-sel-ent="${here.id}">Show</button>
      </div></div>` : ''}
    ${card.distinct && here && doors ? `<div class="confirm warn"><span>Another <b>${who}</b> is already here, ${where}.
        This entry was kept as a separate ${same}, so it goes in under a name that tells them apart.</span>
      <div class="actions">
        <button class="btn primary tiny" data-act="checkin-as" data-k="${k}">Check in as “${esc(freeName(card.names[0]))}”</button>
        <button class="btn tiny" data-act="dup" data-k="${k}">Same ${same} after all — clear it</button>
        <button class="btn ghost tiny" data-sel-ent="${here.id}">Show</button>
      </div></div>` : ''}
    <div class="entries">${card.regs.map(r => `<div class="entry${pick && r.id === chosen.id ? ' chosen' : ''}">
      ${pick ? `<label class="pick"><input type="radio" name="pick-${k}" data-pick="${k}" value="${r.id}"
        ${r.id === chosen.id ? 'checked' : ''}> Use this entry</label>` : ''}
      <div class="fields">
        ${field(`r-n-${r.id}`, r.kind === 'pair' ? 'Player 1' : 'Name', r.name, `data-edit="reg" data-f="name" data-r="${r.id}"`)}
        ${r.kind === 'pair' ? field(`r-p-${r.id}`, 'Partner', r.partner_name, `data-edit="reg" data-f="partner_name" data-r="${r.id}"`)
          + field(`r-t-${r.id}`, 'Team name', r.team_name, `data-edit="reg" data-f="team_name" data-r="${r.id}" placeholder="optional"`) : ''}
      </div>
      <div class="erow"><span class="t">sent ${esc(when(r.created_ts))}${r.kind === 'seeking' ? ' · looking for a partner' : ''}</span>
        <button class="btn ghost tiny" data-act="drop-one" data-r="${r.id}">${doors ? 'No show' : 'Remove'}</button></div>
      ${r.note ? `<span class="nt">“${esc(r.note)}”</span>` : ''}
    </div>`).join('')}</div>
    ${pick ? `<p class="small muted" style="margin:0">Checking in uses the entry picked above — the newest
      unless you choose another, because a second entry is usually the correction. The other${n > 2 ? 's stay' : ' stays'}
      here, marked, until you say whether ${n > 2 ? 'they are' : 'it is'} the same ${same}.</p>` : ''}
    ${hintsFor(card).map(h => `<p class="small muted" style="margin:0">${esc(h)}</p>`).join('')}
    ${card.seeking ? '<p class="small muted" style="margin:0">The next person looking for a partner in this cup is matched with them automatically. Then they check in together as one team.</p>' : ''}
    ${doors && !card.seeking && !here ? `<div class="actions"><button class="btn primary" data-act="checkin" data-k="${k}">Check in${card.matched ? ' as a team' : ''}</button></div>` : ''}
    ${doors ? '' : '<p class="small muted" style="margin:0">Check-in opens with the doors.</p>'}`;
}

function renderDetail() {
  const cls = `col detailcol${V.sel ? ' open' : ''}`;
  const close = '<button class="btn ghost tiny closeD" data-close="1">Close</button>';
  let inner = '';
  if (V.sel && V.sel.ent) { const e = entById(V.sel.ent); if (e) inner = entrantDetail(e, close); }
  if (V.sel && V.sel.key) { const c = cardByKey(V.sel.key); if (c) inner = cardDetail(c, close); }
  if (!inner) {
    V.sel = null;
    inner = `<p class="small muted" style="margin:0">Click anyone to see and change their details here.
      The lists keep updating while this stays put.</p>
      <div><div class="sub" style="padding:0 0 6px">Activity</div>
        ${D.activity.length ? `<ul class="log">${D.activity.slice(0, 12).map(l =>
          `<li><span>${esc(clock(l.ts))}</span><b>${esc(l.by || '')}</b><span>${esc(l.text)}</span></li>`).join('')}</ul>`
          : '<p class="small muted" style="margin:0">Nothing yet.</p>'}</div>
      <div><div class="sub" style="padding:0 0 6px">Keys</div>
        <div class="keys"><kbd>/</kbd><span>filter every cup</span><kbd>n</kbd><span>new walk-in</span>
          <kbd>↑ ↓</kbd><span>move through Expected</span><kbd>Enter</kbd><span>check in the highlighted entry</span>
          <kbd>Esc</kbd><span>clear the filter, close details</span></div></div>`;
  }
  return `<aside class="${cls}"><div class="detail">${inner}</div></aside>`;
}

/* ------------------------------------------------------------ directory */

function renderDir() {
  const q = nk(V.dirQ);
  const list = D.people.filter(p => !q || nk(p.name).includes(q));
  const admin = D.role === 'admin';
  const row = p => {
    let add = '';
    if (!p.playing && !beforeDoors()) add = V.dirAdd === p.id
      ? D.cups.map(c => `<button class="btn tiny" data-act="dir-add" data-p="${p.id}" data-c="${c.id}">${esc(c.name)}</button>`).join(' ')
        + ' <button class="btn ghost tiny" data-act="dir-cancel">Cancel</button>'
      : `<button class="btn tiny" data-act="dir-pick" data-p="${p.id}">Add to tonight…</button>`;
    const forget = !admin ? '' : V.confirm === 'forget:' + p.id
      ? `<span class="small">Forget ${esc(p.name)}? Tonight is untouched.</span>
         <button class="btn primary tiny" data-act="forget" data-p="${p.id}">Forget</button>
         <button class="btn ghost tiny" data-act="unconfirm">Cancel</button>`
      : `<button class="btn ghost tiny" data-act="forget-ask" data-p="${p.id}">Forget</button>`;
    return `<div class="r"><b>${esc(p.name)}</b>${p.playing ? '<span class="chip hot">here tonight</span>' : ''}
      <span class="push"></span>${add}${forget}</div>`;
  };
  return `<div class="dir"><div class="panel">
    <div style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap">
      <div style="flex:1 1 240px;max-width:340px"><input type="search" id="dir-q" value="${esc(V.dirQ)}"
        placeholder="Search by name" aria-label="Search the directory" autocomplete="off"></div>
      <p class="small muted" style="margin:0;flex:1 1 260px">Everyone the club has seen. This outlives
        the event: a new event clears tonight, never this list.${admin ? '' : ' The door link can add people from here but not remove them.'}</p>
    </div>
    <div class="rows">${list.slice(0, 200).map(row).join('')
      || `<div class="empty">${D.people.length ? 'Nobody by that name.' : 'Empty until somebody is checked in — everyone who is gets remembered.'}</div>`}</div>
    ${list.length > 200 ? `<p class="small muted" style="margin:0">…and ${list.length - 200} more. Narrow the search.</p>` : ''}
  </div></div>`;
}

/* --------------------------------------------------------------- render */

function render() {
  if (!D) return;
  const act = document.activeElement && document.activeElement.id;
  const caret = act && document.activeElement.selectionStart;
  const pending = D.registrations.filter(r => r.status === 'pending').length;
  const here = D.entrants.filter(e => e.status !== 'withdrawn').length;
  const playing = D.entrants.filter(e => e.status === 'playing').length;
  const phaseLine = {
    announced: 'Announced', registration: 'Sign-ups open', doors: 'Doors open', live: 'Running', done: 'Finished',
  }[D.phase] || D.phase;
  const counts = c => {
    const p = cardsFor(c.id);
    const n = D.entrants.filter(e => e.cup_id === c.id && e.status !== 'withdrawn').length;
    return `${p.cards.length + p.seekers.length} expected${beforeDoors() ? '' : ` · ${n} here`}`;
  };
  document.title = `Desk · ${D.event.name || 'Table tennis'}`;
  const head = `<header class="bar">
      <span class="word">TTT</span>
      <div><h1>${esc(D.event.name || 'Table tennis')}</h1><div class="phase">${esc(phaseLine)}</div></div>
      <div class="tally"><span><b>${pending}</b> entries expected</span>${beforeDoors() ? ''
        : `<span><b>${here}</b> here</span><span class="live"><b>${playing}</b> playing</span>`}</div>
      <div class="right"><span class="role ${D.role}">${D.role === 'door' ? 'Door' : 'Admin'}</span>
        <a class="btn ghost tiny" href="${CONSOLE.href}${SIMQ}" target="_blank">${CONSOLE.label}</a>
        <span id="pulse" class="pulse on" title="live"></span></div>
    </header>
    <nav class="nav">
      ${D.cups.map(c => `<button class="${V.view === 'desk' && V.cup === c.id ? 'on' : ''}" data-cup="${c.id}">${esc(c.name)} <span class="n">${counts(c)}</span></button>`).join('')}
      <button class="${V.view === 'dir' ? 'on' : ''}" data-dir="1">Club directory <span class="n">${D.people.length}</span></button>
      <span class="sp"></span>
      ${V.view === 'desk' ? `<label class="search"><span class="muted small">Filter</span><input type="search" id="q"
        value="${esc(V.q)}" placeholder="Name, partner or team   /" autocomplete="off"></label>` : ''}
    </nav>`;
  let body;
  if (!D.cups.length) body = `<p class="fatal">No cups yet. Set the event up in the console first.</p>`;
  else if (V.view === 'dir') body = renderDir();
  else body = `
    <div class="phoneSeg"><button class="${V.phone === 'exp' ? 'on' : ''}" data-phone="exp">Expected</button><button class="${V.phone === 'here' ? 'on' : ''}" data-phone="here">Here</button></div>
    <div class="desk">${renderExpected()}${renderHere()}${renderDetail()}</div>`;
  $('app').innerHTML = head + body;
  if (act && $(act) && !$(act).disabled) {
    $(act).focus();
    try { $(act).setSelectionRange(caret, caret); } catch (e) { }
  }
}

/* -------------------------------------------------------------- actions */

async function checkIn(card, asName) {
  const r = pickedReg(card);
  const data = { registration_id: r.id };
  if (asName) data.name = asName;
  const out = await api('admit', data);
  if (!out) return;
  // a stack keeps its other entries, now marked: keep them in view. The card
  // is keyed by its oldest entry, which may be the one that just went in.
  if (V.sel && V.sel.key === card.key)
    V.sel = card.stack ? { key: card.regs.find(x => x.id !== r.id).id } : null;
  V.kb = -1;
  const names = card.matched ? card.names : regNames(r);
  const who = asName ? label([asName, ...names.slice(1)]) : label(names);
  toast(out.where === 'roster' ? `${who} checked in, but ${out.why}.` : `${who} checked in`,
    () => api('remove_entrant', { id: out.entrant_id }));
}

async function dropRegs(regs, what, status = 'dropped') {
  const done = [];
  for (const r of regs) if (await api('update_registration', { id: r.id, status })) done.push(r.id);
  if (!done.length) return;
  if (V.sel && regs.some(r => V.sel.key === r.id)) V.sel = null;
  toast(`${what} the list`, async () => {
    for (const id of done) await api('update_registration', { id, status: 'pending' });
  });
}

async function checkInAll() {
  const cards = readyCards(V.cup);
  V.confirm = '';
  const ids = [];
  let roster = 0, why = '';
  for (const c of cards) {
    const out = await api('admit', { registration_id: pickedReg(c).id });
    if (out) { ids.push(out.entrant_id); if (out.where === 'roster') { roster++; why = out.why; } }
  }
  if (!ids.length) return;
  toast(`${ids.length} checked in${roster ? ` — ${roster} of them are not in a draw: ${why}` : ''}`,
    async () => { for (const id of ids) await api('remove_entrant', { id }); });
}

async function walkIn() {
  const w = V.walk, cup = cupById(V.cup) || {};
  const st = walkState();
  if (!nk(w.name)) return toast('Who is it? Type a name first.');
  if (cup.entry === 'pair' && !w.seek && !nk(w.partner)) return toast('Who is the partner? Or tick “No partner yet”.');
  if (w.seek) {
    const out = await api('add_registration', { cup_id: V.cup, name: w.name.trim() });
    if (!out) return;
    toast(out.matched_with ? `${w.name.trim()} matched with ${out.matched_with} — check them in together from Expected`
      : `${w.name.trim()} is waiting for a partner`,
      () => api('update_registration', { id: out.registration_id, status: 'dropped' }));
  } else {
    const names = st.names.map(n => n.trim());
    if (st.here) names[0] = st.as;
    const p0 = personNamed(names[0]), p1 = names[1] && personNamed(names[1]);
    const out = await api('admit', {
      cup_id: V.cup, kind: names.length > 1 ? 'pair' : 'single',
      name: names[0], partner_name: names[1] || '',
      person_id: p0 ? p0.id : undefined, partner_person_id: p1 ? p1.id : undefined,
    });
    if (!out) return;
    toast(out.where === 'roster' ? `${label(names)} added, but ${out.why}.` : `${label(names)} added`,
      () => api('remove_entrant', { id: out.entrant_id }));
  }
  V.walk = { name: '', partner: '', seek: false };
  render();
  const n = $('w-name'); if (n) n.focus();
}

/* Taking somebody out who has not played. Undo brings them back the way
   they came: their entry checked in again, or the same walk-in re-added. */
async function removeEntrant(e) {
  const out = await api('remove_entrant', { id: e.id });
  if (!out) return;
  V.sel = null;
  const r = e.registration_id && regById(e.registration_id);
  toast(r ? `${label(entNames(e))} back in Expected` : `${label(entNames(e))} removed`, r
    ? () => api('admit', { registration_id: r.id })
    : () => api('admit', { cup_id: e.cup_id, kind: e.players.length > 1 ? 'pair' : 'single',
        name: e.players[0] || e.name, partner_name: e.players[1] || '', team_name: teamName(e) }));
}

async function edit(el) {
  const v = el.value.trim();
  const e = el.dataset.e && entById(el.dataset.e);
  if (el.dataset.edit === 'player' && e) {
    const i = e.player_ids.indexOf(el.dataset.p), old = e.players[i];
    if (!v || v === old) { el.value = old; return; }
    if (await api('update_player', { id: el.dataset.p, name: v }))
      toast(`Renamed ${old} → ${v}`, () => api('update_player', { id: el.dataset.p, name: old }));
  } else if (el.dataset.edit === 'team' && e) {
    const old = e.name, now = v || e.players.join(' / ');
    if (now === old) return;
    if (await api('update_entrant', { id: e.id, name: now }))
      toast(v ? `Team name: ${v}` : 'Team name cleared', () => api('update_entrant', { id: e.id, name: old }));
  } else if (el.dataset.edit === 'cup' && e) {
    const old = e.cup_id;
    if (await api('update_entrant', { id: e.id, cup_id: el.value })) {
      V.sel = null;
      toast(`${label(entNames(e))} moved to ${cupName(el.value)}`, () => api('update_entrant', { id: e.id, cup_id: old }));
    }
  } else if (el.dataset.edit === 'reg') {
    const r = regById(el.dataset.r), f = el.dataset.f, old = r ? r[f] || '' : '';
    if (!r || v === old || (f === 'name' && !v)) { el.value = old; return; }
    if (await api('update_registration', { id: r.id, [f]: v }))
      toast('Entry updated', () => api('update_registration', { id: r.id, [f]: old }));
  }
}

/* --------------------------------------------------------------- events */

document.addEventListener('click', async ev => {
  const t = ev.target;
  if (t.closest('[data-undo]')) {
    const u = toastUndo; $('toast').hidden = true; toastUndo = null;
    if (u) { await u(); toast('Undone'); }
    return;
  }
  const a = t.closest('[data-act]');
  if (a) {
    ev.stopPropagation();
    const d = a.dataset, act = d.act;
    const card = d.k && cardByKey(d.k), e = d.e && entById(d.e);
    if (act === 'checkin' && card) {
      // "check in the registration instead" from the walk-in form: the draft is done with
      if (a.closest('#w-msg')) V.walk = { name: '', partner: '', seek: false };
      if (clashFor(card.cup, card.names)) { V.sel = { key: card.key }; return render(); }
      return checkIn(card);
    }
    if (act === 'checkin-as' && card) return checkIn(card, freeName(card.names[0]));
    if (act === 'drop' && card) return dropRegs(card.regs, `${label(card.names)} taken off`);
    if (act === 'dup' && card)
      return dropRegs(card.regs, `${label(card.names)} cleared as a duplicate — taken off`, 'duplicate');
    if (act === 'distinct' && card) {
      const done = [];
      for (const r of card.regs) if (await api('update_registration', { id: r.id, distinct: true })) done.push(r.id);
      if (done.length) toast(`${label(card.names)} kept as a separate ${card.names.length > 1 ? 'team' : 'person'}`,
        async () => { for (const id of done) await api('update_registration', { id, distinct: false }); });
      return;
    }
    if (act === 'drop-one') { const r = regById(d.r); return r && dropRegs([r], `${label(regNames(r))} taken off`); }
    if (act === 'putback') {
      const r = regById(d.r);
      if (r && await api('update_registration', { id: r.id, status: 'pending' }))
        toast(`${label(regNames(r))} is back in ${beforeDoors() ? 'Registered' : 'Expected'}`,
          () => api('update_registration', { id: r.id, status: 'dropped' }));
      return;
    }
    if (act === 'all-ask') { V.confirm = 'all:' + V.cup; return render(); }
    if (act === 'all-go') return checkInAll();
    if (act === 'unconfirm') { V.confirm = ''; return render(); }
    if (act === 'rest' && e) {
      if (await api('set_resting', { entrant_id: e.id, resting: true }))
        toast(`${label(entNames(e))} sits out`, () => api('set_resting', { entrant_id: e.id, resting: false }));
      return;
    }
    if (act === 'unrest' && e) {
      if (await api('set_resting', { entrant_id: e.id, resting: false }))
        toast(`${label(entNames(e))} back in`, () => api('set_resting', { entrant_id: e.id, resting: true }));
      return;
    }
    if (act === 'gone-ask' && e) { V.confirm = 'gone:' + e.id; return render(); }
    if (act === 'gone' && e) {
      V.confirm = '';
      const out = await api('withdraw', { entrant_id: e.id, withdrawn: true });
      if (out) toast(`${label(entNames(e))} gone home${out.walkovers ? ` · ${out.walkovers} match${out.walkovers === 1 ? '' : 'es'} given to the opponent` : ''}`);
      return;
    }
    if (act === 'back' && e) {
      if (await api('withdraw', { entrant_id: e.id, withdrawn: false })) toast(`${label(entNames(e))} is back`);
      return;
    }
    if (act === 'remove' && e) return removeEntrant(e);
    if (act === 'dir-pick') { V.dirAdd = d.p; return render(); }
    if (act === 'dir-cancel') { V.dirAdd = ''; return render(); }
    if (act === 'dir-add') {
      const p = D.people.find(x => x.id === d.p), cup = cupById(d.c);
      V.dirAdd = '';
      if (!p || !cup) return;
      if (cup.entry === 'pair') {
        // a team needs a partner: take them to that cup's walk-in with the name in
        V.view = 'desk'; V.cup = cup.id; V.walk = { name: p.name, partner: '', seek: false };
        render(); const f = $('w-partner'); if (f) f.focus();
        return;
      }
      const out = await api('add_from_directory', { person_id: p.id, cup_id: cup.id });
      if (out) toast(out.where === 'roster' ? `${p.name} added to ${cup.name}, but ${out.why}.` : `${p.name} added to ${cup.name}`,
        () => api('remove_entrant', { id: out.entrant_id }));
      return;
    }
    if (act === 'forget-ask') { V.confirm = 'forget:' + d.p; return render(); }
    if (act === 'forget') {
      V.confirm = '';
      const p = D.people.find(x => x.id === d.p);
      if (await api('remove_person', { id: d.p })) toast(`Forgot ${p ? p.name : 'them'}`);
      return;
    }
    return;
  }
  const b = t.closest('[data-cup],[data-dir],[data-phone],[data-filter],[data-close],[data-sel-reg],[data-sel-ent]');
  if (!b || t.closest('input,select,label')) return;
  if (b.dataset.cup) {
    V.view = 'desk'; V.cup = b.dataset.cup; V.sel = null; V.kb = -1; V.confirm = '';
    V.walk = { name: '', partner: '', seek: false };
    try { localStorage.setItem('tt_desk_cup', V.cup); } catch (e) { }
  }
  else if (b.dataset.dir) { V.view = 'dir'; V.sel = null; }
  else if (b.dataset.phone) V.phone = b.dataset.phone;
  else if (b.dataset.filter) V.filter = b.dataset.filter;
  else if (b.dataset.close) V.sel = null;
  else if (b.dataset.selReg) {
    V.sel = { key: b.dataset.selReg }; V.confirm = '';
    V.kb = (V._cards || []).findIndex(c => c.key === b.dataset.selReg);
  }
  else if (b.dataset.selEnt) { V.sel = { ent: b.dataset.selEnt }; V.confirm = ''; V.phone = 'here'; }
  render();
});

document.addEventListener('toggle', ev => { if (ev.target.id === 'resolved') V.openRes = ev.target.open; }, true);
document.addEventListener('input', ev => {
  const t = ev.target;
  if (t.id === 'q') { V.q = t.value; V.kb = -1; render(); }
  else if (t.id === 'dir-q') { V.dirQ = t.value; render(); }
  else if (t.id === 'w-name' || t.id === 'w-partner') {
    V.walk[t.id === 'w-name' ? 'name' : 'partner'] = t.value;
    // only the message and the button change; the inputs stay under the cursor
    const st = walkState();
    $('w-msg').innerHTML = walkMsg(st);
    $('w-add').innerHTML = walkButton(st);
  }
});
document.addEventListener('change', ev => {
  const t = ev.target;
  if (t.dataset.pick) { V.pick[t.dataset.pick] = t.value; render(); return; }
  if (t.id === 'w-seek') { V.walk.seek = t.checked; render(); const n = $('w-name'); if (n) n.focus(); return; }
  if (t.dataset.edit) edit(t);
});
document.addEventListener('submit', ev => {
  if (ev.target.id !== 'walkform') return;
  ev.preventDefault();
  walkIn();
});
document.addEventListener('keydown', ev => {
  if (!D || V.view !== 'desk') return;
  const el = document.activeElement || {};
  const typing = /INPUT|TEXTAREA|SELECT/.test(el.tagName || '');
  if (ev.key === 'Escape') {
    if (typing && el.id === 'q') V.q = '';
    if (typing) el.blur();
    V.sel = null; V.kb = -1; V.confirm = ''; render(); return;
  }
  if (typing) {
    // Enter in a detail field saves it, the way leaving the field does
    if (ev.key === 'Enter' && el.dataset && el.dataset.edit) { ev.preventDefault(); el.blur(); }
    return;
  }
  if (ev.key === '/') { ev.preventDefault(); const q = $('q'); if (q) q.focus(); }
  else if (ev.key === 'n' && !beforeDoors()) { ev.preventDefault(); V.phone = 'here'; render(); const n = $('w-name'); if (n) n.focus(); }
  else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    const cards = V._cards || [];
    if (!cards.length) return;
    ev.preventDefault();
    V.kb = ev.key === 'ArrowDown' ? Math.min(cards.length - 1, V.kb + 1) : Math.max(0, V.kb - 1);
    V.sel = { key: cards[V.kb].key };
    render();
    const c = document.querySelector('.card.sel');
    if (c) c.scrollIntoView({ block: 'nearest' });
  }
  else if (ev.key === 'Enter' && V.sel && V.sel.key && !beforeDoors()) {
    const card = cardByKey(V.sel.key);
    if (!card || card.seeking) return;
    ev.preventDefault();
    if (clashFor(card.cup, card.names)) return;     // the panel is already asking
    const next = (V._cards || [])[V.kb + 1];
    checkIn(card).then(() => {
      if (!next) return;
      V.sel = { key: next.key }; render();
      V.kb = (V._cards || []).findIndex(c => c.key === next.key);
    });
  }
});

load().then(listen);
