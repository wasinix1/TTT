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
/* /me/<token>: somebody's own entry, opened from the link they were given. */
const ME = (location.pathname.match(/^\/me\/([A-Za-z0-9_-]+)\/?$/) || [])[1] || '';
/* The form is on the landing itself while entries are open, and still has its
   own page at /join for links that point straight at it. */
const showJoin = () => joining() || !!ME || (!!P && (P.phase === 'registration' || P.phase === 'announced')
  && P.cups.some(c => c.registration === 'open'));
let draft = { cup_id: '', kind: 'single', name: '', strength: '5',
              partner_name: '', partner_strength: '5', team_name: '', note: '' };
let sending = false, error = '';
/* The server found an entry for exactly these two names in this cup and
   wrote nothing: the form asks whether the partner already registered them.
   Changing either name, or the cup, drops the question. */
let twice = null;

// what this phone already sent, so coming back says so instead of quietly
// taking a second entry — and keeps each entry's personal link
// Entries belong to the event they were made for: a new event starts clean.
const thisEvent = x => !P || !P.event_id || x.event === P.event_id;
function mine() {
  try {
    const v = JSON.parse(localStorage.getItem('tt_reg') || 'null');
    return v && thisEvent(v) ? v : null;
  } catch (e) { return null; }
}
function saved() {
  try {
    return (JSON.parse(localStorage.getItem('tt_regs') || '[]') || [])
      .filter(x => x && x.token && thisEvent(x));
  } catch (e) { return []; }
}
function remember(v) {
  v = { ...v, event: P && P.event_id || '' };
  try {
    localStorage.setItem('tt_reg', JSON.stringify(v));
    if (v.token) localStorage.setItem('tt_regs', JSON.stringify(
      allSaved().filter(x => x.token !== v.token).concat([v]).slice(-8)));
  } catch (e) { }
}
function allSaved() {
  try { return (JSON.parse(localStorage.getItem('tt_regs') || '[]') || []).filter(x => x && x.token); }
  catch (e) { return []; }
}
const linkFor = token => `${location.origin}/me/${token}`;

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
  if (cta && ME) cta.innerHTML = '<a class="cta" href="/">← Zur Veranstaltung</a>';
  else if (cta) {
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
  if (ME) return renderMe(box);

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
  if (draft.done && draft.done.already) {
    box.innerHTML = joinShell(`<div class="done-card">
        <h2>Alles klar</h2>
        <p>${esc(draft.done.name)} — ${esc(draft.done.cup)}</p>
        <p>Dann steht ihr schon auf der Liste. Mehr ist nicht nötig — kommt einfach vorbei.</p>
      </div>
      <button class="cta ghost" data-act="again">Jemand anderen anmelden</button>
      ${backLink()}`, open);
    return;
  }
  if (draft.done) {
    // the entry's own link into the bot: one tap and the table calls for this
    // entry come to their phone (docs/telegram.md)
    const tg = draft.done.telegram;
    box.innerHTML = joinShell(`<div class="done-card">
        <h2>Du stehst auf der Liste</h2>
        <p>${esc(draft.done.name)} — ${esc(draft.done.cup)}</p>
        ${draft.done.team ? '<p>Dein:e Partner:in muss sich nicht extra anmelden — eure Anmeldung gilt fürs ganze Team.</p>' : ''}
        <p>Mehr ist nicht nötig. Wir bestätigen alle am Abend selbst — komm einfach vorbei.</p>
        ${draft.done.token ? linkBox(draft.done.token,
          'Mit diesem Link kannst du deine Anmeldung ansehen, die Anmerkung ändern oder dich abmelden. '
          + 'Dieses Handy merkt ihn sich — schick ihn gern auch deinem Team.') : ''}
      </div>
      ${draft.done.token ? `<a class="cta" href="/me/${esc(draft.done.token)}">Anmeldung ansehen</a>` : ''}
      ${tg ? `<a class="cta tg" href="${esc(tg)}" target="_blank" rel="noopener">Per Telegram Bescheid bekommen</a>
        <p class="tg-note">Wir schreiben dir, wenn du gleich dran bist und wenn dein Tisch frei ist.</p>` : ''}
      <button class="cta ghost" data-act="again">Noch jemanden anmelden</button>
      ${backLink()}`, open);
    return;
  }
  if (!draft.cup_id || !open.some(c => c.id === draft.cup_id)) draft.cup_id = open[0].id;
  const cup = open.find(c => c.id === draft.cup_id);
  const pair = cup.entry === 'pair';
  const cupLabel = c => c.name + (ENTRY[c.entry] ? ' · ' + ENTRY[c.entry] : '');

  const here = saved();
  box.innerHTML = joinShell(`<div class="jform">
    ${here.length ? `<div class="mine"><span>Auf diesem Handy angemeldet:</span>${here.map(x =>
      `<a href="/me/${esc(x.token)}">${esc(x.name)}${x.cup ? ` · ${esc(x.cup)}` : ''} →</a>`).join('')}</div>` : ''}
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
             placeholder="Teamname" autocomplete="off">
      <p class="onefor">Eine Anmeldung reicht fürs ganze Team.</p>` : ''}

    <label class="sr" for="j-note">Anmerkung</label>
    <textarea id="j-note" data-j="note" rows="2" placeholder="Anmerkung (optional)">${esc(draft.note)}</textarea>

    ${error ? `<div class="err">${esc(error)}</div>` : ''}
    ${twice ? `<div class="twice">
        <p><b>Für ${esc(twice.names)} gibt es schon eine Anmeldung${twice.cup ? ` im ${esc(twice.cup)}` : ''}.</b></p>
        <p>Kann es sein, dass dein:e Partner:in euch schon angemeldet hat?</p>
        <div class="row">
          <button class="cta" data-act="already" ${sending ? 'disabled' : ''}>Ja, dann nicht nochmal</button>
          <button class="cta ghost" data-act="distinct" ${sending ? 'disabled' : ''}>Nein, wir sind ein anderes Team</button>
        </div></div>`
      : `<button class="cta send" data-act="send" ${sending ? 'disabled' : ''}>${sending ? 'Sende …' : 'Abschicken'}</button>
    ${P.telegram ? `<a class="tg-alt" href="https://t.me/${esc(P.telegram)}?start=join" target="_blank"
        rel="noopener">Oder mit Telegram anmelden — und Bescheid bekommen, wenn du dran bist →</a>` : ''}`}
    ${backLink()}</div>`, open);
}

async function send(distinct) {
  if (sending) return;
  if (!draft.name.trim()) { error = 'Wir brauchen einen Namen.'; return renderJoin(); }
  sending = true; error = ''; renderJoin();
  const team = draft.kind === 'pair' && !!draft.partner_name.trim();
  const who = team ? `${draft.name.trim()} & ${draft.partner_name.trim()}` : draft.name.trim();
  try {
    const r = await fetch('/api/action', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'register', data: { ...draft, distinct: !!distinct } }),
    });
    const j = await r.json().catch(() => ({ error: 'Da ist etwas schiefgegangen.' }));
    if (!r.ok) { error = j.error || 'Da ist etwas schiefgegangen.'; }
    else if (j.possible_duplicate) { twice = { names: who, cup: j.cup }; }
    else {
      twice = null;
      draft.done = { name: who, cup: j.cup, team, token: j.token, telegram: j.telegram || '' };
      remember({ id: j.registration_id, name: who, cup: j.cup, token: j.token, telegram: j.telegram || '' });
    }
  } catch (e) {
    error = 'Gerade keine Verbindung — versuch es gleich noch einmal.';
  }
  sending = false;
  renderJoin();
}

/* ---------------------------------------------------------- /me/<token> */

function linkBox(token, text) {
  return `<div class="linkbox">
    <p>${esc(text)}</p>
    <div class="linkrow"><input id="me-link" readonly value="${esc(linkFor(token))}" aria-label="Dein Link">
      <button class="cta ghost" data-act="copy">Kopieren</button></div>
  </div>`;
}

let me = null, meError = '', meAsk = false, meNote = null, meBusy = false, meMsg = '';

async function meCall(op, extra) {
  const r = await fetch('/api/action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op, data: { token: ME, ...(extra || {}) } }),
  });
  const j = await r.json().catch(() => ({ error: 'Da ist etwas schiefgegangen.' }));
  if (!r.ok) throw new Error(j.error || 'Da ist etwas schiefgegangen.');
  return j;
}

async function meLoad() {
  try { me = await meCall('reg_view'); meError = ''; }
  catch (e) { meError = e.message; }
  renderJoin();
}

async function meDo(op, extra, msg) {
  if (meBusy) return;
  meBusy = true; meMsg = ''; renderJoin();
  try { await meCall(op, extra); meMsg = msg; meAsk = false; meNote = null; }
  catch (e) { meMsg = e.message; }
  meBusy = false;
  await meLoad();
}

const STATUS_DE = {
  pending: 'Angemeldet', confirmed: 'Vor Ort bestätigt', cancelled: 'Abgemeldet',
  dropped: 'Nicht mehr auf der Liste', duplicate: 'Doppelt angemeldet',
};

function renderMe(box) {
  // the half-minute refresh must not take a half-typed note with it
  if (document.activeElement && document.activeElement.id === 'me-note' && !meBusy) return;
  const back = '<a class="cta back-home" href="/">← Zurück zur Veranstaltung</a>';
  if (meError) {
    box.innerHTML = `<h2>Deine Anmeldung</h2><p class="blank">${esc(meError)}</p>${back}`;
    return;
  }
  if (!me) { box.innerHTML = `<h2>Deine Anmeldung</h2><p class="blank">Einen Moment …</p>${back}`; return; }
  const names = [me.name, me.partner_name].filter(Boolean).join(' & ');
  const team = !!me.partner_name;
  const when = me.created_ts ? new Date(me.created_ts * 1000) : null;
  const sent = when ? `${when.getDate()}.${when.getMonth() + 1}., ${when.getHours()}:${String(when.getMinutes()).padStart(2, '0')}` : '';
  const line = {
    pending: me.kind === 'seeking'
      ? (me.matched ? 'Wir haben eine:n Partner:in für dich gefunden — ihr lernt euch am Abend kennen.'
        : 'Wir suchen noch eine:n Partner:in für dich und teilen euch am Abend ein.')
      : 'Mehr ist nicht nötig — wir bestätigen alle am Abend selbst.',
    confirmed: 'Du bist vor Ort eingecheckt. Viel Spaß!',
    cancelled: 'Du hast dich abgemeldet.',
    dropped: 'Diese Anmeldung steht nicht mehr auf der Liste. Frag gern vor Ort nach.',
    duplicate: 'Ihr wart doppelt angemeldet — die andere Anmeldung gilt.',
  }[me.status] || '';
  const note = meNote ?? me.note;
  box.innerHTML = `<div class="me">
    <h2>Deine Anmeldung</h2>
    <div class="done-card">
      <span class="state ${me.status}">${esc(STATUS_DE[me.status] || me.status)}</span>
      <h2>${esc(names)}</h2>
      <p>${esc([me.cup, me.team_name, sent && 'gesendet ' + sent].filter(Boolean).join(' · '))}</p>
      <p>${esc(line)}</p>
    </div>
    ${me.can_change ? `
      <label class="sr" for="me-note">Anmerkung</label>
      <textarea id="me-note" rows="2" placeholder="Anmerkung (optional)">${esc(note)}</textarea>
      <button class="cta ghost" data-act="me-note" ${meBusy ? 'disabled' : ''}>Anmerkung speichern</button>
      ${meAsk ? `<div class="twice"><p><b>Wirklich abmelden?</b></p>
          <p>${team ? 'Das meldet das ganze Team ab.' : 'Du kannst dich danach hier wieder anmelden, solange die Anmeldung offen ist.'}</p>
          <div class="row"><button class="cta" data-act="me-cancel" ${meBusy ? 'disabled' : ''}>Ja, abmelden</button>
            <button class="cta ghost" data-act="me-keep">Doch nicht</button></div></div>`
        : `<button class="cta ghost quiet" data-act="me-ask">Abmelden</button>`}` : ''}
    ${me.can_restore ? `<button class="cta" data-act="me-restore" ${meBusy ? 'disabled' : ''}>Doch wieder anmelden</button>` : ''}
    ${me.status === 'pending' && !me.can_change ? '<p class="blank">Die Veranstaltung läuft — Änderungen bitte vor Ort.</p>' : ''}
    ${meMsg ? `<p class="okmsg">${esc(meMsg)}</p>` : ''}
    ${linkBox(ME, 'Dein persönlicher Link. Wer ihn hat, kann diese Anmeldung ändern — teil ihn nur mit deinem Team.')}
    ${back}
  </div>`;
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
    if ((p.phase === 'doors' || p.phase === 'live') && !joining() && !ME) {
      location.reload();
      return;
    }
    render();
  } catch (e) { /* transient; the next tick catches up */ }
}

document.addEventListener('input', e => {
  if (e.target.id === 'me-note') { meNote = e.target.value; return; }
  const k = e.target.dataset.j;
  if (!k) return;
  draft[k] = e.target.value;
  // the question was about the names as they were: a different one is a new form
  if (twice && (k === 'name' || k === 'partner_name')) {
    twice = null;
    const cursor = e.target.selectionStart;
    renderJoin();
    const back = $(e.target.id);
    if (back) { back.focus(); try { back.setSelectionRange(cursor, cursor); } catch (x) { } }
  }
});
document.addEventListener('change', e => {
  const k = e.target.dataset.j;
  if (!k) return;
  draft[k] = e.target.value;
  // a different cup can mean a different kind of entry, so the fields change
  if (k === 'cup_id') { draft.kind = 'single'; error = ''; twice = null; renderJoin(); }
});
document.addEventListener('click', e => {
  const cup = e.target.closest('button[data-cup]');
  if (cup) { draft.cup_id = cup.dataset.cup; error = ''; return renderJoin(); }
  const kind = e.target.closest('button[data-kind]');
  if (kind) { draft.kind = kind.dataset.kind; error = ''; twice = null; return renderJoin(); }
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  if (b.dataset.act === 'send') return void send();
  if (b.dataset.act === 'copy') {
    const i = $('me-link');
    const done = () => { b.textContent = 'Kopiert'; setTimeout(() => { b.textContent = 'Kopieren'; }, 1500); };
    if (navigator.clipboard) navigator.clipboard.writeText(i.value).then(done, () => { i.select(); });
    else { i.select(); document.execCommand && document.execCommand('copy'); done(); }
    return;
  }
  if (b.dataset.act === 'me-ask') { meAsk = true; meMsg = ''; return renderJoin(); }
  if (b.dataset.act === 'me-keep') { meAsk = false; return renderJoin(); }
  if (b.dataset.act === 'me-cancel') return void meDo('reg_cancel', null, 'Du bist abgemeldet.');
  if (b.dataset.act === 'me-restore') return void meDo('reg_restore', null, 'Du stehst wieder auf der Liste.');
  if (b.dataset.act === 'me-note') return void meDo('reg_note', { note: meNote ?? (me && me.note) ?? '' }, 'Gespeichert.');
  if (b.dataset.act === 'distinct') return void send(true);
  if (b.dataset.act === 'already') {
    // nothing was written; say so and leave it there
    const cup = (P.cups.find(c => c.id === draft.cup_id) || {}).name || '';
    draft.done = { name: twice ? twice.names : draft.name, cup, already: true };
    twice = null;
    return renderJoin();
  }
  if (b.dataset.act === 'again') {
    draft = { cup_id: draft.cup_id, kind: draft.kind, name: '', strength: '5',
              partner_name: '', partner_strength: '5', team_name: '', note: '' };
    error = ''; twice = null;
    renderJoin();
  }
});

load();
if (ME) meLoad();
setInterval(load, 30000);
setInterval(tick, 1000);
