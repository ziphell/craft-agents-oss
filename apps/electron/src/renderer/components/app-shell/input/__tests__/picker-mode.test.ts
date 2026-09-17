/**
 * Truth table for `derivePickerMode`. The helper is small but its behavior
 * has been wrong before (issue #727 was a precedence ordering bug) — pinning
 * each row of the matrix here so future renames / reshufflings can't
 * silently regress to the trapped state.
 */

import { describe, test, expect } from 'bun:test'
import { derivePickerMode, type PickerModeInput } from '../picker-mode'

function input(overrides: Partial<PickerModeInput> = {}): PickerModeInput {
  return {
    connectionUnavailable: false,
    connectionDefaultModel: null,
    connectionCount: 1,
    ...overrides,
  }
}

describe('derivePickerMode', () => {
  // -------------------------------------------------------------------------
  // Precedence: unavailable wins
  // -------------------------------------------------------------------------

  test('connectionUnavailable beats every other flag', () => {
    expect(
      derivePickerMode(
        input({
          connectionUnavailable: true,
          connectionDefaultModel: 'mistral-7b',
          connectionCount: 5,
        }),
      ),
    ).toBe('unavailable')
  })

  // -------------------------------------------------------------------------
  // The #727 regression: switcher must win over locked-single
  // -------------------------------------------------------------------------

  test('≥2 connections + single-model pi_compat default → switcher (#727)', () => {
    expect(
      derivePickerMode(
        input({
          connectionDefaultModel: 'mistral-7b',
          connectionCount: 2,
        }),
      ),
    ).toBe('switcher')
  })

  test('many connections + single-model pi_compat default → switcher', () => {
    expect(
      derivePickerMode(
        input({
          connectionDefaultModel: 'llama3',
          connectionCount: 7,
        }),
      ),
    ).toBe('switcher')
  })

  test('≥2 connections + multi-model default → switcher', () => {
    expect(
      derivePickerMode(
        input({
          connectionDefaultModel: null,
          connectionCount: 3,
        }),
      ),
    ).toBe('switcher')
  })

  // -------------------------------------------------------------------------
  // Mid-session switching: the switcher is NOT gated on an empty session, so a
  // conversation that already has messages can still move to another
  // connection's models (the pin only blocks implicit rewrites).
  // -------------------------------------------------------------------------

  test('switcher is offered regardless of session state (only depends on connection count)', () => {
    expect(derivePickerMode(input({ connectionCount: 5 }))).toBe('switcher')
    expect(derivePickerMode(input({ connectionCount: 2, connectionDefaultModel: 'mistral-7b' }))).toBe('switcher')
  })

  // -------------------------------------------------------------------------
  // locked-single: single-model pi_compat connection and nothing else to pick
  // -------------------------------------------------------------------------

  test('only 1 connection + single-model pi_compat default → locked-single (no switcher possible)', () => {
    // No other connection to switch to, so the picker stays in the disabled
    // single-row UI. That's correct.
    expect(
      derivePickerMode(
        input({
          connectionDefaultModel: 'mistral-7b',
          connectionCount: 1,
        }),
      ),
    ).toBe('locked-single')
  })

  // -------------------------------------------------------------------------
  // Flat list: the unremarkable "list models for the active connection" case
  // -------------------------------------------------------------------------

  test('only 1 multi-model connection → flat', () => {
    expect(
      derivePickerMode(
        input({
          connectionDefaultModel: null,
          connectionCount: 1,
        }),
      ),
    ).toBe('flat')
  })

  // -------------------------------------------------------------------------
  // Boundary: connectionCount > 1 vs == 1
  // -------------------------------------------------------------------------

  test('connectionCount=2 triggers switcher (lower bound for >1)', () => {
    expect(
      derivePickerMode(input({ connectionDefaultModel: 'm', connectionCount: 2 })),
    ).toBe('switcher')
  })

  test('connectionCount=1 never triggers switcher', () => {
    expect(
      derivePickerMode(input({ connectionDefaultModel: 'm', connectionCount: 1 })),
    ).toBe('locked-single')
  })

  // -------------------------------------------------------------------------
  // connectionCount=0 — defensive: should never panic, falls through to flat
  // -------------------------------------------------------------------------

  test('connectionCount=0 (no connections configured) → flat (defensive fallthrough)', () => {
    expect(
      derivePickerMode(
        input({ connectionDefaultModel: null, connectionCount: 0 }),
      ),
    ).toBe('flat')
  })
})
