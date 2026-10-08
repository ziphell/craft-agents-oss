/**
 * What a design is — `prototype`, `deck` or `motion` — and the one rule that
 * keeps the stored kind and its settings from ever disagreeing.
 *
 * The kind is **declared and stored** rather than computed from the settings:
 * it is intent (an author knows they are making a deck before there is any
 * markup to read it off), it is what the list filter, the export menu and any
 * query bind to, and a computed answer goes wrong the moment the two disagree
 * — a design that *is* a deck but never said so would be labelled a page while
 * the app also treats it as one.
 *
 * The `deck` / `motion` settings are the parameters **of** that kind, so they
 * are resolved with it, once, at the single write path:
 *
 * - settings without a kind settle the kind (passing `deck` settings *is*
 *   saying "this is a deck");
 * - a kind that contradicts settings being written is refused with the reason;
 * - one design is one kind, never two — a deck does not also export video;
 *   make it a `motion` composition if that is what it is;
 * - changing the kind drops the settings that belonged to the old one, since
 *   they are parameters of a kind it no longer has.
 *
 * Pure and browser-safe.
 */

import type { DesignDeckSpec, DesignKind, DesignMotionSpec } from '@craft-agent/core';

export const DESIGN_KINDS: readonly DesignKind[] = ['prototype', 'dashboard', 'deck', 'motion'];

export function isDesignKind(value: unknown): value is DesignKind {
  return typeof value === 'string' && (DESIGN_KINDS as readonly string[]).includes(value);
}

/** The kind a set of settings implies, or undefined when it implies none. */
export function kindFromSettings(settings: {
  deck?: DesignDeckSpec | null;
  motion?: DesignMotionSpec | null;
}): DesignKind | undefined {
  const hasDeck = settings.deck !== undefined && settings.deck !== null;
  const hasMotion = settings.motion !== undefined && settings.motion !== null;
  if (hasDeck && hasMotion) {
    throw new Error(
      'A design is one kind: pass either deck settings or motion settings, not both — make it a deck or a motion composition.',
    );
  }
  if (hasDeck) return 'deck';
  if (hasMotion) return 'motion';
  return undefined;
}

export interface DesignKindMigration {
  /** The config with a coherent kind and only that kind's settings. */
  config: Record<string, unknown>;
  /** What had to be settled — one line each, for the caller to log. */
  notes: string[];
}

/**
 * Bring a design.json written before kinds were stored into the current shape.
 *
 * An explicit valid kind is kept; anything else has its kind **inferred from the
 * settings it carries** — a file holding deck settings is a deck whatever it
 * called itself, and one holding motion settings is a motion composition. (The
 * retired runtime kinds `static`/`interactive`/`live` said nothing about what a
 * design *is*, so they are inferred the same way.) Settings that do not belong
 * to the settled kind are dropped; a file that somehow carried both is settled
 * as a deck, because slides are what a person saw it as.
 *
 * Pure: the caller writes the result back on the next save.
 */
export function migrateDesignKind(raw: Record<string, unknown>): DesignKindMigration {
  const notes: string[] = [];
  const stored = raw.kind;
  const hasDeck = raw.deck !== undefined && raw.deck !== null;
  const hasMotion = raw.motion !== undefined && raw.motion !== null;
  // A design that runs on a schedule is a dashboard — that is what a dashboard
  // is (see the kind's own description) — so a file with a refresh spec and no
  // kind of its own settles there.
  const hasRefresh = raw.refresh !== undefined && raw.refresh !== null;

  const kind: DesignKind = isDesignKind(stored)
    ? stored
    : hasDeck
      ? 'deck'
      : hasMotion
        ? 'motion'
        : stored === 'live'
          ? // The retired runtime kind whose scenario a dashboard is (a page fed
            // while it stays open). Settings come first: those describe the
            // shape, and the old kind only ever described the runtime.
            'dashboard'
          : hasRefresh
            ? // A design that runs on a schedule is a dashboard — that is what a
              // dashboard is.
              'dashboard'
            : 'prototype';

  if (!isDesignKind(stored)) {
    notes.push(
      stored === undefined
        ? `kind settled as "${kind}" from its settings`
        : `retired kind "${String(stored)}" → "${kind}" (inferred from its settings)`,
    );
  }

  const config: Record<string, unknown> = { ...raw, kind };
  if (kind !== 'deck' && config.deck !== undefined) {
    delete config.deck;
    notes.push('deck settings dropped (not a deck)');
  }
  if (kind !== 'motion' && config.motion !== undefined) {
    delete config.motion;
    notes.push('motion settings dropped (not a motion composition)');
  }
  return { config, notes };
}

export interface DesignKindState {
  kind: DesignKind;
  /** Present only on a deck; absent means "the defaults". */
  deck?: DesignDeckSpec;
  /** Present only on a motion composition; absent means "the defaults". */
  motion?: DesignMotionSpec;
}

export interface ResolveDesignKindInput {
  /** The kind being written, when the caller names one. */
  kind?: DesignKind;
  /** Deck settings being written: absent = untouched, null = cleared. */
  deck?: DesignDeckSpec | null;
  /** Motion settings being written: absent = untouched, null = cleared. */
  motion?: DesignMotionSpec | null;
  /** What the design is now (an update) — `prototype` for a creation. */
  current?: DesignKindState;
}

/**
 * Resolve the kind and its settings together. Throws (with the reason) when the
 * request contradicts itself; otherwise the answer is the state to store.
 */
export function resolveDesignKindState(input: ResolveDesignKindInput): DesignKindState {
  const current: DesignKindState = input.current ?? { kind: 'prototype' };
  const requested = kindFromSettings({ deck: input.deck, motion: input.motion });
  const kind = input.kind ?? requested ?? current.kind;

  if (requested !== undefined && requested !== kind) {
    throw new Error(
      `Those ${requested} settings belong to a ${requested} design, but the kind is "${kind}" — ` +
        `pass kind: '${requested}', or clear the settings.`,
    );
  }

  // The settings of the kind being written; a kind change takes its own (or the
  // defaults) and drops whatever belonged to the kind the design no longer is.
  const deck =
    kind !== 'deck'
      ? undefined
      : input.deck !== undefined
        ? (input.deck ?? undefined)
        : current.kind === 'deck'
          ? current.deck
          : undefined;
  const motion =
    kind !== 'motion'
      ? undefined
      : input.motion !== undefined
        ? (input.motion ?? undefined)
        : current.kind === 'motion'
          ? current.motion
          : undefined;

  return { kind, deck, motion };
}
