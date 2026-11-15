/**
 * One occurrence of a piece of text replaced, or a reason why not.
 *
 * The rule an anchored edit stands on: **a change that could mean two places is not a change**, and a change whose
 * text is gone was written against a version that no longer exists. Both are answered with a sentence the caller can
 * act on, never by editing the nearest thing that looks similar.
 *
 * A file written on Windows is retried with its own line endings before refusing: `\n` in a caller's `--expect` is
 * not a claim about the file's bytes, and an agent that reads a document as `\n`-separated text should still be able
 * to name a paragraph the file stores with `\r\n`. The replacement's newlines are converted to match, so an edit
 * cannot put a lone `\n` into a CRLF file.
 *
 * The order of the two attempts matters for what the caller is told. A needle that appears **twice** in the file it
 * was given is refused as ambiguous without retrying — another line ending cannot make two matches into one. Only
 * "not there at all" is worth retrying, and if the retry then finds it twice, *that* is the answer.
 *
 * Two callers, one implementation: `markdown_tool edit` and `html_tool edit`. They disagree about nothing here, and a
 * CRLF rule that drifted between them would be a difference nobody could see until somebody's file was rewritten.
 */

export type ReplaceOutcome = { text: string } | { problem: string }

type Lookup = { kind: 'found'; at: number } | { kind: 'ambiguous' } | { kind: 'missing' }

const AMBIGUOUS = 'that text appears more than once in the file'
const MISSING = 'that text is not in the file'

function find(source: string, target: string): Lookup {
  const at = source.indexOf(target)
  if (at < 0) return { kind: 'missing' }
  if (source.indexOf(target, at + target.length) >= 0) return { kind: 'ambiguous' }
  return { kind: 'found', at }
}

function swap(source: string, at: number, target: string, withText: string): string {
  return source.slice(0, at) + withText + source.slice(at + target.length)
}

export function replaceOnce(haystack: string, needle: string, replacement: string): ReplaceOutcome {
  if (!needle) return { problem: 'there is no text to look for' }

  const direct = find(haystack, needle)
  if (direct.kind === 'found') return { text: swap(haystack, direct.at, needle, replacement) }
  // Ambiguous is an answer, not a reason to try again with different newlines.
  if (direct.kind === 'ambiguous') return { problem: AMBIGUOUS }

  // A file written on Windows, edited with `\n` in mind: try its own line endings before refusing.
  if (haystack.includes('\r\n')) {
    const asCrlf = needle.replace(/\n/g, '\r\n')
    const crlf = find(haystack, asCrlf)
    if (crlf.kind === 'found') {
      return { text: swap(haystack, crlf.at, asCrlf, replacement.replace(/\n/g, '\r\n')) }
    }
    if (crlf.kind === 'ambiguous') return { problem: AMBIGUOUS }
  }

  return { problem: MISSING }
}
