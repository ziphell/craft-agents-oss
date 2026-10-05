import { describe, it, expect } from 'bun:test'
import { homedir } from 'os'
import { join } from 'path'
import { expandPath } from '../paths'

describe('expandPath', () => {
  it('expands a bare ~ to home', () => {
    expect(expandPath('~')).toBe(homedir())
  })

  it('expands ~/ to home', () => {
    expect(expandPath('~/.craft-agent/workspaces')).toBe(join(homedir(), '.craft-agent', 'workspaces'))
  })

  it('expands ~\\ (a normalized portable path) to home, not against cwd', () => {
    // `path.normalize('~/x')` yields `~\x` on Windows. Recognizing only `~/` let
    // this fall through to the relative branch and resolve it against the process
    // cwd — which is how a literal `~` folder appeared in the working directory.
    const expanded = expandPath('~\\.craft-agent\\workspaces')
    expect(expanded.startsWith(homedir())).toBe(true)
    expect(expanded).toContain('.craft-agent')
  })
})
