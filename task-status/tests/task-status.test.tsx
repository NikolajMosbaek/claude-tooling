import { expect, test } from 'claude-code/testing'

import { phaseOfStep, skillPhase } from '../hooks/model'

const PANE = {
  plugin: 'task-status',
  component: 'Pane',
  requestId: 'task-status',
  props: {
    title: 'Task status',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const PLAN = 'mcp__ccd_turn__update_plan' as const

const GO_AUTO_PLAN = [
  { content: 'Plan the change', status: 'in_progress' },
  { content: 'Implement the timeout', status: 'pending' },
  { content: 'Commit and update docs', status: 'pending' },
  { content: 'Run the full test suite', status: 'pending' },
  { content: 'Review and fix', status: 'pending' },
  { content: 'Push and open draft PR', status: 'pending' },
  { content: 'Report', status: 'pending' },
]

test('plan steps map to their phases by keyword', () => {
  expect(GO_AUTO_PLAN.map(s => phaseOfStep(s.content))).toEqual([
    'plan', 'dev', 'dev', 'test', 'bugfix', 'pr', 'pr',
  ])
  expect(phaseOfStep('Something unlabelled')).toBe('dev')
})

test('the pane follows update_plan as steps advance, on every surface', async ($, on) => {
  on('command.register', () => ({ value: { command: 'task-status' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  async function rows(surface: 'terminal' | 'desktop') {
    const ui = await $.ui.mount({ ...PANE, surface })
    const texts = (await ui.findAll({ type: 'Text' })).map(t => t.text)
    await ui.unmount()
    return texts
  }

  await $.tool.call({ tool: PLAN, items: GO_AUTO_PLAN })
  for (const surface of ['terminal', 'desktop'] as const) {
    const texts = await rows(surface)
    expect(texts).toContain('🔄 Plan')
    expect(texts).toContain('⏳ Development')
    expect(texts).toContain('   ⏳ Implement the timeout')
  }

  await $.tool.call({ tool: PLAN, advance: true })
  await $.tool.call({ tool: 'Bash', command: 'git commit -m "feat: add timeout"' })
  let texts = await rows('desktop')
  expect(texts).toContain('✅ Plan')
  expect(texts).toContain('🔄 Development')
  expect(texts).toContain('   0/2 · Implement the timeout')
  expect(texts).toContain('   • feat: add timeout')

  await $.tool.call({ tool: PLAN, advance: true })
  await $.tool.call({ tool: PLAN, advance: true })
  texts = await rows('desktop')
  expect(texts).toContain('✅ Development')
  expect(texts).toContain('🔄 Test')
  expect(texts).toContain('⏳ Bug fixing')

  await $.tool.call({ tool: PLAN, done: [4], start: 6 })
  texts = await rows('desktop')
  expect(texts).toContain('✅ Test')
  expect(texts).toContain('⏳ Bug fixing')
  expect(texts).toContain('🔄 Creating PR')
})

test('/task-status prints the overview as text', async ($, on) => {
  on('command.register', () => ({ value: { command: 'task-status' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: PLAN, items: GO_AUTO_PLAN })
  await $.tool.call({ tool: PLAN, advance: true })

  const ran = await $.command.run({ command: 'task-status', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 } })
  const text = 'text' in ran ? String(ran.text) : ''
  expect(text).toContain('✅ Plan')
  expect(text).toContain('🔄 Development — 0/2 · Implement the timeout')
  expect(text).toContain('⏳ Creating PR')
})

test('a background agent stays running until its own turn completes', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', () => ({ result: { status: 'async_launched', agentId: 'a1', description: 'x' } }))
  on('turn.complete', () => ({ text: '' }))

  await $.tool.call({ tool: 'Agent', description: 'review and fix', prompt: 'go' })
  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /review and fix/ }))?.text).toBe(
    '   agent: review and fix — running in background',
  )
  await ui.unmount()

  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't', agentId: 'a1', reason: 'answer' })
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /review and fix/ }))?.text).toBe('   agent: review and fix — done')
  expect((await ui.find({ type: 'Text', text: /Bug fixing/ }))?.text).toBe('✅ Bug fixing')
  await ui.unmount()
})

test('a background test run ends when the plan checks off its test step', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', () => ({ result: {} }))

  await $.tool.call({ tool: PLAN, items: GO_AUTO_PLAN })
  await $.tool.call({ tool: PLAN, start: 4 })
  await $.tool.call({
    tool: 'Bash',
    command: "xcodebuild -scheme App test > build.log 2>&1",
    run_in_background: true,
  })
  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Test$/ }))?.text).toBe('🔄 Test')
  await ui.unmount()

  await $.tool.call({ tool: PLAN, advance: true })
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /Test$/ }))?.text).toBe('✅ Test')
  expect((await ui.find({ type: 'Text', text: /xcodebuild/ }))?.text).toBe('   1/1 · xcodebuild test — done')
  await ui.unmount()
})

test('a terminal TodoWrite list drives the phases too', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', () => ({ result: {} }))

  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Design the API', status: 'completed', activeForm: 'Designing the API' },
      { content: 'Implement the endpoint', status: 'in_progress', activeForm: 'Implementing' },
      { content: 'Run the test suite', status: 'pending', activeForm: 'Testing' },
    ],
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Plan$/ }))?.text).toBe('✅ Plan')
  expect((await ui.find({ type: 'Text', text: /Development$/ }))?.text).toBe('🔄 Development')
  expect((await ui.find({ type: 'Text', text: /Test$/ }))?.text).toBe('⏳ Test')
  await ui.unmount()
})

test('TaskCreate and TaskUpdate build and advance the list by id', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  let next = 0
  on('tool.call', (_, e) => (e.tool === 'TaskCreate' ? { result: { task: { id: String(++next), subject: e.subject } } } : { result: {} }))

  await $.tool.call({ tool: 'TaskCreate', subject: 'Implement the endpoint', description: '' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'Open a pull request', description: '' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '2', status: 'in_progress' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /Development$/ }))?.text).toBe('✅ Development')
  expect((await ui.find({ type: 'Text', text: /Creating PR$/ }))?.text).toBe('🔄 Creating PR')
  await ui.unmount()
})

test('skills land in a phase by name, keyword first', () => {
  expect(
    ['unit-tests', 'fix-review-findings', 'open-pr', 'squash-history', 'code-review', 'brainstorming'].map(skillPhase),
  ).toEqual(['test', 'bugfix', 'pr', 'pr', 'bugfix', 'plan'])
  expect(skillPhase('superpowers:writing-plans')).toBe('plan')
  expect(skillPhase('simplify')).toBe('bugfix')
  expect(skillPhase('pdf')).toBeUndefined()
})
