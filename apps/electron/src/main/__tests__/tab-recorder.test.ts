/**
 * The recorder, on its own.
 *
 * No window and no renderer: what is worth pinning here is the file it produces — the
 * name it chooses, what `stop` leaves on disk, and the two ways a recording ends without
 * anybody pressing stop (the tab closing, the window going away). The picture itself
 * comes from Electron, and the button's behaviour is the toolbar's tests.
 *
 * The second half is the registry: a recording is identified by `(owner, tab)`, so the
 * person and a conversation can each be recording the same tab, and a conversation can be
 * recording two tabs at once. Every one of those is checked here, because "which recording
 * did that stop?" is the question this class exists to answer.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { PERSON_OWNER, TabRecorder } from '../tab-recorder'
import { sidecarPathFor } from '../recording-sidecar'

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
    const state = recorder.start({ tabId: 'tab-1', dir, source: fakeTab(1) })

    expect(state.file.startsWith(join(dir, ''))).toBe(true)
    expect(state.file.endsWith('.mp4')).toBe(true)
    expect(state).toMatchObject({ tabId: 'tab-1', owner: PERSON_OWNER })

    recorder.append(new Uint8Array([1, 2, 3]))
    recorder.append(new Uint8Array([4, 5]))

    const finished = recorder.stop()
    expect(finished?.bytes).toBe(5)
    expect(finished?.file).toBe(state.file)
    expect(finished?.tabId).toBe('tab-1')
    expect(Array.from(readFileSync(state.file))).toEqual([1, 2, 3, 4, 5])
    // One film, not one per chunk — plus the sidecar beside it, which is a record of the page
    // rather than a second film (`recording-sidecar.ts`).
    const name = state.file.split(/[/\\]/).pop()!
    expect(readdirSync(dir).sort()).toEqual([name, name.replace(/\.mp4$/, '.events.jsonl')].sort())
  })

  it('null when there is nothing to stop, and only while recording is there a source', () => {
    const recorder = new TabRecorder()
    expect(recorder.stop()).toBeNull()
    expect(recorder.state()).toBeNull()
    expect(recorder.states()).toEqual([])
    // Nothing armed: a display-media request gets nothing back.
    expect(recorder.armedSource()).toBeNull()

    recorder.start({ tabId: 'tab-1', dir, source: fakeTab(7) })
    expect(recorder.state()).not.toBeNull()
    expect(recorder.armedSource()).not.toBeNull()

    recorder.stop()
    expect(recorder.state()).toBeNull()
    expect(recorder.armedSource()).toBeNull()
  })

  it('ends the recording when the tab it was recording goes away, keeping what it captured', () => {
    const recorder = new TabRecorder()
    const state = recorder.start({ tabId: 'tab-1', dir, source: fakeTab(1) })
    recorder.append(new Uint8Array([9]))

    // A different tab closing is not this recording's business.
    expect(recorder.stopIfSource(2)).toEqual([])
    expect(recorder.state()).not.toBeNull()

    expect(recorder.stopIfSource(1)[0]?.file).toBe(state.file)
    expect(recorder.state()).toBeNull()
    expect(Array.from(readFileSync(state.file))).toEqual([9])
  })

  it('takes the whole window with it: any of its tabs ends the recording', () => {
    const recorder = new TabRecorder()
    const state = recorder.start({ tabId: 'tab-1', dir, source: fakeTab(5) })
    expect(recorder.stopIfSource(1, 2, 5)[0]?.file).toBe(state.file)
    expect(recorder.state()).toBeNull()
  })

  it('two recordings in the same second are two files', () => {
    const recorder = new TabRecorder()
    const first = recorder.start({ tabId: 'tab-1', dir, source: fakeTab(1) })
    recorder.stop()
    const second = recorder.start({ tabId: 'tab-1', dir, source: fakeTab(1) })
    recorder.stop()

    expect(second.file).not.toBe(first.file)
    expect(second.file.endsWith('.mp4')).toBe(true)
  })

  it('a second recording by the person finishes the first rather than dropping it', () => {
    const recorder = new TabRecorder()
    const first = recorder.start({ tabId: 'tab-1', dir, source: fakeTab(1) })
    recorder.append(new Uint8Array([1]))
    // A different tab: the person still records one thing at a time.
    const second = recorder.start({ tabId: 'tab-2', dir, source: fakeTab(2) })

    expect(second.file).not.toBe(first.file)
    expect(recorder.states().length).toBe(1)
    expect(Array.from(readFileSync(first.file))).toEqual([1])
  })

  it('a destroyed tab is no source at all', () => {
    const recorder = new TabRecorder()
    recorder.start({ tabId: 'tab-1', dir, source: fakeTab(3, true) })
    expect(recorder.armedSource()).toBeNull()
  })
})

describe('TabRecorder — more than one recording at a time', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'craft-recorder-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('the person and a conversation can record the same tab, and neither is the other', () => {
    const recorder = new TabRecorder()
    const source = fakeTab(1)

    const person = recorder.start({ tabId: 'tab-1', dir, source })
    const session = recorder.startFor('s1', { tabId: 'tab-1', dir, source })

    expect(session.file).not.toBe(person.file)
    expect(recorder.states().length).toBe(2)
    // The person's is still the one the display-media door answers with.
    expect(recorder.armedSource()).not.toBeNull()
    expect(recorder.state()?.file).toBe(person.file)
    expect(recorder.stateFor('s1', 'tab-1')?.file).toBe(session.file)

    // A chunk goes to the owner it was appended for, and only there.
    recorder.appendFor('s1', 'tab-1', new Uint8Array([7]))
    expect(Array.from(readFileSync(session.file))).toEqual([7])
    expect(readFileSync(person.file).length).toBe(0)
  })

  it('a conversation recording two tabs keeps both, and starting the second does not end the first', () => {
    const recorder = new TabRecorder()
    const first = recorder.startFor('s1', { tabId: 'tab-1', dir, source: fakeTab(1) })
    recorder.appendFor('s1', 'tab-1', new Uint8Array([1]))
    const second = recorder.startFor('s1', { tabId: 'tab-2', dir, source: fakeTab(2) })

    expect(second.file).not.toBe(first.file)
    expect(recorder.states().length).toBe(2)
    expect(recorder.stateFor('s1', 'tab-1')?.file).toBe(first.file)
    expect(Array.from(readFileSync(first.file))).toEqual([1])

    // Stopping one leaves the other alone — this is what the whole registry is for.
    recorder.stopFor('s1', 'tab-1')
    expect(recorder.stateFor('s1', 'tab-1')).toBeNull()
    expect(recorder.stateFor('s1', 'tab-2')?.file).toBe(second.file)
  })

  it('the same conversation and tab again finishes that one recording rather than stacking', () => {
    const recorder = new TabRecorder()
    const first = recorder.startFor('s1', { tabId: 'tab-1', dir, source: fakeTab(1) })
    recorder.appendFor('s1', 'tab-1', new Uint8Array([1, 2]))
    const second = recorder.startFor('s1', { tabId: 'tab-1', dir, source: fakeTab(1) })

    expect(second.file).not.toBe(first.file)
    expect(recorder.states().length).toBe(1)
    // The bytes already written are kept, not dropped.
    expect(Array.from(readFileSync(first.file))).toEqual([1, 2])
  })

  it('two conversations on one tab are two recordings', () => {
    const recorder = new TabRecorder()
    const source = fakeTab(1)
    const a = recorder.startFor('s1', { tabId: 'tab-1', dir, source })
    const b = recorder.startFor('s2', { tabId: 'tab-1', dir, source })

    expect(a.file).not.toBe(b.file)
    expect(recorder.states().length).toBe(2)
    recorder.stopFor('s1', 'tab-1')
    expect(recorder.stateFor('s2', 'tab-1')?.file).toBe(b.file)
  })

  it('the tab going away ends every recording of it, whoever owns them', () => {
    const recorder = new TabRecorder()
    const source = fakeTab(1)
    const person = recorder.start({ tabId: 'tab-1', dir, source })
    const session = recorder.startFor('s1', { tabId: 'tab-1', dir, source })
    const other = recorder.startFor('s1', { tabId: 'tab-2', dir, source: fakeTab(2) })

    const finished = recorder.stopIfSource(1)

    expect(finished.map((recording) => recording.file).sort()).toEqual([person.file, session.file].sort())
    expect(recorder.states().map((state) => state.file)).toEqual([other.file])
  })

  it('stateFor and stopFor say nothing about a recording that was never started', () => {
    const recorder = new TabRecorder()
    expect(recorder.stateFor('s1', 'tab-1')).toBeNull()
    expect(recorder.stopFor('s1', 'tab-1')).toBeNull()
  })
})

describe('TabRecorder — the sidecar beside the film', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'craft-recorder-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** A sidecar as a reader sees it: one JSON object per line. */
  function linesOf(file: string): any[] {
    return readFileSync(file, 'utf-8').trim().split('\n').map((line) => JSON.parse(line))
  }

  it('opens with the clock, and closes when the recording ends', () => {
    const recorder = new TabRecorder()
    const state = recorder.start({ tabId: 'tab-1', dir, source: fakeTab(1) })
    const sidecar = sidecarPathFor(state.file)

    // The first line is what turns every later `ms` into a moment: the recording's start.
    expect(linesOf(sidecar)[0]).toMatchObject({ type: 'start', tabId: 'tab-1' })
    expect(typeof linesOf(sidecar)[0].startedAt).toBe('number')

    recorder.stop()

    const [start, stop] = linesOf(sidecar)
    expect(start.type).toBe('start')
    expect(stop.type).toBe('stop')
    // Both ends carry an offset, so a cut-off log is telling apart from a whole one.
    expect(typeof stop.ms).toBe('number')
    expect(typeof stop.seconds).toBe('number')
  })

  it('logs what the page did, on the recording\'s own clock', () => {
    const recorder = new TabRecorder()
    const state = recorder.start({ tabId: 'tab-1', dir, source: fakeTab(1) })

    recorder.noteEvent('tab-1', { type: 'navigate', url: 'https://example.com/admin' })
    recorder.noteEvent('tab-1', {
      type: 'request',
      method: 'POST',
      url: 'https://example.com/api/export',
      status: 200,
      resourceType: 'xhr',
    })
    recorder.stop()

    const [, navigate, request] = linesOf(sidecarPathFor(state.file))
    expect(navigate).toMatchObject({ type: 'navigate', url: 'https://example.com/admin' })
    expect(request).toMatchObject({ type: 'request', status: 200, resourceType: 'xhr' })
    // Offsets, not wall-clock: the film and the log share one clock, so a reader never lines
    // two timelines up.
    for (const line of [navigate, request]) expect(line.ms).toBeGreaterThanOrEqual(0)
  })

  it('gives an event to every recording of that tab, and to no other tab', () => {
    const recorder = new TabRecorder()
    const person = recorder.start({ tabId: 'tab-1', dir, source: fakeTab(1) })
    const session = recorder.startFor('s1', { tabId: 'tab-1', dir, source: fakeTab(1) })
    const other = recorder.startFor('s1', { tabId: 'tab-2', dir, source: fakeTab(2) })

    recorder.noteEvent('tab-1', { type: 'navigate', url: 'https://example.com/' })

    // The page did one thing and two recordings observed it; the other tab saw nothing.
    expect(linesOf(sidecarPathFor(person.file)).length).toBe(2)
    expect(linesOf(sidecarPathFor(session.file)).length).toBe(2)
    expect(linesOf(sidecarPathFor(other.file)).length).toBe(1)
  })

  it('writes nothing for a tab nobody is recording', () => {
    const recorder = new TabRecorder()
    // This sits on the ordinary navigation and network paths, which run either way.
    recorder.noteEvent('tab-9', { type: 'navigate', url: 'https://example.com/' })
    expect(readdirSync(dir)).toEqual([])
  })

  it('tells a conversation that a field was filled, but never what was typed', () => {
    const recorder = new TabRecorder()
    const person = recorder.start({ tabId: 'tab-1', dir, source: fakeTab(1) })
    const session = recorder.startFor('s1', { tabId: 'tab-1', dir, source: fakeTab(1) })

    recorder.noteEvent('tab-1', {
      type: 'fill',
      target: { tag: 'input', role: 'textbox', name: 'Order id' },
      value: 'A-1',
    })
    recorder.noteEvent('tab-1', { type: 'click', target: { tag: 'button', role: 'button', name: 'Export' } })

    // Whose recording it is decides what it may be told: nobody can be asked to consent to a
    // recording they are not watching.
    const [, personalFill] = linesOf(sidecarPathFor(person.file))
    expect(personalFill).toMatchObject({ type: 'fill', value: 'A-1' })

    const [, conversationalFill, conversationalClick] = linesOf(sidecarPathFor(session.file))
    expect(conversationalFill.value).toBeUndefined()
    // The field is still named — a step can say which one it was.
    expect(conversationalFill.target.name).toBe('Order id')
    // And everything that is not a value goes to both.
    expect(conversationalClick).toMatchObject({ type: 'click', target: { name: 'Export' } })
  })
})
