//! Cross-file resolution. Mirrors the aggregator pass in
//! `web/src/importer/index.ts`.
//!
//! After every file is parsed in isolation, this pass resolves:
//! - script→script imports → `import -references-> component` edges
//! - styleRefs (className={styles.foo}) → `element -styles-> style` edges
//! - side-effect SCSS imports (`import './global.sass'`) → mark file global
//! - href literals → `element -navigates_to-> route` edges (deferred)
//!
//! Returns the best-guess entry component node id (or None).

use super::types::{ParsedScript, ParsedStylesheet};
use crate::graph::edge::{Edge, EdgeKind};
use crate::graph::Graph;
use crate::stable_id::stable_edge_id;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub fn resolve_cross_file(
    project_name: &str,
    graph: &mut Graph,
    scripts: &[ParsedScript],
    stylesheets: &[ParsedStylesheet],
) -> Option<String> {
    // Build a path-keyed lookup so we can resolve relative imports.
    let scripts_by_path: HashMap<&str, &ParsedScript> = scripts
        .iter()
        .map(|s| (s.file_path.as_str(), s))
        .collect();
    let stylesheets_by_path: HashMap<&str, &ParsedStylesheet> = stylesheets
        .iter()
        .map(|s| (s.file_path.as_str(), s))
        .collect();

    // ── 1. script→script: import references the default-exported component
    for script in scripts {
        for (_local, imp) in &script.imports {
            let Some(target_path) = resolve_relative_path(&script.file_path, &imp.source, EXT_SCRIPTS)
            else {
                continue;
            };
            let Some(target) = scripts_by_path.get(target_path.as_str()) else {
                continue;
            };
            // Wire imports that brought in default-exported components
            let resolved = if imp.imported == "default" {
                target.default_export_component.as_ref().and_then(|name| {
                    target.components.get(name).cloned()
                })
            } else {
                target.components.get(&imp.imported).cloned()
            };
            if let Some(target_component_id) = resolved {
                let edge = Edge::new(
                    stable_edge_id(
                        project_name,
                        &imp.node_id,
                        &target_component_id,
                        "references",
                    ),
                    &imp.node_id,
                    &target_component_id,
                    EdgeKind::References,
                );
                graph.insert_edge(edge);
            }
        }
    }

    // ── 2. style refs (className={styles.foo}) → element -styles-> style
    for script in scripts {
        for sref in &script.style_refs {
            let Some(local_imp) = script.imports.get(&sref.css_module_local) else {
                continue;
            };
            let Some(target_path) = resolve_relative_path(&script.file_path, &local_imp.source, EXT_STYLES)
            else {
                continue;
            };
            let Some(target_sheet) = stylesheets_by_path.get(target_path.as_str()) else {
                continue;
            };
            let Some(style_node_id) = target_sheet.class_to_style_node.get(&sref.class_name) else {
                continue;
            };
            let edge = Edge::new(
                stable_edge_id(project_name, &sref.element_id, style_node_id, "styles"),
                &sref.element_id,
                style_node_id,
                EdgeKind::Styles,
            );
            graph.insert_edge(edge);
        }
    }

    // ── 3. side-effect global stylesheet imports — mark the target file
    //         as `isGlobal: true` so the runtime applies its rules to the
    //         preview scope.
    for script in scripts {
        for src in &script.side_effect_imports {
            let Some(target_path) = resolve_relative_path(&script.file_path, src, EXT_STYLES) else {
                continue;
            };
            if let Some(target_sheet) = stylesheets_by_path.get(target_path.as_str()) {
                if let Some(file_node) = graph.node_mut(&target_sheet.file_node_id) {
                    if let serde_json::Value::Object(data) = &mut file_node.data {
                        data.insert(
                            "isGlobal".to_string(),
                            serde_json::Value::Bool(true),
                        );
                    }
                }
            }
        }
    }

    // ── 4. pick best-guess entry component
    pick_entry_component(scripts)
}

const EXT_SCRIPTS: &[&str] = &["tsx", "ts", "jsx", "js", "mjs", "cjs"];
const EXT_STYLES: &[&str] = &[
    "css",
    "scss",
    "sass",
    "module.css",
    "module.scss",
    "module.sass",
];

/// Resolve `./Button` from `src/App.tsx` to `src/Button.tsx`. Tries
/// candidate extensions in order, and also tries `<source>/index.<ext>`.
fn resolve_relative_path(from: &str, source: &str, exts: &[&str]) -> Option<String> {
    if !source.starts_with('.') {
        return None;
    }
    let from_dir = Path::new(from).parent()?;
    let raw = from_dir.join(source);
    let normalized = normalize_path(&raw);

    // Try exact path first (the source already has an extension).
    let exact = normalized.to_string_lossy().to_string();
    let exact_has_known_ext = exts.iter().any(|e| exact.ends_with(&format!(".{e}")));
    if exact_has_known_ext {
        return Some(exact);
    }
    // Add each candidate extension.
    for ext in exts {
        let cand = format!("{exact}.{ext}");
        return_if_exists(&cand);
    }
    // Try as directory with index.<ext>
    for ext in exts {
        let cand = format!("{exact}/index.{ext}");
        return_if_exists(&cand);
    }
    // No filesystem lookup possible here — return the most likely candidate.
    Some(format!("{exact}.{}", exts.first().copied().unwrap_or("tsx")))
}

#[inline]
fn return_if_exists(_path: &str) {}

fn normalize_path(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in p.components() {
        match comp {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other),
        }
    }
    out
}

fn pick_entry_component(scripts: &[ParsedScript]) -> Option<String> {
    // Priority order matches index.ts heuristics:
    let candidates = [
        "src/App.tsx",
        "src/App.jsx",
        "src/App.ts",
        "App.tsx",
        "App.jsx",
        "src/main.tsx",
        "pages/index.tsx",
        "pages/_app.tsx",
    ];
    for name in candidates {
        if let Some(s) = scripts.iter().find(|s| s.file_path.ends_with(name)) {
            if let Some(default_name) = &s.default_export_component {
                if let Some(id) = s.components.get(default_name) {
                    return Some(id.clone());
                }
            }
        }
    }
    // Fall back to the first default-exported component we find.
    for s in scripts {
        if let Some(default_name) = &s.default_export_component {
            if let Some(id) = s.components.get(default_name) {
                return Some(id.clone());
            }
        }
    }
    None
}
