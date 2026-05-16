//! Integration test: import the ecto-engine tiny-react-app fixture and
//! verify the resulting graph contains the expected components,
//! elements, props, text nodes, and class→style references.

use ecto_engine::importer::{import_project, FileBlob};
use ecto_engine::graph::kinds::NodeKind;

fn fixture(path: &str, content: &str) -> FileBlob {
    FileBlob {
        path: path.into(),
        content: content.into(),
    }
}

const APP_TSX: &str = r#"import React from 'react'
import { Header } from './Header'
import { Button } from './Button'
import { Card } from './Card'

export default function App() {
  return (
    <div className="app">
      <Header title="Ecto" subtitle="Codebase-as-graph" />
      <Card>
        <h3>Welcome</h3>
        <p>Imported app.</p>
        <Button label="Get Started" />
      </Card>
    </div>
  )
}
"#;

const BUTTON_TSX: &str = r#"import React from 'react'
import styles from './Button.module.css'

export function Button({ label, ghost }: { label: string; ghost?: boolean }) {
  return (
    <button className={ghost ? styles.ghost : styles.button} onClick="runtime.log">
      {label}
    </button>
  )
}
"#;

const HEADER_TSX: &str = r#"import React from 'react'

export function Header({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <header>
      <h1>{title}</h1>
      <p>{subtitle}</p>
    </header>
  )
}
"#;

const CARD_TSX: &str = r#"import React from 'react'

export function Card({ children }: { children: React.ReactNode }) {
  return <div>{children}</div>
}
"#;

const BUTTON_CSS: &str = r#".button {
  padding: 10px 18px;
  border-radius: 8px;
  background: #111;
  color: #ffffff;
}
.ghost {
  background: transparent;
  color: #111;
}
"#;

#[test]
fn imports_tiny_react_app_to_expected_graph() {
    let files = vec![
        fixture("src/App.tsx", APP_TSX),
        fixture("src/Button.tsx", BUTTON_TSX),
        fixture("src/Button.module.css", BUTTON_CSS),
        fixture("src/Header.tsx", HEADER_TSX),
        fixture("src/Card.tsx", CARD_TSX),
    ];

    let result = import_project("tiny-react-app", &files);

    let nodes = &result.graph.nodes;
    let edges = &result.graph.edges;

    let by_kind = |k: NodeKind| nodes.iter().filter(|n| n.kind == k).count();

    // file + module per script + per stylesheet = 5 scripts * 2 + 1 sheet = 11 file/module nodes total
    assert!(by_kind(NodeKind::File) >= 5, "have file nodes: {}", by_kind(NodeKind::File));
    assert!(by_kind(NodeKind::Module) >= 4, "have module nodes per script");

    // Components: App, Button, Header, Card
    let components: Vec<&str> = nodes
        .iter()
        .filter(|n| n.kind == NodeKind::Component)
        .map(|n| n.name.as_str())
        .collect();
    for needed in ["App", "Button", "Header", "Card"] {
        assert!(
            components.contains(&needed),
            "missing component {needed}, have {components:?}"
        );
    }

    // Text node "Welcome" exists
    let texts: Vec<&str> = nodes
        .iter()
        .filter(|n| n.kind == NodeKind::Text)
        .map(|n| n.name.as_str())
        .collect();
    assert!(
        texts.iter().any(|t| t.contains("Welcome")),
        "missing 'Welcome' text node; have {texts:?}"
    );

    // Get Started prop (the label="Get Started" attribute creates a prop node)
    let props: Vec<&str> = nodes
        .iter()
        .filter(|n| n.kind == NodeKind::Prop)
        .filter_map(|n| n.data.get("value").and_then(|v| v.as_str()))
        .collect();
    assert!(
        props.contains(&"Get Started"),
        "missing 'Get Started' prop value; have {props:?}"
    );

    // Event node for onClick
    let events: Vec<&str> = nodes
        .iter()
        .filter(|n| n.kind == NodeKind::Event)
        .map(|n| n.name.as_str())
        .collect();
    assert!(events.contains(&"onClick"), "missing onClick event; have {events:?}");

    // style nodes from Button.module.css
    let styles: Vec<&str> = nodes
        .iter()
        .filter(|n| n.kind == NodeKind::Style)
        .map(|n| n.name.as_str())
        .collect();
    assert!(styles.contains(&"button"), "missing button style; have {styles:?}");
    assert!(styles.contains(&"ghost"), "missing ghost style; have {styles:?}");

    // Cross-file resolution: Button button element has a 'styles' edge to a style node
    let styles_edges: Vec<_> = edges
        .iter()
        .filter(|e| e.kind == ecto_engine::graph::edge::EdgeKind::Styles)
        .collect();
    assert!(!styles_edges.is_empty(), "no styles edges produced by resolver");

    // Entry component is the default-exported App
    assert!(
        result.entry_node_id.is_some(),
        "expected entry_node_id to resolve to default-exported App"
    );
    let entry_id = result.entry_node_id.as_ref().unwrap();
    let entry_node = nodes.iter().find(|n| &n.id == entry_id).unwrap();
    assert_eq!(entry_node.kind, NodeKind::Component);
    assert_eq!(entry_node.name, "App");
}
