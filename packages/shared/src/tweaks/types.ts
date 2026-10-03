/**
 * A tweak: for the pages it matches, everything in its folder.
 *
 * A tweak is the standing version of an edit somebody makes to a page they do not own —
 * "on our admin console, show the order id next to the customer name". What matters is
 * **who runs it and when**: a tweak is applied every time the page loads, in an ordinary
 * browser, whether or not this app is anywhere near it. That is also why the two carriers
 * are what they are (`tweaks/` in the app, and a loadable extension built from the same
 * files): the tweak is the fact, and the carrier is how it reaches a page.
 *
 * ## What is a file and what is a field
 *
 * The folder holds the tweak, and only two facts live in `tweak.json` because only those
 * two cannot be expressed by a file sitting there:
 *
 * - **which pages it is for** (`matches`) — a tweak with no pages is not a tweak;
 * - **whether it is on** (`enabled`).
 *
 * The code is `tweak.css` and/or `tweak.js`, either or both, found by being there. A tweak
 * whose folder has neither is a tweak that does nothing, which `loadTweak` reports rather
 * than refuses: the author is mid-edit far more often than they are wrong.
 *
 * ## Why the patterns are Chrome's
 *
 * `matches` are **Chrome match patterns** (`*://*.example.com/admin/*`), not a regular
 * expression of our own: the extension carrier is one of the two ways a tweak reaches a
 * page, and `content_scripts` takes exactly this grammar. Inventing a richer one would
 * mean the in-app carrier could express tweaks the extension could not run — the same
 * tweak behaving differently depending on how it was delivered.
 */

/** One entry of the tweaks index, as `tweak.json` states it. */
export interface TweakConfig {
  schemaVersion: 1;
  /** Stable id, e.g. tweak_1a2b3c4d */
  id: string;
  slug: string;
  name: string;
  /** Optional note on what the tweak is for — shown beside it, never parsed. */
  description?: string;
  /**
   * Chrome match patterns for the pages this tweak applies to. At least one, and a
   * pattern that cannot be parsed is refused on write rather than silently matching
   * nothing.
   */
  matches: string[];
  /**
   * Whether the tweak is applied. **Off until somebody turns it on**: a tweak injects into
   * pages the person is signed in to, so naming those pages is not the same consent as
   * agreeing to run this code in them.
   */
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

/** A tweak as it sits on disk: its config plus the code files that are actually there. */
export interface LoadedTweak {
  config: TweakConfig;
  /** Absolute path to the tweak's folder. */
  folderPath: string;
  /** Absolute path to `tweak.css`, whether or not it exists. */
  cssPath: string;
  /** Absolute path to `tweak.js`, whether or not it exists. */
  jsPath: string;
  /** Whether each of the two files is there — a path alone does not say that. */
  hasCss: boolean;
  hasJs: boolean;
  /** True when the folder has neither `tweak.css` nor `tweak.js`. */
  empty: boolean;
}

/** What an edit to a tweak may change. `id`, `slug` and `createdAt` never change. */
export interface UpdateTweakPatch {
  name?: string;
  description?: string | null;
  matches?: string[];
  enabled?: boolean;
}

export interface CreateTweakInput {
  name: string;
  description?: string;
  matches: string[];
  enabled?: boolean;
}

/**
 * One thing a tweak expects to find on the page, recorded from what it actually matched.
 *
 * `selector` is declared in the tweak's own source — a `@target <css>` comment line — and
 * is what makes drift visible: the tweak keeps running on a page that has been
 * redesigned, and this is how "it stopped matching" is told from "it never matched".
 * A tweak that declares none is simply not checked; nothing here is required.
 */
export interface TweakTargetHit {
  /** The selector as the tweak declared it. */
  selector: string;
  /** Which file declared it, for pointing at the line that needs changing. */
  file: 'tweak.css' | 'tweak.js';
  /** When it last matched something, epoch ms. Absent means it never has. */
  lastMatchedAt?: number;
  /** The page it last matched on. */
  lastMatchedUrl?: string;
}

/**
 * The record of what a tweak's targets matched, written by whatever applied the tweak and
 * **never by hand**: a record of a match that did not happen is the one thing this file
 * exists to make impossible to fake.
 */
export interface TweakHits {
  schemaVersion: 1;
  /** When this record was last written. */
  updatedAt: number;
  targets: TweakTargetHit[];
}

/** The file names a tweak folder is made of. */
export const TWEAK_CONFIG_FILENAME = 'tweak.json';
export const TWEAK_CSS_FILENAME = 'tweak.css';
export const TWEAK_JS_FILENAME = 'tweak.js';
export const TWEAK_HITS_FILENAME = 'hits.json';
