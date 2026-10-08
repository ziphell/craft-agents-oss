/**
 * Design Export
 *
 * Taking a design out of the workspace. The two formats that need only the
 * files themselves — HTML (the raw, already self-contained document) and ZIP
 * (the whole design folder) — are written here, so any host can serve them.
 * The ones that need a real rendering engine — PDF (Electron print), PNG (one
 * image per slide), motion video, and editable PPTX (the vendored `dom-to-pptx`
 * engine) — are produced by the desktop app's hidden BrowserWindow
 * (apps/electron/src/main/design-exporter.ts) and reached through the injected
 * `designExportRender` seam (see handler-deps.ts).
 *
 * The scripts the render window runs for PPTX live here too: pure string
 * builders, so the deck contract (`.slide` / `.slide.active`) they rely on is
 * unit-testable without Electron.
 *
 * Not here, deliberately out of scope: Markdown (goes through an external CLI).
 */

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import type { DesignDeckAspect, DesignMotionSpec } from '@craft-agent/core';
import { getDesignContentPath, getDesignPath } from './storage.ts';
import type { DesignExportFormat, DesignMotionSettings } from './types.ts';
import {
  MOTION_DURATION_MS_MAX,
  MOTION_DURATION_MS_MIN,
  MOTION_FPS_MAX,
  MOTION_FPS_MIN,
} from './validation.ts';

/** Logical slide size in CSS px for each authored aspect (width × height). */
const DECK_ASPECT_PX: Record<DesignDeckAspect, { width: number; height: number }> = {
  '16:9': { width: 1280, height: 720 },
  '4:3': { width: 1280, height: 960 },
  '16:10': { width: 1280, height: 800 },
  '9:16': { width: 720, height: 1280 },
};

/** Absent aspect means 16:9 (see DesignDeckSpec). */
export const DEFAULT_DECK_ASPECT: DesignDeckAspect = '16:9';

/** CSS px are 1/96 inch — the same unit a deck's `@page { size: Npx }` uses. */
const CSS_PX_PER_INCH = 96;

/** Logical slide size for an authored aspect, letterboxed to a page. */
export function deckSlideSize(aspect?: DesignDeckAspect): { width: number; height: number } {
  return DECK_ASPECT_PX[aspect ?? DEFAULT_DECK_ASPECT];
}

/**
 * Paper size for Electron's `printToPDF`, which takes a custom `pageSize` in
 * inches. Matches the deck's own `@page` size, so one slide fills one page.
 */
export function deckPageSizeInches(aspect?: DesignDeckAspect): { width: number; height: number } {
  const px = deckSlideSize(aspect);
  return { width: px.width / CSS_PX_PER_INCH, height: px.height / CSS_PX_PER_INCH };
}

// ---------------------------------------------------------------------------
// Motion (HTML → video)
// ---------------------------------------------------------------------------

/** Capture frame rate when `motion.fps` is absent. */
export const DEFAULT_MOTION_FPS = 30;
/** Piece length when `motion.durationMs` is absent. */
export const DEFAULT_MOTION_DURATION_MS = 5000;

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/**
 * Resolve a stored `motion` hint into the numbers the renderer captures with.
 *
 * Defaults fill the absent knobs and the policy bounds (validation.ts) clamp
 * what is present, so a hand-edited design.json that bypassed validation still
 * renders within limits instead of being refused or asked for an hour of video.
 * Pure — the renderer is handed the result and does no policy of its own.
 */
export function resolveMotionSettings(motion?: DesignMotionSpec): DesignMotionSettings {
  return {
    fps: clamp(Math.round(motion?.fps ?? DEFAULT_MOTION_FPS), MOTION_FPS_MIN, MOTION_FPS_MAX),
    durationMs: clamp(
      Math.round(motion?.durationMs ?? DEFAULT_MOTION_DURATION_MS),
      MOTION_DURATION_MS_MIN,
      MOTION_DURATION_MS_MAX,
    ),
    aspect: motion?.aspect ?? DEFAULT_DECK_ASPECT,
  };
}

/**
 * How many frames `durationMs` at `fps` is worth — the capture's frame budget.
 *
 * Only meaningful as a budget: the screencast is sampled in realtime, so this
 * is what a perfect run would deliver, not a count the encoder is driven by
 * (see docs/designs.md "Motion" for the determinism caveat).
 */
export function motionFrameCount(settings: DesignMotionSettings): number {
  return Math.max(1, Math.ceil((settings.durationMs / 1000) * settings.fps));
}

/**
 * Default filename shown in the save dialog for a motion export. MP4 because
 * the recorder negotiates mp4 only (shared/recording-formats.ts) — a build that
 * can record nothing else refuses the export rather than writing another shape.
 */
export function designMotionFileName(slug: string): string {
  return `${slug}.mp4`;
}

/** Save-dialog filters for a motion export. */
export function designMotionFilters(): Array<{ name: string; extensions: string[] }> {
  return [{ name: 'MP4', extensions: ['mp4'] }];
}

/** Highest slide index we will walk (the bridge's own bound on reported slides). */
export const MAX_DECK_SLIDES = 1000;

/** Number of `.slide` elements (0 = not a deck). Runs in the rendered document. */
export const COUNT_DECK_SLIDES_SCRIPT = 'document.querySelectorAll(".slide").length';

/**
 * The canvas convention: one **artboard** is one page (`docs/designs.md`, "Frames and a
 * canvas"). A design with `.slide` elements is a deck and keeps the deck contract; a
 * design with `.artboard` elements is a canvas, whose frames are all laid out at once and
 * each carry their own pixel size. Nothing is configured for either — the element is the
 * convention, exactly as `.slide` is for a deck.
 */
export const ARTBOARD_SELECTOR = '.artboard';

/** Number of canvas pages, for a design with no `.slide` (0 = neither convention). */
export const COUNT_ARTBOARDS_SCRIPT = `document.querySelectorAll('${ARTBOARD_SELECTOR}').length`;

/**
 * Park canvas page `index` at 1:1 and report **where it is and its own size** —
 * `[x, y, width, height]` in viewport pixels, or `[0, 0, 0, 0]` when there is no such page.
 * Runs in the rendered document.
 *
 * A canvas positions its frames by transform and shows them through a camera, so capturing
 * one frame means undoing both for that frame: the camera goes back to identity, the frame
 * lands at the world origin, and its siblings step aside. `offsetWidth`/`offsetHeight` are
 * the frame's real size — a transform does not touch them — which is what makes the image
 * 1:1 rather than whatever zoom the design happened to be at.
 *
 * The position is **measured, never assumed**: the world origin is the top-left of whatever
 * container holds the frames, which is not the top-left of the document (a rail may sit to
 * its left). A capture rect of `[x, y, width, height]` is therefore the frame and nothing
 * else, whatever the document's own layout is. The design's chrome lives outside the
 * artboards, so it can never land in that rect.
 */
export function buildParkArtboardScript(index: number): string {
  return `(function () {
  var boards = Array.prototype.slice.call(document.querySelectorAll('${ARTBOARD_SELECTOR}'));
  var board = boards[${index}];
  if (!board) return [0, 0, 0, 0];
  // **important**, because the design keeps running: a canvas re-frames on resize (and the window is
  // being sized for this page), while the design writes plain inline styles. Measured without it:
  // the "parked" page came back as the design's own overview at 14%, its chrome included, because
  // the design's resize handler had put the camera back.
  if (board.parentElement) board.parentElement.style.setProperty('transform', 'none', 'important');
  boards.forEach(function (el, i) {
    el.style.setProperty('transform', i === ${index} ? 'translate(0px, 0px)' : 'none', 'important');
    el.style.setProperty('visibility', i === ${index} ? 'visible' : 'hidden', 'important');
  });
  var rect = board.getBoundingClientRect();
  return [Math.round(rect.left), Math.round(rect.top), board.offsetWidth, board.offsetHeight];
})()`;
}

/**
 * Lay every canvas page out at 1:1 in a column, for an engine that measures them all at
 * once (the PPTX walk). Returns the page count. Runs in the rendered document.
 */
export function buildShowAllArtboardsScript(): string {
  return `(function () {
  var boards = Array.prototype.slice.call(document.querySelectorAll('${ARTBOARD_SELECTOR}'));
  if (boards.length > 0 && boards[0].parentElement) boards[0].parentElement.style.setProperty('transform', 'none', 'important');
  var y = 0;
  boards.forEach(function (el) {
    el.style.setProperty('transform', 'translate(0px, ' + y + 'px)', 'important');
    el.style.setProperty('visibility', 'visible', 'important');
    y += el.offsetHeight + 40;
  });
  return boards.length;
})()`;
}

/**
 * Activate slide `index` per the documented deck contract (`.slide.active`,
 * `.is-active` alias), and return the slide count. Runs in the rendered
 * document — the deck owns navigation, this only drives it for a capture.
 */
export function buildActivateDeckSlideScript(index: number): string {
  return `(function () {
  var slides = Array.prototype.slice.call(document.querySelectorAll('.slide'));
  slides.forEach(function (slide, i) {
    slide.classList.toggle('active', i === ${index});
    slide.classList.toggle('is-active', i === ${index});
  });
  return slides.length;
})()`;
}

/** Default filename shown in the save dialog for a single-file format. */
export function designExportFileName(
  slug: string,
  format: Exclude<DesignExportFormat, 'png' | 'video'>,
): string {
  return `${slug}.${format}`;
}

/** Save-dialog filters for a single-file format (`png`/`video` have their own). */
export function designExportFilters(
  format: Exclude<DesignExportFormat, 'png' | 'video'>,
): Array<{ name: string; extensions: string[] }> {
  switch (format) {
    case 'pdf':
      return [{ name: 'PDF', extensions: ['pdf'] }];
    case 'pptx':
      return [{ name: 'PPTX', extensions: ['pptx'] }];
    case 'html':
      return [{ name: 'HTML', extensions: ['html'] }];
    case 'zip':
      return [{ name: 'ZIP', extensions: ['zip'] }];
  }
}

// ---------------------------------------------------------------------------
// Editable PPTX (rendered DOM → native shapes/text via the vendored engine)
// ---------------------------------------------------------------------------

/** CSS selector the deck contract uses for one slide (`docs/designs.md`). */
export const DECK_SLIDE_SELECTOR = '.slide';

/**
 * What counts as a page for a rendered walk: a deck's slides, or a canvas's artboards.
 * One design uses one convention (a deck has `.slide` elements, a canvas has `.artboard`
 * frames), and the engine is handed both, so it picks up whatever the document has.
 */
export const DESIGN_PAGE_SELECTOR = `${DECK_SLIDE_SELECTOR}, ${ARTBOARD_SELECTOR}`;

/**
 * Lay every `.slide` out at once so the PPTX engine can measure each as its own
 * slide. A deck normally keeps only the active slide laid out (the starter deck
 * does it with `.slide { display: none } .slide.active { display: grid }`), so
 * the inactive ones would otherwise measure as empty boxes. Adding the `active`
 * class re-applies the deck's own visible style (that class *is* the documented
 * contract); the inline overrides are a belt-and-braces for decks that hide by
 * `opacity` / `visibility` instead. Returns the slide count. Runs in the
 * rendered document.
 */
export function buildShowAllDeckSlidesScript(): string {
  return `(function () {
  var slides = Array.prototype.slice.call(document.querySelectorAll('${DECK_SLIDE_SELECTOR}'));
  slides.forEach(function (el) {
    el.classList.add('active');
    el.style.setProperty('opacity', '1', 'important');
    el.style.setProperty('visibility', 'visible', 'important');
    // display:none has no layout box regardless of the class above; fall back
    // to block only when the deck's own active style did not already reveal it.
    if (getComputedStyle(el).display === 'none') {
      el.style.setProperty('display', 'block', 'important');
    }
  });
  return slides.length;
})()`;
}

/**
 * Export the rendered document to an editable PPTX inside the render window.
 *
 * A deck (`slides > 0`) becomes one PPTX slide per `.slide`, in DOM order; a
 * plain design becomes a single slide holding the page body. The engine returns
 * a `Blob`; this hands it back as base64 (a string is all `executeJavaScript`
 * can serialize), so the main process writes the bytes with no filesystem access
 * in the window. Never rejects — engine failures come back as `{ error }` so the
 * caller can surface the real message.
 */
export function buildExportPptxScript(widthInches: number, heightInches: number): string {
  return `(async function () {
  var slides = Array.prototype.slice.call(document.querySelectorAll('${DESIGN_PAGE_SELECTOR}'));
  var targets = slides.length > 0 ? slides : [document.body];
  if (!window.domToPptx || typeof window.domToPptx.exportToPptx !== 'function') {
    return { error: 'The editable PPTX engine did not load' };
  }
  try {
    var blob = await window.domToPptx.exportToPptx(targets, {
      skipDownload: true,
      width: ${widthInches},
      height: ${heightInches},
    });
    if (!blob) return { error: 'The editable PPTX engine returned no file' };
    var dataUrl = await new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onloadend = function () { resolve(reader.result); };
      reader.onerror = function () { reject(reader.error || new Error('Could not read the generated file')); };
      reader.readAsDataURL(blob);
    });
    var b64 = String(dataUrl).split(',')[1];
    if (!b64) return { error: 'The editable PPTX engine produced an empty file' };
    return { b64: b64, slides: targets.length };
  } catch (err) {
    return { error: (err && err.message) ? err.message : String(err) };
  }
})()`;
}

/**
 * Write the design's `index.html` verbatim to `destPath`. It is already a
 * self-contained single file, so this is a copy, not a build.
 */
export function writeDesignHtmlExport(
  workspaceRootPath: string,
  designSlug: string,
  destPath: string,
): string {
  const source = getDesignContentPath(workspaceRootPath, designSlug);
  const content = readFileSync(source, 'utf-8');
  writeFileAt(content, destPath);
  return destPath;
}

/**
 * Archive the whole design folder (`design.json`, `index.html`, `data/`, and
 * anything else the folder holds) to `destPath` as a ZIP.
 */
export function writeDesignZipExport(
  workspaceRootPath: string,
  designSlug: string,
  destPath: string,
): string {
  const folder = getDesignPath(workspaceRootPath, designSlug);
  const entries = collectFiles(folder).map((absolute) => ({
    path: relative(folder, absolute).split(sep).join('/'),
    data: readFileSync(absolute),
  }));
  writeFileAt(createZipArchive(entries), destPath);
  return destPath;
}

/** All regular files under `dir`, depth-first (symlinks are skipped). */
function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const absolute = join(dir, name);
    const stats = statSync(absolute);
    if (stats.isDirectory()) out.push(...collectFiles(absolute));
    else if (stats.isFile()) out.push(absolute);
  }
  return out;
}

function writeFileAt(data: string | Buffer, destPath: string): void {
  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, data);
}

// ---------------------------------------------------------------------------
// Minimal ZIP writer (deflate). No archive dependency is added for one export.
// ---------------------------------------------------------------------------

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

/** Standard CRC-32 of a buffer, as ZIP requires. */
export function crc32(buffer: Buffer): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = table[(crc ^ buffer[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Build a ZIP archive (deflate-compressed entries) from `{ path, data }`. */
export function createZipArchive(entries: Array<{ path: string; data: Buffer }>): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf-8');
    const crc = crc32(entry.data);
    const compressed = deflateRawSync(entry.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10); // mod time (unset — not meaningful for an export)
    local.writeUInt16LE(0, 12); // mod date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length

    chunks.push(local, name, compressed);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); // central directory header
    dir.writeUInt16LE(20, 4); // version made by
    dir.writeUInt16LE(20, 6); // version needed
    dir.writeUInt16LE(0x0800, 8); // UTF-8 filename flag
    dir.writeUInt16LE(8, 10); // deflate
    dir.writeUInt16LE(0, 12); // mod time
    dir.writeUInt16LE(0, 14); // mod date
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(compressed.length, 20);
    dir.writeUInt32LE(entry.data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt16LE(0, 30); // extra length
    dir.writeUInt16LE(0, 32); // comment length
    dir.writeUInt16LE(0, 34); // disk number start
    dir.writeUInt16LE(0, 36); // internal attributes
    dir.writeUInt32LE(0, 38); // external attributes
    dir.writeUInt32LE(offset, 42); // local header offset
    central.push(dir, name);
    offset += local.length + name.length + compressed.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central directory
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with central directory
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...chunks, centralBuffer, end]);
}
