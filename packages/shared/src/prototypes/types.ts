/**
 * Prototype workbench artifact types.
 *
 * A prototype lives at `{workspaceRootPath}/prototypes/{slug}/` and is a folder
 * of ordinary files: its specification (markdown — a `spec.md`, and any other document that states
 * specs) and whatever else the author keeps beside it. Nothing here is a container — the
 * folder is the prototype, and the files in it are what the workbench reads.
 *
 * **This module imports nothing, on purpose.** It is the one part of the
 * prototypes family that a *renderer* can take a value from: the adjacent modules
 * reach `workspaces/storage.ts` → `config/storage.ts`, which lazy-imports the
 * agent runtime (`../agent/session-scoped-tools.ts`) and through it the Claude
 * Agent SDK — a node-only dependency that cannot be bundled for the browser. A
 * barrel import from the panel dragged all of that into the renderer build; a
 * plain constant from here cannot.
 */

/**
 * The conventional entry document's file name — what `create` seeds, and the index the detail page
 * reads the specification through.
 *
 * Here, with the directory names, rather than in `spec.ts` where it was born: the renderer
 * needs the value, and a value import from any other module of this family drags the barrel behind
 * it into the renderer build (see the header). It is the **index** and not a spec: its name
 * ends in `.md`, not `.spec.md`, so it states nothing on its own.
 */
export const PROTOTYPE_ENTRY_FILENAME = 'spec.md'

/**
 * The suffix a spec document's name ends with — `<name>.spec.md`.
 *
 * A spec is **one file**, and the file's name is its identity: there is no id to keep in
 * sync, and the suffix is what tells a spec apart from the material beside it. Here, beside
 * the entry's name, because the reader (`spec.ts`, `status.ts`) and anything that writes a
 * spec must agree on the one spelling — a file one half treats as a spec and the
 * other as material is a spec nothing can link to.
 */
export const PROTOTYPE_SPEC_SUFFIX = '.spec.md'

/**
 * Whether a prototype file is the **entry** — `spec.md`.
 *
 * The reader (`status.ts`) and the panel both have to answer this, and they have to answer it the
 * same way: the entry is the specification's first row whether or not it states anything, and it is
 * therefore not one of "the rest of the folder" either.
 *
 * Matched without case against the whole relative name, so it is the file at the prototype's root:
 * a filesystem that cannot tell `spec.md` from `Spec.md` should not hide the index over a capital
 * letter, and a `docs/spec.md` the author filed away is a document like any other.
 */
export function isPrototypeEntryFile(name: string): boolean {
  return name.toLowerCase() === PROTOTYPE_ENTRY_FILENAME.toLowerCase()
}

/**
 * Whether a prototype file **states a spec** — a `*.spec.md` file.
 *
 * One file is one spec, and the file's name is its identity, so this predicate is the whole
 * rule: the reader turns each matching file into a spec (`spec.ts`), and the report
 * keeps those files out of "the rest of the folder" (`status.ts`). Both sides read it here for the
 * reason `isPrototypeEntryFile` is here: one judgement, or a spec and its file drift apart.
 *
 * Matched without case against the whole relative name, so a `cart-total.spec.md` in a subfolder is
 * one too — the suffix is the rule, not the file's depth, and a capital letter must not make a
 * spec invisible.
 */
export function isSpecFile(name: string): boolean {
  return name.toLowerCase().endsWith(PROTOTYPE_SPEC_SUFFIX)
}
