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
