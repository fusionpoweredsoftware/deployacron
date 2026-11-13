// A remote path keeps its tilde usable. Quoting it whole is how "~/.ssh/id_gh"
// became a file in a directory literally called "~", and a deploy key that was
// sitting right there reported as "not readable on this server".
import { qPath } from '../lib/ssh.mjs';

const cases = [
  ['~/.ssh/id_gh', "~/'.ssh/id_gh'", 'a key under the home directory'],
  ['~', '~', 'the home directory itself'],
  ['~/dir with space/x', "~/'dir with space/x'", 'spaces after the tilde'],
  ['/home/root/computatron', "'/home/root/computatron'", 'an absolute path is quoted whole'],
  ["/od'd", "'/od'\\''d'", 'a quote in the path survives'],
  ['~user/x', "'~user/x'", "another user's home is not ours to expand"],
];
let bad = 0;
for (const [input, want, what] of cases) {
  const got = qPath(input);
  if (got !== want) { console.error(`  ✗ ${what}: ${JSON.stringify(input)} → ${got}, expected ${want}`); bad++; }
}
if (bad) process.exit(1);
console.log(`  ✓ remote paths keep a usable tilde and stay quoted otherwise (${cases.length} cases)`);
