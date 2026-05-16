// Embedded copy of the tiny-react-app fixture from ecto-engine. Lets
// the demo work without the user needing to grant File System Access.

import type { FileBlob } from './engine'

export const TINY_REACT_APP: FileBlob[] = [
  {
    path: 'src/App.tsx',
    content: `import React from 'react'
import { Header } from './Header'
import { Button } from './Button'
import { Card } from './Card'

export default function App() {
  return (
    <div className="app">
      <Header title="Ecto Rust" subtitle="Codebase-as-graph, in Rust+WASM" />
      <Card>
        <h3>Welcome</h3>
        <p>This tiny React app is rendered from a Rust-built graph.</p>
        <div>
          <Button label="Get Started" />
          <Button label="Learn more" />
        </div>
      </Card>
    </div>
  )
}
`,
  },
  {
    path: 'src/Header.tsx',
    content: `import React from 'react'

export function Header({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <header>
      <h1>{title}</h1>
      <p>{subtitle}</p>
    </header>
  )
}
`,
  },
  {
    path: 'src/Button.tsx',
    content: `import React from 'react'
import styles from './Button.module.css'

export function Button({ label, ghost }: { label: string; ghost?: boolean }) {
  return (
    <button className={ghost ? styles.ghost : styles.button} onClick="runtime.log">
      {label}
    </button>
  )
}
`,
  },
  {
    path: 'src/Card.tsx',
    content: `import React from 'react'

export function Card({ children }: { children: React.ReactNode }) {
  return <div className="card">{children}</div>
}
`,
  },
  {
    path: 'src/Button.module.css',
    content: `.button {
  padding: 10px 18px;
  border-radius: 8px;
  background: #111;
  color: #fff;
  font-weight: 600;
}
.ghost {
  background: transparent;
  color: #111;
  border: 1px solid #ccc;
}
`,
  },
]
