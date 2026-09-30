/**
 * Which tweak paths the watcher follows.
 *
 * This is a loop guard, not a detail: the applier writes `hits.json` into a tweak's own
 * folder *because* the rules were just installed, and on this platform an atomic write also
 * reports the folder. Anything that follows either of those re-installs the rules that wrote
 * it, once per debounce, forever.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigWatcher } from '../watcher.ts';
import { createTweak } from '../../tweaks/storage.ts';

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
    watcher = new ConfigWatcher(dir, { onTweaksListChange: () => { changes += 1; } });
    watcher.start();
    slug = createTweak(dir, { name: 'Row ids', matches: ['*://a.test/*'] }).slug;
  });

  afterEach(() => {
    watcher.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const settle = () => new Promise(resolve => setTimeout(resolve, SETTLE_MS));

  it('follows the record and the code beside it', async () => {
    watcher.notifyFileChange(`tweaks/${slug}/tweak.css`);
    await settle();
    expect(changes).toBe(1);

    watcher.notifyFileChange(`tweaks/${slug}/tweak.js`);
    await settle();
    expect(changes).toBe(2);

    watcher.notifyFileChange(`tweaks/${slug}/tweak.json`);
    await settle();
    expect(changes).toBe(3);
  });

  it('ignores hits.json, and the folder it lands in', async () => {
    watcher.notifyFileChange(`tweaks/${slug}/hits.json`);
    watcher.notifyFileChange(`tweaks/${slug}`);
    watcher.notifyFileChange('tweaks');
    await settle();
    expect(changes).toBe(0);
  });
});
