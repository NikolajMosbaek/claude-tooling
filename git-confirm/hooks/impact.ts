// What a risky git command would really destroy, measured with git before anyone is asked.
//
// The rule: ask only when something that is not this session's own work would be lost.
//   - a file this session created or edited, and that was clean before it did, is Claude's own
//   - a file whose content already equals what `reset --hard <target>` writes loses nothing
//   - a worktree under a temp folder (`mktemp`, /tmp, /var/folders) is disposable
//   - a branch whose commits are on a remote, or whose changes are already in the default branch,
//     loses nothing
// Anything that cannot be measured — git fails, a path still holds a `$` — counts as at risk.
// Git is injected (`Git`) so every rule is testable with canned output.

import { type AlarmSection, branchSection, type StatusEntry, unmeasuredSection, worktreeSection } from './alarm'
import { type Finding, isTempPath } from './risky'
import { joinPath } from './shell'

/** Runs `git -C dir …args`; stdout on exit 0, undefined on any failure. */
export type Git = (dir: string, args: readonly string[]) => Promise<string | undefined>

/** Whether an absolute path is a file this session made or edited from clean. */
export type IsOwn = (absolutePath: string) => boolean

export type Measured =
  | { isAtRisk: false; passReason: string }
  | { isAtRisk: true; summary: string; section?: AlarmSection }

/** `/tmp/x` → `/private/tmp/x`, `/var/…` → `/private/var/…`: the spelling git and the tools agree on. */
export function canonicalPath(path: string): string {
  return path.replace(/^\/(tmp|var|etc)(\/|$)/, '/private/$1$2')
}

/** Entries of `git status --porcelain -z`; a rename's source path is skipped. */
export function parsePorcelainZ(output: string): StatusEntry[] {
  const fields = output.split('\0')
  const entries: StatusEntry[] = []
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i] ?? ''
    if (field.length < 4) continue
    const code = field.slice(0, 2)
    entries.push({ code, path: field.slice(3) })
    if (code.includes('R') || code.includes('C')) i += 1
  }
  return entries
}

const unmeasured = (why: string): Measured => ({ isAtRisk: true, summary: '', section: unmeasuredSection(why) })

/** Measures one `confirm` finding run from `cwd`. */
export async function measure(finding: Finding, cwd: string, git: Git, isOwn: IsOwn): Promise<Measured> {
  const impact = finding.impact
  if (!impact) return { isAtRisk: true, summary: '' }
  const dir = finding.dir === undefined ? cwd : joinPath(cwd, finding.dir)
  if (dir.includes('$')) return unmeasured(`its directory is a shell variable`)

  switch (impact.kind) {
    case 'worktree': {
      if ((impact.pathspecs ?? []).some(p => p.includes('$'))) return unmeasured('a path is a shell variable')
      return measureTree(dir, git, isOwn, {
        statusArgs: ['--', ...(impact.pathspecs ?? [])],
        includeIgnored: impact.includeIgnored === true,
        keep: e => (impact.hits === 'tracked' ? !isUntracked(e) : isUntracked(e)),
        resetTarget: impact.resetTarget,
      })
    }
    case 'worktree-remove': {
      const path = joinPath(dir, impact.path)
      if (impact.isTemp || isTempPath(canonicalPath(path))) return { isAtRisk: false, passReason: 'a temporary worktree' }
      if (path.includes('$')) return unmeasured('its path is a shell variable')
      return measureTree(path, git, isOwn, { statusArgs: [], includeIgnored: false, keep: () => true })
    }
    case 'branches':
      return measureBranches(impact.names, dir, git)
  }
}

const isUntracked = (e: StatusEntry) => e.code === '??' || e.code === '!!'

async function measureTree(
  dir: string,
  git: Git,
  isOwn: IsOwn,
  options: { statusArgs: string[]; includeIgnored: boolean; keep: (e: StatusEntry) => boolean; resetTarget?: string },
): Promise<Measured> {
  const top = (await git(dir, ['rev-parse', '--show-toplevel']))?.trim()
  if (!top) return unmeasured(`${dir} is not a git working tree`)
  const status = await git(dir, [
    'status',
    '--porcelain',
    '-z',
    '--untracked-files=all',
    ...(options.includeIgnored ? ['--ignored'] : []),
    ...options.statusArgs,
  ])
  if (status === undefined) return unmeasured('git status failed')
  let hit = parsePorcelainZ(status).filter(options.keep)

  if (options.resetTarget !== undefined) {
    const differ = await git(dir, ['diff', '--name-only', '-z', options.resetTarget, '--'])
    if (differ === undefined) return unmeasured(`git can't compare with ${options.resetTarget}`)
    const changed = new Set(differ.split('\0').filter(Boolean))
    hit = hit.filter(e => changed.has(e.path))
  }

  const where = top.split('/').filter(Boolean).pop() ?? top
  const own = hit.filter(e => isOwn(canonicalPath(`${top}/${e.path}`)))
  const atRisk = hit.filter(e => !own.includes(e))
  if (atRisk.length === 0) {
    return { isAtRisk: false, passReason: own.length > 0 ? `only Claude's own changes in ${where}` : `nothing uncommitted at risk in ${where}` }
  }
  return { isAtRisk: true, ...worktreeSection(atRisk, own.length, where) }
}

async function measureBranches(names: readonly string[], dir: string, git: Git): Promise<Measured> {
  if (names.length === 0) return { isAtRisk: true, summary: '' }
  if (names.some(n => n.includes('$'))) return unmeasured('a branch name is a shell variable')
  const defaultBranch = (await git(dir, ['rev-parse', '--abbrev-ref', 'origin/HEAD']))?.trim() || 'origin/main'
  const defaultTree = (await git(dir, ['rev-parse', `${defaultBranch}^{tree}`]))?.trim()

  const risky: { name: string; count: number; log: string }[] = []
  const safe: string[] = []
  for (const name of names.slice(0, 5)) {
    const count = Number((await git(dir, ['rev-list', '--count', name, '--not', '--remotes']))?.trim() ?? Number.NaN)
    if (count === 0) {
      safe.push(`${name} is on a remote`)
      continue
    }
    // Merging the branch into the default branch changes nothing: its work is already there
    // (the squash-merged case `branch -d` refuses).
    const merged = (await git(dir, ['merge-tree', '--write-tree', defaultBranch, name]))?.split('\n')[0]?.trim()
    if (defaultTree !== undefined && merged !== undefined && merged === defaultTree) {
      safe.push(`${name} is already in ${defaultBranch}`)
      continue
    }
    const log = (await git(dir, ['log', '--oneline', '-n', '8', name, '--not', '--remotes'])) ?? ''
    risky.push({ name, count: Number.isNaN(count) ? 0 : count, log })
  }
  if (names.length > 5) return { isAtRisk: true, summary: `${names.length} branches` }
  if (risky.length === 0) return { isAtRisk: false, passReason: safe.join('; ') }

  const first = risky[0]
  if (first === undefined) return { isAtRisk: true, summary: '' }
  if (first.count === 0) return unmeasured(`git can't read ${first.name}`)
  const { section, summary } = branchSection(first.name, first.count, first.log)
  return { isAtRisk: true, section, summary: [summary, ...risky.slice(1).map(r => `${r.name} has unpushed work`)].join('; ') }
}
