/**
 * `when:` conditions — the branch-test half of the control flow (`route`).
 *
 * A node's `when` decides whether it runs at all. The expression reads the declared
 * outputs of upstream nodes (`review.verdict === 'approved'`) — which is exactly why
 * structured outputs had to land first: a branch test needs fields that are guaranteed
 * present, and a free-form answer has none.
 *
 * Deliberately a tiny language, not an expression library:
 *   comparison := operand ('===' | '==' | '!==' | '!=' literal)?
 *   operand    := PATH | literal
 *   term       := comparison (('&&' | '||') comparison)*     — left to right, no precedence
 *   primary    := '(' term ')' | '!' primary | term
 * A bare PATH is a truthiness test. Nothing is `eval`'d: the parser only ever produces
 * this AST, so a hand-authored `when` cannot execute anything.
 *
 * Three callers share it, so the grammar lives in one place:
 *  - `validate.ts` parses every `when` (an unparsable expression is a spec error, and its
 *    references must resolve like any other reference);
 *  - `materializeDeps()` reads the references, so a `when` depends on what it reads;
 *  - the Conductor parses once at run start and evaluates against node outputs.
 *
 * Fail-closed by design: an unparsable `when` is refused at validation and never reaches a
 * run. The failure mode this avoids is the dangerous one — a branch test that silently
 * evaluates to false (or true) and runs a node nobody asked for.
 */
import type { NodeOutput } from './refs.ts'

/** A structured-output reference inside a `when`: `<node-id>.<field>`. */
export interface WhenRef {
  nodeId: string
  field: string
}

/** A guard against pathological hand-authored input; real conditions are one line. */
const MAX_EXPRESSION_LENGTH = 1000

const NODE_ID_RE = /^[a-z0-9][a-z0-9-]*/
const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*/

type Token =
  | { kind: 'and' | 'or' | 'not' | 'lparen' | 'rparen' }
  | { kind: 'eq' | 'neq' }
  | { kind: 'ref'; nodeId: string; field: string }
  | { kind: 'literal'; value: string | number | boolean | null }

function tokenize(src: string, at: (msg: string) => string): Token[] | string {
  const tokens: Token[] = []
  let i = 0
  while (i < src.length) {
    const ch = src[i]!
    if (/\s/.test(ch)) {
      i += 1
      continue
    }
    const three = src.slice(i, i + 3)
    if (three === '===') {
      tokens.push({ kind: 'eq' })
      i += 3
      continue
    }
    if (three === '!==') {
      tokens.push({ kind: 'neq' })
      i += 3
      continue
    }
    const two = src.slice(i, i + 2)
    if (two === '==') {
      tokens.push({ kind: 'eq' })
      i += 2
      continue
    }
    if (two === '!=') {
      tokens.push({ kind: 'neq' })
      i += 2
      continue
    }
    if (two === '&&') {
      tokens.push({ kind: 'and' })
      i += 2
      continue
    }
    if (two === '||') {
      tokens.push({ kind: 'or' })
      i += 2
      continue
    }
    if (ch === '!') {
      tokens.push({ kind: 'not' })
      i += 1
      continue
    }
    if (ch === '(') {
      tokens.push({ kind: 'lparen' })
      i += 1
      continue
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen' })
      i += 1
      continue
    }
    // The near-misses worth naming: a single `=`/`&`/`|` is the classic hand-authoring slip.
    if (ch === '=' || ch === '&' || ch === '|') {
      return at(`"${ch}" is not a comparison — use ===, ==, !==, !=, && or ||`)
    }
    if (ch === '"' || ch === "'") {
      const end = src.indexOf(ch, i + 1)
      if (end === -1) return at('unterminated string literal')
      tokens.push({ kind: 'literal', value: src.slice(i + 1, end) })
      i = end + 1
      continue
    }
    // A path, a bare word (true/false/null), or a number.
    const word = src.slice(i).match(/^[A-Za-z0-9_.-]+/)?.[0]
    if (!word) return at(`unexpected character "${ch}"`)
    i += word.length
    if (word === 'true' || word === 'false') {
      tokens.push({ kind: 'literal', value: word === 'true' })
      continue
    }
    if (word === 'null') {
      tokens.push({ kind: 'literal', value: null })
      continue
    }
    const dot = word.indexOf('.')
    if (dot > 0) {
      const nodeId = word.slice(0, dot)
      const field = word.slice(dot + 1)
      if (!NODE_ID_RE.test(nodeId) || !IDENT_RE.test(field)) {
        return at(`"${word}" is not a node field reference (expected <node-id>.<field>)`)
      }
      tokens.push({ kind: 'ref', nodeId, field })
      continue
    }
    if (/^-?\d+(\.\d+)?$/.test(word)) {
      tokens.push({ kind: 'literal', value: Number(word) })
      continue
    }
    return at(
      `"${word}" on its own is not a condition — compare a node field to a value, e.g. ${word}.status === 'ok'`,
    )
  }
  return tokens
}

type Operand = { kind: 'ref'; nodeId: string; field: string } | { kind: 'literal'; value: string | number | boolean | null }

type Node =
  | Operand
  | { kind: 'not'; inner: Node }
  | { kind: 'and' | 'or'; left: Node; right: Node }
  | { kind: 'cmp'; op: 'eq' | 'neq'; left: Operand; right: Operand }

/** A comparison compares two values — a nested condition on either side is a mistake, not a value. */
function isOperand(node: Node): node is Operand {
  return node.kind === 'ref' || node.kind === 'literal'
}

/** A parsed, ready-to-evaluate condition. */
export interface ParsedWhen {
  /** Every `<node-id>.<field>` the expression reads (in source order). */
  refs: WhenRef[]
  /** Evaluate against the run's node outputs. Missing values make comparisons false. */
  evaluate(nodeOutputs: Record<string, NodeOutput>): boolean
}

/**
 * Parse a `when` expression. Returns a message instead of a condition when it is malformed;
 * `where` names the position (a yaml path) that the message is prefixed with, when given.
 */
export function parseWhen(expr: string, where = ''): ParsedWhen | string {
  const at = (msg: string): string => (where ? `${where}: ${msg}` : msg)
  const src = expr.trim()
  if (!src) return at('the condition is empty')
  if (src.length > MAX_EXPRESSION_LENGTH) return at('the condition is too long')

  const tokens = tokenize(src, at)
  if (typeof tokens === 'string') return tokens

  let pos = 0
  const peek = (): Token | undefined => tokens[pos]
  const eat = (kind: Token['kind']): boolean => {
    if (peek()?.kind !== kind) return false
    pos += 1
    return true
  }
  const fail = (want: string): string =>
    at(`expected ${want}${pos < tokens.length ? ` before "${src}"` : ' at the end of the condition'}`)

  let error: string | undefined
  const parsePrimary = (): Node | undefined => {
    const token = peek()
    if (!token) {
      error = fail('a node field or value')
      return undefined
    }
    if (token.kind === 'not') {
      pos += 1
      const inner = parsePrimary()
      return inner && { kind: 'not', inner }
    }
    if (token.kind === 'lparen') {
      pos += 1
      const inner = parseTerm()
      if (!inner) return undefined
      if (!eat('rparen')) {
        error = fail('")"')
        return undefined
      }
      return inner
    }
    if (token.kind === 'ref') {
      pos += 1
      return { kind: 'ref', nodeId: token.nodeId, field: token.field }
    }
    if (token.kind === 'literal') {
      pos += 1
      return { kind: 'literal', value: token.value }
    }
    error = fail('a node field or value')
    return undefined
  }
  const parseComparison = (): Node | undefined => {
    const left = parsePrimary()
    if (!left) return undefined
    const op = peek()?.kind
    if (op !== 'eq' && op !== 'neq') return left
    pos += 1
    const right = parsePrimary()
    if (!right) return undefined
    if (!isOperand(left) || !isOperand(right)) {
      error = at('expected a field or value on both sides of a comparison')
      return undefined
    }
    return { kind: 'cmp', op, left, right }
  }
  // Flat, left-to-right: `a && b || c` is `(a && b) || c`. Parenthesize to say otherwise.
  const parseTerm = (): Node | undefined => {
    let left = parseComparison()
    if (!left) return undefined
    for (;;) {
      const token = peek()
      if (token?.kind !== 'and' && token?.kind !== 'or') return left
      pos += 1
      const right = parseComparison()
      if (!right) return undefined
      left = { kind: token.kind, left, right }
    }
  }

  const ast = parseTerm()
  if (!ast || error) return error ?? at('could not be parsed')
  if (pos < tokens.length) return at(`unexpected trailing input in "${src}"`)

  const refs: WhenRef[] = []
  const collect = (node: Node): void => {
    switch (node.kind) {
      case 'ref':
        refs.push({ nodeId: node.nodeId, field: node.field })
        return
      case 'not':
        collect(node.inner)
        return
      case 'and':
      case 'or':
      case 'cmp':
        collect(node.left)
        collect(node.right)
        return
      default:
        return
    }
  }
  collect(ast)

  return {
    refs,
    evaluate: (nodeOutputs) => evalNode(ast, nodeOutputs),
  }
}

/** Read a `<node-id>.<field>` value out of the run's outputs; undefined when it isn't there. */
function readValue(ref: { nodeId: string; field: string }, nodeOutputs: Record<string, NodeOutput>): unknown {
  return nodeOutputs[ref.nodeId]?.params?.[ref.field]
}

function evalNode(node: Node, nodeOutputs: Record<string, NodeOutput>): boolean {
  switch (node.kind) {
    case 'literal':
      return truthy(node.value)
    case 'ref':
      return truthy(readValue(node, nodeOutputs))
    case 'not':
      return !evalNode(node.inner, nodeOutputs)
    case 'and':
      return evalNode(node.left, nodeOutputs) && evalNode(node.right, nodeOutputs)
    case 'or':
      return evalNode(node.left, nodeOutputs) || evalNode(node.right, nodeOutputs)
    case 'cmp': {
      const left = node.left.kind === 'ref' ? readValue(node.left, nodeOutputs) : node.left.value
      const right = node.right.kind === 'ref' ? readValue(node.right, nodeOutputs) : node.right.value
      const same = equal(left, right)
      return node.op === 'eq' ? same : !same
    }
  }
}

function truthy(value: unknown): boolean {
  if (value === undefined || value === null) return false
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') return value.trim() !== '' && value !== 'false'
  return true
}

/**
 * Compare a node's field against the other side of the comparison — normally a literal, whose
 * type decides how strict the compare is (`7` is a number, `'7'` is a string), so a hand-authored
 * condition does not have to know whether the producing node's model wrote a number or a numeric
 * string. A missing side is never equal to anything but itself.
 */
function equal(actual: unknown, expected: unknown): boolean {
  if (actual === undefined || actual === null) return false
  if (typeof expected === 'number') return Number(actual) === expected
  if (typeof expected === 'boolean') return truthy(actual) === expected
  if (expected === null) return actual === null
  if (expected === undefined) return false
  return String(actual) === String(expected)
}
