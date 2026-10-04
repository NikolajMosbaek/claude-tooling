import { describe, expect, test } from 'claude-code/testing'

import { type Git, measure, type Measured, parsePorcelainZ } from '../hooks/impact'
import { analyze } from '../hooks/risky'

const REPO = '/Users/me/repo'
const MAIN_TREE = 'aaaa111'

/** A git that answers only the calls listed, as `dir|args`; any other call fails, as git would. */
function fakeGit(answers: Record<string, string>): { git: Git; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    git: async (dir, args) => {
      const key = `${dir}|${args.join(' ')}`
      calls.push(key)
      return answers[key]
    },
  }
}

const z = (...entries: string[]) => entries.map(e => `${e}\0`).join('')
const nobodysOwn = () => false

/** Measures the single risky command in `commandLine`. */
async function measureOne(commandLine: string, git: Git, isOwn: (p: string) => boolean = nobodysOwn): Promise<Measured> {
  const [finding] = analyze(commandLine)
  if (!finding) throw new Error(`no finding in ${commandLine}`)
  return measure(finding, REPO, git, isOwn)
}

describe("each skill's own cleanup passes without asking", () => {
  test('/review-code removes its mktemp base tree', async () => {
    const { git, calls } = fakeGit({})
    const command = [
      'BASE_TREE="$(mktemp -d)/src"',
      'git -C /Users/me/repo worktree add --detach --quiet "$BASE_TREE" main',
      'git -C /Users/me/repo worktree remove --force "$BASE_TREE"',
    ].join('\n')
    expect((await measureOne(command, git)).isAtRisk).toBe(false)
    expect(calls).toEqual([])
  })

  test('/review-pr removes its tree from a function with a local variable', async () => {
    const { git } = fakeGit({})
    const command = 'cleanup() { local tree; tree="$(mktemp -d)/src"; git worktree add --detach --quiet "$tree" "$1"; git worktree remove --force "$tree"; }'
    expect((await measureOne(command, git)).isAtRisk).toBe(false)
  })

  test("/fix-issues discards the files it edited itself", async () => {
    const { git } = fakeGit({
      [`${REPO}|rev-parse --show-toplevel`]: `${REPO}\n`,
      [`${REPO}|status --porcelain -z --untracked-files=all -- Sources/A.swift Sources/B.swift`]: z(' M Sources/A.swift', ' M Sources/B.swift'),
    })
    const own = (p: string) => p === `${REPO}/Sources/A.swift` || p === `${REPO}/Sources/B.swift`
    const result = await measureOne('git -C /Users/me/repo checkout -- Sources/A.swift Sources/B.swift', git, own)
    expect(result).toEqual({ isAtRisk: false, passReason: "only Claude's own changes in repo" })
  })

  test('/squash-commits resets to ORIGINAL_HEAD while the tree still equals it', async () => {
    const { git } = fakeGit({
      [`${REPO}|rev-parse --show-toplevel`]: `${REPO}\n`,
      [`${REPO}|status --porcelain -z --untracked-files=all --`]: z('M  Sources/A.swift', 'A  Sources/New.swift'),
      [`${REPO}|diff --name-only -z abc1234 --`]: '',
    })
    expect((await measureOne('git -C /Users/me/repo reset --hard abc1234', git)).isAtRisk).toBe(false)
  })

  test('/prune-branches force-deletes a squash-merged branch', async () => {
    const { git } = fakeGit({
      [`${REPO}|rev-parse --abbrev-ref origin/HEAD`]: 'origin/main\n',
      [`${REPO}|rev-parse origin/main^{tree}`]: `${MAIN_TREE}\n`,
      [`${REPO}|rev-list --count feature/done --not --remotes`]: '3\n',
      [`${REPO}|merge-tree --write-tree origin/main feature/done`]: `${MAIN_TREE}\n`,
    })
    const result = await measureOne('git -C /Users/me/repo branch -D feature/done', git)
    expect(result).toEqual({ isAtRisk: false, passReason: 'feature/done is already in origin/main' })
  })
})

describe('it still asks when something not Claude\'s would be lost', () => {
  test("reset --hard over the person's own edits lists them, and counts Claude's", async () => {
    const { git } = fakeGit({
      [`${REPO}|rev-parse --show-toplevel`]: `${REPO}\n`,
      [`${REPO}|status --porcelain -z --untracked-files=all --`]: z(' M mine.swift', ' M claudes.swift', '?? notes.txt'),
      [`${REPO}|diff --name-only -z HEAD --`]: z('mine.swift', 'claudes.swift'),
    })
    const result = await measureOne('git reset --hard', git, p => p === `${REPO}/claudes.swift`)
    expect(result.isAtRisk).toBe(true)
    if (!result.isAtRisk) return
    expect(result.summary).toBe("1 uncommitted file in repo that Claude didn't change")
    expect(result.section?.rows.map(r => r.text)).toEqual(['mine.swift'])
    expect(result.section?.note).toBe('1 file Claude changed this session goes too')
  })

  test("checkout -- of a file the person had already changed", async () => {
    const { git } = fakeGit({
      [`${REPO}|rev-parse --show-toplevel`]: `${REPO}\n`,
      [`${REPO}|status --porcelain -z --untracked-files=all -- App.swift`]: z(' M App.swift'),
    })
    expect((await measureOne('git checkout -- App.swift', git)).isAtRisk).toBe(true)
  })

  test("clean -fd keeps Claude's new files out of it but not the person's", async () => {
    const { git } = fakeGit({
      [`${REPO}|rev-parse --show-toplevel`]: `${REPO}\n`,
      [`${REPO}|status --porcelain -z --untracked-files=all --`]: z('?? gen/claude.txt', '?? draft.md'),
    })
    const result = await measureOne('git clean -fd', git, p => p === `${REPO}/gen/claude.txt`)
    expect(result.isAtRisk).toBe(true)
    if (result.isAtRisk) expect(result.section?.rows.map(r => r.text)).toEqual(['draft.md'])
  })

  test('branch -D of unpushed, unmerged work lists the commits', async () => {
    const { git } = fakeGit({
      [`${REPO}|rev-parse --abbrev-ref origin/HEAD`]: 'origin/main\n',
      [`${REPO}|rev-parse origin/main^{tree}`]: `${MAIN_TREE}\n`,
      [`${REPO}|rev-list --count spike --not --remotes`]: '2\n',
      [`${REPO}|merge-tree --write-tree origin/main spike`]: 'bbbb222\n',
      [`${REPO}|log --oneline -n 8 spike --not --remotes`]: 'c1 try a\nc2 try b\n',
    })
    const result = await measureOne('git branch -D spike', git)
    expect(result.isAtRisk).toBe(true)
    if (result.isAtRisk) expect(result.section?.rows.map(r => r.mark)).toEqual(['c1', 'c2'])
  })

  test('worktree remove --force of a real worktree with work in it', async () => {
    const { git } = fakeGit({
      [`${REPO}/.worktrees/x|rev-parse --show-toplevel`]: `${REPO}/.worktrees/x\n`,
      [`${REPO}/.worktrees/x|status --porcelain -z --untracked-files=all`]: z(' M a.swift'),
    })
    expect((await measureOne('git worktree remove --force .worktrees/x', git)).isAtRisk).toBe(true)
  })

  test('stash drop has nothing to measure, so it always asks', async () => {
    const { git, calls } = fakeGit({})
    expect((await measureOne('git stash drop', git)).isAtRisk).toBe(true)
    expect(calls).toEqual([])
  })
})

describe('what cannot be measured counts as at risk', () => {
  test('a directory held in a variable the command never set', async () => {
    const result = await measureOne('git -C "$REPO_DIR" reset --hard', fakeGit({}).git)
    expect(result.isAtRisk).toBe(true)
    if (result.isAtRisk) expect(result.section?.title).toContain("couldn't check")
  })

  test('git failing', async () => {
    expect((await measureOne('git reset --hard', fakeGit({}).git)).isAtRisk).toBe(true)
  })

  test('a branch git cannot read', async () => {
    const { git } = fakeGit({ [`${REPO}|rev-parse --abbrev-ref origin/HEAD`]: 'origin/main\n' })
    expect((await measureOne('git branch -D ghost', git)).isAtRisk).toBe(true)
  })
})

test('porcelain -z: a rename takes two fields and only the new path counts', () => {
  expect(parsePorcelainZ(z('R  new.swift', 'old.swift', ' M other.swift'))).toEqual([
    { code: 'R ', path: 'new.swift' },
    { code: ' M', path: 'other.swift' },
  ])
})
