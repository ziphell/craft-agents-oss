/**
 * Prototype workbench module.
 *
 * A prototype is a **folder**: a specification (its markdown — one file or several) holding its
 * requirements, the research and reviews that argue around them, and whatever material the author
 * keeps beside them. This barrel is the surface the workbench, the agent and the panel
 * read it through.
 */

export {
  PROTOTYPE_RESEARCH_DIRNAME,
  PROTOTYPE_REVIEWS_DIRNAME,
} from './types.ts'

export {
  contentFingerprint,
  getPrototypeDirPath,
  getPrototypeResearchPath,
  getPrototypeReviewsPath,
  isMarkdownFile,
  listPrototypeFiles,
} from './storage.ts'
export type { PrototypeFileEntry } from './storage.ts'

export {
  extractRequirementIds,
  getPrototypePrdPath,
  normalizeRequirementId,
  parseRequirementDocument,
  readPrototypeRequirements,
  requirementFingerprint,
  PROTOTYPE_PRD_FILENAME,
} from './requirements.ts'
export type {
  PrototypeRequirement,
  PrototypeRequirements,
} from './requirements.ts'

export { parsePrototypeFinding, readPrototypeFindings } from './research.ts'
export type { PrototypeFinding, PrototypeFindings } from './research.ts'

export { extractLinkTargets, readPrototypeLinks } from './links.ts'
export type { PrototypeLink, PrototypeLinks } from './links.ts'

export {
  formatReviewTarget,
  isUnresolved,
  parsePrototypeReview,
  parseReviewTarget,
  readPrototypeReviews,
  PROTOTYPE_REVIEW_STATUSES,
} from './reviews.ts'
export type {
  PrototypeReview,
  PrototypeReviewStatus,
  PrototypeReviewTarget,
  PrototypeReviewTargetKind,
  PrototypeReviews,
} from './reviews.ts'

export { resolveRequirementCoverage } from './coverage.ts'
export type { RequirementCoverage, RequirementCoverageReport, RequirementDispute } from './coverage.ts'

export type {
  PrototypeStatus,
  PrototypeStatusFinding,
  PrototypeStatusRequirement,
} from './status.ts'
export { buildPrototypeStatus, listPrototypeStatuses, whyPrototypeIsNotSettled } from './status.ts'
export { notice, rawNotice } from './notices.ts'
export type { PrototypeNotice, PrototypeNoticeCode, PrototypeNoticeParams } from './notices.ts'

export {
  getProjectPrototypes,
  setProjectPrototypes,
} from './project-link.ts'

export type { CreatedPrototype, CreatePrototypeInput } from './create.ts'
export { createPrototype, prototypeSlugFromName } from './create.ts'

export type { DuplicatedPrototype, DuplicatePrototypeOptions } from './duplicate.ts'
export { duplicatePrototype } from './duplicate.ts'

export type { DeletedPrototype } from './delete.ts'
export { deletePrototype } from './delete.ts'

export type { PrototypePromptContext } from './prompt.ts'
export { buildPrototypePromptContext, formatPrototypeContextForPrompt } from './prompt.ts'
