import { describe, expect, test } from 'bun:test'
import {
  applyCanvasOps,
  boundsOf,
  CANVAS_LIMITS,
  CanvasOpError,
  createCanvasDoc,
  parseCanvasDoc,
  serializeCanvasDoc,
  type CanvasDoc,
  type CanvasNode,
} from '../document.ts'

const image = (id: string, x = 0, y = 0, w = 100, h = 100): CanvasNode => ({
  id,
  type: 'image',
  src: `generations/${id}.png`,
  x,
  y,
  w,
  h,
  z: 0,
})

const text = (id: string, x = 0, y = 0): CanvasNode => ({
  id,
  type: 'text',
  src: `docs/nodes/${id}.md`,
  x,
  y,
  w: 200,
  h: 60,
  z: 0,
})

const video = (id: string, x = 0, y = 0): CanvasNode => ({
  id,
  type: 'video',
  x,
  y,
  w: 160,
  h: 90,
  z: 0,
})

const doc = (nodes: CanvasNode[] = []): CanvasDoc => ({ ...createCanvasDoc('测试'), nodes })

describe('applyCanvasOps', () => {
  test('a batch applies in order and answers what it touched', () => {
    const { doc: next, results } = applyCanvasOps(doc(), [
      { type: 'add_node', node: image('a', 10, 20) },
      { type: 'move_nodes', ids: ['a'], dx: 5, dy: -5 },
    ])
    expect(next.nodes).toHaveLength(1)
    expect(next.nodes[0]!).toMatchObject({ x: 15, y: 15 })
    expect(results.map((result) => result.type)).toEqual(['add_node', 'move_nodes'])
  })

  test('the first refusal throws and nothing is applied — no half batch', () => {
    const before = doc([image('a')])
    expect(() =>
      applyCanvasOps(before, [
        { type: 'move_nodes', ids: ['a'], dx: 10, dy: 10 },
        { type: 'remove_nodes', ids: ['missing'] },
      ]),
    ).toThrow(CanvasOpError)
    // The caller's document is untouched: apply works on a copy.
    expect(before.nodes[0]!).toMatchObject({ x: 0, y: 0 })
  })

  test('a refusal names the operation index and its type', () => {
    try {
      applyCanvasOps(doc(), [
        { type: 'add_node', node: image('a') },
        { type: 'set_node', id: 'a', patch: { w: 1 } },
      ])
      throw new Error('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(CanvasOpError)
      expect((error as CanvasOpError).index).toBe(1)
      expect((error as CanvasOpError).opType).toBe('set_node')
      expect((error as CanvasOpError).message).toContain('8–20000')
    }
  })

  test('a version-2 `locked` flag is dropped on read, so an old file is never frozen', () => {
    const v2 = {
      ...doc(),
      version: 2,
      nodes: [{ ...image('a'), locked: true }],
    }
    const parsed = parseCanvasDoc(JSON.stringify(v2))
    expect(parsed.nodes[0]).not.toHaveProperty('locked')
    expect(applyCanvasOps(parsed, [{ type: 'move_nodes', ids: ['a'], dx: 4, dy: 4 }]).doc.nodes[0]!.x).toBe(4)
  })

  test('align uses the selection box', () => {
    const base = doc([image('a', 0, 0, 100, 100), image('b', 300, 50, 100, 100)])
    const bySelection = applyCanvasOps(base, [{ type: 'align', ids: ['a', 'b'], edge: 'left' }]).doc
    expect(bySelection.nodes.map((node) => node.x)).toEqual([0, 0])

    const centered = applyCanvasOps(base, [{ type: 'align', ids: ['a', 'b'], edge: 'hcenter' }]).doc
    // selection spans 0..400; its center is 200, so both nodes sit at 150
    expect(centered.nodes.map((node) => node.x)).toEqual([150, 150])
  })

  test('distribute keeps the ends and evens the gaps', () => {
    const base = doc([image('a', 0, 0, 100, 10), image('b', 150, 0, 100, 10), image('c', 500, 0, 100, 10)])
    const out = applyCanvasOps(base, [{ type: 'distribute', ids: ['a', 'b', 'c'], axis: 'x' }]).doc
    expect(out.nodes.map((node) => node.x)).toEqual([0, 250, 500])
  })

  test('group stamps one id on its members and ungroup takes it away', () => {
    const grouped = applyCanvasOps(doc([image('a'), image('b')]), [{ type: 'group', ids: ['a', 'b'] }]).doc
    const groupId = grouped.nodes[0]!.groupId
    expect(groupId).toBeTruthy()
    expect(grouped.nodes[1]!.groupId).toBe(groupId)
    const ungrouped = applyCanvasOps(grouped, [{ type: 'ungroup', ids: ['a', 'b'] }]).doc
    expect(ungrouped.nodes.every((node) => node.groupId === undefined)).toBe(true)
  })

  test('z-order: front is above everything currently on the board', () => {
    const base = doc([image('a'), image('b'), image('c')])
    const withZ = base.nodes.map((node, index) => ({ ...node, z: index }))
    const front = applyCanvasOps({ ...base, nodes: withZ }, [{ type: 'bring_to_front', ids: ['a'] }]).doc
    expect(Math.max(...front.nodes.map((node) => node.z))).toBe(front.nodes.find((node) => node.id === 'a')!.z)
    const back = applyCanvasOps({ ...base, nodes: withZ }, [{ type: 'send_to_back', ids: ['c'] }]).doc
    expect(Math.min(...back.nodes.map((node) => node.z))).toBe(back.nodes.find((node) => node.id === 'c')!.z)
  })

  test('duplicate copies geometry and ids never collide', () => {
    const base = doc([image('a', 10, 10)])
    const { doc: out, results } = applyCanvasOps(base, [{ type: 'duplicate', ids: ['a'] }])
    expect(out.nodes).toHaveLength(2)
    const copy = out.nodes[1]!
    expect(copy!.x).toBe(34)
    expect(copy!.id).not.toBe('a')
    expect(results[0]!.ids).toEqual([copy!.id])
  })

  test('the viewport is clamped to the range the view uses', () => {
    expect(() => applyCanvasOps(doc(), [{ type: 'set_viewport', viewport: { scale: 9 } }])).toThrow(/0.05–4/)
    expect(applyCanvasOps(doc(), [{ type: 'set_viewport', viewport: { scale: 0.5, x: 12 } }]).doc.viewport).toEqual({
      x: 12,
      y: 0,
      scale: 0.5,
    })
  })

  test('a batch is capped, and so is what a canvas holds', () => {
    const many = doc(Array.from({ length: CANVAS_LIMITS.nodes }, (_, index) => image(`n${index}`)))
    expect(() => applyCanvasOps(many, [{ type: 'add_node', node: image('one-more') }])).toThrow(/at most 400/)
    expect(() =>
      applyCanvasOps(doc(), Array.from({ length: CANVAS_LIMITS.opsPerBatch + 1 }, (_, index) => ({
        type: 'add_node' as const,
        node: image(`x${index}`),
      }))),
    ).toThrow(/at most 50/)
  })

  test('boundsOf is the box the align operations use', () => {
    expect(boundsOf([image('a', 10, 10, 50, 50), image('b', 100, 30, 20, 20)])).toEqual({
      left: 10,
      top: 10,
      right: 120,
      bottom: 60,
      width: 110,
      height: 50,
    })
    expect(boundsOf([])).toBeNull()
  })
})

describe('the file format', () => {
  test('round-trips, and refuses a version it does not understand', () => {
    const original = applyCanvasOps(doc(), [{ type: 'add_node', node: image('a') }]).doc
    const parsed = parseCanvasDoc(serializeCanvasDoc(original))
    expect(parsed).toEqual(original)

    expect(() => parseCanvasDoc(JSON.stringify({ ...original, version: 99 }))).toThrow(/version 99/)
    expect(() => parseCanvasDoc('not json')).toThrow(/not JSON/)
    expect(() => parseCanvasDoc(JSON.stringify({ ...original, viewport: undefined }))).toThrow(/viewport/)
  })

  test('serialization is stable enough to diff two revisions by eye', () => {
    const text = serializeCanvasDoc(doc([image('a')]))
    expect(text.startsWith('{\n  "version": 3,')).toBe(true)
    expect(text.endsWith('\n')).toBe(true)
  })

  test('a version-1 document is read as version 3, keeping its nodes', () => {
    const v1 = { ...doc([image('a')]), version: 1 }
    const parsed = parseCanvasDoc(JSON.stringify(v1))
    expect(parsed.version).toBe(3)
    expect(parsed.nodes.map((node) => node.id)).toEqual(['a'])
  })

  test('a version-2 recipe becomes edges, once, and the fields it used to hold are gone', () => {
    const v2 = {
      ...doc([text('t'), image('i'), image('f'), image('l'), image('out')]),
      version: 2,
      nodes: [
        text('t'),
        image('i'),
        image('f'),
        image('l'),
        {
          ...image('out'),
          recipe: { op: 'video-gen', promptNodes: ['t'], inputs: ['i'], firstFrame: 'f', lastFrame: 'l' },
        },
      ],
    }
    const parsed = parseCanvasDoc(JSON.stringify(v2))
    expect(parsed.version).toBe(3)
    expect(parsed.edges.map((edge) => [edge.from, edge.to, edge.role])).toEqual([
      ['f', 'out', 'first-frame'],
      ['l', 'out', 'last-frame'],
      ['i', 'out', 'reference'],
      ['t', 'out', 'prompt'],
    ])
    expect(parsed.nodes.find((node) => node.id === 'out')!.recipe).toEqual({ op: 'video-gen' })
    // Reading is not destructive: a second read of the same bytes gives the same edges.
    expect(parseCanvasDoc(JSON.stringify(v2)).edges.map((edge) => edge.id)).toEqual(parsed.edges.map((edge) => edge.id))
  })

  test('a version-2 relation pointing at a node that is gone is dropped, not kept dead', () => {
    const v2 = {
      ...doc(),
      version: 2,
      nodes: [{ ...image('out'), recipe: { op: 'image-gen', inputs: ['ghost'] } }],
    }
    expect(parseCanvasDoc(JSON.stringify(v2)).edges).toEqual([])
  })

  test("a title is the node's own: it survives a change of file, and is bounded", () => {
    const named = applyCanvasOps(doc(), [
      { type: 'add_node', node: { ...image('a'), title: '主视觉' } },
    ]).doc
    expect(named.nodes[0]!.title).toBe('主视觉')
    // The file changes under it — a re-run, a version — and the name stays.
    const rerun = applyCanvasOps(named, [
      { type: 'set_node', id: 'a', patch: { src: 'generations/a-2.png', recipe: { op: 'image-gen' } } },
    ]).doc
    expect(rerun.nodes[0]!.title).toBe('主视觉')
    const renamed = applyCanvasOps(rerun, [{ type: 'set_node', id: 'a', patch: { title: '备选' } }]).doc
    expect(renamed.nodes[0]!.title).toBe('备选')
    expect(() =>
      applyCanvasOps(named, [
        { type: 'set_node', id: 'a', patch: { title: 'x'.repeat(CANVAS_LIMITS.titleLength + 1) } },
      ]),
    ).toThrow(/at most 80/)
  })

  test('audio nodes and recipes are part of the document', () => {
    const out = applyCanvasOps(doc(), [
      {
        type: 'add_node',
        node: {
          id: 'a',
          type: 'audio',
          src: 'assets/voice.mp3',
          recipe: { op: 'asr', params: { language: 'zh' } },
          x: 0,
          y: 0,
          w: 100,
          h: 40,
          z: 0,
        },
      },
    ]).doc
    expect(out.nodes[0]).toMatchObject({ type: 'audio', src: 'assets/voice.mp3' })
    expect(out.nodes[0]!.recipe).toEqual({ op: 'asr', params: { language: 'zh' } })
  })
})

describe('edges', () => {
  const board = () => doc([text('t'), image('i'), image('j'), video('v')])

  test('connect records the relation and answers its id', () => {
    const { doc: out, results } = applyCanvasOps(board(), [{ type: 'connect', edges: [{ from: 'i', to: 'v', role: 'reference' }] }])
    expect(out.edges).toHaveLength(1)
    expect(out.edges[0]).toMatchObject({ from: 'i', to: 'v', role: 'reference' })
    expect(results[0]!.ids).toEqual([out.edges[0]!.id])
  })

  test('a text card can be the prompt of another text card — text2text', () => {
    const { doc: out } = applyCanvasOps(doc([text('a'), text('b')]), [
      { type: 'connect', edges: [{ from: 'a', to: 'b', role: 'prompt' }] },
    ])
    expect(out.edges[0]).toMatchObject({ from: 'a', to: 'b', role: 'prompt' })
  })

  test('a role the two types cannot carry is refused, and nothing is applied', () => {
    expect(() =>
      applyCanvasOps(board(), [{ type: 'connect', edges: [{ from: 't', to: 'v', role: 'reference' }] }]),
    ).toThrow(/cannot be "reference"/)
    expect(() =>
      applyCanvasOps(board(), [{ type: 'connect', edges: [{ from: 'j', to: 'i', role: 'prompt' }] }]),
    ).toThrow(/cannot be "prompt"/)
    const before = board()
    expect(() =>
      applyCanvasOps(before, [
        { type: 'connect', edges: [{ from: 'i', to: 'v', role: 'reference' }] },
        { type: 'connect', edges: [{ from: 't', to: 'v', role: 'reference' }] },
      ]),
    ).toThrow(/operation 1/)
  })

  test('the same pair twice is refused, and a node cannot be its own input', () => {
    const once = applyCanvasOps(board(), [{ type: 'connect', edges: [{ from: 'i', to: 'v', role: 'reference' }] }]).doc
    expect(() => applyCanvasOps(once, [{ type: 'connect', edges: [{ from: 'i', to: 'v', role: 'first-frame' }] }])).toThrow(
      /already an input/,
    )
    expect(() => applyCanvasOps(board(), [{ type: 'connect', edges: [{ from: 'v', to: 'v', role: 'reference' }] }])).toThrow(
      /own input/,
    )
  })

  test('deleting a node takes its relations with it', () => {
    const wired = applyCanvasOps(board(), [
      { type: 'connect', edges: [{ from: 'i', to: 'v', role: 'reference' }, { from: 't', to: 'v', role: 'prompt' }] },
    ]).doc
    const cut = applyCanvasOps(wired, [{ type: 'remove_nodes', ids: ['v'] }]).doc
    expect(cut.edges).toEqual([])
    const upstream = applyCanvasOps(wired, [{ type: 'remove_nodes', ids: ['i'] }]).doc
    expect(upstream.edges.map((edge) => edge.role)).toEqual(['prompt'])
  })

  test('reorder names every edge of one role, once, and keeps the numbering', () => {
    const wired = applyCanvasOps(doc([image('a'), image('b'), image('c'), video('v')]), [
      {
        type: 'connect',
        edges: [
          { from: 'a', to: 'v', role: 'reference' },
          { from: 'b', to: 'v', role: 'reference' },
          { from: 'c', to: 'v', role: 'reference' },
        ],
      },
    ]).doc
    const ids = wired.edges.map((edge) => edge.id)
    const moved = applyCanvasOps(wired, [{ type: 'reorder_edges', to: 'v', role: 'reference', ids: [ids[2]!, ids[0]!, ids[1]!] }]).doc
    expect(moved.edges.map((edge) => edge.from)).toEqual(['c', 'a', 'b'])
    expect(() => applyCanvasOps(wired, [{ type: 'reorder_edges', to: 'v', role: 'reference', ids: [ids[0]!] }])).toThrow(
      /must name every/,
    )
  })

  test('duplicate keeps relations inside the copy and leaves external ones alone', () => {
    // k → i is external to the pair being copied, i → j is inside it.
    const wired = applyCanvasOps(doc([image('i'), image('j'), image('k')]), [
      { type: 'connect', edges: [{ from: 'i', to: 'j', role: 'reference' }, { from: 'k', to: 'i', role: 'reference' }] },
    ]).doc
    const { doc: copied } = applyCanvasOps(wired, [{ type: 'duplicate', ids: ['i', 'j'] }])
    expect(copied.nodes).toHaveLength(5)
    expect(copied.edges).toHaveLength(3)
    const copyIds = copied.nodes.map((node) => node.id).filter((id) => id.includes('-copy-'))
    const copyEdges = copied.edges.filter((edge) => copyIds.includes(edge.from) || copyIds.includes(edge.to))
    expect(copyEdges).toHaveLength(1)
    expect(copyIds).toContain(copyEdges[0]!.from)
    expect(copyIds).toContain(copyEdges[0]!.to)
  })
})
