/* TTT mobile — the phone page for players and the people watching them.

   One page, two shells, one set of renderers:

   web   /         (doors, live)  role public. Reads /api/state. "Playing
                                  tonight?" picks a name once; this phone
                                  remembers it (localStorage) and the page
                                  works out where that person is from the
                                  same board the wall shows. Read-only.
   tg    /tg       (every phase)  the Telegram Mini App. Who is asking is
                                  whatever Telegram signed (/api/me, see
                                  tt/me.py); the room comes from the same
                                  public /api/state. Can act: pause, go home,
                                  report a score, confirm one, message the
                                  organisers, register before the night.

   The top of the page is one person's evening (the Focus hero): a painted
   table, out of focus while you wait (blur is distance), sharp when you are
   on it, behind one big word or number. Below it is the room: the tables,
   who plays next, the standings, the results, filtered by cup.

   Everything here is a function of data the server already sends. Where the
   page needs a field the server does not send yet, the name is marked
   PROPOSED and there is a fallback; docs/mobile-redesign.md lists them.

   Nothing in the room is red unless it is you. */

(function () {
'use strict';

let SHELL = document.documentElement.dataset.shell === 'tg' ? 'tg' : 'web';
const tg = window.Telegram && window.Telegram.WebApp;
const INIT = (tg && tg.initData)
  || new URLSearchParams(location.hash.slice(1)).get('tgWebAppData') || '';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ------------------------------------------------------------ words

   The public console has always been English and the Mini App German; that
   stays the default (web → en, tg → de). Every string the page shows is
   here, so a later per-event language is one switch. */

const ord = n => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');
const plural = (n, one, many) => n === 1 ? one : many;

const STR = {
  en: {
    tables: r => !r ? 'No table' : /^\d+$/.test(String(r)) ? 'Table ' + r : 'Tables ' + r, table1: n => 'Table ' + n, allTables: 'All tables',
    // hero
    ahead: n => plural(n, 'match before yours', 'matches before yours'),
    nextWord: 'Next', nextM: 'first free table is yours', stayClose: 'Stay close',
    yourTable: 'Your table', since: t => 'Since ' + t, bestOf: (b, p) => `Best of ${b} to ${p}`,
    with: names => 'with ' + names,
    against: 'Against', nextAgainst: 'Next against', played: 'Played', open: 'to be drawn',
    toBeDrawn: 'drawn when a table comes free',
    won: 'You won', lost: 'You lost',
    nowRank: (r, g) => `Now ${ord(r)}${g ? ' in ' + g : ''}`, upFrom: r => `up from ${ord(r)}`, downFrom: r => `down from ${ord(r)}`,
    stillRank: (r, g) => `Still ${ord(r)}${g ? ' in ' + g : ''}`,
    record: (w, l) => `${w}–${l} so far`, recordWord: 'So far',
    laterWord: 'Later', laterM: 'No match for you right now', laterF: 'Your next one is not drawn yet',
    pauseWord: 'Break', pauseM: 'You won’t be called', pauseF: 'Tell the desk when you’re back', pauseFtg: 'until you’re back',
    goneWord: 'Home', goneM: 'Signed out for tonight', goneF: 'Your open matches went to your opponents',
    soonWord: 'Soon', soonM: 'Starting soon', soonF: 'This page moves when you do',
    inWord: 'In', inM: 'You’re in', inF: 'Your draw is still to come',
    inCup: 'In',
    almostWord: 'Almost', almostM: 'You’re on the list', almostF: c => `${c} · we confirm you at the door`,
    notinWord: 'Not in', notinM: 'You’re not entered tonight', notinF: 'Tell the door if you’d like to play',
    tonight: 'Tonight', thanksWord: 'Thanks', thanksM: 'Thanks for playing',
    daysTo: n => plural(n, 'day to go', 'days to go'), hoursTo: n => plural(n, 'hour to go', 'hours to go'), minsTo: n => plural(n, 'minute to go', 'minutes to go'),
    entered: 'Entered', nothingYet: 'nothing yet',
    notYou: 'Not you?',
    nowAt: t => 'now at ' + t, onDeck: 'next', aheadShort: n => n + ' before yours', paused: 'break', gone: 'gone home', inDraw: 'in the draw',
    // web way in
    pillQ: 'Playing tonight?', pillA: 'Tap your name →', pillOn: t => t + ' →',
    whoH: 'Who are you?', whoP: 'Pick your name once. This phone remembers it for the evening.', find: 'Search your name',
    noName: 'No one by that name tonight.',
    pairWith: n => 'with ' + n,
    // room
    everyone: 'Everyone', onTables: 'On the tables', upNext: 'Up next', standings: 'Standings', results: 'Results',
    playing: n => n + ' playing', freeN: n => n + ' free', pausedN: n => n + ' on break',
    free: 'free', tablePaused: 'break', finishing: c => `finishing a ${c} match`, otherCup: 'another cup',
    toPlay: n => n + ' to play', waitingN: n => n + ' waiting', playedN: n => n + ' played',
    getReady: 'Get ready', nextChip: 'next', putBack: 'put back', waitsMatch: 'waiting for a match',
    more: n => `${n} more`, andMore: n => `and ${n} more after that`, nothingQueued: 'Nothing queued.',
    yourCup: 'you play here',
    goThrough: n => `Top ${n} go through`, winsTonight: 'Wins tonight', youAre: r => `You’re ${ord(r)}`, leads: n => n + ' leads',
    colW: 'W', colL: 'L', colBh: 'Bh', colDiff: '±',
    knockout: 'Knockout', champion: 'Winner', tbd: 'to be decided', liveAt: n => 'table ' + n,
    beat: n => 'beat ' + n, walkover: 'walkover', bye: 'bye',
    findP: 'Find a player', showAll: n => `Show all ${n}`, showLess: 'Show fewer', noResult: 'No result with that name.', nothingPlayed: 'Nothing played yet.',
    noTables: 'No tables yet.',
    // telegram
    report: 'Enter result', reported: (s, o) => `Reported ${s} — ${o} still has to confirm`,
    claimBy: b => `${b} reported a result`, claimQ: (w, a, b) => `${w ? 'You win' : 'You lose'} ${a}:${b} — right?`,
    yes: 'Right', no: 'Not right',
    pause: 'Break', back: 'I’m back', leave: 'I’m going home', stay: 'Still here',
    leaveQ: 'Going home? Your open matches go to your opponents as walkovers.',
    evening: 'Your evening', stillToPlay: 'Still to play', w: 'W', l: 'L',
    orga: 'Message the organisers', orgaPh: 'I’ll be ten minutes late …', send: 'Send',
    news: 'News', newsSub: 'New evenings and announcements', linkedSub: k => k ? 'Your calls come here' : 'After the door, your calls come here', unlink: 'Unlink',
    unlinkQ: 'You won’t get table calls any more, and we won’t know you here. Sure?',
    // registration (before the night)
    signup: 'Sign up', confirmed: 'Confirmed', youreIn: 'You’re in', comingQ: 'Coming?', yesSee: 'Yes, see you', cant: 'Can’t make it',
    drop: 'Withdraw', dropQ: c => `Withdraw from ${c}?`, withPartner: 'With a partner', seeking: 'Looking for one', partnerPh: 'Your partner’s name',
    seekNote: 'We’ll draw you someone who comes alone too.', imIn: 'I’m in', yourName: 'Your name', namePh: 'First and last name',
    nameNote: 'As we’ll find you at the door.', regClosed: 'Sign-up isn’t open yet — we’ll tell you.', needName: 'We need your name.',
    single: 'Singles', pair: 'Doubles', drawn: n => `with ${n} — drawn`, lookingFor: 'looking for a partner', comes: 'coming',
    // pad
    result: 'Result', game: n => 'Game ' + n, you: 'You', youWin: (a, b) => `You win ${a}:${b}`, youLose: (a, b) => `You lose ${a}:${b}`,
    padNote: o => `${o} confirms — then it counts.`,
    outsideH: 'Open this in Telegram', outsideP: 'Your evening — when you play, your matches, your table — is in our bot.',
  },
  de: {
    tables: r => r ? 'Tisch ' + r : 'Kein Tisch', table1: n => 'Tisch ' + n, allTables: 'Alle Tische',
    ahead: n => plural(n, 'Spiel vor deinem', 'Spiele vor deinem'),
    nextWord: 'Gleich', nextM: 'der erste freie Tisch ist deiner', stayClose: 'Bleib in der Nähe',
    yourTable: 'Dein Tisch', since: t => 'seit ' + t, bestOf: (b, p) => `Best of ${b} bis ${p}`,
    with: names => 'mit ' + names,
    against: 'Gegen', nextAgainst: 'Als Nächstes gegen', played: 'Gespielt', open: 'noch offen',
    toBeDrawn: 'wird ausgelost, sobald ein Tisch frei ist',
    won: 'Gewonnen', lost: 'Verloren',
    nowRank: (r, g) => `Jetzt ${r}.${g ? ' in ' + g : ''}`, upFrom: r => `vorher ${r}.`, downFrom: r => `vorher ${r}.`,
    stillRank: (r, g) => `Weiter ${r}.${g ? ' in ' + g : ''}`,
    record: (w, l) => `Bisher ${w}:${l}`, recordWord: 'Bisher',
    laterWord: 'Später', laterM: 'Gerade kein Spiel für dich', laterF: 'Dein nächstes steht noch nicht fest',
    pauseWord: 'Pause', pauseM: 'Wir rufen dich nicht auf', pauseF: 'Sag am Eingang Bescheid, wenn du wieder da bist', pauseFtg: 'bis du wieder da bist',
    goneWord: 'Daheim', goneM: 'Für heute abgemeldet', goneF: 'Deine offenen Spiele gingen an deine Gegner:innen',
    soonWord: 'Bald', soonM: 'Gleich geht’s los', soonF: 'Sobald du dran bist, steht es hier',
    inWord: 'Dabei', inM: 'Du bist dabei', inF: 'Deine Auslosung kommt noch',
    inCup: 'Im',
    almostWord: 'Fast', almostM: 'Du stehst auf der Liste', almostF: c => `${c} · am Eingang bestätigen wir dich`,
    notinWord: 'Heute nicht', notinM: 'Heute bist du nicht eingetragen', notinF: 'Sag am Eingang Bescheid, wenn du mitspielen willst',
    tonight: 'Heute', thanksWord: 'Danke', thanksM: 'Danke fürs Mitspielen!',
    daysTo: n => plural(n, 'Tag bis zum Abend', 'Tage bis zum Abend'), hoursTo: n => plural(n, 'Stunde bis zum Abend', 'Stunden bis zum Abend'), minsTo: n => plural(n, 'Minute bis los geht’s', 'Minuten bis los geht’s'),
    entered: 'Angemeldet', nothingYet: 'noch nichts',
    notYou: 'Nicht du?',
    nowAt: t => 'jetzt an ' + t, onDeck: 'gleich dran', aheadShort: n => n + ' vor deinem', paused: 'Pause', gone: 'daheim', inDraw: 'im Turnier',
    pillQ: 'Spielst du heute?', pillA: 'Tipp deinen Namen →', pillOn: t => t + ' →',
    whoH: 'Wer bist du?', whoP: 'Einmal auswählen. Dieses Handy merkt es sich für den Abend.', find: 'Namen suchen',
    noName: 'Heute niemand mit diesem Namen.',
    pairWith: n => 'mit ' + n,
    everyone: 'Alle', onTables: 'An den Tischen', upNext: 'Als Nächstes', standings: 'Tabelle', results: 'Ergebnisse',
    playing: n => n + ' spielen', freeN: n => n + ' frei', pausedN: n => n + ' Pause',
    free: 'frei', tablePaused: 'Pause', finishing: c => `${c}-Spiel läuft noch`, otherCup: 'anderer Bewerb',
    toPlay: n => n + ' zu spielen', waitingN: n => n + ' warten', playedN: n => n + ' gespielt',
    getReady: 'Mach dich bereit', nextChip: 'als nächstes', putBack: 'zurückgestellt', waitsMatch: 'wartet auf ein Spiel',
    more: n => `${n} weitere`, andMore: n => `und ${n} weitere danach`, nothingQueued: 'Noch niemand in der Reihe.',
    yourCup: 'du spielst hier',
    goThrough: n => `Die ersten ${n} kommen weiter`, winsTonight: 'Siege heute', youAre: r => `Du bist ${r}.`, leads: n => n + ' führt',
    colW: 'S', colL: 'N', colBh: 'Bh', colDiff: '±',
    knockout: 'K.o.-Runde', champion: 'Sieger:in', tbd: 'steht noch nicht fest', liveAt: n => 'Tisch ' + n,
    beat: n => 'gegen ' + n, walkover: 'kampflos', bye: 'Freilos',
    findP: 'Spieler:in suchen', showAll: n => `Alle ${n} zeigen`, showLess: 'Weniger zeigen', noResult: 'Kein Ergebnis mit diesem Namen.', nothingPlayed: 'Noch nichts gespielt.',
    noTables: 'Noch keine Tische.',
    report: 'Ergebnis eintragen', reported: (s, o) => `Gemeldet: ${s} — ${o} bestätigt noch`,
    claimBy: b => `${b} meldet ein Ergebnis`, claimQ: (w, a, b) => `${w ? 'Du gewinnst' : 'Du verlierst'} ${a}:${b} — stimmt das?`,
    yes: 'Stimmt', no: 'Stimmt nicht',
    pause: 'Pause', back: 'Ich bin wieder da', leave: 'Ich gehe heim', stay: 'Doch noch da',
    leaveQ: 'Gehst du für heute? Deine offenen Spiele gehen dann kampflos an deine Gegner:innen.',
    evening: 'Dein Abend', stillToPlay: 'Noch zu spielen', w: 'S', l: 'N',
    orga: 'Nachricht an die Orga', orgaPh: 'Ich bin zehn Minuten später da …', send: 'Senden',
    news: 'Neuigkeiten', newsSub: 'Neue Abende und Ansagen der Orga', linkedSub: k => k ? 'Deine Aufrufe kommen hierher' : 'Nach dem Eingang kommen deine Aufrufe hierher', unlink: 'Lösen',
    unlinkQ: 'Dann bekommst du keine Tischaufrufe mehr, und wir kennen dich hier nicht mehr. Sicher?',
    signup: 'Anmeldung', confirmed: 'Bestätigt', youreIn: 'Du bist dabei', comingQ: 'Kommst du?', yesSee: 'Ja, bis dann', cant: 'Kann nicht',
    drop: 'Abmelden', dropQ: c => `Von ${c} abmelden?`, withPartner: 'Mit Partner:in', seeking: 'Partner:in gesucht', partnerPh: 'Name deiner Partnerin / deines Partners',
    seekNote: 'Wir losen dir jemanden zu, der auch alleine kommt.', imIn: 'Ich bin dabei', yourName: 'Dein Name', namePh: 'Vor- und Nachname',
    nameNote: 'So, wie wir dich am Eingang finden.', regClosed: 'Die Anmeldung ist noch nicht offen — wir sagen dir Bescheid.', needName: 'Wir brauchen deinen Namen.',
    single: 'Einzel', pair: 'Doppel', drawn: n => `mit ${n} — zugelost`, lookingFor: 'Partner:in gesucht', comes: 'kommt',
    result: 'Ergebnis', game: n => 'Satz ' + n, you: 'Du', youWin: (a, b) => `Du gewinnst ${a}:${b}`, youLose: (a, b) => `Du verlierst ${a}:${b}`,
    padNote: o => `${o} bestätigt — dann ist es eingetragen.`,
    outsideH: 'Öffne das in Telegram', outsideP: 'Dein Abend — wann du dran bist, deine Spiele, dein Tisch — steht in unserem Bot.',
  },
};
let LANG = SHELL === 'tg' ? 'de' : 'en';
let L = STR[LANG];

/* The console's labels as a player says them — tt/bot.py label_de, ported. */
const LABEL_FIXED = {
  de: { 'Final': 'Finale', 'Semi-final': 'Halbfinale', 'Quarter-final': 'Viertelfinale',
        'Third place': 'Spiel um Platz 3', 'Scramble doubles': 'Zufallsdoppel' },
  en: {},
};
const LABEL_EMPTY = ['Open play', 'Swiss', 'Manual', 'Manual entry'];
function labelL(label) {
  label = String(label || '').trim();
  if (LABEL_EMPTY.includes(label)) return '';
  const fixed = LABEL_FIXED[LANG][label];
  if (fixed) return fixed;
  if (LANG === 'de') {
    let m;
    if ((m = label.match(/^Group (.+)$/))) return 'Gruppe ' + m[1];
    if ((m = label.match(/^Round of (\d+)$/))) return 'Runde der letzten ' + m[1];
    if ((m = label.match(/^Round (\d+)$/))) return 'Runde ' + m[1];
  }
  return label;
}

/* Names. A pair is sent as "Nina Wagner / Ana Petrović" (or the team's own
   name); on a phone it reads as "Nina & Ana". */
const sides = name => String(name || '').split(' / ').filter(Boolean);
const first = n => String(n).trim().split(/\s+/)[0];
function nice(name) {
  const p = sides(name);
  return p.length > 1 ? p.map(first).join(' & ') : (p[0] || '');
}
function short(name) {             // "Maximilian Hofbauer" -> "Maximilian H."
  const w = String(name).trim().split(/\s+/);
  return w.length > 1 ? `${w[0]} ${w[w.length - 1][0]}.` : w[0];
}
const hhmm = ts => { if (!ts) return ''; const d = new Date(ts * 1000); return d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0'); };
const setsOf = games => { let a = 0, b = 0; (games || []).forEach(([x, y]) => { if (x > y) a++; else if (y > x) b++; }); return [a, b]; };
const scoreLine = games => (games || []).map(([a, b]) => `${a}:${b}`).join(' · ');

/* ------------------------------------------------------------ state */

let S = null;                      // /api/state, role public
let V = null;                      // /api/me (tg only)
let skew = 0;
let busy = false;
const ME_KEY = 'ttt_me';
let me = null;                     // web: { event, player } — who this phone is
const ui = {
  cup: null,                       // the strip's choice; null = not chosen yet
  q: '', all: false,               // results search
  upAll: false, stAll: {}, eveAll: false,   // lists opened past their first rows
  msg: '', name: null, kind: {}, partner: {},
  pad: null,
  moment: null,                    // a result that just landed: { until, ... }
  seen: null,                      // done match ids of mine, to notice a new one
  rank: {},                        // eid -> last known rank, for "up from 3rd"
  playingKey: '',
};
const CUP_KEY = 'ttt_cup';
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { } },
};

/* ------------------------------------------------------------ io

   The real thing talks to the server. A mockup or a test hands in its own
   object with the same four calls as window.TTT_IO. */

const IO = window.TTT_IO || {
  state: () => fetch('/api/state').then(r => r.ok ? r.json() : null),
  me: () => INIT ? fetch('/api/me', { headers: { 'X-Tg-Init': INIT }, cache: 'no-store' })
    .then(r => (r.status === 401 || r.status === 404) ? { outside: true } : r.json()) : Promise.resolve({ outside: true }),
  act: (op, data) => fetch('/api/me', {
    method: 'POST', cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-Tg-Init': INIT },
    body: JSON.stringify({ op, data: data || {} }),
  }).then(async r => ({ ok: r.ok, body: await r.json().catch(() => ({})) })),
  listen: cb => {
    let es = null, soon = null;
    const open = () => {
      try { es = new EventSource('/api/stream'); } catch (e) { return; }
      es.onmessage = () => { clearTimeout(soon); soon = setTimeout(cb, 250); };
      es.onerror = () => { es.close(); setTimeout(open, 4000); };
    };
    open();
  },
};

async function load() {
  try {
    const [s, v] = await Promise.all([IO.state(), SHELL === 'tg' ? IO.me() : null]);
    if (s) S = s;
    if (SHELL === 'tg') {
      if (v && v.outside) return outside();
      if (v) { V = v; skew = v.now - Date.now() / 1000; }
    } else if (s) {
      skew = s.now - Date.now() / 1000;
    }
    render();
  } catch (e) { /* hall wifi; the next push or tick catches up */ }
}

async function act(op, data, after) {
  if (busy) return false;
  busy = true;
  buzz('light');
  try {
    const r = await IO.act(op, data);
    if (!r.ok) { toast(r.body.error || 'Das hat nicht geklappt.', true); buzz('bad'); return false; }
    V = r.body.view || V;
    if (after) after();
    render();
    if (r.body.toast) toast(r.body.toast);
    buzz('ok');
    return true;
  } catch (e) {
    toast(LANG === 'de' ? 'Gerade keine Verbindung — versuch es gleich noch einmal.' : 'No connection right now — try again in a moment.', true);
    return false;
  } finally { busy = false; }
}

/* ------------------------------------------------------------ derive

   Where one entrant is tonight. On the Mini App the server says it
   (tt/bot.py state_of, through /api/me "tonight"); on the web page this
   works it out from /api/state in exactly the same shape, so one hero
   renders both. */

const cupOf = id => (S && S.cups || []).find(c => c.id === id) || null;
const cupName = id => (cupOf(id) || {}).name || '';
const fmtOf = cupId => {
  const c = cupOf(cupId);
  return (S.formats || []).find(f => c ? f.id === c.format_id : f.cup_id === cupId) || null;
};
const boardFor = cupId => (S && S.board || []).find(b => (b.cup_id || '') === (cupId || '')) || null;
const multiCup = () => (S && S.cups || []).length > 1;

/* Which match-slot each row waits for — tt/board.py cup_board, the `seat`
   loop. A fixture or a pairing takes a slot; two people waiting alone share
   one. The number of matches before yours is your slot. */
function slots(up) {
  const out = new Map();
  let seat = 0, half = null;
  for (const r of up) {
    if (r.kind === 'waiting') {
      if (half === null) { half = seat; out.set(r.id, seat); }
      else { out.set(r.id, half); half = null; seat += 1; }
    } else { out.set(r.id, seat); seat += 1; }
  }
  return out;
}

/* "Tisch 1–3" / "Alle Tische", in the page's language — the board sends a
   German tables_label; the numbers it is made from are right next to it. */
function tablesLabel(b) {
  if (!b) return '';
  const nums = (b.tables || []).slice().sort((x, y) => x - y);
  if (!nums.length) return L.tables('');
  if (!b.reserved && nums.length === (S.tables || []).length) return L.allTables;
  const runs = [];
  let a = nums[0], p = nums[0];
  for (const n of nums.slice(1)) { if (n === p + 1) { p = n; continue; } runs.push([a, p]); a = p = n; }
  runs.push([a, p]);
  return L.tables(runs.map(([x, y]) => x === y ? x : `${x}–${y}`).join(', '));
}

function sideOf(m, e, playerName) {
  if (m.entrant_a === e.id) return 'a';
  if (m.entrant_b === e.id) return 'b';
  // a scramble: four solo entrants, partners drawn on the spot
  return sides(m.players_a).includes(playerName) ? 'a' : 'b';
}

function record(eid) {
  let w = 0, l = 0;
  for (const m of (S.recent || [])) {
    if (m.meta && m.meta.bye) continue;
    const side = m.entrant_a === eid ? 'a' : m.entrant_b === eid ? 'b'
      : (m.meta && (m.meta.queued || []).includes(eid)) ? 'q' : null;
    if (!side || side === 'q') continue;      // a scramble's sides are players, not entrants
    if (m.winner === side) w++; else if (m.winner) l++;
  }
  return [w, l];
}

function stateOf(e, playerName) {
  const st = e.status;
  const x = { state: st, table: '', table_no: null, match: null, opponent: '', partners: [],
              label: '', best_of: '', bo: 3, need: 2, eta_min: null, position: null,
              on_deck: false, ahead: null, since: null, tables: '', won: 0, lost: 0,
              eid: e.id, cup: multiCup() ? cupName(e.cup_id) : '', cup_id: e.cup_id };
  const b = boardFor(e.cup_id);
  if (b) x.tables = tablesLabel(b);
  if (st === 'playing') {
    for (const t of S.tables) {
      const m = t.match;
      if (!m || !(m.entrant_a === e.id || m.entrant_b === e.id || ((m.meta || {}).queued || []).includes(e.id))) continue;
      const side = sideOf(m, e, playerName);
      const mine = sides(side === 'a' ? m.players_a : m.players_b);
      Object.assign(x, {
        table: tableName(t), table_no: t.number, match: m.id,
        opponent: side === 'a' ? m.b : m.a,
        partners: mine.filter(n => n !== playerName),
        label: labelL(m.label), best_of: L.bestOf(m.scoring.best_of, m.scoring.points_to),
        bo: m.scoring.best_of, pts: m.scoring.points_to, need: Math.floor(m.scoring.best_of / 2) + 1,
        since: m.started_ts || null,                       // PROPOSED in match_dto
      });
      break;
    }
  } else if ((st === 'waiting' || st === 'drawn') && b) {
    const r = b.up.find(r => (r.entrants || []).includes(e.id));
    if (r) {
      const at = r.ahead ?? slots(b.up).get(r.id);         // PROPOSED: row.ahead
      Object.assign(x, { on_deck: !!r.on_deck, eta_min: r.eta_min, position: r.position, ahead: at,
                         label: labelL(r.label) === cupName(e.cup_id) ? '' : labelL(r.label) });
      if (r.kind !== 'waiting') {
        const other = (r.entrants || []).find(id => id && id !== e.id);
        const oe = (S.entrants || []).find(z => z.id === other);
        x.opponent = oe ? oe.name : (r.a === e.name ? r.b : r.a) || '';
      }
    } else if (st === 'waiting' && b.total > b.up.length) {
      // past the 24 rows the board sends: at least that many before
      x.ahead = b.up.length;
      x.ahead_more = true;
    }
  }
  [x.won, x.lost] = record(e.id);
  return x;
}

/* Most urgent first — tt/me.py _rank. */
const URGENT = { playing: 0, waiting: 1, drawn: 1, entered: 2, resting: 3, outside: 4, withdrawn: 5 };
const urgency = x => {
  const base = URGENT[x.state] ?? 9;
  if (x.state === 'waiting' || x.state === 'drawn')
    return [base, x.on_deck ? 0 : 1, x.eta_min ?? 999];
  return [base, 0, 0];
};
const byUrgency = (p, q) => { const a = urgency(p), b = urgency(q); return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]; };

function tableName(t) {
  const n = String(t.name || '').trim();
  return (!n || /^Table\s+\d+$/.test(n)) ? L.table1(t.number) : n;
}

/* The person this page is about, as a list of entrant states. */
function myPlayer() {
  if (SHELL !== 'web' || !me || !S) return null;
  return (S.players || []).find(p => p.id === me.player) || null;
}
function myEntrants() {
  if (!S) return [];
  if (SHELL === 'tg') {
    const ids = new Set((V && V.tonight || []).map(x => x.eid));
    return (S.entrants || []).filter(e => ids.has(e.id));
  }
  const p = myPlayer();
  return p ? (S.entrants || []).filter(e => e.player_ids.includes(p.id)) : [];
}
function tonight() {
  if (SHELL === 'tg') {
    // the Mini App's own list (state_of), with what the room adds to it:
    // which cup, and the tables that cup plays on
    return (V && V.tonight || []).map(x => {
      const e = S && (S.entrants || []).find(z => z.id === x.eid);
      const cup_id = x.cup_id ?? (e ? e.cup_id : '');
      return { ...x, cup_id, tables: x.tables || (S ? tablesLabel(boardFor(cup_id)) : '') };
    });
  }
  const p = myPlayer();
  if (!p) return [];
  return myEntrants().map(e => stateOf(e, p.name)).sort(byUrgency);
}
function myIds() { return new Set(myEntrants().map(e => e.id)); }
const known = () => SHELL === 'tg' ? !!V : !!myPlayer();
function isMine(m, ids) {
  if (!m) return false;
  return ids.has(m.entrant_a) || ids.has(m.entrant_b) || ((m.meta || {}).queued || []).some(q => ids.has(q));
}

/* Where an entrant stands in its standings, for "Now 2nd in group A". */
function rankOf(eid) {
  const e = (S.entrants || []).find(z => z.id === eid);
  const f = e && fmtOf(e.cup_id);
  if (!f || !f.standings) return null;
  for (const g of f.standings) {
    const r = g.rows.find(r => r.entrant_id === eid);
    if (r) return { rank: r.rank, group: f.standings.length > 1 ? labelL(g.group) : '' };
  }
  return null;
}

/* ------------------------------------------------------------ the hero

   One object, one number, three lines of text. A hero is plain data first
   (what to say), then painted (where the table is, how sharp). */

function heroData() {
  if (SHELL === 'tg' && V) {
    const ph = V.phase;
    if (ph === 'announced' || ph === 'registration') return heroBefore();
    if (ph === 'done') return heroDone();
  }
  if (ui.moment && ui.moment.until > Date.now()) return heroResult(ui.moment);
  const t = tonight();
  if (!t.length) {
    if (SHELL !== 'tg') return null;
    const pend = (V.entries || []).find(e => e.status === 'pending');
    return pend
      ? { key: 'almost', kind: 'word', a: 4, big: L.almostWord, m: L.almostM, facts: [L.almostF(pend.cup)], oppL: L.tonight, opp: pend.cup }
      : { key: 'notin', kind: 'word', a: 4, big: L.notinWord, m: L.notinM, facts: [L.notinF], oppL: L.tonight, opp: '', soft: L.nothingYet };
  }
  const x = t[0];
  const H = heroFor(x);
  H.x = x;
  H.also = t.slice(1);
  return H;
}

function heroFor(x) {
  const rec = (x.won || x.lost) ? L.record(x.won, x.lost) : '';
  const facts = (...xs) => xs.filter(Boolean);
  if (x.state === 'playing') {
    return { key: 'table' + (x.table_no || x.table), kind: 'table', big: String(x.table_no ?? tableNoFromV(x) ?? '•'),
      m: L.yourTable + (x.table && !/^(Tisch|Table) \d+$/.test(x.table) ? ' · ' + x.table : ''),
      facts: facts(x.since ? L.since(hhmm(x.since)) : '', x.best_of, x.label, x.partners.length ? L.with(x.partners.map(first).join(', ')) : ''),
      oppL: L.against, opp: nice(x.opponent) };
  }
  if (x.state === 'waiting' || x.state === 'drawn') {
    if (x.on_deck) {
      return { key: 'next', kind: 'next', big: L.nextWord, m: L.nextM, facts: facts(L.stayClose, x.tables, x.label),
        oppL: L.against, opp: nice(x.opponent), soft: x.opponent ? '' : L.open };
    }
    if (x.ahead != null) {
      return { key: 'ahead' + x.ahead, kind: 'ahead', a: Math.min(x.ahead, 4), big: x.ahead + (x.ahead_more ? '+' : ''),
        m: L.ahead(x.ahead), facts: facts(x.tables, x.label, rec),
        oppL: L.nextAgainst, opp: nice(x.opponent), soft: x.opponent ? '' : L.toBeDrawn };
    }
    // in the draw, nothing for them right now: between rounds, or waiting
    // for the other half of a bracket
    return { key: 'later', kind: 'word', a: 4, big: L.laterWord, m: L.laterM, facts: facts(L.laterF, x.label),
      oppL: L.recordWord, opp: x.won || x.lost ? `${x.won} : ${x.lost}` : '', soft: L.nothingYet };
  }
  if (x.state === 'resting') {
    return { key: 'rest', kind: 'word', a: 4, quiet: true, big: L.pauseWord, m: L.pauseM,
      facts: [SHELL === 'tg' ? L.pauseFtg : L.pauseF], oppL: L.recordWord, opp: rec ? `${x.won} : ${x.lost}` : '', soft: L.nothingYet };
  }
  if (x.state === 'withdrawn') {
    return { key: 'gone', kind: 'word', a: 4, quiet: true, big: L.goneWord, m: L.goneM, facts: [L.goneF],
      oppL: L.recordWord, opp: rec ? `${x.won} : ${x.lost}` : '', soft: L.nothingYet };
  }
  const cup = x.cup || cupName(x.cup_id) || '';
  if (x.state === 'entered') {
    return { key: 'soon', kind: 'word', a: 4, big: L.soonWord, m: L.soonM, facts: facts(L.soonF, x.tables),
      oppL: L.inCup, opp: cup };
  }
  return { key: 'in', kind: 'word', a: 4, big: L.inWord, m: L.inM, facts: [L.inF], oppL: L.inCup, opp: cup };
}

/* The Mini App's state_of names the table ("Tisch 3") but not its number;
   until it sends table_no (PROPOSED), the table marked mine has it. */
function tableNoFromV(x) {
  const t = (V && V.tables || []).find(t => t.mine);
  if (t) return t.number;
  const m = String(x.table || '').match(/(\d+)\s*$/);
  return m ? +m[1] : null;
}

function heroResult(mo) {
  return { key: 'result' + mo.id, kind: 'result', a: 4, big: `${mo.sets[0]}–${mo.sets[1]}`,
    m: mo.won ? L.won : L.lost, facts: mo.rankLine.length ? mo.rankLine : [scoreLine(mo.games)],
    oppL: L.played, opp: nice(mo.opponent) };
}

function heroBefore() {
  const ev = V.event;
  const left = ev.starts_ts ? ev.starts_ts - (Date.now() / 1000 + skew) : null;
  const cups = (V.entries || []).map(e => e.cup).filter(Boolean);
  const H = { key: 'before', kind: 'word', a: 4, big: '', m: '', facts: [ev.when].filter(Boolean),
    oppL: L.entered, opp: cups.join(' & '), soft: L.nothingYet };
  if (left && left > 0) {
    const d = Math.floor(left / 86400), h = Math.floor(left / 3600), m = Math.max(1, Math.floor(left / 60));
    Object.assign(H, d >= 1 ? { big: String(d), m: L.daysTo(d) } : h >= 1 ? { big: String(h), m: L.hoursTo(h) } : { big: String(m), m: L.minsTo(m) });
    H.kind = 'count';
    H.key = 'before' + H.big;
  } else {
    Object.assign(H, { big: L.soonWord, m: L.soonM });
  }
  return H;
}

function heroDone() {
  const t = V.tonight || [];
  const w = t.reduce((n, x) => n + (x.won || 0), 0), l = t.reduce((n, x) => n + (x.lost || 0), 0);
  const places = (V.places || []).map(p => p.replace(/^\W+\s*/u, ''));
  return { key: 'done', kind: 'word', a: 2, big: L.thanksWord, m: L.thanksM,
    facts: places.length ? places : [], oppL: L.tonight, opp: w || l ? `${w} : ${l}` : '', soft: L.nothingYet };
}

/* Where the table sits, how big, how sharp. It is always the table, only
   out of focus: each match before yours brings it a little closer. */
function geom(H, W) {
  const r = 1.2;
  if (H.kind === 'table') {
    const w = Math.min(226, W - 120), h = w * r;
    return { x: (W - w) / 2, y: 58, w, h, b: 0, lines: .9, sharp: true, ny: 58 + h * .5 - 74 };
  }
  if (H.kind === 'next') { const w = 250; return { x: (W - w) / 2 + 34, y: 54, w, h: w * r, b: 5, lines: .55 }; }
  const a = Math.max(0, Math.min(H.a ?? 4, 4));
  const w = [250, 240, 230, 220, 210][a];
  return { x: (W - w) / 2 + 46, y: 58 + a * 6, w, h: w * r,
    b: H.kind === 'result' ? 30 : [9, 18, 27, 35, 42][a], lines: H.quiet ? .35 : .5 };
}

let lastKey = null, pulled = false;
function paintHero(H, entering) {
  const hero = $('hero');
  hero.hidden = !H;
  if (!H) { lastKey = null; return; }
  const W = hero.clientWidth || Math.min(innerWidth, 460);
  const g = geom(H, W), o = $('obj');
  const set = gg => Object.entries({ '--x': gg.x + 'px', '--y': gg.y + 'px', '--w': gg.w + 'px', '--h': gg.h + 'px', '--b': gg.b + 'px', '--lines': gg.lines })
    .forEach(([k, v]) => o.style.setProperty(k, v));
  if (entering && !reduced()) {
    // the focus pull: start far away and soft, then come in
    set({ ...g, b: 60, x: g.x + 30, y: g.y + 30, w: g.w * .8, h: g.h * .8, lines: 0 });
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => set(g), 60)));
  } else set(g);
  o.classList.toggle('sharp', !!g.sharp);

  const changed = H.key !== lastKey;
  const n = $('num');
  if (changed || entering) {
    n.className = 'num' + ({ next: ' word', word: ' word', result: ' score' }[H.kind] || '') + (g.sharp ? ' on' : '') + (!reduced() ? ' in' : '');
    n.style.removeProperty('font-size');
    n.innerHTML = [...H.big].map((c, k) => `<span style="animation-delay:${(entering ? 250 : 0) + k * 70}ms">${c === ' ' ? '&nbsp;' : esc(c)}</span>`).join('');
    fit(n, W);
  }
  if (g.sharp) n.style.setProperty('--ny', g.ny + 'px');

  const lab = $('lab');
  lab.className = 'lab' + (g.sharp ? ' center' : '');
  lab.style.setProperty('--ly', (g.sharp ? g.y + g.h + 20 : 318) + 'px');
  lab.innerHTML = `<span class="m">${esc(H.m)}</span>${H.facts.length
    ? `<span class="f micro">${H.facts.map(esc).join('<i>·</i>')}</span>` : ''}`;
  $('opp').innerHTML = `<span class="micro">${esc(H.oppL)}</span>${H.opp
    ? `<b>${esc(H.opp)}</b>` : `<b class="soft">${esc(H.soft || '')}</b>`}`;

  const name = SHELL === 'tg' ? (V.me.name || V.me.first) : (myPlayer() || {}).name;
  $('who').innerHTML = `<span>${esc(name || '')}${H.x && H.x.cup ? ' · ' + esc(H.x.cup) : ''}</span>${SHELL === 'web'
    ? `<button type="button" data-act="not-me">${esc(L.notYou)}</button>` : ''}`;

  if (changed && H.kind === 'table' && lastKey !== null) buzz('call');
  lastKey = H.key;
}

/* Long words ("Daheim", "Heute nicht") and two-digit numbers ("20 hours")
   shrink to the width; a word keeps air on its right. */
function fit(n, W) {
  if (n.classList.contains('on')) return;            // a table number sits inside the table
  const room = n.classList.contains('word') ? W - 80 : W - 44;
  const w = n.scrollWidth;
  if (w > room) n.style.fontSize = Math.floor(parseFloat(getComputedStyle(n).fontSize) * room / w) + 'px';
}

/* Under the hero: the person's other entries, and (Mini App) what they can do. */
function also(H) {
  if (!H || !H.also || !H.also.length) return '';
  // an entry on a break or gone home can be brought back from here too,
  // not only when it happens to be the most urgent one
  const back = o => SHELL !== 'tg' ? ''
    : o.state === 'resting' ? ` <button class="link" data-act="rest" data-eid="${esc(o.eid)}" data-on="">${esc(L.back)}</button>`
    : o.state === 'withdrawn' ? ` <button class="link" data-act="leave" data-eid="${esc(o.eid)}" data-on="">${esc(L.stay)}</button>` : '';
  return `<div class="also">${H.also.map(o => `<div><b>${esc(o.cup || cupName(o.cup_id))}</b><span class="st2">${shortState(o)}${back(o)}</span></div>`).join('')}</div>`;
}
function shortState(o) {
  if (o.state === 'playing') return `<span class="red">${esc(L.nowAt(o.table))}</span>`;
  if (o.state === 'resting') return `<span>${esc(L.paused)}</span>`;
  if (o.state === 'withdrawn') return `<span>${esc(L.gone)}</span>`;
  if (o.on_deck) return `<span class="red">${esc(L.onDeck)}</span>`;
  if (o.ahead != null) return `<span>${esc(L.aheadShort(o.ahead))}</span>`;
  return `<span>${esc(L.inDraw)}</span>`;
}

function actions(H) {
  if (SHELL !== 'tg' || !H || !H.x) return '';
  const x = H.x;
  if (x.state === 'playing') {
    if (!V.scores) return '';
    const mine = (V.reported || [])[0];
    return mine
      ? `<div class="acts"><p class="note">${esc(L.reported(scoreLine(mine.games), nice(x.opponent)))}</p></div>`
      : `<div class="acts"><button class="btn red wide" data-act="pad">${esc(L.report)}</button></div>`;
  }
  if (x.state === 'resting') return `<div class="acts">
      <button class="btn wide" data-act="rest" data-eid="${esc(x.eid)}" data-on="">${esc(L.back)}</button>
      <button class="btn ghost" data-act="leave" data-eid="${esc(x.eid)}" data-on="1">${esc(L.leave)}</button></div>`;
  if (x.state === 'withdrawn') return `<div class="acts">
      <button class="btn wide" data-act="leave" data-eid="${esc(x.eid)}" data-on="">${esc(L.stay)}</button></div>`;
  return `<div class="acts"><button class="btn ghost small" data-act="rest" data-eid="${esc(x.eid)}" data-on="1">${esc(L.pause)}</button></div>`;
}

/* A score the other side reported, waiting for this person: it needs them,
   so it goes first. */
function claims() {
  if (SHELL !== 'tg' || !V) return '';
  return (V.confirm || []).map(c => `<div class="ask">
    <div class="micro">${esc(L.claimBy(nice(c.by)))}</div>
    <div class="sc">${scoreLine(c.games)}</div>
    <div>${esc(L.claimQ(c.sets[0] > c.sets[1], c.sets[0], c.sets[1]))}</div>
    <div class="row">
      <button class="btn" data-act="confirm" data-id="${c.id}" data-yes="1">${esc(L.yes)}</button>
      <button class="btn no" data-act="confirm" data-id="${c.id}" data-yes="">${esc(L.no)}</button>
    </div></div>`).join('');
}

/* A result that just landed is a moment, not a screen: six seconds, then
   the page goes back to the line on its own. */
const MOMENT_MS = 6000;
function noticeResults() {
  if (!S || !known()) { ui.seen = null; return; }
  const ids = myIds();
  const mine = (S.recent || []).filter(m => isMine(m, ids));
  const seen = new Set(mine.map(m => m.id));
  if (ui.seen) {
    const fresh = mine.find(m => !ui.seen.has(m.id) && !(m.meta || {}).walkover && !(m.meta || {}).bye);
    if (fresh) {
      const e = myEntrants().find(z => z.id === fresh.entrant_a || z.id === fresh.entrant_b
        || ((fresh.meta || {}).queued || []).includes(z.id));
      const p = SHELL === 'web' ? (myPlayer() || {}).name : (V.me.name || '');
      const side = e ? sideOf(fresh, e, p) : 'a';
      const games = side === 'a' ? fresh.games : fresh.games.map(([a, b]) => [b, a]);
      const was = e ? ui.rank[e.id] : null, now = e ? rankOf(e.id) : null;
      const rankLine = !now ? [] : !was || was.rank === now.rank ? [L.stillRank(now.rank, now.group)]
        : [L.nowRank(now.rank, now.group), now.rank < was.rank ? L.upFrom(was.rank) : L.downFrom(was.rank)];
      ui.moment = { id: fresh.id, until: Date.now() + MOMENT_MS, won: fresh.winner === side,
        sets: setsOf(games), games, opponent: side === 'a' ? fresh.b : fresh.a, rankLine };
      buzz(fresh.winner === side ? 'ok' : 'light');
      clearTimeout(ui.momentT);
      ui.momentT = setTimeout(() => { ui.moment = null; render(); }, MOMENT_MS);
    }
  }
  ui.seen = seen;
  for (const e of myEntrants()) { const r = rankOf(e.id); if (r) ui.rank[e.id] = r; }
}

/* ------------------------------------------------------------ the room */

function inView(cupId) { const c = selectedCup(); return !c || cupId == null || cupId === '' || cupId === c; }
function selectedCup() {
  if (!multiCup()) return '';
  if (ui.cup !== null) return ui.cup;
  const saved = store.get(CUP_KEY);
  if (saved !== null && (saved === '' || cupOf(saved))) return saved;
  // somebody in exactly one cup starts on their cup; everyone else on all
  const cups = [...new Set(myEntrants().map(e => e.cup_id))];
  return cups.length === 1 && cupOf(cups[0]) ? cups[0] : '';
}
function setCup(id) { ui.cup = id || ''; store.set(CUP_KEY, ui.cup); renderRoom(); }

/* How far along each cup is. A draw that knows its matches is a fraction;
   open play is a count — nobody knows its total. */
function progress(cupId) {
  const f = fmtOf(cupId);
  const b = boardFor(cupId);
  const done = (S.recent || []).filter(m => m.cup_id === cupId && !(m.meta || {}).bye).length;
  const playing = S.tables.filter(t => t.match && t.match.cup_id === cupId).length;
  if (!f || f.uses_queue || f.kind === 'open_play') return { done, total: null, playing };
  const left = b ? b.fixtures : 0;
  return { done, total: done + playing + left, playing };
}

/* The cup switch: the cup's name, centred, nothing else. The counts
   that used to sit here each have their place below, in the tables, Up
   next and the standings — the same switch as the console's. Your own cup
   has its name in red. */
const LIST_ROWS = 5;               // every list: five rows, then "+ N more"
const TABLE_ROWS = 10;             // a standings table: ten, then the rest
function strip() {
  if (!multiCup()) return '';
  const sel = selectedCup();
  const mine = new Set(myEntrants().map(e => e.cup_id));
  const tile = (id, name, bar, cls, tip) => `<button type="button" class="${cls || ''}${sel === id ? ' on' : ''}" data-act="cup" data-cup="${esc(id)}" aria-pressed="${sel === id}"${tip ? ` title="${esc(tip)}"` : ''}>
      <span class="t"><span>${esc(name)}</span></span></button>`;
  return `<nav class="strip" aria-label="${esc(L.everyone)}">${
    tile('', L.everyone, null, 'all')}${
    S.cups.map(c => {
      const p = progress(c.id);
      return tile(c.id, c.name, p.total ? p.done / p.total : null, mine.has(c.id) ? 'mine' : '',
        p.total ? `${p.done}/${p.total}` : L.playedN(p.done));
    }).join('')}</nav>`;
}

function head(title, note) {
  return `<div class="h"><b>${esc(title)}</b>${note ? `<span class="micro">${esc(note)}</span>` : ''}</div>`;
}

/* The tables. A table belongs to the cup of the match on it, not only to
   its tag (app.js renderTables): a busy table follows its match, a free one
   follows its tag, and a table reserved for this cup that is still
   finishing another cup's match shows as exactly that. */
function tablesSection() {
  const all = S.tables || [];
  if (!all.length) return head(L.onTables) + `<p class="sub">${esc(L.noTables)}</p>`;
  if (S.phase === 'done' && !all.some(t => t.match)) return '';
  const vis = all.filter(t => t.match ? inView(t.match.cup_id) || (t.cup_id != null && inView(t.cup_id)) : inView(t.cup_id));
  if (!vis.length) return '';
  const ids = myIds();
  const someone = known() && ids.size > 0;
  const showCup = multiCup() && !selectedCup();
  const busyN = vis.filter(t => t.match && inView(t.match.cup_id)).length;
  const freeN = vis.filter(t => !t.match && !t.paused).length;
  const pausedN = vis.filter(t => !t.match && t.paused).length;
  const note = [busyN ? L.playing(busyN) : '', freeN ? L.freeN(freeN) : '', pausedN ? L.pausedN(pausedN) : ''].filter(Boolean).join(' · ');
  const n = vis.length;
  // up to six tables in two columns; more than that in three, smaller —
  // every table the same size, an odd last row centred under the others
  const cols = n === 1 ? 1 : n > 6 ? 3 : 2;
  const rem = n % cols;
  const tiles = vis.map((t, k) => {
    const m = t.match;
    const tail = cols > 1 && rem && k >= n - rem ? ` o${rem}${rem === 2 ? (k === n - 2 ? 'a' : 'b') : ''}` : '';
    let cls = 'tb', body, aria;
    if (!m) {
      cls += t.paused ? ' paused' : ' free';
      body = `<div class="side a"><span>${esc(t.paused ? L.tablePaused : L.free)}</span></div>`;
      aria = `${tableName(t)}: ${t.paused ? L.tablePaused : L.free}`;
    } else if (!inView(m.cup_id)) {
      cls += ' other';
      body = `<div class="side a"><span class="amp">${esc(L.finishing(cupName(m.cup_id) || L.otherCup))}</span></div>`;
      aria = `${tableName(t)}: ${L.finishing(cupName(m.cup_id) || L.otherCup)}`;
    } else {
      if (isMine(m, ids)) cls += ' mine';
      const lbl = showCup ? cupName(m.cup_id) : labelL(m.label);
      body = (lbl ? `<div class="lbl">${esc(lbl)}</div>` : '') + side(m.a, 'a', cols === 3) + side(m.b, 'b', cols === 3);
      aria = `${tableName(t)}: ${m.a} – ${m.b}`;
    }
    return `<div class="slot${tail}"><div class="${cls}" role="img" aria-label="${esc(aria)}">
      <div class="skin"></div><div class="edge"></div><div class="cl"></div>${body}
      <div class="net"><span class="no">${t.number}</span></div></div></div>`;
  }).join('');
  return head(L.onTables, note) + `<div class="grid n${n === 1 ? 1 : ''} c${cols}${someone ? ' someone' : ''}">${tiles}</div>`;
}
function side(name, cls, compact) {
  const p = sides(name);
  // one person: first name over last name, as a pair stacks its two
  if (p.length === 1 && !compact) {
    const w = p[0].trim().split(/\s+/);
    if (w.length > 1) return `<div class="side ${cls}"><span>${esc(w[0])}</span><span>${esc(w.slice(1).join(' '))}</span></div>`;
  }
  return `<div class="side ${cls}">${p.map(x => `<span>${esc(compact ? short(x) : x)}</span>`).join('<span class="amp">&amp;</span>')}</div>`;
}

/* Who plays next. Order, never place, and no clock (board.py): the times
   are an estimate the wall can afford and a phone in a hand cannot. */
function upNextSection() {
  const bs = (S.board || []).filter(b => inView(b.cup_id));
  if (!bs.length) return '';
  const ids = myIds();
  const grouped = multiCup() && !selectedCup();
  const row = r => {
    const me = (r.entrants || []).some(id => ids.has(id));
    const right = r.on_deck ? `<span class="ready">${esc(L.getReady)}</span>`
      : r.kind === 'pairing' ? `<span class="chip">${esc(L.nextChip)}</span>`
      : r.deferred > 0 ? `<span class="chip">${esc(L.putBack)}</span>` : '<span></span>';
    const nm = r.kind === 'waiting'
      ? `${esc(nice(r.a))}<span class="v">${esc(L.waitsMatch)}</span>`
      : `${esc(nice(r.a))}<span class="v">${esc((LANG === 'de' ? 'gegen ' : 'vs ') + nice(r.b))}</span>`;
    return `<div class="r${me ? ' me' : ''}"><span class="i">${String(r.position).padStart(2, '0')}</span><span class="nm">${nm}</span>${right}</div>`;
  };
  if (!grouped) {
    return bs.map(b => {
      const note = [b.fixtures ? L.toPlay(b.fixtures) : '', b.waiting ? L.waitingN(b.waiting) : '', tablesLabel(b)].filter(Boolean).join(' · ');
      const shown = ui.upAll ? b.up : b.up.slice(0, LIST_ROWS);
      const mineAt = b.up.findIndex(r => (r.entrants || []).some(id => ids.has(id)));
      const extra = !ui.upAll && mineAt >= LIST_ROWS ? [b.up[mineAt]] : [];
      const hidden = b.up.length - shown.length - extra.length;
      return head(L.upNext + (bs.length > 1 ? ' · ' + cupName(b.cup_id) : ''), note)
        + `<div class="list">${shown.map(row).join('') || `<p class="sub">${esc(L.nothingQueued)}</p>`}${
          extra.length ? `<div class="gap" aria-hidden="true">···</div>${extra.map(row).join('')}` : ''}</div>`
        + (hidden > 0 ? `<button type="button" class="more" data-act="up-all">+ ${esc(L.more(hidden))}</button>`
          : ui.upAll && b.up.length > LIST_ROWS ? `<button type="button" class="more" data-act="up-all">${esc(L.showLess)}</button>`
          : b.total > b.up.length ? `<p class="more">${esc(L.andMore(b.total - b.up.length))}</p>` : '');
    }).join('');
  }
  // everyone, several cups: three rows a cup so the cups line up, your row
  // kept if it is further down, the rest one tap away
  const ROWS = 3;                  // per cup, so the cups line up; one cup gets LIST_ROWS
  return head(L.upNext) + bs.map(b => {
    const shown = b.up.slice(0, ROWS);
    const mineAt = b.up.findIndex(r => (r.entrants || []).some(id => ids.has(id)));
    const extra = mineAt >= ROWS ? [b.up[mineAt]] : [];
    const rest = b.total - shown.length - extra.length;
    return `<div class="cuphead"><b>${esc(cupName(b.cup_id))}</b><span>${esc(tablesLabel(b))}</span></div>
      <div class="list">${shown.map(row).join('') || `<p class="sub">${esc(L.nothingQueued)}</p>`}${
        extra.length ? `<div class="gap" aria-hidden="true">···</div>${extra.map(row).join('')}` : ''}</div>${
      rest > 0 ? `<button type="button" class="more" data-act="cup" data-cup="${esc(b.cup_id)}">+ ${esc(L.more(rest))}</button>` : ''}`;
  }).join('');
}

/* Standings, as each kind of draw has them. */
function standingsBlock(f, ids) {
  const out = [];
  const groups = (f.standings || []).filter(g => g.rows.length);
  const bracket = f.view && f.view.bracket;
  if (bracket) out.push(koBlock(bracket, ids));
  if (groups.length && groups.some(g => g.rows.some(r => r.played))) {
    const swiss = f.kind === 'swiss';
    const open = f.kind === 'open_play';
    const adv = f.kind === 'groups' && f.config && f.config.then_ko ? +(f.config.advance_per_group || 2) : 0;
    const many = groups.length > 1;
    const hd = `<div class="st head${swiss ? ' swiss' : ''}"><span></span><span></span><span>${esc(L.colW)}</span><span>${esc(swiss ? L.colBh : L.colL)}</span><span>${esc(L.colDiff)}</span></div>`;
    out.push(groups.map(g => {
      const rows = open ? g.rows.slice().sort((a, b) => b.won - a.won || a.lost - b.lost) : g.rows;
      const key = f.id + '|' + g.group, open2 = ui.stAll[key];
      const cutAt = open2 ? rows.length : TABLE_ROWS;
      const more = rows.length > TABLE_ROWS
        ? `<button type="button" class="more" data-act="st-all" data-k="${esc(key)}">${esc(open2 ? L.showLess : '+ ' + L.more(rows.length - TABLE_ROWS))}</button>` : '';
      return `${many || adv ? `<div class="grp micro">${esc(labelL(g.group))}${adv ? ' · ' + esc(L.goThrough(adv)) : ''}</div>` : ''}${hd}${
        rows.slice(0, cutAt).map((r, i) => {
          const rank = open ? i + 1 : r.rank;
          const q = adv && rank <= adv;
          const cut = adv && rank === adv;
          return `<div class="st${swiss ? ' swiss' : ''}${q ? ' q' : ''}${cut ? ' cut' : ''}${ids.has(r.entrant_id) ? ' me' : ''}">
            <span class="pos">${rank}</span><span>${esc(nice(r.name))}</span><span>${r.won}</span>
            <span>${swiss ? (r.buchholz ?? 0) : r.lost}</span><span>${r.point_diff > 0 ? '+' : ''}${r.point_diff ?? ''}</span></div>`;
        }).join('')}${more}`;
    }).join(''));
  }
  return out.join('');
}
/* The knockout as a tree: rounds left to right, each match centred between
   the two it is fed by, lines joining them. Your road through it is red;
   the match being played carries its table. Rounds that do not halve the
   one before (the match for third) sit under the tree. Wider than the
   phone (16 and up) it scrolls sideways, opened at the round being played. */
const KO = { mh: 50, gap: 12, cg: 18, top: 22 };
function koBlock(rounds, ids) {
  const names = new Set((S.entrants || []).filter(e => ids.has(e.id)).map(e => e.name));
  // the tree runs up to the final (the first round with one match); a round
  // after it is the match for third
  const fi = rounds.findIndex(rd => rd.matches.length === 1);
  const tree = fi < 0 ? rounds : rounds.slice(0, fi + 1), extra = fi < 0 ? [] : rounds.slice(fi + 1);
  const R = tree.length;
  const avail = Math.min(innerWidth, 460) - 40;
  let cw = Math.floor((avail - (R - 1) * KO.cg) / R);
  const wide = cw < 112;
  if (wide) cw = 128;
  const { mh, gap, cg, top } = KO;
  // Place by bracket slot (slot i feeds slot i>>1 of the next round). A bye
  // is not a match, so the tree is laid out from the final down: a match
  // sits level with the matches that feed it, and one fed by nothing takes
  // the next free row — no empty rows where the byes were.
  const slotOf = (m, i) => m.slot ?? i;                          // PROPOSED: bracket_view slot
  const bySlot = tree.map(rd => new Map(rd.matches.map((m, i) => [slotOf(m, i), m])));
  const Y = tree.map(() => new Map());
  let rows = 0;
  const place = (r, sl) => {
    if (!bySlot[r].has(sl)) return null;
    const kids = r > 0 ? [place(r - 1, 2 * sl), place(r - 1, 2 * sl + 1)].filter(v => v != null) : [];
    const y = kids.length ? kids.reduce((a, b) => a + b, 0) / kids.length : top + (rows++) * (mh + gap) + mh / 2;
    Y[r].set(sl, y);
    return y;
  };
  tree[R - 1].matches.forEach((m, i) => place(R - 1, slotOf(m, i)));
  // anything the walk did not reach (a draw still being wired) goes underneath
  tree.forEach((rd, r) => rd.matches.forEach((m, i) => { if (!Y[r].has(slotOf(m, i))) Y[r].set(slotOf(m, i), top + (rows++) * (mh + gap) + mh / 2); }));
  const ys = tree.map((rd, r) => rd.matches.map((m, i) => Y[r].get(slotOf(m, i))));
  const n0 = rows;
  const fin = tree[R - 1].matches.length === 1 ? tree[R - 1].matches[0] : null;
  const champ = fin && fin.winner ? (fin.winner === 'a' ? fin.a : fin.b) : null;
  let H = top + n0 * (mh + gap) - gap;
  if (champ) H = Math.max(H, ys[R - 1][0] + mh / 2 + 58);
  const Wt = R * cw + (R - 1) * cg;
  const x = r => r * (cw + cg);
  const won = m => m.winner ? (m.winner === 'a' ? m.a : m.b) : null;

  const lines = [];
  for (let r = 1; r < R; r++) tree[r].matches.forEach((m, i) => {
    const sl = slotOf(m, i);
    [2 * sl, 2 * sl + 1].forEach(k => {
      const f = bySlot[r - 1].get(k);
      if (!f) return;                                    // a bye: nothing to join
      const x1 = x(r - 1) + cw, xm = x1 + cg / 2;
      lines.push(`<path class="${names.has(won(f)) ? 'me' : ''}" d="M${x1} ${Y[r - 1].get(k)}H${xm}V${ys[r][i]}H${x(r)}"/>`);
    });
  });
  const card = (m, style) => {
    const live = m.table && !m.winner;
    const open = !m.a || !m.b;
    const sd = (nm, which) => {
      if (!nm) return `<div class="s tbd"><span>${m.winner ? esc(L.bye) : '—'}</span><b></b></div>`;
      const cls = m.winner ? (m.winner === which ? ' w' : ' l') : '';
      const g = m.games && m.games.length ? setsOf(m.games)[which === 'a' ? 0 : 1] : '';
      return `<div class="s${cls}${names.has(nm) ? ' me' : ''}"><span>${esc(nice(nm))}</span><b>${g}</b></div>`;
    };
    return `<div class="kc${live ? ' live' : ''}${open && !m.winner ? ' tbd' : ''}"${style ? ` style="${style}"` : ''}>${sd(m.a, 'a')}${sd(m.b, 'b')}${
      live ? `<i class="kl">${esc(L.liveAt(m.table))}</i>` : ''}</div>`;
  };
  const at = Math.max(0, tree.findIndex(rd => rd.matches.some(m => !m.winner)));
  const html = `<div class="kt" style="width:${Wt}px;height:${H}px">
    <svg width="${Wt}" height="${H}" aria-hidden="true">${lines.join('')}</svg>
    ${tree.map((rd, r) => `<span class="kh micro" style="left:${x(r)}px;width:${cw}px">${esc(labelL(rd.name))}</span>`).join('')}
    ${tree.map((rd, r) => rd.matches.map((m, i) => card(m, `left:${x(r)}px;top:${ys[r][i] - mh / 2}px;width:${cw}px`)).join('')).join('')}
    ${champ ? `<div class="kw" style="left:${x(R - 1)}px;top:${ys[R - 1][0] + mh / 2 + 12}px;width:${cw}px">
      <span class="micro">${esc(L.champion)}</span><b class="${names.has(champ) ? 'me' : ''}">${esc(nice(champ))}</b></div>` : ''}
  </div>`;
  return `<div class="ko${wide ? ' wide' : ''}" data-at="${at * (cw + cg)}">${html}</div>${extra.map(rd => `<div class="ko-x">
    <div class="micro">${esc(labelL(rd.name))}</div>${rd.matches.map(m => card(m, `width:${cw}px`)).join('')}</div>`).join('')}`;
}
function standingsSummary(f, ids) {
  for (const g of (f.standings || [])) {
    const r = g.rows.find(r => ids.has(r.entrant_id));
    if (r) return L.youAre(r.rank);
  }
  const top = (f.standings || [])[0];
  return top && top.rows[0] && top.rows[0].played ? L.leads(nice(top.rows[0].name)) : '';
}

function standingsSection() {
  const ids = myIds();
  const fs = (S.formats || []).filter(f => f.status !== 'setup' && inView(f.cup_id));
  const blocks = fs.map(f => ({ f, html: standingsBlock(f, ids) })).filter(x => x.html);
  if (!blocks.length) return '';
  const title = f => f.kind === 'open_play' ? L.winsTonight : (f.view && f.view.bracket ? L.knockout : L.standings);
  if (multiCup() && !selectedCup()) {
    // everyone: one fold per cup, each saying the one thing worth knowing
    return head(L.standings) + blocks.map(({ f, html }) => `<details class="fold"${blocks.length === 1 ? ' open' : ''}>
      <summary><b>${esc(cupName(f.cup_id) || f.name)}</b><span><span class="micro">${esc(standingsSummary(f, ids))}</span><i>+</i></span></summary>
      <div class="in">${html}</div></details>`).join('');
  }
  return blocks.map(({ f, html }) => head(title(f), blocks.length > 1 ? cupName(f.cup_id) || f.name : '') + `<div class="list">${html}</div>`).join('');
}

const RESULTS_SHOWN = LIST_ROWS;   // the latest five; the rest is one tap away
function resultsSection() {
  const all = (S.recent || []).filter(m => inView(m.cup_id));
  if (!all.length) return head(L.results) + `<p class="sub">${esc(L.nothingPlayed)}</p>`;
  const ids = myIds();
  const q = ui.q.trim().toLowerCase();
  const hits = q ? all.filter(m => [m.a, m.b, m.label].some(x => x && String(x).toLowerCase().includes(q))) : all;
  const shown = q || ui.all ? hits : hits.slice(0, RESULTS_SHOWN);
  const showCup = multiCup() && !selectedCup();
  const rows = shown.map(m => {
    const meta = m.meta || {};
    if (meta.bye) return `<div class="res"><span><span class="w">${esc(nice(m.a))}</span><span class="meta">${esc(labelL(m.label) || L.bye)}</span></span><span class="s"></span></div>`;
    const aW = m.winner === 'a';
    const [sa, sb] = setsOf(m.games);
    // the winner is named first, so the games read from the winner's side
    const sc = meta.walkover ? L.walkover : (m.games || []).map(g => aW ? `${g[0]}:${g[1]}` : `${g[1]}:${g[0]}`).join(' ');
    const lb = labelL(m.label);
    const where = [showCup ? cupName(m.cup_id) : '', lb.toLowerCase() === cupName(m.cup_id).toLowerCase() ? '' : lb, sc].filter(Boolean).join(' · ');
    return `<div class="res${isMine(m, ids) ? ' me' : ''}"><span><span class="w">${esc(nice(aW ? m.a : m.b))}</span> <span class="l">${esc(L.beat(nice(aW ? m.b : m.a)))}</span>
      <span class="meta">${esc(where)}</span></span><span class="s">${meta.walkover ? '' : (aW ? `${sa}:${sb}` : `${sb}:${sa}`)}</span></div>`;
  }).join('');
  const more = hits.length > shown.length ? `<button type="button" class="more" data-act="results-all">${esc(L.showAll(hits.length))}</button>`
    : ui.all && !q && all.length > RESULTS_SHOWN ? `<button type="button" class="more" data-act="results-all">${esc(L.showLess)}</button>` : '';
  // the count lives in "Show all N"; the search only once the list is open
  return head(L.results)
    + ((ui.all || q) && all.length > RESULTS_SHOWN ? `<label class="find2"><span class="micro">⌕</span><input id="res-q" type="search" placeholder="${esc(L.findP)}" value="${esc(ui.q)}" autocomplete="off"></label>` : '')
    + `<div class="list">${rows || `<p class="sub">${esc(L.noResult)}</p>`}</div>${more}`;
}

/* ------------------------------------------------------------ Mini App only */

function evening() {
  if (SHELL !== 'tg' || !V) return '';
  const ms = V.matches || [], up = V.upcoming || [];
  if (!ms.length && !up.length) return '';
  const w = ms.filter(m => m.won).length;
  const shown = ui.eveAll || ms.length <= LIST_ROWS ? ms : ms.slice(-LIST_ROWS);
  const more = ms.length > LIST_ROWS ? `<button type="button" class="more" data-act="eve-all">${esc(ui.eveAll ? L.showLess : L.showAll(ms.length))}</button>` : '';
  return head(L.evening, `${w}:${ms.length - w}`) + `<div class="list">${shown.map(m => {
    const [a, b] = setsOf(m.games);
    return `<div class="res"><span><span class="w">${esc(nice(m.opponent))}</span>
      <span class="meta">${esc([m.cup, m.label, m.walkover ? L.walkover : scoreLine(m.games)].filter(Boolean).join(' · '))}</span></span>
      <span class="s"><span class="wl${m.won ? ' won' : ''}">${esc(m.won ? L.w : L.l)}</span> ${m.walkover ? '' : `${a}:${b}`}</span></div>`;
  }).join('')}${up.length ? `<div class="res"><span><span class="w">${esc(L.stillToPlay)}</span>
      <span class="meta">${esc(up.map(u => nice(u.opponent)).join(', '))}</span></span><span></span></div>` : ''}</div>${more}`;
}

function orga() {
  if (SHELL !== 'tg' || !V) return '';
  return head(L.orga) + `<div class="card2">
    <textarea id="msg" data-ui="msg" rows="3" placeholder="${esc(L.orgaPh)}">${esc(ui.msg)}</textarea>
    <div class="acts flush"><button class="btn wide" data-act="message" ${ui.msg.trim() ? '' : 'disabled'}>${esc(L.send)}</button></div></div>`;
}

function settings() {
  if (SHELL !== 'tg' || !V) return '';
  const m = V.me;
  return `<div class="settings">
    <div class="set"><span><b>${esc(L.news)}</b><span class="muted">${esc(L.newsSub)}</span></span>
      <button class="tog${m.news ? ' on' : ''}" data-act="news" aria-pressed="${!!m.news}" aria-label="${esc(L.news)}"></button></div>
    ${m.linked ? `<div class="set"><span><b>${esc(m.name || m.first)}</b><span class="muted">${esc(L.linkedSub(m.known))}</span></span>
      <button class="link" data-act="unlink">${esc(L.unlink)}</button></div>` : ''}
    <div class="foot micro">TTT${V.bot ? ` · @${esc(V.bot)}` : ''}</div></div>`;
}

/* Before the night: what they are in, and what they could be in. */
const soonTs = () => V.event.starts_ts && V.event.starts_ts - (Date.now() / 1000 + skew) < 26 * 3600;
function signup() {
  if (SHELL !== 'tg' || !V || !(V.phase === 'announced' || V.phase === 'registration')) return '';
  const mine = V.entries || [], open = V.open || [];
  if (!mine.length && !open.length) return head(L.signup) + `<div class="card2"><p class="note">${esc(L.regClosed)}</p></div>`;
  const name = ui.name ?? V.me.name ?? '';
  const needName = !V.me.known && open.length && !mine.length;
  return head(L.signup) + `<div class="cards">${mine.map(entered).join('')}${needName ? `<div class="card2">
      <label class="micro" for="nm">${esc(L.yourName)}</label>
      <input class="in1" id="nm" data-ui="name" value="${esc(name)}" autocomplete="name" autocapitalize="words" placeholder="${esc(L.namePh)}">
      <p class="note">${esc(L.nameNote)}</p></div>` : ''}${open.map(openCup).join('')}</div>`;
}
function entered(e) {
  const detail = e.kind === 'pair' ? L.pairWith(e.partner) : e.kind === 'seeking' ? (e.partner ? L.drawn(e.partner) : L.lookingFor) : '';
  const rsvp = e.status === 'pending' && soonTs() && !e.rsvp;
  return `<div class="card2 entry">
    <div class="t"><b>${esc(e.cup)}</b><span class="tag">${esc(e.status === 'confirmed' ? L.confirmed : L.youreIn)}</span></div>
    <p class="note">${esc([detail, e.rsvp === 'yes' ? L.comes : ''].filter(Boolean).join(' · '))}</p>
    ${rsvp ? `<p class="q">${esc(L.comingQ)}</p><div class="acts flush">
      <button class="btn wide" data-act="rsvp" data-id="${esc(e.id)}" data-yes="1">${esc(L.yesSee)}</button>
      <button class="btn ghost" data-act="rsvp" data-id="${esc(e.id)}" data-yes="">${esc(L.cant)}</button></div>` : ''}
    ${e.status === 'pending' ? `<button class="link" data-act="drop" data-id="${esc(e.id)}" data-cup="${esc(e.cup)}">${esc(L.drop)}</button>` : ''}
  </div>`;
}
function openCup(c) {
  const pair = c.entry === 'pair';
  const kind = ui.kind[c.id] || (pair ? 'p' : 's');
  return `<div class="card2 entry">
    <div class="t"><b>${esc(c.name)}</b><span class="micro muted">${esc([
      // "Doppel · Doppel" says nothing: the kind only when the name doesn't
      c.name.toLowerCase().includes((pair ? L.pair : L.single).toLowerCase()) ? '' : (pair ? L.pair : L.single), c.about].filter(Boolean).join(' · '))}</span></div>
    ${c.blurb ? `<p class="note">${esc(c.blurb)}</p>` : ''}
    ${pair ? `<div class="seg"><button class="${kind === 'p' ? 'on' : ''}" data-act="kind" data-cup="${esc(c.id)}" data-k="p">${esc(L.withPartner)}</button>
      <button class="${kind === 'k' ? 'on' : ''}" data-act="kind" data-cup="${esc(c.id)}" data-k="k">${esc(L.seeking)}</button></div>` : ''}
    ${pair && kind === 'p' ? `<input class="in1" id="pt-${esc(c.id)}" data-ui="partner" data-cup="${esc(c.id)}" value="${esc(ui.partner[c.id] || '')}" placeholder="${esc(L.partnerPh)}" autocapitalize="words">` : ''}
    ${pair && kind === 'k' ? `<p class="note">${esc(L.seekNote)}</p>` : ''}
    <div class="acts flush"><button class="btn red wide" data-act="enter" data-cup="${esc(c.id)}">${esc(L.imIn)}</button></div></div>`;
}

/* ------------------------------------------------------------ the score pad */

const playingNow = () => tonight().find(x => x.state === 'playing');
function openPad() {
  const x = playingNow();
  if (!x) return;
  ui.pad = { games: Array.from({ length: x.bo || 3 }, () => ['', '']), opp: x.opponent, need: x.need || 2, bo: x.bo || 3, pts: x.pts || 11, best: x.best_of };
  renderPad();
  $('scrim').classList.add('on');
  requestAnimationFrame(() => $('pad').classList.add('on'));
  if (tg && tg.BackButton) { try { tg.BackButton.show(); tg.BackButton.onClick(closePad); } catch (e) { } }
  setTimeout(() => { const i = $('g0a'); if (i) i.focus(); }, 300);
}
function closePad() {
  ui.pad = null;
  $('pad').classList.remove('on');
  $('scrim').classList.remove('on');
  if (tg && tg.BackButton) { try { tg.BackButton.offClick(closePad); tg.BackButton.hide(); } catch (e) { } }
}
function padState() {
  const p = ui.pad, done = [];
  for (const [a, b] of p.games) { if (a === '' || b === '' || +a === +b) break; done.push([+a, +b]); }
  const [w, l] = setsOf(done);
  const decided = w >= p.need || l >= p.need;
  return { done, w, l, decided, shown: decided ? done.length : Math.min(p.bo, Math.max(p.need, done.length + 1)) };
}
function renderPad() {
  const p = ui.pad;
  if (!p) return;
  const st = padState();
  const f = document.activeElement, fid = f && f.id;
  $('pad').innerHTML = `<div class="grab"></div><h3>${esc(L.result)}</h3>
    <p class="note">${esc([(LANG === 'de' ? 'gegen ' : 'against ') + nice(p.opp), p.best].filter(Boolean).join(' · '))}</p>
    <div class="sheet" style="--g:2">
      <span></span><span class="gh">${esc(L.you)}</span><span class="gh">${esc(first(nice(p.opp)))}</span>
      ${p.games.slice(0, st.shown).map((g, i) => `<span class="nm">${esc(L.game(i + 1))}</span>
        <input id="g${i}a" data-g="${i}:0" value="${esc(g[0])}" inputmode="numeric" maxlength="2" autocomplete="off" aria-label="${esc(L.game(i + 1))}, ${esc(L.you)}">
        <input id="g${i}b" data-g="${i}:1" value="${esc(g[1])}" inputmode="numeric" maxlength="2" autocomplete="off" aria-label="${esc(L.game(i + 1))}, ${esc(nice(p.opp))}">`).join('')}
    </div>
    <p class="verdict${st.decided && st.w > st.l ? ' win' : ''}">${st.decided ? esc(st.w > st.l ? L.youWin(st.w, st.l) : L.youLose(st.w, st.l)) : '&nbsp;'}</p>
    <button class="btn red wide" data-act="pad-send" ${st.decided ? '' : 'disabled'}>${esc(L.send)}</button>
    <p class="hint">${esc(L.padNote(nice(p.opp)))}</p>`;
  if (fid) { const back = $(fid); if (back) back.focus(); }
}
function updatePad() {
  const st = padState();
  if (document.querySelectorAll('#pad input').length !== st.shown * 2) return renderPad();
  const v = document.querySelector('#pad .verdict');
  v.className = 'verdict' + (st.decided && st.w > st.l ? ' win' : '');
  v.innerHTML = st.decided ? esc(st.w > st.l ? L.youWin(st.w, st.l) : L.youLose(st.w, st.l)) : '&nbsp;';
  document.querySelector('[data-act="pad-send"]').disabled = !st.decided;
}

/* ------------------------------------------------------------ the name picker (web) */

function pickerRows(q) {
  const qq = q.trim().toLowerCase();
  const ents = S.entrants || [];
  const rows = (S.players || []).map(p => {
    const es = ents.filter(e => e.player_ids.includes(p.id));
    if (!es.length) return null;
    const xs = es.map(e => stateOf(e, p.name)).sort(byUrgency);
    const pair = es.find(e => e.player_ids.length === 2);
    const mate = pair ? (S.players.find(z => z.id === pair.player_ids.find(i => i !== p.id)) || {}).name : '';
    return { p, xs, mate, cups: multiCup() ? es.map(e => cupName(e.cup_id)).filter(Boolean).join(' · ') : '' };
  }).filter(Boolean).filter(r => !qq || r.p.name.toLowerCase().includes(qq) || (r.mate || '').toLowerCase().includes(qq));
  if (!rows.length) return `<p class="note">${esc(L.noName)}</p>`;
  return rows.map(r => {
    const x = r.xs[0];
    const live = x.state === 'playing' || x.on_deck;
    return `<button class="nm-row" type="button" data-act="pick" data-p="${esc(r.p.id)}">
      <b>${esc(r.p.name)}<small>${esc([r.mate ? L.pairWith(first(r.mate)) : '', r.cups].filter(Boolean).join(' · '))}</small></b>
      ${shortState(x).replace('<span', `<span class="s micro${live ? ' red' : ''}"`).replace(' class="red"', '')}</button>`;
  }).join('');
}
function openPicker() {
  $('find').value = '';
  $('find').placeholder = L.find;
  $('pick-h').textContent = L.whoH;
  $('pick-p').textContent = L.whoP;
  $('names').innerHTML = pickerRows('');
  $('scrim').classList.add('on');
  $('picker').classList.add('on');
}
function closePicker() { $('scrim').classList.remove('on'); $('picker').classList.remove('on'); }

/* Choosing a name is a focus pull: the room goes soft, the hero comes in. */
function pick(pid, row) {
  if (row) row.classList.add('picked');
  setTimeout(() => {
    closePicker();
    const room = $('room');
    room.classList.add('out');
    setTimeout(() => {
      me = { event: (S.event || {}).id || '', player: pid };
      store.set(ME_KEY, me);
      ui.seen = null; ui.cup = null;
      render(true);
      scrollTo({ top: 0 });
      requestAnimationFrame(() => requestAnimationFrame(() => room.classList.remove('out')));
    }, reduced() ? 0 : 450);
  }, 220);
}
function forget() {
  const room = $('room');
  const o = $('obj');
  o.style.setProperty('--b', '60px');
  room.classList.add('out');
  $('hero').classList.add('out');
  setTimeout(() => {
    me = null; store.del(ME_KEY); ui.seen = null; ui.moment = null; ui.cup = null;
    $('hero').classList.remove('out');
    render();
    requestAnimationFrame(() => requestAnimationFrame(() => room.classList.remove('out')));
    setTimeout(openPicker, 250);
  }, reduced() ? 0 : 450);
}

/* ------------------------------------------------------------ render */

function bar() {
  // the mark alone: the evening's name stays out of sight, read out with the mark
  const ev = SHELL === 'tg' && V ? V.event.name : (S && S.event && S.event.name) || '';
  return `<span class="tt" role="img" aria-label="${esc(ev ? 'TTT · ' + ev : 'TTT')}">TTT</span>`;
}

function render(entering) {
  if (!S && !V) return;
  noticeResults();
  $('bar').innerHTML = bar();
  $('asks').innerHTML = claims();
  const H = known() ? heroData() : null;
  paintHero(H, entering);
  $('under').innerHTML = also(H) + actions(H);
  const pill = $('pill');
  pill.hidden = SHELL !== 'web' || known();
  if (!pill.hidden) pill.innerHTML = `<b>${esc(L.pillQ)}</b><span>${esc(L.pillA)}</span>`;
  $('mine').innerHTML = signup() + evening();
  renderRoom();
  $('tail').innerHTML = orga() + settings();
  if (ui.pad && !playingNow()) closePad();          // the referee got there first
  const dot = $('dot');
  if (dot) { dot.classList.add('on'); setTimeout(() => dot.classList.remove('on'), 500); }
}

function renderRoom() {
  const room = $('room');
  const before = SHELL === 'tg' && V && (V.phase === 'announced' || V.phase === 'registration');
  if (!S || before) { room.innerHTML = ''; return; }
  const had = document.activeElement && document.activeElement.id === 'res-q';
  const caret = had ? document.activeElement.selectionStart : 0;
  const openFolds = new Set([...room.querySelectorAll('details.fold[open] summary b')].map(b => b.textContent));
  room.innerHTML = strip() + tablesSection() + upNextSection() + standingsSection() + resultsSection();
  room.querySelectorAll('details.fold summary b').forEach(b => { if (openFolds.has(b.textContent)) b.closest('details').open = true; });
  // a bracket wider than the phone opens at the round being played
  room.querySelectorAll('.ko.wide').forEach(k => { k.scrollLeft = +k.dataset.at || 0; });
  if (had) { const back = $('res-q'); if (back) { back.focus(); try { back.setSelectionRange(caret, caret); } catch (e) { } } }
}

function outside() {
  $('hero').hidden = true;
  $('room').innerHTML = `<div class="empty"><h1>${esc(L.outsideH)}</h1><p>${esc(L.outsideP)}</p></div>`;
}

/* ------------------------------------------------------------ small things */

function buzz(kind) {
  try {
    if (tg && tg.HapticFeedback) {
      const h = tg.HapticFeedback;
      if (kind === 'ok' || kind === 'bad') h.notificationOccurred(kind === 'ok' ? 'success' : 'error');
      else if (kind === 'call') h.notificationOccurred('warning');
      else h.impactOccurred(kind || 'light');
    } else if (kind === 'call' && navigator.vibrate) navigator.vibrate([30, 60, 30]);
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
function toast(msg, bad) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast on' + (bad ? ' bad' : '');
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.className = 'toast' + (bad ? ' bad' : ''); }, 3200);
}

/* ------------------------------------------------------------ events */

document.addEventListener('input', e => {
  const k = e.target.dataset.ui;
  if (e.target.id === 'res-q') { ui.q = e.target.value; return renderRoom(); }
  if (e.target.id === 'find') { $('names').innerHTML = pickerRows(e.target.value); return; }
  if (k === 'name') ui.name = e.target.value;
  else if (k === 'partner') ui.partner[e.target.dataset.cup] = e.target.value;
  else if (k === 'msg') {
    ui.msg = e.target.value;
    const b = document.querySelector('[data-act="message"]');
    if (b) b.disabled = !ui.msg.trim();
  }
  const g = e.target.dataset.g;
  if (g && ui.pad) {
    const [i, sd] = g.split(':').map(Number);
    const v = e.target.value.replace(/[^0-9]/g, '').slice(0, 2);
    e.target.value = v;
    ui.pad.games[i][sd] = v;
    updatePad();
    // a digit that cannot begin a two-digit score moves on at once (anything
    // but 1 when games go to 11); 1 waits for its second digit — as the console
    const pts = ui.pad.pts || 11;
    const done = /^insert/.test(e.inputType || 'insert') && (v.length === 2 || (v.length === 1 && +v * 10 > pts + 8));
    if (done) { const el = $(sd === 0 ? `g${i}b` : `g${i + 1}a`); if (el) { el.focus(); try { el.select(); } catch (x) { } } }
  }
});

document.addEventListener('click', async e => {
  const b = e.target.closest('[data-act]');
  if (!b) {
    if (e.target.id === 'scrim') { closePicker(); closePad(); }
    return;
  }
  const a = b.dataset.act, d = b.dataset;
  if (a === 'cup') { buzz('light'); setCup(d.cup); return; }
  if (a === 'results-all') { ui.all = !ui.all; return renderRoom(); }
  if (a === 'up-all') { ui.upAll = !ui.upAll; return renderRoom(); }
  if (a === 'st-all') { ui.stAll[d.k] = !ui.stAll[d.k]; return renderRoom(); }
  if (a === 'eve-all') { ui.eveAll = !ui.eveAll; return render(); }
  if (a === 'me') return openPicker();
  if (a === 'pick') return pick(d.p, b);
  if (a === 'not-me') return forget();
  if (SHELL !== 'tg') return;
  if (a === 'kind') { ui.kind[d.cup] = d.k; buzz('light'); return render(); }
  if (a === 'enter') {
    const c = (V.open || []).find(x => x.id === d.cup);
    const kind = ui.kind[d.cup] || (c && c.entry === 'pair' ? 'p' : 's');
    const name = (ui.name ?? V.me.name ?? '').trim();
    if (!V.me.known && !name) { toast(L.needName, true); const n = $('nm'); if (n) n.focus(); return; }
    return void act('enter', { cup_id: d.cup, kind, name, partner: ui.partner[d.cup] || '' });
  }
  if (a === 'drop') { if (!(await ask(L.dropQ(d.cup)))) return; return void act('drop', { id: d.id }); }
  if (a === 'rsvp') return void act('rsvp', { id: d.id, yes: !!d.yes });
  if (a === 'rest') return void act('rest', { eid: d.eid, on: !!d.on });
  if (a === 'leave') { if (d.on && !(await ask(L.leaveQ))) return; return void act('leave', { eid: d.eid, on: !!d.on }); }
  if (a === 'confirm') return void act('confirm', { id: +d.id, yes: !!d.yes });
  if (a === 'pad') { buzz('light'); return openPad(); }
  if (a === 'pad-send') { const st = padState(); if (!st.decided) return; return void act('score', { games: st.done }, closePad); }
  if (a === 'message') { const text = ui.msg.trim(); if (!text) return; return void act('message', { text }, () => { ui.msg = ''; }); }
  if (a === 'news') return void act('news', { on: !V.me.news });
  if (a === 'unlink') { if (!(await ask(L.unlinkQ))) return; return void act('unlink', {}); }
});

/* ------------------------------------------------------------ start */

function start() {
  if (SHELL === 'tg' && tg) {
    try { tg.ready(); tg.expand(); } catch (e) { }
    try { if (tg.disableVerticalSwipes) tg.disableVerticalSwipes(); } catch (e) { }
    // the page is bone in every theme: tell Telegram so its bars match
    try { tg.setHeaderColor('#EDE6DB'); tg.setBackgroundColor('#EDE6DB'); if (tg.setBottomBarColor) tg.setBottomBarColor('#EDE6DB'); } catch (e) { }
  }
  if (SHELL === 'web') me = store.get(ME_KEY);
  load().then(() => {
    // a name from another evening is not this evening's
    if (SHELL === 'web' && me && S && S.event && me.event && me.event !== (S.event.id || '')) { me = null; store.del(ME_KEY); render(); }
  });
  IO.listen(load);
  setInterval(load, 30000);
  setInterval(() => {                       // the countdown, without fighting anyone typing
    const f = document.activeElement;
    if ((S || V) && !(f && /INPUT|TEXTAREA/.test(f.tagName))) render();
  }, 60000);
  let rw = innerWidth;
  addEventListener('resize', () => {          // a rotation moves the table; it does not replay the number
    if (innerWidth === rw) return;
    rw = innerWidth;
    render();
    const n = $('num'); n.style.removeProperty('font-size'); fit(n, $('hero').clientWidth);
  });
  $('pill').addEventListener('click', openPicker);
}

/* for the mockup's controls and for tests */
window.TTTM = {
  load, render, stateOf, slots, tablesLabel, labelL, nice, byUrgency,
  derive(s2, fn) { const keep = S; S = s2; try { return fn(); } finally { S = keep; } },
  setLang(l) { LANG = l; L = STR[l]; lastKey = null; render(); },
  setShell(sh) { SHELL = sh; document.documentElement.dataset.shell = sh; V = null; ui.seen = null; ui.moment = null; ui.cup = null; lastKey = null; closePad(); closePicker(); },
  pick(pid) { me = pid ? { event: (S && S.event && S.event.id) || '', player: pid } : null; if (me) store.set(ME_KEY, me); else store.del(ME_KEY); ui.seen = null; ui.moment = null; ui.cup = null; lastKey = null; },
  get lang() { return LANG; },
};

start();
})();
