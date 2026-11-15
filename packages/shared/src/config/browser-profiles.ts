/**
 * Browser profiles.
 *
 * A profile is a Chromium session — cookies, `localStorage`, caches, logins — named once and shared
 * by whoever points at it. That is what makes two accounts of the same site possible: two profiles
 * are two cookie jars, and neither can see the other's session.
 *
 * The app always has a `default` profile, and its partition is the bare `persist:browser-pane` —
 * where every login lived before profiles existed. An install that upgrades therefore keeps its
 * sessions instead of signing out, and "sharing" is the resting state rather than something to opt
 * into.
 *
 * Which profile a conversation works in follows the same chain the model picker uses: the
 * conversation's own pick, then its project's default, then the workspace's default, then the
 * built-in one.
 */

export const DEFAULT_BROWSER_PROFILE_ID = 'default'

/** One profile, as `config.json` stores it and the picker lists it. */
export interface BrowserProfile {
  /** Opaque id; it names a Chromium partition and nothing else reads it. */
  id: string
  /** What the picker shows. Never empty — it falls back to the id. */
  name: string
  createdAt: number
}

export const DEFAULT_BROWSER_PROFILE: BrowserProfile = {
  id: DEFAULT_BROWSER_PROFILE_ID,
  name: 'Default',
  // Before any profile a user can create: it is not "created", it was always there.
  createdAt: 0,
}

/**
 * The profiles a config declares, with the built-in one always present and always first.
 *
 * Stored entries are cleaned rather than trusted — an id is what a partition is named after, so an
 * empty one or a duplicate is dropped instead of becoming a second view of the same jar.
 */
export function normalizeBrowserProfiles(profiles: BrowserProfile[] | undefined): BrowserProfile[] {
  const seen = new Set<string>()
  const kept: BrowserProfile[] = []

  for (const profile of profiles ?? []) {
    const id = typeof profile?.id === 'string' ? profile.id.trim() : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    kept.push({
      id,
      name: typeof profile.name === 'string' && profile.name.trim() ? profile.name.trim() : id,
      createdAt: typeof profile.createdAt === 'number' ? profile.createdAt : 0,
    })
  }

  const builtIn = kept.find((profile) => profile.id === DEFAULT_BROWSER_PROFILE_ID)
  return [
    builtIn ?? { ...DEFAULT_BROWSER_PROFILE },
    ...kept.filter((profile) => profile.id !== DEFAULT_BROWSER_PROFILE_ID),
  ]
}

/** A new profile id. Opaque on purpose: only the partition name ever reads it. */
export function generateBrowserProfileId(): string {
  return `bp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * The profile a command's `--profile` names, by **id or display name**.
 *
 * Both spellings are in front of the person: the id is what `profiles` prints and the name is
 * what they call the profile, so `--profile Work` and `--profile bp-…` are the same request.
 * Matching is trimmed and case-insensitive — a command line is typed, not picked from a list —
 * and a name carried by two profiles resolves to nothing rather than to a guess.
 */
export function resolveBrowserProfileRef(
  ref: string,
  profiles: BrowserProfile[],
): BrowserProfile | undefined {
  const wanted = ref.trim().toLowerCase()
  if (!wanted) return undefined

  const byId = profiles.filter((profile) => profile.id.toLowerCase() === wanted)
  if (byId.length === 1) return byId[0]

  const byName = profiles.filter((profile) => profile.name.toLowerCase() === wanted)
  return byName.length === 1 ? byName[0] : undefined
}
