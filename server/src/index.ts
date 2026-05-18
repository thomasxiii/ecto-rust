import { loadEnvLocal } from './loadEnv.js'
loadEnvLocal()

import path from 'node:path'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import Anthropic from '@anthropic-ai/sdk'
import { Server as SocketIOServer } from 'socket.io'
import type { BundleBuildRequest, GraphEvent, GraphMutation, ImportRequest } from '@ecto/shared'
import { SOCKET, projectRoom } from '@ecto/shared'
import { getBundler } from './bundler/index.js'
import { getSidecarHost, type SidecarImport } from './sidecar/host.js'
import {
  createRevision,
  deleteProject,
  deleteSingleEdge,
  deleteSingleNode,
  getGraph,
  getNode,
  getProject,
  getRevisionSnapshot,
  importProject,
  insertSingleEdge,
  insertSingleNode,
  listEvents,
  listProjects,
  listRevisions,
  renameNode,
  updateEdgeOrder,
  updateNodeData,
  getEdge,
} from './repo.js'
import { generateView } from './aiViewGenerator.js'
import { generateMiniApp } from './aiMiniAppGenerator.js'
import { discoverOllamaModels } from './modelProvider.js'
import { enhanceSemanticLayer } from './aiSemanticEnhancer.js'
import { runAgentPrompt, runAgentPromptStreaming, type AgentOperation, type ConversationMessage } from './aiAgentEngine.js'
import { transcribeAudio, analyzeVoiceActions, resolveElement, type ElementCandidate } from './aiVoiceProcessor.js'
import { checkAndCorrectColors, generateDesignSystemManifest } from './designSystemWatcher.js'

const PORT = Number(process.env.PORT ?? 4000)
const app = Fastify({ logger: true, bodyLimit: 256 * 1024 * 1024 })
await app.register(cors, { origin: true })
await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } }) // 50MB max audio

// Serve compiled npm bundles for the browser sidecar. The cache dir lives
// alongside the server's cwd (.bundle-cache/browser/<hash>.mjs).
const bundler = getBundler()
await bundler.ensureCacheDirs()
await app.register(fastifyStatic, {
  root: path.resolve(process.cwd(), '.bundle-cache', 'browser'),
  prefix: '/bundles/',
  decorateReply: false,
  // Bundles are content-addressed: safe to cache aggressively.
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
  },
})

// ─── REST ────────────────────────────────────────────────────────────────

app.get('/health', async () => ({ ok: true }))

// ─── NPM sidecar bundler ─────────────────────────────────────────────────
//
// POST /api/bundles/build  — compile a package on demand and return its
//   content-addressed hash + URL. Idempotent across calls (CAS).
// GET  /bundles/:hash.mjs  — served via @fastify/static above.

app.post<{ Body: BundleBuildRequest }>(
  '/api/bundles/build',
  async (req, reply) => {
    const { target, name, version, exports } = req.body ?? ({} as BundleBuildRequest)
    if (!target || !name || !version || !Array.isArray(exports)) {
      return reply.code(400).send({ error: 'bad_request', message: 'expected { target, name, version, exports[] }' })
    }
    if (target !== 'browser' && target !== 'server') {
      return reply.code(400).send({ error: 'bad_request', message: 'target must be "browser" or "server"' })
    }
    try {
      const result = await bundler.build({ target, name, version, exports })
      return result
    } catch (err) {
      req.log.error({ err }, 'bundle build failed')
      return reply.code(500).send({ error: 'build_failed', message: err instanceof Error ? err.message : String(err) })
    }
  },
)

// Invoke a ServerFunction body in the Node sidecar subprocess. The body
// runs in a vm-sandboxed scope; `ctx` carries the resolved npm imports.
app.post<{
  Body: {
    body: string
    args?: Record<string, unknown>
    imports?: SidecarImport[]
  }
}>('/api/server-fn/invoke', async (req, reply) => {
  const { body, args, imports } = req.body ?? ({} as { body: string })
  if (typeof body !== 'string') {
    return reply.code(400).send({ error: 'bad_request', message: 'body must be a string' })
  }
  const sidecar = getSidecarHost()
  const out = await sidecar.invoke({
    fn: { body, params: [] },
    args: args ?? {},
    imports: imports ?? [],
  })
  if (out.ok) return out
  return reply.code(500).send(out)
})

app.get('/projects', async () => ({ projects: listProjects() }))

app.get<{ Params: { id: string } }>('/projects/:id', async (req, reply) => {
  const project = getProject(req.params.id)
  if (!project) return reply.code(404).send({ error: 'not_found' })
  return { project }
})

app.get<{ Params: { id: string } }>('/projects/:id/graph', async (req, reply) => {
  const project = getProject(req.params.id)
  if (!project) return reply.code(404).send({ error: 'not_found' })
  return { project, graph: getGraph(req.params.id) }
})

app.get<{ Params: { id: string } }>('/projects/:id/events', async (req, reply) => {
  const project = getProject(req.params.id)
  if (!project) return reply.code(404).send({ error: 'not_found' })
  return { events: listEvents(req.params.id) }
})

app.get<{ Params: { id: string; nodeId: string } }>(
  '/projects/:id/nodes/:nodeId',
  async (req, reply) => {
    const node = getNode(req.params.id, req.params.nodeId)
    if (!node) return reply.code(404).send({ error: 'not_found' })
    return { node }
  },
)

app.patch<{
  Params: { id: string; nodeId: string }
  Body: { data?: Record<string, any>; name?: string }
}>('/projects/:id/nodes/:nodeId', async (req, reply) => {
  const { id, nodeId } = req.params
  const { data, name } = req.body
  let updated = null
  if (data) updated = updateNodeData(id, nodeId, data)
  if (name) updated = renameNode(id, nodeId, name)
  if (!updated) return reply.code(404).send({ error: 'not_found' })
  broadcast({ type: 'node_updated', projectId: id, node: updated })
  return { node: updated }
})

app.post<{ Body: ImportRequest }>('/import', async (req, reply) => {
  try {
    const project = importProject(req.body)
    createRevision(project.id, `Import: ${req.body.projectName}`, 'import')
    broadcast({
      type: 'import_completed',
      projectId: project.id,
      nodeCount: req.body.nodes.length,
      edgeCount: req.body.edges.length,
    })
    return {
      project,
      nodeCount: req.body.nodes.length,
      edgeCount: req.body.edges.length,
    }
  } catch (err) {
    app.log.error(err)
    return reply.code(500).send({ error: 'import_failed', detail: String(err) })
  }
})

// ─── Design System Manifest ──────────────────────────────────────────

app.get<{ Params: { id: string } }>('/projects/:id/design-system', async (req, reply) => {
  const project = getProject(req.params.id)
  if (!project) return reply.code(404).send({ error: 'not_found' })
  return generateDesignSystemManifest(req.params.id)
})

// ─── Timeline / Revisions ─────────────────────────────────────────────

app.get<{ Params: { id: string } }>('/projects/:id/revisions', async (req, reply) => {
  const project = getProject(req.params.id)
  if (!project) return reply.code(404).send({ error: 'not_found' })
  return { revisions: listRevisions(req.params.id) }
})

app.get<{ Params: { id: string; revisionId: string } }>(
  '/projects/:id/revisions/:revisionId',
  async (req, reply) => {
    const snapshot = getRevisionSnapshot(req.params.id, req.params.revisionId)
    if (!snapshot) return reply.code(404).send({ error: 'not_found' })
    return { graph: snapshot }
  },
)

app.delete<{ Params: { id: string } }>('/projects/:id', async (req, reply) => {
  const ok = deleteProject(req.params.id)
  if (!ok) return reply.code(404).send({ error: 'not_found' })
  return { ok: true }
})

// AI canvas-view generator. Takes a user prompt + projectId, summarizes the
// graph for Claude, and returns a frames + primitives spec the web client
// drops directly into a new view.
app.post<{ Body: { projectId?: string; prompt?: string; modelId?: string } }>(
  '/api/views/generate',
  async (req, reply) => {
    const { projectId, prompt, modelId } = req.body ?? {}
    if (!projectId || !prompt || typeof prompt !== 'string') {
      return reply.code(400).send({ error: 'projectId and prompt are required' })
    }
    const project = getProject(projectId)
    if (!project) return reply.code(404).send({ error: 'project_not_found' })
    const payload = getGraph(projectId)
    try {
      const result = await generateView({
        projectName: project.name,
        prompt,
        payload,
        modelId,
      })
      return result
    } catch (err) {
      app.log.error({ err }, 'view generation failed')
      if (err instanceof Anthropic.APIError) {
        return reply.code(err.status ?? 500).send({
          error: 'ai_call_failed',
          message: err.message,
        })
      }
      return reply.code(500).send({
        error: 'ai_call_failed',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  },
)

// Mini-runtime app generator. Takes a natural-language prompt, calls Claude
// with a schema-explaining system prompt, returns a GraphPayload the web
// shell loads into MiniRuntime via `loadGraph`.
app.post<{ Body: { prompt?: string; modelId?: string } }>(
  '/api/mini/generate',
  async (req, reply) => {
    const { prompt, modelId } = req.body ?? {}
    if (!prompt || typeof prompt !== 'string') {
      return reply.code(400).send({ error: 'prompt is required' })
    }
    try {
      const result = await generateMiniApp({ prompt, modelId })
      return result
    } catch (err) {
      app.log.error({ err }, 'mini app generation failed')
      if (err instanceof Anthropic.APIError) {
        return reply.code(err.status ?? 500).send({
          error: 'ai_call_failed',
          message: err.message,
        })
      }
      return reply.code(500).send({
        error: 'ai_call_failed',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  },
)

// Ollama model discovery — returns available local models
app.get('/api/models/ollama', async () => {
  const models = await discoverOllamaModels()
  return { models }
})

// AI semantic layer enhancement. Takes existing semantic nodes and the
// mechanical graph, uses Claude to produce better labels/descriptions.
app.post<{ Body: { projectId?: string; semanticNodes?: any[] } }>(
  '/api/semantic/enhance',
  async (req, reply) => {
    const { projectId, semanticNodes } = req.body ?? {}
    if (!projectId || !semanticNodes || !Array.isArray(semanticNodes)) {
      return reply.code(400).send({ error: 'projectId and semanticNodes are required' })
    }
    const project = getProject(projectId)
    if (!project) return reply.code(404).send({ error: 'project_not_found' })
    const payload = getGraph(projectId)
    try {
      const result = await enhanceSemanticLayer({
        projectName: project.name,
        payload,
        semanticNodes,
      })
      return result
    } catch (err) {
      app.log.error({ err }, 'semantic enhancement failed')
      if (err instanceof Anthropic.APIError) {
        return reply.code(err.status ?? 500).send({
          error: 'ai_call_failed',
          message: err.message,
        })
      }
      return reply.code(500).send({
        error: 'ai_call_failed',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  },
)

// AI agent — takes a user prompt + graph context, returns graph operations,
// applies them to the DB, and broadcasts events to connected clients.
app.post<{
  Body: {
    projectId?: string
    prompt?: string
    selectedNodeId?: string | null
    conversationHistory?: ConversationMessage[]
  }
}>('/api/agent/prompt', async (req, reply) => {
  const { projectId, prompt, selectedNodeId, conversationHistory } = req.body ?? {}
  if (!projectId || !prompt || typeof prompt !== 'string') {
    return reply.code(400).send({ error: 'projectId and prompt are required' })
  }
  const project = getProject(projectId)
  if (!project) return reply.code(404).send({ error: 'project_not_found' })
  const payload = getGraph(projectId)

  try {
    const result = await runAgentPrompt({
      projectName: project.name,
      payload,
      selectedNodeId: selectedNodeId ?? null,
      prompt,
      conversationHistory: conversationHistory ?? [],
    })

    // Apply operations to DB and collect results for the client
    const createdNodes: import('@ecto/shared').GraphNode[] = []
    const createdEdges: import('@ecto/shared').GraphEdge[] = []
    const updatedNodes: import('@ecto/shared').GraphNode[] = []
    const removedNodeIds: string[] = []
    const removedEdgeIds: string[] = []

    for (const op of result.operations) {
      app.log.info({ op: op.op, id: op.id ?? op.nodeId ?? op.targetId, edgeId: op.edgeId, from: op.from, to: op.to }, 'applying agent op')
      try {
        switch (op.op) {
          case 'addNode': {
            if (!op.id || !op.nodeType || !op.name) break
            const data = op.data ?? {}
            // Agent-created class-kind style nodes need a synthesizedId for the
            // stylesheet generator to pick them up. Mirror what the importer does.
            if (op.nodeType === 'style' && data.kind === 'class' && !data.synthesizedId) {
              data.synthesizedId = `ecto-${op.id}`
            }
            // Agent-created components must be exported so they appear in the
            // preview root selector dropdown.
            if (op.nodeType === 'component' && !data.exported && !data.isDefault) {
              data.exported = true
            }
            const node = insertSingleNode(projectId, {
              id: op.id,
              type: op.nodeType,
              name: op.name,
              data,
            })
            createdNodes.push(node)
            broadcast({ type: 'node_created', projectId, node })
            break
          }
          case 'addEdge': {
            if (!op.from || !op.to || !op.edgeType) break
            const edge = insertSingleEdge(projectId, {
              id: op.edgeId ?? `edge-${op.from}-${op.to}`,
              fromNodeId: op.from,
              toNodeId: op.to,
              type: op.edgeType,
              order: op.order,
            })
            createdEdges.push(edge)
            broadcast({ type: 'edge_created', projectId, edge })
            break
          }
          case 'updateNode': {
            if (!op.nodeId || !op.patch) {
              app.log.warn({ op }, 'updateNode missing nodeId or patch')
              break
            }
            const updated = updateNodeData(projectId, op.nodeId, op.patch)
            if (updated) {
              updatedNodes.push(updated)
              broadcast({ type: 'node_updated', projectId, node: updated })
            } else {
              app.log.warn({ nodeId: op.nodeId }, 'updateNode: node not found in DB')
            }
            break
          }
          case 'updateEdge': {
            if (!op.edgeId || op.order == null) {
              app.log.warn({ op }, 'updateEdge missing edgeId or order')
              break
            }
            const updatedEdge = updateEdgeOrder(projectId, op.edgeId, op.order)
            if (updatedEdge) {
              createdEdges.push(updatedEdge) // reuse createdEdges to send back to client
              broadcast({ type: 'edge_updated', projectId, edge: updatedEdge })
            } else {
              app.log.warn({ edgeId: op.edgeId }, 'updateEdge: edge not found in DB')
            }
            break
          }
          case 'removeNode': {
            if (!op.targetId) break
            if (deleteSingleNode(projectId, op.targetId)) {
              removedNodeIds.push(op.targetId)
              broadcast({ type: 'node_removed', projectId, nodeId: op.targetId })
            }
            break
          }
          case 'removeEdge': {
            if (!op.targetId) break
            if (deleteSingleEdge(projectId, op.targetId)) {
              removedEdgeIds.push(op.targetId)
              broadcast({ type: 'edge_removed', projectId, edgeId: op.targetId })
            }
            break
          }
        }
      } catch (opErr) {
        app.log.warn({ op, err: opErr }, 'agent operation failed')
      }
    }

    // Snapshot after agent batch
    if (createdNodes.length || updatedNodes.length || removedNodeIds.length || createdEdges.length || removedEdgeIds.length) {
      createRevision(projectId, `Agent: ${prompt.slice(0, 80)}`, 'agent')
    }

    return {
      reasoning: result.reasoning,
      operations: result.operations,
      createdNodes,
      createdEdges,
      updatedNodes,
      removedNodeIds,
      removedEdgeIds,
    }
  } catch (err) {
    app.log.error({ err }, 'agent prompt failed')
    if (err instanceof Anthropic.APIError) {
      return reply.code(err.status ?? 500).send({
        error: 'ai_call_failed',
        message: err.message,
      })
    }
    return reply.code(500).send({
      error: 'agent_failed',
      message: err instanceof Error ? err.message : String(err),
    })
  }
})

// ─── Voice Processing ─────────────────────────────────────────────────────

app.post('/api/voice/transcribe', async (req, reply) => {
  const data = await req.file()
  if (!data) {
    return reply.code(400).send({ error: 'No audio file provided' })
  }

  const buffer = await data.toBuffer()
  const mimeType = data.mimetype || 'audio/webm'

  try {
    const result = await transcribeAudio(buffer, mimeType)
    return result
  } catch (err) {
    app.log.error({ err }, 'voice transcription failed')
    return reply.code(500).send({
      error: 'transcription_failed',
      message: err instanceof Error ? err.message : String(err),
    })
  }
})

app.post<{
  Body: {
    transcript: string
    segments: Array<{ text: string; start: number; end: number }>
  }
}>('/api/voice/analyze', async (req, reply) => {
  const { transcript, segments } = req.body ?? {}
  if (!transcript || !segments) {
    return reply.code(400).send({ error: 'transcript and segments are required' })
  }

  try {
    const result = await analyzeVoiceActions(transcript, segments)
    return result
  } catch (err) {
    app.log.error({ err }, 'voice action analysis failed')
    return reply.code(500).send({
      error: 'analysis_failed',
      message: err instanceof Error ? err.message : String(err),
    })
  }
})

app.post<{
  Body: {
    instruction: string
    referenceDescription?: string
    candidates: ElementCandidate[]
  }
}>('/api/voice/resolve-element', async (req, reply) => {
  const { instruction, referenceDescription, candidates } = req.body ?? {}
  if (!instruction || !candidates) {
    return reply.code(400).send({ error: 'instruction and candidates are required' })
  }

  try {
    const result = await resolveElement(instruction, referenceDescription, candidates)
    return result
  } catch (err) {
    app.log.error({ err }, 'element resolution failed')
    return reply.code(500).send({
      error: 'resolve_failed',
      message: err instanceof Error ? err.message : String(err),
    })
  }
})

// ─── WebSocket ───────────────────────────────────────────────────────────

// Ensure the sidecar gets torn down with the parent. SIGTERM/SIGINT cover
// nodemon restart, container shutdown, and Ctrl-C. process.on('exit') is
// the last-resort fallback for unhandled exits.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    try {
      getSidecarHost().shutdown()
    } catch {}
    process.exit(0)
  })
}
process.on('exit', () => {
  try {
    getSidecarHost().shutdown()
  } catch {}
})

await app.listen({ port: PORT, host: '0.0.0.0' })

const io = new SocketIOServer(app.server, {
  cors: { origin: true, credentials: true },
})

io.on('connection', (socket) => {
  socket.on(SOCKET.subscribeProject, (projectId: string) => {
    socket.join(projectRoom(projectId))
    app.log.info(`socket ${socket.id} → project ${projectId}`)
  })
  socket.on(SOCKET.unsubscribeProject, (projectId: string) => {
    socket.leave(projectRoom(projectId))
  })
  socket.on(
    SOCKET.mutate,
    (mutation: GraphMutation, ack?: (res: { ok: boolean; error?: string }) => void) => {
      try {
        applyMutation(mutation)
        ack?.({ ok: true })
      } catch (err) {
        ack?.({ ok: false, error: String(err) })
      }
    },
  )

  // ── Streaming agent handler ─────────────────────────────────────
  const activeAgentAborts = new Map<string, () => void>()

  socket.on(SOCKET.agentStart, async (msg: {
    agentId: string
    projectId: string
    prompt: string
    selectedNodeId: string | null
    conversationHistory: ConversationMessage[]
    agentColor: string
    modelId?: string
  }) => {
    const { agentId, projectId, prompt, selectedNodeId, conversationHistory, agentColor, modelId } = msg
    const project = getProject(projectId)
    if (!project) {
      socket.emit(SOCKET.agentError, { agentId, error: 'project_not_found' })
      return
    }

    let cancelled = false
    activeAgentAborts.set(agentId, () => { cancelled = true })
    app.log.info({ agentId, projectId, prompt: prompt.slice(0, 100) }, 'agent:start received')

    const MAX_ROUNDS = 5
    let totalApplied = 0
    let totalSkipped = 0
    let totalOps = 0
    let allSkipped: Array<{ op: string; reason: string }> = []
    let lastReasoning = ''
    let consecutiveEmptyRounds = 0
    // Human-readable log of what was done across rounds, sent in continuation prompts
    const completedWork: string[] = []

    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        if (cancelled) break

        // Re-fetch graph each round so the model sees its own changes
        const payload = getGraph(projectId)

        // On continuation rounds, send a fresh request with the updated graph
        // and a prompt that reminds the model of the original task + JSON format.
        // Include a checklist of what's already been done so it doesn't redo work.
        let currentPrompt: string
        if (round === 0) {
          currentPrompt = prompt
        } else {
          const doneList = completedWork.map((w, i) => `  ${i + 1}. ${w}`).join('\n')
          currentPrompt = `The original user request was:\n"${prompt}"\n\nThe following changes have ALREADY been completed — do NOT redo these:\n${doneList}\n\nExamine the graph above to find which parts of the original request still need to be done. Only generate operations for work that is NOT in the completed list above.\n\nIf everything from the original request is complete, respond with: {"reasoning": "All tasks complete.", "operations": []}\n\nYou MUST respond with a JSON object containing "reasoning" and "operations" keys.`
        }
        const currentHistory = round === 0 ? (conversationHistory ?? []) : []

        if (round > 0) {
          socket.emit(SOCKET.agentThinking, {
            agentId,
            text: `\n\n--- Checking for remaining tasks (round ${round + 1}) ---\n`,
          })
        }

        let roundResult: import('./aiAgentEngine.js').AgentResult | null = null

        await runAgentPromptStreaming(
          {
            projectName: project.name,
            payload,
            selectedNodeId: selectedNodeId ?? null,
            prompt: currentPrompt,
            conversationHistory: currentHistory,
            modelId,
          },
          {
            isCancelled: () => cancelled,

            onThinkingChunk: (text) => {
              socket.emit(SOCKET.agentThinking, { agentId, text })
            },

            onOperationsReady: async (result) => {
              if (cancelled) return
              roundResult = result
              app.log.info({ agentId, round, opCount: result.operations.length, stop: result.stopReason }, 'agent ops ready')

              // Apply operations one at a time with validation
              const applied: string[] = []
              const skipped: Array<{ op: AgentOperation; reason: string }> = []

              for (let i = 0; i < result.operations.length; i++) {
                if (cancelled) break
                const op = result.operations[i]

                const conflict = validateOp(projectId, op)
                if (conflict) {
                  skipped.push({ op, reason: conflict })
                  socket.emit(SOCKET.agentOpSkipped, { agentId, opIndex: totalOps + i, op, reason: conflict })
                  app.log.warn({ op: op.op, conflict }, 'agent op skipped (conflict)')
                  continue
                }

                try {
                  const graphEvent = applyAgentOp(projectId, op)
                  if (graphEvent) broadcast(graphEvent)
                  applied.push(opId(op))
                  socket.emit(SOCKET.agentOpApplied, {
                    agentId,
                    opIndex: totalOps + i,
                    op,
                    touchedNodeId: opTouchedNodeId(op),
                    agentColor,
                  })
                } catch (opErr) {
                  skipped.push({ op, reason: String(opErr) })
                  socket.emit(SOCKET.agentOpSkipped, { agentId, opIndex: totalOps + i, op, reason: String(opErr) })
                  app.log.warn({ op, err: opErr }, 'agent op failed')
                }
              }

              totalApplied += applied.length
              totalSkipped += skipped.length
              totalOps += result.operations.length
              allSkipped.push(...skipped.map(s => ({ op: s.op.op, reason: s.reason })))
              lastReasoning = result.reasoning

              // Build human-readable summaries of what was done this round
              for (const op of result.operations) {
                const desc = describeOp(op, projectId)
                if (desc) completedWork.push(desc)
              }

              if (applied.length > 0) {
                createRevision(projectId, `Agent: ${prompt.slice(0, 80)} (round ${round + 1})`, 'agent')
              }
            },
          },
        )

        if (cancelled || !roundResult) break
        const rr = roundResult as import('./aiAgentEngine.js').AgentResult

        // Track consecutive rounds with no operations (parse failures, empty responses)
        if (rr.operations.length === 0) {
          consecutiveEmptyRounds++
        } else {
          consecutiveEmptyRounds = 0
        }

        // Decide whether to continue
        const shouldContinue =
          consecutiveEmptyRounds < 2 && (
            rr.stopReason === 'max_tokens' ||
            (rr.operations.length > 0 && round < MAX_ROUNDS - 1)
          )

        if (!shouldContinue) {
          app.log.info({ agentId, round, stopReason: rr.stopReason, opsThisRound: rr.operations.length }, 'agent stopping — no more work')
          break
        }

        app.log.info({ agentId, round, stopReason: rr.stopReason, opsThisRound: rr.operations.length }, 'agent continuing to next round')
      }

      socket.emit(SOCKET.agentDone, {
        agentId,
        reasoning: lastReasoning,
        totalOps,
        appliedCount: totalApplied,
        skippedCount: totalSkipped,
        skipped: allSkipped,
      })
    } catch (err) {
      if (!cancelled) {
        socket.emit(SOCKET.agentError, {
          agentId,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    } finally {
      activeAgentAborts.delete(agentId)
    }
  })

  socket.on(SOCKET.agentCancel, (msg: { agentId: string }) => {
    const abort = activeAgentAborts.get(msg.agentId)
    if (abort) abort()
    activeAgentAborts.delete(msg.agentId)
  })

  socket.on('disconnect', () => {
    // Cancel all active agents for this socket
    for (const abort of activeAgentAborts.values()) abort()
    activeAgentAborts.clear()
  })
})

// Debounced revision creation for user edits
const userEditTimers = new Map<string, ReturnType<typeof setTimeout>>()

function scheduleUserEditRevision(projectId: string): void {
  const existing = userEditTimers.get(projectId)
  if (existing) clearTimeout(existing)
  userEditTimers.set(
    projectId,
    setTimeout(() => {
      userEditTimers.delete(projectId)
      try {
        createRevision(projectId, 'User edits', 'user_edit')
      } catch (err) {
        app.log.warn({ err }, 'failed to create user-edit revision')
      }
    }, 3000),
  )
}

function applyMutation(m: GraphMutation): void {
  if (m.type === 'update_node_data') {
    const updated = updateNodeData(m.projectId, m.nodeId, m.patch)
    if (updated) broadcast({ type: 'node_updated', projectId: m.projectId, node: updated })
  } else if (m.type === 'rename_node') {
    const updated = renameNode(m.projectId, m.nodeId, m.name)
    if (updated) broadcast({ type: 'node_updated', projectId: m.projectId, node: updated })
  } else if (m.type === 'add_node') {
    const node = insertSingleNode(m.projectId, {
      id: m.node.id,
      type: m.node.type,
      name: m.node.name,
      data: m.node.data,
      source: m.node.source,
    })
    broadcast({ type: 'node_created', projectId: m.projectId, node })
  } else if (m.type === 'add_edge') {
    const edge = insertSingleEdge(m.projectId, {
      id: m.edge.id,
      fromNodeId: m.edge.fromNodeId,
      toNodeId: m.edge.toNodeId,
      type: m.edge.type,
      data: m.edge.data,
      order: m.edge.order,
    })
    broadcast({ type: 'edge_created', projectId: m.projectId, edge })
  } else if (m.type === 'remove_node') {
    if (deleteSingleNode(m.projectId, m.nodeId)) {
      broadcast({ type: 'node_removed', projectId: m.projectId, nodeId: m.nodeId })
    }
  } else if (m.type === 'remove_edge') {
    if (deleteSingleEdge(m.projectId, m.edgeId)) {
      broadcast({ type: 'edge_removed', projectId: m.projectId, edgeId: m.edgeId })
    }
  }
  scheduleUserEditRevision(m.projectId)
}

// ── Agent operation helpers ────────────────────────────────────────────

/** Check if an operation's targets still exist. Returns null if valid, or a reason string. */
function validateOp(projectId: string, op: AgentOperation): string | null {
  switch (op.op) {
    case 'addNode':
      return null // always safe — new node
    case 'addEdge': {
      if (op.from && !getNode(projectId, op.from)) return `source node ${op.from} no longer exists`
      if (op.to && !getNode(projectId, op.to)) return `target node ${op.to} no longer exists`
      return null
    }
    case 'updateNode': {
      if (op.nodeId && !getNode(projectId, op.nodeId)) return `node ${op.nodeId} no longer exists`
      return null
    }
    case 'updateEdge': {
      if (op.edgeId && !getEdge(projectId, op.edgeId)) return `edge ${op.edgeId} no longer exists`
      return null
    }
    case 'removeNode': {
      if (op.targetId && !getNode(projectId, op.targetId)) return `node ${op.targetId} already removed`
      return null
    }
    case 'removeEdge': {
      if (op.targetId && !getEdge(projectId, op.targetId)) return `edge ${op.targetId} already removed`
      return null
    }
  }
  return null
}

/** Apply a single agent operation to the DB. Returns the GraphEvent to broadcast, or null. */
function applyAgentOp(projectId: string, op: AgentOperation): GraphEvent | null {
  switch (op.op) {
    case 'addNode': {
      if (!op.id || !op.nodeType || !op.name) return null
      const data = op.data ?? {}
      if (op.nodeType === 'style' && data.kind === 'class' && !data.synthesizedId) {
        data.synthesizedId = `ecto-${op.id}`
      }
      if (op.nodeType === 'component' && !data.exported && !data.isDefault) {
        data.exported = true
      }
      const node = insertSingleNode(projectId, { id: op.id, type: op.nodeType, name: op.name, data })
      return { type: 'node_created', projectId, node }
    }
    case 'addEdge': {
      if (!op.from || !op.to || !op.edgeType) return null
      const edge = insertSingleEdge(projectId, {
        id: op.edgeId ?? `edge-${op.from}-${op.to}`,
        fromNodeId: op.from,
        toNodeId: op.to,
        type: op.edgeType,
        order: op.order,
      })
      return { type: 'edge_created', projectId, edge }
    }
    case 'updateNode': {
      if (!op.nodeId || !op.patch) return null
      const updated = updateNodeData(projectId, op.nodeId, op.patch)
      return updated ? { type: 'node_updated', projectId, node: updated } : null
    }
    case 'updateEdge': {
      if (!op.edgeId || op.order == null) return null
      const updatedEdge = updateEdgeOrder(projectId, op.edgeId, op.order)
      return updatedEdge ? { type: 'edge_updated', projectId, edge: updatedEdge } : null
    }
    case 'removeNode': {
      if (!op.targetId) return null
      return deleteSingleNode(projectId, op.targetId)
        ? { type: 'node_removed', projectId, nodeId: op.targetId }
        : null
    }
    case 'removeEdge': {
      if (!op.targetId) return null
      return deleteSingleEdge(projectId, op.targetId)
        ? { type: 'edge_removed', projectId, edgeId: op.targetId }
        : null
    }
  }
  return null
}

function opId(op: AgentOperation): string {
  return op.id ?? op.edgeId ?? op.nodeId ?? op.targetId ?? 'unknown'
}

function opTouchedNodeId(op: AgentOperation): string | null {
  switch (op.op) {
    case 'addNode': return op.id ?? null
    case 'addEdge': return op.to ?? null
    case 'updateNode': return op.nodeId ?? null
    case 'removeNode': return op.targetId ?? null
    default: return null
  }
}

/** Produce a human-readable description of an agent operation for the completed-work checklist. */
function describeOp(op: AgentOperation, projectId: string): string | null {
  switch (op.op) {
    case 'addNode':
      return `Created ${op.nodeType} node "${op.name}" (id: ${op.id})`
    case 'addEdge':
      return `Connected ${op.from} → ${op.to} via ${op.edgeType} edge`
    case 'updateNode': {
      const node = getNode(projectId, op.nodeId ?? '')
      const patchKeys = op.patch ? Object.keys(op.patch) : []
      const patchPreview = op.patch
        ? patchKeys.slice(0, 3).map(k => {
            const v = op.patch![k]
            const vs = typeof v === 'string' ? `"${v.slice(0, 40)}"` : JSON.stringify(v).slice(0, 40)
            return `${k}=${vs}`
          }).join(', ')
        : ''
      return `Updated ${node?.type ?? 'node'} "${node?.name ?? op.nodeId}" — ${patchPreview}`
    }
    case 'updateEdge':
      return `Reordered edge ${op.edgeId} to order ${op.order}`
    case 'removeNode':
      return `Removed node ${op.targetId}`
    case 'removeEdge':
      return `Removed edge ${op.targetId}`
  }
  return null
}

function broadcast(event: GraphEvent): void {
  io.to(projectRoom(event.projectId)).emit(SOCKET.graphEvent, event)

  // Design system watcher: check color compliance on style node updates AND creations
  const isStyleEvent =
    (event.type === 'node_updated' && event.node.type === 'style') ||
    (event.type === 'node_created' && event.node.type === 'style')
  if (isStyleEvent && (event.type === 'node_updated' || event.type === 'node_created')) {
    const styleNodeId = event.node.id
    const projectId = event.projectId
    // Defer so the broadcast completes and any remaining agent ops in the same
    // batch can finish before we re-read from DB
    setImmediate(() => {
      try {
        const { violations, correctedNode } = checkAndCorrectColors(projectId, styleNodeId)
        if (violations.length > 0) {
          app.log.info({ nodeId: styleNodeId, count: violations.length }, 'design system violations detected')

          // Broadcast the correction
          if (correctedNode) {
            io.to(projectRoom(projectId)).emit(SOCKET.graphEvent, {
              type: 'node_updated',
              projectId,
              node: correctedNode,
            } satisfies GraphEvent)
          }

          // Emit violation event so clients can show annotations
          io.to(projectRoom(projectId)).emit(SOCKET.designSystemViolation, {
            projectId,
            styleNodeId,
            violations: violations.map(v => ({
              elementNodeId: v.elementNodeId,
              property: v.property,
              actualColor: v.actualColor,
              closestSystemColor: v.closestSystemColor,
              closestTokenName: v.closestTokenName,
              correctedValue: v.correctedValue,
            })),
          })
        }
      } catch (err) {
        app.log.warn({ err, nodeId: styleNodeId }, 'design system watcher error')
      }
    })
  }
}

app.log.info(`ecto-engine server ready on :${PORT}`)
