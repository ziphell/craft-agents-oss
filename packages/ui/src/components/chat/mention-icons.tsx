/**
 * The one icon a mention chip shows, per kind.
 *
 * A reference of a given kind is drawn by three surfaces — the composer's chip, the sent
 * message's badge, and the @ menu's row — and each used to carry its own copy: three different
 * skill fallbacks (a sparkles glyph, a Zap, and the character ✦), two folder shapes, a text
 * character in one place and an SVG in another. The set lives here so a kind looks the same
 * everywhere, and so there is one place to change what a folder (say) looks like.
 *
 * Two shapes are exported from the same paths, because the callers cannot share a React tree:
 * the composer's chip is injected into a `contenteditable` as HTML (`mentionIconSvg`), while
 * the message bubble and the menu are React (`MentionIcon`). Everything is sizeless and paints
 * with `currentColor`, so the caller owns size and colour.
 *
 * A kind's *own* icon — a skill's emoji, a source's logo — is not this. Those arrive on the
 * badge as a data URL (see `extractBadges`) and win over these; only the fallback is shared.
 */

import type { ContentBadge } from '@craft-agent/core'

export type MentionIconKind =
  | 'skill'
  | 'source'
  | 'file'
  | 'fileCode'
  | 'fileImage'
  | 'folder'
  | 'tab'
  | 'design'
  | 'element'

/** Paths only — the `<svg>` shell is added by the two adapters below. */
const PATHS: Record<MentionIconKind, string> = {
  // Lightning bolt (lucide `zap`) — the item's own mark, and what a skill has instead of a kind.
  skill:
    '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
  // Unplug (lucide `unplug`) — a source is something this app is wired into. The globe is the
  // tab's, below: an address is a place, while a source is a connection.
  source:
    '<path d="m19 5 3-3"/><path d="m2 22 3-3"/><path d="M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z"/><path d="M7.5 13.5 10 11"/><path d="M10.5 16.5 13 14"/><path d="m12 6 6 6 2.3-2.3a2.4 2.4 0 0 0 0-3.4l-2.6-2.6a2.4 2.4 0 0 0-3.4 0Z"/>',
  // Document with a folded corner.
  file:
    '<path d="M10.5 2.5C12.1569 2.5 13.5 3.84315 13.5 5.5V6.1C13.5 6.4716 13.5 6.6574 13.5246 6.81287C13.6602 7.66865 14.3313 8.33983 15.1871 8.47538C15.3426 8.5 15.5284 8.5 15.9 8.5H16.5C18.1569 8.5 19.5 9.84315 19.5 11.5M9 16H15M9 12H10M10.9645 2.5H10.6678C8.64635 2.5 7.63561 2.5 6.84835 2.85692C5.96507 3.25736 5.25736 3.96507 4.85692 4.84835C4.5 5.63561 4.5 6.64635 4.5 8.66781V14C4.5 17.2875 4.5 18.9312 5.40796 20.0376C5.57418 20.2401 5.75989 20.4258 5.96243 20.592C7.06878 21.5 8.71252 21.5 12 21.5C15.2875 21.5 16.9312 21.5 18.0376 20.592C18.2401 20.4258 18.4258 20.2401 18.592 20.0376C19.5 18.9312 19.5 17.2875 19.5 14V11.0355C19.5 10.0027 19.5 9.48628 19.4176 8.99414C19.2671 8.09576 18.9141 7.24342 18.3852 6.50177C18.0955 6.09549 17.7303 5.73032 17 5C16.2697 4.26968 15.9045 3.90451 15.4982 3.6148C14.7566 3.08595 13.9042 2.7329 13.0059 2.58243C12.5137 2.5 11.9973 2.5 10.9645 2.5Z"/>',
  // The same document with `<>`, so code reads as code.
  fileCode:
    '<path d="M10.5 2.5C12.1569 2.5 13.5 3.84315 13.5 5.5V6.1C13.5 6.4716 13.5 6.6574 13.5246 6.81287C13.6602 7.66865 14.3313 8.33983 15.1871 8.47538C15.3426 8.5 15.5284 8.5 15.9 8.5H16.5C18.1569 8.5 19.5 9.84315 19.5 11.5M10.5 12.8799C9.70024 13.2985 9.10807 13.8275 8.64232 14.5478C8.51063 14.7515 8.44479 14.8533 8.44489 15.0011C8.44498 15.1488 8.51099 15.2506 8.643 15.4542C9.1095 16.1736 9.70167 16.7028 10.5 17.1225M13.5 12.8799C14.2998 13.2985 14.8919 13.8275 15.3577 14.5478C15.4894 14.7515 15.5552 14.8533 15.5551 15.0011C15.555 15.1488 15.489 15.2506 15.357 15.4542C14.8905 16.1736 14.2983 16.7028 13.5 17.1225M10.9645 2.5H10.6678C8.64635 2.5 7.63561 2.5 6.84835 2.85692C5.96507 3.25736 5.25736 3.96507 4.85692 4.84835C4.5 5.63561 4.5 6.64635 4.5 8.66781V14C4.5 17.2875 4.5 18.9312 5.40796 20.0376C5.57418 20.2401 5.75989 20.4258 5.96243 20.592C7.06878 21.5 8.71252 21.5 12 21.5C15.2875 21.5 16.9312 21.5 18.0376 20.592C18.2401 20.4258 18.4258 20.2401 18.592 20.0376C19.5 18.9312 19.5 17.2875 19.5 14V11.0355C19.5 10.0027 19.5 9.48628 19.4176 8.99414C19.2671 8.09576 18.9141 7.24342 18.3852 6.50177C18.0955 6.09549 17.7303 5.73032 17 5C16.2697 4.26968 15.9045 3.90451 15.4982 3.6148C14.7566 3.08595 13.9042 2.7329 13.0059 2.58243C12.5137 2.5 11.9973 2.5 10.9645 2.5Z"/>',
  // A picture frame with a sun — a file whose content is an image.
  fileImage:
    '<path d="M7.5 9C7.77614 9 8 8.77614 8 8.5C8 8.22386 7.77614 8 7.5 8C7.22386 8 7 8.22386 7 8.5C7 8.77614 7.22386 9 7.5 9Z"/><path d="M20.9998 16.1004L17.9497 13.0503C16.6163 11.7169 15.9496 11.0503 15.1212 11.0503C14.2928 11.0503 13.6261 11.7169 12.2928 13.0503L5.34323 20M10.5 20.5H13.5C17.2712 20.5 19.1569 20.5 20.3284 19.3284C21.5 18.1569 21.5 16.2712 21.5 12.5V11.5C21.5 7.72876 21.5 5.84315 20.3284 4.67157C19.1569 3.5 17.2712 3.5 13.5 3.5H10.5C6.72876 3.5 4.84315 3.5 3.67157 4.67157C2.5 5.84315 2.5 7.72876 2.5 11.5V12.5C2.5 16.2712 2.5 18.1569 3.67157 19.3284C4.84315 20.5 6.72876 20.5 10.5 20.5Z"/>',
  // Open folder.
  folder:
    '<path d="M20.5 10C20.5 9.07003 20.5 8.60504 20.3978 8.22354C20.1204 7.18827 19.3117 6.37962 18.2765 6.10222C17.895 6 17.43 6 16.5 6H13.1008C12.4742 6 12.1609 6 11.8739 5.91181C11.6824 5.85298 11.5009 5.76572 11.3353 5.65295C11.0871 5.48389 10.8914 5.23926 10.5 4.75L10.4095 4.63693C10.107 4.25881 9.9558 4.06975 9.7736 3.92674C9.54464 3.74703 9.27921 3.61946 8.99585 3.55294C8.77037 3.5 8.52825 3.5 8.04402 3.5C6.60485 3.5 5.88527 3.5 5.32008 3.74178C4.61056 4.0453 4.0453 4.61056 3.74178 5.32008C3.5 5.88527 3.5 6.60485 3.5 8.04402V10M9.46502 20.5H14.535C16.9102 20.5 18.0978 20.5 18.9301 19.8113C19.7624 19.1226 19.9846 17.9559 20.429 15.6227L20.8217 13.5613C21.1358 11.9121 21.2929 11.0874 20.843 10.5437C20.393 10 19.5536 10 17.8746 10H6.12537C4.44643 10 3.60696 10 3.15704 10.5437C2.70713 11.0874 2.8642 11.9121 3.17835 13.5613L3.57099 15.6227C4.01541 17.9559 4.23763 19.1226 5.06992 19.8113C5.90221 20.5 7.08981 20.5 9.46502 20.5Z"/>',
  // Globe again: a tab is a page, and the address is what tells two apart — same family as a source.
  tab:
    '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  // Frames: a design is a page laid out, not a document.
  design:
    '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/>',
  // Cursor: an element is a thing pointed at on a page.
  element:
    '<path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z"/>',
}

const SVG_OPEN =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">'

/** Markup for a kind, for the composer's chip (which is injected as HTML). Sizeless. */
export function mentionIconSvg(kind: MentionIconKind): string {
  return `${SVG_OPEN}${PATHS[kind]}</svg>`
}

/** The same icon as a node, for the React surfaces (message badge, @ menu). Sizeless. */
export function MentionIcon({ kind, className }: { kind: MentionIconKind; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      dangerouslySetInnerHTML={{ __html: PATHS[kind] }}
    />
  )
}

/** A kind as a component, for `EntityIcon`'s `fallbackIcon` slot. */
export function mentionIconComponent(kind: MentionIconKind) {
  return function Icon({ className }: { className?: string }) {
    return <MentionIcon kind={kind} className={className} />
  }
}

/** Extensions that get the code-file icon rather than the plain one. */
const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'rs', 'go', 'java', 'rb', 'swift', 'kt',
  'c', 'cpp', 'h', 'hpp', 'cs',
  'css', 'scss', 'less', 'html', 'vue', 'svelte',
  'json', 'yaml', 'yml', 'toml', 'xml',
  'sh', 'bash', 'zsh', 'fish',
  'md', 'mdx',
  'sql', 'graphql', 'proto',
])

/** Extensions that get the image-file icon. */
const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp', 'tiff', 'tif', 'avif', 'heic', 'heif',
])

/** Which file icon a name gets — by extension, so a `.ts` reads as code wherever it appears. */
export function fileMentionIconKind(name: string): MentionIconKind {
  const ext = name.split('.').pop()?.toLowerCase()
  if (ext && CODE_EXTENSIONS.has(ext)) return 'fileCode'
  if (ext && IMAGE_EXTENSIONS.has(ext)) return 'fileImage'
  return 'file'
}

/**
 * The icon kind for a reference. `label` only matters for a file (its extension).
 *
 * `context` and `command` are not references — they never reach a chip — so they answer with
 * the plain file glyph rather than growing the set.
 */
export function mentionIconKindFor(type: ContentBadge['type'], label?: string): MentionIconKind {
  switch (type) {
    case 'skill': return 'skill'
    case 'source': return 'source'
    case 'folder': return 'folder'
    case 'tab': return 'tab'
    case 'design': return 'design'
    case 'element': return 'element'
    default: return fileMentionIconKind(label ?? '')
  }
}
