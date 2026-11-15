/**
 * Thumbnail bytes, kept for the life of the window.
 *
 * A card scrolled out of view and back would otherwise ask the host for the same picture or the
 * same transcript again. The key carries the file's modified time, so an edited file is read fresh;
 * the map is bounded so a large library cannot grow it without limit.
 */

const MAX_ENTRIES = 160

/** How much of a text file a card previews. One number, so two cards on one file agree. */
export const TEXT_PREVIEW_BYTES = 8192

function remember(cache: Map<string, string>, key: string, value: string): string {
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(key, value)
  return value
}

const dataUrlCache = new Map<string, string>()
const textCache = new Map<string, string>()

export function cachedDataUrl(key: string, read: () => Promise<string>): Promise<string> {
  const hit = dataUrlCache.get(key)
  if (hit !== undefined) return Promise.resolve(hit)
  return read().then((value) => remember(dataUrlCache, key, value))
}

export function cachedText(key: string, read: () => Promise<string>): Promise<string> {
  const hit = textCache.get(key)
  if (hit !== undefined) return Promise.resolve(hit)
  return read().then((value) => remember(textCache, key, value))
}
