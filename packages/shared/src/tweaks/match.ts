/**
 * Which pages a tweak is for: Chrome match patterns, parsed and evaluated here.
 *
 * The grammar is Chrome's (`<scheme>://<host><path>`), because one of the two carriers a
 * tweak can be delivered in is a loadable extension and `content_scripts` takes exactly
 * that form — see the note in `./types.ts`. It is small enough to implement honestly,
 * and implementing it is the only way the app can answer "does this tweak apply to the
 * page in front of me?" without a browser's help:
 *
 *   scheme  `*` (http or https) · `http` · `https`
 *   host    `*` (any) · `*.example.com` (that domain and its subdomains) · `app.example.com`
 *   path    `/admin/*` — `*` is the only wildcard, and it spans `/`
 *
 * Matching a pattern is deliberately **not** "is this string like that one": so much of
 * the grammar is anchored at both ends — the path must match in full, and only a
 * trailing `*` may run past its end. `/admin/*` therefore covers `/admin/users` and
 * `/admin/`, but not `/admin`. That distinction looks pedantic until a tweak for an admin
 * console starts running on `/administrate`. (The companion `matchPatternForUrl` in
 * `prototypes/extension.ts` leaves a `*` on the end for the same reason.)
 */

/** A parsed pattern. Absent pieces are the wildcards the grammar spells `*`. */
interface ParsedPattern {
  scheme: '*' | 'http' | 'https';
  /** Null means "any host". */
  host: string | null;
  /** True when the host is `*.example.com` — that domain *and* its subdomains. */
  subdomains: boolean;
  path: string;
}

/**
 * The grammar, as one expression: scheme, host, path.
 *
 * The host is a name — letters, digits, dots, hyphens — so a **port cannot be written**
 * here, exactly as in Chrome's own patterns (a pattern matches its host on any port).
 * Requiring the path (it starts at the first `/`) is what makes `https://example.com`
 * alone invalid: a tweak is scoped to pages, and a bare origin does not say which.
 */
const MATCH_PATTERN_RE =
  /^(\*|https?):\/\/(\*|\*\.[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)(\/.*)$/

/**
 * Read a pattern, or null when it is not one.
 *
 * Null rather than a throw, because both callers have something better to say than
 * "invalid": the storage layer refuses the write and names the pattern, and the matcher
 * treats an unparsable pattern as matching nothing.
 */
export function parseMatchPattern(pattern: string): ParsedPattern | null {
  const trimmed = pattern.trim()
  // A pattern is one token. Whitespace means this is prose, or two patterns typed on one
  // line — either way it is not a pattern, and guessing which half was meant is worse
  // than saying so.
  if (trimmed === '' || /\s/.test(trimmed)) return null;

  const match = MATCH_PATTERN_RE.exec(trimmed);
  if (!match) return null;

  const [, scheme, host, path] = match;
  if (!scheme || !host || path === undefined) return null;

  // A `*` path is the whole of the path grammar; it has to be at the end, because only
  // a trailing wildcard is what the grammar lets run past the pattern.
  const wildcards = path.split('*').length - 1;
  if (wildcards > 1 || (wildcards === 1 && !path.endsWith('*'))) return null;

  return {
    scheme: scheme as ParsedPattern['scheme'],
    host: host === '*' ? null : host.replace(/^\*\./, ''),
    subdomains: host.startsWith('*.'),
    path,
  };
}

/** Is this a pattern a tweak may declare? */
export function isValidMatchPattern(pattern: string): boolean {
  return parseMatchPattern(pattern) !== null;
}

/**
 * Why a pattern is not one, in words a person can act on — the write path's error.
 */
export function whyMatchPatternIsInvalid(pattern: string): string | null {
  if (parseMatchPattern(pattern)) return null;
  return (
    `"${pattern}" is not a match pattern. A tweak is scoped with Chrome's own grammar: ` +
    `a scheme (\`*\`, \`http\` or \`https\`), then \`://\`, then a host (\`*\`, \`*.example.com\` or \`app.example.com\`), ` +
    `then a path (\`/admin/*\`) — e.g. \`*://*.example.com/admin/*\`. A \`*\` may only be last in the path.`
  );
}

function schemeMatches(pattern: ParsedPattern['scheme'], url: URL): boolean {
  if (pattern === '*') return url.protocol === 'http:' || url.protocol === 'https:';
  return url.protocol === `${pattern}:`;
}

function hostMatches(pattern: ParsedPattern, hostname: string): boolean {
  if (pattern.host === null) return true;
  if (hostname === pattern.host) return true;
  return pattern.subdomains && hostname.endsWith(`.${pattern.host}`);
}

function pathMatches(path: string, pathname: string): boolean {
  // Chrome's anchoring, exactly: the pattern must match the whole path, and only a
  // trailing `*` may run past its end. So `/admin/*` covers `/admin/users` and
  // `/admin/`, but **not** `/admin` — the pattern has that slash in it. Reading the
  // wildcard more generously here would mean a tweak fires in the app and not in an
  // extension built from the same file, which is the one thing this grammar is for.
  if (!path.endsWith('*')) return pathname === path;
  return pathname.startsWith(path.slice(0, -1));
}

/**
 * Does this tweak apply to this address?
 *
 * A pattern that cannot be read applies to nothing — the same answer a pattern with a
 * typo should give, and the reason the write path refuses one in the first place.
 */
export function matchPatternMatches(pattern: string, url: string): boolean {
  const parsed = parseMatchPattern(pattern);
  if (!parsed) return false;

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }

  return (
    schemeMatches(parsed.scheme, target) &&
    hostMatches(parsed, target.hostname) &&
    pathMatches(parsed.path, target.pathname)
  );
}

/** Do any of a tweak's patterns apply to this address? */
export function anyMatchPatternMatches(patterns: readonly string[], url: string): boolean {
  return patterns.some((pattern) => matchPatternMatches(pattern, url));
}
