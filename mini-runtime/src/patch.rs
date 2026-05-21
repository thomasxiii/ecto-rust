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
    /// An `AppendRecord` effect produced a record whose `match`-typed
    /// field needs async resolution by the host (typically an LLM call
    /// to `/api/cognition/match`). The record was appended with a
    /// placeholder `null` in `field`; the host should call
    /// `Runtime::resolve_match(atom, record_id, field, value)` once the
    /// async result is available.
    MatchPending {
        atom: NodeId,
        record_id: String,
        field: String,
        input: String,
        candidates: Vec<Value>,
        by: String,
    },
}
