import React from 'react'
import type { EctoGraph, EctoNode } from '../lib/ectoscript/graph'
import { NODE_TYPE_COLORS } from '../lib/ectoscript/graph'

interface Props {
  graph: EctoGraph
  selectedId: string | null
  atomValues?: Record<string, any>
}

export function InspectorPanel({ graph, selectedId, atomValues }: Props) {
  const node = selectedId ? graph.nodes.find((n) => n.id === selectedId) ?? null : null
  if (!node) {
    return (
      <div style={{ padding: 16, color: '#94a3b8', fontSize: 12 }}>
        Click a node in the 3D graph (or alt-click in the preview) to inspect.
      </div>
    )
  }
  const incoming = graph.edges.filter((e) => e.target === node.id)
  const outgoing = graph.edges.filter((e) => e.source === node.id)
  const liveValue =
    node.type === 'Atom' && atomValues && node.id in atomValues
      ? atomValues[node.id]
      : undefined

  return (
    <div style={{ padding: 16, fontSize: 12, color: '#e2e8f0', overflow: 'auto', height: '100%' }}>
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          background: 'rgba(15, 23, 42, 0.5)',
          border: '1px solid rgba(148, 163, 184, 0.18)',
          borderRadius: 999,
          padding: '4px 10px',
          fontSize: 11,
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: 8,
            background: NODE_TYPE_COLORS[node.type] ?? '#94a3b8',
            display: 'inline-block',
          }}
        />
        {node.type}
      </div>
      <h3 style={{ margin: '12px 0 4px', fontSize: 15, color: '#f1f5f9' }}>{node.label}</h3>
      <div style={{ color: '#64748b', fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 10 }}>
        {node.id}
      </div>
      {liveValue !== undefined ? (
        <div style={{ marginTop: 12 }}>
          <SectionLabel>Live value</SectionLabel>
          <pre
            style={{
              margin: 0,
              padding: 8,
              background: 'rgba(15, 23, 42, 0.5)',
              borderRadius: 6,
              fontSize: 11,
              fontFamily: 'JetBrains Mono, ui-monospace, monospace',
              color: '#7dd3fc',
            }}
          >
            {JSON.stringify(liveValue)}
          </pre>
        </div>
      ) : null}
      {node.data ? (
        <div style={{ marginTop: 12 }}>
          <SectionLabel>Data</SectionLabel>
          <pre
            style={{
              margin: 0,
              padding: 8,
              background: 'rgba(15, 23, 42, 0.5)',
              borderRadius: 6,
              fontSize: 11,
              fontFamily: 'JetBrains Mono, ui-monospace, monospace',
              color: '#cbd5e1',
              overflow: 'auto',
            }}
          >
            {JSON.stringify(node.data, null, 2)}
          </pre>
        </div>
      ) : null}
      <EdgeList title={`Incoming (${incoming.length})`} edges={incoming} other={(e) => e.source} graph={graph} />
      <EdgeList title={`Outgoing (${outgoing.length})`} edges={outgoing} other={(e) => e.target} graph={graph} />
    </div>
  )
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 10, opacity: 0.6, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 4 }}>
      {children}
    </div>
  )
}

function EdgeList({
  title,
  edges,
  other,
  graph,
}: {
  title: string
  edges: { id: string; source: string; target: string; type: string }[]
  other: (e: any) => string
  graph: EctoGraph
}) {
  if (edges.length === 0) return null
  return (
    <div style={{ marginTop: 12 }}>
      <SectionLabel>{title}</SectionLabel>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        {edges.map((e) => {
          const otherId = other(e)
          const otherNode = graph.nodes.find((n: EctoNode) => n.id === otherId)
          return (
            <li
              key={e.id}
              style={{
                padding: '4px 8px',
                background: 'rgba(15, 23, 42, 0.4)',
                borderRadius: 4,
                fontSize: 11,
              }}
            >
              <span style={{ color: '#7dd3fc' }}>{e.type}</span>{' '}
              <span style={{ color: '#cbd5e1' }}>{otherNode?.label ?? otherId}</span>
              <span style={{ color: '#64748b' }}> · {otherNode?.type ?? ''}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
