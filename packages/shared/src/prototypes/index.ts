/**
 * Prototype workbench module.
 *
 * A prototype is a **folder**: a specification (one `*.spec.md` file per spec, plus an entry
 * `spec.md` index) holding its specs, and whatever material the author keeps beside them. This
 * barrel is the surface the workbench, the agent and the panel read it through.
 */

export { PROTOTYPE_ENTRY_FILENAME } from './types.ts'

export {
  getPrototypeDirPath,
  isMarkdownFile,
  listPrototypeFiles,
} from './storage.ts'
export type { PrototypeFileEntry } from './storage.ts'

export {
  getPrototypeEntryPath,
  parseSpecDocument,
  readPrototypeSpecs,
} from './spec.ts'
export type {
  PrototypeSpec,
  PrototypeSpecs,
} from './spec.ts'

export { extractLinkTargets, readPrototypeLinks } from './links.ts'
export type { PrototypeLink, PrototypeLinks } from './links.ts'

export type {
  PrototypeStatus,
  PrototypeStatusSpec,
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
