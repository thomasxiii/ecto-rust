import React, { useEffect, useRef } from 'react'
import Editor, { type Monaco, type OnMount } from '@monaco-editor/react'
import { LANG_ID, THEME_ID, registerEctoScript } from '../lib/ectoscript/monacoLanguage'
import type { ParseError } from '../lib/ectoscript/parser'

interface Props {
  value: string
  onChange: (v: string) => void
  errors: ParseError[]
}

export function EctoEditor({ value, onChange, errors }: Props) {
  const monacoRef = useRef<Monaco | null>(null)
  const modelRef = useRef<any | null>(null)

  const onMount: OnMount = (editor, monaco) => {
    monacoRef.current = monaco
    modelRef.current = editor.getModel()
    registerEctoScript(monaco)
    if (modelRef.current) {
      monaco.editor.setModelLanguage(modelRef.current, LANG_ID)
    }
    monaco.editor.setTheme(THEME_ID)
  }

  // Sync parse errors → Monaco diagnostics.
  useEffect(() => {
    const monaco = monacoRef.current
    const model = modelRef.current
    if (!monaco || !model) return
    monaco.editor.setModelMarkers(
      model,
      'ectoscript',
      errors.map((e) => ({
        startLineNumber: e.line,
        endLineNumber: e.line,
        startColumn: 1,
        endColumn: 200,
        message: e.message,
        severity: monaco.MarkerSeverity.Error,
      })),
    )
  }, [errors])

  return (
    <div style={{ height: '100%', width: '100%', background: '#0b1220' }}>
      <Editor
        height="100%"
        defaultLanguage={LANG_ID}
        theme={THEME_ID}
        value={value}
        onMount={onMount}
        onChange={(v: string | undefined) => onChange(v ?? '')}
        options={{
          fontSize: 13,
          fontFamily:
            'JetBrains Mono, SFMono-Regular, ui-monospace, Menlo, Consolas, monospace',
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          tabSize: 2,
          insertSpaces: true,
          renderWhitespace: 'selection',
          padding: { top: 16, bottom: 16 },
          lineNumbersMinChars: 3,
          wordWrap: 'off',
          automaticLayout: true,
        }}
      />
    </div>
  )
}
