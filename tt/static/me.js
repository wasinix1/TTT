/* The Mini App — one player's evening. See tt/me.py.

   Who is asking is whatever Telegram signed: the initData string goes with
   every request and the server checks it. Nothing is kept here but what is
   half-typed, so a refresh can never show somebody else's evening. */

const tg = window.Telegram && window.Telegram.WebApp;
const INIT = (tg && tg.initData)
  || new URLSearchParams(location.hash.slice(1)).get('tgWebAppData') || '';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let V = null;              // the view, as the server last sent it
let skew = 0;              // server clock minus ours
let busy = false;
// what the player is in the middle of: never overwritten by a refresh
const ui = { name: null, kind: {}, partner: {}, msg: '', pad: null };

/* ------------------------------------------------------------ telegram */

function theme() {
  const dark = tg && tg.colorScheme ? tg.colorScheme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const bg = dark ? '#0e0e0e' : '#ffffff';
  try {
    tg.setHeaderColor(bg);
    tg.setBackgroundColor(bg);
    if (tg.setBottomBarColor) tg.setBottomBarColor(bg);
  } catch (e) { }
}

function buzz(kind) {
  try {
    const h = tg.HapticFeedback;
    if (kind === 'ok' || kind === 'bad') h.notificationOccurred(kind === 'ok' ? 'success' : 'error');
    else h.impactOccurred(kind || 'light');
  } catch (e) { }
}

function ask(message) {
  return new Promise(res => {
    if (tg && tg.showConfirm && tg.isVersionAtLeast && tg.isVersionAtLeast('6.2')) {
      try { return tg.showConfirm(message, ok => res(!!ok)); } catch (e) { }
    }
    res(confirm(message));
  });
}

/* ------------------------------------------------------------ net */

async function load() {
  if (!INIT) return outside();
  try {
    const r = await fetch('/api/me', { headers: { 'X-Tg-Init': INIT }, cache: 'no-store' });
    if (r.status === 401 || r.status === 404) return outside();
    const v = await r.json();
    skew = v.now - Date.now() / 1000;
    V = v;
    render();
    const dot = $('dot');
    if (dot) { dot.classList.add('on'); setTimeout(() => dot.classList.remove('on'), 400); }
  } catch (e) { /* a blip on hall wifi; the next push or tick catches up */ }
}

async function act(op, data, after) {
  if (busy) return;
  busy = true;
  buzz('light');
  try {
    const r = await fetch('/api/me', {
      method: 'POST', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Tg-Init': INIT },
      body: JSON.stringify({ op, data: data || {} }),
    });
    const j = await r.json().catch(() => ({ error: 'Da ist etwas schiefgegangen.' }));
    if (!r.ok) { toast(j.error || 'Das hat nicht geklappt.', true); buzz('bad'); return false; }
    V = j.view;
    if (after) after();
    render();
    if (j.toast) toast(j.toast);
    buzz('ok');
    return true;
  } catch (e) {
    toast('Gerade keine Verbindung — versuch es gleich noch einmal.', true);
    return false;
  } finally { busy = false; }
}

/* Any change anywhere nudges the stream; then we ask for our own view. */
let stream = null, soon = null;
function listen() {
  try { stream = new EventSource('/api/stream'); } catch (e) { return; }
  stream.onmessage = () => { clearTimeout(soon); soon = setTimeout(load, 250); };
  stream.onerror = () => { stream.close(); setTimeout(listen, 4000); };
}

/* ------------------------------------------------------------ render */

function render() {
  if (!V) return;
  const f = document.activeElement;
  const fid = f && f.id, sel = f && f.selectionStart != null ? f.selectionStart : null;
  $('app').innerHTML = [header(), claims(), hero(), entries(), evening(), standings(),
                        tables(), orga(), settings()].join('');
  if (fid) {
    const back = $(fid);
    if (back) { back.focus(); try { if (sel != null) back.setSelectionRange(sel, sel); } catch (e) { } }
  }
  if (ui.pad && !playing()) closePad();       // the referee got there first
}

function header() {
  const ev = V.event;
  // before the night the hero is the event, so the header just says hello
  const before = V.phase === 'announced' || V.phase === 'registration';
  return `<header class="top">
    <span class="mark">TT<i>T</i></span>
    <div class="ev">${before
      ? `<b>Hallo ${esc(V.me.first || V.me.name)}</b>`
      : `<b>${esc(ev.name)}</b><span>${esc(ev.when)}</span>`}</div>
    <span class="live-dot" id="dot" title="live"></span>
  </header>`;
}

const playing = () => V && (V.tonight || []).find(x => x.state === 'playing');
const sets = games => {
  let a = 0, b = 0;
  games.forEach(([x, y]) => { if (x > y) a++; else if (y > x) b++; });
  return [a, b];
};
const scoreLine = games => games.map(([a, b]) => `${a}:${b}`).join(' · ');

function claims() {
  return (V.confirm || []).map(c => `<div class="ask">
    <div class="kick">${esc(c.by)} meldet ein Ergebnis</div>
    <div class="score">${scoreLine(c.games)}</div>
    <div>${c.sets[0] > c.sets[1] ? 'Du gewinnst' : 'Du verlierst'} ${c.sets[0]}:${c.sets[1]} — stimmt das?</div>
    <div class="row">
      <button class="btn red" data-act="confirm" data-id="${c.id}" data-yes="1">Stimmt</button>
      <button class="btn clear" data-act="confirm" data-id="${c.id}" data-yes="">Stimmt nicht</button>
    </div></div>`).join('');
}

/* The one thing that matters most right now, big. */
function hero() {
  const ph = V.phase;
  if (ph === 'announced' || ph === 'registration') return heroBefore();
  if (ph === 'done') return heroAfter();
  const t = V.tonight || [];
  if (!t.length) {
    const waiting = (V.entries || []).find(e => e.status === 'pending');
    return `<section class="hero">
      <div class="kick">Heute</div>
      <div class="big mid">${waiting ? 'Du stehst auf der Liste' : 'Nicht eingetragen'}</div>
      <div class="sub">${waiting
        ? `Für ${esc(waiting.cup)}. Am Eingang bestätigen wir dich — dann kommen deine Aufrufe hierher.`
        : V.me.known ? 'Sag am Eingang Bescheid, wenn du mitspielen willst.'
          : 'Sag am Eingang Bescheid — dort verknüpfen wir dich, und deine Aufrufe kommen hierher.'}</div>
    </section>`;
  }
  const [x, ...rest] = t;
  const others = rest.length ? `<div class="more">${rest.map(o =>
    `<div><b>${esc(o.cup)}</b> <span>${esc(shortState(o))}</span></div>`).join('')}</div>` : '';
  const cup = x.cup ? x.cup + ' · ' : '';

  if (x.state === 'playing') {
    const mine = (V.reported || [])[0];
    const who = (x.partners.length ? `mit ${x.partners.join(', ')} ` : '') + `gegen ${x.opponent}`;
    return `<section class="hero turn"><span class="pulse"></span>
      <div class="kick">Du bist dran${x.label ? ' · ' + esc(cup + x.label) : esc(x.cup ? ' · ' + x.cup : '')}</div>
      <div class="big">${esc(x.table)}</div>
      <div class="line">${esc(who)}</div>
      <div class="sub">${esc(x.best_of)}</div>
      ${V.scores ? (mine
        ? `<div class="sub" style="margin-top:12px">Gemeldet: ${scoreLine(mine.games)} — ${esc(x.opponent)} bestätigt noch.
            <button class="link" style="color:inherit" data-act="withdraw" data-id="${mine.id}">Zurückziehen</button></div>`
        : `<div class="row"><button class="btn white wide" data-act="pad">Ergebnis eintragen</button></div>`) : ''}
      ${others}</section>`;
  }
  if ((x.state === 'waiting' || x.state === 'drawn') && x.on_deck) {
    return `<section class="hero ready">
      <div class="kick">Gleich${x.cup ? ' · ' + esc(x.cup) : ''}</div>
      <div class="big mid">Mach dich bereit</div>
      ${x.opponent ? `<div class="line">gegen ${esc(x.opponent)}</div>` : ''}
      <div class="sub">${x.eta_min > 0 ? `etwa ${x.eta_min} Min` : 'jeden Moment'}${x.label ? ' · ' + esc(x.label) : ''}</div>
      ${others}</section>${pauseRow(x)}`;
  }
  if (x.state === 'waiting' || x.state === 'drawn') {
    const known = x.eta_min != null;
    return `<section class="hero">
      <div class="kick">In der Reihe${x.cup ? ' · ' + esc(x.cup) : ''}</div>
      <div class="big">${known ? `~${x.eta_min}<span style="font-size:.45em;letter-spacing:-.01em"> Min</span>` : '—'}</div>
      <div class="line">${known ? `${x.position}. in der Reihe` : 'Gerade kein Spiel für dich'}</div>
      ${x.opponent ? `<div class="sub">Nächstes Spiel gegen ${esc(x.opponent)}</div>` : ''}
      ${record(x)}${others}</section>${pauseRow(x)}`;
  }
  if (x.state === 'resting') {
    return `<section class="hero quiet">
      <div class="kick">Pause${x.cup ? ' · ' + esc(x.cup) : ''}</div>
      <div class="big">Pause</div>
      <div class="sub">Wir rufen dich nicht auf, bis du wieder da bist.</div>
      <div class="row">
        <button class="btn ink" data-act="rest" data-eid="${x.eid}" data-on="">Ich bin wieder da</button>
        <button class="btn clear" data-act="leave" data-eid="${x.eid}" data-on="1">Ich gehe heim</button>
      </div>${others}</section>`;
  }
  if (x.state === 'withdrawn') {
    return `<section class="hero quiet">
      <div class="kick">Für heute</div>
      <div class="big mid">Abgemeldet</div>
      <div class="sub">Deine offenen Spiele sind an deine Gegner:innen gegangen.</div>
      <div class="row"><button class="btn ink" data-act="leave" data-eid="${x.eid}" data-on="">Doch noch da</button></div>
      ${others}</section>`;
  }
  return `<section class="hero">
    <div class="kick">${x.cup ? esc(x.cup) : 'Heute'}</div>
    <div class="big mid">${x.state === 'entered' ? 'Gleich geht’s los' : 'Du bist dabei'}</div>
    <div class="sub">Sobald du dran bist, sagen wir dir Bescheid.</div>
    ${others}</section>${pauseRow(x)}`;
}

function shortState(o) {
  if (o.state === 'playing') return `jetzt an ${o.table}`;
  if (o.state === 'resting') return 'Pause';
  if (o.state === 'withdrawn') return 'abgemeldet';
  if (o.on_deck) return 'gleich dran';
  if (o.eta_min != null) return `etwa ${o.eta_min} Min`;
  return 'im Turnier';
}

const record = x => (x.won || x.lost)
  ? `<div class="sub" style="margin-top:8px">Bisher ${x.won} ${x.won === 1 ? 'Sieg' : 'Siege'} · ${x.lost} ${x.lost === 1 ? 'Niederlage' : 'Niederlagen'}</div>` : '';

const pauseRow = x => `<div class="actions">
  <button class="btn" data-act="rest" data-eid="${x.eid}" data-on="1">Pause</button></div>`;

function heroBefore() {
  const ev = V.event;
  const left = ev.starts_ts ? ev.starts_ts - (Date.now() / 1000 + skew) : null;
  let count = '';
  if (left && left > 0) {
    const d = Math.floor(left / 86400), h = Math.floor(left % 86400 / 3600), m = Math.floor(left % 3600 / 60);
    const parts = d ? [[d, d === 1 ? 'Tag' : 'Tage'], [h, 'Std']] : [[h, 'Std'], [m, 'Min']];
    count = `<div class="count">${parts.map(([n, l]) => `<div><b>${n}</b><span>${l}</span></div>`).join('')}</div>`;
  }
  return `<section class="hero">
    <div class="kick">${V.phase === 'registration' ? 'Anmeldung offen' : 'Demnächst'}</div>
    <div class="big mid">${esc(ev.name)}</div>
    <div class="sub">${esc(ev.when)}</div>
    ${ev.blurb ? `<div class="sub" style="margin-top:6px">${esc(ev.blurb)}</div>` : ''}
    ${count}</section>`;
}

function heroAfter() {
  const t = V.tonight || [];
  const w = t.reduce((n, x) => n + x.won, 0), l = t.reduce((n, x) => n + x.lost, 0);
  return `<section class="hero${(V.places || []).length ? ' turn' : ''}">
    <div class="kick">Vorbei</div>
    <div class="big mid">Danke fürs Mitspielen!</div>
    ${w || l ? `<div class="line">${w} ${w === 1 ? 'Sieg' : 'Siege'} · ${l} ${l === 1 ? 'Niederlage' : 'Niederlagen'}</div>` : ''}
    ${(V.places || []).map(p => `<div class="line">${esc(p)}</div>`).join('')}
  </section>`;
}

/* ------------------------------------------------------------ entering */

const soonTs = () => V.event.starts_ts && V.event.starts_ts - (Date.now() / 1000 + skew) < 26 * 3600;

function entries() {
  const before = V.phase === 'announced' || V.phase === 'registration';
  const mine = V.entries || [];
  if (!before && !mine.length) return '';
  if (!before) return '';
  const open = V.open || [];
  if (!mine.length && !open.length) {
    return `<div class="block"><div class="card"><div class="note" style="margin:0">
      Die Anmeldung ist noch nicht offen — wir sagen dir Bescheid.</div></div></div>`;
  }
  const name = ui.name ?? V.me.name ?? '';
  // asked once: after a first entry we already have it
  const needName = !V.me.known && open.length && !mine.length;
  return `<div class="block"><h2>Anmeldung</h2>
    ${mine.map(entered).join('')}
    ${needName ? `<div class="card"><div class="field"><label for="nm">Dein Name</label>
      <input class="input" id="nm" data-ui="name" value="${esc(name)}" autocomplete="name"
             autocapitalize="words" placeholder="Vor- und Nachname"></div>
      <div class="note">So, wie wir dich am Eingang finden.</div></div>` : ''}
    ${open.map(openCup).join('')}</div>`;
}

function entered(e) {
  const detail = e.kind === 'pair' ? `mit ${e.partner}`
    : e.kind === 'seeking' ? (e.partner ? `mit ${e.partner} — zugelost` : 'Partner:in gesucht') : '';
  const rsvp = e.status === 'pending' && soonTs() && !e.rsvp;
  return `<div class="card">
    <h3>${esc(e.cup)}</h3>
    <div class="done-mark"><span class="tick">✓</span>${e.status === 'confirmed' ? 'Bestätigt' : 'Du bist dabei'}${
      detail ? ` <span style="color:var(--muted);font-weight:600">· ${esc(detail)}</span>` : ''}${
      e.rsvp === 'yes' ? ' <span style="color:var(--muted);font-weight:600">· kommt 👍</span>' : ''}</div>
    ${rsvp ? `<div class="note">Kommst du?</div><div class="go" style="flex-direction:row">
      <button class="btn ink" style="flex:1" data-act="rsvp" data-id="${e.id}" data-yes="1">Ja, bis dann</button>
      <button class="btn" style="flex:1" data-act="rsvp" data-id="${e.id}" data-yes="">Kann nicht</button></div>` : ''}
    ${e.status === 'pending' ? `<button class="link" data-act="drop" data-id="${e.id}" data-cup="${esc(e.cup)}">Abmelden</button>` : ''}
  </div>`;
}

function openCup(c) {
  const pair = c.entry === 'pair';
  const kind = ui.kind[c.id] || (pair ? 'p' : 's');
  return `<div class="card">
    <h3>${esc(c.name)}</h3>
    <div class="about">${esc([c.name.toLowerCase().includes(pair ? 'doppel' : 'einzel') ? ''
      : (pair ? 'Doppel' : 'Einzel'), c.about].filter(Boolean).join(' · '))}</div>
    ${c.blurb ? `<div class="note">${esc(c.blurb)}</div>` : ''}
    <div class="go">
      ${pair ? `<div class="seg">
        <button class="${kind === 'p' ? 'on' : ''}" data-act="kind" data-cup="${c.id}" data-k="p">Mit Partner:in</button>
        <button class="${kind === 'k' ? 'on' : ''}" data-act="kind" data-cup="${c.id}" data-k="k">Partner:in gesucht</button>
      </div>` : ''}
      ${pair && kind === 'p' ? `<input class="input" id="pt-${c.id}" data-ui="partner" data-cup="${c.id}"
        value="${esc(ui.partner[c.id] || '')}" placeholder="Name deiner Partnerin / deines Partners"
        autocapitalize="words">` : ''}
      ${pair && kind === 'k' ? `<div class="note" style="margin:0">Wir losen dir jemanden zu, der auch alleine kommt.</div>` : ''}
      <button class="btn red wide" data-act="enter" data-cup="${c.id}">Ich bin dabei</button>
    </div></div>`;
}

/* ------------------------------------------------------------ tonight */

function evening() {
  const ms = V.matches || [], up = V.upcoming || [];
  if (!ms.length && !up.length) return '';
  return `<div class="block"><h2>Dein Abend${ms.length ? ` <span>${
    ms.filter(m => m.won).length}:${ms.filter(m => !m.won).length}</span>` : ''}</h2>
    <div class="list">
      ${ms.map(m => `<div class="res">
        <span class="wl ${m.won ? 'w' : ''}">${m.won ? 'S' : 'N'}</span>
        <span class="who"><b>${esc(m.opponent)}</b><span>${esc([m.cup, m.label].filter(Boolean).join(' · ') || (m.won ? 'Sieg' : 'Niederlage'))}</span></span>
        <span class="sc">${m.walkover ? '<i>kampflos</i>' : m.games.map(([a, b]) => `${a}:${b}`).join(' ')}</span>
      </div>`).join('')}
      ${up.length ? `<div class="res left"><b>Noch zu spielen</b>
        <span>${up.map(u => esc(u.opponent)).join(', ')}</span></div>` : ''}
    </div></div>`;
}

function standings() {
  return (V.standings || []).map(t => `<div class="block">
    <h2>Tabelle${t.title && t.title !== 'Tabelle' ? ` <span>${esc(t.title)}</span>` : ''}</h2>
    <div class="list">${t.rows.map(r => `<div class="st${r.me ? ' me' : ''}${r.gap ? ' gap' : ''}">
      <span class="rk">${r.rank}</span><span class="nm">${esc(r.name)}</span>
      <span class="wl2">${r.won}:${r.lost}</span></div>`).join('')}</div></div>`).join('');
}

function tables() {
  if (V.phase !== 'live' && V.phase !== 'doors') return '';
  const ts = V.tables || [];
  if (!ts.some(t => t.a)) return '';
  return `<div class="block"><h2>An den Tischen</h2><div class="tables">
    ${ts.map(t => `<div class="tbl${t.mine ? ' mine' : ''}${t.a ? '' : ' free'}">
      <span class="n">${t.number}</span>
      <span class="p">${t.a ? `<span>${esc(t.a)}</span><span>${esc(t.b)}</span>`
        : `<i>${t.paused ? 'Pause' : 'frei'}</i>`}</span></div>`).join('')}
  </div></div>`;
}

function orga() {
  return `<div class="block"><h2>Nachricht an die Orga</h2><div class="card">
    <textarea class="input" id="msg" data-ui="msg" rows="3"
      placeholder="Ich bin zehn Minuten später da …">${esc(ui.msg)}</textarea>
    <div class="go"><button class="btn ink wide" data-act="message" ${ui.msg.trim() ? '' : 'disabled'}>Senden</button></div>
  </div></div>`;
}

function settings() {
  const m = V.me;
  return `<div class="settings">
    <div class="set"><span class="t"><b>Neuigkeiten</b><span>Neue Abende und Ansagen der Orga</span></span>
      <button class="switch${m.news ? ' on' : ''}" data-act="news" aria-pressed="${m.news}"
        aria-label="Neuigkeiten"></button></div>
    ${m.linked ? `<div class="set"><span class="t"><b>${esc(m.name || m.first)}</b>
      <span>${m.known ? 'Deine Aufrufe kommen hierher' : 'Nach dem Eingang kommen deine Aufrufe hierher'}</span></span>
      <button class="link" data-act="unlink">Lösen</button></div>` : ''}
  </div>
  <div class="foot">TTT${V.bot ? ` · @${esc(V.bot)}` : ''}</div>`;
}

/* ------------------------------------------------------------ the score pad */

function openPad() {
  const x = playing();
  if (!x) return;
  ui.pad = { games: Array.from({ length: x.bo }, () => ['', '']), opp: x.opponent,
             need: x.need, bo: x.bo, best: x.best_of };
  renderPad();
  if (tg && tg.BackButton) { tg.BackButton.show(); tg.BackButton.onClick(closePad); }
  setTimeout(() => { const i = $('g0a'); if (i) i.focus(); }, 60);
}

function closePad() {
  ui.pad = null;
  $('sheet').innerHTML = '';
  if (tg && tg.BackButton) { tg.BackButton.offClick(closePad); tg.BackButton.hide(); }
}

/* Complete games, the rows worth showing, and who that makes the winner. */
function padState() {
  const p = ui.pad;
  const done = [];
  for (const [a, b] of p.games) {
    if (a === '' || b === '' || +a === +b) break;
    done.push([+a, +b]);
  }
  const [w, l] = sets(done);
  const decided = w >= p.need || l >= p.need;
  const shown = decided ? done.length : Math.min(p.bo, Math.max(p.need, done.length + 1));
  return { done, w, l, decided, shown };
}

/* Typing never rebuilds the boxes under the thumb — only a new row, when
   the games so far have not decided it, redraws the sheet. */
function updatePad() {
  const st = padState();
  if (document.querySelectorAll('.pad .game').length !== st.shown) return renderPad();
  const v = document.querySelector('.verdict');
  v.className = 'verdict' + (st.decided && st.w > st.l ? ' win' : '');
  v.textContent = st.decided ? (st.w > st.l ? `Du gewinnst ${st.w}:${st.l}` : `Du verlierst ${st.w}:${st.l}`) : '';
  document.querySelector('[data-act="pad-send"]').disabled = !st.decided;
}

function renderPad() {
  const p = ui.pad;
  if (!p) return;
  const st = padState();
  const f = document.activeElement, fid = f && f.id;
  $('sheet').innerHTML = `<div class="veil" data-act="pad-close"><div class="sheet" data-stop>
    <div class="grab"></div>
    <h3>Ergebnis</h3>
    <div class="sub">gegen ${esc(p.opp)} · ${esc(p.best)}</div>
    <div class="pad">
      <div class="head"><span></span><span>Du</span><span></span><span>${esc(p.opp.split(' ')[0])}</span></div>
      ${p.games.slice(0, st.shown).map((g, i) => `<div class="game">
        <label for="g${i}a">Satz ${i + 1}</label>
        <input class="input" id="g${i}a" data-g="${i}:0" value="${esc(g[0])}" inputmode="numeric" maxlength="2" autocomplete="off">
        <span class="colon">:</span>
        <input class="input" id="g${i}b" data-g="${i}:1" value="${esc(g[1])}" inputmode="numeric" maxlength="2" autocomplete="off">
      </div>`).join('')}
    </div>
    <div class="verdict ${st.decided && st.w > st.l ? 'win' : ''}">${st.decided
      ? (st.w > st.l ? `Du gewinnst ${st.w}:${st.l}` : `Du verlierst ${st.w}:${st.l}`) : ''}</div>
    <div class="go" style="display:flex;flex-direction:column;gap:8px;margin-top:10px">
      <button class="btn red wide" data-act="pad-send" ${st.decided ? '' : 'disabled'}>Senden</button>
      <div class="sub" style="text-align:center">${esc(p.opp)} bestätigt — dann ist es eingetragen.</div>
    </div></div></div>`;
  if (fid) { const back = $(fid); if (back) back.focus(); }
}

/* ------------------------------------------------------------ misc */

function toast(msg, bad) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (bad ? ' bad' : '');
  t.hidden = false;
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.hidden = true; }, 3200);
}

async function outside() {
  let bot = '';
  try { bot = (await (await fetch('/api/public')).json()).telegram || ''; } catch (e) { }
  $('app').innerHTML = `<div class="empty">
    <h1>Öffne das in Telegram</h1>
    <p>Dein Abend — wann du dran bist, deine Spiele, deine Tabelle — steht in unserem Bot.</p>
    ${bot ? `<p><a class="btn red" href="https://t.me/${esc(bot)}?start=join">Zu @${esc(bot)}</a></p>` : ''}
  </div>`;
}

/* ------------------------------------------------------------ events */

document.addEventListener('input', e => {
  const k = e.target.dataset.ui;
  if (k === 'name') ui.name = e.target.value;
  else if (k === 'partner') ui.partner[e.target.dataset.cup] = e.target.value;
  else if (k === 'msg') {
    ui.msg = e.target.value;
    const b = document.querySelector('[data-act="message"]');
    if (b) b.disabled = !ui.msg.trim();
  }
  const g = e.target.dataset.g;
  if (g && ui.pad) {
    const [i, side] = g.split(':').map(Number);
    const v = e.target.value.replace(/[^0-9]/g, '').slice(0, 2);
    e.target.value = v;
    ui.pad.games[i][side] = v;
    updatePad();
    // two digits is a finished number: on to the next box
    if (v.length === 2) {
      const el = $(side === 0 ? `g${i}b` : `g${i + 1}a`);
      if (el) el.focus();
    }
  }
});

document.addEventListener('click', async e => {
  if (e.target.closest('[data-stop]') && !e.target.closest('[data-act]')) return;
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const a = b.dataset.act, d = b.dataset;
  if (a === 'pad-close') { if (e.target === b) closePad(); return; }
  if (a === 'kind') { ui.kind[d.cup] = d.k; buzz('light'); return render(); }
  if (a === 'enter') {
    const c = (V.open || []).find(x => x.id === d.cup);
    const kind = ui.kind[d.cup] || (c && c.entry === 'pair' ? 'p' : 's');
    const name = (ui.name ?? V.me.name ?? '').trim();
    if (!V.me.known && !name) { toast('Wir brauchen deinen Namen.', true); const n = $('nm'); if (n) n.focus(); return; }
    return void act('enter', { cup_id: d.cup, kind, name, partner: ui.partner[d.cup] || '' });
  }
  if (a === 'drop') {
    if (!(await ask(`Von ${d.cup} abmelden?`))) return;
    return void act('drop', { id: d.id });
  }
  if (a === 'rsvp') return void act('rsvp', { id: d.id, yes: !!d.yes });
  if (a === 'rest') return void act('rest', { eid: d.eid, on: !!d.on });
  if (a === 'leave') {
    if (d.on && !(await ask('Gehst du für heute? Deine offenen Spiele gehen dann kampflos an deine Gegner:innen.'))) return;
    return void act('leave', { eid: d.eid, on: !!d.on });
  }
  if (a === 'confirm') return void act('confirm', { id: +d.id, yes: !!d.yes });
  if (a === 'withdraw') return void act('withdraw', { id: +d.id });
  if (a === 'pad') { buzz('light'); return openPad(); }
  if (a === 'pad-send') {
    const st = padState();
    if (!st.decided) return;
    return void act('score', { games: st.done }, closePad);
  }
  if (a === 'message') {
    const text = ui.msg.trim();
    if (!text) return;
    return void act('message', { text }, () => { ui.msg = ''; });
  }
  if (a === 'news') return void act('news', { on: !V.me.news });
  if (a === 'unlink') {
    if (!(await ask('Dann bekommst du keine Tischaufrufe mehr, und wir kennen dich hier nicht mehr. Sicher?'))) return;
    return void act('unlink', {});
  }
});

/* ------------------------------------------------------------ start */

if (tg) {
  try { tg.ready(); tg.expand(); } catch (e) { }
  try { if (tg.disableVerticalSwipes) tg.disableVerticalSwipes(); } catch (e) { }
  try { tg.onEvent('themeChanged', theme); } catch (e) { }
}
theme();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (!tg || !tg.colorScheme) theme(); });
load();
listen();
setInterval(load, 30000);          // the board's times drift even when nothing happens
setInterval(() => {                // the countdown, without fighting anyone typing
  const f = document.activeElement;
  if (V && !(f && /INPUT|TEXTAREA/.test(f.tagName))) render();
}, 60000);
