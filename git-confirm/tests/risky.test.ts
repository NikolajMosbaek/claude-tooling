import { describe, expect, test } from 'claude-code/testing'

import { analyze } from '../hooks/risky'

const kinds = (command: string) => analyze(command).map(f => f.kind)

describe('force-push is refused in every spelling the settings guard knows', () => {
  for (const command of [
    'git push --force',
    'git push -f origin main',
    'git push -uf origin feature/x',
    'git push --force-with-lease',
    'git push --force-with-lease=main:abc123 origin main',
    'git push origin +main',
    'git push origin "+HEAD:main"',
    'git -C "/path with space" push --force',
    'cd repo && git push -f',
    "bash -c 'git push --force'",
  ]) {
    test(command, () => expect(kinds(command)).toEqual(['force-push']))
  }
})

describe('destructive commands ask first', () => {
  for (const command of [
    'git reset --hard',
    'git reset --hard HEAD~1',
    'git checkout -- App/App.swift',
    'git checkout main -- .',
    'git checkout .',
    'git checkout -f main',
    'git switch --discard-changes main',
    'git restore App/App.swift',
    'git restore --staged --worktree .',
    'git clean -fd',
    'git clean -fdx',
    'git branch -D feature/old',
    'git branch --delete --force feature/old',
    'git push origin --delete feature/old',
    'git push origin :feature/old',
    'git stash drop',
    'git stash clear',
    'git worktree remove --force .worktrees/x',
    'git status && git reset --hard origin/main',
  ]) {
    test(command, () => expect(kinds(command)).toEqual(['confirm']))
  }
})

describe('everyday commands pass untouched', () => {
  for (const command of [
    'git status',
    'git push',
    'git push -u origin feature/x',
    'git push --follow-tags',
    'git reset HEAD file.swift',
    'git reset --soft HEAD~1',
    'git checkout main',
    'git checkout -b feature/new origin/main',
    'git switch -c feature/new',
    'git restore --staged file.swift',
    'git clean -n',
    'git clean -fdn',
    'git branch -d merged-branch',
    'git stash pop',
    'git worktree remove .worktrees/x',
    'echo "git reset --hard"',
    'git commit -m "never git push --force here"',
    "git log --grep='reset --hard'",
    'xcodebuild test > build.log 2>&1',
  ]) {
    test(command, () => expect(kinds(command)).toEqual([]))
  }
})

test('a heredoc commit message holding risky words and quotes is one opaque argument', () => {
  const command = [
    'git commit -m "$(cat <<\'EOF\'',
    'fix: stop "git reset --hard" from eating work',
    '',
    'Also never run git push -f; it\'s blocked.',
    'EOF',
    ')"',
  ].join('\n')
  expect(analyze(command)).toEqual([])
})

test('a top-level heredoc body is not read as commands', () => {
  const command = ['cat > notes.txt <<EOF', 'git reset --hard', 'EOF', 'git status'].join('\n')
  expect(analyze(command)).toEqual([])
})

test('the directory git runs in follows -C and a preceding cd', () => {
  expect(analyze('git -C .worktrees/x reset --hard')[0]?.dir).toBe('.worktrees/x')
  expect(analyze('cd .worktrees/x && git clean -fd')[0]?.dir).toBe('.worktrees/x')
  expect(analyze('cd /abs && git -C sub reset --hard')[0]?.dir).toBe('/abs/sub')
})

test('a force-deleted branch is named for the impact check', () => {
  expect(analyze('git branch -D feature/a feature/b')[0]?.impact).toEqual({
    kind: 'branches',
    names: ['feature/a', 'feature/b'],
  })
})
