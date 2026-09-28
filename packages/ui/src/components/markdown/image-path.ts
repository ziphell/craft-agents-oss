/**
 * Where a picture in a document comes from.
 *
 * A markdown document on disk can name a picture beside it — `![](shots/cart.png)`. Outside
 * this app that works: a markdown renderer resolves a relative destination against the
 * document's own folder. Inside, it does not — the destination reaches the browser as an
 * `<img src>`, which is resolved against the *renderer's* origin rather than the document's
 * folder, so the picture is a request that never reaches the file.
 *
 * So resolution is a fact about the document, not about the URL: the caller knows which
 * folder the document is in (`baseDir`), and this turns a relative destination into the
 * absolute path the host's file read takes. It is deliberately **only** the relative case —
 * an `http(s)`/`data` destination is already something a browser can fetch, and an absolute
 * path or a `file:` URL is not this shape, so those are left exactly as they were.
 *
 * Nothing here decides whether a read is allowed. The host's file read keeps its own
 * boundary, and a resolved path is still subject to it — resolving a `../` escape is
 * precisely what that boundary is for.
 */

/** The folder a file lives in, spelled the way the file's own path is spelled. */
export function documentDir(filePath: string): string {
  const cut = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  return cut > 0 ? filePath.slice(0, cut) : filePath
}

/**
 * Whether a markdown image destination names a file beside the document.
 *
 * False for everything a browser fetches on its own (`https:`, `data:`, …), for an absolute
 * path (`/…`, `C:\…`, `\\server\…`) and for a fragment: none of them means "beside the
 * document", so none of them is this function's business.
 */
function isRelativeDestination(src: string): boolean {
  if (src.startsWith('/') || src.startsWith('\\')) return false
  if (src.startsWith('#')) return false
  if (/^[A-Za-z]:[\\/]/.test(src)) return false
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(src)) return false
  return true
}

/**
 * The absolute path a relative image destination names — or `null` when the destination is
 * not one this resolves.
 *
 * `null` is the whole answer for a document with no folder (a message in a conversation) and
 * for a destination that is already a URL; the caller then renders the destination as it is,
 * which is what it did before.
 */
export function resolveDocumentImagePath(
  baseDir: string | undefined,
  src: string | undefined,
): string | null {
  if (!baseDir || !src || !isRelativeDestination(src)) return null
  const separator = baseDir.includes('\\') ? '\\' : '/'
  return `${baseDir.replace(/[\\/]+$/, '')}${separator}${src}`
}
