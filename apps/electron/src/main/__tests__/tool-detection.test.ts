import { describe, it, expect } from 'bun:test'

import {
  getBrowserToolCommandVerb,
  shouldActivateBrowserOverlay,
} from '@craft-agent/server-core/domain'

describe('tool detection', () => {
  describe('getBrowserToolCommandVerb', () => {
    it('extracts normalized command verbs', () => {
      expect(getBrowserToolCommandVerb({ command: 'release' })).toBe('release')
      expect(getBrowserToolCommandVerb({ command: '  SNAPSHOT   ' })).toBe('snapshot')
      expect(getBrowserToolCommandVerb({ command: '--help' })).toBe('--help')
      expect(getBrowserToolCommandVerb({ command: 'navigate https://example.com' })).toBe('navigate')
    })

    it('returns empty string for invalid inputs', () => {
      expect(getBrowserToolCommandVerb({})).toBe('')
      expect(getBrowserToolCommandVerb({ command: 123 })).toBe('')
      expect(getBrowserToolCommandVerb(null)).toBe('')
    })
  })

  describe('shouldActivateBrowserOverlay', () => {
    it('does not activate for non-browser_tool names', () => {
      expect(shouldActivateBrowserOverlay('browser_open', {})).toBe(false)
      expect(shouldActivateBrowserOverlay('mcp__session__browser_snapshot', {})).toBe(false)
      expect(shouldActivateBrowserOverlay('mcp__session__read', {})).toBe(false)
      expect(shouldActivateBrowserOverlay('write', {})).toBe(false)
    })

    it('does not activate for browser_tool help/open/release/teardown commands', () => {
      expect(shouldActivateBrowserOverlay('browser_tool', { command: '--help' })).toBe(false)
      expect(shouldActivateBrowserOverlay('browser_tool', { command: 'help' })).toBe(false)
      expect(shouldActivateBrowserOverlay('browser_tool', { command: 'open' })).toBe(false)
      expect(shouldActivateBrowserOverlay('browser_tool', { command: 'open --foreground' })).toBe(false)
      expect(shouldActivateBrowserOverlay('mcp__session__browser_tool', { command: 'release' })).toBe(false)
      expect(shouldActivateBrowserOverlay('browser_tool', { command: 'close' })).toBe(false)
      expect(shouldActivateBrowserOverlay('browser_tool', { command: 'hide' })).toBe(false)
    })

    it('does not activate when browser_tool command is missing', () => {
      expect(shouldActivateBrowserOverlay('browser_tool', {})).toBe(false)
      expect(shouldActivateBrowserOverlay('mcp__session__browser_tool', { command: '   ' })).toBe(false)
    })

    it('activates for browser_tool actionable commands', () => {
      expect(shouldActivateBrowserOverlay('browser_tool', { command: 'snapshot' })).toBe(true)
      expect(shouldActivateBrowserOverlay('mcp__session__browser_tool', { command: 'navigate https://linear.app' })).toBe(true)
    })

    // The prototype workbench is the other door onto the same window: the commands that act on a
    // page say so, and the ones that only read or write a prototype's files do not.
    it('acts on the prototype tool only for the commands that drive a page', () => {
      expect(shouldActivateBrowserOverlay('prototype_tool', { command: 'open' })).toBe(true)
      expect(shouldActivateBrowserOverlay('mcp__session__prototype_tool', { command: 'apply' })).toBe(true)
      expect(shouldActivateBrowserOverlay('prototype_tool', { command: 'verify' })).toBe(true)

      expect(shouldActivateBrowserOverlay('prototype_tool', { command: 'list' })).toBe(false)
      expect(shouldActivateBrowserOverlay('prototype_tool', { command: 'status' })).toBe(false)
      expect(shouldActivateBrowserOverlay('prototype_tool', { command: 'export' })).toBe(false)
      expect(shouldActivateBrowserOverlay('prototype_tool', { command: '--help' })).toBe(false)
      // The frames come out of a file, not off a page: this one shares an artifact with
      // `record`, not a tab with it.
      expect(shouldActivateBrowserOverlay('prototype_tool', { command: 'sample-video demo.mp4' })).toBe(false)
      expect(shouldActivateBrowserOverlay('prototype_tool', { command: 'pages --change pay=https://x.test/pay' })).toBe(false)
    })
  })
})
