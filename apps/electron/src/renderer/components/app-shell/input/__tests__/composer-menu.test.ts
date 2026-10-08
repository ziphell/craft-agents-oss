import { describe, it, expect } from 'bun:test'
import { buildComposerMenuItems } from '../composer-menu'

const LAYERS = ['goal', 'spec', 'plan'] as const

describe('buildComposerMenuItems', () => {
  describe('order and grouping', () => {
    it('offers attach first and compact last', () => {
      const items = buildComposerMenuItems({ layers: LAYERS, isProcessing: false })

      expect(items.map(i => i.id)).toEqual(['attach', 'goal', 'spec', 'plan', 'compact'])
      expect(items[0]!.id).toBe('attach')
      expect(items.at(-1)!.id).toBe('compact')
    })

    it('puts the first item in no group of its own', () => {
      const items = buildComposerMenuItems({ layers: LAYERS, isProcessing: false })

      expect(items.map(i => i.separatorBefore)).toEqual([false, true, false, false, true])
    })

    it('draws no separator when there are no layers to separate', () => {
      const items = buildComposerMenuItems({ layers: [], isProcessing: false })

      expect(items.map(i => i.id)).toEqual(['attach', 'compact'])
      expect(items.map(i => i.separatorBefore)).toEqual([false, false])
    })
  })

  describe('layers', () => {
    it('offers no layer for a conversation that belongs to no project', () => {
      const items = buildComposerMenuItems({ layers: [], layerMode: null, isProcessing: false })

      expect(items.filter(i => i.id !== 'attach' && i.id !== 'compact')).toEqual([])
    })

    it('marks the conversation\u2019s current layer, and only that one', () => {
      const items = buildComposerMenuItems({ layers: LAYERS, layerMode: 'spec', isProcessing: false })

      expect(items.filter(i => i.active).map(i => i.id)).toEqual(['spec'])
    })

    it('marks nothing when the conversation is on no layer', () => {
      const items = buildComposerMenuItems({ layers: LAYERS, layerMode: null, isProcessing: false })

      expect(items.some(i => i.active)).toBe(false)
    })

    it('never disables a layer', () => {
      const items = buildComposerMenuItems({ layers: LAYERS, layerMode: 'goal', isProcessing: true })

      expect(items.filter(i => i.id === 'goal' || i.id === 'spec' || i.id === 'plan').some(i => i.disabled)).toBe(false)
    })
  })

  describe('compact', () => {
    it('is enabled between turns', () => {
      const items = buildComposerMenuItems({ layers: LAYERS, isProcessing: false })

      expect(items.find(i => i.id === 'compact')!.disabled).toBe(false)
    })

    it('is disabled while a turn is being generated', () => {
      const items = buildComposerMenuItems({ layers: LAYERS, isProcessing: true })

      expect(items.find(i => i.id === 'compact')!.disabled).toBe(true)
    })

    it('is the only item a turn ever disables', () => {
      const items = buildComposerMenuItems({ layers: LAYERS, isProcessing: true })

      expect(items.filter(i => i.disabled).map(i => i.id)).toEqual(['compact'])
    })
  })

  it('never disables attaching — files are added to a draft, not sent', () => {
    const items = buildComposerMenuItems({ layers: LAYERS, isProcessing: true })

    expect(items.find(i => i.id === 'attach')!.disabled).toBe(false)
  })
})
