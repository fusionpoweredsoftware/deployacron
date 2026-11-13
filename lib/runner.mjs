// A run: the steps, their outcomes, and every byte either side printed —
// kept raw, colors and all, as newline-delimited JSON events so the browser
// can replay a finished run exactly as it looked live.
//
//   runs/<id>/meta.json      steps, status, timings, redacted config
//   runs/<id>/events.ndjson  {t, step, pane, data} — pane is "local" or "remote"
//   runs/<id>/local.log      the local pane, raw
//   runs/<id>/remote.log     the remote pane, raw
//   runs/<id>/NOT-DONE.md    what this deploy left for a person

import { EventEmitter } from 'node:events';
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, readdirSync, existsSync, rmSync, createReadStream } from 'node:fs';
import path from 'node:path';
import { RUNS_DIR } from './projects.mjs';
import { run as exec } from './exec.mjs';

export function newRunId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** "user@host", or "edge user@host · origin user@host" when there are several targets. */
function describeTargets(config) {
  const servers = config.local.servers || { server: config.local.server };
  const names = config.targets?.length ? config.targets : Object.keys(servers);
  const one = (s) => (s ? `${s.user}@${s.host}` : '?');
  return names.length > 1 ? names.map((t) => `${t} ${one(servers[t])}`).join(' · ') : one(servers[names[0]] || config.local.server);
}

export class Run extends EventEmitter {
  constructor({ id = newRunId(), kind = 'deploy', project, config, steps }) {
    super();
    this.id = id;
    this.project = project;
    this.dir = path.join(RUNS_DIR, project, id);
    mkdirSync(this.dir, { recursive: true });
    this.meta = {
      id, kind, project, status: 'running', startedAt: new Date().toISOString(), finishedAt: null,
      target: config ? describeTargets(config) : '',
      steps: steps.map((s) => ({ id: s.id, title: s.title, side: s.side, target: s.target || '', status: 'pending', startedAt: null, finishedAt: null, exit: null })),
      config: config || null,
      error: null,
    };
    this.children = new Set();
    this.aborted = false;
    this.save();
  }

  save() { writeFileSync(path.join(this.dir, 'meta.json'), JSON.stringify(this.meta, null, 2)); }

  step(id) { return this.meta.steps.find((s) => s.id === id); }

  /** Append output to a pane, for one step. */
  log(pane, data, stepId) {
    if (!data) return;
    const ev = { t: Date.now(), step: stepId, pane, data };
    appendFileSync(path.join(this.dir, 'events.ndjson'), JSON.stringify(ev) + '\n');
    appendFileSync(path.join(this.dir, `${pane}.log`), data);
    this.emit('log', ev);
  }

  /** A line the deployer itself says, dimmed so it reads apart from the commands' own output. */
  note(pane, text, stepId) { this.log(pane, `\x1b[2m${text}\x1b[0m\r\n`, stepId); }

  setStep(id, patch) {
    Object.assign(this.step(id), patch);
    this.save();
    this.emit('step', { run: this.id, step: this.step(id) });
  }

  /** Run a command as part of a step, output to `pane`. Resolves with the exit code. */
  async exec(stepId, pane, cmd, args, opts = {}) {
    if (this.aborted) return { code: 130 };
    const shown = [cmd, ...args].map((a) => (/[\s'"]/.test(a) ? JSON.stringify(a) : a)).join(' ');
    this.log(pane, `\x1b[36m$ ${opts.display || shown}\x1b[0m\r\n`, stepId);
    let out = '';
    const res = await exec(cmd, args, {
      ...opts,
      onData: (d) => { this.log(pane, d, stepId); out = (out + d).slice(-65536); },
      onSpawn: (child) => { this.children.add(child); child.on('close', () => this.children.delete(child)); },
    });
    if (res.code !== 0) this.log(pane, `\x1b[31m✗ exit ${res.code}${res.signal ? ` (${res.signal})` : ''}\x1b[0m\r\n`, stepId);
    return { ...res, out };
  }

  /**
   * Pause a step until the person answers in the UI. The question rides on the
   * step itself (status "waiting", step.ask), so a reloaded page still shows it.
   * Resolves true for Continue, false for Cancel or an abort.
   */
  ask(stepId, info) {
    return new Promise((resolve) => {
      this.pending = { stepId, resolve };
      this.setStep(stepId, { status: 'waiting', ask: info });
    });
  }

  answer(ok) {
    const p = this.pending;
    if (!p) return false;
    this.pending = null;
    this.setStep(p.stepId, { status: 'running', ask: null });
    p.resolve(!!ok);
    return true;
  }

  abort() {
    this.aborted = true;
    this.answer(false);
    for (const c of this.children) { try { c.kill('SIGTERM'); } catch {} }
  }

  async go(steps, ctx) {
    let failed = null;
    for (const s of steps) {
      if (this.aborted) { this.setStep(s.id, { status: 'skipped' }); continue; }
      if (failed && !s.always) { this.setStep(s.id, { status: 'skipped' }); continue; }
      this.setStep(s.id, { status: 'running', startedAt: new Date().toISOString() });
      let outcome = 'ok';
      try {
        const r = await s.run({ ...ctx, run: this, step: s.id });
        if (r && r.code !== undefined && r.code !== 0) outcome = 'failed';
        if (r && r.warn) outcome = 'warn';
        this.setStep(s.id, { exit: r?.code ?? 0 });
      } catch (e) {
        outcome = 'failed';
        this.log(s.side, `\x1b[31m${e.stack || e.message}\x1b[0m\r\n`, s.id);
      }
      if (this.aborted) outcome = 'aborted';
      this.setStep(s.id, { status: outcome, finishedAt: new Date().toISOString() });
      if (outcome === 'failed' || outcome === 'aborted') failed = s.id;
    }
    this.meta.status = this.aborted ? 'aborted' : failed ? 'failed' : (this.meta.steps.some((s) => s.status === 'warn') ? 'warn' : 'ok');
    this.meta.finishedAt = new Date().toISOString();
    this.save();
    this.emit('done', this.meta);
    return this.meta;
  }
}

// ── the store ───────────────────────────────────────────────────────────────

const projDir = (project) => path.join(RUNS_DIR, safe(project));

export function listRuns(project, { page = 1, size = 12 } = {}) {
  const dir = projDir(project);
  if (!existsSync(dir)) return { runs: [], page, pages: 0, total: 0 };
  const ids = readdirSync(dir).filter((n) => !n.startsWith('.') && existsSync(path.join(dir, n, 'meta.json'))).sort().reverse();
  const total = ids.length, pages = Math.max(1, Math.ceil(total / size));
  page = Math.min(Math.max(1, page), pages);
  const runs = ids.slice((page - 1) * size, page * size).map((id) => {
    const m = readMeta(project, id);
    return m && { id: m.id, kind: m.kind, status: m.status, startedAt: m.startedAt, finishedAt: m.finishedAt, target: m.target,
      steps: m.steps.map((s) => ({ id: s.id, status: s.status })) };
  }).filter(Boolean);
  return { runs, page, pages, total };
}

export function readMeta(project, id) {
  const p = path.join(projDir(project), safe(id), 'meta.json');
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

export function eventsStream(project, id) {
  const p = path.join(projDir(project), safe(id), 'events.ndjson');
  return existsSync(p) ? createReadStream(p) : null;
}

export function readFile(project, id, name) {
  const p = path.join(projDir(project), safe(id), name);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

/** Keep the newest `keep` runs; the rest are logs nobody will read. */
export function prune(project, keep) {
  const dir = projDir(project);
  if (!existsSync(dir)) return;
  const ids = readdirSync(dir).filter((n) => !n.startsWith('.')).sort().reverse();
  for (const id of ids.slice(keep)) rmSync(path.join(dir, id), { recursive: true, force: true });
}

function safe(id) {
  if (!/^[\w.-]+$/.test(String(id))) throw new Error('bad run id');
  return id;
}
