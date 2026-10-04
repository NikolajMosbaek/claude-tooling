import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { type Alarm, fitAlarm } from './alarm'
import { canonicalPath, type Git, measure, type Measured } from './impact'
import type { SessionFiles } from '../types'
import { analyze, type Finding } from './risky'

export const PROCEED = 'Proceed'
export const CANCEL = 'Cancel'
const HEADER = 'Risky git'
const ALARM_SOUND = 'sounds/alarm.wav'

const MAX_SHOWN = 100

const shown = (command: string) => (command.length > MAX_SHOWN ? `${command.slice(0, MAX_SHOWN - 1)}…` : command)

/** The alarm each open Risky git question is drawn with, by question text. */
const alarms = new Map<string, Alarm>()

/** Risky-git questions whose dialog resolved itself while the person was away. */
const unattended = new Set<string>()

/** Every file this session's file tools touched, by canonical path: true when it was clean before. */
const sessionFiles = atom({ plugin: 'git-confirm', key: 'sessionFiles' } as const, {} as SessionFiles)

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const findings = analyze(e.command)
    if (findings.length === 0) return next(e)

    const forcePush = findings.find(f => f.kind === 'force-push')
    if (forcePush) {
      return {
        deny:
          `${$.plugin.name}: \`${shown(forcePush.command)}\` is a force-push, which ${forcePush.reason}. ` +
          'Force-pushing is never allowed; a regular push is fine.',
      }
    }

    // Ask only about what would lose something that isn't this session's own work.
    const measured = await measureAll($, findings)
    const atRisk = findings.flatMap((f, i) => {
      const m = measured[i]
      return m?.isAtRisk === true ? [{ finding: f, measured: m }] : []
    })
    if (atRisk.length === 0) {
      const why = measured.map(m => (m.isAtRisk ? '' : m.passReason)).filter(Boolean).join('; ')
      $.ui.log(`${$.plugin.name}: let ${findings.map(f => `\`${shown(f.command)}\``).join(', ')} through — ${why}`)
      return next(e)
    }

    const what = atRisk.map(r => `\`${shown(r.finding.command)}\``).join(', ')
    const { question, alarm } = composeAlert(atRisk)
    alarms.set(question, alarm)
    void $.audio.play({ asset: ALARM_SOUND }).catch(() => undefined)
    const { answer, why } = await ask($, question).finally(() => alarms.delete(question))

    if (answer === PROCEED) return next(e)
    if (answer === undefined) {
      $.ui.log(`no answer for ${what}: ${why}`, { to: 'debug' })
      return {
        deny:
          `${$.plugin.name}: ${what} needs the user's go-ahead and none was given (${why}). ` +
          'Do not retry it; ask the user first.',
      }
    }
    const said = answer === CANCEL ? '' : ` They said: "${answer}".`
    return { deny: `${$.plugin.name}: the user cancelled ${what}.${said} Do not run it again without asking.` }
  })

  // Remember which files this session's own tools wrote, and whether each was clean before: a
  // command discarding only those loses nothing that isn't Claude's. Sampled before the tool runs.
  on('tool.call', async ($, e, next) => {
    if (FILE_TOOLS.has(String(e.tool))) {
      const input = e as { file_path?: unknown; notebook_path?: unknown }
      const path = typeof input.file_path === 'string' ? input.file_path : input.notebook_path
      if (typeof path === 'string' && path.startsWith('/')) await rememberFile($, canonicalPath(path))
    }
    return next(e)
  })

  // `$.ui.ask` answers with a label alone, and a dialog that resolved itself while the person was
  // away answers with one too. Only the AskUserQuestion record says so (`afkTimeoutMs`); this hook
  // reads it on the way back up and flags the question, so `ask` never takes that answer as Proceed.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny === undefined && ran.isError !== true && ran.result.afkTimeoutMs !== undefined) {
      for (const q of e.questions) if (q.header === HEADER) unattended.add(q.question)
    }
    return ran
  })

  // The alarm frame: Claude Code's own dialog, drawn inside a red frame under a warning banner
  // with the blast radius listed, cut to the 12 rows the engine allows around its dialog (past
  // that it refuses the frame and draws its own). The engine's dialog keeps the keys and the
  // answer — a pane of the mod's own could not hold the tool call open past the 10 s hook budget,
  // and past it the engine runs the command unconfirmed.
  on('ui.render', { component: 'AskUserQuestion' }, async ($, e, next) => {
    const alarm = alarmFor(e.props.questions)
    if (!alarm) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const dialog = await next(e)

    return (
      <Box flexDirection="column" borderStyle="bold" borderColor="red" paddingX={1}>
        <Box justifyContent="center">
          <Text bold inverse color="red">
            {'  ⚠  RISKY GIT  ⚠  '}
          </Text>
        </Box>
        {fitAlarm(alarm).sections.map(section => {
          const footer = [section.more > 0 ? `… ${section.more} more` : '', section.note ?? ''].filter(Boolean).join(' · ')
          return (
            <Box flexDirection="column">
              <Text bold color={section.color} wrap="truncate-end">
                {section.title}
              </Text>
              {section.rows.map(row => (
                <Box>
                  <Text color={row.color}>{`   ${row.mark}`}</Text>
                  <Text wrap="truncate-end">{` ${row.text}`}</Text>
                </Box>
              ))}
              {footer !== '' && (
                <Text dimColor wrap="truncate-end">
                  {`   ${footer}`}
                </Text>
              )}
            </Box>
          )
        })}
        {dialog}
      </Box>
    )
  })
}

/** The alarm of the Risky git question a dialog shows, if it shows one. */
function alarmFor(questions: readonly unknown[]): Alarm | undefined {
  const first = questions[0] as { header?: unknown; question?: unknown } | undefined
  if (first?.header !== HEADER || typeof first.question !== 'string') return undefined
  return alarms.get(first.question)
}

/**
 * The person's answer, or why there is none: dismissed, nobody to ask (`claude -p`), or
 * resolved by itself while they were away. Cancel is listed first so it holds the focus.
 */
async function ask($: EngineInterface, question: string): Promise<{ answer?: string; why: string }> {
  unattended.delete(question)
  try {
    const answer = await $.ui.ask(question, { options: [CANCEL, PROCEED], header: HEADER })
    if (unattended.delete(question)) return { why: 'the dialog timed out while they were away' }
    return answer === '' ? { why: 'the answer was empty' } : { answer, why: '' }
  } catch (error) {
    return { why: `the dialog was dismissed or nobody could be asked: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** The dialog's question — "`git reset --hard` discards … Right now: 2 uncommitted files … Run it?" — and its alarm. */
function composeAlert(atRisk: readonly { finding: Finding; measured: Measured }[]): { question: string; alarm: Alarm } {
  const first = atRisk[0]
  const what =
    atRisk.length === 1 && first
      ? `\`${shown(first.finding.command)}\` ${first.finding.reason}.`
      : `This runs ${atRisk.map(r => `\`${shown(r.finding.command)}\` (${r.finding.reason})`).join('; ')}.`
  const summary = atRisk
    .map(r => (r.measured.isAtRisk ? r.measured.summary : ''))
    .filter(Boolean)
    .join('; ')
  const sections = atRisk.flatMap(r => (r.measured.isAtRisk && r.measured.section ? [r.measured.section] : []))
  return { question: `${what}${summary ? ` Right now: ${summary}.` : ''} Run it?`, alarm: { sections } }
}

/** Each finding measured; when the session's directory is unknown, every one counts as at risk. */
async function measureAll($: EngineInterface, findings: readonly Finding[]): Promise<Measured[]> {
  let cwd: string
  try {
    cwd = canonicalPath(await $.session.cwd())
  } catch {
    return findings.map(() => ({ isAtRisk: true, summary: '' }))
  }
  const owned = await read($, sessionFiles)
  const git: Git = (dir, args) => runGit($, dir, args)
  return Promise.all(findings.map(f => measure(f, cwd, git, path => owned[path] === true)))
}

/** Records `path` the first time a file tool touches it: clean (or absent) before is Claude's own. An ignored file is never clean — it may be a secret only this machine has. */
async function rememberFile($: EngineInterface, path: string): Promise<void> {
  if ((await read($, sessionFiles))[path] !== undefined) return
  const slash = path.lastIndexOf('/')
  const status = await runGit($, path.slice(0, slash) || '/', ['status', '--porcelain', '-z', '--ignored', '--', path.slice(slash + 1)])
  const wasClean = status === undefined ? !(await $.fs.exists(path).catch(() => true)) : status === ''
  await update($, sessionFiles, files => (files[path] === undefined ? { ...files, [path]: wasClean } : files))
}

async function runGit($: EngineInterface, dir: string, args: readonly string[]): Promise<string | undefined> {
  try {
    const ran = await $.process.run(['git', '-C', dir, ...args], { timeoutMs: 5_000 })
    return ran.exitCode === 0 ? ran.stdout : undefined
  } catch {
    return undefined
  }
}
