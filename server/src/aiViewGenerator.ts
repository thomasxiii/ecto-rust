import Anthropic from '@anthropic-ai/sdk'
import type { GraphPayload } from '@ecto/shared'
import { summarizeGraph } from './graphSummary.js'
import { getProvider } from './modelProvider.js'

// ─── Output shapes (kept aligned with web/src/lib/viewsStore.ts) ──────

export interface CanvasFrameSpec {
  id: string
  kind: 'component'
  rootNodeId: string
  x: number
  y: number
  width: number
  height: number
  label?: string
}

export type CanvasArrowEndpoint =
  | { x: number; y: number }
  | { frameId: string; anchor?: 'auto' | 'top' | 'right' | 'bottom' | 'left' }

export type CanvasPrimitiveSpec =
  | {
      id: string
      kind: 'text'
      x: number
      y: number
      width: number
      height: number
      text: string
      fontSize?: number
      color?: string
    }
  | {
      id: string
      kind: 'arrow'
      from: CanvasArrowEndpoint
      to: CanvasArrowEndpoint
      label?: string
      color?: string
      style?: 'solid' | 'dashed'
    }

export interface ViewGenerationResult {
  title: string
  reasoning: string
  frames: CanvasFrameSpec[]
  primitives: CanvasPrimitiveSpec[]
}

// ─── Prompt + schema ──────────────────────────────────────────────────

const SYSTEM_PROMPT = `You generate canvas view specs for a graph-backed app builder. The user describes what they want to see; you place graph component frames on a 2D canvas and draw arrows + text labels between them.

Rules:
- Reference graph components by their componentCode (e.g. "c3") from the provided list. NEVER invent codes.
- Pick the SMALLEST set of components that meaningfully answers the user's prompt — typically 2–6 frames. Prefer relevance over completeness.
- Default frame size: 380 wide × 560 tall (mobile-portrait). Use these defaults unless the user implies a different shape.
- Layout: place frames left-to-right in flow order with at least 80px horizontal gap. For multi-row layouts, use 80px vertical gap. The canvas origin (0,0) is the natural starting point — center the layout around it.
- Arrows: use frame-to-frame arrows to show navigation, triggers, or relationships supported by the graph. Reference frames by their string \`key\`. Always set both \`fromFrame\` and \`toFrame\` to keys that exist in your frames array.
- Text blocks: use sparingly to title sections (place above frames at y < 0). Default fontSize 18 for headings, 13 for notes.
- If the prompt is vague, default to the project's likely entry point (a component named App / Home / Index, or a default-export component) and one or two related frames.
- Don't invent components, routes, or relationships that aren't in the provided context.

Title: 2–5 words capturing the view's intent.
Reasoning: 1–2 sentences explaining why these frames + connections answer the prompt.`

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'reasoning', 'frames', 'texts', 'arrows'],
  properties: {
    title: { type: 'string' },
    reasoning: { type: 'string' },
    frames: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'componentCode', 'x', 'y'],
        properties: {
          key: { type: 'string', description: 'Identifier referenced by arrows' },
          componentCode: { type: 'string', description: 'A code like "c3" from the components list' },
          x: { type: 'number' },
          y: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
          label: { type: 'string' },
        },
      },
    },
    texts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['x', 'y', 'text'],
        properties: {
          x: { type: 'number' },
          y: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
          text: { type: 'string' },
          fontSize: { type: 'number' },
        },
      },
    },
    arrows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['fromFrame', 'toFrame'],
        properties: {
          fromFrame: { type: 'string' },
          toFrame: { type: 'string' },
          label: { type: 'string' },
          style: { type: 'string', enum: ['solid', 'dashed'] },
        },
      },
    },
  },
} as const

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

function makeId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

// ─── Generator ─────────────────────────────────────────────────────────

const DEFAULT_VIEW_MODEL = 'claude-opus-4-7'

export async function generateView(input: {
  projectName: string
  prompt: string
  payload: GraphPayload
  modelId?: string
}): Promise<ViewGenerationResult> {
  const summary = summarizeGraph(input.payload, input.projectName)
  const modelId = input.modelId ?? DEFAULT_VIEW_MODEL

  // For Anthropic models, use the structured output path (json_schema)
  const isAnthropic = !modelId.startsWith('ollama:') && !modelId.startsWith('gpt-') && !modelId.startsWith('o1') && !modelId.startsWith('o3') && !modelId.startsWith('o4')

  let raw: string

  if (isAnthropic) {
    // Anthropic path — structured output with JSON schema constraint
    const response = await client().messages.create({
      model: modelId,
      max_tokens: 8000,
      output_config: {
        format: { type: 'json_schema', schema: SCHEMA as { [k: string]: unknown } },
        effort: 'medium',
      },
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: summary.text, cache_control: { type: 'ephemeral' } },
            { type: 'text', text: `User wants to see: ${input.prompt}` },
          ],
        },
      ],
    })

    raw = ''
    for (const block of response.content) {
      if (block.type === 'text') raw += block.text
    }
  } else {
    // OpenAI / Ollama path — include schema in prompt, parse JSON from response
    const schemaHint = `\n\nRespond with ONLY a valid JSON object matching this schema:\n${JSON.stringify(SCHEMA, null, 2)}`
    const { provider, resolvedModel } = getProvider(modelId)

    const result = await provider.streamCompletion(
      {
        model: resolvedModel,
        system: SYSTEM_PROMPT + schemaHint,
        messages: [{ role: 'user', content: `${summary.text}\n\nUser wants to see: ${input.prompt}` }],
        maxTokens: 8000,
      },
      { isCancelled: () => false, onText: () => {} },
    )
    raw = result.fullText
  }

  if (!raw.trim()) {
    throw new Error('Model returned no text content')
  }

  // Strip markdown fences if present
  let jsonStr = raw.trim()
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonStr)
  } catch {
    throw new Error(
      `Model response was not valid JSON. First 300 chars: ${jsonStr.slice(0, 300)}`,
    )
  }

  return materialize(parsed, summary.componentByCode)
}

// Translate the model's spec (with componentCode + frame keys) into the
// real frames + primitives the web canvas expects, with stable IDs.
function materialize(
  parsed: unknown,
  componentByCode: Map<string, { id: string; name: string }>,
): ViewGenerationResult {
  const obj = (parsed ?? {}) as Record<string, unknown>
  const rawFrames = Array.isArray(obj.frames) ? (obj.frames as unknown[]) : []
  const rawTexts = Array.isArray(obj.texts) ? (obj.texts as unknown[]) : []
  const rawArrows = Array.isArray(obj.arrows) ? (obj.arrows as unknown[]) : []

  // Hard caps so a malformed spec can't blow up the canvas.
  const frameCap = 24
  const textCap = 30
  const arrowCap = 40

  const keyToFrameId = new Map<string, string>()
  const frames: CanvasFrameSpec[] = []
  for (const item of rawFrames.slice(0, frameCap)) {
    const f = item as Record<string, unknown>
    const code = String(f.componentCode ?? '')
    const node = componentByCode.get(code)
    if (!node) continue // hallucinated code — drop silently
    const id = makeId('frame')
    const key = String(f.key ?? id)
    keyToFrameId.set(key, id)
    frames.push({
      id,
      kind: 'component',
      rootNodeId: node.id,
      x: numOr(f.x, 0),
      y: numOr(f.y, 0),
      width: clamp(numOr(f.width, 380), 200, 1200),
      height: clamp(numOr(f.height, 560), 140, 1400),
      label: typeof f.label === 'string' && f.label ? f.label : node.name,
    })
  }

  const primitives: CanvasPrimitiveSpec[] = []
  for (const item of rawTexts.slice(0, textCap)) {
    const t = item as Record<string, unknown>
    const text = String(t.text ?? '').trim()
    if (!text) continue
    primitives.push({
      id: makeId('text'),
      kind: 'text',
      x: numOr(t.x, 0),
      y: numOr(t.y, 0),
      width: clamp(numOr(t.width, 280), 60, 800),
      height: clamp(numOr(t.height, 40), 20, 400),
      text,
      fontSize: t.fontSize != null ? clamp(numOr(t.fontSize, 14), 8, 64) : undefined,
    })
  }
  for (const item of rawArrows.slice(0, arrowCap)) {
    const a = item as Record<string, unknown>
    const fromId = keyToFrameId.get(String(a.fromFrame ?? ''))
    const toId = keyToFrameId.get(String(a.toFrame ?? ''))
    if (!fromId || !toId) continue
    primitives.push({
      id: makeId('arrow'),
      kind: 'arrow',
      from: { frameId: fromId, anchor: 'auto' },
      to: { frameId: toId, anchor: 'auto' },
      label: typeof a.label === 'string' && a.label ? a.label : undefined,
      style: a.style === 'dashed' ? 'dashed' : 'solid',
    })
  }

  return {
    title: String(obj.title ?? '').trim() || 'Untitled view',
    reasoning: String(obj.reasoning ?? '').trim(),
    frames,
    primitives,
  }
}

function numOr(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}
function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}
