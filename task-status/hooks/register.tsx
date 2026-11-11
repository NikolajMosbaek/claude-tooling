import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { TaskStatus } from '../types'
import {
  EMPTY,
  MARK,
  addTask,
  applyPlanUpdate,
  bashActivity,
  commitSubject,
  completeInProgress,
  finishActivity,
  finishAgent,
  matchPhase,
  overviewText,
  phaseViews,
  skillPhase,
  startActivity,
  stepMark,
  stepsFromTodos,
  updateTask,
  withSteps,
} from './model'

const PANE = 'task-status'
const TITLE = 'Task status'
const UPDATE_PLAN = 'mcp__ccd_turn__update_plan'
const WRAP_UP = 'mcp__ccd_turn__wrap_up'

// Bump the tag when TaskStatus changes shape: a value an earlier version
// stored is then read as EMPTY rather than misread.
const status = atom({ plugin: 'task-status', key: 'status' } as const, EMPTY, { shape: 'status-1' })

function isFailed(ran: { deny?: string; isError?: boolean }): boolean {
  return ran.deny !== undefined || ran.isError === true
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'task-status',
      description: 'Show the running task across Plan, Development, Test, Bug fixing and Creating PR',
    })
    void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('command.run', { command: 'task-status' }, async $ => {
    void $.ui.open({ id: PANE, title: TITLE })

    return { text: overviewText(await read($, status)) }
  })

  // Observers only: every hook below hands the call on untouched.
  on('tool.call', { tool: UPDATE_PLAN }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined && !isFailed(ran)) {
      const args = e as unknown as Record<string, unknown>
      await update($, status, s => withSteps(s, applyPlanUpdate(s.steps, args)))
    }
    return ran
  })

  on('tool.call', { tool: WRAP_UP }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined && !isFailed(ran)) {
      await update($, status, s => withSteps(s, completeInProgress(s.steps)))
    }
    return ran
  })

  // The terminal's task lists: TodoWrite, or TaskCreate + TaskUpdate.
  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const ran = await next(e)
    const steps = stepsFromTodos(e.todos)
    if (e.agentId === undefined && !isFailed(ran) && steps !== undefined) {
      await update($, status, s => withSteps(s, steps))
    }
    return ran
  })

  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const ran = await next(e)
    const task = (ran.result as { task?: { id?: unknown } } | undefined)?.task
    if (e.agentId === undefined && !isFailed(ran) && typeof task?.id === 'string') {
      const id = task.id
      await update($, status, s => withSteps(s, addTask(s.steps, id, e.subject)))
    }
    return ran
  })

  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId === undefined && !isFailed(ran)) {
      await update($, status, s => withSteps(s, updateTask(s.steps, e)))
    }
    return ran
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const activity = bashActivity(e.command)
    const id = e.tool_use_id
    if (activity) {
      await update($, status, s =>
        startActivity(s, { id, ...activity, isRunning: true, isBackground: false }),
      )
    }
    const ran = await next(e)
    const subject = commitSubject(e.command)
    if (subject !== undefined && !isFailed(ran)) {
      await update($, status, s => ({ ...s, commits: [...s.commits, subject].slice(-30) }))
    }
    if (activity) {
      const isBackground = e.run_in_background === true && !isFailed(ran)
      await update($, status, s => finishActivity(s, id, { isBackground }))
    }
    return ran
  })

  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    const phase = skillPhase(e.skill)
    const id = e.tool_use_id
    if (phase) {
      await update($, status, s =>
        startActivity(s, { id, phase, label: `/${e.skill}`, isRunning: true, isBackground: false }),
      )
    }
    const ran = await next(e)
    if (phase) await update($, status, s => finishActivity(s, id, { isBackground: false }))
    return ran
  })

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const phase = matchPhase(`${e.subagent_type ?? ''} ${e.description}`)
    const id = e.tool_use_id
    if (phase) {
      await update($, status, s =>
        startActivity(s, {
          id,
          phase,
          label: `agent: ${e.description}`,
          isRunning: true,
          isBackground: false,
        }),
      )
    }
    const ran = await next(e)
    if (phase) {
      const result = ran.result as { status?: string; agentId?: string } | undefined
      const isBackground = !isFailed(ran) && result?.status !== undefined && result.status !== 'completed'
      await update($, status, s =>
        finishActivity(s, id, { isBackground, agentId: isBackground ? result?.agentId : undefined }),
      )
    }
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      const agentId = e.agentId
      await update($, status, s => finishAgent(s, agentId))
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const current: TaskStatus = await read($, status)
    const isEmpty =
      current.steps.length === 0 && current.activities.length === 0 && current.commits.length === 0

    return (
      <Box flexDirection="column">
        {isEmpty && <Text dimColor>No task activity seen in this session yet.</Text>}
        {phaseViews(current).map(view => (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold={view.state === 'active'} dimColor={view.state === 'idle'}>
              {MARK[view.state]} {view.title}
            </Text>
            <Text dimColor wrap="truncate-end">
              {'   '}
              {view.detail}
            </Text>
            {view.id === 'dev' &&
              view.steps.map(step => (
                <Text dimColor={step.status === 'completed'} wrap="truncate-end">
                  {'   '}
                  {stepMark(step.status)} {step.content}
                </Text>
              ))}
            {view.id === 'dev' &&
              current.commits.map(commit => (
                <Text dimColor wrap="truncate-end">
                  {'   '}• {commit}
                </Text>
              ))}
          </Box>
        ))}
      </Box>
    )
  })
}
