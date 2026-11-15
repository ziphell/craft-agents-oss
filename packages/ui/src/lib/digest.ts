/**
 * A short digest of a document, for a selection that has to name the version it came from.
 *
 * `sha256` over the text, cut to eight characters. Eight is not a security boundary and is not
 * meant to be one: it answers "is this still the file I selected in", where a collision between two
 * versions eight hex digits apart is a coincidence nobody produces by editing.
 *
 * Web Crypto is available in the renderer and in the Web UI alike; the fallback exists because a
 * non-secure context (an `http://` hub) has no `crypto.subtle`. A digest that cannot be computed is
 * reported as empty — a selection without a version is weaker, but one that cannot be sent at all
 * is worse.
 */
export async function digestOf(text: string): Promise<string> {
  try {
    const bytes = new TextEncoder().encode(text)
    const hashed = await crypto.subtle.digest('SHA-256', bytes)
    return [...new Uint8Array(hashed)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 8)
  } catch {
    return ''
  }
}
