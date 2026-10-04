// /wt's pure half: reading `git worktree list --porcelain` and laying the table out.

export type Worktree = {
  path: string
  head?: string
  /** `main`, `feature/x`; absent when detached or bare. */
  branch?: string
  isDetached: boolean
  isBare: boolean
  isLocked: boolean
  isPrunable: boolean
}

export function parseWorktrees(porcelain: string): Worktree[] {
  const trees: Worktree[] = []
  for (const block of porcelain.split(/\n\s*\n/)) {
    const tree: Worktree = { path: '', isDetached: false, isBare: false, isLocked: false, isPrunable: false }
    for (const line of block.split('\n')) {
      const [key = '', ...rest] = line.split(' ')
      const value = rest.join(' ')
      if (key === 'worktree') tree.path = value
      if (key === 'HEAD') tree.head = value
      if (key === 'branch') tree.branch = value.replace(/^refs\/heads\//, '')
      if (key === 'detached') tree.isDetached = true
      if (key === 'bare') tree.isBare = true
      if (key === 'locked') tree.isLocked = true
      if (key === 'prunable') tree.isPrunable = true
    }
    if (tree.path !== '') trees.push(tree)
  }
  return trees
}

/** The worktree `cwd` is inside: the deepest one whose path holds it. */
export function currentWorktree(trees: readonly Worktree[], cwd: string): Worktree | undefined {
  return trees
    .filter(t => cwd === t.path || cwd.startsWith(`${t.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0]
}

/** `changes[i]` is the uncommitted-file count of `trees[i]`, or undefined when it couldn't be read. */
export function formatWorktrees(
  trees: readonly Worktree[],
  changes: readonly (number | undefined)[],
  cwd: string,
): string {
  const main = trees[0]
  const current = currentWorktree(trees, cwd)
  const name = (t: Worktree) =>
    t === main ? '(main checkout)' : main && t.path.startsWith(`${main.path}/`) ? t.path.slice(main.path.length + 1) : t.path
  const branch = (t: Worktree) => (t.isBare ? '(bare)' : (t.branch ?? '(detached)'))
  const state = (t: Worktree, i: number) => {
    const n = changes[i]
    const counted = n === undefined ? '?' : n === 0 ? 'clean' : `${n} changed`
    return [counted, t.isLocked ? 'locked' : '', t.isPrunable ? 'prunable' : ''].filter(Boolean).join(', ')
  }

  const rows = trees.map((t, i) => [t === current ? '→' : ' ', name(t), branch(t), (t.head ?? '').slice(0, 8), state(t, i)])
  const header = [' ', 'WORKTREE', 'BRANCH', 'HEAD', 'CHANGES']
  const widths = header.map((h, c) => Math.max(h.length, ...rows.map(r => (r[c] ?? '').length)))
  const line = (cells: string[]) =>
    cells
      .map((cell, c) => (c === cells.length - 1 ? cell : cell.padEnd(widths[c] ?? 0)))
      .join('  ')
      .trimEnd()

  const here = current
    ? `This session is in ${name(current)} on ${branch(current)}` +
      (cwd === current.path ? '.' : ` (cwd ${cwd.slice(current.path.length + 1)}).`)
    : `This session's directory, ${cwd}, is in none of these worktrees.`
  return [here, '', line(header), ...rows.map(line)].join('\n')
}
