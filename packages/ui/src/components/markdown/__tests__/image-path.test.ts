import { describe, it, expect } from 'bun:test'
import { documentDir, resolveDocumentImagePath } from '../image-path'

describe('documentDir', () => {
  it('drops the last segment of a unix path', () => {
    expect(documentDir('/w/prototypes/checkout/PRD.md')).toBe('/w/prototypes/checkout')
  })

  it('drops the last segment of a windows path', () => {
    expect(documentDir('C:\\w\\prototypes\\checkout\\PRD.md')).toBe('C:\\w\\prototypes\\checkout')
  })

  it('keeps a path with nothing to drop', () => {
    expect(documentDir('PRD.md')).toBe('PRD.md')
  })
})

describe('resolveDocumentImagePath', () => {
  it('resolves a picture named beside the document', () => {
    expect(resolveDocumentImagePath('/w/prototypes/checkout', 'wireframes/cart.png')).toBe(
      '/w/prototypes/checkout/wireframes/cart.png',
    )
  })

  it('resolves one named from a subfolder without doubling the separator', () => {
    expect(resolveDocumentImagePath('/w/prototypes/checkout/', './shots/cart.png')).toBe(
      '/w/prototypes/checkout/./shots/cart.png',
    )
  })

  it('keeps the parent step for the host to resolve', () => {
    expect(resolveDocumentImagePath('/w/prototypes/checkout', '../shared/cart.png')).toBe(
      '/w/prototypes/checkout/../shared/cart.png',
    )
  })

  it('spells the join the way the folder is spelled', () => {
    expect(resolveDocumentImagePath('C:\\w\\prototypes\\checkout', 'shots/cart.png')).toBe(
      'C:\\w\\prototypes\\checkout\\shots/cart.png',
    )
  })

  it('leaves a destination the browser fetches on its own alone', () => {
    const base = '/w/prototypes/checkout'
    expect(resolveDocumentImagePath(base, 'https://example.com/cart.png')).toBeNull()
    expect(resolveDocumentImagePath(base, 'http://example.com/cart.png')).toBeNull()
    expect(resolveDocumentImagePath(base, 'data:image/png;base64,AAAA')).toBeNull()
    expect(resolveDocumentImagePath(base, 'file:///w/cart.png')).toBeNull()
  })

  it('leaves an absolute path alone — it is not "beside the document"', () => {
    const base = '/w/prototypes/checkout'
    expect(resolveDocumentImagePath(base, '/w/other/cart.png')).toBeNull()
    expect(resolveDocumentImagePath(base, 'C:\\other\\cart.png')).toBeNull()
    expect(resolveDocumentImagePath(base, '\\\\server\\share\\cart.png')).toBeNull()
    expect(resolveDocumentImagePath(base, '#cart')).toBeNull()
  })

  it('has no answer without a folder to be relative to', () => {
    expect(resolveDocumentImagePath(undefined, 'wireframes/cart.png')).toBeNull()
    expect(resolveDocumentImagePath('', 'wireframes/cart.png')).toBeNull()
  })

  it('has no answer for a destination that is not there', () => {
    expect(resolveDocumentImagePath('/w/prototypes/checkout', undefined)).toBeNull()
    expect(resolveDocumentImagePath('/w/prototypes/checkout', '')).toBeNull()
  })
})
