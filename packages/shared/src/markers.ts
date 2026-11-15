/**
 * Markers: the `@word …` lines a change or a rule writes into its own source.
 *
 * Not a configuration language — the whole of it is "a line that says something about
 * the file it is in", which is what a person reading the file already does by hand:
 *
 *   /* @target .pay-btn *\/
 *   .pay-btn { border-radius: 8px; }
 *
 * What this module owns is the two edges every marker shares, because both are subtle
 * enough that a second copy would come to disagree:
 *
 * - **a marker is not part of a word**: `not-a-@target-marker` is prose, and reading a
 *   selector out of it would invent one;
 * - **a marker is usually inside a comment**, so the terminator of that comment (the
 *   star and slash that close it, or an HTML arrow) is on the line and is not the value.
 *
 * What each marker *means* — where a target is aimed, which pages a rule is for — belongs
 * to whoever declares it, not here.
 */

/**
 * The index of the first `marker` on the line that is a marker and not part of a word.
 * `-1` when the line has none.
 */
export function markerIndex(line: string, marker: string): number {
  let from = 0
  for (;;) {
    const index = line.indexOf(marker, from)
    if (index === -1) return -1
    const before = index === 0 ? '' : (line[index - 1] ?? '')
    if (!/[\w-]/.test(before)) return index
    from = index + 1
  }
}

/**
 * Strip what surrounds a marker's value: the comment terminator it was written inside,
 * a leading separator (`@target: .x` / `@target = .x`), and quotes someone wrapped it in.
 */
export function cleanMarkerValue(raw: string): string {
  let value = raw
  for (const terminator of ['*/', '-->', '#}', '--}}']) {
    const cut = value.indexOf(terminator)
    if (cut !== -1) value = value.slice(0, cut)
  }
  value = value.trim().replace(/^[:=]\s*/, '').trim()
  if (
    (value.startsWith('`') && value.endsWith('`')) ||
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1).trim()
  }
  return value
}
