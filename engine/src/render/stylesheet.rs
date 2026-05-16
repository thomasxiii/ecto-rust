//! Stylesheet generator.
//!
//! Walks all `style` nodes in the graph, rewrites CSS-module class
//! selectors to their `synthesizedId`, emits global rules verbatim, and
//! produces a single CSS string + `{element_id → class_names[]}` map
//! that the runtime injects into the preview iframe.

use crate::graph::edge::EdgeKind;
use crate::graph::kinds::NodeKind;
use crate::graph::Graph;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fmt::Write;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StylesheetResult {
    /// One concatenated CSS string the runtime injects into the preview.
    pub css: String,
    /// element_id → list of synthesized class names to apply.
    pub classes_by_element: HashMap<String, Vec<String>>,
}

pub fn generate_stylesheet(graph: &Graph) -> StylesheetResult {
    let normalized = graph.normalized();
    let mut css = String::new();
    let mut classes_by_element: HashMap<String, Vec<String>> = HashMap::new();

    // Index style nodes by id and capture synthesized class names.
    let mut style_synth_class: HashMap<String, String> = HashMap::new();

    // ── 1. emit class rules + collect synth class lookup ────────────
    for node in graph.iter_nodes().filter(|n| n.kind == NodeKind::Style) {
        let kind = node
            .data
            .get("kind")
            .and_then(|v| v.as_str())
            .unwrap_or("rule");
        match kind {
            "class" => emit_class_rules(node, &mut css, &mut style_synth_class),
            "rule" => emit_global_rule(node, &mut css),
            "atrule" => emit_atrule(node, &mut css),
            _ => {}
        }
    }

    // ── 2. wire elements to their classes via the `styles` edge ─────
    for edge in graph.iter_edges().filter(|e| e.kind == EdgeKind::Styles) {
        if let Some(class_name) = style_synth_class.get(&edge.to_node_id) {
            classes_by_element
                .entry(edge.from_node_id.clone())
                .or_default()
                .push(class_name.clone());
        }
    }

    // Also pick up literal className props that don't go through CSS modules.
    for el in graph.iter_nodes().filter(|n| n.kind == NodeKind::Element) {
        for prop_edge in normalized.out_by(&el.id, EdgeKind::BindsProp) {
            if let Some(prop) = graph.node(&prop_edge.to_node_id) {
                if prop.name == "className" {
                    if let Some(v) = prop.data.get("value").and_then(|v| v.as_str()) {
                        for cls in v.split_whitespace() {
                            classes_by_element
                                .entry(el.id.clone())
                                .or_default()
                                .push(cls.to_string());
                        }
                    }
                }
            }
        }
    }

    StylesheetResult {
        css,
        classes_by_element,
    }
}

fn emit_class_rules(
    node: &crate::graph::Node,
    css: &mut String,
    style_synth_class: &mut HashMap<String, String>,
) {
    let Some(synth) = node.data.get("synthesizedId").and_then(|v| v.as_str()) else {
        return;
    };
    let Some(class_name) = node.data.get("className").and_then(|v| v.as_str()) else {
        return;
    };
    style_synth_class.insert(node.id.clone(), synth.to_string());

    let Some(rules) = node.data.get("rules").and_then(|v| v.as_array()) else {
        return;
    };
    for rule in rules {
        let selector = rule.get("selector").and_then(|v| v.as_str()).unwrap_or("");
        let wrapper = rule.get("wrapper").and_then(|v| v.as_str());
        let rewritten = rewrite_selector(selector, class_name, synth);
        let decls = rule.get("declarations").and_then(|v| v.as_object());
        let Some(decls) = decls else { continue };
        if let Some(w) = wrapper {
            let _ = writeln!(css, "{w} {{");
        }
        let _ = writeln!(css, "{rewritten} {{");
        for (prop, val) in decls {
            if let Some(s) = val.as_str() {
                let _ = writeln!(css, "  {prop}: {s};");
            }
        }
        let _ = writeln!(css, "}}");
        if wrapper.is_some() {
            let _ = writeln!(css, "}}");
        }
    }
}

fn emit_global_rule(node: &crate::graph::Node, css: &mut String) {
    let Some(rules) = node.data.get("rules").and_then(|v| v.as_array()) else {
        return;
    };
    for rule in rules {
        let selector = rule.get("selector").and_then(|v| v.as_str()).unwrap_or("");
        let wrapper = rule.get("wrapper").and_then(|v| v.as_str());
        let decls = rule.get("declarations").and_then(|v| v.as_object());
        let Some(decls) = decls else { continue };
        if let Some(w) = wrapper {
            let _ = writeln!(css, "{w} {{");
        }
        let _ = writeln!(css, "{selector} {{");
        for (prop, val) in decls {
            if let Some(s) = val.as_str() {
                let _ = writeln!(css, "  {prop}: {s};");
            }
        }
        let _ = writeln!(css, "}}");
        if wrapper.is_some() {
            let _ = writeln!(css, "}}");
        }
    }
}

fn emit_atrule(node: &crate::graph::Node, css: &mut String) {
    if let Some(css_text) = node.data.get("cssText").and_then(|v| v.as_str()) {
        css.push_str(css_text);
        css.push('\n');
    }
}

/// `.foo:hover` → `.ecto-sty_<id>:hover`. Compound `.foo.bar` is left
/// alone for now (deferred to a richer pass).
fn rewrite_selector(selector: &str, class_name: &str, synth: &str) -> String {
    let from = format!(".{class_name}");
    let to = format!(".{synth}");
    selector.replace(&from, &to)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::edge::{Edge, EdgeKind};
    use crate::graph::kinds::NodeKind;
    use crate::graph::node::Node;
    use serde_json::json;

    #[test]
    fn emits_rewritten_class_rule() {
        let mut g = Graph::new();
        g.insert_node(
            Node::new("s1", NodeKind::Style, "button").with_data(json!({
                "kind": "class",
                "className": "button",
                "synthesizedId": "ecto-sty_abc123",
                "rules": [{
                    "selector": ".button",
                    "declarations": {"color": "white", "padding": "10px"},
                }],
            })),
        );
        let res = generate_stylesheet(&g);
        assert!(res.css.contains(".ecto-sty_abc123 {"));
        assert!(res.css.contains("color: white;"));
        assert!(res.css.contains("padding: 10px;"));
    }

    #[test]
    fn wires_element_to_class_via_styles_edge() {
        let mut g = Graph::new();
        g.insert_node(Node::new("e1", NodeKind::Element, "button"));
        g.insert_node(
            Node::new("s1", NodeKind::Style, "button").with_data(json!({
                "kind": "class",
                "className": "button",
                "synthesizedId": "ecto-sty_abc",
                "rules": [{"selector": ".button", "declarations": {"color": "white"}}],
            })),
        );
        g.insert_edge(Edge::new("ed1", "e1", "s1", EdgeKind::Styles));
        let res = generate_stylesheet(&g);
        assert_eq!(res.classes_by_element.get("e1").unwrap(), &vec!["ecto-sty_abc".to_string()]);
    }
}
