/**
 * `recording_tool`'s decoder, answered by a process instead of by a window.
 *
 * The desktop decodes in a hidden window of its own; a hub has no window, but it does have the
 * render host (`craft-headless-export`) — the same headless Chromium that prints documents and
 * draws diagrams. This is the seam between them: one spawn per command, the frames as files on
 * disk, and the same reply shape the pane's `sampleVideo` answers.
 *
 * Bytes travel as files rather than as base64 on stdout: a hundred frames is tens of megabytes,
 * and a pipe is the wrong place for them.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { BrowserPaneFns } from '../agent/browser-pane.ts'
import { frameFileName } from './sampler-script.ts'

/** The capabilities `recording_tool` needs — a host can answer them without owning a whole pane. */
export type RecordingFns = Pick<BrowserPaneFns, 'sampleVideo' | 'extractAudio'>

export interface RecordingCliFnsOptions {
  /** The launcher. On a hub: `resources/render-host/craft-headless-export`. */
  command: string
  /** Arguments before the verb, so a test can run a script on node instead. */
  prefixArgs?: string[]
  timeoutMs?: number
}

/** The envelope `craft-headless-export` prints for a recording. */
interface RecordingEnvelope {
  status?: string
  error?: string
  message?: string
  duration_ms?: number
  width?: number
  height?: number
  truncated?: boolean
  frames?: Array<{ offset_ms: number; path: string }>
  /** `--audio-extract`: where the WAV landed, and what is in it. */
  path?: string
  sample_rate?: number
  bytes?: number
}

export function createRecordingCliFns(options: RecordingCliFnsOptions): RecordingFns {
  const timeoutMs = options.timeoutMs ?? 120_000

  return {
    async sampleVideo({
      path,
      out,
      mode,
      everyMs,
      maxFrames,
      changeThreshold,
      fromMs,
      toMs,
      first,
      last,
      maxEdge,
      probeOnly,
    }) {
      if (!existsSync(path)) throw new Error(`No recording at ${path}.`)

      // A probe answers from the header and writes nothing; every other read needs somewhere for
      // the frames to land. Without an `out` that is a scratch directory this call owns, and the
      // caller never sees the files.
      if (probeOnly) {
        const envelope = await run(options, ['--probe-video', path], timeoutMs)
        return resultOf(envelope, null, false)
      }

      const scratch = out ? null : await mkdtemp(join(tmpdir(), 'craft-video-'))
      const dir = out ?? scratch!
      await mkdir(dir, { recursive: true })
      try {
        const envelope = await run(
          options,
          [
            '--video-frames',
            path,
            '--out',
            dir,
            ...(mode ? ['--mode', mode] : []),
            ...(everyMs !== undefined ? ['--every', String(Math.max(1, Math.round(everyMs)))] : []),
            ...(maxFrames !== undefined ? ['--max', String(Math.max(1, Math.round(maxFrames)))] : []),
            ...(changeThreshold !== undefined ? ['--threshold', String(changeThreshold)] : []),
            ...(fromMs !== undefined ? ['--from', String(Math.max(0, Math.round(fromMs)))] : []),
            ...(toMs !== undefined ? ['--to', String(Math.max(0, Math.round(toMs)))] : []),
            ...(first ? ['--first'] : []),
            ...(last ? ['--last'] : []),
            ...(maxEdge !== undefined ? ['--max-edge', String(maxEdge)] : []),
          ],
          timeoutMs,
        )
        return await resultOf(envelope, dir, out !== undefined)
      } finally {
        if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
      }
    },

    async extractAudio({ path, out }) {
      if (!existsSync(path)) throw new Error(`No recording at ${path}.`)
      await mkdir(dirname(out), { recursive: true })
      const envelope = await run(options, ['--audio-extract', path, '--out', out], timeoutMs)
      return {
        path: envelope.path ?? out,
        durationMs: envelope.duration_ms ?? 0,
        sampleRate: envelope.sample_rate ?? 16_000,
        byteLength: envelope.bytes ?? 0,
      }
    },
  }
}

/**
 * Read what the launcher listed, and answer the pane's shape.
 *
 * `keepFiles` is the whole difference: with the caller's own `out`, the file stays and its path is
 * reported; with a scratch directory the bytes are the reply and the path is `null`, so a caller
 * cannot later read a file this call has deleted.
 */
async function resultOf(
  envelope: RecordingEnvelope,
  dir: string | null,
  keepFiles: boolean,
): Promise<Awaited<ReturnType<BrowserPaneFns['sampleVideo']>>> {
  const frames: Awaited<ReturnType<BrowserPaneFns['sampleVideo']>>['frames'] = []
  for (const [index, frame] of (envelope.frames ?? []).entries()) {
    // The launcher names them; a frame it did not write is named the same way the desktop names
    // it, so a caller has one naming to learn either way.
    const framePath = frame.path || (dir ? join(dir, frameFileName(index + 1)) : '')
    if (!framePath) continue
    const bytes = new Uint8Array(await readFile(framePath))
    frames.push({
      offsetMs: frame.offset_ms,
      bytes,
      path: keepFiles ? framePath : null,
    })
  }

  return {
    durationMs: envelope.duration_ms ?? 0,
    viewport:
      envelope.width && envelope.height
        ? { width: envelope.width, height: envelope.height }
        : null,
    truncated: envelope.truncated === true,
    frames,
  }
}

function run(options: RecordingCliFnsOptions, args: string[], timeoutMs: number): Promise<RecordingEnvelope> {
  return new Promise<RecordingEnvelope>((resolve, reject) => {
    const child = spawn(options.command, [...(options.prefixArgs ?? []), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`Reading this recording took longer than ${Math.round(timeoutMs / 1000)}s.`))
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(new Error(`The recording decoder could not be started: ${error.message}`))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const envelope = parseEnvelope(stdout)
      if (envelope?.status === 'ok') return resolve(envelope)
      reject(
        new Error(
          envelope?.message ??
            envelope?.error ??
            (stderr.trim()
              ? stderr.trim().split('\n').slice(-2).join(' ')
              : `the recording decoder exited with code ${code}`),
        ),
      )
    })
  })
}

function parseEnvelope(text: string): RecordingEnvelope | null {
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!
    if (!line.startsWith('{')) continue
    try {
      return JSON.parse(line) as RecordingEnvelope
    } catch {
      // A line that only looks like JSON is not the answer.
    }
  }
  return null
}
