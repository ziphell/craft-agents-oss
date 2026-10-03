import { DOC_REFS } from '../docs/index.ts'
import type { SessionMode } from '../sessions/types.ts'

/**
 * The work block — what a conversation is told when it is working in one of the
 * "thinking it through" modes.
 *
 * It is injected **only when the person says so**: a session carries a `mode` (one stage
 * at a time, or none), and a project being worked on is not the same thing as a project
 * being written specifications for. A project whose conversations are ordinary work gets
 * none of this.
 *
 * The folder is the whole of the answer to "where do these files live": each layer is a
 * file, and the project's own folder is where those files are. Nothing here names a second
 * place to look, and nothing here asks the agent to remember anything — the report it may
 * be asked for is read off the disk, every time.
 *
 * One mode is rendered at a time: `goal`, `spec` and `plan` are stages of the same work,
 * never switches that sit on together, so only the current one is ever injected.
 *
 * The rules are stated as rules rather than as an explanation of the machinery: this text
 * is read by a model, not by the person using the app.
 */

/**
 * What the block needs: which layer, and the folder the files live in.
 *
 * Deliberately not the whole project — the name, the assets and the memory are already in
 * `<project_context>`, and a second copy of them here would be the same facts said twice.
 */
export interface ModePromptContext {
  /** Which layer this conversation is working in. */
  mode: SessionMode
  /** Absolute path to the project's folder — where this mode's files live. */
  folderPath: string
}

/**
 * Escape a value written into the block's attribute.
 *
 * The path is chosen by the app rather than typed into the conversation, but it can still
 * carry a quote or a stray tag — a workspace folder may be named anything — and a path that
 * closed the element early would put the rest of the path in the prompt as instructions.
 */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * The parts that differ between modes: what this layer is about, what one file of it looks
 * like, the line it must not cross, and what has to be read before writing.
 *
 * `handoff` is only present where the layer ends and another system takes over.
 */
interface ModeWording {
  /** One sentence: what this layer is managing. */
  intro: string
  /** One sentence: the file convention (fixed name or suffix). */
  artifact: string
  /** The boundary — what this layer must not write. */
  boundary: string
  /** What must be read before writing. */
  readBefore: string
  /** Where the thinking ends and the doing is handed off (plan only). */
  handoff?: string
  /**
   * What answering "what is missing" also means in this layer (plan only).
   *
   * Only a plan is written *to cover* another artifact, so only a plan can be set against one.
   * It is a reading of two files, asked for by the person — not a record, not a count, and
   * nothing is written down: the answer belongs in the conversation, where a person reads it.
   */
  whenAsked?: string
}

const MODE_WORDING: Record<SessionMode, ModeWording> = {
  goal: {
    intro: 'This conversation is settling the project\'s goal: why it exists and what it is for.',
    artifact:
      'The goal is one file, `goal.md`, at the root of this folder — a project keeps one goal, and it is a fixed name rather than a suffix.',
    boundary:
      'Write the goal and nothing past it: do not write how any of it is to be done, and do not write the detail of any single piece of it — detail belongs in a specification.',
    readBefore:
      'Before writing, read what the project already says about itself: its name, its description and its details.',
  },
  spec: {
    intro:
      'This conversation is writing a specification: what is needed, said so that a person can read it.',
    artifact:
      'A specification is one `*.spec.md` file in that folder — at its root or in a subfolder. A spec\'s path, relative to the folder, is its identity, and a link from one document to another is ordinary markdown. Files that share a stem are one piece of work, so the stem is how the files of one piece are grouped.',
    boundary:
      'Write what is needed, not how it is built: no tech stack, no APIs, no code structure — a spec is read by the people who asked for the work, not by the people who build it. Where something is not settled, say so; never guess. And record nowhere what implements a spec: that is a second description of the work, and it goes stale the moment a file changes.',
    readBefore:
      'Before writing, read the `*.spec.md` files already in the folder, and `goal.md` if there is one — a spec is written to fit the goal and the specs around it.',
  },
  plan: {
    intro:
      'This conversation is working out a plan: how one piece of the specification gets built.',
    artifact:
      'A plan is one `*.plan.md` file in that folder — at its root or in a subfolder. Files that share a stem are one piece of work: `cart.spec.md` and `cart.plan.md` are the two layers of the same thing, so the stem is the grouping key.',
    boundary:
      'Write the steps, not the requirements: do not change what the specification asks for. If the intent itself needs to change, go back and change the `*.spec.md` it is written in.',
    readBefore:
      'Before writing, read the `*.spec.md` with the same stem — a plan is written for one piece of the specification and must not drift from it — and `goal.md` if there is one.',
    handoff:
      'A plan is where the thinking ends: once the steps are settled, hand this `*.plan.md` file itself to the task generator, which reads it and turns the steps it states into nodes — it does not re-invent a decomposition. This family adds no `*.tasks.md` file.',
    whenAsked:
      '- "What is missing" here does not stop at the folder: set what the `*.spec.md` with the same\n  stem asks for against the steps in this plan, and say which of it has no step. Read both files\n  then — and leave the answer in the conversation: do not write it down, do not give it a\n  number, and never record which plan implements which specification.',
  },
}

export function formatModeContextForPrompt(ctx: ModePromptContext): string {
  const wording = MODE_WORDING[ctx.mode]

  // The rules that hold in every layer. Kept as bullets so a layer can add one in the right
  // place — what "what is missing" means beyond the folder belongs next to the folder answer.
  const commonRules = [
    `- When the person asks what is missing, read that folder and answer from what is there: which
  files exist, what sits beside them, and which links point at a file that is not there. Read it
  again each time — never answer from memory, and never from what an earlier turn said.`,
    ...(wording.whenAsked ? [wording.whenAsked] : []),
    `- Leave the person's files where they are. Do not move, rename or delete them; saying that one is
  in the wrong place is fine.`,
    `- The longer form of these rules is in ${DOC_REFS.layers}. Read it before the first file of a
  session.`,
  ]

  const parts = [
    wording.intro,
    'This folder is where the thinking is written down — the goal, the specifications and the plans are all files in it, and it is not the working directory.',
    wording.artifact,
    wording.boundary,
    wording.readBefore,
    ...(wording.handoff ? [wording.handoff] : []),
    commonRules.join('\n'),
  ]

  return `<work mode="${ctx.mode}" folder="${escapeAttr(ctx.folderPath)}">
${parts.join('\n\n')}
</work>`
}
