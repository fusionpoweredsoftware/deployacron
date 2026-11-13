// Spawning, with the output going somewhere useful. Everything the deployer
// runs — local or over ssh — goes through here, so colors are forced the same
// way and exits are reported the same way.

import { spawn } from 'node:child_process';
import os from 'node:os';

const COLOR_ENV = { FORCE_COLOR: '1', CLICOLOR_FORCE: '1', TERM: 'xterm-256color', COLUMNS: '160' };

/**
 * Run a command, streaming stdout+stderr chunks to `onData`. Resolves with the
 * exit code (or the signal name); never rejects on a non-zero exit, because a
 * failing step is a result, not an exception.
 */
export function run(cmd, args, { cwd, env = {}, onData, stdin, input, onSpawn } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: { ...process.env, ...COLOR_ENV, ...env },
        stdio: [stdin ? 'pipe' : (input != null ? 'pipe' : 'ignore'), 'pipe', 'pipe'],
      });
    } catch (e) {
      onData?.(`\x1b[31m${cmd}: ${e.message}\x1b[0m\r\n`);
      return resolve({ code: 127, error: e });
    }
    onSpawn?.(child);
    child.on('error', (e) => {
      const hint = e.code === 'ENOENT' ? ` — ${cmd} is not installed or not on PATH` : '';
      onData?.(`\x1b[31m${cmd}: ${e.message}${hint}\x1b[0m\r\n`);
    });
    child.stdout.on('data', (d) => onData?.(d.toString('utf8')));
    child.stderr.on('data', (d) => onData?.(d.toString('utf8')));
    if (input != null) { child.stdin.end(input); }
    child.on('close', (code, signal) => resolve({ code: code ?? (signal ? 128 : 1), signal }));
  });
}

/** Whether a program is on PATH, by asking the shell. */
export async function which(name) {
  let out = '';
  const { code } = await run(os.platform() === 'win32' ? 'where' : 'which', [name], { onData: (d) => (out += d) });
  return code === 0 ? out.trim().split('\n')[0] : null;
}
