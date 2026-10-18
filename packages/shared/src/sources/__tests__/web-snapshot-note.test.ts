/**
 * The note's shape.
 *
 * One thing a second writer would get wrong: the note's envelope is written in exactly one place.
 */

import { describe, test, expect } from 'bun:test';
import { renderWebSnapshotNote } from '../web-snapshot.ts';

const base = {
  url: 'http://127.0.0.1:8188/',
  title: 'ComfyUI',
  markdown: 'the page, as markdown',
  meta: {},
  capturedAt: Date.UTC(2026, 9, 10),
};

describe('renderWebSnapshotNote', () => {
  test('the body follows the frontmatter', () => {
    const note = renderWebSnapshotNote(base);
    expect(note.startsWith('---\n')).toBe(true);
    expect(note).toContain('source: http://127.0.0.1:8188/');
    expect(note.endsWith('\n---\n\nthe page, as markdown\n')).toBe(true);
  });
});
