/**
 * Designs route round-trips: route string ⇄ NavigationState ⇄ panel key.
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
  isDesignsNavigation,
  type NavigationState,
} from '../types'
import { routes } from '../routes'

describe('designs routes', () => {
  test('route builders emit the designs prefix', () => {
    expect(routes.view.designs()).toBe('designs')
    expect(routes.view.designs('my-dash')).toBe('designs/design/my-dash')
  })

  test('designs is a compound route prefix', () => {
    expect(isCompoundRoute('designs')).toBe(true)
    expect(isCompoundRoute('designs/design/my-dash')).toBe(true)
  })

  test('parses bare designs route (library grid, no auto-selected detail)', () => {
    expect(parseCompoundRoute('designs')).toEqual({ navigator: 'designs', details: null })
    const state = parseRouteToNavigationState('designs')
    expect(state).toEqual({ navigator: 'designs', details: null })
    expect(state && isDesignsNavigation(state)).toBe(true)
  })

  test('parses design detail route', () => {
    expect(parseCompoundRoute('designs/design/my-dash')).toEqual({
      navigator: 'designs',
      details: { type: 'design', id: 'my-dash' },
    })
    expect(parseRouteToNavigationState('designs/design/my-dash')).toEqual({
      navigator: 'designs',
      details: { type: 'design', designSlug: 'my-dash' },
    })
  })

  test('rejects malformed designs routes', () => {
    expect(parseCompoundRoute('designs/unknown')).toBeNull()
    expect(parseCompoundRoute('designs/design')).toBeNull()
  })

  test('round-trips route ⇄ navigation state', () => {
    for (const route of ['designs', 'designs/design/my-dash'] as const) {
      const state = parseRouteToNavigationState(route)
      expect(state).not.toBeNull()
      expect(buildRouteFromNavigationState(state!)).toBe(route)
    }
  })

  test('buildCompoundRoute emits designs routes', () => {
    expect(buildCompoundRoute({ navigator: 'designs', details: null })).toBe('designs')
    expect(buildCompoundRoute({ navigator: 'designs', details: { type: 'design', id: 'x' } })).toBe('designs/design/x')
  })

  test('round-trips navigation state ⇄ panel key', () => {
    const grid: NavigationState = { navigator: 'designs', details: null }
    const detail: NavigationState = { navigator: 'designs', details: { type: 'design', designSlug: 'my-dash' } }
    expect(getNavigationStateKey(grid)).toBe('designs')
    expect(getNavigationStateKey(detail)).toBe('designs/design/my-dash')
    expect(parseNavigationStateKey('designs')).toEqual(grid)
    expect(parseNavigationStateKey('designs/design/my-dash')).toEqual(detail)
  })

  test('automations panel key round-trips (regression: id had a leading slash)', () => {
    const detail: NavigationState = {
      navigator: 'automations',
      details: { type: 'automation', automationId: 'auto-1' },
    }
    expect(parseNavigationStateKey(getNavigationStateKey(detail))).toEqual(detail)
  })
})
