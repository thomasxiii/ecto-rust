//! C FFI surface for iOS / native hosts.
//!
//! Mirrors the WASM surface in shape: every entry point takes a UTF-8
//! C string in, returns a heap-allocated UTF-8 C string out. The
//! caller owns the returned string and must free it via
//! [`ecto_string_free`].
//!
//! This is the same JSON-string contract the JS `Engine` wrapper
//! uses, so Swift code is one-to-one analogous: marshal a Codable to
//! JSON, hand the bytes to Rust, take the returned C string, parse it
//! back to a Codable.
//!
//! Build:
//! ```ignore
//! cargo build --release --target aarch64-apple-ios
//! ```
//! produces `target/aarch64-apple-ios/release/libecto_engine.a`.
//! Generate the header with `cbindgen --crate ecto-engine --output ecto_engine.h`.

#![cfg(not(target_arch = "wasm32"))]

use crate::graph::types::{AgentGraphOp, GraphPayload};
use crate::graph::Graph;
use crate::importer::{import_project, FileBlob};
use crate::mutations::{apply_agent_op, apply_mutation, GraphMutation};
use crate::render::{generate_stylesheet, walk_render_tree};
use crate::semantic::build_semantic_layer;
use crate::ui_layer::build_ui_layer;
use serde::Serialize;
use std::cell::RefCell;
use std::ffi::{c_char, CStr, CString};
use std::ptr;

/// Opaque pointer to a heap-allocated [`Engine`]. Created with
/// [`ecto_engine_new`], freed with [`ecto_engine_free`].
pub struct Engine {
    graph: RefCell<Graph>,
}

#[unsafe(no_mangle)]
pub extern "C" fn ecto_engine_new() -> *mut Engine {
    Box::into_raw(Box::new(Engine {
        graph: RefCell::new(Graph::new()),
    }))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ecto_engine_free(engine: *mut Engine) {
    if !engine.is_null() {
        drop(Box::from_raw(engine));
    }
}

/// Free a string previously returned by any `ecto_*` function.
/// Safe to call on a null pointer — does nothing.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn ecto_string_free(s: *mut c_char) {
    if !s.is_null() {
        drop(CString::from_raw(s));
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn ecto_engine_version() -> *mut c_char {
    string_out(env!("CARGO_PKG_VERSION"))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ecto_engine_load_graph(
    engine: *mut Engine,
    payload_json: *const c_char,
) -> *mut c_char {
    with_engine(engine, |eng| {
        let payload: GraphPayload = read_json(payload_json)?;
        *eng.graph.borrow_mut() = Graph::from_payload(payload);
        Ok(String::from("null"))
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ecto_engine_get_graph(engine: *mut Engine) -> *mut c_char {
    with_engine(engine, |eng| json_out(&eng.graph.borrow().to_payload()))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ecto_engine_import_files(
    engine: *mut Engine,
    project_name: *const c_char,
    files_json: *const c_char,
) -> *mut c_char {
    with_engine(engine, |eng| {
        let name = read_cstr(project_name)?;
        let files: Vec<FileBlob> = read_json(files_json)?;
        let result = import_project(&name, &files);
        *eng.graph.borrow_mut() = Graph::from_payload(result.graph.clone());
        json_out(&result)
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ecto_engine_apply_mutation(
    engine: *mut Engine,
    mutation_json: *const c_char,
) -> *mut c_char {
    with_engine(engine, |eng| {
        let mutation: GraphMutation = read_json(mutation_json)?;
        let events = apply_mutation(&mut eng.graph.borrow_mut(), &mutation)
            .map_err(|e| format!("mutation error: {e}"))?;
        json_out(&events)
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ecto_engine_apply_agent_op(
    engine: *mut Engine,
    project_id: *const c_char,
    op_json: *const c_char,
) -> *mut c_char {
    with_engine(engine, |eng| {
        let project_id = read_cstr(project_id)?;
        let op: AgentGraphOp = read_json(op_json)?;
        let events = apply_agent_op(&mut eng.graph.borrow_mut(), &project_id, &op)
            .map_err(|e| format!("agent op error: {e}"))?;
        json_out(&events)
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ecto_engine_walk_render_tree(
    engine: *mut Engine,
    root_id: *const c_char,
) -> *mut c_char {
    with_engine(engine, |eng| {
        let root = read_cstr(root_id)?;
        let tree = walk_render_tree(&eng.graph.borrow(), &root);
        json_out(&tree)
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ecto_engine_generate_stylesheet(engine: *mut Engine) -> *mut c_char {
    with_engine(engine, |eng| json_out(&generate_stylesheet(&eng.graph.borrow())))
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ecto_engine_build_semantic_layer(
    engine: *mut Engine,
    project_id: *const c_char,
) -> *mut c_char {
    with_engine(engine, |eng| {
        let pid = read_cstr(project_id)?;
        let result = build_semantic_layer(&eng.graph.borrow(), &pid);
        {
            let mut g = eng.graph.borrow_mut();
            for n in &result.nodes {
                g.insert_node(n.clone());
            }
            for e in &result.edges {
                g.insert_edge(e.clone());
            }
        }
        json_out(&LayerWire {
            nodes: &result.nodes,
            edges: &result.edges,
        })
    })
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn ecto_engine_build_ui_layer(
    engine: *mut Engine,
    project_id: *const c_char,
) -> *mut c_char {
    with_engine(engine, |eng| {
        let pid = read_cstr(project_id)?;
        let result = build_ui_layer(&eng.graph.borrow(), &pid);
        {
            let mut g = eng.graph.borrow_mut();
            for n in &result.nodes {
                g.insert_node(n.clone());
            }
            for e in &result.edges {
                g.insert_edge(e.clone());
            }
        }
        json_out(&LayerWire {
            nodes: &result.nodes,
            edges: &result.edges,
        })
    })
}

// ── internal helpers ─────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LayerWire<'a> {
    nodes: &'a [crate::graph::Node],
    edges: &'a [crate::graph::Edge],
}

/// Run `f` with a borrow of the Engine. On any error, returns a JSON
/// object `{"error": "..."}` so the caller never has to deal with
/// null/empty-string error signalling.
unsafe fn with_engine<F>(engine: *mut Engine, f: F) -> *mut c_char
where
    F: FnOnce(&Engine) -> Result<String, String>,
{
    if engine.is_null() {
        return string_out("{\"error\":\"null engine pointer\"}");
    }
    let eng = &*engine;
    match f(eng) {
        Ok(s) => string_out(&s),
        Err(e) => string_out(&format!("{{\"error\":{:?}}}", e)),
    }
}

unsafe fn read_cstr(p: *const c_char) -> Result<String, String> {
    if p.is_null() {
        return Err("null string argument".into());
    }
    CStr::from_ptr(p)
        .to_str()
        .map(|s| s.to_string())
        .map_err(|e| format!("invalid utf-8: {e}"))
}

unsafe fn read_json<T: for<'de> serde::Deserialize<'de>>(p: *const c_char) -> Result<T, String> {
    let s = read_cstr(p)?;
    serde_json::from_str(&s).map_err(|e| format!("invalid json: {e}"))
}

fn json_out<T: Serialize>(value: &T) -> Result<String, String> {
    serde_json::to_string(value).map_err(|e| format!("serialize: {e}"))
}

fn string_out(s: &str) -> *mut c_char {
    CString::new(s).map(|c| c.into_raw()).unwrap_or(ptr::null_mut())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::CString;

    #[test]
    fn round_trip_engine_lifecycle() {
        unsafe {
            let eng = ecto_engine_new();
            let version_ptr = ecto_engine_version();
            let v = CStr::from_ptr(version_ptr).to_str().unwrap().to_string();
            assert!(!v.is_empty());
            ecto_string_free(version_ptr);

            // load empty graph
            let payload = CString::new("{\"nodes\":[],\"edges\":[]}").unwrap();
            let res = ecto_engine_load_graph(eng, payload.as_ptr());
            ecto_string_free(res);

            // get_graph round-trips
            let g = ecto_engine_get_graph(eng);
            let s = CStr::from_ptr(g).to_str().unwrap();
            assert!(s.contains("\"nodes\""));
            ecto_string_free(g);

            ecto_engine_free(eng);
        }
    }
}
