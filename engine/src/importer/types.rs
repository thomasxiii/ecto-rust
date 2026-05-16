//! Common input/output types for the importer.

use crate::graph::edge::Edge;
use crate::graph::node::Node;
use crate::graph::types::GraphPayload;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// A single file as passed from the browser. The browser shell walks
/// the directory via the File System Access API and posts blobs here;
/// the Rust importer doesn't touch the filesystem directly so it works
/// the same in WASM and native.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileBlob {
    /// Path relative to project root, forward-slashed. e.g. `src/App.tsx`.
    pub path: String,
    /// File contents. For text files this is the raw source. For binary
    /// assets the browser pre-encodes them as `data:image/png;base64,…`
    /// strings and the importer stores them verbatim.
    pub content: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileKind {
    Script,
    Css,
    Sass,
    Asset,
    Unknown,
}

impl FileBlob {
    pub fn ext(&self) -> &str {
        self.path.rsplit('.').next().unwrap_or("")
    }

    pub fn kind(&self) -> FileKind {
        match self.ext().to_ascii_lowercase().as_str() {
            "js" | "jsx" | "ts" | "tsx" | "mjs" | "cjs" => FileKind::Script,
            "css" => FileKind::Css,
            "scss" | "sass" => FileKind::Sass,
            "png" | "jpg" | "jpeg" | "gif" | "webp" | "avif" | "ico" | "svg" => FileKind::Asset,
            _ => FileKind::Unknown,
        }
    }

    pub fn file_name(&self) -> &str {
        self.path.rsplit('/').next().unwrap_or(&self.path)
    }
}

/// Output of `parse_js::parse_script`.
#[derive(Debug, Clone, Default)]
pub struct ParsedScript {
    pub file_path: String,
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    /// component name → component node id
    pub components: HashMap<String, String>,
    /// local import binding name → resolved import meta
    pub imports: HashMap<String, ImportSpec>,
    pub module_node_id: String,
    pub file_node_id: String,
    pub default_export_component: Option<String>,
    pub style_refs: Vec<StyleRef>,
    pub side_effect_imports: Vec<String>,
    pub href_refs: Vec<HrefRef>,
}

#[derive(Debug, Clone)]
pub struct ImportSpec {
    /// Module-relative source, as written: `./Button` or `./styles.css`.
    pub source: String,
    pub imported: String,
    pub node_id: String,
}

#[derive(Debug, Clone)]
pub struct StyleRef {
    pub element_id: String,
    pub css_module_local: String,
    pub class_name: String,
}

#[derive(Debug, Clone)]
pub struct HrefRef {
    pub element_id: String,
    pub href: String,
}

/// Output of `parse_css::parse_stylesheet`.
#[derive(Debug, Clone, Default)]
pub struct ParsedStylesheet {
    pub file_path: String,
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    pub file_node_id: String,
    /// primary class name → style node id, used to resolve CSS-module references.
    pub class_to_style_node: HashMap<String, String>,
    /// True for `.css`/`.module.css`/`.scss`/`.sass`/etc.
    pub is_css_module: bool,
}

/// Final output. `graph` is suitable to POST directly to the server's
/// `/import` endpoint — it matches the `ImportRequest.nodes/edges` shape.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub project_name: String,
    pub graph: GraphPayload,
    pub entry_node_id: Option<String>,
    pub script_count: usize,
    pub stylesheet_count: usize,
}
