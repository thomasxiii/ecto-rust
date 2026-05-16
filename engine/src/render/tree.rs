//! Render-tree walker. Produces a platform-neutral tree that any
//! adapter (React DOM, SwiftUI, etc.) can render.

use crate::graph::edge::EdgeKind;
use crate::graph::kinds::NodeKind;
use crate::graph::{Graph, Node};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// One element in the platform-neutral render tree. Shape-compatible
/// with the existing iOS `RenderTreeNode` Swift struct, so the same
/// JSON drives both browser and iOS rendering.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderTreeNode {
    /// The underlying graph node ID. Multiple positions in the tree
    /// can share this when a component is rendered more than once.
    /// Use this for inspector selection and live edits.
    pub id: String,
    /// Unique render-tree position. Always different for every node
    /// in the output, even when `id` repeats. Use this for React keys
    /// and any other position-based identity.
    pub render_key: String,
    pub kind: RenderTreeKind,
    pub tag_hint: Option<String>,
    pub props: serde_json::Value,
    #[serde(default)]
    pub style_declarations: Vec<StyleDeclaration>,
    #[serde(default)]
    pub children: Vec<RenderTreeNode>,
    #[serde(default)]
    pub metadata: RenderMetadata,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RenderTreeKind {
    Element,
    Text,
    Fragment,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StyleDeclaration {
    pub property: String,
    pub value: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderMetadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub call_site_node_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_custom_component: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub component_name: Option<String>,
}

const MAX_DEPTH: usize = 80;

const INVISIBLE_TAGS: &[&str] = &[
    "head", "script", "noscript", "style", "meta", "link", "title",
];

/// Walk the graph starting from `root_id` (typically the entry component).
/// Returns None if the root is missing or unrenderable.
pub fn walk_render_tree(graph: &Graph, root_id: &str) -> Option<RenderTreeNode> {
    let mut ctx = Ctx {
        graph,
        normalized: graph.normalized(),
        stack: HashSet::new(),
        depth: 0,
        children_stack: Vec::new(),
        path: String::from("root"),
    };
    let root = graph.node(root_id)?;
    ctx.walk_node(root, None)
}

struct Ctx<'a> {
    graph: &'a Graph,
    normalized: crate::graph::NormalizedGraph<'a>,
    stack: HashSet<String>,
    depth: usize,
    /// Stack of call-site children. When `walk_component` recurses
    /// into a component because of `<Card>...</Card>`, we push the
    /// `...` element IDs here. When we then encounter a
    /// `children_slot` inside the component's body, we emit those
    /// children in place of the slot.
    children_stack: Vec<Vec<String>>,
    /// Current render-tree position, slash-separated. Used to compute
    /// `render_key` so two instantiations of the same component
    /// produce distinct keys even though their underlying graph node
    /// IDs are identical.
    path: String,
}

impl<'a> Ctx<'a> {
    fn make_render_key(&self, node_id: &str) -> String {
        format!("{}/{}", self.path, node_id)
    }

    fn push_path(&mut self, segment: &str) -> usize {
        let saved = self.path.len();
        self.path.push('/');
        self.path.push_str(segment);
        saved
    }

    fn pop_path(&mut self, saved: usize) {
        self.path.truncate(saved);
    }
}

impl<'a> Ctx<'a> {
    fn walk_node(&mut self, node: &Node, call_site: Option<&str>) -> Option<RenderTreeNode> {
        if self.depth >= MAX_DEPTH || self.stack.contains(&node.id) {
            let render_key = self.make_render_key(&format!("{}__placeholder", node.id));
            return Some(RenderTreeNode {
                id: format!("{}__placeholder", node.id),
                render_key,
                kind: RenderTreeKind::Text,
                tag_hint: None,
                props: serde_json::Value::Null,
                style_declarations: Vec::new(),
                children: Vec::new(),
                metadata: RenderMetadata::default(),
            });
        }
        self.stack.insert(node.id.clone());
        self.depth += 1;
        let result = match node.kind {
            NodeKind::Component => self.walk_component(node, call_site),
            NodeKind::Element => self.walk_element(node),
            NodeKind::Text => Some(self.text_node(node)),
            _ => None,
        };
        self.depth -= 1;
        self.stack.remove(&node.id);
        result
    }

    fn walk_component(&mut self, comp: &Node, call_site: Option<&str>) -> Option<RenderTreeNode> {
        // Component renders → first outgoing `renders` edge target.
        let render_edge = self.normalized.first_out_by(&comp.id, EdgeKind::Renders)?;
        let target = self.graph.node(&render_edge.to_node_id)?;
        let mut out = self.walk_node(target, call_site)?;
        out.metadata.component_name = Some(comp.name.clone());
        Some(out)
    }

    fn walk_element(&mut self, el: &Node) -> Option<RenderTreeNode> {
        let tag = el
            .data
            .get("tagName")
            .and_then(|v| v.as_str())
            .unwrap_or("div")
            .to_string();
        let is_fragment = el
            .data
            .get("isFragment")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let is_custom = el
            .data
            .get("isCustomComponent")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        // Suppress non-visual tags.
        if INVISIBLE_TAGS.contains(&tag.as_str()) {
            return None;
        }

        // Custom component → resolve via `references` edge. The chain
        // is `element -references-> Import -references-> Component`
        // for cross-file imports, or `element -references-> Component`
        // for local components. Chase up to 3 hops to find a Component.
        // Capture the call-site's children so `{children}` resolves
        // back to them when we walk the component body. Also push the
        // call site onto the path so re-instantiations of the same
        // component get distinct `render_key`s.
        if is_custom {
            if let Some(comp) = self.resolve_custom_component(&el.id) {
                let call_site_children: Vec<String> = self
                    .normalized
                    .out_by(&el.id, EdgeKind::ChildOf)
                    .into_iter()
                    .map(|e| e.to_node_id.clone())
                    .collect();
                self.children_stack.push(call_site_children);
                let saved = self.push_path(&el.id);
                let result = self.walk_component(comp, Some(&el.id));
                self.pop_path(saved);
                self.children_stack.pop();
                return result;
            }
        }

        // `{children}` slot inside a component body — emit the call
        // site's children that we pushed onto `children_stack` when
        // we recursed into the component. If there's no call site
        // (e.g. an entry component), emit nothing.
        let is_children_slot = el
            .data
            .get("isChildrenSlot")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if is_children_slot {
            return Some(self.emit_children_slot(&el.id));
        }

        let props = self.collect_props(&el.id);

        let mut children = Vec::new();
        for child_edge in self.normalized.out_by(&el.id, EdgeKind::ChildOf) {
            if let Some(child) = self.graph.node(&child_edge.to_node_id) {
                if let Some(rendered) = self.walk_node(child, None) {
                    children.push(rendered);
                }
            }
        }

        let kind = if is_fragment {
            RenderTreeKind::Fragment
        } else {
            RenderTreeKind::Element
        };

        let render_key = self.make_render_key(&el.id);
        Some(RenderTreeNode {
            id: el.id.clone(),
            render_key,
            kind,
            tag_hint: Some(tag.clone()),
            props,
            style_declarations: Vec::new(),
            children,
            metadata: RenderMetadata {
                is_custom_component: Some(is_custom),
                ..Default::default()
            },
        })
    }

    /// Build a fragment containing the call site's children for a
    /// `{children}` slot. Returns an empty fragment if there's no call
    /// site (the slot is at the entry component, with nothing passed in).
    fn emit_children_slot(&mut self, slot_id: &str) -> RenderTreeNode {
        let mut children = Vec::new();
        if let Some(child_ids) = self.children_stack.last().cloned() {
            // Children walk in the caller's path scope, not the
            // current component's — pop one path segment so their
            // render_keys reflect their call-site position rather than
            // the inside of this component's body.
            for cid in child_ids {
                if let Some(child) = self.graph.node(&cid) {
                    if let Some(rendered) = self.walk_node(child, None) {
                        children.push(rendered);
                    }
                }
            }
        }
        let render_key = self.make_render_key(slot_id);
        RenderTreeNode {
            id: slot_id.to_string(),
            render_key,
            kind: RenderTreeKind::Fragment,
            tag_hint: None,
            props: serde_json::Value::Null,
            style_declarations: Vec::new(),
            children,
            metadata: RenderMetadata::default(),
        }
    }

    /// Follow `references` edges from a custom-component element until
    /// we land on a `component` node (or give up after 3 hops). This
    /// transparently chases through `Import` nodes that the importer's
    /// cross-file resolve pass wires up.
    fn resolve_custom_component(&self, el_id: &str) -> Option<&'a Node> {
        let mut current = el_id.to_string();
        for _ in 0..3 {
            let ref_edge = self.normalized.first_out_by(&current, EdgeKind::References)?;
            let target = self.graph.node(&ref_edge.to_node_id)?;
            match target.kind {
                NodeKind::Component => return Some(target),
                NodeKind::Import => {
                    current = target.id.clone();
                }
                _ => return None,
            }
        }
        None
    }

    fn collect_props(&self, el_id: &str) -> serde_json::Value {
        let mut map = serde_json::Map::new();
        for edge in self.normalized.out_by(el_id, EdgeKind::BindsProp) {
            if let Some(prop) = self.graph.node(&edge.to_node_id) {
                let name = prop
                    .data
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&prop.name)
                    .to_string();
                let value = prop
                    .data
                    .get("value")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);
                map.insert(name, value);
            }
        }
        serde_json::Value::Object(map)
    }

    fn text_node(&self, node: &Node) -> RenderTreeNode {
        let text = node
            .data
            .get("value")
            .and_then(|v| v.as_str())
            .unwrap_or(&node.name)
            .to_string();
        let render_key = self.make_render_key(&node.id);
        RenderTreeNode {
            id: node.id.clone(),
            render_key,
            kind: RenderTreeKind::Text,
            tag_hint: None,
            props: serde_json::json!({ "value": text }),
            style_declarations: Vec::new(),
            children: Vec::new(),
            metadata: RenderMetadata::default(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::edge::Edge;
    use crate::graph::node::Node;
    use serde_json::json;

    #[test]
    fn simple_component_renders_to_element_tree() {
        let mut g = Graph::new();
        g.insert_node(Node::new("c1", NodeKind::Component, "App"));
        g.insert_node(
            Node::new("e1", NodeKind::Element, "div").with_data(json!({"tagName": "div"})),
        );
        g.insert_node(Node::new("t1", NodeKind::Text, "hi").with_data(json!({"value": "hi"})));
        g.insert_edge(Edge::new("r1", "c1", "e1", EdgeKind::Renders));
        g.insert_edge(Edge::new("ch1", "e1", "t1", EdgeKind::ChildOf).with_order(0));

        let tree = walk_render_tree(&g, "c1").expect("tree built");
        assert_eq!(tree.kind, RenderTreeKind::Element);
        assert_eq!(tree.tag_hint.as_deref(), Some("div"));
        assert_eq!(tree.children.len(), 1);
        assert_eq!(tree.children[0].kind, RenderTreeKind::Text);
        assert_eq!(tree.children[0].props["value"], "hi");
    }

    #[test]
    fn custom_component_resolves_via_references() {
        let mut g = Graph::new();
        // App renders <Button/> custom element which references Button component
        g.insert_node(Node::new("app", NodeKind::Component, "App"));
        g.insert_node(
            Node::new("call", NodeKind::Element, "Button").with_data(
                json!({"tagName": "Button", "isCustomComponent": true}),
            ),
        );
        g.insert_node(Node::new("btn", NodeKind::Component, "Button"));
        g.insert_node(
            Node::new("e_btn", NodeKind::Element, "button")
                .with_data(json!({"tagName": "button"})),
        );
        g.insert_edge(Edge::new("r1", "app", "call", EdgeKind::Renders));
        g.insert_edge(Edge::new("ref", "call", "btn", EdgeKind::References));
        g.insert_edge(Edge::new("r2", "btn", "e_btn", EdgeKind::Renders));

        let tree = walk_render_tree(&g, "app").unwrap();
        assert_eq!(tree.tag_hint.as_deref(), Some("button"));
    }

    #[test]
    fn children_slot_substitutes_call_site_children() {
        // <Card><p>hi</p></Card>: Card's body is <div>{children}</div>;
        // the walker should emit <div><p>hi</p></div>.
        let mut g = Graph::new();
        g.insert_node(Node::new("app", NodeKind::Component, "App"));
        g.insert_node(
            Node::new("call", NodeKind::Element, "Card")
                .with_data(json!({"tagName": "Card", "isCustomComponent": true})),
        );
        g.insert_node(
            Node::new("inner_p", NodeKind::Element, "p").with_data(json!({"tagName": "p"})),
        );
        g.insert_node(
            Node::new("hi", NodeKind::Text, "hi").with_data(json!({"value": "hi"})),
        );
        g.insert_node(Node::new("card", NodeKind::Component, "Card"));
        g.insert_node(
            Node::new("card_div", NodeKind::Element, "div").with_data(json!({"tagName": "div"})),
        );
        g.insert_node(
            Node::new("slot", NodeKind::Element, "children_slot").with_data(json!({
                "tagName": "children_slot",
                "isChildrenSlot": true,
            })),
        );
        g.insert_edge(Edge::new("r1", "app", "call", EdgeKind::Renders));
        g.insert_edge(Edge::new("ref", "call", "card", EdgeKind::References));
        g.insert_edge(Edge::new("ch1", "call", "inner_p", EdgeKind::ChildOf).with_order(0));
        g.insert_edge(Edge::new("ch_hi", "inner_p", "hi", EdgeKind::ChildOf).with_order(0));
        g.insert_edge(Edge::new("r2", "card", "card_div", EdgeKind::Renders));
        g.insert_edge(Edge::new("ch_slot", "card_div", "slot", EdgeKind::ChildOf).with_order(0));

        let tree = walk_render_tree(&g, "app").unwrap();
        assert_eq!(tree.tag_hint.as_deref(), Some("div"));
        assert_eq!(tree.children.len(), 1, "div has one child: the fragment");
        assert_eq!(tree.children[0].kind, RenderTreeKind::Fragment);
        assert_eq!(tree.children[0].children.len(), 1);
        assert_eq!(tree.children[0].children[0].tag_hint.as_deref(), Some("p"));
    }

    #[test]
    fn custom_component_chases_through_import_node() {
        // App.tsx imports Card from './Card'. The importer creates an
        // Import node and wires <Card/> element → Import. Then the
        // cross-file resolver wires Import → Card component. The
        // render walker must follow both hops.
        let mut g = Graph::new();
        g.insert_node(Node::new("app", NodeKind::Component, "App"));
        g.insert_node(
            Node::new("call", NodeKind::Element, "Card")
                .with_data(json!({"tagName": "Card", "isCustomComponent": true})),
        );
        g.insert_node(
            Node::new("imp", NodeKind::Import, "Card")
                .with_data(json!({"source": "./Card", "imported": "Card"})),
        );
        g.insert_node(Node::new("card", NodeKind::Component, "Card"));
        g.insert_node(
            Node::new("card_div", NodeKind::Element, "div")
                .with_data(json!({"tagName": "div"})),
        );
        g.insert_edge(Edge::new("r1", "app", "call", EdgeKind::Renders));
        g.insert_edge(Edge::new("ref1", "call", "imp", EdgeKind::References));
        g.insert_edge(Edge::new("ref2", "imp", "card", EdgeKind::References));
        g.insert_edge(Edge::new("r2", "card", "card_div", EdgeKind::Renders));

        let tree = walk_render_tree(&g, "app").unwrap();
        assert_eq!(
            tree.tag_hint.as_deref(),
            Some("div"),
            "should chase through Import to land on Card → div"
        );
    }
}
