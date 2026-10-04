import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { TrackedBuild } from '../types'
import { duration, findXcodebuilds, LOG_PATTERN, size, summarizeLog } from './builds'
import { joinPath } from './shell'
import { formatWorktrees, parseWorktrees } from './worktrees'

const builds = atom({ plugin: 'dev-commands', key: 'builds' } as const, [] as TrackedBuild[])

const KEEP_BUILDS = 10
const SHOWN = 5

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'build-status',
      description: "Instant status of Claude's latest xcodebuild: result, errors, failing tests (optional: a log path)",
    })
    await $.command.register({
      name: 'wt',
      description: 'Instant git worktree list, marking the one this session is in',
    })
    return next(e)
  })

  // Remember every xcodebuild Claude starts, and where its output goes.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const found = findXcodebuilds(e.command)
    if (found.length === 0) return next(e)

    const cwd = await $.session.cwd()
    const startedAt = await $.clock.now()
    const isBackground = e.run_in_background === true
    const tracked: TrackedBuild[] = found.map((build, k) => ({
      id: `${e.tool_use_id}:${k}`,
      action: build.action,
      scheme: build.scheme,
      logPath: build.logPath === undefined ? undefined : joinPath(cwd, build.logPath),
      startedAt,
      isBackground,
    }))
    await update($, builds, list => [...list, ...tracked].slice(-KEEP_BUILDS))

    const ran = await next(e)
    if (!isBackground) {
      const finishedAt = await $.clock.now()
      const isError = ran.deny !== undefined || ran.isError === true
      const ids = new Set(tracked.map(t => t.id))
      await update($, builds, list => list.map(b => (ids.has(b.id) ? { ...b, finishedAt, isError } : b)))
    }
    return ran
  })

  on('command.run', { command: 'build-status' }, async ($, e) => {
    try {
      return { text: await buildStatus($, e.args.trim()) }
    } catch (error) {
      return { text: `build-status: ${error instanceof Error ? error.message : String(error)}` }
    }
  })

  on('command.run', { command: 'wt' }, async $ => {
    try {
      return { text: await worktreeList($) }
    } catch (error) {
      return { text: `wt: ${error instanceof Error ? error.message : String(error)}` }
    }
  })
}

async function buildStatus($: EngineInterface, arg: string): Promise<string> {
  const [cwd, now, list] = await Promise.all([$.session.cwd(), $.clock.now(), read($, builds)])
  const latest = list.at(-1)

  if (arg !== '') return (await describeLog($, now, { logPath: joinPath(cwd, arg) })).join('\n')
  if (latest) {
    const lines = await describeLog($, now, { build: latest, logPath: latest.logPath })
    const earlier = list.slice(0, -1).reverse().slice(0, 4)
    if (earlier.length > 0) {
      lines.push('', 'Earlier this session:')
      for (const build of earlier) lines.push(`  ${await oneLine($, now, build)}`)
    }
    return lines.join('\n')
  }

  const found = await findRecentLog($)
  if (!found) {
    return (
      'No xcodebuild seen this session, and no xcodebuild log written under /private/tmp/claude-* in the last 12 hours.\n' +
      'Pass one: /build-status <path to log>'
    )
  }
  const lines = await describeLog($, now, { logPath: found })
  lines.unshift('(No xcodebuild seen this session; this is the newest xcodebuild log under /private/tmp/claude-*.)')
  return lines.join('\n')
}

async function describeLog(
  $: EngineInterface,
  now: number,
  { build, logPath }: { build?: TrackedBuild; logPath?: string },
): Promise<string[]> {
  const lines: string[] = []
  if (build) {
    const ended = build.finishedAt === undefined ? '' : `, took ${duration(build.finishedAt - build.startedAt)}`
    lines.push(
      `xcodebuild ${build.action}${build.scheme ? ` · ${build.scheme}` : ''} · started ${duration(now - build.startedAt)} ago${ended}` +
        (build.isBackground ? ' · background' : ''),
    )
  }
  if (logPath === undefined) {
    lines.push("Its output wasn't redirected to a file, so there is no log to read.")
    if (build && build.finishedAt === undefined && !build.isBackground) lines.push('Result: running (the Bash call has not returned)')
    if (build?.finishedAt !== undefined) lines.push(`Result: the Bash call returned ${build.isError ? 'an error' : 'success'}`)
    return lines
  }

  let stat: { size: number; mtimeMs: number }
  try {
    stat = await $.fs.stat(logPath)
  } catch {
    lines.push(`Log: ${logPath} — not there (yet?)`)
    return lines
  }
  lines.push(`Log: ${logPath} · ${size(stat.size)} · written ${duration(now - stat.mtimeMs)} ago`)

  const [grep, tail] = await Promise.all([
    $.process.run(['grep', '-a', '-E', LOG_PATTERN, logPath], { timeoutMs: 20_000 }),
    $.process.run(['tail', '-n', '80', logPath], { timeoutMs: 5_000 }),
  ])
  const summary = summarizeLog(grep.stdout, tail.stdout)
  const banner = summary.banners.at(-1)

  if (banner) lines.push(`Result: ** ${banner} **`)
  else if (build && build.finishedAt === undefined && !build.isBackground) lines.push('Result: running')
  else {
    const running = await $.process.run(['pgrep', '-x', 'xcodebuild'], { timeoutMs: 5_000 })
    const pids = running.stdout.split('\n').filter(Boolean)
    lines.push(
      pids.length > 0
        ? `Result: none yet; xcodebuild is running (pid ${pids.join(', ')})`
        : 'Result: no result banner and no xcodebuild running — interrupted or killed?',
    )
  }
  if (summary.testSummary) lines.push(`Tests: ${summary.testSummary}`)
  pushList(lines, 'Errors', summary.errors)
  pushList(lines, 'Test issues', summary.issues)
  pushList(lines, 'Failing tests', summary.failingTests)
  if (!banner && summary.lastLine) lines.push(`Last line: ${summary.lastLine.slice(0, 200)}`)
  return lines
}

function pushList(lines: string[], title: string, items: readonly string[]) {
  if (items.length === 0) return
  lines.push(`${title} (${items.length}):`)
  for (const item of items.slice(0, SHOWN)) lines.push(`  ${item.slice(0, 240)}`)
  if (items.length > SHOWN) lines.push(`  … ${items.length - SHOWN} more`)
}

async function oneLine($: EngineInterface, now: number, build: TrackedBuild): Promise<string> {
  const head = `${build.action}${build.scheme ? ` · ${build.scheme}` : ''} · ${duration(now - build.startedAt)} ago`
  if (build.logPath === undefined) return `${head} · no log`
  try {
    const grep = await $.process.run(['grep', '-a', '-E', '^\\*\\* [A-Z][A-Z -]+ \\*\\*', build.logPath], { timeoutMs: 10_000 })
    const banner = summarizeLog(grep.stdout, '').banners.at(-1)
    return `${head} · ${banner ?? 'no result banner'} · ${build.logPath}`
  } catch {
    return `${head} · ${build.logPath}`
  }
}

/** The newest file under a Claude temp folder written in the last 12 hours that xcodebuild wrote. */
async function findRecentLog($: EngineInterface): Promise<string | undefined> {
  const found = await $.process.run(
    ['find', '/private/tmp', '-maxdepth', '7', '-type', 'f', '-name', '*.log', '-mmin', '-720', '-path', '*/claude-*'],
    { timeoutMs: 15_000 },
  )
  const paths = found.stdout.split('\n').filter(Boolean).slice(0, 300)
  const stamped = await Promise.all(
    paths.map(async path => {
      try {
        return { path, mtimeMs: (await $.fs.stat(path)).mtimeMs }
      } catch {
        return { path, mtimeMs: 0 }
      }
    }),
  )
  stamped.sort((a, b) => b.mtimeMs - a.mtimeMs)
  for (const { path } of stamped.slice(0, 20)) {
    const head = await $.process.run(['head', '-c', '1024', path], { timeoutMs: 5_000 })
    if (/xcodebuild|Command line invocation/.test(head.stdout)) return path
  }
  return undefined
}

async function worktreeList($: EngineInterface): Promise<string> {
  const cwd = await $.session.cwd()
  const listed = await $.process.run(['git', 'worktree', 'list', '--porcelain'], { timeoutMs: 10_000 })
  if (listed.exitCode !== 0) return `Not in a git repository: ${cwd}`

  const trees = parseWorktrees(listed.stdout)
  const changes = await Promise.all(
    trees.map(async tree => {
      if (tree.isBare || tree.isPrunable) return undefined
      try {
        const status = await $.process.run(['git', '-C', tree.path, 'status', '--porcelain'], { timeoutMs: 10_000 })
        return status.exitCode === 0 ? status.stdout.split('\n').filter(Boolean).length : undefined
      } catch {
        return undefined
      }
    }),
  )
  return formatWorktrees(trees, changes, cwd)
}
