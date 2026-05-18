// EctoScript parser.
//
// Grammar (informal, indentation-based — like Python):
//
//   <file>      ::= (<top-decl>)*
//   <top-decl>  ::= <model> | <component> | <token> | <derived> | <styles>
//   <model>     ::= "model" Ident <indent> (<state-decl>)* <dedent>
//   <component> ::= "component" Ident <indent> (<comp-stmt>)* <dedent>
//   <comp-stmt> ::= <uses> | <state-decl> | <render>
//   <uses>      ::= "uses" Ident (<indent> <trait>* <dedent>)?
//   <state>     ::= "state" Ident "=" Literal (<indent> <trait>* <dedent>)?
//   <render>    ::= "render" <indent> <element>+ <dedent>
//   <element>   ::= "<" Ident (<modifier>*) (<indent> <element-body>* <dedent>)?
//   <modifier>  ::= "when" Ident
//   <ele-body>  ::= <element>
//                 | "style" Ident
//                 | "is" Ident
//                 | "on" Ident <indent> <action>+ <dedent>
//                 | Ident "binds" QualifiedIdent
//   <action>    ::= "toggle" QualifiedIdent
//   <token>     ::= "token" Ident "=" Value
//   <derived>   ::= "derived" Ident "=" <expr>
//   <styles>    ::= "styles" Ident <indent> (Ident ":" Value+ <dedent>
//
// We parse into a loose AST that the compiler then walks. This is meant
// to be hackable, not a perfect compiler — the goal is to feed the live
// playground end-to-end.

export type Literal =
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'color'; value: string }
  | { kind: 'unit'; value: number; unit: string } // 12px, 1rem, 100%
  | { kind: 'ident'; name: string }
  | { kind: 'qualified'; segments: string[] } // Theme.darkMode, Black.20
  | { kind: 'raw'; value: string } // unrecognized — keep verbatim

export interface Pos {
  line: number
  col: number
}

export interface ParseError {
  message: string
  line: number
  col: number
}

// --- AST -------------------------------------------------------------

export interface ModelDecl {
  kind: 'model'
  name: string
  pos: Pos
  states: StateDecl[]
}

export interface StateDecl {
  kind: 'state'
  name: string
  initial: Literal
  pos: Pos
  traits: string[]
}

export interface UsesDecl {
  kind: 'uses'
  model: string
  pos: Pos
  traits: string[]
}

export interface ComponentDecl {
  kind: 'component'
  name: string
  pos: Pos
  uses: UsesDecl[]
  states: StateDecl[]
  render: ElementNode | null
}

export interface ElementNode {
  kind: 'element'
  name: string
  pos: Pos
  // visibility — `when <atom>`
  when?: string
  styles: string[]
  traits: string[]
  // event handlers — `on click { toggle X }`
  events: EventHandler[]
  // simple per-element bindings — `checked binds TaskModel.checked`
  bindings: BindingDecl[]
  children: ElementNode[]
}

export interface EventHandler {
  kind: 'event'
  event: string
  pos: Pos
  actions: ActionNode[]
}

export interface ActionNode {
  kind: 'action'
  op: 'toggle' | 'set'
  target: string[] // dotted path
  pos: Pos
}

export interface BindingDecl {
  kind: 'binding'
  prop: string
  target: string[] // dotted path
  pos: Pos
}

export interface TokenDecl {
  kind: 'token'
  name: string
  value: Literal
  pos: Pos
}

export interface DerivedDecl {
  kind: 'derived'
  name: string
  // For now we support: `if <atom-path> <then-ident> or <else-ident>`
  expr: DerivedExpr
  pos: Pos
}

export type DerivedExpr =
  | { kind: 'literal'; value: Literal }
  | { kind: 'ref'; name: string }
  | {
      kind: 'ifElse'
      cond: { segments: string[] }
      then: DerivedExpr
      else: DerivedExpr
    }

export interface StylesDecl {
  kind: 'styles'
  name: string
  pos: Pos
  props: { name: string; value: Literal[] }[]
}

export type TopDecl =
  | ModelDecl
  | ComponentDecl
  | TokenDecl
  | DerivedDecl
  | StylesDecl

export interface ParseResult {
  decls: TopDecl[]
  errors: ParseError[]
}

// --- Lexing helpers --------------------------------------------------

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/
const UNIT_RE = /^(-?\d+(?:\.\d+)?)(px|rem|em|%|vh|vw|ms|s)$/
const NUM_RE = /^-?\d+(?:\.\d+)?$/
const QUALIFIED_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_0-9]+)+$/
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function literalFromToken(tok: string): Literal {
  if (tok.startsWith('"') && tok.endsWith('"')) {
    return { kind: 'string', value: tok.slice(1, -1) }
  }
  if (tok === 'true' || tok === 'false') {
    return { kind: 'bool', value: tok === 'true' }
  }
  if (HEX_RE.test(tok)) return { kind: 'color', value: tok }
  const u = UNIT_RE.exec(tok)
  if (u) return { kind: 'unit', value: parseFloat(u[1]), unit: u[2] }
  if (NUM_RE.test(tok)) return { kind: 'number', value: parseFloat(tok) }
  if (QUALIFIED_RE.test(tok)) return { kind: 'qualified', segments: tok.split('.') }
  if (IDENT_RE.test(tok)) return { kind: 'ident', name: tok }
  return { kind: 'raw', value: tok }
}

// Tokenize a single line, respecting double-quoted strings.
function tokenizeLine(rest: string): string[] {
  const out: string[] = []
  let i = 0
  while (i < rest.length) {
    const ch = rest[i]
    if (ch === ' ' || ch === '\t') {
      i++
      continue
    }
    if (ch === '"') {
      let j = i + 1
      while (j < rest.length && rest[j] !== '"') {
        if (rest[j] === '\\' && j + 1 < rest.length) j += 2
        else j++
      }
      out.push(rest.slice(i, Math.min(j + 1, rest.length)))
      i = j + 1
      continue
    }
    if (ch === '=' || ch === ':') {
      out.push(ch)
      i++
      continue
    }
    if (ch === '<') {
      out.push('<')
      i++
      continue
    }
    let j = i
    while (j < rest.length && !/[\s=:]/.test(rest[j])) j++
    out.push(rest.slice(i, j))
    i = j
  }
  return out
}

// --- Indent outline --------------------------------------------------

interface RawLine {
  line: number
  indent: number
  text: string
}

interface OutlineNode {
  raw: RawLine
  tokens: string[]
  children: OutlineNode[]
}

function buildOutline(source: string): { roots: OutlineNode[]; errors: ParseError[] } {
  const errors: ParseError[] = []
  const lines: RawLine[] = []
  source.split('\n').forEach((line, idx) => {
    // strip `//` comments — but not inside strings
    let inStr = false
    let endIdx = line.length
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') inStr = !inStr
      if (!inStr && line[i] === '/' && line[i + 1] === '/') {
        endIdx = i
        break
      }
    }
    const clean = line.slice(0, endIdx)
    if (clean.trim().length === 0) return
    const indent = clean.length - clean.trimStart().length
    lines.push({ line: idx + 1, indent, text: clean.trimStart() })
  })

  // Normalize indent to discrete levels by tracking the stack of widths
  // we've seen. widths[i] is the column at which depth (i+1) begins —
  // depth 0 is the top level (indent === 0). Tabs and 2-/4-space indent
  // both work transparently because we only compare indents to ones
  // already on the stack.
  const widths: number[] = []
  const roots: OutlineNode[] = []
  const stack: { node: OutlineNode; level: number }[] = []

  for (const raw of lines) {
    let level: number
    if (raw.indent === 0) {
      widths.length = 0
      level = 0
    } else {
      // pop any widths deeper than this line
      while (widths.length > 0 && widths[widths.length - 1] > raw.indent) {
        widths.pop()
      }
      if (widths.length === 0 || widths[widths.length - 1] < raw.indent) {
        widths.push(raw.indent)
      }
      level = widths.length // depth among the indents we've seen
    }
    const node: OutlineNode = { raw, tokens: tokenizeLine(raw.text), children: [] }
    while (stack.length > 0 && stack[stack.length - 1].level >= level) {
      stack.pop()
    }
    if (stack.length === 0) {
      roots.push(node)
    } else {
      stack[stack.length - 1].node.children.push(node)
    }
    stack.push({ node, level })
  }
  return { roots, errors }
}

// --- AST parsing -----------------------------------------------------

export function parse(source: string): ParseResult {
  const { roots, errors } = buildOutline(source)
  const decls: TopDecl[] = []

  for (const root of roots) {
    try {
      const decl = parseTopDecl(root)
      if (decl) decls.push(decl)
    } catch (err: any) {
      errors.push({
        message: err?.message ?? String(err),
        line: root.raw.line,
        col: root.raw.indent + 1,
      })
    }
  }
  return { decls, errors }
}

function parseTopDecl(n: OutlineNode): TopDecl | null {
  const [head, ...rest] = n.tokens
  const pos: Pos = { line: n.raw.line, col: n.raw.indent + 1 }
  switch (head) {
    case 'model':
      return parseModel(n, rest, pos)
    case 'component':
      return parseComponent(n, rest, pos)
    case 'token':
      return parseToken(rest, pos)
    case 'derived':
      return parseDerived(rest, pos)
    case 'styles':
      return parseStyles(n, rest, pos)
    default:
      throw new Error(`Unexpected top-level statement: "${n.raw.text}"`)
  }
}

function parseModel(n: OutlineNode, rest: string[], pos: Pos): ModelDecl {
  const name = expectIdent(rest[0], 'model name', pos)
  const states: StateDecl[] = []
  for (const c of n.children) {
    if (c.tokens[0] === 'state') states.push(parseState(c))
    else throw new Error(`In model "${name}": unexpected "${c.raw.text}"`)
  }
  return { kind: 'model', name, pos, states }
}

function parseComponent(n: OutlineNode, rest: string[], pos: Pos): ComponentDecl {
  const name = expectIdent(rest[0], 'component name', pos)
  const decl: ComponentDecl = {
    kind: 'component',
    name,
    pos,
    uses: [],
    states: [],
    render: null,
  }
  for (const c of n.children) {
    const head = c.tokens[0]
    if (head === 'uses') decl.uses.push(parseUses(c))
    else if (head === 'state') decl.states.push(parseState(c))
    else if (head === 'render') {
      const child = c.children.find((cc) => cc.tokens[0] === '<')
      if (child) decl.render = parseElement(child)
    } else {
      throw new Error(`In component "${name}": unexpected "${c.raw.text}"`)
    }
  }
  return decl
}

function parseUses(n: OutlineNode): UsesDecl {
  const pos: Pos = { line: n.raw.line, col: n.raw.indent + 1 }
  const model = expectIdent(n.tokens[1], 'model name in uses', pos)
  const traits: string[] = []
  for (const c of n.children) {
    if (c.tokens[0] === 'is' && c.tokens[1]) traits.push(c.tokens[1])
  }
  return { kind: 'uses', model, pos, traits }
}

function parseState(n: OutlineNode): StateDecl {
  const pos: Pos = { line: n.raw.line, col: n.raw.indent + 1 }
  const name = expectIdent(n.tokens[1], 'state name', pos)
  const eq = n.tokens[2]
  if (eq !== '=') throw new Error(`state ${name}: expected "=" got "${eq ?? '(end)'}"`)
  const initial = literalFromToken(n.tokens.slice(3).join(' ') || 'null')
  const traits: string[] = []
  for (const c of n.children) {
    if (c.tokens[0] === 'is' && c.tokens[1]) traits.push(c.tokens[1])
  }
  return { kind: 'state', name, initial, pos, traits }
}

function parseElement(n: OutlineNode): ElementNode {
  const pos: Pos = { line: n.raw.line, col: n.raw.indent + 1 }
  // tokens look like: ["<", "container", ...modifiers]
  const tokens = n.tokens
  if (tokens[0] !== '<') throw new Error(`Expected element, got "${n.raw.text}"`)
  const name = expectIdent(tokens[1], 'element name', pos)
  const el: ElementNode = {
    kind: 'element',
    name,
    pos,
    styles: [],
    traits: [],
    events: [],
    bindings: [],
    children: [],
  }
  for (let i = 2; i < tokens.length; i++) {
    if (tokens[i] === 'when' && tokens[i + 1]) {
      el.when = tokens[i + 1]
      i++
    }
  }
  for (const c of n.children) {
    const t = c.tokens
    if (t[0] === '<') {
      el.children.push(parseElement(c))
    } else if (t[0] === 'style' && t[1]) {
      el.styles.push(t[1])
    } else if (t[0] === 'is' && t[1]) {
      el.traits.push(t[1])
    } else if (t[0] === 'on' && t[1]) {
      el.events.push({
        kind: 'event',
        event: t[1],
        pos: { line: c.raw.line, col: c.raw.indent + 1 },
        actions: c.children
          .map((cc) => parseAction(cc))
          .filter((a): a is ActionNode => !!a),
      })
    } else if (t[1] === 'binds' && t[0] && t[2]) {
      el.bindings.push({
        kind: 'binding',
        prop: t[0],
        target: t[2].split('.'),
        pos: { line: c.raw.line, col: c.raw.indent + 1 },
      })
    } else {
      throw new Error(`In element <${name}>: unexpected "${c.raw.text}"`)
    }
  }
  return el
}

function parseAction(n: OutlineNode): ActionNode | null {
  const t = n.tokens
  const pos: Pos = { line: n.raw.line, col: n.raw.indent + 1 }
  if (t[0] === 'toggle' && t[1]) {
    return { kind: 'action', op: 'toggle', target: t[1].split('.'), pos }
  }
  if (t[0] === 'set' && t[1] && t[2] === '=' && t[3]) {
    return { kind: 'action', op: 'set', target: t[1].split('.'), pos }
  }
  return null
}

function parseToken(rest: string[], pos: Pos): TokenDecl {
  const name = expectIdent(rest[0], 'token name', pos)
  if (rest[1] !== '=') throw new Error(`token ${name}: expected "="`)
  const value = literalFromToken(rest.slice(2).join(' '))
  return { kind: 'token', name, value, pos }
}

function parseDerived(rest: string[], pos: Pos): DerivedDecl {
  const name = expectIdent(rest[0], 'derived name', pos)
  if (rest[1] !== '=') throw new Error(`derived ${name}: expected "="`)
  const expr = parseDerivedExpr(rest.slice(2))
  return { kind: 'derived', name, expr, pos }
}

function parseDerivedExpr(toks: string[]): DerivedExpr {
  if (toks[0] === 'if' && toks[1] && toks[2] && toks[3] === 'or' && toks[4]) {
    return {
      kind: 'ifElse',
      cond: { segments: toks[1].split('.') },
      then: { kind: 'ref', name: toks[2] },
      else: { kind: 'ref', name: toks[4] },
    }
  }
  if (toks.length === 1) {
    if (IDENT_RE.test(toks[0])) return { kind: 'ref', name: toks[0] }
    return { kind: 'literal', value: literalFromToken(toks[0]) }
  }
  return { kind: 'literal', value: { kind: 'raw', value: toks.join(' ') } }
}

function parseStyles(n: OutlineNode, rest: string[], pos: Pos): StylesDecl {
  const name = expectIdent(rest[0], 'styles name', pos)
  const props: StylesDecl['props'] = []
  for (const c of n.children) {
    const t = c.tokens
    const colonIdx = t.indexOf(':')
    if (colonIdx <= 0) continue
    const propName = t.slice(0, colonIdx).join('')
    const values = t.slice(colonIdx + 1).map(literalFromToken)
    props.push({ name: propName, value: values })
  }
  return { kind: 'styles', name, pos, props }
}

function expectIdent(tok: string | undefined, what: string, pos: Pos): string {
  if (!tok || !IDENT_RE.test(tok)) {
    throw new Error(`Expected ${what} at line ${pos.line}, got "${tok ?? '(end)'}"`)
  }
  return tok
}
