import { readFileSync, readdirSync, existsSync } from 'fs'

const BS = String.fromCharCode(92)
const HOME = 'C:' + BS + 'Users' + BS + 'Ryan'
const real = `${HOME}${BS}.craft-agent${BS}workspaces${BS}my-workspace${BS}sessions${BS}261004-smart-canyon`
const tilde = `code${BS}craft-agents-oss${BS}~${BS}.craft-agent${BS}workspaces${BS}my-workspace${BS}sessions${BS}261004-smart-canyon`

const expected = `已重启， C:${BS}Users${BS}Ryan${BS}code${BS}craft-agents-oss${BS}~${BS}.craft-agent${BS} 你收到的是否正确`

const strings = (value: unknown, out: string[] = []): string[] => {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const v of value) strings(v, out)
  else if (value && typeof value === 'object') for (const v of Object.values(value)) strings(v, out)
  return out
}

const scan = (label: string, file: string) => {
  if (!existsSync(file)) {
    console.log(`\n[${label}] missing: ${file}`)
    return
  }
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
  let matched = 0
  let lastMatch: { where: string; text: string } | undefined
  for (const line of lines) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      continue
    }
    for (const s of strings(parsed)) {
      if (s.includes('craft-agents-oss') && s.includes('.craft-agent')) {
        matched++
        lastMatch = { where: file, text: s }
      }
    }
  }
  console.log(`\n[${label}] ${lines.length} entries, ${matched} strings mentioning that path`)
  if (lastMatch) {
    console.log('  stored  :', JSON.stringify(lastMatch.text))
    console.log('  expected:', JSON.stringify(expected))
    console.log('  identical?', lastMatch.text === expected)
    if (lastMatch.text !== expected) {
      const a = [...lastMatch.text]
      const b = [...expected]
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (a[i] !== b[i]) {
          console.log(`  first difference at char ${i}: stored ${JSON.stringify(a[i])} vs expected ${JSON.stringify(b[i])}`)
          console.log('  stored  around:', JSON.stringify(lastMatch.text.slice(Math.max(0, i - 12), i + 12)))
          console.log('  expected around:', JSON.stringify(expected.slice(Math.max(0, i - 12), i + 12)))
          break
        }
      }
    }
  }

  // Also: is a user message there at all, and what does it look like?
  const userLines = lines.filter((l) => {
    try {
      const o = JSON.parse(l) as { role?: string; type?: string }
      return o.role === 'user' || o.type === 'user'
    } catch {
      return false
    }
  })
  console.log(`  user-role entries: ${userLines.length}`)
  const lastUser = userLines[userLines.length - 1]
  if (lastUser) {
    const text = strings(JSON.parse(lastUser))
    console.log('  last user strings:', JSON.stringify(text.slice(0, 3)))
  }
}

console.log('expected (typed):', JSON.stringify(expected))
scan('real', `${real}${BS}session.jsonl`)
scan('tilde', `${tilde}${BS}session.jsonl`)
for (const d of [`${real}${BS}.pi-sessions`, `${real}${BS}.pi-agent`]) {
  if (existsSync(d)) console.log('\n' + d.split(BS).slice(-2).join(BS) + ':', readdirSync(d).slice(0, 10).join(', '))
}
