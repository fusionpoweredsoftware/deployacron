// The troubleshooter: the project's command (default `ollama launch claude`)
// inside tmux, on either side.
//
// tmux is the transport. The command runs in a detached session that outlives
// the browser and the ssh connection; the browser *attaches* to it through a
// WebSocket-backed terminal, so typing goes straight in, and the screen can be
// read with capture-pane. Locally the attach borrows a pty from `script`; a
// resize is a detach and a reattach at the new size.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, remoteDir } from './projects.mjs';
import { sshCommand, envPrefix, q, qPath } from './ssh.mjs';
import { run as exec } from './exec.mjs';

const SCRIPT = path.join(ROOT, 'lib', 'remote', 'troubleshoot.sh');

// Three panes, one mechanism. Two run the troubleshooter — here and there —
// and the third is a plain login shell on the server, which is the whole of
// the Remote tab: an ssh you can keep, because the session outlives the tab.
export const TARGETS = {
  local:  { onServer: false, suffix: '-local', command: (p) => p.troubleshoot.command || 'ollama launch claude' },
  remote: { onServer: true,  suffix: '',       command: (p) => p.troubleshoot.command || 'ollama launch claude' },
  shell:  { onServer: true,  suffix: '-shell', command: () => '${SHELL:-bash} -l' },
};
export const isTarget = (t) => Object.hasOwn(TARGETS, t);
const isLocal = (p, side) => !TARGETS[side].onServer || p.local.simulate;
// The local troubleshooter is one per project, whichever target is in view;
// the server-side panes are one per target (bindTarget names them).
const session = (p, side) => (TARGETS[side].onServer ? `${p.troubleshoot.tmuxSession}${TARGETS[side].suffix}` : `${p.troubleshoot.baseSession || p.troubleshoot.tmuxSession}${TARGETS[side].suffix}`);
// Locally the troubleshooter starts in the deployer's own directory (it can read
// runs/, the project, this code); its context files go under .deploy/<project>/.
const workdir = (p, side) => (isLocal(p, side) ? ROOT : remoteDir(p));
const deployDir = (p, side) => (isLocal(p, side) ? path.join(ROOT, '.deploy', p.name) : path.join(remoteDir(p), '.deploy'));
/** The command a pane runs, for the UI to show. */
export const commandFor = (p, side) => TARGETS[side].command(p);

export async function control(p, side, action, extra = {}) {
  // A clear sentence beats ssh's usage block when a field is empty.
  if (!isLocal(p, side)) { const bad = serverProblem(p); if (bad) return { code: 2, out: bad }; }
  const env = { SESSION: session(p, side), WORKDIR: workdir(p, side), DEPLOY_DIR: deployDir(p, side), COMMAND: TARGETS[side].command(p), ...extra };
  let out = '';
  const onData = (d) => (out += d);
  if (isLocal(p, side)) {
    const res = await exec('bash', ['-c', `${envPrefix(env)}bash ${qPath(SCRIPT)} ${action}`], { onData });
    return { code: res.code, out };
  }
  // The script goes down the pipe with the command, rather than being read from
  // a copy a deploy left on the server. The troubleshooters are meant to be up
  // *before* the first deploy — requiring one to have run already is how you
  // get "no such file or directory" from the thing you reach for when nothing
  // works.
  const c = sshCommand(p.local, `${envPrefix(env)}bash -s ${action}`, { tty: false });
  const res = await exec(c.cmd, c.args, { env: c.env, onData, input: readFileSync(SCRIPT, 'utf8') });
  return { code: res.code, out };
}

/** Why the server cannot be reached at all, as a sentence, or null. */
export function serverProblem(p) {
  const s = p.local.server;
  if (!s.host) return 'No server host — fill it in under Settings → Server.';
  if (!s.user) return `No ssh user for ${s.host} — fill it in under Settings → Server. (A destination like "me@${s.host}" goes in the two boxes, not one.)`;
  if (s.auth.type === 'password' && !s.auth.password) return 'Password auth is selected but no password is set.';
  return null;
}

export function attach(p, side, { cols = 120, rows = 36, onData, onExit }) {
  { const bad = !isLocal(p, side) && serverProblem(p); if (bad) { setTimeout(() => { onData?.(Buffer.from(`\r\n\x1b[31m${bad}\x1b[0m\r\n`)); onExit?.(2); }, 0); return { write() {}, resize() {}, kill() {} }; } }
  const name = session(p, side);
  const target = q('=' + name + ':');
  const tmuxCmd = `tmux -u -C attach-session -t ${q('=' + name)}`;
  let cmd, args, env = {};
  if (isLocal(p, side)) { cmd = 'bash'; args = ['-c', tmuxCmd]; }
  else ({ cmd, args, env } = sshCommand(p.local, tmuxCmd, { tty: false }));
  const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const say = (line) => { try { child.stdin.write(line + '\n'); } catch {} };
  const show = (text) => onData?.(Buffer.from(text));

  // Input goes as hex bytes (send-keys -H, tmux ≥ 3.1) — nothing to quote.
  // On an older tmux, fall back to Escape/C-x plus literal text. Which one
  // this tmux is gets settled by a probe below rather than by losing the first
  // keystroke to find out.
  let hex = process.env.DEPLOYER_TMUX_NO_HEX !== '1';
  let lastSize = [cols, rows];
  let sizeFmt = 'x';
  // Both: refresh-client tells tmux the size of *this* client, resize-window
  // fixes the window itself so another client cannot move it.
  // Not every tmux has all three. What it rejects once, it is not asked again.
  let canPin = true, canResizeWindow = true;
  const resize = (c, r) => {
    c = Number(c) || 120; r = Number(r) || 36;
    say(`refresh-client -C ${sizeFmt === 'x' ? `${c}x${r}` : `${c},${r}`}`);
    if (canPin) say(`set-option -t ${q(name + ':')} window-size manual`);
    if (canResizeWindow) say(`resize-window -t ${q('=' + name + ':')} -x ${c} -y ${r}`);
  };
  const sendBytes = (bytes) => {
    if (hex) return say(`send-keys -t ${target} -H ${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join(' ')}`);
    for (const part of keysFor(bytes)) say(`send-keys -t ${target} ${part}`);
  };

  // The protocol: %begin … lines … %end (or %error) per command; %output for
  // pane bytes. A failed command's message is *inside* its block, so blocks are
  // buffered and shown only when they end in %error.
  let buf = '', block = null;
  child.stdout.on('data', (d) => {
    buf += d.toString('latin1');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (line.startsWith('%output ')) { const sp = line.indexOf(' ', 8); onData?.(Buffer.from(stripMouseModes(unescapeTmux(line.slice(sp + 1))), 'latin1')); }
      else if (line.startsWith('%begin ')) block = [];
      else if (line.startsWith('%end ')) block = null;
      else if (line.startsWith('%error ')) {
        const msg = (block || []).join(' ').trim() || line.slice(7); block = null;
        switch (tmuxErrorAction(msg)) {
          case 'no-window-size':   canPin = false; break;             // older tmux: nothing to say about it
          case 'no-resize-window': canResizeWindow = false; break;
          case 'no-hex':           if (hex) { hex = false; show('\r\n\x1b[2m[this tmux has no send-keys -H; using key names]\x1b[0m\r\n'); } break;
          case 'size-format':      if (sizeFmt === 'x') { sizeFmt = ','; resize(...lastSize); } break;
          default:                 show(`\r\n\x1b[31mtmux: ${msg}\x1b[0m\r\n`);
        }
      }
      else if (line.startsWith('%exit')) show('\r\n\x1b[2m[session ended]\x1b[0m\r\n');
      else if (block) block.push(line);
      // %session-changed, %window-* and friends are bookkeeping.
    }
  });
  child.stderr.on('data', (d) => show(`\r\n\x1b[31m${d.toString()}\x1b[0m`));
  child.on('error', (e) => show(`\r\n\x1b[31m${cmd}: ${e.message}\x1b[0m\r\n`));
  child.on('close', (code) => onExit?.(code));
  // Size the window to the browser's terminal, then paint what is already on
  // screen: control mode only streams what is printed from now on, and a
  // full-screen app redraws itself on the resize anyway.
  resize(cols, rows);
  // An empty send-keys -H presses nothing on a tmux that has the flag, and
  // fails on one that does not — so the answer arrives before you type.
  if (hex) say(`send-keys -t ${target} -H`);
  // Paint what is already on screen: control mode streams only what is printed
  // from now on. After the resize has landed, so the capture is the new shape,
  // and with the window's trailing blank rows trimmed — they would otherwise
  // push the prompt down the terminal.
  setTimeout(() => {
    control(p, side, 'screen').then((r) => {
      const lines = r.out.replace(/\r?\n$/, '').split(/\r?\n/);
      let alt = false, cur = null;
      if (/^ALT [01]$/.test(lines[0] || '')) alt = lines.shift().endsWith('1');
      // Adopt the pane's modes before anything else. Without this the browser's
      // terminal is in whatever state it started in: no mouse reporting where
      // the program expects it (so the pointer stays an I-beam over one pane
      // and an arrow over another), and arrow keys sending the wrong bytes.
      if (/^MODES /.test(lines[0] || '')) {
        const f = Object.fromEntries(lines.shift().slice(6).split(' ').map((kv) => kv.split('=')));
        let modes = '';
        // Never mouse reporting — see stripMouseModes. Off, explicitly, in case
        // this terminal is being re-used from a session that had it on.
        modes += '\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1015l';
        modes += f.cursor === '1' ? '\x1b[?25h' : '\x1b[?25l';
        modes += f.appcursor === '1' ? '\x1b[?1h' : '\x1b[?1l';
        modes += f.keypad === '1' ? '\x1b=' : '\x1b>';
        show(modes);
      }
      if (/^CURSOR \d+ \d+$/.test(lines[0] || '')) {
        const [, y, x] = lines.shift().split(' ');
        cur = [Number(y) + 1, Number(x) + 1];
      }
      if (alt) {
        // A full-screen program: ask it to redraw rather than painting over it.
        // A size change is the one request every one of them honours.
        say(`resize-window -t ${q('=' + name + ':')} -x ${lastSize[0]} -y ${Math.max(2, lastSize[1] - 1)}`);
        setTimeout(() => resize(lastSize[0], lastSize[1]), 120);
        return;
      }
      while (lines.length && !lines[lines.length - 1].replace(/\x1b\[[0-9;]*m/g, '').trim()) lines.pop();
      if (!lines.length) return;
      // Each row is placed, not printed: a line as wide as the terminal would
      // otherwise wrap and push everything under it down a row.
      let out = '\x1b[H\x1b[2J';
      lines.forEach((line, i) => { out += `\x1b[${i + 1};1H\x1b[0m` + line; });
      out += cur ? `\x1b[${cur[0]};${cur[1]}H` : '';
      show(out);
    });
  }, 250);
  return {
    write: (data) => { const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'binary'); if (bytes.length) sendBytes(bytes); },
    resize: (c, r) => { lastSize = [Number(c) || cols, Number(r) || rows]; resize(c, r); },
    kill: () => { try { say('detach-client'); child.stdin.end(); } catch {} setTimeout(() => { try { child.kill('SIGTERM'); } catch {} }, 300); },
  };
}

// ── input for a tmux without send-keys -H ───────────────────────────────────
// Only three things are key *names*: Escape, the C-a…C-z controls, and the
// couple of named ones tmux would otherwise mangle. Everything else goes
// through -l, which sends it verbatim.
//
// Nothing invented: tmux sends an argument it does not recognise as a literal
// string, so a wrong name (Semicolon, C-{) is typed into the program instead of
// pressed — which is how a mouse report became "C-{[<35Semicolon13Semicolon18M"
// in somebody's prompt. An escape sequence is therefore Escape followed by its
// remaining bytes as literal text, byte for byte, arrows and mouse included.
const CONTROL = { '\r': 'Enter', '\n': 'C-j', '\t': 'Tab', '\x1b': 'Escape', '\x7f': 'BSpace' };
/** Bytes → send-keys argument strings. */
export function keysFor(bytes) {
  const s = bytes.toString('utf8');
  const out = []; let lit = '';
  const flush = () => { if (lit) { out.push(`-l ${lit.startsWith('-') ? '-- ' : ''}${tmuxQuote(lit)}`); lit = ''; } };
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (CONTROL[ch]) { flush(); out.push(CONTROL[ch]); }
    else if (c > 0 && c < 0x1b) { flush(); out.push(`C-${String.fromCharCode(c + 96)}`); }
    else if (c < 0x20 || c === 0) { /* C-\ C-] C-^ C-_ and NUL: no portable name, and nothing sends them */ }
    else lit += ch;
  }
  flush();
  return out;
}
/** tmux's parser: single quotes take everything literally; a quote is spliced in. */
function tmuxQuote(s) { return `'${s.replace(/'/g, `'"'"'`)}'`; }

/**
 * What to do about an error tmux sent back.
 *
 * Older tmux does not have every command this uses — window-size arrived in
 * 2.9, resize-window with it — and an unsupported command is not a fault worth
 * showing: it is a capability to stop using. Printing them put tmux's
 * complaints inside the terminal the user was working in, and because resizing
 * anything refits every pane, a maximize on one side wrote errors into the
 * other.
 */
export function tmuxErrorAction(msg) {
  const m = String(msg || '');
  if (/unknown option:.*window-size/i.test(m)) return 'no-window-size';
  if (/unknown command:.*resize-window/i.test(m)) return 'no-resize-window';
  if (/(unknown flag|usage:|invalid option)/i.test(m) && /send-keys/i.test(m)) return 'no-hex';
  if (/refresh-client|bad size/i.test(m)) return 'size-format';
  return 'show';
}

/**
 * Mouse-reporting mode switches, removed from whatever the pane prints.
 *
 * A program that turns mouse reporting on takes the pointer away: the cursor
 * becomes an arrow, clicks are sent to the program, and text can no longer be
 * selected. Whether a program does that depends on what it makes of the
 * terminal it finds, so two panes running the same thing disagreed — one arrow,
 * one I-beam — for reasons that have nothing to do with what the panes are for.
 *
 * These are consoles you type into and copy out of, so the mode never reaches
 * the browser's terminal, on either side. The program is not told anything
 * different; its clicks simply have nobody reporting them.
 */
const MOUSE_MODES = /\x1b\[\?(?:9|100[0-6]|101[5-6])[hl]/g;
export const stripMouseModes = (s) => s.replace(MOUSE_MODES, '');

/** tmux escapes control-mode output as \ooo octal (and \\). */
function unescapeTmux(s) {
  return s.replace(/\\(\d{3}|\\)/g, (_, o) => (o === '\\' ? '\\' : String.fromCharCode(parseInt(o, 8))));
}
