//! Node + SourceMap. Node `data` stays as opaque JSON to preserve full
//! parity with the TS engine, which uses `Record<string, any>`. Strongly
//! typed accessors live in domain-specific modules (importer, semantic,
//! etc) rather than this base struct.

use super::kinds::{Layer, NodeKind};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceMap {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_col: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_col: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub id: String,
    #[serde(default)]
    pub project_id: String,
    #[serde(rename = "type")]
    pub kind: NodeKind,
    pub name: String,
    #[serde(default)]
    pub data: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<SourceMap>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub created_at: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub updated_at: String,
}

impl Node {
    pub fn new(id: impl Into<String>, kind: NodeKind, name: impl Into<String>) -> Self {
        Node {
            id: id.into(),
            project_id: String::new(),
            kind,
            name: name.into(),
            data: serde_json::Value::Null,
            source: None,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    pub fn with_data(mut self, data: serde_json::Value) -> Self {
        self.data = data;
        self
    }

    pub fn with_source(mut self, source: SourceMap) -> Self {
        self.source = Some(source);
        self
    }

    /// Read `data.layer` if set, else fall back to the structural layer
    /// inferred from `kind`.
    pub fn layer(&self) -> Layer {
        if let Some(s) = self.data.get("layer").and_then(|v| v.as_str()) {
            match s {
                "semantic" => return Layer::Semantic,
                "ui" => return Layer::Ui,
                _ => {}
            }
        }
        self.kind.layer()
    }

    /// Shallow-merge a JSON patch into `data`. Matches the
    /// `update_node_data` semantics in ecto-engine's `repo.ts`.
    pub fn patch_data(&mut self, patch: &serde_json::Value) {
        let Some(patch_obj) = patch.as_object() else {
            return;
        };
        match self.data.as_object_mut() {
            Some(obj) => {
                for (k, v) in patch_obj {
                    obj.insert(k.clone(), v.clone());
                }
            }
            None => {
                self.data = serde_json::Value::Object(patch_obj.clone());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn node_wire_format() {
        let n = Node::new("n1", NodeKind::SemanticComponent, "App")
            .with_data(json!({"layer": "semantic", "capabilities": ["selectable"]}));
        let s = serde_json::to_string(&n).unwrap();
        assert!(s.contains("\"type\":\"semantic_component\""));
        assert!(s.contains("\"layer\":\"semantic\""));
    }

    #[test]
    fn layer_from_data_overrides_kind() {
        let mut n = Node::new("n1", NodeKind::Element, "div");
        assert_eq!(n.layer(), Layer::Mechanical);
        n.data = json!({"layer": "ui"});
        assert_eq!(n.layer(), Layer::Ui);
    }

    #[test]
    fn layer_falls_back_to_kind_for_layer_native_nodes() {
        let n = Node::new("n1", NodeKind::SemanticComponent, "App");
        assert_eq!(n.layer(), Layer::Semantic);
    }

    #[test]
    fn patch_data_merges_shallow() {
        let mut n = Node::new("n1", NodeKind::Element, "div").with_data(json!({"a": 1, "b": 2}));
        n.patch_data(&json!({"b": 3, "c": 4}));
        assert_eq!(n.data, json!({"a": 1, "b": 3, "c": 4}));
    }
}
