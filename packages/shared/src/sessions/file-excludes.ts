/**
 * What a session folder does not show, and what does not wake the panel.
 *
 * Two lists, because they answer different questions — the same split VS Code makes between
 * `files.exclude` (the explorer does not draw it) and `files.watcherExclude` (the explorer shows it,
 * but a change inside it is not worth re-reading the folder for):
 *
 * - **`SESSION_EXPLORER_EXCLUDES`** — the few named things nobody opens: version-control metadata
 *   and the OS's own droppings. Deliberately **not** "dotfiles": `.env` and `.gitignore` are the
 *   person's own files and are listed.
 * - **`SESSION_WATCHER_EXCLUDES`** — everything above, plus the folders that churn while nothing
 *   the person cares about has changed: `node_modules`, a VCS object store, and this app's own
 *   tool scratch (`data/.tmp`, where `script_sandbox` points TMPDIR).
 *
 * The session transcript is in the watcher list for the same reason it always was: it is appended
 * to on every message, so notifying on it would re-read the folder once per token.
 *
 * Patterns are VS Code's syntax (`**` across segments, `*` within one), matched against a path
 * relative to the session folder, with `/` separators.
 */

/** Not drawn in the file tree. Every entry is a basename rule, as VS Code's defaults are. */
export const SESSION_EXPLORER_EXCLUDES: readonly string[] = [
  '**/.git',
  '**/.svn',
  '**/.hg',
  '**/CVS',
  '**/.DS_Store',
  '**/Thumbs.db',
]

/**
 * Changes that do not re-read the folder.
 *
 * The transcript is first because it is written constantly; the rest are directories whose
 * contents are not something a person opens from this panel.
 */
export const SESSION_WATCHER_EXCLUDES: readonly string[] = [
  'session.jsonl',
  ...SESSION_EXPLORER_EXCLUDES.map((pattern) => `${pattern}/**`),
  '**/node_modules/**',
  '**/.hg/store/**',
  '**/data/.tmp/**',
]

const compiled = new Map<string, RegExp>()

/**
 * One pattern to one regular expression.
 *
 * `**` is the only wildcard that crosses a `/`: `**\/` matches zero or more whole segments, so
 * `**\/node_modules/**` matches `node_modules/x` and `a/node_modules/x/y` alike. `*` and `?` stay
 * inside one segment, which is what makes `data/.tmp/**` mean this session's scratch and not any
 * folder named `tmp`.
 */
function globToRegExp(pattern: string): RegExp {
  const cached = compiled.get(pattern)
  if (cached) return cached

  let source = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]!
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          source += '(?:[^/]+/)*' // whole segments, zero or more
          index += 2
        } else {
          source += '.*'
          index += 1
        }
      } else {
        source += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      source += '[^/]'
      continue
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }

  const regexp = new RegExp(`^${source}$`)
  compiled.set(pattern, regexp)
  return regexp
}

/** A path as the patterns spell it: relative, forward slashes, no leading `./`. */
export function normalizeRelativePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '')
}

/** Does `relativePath` match any of `patterns`? A `x/**` pattern also covers `x` itself. */
export function isExcluded(relativePath: string, patterns: readonly string[]): boolean {
  const path = normalizeRelativePath(relativePath)
  if (!path) return false

  for (const pattern of patterns) {
    if (globToRegExp(pattern).test(path)) return true
    // `**/data/.tmp/**` is about what is *inside* that folder; the folder's own creation is the
    // same event to the panel, so the pattern covers the directory name too.
    if (pattern.endsWith('/**') && globToRegExp(pattern.slice(0, -3)).test(path)) return true
  }
  return false
}
