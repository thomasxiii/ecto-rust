// Built-in mini-app templates. Available without the LLM — the New modal
// offers them as a starting point or instant-load option.
//
// Each template is a complete GraphPayload identical in shape to what the
// /api/mini/generate endpoint returns. The Rust runtime loads them with
// MiniRuntime.loadGraph.

import type { MiniGraphPayload } from './engine'

export interface MiniTemplate {
  id: string
  title: string
  description: string
  prompt: string
  payload: MiniGraphPayload
}

// ─── Shared styles ───────────────────────────────────────────────────────

const literal = (value: unknown) => ({ kind: 'literal', value })
const ref = (id: string) => ({ kind: 'ref', id })

const appRootStyles = {
  background: literal('#ffffff'),
  color: literal('#0f172a'),
  minHeight: literal('100vh'),
  display: literal('flex'),
  flexDirection: literal('column'),
  alignItems: literal('center'),
  justifyContent: literal('center'),
  gap: literal(16),
  padding: literal(32),
  fontFamily: literal('Inter, system-ui, sans-serif'),
}

const titleStyles = {
  fontSize: literal(24),
  fontWeight: literal(600),
  margin: literal(0),
  color: literal('#0f172a'),
}

const primaryButtonStyles = {
  background: literal('#2563eb'),
  color: literal('#ffffff'),
  border: literal('none'),
  borderRadius: literal(6),
  padding: literal('10px 18px'),
  fontSize: literal(14),
  fontWeight: literal(500),
  cursor: literal('pointer'),
  fontFamily: literal('Inter, system-ui, sans-serif'),
}

const inputStyles = {
  padding: literal('8px 12px'),
  border: literal('1px solid #e2e8f0'),
  borderRadius: literal(6),
  fontSize: literal(14),
  fontFamily: literal('Inter, system-ui, sans-serif'),
  width: literal(280),
  outline: literal('none'),
  background: literal('#ffffff'),
  color: literal('#0f172a'),
}

// ─── counter ─────────────────────────────────────────────────────────────

const counter: MiniGraphPayload = {
  root: 'App',
  nodes: [
    { id: 'App', name: 'App', type: 'component' },
    { id: 'appRoot', name: 'appRoot', type: 'element', tag: 'div' },
    {
      id: 'title',
      name: 'title',
      type: 'element',
      tag: 'h1',
      text: { kind: 'literal', value: 'Counter' },
    },
    {
      id: 'display',
      name: 'display',
      type: 'element',
      tag: 'div',
      text: { kind: 'ref', id: 'Count' },
    },
    {
      id: 'row',
      name: 'row',
      type: 'element',
      tag: 'div',
    },
    {
      id: 'decBtn',
      name: 'decBtn',
      type: 'element',
      tag: 'button',
      text: { kind: 'literal', value: '−1' },
    },
    {
      id: 'incBtn',
      name: 'incBtn',
      type: 'element',
      tag: 'button',
      text: { kind: 'literal', value: '+1' },
    },
    {
      id: 'resetBtn',
      name: 'resetBtn',
      type: 'element',
      tag: 'button',
      text: { kind: 'literal', value: 'Reset' },
    },
    { id: 'Count', name: 'Count', type: 'atom', value: 0 },
    {
      id: 'AppStyles',
      name: 'AppStyles',
      type: 'styleSheet',
      rules: {
        appRoot: appRootStyles,
        title: titleStyles,
        display: {
          fontSize: literal(64),
          fontWeight: literal(700),
          color: literal('#0f172a'),
          letterSpacing: literal('-0.02em'),
        },
        row: {
          display: literal('flex'),
          gap: literal(8),
          marginTop: literal(8),
        },
        incBtn: primaryButtonStyles,
        decBtn: {
          ...primaryButtonStyles,
          background: literal('#ffffff'),
          color: literal('#0f172a'),
          border: literal('1px solid #e2e8f0'),
        },
        resetBtn: {
          ...primaryButtonStyles,
          background: literal('#ffffff'),
          color: literal('#64748b'),
          border: literal('1px solid #e2e8f0'),
        },
      },
    },
    { id: 'IncClick', name: 'IncClick', type: 'cause', source: 'incBtn', event: 'click' },
    { id: 'DecClick', name: 'DecClick', type: 'cause', source: 'decBtn', event: 'click' },
    { id: 'ResetClick', name: 'ResetClick', type: 'cause', source: 'resetBtn', event: 'click' },
    { id: 'IncBy1', name: 'IncBy1', type: 'effect', op: 'incrementBy', amount: 1 },
    { id: 'DecBy1', name: 'DecBy1', type: 'effect', op: 'incrementBy', amount: -1 },
    { id: 'SetZero', name: 'SetZero', type: 'effect', op: 'setAtom', value: 0 },
  ],
  edges: [
    { from: 'App', to: 'appRoot', kind: 'renders' },
    { from: 'appRoot', to: 'title', kind: 'contains' },
    { from: 'appRoot', to: 'display', kind: 'contains' },
    { from: 'appRoot', to: 'row', kind: 'contains' },
    { from: 'row', to: 'decBtn', kind: 'contains' },
    { from: 'row', to: 'incBtn', kind: 'contains' },
    { from: 'appRoot', to: 'resetBtn', kind: 'contains' },
    { from: 'App', to: 'IncClick', kind: 'hasCause' },
    { from: 'App', to: 'DecClick', kind: 'hasCause' },
    { from: 'App', to: 'ResetClick', kind: 'hasCause' },
    { from: 'IncClick', to: 'IncBy1', kind: 'triggers' },
    { from: 'DecClick', to: 'DecBy1', kind: 'triggers' },
    { from: 'ResetClick', to: 'SetZero', kind: 'triggers' },
    { from: 'IncBy1', to: 'Count', kind: 'reads' },
    { from: 'IncBy1', to: 'Count', kind: 'writes' },
    { from: 'DecBy1', to: 'Count', kind: 'reads' },
    { from: 'DecBy1', to: 'Count', kind: 'writes' },
    { from: 'SetZero', to: 'Count', kind: 'writes' },
    { from: 'AppStyles', to: 'appRoot', kind: 'targets' },
    { from: 'AppStyles', to: 'title', kind: 'targets' },
    { from: 'AppStyles', to: 'display', kind: 'targets' },
    { from: 'AppStyles', to: 'row', kind: 'targets' },
    { from: 'AppStyles', to: 'decBtn', kind: 'targets' },
    { from: 'AppStyles', to: 'incBtn', kind: 'targets' },
    { from: 'AppStyles', to: 'resetBtn', kind: 'targets' },
  ],
}

// ─── greeter ─────────────────────────────────────────────────────────────

const greeter: MiniGraphPayload = {
  root: 'App',
  nodes: [
    { id: 'App', name: 'App', type: 'component' },
    { id: 'appRoot', name: 'appRoot', type: 'element', tag: 'div' },
    {
      id: 'title',
      name: 'title',
      type: 'element',
      tag: 'h1',
      text: { kind: 'literal', value: 'Greeter' },
    },
    {
      id: 'input',
      name: 'input',
      type: 'element',
      tag: 'input',
      text: { kind: 'ref', id: 'Name' },
      attrs: { placeholder: 'Your name', type: 'text' },
    },
    {
      id: 'greeting',
      name: 'greeting',
      type: 'element',
      tag: 'p',
      text: { kind: 'ref', id: 'Greeting' },
    },
    { id: 'Name', name: 'Name', type: 'atom', value: '' },
    {
      id: 'Greeting',
      name: 'Greeting',
      type: 'derived',
      op: 'formatTemplate',
      template: 'Hello, {}!',
    },
    {
      id: 'AppStyles',
      name: 'AppStyles',
      type: 'styleSheet',
      rules: {
        appRoot: appRootStyles,
        title: titleStyles,
        input: inputStyles,
        greeting: {
          fontSize: literal(20),
          fontWeight: literal(500),
          color: literal('#0f172a'),
          margin: literal(0),
        },
      },
    },
    { id: 'InputChange', name: 'InputChange', type: 'cause', source: 'input', event: 'change' },
    { id: 'WriteName', name: 'WriteName', type: 'effect', op: 'setAtomFromInput' },
  ],
  edges: [
    { from: 'App', to: 'appRoot', kind: 'renders' },
    { from: 'appRoot', to: 'title', kind: 'contains' },
    { from: 'appRoot', to: 'input', kind: 'contains' },
    { from: 'appRoot', to: 'greeting', kind: 'contains' },
    { from: 'Greeting', to: 'Name', kind: 'reads' },
    { from: 'App', to: 'InputChange', kind: 'hasCause' },
    { from: 'InputChange', to: 'WriteName', kind: 'triggers' },
    { from: 'WriteName', to: 'Name', kind: 'writes' },
    { from: 'AppStyles', to: 'appRoot', kind: 'targets' },
    { from: 'AppStyles', to: 'title', kind: 'targets' },
    { from: 'AppStyles', to: 'input', kind: 'targets' },
    { from: 'AppStyles', to: 'greeting', kind: 'targets' },
  ],
}

// ─── todo (small) ────────────────────────────────────────────────────────

const todo: MiniGraphPayload = {
  root: 'App',
  nodes: [
    { id: 'App', name: 'App', type: 'component' },
    { id: 'appRoot', name: 'appRoot', type: 'element', tag: 'div' },
    {
      id: 'title',
      name: 'title',
      type: 'element',
      tag: 'h1',
      text: { kind: 'literal', value: 'Tasks' },
    },
    { id: 'row', name: 'row', type: 'element', tag: 'div' },
    {
      id: 'input',
      name: 'input',
      type: 'element',
      tag: 'input',
      text: { kind: 'ref', id: 'Draft' },
      attrs: { placeholder: 'What needs doing?', type: 'text' },
    },
    {
      id: 'addBtn',
      name: 'addBtn',
      type: 'element',
      tag: 'button',
      text: { kind: 'literal', value: 'Add' },
    },
    {
      id: 'count',
      name: 'count',
      type: 'element',
      tag: 'div',
      text: { kind: 'ref', id: 'CountLabel' },
    },
    { id: 'taskList', name: 'taskList', type: 'element', tag: 'ul' },
    {
      id: 'taskItem',
      name: 'taskItem',
      type: 'element',
      tag: 'li',
      text: { kind: 'itemValue' },
    },
    {
      id: 'taskRepeat',
      name: 'taskRepeat',
      type: 'repeat',
      source: 'Tasks',
      template: 'taskItem',
    },
    { id: 'Draft', name: 'Draft', type: 'atom', value: '' },
    { id: 'Tasks', name: 'Tasks', type: 'atom', value: [] },
    { id: 'Total', name: 'Total', type: 'derived', op: 'count' },
    {
      id: 'CountLabel',
      name: 'CountLabel',
      type: 'derived',
      op: 'formatTemplate',
      template: '{} items',
    },
    {
      id: 'AppStyles',
      name: 'AppStyles',
      type: 'styleSheet',
      rules: {
        appRoot: { ...appRootStyles, justifyContent: literal('flex-start'), paddingTop: literal(64) },
        title: titleStyles,
        row: { display: literal('flex'), gap: literal(8), alignItems: literal('center') },
        input: { ...inputStyles, width: literal(320) },
        addBtn: primaryButtonStyles,
        count: { color: literal('#64748b'), fontSize: literal(13) },
        taskList: {
          listStyle: literal('none'),
          padding: literal(0),
          margin: literal(0),
          display: literal('flex'),
          flexDirection: literal('column'),
          gap: literal(6),
          minWidth: literal(360),
          marginTop: literal(8),
        },
        taskItem: {
          padding: literal('10px 14px'),
          background: literal('#f8fafc'),
          border: literal('1px solid #e2e8f0'),
          borderRadius: literal(6),
          fontSize: literal(14),
          color: literal('#0f172a'),
        },
      },
    },
    { id: 'InputChange', name: 'InputChange', type: 'cause', source: 'input', event: 'change' },
    { id: 'AddClick', name: 'AddClick', type: 'cause', source: 'addBtn', event: 'click' },
    { id: 'WriteDraft', name: 'WriteDraft', type: 'effect', op: 'setAtomFromInput' },
    { id: 'AppendTask', name: 'AppendTask', type: 'effect', op: 'appendReadToList' },
    { id: 'ClearDraft', name: 'ClearDraft', type: 'effect', op: 'setAtom', value: '' },
  ],
  edges: [
    { from: 'App', to: 'appRoot', kind: 'renders' },
    { from: 'appRoot', to: 'title', kind: 'contains' },
    { from: 'appRoot', to: 'row', kind: 'contains' },
    { from: 'row', to: 'input', kind: 'contains' },
    { from: 'row', to: 'addBtn', kind: 'contains' },
    { from: 'appRoot', to: 'count', kind: 'contains' },
    { from: 'appRoot', to: 'taskList', kind: 'contains' },
    { from: 'taskList', to: 'taskRepeat', kind: 'contains' },
    { from: 'Total', to: 'Tasks', kind: 'reads' },
    { from: 'CountLabel', to: 'Total', kind: 'reads' },
    { from: 'App', to: 'InputChange', kind: 'hasCause' },
    { from: 'App', to: 'AddClick', kind: 'hasCause' },
    { from: 'InputChange', to: 'WriteDraft', kind: 'triggers' },
    { from: 'WriteDraft', to: 'Draft', kind: 'writes' },
    { from: 'AddClick', to: 'AppendTask', kind: 'triggers' },
    { from: 'AddClick', to: 'ClearDraft', kind: 'triggers' },
    { from: 'AppendTask', to: 'Draft', kind: 'reads' },
    { from: 'AppendTask', to: 'Tasks', kind: 'writes' },
    { from: 'ClearDraft', to: 'Draft', kind: 'writes' },
    { from: 'AppStyles', to: 'appRoot', kind: 'targets' },
    { from: 'AppStyles', to: 'title', kind: 'targets' },
    { from: 'AppStyles', to: 'row', kind: 'targets' },
    { from: 'AppStyles', to: 'input', kind: 'targets' },
    { from: 'AppStyles', to: 'addBtn', kind: 'targets' },
    { from: 'AppStyles', to: 'count', kind: 'targets' },
    { from: 'AppStyles', to: 'taskList', kind: 'targets' },
    { from: 'AppStyles', to: 'taskItem', kind: 'targets' },
  ],
}

export const TEMPLATES: MiniTemplate[] = [
  {
    id: 'counter',
    title: 'Counter',
    description: 'Increment / decrement / reset a number.',
    prompt: 'A counter with +1, −1, and reset buttons. Shows the current count large.',
    payload: counter,
  },
  {
    id: 'greeter',
    title: 'Greeter',
    description: 'Live-greet whatever the user types.',
    prompt: 'A name input that greets the user with "Hello, {name}!" as they type.',
    payload: greeter,
  },
  {
    id: 'todo',
    title: 'Todo list (simple)',
    description: 'Add items to a list; shows count.',
    prompt: 'A simple todo list. Input + Add button. Show the total count of items below.',
    payload: todo,
  },
]
