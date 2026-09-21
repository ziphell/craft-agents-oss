/**
 * Websites route round-trips: route string ⇄ NavigationState ⇄ panel key.
 * Guards the six touchpoints a new navigator must thread through
 * (prefix list, parse, build, convert, key serialization, type guard).
 */

import { describe, test, expect } from 'bun:test'
import {
  isCompoundRoute,
  parseCompoundRoute,
  buildCompoundRoute,
  parseRouteToNavigationState,
  buildRouteFromNavigationState,
} from '../route-parser'
import {
  getNavigationStateKey,
  parseNavigationStateKey,
  isWebsitesNavigation,
  type NavigationState,
} from '../types'
import { routes } from '../routes'

describe('websites routes', () => {
  test('route builders emit the websites prefix', () => {
    expect(routes.view.websites()).toBe('websites')
    expect(routes.view.websites('my-dash')).toBe('websites/website/my-dash')
  })

  test('websites is a compound route prefix', () => {
    expect(isCompoundRoute('websites')).toBe(true)
    expect(isCompoundRoute('websites/website/my-dash')).toBe(true)
  })

  test('parses bare websites route (library grid, no auto-selected detail)', () => {
    expect(parseCompoundRoute('websites')).toEqual({ navigator: 'websites', details: null })
    const state = parseRouteToNavigationState('websites')
    expect(state).toEqual({ navigator: 'websites', details: null })
    expect(state && isWebsitesNavigation(state)).toBe(true)
  })

  test('parses website detail route', () => {
    expect(parseCompoundRoute('websites/website/my-dash')).toEqual({
      navigator: 'websites',
      details: { type: 'website', id: 'my-dash' },
    })
    expect(parseRouteToNavigationState('websites/website/my-dash')).toEqual({
      navigator: 'websites',
      details: { type: 'website', websiteSlug: 'my-dash' },
    })
  })

  test('rejects malformed websites routes', () => {
    expect(parseCompoundRoute('websites/unknown')).toBeNull()
    expect(parseCompoundRoute('websites/website')).toBeNull()
  })

  test('round-trips route ⇄ navigation state', () => {
    for (const route of ['websites', 'websites/website/my-dash'] as const) {
      const state = parseRouteToNavigationState(route)
      expect(state).not.toBeNull()
      expect(buildRouteFromNavigationState(state!)).toBe(route)
    }
  })

  test('buildCompoundRoute emits websites routes', () => {
    expect(buildCompoundRoute({ navigator: 'websites', details: null })).toBe('websites')
    expect(buildCompoundRoute({ navigator: 'websites', details: { type: 'website', id: 'x' } })).toBe('websites/website/x')
  })

  test('round-trips navigation state ⇄ panel key', () => {
    const grid: NavigationState = { navigator: 'websites', details: null }
    const detail: NavigationState = { navigator: 'websites', details: { type: 'website', websiteSlug: 'my-dash' } }
    expect(getNavigationStateKey(grid)).toBe('websites')
    expect(getNavigationStateKey(detail)).toBe('websites/website/my-dash')
    expect(parseNavigationStateKey('websites')).toEqual(grid)
    expect(parseNavigationStateKey('websites/website/my-dash')).toEqual(detail)
  })

  test('automations panel key round-trips (regression: id had a leading slash)', () => {
    const detail: NavigationState = {
      navigator: 'automations',
      details: { type: 'automation', automationId: 'auto-1' },
    }
    expect(parseNavigationStateKey(getNavigationStateKey(detail))).toEqual(detail)
  })
})
