import React from 'react'
import ForceGraph3D from 'react-force-graph-3d'
import * as THREE from 'three'
import type { MiniGraphPayload } from '../engine'

interface Props {
  payload: MiniGraphPayload | null
  selectedId: string | null
  onSelect: (id: string | null) => void
}

const NODE_KIND_COLORS: Record<string, string> = {
  component: '#34d399',
  element: '#60a5fa',
  atom: '#facc15',
  token: '#fb923c',
  derived: '#a78bfa',
  styleSheet: '#f472b6',
  cause: '#22d3ee',
  effect: '#f87171',
  repeat: '#fb7185',
  visibility: '#c084fc',
  doc: '#94a3b8',
  ui: '#cbd5e1',
}

interface GNode {
  id: string
  label: string
  type: string
  color: string
}
interface GLink {
  source: string
  target: string
  type: string
  color: string
}

export function Graph3DPanel({ payload, selectedId, onSelect }: Props) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const [size, setSize] = React.useState({ w: 480, h: 360 })
  const fgRef = React.useRef<any>(null)

  React.useLayoutEffect(() => {
    if (!containerRef.current) return
    const ro = new ResizeObserver(([entry]) => {
      setSize({ w: entry.contentRect.width, h: entry.contentRect.height })
    })
    ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [])

  const data = React.useMemo(() => {
    if (!payload) return { nodes: [] as GNode[], links: [] as GLink[] }
    const nodes: GNode[] = (payload.nodes as any[]).map((n) => {
      const kind = String(n.type ?? '')
      return {
        id: String(n.id),
        label: `${kind} · ${String(n.name ?? n.id)}`,
        type: kind,
        color: NODE_KIND_COLORS[kind] ?? '#94a3b8',
      }
    })
    const links: GLink[] = (payload.edges as any[]).map((e) => ({
      source: String(e.from),
      target: String(e.to),
      type: String(e.kind),
      color: 'rgba(148, 163, 184, 0.4)',
    }))
    return { nodes, links }
  }, [payload])

  // Highlight the selected node by inflating its size.
  const nodeThreeObject = React.useCallback(
    (node: any) => {
      const isSel = node.id === selectedId
      const geom = new THREE.SphereGeometry(isSel ? 5 : 3, 16, 16)
      const mat = new THREE.MeshLambertMaterial({
        color: node.color,
        emissive: isSel ? node.color : 0x000000,
        emissiveIntensity: isSel ? 0.5 : 0,
      })
      const sphere = new THREE.Mesh(geom, mat)

      // text sprite for labels
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')!
      const text = node.label
      ctx.font = '24px Inter, sans-serif'
      const w = ctx.measureText(text).width + 16
      canvas.width = w
      canvas.height = 32
      ctx.font = '24px Inter, sans-serif'
      ctx.fillStyle = 'rgba(15, 23, 42, 0.78)'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.fillStyle = '#e2e8f0'
      ctx.fillText(text, 8, 24)
      const tex = new THREE.CanvasTexture(canvas)
      const spriteMat = new THREE.SpriteMaterial({ map: tex, depthTest: false })
      const sprite = new THREE.Sprite(spriteMat)
      sprite.scale.set(canvas.width / 6, canvas.height / 6, 1)
      sprite.position.set(0, 6, 0)

      const group = new THREE.Group()
      group.add(sphere)
      group.add(sprite)
      return group
    },
    [selectedId],
  )

  return (
    <div
      ref={containerRef}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        background: 'radial-gradient(circle at 50% 30%, #1e293b, #020617 70%)',
      }}
    >
      {/* legend */}
      <div
        style={{
          position: 'absolute',
          top: 8,
          left: 8,
          zIndex: 2,
          display: 'flex',
          flexWrap: 'wrap',
          gap: 4,
          maxWidth: 260,
        }}
      >
        {Object.entries(NODE_KIND_COLORS).map(([k, v]) => (
          <div
            key={k}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              padding: '2px 6px',
              fontSize: 10,
              color: '#cbd5e1',
              background: 'rgba(15, 23, 42, 0.6)',
              border: '1px solid rgba(148, 163, 184, 0.18)',
              borderRadius: 4,
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 8,
                background: v,
                display: 'inline-block',
              }}
            />
            {k}
          </div>
        ))}
      </div>
      {data.nodes.length === 0 ? (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            color: '#64748b',
            fontSize: 13,
          }}
        >
          Empty graph — write some EctoScript.
        </div>
      ) : (
        <ForceGraph3D
          ref={fgRef}
          graphData={data as any}
          width={size.w}
          height={size.h}
          backgroundColor="rgba(0,0,0,0)"
          nodeThreeObject={nodeThreeObject}
          linkColor={(l: any) => l.color}
          linkOpacity={0.4}
          linkWidth={0.5}
          linkDirectionalArrowLength={3}
          linkDirectionalArrowRelPos={0.95}
          linkLabel={(l: any) => l.type}
          onNodeClick={(node: any) => onSelect(node.id)}
          onBackgroundClick={() => onSelect(null)}
          enableNodeDrag
          showNavInfo={false}
        />
      )}
    </div>
  )
}
