//! Patch list — the runtime's only way of telling the host what changed.
//!
//! A click produces a flat, ordered sequence: the event acknowledgement,
//! the atom write, the recomputed derived values, and the style properties
//! that ended up changing. Hosts replay patches against their own state.

use serde::Serialize;

use crate::graph::NodeId;
use crate::value::Value;

/// Patches are serialized as adjacently-tagged JSON for ergonomic JS dispatch:
/// `{ "type": "atomChanged", "node": ..., "old": ..., "new": ... }`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Patch {
    /// An atom's value was written.
    AtomChanged {
        node: NodeId,
        old: Value,
        new: Value,
    },
    /// A derived value recomputed to a different result.
    DerivedChanged {
        node: NodeId,
        old: Value,
        new: Value,
    },
    /// A materialized style property changed for a target element.
    StyleChanged {
        element: NodeId,
        property: String,
        old: Value,
        new: Value,
    },
    /// An event fired and a cause→effect was resolved. Emitted even if no
    /// downstream state changed, so the host can see the dispatch happened.
    EventHandled { cause: NodeId, effect: NodeId },
}
