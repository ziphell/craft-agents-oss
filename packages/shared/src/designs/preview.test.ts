import { describe, it, expect } from 'bun:test'
import { designDirForLabel, designPreviewLabel, designPreviewUrl } from './preview.ts'

const DIR = '/ws/designs/build-health'

describe('designs/preview', () => {
  it('addresses a design at the app origin, path and all', () => {
    expect(designPreviewUrl('build-health', DIR)).toBe(
      `craft-local://${designPreviewLabel('build-health', DIR)}/index.html`,
    )
    expect(designPreviewUrl('build-health', DIR).startsWith('craft-local://build-health-')).toBe(true)
  })

  it('keeps two designs with the same slug apart, because the folder is what is hashed', () => {
    expect(designPreviewLabel('probe', '/ws-a/designs/probe')).not.toBe(
      designPreviewLabel('probe', '/ws-b/designs/probe'),
    )
  })

  it('finds the folder a label names, and refuses one that names none', () => {
    const candidates = [
      { slug: 'build-health', dir: DIR },
      { slug: 'probe', dir: '/other/designs/probe' },
    ]
    expect(designDirForLabel(designPreviewLabel('probe', '/other/designs/probe'), candidates)).toBe(
      '/other/designs/probe',
    )
    // A slug alone is not an address: the same slug in another workspace is a
    // different origin, so this must not resolve to the one that exists.
    expect(designDirForLabel(designPreviewLabel('probe', '/elsewhere/designs/probe'), candidates)).toBeNull()
    expect(designDirForLabel('probe', candidates)).toBeNull()
  })
})
