import { describe, expect, it } from 'bun:test'
import { OFFICE_DOMAINS } from './office-domains.ts'
import { TOOL_DESCRIPTIONS } from './tool-defs.ts'

/**
 * A tool description is paid for by **every session**, whether or not the tool is used: it sits in
 * the model's instructions from the first turn. That is why it stays a brief for its door, and the
 * detail lives in the guide the tool blocks on until it has been read — read once, and only by the
 * sessions that do the work.
 *
 * The document tools were one door at ~1,460 tokens, most of it a second copy of that guide. They are
 * five doors now, and the ceiling below is what keeps each of them from growing back into a manual.
 */
const BUDGETS: Record<string, number> = {
  docx_tool: 500,
  xlsx_tool: 500,
  pptx_tool: 550,
  pdf_tool: 450,
  convert_tool: 400,
  drawio_tool: 750,
  // `media_tool` is the account door: generation and tasks. The brief is a verb index
  // (the flag detail lives in `media_tool --help`).
  media_tool: 900,
  // `asr_tool` reads a recording into words, routed by the person's setting.
  asr_tool: 500,
  // `recording_tool` is the local decoder: probe and frames, no account and no model.
  recording_tool: 450,
  // `reel_tool` is a timeline door. The op list and document shape live in `reel_tool help`,
  // read once and only by sessions that cut; the brief stays an index.
  reel_tool: 300,
}

/** Words-and-symbols, ×1.33 — the same estimate the repo uses when it talks about prompt cost. */
function estimateTokens(text: string): number {
  return Math.round(text.split(/\s+/).filter(Boolean).length * 1.33)
}

describe('tool description budgets', () => {
  for (const [name, budget] of Object.entries(BUDGETS)) {
    it(`${name} stays a brief (≤ ${budget} tokens)`, () => {
      const description = (TOOL_DESCRIPTIONS as Record<string, string>)[name]
      expect(description).toBeDefined()
      expect(estimateTokens(description!)).toBeLessThanOrEqual(budget)
    })
  }

  it('every document door names its own commands, so the brief is also the index', () => {
    for (const door of OFFICE_DOMAINS) {
      const brief = (TOOL_DESCRIPTIONS as Record<string, string>)[door.toolName] as string
      expect(brief).toBeDefined()
      for (const command of door.commands) {
        // A door that cannot name a command it answers is a door a model will not find the command in.
        expect(brief).toContain(`\`${command}`)
      }
    }
  })

  it('a format-specific command belongs to exactly one door', () => {
    /** Verbs every format has, answered per door for its own files — that is what the split is for. */
    const EVERY_FORMAT = new Set(['create', 'read', 'apply', 'check', 'render', 'merge'])
    const seen = new Map<string, string>()
    for (const door of OFFICE_DOMAINS) {
      for (const command of door.commands) {
        if (EVERY_FORMAT.has(command)) continue
        const owner = seen.get(command)
        // Two doors answering one format-specific command is the ambiguity the split removes.
        expect(owner).toBeUndefined()
        seen.set(command, door.toolName)
      }
    }
  })
})
