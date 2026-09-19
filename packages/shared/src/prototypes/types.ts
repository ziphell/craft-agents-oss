/**
 * Prototype workbench artifact types.
 *
 * A prototype lives at `{workspaceRootPath}/prototypes/{slug}/` and is
 * made of ordinary files (its page documents + `patches/`) so it stays
 * git-diffable and editable by the agent, the control plane, or an external
 * editor.
 *
 * **This module imports nothing, on purpose.** It is the one part of the
 * prototypes family that a *renderer* can take a value from: the adjacent modules
 * reach `workspaces/storage.ts` → `config/storage.ts`, which lazy-imports the
 * agent runtime (`../agent/session-scoped-tools.ts`) and through it the Claude
 * Agent SDK — a node-only dependency that cannot be bundled for the browser. A
 * barrel import from the panel dragged all of that into the renderer build; a
 * plain constant from here cannot.
 *
 * @see docs/prototype-workbench-plan.md §4
 */

/**
 * Which kind of page this is — the fact a *document* carries, not the container
 * (plan §19).
 *
 * A prototype is a flow, and a flow may mix both: three screens of our own plus
 * the one real page we cannot rebuild. That is why this is not
 * `PrototypeKind` — the kind belongs to a row of the page table
 * ({@link PrototypePageEntry}), and a prototype is the table.
 *
 * Fixed when the page is added, never changed afterwards (plan §13.2): turning
 * an overlay into a scratch page would leave its patches pointing at a document
 * that is no longer replayed, and nothing on screen would say so.
 */
export type PageKind = 'overlay' | 'scratch'

/**
 * What a page is when the caller does not say — the kind
 * {@link createPrototype}'s first page falls back to, and (through
 * {@link promoteLegacyConfig}) what a config file written before the page table
 * existed is read as.
 *
 * `scratch` is the default because it is the only kind that can never be
 * stillborn: it owns its document, so every state has a way forward (write
 * `cart.html`, or import another prototype's page). An `overlay` without an
 * address has no page to open, no page to export against, and — since the kind
 * cannot be changed afterwards — no way out at all. Something with no way out
 * must be asked for, never assumed.
 */
export const DEFAULT_PAGE_KIND: PageKind = 'scratch'

/**
 * The page name a prototype's page table is read as having, for configs written
 * before the table existed (plan §19.7 /
 * {@link promoteLegacyConfig} in `config.ts`).
 *
 * A legacy `overlay` had one `targetUrl` and no name for it; a legacy `scratch`
 * had `base.html`, which the table names `base`. Reserving the constant here —
 * rather than in `config.ts` — keeps it in the one module that imports nothing,
 * so both the promotion and its tests can name it.
 */
export const LEGACY_ENTRY_PAGE_NAME = 'entry'

/** The document a legacy `scratch` prototype kept its page in, and its page name. */
export const LEGACY_BASE_PAGE_NAME = 'base'

/**
 * The layout a scratch page may share, and the one slot in it (plan §19.2).
 *
 * Underscored so it cannot be mistaken for a page — the page rule skips
 * `_`-prefixed names, which is what keeps "is this a page" answerable without a
 * list. Here rather than in `pages.ts` because `storage.ts` needs the file name
 * to build a path, and `pages.ts` imports `storage.ts` (keeping this in the
 * import-nothing module is what stops that becoming a cycle).
 *
 * The slot is spelled the way HTML already spells a slot, so an author — usually
 * the agent — recognises it without being taught a syntax of ours, and a layout
 * that later becomes a real Web Component needs no rewriting. The host and export
 * still fill it by replacing the first occurrence: the mechanism is unchanged, only
 * the markup is the standard one.
 */
export const PROTOTYPE_LAYOUT_FILENAME = '_layout.html'
export const PROTOTYPE_LAYOUT_SLOT = '<slot name="page"></slot>'

/**
 * The directory a prototype's **findings** live in — what was learned about
 * someone else's product, with the source and the evidence for it (plan §20.2).
 *
 * Here, next to the other directory names that several modules have to agree on,
 * because the distinction it draws is a rule rather than a preference: `assets/`
 * is what a page loads at runtime and therefore ships in the package, while
 * `research/` is how the author got to the requirements and therefore does not.
 */
export const PROTOTYPE_RESEARCH_DIRNAME = 'research'

/**
 * The directory a prototype's **anchors** live in: one record per scope of what
 * each declared `@target` matched, and when (`anchors.ts`).
 *
 * A sibling of `research/` rather than something inside `patches/`, because it
 * is not a change: nothing here is ever rendered or replayed. It is the
 * *evidence* for a change — the page as it was when the selector was written —
 * which is what makes drift and re-anchoring answerable at all (plan §21.2).
 */
export const PROTOTYPE_ANCHORS_DIRNAME = 'anchors'

/**
 * The directory a prototype's **reviews** live in: one dispute per file — what is
 * argued against, why, and what was decided (`reviews.ts`).
 *
 * The other half of `research/`, deliberately shaped like it. `research/` is the
 * *for* (a claim, its source, its evidence) and this is the *against*, because a
 * workbench that only records what was learned records half of the argument: an
 * objection that lives only in the conversation is gone the moment the window is
 * closed, and the person reading the prototype sees a piece of work nobody ever
 * disagreed with.
 */
export const PROTOTYPE_REVIEWS_DIRNAME = 'reviews'

/**
 * The directory a prototype's **acceptance state** lives in: the record of every
 * check, per round, so "is this newly red?" is answerable (`acceptance.ts`).
 *
 * Not in `dist/`: that directory is the deliverable and is rewritten on every
 * export, while this is our memory of what was verified before. Not in
 * `anchors/` either — anchors are about elements on a page, this is about
 * requirements. Like `anchors/`, nothing here is rendered, replayed or packaged,
 * and only the tool that runs the checks writes it.
 */
export const PROTOTYPE_ACCEPTANCE_DIRNAME = 'acceptance'

/**
 * The slot as it was first written, read for compatibility only.
 *
 * A layout written before the standard spelling would otherwise look like "a layout
 * with no slot", and the fallback for that is "use the layout as it stands" — which
 * would silently drop the page. A page that disappears is the worst failure this
 * model has, so the old spelling keeps working (the same reason old configs are
 * read as a page table, plan §19.7).
 */
export const LEGACY_PROTOTYPE_LAYOUT_SLOT = '<!-- @page -->'

/** Patch kinds supported by the replay engine. */
export type PrototypePatchKind = 'css' | 'js'

/**
 * The writer id a folded change layer is filed under (`fold.ts`), and why it
 * is a writer id rather than a new artifact kind: a consolidated file is still a
 * patch — same naming, same ownership, same replay — and the only thing that makes
 * it special is that it must replay **after** everything it folded.
 *
 * `Z` is reserved: only the control plane writes it, so any agent writer that puts
 * `Z-…` in a patch name is overstepping. Reserved-ness is a **rule** (`byReplayOrder`
 * in `storage.ts` checks it before sorting, and the write guard refuses it), never
 * an inherited alphabet: a patch's meaning may not depend on which writer ids the
 * other patches happen to use. It lives here, in the module that imports nothing,
 * because `ownership.ts` (the rules) and `storage.ts` (the order) both need it and
 * neither may import the other.
 */
export const CONSOLIDATED_WRITER = 'Z'

/**
 * The writer id a session works under when nothing declared one.
 *
 * A prototype usually has exactly one writer (the conversation), so the identity has to
 * **always exist** — otherwise every file-writing turn would first have to declare one, and
 * the common case would be the awkward one. Multi-writer work (a DAG's nodes) declares
 * `writes:` per node instead.
 */
export const PROTOTYPE_DEFAULT_WRITER = 'main'

/**
 * The writer identity a session writes as: what the graph declared for it, else the single-writer
 * default.
 *
 * One function because three callers must agree — the prompt (what the agent is told), the write
 * guard (what it is checked against), and the status/report path. A declared id wins over the
 * default; an empty/whitespace declaration is treated as none, so a blank yaml field cannot
 * silently become a writer id of `''`.
 */
export function resolvePrototypeWriter(source?: { taskWrites?: string } | null): string {
  const declared = source?.taskWrites?.trim()
  return declared && declared.length > 0 ? declared : PROTOTYPE_DEFAULT_WRITER
}

/**
 * The one grammar for a patch file's name: `{writer}-{nnn}-{name}.{css|js}`, optionally one
 * directory deep (`patches/<page>/…`). Shared by `storage.ts` (parsing) and `ownership.ts`
 * (ownership) so the two can never disagree about what a valid name is.
 *
 * The writer segment is lazy and the order segment is the anchor, which is what makes a
 * multi-hyphen writer id parse unambiguously: `research-competitors-001-report.css` splits at
 * the first `-<digits>-`, i.e. writer `research-competitors`, order `001`.
 */
export const PROTOTYPE_PATCH_NAME_RE = /^(.+?)-(\d+)-(.+?)\.(css|js)$/

/**
 * A writer id: a slug, and never something that would make a patch name ambiguous.
 *
 * The second half is what keeps the parse total: the name splits at the first `-<digits>-`, so an
 * id that **ends** in `-<digits>` could never be recovered from the name it produced
 * (`ui-2-001-x.css` reads as writer `ui`, order `2`) — the declared writer and the name would
 * silently disagree, which is exactly the failure ownership exists to prevent.
 */
export function isValidWriterId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/i.test(id) && !/-\d+(-|$)/.test(id)
}

/** Whether a name's writer segment is the reserved consolidated one. */
export function isConsolidatedWriter(id: string | null | undefined): boolean {
  return (id ?? '').toUpperCase() === CONSOLIDATED_WRITER
}

/** The parts a patch file name encodes, or null when it is not a patch name at all. */
export interface PrototypePatchName {
  writer: string
  order: number
  /** The `{name}` segment, without the extension. */
  name: string
  kind: PrototypePatchKind
}

/**
 * Parse a patch file name (not a path). Returns null when the shape is wrong **or** the writer
 * id is unusable — both mean "this file is not a patch we wrote", which the injector ignores
 * and `status` reports as misnamed.
 */
export function parsePrototypePatchName(file: string): PrototypePatchName | null {
  const match = PROTOTYPE_PATCH_NAME_RE.exec(file)
  if (!match) return null
  const writer = match[1] ?? ''
  const order = Number(match[2])
  const name = match[3] ?? ''
  const kind = (match[4] ?? '') as PrototypePatchKind
  if (!isValidWriterId(writer) || !Number.isFinite(order) || name === '') return null
  return { writer, order, name, kind }
}

/** One patch file plus the metadata derived from its name. */
export interface PrototypePatch {
  /** Path relative to the patches directory, e.g. `A-001-btn.css` or `cart/A-002.js`. */
  file: string
  /** Kind inferred from the file extension. */
  kind: PrototypePatchKind
  /**
   * The **writer identity** claimed by the name (`A-001-…` → `A`, `checkout-ui-002-…` →
   * `checkout-ui`), or null when the name does not claim one. This is the token ownership is
   * derived from — a name lease, not a work-kind label.
   */
  writer: string | null
  /** Replay order parsed from the name. */
  order: number
  /** File contents. */
  source: string
  /**
   * The selectors the patch declares it is aimed at (`@target …` in its header),
   * in declaration order, empty when it declares none (`patch-header.ts`).
   *
   * Empty and "declared these" are different facts and stay different: empty
   * means nothing can be checked about what the patch matched, which is not the
   * same as a selector that matched nothing.
   *
   * A list because a consolidated file (`fold.ts`) carries the markers of
   * everything it folded, so the anchors of the patches it replaced stay alive.
   */
  targets: string[]
  /**
   * The page this patch belongs to, or null when it belongs to the whole flow.
   *
   * Directory is ownership (plan §19.4): `patches/cart/A-001.css` is cart's,
   * `patches/A-001.css` is everyone's. Null patches replay on every page, which
   * is also what every patch written before pages had names does.
   */
  page: string | null
  /** Init-script key used when registering this patch with the browser. */
  key: string
}

/**
 * Derived index of a prototype's patches.
 *
 * Deliberately never hand-written: it is recomputed from disk on demand, so it
 * cannot drift and no writer has to coordinate on a shared single file.
 */
export interface PrototypeArtifacts {
  slug: string
  /** Absolute path to the prototype's directory. */
  dir: string
  /** Ordered patches, ready to replay. */
  patches: PrototypePatch[]
}

/**
 * Which prototype a browser window is showing, what kind of page is on screen,
 * and which page it is.
 *
 * Attached to what the agent is told about a window, because a window's own URL
 * is not enough to act on: the same address can be a page we own or someone
 * else's live page. The kind is the decisive fact —
 *
 * - **`scratch`** — the document is ours, rendered from its file with every
 *   applicable patch applied, and it is changed by editing files;
 * - **`overlay`** — the page belongs to a real site (its own JavaScript, its own
 *   session) and is only ever patched, never edited.
 *
 * `origin` is the prototype's **own** address, which is a different fact from the
 * page's URL for an overlay and the same one for a scratch page. Null when
 * nothing serves prototypes (no resolver installed).
 *
 * `page` names which of the prototype's pages is on screen (plan §18/§19) — a
 * flow has several, and "which screen am I looking at" is not answerable from the
 * URL alone once a prototype has more than one. Null when the window is on none
 * of them (taken somewhere else, or a path no page describes).
 */
export interface PrototypeWindowDescriptor {
  slug: string
  kind: PageKind | null
  origin: string | null
  page: string | null
}
