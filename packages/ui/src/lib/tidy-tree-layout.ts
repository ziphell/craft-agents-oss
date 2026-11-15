/**
 * A tidy tree layout, ported from `non-layered-tidy-tree-layout` 2.0.2.
 *
 * MIT License, Copyright (c) 2019 Michael Wong —
 * https://github.com/stetrevor/non-layered-tidy-tree-layout, itself a port of
 * https://github.com/cwi-swat/non-layered-tidy-trees. The algorithm is A.J. van der Ploeg's
 * *Drawing Non-layered Tidy Trees in Linear Time*, unchanged.
 *
 * Vendored rather than depended on for two reasons: the package's `main` is a UMD bundle that
 * dereferences `window` on load (so it cannot be imported by `bun test` or any non-DOM context,
 * and the app had to reach into `src/index.js` — a private path), and it is seven years old with
 * no types. The whole of it is this file, and the app is a renderer: owning the layout is
 * cheaper than owning an unmaintained dependency's internals.
 *
 * What the app uses is `Layout`: hand it a tree whose nodes state `width`/`height`, and it writes
 * `x`/`y` back onto that same tree, plus the box that encloses the result.
 */

export interface TidyTreeData {
  width: number
  height: number
  children: TidyTreeData[]
  x?: number
  y?: number
}

export interface TidyBoundingBox {
  left: number
  right: number
  top: number
  bottom: number
}

/** One node as the algorithm sees it: a box, a level, and its children. */
class Tree {
  w: number
  h: number
  y: number
  c: Tree[]
  cs: number
  x = 0
  prelim = 0
  mod = 0
  shift = 0
  change = 0
  tl: Tree | null = null // left thread
  tr: Tree | null = null // right thread
  el: Tree | null = null // extreme left node
  er: Tree | null = null // extreme right node
  msel = 0 // sum of modifiers at the extreme left node
  mser = 0 // sum of modifiers at the extreme right node

  constructor(width: number, height: number, y: number, children: Tree[]) {
    this.w = width
    this.h = height
    this.y = y
    this.c = children
    this.cs = children.length
  }
}

class IYL {
  constructor(
    readonly lowY: number,
    readonly index: number,
    readonly next: IYL | null,
  ) {}
}

function setExtremes(tree: Tree): void {
  if (tree.cs === 0) {
    tree.el = tree
    tree.er = tree
    tree.msel = tree.mser = 0
  } else {
    const first = tree.c[0]!
    const last = tree.c[tree.cs - 1]!
    tree.el = first.el
    tree.msel = first.msel
    tree.er = last.er
    tree.mser = last.mser
  }
}

function bottom(tree: Tree): number {
  return tree.y + tree.h
}

/** A linked list of the indexes of left siblings and their lowest vertical coordinate. */
function updateIYL(minY: number, index: number, head: IYL | null): IYL {
  let ih = head
  while (ih !== null && minY >= ih.lowY) ih = ih.next
  return new IYL(minY, index, ih)
}

function distributeExtra(tree: Tree, i: number, si: number, distance: number): void {
  // Are there intermediate children?
  if (si !== i - 1) {
    const nr = i - si
    tree.c[si + 1]!.shift += distance / nr
    tree.c[i]!.shift -= distance / nr
    tree.c[i]!.change -= distance - distance / nr
  }
}

function moveSubtree(tree: Tree, i: number, si: number, distance: number): void {
  const child = tree.c[i]!
  child.mod += distance
  child.msel += distance
  child.mser += distance
  distributeExtra(tree, i, si, distance)
}

function nextLeftContour(tree: Tree): Tree | null {
  return tree.cs === 0 ? tree.tl : tree.c[0]!
}

function nextRightContour(tree: Tree): Tree | null {
  return tree.cs === 0 ? tree.tr : tree.c[tree.cs - 1]!
}

function setLeftThread(tree: Tree, i: number, cl: Tree, modsumcl: number): void {
  const li = tree.c[0]!.el!
  li.tl = cl
  // Change mod so that the sum of modifiers after following the thread is correct.
  const diff = modsumcl - cl.mod - tree.c[0]!.msel
  li.mod += diff
  // Change the preliminary x coordinate so that the node does not move.
  li.prelim -= diff
  // Update the extreme node and its sum of modifiers.
  tree.c[0]!.el = tree.c[i]!.el
  tree.c[0]!.msel = tree.c[i]!.msel
}

/** Symmetrical to `setLeftThread`. */
function setRightThread(tree: Tree, i: number, sr: Tree, modsumsr: number): void {
  const ri = tree.c[i]!.er!
  ri.tr = sr
  const diff = modsumsr - sr.mod - tree.c[i]!.mser
  ri.mod += diff
  ri.prelim -= diff
  tree.c[i]!.er = tree.c[i - 1]!.er
  tree.c[i]!.mser = tree.c[i - 1]!.mser
}

function separate(tree: Tree, i: number, ih: IYL): void {
  // Right contour node of left siblings and its sum of modifiers.
  let sr: Tree | null = tree.c[i - 1]!
  let mssr = sr.mod
  // Left contour node of right siblings and its sum of modifiers.
  let cl: Tree | null = tree.c[i]!
  let mscl = cl.mod
  let contour = ih

  while (sr !== null && cl !== null) {
    if (bottom(sr) > contour.lowY) contour = contour.next!
    // How far to the right of the left sibling's right side is the right sibling's left side.
    const distance = mssr + sr.prelim + sr.w - (mscl + cl.prelim)
    if (distance > 0) {
      mscl += distance
      moveSubtree(tree, i, contour.index, distance)
    }
    const sy = bottom(sr)
    const cy = bottom(cl)
    if (sy <= cy) {
      sr = nextRightContour(sr)
      if (sr !== null) mssr += sr.mod
    }
    if (sy >= cy) {
      cl = nextLeftContour(cl)
      if (cl !== null) mscl += cl.mod
    }
  }

  // Set threads and update extreme nodes.
  if (sr === null && cl !== null) setLeftThread(tree, i, cl, mscl)
  else if (sr !== null && cl === null) setRightThread(tree, i, sr, mssr)
}

function positionRoot(tree: Tree): void {
  // Position the root between its children, taking their modifiers into account.
  const first = tree.c[0]!
  const last = tree.c[tree.cs - 1]!
  tree.prelim = (first.prelim + first.mod + last.mod + last.prelim + last.w) / 2 - tree.w / 2
}

function firstWalk(tree: Tree): void {
  if (tree.cs === 0) {
    setExtremes(tree)
    return
  }

  firstWalk(tree.c[0]!)
  let ih = updateIYL(bottom(tree.c[0]!.el!), 0, null)
  for (let i = 1; i < tree.cs; i += 1) {
    firstWalk(tree.c[i]!)
    const minY = bottom(tree.c[i]!.er!)
    separate(tree, i, ih)
    ih = updateIYL(minY, i, ih)
  }
  positionRoot(tree)
  setExtremes(tree)
}

function addChildSpacing(tree: Tree): void {
  let d = 0
  let modsumdelta = 0
  for (let i = 0; i < tree.cs; i += 1) {
    const child = tree.c[i]!
    d += child.shift
    modsumdelta += d + child.change
    child.mod += modsumdelta
  }
}

function secondWalk(tree: Tree, modsum: number): void {
  const sum = modsum + tree.mod
  // Absolute (not relative) horizontal coordinates.
  tree.x = tree.prelim + sum
  addChildSpacing(tree)
  for (let i = 0; i < tree.cs; i += 1) secondWalk(tree.c[i]!, sum)
}

function runLayout(tree: Tree): void {
  firstWalk(tree)
  secondWalk(tree, 0)
}

export class BoundingBox {
  constructor(
    readonly gap: number,
    readonly bottomPadding: number,
  ) {}

  addBoundingBox(width: number, height: number): { width: number; height: number } {
    return { width: width + this.gap, height: height + this.bottomPadding }
  }

  /** The coordinate without the bounding box for a node. */
  removeBoundingBox(x: number, y: number): { x: number; y: number } {
    return { x: x + this.gap / 2, y }
  }
}

export class Layout {
  constructor(private readonly box: BoundingBox) {}

  layout<T extends TidyTreeData>(treeData: T): { result: T; boundingBox: TidyBoundingBox } {
    const tree = this.convert(treeData, 0)
    runLayout(tree)
    const { result, boundingBox } = this.assignLayout(tree, treeData)
    return { result: result as T, boundingBox }
  }

  /** The tree the algorithm wants: each node's box grown by the bounding box's paddings. */
  private convert(treeData: TidyTreeData, y: number): Tree {
    const { width, height } = this.box.addBoundingBox(treeData.width, treeData.height)
    const children: Tree[] = []
    for (let i = 0; i < treeData.children.length; i += 1) {
      children[i] = this.convert(treeData.children[i]!, y + height)
    }
    return new Tree(width, height, y, children)
  }

  private assignLayout(
    tree: Tree,
    treeData: TidyTreeData,
    box: TidyBoundingBox | null = null,
  ): { result: TidyTreeData; boundingBox: TidyBoundingBox } {
    const { x, y } = this.box.removeBoundingBox(tree.x, tree.y)
    treeData.x = x
    treeData.y = y

    const { width, height } = treeData
    const bounds = box ?? { left: x, right: x + width, top: y, bottom: y + height }
    bounds.left = Math.min(bounds.left, x)
    bounds.right = Math.max(bounds.right, x + width)
    bounds.top = Math.min(bounds.top, y)
    bounds.bottom = Math.max(bounds.bottom, y + height)

    for (let i = 0; i < tree.c.length; i += 1) {
      this.assignLayout(tree.c[i]!, treeData.children[i]!, bounds)
    }

    return { result: treeData, boundingBox: bounds }
  }
}
