## Transcript Rendering Improvements {#transcript-improvements}

**Purpose:** Make the dev-card message transcript beautiful, legible, and fast — fix the windowed-scroll blank-flash (hard "never blank" invariant), redesign markdown rendering and tool-block headers (two research-driven design spikes vetted in gallery cards), copy *real markdown* (including partial selections), repair skill slash-commands, and enlarge image previews.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-06-12 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The dev-card transcript renders correctly but presents poorly. Tool-call blocks (Read, Grep, Bash) are noisy and verbose; markdown headers use an oversized scale (`h1` = 24px) and inline code shifts color and font in ways that harm legibility; copying a transcript row writes plain text to the pasteboard instead of markdown; image attachment thumbnails are too small to be useful; several skills (`/devise`, etc.) come through the prompt entry as *file atoms* rather than slash-command atoms; and — the one true functional defect — fast scrolling through a windowed transcript flashes blank card background where rows have not yet mounted or painted.

Now is the right time: the transcript's architecture has stabilized (single-kind assistant cell [L26], `TugListView` windowing with a measured height index, the `ToolCallHeader`/`ToolBlockChrome`/`ToolBlockHistoryCollapse` family, and a markdown parser that already records per-block source character offsets). Every fix below lands on a settled foundation rather than a moving one.

#### Strategy {#strategy}

- **Perf first** — the blank-flash is a defined bug degrading everyday use; fix it before the design work. Two-layer defense: render-ahead (directional, tunable overscan) plus a skeleton backstop so a row in the window *never* shows bare background.
- **Two design spikes, each gallery-vetted** — markdown typography and the collapsed-tool-block header are taste-driven; build/extend a gallery card with candidate option sets, vet, then apply the chosen tokens. Web research (already done; see [#research-notes]) informs the candidates.
- **Do the hard copy work** — partial-selection copy reconstructs markdown from the parser's source offsets; no plain-text fallback.
- **One editable table for collapse policy** — a single per-tool map is the source of truth; trivially flippable.
- **Sequence:** perf → markdown → tool-blocks → skills → images. Each area ends with an integration checkpoint.

#### Success Criteria (Measurable) {#success-criteria}

- Fast-scrolling a transcript never paints bare card background in **either** render mode — windowed (>1200 rows or >600 messages) *and* inline (the `content-visibility: auto` path below the threshold) — verified by `verify`-skill app runs scrolling at speed in both regimes, plus a windowing unit test asserting no transparent gap in the rendered range. ([#step-1], [#step-2])
- `h1`/`h2`/`h3` in transcript markdown render at the gallery-vetted compressed scale (size delta ≤ ~4px across the hierarchy; differentiation is weight + spacing), confirmed visually in `gallery-markdown-view`. ([#step-4], [#step-5])
- Inline code renders with no aggressive color shift — a subtle tint only — confirmed in the gallery. ([#step-5])
- Selecting any sub-range of an assistant row and copying yields well-formed markdown for that selection (round-trips: copied text re-parses to the same block structure), proven by a unit test over the Range→markdown mapping. ([#step-6], [#step-7])
- Read/Grep/Glob/Bash/Edit/Write tool blocks mount collapsed by default (live and historical); the collapsed header alone conveys tool + target + one-line result, verified in `gallery-tool-block-*` and the new collapsed-header gallery card. ([#step-9], [#step-11])
- Error tool blocks color only the header, not the body — verified visually and by a CSS/DOM assertion that the body container carries no error color token. ([#step-12])
- Typing `/devise` (and other skills) in the dev prompt entry produces a slash-command atom, not a file atom — verified in-app. ([#step-14])
- Image attachment thumbnails render at the enlarged size and open a zoom preview on click — verified in-app. ([#step-16])

#### Scope {#scope}

1. `TugListView` windowing: directional + tunable overscan, and a never-blank skeleton backstop.
2. Markdown typography: compressed header scale + de-styled inline code (gallery-vetted tokens).
3. Markdown copy: full-row and partial-selection markdown reconstruction.
4. Tool-block rendering: per-tool collapse-default table, collapsed-header redesign, header-only error coloring, header font sizing.
5. Skills: slash-command atom classification fix + skill argument placeholder slots.
6. Image previews: enlarged thumbnails + click-to-zoom.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Rewriting the markdown parser or swapping the highlighter (Shiki stays).
- Changing the transcript's overall row structure (user row / assistant row split, single-kind cell [L26]).
- The windowed↔inline threshold tuning (`WINDOWED_TRANSCRIPT_*_THRESHOLD`) — left as-is.
- New tool-block *kinds* or new tools; this is presentation only.
- Server/tugcode protocol changes (skills arrive in the existing `session_capabilities` handshake).
- Persisting markdown typography or collapse defaults to tugbank — they are code-level tokens/tables.

#### Dependencies / Prerequisites {#dependencies}

- Markdown parser source offsets: `parse-markdown-to-sanitized-blocks.ts` already exposes `startOffset`/`endOffset` per block ([#partial-copy-design]).
- `SessionMetadataStore` already merges `slash_commands ∪ skills ∪ agents` from the turn-free `initialize` handshake (`session_capabilities`).
- Existing collapse machinery: `ToolBlockHistoryCollapse`, `ToolBlockExpansionState`, `ToolBlockCollapseContext`, the `disclosure` prop on `ToolCallHeader`.
- `DevAttachmentPreview` + `useTugSheet` already provide a pane-modal preview for the zoom step.

#### Constraints {#constraints}

- Tuglaws: one `root.render()` [L01]; external state via `useSyncExternalStore` [L02]; appearance via CSS/DOM not React state [L06]; component-token sovereignty `--tugx-*` [L20]; store observers may write DOM [L22]; scroll/geometry preservation [L23]; stable mount identity across transitions [L26]. Cross-check `tuglaws/tuglaws.md`, `pane-model.md`, `component-authoring.md` before each tugways change and name the laws in the commit.
- WARNINGS ARE ERRORS — the Rust workspace `-D warnings`; tugdeck builds clean.
- Use `bun` (never npm); HMR is always running (no manual tugdeck builds).
- No mock-store / fake-DOM tests; pure-logic `bun:test` + real-app (`just app-test`) only.
- AskUserQuestion ≤ 4 options per question.

#### Assumptions {#assumptions}

- The blank-flash occurs only in the windowed regime (inline mode mounts every cell), so the perf fix targets `TugListView` windowing, not the inline path.
- `/devise`-as-file-atom is a completion-classification bug (namespace matching), not a missing-catalog bug — to be confirmed by a diagnostic in [#step-14].
- Streaming markdown blocks settle to a stable DOM post-`turn_complete`, so source-offset attribution for copy can attach to committed content without fighting deltas.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

Anchors are explicit and kebab-case. Plan-local decisions use `[P01]`; global decisions cited as `[D##]`. Steps cite artifacts, never line numbers.

---

### Research Notes {#research-notes}

Web research for the two design spikes (conducted during planning):

- **Markdown typography** — best-practice guidance converges on *consistency over a large size range*: differentiate heading levels primarily by weight and surrounding space, with modest size deltas, and drive every size from CSS variables for uniformity. No single canonical px set is authoritative — hence the gallery vet. Inline code: monospace + a subtle background tint; the strong foreground/background color pairing many themes ship is the legibility cost we are removing. Sources: [Google Markdown style guide](https://google.github.io/styleguide/docguide/style.html), [Styling Markdown (Bryan Hogan)](https://webdev.bryanhogan.com/miscellaneous/styling-markdown/), [MyST Typography](https://mystmd.org/guide/typography), [Markdown best practices (markdowntorichtext)](https://markdowntorichtext.com/blog/markdown-best-practices/).
- **Collapsed tool calls** — the dominant pattern is *progressive disclosure*: present a one-line summary (summary → detailed → technical) with a consistent expand/collapse affordance and remembered user preference. The collapsed state should carry the essential identifying + outcome information so the user rarely needs to expand. Sources: [Progressive Disclosure (IxDF)](https://ixdf.org/literature/topics/progressive-disclosure), [Progressive Disclosure in AI (aiuxdesign.guide)](https://www.aiuxdesign.guide/patterns/progressive-disclosure), [Progressive Disclosure UI Patterns (agentic-design.ai)](https://agentic-design.ai/patterns/ui-ux-patterns/progressive-disclosure-patterns), [Disclosure widget (Wikipedia)](https://en.wikipedia.org/wiki/Disclosure_widget).

These inform the candidate option sets the gallery cards present; the *decisions* are made by vetting in-gallery, not by adopting any single source.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Why does `/devise` classify as a file atom? (OPEN) {#q01-skill-file-atom}

**Question:** Is the `/devise`-as-file-atom defect a namespace mismatch (user types `/devise`; skill is catalogued as `tugplug:devise`), a missing-from-catalog issue, or a completion-provider ordering issue where the file-path matcher wins?

**Why it matters:** The fix differs — namespace-aware matching in the completion provider vs. seeding the catalog vs. reordering providers. Guessing wrong ships a fix that doesn't fire.

**Options (if known):**
- Namespace mismatch in `completion-providers` / `action-vocabulary` matching (most likely — skills arrive as `"tugplug:devise"`).
- Skills absent from `SessionMetadataStore` catalog at type time (would contradict the handshake merge; check the snapshot).
- File-atom provider out-prioritizes the command provider for the `/`-prefixed token.

**Plan to resolve:** [#step-14] opens with a diagnostic — log the catalog snapshot + the atom-classification path for a typed `/devise`, confirm the cause, then fix.

**Resolution:** OPEN → resolved in [#step-14].

#### [Q02] How to attribute source offsets through the rendered markdown DOM? (OPEN) {#q02-offset-attribution}

**Question:** The parser records `startOffset`/`endOffset` per *block*. To reconstruct markdown for an arbitrary DOM selection we must map a `Range` (which may start/end mid-block, mid-inline-span) back to source character offsets. At what granularity do we attribute offsets — block-level only (copy whole touched blocks), or finer (inline spans)?

**Why it matters:** Block-level is far simpler and likely good enough (selecting half a paragraph copies that paragraph's markdown); inline-level is exact but expensive and brittle against the sanitizer/highlighter DOM.

**Options (if known):**
- Block-level attribution via `data-md-start`/`data-md-end` on each rendered block element; a selection maps to the span of touched blocks, sliced from source. (Recommended starting point.)
- Inline-level offset spans (reject unless block-level proves insufficient in the gallery).

**Plan to resolve:** [#step-6] spikes block-level attribution in the gallery and the unit test; escalate to finer granularity only if the round-trip test demands it.

**Resolution:** OPEN → resolved in [#step-6]/[#step-7].

#### [Q03] Skeleton-fill appearance (OPEN) {#q03-skeleton-appearance}

**Question:** Should the never-blank backstop be a flat neutral fill at the row's reserved height, or a structural skeleton (header bar + lines)?

**Why it matters:** Flat fill is trivial and law-clean (pure CSS at the spacer/cell); structural skeleton is prettier but costs layout work per row shape.

**Options (if known):**
- Flat neutral fill matching row chrome (recommended — cheapest, satisfies the invariant).
- Per-kind structural skeleton (defer; revisit if flat fill reads as jarring during `verify`).

**Plan to resolve:** Decide during [#step-2] `verify` run; default to flat fill.

**Resolution:** OPEN → decided in [#step-2] (default flat).

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Larger overscan inflates mounted DOM, regressing the very perf it aims to fix | med | med | Directional (asymmetric) overscan biased to scroll direction, not a big symmetric bump; measure mounted count | scroll jank reappears in `verify` |
| Partial-copy serialization is brittle against sanitizer/highlighter DOM | med | med | Block-level offset attribution + round-trip unit tests; scope to touched whole blocks | round-trip test fails on real content |
| Default-collapse hides info users actually want | low | med | Single editable table [P06] + existing persisted expansion overrides; expand-state survives | user feedback after `verify` |
| Header-scale change ripples to non-transcript markdown consumers | low | med | Tokens are `--tugx-md-*`; scope overrides to `.dev-card-transcript` if the global change is too broad | gallery shows regression elsewhere |

**Risk R01: Overscan perf regression** {#r01-overscan-perf}

- **Risk:** Rendering many extra rows to avoid blanks reintroduces the commit-weight problem windowing exists to solve.
- **Mitigation:** Asymmetric overscan (large lead in the scroll direction, small trail); keep the symmetric base small; measure mounted-row count in the `verify` run.
- **Residual risk:** Extremely fast fling on a very heavy transcript may still outrun render-ahead — the skeleton backstop ([#step-2]) is what makes the invariant hold regardless.

**Risk R02: Partial-copy brittleness** {#r02-partial-copy}

- **Risk:** Mapping a DOM `Range` to source offsets fails on edge DOM (code blocks, atom chips, nested lists).
- **Mitigation:** Block-level attribution + a round-trip test corpus drawn from real assistant content; explicit handling for fenced code (copy the fence verbatim) and atom chips (reuse `formatAtomTextForCopy`).
- **Residual risk:** Inline-exact selection boundaries are widened to block boundaries — accepted ([Q02]).

---

### Design Decisions {#design-decisions}

#### [P01b] Never-blank via two-TIER rendering (SUPERSEDES the overscan+fill approach) (DECIDED) {#p01b-two-tier}

**Decision:** Achieve never-blank by decoupling *mounted* from *rich*. Every row is always mounted as a CHEAP cell — a single block of bounded plain-text preview (`previewTextForMessages`, `lib/transcript-preview.ts`): no markdown parse, no syntax highlighting, no per-tool components. Only rows in the visible window (+ a prefetch margin) upgrade to the RICH rendering, gated per-cell by an IntersectionObserver against the scrollport. The cheap↔rich swap reserves the measured height so layout never shifts.

**Why this supersedes [P01]/[P02]/[P03]'s overscan+skeleton:** in-app testing showed overscan can't cover a thumb-drag jump (the target cells are unmounted), and a skeleton fill only recolors emptiness — the user still sees no content. The blank is paint/mount latency of *expensive* content. A cheap always-painted tier paints in well under a frame, so neither windowed-unmount nor `content-visibility` paint deferral can produce a perceptible blank; rich work stays bounded to the window.

**Rationale:**
- Mounting N *cheap* cells is affordable; the ~20s freeze the plan cites was N *rich* cells. Rich rendering stays windowed.
- Removes windowed-unmount (kills thumb-drag blank) AND removes the expensive-paint-on-promote (kills the inline/content-visibility blank that hit small sessions too — confirmed both sizes blank).

**Implications:**
- New `lib/transcript-preview.ts` (DONE, pure + tested). New cheap cell component. The transcript stops windowing-by-unmount; cells tier cheap/rich via an IntersectionObserver-driven signal. Height reserved from the measured-height index.
- Steps 1–3 (overscan + skeleton) are **reverted and superseded**; the perf steps will be re-cut around this tier model once the core bet is validated live on the user's real sessions ([real-content fixtures only]).

**Risk:** mounting all cheap cells at extreme N (tens of thousands of messages). Mitigation: measure on real sessions; keep a safety window on the *cheap* layer only if extreme sizes regress.

#### [P01] Never-blank is a hard invariant via two-layer defense, in BOTH render modes (SUPERSEDED by [P01b]) {#p01-never-blank}

**Decision:** A transcript row must never expose bare card background, in **either** render mode — windowed *or* inline. Achieved by (1) render-ahead (directional, tunable overscan, windowed mode only) and (2) a skeleton backstop that paints a neutral row-rhythm fill on any reserved-but-unpainted slot, covering all three blank sources: windowed top/bottom spacers, windowed cells not yet painted, AND inline-mode cells whose paint is deferred by `content-visibility: auto`.

**Rationale:**
- Render-ahead alone can be outrun by a fast fling (R01); the backstop guarantees the invariant unconditionally.
- The blank is not only a windowing artifact. Inline mode (≤1200 rows / ≤600 messages) defers paint via `content-visibility: auto` + `contain-intrinsic-size` (`dev-card.css` `#inline-content-visibility`), so an off-screen inline cell renders as an empty intrinsic-size box — card background shows through during fast scroll exactly as a windowed spacer does. The invariant must hold in both modes or it only half-holds.

**Implications:**
- `computeWindow` gains direction-aware overscan (windowed); windowed spacers + unpainted windowed cells render a fill instead of transparency; inline `content-visibility` cells paint a neutral fill on their contained (deferred-paint) box so the intrinsic-size placeholder is never bare. All CSS/DOM-driven [L06].

#### [P02] Overscan becomes directional and delegate-tunable (DECIDED) {#p02-directional-overscan}

**Decision:** Replace the fixed symmetric `OVERSCAN_COUNT = 3` with direction-aware leading/trailing overscan, surfaced as a `TugListViewDelegate` option; the transcript opts into a larger lead.

**Rationale:** Fast scroll consumes rows in one direction; spending the render budget ahead of motion is where it pays. Keeping it a delegate option avoids hardcoding transcript policy into the primitive.

**Implications:** `ComputeWindowInput` gains `leadingOverscan`/`trailingOverscan` (or a `(direction) => count`); `TugListView` tracks scroll direction in a ref [L06]/[L22]; default preserves today's behavior for other consumers.

#### [P03] Partial-selection copy reconstructs markdown (no plain-text fallback) (DECIDED) {#p03-partial-copy}

**Decision:** Copying any selection in an assistant row yields markdown reconstructed from the parser's source offsets (block-level attribution per [Q02]), not `Selection.toString()`.

**Rationale:** The user requires honest, paste-able markdown for any selection — the explicit "do the hard work" call.

**Implications:** Rendered markdown blocks carry `data-md-start`/`data-md-end`; the cell COPY + context-menu COPY paths map the live `Range` to a source char range and slice the source markdown; atom chips reuse `formatAtomTextForCopy`; fenced code copies verbatim.

#### [P04] Compressed, weight-driven header scale (DECIDED; exact tokens gallery-vetted) {#p04-header-scale}

**Decision:** Replace the 24/20/16px `h1/h2/h3` scale with a compressed hierarchy differentiated primarily by weight and spacing (size delta ≤ ~4px across levels). Exact `--tugx-md-h*-size`/`-weight`/spacing values are chosen by vetting candidate sets in `gallery-markdown-view`.

**Rationale:** Research-backed ([#research-notes]) — large heading jumps read as crude in a dense transcript; consistency + weight differentiation is more legible.

**Implications:** `tug-markdown-view.css` token values change; if the global change over-reaches, scope via `.dev-card-transcript`.

#### [P05] Inline code de-styled for legibility (DECIDED) {#p05-inline-code}

**Decision:** Inline `code` drops the aggressive color shift; keep a subtle background tint and a restrained mono treatment optimized for reading inside prose.

**Rationale:** Current color+font change harms legibility per the hitlist and research.

**Implications:** `--tugx-md-inline-code-*` tokens retuned; vetted in the gallery alongside [P04].

#### [P06] Single per-tool collapse-default table (DECIDED) {#p06-collapse-table}

**Decision:** A single, plainly-editable map (tool kind → `defaultCollapsed: boolean`) is the source of truth for which blocks mount collapsed, applied to live *and* historical turns. **Default-collapse applies even in-flight:** a collapsed live tool block withholds its body (the streaming output) while the header keeps tracking phase via its lifecycle dot (in-flight → success/error). The user opts these noisy tools into "I don't need to watch them," so hiding the streaming body is the intended behavior, not a regression.

**Rationale:** The user asked for a simple table to flip defaults per tool; centralizing also removes the scattered `defaultFolded` idioms. The header (not the body) carries the phase signal, so a collapsed in-flight block still shows liveness.

**Implications:**
- A new `tool-collapse-defaults.ts` map; the dispatch site reads it (replacing `historyCollapsed === true`-only gating); per-block `defaultFolded` props defer to the table.
- **[L26] mount identity:** the dispatch site currently branches `wrapped : unwrapped`; with the table it **always** wraps a noisy block in `ToolBlockHistoryCollapse`, so the React key moves to the wrapper. For a given turn the wrapping is stable across the live→committed transition (a live turn's wrap policy is table-derived from kind, which never changes), so mount identity holds and no remount/scroll-jump occurs. Step 9 verifies a live Bash that streams-then-collapses does not remount.

#### [P07] Default-collapse seed set (DECIDED) {#p07-collapse-seed} 

**Decision:** Seed the table to collapse **Read, Grep, Glob, Bash, Edit, Write**; leave **skill, task/agent (Task/Agent), question (AskUserQuestion), web (WebFetch/WebSearch)** expanded.

**Rationale:** The first set is the noisy file/shell I/O; the second carries content the user is actively reading.

**Implications:** Encoded as the initial values in the [P06] table; trivially changed.

#### [P08] Error coloring is header-only (DECIDED) {#p08-error-header-only}

**Decision:** An errored tool block colors only the header region red (dot/name/exit-code), never the entire body.

**Rationale:** All-red bodies are unreadable and overweight the error.

**Implications:** Error color token moves from the body container to the header; body keeps neutral surface tokens [L20].

#### [P09] Collapsed header carries essentials (DECIDED; redesign gallery-vetted) {#p09-collapsed-header}

**Decision:** The collapsed tool-block header conveys, at a glance, tool + target + a one-line result summary (e.g. "110 lines", "13 matches", "exit 1"), at a legible font size (no tiny meta text). The exact layout is vetted in a new collapsed-tool-block gallery card.

**Rationale:** Progressive disclosure ([#research-notes]) — the collapsed state should answer "what did this do?" without expanding.

**Implications:** `ToolCallHeader` meta cluster + a new collapsed-summary slot; `tool-call-header.css` font sizing bumped; result summaries computed per tool from existing result metadata.

**Resolved ([#step-10], gallery `gallery-tool-block-collapsed`, commit `17ef7cb6`):** the vetted design is the **Quiet Line** —
- **Layout:** one calm row per tool — lifecycle dot, per-tool icon, tool name, target detail (path → basename, command → full), one-line result summary, then the affordances. Color comes only from the lifecycle dot. A long detail **wraps to more rows** (no truncation), while the dot, icon, summary, and affordances stay pinned to the **top row**. Columns are disciplined by a grid: the flow defines the column tracks and each row is a `subgrid`, so the result summary and the affordances hold aligned columns across every row while the detail wraps within its own flexible column. In-flight calls (no result yet) keep an empty result cell so alignment holds.
- **Affordances — exactly two, always visible: Copy + Expand.** Uniform across all tools (no per-tool button set — it would reintroduce the noise the Quiet Line removes). The lifecycle **dot** carries status; the path/URL **chip** carries "open." The Expand chevron points **down** to expand (up to collapse). Tool-specific richness (open file, follow URL, sub-copies) lives in the **expanded body** via the existing body-kind affordance portal / clickable chips — never the collapsed bar.
- **Copy payload = command + result, always** — independent of collapsed/expanded state (tying the clipboard to a transient view state is too clever / surprising). Wired via the existing `toolCallToMarkdown(call)` serializer, so collapsed-Copy, expanded-Copy, and selection-copy all yield identical markdown — one source of truth.

#### [P10] Skill slash-commands classify as command atoms (DECIDED) {#p10-skill-atoms}

**Decision:** Typing a skill name (`/devise`) in the dev prompt entry produces a slash-command atom that routes to claude, not a file atom — by namespace-aware matching against the merged catalog ([Q01]).

**Rationale:** Skills are first-class slash commands; misclassification breaks invocation.

**Implications:** Completion/classification matches `/<name>` against catalogued `<namespace>:<name>` entries; the exact site is confirmed in [#step-14].

#### [P11] Skill argument placeholder slots (DECIDED) {#p11-skill-placeholders}

**Decision:** After accepting a skill command atom that takes arguments, the prompt entry shows placeholder completion slots for those arguments.

**Rationale:** The hitlist asks for it; skills like `/devise` take a free-text idea + output path.

**Implications:** Additive completion-layer feature; depends on the catalog exposing (or the client inferring) an argument hint.

#### [P12] Enlarged image previews with click-to-zoom (DECIDED) {#p12-image-previews}

**Decision:** `TugAttachmentStrip` thumbnails render substantially larger; clicking opens the existing `DevAttachmentPreview` zoom sheet.

**Rationale:** Tiny thumbnails are worthless per the hitlist; the zoom path already exists.

**Implications:** Thumbnail sizing tokens bumped; click handler already wired in the user cell (`handleAttachmentClick`).

---

### Specification {#specification}

#### Partial-copy design {#partial-copy-design}

**The hard reality: an assistant row is NOT one markdown string.** Per `CodeRowBody` (`dev-card-transcript.tsx`), a row interleaves a *sequence* of heterogeneous blocks — multiple `TugMarkdownBlock`s (one per `assistant_text` message, each with its own `streamingPath` source string), `DevThinkingBlock`s, and **tool blocks** between them. A user selection can run prose → Bash block → more prose. There is no single source string to substring; reconstruction must walk the selection across the heterogeneous sequence and stitch per-block markdown in document order. This is the genuinely hard part [P03] commits to.

The markdown parser (`parse-markdown-to-sanitized-blocks.ts`) emits, per markdown block, `startOffset`/`endOffset` (JS string indices into *that message's* source text), and `buildBlockElement` (`render-incremental.ts`) is the single point where the `.tugx-md-block` wrapper is constructed. Pipeline:

1. **Attribution** — `buildBlockElement` stamps `data-md-start`/`data-md-end` on each `.tugx-md-block` wrapper (the source range *within its message* it was produced from). The wrapper also already sits under a per-message container whose streaming path identifies the source string.
2. **Selection walk** — on copy, read the live `Selection`; enumerate the top-level transcript blocks it touches **in document order** (markdown blocks, thinking blocks, tool blocks alike), clipping the first and last to the selection boundary.
3. **Per-block markdown** — emit markdown for each touched block:
   - *markdown block*: map the touched `Range` portion to `[start, end]` via the nearest `data-md-*` ancestor (block-level per [Q02]); slice that message's source string. Atom chips inside the span serialize via `formatAtomTextForCopy`; fenced code is included verbatim.
   - *tool block fully/partly inside the selection*: serialize it through the same per-tool markdown path `turnEntryToMarkdown` already uses (reuse, don't reinvent).
   - *thinking block*: include as the transcript already represents it for copy, or omit per the full-row convention — match `turnEntryToMarkdown`.
4. **Stitch** — join the per-block markdown in order with the same inter-block spacing `turnEntryToMarkdown` uses, so a whole-row selection reproduces the full-row COPY output exactly.
5. **Full-row path** — the COPY button writes `turnEntryToMarkdown(turn)` (already markdown), unchanged; the partial path is the selection-scoped generalization of it.

**Pure/DOM split for tests** ([Q02], Steps 6–7): the offset arithmetic — given a touched block's `{start, end}` and the selection's clipped char positions → the source slice range, and the order-preserving stitch of per-block strings — is pure and `bun:test`-able. The DOM-dependent part — resolving a live `Selection`/`Range` to the ordered set of touched blocks and their clip positions — is verified via `just app-test`. No fake DOM.

#### Inline-mode paint deferral {#inline-content-visibility}

Below the windowed thresholds the transcript mounts every cell but defers off-screen *paint* via `content-visibility: auto` + `contain-intrinsic-size` (`dev-card.css`). An off-screen inline cell therefore renders as an empty intrinsic-size box with no painted content — bare card background shows through during fast scroll, the same visual defect as a windowed spacer. The never-blank invariant ([P01]) covers this leg by painting a neutral fill behind the cell so the deferred-paint box is never transparent. This path has no `computeWindow` and no spacers, so Step 1's overscan does nothing here — only Step 2's fill closes it.

#### State Zone Mapping (tugdeck/tugways) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| scroll direction / last scrollTop | appearance/local-data | `useRef` + DOM read in scroll handler | [L06], [L22] |
| leading/trailing overscan config | structure (prop/delegate) | prop value, no runtime state | — |
| skeleton-fill visibility (windowed spacer + unpainted cell) | appearance | CSS + DOM driven by height index / painted flag | [L06] |
| inline `content-visibility` cell fill (deferred-paint box) | appearance | CSS-only neutral fill behind the cell | [L06] |
| per-tool collapse-default table | structure (constant) | pure module map, no state | — |
| live-turn collapse boolean | local-data | `useState` + `ToolBlockExpansionState` write-through, [A9]-persisted | [L24], [L26] |
| selection→markdown copy result | transient (event-handler local) | computed in COPY handler, no persistent state | [L07] |
| `data-md-start`/`-end` attribution | appearance/structure | DOM attributes on rendered blocks | [L06] |
| markdown header / inline-code tokens | appearance | `--tugx-md-*` CSS tokens | [L20] |
| collapsed-header result summary | appearance | derived from result metadata, rendered in header | [L02] |
| skill command atoms / argument slots | derived | `useSyncExternalStore` over `SessionMetadataStore` catalog | [L02] |
| image-preview zoom sheet | structure | existing `useTugSheet` | — |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (bun:test)** | Pure logic — windowing math, Range→markdown mapping, collapse-table resolution, summary formatting | Every pure transform below |
| **Real-app (`just app-test`)** | Behavior in the running app — scroll-no-blank, skill atom classification, image zoom | Steps whose proof is visual/interactive |
| **Gallery vet** | Human design judgment on candidate token/layout sets | The two design spikes |

#### What stays out of tests {#test-non-goals}

- No mock-store assertion or fake-DOM render tests (banned). Windowing/copy logic is tested as pure functions; visual outcomes are tested via `just app-test` / gallery, not jsdom.
- We do not test the exact px values of the vetted typography — those are design decisions, not invariants; we test that the tokens are applied and that the scale is compressed (delta bound).

---

### Execution Steps {#execution-steps}

> Commit after all checkpoints pass. Cross-check the cited tuglaws and name them in each tugways commit.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Two-tier render: cheap preview tier ([P01b]; replaced overscan) | done | c9effaa8 |
| #step-2 | Two-tier render: all-mounted + IntersectionObserver rich window ([P01b]; replaced skeleton) | done | c9effaa8 |
| #step-3 | Perf integration checkpoint — blanks "greatly improved", user-verified in app | done | c9effaa8 |
| #step-4 | Markdown typography spike + gallery vet (Transcript Markdown card) | done | e79d4685 |
| #step-5 | Apply header scale + inline-code tokens + wrapper spacing model | done | e79d4685 |
| #step-6 | Source-offset attribution on rendered blocks | done | 29c80f73 |
| #step-7 | Range→markdown copy reconstruction | done | dd95862f |
| #step-8 | Markdown integration checkpoint | done | N/A (verify) |
| #step-9 | Per-tool collapse-default table | done | 2b49b3bc |
| #step-10 | Collapsed-header redesign spike + gallery vet | done | 17ef7cb6 |
| #step-11 | Apply collapsed-header redesign + font sizing | done | 51a18308 |
| #step-12 | Error coloring = header-only | done | dfe9766d |
| #step-13 | Tool-block integration checkpoint | done | N/A (verify) |
| #step-14 | Fix skill slash-command classification | done | 9291eda7 |
| #step-15 | Skill argument placeholder slots | done | a431d817 |
| #step-16 | Enlarge image previews + click-to-zoom | done | 2a5ceb22 |
| #step-17 | Phase integration checkpoint | done | N/A (verify) |

---

#### Step 1: Directional + tunable overscan {#step-1}

**Commit:** `feat(tugways): direction-aware tunable overscan in TugListView windowing [L06][L22]`

**References:** [P01] Never-blank, [P02] Directional overscan, Risk R01, (#strategy, #p02-directional-overscan)

**Artifacts:**
- `internal/list-view-window.ts` — `ComputeWindowInput` gains `leadingOverscan`/`trailingOverscan`.
- `tug-list-view.tsx` — scroll-direction ref; delegate option for overscan; transcript delegate opts into a larger lead.

**Tasks:**
- [ ] Generalize `computeWindow` to apply asymmetric overscan keyed on scroll direction; default both to the current `3` so other consumers are byte-identical.
- [ ] Track scroll direction (last `scrollTop` delta) in a ref in the scroll handler [L06]/[L22]; thread direction → overscan selection.
- [ ] Add `overscanForKind`/`leadingOverscan` to `TugListViewDelegate` (optional, defaulting to today's value); wire the transcript delegate in `dev-card-transcript.tsx` to a larger lead.

**Tests:**
- [ ] `list-view-window` unit tests: leading > trailing widens the window in the scroll direction; clamps at `[0, itemCount)`; symmetric defaults reproduce existing snapshots.

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/__tests__/rendered-block-window.test.ts src/lib/__tests__` (or the window test file) passes.
- [ ] `bunx tsc --noEmit` clean (warnings-as-errors).

---

#### Step 2: Never-blank skeleton backstop (both render modes) {#step-2}

**Depends on:** #step-1

**Commit:** `feat(tugways): skeleton fill so windowed AND inline rows never expose bare background [L06]`

**References:** [P01] Never-blank (both modes), [Q03] Skeleton appearance, Risk R01, (#p01-never-blank, #q03-skeleton-appearance, #inline-content-visibility)

**Artifacts:**
- `tug-list-view.css` — windowed top/bottom spacer + unpainted-cell neutral fill (row-rhythm), CSS-only [L06].
- `tug-list-view.tsx` — mark spacers/cells so the fill applies until content paints (reuse the `min-height` lock + a painted flag).
- `dev-card.css` — give the inline-mode `content-visibility: auto` cell a neutral fill on its contained (deferred-paint) box so the `contain-intrinsic-size` placeholder is never bare. This is the inline-mode leg of the invariant ([#inline-content-visibility]).

**Tasks:**
- [ ] Windowed: give top/bottom spacers a neutral fill (not transparent) so scrolled-past-but-unmounted regions never read as card background.
- [ ] Windowed: for a cell in the window whose content has not yet painted, render a flat neutral fill at its reserved height ([Q03] default flat).
- [ ] Inline: paint the same neutral fill behind `content-visibility: auto` cells so the deferred-paint intrinsic-size box shows row-rhythm fill, not card background.
- [ ] Confirm the fill clears the moment real content paints (no lingering skeleton over content), in both modes.

**Tests:**
- [ ] Unit: a pure helper deciding "fill vs content" from (measured height, painted flag) — table-driven.

**Checkpoint:**
- [ ] `just app-test` / `verify` windowed scenario — fast-scroll a >1200-row transcript; assert no frame shows bare card background. Record `VERDICT: PASS|FAIL`.
- [ ] `just app-test` / `verify` inline scenario — fast-scroll a <600-message transcript (the `content-visibility` path); assert no bare background. Record `VERDICT: PASS|FAIL`.
- [ ] Decide [Q03] (default flat) and note it in the commit.

---

#### Step 3: Perf integration checkpoint {#step-3}

**Depends on:** #step-1, #step-2

**Commit:** `N/A (verification only)`

**References:** [P01], [P02], Risk R01, (#success-criteria)

**Tasks:**
- [ ] Verify render-ahead + backstop together hold the never-blank invariant under fast fling on a heavy real session; confirm mounted-row count has not ballooned (R01).

**Tests:**
- [ ] `verify` skill run: scroll at speed, screenshot, confirm no blank flashes.

**Checkpoint:**
- [ ] Manual `verify` PASS recorded; mounted-row count sane.

---

#### Step 4: Markdown typography spike + gallery vet {#step-4}

**Commit:** `feat(gallery): markdown typography candidate token sets for vetting [L20]`

**References:** [P04] Header scale, [P05] Inline code, (#research-notes, #p04-header-scale, #p05-inline-code)

**Artifacts:**
- `gallery-markdown-view.tsx` — extended with 2–3 candidate `--tugx-md-*` token sets (header scale + inline-code treatments) side-by-side over representative content (headers h1–h3, inline code in prose, fenced code, lists).

**Tasks:**
- [ ] Author candidate token sets informed by [#research-notes] (compressed, weight-driven scale; subtle inline-code tint).
- [ ] Render them in the gallery against real-shaped markdown; vet and pick the winning set.

**Tests:**
- [ ] Gallery renders without console errors; tugDevLog clean.

**Checkpoint:**
- [ ] Gallery card shows the candidates; chosen token values recorded in the commit body for [#step-5].

---

#### Step 5: Apply header scale + inline-code tokens {#step-5}

**Depends on:** #step-4

**Commit:** `style(tugways): compressed markdown header scale + de-styled inline code [L20]`

**References:** [P04] Header scale, [P05] Inline code, (#p04-header-scale, #p05-inline-code)

**Artifacts:**
- `tug-markdown-view.css` — `--tugx-md-h*-size/-weight`, heading spacing, `--tugx-md-inline-code-*` retuned to the vetted values (scope to `.dev-card-transcript` if the global change over-reaches per R-note).

**Tasks:**
- [ ] Apply chosen tokens; verify transcript + any other markdown consumers in the gallery for regressions.

**Tests:**
- [ ] Assert (pure/CSS-level) the header size delta across h1–h3 is within the compressed bound (≤ ~4px).

**Checkpoint:**
- [ ] Transcript renders the new scale; `verify`/gallery shows compressed, legible headers and subtle inline code.

---

#### Step 6: Source-offset attribution on rendered blocks {#step-6}

**Depends on:** #step-5

**Commit:** `feat(tugways): attribute source markdown offsets onto rendered blocks for copy [L06]`

**References:** [P03] Partial copy, [Q02] Offset attribution, Spec (#partial-copy-design)

**Artifacts:**
- `lib/markdown/render-incremental.ts` — `buildBlockElement` stamps `data-md-start`/`data-md-end` on the `.tugx-md-block` wrapper from the block's existing `startOffset`/`endOffset`. This is the single construction point for every markdown surface (both `TugMarkdownBlock` modes and `TugMarkdownView` route through it), so attribution lands once here, not in the view/block components.
- `lib/markdown/selection-to-markdown.ts` (new) — the **pure** offset arithmetic: given a touched block's `{start, end}` + clipped selection char positions → source slice range, and the order-preserving stitch of per-block strings.

**Tasks:**
- [ ] Stamp `data-md-start`/`data-md-end` in `buildBlockElement` (the reconciler preserves wrapper identity across deltas, so attributes persist).
- [ ] Author the pure `selection-to-markdown` arithmetic (slice-range + stitch); keep it DOM-free so it is `bun:test`-able.

**Tests:**
- [ ] Unit (`bun:test`, pure): slice-range for several clip shapes (mid-block start, mid-block end, whole block); order-preserving stitch of a heterogeneous block list. **No DOM in this test** — the `Range`→touched-blocks resolution is tested in Step 7 via `just app-test`, per the [Q02] pure/DOM split.

**Checkpoint:**
- [ ] `cd tugdeck && bun test` for `selection-to-markdown` passes; `data-md-*` attributes visible on `.tugx-md-block` wrappers in the gallery DOM.

---

#### Step 7: Range→markdown copy reconstruction {#step-7}

**Depends on:** #step-6

**Commit:** `feat(tugways): copy reconstructs markdown across a selection's blocks, not plain text [L07]`

**References:** [P03] Partial copy, Risk R02, Spec (#partial-copy-design), (#partial-copy-design)

**Artifacts:**
- `lib/markdown/range-to-blocks.ts` (new) — the **DOM-dependent** half: resolve a live `Selection`/`Range` → the ordered set of touched top-level transcript blocks (markdown / thinking / tool) + the clip char-positions for the first/last markdown block.
- `dev-card-transcript.tsx` `useTranscriptCellMenu.handleCopy` (+ keyboard COPY) — replace `selection.toString()` with: `range-to-blocks` → per-block markdown (markdown blocks via the pure `selection-to-markdown` slice over their message source; tool blocks via the `turnEntryToMarkdown` per-tool path) → stitch in order.

**Tasks:**
- [ ] Implement `range-to-blocks` walking touched blocks in document order across the heterogeneous sequence ([#partial-copy-design]).
- [ ] Wire the cell COPY + context-menu COPY through the reconstruction; keep the full-row COPY button on `turnEntryToMarkdown` (the whole-row selection must reproduce it exactly).
- [ ] Source-text access: each markdown block's source is its message's streaming-path value; thread the per-message sources + the tool-block serializer into the handler.

**Tests:**
- [ ] Round-trip unit (`bun:test`, pure): a stitched per-block markdown list re-parses (`parse-markdown-to-sanitized-blocks`) to the expected block structure across the R02 corpus (paragraph, list, fenced code, inline code, atom chip, prose→tool-block→prose).
- [ ] Real-app (`just app-test`): select sub-ranges in a live transcript (within one block, across blocks, across a tool block), copy, and assert the clipboard markdown matches expectation — this exercises the `range-to-blocks` DOM walk that `bun:test` cannot. Recipe ends with `VERDICT: PASS|FAIL`.

**Checkpoint:**
- [ ] `cd tugdeck && bun test` round-trip passes; `just app-test` selection cases PASS; manual paste into the prompt entry reproduces formatting.

---

#### Step 8: Markdown integration checkpoint {#step-8}

**Depends on:** #step-5, #step-6, #step-7

**Commit:** `N/A (verification only)`

**References:** [P03], [P04], [P05], (#success-criteria)

**Tasks:**
- [ ] Verify rendering (scale + inline code) and copy (full + partial) together on a real session.

**Tests:**
- [ ] `verify`: select sub-ranges, copy, paste into prompt entry → correct markdown; headers/inline code legible.

**Checkpoint:**
- [ ] `verify` PASS recorded.

---

#### Step 9: Per-tool collapse-default table {#step-9}

**Depends on:** #step-3

**Commit:** `feat(tugways): single per-tool collapse-default table; collapse noisy tools live+historical [L24][L26]`

**References:** [P06] Collapse table, [P07] Seed set, (#p06-collapse-table, #p07-collapse-seed)

**Artifacts:**
- `tool-blocks/tool-collapse-defaults.ts` — the editable map (kind → `defaultCollapsed`), seeded per [P07].
- `dev-card-transcript.tsx` `CodeRowBody` — wrap top-level tool blocks in `ToolBlockHistoryCollapse` with `defaultCollapsed` from the table (live *and* historical), not only `turn.replayed`.

**Tasks:**
- [ ] Add the table with [P07] seed; export a `collapseDefaultFor(kind)` resolver.
- [ ] Replace the `historyCollapsed === true`-only gating so live noisy blocks also default-collapse; **always** wrap noisy kinds in `ToolBlockHistoryCollapse` so the wrap policy is kind-stable across the live→committed transition ([P06] [L26]).
- [ ] Migrate scattered `defaultFolded` props to defer to the table.

**Tests:**
- [ ] Unit: `collapseDefaultFor` returns the seeded values; unknown kinds default expanded.

**Checkpoint:**
- [ ] `bun test` passes; live Read/Grep/Bash blocks mount collapsed in the gallery/`verify`; skill/task/question/web stay expanded.
- [ ] `verify`: a **live, in-flight Bash** streams to completion then settles collapsed with **no remount and no scroll jump** ([P06] [L26]) — the header dot tracks in-flight → success the whole time.

---

#### Step 10: Collapsed-header redesign spike + gallery vet {#step-10}

**Depends on:** #step-9

**Commit:** `feat(gallery): collapsed tool-block header redesign candidates [L20]`

**References:** [P09] Collapsed header, (#research-notes, #p09-collapsed-header)

**Artifacts:**
- `gallery-tool-block-collapsed.tsx` (new) — candidate collapsed-header layouts across Read/Grep/Bash/Edit, showing tool + target + one-line result summary at legible sizes.

**Tasks:**
- [ ] Author 2–3 collapsed-header layouts (per [#research-notes] progressive disclosure); vet and pick.
- [ ] Define the per-tool result-summary strings (lines, matches, exit code, diff stat).

**Tests:**
- [ ] Gallery renders cleanly.

**Checkpoint:**
- [ ] Winning layout + summary formats recorded for [#step-11].

---

#### Step 11: Apply collapsed-header redesign + font sizing {#step-11}

**Depends on:** #step-9, #step-10

**Commit:** `feat(tugways): redesigned collapsed tool-block header with result summary [L20]`

**References:** [P09] Collapsed header, (#p09-collapsed-header)

**Artifacts:**
- `tool-call-header.tsx` / `tool-call-header.css` — collapsed-summary slot; bump tiny meta font sizes to legible.
- Per-tool blocks (`read`/`grep`/`glob`/`bash`/`edit`/`write`) — feed the result summary into the header meta/summary slot.

**Tasks:**
- [ ] Implement the vetted collapsed header; compute each tool's one-line summary from existing result metadata.
- [ ] Raise header meta font sizing per [P09].

**Tests:**
- [ ] Unit: per-tool summary formatters (e.g. `"Showing 110 of 5388 lines"` → `"110 lines"`).

**Checkpoint:**
- [ ] Collapsed blocks show tool + target + summary legibly in `verify`/gallery.

---

#### Step 12: Error coloring = header-only {#step-12}

**Depends on:** #step-11

**Commit:** `fix(tugways): color only the header on errored tool blocks, not the body [L06][L20]`

**References:** [P08] Error header-only, (#p08-error-header-only)

**Artifacts:**
- `tool-block-chrome.css` / `tool-call-header.css` — move error color token to the header region; body keeps neutral surface.

**Tasks:**
- [ ] Locate the body-wide error color application; scope it to the header (dot/name/exit-code).

**Tests:**
- [ ] CSS/DOM assertion (or gallery visual): the body container carries no error color token when `phase==="error"`.

**Checkpoint:**
- [ ] An errored Bash block shows a red header and a neutral, readable body in the gallery/`verify`.

---

#### Step 13: Tool-block integration checkpoint {#step-13}

**Depends on:** #step-9, #step-11, #step-12

**Commit:** `N/A (verification only)`

**References:** [P06], [P08], [P09], (#success-criteria)

**Tasks:**
- [ ] Verify collapse-by-default, collapsed-header info density, and header-only error together on a real session.

**Tests:**
- [ ] `verify`: noisy blocks collapsed + informative; errors header-only.

**Checkpoint:**
- [ ] `verify` PASS recorded.

---

#### Step 14: Fix skill slash-command classification {#step-14}

**Depends on:** #step-3

**Commit:** `fix(tugways): classify skill slash-commands as command atoms, not file atoms [L02]`

**References:** [P10] Skill atoms, [Q01] Skill file-atom, (#q01-skill-file-atom)

**Artifacts:**
- `completion-providers/*` / `action-vocabulary.ts` / `slash-supported.ts` — namespace-aware matching of `/<name>` against catalogued `<namespace>:<name>` entries (exact site per the diagnostic).

**Tasks:**
- [ ] Diagnostic first: log the `SessionMetadataStore` catalog snapshot and the atom-classification path for a typed `/devise`; confirm [Q01].
- [ ] Fix per the confirmed cause (namespace-aware match is the hypothesis); ensure `/devise` and peers produce a command atom routed to claude.

**Tests:**
- [ ] Unit: classification of `/devise` against a catalog containing `tugplug:devise` → command atom (not file atom).

**Checkpoint:**
- [ ] `just app-test` / `verify`: typing `/devise` in the dev prompt entry yields a slash-command atom and invokes the skill.

---

#### Step 15: Skill argument placeholder slots {#step-15}

**Depends on:** #step-14

**Commit:** `feat(tugways): placeholder argument slots after a skill command atom [L02]`

**References:** [P11] Skill placeholders, (#p11-skill-placeholders)

**Artifacts:**
- Prompt-entry completion layer — after accepting an argument-taking skill atom, render placeholder slot(s) for its arguments.

**Tasks:**
- [ ] Surface an argument hint (from catalog metadata if present; else a generic free-text slot); render placeholder completion slots.

**Tests:**
- [ ] Unit: given a skill atom with an argument hint, the completion layer emits the expected placeholder slot model.

**Checkpoint:**
- [ ] `verify`: accepting `/devise` shows an argument placeholder slot.

---

#### Step 16: Enlarge image previews + click-to-zoom {#step-16}

**Depends on:** #step-3

**Commit:** `feat(tugways): enlarge transcript image thumbnails with click-to-zoom [L20]`

**References:** [P12] Image previews, (#p12-image-previews)

**Artifacts:**
- `tug-attachment-strip` (CSS/TSX) — substantially larger thumbnail sizing tokens; confirm the existing `handleAttachmentClick` → `DevAttachmentPreview` zoom path fires.

**Tasks:**
- [ ] Bump thumbnail size tokens to a useful size; verify click opens the zoom sheet.

**Tests:**
- [ ] Visual/gallery: `gallery-attachment-strip` shows the enlarged thumbnails.

**Checkpoint:**
- [ ] `verify`: thumbnails are usefully large; clicking opens the zoom preview.

---

#### Step 17: Phase integration checkpoint {#step-17}

**Depends on:** #step-3, #step-8, #step-13, #step-15, #step-16

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] End-to-end `verify` over a real heavy session: no blank flashes; legible markdown; markdown copy (full + partial); collapsed noisy blocks with informative headers; header-only errors; working skill commands + placeholders; enlarged image previews.

**Tests:**
- [ ] Full `verify` pass; `cd tugdeck && bun test` green; `bunx tsc --noEmit` clean.

**Checkpoint:**
- [ ] All success criteria ([#success-criteria]) verified PASS.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A dev-card transcript that scrolls without blank flashes, renders beautiful legible markdown, copies real markdown for any selection, presents tool calls as quiet collapsed-by-default blocks with informative headers and header-only error coloring, invokes skills via proper command atoms with argument placeholders, and shows usefully large, zoomable image previews.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Never-blank invariant holds under fast scroll ([#step-3]).
- [ ] Markdown scale compressed + inline code de-styled, gallery-vetted ([#step-5]).
- [ ] Partial + full selection copy yields markdown ([#step-7]).
- [ ] Noisy tools collapse by default via the editable table; collapsed headers informative; errors header-only ([#step-13]).
- [ ] Skill slash-commands classify correctly + show argument placeholders ([#step-15]).
- [ ] Image previews enlarged + zoomable ([#step-16]).
- [ ] `bun test` green, `tsc` clean, `verify` PASS ([#step-17]).

**Acceptance tests:**
- [ ] Windowing unit tests (overscan direction, fill helper).
- [ ] Range→markdown round-trip tests.
- [ ] Collapse-table + summary-formatter unit tests.
- [ ] Skill-classification unit test.
- [ ] `verify` app runs per integration checkpoint.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Inline-level (sub-block) offset attribution if block-level partial copy proves too coarse ([Q02]).
- [ ] Per-kind structural skeletons if flat fill reads as jarring ([Q03]).
- [ ] Extending the collapse-default table to a user-facing preference.

| Checkpoint | Verification |
|------------|--------------|
| Never-blank | `verify` fast-scroll, no bare background |
| Markdown copy | round-trip `bun test` + manual paste |
| Collapse + headers | gallery + `verify` |
| Skills | `verify` typing `/devise` |
| Images | `verify` thumbnail + zoom |
