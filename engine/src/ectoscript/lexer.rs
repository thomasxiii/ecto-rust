//! Per-line tokenizer + literal classifier.
//!
//! Mirrors `parser.ts` exactly: punctuation `=`, `:`, `<` are each their
//! own token; `"..."` quoted strings include the quotes and treat `\\`
//! as a 2-char escape; everything else is a word run terminated by
//! whitespace or punctuation.
//!
//! Literal classification is best-effort — tokens that don't match any
//! known regex become `Literal::Raw`. This matches the TS behavior
//! exactly: it lets fragments like `8px 12px` survive long enough to
//! be joined for multi-value attrs.

/// Split a line into tokens. Strings stay quoted; punctuation is split
/// out. No whitespace tokens are emitted.
pub fn tokenize_line(line: &str) -> Vec<String> {
    let bytes = line.as_bytes();
    let mut tokens = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        // Skip whitespace.
        if c == b' ' || c == b'\t' {
            i += 1;
            continue;
        }
        // Quoted string — preserves the quotes in the token.
        if c == b'"' {
            let start = i;
            i += 1;
            while i < bytes.len() && bytes[i] != b'"' {
                if bytes[i] == b'\\' && i + 1 < bytes.len() {
                    i += 2;
                } else {
                    i += 1;
                }
            }
            if i < bytes.len() {
                i += 1;
            }
            tokens.push(String::from_utf8_lossy(&bytes[start..i]).into_owned());
            continue;
        }
        // Single-char punctuation.
        if c == b'=' || c == b':' || c == b'<' {
            tokens.push((c as char).to_string());
            i += 1;
            continue;
        }
        // Word run.
        let start = i;
        while i < bytes.len() {
            let cc = bytes[i];
            if cc == b' ' || cc == b'\t' || cc == b'=' || cc == b':' {
                break;
            }
            i += 1;
        }
        if i > start {
            tokens.push(String::from_utf8_lossy(&bytes[start..i]).into_owned());
        }
    }
    tokens
}

/// A literal value as recognized at parse time. The compiler turns
/// these into `mini_runtime::Value` once the full graph context is
/// available.
#[derive(Debug, Clone, PartialEq)]
pub enum Literal {
    String(String),
    Number(f64),
    Bool(bool),
    Color(String),
    Unit { value: f64, unit: String },
    Ident(String),
    Qualified(Vec<String>),
    List, // only `[]` is supported in source
    Null,
    Raw(String),
}

const UNIT_SUFFIXES: &[&str] = &["px", "rem", "em", "%", "vh", "vw", "ms", "s"];

/// Classify a single token into a literal. Mirrors `literalFromToken`.
pub fn classify(tok: &str) -> Literal {
    if tok.is_empty() {
        return Literal::Raw(String::new());
    }
    // Quoted string.
    if tok.starts_with('"') && tok.ends_with('"') && tok.len() >= 2 {
        return Literal::String(tok[1..tok.len() - 1].to_string());
    }
    // Bool.
    if tok == "true" {
        return Literal::Bool(true);
    }
    if tok == "false" {
        return Literal::Bool(false);
    }
    if tok == "null" {
        return Literal::Null;
    }
    if tok == "[]" {
        return Literal::List;
    }
    // Number.
    if is_number(tok) {
        if let Ok(n) = tok.parse::<f64>() {
            return Literal::Number(n);
        }
    }
    // Color.
    if let Some(hex) = parse_hex(tok) {
        return Literal::Color(format!("#{hex}"));
    }
    // Unit.
    if let Some((value, unit)) = parse_unit(tok) {
        return Literal::Unit { value, unit };
    }
    // Qualified (Black.20, Theme.darkMode).
    if let Some(segments) = parse_qualified(tok) {
        return Literal::Qualified(segments);
    }
    // Ident.
    if is_ident(tok) {
        return Literal::Ident(tok.to_string());
    }
    Literal::Raw(tok.to_string())
}

fn is_number(s: &str) -> bool {
    let bytes = s.as_bytes();
    let mut i = 0;
    if !bytes.is_empty() && bytes[0] == b'-' {
        i = 1;
    }
    if i >= bytes.len() {
        return false;
    }
    let int_start = i;
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    if i == int_start {
        return false;
    }
    if i < bytes.len() && bytes[i] == b'.' {
        i += 1;
        let frac_start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        if i == frac_start {
            return false;
        }
    }
    i == bytes.len()
}

fn parse_hex(s: &str) -> Option<&str> {
    let body = s.strip_prefix('#')?;
    if !(body.len() == 3 || body.len() == 6 || body.len() == 8) {
        return None;
    }
    if body.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(body)
    } else {
        None
    }
}

fn parse_unit(s: &str) -> Option<(f64, String)> {
    for u in UNIT_SUFFIXES {
        if let Some(num_part) = s.strip_suffix(u) {
            if is_number(num_part) {
                if let Ok(n) = num_part.parse::<f64>() {
                    return Some((n, (*u).to_string()));
                }
            }
        }
    }
    None
}

pub fn is_ident(s: &str) -> bool {
    let bytes = s.as_bytes();
    if bytes.is_empty() {
        return false;
    }
    let head = bytes[0];
    if !(head.is_ascii_alphabetic() || head == b'_') {
        return false;
    }
    bytes[1..]
        .iter()
        .all(|&b| b.is_ascii_alphanumeric() || b == b'_')
}

/// Mirror the TS regex: head must match `is_ident`; subsequent segments
/// may include leading digits (`Black.20`). At least two segments.
fn parse_qualified(s: &str) -> Option<Vec<String>> {
    if !s.contains('.') {
        return None;
    }
    let parts: Vec<&str> = s.split('.').collect();
    if parts.len() < 2 {
        return None;
    }
    if !is_ident(parts[0]) {
        return None;
    }
    for p in &parts[1..] {
        if p.is_empty() || !p.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
            return None;
        }
    }
    Some(parts.into_iter().map(str::to_string).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokenizes_basic_line() {
        let toks = tokenize_line("state name = \"Tom\"");
        assert_eq!(toks, vec!["state", "name", "=", "\"Tom\""]);
    }

    #[test]
    fn tokenizes_element_header() {
        let toks = tokenize_line("< button text: \"Add\"");
        assert_eq!(toks, vec!["<", "button", "text", ":", "\"Add\""]);
    }

    #[test]
    fn punctuation_splits_words() {
        let toks = tokenize_line("padding:8px");
        assert_eq!(toks, vec!["padding", ":", "8px"]);
    }

    #[test]
    fn classifies_literals() {
        assert_eq!(classify("\"hello\""), Literal::String("hello".into()));
        assert_eq!(classify("42"), Literal::Number(42.0));
        assert_eq!(classify("-3.5"), Literal::Number(-3.5));
        assert_eq!(classify("true"), Literal::Bool(true));
        assert_eq!(classify("null"), Literal::Null);
        assert_eq!(classify("#fff"), Literal::Color("#fff".into()));
        assert_eq!(classify("#1a2b3c"), Literal::Color("#1a2b3c".into()));
        assert_eq!(
            classify("8px"),
            Literal::Unit {
                value: 8.0,
                unit: "px".into()
            }
        );
        assert_eq!(
            classify("Black.20"),
            Literal::Qualified(vec!["Black".into(), "20".into()])
        );
        assert_eq!(classify("App"), Literal::Ident("App".into()));
        assert_eq!(classify("[]"), Literal::List);
    }
}
