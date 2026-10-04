import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { CANCEL, PROCEED } from '../hooks/register'

/** Stands for the engine's Bash: counts the commands that actually ran. */
function fakeBash(on: On): string[] {
  const ran: string[] = []
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    ran.push(e.command)
    return { result: { stdout: 'ok', stderr: '', interrupted: false } }
  })
  return ran
}

/** Stands for the person: answers the dialog with `answer`, or as the engine does when they were away. */
function fakePerson(on: On, answer: { pick: string } | { awayAfterMs: number }): string[] {
  const asked: string[] = []
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    const question = e.questions[0]?.question ?? ''
    asked.push(question)
    const answers: Record<string, string> = 'pick' in answer ? { [question]: answer.pick } : { [question]: PROCEED }
    return {
      result: {
        questions: e.questions,
        answers,
        ...('awayAfterMs' in answer ? { afkTimeoutMs: answer.awayAfterMs } : {}),
      },
    }
  })
  return asked
}

test('Proceed runs the risky command', async ($, on) => {
  const ran = fakeBash(on)
  const asked = fakePerson(on, { pick: PROCEED })

  const result = await $.tool.call({ tool: 'Bash', command: 'git reset --hard HEAD~1' })

  expect(result.deny).toBeUndefined()
  expect(ran).toEqual(['git reset --hard HEAD~1'])
  expect(asked[0]).toContain('`git reset --hard HEAD~1` discards every uncommitted change')
  expect(asked[0]?.endsWith('Run it?')).toBe(true)
})

test('Cancel refuses it and tells Claude not to retry', async ($, on) => {
  const ran = fakeBash(on)
  fakePerson(on, { pick: CANCEL })

  const result = await $.tool.call({ tool: 'Bash', command: 'git clean -fd' })

  expect(ran).toEqual([])
  expect(result.deny).toContain('the user cancelled `git clean -fd`')
})

test('free text typed under Other is passed on as the reason', async ($, on) => {
  const ran = fakeBash(on)
  fakePerson(on, { pick: 'stash it first' })

  const result = await $.tool.call({ tool: 'Bash', command: 'git checkout -- .' })

  expect(ran).toEqual([])
  expect(result.deny).toContain('They said: "stash it first"')
})

test('a dialog that resolved itself while the person was away never counts as Proceed', async ($, on) => {
  const ran = fakeBash(on)
  fakePerson(on, { awayAfterMs: 60_000 })

  const result = await $.tool.call({ tool: 'Bash', command: 'git branch -D feature/old' })

  expect(ran).toEqual([])
  expect(result.deny).toContain('none was given')
})

test('force-push is refused without asking', async ($, on) => {
  const ran = fakeBash(on)
  const asked = fakePerson(on, { pick: PROCEED })

  const result = await $.tool.call({ tool: 'Bash', command: 'git push --force-with-lease origin main' })

  expect(ran).toEqual([])
  expect(asked).toEqual([])
  expect(result.deny).toContain('Force-pushing is never allowed')
})

test('everyday git runs without a dialog', async ($, on) => {
  const ran = fakeBash(on)
  const asked = fakePerson(on, { pick: CANCEL })

  await $.tool.call({ tool: 'Bash', command: 'git status && git push -u origin feature/x' })

  expect(asked).toEqual([])
  expect(ran).toEqual(['git status && git push -u origin feature/x'])
})
