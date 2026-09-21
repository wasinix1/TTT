/* The public site. Deliberately not the console: its own tiny payload from
   /api/public, so nothing admin-shaped can leak onto a page anyone can open,
   and a cold phone on hall wifi has almost nothing to download. */

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const KIND = {
  open_play: 'Offenes Spiel', groups: 'Gruppen', single_elim: 'K.o.-Runde', swiss: 'Schweizer System',
};
const ENTRY = { single: 'Einzel', pair: 'Doppel' };
const PLACE = { 1: '1.', 2: '2.', 3: '3.' };

let P = null;
let skew = 0;          // server clock minus ours, so the countdown is honest

/* The form lives at /join on the same page. Its draft is kept here rather
   than read off the DOM, so a background refresh of the event details never
   takes half-typed answers with it. */
const joining = () => location.pathname === '/join';
/* The form is on the landing itself while entries are open, and still has its
   own page at /join for links that point straight at it. */
const showJoin = () => joining() || (!!P && (P.phase === 'registration' || P.phase === 'announced')
  && P.cups.some(c => c.registration === 'open'));
let draft = { cup_id: '', kind: 'single', name: '', strength: '5',
              partner_name: '', partner_strength: '5', team_name: '', note: '' };
let sending = false, error = '';

// what this phone already sent, so coming back says so instead of quietly
// taking a second entry
function mine() {
  try { return JSON.parse(localStorage.getItem('tt_reg') || 'null'); }
  catch (e) { return null; }
}
function remember(v) {
  try { localStorage.setItem('tt_reg', JSON.stringify(v)); } catch (e) { }
}

/* dd/mm/yy, and the time on its own, so the date fits one display-scale line */
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${p(d.getFullYear() % 100)}`;
}

/* 17:00 or 17:00–2:00 — hours unpadded, minutes always two digits */
function fmtTime(iso, end) {
  const d = new Date(iso);
  if (isNaN(d) || !/T\d/.test(iso || '')) return '';
  const hm = (h, m) => `${h}:${String(m).padStart(2, '0')}`;
  const from = hm(d.getHours(), d.getMinutes());
  const m = /^(\d{1,2}):(\d{2})/.exec(end || '');
  return m ? `${from}–${hm(+m[1], +m[2])}` : from;
}

function render() {
  renderJoin();
  $('name').textContent = P.name;
  $('kicker').textContent =
    P.phase === 'registration' ? 'Anmeldung offen'
      : P.phase === 'done' ? 'Ergebnisse' : 'Demnächst';
  // while entries are open the page is just the lockup, the date, the way in
  document.body.classList.toggle('pre', showJoin());

  const b = $('blurb');
  b.hidden = !P.blurb;
  b.textContent = P.blurb || '';

  const facts = [];
  if (P.starts_at) facts.push(['When', fmtDate(P.starts_at)]);
  // only the place, not the street address: "Funkhaus, Argentinierstraße" shows as "Funkhaus"
  if (P.venue) facts.push(['Where', P.venue.split(',')[0].trim()]);
  if (fmtTime(P.starts_at, P.ends_at)) facts.push(['Time', fmtTime(P.starts_at, P.ends_at)]);
  $('facts').innerHTML = facts.map(([k, v]) =>
    `<div class="fact${k === 'Where' ? ' venue' : ''}"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('');

  const done = P.phase === 'done';
  $('cups-head').textContent = done ? 'So ist es ausgegangen' : 'Was gespielt wird';
  // on the form, the cup picker is the list — showing both says it twice
  $('cups-section').hidden = !P.cups.length || showJoin();
  $('cups').innerHTML = P.cups.map(c => cupCard(c, done)).join('');

  // an event with entries open but no cup taking them would be a dead end;
  // say so rather than showing a page with nothing to do on it
  const note = $('cups-note');
  const anyOpen = P.cups.some(c => c.registration === 'open');
  note.hidden = !(P.phase === 'announced' && P.cups.length && !anyOpen);
  note.textContent = 'Die Anmeldung ist noch nicht offen — schau kurz vor dem Termin wieder vorbei.';

  const open = P.cups.filter(c => c.registration === 'open');
  const already = mine();
  const cta = $('cta-slot');
  if (cta) {
    cta.innerHTML = (!joining() && open.length && !done)
      ? (already
          ? `<a class="cta" href="#join">Noch jemanden anmelden</a>`
          : `<a class="cta" href="#join">Voranmelden</a>`)
      : '';
  }

  $('foot-note').textContent = done
    ? 'Tabelle und alle Ergebnisse gibt es auf der Live-Seite.'
    : 'Kein Konto nötig — die Live-Seite ist für alle offen.';

  tick();
}

/* -------------------------------------------------------------- the form */

/* Strength is parked: the form does not ask, and the server takes its
   default. Flip this to bring the questions back. */
const ASK_STRENGTH = false;

const STRENGTHS = [
  [1, '1 — never really played'], [2, '2'], [3, '3 — I can rally'],
  [4, '4'], [5, '5 — a decent social game'], [6, '6'], [7, '7 — club standard'],
  [8, '8'], [9, '9'], [10, '10 — league player'],
];

/* the dark tile names the cups; the form sits beside it */
function joinShell(inner, open) {
  const list = open.map(c => `<div><b>${esc(c.name)}</b>${ENTRY[c.entry] ? ' <i>·</i> ' + ENTRY[c.entry] : ''}</div>`).join('');
  return `<div class="join-grid">
    <div class="join-note"><h2>Voranmelden</h2><div class="cups-list">${list}</div></div>
    <div class="join-form"><div class="jf">${inner}</div></div>
  </div>`;
}
const backLink = () => joining() ? '<a class="back" href="/">← Zurück zur Veranstaltung</a>' : '';

function renderJoin() {
  const box = $('join');
  if (!showJoin()) { box.hidden = true; return; }
  box.hidden = false;

  const open = P.cups.filter(c => c.registration === 'open');
  if (P.phase === 'live' || P.phase === 'doors') {
    box.innerHTML = `<h2>Anmeldung</h2>
      <p class="blank">Die Veranstaltung läuft — sprich die Leute vor Ort an.</p>
      <a class="back" href="/">← Zurück zur Veranstaltung</a>`;
    return;
  }
  if (!open.length) {
    box.innerHTML = `<h2>Anmeldung</h2>
      <p class="blank">Gerade nimmt nichts Anmeldungen an.</p>
      <a class="back" href="/">← Zurück zur Veranstaltung</a>`;
    return;
  }
  if (draft.done) {
    box.innerHTML = joinShell(`<div class="done-card">
        <h2>Du stehst auf der Liste</h2>
        <p>${esc(draft.done.name)} — ${esc(draft.done.cup)}</p>
        <p>Mehr ist nicht nötig. Wir bestätigen alle am Abend selbst — komm einfach vorbei.</p>
      </div>
      <button class="cta ghost" data-act="again">Noch jemanden anmelden</button>
      ${backLink()}`, open);
    return;
  }
  if (!draft.cup_id || !open.some(c => c.id === draft.cup_id)) draft.cup_id = open[0].id;
  const cup = open.find(c => c.id === draft.cup_id);
  const pair = cup.entry === 'pair';
  const cupLabel = c => c.name + (ENTRY[c.entry] ? ' · ' + ENTRY[c.entry] : '');

  box.innerHTML = joinShell(`<div class="jform">
    <label class="sr" for="j-name">Name</label>
    <input id="j-name" value="${esc(draft.name)}" data-j="name" placeholder="Name"
           autocomplete="name" autocapitalize="words" enterkeyhint="next">

    ${open.length > 1 ? `<label class="sr" for="j-cup">Kategorie</label>
      <div class="selectwrap"><select id="j-cup" data-j="cup_id">
        ${open.map(c => `<option value="${c.id}" ${c.id === draft.cup_id ? 'selected' : ''}>${esc(cupLabel(c))}</option>`).join('')}
      </select></div>` : ''}

    ${pair ? `<div class="choice">
        <button data-kind="pair" class="${draft.kind === 'pair' ? 'on' : ''}">
          <span class="t">Mit Partner:in</span><span class="s">Ihr spielt zusammen</span></button>
        <button data-kind="seeking" class="${draft.kind === 'seeking' ? 'on' : ''}">
          <span class="t">Partner:in gesucht</span><span class="s">Wir teilen euch am Abend ein</span></button>
      </div>` : ''}

    ${pair && draft.kind === 'pair' ? `
      <label class="sr" for="j-pname">Teampartner:in</label>
      <input id="j-pname" class="partner" value="${esc(draft.partner_name)}" data-j="partner_name"
             placeholder="Teampartner:in" autocomplete="off" autocapitalize="words">
      <label class="sr" for="j-team">Teamname</label>
      <input id="j-team" class="partner" value="${esc(draft.team_name)}" data-j="team_name"
             placeholder="Teamname" autocomplete="off">` : ''}

    <label class="sr" for="j-note">Anmerkung</label>
    <textarea id="j-note" data-j="note" rows="2" placeholder="Anmerkung (optional)">${esc(draft.note)}</textarea>

    ${error ? `<div class="err">${esc(error)}</div>` : ''}
    <button class="cta send" data-act="send" ${sending ? 'disabled' : ''}>${sending ? 'Sende …' : 'Abschicken'}</button>
    ${backLink()}</div>`, open);
}

async function send() {
  if (sending) return;
  if (!draft.name.trim()) { error = 'Wir brauchen einen Namen.'; return renderJoin(); }
  sending = true; error = ''; renderJoin();
  try {
    const r = await fetch('/api/action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'register', data: draft }),
    });
    const j = await r.json().catch(() => ({ error: 'Da ist etwas schiefgegangen.' }));
    if (!r.ok) { error = j.error || 'Da ist etwas schiefgegangen.'; }
    else {
      draft.done = { name: draft.name, cup: j.cup };
      remember({ id: j.registration_id, name: draft.name, cup: j.cup });
    }
  } catch (e) {
    error = 'Gerade keine Verbindung — versuch es gleich noch einmal.';
  }
  sending = false;
  renderJoin();
}

function cupCard(c, done) {
  const meta = [KIND[c.format] || '', ENTRY[c.entry] || ''].filter(Boolean);
  const line = [c.blurb, c.format_line, c.scoring].filter(Boolean);
  const podium = (c.podium || []).map(p => `<div class="${p.place === 1 ? 'win' : ''}">
      <span class="pl">${PLACE[p.place] || p.place}</span>
      <span class="who">${esc(p.name)}</span>
      ${p.record ? `<span class="rec">${esc(p.record)}</span>` : ''}
    </div>`).join('');
  return `<div class="cup">
    <div class="body">
      <div class="name">${esc(c.name)}</div>
      ${meta.length ? `<div class="meta">${meta.map(esc).join(' · ')}</div>` : ''}
      ${line.length ? `<div class="line">${line.map(esc).join(' · ')}</div>` : ''}
      ${podium ? `<div class="podium">${podium}</div>` : ''}
      ${done && !podium ? `<div class="line">Keine Ergebnisse erfasst.</div>` : ''}
    </div>
    ${!done && c.registration === 'open' ? '<span class="tag open">Anmeldung offen</span>' : ''}
  </div>`;
}

function tick() {
  const box = $('count');
  if (!P || !P.starts_ts || P.phase === 'done') { box.hidden = true; return; }
  let left = P.starts_ts - (Date.now() / 1000 + skew);
  if (left <= 0) { box.hidden = true; return; }
  box.hidden = false;
  const d = Math.floor(left / 86400); left -= d * 86400;
  const h = Math.floor(left / 3600); left -= h * 3600;
  const m = Math.floor(left / 60);
  const s = Math.floor(left - m * 60);
  const parts = d ? [[d, 'Tage'], [h, 'Std'], [m, 'Min']]
                  : [[h, 'Std'], [m, 'Min'], [s, 'Sek']];
  box.innerHTML = parts.map(([n, l]) =>
    `<div><div class="n">${n}</div><div class="l">${l}</div></div>`).join('');
}

async function load() {
  try {
    const r = await fetch('/api/public');
    const p = await r.json();
    skew = p.now - Date.now() / 1000;
    P = p;
    // the clock has moved the event on — the console is what belongs at this
    // URL now, and the server will serve it on the way back in
    if ((p.phase === 'doors' || p.phase === 'live') && !joining()) {
      location.reload();
      return;
    }
    render();
  } catch (e) { /* transient; the next tick catches up */ }
}

document.addEventListener('input', e => {
  const k = e.target.dataset.j;
  if (k) draft[k] = e.target.value;
});
document.addEventListener('change', e => {
  const k = e.target.dataset.j;
  if (!k) return;
  draft[k] = e.target.value;
  // a different cup can mean a different kind of entry, so the fields change
  if (k === 'cup_id') { draft.kind = 'single'; error = ''; renderJoin(); }
});
document.addEventListener('click', e => {
  const cup = e.target.closest('button[data-cup]');
  if (cup) { draft.cup_id = cup.dataset.cup; error = ''; return renderJoin(); }
  const kind = e.target.closest('button[data-kind]');
  if (kind) { draft.kind = kind.dataset.kind; error = ''; return renderJoin(); }
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  if (b.dataset.act === 'send') return void send();
  if (b.dataset.act === 'again') {
    draft = { cup_id: draft.cup_id, kind: draft.kind, name: '', strength: '5',
              partner_name: '', partner_strength: '5', team_name: '', note: '' };
    error = '';
    renderJoin();
  }
});

load();
setInterval(load, 30000);
setInterval(tick, 1000);
