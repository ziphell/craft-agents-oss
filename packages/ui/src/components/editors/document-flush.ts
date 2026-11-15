/**
 * "Save what you are holding" — the editors' end of it.
 *
 * An editor writes its file on a debounce, so the file is a moment behind the screen; while
 * somebody keeps typing it stays behind for as long as they do. That is invisible to the person —
 * they are looking at the editor — and it matters to anything that reads the *file*: the agent, an
 * export, a poster. Before such a read, the host asks for a flush and this is where it lands.
 *
 * A registry rather than context because the ask arrives from outside React — a capability call on
 * the preload, decanted into the page — and the answer has to come back through it as a promise.
 * The editor is the only thing that knows how to save itself; nothing here understands documents.
 */

/**
 * What saving looks like from here: **did the file end up holding what the editor holds?**
 *
 * Not "did the save call finish". A save that was declined — an editor in a conflict, a write that
 * failed — is not a save, and a caller that read the file after one would read the past and never
 * know. `false` is the honest answer, and the caller can decide what to do about it.
 */
type Flusher = () => Promise<boolean>

const flushers = new Map<string, Set<Flusher>>()

/**
 * How two paths are decided to be the same document.
 *
 * Deliberately loose: separators unified and case folded, always. A false positive means one extra
 * editor saves a file it was already going to save; a false negative means a flush silently does
 * nothing and the agent reads a stale file — the failure this module exists to prevent. The host
 * compares exactly (`office/open-documents.ts`), and it is the host that decides *which* path to
 * ask about, so the two never have to agree on anything subtler than this.
 */
function keyOf(path: string): string {
  return path.trim().replace(/\\/g, '/').toLowerCase()
}

/**
 * Register one editor's save, for as long as it is showing that path. Returns the way to stop.
 *
 * Several editors can hold the same file (a window and a conversation block), so the registry is a
 * set: a flush asks all of them, and every one of them has to be able to save.
 */
export function registerDocumentFlusher(path: string, flush: Flusher): () => void {
  const key = keyOf(path)
  const entry = flushers.get(key) ?? new Set<Flusher>()
  entry.add(flush)
  flushers.set(key, entry)
  return () => {
    const current = flushers.get(key)
    if (!current) return
    current.delete(flush)
    if (current.size === 0) flushers.delete(key)
  }
}

/**
 * Save everything showing `path`. `true` when the file now holds what the editors hold.
 *
 * `false` is a real answer, not a failure to report as one: an editor in a conflict cannot save
 * itself (`useFileWriter` refuses rather than overwrite), and `true` because *nobody* was showing
 * the file would be a lie — the caller is asking about a document somebody said was open.
 */
export async function flushDocument(path: string): Promise<boolean> {
  const waiting = flushers.get(keyOf(path))
  if (!waiting || waiting.size === 0) return false
  try {
    const answered = await Promise.all([...waiting].map((flush) => flush()))
    // Every editor showing this file has to have saved it: one that is behind means the file is too.
    return answered.every((ok) => ok === true)
  } catch {
    return false
  }
}

/** Test seam. */
export function clearDocumentFlushers(): void {
  flushers.clear()
}
