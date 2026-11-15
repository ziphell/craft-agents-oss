import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { joinProjectPath, recordPathFor, toPosix } from '../paths.ts'
import { generationOf, newestFirst, relatedOf, searchGenerations, sourcesOf, usedBy } from '../graph.ts'
import { readGenerationRecords, writeGenerationRecord } from '../storage.ts'
import type { GenerationRecord } from '../types.ts'

const record = (file: string, overrides: Partial<GenerationRecord> = {}): GenerationRecord => ({
  file,
  prompt: '',
  references: [],
  at: 0,
  ...overrides,
})

describe('a note sits beside its file', () => {
  test('the extension becomes .gen.json, in the same folder', () => {
    expect(recordPathFor('canvas/assets/x.png')).toBe('canvas/assets/x.gen.json')
    expect(recordPathFor('x.mp4')).toBe('x.gen.json')
  })

  test('a name without an extension is kept whole', () => {
    expect(recordPathFor('canvas/assets/plate')).toBe('canvas/assets/plate.gen.json')
  })

  test('windows separators keep their shape', () => {
    expect(recordPathFor('C:\\p\\canvas\\assets\\x.png')).toBe('C:\\p\\canvas\\assets\\x.gen.json')
  })

  test('paths are compared front-slash to front-slash', () => {
    expect(toPosix('canvas\\assets\\x.png')).toBe('canvas/assets/x.png')
    expect(toPosix('./canvas/assets/x.png')).toBe('canvas/assets/x.png')
  })

  test('a record path turns back into the file it names', () => {
    expect(joinProjectPath('C:\\p\\project', 'canvas/assets/x.png')).toBe(
      'C:\\p\\project/canvas/assets/x.png',
    )
    expect(joinProjectPath('/p/project/', 'canvas/assets/x.png')).toBe(
      '/p/project/canvas/assets/x.png',
    )
  })
})

describe('the lineage is read off the notes', () => {
  const plate = record('canvas/assets/plate.png', { prompt: '一只纸船', at: 1 })
  const vessel = record('canvas/assets/vessel.png', {
    prompt: '纸船在湖上',
    references: ['canvas/assets/plate.png'],
    at: 2,
  })
  const clip = record('canvas/assets/clip.mp4', {
    prompt: '纸船漂动',
    references: ['canvas/assets/vessel.png'],
    at: 3,
  })
  const records = [vessel, clip, plate]

  test('what a file was built from', () => {
    expect(sourcesOf(records, 'canvas/assets/vessel.png')).toEqual(['canvas/assets/plate.png'])
    expect(sourcesOf(records, 'canvas/assets/plate.png')).toEqual([])
  })

  test('what was built from it — one hop, oldest first', () => {
    expect(usedBy(records, 'canvas/assets/plate.png').map((item) => item.file)).toEqual([
      'canvas/assets/vessel.png',
    ])
    expect(usedBy(records, 'canvas/assets/vessel.png').map((item) => item.file)).toEqual([
      'canvas/assets/clip.mp4',
    ])
    expect(usedBy(records, 'canvas/assets/clip.mp4')).toEqual([])
  })

  test('a path spelled with backslashes still matches', () => {
    const windows = record('canvas/assets/other.png', {
      references: ['canvas\\assets\\plate.png'],
      at: 4,
    })
    expect(usedBy([...records, windows], 'canvas/assets/plate.png')).toHaveLength(2)
  })

  test('newest first, and a tie keeps a stable order', () => {
    expect(newestFirst(records).map((item) => item.file)).toEqual([
      'canvas/assets/clip.mp4',
      'canvas/assets/vessel.png',
      'canvas/assets/plate.png',
    ])
    const tied = [record('b.png', { at: 5 }), record('a.png', { at: 5 })]
    expect(newestFirst(tied).map((item) => item.file)).toEqual(['a.png', 'b.png'])
  })

  test('a file nobody generated has no record', () => {
    expect(generationOf(records, 'canvas/assets/upload.png')).toBeNull()
  })

  test('several hops out, nearest first, with the hop counted', () => {
    const line = relatedOf(records, 'canvas/assets/vessel.png', 5)
    expect(line.upstream.map((node) => [node.file, node.depth])).toEqual([
      ['canvas/assets/plate.png', 1],
    ])
    expect(line.downstream.map((node) => [node.file, node.depth])).toEqual([
      ['canvas/assets/clip.mp4', 1],
    ])
    expect(line.upstream[0]!.record?.prompt).toBe('一只纸船')
  })

  test('the walk stops at the depth it is given', () => {
    expect(relatedOf(records, 'canvas/assets/plate.png', 1).downstream.map((node) => node.file)).toEqual([
      'canvas/assets/vessel.png',
    ])
    expect(relatedOf(records, 'canvas/assets/plate.png', 2).downstream.map((node) => node.file)).toEqual([
      'canvas/assets/vessel.png',
      'canvas/assets/clip.mp4',
    ])
  })

  test('a cycle comes back to where it started exactly once, then stops', () => {
    const looped = [
      record('a.png', { references: ['b.png'], at: 1 }),
      record('b.png', { references: ['a.png'], at: 2 }),
    ]
    const line = relatedOf(looped, 'a.png', 10)
    expect(line.upstream.map((node) => node.file)).toEqual(['b.png'])
    expect(line.downstream.map((node) => node.file)).toEqual(['b.png'])
  })
})

describe('finding a row', () => {
  const rows = [
    record('canvas/assets/plate.png', { prompt: '一只纸船', channel: '中转', at: 3 }),
    record('canvas/assets/vessel.png', { prompt: 'Paper boat on a lake', model: 'gpt-image', at: 2 }),
    record('canvas/assets/clip.mp4', { prompt: '漂动', at: 1 }),
  ]

  test('an empty query is the timeline, untouched', () => {
    expect(searchGenerations(rows, '   ')).toEqual(rows)
  })

  test('the prompt is searched, case-insensitively', () => {
    expect(searchGenerations(rows, 'PAPER').map((row) => row.file)).toEqual(['canvas/assets/vessel.png'])
    expect(searchGenerations(rows, '纸船').map((row) => row.file)).toEqual(['canvas/assets/plate.png'])
  })

  test('the file name, the channel and the model are searched too', () => {
    expect(searchGenerations(rows, 'clip').map((row) => row.file)).toEqual(['canvas/assets/clip.mp4'])
    expect(searchGenerations(rows, '中转').map((row) => row.file)).toEqual(['canvas/assets/plate.png'])
    expect(searchGenerations(rows, 'gpt-image').map((row) => row.file)).toEqual(['canvas/assets/vessel.png'])
  })

  test('matches keep the order they came in', () => {
    expect(searchGenerations(rows, 'canvas/').map((row) => row.file)).toEqual([
      'canvas/assets/plate.png',
      'canvas/assets/vessel.png',
      'canvas/assets/clip.mp4',
    ])
  })

  test('no match is an empty list, not everything', () => {
    expect(searchGenerations(rows, '没有这个东西')).toEqual([])
  })
})

describe('reading a project folder', () => {
  test('every note is listed, and a note whose file is gone is not', () => {
    const project = mkdtempSync(join(tmpdir(), 'provenance-'))
    const assets = join(project, 'canvas', 'assets')
    mkdirSync(assets, { recursive: true })
    writeFileSync(join(assets, 'kept.png'), 'x')
    writeFileSync(join(assets, 'gone.png'), 'x')

    writeGenerationRecord(join(assets, 'kept.png'), record('canvas/assets/kept.png', { prompt: '留着', at: 2 }))
    writeGenerationRecord(join(assets, 'gone.png'), record('canvas/assets/gone.png', { prompt: '删了', at: 1 }))
    unlinkSync(join(assets, 'gone.png'))
    writeFileSync(join(project, 'canvas', 'board.canvas.json'), '{}')

    const found = readGenerationRecords(project)
    expect(found.map((item) => item.file)).toEqual(['canvas/assets/kept.png'])
    expect(found[0]!.prompt).toBe('留着')
  })

  test('a note that cannot be parsed is skipped, not thrown', () => {
    const project = mkdtempSync(join(tmpdir(), 'provenance-'))
    writeFileSync(join(project, 'broken.gen.json'), '{ nope')
    expect(readGenerationRecords(project)).toEqual([])
  })
})
