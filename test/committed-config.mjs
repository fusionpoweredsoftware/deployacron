// Guards the committed project definitions against a value that only made
// sense on somebody's machine.
//
// This is not hypothetical: a local bare repo used while testing the fetch
// step was committed as computatron's remote, and the next person to press
// Test connection was told the server could not reach "/tmp/gitprobe/repo.git".
// A committed project.json is shared, so a stray value in it is everyone's.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const DIR = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'projects');
const LOOKS_LOCAL = [
  [/^\/tmp\//, 'a path under /tmp'],
  [/^\/(Users|home)\//, "somebody's home directory"],
  [/localhost|127\.0\.0\.1|0\.0\.0\.0/, 'a loopback address'],
  [/\.local(\/|$)/, 'a .local hostname'],
];
let bad = 0;
const fail = (where, why) => { console.error(`  ✗ ${where}: ${why}`); bad++; };

for (const name of readdirSync(DIR).filter((n) => existsSync(path.join(DIR, n, 'project.json')))) {
  const p = JSON.parse(readFileSync(path.join(DIR, name, 'project.json'), 'utf8'));
  const url = p.git?.url || '';
  for (const [re, why] of LOOKS_LOCAL) if (re.test(url)) fail(`${name}/project.json git.url`, `${why} — ${url}`);
  // The troubleshooter is the point of the thing; a plain shell means somebody
  // swapped it out to test without ollama and forgot to put it back.
  const cmd = p.troubleshoot?.command || '';
  if (name !== '_template' && /^(bash|sh|zsh)$/.test(cmd.trim())) fail(`${name}/project.json troubleshoot.command`, `left as "${cmd}"`);
  // A secret must never be in the committed half.
  for (const k of p.secrets || []) if (p.variables?.[k]) fail(`${name}/project.json variables.${k}`, 'a secret has a value in the committed file');
  if (p.local) fail(`${name}/project.json`, 'holds a "local" block — that belongs in local.json, which is gitignored');
}
if (bad) { console.error(`\n${bad} problem${bad === 1 ? '' : 's'} in the committed project definitions.`); process.exit(1); }
console.log('  ✓ committed project definitions carry no machine-local values');
