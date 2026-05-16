//! Fixture: builds the light/dark toggle app's graph exactly as described
//! in the runtime spec. Reused by tests, the example, and the seed graph
//! the web shell loads on startup.

use std::collections::BTreeMap;

use crate::graph::{Edge, EdgeKind, Graph, Node, NodeData, NodeId, StyleValue};
use crate::runtime::{DerivedKind, EffectKind};
use crate::value::Value;

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
    g.root = Some(APP.into());

    g.add_node(Node::new(APP, "App", NodeData::Component));
    g.add_node(Node::new(TOGGLE, "Toggle", NodeData::Component));

    g.add_node(element(APP_ROOT, "appRoot", "div"));
    g.add_node(element(TOGGLE_TRACK, "toggleTrack", "div"));
    g.add_node(element(TOGGLE_THUMB, "toggleThumb", "div"));

    g.add_node(Node::new(
        THEME_MODE,
        "ThemeMode",
        NodeData::Atom {
            value: Value::string("light"),
        },
    ));

    g.add_node(token(LIGHT_BG, "LightBg", "#ffffff"));
    g.add_node(token(LIGHT_FG, "LightFg", "#111111"));
    g.add_node(token(DARK_BG, "DarkBg", "#111111"));
    g.add_node(token(DARK_FG, "DarkFg", "#ffffff"));

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

    g.add_edge(Edge::new(APP, APP_ROOT, EdgeKind::Renders));
    g.add_edge(Edge::new(APP_ROOT, TOGGLE, EdgeKind::Contains));
    g.add_edge(Edge::new(TOGGLE, TOGGLE_TRACK, EdgeKind::Renders));
    g.add_edge(Edge::new(TOGGLE_TRACK, TOGGLE_THUMB, EdgeKind::Contains));

    g.add_edge(Edge::new(TOGGLE, TOGGLE_CLICK, EdgeKind::HasCause));
    g.add_edge(Edge::new(TOGGLE_CLICK, TOGGLE_THEME, EdgeKind::Triggers));
    g.add_edge(Edge::new(TOGGLE_THEME, THEME_MODE, EdgeKind::Reads));
    g.add_edge(Edge::new(TOGGLE_THEME, THEME_MODE, EdgeKind::Writes));

    g.add_edge(Edge::new(BG, THEME_MODE, EdgeKind::Reads));
    g.add_edge(Edge::new(BG, LIGHT_BG, EdgeKind::Uses));
    g.add_edge(Edge::new(BG, DARK_BG, EdgeKind::Uses));
    g.add_edge(Edge::new(FG, THEME_MODE, EdgeKind::Reads));
    g.add_edge(Edge::new(FG, LIGHT_FG, EdgeKind::Uses));
    g.add_edge(Edge::new(FG, DARK_FG, EdgeKind::Uses));
    g.add_edge(Edge::new(THUMB_X, THEME_MODE, EdgeKind::Reads));

    g.add_edge(Edge::new(APP_STYLES, APP_ROOT, EdgeKind::Targets));
    g.add_edge(Edge::new(APP_STYLES, BG, EdgeKind::Uses));
    g.add_edge(Edge::new(APP_STYLES, FG, EdgeKind::Uses));
    g.add_edge(Edge::new(TOGGLE_STYLES, TOGGLE_TRACK, EdgeKind::Targets));
    g.add_edge(Edge::new(TOGGLE_STYLES, TOGGLE_THUMB, EdgeKind::Targets));
    g.add_edge(Edge::new(TOGGLE_STYLES, BG, EdgeKind::Uses));
    g.add_edge(Edge::new(TOGGLE_STYLES, FG, EdgeKind::Uses));
    g.add_edge(Edge::new(TOGGLE_STYLES, THUMB_X, EdgeKind::Uses));

    g.add_edge(Edge::new(TOGGLE, TOGGLE_DOC, EdgeKind::HasDoc));
    g.add_edge(Edge::new(TOGGLE, TOGGLE_UI, EdgeKind::HasUi));

    g
}

fn element(id: &str, name: &str, tag: &str) -> Node {
    Node::new(
        id,
        name,
        NodeData::Element {
            tag: tag.into(),
            text: None,
            attrs: BTreeMap::new(),
        },
    )
}

fn token(id: &str, name: &str, value: &str) -> Node {
    Node::new(
        id,
        name,
        NodeData::Token {
            value: Value::string(value),
        },
    )
}

fn app_styles_rules() -> BTreeMap<NodeId, BTreeMap<String, StyleValue>> {
    let mut rules: BTreeMap<NodeId, BTreeMap<String, StyleValue>> = BTreeMap::new();
    let mut app_root: BTreeMap<String, StyleValue> = BTreeMap::new();
    app_root.insert("background".into(), StyleValue::Ref { id: ids::BG.into() });
    app_root.insert("color".into(), StyleValue::Ref { id: ids::FG.into() });
    app_root.insert(
        "minHeight".into(),
        StyleValue::Literal {
            value: Value::string("100vh"),
        },
    );
    app_root.insert(
        "display".into(),
        StyleValue::Literal {
            value: Value::string("grid"),
        },
    );
    app_root.insert(
        "placeItems".into(),
        StyleValue::Literal {
            value: Value::string("center"),
        },
    );
    rules.insert(ids::APP_ROOT.into(), app_root);
    rules
}

fn toggle_styles_rules() -> BTreeMap<NodeId, BTreeMap<String, StyleValue>> {
    let mut rules: BTreeMap<NodeId, BTreeMap<String, StyleValue>> = BTreeMap::new();

    let mut track: BTreeMap<String, StyleValue> = BTreeMap::new();
    track.insert("background".into(), StyleValue::Ref { id: ids::FG.into() });
    track.insert("color".into(), StyleValue::Ref { id: ids::BG.into() });
    track.insert(
        "width".into(),
        StyleValue::Literal {
            value: Value::number(64),
        },
    );
    track.insert(
        "height".into(),
        StyleValue::Literal {
            value: Value::number(36),
        },
    );
    track.insert(
        "borderRadius".into(),
        StyleValue::Literal {
            value: Value::number(999),
        },
    );
    track.insert(
        "padding".into(),
        StyleValue::Literal {
            value: Value::number(4),
        },
    );
    track.insert(
        "cursor".into(),
        StyleValue::Literal {
            value: Value::string("pointer"),
        },
    );
    rules.insert(ids::TOGGLE_TRACK.into(), track);

    let mut thumb: BTreeMap<String, StyleValue> = BTreeMap::new();
    thumb.insert("background".into(), StyleValue::Ref { id: ids::BG.into() });
    thumb.insert(
        "width".into(),
        StyleValue::Literal {
            value: Value::number(28),
        },
    );
    thumb.insert(
        "height".into(),
        StyleValue::Literal {
            value: Value::number(28),
        },
    );
    thumb.insert(
        "borderRadius".into(),
        StyleValue::Literal {
            value: Value::number(999),
        },
    );
    thumb.insert(
        "translateX".into(),
        StyleValue::Ref {
            id: ids::THUMB_X.into(),
        },
    );
    rules.insert(ids::TOGGLE_THUMB.into(), thumb);

    rules
}
