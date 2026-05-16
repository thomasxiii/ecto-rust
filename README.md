# ecto-rust

A Rust+WASM rewrite of [ecto-engine](../ecto-engine), targeting full feature
parity with a portable graph core that runs natively in the browser (WASM),
on iOS (FFI static lib), and on any host that can link a Rust `.a`.

> codebase → graph → server → live runtime → collaborative edit → real-time app update
>
> — but the engine is one Rust crate, not many language-specific reimplementations.

## Why

The TypeScript ecto-engine proved the thesis. ecto-rust is the production
substrate:

- **One source of truth.** Graph model, importer, mutation API, layer
  builders, render-tree walker, stylesheet generator — all in a single Rust
  crate. Both the browser (WASM) and iOS (FFI) link the same compiled core.
- **Predictable performance.** Babel/dart-sass are heavy in the browser; swc
  + lightningcss compiled to WASM run an order of magnitude faster on the
  same input.
- **No drift between platforms.** When we change a node kind or a heuristic,
  every host picks it up automatically.

## Layout

```
ecto-rust/
├── engine/        Rust graph engine — compiles to wasm32-unknown-unknown,
│                  aarch64-apple-ios, and native rlib for tests
├── web/           Vite + React shell. Owns DOM, sockets, file picking;
│                  delegates graph work across the WASM boundary
├── shared/        @ecto/shared — TS types kept in sync with the Rust
│                  serde shapes
├── server/        Fastify + SQLite + socket.io. Lifted from ecto-engine
│                  unchanged
└── host-ios/      Swift iOS host — bridges to the Rust engine via the
                   C FFI surface in `engine/src/ffi.rs`
```

## What works today

End-to-end demo: import a folder, see the graph render live in the
browser, edit nodes through the inspector, open a second tab and watch
edits propagate, type a prompt to drive a Claude agent that mutates the
graph, scrub through the revision history. All graph work — parsing,
extraction, layer inference, render-tree walking, stylesheet
generation, mutation application — runs in Rust+WASM.

### Engine (`engine/`)

- **Graph model** — 53 NodeKinds, 37 EdgeKinds, serde-JSON wire-compatible
  with ecto-engine's TS shapes (`shared/src/index.ts`).
- **Mutation API** — `apply_mutation` + `apply_agent_op` with validation,
  cascade-delete on `remove_node`, dangling-edge rejection on `add_edge`.
- **Importer** — JS/TS/JSX via `oxc`, CSS via `lightningcss`, Sass via
  `grass`. Cross-file resolution wires `import` → `references`, CSS-module
  `className={styles.foo}` → `styles` edges, and side-effect global
  stylesheets. Stable IDs match `stableId.ts` byte-for-byte so reimports
  produce identical IDs across implementations.
- **Semantic + UI layers** — `build_semantic_layer` emits
  `semantic_component` / `semantic_element` / `semantic_state` /
  `semantic_style` with provenance and capabilities; `build_ui_layer` emits
  `ui_selectable` and `ui_style_surface` with `represented_by` /
  `controlled_by` edges.
- **Render-tree walker** — `walk_render_tree(root_id)` produces a
  platform-neutral `RenderTreeNode` JSON shape, with a separate
  `renderKey` (unique per tree position) and `id` (graph node ID) so
  components rendered multiple times don't collide as React keys. Custom
  components are resolved by following `references` edges through `Import`
  nodes; `{children}` slots are filled from call-site children via a
  stack tracking nested invocations.
- **Stylesheet generator** — `generate_stylesheet()` rewrites CSS-module
  class selectors to synthesized `.ecto-sty_…` names, passes globals
  through verbatim, and returns `{ css, classesByElement }` for the
  runtime to inject.
- **Tests** — 33 unit tests + 1 integration test that imports the
  tiny-react-app fixture end-to-end. `cargo test` runs them all in
  milliseconds.
- **FFI** — C-ABI surface at `engine/src/ffi.rs` mirroring the WASM
  surface in shape. JSON in, JSON out, opaque `Engine *` handle.

### Web shell (`web/`)

- WASM bundle loaded via wasm-bindgen + a thin JSON-string wrapper so JS
  and the wasm boundary never trip the wasm-bindgen re-entry check.
- Live preview rendered in a sandboxed iframe (matches the pattern from
  ecto-engine for CSS isolation).
- Inspector with editable name / text-node values.
- Layer toggle (mechanical / semantic / UI).
- Realtime collab via socket.io — every local mutation is broadcast to
  the server which re-broadcasts to all subscribed clients; incoming
  events are applied to the local engine.
- Prompt toolbar wired to the server's streaming agent
  (`agent:start` → `agent:thinking` / `agent:op_applied` → `agent:done`).
- Timeline panel listing server-stored revisions; click to scrub back to
  a past snapshot, click "Resume" to return to the live graph.

### Server (`server/`)

Lifted from ecto-engine. Fastify + better-sqlite3 + socket.io. Provides:

- REST: `/import`, `/projects/:id/graph`, `/projects/:id/revisions[/...]`,
  `/projects/:id/design-system`, `/api/agent/prompt`, `/api/views/generate`,
  `/api/voice/{transcribe,analyze,resolve-element}`, `/api/semantic/enhance`.
- Socket.io: project rooms, `mutate` round-trip, broadcast `graph_event`,
  streaming agent (`agent:*`), design-system violation broadcasts.

The server has its own SQLite DB at `server/ecto.db` (auto-created on
first import). No env required for basic use; set `ANTHROPIC_API_KEY` to
enable Claude agents and `OPENAI_API_KEY` for voice transcription.

### iOS host (`host-ios/`)

- `EctoHost/Bridge/ecto_engine.h` — generated by cbindgen, declares the
  full Rust API in C.
- `EctoHost/Bridge/EngineBridge.swift` — Swift wrapper that hands JSON
  Data in and out, with `EngineError` cases for null returns and Rust
  errors.
- `host-ios/README.md` — step-by-step instructions to wire the static
  library into an Xcode project and reuse the existing
  `RenderTreeView` / `StyleMapper` / `SocketManager` Swift code from
  ecto-engine.

The static library builds successfully:

```bash
cargo build --release --target aarch64-apple-ios
# → target/aarch64-apple-ios/release/libecto_engine.a  (~67 MB)
```

## Quick start

```bash
# One-time toolchain.
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
. "$HOME/.cargo/env"
rustup target add wasm32-unknown-unknown
cargo install wasm-pack
npm install

# Build the WASM bundle (dev mode is faster, prod is much smaller).
RUSTFLAGS='--cfg getrandom_backend="wasm_js"' \
  wasm-pack build engine --dev --target web \
  --out-dir ../web/src/wasm --out-name ecto_engine

# Run server + web together.
npm install --prefix server
npm run dev   # uses concurrently
```

Open `http://localhost:5173`. Click **Import demo project** — the
embedded tiny-react-app fixture is parsed in WASM, the graph appears on
the left, and a live preview renders on the right. Click any node in the
preview to edit it, type in the bottom prompt bar to invoke the Claude
agent, or open History (top right) to scrub revisions.

For iOS: see `host-ios/README.md`.

## Tests & build

```bash
# Engine tests (native target, fast).
cargo test

# WASM release bundle.
RUSTFLAGS='--cfg getrandom_backend="wasm_js"' \
  wasm-pack build engine --release --target web \
  --out-dir ../web/src/wasm --out-name ecto_engine

# iOS static lib.
cargo build --release --target aarch64-apple-ios

# Regenerate the C header.
cbindgen --crate ecto-engine --lang c \
  --output host-ios/EctoHost/Bridge/ecto_engine.h
```

Current totals: **33 engine unit tests** + **1 integration test** on the
tiny-react-app fixture, all green.

## Engine-deferred items (not blocking the demo)

These work in ecto-engine and would be straightforward to port; they're
just deferred because they don't change the architecture:

- Compound CSS class rewriting (`.foo.bar.baz` selectors). Today only
  the primary `.foo` is rewritten to its synthesized id.
- Sass `@use` / `@import` resolution against the in-memory file set
  (single `.sass` files work; multi-file Sass needs a custom loader on
  top of `grass`).
- Dynamic className templates (`className={styles[`color-${x}`]}`).
- Next.js `pages/` route extraction and `api/` endpoint nodes.

## UI-deferred items (server already supports them)

The lifted server has every endpoint these need; the web UI surfaces
are the work that remains, and they're each a contained feature:

- **Voice toolbar** — `MediaRecorder` → POST `/api/voice/transcribe`
  (Whisper) → POST `/api/voice/analyze` (Claude action breakdown) →
  feed instructions into the existing PromptToolbar agent flow. The
  pattern is in ecto-engine's `web/src/ui/VoiceToolbar.tsx` and
  `web/src/lib/voiceStore.ts`.
- **Canvas views** — 2D canvas with frames + arrows + primitives.
  Backed by `/api/views/generate` (Claude composes a layout from a
  graph + prompt) and the views store in
  ecto-engine's `web/src/lib/viewsStore.ts`.
- **Design-system manifest viewer** — `/projects/:id/design-system`
  returns the color palette + violations; render it as a sidebar.
  Server already auto-corrects out-of-palette colors and emits
  `design_system:violation` events over socket.io.
- **3D graph canvas** — three.js + react-force-graph-3d, lifted from
  ecto-engine's `web/src/ui/GraphCanvas.tsx`. Reads the same graph
  payload, no engine changes.
- **iOS Xcode project** — the bridge files are ready; assembling the
  Xcode project, copying the SwiftUI views from ecto-engine's
  `host-ios/`, and wiring `EngineBridge` in place of `JSCoreBridge` is
  documented in `host-ios/README.md`.

## Mapping to ecto-engine

| ecto-engine                                  | ecto-rust                                |
|----------------------------------------------|------------------------------------------|
| `shared/src/index.ts`                        | `engine/src/graph/` + `shared/src/index.ts` |
| `core/src/semanticLayer.ts`                  | `engine/src/semantic.rs`                 |
| `core/src/uiLayer.ts`                        | `engine/src/ui_layer.rs`                 |
| `core/src/renderTree.ts`                     | `engine/src/render/tree.rs`              |
| `core/src/styleCollector.ts`, `web/src/runtime/stylesheet.ts` | `engine/src/render/stylesheet.rs` |
| `core/src/graphOperations.ts`                | `engine/src/mutations.rs`                |
| `web/src/importer/parseFile.ts`              | `engine/src/importer/parse_js.rs`        |
| `web/src/importer/parseCss.ts`, `compileSass.ts` | `engine/src/importer/parse_css.rs`   |
| `web/src/importer/index.ts`                  | `engine/src/importer/{mod,resolve}.rs`   |
| `web/src/importer/stableId.ts`               | `engine/src/stable_id.rs`                |
| `web/src/lib/socket.ts`                      | `web/src/socket.ts`                      |
| `web/src/ui/PromptToolbar.tsx`               | `web/src/PromptToolbar.tsx`              |
| `web/src/ui/HistoryInspector.tsx`            | `web/src/Timeline.tsx`                   |
| `server/src/*.ts`                            | `server/src/*.ts` (lifted)               |
| `host-ios/EctoHost/Bridge/JSCoreBridge.swift`| `host-ios/EctoHost/Bridge/EngineBridge.swift` (FFI) |
| `host-ios/EctoHost/Bridge/ecto_engine.h`     | generated by `cbindgen`                  |
