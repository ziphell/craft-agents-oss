/**
 * Do two spellings name the same file?
 *
 * The host's write announcement carries the absolute path it wrote; a view compares it with the path
 * it was given. On Windows those can differ in case or in separators (`C:\Users\…` vs
 * `C:/Users/…`), and a mismatch would mean a preview never notices its own file changing.
 *
 * Deliberately conservative: no symlink resolution, no `realpath` — an extra stat per event costs
 * more than the false positive it would prevent.
 */
export function sameFilePath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return normalize(a) === normalize(b)
}
