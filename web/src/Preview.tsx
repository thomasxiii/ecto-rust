// Renders an engine RenderTreeNode as live React. Mirrors the iframe-
// portal pattern from ecto-engine so global styles + a real <body>
// match cleanly. Whitelists the HTML tags we know are safe to emit.

import React, { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { NpmComponentRef, RenderTreeNode } from './engine'
import { loadModule } from './npmLoader'

const SAFE_TAGS = new Set([
  'div', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'a', 'button', 'input', 'select', 'textarea', 'label', 'form',
  'header', 'footer', 'main', 'section', 'article', 'nav', 'aside',
  'ul', 'ol', 'li', 'img', 'figure', 'figcaption', 'pre', 'code',
])

const SAFE_PROPS = new Set([
  'className', 'style', 'href', 'src', 'alt', 'type', 'value',
  'placeholder', 'disabled', 'aria-label', 'role', 'id', 'title',
])

interface Props {
  tree: RenderTreeNode | null
  css: string
  classesByElement: Record<string, string[]>
  onSelect?: (nodeId: string) => void
  selectedId?: string | null
}

export function Preview({ tree, css, classesByElement, onSelect, selectedId }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [mountRoot, setMountRoot] = useState<HTMLElement | null>(null)
  const [styleEl, setStyleEl] = useState<HTMLStyleElement | null>(null)

  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe) return
    const doc = iframe.contentDocument
    if (!doc) return
    doc.open()
    doc.write(
      `<!doctype html><html><head><style id="ecto-style"></style></head><body></body></html>`,
    )
    doc.close()
    setMountRoot(doc.body)
    setStyleEl(doc.getElementById('ecto-style') as HTMLStyleElement)
  }, [])

  useEffect(() => {
    if (styleEl) styleEl.textContent = css
  }, [css, styleEl])

  return (
    <div style={{ width: '100%', height: '100%', background: '#fff' }}>
      <iframe
        ref={iframeRef}
        title="ecto preview"
        sandbox="allow-same-origin"
        style={{ width: '100%', height: '100%', border: 'none' }}
      />
      {mountRoot && tree
        ? createPortal(
            <RenderNode node={tree} classesByElement={classesByElement} onSelect={onSelect} selectedId={selectedId} />,
            mountRoot,
          )
        : null}
    </div>
  )
}

interface RNProps {
  node: RenderTreeNode
  classesByElement: Record<string, string[]>
  onSelect?: (nodeId: string) => void
  selectedId?: string | null
}

function RenderNode({ node, classesByElement, onSelect, selectedId }: RNProps): React.ReactNode {
  if (node.kind === 'text') {
    return String((node.props as { value?: unknown }).value ?? '')
  }
  if (node.kind === 'fragment') {
    return (
      <>
        {node.children.map((c) => (
          <RenderNode
            key={c.renderKey}
            node={c}
            classesByElement={classesByElement}
            onSelect={onSelect}
            selectedId={selectedId}
          />
        ))}
      </>
    )
  }
  // NPM-component wrapper: short-circuit to a Suspense-loaded export.
  // The graph element's safe props pass through; children are rendered
  // recursively and slotted in.
  if (node.metadata?.npmComponent) {
    return (
      <Suspense
        key={node.renderKey}
        fallback={<NpmFallback npmRef={node.metadata.npmComponent} />}
      >
        <NpmComponent
          npmRef={node.metadata.npmComponent}
          rawProps={node.props}
          classesByElement={classesByElement}
          mountId={node.id}
        >
          {node.children.map((c) => (
            <RenderNode
              key={c.renderKey}
              node={c}
              classesByElement={classesByElement}
              onSelect={onSelect}
              selectedId={selectedId}
            />
          ))}
        </NpmComponent>
      </Suspense>
    )
  }
  const tag = (node.tagHint ?? 'div').toLowerCase()
  if (!SAFE_TAGS.has(tag)) {
    return (
      <span style={{ background: '#fee', color: '#900', padding: 2 }}>⟨{node.tagHint}⟩</span>
    )
  }
  const props: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node.props ?? {})) {
    if (!SAFE_PROPS.has(k)) continue
    if (k === 'className' && typeof v === 'string') {
      const cls = [v, ...(classesByElement[node.id] ?? [])].filter(Boolean).join(' ')
      props.className = cls
    } else {
      props[k] = v
    }
  }
  if (props.className === undefined && classesByElement[node.id]?.length) {
    props.className = classesByElement[node.id].join(' ')
  }
  // Append a selection outline if this is the selected node.
  if (selectedId === node.id) {
    const existing = (props.style as React.CSSProperties) ?? {}
    props.style = { ...existing, outline: '2px solid #5af' }
  }
  if (onSelect) {
    props.onClick = (e: React.MouseEvent) => {
      e.stopPropagation()
      onSelect(node.id)
    }
  }
  return React.createElement(
    tag,
    { ...(props as object), key: node.renderKey },
    node.children.map((c) => (
      <RenderNode
        key={c.renderKey}
        node={c}
        classesByElement={classesByElement}
        onSelect={onSelect}
        selectedId={selectedId}
      />
    )),
  )
}

// ── NPM-component renderer ──────────────────────────────────────────
//
// Suspense-driven loader that dynamic-imports an npm bundle and renders
// the resolved export as a React element. Falls back to a placeholder
// while loading; surfaces import errors inline.

type ResourceState<T> = { status: 'pending'; promise: Promise<T> } | { status: 'ready'; value: T } | { status: 'error'; error: unknown }
const resourceCache = new Map<string, ResourceState<unknown>>()

function refKey(ref: NpmComponentRef): string {
  return `${ref.target}::${ref.packageName}@${ref.packageVersion}::${ref.exports.join(',')}::${ref.exportName}`
}

function readNpmComponent(ref: NpmComponentRef): React.ComponentType<Record<string, unknown>> {
  const key = refKey(ref)
  const existing = resourceCache.get(key)
  if (existing) {
    if (existing.status === 'ready') return existing.value as React.ComponentType<Record<string, unknown>>
    if (existing.status === 'error') throw existing.error
    throw existing.promise
  }
  const promise: Promise<React.ComponentType<Record<string, unknown>>> = loadModule({
    target: ref.target,
    name: ref.packageName,
    version: ref.packageVersion,
    exports: ref.exports,
  }).then((mod) => {
    const exp = (mod as Record<string, unknown>)[ref.exportName]
    if (exp == null) {
      const available = Object.keys(mod).join(', ')
      throw new Error(`npm export "${ref.exportName}" not found in ${ref.packageName}; available: ${available}`)
    }
    return exp as React.ComponentType<Record<string, unknown>>
  })
  const state: ResourceState<React.ComponentType<Record<string, unknown>>> = { status: 'pending', promise }
  resourceCache.set(key, state)
  promise.then(
    (value) => resourceCache.set(key, { status: 'ready', value }),
    (error) => resourceCache.set(key, { status: 'error', error }),
  )
  throw promise
}

interface NpmComponentProps {
  npmRef: NpmComponentRef
  rawProps: Record<string, unknown>
  classesByElement: Record<string, string[]>
  mountId: string
  children: React.ReactNode
}

function NpmComponent({ npmRef, rawProps, classesByElement, mountId, children }: NpmComponentProps) {
  const Mounted = readNpmComponent(npmRef)
  // Pass the element's graph-collected props through verbatim — npm
  // components are responsible for their own prop contracts. We layer
  // any computed className from the styles edges on top.
  const className = classesByElement[mountId]?.join(' ')
  const merged: Record<string, unknown> = { ...rawProps }
  if (className) {
    merged.className = [merged.className, className].filter(Boolean).join(' ')
  }
  return <Mounted {...merged}>{children}</Mounted>
}

function NpmFallback({ npmRef }: { npmRef: NpmComponentRef }) {
  return (
    <div
      style={{
        padding: '4px 8px',
        fontSize: 11,
        color: '#6b7280',
        background: '#f3f4f6',
        border: '1px dashed #d1d5db',
        borderRadius: 4,
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      loading {npmRef.packageName}@{npmRef.packageVersion}…
    </div>
  )
}
