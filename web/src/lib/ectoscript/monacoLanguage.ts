// Monaco language registration for `ectoscript`.
//
// We register a Monarch tokenizer, a dark theme, and a completion
// provider for keywords / element names / style props. Diagnostics are
// pushed from the studio component via `monaco.editor.setModelMarkers`.

import type * as monacoNS from 'monaco-editor'

export const LANG_ID = 'ectoscript'
export const THEME_ID = 'ecto-dark'

const KEYWORDS = [
  'model',
  'component',
  'state',
  'render',
  'styles',
  'token',
  'derived',
  'uses',
  'is',
  'when',
  'on',
  'toggle',
  'set',
  'binds',
  'editable',
  'inspectable',
  'if',
  'or',
  'and',
  'not',
  'true',
  'false',
]

const ELEMENT_NAMES = [
  'container',
  'row',
  'col',
  'card',
  'button',
  'checkbox',
  'text',
  'task',
  'description',
  'heading',
  'subheading',
  'input',
  'image',
  'icon',
  'badge',
  'list',
  'item',
]

const EVENT_NAMES = [
  'click',
  'doubleclick',
  'change',
  'input',
  'submit',
  'mouseenter',
  'mouseleave',
  'focus',
  'blur',
]

const STYLE_PROPS = [
  'bg',
  'fg',
  'radius',
  'shadow',
  'padding',
  'margin',
  'gap',
  'width',
  'height',
  'border',
  'font',
  'fontSize',
  'fontWeight',
]

let registered = false

export function registerEctoScript(monaco: typeof monacoNS): void {
  if (registered) return
  registered = true

  monaco.languages.register({ id: LANG_ID })

  monaco.languages.setMonarchTokensProvider(LANG_ID, {
    keywords: KEYWORDS,
    elements: ELEMENT_NAMES,
    events: EVENT_NAMES,
    styleProps: STYLE_PROPS,
    tokenizer: {
      root: [
        [/\/\/.*$/, 'comment'],
        [/"[^"]*"/, 'string'],
        [/#[0-9a-fA-F]{3,8}\b/, 'number.hex'],
        [/-?\d+(?:\.\d+)?(px|rem|em|%|vh|vw|ms|s)\b/, 'number'],
        [/-?\d+(?:\.\d+)?/, 'number'],
        [/[<>=:]/, 'delimiter'],
        [
          /[a-zA-Z_][a-zA-Z0-9_]*/,
          {
            cases: {
              '@keywords': 'keyword',
              '@elements': 'tag',
              '@events': 'type.identifier',
              '@styleProps': 'attribute.name',
              '@default': 'identifier',
            },
          },
        ],
      ],
    },
  } as any)

  monaco.languages.setLanguageConfiguration(LANG_ID, {
    comments: { lineComment: '//' },
    brackets: [['<', '>']],
    autoClosingPairs: [
      { open: '"', close: '"' },
      { open: '(', close: ')' },
    ],
    onEnterRules: [
      {
        // Auto-indent after lines that introduce a block.
        beforeText: /^\s*(model|component|state|render|styles|on|uses|<.*)\b.*$/,
        action: { indentAction: monaco.languages.IndentAction.Indent },
      },
    ],
  })

  monaco.editor.defineTheme(THEME_ID, {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'keyword', foreground: '7dd3fc', fontStyle: 'bold' },
      { token: 'tag', foreground: 'c4b5fd' },
      { token: 'type.identifier', foreground: '34d399' },
      { token: 'attribute.name', foreground: 'fbbf24' },
      { token: 'number.hex', foreground: 'f472b6' },
      { token: 'number', foreground: 'fda4af' },
      { token: 'string', foreground: 'fcd34d' },
      { token: 'comment', foreground: '64748b', fontStyle: 'italic' },
      { token: 'delimiter', foreground: '94a3b8' },
      { token: 'identifier', foreground: 'e2e8f0' },
    ],
    colors: {
      'editor.background': '#0b1220',
      'editor.foreground': '#e2e8f0',
      'editorLineNumber.foreground': '#334155',
      'editorLineNumber.activeForeground': '#94a3b8',
      'editorCursor.foreground': '#7dd3fc',
      'editor.lineHighlightBackground': '#0f1a2e',
      'editorIndentGuide.background': '#1e293b',
      'editorIndentGuide.activeBackground': '#334155',
      'editor.selectionBackground': '#2563eb55',
      'editorBracketMatch.background': '#1d4ed844',
    },
  })

  monaco.languages.registerCompletionItemProvider(LANG_ID, {
    triggerCharacters: [' ', '<', '.', '\n'],
    provideCompletionItems: (model, position) => {
      const word = model.getWordUntilPosition(position)
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      }
      const suggestions: monacoNS.languages.CompletionItem[] = [
        ...KEYWORDS.map((k) => ({
          label: k,
          kind: monaco.languages.CompletionItemKind.Keyword,
          insertText: k,
          range,
        })),
        ...ELEMENT_NAMES.map((e) => ({
          label: e,
          kind: monaco.languages.CompletionItemKind.Property,
          insertText: e,
          range,
        })),
        ...EVENT_NAMES.map((e) => ({
          label: e,
          kind: monaco.languages.CompletionItemKind.Event,
          insertText: e,
          range,
        })),
        ...STYLE_PROPS.map((p) => ({
          label: p,
          kind: monaco.languages.CompletionItemKind.Field,
          insertText: `${p}: `,
          range,
        })),
      ]
      return { suggestions }
    },
  })
}

export const STARTER_ECTOSCRIPT = `model TaskModel
  state checked = false
  state text = "Write EctoScript"
  state description = "This task is rendered from an app graph."

component Task
  // This is the main Task component. It can expand and collapse.

  uses TaskModel
    is inspectable

  state expanded = false
    is inspectable

  render
    < container
      style Card
      on doubleclick
        toggle expanded

      < checkbox
        checked binds TaskModel.checked
        on click
          toggle TaskModel.checked

      < task
        is editable
        text binds TaskModel.text

      < description when expanded
        is editable
        text binds TaskModel.description

model Theme
  state darkMode = false

token Radius = 12px
token White = #ffffff
token Black = #111111
token Blue = #4f7cff

derived Bg = if Theme.darkMode Black or White
derived Fg = if Theme.darkMode White or Black

styles Card
  bg: Bg
  fg: Fg
  radius: Radius
  shadow: 0 8px 24px Black.20
  padding: 16px
  gap: 8px
`
