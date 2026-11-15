/**
 * `img-tool text` — the words on a picture, read on this machine.
 *
 * PP-OCRv6 (tiny) through onnxruntime: detection finds the lines, recognition reads them. The
 * models are not in git; `bun run fetch:ocr-models` stages them under `cli-tools/models/ocr`, and
 * `bun run build:cli-tools` copies them beside the bundle as `dist/models/ocr`.
 *
 * This is **reading** a picture, not understanding one: every character, the box it sits in, and
 * how sure the model is. What the picture means is still `call_llm`'s question — a model that can
 * see answers that, and it cannot be audited character by character the way this can.
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import sharp from 'sharp'

/** Named in the answer, so a caller can tell which engine produced the words. */
export const OCR_ENGINE = 'PP-OCRv6_tiny'

const MODEL_FILES = ['det.onnx', 'rec.onnx', 'dict.txt'] as const

/**
 * `--max-side`'s default, and why it is not the preset's own.
 *
 * The `PP-OCRv6_tiny` preset resizes with `limitType: "min"` / `maxSideLength: 736`: a picture
 * whose short side is under 736 is **scaled up** until it reaches it. On a 1920×1080 screenshot
 * that leaves the detection input at the picture's own size — four times the pixels of 960×540.
 * Measured on one 1080p screenshot: 562–629 ms / 729 MB at the preset default, 269–330 ms / 397 MB
 * with `max` / 960, and the same words. `--max-side` is the way out when the text is very small.
 */
export const DEFAULT_MAX_SIDE = 960

/** A line of words, with the rectangle it was found in. */
export interface OcrLine {
  text: string
  confidence: number
  box: { x: number; y: number; width: number; height: number }
}

export interface OcrAnswer {
  text: string
  lines: OcrLine[]
  /** Dimensions after EXIF orientation is applied — the pixels the boxes refer to. */
  width: number
  height: number
}

/** Where the models are: beside the bundle, unless the caller points somewhere else. */
function modelsDir(): string {
  return process.env.CRAFT_OCR_MODELS_DIR?.trim() || join(import.meta.dir, 'models', 'ocr')
}

const missingModels = (dir: string): never => {
  throw new Error(
    `OCR models are not installed in ${dir}. Run \`bun run fetch:ocr-models\` and rebuild the tools (\`bun run build:cli-tools\`).`,
  )
}

/**
 * Read the words on `file`.
 *
 * The picture goes in as pixels straight from sharp — no second image decoder — and the answer is
 * per detected box, in reading order, so a caller can say where a line was as well as what it says.
 *
 * `rotate()` with no angle applies the EXIF orientation before the pixels are read. A phone photo
 * is often stored sideways with `Orientation=6/8`; without this the detector sees a picture lying
 * on its side, recognition reads vertical strips as if they were lines, and the boxes describe
 * pixels nobody looking at the photo would recognise. Everything returned is in the displayed
 * orientation — the same one a viewer (and the app's preview) shows.
 */
export async function readText(file: string, options: { maxSide?: number } = {}): Promise<OcrAnswer> {
  const dir = modelsDir()
  for (const name of MODEL_FILES) {
    if (!existsSync(join(dir, name))) missingModels(dir)
  }

  // Both are imported here, not at the top: every other command (`resize`, `info`, …) must not pay
  // for a native runtime it never touches.
  const [{ PaddleOcrService }, ort] = await Promise.all([import('paddleocr'), import('onnxruntime-node')])

  const toArrayBuffer = (buffer: Buffer): ArrayBuffer =>
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer

  const [detModel, recModel, dictionary] = await Promise.all([
    readFile(join(dir, 'det.onnx')),
    readFile(join(dir, 'rec.onnx')),
    readFile(join(dir, 'dict.txt'), 'utf-8'),
  ])

  const service = await PaddleOcrService.createInstance({
    // `paddleocr` types `ort` against its own narrow `OrtModule` (a `create(modelBuffer)` session
    // shape); onnxruntime-node's module is that object, with wider overloads. The cast is the
    // difference between the two declarations, not between two runtimes.
    ort: ort as unknown as NonNullable<Parameters<typeof PaddleOcrService.createInstance>[0]>['ort'],
    modelPreset: 'PP-OCRv6_tiny',
    detection: {
      modelBuffer: toArrayBuffer(detModel),
      limitType: 'max',
      maxSideLength: Math.max(320, options.maxSide ?? DEFAULT_MAX_SIDE),
    },
    recognition: {
      modelBuffer: toArrayBuffer(recModel),
      charactersDictionary: dictionary.trimEnd().split(/\r?\n/),
    },
  })

  const { data, info } = await sharp(file)
    .rotate()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  const results = await service.recognize({
    width: info.width,
    height: info.height,
    data: new Uint8Array(data),
  })

  const round = (value: number): number => Math.round(value * 10_000) / 10_000
  return {
    text: service.processRecognition(results).text,
    lines: results.map((line) => ({
      text: line.text,
      confidence: round(line.confidence),
      box: {
        x: Math.round(line.box.x),
        y: Math.round(line.box.y),
        width: Math.round(line.box.width),
        height: Math.round(line.box.height),
      },
    })),
    width: info.width,
    height: info.height,
  }
}
