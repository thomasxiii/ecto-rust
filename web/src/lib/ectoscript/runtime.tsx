// Graph → React runtime.
//
// Takes a CompileResult plus a mutable atom store and renders the
// element tree of the chosen root component. State changes go through
// `set(atomId, value)` which re-renders the preview.
//
// Element kinds we know about:
//   container   — a flex column with the bound styles
//   checkbox    — a real <input type="checkbox">
//   task        — a heading row (text), editable when `is editable`
//   description — a paragraph row (text), editable when `is editable`
//   text        — generic text
// Anything else falls back to a styled div with the element name shown.

import React from 'react'
import type { EctoNode } from './graph'
import type { CompileResult } from './compiler'
import { readAtomByPath, resolveStyleByName } from './tokens'

export type AtomValues = Record<string, any>

export interface RuntimeProps {
  compiled: CompileResult
  atoms: AtomValues
  setAtom: (atomId: string, value: any) => void
  selectedElementId?: string | null
  onSelectElement?: (id: string | null) => void
}

export function initAtoms(compiled: CompileResult): AtomValues {
  const out: AtomValues = {}
  for (const node of compiled.graph.nodes) {
    if (node.type !== 'Atom') continue
    out[node.id] = literalToValue(node.data?.initial)
  }
  return out
}

function literalToValue(lit: any): any {
  if (!lit) return null
  switch (lit.kind) {
    case 'bool':
      return !!lit.value
    case 'number':
      return lit.value
    case 'string':
      return lit.value
    case 'color':
      return lit.value
    case 'unit':
      return `${lit.value}${lit.unit}`
    case 'ident':
      return lit.name
    case 'qualified':
      return lit.segments.join('.')
    default:
      return lit.value ?? null
  }
}

export function RuntimeView({
  compiled,
  atoms,
  setAtom,
  selectedElementId,
  onSelectElement,
}: RuntimeProps) {
  if (!compiled.rootComponentId) {
    return (
      <div style={{ padding: 16, color: '#94a3b8', fontSize: 13 }}>
        No component to render — declare a <code>component</code> in the editor.
      </div>
    )
  }
  const rootEl = childElementOf(compiled, compiled.rootComponentId)
  if (!rootEl) {
    return (
      <div style={{ padding: 16, color: '#94a3b8', fontSize: 13 }}>
        Component has no render tree.
      </div>
    )
  }
  // The "owning" component for atom resolution is the root component
  const rootCompNode = compiled.graph.nodes.find((n) => n.id === compiled.rootComponentId)
  const componentName = rootCompNode?.label ?? ''
  return (
    <ElementView
      compiled={compiled}
      atoms={atoms}
      setAtom={setAtom}
      element={rootEl}
      componentName={componentName}
      selectedElementId={selectedElementId ?? null}
      onSelectElement={onSelectElement}
    />
  )
}

function childElementOf(compiled: CompileResult, parentId: string): EctoNode | null {
  const e = compiled.graph.edges.find(
    (edge) => edge.source === parentId && edge.type === 'HAS_ELEMENT',
  )
  if (!e) return null
  return compiled.graph.nodes.find((n) => n.id === e.target) ?? null
}

function childrenOf(compiled: CompileResult, parentId: string): EctoNode[] {
  return compiled.graph.edges
    .filter((edge) => edge.source === parentId && edge.type === 'HAS_CHILD')
    .map((edge) => compiled.graph.nodes.find((n) => n.id === edge.target))
    .filter((n): n is EctoNode => !!n)
}

function elementStylesByName(compiled: CompileResult, elId: string): string[] {
  return compiled.graph.edges
    .filter((e) => e.source === elId && e.type === 'USES_STYLE')
    .map((e) => compiled.graph.nodes.find((n) => n.id === e.target)?.label)
    .filter((s): s is string => !!s)
}

function bindingsOf(compiled: CompileResult, elId: string): { prop: string; atomId: string }[] {
  const out: { prop: string; atomId: string }[] = []
  const bindingEdges = compiled.graph.edges.filter(
    (e) => e.source === elId && e.type === 'BINDS',
  )
  for (const be of bindingEdges) {
    const bNode = compiled.graph.nodes.find((n) => n.id === be.target)
    if (!bNode) continue
    const writes = compiled.graph.edges.find(
      (e) => e.source === bNode.id && e.type === 'WRITES',
    )
    if (writes) {
      out.push({ prop: bNode.data?.prop ?? '', atomId: writes.target })
    }
  }
  return out
}

function eventsOf(compiled: CompileResult, elId: string): { event: string; actions: any[] }[] {
  const evs = compiled.graph.edges
    .filter((e) => e.source === elId && e.type === 'HAS_EVENT')
    .map((e) => compiled.graph.nodes.find((n) => n.id === e.target))
    .filter((n): n is EctoNode => !!n)
  return evs.map((evNode) => {
    const acts = compiled.graph.edges
      .filter((e) => e.source === evNode.id && e.type === 'TRIGGERS')
      .map((e) => compiled.graph.nodes.find((n) => n.id === e.target))
      .filter((n): n is EctoNode => !!n)
      .map((a) => ({
        op: a.data?.op,
        target: a.data?.target as string[],
        writesAtomId:
          compiled.graph.edges.find((e) => e.source === a.id && e.type === 'WRITES')?.target,
      }))
    return { event: evNode.label, actions: acts }
  })
}

function traitsOf(compiled: CompileResult, elId: string): string[] {
  return compiled.graph.edges
    .filter((e) => e.source === elId && e.type === 'HAS_TRAIT')
    .map((e) => compiled.graph.nodes.find((n) => n.id === e.target))
    .filter((n): n is EctoNode => !!n && n.type === 'Trait')
    .map((n) => n!.data?.trait ?? n!.label)
}

interface EVProps {
  compiled: CompileResult
  atoms: AtomValues
  setAtom: (atomId: string, value: any) => void
  element: EctoNode
  componentName: string
  selectedElementId: string | null
  onSelectElement?: (id: string | null) => void
}

function ElementView({
  compiled,
  atoms,
  setAtom,
  element,
  componentName,
  selectedElementId,
  onSelectElement,
}: EVProps) {
  // visibility — `when`
  const whenAtom = element.data?.when as string | undefined
  if (whenAtom) {
    const segs = whenAtom.includes('.') ? whenAtom.split('.') : [whenAtom]
    const path = segs.length === 1 ? [componentName, segs[0]] : segs
    const value = readAtomByPath(path, { compiled, atomValues: atoms })
    if (!value) return null
  }

  // styles
  const styleNames = elementStylesByName(compiled, element.id)
  const ctx = { compiled, atomValues: atoms }
  let mergedStyle: React.CSSProperties = {}
  for (const sn of styleNames) {
    Object.assign(mergedStyle, resolveStyleByName(sn, ctx))
  }

  // bindings — figure out which prop maps to which atom
  const binds = bindingsOf(compiled, element.id)
  const checkedBinding = binds.find((b) => b.prop === 'checked')
  const textBinding = binds.find((b) => b.prop === 'text')

  // events
  const evs = eventsOf(compiled, element.id)
  const handlers: Record<string, React.EventHandler<any>> = {}
  for (const ev of evs) {
    const reactEvent = REACT_EVENT_MAP[ev.event] ?? `on${capitalize(ev.event)}`
    handlers[reactEvent] = (e: any) => {
      e.stopPropagation?.()
      for (const a of ev.actions) {
        if (a.writesAtomId == null) continue
        const cur = atoms[a.writesAtomId]
        if (a.op === 'toggle') setAtom(a.writesAtomId, !cur)
        else if (a.op === 'set') setAtom(a.writesAtomId, !cur) // basic fallback
      }
    }
  }

  // traits
  const traits = traitsOf(compiled, element.id)
  const isEditable = traits.includes('editable')

  // children
  const childNodes = childrenOf(compiled, element.id).filter((n) => n.type === 'Element')

  const isSelected = selectedElementId === element.id
  const selectionRing: React.CSSProperties = isSelected
    ? { boxShadow: '0 0 0 2px #2563eb, ' + (mergedStyle.boxShadow ?? '0 0 transparent') }
    : {}
  const onMouseDown = (e: React.MouseEvent) => {
    if (e.altKey) {
      e.stopPropagation()
      onSelectElement?.(element.id)
    }
  }

  const commonProps = {
    onMouseDown,
    style: { ...mergedStyle, ...selectionRing, cursor: isEditable ? 'text' : 'default' },
    ...handlers,
  }

  const ename = element.label
  if (ename === 'checkbox') {
    const checked = checkedBinding ? !!atoms[checkedBinding.atomId] : false
    return (
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, ...commonProps.style }}>
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => {
            if (checkedBinding) setAtom(checkedBinding.atomId, e.target.checked)
          }}
          style={{ width: 18, height: 18, accentColor: '#2563eb' }}
        />
      </label>
    )
  }

  if (textBinding) {
    const text = String(atoms[textBinding.atomId] ?? '')
    if (isEditable) {
      return (
        <EditableText
          value={text}
          onChange={(v) => setAtom(textBinding.atomId, v)}
          style={commonProps.style}
          variant={ename}
          handlers={handlers}
          onMouseDown={onMouseDown}
        />
      )
    }
    return (
      <div {...commonProps}>
        <TextSpan variant={ename}>{text}</TextSpan>
      </div>
    )
  }

  // container or any unknown element — render children
  return (
    <div {...commonProps}>
      {childNodes.map((c) => (
        <ElementView
          key={c.id}
          compiled={compiled}
          atoms={atoms}
          setAtom={setAtom}
          element={c}
          componentName={componentName}
          selectedElementId={selectedElementId}
          onSelectElement={onSelectElement}
        />
      ))}
      {childNodes.length === 0 && ename !== 'container' ? (
        <TextSpan variant={ename}>{ename}</TextSpan>
      ) : null}
    </div>
  )
}

function TextSpan({ children, variant }: { children: React.ReactNode; variant: string }) {
  const sty: React.CSSProperties =
    variant === 'task'
      ? { fontSize: 15, fontWeight: 600 }
      : variant === 'description'
      ? { fontSize: 13, opacity: 0.7 }
      : { fontSize: 14 }
  return <span style={sty}>{children}</span>
}

function EditableText({
  value,
  onChange,
  style,
  variant,
  handlers,
  onMouseDown,
}: {
  value: string
  onChange: (v: string) => void
  style: React.CSSProperties
  variant: string
  handlers: Record<string, any>
  onMouseDown: (e: React.MouseEvent) => void
}) {
  const ref = React.useRef<HTMLDivElement>(null)
  // Keep DOM in sync when the value changes from outside (Reset, dark mode etc).
  React.useEffect(() => {
    if (ref.current && ref.current.innerText !== value) ref.current.innerText = value
  }, [value])
  const sty: React.CSSProperties =
    variant === 'task'
      ? { fontSize: 15, fontWeight: 600, outline: 'none', minHeight: 20 }
      : variant === 'description'
      ? { fontSize: 13, opacity: 0.7, outline: 'none', minHeight: 18 }
      : { fontSize: 14, outline: 'none', minHeight: 18 }
  return (
    <div
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      onMouseDown={onMouseDown}
      onBlur={(e) => onChange(e.currentTarget.innerText)}
      style={{ ...style, ...sty }}
      {...handlers}
    >
      {value}
    </div>
  )
}

const REACT_EVENT_MAP: Record<string, string> = {
  click: 'onClick',
  doubleclick: 'onDoubleClick',
  dblclick: 'onDoubleClick',
  mouseenter: 'onMouseEnter',
  mouseleave: 'onMouseLeave',
  focus: 'onFocus',
  blur: 'onBlur',
  change: 'onChange',
  input: 'onInput',
  submit: 'onSubmit',
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
