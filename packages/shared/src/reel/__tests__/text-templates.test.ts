import { describe, expect, test } from 'bun:test'
import { normalizeOverlay } from '../overlay.ts'
import { TEXT_TEMPLATES, textTemplateOf } from '../text-templates.ts'

describe('花字 catalog', () => {
  test('ids are unique and every template becomes a usable text overlay', () => {
    expect(new Set(TEXT_TEMPLATES.map((template) => template.id)).size).toBe(TEXT_TEMPLATES.length)
    for (const template of TEXT_TEMPLATES) {
      const overlay = normalizeOverlay(
        {
          kind: 'text',
          text: template.sample,
          start: 0,
          duration: 2,
          box: template.box,
          preset: template.preset,
          style: template.style,
          animation: template.animation,
        },
        0,
      )
      expect(overlay).not.toBeNull()
      expect(overlay!.preset).toBe(template.preset)
      expect(overlay!.style?.fontSize).toBe(template.style.fontSize)
      expect(overlay!.box).toEqual(template.box)
    }
    expect(textTemplateOf('impact')?.label).toBe('冲击大字')
    expect(textTemplateOf('nope')).toBeUndefined()
  })
})
