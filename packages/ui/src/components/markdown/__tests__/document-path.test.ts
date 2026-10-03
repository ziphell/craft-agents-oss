import { describe, it, expect } from 'bun:test'
import { documentDir, resolveDocumentPath } from '../document-path'

describe('documentDir', () => {
  it('drops the last segment of a unix path', () => {
    expect(documentDir('/w/projects/checkout/PRD.md')).toBe('/w/projects/checkout')
  })

  it('drops the last segment of a windows path', () => {
    expect(documentDir('C:\\w\\projects\\checkout\\PRD.md')).toBe('C:\\w\\projects\\checkout')
  })

  it('keeps a path with nothing to drop', () => {
    expect(documentDir('PRD.md')).toBe('PRD.md')
  })
})

describe('resolveDocumentPath', () => {
  it('resolves a picture named beside the document', () => {
    expect(resolveDocumentPath('/w/projects/checkout', 'wireframes/cart.png')).toBe(
      '/w/projects/checkout/wireframes/cart.png',
    )
  })

  // A link and a picture are the same rule — the document's folder is what a relative
  // destination is relative to.
  it('resolves a document named beside the document the same way', () => {
    expect(resolveDocumentPath('/w/projects/checkout', 'docs/checkout.md')).toBe(
      '/w/projects/checkout/docs/checkout.md',
    )
  })

  it('resolves one named from a subfolder without doubling the separator', () => {
    expect(resolveDocumentPath('/w/projects/checkout/', './shots/cart.png')).toBe(
      '/w/projects/checkout/./shots/cart.png',
    )
  })

  it('keeps the parent step for the host to resolve', () => {
    expect(resolveDocumentPath('/w/projects/checkout', '../shared/cart.png')).toBe(
      '/w/projects/checkout/../shared/cart.png',
    )
  })

  // The join uses the folder's own separator; a markdown destination keeps writing `/`, and the
  // host's file read resolves the mixed form (the rule pictures have always followed).
  it('spells the join the way the folder is spelled', () => {
    expect(resolveDocumentPath('C:\\w\\projects\\checkout', 'shots/cart.png')).toBe(
      'C:\\w\\projects\\checkout\\shots/cart.png',
    )
  })

  it('leaves a destination the browser fetches on its own alone', () => {
    const base = '/w/projects/checkout'
    expect(resolveDocumentPath(base, 'https://example.com/cart.png')).toBeNull()
    expect(resolveDocumentPath(base, 'http://example.com/cart.png')).toBeNull()
    expect(resolveDocumentPath(base, 'data:image/png;base64,AAAA')).toBeNull()
    expect(resolveDocumentPath(base, 'file:///w/cart.png')).toBeNull()
  })

  it('leaves an absolute path alone — it is not "beside the document"', () => {
    const base = '/w/projects/checkout'
    expect(resolveDocumentPath(base, '/w/other/cart.png')).toBeNull()
    expect(resolveDocumentPath(base, 'C:\\other\\cart.png')).toBeNull()
    expect(resolveDocumentPath(base, '\\\\server\\share\\cart.png')).toBeNull()
    expect(resolveDocumentPath(base, '#cart')).toBeNull()
  })

  it('has no answer without a folder to be relative to', () => {
    expect(resolveDocumentPath(undefined, 'wireframes/cart.png')).toBeNull()
    expect(resolveDocumentPath('', 'wireframes/cart.png')).toBeNull()
  })

  it('has no answer for a destination that is not there', () => {
    expect(resolveDocumentPath('/w/projects/checkout', undefined)).toBeNull()
    expect(resolveDocumentPath('/w/projects/checkout', '')).toBeNull()
  })
})
