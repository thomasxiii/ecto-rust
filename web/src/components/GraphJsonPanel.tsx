import React from 'react'
import type { EctoGraph } from '../lib/ectoscript/graph'
import type { ParseError } from '../lib/ectoscript/parser'

interface Props {
  graph: EctoGraph
  errors: ParseError[]
}

export function GraphJsonPanel({ graph, errors }: Props) {
  const [copied, setCopied] = React.useState(false)
  const text = JSON.stringify(graph, null, 2)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1000)
    } catch {
      /* no-op */
    }
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 12px',
          borderBottom: '1px solid rgba(148, 163, 184, 0.18)',
          fontSize: 12,
        }}
      >
        <span style={{ opacity: 0.6 }}>
          graph.json — {graph.nodes.length} nodes · {graph.edges.length} edges
        </span>
        <button
          onClick={copy}
          style={{
            marginLeft: 'auto',
            background: 'transparent',
            border: '1px solid rgba(148, 163, 184, 0.28)',
            color: 'inherit',
            borderRadius: 6,
            padding: '4px 10px',
            fontSize: 11,
            cursor: 'pointer',
          }}
        >
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      {errors.length > 0 ? (
        <div
          style={{
            padding: 12,
            background: 'rgba(239, 68, 68, 0.12)',
            color: '#fecaca',
            borderBottom: '1px solid rgba(239, 68, 68, 0.32)',
            fontSize: 12,
            fontFamily: 'JetBrains Mono, ui-monospace, monospace',
            maxHeight: 140,
            overflow: 'auto',
          }}
        >
          {errors.map((e, i) => (
            <div key={i}>
              <strong>line {e.line}</strong>: {e.message}
            </div>
          ))}
        </div>
      ) : null}
      <pre
        style={{
          margin: 0,
          padding: 12,
          flex: 1,
          overflow: 'auto',
          fontSize: 11,
          fontFamily: 'JetBrains Mono, ui-monospace, monospace',
          color: '#cbd5e1',
          background: 'rgba(15, 23, 42, 0.5)',
        }}
      >
        {text}
      </pre>
    </div>
  )
}
