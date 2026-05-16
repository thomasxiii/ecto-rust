import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'

// ── Common interface ─────────────────────────────────────────────────

export interface ProviderStreamCallbacks {
  onText: (chunk: string) => void
  isCancelled: () => boolean
}

export interface ProviderResult {
  fullText: string
  stopReason: string
}

export interface CompletionInput {
  model: string
  system: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  maxTokens: number
}

export interface ModelProvider {
  streamCompletion(input: CompletionInput, callbacks: ProviderStreamCallbacks): Promise<ProviderResult>
}

// ── Anthropic ────────────────────────────────────────────────────────

let _anthropic: Anthropic | null = null
function getAnthropic(): Anthropic {
  if (_anthropic) return _anthropic
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set. Add it to .env.local at the repo root.')
  }
  _anthropic = new Anthropic()
  return _anthropic
}

class AnthropicProvider implements ModelProvider {
  async streamCompletion(input: CompletionInput, callbacks: ProviderStreamCallbacks): Promise<ProviderResult> {
    // Build Anthropic-specific messages with cache_control on first user block
    const messages: Anthropic.MessageParam[] = []
    for (let i = 0; i < input.messages.length; i++) {
      const msg = input.messages[i]
      if (i === 0 && msg.role === 'user') {
        messages.push({
          role: 'user',
          content: [
            { type: 'text', text: msg.content, cache_control: { type: 'ephemeral' } },
          ],
        })
      } else {
        messages.push({ role: msg.role, content: msg.content })
      }
    }

    const stream = getAnthropic().messages.stream({
      model: input.model,
      max_tokens: input.maxTokens,
      system: input.system,
      messages,
    })

    let raw = ''
    stream.on('text', (text) => {
      if (callbacks.isCancelled()) {
        stream.abort()
        return
      }
      raw += text
      callbacks.onText(text)
    })

    const finalMessage = await stream.finalMessage()

    if (callbacks.isCancelled()) {
      return { fullText: '', stopReason: 'cancelled' }
    }

    // Use the complete final text
    raw = ''
    for (const block of finalMessage.content) {
      if (block.type === 'text') raw += block.text
    }

    return {
      fullText: raw,
      stopReason: finalMessage.stop_reason ?? 'end_turn',
    }
  }
}

// ── OpenAI ───────────────────────────────────────────────────────────

let _openai: OpenAI | null = null
function getOpenAI(): OpenAI {
  if (_openai) return _openai
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set. Add it to .env.local at the repo root.')
  }
  _openai = new OpenAI()
  return _openai
}

class OpenAIProvider implements ModelProvider {
  async streamCompletion(input: CompletionInput, callbacks: ProviderStreamCallbacks): Promise<ProviderResult> {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: input.system },
      ...input.messages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    ]

    const stream = await getOpenAI().chat.completions.create({
      model: input.model,
      max_completion_tokens: input.maxTokens,
      messages,
      stream: true,
      response_format: { type: 'json_object' },
    })

    let raw = ''
    let stopReason = 'end_turn'

    for await (const chunk of stream) {
      if (callbacks.isCancelled()) break
      const delta = chunk.choices[0]?.delta?.content
      if (delta) {
        raw += delta
        callbacks.onText(delta)
      }
      if (chunk.choices[0]?.finish_reason) {
        stopReason = chunk.choices[0].finish_reason === 'length' ? 'max_tokens' : 'end_turn'
      }
    }

    return { fullText: raw, stopReason }
  }
}

// ── Ollama (OpenAI-compatible API) ───────────────────────────────────

let _ollama: OpenAI | null = null
function getOllama(): OpenAI {
  if (_ollama) return _ollama
  _ollama = new OpenAI({
    baseURL: process.env.OLLAMA_URL ?? 'http://localhost:11434/v1/',
    apiKey: 'ollama',
  })
  return _ollama
}

class OllamaProvider implements ModelProvider {
  async streamCompletion(input: CompletionInput, callbacks: ProviderStreamCallbacks): Promise<ProviderResult> {
    const messages: OpenAI.ChatCompletionMessageParam[] = [
      { role: 'system', content: input.system },
      ...input.messages.map(m => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    ]

    let stream: AsyncIterable<OpenAI.ChatCompletionChunk>
    try {
      stream = await getOllama().chat.completions.create({
        model: input.model,
        messages,
        stream: true,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
        throw new Error('Local model unavailable. Is Ollama running? Try: ollama serve')
      }
      throw err
    }

    let raw = ''
    let stopReason = 'end_turn'

    for await (const chunk of stream) {
      if (callbacks.isCancelled()) break
      const delta = chunk.choices[0]?.delta?.content
      if (delta) {
        raw += delta
        callbacks.onText(delta)
      }
      if (chunk.choices[0]?.finish_reason) {
        stopReason = chunk.choices[0].finish_reason === 'length' ? 'max_tokens' : 'end_turn'
      }
    }

    return { fullText: raw, stopReason }
  }
}

// ── Factory ──────────────────────────────────────────────────────────

const anthropicProvider = new AnthropicProvider()
const openaiProvider = new OpenAIProvider()
const ollamaProvider = new OllamaProvider()

export function getProvider(modelId: string): { provider: ModelProvider; resolvedModel: string } {
  if (modelId.startsWith('ollama:')) {
    const model = modelId.slice(7) || 'qwen2.5-coder:3b'
    return { provider: ollamaProvider, resolvedModel: model }
  }
  if (modelId.startsWith('gpt-') || modelId.startsWith('o1') || modelId.startsWith('o3') || modelId.startsWith('o4')) {
    return { provider: openaiProvider, resolvedModel: modelId }
  }
  // Default: Anthropic
  return { provider: anthropicProvider, resolvedModel: modelId }
}

// ── Ollama model discovery ───────────────────────────────────────────

export async function discoverOllamaModels(): Promise<string[]> {
  const url = process.env.OLLAMA_URL
    ? process.env.OLLAMA_URL.replace(/\/v1\/?$/, '/api/tags')
    : 'http://localhost:11434/api/tags'
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return []
    const data = await res.json() as { models?: Array<{ name: string }> }
    return (data.models ?? []).map(m => m.name)
  } catch {
    return []
  }
}
