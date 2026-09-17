import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { loadProjectConfig, saveProjectConfig } from '../../projects/storage'
import {
  getProjectPrototypes,
  getPrototypeDirPath,
  setProjectPrototypes,
  writePrototypeConfig,
} from '..'

let workspaceRoot = ''

afterEach(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true })
  workspaceRoot = ''
})

/** A workspace with one project and two prototypes. */
function makeWorkspace(): string {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-prototype-project-'))
  // A project is a directory *with a config* — that is what `projectExists` reads,
  // so making the directory alone would test nothing.
  saveProjectConfig(workspaceRoot, {
    id: 'proj_test',
    slug: 'acme-redesign',
    name: 'Acme Redesign',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  for (const slug of ['checkout-flow', 'search-flow']) {
    mkdirSync(getPrototypeDirPath(workspaceRoot, slug), { recursive: true })
    writePrototypeConfig(workspaceRoot, slug, { pages: [{ name: 'cart', kind: 'scratch', entry: true }] })
  }
  return workspaceRoot
}

describe('the prototypes a project is worked on with (§15.1.3)', () => {
  it('records the set, reads it back, and clears it by leaving no key', () => {
    const root = makeWorkspace()
    expect(getProjectPrototypes(root, 'acme-redesign')).toEqual([])

    setProjectPrototypes(root, 'acme-redesign', ['checkout-flow'])
    expect(getProjectPrototypes(root, 'acme-redesign')).toEqual(['checkout-flow'])
    expect(loadProjectConfig(root, 'acme-redesign')?.prototypeSlugs).toEqual(['checkout-flow'])

    setProjectPrototypes(root, 'acme-redesign', [])
    expect(getProjectPrototypes(root, 'acme-redesign')).toEqual([])
    // "None" is the key being absent, not an empty list — the rule pages and
    // references already follow.
    expect(loadProjectConfig(root, 'acme-redesign')?.prototypeSlugs).toBeUndefined()
  })

  // A set, not a choice of one: a project works on several prototypes at once, and
  // nothing in the record says which is in front (§15.1.3).
  it('holds several prototypes at once', () => {
    const root = makeWorkspace()

    setProjectPrototypes(root, 'acme-redesign', ['checkout-flow', 'search-flow'])
    expect(getProjectPrototypes(root, 'acme-redesign')).toEqual(['checkout-flow', 'search-flow'])

    // Replacing the set is the update: what is not sent is no longer worked on.
    setProjectPrototypes(root, 'acme-redesign', ['search-flow'])
    expect(getProjectPrototypes(root, 'acme-redesign')).toEqual(['search-flow'])
  })

  // No membership to satisfy: a prototype belongs to no project (§15.1.4), so any
  // prototype of the workspace can be in the set. The two prototypes here were
  // created without ever naming a project, and both are recordable.
  it('records any prototype of the workspace, with no ownership to check', () => {
    const root = makeWorkspace()

    setProjectPrototypes(root, 'acme-redesign', ['checkout-flow'])
    expect(getProjectPrototypes(root, 'acme-redesign')).toEqual(['checkout-flow'])

    setProjectPrototypes(root, 'acme-redesign', ['search-flow'])
    expect(getProjectPrototypes(root, 'acme-redesign')).toEqual(['search-flow'])
  })

  // A prototype that is not there is **filtered**, not refused: the record is background,
  // so the honest outcome is the same as not naming it — and nobody should get an error
  // for ticking a prototype that was deleted a moment ago. The rest of the set stays.
  it('filters the prototypes that do not exist instead of refusing them', () => {
    const root = makeWorkspace()
    setProjectPrototypes(root, 'acme-redesign', ['checkout-flow'])

    expect(() => setProjectPrototypes(root, 'acme-redesign', ['nope', 'search-flow'])).not.toThrow()
    expect(getProjectPrototypes(root, 'acme-redesign')).toEqual(['search-flow'])

    setProjectPrototypes(root, 'acme-redesign', ['nope'])
    expect(getProjectPrototypes(root, 'acme-redesign')).toEqual([])
    expect(loadProjectConfig(root, 'acme-redesign')?.prototypeSlugs).toBeUndefined()
  })

  // Nothing here creates a project: a write aimed at one that is gone fails in the
  // storage layer, which is the only thing that would have to write the record. A
  // conversation never gets this far — a project that is gone is not in its context.
  it('cannot write a record for a project that does not exist', () => {
    const root = makeWorkspace()
    expect(() => setProjectPrototypes(root, 'nope', ['checkout-flow'])).toThrow('Project not found: nope')
  })

  it('reads as none when the prototypes it names are gone', () => {
    const root = makeWorkspace()
    setProjectPrototypes(root, 'acme-redesign', ['checkout-flow', 'search-flow'])

    rmSync(getPrototypeDirPath(root, 'checkout-flow'), { recursive: true, force: true })

    // The prompt mentions a prototype only while it is there.
    expect(getProjectPrototypes(root, 'acme-redesign')).toEqual(['search-flow'])
  })
})
