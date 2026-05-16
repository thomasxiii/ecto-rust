//! Render-tree walker + stylesheet generator.
//!
//! Ports `core/src/renderTree.ts` and `web/src/runtime/stylesheet.ts`.
//! Output is platform-agnostic — the same `RenderTreeNode` JSON drives
//! React in the browser and SwiftUI on iOS today; the Rust engine
//! produces it directly so neither host re-implements the walker.

pub mod stylesheet;
pub mod tree;

pub use stylesheet::{generate_stylesheet, StylesheetResult};
pub use tree::{walk_render_tree, RenderTreeNode, RenderTreeKind, StyleDeclaration};
