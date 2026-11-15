/**
 * One HTML file that travels: every local picture and stylesheet inlined as a data URL.
 *
 * The point is a file somebody can double-click on a machine that has none of this. It is a
 * **copy**, and the source is never touched — a page whose `src` attributes turned into megabytes
 * of base64 would be unreadable as source and would break the agent's own edits to it (the reason
 * GenOffice's single-file export works the same way).
 *
 * Three rules worth stating:
 *
 * - **Only local references.** `http(s)`, `data:` and `blob:` are left alone: they resolve wherever
 *   the file is opened, and fetching them here would make an export depend on the network.
 * - **A missing file is left as it was**, not replaced with a placeholder. An export that silently
 *   drops a picture is harder to notice than one that still points at a path.
 * - **A budget.** Images are the bulk of any page; past the limit the reference is left alone and
 *   the caller says what was skipped, rather than producing a 200 MB file nobody can open.
 *
 * The scanning is textual (attribute and `url()` positions) rather than a DOM round trip, because
 * the output has to stay structurally identical to the input apart from the substitutions — a
 * serializer that re-prints the document would quietly rewrite styles, entities and scripts.
 */

/** Resolves a reference from the document to something embeddable, or null to leave it alone. */
export type LocalAssetReader = (reference: string) => { mime: string; bytes: Uint8Array } | null

export interface InlineOptions {
  /** Total bytes of embedded assets allowed. Past this, references stay as they are. */
  maxBytes?: number
}

export interface InlineResult {
  html: string
  /** How many references were embedded, and how many were left alone (missing or over budget). */
  inlined: number
  skipped: number
  bytes: number
}

const DEFAULT_MAX_BYTES = 24 * 1024 * 1024

/** `src="…"` / `href="…"` on the elements that fetch something. */
const ATTRIBUTE = /<(img|image|script|link|source|video|audio|iframe)\b([^>]*?)\b(src|href|xlink:href)\s*=\s*("([^"]*)"|'([^']*)')/gi

/** CSS `url(…)`, in stylesheets and in `style` attributes alike. */
const CSS_URL = /url\(\s*("([^"]*)"|'([^']*)'|([^)'"]*))\s*\)/gi

export function isRemoteReference(reference: string): boolean {
  return /^(?:[a-z]+:|\/\/|#)/i.test(reference.trim())
}

function dataUrl(mime: string, bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  // `btoa` over the whole buffer at once overflows the argument limit on a large image.
  return `data:${mime};base64,${btoa(binary)}`
}

/**
 * Inline every local reference the reader can resolve.
 *
 * `read` is handed the reference exactly as the document wrote it (a relative path, usually) and
 * answers the bytes, which keeps the path policy — and the folder it counts from — with the caller.
 */
export function inlineLocalAssets(
  html: string,
  read: LocalAssetReader,
  options: InlineOptions = {},
): InlineResult {
  const budget = options.maxBytes ?? DEFAULT_MAX_BYTES
  let inlined = 0
  let skipped = 0
  let bytes = 0

  const embed = (reference: string): string | null => {
    const value = reference.trim()
    if (!value || isRemoteReference(value)) return null
    const asset = read(value)
    if (!asset) {
      skipped += 1
      return null
    }
    if (bytes + asset.bytes.byteLength > budget) {
      skipped += 1
      return null
    }
    bytes += asset.bytes.byteLength
    inlined += 1
    return dataUrl(asset.mime, asset.bytes)
  }

  const withAttributes = html.replace(
    ATTRIBUTE,
    (match, tag: string, attributes: string, name: string, quoted: string, double: string, single: string) => {
      const reference = double ?? single ?? ''
      const embedded = embed(reference)
      if (!embedded) return match
      const quote = quoted.startsWith("'") ? "'" : '"'
      return `<${tag}${attributes} ${name}=${quote}${embedded}${quote}`
    },
  )

  const withCss = withAttributes.replace(CSS_URL, (match, quoted: string, double: string, single: string, bare: string) => {
    const reference = double ?? single ?? bare ?? ''
    const embedded = embed(reference)
    return embedded ? `url("${embedded}")` : match
  })

  return { html: withCss, inlined, skipped, bytes }
}
