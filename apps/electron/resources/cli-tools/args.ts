import { writeFileSync } from 'node:fs'

/**
 * The argument reader the bundled command-line tools share.
 *
 * These tools replace the Python ones that used to sit behind `uv` (`resources/scripts/*.py`, kept
 * in the repository as the reference for what each command means). They keep the same command names,
 * flags and output shapes, so the agent's instructions and the permission rules did not have to
 * change — and they run on Bun, which every host already has.
 *
 * Deliberately tiny: `--key value`, `--key=value`, `--flag`, `--no-flag`, `-o value`, and
 * positionals. No dependency, because a tool that needs help to parse its own arguments is a tool
 * that cannot be shipped on its own.
 */

export interface Parsed {
  positional: string[]
  flags: Record<string, string | true>
}

/** Flags that never take a value (`--expand`, `--json`, …). */
export function parseArgs(argv: readonly string[], booleans: ReadonlySet<string> = new Set()): Parsed {
  const positional: string[] = []
  const flags: Record<string, string | true> = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!
    if (arg === '--') {
      positional.push(...argv.slice(i + 1))
      break
    }
    if (arg === '-h' || arg === '--help') {
      flags.help = true
      continue
    }
    // `-o out.png` is the one short option these tools have ever had.
    if (arg === '-o') {
      const next = argv[i + 1]
      if (next === undefined) throw new Error('-o needs a path')
      flags.output = next
      i += 1
      continue
    }
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1)
      continue
    }
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (!booleans.has(key) && next !== undefined && !next.startsWith('--') && next !== '-o') {
      flags[key] = next
      i += 1
    } else {
      flags[key] = true
    }
  }
  return { positional, flags }
}

export const text = (parsed: Parsed, name: string): string | undefined => {
  const value = parsed.flags[name]
  return typeof value === 'string' ? value : undefined
}

export const integer = (parsed: Parsed, name: string): number | undefined => {
  const value = text(parsed, name)
  if (value === undefined) return undefined
  const parsedValue = Number(value)
  if (!Number.isInteger(parsedValue)) throw new Error(`--${name} takes a whole number, not "${value}"`)
  return parsedValue
}

export const decimal = (parsed: Parsed, name: string): number | undefined => {
  const value = text(parsed, name)
  if (value === undefined) return undefined
  const parsedValue = Number(value)
  if (!Number.isFinite(parsedValue)) throw new Error(`--${name} takes a number, not "${value}"`)
  return parsedValue
}

export const flag = (parsed: Parsed, name: string): boolean => parsed.flags[name] !== undefined

/**
 * `--with / --no-with`, as the Python tools had them.
 *
 * `undefined` when neither was given, so a default stays a default rather than becoming a value
 * somebody has to guess at.
 */
export const toggle = (parsed: Parsed, name: string): boolean | undefined => {
  if (flag(parsed, `no-${name}`)) return false
  if (flag(parsed, name)) return true
  return undefined
}

/** The one thing every tool here does with a message: print it where a caller looks and fail. */
export function fail(message: string): never {
  process.stderr.write(`${message}\n`)
  process.exit(1)
}

/** Write the answer where it was asked for: `-o`/`--output`, else stdout. */
export function emit(output: string | undefined, body: string): void {
  if (output) {
    writeFileSync(output, body, 'utf-8')
    process.stderr.write(`Output written to ${output}\n`)
    return
  }
  process.stdout.write(body.endsWith('\n') ? body : `${body}\n`)
}
