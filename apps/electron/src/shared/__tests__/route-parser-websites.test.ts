/**
 * Websites route round-trips: route string ⇄ NavigationState ⇄ panel key.
 *
 * A website has no second-level page — the library grid is the whole navigator —
 * so there is exactly one websites route and no detail segment to parse.
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
  test('route builder emits the websites prefix', () => {
    expect(routes.view.websites()).toBe('websites')
  })

  test('websites is a compound route prefix', () => {
    expect(isCompoundRoute('websites')).toBe(true)
  })

  test('parses the bare websites route (library grid)', () => {
    expect(parseCompoundRoute('websites')).toEqual({ navigator: 'websites', details: null })
    const state = parseRouteToNavigationState('websites')
    expect(state).toEqual({ navigator: 'websites' })
    expect(state && isWebsitesNavigation(state)).toBe(true)
  })

  test('rejects the removed website detail route', () => {
    expect(parseCompoundRoute('websites/website/my-dash')).toBeNull()
    expect(parseCompoundRoute('websites/unknown')).toBeNull()
  })

  test('round-trips route ⇄ navigation state', () => {
    const state = parseRouteToNavigationState('websites')
    expect(state).not.toBeNull()
    expect(buildRouteFromNavigationState(state!)).toBe('websites')
  })

  test('buildCompoundRoute emits the websites route', () => {
    expect(buildCompoundRoute({ navigator: 'websites', details: null })).toBe('websites')
  })

  test('round-trips navigation state ⇄ panel key', () => {
    const grid: NavigationState = { navigator: 'websites' }
    expect(getNavigationStateKey(grid)).toBe('websites')
    expect(parseNavigationStateKey('websites')).toEqual(grid)
  })

  test('automations panel key round-trips (regression: id had a leading slash)', () => {
    const detail: NavigationState = {
      navigator: 'automations',
      details: { type: 'automation', automationId: 'auto-1' },
    }
    expect(parseNavigationStateKey(getNavigationStateKey(detail))).toEqual(detail)
  })
})
