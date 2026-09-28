/**
 * Prototype workbench module.
 *
 * A prototype is a **folder**: a specification (its markdown — one file or several) holding its
 * requirements, the research that argues around them, and whatever material the author
 * keeps beside them. This barrel is the surface the workbench, the agent and the panel
 * read it through.
 */

export {
  PROTOTYPE_PRD_FILENAME,
  PROTOTYPE_RESEARCH_DIRNAME,
} from './types.ts'

export {
  getPrototypeDirPath,
  getPrototypeResearchPath,
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
} from './requirements.ts'
export type {
  PrototypeRequirement,
  PrototypeRequirements,
} from './requirements.ts'

export { parsePrototypeFinding, readPrototypeFindings } from './research.ts'
export type { PrototypeFinding, PrototypeFindings } from './research.ts'

export { extractLinkTargets, readPrototypeLinks } from './links.ts'
export type { PrototypeLink, PrototypeLinks } from './links.ts'

export { resolveRequirementCoverage } from './coverage.ts'
export type { RequirementCoverage, RequirementCoverageReport } from './coverage.ts'

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
