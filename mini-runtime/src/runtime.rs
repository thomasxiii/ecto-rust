//! Reactive runtime.
//!
//! Holds the graph plus caches for computed derived values and materialized
//! styles. The propagation algorithm is small and explicit:
//!
//!   1. `handle_event` finds matching Cause nodes for an (element, event)
//!      pair, runs each cause's Triggered Effect as a transaction, and
//!      collects the set of atoms that were written.
//!   2. For each dirty atom, walk `Reads` edges *backwards* to find the
//!      Derived nodes that depend on it. Mark those derived dirty. Repeat
//!      transitively (a derived can READ another derived in the future,
//!      though the toggle demo doesn't need that yet).
//!   3. Recompute each dirty derived. If its value changed, walk `Uses`
//!      edges backwards to find StyleSheets that reference it. Mark those
//!      stylesheets dirty.
//!   4. Re-materialize dirty stylesheets, comparing each property to its
//!      previous value and emitting `StyleChanged` patches for diffs.
//!
//! Atoms and derived values live in the runtime's caches; styles are
//! materialized into `style_cache`. The graph nodes themselves are *not*
//! mutated by propagation except for atom values (which live in node data
//! by spec). Style nodes are read-only — the architectural invariant is
//! that *no effect ever writes to a StyleSheet node directly*. Style
//! changes are always a downstream consequence of atom + derived re-eval.

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

use crate::graph::{EdgeKind, Graph, Node, NodeData, NodeId, NodeKind, StyleValue};
use crate::patch::Patch;
use crate::snapshot::{EventBinding, RenderNode, RuntimeSnapshot, SemanticAnnotation};
use crate::value::Value;

/// Derived value implementations. New variants are added here as derivations
/// become needed; a future iteration can replace this with a DSL.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum DerivedKind {
    /// "light" → LightBg token, "dark" → DarkBg token.
    ThemeBg,
    /// "light" → LightFg token, "dark" → DarkFg token.
    ThemeFg,
    /// "light" → 0, "dark" → 28.
    ThumbX,
}

/// Effect implementations. Each effect is a tiny pure function from current
/// atom values to a set of writes — kept as a sum type rather than a closure
/// so the graph stays inspectable and serializable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EffectKind {
    /// Read ThemeMode atom, flip "light" ↔ "dark".
    ToggleThemeMode,
}

/// Root component id used when materializing the render tree. Convention:
/// the runtime starts from a single root Component node.
pub const ROOT_COMPONENT_ID: &str = "App";

pub struct Runtime {
    pub graph: Graph,
    /// Computed value for each Derived node, keyed by node id.
    derived_cache: HashMap<NodeId, Value>,
    /// Materialized style values, keyed by (element_id, property).
    style_cache: HashMap<(NodeId, String), Value>,
}

impl Runtime {
    /// Build a runtime from a graph and prime the caches so the initial
    /// snapshot is immediately consistent.
    pub fn new(graph: Graph) -> Self {
        let mut rt = Self {
            graph,
            derived_cache: HashMap::new(),
            style_cache: HashMap::new(),
        };
        rt.prime_caches();
        rt
    }

    /// Compute every derived and materialize every style. Called once on
    /// construction so `materialize()` and `handle_event()` always operate
    /// on a fully consistent state.
    fn prime_caches(&mut self) {
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

    /// Build a `RuntimeSnapshot` from current state.
    ///
    /// In `design_mode = false`, Doc and Ui nodes are excluded from the
    /// semantic annotations map. The render tree itself is identical in
    /// both modes — only the semantic projection differs.
    pub fn materialize(&self, design_mode: bool) -> RuntimeSnapshot {
        let render_tree = self.build_render_tree(ROOT_COMPONENT_ID, design_mode);

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

    /// Dispatch an event. Returns a flat patch list describing every change.
    ///
    /// If no Cause node matches the (element, event) pair, returns an empty
    /// list — unknown events are a no-op, not an error.
    pub fn handle_event(&mut self, element: &str, event: &str) -> Vec<Patch> {
        let mut patches: Vec<Patch> = Vec::new();

        // Resolve causes whose source element + event name match. Iterating
        // by Cause nodes (rather than by edge index) is fine here — there
        // are very few causes in a typical app.
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
            // Each cause may TRIGGER one or more effects.
            let effects: Vec<NodeId> =
                self.graph.outgoing_targets(&cause_id, EdgeKind::Triggers);

            for effect_id in effects {
                patches.push(Patch::EventHandled {
                    cause: cause_id.clone(),
                    effect: effect_id.clone(),
                });
                let written = self.run_effect(&effect_id, &mut patches);
                dirty_atoms.extend(written);
            }
        }

        // Walk dependencies → recompute derived → re-materialize styles.
        self.propagate(dirty_atoms, &mut patches);

        patches
    }

    // ---------------------------------------------------------------------
    // Effects.
    // ---------------------------------------------------------------------

    /// Run a single effect node. Returns the set of atom ids that were
    /// written, so the caller can drive propagation. Emits AtomChanged
    /// patches into `patches`.
    fn run_effect(&mut self, effect_id: &str, patches: &mut Vec<Patch>) -> HashSet<NodeId> {
        let mut written = HashSet::new();

        let kind = match self.graph.node(effect_id) {
            Some(Node {
                data: NodeData::Effect { kind },
                ..
            }) => *kind,
            _ => return written,
        };

        match kind {
            EffectKind::ToggleThemeMode => {
                // Find the atom this effect WRITES (also READS, but the
                // write target is what we mutate).
                let writes: Vec<NodeId> =
                    self.graph.outgoing_targets(effect_id, EdgeKind::Writes);
                for atom_id in writes {
                    let old = match self.graph.node(&atom_id) {
                        Some(Node {
                            data: NodeData::Atom { value },
                            ..
                        }) => value.clone(),
                        _ => continue,
                    };
                    let new = match old.as_str() {
                        Some("light") => Value::string("dark"),
                        Some("dark") => Value::string("light"),
                        _ => old.clone(),
                    };
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

        // Stage 1: walk Reads backwards from dirty atoms to find dirty
        // deriveds. BFS — supports derived-on-derived chains too.
        let mut dirty_derived: HashSet<NodeId> = HashSet::new();
        let mut queue: VecDeque<NodeId> = dirty_atoms.into_iter().collect();
        while let Some(node_id) = queue.pop_front() {
            for reader in self.graph.readers(&node_id) {
                if matches!(
                    self.graph.node(&reader).map(|n| &n.data),
                    Some(NodeData::Derived { .. })
                ) && dirty_derived.insert(reader.clone())
                {
                    queue.push_back(reader);
                }
            }
        }

        // Stage 2: recompute dirty deriveds, emit DerivedChanged patches
        // for those whose value changed, and collect dirty stylesheets.
        let mut dirty_sheets: HashSet<NodeId> = HashSet::new();
        // Order matters for deterministic patches. Stable order by id.
        let mut dirty_derived_sorted: Vec<NodeId> = dirty_derived.into_iter().collect();
        dirty_derived_sorted.sort();

        for d_id in dirty_derived_sorted {
            let new_val = self.compute_derived(&d_id);
            let old_val = self.derived_cache.get(&d_id).cloned().unwrap_or(Value::Null);
            if new_val != old_val {
                self.derived_cache.insert(d_id.clone(), new_val.clone());
                patches.push(Patch::DerivedChanged {
                    node: d_id.clone(),
                    old: old_val,
                    new: new_val,
                });
                // Stylesheets that USE this derived become dirty.
                for sheet in self.graph.users(&d_id) {
                    dirty_sheets.insert(sheet);
                }
            }
        }

        // Stage 3: re-materialize dirty stylesheets, diff against prior
        // style_cache, emit StyleChanged patches.
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
        let kind = match self.graph.node(derived_id) {
            Some(Node {
                data: NodeData::Derived { kind },
                ..
            }) => *kind,
            _ => return Value::Null,
        };

        // Read the first atom this derived READs. The toggle demo's
        // deriveds all gate on ThemeMode; if/when multi-atom deriveds
        // arrive, this lookup generalizes naturally.
        let read_targets: Vec<NodeId> = self.graph.outgoing_targets(derived_id, EdgeKind::Reads);
        let read_value = read_targets
            .first()
            .and_then(|id| self.atom_value(id))
            .unwrap_or(Value::Null);

        // Token references used as the "branches" of the derivation are
        // looked up via Uses edges. Resolved by name suffix ("Light…" /
        // "Dark…") — kept tiny and explicit; a DSL replaces this later.
        match kind {
            DerivedKind::ThemeBg => self
                .resolve_theme_token(derived_id, read_value.as_str())
                .unwrap_or(Value::Null),
            DerivedKind::ThemeFg => self
                .resolve_theme_token(derived_id, read_value.as_str())
                .unwrap_or(Value::Null),
            DerivedKind::ThumbX => match read_value.as_str() {
                Some("light") => Value::number(0),
                Some("dark") => Value::number(28),
                _ => Value::number(0),
            },
        }
    }

    /// For ThemeBg / ThemeFg: pick the token whose name starts with
    /// "Light" or "Dark" based on the theme mode atom value.
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

    /// Re-materialize a stylesheet and write resolved values into
    /// `style_cache`, replacing prior entries. Used on initial priming;
    /// no patches emitted.
    fn materialize_sheet(&mut self, sheet_id: &str) {
        let resolved = self.resolve_sheet(sheet_id);
        for (element, props) in resolved {
            for (prop, value) in props {
                self.style_cache.insert((element.clone(), prop), value);
            }
        }
    }

    /// Re-materialize a stylesheet and emit a StyleChanged patch for each
    /// property whose resolved value differs from the cached one.
    fn materialize_sheet_with_patches(&mut self, sheet_id: &str, patches: &mut Vec<Patch>) {
        let resolved = self.resolve_sheet(sheet_id);
        // Iterate in deterministic order so patch sequences are stable.
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

    /// Resolve every StyleValue in a stylesheet to a concrete `Value`.
    /// References to Tokens resolve to the token's literal; references to
    /// Derived nodes resolve to the current `derived_cache` value.
    fn resolve_sheet(&self, sheet_id: &str) -> BTreeMap<NodeId, BTreeMap<String, Value>> {
        let mut out: BTreeMap<NodeId, BTreeMap<String, Value>> = BTreeMap::new();
        let rules = match self.graph.node(sheet_id) {
            Some(Node {
                data: NodeData::StyleSheet { rules },
                ..
            }) => rules.clone(),
            _ => return out,
        };
        for (element_id, props) in rules {
            let mut resolved: BTreeMap<String, Value> = BTreeMap::new();
            for (prop, sv) in props {
                let value = match sv {
                    StyleValue::Literal(v) => v,
                    StyleValue::Ref(id) => self.lookup_value(&id).unwrap_or(Value::Null),
                };
                resolved.insert(prop, value);
            }
            out.insert(element_id, resolved);
        }
        out
    }

    /// Resolve a node reference to a concrete value: tokens carry their
    /// literal in node data; deriveds carry it in the runtime cache.
    fn lookup_value(&self, node_id: &str) -> Option<Value> {
        match self.graph.node(node_id)?.data {
            NodeData::Token { ref value } => Some(value.clone()),
            NodeData::Derived { .. } => self.derived_cache.get(node_id).cloned(),
            NodeData::Atom { ref value } => Some(value.clone()),
            _ => None,
        }
    }

    // ---------------------------------------------------------------------
    // Render tree.
    // ---------------------------------------------------------------------

    fn build_render_tree(&self, root_id: &str, design_mode: bool) -> RenderNode {
        self.build_render_node(root_id, design_mode)
            .unwrap_or_else(|| RenderNode {
                id: root_id.to_string(),
                name: root_id.to_string(),
                kind: NodeKind::Component,
                tag: None,
                children: vec![],
                semantic: None,
            })
    }

    fn build_render_node(&self, id: &str, design_mode: bool) -> Option<RenderNode> {
        let node = self.graph.node(id)?;
        let kind = node.kind();

        let children: Vec<RenderNode> = match &node.data {
            NodeData::Component => {
                // A component renders zero or more elements; each rendered
                // element becomes a child of the component.
                self.graph
                    .outgoing(id, EdgeKind::Renders)
                    .into_iter()
                    .filter_map(|e| self.build_render_node(&e.to, design_mode))
                    .collect()
            }
            NodeData::Element { .. } => {
                // An element contains child elements OR child components.
                self.graph
                    .outgoing(id, EdgeKind::Contains)
                    .into_iter()
                    .filter_map(|e| self.build_render_node(&e.to, design_mode))
                    .collect()
            }
            _ => vec![],
        };

        let tag = match &node.data {
            NodeData::Element { tag } => Some(tag.clone()),
            _ => None,
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

// Internal helper for tests / examples to inspect the runtime without
// rebuilding the public surface.
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
    /// Cypher-like text dump of the entire graph plus the current atom /
    /// derived / bindings state. Format documented in `cypher.rs`.
    pub fn cypher_dump(&self) -> String {
        crate::cypher::cypher_dump(self)
    }
}

