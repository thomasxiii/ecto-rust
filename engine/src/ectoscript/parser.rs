//! Parse the outline into a typed `EctoFile`. Tries hard to recover at
//! the top-decl boundary: a broken declaration is reported as an error
//! but the rest of the file still parses.

use serde::Serialize;

use super::ast::*;
use super::lexer::{classify, is_ident, Literal};
use super::outline::{build_outline, OutlineNode};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParseError {
    pub message: String,
    pub line: usize,
    pub col: usize,
}

#[derive(Debug, Clone)]
pub struct ParseResult {
    pub file: EctoFile,
    pub errors: Vec<ParseError>,
}

pub fn parse(source: &str) -> ParseResult {
    let outline = build_outline(source);
    let mut errors: Vec<ParseError> = Vec::new();
    let mut decls: Vec<TopDecl> = Vec::new();
    for node in outline.children {
        match parse_top_decl(&node) {
            Ok(Some(d)) => decls.push(d),
            Ok(None) => {}
            Err(e) => errors.push(e),
        }
    }
    ParseResult {
        file: EctoFile { decls },
        errors,
    }
}

fn parse_top_decl(node: &OutlineNode) -> Result<Option<TopDecl>, ParseError> {
    let head = node
        .tokens
        .first()
        .map(String::as_str)
        .ok_or_else(|| err(node, "empty declaration"))?;
    Ok(match head {
        "model" => parse_model(node)?.map(TopDecl::Model),
        "component" => parse_component(node)?.map(TopDecl::Component),
        "token" => parse_token(node)?.map(TopDecl::Token),
        "derived" => parse_derived(node)?.map(TopDecl::Derived),
        "styles" => parse_styles(node)?.map(TopDecl::Styles),
        "query" => parse_query(node)?.map(TopDecl::Query),
        _ => {
            return Err(err(
                node,
                &format!("expected top-level declaration, got `{}`", head),
            ))
        }
    })
}

fn parse_model(node: &OutlineNode) -> Result<Option<ModelDecl>, ParseError> {
    let name = node
        .tokens
        .get(1)
        .cloned()
        .ok_or_else(|| err(node, "`model` requires a name"))?;
    if !is_ident(&name) {
        return Err(err(node, &format!("invalid model name `{name}`")));
    }
    let mut states = Vec::new();
    for child in &node.children {
        match child.tokens.first().map(String::as_str) {
            Some("state") => match parse_state(child) {
                Ok(Some(s)) => states.push(s),
                Ok(None) => {}
                Err(e) => return Err(e),
            },
            Some(other) => {
                return Err(err(
                    child,
                    &format!("in model `{name}`: unexpected `{other}`"),
                ))
            }
            None => {}
        }
    }
    Ok(Some(ModelDecl {
        pos: pos(node),
        name,
        states,
    }))
}

fn parse_state(node: &OutlineNode) -> Result<Option<StateDecl>, ParseError> {
    // `state Name = Literal` (RHS optional, defaults null).
    let name = node
        .tokens
        .get(1)
        .cloned()
        .ok_or_else(|| err(node, "`state` requires a name"))?;
    let initial = if node.tokens.get(2).map(String::as_str) == Some("=") {
        let rhs: Vec<&str> = node.tokens[3..].iter().map(String::as_str).collect();
        if rhs.is_empty() {
            Literal::Null
        } else if rhs.len() == 1 {
            classify(rhs[0])
        } else {
            classify(&rhs.join(""))
        }
    } else {
        Literal::Null
    };
    let traits = collect_traits(node);
    Ok(Some(StateDecl {
        pos: pos(node),
        name,
        initial,
        traits,
    }))
}

fn parse_component(node: &OutlineNode) -> Result<Option<ComponentDecl>, ParseError> {
    let name = node
        .tokens
        .get(1)
        .cloned()
        .ok_or_else(|| err(node, "`component` requires a name"))?;
    if !is_ident(&name) {
        return Err(err(node, &format!("invalid component name `{name}`")));
    }
    let mut uses = Vec::new();
    let mut states = Vec::new();
    let mut render: Option<ElementNode> = None;

    for child in &node.children {
        match child.tokens.first().map(String::as_str) {
            Some("uses") => uses.push(parse_uses(child)?),
            Some("state") => {
                if let Some(s) = parse_state(child)? {
                    states.push(s);
                }
            }
            Some("render") => {
                if let Some(first) = child
                    .children
                    .iter()
                    .find(|c| c.tokens.first().map(String::as_str) == Some("<"))
                {
                    render = Some(parse_element(first)?);
                }
            }
            Some(other) => {
                return Err(err(
                    child,
                    &format!("in component `{name}`: unexpected `{other}`"),
                ))
            }
            None => {}
        }
    }

    Ok(Some(ComponentDecl {
        pos: pos(node),
        name,
        uses,
        states,
        render,
    }))
}

fn parse_uses(node: &OutlineNode) -> Result<UsesDecl, ParseError> {
    let model = node
        .tokens
        .get(1)
        .cloned()
        .ok_or_else(|| err(node, "`uses` requires a model name"))?;
    Ok(UsesDecl {
        pos: pos(node),
        model,
        traits: collect_traits(node),
    })
}

fn parse_token(node: &OutlineNode) -> Result<Option<TokenDecl>, ParseError> {
    // `token Name = Literal`
    let name = node
        .tokens
        .get(1)
        .cloned()
        .ok_or_else(|| err(node, "`token` requires a name"))?;
    if node.tokens.get(2).map(String::as_str) != Some("=") {
        return Err(err(node, &format!("`token {name}` missing `=` value")));
    }
    let rhs: Vec<&str> = node.tokens[3..].iter().map(String::as_str).collect();
    let value = match rhs.len() {
        0 => Literal::Null,
        1 => classify(rhs[0]),
        _ => classify(&rhs.join("")),
    };
    Ok(Some(TokenDecl {
        pos: pos(node),
        name,
        value,
    }))
}

fn parse_derived(node: &OutlineNode) -> Result<Option<DerivedDecl>, ParseError> {
    // `derived Name = <expr>`
    let name = node
        .tokens
        .get(1)
        .cloned()
        .ok_or_else(|| err(node, "`derived` requires a name"))?;
    if node.tokens.get(2).map(String::as_str) != Some("=") {
        return Err(err(node, &format!("`derived {name}` missing `=` expr")));
    }
    let rest: Vec<&str> = node.tokens[3..].iter().map(String::as_str).collect();
    let expr = if rest.len() == 5 && rest[0] == "if" && rest[3] == "or" {
        // `if PATH then or else`
        DerivedExpr::IfElse {
            cond: split_path(rest[1]),
            then_ref: rest[2].to_string(),
            else_ref: rest[4].to_string(),
        }
    } else if rest.len() == 1 {
        DerivedExpr::Ref(rest[0].to_string())
    } else {
        DerivedExpr::Raw(rest.join(" "))
    };
    Ok(Some(DerivedDecl {
        pos: pos(node),
        name,
        expr,
    }))
}

fn parse_styles(node: &OutlineNode) -> Result<Option<StylesDecl>, ParseError> {
    let name = node
        .tokens
        .get(1)
        .cloned()
        .ok_or_else(|| err(node, "`styles` requires a name"))?;
    let mut props = Vec::new();
    for child in &node.children {
        let colon_idx = child.tokens.iter().position(|t| t == ":");
        let colon = match colon_idx {
            Some(c) => c,
            None => continue,
        };
        if colon == 0 {
            continue;
        }
        let prop_name: String = child.tokens[..colon].join("");
        let values: Vec<Literal> = child.tokens[colon + 1..]
            .iter()
            .map(|t| classify(t))
            .collect();
        props.push(StyleProp {
            pos: pos(child),
            name: prop_name,
            values,
        });
    }
    Ok(Some(StylesDecl {
        pos: pos(node),
        name,
        props,
    }))
}

fn parse_query(node: &OutlineNode) -> Result<Option<QueryDecl>, ParseError> {
    let name = node
        .tokens
        .get(1)
        .cloned()
        .ok_or_else(|| err(node, "`query` requires a name"))?;
    if node.tokens.get(2).map(String::as_str) != Some("=") {
        return Err(err(node, &format!("`query {name}` missing `=` source")));
    }
    let source_tok = node
        .tokens
        .get(3)
        .cloned()
        .ok_or_else(|| err(node, &format!("`query {name}` missing source")))?;
    let source = split_path(&source_tok);
    let mut filters = Vec::new();
    for child in &node.children {
        // `where Field is <value-expr>`
        if child.tokens.first().map(String::as_str) == Some("where")
            && child.tokens.get(2).map(String::as_str) == Some("is")
        {
            let field = child.tokens[1].clone();
            let rest: Vec<&str> = child.tokens[3..].iter().map(String::as_str).collect();
            let value = parse_value_expr(&rest);
            filters.push(QueryFilter { field, value });
        }
    }
    Ok(Some(QueryDecl {
        pos: pos(node),
        name,
        source,
        filters,
    }))
}

fn parse_element(node: &OutlineNode) -> Result<ElementNode, ParseError> {
    // Tokens: < Ident <modifier>*
    let name = node
        .tokens
        .get(1)
        .cloned()
        .ok_or_else(|| err(node, "element missing name after `<`"))?;
    let mut el = ElementNode {
        pos: pos(node),
        name: name.clone(),
        when: None,
        styles: Vec::new(),
        traits: Vec::new(),
        events: Vec::new(),
        bindings: Vec::new(),
        attrs: Vec::new(),
        children: Vec::new(),
        loop_var: None,
        loop_source: None,
    };

    // Loop form: `< for Var in Source`
    if name == "for" {
        if node.tokens.get(2).map(String::as_str).is_some()
            && node.tokens.get(3).map(String::as_str) == Some("in")
        {
            el.loop_var = Some(node.tokens[2].clone());
            if let Some(src) = node.tokens.get(4) {
                el.loop_source = Some(split_path(src));
            }
        } else {
            return Err(err(node, "expected `for Var in Source`"));
        }
    } else {
        // Inline modifiers after the element name: when X / when X is L / prop binds Path.
        let toks: Vec<&str> = node.tokens.iter().map(String::as_str).collect();
        let mut i = 2;
        let mut consumed_up_to = 1;
        while i < toks.len() {
            match toks[i] {
                "when" => {
                    if let Some(path) = toks.get(i + 1) {
                        if toks.get(i + 2) == Some(&"is") {
                            if let Some(lit) = toks.get(i + 3) {
                                el.when = Some(WhenRule::Equals {
                                    path: split_path(path),
                                    literal: classify(lit),
                                });
                                consumed_up_to = i + 3;
                                i += 4;
                                continue;
                            }
                        }
                        el.when = Some(WhenRule::Truthy {
                            path: split_path(path),
                        });
                        consumed_up_to = i + 1;
                        i += 2;
                        continue;
                    }
                    i += 1;
                }
                "binds" => {
                    // The prop word is the token immediately before `binds`,
                    // unless that token was consumed by a prior modifier.
                    let prop = if i > 0 && i - 1 > consumed_up_to {
                        toks[i - 1].to_string()
                    } else {
                        // Default prop = "text" — matches TS behavior.
                        "text".to_string()
                    };
                    if let Some(path) = toks.get(i + 1) {
                        el.bindings.push(BindingDecl {
                            pos: pos(node),
                            prop,
                            target: split_path(path),
                        });
                        consumed_up_to = i + 1;
                        i += 2;
                        continue;
                    }
                    i += 1;
                }
                _ => {
                    i += 1;
                }
            }
        }
    }

    for child in &node.children {
        let head = child.tokens.first().map(String::as_str).unwrap_or("");
        match head {
            "<" => el.children.push(parse_element(child)?),
            "style" => {
                if let Some(name) = child.tokens.get(1) {
                    el.styles.push(name.clone());
                }
            }
            "is" => {
                if let Some(name) = child.tokens.get(1) {
                    el.traits.push(name.clone());
                }
            }
            "on" => {
                if let Some(event) = child.tokens.get(1) {
                    let mut actions = Vec::new();
                    for action_node in &child.children {
                        if let Some(a) = parse_action(action_node) {
                            actions.push(a);
                        }
                    }
                    el.events.push(EventHandler {
                        pos: pos(child),
                        event: event.clone(),
                        actions,
                    });
                }
            }
            _ => {
                // `Prop binds Path` (3-token form) or `Prop : value...`.
                if child.tokens.get(1).map(String::as_str) == Some("binds") {
                    if let Some(path) = child.tokens.get(2) {
                        el.bindings.push(BindingDecl {
                            pos: pos(child),
                            prop: child.tokens[0].clone(),
                            target: split_path(path),
                        });
                    }
                } else if child.tokens.get(1).map(String::as_str) == Some(":") {
                    let rest: Vec<&str> = child.tokens[2..].iter().map(String::as_str).collect();
                    let value = if rest.len() == 1 {
                        classify(rest[0])
                    } else if rest.is_empty() {
                        Literal::Null
                    } else {
                        classify(&rest.join(""))
                    };
                    el.attrs.push((child.tokens[0].clone(), value));
                } else {
                    return Err(err(
                        child,
                        &format!("in element `<{name}>`: unexpected `{head}`"),
                    ));
                }
            }
        }
    }

    Ok(el)
}

fn parse_action(node: &OutlineNode) -> Option<ActionNode> {
    let head = node.tokens.first().map(String::as_str)?;
    match head {
        "toggle" => Some(ActionNode::Toggle {
            target: split_path(node.tokens.get(1)?),
        }),
        "set" => {
            // `set Path = <value-expr>`
            let target = split_path(node.tokens.get(1)?);
            if node.tokens.get(2).map(String::as_str) != Some("=") {
                return None;
            }
            let rest: Vec<&str> = node.tokens[3..].iter().map(String::as_str).collect();
            Some(ActionNode::Set {
                target,
                value: parse_value_expr(&rest),
            })
        }
        "clear" => Some(ActionNode::Clear {
            target: split_path(node.tokens.get(1)?),
        }),
        "add" => {
            // `add to Path` with field children of the form `name: <value-expr>`.
            if node.tokens.get(1).map(String::as_str) != Some("to") {
                return None;
            }
            let target = split_path(node.tokens.get(2)?);
            let mut fields = Vec::new();
            for child in &node.children {
                let colon_idx = child.tokens.iter().position(|t| t == ":")?;
                if colon_idx == 0 {
                    continue;
                }
                let name: String = child.tokens[..colon_idx].join("");
                let rest: Vec<&str> = child.tokens[colon_idx + 1..]
                    .iter()
                    .map(String::as_str)
                    .collect();
                fields.push(AddField {
                    name,
                    value: parse_value_expr(&rest),
                });
            }
            Some(ActionNode::Add { target, fields })
        }
        _ => None,
    }
}

fn parse_value_expr(rest: &[&str]) -> ValueExpr {
    // 6-token `match X in Y by Z`.
    if rest.len() == 6 && rest[0] == "match" && rest[2] == "in" && rest[4] == "by" {
        return ValueExpr::Match {
            input: split_path(rest[1]),
            collection: split_path(rest[3]),
            field: rest[5].to_string(),
        };
    }
    if rest.len() == 1 {
        let tok = rest[0];
        let lit = classify(tok);
        // Single-token paths (identifier / qualified) are paths, not literals.
        match &lit {
            Literal::Ident(name) => return ValueExpr::Path(vec![name.clone()]),
            Literal::Qualified(segs) => return ValueExpr::Path(segs.clone()),
            _ => return ValueExpr::Literal(lit),
        }
    }
    if rest.is_empty() {
        return ValueExpr::Literal(Literal::Null);
    }
    ValueExpr::Literal(classify(&rest.join("")))
}

fn split_path(s: &str) -> Vec<String> {
    s.split('.').map(str::to_string).collect()
}

fn collect_traits(node: &OutlineNode) -> Vec<String> {
    let mut out = Vec::new();
    for child in &node.children {
        if child.tokens.first().map(String::as_str) == Some("is") {
            if let Some(name) = child.tokens.get(1) {
                out.push(name.clone());
            }
        }
    }
    out
}

fn pos(node: &OutlineNode) -> Pos {
    Pos {
        line: node.line,
        col: node.col,
    }
}

fn err(node: &OutlineNode, msg: &str) -> ParseError {
    ParseError {
        message: msg.to_string(),
        line: node.line.max(1),
        col: node.col.max(1),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_minimal_model() {
        let src = "model A\n  state x = 1\n";
        let res = parse(src);
        assert!(res.errors.is_empty(), "{:?}", res.errors);
        assert_eq!(res.file.decls.len(), 1);
    }

    #[test]
    fn parses_component_with_render() {
        let src = "component App\n  render\n    < container\n      text: \"hi\"\n";
        let res = parse(src);
        assert!(res.errors.is_empty(), "{:?}", res.errors);
    }

    #[test]
    fn rejects_unknown_top_decl() {
        let src = "frobnicate Foo\n";
        let res = parse(src);
        assert_eq!(res.errors.len(), 1);
    }
}
