import LinkifyIt from 'linkify-it'
import { FILE_EXTENSIONS_PATTERN } from '../../lib/file-classification'

/**
 * Linkify - URL and file path detection for markdown preprocessing
 *
 * Uses linkify-it (12M downloads/week) for battle-tested URL detection,
 * plus custom regex for local file paths.
 */

// Initialize linkify-it with default settings. Its fuzzy matching (bare domains) is kept
// on so `www.` hosts are found, but every fuzzy hit is filtered through isRealUrl() below —
// only a scheme or a `www.` prefix makes a URL, never a TLD alone.
const linkify = new LinkifyIt()

// File path regex - detects absolute/home/explicit-relative/bare-relative paths with common extensions
// Examples: /Users/foo.ts, ~/src/app.tsx, ./README.md, ../guide.md, apps/electron/src/main.ts
// Extensions derived from file-classification.ts to stay in sync with preview support
//
// A Windows path belongs here too, in both the forms Windows writes: drive-absolute
// (`C:\Users\tester\flow.drawio`, on **any** drive — a machine's work is not always on `C:`)
// and UNC (`\\fileserver\team\a.md`). The character classes below hold `/` but neither
// `\` nor `:`, so such a path matched no branch at all and stayed plain text: the path a Windows
// user pasted into a chat was not a link, while the POSIX path beside it was. A segment is
// "whatever Windows allows in a name" rather than an ASCII word class, so `C:\用户\文档\a.md` is a
// path too, and both separators are accepted because both are what Windows accepts.
const WINDOWS_PATH_SOURCE = `(?:[A-Za-z]:[\\\\/]|\\\\\\\\)(?:[^\\\\/:*?"<>|\\s]+[\\\\/])*[^\\\\/:*?"<>|\\s]+\\.(?:${FILE_EXTENSIONS_PATTERN})`
const POSIX_PATH_SOURCE = `(?:/|~/|\\./|\\.\\./|[A-Za-z0-9_][\\w\\-./@%]*)[\\w\\-./@%]*\\.(?:${FILE_EXTENSIONS_PATTERN})`
// Punctuation a path can sit *beside* without being part of it: the quotes, and the full-width
// forms a CJK sentence uses. Both boundary classes were ASCII-only, so `见 D:\a\b.md，然后` and
// `「D:\a\b.md」` matched no boundary at all and stayed plain text — a path is no less a path for
// being written in Chinese, and the link it makes is the same `file` link ASCII spacing produced.
const ADJACENT_PUNCTUATION = `，。、；：！？…—（）【】〔〕「」『』《》〈〉“”‘’"'`
const FILE_PATH_REGEX_SOURCE = `(?:^|[\\s([\\{<${ADJACENT_PUNCTUATION}])((?:${WINDOWS_PATH_SOURCE}|${POSIX_PATH_SOURCE}))(?=[\\s)\\]}\\.,:;!?>${ADJACENT_PUNCTUATION}]|$)`
const FILE_PATH_REGEX = new RegExp(FILE_PATH_REGEX_SOURCE, 'gi')
const FILE_PATH_PRETEST_REGEX = new RegExp(FILE_PATH_REGEX_SOURCE, 'i')

// File-path regex for markdown anchor targets (entire href/text value)
// Used by Markdown.tsx click handler to route file links to onFileClick.
const FILE_PATH_TARGET_REGEX = new RegExp(
  `^(?!https?://|mailto:|ftp://|data:)(?:/|~/|\./|\.\./|[A-Za-z0-9_][\\w\\-./@%]*)[\\w\\-./@%]*\\.(?:${FILE_EXTENSIONS_PATTERN})$`,
  'i'
)

interface DetectedLink {
  type: 'url' | 'email' | 'file'
  text: string
  url: string
  start: number
  end: number
}

/**
 * Whether a linkify match is an actual URL, rather than a bare domain that only
 * happens to end in a known TLD.
 *
 * A scheme (`https://…`, `mailto:…`) or a `www.` prefix is the author saying "this is a
 * link". Without one, linkify matches on the TLD list alone — and that list is a poor
 * witness, because its entries double as file extensions and product names: `README.md`,
 * `deploy.sh` and `draw.io` all end in a valid TLD and none is an address. Those stay text
 * (or, when the tail is a known file extension, become file paths via FILE_PATH_REGEX).
 */
const SCHEME_REGEX = /^[a-z][a-z0-9+.-]*:\/\//i
const WWW_REGEX = /^www\./i

function isRealUrl(text: string, schema: string): boolean {
  return schema === 'mailto:' || SCHEME_REGEX.test(text) || WWW_REGEX.test(text)
}

interface CodeRange {
  start: number
  end: number
}

/**
 * Find all code block and inline code ranges in text
 * These ranges should be excluded from link detection
 */
function findCodeRanges(text: string): CodeRange[] {
  const ranges: CodeRange[] = []

  // Find fenced code blocks (```...```)
  const fencedRegex = /```[\s\S]*?```/g
  let match
  while ((match = fencedRegex.exec(text)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length })
  }

  // Find inline code (`...`)
  // But skip escaped backticks and code inside fenced blocks
  const inlineRegex = /(?<!`)`(?!`)([^`\n]+)`(?!`)/g
  while ((match = inlineRegex.exec(text)) !== null) {
    const pos = match.index
    // Check if this is inside a fenced block
    const insideFenced = ranges.some(r => pos >= r.start && pos < r.end)
    if (!insideFenced) {
      ranges.push({ start: pos, end: pos + match[0].length })
    }
  }

  return ranges
}

/**
 * Check if a position is inside any code range
 */
function isInsideCode(pos: number, ranges: CodeRange[]): boolean {
  return ranges.some(r => pos >= r.start && pos < r.end)
}

/**
 * Find all markdown link ranges in text: both [text](...) and [text][ref] patterns.
 * Returns ranges covering the entire link syntax so any URL detected within
 * these spans is skipped by preprocessLinks() — preventing nested/broken links.
 */
function findMarkdownLinkRanges(text: string): CodeRange[] {
  const ranges: CodeRange[] = []

  // Match [text](url) — inline links
  const inlineLinkRegex = /\[(?:[^\[\]]|\\\[|\\\])*\]\([^)]*\)/g
  let match
  while ((match = inlineLinkRegex.exec(text)) !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length })
  }

  // Match [text][ref] — reference links
  const refLinkRegex = /\[(?:[^\[\]]|\\\[|\\\])*\]\[[^\]]*\]/g
  while ((match = refLinkRegex.exec(text)) !== null) {
    // Avoid duplicates with inline links that already matched
    const r = { start: match.index, end: match.index + match[0].length }
    const alreadyCovered = ranges.some(existing => rangesOverlap(existing, r))
    if (!alreadyCovered) {
      ranges.push(r)
    }
  }

  return ranges
}

/**
 * Check if a position falls inside any markdown link range
 */
function isInsideMarkdownLink(pos: number, ranges: CodeRange[]): boolean {
  return ranges.some(r => pos >= r.start && pos < r.end)
}

/**
 * Check if ranges overlap
 */
function rangesOverlap(a: { start: number; end: number }, b: { start: number; end: number }): boolean {
  return a.start < b.end && b.start < a.end
}

/**
 * Detect all links (URLs, emails, file paths) in text
 */
export function detectLinks(text: string): DetectedLink[] {
  const links: DetectedLink[] = []

  // 1. Detect URLs and emails with linkify-it
  const urlMatches = linkify.match(text) || []
  // linkify-it doesn't strip trailing asterisks from bold/italic markdown,
  // which causes broken links when URLs are wrapped like **url** or *url*
  // Note: _ and ~ are valid URL chars so we only strip *
  const trailingMarkdownRe = /\*+$/
  for (const match of urlMatches) {
    let matchText = match.text
    let matchUrl = match.url
    let matchEnd = match.lastIndex

    const stripped = matchText.replace(trailingMarkdownRe, '')
    if (stripped !== matchText) {
      const diff = matchText.length - stripped.length
      matchText = stripped
      matchUrl = matchUrl.replace(trailingMarkdownRe, '')
      matchEnd -= diff
    }

    // Skip bare domains — see isRealUrl().
    if (!isRealUrl(matchText, match.schema)) continue

    links.push({
      type: match.schema === 'mailto:' ? 'email' : 'url',
      text: matchText,
      url: matchUrl,
      start: match.index,
      end: matchEnd
    })
  }

  // 2. Detect file paths with custom regex
  // Reset regex state
  FILE_PATH_REGEX.lastIndex = 0
  let fileMatch
  while ((fileMatch = FILE_PATH_REGEX.exec(text)) !== null) {
    const path = fileMatch[1]
    if (!path) continue // Skip if no capture group

    // Calculate actual start position (after any leading whitespace/punctuation)
    const fullMatch = fileMatch[0]
    const pathOffset = fullMatch.indexOf(path)
    const start = fileMatch.index + pathOffset

    // Check for overlaps with URL matches (URLs take precedence)
    const pathRange = { start, end: start + path.length }
    const overlapsUrl = links.some(link => rangesOverlap(pathRange, link))
    if (overlapsUrl) continue

    links.push({
      type: 'file',
      text: path,
      url: path, // File paths are passed as-is to onFileClick handler
      start,
      end: start + path.length
    })
  }

  // Sort by position
  return links.sort((a, b) => a.start - b.start)
}

/**
 * Detect placeholder/fabricated URLs that the AI generated without knowing the real URL.
 * These are URLs like `https://github.com/...` or `https://example.com/...`
 * that should be stripped back to inline code instead of rendered as links.
 */
const PLACEHOLDER_URL_PATTERN = /\/\.\.\.(?:[)/\s#?]|$)/

/**
 * Check if a URL looks like a placeholder/fabricated URL.
 * Returns true for URLs containing path segments like `/...`
 */
export function isPlaceholderUrl(url: string): boolean {
  return PLACEHOLDER_URL_PATTERN.test(url)
}

/**
 * Strip markdown links with placeholder URLs back to plain text.
 * Converts `[text](https://github.com/...)` → `text`
 * Respects code blocks — links inside fenced or inline code are not touched.
 */
function stripPlaceholderLinks(text: string): string {
  const codeRanges = findCodeRanges(text)
  // Match markdown links [text](url) where url contains placeholder patterns
  return text.replace(
    /\[([^\[\]]*)\]\(([^)]*)\)/g,
    (fullMatch, linkText: string, url: string, offset: number) => {
      // Don't modify links inside code blocks
      if (isInsideCode(offset, codeRanges)) return fullMatch

      if (isPlaceholderUrl(url)) {
        // Strip the link, keep just the display text as plain text
        if (!linkText.trim()) return fullMatch
        return linkText
      }
      return fullMatch
    }
  )
}

/**
 * A destination holding a Windows path the way the source wrote it: drive-absolute (`C:\…`) or
 * UNC (`\\server\…`).
 */
const WINDOWS_DESTINATION_REGEX = /^(?:[A-Za-z]:\\|\\\\)/
/** The two backslashes a UNC path starts with — characters, not a pattern. */
const UNC_LEAD = '\\\\'
/** A UNC lead escaped once already: four backslashes, a shape no path itself has. */
const ESCAPED_UNC_LEAD = '\\\\\\\\'

/**
 * The destination as markdown has to be given it: a Windows path with every backslash written the
 * long way, anything else untouched.
 *
 * CommonMark processes backslash escapes in a destination, and `\` before *punctuation* is one of
 * them. `.` is punctuation, so
 *
 *     [test.md](C:\Users\Ryan\.craft-agent\workspaces\my-workspace\projects\a\test.md)
 *
 * reaches the click handler as `C:\Users\Ryan.craft-agent\…`: one character short, on a path that
 * is not on disk, and not inside any allowed directory either, because `C:\Users\Ryan` is a
 * *prefix* of `C:\Users\Ryan.craft-agent`, not its parent. (`\U`, `\R`, `\w` and the rest are
 * letters, which is why only the `\.` of `.craft-agent` is lost — and why this misfires on nearly
 * every path under `~\.craft-agent`.) What the person sees is a file link of their own that will
 * not open, refused for a reason that names neither the dot nor the escape.
 *
 * Two shapes are left alone, and both are already correct: a destination escaped once already
 * (`C:\\Users\\…`), whose pairs are one backslash each and which re-escaping would double;
 * and a UNC path escaped once already (`\\\\server\\…`) — the one place a lead of four is not
 * a path's own.
 *
 * A path is not prose: nothing in a Windows path means to escape anything, and the `\.` in one is a
 * backslash followed by a dot. Writing them the long way hands markdown the literal path it was
 * given — for a UNC path with a lead of two, because there the pair *is* the path.
 */
function escapeDestination(destination: string): string {
  const bracketed = destination.startsWith('<') && destination.endsWith('>')
  const path = bracketed ? destination.slice(1, -1) : destination

  if (!WINDOWS_DESTINATION_REGEX.test(path)) return destination
  const escaped = escapeBackslashes(path)
  if (escaped === path) return destination
  return bracketed ? `<${escaped}>` : escaped
}

/**
 * Every backslash written the long way, so markdown reads it back as one.
 *
 * A UNC path's leading pair is two backslashes *of the path* rather than one written the long way,
 * so both are escaped like any other.
 */
function escapeBackslashes(path: string): string {
  // Escaped once already — only a UNC lead can be, and never a path of its own.
  if (path.startsWith(ESCAPED_UNC_LEAD)) return path

  const uncLead = path.startsWith(UNC_LEAD)
  let out = uncLead ? ESCAPED_UNC_LEAD : ''
  for (let i = uncLead ? UNC_LEAD.length : 0; i < path.length; i++) {
    if (path[i] !== '\\') {
      out += path[i]
      continue
    }
    out += '\\\\'
    // A pair is one backslash already written that way: skip its second half.
    if (path[i + 1] === '\\') i++
  }
  return out
}

/**
 * Protect the backslashes of a Windows path wherever markdown takes a destination: an inline link
 * or image (`[label](destination)`) and a reference definition (`[ref]: destination`), whose URL a
 * link that refers to it inherits — the same loss, one node along.
 *
 * Ranges inside code are skipped: a message *about* this bug shows the broken form in a fence, and
 * must keep showing it.
 */
function protectWindowsLinkDestinations(text: string): string {
  return protectDefinitionDestinations(protectInlineDestinations(text))
}

/** `[label](destination)` — and `![alt](destination)`, which is the same shape. */
function protectInlineDestinations(text: string): string {
  const codeRanges = findCodeRanges(text)

  return text.replace(/\]\(([^)\n]*)\)/g, (fullMatch: string, destination: string, offset: number) => {
    if (isInsideCode(offset, codeRanges)) return fullMatch
    return `](${escapeDestination(destination)})`
  })
}

/**
 * `[ref]: destination`, on a line of its own.
 *
 * The destination is invisible in what is rendered — that is what a definition is for — but a link
 * that refers to it inherits the URL markdown hands over, so the loss lands exactly where the
 * inline case's does. A title after the destination is left alone: only the destination is this
 * function's business.
 */
function protectDefinitionDestinations(text: string): string {
  const codeRanges = findCodeRanges(text)

  return text.replace(
    /^([ \t]{0,3}\[[^\]\n]*\]:[ \t]*)(<[^<>\n]*>|[^\s]+)/gm,
    (fullMatch: string, prefix: string, destination: string, offset: number) => {
      if (isInsideCode(offset, codeRanges)) return fullMatch
      return prefix + escapeDestination(destination)
    },
  )
}

/**
 * A Windows path written in the *text* of a message — in prose, or as the label of a link.
 *
 * What a reader sees goes through the same escapes a destination does, so a path typed or pasted
 * into a chat arrives short of what was pasted:
 *
 *     typed    C:\Users\Ryan\code\craft-agents-oss\~\.craft-agent
 *     shown    C:\Users\Ryan\code\craft-agents-oss~.craft-agent
 *
 * — both the `\~` and the `\.` gone, and the second one quietly joins two folder names. A path is
 * not prose: nothing in one means to escape anything, so anything that *begins* the way a Windows
 * path begins has its backslashes written the long way, wherever in the text it sits.
 *
 * Only those beginnings are touched, and that is what makes it safe: `snake\_case` is a markdown
 * escape and stays one (escaping every backslash in the text would break it), and a run cannot
 * cross a line, so a fence is only ever entered from inside — where it is skipped.
 */
const WINDOWS_PATH_IN_TEXT_REGEX = /(?:[A-Za-z]:\\|\\\\|~\\)[^\s`]*/g

function protectWindowsPathsInText(text: string): string {
  const codeRanges = findCodeRanges(text)

  return text.replace(WINDOWS_PATH_IN_TEXT_REGEX, (windowsPath: string, offset: number) => {
    if (isInsideCode(offset, codeRanges)) return windowsPath
    return escapeBackslashes(windowsPath)
  })
}

/**
 * Preprocess text to convert raw URLs and file paths into markdown links
 * Skips code blocks and already-linked content
 */
export function preprocessLinks(text: string): string {
  // Before anything else, and before the early return below: a Windows path as a link
  // destination has to survive markdown's escape processing to be a path at all.
  text = protectWindowsLinkDestinations(text)

  // First pass: strip markdown links with placeholder/fabricated URLs
  // (e.g., AI-generated `[commit](https://github.com/...)` → `\`commit\``)
  text = stripPlaceholderLinks(text)

  // Quick check - if no potential links, return early. A Windows path in the text still has to
  // survive rendering, so the text pass is on both ways out of here.
  if (!linkify.pretest(text) && !FILE_PATH_PRETEST_REGEX.test(text)) {
    return protectWindowsPathsInText(text)
  }

  const codeRanges = findCodeRanges(text)
  const markdownLinkRanges = findMarkdownLinkRanges(text)
  const links = detectLinks(text)

  if (links.length === 0) return protectWindowsPathsInText(text)

  // Build result, converting raw links to markdown links
  let result = ''
  let lastIndex = 0

  for (const link of links) {
    // Skip if inside code block
    if (isInsideCode(link.start, codeRanges)) continue

    // Skip if inside an existing markdown link (text or href portion)
    if (isInsideMarkdownLink(link.start, markdownLinkRanges)) continue

    // Add text before this link
    result += text.slice(lastIndex, link.start)

    // Convert to markdown link.
    //
    // A Windows path has to be escaped in **both** halves: the link text is subject to the same
    // escapes as a destination, so an unescaped `C:\Users\Ryan\.craft-agent\a.md` as the text
    // would be displayed a character short — the click would work and the path under it would not
    // be the one on disk. Text and destination are the same string, so one escaping serves both.
    const isWindowsPath = WINDOWS_PATH_REGEX.test(link.text)
    const label = isWindowsPath ? escapeBackslashes(link.text) : link.text
    const href = isWindowsPath ? escapeBackslashes(link.url) : link.url
    result += `[${label}](${href})`

    lastIndex = link.end
  }

  // Add remaining text
  result += text.slice(lastIndex)

  return protectWindowsPathsInText(result)
}

/**
 * Test if text contains any detectable links
 * Useful for optimization - skip preprocessing if no links present
 */
export function hasLinks(text: string): boolean {
  return linkify.pretest(text) || FILE_PATH_PRETEST_REGEX.test(text)
}

/**
 * A Windows path is not a URL, however much `C:` looks like a scheme.
 *
 * The character classes in the regexes above hold `/` but not `\` and not `:`, so
 * `C:\Users\tester\flow.drawio` matched no branch at all and fell through to `onUrlClick` —
 * where a file path met the URL opener and came back as "the system cannot find the file
 * specified", because what it tried to open was a path-shaped string with a `c:` scheme.
 *
 * A drive letter followed by a separator is a path, and nothing else looks like one. The
 * separator is accepted percent-encoded too: a path that went through a link destination
 * arrives as `C:%5CUsers%5C…`, which is the same path and no more a URL than the raw one.
 * Decoding it is `decodeFilePath`'s job, further up this pipeline.
 *
 * A UNC path (`\\server\share\a.md`) is a path for the same reason, and arrives
 * percent-encoded as `%5C%5Cserver%5Cshare%5Ca.md` — one `%5C` per backslash, its leading pair
 * included. Both forms are accepted: the raw one and the encoded one the renderer hands over.
 */
const WINDOWS_PATH_REGEX = /^(?:[A-Za-z]:(?:[\\/]|%5c)|\\\\|%5c%5c)/i

/**
 * Check whether a markdown anchor target should be treated as a local file path.
 * Used by click handlers to route local paths to onFileClick instead of onUrlClick.
 */
export function isFilePathTarget(target: string): boolean {
  const trimmed = target.trim()
  return WINDOWS_PATH_REGEX.test(trimmed) || FILE_PATH_TARGET_REGEX.test(trimmed)
}
