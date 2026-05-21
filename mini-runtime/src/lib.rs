//! Ecto mini-runtime — a self-contained reactive UI runtime built around a
//! typed graph as the single source of truth.
//!
//! The model:
//!   * Components, Elements, Atoms, Tokens, Derived values, StyleSheets,
//!     Causes, Effects, Docs, and Ui nodes are all nodes in one graph,
//!     connected by typed edges (Renders, Contains, Reads, Writes, Uses,
//!     Targets, HasCause, Triggers, HasDoc, HasUi).
//!   * Atoms hold mutable state. When an atom changes, Derived nodes that
//!     READ it are recomputed; StyleSheets that USE the changed values are
//!     re-materialized. The runtime emits a flat list of Patches describing
//!     exactly what changed.
//!   * `materialize(design_mode)` walks the graph and produces a
//!     `RuntimeSnapshot` (render tree + resolved styles + atom/derived
//!     values + event bindings). In design mode, Doc/Ui nodes are
//!     included so an editor can introspect.
//!
//! See `examples/toggle.rs` for a full light/dark toggle demo.

pub mod cypher;
pub mod graph;
pub mod patch;
pub mod runtime;
pub mod snapshot;
pub mod toggle_app;
pub mod value;

pub use graph::{
    Edge, EdgeKind, FilterCompare, Graph, Node, NodeData, NodeId, NodeKind, RepeatFilter,
    StylePart, StyleValue, TextSource, VisibilityRule,
};
pub use patch::Patch;
pub use runtime::{DerivedKind, EffectKind, RecordField, Runtime};
pub use snapshot::{EventBinding, RenderNode, RuntimeSnapshot, SemanticAnnotation};
pub use value::Value;
