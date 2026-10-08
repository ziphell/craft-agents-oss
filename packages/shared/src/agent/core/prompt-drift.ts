/**
 * Prompt-drift notices.
 *
 * A session pins its system-prompt components on its first turn — the formatted
 * preferences, the commit co-author setting, and the bound project's block — because the
 * system block is the cached prefix: re-stamping it per turn would drop the cache for all
 * downstream history (see PromptBuilder / issue #862). Pinning is therefore what makes a
 * session *tell you* about a change instead of silently applying it.
 *
 * What the notice says has to depend on what drifted, because the ways out are not the
 * same:
 *
 *  - `preferences` and the co-author setting are **instructions** folded into the prefix.
 *    Nothing in a live session can re-read them into a prompt that has already gone out,
 *    so a new session really is the only way to apply them.
 *  - the project's MEMORY.md, asset manifest and details are **files and metadata**. The
 *    session's copy is a snapshot, but the agent can open the current one whenever it
 *    wants — so telling it to start a new session there would trade a whole conversation
 *    for a file read. Those notices name the path and say what is stale instead.
 *
 * Each kind is announced at most once per session and in a fixed order, so a session that
 * drifts repeatedly does not narrate the same thing twice.
 */

import type { ProjectPromptContext } from '../../projects/types.ts';

export type PromptDriftKind =
  | 'preferences'
  | 'co-author'
  | 'project-bound'
  | 'project-unbound'
  | 'project-memory'
  | 'project-assets'
  | 'project-designs'
  | 'project-details';

/**
 * Emission order: instruction drift first (it needs a new session), then the
 * binding change, then the parts of the project block the agent can simply re-read.
 */
export const PROMPT_DRIFT_ORDER: readonly PromptDriftKind[] = [
  'preferences',
  'co-author',
  'project-bound',
  'project-unbound',
  'project-memory',
  'project-assets',
  'project-designs',
  'project-details',
];

export interface PromptDriftPaths {
  /** Absolute path to the project's MEMORY.md. The file is the same for pinned and current. */
  memoryPath?: string;
  /** Absolute path to the project's assets folder. */
  assetsPath?: string;
}

/**
 * The notice for one kind. Pure text: `paths` only ever supplies absolute paths, and the
 * fallbacks keep the sentence readable if a caller has none.
 */
export function formatPromptDriftNotice(
  kind: PromptDriftKind,
  paths: PromptDriftPaths = {},
): string {
  const memory = paths.memoryPath ?? 'the project memory file';
  const assets = paths.assetsPath ?? 'the project assets folder';
  switch (kind) {
    case 'preferences':
      // Byte-identical to the Claude path's notice: one change, one wording.
      return 'Note: Your preferences changed since this session started. Start a new session to apply changes.';
    case 'co-author':
      return 'Note: The commit co-author setting changed since this session started. Start a new session to apply it.';
    case 'project-bound':
      return `Note: This session was bound to a project after it started, so your system prompt has no project block. The project's accumulated knowledge is at ${memory} — read it before relying on project knowledge.`;
    case 'project-unbound':
      return 'Note: This session is no longer bound to a project, but your system prompt still describes the one it started in.';
    case 'project-memory':
      return `Note: The project's MEMORY.md changed on disk after this session started — your system prompt still carries the copy taken when it began. Read ${memory} for the newest notes.`;
    case 'project-assets':
      return `Note: The project's reference files changed after this session started — your system prompt still lists the ones present when it began. List ${assets} for the current set.`;
    case 'project-designs':
      return "Note: The designs bound to this project changed after this session started — your system prompt still lists the ones bound when it began. Use list_designs for the current set.";
    case 'project-details':
      return "Note: The project's name, description or details changed after this session started — your system prompt still carries the copy taken when it began.";
  }
}

/** What a session's live inputs look like against the snapshot it pinned. */
export interface PromptDriftInputs {
  currentPreferencesPrompt: string;
  /** The pinned value; the caller only collects drift after a pin exists. */
  pinnedPreferencesPrompt: string;
  currentIncludeCoAuthoredBy: boolean;
  /** null when the session never pinned one — then there is no drift to report. */
  pinnedIncludeCoAuthoredBy: boolean | null;
  currentProject: ProjectPromptContext | null;
  pinnedProject: ProjectPromptContext | null;
}

/**
 * Which kinds drifted. Pure, so the decisions here are testable without a live session.
 *
 * The project block is compared part by part rather than as one blob: "MEMORY.md changed"
 * and "an asset was added" are different notices with different advice, and a session that
 * bound or unbound mid-life gets one notice describing the block itself, not three
 * describing every field that consequently differs.
 */
export function collectPromptDrift(inputs: PromptDriftInputs): PromptDriftKind[] {
  const kinds: PromptDriftKind[] = [];

  if (inputs.currentPreferencesPrompt !== inputs.pinnedPreferencesPrompt) {
    kinds.push('preferences');
  }
  if (
    inputs.pinnedIncludeCoAuthoredBy !== null &&
    inputs.currentIncludeCoAuthoredBy !== inputs.pinnedIncludeCoAuthoredBy
  ) {
    kinds.push('co-author');
  }

  const now = inputs.currentProject;
  const pinned = inputs.pinnedProject;
  if (!now || !pinned) {
    if (!now && pinned) kinds.push('project-unbound');
    else if (now && !pinned) kinds.push('project-bound');
    return kinds;
  }

  if (now.memoryContent !== pinned.memoryContent) kinds.push('project-memory');
  if (!sameAssets(now.assets, pinned.assets)) kinds.push('project-assets');
  if (!sameDesigns(now.designs, pinned.designs)) kinds.push('project-designs');
  if (
    now.name !== pinned.name ||
    now.description !== pinned.description ||
    now.details !== pinned.details
  ) {
    kinds.push('project-details');
  }

  return kinds;
}

function sameAssets(
  a: ProjectPromptContext['assets'],
  b: ProjectPromptContext['assets'],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((asset, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      asset.filename === other.filename &&
      asset.mimeType === other.mimeType &&
      asset.sizeBytes === other.sizeBytes
    );
  });
}

/** The bound designs, by field — a rename or a re-binding is drift even if the slug stays. */
function sameDesigns(
  a: ProjectPromptContext['designs'],
  b: ProjectPromptContext['designs'],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((design, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      design.slug === other.slug &&
      design.name === other.name &&
      design.kind === other.kind
    );
  });
}

/**
 * Announces each kind once, in {@link PROMPT_DRIFT_ORDER}. The state belongs to whichever
 * agent owns the pin, so `reset()` is called exactly where the pin is cleared — a session
 * that re-pins (recovery, history reset) starts its notices over.
 */
export class PromptDriftNotices {
  private announced = new Set<PromptDriftKind>();

  /** Kinds not announced yet, in canonical order — marked announced as they are returned. */
  take(kinds: readonly PromptDriftKind[]): PromptDriftKind[] {
    const drifted = new Set(kinds);
    const fresh = PROMPT_DRIFT_ORDER.filter(
      (kind) => drifted.has(kind) && !this.announced.has(kind),
    );
    for (const kind of fresh) this.announced.add(kind);
    return fresh;
  }

  reset(): void {
    this.announced.clear();
  }
}
