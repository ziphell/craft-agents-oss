/**
 * The mock's state machine, and the one place its two implementations are held together.
 *
 * The workbench intercepts at the network layer and answers from TypeScript
 * (`mock-engine.ts`); a delivered carrier can only intercept inside the page, and
 * answers from generated javascript (`extension.ts` `buildMockEngineScript`). One
 * rule, two runtimes — so the flow below is run through **both** and the two
 * answers are compared step by step. A change to either implementation that the
 * other does not follow fails here rather than in someone's prototype.
 *
 * The rest is the contract side of the same story: what a path item has to say
 * (`x-mock-collection`), what `state.json` starts as, and which operations this
 * vocabulary refuses to express.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  applyMockRequest,
  buildMockRoutes,
  describeMockOperation,
  getContractServicePath,
  getContractStatePath,
  loadContractService,
  matchMockRoute,
  mergeMockStores,
  parseContractFragment,
  type ContractService,
  type MockProgram,
} from '..'
import { buildMockEngineScript } from '../extension'

/** A cart service: a collection, its elements, and the document they share. */
const CART_FRAGMENT = `paths:
  /api/cart:
    x-mock-collection: cart
    get:
      x-mock:
        status: 200
      responses:
        '200': { description: The cart }
    patch:
      x-mock:
        status: 200
      responses:
        '200': { description: The cart }
  /api/cart/items:
    x-mock-collection: cart.items
    get:
      x-mock:
        status: 200
      responses:
        '200': { description: The items }
    post:
      x-mock:
        status: 201
      responses:
        '201': { description: Added }
  /api/cart/items/{id}:
    x-mock-collection: cart.items
    get:
      x-mock:
        status: 200
      responses:
        '200': { description: One item }
    patch:
      x-mock:
        status: 200
      responses:
        '200': { description: Edited }
    put:
      x-mock:
        status: 200
      responses:
        '200': { description: Replaced }
    delete:
      x-mock:
        status: 200
      responses:
        '200': { description: Removed }
  /api/orders:
    get:
      x-mock:
        status: 200
        fixture: list-orders-200
      responses:
        '200': { description: Orders }
`

/** The store the service starts from — also what a fresh program must start from. */
const CART_START = {
  cart: { currency: 'CNY', items: [{ id: 'i-1', name: 'Coffee' }] },
}

/** The same fragment as a loaded service, with the store it starts from. */
function cartService(overrides: Partial<ContractService> = {}): ContractService {
  return {
    slug: 'cart-api',
    dir: '/tmp/cart-api',
    fragments: [parseContractFragment('cart.yaml', CART_FRAGMENT)],
    fixtures: { 'list-orders-200': { orders: [{ id: 'ord-1' }] } },
    brokenFixtures: [],
    state: JSON.parse(JSON.stringify(CART_START)),
    brokenState: null,
    config: null,
    ...overrides,
  }
}

/** The program the workbench would apply for that service. */
function cartProgram(store: unknown = cartService().state): MockProgram {
  return { routes: buildMockRoutes(cartService()).routes, store: JSON.parse(JSON.stringify(store)) }
}

// ---------------------------------------------------------------------------
// The contract side: what a path item declares
// ---------------------------------------------------------------------------

describe('mock state in a contract', () => {
  it('derives the operation from the method, and the element from a trailing {param}', () => {
    const endpoints = buildMockRoutes(cartService()).routes
    const byKey = new Map(endpoints.map((route) => [`${route.method} ${route.path}`, route]))

    // A collection: read all, append one, merge into it.
    expect(byKey.get('GET /api/cart')?.state).toEqual({
      collection: 'cart',
      select: null,
      op: 'read',
      fromState: true,
    })
    expect(byKey.get('PATCH /api/cart')?.state).toMatchObject({ op: 'merge', select: null })
    expect(byKey.get('POST /api/cart/items')?.state).toMatchObject({ op: 'append', select: null })

    // One element: the path's `{id}` selects on the element's own `id`.
    expect(byKey.get('GET /api/cart/items/{id}')?.state).toMatchObject({ op: 'read', select: 'id' })
    expect(byKey.get('DELETE /api/cart/items/{id}')?.state).toMatchObject({ op: 'remove', select: 'id' })

    // A path with no collection is the fixture route it always was.
    expect(byKey.get('GET /api/orders')?.state).toBeUndefined()
    expect(byKey.get('GET /api/orders')?.body).toEqual({ orders: [{ id: 'ord-1' }] })
  })

  /**
   * An operation the vocabulary cannot express is refused **when the contract is
   * read**, not mocked into something that looks plausible: a route that is not in
   * the table reads exactly like a request that reached the real backend.
   */
  it('names an operation it cannot express instead of building a route for it', () => {
    const awkward = `paths:
  /api/cart/items:
    x-mock-collection: cart.items
    delete:
      x-mock:
        status: 204
      responses:
        '204': { description: Gone }
  /api/cart/items/{id}:
    x-mock-collection: cart.items
    post:
      x-mock:
        status: 201
      responses:
        '201': { description: No }
`
    const result = buildMockRoutes(cartService({ fragments: [parseContractFragment('awkward.yaml', awkward)] }))

    expect(result.routes).toHaveLength(0)
    expect(result.stateIssues).toHaveLength(2)
    expect(result.stateIssues[0]).toContain('DELETE /api/cart/items: a stateful DELETE is not expressible')
    expect(result.stateIssues[1]).toContain('POST /api/cart/items/{id}: a stateful POST is not expressible')
  })

  it('refuses a parameter in the middle of a path', () => {
    const described = describeMockOperation('GET', '/api/cart/items/{id}/notes', 'cart.items')

    expect(described).toHaveProperty('problem')
    expect((described as { problem: string }).problem).toContain('only a trailing {param} is addressable')
  })

  it('refuses an empty collection name', () => {
    expect(describeMockOperation('GET', '/api/cart', '   ')).toHaveProperty('problem')
  })

  /** A fixture still decides the body, which is how an operation answers something else. */
  it('keeps a declared fixture as the answer, and says so on the wire', () => {
    const withFixture = `paths:
  /api/cart/items:
    x-mock-collection: cart.items
    post:
      x-mock:
        status: 201
        fixture: added-ack
      responses:
        '201': { description: Added }
`
    const routes = buildMockRoutes(
      cartService({
        fragments: [parseContractFragment('ack.yaml', withFixture)],
        fixtures: { 'added-ack': { ok: true } },
      }),
    ).routes

    expect(routes[0]?.state?.fromState).toBe(false)
    expect(routes[0]?.body).toEqual({ ok: true })
  })
})

describe('mock state on disk', () => {
  const slug = 'checkout-flow'
  let workspaceRoot = ''

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-mock-state-'))
    mkdirSync(getContractServicePath(workspaceRoot, slug, 'cart-api'), { recursive: true })
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('reads state.json as the store the routes start from', () => {
    writeFileSync(getContractStatePath(workspaceRoot, slug, 'cart-api'), '{"cart": {"items": []}}', 'utf-8')

    const service = loadContractService(workspaceRoot, slug, 'cart-api')

    expect(service.state).toEqual({ cart: { items: [] } })
    expect(service.brokenState).toBeNull()
  })

  /**
   * A file that is there but unusable is reported, not silently treated as absent:
   * a stateful route reading an empty store looks exactly like a flow that does not
   * work, and which of the two it is has to be answerable.
   */
  it('reports a state.json it cannot use', () => {
    writeFileSync(getContractStatePath(workspaceRoot, slug, 'cart-api'), '[1, 2]', 'utf-8')

    const service = loadContractService(workspaceRoot, slug, 'cart-api')

    expect(service.state).toBeNull()
    expect(service.brokenState).toContain('has to be a JSON object')
    expect(buildMockRoutes(service).stateProblem).toContain('has to be a JSON object')
  })

  it('merges services, and names a collection two of them both declare', () => {
    const merged = mergeMockStores([
      { service: 'cart-api', store: { cart: { items: [] }, orders: [] } },
      { service: 'pricing-api', store: { orders: [], rates: {} } },
    ])

    // The first service keeps the key; the second one's claim is reported rather
    // than winning silently.
    expect(merged.store).toEqual({ cart: { items: [] }, orders: [], rates: {} })
    expect(merged.conflicts).toHaveLength(1)
    expect(merged.conflicts[0]).toContain('"orders" is declared by both service "cart-api" and service "pricing-api"')
  })
})

// ---------------------------------------------------------------------------
// The flow, through both implementations
// ---------------------------------------------------------------------------

/** One request in the flow under test. */
type Step = [method: string, pathname: string, body: unknown]

/**
 * A whole flow, in order, because state is only meaningful as a sequence: the
 * point of the feature is that the second screen sees what the first one did.
 */
const FLOW: Step[] = [
  ['GET', '/api/cart', null],
  ['POST', '/api/cart/items', { id: 'i-2', name: 'Tea' }],
  ['GET', '/api/cart', null],
  ['PATCH', '/api/cart', { currency: 'EUR' }],
  ['GET', '/api/cart/items/i-2', null],
  ['DELETE', '/api/cart/items/i-1', null],
  ['GET', '/api/cart/items/i-1', null],
  ['PUT', '/api/cart/items/i-2', { id: 'i-2' }],
  ['GET', '/api/orders', null],
  ['GET', '/api/nowhere', null],
  ['POST', '/api/nowhere', { x: 1 }],
  // Behind a `baseUrl` prefix: the same route, reached on a longer path.
  ['GET', '/v1/api/cart/items/i-2', null],
  ['GET', '/api/cart/items/i-2/extra', null],
]

interface Answer {
  status: number
  body: unknown
}

/** The workbench's answers: the TypeScript engine over a fresh store. */
function workbenchAnswers(program: MockProgram): Array<Answer | null> {
  return FLOW.map(([method, pathname, body]) => {
    const matched = matchMockRoute(program.routes, method, pathname)
    if (!matched) return null
    const answer = applyMockRequest({ store: program.store, route: matched.route, params: matched.params, body })
    return { status: answer.status, body: answer.body }
  })
}

/** The page's answers: the generated engine, run the way a page runs it. */
function pageAnswers(program: MockProgram): Array<Answer | null> {
  const engine = new Function(`${buildMockEngineScript(program)}\nreturn __craft_mock;`)() as {
    matchRoute: (method: string, pathname: string) => unknown
    answer: (matched: unknown, body: unknown) => Answer
  }

  return FLOW.map(([method, pathname, body]) => {
    const matched = engine.matchRoute(method, pathname)
    if (!matched) return null
    const answer = engine.answer(matched, body)
    return { status: answer.status, body: answer.body }
  })
}

describe('the mock flow', () => {
  it('holds the flow together: what a request changed, the next one sees', () => {
    const program = cartProgram()
    const answers = workbenchAnswers(program)

    // The cart as it starts, then the items list as the POST left it — a change
    // answers the collection its path addresses, which is what the next screen draws.
    expect(answers[0]).toEqual({
      status: 200,
      body: { currency: 'CNY', items: [{ id: 'i-1', name: 'Coffee' }] },
    })
    expect(answers[1]).toEqual({
      status: 201,
      body: [{ id: 'i-1', name: 'Coffee' }, { id: 'i-2', name: 'Tea' }],
    })
    // …and the cart the screen asks for next shows the same two items.
    expect(answers[2]).toEqual({
      status: 200,
      body: { currency: 'CNY', items: [{ id: 'i-1', name: 'Coffee' }, { id: 'i-2', name: 'Tea' }] },
    })

    // A merge changes one field and keeps the rest.
    expect(answers[3]).toEqual({
      status: 200,
      body: { currency: 'EUR', items: [{ id: 'i-1', name: 'Coffee' }, { id: 'i-2', name: 'Tea' }] },
    })

    // A read answers what the path addresses: the element, not the list.
    expect(answers[4]).toEqual({ status: 200, body: { id: 'i-2', name: 'Tea' } })
    expect(answers[5]).toEqual({ status: 200, body: [{ id: 'i-2', name: 'Tea' }] })
    expect(answers[6]).toEqual({ status: 404, body: null })

    // PUT replaces the element with exactly what was sent.
    expect(answers[7]).toEqual({ status: 200, body: [{ id: 'i-2' }] })

    // A fixture route is still a fixture route, and an unmatched path is not ours.
    expect(answers[8]).toEqual({ status: 200, body: { orders: [{ id: 'ord-1' }] } })
    expect(answers[9]).toBeNull()
    expect(answers[10]).toBeNull()

    // A path behind a `baseUrl` prefix reaches the same route …
    expect(answers[11]).toEqual({ status: 200, body: { id: 'i-2' } })
    // … while a longer path is not that route: the tolerance is bounded by the
    // route's own length, so nothing matches by accident.
    expect(answers[12]).toBeNull()
  })

  /**
   * The two runtimes, one table. This is the assertion that keeps the delivered
   * mock from behaving differently from the one the prototype was built against.
   */
  it('answers identically in the workbench and inside a page', () => {
    expect(pageAnswers(cartProgram())).toEqual(workbenchAnswers(cartProgram()))
  })

  /**
   * Every program starts from its own copy: the store is mutated as the flow runs,
   * and one shared object would let one prototype's clicks show up in another's.
   */
  it('gives every program its own copy of the starting store', () => {
    const first = cartProgram()
    const second = cartProgram()
    workbenchAnswers(first)

    expect(first.store).not.toEqual(CART_START)
    expect(second.store).toEqual(CART_START)
  })

  /**
   * A mock that answers 200 for something that is not there would teach the app
   * under test the wrong thing; one whose store contradicts the contract is a bug
   * in the mock itself, and has to look like one.
   */
  it('answers 500 when its own store is the wrong shape, and 404 when the element is gone', () => {
    const program = cartProgram({ cart: { items: { id: 'not-a-list' } } })
    const answers = workbenchAnswers(program)

    expect(answers[0]).toEqual({ status: 200, body: { items: { id: 'not-a-list' } } })
    expect(answers[1]?.status).toBe(500)
    expect(answers[1]?.body).toHaveProperty('error')
    expect(pageAnswers(cartProgram({ cart: { items: { id: 'not-a-list' } } }))).toEqual(answers)
  })

  it('reads nothing into a path it does not declare', () => {
    const program = cartProgram()
    // The pattern is anchored: `/api/cart` answering `/api/cart/items` would make
    // every collection route shadow its own element routes.
    expect(matchMockRoute(program.routes, 'GET', '/api/cart/items')).not.toBeNull()
    expect(matchMockRoute(program.routes, 'GET', '/api/cart')).not.toBeNull()
    expect(matchMockRoute(program.routes, 'GET', '/api/cart/items/i-1/extra')).toBeNull()
    expect(matchMockRoute(program.routes, 'POST', '/api/cart')).toBeNull()
  })
})
