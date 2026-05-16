//! Edge type and EdgeKind enum.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EdgeKind {
    // ── original MVP
    Contains,
    Imports,
    Renders,
    ChildOf,
    References,
    Styles,
    BindsProp,
    Declares,
    EntryFor,
    // ── expanded semantic relationships
    Composes,
    OwnsState,
    ReadsState,
    WritesState,
    Triggers,
    Handles,
    Calls,
    FetchesFrom,
    BindsTo,
    StyledBy,
    UsesToken,
    ParticipatesInLayout,
    NavigatesTo,
    Represents,
    ImplementsIntent,
    Affects,
    CorrespondsTo,
    // ── upward abstraction edges (mechanical -> semantic -> UI)
    ContributesTo,
    Abstracts,
    RepresentedBy,
    ControlledBy,
    // ── editing/behavior edges
    Controls,
    TriggeredBy,
    TransitionsTo,
    BranchesTo,
    Patches,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Edge {
    pub id: String,
    #[serde(default)]
    pub project_id: String,
    pub from_node_id: String,
    pub to_node_id: String,
    #[serde(rename = "type")]
    pub kind: EdgeKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<i32>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub created_at: String,
}

impl Edge {
    pub fn new(
        id: impl Into<String>,
        from: impl Into<String>,
        to: impl Into<String>,
        kind: EdgeKind,
    ) -> Self {
        Edge {
            id: id.into(),
            project_id: String::new(),
            from_node_id: from.into(),
            to_node_id: to.into(),
            kind,
            data: None,
            order: None,
            created_at: String::new(),
        }
    }

    pub fn with_order(mut self, order: i32) -> Self {
        self.order = Some(order);
        self
    }

    pub fn with_data(mut self, data: serde_json::Value) -> Self {
        self.data = Some(data);
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn edge_kind_round_trip() {
        let k = EdgeKind::ContributesTo;
        let s = serde_json::to_string(&k).unwrap();
        assert_eq!(s, "\"contributes_to\"");
        let back: EdgeKind = serde_json::from_str(&s).unwrap();
        assert_eq!(back, k);
    }

    #[test]
    fn edge_wire_format() {
        let e = Edge::new("e1", "n1", "n2", EdgeKind::Renders).with_order(0);
        let s = serde_json::to_string(&e).unwrap();
        // Match ecto-engine wire format: type, fromNodeId, toNodeId
        assert!(s.contains("\"type\":\"renders\""));
        assert!(s.contains("\"fromNodeId\":\"n1\""));
        assert!(s.contains("\"toNodeId\":\"n2\""));
        assert!(s.contains("\"order\":0"));
    }
}
