//! Runtime value type.
//!
//! Kept deliberately small — strings, numbers (f64), bools, and string-keyed
//! object maps. Enough to express style values (`"#fff"`, `28`, `"100vh"`)
//! and atom state (`"light" | "dark"`) without pulling in serde_json.

use std::collections::BTreeMap;

use serde::Serialize;

/// Untagged serialization: `Value::String("x")` ↔ `"x"` on the wire,
/// `Value::Number(28)` ↔ `28`, etc. The host JS sees plain JSON values.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(untagged)]
pub enum Value {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Object(BTreeMap<String, Value>),
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
            Value::Object(m) => {
                let parts: Vec<String> =
                    m.iter().map(|(k, v)| format!("{k}: {}", v.display())).collect();
                format!("{{ {} }}", parts.join(", "))
            }
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
