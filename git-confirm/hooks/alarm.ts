// What the alarm frame around the Risky git dialog lists: the blast radius, as plain data the
// render hook draws. Built from git's own output so it is testable without a session.

export type AlarmRow = { mark: string; color: string; text: string }

export type AlarmSection = {
  title: string
  color: string
  rows: AlarmRow[]
  /** Rows left out past MAX_ROWS. */
  more: number
  note?: string
}

/** One section per measured directory or branch; empty for a command with nothing to measure. */
export type Alarm = { sections: AlarmSection[] }

export const MAX_ROWS = 8

/** One `git status --porcelain` entry: its two-letter code and its path from the repository root. */
export type StatusEntry = { code: string; path: string }

/**
 * The files a command would take with it that are not this session's own work, and how many of
 * the session's own go with them. Built only when something is at risk — nothing at risk, no ask.
 */
export function worktreeSection(
  atRisk: readonly StatusEntry[],
  ownCount: number,
  where: string,
): { section: AlarmSection; summary: string } {
  const own = ownCount === 0 ? '' : `${plural(ownCount, 'file')} Claude changed this session ${ownCount === 1 ? 'goes' : 'go'} too`
  return {
    summary: `${plural(atRisk.length, 'uncommitted file')} in ${where} that Claude didn't change`,
    section: {
      title: `💥 at risk in ${where}:`,
      color: 'red',
      rows: atRisk.slice(0, MAX_ROWS).map(e => ({ mark: e.code, color: statusColor(e.code), text: e.path })),
      more: Math.max(0, atRisk.length - MAX_ROWS),
      note: own === '' ? undefined : own,
    },
  }
}

/** A finding whose blast radius could not be measured: the dialog says so instead of guessing. */
export function unmeasuredSection(why: string): AlarmSection {
  return { title: `? couldn't check what this destroys — ${why}`, color: 'yellow', rows: [], more: 0 }
}

/** The commits a force-deleted branch holds that no remote has, from `git log --oneline`. */
export function branchSection(name: string, count: number, oneline: string): { section: AlarmSection; summary: string } {
  const summary = `${name} has ${plural(count, 'commit')} on no remote`
  if (count === 0) return { section: { title: `✔ ${name} is all on a remote`, color: 'green', rows: [], more: 0 }, summary }
  const rows = oneline
    .split('\n')
    .filter(Boolean)
    .slice(0, MAX_ROWS)
    .map(line => {
      const space = line.indexOf(' ')
      return { mark: space === -1 ? line : line.slice(0, space), color: 'yellow', text: space === -1 ? '' : line.slice(space + 1) }
    })
  return {
    section: { title: `💥 ${name}: ${plural(count, 'commit')} on no remote`, color: 'red', rows, more: Math.max(0, count - rows.length) },
    summary,
  }
}

/**
 * Claude Code draws at most 12 rows around its own dialog and refuses the whole frame past that.
 * The frame spends 2 on its border and 1 on the banner; this is what the sections may use, a
 * row short of the cap so a wide glyph cannot tip it over.
 */
export const SECTION_ROWS = 12 - 1 - 2 - 1

/** The rows a section draws: its title, its rows, and one footer for "… N more" and the note. */
export function sectionHeight(section: AlarmSection): number {
  return 1 + section.rows.length + (section.more > 0 || section.note !== undefined ? 1 : 0)
}

/** The alarm cut to `budget` rows: the longest list loses rows first (into its "more"); then trailing sections go. */
export function fitAlarm(alarm: Alarm, budget = SECTION_ROWS): Alarm {
  const sections = alarm.sections.map(s => ({ ...s, rows: [...s.rows] }))
  const height = () => sections.reduce((sum, s) => sum + sectionHeight(s), 0)
  while (height() > budget) {
    const longest = sections.filter(s => s.rows.length > 0).sort((a, b) => b.rows.length - a.rows.length)[0]
    if (longest) {
      longest.rows.pop()
      longest.more += 1
    } else {
      sections.pop()
    }
  }
  return { sections }
}

function statusColor(code: string): string {
  if (code === '??') return 'cyan'
  if (code === '!!') return 'gray'
  if (code.includes('D')) return 'red'
  if (code.includes('A')) return 'green'
  return 'yellow'
}

export const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`
