// A small shell reader: enough of POSIX sh to see which commands a Bash tool call runs, with
// their words unquoted and their redirects apart. It is not an interpreter — nothing is expanded.
//
// What it gets right, because an agent types it every day:
//   - quotes: `git -C "/x y" reset --hard` is one `-C` argument, and `-m "push -f"` is one word
//   - `$( … )` and heredocs inside it are one opaque word, so a commit message written as
//     `-m "$(cat <<'EOF' … EOF)"` never reads as commands, whatever quotes it holds
//   - top-level heredoc bodies are skipped
//   - `;` `&&` `||` `&` newlines and `( )` end a command; `|` chains one into a pipeline
//
// What it does not see: aliases, functions, `eval`, a variable holding a command, or anything
// inside `$( … )`. `bash -c '…'` is read by the caller, which parses the argument again.
//
// The same file is copied into dev-commands/hooks/shell.ts; change both.

export type Redirect = { fd: number | 'both'; append: boolean; target: string }
export type SimpleCommand = { words: string[]; redirects: Redirect[] }
export type Pipeline = SimpleCommand[]

type Heredoc = { delim: string; strip: boolean }

export function parseShell(src: string): Pipeline[] {
  const pipelines: Pipeline[] = []
  let pipeline: Pipeline = []
  let command: SimpleCommand = { words: [], redirects: [] }
  let word = ''
  let isInWord = false
  let isQuoted = false
  let pendingRedirect: Omit<Redirect, 'target'> | undefined
  let pendingHeredoc: { strip: boolean } | undefined
  const heredocs: Heredoc[] = []
  let i = 0

  const endWord = () => {
    if (!isInWord) return
    if (pendingHeredoc) {
      heredocs.push({ delim: word, strip: pendingHeredoc.strip })
      pendingHeredoc = undefined
    } else if (pendingRedirect) {
      command.redirects.push({ ...pendingRedirect, target: word })
      pendingRedirect = undefined
    } else if (isQuoted || (word !== '{' && word !== '}')) {
      command.words.push(word)
    }
    word = ''
    isInWord = false
    isQuoted = false
  }
  const endCommand = () => {
    endWord()
    pendingRedirect = undefined
    if (command.words.length > 0 || command.redirects.length > 0) pipeline.push(command)
    command = { words: [], redirects: [] }
  }
  const endPipeline = () => {
    endCommand()
    if (pipeline.length > 0) pipelines.push(pipeline)
    pipeline = []
  }
  const append = (text: string, quoted = false) => {
    word += text
    isInWord = true
    if (quoted) isQuoted = true
  }

  while (i < src.length) {
    const c = src.charAt(i)
    const n = src.charAt(i + 1)

    if (c === '\\') {
      if (n !== '\n' && n !== '') append(n)
      i += 2
      continue
    }
    if (c === "'") {
      const end = closeOf(src, "'", i + 1)
      append(src.slice(i + 1, end), true)
      i = end + 1
      continue
    }
    if (c === '"') {
      const end = skipDoubleQuoted(src, i)
      append(unescapeDoubleQuoted(src.slice(i + 1, end - 1)), true)
      i = end
      continue
    }
    if (c === '$' && n === '(') {
      const end = skipParens(src, i + 1)
      append(src.slice(i, end))
      i = end
      continue
    }
    if (c === '`') {
      const end = closeOf(src, '`', i + 1)
      append(src.slice(i, end + 1))
      i = end + 1
      continue
    }
    if (c === '#' && !isInWord) {
      const nl = src.indexOf('\n', i)
      i = nl === -1 ? src.length : nl
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord()
      i += 1
      continue
    }
    if (c === '\n') {
      endPipeline()
      i = skipHeredocBodies(src, i + 1, heredocs)
      continue
    }
    if (c === ';' || c === '(' || c === ')') {
      endPipeline()
      i += c === ';' && n === ';' ? 2 : 1
      continue
    }
    if (c === '&') {
      if (n === '&') {
        endPipeline()
        i += 2
        continue
      }
      if (n === '>') {
        endWord()
        i += 2
        const isAppend = src.charAt(i) === '>'
        if (isAppend) i += 1
        pendingRedirect = { fd: 'both', append: isAppend }
        continue
      }
      endPipeline()
      i += 1
      continue
    }
    if (c === '|') {
      if (n === '|') {
        endPipeline()
        i += 2
        continue
      }
      endCommand()
      i += n === '&' ? 2 : 1
      continue
    }
    if (c === '>' || c === '<') {
      let fd: number | 'both' = c === '>' ? 1 : 0
      if (isInWord && !isQuoted && /^\d+$/.test(word)) {
        fd = Number(word)
        word = ''
        isInWord = false
      } else {
        endWord()
      }
      if (c === '<' && n === '(') {
        // process substitution: an opaque word
        const end = skipParens(src, i + 1)
        append(src.slice(i, end))
        i = end
        continue
      }
      if (c === '<' && n === '<') {
        if (src.charAt(i + 2) === '<') {
          // here-string: its word is input, not a command
          i += 3
          pendingRedirect = { fd: 0, append: false }
          continue
        }
        i += 2
        const strip = src.charAt(i) === '-'
        if (strip) i += 1
        pendingHeredoc = { strip }
        continue
      }
      i += 1
      let isAppend = false
      if (c === '>' && src.charAt(i) === '>') {
        isAppend = true
        i += 1
      } else if (c === '>' && src.charAt(i) === '|') {
        i += 1
      }
      if (src.charAt(i) === '&') {
        // `>&2` / `>&-` duplicate a descriptor; `>&file` sends both streams to a file
        const dup = /^[0-9-]+/.exec(src.slice(i + 1))
        if (dup) {
          i += 1 + dup[0].length
          continue
        }
        i += 1
        fd = 'both'
      }
      pendingRedirect = { fd, append: isAppend }
      continue
    }

    append(c)
    i += 1
  }
  endPipeline()
  return pipelines
}

/** The index of the next `quote` at or after `from`, or the end of `src`. */
function closeOf(src: string, quote: string, from: number): number {
  const at = src.indexOf(quote, from)
  return at === -1 ? src.length : at
}

/** `src[start]` is `"`; returns the index just past its closing quote. */
function skipDoubleQuoted(src: string, start: number): number {
  let i = start + 1
  while (i < src.length) {
    const c = src.charAt(i)
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === '"') return i + 1
    if (c === '$' && src.charAt(i + 1) === '(') {
      i = skipParens(src, i + 1)
      continue
    }
    if (c === '`') {
      i = closeOf(src, '`', i + 1) + 1
      continue
    }
    i += 1
  }
  return src.length
}

/** `src[open]` is `(`; returns the index just past its matching `)`, quotes and heredocs inside included. */
function skipParens(src: string, open: number): number {
  let depth = 0
  const heredocs: Heredoc[] = []
  let i = open
  while (i < src.length) {
    const c = src.charAt(i)
    if (c === '\\') {
      i += 2
      continue
    }
    if (c === "'") {
      i = closeOf(src, "'", i + 1) + 1
      continue
    }
    if (c === '"') {
      i = skipDoubleQuoted(src, i)
      continue
    }
    if (c === '<' && src.charAt(i + 1) === '<' && src.charAt(i + 2) !== '<') {
      const read = readHeredocDelimiter(src, i + 2)
      if (read) {
        heredocs.push(read.heredoc)
        i = read.end
        continue
      }
    }
    if (c === '\n' && heredocs.length > 0) {
      i = skipHeredocBodies(src, i + 1, heredocs)
      continue
    }
    if (c === '(') depth += 1
    if (c === ')') {
      depth -= 1
      if (depth === 0) return i + 1
    }
    i += 1
  }
  return src.length
}

/** Reads `-'EOF'`, `"EOF"` or `EOF` from just past a `<<`. */
function readHeredocDelimiter(src: string, from: number): { heredoc: Heredoc; end: number } | undefined {
  let i = from
  const strip = src.charAt(i) === '-'
  if (strip) i += 1
  while (src.charAt(i) === ' ' || src.charAt(i) === '\t') i += 1
  const match = /^(?:'([^']*)'|"([^"]*)"|([^\s;&|()<>]+))/.exec(src.slice(i))
  if (!match) return undefined
  const delim = match[1] ?? match[2] ?? match[3] ?? ''
  return { heredoc: { delim: delim.replace(/\\/g, ''), strip }, end: i + match[0].length }
}

/** Skips each pending heredoc's body, starting at the line that begins at `from`. */
function skipHeredocBodies(src: string, from: number, heredocs: Heredoc[]): number {
  let i = from
  while (heredocs.length > 0) {
    const heredoc = heredocs.shift()
    if (!heredoc) break
    while (i < src.length) {
      const nl = src.indexOf('\n', i)
      const end = nl === -1 ? src.length : nl
      const line = src.slice(i, end)
      i = end + 1
      if ((heredoc.strip ? line.replace(/^\t+/, '') : line) === heredoc.delim) break
    }
  }
  return Math.min(i, src.length)
}

function unescapeDoubleQuoted(text: string): string {
  return text.replace(/\\([\\"$`\n])/g, (_, ch: string) => (ch === '\n' ? '' : ch))
}

/** The last path component: `basename('/usr/bin/git')` is `git`. */
export function basename(path: string | undefined): string {
  if (path === undefined) return ''
  const at = path.lastIndexOf('/')
  return at === -1 ? path : path.slice(at + 1)
}

/** `p` against `base` when `p` is relative and `base` is given; `p` alone otherwise. */
export function joinPath(base: string | undefined, p: string): string {
  if (p.startsWith('/') || p.startsWith('~') || base === undefined || base === '') return p
  return `${base.replace(/\/+$/, '')}/${p}`
}

/** For `bash -c '…'`, `sh -lc '…'` and friends: the script the shell is handed, else undefined. */
export function shellScriptArgument(words: readonly string[]): string | undefined {
  if (!['bash', 'sh', 'zsh', 'dash'].includes(basename(words[0]))) return undefined
  for (let k = 1; k < words.length; k += 1) {
    const w = words[k] ?? ''
    if (!w.startsWith('-')) return undefined
    if (/^-[a-z]*c[a-z]*$/.test(w)) return words[k + 1]
  }
  return undefined
}
