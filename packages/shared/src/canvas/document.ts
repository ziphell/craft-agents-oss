/**
 * A canvas is a file: what is on it, where it sits, and how big the view is.
 *
 * A project holds exactly one canvas (`<project>/canvas.json`). It is a document rather than a
 * property of the project: a name, a viewport, and a flat list of things — nothing that only makes
 * sense while some particular window is open.
 *
 * **Every edit is an operation.** The agent and the person apply the same vocabulary, which is
 * also what makes one undo step mean the same thing to both: a batch is applied whole or not at
 * all, and the caller records the before/after pair (`history.ts`). The alternative — each side
 * with its own mutations — is how a co-edited document stops being one document.
 *
 * **A node is a file; an edge is what it is made from.** Nodes are things on a board and nothing
 * else — no embedded forms, no per-node UI. The relation between them ("this picture is the
 * reference for that clip", "this note is the prompt") is its own record, `CanvasEdge`, because a
 * relation stored inside the consumer is invisible on the board and dies silently when either end
 * is deleted. The line a person draws and the record an agent writes are the same object.
 *
 * Deliberately **not** a node-graph editor: an edge is a statement about provenance and input, not
 * a port on a computation. There are four roles, they are chosen by the two endpoint types, and
 * nothing routes, re-executes, or fans out on its own.
 */

/** Bumped when the meaning of a field changes; unknown versions are refused rather than guessed. */
export const CANVAS_DOC_VERSION = 3
/** Version 1 kept text inline; version 2 made every node point at a file. */
export const CANVAS_LEGACY_VERSION = 1
/** Version 2 kept relations inside the consumer's `recipe`; version 3 moved them to `edges`. */
export const CANVAS_INLINE_RELATIONS_VERSION = 2

export type CanvasNodeType = 'image' | 'video' | 'audio' | 'text'

/**
 * What an edge means to the node that receives it.
 *
 * Two of them are numbered (`reference` 1..n, `prompt` T1..Tn — the API takes the order), and the
 * frame roles are the same reference with a place in the clip rather than in the array.
 */
export type CanvasEdgeRole = 'reference' | 'prompt' | 'first-frame' | 'last-frame'

/**
 * A directed relation: `from` is an input of `to`.
 *
 * Numbering within one `(to, role)` group is the order the edges appear in `CanvasDoc.edges` — one
 * array, so a batch that reorders is one undo step, and no second counter can drift.
 */
export interface CanvasEdge {
  id: string
  from: string
  to: string
  role: CanvasEdgeRole
}

/**
 * What a node can be produced from, when it was not simply uploaded or written by hand.
 *
 * A recipe is deliberately only a description. The executor lives with the media tools; the
 * document only needs to remember the operation and the parameters. **Its inputs are not here** —
 * they are edges (`document.ts` → `CanvasEdge`), so a relation cannot outlive its endpoints and
 * the board can draw it.
 */
export interface CanvasRecipe {
  /** `text2text`, `image2txt`, `asr`, `image-gen`, `video-gen`, `audio-gen`, `crop`, `rotate`, … */
  op: string
  /**
   * The file this operation consumed, when the node itself was the input (`crop`, `rotate`, `flip`,
   * `resize`, `convert`). The old file stays where it is, so the edit can be undone by pointing
   * `src` back at it.
   */
  source?: string
  /**
   * Every file this node has produced, newest first. `src` is the one being shown; switching only
   * moves the pointer, so an earlier result stays one click away instead of being overwritten.
   */
  versions?: string[]
  /** A prompt typed on the node itself, for a node that does not use text nodes. */
  prompt?: string
  channelId?: string
  model?: string
  params?: Record<string, string | number>
}

export interface CanvasNode {
  id: string
  type: CanvasNodeType
  /** Render origin, canvas pixels, top-left. */
  x: number
  y: number
  w: number
  h: number
  /** Paint order; higher is nearer. Ties break by array order, so a batch is deterministic. */
  z: number
  /**
   * What the card is called — a name for the thing on the board, not a name for its file.
   *
   * A node outlives the file behind it: a run can be repeated, a version restored, and the file is
   * renamed by every one of those. So the name lives here. Absent means nobody has named it, and a
   * reader falls back to the file's own name (`title.ts#displayTitle`).
   */
  title?: string
  rotation?: number
  /** Members of one group move and select together; the id is opaque and only groups compare. */
  groupId?: string
  /**
   * The file this node shows, project-relative (`docs/nodes/x.md`, `assets/b.mp4`).
   *
   * Text points at a markdown document; media points at an asset. It may not exist yet while a
   * generation runs — the node then shows the task's state, not a missing file.
   */
  src?: string
  /**
   * Legacy inline text, only read while a version-1 document is being migrated.
   * New text nodes write `src` instead.
   */
  text?: string
  /** How this file is (re)produced, when it was not simply uploaded or written. */
  recipe?: CanvasRecipe
  /**
   * The composer's current prompt, persisted with the node so reopening it remembers what
   * was being written. BeefTV stores this as `metadata.composerContent`; we keep it flat on
   * the node since CanvasNode has no metadata bucket yet.
   */
  prompt?: string
  fontSize?: number
  color?: string
  /** video: play without sound. The clip's own file is never touched. */
  muted?: boolean
}

export interface CanvasViewport {
  /** Canvas pixels at the view's top-left. */
  x: number
  y: number
  /** 0.05–4, the same range the view clamps to. */
  scale: number
}

export interface CanvasDoc {
  version: typeof CANVAS_DOC_VERSION
  /** Bumped by every applied batch. The write precondition (see `applyCanvasOps`). */
  revision: number
  name: string
  background?: string
  viewport: CanvasViewport
  nodes: CanvasNode[]
  /**
   * Every relation on the board, in one list — including the ones that are not about generation.
   * Invariant: both endpoints exist and no two edges share a `(from, to)` pair.
   */
  edges: CanvasEdge[]
}

export const CANVAS_LIMITS = {
  nodes: 400,
  edges: 1200,
  opsPerBatch: 50,
  minSize: 8,
  maxSize: 20000,
  minScale: 0.05,
  maxScale: 4,
  textLength: 4000,
  titleLength: 80,
} as const

export type CanvasOp =
  | { type: 'add_node'; node: CanvasNode }
  | { type: 'remove_nodes'; ids: string[] }
  | { type: 'move_nodes'; ids: string[]; dx: number; dy: number }
  | { type: 'set_node'; id: string; patch: CanvasNodePatch }
  | { type: 'connect'; edges: Array<Omit<CanvasEdge, 'id'> & { id?: string }> }
  | { type: 'disconnect'; ids: string[] }
  | { type: 'reorder_edges'; to: string; role: CanvasEdgeRole; ids: string[] }
  | { type: 'set_z'; id: string; z: number }
  | { type: 'bring_to_front'; ids: string[] }
  | { type: 'send_to_back'; ids: string[] }
  | { type: 'align'; ids: string[]; edge: 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom' }
  | { type: 'distribute'; ids: string[]; axis: 'x' | 'y' }
  | { type: 'group'; ids: string[] }
  | { type: 'ungroup'; ids: string[] }
  | { type: 'duplicate'; ids: string[]; dx?: number; dy?: number }
  | { type: 'set_viewport'; viewport: Partial<CanvasViewport> }
  | { type: 'set_canvas'; name?: string; background?: string | null }

/** The fields a `set_node` may touch. Geometry, identity and type are not among them. */
export type CanvasNodePatch = Partial<
  Pick<CanvasNode, 'x' | 'y' | 'w' | 'h' | 'rotation' | 'src' | 'title' | 'recipe' | 'prompt' | 'fontSize' | 'color' | 'muted' | 'groupId'>
>

export interface CanvasOpResult {
  type: CanvasOp['type']
  ok: true
  /** What the operation touched, so a caller can report or re-select. */
  ids: string[]
  detail?: string
}

export interface CanvasApplyResult {
  doc: CanvasDoc
  results: CanvasOpResult[]
}

/** A refused operation names its index, because a batch of fifty with no pointer is unreadable. */
export class CanvasOpError extends Error {
  readonly index: number
  readonly opType: string

  constructor(index: number, opType: string, message: string) {
    super(`operation ${index} (${opType}): ${message}`)
    this.name = 'CanvasOpError'
    this.index = index
    this.opType = opType
  }
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

function assertSize(value: number, what: string, index: number, type: string): void {
  if (!isFiniteNumber(value) || value < CANVAS_LIMITS.minSize || value > CANVAS_LIMITS.maxSize) {
    throw new CanvasOpError(index, type, `${what} must be ${CANVAS_LIMITS.minSize}–${CANVAS_LIMITS.maxSize}`)
  }
}

function requireNode(doc: CanvasDoc, id: string, index: number, type: string): CanvasNode {
  const node = doc.nodes.find((candidate) => candidate.id === id)
  if (!node) throw new CanvasOpError(index, type, `no node ${id}`)
  return node
}

/** Boundaries of a set of nodes; null when the set is empty (a caller reports that, not apply). */
export function boundsOf(nodes: CanvasNode[]): { left: number; top: number; right: number; bottom: number; width: number; height: number } | null {
  if (!nodes.length) return null
  const left = Math.min(...nodes.map((node) => node.x))
  const top = Math.min(...nodes.map((node) => node.y))
  const right = Math.max(...nodes.map((node) => node.x + node.w))
  const bottom = Math.max(...nodes.map((node) => node.y + node.h))
  return { left, top, right, bottom, width: right - left, height: bottom - top }
}

/** Top-most ids in paint order, the order the eye reads when two things overlap. */
export function topmost(nodes: CanvasNode[], ids: string[]): string[] {
  const set = new Set(ids)
  return [...nodes]
    .sort((a, b) => a.z - b.z)
    .map((node) => node.id)
    .filter((id) => set.has(id))
}

export function cloneCanvasDoc(doc: CanvasDoc): CanvasDoc {
  return {
    ...doc,
    viewport: { ...doc.viewport },
    nodes: doc.nodes.map((node) => ({ ...node })),
    edges: doc.edges.map((edge) => ({ ...edge })),
  }
}

/** Which roles a pair of nodes can carry. The endpoint types decide; the person only picks. */
export function edgeRolesFor(from: CanvasNode, to: CanvasNode): CanvasEdgeRole[] {
  const media = (type: CanvasNodeType) => type === 'image' || type === 'video' || type === 'audio'
  const roles: CanvasEdgeRole[] = []
  // Text is an instruction wherever it points: a media card reads it as the prompt, and another
  // text card reads it the same way (`text2text`), which is what keeps that recipe connectable.
  if (from.type === 'text' && (media(to.type) || to.type === 'text')) roles.push('prompt')
  // A text card is read *from* a picture or a recording (describe, transcribe), so it consumes a
  // reference as readily as a media card does.
  if (media(from.type) && (media(to.type) || to.type === 'text')) roles.push('reference')
  if (from.type === 'image' && to.type === 'video') roles.push('first-frame', 'last-frame')
  return roles
}

/** The first legal role, which is the one a wire drawn without a menu uses. */
export function defaultEdgeRole(from: CanvasNode, to: CanvasNode): CanvasEdgeRole | null {
  return edgeRolesFor(from, to)[0] ?? null
}

/** Edges arriving at one node, in board order, optionally narrowed to a role. */
export function edgesInto(doc: CanvasDoc, to: string, role?: CanvasEdgeRole): CanvasEdge[] {
  return doc.edges.filter((edge) => edge.to === to && (role === undefined || edge.role === role))
}

/**
 * Apply one batch to a copy of the document.
 *
 * Atomic: the first refusal throws and nothing is written, so a caller never has to unwind a
 * half-applied batch. `revision` is not touched here — the store owns it, because it is the write
 * precondition and must only move when the write actually lands.
 */
export function applyCanvasOps(doc: CanvasDoc, ops: CanvasOp[]): CanvasApplyResult {
  if (!ops.length) return { doc, results: [] }
  if (ops.length > CANVAS_LIMITS.opsPerBatch) {
    throw new CanvasOpError(0, ops[0]!.type, `a batch holds at most ${CANVAS_LIMITS.opsPerBatch} operations`)
  }

  const next = cloneCanvasDoc(doc)
  const results: CanvasOpResult[] = []

  ops.forEach((op, index) => {
    switch (op.type) {
      case 'add_node': {
        if (next.nodes.length >= CANVAS_LIMITS.nodes) {
          throw new CanvasOpError(index, op.type, `a canvas holds at most ${CANVAS_LIMITS.nodes} nodes`)
        }
        const node = { ...op.node }
        if (!node.id || next.nodes.some((candidate) => candidate.id === node.id)) {
          throw new CanvasOpError(index, op.type, `duplicate or empty id ${node.id}`)
        }
        if (node.type !== 'image' && node.type !== 'video' && node.type !== 'audio' && node.type !== 'text') {
          throw new CanvasOpError(index, op.type, `unknown node type ${String(node.type)}`)
        }
        assertSize(node.w, 'w', index, op.type)
        assertSize(node.h, 'h', index, op.type)
        if (!isFiniteNumber(node.x) || !isFiniteNumber(node.y) || !isFiniteNumber(node.z)) {
          throw new CanvasOpError(index, op.type, 'x, y and z must be finite')
        }
        // A text node points at a markdown file. A version-1 document may still carry inline text;
        // the migration in files.ts turns that into a file before anyone writes a new node here.
        if (node.type === 'text' && typeof node.text !== 'string' && typeof node.src !== 'string') {
          throw new CanvasOpError(index, op.type, 'a text node needs a markdown file (src) or legacy text')
        }
        if (node.title !== undefined && (typeof node.title !== 'string' || node.title.length > CANVAS_LIMITS.titleLength)) {
          throw new CanvasOpError(index, op.type, `a title must be a string of at most ${CANVAS_LIMITS.titleLength}`)
        }
        if (node.recipe !== undefined) {
          if (!node.recipe || typeof node.recipe !== 'object' || typeof node.recipe.op !== 'string' || !node.recipe.op.trim()) {
            throw new CanvasOpError(index, op.type, 'a recipe needs an op')
          }
        }
        // A media node may exist before its file does: that is what an empty node is, and it is
        // the thing a person fills by dropping a file on it or by describing it in its composer.
        // Requiring `src` here made "add a picture" impossible to do in the order people do it.
        next.nodes.push(node)
        results.push({ type: op.type, ok: true, ids: [node.id] })
        return
      }

      case 'remove_nodes': {
        const targets = op.ids.map((id) => requireNode(next, id, index, op.type))
        next.nodes = next.nodes.filter((node) => !op.ids.includes(node.id))
        // A relation whose endpoint is gone is not a relation: leaving the id behind would make a
        // dead reference that no UI can show and no one can remove.
        next.edges = next.edges.filter((edge) => !op.ids.includes(edge.from) && !op.ids.includes(edge.to))
        results.push({ type: op.type, ok: true, ids: [...op.ids] })
        return
      }

      case 'move_nodes': {
        if (!isFiniteNumber(op.dx) || !isFiniteNumber(op.dy)) {
          throw new CanvasOpError(index, op.type, 'dx and dy must be finite')
        }
        const targets = op.ids.map((id) => requireNode(next, id, index, op.type))
        for (const node of targets) {
          node.x += op.dx
          node.y += op.dy
        }
        results.push({ type: op.type, ok: true, ids: [...op.ids] })
        return
      }

      case 'set_node': {
        const node = requireNode(next, op.id, index, op.type)
        const patch = op.patch
        if (patch.w !== undefined) assertSize(patch.w, 'w', index, op.type)
        if (patch.h !== undefined) assertSize(patch.h, 'h', index, op.type)
        for (const key of ['x', 'y', 'w', 'h', 'rotation'] as const) {
          const value = patch[key]
          if (value !== undefined && !isFiniteNumber(value)) {
            throw new CanvasOpError(index, op.type, `${key} must be finite`)
          }
        }
        if (patch.title !== undefined && (typeof patch.title !== 'string' || patch.title.length > CANVAS_LIMITS.titleLength)) {
          throw new CanvasOpError(index, op.type, `a title must be a string of at most ${CANVAS_LIMITS.titleLength}`)
        }
        Object.assign(node, patch)
        results.push({ type: op.type, ok: true, ids: [node.id] })
        return
      }

      case 'connect': {
        if (!op.edges.length) throw new CanvasOpError(index, op.type, 'nothing to connect')
        const made: CanvasEdge[] = []
        for (const wanted of op.edges) {
          const from = requireNode(next, wanted.from, index, op.type)
          const to = requireNode(next, wanted.to, index, op.type)
          if (from.id === to.id) throw new CanvasOpError(index, op.type, `${from.id} cannot be its own input`)
          const legal = edgeRolesFor(from, to)
          if (!legal.includes(wanted.role)) {
            throw new CanvasOpError(
              index,
              op.type,
              `${from.type} → ${to.type} cannot be "${wanted.role}"${legal.length ? ` (use ${legal.join(', ')})` : ' (no relation is legal between these two)'}`,
            )
          }
          if (next.edges.some((edge) => edge.from === from.id && edge.to === to.id)) {
            throw new CanvasOpError(index, op.type, `${from.id} is already an input of ${to.id}`)
          }
          if (next.edges.length + made.length >= CANVAS_LIMITS.edges) {
            throw new CanvasOpError(index, op.type, `a canvas holds at most ${CANVAS_LIMITS.edges} edges`)
          }
          // An id from the caller is honoured so a batch can be retried without drawing twice;
          // one is minted otherwise, because the person's drag has no id yet.
          const edge: CanvasEdge = {
            id: wanted.id && !next.edges.some((existing) => existing.id === wanted.id) && !made.some((existing) => existing.id === wanted.id)
              ? wanted.id
              : `e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
            from: from.id,
            to: to.id,
            role: wanted.role,
          }
          made.push(edge)
        }
        next.edges.push(...made)
        results.push({ type: op.type, ok: true, ids: made.map((edge) => edge.id) })
        return
      }

      case 'disconnect': {
        if (!op.ids.length) throw new CanvasOpError(index, op.type, 'nothing to disconnect')
        for (const id of op.ids) {
          const edge = next.edges.find((candidate) => candidate.id === id)
          if (!edge) throw new CanvasOpError(index, op.type, `no edge ${id}`)
        }
        next.edges = next.edges.filter((edge) => !op.ids.includes(edge.id))
        results.push({ type: op.type, ok: true, ids: [...op.ids] })
        return
      }

      case 'reorder_edges': {
        requireNode(next, op.to, index, op.type)
        const group = next.edges.filter((edge) => edge.to === op.to && edge.role === op.role)
        const given = new Set(op.ids)
        if (given.size !== op.ids.length || group.length !== op.ids.length || group.some((edge) => !given.has(edge.id))) {
          throw new CanvasOpError(index, op.type, `reorder must name every "${op.role}" edge of ${op.to}, once`)
        }
        const ordered = op.ids.map((id) => group.find((edge) => edge.id === id)!) as CanvasEdge[]
        const first = next.edges.findIndex((edge) => edge.to === op.to && edge.role === op.role)
        const rest = next.edges.filter((edge) => !given.has(edge.id))
        // Insert where the group already began: the whole array stays one list, so numbering within
        // every other consumer keeps the order the eye already saw.
        const before = next.edges.slice(0, first).filter((edge) => !given.has(edge.id))
        next.edges = [...rest.slice(0, before.length), ...ordered, ...rest.slice(before.length)]
        results.push({ type: op.type, ok: true, ids: [...op.ids] })
        return
      }

      case 'set_z':
      case 'bring_to_front':
      case 'send_to_back': {
        if (op.type === 'set_z') {
          const node = requireNode(next, op.id, index, op.type)
          if (!isFiniteNumber(op.z)) throw new CanvasOpError(index, op.type, 'z must be finite')
          node.z = op.z
          results.push({ type: op.type, ok: true, ids: [node.id] })
          return
        }
        const targets = op.ids.map((id) => requireNode(next, id, index, op.type))
        const zs = next.nodes.map((node) => node.z)
        const base = op.type === 'bring_to_front' ? Math.max(...zs, 0) : Math.min(...zs, 0)
        targets.forEach((node, offset) => {
          node.z = op.type === 'bring_to_front' ? base + 1 + offset : base - 1 - offset
        })
        results.push({ type: op.type, ok: true, ids: targets.map((node) => node.id) })
        return
      }

      case 'align': {
        const targets = op.ids.map((id) => requireNode(next, id, index, op.type))
        const frame = boundsOf(targets)
        if (!frame) throw new CanvasOpError(index, op.type, 'nothing to align')
        for (const node of targets) {
          switch (op.edge) {
            case 'left':
              node.x = frame.left
              break
            case 'hcenter':
              node.x = frame.left + (frame.width - node.w) / 2
              break
            case 'right':
              node.x = frame.right - node.w
              break
            case 'top':
              node.y = frame.top
              break
            case 'vcenter':
              node.y = frame.top + (frame.height - node.h) / 2
              break
            case 'bottom':
              node.y = frame.bottom - node.h
              break
          }
        }
        results.push({ type: op.type, ok: true, ids: targets.map((node) => node.id) })
        return
      }

      case 'distribute': {
        if (op.ids.length < 3) throw new CanvasOpError(index, op.type, 'distributing needs three or more nodes')
        const targets = op.ids.map((id) => requireNode(next, id, index, op.type))
        const axis = op.axis === 'x' ? ('x' as const) : ('y' as const)
        const size = op.axis === 'x' ? ('w' as const) : ('h' as const)
        const sorted = [...targets].sort((a, b) => a[axis] - b[axis])
        const first = sorted[0]!
        const last = sorted[sorted.length - 1]!
        const span = last[axis] + last[size] - first[axis]
        const total = sorted.reduce((sum, node) => sum + node[size], 0)
        const gap = (span - total) / (sorted.length - 1)
        let cursor = first[axis]
        for (const node of sorted) {
          node[axis] = cursor
          cursor += node[size] + gap
        }
        results.push({ type: op.type, ok: true, ids: sorted.map((node) => node.id) })
        return
      }

      case 'group': {
        if (op.ids.length < 2) throw new CanvasOpError(index, op.type, 'a group needs two or more nodes')
        const targets = op.ids.map((id) => requireNode(next, id, index, op.type))
        const groupId = `group-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
        for (const node of targets) node.groupId = groupId
        results.push({ type: op.type, ok: true, ids: targets.map((node) => node.id), detail: groupId })
        return
      }

      case 'ungroup': {
        const targets = op.ids.map((id) => requireNode(next, id, index, op.type))
        for (const node of targets) delete node.groupId
        results.push({ type: op.type, ok: true, ids: targets.map((node) => node.id) })
        return
      }

      case 'duplicate': {
        const targets = op.ids.map((id) => requireNode(next, id, index, op.type))
        if (next.nodes.length + targets.length > CANVAS_LIMITS.nodes) {
          throw new CanvasOpError(index, op.type, `a canvas holds at most ${CANVAS_LIMITS.nodes} nodes`)
        }
        const dx = op.dx ?? 24
        const dy = op.dy ?? 24
        const copies = targets.map((node, offset) => {
          const copy: CanvasNode = {
            ...node,
            id: `${node.id}-copy-${offset}-${Math.random().toString(36).slice(2, 6)}`,
            x: node.x + dx,
            y: node.y + dy,
            z: node.z + 1 + offset,
          }
          return copy
        })
        // Relations among the copied cards come with them; relations pointing outside do not — a
        // duplicate is a new beginning, not a second consumer of somebody else's picture.
        const renamed = new Map(targets.map((node, offset) => [node.id, copies[offset]!.id]))
        const inner = next.edges.filter((edge) => renamed.has(edge.from) && renamed.has(edge.to))
        next.edges.push(
          ...inner.map((edge) => ({
            ...edge,
            id: `e-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
            from: renamed.get(edge.from)!,
            to: renamed.get(edge.to)!,
          })),
        )
        next.nodes.push(...copies)
        results.push({ type: op.type, ok: true, ids: copies.map((node) => node.id) })
        return
      }

      case 'set_viewport': {
        const { x, y, scale } = op.viewport
        if (x !== undefined && !isFiniteNumber(x)) throw new CanvasOpError(index, op.type, 'x must be finite')
        if (y !== undefined && !isFiniteNumber(y)) throw new CanvasOpError(index, op.type, 'y must be finite')
        if (scale !== undefined) {
          if (!isFiniteNumber(scale) || scale < CANVAS_LIMITS.minScale || scale > CANVAS_LIMITS.maxScale) {
            throw new CanvasOpError(index, op.type, `scale must be ${CANVAS_LIMITS.minScale}–${CANVAS_LIMITS.maxScale}`)
          }
          next.viewport.scale = scale
        }
        if (x !== undefined) next.viewport.x = x
        if (y !== undefined) next.viewport.y = y
        results.push({ type: op.type, ok: true, ids: [] })
        return
      }

      case 'set_canvas': {
        if (op.name !== undefined) {
          const name = op.name.trim()
          if (!name || name.length > CANVAS_LIMITS.titleLength) {
            throw new CanvasOpError(index, op.type, `name must be 1–${CANVAS_LIMITS.titleLength} characters`)
          }
          next.name = name
        }
        if (op.background === null) delete next.background
        else if (op.background !== undefined) next.background = op.background
        results.push({ type: op.type, ok: true, ids: [] })
        return
      }

      default: {
        const unreachable: never = op
        throw new CanvasOpError(index, String((unreachable as { type?: string }).type ?? 'unknown'), 'unknown operation')
      }
    }
  })

  return { doc: next, results }
}

/** A fresh canvas: one that can be drawn on immediately, with nothing on it. */
export function createCanvasDoc(name: string, options: Partial<Pick<CanvasDoc, 'background'>> = {}): CanvasDoc {
  return {
    version: CANVAS_DOC_VERSION,
    revision: 0,
    name: name.trim() || '画布',
    ...(options.background ? { background: options.background } : {}),
    viewport: { x: 0, y: 0, scale: 1 },
    nodes: [],
    edges: [],
  }
}

/** Read a document from bytes, refusing what this build does not understand. */
export function parseCanvasDoc(raw: string): CanvasDoc {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('canvas file is not JSON')
  }
  const doc = value as Partial<CanvasDoc>
  if (!doc || typeof doc !== 'object') throw new Error('canvas file is not an object')
  // Version 1 kept text inline; version 2 kept relations inside the consumer's `recipe`. Both are
  // still readable and are upgraded here, in memory — the file is rewritten in the new shape the
  // next time the editor saves it. A version this build has never seen is refused.
  const readable = [CANVAS_DOC_VERSION, CANVAS_INLINE_RELATIONS_VERSION, CANVAS_LEGACY_VERSION]
  if (!readable.includes(doc.version as number)) {
    throw new Error(`canvas version ${String(doc.version)} is not ${CANVAS_DOC_VERSION}`)
  }
  if (!Array.isArray(doc.nodes)) throw new Error('canvas file has no nodes')
  if (!doc.viewport || !isFiniteNumber(doc.viewport.x) || !isFiniteNumber(doc.viewport.y) || !isFiniteNumber(doc.viewport.scale)) {
    throw new Error('canvas file has no usable viewport')
  }
  if (!isFiniteNumber(doc.revision) || doc.revision < 0) throw new Error('canvas file has no revision')
  return {
    version: CANVAS_DOC_VERSION,
    revision: doc.revision,
    name: typeof doc.name === 'string' && doc.name ? doc.name : '画布',
    ...(typeof doc.background === 'string' ? { background: doc.background } : {}),
    viewport: { x: doc.viewport.x, y: doc.viewport.y, scale: doc.viewport.scale },
    // `locked` is not a thing this build has any more. Dropping it on read is what keeps an older
    // file usable: a flag nothing can clear would leave a card frozen with no way out.
    nodes: doc.nodes.map((node) => {
      const { locked: _locked, ...rest } = node as CanvasNode & { locked?: boolean }
      return rest
    }),
    edges: readEdges(doc.nodes as CanvasNode[], (doc as { edges?: unknown }).edges, doc.version as number),
  }
}

/**
 * The document's edges, from the field or — for a version-2 file — from the recipes that held them.
 *
 * A version-2 recipe listed its inputs, prompts and frames; that is the same four relations this
 * version keeps in one list. Anything naming a node that no longer exists is dropped instead of
 * kept as a reference nothing can draw or remove.
 */
function readEdges(nodes: CanvasNode[], raw: unknown, version: number): CanvasEdge[] {
  const ids = new Set(nodes.map((node) => node.id))
  const edges: CanvasEdge[] = []
  const add = (from: unknown, to: string, role: CanvasEdgeRole, id?: unknown) => {
    if (typeof from !== 'string' || !ids.has(from) || from === to) return
    if (edges.some((edge) => edge.from === from && edge.to === to)) return
    edges.push({
      id: typeof id === 'string' && id ? id : `e-${edges.length}-${to}`,
      from,
      to,
      role,
    })
  }

  if (version >= CANVAS_DOC_VERSION) {
    for (const value of Array.isArray(raw) ? raw : []) {
      const edge = value as Partial<CanvasEdge>
      if (!edge || typeof edge.to !== 'string') continue
      add(edge.from, edge.to, edge.role as CanvasEdgeRole, edge.id)
    }
    return edges
  }

  // Version 2 or older: the relations were fields on the consumer.
  for (const node of nodes) {
    const recipe = node.recipe as (Partial<CanvasRecipe> & {
      inputs?: unknown
      promptNodes?: unknown
      firstFrame?: unknown
      lastFrame?: unknown
    }) | undefined
    if (!recipe) continue
    const list = (value: unknown) => (Array.isArray(value) ? value : [])
    // Frames first: version 2 also listed a frame picture in `inputs`, and the run treated it as
    // that frame rather than as a numbered reference. The frame role is the one that survives.
    add(recipe.firstFrame, node.id, 'first-frame')
    add(recipe.lastFrame, node.id, 'last-frame')
    for (const from of list(recipe.inputs)) add(from, node.id, 'reference')
    for (const from of list(recipe.promptNodes)) add(from, node.id, 'prompt')
    // The new shape has no place for them; keeping them would be a second, silent truth.
    delete recipe.inputs
    delete recipe.promptNodes
    delete recipe.firstFrame
    delete recipe.lastFrame
  }
  return edges
}

export function serializeCanvasDoc(doc: CanvasDoc): string {
  return `${JSON.stringify(doc, null, 2)}\n`
}
