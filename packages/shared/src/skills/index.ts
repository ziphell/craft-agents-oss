/**
 * Skills Module
 *
 * Workspace skills are specialized instructions that extend Claude's capabilities.
 */

export * from './types.ts';
export {
  GLOBAL_AGENT_SKILLS_DIR,
  PROJECT_AGENT_SKILLS_DIR,
  loadSkill,
  loadAllSkills,
  invalidateSkillsCache,
  loadSkillBySlug,
  getSkillIconPath,
  deleteSkill,
  skillExists,
  listSkillSlugs,
  skillNeedsIconDownload,
  downloadSkillIcon,
} from './storage.ts';
export {
  parseAnchors,
  getSkillHitsPath,
  parseSkillHits,
  readSkillHits,
  recordSkillHits,
  writeSkillHits,
  skillAnchors,
} from './anchors.ts';
export type { MatchedAnchors } from './anchors.ts';
