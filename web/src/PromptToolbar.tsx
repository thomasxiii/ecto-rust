// Minimal prompt toolbar — talks to the server's streaming agent via
// socket.io. Reasoning text streams into the bubble; each `agentOpApplied`
// fires a local engine mutation so the preview updates in real time.

import React, { useEffect, useRef, useState } from 'react'
import { bindAgentStream, emitAgentStart, emitAgentCancel } from './socket'

interface Props {
  projectId: string
  selectedId: string | null
  disabled: boolean
  onOpApplied: () => void
}

export function PromptToolbar({ projectId, selectedId, disabled, onOpApplied }: Props) {
  const [prompt, setPrompt] = useState('')
  const [agentId, setAgentId] = useState<string | null>(null)
  const [thinking, setThinking] = useState('')
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const thinkingRef = useRef<string>('')

  useEffect(() => {
    return bindAgentStream({
      onThinking: (_id, text) => {
        thinkingRef.current += text
        setThinking(thinkingRef.current)
      },
      onOpApplied: () => onOpApplied(),
      onDone: () => setStatus('done'),
      onError: (_id, err) => {
        setError(err)
        setStatus('error')
      },
    })
  }, [onOpApplied])

  const submit = () => {
    if (!prompt.trim()) return
    const id = `agent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    setAgentId(id)
    setStatus('running')
    setError(null)
    thinkingRef.current = ''
    setThinking('')
    emitAgentStart({
      agentId: id,
      projectId,
      prompt,
      selectedNodeId: selectedId,
      conversationHistory: [],
      agentColor: '#5af',
    })
  }

  const cancel = () => {
    if (agentId) emitAgentCancel(agentId)
    setStatus('idle')
  }

  return (
    <div
      style={{
        position: 'fixed',
        bottom: 16,
        left: '50%',
        transform: 'translateX(-50%)',
        width: 'min(720px, calc(100% - 32px))',
        background: '#1c1c22',
        border: '1px solid #2a2a30',
        borderRadius: 10,
        padding: 8,
        boxShadow: '0 8px 30px rgba(0,0,0,0.4)',
        zIndex: 50,
      }}
    >
      {thinking || error ? (
        <div
          style={{
            fontSize: 11,
            color: error ? '#f88' : '#8fa',
            padding: '6px 8px',
            maxHeight: 120,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            borderBottom: '1px solid #2a2a30',
            marginBottom: 6,
          }}
        >
          {error ?? thinking}
        </div>
      ) : null}
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder={disabled ? 'Import a project to enable' : 'Ask the agent — "rename Welcome to Hello there"'}
          disabled={disabled || status === 'running'}
          style={{
            flex: 1,
            background: '#0f0f12',
            border: '1px solid #2a2a30',
            borderRadius: 6,
            padding: '8px 10px',
            color: '#e6e6ea',
            fontSize: 13,
          }}
        />
        {status === 'running' ? (
          <button onClick={cancel} style={btn}>Cancel</button>
        ) : (
          <button onClick={submit} disabled={disabled || !prompt.trim()} style={btn}>
            Send
          </button>
        )}
      </div>
    </div>
  )
}

const btn: React.CSSProperties = {
  background: '#3a3a45',
  border: 'none',
  borderRadius: 6,
  color: '#e6e6ea',
  padding: '8px 14px',
  cursor: 'pointer',
  fontSize: 13,
}
