// Lightweight design-system primitives — Button, Input, Textarea, Card,
// Modal. Hand-rolled, no shadcn dependency; aesthetic-only match (Inter,
// black on white, blue accent). All apps generated through the graph
// runtime use the same look-and-feel by referencing tokens like #2563eb.

import React, { useEffect } from 'react'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

export function Button({
  children,
  variant = 'primary',
  className,
  style,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant
}) {
  const cls = `ec-btn ${variant === 'secondary' ? 'ec-btn-secondary' : ''} ${
    variant === 'ghost' ? 'ec-btn-ghost' : ''
  } ${className ?? ''}`.trim()
  const variantStyle: React.CSSProperties =
    variant === 'danger'
      ? { background: 'var(--danger)', borderColor: 'var(--danger)', color: '#fff' }
      : {}
  return (
    <button {...rest} className={cls} style={{ ...variantStyle, ...style }}>
      {children}
    </button>
  )
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`ec-input ${props.className ?? ''}`.trim()} />
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      {...props}
      className={`ec-input ec-textarea ${props.className ?? ''}`.trim()}
    />
  )
}

export function Card({
  children,
  style,
  className,
}: {
  children: React.ReactNode
  style?: React.CSSProperties
  className?: string
}) {
  return (
    <div className={`ec-card ${className ?? ''}`.trim()} style={style}>
      {children}
    </div>
  )
}

export function Modal({
  open,
  onClose,
  title,
  children,
  width = 560,
}: {
  open: boolean
  onClose: () => void
  title?: string
  children: React.ReactNode
  width?: number
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgb(15 23 42 / 0.36)',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 1000,
        padding: 24,
      }}
    >
      <div
        className="ec-card"
        style={{
          width: '100%',
          maxWidth: width,
          background: 'var(--bg)',
          boxShadow: 'var(--shadow-lg)',
          overflow: 'hidden',
        }}
      >
        {title && (
          <div
            style={{
              padding: '16px 20px',
              borderBottom: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{title}</h3>
            <Button variant="ghost" onClick={onClose} aria-label="Close" style={{ padding: 4 }}>
              ✕
            </Button>
          </div>
        )}
        <div style={{ padding: 20 }}>{children}</div>
      </div>
    </div>
  )
}

export const tokens = {
  fg: 'var(--fg)',
  fgMuted: 'var(--fg-muted)',
  fgSubtle: 'var(--fg-subtle)',
  bg: 'var(--bg)',
  bgMuted: 'var(--bg-muted)',
  bgSunken: 'var(--bg-sunken)',
  border: 'var(--border)',
  accent: 'var(--accent)',
  radius: 'var(--radius)',
  radiusLg: 'var(--radius-lg)',
  fontMono: 'var(--font-mono)',
}
