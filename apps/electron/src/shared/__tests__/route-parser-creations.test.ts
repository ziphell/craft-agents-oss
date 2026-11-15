/**
 * Creations route round-trips: route string ⇄ NavigationState ⇄ panel key.
 *
 * The same six touchpoints a new navigator must thread through, and one that it must *not*: a
 * creation has no detail route, because a work is a file rather than something to drill into.
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
  isCreationsNavigation,
  type NavigationState,
} from '../types'
import { routes } from '../routes'

describe('creations routes', () => {
  test('the builder emits the creations prefix', () => {
    expect(routes.view.creations()).toBe('creations')
  })

  test('creations is a compound route prefix', () => {
    expect(isCompoundRoute('creations')).toBe(true)
  })

  test('parses the bare route into the library state', () => {
    expect(parseCompoundRoute('creations')).toEqual({ navigator: 'creations', details: null })
    const state = parseRouteToNavigationState('creations')
    expect(state).toEqual({ navigator: 'creations', details: null })
    expect(state && isCreationsNavigation(state)).toBe(true)
  })

  test('round-trips through navigation state', () => {
    const state: NavigationState = { navigator: 'creations', details: null }
    const route = buildRouteFromNavigationState(state)
    expect(route).toBe('creations')
    expect(parseRouteToNavigationState(route)).toEqual(state)
  })

  test('the panel key is stable', () => {
    expect(getNavigationStateKey({ navigator: 'creations', details: null })).toBe('creations')
    expect(parseNavigationStateKey('creations')).toEqual({ navigator: 'creations', details: null })
  })

  test('a tail is not a route into the library', () => {
    // There is no `creations/<id>`: opening a work opens its file, not a detail screen.
    expect(parseCompoundRoute('creations/thing/1')).toBeNull()
    expect(buildCompoundRoute({ navigator: 'creations', details: null })).toBe('creations')
  })
})
