import { describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCliPrint } from '../office-print.ts'

/**
 * The hub's printer is a spawn, so what is worth testing is the contract, not the browser: the
 * envelope's `ok` is not enough (there must be a file), and a refusal has to arrive as the
 * launcher's own sentence rather than as "something went wrong".
 */
describe('createCliPrint', () => {
  it('answers with the file it wrote, and only because the file is there', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'craft-print-test-'))
    try {
      const script = join(dir, 'fake-export.mjs')
      await writeFile(
        script,
        [
          "import { writeFileSync } from 'node:fs'",
          'const out = process.argv[process.argv.indexOf("--out") + 1]',
          'writeFileSync(out, "not really a pdf")',
          'console.log(JSON.stringify({ command: "export", status: "ok", output_path: out }))',
        ].join('\n'),
      )
      const print = createCliPrint({ command: process.execPath, prefixArgs: [script] })
      const written = await print({ app: 'slides', path: join(dir, 'deck.pptx'), bytes: new Uint8Array(0) })
      expect(written).toBe(join(dir, 'deck.pdf'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses with the launcher’s words when it reports a failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'craft-print-test-'))
    try {
      const script = join(dir, 'fake-export.mjs')
      await writeFile(
        script,
        'console.log(JSON.stringify({ command: "export", status: "error", error: "renderer_unavailable", message: "No Chromium could be launched." }))',
      )
      const print = createCliPrint({ command: process.execPath, prefixArgs: [script] })
      await expect(print({ app: 'docs', path: join(dir, 'brief.docx'), bytes: new Uint8Array(0) })).rejects.toThrow(
        'No Chromium could be launched.',
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('does not take a success envelope for an answer when no file was written', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'craft-print-test-'))
    try {
      const script = join(dir, 'fake-export.mjs')
      // The one lie a launcher can tell: "ok" and nothing on disk.
      await writeFile(script, 'console.log(JSON.stringify({ command: "export", status: "ok" }))')
      const print = createCliPrint({ command: process.execPath, prefixArgs: [script] })
      await expect(print({ app: 'docs', path: join(dir, 'missing.docx'), bytes: new Uint8Array(0) })).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
