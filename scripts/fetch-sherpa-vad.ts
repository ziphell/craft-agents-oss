/**
 * Fetch the Silero VAD model local speech recognition splits recordings with.
 *
 * It is not vendored in git, for the same reason the OCR models are not: it is ONNX, it comes from
 * a pinned upstream release, and `resources/models/` is gitignored. The file is small (644 KB) but
 * a build that silently ships without it transcribes a recording as one long chunk — subtitles
 * still come out, they just lose the pauses that keep them readable.
 *
 *   bun run fetch:sherpa-vad            # fetch once
 *   bun run fetch:sherpa-vad --force    # refetch even if the file is already correct
 *
 * Where github.com is unreachable, `GH_ENDPOINT` names a download proxy and the upstream URL is
 * appended to it untouched:
 *
 *   GH_ENDPOINT=https://gh-proxy.com bun run fetch:sherpa-vad
 *
 * The release asset lives under a rolling tag (`asr-models`), so the guarantee is the checksum
 * rather than the URL: if upstream replaces the bytes, this fetch fails instead of quietly changing
 * where every subtitle boundary falls. A proxy does not change that — the checksum is what accepts
 * or rejects whatever it returns.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

const UPSTREAM = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx'
/** A mirror in front of github.com, when github.com itself is out of reach. */
const GH_ENDPOINT = process.env.GH_ENDPOINT?.trim().replace(/\/+$/, '')
const URL = GH_ENDPOINT ? `${GH_ENDPOINT}/${UPSTREAM}` : UPSTREAM
/** sha256 of the file this repository was built and tested against. */
const SHA256 = '9E2449E1087496D8D4CABA907F23E0BD3F78D91FA552479BB9C23AC09CBB1FD6'

const OUT_DIR = join(import.meta.dir, '..', 'apps', 'electron', 'resources', 'models')
const OUT_FILE = join(OUT_DIR, 'silero_vad.onnx')

const FORCE = process.argv.includes('--force')
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex').toUpperCase()

async function main(): Promise<void> {
  if (!FORCE && existsSync(OUT_FILE) && sha256(readFileSync(OUT_FILE)) === SHA256) {
    console.log('✓ resources/models/silero_vad.onnx is already the pinned silero VAD (pass --force to refetch)')
    return
  }

  console.log('Fetching silero_vad.onnx → resources/models …')
  const response = await fetch(URL, { headers: { 'user-agent': 'craft-agent-fetch-sherpa-vad' } })
  if (!response.ok) throw new Error(`${URL}: ${response.status} ${response.statusText}`)
  // Buffer, not ArrayBuffer: the checksum and the write both want bytes.
  const bytes = Buffer.from(await response.arrayBuffer())

  const digest = sha256(bytes)
  if (digest !== SHA256) {
    throw new Error(
      `silero_vad.onnx changed upstream: expected sha256 ${SHA256}, got ${digest}.\n` +
        'Not writing it — a different model moves every subtitle boundary. Update SHA256 in this script deliberately.',
    )
  }

  mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(OUT_FILE, bytes)
  console.log(`✓ resources/models/silero_vad.onnx ${(statSync(OUT_FILE).size / 1024).toFixed(0)} KB`)
}

await main()
