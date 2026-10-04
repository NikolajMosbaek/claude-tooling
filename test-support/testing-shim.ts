// Stand-in for the test kit's `claude-code/testing` (describe/test/expect) used by run-tests.sh.
const tests: { name: string; fn: () => unknown }[] = []
let prefix = ''
export const describe = (name: string, body: () => void) => { const p = prefix; prefix = `${p}${name} › `; body(); prefix = p }
export const test = (name: string, fn: () => unknown) => { tests.push({ name: prefix + name, fn }) }
const same = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const keys = (o: object) => Object.keys(o).filter(k => (o as Record<string, unknown>)[k] !== undefined).sort()
  const ka = keys(a)
  const kb = keys(b)
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
}
export const expect = (actual: any) => ({
  toEqual: (want: unknown) => { if (!same(actual, want)) throw new Error(`expected ${JSON.stringify(want)}\n   got      ${JSON.stringify(actual)}`) },
  toBe: (want: unknown) => { if (actual !== want) throw new Error(`expected ${JSON.stringify(want)}, got ${JSON.stringify(actual)}`) },
  toContain: (want: string) => { if (typeof actual !== 'string' || !actual.includes(want)) throw new Error(`expected ${JSON.stringify(actual)} to contain ${JSON.stringify(want)}`) },
  toBeUndefined: () => { if (actual !== undefined) throw new Error(`expected undefined, got ${JSON.stringify(actual)}`) },
})
export async function run() {
  let failed = 0
  for (const t of tests) { try { await t.fn(); } catch (e) { failed++; console.log(`✘ ${t.name}\n   ${(e as Error).message}`) } }
  console.log(`${tests.length - failed}/${tests.length} passed`)
  if (failed) process.exitCode = 1
}
