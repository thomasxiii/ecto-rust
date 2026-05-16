//! Graph model — ports `shared/src/index.ts` from ecto-engine.
//!
//! Wire format is preserved exactly (serde rename_all = snake_case on
//! the kind enums) so the existing TS server can talk to a Rust client
//! and vice versa without translation.

pub mod edge;
pub mod kinds;
pub mod node;
pub mod normalized;
pub mod types;

pub use edge::{Edge, EdgeKind};
pub use kinds::{Capability, Layer, NodeKind};
pub use node::{Node, SourceMap};
pub use normalized::NormalizedGraph;
pub use types::{
    AgentGraphOp, ControlDefinition, ControlKind, GraphEvent, GraphPayload, ImportRequest,
    ImportResponse, InteractionStep, ModelOption, ModelProviderId, Project, Provenance,
    ProvenanceEvidence, TimelineEntry,
};

use serde::{Deserialize, Serialize};

/// In-memory graph used by the engine. Nodes and edges are stored as
/// insertion-ordered IndexMaps for deterministic iteration; the
/// `NormalizedGraph` view wraps this with adjacency indices for fast
/// traversal.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct Graph {
    #[serde(default)]
    pub nodes: indexmap::IndexMap<String, Node>,
    #[serde(default)]
    pub edges: indexmap::IndexMap<String, Edge>,
}

impl Graph {
    pub fn new() -> Self {
        Self::default()
    }

    /// Build from the wire-format `{ nodes: [], edges: [] }` payload.
    pub fn from_payload(payload: GraphPayload) -> Self {
        let mut g = Graph::new();
        for node in payload.nodes {
            g.nodes.insert(node.id.clone(), node);
        }
        for edge in payload.edges {
            g.edges.insert(edge.id.clone(), edge);
        }
        g
    }

    /// Serialize back to the wire payload shape.
    pub fn to_payload(&self) -> GraphPayload {
        GraphPayload {
            nodes: self.nodes.values().cloned().collect(),
            edges: self.edges.values().cloned().collect(),
        }
    }

    pub fn node(&self, id: &str) -> Option<&Node> {
        self.nodes.get(id)
    }

    pub fn node_mut(&mut self, id: &str) -> Option<&mut Node> {
        self.nodes.get_mut(id)
    }

    pub fn edge(&self, id: &str) -> Option<&Edge> {
        self.edges.get(id)
    }

    pub fn insert_node(&mut self, node: Node) {
        self.nodes.insert(node.id.clone(), node);
    }

    pub fn insert_edge(&mut self, edge: Edge) {
        self.edges.insert(edge.id.clone(), edge);
    }

    pub fn remove_node(&mut self, id: &str) -> Option<Node> {
        // Remove all edges touching this node first.
        let touching: Vec<String> = self
            .edges
            .values()
            .filter(|e| e.from_node_id == id || e.to_node_id == id)
            .map(|e| e.id.clone())
            .collect();
        for eid in touching {
            self.edges.shift_remove(&eid);
        }
        self.nodes.shift_remove(id)
    }

    pub fn remove_edge(&mut self, id: &str) -> Option<Edge> {
        self.edges.shift_remove(id)
    }

    pub fn iter_nodes(&self) -> impl Iterator<Item = &Node> {
        self.nodes.values()
    }

    pub fn iter_edges(&self) -> impl Iterator<Item = &Edge> {
        self.edges.values()
    }

    pub fn normalized(&self) -> NormalizedGraph<'_> {
        NormalizedGraph::build(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::edge::EdgeKind;
    use crate::graph::kinds::NodeKind;
    use crate::graph::node::Node;
    use serde_json::json;

    #[test]
    fn round_trip_payload() {
        let mut g = Graph::new();
        g.insert_node(Node::new("n1", NodeKind::Component, "App").with_data(json!({"foo": 1})));
        g.insert_node(Node::new("n2", NodeKind::Element, "div"));
        g.insert_edge(Edge::new("e1", "n1", "n2", EdgeKind::Renders));

        let payload = g.to_payload();
        let json = serde_json::to_string(&payload).unwrap();
        let back: GraphPayload = serde_json::from_str(&json).unwrap();
        let g2 = Graph::from_payload(back);
        assert_eq!(g.nodes.len(), g2.nodes.len());
        assert_eq!(g.edges.len(), g2.edges.len());
        assert_eq!(g2.node("n1").unwrap().kind, NodeKind::Component);
    }

    #[test]
    fn removing_node_cascades_edges() {
        let mut g = Graph::new();
        g.insert_node(Node::new("n1", NodeKind::Component, "App"));
        g.insert_node(Node::new("n2", NodeKind::Element, "div"));
        g.insert_edge(Edge::new("e1", "n1", "n2", EdgeKind::Renders));
        assert_eq!(g.edges.len(), 1);
        g.remove_node("n1");
        assert!(g.node("n1").is_none());
        assert_eq!(g.edges.len(), 0, "edges touching removed node are dropped");
    }
}
