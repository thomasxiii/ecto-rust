//! Semantic layer builder.
//!
//! Ports `core/src/semanticLayer.ts`. v1 scope:
//! - emit `semantic_component` for every mechanical `component`
//! - emit `semantic_element` for important elements (has events, styles,
//!   or interactive tag)
//! - emit `semantic_state` for every `state` node
//! - emit `semantic_style` for every style node with declarations
//! - wire `contributes_to` edges back to the mechanical originators
//!
//! Deferred: semantic_interaction grouping, semantic_flow detection,
//! deep evidence chains, AI-augmented inference (these can be added
//! without changing the public shape).

use crate::graph::edge::{Edge, EdgeKind};
use crate::graph::kinds::NodeKind;
use crate::graph::node::Node;
use crate::graph::Graph;
use serde_json::json;

pub struct SemanticLayerResult {
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
}

pub fn build_semantic_layer(graph: &Graph, _project_id: &str) -> SemanticLayerResult {
    let normalized = graph.normalized();
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut counter: u64 = 0;
    let mut sem_id = |kind: &str, ctr: &mut u64| {
        *ctr += 1;
        format!("sem_{kind}_{}", *ctr)
    };

    // 1. semantic_component for every component
    for node in graph.iter_nodes().filter(|n| n.kind == NodeKind::Component) {
        let id = sem_id("component", &mut counter);
        let render_count = normalized.out_by(&node.id, EdgeKind::Renders).len();
        let state_count = normalized.out_by(&node.id, EdgeKind::Declares).len();
        let mut capabilities = vec!["selectable", "promptable"];
        if state_count > 0 {
            capabilities.push("stateProducer");
            capabilities.push("variantable");
        }
        if render_count > 0 {
            capabilities.push("styleable");
            capabilities.push("layoutable");
        }
        let sem = Node::new(&id, NodeKind::SemanticComponent, &node.name).with_data(json!({
            "layer": "semantic",
            "mechanicalComponentId": node.id,
            "displayName": node.name,
            "renderCount": render_count,
            "stateCount": state_count,
            "capabilities": capabilities,
            "provenance": {
                "createdBy": "heuristic",
                "derivedFrom": [node.id],
                "confidence": 0.95,
                "evidence": [{
                    "nodeId": node.id,
                    "reason": format!("Component declaration \"{}\"", node.name),
                    "confidence": 0.95,
                }],
            },
        }));
        edges.push(Edge::new(
            format!("edge_{}_{}_contributes_to", node.id, id),
            &node.id,
            &id,
            EdgeKind::ContributesTo,
        ));
        nodes.push(sem);
    }

    // 2. semantic_element for important elements (interactive tag, events,
    //    or styled)
    for node in graph.iter_nodes().filter(|n| n.kind == NodeKind::Element) {
        let has_events = !normalized.out_by(&node.id, EdgeKind::Triggers).is_empty();
        let has_styles = !normalized.out_by(&node.id, EdgeKind::Styles).is_empty();
        let tag = node.data.get("tagName").and_then(|v| v.as_str()).unwrap_or("");
        let is_interactive = matches!(
            tag,
            "button" | "a" | "input" | "select" | "textarea" | "form" | "label"
        );
        if !(has_events || has_styles || is_interactive) {
            continue;
        }
        let id = sem_id("element", &mut counter);
        let mut capabilities = vec!["selectable"];
        if has_styles {
            capabilities.push("styleable");
        }
        if has_events {
            capabilities.push("eventSource");
            capabilities.push("interactionEditable");
        }
        let sem = Node::new(&id, NodeKind::SemanticElement, tag).with_data(json!({
            "layer": "semantic",
            "mechanicalElementId": node.id,
            "tagName": tag,
            "capabilities": capabilities,
            "provenance": {
                "createdBy": "heuristic",
                "derivedFrom": [node.id],
                "confidence": 0.7,
            },
        }));
        edges.push(Edge::new(
            format!("edge_{}_{}_contributes_to", node.id, id),
            &node.id,
            &id,
            EdgeKind::ContributesTo,
        ));
        nodes.push(sem);
    }

    // 3. semantic_state for every state node
    for node in graph.iter_nodes().filter(|n| n.kind == NodeKind::State) {
        let id = sem_id("state", &mut counter);
        let sem = Node::new(&id, NodeKind::SemanticState, &node.name).with_data(json!({
            "layer": "semantic",
            "mechanicalStateId": node.id,
            "stateName": node.name,
            "capabilities": ["stateProducer", "stateConsumer", "variantable"],
            "provenance": {
                "createdBy": "heuristic",
                "derivedFrom": [node.id],
                "confidence": 0.9,
            },
        }));
        edges.push(Edge::new(
            format!("edge_{}_{}_contributes_to", node.id, id),
            &node.id,
            &id,
            EdgeKind::ContributesTo,
        ));
        nodes.push(sem);
    }

    // 4. semantic_style for every style node that has declarations
    for node in graph.iter_nodes().filter(|n| n.kind == NodeKind::Style) {
        let Some(rules) = node.data.get("rules").and_then(|v| v.as_array()) else {
            continue;
        };
        if rules.is_empty() {
            continue;
        }
        let id = sem_id("style", &mut counter);
        let class_name = node
            .data
            .get("className")
            .and_then(|v| v.as_str())
            .unwrap_or(&node.name);
        let sem = Node::new(&id, NodeKind::SemanticStyle, class_name).with_data(json!({
            "layer": "semantic",
            "mechanicalStyleId": node.id,
            "className": class_name,
            "capabilities": ["styleable", "patchable"],
            "provenance": {
                "createdBy": "heuristic",
                "derivedFrom": [node.id],
                "confidence": 0.85,
            },
        }));
        edges.push(Edge::new(
            format!("edge_{}_{}_contributes_to", node.id, id),
            &node.id,
            &id,
            EdgeKind::ContributesTo,
        ));
        nodes.push(sem);
    }

    SemanticLayerResult { nodes, edges }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::edge::Edge;
    use crate::graph::node::Node;

    #[test]
    fn emits_semantic_component_per_component() {
        let mut g = Graph::new();
        g.insert_node(Node::new("c1", NodeKind::Component, "App"));
        g.insert_node(Node::new("c2", NodeKind::Component, "Button"));
        let res = build_semantic_layer(&g, "p");
        let comps: Vec<_> = res
            .nodes
            .iter()
            .filter(|n| n.kind == NodeKind::SemanticComponent)
            .collect();
        assert_eq!(comps.len(), 2);
    }

    #[test]
    fn emits_semantic_element_only_when_important() {
        let mut g = Graph::new();
        g.insert_node(Node::new("e1", NodeKind::Element, "div").with_data(json!({"tagName": "div"})));
        g.insert_node(
            Node::new("e2", NodeKind::Element, "button")
                .with_data(json!({"tagName": "button"})),
        );
        let res = build_semantic_layer(&g, "p");
        let semes: Vec<_> = res
            .nodes
            .iter()
            .filter(|n| n.kind == NodeKind::SemanticElement)
            .collect();
        // Only `button` is interactive — `div` without events/styles is dropped.
        assert_eq!(semes.len(), 1);
        assert_eq!(semes[0].name, "button");
    }
}
