/**
 * Is this page a security challenge, or just a thin page?
 *
 * The judgement is here rather than inline in the pane manager because it is the one thing in
 * browser automation that can refuse to show an agent the page it asked for, and refusing has to
 * be worth it. `snapshot` and `navigate` both act on the answer: they let go of the tab and tell
 * the agent to ask a person to complete a verification — so a wrong "yes" is not a warning, it is
 * a stopped command.
 *
 * What went wrong without this module: a sparse accessibility tree (`<= 2` actionable nodes,
 * `ax:near-empty`) counted as a detection **on its own**, with `provider: 'unknown'`. example.com,
 * a news article, a single-input sign-in page — all of them read as "Security verification
 * detected (unknown)". Measured across this workspace's sessions: 16 detections, every one of them
 * near-empty alone (`0/22` included — twenty-two nodes, none actionable: a paragraph), and no
 * Cloudflare page among them.
 *
 * The rule now: a shape is not evidence. An empty-ish tree is a **corroborating** signal, reported
 * next to a real one and never instead of one.
 */

/** What the page and its accessibility tree said, before any judgement. */
export interface ChallengeEvidence {
  /** The tab's title — a challenge page names itself there. */
  title: string
  /** The tab's logical address. */
  url: string
  /** Signals read out of the document itself (`text:…`, `dom:…`, see `detectSecurityChallenge`). */
  domSignals: string[]
  /** Size of the accessibility tree, and how many of its nodes a person could act on. */
  nodeCount: number
  actionableCount: number
}

export interface ChallengeVerdict {
  detected: boolean
  /** Which service it is, when it is one this app can name. `none` when `detected` is false. */
  provider: 'cloudflare' | 'unknown' | 'none'
  /** Everything that spoke, for a reply that has to say why it stopped. */
  signals: string[]
}

/** A tree this thin is worth mentioning, never worth acting on by itself. */
const NEAR_EMPTY_ACTIONS = 2

/**
 * The verdict, from evidence alone.
 *
 * Deliberately no side effects and no I/O: this is the decision the tool layer is judged on, and
 * it is the one part of challenge detection that can be tested without a window.
 */
export function readChallengeVerdict(evidence: ChallengeEvidence): ChallengeVerdict {
  const signals: string[] = []

  // -- What the tab says about itself ------------------------------------------------------
  if (/^Just a moment/i.test(evidence.title)) signals.push('title:just-a-moment')
  if (evidence.url.includes('/cdn-cgi/challenge-platform/')) signals.push('url:cdn-cgi-challenge')

  // -- What the document says --------------------------------------------------------------
  for (const signal of evidence.domSignals) {
    if (!signals.includes(signal)) signals.push(signal)
  }

  // -- What the shape says: corroboration only ---------------------------------------------
  //
  // Read after the two groups above, and kept out of the verdict on its own: an article, a canvas
  // app and a single-field search page all have this shape, and telling their readers to go solve
  // a captcha is worse than saying nothing.
  const nearEmpty = evidence.nodeCount > 0 && evidence.actionableCount <= NEAR_EMPTY_ACTIONS
  const detected = signals.length > 0
  if (detected && nearEmpty) signals.push(`ax:near-empty(${evidence.actionableCount}/${evidence.nodeCount})`)

  if (!detected) return { detected: false, provider: 'none', signals }

  const isCloudflare = signals.some(
    (signal) => signal.includes('cf-') || signal.includes('challenge') || signal.includes('turnstile') || signal === 'title:just-a-moment',
  )

  return { detected: true, provider: isCloudflare ? 'cloudflare' : 'unknown', signals }
}
