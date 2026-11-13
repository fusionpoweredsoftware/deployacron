// deployacron — a deployer you run in a browser, for any project that
// is "push a directory to a server and run scripts there".
//
//   npm start          → http://localhost:4747
//
// One Express app for the pages and the JSON API, one WebSocket for the live
// feeds and the interactive troubleshooter terminals. Projects live under
// projects/<name>/, runs under runs/<project>/<id>/.

import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { WebSocketServer } from 'ws';
import { ROOT, RUNS_DIR, loadApp, saveApp, listProjects, loadProject, saveProject, createProject, redact, validate, sourceDir, remoteDir, vars, listFiles, readProjectFile, writeProjectFile, bindTarget, projectDir } from './lib/projects.mjs';
import { render } from './lib/template.mjs';
import { Run, listRuns, readMeta, eventsStream, readFile, prune } from './lib/runner.mjs';
import { buildSteps } from './lib/pipeline.mjs';
import { control, attach, serverProblem, isTarget, commandFor } from './lib/troubleshoot.mjs';
import { sshCommand, sshDisplay, qPath } from './lib/ssh.mjs';
import { run as execRun } from './lib/exec.mjs';

mkdirSync(RUNS_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use('/vendor/xterm', express.static(path.join(ROOT, 'node_modules/@xterm/xterm')));
app.use('/vendor/addon-fit', express.static(path.join(ROOT, 'node_modules/@xterm/addon-fit')));
app.use(express.static(path.join(ROOT, 'public')));

const current = new Map();    // project → running Run
const sockets = new Set();
const broadcast = (msg) => { const s = JSON.stringify(msg); for (const ws of sockets) if (ws.readyState === 1) ws.send(s); };
const fail = (res, e, code = 400) => res.status(code).json({ error: e.message || String(e) });

/** The project a request is about (?project=, else the active one), bound to ?target= (else its first). */
function proj(req) {
  const a = loadApp();
  const name = req.query.project || req.body?.project || a.activeProject;
  let p;
  let known = false; try { known = existsSync(path.join(projectDir(String(name)), 'project.json')); } catch {}
  if (!known) {
    const first = listProjects()[0];
    if (!first) throw new Error('no projects — create one under Settings → Project, or check out your config branch');
    p = loadProject(first.name);
  } else p = loadProject(name);
  return bindTarget(p, req.query.target || req.body?.target);
}
const targetOf = (req) => req.query.target || req.body?.target;
const describe = (p) => ({ project: redact(p), problems: validate(p), sourceDir: sourceDir(p), remoteDir: remoteDir(p), files: listFiles(p), running: current.get(p.name)?.id || null, targets: p.targets, target: p.target });

// ── app + projects ──────────────────────────────────────────────────────────
app.get('/api/app', (req, res) => { const a = loadApp(); res.json({ ...a, projects: listProjects(), running: [...current.keys()] }); });
app.put('/api/app', (req, res) => { const { activeProject, port, keepRuns } = req.body || {}; res.json(saveApp({ activeProject, port: Number(port) || undefined, keepRuns: Number(keepRuns) || undefined })); });
app.post('/api/projects', (req, res) => {
  try { const p = createProject(String(req.body?.name || '').trim().toLowerCase(), req.body?.from || '_template'); saveApp({ activeProject: p.name }); res.json(describe(p)); }
  catch (e) { fail(res, e); }
});
app.get('/api/project', (req, res) => { try { res.json(describe(proj(req))); } catch (e) { fail(res, e); } });
app.put('/api/project', (req, res) => { try { const p = proj(req); res.json(describe(saveProject(p.name, req.body || {}, targetOf(req)))); } catch (e) { fail(res, e); } });
app.get('/api/project/file', (req, res) => { try { const t = readProjectFile(proj(req), String(req.query.path)); if (t == null) return res.status(404).json({ error: 'no such file' }); res.json({ path: req.query.path, text: t }); } catch (e) { fail(res, e); } });
app.put('/api/project/file', (req, res) => { try { const p = proj(req); writeProjectFile(p, String(req.body.path), String(req.body.text ?? '')); res.json({ ok: true, files: listFiles(p) }); } catch (e) { fail(res, e); } });
app.get('/api/project/preview', (req, res) => {
  try { const p = proj(req); const t = readProjectFile(p, `templates/${req.query.template}`); if (t == null) return res.status(404).type('text/plain').send('no such template'); res.type('text/plain').send(render(t, vars(p, { id: '(preview)' }))); }
  catch (e) { fail(res, e); }
});

/**
 * Connect to the server and report what is there. The first thing to press
 * when something does not work, and the answer is a sentence rather than a
 * program's usage block.
 */
app.post('/api/project/test-ssh', async (req, res) => {
  let p; try { p = proj(req); } catch (e) { return fail(res, e); }
  const bad = serverProblem(p);
  if (bad) return res.json({ ok: false, error: bad });
  // One round trip: identity, then whether the things a deploy needs exist.
  const probe = [
    'echo "host=$(hostname)"', 'echo "user=$(id -un)"', 'echo "uname=$(uname -sr)"',
    `echo "dir=$(printf %s ${qPath(remoteDir(p))})"`,
    `echo "dir_state=$([ -d ${qPath(remoteDir(p) + '/.git')} ] && echo git-checkout || { [ -d ${qPath(remoteDir(p))} ] && echo exists || echo missing; })"`,
    'for t in git tmux docker node curl; do printf "tool_%s=%s\n" "$t" "$(command -v $t >/dev/null 2>&1 && echo yes || echo no)"; done',
    'echo "docker_usable=$(docker ps >/dev/null 2>&1 && echo yes || echo no)"',
  ].join('; ');
  let cmd;
  try { cmd = sshCommand(p.local, probe, { tty: false }); } catch (e) { return res.json({ ok: false, error: e.message }); }
  const t0 = Date.now();
  let out = '';
  const r = await execRun(cmd.cmd, cmd.args, { env: { ...cmd.env, SSH_ASKPASS_REQUIRE: 'never' }, onData: (d) => (out += d) });
  const ms = Date.now() - t0;
  const facts = {};
  for (const line of out.split('\n')) { const m = line.match(/^([a-z_]+)=(.*)$/); if (m) facts[m[1]] = m[2].trim(); }
  // git reaching GitHub is a separate question, and the usual one to get wrong.
  let gitAuth = null;
  if (r.code === 0 && p.git.url) {
    const key = p.git.keyPath ? `-i ${qPath(p.git.keyPath)} -o IdentitiesOnly=yes ` : '';
    const check = `GIT_SSH_COMMAND='ssh ${key}-o BatchMode=yes -o StrictHostKeyChecking=accept-new' GIT_TERMINAL_PROMPT=0 git ls-remote --heads ${JSON.stringify(p.git.url)} ${JSON.stringify(p.git.branch || 'main')} 2>&1 | head -3`;
    let g = '';
    const gr = await execRun(...(({ cmd: c, args }) => [c, args])(sshCommand(p.local, check, { tty: false })), { env: cmd.env, onData: (d) => (g += d) });
    const sha = (g.match(/^([0-9a-f]{7,40})\s/m) || [])[1];
    gitAuth = { ok: gr.code === 0 && !!sha, commit: sha ? sha.slice(0, 8) : null, out: g.trim().slice(0, 500) };
  }
  res.json({ ok: r.code === 0, ms, code: r.code, command: sshDisplay(p.local, '…'), facts, gitAuth, out: out.trim().slice(0, 2000) });
});

// ── runs ────────────────────────────────────────────────────────────────────
app.get('/api/runs', (req, res) => {
  try { const p = proj(req); const out = listRuns(p.name, { page: Number(req.query.page) || 1, size: Math.min(50, Number(req.query.size) || 12) }); out.project = p.name; out.current = current.get(p.name)?.id || null; res.json(out); }
  catch (e) { fail(res, e); }
});
app.get('/api/runs/:id', (req, res) => {
  try { const p = proj(req); const m = readMeta(p.name, req.params.id); if (!m) return res.status(404).json({ error: 'no such run' }); res.json({ ...m, notDone: readFile(p.name, req.params.id, 'NOT-DONE.md') }); }
  catch (e) { fail(res, e); }
});
app.get('/api/runs/:id/events', (req, res) => { try { const s = eventsStream(proj(req).name, req.params.id); res.type('application/x-ndjson'); if (!s) return res.end(); s.pipe(res); } catch (e) { fail(res, e); } });
app.get('/api/runs/:id/:pane.log', (req, res) => {
  if (!['local', 'remote'].includes(req.params.pane)) return res.status(404).end();
  try { const t = readFile(proj(req).name, req.params.id, `${req.params.pane}.log`); if (t == null) return res.status(404).end(); res.type('text/plain').send(t); } catch (e) { fail(res, e); }
});

/** Start a run of `steps` for project p; the caller has checked nothing is running. */
function startRun(p, steps, kind) {
  const run = new Run({ kind, project: p.name, config: redact(p), steps });
  current.set(p.name, run);
  run.on('log', (ev) => broadcast({ type: 'log', project: p.name, run: run.id, ...ev }));
  run.on('step', (ev) => broadcast({ type: 'step', project: p.name, ...ev }));
  run.on('done', async (meta) => {
    current.delete(p.name);
    // The troubleshooters get this run's feeds without anyone pressing anything:
    // the local one, and the one on every target a step ran on.
    const used = [...new Set(steps.filter((x) => x.side === 'remote').map((x) => x.target))];
    try { await pushContext(p, 'local'); } catch (e) { console.error('[context local]', e.message); }
    for (const t of used) { try { await pushContext(bindTarget(p, t), 'remote'); } catch (e) { console.error(`[context ${t}]`, e.message); } }
    broadcast({ type: 'done', project: p.name, run: run.id, status: meta.status });
    prune(p.name, loadApp().keepRuns);
  });
  broadcast({ type: 'started', project: p.name, run: run.id, meta: run.meta });
  run.go(steps, { project: p }).catch((e) => { console.error(e); current.delete(p.name); });
  return run;
}
app.post('/api/deploy', (req, res) => {
  let p; try { p = proj(req); } catch (e) { return fail(res, e); }
  if (current.has(p.name)) return res.status(409).json({ error: `run ${current.get(p.name).id} is still going`, id: current.get(p.name).id });
  const problems = validate(p);
  if (problems.length) return res.status(400).json({ error: 'the project is not ready', problems });
  const run = startRun(p, buildSteps(p), 'deploy');
  res.json({ id: run.id, project: p.name });
});
/** The project's remote/prereqs.sh, once, on the selected target: what a server needs before its first deploy. */
app.post('/api/project/prereqs', (req, res) => {
  let p; try { p = proj(req); } catch (e) { return fail(res, e); }
  if (current.has(p.name)) return res.status(409).json({ error: `run ${current.get(p.name).id} is still going` });
  if (!listFiles(p).includes('remote/prereqs.sh')) return res.status(404).json({ error: 'this project has no remote/prereqs.sh' });
  const steps = buildSteps({ ...p, steps: [{ id: 'prereqs', title: `Prerequisites on ${p.target}`, kind: 'script', side: 'remote', target: p.target, run: 'prereqs.sh' }] }).slice(1);
  const run = startRun(p, steps, 'prereqs');
  res.json({ id: run.id, project: p.name });
});
app.post('/api/deploy/answer', (req, res) => {
  try { const p = proj(req); const r = current.get(p.name); if (!r || !r.answer(req.body?.ok)) return res.status(404).json({ error: 'nothing is waiting' }); res.json({ ok: true, id: r.id }); }
  catch (e) { fail(res, e); }
});
app.post('/api/deploy/abort', (req, res) => {
  try { const p = proj(req); const r = current.get(p.name); if (!r) return res.status(404).json({ error: 'nothing running' }); r.abort(); res.json({ ok: true, id: r.id }); }
  catch (e) { fail(res, e); }
});

// ── troubleshoot ────────────────────────────────────────────────────────────
const side = (s) => (isTarget(s) ? s : 'remote');
const strip = (s) => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');
/** The latest deploy's feeds, both sides, to <deploy dir>/logs/last-deploy.md on that side. */
async function pushContext(p, s) {
  const latest = listRuns(p.name, { page: 1, size: 1 }).runs[0];
  if (!latest) return '';
  const local = readFile(p.name, latest.id, 'local.log') || '', remote = readFile(p.name, latest.id, 'remote.log') || '', nd = readFile(p.name, latest.id, 'NOT-DONE.md') || '';
  const bundle = `# ${p.title || p.name} — deploy run ${latest.id} (${latest.status})\n\nProject: projects/${p.name}/ in the deployer. Source: ${sourceDir(p)}. Target${p.targets.length > 1 ? ` "${p.target}" (one of ${p.targets.join(', ')})` : ''}: ${p.local.server.user}@${p.local.server.host}:${remoteDir(p)} (ssh port ${p.local.server.port}${p.local.simulate ? ', SIMULATE mode — the "remote" side is this machine' : ''}).\n\nThe deployer's two feeds, colors stripped. LOCAL is the machine that pushed; REMOTE is the server that received.\n\n## LOCAL SIDE\n\n\`\`\`\n${strip(local)}\n\`\`\`\n\n## REMOTE SIDE\n\n\`\`\`\n${strip(remote)}\n\`\`\`\n\n${nd}`;
  const r = await control(p, s, 'context', { CONTEXT_B64: Buffer.from(bundle).toString('base64') });
  return r.out.trim();
}
app.get('/api/troubleshoot/:side/status', async (req, res) => { try { const p = proj(req); const r = await control(p, side(req.params.side), 'status'); const want = commandFor(p, side(req.params.side));
  // What the session records it was created to run.
  const started = ((r.out.match(/^cmd=(.*)$/m) || [])[1] || '').trim();
  // A tmux session keeps whatever it was started with, so a changed setting
  // does not reach a session that is already up.
  const stale = /running/.test(r.out) && started !== '' && started !== want;
  const size = (r.out.match(/^size=(\d+x\d+)$/m) || [])[1] || '';
  const clients = ((r.out.match(/^clients=(.*)$/m) || [])[1] || '').split(',').filter(Boolean);
  const term = (r.out.match(/^term=(.*)$/m) || [])[1] || '';
  const mouse = (r.out.match(/^mouse=(.*)$/m) || [])[1] === '1';
  res.json({ running: /running/.test(r.out), out: r.out.trim(), command: want, started, stale, size, clients, term, mouse }); } catch (e) { fail(res, e); } });
app.post('/api/troubleshoot/:side/context', async (req, res) => { try { const context = await pushContext(proj(req), side(req.params.side)); res.json({ ok: !!context, context }); } catch (e) { fail(res, e); } });
/**
 * start  — make sure it is running (kept if it already runs the right command)
 * restart — whatever is in there goes; a fresh session takes its place
 */
for (const action of ['start', 'restart']) {
  app.post(`/api/troubleshoot/:side/${action}`, async (req, res) => {
    try {
      const p = proj(req), s = side(req.params.side);
      const context = await pushContext(p, s);
      const r = await control(p, s, 'start', {
        COLS: String(req.body?.cols || 160), ROWS: String(req.body?.rows || 45),
        ...(action === 'restart' ? { FORCE: '1' } : {}),
      });
      res.json({ ok: r.code === 0, out: r.out.trim(), context });
    } catch (e) { fail(res, e); }
  });
}
app.post('/api/troubleshoot/:side/stop', async (req, res) => { try { const r = await control(proj(req), side(req.params.side), 'stop'); res.json({ ok: r.code === 0, out: r.out.trim() }); } catch (e) { fail(res, e); } });
app.post('/api/troubleshoot/:side/send', async (req, res) => { try { const r = await control(proj(req), side(req.params.side), 'send', { TEXT: String(req.body?.text || '') }); res.json({ ok: r.code === 0, out: r.out.trim() }); } catch (e) { fail(res, e); } });
/** One page of a pane's history: `offset` pages back from the live screen. */
app.get('/api/troubleshoot/:side/history', async (req, res) => {
  try {
    const p = proj(req), s = side(req.params.side);
    const rows = Math.max(4, Math.min(200, Number(req.query.rows) || 24));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const depth = Number((await control(p, s, 'depth')).out.trim()) || 0;
    const maxOffset = Math.ceil(depth / rows);
    const off = Math.min(offset, maxOffset);
    const start = -(off * rows), end = start + rows - 1;
    const r = await control(p, s, 'history', { START: String(start), END: String(end) });
    res.json({ text: r.out.replace(/\r?\n$/, ''), offset: off, pages: maxOffset + 1, depth });
  } catch (e) { fail(res, e); }
});
app.get('/api/troubleshoot/:side/feed', async (req, res) => { try { const r = await control(proj(req), side(req.params.side), 'feed'); res.type('text/plain').send(r.out); } catch (e) { fail(res, e); } });

// ── websocket: live feed + terminals ────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  sockets.add(ws);
  const terms = new Map();
  for (const r of current.values()) ws.send(JSON.stringify({ type: 'started', project: r.project, run: r.id, meta: r.meta }));
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'attach') {
      let p; try { p = bindTarget(loadProject(m.project), m.target); } catch (e) { return ws.send(JSON.stringify({ type: 'term', id: m.id, data: `\r\n${e.message}\r\n` })); }
      // Replacing an attach: the old one's exit must not be reported, or it
      // marks the *new* terminal detached and every keystroke is dropped.
      const old = terms.get(m.id);
      if (old) { old.stale = true; old.kill(); }
      const h = attach(p, side(m.side), {
        cols: m.cols, rows: m.rows,
        onData: (d) => !h.stale && ws.readyState === 1 && ws.send(JSON.stringify({ type: 'term', id: m.id, data: d.toString('binary') })),
        onExit: (code) => !h.stale && ws.readyState === 1 && ws.send(JSON.stringify({ type: 'term-exit', id: m.id, code })),
      });
      terms.set(m.id, h);
    } else if (m.type === 'input') terms.get(m.id)?.write(Buffer.from(m.data, 'binary'));
    else if (m.type === 'resize') terms.get(m.id)?.resize(m.cols, m.rows);
    else if (m.type === 'detach') { terms.get(m.id)?.kill(); terms.delete(m.id); }
  });
  ws.on('close', () => { sockets.delete(ws); for (const h of terms.values()) h.kill(); });
});

const a0 = loadApp();
const PORT = Number(process.env.PORT || a0.port || 4747);
server.listen(PORT, () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  console.log(`\n  \x1b[1mdeployacron\x1b[0m v${pkg.version} on \x1b[36mhttp://localhost:${PORT}\x1b[0m`);
  console.log(`  projects: ${listProjects().map((p) => (p.name === a0.activeProject ? `\x1b[1m${p.name}\x1b[0m` : p.name)).join(', ') || '\x1b[33mnone\x1b[0m'}\n`);
});
