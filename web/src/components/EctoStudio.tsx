import React from 'react'
import { EctoEditor } from './EctoEditor'
import { RuntimeView } from './RuntimeView'
import { GraphJsonPanel } from './GraphJsonPanel'
import { Graph3DPanel } from './Graph3DPanel'
import { InspectorPanel } from './InspectorPanel'
import {
  compileEctoscript,
  ensureEngineReady,
  getStarterEctoscript,
  MiniRuntime,
  type EctoScriptParseError,
  type EctoScriptResult,
  type MiniGraphPayload,
  type MiniPatch,
  type MiniValue,
  type RuntimeSnapshot,
} from '../engine'

type BottomTab = 'graph' | '3d' | 'errors'

interface Props {
  onBack: () => void
}

const SERVER_URL =
  (import.meta as any).env?.VITE_SERVER_URL ?? 'http://localhost:4000'

export function EctoStudio({ onBack }: Props) {
  const [source, setSource] = React.useState<string>('')
  const [ready, setReady] = React.useState(false)
  const runtimeRef = React.useRef<MiniRuntime | null>(null)
  const [snapshot, setSnapshot] = React.useState<RuntimeSnapshot | null>(null)
  const [graphPayload, setGraphPayload] = React.useState<MiniGraphPayload | null>(
    null,
  )
  const [errors, setErrors] = React.useState<EctoScriptParseError[]>([])
  const [cognitionError, setCognitionError] = React.useState<string | null>(null)
  const [selectedElementId, setSelectedElementId] = React.useState<string | null>(
    null,
  )
  const [tab, setTab] = React.useState<BottomTab>('graph')

  // One-time engine init + starter source.
  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      await ensureEngineReady()
      if (cancelled) return
      runtimeRef.current = new MiniRuntime()
      setSource(getStarterEctoscript())
      setReady(true)
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Compile-and-load whenever source changes (debounced). We track
  // whether this is the very first load so we can call `loadGraph`
  // (a clean reset) once at startup and `updatePayload` on every
  // subsequent edit — the latter preserves atom values so form inputs,
  // toggles, and accumulated lists survive each keystroke.
  const hasLoadedOnceRef = React.useRef(false)
  React.useEffect(() => {
    if (!ready) return
    const handle = setTimeout(() => {
      try {
        const result: EctoScriptResult = compileEctoscript(source)
        setErrors(result.errors)
        if (!runtimeRef.current) return
        if (hasLoadedOnceRef.current) {
          runtimeRef.current.updatePayload(result.graph)
        } else {
          runtimeRef.current.loadGraph(result.graph)
          hasLoadedOnceRef.current = true
        }
        setGraphPayload(result.graph)
        const snap = runtimeRef.current.materialize(false)
        setSnapshot(snap)
        setCognitionError(null)
      } catch (e) {
        setErrors([
          {
            message: `compile failed: ${(e as Error).message ?? String(e)}`,
            line: 1,
            col: 1,
          },
        ])
      }
    }, 80)
    return () => clearTimeout(handle)
  }, [source, ready])

  const onEvent = React.useCallback(
    (
      element: string,
      event: string,
      payload?: MiniValue,
      itemId?: string,
      itemAtom?: string,
    ) => {
      const rt = runtimeRef.current
      if (!rt) return
      const patches = rt.dispatchEvent(element, event, payload, itemId, itemAtom)
      handlePatches(rt, patches, setCognitionError)
      setSnapshot(rt.materialize(false))
    },
    [],
  )

  const resetState = React.useCallback(() => {
    if (!runtimeRef.current) return
    try {
      const result = compileEctoscript(source)
      runtimeRef.current.loadGraph(result.graph)
      setSnapshot(runtimeRef.current.materialize(false))
      setCognitionError(null)
    } catch {
      // ignore — already surfaced in errors
    }
  }, [source])

  const allErrors: EctoScriptParseError[] = React.useMemo(() => {
    if (!cognitionError) return errors
    return [...errors, { message: cognitionError, line: 1, col: 1 }]
  }, [errors, cognitionError])

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
          {graphPayload?.nodes.length ?? 0} nodes ·{' '}
          {graphPayload?.edges.length ?? 0} edges ·{' '}
          {allErrors.length === 0 ? (
            <span style={{ color: '#34d399' }}>compiled (Rust + WASM)</span>
          ) : (
            <span style={{ color: '#f87171' }}>
              {allErrors.length} error(s)
            </span>
          )}
        </div>
        <div style={{ marginLeft: 'auto', opacity: 0.4, fontSize: 11 }}>
          alt-click an element in the preview to inspect its node
        </div>
        <button
          onClick={resetState}
          style={{
            background: 'transparent',
            color: '#cbd5e1',
            border: '1px solid rgba(148, 163, 184, 0.28)',
            borderRadius: 6,
            padding: '6px 10px',
            fontSize: 11,
            cursor: 'pointer',
          }}
        >
          Reset state
        </button>
      </header>

      <section
        style={{
          gridArea: 'editor',
          borderRight: '1px solid rgba(148, 163, 184, 0.18)',
          minWidth: 0,
          minHeight: 0,
        }}
      >
        <EctoEditor value={source} onChange={setSource} errors={errors} />
      </section>

      <section
        style={{
          gridArea: 'runtime',
          borderRight: '1px solid rgba(148, 163, 184, 0.18)',
          minWidth: 0,
          minHeight: 0,
          background: '#f8fafc',
          color: '#0f172a',
        }}
      >
        {snapshot ? (
          <RuntimeView
            snapshot={snapshot}
            onEvent={onEvent}
            selectedElementId={selectedElementId}
            onSelectElement={setSelectedElementId}
          />
        ) : (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              height: '100%',
              fontSize: 12,
              opacity: 0.5,
            }}
          >
            {ready ? 'compiling…' : 'loading wasm…'}
          </div>
        )}
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
          payload={graphPayload}
          selectedId={selectedElementId}
          snapshot={snapshot}
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
                background:
                  tab === t ? 'rgba(37, 99, 235, 0.18)' : 'transparent',
                color: tab === t ? '#7dd3fc' : '#cbd5e1',
                border: '1px solid',
                borderColor:
                  tab === t ? 'rgba(37, 99, 235, 0.45)' : 'transparent',
                borderRadius: 6,
                padding: '4px 10px',
                fontSize: 11,
                cursor: 'pointer',
              }}
            >
              {t === 'graph'
                ? 'Graph JSON'
                : t === '3d'
                  ? '3D Graph'
                  : `Errors${allErrors.length > 0 ? ` (${allErrors.length})` : ''}`}
            </button>
          ))}
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          {tab === 'graph' ? (
            <GraphJsonPanel payload={graphPayload} errors={errors} />
          ) : tab === '3d' ? (
            <Graph3DPanel
              payload={graphPayload}
              selectedId={selectedElementId}
              onSelect={setSelectedElementId}
            />
          ) : (
            <ErrorsPanel errors={allErrors} />
          )}
        </div>
      </section>
    </div>
  )
}

// Walk a patch list, handling MatchPending side-effects by calling the
// cognition endpoint and feeding the result back via resolveMatch.
function handlePatches(
  rt: MiniRuntime,
  patches: MiniPatch[],
  setCognitionError: (m: string | null) => void,
) {
  for (const p of patches) {
    if (p.type !== 'matchPending') continue
    void runCognitionMatch(rt, p, setCognitionError)
  }
}

async function runCognitionMatch(
  rt: MiniRuntime,
  p: Extract<MiniPatch, { type: 'matchPending' }>,
  setCognitionError: (m: string | null) => void,
) {
  try {
    const res = await fetch(`${SERVER_URL}/api/cognition/match`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        input: p.input,
        candidates: p.candidates,
        field: p.by,
      }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      setCognitionError(`match failed (${res.status}): ${body}`)
      return
    }
    const data = (await res.json()) as { id?: string | null }
    rt.resolveMatch(p.atom, p.recordId, p.field, data.id ?? null)
  } catch (e) {
    setCognitionError(`match failed: ${(e as Error).message ?? String(e)}`)
  }
}

function ErrorsPanel({ errors }: { errors: EctoScriptParseError[] }) {
  if (errors.length === 0) {
    return (
      <div style={{ padding: 16, color: '#34d399', fontSize: 12 }}>
        ✓ No compiler errors.
      </div>
    )
  }
  return (
    <div
      style={{
        padding: 12,
        overflow: 'auto',
        height: '100%',
        fontSize: 12,
        fontFamily: 'JetBrains Mono, ui-monospace, monospace',
      }}
    >
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
