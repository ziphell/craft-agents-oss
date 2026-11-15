/**
 * `img-tool resize|crop|rotate|flip|convert|normalize|info|watermark|composite|text` — the image
 * operations an agent needs on a file it was handed.
 *
 * Replaces the Python tool (`resources/scripts/img_tool.py`, kept as the reference) on **sharp**,
 * which the app already ships for image handling on every host. The command names, flags and the
 * JSON-on-stdout answer are the same, so the instructions and the read-only permission rules did not
 * change.
 *
 * `text` is new, and read-only like `info`: it reads the words on a picture with a local OCR engine
 * (`./ocr.ts`), so a picture's text needs no account and no model that can see. It answers what the
 * characters say and where they are — not what the picture means.
 *
 * A file in, a file out: `-o` names where the result goes, and it is never the input.
 *
 * Two deliberate differences, both stated rather than hidden:
 *
 * - **`.bmp` cannot be written.** sharp has no BMP encoder. Reading one works; a `convert --format bmp`
 *   is refused by name instead of writing something that is not what was asked for.
 * - **`--blend` is an opacity blend**, not a pixel-wise `Image.blend`: the overlay is fitted to the
 *   base and composited at that opacity. Same intent, different arithmetic at the edges.
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import sharp from 'sharp'
import { decimal, emit, fail, integer, parseArgs, text, toggle } from './args'
import { normalizeImage } from './normalize'
import { DEFAULT_MAX_SIDE, OCR_ENGINE, readText } from './ocr'

const USAGE = `Usage:
  img-tool resize <file> [--width n] [--height n] [--scale f] [--keep-aspect|--no-keep-aspect] -o <out>
  img-tool crop <file> --left n --top n --right n --bottom n -o <out>
  img-tool crop <file> --ratio 16:9 -o <out>
  img-tool rotate <file> --angle deg [--expand|--no-expand] [--fill-color #rrggbb] -o <out>
  img-tool flip <file> [--axis horizontal|vertical] -o <out>
  img-tool convert <file> --format png|jpeg|gif|tiff|webp -o <out>
  img-tool normalize <file> -o <out> [--quality n]
  img-tool info <file> [-o <out>]
  img-tool text <file> [--max-side n] [-o <out>]
  img-tool watermark <file> --text "…" [--font-size n] [--opacity 0-255] [--position …] [--color #rrggbb] -o <out>
  img-tool composite <base> <overlay> [--x n] [--y n] [--opacity 0-1] [--blend 0-1] -o <out>

Every command answers one JSON object on stdout. A command that changes a picture must name -o;
info and text write nothing unless -o is given.`

const WRITABLE = ['png', 'jpeg', 'jpg', 'gif', 'tiff', 'tif', 'webp'] as const
type Writable = (typeof WRITABLE)[number]

const POSITIONS = ['center', 'bottom-right', 'bottom-left', 'top-right', 'top-left'] as const
type Position = (typeof POSITIONS)[number]

/** The format a file name asks for, so `-o out.jpg` does not silently write a PNG. */
function formatOf(path: string): Writable | null {
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase()
  if (!extension) return null
  return (WRITABLE as readonly string[]).includes(extension) ? (extension as Writable) : null
}

/** The conversation folder a `session:` handle is counted from, set by the tool shell. */
const SESSION_DIR = process.env.CRAFT_SESSION_DIR?.trim() || null

/**
 * A path from the command line.
 *
 * `session:assets/x.png` names a file in the conversation's own folder — the same handle the
 * media and library tools print — so a session outside a project can hand over a generated file
 * without an absolute path. Without `CRAFT_SESSION_DIR` there is no folder to count from, and the
 * refusal says so by name instead of guessing one.
 */
function resolveFile(raw: string): string {
  const value = raw.trim()
  if (!/^session:/i.test(value)) return resolve(value)
  if (!SESSION_DIR) {
    fail('`session:` names the conversation folder, and this shell has no CRAFT_SESSION_DIR. Pass a normal path instead.')
  }
  return resolve(SESSION_DIR!, value.slice('session:'.length))
}

/** Encode and write; `-o` is where the result goes, and it is never the input. */
async function commit(
  image: sharp.Sharp,
  output: string | undefined,
  formatOverride?: Writable,
): Promise<void> {
  if (!output) {
    // `-o` is required by every command that changes a picture: an operation with nowhere to put
    // its result would only have stdout, and stdout here carries JSON.
    fail('This command needs `-o <output>`.')
  }
  const format = formatOverride ?? formatOf(output)
  const encoded = format ? image.toFormat(format === 'jpg' ? 'jpeg' : format) : image
  const info = await encoded.toFile(output)
  emit(undefined, JSON.stringify({ output, format: info.format, width: info.width, height: info.height, size: info.size }))
}

/** `16:9`, `1.777`, `16x9` — the ratio a centred crop should take. */
function ratioOf(value: string): number {
  const [left, right] = value.toLowerCase().split(/[:x/]/)
  const width = Number(left)
  const height = right === undefined ? Number(left) : Number(right)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    fail(`--ratio takes a shape like 16:9, not "${value}".`)
  }
  return width / height
}

/** The largest centred rectangle of `aspect` inside the picture. */
function centredCrop(
  width: number,
  height: number,
  aspect: number,
): { left: number; top: number; width: number; height: number } {
  let cropWidth = width
  let cropHeight = Math.round(cropWidth / aspect)
  if (cropHeight > height) {
    cropHeight = height
    cropWidth = Math.round(cropHeight * aspect)
  }
  return {
    left: Math.max(0, Math.round((width - cropWidth) / 2)),
    top: Math.max(0, Math.round((height - cropHeight) / 2)),
    width: cropWidth,
    height: cropHeight,
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2), new Set(['keep-aspect', 'no-keep-aspect', 'expand', 'no-expand']))
  const command = parsed.positional[0]?.toLowerCase()
  if (parsed.flags.help || !command) {
    process.stdout.write(`${USAGE}\n`)
    process.exit(parsed.flags.help ? 0 : 1)
  }

  const file = parsed.positional[1]
  if (!file) fail(`${command} needs a file.`)
  const path = resolveFile(file)
  if (!existsSync(path)) fail(`No such file: ${path}`)
  const outputFlag = text(parsed, 'output')
  const output = outputFlag ? resolveFile(outputFlag) : undefined
  // A result is a second file: writing over the picture it was made from is never the answer.
  if (output && output === path) {
    fail('The output cannot be the input file. Choose another -o.')
  }

  switch (command) {
    case 'resize': {
      const width = integer(parsed, 'width')
      const height = integer(parsed, 'height')
      const scale = decimal(parsed, 'scale')
      if (!width && !height && !scale) fail('resize needs --width, --height or --scale.')
      const keepAspect = toggle(parsed, 'keep-aspect') ?? true
      let image = sharp(path)
      if (scale) {
        const meta = await image.metadata()
        if (!meta.width || !meta.height) fail(`${path}: cannot read its size`)
        image = image.resize({ width: Math.round(meta.width * scale), height: Math.round(meta.height * scale) })
      } else {
        image = image.resize({ width, height, fit: keepAspect ? 'inside' : 'fill' })
      }
      await commit(image, output)
      return
    }

    case 'crop': {
      const left = integer(parsed, 'left')
      const top = integer(parsed, 'top')
      const right = integer(parsed, 'right')
      const bottom = integer(parsed, 'bottom')
      const ratio = text(parsed, 'ratio')
      let rect: { left: number; top: number; width: number; height: number }
      if (ratio) {
        if (left !== undefined || top !== undefined || right !== undefined || bottom !== undefined) {
          fail('crop takes either --ratio or the four edges, not both.')
        }
        const meta = await sharp(path).metadata()
        if (!meta.width || !meta.height) fail(`${path}: cannot read its size`)
        rect = centredCrop(meta.width, meta.height, ratioOf(ratio))
      } else {
        if (left === undefined || top === undefined || right === undefined || bottom === undefined) {
          fail('crop needs --ratio 16:9, or --left, --top, --right and --bottom.')
        }
        const width = right - left
        const height = bottom - top
        if (width <= 0 || height <= 0) fail('crop needs right > left and bottom > top.')
        rect = { left, top, width, height }
      }
      await commit(sharp(path).extract(rect), output)
      return
    }

    case 'rotate': {
      const angle = decimal(parsed, 'angle')
      if (angle === undefined) fail('rotate needs --angle <degrees>.')
      const expand = toggle(parsed, 'expand') ?? true
      const background = text(parsed, 'fill-color') ?? '#ffffff'
      // PIL's angle is counter-clockwise and sharp's is clockwise, so the sign is the difference.
      const rotated = sharp(path).rotate(-angle, { background })
      if (expand) {
        await commit(rotated, output)
        return
      }
      // `--no-expand` keeps the original frame: rotate onto a larger frame, then cut the centre out.
      const meta = await sharp(path).metadata()
      const buffer = await rotated.toBuffer()
      const grown = await sharp(buffer).metadata()
      if (!meta.width || !meta.height) fail(`${path}: cannot read its size`)
      const left = Math.max(0, Math.round(((grown.width ?? meta.width) - meta.width) / 2))
      const top = Math.max(0, Math.round(((grown.height ?? meta.height) - meta.height) / 2))
      await commit(sharp(buffer).extract({ left, top, width: meta.width, height: meta.height }), output)
      return
    }

    case 'flip': {
      const axis = (text(parsed, 'axis') ?? 'horizontal').toLowerCase()
      if (axis !== 'horizontal' && axis !== 'vertical') {
        fail('--axis takes horizontal (mirror left-right) or vertical (mirror top-bottom).')
      }
      // sharp names the two mirrors by their arithmetic: `flop` is left-right, `flip` is top-bottom.
      const image = axis === 'horizontal' ? sharp(path).flop() : sharp(path).flip()
      await commit(image, output)
      return
    }

    case 'convert': {
      const format = (text(parsed, 'format') ?? '').toLowerCase()
      if (!format) fail(`convert needs --format (${WRITABLE.join(' / ')}).`)
      if (format === 'bmp') fail('sharp has no BMP encoder: write png, jpeg, webp, gif or tiff instead.')
      if (!(WRITABLE as readonly string[]).includes(format)) {
        fail(`--format takes ${WRITABLE.join(' / ')}.`)
      }
      await commit(sharp(path), output, format as Writable)
      return
    }

    case 'normalize': {
      // The picture a viewer shows, before anything downstream reads a pixel: HEIC decoded (sharp
      // cannot), EXIF orientation baked in, metadata dropped. A picture already right is copied —
      // re-encoding it would cost quality for nothing. `changed: false` says it was a copy.
      if (!output) fail('normalize needs `-o <output>`.')
      const quality = integer(parsed, 'quality') ?? 92
      if (quality < 1 || quality > 100) fail('--quality takes 1–100.')
      const answer = await normalizeImage(path, output, { quality }).catch((error: unknown) =>
        fail(error instanceof Error ? error.message : String(error)),
      )
      emit(undefined, JSON.stringify({ path, output, ...answer }, null, 2))
      return
    }

    case 'info': {
      const meta = await sharp(path).metadata()
      const stats = await sharp(path).stats()
      emit(
        output,
        JSON.stringify(
          {
            path,
            format: meta.format,
            width: meta.width,
            height: meta.height,
            channels: meta.channels,
            hasAlpha: meta.hasAlpha,
            space: meta.space,
            density: meta.density,
            orientation: meta.orientation,
            size: meta.size,
            hasProfile: meta.hasProfile,
            isAnimated: meta.pages !== undefined && meta.pages > 1,
            pages: meta.pages,
            // The per-channel means are what "is this page blank or mostly one colour" is answered
            // with, without a second tool.
            channelMeans: stats.channels.map((channel) => Math.round(channel.mean * 10) / 10),
          },
          null,
          2,
        ),
      )
      return
    }

    case 'text': {
      // Read-only, like `info`: the answer is the words, and `-o` only decides where it is written.
      // `--max-side` trades small-text accuracy for memory and time; 960 is the measured default.
      const maxSide = integer(parsed, 'max-side') ?? DEFAULT_MAX_SIDE
      if (maxSide < 320) fail('--max-side takes 320 or more.')
      const answer = await readText(path, { maxSide }).catch((error: unknown) =>
        fail(error instanceof Error ? error.message : String(error)),
      )
      emit(
        output,
        JSON.stringify(
          {
            path,
            engine: OCR_ENGINE,
            // The oriented size, not the stored one: a phone photo can be sideways on disk with
            // its real orientation in EXIF, and the boxes are in the pixels a viewer shows.
            width: answer.width,
            height: answer.height,
            lineCount: answer.lines.length,
            text: answer.text,
            lines: answer.lines,
          },
          null,
          2,
        ),
      )
      return
    }

    case 'watermark': {
      const label = text(parsed, 'text')
      if (!label) fail('watermark needs --text "…".')
      const fontSize = integer(parsed, 'font-size') ?? 36
      const opacityByte = integer(parsed, 'opacity') ?? 128
      const opacity = opacityByte / 255
      const color = text(parsed, 'color') ?? '#ffffff'
      const position = (text(parsed, 'position') ?? 'center') as Position
      if (!(POSITIONS as readonly string[]).includes(position)) fail(`--position takes ${POSITIONS.join(' / ')}.`)

      const meta = await sharp(path).metadata()
      const width = meta.width ?? 0
      const height = meta.height ?? 0
      const escaped = label.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
        <text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle"
              font-family="sans-serif" font-size="${fontSize}" fill="${color}" fill-opacity="${opacity.toFixed(3)}"
              transform="rotate(-30 ${width / 2} ${height / 2})">${escaped}</text>
      </svg>`
      const gravity =
        position === 'center' ? 'centre' : position === 'bottom-right' ? 'southeast' : position === 'bottom-left' ? 'southwest' : position === 'top-right' ? 'northeast' : 'northwest'
      await commit(sharp(path).composite([{ input: Buffer.from(svg), gravity, blend: 'over' }]), output)
      return
    }

    case 'composite': {
      const overlayFile = parsed.positional[2]
      if (!overlayFile) fail('composite needs a base file and an overlay file.')
      const overlayPath = resolveFile(overlayFile)
      if (!existsSync(overlayPath)) fail(`No such file: ${overlayPath}`)
      const x = integer(parsed, 'x') ?? 0
      const y = integer(parsed, 'y') ?? 0
      const opacity = decimal(parsed, 'opacity') ?? 1
      const blend = decimal(parsed, 'blend')
      const base = sharp(path)
      const meta = await base.metadata()

      let overlay = sharp(overlayPath)
      if (blend !== undefined) {
        // The whole-image blend: the overlay is fitted to the base and laid over it at that weight.
        overlay = overlay.resize({ width: meta.width, height: meta.height, fit: 'fill' })
      }
      let input = await overlay.png().toBuffer()
      const alpha = blend ?? opacity
      if (alpha < 1) {
        // sharp has no per-composite opacity; the alpha channel is where it lives.
        const channel = await sharp(input).ensureAlpha(alpha).png().toBuffer()
        input = channel
      }
      await commit(base.composite([{ input, left: x, top: y, blend: 'over' }]), output)
      return
    }

    default:
      fail(`No such command: ${command}. Try resize, crop, rotate, flip, convert, info, text, watermark or composite.`)
  }
}

await main()
