/**
 * Where a note sits, and how two paths are spelled so they can be compared.
 *
 * Pure string work: the view needs it, and the view is not allowed to touch a filesystem.
 */

/** A note is its file's name with the extension swapped for this. `x.png` → `x.gen.json`. */
export const RECORD_SUFFIX = '.gen.json'

/** Forward slashes, no leading `./` — one spelling per file, so two records always compare. */
export function toPosix(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
}

/** The note's place: the artifact's own folder, its stem plus `RECORD_SUFFIX`. */
export function recordPathFor(filePath: string): string {
  const cut = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  const folder = filePath.slice(0, cut + 1)
  const name = filePath.slice(cut + 1)
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  return `${folder}${stem}${RECORD_SUFFIX}`
}

/** A record's path turned back into the file path the caller asked for. */
export function joinProjectPath(projectDir: string, relativePath: string): string {
  const base = projectDir.replace(/[\\/]+$/, '')
  return `${base}/${toPosix(relativePath)}`
}
