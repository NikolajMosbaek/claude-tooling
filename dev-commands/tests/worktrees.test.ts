import { expect, test } from 'claude-code/testing'

import { currentWorktree, formatWorktrees, parseWorktrees } from '../hooks/worktrees'

const PORCELAIN = [
  'worktree /repo',
  'HEAD 0c8f3493aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  'branch refs/heads/main',
  '',
  'worktree /repo/.worktrees/565427-bff',
  'HEAD 0c8f3493bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  'detached',
  '',
  'worktree /repo/.worktrees/123-camera',
  'HEAD fc2ab738cccccccccccccccccccccccccccccccc',
  'branch refs/heads/bugfix/me/123-camera',
  'locked',
  '',
].join('\n')

test('parses branches, detached heads and flags', () => {
  const trees = parseWorktrees(PORCELAIN)
  expect(trees.map(t => [t.path, t.branch, t.isDetached, t.isLocked])).toEqual([
    ['/repo', 'main', false, false],
    ['/repo/.worktrees/565427-bff', undefined, true, false],
    ['/repo/.worktrees/123-camera', 'bugfix/me/123-camera', false, true],
  ])
})

test('the current worktree is the deepest one holding the cwd, not the main checkout around it', () => {
  const trees = parseWorktrees(PORCELAIN)
  expect(currentWorktree(trees, '/repo/.worktrees/123-camera/App')?.path).toBe('/repo/.worktrees/123-camera')
  expect(currentWorktree(trees, '/repo/App')?.path).toBe('/repo')
  expect(currentWorktree(trees, '/repo-other')).toBeUndefined()
})

test('the table marks the current row and counts changes', () => {
  const text = formatWorktrees(parseWorktrees(PORCELAIN), [0, 2, undefined], '/repo/.worktrees/565427-bff')
  const [summary, , header, ...rows] = text.split('\n')
  expect(summary).toBe('This session is in .worktrees/565427-bff on (detached).')
  expect(header).toContain('WORKTREE')
  expect(rows.find(l => l.startsWith('→'))).toContain('.worktrees/565427-bff')
  expect(rows.find(l => l.includes('(main checkout)'))).toContain('clean')
  expect(rows.find(l => l.includes('565427'))).toContain('2 changed')
  expect(rows.find(l => l.includes('123'))).toContain('?, locked')
})
