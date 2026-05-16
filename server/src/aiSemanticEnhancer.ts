import Anthropic from '@anthropic-ai/sdk'
import type { GraphNode, GraphEdge, GraphPayload } from '@ecto/shared'

// Lazy-init: skip until first call so missing API key doesn't break boot.
let _client: Anthropic | null = null
function client(): Anthropic {
  if (_client) return _client
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. Add it to .env.local at the repo root.',
    )
  }
  _client = new Anthropic()
  return _client
}

export interface SemanticEnhancement {
  nodeId: string
  displayName: string
  description: string
  importance: number
  userFacingCategory?: string
}

export interface EnhanceResult {
  enhancements: SemanticEnhancement[]
}

const SYSTEM_PROMPT = `You are an expert UI/UX analyst. Given a graph of a web application's code structure, you produce human-friendly labels, descriptions, and importance scores for the UI components and elements.

Your job is to look at each component and element and determine:
1. A short, intuitive displayName (what a designer would call it). Examples: "Hero Section", "Primary CTA", "Email Input", "Nav Bar", "Pricing Card", "Sign Up Form"
2. A brief description (1 sentence) explaining what this element does from the user's perspective
3. An importance score from 0-1 indicating how important this element is for the user to see/edit. Top-level pages and key interactive elements score high. Generic wrappers score low.
4. A userFacingCategory: one of "page", "section", "navigation", "form", "input", "button", "link", "media", "text", "container", "card", "list", "modal", "other"

Rules:
- Be concise and designer-friendly in naming. "Sign Up Form" not "SignupForm component".
- Infer purpose from component names, prop names, text content, and structure.
- A component named "Header" that renders nav links is a "Navigation Header", not just "Header".
- Elements with onClick handlers on buttons are "CTA" or "Action Button" type things.
- Score pages/screens at 0.95+, key sections at 0.8+, interactive elements at 0.7+, generic containers at 0.2-0.4.
- Only enhance nodes that you receive — don't invent new ones.`

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['enhancements'],
  properties: {
    enhancements: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['nodeId', 'displayName', 'description', 'importance'],
        properties: {
          nodeId: { type: 'string' },
          displayName: { type: 'string' },
          description: { type: 'string' },
          importance: { type: 'number' },
          userFacingCategory: { type: 'string' },
        },
      },
    },
  },
} as const

export async function enhanceSemanticLayer(input: {
  projectName: string
  payload: GraphPayload
  semanticNodes: GraphNode[]
}): Promise<EnhanceResult> {
  // Build a compact summary of the mechanical graph + semantic nodes
  const context = buildEnhancementContext(input.payload, input.semanticNodes, input.projectName)

  const response = await client().messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 8000,
    output_config: {
      format: { type: 'json_schema', schema: SCHEMA as { [k: string]: unknown } },
    },
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: context,
            cache_control: { type: 'ephemeral' },
          },
          {
            type: 'text',
            text: 'Analyze these components and elements. Return enhanced labels, descriptions, and importance scores for each semantic node listed above.',
          },
        ],
      },
    ],
  })

  let raw = ''
  for (const block of response.content) {
    if (block.type === 'text') raw += block.text
  }
  if (!raw.trim()) {
    throw new Error('Claude returned no text content')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`Claude response was not valid JSON. First 300 chars: ${raw.slice(0, 300)}`)
  }

  const obj = (parsed ?? {}) as Record<string, unknown>
  const enhancements = Array.isArray(obj.enhancements) ? obj.enhancements as SemanticEnhancement[] : []

  return { enhancements }
}

function buildEnhancementContext(
  payload: GraphPayload,
  semanticNodes: GraphNode[],
  projectName: string,
): string {
  const nodes = new Map<string, GraphNode>()
  for (const n of payload.nodes) nodes.set(n.id, n)

  const sections: string[] = []
  sections.push(`Project: ${projectName}`)
  sections.push('')

  // List components with their structure
  const components = payload.nodes.filter(n => n.type === 'component')
  sections.push(`Components (${components.length}):`)
  for (const c of components) {
    const file = c.source?.filePath ? ` [${c.source.filePath}]` : ''
    const flag = c.data?.isDefault ? ' (default export)' : c.data?.exported ? ' (exported)' : ''

    // Find what this component renders
    const renderTargets = payload.edges
      .filter(e => e.fromNodeId === c.id && e.type === 'renders')
      .map(e => nodes.get(e.toNodeId))
      .filter(Boolean) as GraphNode[]

    const children = renderTargets.map(t => {
      const tag = t.data?.tagName ?? t.name
      // Find text content
      const textEdge = payload.edges.find(e => e.fromNodeId === t.id && (e.type === 'child_of' || e.type === 'renders'))
      const textNode = textEdge ? nodes.get(textEdge.toNodeId) : null
      const textContent = textNode?.type === 'text' ? ` "${String(textNode.data?.value ?? '').slice(0, 40)}"` : ''
      // Find props
      const propEdges = payload.edges.filter(e => e.fromNodeId === t.id && e.type === 'binds_prop')
      const propSummary = propEdges
        .map(e => nodes.get(e.toNodeId))
        .filter(Boolean)
        .map(p => `${p!.name}=${JSON.stringify(p!.data?.value ?? '').slice(0, 20)}`)
        .slice(0, 4)
        .join(', ')
      return `    <${tag}${propSummary ? ` ${propSummary}` : ''}>${textContent}`
    }).slice(0, 8)

    // Find state
    const stateEdges = payload.edges.filter(e => e.fromNodeId === c.id && e.type === 'owns_state')
    const states = stateEdges.map(e => nodes.get(e.toNodeId)).filter(Boolean).map(s => s!.name)

    sections.push(`  ${c.name}${flag}${file}`)
    if (children.length > 0) sections.push(`    renders: ${children.join('\n')}`)
    if (states.length > 0) sections.push(`    state: [${states.join(', ')}]`)
  }

  // List semantic nodes to enhance
  sections.push('')
  sections.push(`Semantic nodes to enhance (${semanticNodes.length}):`)
  for (const n of semanticNodes) {
    const type = n.type.replace('semantic_', '')
    const mechId = n.data?.mechanicalComponentId ?? n.data?.mechanicalElementId ?? n.data?.mechanicalStyleId ?? n.data?.mechanicalStateId
    const mechNode = mechId ? nodes.get(mechId as string) : null
    const mechInfo = mechNode ? ` [from ${mechNode.type}:${mechNode.name}]` : ''
    const caps = (n.data?.capabilities as string[])?.join(', ') ?? ''
    sections.push(`  ${n.id}: ${type} "${n.name}"${mechInfo}${caps ? ` caps=[${caps}]` : ''}`)
  }

  return sections.join('\n')
}
