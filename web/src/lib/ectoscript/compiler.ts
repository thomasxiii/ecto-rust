// EctoScript → EctoGraph compiler.
//
// Walks the AST produced by parser.ts and emits a flat node+edge graph
// (graph.ts shape). The renderer (runtime.ts), the JSON panel, and the
// 3D visualizer all consume this same graph.

import type {
  ActionNode,
  BindingDecl,
  ComponentDecl,
  DerivedDecl,
  ElementNode,
  ModelDecl,
  ParseResult,
  StateDecl,
  StylesDecl,
  TokenDecl,
} from './parser'
import type { EctoEdge, EctoEdgeType, EctoGraph, EctoNode, EctoNodeType } from './graph'

export interface CompileResult {
  graph: EctoGraph
  errors: { message: string; line?: number; col?: number }[]
  // Convenience indices the runtime uses without re-walking the graph.
  models: Record<string, { atomIds: Record<string, string> }>
  components: Record<string, string> // name → component nodeId
  rootComponentId: string | null
  tokens: Record<string, string> // tokenName → tokenNodeId
  derived: Record<string, string>
  styles: Record<string, string>
}

export function compile(parsed: ParseResult): CompileResult {
  const nodes: EctoNode[] = []
  const edges: EctoEdge[] = []
  const errors: CompileResult['errors'] = [...parsed.errors]

  const models: CompileResult['models'] = {}
  const components: CompileResult['components'] = {}
  const tokens: CompileResult['tokens'] = {}
  const derived: CompileResult['derived'] = {}
  const styles: CompileResult['styles'] = {}

  let nextId = 0
  const id = (prefix: string) => `${prefix}_${++nextId}`

  const addNode = (
    type: EctoNodeType,
    label: string,
    data?: Record<string, any>,
    explicitId?: string,
  ): EctoNode => {
    const nid = explicitId ?? id(type.toLowerCase())
    const node: EctoNode = { id: nid, type, label, data }
    nodes.push(node)
    return node
  }
  const addEdge = (source: string, target: string, type: EctoEdgeType): EctoEdge => {
    const e: EctoEdge = { id: id('e'), source, target, type }
    edges.push(e)
    return e
  }

  // ---- pass 1: tokens, derived, styles, models ----------------------
  for (const decl of parsed.decls) {
    if (decl.kind === 'token') {
      const t = decl as TokenDecl
      const n = addNode('Token', t.name, { value: t.value })
      tokens[t.name] = n.id
    } else if (decl.kind === 'derived') {
      const d = decl as DerivedDecl
      const n = addNode('DerivedToken', d.name, { expr: d.expr })
      derived[d.name] = n.id
    } else if (decl.kind === 'styles') {
      const s = decl as StylesDecl
      const n = addNode('Style', s.name, {
        props: s.props.map((p) => ({ name: p.name, value: p.value })),
      })
      styles[s.name] = n.id
      // wire up token/derived references inside the style
      for (const p of s.props) {
        for (const v of p.value) {
          if (v.kind === 'ident') {
            if (tokens[v.name]) addEdge(n.id, tokens[v.name], 'USES_TOKEN')
            else if (derived[v.name]) addEdge(n.id, derived[v.name], 'USES_TOKEN')
          } else if (v.kind === 'qualified' && tokens[v.segments[0]]) {
            // e.g. Black.20 — alpha modifier on a token
            addEdge(n.id, tokens[v.segments[0]], 'USES_TOKEN')
          }
        }
      }
    } else if (decl.kind === 'model') {
      const m = decl as ModelDecl
      const modelNode = addNode('Model', m.name)
      const atomIds: Record<string, string> = {}
      for (const s of m.states) {
        const atom = addNode('Atom', `${m.name}.${s.name}`, {
          model: m.name,
          state: s.name,
          initial: s.initial,
        })
        atomIds[s.name] = atom.id
        addEdge(modelNode.id, atom.id, 'HAS_STATE')
        for (const trait of s.traits) {
          const t = addNode('Trait', trait, { trait })
          addEdge(atom.id, t.id, 'HAS_TRAIT')
        }
      }
      models[m.name] = { atomIds }
    }
  }

  // pass 1.5: derived references after first pass (they may reference
  // tokens declared further down the file)
  for (const decl of parsed.decls) {
    if (decl.kind !== 'derived') continue
    const dNodeId = derived[(decl as DerivedDecl).name]
    walkDerived((decl as DerivedDecl).expr, (segs) => {
      if (segs.length === 1) {
        if (tokens[segs[0]]) addEdge(dNodeId, tokens[segs[0]], 'DERIVES_FROM')
        else if (derived[segs[0]]) addEdge(dNodeId, derived[segs[0]], 'DERIVES_FROM')
      }
    })
  }

  // ---- pass 2: components -------------------------------------------
  for (const decl of parsed.decls) {
    if (decl.kind !== 'component') continue
    const c = decl as ComponentDecl
    const cNode = addNode('Component', c.name, { name: c.name })
    components[c.name] = cNode.id

    // model uses — component owns its own model bindings
    for (const u of c.uses) {
      const target = models[u.model]
      if (!target) {
        errors.push({
          message: `component ${c.name}: uses unknown model "${u.model}"`,
          line: u.pos.line,
        })
        continue
      }
      // Wire the component to the model itself.
      const modelNodeId = nodes.find((n) => n.type === 'Model' && n.label === u.model)?.id
      if (modelNodeId) addEdge(cNode.id, modelNodeId, 'USES_MODEL')
      for (const trait of u.traits) {
        const t = addNode('Trait', trait, { trait })
        addEdge(cNode.id, t.id, 'HAS_TRAIT')
      }
    }

    // component-local state
    for (const s of c.states as StateDecl[]) {
      const atom = addNode('Atom', `${c.name}.${s.name}`, {
        component: c.name,
        state: s.name,
        initial: s.initial,
      })
      addEdge(cNode.id, atom.id, 'HAS_STATE')
      // record under a synthetic model so the runtime can resolve
      // local atoms by component name
      models[c.name] = models[c.name] ?? { atomIds: {} }
      models[c.name].atomIds[s.name] = atom.id
      for (const trait of s.traits) {
        const t = addNode('Trait', trait, { trait })
        addEdge(atom.id, t.id, 'HAS_TRAIT')
      }
    }

    // render tree
    if (c.render) {
      const rootId = compileElement(c.render, cNode.id, c.name)
      // root element is the first HAS_ELEMENT
      addEdge(cNode.id, rootId, 'HAS_ELEMENT')
    }
  }

  // Convenience: pick the first component as root unless something has a
  // different convention. We deliberately prefer a component named "App"
  // or "Task" — common starter names — and fall back to the first
  // declared component otherwise.
  const componentNames = Object.keys(components)
  const preferred = ['App', 'Task'].find((n) => components[n])
  const rootComponentId = preferred
    ? components[preferred]
    : componentNames.length > 0
    ? components[componentNames[0]]
    : null

  function compileElement(el: ElementNode, parentId: string, componentName: string): string {
    const elNode = addNode('Element', el.name, {
      name: el.name,
      when: el.when,
      traits: el.traits,
    })
    if (parentId) addEdge(parentId, elNode.id, 'HAS_CHILD')

    for (const styleName of el.styles) {
      if (styles[styleName]) addEdge(elNode.id, styles[styleName], 'USES_STYLE')
    }
    for (const trait of el.traits) {
      const t = addNode('Trait', trait, { trait })
      addEdge(elNode.id, t.id, 'HAS_TRAIT')
    }
    if (el.when) {
      const cond = addNode('Condition', `when ${el.when}`, { atom: el.when })
      addEdge(elNode.id, cond.id, 'HAS_TRAIT')
      const atomId = resolveAtomId(el.when, componentName, models)
      if (atomId) addEdge(cond.id, atomId, 'READS')
    }

    for (const b of el.bindings as BindingDecl[]) {
      const atomId = resolveAtomId(b.target.join('.'), componentName, models)
      const bNode = addNode('Binding', `${el.name}.${b.prop}`, {
        prop: b.prop,
        target: b.target,
      })
      addEdge(elNode.id, bNode.id, 'BINDS')
      if (atomId) {
        addEdge(bNode.id, atomId, 'READS')
        addEdge(bNode.id, atomId, 'WRITES')
      }
    }

    for (const ev of el.events) {
      const evNode = addNode('Event', ev.event, { event: ev.event })
      addEdge(elNode.id, evNode.id, 'HAS_EVENT')
      for (const a of ev.actions as ActionNode[]) {
        const aNode = addNode('Action', `${a.op} ${a.target.join('.')}`, {
          op: a.op,
          target: a.target,
        })
        addEdge(evNode.id, aNode.id, 'TRIGGERS')
        const atomId = resolveAtomId(a.target.join('.'), componentName, models)
        if (atomId) addEdge(aNode.id, atomId, 'WRITES')
      }
    }

    for (const child of el.children) {
      compileElement(child, elNode.id, componentName)
    }
    return elNode.id
  }

  return {
    graph: { nodes, edges },
    errors,
    models,
    components,
    rootComponentId,
    tokens,
    derived,
    styles,
  }
}

function resolveAtomId(
  path: string,
  componentName: string,
  models: CompileResult['models'],
): string | null {
  const segs = path.split('.')
  if (segs.length === 1) {
    // local atom — owned by the component
    return models[componentName]?.atomIds[segs[0]] ?? null
  }
  const [model, ...rest] = segs
  return models[model]?.atomIds[rest.join('.')] ?? null
}

function walkDerived(expr: any, onRef: (segs: string[]) => void): void {
  if (!expr) return
  if (expr.kind === 'ref') onRef([expr.name])
  if (expr.kind === 'ifElse') {
    onRef(expr.cond.segments)
    walkDerived(expr.then, onRef)
    walkDerived(expr.else, onRef)
  }
}
