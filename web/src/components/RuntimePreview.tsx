import React from 'react'
import { RuntimeView, type AtomValues } from '../lib/ectoscript/runtime'
import type { CompileResult } from '../lib/ectoscript/compiler'
import { readAtomByPath } from '../lib/ectoscript/tokens'

interface Props {
  compiled: CompileResult
  atoms: AtomValues
  setAtom: (id: string, v: any) => void
  resetAtoms: () => void
  selectedElementId: string | null
  onSelectElement: (id: string | null) => void
}

export function RuntimePreview({
  compiled,
  atoms,
  setAtom,
  resetAtoms,
  selectedElementId,
  onSelectElement,
}: Props) {
  const [showState, setShowState] = React.useState(false)
  const darkAtomId = compiled.models['Theme']?.atomIds['darkMode']
  const isDark = darkAtomId ? !!atoms[darkAtomId] : false
  const toggleDark = () => {
    if (!darkAtomId) return
    setAtom(darkAtomId, !atoms[darkAtomId])
  }

  // Derive the page background from Theme so the preview canvas
  // reflects dark mode even when no element fills it.
  const pageBg = isDark ? '#0b1220' : '#f8fafc'
  const pageFg = isDark ? '#f1f5f9' : '#0f172a'

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: pageBg,
        color: pageFg,
        transition: 'background 200ms ease, color 200ms ease',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '8px 12px',
          borderBottom: '1px solid rgba(148, 163, 184, 0.18)',
          fontSize: 12,
        }}
      >
        <span style={{ opacity: 0.6, marginRight: 'auto' }}>preview</span>
        <ToolButton onClick={resetAtoms}>Reset state</ToolButton>
        <ToolButton onClick={toggleDark} active={isDark}>
          {isDark ? '☾ dark' : '☼ light'}
        </ToolButton>
        <ToolButton onClick={() => setShowState((v) => !v)} active={showState}>
          State JSON
        </ToolButton>
      </div>
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 32,
          overflow: 'auto',
        }}
        onClick={() => onSelectElement(null)}
      >
        <div style={{ maxWidth: 480, width: '100%' }}>
          <RuntimeView
            compiled={compiled}
            atoms={atoms}
            setAtom={setAtom}
            selectedElementId={selectedElementId}
            onSelectElement={onSelectElement}
          />
        </div>
      </div>
      {showState ? (
        <pre
          style={{
            margin: 0,
            padding: 12,
            background: 'rgba(15, 23, 42, 0.78)',
            color: '#cbd5e1',
            fontSize: 11,
            maxHeight: 200,
            overflow: 'auto',
            fontFamily: 'JetBrains Mono, ui-monospace, monospace',
            borderTop: '1px solid rgba(148, 163, 184, 0.18)',
          }}
        >
          {JSON.stringify(humanAtoms(compiled, atoms), null, 2)}
        </pre>
      ) : null}
    </div>
  )
}

function humanAtoms(c: CompileResult, atoms: AtomValues): Record<string, any> {
  const out: Record<string, any> = {}
  for (const node of c.graph.nodes) {
    if (node.type !== 'Atom') continue
    out[node.label] = atoms[node.id]
  }
  return out
}

function ToolButton({
  children,
  onClick,
  active,
}: {
  children: React.ReactNode
  onClick: () => void
  active?: boolean
}) {
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? 'rgba(37, 99, 235, 0.18)' : 'transparent',
        color: active ? '#60a5fa' : 'inherit',
        border: '1px solid rgba(148, 163, 184, 0.28)',
        borderRadius: 6,
        padding: '4px 10px',
        fontSize: 11,
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      {children}
    </button>
  )
}
// Silence unused-warning on the import while keeping it available for
// future inspector wiring.
void readAtomByPath
