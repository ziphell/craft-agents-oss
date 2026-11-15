import { describe, expect, it } from 'bun:test'
import { buildHandoffBrief } from '../bot-handoff'

/**
 * What these pin down is not the wording but the three rules in the module header: a brief
 * carries its origin, asks for nothing, and stays short enough to leave room for a sentence.
 */
describe('buildHandoffBrief', () => {
  it('names the conversation it came from, by id', () => {
    const text = buildHandoffBrief({
      kind: 'conversation',
      title: 'Fix the build script',
      workspaceName: 'Craft',
      sessionId: '261103-fit-dusk',
      lastText: 'The build now points at electron:build.',
    })

    expect(text).toContain('- conversation: Fix the build script')
    expect(text).toContain('- workspace: Craft')
    expect(text).toContain('- session: 261103-fit-dusk')
    expect(text).toContain('> The build now points at electron:build.')
    expect(text).toContain('[handoff]')
  })

  it('asks for nothing — an instruction would go out on the next Enter', () => {
    const text = buildHandoffBrief({
      kind: 'conversation',
      title: 't',
      workspaceName: 'w',
      sessionId: 's',
    })
    // No second-person request anywhere in the brief itself.
    expect(text.toLowerCase()).not.toMatch(/\bplease\b|\byou should\b/)
  })

  it('ends with a blank line, so the caret sits where the person types', () => {
    const text = buildHandoffBrief({ kind: 'file', path: '/a/b.md', title: 'b.md', format: 'md' })
    expect(text.endsWith('\n\n')).toBe(true)
  })

  it('flattens and trims the excerpt instead of pasting a transcript', () => {
    const long = 'line one\n\nline two   ' + 'x'.repeat(2000)
    const text = buildHandoffBrief({
      kind: 'conversation',
      title: 't',
      workspaceName: 'w',
      sessionId: 's',
      lastText: long,
    })
    expect(text).toContain('> line one line two')
    expect(text).not.toContain('\n\nline two')
    expect(text.length).toBeLessThan(1000)
    expect(text).toContain('…')
  })

  it('describes a file by path, and by the conversation that wrote it', () => {
    const text = buildHandoffBrief({
      kind: 'file',
      path: 'C:\\ws\\sessions\\s1\\report.docx',
      title: 'report.docx',
      format: 'docx',
      sessionId: 's1',
      sessionName: 'Quarterly numbers',
    })
    expect(text).toContain('- file: C:\\ws\\sessions\\s1\\report.docx')
    expect(text).toContain('- title: report.docx (docx)')
    expect(text).toContain('- written by: conversation "Quarterly numbers" (session s1)')
  })

  it('leaves out what it does not know rather than writing an empty field', () => {
    const text = buildHandoffBrief({ kind: 'file', path: '/a/b.md', title: 'b.md' })
    expect(text).not.toContain('- written by:')
    expect(text).not.toContain('()')
  })
})
