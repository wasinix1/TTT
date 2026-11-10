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
      const key = e => {
        if (e.key === 'Escape') done(null);
        // Enter takes the highlighted answer, so a typed surname needs no mouse
        if (e.key === 'Enter') { const go = el.querySelector('button.go'); if (go) { e.preventDefault(); go.click(); } }
      };
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
      if (first) {
        first.focus();
        // a name to finish ("Max ") keeps the cursor at its end
        if (first.select && !/\s$/.test(first.value)) first.select();
        else if (first.setSelectionRange) first.setSelectionRange(first.value.length, first.value.length);
      }
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
    if (reply.ask === 'surname') {
      // a first name somebody here already has: the surname says who it is
      const where = list(reply.cups || []);
      const n = await sheet(`Which ${reply.name}?`,
        `A ${reply.name} is already playing${where ? ' in ' + where : ''}. Their surname tells the two apart; only the desk sees it.`,
        [{ label: 'Continue', value: 'name', primary: true }, { label: 'Cancel', value: null }],
        `${reply.name} `);
      if (!n || !n.text || n.text.split(/\s+/).length < 2) return null;
      return withName(op, data, reply.slot, n.text);
    }
    if (reply.ask === 'same_person') {
      const where = list(reply.cups || []);
      const asked = reply.new_name && reply.new_name !== reply.name ? reply.new_name : reply.name;
      const a = await sheet(`Is ${asked} the ${reply.name} already playing${where ? ' in ' + where : ''}?`,
        reply.new_name && reply.new_name !== reply.name
          ? 'The names are close enough to be one name typed twice.'
          : 'One of them has no surname here, so the name can’t tell.',
        [{ label: `Yes, same person`, value: 'same', primary: true },
         { label: 'No, someone else', value: 'other' },
         { label: 'Cancel', value: null }]);
      if (!a) return null;
      const key = a.value === 'same' ? 'same_as' : 'other';
      const was = (data[key] && typeof data[key] === 'object') ? data[key] : {};
      return { ...data, [key]: { ...was, [reply.slot]: a.value === 'same' ? reply.player_id : true } };
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
