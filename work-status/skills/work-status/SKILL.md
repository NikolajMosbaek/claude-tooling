---
name: work-status
description: Morning brief for Claude Code work — sprint items assigned to you, PR health, what landed since you last looked, local branch state, and where every open context window stopped. Renders a styled HTML brief and opens it.
user-invocable: true
---

Build this morning's work-status brief and open it in the browser.

Read-only against Azure DevOps and every repo. The only things written are
the brief HTML and its model, both under `~/.claude/briefs/`. Never comment
on a PR, change a work item, or touch a branch from this skill — it reports,
it does not act.

Skill directory: **the prompt that invoked this skill opens with
`Base directory for this skill: <path>`.** Use that path verbatim wherever the
commands below write `$SKILL`, so the skill works whether it is installed under
`~/.claude/skills/`, a project's `.claude/skills/`, or a plugin.

Do not search the filesystem for it. A `find … | head -1` guess silently picks
the wrong copy as soon as a second directory matches the name — a backup, a
renamed variant, or a project-level copy shadowing the user-level one — and
then the whole run reads the wrong scripts.

Shell state does not survive between commands, so **set `SKILL=` inside each
block that uses it**, substituting the real path. Left unset it expands to
nothing and `python3 "$SKILL/scripts/…"` fails with `can't open file
'/scripts/…'`.

---

# 0. Prerequisites — check these first, and stop if they fail

This skill needs the Azure DevOps MCP server. It is configured **per
project**, so running from a directory without it produces a brief with a
silently empty ADO half — which reads as "nothing needs you" and is the worst
possible failure for a morning brief.

- **An Azure DevOps MCP server must be available — whatever it is registered
  under.** The tool prefix is `mcp__<server-name>__`, and the name is whatever
  key the user put in their `.mcp.json`: `mcp__ado__…` and
  `mcp__azure-devops__…` are both the same server. Find the prefix in the tools
  actually available to you and **use that prefix everywhere below**. Tool names
  in this file are written `mcp__ado__…` for readability; only the prefix
  varies — the suffixes (`wit_query`, `repo_pull_request`, `work`, …) are fixed.
- If no Azure DevOps server is present at all, say so and stop. Do not render a
  local-only brief and call it a work status.
- The server needs the `core`, `work`, `work-items` and `repositories`
  domains enabled, and an authenticated `az login`. A representative
  `.mcp.json` entry:

  ```json
  {"mcpServers": {"ado": {"type": "stdio", "command": "npx",
    "args": ["-y", "@azure-devops/mcp", "<YOUR-ADO-ORG>",
             "-d", "core", "work", "work-items", "repositories", "pipelines",
             "-a", "azcli"]}}}
  ```

  The key (`"ado"` above) is what sets the tool prefix, so a colleague who
  registers the same server as `"azure-devops"` gets `mcp__azure-devops__…`.

- If `mcp__ado__core_list_projects` returns an auth error, the token has
  expired: `az account show` lies about a revoked token, so the real check is
  `az account get-access-token`, and the fix is
  `az login --allow-no-subscriptions`. Report that and stop.

`python3` and `git` ≥ 2.31 are required (`collect-local.py` uses
`--path-format=absolute`; on older git it degrades to listing worktrees
separately rather than folding them into their main checkout).

# 1. Resolve the context

The organization is fixed by the MCP server's own configuration — never name
one in a query, and never assume the org from this file.

The rest is resolved by a script, so **there is nothing for anyone to set up by
hand** — importing the skill folder is the whole install. Run it first:

```bash
SKILL=/path/from/the/top/of/this/prompt   # substitute the real base directory
python3 "$SKILL/scripts/resolve-context.py"
```

It prints `{configPath, exists, source, config, error, discovered}`.

**If `source` is `"config"`** you are done — `config` holds the project, team and
repos. That is the user's stated intent and outranks anything you could infer, so
do not re-derive it or second-guess it.

**If `exists` is `false`** this is a first run. `discovered` carries what the git
remotes prove — `org`, `project`, `repos` — plus an `ambiguous` list naming
whatever they could not. Fill the gaps, then persist the result so no later run
has to repeat any of this:

1. **`ambiguous` is empty** — project and repos are settled. You only need the
   team.
2. **The team.** `mcp__ado__core_list_project_teams` with **`mine: true`** returns
   only the teams you belong to, which usually leaves exactly one. If it leaves
   several, query your own work items **without** the iteration filter (that needs
   no team), read their `System.AreaPath`, and pick the team whose name matches its
   last segment — matching is case-insensitive. Only if both fail, ask.
3. **Anything named in `ambiguous`** — ask, once, with the candidates spelled out.
   A repo with no ADO remote, or remotes spanning two projects, is the usual cause.
   Never guess a project.
4. **Persist it.** `boardConvention` is a team policy that cannot be discovered, so
   leave it out rather than inventing one; step 6 already degrades safely without
   it, and the user can add it later.

```bash
SKILL=/path/from/the/top/of/this/prompt   # substitute the real base directory
python3 "$SKILL/scripts/resolve-context.py" --write \
  '{"project":"<project>","team":"<team>","repos":["<repo>"]}'
```

It validates before writing and replaces atomically, so a bad value is refused
with a message rather than leaving a broken config behind. Say what you resolved
and that you wrote it in the **terminal summary** (step 8), not in the brief —
the brief is for findings, the summary is for what the run did. Name which method
settled the team, and say plainly that you left `boardConvention` out and where to
add it, or nobody will ever discover the option exists.

Ask **only** for what `ambiguous` names and the team when it is genuinely
undecidable. A first run in an ADO repo you belong to should need no questions at
all.

Write the resolved project, team and repo list into your working notes. If
discovery fails for any of them, say which and continue with the parts that
resolved — a brief missing its sprint section, clearly labelled, beats a
brief that silently invents one.

# 2. Anchor the window

```bash
ls ~/.claude/briefs/*.html 2>/dev/null | sort | tail -3
```

The window runs from **the last brief's date** to now. If there is no prior
brief, fall back to the previous work day — Monday reaches back to Friday.
That is also `collect-local.py`'s default, so with no prior brief you can
just let it choose.

If a brief already exists for today, you are re-running: overwrite it — and
anchor on the **previous** brief, not today's. "The last brief's date" would
otherwise resolve to today and collapse the window to a few minutes, hiding
everything that landed since you actually last looked. Use the second-newest
brief, or the previous work day if today's is the only one.

# 3. Collect local state

```bash
SKILL=/path/from/the/top/of/this/prompt   # substitute the real base directory
python3 "$SKILL/scripts/collect-local.py" --fetch > /tmp/work-status-local.json
```

`--fetch` updates remote-tracking refs first so "what landed" is current; it
never touches local branches. Pass `--since <ISO>` when step 2 found a prior
brief.

The JSON gives you, per repo: `landed` (first-parent commits in the window,
with `prId` parsed out of ADO squash-merge subjects) and `worktrees` (branch,
`dirtyFiles` — a **count**, not a list — `ahead`/`behind`, `upstreamGone`,
`behindDefault`, `transient`, `detached`). Plus `sessions`: every transcript touched recently, with
`title`, `cwd`, `gitBranch`, `turns`, `lastUser` and `lastAssistant`.

**Ignore `transient: true` worktrees** — those are agent scratchpads, not
your work.

Repos are discovered from the directories your recent sessions ran in, so a
repo you have not touched lately will not appear. That is deliberate.

# 4. Collect the open context windows

Call `ListAgents`. It returns peer sessions with a kind (interactive /
Remote Control / cloud) and a live state (active / idle / offline).

`ListAgents` says whether a context is *alive*; the transcript from step 3
says what it was *doing* — you need both, so join the two lists. For each one
you can join, the `lastUser` + `lastAssistant` pair tells you where it
stopped: mid-task, waiting on a question, or finished cleanly.

**Title is the join key, but expect it to miss more often than it hits.** Two
reasons, and they need different handling:

- **An unnamed session** shows in `ListAgents` under an auto-generated label
  (`myrepo-1a`), which matches no transcript field. Fall back to matching on
  `cwd` + `gitBranch` + most-recent `mtime`, and identify it in the brief by
  what it was doing rather than by a name that means nothing to the reader.
- **A Remote Control or cloud session** may have no transcript on this machine
  at all, so no join is possible. Report it from `ListAgents` alone — name,
  kind, state — and say only what that supports: whether it is still alive and
  whether any branch or worktree is stranded behind it. Do not guess at its
  contents.

Never invent a session's activity to fill the section. If the only honest
thing you can say about a context is that it went offline without finishing,
that is the line.

# 5. Collect Azure DevOps state

Use the Azure DevOps MCP tools only — never curl, never manual PAT extraction.
Use the prefix you established in step 0, not the `mcp__ado__` spelling used here.
Pass the project and team resolved in step 1.

Run these together in one message; they are independent:

**a. The sprint.** One WIQL query, no iteration path anywhere in it:

```sql
SELECT [System.Id], [System.WorkItemType], [System.State], [System.Title]
FROM WorkItems
WHERE [System.TeamProject] = @project
  AND [System.AssignedTo] = @Me
  AND [System.IterationPath] = @currentIteration
  AND [System.State] NOT IN ('Done', 'Closed', 'Removed', 'Resolved', 'Completed')
ORDER BY [System.Id]
```

`@currentIteration` needs the `team` argument on `mcp__ado__wit_query` —
without it the macro cannot resolve and the query errors. If it returns
nothing, the team has no iteration with current dates: fall back to
enumerating iterations with `mcp__ado__work` and filtering on the one
covering today. Never hardcode an iteration path; the root moves between
sprints.

One query can serve both this and the team resolution in step 1: select
`System.AreaPath` alongside the rest and drop the iteration clause, then filter to
the sprint locally. That is fine and saves a call, but a project-wide result set is
unbounded and `top` defaults to 50 — **pass `top: 200` explicitly** if you do it
that way, or a large personal backlog silently truncates before your filter runs.

**Filter by what is *not* done, never by a list of active states.** State
names are process-specific — Agile has `New`/`Active`, Scrum has
`New`/`Approved`/`Committed`, Basic has `To Do`/`Doing`, and any project can
add its own (`Blocked` is common). An allow-list of active states silently
drops work instead of erroring, which is exactly the failure a brief must not
have. A `New` item with a branch already cut, or a `Blocked` item with a
deadline, is a finding — not noise.

**b. Your open PRs.** `mcp__ado__repo_pull_request` filtered to your PRs, for
every repo resolved in step 1. For each: reviewer votes, unresolved threads,
and `mergeStatus` for conflicts. Remember `status: 1` means **Active, not
Completed**, and `lastMergeCommit` on an open PR is a test-merge artifact —
never read it as "this merged".

**c. PRs waiting on your vote.** PRs where you are a reviewer and your vote
is still 0. These block other people, so they outrank everything else.

**d. CI.** For any PR that matters, check the build on `refs/pull/<id>/merge`
— *not* `refs/heads/...`, which returns `[]` on a green build.

# 6. Correlate

This is the step that earns the brief. Cross-join steps 3–5 and look for:

- **Blocking others** — unvoted review requests; PR threads where a reviewer
  asked you something and the last word is theirs.
- **Blocked / broken** — red CI, merge conflicts, a PR with enough approvals
  to merge that nobody has merged, a work item parked in a blocked-type state.
- **Board vs. reality** — an item in a started state with no branch anywhere;
  a branch or PR whose item has never been started.

  > Board conventions differ per team, so only apply the sharper rules when
  > `boardConvention` in the config file says they hold. With
  > `prOpenMeansTasksDone`, an open PR whose child Tasks are not Done is a
  > finding; with `unstartedTasksStayNew`, a Task moved off New with no
  > commits is one. Absent the config, report the plain mismatch — item
  > started, no branch — and do not infer a team's process from its state
  > names.

- **Stale local state** — `upstreamGone` worktrees, dirty or unpushed
  branches, and worktrees far `behindDefault` that will conflict on rebase.

  > **Prunability under squash-merge.** ADO squash-merges and deletes the
  > source branch, so the branch tip is *never* an ancestor of `main`.
  > `git branch --merged` and `--contains` both report "not merged" for work
  > that landed days ago, and a `diff origin/main HEAD` on a branch that is
  > 25 commits behind shows everything `main` gained, not what the branch
  > still owes. Neither is evidence. The reliable pair is `upstreamGone:
  > true` **plus** a `Merged PR <id>` commit on the default branch. Report
  > those as *candidates* only — **this skill never deletes anything.** Leave
  > the deleting to whatever branch-cleanup command the reader uses.

- **Dropped threads** — a context window that stopped mid-task days ago, or
  a Remote Control session that went offline without finishing.

Verify anything you are unsure of before it goes in the brief. A confident
wrong line costs more than an omitted one.

# 7. Write the model

Author `$HOME/.claude/briefs/YYYY-MM-DD.json`. `Write` takes an **absolute**
path and does not expand `~` — passing the tilde form fails with "Error
writing file", so resolve `$HOME` first (`echo $HOME`) and pass the expanded
path, or write the file from the shell with a heredoc. On a re-run that file
already exists, and `Write` refuses to overwrite a file it has not read — so
read it first, or use the heredoc.

```json
{
  "title": "Work status",
  "date": "Monday · August 17 2026",
  "headline": "One sentence naming the shape of the work.",
  "arc": {
    "label": "Sprint 42 · day 6 of 10",
    "days": [{"label": "Mon 11", "load": 3, "landed": 1}],
    "todayIndex": 5
  },
  "columns": [{"label": "Landed", "body": "..."}],
  "sections": [
    {"title": "Needs attention",
     "items": [{"title": "...", "href": "https://...",
                "bodyHtml": "Sentence with an <a class=\"src\" href=\"...\">inline link</a>."}]}
  ]
}
```

**The arc** replaces the calendar's day curve with delivery drawn as
terrain: **the trailing ten working days into today**, height = PRs merged
that day, dots on the days anything landed.

Anchor it on working days, not sprint days. A sprint that begins today has
no history to draw and would render as a flat line on its first morning,
which says nothing; the trailing window always carries signal and still
lands today at the right-hand edge. Put the sprint in the `label` instead
(`"Sprint 19 · day 1 of 10"`), where it belongs as context.

`todayIndex` marks today with a dashed clay line. Height is normalised for
you — pass raw counts. Omit `arc` entirely and you get a flat line, which
still reads as deliberate.

Per-day counts — one git call, and no dependence on `date(1)`, whose
arithmetic flags differ between BSD and GNU:

```bash
python3 - <<'PY'
import subprocess, collections
from datetime import date, timedelta
default = subprocess.run(["git", "symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
                         capture_output=True, text=True).stdout.strip() or "origin/main"
today, start = date.today(), date.today() - timedelta(days=13)
log = subprocess.run(["git", "log", default, "--first-parent",
                      f"--since={start} 00:00", "--pretty=%ad|%s", "--date=short"],
                     capture_output=True, text=True).stdout
counts = collections.Counter()
for line in log.splitlines():
    d, _, subj = line.partition("|")
    if subj.startswith("Merged PR"):
        counts[d] += 1
for i in range(13, -1, -1):
    day = today - timedelta(days=i)
    if day.weekday() < 5:
        print(f"{day.strftime('%a')} {day.day}|{counts[day.isoformat()]}")
PY
```

The `Merged PR` prefix is what ADO writes for both squash and no-fast-forward
merges. A repo merged some other way draws a flat arc rather than a wrong
one; say so in the `label` if that is what you see.

Label only the first and last day; the middle labels crowd at this width.

**The three columns** replace the calendar's time blocks with
`Landed` / `In flight` / `Not started`.

**Sections**, in this order, skipping any that would be empty:

| Section | Holds |
|---|---|
| `Needs attention` | Ordered: blocking other people first, then blocking you. |
| `Resolved` | Merged, closed, or answered since the last brief. |
| `Open contexts` | One line per live or recently-stopped context: what it was doing, where it stopped — or, where no transcript joins, just that it is alive or offline. |

`bodyHtml` is emitted verbatim so you can put `<a class="src">` links inline
— link the PR, the work item, the Teams thread. Everything else is escaped.

# 8. Render and open

```bash
SKILL=/path/from/the/top/of/this/prompt   # substitute the real base directory
python3 "$SKILL/scripts/render.py" \
  ~/.claude/briefs/YYYY-MM-DD.json --out ~/.claude/briefs/YYYY-MM-DD.html
# open(1) is macOS; fall back for Linux and Git Bash on Windows
open ~/.claude/briefs/YYYY-MM-DD.html 2>/dev/null \
  || xdg-open ~/.claude/briefs/YYYY-MM-DD.html 2>/dev/null \
  || start "" ~/.claude/briefs/YYYY-MM-DD.html
```

Then give a two-line summary in the terminal — the count of things needing
attention and the single most urgent one — so the brief is useful even
without switching to the browser.

Add a short **notes on this run** line after it, but only for decisions the
reader could not infer from the brief itself: a config you wrote on a first run
(step 1), a window you anchored on an older brief because today's already
existed (step 2), a team you had to assume, a section you left out for want of
data. Name the method that settled each one. Skip the line entirely when the run
was unremarkable — it is there to disclose judgement calls, not to narrate.

---

# Voice

The brief is prose, not a dashboard. Match the reference: declarative
sentences with specifics in them, no hedging, no filler adverbs.

- **Bold claim, then the evidence.** The title states what is true; the
  sentence under it says who, when, and where, and links the source.
- **Say why it matters now.** "Sprint planning at 11 is where the next two
  weeks get carved up" earns its place. "This may require attention" does not.
- **Name people and numbers.** PR ids, work item ids, branch names, counts.
- **Never invent a link.** No source, no `<a>`.
- Keep each item to one or two sentences. If it needs three, it is two items.

Write "they" for anyone whose pronouns you do not know.
