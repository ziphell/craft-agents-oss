import { describe, it, expect } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

// The vendored editable-PPTX engine ships under apps/electron/resources and is
// copied to dist/resources by scripts/copy-assets.ts. This guards the pin: the
// file must gunzip to the exact upstream bundle (hash below), so a corrupted or
// silently-swapped asset cannot ship. The end-to-end conversion itself needs
// Electron's Chromium (see docs/design-plan.md), so it is not covered here.
const VENDOR_DIR = join(import.meta.dir, '..', '..', '..', 'resources', 'vendor', 'dom-to-pptx')
const EXPECTED_SHA256 = 'df8fca27232864a4ad01d7ad8a5be1e867ab26b9562a3e5e66c8429b644256d4'

describe('vendored dom-to-pptx engine', () => {
  it('gunzips to the pinned upstream browser bundle with its public API', () => {
    const source = gunzipSync(readFileSync(join(VENDOR_DIR, 'dom-to-pptx.bundle.js.gz')))
    expect(createHash('sha256').update(source).digest('hex')).toBe(EXPECTED_SHA256)
    const text = source.toString('utf-8')
    // The UMD global the render window reads, plus the options main relies on.
    expect(text).toContain('domToPptx')
    expect(text).toContain('exportToPptx')
    expect(text).toContain('skipDownload')
  })

  it('ships its MIT license next to the bundle', () => {
    expect(readFileSync(join(VENDOR_DIR, 'LICENSE'), 'utf-8')).toContain('MIT License')
  })
})
