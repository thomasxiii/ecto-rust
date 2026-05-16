//! End-to-end tests for the toggle demo. Each test corresponds to one of
//! the cases listed in the runtime spec.

use mini_runtime::toggle_app::{build_toggle_app, ids};
use mini_runtime::{NodeKind, Patch, Runtime, Value};

fn rt() -> Runtime {
    Runtime::new(build_toggle_app())
}

#[test]
fn initial_materialization_is_light_mode() {
    let runtime = rt();
    let snap = runtime.materialize(false);

    // Atom + derived caches reflect the seeded light theme.
    assert_eq!(snap.atoms[ids::THEME_MODE], Value::string("light"));
    assert_eq!(snap.derived[ids::BG], Value::string("#ffffff"));
    assert_eq!(snap.derived[ids::FG], Value::string("#111111"));
    assert_eq!(snap.derived[ids::THUMB_X], Value::number(0));

    // Style materialization resolved the refs to literal values.
    let app_root = &snap.styles[ids::APP_ROOT];
    assert_eq!(app_root["background"], Value::string("#ffffff"));
    assert_eq!(app_root["color"], Value::string("#111111"));
    assert_eq!(app_root["minHeight"], Value::string("100vh"));

    let track = &snap.styles[ids::TOGGLE_TRACK];
    assert_eq!(track["background"], Value::string("#111111"));
    assert_eq!(track["color"], Value::string("#ffffff"));
    assert_eq!(track["width"], Value::number(64));

    let thumb = &snap.styles[ids::TOGGLE_THUMB];
    assert_eq!(thumb["background"], Value::string("#ffffff"));
    assert_eq!(thumb["translateX"], Value::number(0));
}

#[test]
fn render_tree_shape_matches_spec() {
    let runtime = rt();
    let snap = runtime.materialize(false);
    let app = &snap.render_tree;

    assert_eq!(app.id, ids::APP);
    assert_eq!(app.kind, NodeKind::Component);
    assert_eq!(app.children.len(), 1);

    let app_root = &app.children[0];
    assert_eq!(app_root.id, ids::APP_ROOT);
    assert_eq!(app_root.kind, NodeKind::Element);
    assert_eq!(app_root.tag.as_deref(), Some("div"));
    assert_eq!(app_root.children.len(), 1);

    let toggle = &app_root.children[0];
    assert_eq!(toggle.id, ids::TOGGLE);
    assert_eq!(toggle.kind, NodeKind::Component);
    assert_eq!(toggle.children.len(), 1);

    let track = &toggle.children[0];
    assert_eq!(track.id, ids::TOGGLE_TRACK);
    assert_eq!(track.children.len(), 1);

    let thumb = &track.children[0];
    assert_eq!(thumb.id, ids::TOGGLE_THUMB);
    assert!(thumb.children.is_empty());
}

#[test]
fn design_mode_false_excludes_doc_and_ui() {
    let runtime = rt();
    let snap = runtime.materialize(false);

    assert!(!snap.design_mode);
    assert!(snap.semantic_nodes.is_empty());

    // The Toggle component in the render tree carries no semantic
    // annotation in runtime mode.
    let toggle = &snap.render_tree.children[0].children[0];
    assert_eq!(toggle.id, ids::TOGGLE);
    assert!(toggle.semantic.is_none());
}

#[test]
fn design_mode_true_includes_toggle_doc_and_ui() {
    let runtime = rt();
    let snap = runtime.materialize(true);

    assert!(snap.design_mode);
    let ann = snap
        .semantic_nodes
        .get(ids::TOGGLE)
        .expect("Toggle has a semantic annotation in design mode");
    assert_eq!(ann.doc.as_deref(), Some(ids::TOGGLE_DOC));
    assert_eq!(ann.ui.as_deref(), Some(ids::TOGGLE_UI));

    let toggle = &snap.render_tree.children[0].children[0];
    assert!(toggle.semantic.is_some());
}

#[test]
fn clicking_toggle_track_flips_theme_to_dark() {
    let mut runtime = rt();
    let patches = runtime.handle_event(ids::TOGGLE_TRACK, "click");
    assert!(patches_contain_atom_change(
        &patches,
        ids::THEME_MODE,
        "light",
        "dark"
    ));
    assert_eq!(runtime.atom(ids::THEME_MODE), Some(Value::string("dark")));
    assert_eq!(runtime.derived(ids::BG), Some(Value::string("#111111")));
    assert_eq!(runtime.derived(ids::FG), Some(Value::string("#ffffff")));
    assert_eq!(runtime.derived(ids::THUMB_X), Some(Value::number(28)));
}

#[test]
fn clicking_twice_returns_to_light() {
    let mut runtime = rt();
    runtime.handle_event(ids::TOGGLE_TRACK, "click");
    let patches = runtime.handle_event(ids::TOGGLE_TRACK, "click");
    assert!(patches_contain_atom_change(
        &patches,
        ids::THEME_MODE,
        "dark",
        "light"
    ));
    assert_eq!(runtime.atom(ids::THEME_MODE), Some(Value::string("light")));
    assert_eq!(runtime.derived(ids::THUMB_X), Some(Value::number(0)));
}

#[test]
fn style_patches_only_include_affected_properties() {
    let mut runtime = rt();
    let patches = runtime.handle_event(ids::TOGGLE_TRACK, "click");

    // Every StyleChanged patch must target a property that actually
    // depends (directly or transitively) on ThemeMode. Constants like
    // "minHeight" must never appear in the patch list.
    for p in &patches {
        if let Patch::StyleChanged { property, .. } = p {
            assert!(
                matches!(
                    property.as_str(),
                    "background" | "color" | "translateX"
                ),
                "unexpected style patch for property `{property}`"
            );
        }
    }

    // Specifically, properties on appRoot like minHeight/display/placeItems
    // should not appear.
    assert!(!patches.iter().any(|p| matches!(
        p,
        Patch::StyleChanged { property, .. }
        if matches!(property.as_str(), "minHeight" | "display" | "placeItems" | "width" | "height" | "borderRadius" | "padding" | "cursor")
    )));
}

#[test]
fn effect_does_not_mutate_style_nodes_directly() {
    // The architectural invariant: ToggleTheme only WRITEs ThemeMode.
    // Stylesheet node `data` (the StyleValue rules) is identical before
    // and after the click — only resolved values in the runtime's style
    // cache change.
    let mut runtime = rt();
    let sheet_before = clone_stylesheet_rules(&runtime, ids::APP_STYLES);
    let toggle_before = clone_stylesheet_rules(&runtime, ids::TOGGLE_STYLES);

    runtime.handle_event(ids::TOGGLE_TRACK, "click");

    let sheet_after = clone_stylesheet_rules(&runtime, ids::APP_STYLES);
    let toggle_after = clone_stylesheet_rules(&runtime, ids::TOGGLE_STYLES);

    assert_eq!(sheet_before, sheet_after, "AppStyles node data mutated");
    assert_eq!(toggle_before, toggle_after, "ToggleStyles node data mutated");
}

#[test]
fn bg_fg_thumbx_recompute_through_dependencies() {
    let mut runtime = rt();
    let patches = runtime.handle_event(ids::TOGGLE_TRACK, "click");

    // All three derived nodes should appear as DerivedChanged patches.
    let derived_changes: Vec<&str> = patches
        .iter()
        .filter_map(|p| match p {
            Patch::DerivedChanged { node, .. } => Some(node.as_str()),
            _ => None,
        })
        .collect();
    assert!(derived_changes.contains(&ids::BG));
    assert!(derived_changes.contains(&ids::FG));
    assert!(derived_changes.contains(&ids::THUMB_X));
}

#[test]
fn event_dispatch_resolves_via_source_element_and_event_name() {
    let mut runtime = rt();
    let patches = runtime.handle_event(ids::TOGGLE_TRACK, "click");
    let event_handled: Vec<(&str, &str)> = patches
        .iter()
        .filter_map(|p| match p {
            Patch::EventHandled { cause, effect } => Some((cause.as_str(), effect.as_str())),
            _ => None,
        })
        .collect();
    assert_eq!(event_handled, vec![(ids::TOGGLE_CLICK, ids::TOGGLE_THEME)]);
}

#[test]
fn unknown_event_returns_empty_patches() {
    let mut runtime = rt();

    // Wrong element.
    assert!(runtime.handle_event(ids::APP_ROOT, "click").is_empty());
    // Wrong event name on the right element.
    assert!(runtime.handle_event(ids::TOGGLE_TRACK, "mouseenter").is_empty());
    // Element that doesn't exist.
    assert!(runtime.handle_event("nope", "click").is_empty());

    // None of these should have changed state.
    assert_eq!(runtime.atom(ids::THEME_MODE), Some(Value::string("light")));
}

#[test]
fn cypher_dump_includes_all_sections_and_reflects_state() {
    let mut runtime = rt();
    let dump = runtime.cypher_dump();

    // All five section headers present.
    for header in [
        "// ── nodes",
        "// ── edges",
        "// ── atoms",
        "// ── derived",
        "// ── bindings",
    ] {
        assert!(dump.contains(header), "missing section header: {header}");
    }

    // Spot-check a node line and an edge line.
    assert!(dump.contains("(App:Component"));
    assert!(dump.contains("(toggleTrack:Element"));
    assert!(dump.contains("(App)-[:RENDERS]->(appRoot)"));
    assert!(dump.contains("(Bg)-[:USES]->(LightBg)"));

    // Initial state visible.
    assert!(dump.contains("ThemeMode = \"light\""));
    assert!(dump.contains("Bg = \"#ffffff\""));
    assert!(dump.contains("ThumbX = 0"));

    // After clicking, atom and derived rows should reflect the new state.
    runtime.handle_event(ids::TOGGLE_TRACK, "click");
    let dump = runtime.cypher_dump();
    assert!(dump.contains("ThemeMode = \"dark\""));
    assert!(dump.contains("Bg = \"#111111\""));
    assert!(dump.contains("ThumbX = 28"));
}

#[test]
fn event_bindings_in_snapshot_match_graph() {
    let runtime = rt();
    let snap = runtime.materialize(false);
    assert_eq!(snap.bindings.len(), 1);
    let b = &snap.bindings[0];
    assert_eq!(b.element, ids::TOGGLE_TRACK);
    assert_eq!(b.event, "click");
    assert_eq!(b.cause, ids::TOGGLE_CLICK);
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

// ─── Counter app: exercises IncrementBy + FormatTemplate ──────────────────

#[test]
fn counter_app_increment_propagates_through_format_template() {
    use mini_runtime::graph::{Edge, EdgeKind, Graph, Node, NodeData, TextSource};
    use mini_runtime::runtime::{DerivedKind, EffectKind};
    use std::collections::BTreeMap;

    let mut g = Graph::new();
    g.root = Some("App".into());
    g.add_node(Node::new("App", "App", NodeData::Component));
    g.add_node(Node::new(
        "root",
        "root",
        NodeData::Element {
            tag: "div".into(),
            text: None,
            attrs: BTreeMap::new(),
        },
    ));
    g.add_node(Node::new(
        "Count",
        "Count",
        NodeData::Atom {
            value: Value::number(0),
        },
    ));
    g.add_node(Node::new(
        "Label",
        "Label",
        NodeData::Derived {
            kind: DerivedKind::FormatTemplate {
                template: "Count: {}".into(),
            },
        },
    ));
    g.add_node(Node::new(
        "display",
        "display",
        NodeData::Element {
            tag: "span".into(),
            text: Some(TextSource::Ref { id: "Label".into() }),
            attrs: BTreeMap::new(),
        },
    ));
    g.add_node(Node::new(
        "btn",
        "btn",
        NodeData::Element {
            tag: "button".into(),
            text: Some(TextSource::Literal {
                value: Value::string("+1"),
            }),
            attrs: BTreeMap::new(),
        },
    ));
    g.add_node(Node::new(
        "IncClick",
        "IncClick",
        NodeData::Cause {
            source: "btn".into(),
            event: "click".into(),
        },
    ));
    g.add_node(Node::new(
        "IncBy1",
        "IncBy1",
        NodeData::Effect {
            kind: EffectKind::IncrementBy { amount: 1.0 },
        },
    ));
    g.add_edge(Edge::new("App", "root", EdgeKind::Renders));
    g.add_edge(Edge::new("root", "display", EdgeKind::Contains));
    g.add_edge(Edge::new("root", "btn", EdgeKind::Contains));
    g.add_edge(Edge::new("Label", "Count", EdgeKind::Reads));
    g.add_edge(Edge::new("App", "IncClick", EdgeKind::HasCause));
    g.add_edge(Edge::new("IncClick", "IncBy1", EdgeKind::Triggers));
    g.add_edge(Edge::new("IncBy1", "Count", EdgeKind::Reads));
    g.add_edge(Edge::new("IncBy1", "Count", EdgeKind::Writes));

    let mut rt = Runtime::new(g);

    // Initial snapshot: Label resolves to "Count: 0".
    let snap = rt.materialize(false);
    let display_text = find_text(&snap.render_tree, "display").unwrap();
    assert_eq!(display_text, "Count: 0");
    // Button text is a literal.
    let btn_text = find_text(&snap.render_tree, "btn").unwrap();
    assert_eq!(btn_text, "+1");

    // Click once.
    let patches = rt.handle_event("btn", "click");
    assert!(patches.iter().any(|p| matches!(
        p,
        Patch::AtomChanged { node, new, .. } if node == "Count" && new == &Value::number(1)
    )));
    assert!(patches.iter().any(|p| matches!(
        p,
        Patch::DerivedChanged { node, new, .. } if node == "Label" && new == &Value::string("Count: 1")
    )));

    // Three more clicks → count = 4, label = "Count: 4".
    for _ in 0..3 {
        rt.handle_event("btn", "click");
    }
    assert_eq!(rt.atom("Count"), Some(Value::number(4)));
    assert_eq!(rt.derived("Label"), Some(Value::string("Count: 4")));
}

#[test]
fn repeat_node_expands_list_items_into_children() {
    // Append two items to a list atom, then materialize and verify the
    // render tree contains two iteration copies, each carrying its
    // resolved item text.
    use mini_runtime::graph::{Edge, EdgeKind, Graph, Node, NodeData, TextSource};
    use mini_runtime::runtime::EffectKind;
    use std::collections::BTreeMap;

    let mut g = Graph::new();
    g.root = Some("App".into());
    g.add_node(Node::new("App", "App", NodeData::Component));
    g.add_node(Node::new(
        "list",
        "list",
        NodeData::Element {
            tag: "ul".into(),
            text: None,
            attrs: BTreeMap::new(),
        },
    ));
    g.add_node(Node::new(
        "item",
        "item",
        NodeData::Element {
            tag: "li".into(),
            text: Some(TextSource::ItemValue),
            attrs: BTreeMap::new(),
        },
    ));
    g.add_node(Node::new(
        "items_repeat",
        "items_repeat",
        NodeData::Repeat {
            source: "Items".into(),
            template: "item".into(),
        },
    ));
    g.add_node(Node::new(
        "Items",
        "Items",
        NodeData::Atom {
            value: Value::List(vec![Value::string("alpha"), Value::string("beta")]),
        },
    ));
    g.add_edge(Edge::new("App", "list", EdgeKind::Renders));
    g.add_edge(Edge::new("list", "items_repeat", EdgeKind::Contains));

    let rt = Runtime::new(g);
    let snap = rt.materialize(false);
    let list = &snap.render_tree.children[0];
    assert_eq!(list.id, "list");
    assert_eq!(list.children.len(), 2);
    assert_eq!(list.children[0].text.as_deref(), Some("alpha"));
    assert_eq!(list.children[1].text.as_deref(), Some("beta"));
    // Both rendered children share the template id but represent different items.
    assert_eq!(list.children[0].id, "item");
    assert_eq!(list.children[1].id, "item");
}

#[test]
fn repeat_appends_react_to_atom_change() {
    // Use AppendInputToList to drive list growth, verify repeat picks up.
    use mini_runtime::graph::{Edge, EdgeKind, Graph, Node, NodeData, TextSource};
    use mini_runtime::runtime::EffectKind;
    use std::collections::BTreeMap;

    let mut g = Graph::new();
    g.root = Some("App".into());
    g.add_node(Node::new("App", "App", NodeData::Component));
    g.add_node(Node::new(
        "list",
        "list",
        NodeData::Element {
            tag: "ul".into(),
            text: None,
            attrs: BTreeMap::new(),
        },
    ));
    g.add_node(Node::new(
        "item",
        "item",
        NodeData::Element {
            tag: "li".into(),
            text: Some(TextSource::ItemValue),
            attrs: BTreeMap::new(),
        },
    ));
    g.add_node(Node::new(
        "rep",
        "rep",
        NodeData::Repeat {
            source: "Items".into(),
            template: "item".into(),
        },
    ));
    g.add_node(Node::new(
        "Items",
        "Items",
        NodeData::Atom {
            value: Value::List(vec![]),
        },
    ));
    g.add_node(Node::new(
        "input",
        "input",
        NodeData::Element {
            tag: "input".into(),
            text: None,
            attrs: BTreeMap::new(),
        },
    ));
    g.add_node(Node::new(
        "Add",
        "Add",
        NodeData::Cause {
            source: "input".into(),
            event: "change".into(),
        },
    ));
    g.add_node(Node::new(
        "AppendEff",
        "AppendEff",
        NodeData::Effect {
            kind: EffectKind::AppendInputToList,
        },
    ));

    g.add_edge(Edge::new("App", "list", EdgeKind::Renders));
    g.add_edge(Edge::new("list", "rep", EdgeKind::Contains));
    g.add_edge(Edge::new("App", "input", EdgeKind::Renders));
    g.add_edge(Edge::new("App", "Add", EdgeKind::HasCause));
    g.add_edge(Edge::new("Add", "AppendEff", EdgeKind::Triggers));
    g.add_edge(Edge::new("AppendEff", "Items", EdgeKind::Writes));

    let mut rt = Runtime::new(g);
    rt.dispatch_event("input", "change", Some(Value::string("buy milk")));
    rt.dispatch_event("input", "change", Some(Value::string("walk dog")));

    let snap = rt.materialize(false);
    // Find the list element among the App's rendered children.
    let list = snap
        .render_tree
        .children
        .iter()
        .find(|c| c.id == "list")
        .expect("list rendered");
    assert_eq!(list.children.len(), 2);
    assert_eq!(list.children[0].text.as_deref(), Some("buy milk"));
    assert_eq!(list.children[1].text.as_deref(), Some("walk dog"));
}

#[test]
fn derived_kinds_with_multi_word_fields_use_camelcase() {
    // Regression: Claude correctly emits camelCase field names
    // (whenTrue/whenFalse, compareTo). The Rust enum must deserialize
    // those, not snake_case. Without rename_all_fields = "camelCase",
    // payloads with `conditional` or `equalsLiteral` would fail to
    // deserialize and crash the WASM boundary.
    use mini_runtime::graph::{Graph, GraphPayload};
    let json = r#"{
        "root": "App",
        "nodes": [
            { "id": "App", "name": "App", "type": "component" },
            { "id": "Flag", "name": "Flag", "type": "atom", "value": true },
            { "id": "Style", "name": "Style", "type": "derived",
              "op": "conditional", "whenTrue": "line-through", "whenFalse": "none" },
            { "id": "IsFive", "name": "IsFive", "type": "derived",
              "op": "equalsLiteral", "compareTo": 5 }
        ],
        "edges": [
            { "from": "Style", "to": "Flag", "kind": "reads" },
            { "from": "IsFive", "to": "Flag", "kind": "reads" }
        ]
    }"#;
    let payload: GraphPayload =
        serde_json::from_str(json).expect("camelCase derived fields must deserialize");
    let rt = Runtime::new(Graph::from_payload(payload));
    assert_eq!(rt.derived("Style"), Some(Value::string("line-through")));
    assert_eq!(rt.derived("IsFive"), Some(Value::Bool(false)));
}

#[test]
fn cyclic_graph_does_not_overflow_the_stack() {
    // Simulates the kind of malformed render tree the LLM might emit:
    // Element A → Component B → Element A. Without cycle detection this
    // would recurse forever and overflow the WASM stack ("memory access
    // out of bounds").
    use mini_runtime::graph::{Edge, EdgeKind, Graph, Node, NodeData};
    use std::collections::BTreeMap;
    let mut g = Graph::new();
    g.root = Some("App".into());
    g.add_node(Node::new("App", "App", NodeData::Component));
    g.add_node(Node::new(
        "elemA",
        "elemA",
        NodeData::Element {
            tag: "div".into(),
            text: None,
            attrs: BTreeMap::new(),
        },
    ));
    g.add_node(Node::new("CompB", "CompB", NodeData::Component));
    g.add_edge(Edge::new("App", "elemA", EdgeKind::Renders));
    g.add_edge(Edge::new("elemA", "CompB", EdgeKind::Contains));
    g.add_edge(Edge::new("CompB", "elemA", EdgeKind::Renders)); // cycle!

    let rt = Runtime::new(g);
    // If this overflows we never get here.
    let snap = rt.materialize(false);
    assert_eq!(snap.render_tree.id, "App");
    // The cycle should be broken: elemA appears once.
    let mut elem_a_count = 0;
    walk(&snap.render_tree, &mut |n| {
        if n.id == "elemA" {
            elem_a_count += 1;
        }
    });
    assert_eq!(elem_a_count, 1, "elemA must render exactly once even though a cycle reaches it twice");
}

fn walk(node: &mini_runtime::RenderNode, f: &mut impl FnMut(&mini_runtime::RenderNode)) {
    f(node);
    for c in &node.children {
        walk(c, f);
    }
}

#[test]
fn graph_payload_round_trips_through_json() {
    // Build the toggle app, serialize it, parse it back, and verify the
    // round-tripped runtime behaves identically.
    use mini_runtime::graph::GraphPayload;
    use mini_runtime::toggle_app::build_toggle_app;

    let original = build_toggle_app();
    let payload = original.to_payload();
    let json = serde_json::to_string(&payload).expect("serialize");
    let parsed: GraphPayload = serde_json::from_str(&json).expect("deserialize");

    let mut rt = Runtime::new(mini_runtime::graph::Graph::from_payload(parsed));
    assert_eq!(rt.atom(ids::THEME_MODE), Some(Value::string("light")));
    rt.handle_event(ids::TOGGLE_TRACK, "click");
    assert_eq!(rt.atom(ids::THEME_MODE), Some(Value::string("dark")));
}

#[test]
fn ai_generator_shape_loads_into_runtime() {
    // Mirror what the server emits: a counter app graph. If the shape
    // here gets out of sync with the system prompt the LLM uses, this
    // test fails fast.
    use mini_runtime::graph::{Graph, GraphPayload};

    let json = r##"{
      "root": "App",
      "nodes": [
        { "id": "App", "name": "App", "type": "component" },
        { "id": "appRoot", "name": "appRoot", "type": "element", "tag": "div" },
        { "id": "display", "name": "display", "type": "element", "tag": "div",
          "text": { "kind": "ref", "id": "Count" } },
        { "id": "btn", "name": "btn", "type": "element", "tag": "button",
          "text": { "kind": "literal", "value": "+1" } },
        { "id": "Count", "name": "Count", "type": "atom", "value": 0 },
        { "id": "AppStyles", "name": "AppStyles", "type": "styleSheet", "rules": {
            "appRoot": { "background": { "kind": "literal", "value": "#fff" } }
        } },
        { "id": "Click", "name": "Click", "type": "cause", "source": "btn", "event": "click" },
        { "id": "Inc", "name": "Inc", "type": "effect", "op": "incrementBy", "amount": 1 }
      ],
      "edges": [
        { "from": "App", "to": "appRoot", "kind": "renders" },
        { "from": "appRoot", "to": "display", "kind": "contains" },
        { "from": "appRoot", "to": "btn", "kind": "contains" },
        { "from": "App", "to": "Click", "kind": "hasCause" },
        { "from": "Click", "to": "Inc", "kind": "triggers" },
        { "from": "Inc", "to": "Count", "kind": "reads" },
        { "from": "Inc", "to": "Count", "kind": "writes" },
        { "from": "AppStyles", "to": "appRoot", "kind": "targets" }
      ]
    }"##;
    let payload: GraphPayload = serde_json::from_str(json).expect("deserialize counter app");
    let mut rt = Runtime::new(Graph::from_payload(payload));

    assert_eq!(rt.atom("Count"), Some(Value::number(0)));
    rt.handle_event("btn", "click");
    rt.handle_event("btn", "click");
    rt.handle_event("btn", "click");
    assert_eq!(rt.atom("Count"), Some(Value::number(3)));
}

#[test]
fn input_change_event_writes_to_bound_atom() {
    use mini_runtime::graph::{Edge, EdgeKind, Graph, Node, NodeData, TextSource};
    use mini_runtime::runtime::EffectKind;
    use std::collections::BTreeMap;

    let mut g = Graph::new();
    g.root = Some("App".into());
    g.add_node(Node::new("App", "App", NodeData::Component));
    g.add_node(Node::new(
        "input",
        "input",
        NodeData::Element {
            tag: "input".into(),
            text: Some(TextSource::Ref { id: "Name".into() }),
            attrs: BTreeMap::new(),
        },
    ));
    g.add_node(Node::new(
        "Name",
        "Name",
        NodeData::Atom {
            value: Value::string(""),
        },
    ));
    g.add_node(Node::new(
        "InputChange",
        "InputChange",
        NodeData::Cause {
            source: "input".into(),
            event: "change".into(),
        },
    ));
    g.add_node(Node::new(
        "WriteName",
        "WriteName",
        NodeData::Effect {
            kind: EffectKind::SetAtomFromInput,
        },
    ));
    g.add_edge(Edge::new("App", "input", EdgeKind::Renders));
    g.add_edge(Edge::new("App", "InputChange", EdgeKind::HasCause));
    g.add_edge(Edge::new("InputChange", "WriteName", EdgeKind::Triggers));
    g.add_edge(Edge::new("WriteName", "Name", EdgeKind::Writes));

    let mut rt = Runtime::new(g);
    let patches = rt.dispatch_event("input", "change", Some(Value::string("Tom")));
    assert!(patches.iter().any(|p| matches!(
        p,
        Patch::AtomChanged { node, new, .. } if node == "Name" && new == &Value::string("Tom")
    )));
    assert_eq!(rt.atom("Name"), Some(Value::string("Tom")));
}

fn find_text<'a>(node: &'a mini_runtime::RenderNode, id: &str) -> Option<&'a str> {
    if node.id == id {
        return node.text.as_deref();
    }
    for c in &node.children {
        if let Some(t) = find_text(c, id) {
            return Some(t);
        }
    }
    None
}

fn patches_contain_atom_change(patches: &[Patch], node: &str, old: &str, new: &str) -> bool {
    patches.iter().any(|p| match p {
        Patch::AtomChanged {
            node: n,
            old: o,
            new: nw,
        } => n == node && o == &Value::string(old) && nw == &Value::string(new),
        _ => false,
    })
}

fn clone_stylesheet_rules(
    runtime: &Runtime,
    sheet_id: &str,
) -> std::collections::BTreeMap<String, std::collections::BTreeMap<String, mini_runtime::graph::StyleValue>>
{
    use mini_runtime::graph::NodeData;
    match runtime.graph.node(sheet_id).map(|n| &n.data) {
        Some(NodeData::StyleSheet { rules }) => rules.clone(),
        _ => Default::default(),
    }
}
