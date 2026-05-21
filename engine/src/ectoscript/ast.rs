//! Typed AST. The compiler consumes this; it carries enough source
//! position info to surface line/col errors to the editor.

use super::lexer::Literal;

#[derive(Debug, Clone, Copy)]
pub struct Pos {
    pub line: usize,
    pub col: usize,
}

#[derive(Debug, Clone)]
pub struct EctoFile {
    pub decls: Vec<TopDecl>,
}

#[derive(Debug, Clone)]
pub enum TopDecl {
    Model(ModelDecl),
    Component(ComponentDecl),
    Token(TokenDecl),
    Derived(DerivedDecl),
    Styles(StylesDecl),
    Query(QueryDecl),
}

impl TopDecl {
    pub fn name(&self) -> &str {
        match self {
            TopDecl::Model(m) => &m.name,
            TopDecl::Component(c) => &c.name,
            TopDecl::Token(t) => &t.name,
            TopDecl::Derived(d) => &d.name,
            TopDecl::Styles(s) => &s.name,
            TopDecl::Query(q) => &q.name,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ModelDecl {
    pub pos: Pos,
    pub name: String,
    pub states: Vec<StateDecl>,
}

#[derive(Debug, Clone)]
pub struct StateDecl {
    pub pos: Pos,
    pub name: String,
    pub initial: Literal,
    pub traits: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct UsesDecl {
    pub pos: Pos,
    pub model: String,
    pub traits: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct ComponentDecl {
    pub pos: Pos,
    pub name: String,
    pub uses: Vec<UsesDecl>,
    pub states: Vec<StateDecl>,
    pub render: Option<ElementNode>,
}

#[derive(Debug, Clone)]
pub struct TokenDecl {
    pub pos: Pos,
    pub name: String,
    pub value: Literal,
}

#[derive(Debug, Clone)]
pub struct DerivedDecl {
    pub pos: Pos,
    pub name: String,
    pub expr: DerivedExpr,
}

#[derive(Debug, Clone)]
pub enum DerivedExpr {
    /// `if PATH then else` — reads PATH (boolean), picks one of two
    /// token refs.
    IfElse {
        cond: Vec<String>,
        then_ref: String,
        else_ref: String,
    },
    /// Bare identifier — resolves to a token/derived by name.
    Ref(String),
    /// Catch-all: keep the raw source for diagnostics; runtime treats
    /// as a string literal.
    Raw(String),
}

#[derive(Debug, Clone)]
pub struct StylesDecl {
    pub pos: Pos,
    pub name: String,
    pub props: Vec<StyleProp>,
}

#[derive(Debug, Clone)]
pub struct StyleProp {
    pub pos: Pos,
    pub name: String,
    pub values: Vec<Literal>,
}

#[derive(Debug, Clone)]
pub struct QueryDecl {
    pub pos: Pos,
    pub name: String,
    pub source: Vec<String>,
    pub filters: Vec<QueryFilter>,
}

#[derive(Debug, Clone)]
pub struct QueryFilter {
    pub field: String,
    pub value: ValueExpr,
}

/// A value expression used by `set X = Y` RHS, `add to … { field: Y }`,
/// and query filter RHS. Strictly more expressive than `Literal`.
#[derive(Debug, Clone)]
pub enum ValueExpr {
    Literal(Literal),
    Path(Vec<String>),
    Match {
        input: Vec<String>,
        collection: Vec<String>,
        field: String,
    },
}

#[derive(Debug, Clone)]
pub struct ElementNode {
    pub pos: Pos,
    pub name: String,
    pub when: Option<WhenRule>,
    pub styles: Vec<String>,
    pub traits: Vec<String>,
    pub events: Vec<EventHandler>,
    pub bindings: Vec<BindingDecl>,
    pub attrs: Vec<(String, Literal)>,
    pub children: Vec<ElementNode>,
    pub loop_var: Option<String>,
    pub loop_source: Option<Vec<String>>,
}

#[derive(Debug, Clone)]
pub enum WhenRule {
    Truthy { path: Vec<String> },
    Equals { path: Vec<String>, literal: Literal },
}

#[derive(Debug, Clone)]
pub struct EventHandler {
    pub pos: Pos,
    pub event: String,
    pub actions: Vec<ActionNode>,
}

#[derive(Debug, Clone)]
pub enum ActionNode {
    Toggle {
        target: Vec<String>,
    },
    Set {
        target: Vec<String>,
        value: ValueExpr,
    },
    Clear {
        target: Vec<String>,
    },
    Add {
        target: Vec<String>,
        fields: Vec<AddField>,
    },
}

#[derive(Debug, Clone)]
pub struct AddField {
    pub name: String,
    pub value: ValueExpr,
}

#[derive(Debug, Clone)]
pub struct BindingDecl {
    pub pos: Pos,
    pub prop: String,
    pub target: Vec<String>,
}
