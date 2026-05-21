import React from 'react'
import type {
  MiniPatch,
  MiniValue,
  RuntimeRenderNode,
  RuntimeSnapshot,
} from '../engine'

interface Props {
  snapshot: RuntimeSnapshot
  onEvent: (
    element: string,
    event: string,
    payload?: MiniValue,
    itemId?: string,
    itemAtom?: string,
  ) => void
  /** Receives MatchPending patches as they're emitted (e.g. by the
   * parent EctoStudio so it can hit /api/cognition/match). */
  onMatchPending?: (p: Extract<MiniPatch, { type: 'matchPending' }>) => void
  selectedElementId?: string | null
  onSelectElement?: (id: string | null) => void
}

export function RuntimeView({
  snapshot,
  onEvent,
  selectedElementId,
  onSelectElement,
}: Props) {
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        overflow: 'auto',
        background: 'transparent',
      }}
      onClick={() => onSelectElement?.(null)}
    >
      <NodeRenderer
        node={snapshot.renderTree}
        styles={snapshot.styles}
        onEvent={onEvent}
        selectedElementId={selectedElementId ?? null}
        onSelectElement={onSelectElement}
      />
    </div>
  )
}

interface NodeProps {
  node: RuntimeRenderNode
  styles: Record<string, Record<string, MiniValue>>
  onEvent: (
    element: string,
    event: string,
    payload?: MiniValue,
    itemId?: string,
    itemAtom?: string,
  ) => void
  selectedElementId: string | null
  onSelectElement?: (id: string | null) => void
}

function NodeRenderer({
  node,
  styles,
  onEvent,
  selectedElementId,
  onSelectElement,
}: NodeProps) {
  if (node.kind === 'component') {
    return (
      <>
        {node.children.map((c, i) => (
          <NodeRenderer
            key={`${c.id}::${i}::${c.itemId ?? ''}`}
            node={c}
            styles={styles}
            onEvent={onEvent}
            selectedElementId={selectedElementId}
            onSelectElement={onSelectElement}
          />
        ))}
      </>
    )
  }
  if (node.kind !== 'element' || !node.tag) {
    return null
  }

  const style = resolveStyle(styles[node.id] ?? null)
  const tag = node.tag
  const itemId = node.itemId ?? undefined
  const itemAtom = node.itemAtom ?? undefined

  const handlerFor = (event: string, payload?: MiniValue) => {
    return (e?: React.SyntheticEvent) => {
      e?.stopPropagation()
      onEvent(node.id, event, payload, itemId, itemAtom)
    }
  }

  const onAltClick = (e: React.MouseEvent) => {
    if (e.altKey) {
      e.stopPropagation()
      onSelectElement?.(node.id)
    }
  }

  const isSelected = selectedElementId === node.id
  const outline = isSelected ? '2px solid #60a5fa' : undefined

  // The renderer dispatches per-tag. Children are rendered recursively
  // (except for input/checkbox, which are leaf nodes).
  const childrenEls = node.children.map((c, i) => (
    <NodeRenderer
      key={`${c.id}::${i}::${c.itemId ?? ''}`}
      node={c}
      styles={styles}
      onEvent={onEvent}
      selectedElementId={selectedElementId}
      onSelectElement={onSelectElement}
    />
  ))

  switch (tag) {
    case 'container':
    case 'row':
    case 'task': {
      return (
        <div
          style={{ ...style, outline }}
          onClick={(e) => {
            onAltClick(e)
            // Don't intercept clicks for selection; the cause runtime decides.
            handlerFor('click')(e)
          }}
          onDoubleClick={handlerFor('doubleclick')}
          onMouseEnter={handlerFor('mouseenter')}
          onMouseLeave={handlerFor('mouseleave')}
        >
          {childrenEls}
        </div>
      )
    }
    case 'button': {
      const label = node.text ?? node.attrs.text ?? ''
      return (
        <button
          style={{ ...style, outline, cursor: 'pointer' }}
          onClick={(e) => {
            onAltClick(e)
            handlerFor('click')(e)
          }}
        >
          {label}
        </button>
      )
    }
    case 'input': {
      const value = node.text ?? ''
      const placeholder = node.attrs.placeholder ?? ''
      return (
        <input
          type="text"
          value={value}
          placeholder={placeholder}
          style={{
            ...style,
            outline,
            padding: '6px 10px',
            border: '1px solid #cbd5e1',
            borderRadius: 6,
            background: '#fff',
            color: '#0f172a',
            fontFamily: 'inherit',
            fontSize: 13,
            flex: 1,
            minWidth: 0,
          }}
          onClick={onAltClick}
          onChange={(e) =>
            onEvent(node.id, 'change', e.target.value, itemId, itemAtom)
          }
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              onEvent(node.id, 'submit', undefined, itemId, itemAtom)
            }
          }}
        />
      )
    }
    case 'checkbox': {
      const checked = node.text === 'true'
      return (
        <input
          type="checkbox"
          checked={checked}
          style={{ ...style, outline }}
          onClick={(e) => {
            onAltClick(e)
            e.stopPropagation()
          }}
          onChange={(e) =>
            onEvent(node.id, 'change', e.target.checked, itemId, itemAtom)
          }
        />
      )
    }
    case 'heading': {
      const text = node.text ?? node.attrs.text ?? ''
      return (
        <h2
          style={{
            ...style,
            outline,
            margin: 0,
            fontSize: 18,
            fontWeight: 600,
          }}
          onClick={(e) => {
            onAltClick(e)
            handlerFor('click')(e)
          }}
        >
          {text}
          {childrenEls}
        </h2>
      )
    }
    case 'subheading': {
      const text = node.text ?? node.attrs.text ?? ''
      return (
        <h3
          style={{ ...style, outline, margin: 0, fontSize: 13, fontWeight: 500 }}
          onClick={(e) => {
            onAltClick(e)
            handlerFor('click')(e)
          }}
        >
          {text}
          {childrenEls}
        </h3>
      )
    }
    case 'text':
    case 'label': {
      const text = node.text ?? node.attrs.text ?? ''
      return (
        <span
          style={{ ...style, outline, cursor: 'pointer' }}
          onClick={(e) => {
            onAltClick(e)
            handlerFor('click')(e)
          }}
        >
          {text}
          {childrenEls}
        </span>
      )
    }
    case 'description': {
      const text = node.text ?? node.attrs.text ?? ''
      const editable = node.attrs.editable === 'true'
      if (editable) {
        return (
          <span
            style={{ ...style, outline, minHeight: 18 }}
            contentEditable
            suppressContentEditableWarning
            onBlur={(e) =>
              onEvent(node.id, 'change', e.currentTarget.innerText, itemId, itemAtom)
            }
            onClick={onAltClick}
          >
            {text}
          </span>
        )
      }
      return (
        <span style={{ ...style, outline }} onClick={onAltClick}>
          {text}
        </span>
      )
    }
    default: {
      // Fallback — render as a div with the resolved text.
      return (
        <div style={{ ...style, outline }} onClick={onAltClick}>
          {node.text ?? ''}
          {childrenEls}
        </div>
      )
    }
  }
}

function resolveStyle(
  map: Record<string, MiniValue> | null,
): React.CSSProperties {
  if (!map) return {}
  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(map)) {
    out[k] = v == null ? undefined : String(v)
  }
  return out as React.CSSProperties
}
