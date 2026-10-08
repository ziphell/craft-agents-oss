/**
 * Design mentions — one of the workspace's designs, carried inside the composer's text.
 *
 * The same shape as `tab-mention`: the composer's value is a plain string (see
 * `rich-text-input`), so a design travels as `[design:<slug>|<name>]` with both parts
 * percent-encoded — the payload must contain no `]`, and a design name may.
 *
 * A design is workspace-level: it lives in the workspace's `designs/` folder, not inside any
 * one conversation. So the way to bring one up is to reference it, from any composer — "keep
 * working on this one". The slug is the identity (it is what `get_design`/`update_design`
 * take), and the name is what makes the chip readable.
 *
 * The marker is what the composer renders as a chip and what the message stores, exactly like
 * `[source:...]` and `[skill:...]`: the store keeps the marker so the chip can be redrawn from
 * it, the UI hides it behind a badge, and the agent rewrites it into a readable reference at
 * the model boundary (`resolveDesignMentions`, called from base-agent alongside the other
 * resolvers). The live format lives here, in shared, because both sides read it.
 */

export interface DesignRef {
  /** The design's slug — what the design tools take. */
  slug: string
  /** The design's own name, shown as the chip's label. May be empty. */
  name: string
}

export interface DesignMention {
  ref: DesignRef
  /** The marker's payload, encoded — what consumers that cannot take an object (mentions.ts) key on. */
  payload: string
  /** The whole `[design:...]` marker, as it appears in the text. */
  fullMatch: string
  startIndex: number
}

const MARKER_RE = /\[design:([^\]]+)\]/g

/** Build the marker a design is inserted as. */
export function buildDesignMention(ref: DesignRef): string {
  return `[design:${encodeURIComponent(ref.slug)}|${encodeURIComponent(ref.name)}]`
}

/**
 * Read a marker's payload back into a design reference.
 *
 * Returns null for a payload that is not one of ours — a draft is user-editable text, so a
 * clipped or hand-typed marker has to render as plain text rather than as a chip that stands
 * for nothing.
 */
export function parseDesignMention(payload: string): DesignRef | null {
  const parts = payload.split('|')
  if (parts.length < 2) return null

  let decoded: string[]
  try {
    decoded = parts.map((part) => decodeURIComponent(part))
  } catch {
    return null
  }

  const [slug, name] = decoded
  if (!slug) return null
  return { slug, name: name ?? '' }
}

/** What the chip shows: the design's name, and its slug when the name says nothing. */
export function designLabel(ref: DesignRef): string {
  return ref.name.trim() || ref.slug
}

/** All design markers in a text, in order, with positions for splicing. */
export function findDesignMentions(text: string): DesignMention[] {
  const mentions: DesignMention[] = []
  const pattern = new RegExp(MARKER_RE.source, 'g')

  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const payload = match[1]!
    const ref = parseDesignMention(payload)
    if (!ref) continue
    mentions.push({ ref, payload, fullMatch: match[0], startIndex: match.index })
  }

  return mentions
}

/**
 * Rewrite every marker into the reference the model reads.
 *
 * `[design:cart|Cart]` → `[Mentioned design: Cart (slug: cart)]`
 *
 * The model-facing half of the reference: the composer keeps the marker (so the chip can be
 * redrawn), and the agent rewrites it here, the way it already does for sources and skills.
 * The slug is always in the reference — the name may have changed, and the slug is what the
 * design tools take. A malformed marker is left untouched.
 */
export function resolveDesignMentions(text: string): string {
  return text.replace(new RegExp(MARKER_RE.source, 'g'), (full, payload: string) => {
    const ref = parseDesignMention(payload)
    if (!ref) return full
    return `[Mentioned design: ${designLabel(ref)} (slug: ${ref.slug})]`
  })
}
