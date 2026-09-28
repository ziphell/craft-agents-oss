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
  })
})
