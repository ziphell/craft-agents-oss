/**
 * Make a picture the one a viewer shows, before anything downstream reads a pixel.
 *
 * Two cases need work, and they are the two places a phone photo goes wrong:
 *
 * - **HEIC/HEIF** — sharp cannot decode it at all (see `heic.ts`), so it is decoded here, then
 *   encoded as JPEG. The decoder has already applied the container's `irot`/orientation, so the
 *   pixels come out upright and no EXIF tag is written.
 * - **JPEG/WebP with `Orientation` 6/8** — stored sideways, upright only to a viewer. sharp does
 *   not rotate by default, so `.rotate()` (no angle) applies the tag, and the result is written as
 *   JPEG with no metadata. The tag goes away with the rotation baked in, which is the point:
 *   anything that later converts the file loses metadata and must not change the direction.
 * - **AVIF** — sharp decodes it, but no vision API takes it, so it is re-encoded as JPEG even when
 *   the pixels are already upright.
 *
 * Everything else is copied byte for byte. Re-encoding a picture that is already right costs
 * quality and time for nothing.
 */

import { copyFile, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import sharp from 'sharp'
import { decodeHeif } from './heic'

/** JPEG quality for the two re-encoding paths. High enough that the model sees the same picture. */
export const DEFAULT_QUALITY = 92

export interface NormalizedImage {
  /** Dimensions after orientation is applied. */
  width: number
  height: number
  /** True when the bytes were re-encoded; false when the input was copied unchanged. */
  changed: boolean
  /** `copy` means the output is byte-identical to the input. */
  format: 'jpeg' | 'copy'
  size: number
}

const HEIF = new Set(['.heic', '.heif'])
/** No vision API takes these, so they are re-encoded even when the pixels are already upright. */
const ALWAYS_JPEG = new Set(['.avif'])

/** Read `file`, write the usable picture to `out`, and say what happened. */
export async function normalizeImage(
  file: string,
  out: string,
  options: { quality?: number } = {},
): Promise<NormalizedImage> {
  const quality = options.quality ?? DEFAULT_QUALITY
  const extension = extname(file).toLowerCase()

  if (HEIF.has(extension)) {
    try {
      const decoded = await decodeHeif(file)
      await sharp(Buffer.from(decoded.data), {
        raw: { width: decoded.width, height: decoded.height, channels: 4 },
      })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality })
        .toFile(out)
    } catch (error) {
      // `.heif` is a container, not a codec: it may hold AV1 (an AVIF with the wrong name), and
      // libheif-js ships libde265 (HEVC) only. sharp's libvips can decode AV1, so try it before
      // reporting failure; a real HEIC fails there too and keeps libheif's error.
      const meta = await sharp(file).metadata().catch(() => null)
      if (!meta?.width || !meta?.height) throw error
      await sharp(file)
        .rotate()
        .flatten({ background: '#ffffff' })
        .jpeg({ quality })
        .toFile(out)
    }
    const written = await sharp(out).metadata()
    const { size } = await stat(out)
    return {
      width: written.width ?? 0,
      height: written.height ?? 0,
      changed: true,
      format: 'jpeg',
      size,
    }
  }

  if (ALWAYS_JPEG.has(extension)) {
    // Decodable, but no vision API takes it: re-encode, baking in any orientation on the way.
    await sharp(file)
      .rotate()
      .flatten({ background: '#ffffff' })
      .jpeg({ quality })
      .toFile(out)
    const written = await sharp(out).metadata()
    const { size } = await stat(out)
    return {
      width: written.width ?? 0,
      height: written.height ?? 0,
      changed: true,
      format: 'jpeg',
      size,
    }
  }

  const meta = await sharp(file).metadata()
  if (!meta.width || !meta.height) throw new Error(`${file}: cannot read its size`)
  // `orientation` is absent when the file carries none, which is the same as 1.
  if ((meta.orientation ?? 1) !== 1) {
    await sharp(file)
      .rotate()
      .flatten({ background: '#ffffff' })
      .jpeg({ quality })
      .toFile(out)
    const rotated = await sharp(out).metadata()
    const { size } = await stat(out)
    return {
      width: rotated.width ?? meta.height,
      height: rotated.height ?? meta.width,
      changed: true,
      format: 'jpeg',
      size,
    }
  }

  await copyFile(file, out)
  const { size } = await stat(out)
  return { width: meta.width, height: meta.height, changed: false, format: 'copy', size }
}
