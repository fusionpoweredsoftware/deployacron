// How every command reaches the server. One place builds the argv, so ssh and
// rsync and the troubleshooter's tmux calls all agree on the key, the port and
// the connection-sharing socket.

import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { ROOT, expandHome } from './projects.mjs';

/**
 * Where the shared ssh connection's socket lives.
 *
 * Not under the project: a unix socket path is capped at 104 bytes on macOS
 * and 108 on Linux, %C alone is 40 of them, and a checkout a few directories
 * deep blows the limit — ssh then refuses every connection with "ControlPath
 * too long", which reads as the server being unreachable. So it goes in the
 * system temp directory, in a per-user directory named after this checkout so
 * two deployers cannot share a socket by accident.
 */
const SOCKET_DIR = (() => {
  const tag = crypto.createHash('sha1').update(`${os.userInfo().username}:${ROOT}`).digest('hex').slice(0, 8);
  for (const base of [os.tmpdir(), '/tmp']) {
    const dir = path.join(base, `dpl-${tag}`);
    // %C is 40 characters; leave room for it and the separator.
    if (dir.length + 42 > 100) continue;
    try { mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir; } catch {}
  }
  return null;   // nowhere short enough: multiplexing is dropped, below
})();

/**
 * A remote path, quoted — except a leading `~/`, which is left bare so the
 * remote shell still expands it.
 *
 * Quoting the tilde is how `~/.ssh/id_gh` becomes a test for a file literally
 * called `~`, and the deploy key "is not readable on this server" when it is
 * sitting right there.
 */
export function qPath(p) {
  const s = String(p ?? '');
  if (s === '~') return '~';
  if (s.startsWith('~/')) return '~/' + q(s.slice(2));
  return q(s);
}

/** POSIX single-quote, so remote command strings survive one shell. */
export function q(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** `env K=V K=V` prefix for a remote script, every value quoted. */
export function envPrefix(env) {
  const parts = Object.entries(env || {}).filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${q(v)}`);
  return parts.length ? `env ${parts.join(' ')} ` : '';
}

function commonOpts(cfg) {
  const s = cfg.server;
  const opts = [
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=15',
    '-o', 'ServerAliveInterval=20',
    '-p', String(s.port || 22),
  ];
  // One TCP connection shared by every hop of a run, and by the
  // troubleshooter's polls — a fresh handshake each time is slow and noisy in
  // the auth log. Dropped entirely rather than risking a path ssh will reject.
  if (SOCKET_DIR) opts.push('-o', 'ControlMaster=auto', '-o', `ControlPath=${path.join(SOCKET_DIR, '%C')}`, '-o', 'ControlPersist=10m');
  if (s.auth.type === 'key' && s.auth.keyPath) opts.push('-i', expandHome(s.auth.keyPath), '-o', 'IdentitiesOnly=yes');
  if (s.auth.type === 'password') opts.push('-o', 'PubkeyAuthentication=no', '-o', 'NumberOfPasswordPrompts=1');
  return opts;
}

export function target(cfg) {
  const { user, host } = cfg.server;
  // ssh answers an incomplete destination with its whole usage block, which
  // says nothing about which field is empty. Refuse before that happens.
  const missing = [!user && 'user', !host && 'host'].filter(Boolean);
  if (missing.length) throw new Error(`no ${missing.join(' and ')} for the server — fill it in under Settings → Server`);
  return `${user}@${host}`;
}

/**
 * The command and args to run `script` (a shell string) on the server.
 * `tty` allocates a pseudo-terminal, which is what makes docker, npm and
 * friends keep their colors — and what the interactive attach needs.
 */
export function sshCommand(cfg, script, { tty = true } = {}) {
  const args = [...(tty ? ['-tt'] : []), ...commonOpts(cfg), target(cfg), script]
    .filter((a) => a !== undefined && a !== null && a !== '');   // an empty argv entry is another way to get the usage block
  return wrapPassword(cfg, 'ssh', args);
}

/** `ssh …` as you would type it, for showing in a log or an error. */
export function sshDisplay(cfg, script) {
  const c = sshCommand(cfg, script, { tty: false });
  return [c.cmd, ...c.args].map((a) => (/[\s'"$]/.test(a) ? JSON.stringify(a) : a)).join(' ');
}

/** rsync argv pushing `src` (a directory, trailing slash semantics kept) to `dest` on the server. */
export function rsyncCommand(cfg, src, dest, { excludesFile, del = true } = {}) {
  const ssh = ['ssh', ...commonOpts(cfg)].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
  const args = ['-az', '--human-readable', '--info=stats1,progress2', '--no-inc-recursive', '-e', ssh];
  if (del) args.push('--delete');
  if (excludesFile) args.push(`--exclude-from=${excludesFile}`);
  args.push(src, `${target(cfg)}:${dest}`);
  return wrapPassword(cfg, 'rsync', args);
}

/** Password auth goes through sshpass, reading the password from the environment, never argv. */
function wrapPassword(cfg, cmd, args) {
  if (cfg.server.auth.type === 'password') {
    return { cmd: 'sshpass', args: ['-e', cmd, ...args], env: { SSHPASS: cfg.server.auth.password } };
  }
  return { cmd, args, env: {} };
}
