/**
 * Where `--out` puts a screenshot, and writing it there.
 *
 * Two doors capture pictures — `browser_tool` and `computer_tool` — and both answer the same way:
 * with `--out` the file **is** the answer, and the reply carries its path instead of an image. One
 * owner, one answer: the process that wrote the bytes is the one that says where they went, so a
 * caller never has to reconcile a file against a second copy of the same capture.
 *
 * The path rules are `media_tool --out`'s, so every door behaves the same: a directory gets the next
 * `screenshot-0001.ext`, anything that reads as a file is written exactly there (its extension
 * corrected to the image's real format rather than leaving PNG bytes in a `.jpg`), and a relative
 * path counts from the workspace.
 */

import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { resolveLocalPath } from './command-cli.ts'

export type ScreenshotMimeType = 'image/png' | 'image/jpeg'

export function screenshotOutputPath(
  requested: string,
  mimeType: ScreenshotMimeType,
  workspaceRootPath?: string,
): string {
  return outputPath(requested, mimeType === 'image/jpeg' ? 'jpg' : 'png', 'screenshot', workspaceRootPath)
}

/**
 * The file a `pdf` command writes.
 *
 * Same rules, different extension and a `page-` prefix: a directory receives `page-0001.pdf`, which
 * reads as what it is beside `screenshot-0001.png` in the same folder.
 */
export function pdfOutputPath(requested: string, workspaceRootPath?: string): string {
  return outputPath(requested, 'pdf', 'page', workspaceRootPath)
}

function outputPath(
  requested: string,
  ext: string,
  prefix: string,
  workspaceRootPath?: string,
): string {
  let resolved: string
  try {
    resolved = resolveLocalPath(requested, workspaceRootPath)
  } catch {
    throw new Error(
      `--out: "${requested}" is not absolute and there is no workspace to count a relative path from. ` +
      'Pass an absolute path.',
    )
  }
  let existing: ReturnType<typeof statSync> | null = null
  try {
    existing = statSync(resolved)
  } catch {
    existing = null
  }
  const looksLikeFile = existing == null && /\.(png|jpe?g|pdf)$/i.test(extname(resolved))

  if (existing?.isDirectory() || (existing == null && !looksLikeFile)) {
    mkdirSync(resolved, { recursive: true })
    for (let index = 1; ; index += 1) {
      const candidate = join(resolved, `${prefix}-${String(index).padStart(4, '0')}.${ext}`)
      if (!existsSync(candidate)) return candidate
    }
  }

  const givenExt = extname(resolved).toLowerCase()
  const file = !givenExt
    ? `${resolved}.${ext}`
    : givenExt === `.${ext}` || (ext === 'jpg' && givenExt === '.jpeg')
      ? resolved
      : `${resolved.slice(0, -givenExt.length)}.${ext}`
  mkdirSync(dirname(file), { recursive: true })
  return file
}

/** Write the captured bytes and answer where they went. */
export function writeScreenshotBytes(
  bytes: Uint8Array,
  mimeType: ScreenshotMimeType,
  requested: string,
  workspaceRootPath?: string,
): string {
  const file = screenshotOutputPath(requested, mimeType, workspaceRootPath)
  writeFileSync(file, bytes)
  return file
}

/** Write the printed document and answer where it went. */
export function writePdfBytes(
  bytes: Uint8Array,
  requested: string,
  workspaceRootPath?: string,
): string {
  const file = pdfOutputPath(requested, workspaceRootPath)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, bytes)
  return file
}
