// importStormbase — loads the Stormbase fixture into the ecto engine.
//
// Two passes:
//   1. Import the source files (Sass + TSX) → engine builds the static
//      graph for the home page UI. The existing oxc/grass pipeline parses
//      everything; no changes needed there.
//   2. Programmatically augment the graph with:
//      - server_function nodes that define Storm's in-memory store + AI
//        stubs (callable via POST /api/server-fn/invoke).
//      - npm_package + npm_export nodes for react-force-graph-3d so the
//        3D view (when added later) renders through the sidecar.
//
// The server-function bodies use ctx.state — the per-worker mutable
// object exposed by the sidecar — for persistence. State survives across
// invocations within a single worker lifetime; it's reset when the
// worker restarts.

import type { Engine, GraphPayload, ImportResult } from './engine'
import { STORMBASE_FILES } from './fixtures/stormbase'

// ── ServerFunction bodies ────────────────────────────────────────────
//
// These run inside the Node sidecar worker. They share ctx.state across
// invocations, so the store accumulates ideas as the user captures.

const STORE_INIT_BODY = `
if (!ctx.state.storm) {
  ctx.state.storm = {
    ideas: [],
    concepts: new Map(),
    maps: [
      {
        id: 'm1',
        name: 'Storm itself',
        prompt: 'Anything about how Storm should look, feel, and behave',
        color: '#3ecf8e',
        ideaIds: [],
        newCount: 0,
        createdAt: new Date().toISOString(),
      },
    ],
  }
}
return { ready: true, ideaCount: ctx.state.storm.ideas.length }
`

const CAPTURE_BODY = `
if (!ctx.state.storm) {
  ctx.state.storm = { ideas: [], concepts: new Map(), maps: [] }
}
const rawText = String(args.rawText ?? '').trim()
if (!rawText) throw new Error('rawText required')

// Deterministic AI stub: classify by simple keyword heuristic.
const lower = rawText.toLowerCase()
let kind = 'idea'
if (/^why|^what|^how|^when|\\?$/.test(rawText.trim())) kind = 'question'
else if (/should|could|might|maybe/.test(lower)) kind = 'opportunity'
else if (/done|fix|run|switch|move/.test(lower)) kind = 'action'
else if (/feels|seems|notice|observe/.test(lower)) kind = 'observation'
else if (/think|believe|wonder/.test(lower)) kind = 'reflection'

// Deterministic embedding stub: 12-d unit vector seeded by string hash.
function hashStr(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619) >>> 0
  }
  return h
}
const seed = hashStr(rawText)
let s = seed
function next() {
  s = (s * 1664525 + 1013904223) >>> 0
  return (s / 0xffffffff) * 2 - 1
}
const dim = 12
const vec = new Array(dim).fill(0).map(() => next())
const norm = Math.hypot(...vec)
const dna = vec.map((v) => v / norm)

// Extract concept candidates: capitalized words and meaningful nouns.
const stop = new Set(['the','a','an','and','or','but','of','to','for','in','on','it','is','this','that','with','as'])
const tokens = rawText.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? []
const conceptKeys = Array.from(new Set(tokens.filter((t) => !stop.has(t)))).slice(0, 4)

const id = 'idea-' + Date.now() + '-' + Math.floor(Math.random() * 9999)
const title = rawText.length > 80 ? rawText.slice(0, 77) + '...' : rawText
const summary = rawText.length > 200 ? rawText.slice(0, 200) + '...' : rawText
const now = new Date().toISOString()
const idea = {
  id,
  title,
  summary,
  rawText,
  kind,
  source: 'text',
  createdAt: now,
  dna,
  conceptKeys,
}
ctx.state.storm.ideas.unshift(idea)
for (const k of conceptKeys) {
  ctx.state.storm.concepts.set(k, (ctx.state.storm.concepts.get(k) ?? 0) + 1)
}
return { idea, totalIdeas: ctx.state.storm.ideas.length }
`

const LIST_IDEAS_BODY = `
if (!ctx.state.storm) return { ideas: [] }
const limit = Math.min(50, Math.max(1, Number(args.limit ?? 20)))
return { ideas: ctx.state.storm.ideas.slice(0, limit) }
`

const LIST_MAPS_BODY = `
if (!ctx.state.storm) return { maps: [] }
return { maps: ctx.state.storm.maps.map((m) => ({
  id: m.id,
  name: m.name,
  prompt: m.prompt,
  color: m.color,
  ideaCount: m.ideaIds.length,
  newCount: m.newCount,
  createdAt: m.createdAt,
})) }
`

const HOME_STATS_BODY = `
if (!ctx.state.storm) return { totalIdeas: 0, totalConcepts: 0, totalMaps: 0, ideasThisWeek: 0, emergingConcepts: [] }
const s = ctx.state.storm
const weekMs = 7 * 24 * 3600 * 1000
const cutoff = Date.now() - weekMs
const ideasThisWeek = s.ideas.filter((i) => new Date(i.createdAt).getTime() >= cutoff).length
const emerging = Array.from(s.concepts.entries())
  .sort((a, b) => b[1] - a[1])
  .slice(0, 8)
  .map(([key, mentions]) => ({ key, name: key, mentions }))
return {
  totalIdeas: s.ideas.length,
  totalConcepts: s.concepts.size,
  totalMaps: s.maps.length,
  ideasThisWeek,
  emergingConcepts: emerging,
}
`

interface AddNodeFn {
  (node: { id: string; type: string; name: string; data: Record<string, unknown> }): void
}
interface AddEdgeFn {
  (edge: { id: string; from: string; to: string; type: string; data?: Record<string, unknown> }): void
}

function augmentWithStormApi(engine: Engine, projectId: string): void {
  const addNode: AddNodeFn = (n) => {
    engine.applyMutation({
      type: 'add_node',
      projectId,
      node: { ...n, projectId },
    })
  }
  const addEdge: AddEdgeFn = (e) => {
    engine.applyMutation({
      type: 'add_edge',
      projectId,
      edge: {
        id: e.id,
        projectId,
        fromNodeId: e.from,
        toNodeId: e.to,
        type: e.type,
        data: e.data,
      },
    })
  }

  // Storm API container — a module-style holder for all server functions.
  addNode({
    id: 'storm-api',
    type: 'module',
    name: 'storm-api',
    data: { virtual: true, purpose: 'storm server functions' },
  })

  const fns: { id: string; name: string; body: string }[] = [
    { id: 'sf-init', name: 'storm.init', body: STORE_INIT_BODY },
    { id: 'sf-capture', name: 'storm.captureIdea', body: CAPTURE_BODY },
    { id: 'sf-list-ideas', name: 'storm.listIdeas', body: LIST_IDEAS_BODY },
    { id: 'sf-list-maps', name: 'storm.listMaps', body: LIST_MAPS_BODY },
    { id: 'sf-home-stats', name: 'storm.homeStats', body: HOME_STATS_BODY },
  ]
  for (const fn of fns) {
    addNode({
      id: fn.id,
      type: 'server_function',
      name: fn.name,
      data: {
        body: fn.body,
        params: [{ name: 'args' }],
        returnShape: 'value',
      },
    })
    addEdge({
      id: `e-${fn.id}-contains`,
      from: 'storm-api',
      to: fn.id,
      type: 'contains',
    })
  }
}

function augmentWithForceGraph3D(engine: Engine, projectId: string): void {
  // Stage the npm sidecar nodes for the (future) 3D graph view. Even if
  // no element wraps them yet, downstream tooling can wire `<ForceGraph3D/>`
  // → `npm-fg3d-default` via a `wraps_npm_component` edge.
  engine.applyMutation({
    type: 'add_node',
    projectId,
    node: {
      id: 'npm-fg3d',
      projectId,
      type: 'npm_package',
      name: 'react-force-graph-3d',
      data: {
        name: 'react-force-graph-3d',
        version: '^1.27.0',
        target: 'browser',
        exports: ['default'],
      },
    },
  })
  engine.applyMutation({
    type: 'add_node',
    projectId,
    node: {
      id: 'npm-fg3d-default',
      projectId,
      type: 'npm_export',
      name: 'ForceGraph3D',
      data: { exportName: 'default', kind: 'component', isDefault: true },
    },
  })
  engine.applyMutation({
    type: 'add_edge',
    projectId,
    edge: {
      id: 'e-fg3d-contains',
      projectId,
      fromNodeId: 'npm-fg3d',
      toNodeId: 'npm-fg3d-default',
      type: 'contains',
    },
  })
}

export interface ImportStormbaseResult {
  importResult: ImportResult
  graph: GraphPayload
  serverFunctionIds: string[]
}

export function importStormbase(engine: Engine, projectId: string): ImportStormbaseResult {
  console.log('[stormbase] step 1: importFiles')
  const importResult = engine.importFiles('stormbase', STORMBASE_FILES)
  console.log('[stormbase] step 2: augmentWithStormApi')
  augmentWithStormApi(engine, projectId)
  console.log('[stormbase] step 3: augmentWithForceGraph3D')
  augmentWithForceGraph3D(engine, projectId)
  console.log('[stormbase] step 4: getGraph')
  const graph = engine.getGraph()
  console.log('[stormbase] step 5: done', { entry: importResult.entryNodeId })
  return {
    importResult,
    graph,
    serverFunctionIds: ['sf-init', 'sf-capture', 'sf-list-ideas', 'sf-list-maps', 'sf-home-stats'],
  }
}
