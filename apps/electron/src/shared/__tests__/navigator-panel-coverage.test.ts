/**
 * Every navigator must have a panel branch.
 *
 * A navigator can ship with everything but one thing: the route parses, the sidebar item renders,
 * and the content panel has **no branch for it** — so clicking it falls through to the sessions
 * fallback and shows an empty chat. The navigator "exists" everywhere except where the person is
 * looking.
 *
 * This is a text check rather than a render, deliberately: the panel is one 500-line component with
 * a chain of early returns, and a missing link in that chain produces no type error and no runtime
 * error — only a view that quietly shows somebody else's screen. Reading the file is the cheapest
 * thing that fails when that link is missing.
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const PANEL = join(import.meta.dir, '../../renderer/components/app-shell/MainContentPanel.tsx')

/** `NavigatorType`, spelled the way the predicate for each one is named. */
const NAVIGATORS = [
  'sessions',
  'sources',
  'skills',
  'automations',
  'projects',
  'tweaks',
  'creations',
  'bot',
  'settings',
] as const

describe('the content panel knows every navigator', () => {
  const source = readFileSync(PANEL, 'utf8')

  for (const navigator of NAVIGATORS) {
    const predicate = `is${navigator[0]!.toUpperCase()}${navigator.slice(1)}Navigation(navState)`
    test(`has a branch for ${navigator}`, () => {
      expect(source).toContain(predicate)
    })
  }
})
