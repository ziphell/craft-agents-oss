/**
 * Skills Types
 *
 * Type definitions for workspace skills.
 * Skills are specialized instructions that extend Claude's capabilities.
 */

/**
 * Skill metadata from SKILL.md YAML frontmatter
 */
export interface SkillMetadata {
  /** Display name for the skill */
  name: string;
  /** Brief description shown in skill list */
  description: string;
  /** Optional file patterns that trigger this skill */
  globs?: string[];
  /** Optional tools to always allow when skill is active */
  alwaysAllow?: string[];
  /**
   * Optional icon - emoji or URL only.
   * - Emoji: rendered directly in UI (e.g., "🔧")
   * - URL: auto-downloaded to icon.{ext} file
   * Note: Relative paths and inline SVG are NOT supported.
   */
  icon?: string;
  /** Optional source slugs to auto-enable when this skill is invoked */
  requiredSources?: string[];
}

/** Source of a loaded skill */
export type SkillSource = 'global' | 'workspace' | 'project';

/**
 * Plugin name for project-level and global skills.
 *
 * The SDK derives plugin names from `path.basename()` of the registered plugin
 * directory. Both `{project}/.agents/` and `~/.agents/` share the basename
 * `.agents`, so skills from either tier resolve to `.agents:skillSlug`.
 */
export const AGENTS_PLUGIN_NAME = '.agents';

/**
 * A loaded skill with parsed content
 */
export interface LoadedSkill {
  /** Directory name (slug) */
  slug: string
  /** Parsed metadata from YAML frontmatter */
  metadata: SkillMetadata
  /** Full SKILL.md content (without frontmatter) */
  content: string
  /** Absolute path to icon file if exists */
  iconPath?: string
  /** Absolute path to skill directory */
  path: string
  /** Where this skill was loaded from */
  source: SkillSource
  /**
   * The targets its body declares, and what a run last found — **read at display time, not part
   * of the file** (`./anchors.ts`). Absent when nobody computed them.
   *
   * `hits` null (or absent) means **no run has checked**, which is not the same as "nothing
   * matched": the record is written by whoever ran the playbook, and if nobody has, there is
   * nothing to say. Anything drawing this must tell those two apart.
   */
  anchors?: string[]
  hits?: SkillHits | null
}

/**
 * One thing a playbook's step aims at, recorded from what a run actually found.
 *
 * The selector is declared in the skill's own body — an `@anchor <css>` marker on the line of
 * the step it belongs to (`./anchors.ts`) — and is what makes drift visible: a playbook keeps
 * running against a page somebody redesigns, and this is how "it stopped matching" is told from
 * "it never matched". A playbook that declares none is simply not checked; nothing here is
 * required.
 *
 * Same idea as a tweak's `@target` / `hits.json`, and deliberately the same words.
 */
export interface SkillAnchorHit {
  /** The selector as the body declared it. */
  selector: string
  /** When it last matched something, epoch ms. Absent means it never has. */
  lastMatchedAt?: number
  /** The page it last matched on. */
  lastMatchedUrl?: string
}

/**
 * The record of what a playbook's anchors matched, written by a run and **never by hand**.
 *
 * A run is a conversation following the steps, so the writer is whoever checked — and what it
 * writes is what it found. A record somebody could have typed says nothing, which is why the
 * file's absence means "no run has checked", not "nothing matched".
 */
export interface SkillHits {
  schemaVersion: 1
  /** When this record was last written. */
  updatedAt: number
  targets: SkillAnchorHit[]
}

/** The file a skill's hit record lives in, beside `SKILL.md`. */
export const SKILL_HITS_FILENAME = 'hits.json'
