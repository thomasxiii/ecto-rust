//! Typed graph.
//!
//! Nodes carry a `kind` tag *and* a `data` payload — the tag enables fast
//! kind-based queries (e.g. "find all stylesheets that USE this derived")
//! while the payload holds kind-specific information. The two are kept in
//! sync at construction time.
//!
//! Edges are typed (`EdgeKind`) and directed. Most graph queries walk by
//! edge kind: incoming/outgoing edges of a given kind from a node.

use std::collections::{BTreeMap, HashMap};

use serde::Serialize;

use crate::runtime::{DerivedKind, EffectKind};
use crate::value::Value;

pub type NodeId = String;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum NodeKind {
    Component,
    Element,
    Atom,
    Token,
    Derived,
    StyleSheet,
    Cause,
    Effect,
    Doc,
    Ui,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EdgeKind {
    /// Component → Element (the component's rendered root element).
    Renders,
    /// Element → Element|Component (children inside an element).
    Contains,
    /// Component → Cause (this component owns the interaction).
    HasCause,
    /// Cause → Effect (firing the cause runs the effect).
    Triggers,
    /// Effect → Atom, Derived → Atom, Derived → Derived (reactive read).
    Reads,
    /// Effect → Atom (mutates the atom).
    Writes,
    /// Derived → Token, StyleSheet → Token|Derived (value reference).
    Uses,
    /// StyleSheet → Element (the stylesheet applies to this element).
    Targets,
    /// Component → Doc (semantic / authored documentation, design mode only).
    HasDoc,
    /// Component → Ui (editor metadata, design mode only).
    HasUi,
}

impl NodeKind {
    /// Design-mode-only kinds are excluded from the runtime snapshot when
    /// `design_mode=false`. Render-tree-relevant kinds (Component, Element)
    /// are always included; everything else is metadata.
    pub fn is_design_only(self) -> bool {
        matches!(self, NodeKind::Doc | NodeKind::Ui)
    }
}

#[derive(Debug, Clone)]
pub enum NodeData {
    Component,
    Element {
        /// HTML-ish tag name, used by the renderer.
        tag: String,
    },
    Atom {
        value: Value,
    },
    Token {
        value: Value,
    },
    Derived {
        kind: DerivedKind,
    },
    StyleSheet {
        /// element_id → property → style value reference or literal.
        rules: BTreeMap<NodeId, BTreeMap<String, StyleValue>>,
    },
    Cause {
        /// Element that emits the event.
        source: NodeId,
        /// e.g. "click".
        event: String,
    },
    Effect {
        kind: EffectKind,
    },
    Doc {
        text: String,
    },
    Ui {
        meta: BTreeMap<String, Value>,
    },
}

impl NodeData {
    pub fn kind(&self) -> NodeKind {
        match self {
            NodeData::Component => NodeKind::Component,
            NodeData::Element { .. } => NodeKind::Element,
            NodeData::Atom { .. } => NodeKind::Atom,
            NodeData::Token { .. } => NodeKind::Token,
            NodeData::Derived { .. } => NodeKind::Derived,
            NodeData::StyleSheet { .. } => NodeKind::StyleSheet,
            NodeData::Cause { .. } => NodeKind::Cause,
            NodeData::Effect { .. } => NodeKind::Effect,
            NodeData::Doc { .. } => NodeKind::Doc,
            NodeData::Ui { .. } => NodeKind::Ui,
        }
    }
}

/// A style property value can be a literal or a reference to a Token / Derived
/// node. References are resolved during style materialization.
#[derive(Debug, Clone, PartialEq)]
pub enum StyleValue {
    Literal(Value),
    Ref(NodeId),
}

#[derive(Debug, Clone)]
pub struct Node {
    pub id: NodeId,
    pub name: String,
    pub data: NodeData,
}

impl Node {
    pub fn new(id: impl Into<NodeId>, name: impl Into<String>, data: NodeData) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            data,
        }
    }

    pub fn kind(&self) -> NodeKind {
        self.data.kind()
    }
}

#[derive(Debug, Clone)]
pub struct Edge {
    pub from: NodeId,
    pub to: NodeId,
    pub kind: EdgeKind,
}

impl Edge {
    pub fn new(from: impl Into<NodeId>, to: impl Into<NodeId>, kind: EdgeKind) -> Self {
        Self {
            from: from.into(),
            to: to.into(),
            kind,
        }
    }
}

/// Graph storage. Nodes are keyed by id; edges are stored as a flat vector
/// for ordered iteration (deterministic patches) plus auxiliary adjacency
/// indices keyed by `(node, edge_kind)` for O(1) typed lookups.
#[derive(Debug, Default, Clone)]
pub struct Graph {
    nodes: HashMap<NodeId, Node>,
    edges: Vec<Edge>,
    out_index: HashMap<(NodeId, EdgeKind), Vec<usize>>,
    in_index: HashMap<(NodeId, EdgeKind), Vec<usize>>,
}

impl Graph {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add_node(&mut self, node: Node) {
        self.nodes.insert(node.id.clone(), node);
    }

    pub fn add_edge(&mut self, edge: Edge) {
        let idx = self.edges.len();
        self.out_index
            .entry((edge.from.clone(), edge.kind))
            .or_default()
            .push(idx);
        self.in_index
            .entry((edge.to.clone(), edge.kind))
            .or_default()
            .push(idx);
        self.edges.push(edge);
    }

    pub fn node(&self, id: &str) -> Option<&Node> {
        self.nodes.get(id)
    }

    pub fn node_mut(&mut self, id: &str) -> Option<&mut Node> {
        self.nodes.get_mut(id)
    }

    pub fn nodes(&self) -> impl Iterator<Item = &Node> {
        self.nodes.values()
    }

    pub fn edges(&self) -> &[Edge] {
        &self.edges
    }

    /// All outgoing edges of a given kind, in insertion order.
    pub fn outgoing(&self, from: &str, kind: EdgeKind) -> Vec<&Edge> {
        self.out_index
            .get(&(from.to_string(), kind))
            .map(|ixs| ixs.iter().map(|&i| &self.edges[i]).collect())
            .unwrap_or_default()
    }

    /// All incoming edges of a given kind, in insertion order.
    pub fn incoming(&self, to: &str, kind: EdgeKind) -> Vec<&Edge> {
        self.in_index
            .get(&(to.to_string(), kind))
            .map(|ixs| ixs.iter().map(|&i| &self.edges[i]).collect())
            .unwrap_or_default()
    }

    /// Convenience: the target ids of all `from -[kind]->` edges.
    pub fn outgoing_targets(&self, from: &str, kind: EdgeKind) -> Vec<NodeId> {
        self.outgoing(from, kind)
            .into_iter()
            .map(|e| e.to.clone())
            .collect()
    }

    /// Convenience: the source ids of all `-[kind]-> to` edges.
    pub fn incoming_sources(&self, to: &str, kind: EdgeKind) -> Vec<NodeId> {
        self.incoming(to, kind)
            .into_iter()
            .map(|e| e.from.clone())
            .collect()
    }

    /// Nodes that depend on `node_id` — for an atom, this returns the
    /// derived nodes that READ it (and is the entry point for propagation).
    pub fn readers(&self, node_id: &str) -> Vec<NodeId> {
        self.incoming_sources(node_id, EdgeKind::Reads)
    }

    /// Stylesheets that USE the given token or derived node.
    pub fn users(&self, node_id: &str) -> Vec<NodeId> {
        self.incoming_sources(node_id, EdgeKind::Uses)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outgoing_and_incoming_queries_work() {
        let mut g = Graph::new();
        g.add_node(Node::new("a", "A", NodeData::Component));
        g.add_node(Node::new(
            "b",
            "B",
            NodeData::Element {
                tag: "div".into(),
            },
        ));
        g.add_edge(Edge::new("a", "b", EdgeKind::Renders));

        assert_eq!(g.outgoing_targets("a", EdgeKind::Renders), vec!["b"]);
        assert_eq!(g.incoming_sources("b", EdgeKind::Renders), vec!["a"]);
        assert!(g.outgoing_targets("a", EdgeKind::Contains).is_empty());
    }
}
