/**
 * Which JavaScript runtime runs the bundled GenOffice command line.
 *
 * The hosts here are plain Node — `node:fs`, `node:child_process`, and the engine bundles — so the
 * same code runs in the desktop app and on a hub. Exactly one thing is not portable: **the binary
 * that executes the CLI**. The app spawns its own Electron binary with `ELECTRON_RUN_AS_NODE=1`
 * (Electron ships a Node, and it is already in the installation); a hub spawns whatever runtime it
 * is itself run by.
 *
 * So the choice is a value, set once at startup by whoever owns the process, rather than a
 * `process.versions.electron` branch buried in a spawn call. Getting it wrong is not subtle — the
 * CLI answers `4 (app not available)` or fails to start at all — but it is invisible until a save
 * or a conversion is attempted, which is why it is one explicit decision.
 */

export interface OfficeRuntime {
  /** The binary to run `resources/cli/genoffice.cjs` with. */
  command: string
  /** Environment every CLI spawn gets, on top of the process's own (e.g. `ELECTRON_RUN_AS_NODE`). */
  env: Record<string, string>
}

/**
 * The app's runtime: its own binary, as Node.
 *
 * `process.execPath` in a packaged app is `…/Craft`, which *is* the app — hence
 * `ELECTRON_RUN_AS_NODE`, without which running a script would try to start a second copy of the
 * app instead. In development it is `electron.exe`, which needs the same flag for the same reason.
 */
export function electronRuntime(): OfficeRuntime {
  return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } }
}

/**
 * A hub's runtime.
 *
 * 1. `CRAFT_OFFICE_RUNTIME` — an explicit path, for a host that knows better. A compiled single
 *    binary is this case: `process.execPath` would be the server itself, and handing it a script
 *    path does not run the script.
 * 2. `node` from `PATH` — the normal hub. The CLI bundle is CommonJS with a jsdom dependency built
 *    for Node, and a hub already carries Node for the WhatsApp worker and the printing launcher
 *    (`vendor/node` in the standalone package, the system Node in the image). It used to run on
 *    the Bun that hosts the server; Node is the runtime this bundle targets, so that is the
 *    default now. A host without Node fails at the first document conversion with a spawn error.
 */
export function hostRuntime(): OfficeRuntime {
  const explicit = process.env.CRAFT_OFFICE_RUNTIME?.trim()
  if (explicit) return { command: explicit, env: {} }
  return { command: 'node', env: {} }
}

let current: OfficeRuntime | null = null

/** Set once, by the process that owns the hosts (`index.ts` of the app, or the hub's bootstrap). */
export function setOfficeRuntime(runtime: OfficeRuntime): void {
  current = runtime
}

/**
 * The runtime in force, defaulting to a guess from the process.
 *
 * The default is deliberately a guess only for callers that never set one — a test, or a host that
 * forgot — and it prefers Electron's answer when it is Electron, because that is the case where
 * getting it wrong is silent: the app would spawn its own binary without the flag and hang.
 */
export function officeRuntime(): OfficeRuntime {
  if (current) return current
  return process.versions.electron ? electronRuntime() : hostRuntime()
}

/**
 * Printing a document to PDF, when the host has a renderer that can.
 *
 * This is the one capability in this package that is **not** portable: it needs a Chromium and the
 * editor as the top document, so it exists in the desktop app and not on a hub. It is injected the
 * same way the runtime is — set by the process that owns it — rather than imported, so a hub can
 * carry these hosts without dragging the app's print pipeline along.
 */
export interface OfficePrintInput {
  app: 'docs' | 'sheets' | 'slides' | 'pdf'
  path: string
  bytes: Uint8Array
}

export type OfficePrint = (input: OfficePrintInput, outPath?: string) => Promise<string>

let currentPrint: OfficePrint | null = null

/** Give the hosts a printer, or take it away (`null`) on a host that has none. */
export function setOfficePrint(printer: OfficePrint | null): void {
  currentPrint = printer
}

/** The printer in force, or null when this host cannot print — the caller says so and stops. */
export function officePrint(): OfficePrint | null {
  return currentPrint
}

/**
 * Where a produced file goes — the one policy a document tool cannot make for itself.
 *
 * Splitting a pdf, extracting pages, cropping, exporting page images: each produces a *new* file,
 * and "new file" is a decision about a filesystem. The app writes it beside the document it came
 * from and reveals it; a hub writes it to its export scratch and hands the caller something to
 * **download**, because the person is in a browser and the hub's disk is not theirs.
 *
 * That is the whole abstraction: the door produces bytes, the host this process is running in says
 * where they land. A hub cannot pretend to write to a path the person can see, and the desktop app
 * has no reason to fetch a download it already has.
 */
export interface OfficeProducedFile {
  /** File name, without a directory: the host decides the directory. */
  name: string
  bytes: Uint8Array
  mime: string
}

export interface OfficeDelivery {
  /** Absolute paths, for a host that wrote them where the person can reach them. */
  savedPaths?: string[]
  /**
   * Fetches for a client that must download them (`/api/exports/<id>` on a hub), in the shape the
   * export store publishes — `size` included, because whoever saves the file shows a progress hint.
   */
  downloads?: Array<{ id: string; name: string; size: number; mime: string }>
}

/**
 * `source` is the document the files were produced from, when there is one: a host writing to disk
 * puts them beside it, which is where a person looks for "the split pages of that file".
 */
export type OfficeDeliver = (files: OfficeProducedFile[], source: string | null) => Promise<OfficeDelivery>

let currentDeliver: OfficeDeliver | null = null

/** Give the door somewhere to put produced files. Absent, it refuses in words rather than silently. */
export function setOfficeDeliver(deliver: OfficeDeliver | null): void {
  currentDeliver = deliver
}

export function officeDeliver(): OfficeDeliver | null {
  return currentDeliver
}
