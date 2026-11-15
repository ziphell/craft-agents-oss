/**
 * A source's level envelope, for `reel_tool beats`.
 *
 * The same hidden-window route `snapshot` takes, for the same reason: decoding needs a browser,
 * and the tool layer does not have one. The window is created per call and destroyed in `finally`
 * — an analysis is a single question, and a warm window would be state to go stale.
 *
 * Nothing here decides anything about music; the page decodes, shared `beats.ts` interprets.
 */

import { BrowserWindow } from 'electron'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ReelAudioReader, ReelAudioResult } from '@craft-agent/shared/reel/audio'

/** Long enough for a ten-minute track to decode, short enough that a hang is not forever. */
const AUDIO_TIMEOUT_MS = 30_000

interface AudioAnswer {
  ok: boolean
  duration?: number
  bucketSeconds?: number
  rms?: number[]
  message?: string
}

export const readReelAudio: ReelAudioReader = async (path, options): Promise<ReelAudioResult> => {
  const pageScript = join(__dirname, 'edit-audio-page.js')
  if (!existsSync(pageScript)) {
    return { ok: false, message: 'the audio page is missing from this build' }
  }

  const dir = mkdtempSync(join(tmpdir(), 'craft-edit-audio-'))
  const pagePath = join(dir, 'audio.html')
  writeFileSync(
    pagePath,
    `<!doctype html><html><head><meta charset="utf-8"></head>` +
      `<body><script src="${pathToFileURL(pageScript)}"></script></body></html>`,
    'utf8',
  )

  const window = new BrowserWindow({
    show: false,
    width: 16,
    height: 16,
    webPreferences: {
      // Shared with the exporter: the page reads sources through `editExport.readFile`.
      preload: join(__dirname, 'edit-export-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  })

  try {
    await window.loadFile(pagePath)
    const job = {
      path,
      ...(options?.bucketSeconds !== undefined ? { bucketSeconds: options.bucketSeconds } : {}),
    }
    const answer = await Promise.race([
      window.webContents.executeJavaScript(
        `window.__audioLevels(${JSON.stringify(job)})`,
        true,
      ) as Promise<AudioAnswer>,
      new Promise<AudioAnswer>((resolve) => {
        setTimeout(
          () =>
            resolve({
              ok: false,
              message: `decoding took longer than ${AUDIO_TIMEOUT_MS / 1000}s`,
            }),
          AUDIO_TIMEOUT_MS,
        )
      }),
    ])

    if (!answer.ok || !answer.rms || !answer.bucketSeconds || !answer.duration) {
      return { ok: false, message: answer.message ?? 'the page decoded no sound' }
    }
    return {
      ok: true,
      levels: {
        duration: answer.duration,
        bucketSeconds: answer.bucketSeconds,
        rms: Float32Array.from(answer.rms),
      },
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  } finally {
    if (!window.isDestroyed()) window.destroy()
    rmSync(dir, { recursive: true, force: true })
  }
}
