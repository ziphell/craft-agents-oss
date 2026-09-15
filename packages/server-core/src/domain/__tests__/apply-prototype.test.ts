/**
 * Tests for the prototype ↔ live-browser bridge.
 *
 * The behaviour worth pinning is what the injector *does not* do: a page that
 * already arrived with its patches (the workbench's own rendered page) must not
 * have them run again, while a foreign document must still get all of them.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  buildInlinedPatchProbeScript,
  createPrototype,
  getPrototypePatchesPath,
} from '@craft-agent/shared/prototypes'
import { applyPrototypeToBrowser } from '../apply-prototype'
import type { IBrowserPaneManager } from '../../handlers/browser-pane-manager-interface'

const PROBE = buildInlinedPatchProbeScript()

/** A stand-in browser pane that records what was done to the page. */
function makeBpm(inlined: unknown) {
  const evaluated: string[] = []
  const registered: string[] = []
  const cleared: string[] = []

  const bpm = {
    evaluate: mock(async (_id: string, expression: string) => {
      // The probe is the only expression whose answer matters to the caller.
      if (expression === PROBE) return inlined
      evaluated.push(expression)
      return undefined
    }),
    addInitScript: mock(async (_id: string, key: string) => {
      registered.push(key)
      return key
    }),
    clearInitScripts: mock(async (_id: string, prefix: string) => {
      cleared.push(prefix)
      return []
    }),
  }

  return { bpm: bpm as unknown as IBrowserPaneManager, evaluated, registered, cleared }
}

describe('applyPrototypeToBrowser', () => {
  const slug = 'checkout-flow'
  let workspaceRoot = ''

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-apply-prototype-'))
    createPrototype(workspaceRoot, { name: slug, kind: 'scratch' })
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  function writePatch(file: string, source: string): void {
    writeFileSync(join(getPrototypePatchesPath(workspaceRoot, slug), file), source, 'utf-8')
  }

  // An overlay's target page — a real document that knows nothing about us.
  it('injects every patch into a document that carries none', async () => {
    writePatch('A-001-btn.css', '.btn { color: red }')
    writePatch('A-002-guard.js', 'window.guard = true;')
    const { bpm, evaluated, registered, cleared } = makeBpm([])

    const result = await applyPrototypeToBrowser(bpm, 'browser-1', workspaceRoot, slug)

    expect(result.applied).toBe(2)
    expect(result.files).toEqual(['A-001-btn.css', 'A-002-guard.js'])
    expect(result.skipped).toEqual([])
    expect(evaluated).toHaveLength(2)
    // Keys carry the slug, so clearing one prototype cannot touch another's.
    expect(registered).toEqual([
      `prototype:${slug}:A-001-btn.css`,
      `prototype:${slug}:A-002-guard.js`,
    ])
    expect(cleared).toEqual([`prototype:${slug}:`])
  })

  /**
   * The rendered page is the workbench's own document, and re-running a JS patch
   * that is already inlined is silently wrong: the page looks the same while the
   * patch has run twice.
   */
  it('leaves alone what the rendered page already carries', async () => {
    writePatch('A-001-btn.css', '.btn { color: red }')
    const { bpm, evaluated, registered } = makeBpm(['A-001-btn.css'])

    const result = await applyPrototypeToBrowser(bpm, 'browser-1', workspaceRoot, slug)

    expect(result.applied).toBe(0)
    expect(result.files).toEqual([])
    expect(result.skipped).toEqual(['A-001-btn.css'])
    // Nothing ran now, and nothing is queued for the next load of that page.
    expect(evaluated).toEqual([])
    expect(registered).toEqual([])
  })

  // What keeps editing going on an open page: a patch written after it was
  // rendered still lands, in place, without disturbing the ones already there.
  it('injects a patch added after the render, and only that one', async () => {
    writePatch('A-001-btn.css', '.btn { color: red }')
    writePatch('A-002-new.js', 'window.newOne = true;')
    const { bpm, evaluated } = makeBpm(['A-001-btn.css'])

    const result = await applyPrototypeToBrowser(bpm, 'browser-1', workspaceRoot, slug)

    expect(result.applied).toBe(1)
    expect(result.files).toEqual(['A-002-new.js'])
    expect(result.skipped).toEqual(['A-001-btn.css'])
    expect(evaluated).toHaveLength(1)
    expect(evaluated[0]).toContain('window.newOne = true;')
  })

  // Assuming work was done is the dangerous direction: it would leave a page bare
  // while reporting success.
  it('treats an unreadable answer as an untouched document', async () => {
    writePatch('A-001-btn.css', '.btn { color: red }')
    const { bpm } = makeBpm(null)

    expect((await applyPrototypeToBrowser(bpm, 'browser-1', workspaceRoot, slug)).applied).toBe(1)
  })

  it('reports nothing to do for a prototype with no patches', async () => {
    const { bpm, evaluated, cleared } = makeBpm([])

    const result = await applyPrototypeToBrowser(bpm, 'browser-1', workspaceRoot, slug)

    expect(result).toEqual({ slug, applied: 0, files: [], skipped: [] })
    expect(evaluated).toEqual([])
    // Still cleared: a registration left by a patch that was since deleted must go.
    expect(cleared).toEqual([`prototype:${slug}:`])
  })
})
