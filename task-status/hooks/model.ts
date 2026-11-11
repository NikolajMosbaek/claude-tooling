import type { Activity, PhaseId, PlanStep, StepStatus, TaskStatus } from '../types'

export const PHASES: readonly { id: PhaseId; title: string }[] = [
  { id: 'plan', title: 'Plan' },
  { id: 'dev', title: 'Development' },
  { id: 'test', title: 'Test' },
  { id: 'bugfix', title: 'Bug fixing' },
  { id: 'pr', title: 'Creating PR' },
]

export const EMPTY: TaskStatus = { steps: [], commits: [], activities: [] }

// First match wins, so the order settles overlaps: "review and fix" is Bug
// fixing, not Development; "push + draft PR" is Creating PR, not Plan.
const KEYWORDS: readonly [PhaseId, RegExp][] = [
  ['pr', /\bpush\b|\bpull request\b|\bPRs?\b|squash|\breport\b/i],
  ['bugfix', /\breview\b|review-|fix[- ]loop|\bbug\b|address (?:review|comment|finding)|\bfindings?\b/i],
  ['test', /\btests?\b|\btesting\b|\bsuite\b|\bverify\b|\bvalidate\b|type-check/i],
  ['plan', /\bplan\b|\bplanning\b|\bdesign\b|brainstorm|\bspec\b|investigat|\bexplore\b|look at|read (?:the )?(?:task|ticket|work item)/i],
  ['dev', /\bimplement|\bcommit|\bdocs?\b|\bwrite\b|\badd\b|\bbuild\b|\brefactor/i],
]

export function matchPhase(text: string): PhaseId | undefined {
  return KEYWORDS.find(([, re]) => re.test(text))?.[0]
}

// Only skills whose names no keyword catches; the rest go by keyword.
const SKILL_PHASES: Record<string, PhaseId> = {
  'writing-plans': 'plan',
  simplify: 'bugfix',
}

/** A skill's phase from its name (`plugin:name` or `name`); undefined when nothing matches. */
export function skillPhase(skill: string): PhaseId | undefined {
  const bare = skill.split(':').pop() ?? skill
  return SKILL_PHASES[bare] ?? matchPhase(bare.replace(/-/g, ' '))
}

/** A plan step always lands somewhere: Development when nothing matches. */
export function phaseOfStep(content: string): PhaseId {
  return matchPhase(content) ?? 'dev'
}

const STATUSES: readonly StepStatus[] = ['pending', 'in_progress', 'completed']

function toSteps(items: unknown): PlanStep[] | undefined {
  if (!Array.isArray(items)) return undefined
  return items.flatMap(item => {
    if (typeof item !== 'object' || item === null) return []
    const { content, status } = item as Record<string, unknown>
    if (typeof content !== 'string') return []
    const known = STATUSES.find(s => s === status)
    return [{ content, status: known ?? 'pending' }]
  })
}

function oneBased(value: unknown): number[] {
  const list = Array.isArray(value) ? value : value === undefined ? [] : [value]
  return list.filter((n): n is number => typeof n === 'number' && Number.isInteger(n)).map(n => n - 1)
}

/** Applies one `update_plan` call: a whole new list, or advance/done/start deltas. */
export function applyPlanUpdate(steps: PlanStep[], args: Record<string, unknown>): PlanStep[] {
  const replaced = toSteps(args.items)
  if (replaced !== undefined) return replaced

  let next = steps.map(s => ({ ...s }))
  if (args.advance === true) {
    const current = next.findIndex(s => s.status === 'in_progress')
    if (current >= 0) next[current] = { ...next[current]!, status: 'completed' }
    const from = current >= 0 ? current + 1 : 0
    const upcoming = next.findIndex((s, i) => i >= from && s.status === 'pending')
    if (upcoming >= 0) next[upcoming] = { ...next[upcoming]!, status: 'in_progress' }
  }
  for (const i of oneBased(args.done)) {
    if (next[i]) next[i] = { ...next[i]!, status: 'completed' }
  }
  for (const i of oneBased(args.start)) {
    if (next[i]) {
      next = next.map(s => (s.status === 'in_progress' ? { ...s, status: 'pending' } : s))
      next[i] = { ...next[i]!, status: 'in_progress' }
    }
  }
  return next
}

/** `TodoWrite` always sends the whole list. */
export function stepsFromTodos(todos: unknown): PlanStep[] | undefined {
  return toSteps(todos)
}

export function addTask(steps: PlanStep[], id: string, subject: string): PlanStep[] {
  return [...steps.filter(s => s.id !== id), { id, content: subject, status: 'pending' }]
}

/** Applies a `TaskUpdate`; a task this session never saw created is ignored. */
export function updateTask(
  steps: PlanStep[],
  args: { taskId: string; subject?: string; status?: string },
): PlanStep[] {
  if (args.status === 'deleted') return steps.filter(s => s.id !== args.taskId)
  const status = STATUSES.find(s => s === args.status)
  return steps.map(s =>
    s.id === args.taskId
      ? { ...s, content: args.subject ?? s.content, status: status ?? s.status }
      : s,
  )
}

/** `wrap_up` checks off whatever step is still in progress. */
export function completeInProgress(steps: PlanStep[]): PlanStep[] {
  return steps.map(s => (s.status === 'in_progress' ? { ...s, status: 'completed' } : s))
}

export function commitSubject(command: string): string | undefined {
  if (!/\bgit\b(?:\s+-\S+(?:\s+\S+)?)*\s+commit\b/.test(command)) return undefined
  const heredoc = /<<-?\s*'?"?(\w+)'?"?\s*\n\s*([^\n]+)/.exec(command)
  if (heredoc?.[2]) return heredoc[2].trim()
  const flag = /\s-m\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))/.exec(command)
  const message = flag?.[1] ?? flag?.[2] ?? flag?.[3]
  return message?.split('\n')[0]?.trim() || 'commit'
}

export type BashActivity = { phase: PhaseId; label: string }

export function bashActivity(command: string): BashActivity | undefined {
  if (/\bxcodebuild\b[^\n|;&]*\btest(?:-without-building)?\b/.test(command)) return { phase: 'test', label: 'xcodebuild test' }
  if (/\bswift\s+test\b/.test(command)) return { phase: 'test', label: 'swift test' }
  if (/\bclaude\s+plugin\s+test\b/.test(command)) return { phase: 'test', label: 'claude plugin test' }
  if (/\bgit\s+push\b/.test(command)) return { phase: 'pr', label: 'git push' }
  if (/\b(?:gh\s+pr\s+create|az\s+repos\s+pr\s+create)\b/.test(command)) return { phase: 'pr', label: 'creating PR' }
  return undefined
}

/** Starting an activity retires any background one of the same phase it supersedes. */
export function startActivity(status: TaskStatus, activity: Activity): TaskStatus {
  const others = status.activities.map(a =>
    a.phase === activity.phase && a.isRunning && a.isBackground && !a.agentId ? { ...a, isRunning: false } : a,
  )
  return { ...status, activities: [...others, activity].slice(-50) }
}

export function finishActivity(
  status: TaskStatus,
  id: string,
  outcome: { isBackground: boolean; agentId?: string },
): TaskStatus {
  return {
    ...status,
    activities: status.activities.map(a =>
      a.id === id
        ? outcome.isBackground
          ? { ...a, isBackground: true, agentId: outcome.agentId }
          : { ...a, isRunning: false }
        : a,
    ),
  }
}

/**
 * A background command reports no end of its own, so the plan stands in for
 * it: once its phase has a checked-off step and none in progress, it is over.
 */
export function withSteps(status: TaskStatus, steps: PlanStep[]): TaskStatus {
  const isSettled = (phase: PhaseId) => {
    const own = steps.filter(s => phaseOfStep(s.content) === phase)
    return own.some(s => s.status === 'completed') && !own.some(s => s.status === 'in_progress')
  }
  return {
    ...status,
    steps,
    activities: status.activities.map(a =>
      a.isRunning && a.isBackground && !a.agentId && isSettled(a.phase) ? { ...a, isRunning: false } : a,
    ),
  }
}

export function finishAgent(status: TaskStatus, agentId: string): TaskStatus {
  if (!status.activities.some(a => a.agentId === agentId && a.isRunning)) return status
  return {
    ...status,
    activities: status.activities.map(a => (a.agentId === agentId ? { ...a, isRunning: false } : a)),
  }
}

export type PhaseState = 'done' | 'active' | 'idle'

export type PhaseView = {
  id: PhaseId
  title: string
  state: PhaseState
  detail: string
  steps: PlanStep[]
}

function activityLabel(a: Activity): string {
  return a.isRunning ? `${a.label} — ${a.isBackground ? 'running in background' : 'running'}` : `${a.label} — done`
}

export function phaseViews(status: TaskStatus): PhaseView[] {
  return PHASES.map(({ id, title }) => {
    const steps = status.steps.filter(s => phaseOfStep(s.content) === id)
    const activities = status.activities.filter(a => a.phase === id)
    const running = activities.filter(a => a.isRunning)
    const current = steps.find(s => s.status === 'in_progress')
    const completed = steps.filter(s => s.status === 'completed')
    const commits = id === 'dev' ? status.commits : []

    const isStepsDone = steps.length > 0 && completed.length === steps.length
    const isStepsStarted = current !== undefined || (completed.length > 0 && !isStepsDone)
    const state: PhaseState =
      running.length > 0 || isStepsStarted
        ? 'active'
        : isStepsDone || (steps.length === 0 && (activities.length > 0 || commits.length > 0))
          ? 'done'
          : 'idle'

    const progress = steps.length > 0 ? `${completed.length}/${steps.length} · ` : ''
    const lastActivity = activities[activities.length - 1]
    const detail = current
      ? `${progress}${current.content}`
      : running[0]
        ? `${progress}${activityLabel(running[0])}`
        : state === 'done'
          ? `${progress}${lastActivity ? activityLabel(lastActivity) : (completed[completed.length - 1]?.content ?? commits[commits.length - 1] ?? 'done')}`
          : steps.length > 0
            ? `${progress}next: ${steps.find(s => s.status === 'pending')?.content ?? ''}`
            : 'not started'
    return { id, title, state, detail, steps }
  })
}

export const MARK: Record<PhaseState, string> = { done: '✅', active: '🔄', idle: '⏳' }
const STEP_MARK: Record<StepStatus, string> = { completed: '✅', in_progress: '🔄', pending: '⏳' }

export function stepMark(status: StepStatus): string {
  return STEP_MARK[status]
}

export function overviewText(status: TaskStatus): string {
  if (status.steps.length === 0 && status.activities.length === 0 && status.commits.length === 0) {
    return 'No task activity seen in this session yet.'
  }
  const lines: string[] = []
  for (const view of phaseViews(status)) {
    lines.push(`${MARK[view.state]} ${view.title} — ${view.detail}`)
    if (view.id === 'dev') {
      for (const step of view.steps) lines.push(`    ${stepMark(step.status)} ${step.content}`)
      for (const commit of status.commits) lines.push(`    • commit: ${commit}`)
    }
  }
  return lines.join('\n')
}
