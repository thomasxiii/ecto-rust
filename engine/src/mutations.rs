//! Graph mutations.
//!
//! Pure transforms over a `Graph`. Each `apply_mutation` call validates,
//! mutates, and returns the `GraphEvent`s that should be broadcast.
//! Persistence (SQLite) is the server's job; the engine just shapes
//! the graph and tells the caller what happened.
//!
//! Mirrors `web/src/lib/store.ts` patch semantics + `server/src/repo.ts`
//! ordering (edges touching a removed node are cascade-deleted).

use crate::graph::edge::{Edge, EdgeKind};
use crate::graph::kinds::NodeKind;
use crate::graph::node::Node;
use crate::graph::types::{AgentGraphOp, AgentOpKind, GraphEvent};
use crate::graph::Graph;
use serde::{Deserialize, Serialize};
use thiserror::Error;

/// Wire format — matches `GraphMutation` in `shared/src/index.ts`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum GraphMutation {
    UpdateNodeData {
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "nodeId")]
        node_id: String,
        patch: serde_json::Value,
    },
    RenameNode {
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "nodeId")]
        node_id: String,
        name: String,
    },
    AddNode {
        #[serde(rename = "projectId")]
        project_id: String,
        node: Node,
    },
    AddEdge {
        #[serde(rename = "projectId")]
        project_id: String,
        edge: Edge,
    },
    RemoveNode {
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "nodeId")]
        node_id: String,
    },
    RemoveEdge {
        #[serde(rename = "projectId")]
        project_id: String,
        #[serde(rename = "edgeId")]
        edge_id: String,
    },
}

#[derive(Debug, Error, PartialEq)]
pub enum MutationError {
    #[error("node {0} not found")]
    NodeNotFound(String),
    #[error("edge {0} not found")]
    EdgeNotFound(String),
    #[error("node {0} already exists")]
    NodeAlreadyExists(String),
    #[error("edge {0} already exists")]
    EdgeAlreadyExists(String),
    #[error("edge references unknown node: {0}")]
    DanglingEdge(String),
    #[error("agent op missing required field: {0}")]
    AgentOpMissingField(&'static str),
    #[error("unknown node kind: {0}")]
    UnknownNodeKind(String),
    #[error("unknown edge kind: {0}")]
    UnknownEdgeKind(String),
    #[error("patch must be a JSON object, got {0}")]
    InvalidPatch(&'static str),
}

/// Apply a single mutation to the graph. Returns the events that should
/// be broadcast (often one, but `remove_node` emits cascade events too).
pub fn apply_mutation(
    graph: &mut Graph,
    mutation: &GraphMutation,
) -> Result<Vec<GraphEvent>, MutationError> {
    match mutation {
        GraphMutation::UpdateNodeData {
            project_id,
            node_id,
            patch,
        } => {
            if !patch.is_object() {
                return Err(MutationError::InvalidPatch("not an object"));
            }
            let node = graph
                .node_mut(node_id)
                .ok_or_else(|| MutationError::NodeNotFound(node_id.clone()))?;
            node.patch_data(patch);
            Ok(vec![GraphEvent::NodeUpdated {
                project_id: project_id.clone(),
                node: node.clone(),
            }])
        }

        GraphMutation::RenameNode {
            project_id,
            node_id,
            name,
        } => {
            let node = graph
                .node_mut(node_id)
                .ok_or_else(|| MutationError::NodeNotFound(node_id.clone()))?;
            node.name = name.clone();
            Ok(vec![GraphEvent::NodeUpdated {
                project_id: project_id.clone(),
                node: node.clone(),
            }])
        }

        GraphMutation::AddNode { project_id, node } => {
            if graph.node(&node.id).is_some() {
                return Err(MutationError::NodeAlreadyExists(node.id.clone()));
            }
            let mut node = node.clone();
            if node.project_id.is_empty() {
                node.project_id = project_id.clone();
            }
            let inserted = node.clone();
            graph.insert_node(node);
            Ok(vec![GraphEvent::NodeCreated {
                project_id: project_id.clone(),
                node: inserted,
            }])
        }

        GraphMutation::AddEdge { project_id, edge } => {
            if graph.edge(&edge.id).is_some() {
                return Err(MutationError::EdgeAlreadyExists(edge.id.clone()));
            }
            if graph.node(&edge.from_node_id).is_none() {
                return Err(MutationError::DanglingEdge(edge.from_node_id.clone()));
            }
            if graph.node(&edge.to_node_id).is_none() {
                return Err(MutationError::DanglingEdge(edge.to_node_id.clone()));
            }
            let mut edge = edge.clone();
            if edge.project_id.is_empty() {
                edge.project_id = project_id.clone();
            }
            let inserted = edge.clone();
            graph.insert_edge(edge);
            Ok(vec![GraphEvent::EdgeCreated {
                project_id: project_id.clone(),
                edge: inserted,
            }])
        }

        GraphMutation::RemoveNode {
            project_id,
            node_id,
        } => {
            if graph.node(node_id).is_none() {
                return Err(MutationError::NodeNotFound(node_id.clone()));
            }
            // Collect cascade edge ids before mutating.
            let cascade_edge_ids: Vec<String> = graph
                .edges
                .values()
                .filter(|e| e.from_node_id == *node_id || e.to_node_id == *node_id)
                .map(|e| e.id.clone())
                .collect();
            graph.remove_node(node_id);
            let mut events = Vec::with_capacity(1 + cascade_edge_ids.len());
            for eid in cascade_edge_ids {
                events.push(GraphEvent::EdgeRemoved {
                    project_id: project_id.clone(),
                    edge_id: eid,
                });
            }
            events.push(GraphEvent::NodeRemoved {
                project_id: project_id.clone(),
                node_id: node_id.clone(),
            });
            Ok(events)
        }

        GraphMutation::RemoveEdge {
            project_id,
            edge_id,
        } => {
            if graph.remove_edge(edge_id).is_none() {
                return Err(MutationError::EdgeNotFound(edge_id.clone()));
            }
            Ok(vec![GraphEvent::EdgeRemoved {
                project_id: project_id.clone(),
                edge_id: edge_id.clone(),
            }])
        }
    }
}

/// Translate the flat LLM-friendly `AgentGraphOp` into a `GraphMutation`
/// and apply it. Mirrors `applyAgentOp` in `server/src/aiAgentEngine.ts`.
pub fn apply_agent_op(
    graph: &mut Graph,
    project_id: &str,
    op: &AgentGraphOp,
) -> Result<Vec<GraphEvent>, MutationError> {
    let mutation = agent_op_to_mutation(project_id, op)?;
    apply_mutation(graph, &mutation)
}

fn agent_op_to_mutation(
    project_id: &str,
    op: &AgentGraphOp,
) -> Result<GraphMutation, MutationError> {
    match op.op {
        AgentOpKind::AddNode => {
            let id = op
                .id
                .clone()
                .ok_or(MutationError::AgentOpMissingField("id"))?;
            let kind_str = op
                .node_type
                .as_deref()
                .ok_or(MutationError::AgentOpMissingField("nodeType"))?;
            let kind: NodeKind = serde_json::from_value(serde_json::Value::String(
                kind_str.to_string(),
            ))
            .map_err(|_| MutationError::UnknownNodeKind(kind_str.to_string()))?;
            let name = op.name.clone().unwrap_or_default();
            let data = op.data.clone().unwrap_or(serde_json::Value::Null);
            let node = Node {
                id,
                project_id: project_id.to_string(),
                kind,
                name,
                data,
                source: None,
                created_at: String::new(),
                updated_at: String::new(),
            };
            Ok(GraphMutation::AddNode {
                project_id: project_id.to_string(),
                node,
            })
        }
        AgentOpKind::AddEdge => {
            let id = op
                .edge_id
                .clone()
                .ok_or(MutationError::AgentOpMissingField("edgeId"))?;
            let from = op
                .from
                .clone()
                .ok_or(MutationError::AgentOpMissingField("from"))?;
            let to = op
                .to
                .clone()
                .ok_or(MutationError::AgentOpMissingField("to"))?;
            let kind_str = op
                .edge_type
                .as_deref()
                .ok_or(MutationError::AgentOpMissingField("edgeType"))?;
            let kind: EdgeKind = serde_json::from_value(serde_json::Value::String(
                kind_str.to_string(),
            ))
            .map_err(|_| MutationError::UnknownEdgeKind(kind_str.to_string()))?;
            let edge = Edge {
                id,
                project_id: project_id.to_string(),
                from_node_id: from,
                to_node_id: to,
                kind,
                data: op.data.clone(),
                order: op.order,
                created_at: String::new(),
            };
            Ok(GraphMutation::AddEdge {
                project_id: project_id.to_string(),
                edge,
            })
        }
        AgentOpKind::UpdateNode => {
            let node_id = op
                .node_id
                .clone()
                .or_else(|| op.target_id.clone())
                .ok_or(MutationError::AgentOpMissingField("nodeId"))?;
            // updateNode may carry name (rename) and/or patch (data merge).
            // If both, prefer patch — name is folded into the patch.
            if let Some(name) = &op.name {
                if op.patch.is_none() {
                    return Ok(GraphMutation::RenameNode {
                        project_id: project_id.to_string(),
                        node_id,
                        name: name.clone(),
                    });
                }
            }
            let patch = op
                .patch
                .clone()
                .ok_or(MutationError::AgentOpMissingField("patch"))?;
            Ok(GraphMutation::UpdateNodeData {
                project_id: project_id.to_string(),
                node_id,
                patch,
            })
        }
        AgentOpKind::UpdateEdge => {
            // We don't model edge updates as a first-class mutation today —
            // they're rare enough to handle as remove+add. Match the TS
            // engine's behavior of only updating `order` when needed: if
            // the edge exists and `order` is the only change, the server
            // takes that fast path. For the engine here, surface a clear
            // error so the caller knows.
            Err(MutationError::AgentOpMissingField("updateEdge unsupported"))
        }
        AgentOpKind::RemoveNode => {
            let node_id = op
                .target_id
                .clone()
                .or_else(|| op.node_id.clone())
                .or_else(|| op.id.clone())
                .ok_or(MutationError::AgentOpMissingField("targetId"))?;
            Ok(GraphMutation::RemoveNode {
                project_id: project_id.to_string(),
                node_id,
            })
        }
        AgentOpKind::RemoveEdge => {
            let edge_id = op
                .target_id
                .clone()
                .or_else(|| op.edge_id.clone())
                .or_else(|| op.id.clone())
                .ok_or(MutationError::AgentOpMissingField("targetId"))?;
            Ok(GraphMutation::RemoveEdge {
                project_id: project_id.to_string(),
                edge_id,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn seeded() -> Graph {
        let mut g = Graph::new();
        g.insert_node(Node::new("c1", NodeKind::Component, "App"));
        g.insert_node(Node::new("e1", NodeKind::Element, "div"));
        g.insert_node(Node::new("t1", NodeKind::Text, "Hello").with_data(json!({"text": "Hello"})));
        g.insert_edge(Edge::new("r1", "c1", "e1", EdgeKind::Renders));
        g.insert_edge(Edge::new("ch1", "e1", "t1", EdgeKind::ChildOf));
        g
    }

    #[test]
    fn update_node_data_merges_and_emits_event() {
        let mut g = seeded();
        let events = apply_mutation(
            &mut g,
            &GraphMutation::UpdateNodeData {
                project_id: "p".into(),
                node_id: "t1".into(),
                patch: json!({"text": "Join Beta"}),
            },
        )
        .unwrap();
        assert_eq!(events.len(), 1);
        match &events[0] {
            GraphEvent::NodeUpdated { node, .. } => {
                assert_eq!(node.data["text"], "Join Beta");
            }
            other => panic!("expected node_updated, got {other:?}"),
        }
    }

    #[test]
    fn update_node_data_rejects_unknown_node() {
        let mut g = seeded();
        let err = apply_mutation(
            &mut g,
            &GraphMutation::UpdateNodeData {
                project_id: "p".into(),
                node_id: "ghost".into(),
                patch: json!({}),
            },
        )
        .unwrap_err();
        assert!(matches!(err, MutationError::NodeNotFound(_)));
    }

    #[test]
    fn remove_node_cascades_and_emits_edge_events_first() {
        let mut g = seeded();
        let events = apply_mutation(
            &mut g,
            &GraphMutation::RemoveNode {
                project_id: "p".into(),
                node_id: "e1".into(),
            },
        )
        .unwrap();
        // e1 had edges r1 (in) and ch1 (out) — both cascade, then node_removed.
        assert_eq!(events.len(), 3);
        assert!(matches!(events[0], GraphEvent::EdgeRemoved { .. }));
        assert!(matches!(events[1], GraphEvent::EdgeRemoved { .. }));
        assert!(matches!(events[2], GraphEvent::NodeRemoved { .. }));
        assert!(g.node("e1").is_none());
        assert!(g.edge("r1").is_none());
        assert!(g.edge("ch1").is_none());
    }

    #[test]
    fn add_edge_rejects_dangling_endpoints() {
        let mut g = seeded();
        let edge = Edge::new("dang", "c1", "nonexistent", EdgeKind::Renders);
        let err = apply_mutation(
            &mut g,
            &GraphMutation::AddEdge {
                project_id: "p".into(),
                edge,
            },
        )
        .unwrap_err();
        assert!(matches!(err, MutationError::DanglingEdge(_)));
    }

    #[test]
    fn agent_op_update_node_dispatches_to_patch() {
        let mut g = seeded();
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
            node_id: Some("t1".into()),
            patch: Some(json!({"text": "Updated"})),
            target_id: None,
        };
        let events = apply_agent_op(&mut g, "p", &op).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(g.node("t1").unwrap().data["text"], "Updated");
    }

    #[test]
    fn agent_op_add_node_round_trips_kind() {
        let mut g = seeded();
        let op = AgentGraphOp {
            op: AgentOpKind::AddNode,
            id: Some("new1".into()),
            node_type: Some("element".into()),
            name: Some("button".into()),
            data: Some(json!({"tagName": "button"})),
            edge_id: None,
            from: None,
            to: None,
            edge_type: None,
            order: None,
            node_id: None,
            patch: None,
            target_id: None,
        };
        let events = apply_agent_op(&mut g, "p", &op).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(g.node("new1").unwrap().kind, NodeKind::Element);
    }

    #[test]
    fn agent_op_accepts_npm_sidecar_kinds() {
        // The Stormbase loader synthesizes npm_package / npm_export /
        // server_function nodes via agent ops. Make sure the validator
        // accepts the new snake_case wire kinds.
        let mut g = seeded();
        for kind in ["npm_package", "npm_export", "server_function"] {
            let op = AgentGraphOp {
                op: AgentOpKind::AddNode,
                id: Some(format!("n-{kind}")),
                node_type: Some(kind.into()),
                name: Some(kind.into()),
                data: Some(json!({})),
                edge_id: None,
                from: None,
                to: None,
                edge_type: None,
                order: None,
                node_id: None,
                patch: None,
                target_id: None,
            };
            apply_agent_op(&mut g, "p", &op).unwrap_or_else(|e| panic!("failed for {kind}: {e}"));
        }
        for kind in ["uses_npm_export", "wraps_npm_component"] {
            let op = AgentGraphOp {
                op: AgentOpKind::AddEdge,
                id: None,
                node_type: None,
                name: None,
                data: None,
                edge_id: Some(format!("e-{kind}")),
                from: Some("c1".into()),
                to: format!("n-npm_export").into(),
                edge_type: Some(kind.into()),
                order: None,
                node_id: None,
                patch: None,
                target_id: None,
            };
            apply_agent_op(&mut g, "p", &op).unwrap_or_else(|e| panic!("failed for {kind}: {e}"));
        }
    }

    #[test]
    fn agent_op_rejects_unknown_node_kind() {
        let mut g = seeded();
        let op = AgentGraphOp {
            op: AgentOpKind::AddNode,
            id: Some("new1".into()),
            node_type: Some("not_a_real_kind".into()),
            name: None,
            data: None,
            edge_id: None,
            from: None,
            to: None,
            edge_type: None,
            order: None,
            node_id: None,
            patch: None,
            target_id: None,
        };
        let err = apply_agent_op(&mut g, "p", &op).unwrap_err();
        assert!(matches!(err, MutationError::UnknownNodeKind(_)));
    }

    #[test]
    fn mutation_wire_format_matches_ts() {
        let m = GraphMutation::UpdateNodeData {
            project_id: "p".into(),
            node_id: "n".into(),
            patch: json!({"a": 1}),
        };
        let s = serde_json::to_string(&m).unwrap();
        // TS wire shape: { type: 'update_node_data', projectId, nodeId, patch }
        assert!(s.contains("\"type\":\"update_node_data\""));
        assert!(s.contains("\"projectId\":\"p\""));
        assert!(s.contains("\"nodeId\":\"n\""));
    }
}
