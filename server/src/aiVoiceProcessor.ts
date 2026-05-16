import OpenAI from 'openai'
import Anthropic from '@anthropic-ai/sdk'

// ── OpenAI client (for Whisper) ─────────────────────────────────────

let _openai: OpenAI | null = null
function openai(): OpenAI {
  if (_openai) return _openai
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set. Add it to .env.local at the repo root.')
  }
  _openai = new OpenAI()
  return _openai
}

// ── Anthropic client (for action analysis) ──────────────────────────

let _anthropic: Anthropic | null = null
function anthropic(): Anthropic {
  if (_anthropic) return _anthropic
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set.')
  }
  _anthropic = new Anthropic()
  return _anthropic
}

// ── Types ───────────────────────────────────────────────────────────

export interface TranscriptSegment {
  text: string
  start: number // seconds from audio start
  end: number
}

export interface TranscribeResult {
  text: string
  segments: TranscriptSegment[]
}

export interface VoiceAction {
  instruction: string
  timeStart: number // seconds in transcript
  timeEnd: number
  referencesScreen: boolean
  referenceDescription?: string
}

export interface AnalyzeResult {
  actions: VoiceAction[]
}

export interface ElementCandidate {
  nodeId: string
  name: string
  type: string
  tagName?: string
  textContent?: string
  score: number
  leafHits: number
  totalSamples: number
  depth: 'leaf' | 'parent' | 'ancestor'
}

// ── Whisper transcription ───────────────────────────────────────────

export async function transcribeAudio(
  audioBuffer: Buffer,
  mimeType: string,
): Promise<TranscribeResult> {
  const ext = mimeType.includes('webm') ? 'webm' : mimeType.includes('mp4') ? 'mp4' : 'wav'
  const file = new File([new Uint8Array(audioBuffer)], `recording.${ext}`, { type: mimeType })

  const response = await openai().audio.transcriptions.create({
    model: 'whisper-1',
    file,
    response_format: 'verbose_json',
    timestamp_granularities: ['segment'],
  })

  const segments: TranscriptSegment[] = (response as any).segments?.map((seg: any) => ({
    text: seg.text?.trim() ?? '',
    start: seg.start ?? 0,
    end: seg.end ?? 0,
  })) ?? []

  return {
    text: response.text ?? '',
    segments,
  }
}

// ── Action analysis ─────────────────────────────────────────────────

const ANALYZE_SYSTEM = `You are analyzing a voice transcript from a user who is describing changes they want to make to a web application. They are looking at a live preview of the app while speaking and may use their mouse to point at things.

Your job is to break the transcript into discrete action requests. Each action is something the user wants done — a styling change, a content edit, a layout modification, etc.

Key rules:
1. Identify EACH distinct action the user is requesting. One sentence might contain multiple actions.
2. For each action, determine the time range (start/end in seconds) where that action is being described.
3. Determine if the action references something on screen using deictic language like "this", "that", "these", "those", "here", "there", "it", or pointing language like "the thing I'm hovering over", "what I'm pointing at", etc.
4. If the action references screen elements, describe what the reference likely means (e.g. "the element being pointed at", "the group of items being indicated").
5. Rewrite each action as a clear, complete instruction that an AI agent can execute. Replace vague references with placeholders like "[POINTED_ELEMENT]" that will be resolved from mouse data.

Return a JSON object with an "actions" array. Each action has:
- "instruction": string — the clear instruction for the agent
- "timeStart": number — start time in seconds
- "timeEnd": number — end time in seconds
- "referencesScreen": boolean — whether the user referenced something on screen
- "referenceDescription": string | null — description of what they're referencing

Respond with ONLY valid JSON, no markdown fences.`

export async function analyzeVoiceActions(
  transcript: string,
  segments: TranscriptSegment[],
): Promise<AnalyzeResult> {
  const segmentText = segments
    .map(s => `[${s.start.toFixed(1)}s - ${s.end.toFixed(1)}s]: "${s.text}"`)
    .join('\n')

  const userMessage = `Full transcript: "${transcript}"

Segments with timestamps:
${segmentText}

Identify all discrete actions the user is requesting.`

  const response = await anthropic().messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    system: ANALYZE_SYSTEM,
    messages: [{ role: 'user', content: userMessage }],
  })

  let raw = ''
  for (const block of response.content) {
    if (block.type === 'text') raw += block.text
  }

  let parsed: any
  try {
    parsed = JSON.parse(raw.trim())
  } catch {
    const cleaned = raw.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim()
    parsed = JSON.parse(cleaned)
  }

  return {
    actions: Array.isArray(parsed.actions) ? parsed.actions : [],
  }
}

// ── AI element resolution ───────────────────────────────────────────
// Given an action instruction and a ranked list of elements the user
// was hovering over during that time, ask Claude to pick the best match.

const RESOLVE_SYSTEM = `You are helping resolve which UI element a user was referring to when they said something while pointing at their screen.

You will be given:
1. What the user said (their instruction)
2. A scored list of UI elements their mouse cursor was near during that time

Each element has:
- **depth**: "leaf" means the cursor was directly on it, "parent" means it's a direct parent of hovered elements, "ancestor" is a higher-level container
- **score**: weighted score (leaf hits count 1.0, parent 0.3, ancestor 0.1)
- **leafHits**: how many times the cursor was directly on THIS element (not a child)
- **textContent**: visible text inside the element (if any)

IMPORTANT selection rules:
- **Prefer leaf elements** — if the user says "this button" or "this text", pick the specific leaf element with the matching text/tag, not its container
- **Pick containers only when the instruction is about layout/grouping** — e.g., "this section", "this card", "this whole area"
- **Match the instruction's specificity to the element's specificity** — "change this text" → pick the text element; "restyle this section" → pick the section
- **Text content is the strongest signal** — if a leaf element's textContent matches what the user is talking about, pick it
- **Higher score breaks ties** between elements at the same depth level

Return a JSON object with:
- "nodeId": string — the chosen element's nodeId
- "confidence": number — 0 to 1
- "reasoning": string — brief explanation

Respond with ONLY valid JSON.`

export async function resolveElement(
  instruction: string,
  referenceDescription: string | undefined,
  candidates: ElementCandidate[],
): Promise<{ nodeId: string | null; confidence: number; reasoning: string }> {
  if (candidates.length === 0) {
    return { nodeId: null, confidence: 0, reasoning: 'No elements under cursor' }
  }

  // If there's only one leaf candidate, return it directly
  const leaves = candidates.filter(c => c.depth === 'leaf')
  if (leaves.length === 1 && candidates.length <= 3) {
    return {
      nodeId: leaves[0].nodeId,
      confidence: 0.85,
      reasoning: `Direct leaf element: ${leaves[0].name}${leaves[0].textContent ? ` ("${leaves[0].textContent}")` : ''}`,
    }
  }

  const candidateList = candidates
    .map((c, i) => {
      const parts = [
        `${i + 1}. nodeId: "${c.nodeId}"`,
        `name: "${c.name}"`,
        `type: ${c.type}`,
        c.tagName ? `tag: <${c.tagName}>` : null,
        c.textContent ? `text: "${c.textContent}"` : null,
        `depth: ${c.depth}`,
        `score: ${c.score}`,
        `leafHits: ${c.leafHits}/${c.totalSamples}`,
      ].filter(Boolean).join(', ')
      return parts
    })
    .join('\n')

  const userMessage = `User's instruction: "${instruction}"
${referenceDescription ? `They were referring to: "${referenceDescription}"` : ''}

Elements under/near their cursor (ranked by score):
${candidateList}

Which element were they most likely referring to?`

  const response = await anthropic().messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 500,
    system: RESOLVE_SYSTEM,
    messages: [{ role: 'user', content: userMessage }],
  })

  let raw = ''
  for (const block of response.content) {
    if (block.type === 'text') raw += block.text
  }

  try {
    const parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''))
    return {
      nodeId: parsed.nodeId ?? null,
      confidence: parsed.confidence ?? 0,
      reasoning: parsed.reasoning ?? '',
    }
  } catch {
    // Fallback: return the top candidate
    return {
      nodeId: candidates[0].nodeId,
      confidence: 0.5,
      reasoning: 'Parse error, defaulting to most-hovered element',
    }
  }
}
