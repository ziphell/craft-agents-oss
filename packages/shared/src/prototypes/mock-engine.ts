/**
 * The service mock's state machine.
 *
 * The mock used to be a lookup table: one path, one response, every time. A flow
 * needs more than that — "add to cart, then the cart screen shows the item" is the
 * smallest thing a prototype is for, and a fixture cannot express it. This module
 * is the answer to "what does the mock remember", kept **declarative**: the author
 * writes ordinary OpenAPI and says which collection a path is about, and the
 * meaning of each HTTP method follows from HTTP itself rather than from a
 * transition language this project would have to invent and teach (plan §5, D9's
 * postponed half).
 *
 * ```
 * /cart/items:
 *   x-mock-collection: cart.items
 *   get:  …            # the collection, as it is now
 *   post: …            # append the request body to it
 * /cart/items/{id}:
 *   x-mock-collection: cart.items
 *   get:  …            # the element whose `id` is the path's value
 *   patch: …           # merge the body into it
 *   delete: …          # remove it
 * ```
 *
 * Four rules hold the whole thing together:
 *
 * - **The store is ours, not the page's.** It starts from `state.json` (which the
 *   author writes) and lives in memory for as long as the mock is applied — one
 *   `prototype-mock-apply` is one run of the flow, and re-applying resets it. The
 *   mock never writes a file: that would make the deliverable depend on the order
 *   someone clicked in.
 * - **A path addresses a collection or one of its elements.** A trailing
 *   `{param}` picks the element whose field of that name equals the path's value.
 *   Nothing else is addressable — a second parameter, or a path that ends in a
 *   parameter belonging to no collection, is refused when the contract is read
 *   rather than quietly matching nothing.
 * - **A missing element is a 404**, because a mock that answers 200 for something
 *   that is not there teaches the app under test the wrong thing. An operation
 *   whose body contradicts the store (appending to an object, say) answers **500
 *   with a note saying so**: that is a bug in the mock, and it has to look like
 *   one instead of like the app failing.
 * - **A read answers what the path addresses; a change answers the collection as
 *   it now stands.** The screen that just sent an add, an edit or a removal has to
 *   draw the list next, and a mock that answered the single element there would
 *   make every such screen guess. Both are snapshots, never views into the store.
 * - **`x-mock.fixture` still decides the body when it is given.** A stateful route
 *   returns the collection by default, but an operation that answers something
 *   else (an acknowledgement, an error shape) names a fixture exactly as before.
 *
 * The same semantics run twice — here for the workbench's network-level
 * interception, and as generated javascript inside a page for the three delivered
 * carriers (`extension.ts`). Two implementations of one rule is a cost this
 * project names rather than hides; what keeps them from drifting is
 * `__tests__/mock-engine.test.ts`, which runs one case table through both.
 *
 * @see docs/prototype-workbench-plan.md §阶段 5
 */

/** What an operation does to the store, derived from its HTTP method. */
export type MockOp = 'read' | 'append' | 'merge' | 'replace' | 'remove'

/** The addressable target of a stateful path, and what its method does to it. */
export interface MockState {
  /** Dot path into the store, e.g. `cart.items`. */
  collection: string
  /**
   * The element field the path's trailing `{param}` selects on, or null when the
   * path addresses the collection itself.
   */
  select: string | null
  op: MockOp
  /**
   * True when the operation declares no `x-mock.fixture`, so the answer is the
   * collection as it now stands.
   *
   * A flag rather than "body === null", because a fixture may legitimately *be*
   * JSON `null` — the wire has to distinguish "answers with the resource" from
   * "answers with nothing", and only the author knows which they meant.
   */
  fromState: boolean
}

/**
 * A response the mock serves, derived from a contract operation's `x-mock`.
 *
 * This is a *wire* shape: it crosses into the browser client, which fulfils the
 * matching request at the network layer via CDP, and into the generated in-page
 * carrier. There is deliberately no matching regex or live state here — matching
 * stays in one place ({@link matchMockRoute}) and state stays in the store.
 */
export interface MockRoute {
  /** Upper-case HTTP method. */
  method: string
  /** URL path to match, e.g. `/orders` or `/cart/items/{id}`. */
  path: string
  /** Response status code for the operation's *success* case. */
  status: number
  /** Response body, or null for bodiless responses (204/304) and for stateful reads. */
  body: unknown
  /** Present when the path declares a collection; absent for a plain fixture route. */
  state?: MockState
}

/** Everything the mock needs to answer: what it serves, and what it starts from. */
export interface MockProgram {
  routes: MockRoute[]
  /** The starting store, merged from every service's `state.json`. */
  store: MockStore
}

/**
 * A program with nothing in it.
 *
 * A function rather than one shared constant: the store is mutated while the mock
 * runs, and a single object handed to every caller would make one prototype's flow
 * visible to another's.
 */
export function noMockProgram(): MockProgram {
  return { routes: [], store: {} }
}

/** The mock's memory: a plain JSON object, addressed by dot path. */
export type MockStore = Record<string, unknown>

/** A matched route, with the path parameters its pattern captured. */
export interface MockMatch {
  route: MockRoute
  params: Record<string, string>
}

/** What the mock answers, and whether the answer came from the state machine. */
export interface MockAnswer {
  status: number
  body: unknown
  /** True when the route was stateful, so a caller can say the flow advanced. */
  stateful: boolean
}

/**
 * Split a path into the segments of its pattern.
 *
 * `{name}` is a parameter; everything else is literal. Deliberately no wildcards,
 * no optional segments and no regex: a contract is written by hand, and a matcher
 * that accepts more than the author can predict is how "the mock matched nothing"
 * becomes unexplainable.
 */
function segments(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0)
}

/**
 * The parameter name a path *ends* with, or null.
 *
 * Only the last segment can select an element, because the element is what the
 * path addresses: `/cart/items/{id}/notes` addresses a collection that happens to
 * live under an item, and this vocabulary has no way to say that.
 */
function trailingParam(path: string): string | null {
  const parts = segments(path)
  const last = parts[parts.length - 1] ?? ''
  return /^\{[^}]+\}$/.test(last) ? last.slice(1, -1) : null
}

/** A parameter name has to be usable as a field name, or it selects nothing. */
function isUsableField(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
}

/**
 * What an operation does to `collection`, or why it cannot be expressed.
 *
 * Called when the contract is read, so an operation the vocabulary cannot express
 * is **named at review time** rather than silently matching nothing at run time —
 * the same rule the acceptance checks follow for an unsupported `check:` kind.
 */
export function describeMockOperation(
  method: string,
  path: string,
  collection: string,
): Omit<MockState, 'fromState'> | { problem: string } {
  const verb = method.toUpperCase()
  const select = trailingParam(path)
  const where = `${verb} ${path}`

  if (collection.trim().length === 0) {
    return { problem: `${where}: x-mock-collection is empty, so there is no collection to read or change.` }
  }
  if (select !== null && !isUsableField(select)) {
    return {
      problem: `${where}: the trailing parameter "{${select}}" cannot name a field of an element — use {id}, or a name made of letters, digits and underscores.`,
    }
  }

  // A parameter anywhere but at the end addresses something this vocabulary has no
  // name for, and matching it would mean matching a path longer than the pattern.
  const trail = segments(path).filter((segment) => /^\{[^}]+\}$/.test(segment))
  if (trail.length > 1 || (trail.length === 1 && select === null)) {
    return {
      problem: `${where}: only a trailing {param} is addressable — a path with {…} in the middle describes something x-mock-collection cannot select.`,
    }
  }

  const op: MockOp | null =
    verb === 'GET'
      ? 'read'
      : verb === 'POST' && select === null
        ? 'append'
        : verb === 'PATCH'
          ? 'merge'
          : verb === 'PUT'
            ? 'replace'
            : verb === 'DELETE' && select !== null
              ? 'remove'
              : null

  if (op === null) {
    return {
      problem: `${where}: a stateful ${verb} is not expressible — POST appends to a collection (no {param}), DELETE removes one element (a trailing {param}), GET reads, PATCH merges and PUT replaces. Declare \`x-mock.fixture\` instead if this operation answers with a value of its own.`,
    }
  }

  return { collection, select, op }
}

/** Read a dot path out of the store, or `undefined` when it is not there. */
export function readMockPath(store: MockStore, dotPath: string): unknown {
  let current: unknown = store
  for (const key of dotPath.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/**
 * Write a dot path into the store, creating intermediate objects.
 *
 * The store is a JSON document, so nothing here validates the *shape* of what it
 * writes: `state.json` is the author's, and a collection that turns out not to be
 * an array is answered as a mock failure (500) rather than patched over.
 */
export function writeMockPath(store: MockStore, dotPath: string, value: unknown): void {
  const keys = dotPath.split('.')
  const last = keys.pop() as string
  let current: Record<string, unknown> = store
  for (const key of keys) {
    const next = current[key]
    if (next === null || typeof next !== 'object') current[key] = {}
    current = current[key] as Record<string, unknown>
  }
  current[last] = value
}

/**
 * Build the matching regex for a route path.
 *
 * One compiled pattern per call is fine — the route table is small and the
 * alternative (a cache keyed by path) is state that has to be reset.
 */
function patternFor(path: string): RegExp {
  const parts = segments(path).map((segment) =>
    /^\{[^}]+\}$/.test(segment) ? '([^/]+)' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  )
  // Anchored at both ends: a prefix match would make `/cart` answer `/cart/items`.
  return new RegExp(`^/${parts.join('/')}/?$`)
}

/**
 * The route answering this request, or null.
 *
 * Matching is by **pathname**, exactly like the fixture-only version: a route
 * declared as `/cart/items` answers that path on whatever host the page calls,
 * which is what lets one contract serve a prototype in several environments.
 *
 * A path may also be reached **behind a prefix** — an app calling
 * `https://api.example.com/v1/orders` for a contract whose `baseUrl` is
 * `/v1` — so a route whose full path does not match is tried again against that
 * many trailing segments. The tolerance is bounded by the route's own length: a
 * one-segment route can match at the end of any path, which is the point, and a
 * four-segment route can never swallow a shorter one.
 */
export function matchMockRoute(
  routes: MockRoute[],
  method: string,
  pathname: string,
): MockMatch | null {
  const verb = method.toUpperCase()

  for (const route of routes) {
    if (route.method.toUpperCase() !== verb) continue

    const pattern = patternFor(route.path)
    const parts = segments(route.path)
    let match = pattern.exec(pathname)

    if (!match) {
      const tail = `/${segments(pathname).slice(-parts.length).join('/')}`
      if (tail === pathname || segments(pathname).length <= parts.length) continue
      match = pattern.exec(tail)
      if (!match) continue
    }

    const params: Record<string, string> = {}
    const names = parts
      .map((segment) => (/^\{[^}]+\}$/.test(segment) ? segment.slice(1, -1) : null))
      .filter((name): name is string => name !== null)
    names.forEach((name, index) => {
      const value = match[index + 1]
      if (value !== undefined) params[name] = decodeURIComponent(value)
    })

    return { route, params }
  }

  return null
}

/**
 * Answer one request: the state machine, and nothing else.
 *
 * Kept free of the wire, the page and the store's lifetime so the two carriers can
 * share one description of what happens (see the module comment). `body` is the
 * already-parsed request body, or null when there is none.
 */
export function applyMockRequest(input: {
  store: MockStore
  route: MockRoute
  params: Record<string, string>
  body: unknown
}): MockAnswer {
  const { store, route, params, body } = input

  // A plain fixture route: the table lookup the mock always was.
  if (!route.state) return { status: route.status, body: route.body, stateful: false }

  const { collection, select, op, fromState } = route.state
  const current = readMockPath(store, collection)

  /** The element this path addresses, and whether it is there. */
  const element = (): { found: boolean; index: number; value: unknown } => {
    if (select === null) return { found: current !== undefined, index: -1, value: current }
    if (!Array.isArray(current)) return { found: false, index: -1, value: undefined }
    const wanted = params[select]
    const index = current.findIndex(
      (item) => item !== null && typeof item === 'object' && (item as Record<string, unknown>)[select] === wanted,
    )
    return index === -1
      ? { found: false, index: -1, value: undefined }
      : { found: true, index, value: current[index] }
  }

  const failure = (note: string): MockAnswer => ({
    status: 500,
    body: { error: note },
    stateful: true,
  })

  /** A copy of a live value: an answer is a snapshot, never a window into the store. */
  const snapshot = (value: unknown): unknown =>
    value === undefined ? undefined : JSON.parse(JSON.stringify(value))
  const fromStore = (): unknown => snapshot(readMockPath(store, collection))

  /**
   * The answer to a **read**: what the path addresses — the element, or the
   * collection when the path is the collection itself.
   */
  const answerRead = (): MockAnswer => ({
    status: route.status,
    body: fromState ? (select === null ? fromStore() : snapshot(element().value)) : route.body,
    stateful: true,
  })

  /**
   * The answer to a **change**: the collection as it now stands, because that is
   * what the screen that made the request has to draw next. An add, a removal and
   * an edit all end with "here is the list", which is also why a bodiless
   * response is not the default here — `x-mock.status` is how an author asks for
   * one.
   *
   * A named fixture wins over all of it, so an operation that answers something
   * else than the resource keeps the fixture-only form it always had (an
   * acknowledgement, an error shape) — and a fixture that *is* JSON null can say
   * so, which is why the choice is carried as a flag rather than inferred.
   */
  const answerWrite = (): MockAnswer => ({
    status: route.status,
    body: fromState ? fromStore() : route.body,
    stateful: true,
  })

  if (op === 'read') {
    const target = element()
    if (!target.found) return { status: 404, body: null, stateful: true }
    return answerRead()
  }

  if (op === 'append') {
    if (current === undefined) writeMockPath(store, collection, [])
    const list = readMockPath(store, collection)
    if (!Array.isArray(list)) {
      return failure(`mock state: "${collection}" is not a list, so nothing can be appended to it.`)
    }
    list.push(body)
    return answerWrite()
  }

  if (op === 'merge') {
    const target = element()
    if (!target.found) return { status: 404, body: null, stateful: true }
    if (body === null || typeof body !== 'object') {
      return failure(`mock state: ${route.method} ${route.path} has no JSON object body to merge.`)
    }
    const merged = { ...(typeof target.value === 'object' && target.value !== null ? target.value : {}), ...(body as object) }
    if (select === null) writeMockPath(store, collection, merged)
    else {
      const list = current as unknown[]
      list[target.index] = merged
    }
    return answerWrite()
  }

  if (op === 'replace') {
    const target = element()
    if (!target.found) return { status: 404, body: null, stateful: true }
    if (select === null) writeMockPath(store, collection, body)
    else (current as unknown[])[target.index] = body
    return answerWrite()
  }

  // remove
  const target = element()
  if (!target.found) return { status: 404, body: null, stateful: true }
  ;(current as unknown[]).splice(target.index, 1)
  return answerWrite()
}

/**
 * The request body as a value the store can hold, and whether it could be read.
 *
 * `readable: false` is a real answer and not an error path for the caller to
 * swallow: a `POST` that cannot be read changes nothing, and a mock that silently
 * appended `null` would look like the app's own bug. The in-page carrier reports
 * the same fact for a blob or a stream body, which is why the distinction is here
 * rather than inline in the CDP handler.
 */
export function parseMockRequestBody(postData: string | null | undefined): {
  body: unknown
  readable: boolean
} {
  if (postData === null || postData === undefined || postData.length === 0) {
    return { body: null, readable: true }
  }

  try {
    return { body: JSON.parse(postData), readable: true }
  } catch {
    // Form encodings are the other thing a page sends, and they are a list of
    // fields rather than a failure.
    if (/^[^=&]+=[^=&]*(&[^=&]+=[^=&]*)*$/.test(postData)) {
      const body: Record<string, string> = {}
      for (const pair of postData.split('&')) {
        const [key, value = ''] = pair.split('=')
        if (key) body[decodeURIComponent(key)] = decodeURIComponent(value.replace(/\+/g, ' '))
      }
      return { body, readable: true }
    }
    return { body: null, readable: false }
  }
}

/**
 * Merge every service's `state.json` into the one store the mock runs against.
 *
 * One store rather than one per service, because a collection is named by a dot
 * path in a path item and nothing there says which service it belongs to — a
 * prefix would be a rule the author did not write. Two services naming the same
 * top-level key is therefore a **conflict**, reported rather than resolved
 * silently: which of the two a route reads is not something to guess at.
 */
export function mergeMockStores(seeds: Array<{ service: string; store: unknown }>): {
  store: MockStore
  conflicts: string[]
} {
  const store: MockStore = {}
  const owner = new Map<string, string>()
  const conflicts: string[] = []

  for (const seed of seeds) {
    if (seed.store === null || typeof seed.store !== 'object' || Array.isArray(seed.store)) continue
    for (const [key, value] of Object.entries(seed.store as Record<string, unknown>)) {
      const previous = owner.get(key)
      if (previous !== undefined) {
        conflicts.push(`"${key}" is declared by both service "${previous}" and service "${seed.service}"`)
        continue
      }
      owner.set(key, seed.service)
      store[key] = value
    }
  }

  return { store, conflicts }
}
