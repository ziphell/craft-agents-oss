import { describe, it, expect, afterAll } from 'bun:test';
import { inflateRawSync } from 'node:zlib';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  crc32,
  createZipArchive,
  deckPageSizeInches,
  deckSlideSize,
  buildActivateDeckSlideScript,
  buildShowAllDeckSlidesScript,
  buildParkArtboardScript,
  buildShowAllArtboardsScript,
  buildExportPptxScript,
  DECK_SLIDE_SELECTOR,
  ARTBOARD_SELECTOR,
  COUNT_ARTBOARDS_SCRIPT,
  designExportFileName,
  designExportFilters,
  designMotionFileName,
  designMotionFilters,
  motionFrameCount,
  resolveMotionSettings,
  DEFAULT_MOTION_DURATION_MS,
  DEFAULT_MOTION_FPS,
  writeDesignHtmlExport,
  writeDesignZipExport,
} from './export.ts';

const dirs: string[] = [];
function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'design-export-'));
  dirs.push(dir);
  const folder = join(dir, 'designs', 'demo');
  mkdirSync(join(folder, 'data'), { recursive: true });
  writeFileSync(join(folder, 'index.html'), '<!doctype html><h1>Hello</h1>', 'utf-8');
  writeFileSync(join(folder, 'design.json'), '{"slug":"demo"}', 'utf-8');
  writeFileSync(join(folder, 'data', 'snapshot.json'), '{"version":1}', 'utf-8');
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('design export helpers', () => {
  it('deck geometry matches the deck @page size (16:9 → 1280×720 px / 13.33×7.5 in)', () => {
    expect(deckSlideSize('16:9')).toEqual({ width: 1280, height: 720 });
    expect(deckPageSizeInches('16:9').width).toBeCloseTo(1280 / 96, 5);
    expect(deckPageSizeInches('16:9').height).toBeCloseTo(720 / 96, 5);
    // 9:16 is portrait.
    expect(deckSlideSize('9:16')).toEqual({ width: 720, height: 1280 });
  });

  it('activation script toggles active/is-active for the asked index', () => {
    const script = buildActivateDeckSlideScript(2);
    expect(script).toContain("querySelectorAll('.slide')");
    expect(script).toContain('i === 2');
    expect(script).toContain("classList.toggle('active'");
    expect(script).toContain("classList.toggle('is-active'");
  });

  it('parks one canvas artboard at the origin, at its own size', () => {
    expect(ARTBOARD_SELECTOR).toBe('.artboard');
    const script = buildParkArtboardScript(1);
    expect(COUNT_ARTBOARDS_SCRIPT).toContain("querySelectorAll('.artboard')");
    expect(script).toContain("querySelectorAll('.artboard')");
    // The camera is neutralised once, and only this frame is left at the origin.
    expect(script).toContain("setProperty('transform', 'none', 'important')");
    expect(script).toContain("setProperty('transform', i === 1 ? 'translate(0px, 0px)' : 'none', 'important')");
    // The others step aside — and a design that keeps running cannot put them back.
    expect(script).toContain("setProperty('visibility', i === 1 ? 'visible' : 'hidden', 'important')");
    // Its own size — transforms do not touch offsetWidth/offsetHeight, which is what
    // makes the capture 1:1 rather than the zoom the design happened to be at.
    expect(script).toContain('return [Math.round(rect.left), Math.round(rect.top), board.offsetWidth, board.offsetHeight]');
    // The position is measured, never assumed: the world origin is the frames' container,
    // which is not the document's origin when a rail sits beside it.
    expect(script).toContain('board.getBoundingClientRect()');
    expect(script).toContain('if (!board) return [0, 0, 0, 0]');
  });

  it('lays every canvas artboard out in a column for a PPTX walk', () => {
    const script = buildShowAllArtboardsScript();
    expect(script).toContain("querySelectorAll('.artboard')");
    expect(script).toContain("setProperty('transform', 'none', 'important')");
    expect(script).toContain('return boards.length');
  });

  it('names and filters a single-file format', () => {
    expect(designExportFileName('demo', 'pdf')).toBe('demo.pdf');
    expect(designExportFilters('zip')).toEqual([{ name: 'ZIP', extensions: ['zip'] }]);
  });

  it('names and filters the editable PPTX file', () => {
    expect(designExportFileName('demo', 'pptx')).toBe('demo.pptx');
    expect(designExportFilters('pptx')).toEqual([{ name: 'PPTX', extensions: ['pptx'] }]);
  });

  it('lays every slide out at once before a PPTX export', () => {
    const script = buildShowAllDeckSlidesScript();
    expect(DECK_SLIDE_SELECTOR).toBe('.slide');
    expect(script).toContain("querySelectorAll('.slide')");
    // The visible style comes from the deck's own `.slide.active` rule.
    expect(script).toContain("classList.add('active')");
    expect(script).toContain("setProperty('opacity', '1', 'important')");
    expect(script).toContain("setProperty('visibility', 'visible', 'important')");
    // `display: none` has no layout box regardless of the class.
    expect(script).toContain("getComputedStyle(el).display === 'none'");
    expect(script).toContain('return slides.length');
  });

  it('exports the rendered DOM to a base64 PPTX at the requested page size', () => {
    const script = buildExportPptxScript(13.333, 7.5);
    // Deck → one slide per `.slide`; a canvas → one per `.artboard`; a plain design → the page body.
    expect(script).toContain("querySelectorAll('.slide, .artboard')");
    expect(script).toContain('slides.length > 0 ? slides : [document.body]');
    expect(script).toContain('window.domToPptx.exportToPptx');
    expect(script).toContain('skipDownload: true');
    expect(script).toContain('width: 13.333');
    expect(script).toContain('height: 7.5');
    // Blob → base64 string (the only shape executeJavaScript can serialize).
    expect(script).toContain('readAsDataURL');
    expect(script).toContain("split(',')[1]");
    expect(script).toContain('return { b64: b64, slides: targets.length }');
    // Engine failures are returned, never thrown out of the window.
    expect(script).toContain('return { error:');
  });

  it('writes index.html verbatim', () => {
    const workspace = makeWorkspace();
    const dest = join(workspace, 'out', 'demo.html');
    const written = writeDesignHtmlExport(workspace, 'demo', dest);
    expect(written).toBe(dest);
    expect(readFileSync(dest, 'utf-8')).toBe('<!doctype html><h1>Hello</h1>');
  });

  it('archives the whole design folder', () => {
    const workspace = makeWorkspace();
    const dest = join(workspace, 'out', 'demo.zip');
    writeDesignZipExport(workspace, 'demo', dest);
    const zip = readFileSync(dest);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50); // local file header
    expect(zip.readUInt32LE(zip.length - 22)).toBe(0x06054b50); // end of central directory
    const names = readEntryNames(zip);
    expect(names).toContain('design.json');
    expect(names).toContain('index.html');
    expect(names).toContain('data/snapshot.json');
  });

  it('defaults and clamps motion settings to the policy bounds', () => {
    expect(DEFAULT_MOTION_FPS).toBe(30);
    expect(DEFAULT_MOTION_DURATION_MS).toBe(5000);
    expect(resolveMotionSettings()).toEqual({ fps: 30, durationMs: 5000, aspect: '16:9' });
    // Rounding, then clamping: 0 fps → 1, and an hour of video → the 10min ceiling.
    expect(resolveMotionSettings({ fps: 0, durationMs: 999_999_999, aspect: '9:16' }))
      .toEqual({ fps: 1, durationMs: 600_000, aspect: '9:16' });
    expect(resolveMotionSettings({ fps: 1000 })).toEqual({ fps: 60, durationMs: 5000, aspect: '16:9' });
  });

  it('computes the frame budget as duration × fps', () => {
    expect(motionFrameCount({ fps: 30, durationMs: 5000, aspect: '16:9' })).toBe(150);
    // Partial seconds round up — the last frame is still captured.
    expect(motionFrameCount({ fps: 24, durationMs: 1001, aspect: '16:9' })).toBe(25);
    expect(motionFrameCount({ fps: 30, durationMs: 0, aspect: '16:9' })).toBe(1);
  });

  it('names and filters the video file', () => {
    expect(designMotionFileName('demo')).toBe('demo.mp4');
    expect(designMotionFilters()).toEqual([{ name: 'MP4', extensions: ['mp4'] }]);
  });

  it('round-trips a deflate entry', () => {
    const data = Buffer.from('hello zip', 'utf-8');
    const zip = createZipArchive([{ path: 'a.txt', data }]);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    const nameLen = zip.readUInt16LE(26);
    const compLen = zip.readUInt32LE(18);
    const start = 30 + nameLen;
    expect(inflateRawSync(zip.subarray(start, start + compLen))).toEqual(data);
    expect(crc32(data)).toBe(crc32(Buffer.from('hello zip', 'utf-8')));
  });
});

/** Read the entry names out of a ZIP's central directory (test-only helper). */
function readEntryNames(zip: Buffer): string[] {
  const end = zip.length - 22;
  const count = zip.readUInt16LE(end + 10);
  let offset = zip.readUInt32LE(end + 16);
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const nameLen = zip.readUInt16LE(offset + 28);
    names.push(zip.subarray(offset + 46, offset + 46 + nameLen).toString('utf-8'));
    const extraLen = zip.readUInt16LE(offset + 30);
    const commentLen = zip.readUInt16LE(offset + 32);
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}
