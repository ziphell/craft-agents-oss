/**
 * Provenance — what a file was made from, and what was made from it.
 *
 * One note per generated file, written beside it (`x.png` → `x.gen.json`), and the lineage read
 * back off those notes. This barrel is the pure half; `@craft-agent/shared/provenance/storage` is
 * the half that touches disk and is for the host, not the view.
 */

export * from './types.ts'
export * from './paths.ts'
export * from './graph.ts'
