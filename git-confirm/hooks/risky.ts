// Which git commands in a Bash call are worth a second look, and what each one touches.
//
// Two kinds:
//   - `force-push`: refused outright. A Proceed button would only invite it.
//   - `confirm`: can destroy local work or remote refs. Each carries an `impact` saying what to
//     measure; impact.ts measures it, and the person is asked only when something that is not
//     this session's own work would be lost.

import { basename, joinPath, parseShell, shellScriptArgument } from './shell'

export type Impact =
  /** Uncommitted files in a working tree. `hits` is the kind the command destroys. */
  | {
      kind: 'worktree'
      hits: 'tracked' | 'untracked'
      /** Limits the command to these paths (relative to `dir`); absent: the whole tree. */
      pathspecs?: string[]
      /** `reset --hard <target>`: a file whose content already equals the target's loses nothing. */
      resetTarget?: string
      /** `clean -x`/`-X`: ignored files go too. */
      includeIgnored?: boolean
    }
  /** `worktree remove --force <path>`: everything uncommitted in that tree. */
  | { kind: 'worktree-remove'; path: string; isTemp: boolean }
  /** `branch -D`: commits that exist nowhere else. */
  | { kind: 'branches'; names: string[] }

export type Finding = {
  kind: 'force-push' | 'confirm'
  /** The git command as written, words joined: what the dialog shows. */
  command: string
  /** What it does, as a clause: "discards every uncommitted change to tracked files". */
  reason: string
  /** What to measure before asking; absent: nothing can be measured, so always ask. */
  impact?: Impact
  /** The directory git runs in, relative to the session's when relative; absent: the session's. */
  dir?: string
}

type Classified = Omit<Finding, 'command' | 'dir'>

export type GitInvocation = { dir?: string; sub: string; args: string[] }

const WRAPPERS = new Set(['env', 'command', 'nohup', 'time', 'sudo', 'exec', 'xargs'])
const GLOBALS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'])

/**
 * What `$(mktemp …)` stands for once resolved: a path under the system temp folder. It is never
 * handed to git — `isTempPath` recognises it, and a command run *in* it cannot be measured.
 */
export const MKTEMP_PATH = '/private/var/folders/(mktemp)'

/** Whether `path` is under a folder the system clears: `mktemp`'s, `/tmp`, `/var/folders`. */
export function isTempPath(path: string): boolean {
  return /^\/(private\/)?(tmp|var\/folders)\//.test(path)
}

type Vars = Map<string, string>

/** `$NAME`, `${NAME}`, or either followed by more path, replaced from `vars`; others as written. */
export function resolveWord(word: string, vars: Vars): string {
  const match = /^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))(.*)$/s.exec(word)
  if (!match) return word
  const value = vars.get(match[1] ?? match[2] ?? '')
  return value === undefined ? word : `${value}${match[3] ?? ''}`
}

/** A standalone `NAME=value`, `local NAME=value` or `export NAME=value` command, else undefined. */
function assignment(words: readonly string[]): { name: string; value: string } | undefined {
  const rest = ['local', 'export', 'declare', 'readonly', 'typeset'].includes(words[0] ?? '') ? words.slice(1) : words
  if (rest.length !== 1) return undefined
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s.exec(rest[0] ?? '')
  return match?.[1] === undefined ? undefined : { name: match[1], value: match[2] ?? '' }
}

/** The git subcommand a command's words run, or undefined when they don't run git. */
export function gitInvocation(words: readonly string[]): GitInvocation | undefined {
  let i = 0
  while (i < words.length) {
    const w = words[i] ?? ''
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      i += 1
      continue
    }
    if (WRAPPERS.has(basename(w))) {
      i += 1
      while ((words[i] ?? '').startsWith('-')) i += 1
      continue
    }
    break
  }
  if (basename(words[i]) !== 'git') return undefined
  i += 1

  let dir: string | undefined
  while ((words[i] ?? '').startsWith('-')) {
    const w = words[i] ?? ''
    if (w === '-C') dir = joinPath(dir, words[i + 1] ?? '')
    i += GLOBALS_WITH_VALUE.has(w) ? 2 : 1
  }
  const sub = words[i]
  if (sub === undefined) return undefined
  return { dir, sub, args: words.slice(i + 1) }
}

/** The single-letter flags among `args`, clusters split: `-fd` gives `f` and `d`. */
function shortFlags(args: readonly string[]): Set<string> {
  return new Set(args.filter(a => /^-[A-Za-z]+$/.test(a)).flatMap(a => [...a.slice(1)]))
}

/** Whether any of `longs` is among `args`, bare or as `--long=value`. */
function hasLong(args: readonly string[], ...longs: string[]): boolean {
  return args.some(a => longs.some(l => a === l || a.startsWith(`${l}=`)))
}

/** The arguments that are not options, skipping the values of `valued` options (`--source X`). */
function operandsOf(args: readonly string[], valued: readonly string[] = []): string[] {
  const operands: string[] = []
  for (let k = 0; k < args.length; k += 1) {
    const a = args[k] ?? ''
    if (a === '--') return [...operands, ...args.slice(k + 1)]
    if (valued.includes(a)) k += 1
    else if (!a.startsWith('-')) operands.push(a)
  }
  return operands
}

/** What follows `--`, if anything does. */
function afterDashDash(args: readonly string[]): string[] | undefined {
  const at = args.indexOf('--')
  return at === -1 ? undefined : args.slice(at + 1)
}

const confirm = (reason: string, impact?: Impact): Classified => ({ kind: 'confirm', reason, impact })

export function classify({ sub, args }: GitInvocation): Classified | undefined {
  const short = shortFlags(args)
  const operands = operandsOf(args)

  switch (sub) {
    case 'push': {
      if (
        hasLong(args, '--force', '--force-with-lease', '--force-if-includes') ||
        short.has('f') ||
        operands.some(a => a.startsWith('+'))
      ) {
        return { kind: 'force-push', reason: 'rewrites published history' }
      }
      if (hasLong(args, '--delete') || short.has('d') || operands.some(a => a.length > 1 && a.startsWith(':'))) {
        return confirm('deletes a branch or tag on the remote')
      }
      if (hasLong(args, '--mirror', '--prune')) return confirm('can delete refs on the remote')
      return undefined
    }
    case 'reset':
      return hasLong(args, '--hard')
        ? confirm('discards every uncommitted change to tracked files', {
            kind: 'worktree',
            hits: 'tracked',
            resetTarget: operands[0] ?? 'HEAD',
          })
        : undefined
    case 'checkout': {
      const paths = afterDashDash(args)
      const hasPaths = paths !== undefined && paths.length > 0
      if (!(short.has('f') || hasLong(args, '--force') || hasPaths || operands.includes('.'))) return undefined
      const pathspecs = hasPaths ? paths : operands.includes('.') ? ['.'] : undefined
      return confirm('overwrites uncommitted changes in the working tree', { kind: 'worktree', hits: 'tracked', pathspecs })
    }
    case 'switch':
      return short.has('f') || hasLong(args, '--force', '--discard-changes')
        ? confirm('discards uncommitted changes', { kind: 'worktree', hits: 'tracked' })
        : undefined
    case 'restore': {
      const isStaged = short.has('S') || hasLong(args, '--staged')
      const isWorktree = short.has('W') || hasLong(args, '--worktree')
      if (isStaged && !isWorktree) return undefined
      const pathspecs = operandsOf(args, ['-s', '--source'])
      return confirm('overwrites uncommitted changes in the working tree', {
        kind: 'worktree',
        hits: 'tracked',
        pathspecs: pathspecs.length > 0 ? pathspecs : undefined,
      })
    }
    case 'clean': {
      const isDryRun = short.has('n') || hasLong(args, '--dry-run')
      if (isDryRun || !(short.has('f') || hasLong(args, '--force'))) return undefined
      const what = short.has('d') ? 'untracked files and directories' : 'untracked files'
      const includeIgnored = short.has('x') || short.has('X')
      const pathspecs = operandsOf(args, ['-e', '--exclude'])
      return confirm(`permanently deletes ${what}${includeIgnored ? ', ignored ones included' : ''}`, {
        kind: 'worktree',
        hits: 'untracked',
        includeIgnored,
        pathspecs: pathspecs.length > 0 ? pathspecs : undefined,
      })
    }
    case 'branch': {
      const isDelete = short.has('d') || hasLong(args, '--delete')
      const isForce = short.has('f') || hasLong(args, '--force')
      if (!short.has('D') && !(isDelete && isForce)) return undefined
      const which = operands.length > 0 ? operands.join(', ') : 'a branch'
      return confirm(`force-deletes ${which} even if unmerged`, { kind: 'branches', names: operands })
    }
    case 'stash':
      if (args[0] === 'drop') return confirm('permanently drops a stash entry')
      if (args[0] === 'clear') return confirm('permanently drops every stash entry')
      return undefined
    case 'worktree': {
      if (args[0] !== 'remove' || !(short.has('f') || hasLong(args, '--force'))) return undefined
      const path = operandsOf(args.slice(1))[0]
      return confirm(
        'removes the worktree and its uncommitted changes',
        path === undefined ? undefined : { kind: 'worktree-remove', path, isTemp: isTempPath(path) },
      )
    }
    default:
      return undefined
  }
}

/** Every risky git command a Bash command line runs, in order, with its variables resolved. */
export function analyze(commandLine: string, depth = 0, inherited: Vars = new Map()): Finding[] {
  const findings: Finding[] = []
  const vars: Vars = new Map(inherited)
  let cdDir: string | undefined

  for (const pipeline of parseShell(commandLine)) {
    for (const command of pipeline) {
      const set = assignment(command.words)
      if (set) {
        const value = set.value.startsWith('$(mktemp') ? `${MKTEMP_PATH}${set.value.slice(closingParen(set.value))}` : set.value
        vars.set(set.name, resolveWord(value, vars))
        continue
      }
      const words = command.words.map(w => resolveWord(w, vars))

      const script = shellScriptArgument(words)
      if (script !== undefined && depth < 3) {
        findings.push(...analyze(script, depth + 1, vars).map(f => ({ ...f, dir: joinPath(cdDir, f.dir ?? '.') })))
        continue
      }
      if (words[0] === 'cd' && words[1] !== undefined) {
        cdDir = joinPath(cdDir, words[1])
        continue
      }
      const git = gitInvocation(words)
      if (!git) continue
      const found = classify(git)
      if (!found) continue
      const dir = git.dir === undefined ? cdDir : joinPath(cdDir, git.dir)
      findings.push({ ...found, command: `git ${git.sub} ${git.args.join(' ')}`.trim(), dir })
    }
  }
  return findings
}

/** The index just past the `)` that closes the `$(` at the start of `text`. */
function closingParen(text: string): number {
  let depth = 0
  for (let i = 1; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1
    if (text[i] === ')') {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
  return text.length
}
