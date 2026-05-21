//! Render-tree patches.
//!
//! Studio edits today force the host to re-walk the entire render tree
//! and regenerate the stylesheet, which churns React state and resets
//! the runtime. Most mutations only invalidate a narrow slice — a
//! `Style` data edit, for example, leaves the tree shape untouched and
//! only requires a stylesheet refresh.
//!
//! `compute_patches` inspects a mutation and emits the smallest set of
//! `RenderPatch`es the host needs to apply. When we can't yet narrow a
//! given mutation, we emit `Full` to fall back to a complete walk —
//! always correct, just expensive.

use crate::graph::kinds::NodeKind;
use crate::graph::Graph;
use crate::mutations::GraphMutation;
use crate::render::stylesheet::{generate_stylesheet, StylesheetResult};
use serde::{Deserialize, Serialize};

/// One unit of incremental update the host should apply.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RenderPatch {
    /// The render tree is unchanged; only the generated stylesheet has
    /// new values. Host should swap in `css` and `classesByElement`
    /// without re-walking the tree or replacing the tree object ref.
    StylesheetReplaced {
        css: String,
        #[serde(rename = "classesByElement")]
        classes_by_element: std::collections::HashMap<String, Vec<String>>,
    },
    /// Catch-all: this mutation may have changed tree shape or node
    /// props. Host should re-walk the tree and regenerate the
    /// stylesheet from scratch. Always correct.
    Full,
}

impl From<StylesheetResult> for RenderPatch {
    fn from(s: StylesheetResult) -> Self {
        RenderPatch::StylesheetReplaced {
            css: s.css,
            classes_by_element: s.classes_by_element,
        }
    }
}

/// Classify a mutation and emit the narrowest patch list possible.
/// The graph is read AFTER the mutation has been applied — callers
/// should run `apply_mutation` first.
pub fn compute_patches(graph: &Graph, mutation: &GraphMutation) -> Vec<RenderPatch> {
    match mutation {
        GraphMutation::UpdateNodeData { node_id, .. } => {
            let Some(node) = graph.node(node_id) else {
                return vec![RenderPatch::Full];
            };
            match node.kind {
                NodeKind::Style => vec![generate_stylesheet(graph).into()],
                _ => vec![RenderPatch::Full],
            }
        }
        _ => vec![RenderPatch::Full],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::edge::{Edge, EdgeKind};
    use crate::graph::node::Node;
    use crate::mutations::apply_mutation;
    use serde_json::json;

    fn seeded_with_style() -> Graph {
        let mut g = Graph::new();
        g.insert_node(Node::new("c1", NodeKind::Component, "App"));
        g.insert_node(
            Node::new("e1", NodeKind::Element, "div").with_data(json!({"tagName": "div"})),
        );
        g.insert_node(Node::new("s1", NodeKind::Style, "btn").with_data(json!({
            "kind": "class",
            "className": "btn",
            "synthesizedId": "btn_abc",
            "rules": [{ "selector": ".btn", "declarations": { "color": "red" } }],
        })));
        g.insert_edge(Edge::new("r1", "c1", "e1", EdgeKind::Renders));
        g.insert_edge(Edge::new("st1", "e1", "s1", EdgeKind::Styles));
        g
    }

    #[test]
    fn style_data_update_narrows_to_stylesheet_replaced() {
        let mut g = seeded_with_style();
        let m = GraphMutation::UpdateNodeData {
            project_id: "p".into(),
            node_id: "s1".into(),
            patch: json!({"rules": [{"selector": ".btn", "declarations": {"color": "blue"}}]}),
        };
        apply_mutation(&mut g, &m).unwrap();
        let patches = compute_patches(&g, &m);
        assert_eq!(patches.len(), 1);
        match &patches[0] {
            RenderPatch::StylesheetReplaced { css, .. } => {
                assert!(css.contains("blue"), "css should reflect new value: {css}");
            }
            other => panic!("expected StylesheetReplaced, got {other:?}"),
        }
    }

    #[test]
    fn non_style_data_update_falls_back_to_full() {
        let mut g = seeded_with_style();
        let m = GraphMutation::UpdateNodeData {
            project_id: "p".into(),
            node_id: "e1".into(),
            patch: json!({"tagName": "section"}),
        };
        apply_mutation(&mut g, &m).unwrap();
        let patches = compute_patches(&g, &m);
        assert_eq!(patches.len(), 1);
        assert!(matches!(patches[0], RenderPatch::Full));
    }

    #[test]
    fn add_node_falls_back_to_full() {
        let g = Graph::new();
        let m = GraphMutation::AddNode {
            project_id: "p".into(),
            node: Node::new("new", NodeKind::Element, "div"),
        };
        let patches = compute_patches(&g, &m);
        assert!(matches!(patches[0], RenderPatch::Full));
    }
}
