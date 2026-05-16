//! Ecto graph engine — Rust core for the codebase-as-graph runtime.
//!
//! Compiles to:
//! - `wasm32-unknown-unknown` for the browser (via wasm-bindgen)
//! - `aarch64-apple-ios` static lib for the iOS host (via cbindgen)
//! - native `rlib` for tests
//!
//! Public surface lives in [`Engine`]; internal modules under `graph`,
//! `mutations`, `importer`, `semantic`, `ui`, `render`.

pub mod graph;
pub mod importer;
pub mod mutations;
pub mod render;
pub mod semantic;
pub mod ui_layer;

#[cfg(not(target_arch = "wasm32"))]
pub mod ffi;

mod stable_id;

pub use graph::{
    AgentGraphOp, Capability, ControlDefinition, Edge, EdgeKind, Graph, GraphEvent, GraphPayload,
    Layer, Node, NodeKind, NormalizedGraph, Project, Provenance,
};
pub use mutations::{apply_agent_op, apply_mutation, GraphMutation, MutationError};
pub use render::{
    generate_stylesheet, walk_render_tree, RenderTreeKind, RenderTreeNode, StyleDeclaration,
    StylesheetResult,
};
pub use semantic::{build_semantic_layer, SemanticLayerResult};
pub use ui_layer::{build_ui_layer, UiLayerResult};

#[cfg(target_arch = "wasm32")]
pub mod wasm;
