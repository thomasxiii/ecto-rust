import { randomUUID } from 'node:crypto'
import type { GraphNode, GraphEdge, GraphPayload, AgentGraphOp } from '@ecto/shared'
import { getProvider, type ProviderStreamCallbacks } from './modelProvider.js'

// Re-export for backward compat
export type AgentOperation = AgentGraphOp

export interface AgentResult {
  reasoning: string
  operations: AgentOperation[]
  /** Why the model stopped: 'end_turn' (natural), 'max_tokens' (truncated), etc. */
  stopReason: string
}

export interface ConversationMessage {
  role: 'user' | 'assistant'
  content: string
}

// ── System prompt ───────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert frontend developer and UI architect working inside Ecto Engine, a graph-based React application editor. You modify applications by producing graph operations that create, update, or remove nodes and edges in the application graph.

## Graph Model

The application is represented as a directed graph of nodes and edges. The rendering pipeline turns this graph into a live React application.

### Node Types (mechanical layer — the ones you create/modify):

- **component**: A React component. Has \`data.isDefault\`, \`data.exported\`. Connected to its render tree via \`renders\` edges. When creating a new component, ALWAYS set \`data.exported: true\` so it appears in the preview root selector.
- **element**: A JSX element. Key data fields:
  - \`data.tagName\`: HTML tag ("div", "button", "h1", "section", etc.)
  - \`data.isCustomComponent\`: true if this references another component
  - \`data.isFragment\`: true for React fragments
  - \`data.isChildrenSlot\`: true for {children} slots
- **text**: Text content. \`data.value\` contains the string.
- **prop**: A prop binding. \`data.name\` is the prop name, \`data.value\` is the value, \`data.kind\` is "string"|"number"|"boolean"|"expr".
- **style**: CSS styling. Key data fields:
  - \`data.kind\`: "class" | "rule" | "atrule"
  - \`data.className\`: The CSS class name
  - \`data.rules\`: Array of { selector, declarations } where declarations is { property: value }
  - \`data.declarations\`: Flat { property: value } for the primary rule
- **state**: Component state. \`data.stateKind\` ("useState", "useReducer"), \`data.initialValue\`.
- **import**: Module import. \`data.source\` is the import path.
- **file**: Source file. \`data.filePath\`.
- **asset**: Static asset (image, SVG). \`data.dataUri\` or \`data.svg\`.
- **style_token**: A CSS custom property (design token). \`data.tokenName\` is the variable name (without \`--\`), \`data.value\` is the resolved value, \`data.scope\` is where it's declared (e.g., ":root", ".dark"). Use \`var(--tokenName)\` in style declarations to reference these.

### Edge Types (the ones you use):

- **renders**: component → element. Links a component to its root render element(s).
- **child_of**: element → element/text. Parent-child JSX relationship. \`order\` field determines position (lower = earlier).
- **binds_prop**: element → prop. Attaches a prop to an element.
- **styles**: element → style. Applies CSS to an element.
- **contains**: file → component/style. File contains this declaration.
- **references**: element → import/component. Element references another component.
- **imports**: file → import. File has this import.
- **owns_state**: component → state. Component owns this state.

### Rendering Pipeline

1. Starting from a component node, the renderer follows \`renders\` edges to find root elements.
2. For each element, it reads \`data.tagName\` to create the DOM element.
3. It follows \`binds_prop\` edges to gather props (className, style, href, src, etc.).
4. It follows \`child_of\` edges (sorted by \`order\`) to render children.
5. It follows \`styles\` edges to apply CSS classes.
6. For custom components (\`isCustomComponent: true\`), it follows \`references\` to resolve the target component and recurses.
7. Text nodes render their \`data.value\` as string content.

### CSS/Styling

When you create styles:
- Create a \`style\` node with \`data.kind: "class"\`, a unique \`data.className\`, and \`data.declarations\` + \`data.rules\`.
- \`data.declarations\` is a flat object like \`{ "background-color": "blue", "color": "white", "padding": "12px 24px" }\`
- \`data.rules\` is \`[{ "selector": ".classname", "declarations": { ... } }]\`
- Connect it with a \`styles\` edge from the element to the style node.
- When design tokens exist in the project (shown in the Design System section of the context), prefer \`var(--token-name)\` over hardcoded color/spacing/font values. This keeps your output consistent with the existing design system.

### Prop Handling

Props that the renderer passes through to the DOM: className, style, href, src, alt, title, id, type, placeholder, value, target, rel, name, role, tabindex, aria-*, data-*.
Other props are rendered as data attributes.

## Common Patterns

### Modifying styles on an existing element
If the selected node has style nodes connected via \`styles\` edges, use \`updateNode\` on the **style node** (not the element) to change CSS. The patch merges into the style node's data, so update both \`declarations\` and \`rules\`:
\`\`\`
{ "op": "updateNode", "nodeId": "<style-node-id>", "patch": {
    "declarations": { "font-size": "64px" },
    "rules": [{ "selector": ".<className>", "declarations": { ...existing declarations..., "font-size": "64px" } }]
  }
}
\`\`\`
If no style node exists yet, create one and connect it with a \`styles\` edge.

### Adding a sibling element
Find the parent element from the "Siblings" section in the context. Create the new element, then add a \`child_of\` edge from the parent to the new element with an appropriate \`order\` value.

### Reordering children
To reorder children of an element, use \`updateEdge\` to change the \`order\` field on existing \`child_of\` edges. The edge IDs are shown in the siblings section. Example — to swap the order of two children:
\`\`\`
{ "op": "updateEdge", "edgeId": "edge-abc", "order": 2 }
{ "op": "updateEdge", "edgeId": "edge-def", "order": 1 }
\`\`\`

## Rules

1. Generate unique IDs using the format \`agent-<short-descriptor>-<random>\` (e.g., \`agent-btn-a1b2c3\`) ONLY for NEW nodes you are creating.
2. **NEVER invent or guess IDs for existing nodes.** When you need to update or reference an existing node, you MUST use the exact ID shown in the graph context above. If you cannot find a node's ID in the context, do NOT make one up — skip that operation. Every text node's ID is listed in the "Text Index" section.
3. When adding elements as children of an existing element, check the existing child_of edges to determine the right \`order\` value. Use an order higher than existing children to append, or between existing orders to insert.
4. Always create proper edge connections — orphan nodes won't render.
5. ALWAYS create a style node + styles edge for every visible element you add. Unstyled elements render with ugly browser defaults. This is mandatory, not optional.
6. When modifying existing elements, use \`updateNode\` with a data patch rather than removing and re-adding.
7. Think step by step about the graph structure needed before producing operations.
8. Keep class names descriptive and unique (e.g., \`ecto-signup-btn\`, \`ecto-hero-title\`).
9. When the user refers to "this" or "the selected element", they mean the node provided in the selection context.
10. IMPORTANT: When updating style declarations, you MUST also update the \`rules\` array to match. The stylesheet generator reads from \`rules\`.
11. To change text content, use \`updateNode\` on the **text node** (not the parent element). Set \`patch: { "value": "new text" }\`. Find the text node's ID in the Text Index section.
12. The "Text Index" section lists EVERY text node in the project with its exact ID, value, and parent. Use it to find text you need to change — especially for site-wide changes like renaming "Log In" to "Sign In".

## Design Quality — CRITICAL

First, assess the request: **quick edit** vs **creative build**.

- **Quick edit** (change a color, fix text, tweak spacing): Be surgical. Minimal operations. Don't touch surrounding elements.
- **Creative build** (new page, new section, new component): Read the rules below carefully. Your output must look like a real, professionally designed application — not a skeleton of unstyled HTML.

### MANDATORY for creative builds:

1. **EVERY visible element MUST have a style node.** Never create a bare \`<h1>\`, \`<p>\`, \`<button>\`, \`<section>\`, or \`<div>\` without an attached style node + \`styles\` edge. Unstyled elements produce ugly browser defaults (Times New Roman, no spacing, no color). This is the #1 quality problem — if you skip styles, the result looks broken.

2. **Study the existing Styles and Design System sections in the context.** The project already has a visual language — colors, fonts, spacing, border-radius patterns. Your new elements MUST match. If the project uses \`var(--color-primary)\`, you use it too. If existing cards have \`border-radius: 12px\` and \`padding: 24px\`, yours should match. Don't invent a new design system — extend the one that's there.

3. **Build proper page structure.** A page is not just content — it needs:
   - A page wrapper with max-width, centering (\`margin: 0 auto\`), and padding
   - Sections with vertical spacing between them (48-96px)
   - Proper content hierarchy (heading → subtext → content → actions)
   - Background colors on sections for visual rhythm when appropriate

4. **Typography must be intentional.** Set font-size, font-weight, line-height, color, and margin/padding on every text-containing element. Body: 16-18px, line-height 1.5-1.7. Headings: 32-48px, font-weight 600-700, line-height 1.1-1.3. Hero headings: 48-72px. Subtext/descriptions: 14-16px with muted color.

5. **Spacing must follow a scale.** Use 4, 8, 12, 16, 24, 32, 48, 64, 96px only. Never arbitrary values. Cards: 24-32px padding. Sections: 48-96px vertical padding. Gaps between items: 16-24px. Generous whitespace looks professional.

6. **Color must be deliberate.** Use the project's tokens when they exist. Otherwise: one primary color for CTAs, a neutral scale (gray-50 through gray-900) for text and backgrounds, one accent for highlights. Use specific hex values, never "red" or "blue". Text on dark bg must have 4.5:1+ contrast.

7. **Polish the details.** Cards: border-radius 8-16px, subtle box-shadow. Buttons: padding 12px 24px minimum, border-radius 6-8px, distinct hover state. Use flexbox/grid with gap for layouts. Center page content at max-width 1200px.

8. **Match the site's existing visual tone.** If the existing components use dark backgrounds, yours should too. If they use a specific font stack, match it. If buttons have a specific radius and padding, replicate it. Consistency > creativity.

## Output Format

Return a JSON object with:
- \`reasoning\`: Your step-by-step thinking about what graph changes are needed.
- \`operations\`: An array of operations to apply, in order.

Operation types:
- \`{ "op": "addNode", "id": "...", "nodeType": "element|text|style|prop|...", "name": "...", "data": {...} }\`
- \`{ "op": "addEdge", "edgeId": "...", "from": "nodeId", "to": "nodeId", "edgeType": "child_of|renders|styles|binds_prop|...", "order": number }\`
- \`{ "op": "updateNode", "nodeId": "...", "patch": {...} }\`  (merges into existing data)
- \`{ "op": "updateEdge", "edgeId": "...", "order": number }\`  (change edge order for reordering children)
- \`{ "op": "removeNode", "targetId": "nodeId" }\`
- \`{ "op": "removeEdge", "targetId": "edgeId" }\`

IMPORTANT: Respond with ONLY a valid JSON object, no markdown fences, no explanation outside the JSON. The JSON must have exactly two keys: "reasoning" (string) and "operations" (array).`

// ── Context builder ─────────────────────────────────────────────────

/**
 * Build a super-focused context for small local models.
 * Instead of dumping the whole graph, pre-digest the selected node into
 * labeled fields the model can directly reference.
 */
function buildCompactContext(
  payload: GraphPayload,
  selectedNodeId: string | null,
  projectName: string,
): string {
  const nodes = new Map<string, GraphNode>()
  for (const n of payload.nodes) nodes.set(n.id, n)
  const edgesByFrom = new Map<string, GraphEdge[]>()
  const edgesByTo = new Map<string, GraphEdge[]>()
  for (const e of payload.edges) {
    ;(edgesByFrom.get(e.fromNodeId) ?? (() => { const a: GraphEdge[] = []; edgesByFrom.set(e.fromNodeId, a); return a })()).push(e)
    ;(edgesByTo.get(e.toNodeId) ?? (() => { const a: GraphEdge[] = []; edgesByTo.set(e.toNodeId, a); return a })()).push(e)
  }

  const sections: string[] = [`# Project: ${projectName}`]

  // Selected node — structured for easy consumption
  if (selectedNodeId) {
    const sel = nodes.get(selectedNodeId)
    if (sel) {
      sections.push(`\nSELECTED_ELEMENT: ${sel.name} (id: ${sel.id}, type: ${sel.type}, tag: ${sel.data?.tagName ?? 'n/a'})`)

      // Style nodes
      const outEdges = edgesByFrom.get(sel.id) ?? []
      const styleEdges = outEdges.filter(e => e.type === 'styles')
      for (const se of styleEdges) {
        const style = nodes.get(se.toNodeId)
        if (style) {
          sections.push(`STYLE_NODE_ID: ${style.id}`)
          sections.push(`CLASS: ${style.data?.className ?? ''}`)
          sections.push(`CURRENT_CSS: ${JSON.stringify(style.data?.declarations ?? {})}`)
        }
      }

      // Text children
      const childEdges = outEdges
        .filter(e => e.type === 'child_of')
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      for (const ce of childEdges) {
        const child = nodes.get(ce.toNodeId)
        if (child?.type === 'text') {
          sections.push(`TEXT_NODE_ID: ${child.id}`)
          sections.push(`TEXT_VALUE: "${String(child.data?.value ?? '')}"`)
        }
      }

      // Prop bindings
      const propEdges = outEdges.filter(e => e.type === 'binds_prop')
      if (propEdges.length > 0) {
        const props = propEdges
          .map(e => nodes.get(e.toNodeId))
          .filter(Boolean)
          .map(p => `${p!.data?.name}=${JSON.stringify(p!.data?.value ?? '')} (id: ${p!.id})`)
        sections.push(`PROPS: ${props.join(', ')}`)
      }

      // Siblings for ordering context
      const parentEdges = (edgesByTo.get(sel.id) ?? []).filter(e => e.type === 'child_of')
      if (parentEdges.length > 0) {
        const parentId = parentEdges[0].fromNodeId
        const parent = nodes.get(parentId)
        const siblings = (edgesByFrom.get(parentId) ?? [])
          .filter(e => e.type === 'child_of')
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
        sections.push(`\nPARENT: ${parent?.name ?? parentId} (id: ${parentId})`)
        sections.push('SIBLINGS:')
        for (const sib of siblings) {
          const child = nodes.get(sib.toNodeId)
          const marker = sib.toNodeId === sel.id ? ' ← SELECTED' : ''
          const label = child?.type === 'text'
            ? `text: "${String(child.data?.value ?? '').slice(0, 40)}"`
            : `${child?.data?.tagName ?? child?.type ?? '?'}:${child?.name ?? '?'}`
          sections.push(`  [order ${sib.order ?? '?'}, edge: ${sib.id}] ${label} (id: ${sib.toNodeId})${marker}`)
        }
      }
    }
  }

  // Minimal text index — only include if no selection (for "change all X to Y" type requests)
  if (!selectedNodeId) {
    const textNodes = payload.nodes.filter(n => n.type === 'text' && n.data?.value).slice(0, 20)
    if (textNodes.length > 0) {
      sections.push('\n## Text Nodes')
      for (const t of textNodes) {
        const parentEdges = (edgesByTo.get(t.id) ?? []).filter(e => e.type === 'child_of')
        const parentId = parentEdges[0]?.fromNodeId ?? '?'
        const parent = parentId !== '?' ? nodes.get(parentId) : null
        sections.push(`  "${String(t.data?.value ?? '').slice(0, 60)}" (id: ${t.id}, parent: ${parent?.name ?? parentId})`)
      }
    }

    // Brief component list
    const components = payload.nodes.filter(n => n.type === 'component').slice(0, 10)
    if (components.length > 0) {
      sections.push('\n## Components')
      for (const c of components) {
        sections.push(`  ${c.name} (id: ${c.id})`)
      }
    }
  }

  return sections.join('\n')
}

function buildAgentContext(
  payload: GraphPayload,
  selectedNodeId: string | null,
  projectName: string,
  compact?: boolean,
): string {
  // For local models, use the focused format that pre-digests the selected node
  if (compact) return buildCompactContext(payload, selectedNodeId, projectName)

  const nodes = new Map<string, GraphNode>()
  for (const n of payload.nodes) nodes.set(n.id, n)

  const edgesByFrom = new Map<string, GraphEdge[]>()
  const edgesByTo = new Map<string, GraphEdge[]>()
  for (const e of payload.edges) {
    const arr = edgesByFrom.get(e.fromNodeId) ?? []
    arr.push(e)
    edgesByFrom.set(e.fromNodeId, arr)
    const arr2 = edgesByTo.get(e.toNodeId) ?? []
    arr2.push(e)
    edgesByTo.set(e.toNodeId, arr2)
  }

  const sections: string[] = []
  sections.push(`# Project: ${projectName}\n`)

  // Component tree overview
  const allComponents = payload.nodes.filter(n => n.type === 'component')
  const components = compact ? allComponents.slice(0, 10) : allComponents
  const treeDepth = compact ? 2 : 4
  sections.push(`## Components (${components.length}${compact && allComponents.length > 10 ? ` of ${allComponents.length}` : ''})`)
  for (const c of components) {
    const flags: string[] = []
    if (c.data?.isDefault) flags.push('default')
    if (c.data?.exported) flags.push('exported')
    const flagStr = flags.length ? ` [${flags.join(', ')}]` : ''
    sections.push(`\n### ${c.name}${flagStr} (id: ${c.id})`)

    // Render targets
    const renders = (edgesByFrom.get(c.id) ?? []).filter(e => e.type === 'renders')
    if (renders.length > 0) {
      sections.push('Renders:')
      for (const re of renders) {
        const el = nodes.get(re.toNodeId)
        if (el) describeElementTree(el, nodes, edgesByFrom, sections, 1, treeDepth)
      }
    }

    // State
    const stateEdges = (edgesByFrom.get(c.id) ?? []).filter(e => e.type === 'owns_state')
    if (stateEdges.length > 0) {
      const stateNames = stateEdges
        .map(e => nodes.get(e.toNodeId))
        .filter(Boolean)
        .map(s => `${s!.name}(${s!.data?.stateKind ?? '?'})`)
      sections.push(`State: ${stateNames.join(', ')}`)
    }
  }

  // Text index — every text node in the project so the agent can find + update any text
  const allTextNodes = payload.nodes.filter(n => n.type === 'text' && n.data?.value)
  const textNodes = compact ? allTextNodes.slice(0, 30) : allTextNodes
  if (textNodes.length > 0) {
    sections.push(`\n## Text Index (${textNodes.length}${compact && allTextNodes.length > 30 ? ` of ${allTextNodes.length}` : ''} text nodes) — use these IDs for updateNode`)
    for (const t of textNodes) {
      const val = String(t.data?.value ?? '').slice(0, 80)
      // Find the parent element
      const parentEdges = edgesByTo.get(t.id)?.filter(e => e.type === 'child_of') ?? []
      const parentId = parentEdges[0]?.fromNodeId ?? '?'
      const parent = parentId !== '?' ? nodes.get(parentId) : null
      const parentLabel = parent ? `${parent.data?.tagName ?? parent.type}:${parent.name}` : parentId
      sections.push(`  "${val}" (id: ${t.id}, parent: ${parentLabel}, parentId: ${parentId})`)
    }
  }

  // Style nodes — show full declarations for first 20 (design reference), summary for rest
  const allStyles = payload.nodes.filter(n => n.type === 'style' && n.data?.className)
  const styleLimit = compact ? 10 : 60
  const styles = allStyles
  if (styles.length > 0) {
    sections.push(`\n## Styles (${styles.length}) — study these to match the project's visual language`)
    for (let i = 0; i < Math.min(styles.length, styleLimit); i++) {
      const s = styles[i]
      const decls = s.data?.declarations as Record<string, string> | undefined
      const entries = decls ? Object.entries(decls) : []
      if (i < 20) {
        // Full declarations for the first 20 — the agent needs to see complete patterns
        const declStr = entries.map(([k, v]) => `${k}: ${v}`).join('; ')
        sections.push(`  .${s.data.className} (id: ${s.id}) { ${declStr} }`)
      } else {
        const declStr = entries.slice(0, 8).map(([k, v]) => `${k}: ${v}`).join('; ')
        const more = entries.length > 8 ? ` +${entries.length - 8} more` : ''
        sections.push(`  .${s.data.className} (id: ${s.id}) { ${declStr}${more} }`)
      }
    }
  }

  // Design system tokens (skip in compact mode to save context)
  const tokens = compact ? [] : payload.nodes.filter(n => n.type === 'style_token')
  if (tokens.length > 0) {
    const capped = tokens.slice(0, 100)
    sections.push(`\n## Design System (${tokens.length} tokens)`)

    const colorTokens: string[] = []
    const typographyTokens: string[] = []
    const spacingTokens: string[] = []
    const otherTokens: string[] = []

    for (const t of capped) {
      const name = (t.data?.tokenName as string) ?? t.name
      const value = (t.data?.value as string) ?? '?'
      const scope = (t.data?.scope as string) ?? ':root'
      const line = `  --${name}: ${value}` + (scope !== ':root' ? ` (${scope})` : '')
      const nameLower = name.toLowerCase()

      if (/color|bg|background|border-color|shadow|fill|stroke|accent|primary|secondary|neutral|gray|grey|brand|surface|foreground/.test(nameLower)) {
        colorTokens.push(line)
      } else if (/font|text|letter|line-height|weight|size|heading|body|display|leading|tracking|type/.test(nameLower)) {
        typographyTokens.push(line)
      } else if (/space|spacing|gap|padding|margin|gutter|inset/.test(nameLower)) {
        spacingTokens.push(line)
      } else {
        otherTokens.push(line)
      }
    }

    if (colorTokens.length) sections.push('Colors:', ...colorTokens)
    if (typographyTokens.length) sections.push('Typography:', ...typographyTokens)
    if (spacingTokens.length) sections.push('Spacing:', ...spacingTokens)
    if (otherTokens.length) sections.push('Other:', ...otherTokens)
    if (tokens.length > 100) sections.push(`  ... and ${tokens.length - 100} more tokens`)
  }

  // Selected node context
  if (selectedNodeId) {
    const sel = nodes.get(selectedNodeId)
    if (sel) {
      sections.push(`\n## Currently Selected Node`)
      sections.push(`ID: ${sel.id}`)
      sections.push(`Type: ${sel.type}`)
      sections.push(`Name: ${sel.name}`)
      sections.push(`Data: ${JSON.stringify(sel.data, null, 2)}`)

      // All incoming edges (parents, who renders this, etc.)
      const inEdges = edgesByTo.get(sel.id) ?? []
      if (inEdges.length > 0) {
        sections.push('\nIncoming edges:')
        for (const pe of inEdges.slice(0, 10)) {
          const parent = nodes.get(pe.fromNodeId)
          sections.push(`  ${pe.type} from ${parent?.type ?? '?'}:${parent?.name ?? '?'} (id: ${pe.fromNodeId}, edge: ${pe.id}, order: ${pe.order ?? 'none'})`)
        }
      }

      // All outgoing edges (children, props, styles)
      const outEdges = edgesByFrom.get(sel.id) ?? []
      if (outEdges.length > 0) {
        sections.push('\nOutgoing edges:')
        for (const oe of outEdges) {
          const target = nodes.get(oe.toNodeId)
          sections.push(`  ${oe.type} → ${target?.type ?? '?'}:${target?.name ?? '?'} (id: ${oe.toNodeId}, edge: ${oe.id}, order: ${oe.order ?? 'none'})`)
        }
      }

      // Full style node details (so the AI can update declarations)
      const styleEdges = outEdges.filter(e => e.type === 'styles')
      for (const se of styleEdges) {
        const style = nodes.get(se.toNodeId)
        if (style) {
          sections.push(`\nStyle node detail (id: ${style.id}):`)
          sections.push(`  className: ${style.data?.className}`)
          sections.push(`  declarations: ${JSON.stringify(style.data?.declarations ?? {})}`)
          sections.push(`  rules: ${JSON.stringify(style.data?.rules ?? [])}`)
        }
      }

      // Sibling context — show parent's children so the AI can determine order
      for (const pe of inEdges) {
        if (pe.type === 'child_of') {
          const parentId = pe.fromNodeId
          const siblings = (edgesByFrom.get(parentId) ?? [])
            .filter(e => e.type === 'child_of')
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
          if (siblings.length > 0) {
            const parent = nodes.get(parentId)
            sections.push(`\nSiblings (children of ${parent?.type ?? '?'}:${parent?.name ?? '?'}, id: ${parentId}):`)
            for (const sib of siblings) {
              const child = nodes.get(sib.toNodeId)
              const marker = sib.toNodeId === sel.id ? ' ← SELECTED' : ''
              sections.push(`  [order ${sib.order ?? '?'}, edge: ${sib.id}] ${child?.type ?? '?'}:${child?.name ?? '?'} (id: ${sib.toNodeId})${marker}`)
            }
          }
        }
      }
    }
  }

  return sections.join('\n')
}

function findFirstDescendantText(
  nodeId: string,
  nodes: Map<string, GraphNode>,
  edgesByFrom: Map<string, GraphEdge[]>,
  maxDepth: number,
): string | null {
  if (maxDepth <= 0) return null
  const children = (edgesByFrom.get(nodeId) ?? [])
    .filter(e => e.type === 'child_of')
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
  for (const ce of children) {
    const child = nodes.get(ce.toNodeId)
    if (!child) continue
    if (child.type === 'text') {
      const val = String(child.data?.value ?? '').trim()
      if (val) return val.slice(0, 40)
    }
    const found = findFirstDescendantText(ce.toNodeId, nodes, edgesByFrom, maxDepth - 1)
    if (found) return found
  }
  return null
}

function describeElementTree(
  node: GraphNode,
  nodes: Map<string, GraphNode>,
  edgesByFrom: Map<string, GraphEdge[]>,
  out: string[],
  depth: number,
  maxDepth: number,
): void {
  const indent = '  '.repeat(depth)
  const tag = node.data?.tagName ?? node.name
  const isCustom = node.data?.isCustomComponent ? ' [custom]' : ''

  // Gather props
  const propEdges = (edgesByFrom.get(node.id) ?? []).filter(e => e.type === 'binds_prop')
  const propStrs = propEdges
    .map(e => nodes.get(e.toNodeId))
    .filter(Boolean)
    .map(p => `${p!.data?.name ?? p!.name}=${JSON.stringify(p!.data?.value ?? '').slice(0, 30)}`)
    .slice(0, 4)

  // Gather children
  const childEdges = (edgesByFrom.get(node.id) ?? [])
    .filter(e => e.type === 'child_of')
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))

  // Collect direct text children with their IDs for inline display
  const textChildNodes = childEdges
    .map(e => nodes.get(e.toNodeId))
    .filter((n): n is GraphNode => n?.type === 'text')

  // Brief inline label for the element line
  const inlineLabel = textChildNodes.length > 0
    ? ` → "${String(textChildNodes[0].data?.value ?? '').slice(0, 40)}"`
    : (() => {
        const firstText = findFirstDescendantText(node.id, nodes, edgesByFrom, 4)
        return firstText ? ` → "${firstText}"` : ''
      })()

  const propStr = propStrs.length ? ` ${propStrs.join(' ')}` : ''

  out.push(`${indent}<${tag}${isCustom}${propStr}>${inlineLabel} (id: ${node.id})`)

  // Show text children with their own IDs so the agent can target them
  for (const t of textChildNodes) {
    const val = String(t.data?.value ?? '').slice(0, 80)
    out.push(`${indent}  text: "${val}" (id: ${t.id})`)
  }

  if (depth >= maxDepth) {
    const remaining = childEdges.filter(e => {
      const n = nodes.get(e.toNodeId)
      return n && n.type !== 'text'
    })
    if (remaining.length > 0) out.push(`${indent}  ... ${remaining.length} more children`)
    return
  }

  for (const ce of childEdges) {
    const child = nodes.get(ce.toNodeId)
    if (!child || child.type === 'text') continue // text already shown above
    if (child.type === 'element') {
      // Show edge info so the AI can reference it for reordering
      out.push(`${indent}  [child_of edge: ${ce.id}, order: ${ce.order ?? 0}]`)
      describeElementTree(child, nodes, edgesByFrom, out, depth + 1, maxDepth)
    }
  }
}

// ── Build messages (provider-agnostic plain format) ─────────────────

function buildMessages(input: {
  payload: GraphPayload
  selectedNodeId: string | null
  projectName: string
  prompt: string
  conversationHistory: ConversationMessage[]
  compact?: boolean
}): Array<{ role: 'user' | 'assistant'; content: string }> {
  const context = buildAgentContext(input.payload, input.selectedNodeId, input.projectName, input.compact)

  const selIdx = context.indexOf('## Currently Selected Node')
  if (selIdx >= 0) {
    console.log('[agent] selected node context:\n' + context.slice(selIdx, selIdx + 1500))
  } else {
    console.log('[agent] no selected node in context, selectedNodeId:', input.selectedNodeId)
  }

  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = []

  const firstUserText = `Here is the current application graph:\n\n${context}`

  if (input.conversationHistory.length === 0) {
    messages.push({ role: 'user', content: `${firstUserText}\n\nUser request: ${input.prompt}` })
  } else {
    messages.push({ role: 'user', content: `${firstUserText}\n\nUser request: ${input.conversationHistory[0].content}` })
    for (let i = 1; i < input.conversationHistory.length; i++) {
      const msg = input.conversationHistory[i]
      messages.push({ role: msg.role, content: msg.content })
    }
    messages.push({ role: 'user', content: input.prompt })
  }

  return messages
}

// ── Parse + deduplicate operations ──────────────────────────────────

function parseAndDedup(raw: string, stopReason: string = 'end_turn'): AgentResult {
  let jsonStr = raw.trim()
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
  }

  let parsed: unknown

  // Try parsing as-is first
  try {
    parsed = JSON.parse(jsonStr)
  } catch {
    // Try to salvage — works for both truncated and mixed text+JSON responses
    const salvaged = salvageTruncatedJson(jsonStr)
    try {
      parsed = JSON.parse(salvaged)
    } catch {
      // Try to extract a JSON object from within the text (smaller models may add trailing text)
      const jsonMatch = jsonStr.match(/\{[\s\S]*"reasoning"[\s\S]*"operations"[\s\S]*\[/)
      if (jsonMatch) {
        const fromJson = jsonStr.slice(jsonMatch.index!)
        const salvaged2 = salvageTruncatedJson(fromJson)
        try {
          parsed = JSON.parse(salvaged2)
        } catch { /* fall through */ }
      }
    }

    // Last resort: try replacing single quotes with double quotes (some smaller models do this)
    if (!parsed) {
      try {
        parsed = JSON.parse(jsonStr.replace(/'/g, '"'))
      } catch { /* fall through */ }
    }
  }

  // If we still couldn't parse anything, treat the whole response as reasoning
  // with zero operations — the continuation loop will retry
  if (!parsed || typeof parsed !== 'object') {
    console.warn(`[agent] Could not parse JSON from Claude (stop: ${stopReason}), treating as zero-op round. First 200 chars: ${jsonStr.slice(0, 200)}`)
    return {
      reasoning: jsonStr.slice(0, 500),
      operations: [],
      stopReason,
    }
  }

  const obj = (parsed ?? {}) as Record<string, unknown>
  const reasoning = typeof obj.reasoning === 'string' ? obj.reasoning : ''
  const operations = Array.isArray(obj.operations) ? obj.operations as AgentOperation[] : []

  for (const op of operations) {
    if (op.op === 'addNode' && !op.id) op.id = `agent-${randomUUID().slice(0, 8)}`
    if (op.op === 'addEdge' && !op.edgeId) op.edgeId = `edge-agent-${randomUUID().slice(0, 8)}`
  }

  const seenNodeIds = new Set<string>()
  const seenEdgeKeys = new Set<string>()
  const seenEdgeUpdateIds = new Set<string>()
  const dedupedOps: AgentOperation[] = []
  for (const op of operations) {
    if (op.op === 'addNode') {
      if (op.id && seenNodeIds.has(op.id)) continue
      if (op.id) seenNodeIds.add(op.id)
    }
    if (op.op === 'addEdge') {
      const key = `${op.from}|${op.to}|${op.edgeType}`
      if (seenEdgeKeys.has(key)) continue
      seenEdgeKeys.add(key)
    }
    if (op.op === 'updateEdge') {
      if (op.edgeId && seenEdgeUpdateIds.has(op.edgeId)) continue
      if (op.edgeId) seenEdgeUpdateIds.add(op.edgeId)
    }
    dedupedOps.push(op)
  }

  console.log(`[agent] ${operations.length} ops (${dedupedOps.length} after dedup), stop: ${stopReason}, reasoning: ${reasoning.slice(0, 120)}`)
  return { reasoning, operations: dedupedOps, stopReason }
}

// ── Compact system prompt for smaller models ────────────────────────

const COMPACT_SYSTEM_PROMPT = `You modify a React app by returning JSON operations. Return ONLY a JSON object, no markdown fences.

The context gives you labeled fields:
- STYLE_NODE_ID + CLASS + CURRENT_CSS: the style to update
- TEXT_NODE_ID + TEXT_VALUE: the text to update
- SELECTED_ELEMENT: the element the user is pointing at

## How to change CSS
Use updateNode on the STYLE node (STYLE_NODE_ID), NOT the element. Merge new properties into existing CSS. Always set both declarations and rules.

Example — change color to blue:
{"reasoning":"Changing color","operations":[{"op":"updateNode","nodeId":"THE_STYLE_NODE_ID","patch":{"declarations":{"font-size":"48px","color":"blue"},"rules":[{"selector":".THE_CLASS","declarations":{"font-size":"48px","color":"blue"}}]}}]}

## How to change text
Use updateNode on the TEXT node (TEXT_NODE_ID):
{"op":"updateNode","nodeId":"THE_TEXT_NODE_ID","patch":{"value":"new text here"}}

## How to add elements
{"op":"addNode","id":"agent-desc-random","nodeType":"element","name":"my-el","data":{"tagName":"div"}}
Then add a child_of edge from the PARENT to the new element with an order value.
Always create a style node + styles edge for new visible elements.

CRITICAL: Use ONLY the exact IDs from the context. Never guess or invent IDs for existing nodes.
Return: {"reasoning":"...","operations":[...]}`

// ── Streaming agent function ────────────────────────────────────────

export interface AgentStreamCallbacks {
  onThinkingChunk: (text: string) => void
  /** Called when operations are parsed. The caller should apply them and resolve when done. */
  onOperationsReady: (result: AgentResult) => Promise<void>
  /** Called if the stream is cancelled externally */
  isCancelled: () => boolean
}

const DEFAULT_MODEL = 'claude-sonnet-4-20250514'

export async function runAgentPromptStreaming(
  input: {
    projectName: string
    payload: GraphPayload
    selectedNodeId: string | null
    prompt: string
    conversationHistory: ConversationMessage[]
    modelId?: string
  },
  callbacks: AgentStreamCallbacks,
): Promise<AgentResult> {
  const modelId = input.modelId ?? DEFAULT_MODEL
  const isOllama = modelId.startsWith('ollama:')
  const compact = isOllama
  const systemPrompt = compact ? COMPACT_SYSTEM_PROMPT : SYSTEM_PROMPT

  const messages = buildMessages({ ...input, compact })

  const { provider, resolvedModel } = getProvider(modelId)
  const maxTokens = isOllama ? 4096 : 16000

  console.log(`[agent] using model: ${resolvedModel} (provider: ${modelId.split(':')[0]})`)

  // Track reasoning vs operations for streaming display
  let reasoningRaw = ''
  let reasoningDone = false
  let lastFlushedLen = 0

  const result = await provider.streamCompletion(
    { model: resolvedModel, system: systemPrompt, messages, maxTokens },
    {
      isCancelled: callbacks.isCancelled,
      onText: (text) => {
        reasoningRaw += text

        // Stream reasoning text until we hit "operations" marker
        if (!reasoningDone) {
          const opsMarker = '"operations"'
          const opsIdx = reasoningRaw.indexOf(opsMarker)
          if (opsIdx >= 0) {
            const remaining = reasoningRaw.slice(lastFlushedLen, opsIdx)
            if (remaining.length > 0) {
              callbacks.onThinkingChunk(cleanReasoningChunk(remaining))
            }
            reasoningDone = true
          } else {
            const safeEnd = Math.max(lastFlushedLen, reasoningRaw.length - 20)
            if (safeEnd > lastFlushedLen) {
              const chunk = reasoningRaw.slice(lastFlushedLen, safeEnd)
              callbacks.onThinkingChunk(cleanReasoningChunk(chunk))
              lastFlushedLen = safeEnd
            }
          }
        }
      },
    },
  )

  if (callbacks.isCancelled()) {
    return { reasoning: '', operations: [], stopReason: 'cancelled' }
  }

  if (!result.fullText.trim()) {
    throw new Error('Model returned no content')
  }

  const parsed = parseAndDedup(result.fullText, result.stopReason)
  await callbacks.onOperationsReady(parsed)
  return parsed
}

/** Try to close truncated JSON so we can parse whatever operations we got. */
function salvageTruncatedJson(s: string): string {
  // Try parsing as-is first
  try { JSON.parse(s); return s } catch { /* continue */ }

  // Common truncation: JSON cut off mid-operations array.
  // Strategy: find the last complete object in the operations array, close it.
  // Look for the last `}` that could end an operation object
  let attempt = s
  // Strip trailing incomplete key/value/string
  attempt = attempt.replace(/,\s*"[^"]*"?\s*:?\s*[^}\]]*$/, '')
  // Strip any trailing incomplete object
  attempt = attempt.replace(/,\s*\{[^}]*$/, '')
  // Close the operations array and root object
  if (!attempt.endsWith(']')) attempt += ']'
  if (!attempt.endsWith('}')) attempt += '}'
  try { JSON.parse(attempt); return attempt } catch { /* continue */ }

  // Last resort: extract just the reasoning
  const reasoningMatch = s.match(/"reasoning"\s*:\s*"((?:[^"\\]|\\.)*)/)
  if (reasoningMatch) {
    return JSON.stringify({ reasoning: reasoningMatch[1], operations: [] })
  }

  return s // give up, let the caller handle the parse error
}

/** Clean up raw JSON fragments for display as reasoning text */
function cleanReasoningChunk(s: string): string {
  // Strip leading JSON structure: {"reasoning": "
  s = s.replace(/^\s*\{\s*"reasoning"\s*:\s*"?/, '')
  // Unescape common JSON escapes
  s = s.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\t/g, '\t')
  // Strip trailing incomplete escape
  if (s.endsWith('\\')) s = s.slice(0, -1)
  // Strip trailing punctuation that's just JSON structure
  s = s.replace(/"\s*,?\s*$/, '')
  return s
}

// ── Non-streaming version (kept for HTTP fallback) ──────────────────

export async function runAgentPrompt(input: {
  projectName: string
  payload: GraphPayload
  selectedNodeId: string | null
  prompt: string
  conversationHistory: ConversationMessage[]
  modelId?: string
}): Promise<AgentResult> {
  const modelId = input.modelId ?? DEFAULT_MODEL
  const isOllama = modelId.startsWith('ollama:')
  const compact = isOllama
  const systemPrompt = compact ? COMPACT_SYSTEM_PROMPT : SYSTEM_PROMPT

  const messages = buildMessages({ ...input, compact })

  const { provider, resolvedModel } = getProvider(modelId)
  const maxTokens = isOllama ? 4096 : 16000

  let fullText = ''
  const result = await provider.streamCompletion(
    { model: resolvedModel, system: systemPrompt, messages, maxTokens },
    { isCancelled: () => false, onText: (t) => { fullText += t } },
  )

  if (!result.fullText.trim()) {
    throw new Error('Model returned no content')
  }

  return parseAndDedup(result.fullText, result.stopReason)
}

