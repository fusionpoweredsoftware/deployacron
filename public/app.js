/* The deployer's browser side.
   Hash routes: #deploy, #run/<id>, #runs, #troubleshoot, #settings.
   Feeds are paged, never scrolled: as many lines as the box holds per page,
   and Live pins the view to the last page as output arrives. Every request is
   about the active project, which the top bar switches. */

const LINE_PX = 12.5 * 1.5;
const pageLines = (screen) => Math.max(3, Math.floor((screen.clientHeight - 20) / LINE_PX));
const $ = (s, el = document) => el.querySelector(s);
const view = $('#view');
const state = { app: null, project: null, problems: [], files: [], current: null, runs: new Map(), ws: null, terms: new Map(), target: localStorage.getItem('target') || '' };

// ── plumbing ───────────────────────────────────────────────────────────────
async function api(path, opts = {}) {
  // Everything about a project is about one of its targets; the header picks it.
  if (state.target && /^\/api\/(project|troubleshoot)/.test(path)) path += `${path.includes('?') ? '&' : '?'}target=${encodeURIComponent(state.target)}`;
  const r = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const ct = r.headers.get('content-type') || '';
  const body = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw Object.assign(new Error(body?.error || r.statusText), { body });
  return body;
}
let toastT;
function toast(msg, err) {
  let t = $('.toast'); if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.toggle('err', !!err); t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 3200);
}
const fmtT = (iso) => iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
const dur = (a, b) => { if (!a) return ''; const s = Math.max(0, ((b ? new Date(b) : Date.now()) - new Date(a)) / 1000); return s < 60 ? `${s.toFixed(s < 10 ? 1 : 0)}s` : `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`; };
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const P = () => state.app.activeProject;
const utf8 = (s) => Array.from(new TextEncoder().encode(s), (b) => String.fromCharCode(b)).join('');
const multi = () => (state.project?.targets?.length || 0) > 1;
const targetText = () => { const s = state.project?.local?.server; const who = s?.host ? `${s.user}@${s.host}` : 'the server'; return multi() ? `${state.project.target}: ${who}` : who; };

async function loadProject() {
  const r = await api('/api/project');
  state.project = r.project; state.problems = r.problems; state.files = r.files; state.sourceDir = r.sourceDir; state.remoteDir = r.remoteDir; state.current = r.running;
  state.target = r.target; try { localStorage.setItem('target', r.target); } catch {}
  $('#target').textContent = targetText();
  drawProjects();
  drawTargets();
}
/** The target picker: only there when the project has more than one. */
function drawTargets() {
  const sel = $('#target-sel');
  sel.hidden = !multi();
  sel.innerHTML = (state.project?.targets || []).map((t) => `<option value="${esc(t)}" ${t === state.target ? 'selected' : ''}>${esc(t)}</option>`).join('');
}
async function switchTarget(t) { state.target = t; await loadProject(); render(); }
function drawProjects() {
  const sel = $('#project');
  sel.innerHTML = state.app.projects.map((p) => `<option value="${esc(p.name)}" ${p.name === P() ? 'selected' : ''}>${esc(p.title || p.name)}</option>`).join('');
}
async function switchProject(name) {
  state.target = '';
  state.app = await api('/api/app', { method: 'PUT', body: { activeProject: name } });
  state.app.projects = (await api('/api/app')).projects;
  state.runs.clear();
  await loadProject();
  render();
}

// ── a run's lines, kept per pane ───────────────────────────────────────────
function runStore(id) {
  if (!state.runs.has(id)) state.runs.set(id, { id, meta: null, lines: { local: [], remote: [] }, partial: { local: '', remote: '' }, loaded: false, listeners: new Set() });
  return state.runs.get(id);
}
function ingest(store, ev) {
  const pane = ev.pane === 'local' ? 'local' : 'remote';
  const buf = store.partial[pane] + ev.data.replace(/\r\n/g, '\n');
  const parts = buf.split('\n');
  store.partial[pane] = parts.pop();
  for (const p of parts) store.lines[pane].push({ step: ev.step, raw: p });
  for (const fn of store.listeners) fn(pane);
}
async function loadRun(id) {
  const store = runStore(id);
  if (store.loaded) return store;
  store.meta = await api(`/api/runs/${id}`);
  const txt = await (await fetch(`/api/runs/${id}/events`)).text();
  for (const line of txt.split('\n')) { if (!line) continue; try { ingest(store, JSON.parse(line)); } catch {} }
  store.loaded = true;
  return store;
}

// ── websocket ──────────────────────────────────────────────────────────────
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  state.ws = ws;
  ws.onopen = () => $('#conn').classList.add('on');
  ws.onclose = () => { $('#conn').classList.remove('on'); setTimeout(connect, 1500); };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'term') { const t = state.terms.get(m.id); if (!t) return; const bytes = Uint8Array.from(m.data, (c) => c.charCodeAt(0)); if (t.hold?.(m.data)) return; return t.term.write(bytes); }
    if (m.type === 'term-exit') { const t = state.terms.get(m.id); if (t) { t.onDetach?.(); t.attached = false; t.term.write('\r\n\x1b[2m[detached — press Attach]\x1b[0m\r\n'); } return; }
    if (m.project !== P()) return;
    if (m.type === 'started') { state.current = m.run; const s = runStore(m.run); s.meta = m.meta; s.loaded = true; onRunChange(); if (route().name === 'deploy') showDeploy(); }
    else if (m.type === 'log') { const s = runStore(m.run); if (s.loaded) ingest(s, m); }
    else if (m.type === 'step') { const s = runStore(m.run); if (s.meta) { const i = s.meta.steps.findIndex((x) => x.id === m.step.id); if (i >= 0) s.meta.steps[i] = m.step; for (const fn of s.listeners) fn('step'); } }
    else if (m.type === 'done') { const s = runStore(m.run); state.current = null; api(`/api/runs/${m.run}`).then((meta) => { s.meta = meta; for (const fn of s.listeners) fn('done'); }); onRunChange(); }
  };
}
function send(msg) { if (state.ws?.readyState === 1) state.ws.send(JSON.stringify(msg)); }
function onRunChange() { document.querySelectorAll('.deploy-btn').forEach((b) => { b.disabled = !!state.current || !!state.problems.length; }); document.querySelectorAll('.abort-btn').forEach((b) => { b.hidden = !state.current; }); }

// ── the paged feed component ───────────────────────────────────────────────
function makeFeed({ pane, label, sub, getLines, hint }) {
  const el = $('#tpl-feed').content.firstElementChild.cloneNode(true);
  el.classList.add(pane);
  $('.label', el).textContent = label; $('.sub', el).textContent = sub || ''; $('.hint', el).textContent = hint || '';
  const f = { el, pane, page: 1, live: true, filter: null,
    render() {
      const all = getLines();
      const lines = f.filter ? all.filter((l) => l.step === f.filter) : all;
      const N = pageLines($('.screen', el));
      const pages = Math.max(1, Math.ceil(lines.length / N));
      if (f.live) f.page = pages;
      f.page = Math.min(Math.max(1, f.page), pages);
      const st = ANSI.freshState();
      const start = (f.page - 1) * N;
      for (let i = Math.max(0, start - 200); i < start; i++) ANSI.renderLine(lines[i].raw, st);
      let html = '';
      for (let i = start; i < Math.min(lines.length, start + N); i++) html += `<span class="ln">${ANSI.renderLine(lines[i].raw, st) || ' '}</span>`;
      for (let i = Math.min(lines.length, start + N); i < start + N; i++) html += '<span class="ln empty">·</span>';
      $('.screen', el).innerHTML = html;
      $('.pos', el).textContent = `${f.page} / ${pages}`;
      $('.prev', el).disabled = $('.first', el).disabled = f.page <= 1;
      $('.next', el).disabled = $('.last', el).disabled = f.page >= pages;
      $('.live', el).classList.toggle('on', f.live);
      $('.count', el).textContent = `${lines.length} line${lines.length === 1 ? '' : 's'}${f.filter ? ` · step: ${f.filter}` : ''}`;
    },
  };
  const go = (p) => { f.live = false; f.page = p; f.render(); };
  $('.first', el).onclick = () => go(1); $('.prev', el).onclick = () => go(f.page - 1);
  $('.next', el).onclick = () => go(f.page + 1); $('.last', el).onclick = () => go(1e9);
  $('.live', el).onclick = () => { f.live = !f.live; f.render(); };
  let rz; const relayout = () => { clearTimeout(rz); rz = setTimeout(f.render, 60); };
  new ResizeObserver(relayout).observe($('.screen', el));
  window.addEventListener('resize', relayout);
  requestAnimationFrame(f.render);
  return f;
}

// ── the dock ───────────────────────────────────────────────────────────────
/* A page's title, status and buttons, floating over the canvas instead of
   taking a band of it. Drag it by the title, collapse it to a pill, and it
   remembers where you left it per page. */
function dock(key, { title, meta = '', actions = '', body = '' }) {
  // A page can re-render itself while a run streams in; one dock per page,
  // never a stack of them fighting over the same element ids.
  clearDocks();
  const el = document.createElement('section');
  el.className = 'dock';
  // A fixed size when open: the panel must not grow or shift because something
  // finished loading into it. Content that does not fit is paged, the same way
  // the feeds are.
  el.innerHTML = `<header class="dock-grip">
      <span class="dock-title">${title}</span>
      <span class="dock-meta">${meta}</span>
      <span class="dock-actions">${actions}</span>
      <button class="pg dock-fold" title="collapse (or double-click the title)">▾</button>
    </header><div class="dock-body"${body ? '' : ' hidden'}><div class="dock-scroll">${body}</div>
      <div class="dock-pager" hidden><button class="pg prev">‹</button><span class="pos"></span><button class="pg next">›</button></div>
    </div>`;
  document.body.appendChild(el);
  // Versioned: a position saved before the dock moved to the bottom right
  // would otherwise pin it wherever it used to sit, for good. Bumping this
  // resets everyone once; the old keys are swept up so they cannot come back.
  const store = `dock.v2.${key}`;
  for (const k of Object.keys(localStorage)) if (k.startsWith('dock.') && !k.startsWith('dock.v2.')) localStorage.removeItem(k);

  // Paging inside the body, by pixels: whatever the content is, one panel-high
  // slice of it shows at a time.
  const scroll = $('.dock-scroll', el), pager = $('.dock-pager', el);
  let page = 1, repaging = false;
  const repage = () => {
    // Re-entrancy is not theoretical: this writes the page counter, and the
    // observer below would call it again for that write — a microtask storm
    // that wedges the whole renderer. The flag clears on the next frame, not
    // in a microtask, because observer callbacks *are* microtasks.
    if (!body || repaging) return;
    repaging = true;
    requestAnimationFrame(() => { repaging = false; });
    const view = $('.dock-body', el).clientHeight - (pager.hidden ? 0 : 26);
    const pages = Math.max(1, Math.ceil(scroll.scrollHeight / Math.max(1, view)));
    pager.hidden = pages < 2;
    page = Math.min(page, pages);
    scroll.style.transform = `translateY(${-(page - 1) * view}px)`;
    $('.pos', pager).textContent = `${page} / ${pages}`;
    $('.prev', pager).disabled = page <= 1;
    $('.next', pager).disabled = page >= pages;
  };
  $('.prev', pager).onclick = () => { page--; repage(); };
  $('.next', pager).onclick = () => { page++; repage(); };

  const place = (x, y) => {
    // A dock removed by a re-render must not keep writing its position: its
    // rect reads as zeros once detached, which saved the panel into the corner
    // the moment anything dispatched a resize.
    if (!el.isConnected) return;
    const r = el.getBoundingClientRect();
    x = Math.min(Math.max(8, x), Math.max(8, innerWidth - r.width - 8));
    y = Math.min(Math.max(60, y), Math.max(60, innerHeight - 44));
    el.style.left = `${x}px`; el.style.top = `${y}px`;
    localStorage.setItem(store, JSON.stringify({ x, y, folded: el.classList.contains('folded') }));
  };
  let saved = {}, placed = false;
  try { saved = JSON.parse(localStorage.getItem(store) || '{}'); } catch {}
  el.classList.toggle('folded', !!saved.folded);
  // Bottom right by default: out of the way of a canvas that reads top-down.
  // Placed synchronously — the page dispatches a resize while it lays the
  // splitters out, and a dock still waiting for its first frame reads as being
  // at 0,0 and gets saved into the corner.
  const initial = () => {
    const r = el.getBoundingClientRect();
    place(saved.x ?? innerWidth - r.width - 22, saved.y ?? innerHeight - r.height - 18);
    placed = true;
    repage();
  };
  initial();
  requestAnimationFrame(repage);
  const grip = $('.dock-grip', el);
  grip.onmousedown = (e) => {
    if (e.target.closest('button, a, select, input')) return;
    e.preventDefault();
    const r = el.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    el.classList.add('dragging');
    const move = (ev) => place(ev.clientX - dx, ev.clientY - dy);
    const up = () => { el.classList.remove('dragging'); document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
  };
  const fold = () => {
    el.classList.toggle('folded');
    $('.dock-fold', el).textContent = el.classList.contains('folded') ? '▸' : '▾';
    const r = el.getBoundingClientRect(); place(r.left, r.top); repage();
  };
  $('.dock-fold', el).onclick = fold;
  grip.ondblclick = (e) => { if (!e.target.closest('button, a, select, input')) fold(); };
  $('.dock-fold', el).textContent = el.classList.contains('folded') ? '▸' : '▾';
  const onResize = () => { if (!placed) return; const r = el.getBoundingClientRect(); place(r.left, r.top); repage(); };
  addEventListener('resize', onResize);
  el.dropListener = () => removeEventListener('resize', onResize);
  // Anything written into the dock later (a run's status, an elapsed time) must
  // not move it, so the size is fixed and only the paging is recomputed.
  // The content only — never the pager, which repage writes to itself.
  new MutationObserver(repage).observe(scroll, { childList: true, subtree: true, characterData: true });
  return el;
}

const clearDocks = () => document.querySelectorAll('.dock').forEach((d) => { d.dropListener?.(); d.remove(); });

// ── splitters ──────────────────────────────────────────────────────────────
/* Drag the line between two panes to resize them; double-click resets. The
   sizes are kept per layout key so a page opens the way you left it. */
function splitter(container, { axis = 'col', key, sidebar = false, min = .2, minPx = 170, maxPx = 520 }) {
  const el = document.createElement('div');
  el.className = `split ${axis}`;
  container.appendChild(el);
  const prop = axis === 'col' ? 'gridTemplateColumns' : 'gridTemplateRows';
  // Two shapes: a sidebar (first track a pixel width, second takes the rest)
  // and an even split (two fr tracks sharing 2fr between them).
  const apply = (v) => {
    if (sidebar) { container.style[prop] = `${v}px 1fr`; el.style.left = `${v - 3}px`; }
    else { container.style[prop] = `${v}fr ${2 - v}fr`; el.style[axis === 'col' ? 'left' : 'top'] = `calc(${(v / 2) * 100}% - 3px)`; }
    window.dispatchEvent(new Event('resize'));
  };
  const clamp = (v) => (sidebar ? Math.min(maxPx, Math.max(minPx, v)) : Math.min(2 - min * 2, Math.max(min * 2, v)));
  const DEFAULT = sidebar ? 260 : 1;
  let frac = clamp(Number(localStorage.getItem(`split.${key}`)) || DEFAULT);
  apply(frac);
  el.onmousedown = (e) => {
    e.preventDefault();
    document.body.classList.add(axis === 'col' ? 'resizing-col' : 'resizing-row');
    const r = container.getBoundingClientRect();
    const move = (ev) => {
      frac = clamp(sidebar ? ev.clientX - r.left
        : (axis === 'col' ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height) * 2);
      apply(frac);
    };
    const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); document.body.classList.remove('resizing-col', 'resizing-row'); localStorage.setItem(`split.${key}`, String(frac)); };
    document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
  };
  el.ondblclick = () => { frac = DEFAULT; apply(frac); localStorage.removeItem(`split.${key}`); };
  return el;
}

/* A maximize button on a card: it fills its grid and the others hide. */
function maximizable(card, group) {
  const b = document.createElement('button');
  b.className = 'pg max'; b.title = 'maximize (Esc to restore)'; b.textContent = '⤢';
  (card.querySelector('.pager') || card.querySelector('.actions') || card.querySelector('header') || card).appendChild(b);
  const toggle = () => {
    const on = !card.classList.contains('maxed');
    for (const c of document.querySelectorAll('.card')) c.classList.remove('maxed', 'hidden-by-max');
    for (const g of document.querySelectorAll('.has-max')) g.classList.remove('has-max');
    if (on) {
      card.classList.add('maxed');
      group.classList.add('has-max');
      // Every other card on the page gets out of the way, not just this group's.
      for (const c of document.querySelectorAll('#view .card')) if (c !== card) c.classList.add('hidden-by-max');
    }
    b.textContent = on ? '⤡' : '⤢';
    b.title = on ? 'restore (Esc)' : 'maximize';
    // Let the box settle, then re-measure: the terminal refits and reports its
    // new size to tmux, and a feed recomputes how many lines a page holds.
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
    setTimeout(() => window.dispatchEvent(new Event('resize')), 60);
  };
  b.onclick = toggle;
  card.addEventListener('dblclick', (e) => { if (e.target.closest('header, .head')) toggle(); });
  return toggle;
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { const m = document.querySelector('.card.maxed'); if (m) m.querySelector('.max')?.click(); } });

// ── routes ─────────────────────────────────────────────────────────────────
function route() { const h = location.hash.replace(/^#/, '') || 'deploy'; const [name, ...rest] = h.split('/'); return { name, arg: rest.join('/') }; }
function setTab(name) { document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === name)); }
function teardown() {
  clearDocks();
  for (const s of state.runs.values()) s.listeners.clear();
  for (const t of state.terms.values()) { clearInterval(t.poll); send({ type: 'detach', id: t.id }); t.term.dispose(); }
  state.terms.clear(); clearInterval(state.tick);
}
async function render() {
  teardown();
  const r = route();
  setTab(r.name === 'run' ? 'runs' : r.name);
  if (r.name === 'remote') return showRemote();
  if (r.name === 'deploy') return showDeploy();
  if (r.name === 'run') return showDeploy(r.arg);
  if (r.name === 'runs') return showRuns(Number(r.arg) || 1);
  if (r.name === 'troubleshoot') return showTroubleshoot();
  if (r.name === 'settings') return showSettings(r.arg);
  location.hash = '#deploy';
}
window.addEventListener('hashchange', render);

// ── Deploy / Run ───────────────────────────────────────────────────────────
async function showDeploy(runId) {
  let id = runId || state.current;
  if (!id) { const l = await api('/api/runs?size=1'); id = l.current || l.runs[0]?.id; state.current = l.current; }
  const problems = state.problems;
  view.innerHTML = `
    <div class="grid fill">
      <aside class="card"><header><h2>Steps</h2></header><ul class="steps" id="steps"></ul></aside>
      <div class="feeds two" id="feeds"></div>
      <section class="card notdone" id="notdone" hidden><header><h2>Not done yet</h2><span class="muted" style="font-size:12px">what this deploy leaves for a person, or the troubleshooter</span>
        <div class="pager"><button class="pg prev">‹</button><span class="pos"></span><button class="pg next">›</button></div></header><div class="body"></div></section>
    </div>`;
  // The header carries the title and the one button you press; everything that
  // changes while a run streams — status, elapsed, which buttons apply — lives
  // in the fixed body, so nothing resizes or reflows under the cursor.
  dock('deploy', {
    title: runId ? 'Run' : 'Deploy',
    actions: `<button class="btn sm danger abort-btn" id="abort" hidden>Abort</button>
      <button class="btn sm primary deploy-btn" id="deploy" ${state.current || problems.length ? 'disabled' : ''}>▲ Deploy now</button>`,
    body: `<div class="dock-line" id="runmeta"><span class="faint">no run yet</span></div>
      <div class="dock-line">
        <a class="ts-status" id="ts-status" href="#troubleshoot" title="the troubleshooters run before anything else">troubleshooters <span data-s="local">…</span> <span data-s="remote">…</span></a>
        <button class="btn sm" id="toggle-nd" hidden>□ Not done</button>
      </div>
      <div class="dock-line" title="where this project is deployed and what from">
        <a class="dock-target" href="#settings/server">${esc(targetText())}<span class="faint">:${esc(state.remoteDir || '')}</span></a>
        <a class="dock-target" href="#settings/project">${state.project.git.url ? `${esc(state.project.git.url.replace(/^.*[/:]/, '').replace(/\.git$/, ''))}<span class="faint">#${esc(state.project.git.branch)}</span>` : '<span class="faint">no repository</span>'}</a>
      </div>
      ${problems.length ? `<div class="problems">${problems.map((x) => `<div>${esc(x)}</div>`).join('')}<a href="#settings/server" style="text-decoration:underline">Open Settings</a></div>` : ''}`,
  });
  onRunChange();
  for (const side of ['local', 'remote']) api(`/api/troubleshoot/${side}/status`).then((r) => { const el = $(`#ts-status [data-s=${side}]`); if (!el) return; el.textContent = `${side} ${r.running ? '●' : '○'}`; el.className = r.running ? 'on' : 'off'; }).catch(() => {});
  $('#deploy').onclick = startDeploy;
  $('#abort').onclick = () => api('/api/deploy/abort', { method: 'POST' }).catch((e) => toast(e.message, true));
  if (!id) {
    $('#feeds').innerHTML = `<div class="card empty"><b>No runs for ${esc(state.project.title || P())} yet</b>Press <b>Deploy now</b> to push ${esc(state.sourceDir)} to ${esc(targetText())}.</div>`;
    $('#steps').innerHTML = (state.project.steps || []).map((s, i) => `<li class="pending"><span class="n">${i + 1}</span><span class="t">${esc(s.title || s.id)}<small>${esc(s.side === 'local' ? 'local' : (multi() ? (s.target || state.project.targets[0]) : 'remote'))} · ${esc(s.kind)}</small></span><span class="d"></span></li>`).join('');
    return;
  }
  const store = await loadRun(id);
  const feeds = [
    makeFeed({ pane: 'local', label: 'Local', sub: 'this machine, pushing', getLines: () => store.lines.local, hint: 'rsync + ssh from here' }),
    makeFeed({ pane: 'remote', label: 'Remote', sub: targetText(), getLines: () => store.lines.remote, hint: 'what the server prints' }),
  ];
  for (const f of feeds) $('#feeds').appendChild(f.el);
  splitter($('#feeds'), { axis: 'row', key: 'deploy-feeds' });
  splitter($('.grid'), { axis: 'col', key: 'deploy-grid', sidebar: true });
  for (const f of feeds) maximizable(f.el, $('#feeds'));
  let selected = null;
  const drawSteps = () => {
    const m = store.meta; if (!m) return;
    $('#steps').innerHTML = `<li class="all ${selected ? '' : 'selected'}" data-step=""><span class="n">∗</span><span class="t">All steps</span><span class="d"></span></li>` +
      m.steps.map((s, i) => `<li class="${s.status} ${selected === s.id ? 'selected' : ''}" data-step="${esc(s.id)}"><span class="n">${s.status === 'ok' ? '✓' : s.status === 'failed' ? '✕' : s.status === 'warn' ? '!' : s.status === 'waiting' ? '?' : i + 1}</span><span class="t">${esc(s.title)}<small>${esc(s.side === 'remote' && s.target && s.target !== 'server' ? s.target : s.side)}</small></span><span class="d">${s.startedAt ? dur(s.startedAt, s.finishedAt) : ''}</span></li>`).join('');
    $('#steps').querySelectorAll('li').forEach((li) => { li.onclick = () => { selected = li.dataset.step || null; for (const f of feeds) { f.filter = selected; f.live = true; f.render(); } drawSteps(); }; });
    $('#runmeta').innerHTML = `<span class="pill ${m.status}">${m.status}</span><span class="mono">${esc(m.id)}</span><span>${fmtT(m.startedAt)}</span><span class="mono" id="elapsed">${dur(m.startedAt, m.finishedAt)}</span>`;
    $('#toggle-nd').hidden = !(m.notDone && m.status !== 'running');
    if (m.notDone) notDonePanel.set(m.notDone);
    drawAsk(m.steps.find((s) => s.status === 'waiting' && s.ask));
  };
  const drawAsk = (s) => {
    // Fixed over the page, not in the dock: a waiting run is the one thing to look at.
    let box = $('#ask');
    if (!box) { box = document.createElement('div'); box.id = 'ask'; box.className = 'ask'; box.hidden = true; document.body.appendChild(box); }
    box.hidden = !s; if (!s) { box.innerHTML = ''; box.dataset.step = ''; return; }
    if (box.dataset.step === s.id) return;
    box.dataset.step = s.id;
    const a = s.ask;
    box.innerHTML = `<b>${esc(a.title)}</b><div>${esc(a.text)}</div>
      <textarea class="mono" readonly rows="3">${esc(a.key)}</textarea>
      <div class="faint mono">${esc(a.keyPath)}</div>
      <div class="row"><button class="btn sm" data-a="copy">Copy key</button>${a.link ? `<a class="btn sm" href="${esc(a.link)}" target="_blank" rel="noopener">Open deploy keys ↗</a>` : ''}
      <span style="flex:1"></span><button class="btn sm" data-a="no">Cancel</button><button class="btn sm primary" data-a="yes">Continue</button></div>`;
    $('[data-a=copy]', box).onclick = () => { navigator.clipboard?.writeText(a.key).then(() => toast('Key copied'), () => { $('textarea', box).select(); }); };
    const answer = (ok) => api('/api/deploy/answer', { method: 'POST', body: { ok } }).catch((e) => toast(e.message, true));
    $('[data-a=yes]', box).onclick = () => answer(true);
    $('[data-a=no]', box).onclick = () => answer(false);
  };
  const notDonePanel = (() => {
    const nd = $('#notdone'); let sections = [], page = 1, shown = false;
    const draw = () => { $('.body', nd).innerHTML = md(sections[page - 1] || ''); $('.pos', nd).textContent = `${page} / ${sections.length}`; $('.prev', nd).disabled = page <= 1; $('.next', nd).disabled = page >= sections.length; };
    $('.prev', nd).onclick = () => { page--; draw(); }; $('.next', nd).onclick = () => { page++; draw(); };
    $('#toggle-nd').onclick = () => { shown = !shown; nd.hidden = !shown; $('#feeds').hidden = shown; $('#toggle-nd').textContent = shown ? '▤ Feeds' : `□ Not done (${sections.length - 1})`; if (shown) draw(); else for (const f of feeds) f.render(); };
    return { set(text) { sections = text.split(/\n(?=## )/); page = Math.min(page, sections.length); if (!shown) $('#toggle-nd').textContent = `□ Not done (${sections.length - 1})`; if (shown) draw(); } };
  })();
  drawSteps();
  store.listeners.add((what) => { if (what === 'local' || what === 'remote') feeds.find((f) => f.pane === what)?.render(); else drawSteps(); });
  state.tick = setInterval(() => { const e = $('#elapsed'); if (e && store.meta?.status === 'running') e.textContent = dur(store.meta.startedAt); }, 1000);
}
async function startDeploy() {
  try { const r = await api('/api/deploy', { method: 'POST' }); toast(`Run ${r.id} started`); location.hash = '#deploy'; if (route().name === 'deploy') showDeploy(); }
  catch (e) { toast(e.body?.problems ? e.body.problems.join(' · ') : e.message, true); }
}
function md(src) {
  const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  const out = []; let list = false, table = false;
  for (const line of src.split('\n')) {
    if (/^\|/.test(line)) { if (!table) { out.push('<table>'); table = true; } if (/^\|[-| ]+\|$/.test(line)) continue; out.push('<tr>' + line.split('|').slice(1, -1).map((c) => `<td>${inline(c.trim())}</td>`).join('') + '</tr>'); continue; } else if (table) { out.push('</table>'); table = false; }
    const li = line.match(/^- \[ \] (.*)/) || line.match(/^\s*- (.*)/);
    if (li) { if (!list) { out.push('<ul>'); list = true; } out.push(`<li class="${line.includes('[ ]') ? 'todo' : ''}">${inline(li[1])}</li>`); continue; }
    if (/^\s{4,}\S/.test(line) && list) { out[out.length - 1] = out[out.length - 1].replace(/<\/li>$/, ' ' + inline(line.trim()) + '</li>'); continue; }
    if (list) { out.push('</ul>'); list = false; }
    const h = line.match(/^(#{1,3}) (.*)/);
    if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (list) out.push('</ul>'); if (table) out.push('</table>');
  return out.join('\n').replace(/<\/p>\n<p>/g, ' ');
}

// ── Runs ───────────────────────────────────────────────────────────────────
async function showRuns(page) {
  const size = Math.max(4, Math.floor((view.clientHeight - 92) / 43));
  const l = await api(`/api/runs?page=${page}&size=${size}`);
  view.innerHTML = `<section class="card runs-card fill">${l.runs.length ? `<table class="runs"><thead><tr><th>Run</th><th>Status</th><th>Steps</th><th>Target</th><th>Started</th><th>Took</th></tr></thead><tbody>
    ${l.runs.map((r) => `<tr data-id="${r.id}"><td class="mono">${esc(r.id)}</td><td><span class="pill ${r.status}">${r.status}</span></td><td><div class="stepdots">${r.steps.map((s) => `<i class="${s.status}" title="${esc(s.id)}: ${s.status}"></i>`).join('')}</div></td><td class="mono muted">${esc(r.target || '')}</td><td>${fmtT(r.startedAt)}</td><td class="mono">${dur(r.startedAt, r.finishedAt)}</td></tr>`).join('')}
    </tbody></table>` : '<div class="empty"><b>No runs yet</b>Nothing has been deployed from here for this project.</div>'}
    <div class="tfoot"><span>Page ${l.page} of ${l.pages}</span><span class="pager"><button class="pg" ${l.page <= 1 ? 'disabled' : ''} onclick="location.hash='#runs/${l.page - 1}'">‹</button><button class="pg" ${l.page >= l.pages ? 'disabled' : ''} onclick="location.hash='#runs/${l.page + 1}'">›</button></span></div></section>`;
  dock('runs', {
    title: 'Runs',
    meta: `${esc(state.project.title || P())} · ${l.total} run${l.total === 1 ? '' : 's'}`,
    actions: `<button class="btn sm primary deploy-btn" ${state.current || state.problems.length ? 'disabled' : ''}>▲ Deploy now</button>`,
  });
  $('.deploy-btn').onclick = startDeploy;
  view.querySelectorAll('tr[data-id]').forEach((tr) => { tr.onclick = () => (location.hash = `#run/${tr.dataset.id}`); });
}

// ── Troubleshoot ───────────────────────────────────────────────────────────
async function showTroubleshoot() {
  // No header here: the four consoles are the page, and a strip of prose above
  // them costs a row of every one of them. What it used to say lives on the
  // cards themselves — the command is in each card's tooltip.
  view.innerHTML = `<div class="feeds four fill" id="quad"><div class="feeds four" id="terms" style="grid-row:1;grid-column:1/3;grid-template-rows:1fr"></div><div class="feeds four" id="feeds" style="grid-row:2;grid-column:1/3;grid-template-rows:1fr"></div></div>`;
  for (const [side, label, sub] of [['local', 'Local', 'this machine'], ['remote', 'Remote', targetText()]]) $('#terms').appendChild(termCard(side, label, sub));
  splitter($('#terms'), { axis: 'col', key: 'ts-terms' });
  for (const c of $('#terms').querySelectorAll('.card')) maximizable(c, $('#terms'));
  const l = await api('/api/runs?size=1'); const id = l.current || l.runs[0]?.id;
  if (!id) {
    // Nothing deployed yet: the terminals take the whole page rather than
    // sharing it with an empty half that says so.
    $('#feeds').remove();
    $('#quad').style.gridTemplateRows = '1fr';
  } else {
    splitter($('#quad'), { axis: 'row', key: 'ts-rows' });
    const store = await loadRun(id);
    const feeds = [
      makeFeed({ pane: 'local', label: 'Deploy feed · local', sub: id, getLines: () => store.lines.local, hint: `also at runs/${P()}/${id}/local.log` }),
      makeFeed({ pane: 'remote', label: 'Deploy feed · remote', sub: id, getLines: () => store.lines.remote, hint: 'also pushed as .deploy/logs/last-deploy.md' }),
    ];
    for (const f of feeds) $('#feeds').appendChild(f.el);
    splitter($('#feeds'), { axis: 'col', key: 'ts-feeds' });
    for (const f of feeds) maximizable(f.el, $('#feeds'));
    store.listeners.add((what) => feeds.find((f) => f.pane === what)?.render());
  }
}
function termCard(side, label, sub) {
  const isShell = side === 'shell';
  const cmd = isShell ? 'a login shell' : (state.project?.troubleshoot?.command || 'ollama launch claude');
  const el = document.createElement('section');
  el.className = `card term feed ${side}`;
  el.title = isShell
    ? `A login shell on ${targetText()}, inside tmux. It outlives this tab: close the browser and it is still there.`
    : `${cmd} — inside tmux on the ${side} side. Type straight into the terminal, or send a line below it.`;
  // A bare shell is not a troubleshooter. Saying so is not enough — the fix
  // is one setting, so the chip itself is the button that applies it.
  const bareShell = !isShell && /^(bash|sh|zsh|fish)$/.test(cmd.trim());
  el.innerHTML = `<div class="head"><div class="feed-title"><span class="dot"></span><span class="label">${label}</span><span class="sub">${esc(sub)}</span>${
    bareShell
      ? `<button class="cmd bad" data-a="fix-cmd" title="This project runs &quot;${esc(cmd)}&quot; here — a plain shell, not a troubleshooter. Click to set it to ollama launch claude and restart the session.">⚠ ${esc(cmd)}</button>`
      : `<span class="cmd" title="what this pane runs (Settings → Project)">${esc(cmd)}</span>`}</div>
    <div class="actions"><span class="status" id="st-${side}">…</span>
      <span class="histpos" hidden></span><button class="pg" data-a="pageup" title="page back through this pane's history">⇞</button><button class="pg" data-a="pagedown" title="page forward">⇟</button><button class="pg" data-a="bottom" title="back to the live pane" hidden>live</button>
      <button class="btn sm" data-a="start" title="start a new session, replacing whatever is in this one">New</button><button class="btn sm" data-a="attach">Attach</button>${isShell ? '' : '<button class="btn sm" data-a="context" title="push the latest deploy\'s feeds to this side">Send logs</button>'}<button class="btn sm danger" data-a="stop">${isShell ? 'Close' : 'Stop'}</button></div></div>
    <div class="xt"><div class="xterm-host"></div></div>
    <div class="row"><input placeholder="type a line for the troubleshooter and press Enter (sent with tmux send-keys)"><button class="btn sm" data-a="send">Send</button></div>`;
  const term = new Terminal({ cursorBlink: true, fontSize: 12.5, fontFamily: 'JetBrains Mono, SFMono-Regular, ui-monospace, Menlo, monospace', theme: { background: '#000000', foreground: '#c9d1dc', cursor: '#2dd4bf', selectionBackground: 'rgba(45,212,191,.3)' }, scrollback: 0, allowProposedApi: true });
  const fit = new FitAddon.FitAddon(); term.loadAddon(fit);
  term.open($('.xterm-host', el));
  const id = `t-${side}`;
  const t = { id, side, term, fit, attached: false };
  state.terms.set(id, t);
  term.onData((d) => { if (t.attached) send({ type: 'input', id, data: utf8(d) }); });
  // The terminal itself, and only that: the ring means "your keystrokes land
  // here", which is not true of the line box under it — that one sends a line
  // when you press its button.
  term.textarea?.addEventListener('focus', () => el.classList.add('focused'));
  term.textarea?.addEventListener('blur', () => el.classList.remove('focused'));
  const attach = () => { fit.fit(); sent = `${term.cols}x${term.rows}`; send({ type: 'attach', id, side, project: P(), target: state.target, cols: term.cols, rows: term.rows }); t.attached = true; el.classList.add('live'); term.focus(); };
  t.onDetach = () => { t.attached = false; el.classList.remove('live'); };
  $('.xt', el).onmousedown = () => { if (t.attached) setTimeout(() => term.focus(), 0); };
  // Only this pane's own box. Listening to the window's resize made every
  // terminal on the page refit and tell tmux its size whenever any one of them
  // changed — so maximizing the remote pane had the local pane talking to its
  // own tmux, and complaining about it. A ResizeObserver on this box already
  // covers the window resizing, a splitter dragging and a maximize.
  let rz, sent = '';
  const refit = () => {
    clearTimeout(rz);
    rz = setTimeout(() => {
      const box = $('.xt', el).getBoundingClientRect();
      if (box.width < 20 || box.height < 20) return;   // hidden behind a maximized sibling
      try { fit.fit(); } catch { return; }
      const size = `${term.cols}x${term.rows}`;
      if (!t.attached || size === sent) return;        // nothing changed: say nothing
      sent = size;
      send({ type: 'resize', id, cols: term.cols, rows: term.rows });
    }, 120);
  };
  new ResizeObserver(refit).observe($('.xt', el));
  // Paging through history. While paging, live output is held back and shown
  // again on return, so the page you are reading does not move under you.
  let offset = 0, held = '';
  const pos = $('.histpos', el), bottomBtn = $('[data-a=bottom]', el);
  const showPage = async (n) => {
    const r = await api(`/api/troubleshoot/${side}/history?rows=${term.rows}&offset=${Math.max(0, n)}`);
    offset = r.offset;
    if (offset === 0) return toLive();
    el.classList.add('paging');
    pos.hidden = bottomBtn.hidden = false;
    pos.textContent = `−${offset} / ${r.pages - 1}`;
    term.write('\x1b[H\x1b[2J' + r.text.replace(/\r?\n/g, '\r\n'));
  };
  const toLive = async () => {
    offset = 0; el.classList.remove('paging'); pos.hidden = bottomBtn.hidden = true;
    const r = await api(`/api/troubleshoot/${side}/history?rows=${term.rows}&offset=0`);
    term.write('\x1b[H\x1b[2J' + r.text.replace(/\r?\n/g, '\r\n'));
    if (held) { term.write(held); held = ''; }
  };
  t.hold = (data) => { if (offset > 0) { held += data; return true; } return false; };
  const status = async () => {
    try {
      const s = await api(`/api/troubleshoot/${side}/status`);
      const el2 = $(`#st-${side}`);
      // Reset first: a state left over from a previous poll (the pointer
      // cursor and click handler a size mismatch adds) would otherwise stay on
      // one pane and not the other, which reads as the two behaving differently.
      el2.onclick = null; el2.style.cursor = ''; el2.style.color = '';
      if (s.stale) {
        // Running, but not the thing the project asks for. Start fixes it, so
        // say that rather than leaving a green light over the wrong program.
        el2.innerHTML = `<span style="color:var(--amber)">● running ${esc(s.started)}</span>`;
        el2.title = `This session runs "${s.started}", not "${s.command}". Press Start to restart it.`;
        el.classList.add('mismatch');
      } else if (s.running && s.size && s.size !== `${term.cols}x${term.rows}`) {
        // Correct it rather than only naming it: whatever moved the pane — a
        // stale client, a session started at another size — the program inside
        // must draw for the terminal you are looking at.
        if (t.attached) send({ type: 'resize', id, cols: term.cols, rows: term.rows });
        // The program inside is drawing for a different screen than the one
        // you are looking at: every redraw lands a row or a column out, which
        // shows up as doubled or shifted lines. Name it, and offer the repair.
        el2.innerHTML = `<span style="color:var(--amber)">● ${esc(s.size)} ≠ ${term.cols}x${term.rows}</span>`;
        el2.title = `The pane is ${s.size} but this terminal is ${term.cols}x${term.rows}, so the program redraws for the wrong size. Click to resize it.${s.clients?.length > 1 ? ` Attached clients: ${s.clients.join(', ')}.` : ''}`;
        el2.style.cursor = 'pointer';
        el2.onclick = () => { send({ type: 'resize', id, cols: term.cols, rows: term.rows }); setTimeout(status, 600); };
        el.classList.add('mismatch');
      } else {
        el.classList.remove('mismatch');
        el2.textContent = s.running ? '● running' : '○ stopped';
        el2.style.color = s.running ? 'var(--green)' : 'var(--faint)';
        // The pointer shape over the output is the program's doing: a program
        // reporting mouse events gets an arrow, one that is not gets an I-beam.
        // Both facts live here so a difference between the panes is readable.
        el2.title = s.running
          ? `${s.command}\nTERM ${s.term || 'unknown'} · pane ${s.size}${s.mouse ? ' · the program is asking for mouse events; this terminal does not send them, so text stays selectable' : ''}`
          : (s.command || '');
      }
      return s.running;
    } catch { $(`#st-${side}`).textContent = 'unreachable'; return false; }
  };
  const input = $('input', el);
  const sendLine = async () => { const text = input.value; if (!text) return; input.value = ''; try { await api(`/api/troubleshoot/${side}/send`, { method: 'POST', body: { text } }); } catch (e) { toast(e.message, true); } };
  input.onkeydown = (e) => { if (e.key === 'Enter') sendLine(); };
  el.querySelectorAll('button[data-a]').forEach((b) => {
    b.onclick = async () => {
      const a = b.dataset.a;
      try {
        if (a === 'start') {
          fit.fit();
          // New means new: whatever is in there goes and a fresh session takes
          // its place, which is what you want when it is wedged, running the
          // wrong thing, or just old.
          const r = await api(`/api/troubleshoot/${side}/restart`, { method: 'POST', body: { cols: term.cols, rows: term.rows } }); if (!isShell) toast(r.out || 'started'); if (r.context) term.write(`\x1b[2mdeploy feeds pushed to ${r.context}\x1b[0m\r\n`); await status(); if (!t.attached) setTimeout(attach, 400); if (!isShell) input.value = input.value || `Read .deploy/logs/last-deploy.md (both sides of the last deploy) and .deploy/NOT-DONE.md, then help me finish what is not done.`; }
        else if (a === 'attach') { if (!(await status())) return toast('Start it first', true); attach(); }
        else if (a === 'context') { const r = await api(`/api/troubleshoot/${side}/context`, { method: 'POST' }); toast(r.context ? `deploy feeds pushed to ${r.context}` : 'no run to send yet', !r.context); }
        else if (a === 'stop') { send({ type: 'detach', id }); t.onDetach?.(); const r = await api(`/api/troubleshoot/${side}/stop`, { method: 'POST' }); toast(r.out); await status(); }
        else if (a === 'pageup') await showPage(offset + 1);
        else if (a === 'pagedown') await showPage(offset - 1);
        else if (a === 'bottom') await toLive();
        else if (a === 'fix-cmd') {
          const want = 'ollama launch claude';
          const r = await api('/api/project', { method: 'PUT', body: { troubleshoot: { ...state.project.troubleshoot, command: want } } });
          state.project = r.project;
          toast(`troubleshooter command set to "${want}"`);
          await api(`/api/troubleshoot/${side}/stop`, { method: 'POST' }).catch(() => {});
          showTroubleshoot();
        }
        else if (a === 'send') sendLine();
      } catch (e) { toast(e.message, true); }
    };
  });
  // Sizes drift for reasons outside this page (another client attaching, a
  // session created at a different size), so the pane keeps checking.
  t.poll = setInterval(status, 5000);
  status().then((running) => {
    if (running) return attach();
    // The shell is the point of the Remote tab, so it opens itself — with a
    // plain start, never the New button, which would throw away a session you
    // had left running here.
    if (isShell) {
      return api(`/api/troubleshoot/${side}/start`, { method: 'POST', body: { cols: term.cols, rows: term.rows } })
        .then(() => status())
        .then(() => setTimeout(attach, 400))
        .catch((e) => term.write(`\r\n\x1b[31m${e.message}\x1b[0m\r\n`));
    }
    term.write(`\x1b[2m${side}: not running — press New\x1b[0m\r\n`);
  });
  setTimeout(() => fit.fit(), 50);
  return el;
}

// ── Remote: an ssh shell on the server, in tmux ────────────────────────────
async function showRemote() {
  const bad = state.problems.find((x) => /host|user|password/.test(x));
  view.innerHTML = `<div class="feeds fill" id="shell" style="grid-template-rows:1fr"></div>`;
  if (bad) {
    view.innerHTML = `<div class="card empty fill"><b>${esc(bad)}</b>The Remote tab is a shell on the server, so it needs somewhere to connect. <a href="#settings/server" style="text-decoration:underline">Settings → Server</a>, then test the connection there.</div>`;
    return;
  }
  const card = termCard('shell', 'Remote shell', `${targetText()}:${state.remoteDir || ''}`);
  $('#shell').appendChild(card);
  maximizable(card, $('#shell'));
}

// ── Settings ──// ── Settings ───────────────────────────────────────────────────────────────
const TABS = ['server', 'project', 'variables', 'steps', 'files'];
async function showSettings(tab) {
  tab = TABS.includes(tab) ? tab : 'server';
  const p = state.project;
  // No title band: the tab row is the header, and carries where you are and
  // the one button this page has.
  view.innerHTML = `<div class="subtabs">
      <button class="btn primary sm" id="save">Save</button>
      ${TABS.map((t) => `<button data-t="${t}" class="${t === tab ? 'on' : ''}">${t[0].toUpperCase() + t.slice(1)}</button>`).join('')}
      <span class="subtabs-where mono faint">projects/${esc(P())}/</span>
    </div>
    ${state.problems.length ? `<div class="problems">${state.problems.map((x) => `<div>${esc(x)}</div>`).join('')}</div>` : ''}
    <div class="fill" id="pane"></div>`;
  view.querySelectorAll('.subtabs button').forEach((b) => (b.onclick = () => (location.hash = `#settings/${b.dataset.t}`)));
  const pane = $('#pane');
  const save = SETTINGS[tab](pane, p);
  $('#save').onclick = async () => {
    try { const body = save(); const r = await api('/api/project', { method: 'PUT', body }); state.project = r.project; state.problems = r.problems; state.files = r.files; state.sourceDir = r.sourceDir; state.remoteDir = r.remoteDir; state.target = r.target; $('#target').textContent = targetText(); state.app.projects = (await api('/api/app')).projects; drawProjects(); drawTargets(); toast('Saved'); showSettings(tab); }
    catch (e) { toast(e.message, true); }
  };
}
const F = (name, label, value, { type = 'text', small = '', ph = '' } = {}) => `<div class="field"><label>${label}</label><input name="${name}" type="${type}" value="${esc(value ?? '')}" placeholder="${esc(ph)}">${small ? `<small>${small}</small>` : ''}</div>`;
const formValues = (root) => { const o = {}; for (const el of root.querySelectorAll('[name]')) { let v = el.type === 'checkbox' ? el.checked : el.value; if (el.type === 'number') v = Number(v); if (v === 'true') v = true; if (v === 'false') v = false; set(o, el.name, v); } return o; };
const get = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
const set = (o, p, v) => { const ks = p.split('.'); let a = o; for (const k of ks.slice(0, -1)) a = a[k] ??= {}; a[ks[ks.length - 1]] = v; };

const SETTINGS = {
  server(pane, p) {
    const s = p.local.server;
    pane.innerHTML = `<div class="two-col fill">
      <section class="card settings-card"><header><h2>Connection${multi() ? ` · ${esc(p.target)}` : ''}</h2><span class="muted" style="font-size:12px">${multi() ? 'one server per target — switch targets in the top bar · ' : ''}this machine's — kept out of git</span></header><div class="body">
        <div class="row2">${F('local.server.host', 'Host', s.host, { ph: '203.0.113.10' })}${F('local.server.port', 'Port', s.port, { type: 'number' })}</div>
        ${F('local.server.user', 'User', s.user, { ph: 'me', small: 'The user alone. A whole destination pasted into Host is split for you.' })}
        <div class="row2"><div class="field"><label>Auth</label><select name="local.server.auth.type"><option value="key" ${s.auth.type === 'key' ? 'selected' : ''}>SSH key</option><option value="agent" ${s.auth.type === 'agent' ? 'selected' : ''}>ssh-agent / default keys</option><option value="password" ${s.auth.type === 'password' ? 'selected' : ''}>Password (needs sshpass here)</option></select></div>
        ${F('local.server.auth.keyPath', 'Key on this machine', s.auth.keyPath, { ph: '~/.ssh/id_ed25519' })}</div>
        ${F('local.server.auth.password', 'Password', s.auth.password, { type: 'password', small: 'Handed to sshpass through the environment, never a command line.' })}
        ${F('local.server.remoteDir', 'Directory on the server', s.remoteDir, { ph: `/home/me/${P()}` })}
        <div class="field"><label>Mode</label><select name="local.simulate"><option value="false" ${!p.local.simulate ? 'selected' : ''}>ssh — deploy to the server</option><option value="true" ${p.local.simulate ? 'selected' : ''}>simulate — every step runs on this machine</option></select></div>
      </div></section>
      <section class="card settings-card"><header><h2>Connection test</h2><span class="muted" id="test-out" style="font-size:12.5px">not run yet</span><button type="button" class="btn sm" id="test-ssh" style="margin-left:auto">Test</button></header><div class="body" id="test-detail">
        <div class="faint" style="font-size:13px">Saves what is on screen, opens a real ssh session, and reports who you are on the server, whether the directory is a checkout yet, which tools are installed, and whether the server itself can reach the repository.</div>
      </div></section></div>`;
    $('#test-ssh').onclick = async () => {
      const out = $('#test-out'), detail = $('#test-detail');
      out.textContent = 'connecting…'; out.style.color = ''; detail.innerHTML = '';
      try {
        // Test what is on screen, not what was saved an hour ago.
        const saved = await api('/api/project', { method: 'PUT', body: formValues(pane) });
        state.project = saved.project; state.problems = saved.problems; state.remoteDir = saved.remoteDir;
        $('#target').textContent = targetText();
        const r = await api('/api/project/test-ssh', { method: 'POST' });
        if (!r.ok && r.error) { out.textContent = r.error; out.style.color = 'var(--red)'; return; }
        out.textContent = r.ok ? `connected in ${r.ms} ms` : `failed — exit ${r.code}`;
        out.style.color = r.ok ? 'var(--green)' : 'var(--red)';
        const f = r.facts || {};
        const tool = (n) => `<span class="${f['tool_' + n] === 'yes' ? 'ok' : 'no'}">${f['tool_' + n] === 'yes' ? '✓' : '✕'} ${n}</span>`;
        const dirWord = { 'git-checkout': 'a git checkout', exists: 'exists, not a checkout yet', missing: 'not created yet — the first deploy clones into it' }[f.dir_state] || f.dir_state;
        detail.innerHTML = r.ok ? `<div class="probe">
            <div><b>${esc(f.user || '?')}@${esc(f.host || '?')}</b> <span class="faint">${esc(f.uname || '')}</span></div>
            <div><span class="mono">${esc(f.dir || '')}</span> — ${esc(dirWord || '')}</div>
            <div class="tools">${['git', 'tmux', 'docker', 'node', 'curl'].map(tool).join('')}${f.tool_docker === 'yes' && f.docker_usable === 'no' ? '<span class="no">✕ docker usable by this user</span>' : ''}</div>
            ${r.gitAuth ? (r.gitAuth.ok
              ? `<div><span class="ok">✓ the server can reach the repository</span> — <span class="mono">${esc(state.project.git.branch)}</span> is at <span class="mono">${esc(r.gitAuth.commit)}</span></div>`
              : `<div><span class="no">✕ the server cannot reach the repository</span><pre>${esc(r.gitAuth.out)}</pre></div>`) : '<div class="faint">no repository set, so nothing to check there</div>'}
          </div>` : `<div class="probe"><pre>${esc(r.out || 'no output')}</pre><div class="faint mono" style="margin-top:8px">${esc(r.command)}</div></div>`;
      } catch (e) { out.textContent = e.message; out.style.color = 'var(--red)'; }
    };
    return () => formValues(pane);
  },
  project(pane, p) {
    const hasPush = (p.steps || []).some((x) => x.kind === 'push');
    pane.innerHTML = `<div class="two-col fill">
    <section class="card settings-card"><header><h2>Project</h2></header><div class="body">
      ${F('title', 'Title', p.title)}${F('description', 'Description', p.description)}
      ${F('targetsText', 'Targets', (p.targets || []).join(', '), { ph: 'server', small: 'The servers this project deploys to, comma separated (say <span class="mono">edge, origin</span>). Each gets its own connection under Server; each step names the one it runs on. The first is the default.' })}
      ${F('templatesText', 'Templates', (p.templates || []).join(', '), { small: 'Files under templates/, comma separated. Rendered with {{variables}} into each run; a .md with "- [ ]" items becomes the Not-done panel.' })}
      <div class="row2">${F('troubleshoot.command', 'Troubleshooter command', p.troubleshoot.command, { ph: 'ollama launch claude', small: /^(bash|sh|zsh)$/.test((p.troubleshoot.command || '').trim()) ? '<b style="color:var(--amber)">This is a bare shell, not a troubleshooter.</b> Set it to <span class="mono">ollama launch claude</span>.' : '' })}${F('troubleshoot.tmuxSession', 'tmux session name', p.troubleshoot.tmuxSession)}</div>
      <div class="field"><label>Previews</label><div style="display:flex;gap:8px;flex-wrap:wrap">${(p.templates || []).map((t) => `<a class="btn sm" href="/api/project/preview?template=${encodeURIComponent(t)}" target="_blank">${esc(t)}</a>`).join('') || '<span class="faint">none</span>'}</div></div>
      <div class="field"><label>New project</label><div style="display:flex;gap:8px"><input id="np-name" placeholder="name" style="flex:1"><select id="np-from"><option value="_template">from the bare template</option>${state.app.projects.map((x) => `<option value="${esc(x.name)}">copy of ${esc(x.title || x.name)}</option>`).join('')}</select><button class="btn sm" id="np-go">Create</button></div></div>
    </div></section>
    <section class="card settings-card"><header><h2>Repository</h2><span class="muted" style="font-size:12px">the server fetches this itself</span></header><div class="body">
      ${F('git.url', 'Remote', p.git.url, { ph: 'git@github.com:owner/repo.git', small: 'ssh or https. Over ssh the key below is the one <b>on the server</b>, and its public half is a deploy key on the repository.' })}
      ${F('git.branch', 'Branch', p.git.branch, { ph: 'main' })}
      ${F('git.keyPath', 'Deploy key on the server', p.git.keyPath, { ph: '~/.ssh/id_ed25519', small: 'blank: whatever the ssh user already has' })}
      <div class="row2">${F('git.depth', 'Shallow depth', p.git.depth, { type: 'number', small: '0 = full history' })}<div class="field"><label>Submodules</label><select name="git.submodules"><option value="false" ${!p.git.submodules ? 'selected' : ''}>no</option><option value="true" ${p.git.submodules ? 'selected' : ''}>update recursively</option></select></div></div>
      <small class="faint">An https remote can use a token: set <span class="mono">git.token</span> under Variables — a secret, handed to git through askpass.</small>
      ${hasPush ? `<div class="row2">${F('push.excludes', 'rsync excludes file', p.push.excludes, { small: 'edited under Files' })}<div class="field"><label>Delete on push</label><select name="push.delete"><option value="true" ${p.push.delete !== false ? 'selected' : ''}>yes — mirror</option><option value="false" ${p.push.delete === false ? 'selected' : ''}>no — add and update only</option></select></div></div>` : ''}
    </div></section></div>`;
    $('#np-go').onclick = async () => { try { await api('/api/projects', { method: 'POST', body: { name: $('#np-name').value, from: $('#np-from').value } }); state.app = await api('/api/app'); await loadProject(); toast(`project ${P()} created`); location.hash = '#settings/server'; } catch (e) { toast(e.message, true); } };
    return () => { const v = formValues(pane); v.git.depth = Number(v.git.depth) || 0; v.git.submodules = v.git.submodules === true; v.templates = String(v.templatesText || '').split(',').map((s) => s.trim()).filter(Boolean); delete v.templatesText; v.targets = String(v.targetsText || '').split(',').map((s) => s.trim()).filter(Boolean); delete v.targetsText; if (v.push) v.push.delete = v.push.delete !== false; return v; };
  },
  variables(pane, p) {
    const rows = Object.entries(p.variables).map(([k, v]) => ({ k, v, s: p.secrets.includes(k) }));
    const envRows = Object.entries(p.env || {}).map(([k, v]) => ({ k, v }));
    const per = Math.max(4, Math.floor((view.clientHeight - 300) / 44));
    let page = 1;
    pane.innerHTML = `<div class="two-col fill"><section class="card settings-card"><header><h2>Variables</h2><span class="muted" style="font-size:12px">what templates, step env and commands refer to as {{key}}; scripts get each one as KEY_NAME</span><div class="pager"><button class="pg prev">‹</button><span class="pos"></span><button class="pg next">›</button><button class="btn sm" id="v-add">+ add</button></div></header><div class="body" id="v-body"></div></section>
      <section class="card settings-card"><header><h2>Script env</h2><span class="muted" style="font-size:12px">extra environment for every script and command, templated</span><div class="pager"><button class="pg prev" id="e-prev">‹</button><span class="pos" id="e-pos"></span><button class="pg next" id="e-next">›</button><button class="btn sm" id="e-add">+ add</button></div></header><div class="body" id="e-body"></div></section></div>`;
    let epage = 1;
    const drawV = () => {
      const pages = Math.max(1, Math.ceil(rows.length / per)); page = Math.min(Math.max(1, page), pages);
      $('#v-body').innerHTML = `<table class="kv"><thead><tr><th>Key</th><th>Value</th><th title="kept in local.json, masked here">Secret</th><th></th></tr></thead><tbody>` + rows.slice((page - 1) * per, page * per).map((r, i) => { const idx = (page - 1) * per + i; return `<tr><td><input data-i="${idx}" data-f="k" value="${esc(r.k)}"></td><td><input data-i="${idx}" data-f="v" type="${r.s ? 'password' : 'text'}" value="${esc(r.v)}"></td><td><input data-i="${idx}" data-f="s" type="checkbox" ${r.s ? 'checked' : ''}></td><td><button class="pg" data-del="${idx}">✕</button></td></tr>`; }).join('') + '</tbody></table>';
      const vc = $('#v-body').closest('.card'); $('.pos', vc).textContent = `${page} / ${pages}`; $('.prev', vc).disabled = page <= 1; $('.next', vc).disabled = page >= pages;
      $('#v-body').querySelectorAll('input').forEach((el) => (el.oninput = () => { const r = rows[el.dataset.i]; if (el.dataset.f === 's') { r.s = el.checked; drawV(); } else r[el.dataset.f] = el.value; }));
      $('#v-body').querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => { rows.splice(Number(b.dataset.del), 1); drawV(); }));
    };
    const drawE = () => {
      const pages = Math.max(1, Math.ceil(envRows.length / per)); epage = Math.min(Math.max(1, epage), pages);
      $('#e-body').innerHTML = `<table class="kv"><thead><tr><th>Name</th><th>Value (templated)</th><th></th></tr></thead><tbody>` + envRows.slice((epage - 1) * per, epage * per).map((r, j) => { const i = (epage - 1) * per + j; return `<tr><td><input data-i="${i}" data-f="k" value="${esc(r.k)}" class="mono"></td><td><input data-i="${i}" data-f="v" value="${esc(r.v)}" class="mono"></td><td><button class="pg" data-del="${i}">✕</button></td></tr>`; }).join('') + '</tbody></table>';
      $('#e-pos').textContent = `${epage} / ${pages}`; $('#e-prev').disabled = epage <= 1; $('#e-next').disabled = epage >= pages;
      $('#e-body').querySelectorAll('input').forEach((el) => (el.oninput = () => { envRows[el.dataset.i][el.dataset.f] = el.value; }));
      $('#e-body').querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => { envRows.splice(Number(b.dataset.del), 1); drawE(); }));
    };
    $('#v-body').closest('.card').querySelector('.prev').onclick = () => { page--; drawV(); }; $('#v-body').closest('.card').querySelector('.next').onclick = () => { page++; drawV(); };
    $('#v-add').onclick = () => { rows.push({ k: '', v: '', s: false }); page = 1e9; drawV(); };
    $('#e-add').onclick = () => { envRows.push({ k: '', v: '' }); epage = 1e9; drawE(); };
    $('#e-prev').onclick = () => { epage--; drawE(); }; $('#e-next').onclick = () => { epage++; drawE(); };
    drawV(); drawE();
    return () => { const variables = {}, secrets = [], env = {}; for (const r of rows) { if (!r.k.trim()) continue; variables[r.k.trim()] = r.v; if (r.s) secrets.push(r.k.trim()); } for (const r of envRows) if (r.k.trim()) env[r.k.trim()] = r.v; return { variables, secrets, env }; };
  },
  steps(pane, p) {
    const steps = JSON.parse(JSON.stringify(p.steps || []));
    const KINDS = { preflight: 'preflight — check tools here, ship .deploy/, run a remote script', fetch: 'fetch — the server pulls the branch from git', push: 'push — rsync a local directory to the server', script: 'script — run a remote/ script', command: 'command — run a shell string', report: 'report — render templates, list what is not done' };
    const scripts = state.files.filter((f) => f.startsWith('remote/')).map((f) => f.slice(7));
    pane.innerHTML = `<section class="card settings-card fill"><header><h2>Steps</h2><span class="muted" style="font-size:12px">run in this order; a failure stops the run unless a later step is marked always</span><button class="btn sm" id="s-add" style="margin-left:auto">+ add step</button></header><div class="body steps-body" id="s-body"></div></section>`;
    const draw = () => {
      $('#s-body').innerHTML = steps.map((s, i) => `<div class="steprow">
        <span class="n">${i + 1}</span>
        <input data-i="${i}" data-f="id" value="${esc(s.id)}" placeholder="id" class="mono" style="width:110px">
        <input data-i="${i}" data-f="title" value="${esc(s.title)}" placeholder="title" style="width:150px">
        <select data-i="${i}" data-f="kind">${Object.entries(KINDS).map(([k, d]) => `<option value="${k}" ${s.kind === k ? 'selected' : ''} title="${d}">${k}</option>`).join('')}</select>
        <select data-i="${i}" data-f="side"><option value="remote" ${s.side !== 'local' ? 'selected' : ''}>remote</option><option value="local" ${s.side === 'local' ? 'selected' : ''}>local</option></select>
        ${(p.targets || []).length > 1 ? `<select data-i="${i}" data-f="target" title="the server this step runs on" ${s.side === 'local' ? 'disabled' : ''}>${p.targets.map((t) => `<option value="${esc(t)}" ${(s.target || p.targets[0]) === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>` : ''}
        <input data-i="${i}" data-f="run" value="${esc(s.run || '')}" list="scripts" placeholder="${s.kind === 'command' ? 'shell command, {{vars}} allowed' : s.kind === 'script' || s.kind === 'preflight' ? 'remote/ script' : s.kind === 'fetch' ? 'configured under Project → Repository' : ''}" class="mono" style="flex:1">
        <label class="chk" title="run even after a failure"><input data-i="${i}" data-f="always" type="checkbox" ${s.always ? 'checked' : ''}> always</label>
        <button class="pg" data-up="${i}" ${i === 0 ? 'disabled' : ''}>↑</button><button class="pg" data-down="${i}" ${i === steps.length - 1 ? 'disabled' : ''}>↓</button><button class="pg" data-del="${i}">✕</button>
      </div>`).join('') + `<datalist id="scripts">${scripts.map((s) => `<option value="${esc(s)}">`).join('')}</datalist>`;
      $('#s-body').querySelectorAll('[data-f]').forEach((el) => (el.onchange = el.oninput = () => { const s = steps[el.dataset.i]; s[el.dataset.f] = el.type === 'checkbox' ? el.checked : el.value; if (el.dataset.f === 'kind' || el.dataset.f === 'side') draw(); }));
      $('#s-body').querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => { steps.splice(Number(b.dataset.del), 1); draw(); }));
      $('#s-body').querySelectorAll('[data-up]').forEach((b) => (b.onclick = () => { const i = Number(b.dataset.up); [steps[i - 1], steps[i]] = [steps[i], steps[i - 1]]; draw(); }));
      $('#s-body').querySelectorAll('[data-down]').forEach((b) => (b.onclick = () => { const i = Number(b.dataset.down); [steps[i + 1], steps[i]] = [steps[i], steps[i + 1]]; draw(); }));
    };
    $('#s-add').onclick = () => { steps.push({ id: `step${steps.length + 1}`, title: '', kind: 'script', side: 'remote', run: '', always: false }); draw(); };
    draw();
    return () => ({ steps: steps.map((s) => ({ ...s, id: s.id.trim() || undefined })) });
  },
  files(pane, p) {
    let current = state.files[0] || '';
    pane.innerHTML = `<section class="card settings-card fill files"><header><h2>Files</h2><select id="f-sel">${state.files.map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join('')}</select><span class="muted" style="font-size:12px">remote/ is pushed to &lt;remoteDir&gt;/.deploy/ · templates/ are rendered per run</span><div style="margin-left:auto;display:flex;gap:6px"><input id="f-new" placeholder="remote/new.sh or templates/NEW.md" class="mono" style="width:260px"><button class="btn sm" id="f-create">New file</button><button class="btn sm" id="f-save">Save file</button></div></header><textarea id="f-text" class="mono" spellcheck="false"></textarea></section>`;
    const load = async () => { if (!current) return ($('#f-text').value = ''); const r = await api(`/api/project/file?path=${encodeURIComponent(current)}`); $('#f-text').value = r.text; };
    const saveFile = async () => { if (!current) return; try { const r = await api('/api/project/file', { method: 'PUT', body: { path: current, text: $('#f-text').value } }); state.files = r.files; toast(`saved ${current}`); } catch (e) { toast(e.message, true); } };
    $('#f-sel').onchange = () => { current = $('#f-sel').value; load(); };
    $('#f-save').onclick = saveFile;
    $('#f-create').onclick = async () => { const name = $('#f-new').value.trim(); if (!name) return; try { const r = await api('/api/project/file', { method: 'PUT', body: { path: name, text: name.endsWith('.sh') ? '#!/usr/bin/env bash\nset -euo pipefail\n. "$(dirname "$0")/_lib.sh"\ncd "$REMOTE_DIR"\n' : '' } }); state.files = r.files; toast(`created ${name}`); showSettings('files'); setTimeout(() => { $('#f-sel').value = name; $('#f-sel').onchange(); }, 0); } catch (e) { toast(e.message, true); } };
    $('#f-text').onkeydown = (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); saveFile(); } if (e.key === 'Tab') { e.preventDefault(); const t = e.target; const s = t.selectionStart; t.value = t.value.slice(0, s) + '  ' + t.value.slice(t.selectionEnd); t.selectionStart = t.selectionEnd = s + 2; } };
    load();
    // The Save button in the bar saves the file too, so there is one habit.
    return () => { saveFile(); return {}; };
  },
};

function showEmpty() {
  view.innerHTML = `<section class="card settings-card" style="max-width:640px;margin:48px auto"><header><h2>No project yet</h2></header><div class="body">
    <p>deployacron does nothing until it is given a project. Either check out the config branch that holds yours (its <span class="mono">projects/&lt;name&gt;/</span> folder) and restart, or start one from the bare template:</p>
    <div style="display:flex;gap:8px"><input id="np-name" placeholder="name" style="flex:1"><button class="btn sm primary" id="np-go">Create</button></div></div></section>`;
  $('#np-go').onclick = async () => { try { await api('/api/projects', { method: 'POST', body: { name: $('#np-name').value } }); location.hash = '#settings/project'; location.reload(); } catch (e) { toast(e.message, true); } };
}

// ── boot ───────────────────────────────────────────────────────────────────
(async () => {
  state.app = await api('/api/app');
  $('#project').onchange = () => switchProject($('#project').value);
  $('#target-sel').onchange = () => switchTarget($('#target-sel').value);
  // With no project there is nothing to deploy, and deployacron does nothing
  // until it is given one: create it here, or check out a config branch.
  if (!state.app.projects.length) return showEmpty();
  await loadProject();
  connect();
  render();
})();
