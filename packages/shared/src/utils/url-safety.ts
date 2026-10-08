/**
 * Classification of external URLs for `shell.openExternal`-style handlers.
 *
 * We use a blocklist instead of an allowlist: the OS only dispatches URL
 * schemes that have a registered handler, so passing through
 * `obsidian://`, `vscode://`, etc. is safe in practice. Known-dangerous
 * schemes (XSS primitives and `file:` as an RCE vector on Windows) stay
 * explicitly blocked, with a per-scheme reason so blocked attempts produce a
 * useful error message instead of a generic "Invalid URL".
 */

export type UrlClassification =
  | { kind: 'dangerous'; scheme?: string; reason: string }
  | { kind: 'internal-deeplink' }
  | { kind: 'safe-external' }

/**
 * Blocked URL schemes (including trailing `:`) mapped to a human-readable
 * reason. The reason flows through to the toast users see when a blocked
 * URL gets clicked, so it should explain *why* not just *what*.
 */
const DANGEROUS_SCHEMES: ReadonlyMap<string, string> = new Map([
  ['javascript:', 'JavaScript URLs can execute arbitrary code in the renderer (XSS vector).'],
  ['data:', 'data: URLs can embed executable content and bypass scheme restrictions.'],
  ['vbscript:', 'VBScript URLs are a legacy script-execution vector.'],
  ['blob:', 'blob: URLs are renderer-scoped and do not resolve outside this window.'],
  [
    'file:',
    'file: URLs are blocked because shell.openExternal can launch local executables on Windows (Electron RCE class). Use an in-app preview block (html-preview, pdf-preview, image-preview, markdown-preview) or open the file from your OS file manager.',
  ],
])

const INTERNAL_DEEPLINK_SCHEME = 'craftagents:'

export function classifyExternalUrl(rawUrl: string): UrlClassification {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    return { kind: 'dangerous', reason: 'URL is empty or whitespace-only.' }
  }

  let parsed: URL
  try {
    parsed = new URL(rawUrl.trim())
  } catch {
    return { kind: 'dangerous', reason: 'URL is malformed and cannot be parsed.' }
  }

  const protocol = parsed.protocol.toLowerCase()

  const blockedReason = DANGEROUS_SCHEMES.get(protocol)
  if (blockedReason) {
    return { kind: 'dangerous', scheme: protocol, reason: blockedReason }
  }

  if (protocol === INTERNAL_DEEPLINK_SCHEME) {
    return { kind: 'internal-deeplink' }
  }

  return { kind: 'safe-external' }
}

export function isSafeExternalUrl(rawUrl: string): boolean {
  return classifyExternalUrl(rawUrl).kind === 'safe-external'
}

/**
 * Whether an address is one a browser window can hold: `http:` or `https:`, and nothing else.
 *
 * A tab shows a page; what it is *given* is an address, and only these two are addresses it can
 * load. Not the same question as `isSafeExternalUrl`: `mailto:`, `tel:` and someone else's app
 * scheme (`obsidian:`, `vscode:`) are all safe to hand to the operating system, and none of them
 * is something to open in a window. Where a link goes is decided with both: a browser address may
 * go either way, anything else only to the OS.
 */
export function isBrowserUrl(rawUrl: string): boolean {
  try {
    const protocol = new URL(rawUrl.trim()).protocol
    // `craft-local` is the app's own origin — a design's folder, the diagram editor —
    // served by a host in this process. It is allowed here so a design can be opened
    // as a tab and read or driven with the browser tools; the host itself decides what
    // a page on that origin may fetch (a design's data/ is never served).
    return protocol === 'http:' || protocol === 'https:' || protocol === 'craft-local:'
  } catch {
    return false
  }
}

/**
 * Format a `dangerous` classification into a user-facing error message.
 * Returns an empty string for non-dangerous classifications.
 */
export function formatBlockedUrlError(classification: UrlClassification): string {
  if (classification.kind !== 'dangerous') return ''
  const suffix = classification.scheme ? ` (${classification.scheme})` : ''
  return `URL blocked${suffix}. ${classification.reason}`
}
