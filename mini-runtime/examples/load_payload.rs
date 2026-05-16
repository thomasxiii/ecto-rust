// Loads a JSON payload from disk (the full `/api/mini/generate` response
// or just a bare `GraphPayload`), runs it through the runtime, and
// reports any panics. Used to reproduce LLM-generated graphs that crash
// the browser.
//
// Usage: cargo run --example load_payload -p mini-runtime -- path/to.json

use mini_runtime::graph::{Graph, GraphPayload};
use mini_runtime::Runtime;
use std::fs;

fn main() {
    let path = std::env::args().nth(1).expect("usage: load_payload <file.json>");
    let raw = fs::read_to_string(&path).expect("read file");
    let v: serde_json::Value = serde_json::from_str(&raw).expect("parse json");
    let payload_value = if v.get("payload").is_some() {
        v["payload"].clone()
    } else {
        v
    };
    let payload: GraphPayload =
        serde_json::from_value(payload_value).expect("deserialize GraphPayload");

    println!(
        "loaded {} nodes, {} edges (root: {:?})",
        payload.nodes.len(),
        payload.edges.len(),
        payload.root
    );
    let g = Graph::from_payload(payload);
    let rt = Runtime::new(g);
    let snap = rt.materialize(false);
    println!("materialized OK — render tree root: {}", snap.render_tree.id);
    println!("--- cypher dump (first 600 chars) ---");
    let dump = rt.cypher_dump();
    println!(
        "{}",
        if dump.len() > 600 {
            format!("{}…", &dump[..600])
        } else {
            dump
        }
    );
}
