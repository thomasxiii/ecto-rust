//! Importer pipeline.
//!
//! Ports `web/src/importer/{walkFolder,parseFile,parseCss,compileSass,index}.ts`.
//! The browser passes us a flat array of `FileBlob`s (path + bytes/text);
//! the importer extracts a mechanical graph from them.
//!
//! Output is a `GraphPayload` plus an `entry_node_id` — the same shape
//! the TS server accepts via `POST /import`, so the existing server can
//! consume our output unchanged.

pub mod parse_css;
pub mod parse_js;
pub mod resolve;
pub mod types;

pub use types::{FileBlob, ImportResult, ParsedScript, ParsedStylesheet};

use crate::graph::types::GraphPayload;
use crate::graph::Graph;

/// Top-level entry point. Walks every file blob, parses scripts and
/// stylesheets, and runs cross-file resolution to wire imports → assets,
/// className → style, href → route.
pub fn import_project(project_name: &str, files: &[FileBlob]) -> ImportResult {
    let mut scripts: Vec<ParsedScript> = Vec::new();
    let mut stylesheets: Vec<ParsedStylesheet> = Vec::new();
    let mut graph = Graph::new();

    for file in files {
        match file.kind() {
            types::FileKind::Script => {
                let parsed = parse_js::parse_script(project_name, file);
                for node in &parsed.nodes {
                    graph.insert_node(node.clone());
                }
                for edge in &parsed.edges {
                    graph.insert_edge(edge.clone());
                }
                scripts.push(parsed);
            }
            types::FileKind::Css | types::FileKind::Sass => {
                let parsed = parse_css::parse_stylesheet(project_name, file);
                for node in &parsed.nodes {
                    graph.insert_node(node.clone());
                }
                for edge in &parsed.edges {
                    graph.insert_edge(edge.clone());
                }
                stylesheets.push(parsed);
            }
            types::FileKind::Asset => {
                // Assets are encoded by the browser shell (data URIs) and
                // arrive as text in the FileBlob. We register a file node
                // + asset node here; resolve.rs wires imports to them.
                let pair = parse_css::register_asset_blob(project_name, file);
                for node in pair.0 {
                    graph.insert_node(node);
                }
                for edge in pair.1 {
                    graph.insert_edge(edge);
                }
            }
            types::FileKind::Unknown => {
                // Ignore — don't pollute the graph with files we can't parse.
            }
        }
    }

    let entry_node_id = resolve::resolve_cross_file(project_name, &mut graph, &scripts, &stylesheets);

    ImportResult {
        project_name: project_name.to_string(),
        graph: GraphPayload {
            nodes: graph.iter_nodes().cloned().collect(),
            edges: graph.iter_edges().cloned().collect(),
        },
        entry_node_id,
        script_count: scripts.len(),
        stylesheet_count: stylesheets.len(),
    }
}
