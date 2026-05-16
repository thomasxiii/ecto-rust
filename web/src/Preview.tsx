// Renders an engine RenderTreeNode as live React. Mirrors the iframe-
// portal pattern from ecto-engine so global styles + a real <body>
// match cleanly. Whitelists the HTML tags we know are safe to emit.

import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { RenderTreeNode } from './engine'

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
