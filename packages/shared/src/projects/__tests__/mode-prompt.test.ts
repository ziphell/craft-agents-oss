import { describe, expect, it } from 'bun:test'
import { formatModeContextForPrompt, type ModePromptContext } from '..'

/** A context with nothing interesting in it apart from what a test sets. */
function makeContext(overrides: Partial<ModePromptContext> = {}): ModePromptContext {
  return {
    mode: 'spec',
    folderPath: '/tmp/projects/checkout-flow',
    ...overrides,
  }
}

describe('formatModeContextForPrompt', () => {
  // The folder is the whole of the answer to "where do these files live", so the block
  // has to carry the path it was handed and name the mode it was rendered for.
  it('names the mode and the folder', () => {
    const text = formatModeContextForPrompt(makeContext({ mode: 'spec', folderPath: '/work/projects/checkout-flow' }))

    expect(text).toContain('mode="spec"')
    expect(text).toContain('folder="/work/projects/checkout-flow"')
  })

  // Each mode has its own file convention, and only the current one is injected.
  it('states the file convention of the mode it was given', () => {
    expect(formatModeContextForPrompt(makeContext({ mode: 'goal' }))).toContain('`goal.md`')
    expect(formatModeContextForPrompt(makeContext({ mode: 'spec' }))).toContain('`*.spec.md`')
    expect(formatModeContextForPrompt(makeContext({ mode: 'plan' }))).toContain('`*.plan.md`')
  })

  // The plan is the last layer of thinking — the block says this very file is handed to the
  // task generator, which turns the steps it states into nodes rather than inventing a
  // decomposition, so a reader never invents a `*.tasks.md` layer of its own.
  it('hands the plan file itself to the task generator', () => {
    const text = formatModeContextForPrompt(makeContext({ mode: 'plan' }))

    expect(text).toContain('hand this `*.plan.md` file itself to the task generator')
    expect(text).toContain('turns the steps it states into nodes')
    expect(text).toContain('does not re-invent a decomposition')
    expect(text).toContain('`*.tasks.md`')
  })

  // Only a plan is written *to cover* another artifact, so only a plan can be set against one:
  // when the person asks what is missing, it also reads the spec with the same stem and says
  // which of it has no step. It stays a reading of two files — nothing is written down, nothing
  // is counted, and it never becomes a record of which plan implements which specification.
  it('sets the plan against its specification only when the person asks what is missing', () => {
    const plan = formatModeContextForPrompt(makeContext({ mode: 'plan' }))

    expect(plan).toContain('asks for against the steps in this plan')
    expect(plan).toContain('say which of it has no step')
    expect(plan).toContain('never record which plan implements which specification')
    expect(plan).toContain('do not give it a')

    expect(formatModeContextForPrompt(makeContext({ mode: 'spec' }))).not.toContain(
      'against the steps in this plan',
    )
    expect(formatModeContextForPrompt(makeContext({ mode: 'goal' }))).not.toContain(
      'against the steps in this plan',
    )
  })

  // The path is chosen by the app rather than typed by the person, but a workspace folder
  // can be named anything. A quote or a stray tag must not close the element early and spill
  // the rest of the path into the prompt as instructions — so it is escaped, and the only
  // `</work>` in the output is the element's own closing tag.
  it('escapes quotes and tag characters so the block cannot be closed early', () => {
    const text = formatModeContextForPrompt(makeContext({ folderPath: '/work/a"b</work>c' }))

    expect(text).toContain('&quot;')
    expect(text).toContain('&lt;/work&gt;')
    expect(text.match(/<\/work>/g)).toHaveLength(1)
  })
})
