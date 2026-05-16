//! Reactive runtime.
//!
//! Holds the graph plus caches for computed derived values and materialized
//! styles. The propagation algorithm is small and explicit:
//!
//!   1. `handle_event` (or `dispatch_event` for events that carry a
//!      payload like `change`) finds matching Cause nodes for an
//!      (element, event) pair, runs each cause's Triggered Effect as a
//!      transaction, and collects the set of atoms that were written.
//!   2. For each dirty atom, walk `Reads` edges *backwards* in BFS order
//!      to find the Derived nodes that depend on it. BFS gives a
//!      topological order so derived-on-derived chains recompute in
//!      dependency order.
//!   3. Recompute each dirty derived. If its value changed, walk `Uses`
//!      edges backwards to find StyleSheets that reference it. Mark those
//!      stylesheets dirty.
//!   4. Re-materialize dirty stylesheets, diffing each property against
//!      its previous resolved value and emitting `StyleChanged` patches
//!      for the diffs.
//!
//! Atoms and derived values live in the runtime's caches; styles are
//! materialized into `style_cache`. The graph nodes themselves are *not*
//! mutated by propagation except for atom values (which live in node data
//! by spec). Style nodes are read-only — the architectural invariant is
//! that *no effect ever writes to a StyleSheet node directly*. Style
//! changes are always a downstream consequence of atom + derived re-eval.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

use serde::{Deserialize, Serialize};

use crate::graph::{
    EdgeKind, Graph, GraphPayload, NodeData, NodeId, NodeKind, StyleValue, TextSource,
};
use crate::patch::Patch;
use crate::snapshot::{EventBinding, RenderNode, RuntimeSnapshot, SemanticAnnotation};
use crate::value::Value;

/// Derived value implementations. Each variant is a small pure computation
/// from the atoms/derived values its node READs (graph edges) to a fresh
/// `Value`. New variants are added here as derivations become needed; the
/// LLM-prompted graph generator picks from this fixed set.
///
/// All variants take their primary input from the first `READS` target on
/// the derived node. Variants that need extra config carry it inline.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum DerivedKind {
    /// "light" → LightBg-named token, "dark" → DarkBg-named token.
    ThemeBg,
    /// "light" → LightFg-named token, "dark" → DarkFg-named token.
    ThemeFg,
    /// "light" → 0, "dark" → 28.
    ThumbX,
    /// Echoes the value of the READS target unchanged. Useful as a
    /// renamed reactive alias.
    Identity,
    /// Boolean negation. Non-bool truthy values map to `false`; falsy to `true`.
    Not,
    /// Returns `read_value == compare_to` as a Bool.
    EqualsLiteral { compare_to: Value },
    /// Picks between two literals based on a truthy test on the read value.
    Conditional { when_true: Value, when_false: Value },
    /// Substitute `{}` in `template` with the READ value's plain text.
    FormatTemplate { template: String },
    /// Length of a list (or character count for a string).
    Count,
}

/// Effect implementations. Each effect is a tiny pure function from current
/// atom values (and an optional event payload) to one or more atom writes.
/// Effects only mutate Atoms — never styles or other derived/style nodes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum EffectKind {
    /// Read ThemeMode atom (WRITES target), flip "light" ↔ "dark".
    ToggleThemeMode,
    /// Write a fixed literal value to the WRITES target.
    SetAtom { value: Value },
    /// Numeric: WRITES target += amount. No-op if target isn't a number.
    IncrementBy { amount: f64 },
    /// Boolean: WRITES target = !target.
    ToggleBool,
    /// For change events: write the event's payload (typically the new
    /// input value) to the WRITES target.
    SetAtomFromInput,
    /// List: push `value` to the end of WRITES target's list.
    AppendToList { value: Value },
    /// List: append the event payload (e.g. an input value) to the WRITES
    /// target's list.
    AppendInputToList,
    /// List: take the current value of the first READS target (an atom)
    /// and push it to the WRITES target's list. Used to wire
    /// "button click appends the draft atom to a tasks list."
    AppendReadToList,
    /// List: remove the item at `index` from WRITES target's list.
    RemoveFromList { index: usize },
    /// List: write an empty list to the WRITES target.
    ClearList,
}

/// Root component id used when materializing the render tree. Convention:
/// the runtime starts from a Component named "App". Override via
/// `GraphPayload.root` if your app uses a different root id.
pub const ROOT_COMPONENT_ID: &str = "App";

pub struct Runtime {
    pub graph: Graph,
    /// Computed value for each Derived node, keyed by node id.
    derived_cache: HashMap<NodeId, Value>,
    /// Materialized style values, keyed by (element_id, property).
    style_cache: HashMap<(NodeId, String), Value>,
}

impl Runtime {
    /// Build a runtime from a graph and prime the caches.
    pub fn new(graph: Graph) -> Self {
        let mut rt = Self {
            graph,
            derived_cache: HashMap::new(),
            style_cache: HashMap::new(),
        };
        rt.prime_caches();
        rt
    }

    /// Swap the runtime's graph for a fresh payload. Existing caches are
    /// dropped; new ones are primed. Useful when the host wants to load a
    /// different generated app without reconstructing the runtime.
    pub fn load_payload(&mut self, payload: GraphPayload) {
        self.graph = Graph::from_payload(payload);
        self.derived_cache.clear();
        self.style_cache.clear();
        self.prime_caches();
    }

    fn prime_caches(&mut self) {
        // Two passes for deriveds — derived-on-derived would require more,
        // but a fixed-point loop covers it. For the apps we generate, two
        // passes is plenty.
        for _ in 0..2 {
            let derived_ids: Vec<NodeId> = self
                .graph
                .nodes()
                .filter(|n| matches!(n.data, NodeData::Derived { .. }))
                .map(|n| n.id.clone())
                .collect();
            for id in derived_ids {
                let v = self.compute_derived(&id);
                self.derived_cache.insert(id, v);
            }
        }

        let sheet_ids: Vec<NodeId> = self
            .graph
            .nodes()
            .filter(|n| matches!(n.data, NodeData::StyleSheet { .. }))
            .map(|n| n.id.clone())
            .collect();
        for id in sheet_ids {
            self.materialize_sheet(&id);
        }
    }

    // ---------------------------------------------------------------------
    // Public surface: snapshot + event dispatch.
    // ---------------------------------------------------------------------

    pub fn materialize(&self, design_mode: bool) -> RuntimeSnapshot {
        let root_id = self
            .graph
            .root
            .clone()
            .unwrap_or_else(|| ROOT_COMPONENT_ID.to_string());
        let render_tree = self.build_render_tree(&root_id, design_mode);

        let mut styles: BTreeMap<NodeId, BTreeMap<String, Value>> = BTreeMap::new();
        for ((element, prop), value) in &self.style_cache {
            styles
                .entry(element.clone())
                .or_default()
                .insert(prop.clone(), value.clone());
        }

        let mut atoms = BTreeMap::new();
        let mut derived = BTreeMap::new();
        for node in self.graph.nodes() {
            match &node.data {
                NodeData::Atom { value } => {
                    atoms.insert(node.id.clone(), value.clone());
                }
                NodeData::Derived { .. } => {
                    if let Some(v) = self.derived_cache.get(&node.id) {
                        derived.insert(node.id.clone(), v.clone());
                    }
                }
                _ => {}
            }
        }

        let mut bindings: Vec<EventBinding> = self
            .graph
            .nodes()
            .filter_map(|n| match &n.data {
                NodeData::Cause { source, event } => Some(EventBinding {
                    element: source.clone(),
                    event: event.clone(),
                    cause: n.id.clone(),
                }),
                _ => None,
            })
            .collect();
        bindings.sort_by(|a, b| {
            (a.element.as_str(), a.event.as_str()).cmp(&(b.element.as_str(), b.event.as_str()))
        });

        let mut semantic_nodes: BTreeMap<NodeId, SemanticAnnotation> = BTreeMap::new();
        if design_mode {
            for node in self.graph.nodes() {
                if matches!(node.data, NodeData::Component) {
                    let ann = self.semantic_for(&node.id);
                    if ann.doc.is_some() || ann.ui.is_some() {
                        semantic_nodes.insert(node.id.clone(), ann);
                    }
                }
            }
        }

        RuntimeSnapshot {
            design_mode,
            render_tree,
            styles,
            atoms,
            derived,
            bindings,
            semantic_nodes,
        }
    }

    /// Dispatch a payload-less event (`click`, `submit`, `focus`).
    pub fn handle_event(&mut self, element: &str, event: &str) -> Vec<Patch> {
        self.dispatch_event(element, event, None)
    }

    /// Dispatch an event that carries a payload — typically `change` from
    /// an input, whose payload is the new value as a `Value::String`.
    pub fn dispatch_event(
        &mut self,
        element: &str,
        event: &str,
        payload: Option<Value>,
    ) -> Vec<Patch> {
        let mut patches: Vec<Patch> = Vec::new();

        let cause_ids: Vec<NodeId> = self
            .graph
            .nodes()
            .filter_map(|n| match &n.data {
                NodeData::Cause { source, event: ev } if source == element && ev == event => {
                    Some(n.id.clone())
                }
                _ => None,
            })
            .collect();

        if cause_ids.is_empty() {
            return patches;
        }

        let mut dirty_atoms: HashSet<NodeId> = HashSet::new();

        for cause_id in cause_ids {
            let effects: Vec<NodeId> =
                self.graph.outgoing_targets(&cause_id, EdgeKind::Triggers);

            for effect_id in effects {
                patches.push(Patch::EventHandled {
                    cause: cause_id.clone(),
                    effect: effect_id.clone(),
                });
                let written = self.run_effect(&effect_id, payload.as_ref(), &mut patches);
                dirty_atoms.extend(written);
            }
        }

        self.propagate(dirty_atoms, &mut patches);
        patches
    }

    // ---------------------------------------------------------------------
    // Effects.
    // ---------------------------------------------------------------------

    fn run_effect(
        &mut self,
        effect_id: &str,
        payload: Option<&Value>,
        patches: &mut Vec<Patch>,
    ) -> HashSet<NodeId> {
        let mut written = HashSet::new();

        let kind = match self.graph.node(effect_id).map(|n| &n.data) {
            Some(NodeData::Effect { kind }) => kind.clone(),
            _ => return written,
        };

        // For effects that READ from another atom (AppendReadToList), look
        // up the first Reads target's current value. This lets a click
        // effect on "Add" pull the current Draft atom and push it onto
        // Tasks without needing the event to carry a payload.
        let read_value: Option<Value> = self
            .graph
            .outgoing_targets(effect_id, EdgeKind::Reads)
            .first()
            .and_then(|id| self.lookup_value(id));

        let writes: Vec<NodeId> = self.graph.outgoing_targets(effect_id, EdgeKind::Writes);
        for atom_id in writes {
            let old = match self.graph.node(&atom_id).map(|n| &n.data) {
                Some(NodeData::Atom { value }) => value.clone(),
                _ => continue,
            };
            let new = apply_effect(&kind, &old, payload, read_value.as_ref());
            if new != old {
                if let Some(node) = self.graph.node_mut(&atom_id) {
                    if let NodeData::Atom { value } = &mut node.data {
                        *value = new.clone();
                    }
                }
                patches.push(Patch::AtomChanged {
                    node: atom_id.clone(),
                    old,
                    new,
                });
                written.insert(atom_id);
            }
        }

        written
    }

    // ---------------------------------------------------------------------
    // Propagation.
    // ---------------------------------------------------------------------

    fn propagate(&mut self, dirty_atoms: HashSet<NodeId>, patches: &mut Vec<Patch>) {
        if dirty_atoms.is_empty() {
            return;
        }

        // BFS from dirty atoms over Reads edges (backwards) — gives a
        // topological order over the read-DAG so derived-on-derived chains
        // recompute in dependency order.
        let mut seen: HashSet<NodeId> = HashSet::new();
        let mut dirty_derived_order: Vec<NodeId> = Vec::new();
        let mut queue: VecDeque<NodeId> = dirty_atoms.into_iter().collect();
        while let Some(node_id) = queue.pop_front() {
            for reader in self.graph.readers(&node_id) {
                if matches!(
                    self.graph.node(&reader).map(|n| &n.data),
                    Some(NodeData::Derived { .. })
                ) && seen.insert(reader.clone())
                {
                    dirty_derived_order.push(reader.clone());
                    queue.push_back(reader);
                }
            }
        }

        let mut dirty_sheets: HashSet<NodeId> = HashSet::new();
        for d_id in dirty_derived_order {
            let new_val = self.compute_derived(&d_id);
            let old_val = self
                .derived_cache
                .get(&d_id)
                .cloned()
                .unwrap_or(Value::Null);
            if new_val != old_val {
                self.derived_cache.insert(d_id.clone(), new_val.clone());
                patches.push(Patch::DerivedChanged {
                    node: d_id.clone(),
                    old: old_val,
                    new: new_val,
                });
                for sheet in self.graph.users(&d_id) {
                    if matches!(
                        self.graph.node(&sheet).map(|n| &n.data),
                        Some(NodeData::StyleSheet { .. })
                    ) {
                        dirty_sheets.insert(sheet);
                    }
                }
            }
        }

        let mut dirty_sheets_sorted: Vec<NodeId> = dirty_sheets.into_iter().collect();
        dirty_sheets_sorted.sort();
        for sheet_id in dirty_sheets_sorted {
            self.materialize_sheet_with_patches(&sheet_id, patches);
        }
    }

    // ---------------------------------------------------------------------
    // Derived computation.
    // ---------------------------------------------------------------------

    fn compute_derived(&self, derived_id: &str) -> Value {
        let kind = match self.graph.node(derived_id).map(|n| &n.data) {
            Some(NodeData::Derived { kind }) => kind.clone(),
            _ => return Value::Null,
        };

        let read_targets: Vec<NodeId> = self.graph.outgoing_targets(derived_id, EdgeKind::Reads);
        let read_value = read_targets
            .first()
            .and_then(|id| self.lookup_value(id))
            .unwrap_or(Value::Null);

        match kind {
            DerivedKind::ThemeBg | DerivedKind::ThemeFg => self
                .resolve_theme_token(derived_id, read_value.as_str())
                .unwrap_or(Value::Null),
            DerivedKind::ThumbX => match read_value.as_str() {
                Some("light") => Value::number(0),
                Some("dark") => Value::number(28),
                _ => Value::number(0),
            },
            DerivedKind::Identity => read_value,
            DerivedKind::Not => Value::Bool(!is_truthy(&read_value)),
            DerivedKind::EqualsLiteral { compare_to } => Value::Bool(read_value == compare_to),
            DerivedKind::Conditional {
                when_true,
                when_false,
            } => {
                if is_truthy(&read_value) {
                    when_true
                } else {
                    when_false
                }
            }
            DerivedKind::FormatTemplate { template } => {
                Value::String(template.replace("{}", &read_value.plain_text()))
            }
            DerivedKind::Count => match &read_value {
                Value::List(items) => Value::number(items.len() as f64),
                Value::String(s) => Value::number(s.chars().count() as f64),
                _ => Value::number(0),
            },
        }
    }

    fn resolve_theme_token(&self, derived_id: &str, mode: Option<&str>) -> Option<Value> {
        let prefix = match mode {
            Some("light") => "Light",
            Some("dark") => "Dark",
            _ => return None,
        };
        let token_ids = self.graph.outgoing_targets(derived_id, EdgeKind::Uses);
        for tid in token_ids {
            let node = self.graph.node(&tid)?;
            if node.name.starts_with(prefix) {
                if let NodeData::Token { value } = &node.data {
                    return Some(value.clone());
                }
            }
        }
        None
    }

    fn atom_value(&self, atom_id: &str) -> Option<Value> {
        match self.graph.node(atom_id)?.data {
            NodeData::Atom { ref value } => Some(value.clone()),
            _ => None,
        }
    }

    // ---------------------------------------------------------------------
    // Style materialization.
    // ---------------------------------------------------------------------

    fn materialize_sheet(&mut self, sheet_id: &str) {
        let resolved = self.resolve_sheet(sheet_id);
        for (element, props) in resolved {
            for (prop, value) in props {
                self.style_cache.insert((element.clone(), prop), value);
            }
        }
    }

    fn materialize_sheet_with_patches(&mut self, sheet_id: &str, patches: &mut Vec<Patch>) {
        let resolved = self.resolve_sheet(sheet_id);
        let mut element_keys: Vec<_> = resolved.keys().cloned().collect();
        element_keys.sort();
        for element in element_keys {
            let props = &resolved[&element];
            let mut prop_keys: Vec<_> = props.keys().cloned().collect();
            prop_keys.sort();
            for prop in prop_keys {
                let new_val = props[&prop].clone();
                let key = (element.clone(), prop.clone());
                let old_val = self.style_cache.get(&key).cloned();
                let changed = match &old_val {
                    Some(old) => old != &new_val,
                    None => true,
                };
                if changed {
                    self.style_cache.insert(key.clone(), new_val.clone());
                    patches.push(Patch::StyleChanged {
                        element: element.clone(),
                        property: prop,
                        old: old_val.unwrap_or(Value::Null),
                        new: new_val,
                    });
                }
            }
        }
    }

    fn resolve_sheet(&self, sheet_id: &str) -> BTreeMap<NodeId, BTreeMap<String, Value>> {
        let mut out: BTreeMap<NodeId, BTreeMap<String, Value>> = BTreeMap::new();
        let rules = match self.graph.node(sheet_id).map(|n| &n.data) {
            Some(NodeData::StyleSheet { rules }) => rules.clone(),
            _ => return out,
        };
        for (element_id, props) in rules {
            let mut resolved: BTreeMap<String, Value> = BTreeMap::new();
            for (prop, sv) in props {
                let value = match sv {
                    StyleValue::Literal { value } => value,
                    StyleValue::Ref { id } => self.lookup_value(&id).unwrap_or(Value::Null),
                };
                resolved.insert(prop, value);
            }
            out.insert(element_id, resolved);
        }
        out
    }

    fn lookup_value(&self, node_id: &str) -> Option<Value> {
        match self.graph.node(node_id)?.data {
            NodeData::Token { ref value } => Some(value.clone()),
            NodeData::Derived { .. } => self.derived_cache.get(node_id).cloned(),
            NodeData::Atom { ref value } => Some(value.clone()),
            _ => None,
        }
    }

    /// Public helper — resolves a TextSource against the current state,
    /// with no per-iteration context (used when called outside a Repeat).
    pub fn resolve_text(&self, source: &TextSource) -> String {
        self.resolve_text_with_item(source, None)
    }

    /// Resolve a `TextSource` against the current state plus an optional
    /// per-iteration item value. `ItemValue` / `ItemField` only mean
    /// something when an item context is present (inside Repeat).
    fn resolve_text_with_item(&self, source: &TextSource, item: Option<&Value>) -> String {
        match source {
            TextSource::Literal { value } => value.plain_text(),
            TextSource::Ref { id } => self
                .lookup_value(id)
                .map(|v| v.plain_text())
                .unwrap_or_default(),
            TextSource::ItemValue => item.map(|v| v.plain_text()).unwrap_or_default(),
            TextSource::ItemField { key } => item
                .and_then(|v| match v {
                    Value::Object(m) => m.get(key).map(|x| x.plain_text()),
                    _ => None,
                })
                .unwrap_or_default(),
        }
    }

    // ---------------------------------------------------------------------
    // Render tree.
    // ---------------------------------------------------------------------

    fn build_render_tree(&self, root_id: &str, design_mode: bool) -> RenderNode {
        // LLM-generated graphs can be malformed: edges may form cycles
        // (Element A contains Component B that renders Element A) or
        // DAGs where one element is reachable through two parents. The
        // `visited` set ensures we never recurse into the same node twice
        // in a single render walk *unless* we're inside a Repeat
        // expansion (where the same template is intentionally re-rendered
        // once per item — those visits clear the template id between
        // iterations).
        let mut visited: HashSet<NodeId> = HashSet::new();
        self.build_render_node(root_id, design_mode, &mut visited, None)
            .unwrap_or_else(|| RenderNode {
                id: root_id.to_string(),
                name: root_id.to_string(),
                kind: NodeKind::Component,
                tag: None,
                text: None,
                attrs: BTreeMap::new(),
                children: vec![],
                semantic: None,
            })
    }

    /// Walk the children of an element/component, expanding Repeat nodes
    /// inline into one rendered template-copy per item.
    fn build_children(
        &self,
        parent_id: &str,
        edge_kind: EdgeKind,
        design_mode: bool,
        visited: &mut HashSet<NodeId>,
        item: Option<&Value>,
    ) -> Vec<RenderNode> {
        let mut children = Vec::new();
        for e in self.graph.outgoing(parent_id, edge_kind) {
            let target = self.graph.node(&e.to);
            match target.map(|n| &n.data) {
                Some(NodeData::Repeat { source, template }) => {
                    let items = self
                        .atom_value(source)
                        .and_then(|v| match v {
                            Value::List(items) => Some(items),
                            _ => None,
                        })
                        .unwrap_or_default();
                    for it in &items {
                        // Each iteration is its own visit-scope so the
                        // template id can re-enter.
                        let mut iter_visited = visited.clone();
                        if let Some(rn) =
                            self.build_render_node(template, design_mode, &mut iter_visited, Some(it))
                        {
                            children.push(rn);
                        }
                    }
                }
                _ => {
                    if let Some(rn) =
                        self.build_render_node(&e.to, design_mode, visited, item)
                    {
                        children.push(rn);
                    }
                }
            }
        }
        children
    }

    fn build_render_node(
        &self,
        id: &str,
        design_mode: bool,
        visited: &mut HashSet<NodeId>,
        item: Option<&Value>,
    ) -> Option<RenderNode> {
        if !visited.insert(id.to_string()) {
            return None;
        }
        let node = self.graph.node(id)?;
        let kind = node.kind();

        let children: Vec<RenderNode> = match &node.data {
            NodeData::Component => {
                self.build_children(id, EdgeKind::Renders, design_mode, visited, item)
            }
            NodeData::Element { .. } => {
                self.build_children(id, EdgeKind::Contains, design_mode, visited, item)
            }
            _ => vec![],
        };

        let (tag, text, attrs) = match &node.data {
            NodeData::Element { tag, text, attrs } => {
                let resolved_text = text.as_ref().map(|t| self.resolve_text_with_item(t, item));
                let attr_strings: BTreeMap<String, String> = attrs
                    .iter()
                    .map(|(k, v)| (k.clone(), v.plain_text()))
                    .collect();
                (Some(tag.clone()), resolved_text, attr_strings)
            }
            _ => (None, None, BTreeMap::new()),
        };

        let semantic = if design_mode && matches!(node.data, NodeData::Component) {
            let ann = self.semantic_for(id);
            if ann.doc.is_some() || ann.ui.is_some() {
                Some(ann)
            } else {
                None
            }
        } else {
            None
        };

        Some(RenderNode {
            id: id.to_string(),
            name: node.name.clone(),
            kind,
            tag,
            text,
            attrs,
            children,
            semantic,
        })
    }

    fn semantic_for(&self, component_id: &str) -> SemanticAnnotation {
        let doc = self
            .graph
            .outgoing_targets(component_id, EdgeKind::HasDoc)
            .into_iter()
            .next();
        let ui = self
            .graph
            .outgoing_targets(component_id, EdgeKind::HasUi)
            .into_iter()
            .next();
        SemanticAnnotation { doc, ui }
    }
}

// Inspection helpers.
impl Runtime {
    pub fn atom(&self, id: &str) -> Option<Value> {
        self.atom_value(id)
    }
    pub fn derived(&self, id: &str) -> Option<Value> {
        self.derived_cache.get(id).cloned()
    }
    pub fn style(&self, element: &str, property: &str) -> Option<Value> {
        self.style_cache
            .get(&(element.to_string(), property.to_string()))
            .cloned()
    }
    pub fn cypher_dump(&self) -> String {
        crate::cypher::cypher_dump(self)
    }
}

// ─────────────────────────────────────────────────────────────────────────
// Free helpers.
// ─────────────────────────────────────────────────────────────────────────

fn apply_effect(
    kind: &EffectKind,
    old: &Value,
    payload: Option<&Value>,
    read_value: Option<&Value>,
) -> Value {
    match kind {
        EffectKind::ToggleThemeMode => match old.as_str() {
            Some("light") => Value::string("dark"),
            Some("dark") => Value::string("light"),
            _ => old.clone(),
        },
        EffectKind::SetAtom { value } => value.clone(),
        EffectKind::IncrementBy { amount } => match old.as_number() {
            Some(n) => Value::number(n + amount),
            None => old.clone(),
        },
        EffectKind::ToggleBool => match old.as_bool() {
            Some(b) => Value::Bool(!b),
            None => Value::Bool(true),
        },
        EffectKind::SetAtomFromInput => payload.cloned().unwrap_or_else(|| old.clone()),
        EffectKind::AppendToList { value } => {
            let mut items = list_or_empty(old);
            items.push(value.clone());
            Value::List(items)
        }
        EffectKind::AppendInputToList => {
            let mut items = list_or_empty(old);
            if let Some(p) = payload {
                items.push(p.clone());
            }
            Value::List(items)
        }
        EffectKind::AppendReadToList => {
            let mut items = list_or_empty(old);
            if let Some(v) = read_value {
                // Skip pushing empty strings / nulls so a click while the
                // draft is blank is a no-op rather than adding an empty row.
                let is_empty = matches!(v, Value::Null)
                    || matches!(v, Value::String(s) if s.is_empty());
                if !is_empty {
                    items.push(v.clone());
                }
            }
            Value::List(items)
        }
        EffectKind::RemoveFromList { index } => {
            let mut items = list_or_empty(old);
            if *index < items.len() {
                items.remove(*index);
            }
            Value::List(items)
        }
        EffectKind::ClearList => Value::List(Vec::new()),
    }
}

fn list_or_empty(v: &Value) -> Vec<Value> {
    match v {
        Value::List(items) => items.clone(),
        _ => Vec::new(),
    }
}

fn is_truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => *n != 0.0,
        Value::String(s) => !s.is_empty(),
        Value::List(items) => !items.is_empty(),
        Value::Object(m) => !m.is_empty(),
    }
}
