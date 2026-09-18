import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createPrototype, getPrototypePatchesPath, scanPrototypePatches, UI_WRITER, writePrototypeEdits } from '..'

const SLUG = 'checkout-flow'

function writePatch(workspaceRoot: string, file: string, source: string): void {
  writeFileSync(join(getPrototypePatchesPath(workspaceRoot, SLUG), file), source, 'utf-8')
}

function read(workspaceRoot: string, file: string): string {
  return readFileSync(join(getPrototypePatchesPath(workspaceRoot, SLUG), file), 'utf-8')
}

/**
 * A save in the window's editor becomes a patch, and the three facts that decide
 * are here: it is published under its own writer id, it is numbered **after**
 * everything already written (replay order is the declared number and the writer id
 * is not a sort key, so an earlier number would lose to the patch it corrects), and
 * one session's edits land as **one** entry in the change layer.
 */
describe('writePrototypeEdits', () => {
  let workspaceRoot = ''

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-edit-patch-'))
    createPrototype(workspaceRoot, { name: SLUG })
    writePatch(workspaceRoot, 'A-001-total.css', '.total { color: red }')
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('writes a style edit as a patch that replays after what is already there', () => {
    const written = writePrototypeEdits(workspaceRoot, SLUG, null, [
      { kind: 'style', targets: ['.total', '#pay-btn'], declarations: { 'font-weight': '700' } },
    ])

    // `A-001-…` is the highest declared order, so this one is 2 — and `ui` is a
    // writer of its own, not a sort key.
    expect(written).toEqual({ files: ['patches/ui-002-bold.css'], order: 2 })
    const source = read(workspaceRoot, 'ui-002-bold.css')
    expect(source).toContain('@target .total')
    expect(source).toContain('@target #pay-btn')
    expect(source).toContain('.total {')
    expect(source).toContain('font-weight: 700;')

    const patches = scanPrototypePatches(workspaceRoot, SLUG)
    expect(patches.map((patch) => patch.file)).toEqual(['A-001-total.css', 'ui-002-bold.css'])
    // What the edit is aimed at is readable by everything downstream: the anchor
    // record and the drift report are built from these.
    expect(patches[1]?.targets).toEqual(['.total', '#pay-btn'])
    expect(patches[1]?.writer).toBe(UI_WRITER)
  })

  it('writes one save as one entry, in the order the edits were made', () => {
    const written = writePrototypeEdits(workspaceRoot, SLUG, 'pay', [
      { kind: 'style', targets: ['.pay-btn'], declarations: { 'font-weight': '700' } },
      { kind: 'style', targets: ['.pay-btn', '.total'], declarations: { 'font-style': 'italic' } },
      { kind: 'text', selector: '.total', text: 'Total: 12 €' },
    ])

    // Two files because a stylesheet and a script cannot be one file — the same
    // number for both, so replay order breaks the tie by name: styles first.
    expect(written.files).toEqual(['patches/pay/ui-002-edits.css', 'patches/pay/ui-002-text.js'])
    expect(written.order).toBe(2)

    const css = read(workspaceRoot, 'pay/ui-002-edits.css')
    // Later rules win, which is how a session that bolded then un-bolded the same
    // element lands where it ended.
    expect(css.indexOf('.pay-btn {\n  font-weight: 700;')).toBeLessThan(css.indexOf('.pay-btn {\n  font-style: italic;'))
    // Every target once, in the order they were touched.
    expect(css.match(/@target /g)).toHaveLength(2)
    expect(css).toContain('@target .pay-btn')
    expect(css).toContain('@target .total')

    const js = read(workspaceRoot, 'pay/ui-002-text.js')
    expect(js).toContain('// @target .total')
    expect(js).toContain('document.querySelector(".total")')
    expect(js).toContain('el0.textContent = "Total: 12 €";')

    const patches = scanPrototypePatches(workspaceRoot, SLUG)
    expect(patches.map((patch) => patch.file)).toEqual([
      'A-001-total.css',
      'pay/ui-002-edits.css',
      'pay/ui-002-text.js',
    ])
    // Both files declare what they are aimed at, so the anchor record and the drift
    // report cover a person's edits exactly as they cover an agent's.
    expect(patches.slice(1).map((patch) => patch.targets)).toEqual([['.pay-btn', '.total'], ['.total']])
  })

  it('writes several retyped elements into one script, each with its own local', () => {
    writePrototypeEdits(workspaceRoot, SLUG, 'pay', [
      { kind: 'text', selector: '.pay-btn', text: 'Pay now, "quoted"' },
      { kind: 'text', selector: '.total', text: 'Total' },
    ])

    const source = read(workspaceRoot, 'pay/ui-002-text.js')
    expect(source).toContain('el0.textContent = "Pay now, \\"quoted\\"";')
    expect(source).toContain('el1.textContent = "Total";')
    expect(source.match(/@target /g)).toHaveLength(2)
  })

  it('refuses a save that would not survive being written into a patch', () => {
    expect(() =>
      writePrototypeEdits(workspaceRoot, SLUG, null, [
        { kind: 'style', targets: ['.a { color: red }'], declarations: { 'font-weight': '700' } },
      ]),
    ).toThrow()
    expect(() =>
      writePrototypeEdits(workspaceRoot, SLUG, null, [
        { kind: 'style', targets: ['.a'], declarations: { 'font-weight': '700 } .b {' } },
      ]),
    ).toThrow()
    expect(() => writePrototypeEdits(workspaceRoot, SLUG, null, [{ kind: 'text', selector: '  ', text: 'x' }])).toThrow()
    expect(() => writePrototypeEdits(workspaceRoot, SLUG, null, [])).toThrow()
  })

  it('numbers the next save after the one just written', () => {
    writePrototypeEdits(workspaceRoot, SLUG, null, [{ kind: 'style', targets: ['.a'], declarations: { 'font-weight': '700' } }])
    const second = writePrototypeEdits(workspaceRoot, SLUG, null, [
      { kind: 'style', targets: ['.a'], declarations: { 'font-weight': '400' } },
    ])

    expect(second.order).toBe(3)
    expect(existsSync(join(getPrototypePatchesPath(workspaceRoot, SLUG), 'ui-003-bold.css'))).toBe(true)
  })
})
