/**
 * The recorder, on its own.
 *
 * No window and no renderer: what is worth pinning here is the file it produces — the
 * name it chooses, what `stop` leaves on disk, and the two ways a recording ends without
 * anybody pressing stop (the tab closing, the window going away). The picture itself
 * comes from Electron, and the button's behaviour is the toolbar's tests.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { TabRecorder } from '../tab-recorder'

/** The parts of a tab the recorder reads: an id, and whether it is still there. */
function fakeTab(id: number, destroyed = false): any {
  return {
    id,
    isDestroyed: () => destroyed,
    mainFrame: { detached: false, tabId: id },
  }
}

describe('TabRecorder', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'craft-recorder-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes what it is given, and reports where it went', () => {
    const recorder = new TabRecorder()
    const state = recorder.start({ dir, source: fakeTab(1) })

    expect(state.file.startsWith(join(dir, ''))).toBe(true)
    expect(state.file.endsWith('.webm')).toBe(true)

    recorder.append(new Uint8Array([1, 2, 3]))
    recorder.append(new Uint8Array([4, 5]))

    const finished = recorder.stop()
    expect(finished?.bytes).toBe(5)
    expect(finished?.file).toBe(state.file)
    expect(Array.from(readFileSync(state.file))).toEqual([1, 2, 3, 4, 5])
    // One file, not one per chunk: a recording is one file.
    expect(readdirSync(dir)).toEqual([state.file.split(/[/\\]/).pop()!])
  })

  it('null when there is nothing to stop, and only while recording is there a source', () => {
    const recorder = new TabRecorder()
    expect(recorder.stop()).toBeNull()
    expect(recorder.state()).toBeNull()
    // Nothing armed: a display-media request gets nothing back.
    expect(recorder.armedSource()).toBeNull()

    recorder.start({ dir, source: fakeTab(7) })
    expect(recorder.state()).not.toBeNull()
    expect(recorder.armedSource()).not.toBeNull()

    recorder.stop()
    expect(recorder.state()).toBeNull()
    expect(recorder.armedSource()).toBeNull()
  })

  it('ends the recording when the tab it was recording goes away, keeping what it captured', () => {
    const recorder = new TabRecorder()
    const state = recorder.start({ dir, source: fakeTab(1) })
    recorder.append(new Uint8Array([9]))

    // A different tab closing is not this recording's business.
    expect(recorder.stopIfSource(2)).toBeNull()
    expect(recorder.state()).not.toBeNull()

    expect(recorder.stopIfSource(1)?.file).toBe(state.file)
    expect(recorder.state()).toBeNull()
    expect(Array.from(readFileSync(state.file))).toEqual([9])
  })

  it('takes the whole window with it: any of its tabs ends the recording', () => {
    const recorder = new TabRecorder()
    const state = recorder.start({ dir, source: fakeTab(5) })
    expect(recorder.stopIfSource(1, 2, 5)?.file).toBe(state.file)
    expect(recorder.state()).toBeNull()
  })

  it('two recordings in the same second are two files', () => {
    const recorder = new TabRecorder()
    const first = recorder.start({ dir, source: fakeTab(1) })
    recorder.stop()
    const second = recorder.start({ dir, source: fakeTab(1) })
    recorder.stop()

    expect(second.file).not.toBe(first.file)
    expect(second.file.endsWith('.webm')).toBe(true)
  })

  it('a second recording finishes the first rather than dropping it', () => {
    const recorder = new TabRecorder()
    const first = recorder.start({ dir, source: fakeTab(1) })
    recorder.append(new Uint8Array([1]))
    const second = recorder.start({ dir, source: fakeTab(2) })

    expect(second.file).not.toBe(first.file)
    expect(Array.from(readFileSync(first.file))).toEqual([1])
  })

  it('a destroyed tab is no source at all', () => {
    const recorder = new TabRecorder()
    recorder.start({ dir, source: fakeTab(3, true) })
    expect(recorder.armedSource()).toBeNull()
  })
})
