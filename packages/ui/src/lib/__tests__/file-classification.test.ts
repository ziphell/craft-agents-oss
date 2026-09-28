/**
 * Tests for file-classification.ts — what a click on a path means, by extension.
 *
 * The one worth pinning is `html`: it is HTML to draw, not source, and the app has a window for
 * it (`useLinkInterceptor` reads it and hands it to HTMLPreviewOverlay). It used to be classified
 * as `code`, which is what made a `.html` link in a conversation show its markup instead.
 */

import { describe, it, expect } from 'bun:test'
import { classifyFile } from '../file-classification'

describe('classifyFile', () => {
  it('reads HTML as HTML, not as code', () => {
    expect(classifyFile('/x/cart.html')).toEqual({ type: 'html', canPreview: true })
    expect(classifyFile('/x/cart.htm')).toEqual({ type: 'html', canPreview: true })
  })

  it('names the kind that owns each format', () => {
    expect(classifyFile('flow.drawio').type).toBe('drawio')
    expect(classifyFile('notes.md').type).toBe('markdown')
    expect(classifyFile('shot.png').type).toBe('image')
    expect(classifyFile('main.ts').type).toBe('code')
  })

  it('lets a format with a viewer of its own beat the code viewer', () => {
    expect(classifyFile('icon.svg').type).toBe('image')
    expect(classifyFile('report.pdf').type).toBe('pdf')
  })

  it('has nothing of its own for an extension it does not know', () => {
    expect(classifyFile('archive.zip')).toEqual({ type: null, canPreview: false })
    expect(classifyFile('README')).toEqual({ type: null, canPreview: false })
  })
})
