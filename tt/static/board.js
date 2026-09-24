/* The wall display. Read-only, no controls, refreshes itself.
   It answers one question — when am I playing — and nothing else. */

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = id => document.getElementById(id);

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
  return 'circa! in ' + r.eta_min + 'min.';
}

/* v2: rows are bigger, so how many fit is measured after layout rather than
   estimated — a cut-off row is worse than a shorter list. Rows that do not
   fit are removed and replaced by one "and N more" line. */
function fit() {
  document.querySelectorAll('#cups .list').forEach(list => {
    const total = +list.dataset.total || 0;
    const rows = [...list.querySelectorAll('.q[data-r]')];
    const old = list.querySelector('.q.more');
    if (old) old.remove();
    const bottom = list.getBoundingClientRect().bottom;
    let shown = rows.findIndex(r => r.getBoundingClientRect().bottom > bottom + 1);
    if (shown < 0) shown = rows.length;
    rows.slice(shown).forEach(r => r.remove());
    if (shown >= total) return;
    const more = document.createElement('div');
    more.className = 'q more';
    list.appendChild(more);
    const label = () => { more.innerHTML = `<span class="n"></span><span class="w">and ${total - shown} more</span>`; };
    label();
    while (shown > 0 && more.getBoundingClientRect().bottom > bottom + 1) {
      rows[--shown].remove();
      label();
    }
  });
}

function render(S) {
  $('title').textContent = S.event.name || 'Coming up';
  const bs = (S.board || []);
  const clock = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  $('sub').textContent = clock;
  if (!bs.length) {
    $('cups').innerHTML = `<div class="cup"><h2>Nothing running yet</h2></div>`;
    $('note').textContent = '';
    return;
  }
  $('cups').innerHTML = bs.map(b => {
    const cup = S.cups.find(c => c.id === b.cup_id);
    const now = b.playing.map(m => `<div class="now">
      <div class="t">Jetzt · Tisch ${m.table}</div>
      <div class="p">${esc(m.a)} — ${esc(m.b)}</div></div>`).join('')
      || `<div class="now"><div class="t">&nbsp;</div><div class="p">No match on yet</div></div>`;
    const rows = b.up.map(r => `
      <div class="q ${r.on_deck ? 'ondeck' : ''}" data-r>
        <span class="n">${r.position}</span>
        <span class="w">${esc(r.a)}${r.b ? ' — ' + esc(r.b) : ''}</span>
        ${when(r) ? `<span class="e when">${esc(when(r))}</span>` : ''}
      </div>`).join('');
    return `<div class="cup">
      <h2>${esc(cup ? cup.name : (S.event.name || 'Tonight'))}
        <span>${esc(b.tables_label)}</span></h2>
      <div class="live" style="--cols:${colsFor(b.playing.length, bs.length > 1 && window.innerWidth > window.innerHeight)}">${now}</div>
      <div class="list" data-total="${b.total}">${rows || '<div class="q"><span class="w" style="color:var(--muted)">Nobody waiting</span></div>'}</div>
    </div>`;
  }).join('');
  fit();
  if (document.fonts && document.fonts.status !== 'loaded') document.fonts.ready.then(() => { last = -1; poll(); });
  const waiting = bs.reduce((n, b) => n + b.waiting, 0);
  const left = bs.reduce((n, b) => n + b.total, 0);
  $('note').textContent = left ? `${left} still to play` + (waiting ? `, ${waiting} waiting` : '') : '';
}

let last = -1, etag = null;
async function poll() {
  try {
    const h = {};
    if (etag && last >= 0) h['If-None-Match'] = etag;
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
