# claude-tooling

A [Claude Code](https://code.claude.com) plugin marketplace with three tools:

| Tool | What it is | What it gives you | Needs |
|---|---|---|---|
| [work-status](#work-status) | Skill | `/work-status`: a morning brief of your sprint items, PR health, what landed, and where every open session stopped | Azure DevOps, `az login`, `python3` |
| [git-confirm](#git-confirm) | Mod | Refuses force-pushes; asks before a git command that would destroy work that isn't Claude's own, with an alarm listing what would be lost | Claude Code 2.1.287+, macOS |
| [dev-commands](#dev-commands) | Mod | `/build-status` and `/wt`: instant answers about your xcodebuild and worktrees, with no Claude turn | Claude Code 2.1.287+, macOS |

A *mod* is a plugin that runs inside Claude Code itself, so it sees every command Claude runs and
can draw in the interface — see [Mods](https://code.claude.com/docs/en/plugins/mods/overview).

## Install

1. Check your version: `claude --version` must be 2.1.287 or later for the two mods. Update
   Claude Code if it is older.
2. In a Claude Code session, add the marketplace once:

   ```
   /plugin marketplace add NikolajMosbaek/claude-tooling
   ```

3. Install the tools you want — any one of them works on its own:

   ```
   /plugin install work-status@claude-tooling
   /plugin install git-confirm@claude-tooling
   /plugin install dev-commands@claude-tooling
   ```

   work-status asks for your Azure DevOps organization when it is enabled: the name in your
   `dev.azure.com/<organization>/…` URLs.

4. Load them in the open session with `/reload-plugins`, or start a new session.
5. Check: `/plugin` shows a dim line such as `2 mods active · git-confirm, dev-commands` under its
   tabs, and typing `/wt` should print your worktrees.

The same steps work from a shell: `claude plugin marketplace add NikolajMosbaek/claude-tooling`,
then `claude plugin install <tool>@claude-tooling`.

### Update, turn off, remove

| To | Run |
|---|---|
| Get new versions | `/plugin update`, or `claude plugin update <tool>@claude-tooling` |
| Turn a tool off for a while | `/plugin` → **Installed** tab → select it → **Disable plugin** |
| Remove a tool | `/plugin uninstall <tool>@claude-tooling` |
| Turn every mod off for one session | start Claude Code with `--safe-mode` |

## Plugins

### work-status

`/work-status` builds a morning brief: sprint items assigned to you, PR health,
what landed since you last looked, local branch state, and where every open
context window stopped. It renders a styled HTML page and opens it in your browser.

Use it at the start of the day, or after a break, to see what needs you without
opening Azure DevOps, every repo and every terminal tab.

Read-only against Azure DevOps and every repo — it reports, it does not act. The
only things written are the brief under `~/.claude/briefs/` and, on a first run,
a resolved context at `~/.claude/work-status.json`.

**Prerequisites**

- `az login` — the bundled MCP server authenticates with the Azure CLI
- `python3` and `git` ≥ 2.31
- Run it from a directory inside an Azure DevOps repo, so the project and repo
  can be resolved from the git remote

The plugin ships the `ado` MCP server config, so there is no `.mcp.json` to
hand-edit. Enabling it asks for your Azure DevOps organization — the name in
your `dev.azure.com/<organization>/…` URLs; change it later in `/config`.

**First run** resolves the project and repos from your git remote and the team
from the teams you belong to, then writes `~/.claude/work-status.json` so later
runs skip that work. It should ask you nothing.

`boardConvention` is deliberately left out of the generated config — it is team
policy and cannot be discovered. Add it to sharpen the board-vs-reality checks:

```json
{
  "boardConvention": {
    "prOpenMeansTasksDone": true,
    "unstartedTasksStayNew": true
  }
}
```

**Verifying an install**

```
python3 <plugin>/skills/work-status/scripts/test-resolve-context.py
```

32 tests, stdlib only.

### git-confirm

A [mod](https://code.claude.com/docs/en/plugins/mods/overview) (Claude Code 2.1.287 or later)
that watches the git commands Claude runs:

- **Force-pushes are refused**, with no way through: `--force`, `--force-with-lease`, `-f` in any flag
  cluster, a `+refspec`.
- **Commands that destroy work ask first, but only when something that isn't Claude's own would be
  lost.** It covers `reset --hard`, `checkout --`/`.`, `restore`, `switch -f`, `clean -f`,
  `branch -D`, `worktree remove --force`, `stash drop`/`clear` and `push --delete`. Before
  asking, it measures what the command would destroy, and lets it through with a dim note when
  that is nothing, or only:
  - files Claude created or edited this session, from a clean state (ignored files never count as
    clean — they may be secrets only this machine has)
  - files whose content already equals what `reset --hard <target>` would write
  - a worktree under a temp folder (`mktemp`, `/tmp`, `/var/folders`)
  - a branch whose commits are on a remote, or whose changes are already in the default branch
    (the squash-merged case `branch -d` refuses)
- **Otherwise it asks**: a red alarm frame lists exactly what would be lost, a chirp plays, and the
  dialog offers Cancel (focused) or Proceed. Proceed hands the command back to the normal
  permission rules. A dialog nobody answers — dismissed, timed out while you were away, or a
  `claude -p` run — counts as Cancel.
- **Anything it cannot measure counts as at risk**: a path held in a shell variable it can't
  resolve, or git failing.

What you see when it asks, around Claude Code's own question:

```
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃                    ⚠  RISKY GIT  ⚠                     ┃
┃ 💥 at risk in my-app:                                   ┃
┃    D  Feature/Old.swift                                 ┃
┃     M App/AppDelegate.swift                             ┃
┃    1 file Claude changed this session goes too          ┃
┃ `git reset --hard` discards every uncommitted change    ┃
┃ to tracked files. Right now: 2 uncommitted files in     ┃
┃ my-app that Claude didn't change. Run it?               ┃
┃  ❯ 1. Cancel                                            ┃
┃    2. Proceed                                           ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
```

And when nothing is at risk, only a dim line in the transcript:

```
git-confirm: let `git branch -D feature/done` through — feature/done is already in origin/main
```

The frame draws in the terminal and the desktop app. In the VS Code chat panel you get the same
question without the frame. To silence the chirp, delete `sounds/alarm.wav` from the installed plugin.

### dev-commands

A mod (Claude Code 2.1.287 or later) adding two commands that run instantly, with no Claude turn,
even while Claude is working:

- `/build-status` — the latest xcodebuild Claude started: its scheme, the result banner (or
  "running"), errors, test issues and failing tests, read from the log Claude redirected it to.
  `/build-status <log>` reads any log.
- `/wt` — the `git worktree list` table, marking the worktree this session is in, with each one's
  branch, HEAD and uncommitted-file count.

Both are read-only. A normal slash command is a message to Claude: it waits for Claude to finish,
then spends a turn. These run their own code the moment you press Enter, so they answer even in the
middle of a long build.

```
/wt
This session is in .worktrees/123-login-fix on bugfix/123-login-fix.

   WORKTREE                     BRANCH                    HEAD      CHANGES
   (main checkout)              main                      0c8f3493  clean
→  .worktrees/123-login-fix     bugfix/123-login-fix      9846cb47  2 changed
   .worktrees/release-notes     docs/release-notes        7d141602  clean
```

```
/build-status
xcodebuild test · MyApp Test · started 6m 12s ago · background
Log: /private/tmp/…/test.log · 12.4 MB · written 3s ago
Result: none yet; xcodebuild is running (pid 4242)
Errors (1):
  /…/LoginView.swift:42:9: error: cannot find 'session' in scope
```

`/build-status` finds the log by watching where Claude redirects xcodebuild's output
(`> file`, `&>`, `| tee`). With no build seen in this session it falls back to the newest
xcodebuild log Claude wrote under `/private/tmp/claude-*`.

## Developing a mod

Mods hot-reload from a folder: start Claude Code with `--plugin-dir <mod>`, or load the
`plugin-authoring` skill in a session and copy the mod into the dev-mods folder it names.

```
test-support/run-tests.sh      # every mod test that needs no engine, under node
claude plugin validate <mod>   # what the engine would load or refuse
```

`claude plugin test` is the proper runner, but it refuses to start in 2.1.287, so `run-tests.sh`
bundles each test with `claude-code/testing` aliased to `test-support/testing-shim.ts`. Tests that
import a hooks module (`register.*`) need the engine and wait for the real runner. `hooks/shell.ts`
is copied into both mods — a mod cannot import from another — so change both.

Two engine limits shape git-confirm: a hook has a 10 s budget, after which the engine runs the call
on its behalf, so a dialog must go through `$.ui.ask` (a mod's own buttons cannot hold the call);
and the engine draws at most 12 rows of a mod's own around its dialog, refusing the frame past that.
