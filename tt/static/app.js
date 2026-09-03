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
  $('role-tag').textContent =
    S.role === 'admin' ? 'Admin' : S.role === 'referee' ? 'Referee' : 'Live';
  $('setup-btn').hidden = !isAdmin();

  renderCupTabs();
  renderTables();
  renderQueues();
  renderUpcoming();
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
    $('tables').innerHTML =
      `<div class="table-card"><div class="empty-table">No tables yet.` +
      (isAdmin() ? ' Add them in Setup.' : '') + `</div></div>`;
    return;
  }
  if (!vis.length) {
    $('tables').innerHTML =
      `<div class="table-card"><div class="empty-table">No tables reserved for this cup — they're all on the other side.</div></div>`;
    return;
  }
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
  return `<div class="pad">
    <div class="games">${games}</div>
    <div class="pad-row">
      <button class="primary" data-act="report" data-m="${m.id}" ${decided ? '' : 'disabled'}>
        ${decided ? `Save ${wa > wb ? esc(m.a) : esc(m.b)} win` : 'Save result'}</button>
      ${rq ? `<label class="hint"><input type="checkbox" id="rq-${m.id}" ${(drafts['rq-' + m.id] !== false) ? 'checked' : ''} data-rq="${m.id}"> back in queue</label>` : ''}
      <button class="ghost tiny" data-act="clear" data-m="${m.id}">Clear</button>
      ${isAdmin() ? `<button class="ghost tiny" data-act="unassign" data-m="${m.id}">Send back</button>` : ''}
    </div>
    <div class="hint">Best of ${s.best_of} to ${s.points_to}</div>
  </div>`;
}

/* -- queues ------------------------------------------------------------ */

function renderQueues() {
  const qs = S.queues.filter(q => inView(q.cup_id));
  if (!qs.length) { $('queues').innerHTML = ''; return; }
  $('queues').innerHTML = qs.map(q => {
    const rows = q.entries.length ? q.entries.map((e, i) => `
      <div class="row ${e.passes >= 2 ? 'waiting-long' : ''} ${e.blocked ? 'blocked' : ''}">
        <span class="pos">${i + 1}</span>
        <span class="nm">${esc(e.name)}</span>
        ${e.waiting_long ? `<span class="chip hot">waiting a while</span>` : ''}
        <span class="meta">${e.strength}</span>
        ${canScore() ? `<button class="ghost tiny" data-act="leave" data-e="${e.entrant_id}">Out</button>` : ''}
      </div>`).join('')
      : `<div class="blank" style="padding:12px 15px">Nobody waiting.</div>`;
    const modeLabel = { pairs: 'fixed pairs', singles: 'singles',
                        scramble: 'partners drawn on the spot' }[q.mode] || '';
    return `<div class="panel">
      <div class="panel-head"><h2>${esc(q.format_name)} queue</h2>
        <span class="note">${modeLabel}</span></div>
      <div class="panel-body flush">${rows}</div>
    </div>`;
  }).join('');
}

/* -- upcoming ---------------------------------------------------------- */

function tableBadge(m) {
  const all = S.tables.map(t => t.number).sort((a, b) => a - b).join(',');
  const el = (m.eligible_tables || []).slice().sort((a, b) => a - b);
  if (!el.length) return 'No table free for this cup';
  return el.join(',') === all ? 'Any table' : 'Table ' + el.join(', ');
}

function renderUpcoming() {
  const u = S.upcoming.filter(m => inView(m.cup_id));
  if (!u.length) { $('upcoming').innerHTML = ''; return; }
  $('upcoming').innerHTML = `<div class="panel">
    <div class="panel-head"><h2>Still to play</h2><span class="note">${u.length}</span></div>
    <div class="panel-body flush">${u.slice(0, 14).map(m => `
      <div class="row ${m.blocked ? 'blocked' : ''}">
        <span class="nm">${esc(m.a)} <span style="color:var(--dim)">v</span> ${esc(m.b)}</span>
        <span class="chip">${esc(m.label)}</span>
        ${m.next ? `<span class="chip next">Up next</span>` : ''}
        <span class="chip tables">${tableBadge(m)}</span>
        ${m.blocked ? `<span class="chip">a player is still on another table</span>` : ''}
        ${isAdmin() ? `<button class="ghost tiny" data-act="jump" data-m="${m.id}">Seat now</button>` : ''}
      </div>`).join('')}</div></div>`;
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
      return `<div class="row">
        <span class="nm">${esc(w)} <span style="color:var(--dim)">beat</span> ${esc(l)}</span>
        <span class="meta">${esc(sc)}</span>
        ${canScore() ? `<button class="ghost tiny" data-act="void" data-m="${m.id}">Undo</button>` : ''}
      </div>`;
    }).join('')}</div></div>`;
}

/* ---------------------------------------------------------------- sheet */

const TABS = [['people', 'People'], ['tables', 'Tables'], ['cups', 'Cups'],
              ['formats', 'Formats'], ['queue', 'Queue'], ['log', 'Log'],
              ['access', 'Access']];

function renderSheet() {
  $('tabs').innerHTML = TABS.map(([k, l]) =>
    `<button class="${sheetTab === k ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('');
  $('sheet-body').innerHTML = ({
    people: tabPeople, tables: tabTables, cups: tabCups, formats: tabFormats,
    queue: tabQueue, log: tabLog, access: tabAccess,
  }[sheetTab])();
}

function tabPeople() {
  return `<div class="form">
    <fieldset><legend>Add one player</legend>
      <div class="inline">
        <div class="field"><label for="p-name">Name</label>
          <input id="p-name" value="${esc(form.pname || '')}" data-f="pname" placeholder="Jana"></div>
        <div class="field" style="max-width:110px"><label for="p-str">Strength 1–10</label>
          <input id="p-str" value="${esc(form.pstr ?? 5)}" data-f="pstr" inputmode="decimal"></div>
        <button class="primary" data-act="add-player">Add player</button>
      </div>
      <p class="sub">A single player can enter singles, or go in the scramble pool where partners get drawn each round.</p>
    </fieldset>

    <fieldset><legend>Add a fixed pair</legend>
      <div class="inline">
        <div class="field"><label for="t-n1">Player one</label>
          <input id="t-n1" value="${esc(form.tn1 || '')}" data-f="tn1"></div>
        <div class="field" style="max-width:90px"><label for="t-s1">Strength</label>
          <input id="t-s1" value="${esc(form.ts1 ?? 5)}" data-f="ts1" inputmode="decimal"></div>
      </div>
      <div class="inline">
        <div class="field"><label for="t-n2">Player two</label>
          <input id="t-n2" value="${esc(form.tn2 || '')}" data-f="tn2"></div>
        <div class="field" style="max-width:90px"><label for="t-s2">Strength</label>
          <input id="t-s2" value="${esc(form.ts2 ?? 5)}" data-f="ts2" inputmode="decimal"></div>
      </div>
      <div class="inline">
        <div class="field"><label for="t-name">Team name (optional)</label>
          <input id="t-name" value="${esc(form.tname || '')}" data-f="tname"></div>
        <button class="primary" data-act="add-team">Add pair</button>
      </div>
    </fieldset>

    <div class="hr"></div>
    <h2 style="font-size:14px">Players</h2>
    <p class="sub">Strength is your estimate, not a rating. Nudge it after the first round; that beats any rating system at this sample size.</p>
    ${S.players.map(p => `<div class="inline">
      <div class="field"><input id="pn-${p.id}" value="${esc(p.name)}" data-f="n-${p.id}"></div>
      <div class="field" style="max-width:80px"><input id="ps-${p.id}" value="${p.strength}" data-f="s-${p.id}" inputmode="decimal"></div>
      <button class="tiny" data-act="save-player" data-p="${p.id}">Save</button>
      <button class="ghost tiny" data-act="toggle-player" data-p="${p.id}">${p.active ? 'Sit out' : 'Bring back'}</button>
    </div>`).join('') || '<p class="blank">Nobody yet.</p>'}
  </div>`;
}

function tabTables() {
  return `<div class="form">
    <p class="sub">A table with no cup is shared by every running format. Give it a cup and it's reserved for that cup's formats only — that's how you split tables between two tournaments running at once. Pause a table and the dispatcher stops sending matches to it.</p>
    ${S.tables.map(t => `<div class="inline">
      <div class="field" style="max-width:70px"><label>Number</label><input value="${t.number}" disabled></div>
      <div class="field"><label>Name</label><input id="tn-${t.number}" value="${esc(t.name)}" data-f="tn-${t.number}"></div>
      ${S.cups.length ? `<div class="field" style="max-width:150px"><label>Cup</label>
        <select id="tc-${t.number}" data-f="tc-${t.number}">
          <option value="">Shared</option>
          ${S.cups.map(c => `<option value="${c.id}" ${t.cup_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select></div>` : ''}
      <button class="tiny" data-act="save-table" data-t="${t.number}">Save</button>
      <button class="ghost tiny" data-act="pause" data-t="${t.number}">${t.paused ? 'Resume' : 'Pause'}</button>
      <button class="ghost tiny" data-act="rm-table" data-t="${t.number}">Remove</button>
    </div>`).join('')}
    <div><button class="primary" data-act="add-table">Add a table</button></div>
  </div>`;
}

function tabCups() {
  return `<div class="form">
    <fieldset><legend>New cup</legend>
      <div class="inline">
        <div class="field"><label for="cup-name">Name</label>
          <input id="cup-name" value="${esc(form.cupname || '')}" data-f="cupname" placeholder="Cup A"></div>
        <button class="primary" data-act="add-cup">Add cup</button>
      </div>
      <p class="sub">A cup is a spectator-facing grouping — toggle at the top of the page to see just that cup's tables, queue, standings and bracket. Assign a format to a cup on the Formats tab, and optionally reserve specific tables for it on the Tables tab.</p>
    </fieldset>
    ${S.cups.map(c => `<div class="inline">
      <div class="field"><input id="cn-${c.id}" value="${esc(c.name)}" data-f="cn-${c.id}"></div>
      <button class="tiny" data-act="save-cup" data-c="${c.id}">Save</button>
      <button class="ghost tiny" data-act="rm-cup" data-c="${c.id}">Remove</button>
    </div>`).join('') || '<p class="blank">No cups yet — everything shows in one view until you add one.</p>'}
  </div>`;
}

const KIND_FIELDS = {
  open_play: () => `
    <div class="inline">
      <div class="field"><label for="c-mode">Who plays whom</label>
        <select id="c-mode" data-f="c_mode">
          <option value="pairs" ${form.c_mode === 'pairs' ? 'selected' : ''}>Fixed pairs</option>
          <option value="singles" ${form.c_mode === 'singles' ? 'selected' : ''}>Singles</option>
          <option value="scramble" ${form.c_mode === 'scramble' ? 'selected' : ''}>Scramble doubles</option>
        </select></div>
      <div class="field" style="max-width:120px"><label for="c-gap">Strength gap</label>
        <input id="c-gap" value="${esc(form.c_gap ?? 1.5)}" data-f="c_gap" inputmode="decimal"></div>
      <div class="field" style="max-width:130px"><label for="c-widen">Widen after</label>
        <input id="c-widen" value="${esc(form.c_widen ?? 3)}" data-f="c_widen" inputmode="numeric"></div>
      <div class="field" style="max-width:150px"><label for="c-rw">Avoid rematches</label>
        <select id="c-rw" data-f="c_rw">
          <option value="0" ${form.c_rw === '0' ? 'selected' : ''}>Off — closest match always</option>
          <option value="0.6" ${(form.c_rw ?? '0.6') === '0.6' ? 'selected' : ''}>Balanced</option>
          <option value="1.2" ${form.c_rw === '1.2' ? 'selected' : ''}>Strong</option>
        </select></div>
    </div>
    <p class="sub">The gap widens by one every few times a waiting entrant is passed over, so nobody sits all night waiting for a perfect match. Avoiding rematches is priced in strength points: on a lopsided field, "strong" buys variety by pairing people further apart.</p>`,
  groups: () => `
    <div class="inline">
      <div class="field" style="max-width:110px"><label for="c-groups">Groups</label>
        <input id="c-groups" value="${esc(form.c_groups ?? 2)}" data-f="c_groups" inputmode="numeric"></div>
      <div class="field" style="max-width:150px"><label for="c-adv">Advance per group</label>
        <input id="c-adv" value="${esc(form.c_adv ?? 2)}" data-f="c_adv" inputmode="numeric"></div>
      <label class="pick"><input type="checkbox" id="c-ko" data-f="c_ko" ${form.c_ko !== false ? 'checked' : ''}> then a knockout</label>
      <label class="pick"><input type="checkbox" id="c-third" data-f="c_third" ${form.c_third ? 'checked' : ''}> third place match</label>
    </div>`,
  single_elim: () => `<label class="pick"><input type="checkbox" id="c-third" data-f="c_third" ${form.c_third ? 'checked' : ''}> third place match</label>`,
  swiss: () => `
    <div class="inline">
      <div class="field" style="max-width:110px"><label for="c-rounds">Rounds</label>
        <input id="c-rounds" value="${esc(form.c_rounds ?? 5)}" data-f="c_rounds" inputmode="numeric"></div>
      <label class="pick"><input type="checkbox" id="c-cont" data-f="c_cont" ${form.c_cont ? 'checked' : ''}> continuous (no round barrier)</label>
    </div>
    <p class="sub">Continuous Swiss pairs on demand instead of in lockstep rounds, so tables never idle waiting on the one match that went to deuce in the fifth.</p>
    <div class="inline">
      <label class="pick"><input type="checkbox" id="c-swko" data-f="c_swko" ${form.c_swko ? 'checked' : ''}> then a knockout</label>
      <div class="field" style="max-width:150px"><label for="c-swadv">Advance to KO</label>
        <input id="c-swadv" value="${esc(form.c_swadv ?? 4)}" data-f="c_swadv" inputmode="numeric"></div>
      <label class="pick"><input type="checkbox" id="c-third" data-f="c_third" ${form.c_third ? 'checked' : ''}> third place match</label>
    </div>
    <p class="sub">With rounds set, the top finishers cross into a bracket the instant the last round is done. With "continuous", there's no round count to finish on — use "Cut to knockout now" on the running format when you're ready, or if you're short on time part-way through the rounds.</p>`,
};

function tabFormats() {
  const kind = form.f_kind || 'open_play';
  const needsEntrants = kind !== 'open_play';
  return `<div class="form">
    <fieldset><legend>New format</legend>
      <div class="inline">
        <div class="field"><label for="f-kind">Format</label>
          <select id="f-kind" data-f="f_kind">
            <option value="open_play" ${kind === 'open_play' ? 'selected' : ''}>Open play (queue)</option>
            <option value="groups" ${kind === 'groups' ? 'selected' : ''}>Groups (+ knockout)</option>
            <option value="single_elim" ${kind === 'single_elim' ? 'selected' : ''}>Straight knockout</option>
            <option value="swiss" ${kind === 'swiss' ? 'selected' : ''}>Swiss</option>
          </select></div>
        <div class="field"><label for="f-name">Name</label>
          <input id="f-name" value="${esc(form.f_name || '')}" data-f="f_name" placeholder="Main draw"></div>
        ${S.cups.length ? `<div class="field" style="max-width:150px"><label for="f-cup">Cup</label>
          <select id="f-cup" data-f="f_cup">
            <option value="">None</option>
            ${S.cups.map(c => `<option value="${c.id}" ${form.f_cup === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
          </select></div>` : ''}
      </div>
      <div class="inline">
        <div class="field" style="max-width:120px"><label for="f-bo">Best of</label>
          <select id="f-bo" data-f="f_bo">${[1, 3, 5, 7].map(n =>
            `<option value="${n}" ${+(form.f_bo ?? 3) === n ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
        <div class="field" style="max-width:120px"><label for="f-pts">Points to</label>
          <select id="f-pts" data-f="f_pts">${[11, 21].map(n =>
            `<option value="${n}" ${+(form.f_pts ?? 11) === n ? 'selected' : ''}>${n}</option>`).join('')}</select></div>
      </div>
      ${(KIND_FIELDS[kind] || (() => ''))()}
      ${needsEntrants ? `<div class="hr"></div>
        <label style="font-size:12.5px;color:var(--muted)">Who is in it</label>
        <div class="pickers">${S.entrants.map(e => `
          <label class="pick"><input type="checkbox" data-ent="${e.id}"
            ${form.ents && form.ents[e.id] ? 'checked' : ''}> ${esc(e.name)}
            <span style="color:var(--dim)">${e.strength}</span></label>`).join('')}</div>
        <button class="ghost tiny" data-act="pick-all">Select everyone</button>` : ''}
      <div><button class="primary" data-act="add-format">Create format</button></div>
    </fieldset>

    <div class="hr"></div>
    ${S.formats.map(f => {
      const canCutKo = f.kind === 'swiss' && f.status === 'running' && f.phase !== 'ko';
      return `<div class="inline" style="align-items:center">
      <div class="field"><label>${esc({open_play:'Open play',groups:'Groups',single_elim:'Knockout',swiss:'Swiss'}[f.kind]||f.kind)}</label>
        <input value="${esc(f.name)}" disabled></div>
      ${S.cups.length ? `<div class="field" style="max-width:140px"><label>Cup</label>
        <select data-fcup="${f.id}">
          <option value="">No cup</option>
          ${S.cups.map(c => `<option value="${c.id}" ${f.cup_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
        </select></div>` : ''}
      <span class="chip">${f.status}${f.phase ? ' · ' + f.phase : ''}</span>
      ${f.status !== 'running' ? `<button class="primary tiny" data-act="start-format" data-i="${f.id}">Start</button>` : ''}
      ${canCutKo ? `<button class="ghost tiny" data-act="cut-ko" data-i="${f.id}">Cut to knockout now</button>` : ''}
      ${f.status !== 'setup' ? `<button class="ghost tiny" data-act="reset-format" data-i="${f.id}">Reset</button>` : ''}
      <button class="ghost tiny" data-act="rm-format" data-i="${f.id}">Remove</button>
    </div>`;
    }).join('') || '<p class="blank">No formats yet.</p>'}
    <p class="sub">Two formats can run at once and share the tables. A knockout on tables 1 and 2 while everyone already eliminated keeps playing open queue on table 3. "Reset" clears a format's matches and results but keeps its settings and entrants, so you can start it again clean.</p>
  </div>`;
}

function tabQueue() {
  const qf = S.formats.filter(f => f.uses_queue && f.status === 'running');
  if (!qf.length) return `<p class="blank">Start an open play or continuous Swiss format first.</p>`;
  return `<div class="form">
    ${qf.map(f => `<fieldset><legend>${esc(f.name)}</legend>
      <div class="pickers">${S.entrants.map(e => `
        <label class="pick">${esc(e.name)}
          <span style="flex:1"></span>
          ${e.queued ? `<button class="ghost tiny" data-act="leave" data-e="${e.id}">Out</button>`
                     : `<button class="tiny" data-act="join" data-e="${e.id}" data-i="${f.id}">In</button>`}
        </label>`).join('')}</div></fieldset>`).join('')}
    <button class="ghost tiny" data-act="join-all" data-i="${qf[0].id}">Put everyone in ${esc(qf[0].name)}</button>
  </div>`;
}

function tabLog() {
  return `<div class="form">
    <p class="sub">Every change is an event. Rewinding drops everything after that point and rebuilds the evening from scratch.</p>
    ${S.history.map(h => `<div class="inline" style="align-items:center;gap:8px">
      <span class="meta" style="width:48px;color:var(--dim)">${h.seq}</span>
      <span style="flex:1;font-size:13px">${esc(h.type)} <span style="color:var(--muted)">${esc(JSON.stringify(h.payload).slice(0, 70))}</span></span>
      <button class="ghost tiny" data-act="rewind" data-s="${h.seq}">Rewind here</button>
    </div>`).join('')}
    <div class="hr"></div>
    <fieldset><legend>Danger zone</legend>
      <p class="sub">Wipes players, teams, tables, formats, cups and every match — a totally blank event. Your admin and referee links keep working, nothing to redistribute.</p>
      <button class="danger" data-act="reset-event">Reset everything</button>
    </fieldset>
  </div>`;
}

function tabAccess() {
  const base = location.origin;
  return `<div class="form">
    <div class="field"><label>Everyone (read only)</label><div class="key">${base}/</div></div>
    <div class="field"><label>Referees — table screens, can enter results</label>
      <div class="key">${base}/r/${esc(S.keys.referee || '')}</div></div>
    <div class="field"><label>Admin — that is this page</label>
      <div class="key">${base}/a/${esc(S.keys.admin || '')}</div></div>
    <p class="sub">No accounts, no logins. Keep the referee link to the people running tables — anyone who has it can enter results.</p>
    <div><a href="/print?base=${encodeURIComponent(base + '/')}" target="_blank"><button class="primary">Open printable poster</button></a></div>
    <p class="sub">A QR code for the spectator link, sized to print and tape to the wall. Your URL never changes, so print it once.</p>
    <div class="hr"></div>
    <div class="inline">
      <div class="field"><label for="ev-title">Event name</label>
        <input id="ev-title" value="${esc(S.event.name || '')}" data-f="evname"></div>
      <button class="tiny" data-act="save-event">Save</button>
    </div>
  </div>`;
}

/* --------------------------------------------------------------- events */

document.addEventListener('input', e => {
  const g = e.target.dataset.g;
  if (g) {
    const [mid, i, side] = g.split('|');
    const v = e.target.value.replace(/[^0-9]/g, '').slice(0, 2);
    e.target.value = v;
    drafts[mid] = drafts[mid] || [];
    while (drafts[mid].length <= +i) drafts[mid].push(['', '']);
    drafts[mid][+i][+side] = v;
    renderTables();
    const back = document.getElementById(e.target.id);
    if (back) { back.focus(); try { back.setSelectionRange(99, 99); } catch (x) { } }
    return;
  }
  const f = e.target.dataset.f;
  if (f) form[f] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  const rq = e.target.dataset.rq;
  if (rq) drafts['rq-' + rq] = e.target.checked;
});

document.addEventListener('change', e => {
  const f = e.target.dataset.f;
  if (f) {
    form[f] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    if (f === 'f_kind' || f === 'c_mode') renderSheet();
  }
  const ent = e.target.dataset.ent;
  if (ent) { form.ents = form.ents || {}; form.ents[ent] = e.target.checked; }
  const fcup = e.target.dataset.fcup;
  if (fcup) api('update_format', { id: fcup, config: { cup_id: e.target.value } });
});

document.addEventListener('click', async e => {
  const tab = e.target.dataset.tab;
  if (tab) { sheetTab = tab; renderSheet(); return; }
  const cup = e.target.closest('button[data-cup]');
  if (cup) { setCup(cup.dataset.cup); return; }
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const a = b.dataset.act;
  const num = v => { const n = parseFloat(v); return isNaN(n) ? 0 : n; };

  if (a === 'clear') { drafts[b.dataset.m] = [['', '']]; renderTables(); return; }

  if (a === 'report') {
    const mid = b.dataset.m;
    const games = (drafts[mid] || []).filter(g => g[0] !== '' && g[1] !== '')
      .map(g => [+g[0], +g[1]]);
    const ok = await api('report', { match_id: mid, games, requeue: drafts['rq-' + mid] !== false });
    if (ok) { delete drafts[mid]; delete drafts['rq-' + mid]; }
    return;
  }
  if (a === 'void') return void api('void_match', { match_id: b.dataset.m });
  if (a === 'unassign') return void api('unassign', { match_id: b.dataset.m });
  if (a === 'jump') {
    const free = S.tables.find(t => !t.paused && !t.match);
    if (!free) return toast('No free table right now');
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
  if (a === 'save-table') {
    const t = S.tables.find(x => x.number == b.dataset.t);
    return void api('set_table', {
      number: +b.dataset.t,
      name: form['tn-' + b.dataset.t] ?? t.name,
      cup_id: form['tc-' + b.dataset.t] ?? (t.cup_id || '') });
  }

  if (a === 'add-cup') {
    if (!form.cupname) return toast('Give the cup a name');
    await api('add_cup', { name: form.cupname });
    form.cupname = ''; renderSheet();
    return;
  }
  if (a === 'save-cup') return void api('update_cup', {
    id: b.dataset.c, name: form['cn-' + b.dataset.c] ?? '' });
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
  if (a === 'save-player') {
    const p = b.dataset.p;
    return void api('update_player', {
      id: p, name: form['n-' + p], strength: num(form['s-' + p] ?? 5) });
  }
  if (a === 'toggle-player') {
    const p = S.players.find(x => x.id === b.dataset.p);
    return void api('update_player', { id: p.id, active: !p.active });
  }

  if (a === 'pick-all') {
    form.ents = {};
    S.entrants.forEach(en => form.ents[en.id] = true);
    return renderSheet();
  }
  if (a === 'add-format') {
    const kind = form.f_kind || 'open_play';
    const cfg = { scoring: { best_of: +(form.f_bo ?? 3), points_to: +(form.f_pts ?? 11) } };
    if (kind === 'open_play') Object.assign(cfg, {
      mode: form.c_mode || 'pairs', base_gap: num(form.c_gap ?? 1.5),
      widen_every: num(form.c_widen ?? 3) || 3,
      rematch_weight: num(form.c_rw ?? 0.6), avoid_rematch: num(form.c_rw ?? 0.6) > 0,
    });
    if (kind === 'groups') Object.assign(cfg, {
      n_groups: num(form.c_groups ?? 2) || 1, then_ko: form.c_ko !== false,
      advance_per_group: num(form.c_adv ?? 2) || 1, third_place: !!form.c_third,
    });
    if (kind === 'single_elim') cfg.third_place = !!form.c_third;
    if (kind === 'swiss') Object.assign(cfg, {
      rounds: num(form.c_rounds ?? 5) || 5, continuous: !!form.c_cont,
      then_ko: !!form.c_swko, advance: num(form.c_swadv ?? 4) || 4,
      third_place: !!form.c_third,
    });
    if (form.f_cup) cfg.cup_id = form.f_cup;
    const ents = Object.entries(form.ents || {}).filter(([, v]) => v).map(([k]) => k);
    if (kind !== 'open_play' && ents.length < 2) return toast('Pick at least two entrants');
    await api('add_format', { kind, name: form.f_name || '', config: cfg, entrant_ids: ents });
    form.f_name = ''; form.ents = {}; renderSheet();
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
  if (a === 'reset-event') {
    if (!confirm('Wipe EVERYTHING — players, teams, tables, formats, cups, all matches? This cannot be undone.')) return;
    return void api('reset_event', {});
  }
  if (a === 'save-event') return void api('event_meta', { name: form.evname || '' });
});

$('setup-btn').onclick = () => { sheetOpen = true; $('sheet').hidden = false; renderSheet(); };
$('sheet-close').onclick = () => { sheetOpen = false; $('sheet').hidden = true; };
$('sheet').addEventListener('click', e => {
  if (e.target.id === 'sheet') { sheetOpen = false; $('sheet').hidden = true; }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && sheetOpen) { sheetOpen = false; $('sheet').hidden = true; }
});

poll(true);
connectStream();
setInterval(() => { if (!streamOk) poll(); }, 2500);   // fallback only
setInterval(() => { if (streamOk) poll(); }, 20000);   // slow reconcile
