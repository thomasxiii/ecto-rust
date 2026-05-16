//! Cypher-like dump of the runtime — graph structure + live state in one
//! readable text block. Used by the web inspector to show what the runtime
//! is doing.
//!
//! Format choices:
//!   * Nodes:   `(id:Label {prop: value, ...})`
//!   * Edges:   `(from)-[:EDGE_KIND]->(to)`
//!   * Labels use PascalCase (matching `NodeKind` variants).
//!   * Edge kinds use SCREAMING_SNAKE_CASE.
//!
//! Atom values shown are the *current* runtime values (atoms mutate in
//! place). Derived values come from the runtime's cache, so they reflect
//! the latest propagation result.

use std::fmt::Write as _;

use crate::graph::{Node, NodeData, NodeKind};
use crate::runtime::{DerivedKind, EffectKind, Runtime};

pub fn cypher_dump(rt: &Runtime) -> String {
    let mut out = String::new();
    write_nodes(rt, &mut out);
    out.push('\n');
    write_edges(rt, &mut out);
    out.push('\n');
    write_atoms(rt, &mut out);
    out.push('\n');
    write_derived(rt, &mut out);
    out.push('\n');
    write_bindings(rt, &mut out);
    out
}

fn write_nodes(rt: &Runtime, out: &mut String) {
    out.push_str("// ── nodes ────────────────────────────────────────────────────\n");
    use NodeKind::*;
    let order = [
        Component, Element, Atom, Token, Derived, StyleSheet, Cause, Effect, Doc, Ui,
    ];
    for kind in &order {
        let mut nodes: Vec<&Node> = rt.graph.nodes().filter(|n| n.kind() == *kind).collect();
        if nodes.is_empty() {
            continue;
        }
        nodes.sort_by(|a, b| a.id.cmp(&b.id));
        for n in nodes {
            out.push_str(&format_node(rt, n));
            out.push('\n');
        }
        out.push('\n');
    }
}

fn write_edges(rt: &Runtime, out: &mut String) {
    out.push_str("// ── edges ────────────────────────────────────────────────────\n");
    for e in rt.graph.edges() {
        writeln!(out, "({})-[:{}]->({})", e.from, edge_kind_name(e.kind), e.to).unwrap();
    }
}

fn write_atoms(rt: &Runtime, out: &mut String) {
    out.push_str("// ── atoms (current values) ───────────────────────────────────\n");
    for n in rt.graph.nodes() {
        if let NodeData::Atom { value } = &n.data {
            writeln!(out, "{} = {}", n.id, value.display()).unwrap();
        }
    }
}

fn write_derived(rt: &Runtime, out: &mut String) {
    out.push_str("// ── derived (computed) ───────────────────────────────────────\n");
    let mut ids: Vec<String> = rt
        .graph
        .nodes()
        .filter(|n| matches!(n.data, NodeData::Derived { .. }))
        .map(|n| n.id.clone())
        .collect();
    ids.sort();
    for id in ids {
        if let Some(v) = rt.derived(&id) {
            writeln!(out, "{id} = {}", v.display()).unwrap();
        }
    }
}

fn write_bindings(rt: &Runtime, out: &mut String) {
    out.push_str("// ── bindings ─────────────────────────────────────────────────\n");
    for n in rt.graph.nodes() {
        if let NodeData::Cause { source, event } = &n.data {
            writeln!(out, "{source}.{event} → {} (effect via TRIGGERS)", n.id).unwrap();
        }
    }
}

fn format_node(rt: &Runtime, n: &Node) -> String {
    let label = label_for(n.kind());
    let props = match &n.data {
        NodeData::Component => vec![("name", quote(&n.name))],
        NodeData::Element { tag } => vec![("name", quote(&n.name)), ("tag", quote(tag))],
        NodeData::Atom { value } => vec![("value", value.display())],
        NodeData::Token { value } => vec![("value", value.display())],
        NodeData::Derived { kind } => {
            let mut v = vec![("kind", derived_kind_name(*kind).to_string())];
            if let Some(current) = rt.derived(&n.id) {
                v.push(("value", current.display()));
            }
            v
        }
        NodeData::StyleSheet { rules } => {
            let total_props: usize = rules.values().map(|m| m.len()).sum();
            vec![
                ("name", quote(&n.name)),
                ("targets", rules.len().to_string()),
                ("properties", total_props.to_string()),
            ]
        }
        NodeData::Cause { source, event } => vec![
            ("source", source.clone()),
            ("event", quote(event)),
        ],
        NodeData::Effect { kind } => {
            vec![("kind", effect_kind_name(*kind).to_string())]
        }
        NodeData::Doc { text } => vec![("text", quote(&truncate(text, 60)))],
        NodeData::Ui { meta } => {
            if meta.is_empty() {
                vec![("name", quote(&n.name))]
            } else {
                let entries: Vec<String> = meta
                    .iter()
                    .map(|(k, v)| format!("{k}: {}", v.display()))
                    .collect();
                vec![("name", quote(&n.name)), ("meta", format!("{{{}}}", entries.join(", ")))]
            }
        }
    };

    let prop_str = if props.is_empty() {
        String::new()
    } else {
        let parts: Vec<String> = props
            .into_iter()
            .map(|(k, v)| format!("{k}: {v}"))
            .collect();
        format!(" {{{}}}", parts.join(", "))
    };
    format!("({}:{label}{prop_str})", n.id)
}

fn label_for(kind: NodeKind) -> &'static str {
    match kind {
        NodeKind::Component => "Component",
        NodeKind::Element => "Element",
        NodeKind::Atom => "Atom",
        NodeKind::Token => "Token",
        NodeKind::Derived => "Derived",
        NodeKind::StyleSheet => "StyleSheet",
        NodeKind::Cause => "Cause",
        NodeKind::Effect => "Effect",
        NodeKind::Doc => "Doc",
        NodeKind::Ui => "Ui",
    }
}

fn edge_kind_name(k: crate::graph::EdgeKind) -> &'static str {
    use crate::graph::EdgeKind::*;
    match k {
        Renders => "RENDERS",
        Contains => "CONTAINS",
        HasCause => "HAS_CAUSE",
        Triggers => "TRIGGERS",
        Reads => "READS",
        Writes => "WRITES",
        Uses => "USES",
        Targets => "TARGETS",
        HasDoc => "HAS_DOC",
        HasUi => "HAS_UI",
    }
}

fn derived_kind_name(k: DerivedKind) -> &'static str {
    match k {
        DerivedKind::ThemeBg => "ThemeBg",
        DerivedKind::ThemeFg => "ThemeFg",
        DerivedKind::ThumbX => "ThumbX",
    }
}

fn effect_kind_name(k: EffectKind) -> &'static str {
    match k {
        EffectKind::ToggleThemeMode => "ToggleThemeMode",
    }
}

fn quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\"', "\\\""))
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let taken: String = s.chars().take(max).collect();
        format!("{taken}…")
    }
}

