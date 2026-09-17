/**
 * Prototype workbench module.
 *
 * Artifacts (patches, derived index, replay transform) for the PM requirement
 * workbench. See docs/prototype-workbench-plan.md.
 */

export type { PrototypeArtifacts, PrototypePatch, PrototypePatchKind, PrototypeWindowDescriptor, PageKind } from './types.ts'
export {
  CONSOLIDATED_WRITER,
  DEFAULT_PAGE_KIND,
  LEGACY_BASE_PAGE_NAME,
  LEGACY_ENTRY_PAGE_NAME,
  PROTOTYPE_ANCHORS_DIRNAME,
  PROTOTYPE_DEFAULT_WRITER,
  PROTOTYPE_LAYOUT_FILENAME,
  PROTOTYPE_LAYOUT_SLOT,
  PROTOTYPE_PATCH_NAME_RE,
  isConsolidatedWriter,
  isValidWriterId,
  parsePrototypePatchName,
  resolvePrototypeWriter,
} from './types.ts'
export type { PrototypePatchName } from './types.ts'

// The marker parser, which the other modules reach for rather than re-implement
// (`patch-header.ts`).
export {
  extractPatchHeader,
  extractPatchTargets,
  extractRequirementIds,
  normalizeRequirementId,
} from './patch-header.ts'
export type { PrototypePatchHeader } from './patch-header.ts'

export {
  getPrototypeDirPath,
  getPrototypePatchesPath,
  getPrototypePagePatchesPath,
  getPrototypeAnchorsPath,
  getPrototypeLayoutPath,
  getPrototypeDistPath,
  getPrototypePatchKey,
  patchFingerprint,
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
  getContractStatePath,
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

// The mock's state machine (plan §阶段 5, D9's postponed half). Exported because
// the two carriers — the workbench's network interception and the generated
// in-page script — have to agree about it, and a test runs both over one table.
export {
  applyMockRequest,
  describeMockOperation,
  matchMockRoute,
  mergeMockStores,
  noMockProgram,
  parseMockRequestBody,
  readMockPath,
  writeMockPath,
} from './mock-engine.ts'
export type { MockAnswer, MockMatch, MockOp, MockProgram, MockState, MockStore } from './mock-engine.ts'

export {
  buildPatchInitScript,
  buildPatchMatchRecorderScript,
  buildPatchStateProbeScript,
  buildPatchStyleElementId,
  PATCH_STATE_KEY,
} from './patch-script.ts'

// The virtual base of a live page: what each declared `@target` matched, and
// whether it is still there (`anchors.ts`, plan §21.2).
export {
  buildAnchorCandidateScript,
  buildAnchorProbeScript,
  dropPrototypeAnchors,
  readAllPrototypeAnchors,
  readPrototypeAnchors,
  recordPrototypeAnchors,
  resolveAnchorDrift,
  resolveAnchorOrphans,
  SHARED_ANCHOR_SCOPE,
} from './anchors.ts'
export type {
  PrototypeAnchor,
  PrototypeAnchorFile,
  PrototypeAnchorFingerprint,
  PrototypeAnchorObservation,
  PrototypeAnchorReport,
} from './anchors.ts'

// Folding the delta layer into what owns it (`commit.ts`, plan §21.3).
export { commitPrototype } from './commit.ts'
export type { PrototypeCommitResult, PrototypeCommitScopeResult } from './commit.ts'

export type {
  PrototypeArtifactPath,
  PrototypeOwner,
  PrototypeOwnershipReport,
  PrototypePathClassification,
  WriterWriteCheck,
} from './ownership.ts'
export {
  PROTOTYPE_PATH_WRITERS,
  classifyPrototypePath,
  canWriterWrite,
  whyWriterMayNotWrite,
  resolvePrototypeArtifactPath,
  resolvePrototypeOwnership,
} from './ownership.ts'

export type { PrototypeStatus, PrototypeStatusFinding, PrototypeStatusFrameCapture, PrototypeStatusRequirement, PrototypeStatusService } from './status.ts'
export { buildPrototypeStatus, listPrototypeStatuses, whyPrototypeIsNotSettled } from './status.ts'

export { PROTOTYPE_PRD_FILENAME, getPrototypePrdPath, parsePrototypePrd, readPrototypeRequirements } from './requirements.ts'
export type { PrototypeCheck, PrototypeCheckKind, PrototypeRequirement, PrototypeRequirements } from './requirements.ts'

export { PROTOTYPE_RESEARCH_DIRNAME, getPrototypeResearchPath, parsePrototypeFinding, readPrototypeFindings } from './research.ts'
export type { PrototypeFinding, PrototypeFindings } from './research.ts'

export {
  PROTOTYPE_REVIEWS_DIRNAME,
  PROTOTYPE_REVIEW_STATUSES,
  formatReviewTarget,
  getPrototypeReviewsPath,
  isUnresolved,
  parsePrototypeReview,
  parseReviewTarget,
  readPrototypeReviews,
} from './reviews.ts'
export type {
  PrototypeReview,
  PrototypeReviewStatus,
  PrototypeReviewTarget,
  PrototypeReviewTargetKind,
  PrototypeReviews,
} from './reviews.ts'

export {
  ACCEPTANCE_STATE_FILENAME,
  acceptanceCheckKey,
  compareAcceptance,
  getPrototypeAcceptancePath,
  readAcceptanceState,
  summarizeAcceptance,
  writeAcceptanceState,
} from './acceptance.ts'
export type {
  AcceptanceCheckRecord,
  AcceptanceCheckStatus,
  AcceptanceComparison,
  AcceptanceDiff,
  AcceptanceObservation,
  AcceptanceState,
  AcceptanceSummary,
} from './acceptance.ts'

export { PROTOTYPE_FRAMES_DIRNAME, PROTOTYPE_VIDEOS_DIRNAME, buildFramesIndexDoc, copyPrototypeVideo, formatOffset, frameFileName, getPrototypeFramesPath, getPrototypeVideosPath, listFrameCaptures, sessionDirName, writeFrameCapture } from './frames.ts'
export type { PrototypeFrame, PrototypeFrameCapture, PrototypeFrameCaptureSummary, PrototypeFrameReason, WrittenFrameCapture } from './frames.ts'

export { resolveRequirementCoverage } from './coverage.ts'
export type { RequirementCoverage, RequirementCoverageReport, RequirementDispute } from './coverage.ts'

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

export {
  getProjectPrototypes,
  setProjectPrototypes,
} from './project-link.ts'

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
