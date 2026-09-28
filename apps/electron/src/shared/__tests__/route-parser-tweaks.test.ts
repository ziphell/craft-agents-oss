/**
 * Tweaks route round-trips: route string ⇄ NavigationState ⇄ panel key.
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
  isTweaksNavigation,
  type NavigationState,
} from '../types'
import { routes } from '../routes'

describe('tweaks routes', () => {
  test('route builders emit the tweaks prefix', () => {
    expect(routes.view.tweaks()).toBe('tweaks')
    expect(routes.view.tweaks('order-ids')).toBe('tweaks/tweak/order-ids')
  })

  test('tweaks is a compound route prefix', () => {
    expect(isCompoundRoute('tweaks')).toBe(true)
    expect(isCompoundRoute('tweaks/tweak/order-ids')).toBe(true)
  })

  test('parses bare tweaks route (library list, no auto-selected detail)', () => {
    expect(parseCompoundRoute('tweaks')).toEqual({ navigator: 'tweaks', details: null })
    const state = parseRouteToNavigationState('tweaks')
    expect(state).toEqual({ navigator: 'tweaks', details: null })
    expect(state && isTweaksNavigation(state)).toBe(true)
  })

  test('parses tweak detail route', () => {
    expect(parseCompoundRoute('tweaks/tweak/order-ids')).toEqual({
      navigator: 'tweaks',
      details: { type: 'tweak', id: 'order-ids' },
    })
    expect(parseRouteToNavigationState('tweaks/tweak/order-ids')).toEqual({
      navigator: 'tweaks',
      details: { type: 'tweak', tweakSlug: 'order-ids' },
    })
  })

  test('rejects malformed tweaks routes', () => {
    expect(parseCompoundRoute('tweaks/unknown')).toBeNull()
    expect(parseCompoundRoute('tweaks/tweak')).toBeNull()
  })

  test('round-trips route ⇄ navigation state', () => {
    for (const route of ['tweaks', 'tweaks/tweak/order-ids'] as const) {
      const state = parseRouteToNavigationState(route)
      expect(state).not.toBeNull()
      expect(buildRouteFromNavigationState(state!)).toBe(route)
    }
  })

  test('buildCompoundRoute emits tweaks routes', () => {
    expect(buildCompoundRoute({ navigator: 'tweaks', details: null })).toBe('tweaks')
    expect(buildCompoundRoute({ navigator: 'tweaks', details: { type: 'tweak', id: 'x' } })).toBe('tweaks/tweak/x')
  })

  test('round-trips navigation state ⇄ panel key', () => {
    const list: NavigationState = { navigator: 'tweaks', details: null }
    const detail: NavigationState = { navigator: 'tweaks', details: { type: 'tweak', tweakSlug: 'order-ids' } }
    expect(getNavigationStateKey(list)).toBe('tweaks')
    expect(getNavigationStateKey(detail)).toBe('tweaks/tweak/order-ids')
    expect(parseNavigationStateKey('tweaks')).toEqual(list)
    expect(parseNavigationStateKey('tweaks/tweak/order-ids')).toEqual(detail)
  })
})
