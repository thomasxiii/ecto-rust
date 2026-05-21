import React from 'react'
import { EctoEditor } from './EctoEditor'
import { RuntimePreview } from './RuntimePreview'
import { GraphJsonPanel } from './GraphJsonPanel'
import { Graph3DPanel } from './Graph3DPanel'
import { InspectorPanel } from './InspectorPanel'
import { parse } from '../lib/ectoscript/parser'
import { compile, type CompileResult } from '../lib/ectoscript/compiler'
import { STARTER_ECTOSCRIPT } from '../lib/ectoscript/monacoLanguage'
import { initAtoms, type AtomValues } from '../lib/ectoscript/runtime'

type BottomTab = 'graph' | '3d' | 'errors'

interface Props {
  onBack: () => void
}

export function EctoStudio({ onBack }: Props) {
  const [source, setSource] = React.useState<string>(STARTER_ECTOSCRIPT)
  const parsed = React.useMemo(() => parse(source), [source])
  const compiled: CompileResult = React.useMemo(() => compile(parsed), [parsed])

  // The atom store. When the graph's atom IDs change (e.g. recompile),
  // we reseed any new atoms while keeping existing live values.
  const [atoms, setAtoms] = React.useState<AtomValues>(() => initAtoms(compiled))
  const lastCompiledRef = React.useRef(compiled)
  React.useEffect(() => {
    const fresh = initAtoms(compiled)
    setAtoms((prev) => {
      const out: AtomValues = { ...fresh }
      for (const id of Object.keys(fresh)) {
        if (id in prev) out[id] = prev[id]
      }
      return out
    })
    lastCompiledRef.current = compiled
  }, [compiled])

  const setAtom = React.useCallback(
    (id: string, v: any | ((cur: any) => any)) => {
      setAtoms((p) => {
        const next = typeof v === 'function' ? (v as (cur: any) => any)(p[id]) : v
        return { ...p, [id]: next }
      })
    },
    [],
  )
  const resetAtoms = React.useCallback(() => {
    setAtoms(initAtoms(compiled))
  }, [compiled])

  const [selectedElementId, setSelectedElementId] = React.useState<string | null>(null)
  const [tab, setTab] = React.useState<BottomTab>('graph')
  const [cognitionError, setCognitionError] = React.useState<string | null>(null)

  const errors = [
    ...parsed.errors,
    ...compiled.errors.map((e) => ({ message: e.message, line: e.line ?? 1, col: e.col ?? 1 })),
    ...(cognitionError ? [{ message: cognitionError, line: 1, col: 1 }] : []),
  ]

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr 320px',
        gridTemplateRows: 'auto 1fr 280px',
        gridTemplateAreas: `
          "header header header"
          "editor runtime inspector"
          "bottom bottom inspector"
        `,
        width: '100%',
        height: '100vh',
        background: '#020617',
        color: '#e2e8f0',
        fontFamily: 'Inter, system-ui, sans-serif',
      }}
    >
      <header
        style={{
          gridArea: 'header',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '10px 16px',
          borderBottom: '1px solid rgba(148, 163, 184, 0.18)',
          background: 'rgba(15, 23, 42, 0.6)',
          backdropFilter: 'blur(10px)',
        }}
      >
        <button
          onClick={onBack}
          style={{
            background: 'transparent',
            color: '#cbd5e1',
            border: '1px solid rgba(148, 163, 184, 0.28)',
            borderRadius: 6,
            padding: '6px 10px',
            fontSize: 12,
            cursor: 'pointer',
          }}
        >
          ← back
        </button>
        <div style={{ fontWeight: 600, fontSize: 14 }}>EctoStudio</div>
        <div style={{ opacity: 0.55, fontSize: 11 }}>
          {compiled.graph.nodes.length} nodes · {compiled.graph.edges.length} edges ·{' '}
          {errors.length === 0 ? (
            <span style={{ color: '#34d399' }}>compiled</span>
          ) : (
            <span style={{ color: '#f87171' }}>{errors.length} error(s)</span>
          )}
        </div>
        <div style={{ marginLeft: 'auto', opacity: 0.4, fontSize: 11 }}>
          tip — alt-click an element in the preview to inspect its graph node
        </div>
      </header>

      <section
        style={{
          gridArea: 'editor',
          borderRight: '1px solid rgba(148, 163, 184, 0.18)',
          minWidth: 0,
          minHeight: 0,
        }}
      >
        <EctoEditor value={source} onChange={setSource} errors={parsed.errors} />
      </section>

      <section
        style={{
          gridArea: 'runtime',
          borderRight: '1px solid rgba(148, 163, 184, 0.18)',
          minWidth: 0,
          minHeight: 0,
        }}
      >
        <RuntimePreview
          compiled={compiled}
          atoms={atoms}
          setAtom={setAtom}
          resetAtoms={() => {
            resetAtoms()
            setCognitionError(null)
          }}
          selectedElementId={selectedElementId}
          onSelectElement={setSelectedElementId}
          onCognitionError={(msg) => setCognitionError(msg)}
        />
      </section>

      <aside
        style={{
          gridArea: 'inspector',
          borderLeft: '1px solid rgba(148, 163, 184, 0.18)',
          background: 'rgba(15, 23, 42, 0.45)',
          minHeight: 0,
        }}
      >
        <InspectorPanel
          graph={compiled.graph}
          selectedId={selectedElementId}
          atomValues={atoms}
        />
      </aside>

      <section
        style={{
          gridArea: 'bottom',
          borderTop: '1px solid rgba(148, 163, 184, 0.18)',
          background: 'rgba(15, 23, 42, 0.55)',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            padding: '6px 10px',
            borderBottom: '1px solid rgba(148, 163, 184, 0.18)',
            fontSize: 11,
          }}
        >
          {(['graph', '3d', 'errors'] as BottomTab[]).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              style={{
                background: tab === t ? 'rgba(37, 99, 235, 0.18)' : 'transparent',
                color: tab === t ? '#7dd3fc' : '#cbd5e1',
                border: '1px solid',
                borderColor: tab === t ? 'rgba(37, 99, 235, 0.45)' : 'transparent',
                borderRadius: 6,
                padding: '4px 10px',
                fontSize: 11,
                cursor: 'pointer',
              }}
            >
              {t === 'graph' ? 'Graph JSON' : t === '3d' ? '3D Graph' : `Compiler Errors${errors.length > 0 ? ` (${errors.length})` : ''}`}
            </button>
          ))}
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          {tab === 'graph' ? (
            <GraphJsonPanel graph={compiled.graph} errors={parsed.errors} />
          ) : tab === '3d' ? (
            <Graph3DPanel
              graph={compiled.graph}
              selectedId={selectedElementId}
              onSelect={setSelectedElementId}
            />
          ) : (
            <ErrorsPanel errors={errors} />
          )}
        </div>
      </section>
    </div>
  )
}

function ErrorsPanel({
  errors,
}: {
  errors: { message: string; line: number; col: number }[]
}) {
  if (errors.length === 0) {
    return (
      <div style={{ padding: 16, color: '#34d399', fontSize: 12 }}>
        ✓ No compiler errors.
      </div>
    )
  }
  return (
    <div style={{ padding: 12, overflow: 'auto', height: '100%', fontSize: 12, fontFamily: 'JetBrains Mono, ui-monospace, monospace' }}>
      {errors.map((e, i) => (
        <div
          key={i}
          style={{
            padding: '6px 10px',
            marginBottom: 4,
            background: 'rgba(239, 68, 68, 0.1)',
            border: '1px solid rgba(239, 68, 68, 0.32)',
            borderRadius: 4,
            color: '#fecaca',
          }}
        >
          <span style={{ color: '#f87171' }}>
            line {e.line}, col {e.col}:
          </span>{' '}
          {e.message}
        </div>
      ))}
    </div>
  )
}
