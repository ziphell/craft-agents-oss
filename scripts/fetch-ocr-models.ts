/**
 * Fetch the OCR models `img-tool text` reads.
 *
 * They are not vendored in git: the pair is 6 MB of ONNX, and like drawio (`fetch-drawio-assets.ts`)
 * a pinned upstream release is fetched into a gitignored folder instead. `resources/cli-tools/models/`
 * is that folder; `build:cli-tools` copies it into `dist/models/ocr`, which is where the bundle looks.
 *
 *   bun scripts/fetch-ocr-models.ts            # fetch once
 *   bun scripts/fetch-ocr-models.ts --force    # refetch even if the stamp matches
 *
 * Two rules keep this honest:
 *
 * - **Both revisions are pinned by commit**, not by `main`: an OCR result that changes because
 *   upstream retrained a model is a change nobody asked this repository for.
 * - **Every byte is pinned too.** Each model carries its expected size and SHA-256, and a download
 *   is rejected (mirror by mirror) unless both match — a truncated transfer or a rewritten tag at
 *   the same commit is caught here rather than surfacing as garbled OCR at run time. The dictionary
 *   is checked the same way once extracted, since it is generated rather than downloaded.
 * - **The dictionary is extracted from the model's own `inference.yml`,** not downloaded from
 *   somewhere else. PP-OCRv6's recognition model ships 6904 characters there, and a dictionary that
 *   disagrees with the model by even one entry shifts every index after it.
 *
 * The pinned revision is fetched from the first mirror that answers; `hf-mirror.com` is what makes
 * this workable from a network where `huggingface.co` is blocked.
 *
 * `PP-OCRv6_tiny` is the tiny tier: 1.7 MB detection + 4.3 MB recognition. It was chosen over
 * `PP-OCRv5_mobile` after measuring both — same words, but a quarter of the download and half the
 * cold start. The resize strategy is not the preset default; see `ocr.ts` for that measurement.
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const OUT_DIR = join(import.meta.dir, '..', 'apps', 'electron', 'resources', 'cli-tools', 'models', 'ocr')
const STAMP_FILE = join(OUT_DIR, 'manifest.json')

/** An upstream file. `bytes`/`sha256` pin the content when it is a model we load at run time. */
interface UpstreamFile {
  repo: string
  revision: string
  file: string
  bytes?: number
  sha256?: string
}

/** The recognition model whose `inference.yml` carries the character list. */
const DET: UpstreamFile = {
  repo: 'PaddlePaddle/PP-OCRv6_tiny_det_onnx',
  revision: '2ba1506c0380b8f0b03dd142459aac66d4421f6c',
  file: 'inference.onnx',
  bytes: 1_780_590,
  sha256: '193bab7a04fca699a6c82e6abb5b81bdb28177f0abd4062552b04908dafb19f8',
}
const REC: UpstreamFile = {
  repo: 'PaddlePaddle/PP-OCRv6_tiny_rec_onnx',
  revision: '2612ab37152ae0a677521bae4e1e3d4fb4cf7c30',
  file: 'inference.onnx',
  bytes: 4_462_639,
  sha256: '9ef676d6ed3c88256a2d92c640c44f25b0c40947e111b14b8be8f594091563e6',
}
// Not downloaded: extracted from REC's `inference.yml`, then checked against this stamp so a
// dictionary that drifted from the model cannot be written.
const DICT = {
  bytes: 27_153,
  sha256: '46e1b34ef45684cb46d75ac76d355341fe7f0a2c38d6ee02e63ae6b3878019fc',
}
const REC_CONFIG = { repo: REC.repo, revision: REC.revision, file: 'inference.yml' }

const FORCE = process.argv.includes('--force')

/** Tried in order; the pinned revision is the same on each. */
const MIRRORS = ['https://huggingface.co', 'https://hf-mirror.com', 'https://aifasthub.com']

const url = (host: string, entry: { repo: string; revision: string; file: string }): string =>
  `${host}/${entry.repo}/resolve/${entry.revision}/${entry.file}`

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

/** Throw unless the bytes are exactly what the pin says. */
function assertBytes(label: string, bytes: Buffer, expected: { bytes?: number; sha256?: string }): void {
  if (expected.bytes !== undefined && bytes.byteLength !== expected.bytes) {
    throw new Error(`${label}: expected ${expected.bytes} bytes, got ${bytes.byteLength}`)
  }
  if (expected.sha256 && sha256(bytes) !== expected.sha256) {
    throw new Error(`${label}: sha256 ${sha256(bytes)} does not match the pinned ${expected.sha256}`)
  }
}

/**
 * Download one file, verified, retried per mirror, so a blocked host or a transient reset does not
 * fail the fetch. A file already on disk is reused only when it still matches the pin.
 */
async function download(entry: UpstreamFile, target: string): Promise<Buffer> {
  if (!FORCE && existsSync(target)) {
    const cached = readFileSync(target)
    try {
      assertBytes(entry.file, cached, entry)
      return cached
    } catch {
      rmSync(target, { force: true })
    }
  }

  const attempts = 3
  let lastError: unknown
  for (const host of MIRRORS) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const response = await fetch(url(host, entry), {
          headers: { 'user-agent': 'craft-agent-fetch-ocr-models' },
        })
        if (!response.ok) {
          throw new Error(`${entry.repo}/${entry.file} from ${host}: ${response.status} ${response.statusText}`)
        }
        const bytes = Buffer.from(await response.arrayBuffer())
        assertBytes(entry.file, bytes, entry)
        writeFileSync(target, bytes)
        return bytes
      } catch (error) {
        lastError = error
        if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 500))
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/**
 * The `character_dict:` list from a PP-OCR `inference.yml`.
 *
 * Entries are single-quoted (`- '!'`), double-quoted, or bare. `''` is one apostrophe, so the
 * single-quoted form is unescaped by halving doubled quotes — the same rule YAML uses.
 */
function characterDict(yml: string): string[] {
  const lines = yml.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === 'character_dict:')
  if (start < 0) throw new Error('inference.yml has no character_dict block')

  const characters: string[] = []
  for (const line of lines.slice(start + 1)) {
    const match = /^\s*-\s(.*)$/.exec(line)
    if (!match) break
    const value = match[1]!.trimEnd()
    if (value.startsWith("'") && value.endsWith("'")) characters.push(value.slice(1, -1).replace(/''/g, "'"))
    else if (value.startsWith('"') && value.endsWith('"')) characters.push(JSON.parse(value) as string)
    else characters.push(value)
  }
  return characters
}

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`

/** The three files `img-tool text` reads, and whether they are all on disk and match the pins. */
const OUTPUTS = { det: 'det.onnx', rec: 'rec.onnx', dict: 'dict.txt' } as const

function installed(): boolean {
  try {
    assertBytes(OUTPUTS.det, readFileSync(join(OUT_DIR, OUTPUTS.det)), DET)
    assertBytes(OUTPUTS.rec, readFileSync(join(OUT_DIR, OUTPUTS.rec)), REC)
    assertBytes(OUTPUTS.dict, readFileSync(join(OUT_DIR, OUTPUTS.dict)), DICT)
    return true
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  if (!FORCE && installed()) {
    console.log('✓ resources/cli-tools/models/ocr is already at PP-OCRv6_tiny (pass --force to refetch)')
    return
  }

  console.log('Fetching PP-OCRv6_tiny → resources/cli-tools/models/ocr …')
  if (FORCE) rmSync(OUT_DIR, { recursive: true, force: true })
  mkdirSync(OUT_DIR, { recursive: true })

  const det = await download(DET, join(OUT_DIR, OUTPUTS.det))
  const rec = await download(REC, join(OUT_DIR, OUTPUTS.rec))
  const config = await download(REC_CONFIG, join(OUT_DIR, 'rec-inference.yml'))
  const characters = characterDict(config.toString('utf-8'))
  if (characters.length === 0) throw new Error('the character_dict block is empty')

  const dict = Buffer.from(`${characters.join('\n')}\n`, 'utf-8')
  assertBytes(OUTPUTS.dict, dict, DICT)
  writeFileSync(join(OUT_DIR, OUTPUTS.dict), dict)
  rmSync(join(OUT_DIR, 'rec-inference.yml'))

  writeFileSync(
    STAMP_FILE,
    `${JSON.stringify(
      {
        model: 'PP-OCRv6_tiny',
        det: DET.revision,
        rec: REC.revision,
        files: {
          [OUTPUTS.det]: { bytes: det.byteLength, sha256: sha256(det) },
          [OUTPUTS.rec]: { bytes: rec.byteLength, sha256: sha256(rec) },
          [OUTPUTS.dict]: { bytes: dict.byteLength, sha256: sha256(dict) },
        },
        characters: characters.length,
        fetchedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    'utf-8',
  )

  console.log(`\n✓ det.onnx ${mb(det.byteLength)} · rec.onnx ${mb(rec.byteLength)} · dict.txt ${characters.length} characters`)
  console.log('  next: bun run build:cli-tools (stages them as dist/models/ocr)')
}

await main()
