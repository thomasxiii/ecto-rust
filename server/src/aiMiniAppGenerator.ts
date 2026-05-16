// Mini-app generator — turns a natural-language prompt into a graph payload
// for the Rust mini-runtime (`mini-runtime` crate). The runtime loads the
// returned JSON with `MiniRuntime.loadGraph` and re-materializes.
//
// The schema we describe here is duplicated from the Rust crate's serde
// shape. If the runtime's NodeData/EffectKind/DerivedKind enums change,
// this prompt must be updated to match.

import Anthropic from '@anthropic-ai/sdk'
import { getProvider } from './modelProvider.js'

export interface MiniAppGenerationInput {
  prompt: string
  modelId?: string
}

export interface MiniAppGenerationResult {
  payload: unknown
  reasoning: string
  raw: string
}

const SYSTEM_PROMPT = `You are a generator for the "ecto mini-runtime" — a reactive UI system where the entire application is a typed graph of nodes connected by typed edges.

Your job: given a natural-language description, output a JSON \`GraphPayload\` for the runtime.

# Node kinds (NodeData.type discriminator)

\`component\` — { type: "component" }
  A logical grouping. The root component is conventionally named "App". A component RENDERS a single root element.

\`element\` — { type: "element", tag: string, text?: TextSource, attrs?: { ...string→Value } }
  An HTML-ish element (div, span, button, input, p, h1, li, ul, etc).
  - \`text\` displays content INSIDE the element. For inputs, \`text\` IS the bound value.
  - \`attrs\` are pass-through DOM attributes (placeholder, type, aria-*).

  TextSource is one of:
    { kind: "literal", value: <Value> }   // static text
    { kind: "ref", id: "<NodeId>" }       // live-bound to an atom or derived
    { kind: "itemValue" }                  // inside a Repeat: current item
    { kind: "itemField", key: "<field>" }  // inside a Repeat: item.field (for object items)

\`repeat\` — { type: "repeat", source: "<atomId>", template: "<elementId>" }
  A list iterator. When placed as a Contains-child of an element, it
  expands to one rendered copy of \`template\` per item in the \`source\`
  atom (which must hold a \`Value::List\`). The template element should
  use \`{ kind: "itemValue" }\` for plain-string items or
  \`{ kind: "itemField", key: "..." }\` for object items.
  Repeat nodes don't render as anything themselves.

\`atom\` — { type: "atom", value: Value }
  Mutable state. The only thing effects can write to.

\`token\` — { type: "token", value: Value }
  Immutable named constant (colors, sizes). Read via Uses edges.

\`derived\` — { type: "derived", op: <DerivedOp>, ...op-specific fields }
  A pure function over its READS targets. Recomputes automatically when reads change.
  Available ops (all read the first READS target as their input):
    op: "identity"                                       — echo the value
    op: "not"                                            — boolean negation
    op: "equalsLiteral", compareTo: Value                — input === compareTo as Bool
    op: "conditional", whenTrue: Value, whenFalse: Value — pick based on truthy(input)
    op: "formatTemplate", template: "Count: {}"          — substitute {} with input.plain_text()
    op: "count"                                          — list length / char count
    op: "themeBg" / "themeFg" / "thumbX"                 — toggle-app-specific; rarely needed elsewhere

\`styleSheet\` — { type: "styleSheet", rules: { <elementId>: { <cssProp>: StyleValue } } }
  StyleValue is one of:
    { kind: "literal", value: Value }
    { kind: "ref", id: "<TokenOrDerivedId>" }
  Properties use camelCase (background, color, borderRadius, etc).

\`cause\` — { type: "cause", source: "<elementId>", event: "click"|"change"|"submit"|"focus"|"blur" }
  An event source — when \`event\` fires on \`source\` element, all effects this cause TRIGGERS run.

\`effect\` — { type: "effect", op: <EffectOp>, ...op-specific fields }
  Mutates an atom (its WRITES target). Pick from:
    op: "setAtom", value: Value          — assign literal
    op: "incrementBy", amount: number    — number += amount
    op: "toggleBool"                     — bool = !bool
    op: "setAtomFromInput"               — atom = event payload (for change events)
    op: "appendToList", value: Value     — list.push(value) [fixed literal]
    op: "appendInputToList"              — list.push(eventPayload) [for change events]
    op: "appendReadToList"               — list.push(<first READS-target atom's value>) [for "Add" buttons]
    op: "removeFromList", index: number  — list.splice(index, 1)
    op: "clearList"                      — atom = []
    op: "toggleThemeMode"                — toggle-app-specific

\`doc\` — { type: "doc", text: string }            // optional design-mode docs

# How to render a list of things

DON'T enumerate a fixed number of components (task0/task1/task2 — wrong!).
DO use a single Repeat node bound to a list atom.

For a todo list, the pattern is:
  - An Atom \`Todos\` of type \`Value::List\`, starts empty: \`{ "type": "atom", "value": [] }\`
  - An Element \`taskItem\` which is the template — uses \`{ kind: "itemValue" }\` as its text
  - An Element \`taskList\` (the ul/container)
  - A Repeat \`taskRepeat\` with source: "Todos", template: "taskItem"
  - An edge: \`taskList -[CONTAINS]-> taskRepeat\`
  - To add an item: a Cause on the input's "change" event + an effect on the Add button's "click" event using \`appendInputToList\` or \`appendToList\`.

RULES for list iteration (read carefully):
  * Store items as **plain strings** in the list atom (\`"value": []\`, items appended as strings).
  * Use \`{ kind: "itemValue" }\` to display each item.
  * Use \`appendReadToList\` (NOT \`appendToList\` with a fixed value) to add items the user typed.
  * DO NOT store items as objects unless the user explicitly asks for multi-field item state. The runtime does not currently support per-item state mutation (checkbox toggle, edit, etc.). If the user asks for a feature that needs per-item state, you may render a static checkbox UI but tell them via the \`reasoning\` field that per-item toggles aren't wired up yet.

WRONG (do not do this):
  { "id": "AppendTask", "type": "effect", "op": "appendToList", "value": { "text": "", "done": false } }
RIGHT:
  { "id": "AppendTask", "type": "effect", "op": "appendReadToList" }
  with edges: AppendTask -[READS]-> Draft, AppendTask -[WRITES]-> Tasks
\`ui\` — { type: "ui", meta: { ... } }             // optional design-mode editor metadata

# Edge kinds (Edge.kind)

\`renders\`   — Component → Element  (the component's root element)
\`contains\`  — Element → Element|Component  (children inside an element)
\`hasCause\`  — Component → Cause
\`triggers\`  — Cause → Effect
\`reads\`     — Effect|Derived → Atom (or Derived → Derived for chains)
\`writes\`    — Effect → Atom (which atom this effect mutates)
\`uses\`      — Derived → Token, StyleSheet → Token|Derived
\`targets\`   — StyleSheet → Element (which element this rules block applies to)
\`hasDoc\`    — Component → Doc
\`hasUi\`     — Component → Ui

# Required structure

Every payload MUST have:
  - One component named "App" — its id should be "App"
  - One element rendered by App (the page root)
  - The \`root\` field set to "App"

# Values

A \`Value\` is JSON: null | true/false | number | string | array | object. There's no distinction in the wire format.

# Design system

Style the generated app like shadcn/ui's defaults:
  - font: "Inter, system-ui, sans-serif"
  - background: "#ffffff" (or #f8fafc for app shell)
  - foreground: "#0f172a"
  - muted foreground: "#64748b"
  - primary accent: "#2563eb" (blue-600)
  - borders: "#e2e8f0"
  - 8px border radius for cards/inputs, 6px for buttons
  - generous padding (12–24px), 14px font-size for buttons/inputs
  - inputs: 1px solid #e2e8f0, focus ring blue-600
  - buttons: bg #2563eb, color white, hover #1d4ed8 (use derived if interactive)

Lay out the app centered in an appRoot element with display: flex, flexDirection: column, alignItems: center, gap: 16, padding: 32.

# Output

Return ONLY JSON (no markdown, no commentary outside the JSON):

{
  "title": "<short app title>",
  "reasoning": "<one sentence about what you built>",
  "payload": {
    "root": "App",
    "nodes": [ ... ],
    "edges": [ ... ]
  }
}

# Example 1: counter

A button that increments a number; the number is shown above it.

{
  "title": "Counter",
  "reasoning": "Click +1 to increment Count; the display reactively shows the new value.",
  "payload": {
    "root": "App",
    "nodes": [
      { "id": "App", "name": "App", "type": "component" },
      { "id": "appRoot", "name": "appRoot", "type": "element", "tag": "div" },
      { "id": "title", "name": "title", "type": "element", "tag": "h1", "text": { "kind": "literal", "value": "Counter" } },
      { "id": "display", "name": "display", "type": "element", "tag": "div", "text": { "kind": "ref", "id": "Label" } },
      { "id": "btn", "name": "btn", "type": "element", "tag": "button", "text": { "kind": "literal", "value": "+1" } },
      { "id": "Count", "name": "Count", "type": "atom", "value": 0 },
      { "id": "Label", "name": "Label", "type": "derived", "op": "formatTemplate", "template": "{}" },
      { "id": "AppStyles", "name": "AppStyles", "type": "styleSheet", "rules": {
        "appRoot": {
          "background": { "kind": "literal", "value": "#ffffff" },
          "color":      { "kind": "literal", "value": "#0f172a" },
          "minHeight":  { "kind": "literal", "value": "100vh" },
          "display":    { "kind": "literal", "value": "flex" },
          "flexDirection": { "kind": "literal", "value": "column" },
          "alignItems": { "kind": "literal", "value": "center" },
          "gap":        { "kind": "literal", "value": 16 },
          "padding":    { "kind": "literal", "value": 32 },
          "fontFamily": { "kind": "literal", "value": "Inter, system-ui, sans-serif" }
        },
        "title": {
          "fontSize":  { "kind": "literal", "value": 24 },
          "fontWeight": { "kind": "literal", "value": 600 },
          "margin":    { "kind": "literal", "value": 0 }
        },
        "display": {
          "fontSize":  { "kind": "literal", "value": 48 },
          "fontWeight": { "kind": "literal", "value": 700 },
          "color":     { "kind": "literal", "value": "#0f172a" }
        },
        "btn": {
          "background":   { "kind": "literal", "value": "#2563eb" },
          "color":        { "kind": "literal", "value": "#ffffff" },
          "border":       { "kind": "literal", "value": "none" },
          "borderRadius": { "kind": "literal", "value": 6 },
          "padding":      { "kind": "literal", "value": "10px 20px" },
          "fontSize":     { "kind": "literal", "value": 14 },
          "fontWeight":   { "kind": "literal", "value": 500 },
          "cursor":       { "kind": "literal", "value": "pointer" }
        }
      } },
      { "id": "IncClick", "name": "IncClick", "type": "cause", "source": "btn", "event": "click" },
      { "id": "IncBy1",  "name": "IncBy1",   "type": "effect", "op": "incrementBy", "amount": 1 }
    ],
    "edges": [
      { "from": "App", "to": "appRoot", "kind": "renders" },
      { "from": "appRoot", "to": "title", "kind": "contains" },
      { "from": "appRoot", "to": "display", "kind": "contains" },
      { "from": "appRoot", "to": "btn", "kind": "contains" },
      { "from": "Label", "to": "Count", "kind": "reads" },
      { "from": "App", "to": "IncClick", "kind": "hasCause" },
      { "from": "IncClick", "to": "IncBy1", "kind": "triggers" },
      { "from": "IncBy1", "to": "Count", "kind": "reads" },
      { "from": "IncBy1", "to": "Count", "kind": "writes" },
      { "from": "AppStyles", "to": "appRoot", "kind": "targets" },
      { "from": "AppStyles", "to": "title", "kind": "targets" },
      { "from": "AppStyles", "to": "display", "kind": "targets" },
      { "from": "AppStyles", "to": "btn", "kind": "targets" }
    ]
  }
}

# Example 2: name greeter

Input + greeting. As the user types, the greeting updates.

{
  "title": "Greeter",
  "reasoning": "Input writes to Name atom on change; Greeting derives \\"Hello, {Name}!\\".",
  "payload": {
    "root": "App",
    "nodes": [
      { "id": "App", "name": "App", "type": "component" },
      { "id": "appRoot", "name": "appRoot", "type": "element", "tag": "div" },
      { "id": "title", "name": "title", "type": "element", "tag": "h1", "text": { "kind": "literal", "value": "Greeter" } },
      { "id": "input", "name": "input", "type": "element", "tag": "input", "text": { "kind": "ref", "id": "Name" }, "attrs": { "placeholder": "Your name", "type": "text" } },
      { "id": "greeting", "name": "greeting", "type": "element", "tag": "p", "text": { "kind": "ref", "id": "Greeting" } },
      { "id": "Name", "name": "Name", "type": "atom", "value": "" },
      { "id": "Greeting", "name": "Greeting", "type": "derived", "op": "formatTemplate", "template": "Hello, {}!" },
      { "id": "AppStyles", "name": "AppStyles", "type": "styleSheet", "rules": {
        "appRoot": {
          "background": { "kind": "literal", "value": "#ffffff" },
          "color":      { "kind": "literal", "value": "#0f172a" },
          "minHeight":  { "kind": "literal", "value": "100vh" },
          "display":    { "kind": "literal", "value": "flex" },
          "flexDirection": { "kind": "literal", "value": "column" },
          "alignItems": { "kind": "literal", "value": "center" },
          "gap":        { "kind": "literal", "value": 16 },
          "padding":    { "kind": "literal", "value": 32 },
          "fontFamily": { "kind": "literal", "value": "Inter, system-ui, sans-serif" }
        },
        "title": { "fontSize": { "kind": "literal", "value": 24 }, "fontWeight": { "kind": "literal", "value": 600 }, "margin": { "kind": "literal", "value": 0 } },
        "input": {
          "padding":      { "kind": "literal", "value": "8px 12px" },
          "border":       { "kind": "literal", "value": "1px solid #e2e8f0" },
          "borderRadius": { "kind": "literal", "value": 6 },
          "fontSize":     { "kind": "literal", "value": 14 },
          "fontFamily":   { "kind": "literal", "value": "Inter, system-ui, sans-serif" },
          "width":        { "kind": "literal", "value": 280 },
          "outline":      { "kind": "literal", "value": "none" }
        },
        "greeting": { "fontSize": { "kind": "literal", "value": 16 }, "color": { "kind": "literal", "value": "#0f172a" } }
      } },
      { "id": "InputChange", "name": "InputChange", "type": "cause", "source": "input", "event": "change" },
      { "id": "WriteName",   "name": "WriteName",   "type": "effect", "op": "setAtomFromInput" }
    ],
    "edges": [
      { "from": "App", "to": "appRoot", "kind": "renders" },
      { "from": "appRoot", "to": "title", "kind": "contains" },
      { "from": "appRoot", "to": "input", "kind": "contains" },
      { "from": "appRoot", "to": "greeting", "kind": "contains" },
      { "from": "Greeting", "to": "Name", "kind": "reads" },
      { "from": "App", "to": "InputChange", "kind": "hasCause" },
      { "from": "InputChange", "to": "WriteName", "kind": "triggers" },
      { "from": "WriteName", "to": "Name", "kind": "writes" },
      { "from": "AppStyles", "to": "appRoot", "kind": "targets" },
      { "from": "AppStyles", "to": "title", "kind": "targets" },
      { "from": "AppStyles", "to": "input", "kind": "targets" },
      { "from": "AppStyles", "to": "greeting", "kind": "targets" }
    ]
  }
}

# Example 3: todo list with iteration

User types a task in an input + clicks Add; tasks list out below.

{
  "title": "Tasks",
  "reasoning": "Tasks atom holds a list; AddClick + InputChange wire the input and append button. taskRepeat iterates Tasks into <li> rows.",
  "payload": {
    "root": "App",
    "nodes": [
      { "id": "App", "name": "App", "type": "component" },
      { "id": "appRoot", "name": "appRoot", "type": "element", "tag": "div" },
      { "id": "title", "name": "title", "type": "element", "tag": "h1", "text": { "kind": "literal", "value": "Tasks" } },
      { "id": "row", "name": "row", "type": "element", "tag": "div" },
      { "id": "input", "name": "input", "type": "element", "tag": "input",
        "text": { "kind": "ref", "id": "Draft" },
        "attrs": { "placeholder": "What needs doing?", "type": "text" } },
      { "id": "addBtn", "name": "addBtn", "type": "element", "tag": "button",
        "text": { "kind": "literal", "value": "Add" } },
      { "id": "taskList", "name": "taskList", "type": "element", "tag": "ul" },
      { "id": "taskItem", "name": "taskItem", "type": "element", "tag": "li",
        "text": { "kind": "itemValue" } },
      { "id": "taskRepeat", "name": "taskRepeat", "type": "repeat",
        "source": "Tasks", "template": "taskItem" },
      { "id": "Draft", "name": "Draft", "type": "atom", "value": "" },
      { "id": "Tasks", "name": "Tasks", "type": "atom", "value": [] },
      { "id": "AppStyles", "name": "AppStyles", "type": "styleSheet", "rules": {
        "appRoot": {
          "background": { "kind": "literal", "value": "#ffffff" },
          "color":      { "kind": "literal", "value": "#0f172a" },
          "minHeight":  { "kind": "literal", "value": "100vh" },
          "display":    { "kind": "literal", "value": "flex" },
          "flexDirection": { "kind": "literal", "value": "column" },
          "alignItems": { "kind": "literal", "value": "center" },
          "gap":        { "kind": "literal", "value": 16 },
          "padding":    { "kind": "literal", "value": 48 },
          "fontFamily": { "kind": "literal", "value": "Inter, system-ui, sans-serif" }
        },
        "title": { "fontSize": { "kind": "literal", "value": 28 }, "fontWeight": { "kind": "literal", "value": 600 }, "margin": { "kind": "literal", "value": 0 } },
        "row": { "display": { "kind": "literal", "value": "flex" }, "gap": { "kind": "literal", "value": 8 } },
        "input": {
          "padding": { "kind": "literal", "value": "8px 12px" },
          "border": { "kind": "literal", "value": "1px solid #e2e8f0" },
          "borderRadius": { "kind": "literal", "value": 6 },
          "fontSize": { "kind": "literal", "value": 14 },
          "fontFamily": { "kind": "literal", "value": "Inter, system-ui, sans-serif" },
          "width": { "kind": "literal", "value": 280 },
          "outline": { "kind": "literal", "value": "none" }
        },
        "addBtn": {
          "background": { "kind": "literal", "value": "#2563eb" },
          "color": { "kind": "literal", "value": "#ffffff" },
          "border": { "kind": "literal", "value": "none" },
          "borderRadius": { "kind": "literal", "value": 6 },
          "padding": { "kind": "literal", "value": "8px 16px" },
          "fontWeight": { "kind": "literal", "value": 500 },
          "cursor": { "kind": "literal", "value": "pointer" }
        },
        "taskList": {
          "listStyle": { "kind": "literal", "value": "none" },
          "padding": { "kind": "literal", "value": 0 },
          "margin": { "kind": "literal", "value": 0 },
          "display": { "kind": "literal", "value": "flex" },
          "flexDirection": { "kind": "literal", "value": "column" },
          "gap": { "kind": "literal", "value": 6 },
          "minWidth": { "kind": "literal", "value": 320 }
        },
        "taskItem": {
          "padding": { "kind": "literal", "value": "10px 14px" },
          "background": { "kind": "literal", "value": "#f8fafc" },
          "border": { "kind": "literal", "value": "1px solid #e2e8f0" },
          "borderRadius": { "kind": "literal", "value": 6 },
          "fontSize": { "kind": "literal", "value": 14 }
        }
      } },
      { "id": "InputChange", "name": "InputChange", "type": "cause", "source": "input", "event": "change" },
      { "id": "AddClick", "name": "AddClick", "type": "cause", "source": "addBtn", "event": "click" },
      { "id": "WriteDraft", "name": "WriteDraft", "type": "effect", "op": "setAtomFromInput" },
      { "id": "ClearDraft", "name": "ClearDraft", "type": "effect", "op": "setAtom", "value": "" },
      { "id": "AppendTask", "name": "AppendTask", "type": "effect", "op": "appendReadToList" }
    ],
    "edges": [
      { "from": "App", "to": "appRoot", "kind": "renders" },
      { "from": "appRoot", "to": "title", "kind": "contains" },
      { "from": "appRoot", "to": "row", "kind": "contains" },
      { "from": "row", "to": "input", "kind": "contains" },
      { "from": "row", "to": "addBtn", "kind": "contains" },
      { "from": "appRoot", "to": "taskList", "kind": "contains" },
      { "from": "taskList", "to": "taskRepeat", "kind": "contains" },
      { "from": "App", "to": "InputChange", "kind": "hasCause" },
      { "from": "App", "to": "AddClick", "kind": "hasCause" },
      { "from": "InputChange", "to": "WriteDraft", "kind": "triggers" },
      { "from": "WriteDraft", "to": "Draft", "kind": "writes" },
      { "from": "AddClick", "to": "AppendTask", "kind": "triggers" },
      { "from": "AddClick", "to": "ClearDraft", "kind": "triggers" },
      { "from": "AppendTask", "to": "Draft", "kind": "reads" },
      { "from": "AppendTask", "to": "Tasks", "kind": "writes" },
      { "from": "ClearDraft", "to": "Draft", "kind": "writes" },
      { "from": "AppStyles", "to": "appRoot", "kind": "targets" },
      { "from": "AppStyles", "to": "title", "kind": "targets" },
      { "from": "AppStyles", "to": "row", "kind": "targets" },
      { "from": "AppStyles", "to": "input", "kind": "targets" },
      { "from": "AppStyles", "to": "addBtn", "kind": "targets" },
      { "from": "AppStyles", "to": "taskList", "kind": "targets" },
      { "from": "AppStyles", "to": "taskItem", "kind": "targets" }
    ]
  }
}

PATTERN — input + Add button + dynamic list:
  1. Draft atom (string), Tasks atom (empty list).
  2. Input element with text: { kind: "ref", id: "Draft" }.
  3. Cause on input.change → effect \`setAtomFromInput\` writes to Draft.
  4. Cause on addBtn.click → effect \`appendReadToList\` (READS Draft, WRITES Tasks) AND a second effect \`setAtom\` ("" → Draft) to clear the input.
  5. taskRepeat node with source: "Tasks", template: "taskItem".

This is the idiomatic shape — empty Draft values are skipped automatically, so clicking Add with an empty input is a no-op.

# Constraints

- Be COMPLETE: every id referenced in an edge must be defined as a node. Every styleSheet rules key must reference a Targets'd element.
- Cap at ~30 nodes and ~50 edges. Smaller is better.
- Always include an AppStyles stylesheet that targets every visible element (and any taskItem-style template) with at least background/color/font styles.
- Always set \`root\` to "App".
- For lists, use a SINGLE \`repeat\` node + template element. Do NOT enumerate fixed items.
- Output JSON only — no markdown fences.
`

export async function generateMiniApp(
  input: MiniAppGenerationInput,
): Promise<MiniAppGenerationResult> {
  const modelId = input.modelId ?? 'claude-sonnet-4-5'
  const { provider, resolvedModel } = getProvider(modelId)

  let raw = ''
  const result = await provider.streamCompletion(
    {
      model: resolvedModel,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: input.prompt }],
      maxTokens: 8000,
    },
    {
      onText: (chunk) => {
        raw += chunk
      },
      isCancelled: () => false,
    },
  )
  raw = result.fullText || raw

  if (!raw.trim()) {
    throw new Error('Model returned no text content')
  }

  let jsonStr = raw.trim()
  // Strip markdown fences if the model added them despite the instruction.
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
  }

  let parsed: any
  try {
    parsed = JSON.parse(jsonStr)
  } catch (err) {
    throw new Error(
      `Model response was not valid JSON: ${err instanceof Error ? err.message : err}. First 300 chars: ${jsonStr.slice(0, 300)}`,
    )
  }

  const payload = parsed?.payload
  if (!payload || !Array.isArray(payload.nodes) || !Array.isArray(payload.edges)) {
    throw new Error('Model output is missing payload.nodes / payload.edges')
  }

  return {
    payload,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
    raw,
  }
}

// Re-export so the route handler can type-narrow Anthropic errors.
export { Anthropic }
