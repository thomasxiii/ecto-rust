//! Walk the AST and emit a `mini_runtime::GraphPayload`. The wire
//! format is identical to what `MiniRuntime.loadGraph` accepts, so the
//! React shell can compile → load → materialize without any extra
//! adapter.
//!
//! Pass order:
//!   1. Tokens → derived → models (+ atoms) → register styles → queries.
//!   2. Components: pre-create nodes so `< KnownComponent` works as a
//!      forward reference, then walk render trees emitting Elements,
//!      Repeats, Visibility nodes, Causes/Effects.
//!   3. Finalize stylesheets — attach the accumulated rule maps to the
//!      StyleSheet nodes.

use std::collections::{BTreeMap, HashMap};

use mini_runtime::graph::{
    Edge, EdgeKind, FilterCompare, GraphPayload, Node, NodeData, NodeId, RepeatFilter, StylePart,
    StyleValue, TextSource, VisibilityRule,
};
use mini_runtime::runtime::{DerivedKind, EffectKind, RecordField};
use mini_runtime::value::Value;
use serde::Serialize;

use super::ast::*;
use super::lexer::Literal;
use super::parser::ParseError;

/// Result of compiling an `EctoFile`. The graph payload is always
/// returned (possibly partial on error); `errors` carries any
/// compile-time diagnostics.
#[derive(Debug, Clone)]
pub struct CompileResult {
    pub graph: GraphPayload,
    pub index: CompileIndex,
    pub errors: Vec<ParseError>,
}

/// Convenience indexes the React shell uses for the inspector and 3D
/// graph panes — name → node-id lookups so a click in the editor can
/// light up the corresponding node.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileIndex {
    pub atoms: BTreeMap<String, String>,
    pub components: BTreeMap<String, String>,
    pub tokens: BTreeMap<String, String>,
    pub derived: BTreeMap<String, String>,
    pub styles: BTreeMap<String, String>,
    pub queries: BTreeMap<String, String>,
    pub root_component_id: Option<String>,
}

pub fn compile(file: &EctoFile) -> CompileResult {
    let mut cx = Compiler::default();
    cx.run(file);
    cx.finish()
}

#[derive(Default)]
struct Compiler {
    nodes: Vec<Node>,
    edges: Vec<Edge>,
    counter: u32,
    errors: Vec<ParseError>,

    // Symbol tables
    /// "ModelName.stateName" or "ComponentName.stateName" → atom id.
    atoms_by_qname: HashMap<String, NodeId>,
    /// Component-local atoms while the current component is compiling.
    component_local: HashMap<String, NodeId>,
    /// Model name → its state names. Used to keep
    /// component-local lookups distinct from model lookups.
    model_state_names: HashMap<String, Vec<String>>,
    components: HashMap<String, NodeId>,
    tokens: HashMap<String, NodeId>,
    derived: HashMap<String, NodeId>,
    styles: HashMap<String, NodeId>,
    queries: HashMap<String, QueryRecord>,
    styles_decls: HashMap<String, StylesDecl>,
    /// Per-stylesheet element → property → StyleValue map. Filled lazily
    /// as elements reference styles; copied into the StyleSheet node's
    /// `rules` field by `finalize_styles`.
    sheet_rules: HashMap<NodeId, BTreeMap<NodeId, BTreeMap<String, StyleValue>>>,
    /// Derived nodes that needed a Reads edge but their target atom
    /// wasn't known yet at derived-emit time. Flushed once all atoms
    /// exist.
    pending_derived_reads: Vec<(NodeId, Vec<String>, Pos)>,
    /// Stack of enclosing loop variables for the current render walk.
    scope: Vec<String>,
    /// Mirror of `scope` carrying the underlying *list atom id* for
    /// each enclosing loop. Used to resolve `ToggleListItemField`
    /// writes to the right collection.
    loop_sources: Vec<NodeId>,
}

#[derive(Debug, Clone)]
struct QueryRecord {
    source: Vec<String>,
    filters: Vec<QueryFilter>,
}

impl Compiler {
    fn next_id(&mut self, prefix: &str) -> NodeId {
        self.counter += 1;
        format!("{prefix}_{}", self.counter)
    }

    /// Deterministic ID derived from a kind prefix + symbol path. Same
    /// `qname` always hashes to the same ID across recompiles, so the
    /// runtime can match atoms between old and new graphs to preserve
    /// their values when the user edits the source. Use this for nodes
    /// the user names in source (atoms, components, tokens). Anonymous
    /// nodes (elements, effects, causes) keep counter IDs.
    fn stable_id(prefix: &str, qname: &str) -> NodeId {
        let key = format!("{prefix}::{qname}");
        let a = crate::stable_id::fnv1a32(&key);
        let b = crate::stable_id::fnv1a32(&format!("{key}:b"));
        format!("{prefix}_{a}{}", &b[..4])
    }

    fn add_node(&mut self, node: Node) {
        self.nodes.push(node);
    }

    fn add_edge(&mut self, from: impl Into<String>, to: impl Into<String>, kind: EdgeKind) {
        self.edges.push(Edge::new(from, to, kind));
    }
}

// ─────────────────────────────────────────────────────────────────────
// Orchestration.
// ─────────────────────────────────────────────────────────────────────

impl Compiler {
    fn run(&mut self, file: &EctoFile) {
        for d in &file.decls {
            if let TopDecl::Token(t) = d {
                self.emit_token(t);
            }
        }
        for d in &file.decls {
            if let TopDecl::Derived(d) = d {
                self.emit_derived(d);
            }
        }
        for d in &file.decls {
            if let TopDecl::Model(m) = d {
                self.emit_model(m);
            }
        }
        for d in &file.decls {
            if let TopDecl::Styles(s) = d {
                self.styles_decls.insert(s.name.clone(), s.clone());
            }
        }
        for d in &file.decls {
            if let TopDecl::Query(q) = d {
                self.queries.insert(
                    q.name.clone(),
                    QueryRecord {
                        source: q.source.clone(),
                        filters: q.filters.clone(),
                    },
                );
            }
        }

        // Pre-register Component nodes so forward references in render
        // trees (e.g. `< NewProjectForm`) work.
        for d in &file.decls {
            if let TopDecl::Component(c) = d {
                let id = self.next_id("comp");
                self.add_node(Node::new(&id, &c.name, NodeData::Component));
                self.components.insert(c.name.clone(), id);
            }
        }
        for d in &file.decls {
            if let TopDecl::Component(c) = d {
                self.emit_component(c);
            }
        }

        self.finalize_styles();
    }

    fn finish(self) -> CompileResult {
        let root_component_id = self
            .components
            .get("App")
            .or_else(|| self.components.get("Task"))
            .or_else(|| self.components.values().next())
            .cloned();

        let mut index = CompileIndex::default();
        for (k, v) in &self.atoms_by_qname {
            index.atoms.insert(k.clone(), v.clone());
        }
        for (k, v) in &self.components {
            index.components.insert(k.clone(), v.clone());
        }
        for (k, v) in &self.tokens {
            index.tokens.insert(k.clone(), v.clone());
        }
        for (k, v) in &self.derived {
            index.derived.insert(k.clone(), v.clone());
        }
        for (k, v) in &self.styles {
            index.styles.insert(k.clone(), v.clone());
        }
        for k in self.queries.keys() {
            index.queries.insert(k.clone(), k.clone());
        }
        index.root_component_id = root_component_id.clone();

        let graph = GraphPayload {
            nodes: self.nodes,
            edges: self.edges,
            root: root_component_id,
        };
        CompileResult {
            graph,
            index,
            errors: self.errors,
        }
    }

    // Suppress unused-warning while we still touch the field via accessor.
    #[allow(dead_code)]
    fn _ms_names(&self) -> &HashMap<String, Vec<String>> {
        &self.model_state_names
    }
}

// ─────────────────────────────────────────────────────────────────────
// Tokens / derived / models.
// ─────────────────────────────────────────────────────────────────────

impl Compiler {
    fn emit_token(&mut self, t: &TokenDecl) {
        let id = Self::stable_id("token", &t.name);
        let value = literal_to_value(&t.value);
        self.add_node(Node::new(&id, &t.name, NodeData::Token { value }));
        self.tokens.insert(t.name.clone(), id);
    }

    fn emit_derived(&mut self, d: &DerivedDecl) {
        match &d.expr {
            DerivedExpr::IfElse {
                cond,
                then_ref,
                else_ref,
            } => {
                let id = self.next_id("derived");
                let then_val = self.token_value(then_ref);
                let else_val = self.token_value(else_ref);
                self.add_node(Node::new(
                    &id,
                    &d.name,
                    NodeData::Derived {
                        kind: DerivedKind::Conditional {
                            when_true: then_val,
                            when_false: else_val,
                        },
                    },
                ));
                self.derived.insert(d.name.clone(), id.clone());
                self.pending_derived_reads
                    .push((id, cond.clone(), d.pos));
            }
            DerivedExpr::Ref(name) => {
                let id = self.next_id("derived");
                self.add_node(Node::new(
                    &id,
                    &d.name,
                    NodeData::Derived {
                        kind: DerivedKind::Identity,
                    },
                ));
                self.derived.insert(d.name.clone(), id.clone());
                self.pending_derived_reads
                    .push((id, vec![name.clone()], d.pos));
            }
            DerivedExpr::Raw(text) => {
                let id = self.next_id("derived");
                self.add_node(Node::new(
                    &id,
                    &d.name,
                    NodeData::Derived {
                        kind: DerivedKind::Conditional {
                            when_true: Value::String(text.clone()),
                            when_false: Value::String(text.clone()),
                        },
                    },
                ));
                self.derived.insert(d.name.clone(), id);
            }
        }
    }

    fn flush_pending_derived_reads(&mut self) {
        let pending = std::mem::take(&mut self.pending_derived_reads);
        for (derived_id, path, pos) in pending {
            if let Some(atom_id) = self.resolve_path_to_atom(&path, None) {
                self.add_edge(&derived_id, &atom_id, EdgeKind::Reads);
            } else if let Some(other) = self.derived.get(&path.join(".")).cloned() {
                self.add_edge(&derived_id, &other, EdgeKind::Reads);
            } else if path.len() == 1 {
                if let Some(other) = self.derived.get(&path[0]).cloned() {
                    self.add_edge(&derived_id, &other, EdgeKind::Reads);
                } else if let Some(tok) = self.tokens.get(&path[0]).cloned() {
                    self.add_edge(&derived_id, &tok, EdgeKind::Reads);
                } else {
                    self.errors.push(ParseError {
                        message: format!(
                            "derived `{derived_id}` references unknown path `{}`",
                            path.join(".")
                        ),
                        line: pos.line.max(1),
                        col: pos.col.max(1),
                    });
                }
            } else {
                self.errors.push(ParseError {
                    message: format!(
                        "derived `{derived_id}` references unknown path `{}`",
                        path.join(".")
                    ),
                    line: pos.line.max(1),
                    col: pos.col.max(1),
                });
            }
        }
    }

    fn emit_model(&mut self, m: &ModelDecl) {
        // Models aren't rendered — they exist purely to host atoms.
        for state in &m.states {
            let qname = format!("{}.{}", m.name, state.name);
            let atom_id = Self::stable_id("atom", &qname);
            self.add_node(Node::new(
                &atom_id,
                &qname,
                NodeData::Atom {
                    value: literal_to_value(&state.initial),
                },
            ));
            self.atoms_by_qname.insert(qname, atom_id);
        }
        let names: Vec<String> = m.states.iter().map(|s| s.name.clone()).collect();
        self.model_state_names.insert(m.name.clone(), names);
    }

    fn token_value(&self, name: &str) -> Value {
        if let Some(tid) = self.tokens.get(name) {
            if let Some(node) = self.nodes.iter().find(|n| n.id == *tid) {
                if let NodeData::Token { value } = &node.data {
                    return value.clone();
                }
            }
        }
        Value::String(name.to_string())
    }
}

// ─────────────────────────────────────────────────────────────────────
// Components + render trees.
// ─────────────────────────────────────────────────────────────────────

impl Compiler {
    fn emit_component(&mut self, c: &ComponentDecl) {
        self.component_local.clear();
        for state in &c.states {
            let qname = format!("{}.{}", c.name, state.name);
            let atom_id = Self::stable_id("atom", &qname);
            self.add_node(Node::new(
                &atom_id,
                &qname,
                NodeData::Atom {
                    value: literal_to_value(&state.initial),
                },
            ));
            self.atoms_by_qname.insert(qname, atom_id.clone());
            self.component_local.insert(state.name.clone(), atom_id);
        }

        let comp_id = self
            .components
            .get(&c.name)
            .cloned()
            .expect("component pre-registered");

        if let Some(root) = &c.render {
            self.flush_pending_derived_reads();
            if let Some(root_id) = self.emit_element(root, &c.name, &comp_id) {
                self.add_edge(&comp_id, &root_id, EdgeKind::Renders);
            }
        }
    }

    fn emit_element(
        &mut self,
        el: &ElementNode,
        component_name: &str,
        component_id: &str,
    ) -> Option<NodeId> {
        if let (Some(var), Some(source_path)) = (&el.loop_var, &el.loop_source) {
            return self.emit_repeat(el, var, source_path, component_name, component_id);
        }
        if let Some(target_id) = self.components.get(&el.name).cloned() {
            return Some(target_id);
        }

        let element_id = self.next_id("el");
        let tag = el.name.clone();

        let mut text: Option<TextSource> = None;
        let mut attrs: BTreeMap<String, Value> = BTreeMap::new();
        for (name, lit) in &el.attrs {
            attrs.insert(name.clone(), literal_to_value(lit));
        }
        if el.traits.iter().any(|t| t == "editable") {
            attrs.insert("editable".to_string(), Value::Bool(true));
        }

        for b in &el.bindings {
            if b.prop == "text" || b.prop == "value" || b.prop == "checked" {
                if let Some(t) = self.binding_to_text_source(&b.target, component_name) {
                    text = Some(t);
                }
            }
        }

        self.add_node(Node::new(
            &element_id,
            &el.name,
            NodeData::Element {
                tag,
                text,
                attrs,
            },
        ));

        for style_name in &el.styles {
            if self.styles_decls.contains_key(style_name) {
                let sheet_id = self.ensure_stylesheet(style_name);
                self.add_edge(&sheet_id, &element_id, EdgeKind::Targets);
                let rules = self.compile_style_rules(style_name);
                self.sheet_rules
                    .entry(sheet_id)
                    .or_default()
                    .insert(element_id.clone(), rules);
            } else {
                self.errors.push(ParseError {
                    message: format!("unknown styles block `{style_name}`"),
                    line: el.pos.line.max(1),
                    col: el.pos.col.max(1),
                });
            }
        }

        if let Some(rule) = &el.when {
            self.emit_visibility(&element_id, rule, component_name);
        }

        for b in &el.bindings {
            self.emit_binding_writeback(
                &element_id,
                &b.prop,
                &b.target,
                component_name,
                component_id,
            );
        }

        for handler in &el.events {
            self.emit_event_handler(&element_id, handler, component_name, component_id);
        }

        for child in &el.children {
            if let Some(child_id) = self.emit_element(child, component_name, component_id) {
                self.add_edge(&element_id, &child_id, EdgeKind::Contains);
            }
        }

        Some(element_id)
    }

    fn emit_repeat(
        &mut self,
        el: &ElementNode,
        var: &str,
        source_path: &[String],
        component_name: &str,
        component_id: &str,
    ) -> Option<NodeId> {
        let (source_id, filters) = self.resolve_for_source(source_path, component_name);
        let source_id = match source_id {
            Some(id) => id,
            None => {
                self.errors.push(ParseError {
                    message: format!(
                        "unknown loop source `{}`",
                        source_path.join(".")
                    ),
                    line: el.pos.line.max(1),
                    col: el.pos.col.max(1),
                });
                return None;
            }
        };

        self.scope.push(var.to_string());
        let resolved_filters: Vec<RepeatFilter> = filters
            .into_iter()
            .filter_map(|f| self.resolve_query_filter(f, component_name))
            .collect();

        let template_id = el
            .children
            .first()
            .and_then(|first| self.emit_element(first, component_name, component_id));

        self.scope.pop();
        self.loop_sources.pop();

        let template_id = template_id?;
        let repeat_id = self.next_id("rep");
        self.add_node(Node::new(
            &repeat_id,
            &format!("for {var}"),
            NodeData::Repeat {
                source: source_id,
                template: template_id,
                filters: resolved_filters,
            },
        ));
        Some(repeat_id)
    }

    fn emit_visibility(
        &mut self,
        element_id: &str,
        rule: &WhenRule,
        component_name: &str,
    ) {
        let v_rule = match rule {
            WhenRule::Truthy { path } => self.visibility_from_path(path, component_name, None),
            WhenRule::Equals { path, literal } => self.visibility_from_path(
                path,
                component_name,
                Some(literal_to_value(literal)),
            ),
        };
        let Some(v_rule) = v_rule else {
            return;
        };
        let vis_id = self.next_id("vis");
        self.add_node(Node::new(
            &vis_id,
            "when",
            NodeData::Visibility { rule: v_rule },
        ));
        self.add_edge(element_id, &vis_id, EdgeKind::ShownWhen);
    }

    fn visibility_from_path(
        &mut self,
        path: &[String],
        component_name: &str,
        compare: Option<Value>,
    ) -> Option<VisibilityRule> {
        if path.len() == 2 && self.is_loop_var_ref(path) {
            return Some(if let Some(v) = compare {
                VisibilityRule::ItemFieldEquals {
                    key: path[1].clone(),
                    value: v,
                }
            } else {
                VisibilityRule::ItemFieldTruthy {
                    key: path[1].clone(),
                }
            });
        }
        let source = self.resolve_path_to_atom(path, Some(component_name))?;
        Some(if let Some(v) = compare {
            VisibilityRule::Equals { source, value: v }
        } else {
            VisibilityRule::Truthy { source }
        })
    }

    fn emit_event_handler(
        &mut self,
        element_id: &str,
        handler: &EventHandler,
        component_name: &str,
        component_id: &str,
    ) {
        let cause_id = self.next_id("cause");
        self.add_node(Node::new(
            &cause_id,
            &format!("{}.{}", element_id, handler.event),
            NodeData::Cause {
                source: element_id.to_string(),
                event: handler.event.clone(),
            },
        ));
        self.add_edge(component_id, &cause_id, EdgeKind::HasCause);
        for action in &handler.actions {
            if let Some(eid) = self.emit_action(action, component_name) {
                self.add_edge(&cause_id, &eid, EdgeKind::Triggers);
            }
        }
    }

    fn emit_action(&mut self, action: &ActionNode, component_name: &str) -> Option<NodeId> {
        match action {
            ActionNode::Toggle { target } => self.emit_toggle(target, component_name),
            ActionNode::Set { target, value } => self.emit_set(target, value, component_name),
            ActionNode::Clear { target } => self.emit_clear(target, component_name),
            ActionNode::Add { target, fields } => self.emit_add(target, fields, component_name),
        }
    }

    fn emit_toggle(&mut self, target: &[String], component_name: &str) -> Option<NodeId> {
        if target.len() == 2 && self.is_loop_var_ref(target) {
            // No Writes edge — the runtime takes the list atom from
            // the dispatch context's `item_atom_id`, which the host
            // pulls from the rendered node's `itemAtom` field.
            let effect_id = self.next_id("effect");
            self.add_node(Node::new(
                &effect_id,
                "toggle-item",
                NodeData::Effect {
                    kind: EffectKind::ToggleListItemField {
                        field: target[1].clone(),
                    },
                },
            ));
            return Some(effect_id);
        }
        let atom_id = self.resolve_path_to_atom(target, Some(component_name))?;
        let effect_id = self.next_id("effect");
        self.add_node(Node::new(
            &effect_id,
            "toggle",
            NodeData::Effect {
                kind: EffectKind::ToggleBool,
            },
        ));
        self.add_edge(&effect_id, &atom_id, EdgeKind::Writes);
        Some(effect_id)
    }

    fn emit_set(
        &mut self,
        target: &[String],
        value: &ValueExpr,
        component_name: &str,
    ) -> Option<NodeId> {
        let atom_id = self.resolve_path_to_atom(target, Some(component_name))?;
        let effect_id = self.next_id("effect");
        match value {
            ValueExpr::Literal(lit) => {
                self.add_node(Node::new(
                    &effect_id,
                    "set",
                    NodeData::Effect {
                        kind: EffectKind::SetAtom {
                            value: literal_to_value(lit),
                        },
                    },
                ));
            }
            ValueExpr::Path(path) => {
                let Some(src) = self.resolve_path_to_atom(path, Some(component_name)) else {
                    // Soft-fail: keep the effect inert.
                    self.add_node(Node::new(
                        &effect_id,
                        "set-null",
                        NodeData::Effect {
                            kind: EffectKind::SetAtom { value: Value::Null },
                        },
                    ));
                    self.add_edge(&effect_id, &atom_id, EdgeKind::Writes);
                    return Some(effect_id);
                };
                self.add_node(Node::new(
                    &effect_id,
                    "set-from",
                    NodeData::Effect {
                        kind: EffectKind::SetFromRead,
                    },
                ));
                self.add_edge(&effect_id, &src, EdgeKind::Reads);
            }
            ValueExpr::Match { .. } => {
                // Starter never uses match on the LHS of a plain `set`;
                // we emit a no-op write so the action chain stays valid.
                self.add_node(Node::new(
                    &effect_id,
                    "set-match",
                    NodeData::Effect {
                        kind: EffectKind::SetAtom { value: Value::Null },
                    },
                ));
            }
        }
        self.add_edge(&effect_id, &atom_id, EdgeKind::Writes);
        Some(effect_id)
    }

    fn emit_clear(&mut self, target: &[String], component_name: &str) -> Option<NodeId> {
        let atom_id = self.resolve_path_to_atom(target, Some(component_name))?;
        let effect_id = self.next_id("effect");
        self.add_node(Node::new(
            &effect_id,
            "clear",
            NodeData::Effect {
                kind: EffectKind::Clear,
            },
        ));
        self.add_edge(&effect_id, &atom_id, EdgeKind::Writes);
        Some(effect_id)
    }

    fn emit_add(
        &mut self,
        target: &[String],
        fields: &[AddField],
        component_name: &str,
    ) -> Option<NodeId> {
        let atom_id = self.resolve_path_to_atom(target, Some(component_name))?;
        let effect_id = self.next_id("effect");
        let mut record_fields: Vec<RecordField> = Vec::new();
        let mut reads: Vec<NodeId> = Vec::new();
        for f in fields {
            match &f.value {
                ValueExpr::Literal(lit) => {
                    record_fields.push(RecordField::Literal {
                        name: f.name.clone(),
                        value: literal_to_value(lit),
                    });
                }
                ValueExpr::Path(path) => {
                    if let Some(src) = self.resolve_path_to_atom(path, Some(component_name)) {
                        record_fields.push(RecordField::Atom {
                            name: f.name.clone(),
                            source: src.clone(),
                        });
                        reads.push(src);
                    } else {
                        record_fields.push(RecordField::Literal {
                            name: f.name.clone(),
                            value: Value::Null,
                        });
                    }
                }
                ValueExpr::Match {
                    input,
                    collection,
                    field,
                } => {
                    let input_atom = self.resolve_path_to_atom(input, Some(component_name));
                    let cand_atom =
                        self.resolve_path_to_atom(collection, Some(component_name));
                    match (input_atom, cand_atom) {
                        (Some(i), Some(c)) => {
                            record_fields.push(RecordField::Match {
                                name: f.name.clone(),
                                input: i,
                                candidates: c,
                                by: field.clone(),
                            });
                        }
                        _ => {
                            record_fields.push(RecordField::Literal {
                                name: f.name.clone(),
                                value: Value::Null,
                            });
                        }
                    }
                }
            }
        }
        self.add_node(Node::new(
            &effect_id,
            "add-record",
            NodeData::Effect {
                kind: EffectKind::AppendRecord {
                    fields: record_fields,
                },
            },
        ));
        self.add_edge(&effect_id, &atom_id, EdgeKind::Writes);
        for r in reads {
            self.add_edge(&effect_id, &r, EdgeKind::Reads);
        }
        Some(effect_id)
    }

    fn emit_binding_writeback(
        &mut self,
        element_id: &str,
        prop: &str,
        target: &[String],
        component_name: &str,
        component_id: &str,
    ) {
        let cause_event = match prop {
            "value" | "checked" => "change",
            _ => return,
        };

        // Loop-scope target — list atom comes from the dispatch
        // context at runtime, not from a compile-time Writes edge.
        if target.len() == 2 && self.is_loop_var_ref(target) {
            let cause_id = self.next_id("cause");
            self.add_node(Node::new(
                &cause_id,
                &format!("{}.{}", element_id, cause_event),
                NodeData::Cause {
                    source: element_id.to_string(),
                    event: cause_event.to_string(),
                },
            ));
            self.add_edge(component_id, &cause_id, EdgeKind::HasCause);
            let kind = if prop == "checked" {
                EffectKind::ToggleListItemField {
                    field: target[1].clone(),
                }
            } else {
                EffectKind::SetListItemFieldFromInput {
                    field: target[1].clone(),
                }
            };
            let effect_id = self.next_id("effect");
            self.add_node(Node::new(
                &effect_id,
                "writeback",
                NodeData::Effect { kind },
            ));
            self.add_edge(&cause_id, &effect_id, EdgeKind::Triggers);
            return;
        }

        let Some(atom_id) = self.resolve_path_to_atom(target, Some(component_name)) else {
            return;
        };
        let cause_id = self.next_id("cause");
        self.add_node(Node::new(
            &cause_id,
            &format!("{}.{}", element_id, cause_event),
            NodeData::Cause {
                source: element_id.to_string(),
                event: cause_event.to_string(),
            },
        ));
        self.add_edge(component_id, &cause_id, EdgeKind::HasCause);
        let kind = if prop == "checked" {
            EffectKind::ToggleBool
        } else {
            EffectKind::SetAtomFromInput
        };
        let effect_id = self.next_id("effect");
        self.add_node(Node::new(
            &effect_id,
            "writeback",
            NodeData::Effect { kind },
        ));
        self.add_edge(&effect_id, &atom_id, EdgeKind::Writes);
        self.add_edge(&cause_id, &effect_id, EdgeKind::Triggers);
    }

    fn binding_to_text_source(
        &mut self,
        target: &[String],
        component_name: &str,
    ) -> Option<TextSource> {
        // 2-segment refs whose head doesn't name a model/component
        // atom are loop-item references. Components are compiled
        // standalone, so a `task.text` inside `Task` only ever
        // resolves as an item field — the actual `task` binding is
        // supplied by the enclosing `< for task in ... >` at render.
        if target.len() == 2 && self.is_loop_var_ref(target) {
            return Some(TextSource::ItemField {
                key: target[1].clone(),
            });
        }
        let atom_id = self.resolve_path_to_atom(target, Some(component_name))?;
        Some(TextSource::Ref { id: atom_id })
    }

    /// A 2-segment path is a loop-item reference when its head
    /// doesn't name a model whose state set includes the tail
    /// segment. We deliberately *don't* check `self.scope` — the
    /// loop var may be provided by a caller in another component.
    fn is_loop_var_ref(&self, target: &[String]) -> bool {
        if target.len() != 2 {
            return false;
        }
        let qname = format!("{}.{}", target[0], target[1]);
        // Known atom? Then it's not a loop ref.
        if self.atoms_by_qname.contains_key(&qname) {
            return false;
        }
        // Known model with that state? Same conclusion.
        if let Some(states) = self.model_state_names.get(&target[0]) {
            if states.iter().any(|s| s == &target[1]) {
                return false;
            }
        }
        true
    }
}

// ─────────────────────────────────────────────────────────────────────
// Styles.
// ─────────────────────────────────────────────────────────────────────

impl Compiler {
    fn ensure_stylesheet(&mut self, name: &str) -> NodeId {
        if let Some(id) = self.styles.get(name) {
            return id.clone();
        }
        let id = self.next_id("sheet");
        self.add_node(Node::new(
            &id,
            name,
            NodeData::StyleSheet {
                rules: BTreeMap::new(),
            },
        ));
        self.styles.insert(name.to_string(), id.clone());
        self.sheet_rules.insert(id.clone(), BTreeMap::new());
        id
    }

    fn compile_style_rules(&mut self, name: &str) -> BTreeMap<String, StyleValue> {
        let decl = match self.styles_decls.get(name).cloned() {
            Some(d) => d,
            None => return BTreeMap::new(),
        };
        let mut out: BTreeMap<String, StyleValue> = BTreeMap::new();
        for prop in &decl.props {
            let css_key = remap_css_key(&prop.name);
            let sv = self.style_value_from_values(&prop.values);
            out.insert(css_key, sv);
        }
        out
    }

    fn style_value_from_values(&self, values: &[Literal]) -> StyleValue {
        if values.len() == 1 {
            return self.single_style_value(&values[0]);
        }
        let parts: Vec<StylePart> = values.iter().map(|lit| self.style_part(lit)).collect();
        StyleValue::Multi { parts }
    }

    fn single_style_value(&self, lit: &Literal) -> StyleValue {
        match lit {
            Literal::Ident(name) => {
                if let Some(tid) = self.tokens.get(name) {
                    StyleValue::Ref { id: tid.clone() }
                } else if let Some(did) = self.derived.get(name) {
                    StyleValue::Ref { id: did.clone() }
                } else {
                    StyleValue::Literal {
                        value: Value::String(name.clone()),
                    }
                }
            }
            Literal::Qualified(segs) if segs.len() == 2 && is_digits(&segs[1]) => {
                if let Some(tid) = self.tokens.get(&segs[0]) {
                    let pct = segs[1].parse::<f64>().unwrap_or(0.0);
                    return StyleValue::Alpha {
                        token: tid.clone(),
                        percent: pct,
                    };
                }
                StyleValue::Literal {
                    value: Value::String(segs.join(".")),
                }
            }
            _ => StyleValue::Literal {
                value: literal_to_value(lit),
            },
        }
    }

    fn style_part(&self, lit: &Literal) -> StylePart {
        match lit {
            Literal::Ident(name) => {
                if let Some(tid) = self.tokens.get(name) {
                    StylePart::Ref { id: tid.clone() }
                } else if let Some(did) = self.derived.get(name) {
                    StylePart::Ref { id: did.clone() }
                } else {
                    StylePart::Literal {
                        value: Value::String(name.clone()),
                    }
                }
            }
            Literal::Qualified(segs) if segs.len() == 2 && is_digits(&segs[1]) => {
                if let Some(tid) = self.tokens.get(&segs[0]) {
                    let pct = segs[1].parse::<f64>().unwrap_or(0.0);
                    return StylePart::Alpha {
                        token: tid.clone(),
                        percent: pct,
                    };
                }
                StylePart::Literal {
                    value: Value::String(segs.join(".")),
                }
            }
            _ => StylePart::Literal {
                value: literal_to_value(lit),
            },
        }
    }

    fn finalize_styles(&mut self) {
        let ids: Vec<NodeId> = self.sheet_rules.keys().cloned().collect();
        for sheet_id in ids {
            let rules = self.sheet_rules.remove(&sheet_id).unwrap_or_default();
            if let Some(node) = self.nodes.iter_mut().find(|n| n.id == sheet_id) {
                if let NodeData::StyleSheet { rules: r } = &mut node.data {
                    *r = rules;
                }
            }
        }
    }
}

fn is_digits(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_digit())
}

fn remap_css_key(name: &str) -> String {
    match name {
        "bg" => "background".to_string(),
        "fg" => "color".to_string(),
        "radius" => "borderRadius".to_string(),
        "shadow" => "boxShadow".to_string(),
        _ => name.to_string(),
    }
}

// ─────────────────────────────────────────────────────────────────────
// Path resolution.
// ─────────────────────────────────────────────────────────────────────

impl Compiler {
    fn resolve_path_to_atom(
        &self,
        path: &[String],
        component_name: Option<&str>,
    ) -> Option<NodeId> {
        if path.is_empty() {
            return None;
        }
        if path.len() == 1 {
            if let Some(id) = self.component_local.get(&path[0]) {
                return Some(id.clone());
            }
            return None;
        }
        let qname = format!("{}.{}", path[0], path[1..].join("."));
        if let Some(id) = self.atoms_by_qname.get(&qname) {
            return Some(id.clone());
        }
        if let Some(name) = component_name {
            let alt = format!("{name}.{}", path.join("."));
            if let Some(id) = self.atoms_by_qname.get(&alt) {
                return Some(id.clone());
            }
        }
        None
    }

    fn resolve_for_source(
        &mut self,
        path: &[String],
        component_name: &str,
    ) -> (Option<NodeId>, Vec<QueryFilter>) {
        if path.len() == 1 {
            if let Some(q) = self.queries.get(&path[0]).cloned() {
                let atom = self.resolve_path_to_atom(&q.source, Some(component_name));
                if let Some(id) = atom.clone() {
                    self.loop_sources.push(id);
                }
                return (atom, q.filters);
            }
        }
        let atom = self.resolve_path_to_atom(path, Some(component_name));
        if let Some(id) = atom.clone() {
            self.loop_sources.push(id);
        }
        (atom, Vec::new())
    }

    fn resolve_query_filter(
        &self,
        f: QueryFilter,
        component_name: &str,
    ) -> Option<RepeatFilter> {
        let compare = match &f.value {
            ValueExpr::Literal(lit) => FilterCompare::Literal {
                value: literal_to_value(lit),
            },
            ValueExpr::Path(path) => {
                if path.len() == 2 && self.is_loop_var_ref(path) {
                    FilterCompare::OuterItemField {
                        key: path[1].clone(),
                    }
                } else {
                    let src = self.resolve_path_to_atom(path, Some(component_name))?;
                    FilterCompare::Atom { source: src }
                }
            }
            ValueExpr::Match { .. } => return None,
        };
        Some(RepeatFilter {
            field: f.field,
            compare,
        })
    }
}

// ─────────────────────────────────────────────────────────────────────
// Literal → Value.
// ─────────────────────────────────────────────────────────────────────

fn literal_to_value(lit: &Literal) -> Value {
    match lit {
        Literal::String(s) => Value::String(s.clone()),
        Literal::Number(n) => Value::Number(*n),
        Literal::Bool(b) => Value::Bool(*b),
        Literal::Color(c) => Value::String(c.clone()),
        Literal::Unit { value, unit } => {
            let s = if value.fract() == 0.0 {
                format!("{}{unit}", *value as i64)
            } else {
                format!("{value}{unit}")
            };
            Value::String(s)
        }
        Literal::Ident(name) => Value::String(name.clone()),
        Literal::Qualified(segs) => Value::String(segs.join(".")),
        Literal::List => Value::List(Vec::new()),
        Literal::Null => Value::Null,
        Literal::Raw(s) => Value::String(s.clone()),
    }
}
