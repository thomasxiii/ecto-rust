// Graph → React runtime.
//
// Takes a CompileResult plus a mutable atom store and renders the
// element tree of the chosen root component. State changes go through
// `setAtom(id, valueOrUpdater)` which re-renders the preview.
//
// Element kinds we know about:
//   container   — a flex column with the bound styles
//   row         — a flex row
//   checkbox    — a real <input type="checkbox">
//   input       — a real <input type="text">, fires `submit` on Enter
//   button      — a <button>, renders its `text:` attr as label
//   task        — a heading row (text), editable when `is editable`
//   description — a paragraph row (text), editable when `is editable`
//   text/label  — generic text; renders `text:` attr or text binding
//   for         — loop element; iterates a collection and renders children
//                 once per item, exposing `loopVar` in the path scope
// Anything else falls back to a styled div with the element name shown.

import React from 'react'
import type { EctoNode } from './graph'
import type { CompileResult } from './compiler'
import type { ValueExpr, Literal } from './parser'
import { resolveStyleByName } from './tokens'

const SERVER_URL =
  (typeof import.meta !== 'undefined' &&
    (import.meta as { env?: { VITE_SERVER_URL?: string } }).env?.VITE_SERVER_URL) ||
  'http://localhost:4000'

export type AtomValues = Record<string, any>
type AtomUpdater = (id: string, value: any | ((cur: any) => any)) => void

export interface RuntimeProps {
  compiled: CompileResult
  atoms: AtomValues
  setAtom: AtomUpdater
  selectedElementId?: string | null
  onSelectElement?: (id: string | null) => void
  onCognitionError?: (message: string) => void
}

// A scope is a map from loop-variable name → the current iteration's
// record plus a setter that patches that record in its underlying
// collection. References like `task.text` look up the head of the
// path here first; writes (checkboxes, `toggle task.expanded`, etc.)
// route through `setField` so the change persists in the collection.
interface ScopeBinding {
  value: any
  setField?: (field: string, value: any) => void
}
type Scope = Record<string, ScopeBinding>

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
    case 'list':
      return []
    case 'null':
      return null
    default:
      return lit.value ?? null
  }
}

// ── Path / expression resolution ─────────────────────────────────────

function readPath(
  segs: string[],
  compiled: CompileResult,
  atoms: AtomValues,
  scope: Scope,
  componentName: string,
): any {
  if (segs.length === 0) return undefined
  const head = segs[0]
  // 1. Loop-variable scope wins.
  if (head in scope) {
    let v: any = scope[head].value
    for (let i = 1; i < segs.length; i++) {
      if (v == null) return v
      v = (v as any)[segs[i]]
    }
    return v
  }
  // 2. Queries — single-segment query names resolve to a filtered array.
  if (segs.length === 1 && compiled.queries[head]) {
    return evalQuery(head, compiled, atoms, scope, componentName)
  }
  // 3. Atoms — try longest model.atom prefix first.
  const atomId = resolveAtomIdForRead(segs, compiled, componentName)
  if (atomId) {
    const consumed = atomId === compiled.models[componentName]?.atomIds[head] ? 1 : 2
    let v = atoms[atomId]
    for (let i = consumed; i < segs.length; i++) {
      if (v == null) return v
      v = (v as any)[segs[i]]
    }
    return v
  }
  return undefined
}

function resolveAtomIdForRead(
  segs: string[],
  compiled: CompileResult,
  componentName: string,
): string | null {
  if (segs.length === 0) return null
  // Component-local single-segment lookup.
  if (segs.length >= 1) {
    const local = compiled.models[componentName]?.atomIds[segs[0]]
    if (local) return local
  }
  if (segs.length >= 2) {
    const m = compiled.models[segs[0]]
    if (m && m.atomIds[segs[1]]) return m.atomIds[segs[1]]
  }
  return null
}

// Find the atom that an action's target path writes to.
function resolveAtomIdForWrite(
  segs: string[],
  compiled: CompileResult,
  componentName: string,
): string | null {
  return resolveAtomIdForRead(segs, compiled, componentName)
}

// Write to a path — prefer the scope's setField if the head matches a
// loop variable; otherwise resolve the corresponding atom and call
// setAtom. Used by bindings (checkbox/input/value) and the set/toggle
// action ops.
function writePath(
  segs: string[],
  value: any,
  compiled: CompileResult,
  scope: Scope,
  componentName: string,
  setAtom: AtomUpdater,
): void {
  if (segs.length === 2 && segs[0] in scope && scope[segs[0]].setField) {
    scope[segs[0]].setField!(segs[1], value)
    return
  }
  const id = resolveAtomIdForWrite(segs, compiled, componentName)
  if (id) setAtom(id, value)
}

// Resolve the underlying collection atom for a path that may be a
// query alias. Used by the for-loop to build a writeField that patches
// records in the source collection (not in the filtered view).
function resolveSourceCollectionAtom(
  path: string[],
  compiled: CompileResult,
  componentName: string,
): string | null {
  let p = path
  while (p.length === 1 && compiled.queries[p[0]]) {
    p = compiled.queries[p[0]].source
  }
  return resolveAtomIdForRead(p, compiled, componentName)
}

function evalValueExpr(
  expr: ValueExpr,
  compiled: CompileResult,
  atoms: AtomValues,
  scope: Scope,
  componentName: string,
): any {
  switch (expr.kind) {
    case 'literal':
      return literalToValue(expr.value)
    case 'path':
      return readPath(expr.segments, compiled, atoms, scope, componentName)
    case 'match':
      // Synchronous evaluation returns null; the action handler that
      // contains the match expression is responsible for scheduling
      // the async resolution.
      return null
  }
}

function evalQuery(
  name: string,
  compiled: CompileResult,
  atoms: AtomValues,
  scope: Scope,
  componentName: string,
): any[] {
  const q = compiled.queries[name]
  if (!q) return []
  const sourceVal = readPath(q.source, compiled, atoms, scope, componentName)
  if (!Array.isArray(sourceVal)) return []
  if (q.filters.length === 0) return sourceVal
  return sourceVal.filter((item) =>
    q.filters.every((f) => {
      const lhs = (item as any)?.[f.field]
      const rhs = evalValueExpr(f.value, compiled, atoms, scope, componentName)
      return lhs === rhs
    }),
  )
}

// ── Top-level view ───────────────────────────────────────────────────

export function RuntimeView({
  compiled,
  atoms,
  setAtom,
  selectedElementId,
  onSelectElement,
  onCognitionError,
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
  const rootCompNode = compiled.graph.nodes.find((n) => n.id === compiled.rootComponentId)
  const componentName = rootCompNode?.label ?? ''
  return (
    <ElementView
      compiled={compiled}
      atoms={atoms}
      setAtom={setAtom}
      element={rootEl}
      componentName={componentName}
      scope={{}}
      selectedElementId={selectedElementId ?? null}
      onSelectElement={onSelectElement}
      onCognitionError={onCognitionError}
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

function bindingsOf(
  compiled: CompileResult,
  elId: string,
): { prop: string; target: string[] }[] {
  const out: { prop: string; target: string[] }[] = []
  const bindingEdges = compiled.graph.edges.filter(
    (e) => e.source === elId && e.type === 'BINDS',
  )
  for (const be of bindingEdges) {
    const bNode = compiled.graph.nodes.find((n) => n.id === be.target)
    if (!bNode) continue
    out.push({
      prop: bNode.data?.prop ?? '',
      target: (bNode.data?.target as string[]) ?? [],
    })
  }
  return out
}

interface CompiledAction {
  op: 'toggle' | 'set' | 'clear' | 'add'
  target: string[]
  value?: ValueExpr
  fields?: { name: string; value: ValueExpr }[]
}

function eventsOf(
  compiled: CompileResult,
  elId: string,
): { event: string; actions: CompiledAction[] }[] {
  const evs = compiled.graph.edges
    .filter((e) => e.source === elId && e.type === 'HAS_EVENT')
    .map((e) => compiled.graph.nodes.find((n) => n.id === e.target))
    .filter((n): n is EctoNode => !!n)
  return evs.map((evNode) => {
    const acts = compiled.graph.edges
      .filter((e) => e.source === evNode.id && e.type === 'TRIGGERS')
      .map((e) => compiled.graph.nodes.find((n) => n.id === e.target))
      .filter((n): n is EctoNode => !!n)
      .filter((n) => n.type === 'Action')
      .map(
        (a): CompiledAction => ({
          op: a.data?.op,
          target: (a.data?.target as string[]) ?? [],
          value: a.data?.value,
          fields: a.data?.fields,
        }),
      )
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

function attrString(element: EctoNode, key: string): string | undefined {
  const lit = element.data?.attrs?.[key] as Literal | undefined
  if (!lit) return undefined
  if (lit.kind === 'string') return lit.value
  const v = literalToValue(lit)
  return v == null ? undefined : String(v)
}

// ── Visibility ───────────────────────────────────────────────────────

function isVisible(
  element: EctoNode,
  compiled: CompileResult,
  atoms: AtomValues,
  scope: Scope,
  componentName: string,
): boolean {
  const w = element.data?.when as
    | { op: 'truthy'; path: string[] }
    | { op: 'equals'; path: string[]; literal: Literal }
    | undefined
  if (!w) return true
  const value = readPath(w.path, compiled, atoms, scope, componentName)
  if (w.op === 'truthy') return Boolean(value)
  return value === literalToValue(w.literal)
}

// ── Actions ──────────────────────────────────────────────────────────

function runActions(
  actions: CompiledAction[],
  compiled: CompileResult,
  atoms: AtomValues,
  setAtom: AtomUpdater,
  scope: Scope,
  componentName: string,
  onCognitionError?: (message: string) => void,
): void {
  for (const a of actions) {
    if (a.op === 'toggle') {
      // Scope writeback first — `toggle task.expanded`.
      if (a.target.length === 2 && a.target[0] in scope && scope[a.target[0]].setField) {
        const cur = scope[a.target[0]].value?.[a.target[1]]
        scope[a.target[0]].setField!(a.target[1], !cur)
        continue
      }
      const id = resolveAtomIdForWrite(a.target, compiled, componentName)
      if (!id) continue
      setAtom(id, (cur: any) => !cur)
    } else if (a.op === 'set') {
      if (!a.value) continue
      const v = evalValueExpr(a.value, compiled, atoms, scope, componentName)
      writePath(a.target, v, compiled, scope, componentName, setAtom)
      if (a.value.kind === 'match') {
        runMatch(a.value, compiled, atoms, scope, componentName, (resolvedId) => {
          writePath(a.target, resolvedId, compiled, scope, componentName, setAtom)
        }, onCognitionError)
      }
    } else if (a.op === 'clear') {
      const id = resolveAtomIdForWrite(a.target, compiled, componentName)
      if (!id) continue
      const cur = atoms[id]
      let empty: any = ''
      if (Array.isArray(cur)) empty = []
      else if (typeof cur === 'number') empty = 0
      else if (typeof cur === 'boolean') empty = false
      else if (cur === null || cur === undefined) empty = null
      setAtom(id, empty)
    } else if (a.op === 'add') {
      const id = resolveAtomIdForWrite(a.target, compiled, componentName)
      if (!id) continue
      const recordId = newId()
      const record: Record<string, any> = { id: recordId }
      const pending: { field: string; expr: Extract<ValueExpr, { kind: 'match' }> }[] = []
      for (const f of a.fields ?? []) {
        if (f.value.kind === 'match') {
          record[f.name] = null
          pending.push({ field: f.name, expr: f.value })
        } else {
          record[f.name] = evalValueExpr(f.value, compiled, atoms, scope, componentName)
        }
      }
      setAtom(id, (cur: any) => (Array.isArray(cur) ? [...cur, record] : [record]))
      // Kick off any inline `match` expressions; patch the just-added
      // record by id when each resolves.
      for (const pm of pending) {
        runMatch(
          pm.expr,
          compiled,
          atoms,
          scope,
          componentName,
          (resolvedId) => {
            setAtom(id, (cur: any) =>
              Array.isArray(cur)
                ? cur.map((r) =>
                    r && r.id === recordId ? { ...r, [pm.field]: resolvedId } : r,
                  )
                : cur,
            )
          },
          onCognitionError,
        )
      }
    }
  }
}

function runMatch(
  expr: Extract<ValueExpr, { kind: 'match' }>,
  compiled: CompileResult,
  atoms: AtomValues,
  scope: Scope,
  componentName: string,
  onResolved: (id: string | null) => void,
  onCognitionError?: (message: string) => void,
): void {
  const input = readPath(expr.input, compiled, atoms, scope, componentName)
  const candidates = readPath(expr.collection, compiled, atoms, scope, componentName)
  if (typeof input !== 'string' || !Array.isArray(candidates) || candidates.length === 0) {
    onResolved(null)
    return
  }
  void fetch(`${SERVER_URL}/api/cognition/match`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input, candidates, field: expr.field }),
  })
    .then(async (res) => {
      if (!res.ok) {
        const body = await res.text()
        onCognitionError?.(`match failed: ${res.status} ${body}`)
        onResolved(null)
        return
      }
      const data = (await res.json()) as { id: string | null }
      onResolved(data.id ?? null)
    })
    .catch((err) => {
      onCognitionError?.(`match failed: ${err instanceof Error ? err.message : String(err)}`)
      onResolved(null)
    })
}

function newId(): string {
  return 'r_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)
}

// ── Element rendering ────────────────────────────────────────────────

interface EVProps {
  compiled: CompileResult
  atoms: AtomValues
  setAtom: AtomUpdater
  element: EctoNode
  componentName: string
  scope: Scope
  selectedElementId: string | null
  onSelectElement?: (id: string | null) => void
  onCognitionError?: (message: string) => void
}

function ElementView({
  compiled,
  atoms,
  setAtom,
  element,
  componentName,
  scope,
  selectedElementId,
  onSelectElement,
  onCognitionError,
}: EVProps) {
  // visibility
  if (!isVisible(element, compiled, atoms, scope, componentName)) return null

  // Custom-component references — render the named component's
  // render tree in place, switching the atom scope to that component.
  const ename0 = element.label
  if (compiled.components[ename0]) {
    const compId = compiled.components[ename0]
    const subRoot = childElementOf(compiled, compId)
    if (!subRoot) return null
    return (
      <ElementView
        compiled={compiled}
        atoms={atoms}
        setAtom={setAtom}
        element={subRoot}
        componentName={ename0}
        scope={scope}
        selectedElementId={selectedElementId}
        onSelectElement={onSelectElement}
        onCognitionError={onCognitionError}
      />
    )
  }

  // Loop elements iterate a source collection or query.
  if (element.data?.name === 'for' || element.type === 'Loop') {
    const loopVar = element.data?.loopVar as string | undefined
    const loopSource = element.data?.loopSource as string[] | undefined
    if (!loopVar || !loopSource) return null
    const source = readPath(loopSource, compiled, atoms, scope, componentName)
    const items = Array.isArray(source) ? source : []
    const collectionAtomId = resolveSourceCollectionAtom(
      loopSource,
      compiled,
      componentName,
    )
    const childNodes = childrenOf(compiled, element.id).filter(
      (n) => n.type === 'Element' || n.type === 'Loop',
    )
    return (
      <>
        {items.map((item, idx) => {
          const recordId = item && (item.id as string)
          const setField = collectionAtomId && recordId
            ? (field: string, value: any) => {
                setAtom(collectionAtomId, (cur: any) =>
                  Array.isArray(cur)
                    ? cur.map((r) =>
                        r && r.id === recordId ? { ...r, [field]: value } : r,
                      )
                    : cur,
                )
              }
            : undefined
          const itemScope: Scope = {
            ...scope,
            [loopVar]: { value: item, setField },
          }
          const key = recordId ?? String(idx)
          return (
            <React.Fragment key={key}>
              {childNodes.map((c) => (
                <ElementView
                  key={c.id + ':' + key}
                  compiled={compiled}
                  atoms={atoms}
                  setAtom={setAtom}
                  element={c}
                  componentName={componentName}
                  scope={itemScope}
                  selectedElementId={selectedElementId}
                  onSelectElement={onSelectElement}
                  onCognitionError={onCognitionError}
                />
              ))}
            </React.Fragment>
          )
        })}
      </>
    )
  }

  // styles
  const styleNames = elementStylesByName(compiled, element.id)
  const ctx = { compiled, atomValues: atoms }
  let mergedStyle: React.CSSProperties = {}
  for (const sn of styleNames) {
    Object.assign(mergedStyle, resolveStyleByName(sn, ctx))
  }

  // bindings — figure out which prop maps to which target path
  const binds = bindingsOf(compiled, element.id)
  const checkedBinding = binds.find((b) => b.prop === 'checked')
  const textBinding = binds.find((b) => b.prop === 'text')
  const valueBinding = binds.find((b) => b.prop === 'value')

  // events
  const evs = eventsOf(compiled, element.id)
  const handlers: Record<string, React.EventHandler<any>> = {}
  for (const ev of evs) {
    const reactEvent = REACT_EVENT_MAP[ev.event] ?? `on${capitalize(ev.event)}`
    handlers[reactEvent] = (e: any) => {
      e.stopPropagation?.()
      runActions(
        ev.actions,
        compiled,
        atoms,
        setAtom,
        scope,
        componentName,
        onCognitionError,
      )
    }
  }

  // traits
  const traits = traitsOf(compiled, element.id)
  const isEditable = traits.includes('editable')

  // children
  const childNodes = childrenOf(compiled, element.id).filter(
    (n) => n.type === 'Element' || n.type === 'Loop',
  )

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

  // ── checkbox ────────────────────────────────────────────────────
  if (ename === 'checkbox') {
    const checkedVal = checkedBinding
      ? !!readPath(checkedBinding.target, compiled, atoms, scope, componentName)
      : false
    return (
      <label
        style={{ display: 'flex', alignItems: 'center', gap: 8, ...commonProps.style }}
        onMouseDown={onMouseDown}
      >
        <input
          type="checkbox"
          checked={checkedVal}
          onChange={(e) => {
            if (!checkedBinding) return
            writePath(
              checkedBinding.target,
              e.target.checked,
              compiled,
              scope,
              componentName,
              setAtom,
            )
          }}
          onClick={(e) => e.stopPropagation()}
          style={{ width: 18, height: 18, accentColor: '#2563eb' }}
        />
      </label>
    )
  }

  // ── input ───────────────────────────────────────────────────────
  if (ename === 'input') {
    const value = valueBinding
      ? String(readPath(valueBinding.target, compiled, atoms, scope, componentName) ?? '')
      : ''
    const placeholder = attrString(element, 'placeholder') ?? ''
    const submitEvent = evs.find((e) => e.event === 'submit')
    return (
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          if (!valueBinding) return
          writePath(
            valueBinding.target,
            e.target.value,
            compiled,
            scope,
            componentName,
            setAtom,
          )
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && submitEvent) {
            e.preventDefault()
            runActions(
              submitEvent.actions,
              compiled,
              atoms,
              setAtom,
              scope,
              componentName,
              onCognitionError,
            )
          }
        }}
        onMouseDown={onMouseDown}
        style={{
          ...commonProps.style,
          padding: '8px 12px',
          fontSize: 14,
          border: '1px solid rgba(148, 163, 184, 0.32)',
          borderRadius: 6,
          outline: 'none',
          background: 'inherit',
          color: 'inherit',
          font: 'inherit',
          flex: 1,
        }}
      />
    )
  }

  // ── button ──────────────────────────────────────────────────────
  if (ename === 'button') {
    const label = attrString(element, 'text') ?? ''
    const hasChildren = childNodes.length > 0
    return (
      <button
        {...commonProps}
        style={{
          ...commonProps.style,
          padding: '8px 14px',
          fontSize: 13,
          border: '1px solid rgba(148, 163, 184, 0.28)',
          borderRadius: 6,
          background: mergedStyle.background ?? 'rgba(37, 99, 235, 0.18)',
          color: mergedStyle.color ?? 'inherit',
          cursor: 'pointer',
          font: 'inherit',
          ...(mergedStyle as any),
        }}
      >
        {hasChildren
          ? childNodes.map((c) => (
              <ElementView
                key={c.id}
                compiled={compiled}
                atoms={atoms}
                setAtom={setAtom}
                element={c}
                componentName={componentName}
                scope={scope}
                selectedElementId={selectedElementId}
                onSelectElement={onSelectElement}
                onCognitionError={onCognitionError}
              />
            ))
          : label}
      </button>
    )
  }

  // ── text-binding leaves (task / description / text / label) ─────
  if (textBinding) {
    const raw = readPath(textBinding.target, compiled, atoms, scope, componentName)
    const text = String(raw ?? '')
    const directAtomId = resolveAtomIdForWrite(
      textBinding.target,
      compiled,
      componentName,
    )
    const scopeWritable =
      textBinding.target.length === 2 &&
      textBinding.target[0] in scope &&
      !!scope[textBinding.target[0]].setField
    if (isEditable && (directAtomId || scopeWritable)) {
      return (
        <EditableText
          value={text}
          onChange={(v) =>
            writePath(textBinding.target, v, compiled, scope, componentName, setAtom)
          }
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

  // ── static text attr (e.g. < text text: "Hello" >) ─────────────
  const staticText = attrString(element, 'text')
  if (staticText !== undefined && childNodes.length === 0) {
    return (
      <div {...commonProps}>
        <TextSpan variant={ename}>{staticText}</TextSpan>
      </div>
    )
  }

  // container / row / unknown — render children
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
          scope={scope}
          selectedElementId={selectedElementId}
          onSelectElement={onSelectElement}
          onCognitionError={onCognitionError}
        />
      ))}
      {childNodes.length === 0 && ename !== 'container' && ename !== 'row' ? (
        <TextSpan variant={ename}>{ename}</TextSpan>
      ) : null}
    </div>
  )
}

function TextSpan({ children, variant }: { children: React.ReactNode; variant: string }) {
  const sty: React.CSSProperties =
    variant === 'task' || variant === 'heading'
      ? { fontSize: 15, fontWeight: 600 }
      : variant === 'description' || variant === 'subheading'
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
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}
