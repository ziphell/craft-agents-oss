/**
 * Spec naming — the one zero-dependency module of the spec family.
 *
 * A spec lives in a **project folder** — `{workspaceRootPath}/projects/{slug}/` — a folder of
 * ordinary files: its specification (markdown — a `spec.md`, and any other document that states
 * specs) and whatever else the author keeps beside it. Nothing here is a container — the
 * folder is the project, and the files in it are what the workbench reads.
 *
 * **This module imports nothing, on purpose.** It is the one part of the
 * spec family that a *renderer* can take a value from: the adjacent modules
 * reach `workspaces/storage.ts` → `config/storage.ts`, which lazy-imports the
 * agent runtime (`../agent/session-scoped-tools.ts`) and through it the Claude
 * Agent SDK — a node-only dependency that cannot be bundled for the browser. A
 * barrel import from the panel dragged all of that into the renderer build; a
 * plain constant from here cannot.
 */

/**
 * The conventional entry document's file name — the index the detail page reads the specification
 * through.
 *
 * Here, with the directory names, rather than in `spec-docs.ts` where it was born: the renderer
 * needs the value, and a value import from any other module of this family drags the barrel behind
 * it into the renderer build (see the header). It is the **index** and not a spec: its name
 * ends in `.md`, not `.spec.md`, so it states nothing on its own.
 */
export const SPEC_ENTRY_FILENAME = 'spec.md'

/**
 * The suffix a spec document's name ends with — `<name>.spec.md`.
 *
 * A spec is **one file**, and the file's name is its identity: there is no id to keep in
 * sync, and the suffix is what tells a spec apart from the material beside it. Here, beside
 * the entry's name, because the reader (`spec-docs.ts`, `layers.ts`) and anything that writes a
 * spec must agree on the one spelling — a file one half treats as a spec and the
 * other as material is a spec nothing can link to.
 */
export const SPEC_SUFFIX = '.spec.md'

/**
 * The **goal** document's file name — `goal.md`.
 *
 * A project keeps **one** goal, so it is a fixed name rather than a suffix, and it lives at the
 * folder's root: a `docs/goal.md` is a document like any other, not the project's goal. Here,
 * beside the entry's name and the spec suffix, because the reader (`layers.ts`) and anything
 * that writes a goal must agree on the one spelling.
 */
export const GOAL_FILENAME = 'goal.md'

/**
 * The suffix a **plan** document's name ends with — `<name>.plan.md`.
 *
 * A plan is **one file**, and the file's name is its identity, exactly as a spec's is: the
 * suffix is what tells a plan apart from the material beside it. Files that share a stem are one
 * piece of work — `cart.spec.md` and `cart.plan.md` are the two layers of the same thing — so the
 * spelling here is what lets a reader pair them.
 */
export const PLAN_SUFFIX = '.plan.md'

/**
 * Whether a file is the **entry** — `spec.md`.
 *
 * The reader (`layers.ts`) and the panel both have to answer this, and they have to answer it
 * the same way: the entry is the specification's first row whether or not it states anything, and it
 * is therefore not one of "the rest of the folder" either.
 *
 * Matched without case against the whole relative name, so it is the file at the project's root:
 * a filesystem that cannot tell `spec.md` from `Spec.md` should not hide the index over a capital
 * letter, and a `docs/spec.md` the author filed away is a document like any other.
 */
export function isSpecEntryFile(name: string): boolean {
  return name.toLowerCase() === SPEC_ENTRY_FILENAME.toLowerCase()
}

/**
 * Whether a file **states a spec** — a `*.spec.md` file.
 *
 * One file is one spec, and the file's name is its identity, so this predicate is the whole
 * rule: the reader turns each matching file into a spec (`spec-docs.ts`), and the report
 * keeps those files out of "the rest of the folder" (`layers.ts`). Both sides read it here for
 * the reason `isSpecEntryFile` is here: one judgement, or a spec and its file drift apart.
 *
 * Matched without case against the whole relative name, so a `cart-total.spec.md` in a subfolder is
 * one too — the suffix is the rule, not the file's depth, and a capital letter must not make a
 * spec invisible.
 */
export function isSpecFile(name: string): boolean {
  return name.toLowerCase().endsWith(SPEC_SUFFIX)
}

/**
 * Whether a file is the project's **goal** — `goal.md`, at the folder's root.
 *
 * Matched without case against the whole relative name, so it is the file at the project's root:
 * a `docs/goal.md` the author filed away is a document like any other, and a capital letter must
 * not hide the one goal.
 */
export function isGoalFile(name: string): boolean {
  return name.toLowerCase() === GOAL_FILENAME.toLowerCase()
}

/**
 * Whether a file **states a plan** — a `*.plan.md` file.
 *
 * Matched without case against the whole relative name, so a `cart.plan.md` in a subfolder is one
 * too — the suffix is the rule, not the file's depth. A plan and a spec that share a stem are the
 * two layers of one piece of work, and this predicate is what tells the plan half.
 */
export function isPlanFile(name: string): boolean {
  return name.toLowerCase().endsWith(PLAN_SUFFIX)
}
