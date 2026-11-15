/**
 * What does each GenOffice editor ask for, and what does this host answer?
 *
 * The point of this script is to stop *discovering* the answer. An editor's API is ~200 names, and
 * the ones we have not wired answer `undefined`, which reads as "feature off" — so a missing method
 * costs nothing visible until someone clicks the button and nothing happens. That is how `getNotes`
 * swallowed a person's typing for weeks.
 *
 * So: derive the host-side method list from the vendored bundles, subtract what the frame answers
 * itself, subtract what the host has a `case` for, and print the remainder. Exit code 1 when the
 * remainder grows past the list below — an unwired method is allowed *by name*, not by accident.
 *
 *   bun scripts/check-office-methods.ts            # report
 *   bun scripts/check-office-methods.ts --strict   # fail when a name is not accounted for
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const strict = process.argv.includes('--strict')

/**
 * Methods that are **deliberately** unanswered, with the reason.
 *
 * Each one is a capability this product does not have, not a gap in the wiring. Anything not in
 * this list that also has no `case` in the host is a bug — the editor offers it and nothing happens.
 */
const REFUSED: Record<string, string> = {
  // GenOffice's own services. We run none of them, and the editors gate these on `getAiSettings`.
  aiStream: 'AI is off in this product',
  aiStreamCancel: 'AI is off in this product',
  aiGskLogin: 'no GenOffice account service here',
  aiGskStatus: 'no GenOffice account service here',
  aiLogRunFailure: 'no telemetry sink',
  aiSnapshotRestore: 'AI is off in this product',
  aiGenerateImage: 'AI is off in this product',
  generateImage: 'AI is off in this product',
  localGeneratePage: 'AI is off in this product',
  analyzeMedia: 'AI is off in this product',
  imageSearch: 'no image search service',
  webSearch: 'no web search service here (the agent has its own)',
  skillText: 'no skills service for the editors',
  skillsList: 'no skills service for the editors',
  listStyleTemplates: 'no style template library',
  loadStyleTemplate: 'no style template library',
  saveStyleTemplate: 'no style template library',
  saveStyleSidecar: 'no style template library',
  fontCatalog: 'GenOffice downloads fonts from its own CDN',
  fontDownload: 'GenOffice downloads fonts from its own CDN',
  fontInstallLocal: 'no user font store',
  fontMissing: 'needs an inventory of the machine’s fonts',
  recent: 'the app keeps its own recent files',
  getRecentFiles: 'the app keeps its own recent files',
  // Docs' desktop-only protocol. The editor's own main answers these with a dialog, a temp-file
  // handshake, or a knowledge base this host does not have — and three of them it never implemented.
  confirmDocumentReplace: 'a dialog: the app opens another overlay rather than replacing this one',
  convertAltChunkHtml: 'altChunk flattening runs in the editor’s own open path',
  reportCloseCheck: 'no handler in GenOffice’s own main either',
  signalMcpReady: 'no handler in GenOffice’s own main either',
  reportMcpResult: 'no handler in GenOffice’s own main either',
  writeExportImage: 'image-export temp handshake (needs its own dialog first)',
  takeExportPdf: 'image-export temp handshake (needs its own dialog first)',
  saveMergedPdf: 'merge export dialog',
  writeMergeOutput: 'merge export dialog',
  kbList: 'knowledge base (a vault this host does not have)',
  kbRead: 'knowledge base (a vault this host does not have)',
  kbSearch: 'knowledge base (a vault this host does not have)',
  respellKick: 'spellcheck is off in this host’s prefs',
  spellLanguages: 'spellcheck is off in this host’s prefs',
  spellSetLanguages: 'spellcheck is off in this host’s prefs',
  spellAddWord: 'spellcheck is off in this host’s prefs',
  spellIgnoreWord: 'spellcheck is off in this host’s prefs',
  spellReplace: 'spellcheck is off in this host’s prefs',
  spellDiag: 'spellcheck is off in this host’s prefs',
  // Slides' remaining surface needs an OS capability this host does not have.
  // wired (frame answers): insertMedia: 'a file dialog for audio/video (the deck door has no UI)',
  // wired (frame answers): savePicture: 'one shape as a picture needs the same renderer',
  // wired (frame answers): copyElementsImage: 'OS clipboard image',
  // wired (frame answers): clipboardExternal: 'OS clipboard bridge',
  nativeClipboard: 'OS clipboard bridge',
  repasteSlide: 'OS clipboard slot bookkeeping',
  landGeneratedPages: 'AI page landing',
  // PDF and workbook surface that is a dialog, a second document, or the app's own save path.
  autoRename: 'renaming a produced file needs the client’s dialog',
  autoRenameWorkbook: 'renaming a produced file needs the client’s dialog',
  // wired: compareReadOpen: 'compare mode (two documents side by side)',
  // wired: compareReadPdf: 'compare mode (two documents side by side)',
  gskStatus: 'GenOffice account status',
  pagePreviewPng: 'impossible: redaction rectangles only leave the editor on save',
  readPivotDefinition: 'needs the app’s pivot parser, which is not in the engine bundle',
  exportCsv: 'a save dialog decides where the csv goes',
  saveWorkbookEdits: 'the editor’s own incremental save path; this host writes whole workbooks',
  writeWorkbookRecovery: 'recovery copies are the editor’s own bookkeeping',
  openAiModelSettings: 'AI is off in this product',
  openSkillsSettings: 'no skills service for the editors',
  pickModel: 'AI is off in this product',
  getAiSettings: 'answered by the frame (AI is off)',
  setAiSettings: 'answered by the frame (AI is off)',
  setAiPanelPrefs: 'answered by the frame (AI is off)',

  // The OS. A hub has no desktop, and the app answers these in the renderer.
  pickAttachments: 'file dialogs belong to the client',
  pickPictureFile: 'file dialogs belong to the client',
  pickModel3d: 'file dialogs belong to the client',
  pickMergeDataSource: 'file dialogs belong to the client',
  pickExportImagesTarget: 'file dialogs belong to the client',
  openExternal: 'shell.openExternal belongs to the client',
  openSourcePath: 'the client opens paths',
  createDocument: 'desktop command surface',
  runCli: 'desktop command surface',
  listPrinters: 'no printer list here (export a PDF instead)',
  print: 'no printer here',
  printWorkbook: 'no printer here',
  printSlides: 'no printer here',
  printPdfBuffer: 'no printer here',
  captureScreenSources: 'screen capture belongs to the client',
  captureScreenSource: 'screen capture belongs to the client',
  microphoneAccess: 'recording belongs to the client',
  zoteroCommand: 'no Zotero bridge',
  respondToZotero: 'no Zotero bridge',
  addAttachmentPaths: 'chat attachments belong to the session',
  addPastedImage: 'pasted images belong to the renderer',
  readAttachment: 'chat attachments belong to the session',
  readAttachmentImage: 'chat attachments belong to the session',
  readLocalImage: 'the renderer reads local images',
  fetchImage: 'the renderer fetches images',
  openEncryptedWorkbook: 'passwords are asked by the renderer',
  updateWorkbookPassword: 'passwords are asked by the renderer',
  confirmCsvSave: 'the renderer confirms',
  openWorkbooksForMerge: 'a file dialog',
  selectWorkbooksForMerge: 'a file dialog',
  openDocxDecrypt: 'passwords are asked by the renderer',
  setDocPassword: 'passwords are asked by the renderer',
  discardDocPasswordIntents: 'passwords are asked by the renderer',
  docPasswordIntentRevision: 'passwords are asked by the renderer',
  armContextMenu: 'menus belong to the renderer',
  claimContextMenu: 'menus belong to the renderer',
  reportViewMenuState: 'menus belong to the renderer',
  focusDocsTab: 'tabs belong to the renderer',
  listDocsTabs: 'tabs belong to the renderer',
  openNewTab: 'tabs belong to the renderer',
  newBlank: 'the frame opens a blank document',
}

/**
 * Methods that **should** be wired and are not yet — the backlog, by name and reason.
 *
 * Separate from `REFUSED` on purpose: a refusal is a capability this product does not have, a
 * pending is a hole we owe the user. Both are allowed to exist; only a method in *neither* is a
 * bug. Keeping them in one list would let the second kind hide behind the first.
 */
const PENDING: Record<string, string> = {
  // ---- media: bytes have to land in the package before an element can point at them ----
  // wired: addImageBytes: 'media import (write bytes into the package)',
  // wired: insertImageUrl: 'media import (fetch a URL into the package)',
  // wired: addMediaBytes: 'media import (audio/video)',
  // wired: addInk: 'ink strokes (a picture plus an op)',
  // wired: replacePictureBytes: 'media import (replace bytes)',
  // wired: replacePictureUrl: 'media import (replace from URL)',
  // wired: editPictureSrcRect: 'picture crop (op exists; payload not translated yet)',
  // wired: editPictureOpacity: 'picture opacity (op exists; payload not translated yet)',
  // wired: editImageFill: 'image fill (op exists; payload not translated yet)',
  // wired: editBackground: 'background image (needs media import first)',

  // ---- charts and the model behind them ----
  // wired/renamed: addModel: '3D model insert',
  // wired/renamed: getModel: 'model access',
  // wired/renamed: setModel: 'model access',
  // wired: editChart: 'chart editing (data + style in one op)',
  // wired/renamed: getChartData: 'chart data read',
  // wired/renamed: getChartColorSchemes: 'colour scheme catalogue',

  // ---- geometry gestures that need the editor-side payload helper ----
  // wired: editTransform: 'drag preview (payload built by the app, not the editor)',
  // wired: editTransformMulti: 'drag preview, several shapes',
  // wired: cancelTransformPreview: 'drag preview bookkeeping',
  // wired: editConnectorEndpoints: 'connector endpoints (op exists; payload not translated yet)',

  // ---- clipboard of deck objects ----
  // wired: copyElements: 'host-side clipboard for shapes',
  // wired: pasteElements: 'host-side clipboard for shapes',
  // wired: duplicateElements: 'copy within a slide',
  // wired: copySlides: 'host-side clipboard for slides',
  // wired: pasteSlide: 'host-side clipboard for slides',

  // ---- the master view and the show ----
  // wired: masterEnter: 'master view (edits a layout/master part)',
  // wired: masterOpen: 'master view',
  // wired: masterClose: 'master view',
  // wired: masterEditText: 'master view',
  // wired: masterEditTransform: 'master view',
  // wired: masterEditFill: 'master view',
  // wired: masterEditStroke: 'master view',
  // wired: masterAddElement: 'master view',
  // wired: masterDeleteElement: 'master view',
  // wired: presenterStart: 'presenter window',
  // wired: presenterEnd: 'presenter window',
  // wired: presenterSync: 'presenter window',
  // wired: presenterSwap: 'presenter window',
  // wired: presenterInk: 'presenter ink layer',
  // wired: audienceNav: 'presenter window',
  // wired: audienceReady: 'presenter window',
  // wired: setShowFullScreen: 'presenter window',

  // ---- recording, exports and file identity ----
  // wired: saveRecording: 'narration recording (write media into the package)',
  // wired: applyEditScript: 'scripted multi-op edits',
  // wired: saveAs: 'Save As dialog belongs to the client',
  // wired: getMediaData: 'media bytes for one shape',
  // wired (frame answers): exportPdf: 'frame-side export for the docs editor (only export windows answer it today)',
  // wired (frame answers): exportHtml: 'frame-side export for the docs editor',
  // wired (frame answers): exportMarkdown: 'frame-side export for the docs editor',
  saveImageAs: 'file dialog',
  pickImage: 'file dialog',
  // wired: recalcWorkbook: 'IronCalc recalculation (sidecar command)',
  // wired: readWorkbookFormulas: 'sidecar command',
  // wired: readWorkbookMedia: 'sidecar command',
  // wired: findWorkbookCells: 'sidecar command',
}


/**
 * Two sidecar commands the shipped binary does not implement — `find_cells` and `read_row_outline`
 * (zero occurrences in `xlsx-sidecar.exe`). Neither is used any more: `read_range` already answers
 * every cell's value/formula and every row's `outlineLevel`/`hidden`/`collapsed`, so find and the
 * outline are projections of an answer we get anyway (`workbookFindCells` / `workbookRowOutline`).
 * No new binary required.
 */
/** Which editors call which host doors. */
const EDITORS = ['docs', 'sheets', 'slides', 'pdf'] as const

/** The bundle's global for each editor's host bridge. */
const GLOBALS = ['desktop', 'desktopApi', 'slidesApi', 'pdfApi'] as const

function bundlePath(editor: string, file: string): string | null {
  const dir = join(ROOT, 'apps', 'electron', 'resources', 'office', editor, 'assets')
  if (!existsSync(dir)) return null
  const name = readFileSync(join(ROOT, 'apps', 'electron', 'resources', 'office', editor, 'index.html'), 'utf8')
  const match = /assets\/(index-[^"]+\.js)/.exec(name)
  return match ? join(dir, match[1]!) : null
}

function calledMethods(path: string): Set<string> {
  const source = readFileSync(path, 'utf8')
  const out = new Set<string>()
  // Digits belong to the name: `getModel3dData` is not `getModel`.
  const pattern = new RegExp(`(?:${GLOBALS.join('|')})\\.([A-Za-z][A-Za-z0-9]*)`, 'g')
  for (const match of source.matchAll(pattern)) if (match[1]) out.add(match[1]!)
  return out
}

function answeredByFile(path: string): Set<string> {
  if (!existsSync(path)) return new Set()
  const source = readFileSync(path, 'utf8')
  const out = new Set<string>()
  for (const match of source.matchAll(/case '([A-Za-z][A-Za-z0-9]*)'/g)) if (match[1]) out.add(match[1]!)
  // the shim's api table is an object, not a switch
  for (const match of source.matchAll(/^\s{4}([A-Za-z][A-Za-z0-9]*): function/mg)) if (match[1]) out.add(match[1]!)
  return out
}

const frame = answeredByFile(join(ROOT, 'packages', 'ui', 'src', 'components', 'office', 'OfficeFrame.tsx'))
const shim = answeredByFile(join(ROOT, 'packages', 'shared', 'src', 'office', 'shim.ts'))
const hosts: Record<string, Set<string>> = {
  docs: shim,
  sheets: new Set([...shim, ...answeredByFile(join(ROOT, 'packages', 'office-host', 'src', 'workbook.ts'))]),
  slides: new Set([...shim, ...answeredByFile(join(ROOT, 'packages', 'office-host', 'src', 'deck.ts'))]),
  pdf: new Set([...shim, ...answeredByFile(join(ROOT, 'packages', 'office-host', 'src', 'pdf.ts'))]),
}

let missingTotal = 0
let bundleMissing = false

for (const editor of EDITORS) {
  const bundle = bundlePath(editor, 'index.html')
  if (!bundle) {
    bundleMissing = true
    console.log(`== ${editor}: bundle not built here — run bun scripts/build-office-assets.ts ==`)
    continue
  }
  const called = calledMethods(bundle)
  const hostSide = [...called].filter((name) => !frame.has(name) && !name.startsWith('on'))
  const unanswered = hostSide.filter(
    (name) => !hosts[editor]!.has(name) && !(name in REFUSED) && !(name in PENDING),
  )
  const refused = hostSide.filter((name) => name in REFUSED)
  const pending = hostSide.filter((name) => name in PENDING)
  const answered = hostSide.length - unanswered.length - refused.length - pending.length
  missingTotal += unanswered.length
  console.log(
    `== ${editor}: calls ${called.size} · frame ${called.size - hostSide.length} · host answers ${answered} · refused ${refused.length} · pending ${pending.length} · UNEXPLAINED ${unanswered.length}`,
  )
  if (unanswered.length) console.log('   ', unanswered.sort().join(' '))
}

console.log(
  missingTotal === 0
    ? '\nNo method is unanswered without a reason.'
    : `\n${missingTotal} method(s) the editors call, this host ignores, and nothing explains.`,
)

if (strict && missingTotal > 0) process.exit(1)
if (strict && bundleMissing) console.log('(bundles missing — the check is only as complete as the build)')
