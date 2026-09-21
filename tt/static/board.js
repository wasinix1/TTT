/* The wall display. Read-only, no controls, refreshes itself.
   It answers one question — when am I playing — and nothing else. */

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = id => document.getElementById(id);

/* How many rows fit depends on the screen, so measure rather than guess:
   a cut-off row is worse than a shorter list. */
function fits() {
  return Math.max(4, Math.floor(window.innerHeight * 0.62 / (window.innerHeight * 0.0315)));
}

/* Columns for the tables in play, so the blocks are always equal and never a
   full-width straggler: 3 tables are 3 across (or stacked when cups share the
   width), 4 are 2x2, and so on. */
function colsFor(n, multi) {
  if (n <= 2) return Math.max(1, n);
  if (multi) return n % 2 === 0 ? 2 : 1;
  return n <= 3 ? n : n % 3 === 0 ? 3 : n % 2 === 0 ? 2 : 3;
}

function when(r) {
  if (r.blocked) return 'still playing';
  if (r.on_deck) return 'get ready';
  if (r.eta_min == null) return '';
  return r.eta_min <= 5 ? 'a few min' : '~' + r.eta_min + ' min';
}

function render(S) {
  $('title').textContent = S.event.name || 'Coming up';
  const bs = (S.board || []);
  if (!bs.length) {
    $('cups').innerHTML = `<div class="cup"><h2>Nothing running yet</h2></div>`;
    $('sub').textContent = '';
    return;
  }
  const cap = fits();
  $('cups').innerHTML = bs.map(b => {
    const cup = S.cups.find(c => c.id === b.cup_id);
    const now = b.playing.map(m => `<div class="now">
      <div class="t">TABLE ${m.table}</div>
      <div class="p">${esc(m.a)}</div>
      <div class="p">${esc(m.b)}</div></div>`).join('')
      || `<div class="now"><div class="t">&nbsp;</div><div class="p">No match on yet</div></div>`;
    const rows = b.up.slice(0, cap).map(r => `
      <div class="q ${r.on_deck ? 'ondeck' : ''}">
        <span class="n">${r.position}</span>
        <span class="w">${esc(r.a)}${r.b ? ' v ' + esc(r.b) : ''}</span>
        ${when(r) ? `<span class="e when">${esc(when(r))}</span>` : ''}
      </div>`).join('');
    const more = b.total > cap ? `<div class="q"><span class="n"></span>
      <span class="w" style="color:var(--muted)">and ${b.total - cap} more</span></div>` : '';
    return `<div class="cup">
      <h2>${esc(cup ? cup.name : (S.event.name || 'Tonight'))}
        <span>${esc(b.tables_label)} · ~${b.match_minutes} min a match</span></h2>
      <div class="live" style="--cols:${colsFor(b.playing.length, bs.length > 1 && window.innerWidth > window.innerHeight)}">${now}</div>
      <div class="list">${rows || '<div class="q"><span class="w" style="color:var(--muted)">Nobody waiting</span></div>'}${more}</div>
    </div>`;
  }).join('');
  const waiting = bs.reduce((n, b) => n + b.waiting, 0);
  const left = bs.reduce((n, b) => n + b.total, 0);
  $('sub').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  $('note').textContent = left ? `${left} still to play` + (waiting ? `, ${waiting} waiting` : '') : '';
}

let last = -1, etag = null;
async function poll() {
  try {
    const h = {};
    if (etag) h['If-None-Match'] = etag;
    const r = await fetch('/api/state', { headers: h });
    if (r.status === 304) return;
    etag = r.headers.get('ETag');
    const s = await r.json();
    if (s.version !== last) { last = s.version; render(s); }
  } catch (e) { /* the next tick will catch up */ }
}

/* Same push-then-poll arrangement the console uses: a result lands on the
   wall in about the time it takes the referee to look up. */
function stream() {
  let es;
  try { es = new EventSource('/api/stream'); } catch (e) { return; }
  es.onmessage = e => { if (+e.data !== last) poll(); };
  es.onerror = () => { es.close(); setTimeout(stream, 3000); };
}

poll();
stream();
setInterval(poll, 15000);
setInterval(() => { if (last >= 0) poll(); }, 60000);
window.addEventListener('resize', () => { last = -1; poll(); });
