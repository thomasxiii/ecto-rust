//! JS/TS/JSX parsing via `oxc`.
//!
//! Ports the core of `web/src/importer/parseFile.ts`. The output is
//! shape-compatible with the TS importer so downstream code (server,
//! UI, runtime) doesn't care which parser produced it.
//!
//! Scope of the v1 port:
//! - `import` declarations (default, named, namespace, side-effect)
//! - function-declared, arrow-assigned, and default-exported components
//! - JSX elements + fragments, recursively
//! - text children (JSX text + string-literal expression containers)
//! - JSX attributes → `prop` nodes (literal strings, numbers, booleans,
//!   shallow object expressions like `style={{ … }}`)
//! - `on*` event handlers → `event` nodes
//! - `className={styles.foo}` → pending `StyleRef` (resolved post-pass)
//! - `useState(initial)` calls → `state` nodes
//! - `href="…"` literal references → pending `HrefRef`
//!
//! Deferred:
//! - dynamic className templates, computed CSS-module access
//! - hoisted `const content = <…/>` reuse via identifier in JSX children
//! - effects / data-fetching / async-op nodes

use super::types::{FileBlob, ImportSpec, ParsedScript, StyleRef};
use crate::graph::edge::{Edge, EdgeKind};
use crate::graph::kinds::NodeKind;
use crate::graph::node::{Node, SourceMap};
use crate::stable_id::{stable_edge_id, stable_node_id, IdParts};
use oxc_allocator::Allocator;
use oxc_ast::ast as oast;
use oxc_parser::{ParseOptions, Parser};
use oxc_span::SourceType;
use serde_json::{json, Value};

pub fn parse_script(project_name: &str, file: &FileBlob) -> ParsedScript {
    let allocator = Allocator::default();
    let source_type = SourceType::from_path(&file.path).unwrap_or_else(|_| SourceType::tsx());
    let ret = Parser::new(&allocator, &file.content, source_type)
        .with_options(ParseOptions {
            allow_return_outside_function: true,
            ..ParseOptions::default()
        })
        .parse();

    let program = ret.program;

    let mut out = ParsedScript {
        file_path: file.path.clone(),
        ..Default::default()
    };

    // File + module nodes
    let file_node_id = stable_node_id(&IdParts {
        project_name,
        file_path: &file.path,
        node_type: "file",
        ..Default::default()
    });
    let module_node_id = stable_node_id(&IdParts {
        project_name,
        file_path: &file.path,
        node_type: "module",
        ..Default::default()
    });
    out.file_node_id = file_node_id.clone();
    out.module_node_id = module_node_id.clone();

    let file_name = file.file_name().to_string();
    out.nodes.push(
        Node::new(&file_node_id, NodeKind::File, &file_name).with_data(json!({
            "filePath": &file.path,
            "ext": file.ext(),
        })),
    );
    out.nodes.push(Node::new(&module_node_id, NodeKind::Module, &file_name));
    out.edges.push(Edge::new(
        stable_edge_id(project_name, &file_node_id, &module_node_id, "contains"),
        &file_node_id,
        &module_node_id,
        EdgeKind::Contains,
    ));

    let mut ctx = Ctx {
        project_name,
        file_path: &file.path,
        source: &file.content,
        module_node_id: module_node_id.clone(),
        out: &mut out,
    };

    // ── Pass 1: imports ────────────────────────────────────────────
    for stmt in &program.body {
        if let oast::Statement::ImportDeclaration(decl) = stmt {
            ctx.handle_import(decl);
        }
    }

    // ── Pass 2: top-level component declarations ───────────────────
    for stmt in &program.body {
        match stmt {
            oast::Statement::FunctionDeclaration(decl) => {
                if let Some(id) = &decl.id {
                    if is_component_name(&id.name) {
                        let comp_id = ctx.register_component(&id.name, decl.span, false, false);
                        ctx.walk_component_body(&decl.body.as_deref(), &id.name, &comp_id);
                    }
                }
            }
            oast::Statement::VariableDeclaration(var_decl) => {
                ctx.handle_var_decl(var_decl, false, false);
            }
            oast::Statement::ExportDefaultDeclaration(default) => {
                ctx.handle_export_default(default);
            }
            oast::Statement::ExportNamedDeclaration(named) => {
                if let Some(decl) = &named.declaration {
                    ctx.handle_export_named_declaration(decl);
                }
            }
            _ => {}
        }
    }

    out
}

// ──────────────────────────────────────────────────────────────────
// Walker context

struct Ctx<'a, 'b> {
    project_name: &'a str,
    file_path: &'a str,
    source: &'a str,
    module_node_id: String,
    out: &'b mut ParsedScript,
}

impl<'a, 'b> Ctx<'a, 'b> {
    fn make_node_id(&self, node_type: &str, symbol_path: &str, offset: Option<u32>) -> String {
        stable_node_id(&IdParts {
            project_name: self.project_name,
            file_path: self.file_path,
            node_type,
            symbol_path,
            offset,
            extra: "",
        })
    }

    fn push_edge(
        &mut self,
        from: &str,
        to: &str,
        kind: EdgeKind,
        data: Option<Value>,
        order: Option<i32>,
    ) {
        let kind_str = serde_json::to_value(kind)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_default();
        let base = stable_edge_id(self.project_name, from, to, &kind_str);
        let id = match order {
            Some(o) => format!("{base}_{o}"),
            None => base,
        };
        let mut edge = Edge {
            id,
            project_id: String::new(),
            from_node_id: from.to_string(),
            to_node_id: to.to_string(),
            kind,
            data,
            order,
            created_at: String::new(),
        };
        // dedupe: the TS importer relies on stable edge IDs to dedupe
        // naturally; we mirror that by skipping if id already exists.
        if self.out.edges.iter().any(|e| e.id == edge.id) {
            return;
        }
        // Sanity: keep id-determinism for ordered edges by ensuring order
        // sticks.
        if order.is_none() {
            edge.order = None;
        }
        self.out.edges.push(edge);
    }

    fn source_map(&self, span: oxc_span::Span) -> SourceMap {
        let (start_line, start_col) = line_col(self.source, span.start);
        let (end_line, end_col) = line_col(self.source, span.end);
        SourceMap {
            file_path: Some(self.file_path.to_string()),
            start_line: Some(start_line),
            end_line: Some(end_line),
            start_col: Some(start_col),
            end_col: Some(end_col),
        }
    }

    fn handle_import(&mut self, decl: &oast::ImportDeclaration<'_>) {
        let source = decl.source.value.as_str();
        let Some(specs) = &decl.specifiers else {
            self.out.side_effect_imports.push(source.to_string());
            return;
        };
        if specs.is_empty() {
            self.out.side_effect_imports.push(source.to_string());
            return;
        }
        for spec in specs {
            let (local, imported) = match spec {
                oast::ImportDeclarationSpecifier::ImportSpecifier(s) => (
                    s.local.name.to_string(),
                    match &s.imported {
                        oast::ModuleExportName::IdentifierName(n) => n.name.to_string(),
                        oast::ModuleExportName::IdentifierReference(n) => n.name.to_string(),
                        oast::ModuleExportName::StringLiteral(s) => s.value.to_string(),
                    },
                ),
                oast::ImportDeclarationSpecifier::ImportDefaultSpecifier(s) => {
                    (s.local.name.to_string(), "default".to_string())
                }
                oast::ImportDeclarationSpecifier::ImportNamespaceSpecifier(s) => {
                    (s.local.name.to_string(), "*".to_string())
                }
            };
            let imp_id = self.make_node_id(
                "import",
                &format!("import:{local}:{source}"),
                Some(decl.span.start),
            );
            let module_id = self.module_node_id.clone();
            self.out.nodes.push(
                Node::new(&imp_id, NodeKind::Import, &local)
                    .with_data(json!({
                        "source": source,
                        "imported": imported,
                        "local": local,
                    }))
                    .with_source(self.source_map(decl.span)),
            );
            self.push_edge(
                &module_id,
                &imp_id,
                EdgeKind::Imports,
                Some(json!({"source": source, "imported": imported})),
                None,
            );
            self.out.imports.insert(
                local,
                ImportSpec {
                    source: source.to_string(),
                    imported,
                    node_id: imp_id,
                },
            );
        }
    }

    fn handle_var_decl(
        &mut self,
        decl: &oast::VariableDeclaration<'_>,
        exported: bool,
        is_default: bool,
    ) {
        for declarator in &decl.declarations {
            let oast::BindingPatternKind::BindingIdentifier(id) = &declarator.id.kind else {
                continue;
            };
            if !is_component_name(&id.name) {
                continue;
            }
            let Some(init) = &declarator.init else {
                continue;
            };
            let (fn_body, fn_span) = match init {
                oast::Expression::ArrowFunctionExpression(arrow) => (
                    ArrowOrFunctionBody::Arrow(&arrow.body),
                    arrow.span,
                ),
                oast::Expression::FunctionExpression(func) => {
                    let body = func.body.as_deref();
                    (ArrowOrFunctionBody::Function(body), func.span)
                }
                _ => continue,
            };
            let comp_id = self.register_component(&id.name, fn_span, exported, is_default);
            match fn_body {
                ArrowOrFunctionBody::Arrow(body) => {
                    self.walk_arrow_body(body, &id.name, &comp_id);
                }
                ArrowOrFunctionBody::Function(body) => {
                    self.walk_component_body(&body, &id.name, &comp_id);
                }
            }
        }
    }

    fn handle_export_default(&mut self, default: &oast::ExportDefaultDeclaration<'_>) {
        match &default.declaration {
            oast::ExportDefaultDeclarationKind::FunctionDeclaration(decl) => {
                let name = decl
                    .id
                    .as_ref()
                    .map(|i| i.name.to_string())
                    .unwrap_or_else(|| {
                        self.file_path
                            .rsplit('/')
                            .next()
                            .unwrap_or("default")
                            .trim_end_matches(|c: char| c.is_ascii_alphabetic() || c == '.')
                            .to_string()
                    });
                let final_name = if is_component_name(&name) {
                    name
                } else {
                    self.derive_default_name()
                };
                let comp_id = self.register_component(&final_name, decl.span, true, true);
                self.walk_component_body(&decl.body.as_deref(), &final_name, &comp_id);
            }
            oast::ExportDefaultDeclarationKind::ArrowFunctionExpression(arrow) => {
                let name = self.derive_default_name();
                let comp_id = self.register_component(&name, arrow.span, true, true);
                self.walk_arrow_body(&arrow.body, &name, &comp_id);
            }
            _ => {}
        }
    }

    fn handle_export_named_declaration(&mut self, decl: &oast::Declaration<'_>) {
        match decl {
            oast::Declaration::FunctionDeclaration(func) => {
                if let Some(id) = &func.id {
                    if is_component_name(&id.name) {
                        let comp_id = self.register_component(&id.name, func.span, true, false);
                        self.walk_component_body(&func.body.as_deref(), &id.name, &comp_id);
                    }
                }
            }
            oast::Declaration::VariableDeclaration(var_decl) => {
                self.handle_var_decl(var_decl, true, false);
            }
            _ => {}
        }
    }

    fn derive_default_name(&self) -> String {
        let stem = self
            .file_path
            .rsplit('/')
            .next()
            .unwrap_or("Default")
            .rsplit('.')
            .nth(1)
            .or_else(|| Some("Default"))
            .unwrap()
            .to_string();
        if is_component_name(&stem) {
            stem
        } else {
            // Fallback to the dot-stripped basename, capitalized.
            let base = self
                .file_path
                .rsplit('/')
                .next()
                .unwrap_or("Default")
                .split('.')
                .next()
                .unwrap_or("Default");
            let mut chars = base.chars();
            match chars.next() {
                Some(c) => c.to_ascii_uppercase().to_string() + chars.as_str(),
                None => "Default".into(),
            }
        }
    }

    fn register_component(
        &mut self,
        name: &str,
        span: oxc_span::Span,
        exported: bool,
        is_default: bool,
    ) -> String {
        if let Some(existing) = self.out.components.get(name) {
            return existing.clone();
        }
        let comp_id = self.make_node_id(
            "component",
            &format!("comp:{name}"),
            Some(span.start),
        );
        self.out.nodes.push(
            Node::new(&comp_id, NodeKind::Component, name)
                .with_data(json!({
                    "exported": exported,
                    "isDefault": is_default,
                    "propDefaults": [],
                }))
                .with_source(self.source_map(span)),
        );
        let module_id = self.module_node_id.clone();
        self.push_edge(&module_id, &comp_id, EdgeKind::Contains, None, None);
        if exported && is_default {
            self.push_edge(&module_id, &comp_id, EdgeKind::EntryFor, None, None);
            self.out.default_export_component = Some(name.to_string());
        }
        self.out.components.insert(name.to_string(), comp_id.clone());
        comp_id
    }

    fn walk_component_body(
        &mut self,
        body: &Option<&oast::FunctionBody<'_>>,
        comp_name: &str,
        comp_id: &str,
    ) {
        let Some(body) = body else { return };
        for stmt in &body.statements {
            self.walk_stmt_in_component(stmt, comp_name, comp_id);
        }
    }

    fn walk_arrow_body(
        &mut self,
        body: &oast::FunctionBody<'_>,
        comp_name: &str,
        comp_id: &str,
    ) {
        // FunctionBody covers both block and expression bodies in oxc.
        // If the body has exactly one ExpressionStatement and the source
        // arrow had `() => <Jsx/>`, oxc parses that as a Return.
        for stmt in &body.statements {
            self.walk_stmt_in_component(stmt, comp_name, comp_id);
        }
    }

    fn walk_stmt_in_component(
        &mut self,
        stmt: &oast::Statement<'_>,
        comp_name: &str,
        comp_id: &str,
    ) {
        match stmt {
            oast::Statement::ReturnStatement(ret) => {
                if let Some(arg) = &ret.argument {
                    self.walk_render_expr(arg, comp_name, comp_id);
                }
            }
            oast::Statement::ExpressionStatement(es) => {
                // Implicit return arrows materialize as ExpressionStatement
                // when wrapped in `() => (<Jsx/>)` and oxc treats the body
                // as a single statement.
                self.walk_render_expr(&es.expression, comp_name, comp_id);
            }
            oast::Statement::VariableDeclaration(var_decl) => {
                for declarator in &var_decl.declarations {
                    if let Some(init) = &declarator.init {
                        self.detect_use_state(init, declarator, comp_name, comp_id);
                    }
                }
            }
            _ => {}
        }
    }

    fn walk_render_expr(&mut self, expr: &oast::Expression<'_>, comp_name: &str, comp_id: &str) {
        match expr {
            oast::Expression::JSXElement(jsx) => {
                let root = self.walk_jsx_element(jsx, &format!("{comp_name}.return"), 0);
                self.push_edge(comp_id, &root, EdgeKind::Renders, None, None);
            }
            oast::Expression::JSXFragment(frag) => {
                let root = self.walk_jsx_fragment(frag, &format!("{comp_name}.return"), 0);
                self.push_edge(comp_id, &root, EdgeKind::Renders, None, None);
            }
            oast::Expression::ParenthesizedExpression(paren) => {
                self.walk_render_expr(&paren.expression, comp_name, comp_id);
            }
            oast::Expression::ConditionalExpression(cond) => {
                self.walk_conditional_render(cond, comp_name, comp_id);
            }
            oast::Expression::LogicalExpression(logical) => {
                if let oast::Expression::JSXElement(jsx) = &logical.right {
                    let id =
                        self.walk_jsx_element(jsx, &format!("{comp_name}.return.logical"), 0);
                    self.push_edge(
                        comp_id,
                        &id,
                        EdgeKind::Renders,
                        Some(json!({"logical": true})),
                        None,
                    );
                }
            }
            _ => {}
        }
    }

    fn walk_conditional_render(
        &mut self,
        cond: &oast::ConditionalExpression<'_>,
        comp_name: &str,
        comp_id: &str,
    ) {
        if let oast::Expression::JSXElement(jsx) = &cond.consequent {
            let id = self.walk_jsx_element(jsx, &format!("{comp_name}.return.true"), 0);
            self.push_edge(
                comp_id,
                &id,
                EdgeKind::Renders,
                Some(json!({"branch": "consequent"})),
                None,
            );
        }
        if let oast::Expression::JSXElement(jsx) = &cond.alternate {
            let id = self.walk_jsx_element(jsx, &format!("{comp_name}.return.false"), 0);
            self.push_edge(
                comp_id,
                &id,
                EdgeKind::Renders,
                Some(json!({"branch": "alternate"})),
                None,
            );
        }
    }

    fn walk_jsx_element(
        &mut self,
        jsx: &oast::JSXElement<'_>,
        symbol_path: &str,
        index: usize,
    ) -> String {
        let (tag_name, is_custom) = jsx_tag_name(&jsx.opening_element.name);
        let span = jsx.span;
        let el_id = self.make_node_id(
            "element",
            &format!("{symbol_path}.{tag_name}[{index}]"),
            Some(span.start),
        );
        self.out.nodes.push(
            Node::new(&el_id, NodeKind::Element, &tag_name)
                .with_data(json!({
                    "tagName": tag_name,
                    "isCustomComponent": is_custom,
                    "isFragment": false,
                }))
                .with_source(self.source_map(span)),
        );

        // attrs
        let mut attr_idx: i32 = 0;
        for attr in &jsx.opening_element.attributes {
            if let oast::JSXAttributeItem::Attribute(a) = attr {
                self.handle_jsx_attr(a, &el_id, &tag_name, symbol_path, index, &mut attr_idx);
            }
        }

        // wire to component (local or imported)
        if is_custom {
            let root_ident = tag_name.split('.').next().unwrap_or("").to_string();
            let resolved_target = self
                .out
                .components
                .get(&root_ident)
                .cloned()
                .or_else(|| {
                    self.out.imports.get(&root_ident).map(|i| i.node_id.clone())
                });
            if let Some(target) = resolved_target {
                let data = if self.out.components.contains_key(&root_ident) {
                    Some(json!({"kind": "local_component"}))
                } else if let Some(imp) = self.out.imports.get(&root_ident) {
                    Some(json!({"kind": "imported_component", "source": imp.source}))
                } else {
                    None
                };
                self.push_edge(&el_id, &target, EdgeKind::References, data, None);
            }
        }

        // children
        let mut child_index = 0i32;
        for child in &jsx.children {
            match child {
                oast::JSXChild::Element(c) => {
                    let cid = self.walk_jsx_element(
                        c,
                        &format!("{symbol_path}.{tag_name}[{index}]"),
                        child_index as usize,
                    );
                    self.push_edge(&el_id, &cid, EdgeKind::ChildOf, None, Some(child_index));
                    child_index += 1;
                }
                oast::JSXChild::Fragment(f) => {
                    let cid = self.walk_jsx_fragment(
                        f,
                        &format!("{symbol_path}.{tag_name}[{index}]"),
                        child_index as usize,
                    );
                    self.push_edge(&el_id, &cid, EdgeKind::ChildOf, None, Some(child_index));
                    child_index += 1;
                }
                oast::JSXChild::Text(t) => {
                    let trimmed = t.value.trim();
                    if !trimmed.is_empty() {
                        let tid = self.emit_text_node(
                            symbol_path,
                            &tag_name,
                            index,
                            child_index,
                            trimmed,
                            t.span,
                        );
                        self.push_edge(&el_id, &tid, EdgeKind::ChildOf, None, Some(child_index));
                        child_index += 1;
                    }
                }
                oast::JSXChild::ExpressionContainer(ec) => {
                    if let oast::JSXExpression::StringLiteral(s) = &ec.expression {
                        let tid = self.emit_text_node(
                            symbol_path,
                            &tag_name,
                            index,
                            child_index,
                            &s.value,
                            s.span,
                        );
                        self.push_edge(&el_id, &tid, EdgeKind::ChildOf, None, Some(child_index));
                        child_index += 1;
                    } else if let oast::JSXExpression::Identifier(id) = &ec.expression {
                        if id.name == "children" {
                            let slot_id = self.make_node_id(
                                "element",
                                &format!("{symbol_path}.{tag_name}[{index}].children_slot"),
                                Some(ec.span.start),
                            );
                            self.out.nodes.push(
                                Node::new(&slot_id, NodeKind::Element, "children_slot")
                                    .with_data(json!({
                                        "tagName": "children_slot",
                                        "isChildrenSlot": true,
                                        "isFragment": false,
                                        "isCustomComponent": false,
                                    }))
                                    .with_source(self.source_map(ec.span)),
                            );
                            self.push_edge(
                                &el_id,
                                &slot_id,
                                EdgeKind::ChildOf,
                                None,
                                Some(child_index),
                            );
                            child_index += 1;
                        }
                    }
                }
                _ => {}
            }
        }

        el_id
    }

    fn walk_jsx_fragment(
        &mut self,
        frag: &oast::JSXFragment<'_>,
        symbol_path: &str,
        index: usize,
    ) -> String {
        let span = frag.span;
        let el_id = self.make_node_id(
            "element",
            &format!("{symbol_path}.Fragment[{index}]"),
            Some(span.start),
        );
        self.out.nodes.push(
            Node::new(&el_id, NodeKind::Element, "Fragment")
                .with_data(json!({
                    "tagName": "Fragment",
                    "isCustomComponent": false,
                    "isFragment": true,
                }))
                .with_source(self.source_map(span)),
        );
        let mut child_index = 0i32;
        for child in &frag.children {
            if let oast::JSXChild::Element(c) = child {
                let cid = self.walk_jsx_element(
                    c,
                    &format!("{symbol_path}.Fragment[{index}]"),
                    child_index as usize,
                );
                self.push_edge(&el_id, &cid, EdgeKind::ChildOf, None, Some(child_index));
                child_index += 1;
            } else if let oast::JSXChild::Text(t) = child {
                let trimmed = t.value.trim();
                if !trimmed.is_empty() {
                    let tid = self.emit_text_node(
                        symbol_path,
                        "Fragment",
                        index,
                        child_index,
                        trimmed,
                        t.span,
                    );
                    self.push_edge(&el_id, &tid, EdgeKind::ChildOf, None, Some(child_index));
                    child_index += 1;
                }
            }
        }
        el_id
    }

    fn handle_jsx_attr(
        &mut self,
        attr: &oast::JSXAttribute<'_>,
        el_id: &str,
        tag_name: &str,
        symbol_path: &str,
        index: usize,
        attr_idx: &mut i32,
    ) {
        let attr_name = match &attr.name {
            oast::JSXAttributeName::Identifier(n) => n.name.to_string(),
            oast::JSXAttributeName::NamespacedName(n) => {
                format!("{}:{}", n.namespace.name, n.name.name)
            }
        };

        // className={styles.foo} pending StyleRef
        if attr_name == "className" {
            if let Some(oast::JSXAttributeValue::ExpressionContainer(ec)) = &attr.value {
                for (local, class_name) in collect_class_name_refs(&ec.expression) {
                    if let Some(imp) = self.out.imports.get(&local) {
                        if is_css_module_source(&imp.source) {
                            self.out.style_refs.push(StyleRef {
                                element_id: el_id.to_string(),
                                css_module_local: local.clone(),
                                class_name,
                            });
                        }
                    }
                }
            }
        }

        let evaluated = eval_simple_attr(attr.value.as_ref());
        let Some((kind_label, value)) = evaluated else {
            return;
        };

        let prop_id = self.make_node_id(
            "prop",
            &format!("{symbol_path}.{tag_name}[{index}].{attr_name}"),
            Some(attr.span.start),
        );
        self.out.nodes.push(
            Node::new(&prop_id, NodeKind::Prop, &attr_name)
                .with_data(json!({
                    "name": attr_name,
                    "value": value,
                    "kind": kind_label,
                }))
                .with_source(self.source_map(attr.span)),
        );
        self.push_edge(
            el_id,
            &prop_id,
            EdgeKind::BindsProp,
            Some(json!({"name": attr_name})),
            Some(*attr_idx),
        );
        *attr_idx += 1;

        // on* handlers
        if is_event_name(&attr_name) {
            let handler_name = match &attr.value {
                Some(oast::JSXAttributeValue::ExpressionContainer(ec)) => {
                    if let oast::JSXExpression::Identifier(id) = &ec.expression {
                        Some(id.name.to_string())
                    } else if let oast::JSXExpression::StringLiteral(s) = &ec.expression {
                        Some(s.value.to_string())
                    } else {
                        None
                    }
                }
                Some(oast::JSXAttributeValue::StringLiteral(s)) => Some(s.value.to_string()),
                _ => None,
            };
            let event_id = self.make_node_id(
                "event",
                &format!("{symbol_path}.{tag_name}[{index}].event:{attr_name}"),
                Some(attr.span.start),
            );
            self.out.nodes.push(
                Node::new(&event_id, NodeKind::Event, &attr_name)
                    .with_data(json!({
                        "handler": attr_name,
                        "handlerName": handler_name,
                    }))
                    .with_source(self.source_map(attr.span)),
            );
            self.push_edge(
                el_id,
                &event_id,
                EdgeKind::Triggers,
                Some(json!({"handler": attr_name})),
                None,
            );
        }

        // href literal → pending HrefRef
        if attr_name == "href" && kind_label == "literal" {
            if let Value::String(s) = &value {
                self.out.href_refs.push(super::types::HrefRef {
                    element_id: el_id.to_string(),
                    href: s.clone(),
                });
            }
        }
    }

    fn emit_text_node(
        &mut self,
        symbol_path: &str,
        tag_name: &str,
        index: usize,
        child_index: i32,
        text: &str,
        span: oxc_span::Span,
    ) -> String {
        let id = self.make_node_id(
            "text",
            &format!("{symbol_path}.{tag_name}[{index}].text[{child_index}]"),
            Some(span.start),
        );
        let display_name: String = text.chars().take(48).collect();
        self.out.nodes.push(
            Node::new(&id, NodeKind::Text, &display_name)
                .with_data(json!({"value": text}))
                .with_source(self.source_map(span)),
        );
        id
    }

    fn detect_use_state(
        &mut self,
        init: &oast::Expression<'_>,
        declarator: &oast::VariableDeclarator<'_>,
        comp_name: &str,
        comp_id: &str,
    ) {
        let oast::Expression::CallExpression(call) = init else {
            return;
        };
        let callee_name = match &call.callee {
            oast::Expression::Identifier(id) => id.name.to_string(),
            _ => return,
        };
        if callee_name != "useState" {
            return;
        }
        let oast::BindingPatternKind::ArrayPattern(arr) = &declarator.id.kind else {
            return;
        };
        let Some(first) = arr.elements.first().and_then(|e| e.as_ref()) else {
            return;
        };
        let oast::BindingPatternKind::BindingIdentifier(state_id) = &first.kind else {
            return;
        };
        let state_name = state_id.name.to_string();
        let default_value = call
            .arguments
            .first()
            .and_then(|a| match a {
                oast::Argument::StringLiteral(s) => Some(Value::String(s.value.to_string())),
                oast::Argument::NumericLiteral(n) => serde_json::Number::from_f64(n.value)
                    .map(Value::Number),
                oast::Argument::BooleanLiteral(b) => Some(Value::Bool(b.value)),
                oast::Argument::NullLiteral(_) => Some(Value::Null),
                _ => None,
            })
            .unwrap_or(Value::Null);
        let id = self.make_node_id(
            "state",
            &format!("state:{comp_name}:{state_name}"),
            Some(call.span.start),
        );
        self.out.nodes.push(
            Node::new(&id, NodeKind::State, &state_name)
                .with_data(json!({
                    "defaultValue": default_value,
                    "owner": comp_name,
                    "kind": "useState",
                }))
                .with_source(self.source_map(call.span)),
        );
        self.push_edge(comp_id, &id, EdgeKind::Declares, None, None);
    }
}

enum ArrowOrFunctionBody<'a> {
    Arrow(&'a oast::FunctionBody<'a>),
    Function(Option<&'a oast::FunctionBody<'a>>),
}

// ── Helpers ───────────────────────────────────────────────────────

fn is_component_name(name: &str) -> bool {
    name.chars().next().map(|c| c.is_ascii_uppercase()).unwrap_or(false)
}

fn is_event_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some('o'))
        && matches!(chars.next(), Some('n'))
        && chars.next().map(|c| c.is_ascii_uppercase()).unwrap_or(false)
}

fn is_css_module_source(source: &str) -> bool {
    source.ends_with(".css")
        || source.ends_with(".module.css")
        || source.ends_with(".scss")
        || source.ends_with(".sass")
}

fn jsx_tag_name(name: &oast::JSXElementName<'_>) -> (String, bool) {
    match name {
        oast::JSXElementName::Identifier(id) => {
            let n = id.name.to_string();
            let is_custom = is_component_name(&n);
            (n, is_custom)
        }
        oast::JSXElementName::IdentifierReference(id) => {
            let n = id.name.to_string();
            let is_custom = is_component_name(&n);
            (n, is_custom)
        }
        oast::JSXElementName::MemberExpression(m) => {
            let mut parts = Vec::new();
            collect_jsx_member(m, &mut parts);
            (parts.join("."), true)
        }
        oast::JSXElementName::NamespacedName(ns) => (
            format!("{}:{}", ns.namespace.name, ns.name.name),
            false,
        ),
        oast::JSXElementName::ThisExpression(_) => ("this".to_string(), false),
    }
}

fn collect_jsx_member(m: &oast::JSXMemberExpression<'_>, out: &mut Vec<String>) {
    match &m.object {
        oast::JSXMemberExpressionObject::IdentifierReference(id) => {
            out.push(id.name.to_string());
        }
        oast::JSXMemberExpressionObject::MemberExpression(inner) => {
            collect_jsx_member(inner, out);
        }
        oast::JSXMemberExpressionObject::ThisExpression(_) => out.push("this".to_string()),
    }
    out.push(m.property.name.to_string());
}

fn collect_class_name_refs(expr: &oast::JSXExpression<'_>) -> Vec<(String, String)> {
    let mut out = Vec::new();
    walk_class_name_expr(expr, &mut out);
    out
}

fn walk_class_name_expr(expr: &oast::JSXExpression<'_>, out: &mut Vec<(String, String)>) {
    // Convert JSXExpression to Expression-equivalent walking
    if let oast::JSXExpression::Identifier(_) = expr {
        return;
    }
    // Reuse generic walker by routing through Expression branch
    if let Some(expr_ref) = jsx_expression_to_expression(expr) {
        walk_expr_for_class_refs(expr_ref, out);
    }
}

fn jsx_expression_to_expression<'a>(
    expr: &'a oast::JSXExpression<'a>,
) -> Option<&'a oast::Expression<'a>> {
    // oast::JSXExpression contains an Expression union — use as_expression when
    // available, otherwise fall through and match the common subset.
    expr.as_expression()
}

fn walk_expr_for_class_refs(expr: &oast::Expression<'_>, out: &mut Vec<(String, String)>) {
    use oast::Expression as E;
    match expr {
        E::StaticMemberExpression(m) => {
            if let E::Identifier(obj) = &m.object {
                out.push((obj.name.to_string(), m.property.name.to_string()));
            }
        }
        E::ComputedMemberExpression(m) => {
            if let (E::Identifier(obj), E::StringLiteral(prop)) = (&m.object, &m.expression) {
                out.push((obj.name.to_string(), prop.value.to_string()));
            }
        }
        E::CallExpression(call) => {
            for arg in &call.arguments {
                if let Some(inner) = arg.as_expression() {
                    walk_expr_for_class_refs(inner, out);
                }
            }
        }
        E::ConditionalExpression(c) => {
            walk_expr_for_class_refs(&c.consequent, out);
            walk_expr_for_class_refs(&c.alternate, out);
        }
        E::LogicalExpression(l) => {
            walk_expr_for_class_refs(&l.left, out);
            walk_expr_for_class_refs(&l.right, out);
        }
        E::TemplateLiteral(t) => {
            for e in &t.expressions {
                walk_expr_for_class_refs(e, out);
            }
        }
        E::ArrayExpression(a) => {
            for el in &a.elements {
                if let Some(inner) = el.as_expression() {
                    walk_expr_for_class_refs(inner, out);
                }
            }
        }
        _ => {}
    }
}

fn eval_simple_attr<'a>(
    value: Option<&oast::JSXAttributeValue<'a>>,
) -> Option<(&'static str, Value)> {
    match value {
        None => Some(("literal", Value::Bool(true))),
        Some(oast::JSXAttributeValue::StringLiteral(s)) => {
            Some(("literal", Value::String(s.value.to_string())))
        }
        Some(oast::JSXAttributeValue::ExpressionContainer(ec)) => match &ec.expression {
            oast::JSXExpression::StringLiteral(s) => {
                Some(("literal", Value::String(s.value.to_string())))
            }
            oast::JSXExpression::NumericLiteral(n) => Some((
                "literal",
                serde_json::Number::from_f64(n.value)
                    .map(Value::Number)
                    .unwrap_or(Value::Null),
            )),
            oast::JSXExpression::BooleanLiteral(b) => Some(("literal", Value::Bool(b.value))),
            oast::JSXExpression::NullLiteral(_) => Some(("literal", Value::Null)),
            oast::JSXExpression::ObjectExpression(obj) => Some((
                "literal",
                eval_object_expression(obj).unwrap_or(Value::String("<expr>".into())),
            )),
            _ => Some(("expr", Value::String("<expr>".into()))),
        },
        _ => None,
    }
}

fn eval_object_expression(obj: &oast::ObjectExpression<'_>) -> Option<Value> {
    let mut map = serde_json::Map::new();
    for prop in &obj.properties {
        let oast::ObjectPropertyKind::ObjectProperty(p) = prop else {
            return None;
        };
        if p.computed {
            return None;
        }
        let key = match &p.key {
            oast::PropertyKey::StaticIdentifier(id) => id.name.to_string(),
            oast::PropertyKey::PrivateIdentifier(_) => return None,
            oast::PropertyKey::StringLiteral(s) => s.value.to_string(),
            _ => return None,
        };
        let value = match &p.value {
            oast::Expression::StringLiteral(s) => Value::String(s.value.to_string()),
            oast::Expression::NumericLiteral(n) => serde_json::Number::from_f64(n.value)
                .map(Value::Number)
                .unwrap_or(Value::Null),
            oast::Expression::BooleanLiteral(b) => Value::Bool(b.value),
            _ => return None,
        };
        map.insert(key, value);
    }
    Some(Value::Object(map))
}

fn line_col(source: &str, offset: u32) -> (u32, u32) {
    let mut line = 1u32;
    let mut col = 0u32;
    let mut count = 0u32;
    for ch in source.chars() {
        if count == offset {
            break;
        }
        count += ch.len_utf8() as u32;
        if ch == '\n' {
            line += 1;
            col = 0;
        } else {
            col += 1;
        }
    }
    (line, col)
}
