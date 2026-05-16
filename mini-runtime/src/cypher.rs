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

use crate::graph::{Node, NodeData, NodeKind, TextSource};
use crate::runtime::{DerivedKind, EffectKind, Runtime};
use crate::value::Value;

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
        Component, Element, Repeat, Atom, Token, Derived, StyleSheet, Cause, Effect, Doc, Ui,
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
        NodeData::Element { tag, text, attrs } => {
            let mut v = vec![("name", quote(&n.name)), ("tag", quote(tag))];
            if let Some(t) = text {
                v.push(("text", format_text_source(t)));
            }
            if !attrs.is_empty() {
                let entries: Vec<String> = attrs
                    .iter()
                    .map(|(k, val)| format!("{k}: {}", val.display()))
                    .collect();
                v.push(("attrs", format!("{{{}}}", entries.join(", "))));
            }
            v
        }
        NodeData::Atom { value } => vec![("value", value.display())],
        NodeData::Token { value } => vec![("value", value.display())],
        NodeData::Derived { kind } => {
            let mut v = vec![("kind", derived_kind_label(kind))];
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
            vec![("kind", effect_kind_label(kind))]
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
        NodeData::Repeat { source, template } => vec![
            ("source", source.clone()),
            ("template", template.clone()),
        ],
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
        NodeKind::Repeat => "Repeat",
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

fn derived_kind_label(k: &DerivedKind) -> String {
    match k {
        DerivedKind::ThemeBg => "ThemeBg".into(),
        DerivedKind::ThemeFg => "ThemeFg".into(),
        DerivedKind::ThumbX => "ThumbX".into(),
        DerivedKind::Identity => "Identity".into(),
        DerivedKind::Not => "Not".into(),
        DerivedKind::EqualsLiteral { compare_to } => {
            format!("EqualsLiteral({})", compare_to.display())
        }
        DerivedKind::Conditional { when_true, when_false } => format!(
            "Conditional(true={}, false={})",
            when_true.display(),
            when_false.display()
        ),
        DerivedKind::FormatTemplate { template } => {
            format!("FormatTemplate(\"{template}\")")
        }
        DerivedKind::Count => "Count".into(),
    }
}

fn effect_kind_label(k: &EffectKind) -> String {
    match k {
        EffectKind::ToggleThemeMode => "ToggleThemeMode".into(),
        EffectKind::SetAtom { value } => format!("SetAtom({})", value.display()),
        EffectKind::IncrementBy { amount } => format!("IncrementBy({amount})"),
        EffectKind::ToggleBool => "ToggleBool".into(),
        EffectKind::SetAtomFromInput => "SetAtomFromInput".into(),
        EffectKind::AppendToList { value } => format!("AppendToList({})", value.display()),
        EffectKind::AppendInputToList => "AppendInputToList".into(),
        EffectKind::AppendReadToList => "AppendReadToList".into(),
        EffectKind::RemoveFromList { index } => format!("RemoveFromList({index})"),
        EffectKind::ClearList => "ClearList".into(),
    }
}

fn format_text_source(t: &TextSource) -> String {
    match t {
        TextSource::Literal { value } => value.display(),
        TextSource::Ref { id } => format!("→({id})"),
        TextSource::ItemValue => "<item>".into(),
        TextSource::ItemField { key } => format!("<item.{key}>"),
    }
}

#[allow(dead_code)]
fn _suppress(_: Value) {}

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

