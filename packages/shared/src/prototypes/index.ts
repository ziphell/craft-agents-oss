/**
 * Prototype workbench module.
 *
 * Artifacts (patches, derived index, replay transform) for the PM requirement
 * workbench. See docs/prototype-workbench-plan.md.
 */

export type { PrototypeArtifacts, PrototypePatch, PrototypePatchKind } from './types.ts'

export {
  getPrototypeProjectPath,
  getPrototypePatchesPath,
  getPrototypeDistPath,
  getPrototypePatchKey,
  scanPrototypePatches,
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

export type { CapturedBase, CreatedPrototype, CreatePrototypeInput } from './create.ts'
export {
  buildStarterBaseHtml,
  createPrototype,
  prototypeSlugFromName,
  readPrototypeBase,
  writePrototypeBase,
} from './create.ts'

export type { PrototypeEntry, PrototypeExportResult } from './export.ts'
export { buildSelfContainedHtml, buildDevSpec, exportPrototype, resolvePrototypeEntry } from './export.ts'

export type { PrototypePromptContext } from './prompt.ts'
export { buildPrototypePromptContext, formatPrototypeContextForPrompt } from './prompt.ts'
