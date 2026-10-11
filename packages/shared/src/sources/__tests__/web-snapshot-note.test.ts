/**
 * The note's shape, and the page picture's name.
 *
 * Two things a second writer would get wrong: the note's envelope is written in exactly one place,
 * and a picture that lands on a new name every capture piles up copies instead of standing in for
 * the same page.
 */

import { describe, test, expect } from 'bun:test';
import { pageShotFileName, renderWebSnapshotNote } from '../web-snapshot.ts';

const base = {
  url: 'http://127.0.0.1:8188/',
  title: 'ComfyUI',
  markdown: 'the page, as markdown',
  meta: {},
  capturedAt: Date.UTC(2026, 9, 10),
};

describe('renderWebSnapshotNote', () => {
  test('without a picture the body follows the frontmatter as before', () => {
    const note = renderWebSnapshotNote(base);
    expect(note.startsWith('---\n')).toBe(true);
    expect(note).toContain('source: http://127.0.0.1:8188/');
    expect(note.endsWith('\n---\n\nthe page, as markdown\n')).toBe(true);
    expect(note).not.toContain('![');
  });

  test('a kept picture leads the body', () => {
    const shot = 'snapshot.assets/page-abc12345.png';
    const note = renderWebSnapshotNote({ ...base, leadImage: shot });
    const image = `![The page as captured](${shot})`;
    expect(note).toContain(`\n---\n\n${image}\n\nthe page, as markdown\n`);
    expect(note.indexOf(image)).toBeLessThan(note.indexOf('the page, as markdown'));
  });
});

describe('pageShotFileName', () => {
  test('stable per bytes, and named for what it is', () => {
    const a = pageShotFileName(new Uint8Array([1, 2, 3]));
    expect(a).toMatch(/^page-[0-9a-f]{8}\.png$/);
    expect(pageShotFileName(new Uint8Array([1, 2, 3]))).toBe(a);
    expect(pageShotFileName(new Uint8Array([1, 2, 4]))).not.toBe(a);
  });
});
