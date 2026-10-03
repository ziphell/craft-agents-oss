/**
 * `record-start` / `record-stop`.
 *
 * The door is thin, but three things about it are not: the tab has to be named (once, on both
 * ends — a stop that guessed would land on another recording), the length has to be stated, and
 * the two forms have to say different things back. Those are what this pins.
 */

import { describe, it, expect } from 'bun:test'
import { executeBrowserToolCommand } from '../browser-commands'
import type { BrowserPaneFns } from '../browser-pane'

function stubFns(overrides: Partial<BrowserPaneFns> = {}): BrowserPaneFns {
  return {
    // `--tab` is lifted off the command line and used to target the conversation, so the door
    // calls this before the body runs.
    targetTab: async () => {},
    ...overrides,
  } as unknown as BrowserPaneFns
}

const run = (command: string | string[], fns: BrowserPaneFns) =>
  executeBrowserToolCommand({
    command,
    fns,
    sessionId: 'test-session',
    // Recording lands under the conversation's own folder, so the door needs to know where the
    // workspace is — the same thing every path-taking command needs.
    workspaceRootPath: '/tmp/ws',
  })

const RECORDING = { tabId: 'tab-3', file: '/tmp/records/20261001-120000.mp4', startedAt: 1, bytes: 0 }
const FINISHED = { tabId: 'tab-3', file: RECORDING.file, bytes: 93_894, seconds: 3, reason: 'deadline' }

describe('record-start', () => {
  it('records the tab it was told to, for the time it was told', async () => {
    const seen: Array<{ tabId: string; ttlMs: number; wait?: boolean }> = []
    const fns = stubFns({
      startRecording: async (args) => {
        seen.push(args)
        return { started: true, recording: RECORDING, extension: 'mp4' }
      },
    })

    const result = await run('record-start --tab tab-3 --ttl 30s', fns)

    expect(seen[0]).toMatchObject({ tabId: 'tab-3', ttlMs: 30_000 })
    expect(result.output).toContain('Recording tab tab-3 into /tmp/records/20261001-120000.mp4')
    expect(result.output).toContain('30s')
    expect(result.output).toContain('record-stop --tab tab-3')
    // And it says how to read what comes out, which is the whole point of recording.
    expect(result.output).toContain('video_tool understand')
  })

  it('clamps the length at the ceiling, however it was asked for', async () => {
    const seen: number[] = []
    const fns = stubFns({
      startRecording: async (args) => {
        seen.push(args.ttlMs)
        return { started: true, recording: RECORDING, extension: 'mp4' }
      },
    })

    await run('record-start --tab tab-3 --ttl 999999s', fns)

    // Ten minutes — the ceiling `durationOption` has always applied. A recording cannot outlast
    // it, which is what makes "no recording lasts forever" a fact rather than a hope.
    expect(seen[0]).toBe(600_000)
  })

  it('answers with a still-running recording when the same tab is asked for twice', async () => {
    const fns = stubFns({
      startRecording: async () => ({ started: false, reason: 'already-recording', recording: RECORDING }),
    })

    const result = await run('record-start --tab tab-3 --ttl 30s', fns)

    expect(result.output).toContain('already being recorded')
    expect(result.output).toContain(RECORDING.file)
  })

  it('with --wait, the answer IS the finished recording', async () => {
    let waited: boolean | undefined
    const fns = stubFns({
      startRecording: async (args) => {
        waited = args.wait
        return { started: true, recording: RECORDING, extension: 'mp4', finished: FINISHED }
      },
    })

    const result = await run('record-start --tab tab-3 --ttl 30s --wait', fns)

    expect(waited).toBe(true)
    expect(result.output).toContain('Recorded tab tab-3 for 3s')
    expect(result.output).toContain('It ended because: deadline')
    expect(result.output).not.toContain('do not have to wait')
  })

  it('names the tab, always — a stop has to be able to match it', async () => {
    const fns = stubFns({ startRecording: async () => ({ started: true, recording: RECORDING, extension: 'mp4' }) })

    await expect(run('record-start --ttl 30s', fns)).rejects.toThrow('record-start needs the tab to record')
  })

  it('requires a length, and reads one that is not a duration', async () => {
    const fns = stubFns({ startRecording: async () => ({ started: true, recording: RECORDING, extension: 'mp4' }) })

    await expect(run('record-start --tab tab-3', fns)).rejects.toThrow('--ttl is required')
    await expect(run('record-start --tab tab-3 --ttl soon', fns)).rejects.toThrow('--ttl needs a duration')
  })

  it('passes on why it could not start, and says nothing was recorded', async () => {
    const fns = stubFns({
      startRecording: async () => ({ started: false, reason: 'no-encoder', message: 'This build cannot record.' }),
    })

    await expect(run('record-start --tab tab-3 --ttl 30s', fns))
      .rejects.toThrow('Nothing was recorded')
  })

  it('says so when the runtime has no recording at all', async () => {
    await expect(run('record-start --tab tab-3 --ttl 30s', stubFns()))
      .rejects.toThrow('Recording is not available in this runtime')
  })
})

describe('record-stop', () => {
  it('ends the named tab early and reports what it left', async () => {
    const stopped: string[] = []
    const fns = stubFns({
      stopRecording: async ({ tabId }) => {
        stopped.push(tabId)
        return { stopped: true, recording: FINISHED }
      },
    })

    const result = await run('record-stop --tab tab-3', fns)

    expect(stopped).toEqual(['tab-3'])
    expect(result.output).toContain('Stopped recording tab tab-3 — 3s')
    expect(result.output).toContain(FINISHED.file)
  })

  it('names the tab, always', async () => {
    await expect(run('record-stop', stubFns())).rejects.toThrow('record-stop needs the tab')
  })

  it('says a tab that is not being recorded is not being recorded', async () => {
    const fns = stubFns({ stopRecording: async () => ({ stopped: false, reason: 'not-recording' }) })

    const result = await run('record-stop --tab tab-9', fns)

    expect(result.output).toContain('Tab tab-9 is not being recorded')
  })
})
