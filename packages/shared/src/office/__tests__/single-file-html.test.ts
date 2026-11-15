import { describe, expect, it } from 'bun:test'
import { inlineLocalAssets, isRemoteReference } from '../single-file-html'

const png = (n: number) => ({ mime: 'image/png', bytes: new Uint8Array(n) })
const read = (map: Record<string, { mime: string; bytes: Uint8Array }>) => (ref: string) => map[ref] ?? null

describe('isRemoteReference', () => {
  it('knows what resolves wherever the file is opened', () => {
    expect(isRemoteReference('https://cdn.example/x.png')).toBe(true)
    expect(isRemoteReference('data:image/png;base64,AA')).toBe(true)
    expect(isRemoteReference('//cdn.example/x.png')).toBe(true)
    expect(isRemoteReference('#anchor')).toBe(true)
    expect(isRemoteReference('assets/x.png')).toBe(false)
    expect(isRemoteReference('../x.png')).toBe(false)
  })
})

describe('inlineLocalAssets', () => {
  it('embeds a local image and leaves the markup otherwise intact', () => {
    const result = inlineLocalAssets('<p><img src="a.png" alt="x"></p>', read({ 'a.png': png(4) }))
    expect(result.html).toContain('src="data:image/png;base64,')
    expect(result.html).toContain('alt="x"')
    expect(result.inlined).toBe(1)
  })

  it('leaves a remote reference exactly as it was', () => {
    const html = '<img src="https://cdn.example/a.png">'
    expect(inlineLocalAssets(html, read({})).html).toBe(html)
  })

  it('leaves a missing file pointing where it pointed', () => {
    const html = '<img src="gone.png">'
    const result = inlineLocalAssets(html, read({}))
    expect(result.html).toBe(html)
    expect(result.skipped).toBe(1)
    expect(result.inlined).toBe(0)
  })

  it('inlines a stylesheet and the url()s inside it', () => {
    const html = '<link rel="stylesheet" href="a.css"><style>.x{background:url("b.png")}</style>'
    const result = inlineLocalAssets(html, read({ 'a.css': { mime: 'text/css', bytes: new Uint8Array(3) }, 'b.png': png(2) }))
    expect(result.html).not.toContain('href="a.css"')
    expect(result.html).toContain('url("data:image/png;base64,')
    expect(result.inlined).toBe(2)
  })

  it('stops at the budget instead of writing a file nobody can open', () => {
    const html = '<img src="big.png">'
    const result = inlineLocalAssets(html, read({ 'big.png': png(1000) }), { maxBytes: 100 })
    expect(result.html).toBe(html)
    expect(result.skipped).toBe(1)
  })

  it('is a copy: the input string is untouched', () => {
    const html = '<img src="a.png">'
    inlineLocalAssets(html, read({ 'a.png': png(1) }))
    expect(html).toBe('<img src="a.png">')
  })
})
