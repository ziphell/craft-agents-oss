/**
 * The bytes of the PDFs a conversation has shown, under a hard budget.
 *
 * Why this is shared rather than per block: a block used to hold its own copy and give it back only
 * when it left the viewport, which meant scrolling up and down re-read the same file each time —
 * and a block that stayed on screen kept its bytes for as long as the session view lived. There is
 * no per-block rule that is both bounded and steady, because the bound is a property of the *view*,
 * not of one block.
 *
 * So the budget is here, and it is a real one: the least recently used file goes when the total
 * passes it. **A file larger than the whole budget is still stored, alone** — the alternative is a
 * block that cannot draw what it was asked to draw, which is worse than briefly holding more than
 * promised. That is the only way usage exceeds the ceiling, and it is bounded by the largest single
 * file.
 *
 * What the number does *not* cover: `react-pdf` transfers the buffer it is handed, so the `<Document>`
 * mounts with its own copy. Holding a file costs about twice its size, and a drawn page adds a
 * canvas. `PDF_CACHE_BUDGET` is set with that in mind — it bounds the cache, and the copy beside each
 * live one is what the constant is sized against.
 *
 * **A file on screen is pinned and is never evicted.** Without that, an eviction can take the file a
 * person is looking at; its block re-reads it, which evicts something else, which may be the other
 * visible block — two files larger than the budget would chase each other forever. Pinning makes the
 * ceiling "the budget, plus what is currently on screen", which is the only version of this rule that
 * terminates.
 *
 * Listeners are per file: a block subscribes to the file it shows and hears about it when the entry
 * is evicted, which is its cue to unmount the `<Document>` — dropping the copy and the parse with it.
 * A cache that evicted silently would leave the very memory this module exists to bound.
 */

/** About twice this is resident (see the note above), plus one canvas per drawn page. */
export const PDF_CACHE_BUDGET = 32 * 1024 * 1024

/**
 * How many files may be held at all.
 *
 * **The byte budget alone under-counts a conversation full of small documents.** Every held file
 * keeps a mounted `<Document>` — a pdf.js parse plus a canvas of the drawn page (a 500×707 page is
 * about 1.4 MB of pixels) — and neither appears in `byteLength`. Twenty 100 KB invoices are 2 MB of
 * bytes and 28 MB of canvases, so a byte budget would keep every one of them and call it 2 MB.
 *
 * A count is the honest bound for that fixed cost; the budget stays for the other failure — one
 * enormous scan.
 */
export const PDF_CACHE_MAX_FILES = 6

interface Entry {
  bytes: Uint8Array
  /** Monotonic tick of the last time this file was read or looked at; the order eviction follows. */
  used: number
}

const entries = new Map<string, Entry>()
const listeners = new Map<string, Set<() => void>>()
let maxFiles = PDF_CACHE_MAX_FILES
/** Files some block is showing right now; ref-counted, because two blocks may show one file. */
const pins = new Map<string, number>()
let budget = PDF_CACHE_BUDGET
let tick = 0
let totalBytes = 0

function notify(src: string): void {
  const set = listeners.get(src)
  if (!set) return
  for (const listener of set) listener()
}

/**
 * Re-read a file's place in the line, without changing it.
 *
 * Called while a block is on screen: the thing a person is looking at should not be the thing that
 * goes next.
 */
export function touchPdfBytes(src: string): void {
  const entry = entries.get(src)
  if (!entry) return
  entry.used = ++tick
}

/**
 * Hold this file's bytes, evicting whatever has gone longest unused to make room.
 *
 * Returns whether the bytes are now the ones the cache holds (a re-read of the same file keeps the
 * first copy — two references to the same content are told apart by nothing, so the first is kept).
 */
export function retainPdfBytes(src: string, bytes: Uint8Array): boolean {
  const existing = entries.get(src)
  if (existing) {
    existing.used = ++tick
    return true
  }
  entries.set(src, { bytes, used: ++tick })
  totalBytes += bytes.byteLength
  evictUntilWithinBudget(src)
  return true
}

/**
 * Give a file back — the block is unmounting, or its message is gone.
 *
 * `touchPdfBytes` covers "out of sight but still useful"; this is "no longer anyone's business".
 */
export function releasePdfBytes(src: string): void {
  const entry = entries.get(src)
  if (!entry) return
  entries.delete(src)
  totalBytes -= entry.bytes.byteLength
  notify(src)
}

/**
 * This file is on screen: it does not go, whatever the budget says.
 *
 * Ref-counted so two blocks showing the same document pin it once each.
 */
export function pinPdfBytes(src: string): void {
  pins.set(src, (pins.get(src) ?? 0) + 1)
}

/** The block stopped showing it (scrolled away, or unmounted). */
export function unpinPdfBytes(src: string): void {
  const count = (pins.get(src) ?? 0) - 1
  if (count > 0) pins.set(src, count)
  else pins.delete(src)
}

/** The bytes for this file, if they are still held. */
export function getPdfBytes(src: string): Uint8Array | undefined {
  return entries.get(src)?.bytes
}

/** Hear when this file's entry is dropped (or added). */
export function subscribePdfBytes(src: string, listener: () => void): () => void {
  let set = listeners.get(src)
  if (!set) {
    set = new Set()
    listeners.set(src, set)
  }
  set.add(listener)
  return () => {
    set.delete(listener)
    if (set.size === 0) listeners.delete(src)
  }
}

function overBudget(): boolean {
  return totalBytes > budget || entries.size > maxFiles
}

function evictUntilWithinBudget(justRetained: string): void {
  if (!overBudget()) return
  const byAge = [...entries.entries()]
    .filter(([src]) => src !== justRetained && !pins.has(src))
    .sort((a, b) => a[1].used - b[1].used)
  for (const [src, entry] of byAge) {
    if (!overBudget()) break
    entries.delete(src)
    totalBytes -= entry.bytes.byteLength
    notify(src)
  }
}

/** What is held, for tests and for a host that wants to show it. */
export function pdfCacheUsage(): {
  totalBytes: number
  budgetBytes: number
  maxFiles: number
  files: { src: string; bytes: number; pinned: boolean }[]
} {
  return {
    totalBytes,
    budgetBytes: budget,
    maxFiles,
    files: [...entries.entries()]
      .sort((a, b) => b[1].used - a[1].used)
      .map(([src, entry]) => ({ src, bytes: entry.bytes.byteLength, pinned: pins.has(src) })),
  }
}

/** For tests: change the budget and let the cache shrink to it. */
export function setPdfCacheBudget(bytes: number, files = maxFiles): void {
  budget = bytes
  maxFiles = files
  evictUntilWithinBudget('')
}

/** For tests: forget everything, so one case cannot decide the next one's answer. */
export function clearPdfCache(): void {
  for (const src of [...entries.keys()]) releasePdfBytes(src)
  listeners.clear()
  pins.clear()
  budget = PDF_CACHE_BUDGET
  maxFiles = PDF_CACHE_MAX_FILES
  tick = 0
  totalBytes = 0
}
