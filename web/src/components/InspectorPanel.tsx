import React from 'react'
import type { MiniGraphPayload, RuntimeSnapshot, MiniValue } from '../engine'

interface Props {
  payload: MiniGraphPayload | null
  selectedId: string | null
  snapshot: RuntimeSnapshot | null
}

interface AnyNode {
  id: string
  name: string
  type?: string
  [k: string]: unknown
}

interface AnyEdge {
  from: string
  to: string
  kind: string
}

export function InspectorPanel({ payload, selectedId, snapshot }: Props) {
  const node = React.useMemo<AnyNode | null>(() => {
    if (!payload || !selectedId) return null
    return (
      (payload.nodes as AnyNode[]).find((n) => n.id === selectedId) ?? null
    )
  }, [payload, selectedId])

  if (!node) {
    return (
      <div style={{ padding: 16, color: '#94a3b8', fontSize: 12 }}>
        Click a node in the 3D graph (or alt-click in the preview) to inspect.
      </div>
    )
  }
  const edges = (payload?.edges as AnyEdge[]) ?? []
  const incoming = edges.filter((e) => e.to === node.id)
  const outgoing = edges.filter((e) => e.from === node.id)
  const liveValue: MiniValue | undefined =
    node.type === 'atom' && snapshot ? snapshot.atoms[node.id] : undefined

  return (
    <div
      style={{
        padding: 16,
        fontSize: 12,
        color: '#e2e8f0',
        overflow: 'auto',
        height: '100%',
      }}
    >
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
            background: colorForKind(String(node.type ?? '')),
            display: 'inline-block',
          }}
        />
        {String(node.type ?? 'node')}
      </div>
      <h3 style={{ margin: '12px 0 4px', fontSize: 15, color: '#f1f5f9' }}>
        {node.name}
      </h3>
      <div
        style={{
          color: '#64748b',
          fontFamily: 'JetBrains Mono, ui-monospace, monospace',
          fontSize: 10,
        }}
      >
        {node.id}
      </div>
      {liveValue !== undefined ? (
        <div style={{ marginTop: 12 }}>
          <SectionLabel>Live value</SectionLabel>
          <pre style={preStyle}>{JSON.stringify(liveValue, null, 2)}</pre>
        </div>
      ) : null}
      <div style={{ marginTop: 12 }}>
        <SectionLabel>Data</SectionLabel>
        <pre style={preStyle}>{JSON.stringify(stripCommon(node), null, 2)}</pre>
      </div>
      <EdgeList title={`Incoming (${incoming.length})`} edges={incoming} other={(e) => e.from} payload={payload} />
      <EdgeList title={`Outgoing (${outgoing.length})`} edges={outgoing} other={(e) => e.to} payload={payload} />
    </div>
  )
}

const preStyle: React.CSSProperties = {
  margin: 0,
  padding: 8,
  background: 'rgba(15, 23, 42, 0.5)',
  borderRadius: 6,
  fontSize: 11,
  fontFamily: 'JetBrains Mono, ui-monospace, monospace',
  color: '#cbd5e1',
  overflow: 'auto',
}

function stripCommon(n: AnyNode): Record<string, unknown> {
  const { id, name, ...rest } = n
  void id
  void name
  return rest
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 10,
        opacity: 0.6,
        textTransform: 'uppercase',
        letterSpacing: 0.4,
        marginBottom: 4,
      }}
    >
      {children}
    </div>
  )
}

function EdgeList({
  title,
  edges,
  other,
  payload,
}: {
  title: string
  edges: AnyEdge[]
  other: (e: AnyEdge) => string
  payload: MiniGraphPayload | null
}) {
  if (edges.length === 0) return null
  return (
    <div style={{ marginTop: 12 }}>
      <SectionLabel>{title}</SectionLabel>
      <ul
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
        }}
      >
        {edges.map((e, i) => {
          const otherId = other(e)
          const otherNode = (payload?.nodes as AnyNode[] | undefined)?.find(
            (n) => n.id === otherId,
          )
          return (
            <li
              key={`${e.kind}-${e.from}-${e.to}-${i}`}
              style={{
                padding: '4px 8px',
                background: 'rgba(15, 23, 42, 0.4)',
                borderRadius: 4,
                fontSize: 11,
              }}
            >
              <span style={{ color: '#7dd3fc' }}>{e.kind}</span>{' '}
              <span style={{ color: '#cbd5e1' }}>
                {otherNode?.name ?? otherId}
              </span>
              <span style={{ color: '#64748b' }}> · {String(otherNode?.type ?? '')}</span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function colorForKind(kind: string): string {
  switch (kind) {
    case 'component':
      return '#34d399'
    case 'element':
      return '#60a5fa'
    case 'atom':
      return '#facc15'
    case 'token':
      return '#fb923c'
    case 'derived':
      return '#a78bfa'
    case 'styleSheet':
      return '#f472b6'
    case 'cause':
      return '#22d3ee'
    case 'effect':
      return '#f87171'
    case 'repeat':
      return '#fb7185'
    case 'visibility':
      return '#c084fc'
    default:
      return '#94a3b8'
  }
}
