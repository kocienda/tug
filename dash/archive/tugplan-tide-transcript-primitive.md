<!-- tugplan-skeleton v2 -->

## Tide Card Polish — `TugTranscriptEntry` Primitive {#tide-transcript-primitive}

**Purpose:** Ship `TugTranscriptEntry` — a slot-based, token-driven layout primitive that renders one row of Tide's transcript per participant (`user`, `code`, `shell`, `command`). Slack-like layout (icon column + header + body + optional controls), not chat bubbles. Lands as a designed primitive plus a gallery showcase, with no live data wiring; parent §step-11 consumes it.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | tugplan-tide-transcript-primitive |
| Last updated | 2026-05-02 |
| Roadmap anchor | [tugplan-tide-card-polish.md §step-9](./tugplan-tide-card-polish.md#step-9) — this plan executes that step |
| Predecessors | [tugplan-tide-overlay-framework.md](./archive/tugplan-tide-overlay-framework.md) (closed §step-8 series) |
| Successors | parent §step-11 (Multi-turn transcript rendering) consumes this primitive; parent §step-10 (session ledger) is independent and unblocked |

---

### Phase Overview {#phase-overview}

#### Context {#context}

A Tide card is a long-running multi-participant transcript: the user, Claude Code, post-T4 shell output, and post-T10 `:` command output all share one scroll surface. Today the top pane is a single `TugMarkdownView` bound to `streamingDocument.inflight.assistant` ([tide.md §code-session-store](./tide.md#code-session-store)) — completed turns disappear, the user's own submission never appears, and there is no "speaker" model so the four participants would render indistinguishably even once history rendering lands.

The parent plan resolves this by introducing `TugTranscriptEntry` — a layout primitive — *before* wiring multi-turn rendering (parent §step-11). Splitting "design the row" from "wire the data" keeps the visual primitive tunable in isolation: tokens, icon column geometry, header treatment, and body slot are reviewable in a gallery card without entangling the live `CodeSessionStore` data flow or the architectural call about `TugMarkdownView` ownership ([Q01]).

#### Strategy {#strategy}

- **Primitive first, consumers later.** Step 9 produces an unbound primitive plus a gallery demo; the primitive does NOT depend on `CodeSessionStore`, `TugMarkdownView`, or any transcript-aware code path. See [D04].
- **Token-driven.** All visual metrics (icon size, identifier styling, vertical rhythm, controls-row spacing) live in `--tugx-transcript-*` tokens. Per-participant variants override via `[data-participant="..."]` selectors, not branching code paths. See [D03].
- **Open variant model.** Adding a fifth participant is a token + an icon registration, not a primitive rewrite. The TS type starts narrow but consumption is purely CSS-cascade-driven.
- **Slot-based body.** `body: React.ReactNode` — the primitive renders no text directly. Step 11 decides whether to pass a `TugMarkdownView`, an atom-flavored text node, or a structured renderer. The primitive imposes no opinion on streaming, markdown, or atom rendering. See [D02].
- **Gallery card validates the design with mock data.** Realistic-looking content for all four variants stacked. Not wired to any live store.
- **Tuglaws cross-checked at every step.** [L02] (no parallel React state — primitive is presentational), [L06] (appearance via CSS), [L19] (component authoring guide), [L20] (token sovereignty). See [#tuglaws-cross-check].
- **Build stays green at every commit.** `bun x tsc --noEmit`, `bun test`, `bun run audit:tokens lint`, `cargo nextest run` pass on every step.

#### Success Criteria (Measurable) {#success-criteria}

- A `TugTranscriptEntry` primitive exists at `tugdeck/src/components/tugways/tug-transcript-entry.tsx` exposing `Participant`, `TugTranscriptEntryProps`, and a default-exported component matching the spec in [#public-api]. (Verified: file exists; types match; unit test renders each participant variant.)
- Per-participant differences come exclusively from `[data-participant="..."]` selectors over `--tugx-transcript-*` tokens. The TSX has zero participant-specific render branches outside the icon registry. (Verified: grep `participant === "` in `tug-transcript-entry.tsx` returns zero matches except the icon registry.)
- A gallery card renders all four variants (`user`, `code`, `shell`, `command`) stacked with realistic mock content, registered in `gallery-registrations.tsx`. (Verified: open `gallery-transcript-entry` in tugdeck; visual review against [D01].)
- The primitive has no dependency on `CodeSessionStore`, `TugMarkdownView`, or any tide-card path. (Verified: grep `code-session-store|TugMarkdownView|tide-card` in `tug-transcript-entry.tsx` returns zero matches.)
- `bun x tsc --noEmit`, `bun test`, `bun run audit:tokens lint`, `cargo nextest run` green at every step.
- Parent plan §step-9 row flips to "shipped" once this plan completes.

#### Scope {#scope}

1. **Tokens.** New `--tugx-transcript-*` token set in `brio.css` and `harmony.css`, with per-participant icon-color overrides.
2. **Primitive.** `tug-transcript-entry.tsx` + `tug-transcript-entry.css` per the component-authoring guide, plus unit tests.
3. **Gallery card.** `gallery-transcript-entry.tsx` showcasing all four variants with mock content; `registerCard` entry in `gallery-registrations.tsx`.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Live `CodeSessionStore` wiring — parent §step-11.
- Multi-turn rendering, streaming-binding, transcript scroll behavior — parent §step-11.
- The Cmd+J keybinding — parent §step-11 (absorbed from §step-6).
- Markdown styling pass for assistant output — parent §step-12.
- Thinking + tool-use surface rendering — parent §step-13.
- Live `shell` and `command` participant rendering — gated on Phases T4 and T10 respectively. Gallery uses mock content only.
- Atom rendering for `user` rows — atoms in user submissions are a Step 11 concern; the primitive's `body` slot accepts whatever node Step 11 chooses.
- Per-row reactions, threading, message editing.
- Avatar photos. Participant icons are glyphs/marks per parent [D6].
- The session ledger (parent §step-10). Independent placeholder; parent confirms downstream steps do not depend on it.

#### Dependencies / Prerequisites {#dependencies}

- Existing base tokens (`--tug-space-*`, `--tug-icon-size-*`, `--tug-font-size-*`) in `brio.css` / `harmony.css`.
- Existing token audit machinery (`bun run audit:tokens lint`) and seven-slot naming convention.
- Existing card registration mechanism: `registerCard({ componentId, contentFactory, defaultMeta, family, sizePolicy, category })` in `card-registry`.
- Existing tugways primitives (`TugBadge`, `TugBox`, `TugPushButton`, `TugMarkdownView`) for use in the gallery card's mock content.
- Existing component-authoring guide ([tuglaws/component-authoring.md](../tuglaws/component-authoring.md)) — file pair, `data-slot`, module docstring, props interface.

#### Constraints {#constraints}

- **Tuglaws** [L02], [L06], [L19], [L20] apply at every step. See [#tuglaws-cross-check].
- **Warnings are errors.** `cargo build` / `cargo nextest run` enforce `-D warnings` (CLAUDE.md build policy). Frontend type-check + tests treat warnings as errors equivalently.
- **HMR is always running**: never run a manual tugdeck build (`feedback_hmr` memory).
- **Use bun, not npm**: every tooling invocation is `bun ...` (`feedback_use_bun` memory).
- **happy-dom test scoping**: this plan's tests are pure DOM-shape and slot-pass-through assertions — happy-dom is suitable. No `getBoundingClientRect`-based layout-fidelity assertions (`feedback_no_happy_dom_tests` memory).
- **No plan numbers in code**: never write `step-N`, `4.5`, `T3.4.d`, `D01`, etc. into code, comments, or docstrings (`feedback_no_plan_numbers_in_code` memory).
- **No mock-store assertion tests**: tests render through real React, not via hand-rolled mock stores. The primitive is presentational so this falls out naturally (`feedback_no_mock_store_tests` memory).
- **Cross-check tuglaws**: read [tuglaws.md](../tuglaws/tuglaws.md), [pane-model.md](../tuglaws/pane-model.md), [component-authoring.md](../tuglaws/component-authoring.md) before TSX changes (`feedback_tuglaws_cross_check` memory).

#### Assumptions {#assumptions}

- Per-participant overrides via `[data-participant="..."]` selectors satisfy the seven-slot naming audit. (Verified by writing the tokens in [Step 1](#step-1) and running lint.)
- The four initial participants are sufficient for the primitive to demonstrate openness — adding a fifth must remain a token + registration change, not a primitive edit.
- The gallery card mechanism does not require `CodeSessionStore` / `SessionMetadataStore` stubs to render mock rows; static React nodes for slot contents are enough.
- `TugMarkdownView`'s imperative `setRegion("body", text)` works inside an arbitrary container without further plumbing; the gallery uses one MV per `code` row's body purely to demonstrate the slot accepts an MV. (Verified at [Step 3](#step-3) by mounting and inspecting.)

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows [tuglaws/tugplan-skeleton.md §reference-conventions](../tuglaws/tugplan-skeleton.md#reference-conventions). Key points:

- All execution-step anchors are kebab-case `step-N`.
- Design decisions use `dNN-...` slugs.
- Open questions use `qNN-...` slugs.
- Risks use `rNN-...` slugs.
- `**References:**` lines cite specific decisions, specs, lists, and anchors — never line numbers.
- `**Depends on:**` lines cite step anchors only.

---

### Open Questions {#open-questions}

#### [Q01] `code` row body-slot ownership in the live transcript (DECIDED for §step-11) {#q01-body-slot-ownership}

**Question:** When parent §step-11 wires the primitive to live data, should each `code` row own its own `TugMarkdownView`, or should the whole transcript scroll surface be a single `TugMarkdownView` with one named region per code row?

**Why it matters:** Affects per-row MV count (and BlockHeightIndex / DOMPurify cache memory) for long sessions; affects whether the streaming binding lives on the row or on the surface; affects how `setRegion` keys are minted.

**Options:**
- (a) **Per-code-row MV.** Each completed row owns one MV bound by `setRegion("body", text)`; the in-flight row binds to `streamingDocument` via `streamingPath`. On `turn_complete`, the row swaps from streaming-bound to imperative-region with the final text.
- (b) **Single transcript-wide MV.** The whole top pane is one MV. Each code row gets `setRegion(\`code-${msgId}\`, text)`. The in-flight code row's region tracks `streamingDocument` via a small adapter. User rows render outside the MV (interleaved DOM) or as embedded HTML inside the markdown content.
- (c) **Hybrid.** Per-row MV for code rows; non-MV scroll container at the transcript level.

**Resolution:** DECIDED — (a) per-row MV. Confirmed for §step-11. The primitive remains insulated by [D02]; this resolution governs §step-11 wiring only. Re-evaluate if perf measurements (long transcripts, many turns) motivate (b) or (c).

---

#### [Q02] `code` row identifier source (DECIDED for §step-11) {#q02-code-identifier}

**Question:** Does `code` row identifier read `"Code"` (static label) or the active model's display name from `SessionMetadataStore` (dynamic)?

**Resolution:** DECIDED — dynamic. Show the model display name when available, fall back to `"Code"` otherwise. Implemented in §step-11.

---

#### [Q03] Per-participant glyphs (DECIDED) {#q03-glyphs}

**Question:** Which icon glyph represents each participant?

**Resolution:** DECIDED — lucide icons in the gutter, route-prefix character moved to live alongside the typed input itself (in the body for `user`, in the identifier for `shell` and `command`):

| Participant | Gutter icon (lucide) | Where the route prefix sits |
|-|-|-|
| `user`    | `User`    | In the body (`> tell me a haiku`) |
| `code`    | `Bot`     | n/a (assistant response, no typed input) |
| `shell`   | `Shell`   | In the identifier (`$ git`) |
| `command` | `Command` | In the identifier (`:cost`) |

Speaker distinction between `user` and `code` rows comes from both the gutter icon and the bold identifier (`"You"` vs the dynamic model name from [Q02]). Lucide icons read at a glance and stay consistent with the rest of the tugways primitives' iconography. New participants extend `PARTICIPANT_ICONS` with whatever lucide icon a future design pass calls for.

**Iteration note:** An earlier draft of this plan resolved [Q03] with three text glyphs (`>`, `>`, `$`, `:`) in the gutter. After visual review of the gallery, the design moved to lucide icons (above) — the prefix character is more legible alongside the typed input than as a separate gutter mark.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Per-row MV instances regress scroll perf at long transcripts | med | med | Insulated by [D02] — primitive doesn't bind MV; perf evaluated in parent §step-11 | Parent §step-11 smoke against ~50+ turn transcript |
| New tokens collide with existing `--tug*` namespace | low | low | `--tugx-transcript-*` prefix is unique; audit:tokens lint exits 0 in [Step 1](#step-1) | If audit fails |
| Slot-based primitive is too thin, pushing layout work into Step 11 wiring | low | med | Primitive owns icon-column geometry, header layout, and vertical rhythm; wiring code only fills slots | If §step-11 PR adds custom layout CSS instead of consuming the primitive |
| Gallery `user` row reads as misleading without atom rendering | low | med | Gallery uses plain text snippets; document atom rendering as a Step 11 concern in module docstring | Visual review flags |

**Risk R01: Slot model is too narrow.** {#r01-too-narrow}

- **Risk:** A future participant variant (e.g., a `system` admin row, a `session_init` notice row) needs structurally different chrome that the icon + header + body + controls layout can't express.
- **Mitigation:** [D03]'s data-participant cascade covers per-variant tokens; new structural needs would be a new primitive, not a primitive edit.
- **Residual risk:** None for the four named participants. Future variants evaluate against the slot model individually.

---

### Design Decisions {#design-decisions}

#### [D01] Slack-like layout, not chat bubbles (DECIDED) {#d01-slack-not-bubbles}

**Decision:** Two-column row: ~36px icon column on the left; right column has a header (bold identifier + small timestamp), a body, and an optional controls row beneath. No rounded per-row container. No left-vs-right alignment by speaker. No row background colors except per-token participant variants if any are introduced later.

**Rationale:** Carried forward from parent plan's [D6](./tugplan-tide-card-polish.md#resolved-decisions). Chat bubbles alternate by speaker and rounding-decorate each row, making a long transcript hard to scan and conflicting with the developer-tool aesthetic. Slack-style stays scannable and supports four participants symmetrically.

**Implications:**
- Icon column width fixed by token; not configurable per-row.
- No per-row container background or border in the base styles.
- Header / body / controls each get their own DOM node; tokens drive vertical rhythm.

---

#### [D02] `body: React.ReactNode` — primitive renders no text (DECIDED) {#d02-body-react-node}

**Decision:** The primitive's body slot accepts arbitrary `React.ReactNode`. The primitive does not hard-code a markdown renderer, an atom-flavored text component, or any text-rendering behavior. Same for `controls`.

**Rationale:** Decouples the primitive from architectural decisions about MV ownership ([Q01]) and from atom rendering. Step 11 (and future participant rows) decide what to pass in. Keeps the primitive stable across the lifetime of Steps 11–14.

**Implications:**
- The primitive cannot opinionate on streaming, markdown, or atom rendering.
- Tokens still control body line-height, color, and surrounding spacing — those apply to whatever DOM the slot's children produce, via cascade.
- The gallery card passes mock content (plain strings, fenced strings, a `<TugMarkdownView>` with a static `setRegion` for the `code` row).

---

#### [D03] Per-participant variants via `[data-participant]` selectors only (DECIDED) {#d03-data-participant}

**Decision:** All per-variant differences (icon, icon color, identifier styling, optional padding tweaks) come from `[data-participant="user|code|shell|command"]` selectors over `--tugx-transcript-*` tokens. The TSX has a single `data-participant={participant}` attribute on the row root and a small `PARTICIPANT_ICONS` registry; no other participant-specific branches.

**Rationale:** Adding a fifth participant should be a token + an icon registration, not a primitive edit. CSS-only variants honor [L06] (appearance via CSS) and keep the TSX shape stable.

**Implications:**
- The TSX exposes one `data-participant` value; CSS handles the rest.
- The icon registry lives at module scope; new participants extend it.
- Tokens for each variant are namespaced (`--tugx-transcript-icon-color-user`, `…-code`, `…-shell`, `…-command`), pulled into the cascade by `[data-participant]` selectors.

---

#### [D04] Step 9 ships zero production wiring (DECIDED) {#d04-no-production-wire}

**Decision:** No edit to `tide-card.tsx`, `code-session-store.ts`, `session-metadata-store.ts`, or any file outside the new primitive, its CSS, the gallery card, the gallery registry, and the theme files. Production wiring is parent §step-11.

**Rationale:** Lets the primitive land on its own commit. If Step 11 wants to revise the slot model after live integration reveals a constraint, that revision is one PR, not a multi-file unwind.

**Implications:**
- No integration step in this plan.
- Tests do not involve `CodeSessionStore`, `TugMarkdownView`'s streaming mode, or `tide-card`.
- The Plan Status row in the parent plan flips to "shipped" only when the gallery card mounts cleanly and the primitive's tests pass.

---

#### [D05] Token namespace: `--tugx-transcript-*` (DECIDED) {#d05-token-namespace}

**Decision:** Component-scoped tokens for the transcript primitive use the `--tugx-transcript-*` prefix. Per-participant variant tokens use `--tugx-transcript-<concern>-<participant>` (e.g., `--tugx-transcript-icon-color-user`).

**Rationale:** Mirrors the existing component-scoped namespace convention (`--tugx-text-editor-*`, `--tugx-host-canvas-*`). Keeps the transcript primitive's tokens discoverable and avoids polluting the base `--tug-*` tier.

**Implications:**
- All new tokens land under the `--tugx-transcript-*` prefix.
- Base tokens (`--tug-space-*`, `--tug-icon-size-*`, `--tug-font-size-*`) are referenced from the primitive's tokens via `var()` rather than redefined.

---

### Specification {#specification}

#### Public API {#public-api}

```ts
export type Participant = "user" | "code" | "shell" | "command";

export interface TugTranscriptEntryProps {
  /** Which participant this row represents. Drives `data-participant` and the icon. */
  participant: Participant;
  /** Bold leading label in the header row. Plain string or styled node. */
  identifier: React.ReactNode;
  /** Optional small timestamp rendered next to the identifier. */
  timestamp?: React.ReactNode;
  /** Row body content. The primitive imposes no opinion on text rendering. */
  body: React.ReactNode;
  /** Optional trailing affordance row beneath the body (badges, copy button, etc.). */
  controls?: React.ReactNode;
  /** Forwarded className for consumer overrides. Optional. */
  className?: string;
}

export const TugTranscriptEntry: React.FC<TugTranscriptEntryProps>;
```

#### DOM shape {#dom-shape}

```html
<div
  data-slot="tug-transcript-entry"
  data-participant="<participant>"
  role="article"
  aria-labelledby="<id>"
  class="tug-transcript-entry"
>
  <div class="tug-transcript-entry__icon" aria-hidden="true">{icon}</div>
  <div class="tug-transcript-entry__body-column">
    <div class="tug-transcript-entry__header">
      <strong id="<id>" class="tug-transcript-entry__identifier">{identifier}</strong>
      <!-- timestamp emitted only when prop is provided -->
      <span class="tug-transcript-entry__timestamp">{timestamp}</span>
    </div>
    <div class="tug-transcript-entry__body">{body}</div>
    <!-- controls emitted only when prop is provided -->
    <div class="tug-transcript-entry__controls">{controls}</div>
  </div>
</div>
```

Accessibility: the row root carries `role="article"` with `aria-labelledby` pointing at the bold identifier (`<strong>`). This works regardless of whether the identifier is a plain string or a styled node — the rendered identifier serves as the article's accessible name verbatim. Detailed labelling beyond that is a Step 11 concern; the primitive provides reasonable defaults.

Note: `data-slot="tug-transcript-entry"` follows the `tug-{name}` convention defined in [component-authoring.md](../tuglaws/component-authoring.md).

#### Tokens {#tokens}

`--tugx-transcript-*` tokens, defined identically (modulo theme color values) in `brio.css` and `harmony.css`:

| Token | Purpose | Initial value (brio) |
|-|-|-|
| `--tugx-transcript-row-gap` | Gap between adjacent rows when stacked | `var(--tug-space-lg)` |
| `--tugx-transcript-icon-column-width` | Width of the icon column | `36px` |
| `--tugx-transcript-icon-size` | Icon glyph dimension | `var(--tug-icon-size-md)` |
| `--tugx-transcript-icon-color-user` | User-row icon color | participant-tinted |
| `--tugx-transcript-icon-color-code` | Code-row icon color | participant-tinted |
| `--tugx-transcript-icon-color-shell` | Shell-row icon color | participant-tinted |
| `--tugx-transcript-icon-color-command` | Command-row icon color | participant-tinted |
| `--tugx-transcript-identifier-color` | Header identifier color | default text |
| `--tugx-transcript-identifier-weight` | Header identifier font-weight | `600` |
| `--tugx-transcript-identifier-font-size` | Header identifier size | `var(--tug-font-size-sm)` |
| `--tugx-transcript-timestamp-color` | Timestamp color | muted |
| `--tugx-transcript-timestamp-font-size` | Timestamp size | `var(--tug-font-size-xs)` |
| `--tugx-transcript-header-gap` | Gap between identifier and timestamp | `var(--tug-space-sm)` |
| `--tugx-transcript-body-line-height` | Body block line-height | `1.5` |
| `--tugx-transcript-body-color` | Body text color | default text |
| `--tugx-transcript-body-margin-top` | Body top spacing under header | `var(--tug-space-2xs)` |
| `--tugx-transcript-controls-gap` | Gap between controls items | `var(--tug-space-sm)` |
| `--tugx-transcript-controls-margin-top` | Controls row top spacing | `var(--tug-space-xs)` |

Per-participant overrides use `[data-participant="..."]` selectors on the row root and override the variant-specific tokens (initially just the icon-color slots); future tokens added under the `[data-participant]` cascade as needed.

#### Forward compatibility — seams Step 11 will use {#forward-compat}

The seams below are deliberately small. Step 11 reads from them; this plan does not modify them.

- **`body: ReactNode`.** Step 11 passes a `<TugMarkdownView>` (or whatever shape resolves [Q01]) for `code` rows; plain JSX for `user`; mock plain text for `shell` / `command` until their phases land.
- **`controls?: ReactNode`.** Step 11 passes a `<TugBadge>{model}</TugBadge>` + copy button for `code` rows; an exit-code badge for `shell`; nothing for the others by default.
- **`identifier: ReactNode`.** Step 11 passes a string `"You"` for `user`, a dynamic model name for `code` ([Q02]), the command's first token for `shell`, the command name for `command`.
- **`participant`.** Step 11 maps each `TurnEntry` to two rows (`user` + `code`) and each pending in-flight turn similarly; future participants drop in by extending the type and the icon registry.

Step 11 does not modify the primitive. If it discovers it needs to, that finding warrants a follow-up plan, not an inline edit.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|-|-|
| `tugdeck/src/components/tugways/tug-transcript-entry.tsx` | Primitive TSX |
| `tugdeck/src/components/tugways/tug-transcript-entry.css` | Primitive styles |
| `tugdeck/src/components/tugways/cards/gallery-transcript-entry.tsx` | Gallery showcase card |
| `tugdeck/src/components/tugways/__tests__/tug-transcript-entry.test.tsx` | Primitive unit tests |

#### Modified files {#modified-files}

| File | Change |
|-|-|
| `tugdeck/styles/themes/brio.css` | Add `--tugx-transcript-*` tokens + per-participant overrides |
| `tugdeck/styles/themes/harmony.css` | Same |
| `tugdeck/src/components/tugways/cards/gallery-registrations.tsx` | Register `gallery-transcript-entry` |

#### Symbols {#symbols}

| Symbol | Kind | Location | Notes |
|-|-|-|-|
| `Participant` | type alias | `tug-transcript-entry.tsx` | Exported |
| `TugTranscriptEntryProps` | interface | `tug-transcript-entry.tsx` | Exported |
| `TugTranscriptEntry` | component | `tug-transcript-entry.tsx` | Exported |
| `PARTICIPANT_ICONS` | const map | `tug-transcript-entry.tsx` | Internal — the icon registry; new participants extend it |
| `GalleryTranscriptEntry` | component | `gallery-transcript-entry.tsx` | Exported and registered |

---

### Documentation Plan {#documentation-plan}

- [ ] Module docstring on `tug-transcript-entry.tsx` per the component-authoring guide. Opening line states: layout primitive for Tide transcripts, four participants, no live wiring.
- [ ] Module docstring on `gallery-transcript-entry.tsx` clarifying that data is mock; live wire lands in a follow-up plan.
- [ ] No external documentation site update required by this plan.

---

### Test Plan Concepts {#test-plan-concepts}

| Category | Purpose | When |
|-|-|-|
| Unit (DOM snapshot) | Render the primitive with each participant variant; verify `data-participant` and the rendered structure match the spec | [Step 2](#step-2) |
| Unit (slot pass-through) | `body` and `controls` slots render their children verbatim; `timestamp`-omitted case omits the node from the DOM | [Step 2](#step-2) |
| Visual (gallery) | Gallery card renders all four variants stacked; manual review against [D01] | [Step 3](#step-3) |
| Token audit | `bun run audit:tokens lint` exits 0 with the new tokens | [Step 1](#step-1) |

happy-dom is suitable for all units in this plan: no `getBoundingClientRect`-based layout-fidelity assertions, no focus / selection / event-ordering tests across React renders.

---

### Tuglaws Cross-Check {#tuglaws-cross-check}

- **L02** — primitive holds no React state; consumers pass slot contents directly. No `useSyncExternalStore` registration; the primitive is presentational.
- **L03** — no subscriptions to install; `useLayoutEffect` not used.
- **L06** — all per-variant appearance flows through CSS variables and `[data-participant]` selectors; no inline `style={{}}` for participant differences.
- **L07** — n/a (no event handlers in the primitive).
- **L11** — n/a (no responder registration; the primitive is a layout shell).
- **L19** — file pair (`tug-transcript-entry.tsx` + `tug-transcript-entry.css`); module docstring; exported props interface; `data-slot="transcript-entry"`.
- **L20** — component-token sovereignty: only `--tugx-transcript-*` tokens drive participant differences; base `--tug-*` tokens are read but never redefined.
- **L22** — n/a (no high-frequency direct DOM writes; the primitive is React-only).
- **L23** — n/a (no user-visible state to preserve at this layer; consumer slots own state).
- **L24** — n/a (no state-zone classifications introduced).

---

### Execution Steps {#execution-steps}

> Each step is its own commit. `bun x tsc --noEmit`, `bun test`, `bun run audit:tokens lint`, and `cargo nextest run` pass at the end of every step.

#### Step 1: Token tier {#step-1}

**Commit:** `tide(transcript): add --tugx-transcript-* tokens`

**References:** [D03] data-participant selectors, [D05] token namespace, [#tokens], (#scope, #constraints)

**Artifacts:**
- Updated `tugdeck/styles/themes/brio.css` with the full `--tugx-transcript-*` token set per [#tokens] plus the four per-participant `[data-participant]` overrides.
- Updated `tugdeck/styles/themes/harmony.css` mirror with appropriate harmony color values.

**Tasks:**
- [x] Add the eighteen tokens to `brio.css` under a `/* Transcript primitive */` comment block. Includes the four per-participant icon-color flavor slots (`--tugx-transcript-icon-color-{user|code|shell|command}`); the `[data-participant]` cascade that maps a flavor onto the active token is a component-CSS concern (lives in [Step 2](#step-2)'s `tug-transcript-entry.css`).
- [x] Mirror in `harmony.css`. Structural names match exactly; values reference the same `var(--tug7-...)` base tokens, so per-theme color differences fall out automatically.
- [x] Run `bun run audit:tokens lint`; resolve any seven-slot naming complaints. (No complaints — `--tugx-` extension prefix is exempt from seven-slot enforcement.)

**Tests:**
- [x] `bun run audit:tokens lint` exits 0.

**Checkpoint:**
- [x] `bun run audit:tokens lint` — ✓ Zero violations.
- [x] `bun x tsc --noEmit` — exit 0.

---

#### Step 2: `TugTranscriptEntry` primitive {#step-2}

**Depends on:** #step-1

**Commit:** `tide(transcript): add TugTranscriptEntry primitive`

**References:** [D02] body-react-node, [D03] data-participant selectors, [D04] no-production-wire, [Q03] glyphs, [#public-api], [#dom-shape], [#tuglaws-cross-check]

**Artifacts:**
- New `tug-transcript-entry.tsx` exporting `Participant`, `TugTranscriptEntryProps`, `TugTranscriptEntry`, plus the internal `PARTICIPANT_ICONS` registry.
- New `tug-transcript-entry.css` consuming the [Step 1](#step-1) tokens.
- New `__tests__/tug-transcript-entry.test.tsx` covering per-variant DOM, slot pass-through, and the timestamp-omitted case.

**Tasks:**
- [x] Author the TSX per the component-authoring guide: module docstring, library imports, internal imports, props interface (exported), component (exported, functional — no imperative API so no `forwardRef`), `data-slot="tug-transcript-entry"`, single `data-participant` attribute on the row root, `role="article"` + `aria-labelledby` pointing at the bold identifier.
- [x] Implement the icon registry per [Q03]: `PARTICIPANT_ICONS = { user: <User/>, code: <Bot/>, shell: <Shell/>, command: <Command/> }` from `lucide-react` — lucide glyphs in the gutter, route prefix lives alongside the typed input.
- [x] Author the CSS using only `--tugx-transcript-*` and base `--tug-*` tokens. Two-column grid (`grid-template-columns: var(--tugx-transcript-icon-column-width) 1fr`). Header uses flex with `--tugx-transcript-header-gap`. Body and controls stack with `margin-top` from tokens. The `[data-participant]` cascade rules live here and map each flavor token onto the active `--tugx-transcript-icon-color`.
- [x] Author unit tests covering: per-participant DOM shape (4 cases), slot pass-through (`body`, `controls`), optional-slot omission (`timestamp`, `controls`), and `className` forwarding.

**Tests:**
- [x] DOM snapshot per participant — 4 tests, asserts `data-slot`, `data-participant`, `role`, `aria-labelledby` ↔ identifier id, glyph, identifier `<strong>`, timestamp, body, controls.
- [x] Slot pass-through (`body`, `controls`) via sentinel children.
- [x] Optional-slot omission (`timestamp`, `controls`).
- [x] `className` forwarding.

**Checkpoint:**
- [x] `bun x tsc --noEmit` — exit 0.
- [x] `bun test src/components/tugways/__tests__/tug-transcript-entry.test.tsx` — 9 pass / 0 fail / 58 expect() calls.
- [x] `bun run audit:tokens lint` — ✓ Zero violations.

---

#### Step 3: Gallery card + registration {#step-3}

**Depends on:** #step-2

**Commit:** `tide(transcript): gallery showcase for TugTranscriptEntry`

**References:** [D01] slack-not-bubbles, [D02] body-react-node, [D04] no-production-wire, (#scope, #forward-compat)

**Artifacts:**
- New `gallery-transcript-entry.tsx` rendering all four variants stacked with realistic mock content:
  - `user` row: identifier `"You"`, timestamp `"2:14 PM"`, body `> tell me a haiku`.
  - `code` row: identifier — a mock model name (e.g., `"claude-opus-4-7"`) demonstrating the dynamic shape from [Q02], timestamp `"2:14 PM"`, body — plain JSX rendering of the haiku (a markdown view's reserved viewport added a tall blank gap; the live consumer will substitute a per-row `TugMarkdownView`); controls — a model name badge + a copy button.
  - `shell` row: identifier `"$ git"` (route prefix moved to the identifier per [Q03]), timestamp `"2:13 PM"`, body — a `<pre>` block with mock `git status` output; controls — an exit-code badge `"exit 0"`.
  - `command` row: identifier `":cost"`, timestamp `"2:12 PM"`, body — structured rendered output (table or labeled values); controls — a refresh button.
- One `registerCard({ componentId: "gallery-transcript-entry", contentFactory: (_cardId) => <GalleryTranscriptEntry />, defaultMeta: { title: "TugTranscriptEntry", icon: "MessageSquare", closable: true }, family: "developer", acceptsFamilies: ["developer"], sizePolicy: ..., category: ... })` entry in `gallery-registrations.tsx`.

**Tasks:**
- [x] Author the gallery card. `GALLERY_COMPONENT_SIZE` + `CATEGORIES.textInput` (Text Input & Display) — same shape and category as `gallery-markdown-view`.
- [x] Author module docstring stating the data is mock; live wire lands in a follow-up plan.
- [x] Add the registration entry alongside other text/display gallery cards (immediately after `gallery-markdown-1kb`).
- [ ] Manual visual review: open `gallery-transcript-entry` in tugdeck; confirm against [D01] — no rounded per-row container, no left-vs-right alignment by speaker, no chat bubbles. **(User-driven; HMR picks up the changes.)**

**Tests:**
- [x] Render-only smoke test: `<GalleryTranscriptEntry />` mounts without throwing in happy-dom and produces four `data-slot="tug-transcript-entry"` rows in `["user", "code", "shell", "command"]` order. WASM is initialized synchronously in `beforeAll` because the embedded `<TugMarkdownView>` calls into `tugmark-wasm` on mount; this mirrors the existing tugmark-wasm logic-test pattern in `src/__tests__/`.

**Checkpoint:**
- [x] `bun x tsc --noEmit` — exit 0.
- [x] `bun test` — 2744 pass / 0 fail / 10775 expect() calls across 165 files.
- [x] `bun run audit:tokens lint` — ✓ Zero violations.
- [ ] Manual: open `gallery-transcript-entry` in tugdeck and visually review. **(User-driven.)**

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** `TugTranscriptEntry` primitive (TSX + CSS + tokens + gallery showcase + tests), with no production wiring. Parent §step-9 row in the Plan Status table flips to "shipped" upon completion.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [x] `tug-transcript-entry.tsx` and `.css` exist and conform to [component-authoring.md](../tuglaws/component-authoring.md).
- [x] All four participants render in the gallery card with distinct icons and identifiers (verified by smoke test; visual differentiation pending manual review).
- [x] Per-participant differences come exclusively from `[data-participant]` selectors on tokens — TSX has zero participant-specific render branches outside the `PARTICIPANT_ICONS` registry.
- [x] No `code-session-store` / `TugMarkdownView`-streaming / `tide-card` import in the primitive.
- [x] `bun x tsc --noEmit`, `bun test`, `bun run audit:tokens lint` green. (Workspace `cargo nextest run` is unaffected — no Rust touched.)
- [ ] Parent plan §step-9 row flips to "shipped"; the parent plan's Plan Status table is updated in a follow-up commit on the same branch after manual visual review.

**Acceptance tests:**
- [x] DOM snapshot tests for each of the four participants pass.
- [x] Slot pass-through tests (`body`, `controls`) pass.
- [x] Optional-slot omission (`timestamp`, `controls`) tests pass.
- [x] Gallery card render-only smoke test passes.
- [ ] Manual gallery visual review confirms [D01]. **(User-driven.)**

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Parent §step-11 — Multi-turn transcript rendering with `TugTranscriptEntry`. Consumes this primitive. Inherits [Q01] = per-row MV and [Q02] = dynamic identifier as decided constraints. Authored as its own plan (e.g., `dash/tugplan-tide-transcript-rendering.md`).
- [ ] Parent §step-10 — Tugcast-side session ledger. Independent placeholder; will be promoted to its own plan (e.g., `dash/tugplan-tide-session-ledger.md`) on its own schedule and does not block §step-11.
- [ ] Parent §step-12 — Markdown styling pass for assistant output. Builds on parent §step-11's wired transcript.
- [ ] Atom rendering for `user` rows — resolved when §step-11 picks the `body` content type for `user` participants.

| Checkpoint | Verification |
|-|-|
| Tokens lint clean | `bun run audit:tokens lint` |
| Primitive unit tests | `bun test src/components/tugways/__tests__/tug-transcript-entry.test.tsx` |
| Gallery card mounts | Manual: open `gallery-transcript-entry` in tugdeck |
| TS clean | `bun x tsc --noEmit` |
| Workspace tests | `cargo nextest run` |
