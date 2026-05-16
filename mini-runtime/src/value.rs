//! Runtime value type.
//!
//! Kept deliberately small — strings, numbers (f64), bools, and string-keyed
//! object maps. Enough to express style values (`"#fff"`, `28`, `"100vh"`)
//! and atom state (`"light" | "dark"`) without pulling in serde_json.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Untagged serialization: `Value::String("x")` ↔ `"x"` on the wire,
/// `Value::Number(28)` ↔ `28`, etc. The host JS sees plain JSON values.
///
/// Deserialization variant order matters for serde untagged: we try the
/// most specific (Bool, Number, String, List, Object) before falling
/// back to Null. JSON `null` reliably hits `Null` because it doesn't
/// match any of the others.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Value {
    Bool(bool),
    Number(f64),
    String(String),
    List(Vec<Value>),
    Object(BTreeMap<String, Value>),
    Null,
}

impl Value {
    pub fn string(s: impl Into<String>) -> Self {
        Value::String(s.into())
    }

    pub fn number(n: impl Into<f64>) -> Self {
        Value::Number(n.into())
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::String(s) => Some(s.as_str()),
            _ => None,
        }
    }

    pub fn as_number(&self) -> Option<f64> {
        match self {
            Value::Number(n) => Some(*n),
            _ => None,
        }
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Value::Bool(b) => Some(*b),
            _ => None,
        }
    }

    /// Human-friendly debug rendering used by the demo logger.
    pub fn display(&self) -> String {
        match self {
            Value::Null => "null".to_string(),
            Value::Bool(b) => b.to_string(),
            Value::Number(n) => {
                if n.fract() == 0.0 && n.is_finite() {
                    format!("{}", *n as i64)
                } else {
                    format!("{n}")
                }
            }
            Value::String(s) => format!("\"{s}\""),
            Value::List(items) => {
                let parts: Vec<String> = items.iter().map(|v| v.display()).collect();
                format!("[{}]", parts.join(", "))
            }
            Value::Object(m) => {
                let parts: Vec<String> =
                    m.iter().map(|(k, v)| format!("{k}: {}", v.display())).collect();
                format!("{{ {} }}", parts.join(", "))
            }
        }
    }

    /// Render as plain text for `<span>{value}</span>`-style display.
    /// Unlike `display()`, strings are unquoted.
    pub fn plain_text(&self) -> String {
        match self {
            Value::String(s) => s.clone(),
            Value::Null => String::new(),
            Value::Bool(b) => b.to_string(),
            Value::Number(n) => {
                if n.fract() == 0.0 && n.is_finite() {
                    format!("{}", *n as i64)
                } else {
                    format!("{n}")
                }
            }
            Value::List(_) | Value::Object(_) => self.display(),
        }
    }
}

impl From<&str> for Value {
    fn from(s: &str) -> Self {
        Value::String(s.to_string())
    }
}

impl From<String> for Value {
    fn from(s: String) -> Self {
        Value::String(s)
    }
}

impl From<f64> for Value {
    fn from(n: f64) -> Self {
        Value::Number(n)
    }
}

impl From<i32> for Value {
    fn from(n: i32) -> Self {
        Value::Number(n as f64)
    }
}

impl From<bool> for Value {
    fn from(b: bool) -> Self {
        Value::Bool(b)
    }
}
