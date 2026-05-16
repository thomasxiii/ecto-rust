//! Materialized runtime snapshot — what a renderer needs to draw the UI.
//!
//! Hosts (React preview, iOS, etc) consume the snapshot once to do an
//! initial render, then apply incremental `Patch` lists thereafter.

use std::collections::BTreeMap;

use serde::Serialize;

use crate::graph::{NodeId, NodeKind};
use crate::value::Value;

/// The render tree is a recursive Component → Element → (Component | Element)
/// projection of the graph following `Renders` and `Contains` edges.
///
/// Text and attributes are *materialized* — atom/derived references in
/// `NodeData::Element { text }` are resolved to the current `plain_text()`
/// representation here so the host renderer can just splat strings into
/// the DOM.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderNode {
    pub id: NodeId,
    pub name: String,
    pub kind: NodeKind,
    /// Element tag (only when `kind == Element`).
    pub tag: Option<String>,
    /// Resolved text content (for `<button>Click me</button>`-style or
    /// `<span>{count}</span>`-style elements). Inputs use this as their
    /// bound `value` attribute on the React side.
    pub text: Option<String>,
    /// Extra DOM attributes (placeholder, type, etc) carried over from
    /// the graph node's `attrs` map, with `Value`s rendered as plain text.
    pub attrs: BTreeMap<String, String>,
    pub children: Vec<RenderNode>,
    /// Doc/Ui pointers attached when materialized in design mode.
    pub semantic: Option<SemanticAnnotation>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SemanticAnnotation {
    pub doc: Option<NodeId>,
    pub ui: Option<NodeId>,
}

/// A live event binding — the cause node attached to a (element, event) pair.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventBinding {
    pub element: NodeId,
    pub event: String,
    pub cause: NodeId,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSnapshot {
    pub design_mode: bool,
    pub render_tree: RenderNode,
    /// element_id → property → resolved literal value.
    pub styles: BTreeMap<NodeId, BTreeMap<String, Value>>,
    pub atoms: BTreeMap<NodeId, Value>,
    pub derived: BTreeMap<NodeId, Value>,
    pub bindings: Vec<EventBinding>,
    /// Only populated when `design_mode == true`. Maps component_id → doc/ui ids.
    pub semantic_nodes: BTreeMap<NodeId, SemanticAnnotation>,
}
