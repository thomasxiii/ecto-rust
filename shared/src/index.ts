// Shared graph schema and wire-protocol types between server, importer, web, and runtime.
// Keep this module dependency-free — it's imported by browser and node.

// Node types — the 12 original MVP types are kept verbatim for backward
// compatibility with existing imported projects; the rest are the richer
// set we need now. `element` is the structural/declared JSX; `ui_element`
// and `rendered_instance` exist for future work that separates declaration
// from each realized render. `style` still carries kind='class' | 'rule' |
// 'atrule' inside data; `style_rule` and `style_token` are the explicit
// typed versions for tokens and individual rules.
export type NodeType =
  // original MVP
  | 'file'
  | 'module'
  | 'import'
  | 'component'
  | 'element'
  | 'text'
  | 'prop'
  | 'state'
  | 'style'
  | 'function'
  | 'route'
  | 'asset'
  // expanded
  | 'export'
  | 'ui_element'
  | 'state_field'
  | 'event'
  | 'action'
  | 'async_operation'
  | 'api_endpoint'
  | 'data_model'
  | 'style_token'
  | 'style_rule'
  | 'layout_container'
  | 'rendered_instance'
  | 'intent'
  | 'summary'
  // semantic layer
  | 'semantic_component'
  | 'semantic_element'
  | 'semantic_style'
  | 'semantic_state'
  | 'semantic_interaction'
  | 'semantic_flow'
  // UI/editing layer
  | 'ui_selectable'
  | 'ui_style_surface'
  | 'ui_layout_surface'
  | 'ui_interaction_surface'
  | 'ui_variant_surface'
  // npm sidecar — see engine/src/graph/kinds.rs for semantics
  | 'npm_package'
  | 'npm_export'
  | 'server_function'

export type EdgeType =
  // original MVP
  | 'contains'
  | 'imports'
  | 'renders'
  | 'child_of'
  | 'references'
  | 'styles'
  | 'binds_prop'
  | 'declares'
  | 'entry_for'
  // expanded
  | 'composes'
  | 'owns_state'
  | 'reads_state'
  | 'writes_state'
  | 'triggers'
  | 'handles'
  | 'calls'
  | 'fetches_from'
  | 'binds_to'
  | 'styled_by'
  | 'uses_token'
  | 'participates_in_layout'
  | 'navigates_to'
  | 'represents'
  | 'implements_intent'
  | 'affects'
  | 'corresponds_to'
  // upward abstraction edges (mechanical -> semantic -> UI)
  | 'contributes_to'
  | 'abstracts'
  | 'represented_by'
  | 'controlled_by'
  // editing/behavior edges
  | 'controls'
  | 'triggered_by'
  | 'transitions_to'
  | 'branches_to'
  | 'patches'
  // npm sidecar — see engine/src/graph/edge.rs for semantics
  | 'uses_npm_export'
  | 'wraps_npm_component'

export interface SourceMap {
  filePath?: string
  startLine?: number
  endLine?: number
  startCol?: number
  endCol?: number
}

export interface GraphNode {
  id: string
  projectId: string
  type: NodeType
  name: string
  data: Record<string, any>
  source?: SourceMap
  createdAt: string
  updatedAt: string
}

export interface GraphEdge {
  id: string
  projectId: string
  fromNodeId: string
  toNodeId: string
  type: EdgeType
  data?: Record<string, any>
  order?: number
  createdAt: string
}

export interface Project {
  id: string
  name: string
  rootPathLabel: string | null
  entryNodeId: string | null
  createdAt: string
  updatedAt: string
}

export interface GraphPayload {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

// Import request body — importer produces this, server stores it.
export interface ImportRequest {
  projectName: string
  rootPathLabel: string
  nodes: Omit<GraphNode, 'createdAt' | 'updatedAt' | 'projectId'>[]
  edges: Omit<GraphEdge, 'createdAt' | 'projectId'>[]
  entryNodeId: string | null
}

export interface ImportResponse {
  project: Project
  nodeCount: number
  edgeCount: number
}

// Mutation payloads sent from client → server, and broadcast server → client.
export type GraphMutation =
  | {
      type: 'update_node_data'
      projectId: string
      nodeId: string
      patch: Record<string, any>
    }
  | {
      type: 'rename_node'
      projectId: string
      nodeId: string
      name: string
    }
  | {
      type: 'add_node'
      projectId: string
      node: Omit<GraphNode, 'createdAt' | 'updatedAt' | 'projectId'>
    }
  | {
      type: 'add_edge'
      projectId: string
      edge: Omit<GraphEdge, 'createdAt' | 'projectId'>
    }
  | {
      type: 'remove_node'
      projectId: string
      nodeId: string
    }
  | {
      type: 'remove_edge'
      projectId: string
      edgeId: string
    }

// Events server broadcasts to subscribed clients.
export type GraphEvent =
  | { type: 'node_updated'; projectId: string; node: GraphNode }
  | { type: 'node_created'; projectId: string; node: GraphNode }
  | { type: 'edge_created'; projectId: string; edge: GraphEdge }
  | { type: 'edge_updated'; projectId: string; edge: GraphEdge }
  | { type: 'node_removed'; projectId: string; nodeId: string }
  | { type: 'edge_removed'; projectId: string; edgeId: string }
  | { type: 'import_completed'; projectId: string; nodeCount: number; edgeCount: number }

// Socket.io event names.
export const SOCKET = {
  subscribeProject: 'subscribe_project',
  unsubscribeProject: 'unsubscribe_project',
  graphEvent: 'graph_event',
  mutate: 'mutate',
  mutationAck: 'mutation_ack',
  // Agent streaming events
  agentStart: 'agent:start',
  agentThinking: 'agent:thinking',
  agentOpApplied: 'agent:op_applied',
  agentOpSkipped: 'agent:op_skipped',
  agentDone: 'agent:done',
  agentError: 'agent:error',
  agentCancel: 'agent:cancel',
  // Design system watcher
  designSystemViolation: 'design_system:violation',
} as const

export function projectRoom(projectId: string): string {
  return `project:${projectId}`
}

// ── Timeline / version history ───────────────────────────────────────

export interface TimelineEntry {
  id: string
  revisionNumber: number
  label: string
  source: 'import' | 'agent' | 'user_edit' | 'system'
  createdAt: string
}

// ── Layer system types ──────────────────────────────────────────────

export type GraphLayer = 'mechanical' | 'semantic' | 'ui'

export type Capability =
  | 'selectable'
  | 'styleable'
  | 'layoutable'
  | 'textEditable'
  | 'bindable'
  | 'eventSource'
  | 'stateConsumer'
  | 'stateProducer'
  | 'variantable'
  | 'animatable'
  | 'interactionEditable'
  | 'promptable'
  | 'patchable'

export interface ControlDefinition {
  id: string
  label: string
  kind:
    | 'text'
    | 'number'
    | 'color'
    | 'spacing'
    | 'select'
    | 'toggle'
    | 'binding'
    | 'interaction'
    | 'variant'
    | 'code'
  path: string
  value?: unknown
  options?: unknown[]
  sourceNodeIds?: string[]
  patchStrategy?: string
}

export interface ProvenanceEvidence {
  nodeId: string
  reason: string
  confidence?: number
}

export interface Provenance {
  createdBy: 'parser' | 'ai' | 'heuristic' | 'user' | 'system'
  derivedFrom?: string[]
  confidence?: number
  evidence?: ProvenanceEvidence[]
}

export interface InteractionStep {
  kind: 'validate' | 'setState' | 'call' | 'branch' | 'navigate' | 'show' | 'hide' | 'customCode'
  target?: string
  stateNodeId?: string
  value?: unknown
  targetNodeId?: string
  condition?: string
  paths?: InteractionStep[][]
  sourceNodeId?: string
}

// ── Agent graph operations ───────────────────────────────────────────
// Flat schema — smaller models (Ollama 7B) produce this more reliably
// than a discriminated union with per-variant required fields.
export interface AgentGraphOp {
  op: 'addNode' | 'addEdge' | 'updateNode' | 'updateEdge' | 'removeNode' | 'removeEdge'
  // addNode
  id?: string
  nodeType?: string
  name?: string
  data?: Record<string, any>
  // addEdge
  edgeId?: string
  from?: string
  to?: string
  edgeType?: string
  order?: number
  // updateNode
  nodeId?: string
  patch?: Record<string, any>
  // updateEdge: uses edgeId + order (and optionally patch)
  // removeNode / removeEdge
  targetId?: string
}

// ── Model provider types ─────────────────────────────────────────────

export type ModelProviderId = 'anthropic' | 'openai' | 'ollama'

export interface ModelOption {
  id: string
  provider: ModelProviderId
  displayName: string
  isLocal: boolean
}

export const MODEL_OPTIONS: ModelOption[] = [
  { id: 'claude-sonnet-4-20250514', provider: 'anthropic', displayName: 'Claude Sonnet', isLocal: false },
  { id: 'claude-opus-4-7', provider: 'anthropic', displayName: 'Claude Opus', isLocal: false },
  { id: 'gpt-4o', provider: 'openai', displayName: 'GPT-4o', isLocal: false },
  { id: 'ollama:qwen2.5-coder:3b', provider: 'ollama', displayName: 'Ecto Local', isLocal: true },
]

// ── NPM sidecar types ───────────────────────────────────────────────
// The npm sidecar lets graphs reference real npm packages. Browser-target
// packages are bundled into ESM for the preview iframe; server-target
// packages run inside a Node subprocess. See server/src/bundler/ and the
// 'npm_package' / 'npm_export' / 'server_function' node kinds.

export type NpmTarget = 'browser' | 'server'

export interface NpmPackageData {
  name: string
  version: string
  target: NpmTarget
  // The set of named exports the graph references. The bundler tree-shakes
  // unused exports; this list drives the entry shim it generates.
  exports: string[]
  // Populated after a successful build; identifies the bundle on disk.
  bundleHash?: string
  bundleStatus?: 'pending' | 'building' | 'ready' | 'error'
  bundleError?: string
}

export type NpmExportKind = 'component' | 'hook' | 'function' | 'value'

export interface NpmExportData {
  exportName: string
  kind: NpmExportKind
  // For default exports, exportName === 'default'.
  isDefault?: boolean
}

export interface ServerFunctionData {
  // JS body executed in the sidecar. Receives `({ args, ctx })`, where
  // ctx exposes resolved npm imports keyed by export id. Returns JSON-
  // serializable value.
  body: string
  params: { name: string; jsType?: string }[]
  returnShape?: 'value' | 'stream' | 'void'
}

export interface BundleBuildRequest {
  target: NpmTarget
  name: string
  version: string
  exports: string[]
}

export interface BundleBuildResponse {
  hash: string
  target: NpmTarget
  url: string
  bytes: number
  cached: boolean
  durationMs: number
}

// ── Platform adapter contracts ───────────────────────────────────────

export interface PlatformAdapter {
  readonly platformId: string
  readonly displayName: string
  isAvailable(): boolean
  init(config: PlatformConfig): Promise<void>
  dispose(): void
  readonly renderer: PlatformRenderer
  readonly styles: PlatformStyleAdapter
  readonly events: PlatformEventAdapter
}

export interface PlatformConfig {
  projectId: string
  initialGraph: GraphPayload
  onGraphEvent(handler: (e: GraphEvent) => void): () => void
}

export interface PlatformRenderer {
  render(tree: PlatformRenderInput): PlatformRenderOutput
  readonly connected: boolean
}

export interface PlatformRenderInput {
  nodes: Map<string, GraphNode>
  edges: GraphEdge[]
  rootId: string
}

export interface PlatformRenderOutput {
  tree: unknown
  visibleNodeIds: Set<string>
}

export interface PlatformStyleAdapter {
  mapDeclaration(property: string, value: string): { property: string; value: unknown } | null
  supportsFeature(feature: string): boolean
}

export interface PlatformEventAdapter {
  onElementSelect(handler: (nodeId: string, modifier: 'default' | 'mechanical') => void): () => void
  onElementHighlight?(handler: (nodeId: string | null) => void): () => void
  showSelectionOverlay(nodeId: string, color: string): void
  clearOverlays(): void
  showAgentHighlight(nodeId: string, color: string, durationMs: number): void
}
