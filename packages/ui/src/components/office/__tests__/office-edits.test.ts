import { beforeEach, describe, expect, it } from 'bun:test'
import {
  applyOfficeEdit,
  clearOfficeEditTargets,
  hasOfficeEditTarget,
  registerOfficeEditTarget,
} from '../office-edits'
import type { OfficeFrameEditResult } from '../OfficeFrame'
import { clearTextEditTargets, registerTextEditTarget } from '../../editors/text-edits'

const edit = { from: 4, to: 9, expectedText: 'Hello', text: 'Hi' }

function target(result: OfficeFrameEditResult = { ok: true }) {
  const calls: unknown[] = []
  return {
    calls,
    applyEdit: (value: unknown) => {
      calls.push(value)
      return Promise.resolve(result)
    },
  }
}

beforeEach(() => clearOfficeEditTargets())

describe('office edit targets', () => {
  it('finds the editor showing a path and hands it the edit', async () => {
    const stub = target()
    registerOfficeEditTarget('/a/report.docx', stub)
    expect(hasOfficeEditTarget('/a/report.docx')).toBe(true)
    expect(await applyOfficeEdit('/a/report.docx', edit)).toEqual({ ok: true })
    expect(stub.calls).toEqual([edit])
  })

  it('answers honestly when nothing is showing the document', async () => {
    const result = await applyOfficeEdit('/a/closed.docx', edit)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('no editor')
    expect(hasOfficeEditTarget('/a/closed.docx')).toBe(false)
  })

  it('passes a refusal back rather than throwing', async () => {
    registerOfficeEditTarget('/a/report.docx', target({ ok: false, message: 'the selection moved' }))
    expect(await applyOfficeEdit('/a/report.docx', edit)).toEqual({
      ok: false,
      message: 'the selection moved',
    })
  })

  it('lets a remount replace the previous registration without the old cleanup removing it', async () => {
    const first = target()
    const second = target()
    const offFirst = registerOfficeEditTarget('/a/report.docx', first)
    registerOfficeEditTarget('/a/report.docx', second)
    offFirst()
    // The later mount is the one the person opened; it must still be found.
    expect(await applyOfficeEdit('/a/report.docx', edit)).toEqual({ ok: true })
    expect(second.calls).toHaveLength(1)
    expect(first.calls).toHaveLength(0)
  })

  it('forgets a path once its editor goes away', async () => {
    const off = registerOfficeEditTarget('/a/report.docx', target())
    off()
    expect(hasOfficeEditTarget('/a/report.docx')).toBe(false)
  })
})

describe('a markdown edit is not a frame edit', () => {
  it('goes to the editor showing the text document', async () => {
    clearTextEditTargets()
    const seen: unknown[] = []
    const off = registerTextEditTarget('/a/notes.md', {
      applyEdit: (request) => {
        seen.push(request)
        return { ok: true }
      },
    })
    const result = await applyOfficeEdit('/a/notes.md', { kind: 'markdown', expectedText: '甲', text: '乙' })
    expect(result).toEqual({ ok: true })
    expect(seen).toEqual([{ kind: 'replace-span', expectedText: '甲', text: '乙' }])
    off()
  })

  it('answers "nothing is showing it" when no markdown editor is mounted', async () => {
    clearTextEditTargets()
    expect(await applyOfficeEdit('/a/closed.md', { kind: 'markdown', expectedText: '甲', text: '乙' })).toEqual({
      ok: false,
      message: 'no editor is showing this document',
    })
  })
})
