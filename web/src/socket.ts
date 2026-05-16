// Thin socket.io transport. The wire protocol matches ecto-engine's
// shared SOCKET event names so the lifted server works unchanged.

import { io, type Socket } from 'socket.io-client'

const SERVER_URL = (import.meta.env.VITE_SERVER_URL as string) ?? 'http://localhost:4000'

export const SOCKET = {
  subscribeProject: 'subscribe_project',
  unsubscribeProject: 'unsubscribe_project',
  graphEvent: 'graph_event',
  mutate: 'mutate',
  agentStart: 'agent:start',
  agentThinking: 'agent:thinking',
  agentOpApplied: 'agent:op_applied',
  agentOpSkipped: 'agent:op_skipped',
  agentDone: 'agent:done',
  agentError: 'agent:error',
  agentCancel: 'agent:cancel',
} as const

let socket: Socket | null = null

export function getSocket(): Socket {
  if (!socket) {
    socket = io(SERVER_URL, { transports: ['websocket'], autoConnect: true })
  }
  return socket
}

export function isServerLikelyDown(): boolean {
  return !socket?.connected
}

export interface ServerGraphEvent {
  type:
    | 'node_created'
    | 'node_updated'
    | 'node_removed'
    | 'edge_created'
    | 'edge_updated'
    | 'edge_removed'
    | 'import_completed'
  projectId: string
  node?: any
  edge?: any
  nodeId?: string
  edgeId?: string
}

export function subscribeProject(projectId: string, onEvent: (e: ServerGraphEvent) => void): () => void {
  const s = getSocket()
  const handler = (e: ServerGraphEvent) => {
    if (e.projectId === projectId) onEvent(e)
  }
  s.on(SOCKET.graphEvent, handler)
  const join = () => s.emit(SOCKET.subscribeProject, projectId)
  if (s.connected) join()
  else s.once('connect', join)
  return () => {
    s.off(SOCKET.graphEvent, handler)
    s.emit(SOCKET.unsubscribeProject, projectId)
  }
}

export function emitMutation(mutation: any): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    getSocket().emit(SOCKET.mutate, mutation, (ack: any) =>
      resolve(ack ?? { ok: true }),
    )
  })
}

export interface AgentStreamHandlers {
  onThinking?: (agentId: string, text: string) => void
  onOpApplied?: (agentId: string, opIndex: number, op: any, touchedNodeId: string | null) => void
  onOpSkipped?: (agentId: string, opIndex: number, op: any, reason: string) => void
  onDone?: (agentId: string, summary: { reasoning: string; appliedCount: number; skippedCount: number }) => void
  onError?: (agentId: string, error: string) => void
}

export function bindAgentStream(handlers: AgentStreamHandlers): () => void {
  const s = getSocket()
  const t = (m: any) => handlers.onThinking?.(m.agentId, m.text)
  const a = (m: any) => handlers.onOpApplied?.(m.agentId, m.opIndex, m.op, m.touchedNodeId ?? null)
  const k = (m: any) => handlers.onOpSkipped?.(m.agentId, m.opIndex, m.op, m.reason)
  const d = (m: any) => handlers.onDone?.(m.agentId, m)
  const e = (m: any) => handlers.onError?.(m.agentId, m.error)
  s.on(SOCKET.agentThinking, t)
  s.on(SOCKET.agentOpApplied, a)
  s.on(SOCKET.agentOpSkipped, k)
  s.on(SOCKET.agentDone, d)
  s.on(SOCKET.agentError, e)
  return () => {
    s.off(SOCKET.agentThinking, t)
    s.off(SOCKET.agentOpApplied, a)
    s.off(SOCKET.agentOpSkipped, k)
    s.off(SOCKET.agentDone, d)
    s.off(SOCKET.agentError, e)
  }
}

export function emitAgentStart(msg: {
  agentId: string
  projectId: string
  prompt: string
  selectedNodeId: string | null
  conversationHistory: { role: 'user' | 'assistant'; content: string }[]
  agentColor: string
  modelId?: string
}): void {
  getSocket().emit(SOCKET.agentStart, msg)
}

export function emitAgentCancel(agentId: string): void {
  getSocket().emit(SOCKET.agentCancel, { agentId })
}

// ── REST helpers ─────────────────────────────────────────────────────

export async function postImport(payload: {
  projectName: string
  rootPathLabel: string
  nodes: any[]
  edges: any[]
  entryNodeId: string | null
}): Promise<{ project: { id: string }; nodeCount: number; edgeCount: number }> {
  const res = await fetch(`${SERVER_URL}/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (!res.ok) throw new Error(`import failed: ${res.status}`)
  return res.json()
}

export async function fetchProjectGraph(projectId: string): Promise<{ project: any; graph: { nodes: any[]; edges: any[] } }> {
  const res = await fetch(`${SERVER_URL}/projects/${projectId}/graph`)
  if (!res.ok) throw new Error(`graph fetch failed: ${res.status}`)
  return res.json()
}

export async function listProjects(): Promise<any[]> {
  const res = await fetch(`${SERVER_URL}/projects`)
  if (!res.ok) return []
  const data = await res.json()
  return data.projects ?? []
}
