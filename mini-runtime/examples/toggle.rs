//! Demo: builds the graph, materializes the runtime snapshot, prints
//! resolved styles, simulates two clicks, and prints the patch stream.
//!
//! Run with: `cargo run --example toggle -p mini-runtime`

use mini_runtime::toggle_app::{build_toggle_app, ids};
use mini_runtime::{Patch, RenderNode, Runtime, RuntimeSnapshot};

fn main() {
    let mut runtime = Runtime::new(build_toggle_app());

    println!("== Initial materialization (designMode=false) ==\n");
    let snap = runtime.materialize(false);
    print_snapshot(&snap);

    println!("\n== Simulating click on toggleTrack ==\n");
    let patches = runtime.handle_event(ids::TOGGLE_TRACK, "click");
    print_patches(&patches);

    println!("\n== After click ==\n");
    let snap = runtime.materialize(true);
    print_snapshot(&snap);

    println!("\n== Simulating second click on toggleTrack ==\n");
    let patches = runtime.handle_event(ids::TOGGLE_TRACK, "click");
    print_patches(&patches);

    println!("\n== Final state ==\n");
    let snap = runtime.materialize(true);
    print_snapshot(&snap);
}

fn print_snapshot(snap: &RuntimeSnapshot) {
    println!("Render tree:");
    print_tree(&snap.render_tree, 1);

    println!("\nAtoms:");
    for (id, v) in &snap.atoms {
        println!("  {id} = {}", v.display());
    }

    println!("\nDerived:");
    for (id, v) in &snap.derived {
        println!("  {id} = {}", v.display());
    }

    println!("\nResolved styles:");
    for (element, props) in &snap.styles {
        println!("  {element}:");
        for (prop, value) in props {
            println!("    {prop}: {}", value.display());
        }
    }

    println!("\nEvent bindings:");
    for b in &snap.bindings {
        println!("  {} {} → {}", b.element, b.event, b.cause);
    }

    if snap.design_mode {
        println!("\nSemantic nodes (design mode):");
        for (component, ann) in &snap.semantic_nodes {
            println!(
                "  {component} → doc: {:?}, ui: {:?}",
                ann.doc, ann.ui
            );
        }
    }
}

fn print_tree(node: &RenderNode, indent: usize) {
    let pad = "  ".repeat(indent);
    let tag = node
        .tag
        .as_deref()
        .map(|t| format!(" <{t}>"))
        .unwrap_or_default();
    println!("{pad}{} ({:?}){tag}", node.name, node.kind);
    for c in &node.children {
        print_tree(c, indent + 1);
    }
}

fn print_patches(patches: &[Patch]) {
    if patches.is_empty() {
        println!("  (no patches)");
        return;
    }
    for p in patches {
        match p {
            Patch::EventHandled { cause, effect } => {
                println!("  EventHandled  cause={cause} effect={effect}");
            }
            Patch::AtomChanged { node, old, new } => {
                println!(
                    "  AtomChanged   {node}: {} -> {}",
                    old.display(),
                    new.display()
                );
            }
            Patch::DerivedChanged { node, old, new } => {
                println!(
                    "  DerivedChanged {node}: {} -> {}",
                    old.display(),
                    new.display()
                );
            }
            Patch::StyleChanged {
                element,
                property,
                old,
                new,
            } => {
                println!(
                    "  StyleChanged   {element}.{property}: {} -> {}",
                    old.display(),
                    new.display()
                );
            }
        }
    }
}
