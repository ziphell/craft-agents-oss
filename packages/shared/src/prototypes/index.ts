/**
 * Prototype workbench module.
 *
 * Artifacts (patches, derived index, replay transform) for the PM requirement
 * workbench. See docs/prototype-workbench-plan.md.
 */

export type { PrototypeArtifacts, PrototypePatch, PrototypePatchKind, PrototypeWindowDescriptor, PageKind } from './types.ts'
export {
  DEFAULT_PAGE_KIND,
  LEGACY_BASE_PAGE_NAME,
  LEGACY_ENTRY_PAGE_NAME,
  PROTOTYPE_LAYOUT_FILENAME,
  PROTOTYPE_LAYOUT_SLOT,
} from './types.ts'

export {
  getPrototypeDirPath,
  getPrototypePatchesPath,
  getPrototypePagePatchesPath,
  getPrototypeLayoutPath,
  getPrototypeDistPath,
  getPrototypePatchKey,
  listPrototypePatchPages,
  scanPrototypePatches,
  scanPrototypePatchesForPage,
  loadPrototypeArtifacts,
} from './storage.ts'

export type {
  ContractConfig,
  ContractEndpoint,
  ContractExportResult,
  ContractFragment,
  ContractService,
  ComposedContract,
  MockRoute,
  MockRoutesResult,
} from './contract.ts'
export {
  COMPOSED_CONTRACT_FILENAME,
  getPrototypeServicesPath,
  getContractServicePath,
  getContractPathsPath,
  getContractFixturesPath,
  getComposedContractPath,
  listContractServices,
  resolveContractServiceSlug,
  parseContractFragment,
  loadContractService,
  listContractEndpoints,
  composeContract,
  writeComposedContract,
  buildContractDoc,
  exportContractDeliverable,
  buildMockRoutes,
} from './contract.ts'

export { buildPatchInitScript, buildPatchStyleElementId } from './patch-script.ts'

export type {
  LaneWriteCheck,
  PrototypeLaneId,
  PrototypeOwner,
  PrototypeOwnershipReport,
  PrototypePathClassification,
} from './ownership.ts'
export {
  PROTOTYPE_LANES,
  isPrototypeLane,
  classifyPrototypePath,
  canLaneWrite,
  resolvePrototypeOwnership,
} from './ownership.ts'

export type { PrototypeStatus, PrototypeStatusService } from './status.ts'
export { buildPrototypeStatus, listPrototypeStatuses } from './status.ts'

// The page kind and its default live in `types.ts` (which imports nothing) — see
// the note there for why a renderer must not reach a barrel for a *value*.
export type { PrototypeConfig, PrototypePageEntry } from './config.ts'
export {
  PROTOTYPE_CONFIG_FILENAME,
  getPrototypeConfigPath,
  isPageKind,
  legacyPageRows,
  normalizePrototypePages,
  normalizePrototypeReferences,
  readPrototypeConfig,
  writePrototypeConfig,
} from './config.ts'

export {
  getPrototypeReferences,
  linkPrototypeReference,
  unlinkPrototypeReference,
} from './references.ts'

export type { WrittenPage, CreatedPrototype, CreatePrototypeInput } from './create.ts'
export {
  createPrototype,
  prototypeSlugFromName,
  readPrototypeLayout,
  readPrototypePage,
  writePrototypePage,
} from './create.ts'

export type { DuplicatedPrototype, DuplicatePrototypeOptions } from './duplicate.ts'
export { duplicatePrototype } from './duplicate.ts'

export type { DeletedPrototype } from './delete.ts'
export { deletePrototype } from './delete.ts'

export type { PrototypePage, PrototypePageTable, PrototypePagesChange, PrototypePagesResult } from './pages.ts'
export {
  PROTOTYPE_INDEX_PATH,
  describePrototypePages,
  findEntryPage,
  isPrototypePagePath,
  listPrototypePages,
  matchPrototypePage,
  pageFileName,
  pageNameForFile,
  updatePrototypePages,
} from './pages.ts'

export { applyPrototypeLayout, buildLayoutShell, buildPrototypeIndexDocument } from './page-document.ts'

export type { PrototypeEntry, PrototypeExportResult } from './export.ts'
export {
  buildSelfContainedHtml,
  buildDevSpec,
  buildInlinedPatchProbeScript,
  exportPrototype,
  INLINED_PATCHES_ELEMENT_ID,
  resolvePrototypeEntry,
} from './export.ts'

export { pickOverlayPage, requireTargetUrl, setPrototypePageUrl } from './target.ts'

export type { PrototypeBaseUrlResolver } from './url.ts'
export { prototypeDocumentUrl, prototypeOriginUrl, setPrototypeBaseUrlResolver } from './url.ts'

export type { PrototypePromptContext } from './prompt.ts'
export { buildPrototypePromptContext, formatPrototypeContextForPrompt } from './prompt.ts'
