/**
 * Prototype workbench artifact types.
 *
 * A prototype lives at `{workspaceRootPath}/prototypes/{slug}/` and is a folder
 * of ordinary files: its specification (markdown — a `PRD.md`, and any other document that states
 * requirements) and whatever else the author keeps beside it. Nothing here is a container — the
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
 * The directory a prototype's **findings** live in — what was learned about
 * someone else's product, with the source and the evidence for it.
 *
 * Here, next to the other directory names that several modules have to agree on,
 * because the distinction it draws is a rule rather than a preference: `assets/`
 * is a file the prototype itself loads, while `research/` is how the author got
 * to the requirements and is therefore not an implementation of them.
 */
export const PROTOTYPE_RESEARCH_DIRNAME = 'research'

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
 * The conventional entry document's file name — what `create` seeds, and the index the detail page
 * reads the specification through.
 *
 * Here, with the directory names, rather than in `requirements.ts` where it was born: the renderer
 * needs the value, and a value import from any other module of this family drags the barrel behind
 * it into the renderer build (see the header). It says nothing about where requirements live — an
 * author who splits the specification into `docs/features.md` and `docs/personas.md` has simply
 * organized their work, and every one of those files is read the same way.
 */
export const PROTOTYPE_PRD_FILENAME = 'PRD.md'
