import { describe, expect, it } from 'bun:test'
import { rewritePromptReferences } from '../reference-prompt.ts'
import { MediaFailure } from '../types.ts'

const images = [
  { type: 'image' as const, index: 0 },
  { type: 'image' as const, index: 1 },
]

describe('rewritePromptReferences', () => {
  it('names each position the way the default labels do', () => {
    expect(rewritePromptReferences('use {{ref 1}} and {{ref 2}}', images)).toBe('use 图片1 and 图片2')
  })

  it('lets a channel spell references its own way', () => {
    expect(
      rewritePromptReferences('use {{ref 1}}', images, { image: 'Image {n}' }),
    ).toBe('use Image 1')
    expect(
      rewritePromptReferences('use {{ref 1}}', images, { image: '@图片{n}' }),
    ).toBe('use @图片1')
  })

  it('speaks of first and last frames without a number', () => {
    expect(
      rewritePromptReferences('start at {{ref 1}}, end at {{ref 2}}', [
        { type: 'firstFrame' },
        { type: 'lastFrame' },
      ]),
    ).toBe('start at 首帧, end at 尾帧')
  })

  it('leaves a prompt with no markers untouched', () => {
    expect(rewritePromptReferences('a lighthouse', images)).toBe('a lighthouse')
  })

  it('refuses a marker with no matching reference', () => {
    expect(() => rewritePromptReferences('use {{ref 3}}', images)).toThrow(MediaFailure)
    expect(() => rewritePromptReferences('use {{ref 1}}', [])).toThrow(/没有对应素材/)
  })

  it('refuses a reference with no usable number', () => {
    expect(() => rewritePromptReferences('use {{ref 1}}', [{ type: 'image' }])).toThrow(/编号无效/)
  })
})
