/**
 * Diagrams, drawn — by the drawio webapp this app already ships.
 *
 * A `.drawio` document is not a picture until drawio's own renderer has drawn it. That is
 * drawio's code, it runs only inside a document of drawio's origin, and it is not something this
 * app reimplements — so a hidden window loads the engine document that origin serves
 * (`drawio-host.ts`) and drives it.
 *
 * The shape is `video-frames.ts`': one hidden window per call, driven by a single
 * `executeJavaScript` that runs to completion, destroyed in `finally`. Nothing is cached between
 * calls, which is what keeps a stale engine from outliving a refetch of the vendored bundle.
 *
 * **The person is not involved.** No app window has to be open, and no tab is touched: this is
 * the same "a hidden window of its own" that sampling a recording uses, and it is why the tool
 * can be called from a session that has never shown anything.
 */

import { BrowserWindow } from 'electron'
import {
  describeDrawioPageProblem,
  findDrawioPage,
  projectDrawioPage,
} from '@craft-agent/shared/drawio/types'
import { DRAWIO_EXTENSIONS, type DrawioFormat } from '@craft-agent/shared/agent/browser-pane'
import { DRAWIO_ENGINE_PATH, DRAWIO_ENGINE_SURFACE, drawioOriginUrl } from './drawio-host'

/**
 * What a document can be turned into — the capability surface's own list, re-exported rather than
 * written out again, so a format added there cannot be missing here (`xml` is the one whose addition
 * made that difference visible). What each format is, and which of them carry the document rather than
 * a drawing, is documented where the type is declared and in `drawio-tools.md`.
 */
export type { DrawioFormat }

export interface RenderedDrawio {
  bytes: Buffer
  mimeType: string
  /** The suffix the format is written under, `.svg` and friends. */
  extension: string
}

/** The ceiling on one engine call. The editor is a ~10 MB application; it is not fast, but it is
 *  not 60 seconds either, and a tool call has to return something. */
const ENGINE_TIMEOUT_MS = 60_000

/** `format` → what the bytes are filed as. The suffix comes from the shared table, so the name a
 *  `--to` path is completed with and the name written here cannot disagree. */
const FORMATS: Record<DrawioFormat, { mimeType: string; extension: string }> = {
  svg: { mimeType: 'image/svg+xml', extension: DRAWIO_EXTENSIONS.svg },
  xmlsvg: { mimeType: 'image/svg+xml', extension: DRAWIO_EXTENSIONS.xmlsvg },
  png: { mimeType: 'image/png', extension: DRAWIO_EXTENSIONS.png },
  html: { mimeType: 'text/html', extension: DRAWIO_EXTENSIONS.html },
  // The document itself. `.drawio` rather than `.xml`: the same content either way, but `.drawio` is
  // the suffix this app recognizes a diagram by (the prototype page's file list, for one) — and the
  // caller gives its own path anyway.
  xml: { mimeType: 'application/xml', extension: DRAWIO_EXTENSIONS.xml },
}

export function isDrawioFormat(value: string): value is DrawioFormat {
  return Object.prototype.hasOwnProperty.call(FORMATS, value)
}

/** The address the engine is driven at, or the sentence that says why there is none. */
function requireEngineOrigin(): string {
  const origin = drawioOriginUrl()
  if (!origin) {
    throw new Error(
      'The bundled drawio webapp is not installed, so no diagram can be converted or rendered. ' +
        'Run: bun scripts/fetch-drawio-assets.ts',
    )
  }
  return origin
}

/**
 * Run one request in a hidden window on the drawio origin, and destroy it afterwards.
 *
 * `call` is a JavaScript **expression** evaluated in the engine document; the engine's own
 * `window.__craftDiagram` is the surface it may use, and everything it can do to the caller is
 * resolve or reject that expression.
 */
async function withEngine<T>(call: string): Promise<T> {
  const window = new BrowserWindow({
    show: false,
    width: 1280,
    height: 900,
    webPreferences: {
      // A window nobody looks at is still a window the OS may throttle into uselessness, and
      // every step here is timing-dependent.
      backgroundThrottling: false,
    },
  })

  try {
    await window.loadURL(`${requireEngineOrigin()}${DRAWIO_ENGINE_PATH}`)
    return (await window.webContents.executeJavaScript(
      `Promise.race([
        Promise.resolve(${call}),
        new Promise(function (_, reject) {
          setTimeout(function () { reject(new Error('The diagram engine did not answer in time.')) }, ${ENGINE_TIMEOUT_MS})
        })
      ])`,
      true,
    )) as T
  } finally {
    if (!window.isDestroyed()) window.destroy()
  }
}

/**
 * The document the editor is given: the whole file, or only the page that was asked for.
 *
 * A page is cut out rather than pointed at because the editor's export takes `pageId` for a PNG and
 * for nothing else — an SVG, an editable SVG and an HTML page all come from whichever page is
 * *current*, which after a load is the first one. See `projectDrawioPage`.
 *
 * @throws when the name matches no page, or two: drawio's own answer to a page it cannot find is to
 *   draw the first one and say nothing, and that is the one outcome this must not pass on.
 */
function documentToDraw(xml: string, page: string | undefined): string {
  if (!page) return xml

  const lookup = findDrawioPage(xml, page)
  if (!lookup.ok) throw new Error(describeDrawioPageProblem(page, lookup))

  const projected = projectDrawioPage(xml, lookup.page.id)
  if (projected === null) {
    throw new Error(`The page "${page}" is not one this document can be drawn from on its own.`)
  }
  return projected
}

/**
 * A `.drawio` document → SVG, an editable SVG, a PNG, a standalone page, or the document itself.
 *
 * @throws when the engine hands nothing back, which is the one failure that must not be mistaken for a
 *   diagram with no shapes in it (or, for `xml`, for an empty document).
 */
export async function renderDrawio(input: {
  /** The document: what a `.drawio` file holds. */
  xml: string
  format: DrawioFormat
  /** Draw this page, by the name the document gives it. Omitted, its first page. */
  page?: string
  /** Pixels per unit in the output. Omitted, drawio's own 1. */
  scale?: number
  /** Draw it for a dark background, the way the app's own previews do. */
  dark?: boolean
}): Promise<RenderedDrawio> {
  // One string comes back, and it is the *payload*: the engine has already been through the one
  // branch that differs by format — a document arrives in the editor's `xml`, a picture in its
  // `data` — and hands on what the caller has to write (`engineBridgeScript`). So there is no
  // reply to pick a field out of here.
  //
  // This was typed as the editor's own reply, `{ format, data }`, which is a different thing at a
  // different layer: the annotation then *promised* a `data` field, `reply.data` type-checked, and
  // every format died at `Buffer.from(undefined)` — the drawing had arrived, and was thrown away.
  const payload = await withEngine<string>(
    `${DRAWIO_ENGINE_SURFACE}.render(${JSON.stringify({
      xml: documentToDraw(input.xml, input.page),
      format: input.format,
      ...(input.scale !== undefined ? { scale: input.scale } : {}),
      dark: input.dark === true,
    })})`,
  )

  const filed = FORMATS[input.format]
  return { bytes: decodeReply(payload, input.format), ...filed }
}

/**
 * The editor hands its answer back the way its own host expects it: a `data:` URI for the
 * formats that are bytes, markup for the ones that are text.
 *
 * Both spellings of a `data:` URI are handled (`;base64,` and a URL-encoded payload) because
 * which one drawio uses differs by format — the SVG exports are URL-encoded, the PNGs are not —
 * and getting this wrong yields a file that looks plausible and opens as nothing.
 */
function decodeReply(data: string, format: DrawioFormat): Buffer {
  const uri = /^data:([^,]*),(.*)$/s.exec(data)
  if (!uri) return Buffer.from(data, 'utf-8')

  const [, meta = '', payload = ''] = uri
  return meta.includes(';base64')
    ? Buffer.from(payload, 'base64')
    : Buffer.from(decodeURIComponent(payload), 'utf-8')
}
