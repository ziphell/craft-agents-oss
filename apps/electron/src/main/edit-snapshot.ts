/**
 * One frame of a cut, as a JPEG on disk.
 *
 * Same route the exporter takes — a hidden `BrowserWindow`, because that is where a canvas and a
 * decoder are — but no encoder: the page (`edit-snapshot-page.ts`) paints the moment with the
 * shared compositor and answers a data URL, which is written here. Nothing here decides what a
 * frame looks like; that stays in `canvas-compositor`, so a snapshot and a paused preview agree.
 *
 * The window is created per call and destroyed in `finally`: a snapshot is rare (a model asking
 * to look), and a warm window would be a second copy of the preview's state that can go stale.
 */

import { BrowserWindow } from 'electron'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { renderClipsOf } from '@craft-agent/shared/reel/render-clips'
import type { ReelSnapshotInput, ReelSnapshotResult } from '@craft-agent/shared/reel/snapshot'
import type { SnapshotAnswer, SnapshotJob } from './edit-snapshot-page'

/** Decoding a 4K source frame is seconds, not milliseconds; a hang is what this bounds. */
const SNAPSHOT_TIMEOUT_MS = 20_000

export async function snapshotCut(input: ReelSnapshotInput): Promise<ReelSnapshotResult> {
  const pageScript = join(__dirname, 'edit-snapshot-page.js')
  if (!existsSync(pageScript)) {
    return { ok: false, message: 'the snapshot page is missing from this build' }
  }

  const doc = input.document
  const clips = renderClipsOf(doc)
  if (clips.length === 0 && doc.overlays.length === 0) {
    return { ok: false, message: 'this cut is empty — there is nothing to draw' }
  }

  const dir = mkdtempSync(join(tmpdir(), 'craft-edit-snapshot-'))
  const pagePath = join(dir, 'snapshot.html')
  // A `file://` document, so its `<script>` runs in a page that can reach the app's own media
  // origin; the bundle is named absolutely because the temp folder is elsewhere.
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
      // The page reads sources through the same preload the exporter uses: a `file://` page cannot
      // fetch its neighbours, and a data URL cannot be seeked.
      preload: join(__dirname, 'edit-export-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })

  try {
    await window.loadFile(pagePath)
    const payload: SnapshotJob = {
      // Sources become absolute here: the page has no project folder and no roots.
      clips: clips.map((clip) => ({ ...clip, path: input.pathOf(clip.path) })),
      overlays: doc.overlays.map((overlay) =>
        overlay.src ? { ...overlay, src: input.pathOf(overlay.src) } : overlay,
      ),
      width: doc.settings.width,
      height: doc.settings.height,
      at: Math.max(0, input.at),
      ...(input.maxEdge ? { maxEdge: input.maxEdge } : {}),
    }

    const answer = await Promise.race([
      window.webContents.executeJavaScript(
        `window.__snapshot(${JSON.stringify(payload)})`,
        true,
      ) as Promise<SnapshotAnswer>,
      new Promise<SnapshotAnswer>((resolve) => {
        setTimeout(
          () => resolve({ ok: false, message: `drawing took longer than ${SNAPSHOT_TIMEOUT_MS / 1000}s` }),
          SNAPSHOT_TIMEOUT_MS,
        )
      }),
    ])

    if (!answer.ok || !answer.dataUrl) {
      return { ok: false, message: answer.message ?? 'the page drew no picture' }
    }
    const comma = answer.dataUrl.indexOf(',')
    if (!answer.dataUrl.startsWith('data:image/') || comma < 0) {
      return { ok: false, message: 'the page answered something that is not a picture' }
    }

    mkdirSync(dirname(input.outPath), { recursive: true })
    writeFileSync(input.outPath, Buffer.from(answer.dataUrl.slice(comma + 1), 'base64'))
    return {
      ok: true,
      path: input.outPath,
      width: answer.width,
      height: answer.height,
      ...(answer.warnings?.length ? { warnings: answer.warnings } : {}),
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  } finally {
    if (!window.isDestroyed()) window.destroy()
    rmSync(dir, { recursive: true, force: true })
  }
}
