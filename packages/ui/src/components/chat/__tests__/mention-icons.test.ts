/**
 * The one mention-icon set: that every kind has an icon, and that the kind a reference maps to
 * is decided here (and only here) — the composer's chip, the sent badge and the @ menu all ask
 * this module.
 */
import { describe, expect, it } from 'bun:test'
import { fileMentionIconKind, mentionIconKindFor, mentionIconSvg } from '../mention-icons'

describe('mentionIconKindFor', () => {
  it('maps each reference kind to its own icon', () => {
    expect(mentionIconKindFor('skill')).toBe('skill')
    expect(mentionIconKindFor('source')).toBe('source')
    expect(mentionIconKindFor('folder')).toBe('folder')
    expect(mentionIconKindFor('tab')).toBe('tab')
    expect(mentionIconKindFor('design')).toBe('design')
    expect(mentionIconKindFor('element')).toBe('element')
  })

  it('picks a file icon from the name, so a `.ts` reads as code', () => {
    expect(mentionIconKindFor('file', 'src/index.ts')).toBe('fileCode')
    expect(mentionIconKindFor('file', 'cover.png')).toBe('fileImage')
    expect(mentionIconKindFor('file', 'LICENSE')).toBe('file')
  })
})

describe('fileMentionIconKind', () => {
  it('is case-insensitive about the extension', () => {
    expect(fileMentionIconKind('README.MD')).toBe('fileCode')
    expect(fileMentionIconKind('Photo.JPEG')).toBe('fileImage')
  })

  it('falls back to the plain file icon for an unknown or absent extension', () => {
    expect(fileMentionIconKind('archive.tar.gz')).toBe('file')
    expect(fileMentionIconKind('Makefile')).toBe('file')
  })
})

describe('mentionIconSvg', () => {
  it('is sizeless and paints with currentColor, so the caller owns size and colour', () => {
    for (const kind of ['skill', 'source', 'file', 'fileCode', 'fileImage', 'folder', 'tab', 'design', 'element'] as const) {
      const svg = mentionIconSvg(kind)
      // Only the root tag is checked — a shape may legitimately carry its own width/height.
      const rootTag = svg.slice(0, svg.indexOf('>') + 1)
      expect(rootTag).toContain('stroke="currentColor"')
      expect(rootTag).not.toContain(' width="')
      expect(rootTag).not.toContain(' height="')
      expect(rootTag).not.toContain('class=')
    }
  })

  it('gives different kinds different shapes', () => {
    expect(mentionIconSvg('folder')).not.toBe(mentionIconSvg('file'))
  })
})
