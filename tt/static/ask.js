/* The questions only the organiser can answer (docs/player-identity.md).

   An op that needs one writes nothing and comes back with `ask`; the page
   puts it here and sends the same op again with the answer. One copy for
   the desk and the console, so both ask the same thing the same way.

   answerAsk(op, data, reply) resolves to the data to send again, or null
   if the organiser backed out. */

(function () {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const list = xs => xs.filter(Boolean).join(' and ');

  function sheet(title, body, buttons, input) {
    return new Promise(resolve => {
      const el = document.createElement('div');
      el.className = 'askback';
      el.innerHTML = `<div class="askbox" role="dialog" aria-modal="true" aria-labelledby="ask-t">
          <h2 id="ask-t">${esc(title)}</h2>
          ${body ? `<p>${esc(body)}</p>` : ''}
          ${input != null ? `<input id="ask-in" value="${esc(input)}" aria-label="Name">` : ''}
          <div class="askrow">${buttons.map((b, i) =>
            `<button data-i="${i}" class="${b.primary ? 'go' : ''}">${esc(b.label)}</button>`).join('')}</div>
        </div>`;
      const done = v => { el.remove(); document.removeEventListener('keydown', key); resolve(v); };
      const key = e => { if (e.key === 'Escape') done(null); };
      el.addEventListener('click', e => {
        if (e.target === el) return done(null);
        const b = e.target.closest('button[data-i]');
        if (!b) return;
        const pick = buttons[+b.dataset.i];
        const inp = el.querySelector('#ask-in');
        done(pick.value == null ? null : { value: pick.value, text: inp ? inp.value.trim() : '' });
      });
      document.addEventListener('keydown', key);
      document.body.appendChild(el);
      const first = el.querySelector('#ask-in') || el.querySelector('button.go');
      if (first) { first.focus(); if (first.select) first.select(); }
    });
  }

  // which field of the op carries the name in that slot
  function withName(op, data, slot, name) {
    const d = { ...data };
    if (op === 'add_team') {
      d.members = (d.members || []).map((m, i) => i === (slot === 'b' ? 1 : 0) ? [name, m[1]] : m);
    } else if (slot === 'b') d.partner_name = name;
    else d.name = name;
    return d;
  }

  async function answerAsk(op, data, reply) {
    if (reply.ask === 'same_person') {
      const where = list(reply.cups || []);
      const a = await sheet(`${reply.name} is already playing${where ? ' in ' + where : ''}. Same person?`,
        'If it is somebody else with the same name, they need a name that tells them apart.',
        [{ label: `Yes, same ${reply.name}`, value: 'same', primary: true },
         { label: 'No, someone else', value: 'other' },
         { label: 'Cancel', value: null }]);
      if (!a) return null;
      if (a.value === 'same') {
        const same = (data.same_as && typeof data.same_as === 'object') ? data.same_as : {};
        return { ...data, same_as: { ...same, [reply.slot]: reply.player_id } };
      }
      const n = await sheet('A name that tells them apart',
        `So the wall, the scoresheet and the tables never mix up the two of them.`,
        [{ label: 'Use this name', value: 'name', primary: true }, { label: 'Cancel', value: null }],
        `${reply.name} (2)`);
      if (!n || !n.text) return null;
      return withName(op, data, reply.slot, n.text);
    }
    if (reply.ask === 'rename_scope') {
      const where = list(reply.cups || []);
      const a = await sheet(`Rename ${reply.name} to ${reply.new_name}?`,
        `${reply.name} plays in ${where}. Fixing a typo renames them everywhere; somebody else stepping in changes only this entry.`,
        [{ label: 'Fix the name everywhere', value: 'everywhere', primary: true },
         { label: 'Someone else, here only', value: 'here' },
         { label: 'Cancel', value: null }]);
      return a ? { ...data, scope: a.value } : null;
    }
    return null;
  }

  // the look, once, with the page's own colours
  const css = document.createElement('style');
  css.textContent = `
    .askback{position:fixed;inset:0;z-index:90;background:rgba(27,27,27,.32);display:flex;
      justify-content:center;align-items:flex-start;padding:12vh 16px 16px}
    .askbox{background:var(--bone,#EDE6DB);color:var(--ink,#1B1B1B);border-radius:18px;max-width:440px;
      width:100%;padding:20px;box-shadow:0 30px 60px -20px rgba(0,0,0,.35);display:flex;flex-direction:column;gap:12px}
    .askbox h2{margin:0;font-family:var(--syne,inherit);font-size:21px;line-height:1.2;letter-spacing:-.02em}
    .askbox p{margin:0;color:var(--ink-2,#5B5750);font-size:14px;line-height:1.4}
    .askbox input{font:inherit;font-size:16px;padding:10px 12px;border-radius:10px;
      border:1px solid var(--rule,rgba(27,27,27,.14));background:var(--field,#FBF8F3);color:inherit}
    .askrow{display:flex;flex-wrap:wrap;gap:8px}
    .askrow button{font:inherit;font-size:14px;padding:9px 14px;border-radius:999px;cursor:pointer;
      border:1px solid var(--rule,rgba(27,27,27,.14));background:transparent;color:inherit}
    .askrow button.go{background:var(--ink,#1B1B1B);color:var(--bone,#EDE6DB);border-color:transparent}`;
  document.head.appendChild(css);

  window.answerAsk = answerAsk;
})();
