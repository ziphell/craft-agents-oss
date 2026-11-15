import { app, session } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { registerPrivilegedSchemes } from '../src/main/thumbnail-protocol'
import { registerLocalOriginHandler } from '../src/main/local-origin-router'
import { captureOfficePage } from '../src/main/office-page-capture'

registerPrivilegedSchemes()
app.on('window-all-closed', () => {})

const BENCH = 'C:/Users/Ryan/.craft-agent/workspaces/my-workspace/sessions/261102-rapid-diamond/data/bench'
const DOCUMENTS = ['long.docx', 'brief.docx', 'huge.docx', 'zzz.docx'].map((name) => join(BENCH, name))

/** Run `jobs` with at most `limit` in flight; answer wall-clock and each job's own time. */
async function runWith(limit: number): Promise<{ wall: number; each: number[] }> {
  const started = Date.now()
  const each: number[] = []
  let cursor = 0
  const workers = Array.from({ length: limit }, async () => {
    while (cursor < DOCUMENTS.length) {
      const path = DOCUMENTS[cursor++]!
      const t0 = Date.now()
      await captureOfficePage('docs', path, new Uint8Array(readFileSync(path)))
      each.push(Date.now() - t0)
    }
  })
  await Promise.all(workers)
  return { wall: Date.now() - started, each: each.sort((a, b) => a - b) }
}

app
  .whenReady()
  .then(async () => {
    registerLocalOriginHandler(session.defaultSession)
    // A warm-up, so the first run does not pay for the editor bundle alone.
    await captureOfficePage('docs', DOCUMENTS[0]!, new Uint8Array(readFileSync(DOCUMENTS[0]!)))
    console.log('warmed')
    for (const limit of [1, 2, 3, 4]) {
      const { wall, each } = await runWith(limit)
      console.log(
        `limit ${limit}: wall ${wall} ms · each ${each.map((n) => `${(n / 1000).toFixed(1)}s`).join(' ')}`,
      )
    }
    app.exit(0)
  })
  .catch((error: unknown) => {
    console.error(error)
    app.exit(1)
  })
