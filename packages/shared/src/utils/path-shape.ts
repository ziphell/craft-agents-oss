/**
 * What a path **looks like**, decided from the string alone.
 *
 * Its own module, with no imports, because this is the one path question the renderer asks: the
 * same string comparisons run in the main process and in a sandboxed page, and a sandboxed page has
 * neither `process` nor Node's `path`/`os`/`fs`. `utils/paths` answers "where does the app keep its
 * files", which is a main-process question and carries those imports with it — pulling it into the
 * renderer to lowercase a drive letter is how a build ends up externalizing `fs`.
 */

/**
 * Whether a path is written the way Windows writes one.
 *
 * Decided **from the path**, not from the host: `process.platform` does not exist in a sandboxed
 * renderer, and reading it there is the `process is not defined` that once took the whole preview
 * panel down. A path always says which spelling it is — a drive letter, or a UNC share.
 */
export function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}
