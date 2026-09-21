/**
 * One-off: retire the "artifacts" wording I introduced for the conversation
 * header menu, in favour of "websites".
 *
 * The locale files are sorted by key, so this is not a rename in place: the key
 * moves to where `chat.websites` belongs (just before the first `chat.w*` key),
 * and the three keys that only existed for the old menu's groups are dropped
 * (`chat.artifactsEmpty` / `chat.artifactsPages` / `chat.artifactsPrototype` —
 * the prototype row was removed with the prototype side untouched).
 *
 * Usage: bun scripts/retire-artifacts-wording.ts [--write]
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir ?? new URL('.', import.meta.url).pathname, '..')
const LOCALES = join(ROOT, 'packages/shared/src/i18n/locales')
const WRITE = process.argv.includes('--write')

/** The value that replaces `chat.artifacts`, per locale. */
const LABEL: Record<string, string> = {
  'en.json': 'Websites from this conversation ({{count}})',
  'zh-Hans.json': '本次对话的网站（{{count}}）',
  'de.json': 'Websites aus diesem Gespräch ({{count}})',
  'es.json': 'Sitios web de esta conversación ({{count}})',
  'ja.json': 'この会話のウェブサイト（{{count}}）',
  'pl.json': 'Strony z tej rozmowy ({{count}})',
  'hu.json': 'Weboldalak ebből a beszélgetésből ({{count}})',
}

const DEAD_KEYS = ['chat.artifactsEmpty', 'chat.artifactsPages', 'chat.artifactsPrototype']

for (const file of readdirSync(LOCALES).filter(f => f.endsWith('.json')).sort()) {
  const path = join(LOCALES, file)
  const original = readFileSync(path, 'utf-8')
  const eol = original.includes('\r\n') ? '\r\n' : '\n'
  const lines = original.split(/\r?\n/)

  // 1. Drop the dead keys and the old value line.
  const kept = lines.filter(line => {
    const key = line.match(/^\s*"([^"]+)":/)?.[1]
    if (!key) return true
    return key !== 'chat.artifacts' && !DEAD_KEYS.includes(key)
  })

  // 2. Insert the new key where it sorts: before the first `chat.w*` key.
  const label = LABEL[file]
  if (!label) throw new Error(`No label for ${file}`)
  const entry = `  "chat.websites": ${JSON.stringify(label)},`
  const insertAt = kept.findIndex(line => /^\s*"chat\.w/.test(line))
  if (insertAt < 0) throw new Error(`No chat.w* key in ${file} — cannot place chat.websites`)
  kept.splice(insertAt, 0, entry)

  const updated = kept.join(eol)
  if (updated === original) continue
  if (WRITE) writeFileSync(path, updated, 'utf-8')
  console.log(`${WRITE ? 'updated' : 'would update'} ${file}`)
}

if (!WRITE) console.log('\nRe-run with --write to apply.')
