/* The registration desk — see docs/registration-desk.md.

   Its own page and its own payload (/api/desk), so it redraws when somebody
   is checked in and not every time a point is scored. This first version
   only shows: who is expected, who is here and where each of them is right
   now, across every cup. Checking in and changing people from here comes
   next; until then that happens in the console's Door tab. */

const PATH = location.pathname.match(/^\/([ad])\/([^/]+)\/desk$/) || [];
const TOKEN = PATH[2] || '';
const CONSOLE = PATH[1] ? `/${PATH[1]}/${TOKEN}` : '/';
// the sandbox tab is the same desk pointed at a throwaway event
const SIMQ = new URLSearchParams(location.search).get('sim') === '1' ? '?sim=1' : '';

let D = null;              // last payload
let etag = '';
const V = {                // what this viewer is looking at; never sent anywhere
  view: 'desk', cup: '', q: '', filter: 'all', sel: null, phone: 'exp',
  kb: -1, dirQ: '',
};
try { V.cup = localStorage.getItem('tt_desk_cup') || ''; } catch (e) { }

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// the server's Store.name_key: case and stray spaces never make two people
const nk = s => String(s || '').trim().split(/\s+/).join(' ').toLowerCase();

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
    render();
  } catch (e) { /* offline for a moment; the next nudge tries again */ }
}

function fatal(msg) {
  D = null;
  $('app').innerHTML = `<p class="fatal"><b>${esc(msg)}</b></p>`;
  if (stream) stream.close();
}

let stream = null, poll = 0;
function listen() {
  // the stream says "something changed"; the ETag makes asking cheap when
  // what changed was only a score
  try {
    stream = new EventSource('/api/stream' + SIMQ);
    stream.onmessage = () => { pulse(true); load(); };
    stream.onerror = () => pulse(false);
  } catch (e) { }
  poll = setInterval(load, 15000);
}
function pulse(on) { const p = $('pulse'); if (p) p.classList.toggle('on', on); }

/* --------------------------------------------------------------- helpers */

const cupById = id => D.cups.find(c => c.id === id);
const cupName = id => (cupById(id) || {}).name || '';
const regById = id => D.registrations.find(r => r.id === id);
const regNames = r => [r.name, r.partner_name].filter(Boolean);
const label = names => names.filter(Boolean).join(' & ');
const entNames = e => e.players.length ? e.players : [e.name];
// a team name somebody chose, as opposed to the two names joined up
const teamName = e => e.players.length > 1 && ![label(e.players), e.players.join(' / ')]
  .some(n => nk(n) === nk(e.name)) ? e.name : '';
const beforeDoors = () => D.phase === 'announced' || D.phase === 'registration';

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

/* ------------------------------------------------------------- Expected */

/* A matched pair of people looking for a partner is one team and one card.
   Anybody still looking has their own section. Everyone else is one card
   per entry; grouping the duplicates behind one card comes with step 4. */
function cardsFor(cup) {
  const pend = D.registrations.filter(r => r.cup_id === cup && r.status === 'pending');
  const seen = new Set(), cards = [], seekers = [];
  for (const r of pend) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const mate = r.matched_with && pend.find(x => x.id === r.matched_with);
    if (mate) { seen.add(mate.id); cards.push({ key: r.id, cup, regs: [r, mate], names: [r.name, mate.name], matched: true }); }
    else if (r.kind === 'seeking') seekers.push({ key: r.id, cup, regs: [r], names: [r.name], seeking: true });
    else cards.push({ key: r.id, cup, regs: [r], names: regNames(r) });
  }
  return { cards, seekers };
}

function twice(card) {
  const r = card.regs[0];
  return !card.matched && D.registrations.some(o => o.id !== r.id && o.status === 'pending'
    && o.cup_id === r.cup_id && nk(o.name) === nk(r.name));
}

function cardHTML(card) {
  const r = card.regs[0];
  const team = card.regs.map(x => x.team_name).find(Boolean);
  const note = card.regs.map(x => x.note).filter(Boolean).pop();
  const sel = V.sel && V.sel.key === card.key ? ' sel' : '';
  const chips = [
    cupChip(card.cup),
    card.matched ? '<span class="chip dark">matched as partners</span>' : '',
    card.seeking ? '<span class="chip">looking for a partner</span>' : '',
    twice(card) ? '<span class="chip warn">registered twice</span>' : '',
    alsoIn(card.names, card.cup),
    `<span>${esc(when(r.created_ts))}</span>`,
  ].filter(Boolean).join('');
  return `<div class="card${sel}" data-sel-reg="${esc(card.key)}" tabindex="-1">
    <div class="who">${esc(label(card.names))}${team ? `<span class="team">${esc(team)}</span>` : ''}</div>
    <div class="side"></div>
    <div class="meta">${chips}</div>
    ${note ? `<div class="note">“${esc(note)}”</div>` : ''}
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
  const gone = D.registrations.filter(r => cups.includes(r.cup_id) && r.status === 'dropped'
    && matchQ(regNames(r)));
  return `<section class="col ${V.phone === 'here' ? 'hideP' : ''}">
    <div class="colhead"><h2>${beforeDoors() ? 'Registered' : 'Expected'}</h2>
      <span class="n">${filtering() ? `${cards.length} found in all cups` : total}</span></div>
    <div class="list">${cards.map(cardHTML).join('')
      || `<div class="empty">${filtering() ? 'Nobody matches.' : beforeDoors()
        ? 'No entries yet.' : 'Nobody left to expect.'}</div>`}</div>
    ${pair ? `<div class="sub">Looking for a partner <span class="chip dim">matched automatically</span></div>
      <div class="list">${seekers.map(cardHTML).join('') || '<div class="empty">Nobody waiting for a partner.</div>'}</div>` : ''}
    <details class="resolved" id="resolved"${V.openRes ? ' open' : ''}><summary>Taken off the list · ${gone.length}</summary>
      ${gone.length ? `<ul>${gone.map(r => `<li>${cupChip(r.cup_id)} <b>${esc(label(regNames(r)))}</b> · sent ${esc(when(r.created_ts))}</li>`).join('')}</ul>`
        : '<p style="margin:8px 0 0">Nothing yet. No-shows and removed entries land here.</p>'}
    </details>
  </section>`;
}

/* ----------------------------------------------------------------- Here */

function renderHere() {
  if (beforeDoors()) return `<section class="col ${V.phone === 'exp' ? 'hideP' : ''}">
    <div class="colhead"><h2>Here</h2></div>
    <div class="empty">Check-in opens with the doors. Until then this list stays empty, and
      nothing on the left reaches a draw.</div></section>`;
  const pool = D.entrants.filter(e => filtering() || e.cup_id === V.cup);
  const shown = FILTERS.filter(([k, , f]) => k === 'all' || k === V.filter || pool.some(f));
  const test = (FILTERS.find(f => f[0] === V.filter) || FILTERS[0])[2];
  const list = pool.filter(test).filter(e => matchQ(entNames(e).concat(e.name)));
  return `<section class="col ${V.phone === 'exp' ? 'hideP' : ''}">
    <div class="colhead"><h2>Here</h2>
      <span class="n">${filtering() ? `${list.length} found in all cups` : pool.filter(FILTERS[0][2]).length}</span></div>
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

const SOON = `<div class="soon">Checking in and changing people from here comes in the next
  update. Until then use the console: <a href="${CONSOLE}" target="_blank">Door tab ↗</a></div>`;

function renderDetail() {
  const open = !!V.sel;
  const cls = `col detailcol${open ? ' open' : ''}`;
  const close = '<button class="btn ghost tiny closeD" data-close="1">Close</button>';
  if (V.sel && V.sel.ent) {
    const e = D.entrants.find(x => x.id === V.sel.ent);
    if (e) {
      const [lab, chip, tip] = STATUS[e.status] || [e.status, '', ''];
      const r = e.registration_id && regById(e.registration_id);
      const team = teamName(e);
      return `<aside class="${cls}"><div class="detail">
        <div class="top"><h3>${esc(label(entNames(e)))}</h3>${close}</div>
        <div><span class="chip ${chip}">${esc(lab)}${e.status === 'playing' && e.table ? ' · table ' + e.table : ''}</span>
          <span class="small muted"> ${esc(tip)}</span></div>
        <dl class="facts">
          ${team ? `<dt>Team</dt><dd>${esc(team)}</dd>` : ''}
          <dt>Cup</dt><dd>${esc(cupName(e.cup_id) || 'not in a cup')}</dd>
          ${e.status === 'playing' && e.vs ? `<dt>Against</dt><dd>${esc(e.vs)}</dd>` : ''}
          <dt>In</dt><dd>${e.added_ts ? 'at ' + esc(clock(e.added_ts)) + ' · ' : ''}${r
            ? 'registered ' + esc(when(r.created_ts)) : 'walk-in'}</dd>
          ${r && r.note ? `<dt>Note</dt><dd>“${esc(r.note)}”</dd>` : ''}
        </dl>
        <p class="small muted" style="margin:0">${e.removable
          ? 'Not drawn into a match yet, so they can still be taken out without a trace.'
          : 'Already drawn into a match, so leaving is “Gone home”: what they still owe goes to their opponent.'}</p>
        ${SOON}
      </div></aside>`;
    }
  }
  if (V.sel && V.sel.key) {
    const card = allCards().find(c => c.key === V.sel.key);
    if (card) return `<aside class="${cls}"><div class="detail">
      <div class="top"><h3>${esc(label(card.names))}</h3>${close}</div>
      <div class="kv">${esc(cupName(card.cup))} · ${card.matched
        ? 'two people who were looking for a partner, matched automatically'
        : card.seeking ? 'looking for a partner — matched with the next person who is'
        : card.regs[0].kind === 'pair' ? 'a team' : 'one entry'}</div>
      <div class="entries">${card.regs.map(r => `<div class="entry">
        <b>${esc(label(regNames(r)))}${r.team_name ? ` · ${esc(r.team_name)}` : ''}</b>
        <span class="t">sent ${esc(when(r.created_ts))}${r.kind === 'seeking' ? ' · looking for a partner' : ''}</span>
        ${r.note ? `<span class="nt">“${esc(r.note)}”</span>` : ''}
      </div>`).join('')}</div>
      ${twice(card) ? '<p class="small muted" style="margin:0">Somebody with this name sent another entry to this cup. Usually one of the two is a correction.</p>' : ''}
      ${SOON}
    </div></aside>`;
  }
  V.sel = null;
  return `<aside class="${cls}"><div class="detail">
    <p class="small muted" style="margin:0">Click anyone to see their details here. The lists keep updating while this stays put.</p>
    <div><div class="sub" style="padding:0 0 6px">Activity</div>
      ${D.activity.length ? `<ul class="log">${D.activity.slice(0, 12).map(l =>
        `<li><span>${esc(clock(l.ts))}</span><b>${esc(l.by || '')}</b><span>${esc(l.text)}</span></li>`).join('')}</ul>`
        : '<p class="small muted" style="margin:0">Nothing yet.</p>'}</div>
    <div><div class="sub" style="padding:0 0 6px">Keys</div>
      <div class="keys"><kbd>/</kbd><span>filter every cup</span><kbd>↑ ↓</kbd><span>move through Expected</span>
        <kbd>Esc</kbd><span>clear the filter, close details</span></div></div>
  </div></aside>`;
}

const allCards = () => D.cups.flatMap(c => { const p = cardsFor(c.id); return p.cards.concat(p.seekers); });

/* ------------------------------------------------------------ directory */

function renderDir() {
  const q = nk(V.dirQ);
  const list = D.people.filter(p => !q || nk(p.name).includes(q));
  return `<div class="dir"><div class="panel">
    <div style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap">
      <div style="flex:1 1 240px;max-width:340px"><input type="search" id="dir-q" value="${esc(V.dirQ)}"
        placeholder="Search by name" aria-label="Search the directory" autocomplete="off"></div>
      <p class="small muted" style="margin:0;flex:1 1 260px">Everyone the club has seen. This outlives
        the event: a new event clears tonight, never this list.</p>
    </div>
    <div class="rows">${list.slice(0, 200).map(p => `<div class="r"><b>${esc(p.name)}</b>${
      p.playing ? '<span class="chip hot">here tonight</span>' : ''}</div>`).join('')
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
        <a class="btn ghost tiny" href="${CONSOLE}${SIMQ}" target="_blank">Console ↗</a>
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
  if (act && $(act)) {
    $(act).focus();
    try { $(act).setSelectionRange(caret, caret); } catch (e) { }
  }
}

/* --------------------------------------------------------------- events */

document.addEventListener('click', ev => {
  const t = ev.target;
  const b = t.closest('[data-cup],[data-dir],[data-phone],[data-filter],[data-close],[data-sel-reg],[data-sel-ent]');
  if (!b) return;
  if (b.dataset.cup) {
    V.view = 'desk'; V.cup = b.dataset.cup; V.sel = null; V.kb = -1;
    try { localStorage.setItem('tt_desk_cup', V.cup); } catch (e) { }
  }
  else if (b.dataset.dir) { V.view = 'dir'; V.sel = null; }
  else if (b.dataset.phone) V.phone = b.dataset.phone;
  else if (b.dataset.filter) V.filter = b.dataset.filter;
  else if (b.dataset.close) V.sel = null;
  else if (b.dataset.selReg) { V.sel = { key: b.dataset.selReg }; V.kb = (V._cards || []).findIndex(c => c.key === b.dataset.selReg); }
  else if (b.dataset.selEnt) V.sel = { ent: b.dataset.selEnt };
  render();
});
document.addEventListener('toggle', ev => { if (ev.target.id === 'resolved') V.openRes = ev.target.open; }, true);
document.addEventListener('input', ev => {
  if (ev.target.id === 'q') { V.q = ev.target.value; V.kb = -1; render(); }
  else if (ev.target.id === 'dir-q') { V.dirQ = ev.target.value; render(); }
});
document.addEventListener('keydown', ev => {
  if (!D || V.view !== 'desk') return;
  const typing = /INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || '');
  if (ev.key === 'Escape') {
    if (typing && V.q) { V.q = ''; }
    if (typing) document.activeElement.blur();
    V.sel = null; V.kb = -1; render(); return;
  }
  if (typing) return;
  if (ev.key === '/') { ev.preventDefault(); const q = $('q'); if (q) q.focus(); }
  else if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    const cards = V._cards || [];
    if (!cards.length) return;
    ev.preventDefault();
    V.kb = ev.key === 'ArrowDown' ? Math.min(cards.length - 1, V.kb + 1) : Math.max(0, V.kb - 1);
    V.sel = { key: cards[V.kb].key };
    render();
    const el = document.querySelector('.card.sel');
    if (el) el.scrollIntoView({ block: 'nearest' });
  }
});

load().then(listen);
