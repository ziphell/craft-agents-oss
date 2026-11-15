/**
 * The html element index and its patchers, moved to `@craft-agent/shared/html/source-edits`.
 *
 * Not a UI concern: the same offsets let the visual editor change one element *and* let `html_tool` report what a page
 * is made of. One copy, in the package both sides can import.
 */
export * from '@craft-agent/shared/html/source-edits'
