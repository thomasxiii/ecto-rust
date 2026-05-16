//! WebAssembly surface.
//!
//! Exposes an `Engine` class to JS. All inputs and outputs cross the
//! boundary as JSON **strings** rather than `JsValue` round-trips —
//! `serde_wasm_bindgen` walks JS objects via reflection while wasm
//! holds a `&mut self` borrow, which trips wasm-bindgen's runtime
//! re-entry check ("recursive use of an object detected"). JSON
//! strings sidestep that and also match how the iOS FFI bridge will
//! marshal data, so the JS and Swift hosts use the same contract.
//!
//! The TS wrapper at `web/src/engine.ts` does the JSON parse/stringify
//! on the JS side; from the caller's perspective the API is unchanged.

use crate::graph::types::{AgentGraphOp, GraphPayload};
use crate::graph::Graph;
use crate::importer::{import_project, FileBlob, ImportResult};
use crate::mutations::{apply_agent_op, apply_mutation, GraphMutation};
use crate::render::{generate_stylesheet, walk_render_tree};
use crate::semantic::build_semantic_layer;
use crate::ui_layer::build_ui_layer;
use serde::Serialize;
use std::cell::RefCell;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn __start() {
    console_error_panic_hook::set_once();
}

/// Returns the crate version. Useful for the web shell to surface
/// "engine v0.1.0" and to detect WASM-load success.
#[wasm_bindgen]
pub fn engine_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Main entry point — wraps an in-memory [`Graph`] and exposes the
/// engine's full public surface to JS.
///
/// Every method takes `&self`. Internal mutability lives in a
/// `RefCell<Graph>` so wasm-bindgen's `WasmRefCell` only ever does
/// `borrow()`, never `borrow_mut()`. That avoids the
/// "recursive use of an object detected" trap, which can fire when
/// wasm-bindgen's RefCell sees the cell as still borrowed (e.g. after
/// a previous `&mut self` call's guard was not perfectly released).
#[wasm_bindgen]
pub struct Engine {
    graph: RefCell<Graph>,
}

#[wasm_bindgen]
impl Engine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Engine {
        Engine {
            graph: RefCell::new(Graph::new()),
        }
    }

    /// Replace the in-memory graph with a server-supplied payload.
    /// `payload_json` is a JSON string of `GraphPayload`.
    #[wasm_bindgen(js_name = loadGraph)]
    pub fn load_graph(&self, payload_json: &str) -> Result<(), JsValue> {
        let payload: GraphPayload =
            serde_json::from_str(payload_json).map_err(map_err("invalid payload"))?;
        *self.graph.borrow_mut() = Graph::from_payload(payload);
        Ok(())
    }

    /// Returns the current graph as a JSON-stringified `GraphPayload`.
    #[wasm_bindgen(js_name = getGraph)]
    pub fn get_graph(&self) -> Result<String, JsValue> {
        to_json(&self.graph.borrow().to_payload())
    }

    /// Import a folder. `files_json` is a JSON array of `{ path, content }`.
    /// Returns a JSON-stringified `ImportResult`.
    #[wasm_bindgen(js_name = importFiles)]
    pub fn import_files(
        &self,
        project_name: &str,
        files_json: &str,
    ) -> Result<String, JsValue> {
        let files: Vec<FileBlob> =
            serde_json::from_str(files_json).map_err(map_err("invalid files"))?;
        let result: ImportResult = import_project(project_name, &files);
        *self.graph.borrow_mut() = Graph::from_payload(result.graph.clone());
        to_json(&result)
    }

    /// Apply a single `GraphMutation` (JSON-stringified). Returns the
    /// resulting `GraphEvent` array as a JSON string.
    #[wasm_bindgen(js_name = applyMutation)]
    pub fn apply_mutation(&self, mutation_json: &str) -> Result<String, JsValue> {
        let mutation: GraphMutation = serde_json::from_str(mutation_json).map_err(|e| {
            let snippet: String = mutation_json.chars().take(120).collect();
            JsValue::from_str(&format!(
                "invalid mutation ({e}); received {} bytes: {snippet:?}",
                mutation_json.len()
            ))
        })?;
        let events = apply_mutation(&mut self.graph.borrow_mut(), &mutation)
            .map_err(|e| JsValue::from_str(&format!("mutation error: {e}")))?;
        to_json(&events)
    }

    /// Apply a single LLM-flat `AgentGraphOp`. Same return shape as
    /// `applyMutation`.
    #[wasm_bindgen(js_name = applyAgentOp)]
    pub fn apply_agent_op(
        &self,
        project_id: &str,
        op_json: &str,
    ) -> Result<String, JsValue> {
        let op: AgentGraphOp =
            serde_json::from_str(op_json).map_err(map_err("invalid op"))?;
        let events = apply_agent_op(&mut self.graph.borrow_mut(), project_id, &op)
            .map_err(|e| JsValue::from_str(&format!("agent op error: {e}")))?;
        to_json(&events)
    }

    /// Walk the render tree starting from `root_id`. Returns a JSON
    /// string of `RenderTreeNode`, or the string `"null"` if the root
    /// doesn't exist.
    #[wasm_bindgen(js_name = walkRenderTree)]
    pub fn walk_render_tree(&self, root_id: &str) -> Result<String, JsValue> {
        let tree = walk_render_tree(&self.graph.borrow(), root_id);
        to_json(&tree)
    }

    /// Build the CSS string + element→class-name map for the preview.
    /// Returns a JSON string of `StylesheetResult`.
    #[wasm_bindgen(js_name = generateStylesheet)]
    pub fn generate_stylesheet(&self) -> Result<String, JsValue> {
        to_json(&generate_stylesheet(&self.graph.borrow()))
    }

    /// Build the semantic layer. Adds the returned nodes/edges into
    /// the graph in-place and also returns them for the UI to display.
    #[wasm_bindgen(js_name = buildSemanticLayer)]
    pub fn build_semantic_layer(&self, project_id: &str) -> Result<String, JsValue> {
        // Compute against a read borrow, then drop the read borrow
        // before taking the write borrow to insert the new nodes.
        let result = build_semantic_layer(&self.graph.borrow(), project_id);
        {
            let mut g = self.graph.borrow_mut();
            for n in &result.nodes {
                g.insert_node(n.clone());
            }
            for e in &result.edges {
                g.insert_edge(e.clone());
            }
        }
        to_json(&LayerWire {
            nodes: &result.nodes,
            edges: &result.edges,
        })
    }

    /// Build the UI layer. Requires the semantic layer to be present.
    #[wasm_bindgen(js_name = buildUiLayer)]
    pub fn build_ui_layer(&self, project_id: &str) -> Result<String, JsValue> {
        let result = build_ui_layer(&self.graph.borrow(), project_id);
        {
            let mut g = self.graph.borrow_mut();
            for n in &result.nodes {
                g.insert_node(n.clone());
            }
            for e in &result.edges {
                g.insert_edge(e.clone());
            }
        }
        to_json(&LayerWire {
            nodes: &result.nodes,
            edges: &result.edges,
        })
    }
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LayerWire<'a> {
    nodes: &'a [crate::graph::Node],
    edges: &'a [crate::graph::Edge],
}

fn to_json<T: Serialize>(value: &T) -> Result<String, JsValue> {
    serde_json::to_string(value).map_err(map_err("serialize"))
}

fn map_err(prefix: &'static str) -> impl Fn(serde_json::Error) -> JsValue {
    move |e| JsValue::from_str(&format!("{prefix}: {e}"))
}

// ─────────────────────────────────────────────────────────────────────────
// Mini runtime — the standalone toggle-app demo runtime exposed to JS so
// the React shell can render and interact with it. Wraps `mini_runtime`
// in a separate WASM class so it stays decoupled from the importer-driven
// `Engine` above.
// ─────────────────────────────────────────────────────────────────────────

#[wasm_bindgen]
pub struct MiniRuntime {
    inner: RefCell<mini_runtime::Runtime>,
}

#[wasm_bindgen]
impl MiniRuntime {
    /// Construct a runtime pre-loaded with the toggle-app graph. The
    /// fixture lives in `mini_runtime::toggle_app::build_toggle_app`.
    #[wasm_bindgen(constructor)]
    pub fn new() -> MiniRuntime {
        let graph = mini_runtime::toggle_app::build_toggle_app();
        MiniRuntime {
            inner: RefCell::new(mini_runtime::Runtime::new(graph)),
        }
    }

    /// Materialize a snapshot. `design_mode` controls whether semantic
    /// (Doc/Ui) nodes are included. Returns a JSON-stringified
    /// `RuntimeSnapshot`.
    #[wasm_bindgen]
    pub fn materialize(&self, design_mode: bool) -> Result<String, JsValue> {
        let snap = self.inner.borrow().materialize(design_mode);
        to_json(&snap)
    }

    /// Dispatch a UI event. Returns a JSON array of patches.
    #[wasm_bindgen(js_name = handleEvent)]
    pub fn handle_event(&self, element: &str, event: &str) -> Result<String, JsValue> {
        let patches = self.inner.borrow_mut().handle_event(element, event);
        to_json(&patches)
    }

    /// Cypher-like dump of the whole graph + live runtime state. Returns
    /// the dump as a plain string (not JSON).
    #[wasm_bindgen(js_name = cypherDump)]
    pub fn cypher_dump(&self) -> String {
        self.inner.borrow().cypher_dump()
    }
}

impl Default for MiniRuntime {
    fn default() -> Self {
        Self::new()
    }
}
