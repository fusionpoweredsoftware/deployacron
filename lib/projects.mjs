// A project is a folder under projects/<name>/. The engine branch ships only
// projects/_template; a project's definition lives on a config branch of its
// own, so an engine update merged into that branch never touches it.
//
//   project.json        committed on the config branch — title, targets, variables, steps, push rules, templates
//   local.json          gitignored — each target's server, credentials, source path, secret values
//   remote/*.sh         pushed to <remoteDir>/.deploy/ and run there (or run here, for local steps)
//   templates/*         rendered with {{variables}} into the run and pushed to .deploy/
//   rsync-excludes.txt  what the push leaves out
//
// config.json (gitignored) holds only what is not a project's: the active project,
// the port, how many runs to keep.
//
// A project deploys to one or more named targets (say "edge" and "origin").
// Each target is its own server in local.json → servers.<name>; each step
// names the target it runs on, and the first target is the default.

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, cpSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { render, envName } from './template.mjs';

export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const PROJECTS_DIR = path.join(ROOT, 'projects');
export const RUNS_DIR = path.join(ROOT, 'runs');
/** The bare project new ones start from. Copied, never edited in place. */
export const TEMPLATE_DIR = path.join(PROJECTS_DIR, '_template');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const MASK = '••••••••';

const APP_DEFAULTS = { activeProject: '', port: 4747, keepRuns: 100 };
const SERVER_DEFAULTS = { host: '', port: 22, user: '', auth: { type: 'key', keyPath: '~/.ssh/id_ed25519', password: '' }, remoteDir: '' };
const LOCAL_DEFAULTS = {
  servers: {},         // target name → SERVER_DEFAULTS-shaped server
  source: { path: '' },
  simulate: false,
  values: {},          // secret (and locally overridden) variable values
};
const PROJECT_DEFAULTS = {
  title: '', description: '',
  // The servers this project deploys to, by name. Empty means one, "server".
  targets: [],
  // Where the code comes from. The *server* fetches it, so nothing is copied
  // from this machine and what is deployed is exactly what is on the branch.
  // keyPath is a path on the server, not here.
  git: { url: '', branch: 'main', keyPath: '', depth: 0, submodules: false },
  variables: {},        // key → default value (committed; secrets stay empty here)
  secrets: [],          // variable keys whose values live in local.json and are masked
  env: {},              // env every remote/local script gets, templated from variables
  push: { excludes: 'rsync-excludes.txt', delete: true },
  templates: [],        // files under templates/ rendered into the run and pushed to .deploy/
  steps: [],
  troubleshoot: { command: 'ollama launch claude', tmuxSession: '' },
};

const readJson = (p, fallback = {}) => { try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : fallback; } catch (e) { console.error(`[projects] ${p}: ${e.message}`); return fallback; } };
function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    if (k.startsWith('//')) continue;
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(base[k] || {}, v) : v;
  }
  return out;
}
export const expandHome = (p) => (p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p);
const safeTarget = (t) => /^[a-z0-9][a-z0-9_-]{0,30}$/i.test(String(t));
const safeName = (n) => { if (!/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(String(n))) throw new Error('project name: letters, digits, - and _ only'); return n; };

// ── app config ──────────────────────────────────────────────────────────────
export function loadApp() { return merge(APP_DEFAULTS, readJson(CONFIG_PATH)); }
export function saveApp(patch) { const c = merge(loadApp(), patch); writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2) + '\n'); return c; }

// ── projects ────────────────────────────────────────────────────────────────
export function listProjects() {
  if (!existsSync(PROJECTS_DIR)) return [];
  return readdirSync(PROJECTS_DIR).filter((n) => !n.startsWith('_') && !n.startsWith('.') && existsSync(path.join(PROJECTS_DIR, n, 'project.json')))
    .map((name) => { const p = readJson(path.join(PROJECTS_DIR, name, 'project.json')); return { name, title: p.title || name, description: p.description || '' }; });
}
export function projectDir(name) { return path.join(PROJECTS_DIR, safeName(name)); }

/** One server, tidied: a destination pasted whole is split, a missing directory gets a default. */
function normalizeServer(raw, name) {
  const srv = merge(SERVER_DEFAULTS, raw);
  srv.port = Number(srv.port) || 22;
  // "andrey@192.168.1.64" typed into Host is what people actually do, and
  // handing ssh "@192.168.1.64" makes it print its usage block, which reads
  // like the deployer is broken rather than like a field is in the wrong box.
  const at = String(srv.host || '').lastIndexOf('@');
  if (at > 0) { srv.user ||= srv.host.slice(0, at); srv.host = srv.host.slice(at + 1); }
  // A port stuck on the end of the host is the same mistake.
  const colon = String(srv.host || '').lastIndexOf(':');
  if (colon > 0 && /^\d+$/.test(srv.host.slice(colon + 1))) {
    srv.port = Number(srv.host.slice(colon + 1));
    srv.host = srv.host.slice(0, colon);
  }
  srv.host = String(srv.host || '').trim();
  srv.user = String(srv.user || '').trim();
  // root's home is /root, not /home/root — a default that names a directory
  // the server does not have is worse than no default.
  if (!srv.remoteDir && srv.user) srv.remoteDir = srv.user === 'root' ? `/root/${name}` : `/home/${srv.user}/${name}`;
  return srv;
}

/** The project's target names, in order; never empty. */
export const targetsOf = (def) => { const t = (def.targets || []).map(String).filter(safeTarget); return t.length ? [...new Set(t)] : ['server']; };

/** local.json's servers, with a pre-targets `server` block read as the first target's. */
function rawServers(local, targets) {
  const servers = { ...(local.servers || {}) };
  if (local.server && !servers[targets[0]]) servers[targets[0]] = local.server;
  return servers;
}

/**
 * The whole project, merged: shareable definition + this machine's local.json.
 * local.server is the first target's server; bindTarget() gives a view of the
 * project on another one.
 */
export function loadProject(name) {
  const dir = projectDir(name);
  if (!existsSync(path.join(dir, 'project.json'))) throw new Error(`no such project: ${name}`);
  const def = merge(PROJECT_DEFAULTS, readJson(path.join(dir, 'project.json')));
  const local = merge(LOCAL_DEFAULTS, readJson(path.join(dir, 'local.json')));
  def.targets = targetsOf(def);
  const raw = rawServers(local, def.targets);
  local.servers = Object.fromEntries(def.targets.map((t) => [t, normalizeServer(raw[t], name)]));
  delete local.server;
  const variables = { ...def.variables, ...local.values };
  def.troubleshoot.tmuxSession ||= `${name}-troubleshoot`;
  const p = { name, dir, ...def, variables, local };
  return bindTarget(p, def.targets[0]);
}

/**
 * The project as seen from one target: local.server is that target's server,
 * and the server-side troubleshooter session carries the target's name when
 * there is more than one. Everything that talks to "the server" takes a bound
 * project, so none of it needs to know there are several.
 */
export function bindTarget(p, target) {
  const t = p.targets.includes(target) ? target : p.targets[0];
  const base = p.troubleshoot.baseSession || p.troubleshoot.tmuxSession;
  return {
    ...p, target: t,
    local: { ...p.local, server: p.local.servers[t] },
    troubleshoot: { ...p.troubleshoot, baseSession: base, tmuxSession: p.targets.length > 1 ? `${base}-${t}` : base },
  };
}

/** Split a project back into project.json (shared) and local.json (this machine), and write both. */
export function saveProject(name, incoming, target) {
  const cur = loadProject(name);
  const dir = cur.dir;
  const def = merge(PROJECT_DEFAULTS, readJson(path.join(dir, 'project.json')));
  const local = merge(LOCAL_DEFAULTS, readJson(path.join(dir, 'local.json')));
  const keep = (v, old) => (v === MASK ? old : v);
  if (Array.isArray(incoming.targets)) def.targets = incoming.targets.map((t) => String(t).trim()).filter(safeTarget);
  const targets = targetsOf(def);
  local.servers = rawServers(local, targetsOf(merge(PROJECT_DEFAULTS, readJson(path.join(dir, 'project.json')))));
  delete local.server;
  const mergeServer = (t, incomingServer) => {
    const old = merge(SERVER_DEFAULTS, local.servers[t]);
    const next = merge(old, incomingServer);
    next.auth.password = keep(incomingServer.auth?.password ?? old.auth.password, old.auth.password);
    local.servers[t] = next;
  };
  if (incoming.local) {
    const l = incoming.local;
    // The settings page edits one target at a time, as local.server.
    if (l.server) mergeServer(targets.includes(target) ? target : targets[0], l.server);
    for (const [t, srv] of Object.entries(l.servers || {})) if (safeTarget(t)) mergeServer(t, srv);
    if (l.source) local.source = merge(local.source, l.source);
    if (l.simulate !== undefined) local.simulate = Boolean(l.simulate);
  }
  for (const k of ['title', 'description', 'git', 'env', 'push', 'templates', 'steps', 'troubleshoot']) if (incoming[k] !== undefined) def[k] = incoming[k];
  def.git.depth = Number(def.git.depth) || 0;
  def.git.submodules = Boolean(def.git.submodules);
  if (Array.isArray(incoming.secrets)) def.secrets = incoming.secrets;
  if (incoming.variables) {
    def.variables = {}; local.values = {};
    for (const [k, v] of Object.entries(incoming.variables)) {
      if (def.secrets.includes(k)) { def.variables[k] = ''; const val = keep(v, cur.local.values[k] ?? ''); if (val) local.values[k] = val; }
      else def.variables[k] = v;
    }
  }
  // Servers for targets that are gone are kept: renaming a target back finds its server again.
  writeFileSync(path.join(dir, 'project.json'), JSON.stringify(def, null, 2) + '\n');
  writeFileSync(path.join(dir, 'local.json'), JSON.stringify(local, null, 2) + '\n');
  return bindTarget(loadProject(name), target);
}

export function createProject(name, from = '_template') {
  const dir = projectDir(name);
  if (existsSync(dir)) throw new Error(`project ${name} already exists`);
  const src = from === '_template' ? TEMPLATE_DIR : projectDir(from);
  cpSync(src, dir, { recursive: true, filter: (p) => !p.endsWith('local.json') });
  const p = readJson(path.join(dir, 'project.json'));
  p.title = p.title && from !== '_template' ? `${p.title} (copy)` : name;
  writeFileSync(path.join(dir, 'project.json'), JSON.stringify(p, null, 2) + '\n');
  return loadProject(name);
}

/** What the browser and the run record may see. */
export function redact(p) {
  const c = JSON.parse(JSON.stringify(p));
  delete c.dir;
  for (const srv of [c.local.server, ...Object.values(c.local.servers || {})]) if (srv?.auth?.password) srv.auth.password = MASK;
  for (const k of c.secrets) if (c.variables[k]) c.variables[k] = MASK;
  return c;
}

export function sourceDir(p) { return path.resolve(ROOT, expandHome(p.local.source.path || `../${p.name}`)); }
export function remoteDir(p) { return p.local.simulate ? path.join(os.tmpdir(), `deploy-${p.name}-${p.target || 'server'}-simulate`) : p.local.server.remoteDir; }

/** Everything a template or a step env may refer to, flat. */
export function vars(p, run) {
  const v = { 'git.url': p.git.url, 'git.branch': p.git.branch, ...p.variables, 'project.name': p.name, 'project.title': p.title, 'target.name': p.target || '', 'server.host': p.local.server.host, 'server.user': p.local.server.user, 'server.remoteDir': remoteDir(p), 'source.dir': sourceDir(p), 'run.id': run?.id || '' };
  // Every target is reachable by name, so the edge's config can name the origin's address.
  for (const t of p.targets || []) {
    const srv = p.local.servers?.[t] || {};
    v[`targets.${t}.host`] = srv.host || ''; v[`targets.${t}.user`] = srv.user || ''; v[`targets.${t}.remoteDir`] = srv.remoteDir || '';
  }
  return v;
}

/** The env every script gets: REMOTE_DIR, PROJECT, each variable upper-cased, then the project's env map rendered. */
export function scriptEnv(p, run) {
  const v = vars(p, run);
  const env = {
    REMOTE_DIR: remoteDir(p), PROJECT: p.name, TARGET: p.target || '', RUN_ID: run?.id || '',
    GIT_URL: p.git.url || '', GIT_BRANCH: p.git.branch || 'main', GIT_KEY: p.git.keyPath || '',
    GIT_DEPTH: String(p.git.depth || 0), GIT_SUBMODULES: p.git.submodules ? '1' : '',
    GIT_TOKEN: p.variables['git.token'] || '',
  };
  for (const [k, val] of Object.entries(p.variables)) env[envName(k)] = String(val ?? '');
  for (const t of p.targets || []) env[`TARGET_${envName(t)}_HOST`] = p.local.servers?.[t]?.host || '';
  for (const [k, t] of Object.entries(p.env || {})) env[k] = render(t, v);
  return env;
}

export function validate(p) {
  const errs = [];
  const kinds = new Set((p.steps || []).map((x) => x.kind));
  if (kinds.has('fetch')) {
    if (!p.git.url) errs.push('no repository set (Settings → Project)');
    if (!p.git.branch) errs.push('no branch set (Settings → Project)');
  }
  for (const st of p.steps || []) if (st.target && !p.targets.includes(st.target)) errs.push(`step "${st.id || st.title}" runs on target "${st.target}", which the project does not have`);
  if (!p.local.simulate) {
    // Only the targets some step actually runs on need a server.
    const used = new Set((p.steps || []).filter((x) => x.side !== 'local').map((x) => (p.targets.includes(x.target) ? x.target : p.targets[0])));
    for (const t of p.targets.filter((x) => used.has(x))) {
      const s = p.local.servers[t];
      const pre = p.targets.length > 1 ? `${t}: ` : '';
      if (!s.host) errs.push(`${pre}server host is empty`);
      if (!s.user) errs.push(`${pre}server user is empty`);
      if (!s.remoteDir) errs.push(`${pre}remote directory is empty`);
      if (s.auth.type === 'password' && !s.auth.password) errs.push(`${pre}auth is password but none is set`);
      if (s.auth.type === 'key' && !existsSync(expandHome(s.auth.keyPath || ''))) errs.push(`${pre}key not found: ${s.auth.keyPath}`);
    }
  }
  if (kinds.has('push') && !existsSync(sourceDir(p))) errs.push(`source path does not exist: ${sourceDir(p)}`);
  if (!p.steps.length) errs.push('the project has no steps');
  return errs;
}

// ── editable files ──────────────────────────────────────────────────────────
// remote/, templates/ and the excludes file are the project's; nothing else is
// reachable from the browser, and no path may leave the project directory.
export function listFiles(p) {
  const out = [];
  const walk = (rel) => { const abs = path.join(p.dir, rel); if (!existsSync(abs)) return; for (const n of readdirSync(abs).sort()) { const r = path.posix.join(rel, n); if (statSync(path.join(p.dir, r)).isDirectory()) walk(r); else out.push(r); } };
  walk('remote'); walk('templates');
  if (existsSync(path.join(p.dir, p.push.excludes))) out.push(p.push.excludes);
  return out;
}
function filePath(p, rel) {
  const r = path.posix.normalize(String(rel));
  const ok = r.startsWith('remote/') || r.startsWith('templates/') || r === p.push.excludes;
  if (!ok || r.includes('..')) throw new Error('that path is not editable');
  return path.join(p.dir, r);
}
export function readProjectFile(p, rel) { const f = filePath(p, rel); return existsSync(f) ? readFileSync(f, 'utf8') : null; }
export function writeProjectFile(p, rel, text) { const f = filePath(p, rel); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, text); }
