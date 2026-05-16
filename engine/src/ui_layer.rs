//! UI layer builder.
//!
//! Ports `core/src/uiLayer.ts`. v1 scope:
//! - emit `ui_selectable` for every `semantic_component` and important
//!   `semantic_element`
//! - emit `ui_style_surface` for selectables whose semantic node has
//!   `styleable` capability
//! - wire `represented_by` (semantic → ui_selectable) and `controlled_by`
//!   (ui_selectable → ui_style_surface)
//!
//! Deferred: ui_layout_surface, ui_interaction_surface, ui_variant_surface
//! and the live `getControlsForSelection` re-inference pass.

use crate::graph::edge::{Edge, EdgeKind};
use crate::graph::kinds::NodeKind;
use crate::graph::node::Node;
use crate::graph::Graph;
use serde_json::json;

pub struct UiLayerResult {
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
}

pub fn build_ui_layer(graph: &Graph, _project_id: &str) -> UiLayerResult {
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut counter: u64 = 0;
    let mut ui_id = |kind: &str, ctr: &mut u64| {
        *ctr += 1;
        format!("ui_{kind}_{}", *ctr)
    };

    for sem in graph.iter_nodes().filter(|n| {
        matches!(
            n.kind,
            NodeKind::SemanticComponent | NodeKind::SemanticElement
        )
    }) {
        let caps = sem
            .data
            .get("capabilities")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let has = |c: &str| {
            caps.iter()
                .any(|v| v.as_str().map(|s| s == c).unwrap_or(false))
        };
        let sel_id = ui_id("selectable", &mut counter);
        let icon = match sem.kind {
            NodeKind::SemanticComponent => "component",
            _ => "element",
        };
        let selectable = Node::new(&sel_id, NodeKind::UiSelectable, &sem.name).with_data(json!({
            "layer": "ui",
            "targetSemanticNodeId": sem.id,
            "icon": icon,
            "typeHint": sem.name,
            "capabilities": ["selectable"],
        }));
        edges.push(Edge::new(
            format!("edge_{}_{}_represented_by", sem.id, sel_id),
            &sem.id,
            &sel_id,
            EdgeKind::RepresentedBy,
        ));
        nodes.push(selectable);

        if has("styleable") {
            let surface_id = ui_id("style", &mut counter);
            let surface = Node::new(&surface_id, NodeKind::UiStyleSurface, &sem.name).with_data(
                json!({
                    "layer": "ui",
                    "targetSemanticNodeId": sem.id,
                    "controls": [],
                    "affectedMechanicalNodeIds": [],
                }),
            );
            edges.push(Edge::new(
                format!("edge_{}_{}_controlled_by", sel_id, surface_id),
                &sel_id,
                &surface_id,
                EdgeKind::ControlledBy,
            ));
            edges.push(Edge::new(
                format!("edge_{}_{}_controls", surface_id, sem.id),
                &surface_id,
                &sem.id,
                EdgeKind::Controls,
            ));
            nodes.push(surface);
        }
    }

    UiLayerResult { nodes, edges }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::node::Node;
    use serde_json::json;

    #[test]
    fn emits_selectable_per_semantic_component() {
        let mut g = Graph::new();
        g.insert_node(
            Node::new("s1", NodeKind::SemanticComponent, "App")
                .with_data(json!({"layer": "semantic", "capabilities": ["selectable", "styleable"]})),
        );
        let res = build_ui_layer(&g, "p");
        assert_eq!(
            res.nodes.iter().filter(|n| n.kind == NodeKind::UiSelectable).count(),
            1
        );
        assert_eq!(
            res.nodes.iter().filter(|n| n.kind == NodeKind::UiStyleSurface).count(),
            1,
            "styleable cap → style surface"
        );
    }
}
