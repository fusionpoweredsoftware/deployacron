// The generic engine: a project's steps, run in order. Four kinds of step:
//
//   push      rsync the source to the server, then the project's remote/
//             scripts and rendered templates to <remoteDir>/.deploy/
//   script    run one of the project's remote/ scripts, on either side
//   command   run a shell string, on either side, templated
//   report    render the templates into the run and list the "- [ ]" items
//
// Every script and command gets the project's env (see projects.scriptEnv).
//
// A step runs on one of the project's targets (def.target, default the first);
// its ctx.project is the project bound to that target, so "the server" below
// always means that step's server.

import path from 'node:path';
import { writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { ROOT, sourceDir, remoteDir, vars, scriptEnv, listFiles, bindTarget } from './projects.mjs';
import { render } from './template.mjs';
import { sshCommand, rsyncCommand, envPrefix, q, qPath } from './ssh.mjs';
import { which } from './exec.mjs';
import { control } from './troubleshoot.mjs';

const ENGINE_REMOTE = path.join(ROOT, 'lib', 'remote');   // troubleshoot.sh, pushed with every project

/** Run a shell string on `side`, output to that pane. Locally, and in simulate mode, it is plain bash. */
async function sh(ctx, side, script, opts = {}) {
  const { run, step, project: p } = ctx;
  if (side === 'local' || p.local.simulate) {
    return run.exec(step, side, 'bash', ['-c', script], { display: `${p.local.simulate && side === 'remote' ? '(simulate) ' : ''}${script}`, cwd: opts.cwd, ...opts });
  }
  const c = sshCommand(p.local, script, { tty: opts.tty !== false });
  return run.exec(step, 'remote', c.cmd, c.args, { env: c.env, display: `ssh ${p.local.server.user}@${p.local.server.host} ${script}`, ...opts });
}

/** Render every template into the run dir; returns the dir. */
function renderTemplates(ctx) {
  const { run, project: p } = ctx;
  const out = path.join(run.dir, 'rendered');
  mkdirSync(out, { recursive: true });
  const v = vars(p, run);
  const files = [];
  for (const t of p.templates || []) {
    const src = path.join(p.dir, 'templates', t);
    if (!existsSync(src)) { run.note('local', `template missing: templates/${t}`, ctx.step); continue; }
    writeFileSync(path.join(out, path.basename(t)), render(readFileSync(src, 'utf8'), v));
    files.push(path.basename(t));
  }
  return { dir: out, files };
}

/**
 * remote/ scripts, the engine's own scripts and the rendered templates →
 * <remoteDir>/.deploy/, as a tar down the ssh connection. Deliberately not
 * rsync: the code itself is fetched by the server from git, so this handful of
 * files is the only thing that travels, and asking for rsync on both ends to
 * move it would be a dependency bought for nothing.
 */
async function pushDeployDir(ctx) {
  const { run, step, project: p } = ctx;
  (run.shipped ||= new Set()).add(p.target);
  const dest = remoteDir(p).replace(/\/+$/, '') + '/.deploy/';
  const staging = path.join(run.dir, 'deploy-dir');
  mkdirSync(staging, { recursive: true });
  const { dir: rendered } = renderTemplates(ctx);
  const copy = async (from, label) => run.exec(step, 'local', 'bash', ['-c', `cp -R ${q(from + '/.')} ${q(staging)}`], { display: `stage ${label}` });
  if (existsSync(path.join(p.dir, 'remote'))) await copy(path.join(p.dir, 'remote'), 'remote/');
  await copy(ENGINE_REMOTE, 'engine scripts');
  await copy(rendered, 'rendered templates');
  if (p.local.simulate) {
    mkdirSync(dest, { recursive: true });
    return run.exec(step, 'local', 'bash', ['-c', `cp -R ${q(staging + '/.')} ${q(dest)}`], { display: `(simulate) copy .deploy → ${dest}` });
  }
  const c = sshCommand(p.local, `mkdir -p ${qPath(dest)} && tar xzf - -C ${qPath(dest)}`, { tty: false });
  const tar = `tar czf - -C ${q(staging)} .`;
  return run.exec(step, 'local', 'bash', ['-c', `${tar} | ${[c.cmd, ...c.args.map(q)].join(' ')}`], { env: c.env, display: `ship .deploy → ${dest}` });
}

const KINDS = {
  async push(ctx) {
    const { run, step, project: p } = ctx;
    const src = sourceDir(p).replace(/\/+$/, '') + '/';
    const dest = remoteDir(p).replace(/\/+$/, '') + '/';
    const excludes = path.join(p.dir, p.push.excludes || 'rsync-excludes.txt');
    const del = p.push.delete !== false;
    let r;
    if (p.local.simulate) {
      r = await run.exec(step, 'local', 'rsync', ['-a', ...(del ? ['--delete'] : []), ...(existsSync(excludes) ? [`--exclude-from=${excludes}`] : []), '--info=stats1', src, dest], { display: `(simulate) rsync ${src} → ${dest}` });
    } else {
      await sh(ctx, 'remote', `mkdir -p ${qPath(dest)}`, { tty: false });
      const c = rsyncCommand(p.local, src, dest, { excludesFile: existsSync(excludes) ? excludes : null, del });
      r = await run.exec(step, 'local', c.cmd, c.args, { env: c.env });
    }
    if (r.code !== 0) return r;
    return pushDeployDir(ctx);
  },
  /** The server pulls the branch itself. */
  async fetch(ctx) {
    const { project: p, def } = ctx;
    const env = { ...scriptEnv(p, ctx.run), ...renderMap(def.env, p, ctx.run) };
    const script = p.local.simulate ? path.join(ENGINE_REMOTE, 'fetch.sh') : `${remoteDir(p)}/.deploy/fetch.sh`;
    return sh(ctx, 'remote', `${envPrefix(env)}bash ${qPath(script)}`);
  },
  async script(ctx) {
    const { project: p, def } = ctx;
    const env = { ...scriptEnv(p, ctx.run), ...renderMap(def.env, p, ctx.run) };
    if (def.side === 'local' || p.local.simulate) {
      const file = def.side === 'local' ? path.join(p.dir, 'remote', def.run) : path.join(remoteDir(p), '.deploy', def.run);
      return sh(ctx, def.side, `${envPrefix(env)}bash ${qPath(file)}`, { cwd: def.side === 'local' ? sourceDir(p) : undefined });
    }
    return sh(ctx, 'remote', `${envPrefix(env)}bash ${qPath(remoteDir(p) + '/.deploy/' + def.run)}`);
  },
  async command(ctx) {
    const { project: p, def } = ctx;
    const env = { ...scriptEnv(p, ctx.run), ...renderMap(def.env, p, ctx.run) };
    const cmd = render(def.run, vars(p, ctx.run));
    if (def.side === 'local') return sh(ctx, 'local', cmd, { env, cwd: sourceDir(p) });
    return sh(ctx, 'remote', `${envPrefix(env)}bash -c ${q(cmd)}`);
  },
  async report(ctx) {
    const { run, step, project: p } = ctx;
    const { dir, files } = renderTemplates(ctx);
    let items = 0;
    for (const f of files) {
      const text = readFileSync(path.join(dir, f), 'utf8');
      const todos = text.split('\n').filter((l) => /^- \[ \]/.test(l)).length;
      items += todos;
      if (/\.md$/i.test(f) && todos) {
        writeFileSync(path.join(run.dir, 'NOT-DONE.md'), text);
        run.log('local', `\x1b[35m□\x1b[0m ${todos} manual items in \x1b[1m${f}\x1b[0m — in this run, and in ${remoteDir(p)}/.deploy/${f} on the server\r\n`, step);
        for (const l of text.split('\n')) if (l.startsWith('## ')) run.log('local', `  \x1b[1m${l.slice(3)}\x1b[0m\r\n`, step);
      } else run.log('local', `rendered \x1b[1m${f}\x1b[0m\r\n`, step);
    }
    if (!files.length) run.note('local', 'no templates to render', step);
    const failed = run.meta.steps.some((s) => s.status === 'failed');
    return { code: 0, warn: !failed && items > 0 };
  },
  async preflight(ctx) {
    const { run, step, project: p } = ctx;
    const from = (p.steps || []).some((x) => x.kind === 'fetch') ? `${p.git.url}#${p.git.branch}` : sourceDir(p);
    run.note('local', `${p.title || p.name} · run ${run.id} — ${from} → ${p.local.server.user}@${p.local.server.host}:${remoteDir(p)}${p.local.simulate ? ' (simulate)' : ''}`, step);
    let bad = false;
    const needsRsync = (p.steps || []).some((x) => x.kind === 'push');
    for (const tool of ['ssh', ...(needsRsync ? ['rsync'] : []), ...(p.local.server.auth.type === 'password' ? ['sshpass'] : []), 'tmux']) {
      const found = await which(tool);
      if (found) run.log('local', `\x1b[32m✓\x1b[0m ${tool}  \x1b[2m${found}\x1b[0m\r\n`, step);
      else { run.log('local', `\x1b[31m✗\x1b[0m ${tool} not found on this machine${tool === 'tmux' ? ' (only the troubleshooter needs it)' : ''}\r\n`, step); if (tool !== 'tmux' && !p.local.simulate) bad = true; }
    }
    if (bad) return { code: 1 };
    // The .deploy dir goes up first so a remote preflight script can run before the push.
    const r = await pushDeployDir(ctx);
    if (r.code !== 0) return r;
    if (ctx.def.run) return KINDS.script(ctx);
    return { code: 0 };
  },
};

function renderMap(map, p, run) { const v = vars(p, run), out = {}; for (const [k, t] of Object.entries(map || {})) out[k] = render(String(t), v); return out; }

/**
 * Step zero, always: both troubleshooters up before anything else happens.
 * A deploy with nobody to ask when it goes wrong is the one we do not run.
 */
export const TROUBLESHOOTERS_STEP = {
  id: 'troubleshooters', title: 'Troubleshooters', side: 'local', always: false,
  async run(ctx) {
    const { run, step, project: p0 } = ctx;
    // One here; one on every target a step runs on.
    const used = [...new Set((p0.steps || []).filter((x) => x.side !== 'local').map((x) => (p0.targets.includes(x.target) ? x.target : p0.targets[0])))];
    const sides = [['local', p0.targets[0]], ...used.map((t) => ['remote', t])];
    let localOk = false; const down = [];
    for (const [side, t] of sides) {
      const p = bindTarget(p0, t);
      const label = side === 'local' ? 'local  ' : (p0.targets.length > 1 ? `${t} ` : 'remote ');
      const sess = side === 'local' ? `${p.troubleshoot.baseSession}-local` : p.troubleshoot.tmuxSession;
      const st = await control(p, side, 'status');
      let ok = /running/.test(st.out);
      if (ok) run.log('local', `\x1b[32m✓\x1b[0m ${label} troubleshooter already running (tmux: ${sess})\r\n`, step);
      else {
        run.log('local', `\x1b[36m…\x1b[0m ${label} starting \x1b[1m${p.troubleshoot.command}\x1b[0m in tmux\r\n`, step);
        const r = await control(p, side, 'start', { COLS: '160', ROWS: '45' });
        ok = r.code === 0 && /started|already/.test(r.out);
        if (ok) run.log('local', `\x1b[32m✓\x1b[0m ${label} troubleshooter up\r\n`, step);
        else run.log('local', `\x1b[${side === 'local' ? '31' : '33'}m${side === 'local' ? '✗' : '!'}\x1b[0m ${label} troubleshooter did not start:\r\n${r.out.trim().split('\n').map((l) => '    ' + l).join('\r\n')}\r\n`, step);
      }
      if (side === 'local') localOk = ok; else if (!ok) down.push(t);
    }
    if (!localOk) {
      run.log('local', `\x1b[31mNo local troubleshooter, no deploy.\x1b[0m It is the one that can work out everything else. Is tmux installed here, and is \x1b[1m${p0.troubleshoot.command}\x1b[0m on PATH? Open Troubleshoot and press Start to see it fail in place.\r\n`, step);
      return { code: 1 };
    }
    if (down.length) {
      run.log('local', `\x1b[33m!\x1b[0m the remote troubleshooter is not up on ${down.join(', ')} — continuing, since the local one can get it there (tmux and ${p0.troubleshoot.command} on the server; see Troubleshoot).\r\n`, step);
      return { code: 0, warn: true };
    }
    run.note('local', 'every troubleshooter is up — open Troubleshoot to talk to them; the feeds of this run go to them when it ends', step);
    return { code: 0 };
  },
};

/** Remote kinds that read <remoteDir>/.deploy/ and so need it shipped to their target first. */
const NEEDS_DEPLOY_DIR = new Set(['fetch', 'script', 'command']);

/** The project's steps as the runner wants them, with step zero in front. */
export function buildSteps(p) {
  return [TROUBLESHOOTERS_STEP, ...(p.steps || []).map((def, i) => {
    const kind = KINDS[def.kind] ? def.kind : 'command';
    const side = def.side === 'local' ? 'local' : 'remote';
    const target = p.targets.includes(def.target) ? def.target : p.targets[0];
    return {
      id: def.id || `step${i + 1}`, title: def.title || def.id || def.kind, side, target, always: !!def.always,
      run: async (ctx) => {
        const bound = { ...ctx, project: bindTarget(ctx.project, target), def: { ...def, kind } };
        // The first remote step on a target that has not had .deploy/ shipped
        // this run ships it, so a project need not start every target with a preflight.
        if (side === 'remote' && NEEDS_DEPLOY_DIR.has(kind) && !ctx.run.shipped?.has(target)) {
          const r = await pushDeployDir(bound);
          if (r.code !== 0) return r;
        }
        return KINDS[kind](bound);
      },
    };
  })];
}
