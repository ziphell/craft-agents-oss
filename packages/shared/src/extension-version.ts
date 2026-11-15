/**
 * The version a generated browser extension is stamped with.
 *
 * An extension is built from a set of tweaks, and it has to answer one question — "which
 * build am I looking at?" — for a reviewer who reloads the extension after every change.
 *
 * Chrome's version parts are numbers, so the answer has to be numbers:
 * `1.<days since epoch>.<minutes of the day>` is monotonic within a day, readable, and
 * nowhere near the 65535-per-part limit.
 */
export function extensionVersion(builtAt: Date): string {
  const days = Math.floor(builtAt.getTime() / 86_400_000)
  const minutes = builtAt.getUTCHours() * 60 + builtAt.getUTCMinutes()
  return `1.${days}.${minutes}`
}
