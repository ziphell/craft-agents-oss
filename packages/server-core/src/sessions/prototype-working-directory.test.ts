/**
 * "A conversation works in one place" — the two halves of that one choice, on the session.
 *
 * Binding a prototype moves the working directory into the prototype's own folder; picking
 * any other directory drops the binding. Both directions are asserted here because they are
 * the only thing keeping the picker, the badge and bash's cwd saying the same thing.
 */
import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SessionManager } from './SessionManager.ts'

describe('prototype binding and working directory', () => {
  let root = ''

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'craft-prototype-cwd-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  /** One session with the fields these two mutators read, and the events they emit. */
  function harness(seed: { prototypeSlug?: string; workingDirectory?: string; messages?: unknown[] }) {
    const sm = new SessionManager()
    const events: string[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const any = sm as any
    any.sendEvent = (e: { type: string }) => events.push(e.type)
    any.persistSession = () => {}
    any.flushSession = async () => {}
    any.setMetadataWriteGuard = () => {}

    const session = {
      id: 's',
      messages: seed.messages ?? [],
      workspace: { id: 'ws', rootPath: root },
      ...seed,
    }
    any.sessions.set('s', session)
    return { sm, events, session }
  }

  /** A prototype folder on disk, created the way the prototypes layer would. */
  function makePrototypeFolder(slug: string): string {
    const dir = join(root, 'prototypes', slug)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  it('binding a prototype moves the working directory into the prototype folder', async () => {
    const dir = makePrototypeFolder('checkout-flow')
    const { sm, events, session } = harness({ workingDirectory: join(root, 'sessions', 's') })

    await sm.setSessionPrototypeSlug('s', 'checkout-flow')

    expect(session.prototypeSlug).toBe('checkout-flow')
    expect(session.workingDirectory).toBe(dir)
    expect(events).toContain('prototype_slug_changed')
    expect(events).toContain('working_directory_changed')
  })

  it('picking a different folder drops the binding', () => {
    const prototypeDir = makePrototypeFolder('checkout-flow')
    const otherDir = join(root, 'code', 'shop')
    mkdirSync(otherDir, { recursive: true })
    const { sm, events, session } = harness({
      prototypeSlug: 'checkout-flow',
      workingDirectory: prototypeDir,
      messages: [{ id: 'm1' }],
    })

    sm.updateWorkingDirectory('s', otherDir)

    expect(session.workingDirectory).toBe(otherDir)
    expect(session.prototypeSlug).toBeUndefined()
    expect(events).toContain('prototype_slug_changed')
  })

  it('picking the prototype folder again keeps the binding', () => {
    const prototypeDir = makePrototypeFolder('checkout-flow')
    const { sm, events, session } = harness({
      prototypeSlug: 'checkout-flow',
      workingDirectory: prototypeDir,
      messages: [{ id: 'm1' }],
    })

    // The same folder, as a person would hand it back: a trailing separator typed or
    // pasted, which must not read as "somewhere else".
    sm.updateWorkingDirectory('s', prototypeDir + '/')

    expect(session.prototypeSlug).toBe('checkout-flow')
    expect(session.workingDirectory).toBe(prototypeDir + '/')
    expect(events).not.toContain('prototype_slug_changed')
  })

  it('binds a prototype whose folder is not there yet, without moving the session', async () => {
    const here = join(root, 'sessions', 's')
    mkdirSync(here, { recursive: true })
    const { sm, events, session } = harness({ workingDirectory: here })

    await sm.setSessionPrototypeSlug('s', 'never-written')

    expect(session.prototypeSlug).toBe('never-written')
    expect(session.workingDirectory).toBe(here)
    expect(events).toContain('prototype_slug_changed')
    expect(events).not.toContain('working_directory_changed')
    expect(events).not.toContain('working_directory_error')
  })
})
