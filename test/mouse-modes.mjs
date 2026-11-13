// The pointer over a pane must not depend on what the program inside decides
// about mouse reporting: two panes running the same thing disagreed, one an
// arrow and one an I-beam. The mode never reaches the browser's terminal.
import { stripMouseModes } from '../lib/troubleshoot.mjs';

const cases = [
  ['\x1b[?1000h\x1b[?1006hhello', 'hello', 'X10 + SGR on'],
  ['a\x1b[?1002lb', 'ab', 'button-event off'],
  ['\x1b[?1003h\x1b[?1015h', '', 'any-event and urxvt on'],
  ['\x1b[?9h', '', 'X10 compatibility on'],
  ['\x1b[?1049h alt screen', '\x1b[?1049h alt screen', 'alternate screen kept'],
  ['\x1b[?25l hidden cursor', '\x1b[?25l hidden cursor', 'cursor visibility kept'],
  ['\x1b[?1h app cursor keys', '\x1b[?1h app cursor keys', 'application cursor keys kept'],
  ['\x1b[31mred\x1b[0m', '\x1b[31mred\x1b[0m', 'colours kept'],
  ['\x1b[10;20H', '\x1b[10;20H', 'cursor positioning kept'],
];
let bad = 0;
for (const [input, want, what] of cases) {
  const got = stripMouseModes(input);
  if (got !== want) { console.error(`  ✗ ${what}: ${JSON.stringify(input)} → ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`); bad++; }
}
if (bad) process.exit(1);
console.log(`  ✓ mouse reporting never reaches the terminal (${cases.length} cases), everything else passes through`);
