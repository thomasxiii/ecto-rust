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
