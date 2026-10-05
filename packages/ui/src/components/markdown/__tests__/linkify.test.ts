/**
 * Tests for linkify.ts — URL/file-path detection and markdown link preprocessing.
 *
 * Focuses on the bug where preprocessLinks() would detect bare domains inside
 * the text portion of existing markdown links (e.g. [help.figma.com - Title](url))
 * and double-wrap them, producing broken nested markdown.
 */

import { describe, it, expect } from 'bun:test'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import { preprocessLinks, detectLinks, isPlaceholderUrl, isFilePathTarget } from '../linkify'

/**
 * What markdown actually delivers for the first link in this text — the destination the click
 * handler sees and the text the reader sees. Both are subject to the same escapes, and a
 * destination is the one place where what was written and what arrives differ.
 */
function parsedLink(markdown: string): { url?: string; text?: string } {
  let found: { url?: string; text?: string } | undefined
  const walk = (node: unknown): void => {
    const n = node as { type?: string; url?: unknown; children?: unknown[] }
    if (n.type === 'link') {
      const first = (n.children ?? [])[0] as { value?: string } | undefined
      found = { url: typeof n.url === 'string' ? n.url : undefined, text: first?.value }
      return
    }
    for (const child of n.children ?? []) {
      if (found === undefined) walk(child)
    }
  }
  walk(unified().use(remarkParse).parse(markdown))
  return found ?? {}
}

/** A reference definition carries the URL a link referring to it inherits — the same loss. */
function parsedDefinition(markdown: string): string | undefined {
  let found: string | undefined
  const walk = (node: unknown): void => {
    const n = node as { type?: string; url?: unknown; children?: unknown[] }
    if (n.type === 'definition' && typeof n.url === 'string') {
      found = n.url
      return
    }
    for (const child of n.children ?? []) {
      if (found === undefined) walk(child)
    }
  }
  walk(unified().use(remarkParse).parse(markdown))
  return found
}

/** What a reader sees: every text node markdown delivers, concatenated. */
function renderedText(markdown: string): string {
  const out: string[] = []
  const walk = (node: unknown): void => {
    const n = node as { value?: unknown; children?: unknown[] }
    if (typeof n.value === 'string') out.push(n.value)
    for (const child of n.children ?? []) walk(child)
  }
  walk(unified().use(remarkParse).parse(markdown))
  return out.join('')
}

function parsedDestination(markdown: string): string | undefined {
  return parsedLink(markdown).url
}

function parsedLinkText(markdown: string): string | undefined {
  return parsedLink(markdown).text
}

// ============================================================================
// preprocessLinks — existing markdown links should NOT be corrupted
// ============================================================================

describe('preprocessLinks', () => {
  describe('preserves existing markdown links', () => {
    it('does not wrap a domain inside markdown link text', () => {
      const input = '- [help.figma.com - Pan and zoom in FigJam](https://help.figma.com/hc/en-us/articles/123)'
      expect(preprocessLinks(input)).toBe(input)
    })

    it('does not wrap a full URL used as link text', () => {
      const input = '[https://example.com](https://example.com)'
      expect(preprocessLinks(input)).toBe(input)
    })

    it('does not wrap the href URL of a markdown link', () => {
      const input = '[Click here](https://example.com/page)'
      expect(preprocessLinks(input)).toBe(input)
    })

    it('preserves multiple markdown links in the same text', () => {
      const input = 'See [docs.github.com - Actions](https://docs.github.com/actions) and [api.stripe.com - Charges](https://api.stripe.com/charges)'
      expect(preprocessLinks(input)).toBe(input)
    })

    it('preserves markdown reference links', () => {
      const input = 'Check [example.com docs][ref1] for details'
      expect(preprocessLinks(input)).toBe(input)
    })

    it('preserves link with domain and extra description in text', () => {
      const input = '- [stackoverflow.com - How to fix React hydration errors](https://stackoverflow.com/questions/123)'
      expect(preprocessLinks(input)).toBe(input)
    })
  })

  // A destination is subject to CommonMark's backslash escapes, and `\` before punctuation is one
  // of them: `.` is punctuation, so `[test.md](C:\Users\Ryan\.craft-agent\…)` arrived at the
  // click handler as `…\Ryan.craft-agent\…` — a path that is not on disk, and not inside an
  // allowed directory either (`C:\Users\Ryan` is a *prefix* of `C:\Users\Ryan.craft-agent`,
  // not its parent), so the app refused a file the person could see plainly exists.
  describe('a Windows path keeps its backslashes as a link destination', () => {
    const PATH = 'C:\\Users\\Ryan\\.craft-agent\\workspaces\\my-workspace\\projects\\a\\test.md'
    const ESCAPED_PATH = PATH.replace(/\\/g, '\\\\')

    it('escapes the destination so markdown delivers the path it was given', () => {
      const input = `[test.md](${PATH})`
      expect(preprocessLinks(input)).toBe(`[test.md](${ESCAPED_PATH})`)
      expect(parsedDestination(preprocessLinks(input))).toBe(PATH)
    })

    it('leaves an already-escaped destination alone', () => {
      const input = `[test.md](${ESCAPED_PATH})`
      expect(preprocessLinks(input)).toBe(input)
      expect(parsedDestination(preprocessLinks(input))).toBe(PATH)
    })

    it('is stable when run twice, as a re-render would', () => {
      const once = preprocessLinks(`[test.md](${PATH})`)
      expect(preprocessLinks(once)).toBe(once)
    })

    it('handles the angle-bracket form, which protects nothing from this', () => {
      const input = `[test.md](<${PATH}>)`
      expect(parsedDestination(preprocessLinks(input))).toBe(PATH)
    })

    it('escapes every Windows link in the text', () => {
      const other = 'C:\\Users\\Ryan\\.craft-agent\\workspaces\\my-workspace\\projects\\a\\flows\\flow.drawio'
      const input = `see [test.md](${PATH}) and [flow](${other})`
      const processed = preprocessLinks(input)
      expect(parsedDestination(processed)).toBe(PATH)
      expect(processed).toContain(`(${other.replace(/\\/g, '\\\\')})`)
    })

    it('leaves destinations that are not Windows paths alone', () => {
      const input = '[docs](https://example.com/a_b\\c.md) and [notes](notes\\draft.md)'
      expect(preprocessLinks(input)).toBe(input)
    })

    it('escapes the path it detects in prose, for the label as well as the click', () => {
      const path = String.raw`D:\work\proj\a\test.md`
      const processed = preprocessLinks(`see ${path} here`)

      // Both halves have to read back as the path: the text is under the same escapes as the
      // destination, so an unescaped label would *display* one character short.
      expect(parsedLinkText(processed)).toBe(path)
      expect(parsedDestination(processed)).toBe(path)
      // Escaped in the source for both halves — twice the backslashes, twice over.
      const escaped = path.replace(/\\/g, '\\\\')
      expect(processed).toBe(`see [${escaped}](${escaped}) here`)
    })

    it('keeps a UNC path intact, leading pair and all', () => {
      const path = String.raw`\\fileserver\team\proj\.hidden\a\test.md`
      const processed = preprocessLinks(`see ${path} here`)

      // The leading pair is two backslashes *of the path*, so both are escaped — the one place a
      // pair is not one backslash already written the long way.
      expect(parsedLinkText(processed)).toBe(path)
      expect(parsedDestination(processed)).toBe(path)
      expect(preprocessLinks(processed)).toBe(processed)
    })

    it('leaves a UNC destination that is already escaped alone', () => {
      const escaped = String.raw`\\\\fileserver\\team\\a.md`
      const input = `[share](${escaped})`
      expect(preprocessLinks(input)).toBe(input)
    })

    it('routes a UNC target to the file opener, raw or percent-encoded', () => {
      // The renderer percent-encodes the backslashes before the click handler sees them — one
      // `%5C` each, the leading pair included — and decodeFilePath turns them back.
      expect(isFilePathTarget(String.raw`\\fileserver\team\a.md`)).toBe(true)
      expect(isFilePathTarget('%5C%5Cfileserver%5Cteam%5Ca.md')).toBe(true)
      expect(isFilePathTarget('%5c%5cserver%5cshare%5ca.md')).toBe(true)
    })

    it('leaves a detected path inside code alone', () => {
      const input = 'see `D:\\work\\a\\test.md` here'
      expect(preprocessLinks(input)).toBe(input)
    })

    it('leaves a link inside code alone, so the broken form can still be quoted', () => {
      const fenced = '```\n[test.md](C:\\Users\\Ryan\\.craft-agent\\a.md)\n```'
      expect(preprocessLinks(fenced)).toBe(fenced)

      const inline = 'write `[test.md](C:\\Users\\Ryan\\.craft-agent\\a.md)` to link it'
      expect(preprocessLinks(inline)).toBe(inline)
    })
  })

  describe('still wraps bare URLs that are not already linked', () => {
    it('wraps a bare URL', () => {
      const input = 'Visit https://example.com for more info'
      expect(preprocessLinks(input)).toBe('Visit [https://example.com](https://example.com) for more info')
    })

    it('wraps a bare repo-relative file path', () => {
      const input = 'See apps/electron/resources/docs/browser-tools.md for details'
      expect(preprocessLinks(input)).toBe('See [apps/electron/resources/docs/browser-tools.md](apps/electron/resources/docs/browser-tools.md) for details')
    })

    it('leaves a bare domain as text', () => {
      const input = 'Check out example.com for details'
      expect(preprocessLinks(input)).toBe(input)
    })

    it('wraps a www. host', () => {
      const input = 'Check out www.example.com for details'
      expect(preprocessLinks(input)).toBe('Check out [www.example.com](http://www.example.com) for details')
    })

    it('leaves a name that ends in a TLD but is not an address', () => {
      // `.io` is a TLD, so linkify matches `draw.io` — but nothing here says it is a URL.
      expect(preprocessLinks('Draw it in draw.io')).toBe('Draw it in draw.io')
    })

    it('leaves a bare file name to the file-path pass', () => {
      expect(preprocessLinks('See README.md for details')).toBe('See [README.md](README.md) for details')
    })

    it('wraps bare URL but preserves adjacent markdown link', () => {
      const input = 'See https://bare.example.com and [linked.example.com - Title](https://linked.example.com/page)'
      const result = preprocessLinks(input)
      // The bare URL should be wrapped
      expect(result).toContain('[https://bare.example.com](https://bare.example.com)')
      // The existing markdown link should be untouched
      expect(result).toContain('[linked.example.com - Title](https://linked.example.com/page)')
    })
  })

  describe('strips trailing markdown formatting from URLs', () => {
    it('does not include trailing ** from bold-wrapped URL', () => {
      const input = 'PR created: **https://github.com/lukilabs/craft-growth/pull/1363**'
      const result = preprocessLinks(input)
      expect(result).toBe('PR created: **[https://github.com/lukilabs/craft-growth/pull/1363](https://github.com/lukilabs/craft-growth/pull/1363)**')
    })

    it('does not include trailing * from italic-wrapped URL', () => {
      const input = '*https://example.com/page*'
      const result = preprocessLinks(input)
      expect(result).toBe('*[https://example.com/page](https://example.com/page)*')
    })

    it('handles bold-wrapped URL with path and trailing text', () => {
      const input = 'See **https://github.com/org/repo/pull/42** for details'
      const result = preprocessLinks(input)
      expect(result).toBe('See **[https://github.com/org/repo/pull/42](https://github.com/org/repo/pull/42)** for details')
    })
  })

  describe('does not touch links inside code blocks', () => {
    it('skips URLs in fenced code blocks', () => {
      const input = '```\nhttps://example.com\n```'
      expect(preprocessLinks(input)).toBe(input)
    })

    it('skips URLs in inline code', () => {
      const input = 'Run `curl https://example.com` to test'
      expect(preprocessLinks(input)).toBe(input)
    })
  })
})

// ============================================================================
// preprocessLinks — strips placeholder/fabricated URLs
// ============================================================================

describe('preprocessLinks — placeholder URL stripping', () => {
  it('strips GitHub link with /... placeholder to plain text', () => {
    const input = '**[6610172ec](https://github.com/...) - feat: Browse cache (#6644)**'
    const result = preprocessLinks(input)
    expect(result).toContain('6610172ec')
    expect(result).not.toContain('https://github.com/...')
    expect(result).not.toContain('[6610172ec]')
  })

  it('strips any link with /... in the URL path', () => {
    const input = 'See [commit abc123](https://github.com/.../commit/abc123) for details'
    const result = preprocessLinks(input)
    expect(result).toBe('See commit abc123 for details')
  })

  it('strips link with /... at end of URL', () => {
    const input = 'Check [docs](https://docs.example.com/...)'
    const result = preprocessLinks(input)
    expect(result).toBe('Check docs')
  })

  it('preserves valid GitHub URLs that do not contain /...', () => {
    const input = '[PR #42](https://github.com/lukilabs/craft-agents/pull/42)'
    expect(preprocessLinks(input)).toBe(input)
  })

  it('preserves valid URLs with actual path segments', () => {
    const input = '[Click here](https://example.com/real/path/to/page)'
    expect(preprocessLinks(input)).toBe(input)
  })

  it('handles multiple links where some are placeholders', () => {
    const input = 'See [real link](https://github.com/org/repo/issues/1) and [fake link](https://github.com/...)'
    const result = preprocessLinks(input)
    expect(result).toContain('[real link](https://github.com/org/repo/issues/1)')
    expect(result).toContain('and fake link')
    expect(result).not.toContain('[fake link]')
  })

  it('does not strip placeholder links inside fenced code blocks', () => {
    const input = '```\n[commit](https://github.com/...)\n```'
    expect(preprocessLinks(input)).toBe(input)
  })

  it('does not strip placeholder links inside inline code', () => {
    const input = 'Example: `[commit](https://github.com/...)`'
    expect(preprocessLinks(input)).toBe(input)
  })

  it('preserves empty link text with placeholder URL as-is', () => {
    const input = '[](https://github.com/...)'
    expect(preprocessLinks(input)).toBe(input)
  })
})

// ============================================================================
// isPlaceholderUrl — unit tests for placeholder detection
// ============================================================================

describe('isPlaceholderUrl', () => {
  it('detects https://github.com/... as placeholder', () => {
    expect(isPlaceholderUrl('https://github.com/...')).toBe(true)
  })

  it('detects URL with /... in middle of path', () => {
    expect(isPlaceholderUrl('https://github.com/.../commit/abc')).toBe(true)
  })

  it('does not flag valid GitHub URLs', () => {
    expect(isPlaceholderUrl('https://github.com/org/repo')).toBe(false)
    expect(isPlaceholderUrl('https://github.com/org/repo/pull/42')).toBe(false)
    expect(isPlaceholderUrl('https://github.com/org/repo/commit/abc123')).toBe(false)
  })

  it('does not flag URLs with triple dots in query params', () => {
    expect(isPlaceholderUrl('https://example.com/search?q=test...more')).toBe(false)
  })

  it('does not flag compare URLs with two dots', () => {
    expect(isPlaceholderUrl('https://github.com/org/repo/compare/main..feature')).toBe(false)
  })

  it('does not flag three-dot GitHub compare URLs', () => {
    expect(isPlaceholderUrl('https://github.com/org/repo/compare/main...feature')).toBe(false)
    expect(isPlaceholderUrl('https://github.com/org/repo/compare/v1.0.0...v2.0.0')).toBe(false)
  })
})

// ============================================================================
// detectLinks — basic detection sanity checks
// ============================================================================

// A definition's destination is invisible in what is rendered — that is what a definition is for —
// but a link that refers to it inherits the URL markdown hands over, so the same loss lands here.
describe('reference definitions', () => {
  const PATH = String.raw`C:\Users\Ryan\.craft-agent\workspaces\a\test.md`

  it('keeps the destination intact', () => {
    const processed = preprocessLinks(`[test.md][ref]\n\n[ref]: ${PATH}`)
    expect(parsedDefinition(processed)).toBe(PATH)
    expect(processed).toContain(`[ref]: ${PATH.replace(/\\/g, '\\\\')}`)
  })

  it('leaves a title after the destination alone', () => {
    const processed = preprocessLinks(`[ref]: ${PATH} "the file"`)
    expect(parsedDefinition(processed)).toBe(PATH)
    expect(processed.endsWith('"the file"')).toBe(true)
  })

  it('leaves a definition inside a fence alone', () => {
    const input = '```\n[ref]: C:\\Users\\Ryan\\.craft-agent\\a.md\n```'
    expect(preprocessLinks(input)).toBe(input)
  })
})

// The *text* of a message goes through the same escapes a destination does, so a Windows path in
// prose reached the reader a character short: `\.craft-agent` showed as `.craft-agent`, quietly
// joining two folder names.
describe('a Windows path in the message text', () => {
  const PATH = String.raw`C:\Users\Ryan\code\craft-agents-oss\~\.craft-agent`

  it('is shown exactly as it was written', () => {
    const sentence = `见 ${PATH} 这一层`
    expect(renderedText(preprocessLinks(sentence))).toBe(sentence)
  })

  it('keeps its backslashes when it is the label of a link', () => {
    const processed = preprocessLinks(`[${PATH}](${PATH})`)
    expect(renderedText(processed)).toBe(PATH)
    expect(parsedDestination(processed)).toBe(PATH)
  })

  it('covers the portable `~` form the app writes paths in', () => {
    const portable = String.raw`~\.craft-agent\workspaces\my-workspace`
    expect(renderedText(preprocessLinks(portable))).toBe(portable)
  })

  it('covers a UNC path, extension or not', () => {
    const unc = String.raw`\\fileserver\team\.hidden`
    expect(renderedText(preprocessLinks(unc))).toBe(unc)
  })

  it('leaves markdown escapes that are not paths alone', () => {
    const escapes = String.raw`snake\_case and \*literal asterisks\* and \[not a link\]`
    expect(renderedText(preprocessLinks(escapes))).toBe('snake_case and *literal asterisks* and [not a link]')
  })

  it('leaves code alone', () => {
    const fenced = '```\n' + PATH + '\n```'
    expect(preprocessLinks(fenced)).toBe(fenced)
    const inline = 'write `' + PATH + '` to see it'
    expect(preprocessLinks(inline)).toBe(inline)
  })
})

describe('detectLinks', () => {
  it('detects a bare URL', () => {
    const links = detectLinks('Visit https://example.com today')
    expect(links).toHaveLength(1)
    expect(links[0]).toBeDefined()
    expect(links[0]!.url).toBe('https://example.com')
    expect(links[0]!.type).toBe('url')
  })

  it('does not detect a bare domain', () => {
    expect(detectLinks('Check example.com')).toHaveLength(0)
  })

  it('detects a www. host', () => {
    const links = detectLinks('Check www.example.com')
    expect(links).toHaveLength(1)
    expect(links[0]!.url).toBe('http://www.example.com')
    expect(links[0]!.type).toBe('url')
  })

  it('reads names with file-extension TLDs as file paths, not domains', () => {
    expect(detectLinks('The file is deploy.sh and the doc is README.md').map(l => l.type)).toEqual(['file', 'file'])
  })

  it('strips trailing ** from bold-wrapped URL', () => {
    const links = detectLinks('**https://github.com/org/repo/pull/42**')
    expect(links).toHaveLength(1)
    expect(links[0]!.url).toBe('https://github.com/org/repo/pull/42')
    expect(links[0]!.text).toBe('https://github.com/org/repo/pull/42')
  })

  it('detects file paths', () => {
    const links = detectLinks('See /Users/foo/bar.ts for details')
    expect(links).toHaveLength(1)
    expect(links[0]).toBeDefined()
    expect(links[0]!.type).toBe('file')
    expect(links[0]!.url).toBe('/Users/foo/bar.ts')
  })

  it('detects bare repo-relative file paths', () => {
    const links = detectLinks('Open apps/electron/resources/docs/browser-tools.md')
    expect(links).toHaveLength(1)
    expect(links[0]).toBeDefined()
    expect(links[0]!.type).toBe('file')
    expect(links[0]!.url).toBe('apps/electron/resources/docs/browser-tools.md')
  })

  it('detects a drawio diagram path', () => {
    const links = detectLinks('The diagram is assets/checkout/flow.drawio')
    expect(links).toHaveLength(1)
    expect(links[0]).toBeDefined()
    expect(links[0]!.type).toBe('file')
    expect(links[0]!.url).toBe('assets/checkout/flow.drawio')
  })

  it('detects parent-relative file paths', () => {
    const links = detectLinks('See ../README.md for setup steps')
    expect(links).toHaveLength(1)
    expect(links[0]).toBeDefined()
    expect(links[0]!.type).toBe('file')
    expect(links[0]!.url).toBe('../README.md')
  })

  // A drive letter looks like a scheme, and the file-path classes held neither `\` nor `:`, so a
  // Windows absolute path matched no branch at all: the path a Windows user pasted stayed plain
  // text while the POSIX path in the next sentence was a link.
  describe('Windows absolute paths', () => {
    it('detects one on any drive, not just C:', () => {
      const path = String.raw`D:\work\proj\a\test.md`
      const links = detectLinks(`Open ${path} for details`)
      expect(links).toHaveLength(1)
      expect(links[0]!.type).toBe('file')
      expect(links[0]!.url).toBe(path)
    })

    it('detects the forward-slash form, and a lower-case drive letter', () => {
      expect(detectLinks('Open e:/work/proj/a/test.md for details').map((l) => l.url)).toEqual([
        'e:/work/proj/a/test.md',
      ])
    })

    it('detects one whose folder names are not ASCII', () => {
      const path = 'C:\\Users\\\u7528\u6237\\a.md'
      expect(detectLinks(`Open ${path} for details`).map((l) => l.url)).toEqual([path])
    })

    it('does not detect one with no known file extension', () => {
      expect(detectLinks(String.raw`Open D:\work\proj\a today`)).toHaveLength(0)
    })

    it('detects one written beside full-width punctuation', () => {
      const path = String.raw`D:\work\a\test.md`
      const links = detectLinks(`\u89c1 ${path}\uff0c\u7136\u540e`)
      expect(links.map((l) => l.url)).toEqual([path])
    })

    it('detects a UNC path, whose root is two backslashes', () => {
      const path = String.raw`\\fileserver\team\proj\.hidden\a\test.md`
      const links = detectLinks(`Open ${path} for details`)
      expect(links).toHaveLength(1)
      expect(links[0]!.type).toBe('file')
      expect(links[0]!.url).toBe(path)
    })
  })
})

describe('isFilePathTarget', () => {
  it('accepts absolute unix image paths', () => {
    expect(isFilePathTarget('/Users/balintorosz/.craft-agent/sessions/abc/image.jpg')).toBe(true)
  })

  it('accepts parent-relative image paths', () => {
    expect(isFilePathTarget('../downloads/assets/screenshot.png')).toBe(true)
  })

  it('accepts repo-relative markdown paths', () => {
    expect(isFilePathTarget('apps/electron/resources/docs/browser-tools.md')).toBe(true)
  })

  // A drive letter looks like a scheme, and the file-path character classes hold `/` but
  // neither `:` nor `\` — so these matched nothing and were handed to the URL opener.
  it('accepts a Windows path', () => {
    expect(isFilePathTarget('C:\\Users\\tester\\projects\\a\\flow.drawio')).toBe(true)
    expect(isFilePathTarget('C:/Users/tester/projects/a/flow.drawio')).toBe(true)
  })

  it('still reads a real scheme as a scheme', () => {
    // No separator after the colon, so this is `c:` the scheme, not a drive.
    expect(isFilePathTarget('c:not-a-path')).toBe(false)
  })

  it('rejects web URLs', () => {
    expect(isFilePathTarget('https://example.com/image.jpg')).toBe(false)
  })

  it('rejects file URLs because they are resolved by link-target.ts', () => {
    expect(isFilePathTarget('file:///Users/tester/report.xlsx')).toBe(false)
  })

  it('rejects non-file strings', () => {
    expect(isFilePathTarget('not a link at all')).toBe(false)
  })
})
