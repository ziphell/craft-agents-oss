/**
 * rename-pages-to-websites.ts — migrate the upstream "pages" feature to "websites".
 *
 * The repo contains TWO unrelated things called "page":
 *   1. the websites feature (what this script renames), and
 *   2. a prototype's page — one screen of a flow (`PrototypePage`,
 *      `prototypes/pages.ts`, the `prototype_tool pages` command, …).
 *
 * Only (1) is renamed. The guard is structural rather than clever: this script
 * touches an explicit allowlist of paths and never enters `prototypes/` or any
 * `*prototype*` file, so (2) cannot be caught by a broad identifier replacement.
 *
 * Usage:
 *   bun scripts/rename-pages-to-websites.ts            # dry run (default): print the plan
 *   bun scripts/rename-pages-to-websites.ts --write    # apply: rename paths + rewrite contents
 *
 * The disk migration (moving an existing `{workspace}/pages/` to `websites/` and
 * `page.json` to `website.json`) is NOT done here: it lands in
 * `packages/shared/src/websites/migrate.ts` and runs at workspace bootstrap, so
 * user data is moved by the app, idempotently, not by a one-off script.
 */

import { readdirSync, readFileSync, renameSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

const ROOT = resolve(import.meta.dir ?? new URL('.', import.meta.url).pathname, '..')
const WRITE = process.argv.includes('--write')

/** Paths this script may touch — everything else is out of scope. */
const ALLOWED_PREFIXES = [
  'packages/shared/src/',
  'packages/shared/package.json',
  'packages/shared/CLAUDE.md',
  'packages/core/src/',
  'packages/server-core/src/',
  'packages/session-tools-core/src/',
  'packages/ui/src/',
  'apps/electron/src/',
  'apps/viewer/src/',
  'apps/webui/src/',
  'apps/electron/resources/docs/pages.md',
]

/**
 * Never rewritten. Release notes and design docs are historical records: they
 * describe what shipped under the old name, and rewriting them would make the
 * history lie.
 */
const EXCLUDED_PREFIXES = [
  'apps/electron/resources/release-notes/',
  'docs/',
  // Prototype tool tests: they build `PrototypeStatus` / `PrototypeConfig`
  // literals, whose `pages:` field is the flow's page list — prototype
  // vocabulary, not ours.
  'packages/shared/src/agent/__tests__/',
]

/**
 * Feature files that must NOT get the blanket `Page` → `Website` rewrite: they
 * build an automations `ScriptAction` / `ScriptEnvOptions` whose `page` field is
 * the AUTOMATIONS vocabulary (how a refresh run stamps its own completion
 * marker). They still get every enumerated rule.
 */
const NO_BLANKET_PREFIXES = [
  'packages/shared/src/websites/refresh.ts',
  'packages/server-core/src/websites/script-executor-bridge.ts',
  'packages/server-core/src/websites/__tests__/script-executor-bridge.test.ts',
]

/**
 * Files outside the feature that only ever name the feature's own nouns when
 * they write the bare string `'pages'` / `'page'` — the navigator key, the disk
 * directory, the route detail type. Listed one by one because a prototype file
 * says `'pages'` for its own page list, and `utils/redaction.test.ts` uses
 * `'page'` as a generic key name: neither may be touched.
 */
const BARE_STRING_FILES = [
  'apps/electron/src/shared/routes.ts',
  'apps/electron/src/shared/route-parser.ts',
  'apps/electron/src/shared/types.ts',
  'apps/electron/src/shared/__tests__/route-parser-pages.test.ts',
  'apps/electron/src/shared/__tests__/route-parser-websites.test.ts',
  'packages/shared/src/config/watcher.ts',
  'packages/shared/src/automations/utils.ts',
  'packages/shared/src/automations/script-executor.test.ts',
]

/** The feature's own files: everything inside these gets the full rename. */
const FEATURE_PREFIXES = [
  // The type definitions live in core; every `Page*` name there is ours.
  'packages/core/src/',
  'packages/shared/src/pages/',
  'packages/shared/src/websites/',
  'packages/server-core/src/pages/',
  'packages/server-core/src/websites/',
  'packages/server-core/src/handlers/rpc/pages.ts',
  'packages/server-core/src/handlers/rpc/websites.ts',
  'packages/server-core/src/websites/',
  'apps/electron/src/renderer/components/pages/',
  'apps/electron/src/renderer/components/websites/',
  'apps/electron/src/renderer/hooks/usePages.ts',
  'apps/electron/src/renderer/hooks/useWebsites.ts',
  'apps/electron/src/renderer/atoms/pages.ts',
  'apps/electron/src/renderer/atoms/websites.ts',
  'apps/electron/src/shared/page-bridge.ts',
  'apps/electron/src/shared/website-bridge.ts',
  'apps/electron/src/shared/__tests__/page-bridge.test.ts',
  'apps/electron/src/shared/__tests__/website-bridge.test.ts',
]

/** Directories whose whole subtree is the feature (renamed wholesale). */
const DIR_RENAMES: Array<[string, string]> = [
  ['packages/shared/src/pages', 'packages/shared/src/websites'],
  ['packages/server-core/src/pages', 'packages/server-core/src/websites'],
  ['apps/electron/src/renderer/components/pages', 'apps/electron/src/renderer/components/websites'],
]

/** Single-file renames (path → path). */
const FILE_RENAMES: Array<[string, string]> = [
  ['packages/server-core/src/handlers/rpc/pages.ts', 'packages/server-core/src/handlers/rpc/websites.ts'],
  ['apps/electron/src/renderer/hooks/usePages.ts', 'apps/electron/src/renderer/hooks/useWebsites.ts'],
  ['apps/electron/src/renderer/atoms/pages.ts', 'apps/electron/src/renderer/atoms/websites.ts'],
  ['apps/electron/src/shared/page-bridge.ts', 'apps/electron/src/shared/website-bridge.ts'],
  ['apps/electron/src/main/page-thumbnailer.ts', 'apps/electron/src/main/website-thumbnailer.ts'],
  ['apps/electron/src/main/page-thumbnail-host.ts', 'apps/electron/src/main/website-thumbnail-host.ts'],
  ['apps/electron/src/main/__tests__/page-thumbnail-host.test.ts', 'apps/electron/src/main/__tests__/website-thumbnail-host.test.ts'],
  ['apps/electron/resources/docs/pages.md', 'apps/electron/resources/docs/websites.md'],
  ['packages/core/src/types/page.ts', 'packages/core/src/types/website.ts'],
  // The renderer surfaces are renamed too — the whole subtree moves with the
  // directory, so these are listed under the OLD directory name.
  ['apps/electron/src/renderer/components/pages/page-visuals.tsx', 'apps/electron/src/renderer/components/pages/website-visuals.tsx'],
  ['apps/electron/src/renderer/components/pages/PageFrame.tsx', 'apps/electron/src/renderer/components/pages/WebsiteFrame.tsx'],
  ['apps/electron/src/renderer/components/pages/PageView.tsx', 'apps/electron/src/renderer/components/pages/WebsiteView.tsx'],
  ['apps/electron/src/renderer/components/pages/PageTile.tsx', 'apps/electron/src/renderer/components/pages/WebsiteTile.tsx'],
  ['apps/electron/src/renderer/components/pages/PagesHome.tsx', 'apps/electron/src/renderer/components/pages/WebsitesHome.tsx'],
  ['apps/electron/src/renderer/components/pages/PageGrantsDialog.tsx', 'apps/electron/src/renderer/components/pages/WebsiteGrantsDialog.tsx'],
  ['apps/electron/src/renderer/components/pages/PageGrantRequestDialog.tsx', 'apps/electron/src/renderer/components/pages/WebsiteGrantRequestDialog.tsx'],
  ['apps/electron/src/renderer/components/pages/PageSourceAuthBanner.tsx', 'apps/electron/src/renderer/components/pages/WebsiteSourceAuthBanner.tsx'],
  ['apps/electron/src/renderer/components/pages/DeletePageDialog.tsx', 'apps/electron/src/renderer/components/pages/DeleteWebsiteDialog.tsx'],
  ['apps/electron/src/renderer/components/pages/SharePageDialog.tsx', 'apps/electron/src/renderer/components/pages/ShareWebsiteDialog.tsx'],
  ['apps/electron/src/shared/__tests__/page-bridge.test.ts', 'apps/electron/src/shared/__tests__/website-bridge.test.ts'],
  ['apps/electron/src/shared/__tests__/route-parser-pages.test.ts', 'apps/electron/src/shared/__tests__/route-parser-websites.test.ts'],
]

/**
 * Identifier and string rewrites, applied INSIDE the allowlist only.
 *
 * Order matters: longer, more specific names first, so `PageActionGrant` is not
 * half-renamed by a `Page` rule. Every entry must be unambiguous in the websites
 * feature — none of these names exist in the prototype vocabulary.
 */
const REWRITES: Array<[RegExp, string]> = [
  // The wire string: hard cut to the new protocol (decision: no compatibility).
  [/craft-pages\/v1/g, 'craft-websites/v1'],
  // Types and symbols
  [/PageActionGrant/g, 'WebsiteActionGrant'],
  [/PageActionBroker/g, 'WebsiteActionBroker'],
  [/PageActionDescriptor/g, 'WebsiteActionDescriptor'],
  [/PageActionInvocation/g, 'WebsiteActionInvocation'],
  [/PageActionRequest/g, 'WebsiteActionRequest'],
  [/PageRenderLease/g, 'WebsiteRenderLease'],
  [/PageDataSnapshot/g, 'WebsiteDataSnapshot'],
  [/PageDataPatch/g, 'WebsiteDataPatch'],
  [/PageRefreshSpec/g, 'WebsiteRefreshSpec'],
  [/PageRefreshStatus/g, 'WebsiteRefreshStatus'],
  [/PageShareInfo/g, 'WebsiteShareInfo'],
  [/PageThumbnailInfo/g, 'WebsiteThumbnailInfo'],
  [/PageGrantRequest/g, 'WebsiteGrantRequest'],
  [/PageConfig/g, 'WebsiteConfig'],
  [/PageKind/g, 'WebsiteKind'],
  [/PageToolCallbacks/g, 'WebsiteToolCallbacks'],
  [/PageToolSummary/g, 'WebsiteToolSummary'],
  [/PageToolDetails/g, 'WebsiteToolDetails'],
  [/PAGE_BRIDGE_PROTOCOL/g, 'WEBSITE_BRIDGE_PROTOCOL'],
  [/PAGE_CONFIG_FILENAME/g, 'WEBSITE_CONFIG_FILENAME'],
  [/PAGE_CONTENT_FILENAME/g, 'WEBSITE_CONTENT_FILENAME'],
  [/PAGE_SNAPSHOT_FILENAME/g, 'WEBSITE_SNAPSHOT_FILENAME'],
  [/PAGE_STORE_FILENAME/g, 'WEBSITE_STORE_FILENAME'],
  [/PAGE_THUMBNAIL_FILENAME/g, 'WEBSITE_THUMBNAIL_FILENAME'],
  [/PAGE_SLUG_REGEX/g, 'WEBSITE_SLUG_REGEX'],
  [/PAGE_DATA_/g, 'WEBSITE_DATA_'],
  [/PAGE_REFRESH_/g, 'WEBSITE_REFRESH_'],
  [/PAGE_ACTION_/g, 'WEBSITE_ACTION_'],
  [/PAGE_LEASE_/g, 'WEBSITE_LEASE_'],
  [/PAGE_PASSWORD_/g, 'WEBSITE_PASSWORD_'],
  [/PAGE_SHARE_/g, 'WEBSITE_SHARE_'],
  // Functions and hooks
  [/getWorkspacePagesPath/g, 'getWorkspaceWebsitesPath'],
  [/loadWorkspacePages/g, 'loadWorkspaceWebsites'],
  [/generatePageSlug/g, 'generateWebsiteSlug'],
  [/isValidPageSlug/g, 'isValidWebsiteSlug'],
  [/InvalidPageSlugError/g, 'InvalidWebsiteSlugError'],
  [/getPagePath\b/g, 'getWebsitePath'],
  [/pageExists/g, 'websiteExists'],
  [/loadPageById/g, 'loadWebsiteById'],
  [/loadPageConfig/g, 'loadWebsiteConfig'],
  [/savePageConfig/g, 'saveWebsiteConfig'],
  [/loadPageContent/g, 'loadWebsiteContent'],
  [/savePageContent/g, 'saveWebsiteContent'],
  [/loadPage\b/g, 'loadWebsite'],
  [/createPage\b/g, 'createWebsite'],
  [/updatePage\b/g, 'updateWebsite'],
  [/deletePage\b/g, 'deleteWebsite'],
  [/usePages\b/g, 'useWebsites'],
  [/pagesAtom/g, 'websitesAtom'],
  [/PageView\b/g, 'WebsiteView'],
  [/PageFrame\b/g, 'WebsiteFrame'],
  [/PagesHome\b/g, 'WebsitesHome'],
  [/PageTile\b/g, 'WebsiteTile'],
  [/PageFreshness\b/g, 'WebsiteFreshness'],
  [/PageKindBadge\b/g, 'WebsiteKindBadge'],
  // Module paths and channel keys
  [/@craft-agent\/shared\/pages/g, '@craft-agent/shared/websites'],
  [/'\.\/pages\.ts'/g, "'./websites.ts'"],
  [/\/components\/pages\//g, '/components/websites/'],
  [/\/atoms\/pages'/g, "/atoms/websites'"],
  [/\/hooks\/usePages'/g, "'/hooks/useWebsites'"],
  [/PAGE_TOOL_/g, 'WEBSITE_TOOL_'],
  // i18n keys (the `pages.` and `sidebar.pages` families only)
  [/"pages\./g, '"websites.'],
  [/"sidebar\.pages"/g, '"sidebar.websites"'],
  [/"sidebar\.allPages"/g, '"sidebar.allWebsites"'],
  [/t\('pages\./g, "t('websites."],
  [/t\("pages\./g, 't("websites.'],
  [/'pages\./g, "'websites."],
  // RPC channel group and route words
  [/RPC_CHANNELS\.pages\./g, 'RPC_CHANNELS.websites.'],
  [/'\.\/page\.ts'/g, "'./website.ts'"],
  [/\.\/page\.ts/g, './website.ts'],
  // NOTE: deliberately NO bare `pages: ` rule — it also matched unrelated
  // `pages:` fields (a prototype's page list, the mobile sheet's pages).
  [/nav:pages/g, 'nav:websites'],
  // package.json subpath exports ("./pages", "./pages/types", "./pages/data-store")
  [/"\.\/pages/g, '"./websites'],
  [/'\.\/pages/g, "'./websites"],
  // Channel and route VALUE strings ('pages:create', 'pages/page/<slug>')
  [/'pages:/g, "'websites:"],
  [/`pages:/g, '`websites:'],
  [/'pages\/page\//g, "'websites/website/"],
  [/`pages\/page\//g, '`websites/website/'],
  [/\/pages\/page\//g, '/websites/website/'],
  // Route/view names and registration
  [/case 'pages':/g, "case 'websites':"],
  [/case 'page-info':/g, "case 'website-info':"],
  [/name: 'pages'/g, "name: 'websites'"],
  [/name: 'page-info'/g, "name: 'website-info'"],
  [/registerPagesHandlers/g, 'registerWebsitesHandlers'],
  [/'\.\/handlers\/rpc\/pages'/g, "'./handlers/rpc/websites'"],
  // The doc file that was renamed on disk
  [/pages\.md/g, 'websites.md'],
  // The thumbnailer modules (renamed on disk)
  [/page-thumbnail/g, 'website-thumbnail'],
  // Package-qualified handler imports (registration tests)
  [/@craft-agent\/server-core\/handlers\/rpc\/pages/g, '@craft-agent/server-core/handlers/rpc/websites'],
  // The bridge module (renamed on disk)
  [/'\.\.\/page-bridge'/g, "'../website-bridge'"],
  // The disk directory itself (the one literal that decides where data lives).
  // The two shapes below are how automations and the config watcher name it.
  [/\(workspaceRootPath, 'pages'\)/g, "(workspaceRootPath, 'websites')"],
  [/join\(options\.workspaceRootPath, 'pages', /g, "join(options.workspaceRootPath, 'websites', "],
  // Compound names a word boundary cannot see. They cross into callers, so they
  // are enumerated rather than covered by the feature's blanket `Page` rule.
  [/LoadedPage/g, 'LoadedWebsite'],
  [/PagesNavigationState/g, 'WebsitesNavigationState'],
  [/isPagesNavigation/g, 'isWebsitesNavigation'],
  [/isPagesSharingEnabled/g, 'isWebsitesSharingEnabled'],
  [/CRAFT_FEATURE_PAGES_SHARING/g, 'CRAFT_FEATURE_WEBSITES_SHARING'],
  [/enqueuePageThumbnail/g, 'enqueueWebsiteThumbnail'],
  [/setPageThumbnailer/g, 'setWebsiteThumbnailer'],
  [/PageThumbnailer/g, 'WebsiteThumbnailer'],
  [/getPageThumbnailPath/g, 'getWebsiteThumbnailPath'],
  [/regeneratePageThumbnail/g, 'regenerateWebsiteThumbnail'],
  [/getPageThumbnail/g, 'getWebsiteThumbnail'],
  [/recordPageThumbnail/g, 'recordWebsiteThumbnail'],
  [/computePageContentDigest/g, 'computeWebsiteContentDigest'],
  [/syncPageContentDigest/g, 'syncWebsiteContentDigest'],
  [/onPagesChanged/g, 'onWebsitesChanged'],
  [/\bgetPages\b/g, 'getWebsites'],
  [/\bgetPage\b/g, 'getWebsite'],
  [/getPageContent/g, 'getWebsiteContent'],
  [/setPageContent/g, 'setWebsiteContent'],
  [/getPageData/g, 'getWebsiteData'],
  [/getPageShareDataScan/g, 'getWebsiteShareDataScan'],
  [/listPageGrants/g, 'listWebsiteGrants'],
  [/issuePageGrant/g, 'issueWebsiteGrant'],
  [/revokePageGrant/g, 'revokeWebsiteGrant'],
  [/createPageLease/g, 'createWebsiteLease'],
  [/publishPage/g, 'publishWebsite'],
  [/setPagePublicationPassword/g, 'setWebsitePublicationPassword'],
  [/PageShareCapabilities/g, 'WebsiteShareCapabilities'],
  [/PageActionResult/g, 'WebsiteActionResult'],
  [/DeletePageDialog/g, 'DeleteWebsiteDialog'],
  [/SharePageDialog/g, 'ShareWebsiteDialog'],
  [/pageIdOrSlug/g, 'websiteIdOrSlug'],
  [/pageSlug/g, 'websiteSlug'],
  [/createPagesScriptExecutor/g, 'createWebsitesScriptExecutor'],
  [/PagesScriptExecutorDeps/g, 'WebsitesScriptExecutorDeps'],
  [/buildPageRefreshMatchers/g, 'buildWebsiteRefreshMatchers'],
  [/isPageRefreshMatcherId/g, 'isWebsiteRefreshMatcherId'],
  [/pageRefreshMatcherId/g, 'websiteRefreshMatcherId'],
  [/pageRefreshMatchers/g, 'websiteRefreshMatchers'],
  [/reloadPageRefreshMatchers/g, 'reloadWebsiteRefreshMatchers'],
  [/recordPageRefresh/g, 'recordWebsiteRefresh'],
  [/executePageAction/g, 'executeWebsiteAction'],
  [/cancelPageAction/g, 'cancelWebsiteAction'],
  [/releasePageLease/g, 'releaseWebsiteLease'],
  [/CreatePageInput/g, 'CreateWebsiteInput'],
  [/unbindProjectFromPages/g, 'unbindProjectFromWebsites'],
  [/touchedPages/g, 'touchedWebsites'],
  [/page_publish_token/g, 'website_publish_token'],
  [/\.view\.pages\b/g, '.view.websites'],
  [/CRAFT_PAGES_SHARE_API_URL/g, 'CRAFT_WEBSITES_SHARE_API_URL'],
]

/**
 * Bare string literals only, for the handful of files listed in
 * {@link BARE_STRING_FILES}: outside the feature, `'pages'` means the navigator
 * key / the disk directory / the route detail type — never a prototype's page
 * list.
 */
const REWRITES_BARE_STRINGS: Array<[RegExp, string]> = [
  [/'pages'/g, "'websites'"],
  [/'page'/g, "'website'"],
]

function isAllowed(rel: string): boolean {
  const p = rel.split(sep).join('/')
  if (p.includes('prototype')) return false
  if (p.includes('/prototypes/')) return false
  if (EXCLUDED_PREFIXES.some(prefix => p.startsWith(prefix))) return false
  return ALLOWED_PREFIXES.some(prefix => p === prefix || p.startsWith(prefix))
}

function isFeatureFile(rel: string): boolean {
  const p = rel.split(sep).join('/')
  return FEATURE_PREFIXES.some(prefix => p === prefix || p.startsWith(prefix))
}

/**
 * The feature's OWN files can be rewritten wholesale: every `Page` / `page` in
 * them names this feature, including the compounds a word boundary would miss
 * (`LoadedPage`, `recordPageThumbnail`, `pageSlug`). The two files that also
 * speak the automations vocabulary are held back — see
 * {@link NO_BLANKET_PREFIXES}.
 */
const REWRITES_BLANKET: Array<[RegExp, string]> = [
  [/Page/g, 'Website'],
  [/page/g, 'website'],
]

/**
 * Word-boundary rules, for the files that must not be blanket-rewritten. The
 * `Page*` / `PAGE_*` families are ours even there; the bare words are not,
 * because `ScriptAction.page` is how a refresh run stamps its completion
 * marker.
 */
const REWRITES_GENERIC: Array<[RegExp, string]> = [
  [/\bPage([A-Z]\w*)/g, 'Website$1'],
  [/\bPAGE_([A-Z0-9_]+)/g, 'WEBSITE_$1'],
]

/**
 * Relative imports of the feature from its neighbours (`../pages/storage.ts`).
 * Separate from the enumerated list because a bare `pages` segment is also how
 * the prototype's own modules reach each other — the path must be rooted at the
 * feature, never a bare `./pages`.
 */
const REWRITES_PATHS: Array<[RegExp, string]> = [
  [/from '\.\.\/pages\//g, "from '../websites/"],
  [/from '\.\.\/pages'/g, "from '../websites'"],
  [/from '\.\.\/\.\.\/pages\//g, "from '../../websites/"],
  // Dynamic type imports: `import('../pages/types.ts').LoadedPage`
  [/import\('\.\.\/pages\//g, "import('../websites/"],
  [/import\("\.\.\/pages\//g, 'import("../websites/'],
]

/**
 * Callers get the enumerated rules MINUS `PageKind`: that name also exists in
 * the prototype vocabulary (`PrototypePage.kind: PageKind`), and a caller like
 * SessionManager imports both worlds. Every other name here belongs to the
 * websites feature alone, so it is safe outside the feature's own files too.
 */
const REWRITES_CALLERS = [...REWRITES_PATHS, ...REWRITES.filter(([pattern]) => String(pattern) !== '/PageKind/g')]

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

const targets = walk(ROOT)
  .map(full => relative(ROOT, full).split(sep).join('/'))
  .filter(isAllowed)
  .filter(p => /\.(ts|tsx|json|md)$/.test(p))

let rewrittenFeature = 0
let rewrittenCallers = 0
let renamedFiles = 0
const hitByRule = new Map<string, number>()

function isNoBlanket(rel: string): boolean {
  const p = rel.split(sep).join('/')
  return NO_BLANKET_PREFIXES.some(prefix => p === prefix || p.startsWith(prefix))
}

function rulesFor(rel: string): ReadonlyArray<[RegExp, string]> {
  const p = rel.split(sep).join('/')
  if (isNoBlanket(rel)) return [...REWRITES_GENERIC, ...REWRITES]
  if (isFeatureFile(rel)) return [...REWRITES_BLANKET, ...REWRITES_GENERIC, ...REWRITES]
  if (BARE_STRING_FILES.includes(p)) return [...REWRITES_CALLERS, ...REWRITES_BARE_STRINGS]
  return REWRITES_CALLERS
}

for (const rel of targets) {
  const path = join(ROOT, rel)
  const before = readFileSync(path, 'utf-8')
  const rules = rulesFor(rel)
  let after = before
  for (const [pattern, replacement] of rules) {
    const matches = after.match(pattern)
    if (!matches) continue
    hitByRule.set(String(pattern), (hitByRule.get(String(pattern)) ?? 0) + matches.length)
    after = after.replace(pattern, replacement)
  }
  if (after === before) continue
  if (isFeatureFile(rel)) rewrittenFeature++
  else rewrittenCallers++
  if (WRITE) writeFileSync(path, after, 'utf-8')
}

if (WRITE) {
  for (const [from, to] of FILE_RENAMES) {
    const src = join(ROOT, from)
    if (existsSync(src) && !existsSync(join(ROOT, to))) {
      renameSync(src, join(ROOT, to))
      renamedFiles++
    }
  }
  for (const [from, to] of DIR_RENAMES) {
    const src = join(ROOT, from)
    if (existsSync(src) && !existsSync(join(ROOT, to))) {
      renameSync(src, join(ROOT, to))
      renamedFiles++
    }
  }
}

console.log(`${WRITE ? 'APPLIED' : 'DRY RUN'} — pages → websites`)
console.log(`  scoped files:     ${targets.length}`)
console.log(`  feature files:    ${rewrittenFeature} rewritten (full rename)`)
console.log(`  caller files:     ${rewrittenCallers} rewritten (no PageKind rule)`)
if (WRITE) console.log(`  paths renamed:    ${renamedFiles}`)
console.log('  top rule hits:')
for (const [rule, hits] of [...hitByRule].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
  console.log(`    ${String(hits).padStart(5)}  ${rule}`)
}
if (!WRITE) console.log('\nRe-run with --write to apply.')
