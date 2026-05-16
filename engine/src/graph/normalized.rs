//! Adjacency-indexed view of a Graph. Mirrors the `NormalizedGraph`
//! helper in `core/src/graphRuntime.ts`.

use super::edge::{Edge, EdgeKind};
use super::{Graph, Node};
use std::collections::HashMap;

/// Borrowed view of a graph with O(1) edge lookups by source/target.
pub struct NormalizedGraph<'a> {
    pub graph: &'a Graph,
    /// node_id -> edges where node is `from_node_id`
    out_edges: HashMap<&'a str, Vec<&'a Edge>>,
    /// node_id -> edges where node is `to_node_id`
    in_edges: HashMap<&'a str, Vec<&'a Edge>>,
}

impl<'a> NormalizedGraph<'a> {
    pub fn build(graph: &'a Graph) -> Self {
        let mut out_edges: HashMap<&'a str, Vec<&'a Edge>> = HashMap::new();
        let mut in_edges: HashMap<&'a str, Vec<&'a Edge>> = HashMap::new();
        for edge in graph.edges.values() {
            out_edges
                .entry(edge.from_node_id.as_str())
                .or_default()
                .push(edge);
            in_edges
                .entry(edge.to_node_id.as_str())
                .or_default()
                .push(edge);
        }
        // Stable order: by edge.order if present, else insertion.
        for v in out_edges.values_mut() {
            v.sort_by(|a, b| match (a.order, b.order) {
                (Some(x), Some(y)) => x.cmp(&y),
                (Some(_), None) => std::cmp::Ordering::Less,
                (None, Some(_)) => std::cmp::Ordering::Greater,
                (None, None) => std::cmp::Ordering::Equal,
            });
        }
        Self {
            graph,
            out_edges,
            in_edges,
        }
    }

    pub fn node(&self, id: &str) -> Option<&'a Node> {
        self.graph.nodes.get(id)
    }

    pub fn out_edges(&self, node_id: &str) -> impl Iterator<Item = &&'a Edge> {
        self.out_edges
            .get(node_id)
            .map(|v| v.iter())
            .unwrap_or([].iter())
    }

    pub fn in_edges(&self, node_id: &str) -> impl Iterator<Item = &&'a Edge> {
        self.in_edges
            .get(node_id)
            .map(|v| v.iter())
            .unwrap_or([].iter())
    }

    pub fn out_by(&self, node_id: &str, kind: EdgeKind) -> Vec<&'a Edge> {
        self.out_edges(node_id)
            .filter(|e| e.kind == kind)
            .copied()
            .collect()
    }

    pub fn first_out_by(&self, node_id: &str, kind: EdgeKind) -> Option<&'a Edge> {
        self.out_edges(node_id).find(|e| e.kind == kind).copied()
    }

    pub fn in_by(&self, node_id: &str, kind: EdgeKind) -> Vec<&'a Edge> {
        self.in_edges(node_id)
            .filter(|e| e.kind == kind)
            .copied()
            .collect()
    }

    pub fn children_via(&self, node_id: &str, kind: EdgeKind) -> Vec<&'a Node> {
        self.out_by(node_id, kind)
            .into_iter()
            .filter_map(|e| self.node(&e.to_node_id))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::kinds::NodeKind;
    use crate::graph::node::Node;

    #[test]
    fn out_by_returns_ordered_edges() {
        let mut g = Graph::new();
        g.insert_node(Node::new("a", NodeKind::Component, "App"));
        g.insert_node(Node::new("b", NodeKind::Element, "div"));
        g.insert_node(Node::new("c", NodeKind::Element, "span"));
        g.insert_edge(Edge::new("e1", "a", "b", EdgeKind::Renders).with_order(2));
        g.insert_edge(Edge::new("e2", "a", "c", EdgeKind::Renders).with_order(1));

        let n = g.normalized();
        let out = n.out_by("a", EdgeKind::Renders);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].to_node_id, "c", "lower order comes first");
        assert_eq!(out[1].to_node_id, "b");
    }
}
