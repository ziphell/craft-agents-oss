/**
 * What a playbook's steps aim at, and the record of what a run found.
 *
 * No browser and no filesystem beyond one temp directory: what is worth pinning is that the
 * marker is read out of a line the way a person writes it (inside a markdown comment), and that
 * the record keeps the old time — the one thing that tells "stopped matching" from "never
 * matched".
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  parseAnchors,
  parseSkillHits,
  readSkillHits,
  recordSkillHits,
  writeSkillHits,
  type SkillHits,
} from '../index'

describe('the anchors a skill body declares', () => {
  it('reads a selector out of the comment a step carries', () => {
    const body = [
      '# Weekly export',
      '',
      '1. Open the orders list. <!-- @anchor .orders -->',
      '2. Press Export. <!-- @anchor .toolbar .export -->',
      '3. Confirm. <!-- @anchor [data-testid="confirm"] -->',
    ].join('\n')

    expect(parseAnchors(body)).toEqual(['.orders', '.toolbar .export', '[data-testid="confirm"]'])
  })

  it('is not fooled by prose or by a note to self', () => {
    const body = [
      'not-a-@anchor-marker is prose and a selector read out of it would be invented',
      'A step. <!-- @anchor -->',
      'Another. <!-- @anchor TBD -->',
      'A third. <!-- @anchor .real -->',
    ].join('\n')

    expect(parseAnchors(body)).toEqual(['.real'])
  })

  it('keeps the order and drops a repeat', () => {
    const body = 'a <!-- @anchor .x -->\nb <!-- @anchor .y -->\nc <!-- @anchor .x -->'

    expect(parseAnchors(body)).toEqual(['.x', '.y'])
  })

  it('declaring nothing is allowed — the playbook is simply not checked', () => {
    expect(parseAnchors('# A skill with steps and no targets\n1. Do the thing.')).toEqual([])
  })
})

describe('a skill\'s hit record', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'craft-skill-hits-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('gives a time to what matched and keeps the old time for what did not', () => {
    const first = recordSkillHits(null, ['.a', '.b'], new Set(['.a', '.b']), 'https://x/one', 1000)
    expect(first.targets).toEqual([
      { selector: '.a', lastMatchedAt: 1000, lastMatchedUrl: 'https://x/one' },
      { selector: '.b', lastMatchedAt: 1000, lastMatchedUrl: 'https://x/one' },
    ])

    // A later run where only `.a` is still there: the page moved, and `.b` says so by holding
    // the time it used to have.
    const second = recordSkillHits(first, ['.a', '.b'], new Set(['.a']), 'https://x/two', 2000)
    expect(second.targets).toEqual([
      { selector: '.a', lastMatchedAt: 2000, lastMatchedUrl: 'https://x/two' },
      { selector: '.b', lastMatchedAt: 1000, lastMatchedUrl: 'https://x/one' },
    ])
  })

  it('records each anchor on the page its own step ran on', () => {
    // A playbook whose steps cross pages: the second anchor lives on a page the run has already
    // left, and recording the page it ended on would be a fact nobody observed.
    const hits = recordSkillHits(
      null,
      ['#home-search', '#results'],
      new Map([
        ['#home-search', 'https://x/home'],
        ['#results', 'https://x/results'],
      ]),
      'https://x/end', // where the run stopped — not where either anchor was found
      1000,
    )

    expect(hits.targets).toEqual([
      { selector: '#home-search', lastMatchedAt: 1000, lastMatchedUrl: 'https://x/home' },
      { selector: '#results', lastMatchedAt: 1000, lastMatchedUrl: 'https://x/results' },
    ])
  })

  it('reads a map entry with no url — and an anchor the map never mentions — as not found', () => {
    const before = recordSkillHits(null, ['#a', '#b', '#c'], new Set(['#a', '#b', '#c']), 'https://x/one', 1000)
    const after = recordSkillHits(
      before,
      ['#a', '#b', '#c'],
      new Map([
        ['#a', 'https://x/two'], // found, on its own page
        ['#b', ''], // looked for here and not there
        // '#c' is not in the map at all — the run never got to its page
      ]),
      'https://x/end',
      2000,
    )

    expect(after.targets).toEqual([
      { selector: '#a', lastMatchedAt: 2000, lastMatchedUrl: 'https://x/two' },
      { selector: '#b', lastMatchedAt: 1000, lastMatchedUrl: 'https://x/one' },
      { selector: '#c', lastMatchedAt: 1000, lastMatchedUrl: 'https://x/one' },
    ])
  })

  it('says nothing rather than failing when the record is damaged', () => {
    expect(parseSkillHits('not json')).toBeNull()
    expect(parseSkillHits('{"targets": "not an array"}')).toBeNull()
    expect(parseSkillHits('{"schemaVersion":1,"updatedAt":1,"targets":[]}')).toEqual({
      schemaVersion: 1,
      updatedAt: 1,
      targets: [],
    })
  })

  it('round-trips through the file beside the skill', () => {
    const path = join(dir, 'hits.json')
    expect(readSkillHits(path)).toBeNull()

    const hits: SkillHits = recordSkillHits(null, ['.a'], new Set(['.a']), 'https://x/', 7)
    writeSkillHits(path, hits)

    expect(readSkillHits(path)).toEqual(hits)
    expect(JSON.parse(readFileSync(path, 'utf-8')).updatedAt).toBe(7)
  })
})
