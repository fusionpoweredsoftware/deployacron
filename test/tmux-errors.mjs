// What the deployer does with each complaint tmux can send back. The ones that
// mean "this tmux is older than that command" must never reach the terminal:
// they did, and because a resize refits every pane, maximizing one side wrote
// tmux errors into the other side's session.
import { tmuxErrorAction } from '../lib/troubleshoot.mjs';

const cases = [
  ['unknown option: window-size', 'no-window-size'],
  ['parse error: unknown command: resize-window', 'no-resize-window'],
  ['command send-keys: unknown flag -H', 'no-hex'],
  ['bad size argument to refresh-client', 'size-format'],
  ["can't find session: nope", 'show'],
  ['no such window: 9', 'show'],
];
let bad = 0;
for (const [msg, want] of cases) {
  const got = tmuxErrorAction(msg);
  if (got !== want) { console.error(`  ✗ ${JSON.stringify(msg)} → ${got}, expected ${want}`); bad++; }
}
if (bad) process.exit(1);
console.log(`  ✓ tmux errors classified (${cases.length} cases); unsupported commands are dropped, not printed`);
