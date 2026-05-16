// MiniAppView — the live, interactive view of any graph loaded into the
// MiniRuntime. Renders the materialized render tree, wires click & change
// events through WASM, shows the cypher dump alongside.

import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  ensureEngineReady,
  generateMiniApp,
  MiniRuntime,
  type MiniGraphPayload,
  type MiniPatch,
  type MiniRenderNode,
  type MiniRuntimeSnapshot,
  type MiniValue,
} from './engine'
import { TEMPLATES, type MiniTemplate } from './miniTemplates'
import { Button, Input, Modal, Textarea, tokens } from './ui'

interface AppMeta {
  title: string
  reasoning?: string
}

export function MiniAppView({ onBack }: { onBack: () => void }) {
  const runtimeRef = useRef<MiniRuntime | null>(null)
  const [ready, setReady] = useState(false)
  const [snapshot, setSnapshot] = useState<MiniRuntimeSnapshot | null>(null)
  const [patches, setPatches] = useState<MiniPatch[]>([])
  const [cypher, setCypher] = useState('')
  const [designMode, setDesignMode] = useState(false)
  const [eventCount, setEventCount] = useState(0)
  const [meta, setMeta] = useState<AppMeta>({ title: 'Toggle (built-in)' })
  const [newModalOpen, setNewModalOpen] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState<string | null>(null)

  // ── lifecycle ──────────────────────────────────────────────────────────

  useEffect(() => {
    ensureEngineReady().then(() => {
      const rt = new MiniRuntime()
      runtimeRef.current = rt
      setSnapshot(rt.materialize(designMode))
      setCypher(rt.cypherDump())
      setReady(true)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const rt = runtimeRef.current
    if (!rt) return
    setSnapshot(rt.materialize(designMode))
  }, [designMode])

  // ── dispatch ───────────────────────────────────────────────────────────

  const dispatch = (element: string, event: string, payload?: MiniValue) => {
    const rt = runtimeRef.current
    if (!rt) return
    const newPatches =
      payload === undefined
        ? rt.handleEvent(element, event)
        : rt.dispatchEvent(element, event, payload)
    setSnapshot(rt.materialize(designMode))
    setCypher(rt.cypherDump())
    if (newPatches.length > 0) {
      setPatches(newPatches)
      setEventCount((c) => c + 1)
    }
  }

  // ── load a generated/templated payload ─────────────────────────────────

  const applyPayload = (payload: MiniGraphPayload, m: AppMeta) => {
    const rt = runtimeRef.current
    if (!rt) return
    rt.loadGraph(payload)
    setSnapshot(rt.materialize(designMode))
    setCypher(rt.cypherDump())
    setPatches([])
    setEventCount(0)
    setMeta(m)
    setNewModalOpen(false)
  }

  const submitPrompt = async (prompt: string) => {
    setGenerating(true)
    setGenError(null)
    try {
      const res = await generateMiniApp(prompt)
      applyPayload(res.payload, {
        title: extractTitle(res) ?? 'Generated app',
        reasoning: res.reasoning,
      })
    } catch (err) {
      setGenError(err instanceof Error ? err.message : String(err))
    } finally {
      setGenerating(false)
    }
  }

  const useTemplate = (t: MiniTemplate) => {
    applyPayload(t.payload, { title: t.title })
  }

  // ── derived UI state ───────────────────────────────────────────────────

  const clickBindings = useMemo(() => {
    const map = new Map<string, Set<string>>()
    if (!snapshot) return map
    for (const b of snapshot.bindings) {
      if (!map.has(b.element)) map.set(b.element, new Set())
      map.get(b.element)!.add(b.event)
    }
    return map
  }, [snapshot])

  const inspectorText = useMemo(() => {
    if (!cypher) return ''
    return `${cypher}\n${formatPatchesSection(patches, eventCount)}`
  }, [cypher, patches, eventCount])

  if (!ready || !snapshot) {
    return (
      <div style={{ padding: 32, color: tokens.fgMuted }}>Loading mini runtime…</div>
    )
  }

  return (
    <div style={{ display: 'flex', width: '100%', height: '100%' }}>
      <main
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          background: tokens.bg,
          minWidth: 0,
        }}
      >
        <header
          style={{
            padding: '12px 20px',
            borderBottom: `1px solid ${tokens.border}`,
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            background: tokens.bg,
          }}
        >
          <Button variant="ghost" onClick={onBack}>← Back</Button>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{meta.title}</span>
            {meta.reasoning && (
              <span style={{ fontSize: 11, color: tokens.fgMuted }}>{meta.reasoning}</span>
            )}
          </div>
          <span style={{ marginLeft: 'auto', fontSize: 11, color: tokens.fgMuted }}>
            events: {eventCount}
          </span>
          <label
            style={{
              fontSize: 12,
              color: tokens.fgMuted,
              display: 'flex',
              gap: 6,
              alignItems: 'center',
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={designMode}
              onChange={(e) => setDesignMode(e.target.checked)}
            />
            design mode
          </label>
          <Button onClick={() => setNewModalOpen(true)}>+ New</Button>
        </header>

        <div
          style={{
            flex: 1,
            position: 'relative',
            overflow: 'auto',
            background: tokens.bgMuted,
          }}
        >
          <Stage
            node={snapshot.renderTree}
            styles={snapshot.styles}
            atoms={snapshot.atoms}
            bindings={clickBindings}
            onEvent={dispatch}
          />
        </div>
      </main>

      <aside
        style={{
          width: 460,
          borderLeft: `1px solid ${tokens.border}`,
          background: tokens.bg,
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
        }}
      >
        <div
          style={{
            padding: '12px 16px',
            borderBottom: `1px solid ${tokens.border}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            fontSize: 11,
            color: tokens.fgMuted,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
          }}
        >
          <span>Graph + state (Cypher-like)</span>
          <Button
            variant="ghost"
            onClick={() => navigator.clipboard?.writeText(inspectorText)}
            style={{ fontSize: 11, padding: '2px 8px' }}
            title="Copy to clipboard"
          >
            copy
          </Button>
        </div>
        <textarea
          readOnly
          value={inspectorText}
          spellCheck={false}
          style={{
            flex: 1,
            width: '100%',
            background: tokens.bg,
            color: tokens.fg,
            border: 'none',
            outline: 'none',
            padding: 16,
            resize: 'none',
            fontFamily: tokens.fontMono,
            fontSize: 12,
            lineHeight: 1.55,
            whiteSpace: 'pre',
          }}
        />
      </aside>

      <NewAppModal
        open={newModalOpen}
        onClose={() => setNewModalOpen(false)}
        onSubmitPrompt={submitPrompt}
        onUseTemplate={useTemplate}
        generating={generating}
        error={genError}
      />
    </div>
  )
}

// ─── new-app modal ───────────────────────────────────────────────────────

function NewAppModal({
  open,
  onClose,
  onSubmitPrompt,
  onUseTemplate,
  generating,
  error,
}: {
  open: boolean
  onClose: () => void
  onSubmitPrompt: (prompt: string) => void
  onUseTemplate: (t: MiniTemplate) => void
  generating: boolean
  error: string | null
}) {
  const [prompt, setPrompt] = useState('')
  return (
    <Modal open={open} onClose={onClose} title="New mini app" width={620}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <label
            style={{
              fontSize: 12,
              color: tokens.fgMuted,
              display: 'block',
              marginBottom: 6,
              fontWeight: 500,
            }}
          >
            Describe the app you want to build
          </label>
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="A counter with +1 and reset buttons. Show the count in large text."
            rows={4}
            disabled={generating}
          />
          {error && (
            <div
              style={{
                marginTop: 8,
                padding: 10,
                background: '#fef2f2',
                color: '#b91c1c',
                border: '1px solid #fecaca',
                borderRadius: 6,
                fontSize: 12,
              }}
            >
              {error}
            </div>
          )}
          <div
            style={{
              marginTop: 10,
              display: 'flex',
              justifyContent: 'flex-end',
              gap: 8,
            }}
          >
            <Button variant="secondary" onClick={onClose} disabled={generating}>
              Cancel
            </Button>
            <Button
              onClick={() => onSubmitPrompt(prompt)}
              disabled={!prompt.trim() || generating}
            >
              {generating ? 'Generating…' : 'Create with Claude'}
            </Button>
          </div>
        </div>

        <div
          style={{
            borderTop: `1px solid ${tokens.border}`,
            paddingTop: 16,
          }}
        >
          <div
            style={{
              fontSize: 11,
              color: tokens.fgMuted,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              marginBottom: 10,
            }}
          >
            or start from a template
          </div>
          <div style={{ display: 'grid', gap: 8 }}>
            {TEMPLATES.map((t) => (
              <button
                key={t.id}
                onClick={() => onUseTemplate(t)}
                disabled={generating}
                style={{
                  textAlign: 'left',
                  background: tokens.bg,
                  border: `1px solid ${tokens.border}`,
                  borderRadius: tokens.radius,
                  padding: '12px 14px',
                  cursor: generating ? 'not-allowed' : 'pointer',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 2,
                  fontFamily: 'inherit',
                  color: tokens.fg,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = 'var(--accent)'
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = tokens.border
                }}
              >
                <span style={{ fontWeight: 600, fontSize: 14 }}>{t.title}</span>
                <span style={{ fontSize: 12, color: tokens.fgMuted }}>{t.description}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  )
}

// ─── stage / render-tree walker ──────────────────────────────────────────

function Stage({
  node,
  styles,
  atoms,
  bindings,
  onEvent,
}: {
  node: MiniRenderNode
  styles: MiniRuntimeSnapshot['styles']
  atoms: MiniRuntimeSnapshot['atoms']
  bindings: Map<string, Set<string>>
  onEvent: (element: string, event: string, payload?: MiniValue) => void
}) {
  return renderTree(node, styles, atoms, bindings, onEvent)
}

function renderTree(
  node: MiniRenderNode,
  styles: MiniRuntimeSnapshot['styles'],
  atoms: MiniRuntimeSnapshot['atoms'],
  bindings: Map<string, Set<string>>,
  onEvent: (element: string, event: string, payload?: MiniValue) => void,
): React.ReactNode {
  if (node.kind === 'component') {
    return (
      <>
        {node.children.map((c, i) => (
          <React.Fragment key={`${c.id}__${i}`}>
            {renderTree(c, styles, atoms, bindings, onEvent)}
          </React.Fragment>
        ))}
      </>
    )
  }
  if (node.kind !== 'element') return null

  const props = styles[node.id] ?? {}
  const style = miniStylesToCss(props)
  const events = bindings.get(node.id) ?? new Set<string>()
  const handlers: Record<string, any> = {}

  const isInput = node.tag === 'input' || node.tag === 'textarea'

  if (isInput) {
    if (events.has('change')) {
      handlers.onChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        onEvent(node.id, 'change', e.target.value)
      }
    } else {
      handlers.onChange = () => {} // satisfy React controlled-input warning
    }
  } else if (events.has('click')) {
    handlers.onClick = () => onEvent(node.id, 'click')
  }
  for (const ev of ['focus', 'blur', 'submit'] as const) {
    if (events.has(ev)) {
      const key = `on${ev[0].toUpperCase()}${ev.slice(1)}`
      handlers[key] = (e: any) => {
        if (ev === 'submit') e.preventDefault?.()
        onEvent(node.id, ev)
      }
    }
  }

  const passThroughAttrs: Record<string, any> = { ...node.attrs }
  // Inputs use the resolved text as their bound value, not as a child.
  if (isInput) {
    passThroughAttrs.value = node.text ?? ''
  }

  const tagName = (node.tag || 'div') as keyof JSX.IntrinsicElements
  const children = isInput
    ? null
    : [
        ...(node.text ? [<TextNode key="__text" value={node.text} />] : []),
        ...node.children.map((c, i) => (
          <React.Fragment key={`${c.id}__${i}`}>
            {renderTree(c, styles, atoms, bindings, onEvent)}
          </React.Fragment>
        )),
      ]

  return React.createElement(
    tagName,
    {
      style,
      'data-node-id': node.id,
      ...passThroughAttrs,
      ...handlers,
    },
    children,
  )
}

function TextNode({ value }: { value: string }) {
  return <>{value}</>
}

function miniStylesToCss(props: Record<string, MiniValue>): React.CSSProperties {
  const out: Record<string, string | number> = {}
  for (const [k, raw] of Object.entries(props)) {
    let v: string | number | null = null
    if (typeof raw === 'string' || typeof raw === 'number') v = raw
    if (v === null) continue
    if (k === 'translateX') {
      out.transform = `translateX(${typeof v === 'number' ? v + 'px' : v})`
      continue
    }
    if (
      typeof v === 'number' &&
      [
        'width',
        'height',
        'minHeight',
        'maxHeight',
        'minWidth',
        'maxWidth',
        'borderRadius',
        'padding',
        'paddingTop',
        'paddingRight',
        'paddingBottom',
        'paddingLeft',
        'margin',
        'marginTop',
        'marginRight',
        'marginBottom',
        'marginLeft',
        'top',
        'left',
        'right',
        'bottom',
        'gap',
        'rowGap',
        'columnGap',
      ].includes(k)
    ) {
      out[k] = `${v}px`
    } else {
      out[k] = v
    }
  }
  out.transition =
    'background 200ms ease, color 200ms ease, transform 200ms ease, border-color 200ms ease'
  return out
}

// ─── inspector helpers ───────────────────────────────────────────────────

function formatPatchesSection(patches: MiniPatch[], eventCount: number): string {
  const header =
    '// ── last patches ─────────────────────────────────────────────'
  if (eventCount === 0) {
    return `${header}\n(interact with the app to see patches)\n`
  }
  if (patches.length === 0) {
    return `${header}\n(last event produced no patches)\n`
  }
  const lines = patches.map((p) => `  ${patchLabel(p)}`)
  return `${header}\n# event #${eventCount}\n${lines.join('\n')}\n`
}

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
  if (Array.isArray(v)) return `[${v.map(fmt).join(', ')}]`
  if (typeof v === 'object')
    return `{ ${Object.entries(v).map(([k, val]) => `${k}: ${fmt(val as MiniValue)}`).join(', ')} }`
  return String(v)
}

function extractTitle(res: { reasoning?: string; raw?: string }): string | null {
  try {
    const obj = res.raw ? JSON.parse(stripFences(res.raw)) : null
    if (obj && typeof obj.title === 'string') return obj.title
  } catch {
    // ignore
  }
  return null
}

function stripFences(s: string): string {
  let out = s.trim()
  if (out.startsWith('```')) out = out.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
  return out
}
