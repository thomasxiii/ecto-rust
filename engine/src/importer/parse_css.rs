//! CSS / Sass parsing via `lightningcss` + `grass`.
//!
//! Ports `web/src/importer/{parseCss,compileSass}.ts` to the extent
//! needed for the tiny-react-app fixture. We emit one `style` node per
//! primary class (CSS-module model), one `style_token` node per
//! `--token` declaration, one `style` node per global (non-class)
//! selector, and one `style` node per `@keyframes`/`@font-face`.
//!
//! Sass source is compiled to CSS via the pure-Rust `grass` crate
//! first; the resulting CSS goes through the same lightningcss pass.
//! `@use` / `@import` resolution against the in-memory file set is
//! deferred (todo: pass the file set through a custom Sass loader).

use super::types::{FileBlob, ParsedStylesheet};
use crate::graph::edge::{Edge, EdgeKind};
use crate::graph::kinds::NodeKind;
use crate::graph::node::Node;
use crate::stable_id::{stable_edge_id, stable_node_id, IdParts};
use lightningcss::declaration::DeclarationBlock;
use lightningcss::printer::PrinterOptions;
use lightningcss::properties::Property;
use lightningcss::rules::style::StyleRule;
use lightningcss::rules::CssRule;
use lightningcss::stylesheet::{ParserOptions, StyleSheet};
use lightningcss::traits::ToCss;
use lightningcss::values::ident::Ident;
use lightningcss::values::string::CowArcStr;
use serde_json::{json, Value};
use std::collections::HashMap;

pub fn parse_stylesheet(project_name: &str, file: &FileBlob) -> ParsedStylesheet {
    let mut out = ParsedStylesheet {
        file_path: file.path.clone(),
        is_css_module: is_css_module_path(&file.path),
        ..Default::default()
    };

    let file_node_id = stable_node_id(&IdParts {
        project_name,
        file_path: &file.path,
        node_type: "file",
        ..Default::default()
    });
    out.file_node_id = file_node_id.clone();
    out.nodes.push(
        Node::new(&file_node_id, NodeKind::File, file.file_name()).with_data(json!({
            "filePath": &file.path,
            "ext": file.ext(),
            "isStylesheet": true,
        })),
    );

    // Compile Sass → CSS via grass (single-file mode for v1).
    let css_source: String = match file.ext().to_ascii_lowercase().as_str() {
        "scss" | "sass" => {
            let opts = grass::Options::default();
            match grass::from_string(file.content.clone(), &opts) {
                Ok(s) => s,
                Err(_) => return out, // unparseable; emit file node only
            }
        }
        _ => file.content.clone(),
    };

    let parser_opts = ParserOptions::default();
    let stylesheet = match StyleSheet::parse(&css_source, parser_opts) {
        Ok(s) => s,
        Err(_) => return out,
    };

    // First pass: collect rules + tokens, keyed by primary class.
    let mut class_to_rules: HashMap<String, Vec<RuleData>> = HashMap::new();
    let mut global_rules: Vec<RuleData> = Vec::new();
    let mut tokens: Vec<TokenData> = Vec::new();
    let mut at_rules: Vec<AtRuleData> = Vec::new();

    visit_rules(&stylesheet.rules.0, None, &mut |rule, wrapper| match rule {
        CssRule::Style(s) => collect_style_rule(
            s,
            wrapper,
            &mut class_to_rules,
            &mut global_rules,
            &mut tokens,
        ),
        CssRule::Keyframes(k) => at_rules.push(AtRuleData {
            kind: "keyframes",
            name: k
                .name
                .to_css_string(PrinterOptions::default())
                .unwrap_or_default(),
            css_text: render_rule_to_string(rule),
        }),
        CssRule::FontFace(_) => at_rules.push(AtRuleData {
            kind: "fontface",
            name: "font-face".into(),
            css_text: render_rule_to_string(rule),
        }),
        CssRule::Import(i) => at_rules.push(AtRuleData {
            kind: "import",
            name: i.url.to_string(),
            css_text: format!("@import \"{}\";", i.url),
        }),
        _ => {}
    });
    // stylesheet borrow ends here; the collected Data structs are owned.

    // Emit style_token nodes for each --foo: value found.
    for tok in &tokens {
        let id = stable_node_id(&IdParts {
            project_name,
            file_path: &file.path,
            node_type: "style_token",
            symbol_path: &format!("token:{}", tok.name),
            extra: &tok.scope,
            ..Default::default()
        });
        out.nodes.push(
            Node::new(&id, NodeKind::StyleToken, &tok.name).with_data(json!({
                "tokenName": tok.name,
                "value": tok.value,
                "scope": tok.scope,
            })),
        );
        out.edges.push(Edge::new(
            stable_edge_id(project_name, &file_node_id, &id, "contains"),
            &file_node_id,
            &id,
            EdgeKind::Contains,
        ));
    }

    // Emit style nodes for primary classes.
    for (class_name, rules) in class_to_rules {
        let id = stable_node_id(&IdParts {
            project_name,
            file_path: &file.path,
            node_type: "style",
            symbol_path: &format!("class:{class_name}"),
            ..Default::default()
        });
        let synth_id = stable_node_id(&IdParts {
            project_name,
            file_path: &file.path,
            node_type: "style_synth",
            symbol_path: &class_name,
            ..Default::default()
        });
        out.nodes.push(
            Node::new(&id, NodeKind::Style, &class_name).with_data(json!({
                "kind": "class",
                "className": class_name,
                "synthesizedId": format!("ecto-sty_{synth_id}"),
                "rules": rules.iter().map(|r| json!({
                    "selector": r.selector,
                    "wrapper": r.wrapper,
                    "declarations": r.declarations,
                })).collect::<Vec<_>>(),
            })),
        );
        out.edges.push(Edge::new(
            stable_edge_id(project_name, &file_node_id, &id, "contains"),
            &file_node_id,
            &id,
            EdgeKind::Contains,
        ));
        out.class_to_style_node.insert(class_name, id);
    }

    // Emit style nodes for global rules (non-class selectors).
    for (idx, rule) in global_rules.iter().enumerate() {
        let id = stable_node_id(&IdParts {
            project_name,
            file_path: &file.path,
            node_type: "style",
            symbol_path: &format!("global:{}", rule.selector),
            offset: Some(idx as u32),
            ..Default::default()
        });
        out.nodes.push(
            Node::new(&id, NodeKind::Style, &rule.selector).with_data(json!({
                "kind": "rule",
                "rules": [{
                    "selector": rule.selector,
                    "wrapper": rule.wrapper,
                    "declarations": rule.declarations,
                }],
            })),
        );
        out.edges.push(Edge::new(
            stable_edge_id(project_name, &file_node_id, &id, "contains"),
            &file_node_id,
            &id,
            EdgeKind::Contains,
        ));
    }

    // Emit style nodes for at-rules captured verbatim.
    for (idx, atr) in at_rules.iter().enumerate() {
        let id = stable_node_id(&IdParts {
            project_name,
            file_path: &file.path,
            node_type: "style",
            symbol_path: &format!("atrule:{}:{}", atr.kind, atr.name),
            offset: Some(idx as u32),
            ..Default::default()
        });
        out.nodes.push(
            Node::new(&id, NodeKind::Style, &format!("@{}", atr.kind)).with_data(json!({
                "kind": "atrule",
                "atKind": atr.kind,
                "atName": atr.name,
                "cssText": atr.css_text,
            })),
        );
        out.edges.push(Edge::new(
            stable_edge_id(project_name, &file_node_id, &id, "contains"),
            &file_node_id,
            &id,
            EdgeKind::Contains,
        ));
    }

    out
}

/// Register a binary asset file. The browser shell pre-encodes binaries
/// to `data:…;base64,…` strings and stores them in FileBlob.content; we
/// just emit a file + asset node here, and `resolve.rs` wires `import
/// logo from './foo.png'` references to them.
pub fn register_asset_blob(project_name: &str, file: &FileBlob) -> (Vec<Node>, Vec<Edge>) {
    let file_node_id = stable_node_id(&IdParts {
        project_name,
        file_path: &file.path,
        node_type: "file",
        ..Default::default()
    });
    let asset_node_id = stable_node_id(&IdParts {
        project_name,
        file_path: &file.path,
        node_type: "asset",
        ..Default::default()
    });
    let nodes = vec![
        Node::new(&file_node_id, NodeKind::File, file.file_name()).with_data(json!({
            "filePath": &file.path,
            "ext": file.ext(),
            "isAsset": true,
        })),
        Node::new(&asset_node_id, NodeKind::Asset, file.file_name()).with_data(json!({
            "filePath": &file.path,
            "dataUri": &file.content,
        })),
    ];
    let edges = vec![Edge::new(
        stable_edge_id(project_name, &file_node_id, &asset_node_id, "contains"),
        &file_node_id,
        &asset_node_id,
        EdgeKind::Contains,
    )];
    (nodes, edges)
}

// ── helpers ───────────────────────────────────────────────────────

#[derive(Debug, Clone)]
struct RuleData {
    selector: String,
    wrapper: Option<String>,
    declarations: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone)]
struct TokenData {
    name: String,
    value: String,
    scope: String,
}

#[derive(Debug, Clone)]
struct AtRuleData {
    kind: &'static str,
    name: String,
    css_text: String,
}

fn visit_rules(
    rules: &[CssRule<'_>],
    wrapper: Option<&str>,
    f: &mut dyn FnMut(&CssRule<'_>, Option<&str>),
) {
    for rule in rules {
        match rule {
            CssRule::Media(m) => {
                let header = format!("@media {}", render_media_list(&m.query));
                visit_rules(&m.rules.0, Some(&header), f);
            }
            CssRule::Supports(s) => {
                let header = format!(
                    "@supports {}",
                    s.condition
                        .to_css_string(PrinterOptions::default())
                        .unwrap_or_default()
                );
                visit_rules(&s.rules.0, Some(&header), f);
            }
            other => f(other, wrapper),
        }
    }
}

fn render_media_list(q: &lightningcss::media_query::MediaList<'_>) -> String {
    q.to_css_string(PrinterOptions::default()).unwrap_or_default()
}

/// Stringify a single rule via ToCss. Avoids cloning into a new sheet,
/// which would require an unrelated lifetime.
fn render_rule_to_string(rule: &CssRule<'_>) -> String {
    let mut out = String::new();
    let mut printer = lightningcss::printer::Printer::new(&mut out, PrinterOptions::default());
    let _ = rule.to_css(&mut printer);
    out
}

fn collect_style_rule(
    rule: &StyleRule<'_>,
    wrapper: Option<&str>,
    class_index: &mut HashMap<String, Vec<RuleData>>,
    global_rules: &mut Vec<RuleData>,
    tokens: &mut Vec<TokenData>,
) {
    let declarations = collect_declarations(&rule.declarations, tokens, &rule.selectors.0.iter().next().map(|s| selector_to_string(s)).unwrap_or_default());
    let selector_strs: Vec<String> = rule.selectors.0.iter().map(selector_to_string).collect();
    for sel in &selector_strs {
        let entry = RuleData {
            selector: sel.clone(),
            wrapper: wrapper.map(str::to_string),
            declarations: declarations.clone(),
        };
        if let Some(primary) = primary_class_from_selector(sel) {
            class_index.entry(primary).or_default().push(entry);
        } else {
            global_rules.push(entry);
        }
    }
}

fn collect_declarations(
    block: &DeclarationBlock<'_>,
    tokens: &mut Vec<TokenData>,
    scope: &str,
) -> serde_json::Map<String, Value> {
    let mut map = serde_json::Map::new();
    for decl in block
        .declarations
        .iter()
        .chain(block.important_declarations.iter())
    {
        let (prop_name, value_str) = serialize_property(decl);
        map.insert(prop_name.clone(), Value::String(value_str.clone()));
        if let Some(stripped) = prop_name.strip_prefix("--") {
            tokens.push(TokenData {
                name: stripped.to_string(),
                value: value_str,
                scope: scope.to_string(),
            });
        }
    }
    map
}

fn serialize_property(decl: &Property<'_>) -> (String, String) {
    let mut name = decl.property_id().name().to_string();
    if let Property::Custom(c) = decl {
        name = c.name.as_ref().to_string();
    }
    let mut value = String::new();
    // Round-trip via printer to get a canonical string form.
    let mut printer = lightningcss::printer::Printer::new(&mut value, PrinterOptions::default());
    let _ = decl.value_to_css(&mut printer);
    (name, value)
}

fn selector_to_string(sel: &lightningcss::selector::Selector<'_>) -> String {
    sel.to_css_string(PrinterOptions::default()).unwrap_or_default().trim().to_string()
}

pub fn primary_class_from_selector(selector: &str) -> Option<String> {
    let first = selector.split(',').next()?.trim();
    let re = regex::Regex::new(r"\.([A-Za-z_][\w-]*)").ok()?;
    re.captures(first).map(|c| c[1].to_string())
}

pub fn all_classes_in_selector(selector: &str) -> Vec<String> {
    let Some(re) = regex::Regex::new(r"\.([A-Za-z_][\w-]*)").ok() else {
        return Vec::new();
    };
    re.captures_iter(selector)
        .map(|c| c[1].to_string())
        .collect()
}

fn is_css_module_path(path: &str) -> bool {
    path.ends_with(".module.css") || path.ends_with(".module.scss") || path.ends_with(".module.sass")
}

// keep an unused import named in scope while the API stabilizes
#[allow(dead_code)]
fn _phantom(_a: Ident<'_>, _b: CowArcStr<'_>) {}
