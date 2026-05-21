// Resolves EctoScript tokens, derived tokens, and style blocks into
// concrete CSS values. The runtime hands us the current atom store so
// derived expressions like `if Theme.darkMode Black or White` can be
// evaluated.

import type { CompileResult } from './compiler'
import type { Literal } from './parser'

export interface ResolveContext {
  compiled: CompileResult
  atomValues: Record<string, any> // atom node id → current runtime value
}

// CSS property mapping from EctoScript shorthand → React style key
const CSS_KEY_MAP: Record<string, string> = {
  bg: 'background',
  fg: 'color',
  radius: 'borderRadius',
  shadow: 'boxShadow',
  padding: 'padding',
  margin: 'margin',
  gap: 'gap',
  width: 'width',
  height: 'height',
  border: 'border',
  font: 'font',
  fontSize: 'fontSize',
  fontWeight: 'fontWeight',
}

export function resolveStyleByName(name: string, ctx: ResolveContext): React.CSSProperties {
  const styleNodeId = ctx.compiled.styles[name]
  if (!styleNodeId) return {}
  const node = ctx.compiled.graph.nodes.find((n) => n.id === styleNodeId)
  if (!node) return {}
  const out: Record<string, string | number> = {}
  for (const p of (node.data?.props ?? []) as { name: string; value: Literal[] }[]) {
    const key = CSS_KEY_MAP[p.name] ?? p.name
    out[key] = p.value.map((v) => literalToCss(v, ctx)).join(' ')
  }
  // EctoScript styles describe flex containers by default — without
  // this, `flexDirection: row` and `flex: 1` would have no effect on
  // styles that don't also set a background.
  if (!out['display']) out['display'] = 'flex'
  if (!out['flexDirection']) out['flexDirection'] = 'column'
  return out as React.CSSProperties
}

export function literalToCss(v: Literal, ctx: ResolveContext): string {
  switch (v.kind) {
    case 'string':
      return v.value
    case 'number':
      return String(v.value)
    case 'bool':
      return String(v.value)
    case 'color':
      return v.value
    case 'unit':
      return `${v.value}${v.unit}`
    case 'ident':
      return resolveRefToCss(v.name, ctx)
    case 'qualified': {
      // Black.20 → black with alpha 0.20
      if (v.segments.length === 2 && /^\d+$/.test(v.segments[1])) {
        const base = resolveRefToCss(v.segments[0], ctx)
        const alpha = Math.min(100, parseInt(v.segments[1], 10)) / 100
        return hexWithAlpha(base, alpha)
      }
      // Theme.darkMode in a style — fall back to a literal string
      return v.segments.join('.')
    }
    case 'raw':
      return v.value
    case 'list':
      return ''
    case 'null':
      return ''
  }
}

function resolveRefToCss(name: string, ctx: ResolveContext): string {
  const tokenId = ctx.compiled.tokens[name]
  if (tokenId) {
    const t = ctx.compiled.graph.nodes.find((n) => n.id === tokenId)
    if (t?.data?.value) return literalToCss(t.data.value, ctx)
  }
  const derivedId = ctx.compiled.derived[name]
  if (derivedId) {
    const d = ctx.compiled.graph.nodes.find((n) => n.id === derivedId)
    if (d?.data?.expr) return literalToCss(evalDerived(d.data.expr, ctx), ctx)
  }
  return name
}

export function evalDerived(expr: any, ctx: ResolveContext): Literal {
  if (!expr) return { kind: 'raw', value: '' }
  if (expr.kind === 'literal') return expr.value
  if (expr.kind === 'ref') {
    const tokId = ctx.compiled.tokens[expr.name]
    if (tokId) {
      const t = ctx.compiled.graph.nodes.find((n) => n.id === tokId)
      if (t?.data?.value) return t.data.value as Literal
    }
    return { kind: 'raw', value: expr.name }
  }
  if (expr.kind === 'ifElse') {
    const condVal = readAtomByPath(expr.cond.segments, ctx)
    return condVal ? evalDerived(expr.then, ctx) : evalDerived(expr.else, ctx)
  }
  return { kind: 'raw', value: '' }
}

export function readAtomByPath(segments: string[], ctx: ResolveContext): any {
  if (segments.length === 1) {
    // Try in every model — useful for component-local atoms in derived
    for (const modelName of Object.keys(ctx.compiled.models)) {
      const id = ctx.compiled.models[modelName].atomIds[segments[0]]
      if (id && id in ctx.atomValues) return ctx.atomValues[id]
    }
    return undefined
  }
  const [model, ...rest] = segments
  const id = ctx.compiled.models[model]?.atomIds[rest.join('.')]
  return id ? ctx.atomValues[id] : undefined
}

function hexWithAlpha(hex: string, alpha: number): string {
  if (!hex.startsWith('#')) return hex
  let r = 0,
    g = 0,
    b = 0
  if (hex.length === 4) {
    r = parseInt(hex[1] + hex[1], 16)
    g = parseInt(hex[2] + hex[2], 16)
    b = parseInt(hex[3] + hex[3], 16)
  } else if (hex.length === 7) {
    r = parseInt(hex.slice(1, 3), 16)
    g = parseInt(hex.slice(3, 5), 16)
    b = parseInt(hex.slice(5, 7), 16)
  } else {
    return hex
  }
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
