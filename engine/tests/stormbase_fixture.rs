//! Reproducing the "RefCell already borrowed" panic the user hit when
//! clicking "Load Stormbase sample". The Stormbase fixture's JSX or
//! Sass triggers something inside import_project that fails. By running
//! the importer natively (no wasm-bindgen), we isolate fixture issues
//! from WASM bridge issues.

use ecto_engine::importer::{import_project, FileBlob};

const VARIABLES_SCSS: &str = include_str!("./storm_variables.scss");
const MIXINS_SCSS: &str = include_str!("./storm_mixins.scss");

fn with_helpers(body: &str) -> String {
    format!("{VARIABLES_SCSS}\n{MIXINS_SCSS}\n{body}\n")
}

const APP_TSX: &str = r#"import { Nav } from "./components/layout/Nav"
import { CaptureBox } from "./components/capture/CaptureBox"
import { IdeaCard } from "./components/ideas/IdeaCard"
import { MapCard } from "./components/maps/MapCard"
import styles from "./App.module.scss"

export default function App() {
  return (
    <div className={styles.shell}>
      <Nav />
      <div className={styles.page}>
        <section className={styles.hero}>
          <CaptureBox />
        </section>
        <section className={styles.section}>
          <div className={styles.grid}>
            <IdeaCard title="t" summary="s" time="t" kind="idea" />
          </div>
        </section>
        <section className={styles.section}>
          <div className={styles.grid}>
            <MapCard name="m" prompt="p" ideaCount={1} newCount={0} />
          </div>
        </section>
      </div>
    </div>
  )
}
"#;

const NAV_TSX: &str = r#"import styles from "./Nav.module.scss"
export function Nav() {
  return (
    <nav className={styles.nav}>
      <a href="/" className={styles.brand}>
        <span className={styles.dot} />
        <span className={styles.name}>Storm</span>
      </a>
    </nav>
  )
}
"#;

const CAPTURE_TSX: &str = r#"import styles from "./CaptureBox.module.scss"
export function CaptureBox() {
  return (
    <div className={styles.box}>
      <textarea className={styles.textarea} placeholder="What's stirring?" rows={3} />
    </div>
  )
}
"#;

const IDEA_CARD_TSX: &str = r#"import styles from "./IdeaCard.module.scss"
interface Props {
  title: string
  summary: string
  time: string
  kind: string
  concepts?: string[]
  source?: string
}
export function IdeaCard(props: Props) {
  return (
    <a href="/ideas" className={styles.card} data-kind={props.kind}>
      <div className={styles.head}>
        <span className={styles.type}>{props.kind}</span>
        {props.source === "voice" ? <span className={styles.voice}>voice</span> : null}
        <span className={styles.time}>{props.time}</span>
      </div>
      <h3 className={styles.title}>{props.title}</h3>
      <p className={styles.summary}>{props.summary}</p>
      {props.concepts && props.concepts.length > 0 ? (
        <div className={styles.tags}>
          {props.concepts.map((c) => (
            <span key={c} className={styles.tag}>{c}</span>
          ))}
        </div>
      ) : null}
    </a>
  )
}
"#;

const MAP_CARD_TSX: &str = r#"import styles from "./MapCard.module.scss"
interface Props {
  name: string
  prompt: string
  ideaCount: number
  newCount: number
}
export function MapCard(props: Props) {
  return (
    <a href="/maps" className={styles.card}>
      <span className={styles.name}>{props.name}</span>
    </a>
  )
}
"#;

const NAV_SCSS_BODY: &str = r#".nav { display: flex; }
.brand { color: $ink; }
.dot { background: $accent-storm; }
.name { font-family: $font-display; }
"#;
const CAPTURE_SCSS_BODY: &str = r#".box { @include card; }
.textarea { font-family: inherit; }
"#;
const IDEA_SCSS_BODY: &str = r#".card { @include card; }
.head { display: flex; }
.type { @include pill; }
.voice { @include pill; }
.time { color: $ink-faint; }
.title { font-size: 17px; }
.summary { color: $ink-dim; }
.tags { display: flex; }
.tag { @include pill; }
"#;
const MAP_SCSS_BODY: &str = r#".card { @include card; }
.name { font-family: $font-display; }
"#;
const APP_SCSS_BODY: &str = r#".shell { background: $bg; }
.page { max-width: 1120px; margin: 0 auto; }
.hero { display: flex; }
.section { display: flex; }
.grid { display: grid; }
"#;

#[test]
fn stormbase_fixture_does_not_panic() {
    let files = vec![
        FileBlob {
            path: "src/components/layout/Nav.tsx".into(),
            content: NAV_TSX.into(),
        },
        FileBlob {
            path: "src/components/layout/Nav.module.scss".into(),
            content: with_helpers(NAV_SCSS_BODY),
        },
        FileBlob {
            path: "src/components/capture/CaptureBox.tsx".into(),
            content: CAPTURE_TSX.into(),
        },
        FileBlob {
            path: "src/components/capture/CaptureBox.module.scss".into(),
            content: with_helpers(CAPTURE_SCSS_BODY),
        },
        FileBlob {
            path: "src/components/ideas/IdeaCard.tsx".into(),
            content: IDEA_CARD_TSX.into(),
        },
        FileBlob {
            path: "src/components/ideas/IdeaCard.module.scss".into(),
            content: with_helpers(IDEA_SCSS_BODY),
        },
        FileBlob {
            path: "src/components/maps/MapCard.tsx".into(),
            content: MAP_CARD_TSX.into(),
        },
        FileBlob {
            path: "src/components/maps/MapCard.module.scss".into(),
            content: with_helpers(MAP_SCSS_BODY),
        },
        FileBlob {
            path: "src/App.module.scss".into(),
            content: with_helpers(APP_SCSS_BODY),
        },
        FileBlob {
            path: "src/App.tsx".into(),
            content: APP_TSX.into(),
        },
    ];

    let result = import_project("stormbase", &files);
    assert!(result.entry_node_id.is_some(), "expected an entry node");
    let entry = result.entry_node_id.as_ref().unwrap();
    let entry_node = result
        .graph
        .nodes
        .iter()
        .find(|n| &n.id == entry)
        .expect("entry node found");
    assert_eq!(entry_node.name, "App", "expected App as entry component");
}
