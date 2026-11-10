/* Self check-in — the page behind the QR code on the hall wall.

   Three ways in, all ending in the server's op_checkin, which runs the same
   admit the desk does: the entry this phone made (its saved link), a name
   picked from who is still expected, or a walk-in typed in. The venue code
   from the poster rides along on every request; without it nothing here
   works. */

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ENTRY = { single: 'Einzel', pair: 'Doppel' };
// "Einzel · Einzel" says nothing twice
const cupLabel = c => c.name + (ENTRY[c.entry] && !c.name.toLowerCase().includes(ENTRY[c.entry].toLowerCase())
  ? ' · ' + ENTRY[c.entry] : '');

const CODE = new URLSearchParams(location.search).get('v') || '';
let INFO = null;
let found = [], q = '';
let walk = { cup_id: '', kind: 'seeking', name: '', partner_name: '' };
let busy = false, error = '', result = null;

async function call(op, data) {
  const r = await fetch('/api/action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op, data: { code: CODE, ...data } }),
  });
  const j = await r.json().catch(() => ({ error: 'Da ist etwas schiefgegangen.' }));
  if (!r.ok) throw new Error(j.error || 'Da ist etwas schiefgegangen.');
  return j;
}

/* the public site keeps what this phone registered in tt_regs (site.js);
   the server says which of those are still open (INFO.mine) */
function saved(event) {
  try {
    return (JSON.parse(localStorage.getItem('tt_regs') || '[]') || [])
      .filter(x => x && x.token && (!event || x.event === event));
  } catch (e) { return []; }
}
const status = x => (INFO.mine || {})[x.token] || '';
function remember(v) {
  try {
    const all = (JSON.parse(localStorage.getItem('tt_regs') || '[]') || []).filter(x => x && x.token);
    v = { ...v, event: INFO.event_id };
    localStorage.setItem('tt_reg', JSON.stringify(v));
    localStorage.setItem('tt_regs', JSON.stringify(
      all.filter(x => x.token !== v.token).concat([v]).slice(-8)));
  } catch (e) { }
}

function render() {
  const app = $('app');
  if (!INFO) return;
  const head = `<p class="kicker">Einchecken</p><h1>${esc(INFO.event || 'Tischtennis')}</h1>`;
  if (result) return (app.innerHTML = head + renderResult());

  const open = INFO.cups.filter(c => !c.closed);
  const mine = saved(INFO.event_id).filter(x => status(x) === 'pending' || status(x) === 'confirmed');
  if (!walk.cup_id || !open.some(c => c.id === walk.cup_id)) walk.cup_id = (open[0] || {}).id || '';
  const cup = open.find(c => c.id === walk.cup_id);
  const pair = cup && cup.entry === 'pair';

  app.innerHTML = head + `
    ${mine.length ? `<h2>Auf diesem Handy</h2>${mine.map(x => status(x) === 'confirmed'
      ? `<p class="here">✓ <b>${esc(x.name)}</b> ist eingecheckt${x.cup ? ` · ${esc(x.cup)}` : ''}</p>`
      : `<button class="cta" data-mine="${esc(x.token)}" ${busy ? 'disabled' : ''}>Einchecken als ${esc(x.name)}${
        x.cup ? `<span class="s">${esc(x.cup)}</span>` : ''}</button>`).join('')}` : ''}

    <h2>${mine.length ? 'Jemand anderes?' : 'Schon angemeldet?'}</h2>
    <div class="block">
      <label for="q">Tippe die ersten Buchstaben deines Namens</label>
      <input id="q" value="${esc(q)}" autocomplete="off" autocapitalize="words" placeholder="Name" enterkeyhint="search">
      <div class="found">${found.map(f => `<button data-reg="${esc(f.id)}" ${busy ? 'disabled' : ''}>
        <span>${esc(f.name)}</span><small>${esc(f.cup)}</small></button>`).join('')}</div>
      ${q.trim().length >= 2 && !found.length ? '<p class="muted" style="margin:10px 0 0">Niemand Passendes auf der Liste — dann trag dich unten ein.</p>' : ''}
    </div>

    <h2>Nicht angemeldet?</h2>
    ${open.length ? `<div class="block">
      <label for="w-name">Name</label>
      <input id="w-name" data-w="name" value="${esc(walk.name)}" autocomplete="name" autocapitalize="words" placeholder="Name">
      ${open.length > 1 ? `<label for="w-cup" style="display:block;margin-top:14px">Wo spielst du mit?</label>
        <select id="w-cup" data-w="cup_id">${open.map(c => `<option value="${esc(c.id)}" ${c.id === walk.cup_id ? 'selected' : ''}>${
          esc(cupLabel(c) + (c.full ? ' · voll' : ''))}</option>`).join('')}</select>` : ''}
      ${pair ? `<div class="choice">
          <button data-kind="pair" class="${walk.kind === 'pair' ? 'on' : ''}">Mit Partner:in</button>
          <button data-kind="seeking" class="${walk.kind === 'seeking' ? 'on' : ''}">Partner:in gesucht</button>
        </div>
        ${walk.kind === 'pair' ? `<input id="w-partner" data-w="partner_name" value="${esc(walk.partner_name)}"
          autocomplete="off" autocapitalize="words" placeholder="Teampartner:in">` : ''}` : ''}
      <button class="cta" data-act="walk" ${busy ? 'disabled' : ''}>${busy ? 'Einen Moment …' : 'Eintragen und einchecken'}</button>
    </div>` : `<p class="muted">Gerade geht das nur am Eingang — die Auslosung läuft schon.</p>`}
    ${error ? `<p class="err">${esc(error)}</p>` : ''}
    <a class="back" href="/">Live-Tische ansehen →</a>`;
}

function renderResult() {
  const r = result;
  const tg = r.telegram ? `<a class="cta tg" href="${esc(r.telegram)}" target="_blank" rel="noopener">Tischaufrufe per Telegram
      <span class="s">Wir schreiben dir, wenn dein Tisch frei ist</span></a>` : '';
  const again = `<button class="cta ghost" data-act="again">Noch jemanden einchecken</button>
    <a class="cta ghost" href="/">Live-Tische ansehen</a>`;
  if (r.already) return `<div class="done"><p class="who">${esc(r.name)}</p><p class="muted">${esc(r.cup)}</p></div>
    <p>Ist schon eingecheckt — du musst nichts mehr tun.</p>
    <p class="muted">Wenn das nicht du warst, sag bitte am Eingang Bescheid.</p>${again}`;
  if (r.waiting) return `<div class="done"><p class="who">${esc(r.name)}</p><p class="muted">${esc(r.cup)}</p></div>
    <p>Du stehst auf der Liste. Sobald noch jemand ohne Partner:in eincheckt, spielt ihr zusammen und seid beide drin.</p>
    <p class="muted">Dauert es zu lange, sag am Eingang Bescheid.</p>${tg}${again}`;
  return `<div class="done"><p class="who">${esc(r.name)}</p><p class="muted">${esc(r.cup)}</p></div>
    <p><b>Du bist eingecheckt.</b> ${r.drawn ? 'Du bist im Spiel — auf der Tafel siehst du, wann du dran bist.'
      : 'Es geht los, sobald die Auslosung steht.'}</p>${tg}${again}`;
}

async function checkin(data, keep) {
  if (busy) return;
  busy = true; error = ''; render();
  try {
    result = await call('checkin', data);
    if (result.token) {
      remember({ name: result.name, cup: result.cup, token: result.token, telegram: result.telegram || '' });
      if (!result.waiting) INFO.mine = { ...INFO.mine, [result.token]: 'confirmed' };
    } else if (keep) remember(keep);
    found = []; q = ''; walk = { ...walk, name: '', partner_name: '' };
  } catch (e) { error = e.message; }
  busy = false; render();
}

let findTimer = 0, findSeq = 0;
function find() {
  clearTimeout(findTimer);
  findTimer = setTimeout(async () => {
    const mine = ++findSeq;
    if (q.trim().length < 2) { found = []; return render(); }
    try {
      const j = await call('checkin_find', { q });
      if (mine === findSeq) { found = j.found; render(); }
    } catch (e) { error = e.message; render(); }
  }, 200);
}

/* redraws replace the inputs; keep the caret where it was */
function keepFocus(fn) {
  const a = document.activeElement, id = a && a.id, pos = a && a.selectionStart;
  fn();
  const el = id && $(id);
  if (el) { el.focus(); try { el.setSelectionRange(pos, pos); } catch (e) { } }
}
const _render = render;
render = () => keepFocus(_render);

document.addEventListener('input', e => {
  if (e.target.id === 'q') { q = e.target.value; error = ''; find(); return; }
  const k = e.target.dataset.w;
  if (k) { walk[k] = e.target.value; if (k === 'cup_id') render(); }
});
document.addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.mine != null) {
    const x = saved().find(x => x.token === b.dataset.mine);
    if (x) checkin({ token: x.token }, x);
  } else if (b.dataset.reg) {
    checkin({ registration_id: b.dataset.reg });
  } else if (b.dataset.kind) {
    walk.kind = b.dataset.kind; render();
  } else if (b.dataset.act === 'walk') {
    if (!walk.name.trim()) { error = 'Wir brauchen einen Namen.'; return render(); }
    checkin({ ...walk });
  } else if (b.dataset.act === 'again') {
    result = null; error = ''; render();
  }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.dataset && e.target.dataset.w) {
    const b = document.querySelector('[data-act="walk"]');
    if (b) b.click();
  }
});

(async () => {
  if (!CODE) {
    $('app').innerHTML = `<p class="kicker">Einchecken</p><h1>Code fehlt</h1>
      <p>Scanne den QR-Code im Saal, um dich einzuchecken.</p><a class="back" href="/">Zur Veranstaltung →</a>`;
    return;
  }
  try {
    INFO = await call('checkin_info', { tokens: saved().map(x => x.token).slice(-8) });
    render();
  } catch (e) {
    $('app').innerHTML = `<p class="kicker">Einchecken</p><h1>Geht gerade nicht</h1>
      <p>${esc(e.message)}</p><a class="back" href="/">Zur Veranstaltung →</a>`;
  }
})();
