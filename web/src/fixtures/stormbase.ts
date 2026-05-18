// Stormbase fixture — a port of github.com/Stormbase that exercises the
// engine's styling pipeline + npm sidecar end-to-end.
//
// Caveat: ecto-rust's importer compiles each Sass file standalone with no
// load paths, so `@use "variables"` doesn't resolve across files. We
// inline the token + mixin definitions at the top of every module so the
// `.module.scss` files compile cleanly. Once the engine's parse_css.rs
// gains a virtual-fs / load-paths option, swap this back to `@use`.

import type { FileBlob } from '../engine'

const VARIABLES_SCSS = `// Storm — visual tokens.
$bg: #f7f5f0;
$bg-elev: #ffffff;
$bg-soft: #f0ece4;
$ink: #1a1a1f;
$ink-dim: #5b5b66;
$ink-faint: #8d8d99;
$border: rgba(20, 20, 30, 0.08);
$border-strong: rgba(20, 20, 30, 0.14);

$accent-storm: #ff6b35;
$accent-idea: #ffb648;
$accent-concept: #7c5cff;
$accent-map: #3ecf8e;
$accent-question: #4cc3ff;
$accent-opp: #ffd23f;
$accent-theme: #ff5c8a;
$accent-new: #ff3d68;

$radius-sm: 8px;
$radius: 14px;
$radius-lg: 22px;
$radius-pill: 999px;

$shadow-sm: 0 1px 2px rgba(20, 20, 30, 0.04), 0 1px 1px rgba(20, 20, 30, 0.03);
$shadow: 0 4px 18px rgba(20, 20, 30, 0.06), 0 1px 2px rgba(20, 20, 30, 0.04);
$shadow-lg: 0 18px 50px rgba(20, 20, 30, 0.12), 0 2px 6px rgba(20, 20, 30, 0.04);

$font-sans: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
$font-display: "Fraunces", "Iowan Old Style", Georgia, serif;
$font-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, monospace;

$space-1: 4px;
$space-2: 8px;
$space-3: 12px;
$space-4: 16px;
$space-5: 24px;
$space-6: 32px;
$space-7: 48px;
$space-8: 64px;
`

const MIXINS_SCSS = `@mixin card {
  background: $bg-elev;
  border: 1px solid $border;
  border-radius: $radius;
  box-shadow: $shadow-sm;
}

@mixin card-hover {
  transition: transform 160ms ease, box-shadow 160ms ease, border-color 160ms ease;
  &:hover {
    transform: translateY(-1px);
    box-shadow: $shadow;
    border-color: $border-strong;
  }
}

@mixin pill {
  display: inline-flex;
  align-items: center;
  gap: $space-1;
  padding: 2px 10px;
  font-size: 12px;
  font-weight: 500;
  border-radius: $radius-pill;
  background: $bg-soft;
  color: $ink-dim;
  letter-spacing: 0.01em;
}

@mixin button-primary {
  display: inline-flex;
  align-items: center;
  gap: $space-2;
  padding: 10px 18px;
  border-radius: $radius-pill;
  background: $ink;
  color: $bg-elev;
  font-weight: 500;
  border: none;
  cursor: pointer;
}

@mixin button-ghost {
  display: inline-flex;
  align-items: center;
  gap: $space-2;
  padding: 8px 14px;
  border-radius: $radius-pill;
  background: transparent;
  color: $ink-dim;
  font-weight: 500;
  border: 1px solid $border;
  cursor: pointer;
}
`

const HELPERS = VARIABLES_SCSS + '\n' + MIXINS_SCSS + '\n'

const NAV_TSX = `import styles from "./Nav.module.scss"

export function Nav() {
  return (
    <nav className={styles.nav}>
      <a href="/" className={styles.brand}>
        <span className={styles.dot} />
        <span className={styles.name}>Storm</span>
      </a>
      <div className={styles.links}>
        <a href="/" className={styles.link}>Home</a>
        <a href="/ideas" className={styles.link}>Ideas</a>
        <a href="/maps" className={styles.link}>Maps</a>
        <a href="/graph" className={styles.link}>Graph</a>
      </div>
    </nav>
  )
}
`

const NAV_SCSS = `
.nav {
  position: sticky;
  top: 0;
  z-index: 10;
  background: rgba(247, 245, 240, 0.85);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid $border;
  display: flex;
  align-items: center;
  padding: $space-3 $space-6;
  gap: $space-6;
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: $space-2;
  font-family: $font-display;
  font-weight: 600;
  font-size: 18px;
  color: $ink;
}

.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: $accent-storm;
  box-shadow: 0 0 12px rgba($accent-storm, 0.4);
}

.name {
  letter-spacing: -0.01em;
}

.links {
  display: flex;
  gap: $space-4;
  margin-left: auto;
}

.link {
  font-size: 14px;
  color: $ink-dim;
  padding: 6px 10px;
  border-radius: $radius-pill;
}
.link:hover { color: $ink; background: $bg-soft; }
`

const CAPTURE_TSX = `import styles from "./CaptureBox.module.scss"

export function CaptureBox() {
  return (
    <div className={styles.box}>
      <textarea
        className={styles.textarea}
        placeholder="What's stirring?"
        rows={3}
      />
      <div className={styles.foot}>
        <span className={styles.hint}>cmd + enter to capture</span>
        <button className={styles.submit}>Capture</button>
      </div>
    </div>
  )
}
`

const CAPTURE_SCSS = `
.box {
  @include card;
  padding: $space-3;
  border: 1px solid $border-strong;
  box-shadow: $shadow;
  transition: border-color 160ms ease, box-shadow 160ms ease;
}
.box:focus-within {
  border-color: $accent-storm;
  box-shadow: 0 0 0 4px rgba($accent-storm, 0.08), $shadow;
}

.textarea {
  width: 100%;
  border: none;
  outline: none;
  resize: vertical;
  background: transparent;
  font-family: inherit;
  font-size: 15px;
  color: $ink;
  padding: $space-2;
  min-height: 64px;
}
.textarea::placeholder { color: $ink-faint; }

.foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: $space-2;
  padding-top: $space-2;
  border-top: 1px dashed $border;
}

.hint {
  font-size: 12px;
  color: $ink-faint;
  font-family: $font-mono;
}

.submit {
  @include button-primary;
  background: $accent-storm;
}
`

const IDEA_CARD_TSX = `import styles from "./IdeaCard.module.scss"

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
        {props.source === "voice" ? <span className={styles.voice}>● voice</span> : null}
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
      <div className={styles.dnaStrip} />
    </a>
  )
}
`

const IDEA_CARD_SCSS = `
.card {
  @include card;
  @include card-hover;
  display: block;
  padding: $space-4 $space-4 $space-3;
  cursor: pointer;
  position: relative;
  overflow: hidden;
}
.card::before {
  content: "";
  position: absolute;
  inset: 0 auto 0 0;
  width: 3px;
  background: linear-gradient(180deg, $accent-idea, transparent);
  opacity: 0.7;
}
.card[data-kind="question"]::before { background: linear-gradient(180deg, $accent-question, transparent); }
.card[data-kind="observation"]::before { background: linear-gradient(180deg, $accent-concept, transparent); }
.card[data-kind="action"]::before { background: linear-gradient(180deg, $accent-storm, transparent); }
.card[data-kind="reflection"]::before { background: linear-gradient(180deg, $accent-theme, transparent); }
.card[data-kind="opportunity"]::before { background: linear-gradient(180deg, $accent-opp, transparent); }

.head {
  display: flex;
  align-items: center;
  gap: $space-2;
  margin-bottom: $space-2;
}

.type {
  @include pill;
  background: rgba($accent-idea, 0.16);
  color: darken($accent-idea, 35%);
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  font-size: 10.5px;
}

.voice {
  @include pill;
  background: rgba($accent-storm, 0.12);
  color: darken($accent-storm, 8%);
  font-size: 11px;
}

.time {
  margin-left: auto;
  font-size: 12px;
  color: $ink-faint;
}

.title {
  font-size: 17px;
  font-weight: 500;
  margin-bottom: $space-2;
  line-height: 1.3;
}

.summary {
  font-size: 13.5px;
  line-height: 1.55;
  color: $ink-dim;
}

.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: $space-3;
}

.tag {
  @include pill;
  background: rgba($accent-concept, 0.08);
  color: darken($accent-concept, 14%);
  font-size: 11.5px;
}

.dnaStrip {
  margin-top: $space-3;
  height: 12px;
  border-radius: 3px;
  background: linear-gradient(90deg,
    $accent-storm 0%,
    $accent-idea 14%,
    $accent-opp 28%,
    $accent-map 42%,
    $accent-question 57%,
    $accent-concept 71%,
    $accent-theme 85%,
    $accent-new 100%);
  background-size: 200% 100%;
  background-position: 30% 0;
  opacity: 0.7;
}
`

const MAP_CARD_TSX = `import styles from "./MapCard.module.scss"

interface Props {
  name: string
  prompt: string
  ideaCount: number
  newCount: number
}

export function MapCard(props: Props) {
  return (
    <a href="/maps" className={styles.card}>
      <div className={styles.head}>
        <span className={styles.name}>{props.name}</span>
        {props.newCount > 0 ? (
          <span className={styles.newBadge}>{props.newCount} new</span>
        ) : null}
      </div>
      <p className={styles.prompt}>{props.prompt}</p>
      <div className={styles.foot}>
        <span className={styles.count}>{props.ideaCount} ideas</span>
        <span className={styles.dot} />
      </div>
    </a>
  )
}
`

const MAP_CARD_SCSS = `
.card {
  @include card;
  @include card-hover;
  display: block;
  padding: $space-4;
  cursor: pointer;
  position: relative;
  overflow: hidden;
}
.card::after {
  content: "";
  position: absolute;
  inset: 0 0 auto 0;
  height: 3px;
  background: $accent-map;
  opacity: 0.7;
}

.head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: $space-2;
}

.name {
  font-family: $font-display;
  font-size: 18px;
  font-weight: 500;
}

.newBadge {
  @include pill;
  background: $accent-new;
  color: white;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.prompt {
  font-size: 13.5px;
  color: $ink-dim;
  margin: 0 0 $space-3;
  line-height: 1.4;
}

.foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 12px;
  color: $ink-faint;
}

.count {}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: $accent-map;
  box-shadow: 0 0 8px rgba($accent-map, 0.4);
}
`

const APP_TSX = `import { Nav } from "./components/layout/Nav"
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
          <div className={styles.heroHead}>
            <p className={styles.eyebrow}>Your mind this week</p>
            <h1 className={styles.title}>
              <span>What's stirring?</span>
              <span className={styles.stormDot} />
            </h1>
          </div>
          <CaptureBox />
        </section>

        <section className={styles.stats}>
          <div className={styles.statIdea}>
            <span className={styles.statValue}>23</span>
            <span className={styles.statLabel}>Ideas</span>
          </div>
          <div className={styles.statConcept}>
            <span className={styles.statValue}>41</span>
            <span className={styles.statLabel}>Concepts</span>
          </div>
          <div className={styles.statMap}>
            <span className={styles.statValue}>6</span>
            <span className={styles.statLabel}>Maps</span>
          </div>
          <div className={styles.statStorm}>
            <span className={styles.statValue}>8</span>
            <span className={styles.statLabel}>This week</span>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2>Recent ideas</h2>
            <a href="/ideas" className={styles.more}>All ideas →</a>
          </div>
          <div className={styles.grid}>
            <IdeaCard
              title="The shape of attention is the shape of the day"
              summary="What you keep returning to defines what you become. Capture that drift, don't fight it."
              time="2h ago"
              kind="reflection"
              concepts={["attention", "drift", "habit"]}
            />
            <IdeaCard
              title="Storm should feel like a tide pool"
              summary="Small captures accrete. The interesting part is what crystallizes between them."
              time="5h ago"
              kind="idea"
              concepts={["product", "interaction"]}
              source="voice"
            />
            <IdeaCard
              title="Why do meetings feel longer in winter?"
              summary="Probably just the dark — but worth checking calendar density vs. perceived load."
              time="yesterday"
              kind="question"
              concepts={["time perception", "seasonality"]}
            />
            <IdeaCard
              title="Run the migration before legal review, not after"
              summary="Switch the order. Saves a week."
              time="2d ago"
              kind="action"
              concepts={["workflow"]}
            />
            <IdeaCard
              title="Embeddings as a souvenir"
              summary="Once you commit a thought to vector space you can always find your way back to it."
              time="3d ago"
              kind="observation"
              concepts={["embeddings", "memory"]}
            />
            <IdeaCard
              title="Maybe the right primitive is the cluster, not the note"
              summary="A note alone is a vapor. A constellation of notes is a position."
              time="4d ago"
              kind="opportunity"
              concepts={["product"]}
            />
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2>Active maps</h2>
            <a href="/maps" className={styles.more}>New map +</a>
          </div>
          <div className={styles.grid}>
            <MapCard
              name="Storm itself"
              prompt="Anything about how Storm should look, feel, and behave"
              ideaCount={9}
              newCount={2}
            />
            <MapCard
              name="Winter season"
              prompt="Energy, focus, and mood through the dark months"
              ideaCount={6}
              newCount={0}
            />
            <MapCard
              name="Reading lately"
              prompt="Books and essays I want to track threads from"
              ideaCount={11}
              newCount={1}
            />
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <h2>Emerging concepts</h2>
            <span className={styles.subtle}>Showing up most this week</span>
          </div>
          <div className={styles.concepts}>
            <a href="/graph" className={styles.conceptPill}>
              <span>attention</span>
              <span className={styles.conceptCount}>7</span>
            </a>
            <a href="/graph" className={styles.conceptPill}>
              <span>memory</span>
              <span className={styles.conceptCount}>5</span>
            </a>
            <a href="/graph" className={styles.conceptPill}>
              <span>habit</span>
              <span className={styles.conceptCount}>4</span>
            </a>
            <a href="/graph" className={styles.conceptPill}>
              <span>embeddings</span>
              <span className={styles.conceptCount}>4</span>
            </a>
            <a href="/graph" className={styles.conceptPill}>
              <span>seasonality</span>
              <span className={styles.conceptCount}>3</span>
            </a>
            <a href="/graph" className={styles.conceptPill}>
              <span>product</span>
              <span className={styles.conceptCount}>3</span>
            </a>
          </div>
        </section>
      </div>
    </div>
  )
}
`

const APP_SCSS = `
.shell {
  background: $bg;
  color: $ink;
  font-family: $font-sans;
  min-height: 100%;
}

.page {
  max-width: 1120px;
  margin: 0 auto;
  padding: $space-7 $space-6 $space-8;
  display: flex;
  flex-direction: column;
  gap: $space-7;
}

.hero {
  display: flex;
  flex-direction: column;
  gap: $space-4;
}

.heroHead {
  display: flex;
  flex-direction: column;
  gap: $space-2;
}

.eyebrow {
  font-size: 12.5px;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: $ink-faint;
  margin: 0;
}

.title {
  display: inline-flex;
  align-items: center;
  gap: $space-3;
  font-family: $font-display;
  font-size: 44px;
  font-weight: 500;
  line-height: 1.05;
  margin: 0;
}

.stormDot {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: $accent-storm;
  box-shadow: 0 0 0 8px rgba($accent-storm, 0.12);
}

.stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: $space-3;
}

.statIdea, .statConcept, .statMap, .statStorm {
  @include card;
  padding: $space-4;
  display: flex;
  flex-direction: column;
  gap: 2px;
  position: relative;
  overflow: hidden;
}
.statIdea::before, .statConcept::before, .statMap::before, .statStorm::before {
  content: "";
  position: absolute;
  inset: auto 0 0 0;
  height: 3px;
}
.statIdea::before { background: $accent-idea; }
.statConcept::before { background: $accent-concept; }
.statMap::before { background: $accent-map; }
.statStorm::before { background: $accent-storm; }

.statValue {
  font-family: $font-display;
  font-size: 30px;
  font-weight: 500;
  color: $ink;
}

.statLabel {
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: $ink-dim;
}

.section {
  display: flex;
  flex-direction: column;
  gap: $space-4;
}

.sectionHead {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}

.sectionHead h2 {
  font-family: $font-display;
  font-size: 22px;
  font-weight: 500;
  margin: 0;
}

.subtle {
  font-size: 12.5px;
  color: $ink-faint;
}

.more {
  font-size: 13px;
  color: $ink-dim;
  border-bottom: 1px solid transparent;
}
.more:hover {
  color: $ink;
  border-bottom-color: $ink;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: $space-3;
}

.concepts {
  display: flex;
  flex-wrap: wrap;
  gap: $space-2;
}

.conceptPill {
  display: inline-flex;
  align-items: center;
  gap: $space-2;
  padding: 6px 12px 6px 14px;
  border-radius: $radius-pill;
  background: $bg-elev;
  border: 1px solid $border;
  font-size: 13px;
  color: $ink;
}
.conceptPill:hover {
  border-color: rgba($accent-concept, 0.4);
  background: rgba($accent-concept, 0.04);
}

.conceptCount {
  font-size: 11.5px;
  background: rgba($accent-concept, 0.14);
  color: darken($accent-concept, 16%);
  padding: 1px 8px;
  border-radius: $radius-pill;
}
`

// Build the FileBlob list. Every .module.scss gets the helper prelude
// concatenated so its $vars and @mixins resolve in standalone compile.
function withHelpers(body: string): string {
  return HELPERS + body
}

export const STORMBASE_FILES: FileBlob[] = [
  { path: 'src/components/layout/Nav.tsx', content: NAV_TSX },
  { path: 'src/components/layout/Nav.module.scss', content: withHelpers(NAV_SCSS) },
  { path: 'src/components/capture/CaptureBox.tsx', content: CAPTURE_TSX },
  { path: 'src/components/capture/CaptureBox.module.scss', content: withHelpers(CAPTURE_SCSS) },
  { path: 'src/components/ideas/IdeaCard.tsx', content: IDEA_CARD_TSX },
  { path: 'src/components/ideas/IdeaCard.module.scss', content: withHelpers(IDEA_CARD_SCSS) },
  { path: 'src/components/maps/MapCard.tsx', content: MAP_CARD_TSX },
  { path: 'src/components/maps/MapCard.module.scss', content: withHelpers(MAP_CARD_SCSS) },
  { path: 'src/App.module.scss', content: withHelpers(APP_SCSS) },
  { path: 'src/App.tsx', content: APP_TSX },
]
