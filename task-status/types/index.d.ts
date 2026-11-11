export type PhaseId = 'plan' | 'dev' | 'test' | 'bugfix' | 'pr'

export type StepStatus = 'pending' | 'in_progress' | 'completed'

/** `id` is set for steps made with `TaskCreate`, which `TaskUpdate` addresses by it. */
export type PlanStep = { content: string; status: StepStatus; id?: string }

/** Something seen running outside the plan: a test command, a push, an agent or skill. */
export type Activity = {
  id: string
  phase: PhaseId
  label: string
  isRunning: boolean
  isBackground: boolean
  /** The background agent's id, matched against its `turn.complete`. */
  agentId?: string
}

export type TaskStatus = {
  steps: PlanStep[]
  commits: string[]
  activities: Activity[]
}

declare module 'claude-code' {
  interface PluginState {
    'task-status': { status: Shaped<TaskStatus> }
  }
}
