//! FNV-1a 32-bit stable IDs.
//!
//! Mirrors `web/src/importer/stableId.ts` exactly so that re-imports of
//! the same source produce the same IDs as the TS importer did. This
//! also means a project imported with the TS engine can be reopened
//! with the Rust engine without losing edits keyed by node id.

/// FNV-1a 32-bit hash, lowercased 8-char hex. Equivalent to
/// `(h >>> 0).toString(16).padStart(8, '0')` in JS.
pub fn fnv1a32(input: &str) -> String {
    let mut h: u32 = 0x811c_9dc5;
    for byte in input.bytes() {
        h ^= byte as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    format!("{h:08x}")
}

/// Inputs for the composite stable ID. Matches `IdParts` in
/// stableId.ts — pass empty strings where the TS code would pass
/// `undefined`.
#[derive(Debug, Clone, Default)]
pub struct IdParts<'a> {
    pub project_name: &'a str,
    pub file_path: &'a str,
    pub node_type: &'a str,
    pub symbol_path: &'a str,
    pub offset: Option<u32>,
    pub extra: &'a str,
}

/// Produce a stable node ID. Format: `<3char_type_prefix>_<a><b[..4]>`
/// where `a = fnv1a(key)` and `b = fnv1a(key + ":b")` and
/// `key = parts.join("::")`.
pub fn stable_node_id(parts: &IdParts<'_>) -> String {
    let offset = parts
        .offset
        .map(|o| o.to_string())
        .unwrap_or_default();
    let key = format!(
        "{}::{}::{}::{}::{}::{}",
        parts.project_name,
        parts.file_path,
        parts.node_type,
        parts.symbol_path,
        offset,
        parts.extra,
    );
    let a = fnv1a32(&key);
    let b_full = fnv1a32(&format!("{key}:b"));
    let prefix: String = parts.node_type.chars().take(3).collect();
    format!("{prefix}_{a}{}", &b_full[..4])
}

/// Stable edge ID. Format: `edg_<fnv1a(projectName::from::to::type)>`.
pub fn stable_edge_id(project_name: &str, from_id: &str, to_id: &str, edge_type: &str) -> String {
    let key = format!("{project_name}::{from_id}::{to_id}::{edge_type}");
    format!("edg_{}", fnv1a32(&key))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fnv1a_matches_ts_reference() {
        // Reference values cross-checked against ecto-engine's stableId.ts
        // run through the same FNV-1a (0x811c9dc5 init, 0x01000193 prime,
        // 32-bit unsigned).
        assert_eq!(fnv1a32(""), "811c9dc5");
        assert_eq!(fnv1a32("a"), "e40c292c");
        assert_eq!(fnv1a32("hello"), "4f9f2cab");
    }

    #[test]
    fn node_id_shape() {
        let id = stable_node_id(&IdParts {
            project_name: "proj",
            file_path: "src/App.tsx",
            node_type: "component",
            symbol_path: "comp:App",
            offset: Some(0),
            extra: "",
        });
        // 3-char prefix + underscore + 12 hex chars
        assert!(id.starts_with("com_"));
        assert_eq!(id.len(), 4 + 8 + 4, "prefix(4) + a(8) + b[..4](4)");
    }

    #[test]
    fn node_id_deterministic() {
        let a = stable_node_id(&IdParts {
            project_name: "p",
            file_path: "f.ts",
            node_type: "element",
            symbol_path: "App.return.div[0]",
            offset: Some(42),
            extra: "",
        });
        let b = stable_node_id(&IdParts {
            project_name: "p",
            file_path: "f.ts",
            node_type: "element",
            symbol_path: "App.return.div[0]",
            offset: Some(42),
            extra: "",
        });
        assert_eq!(a, b);
    }

    #[test]
    fn edge_id_shape_and_uniqueness() {
        let a = stable_edge_id("p", "n1", "n2", "renders");
        let b = stable_edge_id("p", "n1", "n2", "child_of");
        assert!(a.starts_with("edg_"));
        assert_eq!(a.len(), 4 + 8);
        assert_ne!(a, b);
    }
}
