//! Fixture: builds the light/dark toggle app's graph exactly as described
//! in the runtime spec. Reused by tests, the example, and any host demo.

use std::collections::BTreeMap;

use crate::graph::{Edge, EdgeKind, Graph, Node, NodeData, NodeId, StyleValue};
use crate::runtime::{DerivedKind, EffectKind};
use crate::value::Value;

/// Stable node ids — exposed as constants so tests can refer to them by name
/// without stringly-typed risk.
pub mod ids {
    pub const APP: &str = "App";
    pub const APP_ROOT: &str = "appRoot";
    pub const TOGGLE: &str = "Toggle";
    pub const TOGGLE_TRACK: &str = "toggleTrack";
    pub const TOGGLE_THUMB: &str = "toggleThumb";

    pub const THEME_MODE: &str = "ThemeMode";

    pub const LIGHT_BG: &str = "LightBg";
    pub const LIGHT_FG: &str = "LightFg";
    pub const DARK_BG: &str = "DarkBg";
    pub const DARK_FG: &str = "DarkFg";

    pub const BG: &str = "Bg";
    pub const FG: &str = "Fg";
    pub const THUMB_X: &str = "ThumbX";

    pub const APP_STYLES: &str = "AppStyles";
    pub const TOGGLE_STYLES: &str = "ToggleStyles";

    pub const TOGGLE_CLICK: &str = "ToggleClick";
    pub const TOGGLE_THEME: &str = "ToggleTheme";

    pub const TOGGLE_DOC: &str = "ToggleDoc";
    pub const TOGGLE_UI: &str = "ToggleUI";
}

pub fn build_toggle_app() -> Graph {
    use ids::*;
    let mut g = Graph::new();

    // ── Components ──
    g.add_node(Node::new(APP, "App", NodeData::Component));
    g.add_node(Node::new(TOGGLE, "Toggle", NodeData::Component));

    // ── Elements ──
    g.add_node(Node::new(
        APP_ROOT,
        "appRoot",
        NodeData::Element { tag: "div".into() },
    ));
    g.add_node(Node::new(
        TOGGLE_TRACK,
        "toggleTrack",
        NodeData::Element { tag: "div".into() },
    ));
    g.add_node(Node::new(
        TOGGLE_THUMB,
        "toggleThumb",
        NodeData::Element { tag: "div".into() },
    ));

    // ── State atom ──
    g.add_node(Node::new(
        THEME_MODE,
        "ThemeMode",
        NodeData::Atom {
            value: Value::string("light"),
        },
    ));

    // ── Primitive tokens ──
    g.add_node(Node::new(
        LIGHT_BG,
        "LightBg",
        NodeData::Token {
            value: Value::string("#ffffff"),
        },
    ));
    g.add_node(Node::new(
        LIGHT_FG,
        "LightFg",
        NodeData::Token {
            value: Value::string("#111111"),
        },
    ));
    g.add_node(Node::new(
        DARK_BG,
        "DarkBg",
        NodeData::Token {
            value: Value::string("#111111"),
        },
    ));
    g.add_node(Node::new(
        DARK_FG,
        "DarkFg",
        NodeData::Token {
            value: Value::string("#ffffff"),
        },
    ));

    // ── Derived values ──
    g.add_node(Node::new(
        BG,
        "Bg",
        NodeData::Derived {
            kind: DerivedKind::ThemeBg,
        },
    ));
    g.add_node(Node::new(
        FG,
        "Fg",
        NodeData::Derived {
            kind: DerivedKind::ThemeFg,
        },
    ));
    g.add_node(Node::new(
        THUMB_X,
        "ThumbX",
        NodeData::Derived {
            kind: DerivedKind::ThumbX,
        },
    ));

    // ── Style sheets ──
    g.add_node(Node::new(
        APP_STYLES,
        "AppStyles",
        NodeData::StyleSheet {
            rules: app_styles_rules(),
        },
    ));
    g.add_node(Node::new(
        TOGGLE_STYLES,
        "ToggleStyles",
        NodeData::StyleSheet {
            rules: toggle_styles_rules(),
        },
    ));

    // ── Interaction ──
    g.add_node(Node::new(
        TOGGLE_CLICK,
        "ToggleClick",
        NodeData::Cause {
            source: TOGGLE_TRACK.into(),
            event: "click".into(),
        },
    ));
    g.add_node(Node::new(
        TOGGLE_THEME,
        "ToggleTheme",
        NodeData::Effect {
            kind: EffectKind::ToggleThemeMode,
        },
    ));

    // ── Semantic / design-mode metadata ──
    g.add_node(Node::new(
        TOGGLE_DOC,
        "ToggleDoc",
        NodeData::Doc {
            text: "Switches the app between light and dark themes.".into(),
        },
    ));
    let mut ui_meta = BTreeMap::new();
    ui_meta.insert("surface".into(), Value::string("interactive"));
    ui_meta.insert("category".into(), Value::string("control"));
    g.add_node(Node::new(
        TOGGLE_UI,
        "ToggleUI",
        NodeData::Ui { meta: ui_meta },
    ));

    // ── Edges ──
    // Render tree.
    g.add_edge(Edge::new(APP, APP_ROOT, EdgeKind::Renders));
    g.add_edge(Edge::new(APP_ROOT, TOGGLE, EdgeKind::Contains));
    g.add_edge(Edge::new(TOGGLE, TOGGLE_TRACK, EdgeKind::Renders));
    g.add_edge(Edge::new(TOGGLE_TRACK, TOGGLE_THUMB, EdgeKind::Contains));

    // Interaction graph.
    g.add_edge(Edge::new(TOGGLE, TOGGLE_CLICK, EdgeKind::HasCause));
    g.add_edge(Edge::new(TOGGLE_CLICK, TOGGLE_THEME, EdgeKind::Triggers));
    g.add_edge(Edge::new(TOGGLE_THEME, THEME_MODE, EdgeKind::Reads));
    g.add_edge(Edge::new(TOGGLE_THEME, THEME_MODE, EdgeKind::Writes));

    // Derived dependencies.
    g.add_edge(Edge::new(BG, THEME_MODE, EdgeKind::Reads));
    g.add_edge(Edge::new(BG, LIGHT_BG, EdgeKind::Uses));
    g.add_edge(Edge::new(BG, DARK_BG, EdgeKind::Uses));
    g.add_edge(Edge::new(FG, THEME_MODE, EdgeKind::Reads));
    g.add_edge(Edge::new(FG, LIGHT_FG, EdgeKind::Uses));
    g.add_edge(Edge::new(FG, DARK_FG, EdgeKind::Uses));
    g.add_edge(Edge::new(THUMB_X, THEME_MODE, EdgeKind::Reads));

    // Stylesheet bindings.
    g.add_edge(Edge::new(APP_STYLES, APP_ROOT, EdgeKind::Targets));
    g.add_edge(Edge::new(APP_STYLES, BG, EdgeKind::Uses));
    g.add_edge(Edge::new(APP_STYLES, FG, EdgeKind::Uses));
    g.add_edge(Edge::new(TOGGLE_STYLES, TOGGLE_TRACK, EdgeKind::Targets));
    g.add_edge(Edge::new(TOGGLE_STYLES, TOGGLE_THUMB, EdgeKind::Targets));
    g.add_edge(Edge::new(TOGGLE_STYLES, BG, EdgeKind::Uses));
    g.add_edge(Edge::new(TOGGLE_STYLES, FG, EdgeKind::Uses));
    g.add_edge(Edge::new(TOGGLE_STYLES, THUMB_X, EdgeKind::Uses));

    // Semantic edges.
    g.add_edge(Edge::new(TOGGLE, TOGGLE_DOC, EdgeKind::HasDoc));
    g.add_edge(Edge::new(TOGGLE, TOGGLE_UI, EdgeKind::HasUi));

    g
}

fn app_styles_rules() -> BTreeMap<NodeId, BTreeMap<String, StyleValue>> {
    let mut rules: BTreeMap<NodeId, BTreeMap<String, StyleValue>> = BTreeMap::new();
    let mut app_root: BTreeMap<String, StyleValue> = BTreeMap::new();
    app_root.insert("background".into(), StyleValue::Ref(ids::BG.into()));
    app_root.insert("color".into(), StyleValue::Ref(ids::FG.into()));
    app_root.insert(
        "minHeight".into(),
        StyleValue::Literal(Value::string("100vh")),
    );
    app_root.insert(
        "display".into(),
        StyleValue::Literal(Value::string("grid")),
    );
    app_root.insert(
        "placeItems".into(),
        StyleValue::Literal(Value::string("center")),
    );
    rules.insert(ids::APP_ROOT.into(), app_root);
    rules
}

fn toggle_styles_rules() -> BTreeMap<NodeId, BTreeMap<String, StyleValue>> {
    let mut rules: BTreeMap<NodeId, BTreeMap<String, StyleValue>> = BTreeMap::new();

    let mut track: BTreeMap<String, StyleValue> = BTreeMap::new();
    track.insert("background".into(), StyleValue::Ref(ids::FG.into()));
    track.insert("color".into(), StyleValue::Ref(ids::BG.into()));
    track.insert("width".into(), StyleValue::Literal(Value::number(64)));
    track.insert("height".into(), StyleValue::Literal(Value::number(36)));
    track.insert("borderRadius".into(), StyleValue::Literal(Value::number(999)));
    track.insert("padding".into(), StyleValue::Literal(Value::number(4)));
    track.insert(
        "cursor".into(),
        StyleValue::Literal(Value::string("pointer")),
    );
    rules.insert(ids::TOGGLE_TRACK.into(), track);

    let mut thumb: BTreeMap<String, StyleValue> = BTreeMap::new();
    thumb.insert("background".into(), StyleValue::Ref(ids::BG.into()));
    thumb.insert("width".into(), StyleValue::Literal(Value::number(28)));
    thumb.insert("height".into(), StyleValue::Literal(Value::number(28)));
    thumb.insert("borderRadius".into(), StyleValue::Literal(Value::number(999)));
    thumb.insert("translateX".into(), StyleValue::Ref(ids::THUMB_X.into()));
    rules.insert(ids::TOGGLE_THUMB.into(), thumb);

    rules
}
