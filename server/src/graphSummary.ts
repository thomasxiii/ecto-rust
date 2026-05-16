import type { GraphEdge, GraphNode, GraphPayload } from '@ecto/shared'

// Compact text summary of the graph for an LLM. We assign short codes
// (c0, c1, …) to each component instead of sending the raw FNV-hash IDs —
// the model only needs an opaque handle, and short codes save tokens both
// in the prompt and in the model's response.
//
// `componentByCode` maps the short code back to the real graph node so the
// caller can resolve `componentCode` references in the model's output.

export interface GraphSummary {
  text: string
  componentByCode: Map<string, GraphNode>
}

export function summarizeGraph(payload: GraphPayload, projectName: string): GraphSummary {
  const nodes = new Map<string, GraphNode>()
  for (const n of payload.nodes) nodes.set(n.id, n)

  const inEdges = new Map<string, GraphEdge[]>()
  for (const e of payload.edges) {
    if (!inEdges.has(e.toNodeId)) inEdges.set(e.toNodeId, [])
    inEdges.get(e.toNodeId)!.push(e)
  }

  const components: GraphNode[] = []
  for (const n of payload.nodes) if (n.type === 'component') components.push(n)
  components.sort((a, b) => a.name.localeCompare(b.name))

  const codeOf = new Map<string, string>()
  const componentByCode = new Map<string, GraphNode>()
  components.forEach((c, i) => {
    const code = `c${i}`
    codeOf.set(c.id, code)
    componentByCode.set(code, c)
  })

  const componentLines = components.map((c) => {
    const file = c.source?.filePath ? ` — ${c.source.filePath}` : ''
    const flag = c.data?.isDefault
      ? ' [default]'
      : c.data?.exported
        ? ' [exported]'
        : ''
    return `  ${codeOf.get(c.id)}: ${c.name}${flag}${file}`
  })

  // Routes — `entry_for` edges connect a route node to its entry component.
  const routes: string[] = []
  for (const n of payload.nodes) {
    if (n.type !== 'route') continue
    const path = (n.data?.path as string | undefined) ?? n.name
    const entry = payload.edges.find(
      (e) => e.fromNodeId === n.id && e.type === 'entry_for',
    )
    const target = entry ? nodes.get(entry.toNodeId) : null
    const targetCode = target ? (codeOf.get(target.id) ?? '?') : '?'
    routes.push(`  ${path} → ${targetCode}`)
  }

  // Composition — which component renders which.
  const composes = new Set<string>()
  for (const e of payload.edges) {
    if (e.type !== 'renders' && e.type !== 'composes') continue
    const from = nodes.get(e.fromNodeId)
    const to = nodes.get(e.toNodeId)
    if (!from || !to) continue
    if (from.type !== 'component' || to.type !== 'component') continue
    const fromCode = codeOf.get(from.id)
    const toCode = codeOf.get(to.id)
    if (fromCode && toCode && fromCode !== toCode) {
      composes.add(`  ${fromCode} renders ${toCode}`)
    }
  }

  // Navigations — `navigates_to` edges, bubbled up to the owning component.
  const navigations = new Set<string>()
  for (const e of payload.edges) {
    if (e.type !== 'navigates_to') continue
    const owning = findOwningComponent(nodes, inEdges, e.fromNodeId)
    const target = nodes.get(e.toNodeId)
    if (!owning || !target) continue
    const fromCode = codeOf.get(owning.id) ?? '?'
    const targetPath = (target.data?.path as string | undefined) ?? target.name
    const label = (e.data?.label as string | undefined) ?? ''
    navigations.add(`  ${fromCode} → ${targetPath}${label ? ` ("${label}")` : ''}`)
  }

  // Events — only the kind, not the full element subtree.
  const events = new Set<string>()
  for (const n of payload.nodes) {
    if (n.type !== 'event') continue
    const owning = findOwningComponent(nodes, inEdges, n.id)
    const owningCode = owning ? (codeOf.get(owning.id) ?? '?') : '?'
    const trig = payload.edges.find(
      (e) => e.fromNodeId === n.id && e.type === 'triggers',
    )
    const target = trig ? nodes.get(trig.toNodeId) : null
    const eventName = (n.data?.eventName as string | undefined) ?? n.name
    events.add(`  ${owningCode}.${eventName}${target ? ` → ${target.name}` : ''}`)
  }

  const sections: string[] = []
  sections.push(`Project: ${projectName}`)
  sections.push('')
  sections.push(`Components (${components.length}):`)
  sections.push(componentLines.join('\n'))
  if (routes.length > 0) {
    sections.push('', 'Routes:', routes.join('\n'))
  }
  if (composes.size > 0) {
    sections.push('', 'Composition:', [...composes].slice(0, 80).join('\n'))
  }
  if (navigations.size > 0) {
    sections.push('', 'Navigations:', [...navigations].slice(0, 60).join('\n'))
  }
  if (events.size > 0) {
    sections.push('', 'Events:', [...events].slice(0, 60).join('\n'))
  }

  return { text: sections.join('\n'), componentByCode }
}

function findOwningComponent(
  nodes: Map<string, GraphNode>,
  inEdges: Map<string, GraphEdge[]>,
  startId: string,
): GraphNode | null {
  // Walk up via incoming structural edges until we hit a component node.
  // Cap the climb so a malformed graph can't loop forever.
  const visited = new Set<string>([startId])
  const stack = [startId]
  let steps = 0
  while (stack.length > 0 && steps++ < 200) {
    const id = stack.pop()!
    const n = nodes.get(id)
    if (n && n.type === 'component') return n
    for (const e of inEdges.get(id) ?? []) {
      if (
        e.type !== 'contains' &&
        e.type !== 'child_of' &&
        e.type !== 'renders' &&
        e.type !== 'declares' &&
        e.type !== 'composes'
      )
        continue
      if (visited.has(e.fromNodeId)) continue
      visited.add(e.fromNodeId)
      stack.push(e.fromNodeId)
    }
  }
  return null
}
