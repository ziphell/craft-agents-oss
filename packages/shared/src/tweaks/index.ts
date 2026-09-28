/**
 * Tweaks — for the pages they match, everything in their folder.
 *
 * A tweak is a standing edit to pages nobody here owns: "on our admin console, show the
 * order id next to the customer name". It is applied every time one of those pages
 * loads, in an ordinary browser, whether or not this app is running — which is why the
 * tweak is the fact and the carrier is how it travels (`tweaks/` in the app, and a
 * loadable extension built from the same files).
 *
 * Read the notes in `./types.ts` for what lives in `tweak.json` and why so little of it
 * does, and `./match.ts` for why the patterns are Chrome's own grammar.
 */

export type {
  TweakConfig,
  LoadedTweak,
  CreateTweakInput,
  UpdateTweakPatch,
  TweakTargetHit,
  TweakHits,
} from './types.ts'
export {
  TWEAK_CONFIG_FILENAME,
  TWEAK_CSS_FILENAME,
  TWEAK_JS_FILENAME,
  TWEAK_HITS_FILENAME,
} from './types.ts'

export {
  anyMatchPatternMatches,
  isValidMatchPattern,
  matchPatternMatches,
  parseMatchPattern,
  whyMatchPatternIsInvalid,
} from './match.ts'

export {
  extractTweakTargets,
  parseTweakHits,
  readTweakHits,
  recordTweakHits,
  tweakTargets,
  writeTweakHits,
} from './targets.ts'

// The shape a tweak is shown in — shared by the agent's tools and the app's own pages
export {
  toTweakDetails,
  toTweakSummary,
  toTweakTargets,
  type TweakDetails,
  type TweakSummary,
  type TweakTargetInfo,
} from './summary.ts'

export {
  assertValidTweakSlug,
  createTweak,
  deleteTweak,
  getTweakConfigPath,
  getTweakCssPath,
  getTweakHitsPath,
  getTweakJsPath,
  getTweakPath,
  isValidTweakSlug,
  loadTweak,
  loadTweakConfig,
  loadWorkspaceTweaks,
  readTweakSources,
  TWEAK_SLUG_REGEX,
  tweakExists,
  tweaksForUrl,
  saveTweakConfig,
  updateTweak,
  whyTweakConfigIsInvalid,
} from './storage.ts'

// The carrier that runs a tweak in this app's own browser window
export {
  buildSelectorMatchScript,
  buildTweaksInitScript,
  buildTweaksMatcherSource,
  buildTweaksProbeScript,
  type TweaksInitScriptTweak,
} from './inject.ts'

// The carrier that reaches a browser this app is not running in
export {
  buildTweaksExtension,
  exportTweaksExtension,
  tweakExtensionFilePath,
  TWEAKS_EXTENSION_DIRNAME,
  type TweaksExtensionBuild,
  type TweaksExtensionFile,
  type TweaksExportResult,
} from './extension.ts'
