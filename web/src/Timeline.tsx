// Minimal timeline / revisions panel. Lists snapshots the server has
// stored for the current project and lets you click one to scrub
// back. Real-time edits are paused while a historical snapshot is
// loaded (we just reload the current state when the user exits).
//
// This pairs with the server's existing `/projects/:id/revisions` and
// `/projects/:id/revisions/:revisionId` routes — no server changes
// needed.

import React, { useEffect, useState } from 'react'

interface Revision {
  id: string
  revisionNumber: number
  label: string
  source: string
  createdAt: string
}

const SERVER_URL = (import.meta.env.VITE_SERVER_URL as string) ?? 'http://localhost:4000'

interface Props {
  projectId: string
  onScrubTo: (snapshot: { nodes: any[]; edges: any[] }) => void
  onResume: () => void
}

export function Timeline({ projectId, onScrubTo, onResume }: Props) {
  const [revisions, setRevisions] = useState<Revision[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    fetch(`${SERVER_URL}/projects/${projectId}/revisions`)
      .then((r) => r.json())
      .then((data) => setRevisions(data.revisions ?? []))
      .catch(() => setRevisions([]))
  }, [projectId, open])

  const scrub = async (rev: Revision) => {
    setActiveId(rev.id)
    const res = await fetch(`${SERVER_URL}/projects/${projectId}/revisions/${rev.id}`)
    const data = await res.json()
    if (data.snapshot) onScrubTo(data.snapshot)
  }

  const resume = () => {
    setActiveId(null)
    onResume()
  }

  return (
    <div
      style={{
        position: 'fixed',
        top: 16,
        right: 360,
        background: '#1c1c22',
        border: '1px solid #2a2a30',
        borderRadius: 8,
        padding: open ? 8 : 4,
        zIndex: 40,
        maxWidth: 280,
        maxHeight: open ? 360 : undefined,
        overflow: 'auto',
      }}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          background: 'transparent',
          border: 'none',
          color: '#aaa',
          fontSize: 11,
          cursor: 'pointer',
          width: '100%',
          textAlign: 'left',
        }}
      >
        {open ? '▼ History' : '▸ History'}
      </button>
      {open ? (
        <>
          {activeId ? (
            <button
              onClick={resume}
              style={{
                background: '#5a3',
                border: 'none',
                color: '#fff',
                borderRadius: 4,
                padding: '4px 8px',
                fontSize: 11,
                cursor: 'pointer',
                width: '100%',
                marginBottom: 6,
              }}
            >
              ← Resume live edits
            </button>
          ) : null}
          {revisions.length === 0 ? (
            <p style={{ fontSize: 11, color: '#888', margin: '4px 0' }}>
              No revisions yet. Import a project or make an edit to create one.
            </p>
          ) : (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {revisions.slice().reverse().map((r) => (
                <li
                  key={r.id}
                  onClick={() => scrub(r)}
                  style={{
                    padding: '4px 6px',
                    cursor: 'pointer',
                    borderRadius: 4,
                    background: activeId === r.id ? '#2c2c34' : 'transparent',
                    fontSize: 11,
                    color: '#ccc',
                  }}
                >
                  <span style={{ color: '#888' }}>#{r.revisionNumber}</span> {r.label}
                  <span style={{ color: '#666', float: 'right' }}>{r.source}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </div>
  )
}
