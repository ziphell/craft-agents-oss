import { describe, expect, it } from 'bun:test'
import { selectionMessage } from '../canvas-selection'

describe('selection message', () => {
  it('names each card by file, type and id, then the instruction', () => {
    const message = selectionMessage(
      [
        { id: 'n-1', type: 'image', src: 'assets/cat.png' },
        { id: 'n-2', type: 'text', src: 'docs/shot-01.md' },
      ],
      'Canvas selection (2 cards):',
      'Make both backgrounds white.',
    )

    expect(message).toBe(
      [
        'Canvas selection (2 cards):',
        '1. cat.png · image · assets/cat.png · n-1',
        '2. shot-01.md · text · docs/shot-01.md · n-2',
        '',
        'Make both backgrounds white.',
      ].join('\n'),
    )
  })

  it('still says which card when it has no file yet', () => {
    const message = selectionMessage([{ id: 'n-3', type: 'image' }], 'Canvas selection (1 cards):', 'Fill this.')
    expect(message).toContain('1. image · image · — · n-3')
  })
})
