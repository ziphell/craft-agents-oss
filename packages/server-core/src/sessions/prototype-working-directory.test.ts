/**
 * Binding a prototype records *which body of work* a conversation is on. Where it works
 * is a different fact, owned by the project (or the session's own fallback) — so neither
 * mutator may touch the other. Both directions are asserted here because they are the only
 * thing keeping the binding badge and the working-directory picker from claiming to be one
 * choice: they used to be, and binding used to move you into the prototype's folder.
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

  it('binding a prototype leaves the working directory alone', async () => {
    // The prototype's folder exists — binding still does not adopt it.
    makePrototypeFolder('checkout-flow')
    const here = join(root, 'sessions', 's')
    mkdirSync(here, { recursive: true })
    const { sm, events, session } = harness({ workingDirectory: here })

    await sm.setSessionPrototypeSlug('s', 'checkout-flow')

    expect(session.prototypeSlug).toBe('checkout-flow')
    expect(session.workingDirectory).toBe(here)
    expect(events).toContain('prototype_slug_changed')
    expect(events).not.toContain('working_directory_changed')
  })

  it('unbinding leaves the working directory alone', async () => {
    const here = join(root, 'sessions', 's')
    mkdirSync(here, { recursive: true })
    const { sm, events, session } = harness({ prototypeSlug: 'checkout-flow', workingDirectory: here })

    await sm.setSessionPrototypeSlug('s', null)

    expect(session.prototypeSlug).toBeUndefined()
    expect(session.workingDirectory).toBe(here)
    expect(events).toContain('prototype_slug_changed')
    expect(events).not.toContain('working_directory_changed')
  })

  it('picking a different folder keeps the binding', () => {
    const otherDir = join(root, 'code', 'shop')
    mkdirSync(otherDir, { recursive: true })
    const { sm, events, session } = harness({
      prototypeSlug: 'checkout-flow',
      workingDirectory: join(root, 'sessions', 's'),
      messages: [{ id: 'm1' }],
    })

    sm.updateWorkingDirectory('s', otherDir)

    expect(session.workingDirectory).toBe(otherDir)
    expect(session.prototypeSlug).toBe('checkout-flow')
    expect(events).not.toContain('prototype_slug_changed')
    expect(events).toContain('working_directory_changed')
  })
})
