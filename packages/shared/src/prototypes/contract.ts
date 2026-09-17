/**
 * Service contract layer.
 *
 * The contract is the **source of truth**. Fragments under
 * `services/{svc}/paths/` are authored (by the agent) as ordinary YAML files;
 * the composed `openapi.yaml`, the backend deliverable and the in-browser mock
 * are all *derived* from them.
 *
 * Why fragments instead of one `openapi.yaml`:
 *  - a single file is the one thing parallel writers cannot share without
 *    contending on it (plan §3.3 constraint 2);
 *  - `$ref`s keep working because fragments are merged into one document, so
 *    they can reference each other's schemas.
 *
 * @see docs/prototype-workbench-plan.md §阶段 5
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { describeMockOperation, type MockRoute } from './mock-engine.ts'
import { getPrototypeDistPath, getPrototypeDirPath } from './storage.ts'

const SERVICES_DIRNAME = 'services'
const PATHS_DIRNAME = 'paths'
const FIXTURES_DIRNAME = 'fixtures'
const CONFIG_FILENAME = 'config.json'
/** The mock's starting state, one document per service (see `mock-engine.ts`). */
const STATE_FILENAME = 'state.json'
export const COMPOSED_CONTRACT_FILENAME = 'openapi.yaml'

/** The path-item key declaring which store collection a path is about. */
const COLLECTION_KEY = 'x-mock-collection'

/** HTTP verbs recognised inside an OpenAPI path item. */
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const

/** `config.json` — deliberately the same shape as an API source (`ApiSourceConfig`). */
export interface ContractConfig {
  title?: string
  baseUrl?: string
  authType?: string
  defaultHeaders?: Record<string, string>
}

/** One authored `paths/*.yaml` file. */
export interface ContractFragment {
  /** File name relative to `paths/`. */
  file: string
  /** Path items declared by this fragment, keyed by URL path. */
  paths: Record<string, unknown>
  /** Schemas declared by this fragment. */
  schemas: Record<string, unknown>
  /** Free-form contract notes (`x-contract`), for the backend handoff. */
  contract: Record<string, unknown> | null
}

/** A loaded service directory. */
export interface ContractService {
  slug: string
  /** Absolute path to `services/{svc}/`. */
  dir: string
  fragments: ContractFragment[]
  /** Fixture name → parsed JSON body. */
  fixtures: Record<string, unknown>
  /** Names of fixture files that failed to parse. */
  brokenFixtures: string[]
  /**
   * The mock's starting state (`state.json`), or null when the service declares
   * none — which is the honest state of a service with nothing stateful in it.
   */
  state: Record<string, unknown> | null
  /** Why `state.json` could not be used, when it is there but unreadable. */
  brokenState: string | null
  config: ContractConfig | null
}

export interface ContractEndpoint {
  method: string
  path: string
  summary: string
  status: string
  responses: Array<{ status: string; description: string }>
  /** `x-mock` declaration, when present. */
  mock: { status: number; fixture: string | null } | null
  /**
   * The store collection this path is about (`x-mock-collection` on the path
   * item), or null. A path item declares it once for all its methods: the
   * collection is what the path addresses, and the method says what is done to it.
   */
  collection: string | null
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export function getPrototypeServicesPath(workspaceRootPath: string, slug: string): string {
  return join(getPrototypeDirPath(workspaceRootPath, slug), SERVICES_DIRNAME)
}

export function getContractServicePath(workspaceRootPath: string, slug: string, serviceSlug: string): string {
  return join(getPrototypeServicesPath(workspaceRootPath, slug), serviceSlug)
}

export function getContractPathsPath(workspaceRootPath: string, slug: string, serviceSlug: string): string {
  return join(getContractServicePath(workspaceRootPath, slug, serviceSlug), PATHS_DIRNAME)
}

export function getContractFixturesPath(workspaceRootPath: string, slug: string, serviceSlug: string): string {
  return join(getContractServicePath(workspaceRootPath, slug, serviceSlug), FIXTURES_DIRNAME)
}

/** `services/{svc}/state.json` — the mock's starting state (see `mock-engine.ts`). */
export function getContractStatePath(workspaceRootPath: string, slug: string, serviceSlug: string): string {
  return join(getContractServicePath(workspaceRootPath, slug, serviceSlug), STATE_FILENAME)
}

export function getComposedContractPath(workspaceRootPath: string, slug: string, serviceSlug: string): string {
  return join(getContractServicePath(workspaceRootPath, slug, serviceSlug), COMPOSED_CONTRACT_FILENAME)
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** Service slugs present under `services/`, in a deterministic order. */
export function listContractServices(workspaceRootPath: string, slug: string): string[] {
  const servicesPath = getPrototypeServicesPath(workspaceRootPath, slug)
  if (!existsSync(servicesPath)) return []

  return readdirSync(servicesPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort()
}

/**
 * Parse one fragment.
 *
 * Accepts both shapes people actually write:
 *  - a `paths:` / `components:` block, and
 *  - top-level `/…` keys used directly as path items.
 */
export function parseContractFragment(file: string, raw: string): ContractFragment {
  const fragment: ContractFragment = { file, paths: {}, schemas: {}, contract: null }

  let doc: unknown
  try {
    doc = parseYaml(raw)
  } catch (error) {
    throw new Error(`Fragment "${file}" is not valid YAML: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return fragment

  const record = doc as Record<string, unknown>

  if (record.paths && typeof record.paths === 'object' && !Array.isArray(record.paths)) {
    Object.assign(fragment.paths, record.paths as Record<string, unknown>)
  }
  for (const [key, value] of Object.entries(record)) {
    if (key.startsWith('/')) fragment.paths[key] = value
  }

  const components = record.components as { schemas?: unknown } | undefined
  if (components?.schemas && typeof components.schemas === 'object' && !Array.isArray(components.schemas)) {
    Object.assign(fragment.schemas, components.schemas as Record<string, unknown>)
  }

  if (record['x-contract'] && typeof record['x-contract'] === 'object' && !Array.isArray(record['x-contract'])) {
    fragment.contract = record['x-contract'] as Record<string, unknown>
  }

  return fragment
}

function readFragments(workspaceRootPath: string, slug: string, serviceSlug: string): ContractFragment[] {
  const pathsDir = getContractPathsPath(workspaceRootPath, slug, serviceSlug)
  if (!existsSync(pathsDir)) return []

  return readdirSync(pathsDir)
    .filter((file) => /\.(ya?ml)$/i.test(file))
    .sort()
    .map((file) => parseContractFragment(file, readFileSync(join(pathsDir, file), 'utf-8')))
}

function readFixtures(
  workspaceRootPath: string,
  slug: string,
  serviceSlug: string,
): { fixtures: Record<string, unknown>; broken: string[] } {
  const fixturesDir = getContractFixturesPath(workspaceRootPath, slug, serviceSlug)
  const fixtures: Record<string, unknown> = {}
  const broken: string[] = []
  if (!existsSync(fixturesDir)) return { fixtures, broken }

  for (const file of readdirSync(fixturesDir).sort()) {
    if (!/\.json$/i.test(file)) continue
    const name = file.replace(/\.json$/i, '')
    try {
      fixtures[name] = JSON.parse(readFileSync(join(fixturesDir, file), 'utf-8'))
    } catch {
      broken.push(name)
    }
  }

  return { fixtures, broken }
}

function readConfig(workspaceRootPath: string, slug: string, serviceSlug: string): ContractConfig | null {
  const configPath = join(getContractServicePath(workspaceRootPath, slug, serviceSlug), CONFIG_FILENAME)
  if (!existsSync(configPath)) return null
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8')) as ContractConfig
  } catch {
    return null
  }
}

/**
 * The mock's starting state, by reading `state.json`.
 *
 * A file that is there but unusable is **reported**, not treated as absent: a
 * stateful route reading an empty store looks exactly like a flow that does not
 * work, and which of the two it is has to be answerable.
 */
function readState(
  workspaceRootPath: string,
  slug: string,
  serviceSlug: string,
): { state: Record<string, unknown> | null; broken: string | null } {
  const statePath = getContractStatePath(workspaceRootPath, slug, serviceSlug)
  if (!existsSync(statePath)) return { state: null, broken: null }
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf-8')) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { state: null, broken: `${STATE_FILENAME} has to be a JSON object (top-level), not ${Array.isArray(parsed) ? 'an array' : typeof parsed}.` }
    }
    return { state: parsed as Record<string, unknown>, broken: null }
  } catch (err) {
    return { state: null, broken: `${STATE_FILENAME} is not valid JSON: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** Load a service directory: fragments + fixtures + state + config. */
export function loadContractService(workspaceRootPath: string, slug: string, serviceSlug: string): ContractService {
  const { fixtures, broken } = readFixtures(workspaceRootPath, slug, serviceSlug)
  const { state, broken: brokenState } = readState(workspaceRootPath, slug, serviceSlug)
  return {
    slug: serviceSlug,
    dir: getContractServicePath(workspaceRootPath, slug, serviceSlug),
    fragments: readFragments(workspaceRootPath, slug, serviceSlug),
    fixtures,
    brokenFixtures: broken,
    state,
    brokenState,
    config: readConfig(workspaceRootPath, slug, serviceSlug),
  }
}

/**
 * Resolve which service to operate on: an explicit slug, or the only one present.
 *
 * @throws when the choice is ambiguous or nothing exists — silently guessing
 *   between several services would be worse than failing.
 */
export function resolveContractServiceSlug(
  workspaceRootPath: string,
  slug: string,
  requested?: string,
): string {
  const services = listContractServices(workspaceRootPath, slug)

  if (requested) {
    if (!services.includes(requested)) {
      throw new Error(
        services.length > 0
          ? `Service "${requested}" not found. Available: ${services.join(', ')}`
          : `Service "${requested}" not found — no services exist under ${getPrototypeServicesPath(workspaceRootPath, slug)}`,
      )
    }
    return requested
  }

  if (services.length === 1) return services[0] as string
  if (services.length === 0) {
    throw new Error(`No services found under ${getPrototypeServicesPath(workspaceRootPath, slug)}`)
  }
  throw new Error(`Multiple services found (${services.join(', ')}) — pass --service <slug>`)
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

export interface ComposedContract {
  document: Record<string, unknown>
  /** Paths declared by more than one fragment (last fragment wins). */
  conflicts: string[]
  /** Fixture names referenced by `x-mock` that do not exist. */
  missingFixtures: string[]
  endpoints: ContractEndpoint[]
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Endpoints across all fragments, in path-then-method order. */
export function listContractEndpoints(service: ContractService): ContractEndpoint[] {
  const endpoints: ContractEndpoint[] = []

  for (const fragment of service.fragments) {
    for (const path of Object.keys(fragment.paths).sort()) {
      const item = fragment.paths[path]
      if (!isPlainObject(item)) continue

      // Declared once on the path item: the collection is what the path addresses,
      // and each method says what is done to it.
      const collectionRaw = item[COLLECTION_KEY]
      const collection = typeof collectionRaw === 'string' && collectionRaw.trim().length > 0
        ? collectionRaw.trim()
        : null

      for (const method of HTTP_METHODS) {
        const operation = item[method]
        if (!isPlainObject(operation)) continue

        const responses = Object.entries(isPlainObject(operation.responses) ? operation.responses : {})
          .map(([status, response]) => ({
            status,
            description: isPlainObject(response) && typeof response.description === 'string' ? response.description : '',
          }))
          .sort((a, b) => a.status.localeCompare(b.status))

        const mockRaw = operation['x-mock']
        const mock = isPlainObject(mockRaw)
          ? {
              status: typeof mockRaw.status === 'number' ? mockRaw.status : 200,
              fixture: typeof mockRaw.fixture === 'string' ? mockRaw.fixture : null,
            }
          : null

        endpoints.push({
          method: method.toUpperCase(),
          path,
          summary: typeof operation.summary === 'string' ? operation.summary : '',
          status: endpointStatus(responses),
          responses,
          mock,
          collection,
        })
      }
    }
  }

  return endpoints
}

/** "declared" when the endpoint documents responses, otherwise "undocumented". */
function endpointStatus(responses: Array<{ status: string }>): string {
  return responses.length > 0 ? 'declared' : 'undocumented'
}

/**
 * Merge fragments into one OpenAPI document.
 *
 * Deterministic: fragments are applied in file-name order, so the last writer of
 * a duplicate path is stable and reported in `conflicts` rather than silently
 * dropped.
 */
export function composeContract(service: ContractService): ComposedContract {
  const paths: Record<string, unknown> = {}
  const schemas: Record<string, unknown> = {}
  const conflicts: string[] = []

  for (const fragment of service.fragments) {
    for (const [path, item] of Object.entries(fragment.paths)) {
      if (path in paths) conflicts.push(path)
      paths[path] = item
    }
    Object.assign(schemas, fragment.schemas)
  }

  const endpoints = listContractEndpoints(service)
  const missingFixtures = [
    ...new Set(
      endpoints
        .map((endpoint) => endpoint.mock?.fixture)
        .filter((fixture): fixture is string => !!fixture && !(fixture in service.fixtures)),
    ),
  ].sort()

  const document: Record<string, unknown> = {
    openapi: '3.1.0',
    info: {
      title: service.config?.title ?? service.slug,
      version: '0.1.0',
      description: 'Composed from services/*/paths/*.yaml — do not edit directly; edit the fragments.',
    },
    ...(service.config?.baseUrl ? { servers: [{ url: service.config.baseUrl }] } : {}),
    paths,
    ...(Object.keys(schemas).length > 0 ? { components: { schemas } } : {}),
  }

  return { document, conflicts, missingFixtures, endpoints }
}

/** Compose and write `services/{svc}/openapi.yaml`, returning the composed view. */
export function writeComposedContract(workspaceRootPath: string, slug: string, serviceSlug: string): ComposedContract {
  const service = loadContractService(workspaceRootPath, slug, serviceSlug)
  const composed = composeContract(service)

  mkdirSync(service.dir, { recursive: true })
  writeFileSync(
    getComposedContractPath(workspaceRootPath, slug, serviceSlug),
    stringifyYaml(composed.document),
    'utf-8',
  )

  return composed
}

// ---------------------------------------------------------------------------
// Backend deliverable
// ---------------------------------------------------------------------------

const NOT_DECLARED = '**not declared**'

/**
 * Contract handoff document.
 *
 * Deliberately calls out what is *missing* as well as what is there: a contract
 * that only lists happy paths is not enough for a backend to implement against
 * (plan §5.4, "契约 ⊃ mock").
 */
export function buildContractDoc(service: ContractService, composed: ComposedContract): string {
  const lines: string[] = [
    `# API contract — ${service.slug}`,
    '',
    'Composed from `paths/*.yaml` fragments. The fragments are the source of truth; this document is a',
    'reading aid for the receiving backend team.',
    '',
    '## Endpoints',
    '',
  ]

  if (composed.endpoints.length === 0) {
    lines.push('_No endpoints declared._', '')
  } else {
    lines.push('| Method | Path | Summary | Response coverage |', '| --- | --- | --- | --- |')
    for (const endpoint of composed.endpoints) {
      const coverage = endpoint.responses.length > 0
        ? endpoint.responses.map((response) => response.status).join(', ')
        : 'none'
      lines.push(`| ${endpoint.method} | \`${endpoint.path}\` | ${endpoint.summary || '—'} | ${coverage} |`)
    }
    lines.push('')
  }

  // Error semantics
  const errors = composed.endpoints.filter((endpoint) =>
    endpoint.responses.some((response) => !/^2/.test(response.status)),
  )
  lines.push('## Error semantics', '')
  if (errors.length === 0) {
    lines.push(`${NOT_DECLARED} — no endpoint documents a non-2xx response.`, '')
  } else {
    for (const endpoint of errors) {
      const nonOk = endpoint.responses.filter((response) => !/^2/.test(response.status))
      lines.push(
        `- \`${endpoint.method} ${endpoint.path}\``,
        ...nonOk.map((response) => `  - \`${response.status}\` — ${response.description || 'no description'}`),
      )
    }
    lines.push('')
  }

  // Auth
  lines.push('## Authentication', '')
  lines.push(
    service.config?.authType
      ? `\`${service.config.authType}\`${service.config.baseUrl ? ` against \`${service.config.baseUrl}\`` : ''}.`
      : `${NOT_DECLARED} — no \`authType\` in \`config.json\`.`,
    '',
  )

  // Free-form contract notes (pagination / idempotency / concurrency / …)
  const notes = service.fragments.filter((fragment) => fragment.contract)
  lines.push('## Contract notes', '')
  if (notes.length === 0) {
    lines.push(
      `${NOT_DECLARED} — none of the fragments carry an \`x-contract\` block, so pagination, ordering,`,
      'idempotency and concurrency behaviour are undocumented.',
      '',
    )
  } else {
    for (const fragment of notes) {
      lines.push(`### \`${fragment.file}\``, '')
      for (const [key, value] of Object.entries(fragment.contract as Record<string, unknown>)) {
        lines.push(`- **${key}** — ${typeof value === 'string' ? value : JSON.stringify(value)}`)
      }
      lines.push('')
    }
  }

  if (composed.missingFixtures.length > 0) {
    lines.push(
      '## Missing fixtures',
      '',
      'These `x-mock.fixture` references have no matching file under `fixtures/`:',
      '',
      ...composed.missingFixtures.map((name) => `- \`${name}\``),
      '',
    )
  }

  if (composed.conflicts.length > 0) {
    lines.push(
      '## Duplicate paths',
      '',
      'Declared by more than one fragment (the last fragment in file-name order won):',
      '',
      ...composed.conflicts.map((path) => `- \`${path}\``),
      '',
    )
  }

  return lines.join('\n')
}

export interface ContractExportResult {
  service: string
  /** `dist/openapi.yaml` — the backend deliverable. */
  openapiPath: string
  /** `dist/contract.md` — the handoff document. */
  docPath: string
  /** `dist/fixtures/` — response bodies shipped alongside the spec. */
  fixturesDir: string
  endpoints: number
  fixtures: number
  missingFixtures: string[]
  conflicts: string[]
}

/** Write the backend-facing deliverables for one service into `dist/`. */
export function exportContractDeliverable(
  workspaceRootPath: string,
  slug: string,
  serviceSlug: string,
): ContractExportResult {
  const service = loadContractService(workspaceRootPath, slug, serviceSlug)
  const composed = composeContract(service)

  const distDir = getPrototypeDistPath(workspaceRootPath, slug)
  mkdirSync(distDir, { recursive: true })

  const openapiPath = join(distDir, 'openapi.yaml')
  writeFileSync(openapiPath, stringifyYaml(composed.document), 'utf-8')

  const docPath = join(distDir, 'contract.md')
  writeFileSync(docPath, buildContractDoc(service, composed), 'utf-8')

  const fixturesDir = join(distDir, 'fixtures')
  mkdirSync(fixturesDir, { recursive: true })
  for (const [name, body] of Object.entries(service.fixtures)) {
    writeFileSync(join(fixturesDir, `${name}.json`), `${JSON.stringify(body, null, 2)}\n`, 'utf-8')
  }

  return {
    service: serviceSlug,
    openapiPath,
    docPath,
    fixturesDir,
    endpoints: composed.endpoints.length,
    fixtures: Object.keys(service.fixtures).length,
    missingFixtures: composed.missingFixtures,
    conflicts: composed.conflicts,
  }
}

// ---------------------------------------------------------------------------
// Mock materialization
// ---------------------------------------------------------------------------

/**
 * A response the mock serves, derived from a contract operation's `x-mock`.
 *
 * The shape lives in `mock-engine.ts` with the semantics that read it: the state
 * machine is the only thing that has to agree about what a route means, and the
 * wire shape is its input. Re-exported here because a route is *derived from the
 * contract*, and that is the door callers come through.
 */
export type { MockRoute } from './mock-engine.ts'

export interface MockRoutesResult {
  routes: MockRoute[]
  /** `x-mock.fixture` references with no matching fixture file (route skipped). */
  missingFixtures: string[]
  /** Endpoints that declare no `x-mock`, as `"GET /orders"`. */
  unmocked: string[]
  /**
   * Operations whose declared collection this vocabulary cannot act on, as
   * sentences (see `describeMockOperation`) — a stateful route that could not be
   * built. Named here rather than dropped: a route that is not in the table looks
   * like a request that reached the real backend.
   */
  stateIssues: string[]
  /** Why `state.json` was unusable, when it is there but broken. */
  stateProblem: string | null
}

/**
 * Build the mock route table from a service's contract.
 *
 * A declared `x-mock.fixture` that does not exist is **skipped rather than
 * served as an empty body** — a silently-empty response is far harder to debug
 * than the request reaching the real backend. The same rule applies to a path
 * whose collection this vocabulary cannot express: it is reported, not mocked.
 */
export function buildMockRoutes(service: ContractService): MockRoutesResult {
  const routes: MockRoute[] = []
  const missingFixtures: string[] = []
  const unmocked: string[] = []
  const stateIssues: string[] = []

  for (const endpoint of listContractEndpoints(service)) {
    if (!endpoint.mock) {
      unmocked.push(`${endpoint.method} ${endpoint.path}`)
      continue
    }

    // The stateful half: the path says which collection it is about, the method
    // says what is done to it. An operation this vocabulary cannot express is
    // named here, at read time, instead of being mocked into silence.
    let state: MockRoute['state']
    if (endpoint.collection !== null) {
      const described = describeMockOperation(endpoint.method, endpoint.path, endpoint.collection)
      if ('problem' in described) {
        stateIssues.push(described.problem)
        continue
      }
      state = { ...described, fromState: endpoint.mock.fixture === null }
    }

    const fixture = endpoint.mock.fixture
    if (fixture) {
      if (!(fixture in service.fixtures)) {
        missingFixtures.push(fixture)
        continue
      }
      routes.push({
        method: endpoint.method,
        path: endpoint.path,
        status: endpoint.mock.status,
        body: service.fixtures[fixture],
        ...(state ? { state } : {}),
      })
      continue
    }

    routes.push({
      method: endpoint.method,
      path: endpoint.path,
      status: endpoint.mock.status,
      // Null for a stateful route that named no fixture: the answer is the
      // collection itself (`state.fromState`), not a body carried here.
      body: null,
      ...(state ? { state } : {}),
    })
  }

  return {
    routes,
    missingFixtures: [...new Set(missingFixtures)].sort(),
    unmocked,
    stateIssues,
    stateProblem: service.brokenState,
  }
}
