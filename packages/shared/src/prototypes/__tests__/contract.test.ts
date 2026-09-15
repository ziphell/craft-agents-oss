import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  buildContractDoc,
  buildMockRoutes,
  composeContract,
  exportContractDeliverable,
  getComposedContractPath,
  getContractFixturesPath,
  getContractPathsPath,
  getContractServicePath,
  getPrototypeDistPath,
  getPrototypeServicesPath,
  listContractServices,
  loadContractService,
  parseContractFragment,
  resolveContractServiceSlug,
  writeComposedContract,
} from '..'

const FRAGMENT = `paths:
  /orders:
    get:
      summary: List orders
      x-mock:
        status: 200
        fixture: list-orders-200
      responses:
        '200':
          description: OK
        '500':
          description: Boom
components:
  schemas:
    Order:
      type: object
`

describe('parseContractFragment', () => {
  it('reads a paths: block plus components.schemas', () => {
    const fragment = parseContractFragment('list-orders.yaml', FRAGMENT)

    expect(Object.keys(fragment.paths)).toEqual(['/orders'])
    expect(Object.keys(fragment.schemas)).toEqual(['Order'])
  })

  it('also accepts top-level /path keys (the terse form)', () => {
    const fragment = parseContractFragment('terse.yaml', '/health:\n  get:\n    responses:\n      \'200\':\n        description: OK\n')

    expect(Object.keys(fragment.paths)).toEqual(['/health'])
  })

  it('captures an x-contract notes block', () => {
    const fragment = parseContractFragment('notes.yaml', `${FRAGMENT}x-contract:\n  pagination: cursor based\n`)

    expect(fragment.contract).toEqual({ pagination: 'cursor based' })
  })

  it('rejects invalid YAML with the fragment name', () => {
    expect(() => parseContractFragment('broken.yaml', 'paths: [unclosed')).toThrow(/broken\.yaml/)
  })
})

describe('contract service discovery', () => {
  const slug = 'checkout-flow'
  let workspaceRoot = ''
  let servicesPath = ''

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-contract-'))
    servicesPath = getPrototypeServicesPath(workspaceRoot, slug)
    mkdirSync(servicesPath, { recursive: true })
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('lists services in a deterministic order and ignores dotted directories', () => {
    mkdirSync(join(servicesPath, 'billing'), { recursive: true })
    mkdirSync(join(servicesPath, 'checkout-api'), { recursive: true })
    mkdirSync(join(servicesPath, '.hidden'), { recursive: true })

    expect(listContractServices(workspaceRoot, slug)).toEqual(['billing', 'checkout-api'])
    expect(listContractServices(workspaceRoot, 'no-such-project')).toEqual([])
  })

  it('resolves an explicit service, a single service, and refuses ambiguity', () => {
    mkdirSync(join(servicesPath, 'only'), { recursive: true })
    expect(resolveContractServiceSlug(workspaceRoot, slug)).toBe('only')
    expect(resolveContractServiceSlug(workspaceRoot, slug, 'only')).toBe('only')

    mkdirSync(join(servicesPath, 'second'), { recursive: true })
    expect(() => resolveContractServiceSlug(workspaceRoot, slug)).toThrow(/Multiple services/)
    expect(() => resolveContractServiceSlug(workspaceRoot, slug, 'nope')).toThrow(/not found/)
  })

  it('refuses when no service exists at all', () => {
    expect(() => resolveContractServiceSlug(workspaceRoot, slug)).toThrow(/No services found/)
  })
})

describe('composeContract', () => {
  const slug = 'checkout-flow'
  const serviceSlug = 'checkout-api'
  let workspaceRoot = ''

  function writeFixture(name: string, body: unknown) {
    const dir = getContractFixturesPath(workspaceRoot, slug, serviceSlug)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(body), 'utf-8')
  }

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-contract-'))
    const pathsDir = getContractPathsPath(workspaceRoot, slug, serviceSlug)
    mkdirSync(pathsDir, { recursive: true })
    writeFileSync(join(pathsDir, 'list-orders.yaml'), FRAGMENT, 'utf-8')
    writeFileSync(join(pathsDir, 'create-order.yaml'), '/orders:\n  post:\n    summary: Create\n    responses:\n      \'201\':\n        description: Created\n', 'utf-8')
    writeFixture('list-orders-200', [{ id: 1 }])
    writeFileSync(
      join(getContractServicePath(workspaceRoot, slug, serviceSlug), 'config.json'),
      JSON.stringify({ title: 'Checkout API', baseUrl: 'http://localhost:4010', authType: 'bearer' }),
      'utf-8',
    )
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('merges fragments into one OpenAPI document with schemas and servers', () => {
    const composed = composeContract(loadContractService(workspaceRoot, slug, serviceSlug))
    const document = composed.document as Record<string, any>

    expect(document.openapi).toBe('3.1.0')
    expect(document.info.title).toBe('Checkout API')
    expect(document.servers).toEqual([{ url: 'http://localhost:4010' }])
    expect(Object.keys(document.paths)).toEqual(['/orders'])
    expect(document.components.schemas.Order).toEqual({ type: 'object' })
  })

  it('reports duplicate paths instead of silently dropping them', () => {
    // Both fragments declare /orders.
    const composed = composeContract(loadContractService(workspaceRoot, slug, serviceSlug))
    expect(composed.conflicts).toEqual(['/orders'])
  })

  it('extracts endpoints with methods, responses and x-mock', () => {
    const composed = composeContract(loadContractService(workspaceRoot, slug, serviceSlug))

    const get = composed.endpoints.find((endpoint) => endpoint.method === 'GET')
    expect(get?.path).toBe('/orders')
    expect(get?.summary).toBe('List orders')
    expect(get?.responses.map((response) => response.status)).toEqual(['200', '500'])
    expect(get?.mock).toEqual({ status: 200, fixture: 'list-orders-200' })

    const post = composed.endpoints.find((endpoint) => endpoint.method === 'POST')
    expect(post?.mock).toBeNull()
  })

  it('flags x-mock fixtures that have no file', () => {
    writeFileSync(
      join(getContractPathsPath(workspaceRoot, slug, serviceSlug), 'missing.yaml'),
      '/invoices:\n  get:\n    x-mock:\n      fixture: list-invoices-200\n    responses:\n      \'200\':\n        description: OK\n',
      'utf-8',
    )

    const composed = composeContract(loadContractService(workspaceRoot, slug, serviceSlug))
    expect(composed.missingFixtures).toEqual(['list-invoices-200'])
  })

  it('writes the composed document to services/<svc>/openapi.yaml', () => {
    writeComposedContract(workspaceRoot, slug, serviceSlug)

    const composedPath = getComposedContractPath(workspaceRoot, slug, serviceSlug)
    expect(existsSync(composedPath)).toBe(true)
    expect(readFileSync(composedPath, 'utf-8')).toContain('openapi: 3.1.0')
  })

  it('builds mock routes from x-mock, resolving fixtures and skipping missing ones', () => {
    writeFileSync(
      join(getContractPathsPath(workspaceRoot, slug, serviceSlug), 'extra.yaml'),
      [
        '/invoices:',
        '  delete:',
        '    x-mock:',
        '      status: 204',
        '    responses:',
        "      '204':",
        '        description: Gone',
        '/quotes:',
        '  get:',
        '    x-mock:',
        '      fixture: nope-200',
        '    responses:',
        "      '200':",
        '        description: OK',
        '/health:',
        '  get:',
        '    responses:',
        "      '200':",
        '        description: OK',
        '',
      ].join('\n'),
      'utf-8',
    )

    const result = buildMockRoutes(loadContractService(workspaceRoot, slug, serviceSlug))

    // GET /orders resolved its fixture; the bodiless 204 carries null.
    expect(result.routes).toContainEqual({ method: 'GET', path: '/orders', status: 200, body: [{ id: 1 }] })
    expect(result.routes).toContainEqual({ method: 'DELETE', path: '/invoices', status: 204, body: null })

    // A declared-but-missing fixture is skipped, never served as an empty body.
    expect(result.missingFixtures).toEqual(['nope-200'])
    expect(result.routes.some((route) => route.path === '/quotes')).toBe(false)

    // /health declares no x-mock at all.
    expect(result.unmocked).toContain('GET /health')
  })
})

describe('buildContractDoc', () => {
  const slug = 'checkout-flow'
  const serviceSlug = 'checkout-api'
  let workspaceRoot = ''

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-contract-doc-'))
    const pathsDir = getContractPathsPath(workspaceRoot, slug, serviceSlug)
    mkdirSync(pathsDir, { recursive: true })
    writeFileSync(join(pathsDir, 'list-orders.yaml'), FRAGMENT, 'utf-8')
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('documents endpoints and declared error responses', () => {
    const service = loadContractService(workspaceRoot, slug, serviceSlug)
    const doc = buildContractDoc(service, composeContract(service))

    expect(doc).toContain('# API contract — checkout-api')
    expect(doc).toContain('| GET | `/orders` | List orders | 200, 500 |')
    expect(doc).toContain('## Error semantics')
    expect(doc).toContain('`500` — Boom')
  })

  it('calls out what is NOT declared, so the handoff is not silently incomplete', () => {
    const service = loadContractService(workspaceRoot, slug, serviceSlug)
    const doc = buildContractDoc(service, composeContract(service))

    // No config.json → auth not declared; no x-contract → notes not declared.
    expect(doc).toContain('## Authentication')
    expect(doc).toContain('**not declared**')
    expect(doc).toContain('## Contract notes')
    expect(doc).toContain('undocumented')
  })

  it('renders x-contract notes when a fragment provides them', () => {
    writeFileSync(
      join(getContractPathsPath(workspaceRoot, slug, serviceSlug), 'notes.yaml'),
      '/health:\n  get:\n    responses:\n      \'200\':\n        description: OK\nx-contract:\n  pagination: cursor based\n  idempotency: PUT is idempotent\n',
      'utf-8',
    )

    const service = loadContractService(workspaceRoot, slug, serviceSlug)
    const doc = buildContractDoc(service, composeContract(service))

    expect(doc).toContain('### `notes.yaml`')
    expect(doc).toContain('- **pagination** — cursor based')
    expect(doc).toContain('- **idempotency** — PUT is idempotent')
  })

  it('lists missing fixtures and duplicate paths', () => {
    writeFileSync(
      join(getContractPathsPath(workspaceRoot, slug, serviceSlug), 'dup.yaml'),
      '/orders:\n  get:\n    x-mock:\n      fixture: nope-200\n    responses:\n      \'200\':\n        description: OK\n',
      'utf-8',
    )

    const service = loadContractService(workspaceRoot, slug, serviceSlug)
    const doc = buildContractDoc(service, composeContract(service))

    expect(doc).toContain('## Missing fixtures')
    expect(doc).toContain('`nope-200`')
    expect(doc).toContain('## Duplicate paths')
  })
})

describe('exportContractDeliverable', () => {
  const slug = 'checkout-flow'
  const serviceSlug = 'checkout-api'
  let workspaceRoot = ''

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'craft-contract-export-'))
    const pathsDir = getContractPathsPath(workspaceRoot, slug, serviceSlug)
    mkdirSync(pathsDir, { recursive: true })
    writeFileSync(join(pathsDir, 'list-orders.yaml'), FRAGMENT, 'utf-8')
    const fixturesDir = getContractFixturesPath(workspaceRoot, slug, serviceSlug)
    mkdirSync(fixturesDir, { recursive: true })
    writeFileSync(join(fixturesDir, 'list-orders-200.json'), JSON.stringify([{ id: 1 }]), 'utf-8')
  })

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true })
  })

  it('writes openapi.yaml, contract.md and copies fixtures into dist/', () => {
    const result = exportContractDeliverable(workspaceRoot, slug, serviceSlug)

    expect(result.endpoints).toBe(1)
    expect(result.fixtures).toBe(1)
    expect(result.missingFixtures).toEqual([])

    expect(existsSync(result.openapiPath)).toBe(true)
    expect(existsSync(result.docPath)).toBe(true)
    expect(existsSync(join(result.fixturesDir, 'list-orders-200.json'))).toBe(true)
    expect(result.openapiPath.startsWith(getPrototypeDistPath(workspaceRoot, slug))).toBe(true)

    expect(readFileSync(result.openapiPath, 'utf-8')).toContain('/orders')
    expect(readFileSync(result.docPath, 'utf-8')).toContain('List orders')
  })
})
