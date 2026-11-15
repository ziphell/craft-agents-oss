/**
 * The block model, moved to `@craft-agent/shared/markdown/blocks`.
 *
 * It is not a UI concern: the same offsets decide what the editor may touch *and* what `markdown_tool` reports when
 * an agent asks what a file is made of. One copy, in the package both sides can import.
 */
export * from '@craft-agent/shared/markdown/blocks'
