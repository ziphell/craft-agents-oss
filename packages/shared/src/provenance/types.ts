/**
 * What made this file.
 *
 * The note lives **beside the file it describes** — `canvas/assets/x.png` and
 * `canvas/assets/x.gen.json` — rather than in an index. A folder that is copied, zipped or opened
 * by something other than this app still carries its own history, and there is no second list that
 * can disagree with what is on disk.
 *
 * Paths are the project's own (`canvas/assets/x.png`), never absolute: a project folder that moves
 * keeps meaning the same thing. Relative paths are written the way they are joined (`/`), whatever
 * the platform.
 */
export interface GenerationRecord {
  /** The file this note is about, project-relative. */
  file: string
  /** What was asked for, as it was sent. */
  prompt: string
  /** What the run was built from — project-relative, in the order it was sent. */
  references: string[]
  /** A picture used as the first frame, when the run was built that way. */
  firstFrame?: string
  /** A picture used as the last frame, when the run was built that way. */
  lastFrame?: string
  /** The account that made it, by the name a person sees. */
  channel?: string
  model?: string
  params?: Record<string, string | number>
  /** The conversation that asked, when one did. A panel generation has none. */
  session?: string
  /** When the file was written, epoch ms. It is what the timeline is ordered by. */
  at: number
}
