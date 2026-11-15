/**
 * A cut, rendered to a file.
 *
 * Same answer the app gives for drawio, GenOffice and session recordings: **a hidden window,
 * because that is where the encoder is.** There is no encoder in the main process and the app does
 * not ship ffmpeg.
 *
 * What is different from a recording: this is an **encode**, not a capture. The page
 * (`edit-export-page.ts`, bundled separately because it imports MediaBunny) decodes each source
 * frame by frame and hands it to `VideoEncoder` at the composition's own timestamp. Nothing here
 * follows the wall clock, so a thirty-second cut does not take thirty seconds, and the file's
 * length is `Σ clip.duration` rather than "however long the machine took".
 *
 * The page also *muxes*: it writes into a file through a `StreamTarget`, so chunks arrive with an
 * absolute **offset** and the caller has to seek — appending them blindly would work only for
 * formats that never rewrite a header, and MP4 does.
 *
 * This module writes nothing itself; the IPC door below does, because the output path is the
 * renderer's to choose.
 */

import { BrowserWindow, ipcMain } from 'electron'
import { existsSync, mkdtempSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ReelExportInput, ReelExportResult } from '@craft-agent/shared/reel/export-host'
import type { EditOverlay } from '@craft-agent/shared/reel/overlay'
import {
  exportPlanOf,
  type EditExportClip,
  type ReelExportPlan,
} from '@craft-agent/shared/reel/export-job'

export type { EditExportClip }

export interface EditExportJob extends ReelExportPlan {
  /** The file's shape: MP4/WebM with picture, or a bare MP3 stream with sound only. */
  container: 'mp4' | 'webm' | 'mp3'
  /** Write the mixed sound only — no picture track, no frames (`.m4a` / `.mp3` / `.webm` audio). */
  audioOnly?: boolean
  /** Called for every written chunk, with its offset in the output file. */
  onChunk: (bytes: Uint8Array, position: number) => void
  /** 0..1, from the page's own progress. */
  onProgress?: (ratio: number) => void
  /** Aborting tears the hidden window down; the caller deletes the partial file. */
  signal?: AbortSignal
}

const CHUNK_CHANNEL = 'edit-export:chunk'
const PROGRESS_CHANNEL = 'edit-export:progress'
const DONE_CHANNEL = 'edit-export:done'

/**
 * One export at a time.
 *
 * Two encodes competing for the same GPU is slower than one after the other, and a queue is also
 * what makes "the second export" a file rather than a race for the same window.
 */
let queue: Promise<unknown> = Promise.resolve()

export function exportCut(job: EditExportJob): Promise<{
  ok: boolean
  cancelled?: boolean
  message?: string
}> {
  const task = queue.then(() => run(job), () => run(job))
  queue = task.then(
    () => undefined,
    () => undefined,
  )
  return task
}

/** Everything a job needs but the two doors (bytes and progress) — the same shape either way. */
interface EditExportRequest extends ReelExportPlan {
  container: 'mp4' | 'webm' | 'mp3'
  audioOnly?: boolean
}

/**
 * One cut into one file.
 *
 * The file is created before the encode starts, so a failed render leaves an obvious empty file
 * rather than nothing, and the directory is made on the way because `reels/exports/` may be new.
 * Chunks are written at their offsets: a muxer seeks, it does not only append.
 */
async function writeCutToFile(
  request: EditExportRequest,
  outPath: string,
  onProgress?: (ratio: number) => void,
  signal?: AbortSignal,
): Promise<{ ok: boolean; path?: string; cancelled?: boolean; message?: string }> {
  const { open, mkdir } = await import('node:fs/promises')
  await mkdir(dirname(outPath), { recursive: true })
  const handle = await open(outPath, 'w')
  try {
    const result = await exportCut({
      clips: request.clips,
      overlays: request.overlays ?? [],
      width: request.width,
      height: request.height,
      fps: request.fps,
      container: request.container,
      audioOnly: request.audioOnly === true,
      onChunk: (bytes, position) => {
        writeSync(handle.fd, bytes, 0, bytes.byteLength, position)
      },
      ...(onProgress ? { onProgress } : {}),
      ...(signal ? { signal } : {}),
    })
    return result.ok ? { ok: true, path: outPath } : result
  } finally {
    await handle.close()
  }
}

/**
 * The tool door: a whole cut at a path, with no renderer in the conversation.
 *
 * `reel_tool export` hands over the document; this flattens it with the same `exportPlanOf` the
 * panel uses, so the file the agent renders is the file the person would have got.
 */
export async function exportCutToFile(input: ReelExportInput): Promise<ReelExportResult> {
  const plan = exportPlanOf(input.document, input.pathOf)
  if (plan.clips.length === 0 && plan.overlays.length === 0) {
    return { ok: false, message: 'this cut is empty — there is nothing to render' }
  }

  const result = await writeCutToFile(
    { ...plan, container: input.container, ...(input.audioOnly ? { audioOnly: true } : {}) },
    input.outPath,
    input.onProgress,
    input.signal,
  )
  if (!result.ok) return result

  const duration = Math.max(
    plan.clips.reduce((end, clip) => Math.max(end, clip.start + clip.duration), 0),
    plan.overlays.reduce((end, overlay) => Math.max(end, overlay.start + overlay.duration), 0),
  )
  return { ok: true, path: input.outPath, duration }
}

async function run(job: EditExportJob): Promise<{
  ok: boolean
  cancelled?: boolean
  message?: string
}> {
  if (!job.clips.length && !job.overlays.length) return { ok: false, message: 'this cut has no clips' }
  const pageScript = join(__dirname, 'edit-export-page.js')
  if (!existsSync(pageScript)) return { ok: false, message: 'the export page is missing from this build' }
  // Cancelled while it was still queued behind another render: no window is worth opening.
  if (job.signal?.aborted) return { ok: false, cancelled: true, message: 'cancelled' }

  const dir = mkdtempSync(join(tmpdir(), 'craft-edit-export-'))
  const pagePath = join(dir, 'export.html')
  // A `file://` document, so its `<script>` and the media it plays share one origin; a data: URL
  // page is opaque and cannot read either.
  writeFileSync(
    pagePath,
    `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#000}</style></head>` +
      `<body><script src="${pathToFileURL(pageScript)}"></script></body></html>`,
    'utf8',
  )

  const window = new BrowserWindow({
    show: false,
    width: 16,
    height: 16,
    webPreferences: {
      preload: join(__dirname, 'edit-export-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // Not a window anyone sees: it has to keep working while nothing is looking at it.
      backgroundThrottling: false,
    },
  })

  let failure: string | null = null
  let writeFailure: string | null = null
  let chunks = 0
  /** Resolved by the page's `finish` message: the last write is on disk when this resolves. */
  let resolveDone: () => void = () => undefined
  const doneSignal = new Promise<void>((resolve) => {
    resolveDone = resolve
  })

  // Cancelling tears the window down, which stops both the decoder and the encoder at once. The
  // muxer's file handle is closed by the caller, and it deletes the partial file.
  let cancelled = false
  const onAbort = () => {
    cancelled = true
    if (!window.isDestroyed()) window.destroy()
    resolveDone()
  }
  job.signal?.addEventListener('abort', onAbort, { once: true })

  const onChunk = (event: Electron.IpcMainEvent, chunk: { data: Uint8Array; position: number }) => {
    if (event.sender !== window.webContents) return
    chunks += 1
    try {
      // Synchronous, at the offset the muxer asked for: a chunk must be on disk before the next
      // message (progress, the corrected `moov`, done) is handled.
      job.onChunk(chunk.data, chunk.position)
    } catch (error) {
      writeFailure = error instanceof Error ? error.message : String(error)
    }
  }
  const onProgress = (event: Electron.IpcMainEvent, ratio: number) => {
    if (event.sender !== window.webContents) return
    job.onProgress?.(Math.max(0, Math.min(1, Number(ratio) || 0)))
  }
  const onDone = (event: Electron.IpcMainEvent, message?: string | null) => {
    if (event.sender !== window.webContents) return
    failure = message ?? null
    resolveDone()
  }

  ipcMain.on(CHUNK_CHANNEL, onChunk)
  ipcMain.on(PROGRESS_CHANNEL, onProgress)
  ipcMain.on(DONE_CHANNEL, onDone)

  try {
    if (job.signal?.aborted) return { ok: false, cancelled: true, message: 'cancelled' }
    await window.loadFile(pagePath)
    const payload = {
      clips: job.clips.map((clip) => ({
        path: clip.path,
        in: Math.max(0, clip.in),
        duration: Math.max(0.05, clip.duration),
        start: Math.max(0, clip.start),
        kind: clip.kind,
        track: clip.track,
        volume: clip.volume,
        muted: clip.muted,
        fadeIn: clip.fadeIn,
        fadeOut: clip.fadeOut,
        automation: clip.automation,
        transform: clip.transform,
        opacity: clip.opacity,
        keyframes: clip.keyframes,
        crop: clip.crop,
        freeze: clip.freeze,
        effect: clip.effect,
        audioEffect: clip.audioEffect,
        speed: clip.speed,
        transition: clip.transition,
        hidden: clip.hidden,
        masks: clip.masks,
      })),
      width: job.width,
      height: job.height,
      fps: job.fps,
      container: job.container,
      audioOnly: job.audioOnly === true,
      overlays: job.overlays,
    }
    await window.webContents.executeJavaScript(`window.__render(${JSON.stringify(payload)})`, true)
    // Chunks (including the corrected `moov`) arrive over IPC; wait for the page's own `done` so
    // the file is complete before the handle is closed. A dead page still ends the wait.
    await Promise.race([doneSignal, new Promise<void>((resolve) => setTimeout(resolve, 5000))])
    if (cancelled || job.signal?.aborted) return { ok: false, cancelled: true, message: 'cancelled' }
    if (writeFailure) return { ok: false, message: writeFailure }
    if (failure) return { ok: false, message: failure }
    if (chunks === 0) return { ok: false, message: 'the encoder produced no output' }
    return { ok: true }
  } catch (error) {
    // A destroyed window rejects the pending `executeJavaScript`; that is the cancel, not a fault.
    if (cancelled || job.signal?.aborted) return { ok: false, cancelled: true, message: 'cancelled' }
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  } finally {
    job.signal?.removeEventListener('abort', onAbort)
    ipcMain.removeListener(CHUNK_CHANNEL, onChunk)
    ipcMain.removeListener(PROGRESS_CHANNEL, onProgress)
    ipcMain.removeListener(DONE_CHANNEL, onDone)
    rmSync(dir, { recursive: true, force: true })
    if (!window.isDestroyed()) window.destroy()
  }
}

/**
 * The renderer's door.
 *
 * Chunks are written at their offsets (the muxer seeks), and progress is pushed to the window that
 * asked. The file is created before the job starts so a failed encode leaves an obvious empty file
 * rather than nothing at all.
 */
export function registerEditExportIpc(): void {
  // The export page is a `file://` document; a `fetch(file://…)` is blocked there. The bytes come
  // through this door instead, so decoding a source never depends on a permissive origin.
  ipcMain.handle('edit-export:read', async (_event: Electron.IpcMainInvokeEvent, path: string) => {
    const { readFile } = await import('node:fs/promises')
    return new Uint8Array(await readFile(path))
  })

  ipcMain.handle(
    'edit-export:run',
    async (
      event: Electron.IpcMainInvokeEvent,
      request: {
        clips: EditExportClip[]
        overlays: EditOverlay[]
        width: number
        height: number
        fps: number
        outPath: string
        container?: 'mp4' | 'webm' | 'mp3'
        audioOnly?: boolean
      },
    ): Promise<{ ok: boolean; path?: string; message?: string }> =>
      writeCutToFile(
        {
          clips: request.clips,
          overlays: request.overlays ?? [],
          width: request.width,
          height: request.height,
          fps: request.fps,
          container: request.container ?? 'mp4',
          audioOnly: request.audioOnly === true,
        },
        request.outPath,
        (ratio) => {
          if (!event.sender.isDestroyed()) event.sender.send('edit-export:progress', ratio)
        },
      ),
  )
}
