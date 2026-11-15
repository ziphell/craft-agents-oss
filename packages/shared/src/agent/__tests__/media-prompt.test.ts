import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolvePrompt } from '../media-commands.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'craft-prompt-'))
  writeFileSync(join(dir, 'brief.md'), 'line one\nline two\n')
  writeFileSync(join(dir, 'shot.md'), 'close-up, dusk\n')
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('media prompt values', () => {
  it('reads a file and appends an inline direction, in the order they were written', () => {
    expect(resolvePrompt(['@brief.md', 'cinematic lighting'], dir)).toEqual({
      prompt: 'line one\nline two\n\ncinematic lighting',
    })
  })

  it('joins two files and keeps the order', () => {
    expect(resolvePrompt(['@brief.md', '@shot.md'], dir)).toEqual({
      prompt: 'line one\nline two\n\nclose-up, dusk',
    })
  })

  it('keeps an inline prompt as it was given', () => {
    expect(resolvePrompt(['a lighthouse'], dir)).toEqual({ prompt: 'a lighthouse' })
  })

  it('names a prompt file that is not there', () => {
    const result = resolvePrompt(['@missing.md'], dir)
    expect('error' in result && result.error).toContain('Cannot read the prompt file')
  })

  it('refuses an empty prompt', () => {
    expect('error' in resolvePrompt([], dir)).toBe(true)
    expect('error' in resolvePrompt(['   '], dir)).toBe(true)
  })
})
