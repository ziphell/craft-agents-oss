import { describe, it, expect } from 'bun:test'
import {
  buildThumbnailHostHtml,
  escapeSrcdocAttribute,
  THUMB_LOGICAL_WIDTH,
} from '../design-thumbnail-host'
import { DESIGN_FRAME_SANDBOX } from '@craft-agent/shared/designs/sandbox'

describe('design-thumbnail-host', () => {
  it('gives the frame the one shared sandbox rule — never same-origin', () => {
    const html = buildThumbnailHostHtml({ content: '<p>x</p>', slug: 's', snapshot: null })
    // The same rule DesignFrame uses, asserted on the artifact rather than on a copy of it.
    expect(html).toContain(`sandbox="${DESIGN_FRAME_SANDBOX}"`)
    expect(html).toContain('sandbox="allow-scripts allow-forms"')
    expect(html).not.toContain('allow-same-origin')
  })

  it('escapes content for safe srcdoc embedding', () => {
    const escaped = escapeSrcdocAttribute('<img src="x" onerror=\'a&b\'>')
    expect(escaped).not.toContain('"')
    expect(escaped).not.toContain('<img')
    expect(escaped).toContain('&quot;')
    expect(escaped).toContain('&lt;img')
    expect(escaped).toContain('&amp;')
  })

  it('embeds the design content as an escaped srcdoc iframe with the shared sandbox', () => {
    const html = buildThumbnailHostHtml({
      content: '<h1>Hello "world"</h1>',
      slug: 'demo',
      snapshot: null,
    })
    expect(html).toContain(`width: ${THUMB_LOGICAL_WIDTH}px`)
    expect(html).toContain('sandbox="allow-scripts allow-forms"')
    // Raw content must not appear unescaped in the host doc.
    expect(html).not.toContain('<h1>Hello')
    expect(html).toContain('&lt;h1&gt;Hello &quot;world&quot;')
  })

  it('delivers the data snapshot via the craft-designs/v1 init message', () => {
    const snapshot = { version: 1 as const, generatedAt: 5, kv: { total: 42 }, series: {} }
    const html = buildThumbnailHostHtml({ content: '<p>x</p>', slug: 's', snapshot })
    expect(html).toContain('craft-designs/v1')
    expect(html).toContain("type: 'init'")
    expect(html).toContain('"total":42')
  })

  it('neutralizes a </script> sequence inside snapshot data', () => {
    const snapshot = { version: 1 as const, generatedAt: 1, kv: { x: '</script><script>alert(1)' }, series: {} }
    const html = buildThumbnailHostHtml({ content: '<p>x</p>', slug: 's', snapshot })
    expect(html).not.toContain('</script><script>alert(1)')
    expect(html).toContain('<\\/script>')
  })

  it('embeds the content as an escaped srcdoc (a design always gets its scripts)', () => {
    const html = buildThumbnailHostHtml({ content: '<p>static</p>', slug: 's', snapshot: null })
    expect(html).toContain('sandbox="allow-scripts allow-forms"')
    expect(html).toContain('&lt;p&gt;static&lt;/p&gt;')
  })
})
