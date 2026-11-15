import { describe, expect, it } from 'bun:test'
import { nextVersions } from '../versions'

describe('node versions', () => {
  it('starts with the file a run produced', () => {
    expect(nextVersions({ added: 'assets/new.png' })).toEqual(['assets/new.png'])
  })

  it('keeps the previous pointer and the older chain, newest first', () => {
    expect(
      nextVersions({
        added: 'assets/c.png',
        current: 'assets/b.png',
        previous: ['assets/b.png', 'assets/a.png'],
      }),
    ).toEqual(['assets/c.png', 'assets/b.png', 'assets/a.png'])
  })

  it('does not repeat a file that is already in the chain', () => {
    expect(
      nextVersions({
        added: 'assets/b.png',
        current: 'assets/b.png',
        previous: ['assets/b.png', 'assets/a.png'],
      }),
    ).toEqual(['assets/b.png', 'assets/a.png'])
  })

  it('caps the chain so a node does not become an archive', () => {
    const previous = Array.from({ length: 30 }, (_, index) => `assets/${index}.png`)
    expect(nextVersions({ added: 'assets/new.png', previous, limit: 5 })).toHaveLength(5)
  })

  it('ignores empty entries', () => {
    expect(nextVersions({ added: 'assets/a.png', current: '', previous: [''] })).toEqual([
      'assets/a.png',
    ])
  })
})
