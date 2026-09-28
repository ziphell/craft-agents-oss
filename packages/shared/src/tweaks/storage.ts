/**
 * Tweaks on disk: `{workspace}/tweaks/{slug}/`.
 *
 * One directory per tweak, and the same shape the rest of the app uses — a config for the
 * two facts a file cannot state, and ordinary source files beside it that the agent (or
 * the person) edits with the file tools. Nothing here writes CSS or JS.
 *
 * A tweak's folder is the author's, with one exception: `hits.json` is written by whatever
 * applied the tweak (`./targets.ts`), because a record of a match that did not happen is
 * the one thing it exists to make impossible to fake. It is also why the record is
 * written atomically: the reader is a page load happening right now.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'fs';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { getWorkspaceTweaksPath } from '../workspaces/storage.ts';
import { atomicWriteFileSync, readJsonFileSync } from '../utils/files.ts';
import { generateUniqueSlug } from '../utils/slug.ts';
import { anyMatchPatternMatches, whyMatchPatternIsInvalid } from './match.ts';
import {
  TWEAK_CONFIG_FILENAME,
  TWEAK_CSS_FILENAME,
  TWEAK_HITS_FILENAME,
  TWEAK_JS_FILENAME,
  type CreateTweakInput,
  type LoadedTweak,
  type TweakConfig,
  type UpdateTweakPatch,
} from './types.ts';

/** A slug becomes a folder name (and later an extension file name), so it is a plain one. */
export const TWEAK_SLUG_REGEX = /^[a-z0-9-]+$/;

export function isValidTweakSlug(slug: unknown): slug is string {
  return typeof slug === 'string' && TWEAK_SLUG_REGEX.test(slug);
}

export function assertValidTweakSlug(slug: unknown): asserts slug is string {
  if (!isValidTweakSlug(slug)) {
    throw new Error(`Invalid tweak slug: ${String(slug)}. Slugs are lowercase letters, digits and hyphens.`);
  }
}

/**
 * Get path to a tweak's folder.
 *
 * The single chokepoint every other path derives from: validating the slug here is what
 * keeps a crafted slug from escaping `{workspace}/tweaks/`.
 */
export function getTweakPath(workspaceRootPath: string, slug: string): string {
  assertValidTweakSlug(slug);
  return join(getWorkspaceTweaksPath(workspaceRootPath), slug);
}

export function getTweakConfigPath(workspaceRootPath: string, slug: string): string {
  return join(getTweakPath(workspaceRootPath, slug), TWEAK_CONFIG_FILENAME);
}

export function getTweakCssPath(workspaceRootPath: string, slug: string): string {
  return join(getTweakPath(workspaceRootPath, slug), TWEAK_CSS_FILENAME);
}

export function getTweakJsPath(workspaceRootPath: string, slug: string): string {
  return join(getTweakPath(workspaceRootPath, slug), TWEAK_JS_FILENAME);
}

export function getTweakHitsPath(workspaceRootPath: string, slug: string): string {
  return join(getTweakPath(workspaceRootPath, slug), TWEAK_HITS_FILENAME);
}

// ============================================================
// Config
// ============================================================

/**
 * What is wrong with a tweak's config, as a sentence — or null.
 *
 * Only two things are refused, and both are refused because they are invisible later:
 * a tweak with no pages would never run and never say why, and a pattern that cannot be
 * parsed would match nothing while looking like it matches something.
 */
export function whyTweakConfigIsInvalid(config: Pick<TweakConfig, 'name' | 'matches'>): string | null {
  if (typeof config.name !== 'string' || config.name.trim().length === 0) {
    return 'A tweak needs a name.';
  }
  if (!Array.isArray(config.matches) || config.matches.length === 0) {
    return 'A tweak needs at least one match pattern — the pages it is for.';
  }
  for (const pattern of config.matches) {
    const why = whyMatchPatternIsInvalid(pattern);
    if (why) return why;
  }
  return null;
}

/** Read a tweak's config, or null when there is none or it cannot be read. */
export function loadTweakConfig(workspaceRootPath: string, slug: string): TweakConfig | null {
  if (!isValidTweakSlug(slug)) return null;
  const path = getTweakConfigPath(workspaceRootPath, slug);
  if (!existsSync(path)) return null;
  try {
    return readJsonFileSync<TweakConfig>(path);
  } catch {
    return null;
  }
}

export function saveTweakConfig(workspaceRootPath: string, config: TweakConfig): void {
  atomicWriteFileSync(getTweakConfigPath(workspaceRootPath, config.slug), `${JSON.stringify(config, null, 2)}\n`);
}

/**
 * A tweak as it is on disk: its config, and which code files are actually there.
 *
 * `empty` is reported rather than refused: an author is part-way through writing a tweak
 * far more often than they are wrong, and a tweak with nothing to inject is a blank page
 * rather than a damaged one.
 */
export function loadTweak(workspaceRootPath: string, slug: string): LoadedTweak | null {
  const config = loadTweakConfig(workspaceRootPath, slug);
  if (!config) return null;

  const cssPath = getTweakCssPath(workspaceRootPath, slug);
  const jsPath = getTweakJsPath(workspaceRootPath, slug);
  const hasCss = existsSync(cssPath);
  const hasJs = existsSync(jsPath);
  return {
    config,
    folderPath: getTweakPath(workspaceRootPath, slug),
    cssPath,
    jsPath,
    hasCss,
    hasJs,
    empty: !hasCss && !hasJs,
  };
}

/** A tweak's own source files, as they are — whichever of the two exist. */
export function readTweakSources(tweak: LoadedTweak): { css: string | null; js: string | null } {
  const read = (path: string): string | null => {
    if (!existsSync(path)) return null;
    try {
      return readFileSync(path, 'utf-8');
    } catch {
      return null;
    }
  };
  return { css: read(tweak.cssPath), js: read(tweak.jsPath) };
}

/** Every tweak in the workspace, by name. Missing or unreadable configs are skipped. */
export function loadWorkspaceTweaks(workspaceRootPath: string): LoadedTweak[] {
  const root = getWorkspaceTweaksPath(workspaceRootPath);
  if (!existsSync(root)) return [];

  const tweaks: LoadedTweak[] = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const tweak = loadTweak(workspaceRootPath, entry.name);
    if (tweak) tweaks.push(tweak);
  }

  return tweaks.sort((a, b) => a.config.name.localeCompare(b.config.name));
}

export function tweakExists(workspaceRootPath: string, slug: string): boolean {
  return isValidTweakSlug(slug) && existsSync(getTweakConfigPath(workspaceRootPath, slug));
}

/**
 * The tweaks that apply to an address, in the order they were made.
 *
 * Only **enabled** tweaks: a tweak nobody switched on is not a tweak that runs quietly, it
 * is one that does not run at all. This is the query both carriers ask (`tweaks/` in the
 * app, and the extension's own list), so the answer cannot differ between them.
 */
export function tweaksForUrl(workspaceRootPath: string, url: string): LoadedTweak[] {
  return loadWorkspaceTweaks(workspaceRootPath).filter(
    (tweak) => tweak.config.enabled && anyMatchPatternMatches(tweak.config.matches, url),
  );
}

// ============================================================
// Create / update / delete
// ============================================================

/**
 * Create a tweak from a name and its pages.
 *
 * **Off unless asked otherwise.** A tweak injects into pages somebody is signed in to, and
 * naming those pages is not the same consent as agreeing to run this code in them — so
 * the switch is a person's to flip, and a tweak made by an agent arrives paused.
 */
export function createTweak(workspaceRootPath: string, input: CreateTweakInput): TweakConfig {
  const invalid = whyTweakConfigIsInvalid({ name: input.name, matches: input.matches });
  if (invalid) throw new Error(invalid);

  const root = getWorkspaceTweaksPath(workspaceRootPath);
  const existing = new Set(loadWorkspaceTweaks(workspaceRootPath).map((tweak) => tweak.config.slug));
  const slug = generateUniqueSlug(input.name, existing, 'tweak');

  const now = Date.now();
  const config: TweakConfig = {
    schemaVersion: 1,
    id: `tweak_${randomUUID().slice(0, 8)}`,
    slug,
    name: input.name.trim(),
    ...(input.description ? { description: input.description } : {}),
    matches: [...input.matches],
    enabled: input.enabled ?? false,
    createdAt: now,
    updatedAt: now,
  };

  mkdirSync(getTweakPath(workspaceRootPath, slug), { recursive: true });
  saveTweakConfig(workspaceRootPath, config);
  return config;
}

/**
 * Update a tweak's fields. `id`, `slug` and `createdAt` are not editable — the slug is the
 * folder name, and the id is what a record elsewhere would refer to.
 */
export function updateTweak(workspaceRootPath: string, slug: string, patch: UpdateTweakPatch): TweakConfig {
  const existing = loadTweakConfig(workspaceRootPath, slug);
  if (!existing) throw new Error(`Tweak not found: ${slug}`);

  const next: TweakConfig = {
    ...existing,
    ...(patch.name !== undefined ? { name: patch.name } : {}),
    ...(patch.matches !== undefined ? { matches: patch.matches } : {}),
    ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    updatedAt: Date.now(),
  };

  if (patch.description !== undefined) {
    // Null clears it; a string sets it.
    if (patch.description === null || patch.description.trim() === '') delete next.description;
    else next.description = patch.description;
  }

  const invalid = whyTweakConfigIsInvalid(next);
  if (invalid) throw new Error(invalid);

  saveTweakConfig(workspaceRootPath, next);
  return next;
}

/** Delete a tweak, its sources and its record. */
export function deleteTweak(workspaceRootPath: string, slug: string): void {
  const dir = getTweakPath(workspaceRootPath, slug);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}
