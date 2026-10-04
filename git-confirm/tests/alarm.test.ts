import { describe, expect, test } from 'claude-code/testing'

import { type Alarm, branchSection, fitAlarm, MAX_ROWS, SECTION_ROWS, sectionHeight, worktreeSection } from '../hooks/alarm'
import { analyze } from '../hooks/risky'

const ENTRIES = [
  { code: ' M', path: 'App/App.swift' },
  { code: 'D ', path: 'Feature/Old.swift' },
]

test('the at-risk files are listed with their status colours', () => {
  const { section, summary } = worktreeSection(ENTRIES, 0, 'my-app')
  expect(summary).toBe("2 uncommitted files in my-app that Claude didn't change")
  expect(section.title).toBe('💥 at risk in my-app:')
  expect(section.rows).toEqual([
    { mark: ' M', color: 'yellow', text: 'App/App.swift' },
    { mark: 'D ', color: 'red', text: 'Feature/Old.swift' },
  ])
  expect(section.note).toBeUndefined()
})

test("Claude's own files that go too are counted underneath", () => {
  expect(worktreeSection(ENTRIES, 1, 'x').section.note).toBe('1 file Claude changed this session goes too')
})

test('long lists are cut, with a count of the rest', () => {
  const many = Array.from({ length: MAX_ROWS + 3 }, (_, i) => ({ code: ' M', path: `f${i}.swift` }))
  const { section } = worktreeSection(many, 0, 'x')
  expect(section.rows.length).toBe(MAX_ROWS)
  expect(section.more).toBe(3)
})

test('a force-deleted branch lists its unpushed commits', () => {
  const { section, summary } = branchSection('feature/x', 2, 'abc1234 add thing\ndef5678 fix thing\n')
  expect(summary).toBe('feature/x has 2 commits on no remote')
  expect(section.rows).toEqual([
    { mark: 'abc1234', color: 'yellow', text: 'add thing' },
    { mark: 'def5678', color: 'yellow', text: 'fix thing' },
  ])
  expect(branchSection('feature/x', 0, '').section.title).toBe('✔ feature/x is all on a remote')
})

test('each destructive command says which files it hits', () => {
  expect(analyze('git reset --hard')[0]?.impact).toEqual({ kind: 'worktree', hits: 'tracked', resetTarget: 'HEAD' })
  expect(analyze('git clean -fd')[0]?.impact).toEqual({ kind: 'worktree', hits: 'untracked', includeIgnored: false })
})

describe('the frame fits the 12 rows the engine allows around its dialog', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ mark: ' M', color: 'yellow', text: `f${i}` }))
  const height = (alarm: Alarm) => alarm.sections.reduce((sum, s) => sum + sectionHeight(s), 0)

  test('a long file list is cut into "more", within the budget', () => {
    const fitted = fitAlarm({ sections: [{ title: 't', color: 'red', rows: rows(8), more: 0, note: '1 survives' }] })
    expect(height(fitted) <= SECTION_ROWS).toBe(true)
    expect(fitted.sections[0]?.rows.length).toBe(SECTION_ROWS - 2)
    expect(fitted.sections[0]?.more).toBe(8 - (SECTION_ROWS - 2))
  })
  test('the longest of several lists gives way first', () => {
    const fitted = fitAlarm({
      sections: [
        { title: 'a', color: 'red', rows: rows(6), more: 0 },
        { title: 'b', color: 'red', rows: rows(2), more: 0 },
      ],
    })
    expect(height(fitted) <= SECTION_ROWS).toBe(true)
    // a: title + 3 rows + "… 3 more" = 5; b: title + 2 rows = 3; 8 rows in all
    expect(fitted.sections.map(s => s.rows.length)).toEqual([3, 2])
  })
  test('sections past what any cut can fit are dropped, never the budget', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ title: `s${i}`, color: 'red', rows: rows(1), more: 0 }))
    expect(height(fitAlarm({ sections: many })) <= SECTION_ROWS).toBe(true)
  })
  test('a small alarm is left alone', () => {
    const small = { sections: [{ title: 't', color: 'red', rows: rows(3), more: 0 }] }
    expect(fitAlarm(small)).toEqual(small)
  })
})
