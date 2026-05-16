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
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderNode {
    pub id: NodeId,
    pub name: String,
    pub kind: NodeKind,
    /// Element tag, only set when `kind == Element`.
    pub tag: Option<String>,
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
