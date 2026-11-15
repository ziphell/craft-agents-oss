/**
 * Draws a parsed mindmap as an SVG string.
 *
 * The app's other diagrams are drawn by `beautiful-mermaid`, which has no mindmap pipeline;
 * this block draws its own. The two halves are deliberately separate:
 *
 * - `parseMindmap` (in `@craft-agent/core`) reads the syntax, and `mermaid_validate` reuses it.
 * - this module turns the tree into markup, synchronously, so the reader can render in a
 *   `useMemo` with no flash — the same contract `renderMermaidSVG` has.
 *
 * **Layout is the vendored tidy-tree packer** in `lib/tidy-tree-layout` (ported from
 * `non-layered-tidy-tree-layout`, MIT — the algorithm Mermaid's own mindmap has used). It is
 * asked for a top-down tree and its coordinates are read sideways: depth becomes the horizontal
 * axis, and sibling spread becomes the vertical one. Root-centred mindmaps are two of those
 * layouts, the branches split by weight and the left half mirrored, which is why the root's
 * children are divided before anything is placed.
 *
 * **Colours are CSS variable references**, like the mermaid block: the SVG is injected into
 * the document and the theme resolves the variables, so a light/dark or preset change repaints
 * without re-rendering.
 */

import { BoundingBox, Layout } from '../../lib/tidy-tree-layout'
import type { MindmapNode, MindmapShape } from '@craft-agent/core/mermaid/mindmap'

const FONT_SIZE = 13
const LINE_HEIGHT = 18
const PADDING_X = 11
const PADDING_Y = 7
const MIN_NODE_WIDTH = 34
const MIN_NODE_HEIGHT = 30
const MAX_TEXT_WIDTH = 220
/** Lines a single label may take before it is clipped; a wall of text is not a map. */
const MAX_LINES_PER_NODE = 12
/** Nodes one map may draw. Past this the source is shown instead of a very large picture. */
const MAX_NODES = 800
/** Extra horizontal room for shapes that pinch the sides of their label. */
const SHAPE_PADDING = 10
/** Space between siblings, on the vertical axis of the finished drawing. */
const SIBLING_GAP = 10
/**
 * Space between a node and its children, on the horizontal axis.
 *
 * Wide enough that a curve lives in an empty column: the edge is drawn from a node's side to its
 * child's side across this gap only, and edges are painted *before* the boxes, so the worst case
 * — another subtree's node intruding into the gap — reads as the connector passing behind a box
 * rather than as a line through its text.
 */
const DEPTH_GAP = 40
const MARGIN = 24
const FONT_FAMILY = "'Inter', ui-sans-serif, system-ui, sans-serif"

/** A node with the text already laid out: what gets drawn, independent of where. */
interface SizedNode {
  node: MindmapNode
  lines: string[]
  width: number
  height: number
  depth: number
  /** Which top-level branch this node belongs to — its colour, and `-1` for the root. */
  branch: number
  children: SizedNode[]
}

/** The shape the layout packer wants: a tree whose boxes are the *swapped* node dimensions. */
interface LayoutNode {
  width: number
  height: number
  children: LayoutNode[]
  sized: SizedNode
  x?: number
  y?: number
}

interface PlacedNode {
  sized: SizedNode
  left: number
  top: number
  side: 'root' | 'left' | 'right'
}

/** Render a parsed mindmap. Throws only if the tree is malformed, which `parseMindmap` prevents. */
export function renderMindmapSVG(root: MindmapNode): string {
  const nodeCount = countNodes(root)
  if (nodeCount > MAX_NODES) {
    throw new Error(`This mind map has ${nodeCount} nodes; the limit for drawing one is ${MAX_NODES}.`)
  }

  const sizedRoot = sizeTree(root, 0, -1)
  const placed = new Map<SizedNode, PlacedNode>()
  placed.set(sizedRoot, { sized: sizedRoot, left: 0, top: -sizedRoot.height / 2, side: 'root' })

  // Branches are split by their leaf count so a deep branch and a shallow one balance, rather
  // than the first half of a list landing on one side. The first child goes right; each next one
  // goes to the lighter side, which keeps the reading order top-to-bottom on both halves.
  const right: SizedNode[] = []
  const left: SizedNode[] = []
  let rightWeight = 0
  let leftWeight = 0
  for (const child of sizedRoot.children) {
    const weight = leafWeight(child)
    if (rightWeight <= leftWeight) {
      right.push(child)
      rightWeight += weight
    } else {
      left.push(child)
      leftWeight += weight
    }
  }

  if (right.length > 0) layoutSide(sizedRoot, right, 'right', placed)
  if (left.length > 0) layoutSide(sizedRoot, left, 'left', placed)

  const edges: string[] = []
  const visit = (node: SizedNode) => {
    for (const child of node.children) {
      const parent = placed.get(node)
      const childPlacement = placed.get(child)
      if (parent && childPlacement) edges.push(edgePath(parent, childPlacement))
      visit(child)
    }
  }
  visit(sizedRoot)

  // Children before parents, so a label is never painted over by the box it belongs to.
  const nodes = Array.from(placed.values())
    .sort((a, b) => b.sized.depth - a.sized.depth)
    .map(renderNode)

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const placement of placed.values()) {
    minX = Math.min(minX, placement.left)
    minY = Math.min(minY, placement.top)
    maxX = Math.max(maxX, placement.left + placement.sized.width)
    maxY = Math.max(maxY, placement.top + placement.sized.height)
  }

  // The root is the centre of the picture, not a corner of it: when one side is deeper than the
  // other the tight box would leave the root off-centre, so the shorter side is given the extra
  // margin. Vertical balance comes from the layout itself (each side is centred on the root).
  const rootCentreX = sizedRoot.width / 2
  const halfWidth = Math.max(rootCentreX - minX, maxX - rootCentreX)
  minX = rootCentreX - halfWidth
  maxX = rootCentreX + halfWidth

  const width = Math.ceil(maxX - minX + MARGIN * 2)
  const height = Math.ceil(maxY - minY + MARGIN * 2)
  const translateX = round(MARGIN - minX)
  const translateY = round(MARGIN - minY)

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}" role="img" ` +
    `aria-label="Mind map: ${escapeXml(root.label.replace(/\n/g, ' '))}">` +
    `<g transform="translate(${translateX} ${translateY})">` +
    edges.join('') +
    nodes.join('') +
    `</g></svg>`
  )
}

function layoutSide(
  root: SizedNode,
  children: SizedNode[],
  side: 'left' | 'right',
  out: Map<SizedNode, PlacedNode>,
): void {
  const layoutRoot: LayoutNode = {
    // The layout packs a top-down tree; this one is read sideways. Handing it the swapped
    // dimensions is what makes `gap` mean "between siblings" and `bottomPadding` mean
    // "between a node and its children" in the finished drawing.
    width: root.height,
    height: root.width,
    children: children.map(toLayoutNode),
    sized: root,
  }

  const { result } = new Layout(new BoundingBox(SIBLING_GAP, DEPTH_GAP)).layout(layoutRoot)
  const rootCenter = (result.x ?? 0) + root.height / 2

  const walk = (node: LayoutNode) => {
    const { sized } = node
    if (sized !== root) {
      const top = (node.x ?? 0) - rootCenter
      // A right-hand node starts where the layout put it; a left-hand one is mirrored so that it
      // ends where the layout put it. Either way the root stays at `0 … root.width`.
      const left =
        side === 'right'
          ? (node.y ?? 0)
          : root.width - (node.y ?? 0) - sized.width
      out.set(sized, { sized, left, top, side })
    }
    node.children.forEach(walk)
  }

  walk(result)
}

function toLayoutNode(sized: SizedNode): LayoutNode {
  return {
    width: sized.height,
    height: sized.width,
    sized,
    children: sized.children.map(toLayoutNode),
  }
}

function edgePath(parent: PlacedNode, child: PlacedNode): string {
  const rightward = child.side !== 'left'
  const startX = rightward ? parent.left + parent.sized.width : parent.left
  const endX = rightward ? child.left : child.left + child.sized.width
  const startY = parent.top + parent.sized.height / 2
  const endY = child.top + child.sized.height / 2
  // Bounded so the curve never leaves the gap between the two columns: a large half-distance
  // would bow further into a neighbouring subtree's space than the gap actually offers.
  const bend = Math.min(28, Math.max(12, Math.abs(endX - startX) / 2))
  const direction = endX >= startX ? 1 : -1
  const stroke =
    child.sized.depth === 1
      ? branchTint(child.sized.branch, 42)
      : 'var(--foreground-20)'
  const width = child.sized.depth === 1 ? 1.6 : 1.2

  return (
    `<path d="M ${round(startX)} ${round(startY)} ` +
    `C ${round(startX + direction * bend)} ${round(startY)}, ` +
    `${round(endX - direction * bend)} ${round(endY)}, ${round(endX)} ${round(endY)}" ` +
    `fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" />`
  )
}

function renderNode(placement: PlacedNode): string {
  const { node, width, height, depth, branch, lines } = placement.sized
  const colors = palette(depth, branch)
  const fill = `fill="${colors.fill}" stroke="${colors.stroke}" stroke-width="1"`

  return (
    renderShape(node.shape, placement.left, placement.top, width, height, fill) +
    renderText(placement, lines, colors.text)
  )
}

function renderShape(
  shape: MindmapShape,
  x: number,
  y: number,
  width: number,
  height: number,
  fill: string,
): string {
  const cx = x + width / 2
  const cy = y + height / 2

  switch (shape) {
    case 'circle':
    case 'cloud':
      return `<ellipse cx="${round(cx)}" cy="${round(cy)}" rx="${round(width / 2)}" ry="${round(height / 2)}" ${fill} />`
    case 'hexagon': {
      const inset = Math.min(height / 2, width / 3)
      const points = [
        `${round(x + inset)},${round(y)}`,
        `${round(x + width - inset)},${round(y)}`,
        `${round(x + width)},${round(cy)}`,
        `${round(x + width - inset)},${round(y + height)}`,
        `${round(x + inset)},${round(y + height)}`,
        `${round(x)},${round(cy)}`,
      ].join(' ')
      return `<polygon points="${points}" ${fill} />`
    }
    case 'asymmetric': {
      const notch = Math.min(height / 2, width / 3)
      const points = [
        `${round(x)},${round(y)}`,
        `${round(x + width - notch)},${round(y)}`,
        `${round(x + width)},${round(cy)}`,
        `${round(x + width - notch)},${round(y + height)}`,
        `${round(x)},${round(y + height)}`,
      ].join(' ')
      return `<polygon points="${points}" ${fill} />`
    }
    case 'bang': {
      // A rectangle whose sides bow inward — the shape mermaid reads from `))text((`.
      const inset = Math.min(height / 3, width / 4)
      return (
        `<path d="M ${round(x)} ${round(y)} L ${round(x + width)} ${round(y)} ` +
        `Q ${round(x + width - inset)} ${round(cy)} ${round(x + width)} ${round(y + height)} ` +
        `L ${round(x)} ${round(y + height)} ` +
        `Q ${round(x + inset)} ${round(cy)} ${round(x)} ${round(y)} Z" ${fill} />`
      )
    }
    case 'rect':
      return `<rect x="${round(x)}" y="${round(y)}" width="${round(width)}" height="${round(height)}" rx="4" ${fill} />`
    case 'rounded':
    case 'default':
    default:
      return `<rect x="${round(x)}" y="${round(y)}" width="${round(width)}" height="${round(height)}" rx="${round(Math.min(height / 2, 9))}" ${fill} />`
  }
}

function renderText(placement: PlacedNode, lines: string[], color: string): string {
  const { width, height, depth } = placement.sized
  const centerX = placement.left + width / 2
  const firstY = placement.top + height / 2 - ((lines.length - 1) * LINE_HEIGHT) / 2
  const tspans = lines
    .map(
      (line, index) =>
        `<tspan x="${round(centerX)}" y="${round(firstY + index * LINE_HEIGHT)}">${escapeXml(line)}</tspan>`,
    )
    .join('')

  return (
    `<text text-anchor="middle" dominant-baseline="central" font-family="${FONT_FAMILY}" ` +
    `font-size="${FONT_SIZE}" font-weight="${depth <= 1 ? 600 : 400}" fill="${color}">${tspans}</text>`
  )
}

function palette(depth: number, branch: number): { fill: string; stroke: string; text: string } {
  if (depth === 0) {
    return { fill: 'var(--foreground)', stroke: 'var(--foreground)', text: 'var(--background)' }
  }
  if (depth === 1) {
    return { fill: branchTint(branch, 18), stroke: branchTint(branch, 42), text: 'var(--foreground)' }
  }
  // A leaf keeps its branch's hue, only lighter — the branch stays readable as one thing.
  return { fill: branchTint(branch, 8), stroke: branchTint(branch, 26), text: 'var(--foreground)' }
}

/**
 * A top-level branch's colour: the theme accent with its hue stepped, so sibling branches are
 * told apart while every one of them still belongs to the theme. Six steps covers a map whose
 * branches are many; past six the hues repeat, which reads as grouping rather than error.
 */
function branchHue(branch: number): string {
  // `h` in a relative `oklch()` is a number, not an angle — `calc(h + 16deg)` is invalid and
  // the whole `fill` would fall back to black.
  const offset = (Math.abs(branch) % 6) * 16
  return `oklch(from var(--accent) l c calc(h + ${offset}))`
}

function branchTint(branch: number, percent: number): string {
  return `color-mix(in oklch, ${branchHue(branch)} ${percent}%, var(--background))`
}

function countNodes(node: MindmapNode): number {
  let count = 1
  for (const child of node.children) count += countNodes(child)
  return count
}

function sizeTree(node: MindmapNode, depth: number, branch: number): SizedNode {
  // Depth 0 and 1 are drawn semibold (see `renderText`), and a bold label is wider than the same
  // text at 400 — sizing it with the regular factor shaved the left/right padding unevenly.
  const bold = depth <= 1
  const lines = wrapLabel(node.label, bold)
  const textWidth = Math.max(0, ...lines.map((line) => measureText(line, bold)))
  const shapePadding = pinchedShape(node.shape) ? SHAPE_PADDING : 0
  const sized: SizedNode = {
    node,
    lines,
    width: Math.max(MIN_NODE_WIDTH, Math.ceil(textWidth + PADDING_X * 2 + shapePadding)),
    height: Math.max(MIN_NODE_HEIGHT, lines.length * LINE_HEIGHT + PADDING_Y * 2),
    depth,
    branch,
    children: [],
  }
  // A top-level child opens a branch of its own; everything under it keeps that branch's colour.
  sized.children = node.children.map((child, index) =>
    sizeTree(child, depth + 1, depth === 0 ? index : branch),
  )
  return sized
}

/** Shapes whose outline eats into the label's width at the sides. */
function pinchedShape(shape: MindmapShape): boolean {
  return (
    shape === 'circle' ||
    shape === 'cloud' ||
    shape === 'hexagon' ||
    shape === 'asymmetric' ||
    shape === 'bang'
  )
}

function leafWeight(node: SizedNode): number {
  if (node.children.length === 0) return 1
  return node.children.reduce((total, child) => total + leafWeight(child), 0)
}

/** Characters that take a full em: CJK, Hangul, full-width forms, and emoji. */
const WIDE_CHARACTER =
  /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u2600-\u27BF\u{1F000}-\u{1FAFF}]/u

/** A label's width, from its characters. `bold` is what the node will actually be drawn at. */
function measureText(text: string, bold = false): number {
  const factor = bold ? 0.59 : 0.56
  let width = 0
  for (const character of text) {
    width += WIDE_CHARACTER.test(character) ? FONT_SIZE : FONT_SIZE * factor
  }
  return width
}

/**
 * Break a label into lines. Words are kept whole where they fit; a word wider than the box
 * (a URL, or Chinese text with no spaces) is broken by character.
 */
function wrapLabel(label: string, bold = false): string[] {
  const lines: string[] = []

  for (const paragraph of label.split('\n')) {
    const text = paragraph.trim()
    if (text.length === 0) {
      lines.push('')
      continue
    }

    let line = ''
    let lineWidth = 0
    const push = () => {
      lines.push(line.trimEnd())
      line = ''
      lineWidth = 0
    }

    for (const token of text.split(/(\s+)/)) {
      if (token.length === 0) continue

      if (/^\s+$/.test(token)) {
        if (line.length > 0 && !line.endsWith(' ')) {
          line += ' '
          lineWidth += measureText(' ', bold)
        }
        continue
      }

      const tokenWidth = measureText(token, bold)
      if (lineWidth + tokenWidth > MAX_TEXT_WIDTH && line.trim().length > 0) push()

      if (tokenWidth <= MAX_TEXT_WIDTH) {
        line += token
        lineWidth += tokenWidth
        continue
      }

      for (const character of token) {
        const characterWidth = measureText(character, bold)
        if (lineWidth + characterWidth > MAX_TEXT_WIDTH && line.length > 0) push()
        line += character
        lineWidth += characterWidth
      }
    }

    if (line.trim().length > 0 || lines.length === 0) push()
  }

  if (lines.length > MAX_LINES_PER_NODE) {
    const clipped = lines.slice(0, MAX_LINES_PER_NODE)
    clipped[MAX_LINES_PER_NODE - 1] = `${clipped[MAX_LINES_PER_NODE - 1] ?? ''}…`
    return clipped
  }

  return lines.length > 0 ? lines : ['']
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}
