//! Wire-protocol types beyond Node/Edge: mutations, events, agent ops,
//! controls, provenance, timeline, model providers.

use super::edge::Edge;
use super::node::Node;
use serde::{Deserialize, Serialize};

// ── Project + payload wrapping ───────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub root_path_label: Option<String>,
    #[serde(default)]
    pub entry_node_id: Option<String>,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct GraphPayload {
    #[serde(default)]
    pub nodes: Vec<Node>,
    #[serde(default)]
    pub edges: Vec<Edge>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRequest {
    pub project_name: String,
    pub root_path_label: String,
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    pub entry_node_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResponse {
    pub project: Project,
    pub node_count: usize,
    pub edge_count: usize,
}

// ── Graph events broadcast from server ───────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum GraphEvent {
    NodeCreated {
        #[serde(rename = "projectId")]
        project_id: String,
        node: Node,
    },
    NodeUpdated {
        #[serde(rename = "projectId")]
        project_id: String,
        node: Node,
    },
    NodeRemoved {
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "nodeId")]
        node_id: String,
    },
    EdgeCreated {
        #[serde(rename = "projectId")]
        project_id: String,
        edge: Edge,
    },
    EdgeUpdated {
        #[serde(rename = "projectId")]
        project_id: String,
        edge: Edge,
    },
    EdgeRemoved {
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "edgeId")]
        edge_id: String,
    },
    ImportCompleted {
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "nodeCount")]
        node_count: usize,
        #[serde(rename = "edgeCount")]
        edge_count: usize,
    },
}

// ── Agent ops (flat schema for LLM friendliness) ─────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentGraphOp {
    pub op: AgentOpKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edge_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edge_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub patch: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AgentOpKind {
    #[serde(rename = "addNode")]
    AddNode,
    #[serde(rename = "addEdge")]
    AddEdge,
    #[serde(rename = "updateNode")]
    UpdateNode,
    #[serde(rename = "updateEdge")]
    UpdateEdge,
    #[serde(rename = "removeNode")]
    RemoveNode,
    #[serde(rename = "removeEdge")]
    RemoveEdge,
}

// ── Controls (UI layer editing surfaces) ─────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ControlKind {
    Text,
    Number,
    Color,
    Spacing,
    Select,
    Toggle,
    Binding,
    Interaction,
    Variant,
    Code,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlDefinition {
    pub id: String,
    pub label: String,
    pub kind: ControlKind,
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<serde_json::Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_node_ids: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub patch_strategy: Option<String>,
}

// ── Provenance ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Provenance {
    pub created_by: ProvenanceSource,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub derived_from: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub evidence: Option<Vec<ProvenanceEvidence>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProvenanceSource {
    Parser,
    Ai,
    Heuristic,
    User,
    System,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvenanceEvidence {
    pub node_id: String,
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f32>,
}

// ── Interaction steps (semantic flows) ───────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractionStep {
    pub kind: InteractionStepKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_node_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_node_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub condition: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub paths: Option<Vec<Vec<InteractionStep>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_node_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InteractionStepKind {
    Validate,
    SetState,
    Call,
    Branch,
    Navigate,
    Show,
    Hide,
    CustomCode,
}

// ── Timeline ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineEntry {
    pub id: String,
    pub revision_number: u64,
    pub label: String,
    pub source: TimelineSource,
    pub created_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TimelineSource {
    Import,
    Agent,
    UserEdit,
    System,
}

// ── Model providers ──────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelProviderId {
    Anthropic,
    Openai,
    Ollama,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub id: String,
    pub provider: ModelProviderId,
    pub display_name: String,
    pub is_local: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn agent_op_round_trip() {
        let op = AgentGraphOp {
            op: AgentOpKind::UpdateNode,
            id: None,
            node_type: None,
            name: None,
            data: None,
            edge_id: None,
            from: None,
            to: None,
            edge_type: None,
            order: None,
            node_id: Some("n1".into()),
            patch: Some(json!({"text": "Join Beta"})),
            target_id: None,
        };
        let s = serde_json::to_string(&op).unwrap();
        assert!(s.contains("\"op\":\"updateNode\""));
        assert!(s.contains("\"nodeId\":\"n1\""));
        let back: AgentGraphOp = serde_json::from_str(&s).unwrap();
        assert_eq!(back.op, AgentOpKind::UpdateNode);
        assert_eq!(back.node_id.as_deref(), Some("n1"));
    }

    #[test]
    fn graph_event_tag_format() {
        let ev = GraphEvent::NodeRemoved {
            project_id: "p1".into(),
            node_id: "n1".into(),
        };
        let s = serde_json::to_string(&ev).unwrap();
        assert!(s.contains("\"type\":\"node_removed\""));
        assert!(s.contains("\"projectId\":\"p1\""));
        assert!(s.contains("\"nodeId\":\"n1\""));
    }
}
