import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { saveProjectConfig } from '../../projects/storage'
import {
  getPrototypeDirPath,
  getPrototypeProject,
  listPrototypesForProject,
  readPrototypeConfig,
  resolveProjectPrototype,
  setPrototypeProject,
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

describe('the prototype ↔ project edge', () => {
  it('records which project a prototype was made for, and reads it back', () => {
    const root = makeWorkspace()
    expect(getPrototypeProject(root, 'checkout-flow')).toBeNull()

    setPrototypeProject(root, 'checkout-flow', 'acme-redesign')

    expect(getPrototypeProject(root, 'checkout-flow')).toBe('acme-redesign')
    expect(readPrototypeConfig(root, 'checkout-flow').projectSlug).toBe('acme-redesign')
    // One-way on purpose, and not a move: nothing of the prototype is inside the
    // project, and the other prototype is untouched (plan §15.1).
    expect(getPrototypeProject(root, 'search-flow')).toBeNull()
  })

  it('lists the prototypes that belong to a project', () => {
    const root = makeWorkspace()
    setPrototypeProject(root, 'checkout-flow', 'acme-redesign')

    expect(listPrototypesForProject(root, 'acme-redesign')).toEqual(['checkout-flow'])
    expect(listPrototypesForProject(root, 'nobody')).toEqual([])
  })

  it('clears the edge, and does not write an empty slug', () => {
    const root = makeWorkspace()
    setPrototypeProject(root, 'checkout-flow', 'acme-redesign')
    setPrototypeProject(root, 'checkout-flow', null)

    expect(getPrototypeProject(root, 'checkout-flow')).toBeNull()
    // "No project" is the key being absent, not an empty string — the rule pages
    // and references already follow.
    expect(readPrototypeConfig(root, 'checkout-flow').projectSlug).toBeUndefined()
  })

  // A relationship that is not true is worse than a failed command: the config
  // would name a project nobody can open.
  it('refuses a project that does not exist, and a prototype that does not exist', () => {
    const root = makeWorkspace()

    expect(() => setPrototypeProject(root, 'checkout-flow', 'nope')).toThrow('No project "nope"')
    expect(() => setPrototypeProject(root, 'nope', 'acme-redesign')).toThrow('does not exist')
  })
})

describe('the project\'s prototype (what a conversation inherits)', () => {
  it('answers with the one prototype that belongs to the project', () => {
    const root = makeWorkspace()
    setPrototypeProject(root, 'checkout-flow', 'acme-redesign')

    expect(resolveProjectPrototype(root, 'acme-redesign')).toBe('checkout-flow')
  })

  it('answers nothing when no prototype belongs to the project', () => {
    const root = makeWorkspace()

    expect(resolveProjectPrototype(root, 'acme-redesign')).toBeNull()
    expect(resolveProjectPrototype(root, null)).toBeNull()
    expect(resolveProjectPrototype(root, '')).toBeNull()
  })

  // The rule is "exactly one": with two candidates there is no single prototype
  // the project names, and picking one would make the answer depend on directory
  // order — so a session falls back to the binding it always had.
  it('answers nothing when several prototypes claim the project', () => {
    const root = makeWorkspace()
    setPrototypeProject(root, 'checkout-flow', 'acme-redesign')
    setPrototypeProject(root, 'search-flow', 'acme-redesign')

    expect(resolveProjectPrototype(root, 'acme-redesign')).toBeNull()
    // ...and the list is what lets a caller say which of the two happened.
    expect(listPrototypesForProject(root, 'acme-redesign')).toEqual(['checkout-flow', 'search-flow'])
  })

  it('follows the edge when a prototype is moved to another project', () => {
    const root = makeWorkspace()
    setPrototypeProject(root, 'checkout-flow', 'acme-redesign')
    setPrototypeProject(root, 'checkout-flow', null)

    expect(resolveProjectPrototype(root, 'acme-redesign')).toBeNull()
  })
})
