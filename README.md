# deployacron

An all-purpose deployer you run in a browser, for any project that is "get the
code onto one or more servers over SSH and run scripts there". It shows both sides of the deploy
live with colors kept, stores every run, and puts a **troubleshooter**
(`ollama launch claude`) on each side that can read the feeds. Nothing is
scheduled; you press the button.

A project can span several servers — see **Targets** below. Projects live on
a config branch of their own, not on this one — see **Your projects live on a
config branch**.

```
npm install
npm start            # http://localhost:4747
```

**What the local machine needs:** Node 18+, `ssh`, `tmux`, and `sshpass` only
for password auth. No rsync: the code is fetched by the server, and the
deployer's own scripts travel as a tar down the ssh connection. The server
needs `git` and `tmux`.

## The tabs

**Remote** is an ssh shell on the server, inside tmux, and nothing else. It
opens itself when you go there, survives the browser being closed, and is the
same terminal as the troubleshooters: type into it, page back through its
history, maximize it. **Deploy** runs and watches a deploy, **Runs** lists the
old ones, **Troubleshoot** is the two troubleshooters and the last deploy's
feeds, **Settings** is the project.

## First run

A path on the server may start with `~/` — the deploy key, the remote
directory — and is expanded there, against that machine's home. A path of your
own on this machine may too.

1. Open **Settings → Server**: host, user, key or password, remote directory.
   That key reaches **the server**, not GitHub. This tab is this machine's and
   is written to `projects/<name>/local.json` (gitignored); the other tabs are
   the project's and are committed. Press **Test** next to it: it saves what is
   on screen, opens a real ssh session, and reports who you are on the server,
   whether the directory is a checkout yet, whether git, tmux, docker, node and
   curl are installed and usable, and whether **the server** can reach the
   repository. Do this before anything else — a failure here is named in a
   sentence rather than as a program's usage block. A whole destination pasted
   into Host (`me@host:2222`) is split across the three fields for you.
2. Open **Settings → Project → Repository**: the remote, the branch, and the
   path to a deploy key **on the server**. The server does the fetching, so the
   key lives there and its public half goes on the GitHub repository as a
   deploy key. An https remote can use a token instead: set `git.token` under
   Variables, where it is a secret and reaches git through askpass rather than
   a URL or a file.

   Or leave the key path empty. If the server cannot read an ssh remote, the
   fetch step makes `~/.ssh/deploy-<project>` on that server and the run
   pauses with its public key and a link to the repository's deploy keys.
   Add it, press **Continue**, and the fetch tries again. Later deploys use
   that key without asking. A key path you set is always used as is.
3. Press **Deploy now**.

## Troubleshooters first

A deploy begins with step zero, **Troubleshooters**, before anything is
pushed. It starts `ollama launch claude` (Settings → Project → *Troubleshooter
command*) inside tmux on this machine and on the server. **The local one is
required**: if it does not start the run stops right there, because it is the
one that can work out everything else, the server included. A remote one that
does not start is a warning and the run continues.

When a run ends, its two feeds (colors stripped) and its NOT-DONE.md are
written to each side as `.deploy/logs/last-deploy.md`, so you can tell either
troubleshooter to read them. The **Troubleshoot** page shows four consoles:
both troubleshooters, attached through a real terminal you type into
(xterm.js over a WebSocket, tmux control mode underneath, so no pty is
needed on either side), and beneath them the latest
deploy's local and remote feeds. Before the first deploy there are no feeds,
so the two terminals take the whole page.

Per side: **⇞ ⇟** page back and forward through that pane's history (read
straight out of tmux's scrollback, 100k lines; **live** returns to the live
pane and replays anything that arrived while you were reading), **New**,
**Attach**, **Send logs** (push the latest feeds again), **Send** (a line via
`tmux send-keys`, works with nothing attached), **Stop**.
The input box is prefilled with a first prompt after New. Click into a
terminal and type: keys go straight to the pane, control characters and arrows
included. The tmux window follows the browser terminal's size.

**New means a new session.** Whatever is in there is replaced by one running
what the project asks for — use it when a session is wedged, running the wrong
thing, or just old. That matters because a tmux session keeps the command it was
created with, so one started before you changed *Troubleshooter command* goes on
being the old thing until it is replaced. Each session records what it was
created to run, so until you press New the pane's header shows the command it
*should* run in amber beside the one it *is* running. The Remote tab opens its
shell by itself on arrival, and that is a plain start rather than a New, so
coming back to the tab never throws away a session you left running. If that is a bare shell, the setting is
wrong rather than the session: the chip turns amber, and clicking it sets
*Troubleshooter command* to `ollama launch claude` and drops the stale session.
Settings → Project says the same thing in place.

Attaching adopts the pane's own terminal modes — cursor visibility, application
cursor keys, keypad — because a terminal that attaches later never saw the
sequences that set them, and without it arrow keys send bytes the program does
not expect.

**Mouse reporting is the exception: it never reaches the browser's terminal.**
A program that turns it on takes the pointer away — the cursor becomes an
arrow, clicks go to the program, and text can no longer be selected — and
whether a program does that depends on what it makes of the terminal it finds,
so two panes running the same thing disagreed. These are consoles you type into
and copy out of, so both stay an I-beam with selectable text whatever the
program asks for.

The terminal your keystrokes reach is ringed, in the same accent a focused
input gets, drawn around the output itself. Clicking the line box under a pane
is not the same thing and does not ring it.

A pane speaks to its tmux only when **its own** box changes size, and only when
the size actually differs from the last one it sent. Maximizing one terminal
leaves the other silent; dragging the splitter between them, which really does
change both, has both report once.

The deployer uses a few tmux commands that older versions do not have. What a
tmux rejects once it is not asked for again, and the rejection is not printed:
those complaints used to land in the terminal you were working in, and since a
resize refits every pane, maximizing one side wrote errors into the other.

**When a pane renders wrong** — lines doubled, or a menu drawn a row out — the
program inside is drawing for a different screen than the one you are looking
at. The pane's size is pinned to your terminal and re-checked every few seconds:
a drift is corrected, and while it lasts the status reads the two sizes rather
than a green "running". Click it to correct it immediately.

The command runs through a **login shell**, so its PATH is the one you get when
you ssh in and type — not the shorter one a non-interactive ssh gets, which is
how a perfectly installed `ollama` comes back as "command not found". When the
command genuinely is not there, the pane says so and stays open instead of
quietly looking like a shell.

Neither side needs a deploy to have run first: the script that drives tmux
travels down the ssh connection with the command, and the working directory is
created if it is not there yet. That is the point of them — the thing you reach
for when nothing works cannot itself depend on the thing that is not working.

The sessions are `<tmuxSession>-local` here and `<tmuxSession>` on the server:

```
tmux attach -t =myapp-troubleshoot-local                # here
ssh user@host -t tmux attach -t =myapp-troubleshoot     # there (myapp-troubleshoot-<target> with several targets)
tmux capture-pane -p -e -J -S - -t =myapp-troubleshoot  # the screen as text
```

Locally the troubleshooter starts in this directory, so it can read
`runs/<project>/<id>/*.log`, `projects/<name>/`, this README and the code. On
the server it starts in `<remoteDir>` and can read `.deploy/` next to it.

## What a run is

Steps come from `projects/<name>/project.json` and are edited under
**Settings → Steps**. Five kinds:

| kind | side | what it does |
|---|---|---|
| `preflight` | remote | checks `ssh`/`rsync`/`tmux` here, pushes `.deploy/` to the server, then runs the named `remote/` script there |
| `fetch` | remote | the **server** clones or fast-forwards one branch from git, with its own deploy key. Nothing is copied from this machine, so what runs is exactly what is on the branch. Reports the old and new commit, the log between them, and the diffstat |
| `push` | local | the older way: `rsync -az` a local directory to `<remoteDir>`. Only for a project that has no repository |
| `script` | either | runs `remote/<file>` on that side, with the project's env |
| `command` | either | runs a shell string on that side; `{{variables}}` allowed |
| `report` | local | renders the templates into the run; a `.md` with `- [ ]` items becomes the **Not done** panel |

A failing step stops the run; steps marked **always** still run (checks,
verify, report). The step's side is the pane its output lands in.

**Variables** (Settings → Variables) are a flat map, `domains.root` and so on.
Templates and commands refer to them as `{{domains.root}}`; every script gets
each one in its environment as `DOMAINS_ROOT`, plus `REMOTE_DIR`, `PROJECT`,
`RUN_ID`, and whatever the **Script env** table renders (`ROOT_URL:
https://{{domains.root}}`). A variable marked **secret** is stored in
`local.json`, masked in the browser, and left blank in the committed file.
Templates also know `{{project.name}}`, `{{server.host}}`, `{{server.user}}`,
`{{server.remoteDir}}`, `{{source.dir}}`, `{{run.id}}`, and support
`{{#if key}}…{{else}}…{{/if}}`.

**Files** (Settings → Files) edits `remote/*.sh`, `templates/*` and the
rsync excludes in place, and creates new ones. `remote/` lands in
`<remoteDir>/.deploy/`; a script sources `_lib.sh` for the colored helpers.

**Project** (Settings → Project) has the title, the excludes file, delete on
push, the template list, the troubleshooter command and tmux session name,
previews of each rendered template, and **New project** (bare template, or a
copy of an existing one).

## The feeds

Two panes on the Deploy page, **Local** and **Remote**. They are paged, not
scrolled: as many lines as the box holds per page, `« ‹ n / N › »` to move,
**Live** pins to the last page as output arrives. Click a step to see only its
lines. Nothing on any page scrolls or cuts off; the page is the viewport.

**The dock.** A page's title, status and buttons float in a small panel rather
than taking a band across the top: drag it by the title, collapse it with the
chevron or a double-click, and it stays where you put it. The canvas keeps the
full height of the window.

**Resizing.** Every boundary is a drag handle: between the step list and the
feeds, between the two feeds, between the two troubleshooters, and between the
terminals and the feeds below them. Double-click a handle to reset it; the
sizes are remembered per layout. The **⤢** button on any console makes it fill
**the whole page** — every other panel gets out of the way — and Esc or **⤡**
puts it back. A maximized terminal tells tmux its new size, so the program
inside redraws at full height.

Every run is under `runs/<project>/<id>/`:

```
meta.json        steps, statuses, timings, target, redacted project
events.ndjson    every chunk with its step and side — what the browser replays
local.log        the local pane, raw, colors included
remote.log       the remote pane, raw, colors included
rendered/        the templates as rendered for this run
NOT-DONE.md      the checklist, when a template produced one
```

**Runs** lists them and opens any one as it looked live. `keepRuns` in
`config.json` prunes the oldest per project.

## Targets: one project, several servers

A project deploys to one or more named **targets** — say `edge` and `origin`.
Set them under **Settings → Project → Targets** (`"targets": ["edge", "origin"]`
in `project.json`); with none, there is one, `server`, and everything works as
it always did.

- **Each target is its own server.** `local.json` keeps them under
  `servers.<target>`. With more than one, a target picker appears in the top
  bar, and **Server**, **Remote** and **Troubleshoot** are about the target it
  shows. A `local.json` from before targets (a single `server` block) is read
  as the first target's and moved under `servers` on the next save.
- **Each step names its target** (`"target": "origin"`, a picker under
  Settings → Steps); a step that names none runs on the first. A step that
  names a target the project does not have is reported before anything runs.
- **One Deploy runs across all of them**, in step order: origin first, then
  edge, or however the steps are laid out. The first remote step on a target
  ships `.deploy/` there if no preflight did.
- **Each target can see the others.** Templates and commands get
  `{{targets.<name>.host}}` (and `.user`, `.remoteDir`) for every target, and
  `{{target.name}}` for their own; scripts get `TARGET` and
  `TARGET_<NAME>_HOST`. That is how an edge's proxy config names the origin's
  address without either being typed twice.
- **Troubleshooters**: one here, and one on every target a step runs on
  (`<session>-<target>`). Each gets the run's feeds when it ends.

## Your projects live on a config branch

The engine branch ships only `projects/_template`. A real project's
definition (`projects/<name>/project.json`, its `remote/` scripts and
`templates/`) is committed on a branch of its own — `config/<name>`, say —
made from the engine branch. Engine updates never touch `projects/<name>/`,
so merging a new engine into your config branch leaves your side exactly as
it was. Each machine's servers, credentials and secret values stay in
`projects/<name>/local.json`, which is gitignored everywhere.

With no project at all, deployacron does nothing: the page says so and offers
to start one from the template.

## Layout

```
server.mjs              Express + WebSocket: pages, JSON API, live feed, terminal attach
lib/projects.mjs        projects: load/save/split (project.json + local.json), files, variables
lib/pipeline.mjs        the engine: step kinds, step zero (troubleshooters), templates → .deploy/
lib/template.mjs        {{key}} and {{#if}} rendering
lib/runner.mjs          a Run: steps, events.ndjson, pane logs, the per-project run store
lib/ssh.mjs             ssh/rsync argv (key, password via sshpass, connection sharing)
lib/exec.mjs            spawn with color forced, output streamed
lib/troubleshoot.mjs    tmux sessions on either side, and the terminal attach
lib/remote/             troubleshoot.sh — pushed to every project's .deploy/
projects/<name>/        project.json, local.json (gitignored), remote/, templates/, rsync-excludes.txt
projects/_template/     what New project copies
public/                 the UI: app.js, style.css, ansi.js (ANSI → HTML)
config.json             active project, port, runs to keep (gitignored)
```
