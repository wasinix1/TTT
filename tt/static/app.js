/* Table tennis console — client.
   Polls /api/state, re-renders, keeps score drafts alive across renders. */

const TOKEN = (() => {
  const m = location.pathname.match(/^\/[ar]\/([^/]+)/);
  return m ? m[1] : '';
})();

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

// which cup this browser is looking at — per-viewer, not shared with the
// server, so admin and every spectator can each pick their own
let selectedCup = localStorage.getItem('tt_cup') || '';
function setCup(id) {
  selectedCup = id || '';
  try { localStorage.setItem('tt_cup', selectedCup); } catch (e) { }
  render();
}
// true if an item with this cup_id (null = shared/ungrouped) belongs in the
// current view: shared items always show, cup-specific ones only in "All"
// or their own tab
const inView = cupId => !selectedCup || cupId == null || cupId === selectedCup;

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isAdmin = () => S && S.role === 'admin';
const canScore = () => S && (S.role === 'admin' || S.role === 'referee');

/* ------------------------------------------------------------------ net */

async function api(op, data) {
  const r = await fetch('/api/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Key': TOKEN },
    body: JSON.stringify({ op, data: data || {} }),
  });
  const j = await r.json().catch(() => ({ error: 'bad response' }));
  if (!r.ok) { toast(j.error || 'That did not work'); return null; }
  await poll(true);
  return j;
}

let lastVersion = -1, polling = false, etag = null;
async function poll(force) {
  if (polling) return;
  polling = true;
  try {
    const h = { 'X-Key': TOKEN };
    if (etag && !force) h['If-None-Match'] = etag;
    const r = await fetch('/api/state?token=' + encodeURIComponent(TOKEN), { headers: h });
    $('pulse').classList.add('on');
    setTimeout(() => $('pulse').classList.remove('on'), 320);
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
    stream = new EventSource('/api/stream');
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

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.hidden = true; }, 3800);
}

/* --------------------------------------------------------------- render */

function render() {
  const focus = document.activeElement;
  const fid = focus && focus.id ? focus.id : null;
  const sel = focus && focus.selectionStart != null ? focus.selectionStart : null;

  $('ev-name').textContent = S.event.name || 'Table tennis';
  const base = S.role === 'admin' ? 'Admin' : S.role === 'referee' ? 'Referee' : 'Live';
  $('role-tag').textContent =
    (S.phase && S.phase !== 'live' && S.role !== 'public')
      ? base + ' · ' + S.phase : base;
  const waiting = (S.registrations || []).filter(r => r.status === 'pending').length;
  $('setup-btn').hidden = !isAdmin();
  $('setup-btn').textContent = waiting ? `Setup · ${waiting}` : 'Setup';

  renderCupTabs();
  renderTables();
  renderBoard();
  renderEditor();
  renderManual();
  renderStandings();
  renderBrackets();
  renderRecent();
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

/* -- cup tabs ------------------------------------------------------------ */

function renderCupTabs() {
  const bar = $('cup-tabs');
  if (!S.cups.length) { bar.hidden = true; return; }
  if (selectedCup && !S.cups.some(c => c.id === selectedCup)) selectedCup = '';
  bar.hidden = false;
  bar.innerHTML = [['', 'All']].concat(S.cups.map(c => [c.id, c.name])).map(([id, name]) =>
    `<button class="${selectedCup === id ? 'on' : ''}" data-cup="${id}">${esc(name)}</button>`
  ).join('');
}

/* -- tables ------------------------------------------------------------ */

function renderTables() {
  const all = S.tables;
  const vis = S._visibleTables = all.filter(t => inView(t.cup_id));
  if (!all.length) {
    $('warn').innerHTML = '';
    $('tables').innerHTML =
      `<div class="table-card"><div class="empty-table">No tables yet.` +
      (isAdmin() ? ' Add them in Setup.' : '') + `</div></div>`;
    return;
  }
  if (!vis.length) {
    $('warn').innerHTML = '';
    $('tables').innerHTML =
      `<div class="table-card"><div class="empty-table">No tables reserved for this cup — they're all on the other side.</div></div>`;
    return;
  }
  const idle = (S.idle_tables || []).filter(w => inView(w.cup_id));
  $('warn').innerHTML = idle.length ? idle.map(w => `<div class="warn">
      Table ${w.table} is reserved and standing empty while
      ${esc(w.waiting_for.join(' and '))} ${w.waiting_for.length > 1 ? 'have' : 'has'}
      people waiting. Share it out in Setup → Tables, or leave it if the
      reservation is the point.</div>`).join('') : '';
  $('tables').innerHTML = vis.map(t => {
    const m = t.match;
    const cls = ['table-card', m ? 'live' : '', t.paused ? 'paused' : ''].join(' ');
    let body;
    if (t.paused) {
      body = `<div class="empty-table">Paused</div>`;
    } else if (!m) {
      body = `<div class="empty-table">Free — waiting for a pairing</div>`;
    } else {
      body = `<div class="match-label">${esc(m.label)}</div><div class="versus">
        <div class="side"><span class="side-name">${esc(m.a)}</span></div>
        <div class="vs">plays</div>
        <div class="side"><span class="side-name">${esc(m.b)}</span></div>
      </div>` + (canScore() ? scorePad(m) : bestOfLine(m));
    }
    return `<div class="${cls}">
      <div class="table-head">
        <span class="table-no">${t.number}</span>
        <span class="table-name">${esc(t.name || ('Table ' + t.number))}</span>
        ${isAdmin() ? `<button class="ghost tiny" data-act="pause" data-t="${t.number}">${t.paused ? 'Resume' : 'Pause'}</button>` : ''}
      </div>${body}</div>`;
  }).join('');
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
  if (r.blocked) return 'waiting on a player';
  if (r.on_deck) return 'get ready';
  if (r.eta_min == null) return '';
  if (r.eta_min <= 5) return 'in a few minutes';
  return 'in about ' + r.eta_min + ' min';
}

function cupName(id) {
  const c = S.cups.find(x => x.id === id);
  return c ? c.name : '';
}

function renderBoard() {
  const bs = (S.board || []).filter(b => inView(b.cup_id));
  if (!bs.length) { $('board').innerHTML = ''; return; }
  $('board').innerHTML = bs.map(b => {
    const name = cupName(b.cup_id);
    const rows = b.up.map(r => `
      <div class="row hoverable ${r.blocked ? 'blocked' : ''} ${r.on_deck ? 'ondeck' : ''}">
        <span class="pos">${r.position}</span>
        <span class="nm">${esc(r.a)}${r.b ? ` <span style="color:var(--dim)">v</span> ${esc(r.b)}` : ''}</span>
        ${r.deferred ? `<span class="chip">put back</span>` : ''}
        ${whenLabel(r) ? `<span class="chip when">${esc(whenLabel(r))}</span>` : ''}
        ${r.kind === 'fixture' && canScore()
          ? `<button class="ghost tiny on-hover" data-act="score" data-m="${r.id}">Enter result</button>` : ''}
        ${r.kind === 'fixture' && isAdmin()
          ? `<button class="ghost tiny on-hover" data-act="jump" data-m="${r.id}">Seat now</button>` : ''}
        ${r.kind === 'waiting' && canScore()
          ? `<button class="ghost tiny on-hover" data-act="leave" data-e="${r.id}">Sit out</button>` : ''}
      </div>`).join('');
    const more = b.total > b.up.length
      ? `<div class="blank" style="padding:10px 15px">and ${b.total - b.up.length} more after that</div>` : '';
    const note = [
      b.fixtures ? b.fixtures + ' to play' : '',
      b.waiting ? b.waiting + ' waiting' : '',
      // the exact table is only picked the instant one frees up, so a cup
      // on the shared pool gets no number; its own tables are a promise
      b.tables_label,
      '~' + b.match_minutes + ' min a match',
    ].filter(Boolean).join(' · ');
    return `<div class="panel">
      <div class="panel-head"><h2>Coming up${name ? ' — ' + esc(name) : ''}</h2>
        <span class="note">${esc(note)}</span></div>
      <div class="panel-body flush">${rows || '<div class="blank" style="padding:12px 15px">Nothing queued.</div>'}${more}</div>
    </div>`;
  }).join('');
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
  if (!manualOpen) {
    el.innerHTML = `<div class="panel"><div class="panel-body">
      <button class="ghost tiny" data-act="manual-open">Add a result by hand</button>
      <p class="sub" style="margin-top:6px">For a game played off the queue — a walk-up
        match, or one that happened before anyone was keeping track. Anything the console
        arranged is scored on the match itself.</p>
    </div></div>`;
    return;
  }
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

function renderStandings() {
  const blocks = [];
  for (const f of S.formats) {
    if (!inView(f.cup_id)) continue;
    if (!f.standings || !f.standings.length) continue;
    const adv = f.kind === 'groups' && f.config.then_ko
      ? +(f.config.advance_per_group || 2) : 0;
    for (const g of f.standings) {
      if (!g.rows.length) continue;
      const swiss = f.kind === 'swiss';
      blocks.push(`<div class="panel">
        <div class="panel-head"><h2>${esc(g.group)}</h2>
          <span class="note">${esc(f.name)}</span></div>
        <table class="grid">
          <tr><th></th><th>Entrant</th><th class="n">P</th><th class="n">W</th>
            ${swiss ? '<th class="n">Buch</th>' : ''}
            <th class="n">Games</th><th class="n">±</th></tr>
          ${g.rows.map(r => `<tr class="${adv && r.rank <= adv ? 'qualified' : ''}">
            <td>${r.rank}</td><td>${esc(r.name)}</td>
            <td class="n">${r.played}</td><td class="n">${r.won}</td>
            ${swiss ? `<td class="n">${r.buchholz ?? 0}</td>` : ''}
            <td class="n">${r.games}</td><td class="n">${r.point_diff > 0 ? '+' : ''}${r.point_diff}</td>
          </tr>`).join('')}
        </table></div>`);
    }
  }
  $('standings').innerHTML = blocks.join('');
}

/* -- bracket ----------------------------------------------------------- */

function renderBrackets() {
  const out = [];
  for (const f of S.formats) {
    if (!inView(f.cup_id)) continue;
    const b = f.view && f.view.bracket;
    if (!b) continue;
    out.push(`<div class="panel">
      <div class="panel-head"><h2>Knockout</h2><span class="note">${esc(f.name)}</span></div>
      <div class="bracket">${b.map(r => `
        <div class="bround"><h3>${esc(r.name)}</h3>${r.matches.map(m => {
          const side = (nm, which) => {
            if (!nm) return `<div><span class="tbd">to be decided</span></div>`;
            const cl = m.winner ? (m.winner === which ? 'won' : 'lost') : '';
            const g = m.games && m.games.length
              ? m.games.filter(x => which === 'a' ? x[0] > x[1] : x[1] > x[0]).length : '';
            return `<div><span class="${cl}">${esc(nm)}</span><span class="${cl}">${g}</span></div>`;
          };
          return `<div class="bmatch ${m.table ? 'live' : ''}">${side(m.a, 'a')}${side(m.b, 'b')}</div>`;
        }).join('')}</div>`).join('')}</div></div>`);
  }
  $('brackets').innerHTML = out.join('');
}

/* -- recent ------------------------------------------------------------ */

function renderRecent() {
  const r = S.recent.filter(m => inView(m.cup_id));
  if (!r.length) { $('recent').innerHTML = ''; return; }
  $('recent').innerHTML = `<div class="panel">
    <div class="panel-head"><h2>Results</h2><span class="note">${r.length}</span></div>
    <div class="panel-body flush">${r.map(m => {
      const sc = m.games.map(g => `${g[0]}-${g[1]}`).join(', ');
      const w = m.winner === 'a' ? m.a : m.b, l = m.winner === 'a' ? m.b : m.a;
      return `<div class="row hoverable">
        <span class="nm">${esc(w)} <span style="color:var(--dim)">beat</span> ${esc(l)}</span>
        <span class="meta">${esc(sc)}</span>
        ${canScore() ? `<button class="ghost tiny on-hover" data-act="edit" data-m="${m.id}">Edit result</button>` : ''}
      </div>`;
    }).join('')}</div></div>`;
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

const TABS = [['door', 'Door'], ['event', 'Event'],
              ['links', 'Links'], ['more', 'More']];

/* Before the doors the job is setting the thing up; after them it is
   letting people in. Open on whichever that is. */
const defaultTab = () =>
  (S && (S.phase === 'announced' || S.phase === 'registration')) ? 'event' : 'door';

let sheetTabSet = false;

function renderSheet() {
  if (wiz) return renderWizard();
  if (!sheetTabSet) { sheetTab = defaultTab(); sheetTabSet = true; }
  // never rebuild the sheet out from under a half-typed field
  if (dirtyFocus()) return;
  const waiting = (S.registrations || []).filter(r => r.status === 'pending').length;
  $('tabs').innerHTML = TABS.map(([k, l]) =>
    `<button class="${sheetTab === k ? 'on' : ''}" data-tab="${k}">${l}${
      k === 'door' && waiting ? ` <span class="count">${waiting}</span>` : ''}</button>`).join('');
  // a result coming in on another table re-renders everything, and without
  // this the sheet jumps back to the top under whoever is reading it
  const body = $('sheet-body');
  const top = body.scrollTop;
  body.innerHTML = ({
    door: tabDoor, event: tabEvent, links: tabLinks, more: tabMore,
  }[sheetTab] || tabDoor)();
  body.scrollTop = top;
}

/* ------------------------------------------------------------ small parts */

const sec = (title, extra) => `<div class="sec"><h2>${esc(title)}</h2>
  <span class="line"></span>${extra || ''}</div>`;

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
  sheetOpen = true;
  $('sheet').hidden = false;
  renderSheet();
}

function wizCarried() {
  return S.cups.length || S.formats.length || S.tables.length;
}

function renderWizard() {
  $('tabs').innerHTML = WIZ_STEPS.map((l, i) =>
    `<button class="${wiz.step === i ? 'on' : ''}" data-wstep="${i}">${i + 1}. ${l}</button>`).join('');
  const body = $('sheet-body');
  const top = body.scrollTop;
  body.innerHTML =
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
  const cols = many ? '28px 1fr 160px auto' : '28px 1fr auto';
  return `<div class="form">
    ${sec('Tables')}
    ${wiz.tables.length ? `<div class="rows">
      <div class="hrow" style="--cols:${cols}"><span>#</span><span>Name</span>${
        many ? '<span>Cup</span>' : ''}<span></span></div>
      ${wiz.tables.map((t, i) => `<div class="drow" style="--cols:${cols}">
        <span class="num">${i + 1}</span>
        <input id="wt-name-${i}" value="${esc(t.name)}" data-wt="${i}|name">
        ${many ? `<select id="wt-cup-${i}" data-wt="${i}|cup">
          <option value="-1" ${t.cup < 0 ? 'selected' : ''}>Shared</option>
          ${wiz.cups.map((c, ci) =>
            `<option value="${ci}" ${t.cup === ci ? 'selected' : ''}>${
              esc(c.name || 'Cup ' + (ci + 1))}</option>`).join('')}
        </select>` : ''}
        <span class="acts">
          <button class="ghost tiny" data-act="wiz-rm-table" data-i="${i}">Remove</button>
        </span></div>`).join('')}
    </div>` : '<p class="blank">No tables. Add at least one or nothing can be dispatched.</p>'}
    <div class="inline"><button class="ghost" data-act="wiz-add-table">Add a table</button></div>
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
  return `<div class="form">
    ${sec('The event')}
    <div class="inline">
      <div class="field"><label for="ev-title">Name</label>
        ${auto('ev-title', 'event_meta', 'name', ev.name, 'placeholder="October open"')}</div>
      <div class="field" style="max-width:230px"><label for="ev-start">Starts at</label>
        ${auto('ev-start', 'event_meta', 'starts_at', ev.starts_at, 'type="datetime-local"')}</div>
    </div>
    <div class="inline">
      <div class="field"><label for="ev-venue">Venue</label>
        ${auto('ev-venue', 'event_meta', 'venue', ev.venue,
               'placeholder="Turnhalle, Hauptstraße 3"')}</div>
    </div>
    <div class="field"><label for="ev-blurb">Blurb</label>
      ${autoArea('ev-blurb', 'event_meta', 'blurb', ev.blurb, 'rows="2" ' +
        'placeholder="Open to everyone, bats provided, first match at seven."')}</div>

    <div class="inline" style="align-items:center">
      <span class="chip state">${esc(S.phase || 'live')}</span>
      <span class="sub" style="flex:1;margin:0">${esc(PHASE_LABEL[S.phase] || '')}</span>
      <div class="field" style="max-width:190px">
        ${pick('ev-phase', 'set_phase', 'phase', ev.phase_pin || '',
          [['', 'Follow the clock']].concat(
            Object.keys(PHASE_LABEL).map(k => [k, 'Pin to ' + k])))}</div>
    </div>
    ${why('Name and blurb are what the landing page shows. Until the start time the plain ' +
          'URL is that page; at the start time it becomes the console on its own — no button ' +
          'to remember to press.',
          'Pin the phase to open the doors early, hold them, or put the landing page back up ' +
          'afterwards. Your admin and referee links always show the console, whatever the phase.')}

    ${sec('Cups')}
    ${S.cups.map(cupCard).join('')}
    ${!S.cups.length ? `<p class="blank">No cups yet. Everything runs in one view until you add one.</p>` : ''}
    <div class="inline">
      <div class="field" style="max-width:230px"><label for="cup-name">Another cup</label>
        <input id="cup-name" value="${esc(form.cupname || '')}" data-f="cupname"
               placeholder="Name it"></div>
      <button class="ghost" data-act="add-cup">Add</button>
    </div>
    ${why('A cup is a sub-tournament and the unit of entry: a registration names one cup, ' +
          'and whoever you confirm at the door lands in that cup’s draw. One cup is the ' +
          'normal case; two is how you run singles and doubles side by side.',
          'A cup that is open appears on the landing page with a button to enter.')}

    ${loose.length ? sec('Not in a cup') + loose.map(f => `<div class="card"><div class="card-body">
        ${formatBlock(f, null)}</div></div>`).join('')
      + `<p class="sub">These run and share the tables like any other draw, they just have no
         cup of their own and no door feeding them.</p>` : ''}

    ${tablesSection()}

    ${sec('Next event')}
    <div class="inline" style="align-items:center">
      <span class="sub" style="flex:1;margin:0">Opens filled in from this one — four steps,
        with a review before anything happens.</span>
      <button data-act="wiz-open">Set up a new event</button>
    </div>
    ${why('Players, teams, matches and formats are cleared. Your access links stay, and ' +
          'nothing is deleted from the log — More → Log still rewinds back across it.')}
  </div>`;
}

/* A cup and everything that is true of it. The draw lives here rather than
   on a tab of its own, which is what lets creating one bind both edges:
   the format's cup_id, and the cup's format_id — the draw the door feeds. */
function cupCard(c) {
  const fs = fmtsOfCup(c.id);
  const intake = c.format_id || '';
  const orphan = fs.length && !intake;
  const mine = tablesOfCup(c.id);
  return `<div class="card"><div class="card-body">
    <div class="inline">
      <div class="field"><label for="cn-${c.id}">Name</label>
        ${auto('cn-' + c.id, 'update_cup:' + c.id, 'name', c.name)}</div>
      <div class="field" style="max-width:135px"><label for="ce-${c.id}">Entry</label>
        ${pick('ce-' + c.id, 'update_cup:' + c.id, 'entry', c.entry || 'single',
          [['single', 'On your own'], ['pair', 'As a pair']])}</div>
      <div class="field" style="max-width:135px"><label for="cr-${c.id}">Sign-ups</label>
        ${pick('cr-' + c.id, 'update_cup:' + c.id, 'registration', c.registration || 'closed',
          [['open', 'Open'], ['closed', 'Closed']])}</div>
      <button class="ghost tiny" data-act="rm-cup" data-c="${c.id}">Remove</button>
    </div>
    <div class="field"><label for="cb-${c.id}">One line for the landing page</label>
      ${auto('cb-' + c.id, 'update_cup:' + c.id, 'blurb', c.blurb || '',
             'placeholder="Five rounds, then a cut to the last eight."')}</div>
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
  const joinable = canCut ? S.entrants.filter(e => !f.entrant_ids.includes(e.id)) : [];
  const isIntake = cup && cup.format_id === f.id;
  const many = cup && fmtsOfCup(cup.id).length > 1;
  return `<div class="sumline">
      <span class="what">${esc(KIND_NAME_ALL[f.kind] || f.kind)}</span>
      <span class="cfg">${esc(f.name && f.name !== (cup || {}).name ? f.name + ' · ' : '')}${
        esc(formatSummary(f))}</span>
      <span class="chip${running ? ' hot' : ''}">${esc(f.status)}${
        f.phase ? ' · ' + esc(f.phase) : ''}</span>
      ${many ? (isIntake
        ? `<span class="chip state">entries land here</span>`
        : `<button class="ghost tiny" data-act="set-intake" data-c="${cup.id}" data-i="${f.id}"
            >send entries here</button>`) : ''}
      <button class="ghost tiny" data-act="fx" data-i="${f.id}">${open ? 'Done' : 'Change'}</button>
    </div>
    ${open ? drawSettings(f, pfx) : ''}
    <div class="acts">
      ${!running ? `<button class="primary tiny" data-act="start-format" data-i="${f.id}">Start</button>` : ''}
      ${canCut && joinable.length ? `<select data-fadd="${f.id}" style="max-width:170px">
        <option value="">+ add a team mid-draw…</option>
        ${joinable.map(e => `<option value="${e.id}">${esc(e.name)}</option>`).join('')}
      </select>` : ''}
      ${canCut ? `<button class="ghost tiny" data-act="cut-ko" data-i="${f.id}">Cut to knockout now</button>` : ''}
      ${f.status !== 'setup' ? `<button class="ghost tiny" data-act="reset-format" data-i="${f.id}">Reset</button>` : ''}
      <button class="ghost tiny" data-act="rm-format" data-i="${f.id}">Remove</button>
    </div>`;
}

/* Scoring sits inside the disclosure with everything else: it is 3 and 11
   almost every time, and a control you never change is still a control you
   have to read past. */
function drawSettings(f, pfx) {
  const ents = f.status === 'setup' ? S.entrants : [];
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
    ${ents.length ? `<div class="hr"></div>
      <label style="font-size:12.5px;color:var(--muted)">Who is in it</label>
      <div class="pickers">${ents.map(e => `
        <label class="pick"><input type="checkbox" data-fent="${f.id}|${e.id}"
          ${(form['fe_' + f.id] || {})[e.id] ? 'checked' : ''}> ${esc(e.name)}
          <span style="color:var(--dim)">${e.strength}</span></label>`).join('')}</div>` : ''}
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
  const cols = many ? '28px 1fr 150px auto' : '28px 1fr auto';
  return `${sec('Tables', many ? `<button class="ghost tiny" data-act="${
    split ? 'share-tables' : 'split-tables'}">${
    split ? 'Share them all' : 'Split between cups'}</button>` : '')}
    ${S.tables.length ? `<div class="rows">
      <div class="hrow" style="--cols:${cols}"><span>#</span><span>Name</span>${
        many ? '<span>Cup</span>' : ''}<span></span></div>
      ${S.tables.map(t => `<div class="drow" style="--cols:${cols}">
        <span class="num">${t.number}</span>
        ${auto('tn-' + t.number, 'set_table:' + t.number, 'name', t.name)}
        ${many ? pick('tc-' + t.number, 'set_table:' + t.number, 'cup_id', t.cup_id || '',
          [['', 'Shared']].concat(S.cups.map(c => [c.id, c.name]))) : ''}
        <span class="acts">
          <button class="ghost tiny" data-act="pause" data-t="${t.number}">${t.paused ? 'Resume' : 'Pause'}</button>
          <button class="ghost tiny" data-act="rm-table" data-t="${t.number}">Remove</button>
        </span></div>`).join('')}
    </div>` : '<p class="blank">No tables. Add at least one or nothing can be dispatched.</p>'}
    <div class="inline"><button class="ghost" data-act="add-table">Add a table</button></div>
    ${why('Pausing a table stops the dispatcher sending matches to it. Changing a table’s ' +
          'cup takes effect straight away.',
          many && split
            ? 'Each cup only ever plays on its own tables, so “which table” is a real ' +
              'answer for a spectator. A cup with nothing ready leaves its tables standing empty.'
            : 'Every cup draws from one pool and the table goes to whichever cup is furthest ' +
              'from finishing, so nothing stands idle — but you cannot tell anyone which ' +
              'table they are on until they are called.')}`;
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
      <div class="field" style="max-width:120px"><label for="${id('c-gap')}">Strength gap</label>
        <input id="${id('c-gap')}" value="${esc(v('c_gap', 1.5))}" data-f="${k('c_gap')}" inputmode="decimal"></div>
      <div class="field" style="max-width:130px"><label for="${id('c-widen')}">Widen after</label>
        <input id="${id('c-widen')}" value="${esc(v('c_widen', 3))}" data-f="${k('c_widen')}" inputmode="numeric"></div>
      <div class="field" style="max-width:150px"><label for="${id('c-rw')}">Avoid rematches</label>
        <select id="${id('c-rw')}" data-f="${k('c_rw')}">
          <option value="0" ${v('c_rw') === '0' ? 'selected' : ''}>Off — closest match always</option>
          <option value="0.6" ${v('c_rw', '0.6') === '0.6' ? 'selected' : ''}>Balanced</option>
          <option value="1.2" ${v('c_rw') === '1.2' ? 'selected' : ''}>Strong</option>
        </select></div>
    </div>
    ${why('The gap widens by one every few times a waiting entrant is passed over, so ' +
          'nobody sits all night waiting for a perfect match.',
          'Avoiding rematches is priced in strength points: on a lopsided field, ' +
          '<b>strong</b> buys variety by pairing people further apart.')}`,
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
          <option value="paced" ${v('c_pace', 'paced') === 'paced' ? 'selected' : ''}>Paced — on demand, nobody gets ahead</option>
          <option value="strict" ${v('c_pace') === 'strict' ? 'selected' : ''}>Strict rounds — everyone waits for the round</option>
          <option value="free" ${v('c_pace') === 'free' ? 'selected' : ''}>Free-running — on demand, no round limit</option>
        </select></div>
    </div>
    ${why('<b>Paced</b> pairs people the moment a table frees up, but only against ' +
          'someone who has played the same number of games, and stops them at the round ' +
          'count. No table ever waits on the one match that went to deuce in the fifth, ' +
          'and the field stays level — which also matters when you are sharing tables, ' +
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
   walked in becomes a player. The claimed strength sits next to what we
   remember about them, and what you type wins over both. */

function knownFor(name) {
  const k = (name || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return (S.people || []).find(p =>
    p.name.trim().toLowerCase().replace(/\s+/g, ' ') === k);
}

/* What the door will actually use, before anyone touches the box. Rendering
   and submitting both go through this: the first version of it worked these
   out separately, so the box showed what we remembered and then sent what
   they claimed. */
function admitDefaults(r) {
  const k = knownFor(r.name);
  const pk = r.partner_name ? knownFor(r.partner_name) : null;
  return {
    strength: form['rs-' + r.id] ?? (k ? k.strength : r.strength),
    partner_strength: form['rps-' + r.id] ?? (pk ? pk.strength : r.partner_strength),
    name: form['rn-' + r.id] ?? r.name,
    partner_name: form['rp-' + r.id] ?? r.partner_name,
  };
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

/* One pending entry. Two lines at most, and the strength box carries what
   we know beside it rather than in a paragraph underneath. */
function regRow(r) {
  const known = knownFor(r.name);
  const pKnown = r.partner_name ? knownFor(r.partner_name) : null;
  const seeking = r.kind === 'seeking';
  const d = admitDefaults(r);
  const note = n => n ? `<span class="sub" style="margin:0;white-space:nowrap">${esc(n)}</span>` : '';
  const seen = (k, claimed) => note(
    k ? `last time ${k.strength}${+k.strength !== +claimed ? ` · said ${claimed}` : ''}`
      : `said ${claimed}`);
  return `<div class="entry">
    <div class="drow" style="--cols:1fr 76px 150px auto">
      <input id="rn-${r.id}" value="${esc(d.name)}" data-f="rn-${r.id}">
      <input id="rs-${r.id}" value="${esc(d.strength)}" data-f="rs-${r.id}" inputmode="decimal">
      ${seen(known, r.strength)}
      <span class="acts">
        <button class="primary tiny" data-act="admit" data-r="${r.id}">Confirm</button>
        <button class="ghost tiny" data-act="drop-reg" data-r="${r.id}">No show</button>
      </span>
    </div>
    ${r.kind === 'pair' || seeking ? `<div class="drow" style="--cols:1fr 76px 150px auto">
      <input id="rp-${r.id}" value="${esc(d.partner_name)}" data-f="rp-${r.id}"
             placeholder="${seeking ? 'partner — blank enters them alone' : 'partner'}">
      <input id="rps-${r.id}" value="${esc(d.partner_strength)}" data-f="rps-${r.id}" inputmode="decimal">
      ${seen(pKnown, r.partner_strength)}
      <span></span>
    </div>` : ''}
    ${r.note ? `<div class="drow" style="--cols:1fr"><span class="sub"
      >“${esc(r.note)}”</span></div>` : ''}
  </div>`;
}

function tabDoor() {
  const regs = S.registrations || [];
  const pending = regs.filter(r => r.status === 'pending');
  const inCups = S.cups.length ? S.cups : [{ id: '', name: 'This event' }];
  const walkOpen = !!form.walk_open || !pending.length;
  return `<div class="form">
    ${sec('At the door', pending.length
      ? `<button class="${walkOpen ? 'ghost' : ''} tiny" data-act="walk-toggle">${
          walkOpen ? 'Hide' : 'Somebody not on the list'}</button>` : '')}
    ${walkOpen ? walkInForm() : ''}

    ${pending.length ? inCups.map(c => {
      const rows = pending.filter(r => r.cup_id === c.id);
      if (!rows.length) return '';
      return `${sec(c.name + ' · ' + rows.length + ' waiting',
        `<button class="ghost tiny" data-act="admit-all" data-c="${c.id}">Confirm all ${rows.length}</button>`)}
        <div class="rows">${rows.map(regRow).join('')}</div>`;
    }).join('') : `<p class="blank">Nobody waiting${
      regs.length ? '' : ` — entries arrive from ${location.origin}/join`}.</p>`}

    ${rosterSection()}
    ${queueSection()}
  </div>`;
}

function walkInForm() {
  const wcup = form.w_cup ?? (S.cups[0] ? S.cups[0].id : '');
  const wpair = (S.cups.find(c => c.id === wcup) || {}).entry === 'pair';
  return `<div class="inline" style="align-items:flex-end">
      ${S.cups.length > 1 ? `<div class="field" style="max-width:160px"><label for="w-cup">Cup</label>
        <select id="w-cup" data-f="w_cup">${S.cups.map(c =>
          `<option value="${c.id}" ${wcup === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select></div>` : ''}
      <div class="field"><label for="w-name">Name</label>
        <input id="w-name" value="${esc(form.w_name || '')}" data-f="w_name"
               list="known-people" placeholder="Jana Berger"></div>
      <div class="field" style="max-width:76px"><label for="w-str">Strength</label>
        <input id="w-str" value="${esc(form.w_str ?? (knownFor(form.w_name) || {}).strength ?? 5)}"
               data-f="w_str" inputmode="decimal"></div>
      ${wpair ? `<div class="field"><label for="w-pname">Partner</label>
        <input id="w-pname" value="${esc(form.w_pname || '')}" data-f="w_pname" list="known-people"></div>
      <div class="field" style="max-width:76px"><label for="w-pstr">Strength</label>
        <input id="w-pstr" value="${esc(form.w_pstr ?? 5)}" data-f="w_pstr" inputmode="decimal"></div>` : ''}
      <button class="primary" data-act="walk-in">Add</button>
    </div>
    <datalist id="known-people">${(S.people || []).map(p =>
      `<option value="${esc(p.name)}">`).join('')}</datalist>
    ${knownFor(form.w_name) ? `<p class="sub">${esc(form.w_name)} is in the directory — last
      played at ${knownFor(form.w_name).strength}.</p>` : ''}`;
}

/* Tonight's roster. Names and strengths autosave, so the Save button that
   used to sit on all forty rows is gone. */
function rosterSection() {
  const addOpen = !!form.roster_add;
  return `${sec('Tonight', `<button class="ghost tiny" data-act="roster-add">${
      addOpen ? 'Hide' : 'Add by hand'}</button>`)}
    ${addOpen ? `<div class="card"><div class="card-body">
      <div class="inline">
        <div class="field"><label for="p-name">Player</label>
          <input id="p-name" value="${esc(form.pname || '')}" data-f="pname" placeholder="Jana"></div>
        <div class="field" style="max-width:105px"><label for="p-str">Strength</label>
          <input id="p-str" value="${esc(form.pstr ?? 5)}" data-f="pstr" inputmode="decimal"></div>
        <button class="primary" data-act="add-player">Add</button>
      </div>
      <div class="hr"></div>
      <div class="inline">
        <div class="field"><label for="t-n1">Pair — one</label>
          <input id="t-n1" value="${esc(form.tn1 || '')}" data-f="tn1"></div>
        <div class="field" style="max-width:85px"><label for="t-s1">Strength</label>
          <input id="t-s1" value="${esc(form.ts1 ?? 5)}" data-f="ts1" inputmode="decimal"></div>
        <div class="field"><label for="t-n2">and two</label>
          <input id="t-n2" value="${esc(form.tn2 || '')}" data-f="tn2"></div>
        <div class="field" style="max-width:85px"><label for="t-s2">Strength</label>
          <input id="t-s2" value="${esc(form.ts2 ?? 5)}" data-f="ts2" inputmode="decimal"></div>
      </div>
      <div class="inline">
        <div class="field"><label for="t-name">Team name (optional)</label>
          <input id="t-name" value="${esc(form.tname || '')}" data-f="tname"></div>
        <button class="primary" data-act="add-team">Add pair</button>
      </div>
      ${why('A single player can enter singles, or go in the scramble pool where partners ' +
            'get drawn each round.')}
    </div></div>` : ''}
    ${S.players.length ? `<div class="rows">
      <div class="hrow" style="--cols:1fr 76px auto"><span>Name</span><span>Strength</span><span></span></div>
      ${S.players.map(p => `<div class="drow" style="--cols:1fr 76px auto"${
        p.active ? '' : ' data-dim="1"'}>
        ${auto('pn-' + p.id, 'update_player:' + p.id, 'name', p.name)}
        ${auto('ps-' + p.id, 'update_player:' + p.id, 'strength', p.strength, 'inputmode="decimal"')}
        <span class="acts"><button class="ghost tiny" data-act="toggle-player" data-p="${p.id}">${
          p.active ? 'Sit out' : 'Bring back'}</button></span>
      </div>`).join('')}
    </div>` : '<p class="blank">Nobody yet.</p>'}
    ${why('Strength is your estimate, not a rating. Nudge it after the first round; that ' +
          'beats any rating system at this sample size. Edits save as you leave the box.')}`;
}

function queueSection() {
  const qf = S.formats.filter(f => f.uses_queue && f.status === 'running');
  if (!qf.length) return '';
  return `${sec('Queue')}
    ${qf.map(f => `<div class="card"><div class="card-body">
      <div class="inline" style="align-items:center">
        <span style="flex:1;font-weight:600">${esc(f.name || KIND_NAME_ALL[f.kind])}</span>
        <button class="ghost tiny" data-act="join-all" data-i="${f.id}">Put everyone in</button>
      </div>
      <div class="pickers">${S.entrants.map(e => `
        <label class="pick">${esc(e.name)}<span style="flex:1"></span>
          ${e.queued ? `<button class="ghost tiny" data-act="leave" data-e="${e.id}">Out</button>`
                     : `<button class="tiny" data-act="join" data-e="${e.id}" data-i="${f.id}">In</button>`}
        </label>`).join('')}</div>
    </div></div>`).join('')}`;
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
      <div class="drow" style="--cols:170px 1fr"><span>Admin — this page</span>
        <span class="key">${base}/a/${esc(S.keys.admin || '')}</span></div>
      <div class="drow" style="--cols:170px 1fr"><span>Wall display</span>
        <span class="key">${base}/board</span></div>
    </div>
    ${why('No accounts, no logins. Keep the referee link to the people running tables — ' +
          'anyone who has it can enter results.',
          'The wall display needs no key and has no controls, so it is safe on a screen ' +
          'anyone can reach. It answers “when am I playing” by itself: who is on ' +
          'which table now, then the running order with a rough time against each one.')}

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

/* -------------------------------------------------------------- More tab

   The two things you reach for once a month: who the club knows, and the
   undo of last resort. */

function tabMore() {
  return `<div class="form">
    ${sec('Club directory')}
    <div class="inline">
      <div class="field" style="max-width:280px"><label for="dir-q">Search</label>
        <input id="dir-q" value="${esc(form.dir_q || '')}" data-f="dir_q"
               placeholder="Name"></div>
    </div>
    ${directoryRows()}
    ${why('Everyone the club has seen, and the strength you last settled on for them. This ' +
          'outlives the event — a new event clears tonight’s roster, never this. Adding ' +
          'a regular from here starts them at the number you tuned last time instead of a guess.')}

    ${sec('Log')}
    <p class="sub">Every change is an event. Rewinding drops everything after that point and
      rebuilds the evening from scratch.</p>
    <div class="rows">
      <div class="hrow" style="--cols:44px 1fr auto"><span>#</span><span>What</span><span></span></div>
      ${S.history.map(h => `<div class="drow" style="--cols:44px 1fr auto">
        <span class="num">${h.seq}</span>
        <span style="font-size:13px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
          >${esc(h.type)} <span style="color:var(--muted)">${esc(JSON.stringify(h.payload).slice(0, 70))}</span></span>
        <span class="acts"><button class="ghost tiny" data-act="rewind" data-s="${h.seq}">Rewind here</button></span>
      </div>`).join('')}
    </div>
    ${why('To start the next evening clean, Event → next event does it properly: one ' +
          'pass that clears the old one and sets up the next, instead of a wipe you then ' +
          'have to rebuild from.')}
  </div>`;
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
    <div class="hrow" style="--cols:1fr 76px auto"><span>Name</span><span>Strength</span><span></span></div>
    ${list.slice(0, 40).map(p => `<div class="drow" style="--cols:1fr 76px auto">
      <span>${esc(p.name)}${p.playing
        ? ' <span style="color:var(--signal);font-size:12px">playing tonight</span>' : ''}</span>
      ${auto('nn-' + p.id, 'update_person:' + p.id, 'strength', p.strength, 'inputmode="decimal"')}
      <span class="acts">
        ${p.playing ? '' : `<button class="tiny" data-act="from-directory" data-n="${p.id}">Add to tonight</button>`}
        <button class="ghost tiny" data-act="rm-person" data-n="${p.id}">Forget</button>
      </span></div>`).join('')}
  </div>${list.length > 40 ? `<p class="sub">…and ${list.length - 40} more. Narrow the search.</p>` : ''}`;
}

/* --------------------------------------------------------------- events */

document.addEventListener('input', e => {
  const mg = e.target.dataset.mg;
  if (mg) {
    const [i, side] = mg.split('|');
    const v = e.target.value.replace(/[^0-9]/g, '').slice(0, 2);
    e.target.value = v;
    while (manualGames.length <= +i) manualGames.push(['', '']);
    manualGames[+i][+side] = v;
    renderManual();
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
    const back = document.getElementById(e.target.id);
    if (back) { back.focus(); try { back.setSelectionRange(99, 99); } catch (x) { } }
    return;
  }
  if (wizInput(e)) return;
  const f = e.target.dataset.f;
  if (f) {
    form[f] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    // typing a name the club already knows should bring their number with it
    if ((f === 'w_name' || f === 'w_pname') && sheetTab === 'entries') {
      const k = knownFor(form[f]);
      if (k) { form[f === 'w_name' ? 'w_str' : 'w_pstr'] = k.strength; renderSheet(); }
    }
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
  // selects commit the moment they change — there is nothing to finish typing
  if (e.target.dataset.save) { autoSave(e.target); return; }
  const f = e.target.dataset.f;
  if (f) {
    form[f] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    if (f === 'f_kind' || /c_mode$/.test(f) || /c_pace$/.test(f)) renderSheet();
  }
  // which format a cup's new draw will be, and what settings to show for it
  const nk = e.target.dataset.nk;
  if (nk) {
    form['nk_' + nk] = e.target.value;
    if (e.target.value) seedFormat('nf' + nk + '_', e.target.value, null);
    renderSheet();
    return;
  }
  const fent = e.target.dataset.fent;
  if (fent) {
    const [fid, eid] = fent.split('|');
    form['fe_' + fid] = form['fe_' + fid] || {};
    form['fe_' + fid][eid] = e.target.checked;
  }
  const fadd = e.target.dataset.fadd;
  if (fadd && e.target.value) api('add_entrant', { id: fadd, entrant_id: e.target.value });
});

document.addEventListener('click', async e => {
  const tab = e.target.dataset.tab;
  if (tab) { sheetTab = tab; renderSheet(); return; }
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
    const rows = (S.registrations || []).filter(
      r => r.status === 'pending' && r.cup_id === b.dataset.c);
    if (!confirm(`Confirm all ${rows.length}? You can still sit anyone out afterwards.`)) return;
    const payloads = rows.map(admitPayload);   // before the list re-renders under us
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
      cup_id: form.w_cup ?? (S.cups[0] ? S.cups[0].id : ''),
      name: form.w_name, strength: num(form.w_str ?? (known ? known.strength : 5)),
      partner_name: form.w_pname || '',
      partner_strength: num(form.w_pstr ?? 5),
      kind: form.w_pname ? 'pair' : 'single',
      person_id: known ? known.id : undefined,
    });
    if (out) {
      form.w_name = form.w_pname = ''; form.w_str = form.w_pstr = undefined;
      renderSheet();
      if (out.where === 'roster') toast(`Added to the roster — ${out.why}`);
    }
    return;
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
    const ok = await api('report', { match_id: mid, games, requeue: drafts['rq-' + mid] !== false });
    if (ok) { delete drafts[mid]; delete drafts['rq-' + mid]; if (editing === mid) closeEditor(); }
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
  if (a === 'manual-open') { manualOpen = true; renderManual(); return; }
  if (a === 'manual-close') { manualOpen = false; renderManual(); return; }
  if (a === 'put-back') {
    const ok = await api('put_back', { match_id: b.dataset.m });
    if (ok) toast('Table freed — that match goes to the back of the queue');
    return;
  }
  if (a === 'jump') {
    const row = (S.board || []).flatMap(x => x.up).find(r => r.id === b.dataset.m);
    const allowed = row ? row.tables : S.tables.map(t => t.number);
    const free = S.tables.find(t => !t.paused && !t.match && allowed.includes(t.number));
    if (!free) return toast('No table free that this match can use');
    return void api('assign', { match_id: b.dataset.m, table: free.number });
  }
  if (a === 'join') return void api('join_queue', { entrant_id: b.dataset.e, format_id: b.dataset.i });
  if (a === 'leave') return void api('leave_queue', { entrant_id: b.dataset.e });
  if (a === 'join-all') {
    for (const en of S.entrants) if (!en.queued)
      await api('join_queue', { entrant_id: en.id, format_id: b.dataset.i });
    return;
  }
  if (a === 'pause') {
    const t = S.tables.find(x => x.number == b.dataset.t);
    return void api('set_table', { number: +b.dataset.t, paused: !t.paused });
  }
  if (a === 'add-table') {
    const n = S.tables.length ? Math.max(...S.tables.map(t => t.number)) + 1 : 1;
    return void api('set_table', { number: n, name: 'Table ' + n });
  }
  if (a === 'rm-table') return void api('remove_table', { number: +b.dataset.t });
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
      form['fe_' + f.id] = Object.fromEntries((f.entrant_ids || []).map(i => [i, true]));
    }
    return renderSheet();
  }
  if (a === 'walk-toggle') { form.walk_open = !form.walk_open; return renderSheet(); }
  if (a === 'roster-add') { form.roster_add = !form.roster_add; return renderSheet(); }
  if (a === 'rm-cup') {
    if (!confirm('Remove this cup? Its tables and formats stay, just ungrouped.')) return;
    return void api('remove_cup', { id: b.dataset.c });
  }

  if (a === 'add-player') {
    if (!form.pname) return toast('Give the player a name');
    await api('add_player', { name: form.pname, strength: num(form.pstr ?? 5) });
    form.pname = ''; renderSheet(); $('p-name') && $('p-name').focus();
    return;
  }
  if (a === 'add-team') {
    if (!form.tn1 || !form.tn2) return toast('Both players need a name');
    await api('add_team', {
      name: form.tname || '',
      members: [[form.tn1, num(form.ts1 ?? 5)], [form.tn2, num(form.ts2 ?? 5)]],
    });
    form.tn1 = form.tn2 = form.tname = ''; renderSheet();
    return;
  }
  if (a === 'toggle-player') {
    const p = S.players.find(x => x.id === b.dataset.p);
    return void api('update_player', { id: p.id, active: !p.active });
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
      kind, name: cup.name || '', config: cfg, entrant_ids: [] });
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
    if (f.status === 'setup') {
      const ents = Object.entries(form['fe_' + fid] || {})
        .filter(([, v]) => v).map(([k]) => k);
      if (f.kind !== 'open_play' && ents.length && ents.length < 2)
        return toast('A draw needs at least two entrants, or none yet');
      data.entrant_ids = ents;
    }
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
  if (a === 'rewind') {
    if (!confirm('Drop everything after event ' + b.dataset.s + '?')) return;
    return void api('rewind', { seq: +b.dataset.s });
  }
});

$('setup-btn').onclick = () => { sheetOpen = true; $('sheet').hidden = false; renderSheet(); };
$('sheet-close').onclick = () => { sheetOpen = false; $('sheet').hidden = true; };
$('sheet').addEventListener('click', e => {
  if (e.target.id === 'sheet') { sheetOpen = false; $('sheet').hidden = true; }
});
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (editing) return closeEditor();
  if (sheetOpen) { sheetOpen = false; $('sheet').hidden = true; }
});
$('editor').addEventListener('click', e => {
  if (e.target.id === 'editor') closeEditor();
});

poll(true);
connectStream();
setInterval(() => { if (!streamOk) poll(); }, 2500);   // fallback only
setInterval(() => { if (streamOk) poll(); }, 20000);   // slow reconcile
