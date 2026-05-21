//! EctoScript — the indentation-based source language compiled into a
//! `mini_runtime::GraphPayload`. The compiler runs entirely in Rust so
//! the same engine drives the web preview (via WASM) and the iOS host
//! (via the C ABI in `ffi.rs`).
//!
//! Pipeline:
//!   1. `outline::build_outline` chops the source into a tree of
//!      `OutlineNode`s where each node has indent-depth, a token list,
//!      and child nodes.
//!   2. `parser::parse` lifts the outline into a typed `EctoFile` AST.
//!   3. `compiler::compile` walks the AST and emits a wire-format
//!      `GraphPayload` plus a `CompileIndex` (handy id maps for the
//!      host's inspector panes).
//!
//! Parse and compile errors carry `{message, line, col}` so the Monaco
//! editor can surface them as inline markers.

pub mod ast;
pub mod compiler;
pub mod lexer;
pub mod outline;
pub mod parser;
pub mod starter;

use mini_runtime::graph::GraphPayload;
use serde::Serialize;

pub use compiler::{CompileIndex, CompileResult};
pub use parser::ParseError;
pub use starter::STARTER_ECTOSCRIPT;

/// Single-entry compile: source text → wire-format graph + diagnostics.
/// On a parse failure the graph is whatever the partial AST could
/// produce; callers should still surface the errors.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EctoScriptResult {
    pub graph: GraphPayload,
    pub errors: Vec<ParseError>,
    pub index: CompileIndex,
}

pub fn compile_source(source: &str) -> EctoScriptResult {
    let parsed = parser::parse(source);
    let CompileResult {
        graph,
        index,
        errors: compile_errors,
    } = compiler::compile(&parsed.file);
    let mut errors = parsed.errors;
    errors.extend(compile_errors);
    EctoScriptResult {
        graph,
        errors,
        index,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mini_runtime::Runtime;

    #[test]
    fn starter_compiles_without_errors() {
        let res = compile_source(STARTER_ECTOSCRIPT);
        assert!(
            res.errors.is_empty(),
            "expected no errors, got: {:#?}",
            res.errors
        );
        assert!(res.index.root_component_id.is_some());
        assert!(!res.graph.nodes.is_empty());
    }

    /// Editing source above an atom must not shift its ID. The runtime
    /// uses atom IDs to preserve live state across recompiles — if a
    /// token-literal edit renumbers downstream atoms, every form input
    /// resets to its initial value on each keystroke.
    #[test]
    fn atom_ids_stable_across_source_edits() {
        let original = STARTER_ECTOSCRIPT;
        // Compile once to capture baseline atom IDs.
        let baseline = compile_source(original);
        assert!(baseline.errors.is_empty(), "starter must compile");
        // Edit the source above the atoms: replace any token literal we
        // know exists in the starter. We do a generic edit — append a
        // benign new line so positions shift but no names change.
        let edited = format!("// tweak\n{original}");
        let edited_res = compile_source(&edited);
        assert!(
            edited_res.errors.is_empty(),
            "edited starter must still compile: {:?}",
            edited_res.errors,
        );
        for (qname, id) in &baseline.index.atoms {
            let after = edited_res.index.atoms.get(qname);
            assert_eq!(
                after,
                Some(id),
                "atom {qname} must keep its id across edits (was {id}, got {after:?})",
            );
        }
    }

    /// The studio scenario: user types into a form (atom acquires a
    /// value), then edits the source above it (recompile). The atom's
    /// live value must survive the reload — that's the whole point of
    /// content-stable atom IDs + `update_payload`.
    #[test]
    fn update_payload_preserves_atom_values_across_source_edits() {
        let baseline = compile_source(STARTER_ECTOSCRIPT);
        assert!(baseline.errors.is_empty());
        let name_atom = baseline
            .index
            .atoms
            .get("NewProjectForm.name")
            .expect("starter has NewProjectForm.name")
            .clone();
        let mut rt =
            Runtime::new(mini_runtime::Graph::from_payload(baseline.graph.clone()));

        // Simulate user typing into the form: write the atom via a
        // dispatched change on its bound input.
        let snap = rt.materialize(false);
        let input_id =
            find_first_input_id(&snap.render_tree).expect("starter has an input");
        rt.dispatch_event(
            &input_id,
            "change",
            Some(mini_runtime::Value::String("Inbox".into())),
            None,
            None,
        );
        assert_eq!(
            rt.atom(&name_atom),
            Some(mini_runtime::Value::String("Inbox".into())),
        );

        // Now edit the source (benign comment prepend) and update_payload.
        let edited = compile_source(&format!("// edit\n{STARTER_ECTOSCRIPT}"));
        assert!(edited.errors.is_empty(), "edited starter must compile");
        rt.update_payload(edited.graph);

        // Same atom id should still be there and hold the typed value.
        assert_eq!(
            rt.atom(&name_atom),
            Some(mini_runtime::Value::String("Inbox".into())),
            "atom value must survive update_payload",
        );
    }

    /// Conversely: a token literal edit must actually flow through to
    /// downstream styles/derived after update_payload — otherwise we'd
    /// preserve too much and the user's edit wouldn't take effect.
    #[test]
    fn update_payload_applies_token_value_changes() {
        let original = "token tk_main = \"#3b82f6\"\n\ncomponent App\n  render\n    < div\n      text: \"hi\"\n";
        let edited = "token tk_main = \"#10b981\"\n\ncomponent App\n  render\n    < div\n      text: \"hi\"\n";
        let r1 = compile_source(original);
        assert!(r1.errors.is_empty(), "original must compile: {:?}", r1.errors);
        let mut rt = Runtime::new(mini_runtime::Graph::from_payload(r1.graph));
        let r2 = compile_source(edited);
        assert!(r2.errors.is_empty(), "edited must compile: {:?}", r2.errors);
        rt.update_payload(r2.graph);
        // The token node's value must reflect the edit (i.e. the merge
        // didn't preserve the old literal).
        let new_token_value = rt
            .graph
            .nodes()
            .find_map(|n| match &n.data {
                mini_runtime::graph::NodeData::Token { value }
                    if n.name == "tk_main" =>
                {
                    Some(value.clone())
                }
                _ => None,
            })
            .expect("tk_main must exist after update");
        assert_eq!(
            new_token_value,
            mini_runtime::Value::String("#10b981".into()),
            "token literal edits must propagate through update_payload",
        );
    }

    #[test]
    fn starter_loads_into_runtime_and_materializes() {
        let res = compile_source(STARTER_ECTOSCRIPT);
        let mut rt = Runtime::new(mini_runtime::Graph::from_payload(res.graph));
        let snap = rt.materialize(false);
        assert_eq!(snap.render_tree.kind, mini_runtime::NodeKind::Component);
        assert!(
            !snap.render_tree.children.is_empty(),
            "expected the App component to render some children"
        );
    }

    /// Type a project name → submit → expect ProjectModel.projects to
    /// contain a record with that name and a generated `id`.
    #[test]
    fn submitting_new_project_form_appends_record() {
        let res = compile_source(STARTER_ECTOSCRIPT);
        let projects_atom = res
            .index
            .atoms
            .get("ProjectModel.projects")
            .expect("ProjectModel.projects atom should be indexed")
            .clone();
        let name_atom = res
            .index
            .atoms
            .get("NewProjectForm.name")
            .expect("NewProjectForm.name atom")
            .clone();
        let mut rt =
            Runtime::new(mini_runtime::Graph::from_payload(res.graph));

        // Find the input element id by walking the render tree under
        // the NewProjectForm component.
        let snap = rt.materialize(false);
        let input_id = find_first_input_id(&snap.render_tree)
            .expect("starter must render at least one input");

        rt.dispatch_event(
            &input_id,
            "change",
            Some(mini_runtime::Value::String("Inbox".into())),
            None,
            None,
        );
        assert_eq!(
            rt.atom(&name_atom),
            Some(mini_runtime::Value::String("Inbox".into())),
            "input change should write to the bound atom",
        );

        rt.dispatch_event(&input_id, "submit", None, None, None);
        let projects = rt.atom(&projects_atom).expect("projects atom exists");
        match &projects {
            mini_runtime::Value::List(items) => {
                assert_eq!(items.len(), 1, "expected exactly one project");
                if let mini_runtime::Value::Object(m) = &items[0] {
                    assert_eq!(
                        m.get("name"),
                        Some(&mini_runtime::Value::String("Inbox".into())),
                    );
                    assert!(matches!(m.get("id"), Some(mini_runtime::Value::String(_))));
                } else {
                    panic!("project item should be an object, got {projects:?}");
                }
            }
            _ => panic!("ProjectModel.projects should be a list, got {projects:?}"),
        }
    }

    fn find_first_input_id(
        node: &mini_runtime::RenderNode,
    ) -> Option<String> {
        if node.tag.as_deref() == Some("input") {
            return Some(node.id.clone());
        }
        for c in &node.children {
            if let Some(id) = find_first_input_id(c) {
                return Some(id);
            }
        }
        None
    }

    /// Regression: when a component references an outer loop variable
    /// (e.g. `task.text`), its bindings, visibility, and query filters
    /// must resolve via the dispatched item context — not via the
    /// compiler's lexical scope (which is empty inside a standalone
    /// component).
    #[test]
    fn outer_loop_refs_render_under_starter_layout() {
        let res = compile_source(STARTER_ECTOSCRIPT);
        assert!(res.errors.is_empty(), "{:#?}", res.errors);
        let tasks_atom = res.index.atoms.get("TaskModel.tasks").unwrap().clone();
        let projects_atom = res
            .index
            .atoms
            .get("ProjectModel.projects")
            .unwrap()
            .clone();

        let mut rt =
            Runtime::new(mini_runtime::Graph::from_payload(res.graph));

        // Seed two projects and two tasks, each tagged with a project.
        rt.resolve_match(
            &projects_atom,
            "p_alpha",
            "_",
            mini_runtime::Value::Null,
        );
        // Use direct atom writes via patch_list helpers — simulate the
        // result of AppendRecord without going through dispatch.
        seed_list(
            &mut rt,
            &projects_atom,
            vec![
                obj([("id", "p_alpha"), ("name", "Alpha")]),
                obj([("id", "p_beta"), ("name", "Beta")]),
            ],
        );
        seed_list(
            &mut rt,
            &tasks_atom,
            vec![
                obj([
                    ("id", "t_1"),
                    ("text", "buy milk"),
                    ("projectId", "p_alpha"),
                ]),
                obj([
                    ("id", "t_2"),
                    ("text", "walk dog"),
                    ("projectId", "p_beta"),
                ]),
            ],
        );

        let snap = rt.materialize(false);
        // Find every rendered heading and check that the task titles
        // make it through the binding.
        let texts = collect_heading_texts(&snap.render_tree);
        assert!(
            texts.iter().any(|t| t == "buy milk"),
            "expected to see a heading with the task text, got {texts:?}",
        );
        assert!(
            texts.iter().any(|t| t == "walk dog"),
            "expected to see a heading with the task text, got {texts:?}",
        );

        // Project labels (the inner `for project in TaskProject` loop)
        // must filter to the task's actual project — not show all of
        // them.
        let labels = collect_subheading_texts(&snap.render_tree);
        let alpha_count = labels.iter().filter(|s| *s == "Alpha").count();
        let beta_count = labels.iter().filter(|s| *s == "Beta").count();
        assert_eq!(
            alpha_count, 1,
            "expected exactly one Alpha label, got {labels:?}",
        );
        assert_eq!(
            beta_count, 1,
            "expected exactly one Beta label, got {labels:?}",
        );
    }

    fn seed_list(
        rt: &mut Runtime,
        atom_id: &str,
        items: Vec<mini_runtime::Value>,
    ) {
        // Replace the atom's value via a synthetic AtomChanged. The
        // runtime's resolve_match is the only mutating public path
        // that doesn't require an effect node, so we use it as a
        // raw "set this atom" by patching each record into place via
        // a sentinel.
        let mut g = rt.graph.to_payload();
        for n in g.nodes.iter_mut() {
            if n.id == atom_id {
                if let mini_runtime::NodeData::Atom { value } = &mut n.data {
                    *value = mini_runtime::Value::List(items.clone());
                }
            }
        }
        rt.load_payload(g);
    }

    fn obj(pairs: impl IntoIterator<Item = (&'static str, &'static str)>) -> mini_runtime::Value {
        let mut m = std::collections::BTreeMap::new();
        for (k, v) in pairs {
            m.insert(k.to_string(), mini_runtime::Value::String(v.to_string()));
        }
        mini_runtime::Value::Object(m)
    }

    fn collect_heading_texts(
        node: &mini_runtime::RenderNode,
    ) -> Vec<String> {
        let mut out = Vec::new();
        walk_collect(node, "heading", &mut out);
        out
    }

    fn collect_subheading_texts(
        node: &mini_runtime::RenderNode,
    ) -> Vec<String> {
        let mut out = Vec::new();
        walk_collect(node, "subheading", &mut out);
        out
    }

    fn walk_collect(
        node: &mini_runtime::RenderNode,
        tag: &str,
        out: &mut Vec<String>,
    ) {
        if node.tag.as_deref() == Some(tag) {
            if let Some(t) = &node.text {
                out.push(t.clone());
            }
        }
        for c in &node.children {
            walk_collect(c, tag, out);
        }
    }
}
