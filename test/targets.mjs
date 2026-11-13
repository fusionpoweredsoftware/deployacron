// Targets: a project with two servers, each step bound to its own.
//
// Builds a throwaway project in a temp checkout of projects/, so nothing here
// touches a real one.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let bad = 0;
const check = (ok, what) => { if (ok) console.log(`  ✓ ${what}`); else { console.error(`  ✗ ${what}`); bad++; } };

const mod = await import('../lib/projects.mjs');
const { PROJECTS_DIR, loadProject, bindTarget, saveProject, validate, vars, scriptEnv, remoteDir } = mod;
const name = `zz-targets-test-${process.pid}`;
const dir = path.join(PROJECTS_DIR, name);
mkdirSync(dir, { recursive: true });
try {
  writeFileSync(path.join(dir, 'project.json'), JSON.stringify({
    title: 'targets test', targets: ['edge', 'origin'],
    steps: [
      { id: 'a', kind: 'command', side: 'remote', target: 'origin', run: 'true' },
      { id: 'b', kind: 'command', side: 'remote', target: 'edge', run: 'true' },
      { id: 'c', kind: 'command', side: 'remote', run: 'true' },
    ],
  }));
  // A pre-targets local.json: `server` is read as the first target's.
  writeFileSync(path.join(dir, 'local.json'), JSON.stringify({
    server: { host: 'me@198.51.100.1:2222', auth: { type: 'agent' } },
    servers: { origin: { host: '198.51.100.2', user: 'root', auth: { type: 'agent' } } },
  }));

  const p = loadProject(name);
  check(p.target === 'edge', 'the first target is the default');
  check(p.local.server.host === '198.51.100.1' && p.local.server.user === 'me' && p.local.server.port === 2222, 'a legacy `server` becomes the first target, destination split');
  const o = bindTarget(p, 'origin');
  check(o.local.server.host === '198.51.100.2' && o.local.server.remoteDir === `/root/${name}`, 'bindTarget swaps in that target\'s server, with its default directory');
  check(o.troubleshoot.tmuxSession === `${name}-troubleshoot-origin` && o.troubleshoot.baseSession === `${name}-troubleshoot`, 'each target gets its own server-side troubleshooter session');
  check(bindTarget(p, 'nope').target === 'edge', 'an unknown target falls back to the first');
  check(vars(o)['targets.edge.host'] === '198.51.100.1' && vars(p)['targets.origin.host'] === '198.51.100.2', 'every target\'s address is a variable on every target');
  check(scriptEnv(o).TARGET === 'origin' && scriptEnv(o).TARGET_EDGE_HOST === '198.51.100.1', 'scripts get TARGET and TARGET_<NAME>_HOST');
  check(validate(p).length === 0, `a complete two-target project validates (${validate(p).join('; ')})`);

  // Saving from the Server page writes only the target in view.
  saveProject(name, { local: { server: { host: '198.51.100.9' } } }, 'origin');
  const local = JSON.parse(readFileSync(path.join(dir, 'local.json'), 'utf8'));
  check(local.servers.origin.host === '198.51.100.9' && local.servers.edge.host === 'me@198.51.100.1:2222', 'saving one target leaves the other as it was');
  check(local.server === undefined, 'the legacy block is migrated into servers');

  const { buildSteps } = await import('../lib/pipeline.mjs');
  const steps = buildSteps(loadProject(name));
  check(steps.map((s) => s.target).join(',') === ',origin,edge,edge', 'steps carry their target, defaulting to the first');

  // A step naming a target the project does not have is a problem, not a silent default.
  const pj = JSON.parse(readFileSync(path.join(dir, 'project.json'), 'utf8'));
  pj.steps.push({ id: 'd', kind: 'command', side: 'remote', target: 'ghost', run: 'true' });
  writeFileSync(path.join(dir, 'project.json'), JSON.stringify(pj));
  check(validate(loadProject(name)).some((e) => /ghost/.test(e)), 'an unknown step target is reported');

  // A single-target project behaves as before.
  writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ steps: [{ kind: 'command', run: 'true' }] }));
  const single = loadProject(name);
  check(single.targets.join() === 'server' && single.troubleshoot.tmuxSession === `${name}-troubleshoot`, 'no targets: one, "server", with the old session name');
  check(remoteDir({ ...single, local: { ...single.local, simulate: true } }).includes(`${name}-server-simulate`), 'simulate directories are per target');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
if (bad) { console.error(`\n${bad} targets check${bad === 1 ? '' : 's'} failed.`); process.exit(1); }
