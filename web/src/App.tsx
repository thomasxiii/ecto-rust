import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Engine, ensureEngineReady, type GraphNode, type GraphPayload, type RenderTreeNode } from './engine'
import { TINY_REACT_APP } from './fixture'
import { MiniToggleApp } from './MiniToggleApp'
import { Preview } from './Preview'
import { PromptToolbar } from './PromptToolbar'
import { Timeline } from './Timeline'
import {
  postImport,
  subscribeProject,
  emitMutation,
  fetchProjectGraph,
  type ServerGraphEvent,
} from './socket'

const LOCAL_PROJECT_ID = 'local-demo'

type View = 'engine' | 'mini-toggle'

export function App() {
  const [view, setView] = useState<View>('engine')

  if (view === 'mini-toggle') {
    return <MiniToggleApp onBack={() => setView('engine')} />
  }
  return <EngineView onOpenMiniToggle={() => setView('mini-toggle')} />
}

function EngineView({ onOpenMiniToggle }: { onOpenMiniToggle: () => void }) {
  const engineRef = useRef<Engine | null>(null)
  const [ready, setReady] = useState(false)
  const [graph, setGraph] = useState<GraphPayload>({ nodes: [], edges: [] })
  const [entryId, setEntryId] = useState<string | null>(null)
  const [tree, setTree] = useState<RenderTreeNode | null>(null)
  const [css, setCss] = useState('')
  const [classes, setClasses] = useState<Record<string, string[]>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [layerView, setLayerView] = useState<'mechanical' | 'semantic' | 'ui'>('mechanical')
  const [projectId, setProjectId] = useState<string | null>(null)
  const [serverConnected, setServerConnected] = useState(false)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    ensureEngineReady().then(() => {
      engineRef.current = new Engine()
      setReady(true)
    })
  }, [])

  // Subscribe to the project's room over socket.io. The server
  // broadcasts every mutation; we apply it to the local engine so
  // other tabs see edits made anywhere.
  useEffect(() => {
    if (!projectId || !engineRef.current) return
    const off = subscribeProject(projectId, (e: ServerGraphEvent) => {
      const eng = engineRef.current
      if (!eng) return
      try {
        switch (e.type) {
          case 'node_updated':
          case 'node_created':
            // The server emits whole-node payloads; the engine's
            // `add_node` mutation will dedupe by id (it errors), so
            // we go through loadGraph for created/updated to avoid
            // diverging. Apply directly by reading current graph,
            // merging, and reloading.
            applyServerEvent(eng, e)
            break
          case 'node_removed':
          case 'edge_removed':
          case 'edge_created':
          case 'edge_updated':
            applyServerEvent(eng, e)
            break
          case 'import_completed':
            // Fetch authoritative graph from server.
            fetchProjectGraph(projectId).then((res) => {
              eng.loadGraph(res.graph)
              setRevision((r) => r + 1)
            })
            return
        }
        setRevision((r) => r + 1)
      } catch (err) {
        console.warn('[ecto] failed to apply server event', e, err)
      }
    })
    setServerConnected(true)
    return () => {
      off()
      setServerConnected(false)
    }
  }, [projectId])

  // Whenever the engine's graph changes (local edit, server push, agent op),
  // refresh the visible state.
  useEffect(() => {
    if (!engineRef.current) return
    refreshFromEngine()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revision])

  const refreshFromEngine = () => {
    const eng = engineRef.current
    if (!eng) return
    const g = eng.getGraph()
    setGraph(g)
    const root =
      entryId ??
      g.nodes.find((n) => n.type === 'component' && (n.data?.exported ?? false))?.id ??
      g.nodes.find((n) => n.type === 'component')?.id ??
      null
    if (root && root !== entryId) setEntryId(root)
    if (root) setTree(eng.walkRenderTree(root))
    const sheet = eng.generateStylesheet()
    setCss(sheet.css)
    setClasses(sheet.classesByElement)
  }

  const importDemo = async () => {
    const eng = engineRef.current
    if (!eng) return
    const result = eng.importFiles('tiny-react-app', TINY_REACT_APP)
    setEntryId(result.entryNodeId)
    setRevision((r) => r + 1)
    // POST to the server so realtime collab works.
    try {
      const resp = await postImport({
        projectName: 'tiny-react-app',
        rootPathLabel: 'tiny-react-app',
        nodes: result.graph.nodes,
        edges: result.graph.edges,
        entryNodeId: result.entryNodeId,
      })
      setProjectId(resp.project.id)
    } catch (err) {
      console.warn('[ecto] server unreachable — running in local-only mode', err)
      setProjectId(LOCAL_PROJECT_ID)
    }
  }

  const selectedNode = useMemo<GraphNode | null>(() => {
    if (!selectedId) return null
    return graph.nodes.find((n) => n.id === selectedId) ?? null
  }, [selectedId, graph])

  const onSelect = (nodeId: string) => {
    setSelectedId(nodeId)
    const node = graph.nodes.find((n) => n.id === nodeId)
    if (node && node.type === 'element') {
      const childEdge = graph.edges.find((e) => e.fromNodeId === nodeId && e.type === 'child_of')
      if (childEdge) {
        const childNode = graph.nodes.find((n) => n.id === childEdge.toNodeId)
        if (childNode?.type === 'text') {
          setSelectedId(childNode.id)
          setEditText(String(childNode.data?.value ?? childNode.name))
          return
        }
      }
    }
    if (node?.type === 'text') {
      setEditText(String(node.data?.value ?? node.name))
    } else if (node) {
      setEditText(node.name)
    }
  }

  const applyEdit = () => {
    const eng = engineRef.current
    if (!eng || !selectedNode) return
    const mutation: any =
      selectedNode.type === 'text'
        ? {
            type: 'update_node_data',
            projectId: projectId ?? LOCAL_PROJECT_ID,
            nodeId: selectedNode.id,
            patch: { value: editText },
          }
        : {
            type: 'rename_node',
            projectId: projectId ?? LOCAL_PROJECT_ID,
            nodeId: selectedNode.id,
            name: editText,
          }
    eng.applyMutation(mutation)
    setRevision((r) => r + 1)
    if (projectId && projectId !== LOCAL_PROJECT_ID) {
      void emitMutation(mutation)
    }
  }

  const buildSemanticLayer = () => {
    const eng = engineRef.current
    if (!eng) return
    eng.buildSemanticLayer(projectId ?? LOCAL_PROJECT_ID)
    eng.buildUiLayer(projectId ?? LOCAL_PROJECT_ID)
    setRevision((r) => r + 1)
    setLayerView('semantic')
  }

  const filteredNodes = useMemo(() => {
    return graph.nodes.filter((n) => {
      const layer = n.data?.layer
      if (layerView === 'mechanical') return !layer
      if (layerView === 'semantic') return layer === 'semantic'
      return layer === 'ui'
    })
  }, [graph, layerView])

  return (
    <div style={{ display: 'flex', width: '100%' }}>
      <aside
        style={{
          width: 320,
          borderRight: '1px solid #2a2a30',
          padding: 12,
          overflow: 'auto',
          background: '#16161b',
        }}
      >
        <h3 style={{ margin: '0 0 8px' }}>ecto-rust</h3>
        <div style={{ fontSize: 11, color: serverConnected ? '#7d7' : '#aaa', marginBottom: 12 }}>
          {projectId
            ? serverConnected
              ? `● live · project ${projectId.slice(0, 8)}`
              : `○ local-only mode`
            : 'no project'}
        </div>
        <button onClick={importDemo} disabled={!ready} style={btn}>
          {ready ? 'Import demo project' : 'Loading WASM…'}
        </button>
        <button onClick={buildSemanticLayer} style={{ ...btn, marginTop: 8 }}>
          Build semantic + UI layers
        </button>
        <button
          onClick={onOpenMiniToggle}
          disabled={!ready}
          style={{ ...btn, marginTop: 8, background: '#2d4a3a' }}
        >
          Run mini toggle app →
        </button>
        <div style={{ marginTop: 16, fontSize: 11, color: '#888' }}>
          {graph.nodes.length} nodes · {graph.edges.length} edges
        </div>
        <div style={{ marginTop: 12, display: 'flex', gap: 4 }}>
          {(['mechanical', 'semantic', 'ui'] as const).map((l) => (
            <button
              key={l}
              onClick={() => setLayerView(l)}
              style={{
                ...btn,
                background: layerView === l ? '#3a3a45' : '#222',
                padding: '4px 8px',
                fontSize: 11,
              }}
            >
              {l}
            </button>
          ))}
        </div>
        <ul style={{ listStyle: 'none', padding: 0, margin: '12px 0' }}>
          {filteredNodes.slice(0, 200).map((n) => (
            <li
              key={n.id}
              onClick={() => onSelect(n.id)}
              style={{
                padding: '4px 6px',
                cursor: 'pointer',
                borderRadius: 4,
                background: selectedId === n.id ? '#2c2c34' : 'transparent',
                fontSize: 12,
                color: '#ccc',
              }}
            >
              <span style={{ color: '#888' }}>{n.type}</span> {n.name}
            </li>
          ))}
        </ul>
      </aside>

      <main style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
        <Preview tree={tree} css={css} classesByElement={classes} onSelect={onSelect} selectedId={selectedId} />
        {projectId ? (
          <>
            <PromptToolbar
              projectId={projectId}
              selectedId={selectedId}
              disabled={!ready}
              onOpApplied={() => {
                if (projectId === LOCAL_PROJECT_ID) setRevision((r) => r + 1)
              }}
            />
            {projectId !== LOCAL_PROJECT_ID ? (
              <Timeline
                projectId={projectId}
                onScrubTo={(snapshot) => {
                  const eng = engineRef.current
                  if (!eng) return
                  eng.loadGraph(snapshot)
                  setRevision((r) => r + 1)
                }}
                onResume={() => {
                  // Re-fetch current authoritative state from server.
                  fetchProjectGraph(projectId).then((res) => {
                    const eng = engineRef.current
                    if (!eng) return
                    eng.loadGraph(res.graph)
                    setRevision((r) => r + 1)
                  })
                }}
              />
            ) : null}
          </>
        ) : null}
      </main>

      <aside
        style={{
          width: 320,
          borderLeft: '1px solid #2a2a30',
          padding: 12,
          background: '#16161b',
        }}
      >
        <h4 style={{ margin: '0 0 12px' }}>Inspector</h4>
        {selectedNode ? (
          <>
            <div style={{ fontSize: 11, color: '#888' }}>{selectedNode.type}</div>
            <div style={{ fontSize: 13, marginBottom: 8 }}>{selectedNode.id}</div>
            <input
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              style={{
                width: '100%',
                padding: '6px 8px',
                background: '#0f0f12',
                border: '1px solid #2a2a30',
                borderRadius: 4,
                color: '#e6e6ea',
              }}
            />
            <button onClick={applyEdit} style={{ ...btn, marginTop: 8, width: '100%' }}>
              Apply
            </button>
            <pre style={{ marginTop: 12, fontSize: 11, color: '#888', overflow: 'auto' }}>
              {JSON.stringify(selectedNode.data, null, 2)}
            </pre>
          </>
        ) : (
          <p style={{ fontSize: 12, color: '#888' }}>Click a node in the preview or list.</p>
        )}
      </aside>
    </div>
  )
}

// Apply an incoming server graph_event into the engine's in-memory graph.
// We translate the event into the engine's local apply_mutation calls so
// the in-memory state stays in sync without doing a full graph fetch
// every time.
function applyServerEvent(eng: Engine, e: ServerGraphEvent): void {
  switch (e.type) {
    case 'node_created':
      eng.applyMutation({
        type: 'add_node',
        projectId: e.projectId,
        node: e.node,
      } as any)
      break
    case 'node_updated': {
      // Server emits the whole node; we translate to update_node_data
      // for the engine. The patch is the full data object.
      if (e.node) {
        eng.applyMutation({
          type: 'update_node_data',
          projectId: e.projectId,
          nodeId: e.node.id,
          patch: e.node.data ?? {},
        })
        if (e.node.name) {
          eng.applyMutation({
            type: 'rename_node',
            projectId: e.projectId,
            nodeId: e.node.id,
            name: e.node.name,
          })
        }
      }
      break
    }
    case 'node_removed':
      if (e.nodeId) {
        eng.applyMutation({
          type: 'remove_node',
          projectId: e.projectId,
          nodeId: e.nodeId,
        })
      }
      break
    case 'edge_created':
      if (e.edge) {
        eng.applyMutation({
          type: 'add_edge',
          projectId: e.projectId,
          edge: e.edge,
        } as any)
      }
      break
    case 'edge_removed':
      if (e.edgeId) {
        eng.applyMutation({
          type: 'remove_edge',
          projectId: e.projectId,
          edgeId: e.edgeId,
        })
      }
      break
    default:
      break
  }
}

const btn: React.CSSProperties = {
  background: '#3a3a45',
  border: 'none',
  borderRadius: 4,
  color: '#e6e6ea',
  padding: '6px 10px',
  cursor: 'pointer',
  width: '100%',
  fontSize: 12,
}
