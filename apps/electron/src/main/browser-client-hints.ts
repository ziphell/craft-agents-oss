/**
 * The low-entropy client hints a Chromium browser sends on its own.
 *
 * Chromium announces itself to every secure origin with three request headers — `Sec-CH-UA`,
 * `Sec-CH-UA-Mobile`, `Sec-CH-UA-Platform` — and sites increasingly read those instead of parsing
 * the (by now heavily reduced) user-agent string. A browser that never announces itself is the
 * odd one out, which is the kind of thing that makes a site behave strangely.
 *
 * This build does not send them. A tab's user agent is overridden so that it does not say
 * Electron (`attachTab` in `browser-pane-manager.ts`), and the override takes the hints with it:
 * the page's own `navigator.userAgentData` still reports the engine, but no request carries the
 * headers (`spike/anti-bot-fingerprint.ts` round 4 measures the absence over HTTPS).
 *
 * So they are put back by hand, with **the engine's own values** — the same brand list
 * `navigator.userAgentData` reports, and nothing invented. In particular there is no "Google
 * Chrome" brand: this is Chromium, and claiming to be Chrome would only leave the headers
 * disagreeing with the page they arrive beside.
 *
 * Low-entropy only. The high-entropy hints (`Sec-CH-UA-Full-Version-List`,
 * `…-Platform-Version`, `…-Arch`, `…-Bitness`, `…-Model`) are sent **after an origin asks** with
 * `Accept-CH`, and nothing here knows who asked — sending those would announce more than the
 * browser does.
 */

/** What the running engine is, in the two facts a low-entropy brand list needs. */
export interface ClientHintIdentity {
  /** Chromium's major version — what a brand list carries (`v="142"`, not the full version). */
  chromiumMajor: string
  /** `process.platform` of the host. */
  platform: string
}

/** The running engine's identity, or `null` where there is no Chromium version to name. */
export function currentClientHintIdentity(): ClientHintIdentity | null {
  const chrome = process.versions?.chrome
  if (!chrome) return null
  return { chromiumMajor: chrome.split('.')[0], platform: process.platform }
}

/** The one `Sec-CH-UA-Platform` token Chromium uses per host OS, or `null` for one it does not name. */
function platformToken(platform: string): string | null {
  switch (platform) {
    case 'win32':
      return '"Windows"'
    case 'darwin':
      return '"macOS"'
    case 'linux':
      return '"Linux"'
    default:
      return null
  }
}

/**
 * Whether client hints reach this URL at all.
 *
 * Chromium sends them only in a secure context: HTTPS, and the loopback origins (`localhost`,
 * `127.0.0.1`, `[::1]`) it treats as one. Plain `http://` gets none, so adding them there would be
 * as much of a giveaway as leaving them off everywhere else.
 */
function isSecureContext(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol === 'https:') return true
  if (parsed.protocol !== 'http:') return false
  const host = parsed.hostname
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost')
}

/**
 * Add the low-entropy hints to a request's headers, in place.
 *
 * A no-op when the engine already sent them: if a future Electron stops dropping them, its own
 * values are the right ones and there is nothing to add. The check is by prefix rather than by one
 * spelling, so a header that arrived in any casing is not duplicated.
 */
export function applyLowEntropyClientHints(
  headers: Record<string, string>,
  url: string,
  identity: ClientHintIdentity,
): void {
  if (Object.keys(headers).some((key) => key.toLowerCase().startsWith('sec-ch-ua'))) return
  if (!isSecureContext(url)) return

  const platform = platformToken(identity.platform)
  if (!platform) return

  // GREASE first, then the engine — the order `navigator.userAgentData.brands` lists them in.
  // The GREASE brand is Chromium's deliberately-unknown entry (servers must ignore it); its
  // spelling is what this engine reports, so the header and the page agree.
  headers['Sec-CH-UA'] = `"Not_A Brand";v="99", "Chromium";v="${identity.chromiumMajor}"`
  headers['Sec-CH-UA-Mobile'] = '?0'
  headers['Sec-CH-UA-Platform'] = platform
}
