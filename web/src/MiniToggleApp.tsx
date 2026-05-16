// MiniToggleApp — renders the mini-runtime's toggle demo as real DOM.
//
// On mount it builds a MiniRuntime (which bundles the toggle-app graph),
// materializes an initial snapshot, and walks the render tree to draw the
// UI. Clicking the toggleTrack calls into WASM `handleEvent`, which
// returns a patch list; we apply the patches by re-materializing (cheap
// for a five-node tree) so styles, atom, and derived caches all update
// together. The patch list is shown below the toggle for transparency.

import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  ensureEngineReady,
  MiniRuntime,
  type MiniPatch,
  type MiniRenderNode,
  type MiniRuntimeSnapshot,
  type MiniValue,
} from './engine'

export function MiniToggleApp({ onBack }: { onBack: () => void }) {
  const runtimeRef = useRef<MiniRuntime | null>(null)
  const [ready, setReady] = useState(false)
  const [snapshot, setSnapshot] = useState<MiniRuntimeSnapshot | null>(null)
  const [patches, setPatches] = useState<MiniPatch[]>([])
  const [cypher, setCypher] = useState('')
  const [designMode, setDesignMode] = useState(false)
  const [clickCount, setClickCount] = useState(0)

  useEffect(() => {
    ensureEngineReady().then(() => {
      runtimeRef.current = new MiniRuntime()
      setSnapshot(runtimeRef.current.materialize(designMode))
      setCypher(runtimeRef.current.cypherDump())
      setReady(true)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!runtimeRef.current) return
    setSnapshot(runtimeRef.current.materialize(designMode))
  }, [designMode])

  const dispatch = (element: string, event: string) => {
    const rt = runtimeRef.current
    if (!rt) return
    const newPatches = rt.handleEvent(element, event)
    if (newPatches.length === 0) return
    setPatches(newPatches)
    setSnapshot(rt.materialize(designMode))
    setCypher(rt.cypherDump())
    setClickCount((c) => c + 1)
  }

  const inspectorText = useMemo(() => {
    if (!cypher) return ''
    const patchesSection = formatPatchesSection(patches, clickCount)
    return `${cypher}\n${patchesSection}`
  }, [cypher, patches, clickCount])

  const bindingMap = useMemo(() => {
    const map = new Map<string, Set<string>>()
    if (!snapshot) return map
    for (const b of snapshot.bindings) {
      if (!map.has(b.element)) map.set(b.element, new Set())
      map.get(b.element)!.add(b.event)
    }
    return map
  }, [snapshot])

  if (!ready || !snapshot) {
    return <div style={panelStyle}>Loading mini runtime…</div>
  }

  return (
    <div style={{ display: 'flex', width: '100%', height: '100%' }}>
      <main
        style={{
          flex: 1,
          overflow: 'auto',
          background: '#0d0d11',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <header
          style={{
            padding: '12px 16px',
            borderBottom: '1px solid #2a2a30',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <button onClick={onBack} style={btn}>
            ← Back
          </button>
          <h3 style={{ margin: 0, fontSize: 14 }}>Mini toggle app</h3>
          <span style={{ marginLeft: 'auto', fontSize: 11, color: '#888' }}>
            clicks: {clickCount}
          </span>
          <label style={{ fontSize: 11, color: '#aaa', display: 'flex', gap: 6 }}>
            <input
              type="checkbox"
              checked={designMode}
              onChange={(e) => setDesignMode(e.target.checked)}
            />
            design mode
          </label>
        </header>
        <div style={{ flex: 1, position: 'relative' }}>
          <Stage
            node={snapshot.renderTree}
            styles={snapshot.styles}
            bindings={bindingMap}
            onEvent={dispatch}
          />
        </div>
      </main>

      <aside
        style={{
          width: 460,
          borderLeft: '1px solid #2a2a30',
          background: '#16161b',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
        }}
      >
        <div
          style={{
            padding: '10px 12px',
            borderBottom: '1px solid #2a2a30',
            fontSize: 11,
            color: '#888',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>Graph + state (Cypher-like)</span>
          <button
            onClick={() => navigator.clipboard?.writeText(inspectorText)}
            style={{ ...btn, padding: '2px 6px', fontSize: 11 }}
            title="Copy to clipboard"
          >
            copy
          </button>
        </div>
        <textarea
          readOnly
          value={inspectorText}
          spellCheck={false}
          style={{
            flex: 1,
            width: '100%',
            background: '#0f0f12',
            color: '#cfd0d4',
            border: 'none',
            outline: 'none',
            padding: 12,
            resize: 'none',
            fontFamily:
              'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            fontSize: 12,
            lineHeight: 1.45,
            whiteSpace: 'pre',
          }}
        />
      </aside>
    </div>
  )
}

function formatPatchesSection(patches: MiniPatch[], clickCount: number): string {
  const header =
    '// ── last patches ─────────────────────────────────────────────'
  if (clickCount === 0) {
    return `${header}\n(no clicks yet — click the toggle to see patches)\n`
  }
  if (patches.length === 0) {
    return `${header}\n(last event produced no patches)\n`
  }
  const lines = patches.map((p) => `  ${patchLabel(p)}`)
  return `${header}\n# click #${clickCount}\n${lines.join('\n')}\n`
}

// ─── stage / render-tree walker ──────────────────────────────────────────

function Stage({
  node,
  styles,
  bindings,
  onEvent,
}: {
  node: MiniRenderNode
  styles: MiniRuntimeSnapshot['styles']
  bindings: Map<string, Set<string>>
  onEvent: (element: string, event: string) => void
}) {
  return renderTree(node, styles, bindings, onEvent)
}

function renderTree(
  node: MiniRenderNode,
  styles: MiniRuntimeSnapshot['styles'],
  bindings: Map<string, Set<string>>,
  onEvent: (element: string, event: string) => void,
): React.ReactNode {
  const children = node.children.map((c) => (
    <React.Fragment key={c.id}>{renderTree(c, styles, bindings, onEvent)}</React.Fragment>
  ))
  if (node.kind === 'component') {
    // A component is invisible in the DOM — render its children directly.
    return <>{children}</>
  }
  if (node.kind === 'element') {
    const props = styles[node.id] ?? {}
    const style = miniStylesToCss(props)
    const events = bindings.get(node.id)
    const handlers: Record<string, () => void> = {}
    if (events?.has('click')) {
      handlers.onClick = () => onEvent(node.id, 'click')
    }
    const Tag = (node.tag || 'div') as keyof JSX.IntrinsicElements
    return React.createElement(Tag, { style, ...handlers, 'data-node-id': node.id }, children)
  }
  return null
}

function miniStylesToCss(props: Record<string, MiniValue>): React.CSSProperties {
  const out: Record<string, string | number> = {}
  for (const [k, raw] of Object.entries(props)) {
    let v: string | number | null = null
    if (typeof raw === 'string' || typeof raw === 'number') {
      v = raw
    }
    if (v === null) continue
    if (k === 'translateX') {
      out.transform = `translateX(${typeof v === 'number' ? v + 'px' : v})`
      // Smooth animation when the value changes.
      out.transition = 'transform 200ms ease, background 200ms ease, color 200ms ease'
      continue
    }
    if (
      typeof v === 'number' &&
      [
        'width',
        'height',
        'borderRadius',
        'padding',
        'margin',
        'top',
        'left',
        'right',
        'bottom',
      ].includes(k)
    ) {
      out[k] = `${v}px`
    } else {
      out[k] = v
    }
  }
  // Always include the cross-element transition for visible properties.
  out.transition = out.transition || 'background 200ms ease, color 200ms ease, transform 200ms ease'
  return out
}

// ─── inspector helpers ───────────────────────────────────────────────────

function patchLabel(p: MiniPatch): string {
  switch (p.type) {
    case 'atomChanged':
      return `atom ${p.node}: ${fmt(p.old)} → ${fmt(p.new)}`
    case 'derivedChanged':
      return `derived ${p.node}: ${fmt(p.old)} → ${fmt(p.new)}`
    case 'styleChanged':
      return `${p.element}.${p.property}: ${fmt(p.old)} → ${fmt(p.new)}`
    case 'eventHandled':
      return `event ${p.cause} → ${p.effect}`
  }
}

function fmt(v: MiniValue): string {
  if (typeof v === 'string') return JSON.stringify(v)
  if (v === null) return 'null'
  return String(v)
}

const panelStyle: React.CSSProperties = { padding: 24, color: '#aaa', fontSize: 13 }
const btn: React.CSSProperties = {
  background: '#3a3a45',
  border: 'none',
  borderRadius: 4,
  color: '#e6e6ea',
  padding: '6px 10px',
  cursor: 'pointer',
  fontSize: 12,
}
