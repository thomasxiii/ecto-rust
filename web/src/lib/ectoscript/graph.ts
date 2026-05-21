// Graph types emitted by the EctoScript compiler. These are intentionally
// flat node+edge lists so the same shape feeds the JSON panel, the 3D
// visualizer, and the runtime renderer.

export type EctoNodeType =
  | 'Model'
  | 'Component'
  | 'Atom'
  | 'Element'
  | 'Style'
  | 'Token'
  | 'DerivedToken'
  | 'Event'
  | 'Action'
  | 'Binding'
  | 'Condition'
  | 'Trait'
  | 'Query'
  | 'Loop'
  | 'Cognition'

export type EctoEdgeType =
  | 'HAS_STATE'
  | 'USES_MODEL'
  | 'HAS_ELEMENT'
  | 'HAS_CHILD'
  | 'USES_STYLE'
  | 'READS'
  | 'WRITES'
  | 'BINDS'
  | 'HAS_EVENT'
  | 'TRIGGERS'
  | 'HAS_TRAIT'
  | 'USES_TOKEN'
  | 'DERIVES_FROM'
  | 'QUERIES'
  | 'FILTERS_BY'
  | 'ITERATES'
  | 'MATCHES_AGAINST'

export interface EctoNode {
  id: string
  type: EctoNodeType
  label: string
  data?: Record<string, any>
}

export interface EctoEdge {
  id: string
  source: string
  target: string
  type: EctoEdgeType
}

export interface EctoGraph {
  nodes: EctoNode[]
  edges: EctoEdge[]
}

export const NODE_TYPE_COLORS: Record<EctoNodeType, string> = {
  Model: '#f59e0b',
  Component: '#3b82f6',
  Atom: '#10b981',
  Element: '#8b5cf6',
  Style: '#ec4899',
  Token: '#f43f5e',
  DerivedToken: '#fb7185',
  Event: '#06b6d4',
  Action: '#0ea5e9',
  Binding: '#22d3ee',
  Condition: '#facc15',
  Trait: '#94a3b8',
  Query: '#a3e635',
  Loop: '#fbbf24',
  Cognition: '#e879f9',
}
