/**
 * Artifacts route round-trips: route string ⇄ NavigationState ⇄ panel key.
 * Guards the six touchpoints a new navigator must thread through
 * (prefix list, parse, build, convert, key serialization, type guard) — and, unlike
 * the others, the encoding: an artifact's id is a path with slashes of its own, so a
 * route that did not encode it would parse back as a prefix of itself.
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
  isArtifactsNavigation,
  type NavigationState,
} from '../types'
import { routes } from '../routes'

describe('artifacts routes', () => {
  test('route builders emit the artifacts prefix', () => {
    expect(routes.view.artifacts()).toBe('artifacts')
    expect(routes.view.artifacts('diagrams/flow.drawio')).toBe('artifacts/artifact/diagrams%2Fflow.drawio')
  })

  test('artifacts is a compound route prefix', () => {
    expect(isCompoundRoute('artifacts')).toBe(true)
    expect(isCompoundRoute('artifacts/artifact/diagrams%2Fflow.drawio')).toBe(true)
  })

  test('parses bare artifacts route (library list, no auto-selected detail)', () => {
    expect(parseCompoundRoute('artifacts')).toEqual({ navigator: 'artifacts', details: null })
    const state = parseRouteToNavigationState('artifacts')
    expect(state).toEqual({ navigator: 'artifacts', details: null })
    expect(state && isArtifactsNavigation(state)).toBe(true)
  })

  test('parses artifact detail route, decoding the path', () => {
    expect(parseCompoundRoute('artifacts/artifact/diagrams%2Fflow.drawio')).toEqual({
      navigator: 'artifacts',
      details: { type: 'artifact', id: 'diagrams/flow.drawio' },
    })
    expect(parseRouteToNavigationState('artifacts/artifact/diagrams%2Fflow.drawio')).toEqual({
      navigator: 'artifacts',
      details: { type: 'artifact', id: 'diagrams/flow.drawio' },
    })
  })

  test('rejects malformed artifacts routes', () => {
    expect(parseCompoundRoute('artifacts/unknown')).toBeNull()
    expect(parseCompoundRoute('artifacts/artifact')).toBeNull()
  })

  test('round-trips route ⇄ navigation state', () => {
    for (const route of ['artifacts', 'artifacts/artifact/diagrams%2Fflow.drawio'] as const) {
      const state = parseRouteToNavigationState(route)
      expect(state).not.toBeNull()
      expect(buildRouteFromNavigationState(state!)).toBe(route)
    }
  })

  test('buildCompoundRoute emits artifacts routes', () => {
    expect(buildCompoundRoute({ navigator: 'artifacts', details: null })).toBe('artifacts')
    expect(buildCompoundRoute({ navigator: 'artifacts', details: { type: 'artifact', id: 'diagrams/flow.drawio' } }))
      .toBe('artifacts/artifact/diagrams%2Fflow.drawio')
  })

  test('round-trips navigation state ⇄ panel key', () => {
    const list: NavigationState = { navigator: 'artifacts', details: null }
    const detail: NavigationState = {
      navigator: 'artifacts',
      details: { type: 'artifact', id: 'diagrams/flow.drawio' },
    }
    expect(getNavigationStateKey(list)).toBe('artifacts')
    expect(getNavigationStateKey(detail)).toBe('artifacts/artifact/diagrams%2Fflow.drawio')
    expect(parseNavigationStateKey('artifacts')).toEqual(list)
    expect(parseNavigationStateKey('artifacts/artifact/diagrams%2Fflow.drawio')).toEqual(detail)
  })
})
