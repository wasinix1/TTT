/* Paint — the tables' paint, carried to what you press and to the ink rules.

   One rule, two materials. Anything solid in ink or red is paint: the
   tables, the filled buttons (Check in, Save, Seat now, the chosen cup), the
   ink outlines (the role tag, "Playing tonight?") and the heavy ink rules
   under a section head. Anything grey or thin is print: the hairlines between
   rows, the grey outlines, the text. Paint marks what you act on and where a
   section starts; print is the information.

   It is done here, once, for the console, the desk and the phone page,
   rather than in each stylesheet: what is "filled" depends on state (a Save
   turns ink when a score is in), so the page is looked over after every
   render and each element is marked by what it actually shows:

     .tp    a filled button: its fill is drawn by ::before through the paint
            filter; its own background is clipped to the text, so a hover or
            state colour still comes through (the ::before inherits it)
     .tp-o  an ink outline: the border is drawn by ::before, frayed
     .tp-lt / .tp-lb   an ink rule on top / bottom, drawn as a painted stroke

   Left alone, on purpose: the walk-in switch on the desk and the segmented
   switches on the phone (a crisp frame around a choice), anything inside a
   table (it has its own paint), and anything already using ::before.
   Without this script everything still draws, crisp. */
(function () {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const FILTERS = `<svg xmlns="${NS}" width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">
  <filter id="tp-fill" x="-6%" y="-16%" width="112%" height="132%">
    <feTurbulence type="fractalNoise" baseFrequency=".02 .09" numOctaves="3" seed="11" result="n"/>
    <feColorMatrix in="n" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -1.2 1.08" result="shade"/>
    <feComposite in="SourceGraphic" in2="shade" operator="arithmetic" k1="0" k2="1" k3="-.12" k4="0" result="streak"/>
    <feTurbulence type="fractalNoise" baseFrequency=".08" numOctaves="2" seed="4" result="edge"/>
    <feDisplacementMap in="streak" in2="edge" scale="2"/>
  </filter>
  <filter id="tp-edge" x="-4%" y="-12%" width="108%" height="124%">
    <feTurbulence type="fractalNoise" baseFrequency=".07" numOctaves="2" seed="6" result="edge"/>
    <feDisplacementMap in="SourceGraphic" in2="edge" scale="1.8"/>
  </filter>
</svg>`;
  // a painted stroke, stretched along a rule: dry at the edges, a few gaps
  const STROKE = `<svg xmlns='${NS}' viewBox='0 0 1200 8' preserveAspectRatio='none'>
<filter id='s' x='0' y='-1' width='1' height='3'>
<feTurbulence type='fractalNoise' baseFrequency='.012 .5' numOctaves='2' seed='7' result='g'/>
<feDisplacementMap in='SourceGraphic' in2='g' scale='3' result='d'/>
<feTurbulence type='fractalNoise' baseFrequency='.02 .9' numOctaves='2' seed='3' result='t'/>
<feColorMatrix in='t' type='matrix' values='0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -1.3 1.3' result='a'/>
<feComposite in='d' in2='a' operator='in'/></filter>
<rect x='0' y='2.6' width='1200' height='2.8' fill='%231B1B1B' filter='url(%23s)'/></svg>`;
  const STROKE_URL = 'url("data:image/svg+xml,' + STROKE.replace(/\n/g, '').replace(/"/g, "'").replace(/</g, '%3C').replace(/>/g, '%3E') + '")';

  const CSS = `
:root{--tp-line:${STROKE_URL}}
.tp{isolation:isolate;-webkit-background-clip:text!important;background-clip:text!important;box-shadow:none!important}
:where(.tp){position:relative}
.tp::before{content:"";position:absolute;inset:0;border-radius:inherit;background-color:inherit;filter:url(#tp-fill);z-index:-1;pointer-events:none}
.tp-o{isolation:isolate;border-color:transparent!important;box-shadow:none!important}
:where(.tp-o){position:relative}
.tp-o::before{content:"";position:absolute;inset:calc(-1 * var(--tp-bw,0px));border-radius:inherit;border:var(--tp-ow,1.5px) solid var(--tp-oc,currentColor);filter:url(#tp-edge);pointer-events:none}
.tp-lt,.tp-lb{background-repeat:no-repeat;background-origin:border-box}
.tp-lt{border-top-color:transparent!important;background-image:var(--tp-line);background-position:left top;background-size:100% var(--tp-lht,4px)}
.tp-lb{border-bottom-color:transparent!important;background-image:var(--tp-line);background-position:left bottom;background-size:100% var(--tp-lhb,4px)}
.tp-lt.tp-lb{background-image:var(--tp-line),var(--tp-line);background-position:left top,left bottom;background-size:100% var(--tp-lht,4px),100% var(--tp-lhb,4px)}
@media (forced-colors:active){.tp::before,.tp-o::before{display:none}.tp,.tp-o,.tp-lt,.tp-lb{background-clip:border-box;border-color:CanvasText!important;background-image:none}}
`;

  // what may be painted, and what never is
  const PRESS = 'button, .btn, .role-tag, .role';
  const SKIP = '.segc, .seg, .ptable, .tb, .mt, .tile .pn, .kc, .km, [data-flat]';
  // the ink rules: the heads and the first rows of the lists, wherever they
  // are on the console, the desk and the phone page
  const RULES = [
    '.panel-head', '.cupcol .bh', '.st.head', '.hrow', '.find-res', 'table.grid th',
    '.list .r', '.panel-body > .row.result', '.sec', '.form > .sblock', '.doorbox',
    '.ref .cols', '.ref .bycup', '#sheet .tabs button',
    '.find', '.lhead', '.blk2 > .r2', '.blk2 > .rb', '.empty2', '.log', '.dir .rows', '.dir input[type=search]',
    '.r', '.res', '.picker input', '.in1', '.h',
  ].join(',');

  const rgba = c => { const m = c && c.match(/[\d.]+/g); return m ? m.map(Number) : null; };
  const kind = c => {             // 'ink' | 'red' | '' for a computed colour
    const v = rgba(c); if (!v) return '';
    const [r, g, b, a = 1] = v;
    if (a < .6) return '';
    if (r < 70 && g < 70 && b < 70) return 'ink';
    if (r > 150 && g < 90 && b < 90) return 'red';
    return '';
  };
  const set = (el, cls, on) => { if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on); };
  const prop = (el, k, v) => { if (v == null) { if (el.style.getPropertyValue(k)) el.style.removeProperty(k); } else if (el.style.getPropertyValue(k) !== v) el.style.setProperty(k, v); };

  function press(el) {
    if (el.closest(SKIP)) { set(el, 'tp', false); set(el, 'tp-o', false); return; }
    const r = el.getBoundingClientRect();
    if (!r.width || r.width < 28 || r.height < 18 || r.height > 96) return;   // hidden, a glyph, or a panel
    const mine = el.classList.contains('tp') || el.classList.contains('tp-o');
    // an outline we drew has its own border hidden: look at it bare again
    if (el.classList.contains('tp-o')) el.classList.remove('tp-o');
    const cs = getComputedStyle(el);
    if (!mine && getComputedStyle(el, '::before').content !== 'none') return;  // its ::before is spoken for
    const fill = kind(cs.backgroundColor);
    set(el, 'tp', !!fill);
    // an ink (or red) outline on an unfilled element: a border or an inset ring
    let ow = 0, oc = null;
    if (!fill) {
      const bw = parseFloat(cs.borderTopWidth);
      const all = ['Top', 'Right', 'Bottom', 'Left'].every(k => parseFloat(cs['border' + k + 'Width']) >= 1 && cs['border' + k + 'Style'] !== 'none' && kind(cs['border' + k + 'Color']));
      if (all) { ow = bw; oc = cs.borderTopColor; }   // a frame all round, not a rule on one side
      else {
        const m = cs.boxShadow.match(/(rgba?\([^)]*\))\s+0px\s+0px\s+0px\s+([\d.]+)px\s+inset|inset\s+0px\s+0px\s+0px\s+([\d.]+)px\s+(rgba?\([^)]*\))/);
        if (m) { const col = m[1] || m[4], w = parseFloat(m[2] || m[3]); if (kind(col)) { ow = w; oc = col; } }
      }
    }
    set(el, 'tp-o', !!ow);
    prop(el, '--tp-ow', ow ? ow + 'px' : null);
    prop(el, '--tp-oc', ow ? oc : null);
    prop(el, '--tp-bw', ow ? (parseFloat(cs.borderTopWidth) || 0) + 'px' : null);
  }

  function rule(el) {
    if (el.closest(SKIP) || el.classList.contains('tp') || el.classList.contains('tp-o')) return;
    const cs = getComputedStyle(el);
    for (const [side, cls, v] of [['Top', 'tp-lt', '--tp-lht'], ['Bottom', 'tp-lb', '--tp-lhb']]) {
      const on = el.classList.contains(cls);
      // read the border as the stylesheet has it, not as we left it
      const w = parseFloat(cs['border' + side + 'Width']);
      const ink = on ? el.dataset['tp' + side] === '1' : (w >= 1 && cs['border' + side + 'Style'] === 'solid' && kind(cs['border' + side + 'Color']) === 'ink');
      if (on && !ink) { set(el, cls, false); continue; }
      if (!on && ink) {
        el.dataset['tp' + side] = '1';
        set(el, cls, true);
        prop(el, v, Math.max(3.5, w * 2.4).toFixed(1) + 'px');
      }
      if (!on && !ink) delete el.dataset['tp' + side];
    }
  }

  let queued = false;
  function scan() {
    queued = false;
    for (const el of document.querySelectorAll(PRESS)) press(el);
    for (const el of document.querySelectorAll(RULES)) rule(el);
  }
  const soon = () => { if (!queued) { queued = true; requestAnimationFrame(scan); } };

  function start() {
    if (!document.getElementById('tp-fill')) document.body.insertAdjacentHTML('afterbegin', FILTERS);
    const st = document.createElement('style');
    st.id = 'tp-style';
    st.textContent = CSS;
    document.head.appendChild(st);
    scan();
    const bare = c => (c || '').replace(/\btp(-o|-lt|-lb)?\b/g, '').trim().replace(/\s+/g, ' ');
    new MutationObserver(muts => {
      for (const m of muts) {
        // our own marks do not call for another look
        if (m.attributeName === 'class' && bare(m.oldValue) === bare(m.target.getAttribute('class'))) continue;
        soon(); return;
      }
    }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['class', 'hidden', 'disabled', 'open'] });
    addEventListener('resize', soon);
    document.addEventListener('toggle', soon, true);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
