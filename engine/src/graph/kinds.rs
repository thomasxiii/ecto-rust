//! Node and edge kind enums + layer/capability enums.
//!
//! Variants use serde rename_all = "snake_case" so the wire JSON matches
//! ecto-engine's TS union literals (`"semantic_component"`, `"renders"`,
//! etc) verbatim.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeKind {
    // ── original MVP
    File,
    Module,
    Import,
    Component,
    Element,
    Text,
    Prop,
    State,
    Style,
    Function,
    Route,
    Asset,
    // ── expanded
    Export,
    UiElement,
    StateField,
    Event,
    Action,
    AsyncOperation,
    ApiEndpoint,
    DataModel,
    StyleToken,
    StyleRule,
    LayoutContainer,
    RenderedInstance,
    Intent,
    Summary,
    // ── semantic layer
    SemanticComponent,
    SemanticElement,
    SemanticStyle,
    SemanticState,
    SemanticInteraction,
    SemanticFlow,
    // ── UI / editing layer
    UiSelectable,
    UiStyleSurface,
    UiLayoutSurface,
    UiInteractionSurface,
    UiVariantSurface,
    // ── npm sidecar (external code integration)
    //
    // NpmPackage: declares a dependency on an npm package. data carries
    //   { name, version, target: "browser" | "server", exports: string[] }.
    //   The server bundler compiles each unique (name, version, exports)
    //   triple into a bundle hash that lives in data.bundleHash once built.
    //
    // NpmExport: a specific named export from an NpmPackage. data carries
    //   { exportName, kind: "component" | "hook" | "function" | "value" }.
    //   Linked to its parent NpmPackage with a `contains` edge.
    //
    // ServerFunction: a graph-defined function whose body runs in the
    //   server-side Node sidecar subprocess. data carries
    //   { body, params, returnShape }. May reference NpmExport nodes via
    //   `uses_npm_export` edges to access external libraries.
    NpmPackage,
    NpmExport,
    ServerFunction,
}

impl NodeKind {
    pub fn layer(self) -> Layer {
        use NodeKind::*;
        match self {
            SemanticComponent | SemanticElement | SemanticStyle | SemanticState
            | SemanticInteraction | SemanticFlow => Layer::Semantic,
            UiSelectable | UiStyleSurface | UiLayoutSurface | UiInteractionSurface
            | UiVariantSurface => Layer::Ui,
            _ => Layer::Mechanical,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Layer {
    Mechanical,
    Semantic,
    Ui,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Capability {
    Selectable,
    Styleable,
    Layoutable,
    TextEditable,
    Bindable,
    EventSource,
    StateConsumer,
    StateProducer,
    Variantable,
    Animatable,
    InteractionEditable,
    Promptable,
    Patchable,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn npm_node_kinds_serialize_snake_case() {
        for (kind, wire) in [
            (NodeKind::NpmPackage, "\"npm_package\""),
            (NodeKind::NpmExport, "\"npm_export\""),
            (NodeKind::ServerFunction, "\"server_function\""),
        ] {
            let s = serde_json::to_string(&kind).unwrap();
            assert_eq!(s, wire);
            let back: NodeKind = serde_json::from_str(&s).unwrap();
            assert_eq!(back, kind);
        }
    }

    #[test]
    fn npm_node_kinds_default_to_mechanical_layer() {
        // Sidecar nodes are mechanical — they describe real runtime
        // resources, not semantic/UI abstractions.
        assert_eq!(NodeKind::NpmPackage.layer(), Layer::Mechanical);
        assert_eq!(NodeKind::NpmExport.layer(), Layer::Mechanical);
        assert_eq!(NodeKind::ServerFunction.layer(), Layer::Mechanical);
    }
}
