// ANSI → HTML, for the paged feeds. Keeps SGR (colors, bold, dim, italic,
// underline); drops cursor movement and the rest, because a paged view has no
// cursor to move. A carriage return inside a line keeps what came after it —
// which is what progress bars mean by it.
(function () {
  const BASE = ['#3b4252', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#c8ccd4'];
  const BRIGHT = ['#5c6370', '#f07178', '#b5e890', '#f2d38a', '#82c0ff', '#d9a0ee', '#7fd6e0', '#ffffff'];
  function c256(n) {
    n = Number(n);
    if (n < 8) return BASE[n];
    if (n < 16) return BRIGHT[n - 8];
    if (n < 232) { n -= 16; const r = Math.floor(n / 36), g = Math.floor((n % 36) / 6), b = n % 6; const v = (x) => (x ? 55 + x * 40 : 0); return `rgb(${v(r)},${v(g)},${v(b)})`; }
    const g = 8 + (n - 232) * 10; return `rgb(${g},${g},${g})`;
  }
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  function freshState() { return { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false }; }

  function applySGR(st, params) {
    const p = params.length ? params : [0];
    for (let i = 0; i < p.length; i++) {
      const n = Number(p[i]);
      if (n === 0) Object.assign(st, freshState());
      else if (n === 1) st.bold = true;
      else if (n === 2) st.dim = true;
      else if (n === 3) st.italic = true;
      else if (n === 4) st.underline = true;
      else if (n === 7) st.inverse = true;
      else if (n === 22) { st.bold = false; st.dim = false; }
      else if (n === 23) st.italic = false;
      else if (n === 24) st.underline = false;
      else if (n === 27) st.inverse = false;
      else if (n >= 30 && n <= 37) st.fg = BASE[n - 30];
      else if (n >= 90 && n <= 97) st.fg = BRIGHT[n - 90];
      else if (n === 39) st.fg = null;
      else if (n >= 40 && n <= 47) st.bg = BASE[n - 40];
      else if (n >= 100 && n <= 107) st.bg = BRIGHT[n - 100];
      else if (n === 49) st.bg = null;
      else if (n === 38 || n === 48) {
        let col = null;
        if (p[i + 1] == 5) { col = c256(p[i + 2]); i += 2; }
        else if (p[i + 1] == 2) { col = `rgb(${p[i + 2]},${p[i + 3]},${p[i + 4]})`; i += 4; }
        if (n === 38) st.fg = col; else st.bg = col;
      }
    }
  }

  function open(st) {
    const s = [];
    let fg = st.fg, bg = st.bg;
    if (st.inverse) { const t = fg || 'var(--feed-fg)'; fg = bg || 'var(--feed-bg)'; bg = t; }
    if (fg) s.push(`color:${fg}`);
    if (bg) s.push(`background:${bg}`);
    if (st.bold) s.push('font-weight:700');
    if (st.dim) s.push('opacity:.55');
    if (st.italic) s.push('font-style:italic');
    if (st.underline) s.push('text-decoration:underline');
    return s.length ? `<span style="${s.join(';')}">` : '';
  }

  // One line → html, carrying the SGR state in and out.
  function renderLine(line, st) {
    if (line.includes('\r')) {
      // Keep the last thing written after a bare CR, unless it is empty.
      const parts = line.split('\r');
      let keep = parts[parts.length - 1];
      if (!keep.trim()) keep = parts.filter((x) => x.trim()).pop() || '';
      line = keep;
    }
    let out = '', i = 0, openTag = open(st);
    out += openTag;
    const re = /\x1b\[([0-9;?]*)([A-Za-z@])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>]/g;
    let m;
    while ((m = re.exec(line))) {
      out += esc(line.slice(i, m.index));
      i = m.index + m[0].length;
      if (m[2] === 'm') {
        if (openTag) out += '</span>';
        applySGR(st, m[1] === '' ? [] : m[1].split(';'));
        openTag = open(st);
        out += openTag;
      }
      // Everything else — cursor moves, erases, OSC — is dropped.
    }
    out += esc(line.slice(i));
    if (openTag) out += '</span>';
    // Anything left: stray control characters.
    return out.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  }

  window.ANSI = { renderLine, freshState };
})();
