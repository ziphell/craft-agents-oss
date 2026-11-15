/**
 * One frame of a cut, drawn in a window nobody sees.
 *
 * The same answer the exporter gives, for a single moment: the picture is painted by
 * `canvas-compositor` — the code the preview and an export share — so what the agent photographs
 * is what the player shows at that timestamp. Nothing here encodes video, so MediaBunny is used
 * only to decode one sample per visible clip.
 *
 * The page returns a JPEG data URL; the bytes are written here, because the path is the caller's.
 * Bundled separately (`scripts/electron-build-export-page.ts`) like the export page.
 */

import {
  ALL_FORMATS,
  BlobSource,
  Input,
  VideoSampleSink,
} from 'mediabunny'
import { clipSourceTime } from '../../../../packages/shared/src/reel/document'
import type { EditOverlay } from '../../../../packages/shared/src/reel/overlay'
import {
  drawComposition,
  type Picture,
  type RenderClip,
} from '../../../../packages/shared/src/reel/canvas-compositor'

export interface SnapshotJob {
  /** Absolute source paths — a project-relative path cannot be read from here. */
  clips: RenderClip[]
  /** Picture-in-picture sources are absolute too. */
  overlays: EditOverlay[]
  width: number
  height: number
  /** Timeline seconds. */
  at: number
  /** Cap the longest edge of the answer, so a 4K frame is not handed over at full size. */
  maxEdge?: number
}

export interface SnapshotAnswer {
  ok: boolean
  /** `data:image/jpeg;base64,…` — the host writes it and answers the path. */
  dataUrl?: string
  width?: number
  height?: number
  /** Sources that could not be decoded, so the caller knows what the picture is missing. */
  warnings?: string[]
  message?: string
}

interface Bridge {
  /** Read a source file as bytes. A `file://` page cannot fetch its own neighbours. */
  readFile: (path: string) => Promise<Uint8Array>
}

declare global {
  interface Window {
    // `editExport` is declared by the export page, which owns that preload; this page only borrows
    // its `readFile`, so it says so through a cast instead of declaring the same global twice.
    __snapshot: (job: SnapshotJob) => Promise<SnapshotAnswer>
  }
}

const bridge = () => (window as unknown as { editExport: Bridge }).editExport

/** A still picture, as opposed to a clip with frames. */
const STILL = /\.(png|jpe?g|webp|gif|avif|bmp|svg)$/i

/** One read per file: a source used twice must not cross the IPC boundary twice. */
const readCache = new Map<string, Promise<Uint8Array<ArrayBuffer>>>()
function bytesOf(path: string): Promise<Uint8Array<ArrayBuffer>> {
  const known = readCache.get(path)
  if (known) return known
  const reading = (async () => {
    const bytes = await bridge().readFile(path)
    const copy = new Uint8Array(bytes.byteLength)
    copy.set(bytes)
    return copy
  })()
  readCache.set(path, reading)
  return reading
}

window.__snapshot = async (job: SnapshotJob): Promise<SnapshotAnswer> => {
  const width = Math.max(2, Math.round(job.width))
  const height = Math.max(2, Math.round(job.height))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) return { ok: false, message: 'this window has no 2d canvas' }
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, width, height)

  const sinks = new Map<string, Promise<VideoSampleSink | null>>()
  const bitmaps = new Map<string, Promise<ImageBitmap | null>>()
  /** Sources the picture is missing, said once each — a black rectangle is not an answer. */
  const warnings: string[] = []
  const note = (path: string, error: unknown): void => {
    const why = error instanceof Error ? error.message : String(error)
    const line = `${path}: ${why}. Chromium reads H.264/VP9 and most MOV; HEVC needs a hardware decoder, and ProRes is not supported — convert the source to H.264 MP4.`
    if (!warnings.includes(line)) warnings.push(line)
  }

  /** One decoder per source file, opened only when a frame actually needs it. */
  const sinkOf = (path: string): Promise<VideoSampleSink | null> => {
    const known = sinks.get(path)
    if (known) return known
    const opening = (async () => {
      try {
        const input = new Input({
          formats: ALL_FORMATS,
          source: new BlobSource(new Blob([await bytesOf(path)])),
        })
        const track = await input.getPrimaryVideoTrack()
        return track ? new VideoSampleSink(track) : null
      } catch (error) {
        note(path, error)
        return null
      }
    })()
    sinks.set(path, opening)
    return opening
  }

  const bitmapOf = (path: string): Promise<ImageBitmap | null> => {
    const known = bitmaps.get(path)
    if (known) return known
    const opening = (async () => {
      try {
        return await createImageBitmap(new Blob([await bytesOf(path)]))
      } catch (error) {
        note(path, error)
        return null
      }
    })()
    bitmaps.set(path, opening)
    return opening
  }

  /** One decoded frame as a `Picture`, so the shared compositor can paint it. */
  const pictureFrom = async (
    path: string,
    kind: 'video' | 'image',
    sourceTime: number,
  ): Promise<Picture | null> => {
    if (kind === 'image') {
      const bitmap = await bitmapOf(path)
      return bitmap
        ? {
            width: bitmap.width,
            height: bitmap.height,
            draw: (target, x, y, w, h) => target.drawImage(bitmap, x, y, w, h),
          }
        : null
    }
    const sink = await sinkOf(path)
    try {
      const sample = sink ? await sink.getSample(sourceTime) : null
      if (!sample) return null
      return {
        width: sample.displayWidth,
        height: sample.displayHeight,
        draw: (target, x, y, w, h) => sample.draw(target, x, y, w, h),
        release: () => sample.close(),
      }
    } catch (error) {
      note(path, error)
      return null
    }
  }

  try {
    await drawComposition({
      ctx,
      canvas,
      clips: job.clips,
      overlays: job.overlays,
      time: job.at,
      pictureOf: (clip, local) =>
        clip.kind === 'audio'
          ? null
          : pictureFrom(
              clip.path,
              clip.kind === 'image' ? 'image' : 'video',
              clipSourceTime(clip, local),
            ),
      overlayPictureOf: (overlay, local) =>
        overlay.src
          ? pictureFrom(
              overlay.src,
              STILL.test(overlay.src) ? 'image' : 'video',
              (overlay.in ?? 0) + local,
            )
          : null,
    })
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }

  // A 4K composition is 8 MB as a PNG; cap the longest edge before it becomes a JPEG.
  const edge = job.maxEdge && job.maxEdge > 0 ? job.maxEdge : 0
  const longest = Math.max(width, height)
  let out = canvas
  if (edge && longest > edge) {
    const scale = edge / longest
    const scaled = document.createElement('canvas')
    scaled.width = Math.max(2, Math.round(width * scale))
    scaled.height = Math.max(2, Math.round(height * scale))
    const scaledCtx = scaled.getContext('2d', { alpha: false })
    if (!scaledCtx) return { ok: false, message: 'this window has no 2d canvas' }
    scaledCtx.drawImage(canvas, 0, 0, scaled.width, scaled.height)
    out = scaled
  }

  return {
    ok: true,
    dataUrl: out.toDataURL('image/jpeg', 0.9),
    width: out.width,
    height: out.height,
    ...(warnings.length ? { warnings } : {}),
  }
}
