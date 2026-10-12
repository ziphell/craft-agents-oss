/**
 * Which tweak paths the watcher follows.
 *
 * This is a loop guard, not a detail: the applier writes `hits.json` into a tweak's own
 * folder *because* the rules were just installed, and on this platform an atomic write also
 * reports the folder. Anything that follows either of those re-installs the rules that wrote
 * it, once per debounce, forever.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigWatcher } from '../watcher.ts';
import { createTweak, getTweakCssPath, getTweakJsPath, updateTweak } from '../../tweaks/storage.ts';

/** Longer than the watcher's own debounce (100ms). */
const SETTLE_MS = 250;

describe('ConfigWatcher tweak events', () => {
  let dir: string;
  let watcher: ConfigWatcher;
  let changes: number;
  let slug: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'craft-watch-tweaks-'));
    changes = 0;
    // The tweak exists before the watcher starts, so its seeded signature matches disk — the
    // same shape as a watcher started on a workspace that already has tweaks in it.
    slug = createTweak(dir, { name: 'Row ids', matches: ['*://a.test/*'] }).slug;
    watcher = new ConfigWatcher(dir, { onTweaksListChange: () => { changes += 1; } });
    watcher.start();
  });

  afterEach(() => {
    watcher.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const settle = () => new Promise(resolve => setTimeout(resolve, SETTLE_MS));

  it('follows the record and the code beside it', async () => {
    writeFileSync(getTweakCssPath(dir, slug), '.row{}', 'utf-8');
    watcher.notifyFileChange(`tweaks/${slug}/tweak.css`);
    await settle();
    expect(changes).toBe(1);

    writeFileSync(getTweakJsPath(dir, slug), 'void 0', 'utf-8');
    watcher.notifyFileChange(`tweaks/${slug}/tweak.js`);
    await settle();
    expect(changes).toBe(2);

    updateTweak(dir, slug, { enabled: true });
    watcher.notifyFileChange(`tweaks/${slug}/tweak.json`);
    await settle();
    expect(changes).toBe(3);
  });

  it('takes a folder-level change as a candidate for a code edit', async () => {
    // What this platform reports for a plain write to a file that already existed: only the
    // folder. The edit must not be lost just because no file-level event came.
    writeFileSync(getTweakJsPath(dir, slug), 'void 0', 'utf-8');
    watcher.notifyFileChange(`tweaks/${slug}`);
    await settle();
    expect(changes).toBe(1);
  });

  it('ignores a write that does not change the record or the code', async () => {
    // The applier's own hits.json lands in the same folder and raises the same folder event;
    // re-installing on it would be the rules re-running forever.
    writeFileSync(join(dir, 'tweaks', slug, 'hits.json'), '{}', 'utf-8');
    watcher.notifyFileChange(`tweaks/${slug}/hits.json`);
    watcher.notifyFileChange(`tweaks/${slug}`);
    watcher.notifyFileChange('tweaks');
    await settle();
    expect(changes).toBe(0);
  });
});
