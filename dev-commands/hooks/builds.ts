// /build-status's pure half: finding xcodebuild runs in a Bash command, and reading what
// grep and tail pulled out of a log. No `$` here, so all of it is testable as plain functions.

import { basename, joinPath, parseShell } from './shell'

export type FoundBuild = { action: string; scheme?: string; logPath?: string }

const ACTIONS = new Set([
  'build',
  'build-for-testing',
  'test',
  'test-without-building',
  'analyze',
  'archive',
  'clean',
  'docbuild',
  'install',
])

/** Flags that make xcodebuild print information and exit instead of building. */
const INFO_FLAGS = new Set([
  '-list',
  '-version',
  '-showsdks',
  '-showBuildSettings',
  '-showdestinations',
  '-showTestPlans',
  '-help',
  '-usage',
  '-checkFirstLaunchStatus',
])

/** Every xcodebuild run in a Bash command line, with where its output is written. */
export function findXcodebuilds(commandLine: string): FoundBuild[] {
  const found: FoundBuild[] = []
  let cdDir: string | undefined

  for (const pipeline of parseShell(commandLine)) {
    pipeline.forEach(({ words, redirects }, k) => {
      if (words[0] === 'cd' && words[1] !== undefined) {
        cdDir = joinPath(cdDir, words[1])
        return
      }
      const at = commandPosition(words)
      if (basename(words[at]) !== 'xcodebuild') return
      const rest = words.slice(at + 1)
      if (rest.some(w => INFO_FLAGS.has(w))) return

      const schemeAt = rest.indexOf('-scheme')
      const scheme = schemeAt === -1 ? undefined : rest[schemeAt + 1]
      const action = rest.find(w => ACTIONS.has(w)) ?? 'build'

      const toFile = redirects.filter(r => (r.fd === 1 || r.fd === 'both') && r.target !== '/dev/null').at(-1)
      const target = toFile?.target ?? teeTarget(pipeline.slice(k + 1).map(c => c.words))
      found.push({ action, scheme, logPath: target === undefined ? undefined : joinPath(cdDir, target) })
    })
  }
  return found
}

const WRAPPERS = new Set(['env', 'command', 'nohup', 'time', 'exec', 'xcrun', 'caffeinate', 'arch'])

/** The index of the word a command runs, past `VAR=value` prefixes and wrappers such as `xcrun`. */
function commandPosition(words: readonly string[]): number {
  let i = 0
  while (i < words.length) {
    const w = words[i] ?? ''
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) i += 1
    else if (WRAPPERS.has(basename(w))) {
      i += 1
      while ((words[i] ?? '').startsWith('-')) i += 1
    } else break
  }
  return i
}

/** The file a later `tee` in the pipeline writes, if any. */
function teeTarget(commands: readonly string[][]): string | undefined {
  for (const words of commands) {
    if (basename(words[0]) !== 'tee') continue
    return words.slice(1).find(w => !w.startsWith('-'))
  }
  return undefined
}

/** One ERE that pulls every line /build-status reports out of a log, for `grep -E`. */
export const LOG_PATTERN = [
  '^\\*\\* [A-Z][A-Z -]+ \\*\\*',
  ': error: ',
  '^Test Case .* failed',
  '^✘ ',
  '^✔ Test run with',
  '^Executed [0-9]+ tests?, with',
  'Testing failed:',
].join('|')

export type LogSummary = {
  /** `TEST FAILED`, `BUILD SUCCEEDED`, `TEST EXECUTE SUCCEEDED`… in log order. */
  banners: string[]
  errors: string[]
  issues: string[]
  /** The run's own one-line test verdict: Swift Testing's or XCTest's last total. */
  testSummary?: string
  /** xcodebuild's closing "Failing tests:" list. */
  failingTests: string[]
  lastLine?: string
}

/** Reads `grep -E LOG_PATTERN` output over the whole log and the log's last lines. */
export function summarizeLog(grepOutput: string, tail: string): LogSummary {
  const banners: string[] = []
  const errors = new Set<string>()
  const issues = new Set<string>()
  let testSummary: string | undefined

  for (const raw of grepOutput.split('\n')) {
    const line = raw.trimEnd()
    if (line === '') continue
    const banner = /^\*\* ([A-Z][A-Z -]+) \*\*/.exec(line)
    if (banner?.[1]) banners.push(banner[1].trim())
    else if (/Test run with/.test(line) || /^Executed \d+ tests?, with/.test(line)) testSummary = line
    else if (line.includes(': error: ')) errors.add(line.trim())
    else if (line.startsWith('✘ ') || /^Test Case .* failed/.test(line)) issues.add(line)
  }

  const tailLines = tail.split('\n').map(l => l.trimEnd())
  const failingTests: string[] = []
  const listAt = tailLines.lastIndexOf('Failing tests:')
  if (listAt !== -1) {
    for (const line of tailLines.slice(listAt + 1)) {
      if (!line.startsWith('\t')) break
      failingTests.push(line.trim())
    }
  }
  const lastLine = [...tailLines].reverse().find(l => l.trim() !== '')

  return { banners, errors: [...errors], issues: [...issues], testSummary, failingTests, lastLine }
}

/** "12s", "6m 12s", "2h 05m". */
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

export function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
