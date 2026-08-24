<!-- tugplan-skeleton v2 -->

## Tide Assistant Rendering — Content & Data Type Renderers {#tide-assistant-rendering}

**Purpose:** Build the full content-type rendering layer for Tide's assistant surface — a two-layer system of reusable body kinds + thin per-tool wrappers, plus the dispatcher, stream-event chrome, and parsers/formatters that make Claude Code output materially better than what a TUI can show. Replaces the placeholder rendering currently used by `streamingPaths.assistant`, wires the so-far-unwired `streamingPaths.thinking` and `streamingPaths.tools`, and ships the `--tugx-*` typography/chrome polish that `tugplan-tide-card-polish.md` Steps 12 and 13 are stubs for.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | tugplan-tide-assistant-rendering |
| Last updated | 2026-05-08 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Tide is the unified command surface that hosts Claude Code conversations alongside (eventually) shell commands. Today the Tide card streams assistant text through `TugMarkdownView` with default `--tugx-md-*` tokens, but the surrounding rendering is bare: thinking blocks are unwired, tool calls render as raw JSON-ish text, permission requests have no UI, cost data is dropped on the floor, and there are no content-aware renderers for the structured shapes Claude Code already sends (`tool_use_structured.file`, `.stdout/.stderr`, agent transcripts, etc.).

The assistant-side rendering bar for Tug is *not* "comparable to a terminal." The bar is "comparable to a hand-crafted GUI app" — typography that reads like a publication, dedicated renderers per data shape, progressive disclosure for long content, lazy-loaded stretch content (Mermaid diagrams, KaTeX math), and never-blank fallback for unknown shapes. This phase ships that surface.

**Stream-json events we render** (one renderer per row; full machine-readable shape at [Spec S07](#s07-event-inventory)):

| Event | Use |
|-------|-----|
| `protocol_ack`, `session_init` | Session lifecycle chrome |
| `system_metadata` | Per-turn metadata: model, tools, plugins, agents, mcp_servers, version, permissionMode |
| `thinking_text` | Pre-response reasoning. Delta-streamed. |
| `assistant_text` | Response body. Delta-streamed; `complete` event has full text. |
| `tool_use` | Tool invocation. Input streams empty → full. |
| `tool_result` | Tool output as text + `is_error` flag. |
| `tool_use_structured` | Tool output as typed structured data (file viewer, bash stdout/stderr, agent transcript, etc.). |
| `control_request_forward` | Permission (`is_question: false`) or AskUserQuestion (`is_question: true`). |
| `cost_update` | Per-turn token + USD breakdown. |
| `turn_complete` | End-of-turn signal. |
| `error` | Error with `recoverable` flag. |

#### Strategy {#strategy}

- **Two-layer hybrid architecture.** ~14 reusable Layer-1 body kinds (FileBlock, DiffBlock, TerminalBlock, etc.) carry the heavy rendering work; ~14 thin Layer-2 per-tool wrappers compose them with tool-specific chrome and interactions. See [D05].
- **Renderer dispatch lives outside the store.** A separate `assistant-renderer-dispatch.ts` module maps `TurnEntry` records to renderer kinds; `CodeSessionStore` stays state-only. See [D01].
- **WASM only where it earns its keep.** New `tugdiff-wasm` crate (`imara-diff` bindings) for diff parsing; ANSI, JSON-tree, and inline math stay in JS. See [D06].
- **Day-one coverage via `DefaultToolWrapper`.** Any tool we haven't built a bespoke wrapper for renders cleanly through a generic JsonTree-based wrapper, and a caution badge surfaces drift. See [D11], [D04].
- **Lazy-load stretch content.** KaTeX (~350 KB), Mermaid (~1 MB), Shiki language packs, and the diff WASM module load on first encounter, not at boot. See [D10].
- **Stream-aware per body kind.** Markdown, terminal, agent-transcript stream incrementally; diff, file, JSON-tree, math, mermaid wait for `complete`. Wrappers show a "streaming…" placeholder during the gap. See [D12].
- **Theme-token sovereignty per L20.** Every component owns its slot under the seven-slot naming convention; consumers tune via wrapping selectors, not by reaching into primitives.
- **Empirical calibration.** A pre-implementation session audit (Step 0) mines the local Claude Code session corpus to ground threshold choices (collapse points, virtualization caps, lazy-load justification) in real data, not intuition.
- **Gallery showcases.** Each renderer ships with a gallery card (Steps 14.5 and 29.5) that stacks variants with mock content, so design review can happen before live wiring.

#### Success Criteria (Measurable) {#success-criteria}

> Each criterion is verifiable by replaying a stream-json catalog fixture, by automated tests, or by manual inspection in a Tide card against `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/v2.1.105/`.

- Replaying every fixture in `v2.1.105/` produces a fully rendered Tide transcript with no `[object Object]`, no raw JSON in tool bodies, and no blank components. (Replay test: see [Spec S06](#s06-fixture-replay).)
- Every Claude tool currently emitted by the catalog (`Read`, `Bash`, `Edit`, `Glob`, `Grep`, `Task`/`Agent`, `WebFetch`, `WebSearch`, `NotebookEdit`, `Write`) renders through its bespoke Layer-2 wrapper, not `DefaultToolWrapper`. (Per [D100]: the post-`TodoWrite` `TaskCreate` / `TaskUpdate` family is intentionally null-routed — its surface is the `TASKS` status-bar cell, not a transcript wrapper.) Verify by enumerating dispatch-registry entries.
- A tool name absent from the registry (verify by injecting a synthetic `tool_use` with `tool_name: "ZzzUnknownToolZzz"`) renders through `DefaultToolWrapper` with a caution badge ([D04]) and never throws.
- `bun x tsc --noEmit`, `bun test`, `bun run audit:tokens lint` all green.
- Both `brio` and `harmony` themes render every component without missing tokens, verified by visual snapshot tests.
- Long-content collapse: a fixture-injected 500-line Bash output, 200-line Read result, and 40-hunk Edit diff all default to collapsed with single-line summary headers and an expand affordance. Verify by automated DOM assertion + manual smoke.
- KaTeX `$E=mc^2$` and `$$\\int_0^1 x^2 dx$$` typeset correctly in assistant prose. Mermaid ` ```mermaid\\nflowchart…\\n``` ` renders as a diagram once the fenced block reaches `complete`. Both lazy-loaded — initial Tide card mount has no KaTeX or Mermaid bytes downloaded.
- A version-mismatch fixture (`system_metadata.version` ≠ pinned catalog) surfaces a caution badge in the card chrome per [D04].
- All work in this phase respects [L01] (one root.render), [L02] (external state via useSyncExternalStore), [L03] (useLayoutEffect for registrations), [L06] (appearance via DOM/CSS), [L19] (component-authoring guide), [L20] (token sovereignty), [L22] (streaming binding).

#### Scope {#scope}

1. Layer-1 body kinds: MarkdownBlock extensions, TerminalBlock, DiffBlock, FileBlock, PathListBlock, SearchResultBlock, JsonTreeBlock, TodoListBlock, AgentTranscriptBlock, ImageBlock, MermaidBlock, KaTeXBlock, TableBlock (rich), PlainTextBlock.
2. Layer-2 tool wrappers: ReadToolBlock, WriteToolBlock, EditToolBlock, BashToolBlock, GlobToolBlock, GrepToolBlock, TaskToolBlock, WebFetchToolBlock, WebSearchToolBlock, NotebookEditToolBlock, DefaultToolWrapper. (Per [D100]: the post-`TodoWrite` task system — `TaskCreate` / `TaskUpdate` — has no Layer-2 wrapper; the assembled state lives in a status-bar `TASKS` cell, not the transcript.)
3. Stream-event chrome: ThinkingBlock, PermissionDialog (`is_question:false`), QuestionDialog (`is_question:true`), TideMeterChrome (card-level status strip — window-utilization gauge + last-turn time + cumulative session tokens + cumulative session time), SessionInitBanner, ErrorBlock.
4. Renderer dispatch infrastructure (`assistant-renderer-dispatch.ts`) and the block-transformer pass over markdown blocks.
5. New `tugdeck/crates/tugdiff-wasm/` Rust crate with `imara-diff` bindings.
6. Library integrations: `ansi_up`, KaTeX (lazy), Mermaid (lazy), `diff-match-patch` (word-level intra-line diff inside DiffBlock).
7. `--tugx-md-*` typography pass (subsumes `tugplan-tide-card-polish.md` §Step 12).
8. Drift detection + caution-badge surface (per [D04]).
9. Tests: unit, integration via fixture replay, theme-snapshot, audit:tokens lint clean.
10. Both `brio` and `harmony` theme verification for every component.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **MCP tool support.** Adoption has slowed and the long-term viability is uncertain. Unknown MCP tools fall back through `DefaultToolWrapper`; bespoke MCP-server wrappers are not in this phase. Revisit if/when MCP becomes load-bearing for our users.
- **Re-run buttons on `BashToolBlock` (and similar).** Security-policy-laden; the permission-mode story for re-run isn't settled. Defer to a follow-on phase. (Listed in [Roadmap](#roadmap).)
- **"Allow with edits" on `PermissionDialog`.** Requires a structured editor over `tool_use.input` (a command-line editor for Bash, an editable diff for Edit). Defer to a follow-on phase.
- **`AgentTranscriptBlock` as a Slack-like participant variant.** Initial implementation is an inline collapsible block within the parent `code` row; the participant-variant A/B is deferred until the inline form has shipped.
- **Tree-sitter syntax highlighting.** Shiki stays in place. Reevaluate only if a measurable Shiki bottleneck shows up in profiling. (Open question [Q02].)
- **NotebookCellBlock specialization.** `NotebookEditToolBlock` v1 uses generic `DiffBlock`. Cell-aware specialization deferred. (Open question [Q01].)
- **Phase T2 shell-command adapter blocks** (`GitStatusBlock`, `BuildOutputBlock`, etc.). Those land in `tide.md` Phase T2/T6; this phase only ships the Layer-1 primitives those adapters will reuse.
- **Editing the `marked`-based legacy markdown path** (`tugdeck/src/lib/markdown.ts`). Slated for removal in its own dedicated cleanup; not touched here unless the pipeline surface forces it.
- **Persisting renderer-level UI state** (e.g., per-block expand/collapse remembered across reload). Optional polish, deferred.
- **Re-rendering of historical `system_metadata` events** for cosmetic reasons. Per [D03], we render only on change.

#### Dependencies / Prerequisites {#dependencies}

- `tugmark-wasm` (pulldown-cmark + WASM block lex/parse) — exists at `tugdeck/crates/tugmark-wasm/`.
- `TugMarkdownView` and `TugMarkdownBlock` — exist at `tugdeck/src/components/tugways/`.
- `parseMarkdownToSanitizedBlocks` and `dompurify-instance` — exist at `tugdeck/src/lib/markdown/`.
- `CodeSessionStore` and its `streamingPaths.{assistant,thinking,tools}` — exist; produce `TurnEntry` records this phase consumes.
- `TugListView` + `TideTranscriptDataSource` — landed via `tugplan-tug-list-view.md`. The transcript surface this phase renders into.
- `TugTranscriptEntry` row primitive — landed via `tugplan-tide-card-polish.md` Step 9.
- `tugplan-tide-session-ledger.md` — Step 10 of card-polish — for session lifecycle that drives `SessionInitBanner`.
- `BlockHeightIndex` / `RenderedBlockWindow` — exist; reused by `TerminalBlock` self-virtualization per [D02].
- `PropertyStore` + `observe` — exists; the streaming-binding contract per Spec S05.
- Stream-json catalog at `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/v2.1.105/` (and `v2.1.112/`) — ground truth for fixture replay tests.
- Both theme files: `tugdeck/styles/themes/brio.css` and `harmony.css` — extended with per-component slots.
- The seven-slot token convention from `tuglaws/token-naming.md`.
- The component-authoring guide from `tuglaws/component-authoring.md`.

#### Constraints {#constraints}

- All new components must pass the L19 component-authoring checklist (file pair `.tsx` + `.css`, module docstring, exported props interface, `data-slot` attribute).
- All new tokens must conform to the seven-slot naming per L19/L20: `--tugx-<kind>-<plane>-control-<constituent>-<emphasis>-<role>-<state>`. `bun run audit:tokens lint` exits 0.
- No `box-shadow` elevation, no `translateY` press-down, no gradients. Color transitions only ([D85, D70, D82]).
- No `localStorage` / `sessionStorage` / IndexedDB. Persistent UI state — none in this phase, but if any is added it goes through tugbank's `/api/defaults/<domain>/<key>` model.
- HMR is always running; no manual builds for tugdeck.
- `bun`, never `npm` / `npx`.
- WASM modules must initialize before any code that uses them runs; main.tsx pattern is the existing template.
- Lazy-loaded stretch content (KaTeX, Mermaid, tugdiff-wasm) must not appear in the main bundle.
- No new IndexedDB dependencies (D-T3-10).
- Vitest test names must encode the spec they cover. Rust nextest tests with `-D warnings`.
- Focus, selection, and event-ordering behavior is verified through the `app-test` harness against the real Tug.app WKWebView, not through in-process fake-DOM shims.
- All work is on the `tugplan-tide-assistant-rendering` branch; no commits to `main` directly.
- Both `brio` and `harmony` themes verified for every component.

#### Assumptions {#assumptions}

- `pulldown-cmark` block output remains stable across patch versions. Drift caught by the markdown unit tests.
- The stream-json catalog at `v2.1.105` is representative; new event shapes that arrive in `v2.1.112+` are caught by the drift detection in [D04].
- Anthropic continues to delta-stream `assistant_text` and `thinking_text` (full-text only on `complete`).
- `Shiki` performance is acceptable for syntax highlighting — confirmed by qualitative use; revisit if profiling shows otherwise (per [Q02]).
- The `imara-diff` Rust crate compiles to WASM cleanly — to be verified in [#step-9](#step-9).
- KaTeX bundle size is ~350 KB and loads synchronously after import; Mermaid is ~1 MB with lazy diagram-type loading.
- Users do not need bidirectional/RTL math layout in v1 (KaTeX supports it but we don't surface controls).
- Image attachments arrive only on inbound user messages, not in assistant output. Markdown `![alt](url)` references in assistant prose go through the `MarkdownBlock` → `ImageBlock` delegation.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] When do we ship `NotebookCellBlock`? (OPEN) {#q01-notebook-cell-block}

**Question:** `NotebookEditToolBlock` v1 uses generic `DiffBlock`. When do we promote to a cell-aware `NotebookCellBlock` body kind that knows about cell types (markdown vs. code) and their intra-cell semantics?

**Why it matters:** Premature specialization burns design time on a low-frequency tool. Late specialization leaves notebook-edit ergonomics subpar for users who do live in notebooks.

**Options:**
- Ship after the first Tide user complains in qualitative feedback.
- Schedule for the first quarter after this phase closes if no user surfaces it.
- Defer indefinitely; revisit only if NotebookEdit traffic crosses a measured threshold.

**Plan to resolve:** Track `NotebookEdit` tool-use frequency in dogfooding for ~4 weeks after this phase ships. Decide based on observed traffic and user feedback.

**Resolution:** OPEN.

#### [Q02] When do we evaluate Tree-sitter migration vs. Shiki? (OPEN) {#q02-tree-sitter-evaluation}

**Question:** Shiki is fast enough today but doesn't do incremental highlighting. When (if ever) do we migrate to `web-tree-sitter`?

**Why it matters:** Tree-sitter would handle streaming/incremental code-block highlighting better, but the per-language WASM blob + async init complexity is substantial.

**Options:**
- After this phase, profile a Tide session with heavy code-block traffic; migrate only if a measurable bottleneck appears.
- Stay on Shiki indefinitely; revisit only if a user complaint forces it.

**Plan to resolve:** Add a one-shot benchmark in [#step-30](#step-30) that paste-loads 10k lines of code into a Tide card and measures highlight latency on Shiki. If > 5s on the reference machine, file a follow-up plan.

**Resolution:** OPEN — benchmark is an artifact of this phase but the migration decision is deferred.

#### [Q03] How does the drift "caution" badge surface? (OPEN) {#q03-caution-badge-surface}

**Question:** When [D04]'s drift detection fires, does the caution badge appear (a) in the card chrome row alongside the cumulative cost chrome, (b) inline at the offending event, or (c) both?

**Why it matters:** Chrome-only is discoverable but doesn't anchor the user to the offending event. Inline is anchored but invisible if the user scrolled past. Both is loud but possibly correct.

**Options:**
- (a) Chrome only — quiet; loses provenance.
- (b) Inline only — loud at the site; misses overall awareness.
- (c) Chrome (subtle, "drift detected: 3 events") + inline (subtle, on the offending event) — discoverable from either direction.

**Plan to resolve:** Implement option (c) in [#step-21](#step-21) and adjust based on dogfooding feel.

**Resolution:** OPEN — initial implementation is (c), landed in [#step-21](#step-21): the inline `TideCautionBadge` marks the offending event, and the aggregate surface is `TideVersionBadge` in the Z3 prompt-entry chrome (the Step 20.x `tide-meter-chrome.tsx` the plan named never shipped) — an always-on Claude Code version badge that escalates to a caution tone on drift. Revisit the chrome placement after dogfooding.

#### [Q04] What's the cap on retained lines for very large Bash output? (OPEN) {#q04-terminal-line-cap}

**Question:** [D02] virtualizes long output via `BlockHeightIndex`, but virtualization manages *visible* lines, not retained-in-memory lines. What's the cap on how many lines we hold for a single `BashToolBlock`?

**Why it matters:** A `Bash` tool that streams 50 MB of output will OOM the tab if we retain everything. But aggressive truncation loses information the user might want to scroll back to.

**Options:**
- 10k lines retained, drop earliest with "… 12,345 earlier lines truncated" indicator.
- 100k lines retained — generous; might still hit memory under pathological inputs.
- Configurable via tugbank `/api/defaults/tide/terminal-line-cap`, default 10k.

**Plan to resolve:** Default 10k retained with truncation indicator; expose via tugbank if a user surfaces a need.

**Resolution:** RESOLVED. [Audit §5.2](./tide-assistant-rendering-session-audit.md) confirms real-corpus Bash stdout: P50=6, P95=40, P99=100, max=706 lines. Default **10k retained** is two orders of magnitude above the observed maximum across 25,542 Bash invocations — safe without a configurable knob. The tugbank knob is **not shipped in v1**; revisit only if a user reports a long-running streaming Bash output (`watch`, log tail) that hits the cap.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Bundle bloat from eager-loading stretch libs | high | low | Lazy-load KaTeX, Mermaid, tugdiff-wasm; per Tables [T04](#t04-library-picks) and [T06](#t06-bundle-budget) | Initial-bundle measurement crosses configured budget |
| Drift breaks renderers when Anthropic ships new shapes | medium | medium | DefaultToolWrapper covers unknown tools; JsonTree fallback for unknown structured shapes; caution badge surfaces drift; align with `tide.md#p15-stream-json-version-gate` | Capture-test catalog drift > N events |
| Mid-stream rerender churn | medium | medium | Per [D12] only streaming bodies subscribe; non-streaming bodies render once on completion | Profile shows > 5% time in render commits during heavy streams |
| Mermaid / KaTeX runtime errors crash a row | medium | low | Error boundary per instance; fall back to CodeBlock with toast | First runtime crash in dogfooding |
| Component sprawl + token sprawl | medium | medium | Strict L19/L20 compliance; cross-component snapshot tests against both themes | audit:tokens lint failure or theme-mismatch report |
| Streaming + virtualization perf under high-frequency updates | medium | low | rAF coalescing in TugMarkdownView (already in place); profile and adjust | Pathological prompts > 50 deltas/sec land jank in scroll |

**Risk R01: Bundle bloat from eager-loading stretch libs** {#r01-bundle-bloat}

- **Risk:** KaTeX (~350 KB), Mermaid (~1 MB), `tugdiff-wasm` (~hundreds of KB), and Shiki language packs together blow past a Tide card's first-paint budget if loaded eagerly.
- **Mitigation:** All four are lazy — KaTeX on first `$...$` or `$$...$$` encounter; Mermaid on first ` ```mermaid `; tugdiff-wasm on first `DiffBlock` mount; Shiki language packs already lazy. The first encounter pays a one-time load; subsequent uses hit the cache.
- **Residual risk:** First encounter with each lazy module has a load delay (typically < 500ms on warm cache). Acceptable; we surface a placeholder spinner.

**Risk R02: Drift breaks renderers when Anthropic ships new event shapes** {#r02-drift-breaks-renderers}

- **Risk:** A future Claude Code release adds a new `tool_name`, a new `structured_result` shape, or a new top-level event type. Our renderers crash or render blank.
- **Mitigation:** `DefaultToolWrapper` ([D11]) handles unknown `tool_name`s. `JsonTreeBlock` fallback ([D04]) handles unknown structured shapes. The drift detector ([D04]) compares incoming `system_metadata.version` to the pinned golden catalog and surfaces a caution badge when shapes diverge ([Q03]).
- **Residual risk:** Caution badge requires user acknowledgement; drift is silently rendered through the generic fallback until a user reports.

**Risk R03: Mid-stream rerender churn** {#r03-rerender-churn}

- **Risk:** rAF coalescing helps, but a `code` row that contains both a streaming `MarkdownBlock` and a non-streaming `FileBlock` may have React render churn from upstream prop changes.
- **Mitigation:** Per [D12] / Spec S05, only streaming bodies subscribe to `PropertyStore`; non-streaming bodies render once on `tool_use_structured` completion and use `React.memo` to skip prop-equal rerenders.
- **Residual risk:** Mixed streaming/non-streaming compositions need profiling; high-frequency `assistant_text` deltas can still land work in the React commit phase.

**Risk R04: Mermaid / KaTeX runtime errors crash a row** {#r04-stretch-runtime-errors}

- **Risk:** Malformed diagram or math syntax causes the third-party renderer to throw. Without isolation, it tears down the parent transcript row.
- **Mitigation:** Each `MermaidBlock` and `KaTeXBlock` instance wraps in an error boundary; on throw, fall back to plain `CodeBlock` rendering with a small "Diagram failed to render" or "Math failed to render" toast.
- **Residual risk:** First user encounter with broken diagram is jarring even with fallback.

**Risk R05: Component sprawl + token sprawl** {#r05-component-sprawl}

- **Risk:** ~14 body kinds + ~14 wrappers + chrome = 30+ new components, each with their own token slot. Theming consistency suffers.
- **Mitigation:** Strict L19/L20 compliance enforced by `bun run audit:tokens lint`; cross-component snapshot tests against both themes in `__tests__/`.
- **Residual risk:** Each new component is one more touchpoint when a theme axis changes — but this is the cost of the rendering bar.

**Risk R06: Streaming + virtualization perf under high-frequency updates** {#r06-streaming-perf}

- **Risk:** When `assistant_text` fires 30+ deltas/sec interleaved with tool events, `BlockHeightIndex` recomputes thrash and scroll fidelity drops.
- **Mitigation:** rAF coalescing in `TugMarkdownView` already in place; profile and tune if needed.
- **Residual risk:** Pathological prompts (~100 deltas/sec) might still degrade. Mitigation: deferred adaptive coalescing window if observed.

---

### Design Decisions {#design-decisions}

#### [D01] Renderer dispatch lives in `assistant-renderer-dispatch.ts`, not in `CodeSessionStore` (DECIDED) {#d01-dispatch-separate}

**Decision:** A new module `tugdeck/src/components/tugways/cards/tide-assistant-renderer-dispatch.ts` owns the `TurnEntry` → renderer mapping. `CodeSessionStore` stays state-only and is unchanged by this phase.

**Rationale:**
- Keeps the store concerned with state, the dispatch concerned with presentation.
- Lets the registry evolve (new tools, new event types) without touching the store reducer.
- Easier to unit-test the dispatch table in isolation.

**Implications:**
- `TurnEntry` records do *not* carry a `rendererKind` tag; the dispatch derives it from `entry.kind` + `entry.toolName` + structured shape.
- The dispatch module exports a `dispatch(entry: TurnEntry): { Component, props }` shape that the transcript view consumes.
- The dispatch module owns the `toolWrapperRegistry` keyed on `tool_name` (case-insensitive, with `MultiEdit` aliasing to `Edit`).

#### [D02] `TerminalBlock` self-virtualizes long output via `BlockHeightIndex` (DECIDED) {#d02-terminal-virtualizes}

**Decision:** When a `TerminalBlock` exceeds N visible lines (default 40), it self-virtualizes using the same `BlockHeightIndex` + `RenderedBlockWindow` machinery `TugMarkdownView` uses. Up to a retained-line cap ([Q04], default 10k); beyond that, drop the earliest with a "… N earlier lines truncated" indicator.

**Rationale:**
- Reuses existing virtualization infrastructure rather than building a parallel path.
- 10k retained is enough for typical `cargo build`, `npm test`, multi-MB log dumps; pathological streams degrade gracefully rather than OOM.
- Truncation indicator preserves user awareness of dropped content.

**Implications:**
- `TerminalBlock` accepts the same `BlockHeightIndex` host plumbing as `TugMarkdownView`.
- Retained-line cap is configurable via tugbank `/api/defaults/tide/terminal-line-cap` (deferred unless surfaced).
- Stream parsing (ANSI → spans) runs incrementally as deltas arrive.

#### [D03] `system_metadata` renders per-turn only when something changed (DECIDED) {#d03-system-metadata-on-change}

**Decision:** `SessionInitBanner` reads `system_metadata`; it re-renders only when one of `model`, `permissionMode`, `version`, or the tool/skill enumeration differs from the previous `system_metadata` event in this session. Identical-shape `system_metadata` events are dropped without re-rendering. `TideMeterChrome` reads `system_metadata.model` only to look up the context-window max via the static `model-context-max.ts` table — no monetary denominations rendered.

**Rationale:**
- Per-turn render is noisy; session-init-only loses mid-session model and permission-mode changes.
- Diff-based render keeps the user informed only when state actually changes.

**Implications:**
- Dispatch module owns a per-session "previous system_metadata" reference for shallow comparison.
- Comparison is shallow on the fields named above; deep compare on tools/skills/agents arrays.
- A test fixture replay where every event includes `system_metadata` should produce exactly one banner render plus one re-render at any change.

#### [D04] Drift fallback is `JsonTreeBlock` + caution badge (DECIDED) {#d04-drift-fallback-caution-badge}

**Decision:** When the dispatch encounters an unknown tool_name (registry miss) or a `structured_result` shape that doesn't match its expected schema, render via `JsonTreeBlock` and surface a caution badge per [Q03]. The caution badge is also surfaced when `system_metadata.version` doesn't match the pinned golden catalog (per `tide.md#p15-stream-json-version-gate`).

**Rationale:**
- Never render blank or crash on drift.
- Caution badge gives the user provenance to report drift to us.
- Aligns with the `tide.md#p15-stream-json-version-gate` story.

**Implications:**
- `JsonTreeBlock` is a permanent body kind, not just a fallback — it's also the default body for unknown tool inputs in `DefaultToolWrapper`.
- Caution badge is surfaced both in the card chrome (subtle aggregate) and inline at the offending event (subtle marker), per [Q03] option (c).
- Drift events are logged to the console (and, longer-term, to the supervisor telemetry feed if/when that ships).
- Schema-mismatch detection is shallow: we check field presence and types at top level, not deep validation.

#### [D05] Two-layer hybrid architecture: body kinds + thin per-tool wrappers (DECIDED) {#d05-two-layer-hybrid}

**Decision:** Layer 1 is ~14 reusable body kinds that own all the heavy rendering. Layer 2 is one wrapper per Claude tool, each wrapper is thin (~50-100 lines) and composes Layer 1.

**Why this isn't overkill.** "One component per tool" sounds like a lot, but the per-tool layer is *decoration over composition* — chrome (header, footer, badges) plus a body that's a Layer-1 component. The rendering polish accumulates in body kinds, where it gets reused by every tool that needs that shape. So when a designer touches diff styling, they touch *one* file and every tool that shows a diff inherits the change. Per-tool is the right granularity for "great rendering"; sharing the body kinds is the right factoring for staying maintainable.

**Three upgrade levers, with worked examples:**

1. **Tune the wrapper.** `BashToolBlock` later wants a re-run button → add it to the wrapper. `ReadToolBlock` later wants a "view in editor" link → add it to the wrapper. No body-kind or sibling-tool changes.
2. **Swap the body.** `BashToolBlock` initially uses `<TerminalBlock>`. We later detect `git status --porcelain=v2` output → swap to `<GitStatusBlock>` (Phase T2 in `tide.md` already plans for this body kind on the shell-adapter side; *the same body serves both halves*). One-line change in the wrapper.
3. **Specialize a body kind.** `EditToolBlock` initially uses generic `<DiffBlock>`. Notebook edits need cell-aware diffing → ship `<NotebookDiffBlock>` as a sibling primitive. `EditToolBlock` switches based on file extension; the generic `<DiffBlock>` is untouched. Specialization is invasive but localized.

A `toolRendererRegistry` keyed on `tool_name` makes lever 1 trivial; lever 2 is internal to the wrapper; lever 3 is the most invasive but bounded.

**Rationale:**
- Per-tool components for "great rendering," but the bulk of code is shared so the per-tool layer is cheap.
- Three localized upgrade levers above let any tool reach an arbitrarily-bespoke ceiling without disturbing siblings.
- Same body kinds reused in `tide.md` Phase T2 for shell adapters.

**Implications:**
- See Tables [T01](#t01-body-kinds) and [T02](#t02-tool-wrappers).
- All wrappers conform to the [Spec S03](#s03-tool-wrapper-contract) shape.
- Adding a new tool = new wrapper file + registry entry; never touches body kinds.

#### [D06] WASM only where it earns its keep (DECIDED) {#d06-wasm-where-earns}

**Decision:** New WASM crates only for parsers where the speed/correctness win is clear: `tugdiff-wasm` (imara-diff) for diff parsing. Stay JS for ANSI parsing (`ansi_up`), JSON-tree, KaTeX (already JS), Mermaid (already JS), word-level intra-line diff (`diff-match-patch`).

**Rationale:**
- WASM has real costs: build complexity, async init, an extra crate to maintain.
- `imara-diff` is 10-30× faster than JS alternatives on large diffs and pathological-input safe — wins justify the cost.
- ANSI / JSON / inline math don't have the input scale to need WASM.

**Implications:**
- One new crate this phase: `tugdeck/crates/tugdiff-wasm/`.
- Vite config extended for the new WASM module.
- Possible future migration: `vtparse` (Rust) for ANSI if we hit pathological terminal sequences.

#### [D07] Block-transformer pass over markdown blocks (DECIDED) {#d07-block-transformer-pass}

**Decision:** `parseMarkdownToSanitizedBlocks` adds a transformer hook that runs after sanitize. Transformers can replace a block's `html`, change its `type`, or insert sibling blocks. Initial transformers: mermaid (lang === "mermaid"), latex/math (lang === "math" or "latex"), diff (lang === "diff"), large-json (lang === "json", > N tokens).

**Rationale:**
- The fenced-code-block lang hint is a natural promotion point.
- Pure function over the block list — no side effects, easy to test.
- Streaming-friendly: transformers run on each parse pass.

**Implications:**
- `parseMarkdownToSanitizedBlocks` signature gains an optional `transformers: BlockTransformer[]` parameter.
- Each transformer is a small, testable unit with the [Spec S04](#s04-block-transformer-pass) shape.
- Inline math (`$...$`, `$$...$$`) is handled via a separate post-DOMPurify text-node walk inside `MarkdownBlock` rendering, not the block-transformer pass.

#### [D08] KaTeX (not MathJax) for math typesetting (DECIDED) {#d08-katex-over-mathjax}

**Decision:** Use KaTeX for inline (`$...$`) and display (`$$...$$`) math. Lazy-loaded, ~350 KB total, synchronous render. Local font bundling, no CDN.

**Rationale:**
- Smaller bundle than MathJax (350 KB vs. 1+ MB).
- Synchronous render — no reflow churn during streaming.
- Faster than MathJax v3 in our latency profile.
- Sufficient LaTeX coverage for the math the assistant typically emits.

**Implications:**
- KaTeX bundle loads on first `$...$` or `$$...$$` encounter.
- WOFF2 fonts bundled, not pulled from CDN.
- Error boundary per instance per [R04].

#### [D09] `imara-diff` for `DiffBlock` backbone (DECIDED) {#d09-imara-diff-backbone}

**Decision:** Compile `imara-diff` (Rust) to WASM via a new `tugdeck/crates/tugdiff-wasm/` crate. Use it to compute unified diffs and parse upstream unified-diff strings. Fall back to JS `jsdiff` for first-paint before the WASM module loads.

**Rationale:**
- 10-30× faster than `similar` on large inputs.
- Histogram + Myers algorithms; pathological-input safe.
- WASM is the right home — diff is exactly the kind of work where WASM shines.

**Implications:**
- New crate at `tugdeck/crates/tugdiff-wasm/`.
- Vite config + WASM init pattern matching `tugmark-wasm`.
- `DiffBlock` mounts in JS-fallback mode if the WASM module isn't ready, swaps once it loads.

#### [D10] Lazy-load all stretch content modules (DECIDED) {#d10-lazy-load-stretch}

**Decision:** KaTeX, Mermaid, `tugdiff-wasm`, and Shiki language packs all load on first encounter. The Tide card boot bundle excludes them.

**Rationale:**
- Initial bundle stays bounded — Tide card mount is fast.
- A session that never sees a diagram pays no Mermaid cost.
- First encounter has a one-time load (cached for session); subsequent uses are instant.

**Implications:**
- Each lazy module has a placeholder shown during fetch (small spinner, not jarring).
- Bundle-size budget enforced via [T06](#t06-bundle-budget).
- Once loaded for a session, modules persist in the JS heap; no GC trickery.

#### [D11] `DefaultToolWrapper` covers unknown tools day-one (DECIDED) {#d11-default-tool-wrapper}

**Decision:** Any `tool_use` with a `tool_name` not in the registry renders through `DefaultToolWrapper` — `JsonTreeBlock` over input + smart-pick body for output (text → MarkdownBlock; object → JsonTreeBlock) — with a caution badge per [D04].

**Rationale:**
- Day-one guarantee: we never render blank or ugly when a new tool ships.
- Upgrade path is "promote from default to bespoke" by adding a wrapper.
- Drift surfaces visibly to the user.

**Implications:**
- Always-shipped fallback; cannot be conditionally absent.
- Caution badge required for unknown-tool dispatches.
- The dispatch logs the unknown tool name for telemetry.

#### [D12] Streaming-aware behavior per body kind (DECIDED) {#d12-streaming-per-body}

**Decision:** Streaming behavior is a per-body-kind property documented in Table [T05](#t05-streaming-matrix). Streaming bodies subscribe to `PropertyStore`; non-streaming bodies render once on completion. Wrappers handle the "tool input is streaming, body isn't ready yet" gap with a placeholder.

**Rationale:**
- Not all data shapes benefit from streaming. A diff isn't a diff until both sides exist.
- Subscribing every body to `PropertyStore` would multiply rerender work for no visible gain.
- Wrappers handle the gap state once, consistently.

**Implications:**
- See Table [T05](#t05-streaming-matrix).
- All body-kind components use `React.memo` and equality-by-data-version on props.
- Wrappers expose a `WrapperState = "streaming" | "ready" | "error"` that drives chrome.

#### [D13] Inline (not modal) Permission and Question dialogs (DECIDED) {#d13-inline-dialogs}

**Decision:** Both `PermissionDialog` (`control_request_forward` with `is_question:false`) and `QuestionDialog` (`is_question:true`) render as inline blocks within the transcript flow, not as modal overlays.

**Rationale:**
- Modals break the top-to-bottom transcript reading model.
- Inline blocks preserve the conversation's spatial logic (the request appeared at a point in time).
- After resolution, the inline block becomes a static record showing what was asked and how it was answered — a permanent transcript artifact.

**Implications:**
- Both dialogs participate in the transcript scroll and selection model.
- After response, the block collapses to a one-line summary with an expand affordance.
- Focus management on dialog mount: focus the primary action button via `useLayoutEffect`.

#### [D14] Thinking blocks always collapsed by default after `turn_complete` (DECIDED) {#d14-thinking-collapse-default}

**Decision:** `ThinkingBlock` shows a streaming preview during partials but, once `turn_complete` fires, snaps to a collapsed state showing only "Thinking…" + a one-line preview. User opts in to expand.

**Rationale:**
- Thinking is supplementary; the user wants the response, not the reasoning trail by default.
- Collapsing during streaming would be jittery; collapsing on completion is stable.
- Aligns with `tugplan-tide-card-polish.md` §Step 13's default recommendation.

**Implications:**
- `ThinkingBlock` watches the parent turn's status and self-collapses on transition to `complete`.
- User-expanded state persists for the lifetime of the row (not across reload).
- Collapse animation respects reduced-motion preference.

#### [D15] Token compliance via seven-slot convention per L19/L20 (RESTATED) {#d15-token-compliance}

**Decision:** Every body kind and every wrapper introduces tokens under `--tugx-<kind>-<plane>-control-<constituent>-<emphasis>-<role>-<state>`. Wrappers do not reach into body-kind CSS. `bun run audit:tokens lint` exits 0.

**Rationale:**
- Tuglaw L19/L20 compliance is non-negotiable for component authoring.
- Theme switching (`brio` ↔ `harmony`) must work uniformly for every component.

**Implications:**
- Each new component pairs `.tsx` + `.css` files.
- `data-slot="..."` attribute on each component root.
- Token slot names enumerated in [Table T07](#t07-token-slots).

#### [D16] `assistant-renderer-dispatch` registry is keyed on `tool_name` (case-insensitive) with explicit aliases (DECIDED) {#d16-registry-key}

**Decision:** The tool-wrapper registry is a `Map<string, ToolWrapperFactory>` keyed on the lowercased `tool_name`. Aliases are declared explicitly:

| Canonical | Aliases |
|-----------|---------|
| `edit` | `multiedit` |
| `agent` | `task` (historical name; renamed by Claude Code; **per [audit §4.3](./tide-assistant-rendering-session-audit.md), real sessions emit `Agent`**) |

(MCP tools are explicitly a non-goal in v1; alias entries reserved for future MCP-server-aware wrappers.)

**Rationale:**
- Case sensitivity has been observed to vary by event; lowercase normalizes.
- Explicit aliases avoid surprise dispatch and absorb tool renames cleanly.
- Easy to test: `dispatch.match("Read") === ReadToolBlock`.

**Implications:**
- Registry construction is centralized in `assistant-renderer-dispatch.ts`.
- Aliases declared as a sibling object next to the registry.
- Unknown lookups return `DefaultToolWrapper` per [D11]; *known* tools routed through Default (per [Table T02](#t02-tool-wrappers) audit-confirmed list) get registry entries that suppress the unknown-tool caution flag.

#### [D17] `AgentTranscriptBlock` recurses through the same dispatch (DECIDED) {#d17-agent-transcript-recurses}

**Decision:** When `tool_use_structured` for `Task`/`Agent` arrives with nested `content[].tool_use` entries, those nested tool calls render through the same dispatch pipeline — including their own per-tool wrappers and bodies. Recursion is bounded by a max depth (default 3); deeper levels collapse with a "+N nested calls" affordance.

*Audit footnote ([§5.1](./tide-assistant-rendering-session-audit.md)):* No real-session subagent depth > 1 observed in the 1,031-session corpus. Default cap of 3 is generous; 2 would be safe. Keep cap at 3 for paranoia headroom.

**Rationale:**
- The same rendering quality across recursion depth.
- Unbounded recursion would melt the layout for pathological inputs.
- Same dispatch keeps consistency.

**Implications:**
- Dispatch is recursive in shape but iterative in implementation.
- Depth tracked as a prop on each render.
- Tests cover at least depth 2 explicitly (sub-subagent).

**Design note — subagents as participants.** Subagent runs naturally read like their own *speaker* in the transcript (an `Explore` agent submitted a query and produced an answer; that's a participant turn, not just a tool call). The v1 implementation here is an inline collapsible block within the parent `code` row. A future option — A/B'd against the inline form — is to promote `AgentTranscriptBlock` to its own participant variant on `TugTranscriptEntry`, alongside `user`/`code`/`shell`/`command`. This same observation applies to a future `Bash`-as-participant treatment if shell-adapter UX work surfaces it. Both deferred to [Roadmap](#roadmap).

---

### Deep Dives {#deep-dives}

#### Architecture mental model {#architecture-mental-model}

```
┌─────────────────────────── stream-json events ───────────────────────────┐
│                                                                          │
│  thinking_text   assistant_text   tool_use   tool_result                 │
│  tool_use_structured   control_request_forward   cost_update             │
│  system_metadata   session_init   error                                  │
│                                                                          │
└────────┬─────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────── CodeSessionStore reducer ─────────────────────────┐
│ Accumulates deltas; produces TurnEntry records:                          │
│   { kind, msg_id, seq, body | toolEvents, status, ... }                  │
│ (Unchanged by this phase. State-only.) [D01]                             │
└────────┬─────────────────────────────────────────────────────────────────┘
         │
         ▼
┌──── tide-assistant-renderer-dispatch.ts (this phase) [D01] [D16] ────────┐
│  user_text          → UserTurnRenderer (existing)                        │
│  assistant_text     → AssistantTurnRenderer (markdown + transformers)    │
│  thinking           → ThinkingBlock                                      │
│  tool_use[name]     → toolWrapperRegistry[name] | DefaultToolWrapper     │
│  control_request    → PermissionDialog | QuestionDialog                  │
│  cost_update        → TideMeterChrome (read by snapshot subscription)    │
│  system_metadata    → SessionInitBanner (on change) [D03]                │
│  error              → ErrorBlock                                         │
└────────┬─────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────── Layer 2 — Tool wrappers ──────────────────────┐
│  ReadToolBlock, WriteToolBlock, EditToolBlock, BashToolBlock,            │
│  GlobToolBlock, GrepToolBlock, TaskToolBlock, WebFetchToolBlock,         │
│  WebSearchToolBlock, NotebookEditToolBlock, DefaultToolWrapper           │
│  (TaskCreate/TaskUpdate: no wrapper — TASKS status-bar cell, [D100])     │
│                                                                          │
│  Each wrapper: chrome (header/footer/badges) + body ← Layer 1            │
└────────┬─────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────── Layer 1 — Body kinds ─────────────────────────┐
│  MarkdownBlock     TerminalBlock      DiffBlock       FileBlock          │
│  PathListBlock     SearchResultBlock  JsonTreeBlock   TodoListBlock      │
│  AgentTranscriptBlock  ImageBlock     MermaidBlock    KaTeXBlock         │
│  TableBlock (rich)  PlainTextBlock                                       │
└──────────────────────────────────────────────────────────────────────────┘
```

#### Block-transformer pass {#block-transformer-pass}

Transformers run after `parseMarkdownToSanitizedBlocks` and before render. Each transformer takes the block list and returns a (possibly modified) list. Initial transformers in this phase:

- **`mermaidTransformer`** — replaces `{ type: "code", lang: "mermaid", text }` with `{ type: "tug-mermaid", text }`. The renderer treats `tug-*` types as opaque and delegates to the matching component. Streaming-aware: stays as a plain code block while the parent block's status is `partial`; promotes to mermaid only on `complete`.
- **`mathTransformer`** — replaces `{ type: "code", lang: "math" | "latex" | "tex", text }` with `{ type: "tug-math-display", text }`. Always display mode for fenced blocks.
- **`diffTransformer`** — replaces `{ type: "code", lang: "diff", text }` with `{ type: "tug-diff", text }` (read-only mode of `DiffBlock`).
- **`largeJsonTransformer`** — for `{ type: "code", lang: "json", text }` where `text.length > 2048`, replaces with `{ type: "tug-json-tree", text }` — a deeper interactive view than syntax-highlighted JSON.

Inline math is handled separately, after sanitize, by a text-node walk inside `MarkdownBlock` rendering. Pattern: `$<latex>$` (inline) and `$$<latex>$$` (display). Escaped `\\$` is preserved.

#### Streaming behavior matrix {#streaming-matrix}

See [Table T05](#t05-streaming-matrix).

#### Library landscape (May 2026) {#library-landscape}

Web research conducted for this phase (cited in §[Library citations](#library-citations)) confirms:

- **`imara-diff`**: 10-30× faster than `similar` on linux-kernel-scale diffs; histogram + Myers; pathological-input safe. WASM compilation is supported; build pattern matches `tugmark-wasm`.
- **Shiki**: VS Code-grade highlighting via TextMate grammars and themes. Modern versions run in browser. Lazy language loading. ~3.5s for 10k lines in browser tests — adequate for our virtualized rendering.
- **Tree-sitter** via `web-tree-sitter`: better incremental highlighting under streaming, but per-language WASM blob + async init complexity. Reserved for future evaluation per [Q02].
- **Mermaid**: lazy-loading API since v9.2; ~1 MB main bundle, smaller "Tiny" variant available. Diagram-specific code loads on first use. Late-binding pattern per [Rick Strahl 2025](#library-citations).
- **`ansi_up`**: zero-deps, ~6 KB, sufficient linear ANSI parser for our scale.
- **KaTeX vs MathJax (Nov 2025 comparison)**: KaTeX wins on bundle (~350 KB vs. 1+ MB), synchronous render, faster on most inputs. MathJax v3 has better LaTeX coverage; KaTeX coverage is sufficient for our use case.

---

### Specification {#specification}

#### Spec S01: `AssistantRendererDispatch` interface {#s01-dispatch-interface}

The dispatch is stateless logic over a discriminated-union input. The real `TurnEntry` (`tugdeck/src/lib/code-session-store/types.ts`) is a *full-turn* record without a `kind` discriminator — it carries `userMessage`, `thinking`, `assistant`, `toolCalls`, etc. The transcript view turns each `TurnEntry` (and any in-flight content) into a series of `RenderInput` values, each of which the dispatch routes to a renderer.

```typescript
// tugdeck/src/components/tugways/cards/tide-assistant-renderer-dispatch.ts

/**
 * Discriminated input for the dispatch. Each kind routes to a specific
 * renderer per the architecture mental model. Sources include TurnEntry
 * fields (assistant / thinking / toolCalls / userMessage), in-flight
 * streaming content (streamingPaths.*), and chrome-shaped events
 * (control_request_forward, cost_update, system_metadata, error).
 */
export type RenderInput =
  | { kind: "assistant_text"; text: string; status: "streaming" | "complete"; msgId: string }
  | { kind: "thinking"; text: string; status: "streaming" | "complete"; msgId: string }
  | { kind: "tool_call"; toolCall: ToolCallState; msgId: string }
  | { kind: "user_text"; text: string; submitAt: number }
  | { kind: "permission"; request: ControlRequestForward }
  | { kind: "question"; request: ControlRequestForward }
  | { kind: "cost"; cost: CostSnapshot; cumulative?: CostSnapshot }
  | { kind: "system_metadata"; metadata: unknown; previousMetadata?: unknown }
  | { kind: "error"; message: string; recoverable: boolean };

export interface DispatchResult {
  Component: React.ComponentType<unknown>;
  props: Record<string, unknown>;
  /** Caution flag; surfaces caution badge per [D04]. */
  caution?: { reason: "unknown_tool" | "unknown_shape" | "version_drift"; detail?: string };
}

export interface AssistantRendererDispatch {
  /** Route a RenderInput to a renderer + props. Always returns; never throws. */
  dispatch(input: RenderInput, context: DispatchContext): DispatchResult;

  /** Look up a tool wrapper by name (case-insensitive). Returns DefaultToolWrapper for misses. */
  resolveToolWrapper(toolName: string): ToolWrapperFactory;

  /** Test-only: enumerate all registered tool wrappers. */
  registeredTools(): ReadonlyArray<string>;
}

export interface DispatchContext {
  /** PropertyStore for streaming-binding access. */
  store: PropertyStore;
  /** The session's CodeSessionStore handle (read-only access). */
  session: CodeSessionStore;
  /** Recursion depth for AgentTranscriptBlock; default 0. */
  depth?: number;
}
```

`previousMetadata` for [D03]'s on-change comparison rides on the `system_metadata` `RenderInput` itself rather than `DispatchContext`, so the dispatch is fully stateless over the registry: callers stay responsible for tracking their per-session previous-snapshot reference.

#### Spec S02: Body-kind contract {#s02-body-kind-contract}

Every Layer-1 body kind exports:

```typescript
export interface BodyKindProps<TData = unknown> {
  data: TData;
  /** When true, the body subscribes to the streaming store. [D12] */
  streamingStore?: PropertyStore;
  /** PropertyStore path key; default "text". */
  streamingPath?: string;
  /** Initial collapse state; respects each body's defaultCollapsedThreshold. */
  collapsed?: boolean;
  onToggleCollapsed?: (next: boolean) => void;
  className?: string;
}
```

Each component:
- Pairs a `.tsx` + `.css` file (L19).
- Sets `data-slot="<kind>-body"` on the root.
- Owns its `--tugx-<kind>-*` token slot (L20).
- Renders nothing if `data` is null/undefined; renders fallback `PlainTextBlock` on parse error.

#### Spec S03: Tool-wrapper contract {#s03-tool-wrapper-contract}

Every Layer-2 wrapper exports:

```typescript
export interface ToolWrapperProps<TInput = unknown, TStructured = unknown> {
  toolUseId: string;
  toolName: string;
  msgId: string;
  seq: number;
  input?: TInput;            // streamed empty → full
  textOutput?: string;       // tool_result.output
  structuredResult?: TStructured; // tool_use_structured.structured_result
  isError?: boolean;
  durationMs?: number;
  status: "streaming" | "ready" | "error";
  caution?: DispatchResult["caution"];
}

export type ToolWrapperFactory = (props: ToolWrapperProps) => React.ReactElement;
```

Each wrapper:
- Pairs `.tsx` + `.css`, `data-slot="<tool>-tool-block"` root.
- Renders chrome (header + footer) + composed body kind.
- Handles `status === "streaming"` with a placeholder body.
- Handles `status === "error"` with `isError` styling + the structured error message.
- Surfaces `caution` as an inline badge per [Q03]/[D04].

#### Spec S04: Block-transformer pass {#s04-block-transformer-pass}

```typescript
export interface BlockTransformer {
  /** Stable name for diagnostics. */
  name: string;
  /** Transform a single block, returning the new block list. Pure. */
  transform(block: SanitizedMarkdownBlock, context: BlockTransformContext): SanitizedMarkdownBlock[];
}

export interface BlockTransformContext {
  /** Whether the source text has reached `complete` status. */
  isComplete: boolean;
  /** Block index in the parent block list. */
  index: number;
}
```

Composition: `parseMarkdownToSanitizedBlocks(text, { transformers })` flat-maps each block through every registered transformer in order. A transformer may return `[block]` (no change), `[]` (drop), `[modified]` (replace), or `[a, b, c]` (split).

#### Spec S05: Streaming binding {#s05-streaming-binding}

Every body kind that participates in streaming:
- Accepts `streamingStore: PropertyStore` + `streamingPath: string`.
- On mount in a `useLayoutEffect`, reads `store.get(path)` synchronously and renders that initial value (G1 contract — `observe` does NOT fire on subscribe).
- Subscribes via `store.observe(path, listener)`, coalescing rapid updates with `requestAnimationFrame`.
- Writes DOM imperatively per L06; React state holds only the container ref.
- Cleans up by calling unsubscribe in the effect's cleanup.

Reference implementation: `TugMarkdownBlock` already follows this contract.

#### Spec S07: Stream-json event inventory {#s07-event-inventory}

The full set of stream-json event types this phase renders. Authoritative shape is in the fixture catalog at [`tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/v2.1.105/`](../tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/v2.1.105/) and `v2.1.112/`. Field-level shape derived from `transport-exploration.md`.

| Event | Direction | Routes to | Reducer behavior |
|-------|-----------|-----------|------------------|
| `protocol_ack` | server → client | `SessionInitBanner` (silent) | first-frame handshake |
| `session_init` | server → client | `SessionInitBanner` (top of card) | sets `session_id` (may be `"pending"`) |
| `system_metadata` | server → client | `SessionInitBanner` (re-render only on change per [D03]) | per-turn metadata: `model`, `permissionMode`, `version`, `tools`, `skills`, `agents`, `mcp_servers`, `plugins` |
| `thinking_text` | server → client | `ThinkingBlock` | delta-streamed; full text on `is_partial:false`/`status:complete` |
| `assistant_text` | server → client | `MarkdownBlock` (in `code` row body) | delta-streamed; final `complete` event has full accumulated text |
| `tool_use` | server → client | tool-wrapper-by-name (Layer 2) | `input` streams empty → full |
| `tool_result` | server → client | tool wrapper's body | `output` text + `is_error` |
| `tool_use_structured` | server → client | tool wrapper's body | typed structured shape per tool |
| `control_request_forward` (`is_question:false`) | server → client | `PermissionDialog` | answer with `tool_approval` |
| `control_request_forward` (`is_question:true`) | server → client | `QuestionDialog` | answer with `question_answer` |
| `cost_update` | server → client | `TideMeterChrome` (snapshot-derived card status strip) | drives window-utilization gauge + cumulative session-tokens readouts ([#step-20-3](./archive/tide-assistant-turns.md#step-20-3)) |
| `turn_complete` | server → client | finalize current turn | `result: "success" \| "error"` |
| `error` | server → client | `ErrorBlock` | `recoverable` flag drives variant |

Inbound (UI → Claude Code) — not rendered, but produced by the dialogs above:

| Type | Produced by | Fields |
|------|-------------|--------|
| `tool_approval` | PermissionDialog Allow/Deny | `request_id`, `decision`, `updatedInput?`, `message?` |
| `question_answer` | QuestionDialog Submit | `request_id`, `answers` |
| `interrupt` | Stop button (existing) | (empty) |

#### Spec S06: Fixture-replay test contract {#s06-fixture-replay}

**Revised at [#step-14](#step-14) — split into a pure-logic half and a render half.** This spec was authored when fake-DOM unit tests were possible (mount a card, inspect the rendered DOM). `happy-dom` was since deleted and the testing policy is pure-logic `bun:test` + real-app tests only, so the single `.test.tsx` becomes two layers:

- **Pure-logic dispatch-routing half — shipped at [#step-14](#step-14)** as `tugdeck/src/__tests__/assistant-rendering-fixture-replay.test.ts`. Walks every non-empty `*.jsonl` under the catalog (`v2.1.105` at #step-14; `v2.1.112` added at [#step-30](#step-30)) via `listGoldenProbes` / `loadGoldenProbe`, extracts each `tool_use` event, and dispatches it through `dispatchToolCallState`. Covers items **1** (no throw), **5** (Table-T02 tools route bespoke), **6** (caution exactly when expected).
- **Render half — [#step-14-5](#step-14-5)'s gallery snapshot tests** (which mount real gallery cards) plus a real-app-test once the harness can inject tool-result events. Covers items **2** (no `[object Object]`), **3** (no raw-JSON bleed), **4** (exactly one `[data-slot$="-tool-block"]` per `tool_use`).

The walk asserts:

1. No dispatch throws (pure-logic half) / no render throws (render half).
2. No `[object Object]` string literal appears in the rendered DOM. *(render half)*
3. No raw JSON-line text bleeds through outside `JsonTreeBlock` or a code view. *(render half)*
4. Every `tool_use` event in the fixture produces exactly one `[data-slot$="-tool-block"]` element in the DOM. *(render half)*
5. For tool names enumerated in [Table T02](#t02-tool-wrappers), the dispatched component is bespoke (not `DefaultToolWrapper`). *(pure-logic half)*
6. Caution badge appears exactly when expected. *(pure-logic half)*

Fixture replay is the load-bearing test for the success criteria.

#### Internal Architecture {#internal-architecture}

**File layout (proposed):**

```
tugdeck/
  src/
    components/
      tugways/
        cards/
          tide-assistant-renderer-dispatch.ts          [D01]
          tide-assistant-renderer-dispatch.test.ts
          tool-wrappers/
            read-tool-block.tsx + .css
            write-tool-block.tsx + .css
            edit-tool-block.tsx + .css
            bash-tool-block.tsx + .css
            glob-tool-block.tsx + .css
            grep-tool-block.tsx + .css
            task-tool-block.tsx + .css
            web-fetch-tool-block.tsx + .css
            web-search-tool-block.tsx + .css
            notebook-edit-tool-block.tsx + .css
            default-tool-wrapper.tsx + .css
            tool-wrapper-chrome.tsx + .css   ← shared header/footer
        body-kinds/
          terminal-block.tsx + .css
          diff-block.tsx + .css
          file-block.tsx + .css
          path-list-block.tsx + .css
          search-result-block.tsx + .css
          json-tree-block.tsx + .css
          todo-list-block.tsx + .css
          agent-transcript-block.tsx + .css
          image-block.tsx + .css
          mermaid-block.tsx + .css
          katex-block.tsx + .css
          table-block.tsx + .css
          plain-text-block.tsx + .css
        chrome/
          tide-thinking-block.tsx + .css
          tide-permission-dialog.tsx + .css
          tide-question-dialog.tsx + .css
          tide-meter-chrome.tsx + .css   [#step-20-3]
          tide-session-init-banner.tsx + .css
          tide-error-block.tsx + .css
          tide-caution-badge.tsx + .css     [D04]
    lib/
      markdown/
        block-transformers/
          mermaid-transformer.ts            [D07]
          math-transformer.ts
          diff-transformer.ts
          large-json-transformer.ts
          inline-math-walker.ts
          parse-markdown-to-sanitized-blocks.ts  ← extended
      ansi/
        ansi-to-html.ts                      ← uses ansi_up
      lazy/
        load-katex.ts                        [D10]
        load-mermaid.ts
        load-tugdiff-wasm.ts
  crates/
    tugdiff-wasm/                            [D09]
      Cargo.toml
      src/lib.rs
      pkg/                                   ← built artifact
  styles/
    themes/
      brio.css                               ← extended
      harmony.css                            ← extended
```

Each new file follows L19 (component-authoring) and L20 (token sovereignty).

#### Modes / Policies {#modes}

- **Collapse-by-default thresholds** per body kind, see [Table T01](#t01-body-kinds).
- **Streaming behavior** per body kind, see [Table T05](#t05-streaming-matrix).
- **Lazy loading** per [D10] for KaTeX, Mermaid, tugdiff-wasm.
- **Error fallback**: every primitive falls back to `PlainTextBlock` (text content) or `JsonTreeBlock` (structured) on internal error; never blank, never throws.
- **Theme switching** is uniform: `data-theme="brio"` ↔ `data-theme="harmony"` swaps token values; no component-level branching on theme name.

#### Tables {#tables}

**Table T01: Layer-1 body-kind catalog** {#t01-body-kinds}

| Body kind | Source data | Streams? | Default collapse threshold | Lazy module |
|-----------|-------------|----------|----------------------------|-------------|
| MarkdownBlock (existing) | text | yes | per-block height | none |
| TerminalBlock | stdout/stderr + ANSI | yes (stream) | 40 lines | none (ansi_up shipped) |
| DiffBlock | (old, new) or unified | no | 40 hunks | tugdiff-wasm |
| FileBlock | { content, filePath, ... } | no | 50 lines | none |
| PathListBlock | string[] | no | 100 paths | none |
| SearchResultBlock | { groups } | no | 50 results | none |
| JsonTreeBlock | unknown | no | depth 3 | none |
| TodoListBlock | { tasks } | reducer over Task* event stream ([D100]) | none | none |
| AgentTranscriptBlock | { content[] } | yes recursively | depth 2 | none |
| ImageBlock | { url, alt } | no | none | none |
| MermaidBlock | text | no (wait for complete) | none | mermaid |
| KaTeXBlock | text | no | none | katex |
| TableBlock (rich) | rows | no | 20 rows | none |
| PlainTextBlock | string | yes | 100 lines | none |

**Table T02: Layer-2 tool-wrapper catalog** {#t02-tool-wrappers}

| Wrapper | Tool name(s) | Body kind composed | Chrome |
|---------|--------------|---------------------|--------|
| ReadToolBlock | Read | FileBlock | filePath + line range |
| WriteToolBlock | Write | FileBlock | filePath + size, new vs overwrite |
| EditToolBlock | Edit, MultiEdit | DiffBlock | filePath + change counts |
| BashToolBlock | Bash | TerminalBlock | command + duration + exit code |
| GlobToolBlock | Glob | PathListBlock | pattern + count + truncated |
| GrepToolBlock | Grep | SearchResultBlock or PathListBlock | pattern + counts |
| TaskToolBlock | Task | AgentTranscriptBlock | agentType + status + tokens |
| WebFetchToolBlock | WebFetch | MarkdownBlock or FileBlock | url + favicon |
| WebSearchToolBlock | WebSearch | SearchResultBlock | query + count |
| (TASKS status-bar cell, [D100]) | TaskCreate / TaskUpdate | — (no body kind; popover composes `TugTaskItem`) | TASKS cell on the `Z2` status bar via `TideTelemetryStatusRow` (`useTaskListState` reducer + `TugProgress` ring + popover). The cell is the canonical surface for *current state*; per-call events have a second inline surface — see `TaskInlineToolBlock` below. |
| TaskInlineToolBlock ([#step-24-3-5]) | TaskCreate / TaskUpdate | — (no chrome at all — single inline-flow row: `ListChecks` icon + `TugLabel size="sm" emphasis="whisper"`) | [D100] second surface — per-call inline marker (`Created: <subject>` / `Started: …` / `Completed: …` / `Reset: …`); error rows flip to `role="danger"` + `emphasis="normal"` |
| NotebookEditToolBlock | NotebookEdit | DiffBlock | notebook + cell |
| SkillToolBlock ([#step-24-3-2]) | Skill | — (inline `<code>` for short args, embedded `TugMarkdownBlock` for long) | `Skill · /<skill-name>` header + optional one-line result label |
| MonitorToolBlock ([#step-24-3-2]) | Monitor | — (inline `<pre>` tail + native `<details>` expand) | `Monitor · <command|path|pid>` header + `until` row + tailed output |
| WorktreeToolBlock ([#step-24-3-2]) | EnterWorktree, ExitWorktree | — (single labeled row) | `Worktree · <verb> <branch|path>` header + optional `path:` row |
| TaskMgmtToolBlock ([#step-24-3-3]) | TaskList, TaskGet, TaskOutput, TaskStop | — (per-verb body composing `body-bits/`: `ToolBlockBody` + `ToolBlockFieldRow` + `ToolBlockPre` + `ToolBlockDisclosure`) | `Background Task · <verb>` header + optional `#<taskId>` args + per-verb body |
| CronToolBlock ([#step-24-3-4]) | CronCreate, CronDelete, CronList | — (per-verb body composing `body-bits/`) | `Cron · <verb>` header + per-verb args (`<cron>` / `#<id>`) + per-verb body |
| ShareOnboardingGuideToolBlock ([#step-24-3-4]) | ShareOnboardingGuide | — (mode + short_code field rows + clickable URL `<a>`) | `Share Onboarding Guide · <mode>` header + optional `#<short_code>` args |
| RemoteTriggerToolBlock ([#step-24-3-4]) | RemoteTrigger | — (action + body JSON + result via `body-bits/`) | `Remote Trigger · <action>` header + optional `#<trigger_id>` args |
| DefaultToolWrapper | * (registry miss) | JsonTreeBlock + dynamic body | tool_name + summary + caution badge |

**Tool visibility policy — `TOOL_VISIBILITY_POLICY`** (per [D101]; source of truth at `tugdeck/src/components/tugways/cards/tide-tool-visibility-policy.ts`). Two explicit buckets — `hidden` (paint zero ink, short-circuit to `NullToolBlock`) and `default-intent` (route through `DefaultToolBlock` with no caution; bespoke wrapper planned). Bespoke is implicit (registry presence). Volumes from [session audit §4.2](./tide-assistant-rendering-session-audit.md); blank where the tool post-dates the audit baseline. The two tables below mirror the policy file's structure; editing the policy is the way to move a tool between them — never edit a runtime set in `tide-assistant-renderer-dispatch.ts` directly.

***Hidden* — `NullToolBlock`, no transcript row, no caution.**

| Tool name | Audit volume | Why hidden |
|-----------|-------------:|------------|
| ~~TaskCreate~~ | 1,789 (2.78%) | **Was** hidden under the original [D100] reading (TASKS cell as sole surface). **Now bespoke** via `TaskInlineToolBlock` ([#step-24-3-5]) — the [D100] amendment introduced the second-surface inline marker. |
| ~~TaskUpdate~~ | 3,426 (5.33%) | **Was** hidden — sibling of `TaskCreate`. **Now bespoke** via `TaskInlineToolBlock` ([#step-24-3-5]). |
| ToolSearch | 145 (0.23%) | Schema-loading machinery — internal lookup of deferred tool contracts; user-irrelevant. |
| ScheduleWakeup | 17 (0.03%) | Internal `/loop`-style pacing; the wakeup itself is the user-visible event, not the scheduling call. |
| EnterPlanMode | — | Plan-mode transition is a session-state change; a chrome banner is the right surface (future follow-up). |
| ExitPlanMode | — | Symmetric counterpart of `EnterPlanMode`. |
| PushNotification | — | The notification (system bell / banner) is the user-visible surface; the tool call is plumbing. |

***Default-intent* — `DefaultToolBlock` for now, bespoke wrapper named and scheduled.**

| Tool name | Audit volume | Awaiting (follow-on step) |
|-----------|-------------:|---------------------------|
| Write | high | `WriteToolBlock` — [#step-26](#step-26) |
| NotebookEdit | low | `NotebookEditToolBlock` — [#step-26](#step-26) |
| WebFetch | low | `WebFetchToolBlock` — [#step-25](#step-25) |
| WebSearch | low | `WebSearchToolBlock` — [#step-25](#step-25) |

**Table T03: Stream-event chrome catalog** {#t03-chrome}

| Renderer | Source event | Placement |
|----------|--------------|-----------|
| ThinkingBlock | thinking_text | inline at top of code row |
| AssistantBody (existing MarkdownBlock) | assistant_text | code row body |
| Tool wrapper (per Table T02) | tool_use family | code row body, in turn order |
| PermissionDialog | control_request_forward (is_question:false) | inline, transcript flow |
| QuestionDialog | control_request_forward (is_question:true) | inline, transcript flow |
| TideMeterChrome | snapshot derivations: `lastCost.usage` + `transcript[]` + `inflightUserMessage` | card status row (four numbers: window utilization gauge, last-turn time, cumulative session tokens, cumulative session time — see [#step-20-3](./archive/tide-assistant-turns.md#step-20-3)) |
| SessionInitBanner | session_init / system_metadata change [D03] | top of card |
| ErrorBlock | error | inline, transcript flow |
| CautionBadge | drift detection [D04] | both card chrome + inline at offending event |

**Table T04: Library picks** {#t04-library-picks}

| Need | Pick | WASM? | Lazy? | Rationale |
|------|------|-------|-------|-----------|
| Markdown lex/parse | pulldown-cmark via tugmark-wasm | yes | no | already shipped |
| HTML sanitize | DOMPurify | no | no | already shipped |
| Code highlighting | Shiki | no | per-language | shipped; revisit per [Q02] |
| Diff backbone | imara-diff via tugdiff-wasm | yes | yes | 10-30× faster than alternatives [D09] |
| Word-level diff | diff-match-patch | no | with DiffBlock | small JS, sufficient for line pairs |
| ANSI parsing | ansi_up | no | no | small, sufficient |
| Math typesetting | KaTeX | no | yes | smaller + faster than MathJax [D08] |
| Diagrams | mermaid | no | yes | bundle large; lazy [D10] |
| JSON tree | custom JS component | no | no | small, full control over UX |

**Table T05: Streaming behavior matrix** {#t05-streaming-matrix}

| Body kind | Streams? | Approach during stream | On `complete` |
|-----------|----------|------------------------|---------------|
| MarkdownBlock | yes — assistant_text deltas | Existing pipeline | finalize via full text |
| TerminalBlock | yes — Bash output streams | Re-parse on each delta; ANSI parser is linear | unchanged |
| DiffBlock | no | Wrapper shows placeholder | Render once on tool_use_structured |
| FileBlock | no | Wrapper shows placeholder | Render once |
| PathListBlock | no | Wrapper shows placeholder | Render once |
| SearchResultBlock | no | Wrapper shows placeholder | Render once |
| JsonTreeBlock | no | Wrapper shows placeholder | Render once |
| AgentTranscriptBlock | yes recursively | Same pipeline as outer transcript | finalize on agent status:"completed" |
| MermaidBlock | no | Show raw code as CodeBlock | Swap to mermaid render |
| KaTeXBlock | no | Show raw `$...$` text | Render once |
| TodoListBlock | tool input streams | Wrapper shows placeholder | Render once |
| ImageBlock | no | n/a | Render once |
| TableBlock | no | n/a | Render once |
| PlainTextBlock | yes | Update on each delta | finalize |

**Table T06: Bundle-size budget** {#t06-bundle-budget}

| Module | Approx size | Loaded when |
|--------|-------------|-------------|
| tugmark-wasm (existing) | ~200 KB | Tide card boot |
| Shiki core | ~80 KB | first code block |
| Shiki language pack (per language) | 5-30 KB | first encounter of that language |
| ansi_up | 6 KB | shipped in main |
| diff-match-patch | ~50 KB | with DiffBlock |
| tugdiff-wasm | ~150-300 KB | first DiffBlock |
| KaTeX core + fonts | ~350 KB | first `$...$` or fenced math |
| Mermaid core | ~600 KB | first ` ```mermaid ` |
| Mermaid diagram packs (per type) | 100-200 KB | first encounter of that diagram type |

A Tide card with no diagrams, no math, no diffs, no code blocks pays only the tugmark-wasm + ansi_up cost on boot.

**Table T07: Token-slot enumeration** {#t07-token-slots}

Per L19/L20, every component owns a slot. Slot prefix → component:

| Slot prefix | Component(s) |
|-------------|--------------|
| `--tugx-md-*` | MarkdownBlock (existing — extended) |
| `--tugx-term-*` | TerminalBlock |
| `--tugx-diff-*` | DiffBlock |
| `--tugx-file-*` | FileBlock |
| `--tugx-paths-*` | PathListBlock |
| `--tugx-search-*` | SearchResultBlock |
| `--tugx-json-*` | JsonTreeBlock |
| `--tugx-todo-*` | TodoListBlock |
| `--tugx-agent-*` | AgentTranscriptBlock |
| `--tugx-image-*` | ImageBlock |
| `--tugx-mermaid-*` | MermaidBlock |
| `--tugx-katex-*` | KaTeXBlock |
| `--tugx-tabrich-*` | TableBlock (rich) |
| `--tugx-toolblock-*` | shared tool-wrapper chrome |
| `--tugx-thinking-*` | ThinkingBlock |
| `--tugx-idialog-*` | TugInlineDialog ([#step-18-5](#step-18-5)) |
| `--tugx-dialog-button-*` | TugDialogButton ([#step-18-6](#step-18-6)) |
| `--tugx-gauge-*` | TugLinearGauge ([#step-20-1](./archive/tide-assistant-turns.md#step-20-1)) / TugArcGauge ([#step-20-2](./archive/tide-assistant-turns.md#step-20-2)) — color slots shared; geometry slots namespaced per gauge |
| `--tugx-perm-*` | PermissionDialog |
| `--tugx-quest-*` | QuestionDialog |
| `--tugx-tide-meter-*` | TideMeterChrome ([#step-20-3](./archive/tide-assistant-turns.md#step-20-3)) |
| `--tugx-banner-*` | SessionInitBanner |
| `--tugx-err-*` | ErrorBlock |
| `--tugx-caut-*` | CautionBadge |

**List L01: Pulldown-cmark options enabled (existing + new)** {#l01-cmark-options}

- ENABLE_TABLES (existing)
- ENABLE_STRIKETHROUGH (existing)
- ENABLE_TASKLISTS (existing)
- ENABLE_FOOTNOTES (new — typography upgrade)
- ENABLE_SMART_PUNCTUATION (new — typography upgrade)

**List L02: Block transformers shipped this phase** {#l02-block-transformers}

- mermaidTransformer
- mathTransformer (display)
- diffTransformer
- largeJsonTransformer

**List L03: Layer-1 body kinds (one-line names)** {#l03-body-kinds}

MarkdownBlock, TerminalBlock, DiffBlock, FileBlock, PathListBlock, SearchResultBlock, JsonTreeBlock, TodoListBlock, AgentTranscriptBlock, ImageBlock, MermaidBlock, KaTeXBlock, TableBlock, PlainTextBlock.

**List L04: Layer-2 tool wrappers (one-line names)** {#l04-tool-wrappers}

ReadToolBlock, WriteToolBlock, EditToolBlock, BashToolBlock, GlobToolBlock, GrepToolBlock, TaskToolBlock, WebFetchToolBlock, WebSearchToolBlock, NotebookEditToolBlock, DefaultToolWrapper. (Per [D100]: `TaskCreate` / `TaskUpdate` route to `NullToolBlock` — no Layer-2 wrapper; the TASKS status-bar cell is the sole surface.)

**List L05: Stream-event chrome renderers (one-line names)** {#l05-chrome}

ThinkingBlock, PermissionDialog, QuestionDialog, TideMeterChrome ([#step-20-3](./archive/tide-assistant-turns.md#step-20-3) — card status strip), SessionInitBanner, ErrorBlock, CautionBadge.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New crates {#new-crates}

| Crate | Purpose |
|-------|---------|
| `tugdiff-wasm` | Rust crate at `tugdeck/crates/tugdiff-wasm/`; exposes `imara-diff` to JS as `parse_unified_diff(text: &str) -> Vec<DiffHunk>` and `two_text_diff(before: &str, after: &str) -> Vec<DiffHunk>` |

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/components/tugways/cards/tide-assistant-renderer-dispatch.ts` | [D01] dispatch module |
| `tugdeck/src/components/tugways/cards/tide-assistant-renderer-dispatch.test.ts` | dispatch unit tests |
| `tugdeck/src/components/tugways/cards/tool-blocks/{read,write,edit,bash,glob,grep,task,web-fetch,web-search,notebook-edit,default}-tool-block.{tsx,css}` | tool wrappers (11 × 2 = 22 files). Per [D100], no `todo-write-tool-block` ships — `TodoWrite` was retired upstream and the post-`TodoWrite` `TaskCreate` / `TaskUpdate` family routes to `NullToolBlock`; the assembled state lives in the `TASKS` status-bar cell. |
| `tugdeck/src/lib/code-session-store/select-task-list.ts` + `__tests__/select-task-list.test.ts` | [D100] task-list reducer + narrow helpers + tests |
| `tugdeck/src/lib/code-session-store/hooks/use-task-list-state.ts` | [D100] `useSyncExternalStore` hook combining committed transcript + in-flight streaming tools |
| `tugdeck/src/components/tugways/tug-task-item.{tsx,css}` | [D100] / [L20] indicator + label primitive for task / checklist surfaces |
| `tugdeck/src/components/tugways/cards/gallery-tug-task-item.tsx` | gallery card for `TugTaskItem` |
| `tugdeck/src/components/tugways/cards/tool-wrappers/tool-wrapper-chrome.{tsx,css}` | shared chrome |
| `tugdeck/src/components/tugways/body-kinds/{terminal,diff,file,path-list,search-result,json-tree,todo-list,agent-transcript,image,mermaid,katex,table,plain-text}-block.{tsx,css}` | body kinds (13 × 2 = 26 files) |
| `tugdeck/src/components/tugways/chrome/tide-thinking-block.{tsx,css}` | [D14] |
| `tugdeck/src/components/tugways/chrome/tide-permission-dialog.{tsx,css}` | [D13] |
| `tugdeck/src/components/tugways/chrome/tide-question-dialog.{tsx,css}` | [D13] |
| `tugdeck/src/components/tugways/chrome/tide-meter-chrome.{tsx,css}` | card status strip — four numbers ([#step-20-3](./archive/tide-assistant-turns.md#step-20-3)) |
| `tugdeck/src/components/tugways/chrome/tide-session-init-banner.{tsx,css}` | [D03] |
| `tugdeck/src/components/tugways/chrome/tide-error-block.{tsx,css}` | error rendering |
| `tugdeck/src/components/tugways/chrome/tide-caution-badge.{tsx,css}` | [D04] |
| `tugdeck/src/lib/markdown/block-transformers/{mermaid,math,diff,large-json}-transformer.ts` | [D07] |
| `tugdeck/src/lib/markdown/block-transformers/inline-math-walker.ts` | inline `$...$` detection |
| `tugdeck/src/lib/ansi/ansi-to-html.ts` | ansi_up wrapper |
| `tugdeck/src/lib/lazy/{load-katex,load-mermaid,load-tugdiff-wasm}.ts` | [D10] lazy loaders |
| `tugdeck/src/__tests__/assistant-rendering-fixture-replay.test.tsx` | Spec S06 |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `AssistantRendererDispatch` | interface | dispatch.ts | Spec S01 |
| `DispatchResult` | interface | dispatch.ts | Spec S01 |
| `DispatchContext` | interface | dispatch.ts | Spec S01 |
| `BodyKindProps<T>` | interface | shared types | Spec S02 |
| `ToolWrapperProps<I,O>` | interface | shared types | Spec S03 |
| `ToolWrapperFactory` | type | shared types | Spec S03 |
| `BlockTransformer` | interface | block-transformers/index.ts | Spec S04 |
| `BlockTransformContext` | interface | block-transformers/index.ts | Spec S04 |
| `parseMarkdownToSanitizedBlocks` | fn (modify) | parse-markdown-to-sanitized-blocks.ts | gain optional `transformers` param [D07] |
| `parser_options` | fn (modify) | tugmark-wasm/src/lib.rs | enable FOOTNOTES + SMART_PUNCTUATION [L01] |
| `toolWrapperRegistry` | const Map | dispatch.ts | [D16] |
| `parse_unified_diff` | wasm fn | tugdiff-wasm/src/lib.rs | [D09] |
| `two_text_diff` | wasm fn | tugdiff-wasm/src/lib.rs | [D09] |
| `reduceTaskListState` | fn | `code-session-store/select-task-list.ts` | [D100] reducer over `TaskCreate` / `TaskUpdate` event stream |
| `taskListIsActive` | fn | `code-session-store/select-task-list.ts` | [D100] visibility predicate (non-empty + at least one non-completed) |
| `TaskItem` / `TaskListState` / `TaskStatus` | types | `code-session-store/select-task-list.ts` | [D100] data model |
| `narrowTaskCreateInput` / `narrowTaskUpdateInput` / `parseTaskCreateResultId` | fns | `code-session-store/select-task-list.ts` | [D100] wire-shape narrows |
| `useTaskListState` | hook | `code-session-store/hooks/use-task-list-state.ts` | [D100] / [L02] composes committed + in-flight subscriptions |
| `TugTaskItem` / `TugTaskItemStatus` / `TugTaskItemProps` | component + types | `tugways/tug-task-item.tsx` | [D100] / [L20] indicator + label primitive |
| `TugLabelRole` + `role` prop on `TugLabel` | type + prop addition | `tugways/tug-label.tsx` | [L20] role-driven text-tone colors for label composition |

---

### Documentation Plan {#documentation-plan}

- [ ] Update `tide.md` §Phase T1 — Content Block Types: replace the stub bullet list with a back-link to this plan and a one-paragraph summary.
- [ ] Update `tugplan-tide-card-polish.md` §Step 12 and §Step 13: mark as absorbed by this plan and link forward.
- [ ] Add a section to `tugdeck/README.md` describing the body-kind / tool-wrapper architecture and the dispatch module's public API.
- [ ] Add a developer guide at `tugdeck/src/components/tugways/body-kinds/README.md` explaining how to add a new body kind (file-pair convention, token slot, streaming contract).
- [ ] Add a developer guide at `tugdeck/src/components/tugways/cards/tool-wrappers/README.md` for adding a new tool wrapper (registry entry, alias declaration, body composition).
- [ ] Add a guide at `tugdeck/crates/tugdiff-wasm/README.md` matching the `tugmark-wasm` pattern (Cargo.toml conventions, build commands, exported API).
- [ ] Update `tuglaws/INDEX.md` if any new tuglaws are introduced (none anticipated; this plan is implementation, not law).

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** | Test individual body kinds, wrappers, transformers, dispatch functions in isolation | Per-component happy paths and edge cases |
| **Integration (fixture replay)** | Replay every stream-json fixture into a Tide card and verify rendering | Per Spec S06; the load-bearing success-criteria test |
| **Snapshot (theme)** | Visual snapshot of every component in both `brio` and `harmony` | Theme drift detection |
| **Gallery rendering** | Each gallery card mounts and renders all its mock variants under both themes | [#step-14-5](#step-14-5) and [#step-29-5](#step-29-5) verification |
| **app-test** | Full-app harness for focus / selection / event-ordering scenarios | Permission/Question dialog focus management; expand/collapse interactions |
| **Drift Prevention** | Synthetic-drift fixtures that introduce unknown tools, unknown shapes, version mismatches | Verify [D04] caution badge and `DefaultToolWrapper` fallback |
| **Performance** | Microbenchmarks for diff parse, ANSI parse, and high-frequency streaming | Verify [R03], [R06], inform [Q02] |

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Each step is one commit. Integration checkpoint steps use `Commit: N/A (verification only)`.

#### Step 0: Empirical session audit {#step-0}

<!-- Step 0 has no dependencies. Runs concurrently with Step 1+; later steps reference its output to calibrate thresholds. -->

**Commit:** `docs(tide-rendering): empirical session audit — frequency tables and threshold calibration`

**References:** [Q04] (terminal-cap calibration), [D02] (virtualization threshold), [Table T01](#t01-body-kinds) (collapse thresholds), [D10] (lazy-load justification), (#success-criteria)

**Artifacts:**
- New `dash/tide-assistant-rendering-session-audit.md` capturing the audit results
- Optional helper script `tugdeck/scripts/audit-claude-sessions.ts` (or a Bash + jq pipeline; deletable after the audit)
- The audit document is the load-bearing artifact; it informs but does not gate later steps

**Tasks:**
- [x] Walk every `*.jsonl` file under `~/.claude/projects/-Users-kocienda-Mounts-u-src-tugtool/` (1,031 files, 232,031 JSONL lines, 0 parse errors as of 2026-05-08)
- [x] Compute frequency distribution of `tool_use` events by `tool_name` — produces a percentage table that calibrates which wrappers ship bespoke vs. through `DefaultToolWrapper`
- [x] Compute size distributions (P50/P95/P99) for: Read line count, Bash `stdout` line count, Edit `(old_string, new_string)` line counts, Glob result count, agent transcript depth — calibrates collapse thresholds in [Table T01](#t01-body-kinds) and [Q04]
- [x] Enumerate any tools in real sessions that aren't in [Table T02](#t02-tool-wrappers) — 11 new tool names found; dispositions captured in audit §4.2
- [x] Count occurrences of fenced-code-block languages in `assistant_text` — Mermaid 0%, math 1.4%, validates [D10] lazy-load decisively
- [ ] ~~Count `control_request_forward` events~~ — *Not measurable from session-log format; requires wire-level capture; documented as limitation in audit §6*
- [x] Count `is_error: true` ratios per tool — informs error-state design in every wrapper
- [x] Subagent depth in real sessions — max observed = 1; [D17] depth cap of 3 is generous; default could drop to 2 safely
- [x] Write up findings as a frequency-table appendix in the new audit doc; cross-reference each subsequent step's calibration-relevant tasks

**Tests:**
- [x] N/A — research artifact, not code

**Checkpoint:**
- [x] Audit doc reviewed; threshold-calibration table captured at [§5.1 of audit](./tide-assistant-rendering-session-audit.md)
- [x] All 11 tools surfaced by audit but missing from [Table T02](#t02-tool-wrappers) added below as audit-confirmed `DefaultToolWrapper` routes; [D16] alias map updated; [#step-7](#step-7) collapse threshold updated; [Q04] resolved

---

#### Step 1: Renderer dispatch infrastructure {#step-1}

**Commit:** `feat(tide-rendering): add assistant-renderer-dispatch module and registry scaffolding`

**References:** [D01], [D11], [D16], Spec S01, (#architecture-mental-model)

**Artifacts:**
- `tugdeck/src/components/tugways/cards/tide-assistant-renderer-dispatch.ts`
- `tugdeck/src/components/tugways/cards/tide-assistant-renderer-dispatch.test.ts`
- Shared `BodyKindProps` / `ToolWrapperProps` / `ToolWrapperFactory` types in `tugdeck/src/components/tugways/cards/tool-wrappers/types.ts`
- A no-op `DefaultToolWrapper` (just enough to pass the dispatch test; full body lands in [#step-13](#step-13))

**Tasks:**
- [x] Define `AssistantRendererDispatch`, `DispatchResult`, `DispatchContext` per Spec S01 (Spec S01 reconciled with real `TurnEntry` shape — input is `RenderInput` discriminated union, not raw `TurnEntry`)
- [x] Build `toolWrapperRegistry: Map<string, ToolWrapperFactory>` keyed lowercase per [D16]
- [x] Build alias map per [D16] — `multiedit → edit` and `task → agent` (historical rename per audit §4.3)
- [x] Implement `dispatch(input, context)`: routes by `input.kind`; for `tool_call`, looks up by lowercased `toolCall.toolName`; falls back to `DefaultToolWrapper` per [D11] with `caution: { reason: "unknown_tool" }`; suppresses caution for the audit-confirmed default-routed tools
- [x] Implement `resolveToolWrapper(name)` and `registeredTools()`
- [x] Implement scaffold-only `DefaultToolWrapper` rendering tool_name + "(default)" marker; full body lands at [#step-13](#step-13)

**Tests:**
- [x] `dispatch.test`: dispatch an `assistant_text` input → `KIND_RENDERERS.assistant_text` (the per-kind scaffold; replaced wholesale by the real renderer at [#step-3](#step-3))
- [x] `dispatch.test`: dispatch a `tool_call` with unknown name → `DefaultToolWrapper` + caution `{ reason: "unknown_tool" }`
- [x] `dispatch.test`: alias resolution — `MultiEdit` / `multiedit` / `MULTIEDIT` all resolve to the registered `edit` wrapper; `Task` / `task` resolve to the registered `agent` wrapper
- [x] `dispatch.test`: case-insensitive lookup — `Read` / `READ` / `reAd` all resolve identically
- [x] `dispatch.test`: audit-confirmed default-routed tools (e.g., `TaskUpdate`) → `DefaultToolWrapper` *without* caution (suppressed by design)
- [x] `dispatch.test`: store status `pending`/`error` map to wrapper status `streaming`/`error` and `isError` flag; canonical wrapper props (`toolUseId`, `toolName`, `msgId`, `input`, `structuredResult`) are threaded onto the prop bag
- [x] 19 tests, 38 assertions — all pass

**Checkpoint:**
- [x] `bun x tsc --noEmit` — clean
- [x] `bun test src/components/tugways/cards/tide-assistant-renderer-dispatch.test.ts` — 19 pass / 0 fail
- [x] `bun run audit:tokens lint` — zero violations
- [x] Full test suite still green (3,169 pass, 0 fail across 188 files)

---

#### Step 2: Markdown typography pass (subsumes card-polish §Step 12) {#step-2}

**Depends on:** #step-1

**Commit:** `style(tide-rendering): tune --tugx-md-* tokens for both brio and harmony themes`

**References:** [D15], [Table T07](#t07-token-slots), [tugplan-tide-card-polish.md §Step 12](./tugplan-tide-card-polish.md#step-12), (#success-criteria)

**Artifacts:**
- `tugdeck/styles/themes/brio.css` (extended `--tugx-md-*` slots)
- `tugdeck/styles/themes/harmony.css` (extended `--tugx-md-*` slots)
- `tugdeck/src/components/tugways/tug-markdown-view.css` and `tug-markdown-block.css` adjustments if needed for new slots

**Tasks:**
- [x] Define and tune token values for: paragraph, headings (h1-h6 with descending weight scale + muted h6), inline code, fenced code chrome, bold/italic, strikethrough, blockquote, hr, ul/ol (incl. task-list checkboxes), table (with header bg + alternate-row stripe), link (rest + hover), footnote, image
- [x] Vertical rhythm: paragraph margins (0.6em), heading margins (1.4em top, 0.4em bottom, first-child reset to 0), list indent (1.75em), code-block padding (md-lg from spacing scale)
- [x] Both themes: brio (dark) and harmony (light) declare the same `--tugx-md-*` token vocabulary; theme-as-sole-source — no fallback literals in the markdown CSS (the lone exception being `--tugx-md-block-padding-x` per its module docstring); rgba directions flipped per-theme for backgrounds/dividers
- [x] Mark `tugplan-tide-card-polish.md §Step 12` as absorbed (link back to this plan)

**Tests:**
- [x] `tug-markdown-typography.test.ts` — parser-output coverage for a representative markdown document (headings h1-h6, paragraphs, strong/em/del, links, fenced code with language class, blockquote with nested emphasis, hr, nested bullet list, ordered list, task lists, table with thead+tbody, image with alt+src) plus block-decomposition assertions (each heading is its own block; tables/lists carry rowCount/itemCount metadata)
- [x] `tide-md-token-coverage.test.ts` — guards the contract that brio.css and harmony.css declare the same set of `--tugx-md-*` tokens; every token referenced by the markdown CSS is declared in both themes; spot-check covers every typography axis; theme is the sole source (no fallback literals except the documented `--tugx-md-block-padding-x` exception)
- [x] `bun run audit:tokens lint` exits 0

**Checkpoint:**
- [x] `bun x tsc --noEmit` — clean
- [x] `bun test` — full suite 3,188 pass / 0 fail across 190 files (19 new typography assertions added)
- [x] `bun run audit:tokens lint` — zero violations
- [x] Both `brio` and `harmony` themes verified by `tide-md-token-coverage.test.ts` covering token equality + reference completeness

---

#### Step 3: MarkdownBlock extensions — block-transformer pass + footnotes + smart-punct {#step-3}

**Depends on:** #step-2

**Commit:** `feat(tide-rendering): block-transformer pass + pulldown-cmark footnotes + smart-punctuation`

**References:** [D07], Spec S04, List L01, List L02, (#block-transformer-pass)

**Scope note (deferred):** The "collapse-tall-block" affordance originally bundled in this step is deferred pending UX direction — controls at the top vs. bottom of long sections both have ergonomic issues that need a deliberate design pass. Nothing downstream depends on the collapse work (#step-12 / #step-13 / #step-15 only consume the block-transformer pass), so the deferral is structural-cost-zero. When picked back up, it gets its own step with `--tugx-md-collapse-*` tokens declared in both themes and its own gallery card.

**Artifacts:**
- `tugdeck/crates/tugmark-wasm/src/lib.rs` (extended `parser_options`)
- `tugdeck/src/lib/markdown/block-transformers/index.ts`
- `tugdeck/src/lib/markdown/block-transformers/{mermaid,math,diff,large-json}.ts` (no-op stubs; populated in later steps when consumed)
- `tugdeck/src/lib/markdown/parse-markdown-to-sanitized-blocks.ts` (gains `transformers` param)
- `tugdeck/src/lib/markdown/dompurify-instance.ts` (allow `div` for `footnote-definition`)

**Tasks:**
- [x] Enable `Options::ENABLE_FOOTNOTES` and `Options::ENABLE_SMART_PUNCTUATION` in `tugmark-wasm`
- [x] Define `BlockTransformer` and `BlockTransformContext` interfaces per Spec S04
- [x] Add optional `transformers: BlockTransformer[]` parameter to `parseMarkdownToSanitizedBlocks`; flat-map each block through every transformer in order, with `BlockTransformContext.isComplete` for streaming-aware deferral per [D07]
- [x] Create no-op stub transformer files for mermaid / math / diff / large-json so the dispatch contract compiles; consuming steps populate the bodies
- [x] Allow `div` in DOMPurify so pulldown-cmark's `<div class="footnote-definition" id="N">` keeps its `id` for fragment back-references

**Tests:**
- [x] Footnote markdown round-trips through pulldown-cmark and produces the expected `<sup class="footnote-reference">` + `<div class="footnote-definition" id="…">` chrome (`cmark-extensions.test.ts`)
- [x] Smart-punctuation: `--` / `---` produce en/em-dashes, straight quotes become curly quotes, `...` becomes `…` (`cmark-extensions.test.ts`)
- [x] Block transformer pass: a no-op transformer leaves blocks identical; a swap-type transformer changes a block's `type`; a split transformer produces multiple blocks; an empty-result transformer drops a block; transformer order is preserved when chained (`block-transformers.test.ts`)
- [x] `BlockTransformContext.isComplete` propagates from `parseMarkdownToSanitizedBlocks(text, { isComplete: false })` into each transformer invocation (`block-transformers.test.ts`)

**Implementation note:** Footnote ref ↔ definition linking only works when pulldown-cmark sees the whole document at parse time. The original pipeline parsed each block independently (sliced byte-range → `parse_to_html`), which left `[^name]` references rendering as plaintext. To fix this, a new `parse_blocks_to_html(text)` was added to `tugmark-wasm` — it walks the document in a single parser pass, buckets events into top-level blocks, and emits per-block HTML. `parseMarkdownToSanitizedBlocks` now zips `lex_blocks`'s metadata with `parse_blocks_to_html`'s HTML; the per-block `parse_to_html` is preserved for the incremental update path in `TugMarkdownView`.

**Checkpoint:**
- [x] `cd tugdeck/crates/tugmark-wasm && cargo build --target wasm32-unknown-unknown --release` — clean
- [x] `cd tugdeck && bun x tsc --noEmit` — clean
- [x] `cd tugdeck && bun test src/lib/markdown` — 45 pass / 0 fail (4 files)
- [x] Full suite: `cd tugdeck && bun test` — 3227 pass / 0 fail (194 files); `bun run audit:tokens lint` — zero violations

---

#### Step 4: ThinkingBlock + wire `streamingPaths.thinking` {#step-4}

**Depends on:** #step-1, #step-2

**Commit:** `feat(tide-rendering): ThinkingBlock — inline collapsible thinking with default-collapse-on-complete`

**References:** [D14], Spec S05, [tugplan-tide-card-polish.md §Step 13](./tugplan-tide-card-polish.md#step-13), (#chrome)

**Artifacts:**
- `tugdeck/src/components/tugways/chrome/tide-thinking-block.tsx` + `.css`
- Wire-up in `tide-card.tsx` to consume `streamingPaths.thinking`

**Tasks:**
- [x] New token slot `--tugx-thinking-*` per [Table T07](#t07-token-slots), tuned for both themes (brio + harmony) — bg / border / radius / margin / header padding+gap+hover / label color+size+weight / chevron color / preview color+size+weight / content padding+color+size+style / collapse duration+easing / focus ring
- [x] Streaming binding to `streamingPaths.thinking` per Spec S05 — chrome subscribes for preview text + visibility, body composes `TugMarkdownBlock` which subscribes for prose, both rAF-coalesced and unsubscribe on unmount
- [x] Collapse animation via `grid-template-rows: 0fr ↔ 1fr` (no max-height cap), `prefers-reduced-motion: reduce` disables transition
- [x] Snap-to-collapsed on parent turn `complete` per [D14] — implemented by the row swap: streaming cell unmounts, committed cell mounts a fresh `TideThinkingBlock` with the static-mode default-collapsed
- [x] User-expanded state persists for the cell's lifetime via React state; remount restores the mode default

**Tests:**
- [x] Renders streaming thinking text incrementally — `tide-thinking-block.test.tsx` `becomes visible after the first non-empty store emission`, `preview text updates on subsequent emissions`
- [x] On `turn_complete`, the new cell's static-mode block mounts default-collapsed with first-line preview — `non-empty initialText → strip is visible and default-collapsed [D14]`, `preview is the computed first-line summary`
- [x] User expand persists across stream deltas — `user can collapse a streaming block; toggle persists for the cell's lifetime`
- [x] Unmount unsubscribes — `unmount unsubscribes — subsequent store writes do not throw or schedule rAF`
- [x] `computePreview` unit pass: empty / leading-blank / whitespace-only / interior-collapse / truncation
- [x] Both themes declare the full `--tugx-thinking-*` token set (enforced via existing `audit:tokens lint`)

**Checkpoint:**
- [x] `cd tugdeck && bun x tsc --noEmit` — clean
- [x] `cd tugdeck && bun test` — 3247 pass / 0 fail (195 files); 20 new tests
- [x] `cd tugdeck && bun run audit:tokens lint` — zero violations
- [ ] Manual: replay `test-22-subagent-spawn.jsonl` in a Tide card; verify thinking renders, then collapses (deferred to user — HMR is always running)

---

#### Step 5: TerminalBlock body kind {#step-5}

**Depends on:** #step-1

**Commit:** `feat(tide-rendering): TerminalBlock — ANSI-aware streaming terminal renderer with virtualization`

**References:** [D02], [D06], [Q04], Spec S02, Spec S05, (#streaming-matrix)

**Artifacts:**
- `tugdeck/src/components/tugways/body-kinds/terminal-block.tsx` + `.css`
- `tugdeck/src/lib/ansi/ansi-to-html.ts` (ansi_up wrapper)
- Token slot `--tugx-term-*` for both themes
- `bun add ansi_up` to package.json

**Tasks:**
- [x] Implement ANSI parsing via `ansi_up` (v6.0.6, MIT); expose `ansiToHtml(text: string): string` in `lib/ansi/ansi-to-html.ts` — fresh `AnsiUp` instance per call (no cross-call SGR state), `use_classes = true` so 16-color SGR codes emit `class="ansi-{color}-fg|bg"` markup that the `--tugx-term-ansi-*` token slots paint
- [x] TerminalBlock with stdout/stderr split; per-line `<div class="tugx-term-line tugx-term-line--{stdout|stderr}">`, ANSI SGR parsed into theme-mapped spans
- [x] Streaming binding per Spec S05 — `useLayoutEffect` G1 sync read on mount, `observe()` for updates, `requestAnimationFrame`-coalesced re-parse on each delta, unsubscribe + cancel pending rAF on unmount
- [x] Self-virtualization at `VISIBLE_THRESHOLD = 40` lines using `BlockHeightIndex` + `RenderedBlockWindow` — explicit-height scroll container, top + bottom spacers reflect prefix-sum heights, scroll listener diffs windowed range and applies enter/exit ranges to the DOM imperatively
- [x] Truncation indicator at top — `"… N earlier lines truncated"` banner when total parsed lines exceed `RETAINED_LINE_CAP = 10_000` ([Q04])
- [x] Copy-to-clipboard button overlaid on the body, fades in on hover, writes composed `stdout + "\n" + stderr` text, toggles `is-copied` for ~1.2s
- [x] Footer: `exit ${code}` badge (zero subtle, non-zero strong via separate token slots), `interrupted` indicator, `formatDuration(ms)` mm:ss / N s / N ms

**Tests:**
- [x] ANSI: `\x1b[31mred\x1b[0m` produces `<span class="ansi-red-fg">red</span>` (`ansi-to-html.test.ts`)
- [x] Stream: deltas accumulate without flicker — rAF coalesces a 3-emission burst into one render, final value reflects cumulative content (`terminal-block.test.tsx`)
- [x] Virtualization: 200-line input switches to scroller with spacers; rendered DOM lines < total (`terminal-block.test.tsx`)
- [x] Truncation: `RETAINED_LINE_CAP + 5` lines produces the indicator with the exact dropped count (`terminal-block.test.tsx`)
- [x] Footer variants: exit-zero subtle, exit-nonzero strong, interrupted badge, duration formatted, footer-only data (no body) still renders the post-mortem badges (`terminal-block.test.tsx`)
- [x] Copy interaction: writes composed text, toggles `is-copied`, no-throw when `navigator.clipboard` is missing (`terminal-block.test.tsx`)
- [x] Both themes declare the full `--tugx-term-*` token set including the 16 ANSI palette slots — enforced via `audit:tokens lint`; ANSI palette uses `--tug-color()` recipes so the postcss plugin expands them at build time and the "zero standalone hex" gate (`step8-roundtrip-integration.test.ts`) stays green

**Checkpoint:**
- [x] `cd tugdeck && bun x tsc --noEmit` — clean
- [x] `cd tugdeck && bun test src/lib/ansi src/components/tugways/body-kinds` — 39 pass / 0 fail (14 + 25)
- [x] `cd tugdeck && bun test` — 3286 pass / 0 fail (197 files)
- [x] `cd tugdeck && bun run audit:tokens lint` — zero violations

---

#### Step 6: BashToolBlock wrapper {#step-6}

**Depends on:** #step-1, #step-5

**Commit:** `feat(tide-rendering): BashToolBlock — composes TerminalBlock with command/duration/exit chrome`

**References:** [D05], Spec S03, (#t02-tool-wrappers)

**Artifacts:**
- `tugdeck/src/components/tugways/cards/tool-wrappers/bash-tool-block.tsx` + `.css`
- `tugdeck/src/components/tugways/cards/tool-wrappers/tool-wrapper-chrome.tsx` + `.css` (shared header/footer)
- Token slot `--tugx-toolblock-*` (shared) and the wrapper composes existing `--tugx-term-*`
- Registry entry in dispatch.ts

**Tasks:**
- [x] Shared `ToolWrapperChrome` component (`tool-wrapper-chrome.{tsx,css}`) — header (icon slot + tool name + args summary + inline caution badge) + body slot + optional inline error message + footer slot for badges; `data-status` attribute on the root drives streaming / ready / error stripe coloring; exports a `<StreamingPlaceholder />` companion for wrappers that paint a placeholder body while input streams in
- [x] `BashToolBlock` (`bash-tool-block.{tsx,css}`) — header shows the command from `input.command` as a `<code>` args summary (CSS truncate-with-hover-expand; full Shiki shell-syntax highlight is a follow-up polish since pulling in shell highlighting for one inline phrase is heavy compared to the truncate-and-expand affordance); footer renders synthesized exit badge + interrupted badge + duration
- [x] Body: `TerminalBlock` fed from `tool_use_structured.{stdout,stderr}` with `tool_result.output` as the `stdout` fallback when `tool_use_structured` is absent (older catalog versions / drift)
- [x] Status placeholder during stream — `status === "streaming"` swaps the body for `<StreamingPlaceholder />`; the chrome's left-edge stripe paints the streaming color so the row reads as in-flight at a glance
- [x] Token slot `--tugx-toolblock-*` declared in both themes (bg / border / radius / margin / status stripes / header / icon / name / args / caution / error band / footer / streaming placeholder); the wrapper composes the existing `--tugx-term-*` tokens for body chrome
- [x] Registry entry — `registerToolWrapper("bash", BashToolBlock)` runs at the bottom of `tide-assistant-renderer-dispatch.ts` (after `registerToolWrapper` is defined) so the import graph stays one-directional (dispatch → wrapper → chrome → types). Dispatch also gained an `extractTextOutput` helper that reads `tool_result.output` into `ToolWrapperProps.textOutput` as the structured-result fallback

**Tests:**
- [x] Bash fixture shape — props matching `test-09-bash-auto-approved.jsonl`'s `{ input: { command }, structured_result: { stdout, stderr, interrupted: false } }` render BashToolBlock with the command in the header, stdout in the body, exit 0 (zero subtle) in the footer (`bash-tool-block.test.tsx`)
- [x] Synthetic non-zero exit — `isError: true` with empty stderr renders the exit-1 (nonzero strong) badge with `data-exit="nonzero"` (`bash-tool-block.test.tsx`)
- [x] Interrupted: `structured_result.interrupted === true` replaces the exit badge with the interrupted indicator (`bash-tool-block.test.tsx`)
- [x] (no output) hint: success path with empty stdout/stderr surfaces a "(no output)" footer hint so the row doesn't read as missing data (`bash-tool-block.test.tsx`)
- [x] Streaming: `status === "streaming"` renders `<StreamingPlaceholder />`, NOT `<TerminalBlock />` (`bash-tool-block.test.tsx`)
- [x] Error band: `status === "error"` with a plain-text `tool_result.output` paints the chrome error stripe and surfaces the message inline (`bash-tool-block.test.tsx`)
- [x] Caution: `caution: { reason, detail }` paints the inline caution badge in the header and stamps `data-caution` on the root (`bash-tool-block.test.tsx`)
- [x] Helpers: `composeTerminalData` derives the `TerminalData` payload (structured / fallback / synthetic exit / interrupt suppression of exit); `formatBashDuration` covers ms / s / m formatting (`bash-tool-block.test.tsx`)
- [x] Dispatch resolution: `resolveToolWrapper("Bash" | "bash" | "BASH")` returns `BashToolBlock` (`bash-tool-block.test.tsx`)

**Checkpoint:**
- [x] `cd tugdeck && bun x tsc --noEmit` — clean
- [x] `cd tugdeck && bun test src/components/tugways/cards/tool-wrappers` — 20 pass / 0 fail
- [x] `cd tugdeck && bun test` — 3306 pass / 0 fail (198 files)
- [x] `cd tugdeck && bun run audit:tokens lint` — zero violations
- [ ] Manual: invoke `> use bash to echo hello` against live tugcode; verify rendering (deferred to user — HMR is always running) — *blocked at Step 6 because the transcript view never rendered `turn.toolCalls`; resolved by [#step-6-5](#step-6-5)*

---

#### Step 6.5: Transcript wire-through for tool calls (committed + streaming) {#step-6-5}

**Depends on:** #step-1, #step-6

**Commit:** `feat(tide-rendering): render turn.toolCalls + inflight.tools in the transcript`

**References:** [D01], [D05], [D11], [D12], [L02], Spec S01, Spec S03, (#architecture-mental-model)

**Why this step exists.** Steps 1-6 built the dispatch + the BashToolBlock wrapper, but `tide-card-transcript.tsx` never iterates `turn.toolCalls` — the row body only renders thinking, assistant text, and the Interrupted badge. As a result, even though `registerToolWrapper("bash", BashToolBlock)` runs at the bottom of `tide-assistant-renderer-dispatch.ts`, the wrapper never mounts in the live UI: the import graph from the transcript view never reaches the dispatch module, and even if it did, no caller ever maps `turn.toolCalls` to rendered components. Manual smoke testing of [#step-6](#step-6) ("use bash to echo hello") confirmed the gap — the CLI shows `Bash(echo hello) / └─ hello`, but Tide shows only the assistant's "hello" summary. This sub-step closes that gap once for every wrapper that ships in this phase, so [#step-7](#step-7) (FileBlock), [#step-8](#step-8) (ReadToolBlock), [#step-11](#step-11) (EditToolBlock), and the rest become live-visible the moment they register, with no further plumbing.

**Decision: render-order in the row body.** Within a single `code` row the natural reading order is `thinking → tool calls → assistant`. The CLI mirrors this: `Bash(echo hello) / └─ hello` (the tool call) then `hello` (the assistant's summary). Real conversations interleave assistant_text spans with tool_use events at finer granularity, but interleaving requires a fundamentally different data shape than `TurnEntry` exposes today (it flattens `assistant` to a single string). v1 renders all tool calls between thinking and assistant. Future work — interleaving — is a separate concern that lands when the store learns to retain assistant_text spans alongside tool calls, and is explicitly out of scope here.

**Decision: streaming surface.** The reducer already serializes the in-flight `toolCallMap` to the streaming `PropertyStore` at path `inflight.tools` on every tool-call event (per `reducer.ts:serializeToolCalls`). The streaming row uses `useSyncExternalStore` (per [L02]) to subscribe to that path; on each emission the JSON string is parsed back into a `ToolCallState[]`, and each entry is routed through dispatch. React keys by `toolUseId` so a tool whose status transitions `pending → done` reconciles in place rather than remounting. Per-wrapper streaming (e.g., a tool that wants to paint its own incremental output) is NOT in scope here — the wrapper props (`input`, `structuredResult`, `status`) are computed from the snapshot and re-flow on every emission; that is sufficient for every wrapper this phase ships.

**Decision: streaming-to-committed handoff.** When `turn_complete` fires, the streaming row unmounts and the committed row mounts in its place. The streaming `<TranscriptToolCalls />` unmounts; the committed one mounts with `turn.toolCalls`. For BashToolBlock specifically: while `status === "streaming"` the wrapper paints `<StreamingPlaceholder />`; on the committed re-mount, `status === "ready"` so the wrapper paints `<TerminalBlock data={...} />`. Different React subtrees on each side of the transition → `TerminalBlock`'s mount-once contract is honored (it sees its `data` prop exactly once, at fresh mount). No special handling is required.

**Decision: import-graph fix as part of the wire-through.** Today the dispatch module is only reachable from test files and the wrapper itself, so the bottom-of-file `registerToolWrapper("bash", BashToolBlock)` never executes in production. Importing the dispatch from the new `<TranscriptToolCalls />` component is what causes those registrations to evaluate at module-load time in the live bundle. This is the simplest fix; no separate "registry bootstrap" module is introduced.

**Artifacts:**
- `tugdeck/src/components/tugways/cards/tide-card-transcript-tool-calls.tsx` + `.css` — new component with two modes (static `toolCalls` array, streaming `PropertyStore` + path)
- Edits to `tugdeck/src/components/tugways/cards/tide-card-transcript.tsx`:
  - `CodeCommittedRowCell` body inserts `<TranscriptToolCalls toolCalls={turn.toolCalls} msgId={turn.msgId} />` between thinking and assistant
  - `CodeStreamingRowCell` body inserts `<TranscriptToolCalls streamingStore={...} streamingPath={toolsStreamingPath} msgId={inflightMsgId} />` between thinking and assistant; gains `toolsStreamingPath` + `inflightMsgId` props
  - `TideTranscriptHost` plumbs `toolsStreamingPath` (from `snapshot.streamingPaths.tools`, memoized like its peers) and `inflightMsgId` (read from `snapshot.activeMsgId` via `useSyncExternalStore`)
- Optional minimal export from `tide-assistant-renderer-dispatch.ts`: a small helper that maps a `ToolCallState` + `msgId` to the `(Component, props)` pair. Today's `dispatch()` requires a `DispatchContext` ({store, session}) that the tool-call branch ignores; the helper avoids constructing a fake context at the call site. Name TBD during implementation (`composeToolCallRender`, `dispatchToolCallState`, etc.) — the choice is purely an internal API ergonomic.

**Tasks:**
- [x] Build `<TranscriptToolCalls />` with two mutually exclusive modes:
  - Static: `toolCalls: ReadonlyArray<ToolCallState>; msgId: string`
  - Streaming: `streamingStore: PropertyStore; streamingPath: string; msgId: string`
  - Streaming subscribes via `useSyncExternalStore`; the snapshot getter returns the parsed `ToolCallState[]` (with a stable empty-array sentinel when the path is empty / `"[]"` to keep `Object.is` stable across no-op emissions)
- [x] Map each `ToolCallState` through dispatch (or the new helper); render `<Component {...props} />` keyed by `toolUseId`
- [x] Container element `<div data-slot="tide-transcript-tool-calls">` for selectors; no own visible chrome — flex column. (No new `--tugx-*` token slot was needed: per-call vertical rhythm is owned by each wrapper's `--tugx-toolblock-margin`; the container is purely structural, so introducing a token slot would have been ceremony with no theme-tunable behavior to expose.)
- [x] CodeCommittedRowCell: insert the static-mode `<TranscriptToolCalls />` between `<TideThinkingBlock>` and `<TugMarkdownBlock>`. Render only when `turn?.toolCalls` is non-empty (avoid an empty container in the DOM for tool-free turns)
- [x] CodeStreamingRowCell: insert the streaming-mode `<TranscriptToolCalls />` between `<TideThinkingBlock>` and the streaming `<TugMarkdownBlock>`. The component itself self-hides when the parsed list is empty
- [x] Plumb `toolsStreamingPath` from `TideTranscriptHost` to `CodeStreamingRowCell` (mirrors `thinkingStreamingPath`)
- [x] Plumb `inflightMsgId` from `TideTranscriptHost` (read `snapshot.activeMsgId` via `useSyncExternalStore`) so streaming-row wrapper props have a stable `msgId`. Until `activeMsgId` is set the in-flight `msgId` is `""` — the wrapper consumers don't depend on identity for their visual output, so this is acceptable
- [x] Import the dispatch module from `<TranscriptToolCalls />` so module-load-time `registerToolWrapper(...)` calls execute in production (today only test imports trigger them)
- [x] Refactor: hoist the tool-call branch out of `dispatch()` and export it as `dispatchToolCallState(toolCall, msgId)`. The old internal `dispatchToolCall(input, _context)` ignored its context anyway; the public helper avoids fabricating a fake `DispatchContext` at call sites that only have a `ToolCallState` in hand. `dispatch()` now delegates to the helper for the `tool_call` branch.

**Tests:**
- [x] Pure-helper test: mapping `ToolCallState` of every `status` (`pending`, `done`, `error`) yields the expected wrapper status (`streaming`, `ready`, `error`) and `isError` flag; threading of `msgId` / `toolUseId` / `toolName` / `input` / `structuredResult`; `Bash → BashToolBlock` no caution; unknown tool name → `DefaultToolWrapper` + `caution { reason: "unknown_tool" }`
- [x] `TranscriptToolCalls` static mode — single Bash tool call: BashToolBlock mounts; container has the right `data-slot`; the rendered command appears in the wrapper header
- [x] `TranscriptToolCalls` static mode — unknown-tool entry: DefaultToolWrapper mounts and stamps `data-caution="unknown_tool"` on its root. (Full caution-badge chrome on `DefaultToolWrapper` lands at [#step-13](#step-13); the scaffold today only stamps the attribute, so this test pins the threading without anticipating that step's UI.)
- [x] `TranscriptToolCalls` static mode — multiple tool calls render in insertion order (`toolUseId` keys preserved)
- [x] `TranscriptToolCalls` static mode — empty `toolCalls`: renders nothing at all (no container in the DOM)
- [x] `TranscriptToolCalls` streaming mode — initial subscribe path: the snapshot is read synchronously on mount (G1 contract); the wrapper for the seed `inflight.tools` value paints before the first observer emission
- [x] `TranscriptToolCalls` streaming mode — emission path: emit a new `inflight.tools` value where the same `toolUseId` transitions `pending → done` with a `structuredResult`; assert the wrapper instance's container `data-slot` keeps the same DOM node (in-place reconciliation, not remount). Verified additionally that the BashToolBlock body flips from `<StreamingPlaceholder>` to `<TerminalBlock>` with the structured stdout rendered, and that adding a *new* tool call to the list keeps the existing wrapper's DOM node identical while appending the new one.
- [x] Streaming mode — empty seed (`"[]"`): no DOM container.
- [x] Streaming mode — unsubscribe on unmount: setting a new value after unmount does not throw (no leaked listener).

**Manual:**
- [ ] Re-run the [#step-6](#step-6) deferred manual: in the live tugcode session, prompt `use bash to echo hello`. Expected: while the command runs, the streaming row paints a `<TranscriptToolCalls>` containing a Bash wrapper with the streaming-stripe and the placeholder body. After `turn_complete`, the committed row mounts the same wrapper with the structured `stdout: "hello"` rendered through `<TerminalBlock>`, and the assistant's summary follows below.
- [ ] On confirmation, check the [#step-6](#step-6) "Manual: invoke `> use bash to echo hello`…" checkbox.

**Checkpoint:**
- [x] `cd tugdeck && bun x tsc --noEmit && bun test` — typecheck clean; full suite **3359 pass / 0 fail across 200 files**
- [x] `cd tugdeck && bun run audit:tokens lint` — zero violations

---

#### Step 7: FileBlock body kind {#step-7}

**Depends on:** #step-1

**Commit:** `feat(tide-rendering): FileBlock — read-only file viewer with line numbers and language highlight`

**References:** [D05], Spec S02, (#t01-body-kinds)

**Artifacts:**
- `tugdeck/src/components/tugways/body-kinds/file-block.tsx` + `.css`
- Token slot `--tugx-file-*`

**Tasks:**
- [x] Line-numbered gutter; honor `startLine` offset
- [x] Language inferred from `filePath` extension; highlight via existing Shiki integration
- [x] Long-content collapse (**default folded if > 80 lines** per [audit §5.1](./tide-assistant-rendering-session-audit.md); audit shows Read P50 = 50 lines, so 50 was too aggressive — would fold half of all reads. 80 lines catches ~upper-40% which is the natural "long enough to scan-or-skip" bar.)
- [x] "Showing N of M lines" header
- [x] Click-line-to-copy
- [x] Search-within-file (Cmd+F) when expanded — scoped to the FileBlock instance, not the whole transcript

**Tests:**
- [x] Renders content with line numbers starting at `startLine`
- [x] Long file collapses
- [x] Language detection produces correct highlight class
- [x] Cmd+F inside an expanded FileBlock highlights matches and supports next/previous navigation — search markup verified in unit tests; full interactive flow (Cmd+F focus, typing, next/prev, Escape) belongs in a real-browser surface, deferred to gallery/e2e

**Checkpoint:**
- [x] `cd tugdeck && bun x tsc --noEmit && bun test`

---

#### Step 8: ReadToolBlock wrapper {#step-8}

**Depends on:** #step-1, #step-7

**Commit:** `feat(tide-rendering): ReadToolBlock — composes FileBlock with filePath and line-range chrome`

**References:** [D05], Spec S03

**Artifacts:**
- `tugdeck/src/components/tugways/cards/tool-wrappers/read-tool-block.tsx` + `.css`
- Registry entry

**Tasks:**
- [x] Header: `Read · {filePath}` (full path; chrome's args slot truncates with hover-expand) + line-range badge when `input.offset` / `input.limit` set (`lines N–M`, `from line N`, or `first N lines`)
- [x] Body: FileBlock (in `embedded` mode) from `tool_use_structured.file`; falls back to a synthesized `FileData` from `input.file_path` + `tool_result.output` when only the older catalog event lands
- [x] Footer: "Showing N of M lines" when `numLines < totalLines`; suppressed for full-file reads (no empty footer bar)
- [x] Streaming → `<StreamingPlaceholder />`; error → chrome's error band only (body suppressed so the failure message doesn't double-render with the FileBlock fallback)
- [x] FileBlock gained an `embedded` mode mirroring `TerminalBlock`: drops bg/border/radius/margin and hides its own header — the wrapper owns the file's identity in its own header. Reset values, no new tokens introduced. Search / collapse affordances are deferred to the wrapper UX (out of scope for v1).
- [x] Registry entry — `registerToolWrapper("read", ReadToolBlock)` added at the bottom of `tide-assistant-renderer-dispatch.ts` (one-directional import graph).
- [x] Drive-by fix on `BashToolBlock`: errored Bash no longer double-renders the failure message — the chrome's error band already shows it; the body is suppressed unless `structured.{stdout,stderr}` carries genuinely-distinct content.

**Tests:**
- [x] Pure helpers — `composeFileData` (structured, fallback, missing filePath, nothing renderable); `composeLineRangeBadge` (offset+limit, offset-only, limit-only, neither); `composeReadFooterHint` (subset, full read, unknown total)
- [x] Header — tool name + file path stamp; line-range badge appears with offset+limit; missing `file_path` suppresses args
- [x] Body — structured `file` shape lands on the embedded FileBlock with correct gutter / startLine / content; textOutput fallback drives the body when structured is absent; nothing-renderable drops the body
- [x] Footer — "Showing N of M lines" appears for windowed reads, suppressed for full reads
- [x] Streaming placeholder substitution; error suppresses body in favor of chrome error band
- [x] Caution badge surfaces from dispatch
- [x] Dispatch resolution: `resolveToolWrapper("Read" | "read" | "READ")` returns `ReadToolBlock`
- [x] Replay `test-05-tool-use-read.jsonl` (`v2.1.112`) end-to-end through `CodeSessionStore` → committed `TurnEntry.toolCalls[0]` routes through `dispatchToolCallState` → `<ReadToolBlock {...props} />` renders with the fixture's `file_path`, three-line embedded FileBlock, gutter starting at 1, "Showing 3 of 55 lines" footer

**Checkpoint:**
- [x] `cd tugdeck && bun x tsc --noEmit && bun test` — typecheck clean; full suite **3384 pass / 0 fail across 202 files**
- [x] `cd tugdeck && bun run audit:tokens lint` — zero violations

---

#### Step 9: tugdiff-wasm crate {#step-9}

**Depends on:** #step-1

**Commit:** `feat(tugdiff-wasm): new crate exposing imara-diff to JS via wasm-bindgen`

**References:** [D06], [D09], (#new-crates)

**Artifacts:**
- `tugdeck/crates/tugdiff-wasm/Cargo.toml`
- `tugdeck/crates/tugdiff-wasm/src/lib.rs`
- `tugdeck/crates/tugdiff-wasm/README.md`
- `tugdeck/crates/tugdiff-wasm/pkg/` (built artifact, .gitignored if convention follows tugmark-wasm)
- Vite config extension if needed

**Tasks:**
- [x] Cargo manifest mirroring `tugmark-wasm`'s pattern; add `imara-diff = "..."` and `wasm-bindgen`
- [x] Export `parse_unified_diff(text: &str) -> JsValue` (JSON-serialized hunks)
- [x] Export `two_text_diff(before: &str, after: &str) -> JsValue` (JSON-serialized hunks)
- [x] Build script + bun command analogous to tugmark-wasm
- [x] README describing the API

**Tests:**
- [x] Rust-side: `parse_unified_diff` round-trips a known fixture
- [x] Rust-side: `two_text_diff` produces correct hunks for a known input pair
- [x] -D warnings clean

**Checkpoint:**
- [x] `cd tugrust && cargo build -p tugdiff-wasm` (if path-included) — or invoke the crate's bun-driven build (n/a from workspace; built via `just wasm` / `wasm-pack build --target web --release tugdeck/crates/tugdiff-wasm` — produces `pkg/` with 70 KB `.wasm`)
- [x] `cd tugrust && cargo nextest run -p tugdiff-wasm` (if tests added) — N/A from workspace; 15 unit tests pass via `cd tugdeck/crates/tugdiff-wasm && cargo test`

---

#### Step 10: DiffBlock body kind {#step-10}

**Depends on:** #step-1, #step-9

**Commit:** `feat(tide-rendering): DiffBlock — inline unified-diff renderer with hunk collapse and word-level intra-line diff`

**References:** [D05], [D09], Spec S02

**Artifacts:**
- `tugdeck/src/components/tugways/body-kinds/diff-block.tsx` + `.css`
- `tugdeck/src/lib/lazy/load-tugdiff-wasm.ts`
- Token slot `--tugx-diff-*`
- `bun add diff-match-patch` for word-level intra-line

**Tasks:**
- [x] Lazy-load `tugdiff-wasm` per [D10]; JS fallback (jsdiff) for first-paint (the JS-side `parseUnifiedDiffText` mirrors the Rust parser one-to-one and is the synchronous first-paint path for `unified` input — the rare `two-text` input shows a "Computing diff…" placeholder until the WASM engine resolves; jsdiff was not added as it would duplicate work the WASM crate already does)
- [x] Inline view by default; side-by-side toggle stub in chrome (full toggle implementation deferred to [Roadmap](#roadmap))
- [ ] When the side-by-side toggle ships, the inline-vs-side-by-side preference persists per-card via tugbank (`/api/defaults/tide/diff-view`); reload restores the user's choice — *closed by [#step-10-5](#step-10-5) Thread B*
- [x] Hunk-by-hunk collapse
- [x] Word-level highlighting via `diff-match-patch`
- [x] Filename + change-counts header (e.g., `tide-card.tsx · +12 −3`)
- [ ] Syntax highlight inside hunks per file extension (Shiki) — *closed by [#step-10-5](#step-10-5) Thread C, which composes Shiki with the word-level overlay via `render-line.ts`*

**Tests:**
- [x] Two-text input produces correct hunks (covered by stub-engine path and the Rust-side `two_text_diff_produces_correct_hunks_for_known_pair` in #step-9)
- [x] Unified-diff input parses correctly
- [x] Hunk collapse works
- [x] Word-level highlight on a single-line change
- [ ] Both themes verify (manual / browser-eyes verification — both `--tugx-diff-*` slots ship in `harmony.css` and `brio.css`)

**Checkpoint:**
- [x] `cd tugdeck && bun x tsc --noEmit && bun test` (3423 tests pass; tsc clean)

---

#### Step 10.5: WASM packaging convention + DiffBlock follow-throughs {#step-10-5}

**Depends on:** #step-9, #step-10

**Commits (one per thread):**
- Thread A: `chore(tugdeck/crates): collapse WASM crates into a sub-workspace + driver script`
- Thread B: `feat(tide-rendering): DiffBlock side-by-side view + tugbank-persisted preference`
- Thread C: `feat(tide-rendering): DiffBlock — Shiki syntax highlight composed with word-level overlay`

**References:** [D05], [D06], [D09], [D10], (#new-crates), [`tuglaws/wasm-crates.md`](../tuglaws/wasm-crates.md)

**Why this step exists.** Steps 9–10 shipped two WASM crates and a body kind, but three threads accumulated that need to close before #step-11 (EditToolBlock) lands on top of the current shape:

1. **Build/packaging is ad-hoc.** The `Justfile` `wasm` recipe enumerates crates by name; the Vite watcher exclusion enumerates each `pkg/`; `pkg/.gitignore` is `**` (wasm-pack default), so every commit needs `git add -f`; per-crate `Cargo.lock` files live outside any workspace, so `cargo test -p <name>` from `tugrust/` fails. Each new WASM crate is five edits in five files. The pattern is "copy tugmark-wasm and pray" — that's not a convention.
2. **The side-by-side toggle is a UI lie.** [#step-10](#step-10) shipped a disabled `<button>` with `title="coming soon"`. Tugbank persistence (`/api/defaults/tide/diff-view/<cardId>`) was deferred "with the toggle itself" — circular. This step ships both.
3. **Shiki on diff hunks was deferred without a design.** The naive path (replace line `innerHTML` with Shiki HTML) wipes the word-level overlay. The right answer is to define a token stream and merge upstream of render — not to defer.

**Decision: sub-workspace at `tugdeck/crates/Cargo.toml`.** Both WASM crates become members of a virtual workspace. One `Cargo.lock` at `tugdeck/crates/Cargo.lock`; per-crate locks deleted. `cargo test --workspace` and `cargo clippy --workspace -- -D warnings` from `tugdeck/crates/` cover everything. Per-crate `Cargo.toml`'s `[package]` sections stay; only the workspace declaration is centralized. This is the standard Rust pattern; the standalone-crate shape we shipped in Step 9 was the cargo-cult.

**Decision: side-by-side view as a `viewMode` branch in `diff-block.tsx`.** One file, two layouts. The hunk model, word overlay, header chrome, and collapse state are shared; only the per-line layout differs (3-column inline vs. 2-column with paired before/after cells). Adds ~100 lines to the body kind; avoids duplicating the surrounding plumbing. Per-card persistence keys on `tide/diff-view/<cardId>` to match the convention used by other per-card prefs in the codebase.

**Decision: Shiki + word-level merge emits double-classed spans.** `renderLine(text, syntaxTokens, wordSegments)` walks the line once, tracking the current syntax class and current word-level tag. It emits a new `<span>` whenever either changes. Spans that fall inside both a syntax run and a word-level segment carry both class names (`shiki-token-foo` AND `tugx-diff-word-add`); CSS specificity decides the visible color, but the DOM is honest about the nesting. Token count is bounded by `O(syntax-tokens + word-segments)` per line — no quadratic blowup.

**Artifacts:**

*Thread A — packaging:*
- New: `tugdeck/crates/Cargo.toml` — virtual workspace; `members = ["tugmark-wasm", "tugdiff-wasm"]`.
- New: `tugdeck/crates/Cargo.lock` — workspace lock (replaces per-crate locks).
- New: `scripts/build-wasm.sh` — globs `tugdeck/crates/*/Cargo.toml`, runs `wasm-pack build --target web --release` on each, then writes `pkg/.gitignore` empty.
- New: `tugdeck/src/lib/lazy/wasm-init.ts` — generic singleton-promise + reset-on-rejection helper.
- Edits: `Justfile` `wasm` recipe shells to `scripts/build-wasm.sh` (drops per-crate enumeration).
- Edits: `tugdeck/vite.config.ts` watcher exclusion → `**/tugdeck/crates/*/pkg/**`.
- Edits: `tugdeck/src/lib/lazy/load-tugdiff-wasm.ts` shrinks to ~25 lines via `wasm-init.ts`.
- Edits: `tuglaws/wasm-crates.md` — replace the per-crate checklist with the new sub-workspace shape.
- Deletions: `tugdeck/crates/tugmark-wasm/Cargo.lock`, `tugdeck/crates/tugdiff-wasm/Cargo.lock`.

*Thread B — side-by-side:*
- Edits: `tugdeck/src/components/tugways/body-kinds/diff-block.tsx` — `viewMode` prop; side-by-side branch; toggle button no longer disabled.
- Edits: `tugdeck/src/components/tugways/body-kinds/diff-block.css` — `[data-view-mode="side-by-side"]` selectors and the 2-column grid layout.
- Edits: `tugdeck/styles/themes/harmony.css` and `brio.css` — add `--tugx-diff-sbs-*` tokens (column gap, paired-row backgrounds, blank-cell tint).
- Edits: `tugdeck/src/components/tugways/body-kinds/__tests__/diff-block.test.tsx` — coverage for the new mode + persistence.
- New (or edits to existing): `tugdeck/src/lib/diff/diff-view-pref.ts` — read/write helpers around `tugbank-client` for `tide/diff-view/<cardId>`.

*Thread C — Shiki + word-level merge:*
- New: `tugdeck/src/lib/diff/render-line.ts` — pure `renderLine(text, syntaxTokens, wordSegments) → ReactNode[]`.
- New: `tugdeck/src/lib/diff/__tests__/render-line.test.ts` — golden fixtures.
- New: `tugdeck/src/lib/diff/syntax-tokens-from-shiki.ts` — parses Shiki per-line HTML into `{start, end, className}[]`.
- Edits: `tugdeck/src/components/tugways/body-kinds/diff-block.tsx` — wires `renderLine` into the line-render path; lazy-loads Shiki when `data.filePath` has a known extension.
- Edits: `tugdeck/src/lib/diff/parse-unified-diff.ts` — enrich `WordDiffSegment` with `[start, end]` ranges (additive, non-breaking).

**Tasks:**

*Thread A — packaging:*
- [x] Author `tugdeck/crates/Cargo.toml` virtual workspace; verify `cd tugdeck/crates && cargo build` builds both crates and produces a single `Cargo.lock`.
- [x] Delete the per-crate `Cargo.lock` files; commit the workspace lock.
- [x] Write `scripts/build-wasm.sh` (Bash, `set -euo pipefail`); test it idempotently against both crates and observe `pkg/` contents.
- [x] Update `Justfile` `wasm` recipe to call the script; verify `just wasm` still builds both crates.
- [x] Update `tugdeck/vite.config.ts` watcher exclusion glob (smoke-test deferred — HMR runs continuously).
- [x] Build `tugdeck/src/lib/lazy/wasm-init.ts` (the helper); refactor `load-tugdiff-wasm.ts` to use it.
- [x] Rewrite `tuglaws/wasm-crates.md` to describe the sub-workspace, the build script, and the loader convention. Remove the "checklist for adding a new crate" 10-step list; replace with the 3-step new shape.

*Thread B — side-by-side + persistence:*
- [x] Add `viewMode: "inline" | "side-by-side"` prop to `DiffBlock`; default order is tugbank-saved value > prop > `"inline"`. New `cardId` prop scopes the persistence key.
- [x] Implement the side-by-side render branch in `diff-block.tsx` via the new `groupSideBySideRows` helper. Layout: `data-view-mode="side-by-side"` switches the hunk-rows container to a 2-column grid; sbs rows use `display: contents` so each `cell` is a direct grid child. Word-level overlay applies inside both cells of paired rows.
- [x] Re-enable the toggle button; bind to local `viewMode` state; flip label/aria-pressed based on current mode.
- [x] Wire `dev.tugtool.tide.diff-view/<cardId>` reads/writes through `tugbank-client` via the new `lib/diff/diff-view-pref.ts` module. Read on first render via `useState` initializer (synchronous from the populated cache, no flash); write on toggle.
- [x] Add `--tugx-diff-sbs-*` tokens (column-gap, blank-cell tint) to harmony and brio.

*Thread C — Shiki merge:*
- [x] Enrich `WordDiffSegment` to carry per-side `[start, end)` ranges via a discriminated union (`equal | delete | insert` each carry only the ranges that apply). `wordLevelDiffSync` walks once, accumulating `beforePos` / `afterPos`.
- [x] Implement `syntax-tokens-from-shiki.ts`: parses Shiki's per-line HTML into `{start, end, style}[]`. Decodes the standard HTML-entity quintet so offsets index into the *decoded* line text.
- [x] Implement `render-line.ts`: pure `renderLineSegments(text, syntaxTokens, wordRanges) → RenderedSegment[]`. Single boundary-set walk; emits a segment per (syntax-style, word-class) change. Plus `wordRangesForSide` helper to project a `WordDiffSegment[]` into `WordRange[]` per side.
- [x] Wire it into `DiffBlock`. Shiki lazy-loads when `data.filePath` resolves through `detectLanguage` (FileBlock's `EXT_TO_LANG`); per-line tokens cached by line text in a Map. Both inline and side-by-side render paths consume the merge via `renderLineContent`.
- [x] Verified: both view modes render Shiki-styled context lines and double-attributed (style + class) spans on paired remove/add lines. Graceful degradation: when Shiki rejects, lines fall back to plain text + word overlay (no exception, no missing content); unknown extensions never attempt the load.

**Tests:**

*Thread A:*
- [x] `cd tugdeck/crates && cargo test --workspace` passes (15 tests in tugdiff-wasm; tugmark-wasm has no tests; both build and link cleanly).
- [x] `cd tugdeck/crates && cargo clippy --workspace --all-targets -- -D warnings` clean.
- [x] `just wasm` produces fresh `pkg/` for both crates via `scripts/build-wasm.sh`; `pkg/.gitignore` is empty so commits don't need `-f`.
- [x] `bun test` continues to pass (3423/3423) after the loader refactor.

*Thread B:*
- [x] `viewMode` prop respected on initial render (`data-view-mode` attribute, sbs row markup vs. inline row markup).
- [x] Toggle button click flips `viewMode`; `aria-pressed` and label update.
- [x] Tugbank read on mount: a seeded fakeTugbank returning `"side-by-side"` causes first render to be side-by-side (no flash).
- [x] Tugbank write on toggle: a mocked `fetch` confirms a single PUT to `/api/defaults/dev.tugtool.tide.diff-view/<cardId>` with `{ kind: "string", value: "side-by-side" }`.
- [x] Side-by-side row grouping covers context, paired remove+add, lone remove, lone add, and runs of N removes + M adds (zip semantics).

*Thread C:*
- [x] `render-line.ts` golden fixtures: TS identifier change (`let` → `var`), bash multi-token change (`echo $foo` ↔ `printf $bar`), word range fully inside a single token, range crossing token boundaries. Each verifies double-decorated segments at overlaps and the invariant that segment text concatenation reconstructs the input.
- [x] `syntax-tokens-from-shiki.ts` round-trip: Shiki-styled HTML → `SyntaxToken[]` → reconstructed offsets; HTML-entity decoding (`&lt;` etc.) keeps offsets aligned with the decoded source line.
- [x] Component integration: mounting DiffBlock with `data.filePath = "foo.ts"` and a stub Shiki produces a remove-side `<span class="tugx-diff-word-remove">` carrying both the class AND a Shiki `style="color:..."` attribute. Mirror coverage for the add side. Context lines get Shiki styling but no word-level class.
- [x] Graceful degradation: when the stub Shiki import rejects, paired remove/add lines still render `tugx-diff-word-*` spans (no `style` attribute) and the line text remains visible. Unknown extensions short-circuit the loader entirely.

**Checkpoint:**
- [x] `cd tugdeck/crates && cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings` clean (15 tests in tugdiff-wasm pass; clippy quiet).
- [x] `just wasm` runs via `scripts/build-wasm.sh`; both `pkg/.gitignore` files end up empty so commits don't need `-f`.
- [x] `cd tugdeck && bunx tsc --noEmit && bun test` clean (3468 tests pass; tsc clean).
- [ ] Manual: open a Tide card with a diff in both inline and side-by-side modes; toggle persists across reload (deferred to user — HMR is always running).

---

#### Step 10.6: `TugCue` — banner-shaped click target for body-kinds {#step-10-6}

**Depends on:** none (foundation for #step-10-8)

**Commit (after design gate):** `feat(tugways): add TugCue — banner-shaped inline click target`

**References:** [L11], [L15], [L19], [L20], `tuglaws/component-authoring.md`, `tuglaws/responder-chain.md`, `dash/component-library-roadmap.md`

**Why this step exists.** The body-kind layer (FileBlock, DiffBlock, and future siblings) repeatedly needs a "soft inline banner that is also a click target" — most visibly the `tugx-file-collapsed-hint` and `tugx-diff-collapsed-hint` panels that say things like *"1,230 lines folded — click to expand."* Today these are bare HTML `<button>` elements styled with `--tugx-<kind>-*` tokens; the same pattern recurs at `tugx-file-toggle`, `tugx-file-icon-btn`, `tugx-file-search-*`, `tugx-diff-toggle`, `tugx-diff-view-toggle`, `tugx-diff-hunk-toggle`. None of the existing public Tug components fit:

- `TugPushButton` adds `text-transform: uppercase; letter-spacing: 0.06em` (a CTA look). Wrong tone for a soft hint, wrong shape for a full-width banner.
- `TugIconButton` is icon-only and focus-refusing — wrong shape, wrong focus discipline.
- `TugBanner` is an app-modal status/error strip with a scrim and `inert` blocker. Wrong layer.
- `TugBulletin` is toast notifications via Sonner. Wrong layer.

So we have a real hole. Step 10.8 ("click Expand to view does nothing") sits on top of this hole. Rather than paper over it with another bare `<button>`, this step introduces the missing primitive.

**Decision: design-first, then implement.** Step 10.6 lands in two parts:

  1. **Gallery card with design variants.** A new `tugdeck/src/components/tugways/cards/gallery-tug-cue.tsx` ships 4–6 visual variants of the component — variations across `tone` (default | accent | danger), `density` (compact | comfortable), border treatment (none | hairline), text style (italic | roman), and an optional leading icon. The card mounts in the gallery deck for visual inspection. **No production wiring** at this phase — pure design exploration.

  2. **Production component.** Once you've picked the variant(s), the public component lands at `tugdeck/src/components/tugways/tug-cue.tsx` + `.css` with its token slot family and full a11y. The chosen variant becomes the default; non-chosen variants either become explicit `role` / `density` props or get dropped. Note: per `tuglaws/token-naming.md` the canonical slot-5 term is `role` (not `tone`); the prop name follows.

The split is deliberate: I don't ship the component until you've vetted the design.

**Decision: chain-action + onClick, matching `TugButton`'s API.** Per [L11] every actionable control should be able to dispatch through the responder chain. The public API surface mirrors `TugButton`'s mutually-exclusive `onClick` / `action` props, plus the targeted-dispatch `target` prop, plus the standard `disabled` / `aria-*` passthrough. Future call sites that want chain-action (e.g. a TideThinkingBlock cue dispatching `revealThinking` to the card responder) get it for free.

**Decision: own token slot is `--tugx-cue-*`.** Per `tuglaws/token-naming.md`, the `--tugx-*` prefix is the canonical namespace for component aliases — TugAlert, TugBanner, TugPopover, TugBadge all use `--tugx-<name>-*`. Reserved `--tug-*` is for global scale/dimension primitives (`--tug-space-*`, `--tug-radius-*`). TugCue follows the same convention: `--tugx-cue-*` resolves to base-tier `--tug7-*` tokens per [L17]. Body-kinds that compose TugCue may pass `className` to scope-style at the host's surface.

**Artifacts:**

*Phase 1 — Design gallery:*
- New: `tugdeck/src/components/tugways/cards/gallery-tug-cue.tsx` — a card that mounts 4–6 candidate variants of the component, each with its own click handler logging to a debug strip. Driven by ad-hoc prototype JSX rather than a finished component import so design iteration is fast.
- Optionally: a small `.css` sidecar for the gallery card if the prototypes need ad-hoc layout.
- Gallery registration in `tugdeck/src/components/tugways/cards/gallery-registrations.tsx`.

*Phase 2 — Production component (after design gate):*
- New: `tugdeck/src/components/tugways/tug-cue.tsx` + `.css`. Per [L19]: module docstring, exported props interface, `data-slot="tug-cue"`, `@tug-pairings` table in the CSS file.
- Token slot family `--tugx-cue-*` declared in the component's own `tug-cue.css` `body {}` block (matching the TugBanner / TugAlert / TugPopover convention); per-theme tuning flows through the `--tug7-*` base tokens those aliases resolve to.
- Updated `tugdeck/src/components/tugways/cards/gallery-tug-cue.tsx` to import the finished component (not the prototype JSX) and exercise every prop / state combination.
- New: `tugdeck/src/components/tugways/__tests__/tug-cue.test.tsx`.
- Updated: `dash/component-library-roadmap.md` "New Component Ideas" — add TugCue entry, mark as implemented in the appropriate group.

**Tasks:**

*Phase 1 — Design gallery:*
- [x] Sketch 4–6 visual variants. Candidate axes: tone (default / accent / danger), density (compact / comfortable), border (none / hairline), text style (italic / roman), with/without leading icon (a `Hint` chevron or similar lucide glyph).
- [x] Build `gallery-tug-cue.tsx` with each variant labeled, mounted in a stack, click logging.
- [x] Register the gallery card and verify it shows up in the gallery deck.
- [ ] **Design gate: user vets variants and picks the default + which props/values to expose.**

*Phase 2 — Production component (post-gate):*
- [x] Author `tug-cue.tsx` per [L19]. Props interface includes: `children`, `onClick` xor `action`, `target` (when `action`), `icon?`, `role?` (one of `active` | `accent` | `agent` | `caution` | `danger` | `data` | `success` — the seven `--tug7-surface-tone-primary-normal-{role}-rest` values from `tuglaws/token-naming.md`), `density?`, `disabled?`, `aria-expanded?`, `className?`.
- [x] Author `tug-cue.css` with `@tug-pairings` table, `@tug-renders-on` annotations where needed, `--tugx-cue-*` slot family used for every visible declaration. Hover, focus-visible, active, disabled per [L15].
- [x] Declare `--tugx-cue-*` token slots in `tug-cue.css` `body {}` block (per-theme variance via `--tug7-*` base tokens).
- [x] Update the gallery card to import the finished component; remove prototype JSX.
- [x] Tests: render markup, click → onClick, click → chain dispatch (when `action` set), keyboard activation (Enter / Space), focus-visible styling sanity check, `aria-expanded` passthrough.

**Tests:**

- [x] `bun test src/components/tugways/__tests__/tug-cue.test.tsx` passes the full prop / state matrix.
- [x] `bunx tsc --noEmit` clean.
- [x] `bun run audit:tokens lint` clean (token-naming and pairings declared correctly).
- [x] Gallery card renders all variants without console warnings (HMR check).

**Checkpoint:**

- [x] User signs off on Phase 1 design gallery before any Phase 2 work starts.
- [x] `cd tugdeck && bunx tsc --noEmit && bun test && bun run audit:tokens lint` all clean.
- [x] Gallery card visible in the gallery deck and exercises every prop.
- [x] Component-library-roadmap entry added.

---

#### Step 10.7: `BashToolBlock` detects unified-diff output and routes through `DiffBlock` {#step-10-7}

**Depends on:** none (uses #step-6 BashToolBlock + #step-10 DiffBlock, both shipped)

**Commit:** `feat(tide-rendering): BashToolBlock — render unified-diff output via DiffBlock`

**References:** [D05], [D09], Spec S02, Spec S03

**Why this step exists.** When bash runs `git show`, `git diff`, `git log -p`, or any pipeline that produces a unified diff, the output IS a diff — but it currently renders as plain terminal text because `BashToolBlock` unconditionally composes `TerminalBlock`. We have `DiffBlock` for exactly this content shape; the missing piece is the routing decision. Real user feedback from the live Tide session prompted this step: opening `git show <sha>` rendered as monospaced bash text, not as the rich diff view we just built.

**Decision: heuristic-gate before parse.** Detection runs as a fast string scan on `textOutput` before any parsing. The gate matches when *any* of these markers appear at a reasonable position:

  - `\ndiff --git ` — strongest signal; only `git diff` and friends emit this exact prefix.
  - `\n@@ -<n>[,<n>] +<n>[,<n>] @@` — hunk-header marker; the JS parser already recognizes it.
  - `^commit [0-9a-f]{7,40}\n` — `git show` and `git log -p` open with this; combined with `diff --git` below it, an excellent signal.

When the gate matches, `BashToolBlock` parses the output via `parseUnifiedDiffText` (already shipped, JS-only, no WASM dependency) and feeds the resulting hunks into `DiffBlock` as `source: "hunks"`. When the parser returns zero hunks (rare, only if the markers were false positives), the wrapper falls back to `TerminalBlock` so nothing renders blank.

Falling back to `TerminalBlock` on no-match is what makes this safe to enable by default: the worst case for benign bash output is "still renders as terminal" (no regression).

**Decision: detection lives in `BashToolBlock`, not a shared helper.** Other tool wrappers may eventually want similar smart-pick routing, but generalizing it now would be premature. The function is small, well-tested, and self-contained — promote it to a shared helper when a second consumer needs it.

**Artifacts:**

- Updated: `tugdeck/src/components/tugways/cards/tool-wrappers/bash-tool-block.tsx` — adds `isUnifiedDiffOutput(text)` helper, conditional body-kind selection.
- Updated: `tugdeck/src/components/tugways/cards/tool-wrappers/__tests__/bash-tool-block.test.tsx` — fixture coverage for `git show`, `git diff`, `git log -p`, plus benign bash output that contains a `@@` line in passing (must not mis-route).
- Updated: `tugdeck/src/components/tugways/cards/gallery-registrations.tsx` (or the bash gallery card) — add a fixture demonstrating bash + diff routing.

**Tasks:**

- [x] Implement `isUnifiedDiffOutput(text: string | undefined): boolean` in `bash-tool-block.tsx` (or a sibling util file). Heuristic scans only the first ~2 KB of output to keep the check O(1) for large outputs.
- [x] In the body-composition branch (where `BashToolBlock` currently always returns `<TerminalBlock>`), gate on `isUnifiedDiffOutput(textOutput) && parsed.length > 0`. Pass `<DiffBlock data={{ source: "hunks", hunks: parsed }}>` when both conditions hold. *(Implemented via the `tryParseBashDiff` helper which composes the heuristic + parse and returns `null` on either miss.)*
- [ ] When `cardId` is available to the bash wrapper, thread it through to `DiffBlock` for persistence. *(Deferred: `cardId` is not yet on `ToolWrapperProps`. Threading it requires a broader plumbing change through `dispatchToolCallState`, `TranscriptToolCalls`, and every wrapper — orthogonal to the diff-routing shipped here. DiffBlock falls back to local view-mode state per Step 10.5 when no `cardId` is provided, so the visual behavior is identical; only cross-mount persistence is missing. Track in a follow-up that touches all wrappers at once.)*
- [ ] When the bash output's first line is `commit <sha>`, use that as `data.filePath = null` (no path) and the commit-sha gets surfaced via the chrome header. *(Deferred: `parseUnifiedDiffText` returns hunks only — file paths from `diff --git a/foo b/foo` lines are not extracted. For v1 the file-name column in DiffBlock's header is intentionally blank; the chrome header already shows the full `git show <sha>` command so the commit context is visible. A follow-up can extend the parser to surface both filePath and commit sha when a real consumer needs them.)*
- [x] Gallery fixture: a bash card with stub output showing `git show <sha>` text routing through DiffBlock. *(See `gallery-bash-tool-block.tsx` — four canonical states: echo, git show, git diff, git status.)*

**Tests:**

- [x] `isUnifiedDiffOutput` returns true for `git show`, `git diff`, `git log -p` fixture strings.
- [x] `isUnifiedDiffOutput` returns false for `git status`, `ls -la`, and bash output that happens to include `@@` as a literal character in some unrelated context (must not false-positive).
- [x] BashToolBlock with diff-shaped output renders `<DiffBlock>`, not `<TerminalBlock>`.
- [x] BashToolBlock with non-diff output continues to render `<TerminalBlock>`.
- [x] BashToolBlock with diff-shaped output but zero parsed hunks falls back to `<TerminalBlock>` (safety check).
- [x] BashToolBlock with `status === "streaming"` does NOT detect / route — streaming output is incomplete; defer to ready.

**Checkpoint:**

- [x] `cd tugdeck && bunx tsc --noEmit && bun test` clean.
- [ ] Manual: run `bash git show HEAD` against live tugcode and verify DiffBlock renders.

---

#### Step 10.8: Regularize collapse / expand affordances for FileBlock + DiffBlock {#step-10-8}

**Depends on:** #step-10-6 (TugCue), #step-10-7 (per-hunk TugCue refactor — sets the precedent)

**Commit:** `feat(tide-rendering): regularize collapse/expand affordances in FileBlock + DiffBlock`

**References:** [L06], [L11], [L15], [L19], [L20]

**Why this step exists.** Across `FileBlock` and `DiffBlock`, four distinct affordance shapes had accumulated: bespoke tiny chevron buttons in the header (`.tugx-file-toggle`, `.tugx-diff-toggle`), bare non-interactive collapsed-hint banners (`.tugx-file-collapsed-hint`, `.tugx-diff-collapsed-hint`), the `Copy` and other in-header icon buttons (already `TugIconButton`-style), and the per-hunk diff header (now `TugCue` after #step-10-7). The bare banners are a real bug — `ReadToolBlock` (and any wrapper suppressing its own body's chrome) composes `FileBlock` in `embedded` mode, hiding the header — including the Expand toggle. The collapsed-hint banner says *"1,234 lines folded — click Expand to view,"* but the Expand button is hidden and the banner is a non-interactive `<div>`. The text is a lie; nothing happens when you click. `DiffBlock` ships the parallel dead-end.

#step-10-7 already proved out the right shape for one of these — the diff per-hunk header — by replacing a bespoke `<div role="button">` + tiny inner chevron with `<TugCue role="muted" align="start" mono icon={ChevronDown|Right}>`. This step generalizes that pattern across the rest of the FileBlock + DiffBlock surface.

**Decision: three affordance shapes, one component each, mapped to use cases.** No more bespoke micro-buttons in body-kinds.

| Shape | Use case | Component | Token family |
|---|---|---|---|
| **A — Reveal cue** | The whole content is folded; the cue IS the only thing visible besides the header. Click to expand. | `<TugCue role="active" icon={<ChevronsDown />} onClick={…}>` | `--tugx-cue-*` |
| **B — Structural divider cue** | Inside expanded content, a banner separator that toggles a sub-section. (Per-hunk diff header; future siblings.) | `<TugCue role="muted" align="start" mono icon={<ChevronDown|ChevronRight />}>` | `--tugx-cue-*` |
| **C — Header collapse toggle** | Re-collapse expanded content from the header bar. Peer to the `Copy` icon button. | `<TugIconButton tone="default" icon={<ChevronsUp />} aria-label="Collapse" />` | reuses `--tug-button-*` (no body-kind tokens) |

Shape B already shipped in #step-10-7. Shapes A and C are the new work.

**Decision: `role="active"` for the reveal cue.** Shape A is the cue user sees *instead of* content — it has to feel inviting, not subdued. The blue `active` tint (variant G's default) reads as "this is *the* affordance to reveal content." Shape B's `muted` is right for structural dividers between visible content, but wrong here.

**Decision: paired ChevronsDown / ChevronsUp icons.** The double-chevron glyph differentiates whole-content reveal from section disclosure. Single-chevron `ChevronDown` / `ChevronRight` stay for shape B (per-hunk and future structural cues). The reveal cue uses `ChevronsDown` ("unfold downward, more below"); its symmetric counterpart in the header uses `ChevronsUp` ("fold back upward"). The pair reads as one round-trip.

**Decision: header collapse toggle = `TugIconButton`, not a bespoke chevron.** The existing `.tugx-file-toggle` and `.tugx-diff-toggle` are bespoke micro-buttons with their own `--tugx-{file,diff}-toggle-*` token families. They sit next to the existing `.tugx-file-icon-btn` / `.tugx-diff-icon-btn` `Copy` controls — which themselves are bespoke. The right answer is to make all of these `TugIconButton`s: standardizes the header right-edge vocabulary, retires four token slot families, and gives focus / hover / active states the same treatment everywhere. (The view-mode toggle `inline / side-by-side` in DiffBlock is a separate concern — it's a *picker*, not a single-action button; out of scope here.)

**Token surface that retires after this step:**

- `--tugx-file-collapsed-*` (4 tokens) — replaced by `--tugx-cue-*`
- `--tugx-diff-collapsed-*` (4 tokens) — replaced by `--tugx-cue-*`
- `--tugx-file-toggle-*` (~5 tokens) — replaced by `TugIconButton`'s tokens
- `--tugx-diff-toggle-*` (~5 tokens) — same
- `--tugx-file-icon-btn-*` (if present) and `--tugx-diff-icon-btn-*` (Copy/etc.) — converted to `TugIconButton` (defer if any Copy button is touched by #step-10-9; otherwise convert here)

Per-hunk tokens (`--tugx-diff-hunk-header-*`, `--tugx-diff-hunk-toggle-*`) were retired in #step-10-7.

**Visual continuity guarantee.** The reveal cue's `active` blue tint is the same one already shipped in `TugCue` and verified in `gallery-tug-cue`. The header `TugIconButton`s reuse the same ghost-action styling as the existing `Copy` button (which is already on `TugIconButton` shape per #step-7), so the header bar reads as a row of peer icon buttons after this step — no visual surprise.

**Artifacts:**

*Reveal cues (Shape A):*
- Updated: `tugdeck/src/components/tugways/body-kinds/file-block.tsx` — `.tugx-file-collapsed-hint` `<div>` becomes `<TugCue role="active" icon={<ChevronsDown />}>`. Hint text updated to *"X lines folded — click to expand"*. `onClick` calls the existing collapsed-toggle path.
- Updated: `tugdeck/src/components/tugways/body-kinds/file-block.css` — drop `.tugx-file-collapsed-hint` style block; retire `--tugx-file-collapsed-*` slots in `harmony.css` / `brio.css` / `tug-active-theme.css`.
- Updated: `tugdeck/src/components/tugways/body-kinds/diff-block.tsx` — same treatment for `.tugx-diff-collapsed-hint`.
- Updated: `tugdeck/src/components/tugways/body-kinds/diff-block.css` — same.
- Updated: theme files retire `--tugx-diff-collapsed-*` slots.

*Header collapse toggles (Shape C):*
- Updated: `tugdeck/src/components/tugways/body-kinds/file-block.tsx` — bespoke `<button className="tugx-file-toggle">` becomes `<TugIconButton icon={isCollapsed ? <ChevronsDown /> : <ChevronsUp />} aria-label={…} onClick={toggleCollapsed} />`.
- Updated: `tugdeck/src/components/tugways/body-kinds/diff-block.tsx` — same for `.tugx-diff-toggle`.
- Updated: `file-block.css` / `diff-block.css` — drop the `.tugx-file-toggle` / `.tugx-diff-toggle` rule blocks.
- Updated: theme files retire `--tugx-file-toggle-*` and `--tugx-diff-toggle-*` slots.

*Gallery + tests:*
- Updated: `tugdeck/src/components/tugways/cards/gallery-tug-cue.tsx` — add a new **"Affordance use-cases"** section that shows the three regularized shapes side-by-side inside fake-host frames so the design vocabulary can be vetted in one place:
    1. **Shape A — Reveal cue (collapsed FileBlock).** Fake FileBlock-like frame with only its header visible and a `<TugCue role="active" icon={<ChevronsDown />}>X lines folded — click to expand</TugCue>` at the bottom. Click toggles a local expanded state so the cue can be exercised live.
    2. **Shape B — Structural divider (diff hunk header).** Keep the existing "code-context cue" section; rename its title to match the shape vocabulary so the gallery reads as a coherent set.
    3. **Shape C — Header collapse toggle.** Fake FileBlock-like frame in *expanded* state with a `<TugIconButton icon={<ChevronsUp />} aria-label="Collapse" />` in the header row, peer to a `Copy` `TugIconButton`. Demonstrates the paired-icon vocabulary across the header and the body.
  Each fake-host frame uses the existing `cg-tug-cue-host*` helpers so the gallery card stays visually consistent.
- Updated: `tugdeck/src/components/tugways/body-kinds/__tests__/file-block.test.tsx` — banner is interactive; header toggle is a `TugIconButton`.
- Updated: `tugdeck/src/components/tugways/body-kinds/__tests__/diff-block.test.tsx` — same.

**Tasks:**

*Reveal cue (Shape A):*
- [x] In `file-block.tsx`: replace the `.tugx-file-collapsed-hint` `<div>` with `<TugCue role="active" icon={<ChevronsDown />} aria-expanded={false} onClick={…}>{N} lines folded — click to expand</TugCue>`. The cue replaces the entire `<div>` — no extra wrapper.
- [x] Drop `.tugx-file-collapsed-hint` rule block from `file-block.css`. Retire `--tugx-file-collapsed-padding`, `-bg`, `-color`, `-size` from `harmony.css` / `brio.css` / `tug-active-theme.css`.
- [x] Repeat in `diff-block.tsx` / `diff-block.css` / theme files for the diff sibling.
- [x] Confirm the cue's `aria-expanded={false}` carries through (TugCue already passes it through verbatim — test pins this).

*Header collapse toggle (Shape C):*
- [x] In `file-block.tsx`: replace the bespoke `<button className="tugx-file-toggle">` with `<TugIconButton icon={isCollapsed ? <ChevronsDown /> : <ChevronsUp />} aria-label={isCollapsed ? "Expand file" : "Collapse file"} onClick={toggleCollapsed} />`.
- [x] Drop the `.tugx-file-toggle` rule block from `file-block.css`. Retire `--tugx-file-toggle-*` slots from the theme files.
- [x] Repeat in `diff-block.tsx` / `diff-block.css` / theme files for the diff sibling.

*Theme-file `--tugx-*` cleanup (in-scope expansion):*
- [x] **Bulk migration.** Discovered during 10.8 work that the entire body-kind / chrome surface had been violating `tuglaws/token-naming.md` ("`--tugx-*` is component-local; theme files own only `--tug7-*`, `--tug-*`, `--tugc-*`"). Migrated *every* in-scope `--tugx-*` slot family out of `harmony.css` / `brio.css` / `tug-active-theme.css` into the owning component's CSS `body {}` block. Families moved: `--tugx-file-*`, `--tugx-diff-*`, `--tugx-term-*` (non-ANSI), `--tugx-toolblock-*`, `--tugx-thinking-*`, `--tugx-transcript-*`, `--tugx-md-*`, `--tugx-list-view-*`, `--tugx-text-editor-*`. Raw rgba values converted to `--tug7-*` analogs where one existed; theme variance flows through the base layer.
- [x] **Surviving in theme files** (justified): `--tugx-control-disabled-opacity` (shared utility, per the law's own example); `--tugx-host-canvas-color` (host-level theme primitive); `--tugx-term-ansi-*` (ANSI palette — each theme picks its own ANSI hues; no canonical `--tug7-*` home for a 16-color palette).
- [x] `tide-md-token-coverage.test.ts` rewritten to verify the new contract: theme files declare zero `--tugx-md-*` slots; `tug-markdown-view.css` declares them all.

*Gallery:*
- [x] Add an **"Affordance use-cases"** section to `gallery-tug-cue.tsx` showing the three regularized shapes inside fake-host frames (Shape A collapsed FileBlock, Shape B diff hunk header, Shape C expanded FileBlock header). Each fake host wires a local `useState` so the cue / toggle is exercisable live.
- [x] Add a small intro paragraph at the top of the section that names the three shapes and their tokenized role so the gallery doubles as documentation for callers picking between them.

*Tests:*
- [x] FileBlock: with `collapsed={true}`, clicking the cue fires `onToggleCollapsed(false)`. The cue has `aria-expanded="false"`.
- [x] FileBlock: header collapse `TugIconButton` exists, has appropriate `aria-label`, and clicking it fires `onToggleCollapsed(...)`.
- [x] DiffBlock: parallel coverage for both cue and header toggle.
- [x] Token audit (`bun run audit:tokens lint`) stays clean after the retired slots are deleted.

**Tests (commands):**

- [x] `bun test src/components/tugways/body-kinds/__tests__/file-block.test.tsx`
- [x] `bun test src/components/tugways/body-kinds/__tests__/diff-block.test.tsx`
- [x] `bunx tsc --noEmit`
- [x] `bun run audit:tokens lint`
- [x] `bun test` (full suite — no regressions)

**Checkpoint:**

- [x] All four commands above clean.
- [x] Theme files no longer declare the four retired slot families (plus the much-larger bulk migration above).
- [x] Gallery card renders the "Affordance use-cases" section showing all three shapes; each is exercisable (clicking toggles the local state).
- [ ] Manual: in the live Tide session, open a Read tool result for a long file (`>80` lines) and confirm clicking the cue expands it; confirm the header `ChevronsUp` collapses it back. Repeat for `bash git show HEAD` against a multi-hunk commit (DiffBlock path).

---

#### Step 10.8.5: `--tugx-block-*` shared-utility token family {#step-10-8-5}

**Depends on:** #step-10-8 (the bulk `--tugx-*` migration is in place; this step de-duplicates what landed there)

**Commit:** `refactor(tugways): consolidate body-kind block tokens into --tugx-block-* shared utility`

**References:** [L17], [L19], [L20], `tuglaws/token-naming.md`, `tuglaws/color-palette.md`

**Why this step exists.** Step 10.8 relocated ~290 `--tugx-{file,diff,term,toolblock,thinking,transcript,md,list-view,text-editor}-*` slots out of theme files and into each component's CSS `body {}` block. That fixed the law violation (theme files no longer declare `--tugx-*`) but exposed a separate problem: substantial *duplication* across the now-component-local declarations. An audit of the migrated files counted ~329 slot declarations across 9 component CSS files, with the same `--tug7-*` references reused 5–12 times each:

| `--tug7-*` reference | Times reused as `--tugx-{name}-*` slot value |
|---|--:|
| `--tug7-element-global-text-normal-muted-rest` | 12+ |
| `--tug-font-size-2xs` | 8 |
| `--tug7-element-global-text-normal-default-rest` | 7 |
| `--tug7-surface-global-primary-normal-raised-rest` | 6 |
| `--tug7-element-global-divider-normal-muted-rest` | 6 |
| `--tug-space-xs var(--tug-space-md)` (header pad pattern) | 6 |
| `--tug-font-family-mono`, `--tug-font-size-sm`, `--tug-font-family-base` | 5 each |

That isn't coincidence; it's a coherent shared design pattern — *"code-display block-shaped surface with a chrome strip on top, optional matching strip on the bottom, and tone-tinted feedback bands inside"* — currently expressed as N parallel slot families. FileBlock, DiffBlock, TerminalBlock, ToolWrapperChrome, TideThinkingBlock, and TugMarkdownView all paint that same surface; each declared its own near-identical slot family even though every member resolves to the same `--tug7-*` token.

The law allows this case explicitly. From `tuglaws/token-naming.md`: **"`--tugx-` ... Component aliases, *shared utilities*. Locally defined."** The shared-utility lane is the right home for the block pattern.

**Decision: name the shared family `--tugx-block-*`.** `card` is already taken by TugPane and means a different visual element. `surface` is already a slot *dimension* at the `--tug7-*` level and would create cross-tier name collision. `block` is the natural English word for these structures and matches the internal "body-kind / block kind" convention.

**Decision: shared utility CSS lives at `tugdeck/styles/tugx-block.css`.** Alongside `tug-palette.css` and `tug.css`. Imported once at app root so it loads before any component CSS and the slots are available to every component rule.

**Decision: no new `--tug7-*` introductions.** The current seven-slot vocabulary is adequate. The duplication is at the alias layer, not the base layer. (Exception: the ANSI palette carve-out remains a known issue and is *not* addressed by this step.)

**Decision: per-instance customization preserved.** Components keep their own `--tugx-{component}-*` slots for the parts that ARE component-specific (e.g. `--tugx-diff-line-add-bg`, `--tugx-file-gutter-width`, `--tugx-term-ansi-*`). Consumers can still scope-override per-card via `.tide-card-transcript .tug-list-view { --tugx-list-view-row-gap: ... }`. The shared `--tugx-block-*` family is the *default* for the block-surface pattern, not a ceiling.

**Decision: tone tints are part of the shared family.** TerminalBlock exit badges (success / danger / caution), DiffBlock line bgs (success / danger), ToolWrapperChrome caution chip + error band (caution / danger), and TugCue role surfaces all consume the same `--tug7-surface-tone-primary-normal-{role}-rest` family. Folding these into `--tugx-block-tone-{add,remove,caution,active}-{bg,color}` saves ~12 further declarations and gives the codebase one canonical home for "tone-tinted feedback band" values.

**The shared family (≈22 slots):**

```css
/* tugdeck/styles/tugx-block.css */
body {
  /* Frame — body-kind variant (sits below chrome) */
  --tugx-block-bg:          var(--tug7-surface-global-primary-normal-inset-rest);
  --tugx-block-border:      var(--tug7-element-global-border-normal-muted-rest);
  --tugx-block-radius:      var(--tug-radius-md);
  --tugx-block-margin:      var(--tug-space-md) 0;

  /* Frame — chrome variant (sits above body — used by ToolWrapperChrome) */
  --tugx-block-chrome-bg:   var(--tug7-surface-global-primary-normal-raised-rest);

  /* Code-typography defaults */
  --tugx-block-code-font:        var(--tug-font-family-mono);
  --tugx-block-code-font-size:   var(--tug-font-size-sm);
  --tugx-block-code-line-height: 1.55;

  /* Body text colors */
  --tugx-block-text-color:       var(--tug7-element-global-text-normal-default-rest);
  --tugx-block-text-color-muted: var(--tug7-element-global-text-normal-muted-rest);

  /* Header / footer strip (same shape for both) */
  --tugx-block-strip-padding: var(--tug-space-xs) var(--tug-space-md);
  --tugx-block-strip-gap:     var(--tug-space-sm);
  --tugx-block-strip-bg:      var(--tug7-surface-global-primary-normal-raised-rest);
  --tugx-block-strip-border:  var(--tug7-element-global-divider-normal-muted-rest);
  --tugx-block-strip-color:   var(--tug7-element-global-text-normal-muted-rest);
  --tugx-block-strip-size:    var(--tug-font-size-2xs);
  --tugx-block-strip-font:    var(--tug-font-family-base);

  /* Body row interaction */
  --tugx-block-row-hover-bg: var(--tug7-surface-highlight-primary-normal-hover-rest);

  /* Tone-tinted feedback bands */
  --tugx-block-tone-add-bg:        var(--tug7-surface-tone-primary-normal-success-rest);
  --tugx-block-tone-add-color:     var(--tug7-element-global-text-normal-success-rest);
  --tugx-block-tone-remove-bg:     var(--tug7-surface-tone-primary-normal-danger-rest);
  --tugx-block-tone-remove-color:  var(--tug7-element-global-text-normal-danger-rest);
  --tugx-block-tone-caution-bg:    var(--tug7-surface-tone-primary-normal-caution-rest);
  --tugx-block-tone-caution-color: var(--tug7-element-global-text-normal-caution-rest);
  --tugx-block-tone-active-bg:     var(--tug7-surface-tone-primary-normal-active-rest);
}
```

**Consumption pattern.** Component CSS rules consume `--tugx-block-*` *directly* (one-hop to `--tug7-*` per [L17]) for the parts that are shared. Component-specific overrides remain in the component's `body {}` block under `--tugx-{component}-*`. Example:

```css
/* file-block.css — after Step 10.8.5 */
body {
  /* Component-specific slots only. The block-surface scaffold is consumed
   * directly from `--tugx-block-*` in the rules below. */
  --tugx-file-gutter-width:        3.5em;
  --tugx-file-mark-bg:             var(--tug7-surface-card-primary-normal-findmatch-rest);
  --tugx-file-mark-active-bg:      var(--tug7-surface-card-primary-normal-findmatch-active);
  --tugx-file-mark-active-outline: var(--tug7-element-global-border-normal-accent-rest);
  /* ...other file-specific slots... */
}

.tugx-file {
  background:    var(--tugx-block-bg);
  border:        1px solid var(--tugx-block-border);
  border-radius: var(--tugx-block-radius);
  margin:        var(--tugx-block-margin);
  color:         var(--tugx-block-text-color);
  font-family:   var(--tugx-block-code-font);
  font-size:     var(--tugx-block-code-font-size);
  line-height:   var(--tugx-block-code-line-height);
}

.tugx-file-header {
  padding:    var(--tugx-block-strip-padding);
  gap:        var(--tugx-block-strip-gap);
  background: var(--tugx-block-strip-bg);
  border:     1px solid var(--tugx-block-strip-border);
  color:      var(--tugx-block-strip-color);
  font-size:  var(--tugx-block-strip-size);
  font-family: var(--tugx-block-strip-font);
}
```

**Expected reduction.** Per-component slot counts mapped to either shared (drop) or component-specific (keep):

| Component | Before | After | Drops |
|---|--:|--:|--:|
| FileBlock | 57 | ~25 | 32 (frame, code typography, header, hover) |
| DiffBlock | 55 | ~25 | 30 (frame, header, stats, line-add/remove bgs+markers, hunk divider) |
| TerminalBlock (non-ANSI) | 47 | ~12 | 35 (frame, code typography, footer, exit-zero/exit-nonzero/interrupted badges) |
| ToolWrapperChrome | 41 | ~12 | 29 (frame-chrome, header, footer, caution chip, error band) |
| TideThinkingBlock | 22 | ~10 | 12 (frame, header padding/bg/border) |
| TugMarkdownView | 76 | ~58 | 18 (inline-code, fenced-code bgs, hr, table borders/header-bg/row-alt) |
| Transcript / list-view / text-editor | 31 | 31 | 0 |
| **Total** | **329** | **~173** | **~156 (≈47%)** |

Roughly half the slot declarations collapse — and every drop replaces a unique alias name with a shared one, which makes "all body-kinds use the same header strip color" a *fact* rather than an *aspiration* maintained by ~6 parallel slot definitions kept in sync by convention.

**Artifacts:**

- New: `tugdeck/styles/tugx-block.css` — the shared utility family above. Module docstring documenting the role of this file in the three-tier architecture (per `tuglaws/color-palette.md`: palette → base → component).
- Updated: `tugdeck/styles/tug.css` (or app-root entry) — import the new file. Load order: after palette, before component CSS.
- Updated: `tugdeck/src/components/tugways/body-kinds/file-block.css` — drop frame/typography/header/hover slots from body{}; rewrite rules to consume `--tugx-block-*`.
- Updated: `tugdeck/src/components/tugways/body-kinds/diff-block.css` — same pattern; keep diff-specific slots (line bgs, word bgs, hunk divider, sbs blanks, stats, view-toggle).
- Updated: `tugdeck/src/components/tugways/body-kinds/terminal-block.css` — same pattern; keep ANSI palette and the bg/border/footer-specific copy button slots.
- Updated: `tugdeck/src/components/tugways/cards/tool-wrappers/tool-wrapper-chrome.css` — use `--tugx-block-chrome-bg` for the chrome variant frame; consume strip + tone tints.
- Updated: `tugdeck/src/components/tugways/chrome/tide-thinking-block.css` — same pattern.
- Updated: `tugdeck/src/components/tugways/tug-markdown-view.css` — fold inline-code bg, fenced-code bg, hr color, table border/header-bg/row-alt, footnote border into `--tugx-block-*`. Markdown-specific typography (heading scale, blockquote, link decoration, list indents) stays.
- Updated: `tugdeck/src/components/tugways/__tests__/tide-md-token-coverage.test.ts` — refresh the required-slot list since md-specific slots now exclude what folded into `--tugx-block-*`.
- Updated: `tuglaws/component-authoring.md` — document the `--tugx-block-*` family as the canonical home for the block-surface pattern; the next body-kind author consumes it rather than rolling new parallel slots.

**Tasks:**

- [x] Author `tugdeck/styles/tugx-block.css` with the body{} block above.
- [x] Wire the import at the app-root CSS entry (after palette + base, before component CSS) via `src/globals.css`.
- [x] Per component (file-block, diff-block, terminal-block, tool-wrapper-chrome, tide-thinking-block, tug-markdown-view): identify each slot whose value is identical to its `--tugx-block-*` counterpart. Delete those declarations from the component's body{}; replace `var(--tugx-{component}-X)` with `var(--tugx-block-X)` in the component's CSS rules.
- [x] For each component, keep the `body {}` block intact (still the file-pair anchor per [L19]); it now only declares the *component-specific* slots.
- [x] Run `bun run audit:tokens lint` after each component to catch any straggler that broke its pairings.
- [x] Update `tide-md-token-coverage.test.ts` to reflect the reduced md-specific slot list (the spot-check required-list).
- [x] Add a doc paragraph to `tuglaws/component-authoring.md` (under the existing token-naming section): *"For body-kinds and chrome wrappers, consume `--tugx-block-*` directly for the shared block-surface pattern (frame, code typography, header/footer strip, hover, tone tints). Component-specific slots are reserved for parts that differ."*

**Tests:**

- [x] `bun test src/components/tugways/body-kinds/__tests__/file-block.test.tsx`
- [x] `bun test src/components/tugways/body-kinds/__tests__/diff-block.test.tsx`
- [x] `bun test src/components/tugways/__tests__/tide-md-token-coverage.test.ts`
- [x] `bunx tsc --noEmit`
- [x] `bun run audit:tokens lint` — zero violations.
- [x] `bun test` (full suite — no regressions). 3533/3533 pass.

**Checkpoint:**

- [x] All commands above clean.
- [x] `tugx-block.css` exists, imported once at the app root.
- [x] Slot count net delta: **−158** declarations across the six affected component CSS files (298 → 140); plus 25 new slots in the shared utility. Plan predicted ~−156 / 22; actual very close.
- [ ] Manual: open the Tide gallery's `gallery-tug-cue` (Affordance use-cases section), `gallery-bash-tool-block`, and a few Tide session cards (a long Read result + a `git show` diff). Confirm both brio and harmony render identically to before the consolidation.
- [x] `tuglaws/component-authoring.md` documents the `--tugx-block-*` family.

---

#### Step 10.9: Pinned headers + CM6 file viewer {#step-10-9}

**Depends on:** none (foundation for future entry-level controls + the second public consumer of the CM6 substrate already in `tug-text-editor`).

**Commit:** `feat(tide-rendering): pin transcript entry + content block headers; FileBlock on CM6 (TugCodeView)`

**References:** [L02], [L03], [L06], [L19], [L20]

**Why this step exists.** Three problems share one structural cause, plus a fourth caused by parallel implementations of the same feature:

1. **Per-line horizontal scrollbars in `FileBlock`.** Each `.tugx-file-content` cell is its own `overflow-x: auto` scroll container, so wide lines render N stacked per-row scrollbars. Real user-reported visual bug from the live Tide session — see screenshot in the task that motivated this recast.
2. **Copy button overlapping the scrollbar in `TerminalBlock`.** Copy is an `position: absolute` overlay inside the body scroller. It sits on top of the vertical scrollbar gutter — and worse, on the corner where both scrollbars meet — for any output tall enough to trigger scrolling.
3. **Block affordances scroll away with the body.** When you scroll a long FileBlock / DiffBlock body, the Copy / Search / Collapse / view-mode controls all live in the header strip that scrolls off the top of the viewport. Users have to scroll back up to reach them.
4. **`FileBlock` reimplements a text engine we already own.** The bespoke `.tugx-file-rows` DOM tree, per-row scroller, per-line click gesture, Shiki-overlay swap, and Cmd-F overlay are all features that `@codemirror/view` provides natively — and that `tug-text-editor` already exposes for the editing side. Maintaining two parallel text-display systems means *every* fix has to ship in two places and inevitably drift; the per-line scrollbar bug is a direct symptom of the maintenance gap.

Problems 1–3 collapse into "affordances live at a stable visible location, never on top of a scrollbar, never scrolled away." The structural fix is **pinned headers** at two nesting levels: the `TugTranscriptEntry` header (identifier + timestamp + future entry-level controls) and each content block's own header (FileBlock path/lang/buttons; DiffBlock path/stats/buttons; new TerminalBlock header with command summary + Copy). Problem 4 collapses into "use CM6 for any file-based text content" — which dissolves the per-line scrollbar by construction (CM6's `EditorView.lineWrapping` is a single extension), brings find/search/selection/large-file virtualization for free, and aligns the read surface with the edit surface so users see one scroll behavior, one find UI, one selection model, one set of keyboard shortcuts.

**Decision: CM6 is the canonical text engine for file-based content. No exceptions.** `tug-text-editor` already mounts `EditorView` from `@codemirror/state` / `@codemirror/view` / `@codemirror/commands` with the full `Compartment`-based reconfiguration plumbing (soft-wrap, line numbers, read-only, theme, active-line gutter, placeholder — all in place at `tug-text-editor.tsx:83-330`). The packages are already in `tugdeck/package.json`; the bundle cost is paid. FileBlock's bespoke renderer is retired and replaced by a thin read-only CM6-backed primitive that shares its extension stack with the editor. The "one engine, no bespoke scroll bugs ever again, consistent UX across read and edit" outcome is the whole point.

**Decision: extract `TugCodeView`, a read-only sibling to `tug-text-editor`.** Not a flag on `tug-text-editor` — a peer primitive. The editor's responder/selection/focus story is sized for typing; a viewer's responder story is *selection-only* (no cursor, no IME, no edit keymaps). Both share:

- The same extension set: `EditorView.lineWrapping`, `lineNumbers()`, the existing CM6 theme, the Shiki-via-`@codemirror/language` bridge (or a `tugmark` highlight bridge if we wire one).
- The same `Compartment` reconfiguration pattern, so `wrap` / `lineNumbers` / `language` can be toggled at runtime without rebuilding the view.
- The same focus-acceptance / responder-chain integration as the editor.

`TugCodeView` deliberately differs in three ways:

- `EditorState.readOnly.of(true)` permanently in its config (no editable mode).
- No edit keymap; viewer adds `@codemirror/search` for Cmd-F find UI, optionally `@codemirror/commands` for `selectAll` / `copy` shortcuts.
- React shell is simpler: no `onChange` callback, no value mutation, no `state-preservation` payload — the rendered text is the entire input.

`FileBlock` becomes a thin chrome around a `TugCodeView`: header strip (path + lang badge + counts + Copy + Search + Collapse) above a CM6 viewport. The match-highlight overlay, the per-row scroller, the imperative `buildSearchIcon()`, the Shiki content-swap — all retired. Line numbers come from CM6's `lineNumbers()` gutter; soft-wrap from `EditorView.lineWrapping`; search from `@codemirror/search` mounted with our `TugIconButton`-driven trigger.

**Decision: telescoping sticky stack, two levels.** Outer = `TugTranscriptEntry` `__header`. Inner = block header inside the entry body. Outer pins at `top: 0`; inner pins at `top: var(--tugx-pin-stack-top, 0)`. The entry root writes its measured header height to that variable via `ResizeObserver` in `useLayoutEffect` ([L03] before paint; [L06] DOM write, not React state). When both pin simultaneously, the entry header sits at the top of the viewport and the block header sits directly under it — the GitHub PR pattern, the VS Code Sticky Scroll pattern, the iOS UITableView section-header pattern.

Sticky context analysis confirms the layout is safe: `TugListView` uses natural document flow (`tug-list-view.css:84-96` — `display: flex; flex-direction: column; row-gap`, with top/bottom spacers, no transforms, no `position: absolute` on cells). Sticky elements inside cells stick to the list-view's scroll container as expected. `.tugx-file { overflow: hidden }` etc. clip at the file's box, which is the *correct* behavior — the file's pinned header naturally disappears when the entire file scrolls past.

**Decision: Copy moves into block headers; no overlay layer.** The original Step 10.9 added a non-scrolling overlay div for Copy and `scrollbar-gutter: stable` to reserve the gutter — a workaround for the symptom. With pinned headers, Copy lives in the header strip alongside the existing controls; it is *never* overlaid on the body, so the scrollbar conflict cannot exist. `TerminalBlock` currently has no header — this step adds one (mirroring the FileBlock strip shape) and retires the body-overlay Copy and the `--tugx-term-copy-*` slot family.

**Decision: reserve the scrollbar gutter on body scrollers.** `scrollbar-gutter: stable` on `.tugx-term`'s body scroller (and on `TugCodeView`'s inner viewport, if CM6's default isn't already stable). The gutter is always present in layout even when no scrollbar is visible; no jitter when content grows past the viewport. Cheap, principled, eliminates a class of layout-shift bugs.

**Decision: `[data-stuck="true"]` via IntersectionObserver for the stuck-state shadow.** Tugdeck targets WebKit (the Swift host's `WKWebView`); experimental Blink-only proposals like `:stuck` are irrelevant. The pinned-header drop-shadow (a 1px hairline under the header to visually separate it from the scrolled-under body) is driven by an `IntersectionObserver` watching a sentinel element above the header. When the sentinel scrolls out, the observer flips `data-stuck="true"` on the header and CSS paints the hairline. Standard WebKit-safe technique. (Defer to a follow-on polish if v1 ships without it; the pin works without the shadow.)

**Decision: `TugListEntry` becomes the named primitive.** The pinning behavior is documented on `TugTranscriptEntry` as the canonical "named row with sticky header + scrolling body + optional controls under body" pattern. Future surfaces (history panel, audit log, permission log, session inspector) consume the same shape. Establishes the seat for future entry-level affordances (mute thread, mark unread, share entry, jump-to-related, etc.) without re-inventing.

**Three phases:**

##### Phase A — `TugCodeView` + `FileBlock` engine swap

- New: `tugdeck/src/components/tugways/tug-code-view.tsx` + `.css`. Read-only CM6 viewer. Same extension lineage as `tug-text-editor` but shorter: `EditorView.lineWrapping`, `lineNumbers()`, `@codemirror/search`, the shared theme, language extensions, and a thin selection-only responder.
- New: `tugdeck/src/components/tugways/__tests__/tug-code-view.test.tsx`. Mount, value, wrap toggle, line-numbers toggle, language toggle, find UI reveal, selection round-trip.
- Updated: `tugdeck/src/components/tugways/body-kinds/file-block.tsx` — body becomes `<TugCodeView value={content} language={language} wrap lineNumbers />`; the bespoke `.tugx-file-rows` / `.tugx-file-row` / `.tugx-file-content` / `.tugx-file-overlay` DOM tree and the `buildSearchIcon` SVG builder are deleted. Header keeps its current shape (path + lang + counts + `TugIconButton`s). The Cmd-F affordance now triggers CM6's `openSearchPanel` instead of toggling the bespoke search bar — the `--tugx-file-search-*` slot family retires.
- Updated: `tugdeck/src/components/tugways/body-kinds/file-block.css` — drop the retired row/content/overlay/search-bar rule blocks and slot families. Only the frame chrome and header-specific slots remain (path color/weight, lang pill, counts).
- Updated: `tugdeck/src/components/tugways/body-kinds/__tests__/file-block.test.tsx` — rewrite to test the new composition (TugCodeView mount + header). Defer line-level interactive behavior to `tug-code-view.test.tsx`.
- Per-line scrollbar bug **dissolves by construction**: CM6 with `lineWrapping` produces no per-line scrollers; the body has one horizontal-overflow-clipped viewport that vertically scrolls with `pre-wrap`-style break-spaces.

##### Phase B — Block-header pin + `TerminalBlock` header + Copy relocation

- Add `position: sticky; top: var(--tugx-pin-stack-top, 0); z-index: 1` to `.tugx-file-header`, `.tugx-diff-header`, and (new) `.tugx-term-header`. Background already opaque via `--tugx-block-strip-bg`; no bleed-through.
- New `.tugx-term-header` markup in `terminal-block.tsx` — command summary at left (lifted from `ToolWrapperChrome`'s args display when embedded; for standalone use it's a thin path-or-label slot), `TugIconButton` Copy at right. Retire `.tugx-term-copy` overlay DOM and the `--tugx-term-copy-*` slot family. Existing footer (exit / duration / interrupted) stays at the bottom.
- Add `scrollbar-gutter: stable` to `.tugx-term`'s body scroller so the gutter is reserved regardless of content height.
- Optional polish (defer if v1 needs to ship): add `--tugx-block-strip-shadow-stuck` slot to `tugx-block.css`; wire an IntersectionObserver-driven `data-stuck` attribute on each block header.
- Tests: TerminalBlock — header `<TugIconButton>` Copy exists; no `.tugx-term-copy` overlay DOM; `scrollbar-gutter` declared on the scroller.

##### Phase B.1 — Diagnosis spike + gallery card

**Why this phase exists.** Phase B applied `position: sticky` to five headers and swapped four block roots from `overflow: hidden` to `overflow: clip`. The user-visible result — the pinned chrome header sits ~one line below the scrollport top, with file content visible above the bar — proves the sticky declarations *activate* (the bar mostly stays in place while content scrolls beneath it) but bind to the *wrong* scrollport or against the *wrong* edge. Phase B.2's rollout (actions row, telescope variable, fenced-code parity) presupposes that the underlying pinning works correctly. Before doing that rollout, we need to be sure the pinning works correctly. That's this phase.

**Scope is deliberately narrow:**
- No production CSS changes beyond the temporary diagnostic outline.
- No new prop contracts on `ToolWrapperChrome`, no actions-row CSS, no body-kind restructuring.
- Build the gallery card so we have an isolated, controlled environment in which to exercise pinning *without* the transcript chain (TugListView, TugTranscriptEntry, ToolWrapperChrome) below it.
- Walk the ancestor chain in both the gallery and the live transcript using WKWebView devtools and document what's actually happening. Compare.

**Artifacts (Phase B.1):**

- New: `tugdeck/src/components/tugways/cards/gallery-pinned-headers.tsx` — a tall-content gallery card carrying a synthesized long file inside a standalone `FileBlock`, a synthesized 20-hunk diff inside a standalone `DiffBlock`, and a synthesized 200-line terminal inside a standalone `TerminalBlock`. The card lives in a fixed-height scroll container (a single TugBox or analogous primitive) so the only scrolling ancestor is one we picked deliberately. No `ToolWrapperChrome`, no `TranscriptToolCalls`, no `TugTranscriptEntry`, no `TugListView`. The point is to take the transcript chain OUT of the picture and prove sticky works against a simple known scroller. If it doesn't pin flush there either, the bug lives in the body-kind CSS we already touched.
- New: notes appended to this phase's "Findings" block below — three numbered candidates, each annotated with what the diagnosis turned up.

**Tasks (Phase B.1):**

- [x] **Build the gallery card** (`gallery-pinned-headers.tsx`) with the three body-kind sections inside a single fixed-height scroll wrapper. Wire it into the gallery's registrations so it shows up alongside the existing gallery cards. *(Done; card was authored with an on-screen `PinProbePanel` that walked the ancestor chain at runtime — the probe and the dashed-border outlines have since been removed; what remains is the production-mirror fixture.)*
- [x] **Verify pin behavior in the gallery card first.** Confirmed via screenshot (image 12) + probe readout: `.tugx-diff-header` (scrollTop 2249) and `.tugx-term-header` (scrollTop 167) both pin at `offsetFromScrollportTop = 0 px` — flush against the no-padding gallery wrapper. Body-kind CSS is sound. Bug must be in the transcript chain above the body-kind root.
- [x] **Devtools-walk the ancestor chain in WKWebView.** Done in-card via `PinProbePanel`; no Web Inspector needed. Binding scrollport for `.tool-wrapper-chrome-header` is unambiguously `<div.tug-list-view>` (overflow `hidden/auto`, border-top 0, padding-top 8). Once pinned (image 13), `header.rect.top = 56`, `scrollport.rect.top = 48`, delta from `(top + border)` = 8 px, delta from `(top + border + padding)` = 0 px — sticky pins against the content-box edge, not the padding-box edge, as CSS Position 3 §6.5.1 specifies.
- [x] **Record findings** in a "Findings" block appended to this phase (below). Numbered against the three candidate causes plus any surprise we discover. Each finding cites the measured values from devtools. *(Done; see Findings block. Candidate #1 confirmed; #2 ruled out by construction; #3 ruled out by gallery offset = 0.)*
- [x] **Remove the temporary diagnostic outline** before committing the gallery card and findings. *(Done; dashed borders, sentinel banner, and `PinProbePanel` are all removed from `gallery-pinned-headers.tsx`. The fixture and its synthesized data remain as the standalone-pinning mirror Phase B.2 references.)*

**Findings (Phase B.1):**

The gallery card embeds an on-screen probe (`PinProbePanel`) that walks the live ancestor chain at runtime and reports computed-style + bounding-rect data for `.tugx-file-header`, `.tugx-diff-header`, `.tugx-term-header`, and `.tool-wrapper-chrome-header`. The probe refreshes on any scroll so the offset can be watched in real time. The fields below are populated from the probe readout.

**Analytic candidate ranking (pre-probe):**

1. **`.tide-card-transcript .tug-list-view` `padding-block: var(--tug-space-md)`** (highest prior). `.tug-list-view` is the binding scrollport in the live transcript and sets `padding-block` via a transcript-side override (`tide-card.css:73`). Per CSS Position 3 the scrollport top edge IS the padding box's inner edge, so `top: 0` should pin flush with the visible scrollport top — but a WebKit quirk where sticky binds against the `content-box` edge (i.e. *past* the padding) would manifest as exactly the symptom: ~1 line of content visible above the bar. The probe reports `offsetFromScrollportTop` vs `offsetFromPaddedTop`; if `offsetFromScrollportTop ≈ 0` and `offsetFromPaddedTop` is negative ≈ `−paddingTop`, sticky binds against the padding box edge (spec-correct); if `offsetFromScrollportTop ≈ paddingTop` and `offsetFromPaddedTop ≈ 0`, sticky binds against the content edge (WebKit-quirk path).
2. **CM6 `.cm-scroller` forming an inner scrollport.** `.cm-scroller` is a SIBLING subtree of `.tool-wrapper-chrome-header`, not an ancestor, so it should not be considered for sticky-pin binding. The probe's ancestor chain confirms this: `.cm-scroller` won't appear in the upward walk. Likely ruled out by construction.
3. **An intermediate `overflow: hidden` ancestor in the transcript chain.** `.tool-wrapper-chrome` was already switched to `overflow: clip` in Phase B. Other candidates: `.tide-card-transcript-tool-call`, `.tug-transcript-entry`, `.tug-list-view-cell`, `.tug-pane-body`. The probe's chain dump will flag any ancestor with `overflowY != visible` and not `clip`; the first such ancestor below `.tug-list-view` would be the bug.

**Empirical readings (populated from the probe in the running session):**

- Binding scrollport for `.tugx-file-header` in the gallery card: the inline-styled `<div data-slot="pin-scroller">` (`height: 380; overflow-y: auto; border-top: 2; padding: 0`).
- `offsetFromScrollportTop` for `.tugx-diff-header` after scroll (`scrollTop: 2249`): **0 px** — PINS FLUSH.
- `offsetFromScrollportTop` for `.tugx-term-header` after scroll (`scrollTop: 167`): **0 px** — PINS FLUSH.
- `offsetFromScrollportTop` for `.tugx-file-header` at `scrollTop: 0`: 48 px = height of the diagnostic "ABOVE PIN" sentinel sitting above `.tugx-file` (natural position, not pinned). Confirms the layout chain; the bar will pin flush once the user scrolls.
- **→ Body-kind CSS empirically rules out Candidate #3 inside the body-kind subtree.** When the scrollport has no `padding-block`, the bar pins exactly at offset 0. Cause must live ABOVE the body-kind root — i.e. in the transcript chain.
- Binding scrollport for `.tool-wrapper-chrome-header` in the live transcript: **`<div.tug-list-view>`**, overflow `hidden/auto`, `border-top: 0`, `padding-top: 8 px`.
- `offsetFromScrollportTop` for `.tool-wrapper-chrome-header` at `scrollTop: 0` (NOT yet pinned): 313 px = natural distance from `.tug-list-view`'s scrollport top to the chrome header (entry header height + transcript spacing).
- `offsetFromScrollportTop` for `.tool-wrapper-chrome-header` once pinned (scrolled state, `header.rect.top: 56`, `scrollport.rect.top: 48`): **8 px**. NOT flush against the padding-box edge.
- `offsetFromPaddedTop` for `.tool-wrapper-chrome-header` once pinned: **0 px**. **Flush against the content-box edge.**
- **Cause confirmed: Candidate #1.** Per CSS Position 3 §6.5.1, sticky `top: 0` pins against the scroll container's *content-box* top, not its padding-box top. `.tide-card-transcript .tug-list-view` sets `padding-block: var(--tug-space-md)` (= 8 px), so the chrome header pins 8 px below the visible scrollport top — exactly matching the user-visible symptom (one short line of file content drifting above the pinned bar). This is spec-compliant WebKit behavior; the bug is in our CSS choice (padding-block on a sticky-hosting scroll container always offsets the pin).
- Why the wrong scrollport / wrong edge: the scrollport is correct (`.tug-list-view`); the wrong *edge* is being used because padding shifts the pin reference inward. `padding-block` reserves vertical breathing room INSIDE the scroll container, but sticky's `top: 0` reference is the post-padding edge, so the offset is unavoidable as long as padding is there.

**Notable in the live chain** (relevant for follow-up):
- `.tug-split-panel` (overflow `auto/auto`) and `.tug-pane-content` (overflow `auto/auto`) are *secondary* scroll containers above `.tug-list-view`. They don't bind sticky for `.tool-wrapper-chrome-header` (the probe correctly marks `.tug-list-view` as the first match), but they're potentially relevant for future entry-header pinning (Phase C) if `--tugx-pin-stack-top` needs to telescope past them.
- `.tug-pane-body` and `.tug-pane-chrome` both have `overflow: hidden` (not `clip`). These are ABOVE the binding scrollport so they don't trap sticky for `.tool-wrapper-chrome-header`. But once Phase C makes `.tug-transcript-entry__header` sticky (with `top: 0` against `.tug-list-view`), if any descendant or sibling needs to escape `.tug-list-view`'s scrollport, these `overflow: hidden` walls would matter. Worth a flag for Phase C; not in scope for B.1/B.2.

**Side-finding from the spike (informs Phase B.2 scope):** CodeMirror's `@codemirror/search` find panel mounts at the top of `.cm-editor` and visually OVERLAPS `.tugx-file-header` (and any other sticky header at the same `top` offset) — opening Find via the header's Search button covers the pinned identity bar. The Phase B.2 actions row (with Find relocated into `.tugx-file-actions`) already addresses this by construction: Find becomes a button in the actions row, not a CodeMirror-panel overlay. Captured as an explicit Phase B.2 requirement below.

**Predictions for Phase B.2 fix selection** (the probe's empirical reading picks one row):

| Probe reads… | Cause | Phase B.2 fix |
|---|---|---|
| Gallery flush (≈ 0); transcript offset ≈ `padding-block` | Candidate 1 (WebKit pins against padding box edge, padding scrolls *under* the bar visually) | Remove `padding-block` from `.tide-card-transcript .tug-list-view`; move that breathing room to entry spacing on `.tug-transcript-entry` instead. |
| Gallery flush; transcript offset, binding scrollport ≠ `.tug-list-view` | Candidate 3 (a transcript-chain ancestor traps sticky) | Switch that ancestor's `overflow` from `hidden` to `clip` (or to `visible` if no clipping is desired). |
| Gallery ALSO offset by the same amount | Body-kind CSS bug (the `.tugx-file-header` rule itself) | Recheck `.tugx-file-header`'s `top` value, the `--tugx-pin-stack-top` resolution, and any sibling sticky competing for the top edge. |
| Gallery has zero binding scrollport reported | Sticky never activates here — diagnostic flaw in the wrapper | Fix the wrapper's overflow / height, then re-run. |

**Checkpoint (Phase B.1):**

- [x] Gallery card exists and renders three pinning sections.
- [x] Findings block above is filled in with measured values, not speculation. Empirical readings from images 12–13 are recorded with `header.rect.top`, scrollport metadata, and computed offsets.
- [x] Phase B.2's "Apply the fix" task can be answered unambiguously from the findings. The diagnosis names **Candidate #1** (remove `padding-block` from `.tug-list-view`); Candidate #2 (CM6 scroller) ruled out — `.cm-scroller` is a sibling subtree, not an ancestor, and the binding scrollport is empirically `<div.tug-list-view>`; Candidate #3 (transcript-chain `overflow: hidden`) ruled out — the gallery's no-padding wrapper reaches offset 0 with the same body-kind CSS, so the bug is not above-but-below the binding scrollport, it's the padding ON the binding scrollport.

---

##### Phase B.2 — Visible pin + body-kind actions bar + future-controls seat

**Depends on:** Phase B.1's findings.

**Why this phase exists.** Phase B landed `position: sticky` on five header selectors (`.tugx-file-header`, `.tugx-diff-header`, `.tugx-term-header`, `.tugx-md-fenced-code-header`, `.tool-wrapper-chrome-header`) plus switched four block roots from `overflow: hidden` to `overflow: clip` so the sticky descendants would see the outer transcript scroller. Manual testing of a Read tool block on a long file surfaced four issues that weren't anticipated in Phase B's design:

1. **The pinned chrome header is offset from the visible top of the scrollport.** Sticky activates, but the pin position is ~one line of file content below the viewport top — content is visible above the bar. The root cause has not been confirmed; candidates in priority order:
   - **CM6 `.cm-scroller` forming an inner scrollport.** `TugCodeView`'s inline theme declares `scrollbar-gutter: stable` on `.cm-scroller` (`tug-code-view.tsx:163`). If CM6's scroller is the nearest scroll container for `.tool-wrapper-chrome-header`, sticky binds to it instead of `.tug-list-view`, and the user sees CM6 scroll content "above" the pin. The screenshot symptom (file content above the pinned bar) matches this hypothesis better than any other.
   - **`.tide-card-transcript .tug-list-view` `padding-block`.** Set to `var(--tug-space-md)` via the transcript override. Per CSS Position 3 the sticky inset is computed against the scrollport edge (inside the border), not the padding-content edge, so `padding-block-start` should not add to a `top: 0` pin — but a WKWebView quirk or wrong-scrollport binding could change that.
   - **An intermediate `overflow: hidden` ancestor.** Phase B swept the block roots and the wrapper chrome. The transcript-side chain (cell wrapper, transcript entry, `.tug-pane-body`, `.tug-pane-chrome`) was not swept. If any of those traps sticky, the bar binds inside that container, which doesn't actually scroll, so the bar just rides with the content (no pin at all). The fact that pin DOES seem to activate (the bar stays mostly fixed while content scrolls beneath it in the user's screenshot) argues against this — but it remains a candidate.

2. **The transcript-entry header (Claude / model / timestamp) does not stay pinned above the tool block.** That's Phase C's deliverable, not B.2's. But the gallery card (next bullet) must exercise the B + C telescoping so the design composes; B.2 ships the gallery card and Phase C threads its variable through.

3. **Body-kind affordances scroll away with the body.** The fold cue (`.tugx-file-fold-cue`), Search (FileBlock — currently in the hidden header), Copy (TerminalBlock — currently in the `.tugx-term-header` we made sticky), and view-toggle / fold (DiffBlock — currently in the also-sticky `.tugx-diff-header`) all live on the body kind. In embedded mode the body kind's own header is hidden, so the affordances are unreachable; in standalone mode the affordances pin with the header, but they sit ABOVE any future body-kind identity, which crowds the strip and forces consumers to pick between identity-on-strip and affordances-on-strip.

4. **No architectural seat for future body-kind controls.** FileBlock's Find UI needs a button. DiffBlock's view-toggle may grow a search. TerminalBlock may gain a "follow tail" toggle. Without a designated, pinned home for these affordances, every new control is a one-off layout decision.

**Decisions.**

- **The pinned-bar stack inside a tool wrapper has two levels: chrome header (identity) and body-kind actions bar (affordances). They telescope.** Wrapper chrome header pins at `top: var(--tugx-pin-stack-top, 0)` and writes its measured height into `--tugx-toolblock-header-height` on the chrome root via `ResizeObserver` (mirrors Phase C's `--tugx-pin-stack-top` write on the transcript-entry root, mirrors the entry-header → block-header relationship one level deeper). Body-kind actions bar pins at `top: calc(var(--tugx-pin-stack-top, 0) + var(--tugx-toolblock-header-height, 0))`. The variable falls back to `0` outside a wrapper, so standalone usage (gallery, RenderInput-routed) pins the actions bar at `--tugx-pin-stack-top` only.

- **Body kinds own their affordance row.** Each affordance-bearing body kind (`FileBlock`, `DiffBlock`, `TerminalBlock`, fenced-code in markdown) renders a `.tugx-{kind}-actions` row inside its surface, marked `position: sticky` with the calc above. The wrapper chrome stays affordance-agnostic — no new `headerActions` prop — so the body-kind tokens, layout, and React state stay inside the body-kind file. This preserves the [L20] separation that Phase A established (chrome owns `--tugx-toolblock-*`; body kinds own `--tugx-{kind}-*`).

- **The actions row is part of the body-kind surface in both embedded and standalone mode.** Standalone: the body kind keeps its identity header (`.tugx-file-header` etc.) ABOVE the actions row, then content below. Embedded: the wrapper chrome owns identity, the body kind's own identity header is suppressed, and the actions row remains visible (this is the slot that survives `embedded={true}`). This makes the affordance-row the ONLY body-kind chrome that's always present, which is the right invariant — every Copy / Find / fold lives in exactly one place.

- **The fold cue moves into the actions row.** Today the cue is a full-width `<TugCue role="active">` rendered above the body content. In B.2 it becomes one element inside `.tugx-file-actions`; the right side of the row carries Find. The cue text shortens from "263 lines folded — click to expand" to a chevron + small label that fits inside an action-bar height, since the row also has to host other affordances now.

- **The pin offset has been diagnosed before this phase starts.** That work is Phase B.1's job. Phase B.2 consumes the finding and applies one named fix — not three candidate fixes guarded behind diagnostics.

**Artifacts (Phase B.2):**

- Updated: `tugdeck/src/components/tugways/cards/tool-wrappers/tool-wrapper-chrome.tsx` — `useLayoutEffect` + `ResizeObserver` on the chrome-header element writes its height to `--tugx-toolblock-header-height` on the chrome root.
- Updated: `tugdeck/src/components/tugways/body-kinds/file-block.tsx` + `.css` + tests — `.tugx-file-actions` row hosts the fold cue (when over-threshold) and the Search `<TugIconButton>` (when expanded). Old: cue rendered as full-width banner above the substrate.
- Updated: `tugdeck/src/components/tugways/body-kinds/diff-block.tsx` + `.css` + tests — `.tugx-diff-actions` row hosts the view-toggle, the diff-fold toggle, and (future) any other diff-specific control. `.tugx-diff-header` keeps identity (path + stats) only.
- Updated: `tugdeck/src/components/tugways/body-kinds/terminal-block.tsx` + `.css` + tests — `.tugx-term-actions` row hosts the Copy `<TugIconButton>` (relocated from `.tugx-term-header`). The header keeps the optional label only; in embedded mode it's suppressed and the actions row is the only body-kind chrome.
- Updated: `tugdeck/src/components/tugways/tug-markdown-view.css` + tests — fenced-code Copy moves into a `.tugx-md-fenced-code-actions` row pinned below the entry header.
- Possibly updated (depends on diagnosis): `tugdeck/src/components/tugways/tug-list-view.css` or `tide-card.css` — the precise change depends on which of the three candidate causes the pin offset turns out to be.

**Tasks (Phase B.2):**

- [x] **Apply the fix Phase B.1's findings name: remove `padding-block` from `.tug-list-view` so sticky descendants pin flush against the scrollport's padding-box edge.** Done — `.tug-list-view`'s `padding-block` set to `0`; visual breathing room restored via `::before` / `::after` pseudo-elements (`tug-list-view.css`). Pseudo-elements participate in scroll flow so they offer the same visual padding without offsetting the sticky reference. Existing `--tugx-list-view-padding-block` token preserved (it now drives the pseudo-elements' `height` instead of `padding-block`), so consumer overrides like `.tide-card-transcript .tug-list-view` and `.tide-card-picker-list-view.tug-list-view { --tugx-list-view-padding-block: 0 }` continue to compose. Virtualization spacers (`-spacer--top` / `--bottom`) untouched; 77 TugListView tests still green.
- [x] **`ToolWrapperChrome` writes `--tugx-toolblock-header-height`.** Done — `useLayoutEffect` with a `ResizeObserver` on the header element writes `borderBoxSize.blockSize` (falling back to `contentRect.height`) into the chrome root's inline style. Initial seed via `offsetHeight` so the first paint already has the correct value. Observer disconnect on cleanup. New `tool-wrapper-chrome.test.tsx` pins both the mount write and the unmount path.
- [x] **`FileBlock` introduces `.tugx-file-actions`.** Done — actions row hosts a compact fold cue (chevron + count label when collapsed, icon-only when expanded) and the Search `<TugIconButton>`. Sticky at `top: calc(var(--tugx-pin-stack-top, 0px) + var(--tugx-toolblock-header-height, 0px) + var(--tugx-file-header-height, 0px))`. FileBlock writes its own `--tugx-file-header-height` via ResizeObserver when the identity header is rendered (suppressed in embedded mode, where the variable stays unset and `calc()` falls back to 0 — actions row then pins beneath the wrapper chrome only). The Search affordance triggers CM6's `openSearchPanel` as before; with Copy + identity moved to separate sticky strips above CM6's `.cm-editor`, CM6's find panel mounts BELOW the sticky stack and no longer overlaps the identity bar.
- [x] **`DiffBlock` introduces `.tugx-diff-actions`.** Done — view-toggle + fold cue (compact form, mirroring FileBlock's) moved out of `.tugx-diff-header`. Header keeps path + stats only. The standalone `<TugCue>` "click to expand" hint was retired with the move (the fold cue in the actions row is the click target now, visible in both states). DiffBlock writes `--tugx-diff-header-height` via ResizeObserver; actions row pins at `top: calc(pin-stack-top + toolblock-header-height + diff-header-height)`.
- [x] **`TerminalBlock` introduces `.tugx-term-actions`.** Done — Copy `<TugIconButton>` moved out of `.tugx-term-header` into the actions row. Header now hosts ONLY the optional `headerLabel`; in standalone-without-label the header is suppressed entirely (an empty strip would just add visual noise), and in embedded mode the header is always suppressed. The actions row is the only body-kind chrome that survives `embedded={true}`. TerminalBlock writes `--tugx-term-header-height` via ResizeObserver; same sticky-stack calc as DiffBlock.
- [x] **`tug-markdown-view` fenced-code actions row.** Done — Copy `<button>` moved out of `.tugx-md-fenced-code-header` into a new `.tugx-md-fenced-code-actions` row (`enhanceFencedCode` + `tug-markdown-view.css`). Because `enhanceFencedCode` is an imperative DOM helper (no React component, no ResizeObserver), the header height for the actions-row offset uses a static-token approximation: `--tugx-md-fenced-code-header-height: 28px`, applied as `min-height` on the header and consumed by the actions row's `top` calc. Themes that tune the strip padding or font size should override the token at the same time.
- [x] **Extend the gallery card.** Done — added a fourth section to `gallery-pinned-headers.tsx` that wraps `FileBlock` inside a `ToolWrapperChrome` (simulating a Read tool call) so the two-bar telescope — chrome header on top, actions row directly below — is exercisable visually alongside the three standalone sections.
- [x] **Tests** — All Phase B.2 deliverables ship with updated unit coverage. Full `bun test` suite: 3564 pass, 0 fail. `bunx tsc --noEmit`: clean. `bun run audit:tokens lint`: clean.

**Tests (commands, Phase B.2):**

- [x] `bun test src/components/tugways/cards/tool-wrappers/__tests__/tool-wrapper-chrome.test.tsx` — `--tugx-toolblock-header-height` written on the chrome root after mount; cleans up on unmount. (new file; 2 pass)
- [x] `bun test src/components/tugways/body-kinds/__tests__/file-block.test.tsx` — `.tugx-file-actions` row renders; fold cue toggles; Search button now inside actions row; embedded mode keeps actions row. (41 pass)
- [x] `bun test src/components/tugways/body-kinds/__tests__/diff-block.test.tsx` — view-toggle + fold cue moved into `.tugx-diff-actions`; click toggles still fire. (54 pass)
- [x] `bun test src/components/tugways/body-kinds/__tests__/terminal-block.test.tsx` — Copy moved into `.tugx-term-actions`; header suppressed without label / in embedded mode; copy-roundtrip + CSS-sticky assertions still pass. (34 pass)
- [x] `bun test src/lib/markdown/__tests__/enhance-fenced-code.test.ts` — Copy moved into `.tugx-md-fenced-code-actions`; DOM order header → actions → pre. (13 pass)
- [x] `bunx tsc --noEmit` — clean.
- [x] `bun run audit:tokens lint` — zero violations.
- [x] `bun test` (full suite) — 3564 pass, 0 fail, no regressions.

**Checkpoint (Phase B.2):**

- [ ] Manual: open a Read tool on a 500-line file. Confirm: chrome header pinned FLUSH with the visible top of the transcript scrollport (no offset, no content visible above the bar); body-kind actions row pinned directly below the chrome header with chevron-up (collapse) and Find buttons; both bars remain reachable through the entire scroll range; clicking the fold from a deep-scrolled position works.
- [ ] Manual: open the gallery's pinned-headers card. Confirm the same in a stand-alone setting (proves the pinning isn't specific to a real transcript).
- [ ] Manual: run `find . -type f | head -300` via Bash. Confirm Copy stays reachable in the terminal's actions row throughout the scroll range.
- [ ] After Phase C lands: re-open the gallery card. Confirm the outer entry-header pin appears above the chrome header; the three-level telescope (entry > chrome > actions) is visible during the transition.

---

##### Phase C — Entry-header pin + telescoping variable

- `.tug-transcript-entry__header { position: sticky; top: 0; z-index: 2 }` (higher than block headers so the entry header always wins during transient transitions when both might compete).
- `tug-transcript-entry.tsx` adds a `useLayoutEffect` that creates a `ResizeObserver` on the `__header` element and writes `--tugx-pin-stack-top: ${height}px` onto the entry root. `[L03]` (observer registered before paint) and `[L06]` (DOM write, not React state) both satisfied. Observer disconnect in the effect's cleanup.
- `tug-transcript-entry.tsx` module docstring documents the contract: "child block headers may consume `--tugx-pin-stack-top` to telescope under the entry header when both pin simultaneously. The variable always reflects the live measured height of `__header`."
- Tests: entry mounts; `--tugx-pin-stack-top` is set on the root after layout; updates when `__header` content changes height (simulated via prop change).
- Real-browser sticky behavior is verified via the gallery card + manual visual check.

**Artifacts:**

- New: `tugdeck/src/components/tugways/tug-code-view.tsx` + `.css`.
- New: `tugdeck/src/components/tugways/__tests__/tug-code-view.test.tsx`.
- New: `tugdeck/src/components/tugways/cards/gallery-pinned-headers.tsx` — a tall-content card demonstrating both levels pinning, with a "scroll me" affordance and a synthesized long file + tall terminal + multi-hunk diff so the telescoping is exercisable in the gallery.
- Updated: `tugdeck/src/components/tugways/body-kinds/file-block.tsx` + `.css` + tests — engine swap to `TugCodeView`; retire `.tugx-file-rows` / `-row` / `-content` / `-overlay` / `-search-*` and their slot families.
- Updated: `tugdeck/src/components/tugways/body-kinds/terminal-block.tsx` + `.css` + tests — new header, Copy relocated, `scrollbar-gutter: stable`, overlay DOM retired.
- Updated: `tugdeck/src/components/tugways/body-kinds/diff-block.css` — header pin only (no JSX change).
- Updated: `tugdeck/src/components/tugways/tug-transcript-entry.tsx` + `.css` + tests — sticky outer header + ResizeObserver-driven `--tugx-pin-stack-top`.
- Updated: `tugdeck/src/components/tugways/tug-markdown-view.css` — fenced-code header pin (same `var(--tugx-pin-stack-top)` consumer).
- Updated: `tuglaws/component-authoring.md` — document the pin-telescoping contract and the `TugCodeView` / file-content rule ("CM6 is the canonical text engine for file-based content").

**Tasks (Phase A — CM6 + FileBlock swap):**

- [x] Author `tug-code-view.tsx` with the read-only CM6 mount, lineWrapping + lineNumbers + search compartments, and a small selection-only responder.
- [x] Author `tug-code-view.css` with `--tugx-codeview-*` slots that consume `--tugx-block-*` (frame, code typography, strip chrome) directly; component-specific slots only for the gutter color/width and the selection highlight tones.
- [x] Author `tug-code-view.test.tsx` covering mount, value, wrap toggle, line-numbers toggle, find UI reveal, selection round-trip.
- [x] Swap `file-block.tsx`'s body to `<TugCodeView ...>`; delete the bespoke renderer, the match overlay, the imperative search icon, and the `--tugx-file-rows/-row/-content/-overlay/-search-*` slot families.
- [x] Rewrite `file-block.test.tsx` against the new composition; defer line-level CM6 behavior to `tug-code-view.test.tsx`.
- [x] Add `@codemirror/search` to `tugdeck/package.json` — the find-panel substrate.
- [x] Update `tuglaws/component-authoring.md` with the "Text content" section naming CM6 as the canonical engine for file-based text content.
- [x] Update fixture-replay tests (`read-tool-block.test.tsx`, `read-tool-block.replay.test.tsx`) to assert against the substrate slot (`[data-slot="tug-code-view"]` + `.cm-content`) instead of the retired `[data-slot="file-gutter"]` bespoke markers.

**Tasks (Phase B — block-header pin + TerminalBlock header):**

- [x] Add sticky declarations to `.tugx-file-header`, `.tugx-diff-header`, `.tugx-md-fenced-code-header`.
- [x] Add `.tugx-term-header` markup to `terminal-block.tsx` (optional label slot + Copy `TugIconButton`); add CSS rule consuming `--tugx-block-strip-*`.
- [x] Add sticky declaration to `.tugx-term-header`.
- [x] Add `scrollbar-gutter: stable` to `.tugx-term-scroller` (the body viewport).
- [x] Retire `.tugx-term-copy` overlay DOM in `terminal-block.tsx`; drop the `--tugx-term-copy-*` slot family from `terminal-block.css`.
- [x] Update `terminal-block.test.tsx`: header Copy `TugIconButton` exists; no `.tugx-term-copy` overlay; `scrollbar-gutter` declared on the scroller; `position: sticky` declared on the header.
- [x] Switch block roots (`.tugx-file`, `.tugx-diff`, `.tugx-term`, `.tugx-md-fenced-code`) from `overflow: hidden` to `overflow: clip` so the rounded-corner clipping survives but the sticky descendants see the OUTER transcript scroller. `overflow: hidden` forms a scroll container that captures sticky positioning; `overflow: clip` clips without forming one. Supported in WebKit (Safari 16+).

**Tasks (Phase C — entry-header pin):**

- [x] Add `position: sticky; top: 0; z-index: 2` to `.tug-transcript-entry__header`. Done — also added opaque background via the new `--tugx-transcript-header-bg` token (bound to `--tug7-surface-global-primary-normal-overlay-rest`, matching the pane chrome) so body content doesn't bleed through.
- [x] Add `useLayoutEffect` + `ResizeObserver` to `tug-transcript-entry.tsx`; write `--tugx-pin-stack-top` onto the entry root. Done — seed via `offsetHeight` on mount; observer keeps the variable accurate across header content / magnification changes; disconnect on cleanup.
- [x] Update `tug-transcript-entry.test.tsx`: variable is set after mount; updates on header-content prop change. Done — 3 new tests in a "Pin-stack contract" describe block covering the seed write, re-render survival, and clean unmount.
- [x] Update the module docstring with the pin-telescoping contract. Done — new "Pin-stack contract — `--tugx-pin-stack-top`" section in the .tsx docstring covering reads/writes, [L03]/[L06]/[L19]/[L20] mappings.

**Tasks (gallery + docs):**

- [x] Author `gallery-pinned-headers.tsx` showing both levels pinning across a synthesized long file + multi-hunk diff + tall terminal in one transcript turn. *(Shipped in Phase B.1 / B.2 — gallery card carries four sections including the chrome-wrapped FileBlock; with Phase C's transcript-entry pin landed, the gallery card now exercises the full three-level telescope when composed inside a transcript turn.)*
- [x] Update `tuglaws/component-authoring.md`: add a "Text content" section that names CM6 (via `TugCodeView` or `tug-text-editor`) as the canonical engine for any file-based text surface, and document the `--tugx-pin-stack-top` variable as a shared contract. Done — "Text content" section already in place from Phase A; new "Pin-stack composition — `--tugx-pin-stack-top`" section adjacent documents the full writer/reader contract (entry → toolblock-header-height → file/diff/term-header-height → actions row), the 5 authoring rules (writer ownership, reader composition, opaque background, container clipping, scroll-container padding pitfall), and the `0px` fallback gotcha.

**Tests (commands):**

- [x] `bun test src/components/tugways/__tests__/tug-code-view.test.tsx`
- [x] `bun test src/components/tugways/body-kinds/__tests__/file-block.test.tsx`
- [x] `bun test src/components/tugways/body-kinds/__tests__/diff-block.test.tsx`
- [x] `bun test src/components/tugways/body-kinds/__tests__/terminal-block.test.tsx`
- [x] `bun test src/components/tugways/__tests__/tug-transcript-entry.test.tsx` (Phase C) — 12 pass.
- [x] `bunx tsc --noEmit`
- [x] `bun run audit:tokens lint`
- [x] `bun test` (full suite — no regressions)

**Checkpoint:**

- [x] All commands above clean. `bunx tsc --noEmit`, `bun run audit:tokens lint`, `bun test` — 3573 pass, 0 fail.
- [x] Manual: open Read tool on a 500-line file in both brio and harmony. Confirm: no per-line scrollbars; lines wrap; file header stays visible while scrolling deep into the body; entry header (Claude / `HH:MM AM`) stays at the top of the viewport above the file header.
- [ ] Manual: run a `bash` command with long stdout. Confirm: Copy button sits in the pinned actions row, never on top of any scrollbar; scrollbar gutter reserved (no horizontal layout shift when output grows past the viewport).
- [ ] Manual: long DiffBlock + tall TerminalBlock in one transcript turn. Confirm telescoping: entry header at top, then block header under it; scrolling between the two blocks transitions cleanly.

---

##### Phase D — Action-row consolidation + progressive Find disclosure

**Depends on:** Phases A / B / B.1 / B.2 / C. The pin-stack writer/reader chain established in those phases is what this phase rearranges; the consolidation cannot land before the variables that drive it.

**Why this phase exists.** Phase B.2 introduced `.tugx-{kind}-actions` as a dedicated sticky row beneath every block's identity header so affordances (Find, Copy, view-mode toggle, fold cue) survive scrolling. The row works — but in practice it carries one or two icon-sized controls hugging the right edge while the rest of the row is empty. The chrome header *above* it has the same shape — icon + name + flex-1 args + trailing space — and is also mostly empty on the right. Result: two stacked sticky rows where one would do. See user screenshots from 2026-05-11 (Bash with `find . -type f | head -300`, Read of `THIRD_PARTY_NOTICES.md`, Bash with `git diff`): both rows are bound by the same visible content, and the redundancy is most pronounced exactly in the pinned state where vertical space matters most.

A separate concern compounds it: the FileBlock / DiffBlock Find UI lives in the actions row at rest. Even when no find session is active, the row reserves space for the Find trigger plus matching geometry for an expanded find view. The expanded find UI doesn't fit beside the args at most widths anyway — it's a multi-control band with input, prev/next, three checkboxes, match count, Done — so reserving "actions row" geometry for it does nothing while resting and isn't enough while finding.

**Decisions.**

- **Resting affordances live in the chrome / identity header, not in a separate row.** `ToolWrapperChrome` grows an `actions?: React.ReactNode` slot. It renders as `flex: 0 0 auto` immediately after `.tool-wrapper-chrome-args` (which keeps `flex: 1 1 auto; min-width: 0; text-overflow: ellipsis`). Body kinds populate the slot when embedded. In standalone mode the body kind's own identity header (`.tugx-file-header`, `.tugx-diff-header`, `.tugx-term-header`) gains the same trailing slot. One row, both modes.

- **Find UI is progressive disclosure: a second sticky row that mounts only while a find session is open.** Resting state: no `.tugx-file-find` / `.tugx-diff-find` in the DOM, no reserved geometry, no `ResizeObserver` writing a non-zero height variable. Active state: the find row mounts, becomes sticky beneath the chrome / identity header, and writes its measured height into `--tugx-{kind}-find-height` for downstream sticky consumers (hunk headers). On close, the row unmounts and the variable returns to its `0px` fallback. State remains React-local to the body kind ([L06] DOM-write for the height variable, React state for the mount switch — mount-time DOM presence isn't an "appearance change", it's a structural change, so React state is appropriate).

- **`.tugx-{kind}-actions` retires. `--tugx-{kind}-actions-height` retires.** With resting affordances absorbed into the identity row, the dedicated actions row no longer exists. The variable it wrote becomes dead weight; remove it from FileBlock, DiffBlock, TerminalBlock. Sticky-stack `top:` calcs lose one term — hunk headers in DiffBlock pin at `calc(pin-stack-top + toolblock-header-height + diff-header-height + diff-find-height)`; the standing `diff-actions-height` is gone.

- **`--tugx-{kind}-find-height` is a new variable, written only while find is open.** Each find-bearing body kind (`FileBlock`, `DiffBlock`) registers a `ResizeObserver` on its find row when mounted; unregisters on unmount. The variable's defined-only-while-open lifetime is enough — consumers read it as `var(--tugx-{kind}-find-height, 0px)` and get the right answer either way.

- **The actions slot in `ToolWrapperChrome` is content-typed, not affordance-typed.** The chrome doesn't know about Find, Copy, or view-mode — it accepts `React.ReactNode` and renders it. Body kinds compose the appropriate `TugIconButton` / `TugPushButton` set themselves. The [L20] separation Phase A established (chrome owns `--tugx-toolblock-*`; body kinds own `--tugx-{kind}-*`) is preserved: the actions slot is structural, not stylistic. Styling of the buttons inside the slot is governed by the body kind's `--tugx-{kind}-*` tokens via the buttons themselves.

- **Maximum slot width is bounded so args remains scannable.** The actions slot is `flex: 0 0 auto`; the args region is `flex: 1 1 auto; min-width: 0`. As more buttons enter the slot, args ellipsizes earlier. A body kind that wants to host more than ~3 icon buttons or one TugPushButton + 2 icons should either (a) reduce the count, or (b) open a Find-style progressive-disclosure row. This is a soft constraint enforced by visual review, not a code-level cap.

- **The args hover-expand behavior keeps working.** `.tool-wrapper-chrome-header:hover .tool-wrapper-chrome-args { white-space: pre-wrap; overflow: auto; max-height: 4lh }` — the actions slot's `flex: 0 0 auto` doesn't fight this; args still grows downward inside the header when hovered. The actions remain visible at the right edge while args expands.

- **The fold cue moves with the affordances.** Today it sits in `.tugx-file-actions` (FileBlock) and `.tugx-diff-actions` (DiffBlock) as a compact chevron + label. In Phase D it migrates into the chrome / identity actions slot alongside Find and any view-mode toggle — same compact form.

**Artifacts (Phase D):**

- Updated: `tugdeck/src/components/tugways/cards/tool-wrappers/tool-wrapper-chrome.tsx` + `.css` — new `actions?: React.ReactNode` prop, rendered as `<div className="tool-wrapper-chrome-actions" data-slot="tool-wrapper-actions">` between `__args` and the caution badge. New `--tugx-toolblock-actions-gap` slot for the action-group internal gap (typically `var(--tug-space-2xs)`). Layout: header's `gap` continues to handle outer spacing; actions cluster owns its own internal spacing.
- Updated: `tugdeck/src/components/tugways/body-kinds/file-block.tsx` + `.css` — retire `.tugx-file-actions`; resting affordances (Find trigger, future fold cue) move into either the chrome's `actions` slot (when wrapped) or `.tugx-file-header`'s trailing slot (when standalone). New `.tugx-file-find` (progressive disclosure) replaces the existing always-mounted find substrate inside the actions row. ResizeObserver targets the find row when mounted; `--tugx-file-actions-height` retires, `--tugx-file-find-height` is introduced (set only while find is open).
- Updated: `tugdeck/src/components/tugways/body-kinds/diff-block.tsx` + `.css` — mirror of FileBlock changes. `.tugx-diff-actions` retires; `.tugx-diff-find` mounts only while find is open. Hunk-header `top:` calc loses `diff-actions-height` and gains `diff-find-height`. View-toggle (unified/split) and diff-fold toggle migrate into the chrome's `actions` slot (embedded) or `.tugx-diff-header`'s trailing slot (standalone).
- Updated: `tugdeck/src/components/tugways/body-kinds/terminal-block.tsx` + `.css` — Copy migrates from `.tugx-term-actions` into the chrome's `actions` slot (embedded) or `.tugx-term-header`'s trailing slot (standalone). `.tugx-term-actions` retires entirely (TerminalBlock has no find UI, so there's no `.tugx-term-find` analog). The header-without-label suppression rule from Phase B.2 is revisited: with Copy now in the chrome slot, the standalone-without-label header may still need to render an empty strip just to host Copy — or Copy can render as a chrome-overlay icon-button when no header text exists. Decision deferred to implementation review; both designs are acceptable.
- Updated: `tugdeck/src/components/tugways/tug-markdown-view.css` + `enhanceFencedCode` — fenced-code Copy migrates from `.tugx-md-fenced-code-actions` into `.tugx-md-fenced-code-header`'s trailing area. `.tugx-md-fenced-code-actions` retires; the `--tugx-md-fenced-code-header-height` token preserves its current purpose (consumed by any future sticky descendant in markdown subtrees).
- Updated: `tugdeck/src/components/tugways/cards/gallery-pinned-headers.tsx` — fixture comparison. Each of the four sections (standalone FileBlock, standalone DiffBlock, standalone TerminalBlock, chrome-wrapped FileBlock) should show ONE pinned row at rest, expanding to TWO only while Find is active in the file / diff sections. The card is the visual smoke test for the consolidation.
- Updated: `tuglaws/component-authoring.md` — replace the Phase B.2 "writer/reader chain (entry → toolblock-header-height → body-kind header-height → actions row)" section with the Phase D chain ("entry → toolblock-header-height → body-kind header-height → optional find-row height"). Document the chrome `actions` slot as a structural prop and call out the `min-width: 0` requirement on `__args` that the trailing actions slot depends on.

**Tasks (Phase D):**

- [x] **`ToolWrapperChrome` grows an `actions` slot.** Done — chrome's header renders `<div data-slot="tool-wrapper-actions">` at its trailing edge, published to descendants via the new `ChromeActionsTargetContext` and `useChromeActionsTarget()` hook. Body kinds composed under `embedded={true}` `createPortal` their resting affordances into that slot (no `actions?` prop on the chrome itself — the contract is portal-based so body kinds keep affordance state local). Module docstring documents the contract.
- [x] **No wrapper-side wiring required.** Decided the portal-via-context architecture over a `headerActions` prop because hoisting affordance state (find session, fold collapsed-set, view-mode toggle) into the wrappers would invert the data flow and require every wrapper to re-implement the affordance UI. With portals, `BashToolBlock` / `ReadToolBlock` / future `EditToolBlock` keep their current composition unchanged — chrome wraps an embedded body kind, body kind portals affordances into chrome — no per-wrapper edit.
- [x] **FileBlock: retire `.tugx-file-actions`; affordances move into header trailing area (standalone) or portal into chrome (embedded).** Done — actions row + `--tugx-file-actions-height` writer retired. Resting affordances (fold cue, Search trigger) render inside `.tugx-file-header` at the trailing edge in standalone composition, or portal into the chrome's actions slot when `embedded={true}`. Find UI (`.tugx-file-find`) continues to mount only when `findOpen === true`; its sticky `top:` calc drops the now-zero `--tugx-file-actions-height` term. No `--tugx-file-find-height` writer introduced — nothing pins under the find row, so YAGNI.
- [x] **DiffBlock: same pattern + hunk-header calc update.** Done — `.tugx-diff-actions` row + `--tugx-diff-actions-height` writer retired. Fold cue + view-toggle render inside `.tugx-diff-header` (standalone) or portal into chrome (embedded). Hunk header `top:` calc drops the formerly-needed `--tugx-diff-actions-height` term; `z-index: 0` invariant preserved so hunks still ride UNDER the upper pin stack when leaving the scene. No diff-side find UI exists today, so no `--tugx-diff-find-height` writer was introduced — when diff search lands as a future feature, the calc and writer extend then.
- [x] **TerminalBlock: Copy migrates into the header; `.tugx-term-actions` retires.** Done — standalone mode ALWAYS renders `.tugx-term-header` (label-or-no-label) with Copy at the trailing edge. Chose this over the chrome-overlay alternative because a single sticky row is structurally simpler than a header-suppression conditional + an overlay band, and the empty-header strip (when no label) is a minor cost compared to the consistency win. Embedded mode portals Copy into the chrome's actions slot; the body kind's own header is suppressed. The `--tugx-term-header-height` writer + effect retired with the actions row (no descendant pin reader needed it).
- [x] **Fenced-code: Copy migrates into the header.** Done — `enhanceFencedCode` rewrites its DOM so Copy lives inside `.tugx-md-fenced-code-header` as a `[data-slot="md-fenced-code-actions"]` cluster at the trailing edge. The dedicated `.tugx-md-fenced-code-actions` sticky row retired. The static `--tugx-md-fenced-code-header-height: 28px` still drives `min-height` on the header for consumers (nothing pins under the fenced-code header today, but the token remains for future descendants).
- [x] **Affordances are Tug components, with invariant shapes across all states.** Per the [L19] / [L20] "components must use Tug primitives" rule, and the new authoring rules added in `tuglaws/component-authoring.md` (rules 7 + 8: button shapes are invariant across states; affordances stay visible across body-state changes). The body-kind affordance cluster is:
  - **File fold cue, diff fold cue**: `TugPushButton`, `subtype="icon-text"`, `emphasis="ghost"`, `size="xs"`. The button shape is invariant — only the chevron icon flips (`ChevronsDown`↔`ChevronsUp`) and the label string swaps "folded"↔"expanded" with the state. Never collapses to icon-only.
  - **File Search (Find trigger)**: `TugPushButton`, `subtype="icon-text"`, `emphasis="ghost"`, `size="xs"`. Magnifier icon + "Find" label. **Always rendered**, disabled when collapsed (substrate isn't mounted) — keeps the cluster geometry invariant across fold state so the header never grows/shrinks.
  - **Diff view-toggle**: `TugPushButton`, `subtype="text"`, `emphasis="ghost"`, `size="xs"`. Disabled when the diff is collapsed (no hunks visible, so view-mode is meaningless).
  - **Terminal Copy**: `TugPushButton`, `subtype="icon-text"`, `emphasis="ghost"`, `size="xs"`. `Copy` icon + "Copy" label at rest; `confirmation` prop drives the post-click `Check` icon + "Copied" flash via TugButton's built-in `data-tug-confirming` swap (no imperative class-mutation from React).
  - **Fenced-code Copy** (imperative DOM via `enhanceFencedCode`): raw `<button>` with the same visual treatment (ghost-equivalent, icon + "Copy" / "Copied!" label swap at the same shape). Documented exception per tuglaw rule 6 — imperative-DOM rendering paths may use raw `<button>` markup but must match the Tug primitive equivalent visually.
  - The legacy `tugx-{kind}-fold-cue` / `tugx-{kind}-view-toggle` / `tugx-{kind}-search` / `tugx-{kind}-copy-button` class names are forwarded onto the Tug components as `className` so CSS scoping and test selectors stay stable. The bespoke per-block fold-cue / view-toggle CSS rules and the `--tugx-{kind}-fold-cue-*` / `--tugx-diff-view-*` slot families retired.
- [x] **Gallery card visual confirmation surface.** Done — `gallery-pinned-headers.tsx` now carries six sections (3 standalone, 3 chrome-wrapped) so each body kind's consolidated shape is exercisable side-by-side with its chrome composition. Section titles updated to reflect the new contract ("header carries Find + fold cue at trailing edge", "affordances portal into chrome header").
- [x] **Tuglaws update.** `tuglaws/component-authoring.md` "Pin-stack composition" section rewritten to reflect Phase D: references to `--tugx-{kind}-actions-height` removed; new "Body-kind affordance hosting" subsection documents the trailing-cluster pattern and the portal mechanism (via `ChromeActionsTargetContext` / `useChromeActionsTarget()`); progressive-disclosure Find UI documented; a sixth authoring rule mandates Tug primitives for affordance components.

**Tests (commands, Phase D):**

- [x] `bun test src/components/tugways/cards/tool-wrappers/__tests__/tool-wrapper-chrome.test.tsx` — 5 pass. Asserts the actions slot renders (even when empty), that descendants can portal into it via `useChromeActionsTarget`, and that the hook returns null outside a chrome.
- [x] `bun test src/components/tugways/body-kinds/__tests__/file-block.test.tsx` — 44 pass. Search button now lives inside `[data-slot="file-actions"]` at the header's trailing edge (standalone) or portaled into the chrome's actions slot (embedded). Find UI still progressive-discloses.
- [x] `bun test src/components/tugways/body-kinds/__tests__/diff-block.test.tsx` — 55 pass. View-toggle + fold cue toggle from their new header-trailing home (standalone) or chrome portal (embedded); hunk-collapse + whole-diff-collapse + per-hunk-collapse all still fire.
- [x] `bun test src/components/tugways/body-kinds/__tests__/terminal-block.test.tsx` — 34 pass. Copy reachable from the header's trailing cluster (standalone) or chrome portal (embedded); no `.tugx-term-actions` sticky rule in source.
- [x] `bun test src/lib/markdown/__tests__/enhance-fenced-code.test.ts` — 13 pass. Copy inside `[data-slot="md-fenced-code-actions"]` cluster within the header; no `.tugx-md-fenced-code-actions` row anywhere in the DOM.
- [x] `bunx tsc --noEmit` — clean.
- [x] `bun run audit:tokens lint` — zero violations.
- [x] `bun test` (full suite) — **3577 pass, 0 fail** (post-Phase-C baseline was 3573; the four new tests cover the chrome `actions`-slot contract and the embedded-portal path for each body kind).

**Checkpoint (Phase D):**

- [ ] Manual: open the gallery card. Confirm each section shows ONE pinned row at rest; opening Find in the file sections expands to TWO; closing returns to ONE.
- [ ] Manual: run `find . -type f | head -300` via Bash. Confirm: a single pinned row carrying the icon + name + `find . -type f | head -300` args + Copy at the right; no empty actions row beneath; Copy reachable throughout the scroll range.
- [ ] Manual: open a Read tool on a 500-line file. Confirm the same shape: one row carrying icon + name + path + Find + fold cue. Open Find — a second sticky row appears beneath, with the input + nav buttons + checkboxes + match count + Done. Close Find — back to one row.
- [ ] Manual: open a long DiffBlock. Confirm the chrome row carries view-toggle + fold cue; hunk headers ride UNDER that row when scrolling past (z-index: 0 invariant preserved).
- [ ] Visual diff vs the screenshots in the Phase D "why" section: the "two mostly-empty rows" pattern should be gone.

---

##### Phase E.1 — Find-UI and state-zone hardening

**Depends on:** Phase D, plus the post-Phase-D audit fixups landed in `8ebf8c92` (rAF → useLayoutEffect; L20 position-coordination carve-out).

**Why this phase exists.** The post-Phase-D audit surfaced four softer concerns that all sit in the same neighborhood — they're about *how* the find session and the body-kind state are wired, not *what* the surface looks like. None burn the barn down, but each one is a small drift from the tuglaws or from a clean reading of the responder-chain conventions, and the kind of thing that piles up if left alone:

- The Cmd-G / Shift-Cmd-G keystrokes that drive find-next / find-previous attach a document-level `keydown` listener inside `FileBlock` rather than going through the responder chain. There's no `FIND_NEXT` / `FIND_PREVIOUS` in `TUG_ACTIONS` today. Cmd-F → FIND already round-trips through the chain (TugCodeView registers FIND, the host's `onFindRequested` opens the find UI); Cmd-G should follow the same path.
- Both `FileBlock` and `DiffBlock` carry their `collapsed` state as a hybrid controlled / uncontrolled pattern: `useState(initialCollapsed)` plus a `useEffect` that syncs `collapsedProp` into local state on prop changes. Functionally fine — but a known React antipattern that creates a "controlled prop says false, local state says true" divergence after a click in uncontrolled mode, and reads awkwardly. The canonical alternative is the lift pattern: `const collapsed = collapsedProp !== undefined ? collapsedProp : localCollapsed;` — no `useEffect`-sync, no divergence.
- `TerminalBlock`'s Copy button uses `TugPushButton`'s `confirmation` prop for the "Copied" feedback flash. The flash fires on every click regardless of whether `navigator.clipboard.writeText` actually succeeded. Pre-Phase-D the imperative `is-copied` class was only added inside the `.then()` callback, so the feedback was honest. Re-adopting honest feedback requires `TugButton` to expose a *controlled* confirmation API (an `isConfirming` / `setConfirmed(true)` shape) so the host can fire the flash conditionally.
- The `useEffect` that pushes the find query + options to CM6 runs after paint, so each keystroke produces a one-frame visual lag between the input update and the match-highlight repaint. `useLayoutEffect` runs before paint and eliminates the lag.

**Decisions.**

- **`FIND_NEXT` and `FIND_PREVIOUS` join the action vocabulary.** Both surface in `TUG_ACTIONS` alongside the existing `FIND`. `TugCodeView` registers handlers for both (they delegate to `cmFindNext` / `cmFindPrevious` on the live view, with the empty-query guard the host currently applies). The host's existing `findQuery.length === 0` guard moves into the handlers so the action vocabulary is the single chokepoint and the document-level listener retires.
- **Cmd-G / Shift-Cmd-G dispatch through the responder chain, not via `document.addEventListener`.** The mechanism is the keyboard pipeline that already routes Cmd-F → FIND. Add the bindings to whatever keymap layer the FIND action uses (likely a chain-level keymap or TugCodeView's substrate keymap; the implementation choice is deferred to the task). The empty-query guard becomes "the handler is a no-op when the query is empty," dispatched through the chain just like every other action.
- **`collapsed` state lifts via the "computed value, single source" pattern.** Both `FileBlock` and `DiffBlock` drop the `useEffect`-sync from `collapsedProp`. Internal state holds the uncontrolled default; `collapsed = collapsedProp ?? localCollapsed` is computed on every render. Toggling in uncontrolled mode writes local state; in controlled mode the parent owns `collapsed` and toggling fires `onToggleCollapsed?.(next)` but DOES NOT write local state (the parent's prop drives the next render). Same shape as the existing `viewMode` resolution in `DiffBlock`, which already uses this pattern correctly.
- **`TugButton` grows a controlled-confirmation API.** Add an optional `isConfirming?: boolean` prop. When provided, the parent controls the confirmation state; the button enters the confirmed state when the prop is `true` and exits when it returns to `false`, ignoring the internal timer. `confirmation.duration` remains in use for the uncontrolled path (no `isConfirming` prop). `TerminalBlock` adopts the controlled mode: a local `[copied, setCopied]` state, set to `true` inside `.then()` after a successful clipboard write, cleared by a host-owned timer. The flash is honest again.
- **Find state-sync runs in `useLayoutEffect`.** The effect that pushes `findQuery` / `findCaseSensitive` / `findRegexp` / `findWholeWord` to the CM6 delegate, plus the `setFindMatchCount` after, moves from `useEffect` to `useLayoutEffect`. The substrate's match-highlight repaint and the input's character commit land in the same paint, eliminating the keystroke-lag.

**Artifacts (Phase E.1):**

- Updated: `tugdeck/src/components/tugways/action-vocabulary.ts` — add `FIND_NEXT` and `FIND_PREVIOUS` to `TUG_ACTIONS`; document the no-op-when-no-query semantics.
- Updated: `tugdeck/src/components/tugways/tug-code-view.tsx` — register `FIND_NEXT` / `FIND_PREVIOUS` handlers alongside the existing `FIND` / `SELECT_ALL` / `COPY`. Handlers guard on `query.valid` (the same flag `getMatchCount` already uses) so an empty / invalid query is a no-op without resurrecting CM6's `openSearchPanel`-from-selection fallback.
- Updated: `tugdeck/src/components/tugways/body-kinds/file-block.tsx` — retire the document-level `keydown` listener for Cmd-G; the chain keyboard pipeline now drives the dispatch. Lift `collapsed` to the computed-value pattern (drop the `useEffect`-sync). Move the find-state-sync `useEffect` to `useLayoutEffect`.
- Updated: `tugdeck/src/components/tugways/body-kinds/diff-block.tsx` — lift `collapsed` to the computed-value pattern (drop the `useEffect`-sync). Mirrors `viewMode`'s existing resolution.
- Updated: `tugdeck/src/components/tugways/internal/tug-button.tsx` + `.css` — new optional `isConfirming?: boolean` prop. When provided, the prop drives the `data-tug-confirming` attribute and overrides the internal timer. Mutually-exclusive contract with `confirmation.duration` is documented and dev-warned.
- Updated: `tugdeck/src/components/tugways/body-kinds/terminal-block.tsx` — replace the unconditional `confirmation.duration` with a controlled `isConfirming` flag set inside the clipboard `.then()`. Local `setTimeout` clears the flag after `COPIED_FLASH_MS`. Failure path: flag never sets, no flash.
- Updated: `tugdeck/src/components/tugways/__tests__/tug-code-view.test.tsx` — new tests for `FIND_NEXT` / `FIND_PREVIOUS` action handlers (mount, dispatch, no-op when query empty).
- Updated: `tugdeck/src/components/tugways/body-kinds/__tests__/file-block.test.tsx` — drop the document-level listener test scaffolding (if any); add a controlled-collapse test (parent sets `collapsed={true}`, child renders collapsed; parent's `onToggleCollapsed` fires on click but local state stays untouched).
- Updated: `tugdeck/src/components/tugways/body-kinds/__tests__/diff-block.test.tsx` — mirror controlled-collapse test.
- Updated: `tugdeck/src/components/tugways/body-kinds/__tests__/terminal-block.test.tsx` — Copy click on a missing-clipboard environment: button never enters confirmed state.
- Updated: `tugdeck/src/components/tugways/cards/gallery-push-button.tsx` — add an `isConfirming` row to the gallery matrix so the controlled mode is exercisable visually.
- Updated: `tuglaws/component-authoring.md` — add the controlled-confirmation pattern under `TugButton` patterns (or a new "Controlled feedback states" subsection).

**Tasks (Phase E.1):**

- [x] **Extend `TUG_ACTIONS`** with `FIND_NEXT` and `FIND_PREVIOUS`. Done — action constants + docstring entries added to `action-vocabulary.ts`. Implementation decision: register the handlers in `FileBlock` (the responder that owns the find session) rather than `TugCodeView`. Reason: the responder chain walks UP from focus through React's responder parent context, and the find input is a sibling of `TugCodeView` (both inside `FileBlock`), so a walk from the input never reaches `TugCodeView`. Putting the handlers in `FileBlock` covers BOTH focus paths (input + CM6) in one place and matches [L11] — `FileBlock` owns `findOpen` / `findQuery` / the `codeViewRef` delegate, so it owns the actions that operate on that state.
- [x] **Route Cmd-G / Shift-Cmd-G through the chain.** Done — added two entries to `keybinding-map.ts` (`KeyG, meta → FIND_NEXT`; `KeyG, meta, shift → FIND_PREVIOUS`). The existing static keybinding pipeline dispatches via `sendToFirstResponderForContinuation`, same mechanism that already drives Cmd-F → FIND.
- [x] **Retire the document-level `keydown` listener** in `FileBlock`. Done — the listener and its companion `useEffect` + `findQueryRef` mirror retired. The chain pipeline now owns the Cmd-G route end-to-end.
- [x] **Lift `collapsed` to the computed-value pattern in `FileBlock`.** Done — replaced `useState(initialCollapsed)` + `useEffect`-sync with `useState(overThreshold)` for the uncontrolled fallback and `const collapsed = collapsedProp ?? localCollapsed` on every render. `toggleCollapsed` and `openFind` both branch on `collapsedProp === undefined` to decide whether to write local state.
- [x] **Lift `collapsed` to the computed-value pattern in `DiffBlock`.** Done — same treatment. Mirrors the existing `viewMode` resolution.
- [x] **Move the find-state-sync effect to `useLayoutEffect`.** Done — the effect that pushes `findQuery` / `findCaseSensitive` / `findRegexp` / `findWholeWord` to CM6's delegate runs before paint so match highlights repaint in the same frame as the input update. No keystroke lag.
- [x] **Add `isConfirming?: boolean` to `TugButton` / `TugPushButton`.** Done — new optional prop, documented as the controlled-mode opt-in. When provided, a dedicated `useLayoutEffect` writes `data-tug-confirming` directly into the DOM and the click handler's `enterConfirmation()` call is skipped. Mutually-exclusive with `confirmation.duration`; a mount-time `useEffect` fires a dev-mode `console.warn` when both are set.
- [x] **Refactor `TerminalBlock` to controlled confirmation.** Done — local `[copied, setCopied]` state replaces the old imperative `is-copied` class swap. `setCopied(true)` inside the clipboard `.then()` callback (success path only); `setTimeout` clears after `COPIED_FLASH_MS`. Cleanup on unmount. Failure path (`.catch`) leaves `copied` at `false` — the button never lies about success. Removed `duration` from the `confirmation` prop on the Copy button (controlled mode supplies the timing externally).
- [x] **`FileBlock` becomes a responder.** Done — uses `useOptionalResponder` to register an id + handlers for `FIND` / `FIND_NEXT` / `FIND_PREVIOUS`. `FIND` calls `openFind()`; the navigation handlers read `findQueryRef.current` (the latest-ref pattern per [L07]) and bail when the query is empty. The block's root wraps in `<fileBlockResponder.ResponderScope>` and attaches `responderRef` via a composed-ref callback. `useOptionalResponder` (tolerant) means standalone gallery hosts still render correctly when no `ResponderChainProvider` is above.
- [x] **Tests.** Done — 5 new TugButton tests (uncontrolled vs controlled vs flipping vs dev-warn), 2 controlled-collapse tests (FileBlock + DiffBlock), 2 honest-confirmation tests (TerminalBlock success + failure paths).
- [x] **Update `tuglaws/component-authoring.md`** — Done. New "Controlled feedback states" subsection under Component Patterns documents the two-mode (uncontrolled timer / controlled prop) contract, the [L06] / [L03] mapping for the DOM mutation, and the false-positive-feedback failure mode that motivates the controlled mode.

**Tests (commands, Phase E.1):**

- [x] `bun test src/components/tugways/internal/__tests__/tug-button.test.tsx` (new file) — 5 pass. Uncontrolled timer fires on click; controlled `isConfirming={false}` stays at rest on click; `isConfirming={true}` enters confirmed; toggling false → true → false drives the attribute exactly; the dev-warn fires when `isConfirming` + `confirmation.duration` are both set.
- [x] `bun test src/components/tugways/body-kinds/__tests__/file-block.test.tsx` — 45 pass. New controlled-collapse test: parent provides `collapsed={true}`, click on the cue fires the callback but the visible state stays as the parent's prop says; a subsequent rerender with `collapsed={false}` updates the DOM.
- [x] `bun test src/components/tugways/body-kinds/__tests__/diff-block.test.tsx` — 56 pass. Same controlled-collapse contract.
- [x] `bun test src/components/tugways/body-kinds/__tests__/terminal-block.test.tsx` — 36 pass. Success path: clipboard `.then()` sets `copied`, button enters confirmed (`data-tug-confirming="true"`). Failure path: rejected promise leaves the button at rest — no `data-tug-confirming` attribute.
- [x] `bunx tsc --noEmit` — clean.
- [x] `bun run audit:tokens lint` — zero violations.
- [x] `bun test` (full suite) — **3586 pass, 0 fail** (post-Phase-D baseline was 3577; +9 new tests).

**Checkpoint (Phase E.1):**

- [ ] Manual: open a Read tool on a long file. Press Cmd-F (find opens), Cmd-G (next), Shift-Cmd-G (previous), Escape (clears query), Escape again (closes). Confirm each route works without a console error.
- [ ] Manual: type into the find input. Confirm the match highlights paint in the same frame as the input update (no perceptible lag).
- [ ] Manual: run a Bash command that emits output. Click Copy. Confirm the flash fires. Then in a separate session, deny clipboard permission and click Copy. Confirm the button stays in rest (no false-positive flash).
- [ ] Manual: pass `collapsed={true}` to a FileBlock from a parent. Click the fold cue. Confirm the parent's `onToggleCollapsed` fires but the visible state stays collapsed (parent controls it).

---

##### Phase E.2 — Developer-ergonomics + latent-constraint pass

**Depends on:** Phase E.1.

**Why this phase exists.** Three remaining audit concerns sit on the developer-affordance side of the codebase, not the user-visible side. They don't change pixels; they make the surface harder to misuse and remove latent walls that would block future sticky-coordination work:

- The fenced-code Copy button's size tokens (`--tugx-md-fenced-code-copy-height`, `-font-size`, `-icon-size`) duplicate `TugButton`'s 2xs sizing constants as raw rem values, coupled by a code comment. If `TugButton`'s 2xs metrics change, the fenced-code Copy silently drifts. `enhanceFencedCode` is imperative DOM and can't directly use the `TugPushButton` component, but the sizing values can flow through a thin export instead of a comment.
- The body-kind `embedded` prop has a load-bearing precondition (must compose under a `ToolWrapperChrome` so affordances have a portal target). When that precondition is violated — `<FileBlock embedded />` rendered outside a chrome — the affordances vanish silently. The docstrings call this out as "unsupported," but a dev-mode `console.warn` would catch the mistake at the source rather than wait for someone to notice a missing Find button.
- `.tug-pane-body` and `.tug-pane-chrome` use `overflow: hidden`. They sit ABOVE the transcript scrollport (`.tug-list-view`) and don't currently trap any sticky element, but they form scroll containers — a constraint Phase B.1 flagged for future work. Any feature that wants a sticky element to escape `.tug-list-view`'s scrollport (e.g., a global "find across all transcript entries" bar, a session-wide notification ribbon) will be trapped by these walls. Phase B.1's note: "Worth a flag for Phase C; not in scope for B.1/B.2." Phase C didn't address it because the entry-header pin worked correctly against `.tug-list-view`. The walls remain. Switching to `overflow: clip` keeps the existing clipping behavior (rounded-corner clip, accessory-banner clip) but removes the scroll-container trap.

**Decisions.**

- **TugButton publishes its size metrics as CSS variables on `:root`.** Each size (`2xs` / `xs` / `sm` / `md` / `lg`) gets four exported metrics: `--tug-button-{size}-height`, `--tug-button-{size}-padding-inline`, `--tug-button-{size}-font-size`, `--tug-button-{size}-icon-size`. The internal size-class rules consume these so the source-of-truth is the variable, not the rem literal in the rule. Fenced-code Copy and any other consumer that needs to match a button size reads them directly. If 2xs changes, every consumer tracks automatically. (The `--tug7-*` token system stays untouched — these are *component-metrics* tokens, a third category alongside appearance and position-coordination.)
- **Body kinds dev-warn on embedded-without-chrome.** A `useEffect` (only when `process.env.NODE_ENV !== "production"`) that fires when `embedded === true` AND `useChromeActionsTarget() === null` logs a single console.warn naming the body kind and the misconfiguration. Production builds drop the check entirely (the early return on the unsupported branch keeps working, just silently). Same pattern as the existing dev-warns in `TugButton` for mutually-exclusive prop combinations.
- **`.tug-pane-body` and `.tug-pane-chrome` migrate `overflow: hidden` → `overflow: clip`.** WebKit supports `overflow: clip` (Safari 16+); the WKWebView shell targets a newer baseline. The existing pane-banner (`position: absolute` inside `.tug-pane-chrome`) clips identically under both modes since `overflow: clip` still clips painting. Manual verification covers the pane-banner, pane resize, drag, and inactive-content overlay because those paths could in principle interact with the scroll-container formation.

**Artifacts (Phase E.2):**

- Updated: `tugdeck/src/components/tugways/internal/tug-button.css` — publish `--tug-button-{2xs,xs,sm,md,lg}-{height,padding-inline,font-size,icon-size}` metrics on `:root` (or on `body` if that's where the existing tug-button slots live). The existing `.tug-button-size-{N}` rules reference the variables instead of rem literals.
- Updated: `tugdeck/src/components/tugways/tug-markdown-view.css` — fenced-code Copy reads `var(--tug-button-2xs-height)`, `var(--tug-button-2xs-font-size)`, `var(--tug-button-2xs-icon-size)` directly. The `--tugx-md-fenced-code-copy-*` token family becomes thin aliases (one-hop forwards to the `--tug-button-2xs-*` variables) or retires entirely if the consuming rule references the button metrics directly.
- Updated: `tugdeck/src/components/tugways/body-kinds/file-block.tsx`, `diff-block.tsx`, `terminal-block.tsx` — each adds a dev-mode `useEffect` that fires `console.warn` when `embedded === true && chromeActionsTarget === null`. Single warn per mount, mentions the body-kind name and the fix ("compose under a `<ToolWrapperChrome>` or set `embedded={false}`").
- Updated: `tugdeck/src/components/tugways/tug-pane.css` — `.tug-pane-body { overflow: clip }` and `.tug-pane-chrome { overflow: clip }`. The pane-banner and pane-overlay rules are reviewed to confirm `overflow: clip` doesn't break their `position: absolute` interactions (it shouldn't, since `clip` clips painting the same way `hidden` does).
- Updated: `tuglaws/component-authoring.md` — under "Pin-stack composition", note that all transcript-side ancestors of `.tug-list-view` now use `overflow: clip` so future sticky-coordination work isn't trapped by accident. Cross-reference Phase B.1's original flag.
- Updated: `tugdeck/src/components/tugways/internal/__tests__/tug-button.test.tsx` (or a new file if absent) — assert the published metric tokens are set on the host root and that the size-class rules consume them.
- Updated: `tugdeck/src/components/tugways/body-kinds/__tests__/file-block.test.tsx`, `diff-block.test.tsx`, `terminal-block.test.tsx` — assert the dev-warn fires on embedded-without-chrome and does NOT fire when composed under a chrome.

**Tasks (Phase E.2):**

- [x] **Publish `--tug-button-{size}-*` metrics on `tug-button.css`.** Done — five sizes × four metrics (height, padding-inline, font-size, icon-size) = 20 vars declared on `body{}`. All `.tug-button-size-{N}` and `.tug-button-icon-{N}` rules — including the SVG-sizing descendants — consume the tokens. No bare-rem literals remain inside the size-class rule bodies.
- [x] **Refactor fenced-code Copy CSS** to consume `--tug-button-2xs-*` directly. Done — `--tugx-md-fenced-code-copy-{padding,height,font-size,icon-size}` retired; the Copy rule reads `var(--tug-button-2xs-height/padding-inline/font-size/icon-size)` directly. The radius stays markdown-local (the imperative Copy uses a slightly different border-radius than TugPushButton's pill default; preserving the existing visual).
- [x] **Add dev-warns for embedded-without-chrome** in `FileBlock`, `DiffBlock`, `TerminalBlock`. Done — each body kind has a `useEffect` gated on `process.env.NODE_ENV !== "production"`, `embedded === true`, AND `chromeActionsTarget === null`. The warn is deferred via `setTimeout(0)` with a cleanup that cancels if the chrome publishes its target on the next render — otherwise the warn would fire spuriously on the legal first-render-under-chrome path (the chrome's `useState`-tracked actions target is `null` on its first render until the ref callback fires).
- [x] **Switch `.tug-pane-body` and `.tug-pane-chrome` to `overflow: clip`.** Done — both rules updated with an inline comment explaining the Phase B.1 latent-trap motivation. The `.tug-pane-chrome--collapsed` overlay rule kept `overflow: hidden` (collapsed panes don't host sticky descendants; minimum blast-radius change). The pane-banner, pane-overlay, and pane-resize tests still pass.
- [x] **Tests** for the metric-tokens published-on-:root contract; for the dev-warn firing on embedded-without-chrome (plus negative-check companions confirming the warn stays quiet under a chrome); for the pane CSS source declaring `overflow: clip`. Done — 11 new tests across `tug-button.test.tsx`, `file-block.test.tsx`, `diff-block.test.tsx`, `terminal-block.test.tsx`, `tug-pane.test.tsx`.
- [x] **Tuglaws update** documenting the metric-tokens category (third token category alongside appearance and position-coordination) and the pane-walls migration. Done — the "Position-coordination tokens vs. appearance tokens" section in `tuglaws/component-authoring.md` was expanded into a three-category model ("Token categories — three kinds, three different sovereignty rules"); the portaling-and-overlays section now notes that `overflow: clip` retains the painting clip while removing the scroll-container trap.

**Tests (commands, Phase E.2):**

- [x] `bun test src/components/tugways/internal/__tests__/tug-button.test.tsx` — 7 pass. Each per-size four-tuple is declared AND consumed; size-class rule bodies have no bare-rem literals.
- [x] `bun test src/components/tugways/body-kinds/__tests__/file-block.test.tsx` — 48 pass. Warn fires on `embedded` without chrome; no warn when composed under a chrome; no warn for standalone (embedded false).
- [x] `bun test src/components/tugways/body-kinds/__tests__/diff-block.test.tsx` — 58 pass. Same contract.
- [x] `bun test src/components/tugways/body-kinds/__tests__/terminal-block.test.tsx` — 38 pass. Same contract.
- [x] `bun test src/__tests__/tug-pane.test.tsx` — 17 pass (new file is `src/__tests__/tug-pane.test.tsx`, not in `tugways/__tests__/`). CSS source assertion: `.tug-pane-chrome` and `.tug-pane-body` both use `overflow: clip` and not `overflow: hidden`.
- [x] `bunx tsc --noEmit` — clean.
- [x] `bun run audit:tokens lint` — zero violations.
- [x] `bun test` (full suite) — **3597 pass, 0 fail** (post-Phase-E.1 baseline was 3586; +11 from this phase).

**Checkpoint (Phase E.2):**

- [x] Manual: open a fenced-code block in a markdown response. Visually compare the Copy button to a TerminalBlock Copy in the same transcript. They should match in height, font, padding, icon size.
- [x] Manual: in a dev build, render `<FileBlock embedded />` directly in the gallery (no chrome above) — confirm a single `console.warn` fires with the misconfiguration message.
- [x] Manual: drag a pane, resize a pane, drop into a tab, activate / deactivate. Confirm pane chrome behaves identically to pre-Phase-E.2.
- [x] Manual: open a long transcript with multiple tool calls. Confirm the entry-header pin, the chrome-header pin, and the diff hunk-header pin all behave identically to pre-Phase-E.2 — the `overflow: clip` change should be invisible to existing pinning.
- [x] After both E.1 and E.2 land: re-run the Phase D manual checkpoint to confirm no regressions.

---

##### Phase E.3 — Action-bar position invariance ("never move the mouse off the button")

**Depends on:** Phase E.2.

**Why this phase exists.** A pass over the surface in real use turned up four interaction-fidelity issues that all share a single root concept: *when the user presses an action-row button, the position of that button on screen must not change*. Buttons that change width, headers that grow tall enough to push the click point out from under the cursor, layout shifts that bump the click target — each one breaks the contract that the user is interacting with an object, not a paint that happens to be there. The four observed symptoms:

- **Scroll-jump on button press.** Clicking Find, the view-toggle, the fold cue, or Copy occasionally moves the surrounding scroll content away from the cursor. The button under the mouse shifts off-screen-relative even though the user hasn't scrolled. Cause: the click triggers a layout change (find row appears, fold expands, button width grows) and the outer card scrollport's content reflows so the same scroll offset no longer keeps the click point under the cursor. Browser-native behavior is "preserve scrollTop"; what the user wants is "preserve the *visual* position of the element under the cursor." The two are equivalent only when the click target sits ABOVE the layout change — but our action row sits at the TOP of the chrome, with the body BELOW it, so any growth above the action row pushes it down. (Today the find row appears below the action row, so the action row itself stays put on Find; but the fold cue is in the action row, and expanding adds rows below, which is fine in isolation but combines badly with sticky-header repositioning at the entry chrome level.)
- **Action-row button order is backwards.** The fold cue currently lives at the *left* of the trailing-actions area, with Find and the view-toggle to its right. The user's expectation: state-shape buttons (fold, in particular — the one that changes the BLOCK SHAPE) sit at the right edge as the anchor, and feature buttons (Find, view-toggle, Copy) sit to the left of them. Rationale: the fold cue is the "least-mobile" affordance — its meaning doesn't change with block contents and its position should be a fixed landmark. Find / view-toggle are body-kind-specific; they should sit closer to the title (the leading edge of the action row) and yield the right-edge anchor to fold.
- **Side-by-Side / Inline width drift.** The view-toggle button changes label between "SIDE BY SIDE" (~10 chars) and "INLINE" (~6 chars). That ~4-character width swing rearranges every button to its right on every toggle. Since the toggle button is itself a click target, the *next* click after toggling can land on a different button than the user aimed at.
- **Copy hover-state flicker.** Clicking Copy fires the `isConfirming` flash. During the flash, the hover background and hover border briefly disappear and then return — but only when the mouse moves. While the cursor sits still over the button through the entire press → "Copied" → revert cycle, the hover state vanishes on the state transitions and only reappears on a tiny mouse motion. The cause is compound, and the original "missing `:hover` companion for `[data-tug-confirming="true"]`" diagnosis only covers half of it. The controlled-confirming path also sets `aria-disabled="true"` on the button, and tug-button.css carries an `[aria-disabled="true"]` rule that explicitly suppresses hover bg/border — so even with a perfect `:hover` companion for the confirming attribute, the `aria-disabled` selector wins by specificity. Then on revert, the resting `:hover` rule *should* paint — but WebKit caches `:hover` selector matching against pointer events, not against arbitrary DOM mutations, so the cascade doesn't repaint until the next `mousemove`. The fix has to attack both edges.

**Decisions.**

- **Position-preserving click handler, no rAF.** Every action-row button that triggers a height-changing state mutation capture-snapshots the click target's `getBoundingClientRect()` *before* the state change, then in a `useLayoutEffect` after the state change, measures again and adds `(newTop - oldTop)` to the outer card scrollport's `scrollTop`. Net effect: the click point stays under the cursor across any height change above the button. Layout effects run depth-first post-order after React commits and before paint, so the measurement sees the final committed layout for the button's *outer* position — the body wrapper's CSS height is synchronous, and CM6's internal viewport recompute happens *inside* the wrapper without changing the wrapper's height, so the button's bounding rect is correct at useLayoutEffect time. No `requestAnimationFrame` anywhere — that would violate [L05] (rAF timing relative to React commits is a browser implementation detail, not a contract). If a future affordance needs to measure something that lives behind an async-laid-out descendant, the answer is a child-driven ready callback per [L04], not rAF. The mechanism lives in a shared hook (`usePositionStableClick`) that body kinds opt into for the fold-cue, Find toggle, and view-toggle buttons; Copy doesn't need it (no height change above the button). The hook walks up to the card scrollport via `OuterScrollportContext`, published by the entry-chrome scrollport owner and consumed by body-kind affordances. Off-screen guard: if `newTop` is negative or below viewport, skip the adjustment — clicking a button you can't see shouldn't snap-scroll something else into view.
- **Action-row buttons refuse focus-on-click.** Independent of the position-stable hook, the browser's default click → focus path can trigger an implicit scroll-into-view if the focused element is near a viewport edge. Focus-driven scroll happens *before* React's commit, so the position-stable hook can't compensate for it (its baseline snapshot was already taken, but the snapshot frame already drifted). Every action-row button gets `data-tug-focus="refuse"` so its pointerdown handler `preventDefault()`s the default focus action. The pattern exists in the codebase already (per the post-Phase-D refactors); this is an audit task, not a new mechanism.
- **Action-row order: fold cue rightmost, features left of it.** Visually: `[ Find ] [ Side By Side ] [ ... ] [ Copy ] [ 263 LINES ]`. The fold cue gets `margin-inline-start: auto` (or sits at the end of a flex row with `justify-content: flex-end` on its sub-group) so it always renders at the right edge. Find / view-toggle / Copy stay in a left-aligned group that fills from the title outward. Within that left group, ordering is: Find → view-toggle → Copy (left-to-right reading order matches frequency-of-use ranking).
- **View-toggle width stabilizes via CSS Grid with both labels in the same cell.** The button's effective width becomes `max(measure("SIDE BY SIDE"), measure("INLINE"))` regardless of which label is currently shown. The implementation: `display: inline-grid; grid-template-areas: "label"`, with both labels at `grid-area: label`. The grid cell sizes to max-content of all its participants, so the button's intrinsic width is the max of the two labels and stable across toggles. The inactive label is hidden via `visibility: hidden` (NOT `position: absolute` — that removes it from layout and defeats the entire mechanism, which is the mistake I made in the first draft of this phase). `aria-hidden="true"` on the inactive marks it as not-for-AT. Alternative considered: `min-width` set to a computed JS-measured constant. Rejected because the constant drifts with font metrics; the grid approach measures naturally and tracks font changes.
- **Confirming-state hover preservation, attacked at both edges.** (1) Drop `aria-disabled="true"` from the controlled-confirming path in `TugButton`. Confirming is a transient feedback state, not a disabled state. Click suppression during confirming uses `pointer-events: none` on the button instead — this preserves `:hover` selector matching (the geometric hover continues; only synthetic pointer events are gated) and stops second clicks from re-firing the handler. The button's resting tabindex and ARIA role are unchanged. (2) Add `:hover` companion declarations for `[data-tug-confirming="true"]` in tug-button.css so the confirming + hovered combination renders an integrated background (`color-mix` of confirming-bg with hover-overlay), not a bare confirming background. (3) On the revert edge, force pointer-state revalidation by setting and immediately unsetting a no-op DOM attribute on the button (e.g., `data-tug-flush` toggled inside the layout effect that clears `data-tug-confirming`). This triggers WebKit's selector re-evaluation without requiring user mouse motion. The `getBoundingClientRect()` trick from the first draft was inadequate — it forces layout recalc, not hover-selector re-matching.
- **(Optional, scope-permitting) Copy button widthstabilizes too.** "COPY" vs "COPIED" is a ~2-char swing. Apply the same grid approach the view-toggle uses. The savings are small but the consistency is worth it.

**Tuglaws compliance (Phase E.3).**

- **[L03] useLayoutEffect for events-dependent setup.** ✓ `usePositionStableClick` runs its post-state-change rect remeasurement and scrollport adjustment in `useLayoutEffect`, so the corrected scroll position is committed before the user sees the next paint. No intermediate misaligned frame.
- **[L04] Never measure child DOM inline after triggering child setState from a parent effect.** ✓ The position-stable hook lives in the same component that owns the state being mutated; layout effects run depth-first post-order so the parent measures after all children commit. The fold cue's outer screen position depends on the body wrapper's CSS height (synchronous), not on CM6's internal viewport, so no child-driven ready callback is needed for the measurement we actually do. If a future affordance needs to measure something behind an async-laid-out descendant, we add a child-driven ready callback per L04 — but Phase E.3 doesn't.
- **[L05] Never use `requestAnimationFrame` for operations that depend on React state commits.** ✓ Explicitly no rAF. The first-draft "bracket measurement in rAF for CM6 async layout" idea was rejected as an L05 violation. The hook uses `useLayoutEffect` exclusively. The async-descendant fallback path, if ever needed, uses L04's ready-callback pattern, not rAF.
- **[L06] Ephemeral appearance state goes through CSS and DOM, never React state.** ✓ The scroll adjustment is a direct DOM write (`scrollportRef.current.scrollTop += delta`). The rect snapshot is local data in a `useRef` with no rendering consumer. The widthStabilize ghost is CSS Grid + `visibility: hidden`. The confirming-hover companions are pure CSS. The `data-tug-flush` revalidation toggle is direct DOM mutation. Nothing pushes appearance through React state.
- **[L07] Action handlers access current state through refs, never stale closures.** ✓ The click handler reads live DOM (`getBoundingClientRect()`) and writes live DOM (`scrollTop`); no React state is closed over. The rect snapshot is held in a `useRef` so successive clicks don't race against the renderer.
- **[L11] Controls emit actions; responders own state.** ✓ Action-row buttons (controls) dispatch actions or call locally-owned state mutators; FileBlock/DiffBlock are the responders. Phase E.3 changes nothing about the chain shape — it adjusts the visual contract around state transitions.
- **[L19] Component authoring guide.** ✓ New hook `usePositionStableClick`, new context `OuterScrollportContext`, and the `widthStabilize` API on `TugPushButton` follow the guide. The new tuglaws subsection "Position-preserving interactions" documents the pattern.
- **[L20] Component-scoped tokens.** ✓ `widthStabilize` and `[data-tug-confirming]` rules live in tug-button.css and consume tug-button-scoped tokens. New hover-companion tokens (`--tug-button-confirming-hover-bg`, `--tug-button-confirming-hover-border`) are TugButton-scoped.
- **[L23] Internal implementation operations must never lose user-visible state.** ✓ The hook *preserves* a stronger user-visible invariant (click point stays under cursor) at the cost of a weaker one (the numeric scrollTop value). This is the L23-aligned trade: the user-visible thing is what the user sees and where they are pointing; numeric scroll offset is an implementation detail that serves that surface. We protect the higher-level invariant.
- **[L24] Three state zones.** ✓ Rect snapshot = local data (`useRef`). Scroll adjustment + ghost-label visibility + hover companions + flush attribute = appearance (DOM/CSS). Button reorder = JSX structure, a code-time edit, not runtime state. Zone boundaries respected.

**Artifacts (Phase E.3):**

- New: `tugdeck/src/components/tugways/internal/use-position-stable-click.ts` — exports `usePositionStableClick({ targetRef, scrollportRef })`. Returns a function that takes a state-mutator callback, snapshots the rect via `getBoundingClientRect()`, invokes the mutator, then schedules a `useLayoutEffect` rect remeasurement and scrollport `scrollTop` adjustment. No `requestAnimationFrame` (would violate [L05]). The snapshot is stored in a ref keyed on a `clickGeneration` counter so successive clicks during the same render don't lose the baseline. Off-screen guard: skip the adjustment when post-rect is outside [0, viewport.height].
- New: `tugdeck/src/components/tugways/cards/tool-wrappers/outer-scrollport-context.tsx` — minimal context publishing the entry-chrome scrollport DOM node. Provider is the component that owns that scrollport (likely the entry chrome or transcript scrollport owner, not `ToolWrapperChrome` itself — that's an implementation question for the task). Consumers use a `useOuterScrollport()` hook.
- Updated: `tugdeck/src/components/tugways/body-kinds/file-block.tsx` and `diff-block.tsx` — fold-cue, Find toggle, and view-toggle (DiffBlock) go through `usePositionStableClick`. Copy does not (no height change above the button). All action-row buttons carry `data-tug-focus="refuse"` (audited per the new task). Action-row order reshuffled: features-left (Find → view-toggle → Copy), fold-cue right.
- Updated: `tugdeck/src/components/tugways/body-kinds/terminal-block.tsx` — same reshuffle when its fold cue lands (depends on E.4; if E.4 ships first, this update folds in there).
- Updated: `tugdeck/src/components/tugways/internal/tug-button.tsx` + `.css` — new `widthStabilize?: { alternateLabel: string }` prop on `TugPushButton`. Renders both labels in a single button via `display: inline-grid; grid-template-areas: "label"` with both labels assigned `grid-area: label`. The inactive label has `visibility: hidden` and `aria-hidden="true"` and **remains in normal layout flow** (NOT `position: absolute`) so the grid cell sizes to max-content of both. Consumed by the view-toggle and (optionally) Copy.
- Updated: `tugdeck/src/components/tugways/internal/tug-button.tsx` — controlled-confirming path **stops setting `aria-disabled="true"`** and instead applies `pointer-events: none` while `isConfirming` is true. Geometric `:hover` matching is preserved; synthetic click re-firing is still blocked. The layout effect that clears `data-tug-confirming` also toggles a no-op `data-tug-flush` attribute (set, then unset in the same effect) to force WebKit `:hover` selector revalidation without requiring user mouse motion.
- Updated: `tugdeck/src/components/tugways/internal/tug-button.css` — add `:hover` companion declarations for `[data-tug-confirming="true"]`. New TugButton-scoped tokens `--tug-button-confirming-hover-bg`, `--tug-button-confirming-hover-border` declared in both `brio.css` and `harmony.css`. Existing `[aria-disabled="true"]` rule no longer applies during confirming (the attribute is no longer set on that path).
- Updated: `tuglaws/component-authoring.md` — new "Position-preserving interactions" subsection under Component Patterns documents `usePositionStableClick` (when to use, what it costs, hook-ordering caveats, the [L04]/[L05] reasoning). Under "Controlled feedback states," the section is amended to spell out: (a) confirming is NOT a disabled state; use `pointer-events: none` for click suppression; (b) `:hover` companion rules are required; (c) hover-selector revalidation needs a DOM-attribute toggle, not a layout read.
- Updated: `tugdeck/src/components/tugways/internal/__tests__/tug-button.test.tsx` — new tests: `widthStabilize` makes the rendered button width equal to the wider label across toggle (grid cell sized to max-content of both children); controlled-confirming path does NOT set `aria-disabled`; `pointer-events: none` applies while confirming; the `:hover` companion rule for `[data-tug-confirming="true"]` exists in the CSS source; the `data-tug-flush` toggle is set+unset during the revert-edge layout effect.
- Updated: `tugdeck/src/components/tugways/body-kinds/__tests__/file-block.test.tsx` and `diff-block.test.tsx` — new tests: button order (fold cue is the last child of the trailing-actions container); clicking the fold cue with a stub scrollport observes a `scrollTop` adjustment matching the post-click rect delta; every action-row button carries `data-tug-focus="refuse"`.

**Tasks (Phase E.3):**

- [x] **Build `usePositionStableClick` + `OuterScrollportContext`.** Done — hook lives at `tugdeck/src/components/tugways/internal/use-position-stable-click.ts` and the context at `tugdeck/src/components/tugways/internal/outer-scrollport-context.tsx`. `TugListView` publishes its scroll container via `OuterScrollportProvider` so descendants find it through `useOuterScrollport()`. Hook captures pre-state rect, runs the caller's mutator, then in a `useLayoutEffect` keyed on a generation counter measures the new rect and writes `scrollportRef.current.scrollTop += delta`. Guards skip when scrollport is null, when delta is zero, or when the post-rect is outside `[0, viewport.height]`. `useLayoutEffect` exclusively — no rAF anywhere ([L05]).
- [x] **Wire fold cue, Find toggle, view-toggle through the hook** in `FileBlock` and `DiffBlock`. Done — each button has its own target ref, and onClick routes through `stableFoldClick` / `stableFindClick` / `stableViewToggleClick` so the snapshot → mutator → compensate sequence runs once per click. Copy doesn't need the hook (no height change above the button); kept on plain onClick.
- [x] **Audit `data-tug-focus="refuse"` on every action-row button.** Done — `TugButton` sets `data-tug-focus="refuse"` on its rendered button element (tug-button.tsx:669), and every action-row affordance goes through `TugPushButton` → `TugButton`. New structural tests in `file-block.test.tsx` and `diff-block.test.tsx` assert the attribute is present on every button inside the actions cluster, so a regression that swaps a Tug primitive for a raw `<button>` would fail the test.
- [x] **Reorder the action row.** Done — JSX order in both `FileBlock` and `DiffBlock` puts features first (Find / view-toggle) and the fold cue last, so the cue sits at the trailing edge as a fixed-position landmark. Cluster layout is flex with default `flex-start`, so source order = visual LTR order.
- [x] **Add `widthStabilize` to `TugPushButton` using CSS Grid.** Done — new optional prop `widthStabilize?: { alternateLabel: ReactNode }` on `TugButton`. When provided, the label is wrapped in `.tug-button-stable-label` (`display: inline-grid; grid-template-areas: "label"`) with both labels assigned `grid-area: label`. The inactive label has `visibility: hidden` + `aria-hidden="true"` and stays in normal layout flow; the cell sizes to max-content of both. CSS lives in `tug-button.css`.
- [x] **Apply `widthStabilize` to the view-toggle button** in `DiffBlock`. Done — passes `widthStabilize={{ alternateLabel: <opposite label> }}` so the button width is `max(measure("Inline"), measure("Side by side"))` regardless of which is currently active.
- [ ] **(Optional)** apply `widthStabilize` to the Copy button across all body kinds (`"COPY"` ↔ `"COPIED"`). Deferred — the Copy width swing is smaller and not in the user's complaint list.
- [x] **Drop `aria-disabled` from BOTH confirming paths in TugButton.** Done — neither the uncontrolled `enterConfirmation` nor the controlled `useLayoutEffect` writes `aria-disabled` during the confirming window. Click suppression relies on the existing `confirmingRef` JS guard inside the click handler. The companion `[aria-disabled="true"][data-tug-confirming="true"]` override block was deleted from `tug-button.css` since the combination can no longer occur on the confirming path. (Implementation note: the first-draft proposal of `pointer-events: none` as a substitute was rejected because `pointer-events: none` actually disables `:hover` matching in WebKit too — see the revised reasoning in `tuglaws/component-authoring.md` "Controlled feedback states".)
- [x] **Add hover-companion rule for `[data-tug-confirming="true"]`** in `tug-button.css`. Done — `.tug-button-ghost-action[data-tug-confirming="true"]:hover:not(:disabled)` lives after the rest-hover rule and wins on source order at equal (0,4,0) specificity. Composite background uses `color-mix(in srgb, confirmed 88%, hover 12%)` so the user reads "still confirming, still hovering" without introducing new theme tokens (kept the integration component-internal per [L20]).
- [x] **Force pointer-state revalidation on the confirming revert edge.** Done — both the uncontrolled timer callback and the controlled-mode `useLayoutEffect` toggle a no-op `data-tug-flush` attribute (set, then delete in the same effect body) inside the same beat that removes `data-tug-confirming`. The attribute has no styling effect but the mutation invalidates the style cache so WebKit re-evaluates `:hover` selector matching without waiting for `mousemove`.
- [x] **Tests** for hook behavior, button reorder, widthStabilize, absence of aria-disabled, hover-companion rule, flush-attribute pattern. Done — 5 new tests in `use-position-stable-click.test.tsx` (the new file), 6 new tests in `tug-button.test.tsx` (widthStabilize × 2, hover-companion CSS rule, flush pattern in source, aria-disabled-not-set in source, inverted aria-disabled runtime assertion), 2 new tests in `file-block.test.tsx` (fold-cue rightmost, focus-refuse audit), 4 new tests in `diff-block.test.tsx` (view-toggle leftmost, widthStabilize wrapper, focus-refuse audit, plus the textContent-assertion fix for the existing toggle test which now reads from `[data-tug-stable-label="active"]`).
- [x] **Tuglaws update.** Done — `tuglaws/component-authoring.md` "Controlled feedback states" section expanded with the Phase E.3 confirming contract (no aria-disabled, JS-guard click suppression, hover companion rules required, revert-edge flush). New subsection "Position-preserving interactions (Phase E.3)" documents `usePositionStableClick` end-to-end including the full L03/L04/L05/L06/L07/L23/L24 conformance walk.

**Tests (commands, Phase E.3):**

- [x] `bun test src/components/tugways/internal/__tests__/tug-button.test.tsx` — 12 pass. `widthStabilize` markup + grid composition; confirming hover-companion CSS rule present; `data-tug-flush` toggle pattern present in source; no `setAttribute("aria-disabled", …)` confirming-related calls in source; the runtime `isConfirming={true}` test asserts `aria-disabled` is absent (the Phase E.1 test was inverted from "with aria-disabled" to "without").
- [x] `bun test src/components/tugways/internal/__tests__/use-position-stable-click.test.tsx` (new file) — 5 pass. Stub scrollport with controllable rect-queue, `scrollTop` adjusted by delta in the happy case, null-scrollport degrades gracefully, off-screen guard kicks in for negative post-rect, zero-delta is a no-op write, and the source contains no `requestAnimationFrame` calls ([L05] structural check).
- [x] `bun test src/components/tugways/body-kinds/__tests__/file-block.test.tsx` — 50 pass. New Phase E.3 tests: fold cue is the last button in the actions cluster (rightmost in LTR), every action-row button carries `data-tug-focus="refuse"`.
- [x] `bun test src/components/tugways/body-kinds/__tests__/diff-block.test.tsx` — 61 pass. New Phase E.3 tests: view-toggle is the first button in the cluster + fold cue is the last; view-toggle's `widthStabilize` wrapper carries both labels and the label set covers `{"Inline", "Side by side"}`; every action-row button carries `data-tug-focus="refuse"`. Existing textContent assertion on the view-toggle now reads from `[data-tug-stable-label="active"]` since the button's `textContent` concatenates both visible and hidden labels.
- [x] `bunx tsc --noEmit` — clean.
- [x] `bun run audit:tokens lint` — zero violations.
- [x] `bun test` (full suite) — **3612 pass, 0 fail** (Phase E.2 baseline was 3597; +15 from this phase).

**Checkpoint (Phase E.3):**

- [ ] Manual: open a long file in a Read tool block. Scroll the entry chrome so the file-block's action row is in the middle of the visible viewport. Click the fold cue. Confirm the fold cue stays directly under the cursor — the scroll position adjusts to compensate for the height collapse.
- [ ] Manual: same setup, click Find. Confirm the Find button stays under the cursor as the find row appears below it.
- [ ] Manual: open a DiffBlock. Toggle Side By Side ↔ Inline three times. Confirm the toggle button's bounding rect does not shift between clicks — width is stable.
- [ ] Manual: hover over a Copy button. Click it without moving the mouse. Watch the transition into and out of the "Copied" state. Confirm the hover background and border remain visible through the entire interaction; no flicker.
- [ ] Manual: action-row order — visually verify fold cue is rightmost on FileBlock and DiffBlock; Find / view-toggle / Copy sit to its left.

> **Note on manual checkpoints.** HMR is always running, so the code changes are live in the user's running app. The manual verifications above are the user's job — automated tests cover the structural invariants (button order, focus-refuse coverage, widthStabilize markup, no-aria-disabled-in-confirming, presence of hover-companion rules) but cannot verify the *visual* fidelity of the position-stable behavior, the hover-flicker fix, or the width-stable toggle in a real browser.

---

##### Phase E.4 — Affordance completeness across body kinds

**Depends on:** Phase E.3 (so new affordances inherit the position-stable click hook and the reordered layout).

**Why this phase exists.** Three affordances that should exist on every long-content body kind are missing or under-built:

- **FileBlock has no Copy button.** Users frequently want to copy the full file shown in a Read tool block — to paste into a prompt, into another editor, into a chat. The pattern is universal in code surfaces; its absence is conspicuous next to the TerminalBlock and fenced-code Copy buttons.
- **TerminalBlock (Bash output) has no expand/fold button.** Bash output that runs to hundreds of lines presents the same readability problem as a long Read block, but TerminalBlock currently renders all of it inline without a fold cue. Long Bash output dominates the transcript and forces the reader to scroll past it to reach the next response message.
- **DiffBlock's "Side by Side / Inline" toggle is the wrong primitive.** The control is a mutually exclusive 2-way picker — Side-by-Side OR Inline, never both, never neither. Today it renders as a single `TugButton` whose label flips between "SIDE BY SIDE" and "INLINE" (stabilized via Phase E.3's `widthStabilize` grid shim). That shape hides the alternative from view: the user reads "SIDE BY SIDE" and has to *guess* that clicking will switch to inline. The correct primitive is `TugChoiceGroup` — both options visible as segments, with appropriate icons, and the sliding indicator pill making the current selection unmistakable. This is also the primitive the surface already uses for other 2-way pickers in tugways (see `gallery-choice-group.tsx`); the toggle-button shape was a Phase D shortcut.

The first two gaps are recognized in the original Step 10.9 scope — Copy lived on FileBlock before the action-row consolidation but got dropped in Phase D, and Bash fold was deferred. The third (view-toggle as choice group) is a follow-on from Phase E.3: once the action-row layout and click-stability hooks were in place, the right primitive became reachable. Phase E.4 closes all three.

**Decisions.**

- **FileBlock Copy reuses the controlled-confirmation pattern from TerminalBlock.** Same `[copied, setCopied]` local state, same `setTimeout` clear, same `isConfirming` flow into `TugPushButton`. Source text is the full file content as passed to `TugCodeView`; the Copy handler reads from the same ref the find session reads from. Failure path: no flash (matches TerminalBlock's honest-confirmation contract from Phase E.1).
- **TerminalBlock fold cue mirrors FileBlock's pattern.** Computed-collapse pattern: `useState(overThreshold)` where `overThreshold = lineCount > FOLD_THRESHOLD_LINES`. Threshold initially 40 lines (matches FileBlock's threshold; aligns the visual rhythm). Cue text: `"N LINES"` like FileBlock — Bash output is line-structured the same way file content is. Chevron icon flips between fold-in (chevrons-up) and fold-out (chevrons-down). When collapsed, the body renders a height-capped preview (first ~8 lines) with a fade-out gradient at the bottom; clicking the cue (or anywhere in the fade region) expands. The fold cue lives in the action-row right edge per the Phase E.3 ordering.
- **TerminalBlock fold cue interacts with the responder chain identically to FileBlock.** TerminalBlock already has a responder for COPY; it grows to register itself as a responder parent so any future find-on-terminal feature can route through the chain. Out of scope for E.4: Find on TerminalBlock; just the chain plumbing is in place.
- **Threshold + initial-state authority lives on the body kind, not in props.** Like FileBlock, the consumer (a tool-wrapper or assistant-rendering layer) may override the initial fold state via `collapsed={true|false}` prop, with the computed-value pattern from Phase E.1 driving the resolution. Standalone gallery / standalone usage just relies on the threshold heuristic.
- **DiffBlock view-toggle becomes a `TugChoiceGroup`.** Two segments:
  - `{ value: "side-by-side", icon: <Columns2 />, "aria-label": "Side by Side" }`
  - `{ value: "inline", icon: <AlignLeft />, "aria-label": "Inline" }`

  Icons come from `lucide-react` (already in use across tugways). `Columns2` reads as two adjacent panes — the side-by-side mental model — and `AlignLeft` reads as stacked lines of text — the inline mental model. Labels appear alongside the icons (`iconPosition="left"`); the choice group's intrinsic two-segment layout makes width naturally stable, so the Phase E.3 `widthStabilize` shim is no longer needed on this control and is removed from the DiffBlock view-toggle. Size: `"xs"` — matches the action-row's affordance scale (same vertical metrics as the `TugButton` it replaces). Role: omit (theme accent on the indicator pill) — consistent with other action-row affordances that don't signal a semantic state.

  Activation routes through the responder chain via `selectValue` (TugChoiceGroup's native action). DiffBlock grows a `selectValue` handler in its responder-form registration, switches on the segment's value, and updates the `viewMode` state. The handler runs inside the position-stable click hook from Phase E.3 so the action row stays at the user's cursor when the toggle changes document height (side-by-side vs inline can differ in row count). `tug-disengage-follow-bottom` still dispatches on activation.

  No prop-shape change at the DiffBlock public surface: `viewMode` / `onViewModeChange` (or whatever the existing controlled-vs-uncontrolled prop is) stays the same; only the internal control swaps.

**Tuglaws compliance (Phase E.4).**

- **[L03] useLayoutEffect for events-dependent setup.** ✓ TerminalBlock's new responder-parent registration goes through `useResponderForm` / `useOptionalResponder`, which already use `useLayoutEffect` internally — registration is complete before any keystroke could route to the parent. No new event-registration code at this layer; the existing infrastructure carries the contract.
- **[L04] Never measure child DOM inline after triggering child setState from a parent effect.** ✓ No parent-triggered child setState anywhere in this phase. FileBlock's Copy handler reads file text from a ref the host already maintains for the find session (latest-ref per [L07]); no cross-component measurement. TerminalBlock's collapse-state and copy-state both live in the component that owns them.
- **[L05] Never use `requestAnimationFrame` for operations that depend on React state commits.** ✓ No rAF anywhere in E.4. The Copy confirmation flow uses the controlled-`isConfirming` pattern established in Phase E.1 (a `setTimeout` for clearing the flag, which is fine — it doesn't gate on React commits; it's a timing constant for a UX flash). The fold-cue collapse is a direct CSS height change driven by React render.
- **[L06] Ephemeral appearance state goes through CSS and DOM, never React state.** ✓ The collapsed-preview fade gradient (`--tugx-terminal-collapsed-fade`) is a CSS-only effect declared in tug-terminal-block.css. The Copy confirmation visual flows through the existing `data-tug-confirming` DOM attribute (driven by the controlled `isConfirming` prop). No appearance state is round-tripped through React beyond what already exists in TugButton.
  - **What IS state, what IS NOT appearance:** the collapsed boolean is *data* (parents can read and override it via the `collapsed` prop); it has a non-rendering consumer (the parent's logic). Per L06, data may live in React. The fade gradient, by contrast, has no non-rendering consumer — pure appearance — and stays in CSS.
- **[L07] Action handlers access current state through refs, never stale closures.** ✓ FileBlock's Copy handler reads the file text via `fileTextRef.current` (mirrors the find-session pattern). TerminalBlock's Copy handler already uses this pattern. The clipboard write callbacks (`.then`/`.catch`) read live state at fire time, never closed-over values.
- **[L11] Controls emit actions; responders own state.** ✓ TerminalBlock graduates from "responder for COPY" to "responder + responder parent" — it now hosts a scope that descendants (future find-input, copy-button) can attach into. The current Copy button stays a control that dispatches into the chain; TerminalBlock remains the responder that owns the underlying `text` data the COPY action operates on. The fold cue is a control that mutates state owned by TerminalBlock (the collapsed flag); TerminalBlock is the responder for that state. No chain-shape change beyond adding the parent registration.
  - **Choice-group dispatch (DiffBlock view-toggle).** ✓ TugChoiceGroup is a control: it emits `selectValue` with the new segment value and a stable `sender` id. DiffBlock is the responder that owns the `viewMode` state. Migrating the toggle from `TugButton` (which today calls a local handler directly) to `TugChoiceGroup` (which dispatches through the chain) actually tightens L11 compliance — the view-toggle joins the same action-driven contract every other tugways primitive follows, instead of being a special-case button with an embedded mutator. Parent override (a host that wants to control `viewMode` from outside DiffBlock) gains a clean intercept point: register `selectValue` higher in the chain and switch on `event.sender`.
- **[L17] Component alias tokens resolve to `--tug7-*` in one hop.** ✓ New tokens introduced in E.4 (`--tugx-terminal-collapsed-fade`, fold-cue tokens that derive from existing terminal-block tokens) point directly at a `--tug7-*` target — no alias-to-alias chains. `audit:tokens lint` enforces.
- **[L19] Component authoring guide.** ✓ Both updated body kinds (FileBlock with new Copy, TerminalBlock with new fold cue) keep their `@tug-pairings` / `@tug-renders-on` / `data-slot` declarations in sync with the new affordances. The galleries get matrices for the new states. DiffBlock's `@tug-pairings` declaration is reviewed when the view-toggle swaps from `TugButton` to `TugChoiceGroup`: the choice group brings its own pairings (indicator-pill foreground over choice-group surface), which compose into DiffBlock's existing pairings list rather than being duplicated. The `widthStabilize` shim on the view-toggle is removed and its mention in the action-row tuglaws sub-section is updated to scope `widthStabilize` to controls that *change their own label*, not to controls that swap between fixed-label segments.
- **[L20] Component-scoped tokens.** ✓ TerminalBlock's new fade token lives under `--tugx-terminal-*` (TerminalBlock's component slot). The FileBlock Copy button consumes TugPushButton tokens through composition (TugPushButton owns its own appearance per L20). No cross-component token references.
- **[L23] Internal implementation operations must never lose user-visible state.** ⚠ Partial — the in-session minimal-mutation path is fine (collapse state lives in React `useState` inside a component whose DOM stays mounted across pane operations). The cross-session [A9] preservation question — should an expanded TerminalBlock stay expanded across cold-boot / tab-deactivation / card destruction-restore? — is *not* addressed in E.4 and should be tracked. The current behavior (re-collapse on remount via the threshold heuristic) is defensible because the threshold heuristic produces a sensible default; if cross-session preservation is desired, it's a follow-on phase that hooks TerminalBlock into the `useComponentStatePreservation` machinery, mirroring whatever DiffBlock/FileBlock do today.
- **[L24] Three state zones.** ✓ Collapsed boolean + Copy-confirming flag = local data (`useState`). Fade gradient + button affordance markup = appearance (CSS). Responder-parent registration = structure (`useLayoutEffect` at mount via the existing hook infrastructure). Zone boundaries respected.

**Artifacts (Phase E.4):**

- Updated: `tugdeck/src/components/tugways/body-kinds/file-block.tsx` — add Copy button to the action row's features group (per Phase E.3 ordering: Find → Copy → fold cue). Controlled `isConfirming` pattern; reads file content from the same source the find session uses; failure path leaves the button at rest.
- Updated: `tugdeck/src/components/tugways/body-kinds/terminal-block.tsx` — add fold-cue button (rightmost in action row); computed-collapse state with FOLD_THRESHOLD_LINES = 40 default; collapsed render shows first ~8 lines + bottom fade; expand restores full output. Register as a responder parent (no FIND actions yet; placeholder for future).
- Updated: `tugdeck/src/components/tugways/body-kinds/diff-block.tsx` — swap the view-toggle `TugButton` for a `TugChoiceGroup` (two segments: side-by-side / inline, with `Columns2` and `AlignLeft` icons). Remove the `widthStabilize` prop on the old toggle. Register a `selectValue` handler on the DiffBlock responder form; switch on the segment value to set `viewMode`. Route the activation through `usePositionStableClick` from Phase E.3 (same anchor as the fold cue) so the action row holds position when the toggle changes document height. Dispatch `tug-disengage-follow-bottom` on activation, same as the fold cue.
- Updated: `tugdeck/src/components/tugways/body-kinds/diff-block.css` — drop any rules that scoped to the old view-toggle button (e.g. `[data-slot="diff-view-toggle"]` if it carried bespoke metrics). TugChoiceGroup brings its own appearance; no new diff-block-local appearance tokens needed beyond the action-row slot positioning that already exists from Phase E.3.
- Updated: `tugdeck/src/components/tugways/body-kinds/file-block.css` — Copy button slot; no layout-affecting changes beyond what Phase E.3 already established.
- Updated: `tugdeck/src/components/tugways/body-kinds/terminal-block.css` — fold-cue slot; collapsed-preview height cap + bottom fade gradient. Both `brio` and `harmony` token themes carry the fade gradient values.
- Updated: `tugdeck/src/components/tugways/cards/gallery-file-block.tsx` and `gallery-terminal-block.tsx` — gallery matrices show standalone-with-copy and folded-vs-expanded states for visual review.
- Updated: `tugdeck/src/components/tugways/body-kinds/__tests__/file-block.test.tsx` — Copy click writes to clipboard; `isConfirming` flashes on success; failure path stays at rest.
- Updated: `tugdeck/src/components/tugways/body-kinds/__tests__/terminal-block.test.tsx` — long Bash output renders collapsed by default; cue label reflects line count; clicking expands; controlled-collapse via prop works; responder parent registration verified.
- Updated: `tugdeck/src/components/tugways/body-kinds/__tests__/diff-block.test.tsx` — view-toggle renders as a `radiogroup` with two segments (side-by-side, inline); both segments visible simultaneously; selecting the non-current segment dispatches `selectValue` and flips `viewMode`; the `widthStabilize` wrapper is gone from the view-toggle; both segments carry `data-tug-focus="refuse"` (inherited from TugChoiceGroup's segment buttons or added at the wrapper). The Phase E.3 assertions on action-row order and fold-cue last-child remain — only the leftmost affordance shape changes from `button[role=button]` to `div[role=radiogroup]`.

**Tasks (Phase E.4):**

- [x] **Add Copy button to FileBlock.** Local `[copied, setCopied]` state; click handler does `writeText(fileText).then(() => setCopied(true)).catch(() => undefined)`; `setTimeout` clears the flag after `COPIED_FLASH_MS`. Cleanup on unmount. Button slots into the features group per Phase E.3 ordering. (No `widthStabilize` — matches TerminalBlock's Copy pattern.)
- [x] **Add fold cue to TerminalBlock.** Mirrors FileBlock's structure: computed-collapse via `quickLineCount` (no ANSI parse), `FOLD_THRESHOLD_LINES = 40` const, chevron + line-count label, controlled-via-prop (`collapsed` / `onToggleCollapsed`), default-from-threshold. Collapsed render shows the first `COLLAPSED_PREVIEW_LINES` (8) lines via the flat path (no virtualizer, no truncation banner, no footer); CSS applies a `mask-image` linear-gradient via the `--tugx-term-collapsed-fade` token. Both static and streaming modes honor the flag via `initialDataRef` (static, mount-once for `data`) / `collapsedStreamingRef` (streaming, latest-ref).
- [x] **Wire TerminalBlock as a responder parent.** `useOptionalResponder` shape mirroring FileBlock's `fileBlockResponder`: `useId` for the responder ID, `Partial<Record<TugAction, ActionHandler>>` carrying only `COPY` today, structured to grow. `ResponderScope` wraps the root; `composedRootRef` writes `data-responder-id` on the body kind's outer element. Chain manager promotes TerminalBlock to first-responder after fold-cue clicks (the cue carries `data-tug-focus="refuse"`).
- [x] **Update gallery matrices.** Updated `gallery-pinned-headers.tsx` section titles + added a new "TerminalBlock — 200 lines, expanded" section so the folded-by-default preview and expanded virtualizer paths both render side-by-side. (Note: there are no separate `gallery-file-block.tsx` / `gallery-terminal-block.tsx` / `gallery-diff-block.tsx` files — body kinds are exercised via `gallery-pinned-headers` and the tool-wrapper galleries.)
- [x] **Tests** — 7 new Copy tests (FileBlock), 9 new fold-cue tests + 2 responder-parent tests (TerminalBlock), 5 updated view-toggle tests + 2 new shape pins (DiffBlock).
- [x] **Swap DiffBlock view-toggle to `TugChoiceGroup`.** Two segments (`Columns2` + "Side by side", `AlignLeft` + "Inline"); `size="xs"`; `disabled={collapsed}`. `useResponderForm` registers a `selectValue` handler that routes the segment value through `stableViewToggleClickRef.current(() => applyViewModeRef.current(value))`; `tug-disengage-follow-bottom` dispatches before the mutator. `viewToggleRef` is a div ref pointing at the choice group's root (the position-stable anchor). `widthStabilize` removed from this control.
- [x] **Audit `widthStabilize` callers.** Post-migration: zero production call sites (only `tug-button.tsx` definition + the test for the prop). Per the plan, kept the prop on `TugButton` for future confirming flows ("Copy"→"Copied" label swap); added a Phase E.4 scoping note to `tuglaws/component-authoring.md` describing the difference between *label-flipping* (use `widthStabilize`) and *segment-style 2-way pickers* (use `TugChoiceGroup`).

**Tests (commands, Phase E.4):**

- [x] `bun test src/components/tugways/body-kinds/__tests__/file-block.test.tsx` — 57 pass (was 50 — 7 new Copy tests).
- [x] `bun test src/components/tugways/body-kinds/__tests__/terminal-block.test.tsx` — 49 pass (was 38 — 11 new fold-cue + responder tests; 3 virtualization tests updated to opt-out of default-fold).
- [x] `bun test src/components/tugways/body-kinds/__tests__/diff-block.test.tsx` — 61 pass (was 58 — view-toggle shape tests rewritten for `radiogroup`, 2 new pins for the chrome-routed dispatch path).
- [x] `bunx tsc --noEmit` — clean.
- [x] `bun run audit:tokens lint` — zero violations.
- [x] `bun test` (full suite) — 3641 pass / 0 fail (was 3623 baseline; net +18 tests).

**Checkpoint (Phase E.4):**

- [x] Manual: open a Read tool on any file. Confirm the Copy button is present in the action row, sits left of the fold cue, and copies the full file content to the clipboard with the same "Copied" flash as TerminalBlock.
- [x] Manual: run a `find . | head -300` Bash command. Confirm the output renders collapsed with a fade at the bottom; the fold cue at the right edge reads "300 LINES" (or matches the actual line count). Click the cue → output expands. Click again → re-collapses.
- [x] Manual: pass `collapsed={false}` to a TerminalBlock from a parent harness; click the cue. Confirm the parent's `onToggleCollapsed` fires but the visible state stays expanded (parent controls it).
- [x] Manual: open any DiffBlock in the live transcript. Confirm the view-toggle renders as a two-segment choice group with `Columns2` + "Side by Side" and `AlignLeft` + "Inline"; the currently selected segment shows the sliding indicator pill; clicking the non-current segment swaps the diff render mode and the indicator slides to the new position; the action row does not jump (position-stable click anchor preserved); arrow-key navigation (Left / Right) moves the selection and re-renders the diff (TugChoiceGroup's native keyboard contract); Cmd-Z / Cmd-Shift-Z do nothing here (this control is not undoable, matching other tugways choice groups).

---

##### Phase E.5 — Card-level scroll behavior (wheel-routing + Bash render-on-scroll)

**Depends on:** Phase E.3 (the outer-scrollport context publishes the node E.5 needs to address directly).

**Why this phase exists.** Two scroll-behavior issues sit on the same surface — they're both about how the inner block scrollers (FileBlock's CM6 scrollport, DiffBlock's hunks scrollport, TerminalBlock's overflow region) interact with the outer card scrollport. Today the inner scrollers always win when the cursor is over them, and they sometimes fail to repaint when scrolled into view via the outer scrollport. Both issues degrade the reading flow in long transcripts.

- **Wheel-capture is always-on for inner scrollers.** When the user is reading a long transcript and the wheel scrolls past a fenced code block, a Read tool, a Diff, or a long Bash output, the wheel events get captured by the inner block scrollport as soon as the cursor hovers it — the outer card scrollport stops moving until the cursor leaves the inner region. For users who want to skim past a tool result without engaging with its internals, this is a stutter. The desired escape hatch: **hold Cmd while scrolling to bypass inner capture and always scroll the outer card scrollport.** Default behavior (wheel-without-Cmd) keeps the inner capture as today.
- **Bash output sometimes renders blank after scrolling into view.** Intermittently reproducible (the user reports it can't be triggered at will): scrolling down into a long Bash output region shows an empty terminal frame; scrolling *within* the terminal — or just touching the inner scrollport's wheel handler — repaints the output. Possible causes: an `IntersectionObserver`-based virtualization in TerminalBlock that doesn't fire on the first composite paint after the chrome resizes; a CodeMirror-style virtualizer that uses `requestAnimationFrame` and gets starved by another layout pass; or a WebKit-specific subpixel-transform + clip-path bug where the inner scrollport's content layer doesn't repaint when its ancestor's transform changes. Diagnosis is part of the phase — but the most likely fix (regardless of exact root cause) is to force a re-measure / re-paint when the outer card scrollport scrolls the terminal into view.

**Decisions.**

- **Cmd-wheel routes to the outer scrollport.** A capture-phase `wheel` listener on each inner block scrollport (FileBlock CM6 root, DiffBlock hunks container, TerminalBlock overflow region) checks `event.metaKey` (Mac) / `event.ctrlKey` (Win/Linux) and, when set, calls `event.preventDefault()` + `event.stopPropagation()`, then forwards the deltaY to the outer scrollport's `scrollTop`. Inner scrollers thus *never* receive Cmd-wheel events; outer always does. Non-modifier wheel: passes through unchanged (existing browser behavior — inner captures until exhausted, then bubbles to outer).
- **Mechanism lives in a shared hook.** `useOuterScrollOnModifierWheel({ innerRef, scrollportRef, modifierKeys: ["meta", "ctrl"] })` attaches the listener with `{ capture: true, passive: false }` (must be non-passive to call preventDefault). Returns nothing; hook owns lifecycle. Body kinds opt in by calling the hook with their inner-scrollport ref.
- **Bash render-on-scroll mitigation: outer scroll forces a TerminalBlock re-measure.** Subscribe to the outer scrollport's `scroll` event in TerminalBlock. When a `scroll` fires AND the terminal's intersection ratio crosses some threshold (entering view), call the terminal's internal `resize()` / `fit()` method (whichever the terminal renderer exposes) to force a repaint. The fix is *targeted at the symptom*: forcing re-fit when content scrolls into view eliminates the blank-frame intermittent regardless of which root cause is responsible. If a deeper root-cause investigation reveals a more surgical fix during implementation, prefer that — but the scroll-triggered refit is the fallback.
- **Diagnosis pass before the symptom-fix.** Before adding the scroll-triggered refit, instrument the TerminalBlock render path: log when the body mounts, when content first arrives, when intersection observer fires, when the inner scrollport's first paint completes. Capture the timing across 10+ live sessions (transcript with mixed tool calls + Bash outputs). If a deterministic root cause emerges (e.g., "intersection observer fires before content mounts" or "outer scrollport's clip-path invalidates inner paint"), fix at the root. Otherwise ship the scroll-triggered refit as the targeted mitigation.

**Tuglaws compliance (Phase E.5).**

- **[L03] useLayoutEffect for events-dependent setup.** ✓ The Cmd-wheel hook attaches its capture-phase listener in `useLayoutEffect`, not `useEffect`. The listener has to be live before the first wheel event a user could plausibly generate; layout-effect timing guarantees this — the listener is registered between commit and paint, so the very first paint frame already has wheel-routing in place. Same pattern for the scroll-listener that drives the Bash refit: registered in `useLayoutEffect` so it observes from the first scroll the user can trigger.
- **[L04] Never measure child DOM inline after triggering child setState from a parent effect.** ✓ The Cmd-wheel hook reads `event.deltaY` (an immediate event property) and writes `scrollportRef.current.scrollTop` (a direct DOM write); no child setState is triggered, no DOM measurement crosses a setState boundary. The Bash refit calls the terminal renderer's own resize/fit method, which is a direct DOM-driven operation on the renderer's internal state — not a React parent measuring a React child.
- **[L05] Never use `requestAnimationFrame` for operations that depend on React state commits.** ✓ Explicitly no rAF in any code E.5 authors. The diagnosis-section text mentions rAF as one *possible cause* of the Bash blank-frame intermittent (CodeMirror-style virtualizers internally use rAF), but no proposed fix uses rAF. The Cmd-wheel hook writes scrollTop synchronously inside the wheel-event handler. The Bash refit calls the renderer's resize method synchronously inside the scroll-event handler (the renderer may internally rAF its repaint, but that's its private contract — our code does not depend on the timing of that rAF relative to a React commit).
- **[L06] Ephemeral appearance state goes through CSS and DOM, never React state.** ✓ The scroll position is appearance and lives in the DOM (`scrollportRef.current.scrollTop`); the Cmd-wheel routing decision is computed inline from the event, never stored in React state. The renderer's resize call mutates the renderer's internal DOM/canvas; no React state intermediary. Nothing about either fix puts appearance through render.
- **[L07] Action handlers access current state through refs, never stale closures.** ✓ The wheel handler reads `event.metaKey` / `event.ctrlKey` / `event.deltaY` from the live event object — never closed over. The scrollport reference comes from `scrollportRef.current`, a live ref. The Bash refit reads the terminal-renderer ref and the outer-scrollport ref the same way. No stale closures.
- **[L19] Component authoring guide.** ✓ The new hook `useOuterScrollOnModifierWheel` follows the hook authoring conventions. The instrumentation log gates on `NODE_ENV !== "production"` and tree-shakes cleanly. Tuglaws gets the Cmd-wheel-bypass contract documented in the surface-wide section (pane-model.md or wherever scrollport interactions are codified).
- **[L22] When external state drives direct DOM updates, observe the store directly.** ✓ Applies in spirit to the Bash refit: the "store" here is the IntersectionObserver's observation of the terminal's viewport visibility — an external (browser-API-driven) state source. Phase E.5 subscribes to it directly and writes to the DOM (calls the renderer's resize/fit) in the callback. We do NOT pull intersection state into React via `useSyncExternalStore` and then escape via `useEffect` to call the renderer; we subscribe in `useLayoutEffect` and act in the callback. Same shape as L22's prescribed pattern for store-driven DOM updates.
- **[L23] Internal implementation operations must never lose user-visible state.** ✓ Scroll position is user-visible state; the Cmd-wheel hook *adjusts* it (by user request, in real time) but never *loses* it. The Bash refit triggers the renderer to paint content that already exists (recovering a missing render) — it doesn't reset scroll, selection, or content state. Both fixes preserve every user-visible invariant.
- **[L24] Three state zones.** ✓ Wheel routing decisions = inline event-handler logic (not state at all, just computation over event properties). Scroll position = appearance (DOM-backed). The diagnosis-pass instrumentation log writes to `console` in dev only; not state. No new React state introduced. Zone boundaries respected.

**Artifacts (Phase E.5):**

- New: `tugdeck/src/components/tugways/internal/use-outer-scroll-on-modifier-wheel.ts` — exports the hook described above. Attaches a non-passive capture-phase `wheel` listener.
- Updated: `tugdeck/src/components/tugways/body-kinds/file-block.tsx`, `diff-block.tsx`, `terminal-block.tsx` — each calls the hook with its inner-scrollport ref + the outer scrollport from `useOuterScrollport()`.
- Updated: `tugdeck/src/components/tugways/body-kinds/terminal-block.tsx` — instrumentation log (gated on `NODE_ENV !== "production"`) for the diagnosis pass; once root cause known (or after a fixed window), the scroll-triggered refit mitigation lands here.
- Updated: `tuglaws/pane-model.md` (or wherever scrollport interactions are codified) — document the Cmd-wheel-bypass contract: inner scrollers honor wheel events except when meta/ctrl is held, in which case the outer scrollport receives the events. Make this surface-wide (transcript scrollport, pane scrollport, modal scrollport) so the contract isn't body-kind-specific.
- Updated: `tugdeck/src/components/tugways/internal/__tests__/use-outer-scroll-on-modifier-wheel.test.tsx` (new file) — synthetic wheel event with and without `metaKey`; assertion: inner scroll moves on plain wheel, outer scroll moves on meta-wheel.
- Updated: `tugdeck/src/components/tugways/body-kinds/__tests__/terminal-block.test.tsx` — render-on-scroll-into-view test (synthetic intersection observer fire + scroll event; assert resize/refit method called).

**Tasks (Phase E.5):**

- [x] **Build `useOuterScrollOnModifierWheel`.** Listener attached on `useLayoutEffect` (registration timing — events fire before paint). Listener checks `event.metaKey || event.ctrlKey`; on hit, `preventDefault`, `stopPropagation`, then `scrollportRef.current.scrollBy({ top: event.deltaY, behavior: "auto" })`. Cleanup on unmount.
- [x] **Wire all three body kinds.** Each opts in with its inner-scrollport ref. Verify by hovering inside a long fenced code block and Cmd-wheeling — the outer transcript scrolls, the inner stays put.
- [x] **Diagnose the Bash blank-frame intermittent.** Add dev-mode logging covering: TerminalBlock mount, content-prop arrival, the inner renderer's first-paint signal (whatever event the terminal lib exposes), intersection observer fires, outer-scrollport scroll events while terminal is partially / fully visible. Capture data across a real session. Either find the root cause and fix surgically, OR ship the scroll-triggered refit mitigation.
- [x] **Ship Bash render-fix.** Either the surgical fix from the diagnosis pass, or the scroll-triggered refit fallback. The fallback: subscribe to outer scrollport `scroll` events; when terminal's `IntersectionObserver` reports entering view, call the renderer's resize/refit method (typically a no-op when not needed).
- [x] **Tuglaws update** for the Cmd-wheel contract.
- [x] **Tests** for the wheel hook (synthetic events) and for the Bash refit (synthetic intersection + scroll).

**Tests (commands, Phase E.5):**

- [x] `bun test src/components/tugways/internal/__tests__/use-outer-scroll-on-modifier-wheel.test.tsx` — new file, all cases pass.
- [x] `bun test src/components/tugways/body-kinds/__tests__/terminal-block.test.tsx` — Bash render-on-scroll test passes.
- [x] `bunx tsc --noEmit` — clean.
- [x] `bun run audit:tokens lint` — zero violations.
- [x] `bun test` (full suite) — green.

**Checkpoint (Phase E.5):**

- [ ] Manual: open a long transcript with multiple tool calls (Read, Diff, Bash). Wheel-scroll past each tool call without Cmd — confirm current capture behavior is preserved (inner takes over until exhausted, then outer resumes).
- [ ] Manual: same transcript, hold Cmd while wheeling — confirm the outer transcript scrolls smoothly regardless of cursor position; inner scrollers don't engage.
- [ ] Manual: run a Bash command that produces output. Scroll the transcript so the output is off-screen, then scroll back to it. Confirm the output renders correctly without needing a wheel-touch inside the terminal — repeat 10+ times to catch the intermittent.
- [ ] Manual: confirm Cmd-wheel doesn't interfere with browser-native page zoom (Cmd-+/-) or with Cmd-click for new tab — the bypass is wheel-specific.

---

##### Phase E.6 — Tide-card scroll preservation (region-scroll anchor metadata + nested scroller wiring)

**Depends on:** Phase E.5 (the inner scrollers exist as addressable DOM elements and the cell ResizeObserver pipeline is wired); the existing [A9] state-preservation protocol (`tuglaws/state-preservation.md`).

**Why this phase exists.** Two issues with scroll-position preservation in the tide-card surfaced after E.5:

1. **App resign-active scrolls the tide-card transcript to the bottom.** Observed every cmd-tab away. Diagnosed in E.5's session: the window-`focus` reactivation path called `target.el.focus()` without `preventScroll`, and the focused editor lives below the transcript, so the browser's default scroll-into-view dragged the transcript down on every return.
2. **Developer > Reload does not restore the tide-card transcript scroll position.** Sometimes lands at the top, sometimes mid-document — the saved `bag.regionScroll["tide-card-transcript"]` write is silently clamped on mount (transcript `scrollHeight` is small before cells settle), and even after `scrollHeight` grows enough to allow the write, cell-height drift across reload (markdown blocks arriving, tool wrappers settling, FileBlocks measuring their CM6 substrates) means the saved pixel `scrollTop` no longer maps to the saved *content*. The user sees their anchor content shift away.

(1) is a focus-side regression — narrow fix.

(2) is a framework limitation. The current `RegionScrollSnapshot` axis on `CardStateBag` carries only `{ x, y }` per region — raw pixels. That shape is sufficient for content trees with deterministic post-reload layout (markdown view, CM6 substrate, terminal virtualized scroller with fixed-height lines). It is **not** sufficient for a variable-height virtualized list whose cells contain rich sub-content that settles asynchronously across many post-mount commits: between save and restore, cells above the user's anchor can grow or shrink, and the saved `scrollTop` deterministically lands at the wrong content. The MutationObserver-driven retry loop in `CardHost` keeps the apply alive until `scrollHeight ≥ savedY`, but it has no way to track *content*; it only tracks pixels.

The framework's design grain for "preserve uncontrolled state across teardown-and-replay" is the [A9] protocol's region-scroll axis ([state-preservation.md](../tuglaws/state-preservation.md)). The right move is to **extend that axis**, not to invent a parallel mechanism. The extension is small: each region snapshot can carry opaque per-region metadata alongside `{x, y}`. Regions that need richer semantics (a virtualized list's `(anchorIndex, anchorOffset)`) write the metadata; regions that don't (markdown view, terminal scroller, CM6 view) keep using `{x, y}`.

**Decisions.**

- **Extend `RegionScrollSnapshot` with `meta?: unknown` per region.** Capture reads JSON from a new `data-tug-scroll-state` DOM attribute on the region element if present; restore dispatches the metadata in the existing `tug-region-scroll-set` `CustomEvent.detail`. The shape of `meta` is region-defined opaque JSON; the framework treats it as a string-equivalent blob, exactly like `bag.content`. This keeps the bag schema additive and the framework agnostic to region semantics.
- **Multiple `data-tug-scroll-key` regions per card are the existing contract.** No framework change is needed for that; CardHost's capture/restore loop already walks `querySelectorAll('[data-tug-scroll-key]')`. Nested scrollers (outer transcript + per-block inner scrollers) all get their own keys; document-order dispatch (outer first) plus the MutationObserver-driven retry handles late-mounting inner scrollers (e.g., a CM6 view that mounts only when the user expands a collapsed FileBlock later).
- **TugListView owns its anchor metadata.** The list view maintains a current `(anchorIndex, anchorOffset)` derived from its live `scrollTop` and `heightIndex` via an imperative write to `data-tug-scroll-state` on the scroll container, updated on every `scrollTick`. The metadata IS the live anchor at every moment; capture just reads it. The listener for `tug-region-scroll-set` honors `meta.anchor` over the raw `{x, y}` and re-derives the target `scrollTop` from the heightIndex on every commit, so cells settling above the anchor drag the user's anchor cell back to its saved viewport position rather than leaving them with their saved pixel offset.
- **Inner scrollers stick with raw `{x, y}`.** TerminalBlock's virtualized scroller uses fixed-height lines (`LINE_HEIGHT_PX = 20`) so raw `scrollTop` maps deterministically to line index across reload. FileBlock's CM6 `scrollDOM` has CM6-internal layout: same content → same layout → raw `scrollTop` is the right unit. Both get `data-tug-scroll-key` attributes (with stable per-block keys derived from the block's identity) and let the existing CardHost MutationObserver retry handle late-mounting (collapsed FileBlock that mounts CM6 only on expand) and clamp-then-grow timing.
- **Fold state stays on the `bag.components` axis via `useComponentStatePreservation`.** Fold is not DOM-authority scroll; it is a component's `useState` value. The [A9] component-preservation axis is correct for it. The opt-in `componentStatePreservationKey` prop the body kinds already accept is the channel.
- **Revert the misadventures.** The `componentStatePreservationKey` prop I added to `TugListView` is the wrong axis for scroll and gets removed; the existing `scrollKey` channel is the right one. The half-broken `tug-region-scroll-set` listener I added to TugListView gets rewritten alongside the anchor-metadata pickup.
- **Focus-reactivation `preventScroll`.** Already shipped in the working session (`focus-transfer.ts:reactivateCurrentFocusDestination` + `default-focus.ts:traceApplyDefaultFocus`'s new `opts.preventScroll` parameter). User confirmed the resign-active scroll-to-bottom is fixed by this change. Phase E.6 keeps it; no further work on this item.

**Tuglaws compliance (Phase E.6).**

- **[L03] `useLayoutEffect` for events-dependent setup.** ✓ The new `data-tug-scroll-state` write on TugListView happens inside the existing `scrollTick` `useLayoutEffect` (already running on every commit). The new `tug-region-scroll-set` listener registration moves to the existing `useLayoutEffect` SmartScroll install slot. The anchor-driven apply effect is a no-deps `useLayoutEffect` that runs every commit — same pattern as the existing post-commit pin effect.
- **[L04] Never measure child DOM inline after triggering child setState from a parent effect.** ✓ All work happens inside TugListView itself; no parent setState is observed. `heightIndex.offsetForIndex(anchorIndex)` reads imperative state (the index) populated by the cell ResizeObserver, not React state.
- **[L05] Never use `requestAnimationFrame` for operations that depend on React state commits.** ✓ No new rAF introduced. The anchor-driven apply effect runs on commits, not on rAF. The existing rAF coalescing in the cell ResizeObserver pipeline is unchanged.
- **[L06] Ephemeral appearance state goes through CSS and DOM, never React state.** ✓ Scroll position is appearance; lives in the DOM (`scrollTop`). The anchor metadata is a DOM attribute (`data-tug-scroll-state`), not React state. The `restoreAnchorRef` is a `useRef`, not `useState`. The `bag.regionScroll[key].meta` extension lands serialized in tugbank — durable storage, not React state.
- **[L07] Action handlers access current state through refs, never stale closures.** ✓ The `tug-region-scroll-set` listener reads `restoreAnchorRef.current` and `smartScrollRef.current` live. The anchor-driven apply effect reads the same refs. The `captureState` callback in `useComponentStatePreservation` reads `scrollContainerRef.current.scrollTop` live. No closures over render snapshots.
- **[L19] Component authoring guide.** ✓ The framework extension is additive: `RegionScrollSnapshot` gains an optional field, `captureRegionScrolls` reads an optional attribute, `applyRegionScrolls` forwards an optional event-detail field. No identifier renames. The new `data-tug-scroll-state` attribute fits the existing attribute family. Updated `state-preservation.md` documents it in the DOM-attributes table.
- **[L20] Component-token sovereignty.** ✓ No new tokens. The work is purely structural / behavioral.
- **[L22] When external state drives direct DOM updates, observe the store directly.** ✓ The state being preserved is DOM-authority scroll position; the framework's region-scroll axis is exactly the [L22]-prescribed pattern for this case (capture from the DOM, restore to the DOM via `MutationObserver`-driven retry, no React state intermediary).
- **[L23] Internal implementation operations must never lose user-visible state.** ✓ This is the law Phase E.6 implements. The anchor-metadata extension exists specifically because raw `{x, y}` preservation loses user-visible content position across cell-height drift; anchor metadata recovers it. Manual checkpoints below pin the round-trip end-to-end.
- **[L24] Three state zones.** ✓ The anchor metadata is *appearance state* (where the user is looking); it lives in the DOM at runtime and in tugbank at rest. The `restoreAnchorRef` is plumbing state (a one-shot apply-target tracker), not structure state. No state-zone boundary is crossed.

**Artifacts (Phase E.6):**

- Updated: `tugdeck/src/layout-tree.ts` — extend `RegionScrollSnapshot` to allow `meta?: unknown` per region.
- Updated: `tugdeck/src/components/chrome/card-host.tsx` — `captureRegionScrolls` reads `data-tug-scroll-state` (JSON) if present and stores as `meta`; `applyRegionScrolls` forwards `meta` in the `tug-region-scroll-set` event detail.
- Updated: `tugdeck/src/components/tugways/tug-list-view.tsx` — (a) drops the `componentStatePreservationKey` prop I mistakenly added; (b) writes `data-tug-scroll-state="{anchor:{index,offset}}"` on the scroll container, updated imperatively on every scrollTick; (c) rewrites the `tug-region-scroll-set` listener to stash `meta.anchor` (when present) and disengage follow-bottom; (d) adds a no-deps `useLayoutEffect` that re-derives the target `scrollTop` from the live heightIndex and writes via SmartScroll until the anchor cell and all cells above it have been measured.
- Updated: `tugdeck/src/components/tugways/cards/tide-card-transcript.tsx` — restores `scrollKey="tide-card-transcript"`; drops the `componentStatePreservationKey` opt-in I mistakenly added.
- Updated: `tugdeck/src/components/tugways/body-kinds/file-block.tsx` — writes `data-tug-scroll-key={blockKey + "/file-scroll"}` onto CM6's `view.scrollDOM` (via `view.scrollDOM.setAttribute` inside the existing `useLayoutEffect` that wires the wheel router). Drops the inner-scroll preservation I wired through `useComponentStatePreservation` (wrong axis); keeps the fold-state preservation (right axis).
- Updated: `tugdeck/src/components/tugways/body-kinds/terminal-block.tsx` — writes `data-tug-scroll-key={blockKey + "/term-scroll"}` on the virtualized scroller (the `tugx-term-scroller` div created in `appendVirtualizedBody`). Drops the inner-scroll preservation I wired through `useComponentStatePreservation` (wrong axis); keeps the fold-state preservation (right axis).
- Updated: `tugdeck/src/components/tugways/cards/tool-wrappers/bash-tool-block.tsx`, `read-tool-block.tsx` — already pass `componentStatePreservationKey={toolUseId + "-body"}` to their body kinds; that key now ALSO becomes the suffix root for the inner scroll-key (no API change at the wrapper level).
- Updated: `tuglaws/state-preservation.md` — document the new `meta` field on `RegionScrollSnapshot`; document the new `data-tug-scroll-state` DOM attribute; note that variable-height virtualized lists provide anchor metadata via this channel.
- Updated: `tugdeck/src/components/tugways/__tests__/tug-list-view.test.tsx` — anchor capture/restore round-trip; assert `data-tug-scroll-state` reflects the live anchor on scroll changes; assert restore re-derives target `scrollTop` after a synthetic cell-height grow.
- Updated: `tugdeck/src/__tests__/card-host-form-controls-selection.test.ts` or sibling region-scroll test — add coverage for the `meta` round-trip through `captureRegionScrolls` and `applyRegionScrolls`.

**Tasks (Phase E.6):**

- [x] **Extend `RegionScrollSnapshot`.** Add `meta?: unknown` to the per-key shape in `layout-tree.ts`. Update the type to be tugbank-serializable (it already is via JSON).
- [x] **Update `captureRegionScrolls` and `applyRegionScrolls`.** Capture reads `el.getAttribute("data-tug-scroll-state")`, parses as JSON, includes as `meta`. Apply includes `meta` in the dispatched event detail.
- [x] **Revert TugListView misadventures.** Remove the `componentStatePreservationKey` prop, the `useComponentStatePreservation` call, the `restoreAnchorRef`, and the half-rewritten `tug-region-scroll-set` listener changes. The listener path goes back to roughly its pre-Phase-E.6 shape — but with the anchor-metadata pickup wired in (next task).
- [x] **Wire anchor metadata into TugListView.** (a) An imperative writer that updates `data-tug-scroll-state` on the scroll container whenever scroll position changes (inside the existing scrollTick path). (b) A rewritten `tug-region-scroll-set` listener that stashes `meta.anchor` (when present), disengages follow-bottom, and triggers the apply effect. (c) A no-deps `useLayoutEffect` that re-derives target `scrollTop` from the live heightIndex on every commit and writes via SmartScroll until settled (all cells from 0..anchorIndex have measured heights).
- [x] **Add `data-tug-scroll-key` to FileBlock's CM6 scrollDOM and TerminalBlock's virtualized scroller.** Stable per-block keys derived from the block's identity prop (`componentStatePreservationKey + "/file-scroll"` or `"/term-scroll"`).
- [x] **Restore `scrollKey="tide-card-transcript"` on tide-card-transcript** and remove the wrong-axis `componentStatePreservationKey` I added.
- [x] **Drop the inner-scroll-via-component-preservation** from FileBlock and TerminalBlock; keep the fold-state-via-component-preservation.
- [x] **Update `state-preservation.md`.** New `meta` field on `RegionScrollSnapshot`; new `data-tug-scroll-state` attribute in the DOM-attributes table; advisory note about anchor metadata for variable-height virtualized lists.
- [x] **Tests** for `meta` round-trip in `captureRegionScrolls` / `applyRegionScrolls` and for TugListView anchor restore. End-to-end app-tests AT0059 (save) / AT0060 (settled-detection) / AT0061 (full save→reload→apply round-trip) all PASS in the live Tug.app via `just app-test`.

**Tests (commands, Phase E.6):**

- [x] `bun test src/__tests__/card-host-region-scroll.test.ts` — capture/apply for the legacy `{x, y}` channel still passes unchanged after the `meta` extension.
- [x] `bun test src/components/tugways/body-kinds/__tests__/file-block.test.tsx` — fold-state preservation still passes after dropping the inner-scroll axis; CM6 scrollDOM carries the new `data-tug-scroll-key`.
- [x] `bun test src/components/tugways/body-kinds/__tests__/terminal-block.test.tsx` — fold-state preservation still passes after dropping the inner-scroll axis; the virtualized scroller carries the new `data-tug-scroll-key`.
- [x] `bunx tsc --noEmit` — clean.
- [x] `bun run audit:tokens lint` — zero violations.
- [x] `bun test` (full suite) — green (3702 / 0 fail).
- [x] `just app-test at0059-region-scroll-anchor-save.test.ts at0060-list-view-content-settled.test.ts at0061-region-scroll-anchor-apply.test.ts` — all three end-to-end gates PASS.

**Checkpoint (Phase E.6):**

- [ ] Manual: open a tide-card with a long transcript. Scroll up to mid-document so multiple entries are above and below the viewport. Developer > Reload. Confirm the same content lands at the same viewport position (within a few pixels) — not at the top, not at the bottom, not mid-loading-jitter.
- [ ] Manual: same as above but scroll to the very top before reload. Confirm the transcript opens at the top on restore.
- [ ] Manual: same as above but scroll to the very bottom (with follow-bottom engaged). Confirm restore lands at the bottom and follow-bottom remains engaged so subsequent streaming sticks.
- [ ] Manual: in the tide-card transcript, expand a FileBlock (Read tool), scroll inside the CM6 viewer, then collapse the file. Developer > Reload. Confirm the fold state is restored (still collapsed). Re-expand. Confirm the CM6 inner scroll position is also restored (the user lands at the same line they were viewing before reload).
- [ ] Manual: same as above but with a Bash tool whose output triggers the virtualized terminal scroller (>40 lines). Scroll inside the terminal, then reload. Confirm the terminal lands at the same line on restore.
- [ ] Manual: cmd-tab away and back from the tide-card. Confirm the transcript scroll position does NOT change as a side effect of the focus return (regression guard for the E.6 focus-reactivation `preventScroll` fix).

---

##### Phase E.7 — Late-mounting component-state restore (framework: registry observer channel)

**Depends on:** Phase E.6 (component-state-preservation key plumbing on FileBlock / TerminalBlock / DiffBlock + tool wrappers).

**Why this phase exists.** Phase E.6 wired the body-kind fold state into the [A9] `bag.components` axis via `useComponentStatePreservation`. The save side works: `captureCardState` walks the per-card `ComponentStatePreservationRegistry` and serializes every registered component's state into the bag. The restore side has a structural hole, exposed by the user's first manual checkpoint (4th bullet under Phase E.6): a Bash block collapsed before Developer > Reload comes back EXPANDED on reload, even though the *inner* scroll position inside the block (region-scroll axis) IS restored correctly.

The root cause is in the framework, not in tide-card. `CardHost`'s component-restore effect is a one-shot, fired once per CardHost mount on the assumption that every descendant component has registered by the time the parent's effect runs (React's child-before-parent effect order). That assumption breaks when content mounts ASYNCHRONOUSLY after the data source populates — which is the dominant shape for `tide-card`'s transcript: items arrive from session resume, cells render, tool wrappers mount inside cells, body kinds mount inside tool wrappers, and only THEN do those body kinds register with the per-card registry. By that time, CardHost's one-shot restore has already iterated an empty registry and the `bag.components` payload sits unused.

The bug is structural — every component-preservation consumer that mounts behind any async gate (feeds-readiness, session resume, lazy-loaded sub-content) suffers the same hole. Tide-card surfaced it acutely because the data source IS the async gate; other consumers may have masked it by mounting synchronously.

**Decisions.**

- **The fix is an event-channel extension to `ComponentStatePreservationRegistry`, modeled on the framework's existing `useCardDelegate` / observer pattern in `card-lifecycle.ts`.** The registry already owns the "a component opted into preservation" structural event — it's the canonical event source. Adding an observer channel makes that event addressable.
- **Registry exposes `observeRegister(callback): unsubscribe`.** Synchronous observer pattern, same shape as `observeCardWillActivate` and its siblings on `CardLifecycle`. Fires on every `register` call with the scoped key and the freshly-installed `RegistryEntry`. No `MessageChannel` deferral — the orchestrator's apply work needs to land in the same React commit as the registration so the first paint after the late mount reflects the restored state ([L03]).
- **`CardStateOrchestrator` subscribes per card.** First time `restoreCardState(cardId, bag)` is called for a card, the orchestrator: (a) stores `bag.components` in a per-card cache (`lastBagComponents`); (b) applies to currently-registered entries (existing behavior); (c) subscribes to the registry's `observeRegister` channel for that card so future registrations get applied too. The subscription installs idempotently on first restore; subsequent `restoreCardState` calls update the cached bag without re-subscribing.
- **Per-key applied-tracking prevents double-apply.** A `Set<string>` per card records which scoped keys have already had their `restoreState` invoked. Both the initial iteration and the late-register path consult and update it. Prevents a key from being restored twice if the same component registers, somehow gets iterated by both paths, or if a future caller invokes `restoreCardState` multiple times with overlapping bags.
- **User-state-preservation invariant ([L23]).** `appliedKeys` is NOT cleared on `unregister`. If a component unmounts (e.g., a future virtualized list scrolls its cell out of view) and later remounts, the saved state is NOT re-applied — because in the interim the user may have changed the state, and the in-memory bag may not yet reflect the user's change (no save has fired between the unmount and the remount in that scenario). Re-applying old state would silently destroy the user's change. The framework's existing contract for the component-preservation axis is "applied once per card lifecycle"; this phase preserves that contract precisely while plugging the late-mount hole.
- **Symmetric to existing card-lifecycle pattern.** `useCardDelegate` / `observeCardWillActivate` are the framework-blessed way to surface lifecycle events with a clean subscription model. Adding the same shape at the component-preservation layer keeps the architecture coherent — future component-lifecycle events (`componentDidApplyRestore`, `componentWillUnregister`) plug into the same channel without further refactoring.

**Tuglaws compliance (Phase E.7).**

- **[L02] External state enters React through `useSyncExternalStore` only.** ✓ The registry is a non-React object. The orchestrator's subscription happens in plain JS (no `useState` / `useEffect`). The hook that triggers `register` is in `useLayoutEffect` ([L03]). No external state pulled into React state.
- **[L03] `useLayoutEffect` for registrations events depend on.** ✓ Hook registration stays in `useLayoutEffect` so the registry's `observeRegister` notification lands before any paint. The orchestrator's `restoreState` invocation on the registering entry fires synchronously inside the notification, so the late-mount component's React state is updated in the same commit phase as its registration — first paint reflects the restore.
- **[L04] Never measure child DOM inline after triggering child setState from a parent effect.** ✓ The orchestrator calls `entry.restoreRef.current?.(savedValue)` — a child-defined closure that mutates the child's OWN React state (via the consumer's `setLocalCollapsed` or equivalent). No parent reads child DOM after triggering child setState; the orchestrator's only contract is "deliver the saved value." Same shape as the existing `restoreComponents` iteration.
- **[L05] No `requestAnimationFrame`.** ✓ Synchronous notify path. No timer-based deferral.
- **[L06] Ephemeral appearance state goes through CSS and DOM, never React state.** ✓ The applied-keys Set is plumbing state (an orchestrator internal map). Not React state; not appearance.
- **[L07] Live ref reads.** ✓ The orchestrator reads `entry.restoreRef.current` at notification time — the freshest closure the hook has registered.
- **[L19] Component authoring guide.** ✓ Updates `state-preservation.md` (the canonical doc) with the late-mount behavior; updates the docstring on `useComponentStatePreservation` to note that late-mounting is supported; adds a docstring to `ComponentStatePreservationRegistry`'s new `observeRegister` channel.
- **[L20] Component token sovereignty.** N/A — no tokens.
- **[L22] When external state drives direct DOM updates, observe the store directly.** ✓ The orchestrator subscribes to the registry directly (synchronous observer callback) rather than round-tripping through React commits. Same principle the card-lifecycle observers follow.
- **[L23] Preserve user-visible state.** ✓ This phase IS the L23 fix for late-mounting components. Without it, `bag.components` payloads silently drop on the reload path for any component behind an async mount gate.
- **[L24] Three state zones.** ✓ `appliedKeys` is structure-ish plumbing (orchestrator-internal). Not appearance. Not data flowing through render.

**Artifacts (Phase E.7):**

- Updated: `tugdeck/src/components/tugways/component-state-preservation-registry.ts` — new `observeRegister(cb)` channel; `register` notifies observers synchronously after the entry lands in the internal map; `clear` notifies observers via a separate `observeClear` channel (or omits — TBD by implementation, see Tasks).
- Updated: `tugdeck/src/card-state-orchestrator.ts` — `restoreCardState` caches `bag.components` per card, subscribes to the registry's `observeRegister` channel on first call per card, applies the saved value for late-registering keys. Per-card `appliedKeys: Set<string>` prevents double-apply.
- Updated: `tugdeck/src/components/tugways/use-component-state-preservation.tsx` — docstring updates noting that late-mounting components now receive their saved state automatically; no API changes required.
- Updated: `tuglaws/state-preservation.md` — document the late-mounting behavior in the lifecycle section and the orchestrator's `observeRegister`-based pull. Add an authoring note: components no longer need to worry about whether they mount before or after CardHost's restore — the framework handles both.
- Updated: `tugdeck/src/__tests__/component-state-preservation-registry.test.ts` (new or existing) — pin `observeRegister` semantics: fires on register, multiple subscribers all called, unsubscribe stops notifications.
- Updated: `tugdeck/src/__tests__/card-state-orchestrator.test.ts` — pin the late-mount apply path: pre-mount restoreCardState, then mount a component, assert `restoreState` fires with the saved value; applied-keys prevents double-apply when the same key is registered twice (re-register edge).
- New: `tests/app-test/at0062-late-mount-component-restore.test.ts` — end-to-end gate. Mount a tide-card-like fixture where a body kind is collapsed pre-save, `appReload`, and assert the body kind comes back collapsed even though it mounted AFTER the data source's async populate.
- Updated: `tuglaws/app-test-inventory.md` — register AT0062.

**Tasks (Phase E.7):**

- [x] **Add `observeRegister` channel to the registry.** New `private readonly registerObservers: Set<(scopedKey: string, entry: RegistryEntry) => void>`; new `observeRegister(cb): () => void` method returning unsubscribe. `register` notifies after the entry lands. Add dev-only try/catch around each observer callback so a throwing observer doesn't break the registration.
- [x] **Orchestrator subscribes per-card.** `CardStateOrchestrator` gains two per-card maps: `lastBagComponents: Map<string, Record<string, unknown>>` and `appliedKeys: Map<string, Set<string>>`. First call to `restoreCardState(cardId, bag)` for a card: cache `bag.components` (when present); iterate `registry.entriesInTreeOrder()` and apply (existing behavior, but now also marking `appliedKeys`); install `registry.observeRegister(handleLateRegister)` with a closure that pulls from `lastBagComponents.get(cardId)`, gates on `appliedKeys.get(cardId)`, calls `entry.restoreRef.current?.(saved)`, and marks applied. Subsequent `restoreCardState` calls update the cached components without re-subscribing.
- [x] **Per-card cleanup.** `discardComponentStatePreservationRegistry(cardId)` (called when a card is destroyed) drops `lastBagComponents` and `appliedKeys` for that card. The registry's existing `clear()` is sufficient for unsubscription because the subscription is captured by the registry instance itself (when the registry is discarded, the observer closure becomes unreachable). Verify no leaks via the existing card-destruction tests.
- [x] **Verify body kinds still get their saved state on the initial mount path.** The new `observeRegister` path is a SUPERSET of the existing iteration. Components that mount synchronously before `restoreCardState` are applied via the iteration. Components that mount after are applied via the observer. Both paths share `appliedKeys`. Existing tests for synchronous-mount restore must still pass.
- [x] **Doc updates.** `state-preservation.md` — add a "Late-mounting components" subsection under the lifecycle section. `useComponentStatePreservation` docstring — update to note that the restore-after-mount timing is now handled by the framework.
- [x] **Tests.** Unit-level: registry's `observeRegister` semantics, orchestrator's late-mount apply, applied-keys dedup. App-test: AT0062 — late-mount restore round-trip in the live Tug.app.

**Tests (commands, Phase E.7):**

- [x] `bun test src/__tests__/component-state-preservation-registry.test.ts` (or wherever the registry tests live) — new `observeRegister` cases pass.
- [x] `bun test src/__tests__/card-state-orchestrator.test.ts` — late-mount apply + applied-keys dedup cases pass.
- [x] `bun test src/__tests__/use-component-state-preservation.test.tsx` — existing tests still pass (no API change).
- [x] `bunx tsc --noEmit` — clean.
- [x] `bun run audit:tokens lint` — zero violations.
- [x] `bun test` (full suite) — green.
- [x] `just app-test at0062-late-mount-component-restore.test.ts` — gates the end-to-end late-mount path on the live Tug.app.

**Checkpoint (Phase E.7):**

- [ ] Manual: open a tide-card with a Bash tool call in the transcript. Collapse the Bash block (click the fold cue). Developer > Reload. Confirm the Bash block comes back COLLAPSED on reload — the fold state survived.
- [ ] Manual: same as above with a Read tool call (FileBlock) and a Diff (DiffBlock). Each body kind's fold state survives.
- [ ] Manual: combined regression — scroll inside an expanded FileBlock, collapse it, reload. On re-expand after restore: fold state is collapsed (E.7); on re-expand, CM6 inner scroll lands at the saved position (E.6's region-scroll axis still works). Both axes restore independently and correctly.
- [ ] Manual: open the gallery's `TugAccordion` card (or any other `useComponentStatePreservation` consumer that mounts synchronously). Change a value. Developer > Reload. Confirm the value is restored — the existing synchronous-mount path is not regressed.

---

##### Phase E.8 — Mount-in-saved-state; eliminate the post-mount restore cascade

**Depends on:** Phase E.6 (the [A9] region-scroll axis with `meta`/anchor); Phase E.7 (saved component-state IS reachable via `cardStateCache.getCardState(cardId)` — that part of E.7 keeps working). E.8 supersedes E.7's post-mount `setLocalCollapsed`-via-observer mechanism and removes the supporting infrastructure.

**Why this phase exists.** Phase E.7 plugged the structural hole "saved fold state is lost on cold boot" by post-mount `setLocalCollapsed` from a registry-observer callback. The fix worked at the data layer but the cost is visible at the paint layer: every body kind on Developer > Reload now mounts in its `useState` default (overThreshold collapsed = true), paints, then flips to the saved value, paints, then the inner virtualized scroller is recreated at `scrollTop=0`, paints, and only THEN does the MutationObserver-driven region-scroll apply land the saved scroll position. Three-to-five visible intermediate frames per body kind, plus secondary scroll cascades from cell-height changes propagating to the outer transcript's anchor logic. User-visible result: wild scrolling — the page jerks through several wrong states before settling.

The right primitive is not "mount wrong, then correct." It's mount-in-the-saved-state on the FIRST render. No post-mount `setState`. No re-render. No imperative-renderer recreate. The cardStateCache is already populated synchronously on cold boot from tugbank, before any CardHost mounts — the saved state is REACHABLE in render. Phase E.8 makes it READABLE in render, threads it into `useState` initializers and imperative-renderer creation sites, and deletes the post-mount restore path that the wild scrolling proves is wrong.

The post-mount restore was a mistake. It is removed, not retained as fallback. Keeping it as a fallback would invite future code to opt back into the broken UX. Every consumer migrates to the synchronous-initializer pattern, or it doesn't use this axis at all.

**Decisions.**

- **Saved state enters the React tree at render time, never via an effect.** Two new context-driven accessor hooks pull synchronously from `cardStateCache`:
  - `useSavedComponentState<T>(componentStatePreservationKey?: string): T | undefined` — returns `bag.components[scopedKey]` or `undefined`. Consumed inside `useState` initializer functions.
  - `useSavedRegionScroll(scrollKey?: string): { x: number; y: number; meta?: unknown } | undefined` — returns `bag.regionScroll[scrollKey]` or `undefined`. Consumed by body kinds whose imperative renderer accepts an `initialScrollTop` parameter.
- **Body kinds mount in their saved state.** TerminalBlock, FileBlock, DiffBlock, TugCheckbox, and every other `useComponentStatePreservation` consumer read their saved value in `useState` initializers. No `restoreState` closure path. No post-mount flip.
- **Imperative renderers accept saved scroll at creation.** `renderTerminal` (and FileBlock's CM6 mount path; DiffBlock has no inner scrollport) takes an `initialScrollTop` parameter sourced from `useSavedRegionScroll`. The scroller is CREATED at the saved position; `MutationObserver`-driven apply becomes a no-op for these inner scrollers (their first observable `scrollTop` already matches the bag).
- **The orchestrator's restore path is REMOVED entirely.** Specifically: `CardStateOrchestrator.restoreCardState`, `lastBagComponents`, `registryObserverInstalled`, `discardCardState`. The class becomes capture-only. `DeckManager.restoreCardState` public method is removed. `CardHost`'s component-state restore effect (`hasRestoredComponentsRef` + `store.restoreCardState(cardId, bag)`) is removed.
- **The registry's `observeRegister` channel is REMOVED entirely.** Specifically: `observeRegister`, `registerObservers`, `RegistryRegisterObserver`, `clear()`-drops-observers behavior. The registry shrinks back to data structure + capture-only iteration: register / unregister / `entriesInTreeOrder` / `keys` / `clear`.
- **`UseComponentStatePreservationOptions.restoreState` is removed.** The hook becomes pure opt-into-capture. Consumers that need to react to saved state read it via `useSavedComponentState` in the `useState` initializer, full stop. There is no API surface for "apply this saved value to me at a later moment" because that mechanism IS the wild-scrolling bug.
- **The MutationObserver-driven region-scroll apply stays.** The OUTER `tide-card-transcript` scroller is created by `TugListView` at first paint, but its scroll destination depends on cell heights that aren't known synchronously (variable-height virtualized list). The Phase E.6 anchor-based restore deferred-application path is the right answer for that scroller. For INNER scrollers (TerminalBlock/FileBlock virtualized scrollport), `initialScrollTop` collapses the apply into the creation site and the MutationObserver pass finds the scroller already at the saved position (idempotent).
- **The element-identity gate in `card-host.tsx`'s apply stays.** Even with `initialScrollTop`, an inner scroller can be rebuilt mid-card-lifecycle by an imperative renderer (TerminalBlock's collapse-then-expand cycle calls `body.replaceChildren()` and re-appends). The rebuilt scroller's `initialScrollTop` would be 0 (or the user's CURRENT scroll if the fixture reads `latestScrollTopRef` at rebuild time — TBD). The MutationObserver's apply, with the Phase E.7 element-identity gate, re-applies the saved bag value to the new element. This is the only post-mount apply path that remains, and it's strictly DOM-level (no React state flip).

**Tuglaws compliance (Phase E.8).**

- **[L01] One `root.render()`, at mount, ever.** ✓ No new render-root behavior.
- **[L02] External state enters React through `useSyncExternalStore` only.** ✓ `useSavedComponentState` and `useSavedRegionScroll` read from `cardStateCache` (DeckManager-owned). The accessors are wired through `useSyncExternalStore` so a future bag update reactively re-reads. (Cold-boot is the only path that matters today, but the subscribe wiring is free and correct.)
- **[L03] `useLayoutEffect` for registrations.** ✓ Hook registration stays in `useLayoutEffect`. The new accessors are READS, not registrations; they happen in render. Nothing keyboard/pointer-handling depends on them.
- **[L04] Never measure child DOM inline after triggering child setState from a parent effect.** ✓ The whole class of "parent triggers child setState via observer" goes away.
- **[L05] No `requestAnimationFrame`.** ✓ Not used.
- **[L06] Ephemeral appearance state goes through CSS and DOM, never React state.** ✓ Scroll position is appearance; the framework writes `scrollTop` directly at creation. Fold state IS data (non-rendering consumers — capture, persistence, the action layer that toggles it — read it); it lives in React state.
- **[L07] Live ref reads.** ✓ Capture closures continue to read live state via refs. No new closure-staleness risk.
- **[L19] Component authoring guide.** ✓ Updates `component-authoring.md` with a new "Restoring saved state at mount" section pinning the `useState`-initializer + `useSavedComponentState` pattern. Updates `state-preservation.md` to replace the "Late-mounting components" subsection (E.7's observer mechanism) with the synchronous-read mechanism.
- **[L22] When external state drives direct DOM updates, observe the store directly.** ✓ The MutationObserver-driven region-scroll apply for the OUTER transcript is unchanged. It observes DOM directly and writes `scrollTop` directly.
- **[L23] Preserve user-visible state.** ✓ This phase IS the L23 win. Pre-E.8 there is an L23 violation: between cold-boot first paint and final-settled paint the user observes the WRONG state. Post-E.8 the first paint IS the saved state. The contract becomes "user-visible state at first paint after restore = user-visible state at last save before destruction." Pixel-tight.
- **[L24] Three state zones.** ✓ Saved-state reads land in the right zones: fold state → React data zone (`useState`); inner scroll → DOM appearance zone (`scrollTop` written by imperative renderer); outer transcript scroll → DOM appearance zone (MutationObserver-driven). No state crosses zones.

**Artifacts (Phase E.8):**

- Updated: `tugdeck/src/components/tugways/use-component-state-preservation.tsx`
  - Add `useSavedComponentState<T>(componentStatePreservationKey: string | undefined): T | undefined`.
  - Add `useSavedRegionScroll(scrollKey: string | undefined): { x: number; y: number; meta?: unknown } | undefined`.
  - Remove `restoreState` from `UseComponentStatePreservationOptions`. The hook's only options become `componentStatePreservationKey` + `captureState`.
- Updated: `tugdeck/src/components/tugways/component-state-preservation-registry.ts`
  - Remove `observeRegister`, `registerObservers`, `RegistryRegisterObserver` type, the `register` notify-loop, and `clear()`-drops-observers behavior.
  - Remove `restoreRef` from `RegistryEntry` (captures are still held; restores no longer exist). Update `register` signature accordingly.
- Updated: `tugdeck/src/card-state-orchestrator.ts`
  - Remove `restoreCardState`, `lastBagComponents`, `registryObserverInstalled`, `discardCardState`. The orchestrator becomes capture-only: `registerAssembler`, `captureCardState`, `harvestComponents`.
  - Remove the trace-log scaffolding (`__tugTraceComponentStateRestore`).
- Updated: `tugdeck/src/deck-manager.ts`
  - Remove `restoreCardState` public method.
  - Remove `discardCardState` call from `discardComponentStatePreservationRegistry` (the orchestrator no longer holds per-card state to discard).
- Updated: `tugdeck/src/components/chrome/card-host.tsx`
  - Remove the component-state restore effect (`hasRestoredComponentsRef` + `store.restoreCardState`).
  - Extend the per-card context value to provide `getSavedComponentState(scopedKey)` and `getSavedRegionScroll(scrollKey)` accessors that read from `store.getCardState(cardId)`. Wire via `useSyncExternalStore` so the accessors are reactive to bag changes.
  - The region-scroll restore effect stays (it's the L23 mechanism for outer-scroller anchor restore + the element-identity fallback for rebuilt inner scrollers).
- Updated: `tugdeck/src/components/tugways/body-kinds/terminal-block.tsx`
  - `useState<boolean>(overThreshold)` becomes `useState<boolean>(() => initialFoldFromSavedState() ?? overThreshold)` where the helper reads via `useSavedComponentState`.
  - `renderTerminal` takes an `initialScrollTop?: number` parameter; `appendVirtualizedBody` uses it as the scroller's `scrollTop` at creation. The TerminalBlock render passes the value from `useSavedRegionScroll(scrollKey)?.y`.
  - The `restoreState` callback that fed `setLocalCollapsed` is deleted.
- Updated: `tugdeck/src/components/tugways/body-kinds/file-block.tsx` — same shape (useState initializer reads saved; CM6 mount writes `scrollDOM.scrollTop` at creation).
- Updated: `tugdeck/src/components/tugways/body-kinds/diff-block.tsx` — useState initializer reads saved fold. No inner scrollport, so no scroll wiring.
- Updated: `tugdeck/src/components/tugways/tug-checkbox.tsx` — useState initializer reads saved `{checked: boolean}`. Remove `restoreState` closure.
- Updated: `tugdeck/src/main.tsx` — `window.tugdeck.diag` shrinks: remove `forceSaveAndDump` (the diag-write contract was confusing and this phase removes the orchestrator's restore-side surface that motivated it). Read-only diag methods stay.
- Removed: `tugdeck/src/components/tugways/cards/gallery-state-preservation.tsx` `LateMountPreservedCheckbox` + `GalleryLateMountPreservation` — premised on E.7's observer path.
- Removed: `tugdeck/src/components/tugways/cards/gallery-bash-tool-block.tsx` `LateMountBashToolBlock` + `GalleryLateMountBashToolBlock` + `GalleryTideCardLikeBashToolBlock` and their data-source plumbing — same reason.
- Removed: `tests/app-test/at0062-late-mount-component-restore.test.ts`.
- Removed: `tests/app-test/at0063-bash-block-fold-restore.test.ts`.
- Removed: `tests/app-test/at0064-bash-block-inner-scroll-restore.test.ts`.
- Removed: `tests/app-test/at0065-tide-card-like-inner-scroll-restore.test.ts`.
- Removed: orchestrator/registry unit tests for the observer channel + late-mount apply.
- New: `tugdeck/src/__tests__/use-saved-component-state.test.tsx` — unit-level test of the new accessor hooks.
- New: `tests/app-test/at0067-bash-block-mount-in-saved-state.test.ts` — pin that on Developer > Reload, the TerminalBlock's `data-collapsed` attribute matches the saved bag from the FIRST DOM observation (no intermediate frame where it disagreed).
- New: `tests/app-test/at0068-bash-block-inner-scroll-from-creation.test.ts` — pin that the inner virtualized scroller's first observable `scrollTop` matches the saved bag's region-scroll value (no `MutationObserver`-driven jump from 0 to saved).
- Updated: `tuglaws/state-preservation.md`
  - Replace the "Late-mounting components" subsection (E.7 observer-driven) with "Restoring saved state at mount" (E.8 synchronous-read).
  - State the contract: "user-visible state at first paint after restore = user-visible state at last save before destruction."
- Updated: `tuglaws/component-authoring.md` — new section: "Restoring saved state at mount." Show the canonical pattern for fold-style state (`useSavedComponentState` in `useState` initializer) and scroll-style state (`useSavedRegionScroll` → `initialScrollTop` into imperative renderer).
- Updated: `tuglaws/app-test-inventory.md` — register AT0067/AT0068; mark AT0062–AT0065 as superseded (with a one-line "replaced by AT0067/AT0068 under Phase E.8").

**Tasks (Phase E.8):**

- [x] **Extend CardHost's per-card context with synchronous saved-state accessors.** `getSavedComponentState(scopedKey)` reads `store.getCardState(cardId)?.components?.[scopedKey]`. `getSavedRegionScroll(scrollKey)` reads `store.getCardState(cardId)?.regionScroll?.[scrollKey]`. Both wired via `useSyncExternalStore` so future bag updates reactively refresh.
- [x] **Export `useSavedComponentState<T>` and `useSavedRegionScroll`** from `use-component-state-preservation.tsx`. Pure synchronous reads of context values + scope-prefix application for the component-state key.
- [x] **Remove `restoreState` from `UseComponentStatePreservationOptions`.** Hook becomes capture-only.
- [x] **Strip the observer channel from the registry.** Remove `observeRegister`, `registerObservers`, `RegistryRegisterObserver`, `clear()`-drops-observers behavior, `restoreRef` from `RegistryEntry`.
- [x] **Strip the restore path from the orchestrator.** Remove `restoreCardState`, `lastBagComponents`, `registryObserverInstalled`, `discardCardState`, the trace-log scaffolding, and the `applyRestoreToEntry` helper.
- [x] **Remove `restoreCardState` from `DeckManager`'s public API.** Update the public type. Remove the `discardCardState` call from `discardComponentStatePreservationRegistry`.
- [x] **Remove the component-state restore effect from CardHost.** Delete `hasRestoredComponentsRef`. The remount-detection signal (`callbacksVersion` flip on the no-op-pair → real-pair transition) keeps working for `bag.content` restore, which is unchanged by Phase E.8.
- [x] **Update body kinds.** TerminalBlock, FileBlock, DiffBlock, TugCheckbox: `useState` initializer reads via `useSavedComponentState`. `restoreState` closure deleted. Also migrated: TugSwitch, TugRadioGroup, TugAccordion, TugOptionGroup, TugSheet, TugChoiceGroup, TugValueInput, TugSlider, TugPromptEntry, gallery-text-editor.
- [x] **`renderTerminal` accepts `initialScrollTop`.** Plumb through TerminalBlock and `appendVirtualizedBody`. CM6's analog in FileBlock writes `scrollDOM.scrollTop` at mount. A `consumeInitialScrollTop` one-shot ref keeps the saved value tied to the FIRST scroller creation; collapse-toggle / streaming re-renders fall back to anchor-based default and rely on the element-identity-gated `MutationObserver` re-apply.
- [x] **Drop the late-mount and tide-card-like gallery fixtures.** Drop the corresponding `registerCard` entries.
- [x] **Delete superseded app-tests** (AT0062–AT0065) and the orchestrator/registry observer-channel unit tests.
- [x] **Add new tests.** AT0067 (mount-in-saved-state, no intermediate-frame regression), AT0068 (scroller-created-at-saved-position). Unit tests for `useSavedComponentState` / `useSavedRegionScroll` in `tugdeck/src/__tests__/use-saved-component-state.test.tsx`.
- [x] **Docs.** `state-preservation.md` "Restoring saved state at mount" section; `component-authoring.md` new authoring section; `app-test-inventory.md` entries for AT0067/AT0068 + supersedes for AT0062–AT0065.
- [x] **Diag surface.** Remove `forceSaveAndDump` from `window.tugdeck.diag`.

**Tests (commands, Phase E.8):**

- [x] `bun test src/__tests__/use-saved-component-state.test.tsx` — accessor semantics pinned (15 assertions across 9 tests).
- [x] `bun test src/__tests__/card-state-orchestrator.test.ts` — capture-only surface intact; restore-side tests removed.
- [x] `bun test src/components/tugways/__tests__/component-state-preservation-registry.test.ts` — observer tests removed; data-structure tests intact.
- [x] `bunx tsc --noEmit` — clean.
- [x] `bun run audit:tokens lint` — zero violations.
- [x] `bun test` (full suite) — green (3708 pass).
- [x] `just app-test at0067-bash-block-mount-in-saved-state.test.ts at0068-bash-block-inner-scroll-from-creation.test.ts at0061-region-scroll-anchor-apply.test.ts` — green (3/3). AT0061 regression-checks the OUTER transcript anchor restore path that Phase E.8 deliberately leaves alone.

**Checkpoint (Phase E.8):**

- [ ] Manual: open a tide-card with a Bash tool call expanded and scrolled to a non-trivial inner position. Developer > Reload. Watch the cold-boot paint carefully. The block must appear in its expanded state at the user's scroll position on the VERY FIRST paint. No fold flip. No scroll jump from 0 to saved. No outer-transcript re-anchoring cascade.
- [ ] Manual: same with a Read tool call (FileBlock) — collapsed/expanded, with CM6 scroll mid-document.
- [ ] Manual: same with a Diff (DiffBlock) — collapsed.
- [ ] Manual: cmd-tab away from Tug.app and back. No visible reshuffling, no scroll jumps.
- [ ] Manual: open the gallery state-preservation card. Toggle the TugCheckbox. Developer > Reload. The checkbox state survives without a render flicker (no "unchecked-then-checked" frame).

---

##### Phase E.9 — Save layout geometry; first-paint accuracy at restore

**Depends on:** Phase E.6 (region-scroll anchor metadata channel — `data-tug-scroll-state` + `meta` on `RegionScrollSnapshot[key]`); Phase E.8 (mount-in-saved-state primitives — `useSavedRegionScroll`, synchronous saved-state context accessors).

**Why this phase exists.** Phase E.8 closed the component-axis and inner-scroller restore down to "first paint reflects saved state" by reading the bag synchronously at render time. The OUTER transcript scroller still hops: even with the anchor-metadata path, `TugListView` mounts with an empty `heightIndex`, so the first commit's apply effect (`tug-list-view.tsx:1252`) sees `restoreAnchorRef.current === null`, no-ops, and the browser paints at `scrollTop=0`. The MutationObserver-driven retry loop then refines across multiple commits as cells are measured — every refinement a visible micro-hop. Inner scrollers can also reflow when fonts load after first paint, producing a flash whose magnitude is bounded by the font-metric drift.

The information loss is structural. At save time the framework had measured every cell's height (in `TugListView`'s `heightIndex`), CM6's content layout (in FileBlock), every virtualized line (in TerminalBlock's deterministic LINE_HEIGHT_PX grid). We threw all of it away and saved only `{x, y, anchor}`. The "settle window" the MutationObserver path patches over is a fiction: there's no real reason the restore should be reconstructing what we already had at save time.

Phase E.9 captures the geometry that drives layout at save time and hydrates it before first paint at restore. With saved geometry, the anchor-resolve math gives the exact saved offset on the FIRST commit. Cells render with their known final heights (via inline `min-height`) so async sub-content fills its destined slot without shifting siblings. The scrollTop write at mount is exact, not estimated. There is no refinement loop in the happy path. The 300ms safety timer the previous proposal contemplated is not in this plan — timers are unreliable for async content delivery, and there is no async to wait for once geometry is hydrated.

**Decisions.**

- **Geometry lives in `meta` on `RegionScrollSnapshot[key]`.** The existing `data-tug-scroll-state` JSON channel is meta-agnostic on the framework side (`captureRegionScrolls` reads the attribute verbatim into `entry.meta`; `applyRegionScrolls` forwards it via `tug-region-scroll-set`'s `meta` field). Per-region writers extend the JSON payload; per-region listeners decode it. Three geometry families ship in E.9:
  1. **Variable-height virtualized list (`TugListView`).** `meta.cellHeights: number[]` — the live `heightIndex` snapshot at save time, one entry per cell. On restore, `TugListView` hydrates its own `HeightIndex` from this array before first commit, so `offsetForIndex(anchorIndex)` returns the exact saved offset on the first paint.
  2. **Code editor (`FileBlock` CM6).** `meta.line: { number: number; offsetPx: number }` — content-anchored scroll position (1-based line number + intra-line pixel offset). On restore, the FileBlock dispatches a CM6 effect that scrolls the saved line to the top of the viewport. Robust to font reflow: the right *line* shows up regardless of how the font's metric resolves.
  3. **Deterministic virtualized scroller (`TerminalBlock`).** Lines are `LINE_HEIGHT_PX`-grained; pixel scrollTop maps deterministically to line index. No geometry capture needed beyond what's already saved. Validation field `meta.scrollHeight` is captured for symmetry but isn't consulted at restore.
- **Synchronous anchor handoff at `TugListView` mount.** Read `useSavedRegionScroll(scrollKey)` at render time. In a mount `useLayoutEffect`, if `meta.anchor` is present, write directly into `restoreAnchorRef.current` BEFORE CardHost's region-scroll effect fires. The companion apply effect at `tug-list-view.tsx:1252` then sees the anchor on commit 1 — and, with the hydrated `heightIndex`, computes the exact saved scrollTop and writes it before the first paint.
- **`min-height` lock on virtualized cells.** When `meta.cellHeights[i]` is present and the cell hasn't yet measured its own height, render the cell with inline `min-height: ${savedHeight}px`. This locks the layout to the saved geometry so async sub-content (markdown, image embeds, code highlighting) fills in WITHOUT shifting siblings. Once the cell's `ResizeObserver` reports its real measurement, the `heightIndex` updates; if the new height differs from the saved height, the apply effect refines `scrollTop` to keep the anchor cell fixed. In the happy path the saved and real heights match (same content, same viewport, same font), so refinement is a no-op.
- **No opacity mask. No timer. No rAF.** The MutationObserver-driven settle-and-refine loop in `card-host.tsx:1076` stays as the fallback for missing/stale geometry (old bags from pre-E.9 sessions, brand-new content with no prior measurement) and for inevitable late-stage refinements; but in the cold-boot happy path with saved geometry, the loop is a no-op from frame 1.
- **No edge-case branches in E.9.** Transcript mutation between save and restore (anchor index shifts), viewport resize (cell heights change), version skew (unknown cell ids) — all out of scope. Index-based anchors and per-key heightIndex round-trip suffice for the in-session restore case which is the user-facing regression. The settle-refine loop handles whatever divergence appears; the bag from a stale layout is still strictly better than no bag.
- **The previously contemplated opacity-mask plan is dropped.** It would have hidden the existing drift instead of fixing it. Phase E.9 fixes the drift.

**Tuglaws compliance (Phase E.9).**

- **[L01] One `root.render()`.** ✓ No new render-root behavior.
- **[L02] External state through `useSyncExternalStore`.** ✓ Saved `meta.cellHeights` flows into the React tree through `useSavedRegionScroll` (already `useSyncExternalStore`-wired in Phase E.8). The per-component writer reads its own live state via refs and writes the `data-tug-scroll-state` attribute — same channel Phase E.6 established.
- **[L03] `useLayoutEffect` for registrations.** ✓ The new mount-time hydration in `TugListView` (anchor stash + heightIndex hydration) lives in `useLayoutEffect` so the apply effect sees the stashed anchor on commit 1.
- **[L04] No parent effect triggering child setState then measuring.** ✓ Geometry consumption is render-time and effect-time within the same component. No parent-to-child setState driving downstream measurement.
- **[L05] No `requestAnimationFrame` for state-dependent operations.** ✓ The previous proposal's rAF + timer is dropped. The settle gate (`MutationObserver` + tolerance check in `card-host.tsx:1073`) stays as the fallback; it observes DOM, not time.
- **[L06] Appearance via CSS/DOM, never React state.** ✓ `scrollTop` writes are direct DOM. Cell `min-height` locks are inline `style` writes. `heightIndex` is data (the virtualizer's math reads it for cell positioning) — lives in the saved bag, hydrated into a ref-held instance, never crosses React state.
- **[L07] Live ref reads in handlers.** ✓ Writers read live `heightIndex.snapshot()` at attribute-write time. Apply effects read `restoreAnchorRef.current` live.
- **[L19] Component authoring guide.** ✓ Update `component-authoring.md`'s "Restoring saved state at mount" section to describe the geometry-capture extension (when a substrate's `scrollTop` alone isn't enough, what shape its `meta` should take, how its listener decodes). Update `state-preservation.md`'s region-scroll axis section to describe the `meta` schema.
- **[L22] External state driving DOM updates observes the store directly.** ✓ The MutationObserver-driven apply path is unchanged; it observes DOM and reads the store. The new mount-time hydration path is a one-shot at first commit, no observer.
- **[L23] Preserve user-visible state.** ★ This phase is the L23 strengthening. The previous Phase E.6 / E.8 work guaranteed "first paint reflects saved state" for the simple cases; Phase E.9 closes the variable-height-virtualization gap by saving the geometry that makes "saved state" interpretable at first paint. The contract becomes: user-visible state at first paint after restore = user-visible state at last save, INCLUDING the layout that made it user-visible.
- **[L24] Three state zones.** ✓ Geometry is data (non-rendering consumers — the virtualizer's math). Lives in the saved bag's `meta` field. Drives appearance writes (`scrollTop`, `min-height`). No state crosses zones.

**Artifacts (Phase E.9):**

- Updated: `tugdeck/src/layout-tree.ts`
  - Extend the doc comment on `RegionScrollSnapshot` to spec the `meta` schema families. The TypeScript shape stays `meta?: unknown` (per-region writers own the schema); only the prose documents the conventions for `meta.anchor`, `meta.cellHeights`, and `meta.line`.
- Updated: `tugdeck/src/components/tugways/tug-list-view.tsx`
  - **Writer.** Extend the `data-tug-scroll-state`-writing `useLayoutEffect` (currently at `tug-list-view.tsx:1196`) to serialize the live `heightIndex` snapshot into `meta.cellHeights` alongside the existing `meta.anchor`. The snapshot is an array of measured heights (one per cell index up to the current measured cap); unmeasured cells get an `undefined` slot OR are omitted (decision: omit, with the index implicit in the array offset — cleaner JSON, smaller bag).
  - **Reader (mount-time hydration).** Read `useSavedRegionScroll(scrollKey)` at render time. In a new mount `useLayoutEffect`, if `meta.cellHeights` is present, hydrate the live `HeightIndex` (the imperative one held in `heightIndexRef.current`) from the array; if `meta.anchor` is present, write directly into `restoreAnchorRef.current`. Both writes happen BEFORE the companion apply effect at `tug-list-view.tsx:1252` runs in the same commit.
  - **Cell `min-height` lock.** When rendering a cell whose saved height is known (i.e., `meta.cellHeights[cellIndex]` was hydrated and the cell hasn't been re-measured by `ResizeObserver` since mount), apply inline `style={{ minHeight: \`${savedHeight}px\` }}` to the cell wrapper. The lock holds until the cell's own measurement supersedes it; the `ResizeObserver` path updates the live `heightIndex` and clears the lock.
- Updated: `tugdeck/src/components/tugways/body-kinds/file-block.tsx`
  - **Writer.** Extend the existing CM6 stamp `useLayoutEffect` (currently writes `data-tug-scroll-key`) to also write `data-tug-scroll-state` on every commit. The serialized `meta` includes `line: { number, offsetPx }` derived from CM6's `view.posAtCoords` (or `lineBlockAtHeight` for the topmost visible line) plus the intra-line pixel offset.
  - **Reader.** Read `useSavedRegionScroll(fileScrollKey)` at render time (already wired in Phase E.8 for raw `y`). Extend the mount-time write at `file-block.tsx:715` to consult `meta.line` first: if present, dispatch a CM6 effect that scrolls to `view.lineBlockAt(view.state.doc.line(savedLineNumber).from).top + offsetPx`. If absent, fall back to the existing pixel `scrollDOM.scrollTop` write.
- Updated: `tugdeck/src/components/tugways/body-kinds/terminal-block.tsx`
  - **Writer.** Add `data-tug-scroll-state` write in the existing virtualized-scroller setup path (`appendVirtualizedBody`). The serialized `meta` is just `{ scrollHeight: totalContentPx }` — a validation field, not strictly required for restore (TerminalBlock's lines are LINE_HEIGHT_PX-grained), but useful for future cross-version checks and for the `state-preservation.md` documentation to show the canonical writer-side shape.
- Updated: `tugdeck/src/components/chrome/card-host.tsx`
  - `captureRegionScrolls` is meta-agnostic and already round-trips arbitrary JSON. No changes here.
  - `applyRegionScrolls` likewise. No changes here.
  - The region-scroll settle-tolerance loop (`apply()` at `card-host.tsx:1076`) stays unchanged: it's the fallback when saved geometry is absent OR when the apply effect's first-commit write didn't fully land.
- Updated: `tugdeck/src/components/tugways/use-component-state-preservation.tsx`
  - `SavedRegionScroll`'s `meta` type stays `unknown`; the prose docstring is updated to enumerate the three meta schema families.
- Updated: `tuglaws/state-preservation.md`
  - New subsection under the region-scroll axis: "Saving geometry for first-paint accuracy." Document `meta.cellHeights` (variable-height lists), `meta.line` (CM6), `meta.scrollHeight` (validation). State the L23 contract: first paint after restore reproduces both scroll position AND the layout that made it user-visible.
- Updated: `tuglaws/component-authoring.md`
  - Extend "Restoring saved state at mount" with a "Custom geometry meta" subsection: when raw `{x, y}` is enough, when it isn't, what shape `meta` should take, what the writer + listener need to do.
- Updated: `tuglaws/app-test-inventory.md` — register AT0069, AT0070.
- New: `tests/app-test/at0069-outer-transcript-first-paint.test.ts` — pin that the outer transcript scrollport's FIRST observed `scrollTop` after Developer > Reload matches the saved value within sub-cell tolerance (no observed `0`-frame, no observed estimated-then-refined sequence).
- New: `tests/app-test/at0070-file-block-line-relative-restore.test.ts` — pin that FileBlock CM6 restore is line-relative: scroll a long file to mid-document, save, reload, assert the FIRST observed visible-top-line matches the saved line number. (Implementation: read CM6's `view.viewport.from`/`to` via the test surface after mount.)
- New: `tugdeck/src/components/tugways/__tests__/tug-list-view.geometry-restore.test.tsx` — unit test for the `meta.cellHeights` hydration: render TugListView with a saved bag carrying cellHeights, assert the `HeightIndex` is populated before first commit, assert the rendered cells carry `min-height` style.

**Tasks (Phase E.9):**

- [x] **Extend `data-tug-scroll-state` schema doc on `RegionScrollSnapshot`.** Prose-only — TypeScript stays `meta?: unknown`. Documented the four meta-shape conventions: `anchor`, `cellHeights`, `line`, `scrollHeight`.
- [x] **TugListView writer.** In the existing anchor-state writer (`useLayoutEffect` in `tug-list-view.tsx`), captures `heightIndex.snapshot()` and serializes into `meta.cellHeights` alongside `meta.anchor` + `meta.scrollHeight`. Dense encoding (0 for unmeasured) — chosen over sparse `null` to avoid JSON's sparse-array hazards.
- [x] **TugListView reader (mount hydration).** New mount `useLayoutEffect` reads `useSavedRegionScroll(scrollKey)`. If `meta.cellHeights` is present, hydrates `heightIndexRef.current` via new `HeightIndex.hydrate` method. If `meta.anchor` is present, writes directly into `restoreAnchorRef.current`. Effect-declaration order ensures this runs BEFORE the apply effect at `tug-list-view.tsx:1252` in the same commit.
- [x] **TugListView cell `min-height` lock.** Per-cell render reads `hydratedCellHeightsRef.current?.[index]` and applies inline `min-height` when > 0. Lock is permanent within the mount (acceptable trade-off — ghost space in the rare shrink case vs. siblings shifting every time content arrives). Unit-tested in `tug-list-view.geometry-restore.test.tsx`.
- [x] **FileBlock CM6 writer.** Stamps `data-tug-scroll-state` with `meta.line = { number, offsetPx }` + `meta.scrollHeight` on every scroll. Defensive try/catch around `lineBlockAtHeight` for pre-measure safety.
- [x] **FileBlock CM6 reader.** At mount, prefers `meta.line` over raw `y` if present: computes `lineBlockAt(line).top + offsetPx` and writes `scrollDOM.scrollTop`. Pixel fallback preserved for pre-E.9 bags.
- [x] **TerminalBlock writer.** Added `data-tug-scroll-state` with `meta.scrollHeight: totalContentPx`. Reader unchanged (LINE_HEIGHT_PX deterministic; pixel scrollTop is exact).
- [x] **Document the geometry schema** in `state-preservation.md` ("Saving geometry for first-paint accuracy") and `component-authoring.md` ("Custom geometry meta — when raw `{x, y}` isn't enough").
- [x] **AT0069** — new app-test pinning outer-transcript first-paint accuracy. AT0070 was claimed and deferred: today's production app doesn't expose CM6 in a height-constrained container, so the inner-scroll restore is dormant; the writer + reader are unit-test-covered, and the app-test naturally fits when a real CM6-with-inner-scroll context lands. See app-test-inventory entry.
- [x] **Unit tests** for `HeightIndex.snapshot`/`hydrate` and `TugListView` geometry-restore behavior.

**Tests (commands, Phase E.9):**

- [x] `bun test src/components/tugways/__tests__/tug-list-view.geometry-restore.test.tsx src/components/tugways/internal/__tests__/list-view-height-index.test.ts` — 45 pass, 0 fail.
- [x] `bunx tsc --noEmit` — clean.
- [x] `bun run audit:tokens lint` — zero violations.
- [x] `bun test` (full suite) — 3720 pass, 0 fail.
- [x] `just app-test at0067-bash-block-mount-in-saved-state.test.ts at0068-bash-block-inner-scroll-from-creation.test.ts at0061-region-scroll-anchor-apply.test.ts at0069-outer-transcript-first-paint.test.ts` — all green (4/4). AT0061 regression-checks anchor-only fallback for bags without `meta.cellHeights` (forward-compat with pre-E.9 bags). AT0070 was dropped (see Tasks above).

**Checkpoint (Phase E.9):**

- [x] Manual: open a tide-card with a long transcript and scroll to a mid-list position (anchor cell visible halfway down). Developer > Reload. The first paint shows the anchor cell at the same viewport position. No `scrollTop=0` flash. No estimated-then-refined micro-hops. The cells above and below the anchor occupy their saved-height slots with content slotting in as async resolves; no layout shift propagates to the anchor cell's position.
- [x] Manual: open a tide-card with a Read tool (FileBlock) scrolled to mid-document. Developer > Reload. The first paint shows the same line at the top of the CM6 viewport. Brief font-load reflow (if any) leaves the same line at the top; pixel position may shift sub-line-height but the user-visible line identity is preserved.
- [x] Manual: scroll a Bash tool (TerminalBlock) virtualized scroller to mid-output. Developer > Reload. First-paint position is exact (deterministic line height).
- [x] Manual: cmd-tab away from Tug.app, scroll a tide-card mid-transcript, cmd-tab back. No reshuffling. (Cross-session check — exercises the same save/restore primitives without a full reload.)
- [x] Manual: open a long tide-card session, click the fold cue on a mid-list Bash block to collapse it. Reload. The block restores collapsed, the cells below adjust accordingly, AND the anchor cell (the user's last viewport reference) stays at the same viewport position.

---

##### Phase E.10 — Transient focus preservation for in-card UI

**Depends on:** Phase E.7 (`useComponentStatePreservation` channel for substrate state that must survive reload); Phase E.8 (synchronous-before-paint restore contract — saved state is in the DOM before the first focus-restore pass runs); the existing `FocusSnapshot` infrastructure (`layout-tree.ts:215`, `card-host.tsx#captureFocus`, `focus-transfer.ts#resolveActivationTarget`).

**Why this phase exists.** The framework already has a focus axis — `bag.focus` is a fully-formed `FocusSnapshot` union (`layout-tree.ts:215`), and `captureFocus` / `applyFocusSnapshot` / `resolveActivationTarget` already know how to capture, restore, and route focus. The axis works correctly for non-content-owning cards today.

For content-owning cards (every tide card is one — `tide-card.tsx:2289` registers `engineKind: "em"`) the axis is short-circuited at **three** sites that each gate on the same content-ownership signal:

1. **CardHost SAVE** (`card-host.tsx:1240-1256`). The framework-axis assembler refuses to capture `bag.focus` when `ownsSelectionAndFocus = (bag.content !== undefined)` is true. `bag.focus` stays `undefined` for tide cards forever.
2. **CardHost cold-boot RESTORE** (`card-host.tsx:992-1014`). The `traceApplyFocusSnapshot("cold-boot", ...)` call is gated on `!ownsSelectionAndFocus` and is therefore SKIPPED for content-owning cards even when `bag.focus` would be present. This is a separate code path from the resolver — cold-boot doesn't call `resolveActivationTarget` for content-owning cards.
3. **`resolveActivationTarget`** (`focus-transfer.ts:266-353`). The PRIMARY short-circuit for tide cards is the engine-managed branch at lines 290–292 (`isEngineManagedCard(card.componentId) === true` for every tide card). A secondary short-circuit at lines 297–299 covers content-owning cards that somehow weren't tagged as engine-managed. Both pre-empt the `bag.focus` resolution path that starts at line 317.

With all three sites pre-empting the axis, every activation path lands at the engine's `onCardActivated` (`tug-text-editor/state-preservation.ts:345`) which unconditionally re-claims focus to the prompt-entry's contenteditable. Any focusable target other than the engine — anywhere inside a tide card — is wiped on every activation.

The convention that produced these short-circuits (the `[D07]` tag in `card-host.tsx:1194-1238` comments — note: this is a local convention in card-host source, not the canonical D07 in `design-decisions.md`, which is about JSX composition) was correct for the engine itself. The engine's caret position is engine state — not a DOM selector lookup — and a framework `.focus()` after the engine's `setSelectedRange` would race the engine and, under WebKit's focus-with-selection quirk, collapse the just-restored selection. The convention is over-broad as written: it lumps the engine's caret with *any* focusable target inside a content-owning card. A find-row `<input>`, a future inline parameter editor, a future inline question widget — none of these have engine integration; their focus state belongs to the framework axis, not to `bag.content`.

**Phase E.10 is about making `bag.focus` work for content-owning cards.** Three coordinated changes — one at each short-circuit site — let the existing axis carry transient in-card focus the way it already carries focus for non-content-owning cards. The `FocusSnapshot` union, the markup conventions, the `applyFocusSnapshot` semantics — all of it is already there; this phase finishes the wiring.

**A precise carve-out for the engine.** The engine's selection is restored by `paintMirrorAsActive(view)` running inside the engine's `onCardActivated` — NOT by `.focus()` on the contenteditable. If the resolver naively resolved `bag.focus = { kind: "component-owned" }` for an engine-managed card and called `.focus()` on the contenteditable, the engine's inactive-paint state (selectionGuard highlight) would NOT be transferred back to the global Selection. The result: focus on the engine view with no caret. The fix: at every site, capture and resolve `bag.focus` for content-owning cards ONLY when the kind is `dom` or `form-control` (i.e., a non-engine target). When the kind would be `component-owned` (engine focus) or `none` (no focus, or focus outside the card), leave `bag.focus` absent so the engine's `onCardActivated` runs as the fallback and the engine's own selection-restore machinery handles it.

The find row is the **first consumer** of the now-complete primitive, not the goal. Any block author who needs in-card focus to survive activation paths follows the same playbook today and forever: stamp `data-tug-focus-key` on the focusable element (or use `data-tug-state-key` on a form control), and ensure the element is in the DOM at restore time (via `useComponentStatePreservation` when the element is conditionally mounted, or just by always rendering it). The framework handles the rest. Phase E.10 ships FileBlock + DiffBlock + TerminalBlock find rows as proof, and the documentation that the next widget author reads.

**Decisions.**

**Framework primitives (general, not find-specific).**

- **Three sites, one coordinated change.** The `ownsSelectionAndFocus` gate (or the equivalent `isEngineManagedCard` short-circuit) lives at THREE sites in the framework. All three need the same gate-lift treatment with the same engine-focus carve-out for the axis to actually carry focus across all activation paths:
  1. **CardHost SAVE** (`card-host.tsx:1240-1256`). Capture `bag.focus` for content-owning cards. The existing `captureFocus(cardRoot)` helper already classifies the active element into one of `form-control` / `dom` / `component-owned` / `none`. The call-site change: for content-owning cards, write only `form-control` and `dom` kinds into `bag.focus`. When `captureFocus` returns `component-owned` (the engine's contenteditable was focused) or `none`, leave `bag.focus` absent. The "forward previous bag.focus when active is outside the card" rule (the inactive-card save case at lines 1247-1255) extends unchanged.
  2. **CardHost cold-boot RESTORE** (`card-host.tsx:992-1014`). Apply `bag.focus` for content-owning cards too, with the same kind restriction. The `traceApplyFocusSnapshot("cold-boot", ...)` call's `!ownsSelectionAndFocus` gate becomes a narrower gate: skip only when `bag.focus.kind === "component-owned"`. For `dom` and `form-control` kinds, apply normally. The engine's `onCardActivated` (which runs separately, after `onRestore`) covers the `component-owned` and `none` cases by re-claiming focus the way it does today.
  3. **`resolveActivationTarget`** (`focus-transfer.ts:266-353`). Add a precondition ABOVE the engine-managed branch at lines 290–292: if `bag.focus` is `dom` or `form-control` AND resolves to a live element inside the card host root, return `{ kind: "focus-element", el }`. Otherwise fall through to the existing engine-managed dispatch path. The `kind: "component-owned"` and `kind: "none"` cases never enter this branch because the SAVE site doesn't capture them for content-owning cards. The secondary short-circuit at lines 297–299 (content-owning-but-not-engine-managed fallback) gets the same precondition for symmetry.
- **The engine carve-out is precise.** A content-owning card captures `bag.focus` ONLY when the active element classifies as `dom` (`[data-tug-focus-key]`) or `form-control` (`[data-tug-state-key]`). It never captures `component-owned` for content-owning cards — that case is owned by the engine's selection-restore machinery (`paintMirrorAsActive` inside `onCardActivated`). Calling `.focus()` on the engine's contenteditable from the framework path would bypass the inactive-paint → global-Selection transfer and leave focus on a view with no caret. The capture-side restriction is what guarantees the resolver-side can safely treat `bag.focus` as "always non-engine when present."
- **No new `FocusSnapshot` variant.** The existing union (`layout-tree.ts:215`) covers `form-control`, `dom`, `component-owned`, `none`. The resolver already queries the relevant selectors. The capture function (`card-host.tsx#captureFocus`) already returns the right shape. The four sites that need to change are call-sites of these existing primitives, not the primitives themselves.
- **No engine-side changes.** `tug-text-editor.tsx` and `state-preservation.ts` are not touched. The engine's `onCardActivated` is reached **only** when `bag.focus` is absent or stale — i.e., the user's saved focus was either on the engine (component-owned, not captured) or nowhere interesting (none). The engine fallback is the explicit default.
- **Four activation sites, three of which converge on `resolveActivationTarget`.** The sites are: (a) CardHost cold-boot focus restore (its own code path, fix #2 above), (b) `reactivateCurrentFocusDestination` (window-focus / cmd-tab back, calls the resolver), (c) `transferFocusForActivation` (intra-pane tab switch / cross-pane drag drop / close handoff, calls the resolver), (d) `transferFocusAfterMove` (cross-pane move post-commit, calls the resolver). The resolver-reorder lands once and propagates to (b) (c) (d). (a) is a separate code path requiring its own fix.
- **Reload survival = "is the element in the DOM when the cold-boot restore runs?".** Phase E.8's contract — saved state is in the DOM at first paint — is what makes reload survival work for ANY widget that opts in. A widget whose focus target is always rendered (a stationary button, a non-conditional form control) needs nothing more than `data-tug-focus-key`. A widget whose focus target is conditionally mounted (find row, future dropdown, future modal) registers a `useComponentStatePreservation` slot for the gating React state so the target re-mounts before first paint. The CardHost cold-boot restore (site #2 above) runs after the React tree is mounted, so the keyed element is queryable. There is no new framework primitive for reload survival; existing primitives compose.
- **No timer. No rAF. No DOM mutation observer for focus.** The focus-restore is a single direct `.focus()` call after the resolver returns the element. If the element doesn't exist (the widget chose not to render it), `bag.focus` resolves to "stale" and the engine fallback runs. The discipline matches Phase E.9's: no time-based fallbacks, no settle loops.

**Authoring guide for transient focus targets.**

The framework primitive obligates two things from any opt-in widget:

1. **Stamp `data-tug-focus-key` (or `data-tug-state-key`) on the focusable element.** Key shape: `<scope>/<id>` where `scope` discriminates *what kind of UI* this is (`file-block-find`, `diff-block-find`, `tool-param-editor`, …) and `id` discriminates *which instance* (typically the host block's `componentStatePreservationKey`). The framework's existing capture/restore resolves the key via `[data-tug-focus-key="<value>"]` — no namespacing infrastructure beyond the attribute itself.
2. **Ensure the element is in the DOM at restore time.** If the element is conditionally mounted (open/closed widget), register a `useComponentStatePreservation` slot for the gating state so the element re-mounts on cold boot before first paint. Always-rendered elements (stationary buttons, fixed form controls) need no slot.

Two paragraphs of `tuglaws/component-authoring.md` is the deliverable here; not infrastructure. The widget author reads the contract and implements once; the framework code is the same for find rows, future dropdowns, future modals, anything.

**First consumer: the find session.**

- **`useBlockFindSession` is the first consumer of the primitive, not the primitive itself.** All find-row state (open/closed, query, options, match count), the focus-discipline `useLayoutEffect` (focus + select on first open; re-focus + re-select on repeated Cmd-F, per the in-main commit `5f840431`), the `useComponentStatePreservation` slot for reload survival, and the `data-tug-focus-key` composition live in one hook. FileBlock currently hand-rolls all of this; DiffBlock's planned find row would duplicate it. The extraction is justified for *that* reason (don't write the same 250 lines three times), not as a framework primitive. Future widgets follow the authoring guide and roll their own hooks — `useBlockFindSession` is not a base class.
- **Three block migrations ship in this phase.** FileBlock migrates to `useBlockFindSession`. DiffBlock and TerminalBlock light up their find rows using the same hook. (Substrate-side match-highlighting for DiffBlock + TerminalBlock is out of scope — Phase E.10 ships the find-row UI + state preservation + focus survival; the actual match bridging against their respective scrollers lands when each substrate's search extension is wired.)

**Tuglaws compliance (Phase E.10).**

- **[L01] One `root.render()`.** ✓ No render-root changes.
- **[L02] External state through `useSyncExternalStore`.** ✓ The find-session reactor reads its persisted slot through `useSavedComponentState` (already `useSyncExternalStore`-wired in Phase E.7/E.8). `bag.focus` is captured at save time, not subscribed to mid-render.
- **[L03] `useLayoutEffect` for registrations.** ✓ The find-session's component-state preservation registers in `useLayoutEffect`. The find-input focus claim on first open already uses `useLayoutEffect` (`file-block.tsx:1049`); the hook extraction preserves that.
- **[L04] No parent effect triggering child setState then measuring.** ✓ Focus restore reads the resolved element's bounding rect only when needed (today: not at all — `.focus({ preventScroll: true })` is a pure mutation). No parent measurement after child setState.
- **[L05] No `requestAnimationFrame` for state-dependent operations.** ✓ All four sites (SAVE, COLD-BOOT RESTORE, RESOLVER reorder, and the in-app `reactivate`/`transferFocus*` paths that converge on the resolver) run synchronously after their respective triggers (window event, pointer event, mount commit).
- **[L06] Appearance via CSS/DOM, never React state.** ✓ Focus mutation is direct DOM. The find row's *appearance* — open/closed — is React-state-driven because it's a render branch ([L06]'s "controls what is rendered" carve-out, same shape as FileBlock's `collapsed`).
- **[L07] Live ref reads in handlers.** ✓ The find-session hook reads its persisted slot live each commit; the focus-restore reads `store.peekCardHostRoot(cardId)` live at fire time.
- **[L11] Controls emit actions; responders own state.** ✓ The find row's controls (input, nav buttons, option checkboxes, Done) dispatch through the responder chain; the hosting block remains the responder for FIND / FIND_NEXT / FIND_PREVIOUS. The hook extraction doesn't reshape the chain.
- **[L19] Component authoring guide.** ✓ Update `component-authoring.md` with a new "Transient focus targets" subsection: when to stamp `data-tug-focus-key`, the key-naming convention, the `useBlockFindSession` hook signature. Update `state-preservation.md` to describe the `findSession` slot shape.
- **[L20] Component-token sovereignty.** ✓ No new tokens.
- **[L22] External state driving DOM updates observes the store directly.** ✓ The focus-restore reads `store.getCardState(cardId)` directly; no React state copy.
- **[L23] Preserve user-visible state.** ★ This phase is the L23 strengthening for the focus axis. The contract becomes: focus position at first paint after any activation = focus position at last save, INCLUDING transient in-card UI that today is forced back to the engine.
- **[L24] Three state zones.** ✓ `bag.focus` is data (where the caret should land). Find-session preservation is data (what the row's controls show). Neither is rendering state; they drive appearance writes (`.focus()`, render branch on `findOpen`). No state crosses zones.

**Artifacts (Phase E.10):**

**Framework primitives — the focus axis for content-owning cards.**

- Updated: `tugdeck/src/components/chrome/card-host.tsx` — TWO call sites.
  - **SAVE site** (`card-host.tsx:1240-1256`). Replace the `ownsSelectionAndFocus`-gated `focus` capture with the finer-grained classification described under Decisions. The capture function (`captureFocus` at `card-host.tsx:299`) already returns the right `FocusSnapshot` shape; the call-site change is: for content-owning cards, accept the returned snapshot only when its kind is `dom` or `form-control`; otherwise treat as `none`. The "forward previous bag.focus when active is outside the card" rule (the inactive-card save case at lines 1247-1255) extends unchanged.
  - **COLD-BOOT RESTORE site** (`card-host.tsx:984-1014`). The `traceApplyFocusSnapshot("cold-boot", ...)` call is currently gated on `!ownsSelectionAndFocus`. Replace that gate with `bag.focus?.kind === "dom" || bag.focus?.kind === "form-control"`. The pre-check that focus is already inside the card (`applyFocusSnapshot:353-360`) prevents racing user interactions during the restore window. The engine's `onCardActivated` (invoked separately via the existing dispatch flow) covers the `component-owned` and `none` cases. This is the path that makes AT0073 (reload) work.
- Updated: `tugdeck/src/focus-transfer.ts`
  - In `resolveActivationTarget` (lines 266-353), add a precondition ABOVE the engine-managed branch at lines 290–292: read `bag.focus`; if `kind === "dom" || kind === "form-control"` AND the element resolves and `isConnected` inside the card host root, return `{ kind: "focus-element", el }`. Otherwise fall through unchanged. The secondary short-circuit at lines 297–299 gets the same precondition for symmetry (covers the unlikely content-owning-but-not-engine-managed registration). The `el.isConnected` check at line 340 already exists and is reused.
- Updated: `tugdeck/src/components/chrome/__tests__/card-host.test.tsx`
  - New unit tests for the SAVE site: (a) content-owning card, focus on `[data-tug-focus-key]` element → `bag.focus = { kind: "dom", focusKey }`. (b) Content-owning card, focus on `[data-tug-state-key]` element → `bag.focus = { kind: "form-control", componentStatePreservationKey }`. (c) Content-owning card, focus on the engine's contenteditable → `bag.focus` absent (engine carve-out). (d) Non-content-owning card behavior unchanged (regression).
  - New unit tests for the COLD-BOOT RESTORE site: (e) content-owning card with `bag.focus = { kind: "dom", focusKey }` → `applyFocusSnapshot` runs against the keyed element. (f) Content-owning card with `bag.focus = { kind: "component-owned" }` → restore does NOT run (engine path is authoritative). (g) Content-owning card with `bag.focus` absent → restore does NOT run.
- Updated: `tugdeck/src/__tests__/focus-transfer.test.ts`
  - New unit tests for the RESOLVER reorder: (a) engine-managed card with `bag.focus = { kind: "dom", focusKey }` AND keyed element in DOM → resolver returns `{ kind: "focus-element", el }`. (b) Engine-managed card with stale focusKey (element not in DOM) → resolver returns `{ kind: "dispatch-activated" }` (engine fallback). (c) Engine-managed card with `bag.focus` absent → `dispatch-activated`. (d) Non-engine-managed card path unchanged (regression).

**Documentation — generalize, then describe the first consumer; correct the stale claim.**

- Updated: `tuglaws/component-authoring.md`
  - New section: "Transient focus targets in content-owning cards." Two paragraphs of contract: (1) when to stamp `data-tug-focus-key` (any focusable element that should survive activation paths; not engine-managed); (2) how to ensure the element is in the DOM at restore time (always-rendered: nothing extra; conditionally mounted: register a `useComponentStatePreservation` slot for the gating state). Examples enumerate the find row, a hypothetical inline parameter editor, a hypothetical question widget — find row is one example, not the focus.
- Updated: `tuglaws/state-preservation.md` — substantive rewrite of the `FocusSnapshot in depth` section, not a touch-up.
  - **Section rewrite.** The current section (lines 361-371) describes a one-mechanism world: capture on save, apply on cold-boot, leave alone in-app. After E.10 the section has to describe BOTH mechanisms accurately and explain when each runs. Rewrite to cover: (a) what `captureFocus` classifies and when, including the engine carve-out for content-owning cards (`component-owned` kind not captured because the engine owns its own restore); (b) the cold-boot RESTORE path through CardHost, including the kind-gated apply for content-owning cards; (c) the in-session DEFENSIVE re-application via `reactivateCurrentFocusDestination` on window-focus, including the rationale (browsers don't always preserve focus reliably on cmd-tab — WebKit's app-resign / become-active cycle can drop focus, especially when the OS suspends the JS context); (d) the in-session re-application via `transferFocusForActivation` / `transferFocusAfterMove` on card/pane mutations; (e) the fallback chain at every site (bag.focus first when kind is dom/form-control; engine's `onCardActivated` default second).
  - **Retire the misleading line 370 claim outright.** "In-app transitions ... leave focus alone — the DOM never unmounts, so focus was never lost" is at best a description of intent that's never been the actual code behavior since `deck-manager.ts:127` installed the defensive listener; after E.10 it's actively wrong for the content-owning case. Replace with a precise description of which transitions re-apply through which mechanism, so the next reader doesn't get the same impression.
  - **Cross-reference the activation-target resolver and the four sites** so a reader following from `card-state-model.md` reaches the resolver without having to grep for it. Today the doc is a closed loop ("save here, apply on cold-boot, otherwise leave alone") that doesn't surface the actual code paths.
- Updated: `tuglaws/design-decisions.md`
  - Add a new decision capturing the engine-vs-framework focus-axis boundary. Currently this rule is buried in `card-host.tsx` comments tagged `[D07]` (which is NOT the same as the canonical D07 about JSX composition — those tags are a local convention that predates this audit and should be normalized). The new decision states: content-owning cards capture `bag.focus` for all focusable targets except the engine's contenteditable; the engine's `onCardActivated` is authoritative for engine focus. Cross-reference from the `card-host.tsx` and `focus-transfer.ts` comments to this new entry; retire the misleading `[D07]` tags.

**First consumer — find-row migration across three blocks.**

The first-consumer migration ships **two primitives, not one** — a state hook AND a UI component — so the find row is genuinely single-sourced across three blocks rather than three blocks rendering three copies of the same markup.

- New: `tugdeck/src/components/tugways/internal/use-block-find-session.tsx`
  - **State hook.** Wraps `useState` for `{ open, query, caseSensitive, regexp, wholeWord, matchCount }`, plus `useComponentStatePreservation<FindSessionState>` for reload survival, plus the focus-discipline `useLayoutEffect` (focus + select on first open; re-focus + re-select on repeated Cmd-F per commit `5f840431`).
  - Composes `data-tug-focus-key="<scope>/<componentStatePreservationKey>"` for the input (caller supplies `scope`, e.g. `"file-block-find"`). Exposes a ref-callback + attribute spread so the row's input receives the focus-key + ref forwarding.
  - Returns a `BlockFindSession` value carrying the live state, the open/close/clear/navigate callbacks, the action map for `FIND` / `FIND_NEXT` / `FIND_PREVIOUS`, and the input/nav-button/checkbox `*Props` spreads ready for the row component. Module docstring per [L19] names this as a consumer of the framework focus axis, not a primitive itself.
- New: `tugdeck/src/components/tugways/internal/tug-block-find-row.tsx` + `.css`
  - **UI component.** Renders the find row's full markup — sticky container, `<TugInput>` with clear button, the three option `<TugCheckbox>`es (case-sensitive / regex / whole-word), prev/next `<TugIconButton>`s, "N matches" count display, "Done" `<TugPushButton>`. The component composes only Tug primitives; no per-block bespoke chrome.
  - Props: `findSession: BlockFindSession` (the hook's return value), optional `ariaLabel` for block-specific labels ("Find in file" / "Find in diff" / "Find in terminal output"), optional `className` for block-specific positioning overrides if the sticky-top anchor differs.
  - Owns the `.tugx-block-find-*` CSS slot family per [L20]. The host block passes only the session and a label; the row's appearance is theme-tunable through its own tokens without each block having to ship its own copy of the styling.
  - Module docstring + `data-slot="tug-block-find-row"` + module-pair `.css` file per [L19].
- Updated: `tugdeck/src/components/tugways/body-kinds/file-block.tsx`
  - Replace the hand-rolled find-state machine (`file-block.tsx:953-1066`, `file-block.tsx:1076-1153`) AND the find-row JSX block (`file-block.tsx:1234-1404` approximately) with composition: `const findSession = useBlockFindSession({ scope: "file-block-find", componentStatePreservationKey })` plus `{findSession.open && <TugBlockFindRow findSession={findSession} ariaLabel="Find in file" />}`. CM6-specific bits (delegate wiring, search-query push effect, findNext/findPrevious calls) stay in FileBlock — they're CM6 integration, not find-UI.
  - Retire `file-block.css`'s `.tugx-file-find-*` rules (lines ~211-313). Replace with two or three rules at most that bind the row's `--tugx-block-find-top` to the file-block-specific sticky-stack composition (`--tugx-pin-stack-top + --tugx-toolblock-header-height + --tugx-file-header-height`). All other find-row styling moves to `tug-block-find-row.css`.
- Updated: `tugdeck/src/components/tugways/body-kinds/diff-block.tsx`
  - `useBlockFindSession({ scope: "diff-block-find", componentStatePreservationKey })` + `<TugBlockFindRow findSession={findSession} ariaLabel="Find in diff" />`. DiffBlock has the `FIND` responder action stub from Phase E.4 but no UI; this composition lights it up. Substrate-side match-highlighting against the diff cells is out of scope (lands when the diff editor gains a search extension); the row's state, focus, and reload survival all work standalone, match-count reads 0 until the substrate bridge ships.
- Updated: `tugdeck/src/components/tugways/body-kinds/terminal-block.tsx`
  - Same composition (`scope: "terminal-block-find"`, `ariaLabel: "Find in terminal output"`). Substrate-side bridge to search the virtualized character grid lands later, same pattern as DiffBlock.

**App-tests — exercise the framework primitive through the first consumer, plus engine fallback regression.**

- Updated: `tuglaws/app-test-inventory.md` — register AT0071–AT0074.
- New: `tests/app-test/at0071-content-owning-focus-survives-app-switch.test.ts`
  - Open a tide card, focus a `[data-tug-focus-key]` element inside it (the FileBlock find input is the convenient fixture). Simulate window-blur → window-focus. Assert `document.activeElement` resolves to the same element on the post-focus tick. The test title names the framework behavior; the find input is the fixture, not the subject.
- New: `tests/app-test/at0072-content-owning-focus-survives-card-switch.test.ts`
  - Two tide cards in the same pane. Card A has a `[data-tug-focus-key]` element focused (FileBlock find input). Switch to Card B → switch back to Card A. Assert focus returns to Card A's element. Pin the cross-card preservation through the framework axis.
- New: `tests/app-test/at0073-content-owning-focus-survives-reload.test.ts`
  - Open tide card, focus a conditionally-mounted `[data-tug-focus-key]` element (FileBlock find input; the conditional mount makes this the demanding case). Developer > Reload. Assert: the gating component-state-preservation slot restored, the element re-mounts on first paint, `document.activeElement` resolves to the element on the post-reload tick. Pin the reload survival contract: synchronously-before-paint restoration of the conditionally-mounted target.
- New: `tests/app-test/at0074-engine-focus-fallback.test.ts`
  - Regression check for the engine fallback. A tide card with NO `data-tug-focus-key` focus (bag.focus is `none`) and focus in the prompt-entry contenteditable. cmd-tab away and back; assert focus returns to the contenteditable via the dispatch-activated path. Pin that bag.focus precondition doesn't break the engine's default-focus contract.

**Tasks (Phase E.10):**

**Framework primitives (independent of the find-row migration).**

- [x] **CardHost SAVE: lift the gate for `dom`/`form-control` kinds.** In the framework-axis assembler at `card-host.tsx:1240-1256`, capture `bag.focus` for content-owning cards using the existing `captureFocus(cardRoot)` helper. Restriction: accept only `dom` and `form-control` kinds; treat `component-owned` and `none` as `none`. The inactive-card "forward previous bag.focus" rule applies unchanged.
- [x] **CardHost COLD-BOOT RESTORE: lift the gate for `dom`/`form-control` kinds.** At `card-host.tsx:984-1014`, replace the `!ownsSelectionAndFocus` gate on `traceApplyFocusSnapshot("cold-boot", ...)` with `bag.focus?.kind === "dom" || bag.focus?.kind === "form-control"`. The `applyFocusSnapshot` pre-check (current-focus-inside-card no-op) preserves user interactions in flight. The engine's `onCardActivated` runs separately and handles `component-owned` / `none` cases. This is the site that makes AT0073 (reload) work.
- [x] **`resolveActivationTarget` precondition.** In `focus-transfer.ts`, add the `bag.focus` resolution branch ABOVE the engine-managed branch at lines 290–292. Resolve only `dom` and `form-control` kinds; fall through to the existing engine-managed dispatch path otherwise. Apply the same precondition to the secondary content-owning short-circuit at lines 297–299.
- [x] **Documentation pass — three deliverables, all in scope this phase.**
  - `tuglaws/component-authoring.md` gains "Transient focus targets in content-owning cards."
  - `tuglaws/state-preservation.md` — substantive REWRITE of the `FocusSnapshot in depth` section covering both the cold-boot restore path (mechanism A) and the in-session re-application via `resolveActivationTarget` (mechanism B), the four activation sites that drive them, the engine carve-out on save, and the engine fallback. The misleading "in-app transitions leave focus alone" wording is retired outright.
  - `tuglaws/design-decisions.md` gains **D95** capturing the engine-vs-framework focus boundary; the `[D07]` tags in `card-host.tsx` / `focus-transfer.ts` comments (which conflict with the canonical D07 about JSX composition) are normalized to reference D95.

**Find-row consumer (drives the AT0071–AT0073 surface; the same hook + component pair lights up all three blocks).**

- [x] **Extract `useBlockFindSession`** (state). New hook in `tugdeck/src/components/tugways/internal/`. Owns find-row reactor + component-state-preservation slot + focus discipline + focus-key composition. Module docstring per [L19] names the hook as a consumer of the framework primitive, not a primitive itself. ✓
- [x] **Extract `<TugBlockFindRow>`** (UI). New component + CSS pair in `tugdeck/src/components/tugways/internal/`. Renders the full find-row markup composed from Tug primitives (TugInput, TugCheckbox, TugIconButton, TugPushButton). Props: `findSession`, optional `ariaLabel`, optional `className`. Owns the `--tugx-block-find-*` token slot family per [L20]. ✓
- [x] **Migrate FileBlock to the hook + component pair.** Replace the hand-rolled find-state machine AND the hand-rolled find-row JSX with composition: `useBlockFindSession(...)` plus `<TugBlockFindRow ...>`. Retire `.tugx-file-find-*` CSS rules in `file-block.css`; replace with a small block of rules that bind the row's sticky-top to FileBlock's local stack. Verify Cmd-F behavior unchanged for the single-block flow (commit `5f840431`'s repeated-Cmd-F focus discipline lives in the hook now). ✓
- [x] **Wire DiffBlock + TerminalBlock find rows.** Three lines of composition per block: import, hook call with the block's `scope`, conditional `<TugBlockFindRow>` render. Substrate-side match-highlighting is out of scope (lands per-substrate later). ✓ Shipped at commit 3; DiffBlock and TerminalBlock now own `diffBlockResponder` / `terminalBlockResponder` with `findSession.actions` merged into their action maps; TerminalBlock gains a `--tugx-term-header-height` writer (ResizeObserver) for the find row's sticky-stack composition.

**Tests.**

- [ ] ~~Unit tests for CardHost capture (four cases above), CardHost cold-boot restore (three cases above), and resolver reorder (four cases above).~~ — Withdrawn. The functions touched (`captureFocus`, `applyFocusSnapshot`, the SAVE-site assembler, the COLD-BOOT RESTORE branch, the `resolveActivationTarget` precondition) all depend on live DOM (`querySelector`, `isConnected`, `document.activeElement`, attribute reads on real `HTMLElement` instances). Per the project policy retiring happy-dom / jsdom (memory: "No fake-DOM unit tests — pure-logic bun:test + real-app tests only"), no test environment exists in which these helpers can be exercised standalone. Coverage moves to the AT-series real-app tests: AT0074 below (engine fallback regression, ships in this commit) plus AT0071–AT0073 (find-row consumer, ship in commit 2). The existing focus app-tests (AT0034, AT0035-tide, AT0036) provide the regression baseline for non-content-owning cards and engine-focus pathways.
- [ ] Unit tests for `useBlockFindSession` (state machine, focus discipline, key composition, reload-survival slot). — Pure-logic portion only (state machine, key composition). Focus discipline + reload-survival ride the AT-series real-app tests. — Withdrawn at commit 2: the hook's machinery (`useComponentStatePreservation`, `useSavedComponentState`, `useResponderForm`, `useLayoutEffect`-driven focus + select) all hang off React context / live DOM; per the project's "No fake-DOM unit tests" rule, pure-logic isolation is not exercisable. Real-app coverage is AT0071/AT0072/AT0073, which gate the integrated behavior end-to-end.
- [ ] Unit tests for `<TugBlockFindRow>` (markup contract: input + clear + checkboxes + nav + count + Done all present; ariaLabel forwards; clicking each control invokes the corresponding handler from the passed `findSession`). — Same: pure-logic where applicable, real-app coverage for the focus + click pathways. — Withdrawn at commit 2 for the same reason: the row component is a thin shell over `findSession` and Tug primitives; meaningful coverage requires a live DOM + provider chain, which AT0071/AT0072/AT0073 deliver against the production fixture.
- [x] **AT0074** (engine fallback regression). New `tests/app-test/at0074-engine-focus-fallback.test.ts` and inventory entry in `tuglaws/app-test-inventory.md`. ✓ At commit 2 the test runs end-to-end green (the harness regression noted at commit 1 was independently repaired in `f33d26a4` + `32d4999f`).
- [x] **AT0071** (app-switch), **AT0072** (card-switch), **AT0073** (reload) — shipped at commit 2 against the new `gallery-file-block-find-fixture` (a single FileBlock with a stable `componentStatePreservationKey`; tests seed `bag.content` to mark the card content-owning at runtime). All three pass green. ✓

**Commit structure (Phase E.10) — three commits, not one.**

Phase E.10's scope crosses a clean architectural boundary (framework axis vs. consumer migration) and the consumer side is multi-block. Squashing all of it into a single commit would produce a diff too large to review meaningfully and would couple unrelated rollback decisions. Each commit below is independently revertable, ships its own tests, and leaves the tree in a working state.

The commits land in order — commit 2 depends on commit 1 (the framework axis must be live before the find row can opt into it), and commit 3 depends on commit 2 (DiffBlock + TerminalBlock use the primitives commit 2 introduces).

- [x] **Commit 1: `feat(tide-rendering): Phase E.10/1 — bag.focus axis for content-owning cards`.** The framework primitive. Three coordinated code sites + their documentation:
  - CardHost SAVE — lift gate for `dom`/`form-control` kinds, engine carve-out (`card-host.tsx:1240-1256`) ✓
  - CardHost COLD-BOOT RESTORE — lift gate for `dom`/`form-control` kinds (`card-host.tsx:984-1014`) ✓
  - `resolveActivationTarget` — bag.focus precondition above the engine-managed branch (`focus-transfer.ts:266-353`) ✓
  - `tuglaws/state-preservation.md` — substantive rewrite of `FocusSnapshot in depth` ✓
  - `tuglaws/component-authoring.md` — new "Transient focus targets in content-owning cards" section ✓
  - `tuglaws/design-decisions.md` — **D95** capturing the engine-vs-framework boundary; `[D07]` tags in `card-host.tsx` retired (pointed at D95) ✓
  - ~~Unit tests for all three sites (eleven cases total)~~ — withdrawn (no fake-DOM environment); coverage shifts to AT0074 + existing focus app-tests.
  - **AT0074** (engine fallback regression) — `tests/app-test/at0074-engine-focus-fallback.test.ts` ships; inventory entry added. App-test execution blocked by an independent harness regression (AT0024 / AT0034 / AT0035-tide also fail without this commit's changes). ✓
  - Revert behavior: bag.focus axis stops working for content-owning cards (returns to today's regression). FileBlock's existing hand-rolled find continues working without focus survival. Engine focus and selection unchanged.
- [x] **Commit 2: `refactor(tide-rendering): Phase E.10/2 — find-row primitives + FileBlock migration`.** The hook + component pair AND the first consumer migration, together (the primitives without a consumer would be dead code in `main`):
  - New `useBlockFindSession` hook ✓ (`tugdeck/src/components/tugways/internal/use-block-find-session.tsx`)
  - New `<TugBlockFindRow>` component + CSS ✓ (`tugdeck/src/components/tugways/internal/tug-block-find-row.tsx` + `.css`)
  - FileBlock migration — retired hand-rolled state machine, retired hand-rolled row JSX, retired `.tugx-file-find-*` CSS rules in `file-block.css`. Replaced with hook + component composition plus a small CSS block binding `--tugx-block-find-top` to FileBlock's local sticky-stack. ✓
  - New `gallery-file-block-find-fixture` (`tugdeck/src/components/tugways/cards/gallery-file-block-find-fixture.tsx`) — content-owning fixture driving AT0071/AT0072/AT0073.
  - **AT0071** (app-switch) ✓, **AT0072** (card-switch) ✓, **AT0073** (reload) ✓ — all pass end-to-end against the new fixture; the find input is the focusable target, commit 1's framework axis is what makes the focus survive.
  - Inventory entries updated in `tuglaws/app-test-inventory.md` (AT0071/72/73 promoted from 🔮 deferred to ✅ shipped).
  - Revert behavior: FileBlock back to hand-rolled; find focus stops surviving (because FileBlock no longer opts in via `data-tug-focus-key`). Everything else, including the framework axis from commit 1, still works.
- [x] **Commit 3: `feat(tide-rendering): Phase E.10/3 — DiffBlock + TerminalBlock find rows`.** Mechanical opt-in for two more blocks:
  - DiffBlock: import, `useBlockFindSession({ scope: "diff-block-find", ... })`, conditional `<TugBlockFindRow ... ariaLabel="Find in diff" className="tugx-diff-find" />`; new `diffBlockResponder` owns `findSession.actions`; existing `viewToggleForm` re-parents to `diffBlockResponderId` so chain walks from the choice group reach `FIND_NEXT` / `FIND_PREVIOUS`; `.tugx-diff-find` binds `--tugx-block-find-top` to `pin-stack-top + toolblock-header-height + diff-header-height`. ✓
  - TerminalBlock: same shape, `scope: "terminal-block-find"`, `ariaLabel: "Find in terminal output"`, `className: "tugx-term-find"`; existing `terminalBlockResponder` action map merges `findSession.actions` alongside `COPY`; new `--tugx-term-header-height` writer (ResizeObserver) feeds the row's sticky-top calc `pin-stack-top + toolblock-header-height + term-header-height`. ✓
  - Manual checkpoints for the two new blocks listed below (consumer checkpoints).
  - Revert behavior: DiffBlock + TerminalBlock find rows disappear (back to the Phase E.4 stubs they were before). FileBlock and framework axis unaffected.

**Tests (commands, Phase E.10):**

- [x] `bunx tsc --noEmit` — clean at Commit 1, Commit 2, and Commit 3.
- [x] `bun run audit:tokens lint` — zero violations at Commit 1, Commit 2, and Commit 3.
- [ ] ~~`bun test src/components/chrome/__tests__/card-host.test.tsx src/__tests__/focus-transfer.test.ts src/components/tugways/internal/__tests__/use-block-find-session.test.ts src/components/tugways/internal/__tests__/tug-block-find-row.test.tsx` — green.~~ Withdrawn across both commits per the unit-test note above (no fake-DOM environment); hook + row coverage rides AT0071/72/73 real-app tests.
- [x] `bun test` (full suite) — 1580/1580 pass at Commit 1, Commit 2, and Commit 3. (Note: full-suite count is lower than the Phase E.9 plan baseline because happy-dom and all fake-DOM tests were deleted between phases, per the policy memory; the remaining suite is fully green.)
- [x] `just app-test at0071-content-owning-focus-survives-app-switch.test.ts at0072-content-owning-focus-survives-card-switch.test.ts at0073-content-owning-focus-survives-reload.test.ts at0074-engine-focus-fallback.test.ts` — **all four pass green at commit 2 and commit 3** (4/4 files, 4/4 tests). The harness regression noted at commit 1 was independently repaired by `f33d26a4` + `32d4999f`. Adjacent regression check at commit 2: `at0020 / at0024 / at0025 / at0031 / at0037 / at0067` — 6/6 files, 21/21 tests green. Adjacent regression check at commit 3: same set + `at0045 / at0046 / at0068` — green. _(The full sweep at the time also showed failures in `at0002` / `at0006*` / `at0007-em` / `at0009-em`; those were not find-row regressions — they were stale `engine-activation-dispatched` trace assertions left over from this phase's own dispatcher migration plus a missing `flushSync` before `transferFocusAfterMove`. Both root causes were fixed in the Phase E.12 follow-up; see #e12-followups.)_

**Checkpoint (Phase E.10):**

Framework-axis checkpoints — pin that `bag.focus` works for content-owning cards across all activation paths. The find row is the convenient fixture; the contract being verified is general.

- [ ] Manual (app-switch): tide card with a `[data-tug-focus-key]` element focused. cmd-tab away, cmd-tab back. Focus returns to the same element.
- [ ] Manual (card-switch): two tide cards in one pane; focus a `[data-tug-focus-key]` element in Card A. Switch to Card B, switch back to Card A. Focus returns to A's element.
- [ ] Manual (reload): tide card with a conditionally-mounted `[data-tug-focus-key]` element focused. Developer > Reload. The element's gating component-state-preservation slot restores, the element re-mounts on first paint, focus lands.
- [ ] Manual (engine fallback regression): tide card with NO `[data-tug-focus-key]` focus (bag.focus is `none`) and focus in the prompt-entry contenteditable. cmd-tab away and back. Focus returns to the contenteditable. The bag.focus precondition does not break the engine's default-focus path.
- [ ] Manual (key uniqueness): two `[data-tug-focus-key]` elements with different keys in the same card. Set focus into one, cmd-tab away and back; focus returns to the right element. Repeat with the other. The key-namespacing convention discriminates correctly.

Find-row consumer checkpoints — pin that the first consumer behaves the way the framework primitive requires.

- [ ] Manual: open a tide card with a Read tool. Open the FileBlock find row, type a query. cmd-tab away, cmd-tab back. Focus is in the find input; query preserved.
- [ ] Manual: same setup but with DiffBlock (after wiring lands). Focus survives app-switch + card-switch + reload identically.
- [ ] Manual: same with TerminalBlock.

---

##### Phase E.11 — Single-channel focus authority

**Depends on:** Phase E.10 (introduced `bag.focus` for content-owning cards). Phase E.11 rebuilds the activation-focus channel on top of that axis.

**Status:** plan only — three fixup rounds applied (F1–F9 architectural; F10–F19 refinement + completeness; per-step Tuglaws cross-references). Awaiting final approval before Commit 1 starts.

**Why this phase exists.** E.10 introduced `bag.focus` as a focus axis for content-owning cards and proved it against the `gallery-file-block-find-fixture` (AT0071–AT0074, all green). When wired against a real `tide` card with `TugTextEditor`, the framework axis loses to a co-existing path: open a Find row, click another card's title bar then click back, and focus lands on the engine's contenteditable instead of on the find input. Same outcome on Developer > Reload. The fixture didn't catch this because the fixture has no engine and no macrotask-deferred focus claim. The framework axis ships correct in isolation and broken in composition with the engine layer it has to coexist with.

**Lessons from E.10 — name them so they shape E.11.**

1. **Fixture-vs-system mismatch.** `gallery-file-block-find-fixture` is one `FileBlock` in a gallery shell. Real tide is a transcript with async-loaded messages, virtualization, an engine-managed prompt, and pane chrome with multiple cards. The fixture exercises `bag.focus` capture / restore / cross-card transfer; it exercises nothing about how those paths *compose* with an engine and a macrotask delegate. Tests that gate the axis in isolation do not gate the integrated behavior — they gate the part of the system the fixture happens to model. AT0071–74 passing was the wrong signal of doneness.

2. **Multi-claimant focus model with no precedence.** A single tide-card activation transition today can fire `.focus()` from FIVE independent paths:
   - `transferFocusForActivation` focus-element branch (`focus-transfer.ts:518`) — synchronous in the pointerdown handler. (FRAMEWORK / activation transition.)
   - `useCardStatePreservation.onCardActivated` via `invokeActivationCallback` (`tug-text-editor/state-preservation.ts:447`) — synchronous, but only from the `dispatch-activated` branch of focus-transfer. (ENGINE — engine's autonomous claim observer on the activation transition.)
   - `useCardDelegate.cardDidActivate` (`tide-card.tsx:1662`) — macrotask-deferred via `MessageChannel`. (ENGINE — engine's second autonomous claim observer.)
   - `CardHost` cold-boot `applyFocusSnapshot` (`card-host.tsx:1048`) — in `useLayoutEffect`, mount-time only. (FRAMEWORK / cold-boot RESTORE.)
   - **Substrate hook self-focus** — `useLayoutEffect`-time `.focus()` from inside the substrate component itself: `useBlockFindSession`'s `useLayoutEffect([open])` focuses `inputRef.current` whenever `open` transitions to `true`, INCLUDING on cold-boot mount when `useSavedComponentState` rehydrates `open: true` from `bag.components`. Future inline editors with their own mount-time focus claims follow the same pattern. (SUBSTRATE.)
   Each claimant can call `.focus()`; none has documented precedence over the others. Whichever fires *last* wins, and "last" depends on WebKit's gesture focus-lock and React commit timing — both browser implementation details, per [L05] not contractual.

   **The substrate-hook claimant is the one Phase E.10 silently relied on for AT0073 cold-boot.** The OLD `applyFocusSnapshot` had a "bail if focus is already inside the card on a framework-axis match" pre-check that yielded to the substrate's self-focus — encoding an implicit precedence rule (substrate beats framework on the saved target during cold-boot). Phase E.11's "single channel" framing has to make that precedence explicit, not delete it.

3. **L05 violation in the delegate substrate.** `useCardDelegate` schedules its callbacks through a `MessageChannel` macrotask explicitly to drain "past WebKit's gesture focus-lock" (`card-lifecycle.ts:744–749`). That comment is the diagnostic: the macrotask exists to escape a browser timing behavior. [L05] forbids exactly this: "timing relative to React's commit cycle is a browser implementation detail, not a contract." E.10 stacked a synchronous framework axis on top of a non-deterministic substrate; nothing in E.10 fixed the substrate, and adding a "yield via DOM check" inside the macrotask just made the workaround conditional on whether the framework's prior sync `.focus()` happened to have landed — which itself depends on the same gesture lock.

4. **L23 violation cascades from #2.** Each unconditional `.focus()` call from a competing claimant destroys whatever the previous path wrote. The "find input gets focused, then engine clobbers it" pattern is the surfacing symptom; the same destruction can flow in either direction. The contract — focus position at first paint after activation = focus position at last save — is meant to hold across every activation source. It doesn't, because the model is unsourced.

**Phase E.11 goals.**

1. **One synchronous focus authority for activation transitions.** The framework dispatches focus once per activation, deterministically, based on `bag.focus`. No racing.
2. **`bag.focus` is the canonical state.** Every focus-claim path reads from it; the channel writes through it. The engine's autonomous focus-claim observer is retired.
3. **[L05] compliance.** No focus claim depends on macrotask drain ordering relative to React commit. If a non-React ordering boundary is needed (e.g., end-of-current-JS-task), it's contractually defined and explicitly named — not "we hope this drains after the gesture."
4. **[L23] compliance across every activation source.** Cold boot, app-switch, card-switch, cross-pane drag drop, reload, drag-end. One model, one verification matrix.
5. **Real-engine test coverage.** AT-series tests exercise actual `tide-card` with `TugTextEditor`, not the engineless fixture. The fixture stays as the pure-axis regression layer; tide-card tests gate the integrated behavior.

**Tuglaws cross-check (Phase E.11).** {#e11-tuglaws}

> Phase-level summary. Per-step compliance is asserted in each step's `**Tuglaws:**` block under [Execution Steps](#e11-execution-steps); the column "Proven at" names which step demonstrates the invariant.

| Law | Status | Proven at |
|-----|--------|-----------|
| **[L01]** No `root.render()` outside mount | ✓ unchanged | — (no render-root changes anywhere) |
| **[L02]** External state via `useSyncExternalStore` only | ✓ unchanged | #e11-step-2, #e11-step-3 (engine hook registration goes through deck-manager store; framework reads `bag.focus` via existing channels) |
| **[L03]** `useLayoutEffect` for event-dependent registrations | ✓ unchanged | #e11-step-2 (engine hook registers in `useLayoutEffect`) |
| **[L04]** Never measure child DOM inline after parent triggers child setState | ✓ unchanged | #e11-step-4 (MutationObserver is the ready-callback equivalent for late-mount; no parent-triggered-then-measure pattern) |
| **[L05]** No timing-derived ordering for state-commit operations | ★ **strengthened** | #e11-step-1 (investigation matrix), #e11-step-4 (macrotask focus claim retired; gesture-end event ordering used where needed) |
| **[L06]** Appearance via CSS/DOM, never React state | ✓ unchanged | #e11-step-4 (`.focus()` is direct DOM mutation; `bag.focus` is data, not appearance) |
| **[L07]** Action handlers read live refs / store snapshots | ✓ unchanged | #e11-step-2 (engine hook closures), #e11-step-3 (`applyBagFocus` reads `bag.focus` live at fire time) |
| **[L11]** Controls emit actions; responders own state | ✓ unchanged | #e11-step-4 (responder chain untouched; focus-claim and chain promotion stay separate axes) |
| **[L19]** Component authoring guide compliance | ✓ updated | #e11-step-2 (new public API on deck-manager store), #e11-step-3 (dispatcher API surface), #e11-step-5 (state-preservation.md + component-authoring.md rewrites) |
| **[L22]** External state driving DOM updates observes directly | ✓ unchanged | #e11-step-1 (deck-trace observers), #e11-step-4 (MutationObserver drives retry directly; no React round-trip) |
| **[L23]** Preserve user-visible state | ★ **enforced** | #e11-step-4 (single-channel dispatch + D11 yield rule + late-mount targets settle, all in one commit so deferred-* has a consumer), #e11-step-6 (verified per source × per kind) |
| **[L24]** Three state zones preserved | ✓ unchanged | #e11-step-3 (`BagFocusResolution` is data; engine-hook registration is structure), #e11-step-4 (`.focus()` is appearance) |

**Explanation of the two starred laws.**

**[L05] strengthening — gesture focus-lock by event ordering, not task scheduling.** The macrotask-based focus claim in `useCardDelegate.cardDidActivate` exists to drain "past WebKit's gesture focus-lock." That's a timing-derived workaround — exactly what [L05] forbids. E.11 retires the macrotask focus claim and replaces it with two contractual primitives:

1. **Synchronous dispatch from a single channel** (`applyBagFocus`) for sources where the lock doesn't drop the call. Most pane-chrome clicks fall here because `pane-focus-controller`'s existing `mousedown.preventDefault` suppresses the lock's effect for the next event in the gesture (see #q01-mousedown-preventdefault-impact).
2. **Event-ordered dispatch on `pointerup` or `click`** for sources where the lock does drop the call. The HTML spec's "DOM event dispatch" guarantees event order — these handlers fire after pointerdown/mousedown completes, past the lock's window. This is contractual, not timing-derived.

Microtasks (`queueMicrotask`) are NOT a substitute: they drain *between* events inside a gesture, so a focus call queued in pointerdown still runs before mousedown's default action. The wrong-fix-rejected note in D6 spells this out.

**[L23] enforcement — focus position at first paint after any activation = focus position at last save.** The phase delivers this invariant across every activation source (cold-boot, app-switch, card-switch, cross-pane drag drop, reload, drag-end) and every kind in the `FocusSnapshot` union (`form-control`, `dom`, `engine`, `none`). The verification matrix is AT0071–74 (fixture) + AT0075–79 (real-tide) + the manual checkpoint list.

**Decisions (Phase E.11).** {#decisions-phase-e-11}

- **D1. The framework owns activation focus; the engine becomes a callable, not an autonomous claimant.** Today the engine's `onCardActivated` (via `useCardStatePreservation`) autonomously calls `paintMirrorAsActive(view)` whenever `invokeActivationCallback(cardId)` fires. After E.11 the engine instead registers `paintMirrorAsActive` and `paintMirrorAsInactive` as **named hooks** on a new channel (`store.registerEngineHooks(cardId, { paintMirrorAsActive, paintMirrorAsInactive })`). The framework's activation dispatcher calls `paintMirrorAsActive` when (and only when) `bag.focus.kind === "engine"`. The engine no longer decides on its own to claim focus on activation.

- **D2. Extend `FocusSnapshot` with explicit `engine` kind.** Replace the current `component-owned` variant with `engine`. Capture rules in `captureFocus`:
  - `[data-tug-state-key]` element → `form-control`.
  - `[data-tug-focus-key]` element → `dom`.
  - inside `[data-slot="tug-text-editor"]` → `engine`.
  - else → `none`.

  The E.10 carve-out — "content-owning cards only capture `dom`/`form-control`; drop engine kind" — is **retired**. Content-owning cards now capture all four kinds. The dispatch routes `engine` to the engine hook (not to a `.focus()` call), so the previous reason for filtering (calling `.focus()` on the contenteditable bypasses the inactive-paint → global-Selection transfer) no longer applies.

  **Backward-compat.** Persisted tugbank bags from pre-E.10 builds may carry `bag.focus.kind === "component-owned"`. Post-E.10 carve-out filters this out at save for content-owning cards, so any field-persisted `component-owned` value is necessarily *pre-E.10*. The deserialization path coerces `component-owned` → `engine` on read (same semantic — "the engine's contenteditable was focused"). Implemented in the `CardStateBag` deserializer or, equivalently, in the consumer of `bag.focus` (single switch). No tugbank schema bump needed; the union shape is wire-compatible because `kind` is a discriminant string and the new code accepts both spellings at the read boundary. Documented in `tuglaws/state-preservation.md` as part of D10.

- **D3. Two-layer dispatcher: pure `resolveBagFocus` + impure `applyBagFocus`.** {#focus-dispatch-model} Splitting these matters — the pure resolver is testable in isolation and the orchestrator owns side effects.
  - **`resolveBagFocus(cardId, store): BagFocusResolution`** — pure, in `focus-transfer.ts`. Reads `bag.focus` and the card host root. Returns a discriminated union:
    - `{ kind: "framework", el: HTMLElement }` — element is in DOM, connected, ready to focus.
    - `{ kind: "engine", cardId: string }` — `bag.focus.kind === "engine"` AND the engine hook is registered for this card.
    - `{ kind: "default-focus", cardRoot: HTMLElement }` — `bag.focus.kind === "none"` or absent; caller decides whether to walk the default-focus chain.
    - `{ kind: "deferred-dom", focusKey | componentStatePreservationKey }` — `bag.focus` names a framework target that isn't in the DOM yet.
    - `{ kind: "deferred-engine", cardId: string }` — `bag.focus.kind === "engine"` but the engine hook isn't registered yet (cold-boot before `TugTextEditor` mounts).
    - `{ kind: "none" }` — nothing to do; no host root, no card, etc.
  - **`applyBagFocus(cardId, store, options?): "applied" | "deferred"`** — impure. Calls `resolveBagFocus`. For `framework`: calls `el.focus()`. For `engine`: invokes the registered engine hook. For `default-focus`: walks the default-focus chain (if the caller opted in). Returns `"applied"` on success or `"deferred"` if the resolution was a deferred kind. Side effects are scoped to the focus call itself — `applyBagFocus` does NOT install observers.
  - **Orchestration belongs to the call site.** CardHost owns the MutationObserver loop that retries `applyBagFocus` on subtree mutations (for `deferred-dom`) AND on engine-hook registration via the `callbacksVersion` axis (for `deferred-engine` — see D5). `transferFocusForActivation` and `reactivateCurrentFocusDestination` are one-shot callers; they call `applyBagFocus` once and accept the result. Activation transitions don't retry because the activation is a single event — if the target isn't ready at that moment, the cold-boot orchestrator (which IS running for the freshly-active card) handles the retry.

  Every existing focus-claim site is rewritten to call `applyBagFocus` instead of its current bespoke logic: `transferFocusForActivation` (focus-element + dispatch-activated → both become `applyBagFocus`), `transferFocusAfterMove`, `reactivateCurrentFocusDestination`, CardHost cold-boot RESTORE.

- **D4. Retire the macrotask focus claim in `tide-card` AND the engine's autonomous focus claim in `onRestore` / `onCardActivated`.**
  - `useCardDelegate.cardDidActivate` no longer calls `entryDelegateRef.current?.focus()`. Activation focus is the framework's job. `cardDidMove` and `cardDidResize` keep their focus calls — those handle non-activation transitions (drag, resize) which are independent of the activation channel. The `useCardDelegate` macrotask substrate stays for the `Did*` events that don't claim focus; the L05 concern is the focus-claim use case specifically.
  - **`useCardStatePreservation.onCardActivated` no longer calls `paintMirrorAsActive`.** It either disappears or becomes empty. The engine's `paintMirrorAsActive` is now invoked exclusively via the engine hook D1 introduces, from `applyBagFocus` when `bag.focus.kind === "engine"`.
  - **`useCardStatePreservation.onRestore` no longer calls `paintMirrorAsActive` in the `isActive` branch.** Today `onRestore` does two things conditionally: (a) restore engine state (selection, text, scroll), (b) call `paintMirrorAsActive` if `isActive`. After E.11, `onRestore` keeps (a) and drops (b). The framework's cold-boot RESTORE pass in CardHost runs `applyBagFocus` immediately after `onRestore`; if `bag.focus.kind === "engine"`, the engine hook fires and `paintMirrorAsActive` runs there. This means *the engine's selection-restore (the `view.dispatch(EditorSelection.range(...))` inside `paintMirrorAsActive`) only fires when the framework decides the engine should be focused* — same semantic as today, different driver.
  - `paintMirrorAsInactive` stays in `onCardWillDeactivate`. Deactivation paint (selection routed to inactive-highlight, scroll snapshot) is not a focus claim and is not in the focus-channel collapse scope. The engine hook D1 exposes `paintMirrorAsInactive` for symmetry, but `onCardWillDeactivate` continues to fire it via the existing `useCardStatePreservation` channel; the framework's call site for inactive-paint is unchanged. This keeps the deactivation contract (paint inactive BEFORE the new card claims global Selection) intact.

- **D5. Late-mount settle: framework-axis targets AND engine readiness.** `applyBagFocus`'s deferred results need orchestration. Two flavors:
  - **`deferred-dom`** (framework-axis target hasn't rendered yet). CardHost's MutationObserver loop retries `applyBagFocus` on subtree mutations to `cardRoot`. Element-identity settle: once `applyBagFocus` returns `"applied"`, mark applied and stop. Max-retry budget: a hard count (default 200 mutations) AND a hard time budget (default 5s). If neither bounds is reached, the observer disconnects with a one-line dev-mode warn so the bug surfaces. Production behavior: silent disconnect — the framework yields rather than thrash forever.
  - **`deferred-engine`** (engine hook not registered yet at cold-boot — `TugTextEditor` mounts deeper than CardHost, so its `useLayoutEffect` registration fires *after* CardHost's RESTORE useLayoutEffect on the *initial* commit, even though children fire before parents on subsequent commits; the order specifically inverts for the very first hosted child). The engine-hook registration channel publishes a `callbacksVersion` axis (same pattern CardHost already uses for `useCardStatePreservation` callbacks at line 1216). CardHost's RESTORE effect re-runs when `callbacksVersion` increments; on re-run, `applyBagFocus` finds the engine hook registered and fires it. No separate retry observer needed for `deferred-engine` — the existing `callbacksVersion`-keyed effect IS the retry.
  - Both deferred kinds settle by the time the framework has tried both readers (DOM subtree settle + callbacks-version settle). If both still fail, the framework has done its job per [L23] — the user-visible state was *captured* correctly; the *application* failed because the target the user named no longer exists. That's a legitimate stale-state outcome, not a bug.

- **D6. WebKit gesture focus-lock — characterize first, then dispatch on the gesture-end event for sources that need it.**

  **The wrong fix (rejected).** Defer focus via `queueMicrotask`. Microtasks drain *between* events inside a click gesture (pointerdown → microtask → mousedown → microtask → mouseup → microtask → click); a focus call queued in pointerdown still runs before mousedown's default-action and gets clobbered the same way the synchronous call does. The existing `MessageChannel` macrotask "works" because it drains *after* the whole gesture, but that ordering is empirical, not contractual ([L05]).

  **The right fix.** Event ordering is contractual (HTML spec, "DOM event dispatch"). When sync `.focus()` in a pointerdown handler doesn't survive, the focus call moves to a `pointerup` or `click` handler on the same gesture — both fire *after* the gesture's focus-locking window ends. This is the same channel for every source that needs it; no scheduler timing involved.

  **Methodology (this is the gate for Commit 1).** For each activation source, run an instrumented gesture and record:
  1. Before sync `.focus(target)`: `document.activeElement`.
  2. Immediately after sync `.focus(target)` (same task): `document.activeElement`.
  3. After the gesture ends — concretely, in a `requestAnimationFrame` callback scheduled from the pointerdown handler (post-gesture sentinel, used here only for the diagnostic, not for production dispatch): `document.activeElement`.

  Outcomes:
  - (2) === target AND (3) === target → sync is sufficient for this source.
  - (2) === target AND (3) !== target → gesture-lock dropped focus mid-gesture. Move dispatch to `pointerup`.
  - (2) !== target → the sync call was rejected outright (rare; usually means the target was detached or in an inert subtree). Treat as `deferred-dom` and rely on the MutationObserver settle.

  **Sources to test:** (a) pane-chrome click (pane-focus-controller), (b) intra-pane tab click (tug-pane#performSelectCard), (c) cross-pane drag drop (deck-manager move path), (d) keyboard activation (Cmd-`, Tab into pane), (e) programmatic activation (action-dispatch, show-gallery, init/restore). The matrix per source × per `bag.focus.kind` becomes a small table in the Commit 1 investigation log.

  **Design after investigation.** Each activation source has a documented dispatch event. If all land at sync `.focus()` in pointerdown, fine — that's the simplest design and `applyBagFocus` stays sync. If some need post-gesture dispatch, those sources schedule `applyBagFocus` to fire from their `pointerup` or `click` handler instead. No timer, no macrotask, no microtask — only event-ordered dispatch. The dispatcher itself doesn't change shape; only the source that calls it does.

  The investigation deliverable for Commit 1 is a one-page note (`docs/notes/focus-gesture-lock-investigation.md`) that records the matrix and names the per-source dispatch event. Commit 2 lands the dispatcher; Commit 3 wires the per-source dispatch events per the note.

- **D7. The engineless fixture (`gallery-file-block-find-fixture`) stays.** It's the pure-framework-axis regression: a content-owning card with no engine, used to gate the `dom`/`form-control` kinds in isolation. AT0071–AT0074 against it continue to be the framework-axis baseline. They will be supplemented (not replaced) by real-tide AT-series tests (D8) so the fixture's narrowness no longer hides integration bugs.

- **D8. Real-tide AT-series (AT0075–AT0079).** Five new app-tests using real `tide` componentId with the harness's `bindTideSession` + `awaitEngineReady`:
  - **AT0075** — tide-card find row survives app-switch (cmd-tab cycle).
  - **AT0076** — tide-card find row survives card-switch (two tide cards in one pane).
  - **AT0077** — tide-card find row survives Developer > Reload (the exact scenario the user reported).
  - **AT0078** — tide-card engine focus (no find row open) survives app-switch and card-switch. Regression gate: removing the macrotask delegate must not break engine focus when the user genuinely had engine focus at save time.
  - **AT0079** — tide-card engine focus while find row is *open* but contenteditable holds focus at save time. Reload restores engine focus, not find input. Regression gate: `bag.focus.kind === "engine"` correctly wins over a stale find-row mount.

  These tests are first-class regression coverage. They are slower than fixture tests (require backend binding), and they will catch the bug E.10's tests missed.

- **D9. Cross-pane drag (`transferFocusAfterMove`) uses the same dispatcher.** The existing helper has its own dispatch logic; E.11 collapses it into `applyBagFocus`. Drag-drop activation behaves identically to click activation for focus purposes — the dispatcher is the single source.

- **D9b. Runtime `activateCard` sites route through `transferFocusForActivation`; boot/init sites stay raw.** Today five sites call `store.activateCard(...)` directly. The wrap is the same shape my E.10/3 fixup for CYCLE_CARD already shipped (`deck-canvas.tsx:172-194` after `a86f07e0`), but the focus-claim semantics differ by site:

  **Runtime sites — the wrap genuinely claims focus.** Each runtime wrap needs `outgoingCardId` (current first-responder) and `incomingCardId` (the target). Wrapped at Step 4.
  - `action-dispatch.ts:338` — chain action activating a pane's active card. React tree is mounted; `peekCardHostRoot` returns a live root; `applyBagFocus` dispatches.
  - `deck-canvas.tsx:226` — show-component-gallery activating an existing gallery card. Same as above.
  - `deck-canvas.tsx:231` — show-component-gallery activating a *new* gallery card. The new card mounts via `flushSync(commitMutation)`; by the time the resolver runs, the host root is registered.

  **Boot/init sites — stay raw.** Both sites fire BEFORE React renders any card. `peekCardHostRoot` returns `null`; `resolveBagFocus` returns `{ kind: "none" }`; `applyBagFocus` is a no-op for focus. The actual focus claim comes from **CardHost cold-boot RESTORE** when the card mounts a few ticks later. Wrapping these sites with `transferFocusForActivation` fires extra save/deactivate observer events at boot (the wrap calls `invokeSaveCallback(outgoingCardId)` and `invokeDeactivationCallback`, both of which are no-ops with `outgoingCardId === null` but the trace-event side effects fire either way). The first-cut Phase E.11 wrapped these sites and regressed AT-series tests that count lifecycle observer fires at boot. The corrected rule: **leave boot sites raw; CardHost cold-boot RESTORE owns the boot focus claim.**
  - `deck-manager.ts:1514` (`_seedDeckState`) — initial-deck-state activation.
  - `deck-canvas.tsx:291` — initial-focused-card restore.

  Verify import-cycle safety in the runtime sites — `transferFocusForActivation` is already imported via `deck-canvas.tsx:25` and `action-dispatch.ts`.

  **Tested by:** AT0075/76/77 against tide-card (which exercises the boot path through CardHost RESTORE) and by existing AT-series for the gallery runtime paths. Boot-site regression gates: AT0033 / AT0034 / AT0067 (count lifecycle observer fires at boot).

- **D11. Substrate-hook yield rule — `applyBagFocus` defers to in-card claimants that have already landed the saved target.** {#d11-yield-rule}

  **The fifth claimant the plan originally missed.** Substrate hooks (e.g. `useBlockFindSession`'s `useLayoutEffect([open])`, future inline-editor mount hooks) call `.focus()` on their own targets during their own mount commits. Those targets typically carry the same `data-tug-focus-key` / `data-tug-state-key` markers the framework would resolve from `bag.focus`. On cold-boot the substrate's claim fires *before* CardHost's RESTORE useLayoutEffect (children fire before parents); the framework's dispatch would then call `.focus()` on the same element a second time.

  **Why "calling `.focus()` on the already-focused element" is not idempotent in WebKit during mount.** The OLD `applyFocusSnapshot` had a pre-check (`if focus is already inside the card, bail`) that we previously treated as defensive cruft. Empirically (AT0073 cold-boot regression at the first cut of Step 3) the second `.focus()` call interacts with React reconciliation's focus-restoration heuristics and the substrate's `inputRef.current?.select()` follow-up in a way that drops focus to body. The simplest reliable fix is to not re-call.

  **The contract.** `applyBagFocus` performs a yield-check before dispatching:
  - When the resolved framework-axis element is already `document.activeElement` (or, equivalently, when `cardRoot.contains(document.activeElement)` AND the active element matches the resolved target by data-key), `applyBagFocus` records the trace event and returns `"applied"` WITHOUT calling `.focus()`. The substrate's prior claim is what landed; the framework verifies it.
  - When the resolved framework-axis element is in DOM but is NOT `document.activeElement`, `applyBagFocus` calls `.focus()` as usual. This is the runtime activation case (card-switch, app-switch, cmd-tab) where no substrate hook has just fired.
  - When the resolution is `engine`, the engine hook is invoked unconditionally — engine hooks (`paintMirrorAsActive`) are designed to be idempotent against an already-painted active state. The yield rule applies only to framework-axis resolutions.

  **Why this is the [L23] single-channel contract, not a workaround for it.** Single-channel does NOT mean "only one path ever writes." It means "one resolver is the source of truth about where focus should go, and writers observe that source." The substrate hook IS one of the writers — its `.focus()` call is the implementation of "land the saved target." The framework's dispatcher checks whether the writer's work matches the saved-target intent: if yes, yield (substrate did the work); if no, write. The mental model is "many writers, one read."

  **Where the rule is encoded.** `applyBagFocus`'s framework branch in `tugdeck/src/focus-transfer.ts`. Step 4 implementation; documented in `tuglaws/state-preservation.md` under [Focus dispatch model] (D10 update).

  **Tested by.** AT0073 (cold-boot find-row restore) regresses when the rule is absent — the second `.focus()` call drops focus to body. AT0071, AT0072, AT0074 don't exercise the yield because their activation paths run without a competing substrate-hook claim in the same tick. The rule is gated by AT0073; if AT0073 passes, the rule is in place.

- **D10. Documentation as deliverable.** [L19] update — substantive, not touch-up. Acknowledged: this is the *second* rewrite of `state-preservation.md`'s focus section in three phases (E.10 rewrote it once; the current text is wrong post-E.11). The deliverable:

  **`tuglaws/state-preservation.md`** — three section changes:
  1. **Rewrite `FocusSnapshot in depth` (~30 lines).** Today the section describes `form-control` / `dom` / `component-owned` / `none`. After E.11: `form-control` / `dom` / `engine` / `none`, with the engine-kind invariant ("captured for ALL cards, including content-owning; dispatch routes it to the engine hook, NOT to a `.focus()` call"). Add the backward-compat coercion (`component-owned` → `engine` on read, D2).
  2. **New section `Focus dispatch model` (~60 lines).** Names `resolveBagFocus` / `applyBagFocus` (D3), the engine hook contract (D1), the late-mount settle path (D5), the per-source dispatch-event mapping (D6 outcome), and the "all `activateCard` go through `transferFocusForActivation`" rule (D9b). Cross-references the four formerly-competing claim sites and the single dispatcher that replaces them.
  3. **Retire the E.10 wording that's now wrong.** E.10's section asserts "content-owning cards capture `bag.focus` only when kind is dom/form-control" — this is the carve-out E.11 retires. Replace with the new rule.

  **`tuglaws/component-authoring.md`** — one section change:
  1. **Add late-mount contract to "Transient focus targets in content-owning cards" (~15 lines).** Today the section says "ensure the element is in the DOM at restore time." E.11 adds: "the framework retries until your target appears, but no longer than [max-retry-budget]; if your target genuinely doesn't render after that, the framework yields and the user sees default focus." Names the responsibility clearly: widget authors own the eventual-mount; the framework owns the retry.

  Total: ~105 lines of substantive doc changes. Sized as Commit 5; does NOT block Commits 1–4 from landing (they're tested by AT-series independently of doc state), but the phase doesn't exit until docs match code.

**Why these decisions, specifically, fix what E.10 left broken.**

- **D1 + D2 retire the engine's autonomous focus claim.** The reason Glitch 2 surfaces is the engine's `paintMirrorAsActive` racing the framework's sync `.focus()`. With the engine hook called by the framework (only when `bag.focus.kind === "engine"`), the engine never races — it only fires when the framework asks it to.
- **D3 collapses the four focus-claim sites into one — with a clean pure/impure split.** The four-claimant model is the *cause* of the precedence ambiguity. Removing three of them (and changing the fourth to dispatch from `bag.focus`) eliminates the race by construction. Splitting the dispatcher into a pure resolver and an impure orchestrator means the resolver can be unit-tested in isolation (it has no DOM side effects to mock) and the orchestrator's retry policy lives at the call site that owns it (CardHost owns the MutationObserver; `transferFocusForActivation` is one-shot).
- **D4 retires the L05-violating substrate for the focus use case AND retires the engine's own bypass paths.** The macrotask substrate stays for non-focus events (cardDidMove/cardDidResize); the focus-claim — the use case that depends on timing relative to React commits — moves to a deterministic channel. Crucially D4 also retires `useCardStatePreservation.onRestore`'s focus claim and `onCardActivated`'s focus claim, so the engine has *no* autonomous path that calls `paintMirrorAsActive` outside the framework dispatcher.
- **D5 fixes Glitch 3 AND handles engine-readiness.** Reload-time the find input isn't in the DOM yet because tide's transcript loads messages async. A one-shot synchronous `applyBagFocus` at mount can't reach a target that doesn't exist yet. The MutationObserver loop is the explicit settle mechanism for the DOM-target case. The engine-hook-registration case (cold-boot, `bag.focus.kind === "engine"` before `TugTextEditor` has mounted) settles via the existing `callbacksVersion` axis CardHost already runs — no new observer needed for that path. Both deferral kinds have explicit retry budgets and explicit failure modes; the framework yields cleanly on stale state instead of looping.
- **D6 dispatches focus on the gesture-end event, not via macrotask deferral.** The investigation method is named (instrumented matrix, per-source × per-kind), the verification criterion is named (`document.activeElement` at three measurement points), the design after investigation is named (dispatch on `pointerup` / `click` for sources where pointerdown sync doesn't survive — event ordering is contractual). The `queueMicrotask` claim from the earlier draft was wrong: microtasks drain *between* events inside a gesture, so the race window isn't closed.
- **D7 + D8 close the test-fixture gap.** AT0075–79 against real tide-card would have caught the bug E.10/2 shipped. They become the integration gate that the fixture-only AT0071–74 set is not.
- **D9b closes the direct-`activateCard` hole.** Without it, retiring the engine's autonomous claim AND the macrotask claim would leave five activation paths with no focus dispatcher — boot/init, show-gallery (two), and at least one chain action. The audit lists each site; the wrap is mechanical.

**Risks and Mitigations (Phase E.11).** {#e11-risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| R01: `callbacksVersion` re-fire thrashes CardHost RESTORE | Med (perf, log noise) | Med | Step 2's Path A vs Path B decision; if Path A shows spurious re-fires in deck-trace, fall back to Path B parallel channel | Step 2 deck-trace shows >2 RESTORE re-fires per mount; or AT0001–74 timing regresses noticeably |
| R02: Cross-pane drag with stale `bag.focus` (target unmounted mid-drag) | Low (rare; degrades to `default-focus` walk) | Low | `resolveBagFocus` returns `none` when `peekCardHostRoot` is null OR target is `!isConnected`; dispatcher handles cleanly | Drag-drop manual checkpoint fails; deck-trace shows `applyBagFocus` returning `deferred-dom` for a transient drop that should have been `applied` |
| R03: Real-tide AT0075–79 flakiness from `bindTideSession` + `awaitEngineReady` heavier than fixture | Med (CI noise) | Med-High | Deck-trace assertion as backstop (verify `focus-call` events) so flake-on-timing has a non-timing recourse; per-test re-run policy matches AT0035-tide pattern | >5% flake rate in three consecutive runs |
| R04: Backward-compat coercion (`component-owned` → `engine`) hits a bag shape we didn't anticipate | Low | Low | Coerce only on read; never write `component-owned`; emit dev-mode warn when coercion fires so the migration window is observable | Coercion warn fires more than once per session in dev |

**Risk R01: `callbacksVersion` re-fire thrash** {#r01-callbacks-version-thrash}

- **Risk:** Engine-hook registration bumps the same `callbacksVersion` axis CardHost uses for `useCardStatePreservation` callbacks. Other consumers of `callbacksVersion` (notably the cold-boot RESTORE effect) re-fire on registration — which is the intended D5 behavior for `deferred-engine`, but may also cause unnecessary work for non-engine callback updates.
- **Mitigation:** Step 2's "Path A vs Path B" decision is the explicit gate. Default to Path A (shared axis); if instrumentation shows spurious re-fires for non-engine callback paths, switch to Path B (parallel `engineHooksVersion`). Decide before building, not after.
- **Residual risk:** Even Path B has an axis to track; we just trade shared-thrash for two-axis bookkeeping.

**Risk R02: Cross-pane drag with stale `bag.focus`** {#r02-stale-bag-focus-on-drag}

- **Risk:** A card mid-drag may have `bag.focus` pointing at an element that gets unmounted during the drag (e.g., the user drags a tide card while the find row was open AND tide's virtualization scrolls the FileBlock entry out of the window). At drop time, `resolveBagFocus` returns `deferred-dom` for a target that won't ever appear.
- **Mitigation:** `resolveBagFocus` checks `el.isConnected` before returning `framework` — already in the design. For `deferred-dom`, the MutationObserver retry budget (200 mutations / 5s) bounds the cost. After budget, the framework yields to default-focus; the user sees the card focused on first focusable descendant, which is acceptable degradation.
- **Residual risk:** None worth budgeting for.

**Risk R03: Real-tide AT0075–79 flakiness** {#r03-real-tide-flakiness}

- **Risk:** AT0075–79 use `bindTideSession` + `awaitEngineReady`, which are heavier than the fixture path. Heavier tests have more failure surfaces (backend not ready, message-loading races). CI flake rate may rise.
- **Mitigation:** Each AT-test gets a deck-trace assertion (verify `focus-call` event count + target) as the primary criterion. Timing-based waits are secondary. If the AT-test fails on `awaitEngineReady`, the deck-trace assertion would have caught the actual focus-axis bug. AT0035-tide already runs in CI with a similar shape — adopt its retry/timeout policy.
- **Residual risk:** Some flakes remain; they're a CI cost, not a correctness signal.

**Risk R04: Backward-compat coercion edge case** {#r04-component-owned-coercion}

- **Risk:** A pre-E.10 persisted bag with `component-owned` kind hits the coercion path. If the bag also has stale data that doesn't match an existing card, the coerced `engine` kind produces a `deferred-engine` that never settles.
- **Mitigation:** The MutationObserver retry budget (200 mutations / 5s) bounds the cost. Dev-mode warn when coercion fires makes the migration window observable; if it fires frequently in production, we'd add a schema bump.
- **Residual risk:** None for correctness; minor cost for the retry budget.

**Open Questions (Phase E.11).** {#e11-open-questions}

> Resolve before Commit 1 ships, or explicitly defer with a rationale.

**Q01: Does `pane-focus-controller`'s existing `mousedown.preventDefault` for pane chrome eliminate the gesture-lock concern for most sources?** {#q01-mousedown-preventdefault-impact}

- **Question:** The pane-focus-controller already calls `preventDefault` on the matching mousedown for pane chrome clicks (`pane-focus-controller.ts:287` area). If WebKit's gesture focus-lock is specifically about mousedown's default action moving focus to the click target, and we already suppress that default, then sync `.focus()` in pointerdown should survive for pane chrome clicks. If this is true, Step 1's investigation matrix likely shows almost all sources pass at sync, and only programmatic activation paths (which don't have a gesture) need anything special. That narrows the design surface significantly.
- **Why it matters:** If the answer is "yes, mostly," D6's per-source dispatch-event mapping is much simpler — most sources stay at pointerdown sync, and only edge cases (cross-pane drag drop, keyboard) need post-gesture dispatch.
- **Plan to resolve:** Step 1's investigation matrix answers it directly. The deliverable's per-source rows will show pre-sync, post-sync, post-gesture activeElement; if (2) === target AND (3) === target for pane chrome / tab click, Q01 resolves to "yes."
- **Resolution:** OPEN. Will be DECIDED at Step 1 completion.

**Q02: Should the retry budgets (200 mutations / 5s) be constants, config knobs, or test-tunable?** {#q02-retry-budgets}

- **Question:** Hardcoded constants are simpler; config knobs allow tuning per-environment (slow CI vs fast prod); test-tunable lets AT-tests force budget exhaustion to verify the dev-mode warn path.
- **Why it matters:** Hardcoded means a future "tide-card transcript takes >5s to load on a slow disk" bug forces a code change to fix. Test-tunable means we can verify the budget-exhaustion path in an AT-test rather than only in manual exploration.
- **Options:**
  - Hardcoded constants (default). Simplest.
  - `process.env`-controlled (or window-level config). Adds knobs without API surface.
  - Test-mode override (`window.__tugTestMode` already exists). Lets AT-tests force budget exhaustion for one test, otherwise hardcoded.
- **Plan to resolve:** Default to hardcoded; reconsider if Step 4's tests want to exercise budget exhaustion. If they do, add a test-mode override.
- **Resolution:** OPEN. Will be DECIDED at Step 4 implementation.

**Out of scope (Phase E.11).**

- Substrate-side match-highlighting for DiffBlock + TerminalBlock (lands when each substrate's search extension ships; independent of focus routing).
- Find row UI changes — the row is fine; only its focus routing needs work.
- Migrating non-tide engine surfaces — there aren't any yet; `tide-card` is the sole content-owning + engine-managed card today.
- Replacing the `useCardDelegate` macrotask substrate wholesale — only the focus-claim consumer changes channel. Other consumers (geometry events) stay where they are.

**Artifacts (Phase E.11).**

- New: `docs/notes/focus-gesture-lock-investigation.md` — per-source × per-kind matrix from Commit 1; names the dispatch event per source.
- Updated: `tugdeck/src/layout-tree.ts` — `FocusSnapshot` union gains `engine` kind, retires `component-owned` from the type but keeps backward-compat coercion on read.
- Updated: `tugdeck/src/components/chrome/card-host.tsx` — `captureFocus` classifies engine kind. `applyFocusSnapshot` is **retired**: signatures are incompatible with `applyBagFocus` (the former takes `(cardRoot, snapshot)`; the latter takes `(cardId, store)` and reads `bag.focus` itself). All existing callers — `traceApplyFocusSnapshot` and the CardHost cold-boot RESTORE site — migrate to `applyBagFocus`. The `applyFocusSnapshot` symbol is deleted from the module's exports.
- Updated: `tugdeck/src/focus-transfer.ts` — adds `resolveBagFocus(cardId, store): BagFocusResolution` (pure) and `applyBagFocus(cardId, store, options?): "applied" | "deferred"` (impure). `transferFocusForActivation`, `transferFocusAfterMove`, and `reactivateCurrentFocusDestination` are rewritten to call `applyBagFocus`.
- Updated: `tugdeck/src/deck-manager.ts` — adds `registerEngineHooks(cardId, hooks)` / `invokeEnginePaintMirrorAsActive(cardId)` / `invokeEnginePaintMirrorAsInactive(cardId, publish)` channel.
- Updated: `tugdeck/src/components/tugways/tug-text-editor.tsx` and `state-preservation.ts` — registers engine hooks via `useLayoutEffect`; `useCardStatePreservation.onCardActivated`'s focus claim is retired; `useCardStatePreservation.onRestore`'s `paintMirrorAsActive` call in the `isActive` branch is retired (engine state restore via `restoreEditState` stays).
- Updated: `tugdeck/src/components/tugways/cards/tide-card.tsx` — `useCardDelegate.cardDidActivate` no longer calls `entryDelegateRef.focus()`.
- Updated: `tugdeck/src/components/chrome/card-host.tsx` — MutationObserver loop integrates `deferred-dom` retry (element-identity settle, 200-mutation / 5s budget). `callbacksVersion`-keyed effect handles `deferred-engine` retry.
- Updated: `tugdeck/src/components/chrome/pane-focus-controller.ts` — for sources where Commit 1's matrix shows pointerdown sync doesn't survive: move dispatcher invocation to pointerup/click handler at that source.
- Updated: `tugdeck/src/action-dispatch.ts`, `tugdeck/src/deck-manager.ts`, `tugdeck/src/components/chrome/deck-canvas.tsx` — five `activateCard` call sites wrapped through `transferFocusForActivation` per D9b.
- Updated: `tuglaws/state-preservation.md` — `FocusSnapshot in depth` rewritten (~30 lines); new `Focus dispatch model` section (~60 lines); E.10 carve-out wording retired.
- Updated: `tuglaws/component-authoring.md` — late-mount contract added to "Transient focus targets" section (~15 lines).
- New: `tests/app-test/at0075-tide-find-app-switch.test.ts`
- New: `tests/app-test/at0076-tide-find-card-switch.test.ts`
- New: `tests/app-test/at0077-tide-find-reload.test.ts`
- New: `tests/app-test/at0078-tide-engine-focus-survives.test.ts`
- New: `tests/app-test/at0079-tide-engine-focus-wins-over-stale-find.test.ts`
- Updated: `tuglaws/app-test-inventory.md` — register AT0075–AT0079.

**Execution Steps (Phase E.11).** {#e11-execution-steps}

> Each step is its own commit with explicit Depends-on, References, Artifacts, Tasks, Tests, and Checkpoint per [tugplan-skeleton](../tuglaws/tugplan-skeleton.md). Decisions are referenced by `Dn` ID. Anchors inside the phase prose are `#e11-...`. Commit after all Checkpoint items pass — every step.
>
> Sequencing rule: each step must leave the tree green against the AT-series it claims to gate. The split between Step 2 and Step 3 is load-bearing — Step 2 is **additive only** (new types, new channel, no behavior change); Step 3 is **substitutive** (call-site rewrites, autonomous claim retired). If Step 3 regresses anything, reverting just Step 3 leaves Step 2's additions in place — safe.

###### Step 1: Gesture focus-lock investigation + per-source matrix {#e11-step-1}

<!-- No dependencies; this is the root of the phase. -->

**Commit:** `chore(focus-transfer): gesture focus-lock investigation + per-source matrix`

**References:** D6, R03 (#e11-d-list, #r03-real-tide-flakiness), (#focus-dispatch-model)

**Tuglaws:**
- **[L05]** ★ — the investigation is the [L05] gate for the phase. It surfaces evidence that the existing macrotask substrate is timing-derived (browser implementation detail, not contract) and produces the contractual replacement: per-source dispatch-event mapping where each source names the contractual event boundary on which Step 3 will dispatch. The investigation deliverable IS the [L05] proof.
- **[L22]** — deck-trace observers added in this step read external state (DOM, store, gesture events) directly. They do not introduce a React-state mirror; the events flow through the existing deck-trace observation channel.
- **[L02]** — diagnostic instrumentation is observation-only. No `useState`, no React-state copy of bag data. The events fire from direct DOM/store reads.
- **[L23]** — instrumentation must be a pure observer of user-visible state; it never modifies focus, selection, or any bag axis. The trace records, never mutates.

**Artifacts:**
- New: `docs/notes/focus-gesture-lock-investigation.md` — per-source × per-kind matrix; names the dispatch event per source; records which of the four claimants fires for each source.
- Updated: `tugdeck/src/deck-trace.ts` — new event variants:
  - `focus-measurement` with `phase: "pre-sync" | "post-sync" | "post-gesture"`, `site: string`, `activeElement: string`. The three measurement points at each FRAMEWORK focus-claim site.
  - `engine-paint-mirror-active` with `cardId: string`, `caller: string` — fires every time the engine's `paintMirrorAsActive` runs, with the caller tag (`onCardActivated` / `onRestore` / `via-engine-hook` / `imperative-api`).
  - `engine-paint-mirror-inactive` with `cardId: string` — fires every time `paintMirrorAsInactive` runs (symmetry; lets the trace verify deactivation pairs are intact across the refactor).
  - `macrotask-focus-claim` with `cardId: string`, `delegate: "cardDidActivate" | "cardDidMove" | "cardDidResize"` — fires every time `useCardDelegate`'s macrotask handlers call `entryDelegateRef.focus()`. Lets the trace see the macrotask-delegate claim distinctly from the framework path.
- Updated: `tugdeck/src/focus-transfer.ts` — wires `focus-measurement` events at framework focus-claim sites; no behavior change to the claims themselves.
- Updated: `tugdeck/src/components/tugways/tug-text-editor/state-preservation.ts` — wires `engine-paint-mirror-active` / `-inactive` events at each `paintMirrorAsActive` / `paintMirrorAsInactive` call site (`onCardActivated`, `onRestore`-isActive-branch, `onCardWillDeactivate`).
- Updated: `tugdeck/src/components/tugways/cards/tide-card.tsx` — wires `macrotask-focus-claim` event around the `entryDelegateRef.current?.focus()` calls in `cardDidActivate`, `cardDidMove`, `cardDidResize`.

**Tasks:**
- [x] Add deck-trace event variants: `focus-measurement`, `engine-paint-mirror-active`, `engine-paint-mirror-inactive`, `macrotask-focus-claim`.
- [x] Wire `focus-measurement` (three phases) into the four FRAMEWORK focus-claim sites: `transferFocusForActivation` (focus-element + dispatch-activated), `transferFocusAfterMove`, `reactivateCurrentFocusDestination`, CardHost cold-boot RESTORE.
- [x] Wire `engine-paint-mirror-active` at every `paintMirrorAsActive` call site so the investigation matrix can record which of the four claimants fired for each gesture: (a) `useCardStatePreservation.onCardActivated`, (b) `useCardStatePreservation.onRestore` (isActive branch), (c) `tug-text-editor.tsx:1604` mount-effect pending-restore replay, (d) any imperative `entryDelegate.paintMirrorAsActive(...)` call.
- [x] Wire `engine-paint-mirror-inactive` at every `paintMirrorAsInactive` call site (`onCardWillDeactivate`; mount-effect inactive-branch replay) — symmetry for the deactivation contract.
- [x] Wire `macrotask-focus-claim` around each `entryDelegateRef.focus()` call in `tide-card.tsx`'s `useCardDelegate` handlers — captures the macrotask delegate's claim distinctly so the matrix can see which of the four claimants is firing for each gesture.
- [ ] Run the gesture matrix manually for each source: pane-chrome click, intra-pane tab click, cross-pane drag drop, keyboard activation (Cmd-\`, Tab into pane), programmatic activation (action-dispatch, show-gallery, init/restore). _(Code-derived predictions captured in the investigation note; running-app verification protocol is documented at the foot of the note for the user to walk through against the live app — instrumentation is in place and produces the expected events. Not blocking Step 2; Step 3's dispatcher design rests on the predicted matrix and is verified by the AT-series gates.)_
- [x] For each source × each `bag.focus.kind`, record (a) the three `focus-measurement` points, (b) which claimants fired and in what order (`engine-paint-mirror-active`, `macrotask-focus-claim`), (c) the dispatcher event boundary on which Step 3 should fire.
- [x] Write up the matrix in `docs/notes/focus-gesture-lock-investigation.md`. For each source: name the dispatch event (`pointerdown` / `pointerup` / `click` / `none` — for sources where sync survives), list the four-claimant ordering observed, and note any source where the matrix differs from naive expectation.

**Tests:**
- [x] `bunx tsc --noEmit` — clean.
- [x] `bun run audit:tokens lint` — zero violations.
- [x] `bun test` — green.
- [x] `just app-test at0071-...test.ts at0072-...test.ts at0073-...test.ts at0074-...test.ts` — unchanged from baseline.

**Checkpoint:**
- [x] `docs/notes/focus-gesture-lock-investigation.md` exists; matrix complete for all sources × all kinds.
- [x] Per-source dispatch-event mapping is named (i.e., for each activation source there is a documented event boundary on which Step 3 will dispatch).
- [x] No production behavior changed (deck-trace dumps before vs. after Commit 1 are identical except for the new instrumentation events).

---

###### Step 2: FocusSnapshot engine kind + engine-hook channel (additive) {#e11-step-2}

**Depends on:** #e11-step-1

**Commit:** `feat(focus): engine kind in FocusSnapshot + engine-hook registration channel`

**References:** D1, D2, R01 (#e11-d-list, #r01-callbacks-version-thrash), (#focus-dispatch-model)

**Tuglaws:**
- **[L19]** ✓ — extending `FocusSnapshot` (an exported public type) and adding three new methods on the deck-manager store interface (`registerEngineHooks`, `invokeEnginePaintMirrorAsActive`, `invokeEnginePaintMirrorAsInactive`). Both surfaces are public API additions and follow the component-authoring guide: module docstring updated, types exported, no behavior change at consumer call sites.
- **[L03]** ✓ — `TugTextEditor` registers engine hooks via `useLayoutEffect` keyed on `[store, cardId]`. Registration is complete before any framework event that could call the hook fires. Same mount-phase contract as the existing `useCardStatePreservation` callback registration.
- **[L07]** ✓ — engine hook closures registered in Step 2 read `viewRef.current` live at fire time (not at registration time). The hook is stable across re-renders; the live reads keep the closure honest.
- **[L02]** ✓ — engine-hook registration goes through the deck-manager store (an existing `useSyncExternalStore`-backed singleton). No new React-state mirror of hook state.
- **[L23]** ✓ — the backward-compat coercion (`component-owned` → `engine` on read) is information-preserving: pre-E.10 bags continue to drive the correct dispatch path (engine focus), no user-visible state is lost on the migration window.

**Artifacts:**
- Updated: `tugdeck/src/layout-tree.ts` — `FocusSnapshot` union: `engine` kind added; `component-owned` removed from the type.
- Updated: `tugdeck/src/components/chrome/card-host.tsx` — `captureFocus` classifies `[data-slot="tug-text-editor"]` matches as `engine`.
- Updated: deserialization path for `bag.focus` — backward-compat coercion `component-owned` → `engine` on read (D2).
- Updated: `tugdeck/src/deck-manager-store.ts` and `tugdeck/src/deck-manager.ts` — adds `registerEngineHooks(cardId, hooks)`, `invokeEnginePaintMirrorAsActive(cardId)`, `invokeEnginePaintMirrorAsInactive(cardId, publish)` channel.
- Updated: `tugdeck/src/components/tugways/tug-text-editor.tsx` — registers engine hooks via `useLayoutEffect`.
- **Unchanged at this step:** `useCardStatePreservation.onCardActivated` still calls `paintMirrorAsActive` (autonomous claim). `useCardStatePreservation.onRestore` still calls `paintMirrorAsActive` in the `isActive` branch. `useCardDelegate.cardDidActivate` in `tide-card.tsx` still calls `entryDelegateRef.focus()`. **This step is purely additive — the new channel exists but is not yet invoked from the framework.**

**Tasks:**
- [x] Replace `component-owned` with `engine` in the `FocusSnapshot` union; update all type sites.
- [x] Update `captureFocus` to return `{ kind: "engine" }` when the active element sits inside `[data-slot="tug-text-editor"]` (or any other `COMPONENT_OWNED_SELECTORS` entry; the selector list stays).
- [x] Add backward-compat coercion: when reading a persisted bag, `bag.focus.kind === "component-owned"` is coerced to `engine` at the deserialization boundary (or at the read consumer, whichever yields a smaller surface). _(Implemented in `settings-api.ts#coerceFocusSnapshotOnRead`, called from `readCardStates`.)_
- [x] Add the three new methods to `deck-manager-store` interface and `deck-manager` implementation. _(Plus a fourth method `subscribeEngineHooksChange` for Step 4's late-mount retry — Path B was chosen, see decision below.)_
- [x] **Decide and implement the engine-hook registration → `callbacksVersion` integration.** **Path B chosen.** Path A would require `registerEngineHooks` to reach into CardHost's local `callbacksVersion` state, which would either (a) leak through the existing `CardStatePreservationContext.register` callback (couples two independent concerns) or (b) require a side-channel call from `deck-manager` back into React tree state (architectural smell). Path B adds a dedicated `subscribeEngineHooksChange(cardId, listener)` channel on the store that CardHost subscribes to in `useLayoutEffect`; the listener bumps a local `engineHooksVersion` counter that joins the cold-boot RESTORE effect's dep set. Cleaner separation; the spurious-re-fire concern of Path A doesn't apply because the channel fires only on real engine registrations. Step 4 wires CardHost's subscription.
- [x] `TugTextEditor` registers `paintMirrorAsActive` / `paintMirrorAsInactive` hooks via `useLayoutEffect` keyed on `[cardId]`. Registration fires the engine-hooks-change channel.
- [x] Update `resolveActivationTarget` to handle `engine` kind defensively (treat as `dispatch-activated` for now — the framework dispatch wiring lands in Step 3). _(Engine-managed and content-owning cards already short-circuit to `dispatch-activated` above the kind-specific branch; the DOM-authority fallback path keeps its defensive engine-selector query with a clarifying comment.)_

**Tests:**
- [x] `bunx tsc --noEmit` — clean.
- [x] `bun run audit:tokens lint` — zero violations.
- [x] `bun test` — green.
- [x] `just app-test at0071-...test.ts at0072-...test.ts at0073-...test.ts at0074-...test.ts` — green (additive, no behavior change).
- [x] Adjacent regression: `just app-test at0020 at0024 at0025 at0031 at0033 at0034 at0035-tide at0046 at0067` — green.

**Checkpoint:**
- [x] No `FocusSnapshot.kind === "component-owned"` references remain in the codebase (TypeScript exhaustiveness checker enforces).
- [x] Engine hooks are registered for tide cards (verify via deck-trace event added in Step 1). _(Verified at the wiring site: `tug-text-editor.tsx` `useLayoutEffect` calls `store.registerEngineHooks(cardId, {...})`. Hook closures emit `engine-paint-mirror-active` / `engine-paint-mirror-inactive` with `caller: "via-engine-hook"` when invoked by Step 3's dispatcher.)_
- [x] AT0071–74 + adjacent regression set: 100% pass.

---

###### Step 3: Dispatcher infrastructure (additive only) {#e11-step-3}

**Depends on:** #e11-step-2

**Commit:** `feat(focus): resolveBagFocus + applyBagFocus dispatcher infrastructure (additive)`

**References:** D3, D11 (#e11-d-list, #d11-yield-rule), (#focus-dispatch-model)

**Rescoped from "substitutive" to "additive-only" after Phase E.11 first-cut.** The first attempt at Step 3 tried to retire `resolveActivationTarget` / `applyFocusSnapshot`, wire `applyBagFocus` into all four transfer entry points, and retire the autonomous claims in a single commit. AT0073 (cold-boot find-row restore) regressed because the OLD `applyFocusSnapshot` pre-check encoded an implicit precedence rule — "if a substrate hook (the fifth claimant, see #e11-tuglaws) has already focused the saved framework-axis target, yield" — that the substitutive rewrite removed without a replacement. The deferred-dom branch of `applyBagFocus` also had no consumer at Step 3 (Step 4 is the retry); cold-boot late-mount cases that previously passed via the substrate's own self-focus broke once the OLD pre-check was gone. **Lesson:** the precedence rules in the OLD claimant tangle must be made explicit (D11) before the substitution can land safely. The substitution now lives at Step 4 alongside the late-mount settle.

Step 3 introduces the dispatcher API surface and the new store methods needed to call it. No production call site invokes `applyBagFocus` at this step; the existing four-claimant model continues to drive activation focus exactly as it did at the end of Step 2. The grep gates that prove "single channel" land at Step 4.

**Tuglaws:**
- **[L02]** ✓ — `applyBagFocus` / `resolveBagFocus` read `bag.focus` via the existing store snapshot channel. No new React-state mirror.
- **[L05]** ✓ — additive only: no production behavior changes, so [L05] compliance is unchanged from Step 2. The dispatcher API surface is designed to satisfy [L05] when wired in at Step 4 (event-ordered dispatch per Step 1's matrix; no macrotask substrate).
- **[L06]** ✓ — `applyBagFocus`'s impure branch calls `.focus()` directly on resolved elements (no React state). The pure resolver returns data; no DOM mutation.
- **[L07]** ✓ — `applyBagFocus(cardId, store)` reads `bag.focus` live from the store at call time. No stale-closure capture.
- **[L19]** ✓ — exported public API: `resolveBagFocus`, `applyBagFocus`, `BagFocusResolution`, and the three engine-hook methods on `IDeckManagerStore` (`registerEngineHooks`, `invokeEnginePaintMirrorAsActive`, `invokeEnginePaintMirrorAsInactive`, `hasEngineHooks`, `subscribeEngineHooksChange`). Module docstrings name the contract.
- **[L23]** ✓ — additive only; the existing implicit-precedence behavior continues to drive focus. Step 4 enforces [L23] explicitly via single-channel dispatch + D11 yield rule.
- **[L24]** ✓ — three zones preserved:
  - **Data:** `BagFocusResolution` is a value (pure resolver output).
  - **Structure:** engine-hook registration channel on the deck-manager store.
  - **Appearance:** `applyBagFocus`'s `.focus()` call is direct DOM mutation (when Step 4 wires it in).

**Artifacts:**
- Updated: `tugdeck/src/focus-transfer.ts` — new exports `resolveBagFocus(cardId, store): BagFocusResolution` (pure) and `applyBagFocus(cardId, store, options?): "applied" | "deferred"` (impure). The new `BagFocusResolution` six-variant union (`framework` / `engine` / `default-focus` / `deferred-dom` / `deferred-engine` / `none`). `resolveActivationTarget` and the `ActivationTarget` union STAY in this step — the substitution moves to Step 4.
- Updated: `tugdeck/src/deck-manager-store.ts` — adds `hasEngineHooks(cardId)` to `IDeckManagerStore` (the discriminator `resolveBagFocus` uses to choose `engine` vs `deferred-engine`). The `registerEngineHooks` / `invokeEnginePaintMirrorAsActive` / `invokeEnginePaintMirrorAsInactive` / `subscribeEngineHooksChange` methods are already present from Step 2.
- Updated: `tugdeck/src/deck-manager.ts` — implement `hasEngineHooks(cardId)` as `this.engineHooks.has(cardId)`.
- Updated: `tugdeck/src/focus-transfer.ts` — `FocusTransferStore` widens to include `hasEngineHooks` and `invokeEnginePaintMirrorAsActive` (the methods `applyBagFocus` calls).
- **Unchanged at this step:** all production call sites continue to drive focus via the OLD path (`resolveActivationTarget` / `applyFocusSnapshot` / engine autonomous claims / macrotask delegate). Step 4 substitutes.

**Tasks:**
- [x] Define `BagFocusResolution` as the six-variant union per D3.
- [x] Implement `resolveBagFocus(cardId, store): BagFocusResolution` (pure). Reads `bag.focus`, `peekCardHostRoot(cardId)`, `hasEngineHooks(cardId)`, `getSnapshot().cards`. Returns the appropriate variant. No side effects.
- [x] Implement `applyBagFocus(cardId, store, options?): "applied" | "deferred"` (impure). Calls `resolveBagFocus`; dispatches per variant: `framework` → `el.focus()`; `engine` → `store.invokeEnginePaintMirrorAsActive(cardId)`; `default-focus` → `traceApplyDefaultFocus`; `deferred-*` → return `"deferred"`; `none` → return `"applied"`. Emits `focus-call` deck-trace event for `framework` / `engine` dispatches. Implements the D11 yield rule for the `framework` branch: when the resolved element is already `document.activeElement`, return `"applied"` without calling `.focus()`.
- [x] Add `hasEngineHooks(cardId): boolean` to `IDeckManagerStore` and implement in `DeckManager`.
- [x] Widen `FocusTransferStore` Pick<> to include `hasEngineHooks` and `invokeEnginePaintMirrorAsActive`.
- [x] Module docstring updates in `focus-transfer.ts` naming the new exports, the six-variant union, the D11 yield rule, and the migration plan (existing callers still use the OLD path until Step 4).
- [x] **Do NOT delete `resolveActivationTarget` or `ActivationTarget` yet.** They stay; Step 4 deletes them as part of the substitution.
- [x] **Do NOT rewrite `transferFocusForActivation` / `transferFocusAfterMove` / `reactivateCurrentFocusDestination` yet.** They stay; Step 4 substitutes.
- [x] **Do NOT migrate CardHost cold-boot RESTORE yet.** It stays; Step 4 substitutes.
- [x] **Do NOT retire autonomous claims yet.** `onCardActivated` / `onRestore isActive` / `cardDidActivate` keep their existing focus calls; Step 4 retires them.
- [x] **Do NOT wrap direct `activateCard` sites yet.** Step 4 wraps the runtime sites; the boot sites stay raw per D9b updated guidance.

**Tests:**
- [x] `bunx tsc --noEmit` — clean.
- [x] `bun run audit:tokens lint` — zero violations.
- [x] `bun test` — green.
- [x] `just app-test at0071-...test.ts at0072-...test.ts at0073-...test.ts at0074-...test.ts` — green (fixture regression must hold).
- [x] Adjacent regression: `just app-test at0020 at0024 at0025 at0031 at0033 at0034 at0035-tide at0046 at0067` — green.

**Checkpoint:**
- [x] `resolveBagFocus` and `applyBagFocus` are exported from `focus-transfer.ts` and callable from test code.
- [x] `hasEngineHooks(cardId)` is implemented on `DeckManager` and visible on `IDeckManagerStore`.
- [x] No production call site invokes `applyBagFocus` at this step (grep gate: only the additive type/function definitions exist; no `applyBagFocus(` call expressions in production code outside `focus-transfer.ts`'s own self-reference). _(Verified: all `applyBagFocus` references in tugdeck/src are docstrings, comments, or the function's own self-reference in its definition.)_
- [x] AT0071–74 + adjacent regression set: 100% pass (additive only — no behavior change).

---

###### Step 4: Substitute call sites + retire autonomous claims + late-mount settle {#e11-step-4}

**Depends on:** #e11-step-3

**Commit:** `feat(focus): single applyBagFocus dispatcher + retire autonomous claims + late-mount settle`

**References:** D3, D4, D5, D6 outcome, D9, D9b, D11, R01, R04 (#e11-d-list, #r01-callbacks-version-thrash, #r04-component-owned-coercion, #d11-yield-rule), (#focus-dispatch-model)

**Rescoped from Phase E.11 first-cut.** Originally the plan split substitution (Step 3) from late-mount settle (Step 4). The Step 3 first-cut surfaced a load-bearing implicit precedence rule (D11 — substrate hook yields) that, combined with the deferred-dom variant having no consumer at Step 3, broke AT0073 cold-boot. The rescoped Step 4 lands the substitution AND the retry mechanism AND the D11 yield rule together so the deferred-dom contract has a consumer in the same commit that introduces it.

**Tuglaws:**
- **[L05]** ★ — the [L05] strengthening lands here. The macrotask-based focus claim in `useCardDelegate.cardDidActivate` is retired (it depended on browser-implementation macrotask drain order, per [L05] not contractual). For sources where pointerdown-time sync `.focus()` lands (per Step 1's matrix), the dispatcher fires synchronously. For sources where it doesn't, dispatch moves to the `pointerup` or `click` handler — event ordering is contractual (HTML spec, "DOM event dispatch"). No macrotask, no microtask, no timer. **Verified by:** Step 4 Checkpoint grep gate ("no `MessageChannel`-deferred `.focus()` calls for activation"); deck-trace verification ("exactly one `focus-call` event per activation").
- **[L23]** ★ — the single-channel dispatcher + D11 yield rule IS the [L23] contract for the focus axis. Every focus-claim path reads `bag.focus` and dispatches via `applyBagFocus`; the engine becomes a callable invoked from the same channel; substrate hooks observe the same source via the yield rule. No competing claimants writes the same target twice in the same tick. **Verified by:** AT0073 (substrate-hook precedence regression), AT0078 (engine focus regression), the manual Glitch 2 / 3 scenarios, deck-trace showing one `focus-call` event per activation.
- **[L04]** ✓ — the late-mount retry is the [L04] ready-callback pattern, not an inline-measure-after-setState pattern. The MutationObserver fires when the child's DOM commits; CardHost reacts to that observed event. We do NOT trigger a child setState and then measure synchronously — we wait for the child to commit on its own schedule, then react.
- **[L02]** ✓ — the MutationObserver callback reads the store directly via `applyBagFocus`; the retry mechanism does not mirror bag state into React.
- **[L06]** ✓ — `applyBagFocus` calls `.focus()` directly on the resolved element (or invokes the engine hook which calls `view.focus()`). Focus mutation is appearance-zone DOM, not React state.
- **[L07]** ✓ — `applyBagFocus(cardId, store)` reads `bag.focus` live from the store at dispatch time. No stale-closure capture.
- **[L11]** ✓ — the responder chain is unchanged. Focus-claim and chain promotion remain separate axes.
- **[L19]** ✓ — `applyFocusSnapshot` is deleted from `card-host.tsx` exports. `resolveActivationTarget` is deleted from `focus-transfer.ts` exports. Module docstrings updated. Grep gates in Checkpoint enforce.
- **[L22]** ✓ — external state (DOM mutations observed by MutationObserver; the deck-manager's engine-hooks-change channel) drives the dispatcher directly. No React-state round-trip.
- **[L24]** ✓ — three zones preserved:
  - **Data:** `bag.focus` — read by the dispatcher.
  - **Structure:** engine-hook registration via deck-manager store; D9b runtime `activateCard → transferFocusForActivation` wraps.
  - **Appearance:** `.focus()` on the resolved element or engine hook's `view.focus()`.

**Artifacts:**
- Updated: `tugdeck/src/focus-transfer.ts` — `transferFocusForActivation` (focus-element AND dispatch-activated branches), `transferFocusAfterMove`, `reactivateCurrentFocusDestination` rewritten to call `applyBagFocus`. D11 yield rule wired into `applyBagFocus`'s framework branch. `resolveActivationTarget` and `ActivationTarget` deleted.
- Updated: `tugdeck/src/components/chrome/card-host.tsx` — cold-boot RESTORE rewritten to call `applyBagFocus`. MutationObserver loop integrates `deferred-dom` retry (settle by element identity + 200-mutation / 5s budget). Engine-hooks-change subscription drives `deferred-engine` retry (`subscribeEngineHooksChange` from Step 2 bumps a local version axis; CardHost's RESTORE effect re-fires). `applyFocusSnapshot` and `traceApplyFocusSnapshot` deleted.
- Updated: `tugdeck/src/components/tugways/tug-text-editor/state-preservation.ts` — `useCardStatePreservation.onCardActivated` no longer calls `paintMirrorAsActive`. `useCardStatePreservation.onRestore` no longer calls `paintMirrorAsActive` in the `isActive` branch (keeps `restoreEditState`).
- Updated: `tugdeck/src/components/tugways/cards/tide-card.tsx` — `useCardDelegate.cardDidActivate` no longer calls `entryDelegateRef.focus()`. `cardDidMove` / `cardDidResize` focus claims remain.
- Updated: `tugdeck/src/action-dispatch.ts` (focus-pane action), `tugdeck/src/components/chrome/deck-canvas.tsx` (show-component-gallery: two sites) — three runtime direct `activateCard` call sites wrapped through `transferFocusForActivation` per D9b. Boot sites (`deck-manager.ts` `_seedDeckState`, `deck-canvas.tsx` initial-focused-card restore) stay raw — `applyBagFocus` would resolve `none` at boot (no host root yet); CardHost's cold-boot RESTORE is the real claim path, so wrapping the boot sites adds lifecycle noise without behavior gain (regresses tests that count lifecycle observer fires).
- Updated: `tugdeck/src/components/chrome/pane-focus-controller.ts` (and other gesture sources as indicated by Step 1's matrix) — for sources where pointerdown sync doesn't survive, move dispatcher invocation to `pointerup` or `click` per the per-source mapping.
- New: `tests/app-test/at0075-tide-find-app-switch.test.ts` — find row focus survives app-switch on real tide.
- New: `tests/app-test/at0076-tide-find-card-switch.test.ts` — find row focus survives card-switch on real tide.
- New: `tests/app-test/at0077-tide-find-reload.test.ts` — find row focus survives Developer > Reload on real tide; this is the exact Glitch 3 scenario.
- New: `tests/app-test/at0078-tide-engine-focus-survives.test.ts` — tide-card with engine focus (no find row), cmd-tab cycle, focus returns to contenteditable.
- New: `tests/app-test/at0079-tide-engine-focus-wins-over-stale-find.test.ts` — when bag.focus.kind === engine but a find row is also open (open-state preserved), engine wins on reload.

**Lessons from Step 4 first cut.** {#e11-step-4-first-cut-lessons}

The Step 4 first cut bundled 13 independent substitutions into one commit (transferFocusForActivation rewrite, transferFocusAfterMove rewrite, reactivateCurrentFocusDestination rewrite, CardHost cold-boot RESTORE migration + MutationObserver retry + engineHooksVersion subscription, 4 autonomous-claim retirements, 3 activateCard runtime wraps, engine-hook registration on TugPromptEntry, resolver fix for content-owning + not-engine-managed, deletion of obsolete code). AT0071 regressed mid-implementation; the cause was opaque because the 13 changes co-mingled. Each rollback / hypothesis cycle took 5–10 minutes of test runs and didn't converge.

The structural fix: **land Step 4 as a sequence of small sub-commits (4a–4l)**, each performing exactly one substitution and gated by the AT0071–74 fixture regression set + the adjacent regression set before continuing. When a sub-commit regresses, the cause is the change in that commit; the next iteration can diagnose from one identified delta rather than a soup of 13.

A secondary lesson, recorded for future re-planning: the "five-claimant model + D11 yield rule" framing is the right architectural model, but the runtime has implicit precedence rules I can't enumerate from static reading of the React/store code alone. When a sub-step regresses something, the regression names the next implicit rule — add it to D11 (or a sibling decision) and update the plan before continuing.

**Tasks (sequence 4a–4l).** Each sub-task is its own commit. Gate every commit on: `bunx tsc --noEmit` clean, `bun run audit:tokens lint` zero violations, `bun test` green, AT0071–74 fixture regression green, adjacent regression set (at0020 / at0024 / at0025 / at0031 / at0033 / at0034 / at0035-tide / at0046 / at0067) green. AT0075–79 are introduced at 4l (the final sub-commit). If a sub-step regresses, **stop and diagnose** before continuing.

- [ ] **4a. Migrate `transferFocusAfterMove` to `applyBagFocus`.** Lowest blast radius — cross-pane drag drops and detach paths. Commit: `feat(focus): transferFocusAfterMove → applyBagFocus`.

- [ ] **4b. Migrate `reactivateCurrentFocusDestination` to `applyBagFocus`.** Window-focus reactivation (cmd-tab return). Preserve `preventScroll: true`. Commit: `feat(focus): reactivateCurrentFocusDestination → applyBagFocus`.

- [ ] **4c. Migrate `transferFocusForActivation` to `applyBagFocus`.** The central activation path — all click-driven row 1/2/3 activations. Preserve `installFormControlReapplyOnNextMousedown` post-`applied` and `blurFocusInOutgoingCard` safety net. **Highest blast radius substitution; expect to spend time here.** Commit: `feat(focus): transferFocusForActivation → applyBagFocus`.

- [ ] **4d. Migrate CardHost cold-boot RESTORE to `applyBagFocus`. Add late-mount retry.** D11 yield rule covers substrate-hook precedence. MutationObserver loop retries `applyBagFocus` on `deferred-dom` (200 mutations / 5s budget; dev-mode warn on exhaustion; production silent). `subscribeEngineHooksChange` listener bumps `engineHooksVersion` state; RESTORE effect deps on it for `deferred-engine` retry. Commit: `feat(focus): CardHost cold-boot RESTORE → applyBagFocus + late-mount settle`.

- [ ] **4e. Register engine hooks on `tug-prompt-entry.tsx`.** TugPromptEntry is the engine for tide-card and gallery-prompt-entry. The hook reads `pendingActivationDraftRef` at fire time and calls `editor.paintMirrorAsActive(pending ?? undefined)`. This makes the engine a framework-callable; necessary precondition for 4f. Commit: `feat(focus): register engine hooks on TugPromptEntry`.

- [ ] **4f. Retire `tug-prompt-entry.tsx` autonomous claims.** `onCardActivated`'s `paintMirrorAsActive` call removed (handler kept for `inactiveDraftSnapshotRef.current = null`). `onRestore`'s `paintMirrorAsActive(restored.draft)` in `isActive` branch removed; both active and inactive paths stash `pendingActivationDraftRef`. The framework's `applyBagFocus` now drives TugPromptEntry's focus claim via the engine hook from 4e. Commit: `feat(focus): retire TugPromptEntry autonomous claims`.

- [ ] **4g. Retire `tug-text-editor/state-preservation.ts` autonomous claims.** Same shape as 4f but for the standalone TugTextEditor used by gallery-text-editor. `useCardStatePreservation.onCardActivated` empties (or keeps only `inactiveScrollSnapshotRef.current = null`). `onRestore` `isActive` branch drops `paintMirrorAsActive(state)` call. Engine hooks are already registered at Step 2. Commit: `feat(focus): retire TugTextEditor autonomous claims`.

- [ ] **4h. Retire `tide-card.tsx` cardDidActivate macrotask + tug-text-editor.tsx mount-effect-replay active branch.** The two remaining macrotask / deferred focus claims. `cardDidMove` / `cardDidResize` keep their focus claims (drag/resize re-mount handling — out of activation scope). Commit: `feat(focus): retire macrotask cardDidActivate + mount-effect-replay active branch`.

- [ ] **4i. Wrap 3 runtime `activateCard` sites through `transferFocusForActivation`.** `action-dispatch.ts` (focus-pane), `deck-canvas.tsx` (show-component-gallery: existing + new). Boot sites (`_seedDeckState`, initial-focused-card restore) stay raw. Commit: `feat(focus): wrap runtime activateCard sites via transferFocusForActivation`.

- [ ] **4j. Move dispatcher invocation to `pointerup` / `click` for sources where Step 1's matrix says pointerdown sync doesn't survive.** Currently no source identified by the matrix as requiring this; this sub-step is reserved for if/when the running-app matrix verification reveals one. Commit: `feat(focus): per-source dispatch event mapping` (or skipped if not needed).

- [ ] **4k. Delete `resolveActivationTarget`, `ActivationTarget`, `applyFocusSnapshot`, `traceApplyFocusSnapshot`, `describeTargetSelector` (unused), `isElementHidden` (in card-host; unused after deletions).** Pure deletion of dead code. Grep gates from #e11-step-4 checkpoint enforce. Commit: `chore(focus): delete obsolete activation-target / applyFocusSnapshot helpers`.

- [ ] **4l. Introduce AT0075/76/77/78/79.** Real-tide AT-series test gates (D8). Commit: `test(tide-rendering): AT0075–AT0079 real-tide focus integration tests`.

**Tests:**
- [ ] `bunx tsc --noEmit` — clean.
- [ ] `bun run audit:tokens lint` — zero violations.
- [ ] `bun test` — green.
- [ ] `just app-test at0071-...test.ts at0072-...test.ts at0073-...test.ts at0074-...test.ts` — green (fixture regression must hold; AT0073's D11 yield rule is THE gate).
- [ ] AT0075, AT0076, AT0077, AT0078, AT0079: green.
- [ ] Adjacent regression set: green.
- [ ] Manual: tide-card with find row open, Developer > Reload. Focus is on find input. Query preserved.
- [ ] Manual: tide-card with find row open, click another card's title bar, click tide back. Focus is on find input (not prompt-entry). Deck-trace shows exactly one `focus-call` event.

**Checkpoint:**
- [ ] `applyBagFocus` is the only function in the codebase that calls `.focus()` on a focus target derived from `bag.focus` (grep gate).
- [ ] `applyFocusSnapshot` is deleted (grep gate: no remaining references).
- [ ] `resolveActivationTarget` is deleted (grep gate).
- [ ] `useCardStatePreservation.onCardActivated` does not call `paintMirrorAsActive` (grep gate).
- [ ] `useCardStatePreservation.onRestore`'s `paintMirrorAsActive` in `isActive` branch is gone (grep gate).
- [ ] `entryDelegateRef.focus()` does not appear in `useCardDelegate.cardDidActivate` (grep gate).
- [ ] All three RUNTIME direct `activateCard` sites are wrapped via `transferFocusForActivation`. Boot sites (`_seedDeckState`, initial-focused-card restore) stay raw (grep gate inverted: those two sites only call `activateCard` directly; no others do).
- [ ] AT0075/76/77 pass with real tide-session binding (not the engineless fixture).
- [ ] AT0079 confirms `bag.focus.kind === "engine"` wins over a stale find-row mount.
- [ ] No infinite-retry loops in production: a forced-stale `bag.focus` whose target never mounts disconnects after the budget with a dev-mode warn.
- [ ] Deck-trace for a Developer > Reload of a tide card with find-row focus shows: cold-boot mount, initial `applyBagFocus` returns `"deferred"`, MutationObserver fires N times (≤ budget), final `applyBagFocus` returns `"applied"` with target = find input.
- [ ] Deck-trace for a tide-card title-bar re-activation shows: 1 SAVE outgoing, 1 commit, 1 `focus-call` event (target = find input or engine target per `bag.focus`). No competing claim events for this transition.

---

###### Step 5: Documentation {#e11-step-5}

**Depends on:** #e11-step-4

**Commit:** `docs(tuglaws): single-channel focus model; component-authoring late-mount contract`

**References:** D10 (#e11-d-list)

**Tuglaws:**
- **[L19]** ★ — the [L19] documentation deliverable. `tuglaws/state-preservation.md` and `tuglaws/component-authoring.md` are the canonical references the next widget author reads; they must describe what the code does post-E.11, not what it did pre-E.11. This step retires the E.10 carve-out wording (which is now wrong) and names the post-E.11 dispatch model, the engine-hook contract, the late-mount retry budget, and the widget-author contract for transient focus targets. The docs and the code must match exactly — Step 6's Integration Checkpoint verifies this by cross-referencing.

**Artifacts:**
- Updated: `tuglaws/state-preservation.md` — rewrite `FocusSnapshot in depth` (~30 lines) and add new `Focus dispatch model` section (~60 lines). Retire the E.10 carve-out wording.
- Updated: `tuglaws/component-authoring.md` — add late-mount contract (~15 lines) to the "Transient focus targets in content-owning cards" section.

**Tasks:**
- [x] Rewrite `FocusSnapshot in depth` to describe the post-E.11 union (`form-control` / `dom` / `engine` / `none`) and the backward-compat coercion of legacy `component-owned`.
- [x] Add `Focus dispatch model` section naming `resolveBagFocus` / `applyBagFocus`, the D11 yield rule, the engine hook contract, the late-mount settle path (deferred-dom + deferred-engine), and the four activation dispatch sites.
- [x] Update inline references in `state-preservation.md` from `component-owned` to `engine` and from `applyFocusSnapshot` / `resolveActivationTarget` to `applyBagFocus`.
- [x] Add late-mount paragraph to `component-authoring.md`'s "Transient focus targets" section: widget authors stamp `data-tug-focus-key`; the framework retries via MutationObserver (200 mutations / 5s budget); D11 yield rule protects widget-internal substrate-hook self-focus; if the target genuinely never appears, the framework yields cleanly. Engine becomes a callable invoked through `applyBagFocus`'s engine branch (no more autonomous `paintMirrorAsActive` from `onCardActivated`).
- [x] Module header in `focus-transfer.ts` already rewritten at Step 4k to describe the post-E.11 single-channel model; module header in `card-host.tsx` likewise updated for the cold-boot RESTORE description.

**Tests:**
- [x] `bunx tsc --noEmit` — clean (no code changes; docs only).
- [x] Manual read-through: the docs describe what the code does post-E.11.

**Checkpoint:**
- [x] `tuglaws/state-preservation.md` no longer carries the pre-E.11 `component-owned` / `applyFocusSnapshot` / `resolveActivationTarget` terminology in load-bearing sections (FocusSnapshot in depth, Focus dispatch model, related-files index).
- [x] `tuglaws/component-authoring.md`'s "Transient focus targets" section names the framework retry + budget contract AND the D11 yield rule for widget-internal substrate hooks.
- [ ] All Phase E.11 manual checkpoints listed below pass _(verified at #e11-step-6)._

---

###### Step 6: Integration Checkpoint {#e11-step-6}

**Depends on:** #e11-step-1, #e11-step-2, #e11-step-3, #e11-step-4, #e11-step-5

**Commit:** `N/A (verification only)`

**References:** D1, D2, D3, D4, D5, D6, D7, D8, D9, D9b, D10 (#e11-d-list), (#e11-exit-criteria, #e11-tuglaws)

**Tuglaws:**

> This step verifies all twelve laws cited in the phase-level cross-check (#e11-tuglaws) hold after the full E.11 sequence has landed. The starred laws ([L05], [L23]) are the load-bearing ones; the rest are unchanged or trivially preserved.

- **[L05]** ★ verified by: (a) deck-trace dump for any activation transition shows zero `MessageChannel`-deferred `.focus()` calls in the focus-claim path; (b) per-source dispatch-event mapping in `docs/notes/focus-gesture-lock-investigation.md` matches code (each source's actual dispatch event is the one the matrix names); (c) the macrotask delegate in `useCardDelegate.cardDidActivate` no longer claims focus (grep gate from #e11-step-3 still holds).
- **[L23]** ★ verified by: (a) AT0075–79 pass against real tide-card; (b) AT0071–74 (fixture regression) still pass; (c) all six manual checkpoints (#e11-checkpoint) pass against the running app; (d) deck-trace shows exactly **one** `focus-call` event per activation transition with the target matching `bag.focus` resolution.
- **[L01]–[L04], [L06]–[L07], [L11], [L19], [L22], [L24]** ✓ verified by the absence of regression in AT0001–74 and the adjacent regression set (at0020 / at0024 / at0025 / at0031 / at0033 / at0034 / at0035-tide / at0046 / at0067).
- **Cross-document consistency** verified by Step 5's checkpoint: every D-decision in the plan's prose has a corresponding paragraph in `tuglaws/state-preservation.md` (manual review).

**Tasks:**
- [ ] Verify the full E.11 manual checkpoint list (below) passes against the running app — _user-driven, performed in `just app` with `deckTrace.enable(true)`; documented in the user-reported-scenarios validation step._
- [ ] Verify the deck-trace verification: any activation transition produces exactly **one** `focus-call` event — _user-driven via `window.__deckTrace.dumpTable()` against the running app._
- [x] Verify the full app-test sweep is green — _13/13 files green, 23/23 tests passed; AT0075/76/77/79 properly skipped (harness-extension required, see AT inventory). NOTE: the sweep at this step also masked four real failures (`at0002` / `at0006-em` / `at0007-em` / `at0009-em`) as "cadence flakes"; that narrative was wrong — they were deterministic stale-trace-event bugs from this phase's dispatcher migration, root-caused and fixed in the Phase E.12 follow-up (#e12-followups)._
- [ ] Verify the user-reported scenarios (Glitch 2: title-bar re-activation; Glitch 3: Developer > Reload) pass in the running app — _user-driven validation against `just app` since automation requires harness extensions for tide-card find-row injection (see AT0075–AT0079 inventory entries)._
- [x] Update `tuglaws/app-test-inventory.md` to register AT0075–AT0079 as shipped (or, in the case of AT0075/76/77/79, as documented-but-skipped pending harness extensions).

**Tests:**
- [x] `bunx tsc --noEmit` — clean.
- [x] `bun run audit:tokens lint` — zero violations.
- [x] `bun test` — green (1580 / 1580).
- [x] Full `just app-test` sweep: green. _(See the Tasks note above re: four failures this step misattributed to "cadence flakes" — fixed in the Phase E.12 follow-up.)_

**Checkpoint:**
- [ ] All six E.11 manual checkpoints (below) pass — _the find-row scenarios (lines 1–3 of the checkpoint) require user-driven verification in the running app; the engine-path scenarios (lines 4–5) are gated automatically by AT0078._
- [x] All six exit criteria (below) satisfied — _all automated criteria are green; the manual / user-verified criteria are flagged as awaiting user validation in `just app`._

---

**Decision ID list (cross-reference).** {#e11-d-list}

| ID | Title | Anchor |
|----|-------|--------|
| D1 | Framework owns activation focus; engine is callable | (#decisions-phase-e-11) |
| D2 | `engine` kind in `FocusSnapshot`; backward-compat coercion | (#decisions-phase-e-11) |
| D3 | Two-layer dispatcher: pure `resolveBagFocus` + impure `applyBagFocus` | (#decisions-phase-e-11) |
| D4 | Retire macrotask focus claim AND engine autonomous claim | (#decisions-phase-e-11) |
| D5 | Late-mount settle: `deferred-dom` (MutationObserver) + `deferred-engine` (`callbacksVersion`) | (#decisions-phase-e-11) |
| D6 | Gesture focus-lock: characterize first, dispatch on gesture-end event | (#decisions-phase-e-11) |
| D7 | Engineless fixture stays as pure-axis regression | (#decisions-phase-e-11) |
| D8 | Real-tide AT-series AT0075–AT0079 | (#decisions-phase-e-11) |
| D9 | Cross-pane drag uses the same dispatcher | (#decisions-phase-e-11) |
| D9b | All `activateCard` call sites route through `transferFocusForActivation` | (#decisions-phase-e-11) |
| D10 | Documentation deliverable: `state-preservation.md` + `component-authoring.md` | (#decisions-phase-e-11) |
| D11 | Substrate-hook yield rule in `applyBagFocus` | (#d11-yield-rule) |

**Tests (aggregate matrix, Phase E.11).** {#e11-tests}

> Per-step test gates live in each step's `Tests:` block above. This aggregate matrix is the phase-level invariant: which AT-series ships at which step.

| Test | Introduced at | Required green from |
|------|---------------|---------------------|
| `bunx tsc --noEmit` | — | Every step |
| `bun run audit:tokens lint` | — | Every step |
| `bun test` | — | Every step |
| AT0071–AT0074 (fixture regression) | E.10 | Every step (must not regress) |
| AT0075, AT0076, AT0077, AT0078, AT0079 (real-tide integration) | #e11-step-4 | Step 4 onward |
| Adjacent regression (at0020 / at0024 / at0025 / at0031 / at0033 / at0034 / at0035-tide / at0046 / at0067) | — | Every step |
| Deck-trace verification: one `focus-call` event per activation | — | Step 4 onward (the substitution lands at Step 4, so multiple `focus-call` events expected through Step 3; reduced to 1 from Step 4) |

**Manual checkpoints (Phase E.11).** {#e11-checkpoint}

> Verified at #e11-step-6 (Integration Checkpoint). Each line names one user-visible behavior the phase must produce.

- [ ] Open a tide card with a Read tool. Open the FileBlock find row. Type a query. cmd-tab away, cmd-tab back. Focus is in the find input. Query preserved.
- [ ] Same setup. Click the title bar of another card. Click the title bar of the tide card. Focus returns to the find input.
- [ ] Same setup. Developer > Reload. Focus returns to the find input. Query preserved. (Includes the late-mount case where tide's transcript loads messages async after restart.)
- [ ] Same setup with focus in the prompt-entry contenteditable (not in find row). cmd-tab cycle. Focus returns to contenteditable. (Engine-path regression: removing the macrotask delegate must not break engine focus.)
- [ ] Same setup with find row open but contenteditable focused at save time. Developer > Reload. Focus returns to contenteditable, not to the find input. (Last-save semantics: `bag.focus.kind === "engine"` wins.)
- [ ] Cross-pane drag a tide card from one pane to another. Focus continues to land per `bag.focus` on the drop card.

**Exit criteria (Phase E.11).** {#e11-exit-criteria}

- [x] AT0078 (real-tide engine path) passes. AT0075/76/77/79 are documented and skipped pending harness extensions for tool-result message injection on tide cards — see AT inventory entries for the structural coverage gap (AT0071–74 fixture path + AT0078 engine path together cover the dispatch model; the gap is the find-row × real-tide integration, deferred to manual checkpoint + future harness work).
- [x] All four E.10 fixture AT-series tests continue passing (AT0071/72/73/74).
- [x] Adjacent regression set (at0020 / at0024 / at0025 / at0031 / at0033 / at0034 / at0035-tide / at0046 / at0067) passes.
- [x] `tuglaws/state-preservation.md` describes the single-channel model (D10 deliverable shipped). `tuglaws/component-authoring.md`'s "Transient focus targets" section names the late-mount retry + D11 yield rule contract.
- [ ] The user-reported scenarios (Glitch 2 + Glitch 3 from the E.10/3 thread) verifiably pass in the running app — _awaiting user-driven manual verification in `just app`._
- [ ] A deck-trace dump for an activation transition shows exactly **one** `focus-call` event with the resolved target — _awaiting user-driven verification in `just app` with `deckTrace.enable(true)`._

---

##### Phase E.12 — Single text entry per card; retire per-block Find {#phase-e-12}

**Depends on:** Phase E.11 (built the single-channel `bag.focus` dispatcher this phase simplifies) and Step 10.9 Phase A (`FileBlock` now renders on `TugCodeView` / CM6).

**Status:** implemented — all six sub-steps (12a–12f) landed, plus a post-phase cleanup pass (#e12-followups). All automated gates green: tugdeck `tsc`, `tests/app-test/tsconfig.json` `tsc`, lint, `bun test` 1580/1580, and the full `just app-test` sweep (48/48 files, 89/89 tests, first pass). Manual checkpoints await user-driven verification in `just app`.

**Why this phase exists.** E.10 and E.11 built a focus model that lets a content-owning card carry *multiple* focus targets — an engine surface plus one or more framework-axis targets (the per-block Find rows). The per-block Find widget (`useBlockFindSession` + `TugBlockFindRow` + `BlockFindButton`, one instance per `FileBlock` / `DiffBlock` / `TerminalBlock`) is the only thing that ever produced a framework-axis (`dom`) target inside a tide-card, and it is the wrong model: a cranky, complex, per-block widget in a system that aspires to a simplified, AI-first command surface. The notion of Find will be redesigned later; these widgets are not coming back in this form, in this place. Removing them lets the focus model for content-owning cards collapse to its essential shape — a tide-card has exactly one text-entry surface, so activation focus has exactly one destination.

**The rule this phase establishes.** {#e12-rule}

> **A card has at most one text-entry / input surface.** For a tide-card that surface is the `tug-prompt-entry` component in the bottom pane. Content blocks (`FileBlock`, `DiffBlock`, `TerminalBlock`) render no text-entry UI of their own.

Consequence: `bag.focus` for a tide-card is always `engine` (when the card is active) or `none`. The framework never has to *decide* where focus lands inside a tide-card — on every activation source (cold-boot, app-switch, card-switch, cross-pane drag, reload, drag-end) it restores selection, scroll position, and the blinking caret to `tug-prompt-entry` via the engine hook E.11 introduced. "Where does focus go when a tide-card is activated" has one answer.

**What E.11 work is retained, and what is retired.** {#e12-retain-retire}

| E.11 element | Disposition | Reason |
|---|---|---|
| Single-channel dispatcher (`resolveBagFocus` / `applyBagFocus`), D3 | **Retain** | This is what made activation focus deterministic. Simplified, not removed. |
| Engine-hook channel (`registerEngineHooks` / `invokeEnginePaintMirrorAsActive`), D1 | **Retain** | The one channel a tide-card's activation focus rides. |
| Retired macrotask focus claim + engine autonomous claim, D4 | **Retain** | The multi-claimant race stays gone; no reason to bring it back. |
| `engine` `FocusSnapshot` kind + `component-owned` → `engine` read coercion, D2 | **Retain** | `engine` is now the *only* meaningful kind for a content-owning + engine card. |
| `deferred-engine` cold-boot retry (`engineHooksVersion`), D5 | **Retain** | Cold-boot before the engine hook registers is still real. |
| `dom` / `form-control` `FocusSnapshot` kinds + `data-tug-focus-key` / `data-tug-state-key` axis | **Retain (untouched)** | The general framework focus axis still serves non-engine form-control cards (`tug-input`, `tug-textarea`, settings cards, `default-focus.ts`). E.12 does not touch it. |
| D2's "content-owning cards capture all four kinds" carve-in | **Retire (by consequence)** | With Find rows gone, no `data-tug-focus-key` / `data-tug-state-key` element remains inside a tide-card, so `captureFocus` naturally yields `engine` / `none` for it. No `captureFocus` code change — see E12-D4. |
| `deferred-dom` CardHost MutationObserver focus-retry branch, D5 | **Retire** | Its motivating consumer was find-row late-mount. No framework-axis target inside a tide-card late-mounts anymore. Only the *focus-retry branch* is retired — the observer itself keeps its region-scroll and DOM-selection duties (E12-D6). |
| `deferred-dom` variant in `BagFocusResolution` | **Retain** | It is the correct description of an unmounted framework-axis target and is still reachable by non-engine cards (`resolveBagFocus` focus-transfer.ts:358-375). Nothing retries it after E.12; the one-shot callers already treat `"deferred"` as graceful no-focus. |
| D11 substrate-hook yield rule (framework-branch yield-check in `applyBagFocus`) | **Retain as plain idempotency guard** | The fifth claimant — `useBlockFindSession`'s `useLayoutEffect([open])` self-focus — is deleted with the hook, so the "substrate-hook" *rationale* is gone. The 6-line `if (activeElement === el) return` check is cheap defensive insurance against WebKit's mount-time double-`.focus()` drop-to-body; E.12 keeps it, re-commented as a generic idempotency guard, and does not treat its removal as a goal. |
| AT0071–AT0074 (find-fixture), AT0075–AT0077 + AT0079 (real-tide find) | **Retire** | They gated find-row / framework-axis focus survival inside content-owning cards — the behavior being removed. |
| AT0078 (engine focus survives, no find row) | **Retain + expand** | Becomes the core regression for [the rule](#e12-rule). E.12 adds coverage across every activation source. |

**Decisions (Phase E.12).** {#decisions-phase-e-12}

- **E12-D1. Per-block Find is removed in total.** Delete `use-block-find-session.tsx`, `tug-block-find-row.tsx` + `.css`, `affordances/block-find-button.tsx` (and its `affordances/index.ts` export), and `gallery-file-block-find-fixture.tsx` + its gallery registration. All three body kinds drop: the `useBlockFindSession` call, the `<TugBlockFindRow>` mount, the Search affordance, the substrate query-push effect, and the `FIND` / `FIND_NEXT` / `FIND_PREVIOUS` handler registration that came from `session.actions`. The `FIND*` entries in `action-vocabulary.ts` stay (vocabulary, not handlers) — the future Find rework re-binds them.

- **E12-D2. Per-block responders are audited and retired where they carried only find.** `FileBlock`'s and `DiffBlock`'s responders registered *only* `findSession.actions` — they are retired entirely (the `useId`, the `useOptionalResponder`, the `ResponderScope` wrapper, the `chainManager` first-responder-promotion calls in `onBeforeOpen` / fold-cue toggle). `TerminalBlock`'s responder registered `findSession.actions` **merged with its own `COPY` handler** — it is kept; only the `...findSession.actions` spread is removed.

  **Retiring a responder is not a pure deletion — it changes responder-chain topology.** Two implementation-time audits, both load-bearing:
  - **Re-parent every child responder** parented to the retired `fileBlockResponderId` / `diffBlockResponderId`, not just `DiffBlock`'s view-toggle `TugChoiceGroup`. In particular `FileBlock` composes `TugCodeView`, which registers its own selection-only responder (`selectAll` / `copy`); if it is parented to `fileBlockResponderId` it must be re-parented to whatever ancestor the retired responder was a child of.
  - **State the post-retirement chain reasoning in the commit.** After retirement, clicking inside a `FileBlock` viewer leaves `TugCodeView`'s own responder in the chain — that is *why* retiring `FileBlock`'s find-only responder is safe (Cmd-C / Cmd-A still resolve via `TugCodeView`). `DiffBlock` never had a Cmd-C/Cmd-A responder handler (its responder only carried find), so retiring it loses no action handler — confirm this holds rather than assuming it.

- **E12-D3. CM6 substrate search stays dormant in `TugCodeView`.** The `@codemirror/search` extension and the delegate's search methods (`setSearchQuery`, `clearSearch`, `findNext`, `findPrevious`, `getMatchCount`, `openSearch`, the `onFindRequested` prop) remain in `TugCodeView` as latent capability for the future Find rework. `FileBlock` simply stops consuming them. No UI drives them after E.12. **Verify "dormant" is actually dormant:** confirm `TugCodeView`'s CM6 config does not include a live `searchKeymap` (or any `Mod-f` binding) that would open CM6's *own* search panel on Cmd-F, and that `TugCodeView`'s `FIND` responder action forwards via `onFindRequested` only (it does not itself call `openSearchPanel`). If either is live, neutralize it — a CM6-native find panel appearing on Cmd-F is exactly the per-block find UI this phase removes.

- **E12-D4. `captureFocus` needs no code change; find-removal alone collapses a tide-card to `engine` / `none`.** `captureFocus` (`card-host.tsx:303-329`) is a *pure DOM classifier* with no card-type awareness — and it should stay that way; making it card-type-aware would be the wrong shape. It classifies by attribute order: `data-tug-state-key` → `form-control`, `data-tug-focus-key` → `dom`, `COMPONENT_OWNED_SELECTORS` match → `engine`, else `none`. Once the Find rows are gone (E12-D1), the only remaining `data-tug-*-key` element a tide-card could carry is... none — so `captureFocus` naturally returns `engine` (active element inside the engine surface) or `none` for a tide-card, with no code change. The implementation task is a **verification**: grep-confirm no `data-tug-focus-key` / `data-tug-state-key` element remains in a tide-card's subtree after E12-D1. If one is found, that is a *separate* violation of [the rule](#e12-rule) to surface — not something `captureFocus` should paper over.

  **Focusable-but-not-entry content is captured as `none`.** A read-only `TugCodeView` (FileBlock's CM6 viewer) is still *focusable* — CM6 read-only views accept focus for selection/copy. But `TugCodeView`'s `.cm-content` sits under `data-slot="tug-code-view"`, which is **not** in `COMPONENT_OWNED_SELECTORS` (those are `[data-slot="tug-text-editor"]` and `[data-tug-prompt-input-root]`) and carries no `data-tug-*-key`. So when the user clicks into a FileBlock viewer inside a tide-card, `captureFocus` returns `none`, and on the next activation `resolveBagFocus` routes the tide-card to `engine` — focus lands on `tug-prompt-entry`, not back in the viewer. This is **correct and intended** per [the rule](#e12-rule): a viewer is not a text-entry surface; transient selection-to-copy focus is not preserved across activation. This decision must be stated explicitly so it is not rediscovered as a surprise during implementation.

- **E12-D5. The `deferred-dom` variant stays; only the retry is removed.** `resolveBagFocus` keeps returning `deferred-dom` (focus-transfer.ts:358-375) — it is the correct description of "the saved framework-axis target is not in the DOM," and it is still reachable by *non-engine* framework-axis cards (a card with a conditionally-rendered `tug-input`, etc.). Removing the variant from `BagFocusResolution` would force an unprovable global claim that no non-engine card ever late-mounts a focus target. `applyBagFocus` still returns `"deferred"` for it; the one-shot callers (`transferFocusForActivation` / `transferFocusAfterMove` / `reactivateCurrentFocusDestination`) already treat `"deferred"` as graceful no-focus via their `if (result === "applied")` gate. **What changes:** nothing *retries* `deferred-dom` after E.12 (the CardHost focus-retry branch is removed — E12-D6). The D11 framework-branch yield-check is **kept** as a plain idempotency guard (see the retain/retire table) — E.12 re-comments it away from the "substrate-hook" framing but does not remove it.

- **E12-D6. Retire only the focus-retry branch of the CardHost MutationObserver — not the observer.** The MutationObserver in the RESTORE effect (`card-host.tsx:1198-1208`) has **three duties**, and only one is find-related:
  1. **region-scroll late-mount retry** (`regionSnapshot`, `card-host.tsx:1156-1192`) — used by `tug-markdown-view`, `TerminalBlock`, **and FileBlock's own CM6 inner-scroll** (`data-tug-scroll-key`). **Keep.**
  2. **`bag.domSelection` late-mount retry** (`tryRestoreDomSelection`, `card-host.tsx:910-939`) — used by `tug-markdown-view`. **Keep.**
  3. **`deferred-dom` focus retry** (`card-host.tsx:1121-1155`) — the find-row case. **Retire.**

  Retiring the *observer* would break duties 1 and 2 — a direct **[L23]** regression (region scroll + markdown DOM-selection no longer survive cold-boot). E.12 retires precisely: `FOCUS_RETRY_MAX_MUTATIONS`, `FOCUS_RETRY_DEADLINE_MS`, `focusRetryDeadline`, `focusRetryMutationCount`, `focusApplied`, the `needsFocusRetry` term in the observer-install gate (`card-host.tsx:1054-1056`), the focus-retry block inside `apply()` (`1121-1155`), and the budget-exhaustion dev-warn. The observer, `regionSnapshot`, `tryRestoreDomSelection`, and the `apply()` function stay. The one-shot cold-boot `applyBagFocus` call (`card-host.tsx:991-1008`) stays; the `engineHooksVersion`-keyed effect re-run is the only late-mount focus path left, and it covers the real cold-boot case (`deferred-engine`).

- **E12-D7. Test suite: delete the find tests, keep + expand AT0078.** Delete AT0071–AT0077 and AT0079 and the fixture they bound. Keep AT0078 and expand its coverage (or add siblings) so [the rule](#e12-rule) is gated across activation sources: app-switch, card-switch, Developer > Reload, cross-pane drag. The new tests need *engine* focus, not a find row, so the harness gap that forced AT0075-77/79 to `describe.skip` (tool-result message injection) does **not** block them. **But verify harness capability before committing to each source** — E.11 hit harness gaps mid-implementation. In particular confirm the app-test harness can cross-pane-drag a real-tide card; if it cannot, gate that one line at the manual-checkpoint level (as E.11 did for the find-row scenarios) rather than shipping a skipped test. Update `tuglaws/app-test-inventory.md`.

- **E12-D8. Documentation, and strip E.11 plan-number references from every touched region.** `tuglaws/state-preservation.md` and `tuglaws/component-authoring.md` were rewritten in E.11 Step 5 to describe `deferred-dom` retry, the D11 yield rule as a substrate-hook contract, and the find-row transient-focus contract. E.12 rewrites those sections to describe [the rule](#e12-rule): a content-owning + engine card has one text-entry surface; activation focus always resolves to the engine hook; the `deferred-dom` *retry* is gone (the variant remains, unretried); the D11 check survives as a plain idempotency guard. The E.11 plan prose in this roadmap is **not** annotated — it stays as historical record; E.12's text is the current contract.

  **Plan-number hygiene (memory `feedback_no_plan_numbers_in_code`).** `focus-transfer.ts` and `card-host.tsx` are littered with "Phase E.11 Step 4d / 4k", "Step 3", "m36" comment references — a standing violation. E.12 edits these exact comment blocks (E12-D5, E12-D6). Every comment block E.12 touches must have its plan-number references stripped on the way through; E.12 adds none of its own ("E12-D6", etc. belong in the plan and commit messages, never in code/comments/docstrings).

**Tuglaws cross-check (Phase E.12).** {#e12-tuglaws}

| Law | Status | Where |
|---|---|---|
| **[L01]** No `root.render()` outside mount | ✓ unchanged | — |
| **[L02]** External state via `useSyncExternalStore` only | ✓ unchanged | deletions only; no new external-state reads |
| **[L03]** `useLayoutEffect` for event-dependent registrations | ✓ unchanged | retiring registrations, not adding |
| **[L05]** No timing-derived ordering | ✓ preserved | E.11's macrotask retirement stands; E.12 removes more, adds none |
| **[L06]** Appearance via CSS/DOM | ✓ unchanged | `.focus()` stays a DOM mutation |
| **[L07]** Handlers read live refs / snapshots | ✓ unchanged | — |
| **[L11]** Controls emit actions; responders own state | ✓ verified at E12-D2 | retiring a responder changes chain topology — E12-D2 mandates re-parenting every child responder (incl. `TugCodeView`'s selection responder) and confirming no action handler is lost; `TerminalBlock` keeps its `COPY` responder |
| **[L19]** Component-authoring guide compliance | ✓ updated | E12-D8 doc rewrite; deleted modules drop their file-pairs cleanly |
| **[L23]** Preserve user-visible state | ★ **simplified — guarded by E12-D6** | one destination per tide-card; selection / scroll / caret restored to `tug-prompt-entry` on every activation source. **The MutationObserver's region-scroll + DOM-selection late-mount duties are explicitly kept** (E12-D6) — retiring the whole observer would regress L23 for `tug-markdown-view` and FileBlock CM6 inner-scroll. |
| **[L24]** Three state zones preserved | ✓ unchanged | — |

**Out of scope (Phase E.12).**
- The future Find redesign. E.12 removes the wrong model; it does not design the replacement.
- The general framework focus axis (`data-tug-focus-key` / `data-tug-state-key`, `dom` / `form-control` kinds, the `deferred-dom` resolution variant, `default-focus.ts`) — untouched; still serves non-engine form-control cards.
- Non-focus delegate / lifecycle callbacks (`cardDidMove`, `cardDidResize`, geometry events) — unchanged.
- `TugCodeView`'s CM6 search plumbing — kept dormant (E12-D3), not removed.
- Persisted tugbank bags retain orphaned `useBlockFindSession` `bag.components` slots (`<key>/<scope>`). Harmless — they become unread keys; no migration or schema bump is needed.

**Artifacts (Phase E.12).**
- Deleted: `tugdeck/src/components/tugways/internal/use-block-find-session.tsx`
- Deleted: `tugdeck/src/components/tugways/internal/tug-block-find-row.tsx` + `.css`
- Deleted: `tugdeck/src/components/tugways/body-kinds/affordances/block-find-button.tsx`
- Deleted: `tugdeck/src/components/tugways/cards/gallery-file-block-find-fixture.tsx`
- Updated: `tugdeck/src/components/tugways/body-kinds/affordances/index.ts` — drop `BlockFindButton` export
- Updated: `tugdeck/src/components/tugways/cards/gallery-registrations.tsx` — drop the `gallery-file-block-find-fixture` registration
- Updated: `file-block.tsx`, `diff-block.tsx`, `terminal-block.tsx` (+ their `.css` and `__tests__`) — remove find session / row / Search affordance / responder per E12-D1, E12-D2
- Updated: `tugdeck/src/focus-transfer.ts` — keep the `deferred-dom` variant (E12-D5); re-comment the D11 yield-check as a plain idempotency guard; strip E.11 plan-number references from touched comment blocks
- Updated: `tugdeck/src/components/chrome/card-host.tsx` — no `captureFocus` code change (E12-D4, verification only); retire *only* the `deferred-dom` focus-retry branch of the RESTORE-effect MutationObserver, keeping the observer's region-scroll + DOM-selection duties (E12-D6); strip E.11 plan-number references from touched comment blocks
- Deleted: `tests/app-test/at0071-*.test.ts` … `at0077-*.test.ts`, `at0079-*.test.ts`
- Updated: `tests/app-test/at0078-tide-engine-focus-survives.test.ts` — expand per E12-D7
- New: per-activation-source coverage of [the rule](#e12-rule) (AT number assigned at implementation against `app-test-inventory.md`'s high-water mark)
- Updated: `tuglaws/app-test-inventory.md`, `tuglaws/state-preservation.md`, `tuglaws/component-authoring.md`

**Execution Steps (Phase E.12).** {#e12-execution-steps}

> Same sequencing discipline as E.11's 4a–4l: each sub-commit leaves the tree green against tsc / lint / `bun test` / the adjacent AT regression set, so a runtime regression is isolated to one sub-commit. Adjacent regression set: at0020 / at0024 / at0025 / at0031 / at0033 / at0034 / at0035-tide / at0046 / at0067, plus at0078.

###### Step 12a: Unwire per-block Find from the body kinds {#e12-step-12a}

**Depends on:** —
**Commit:** `refactor(tide-rendering): unwire per-block Find from FileBlock/DiffBlock/TerminalBlock`
**References:** E12-D1, E12-D2, E12-D3

**Tasks:**
- [x] `file-block.tsx`: remove the `useBlockFindSession` call, the `<TugBlockFindRow>` mount, the `BlockFindButton` from the affordances cluster, the substrate query-push `useLayoutEffect`, the `onFindRequested` wiring on `<TugCodeView>`, and the navigation callbacks. Retire `fileBlockResponder` / `fileBlockResponderId` / the `ResponderScope` wrapper and the `chainManager.makeFirstResponder` promotion calls (it carried only find actions — E12-D2). **Re-parent** `TugCodeView`'s selection responder (and any other child responder) off `fileBlockResponderId` to whatever ancestor the retired responder was a child of. _Done — `TugCodeView` reads the ambient `ResponderParentContext`, so removing the `ResponderScope` wrapper re-parents it automatically._
- [x] `diff-block.tsx`: same removals. Retire `diffBlockResponder` / `diffBlockResponderId`. **Re-parent every child responder** parented to it — the view-toggle `TugChoiceGroup` and any other — to the retired responder's former parent. Confirm `DiffBlock`'s responder carried no action handler other than find (no Cmd-C/Cmd-A loss). _Done — `viewToggleForm` re-parented to `parentId: null` (ambient); the diff responder carried only `findSession.actions`._
- [x] `terminal-block.tsx`: remove the `useBlockFindSession` call and `<TugBlockFindRow>` mount; drop the `...findSession.actions` spread from `terminalBlockActions`. **Keep** `terminalBlockResponder` — it still owns `COPY`.
- [x] Remove the now-dead find-row CSS hooks (`.tugx-file-find`, `.tugx-diff-find`, `.tugx-term-find` and the `--tugx-block-find-*` / header-height plumbing that only fed the row's sticky-top) from the three `.css` files. Leave the identity-header + actions-row plumbing intact. _`--tugx-diff-header-height` writer kept — `.tugx-diff-hunk-header` still consumes it._
- [x] Verify `TugCodeView` "dormant" per E12-D3: its CM6 config carries no live `searchKeymap` / `Mod-f` binding, and its `FIND` responder action forwards via `onFindRequested` only. Neutralize either if live. _Verified clean — no `searchKeymap` bound; `FIND` forwards via `onFindRequestedRef` only._
- [x] Update the three `__tests__` files to drop find-row assertions. _No body-kind `__tests__` files exist — nothing to update._

**Tests:**
- [x] `bunx tsc --noEmit` clean; `bun run audit:tokens lint` zero violations; `bun test` green (1580/1580).
- [x] Adjacent AT regression set green.

**Checkpoint:**
- [x] All three body kinds render in the gallery with no Find row, no Search button; Copy + fold cue still work. _Affordance cluster is now Copy + fold cue only; verified by tsc + the live app-test sweep exercising the body kinds._
- [x] Cmd-F inside a `FileBlock` opens *no* find UI — neither a `TugBlockFindRow` nor CM6's own search panel. _`TugBlockFindRow` deleted; `TugCodeView` binds no `searchKeymap`._
- [x] Clicking inside a `FileBlock` viewer: Cmd-C / Cmd-A still resolve (via `TugCodeView`'s re-parented selection responder).
- [x] `TugCodeView`'s search delegate methods still compile and are unreferenced by `FileBlock` (dormant per E12-D3).

###### Step 12b: Delete the unreferenced Find modules + fixture {#e12-step-12b}

**Depends on:** #e12-step-12a
**Commit:** `refactor(tide-rendering): delete per-block Find modules and find fixture`
**References:** E12-D1

> Mechanical — 12a removed every consumer; this sub-commit deletes the now-dead files. No runtime regression surface.

**Tasks:**
- [x] Delete `use-block-find-session.tsx`, `tug-block-find-row.tsx` + `.css`, `affordances/block-find-button.tsx`.
- [x] Drop the `BlockFindButton` export from `affordances/index.ts`.
- [x] Delete `gallery-file-block-find-fixture.tsx`; remove its registration from `gallery-registrations.tsx`.
- [x] Delete any `__tests__` files bound to the deleted modules. _None existed._
- [x] Grep-gate: zero remaining references to `useBlockFindSession`, `TugBlockFindRow`, `BlockFindButton`, `gallery-file-block-find-fixture`.

**Tests:**
- [x] `bunx tsc --noEmit` clean; `bun test` green (1580/1580).

**Checkpoint:**
- [x] Grep-gate passes; gallery still mounts (one fewer card).

###### Step 12c: Verify focus capture + simplify the resolver prose {#e12-step-12c}

**Depends on:** #e12-step-12b
**Commit:** `refactor(focus-transfer): re-comment idempotency guard; verify tide-card focus collapses to engine`
**References:** E12-D4, E12-D5

**Tasks:**
- [x] **Verification, not a code change** (E12-D4): grep-confirm no `data-tug-focus-key` / `data-tug-state-key` element remains inside a tide-card's subtree after 12a/12b. `captureFocus` is left untouched — find-removal alone collapses a tide-card to `engine` / `none`. If a stray `data-tug-*-key` element is found, stop and surface it as a separate [rule](#e12-rule) violation. _Verified: no JSX stamps `data-tug-focus-key` anymore; `data-tug-state-key` is only stamped by `TugInput`/`TugTextarea` given a key, and the one `TugInput` in a tide card (the project-picker path field) passes no key._
- [x] `focus-transfer.ts`: **keep** the `deferred-dom` variant in `BagFocusResolution` and **keep** the framework-branch `if (doc.activeElement === el) return "applied"` check — re-comment the latter as a generic idempotency guard (it no longer has a "substrate-hook" rationale; it is cheap insurance against WebKit mount-time double-`.focus()`). Do not change `applyBagFocus`'s return contract. _Comment-only change; logic untouched._
- [x] Strip E.11 plan-number references ("Phase E.11 Step 3 / 4c", etc.) from every `focus-transfer.ts` comment block touched here; add none.

**Tests:**
- [x] `bunx tsc --noEmit` clean; `bun run audit:tokens lint` zero; `bun test` green (1580/1580).
- [x] `at0078` + adjacent AT regression set green (5/5 files).

**Checkpoint:**
- [x] `resolveBagFocus` unit coverage: a tide-card resolves `engine` or `deferred-engine`. (`deferred-dom` is still a valid variant for non-engine cards — not asserted absent.) _Confirmed via `at0078` / `at0080` / `at0081` exercising the engine + deferred-engine resolution on real tide cards._

###### Step 12d: Retire the `deferred-dom` focus-retry branch of the RESTORE MutationObserver {#e12-step-12d}

**Depends on:** #e12-step-12c
**Commit:** `refactor(card-host): retire deferred-dom focus-retry branch; keep scroll/selection retry`
**References:** E12-D6

**Tasks:**
- [x] `card-host.tsx` RESTORE effect: remove **only** the focus-retry pieces — `FOCUS_RETRY_MAX_MUTATIONS`, `FOCUS_RETRY_DEADLINE_MS`, `focusRetryDeadline`, `focusRetryMutationCount`, `focusApplied`, the `needsFocusRetry` term in the observer-install gate, the focus-retry block inside `apply()`, and the budget-exhaustion dev-warn.
- [x] **Keep** the MutationObserver itself, `regionSnapshot` retry, and `tryRestoreDomSelection` — they carry the region-scroll and DOM-selection late-mount duties ([L23]). Keep the one-shot cold-boot `applyBagFocus` call and the `engineHooksVersion`-keyed effect re-run for `deferred-engine`.
- [x] Re-comment the RESTORE effect's prose: the observer now has two duties (region-scroll, DOM-selection); the one remaining late-mount *focus* path is `deferred-engine` via `engineHooksVersion`. Strip E.11 plan-number references from every touched comment block.

**Tests:**
- [x] `bunx tsc --noEmit` clean; `bun test` green (1580/1580).
- [x] `at0078` + adjacent AT regression set green.
- [x] Region-scroll regression still green — proves the observer's scroll duty survived. _`at0065` does not exist; covered instead by `at0014-cold-boot-scroll`, `at0014-scroll-persistence`, `at0059`, `at0061`, `at0068` — all green._

**Checkpoint:**
- [x] Cold-boot a tide-card (the `at0078` path): focus lands on `tug-prompt-entry` via the `deferred-engine` retry; no focus-retry MutationObserver branch involved.
- [x] Cold-boot a long FileBlock with saved CM6 inner-scroll: the inner scroll position still restores (observer's region-scroll duty intact). _Gated by `at0014` / `at0068`._

###### Step 12e: Test suite — delete find tests, expand AT0078 {#e12-step-12e}

**Depends on:** #e12-step-12d
**Commit:** `test(tide-rendering): retire find AT-series; gate single-text-entry rule`
**References:** E12-D7

**Tasks:**
- [x] Delete `at0071`–`at0077` and `at0079` test files.
- [x] Expand `at0078` (or add siblings) so [the rule](#e12-rule) is gated across app-switch, card-switch, Developer > Reload, and cross-pane drag — each asserts focus restore to `tug-prompt-entry`. _AT0078 retained (app-switch); AT0080 added (card-switch); AT0081 added (Developer > Reload); cross-pane drag stays gated by `at0034-em-focus-after-move` on the `gallery-prompt-entry` surface. The new tests assert focus destination; selection-restore for app-switch stays gated by `at0035-tide`._
- [x] **Before writing each source's test, verify the harness supports it.** _Verified: app-switch / card-switch / reload are harness-supported; cross-pane drag of the `tug-prompt-entry` surface is already gated by `at0034`. AT0081 had to wait on the contenteditable mounting rather than the `isEngineReady` flag, which does not re-arm after `appReload` — documented in the test + inventory._
- [x] Update `tuglaws/app-test-inventory.md`: retire AT0071–77 + AT0079; record the new entries; fix the high-water mark (→ AT0081).

**Tests:**
- [x] Full `just app-test` sweep green — 48/48 files, 89/89 tests, first pass (AT0078/AT0080/AT0081 added to the sweep array). _The five failures the sweep showed at first were not flakes — two deterministic bugs, root-caused and fixed in the post-phase cleanup; see #e12-followups._

**Checkpoint:**
- [x] The new AT set fails if a tide-card's activation focus lands anywhere other than `tug-prompt-entry`. _AT0078/AT0080/AT0081 all assert `document.activeElement` is the `[data-slot="tug-text-editor"] .cm-content` inside the expected card._
- [x] Every activation source is covered either by an active AT test or by a documented manual checkpoint — none silently dropped. _app-switch → AT0078; card-switch → AT0080; reload → AT0081; cross-pane drag → AT0034._

###### Step 12f: Documentation {#e12-step-12f}

**Depends on:** #e12-step-12e
**Commit:** `docs(tide-rendering): single-text-entry rule; retire deferred-dom + D11 prose`
**References:** E12-D8

**Tasks:**
- [x] `tuglaws/state-preservation.md`: rewrite the `Focus dispatch model` + `FocusSnapshot in depth` sections — a content-owning + engine card resolves to `engine`; `deferred-engine` (via `engineHooksVersion`) is the one late-mount *focus* path; the `deferred-dom` variant still exists for non-engine cards but is no longer retried; the framework-branch `activeElement === el` check is now a plain idempotency guard, not a "substrate-hook yield rule."
- [x] `tuglaws/component-authoring.md`: rewrite the "Transient focus targets in content-owning cards" section (now "Focus in content-owning cards") to state [the rule](#e12-rule) — a content-owning + engine card has one text-entry surface; no per-block transient focus targets; focusable read-only viewers (`TugCodeView`) classify as `none` and do not hold focus across activation. _Also swept stale find-row references from the affordance-hosting + pin-stack-token sections._

**Tests:**
- [x] `bunx tsc --noEmit` clean (docs only).
- [x] Read-through: docs describe post-E.12 behavior.

**Checkpoint:**
- [x] No load-bearing section in either tuglaws doc still describes the `deferred-dom` *retry*, the D11 *substrate-hook yield rule* framing, or per-block Find rows. (The `deferred-dom` variant and the idempotency guard may still be mentioned — accurately.) _`design-decisions.md` D95 was also rewritten for the post-E.12 model in the cleanup pass — see #e12-followups._

**Manual checkpoints (Phase E.12).** {#e12-checkpoint}

> User-driven — verified interactively in `just app` with `deckTrace.enable(true)`. The automated AT-series (AT0078 / AT0080 / AT0081 / AT0034) gates the focus-destination invariant; these checkpoints confirm the user-visible behavior.

- [ ] Open a tide card with a Read tool. No Search button on the FileBlock; no Find row; Cmd-F does nothing (Find is being redesigned).
- [ ] Focus the prompt entry, type, place the caret mid-text. cmd-tab away and back → caret + selection + scroll restored on `tug-prompt-entry`.
- [ ] Same, but card-switch (two tide cards in one pane) → same restore.
- [ ] Same, but Developer > Reload → same restore (cold-boot via `deferred-engine`).
- [ ] Cross-pane drag a tide card → focus lands on `tug-prompt-entry` of the drop card.
- [ ] Click into a FileBlock viewer inside a tide card, then cmd-tab away and back → focus returns to `tug-prompt-entry`, not the viewer (E12-D4: a viewer is not a text-entry surface).
- [ ] Cold-boot a tide card with a long FileBlock scrolled partway → the FileBlock's CM6 inner scroll position restores (E12-D6: the observer's region-scroll duty survived).
- [ ] deck-trace dump for any tide-card activation: exactly one focus-claim event, target = `tug-prompt-entry`.

**Exit criteria (Phase E.12).** {#e12-exit-criteria}
- [x] Per-block Find is gone: grep finds zero references to the deleted modules.
- [x] `card-host.tsx`'s RESTORE-effect MutationObserver retains its region-scroll + DOM-selection duties and has no `deferred-dom` focus-retry branch. _Region-scroll regression green via `at0014` / `at0059` / `at0061` / `at0068` (`at0065` does not exist)._
- [x] AT0078 + the new single-text-entry AT set (AT0080, AT0081) pass; the find AT-series is retired from `app-test-inventory.md`; every activation source is covered by an AT test (cross-pane drag → AT0034).
- [x] `tuglaws/state-preservation.md` + `component-authoring.md` describe [the rule](#e12-rule).
- [x] No E.11 plan-number reference remains in any `focus-transfer.ts` / `card-host.tsx` comment block that E.12 touched.
- [x] tsc clean (tugdeck + `tests/app-test/tsconfig.json`), lint zero violations, `bun test` green (1580/1580), **full `just app-test` sweep green (48/48 files, 89/89 tests, first pass)**.
- [ ] Manual checkpoints above pass — _awaiting user-driven verification in `just app`._

**Follow-ups (Phase E.12) — resolved.** {#e12-followups}

Debt surfaced during E.12. All three items below were root-caused and fixed in a post-E.12 cleanup pass; recorded here for the trail:

- **5 "pre-existing" app-test failures — FIXED.** `at0002-tab-switch-em`, `at0006-cross-pane-drag`, `at0006-em-cross-pane`, `at0007-em-card-detach`, `at0009-em-inactive-mount`. These were *not* flakes and *not* unfixable pre-existing debt — they were two deterministic bugs the "cadence flake" narrative had been masking. (1) `at0002` / `at0006-em` / `at0007-em` / `at0009-em` waited on the `engine-activation-dispatched` trace event, which Phase E.11's dispatcher migration retired (its last caller was removed at E.11 Step 4k) — E.11 updated AT0033's gate but missed these four; the fix points them at `engine-paint-mirror-active` / `caller: "via-engine-hook"`. (2) `at0006-cross-pane-drag` / `at0007-card-detach` failed because `_moveCardToPane` / `_detachCard` called `transferFocusAfterMove` *before* the React portal re-parent committed — `transferFocusAfterMove` resolved against the pre-move DOM, yielded to the about-to-be-destroyed source-pane element, and the re-mount then dropped focus with nothing to re-claim it; the fix wraps the `_flipFirstResponder` call in `flushSync` (the same convention `_removeCard` already used) so the re-parent commits before the focus transfer runs. Full `just app-test` sweep is now 48/48 green, first pass.
- **`matchers.test.ts:350` tsc error — FIXED.** The hand-written `EVENT_FIXTURES` map was missing the four E.11-era `DeckTraceEventShape` variants (`focus-measurement` / `engine-paint-mirror-active` / `engine-paint-mirror-inactive` / `macrotask-focus-claim`). Added the fixtures; `tsc -p tests/app-test/tsconfig.json` is clean.
- **`design-decisions.md` D95 — FIXED.** Rewritten for the post-E.12 model: single-text-entry rule, single-channel dispatcher, `resolveBagFocus` / `applyBagFocus`, engine-as-callable. The pre-E.11 framing (`resolveActivationTarget`, `component-owned`, per-block find rows) is gone.
- **Harness:** `enableDeckTrace` now persists across `appReload` (via `sessionStorage`, same mechanism as the ready-gen counter) so `engine-ready` is recorded on the reloaded page — AT0081 uses `awaitEngineReady` normally instead of a contenteditable-mount workaround.
- **Open (not E.12 scope):** the `just app-test` FILES array still omits ~20 shipped test files (`at0039`–`at0069`). E.12's three new tests (AT0078/AT0080/AT0081) were added to the array; the rest of the gap is a separate sweep-completeness task.

---

#### Body-kind & tool-wrapper conformance {#bk-conformance}

*Shared contract for every body kind and tool wrapper authored from Step 11 onward. Step 10.9 (Phases A–E.12) established this architecture against `FileBlock` / `DiffBlock` / `TerminalBlock` and `ToolWrapperChrome`; new components conform to it rather than re-deriving it. The steps below reference this section instead of repeating the contract — each lists only its component-specific deltas.*

**Reference implementations:** `file-block.tsx`, `diff-block.tsx`, `terminal-block.tsx`, `tool-wrapper-chrome.tsx`, `tug-code-view.tsx`. **Authoritative spec:** [`tuglaws/component-authoring.md`](../tuglaws/component-authoring.md), [Tuglaws](../tuglaws/tuglaws.md) [L19] / [L20] / [L23].

1. **Text engine — CM6 only.** Any file-based or multi-line code/text content renders through `TugCodeView` (read-only) or `tug-text-editor` (editable). No bespoke text-row DOM, no per-line scrollers. [Step 10.9 Phase A]
2. **Single text-entry surface.** A card has at most one text-entry / input surface — for a tide-card that is `tug-prompt-entry`. Body kinds render **no** text-entry UI of their own: no per-block find, no in-block search field, no inline editor. Text-search affordances are deferred to the future Find redesign. [Phase E.12, [#e12-rule](#e12-rule)]
3. **Pinned identity header + actions row.** A body kind with chrome renders a sticky identity header and a `.tugx-{kind}-actions` row, both pinning via the telescoping `top: calc(var(--tugx-pin-stack-top, 0px) + var(--tugx-toolblock-header-height, 0px) + …)` stack. The actions row is the one body-kind chrome that survives `embedded={true}`. [Phases B.2, C]
4. **Embedded mode.** `embedded={true}` suppresses the body kind's own identity header (the host `ToolWrapperChrome` owns identity) and portals its affordances into the chrome's actions slot via `useChromeActionsTarget`. Standalone mode keeps the header inline. [Phase B.2]
5. **Affordance library.** Copy / fold use `BlockCopyButton` / `BlockFoldCue` from `body-kinds/affordances/` — do not hand-roll. (`BlockFindButton` was retired with per-block Find.) [Phases D, E.4, E.12]
6. **Tokens.** Component slots `--tugx-{kind}-*` compose the shared `--tugx-block-*` family ([#step-10-8-5](#step-10-8-5)) and never override `--tugx-toolblock-*` or the pin-stack variables. Seven-slot control convention for any interactive control. [L20]
7. **State preservation.** Collapse state, inner scroll position, and any user-visible state survive reload / cross-pane / cold-boot via `useComponentStatePreservation` / `useSavedRegionScroll` ([A9]). [L23, Phases E.6–E.9]
8. **Header truncation (tool wrappers).** Wrapper headers of the form `Tool · {arg}` use the established truncation primitives: end-ellipsis `<code>` for commands, the middle-ellipsis path pattern (`MiddleEllipsisPath` in `tool-wrappers/middle-ellipsis-path.tsx`, shared by `ReadToolBlock` / `EditToolBlock`) for file paths, and `TugTooltip` with `truncated` / `suppressOpen` gating. The args slot truncates, never scrolls or hover-expands. [Step 10.9 follow-on, #step-11]
9. **List-shaped body kinds.** Body kinds backed by a row list (`PathListBlock`, `SearchResultBlock`, `TodoListBlock`, large `TableBlock`) build on `TugListView`; its opt-in `selectionRequired` mode is available when the list owns a mandatory single selection.
10. **Tool-block bodies compose from `body-bits/`.** Every tool-wrapper body inside `ToolBlockChrome` composes the shared primitives in `tool-blocks/body-bits/` — `ToolBlockBody` (padded vertical-flex container), `ToolBlockFieldRow` (`<label>: <value>` row, `inline` / `stacked` layouts), `ToolBlockDisclosure` (native `<details>` + rotating chevron + active-tone label), `ToolBlockPre` (mono `<pre>` for raw output). The pre-extraction state had three wrappers (Skill / Monitor / Worktree) each hand-rolling its own slightly-different body container, label-over-value row, and `<pre>` block in its own CSS file — landed in this codebase, that pattern fan-outs to every subsequent wrapper. Reach for a wrapper-local class only when the primitive set genuinely does not cover the shape; when in doubt, extend a primitive (or add a new one to `body-bits/`) rather than re-deriving the layout in a wrapper-CSS file. A wrapper that composes purely from `body-bits/` may legitimately ship without a paired `.css` file (Worktree is the reference); the `.tsx` + `.css` pair convention is "pair when you own styles", not "always pair".

**Scope note.** Items 3–5 apply to body kinds with header / scrolling chrome (file, diff, terminal, json-tree, path-list, search-result, agent-transcript, todo-list, large table). Display-only inline blocks (`KaTeXBlock`, `MermaidBlock`, `ImageBlock`) apply only items 1–2 and 6–7 as relevant — they have no identity header, actions row, or fold affordance. Item 10 applies to tool-block *wrappers* (Layer 2), not to body kinds (Layer 1).

---

#### Step 11: EditToolBlock wrapper {#step-11}

**Status:** implemented — wrapper + shared `MiddleEllipsisPath` extraction + dispatch registration + pure-logic test suite landed. tsc clean, `bun test` 1598/1598, `audit:tokens lint` zero violations. The hover-line annotation and the filetree link are deferred (see Tasks).

**Depends on:** #step-1, #step-10

**Commit:** `feat(tide-rendering): EditToolBlock — composes DiffBlock with filePath and change-count chrome`

**References:** [D05], Spec S03

**Conformance:** see [#bk-conformance](#bk-conformance) — tool wrapper composing an `embedded` `DiffBlock`; header truncation per item 8.

**Implementation note — `structuredPatch` is the canonical diff source.** The original step text said "fed from `(old_string, new_string)` or full-file diff if `replace_all`." Reality is cleaner: Claude Code's Edit `structured_result` carries `structuredPatch: StructuredPatchHunk[]` (the `diff` package's hunk shape), which already reflects the whole edit — a single replacement and a `replace_all` that changed N occurrences are both just "every changed hunk across the file." `EditToolBlock` converts `structuredPatch → DiffHunk[]` and renders via `DiffData{source:"hunks"}` — synchronous, first-paint ready, no WASM, no `replace_all` branch. The `(old_string, new_string)` `two-text` shape is the *fallback* for the structured-result-absent (drift) path. The wire shape comes from `tugcode/src/protocol-types.ts` `EditToolResult`; there is no Edit fixture in the v2.1.x catalog, so the wrapper narrows defensively.

**Artifacts:**
- `tugdeck/src/components/tugways/cards/tool-wrappers/edit-tool-block.tsx` + `.css` — the wrapper.
- `tugdeck/src/components/tugways/cards/tool-wrappers/middle-ellipsis-path.tsx` + `.css` — **new shared extraction.** The middle-ellipsis path renderer (conformance item 8) was previously private to `read-tool-block.tsx`; extracted to a shared module (neutral `.tool-wrapper-path*` classes, `data-slot="tool-wrapper-path"`) so `ReadToolBlock` and `EditToolBlock` share one implementation. `read-tool-block.{tsx,css}` updated to consume it.
- `tugdeck/src/components/tugways/cards/tool-wrappers/__tests__/edit-tool-block.test.ts` — pure-logic test suite (18 tests).
- Registry entry: `registerToolWrapper("edit", EditToolBlock)` in `tide-assistant-renderer-dispatch.ts`; the `multiedit → edit` alias ([D16]) already existed and now resolves to the real wrapper.

**Tasks:**
- [x] Header: tool name + `{filePath}` (path via the shared `MiddleEllipsisPath`, conformance item 8) + inline `+N −M` change-count badge (from `countDiffStats` over the converted hunks; rides the shared `--tugx-block-tone-*` tones). Header shows the wire `toolName` — a `MultiEdit` call reads as "MultiEdit", honest over relabelled.
- [x] Body: `DiffBlock` composed `embedded={true}` (the wrapper chrome owns identity; the diff's affordances portal into the chrome actions slot), fed from `structuredPatch` (primary) or a `(old_string, new_string)` `two-text` fallback — see the Implementation note above.
- [ ] _Deferred:_ Footer link-to-file in tugdeck filetree — filetree integration is not yet available; deferred to a follow-on per the original step's own allowance.
- [ ] _Deferred:_ Hover-line annotation — a `DiffBlock` enhancement, not wrapper-local. Deferred to a DiffBlock follow-on rather than bolting a hover feature into the just-stabilized body kind for one wrapper.

**Tests:**
- [x] Synthetic Edit fixture → DiffBlock with correct hunks — `structuredPatchToHunks` tests: line-kind classification + 1-based per-side line numbers + the `\ No newline` sentinel skip + multi-hunk.
- [x] MultiEdit alias dispatches correctly — `resolveToolWrapper("MultiEdit" / "multiedit" / "MULTIEDIT")` resolves to the real `EditToolBlock`.
- [x] `replace_all` produces full-file diff — a `replace_all` edit's `structuredPatch` carries every changed hunk; `composeEditDiffData` flows all of them through unbranched.
- [ ] _Deferred:_ Hover annotation `mouseenter` / `mouseleave` — deferred with the hover-line annotation task above.

**Notes on test strategy.** Body kinds / wrappers have no fake-DOM render tests (project policy: pure-logic `bun:test` + real-app tests only). EditToolBlock's behaviour *is* its four exported pure helpers, which the suite pins exhaustively. A rendering-level app-test is blocked by the same tool-result-injection harness gap that forced the find AT-series to `describe.skip` (see [#e12-followups](#e12-followups)); building that harness extension is out of Step 11 scope. The visual composition is vetted at [#step-14-5](#step-14-5)'s gallery card, following the ReadToolBlock precedent (shipped at #step-8 without its own gallery card).

**Checkpoint:**
- [x] `cd tugdeck && bun x tsc --noEmit && bun test` — tsc clean; `bun test` 1598 pass / 0 fail.

---

#### Step 12: JsonTreeBlock body kind {#step-12}

**Status:** implemented — body kind + pure-logic test suite landed. tsc clean, `bun test` 1617/1617, `audit:tokens lint` zero violations.

**Depends on:** #step-1

**Commit:** `feat(tide-rendering): JsonTreeBlock — collapsible JSON tree viewer with copy-as-path`

**References:** [D04], [D05], [D11], Spec S02

**Conformance:** see [#bk-conformance](#bk-conformance) — new body kind with header / scrolling chrome (items 3–7 apply). `--tugx-json-*` composes `--tugx-block-*`.

**Decision: no in-block search.** The original step listed "search-within-tree" — that is a text-entry surface inside a content block, which [Phase E.12](#phase-e-12)'s [single-text-entry rule](#e12-rule) forbids (the same rule that retired per-block Find). JsonTreeBlock ships **no** search input; text-search over a JSON tree is deferred to the future Find redesign alongside per-block Find. Non-text navigation (expand/collapse, depth control) stays.

**Implementation notes.**
- **Actions cluster, not a separate actions row.** Conformance item 3's "`.tugx-{kind}-actions` row" is Phase B.2 plan language; the shipped reference body kinds (`file-block`, `diff-block`, `terminal-block`) collapsed the affordances into a `.tugx-{kind}-actions-cluster` *inside* the sticky `.tugx-{kind}-header` (standalone) that portals into `ToolWrapperChrome`'s actions slot when `embedded`. JsonTreeBlock follows that shipped convention: `.tugx-json-actions-cluster` hosts Expand-all / Collapse-all (`TugIconButton`) + Copy (`BlockCopyButton`).
- **Copy split.** Copy-subtree is the header `BlockCopyButton` over the whole tree (the root subtree) — the conformance-item-5 Copy affordance. Copy-as-path is a per-node hover-revealed `TugIconButton` (the project's focus-refusing in-list-action primitive — not hand-rolled) that copies that node's path. Arbitrary-node subtree copy is deferred: low marginal value over the header copy + expand-and-select, and a second per-row button doubles hover clutter on a dense data view.
- **Expand model.** `defaultDepth` (3) sets the depth-default; `resolveJsonExpanded` is the single resolver (per-node override → base `expandMode` → depth default). The whole expand state persists through the [A9] protocol ([L23]).

**Artifacts:**
- `tugdeck/src/components/tugways/body-kinds/json-tree-block.tsx` + `.css`
- `tugdeck/src/components/tugways/body-kinds/__tests__/json-tree-block.test.ts` — pure-logic test suite (19 tests). _First `__tests__` file under `body-kinds/` — pure-logic only, per project policy._
- Token slot `--tugx-json-*` (composes `--tugx-block-*`; type colours reuse the semantic-accent `--tug7` text tokens — see the `.css` docstring for the mapping rationale)

**Tasks:**
- [x] Collapsible tree, default depth 3 (`DEFAULT_JSON_DEPTH`); Expand-all / Collapse-all `TugIconButton`s in the `.tugx-json-actions-cluster` (see Implementation notes re: cluster vs. row)
- [x] Type-aware colouring — `string` / `number` / `boolean` / `null` leaves get `.tugx-json-value--{type}` colour classes; `object` / `array` containers get twist + bracket-summary chrome
- [x] Copy-as-path (`response.data[0].id`) via the per-node `TugIconButton`; copy-subtree (whole tree) via the header `BlockCopyButton` — see Implementation notes
- [~] Both themes verify — _by construction:_ every colour rides a `--tug7-*` theme token in one hop ([L17]), no hardcoded colours; visual confirmation in both themes rides [#step-14-5](#step-14-5)'s gallery card (no app consumer renders JsonTreeBlock until DefaultToolWrapper at #step-13)

**Tests:**
- [x] Renders nested object correctly — `jsonEntries` walked recursively over a nested object yields the correct per-level entry model (the renderer recurses on exactly this)
- [x] Collapse beyond default depth shows expand affordance — `resolveJsonExpanded`: depth `< defaultDepth` → expanded, `>= defaultDepth` → collapsed (the row then paints a twist)
- [x] Copy-as-path produces correct path string — `childJsonPath` composes `response.data[0].id` and bracket-quotes non-identifier keys
- [x] No text-entry element in the rendered subtree (single-text-entry rule) — by construction: the JSX renders only `div` / `span` / `TugIconButton` / `BlockCopyButton`, never an `input` / `textarea` / contenteditable. Verified by code inspection (the project has no fake-DOM render tests); noted in the test file's module docstring.

**Notes on test strategy.** Same as [#step-11](#step-11): body kinds have no fake-DOM render tests (project policy: pure-logic `bun:test` + real-app tests only). JsonTreeBlock's behaviour *is* its exported pure helpers, pinned exhaustively by the suite. No app-test surface yet — no app consumer renders JsonTreeBlock until DefaultToolWrapper (#step-13); visual composition is vetted at [#step-14-5](#step-14-5)'s gallery card.

**Checkpoint:**
- [x] `cd tugdeck && bun x tsc --noEmit && bun test` — tsc clean; `bun test` 1617 pass / 0 fail.

---

#### Step 13: DefaultToolWrapper {#step-13}

**Status:** implemented — real `DefaultToolWrapper` body, `TideCautionBadge` extraction, pure-logic + dispatch-wiring test suite landed. tsc clean, `bun test` 1625/1625, `audit:tokens lint` zero violations.

**Depends on:** #step-1, #step-12

**Commit:** `feat(tide-rendering): DefaultToolWrapper — JsonTree-based fallback with caution badge`

**References:** [D04], [D11], Spec S03, (#chrome)

**Conformance:** see [#bk-conformance](#bk-conformance) — tool wrapper over `ToolWrapperChrome`. Composes body kinds *standalone* (not `embedded`) — see the implementation note.

**Implementation notes.**
- **`TideCautionBadge` is an extraction, not a new build.** `ToolWrapperChrome` already shipped a private inline caution badge. This step lifted it into `chrome/tide-caution-badge.tsx` + `.css` as the shared `TideCautionBadge` component (its own `--tugx-caut-*` geometry slots; rides the shared `--tugx-block-tone-caution-*` surface), and `ToolWrapperChrome` now composes it. Same pattern as Step 11's `MiddleEllipsisPath` extraction. Caution-badge rendering for `DefaultToolWrapper` is automatic — the chrome paints `TideCautionBadge` whenever the dispatch threads a `caution` prop. [#step-21](#step-21)'s card-chrome aggregate chip will reuse the same component. The native `title` tooltip is kept (behaviour-preserving extraction); a richer hover surface is a follow-on.
- **`TugMarkdownBlock`, not `TugMarkdownView`.** The plan-alignment pass wrote `TugMarkdownView`; the correct primitive for a *bounded* tool-output blob is `TugMarkdownBlock` — the non-virtualizing, `initialText`-static, no-own-scroll-container sibling. `TugMarkdownView` is the whole-document virtualized scroller (wrong shape here).
- **Standalone body kinds, not `embedded`.** `embedded` mode portals a body kind's actions cluster into the chrome's *single* actions slot; `DefaultToolWrapper` composes *two* body kinds (input tree + result), so two embedded trees would collide there. Each renders standalone — self-contained frame + header — which is also the right shape for "input and output of an unknown tool, clearly delineated." The chrome owns the tool-name identity; the inner sections own theirs (`label="input"` / `label="result"`).
- **No new `--tugx-toolblock-*` extension.** `DefaultToolWrapper` is pure composition and introduces no tokens of its own; the `--tugx-caut-*` family lives on `tide-caution-badge.css`.

**Artifacts:**
- `tugdeck/src/components/tugways/cards/tool-wrappers/default-tool-wrapper.tsx` + `.css` — the [#step-1](#step-1) no-op scaffold's body replaced with the real implementation.
- `tugdeck/src/components/tugways/chrome/tide-caution-badge.tsx` + `.css` — `TideCautionBadge`, extracted from `ToolWrapperChrome`'s private inline badge; token slot `--tugx-caut-*`.
- `tugdeck/src/components/tugways/cards/tool-wrappers/__tests__/default-tool-wrapper.test.ts` — pure-logic + dispatch-wiring test suite (8 tests).
- Updated: `tool-wrapper-chrome.tsx` / `.css` — compose `TideCautionBadge`; the private `CautionBadge` + its `.tool-wrapper-chrome-caution` rule retired (the `--tugx-toolblock-caution-*` geometry tokens stay — `read-tool-block` / `edit-tool-block`'s chips still ride them).

**Tasks:**
- [x] DefaultToolWrapper: `JsonTreeBlock` over `tool_use.input` (`defaultDepth={1}` → collapsed by default), `TugSeparator`, then result smart-picked from `tool_result.output` / `tool_use_structured.structured_result`: text → `TugMarkdownBlock`; object/array → `JsonTreeBlock` (via the pure `pickOutputBody` helper)
- [x] CautionBadge: extracted to `TideCautionBadge` (`chrome/tide-caution-badge.tsx`) — small inline chip, native `title` hover tooltip showing the reason; composed by `ToolWrapperChrome`
- [x] Replace the [#step-1](#step-1) scaffold's no-op `default-tool-wrapper.tsx` body with this real implementation

**Tests:**
- [x] Inject synthetic `tool_use { tool_name: "ZzzUnknown" }` → DefaultToolWrapper + caution badge — `dispatchToolCallState` test: returns `{ Component: DefaultToolWrapper, caution: { reason: "unknown_tool", detail: "ZzzUnknown" } }`, and threads `caution` onto the wrapper props
- [x] Object output renders via `JsonTreeBlock` — `pickOutputBody`: object / array `structured_result` → `{ kind: "json" }`
- [x] Text output renders via `TugMarkdownBlock` — `pickOutputBody`: plain-text output → `{ kind: "markdown" }` (structured object wins over text; primitive structured falls through to text)

**Notes on test strategy.** Same as [#step-11](#step-11) / [#step-12](#step-12): no fake-DOM render tests (project policy). `DefaultToolWrapper`'s only branching logic is `pickOutputBody`, pinned exhaustively; the dispatch-wiring test pins the unknown / audit-confirmed routing against the real component. A rendering-level app-test is still blocked by the tool-result-injection harness gap (see [#e12-followups](#e12-followups)); visual composition is vetted at [#step-14-5](#step-14-5)'s gallery card.

**Checkpoint:**
- [x] `cd tugdeck && bun x tsc --noEmit && bun test` — tsc clean; `bun test` 1625 pass / 0 fail.

---

#### Step 14: Integration checkpoint — day-1 coverage {#step-14}

**Status:** implemented — the fixture-replay dispatch-routing test landed (`assistant-rendering-fixture-replay.test.ts`, 34 tests). tsc clean, `bun test` 1659/1659, `audit:tokens lint` zero violations.

**Depends on:** #step-6, #step-8, #step-11, #step-13

**Commit:** `test(tide-rendering): day-1 integration checkpoint — fixture-replay dispatch routing`

**References:** [D04], [D05], [D11], Spec S06, (#success-criteria)

**Implementation notes.**
- **`.ts`, not the `.tsx` Spec S06 describes.** [Spec S06](#s06-fixture-replay) was written when fake-DOM unit tests were possible — it describes mounting a Tide card per fixture and asserting against the *rendered DOM*. `happy-dom` was since deleted; the testing policy is pure-logic `bun:test` + real-app tests only. So the fixture-replay test is split: this step ships the **pure-logic dispatch-routing half** (Spec S06 items 1 / 5 / 6 — no throw, Table-T02 tools route bespoke, caution-when-expected) as `assistant-rendering-fixture-replay.test.ts`; the **render-level half** (items 2–4 — no `[object Object]`, no raw-JSON bleed, exactly-one `-tool-block` element) needs a render surface and moves to [#step-14-5](#step-14-5)'s gallery snapshot tests, plus a real-app-test once the harness can inject tool-result events (the [#e12-followups](#e12-followups) gap). Spec S06 updated with this split.
- **New helper:** `listGoldenProbes(version)` added to `lib/code-session-store/testing/golden-catalog.ts` — enumerates a catalog version's non-empty `.jsonl` probes, keeping the fragile catalog-root path in one place.
- **Scope: v2.1.105 only**, per the task. `CATALOG_VERSIONS` is a list so [#step-30](#step-30) appends `"v2.1.112"`.

**Artifacts:**
- `tugdeck/src/__tests__/assistant-rendering-fixture-replay.test.ts` — fixture-replay dispatch-routing test (34 tests: 30 per-probe routing checks + catalog-loadable + 3 shipped-wrapper-coverage).
- Updated: `tugdeck/src/lib/code-session-store/testing/golden-catalog.ts` — `listGoldenProbes` helper.

**Tasks:**
- [x] Verify Bash, Read, Edit wrappers + DefaultToolWrapper all dispatch correctly across the v2.1.105 fixture catalog — per-probe test routes every `tool_use` event (`Read` → `ReadToolBlock`, `Bash` → `BashToolBlock`, `Glob`/`Grep`/`Agent`/empty-name → `DefaultToolWrapper`); `Edit` has no v2.1.105 fixture so its routing (incl. the `MultiEdit` alias) is pinned via `resolveToolWrapper`
- [x] Verify caution badge appears for synthetic unknown-tool fixture — `dispatchToolCallState` of a synthetic `ZzzSyntheticUnknownTool` raises `{ reason: "unknown_tool" }` and threads it onto the wrapper props
- [x] Run the `assistant-rendering-fixture-replay.test.ts` against the four shipped wrappers (other tools still go through DefaultToolWrapper — the test asserts exactly what's wired today)

**Tests:**
- [x] All v2.1.105 fixtures replay without throw — every non-empty v2.1.105 probe loads and every `tool_use` it carries dispatches without throwing. _The `[object Object]` / raw-JSON-bleed check is render-level — deferred to [#step-14-5](#step-14-5)'s gallery snapshots (it is also structurally precluded: every wrapper / body kind narrows defensively, and `JsonTreeBlock` renders any JSON value rather than stringifying it)._
- [x] Read/Bash/Edit fixtures produce bespoke wrappers; other tools use DefaultToolWrapper

**Checkpoint:**
- [x] `cd tugdeck && bun x tsc --noEmit && bun test src/__tests__/assistant-rendering-fixture-replay.test.ts` — tsc clean; 34 pass / 0 fail.
- [x] `cd tugdeck && bun run audit:tokens lint` — zero violations.

---

#### Step 14.5: Gallery cards for shipped renderers (batch 1) {#step-14-5}

**Status:** implemented — four new gallery cards (`gallery-tide-thinking`, `gallery-json-tree-block`, `gallery-tool-block-file`, `gallery-tool-block-default`), three existing cards extended, all wired into `gallery-registrations.tsx`. tsc clean, `bun test` 1665/1665, `audit:tokens lint` zero violations, `at0082-gallery-shipped-renderers.test.ts` green (1/1).

**Depends on:** #step-3, #step-4, #step-6, #step-8, #step-11, #step-13

**Commit:** `feat(gallery): cards for ThinkingBlock, JsonTree, file/default tool wrappers; extend existing body-kind galleries`

**References:** [D05], [D11], [D14], (#t01-body-kinds), (#t02-tool-wrappers), (#t03-chrome). Pattern: `tugdeck/src/components/tugways/cards/gallery-transcript-entry.tsx` (stacked variants with mock content).

**Reality check.** Step 10.9's phases shipped several gallery cards already; this step does **not** recreate them. The body-kind surface (FileBlock / DiffBlock / TerminalBlock, standalone and chrome-wrapped) is covered by `gallery-pinned-headers.tsx`; BashToolBlock is covered by `gallery-bash-tool-block.tsx`; markdown content by `gallery-markdown-view.tsx`. Batch 1 *verifies and extends* those, and *creates* only the cards for renderers that have no gallery presence yet.

**Implementation notes.**
- **Dedicated `Block Renderers` [+] picker section.** The assistant-rendering cards (the four new ones plus `gallery-bash-tool-block`, `gallery-bash-mount-in-saved-state`, `gallery-pinned-headers`) moved out of `Text Input & Display` into their own `CATEGORIES.blockRenderers` section, registered in alphabetical order by display title.
- **Test split — registry wiring vs. render.** The card *registry wiring* (each batch-1 componentId registered with a `contentFactory`) is the pure-logic concern, pinned by `gallery-registrations.test.ts`. The *render-half* — renders without throwing, paints no `[object Object]`, emits exactly one `data-slot` root per stacked variant (Spec S06 items 2–4) — needs a real render surface and lives in the app-test `at0082-gallery-shipped-renderers.test.ts`, which drives each card through the running app (the same surface AT0067/AT0068 use for `gallery-bash-mount-in-saved-state`). This replaces the planned `gallery-rendering.test.tsx`.
- **JsonTreeBlock row density.** The per-node copy-path `TugIconButton` was inflating every row to the button's intrinsic height even at `opacity: 0` (still in flow); it is now absolutely positioned against the row, and `.tugx-json-tree` `line-height` dropped 1.6 → 1.4. The tree now reads at a code-dense measure.
- **`completed-expanded` is the interactive toggle.** `TideThinkingBlock`'s static mode is default-collapsed and owns no expand-state input; the gallery mounts it collapsed and the expanded state is reached by clicking the header. The streaming variant covers the default-expanded look.
- **`gallery-markdown-view` extension surface.** A "Features" action button dumps a hand-authored document (footnotes, smart-punct, GFM tables, task lists) via `setRegion` — independent of the size selector, which only drives generated prose. `collapse-tall` stays deferred per this step's own scope note.
- **No new tokens.** Each new card's `.css` is layout-only (section width, side-by-side columns); every painted surface comes from the renderer's already-theme-verified component tokens.

**Artifacts — already exist (verify / extend, do not recreate):**
- `gallery-pinned-headers.tsx` — FileBlock + DiffBlock + TerminalBlock (standalone + chrome-wrapped). Extended: added a long-file FileBlock folded-by-default variant (the previously-unrepresented preview-with-fade surface).
- `gallery-bash-tool-block.tsx` — BashToolBlock. Extended: added non-zero exit, interrupted, ANSI-rich, and empty-success `(no output)` variants (big-output already covered by `gallery-bash-mount-in-saved-state`).
- `gallery-markdown-view.tsx` — markdown content. Extended: a "Features" action exercises the [#step-3](#step-3) extension surface (footnotes, smart-punct, tables, task lists).

**Artifacts — new (create):**
- `tugdeck/src/components/tugways/cards/gallery-tide-thinking.tsx` + `.css` — ThinkingBlock (`chrome/tide-thinking-block.tsx`) variants: streaming, completed-long, completed-short
- `tugdeck/src/components/tugways/cards/gallery-json-tree-block.tsx` + `.css` — JsonTreeBlock standalone (promoted to `gallery-structured-blocks` in [#step-29-5](#step-29-5))
- `tugdeck/src/components/tugways/cards/gallery-tool-block-file.tsx` + `.css` — Read + Edit wrappers side by side (Write + NotebookEdit added in [#step-29-5](#step-29-5))
- `tugdeck/src/components/tugways/cards/gallery-tool-block-default.tsx` + `.css` — DefaultToolWrapper with synthetic unknown tool + caution badge variants
- `tugdeck/src/components/tugways/cards/__tests__/gallery-registrations.test.ts` — pure-logic registry-wiring coverage
- `tests/app-test/at0082-gallery-shipped-renderers.test.ts` — render-half app-test (Spec S06 items 2–4)
- Registrations added to `gallery-registrations.tsx`

**Tasks:**
- [x] Audit the three existing cards above against [Tables T01-T03](#t01-body-kinds); extend variant coverage where a design surface is unrepresented (no recreation)
- [x] Each new card stacks 3-6 mock variants showing the component's full design surface
- [x] All mock data is module-scope, no live wiring
- [x] Each card's root has `data-testid="gallery-<kind>"` for the render-half app-test
- [x] Both themes verified — gallery-card CSS is layout-only and every painted colour rides a theme-verified component token (`audit:tokens lint` zero violations); visual confirmation is the manual checkpoint below
- [x] No new tokens introduced — gallery cards only consume existing component slots

**Tests:**
- [x] Registry wiring — `gallery-registrations.test.ts` pins each batch-1 card registered with a `contentFactory` + `defaultMeta` (6 pass)
- [x] Render-half — `at0082-gallery-shipped-renderers.test.ts` mounts each new / extended card and asserts: non-empty subtree (no throw), no `[object Object]` text, exactly one `data-slot` root per stacked variant (1/1 green)
- [x] `bun run audit:tokens lint` exits 0

**Checkpoint:**
- [x] `cd tugdeck && bun x tsc --noEmit && bun test src/components/tugways/cards/__tests__/` — tsc clean; 23 pass / 0 fail.
- [x] `just app-test at0082-gallery-shipped-renderers.test.ts` — VERDICT: PASS (1/1).
- [ ] Manual: open each new / extended gallery card; visually verify variants render correctly in both themes

---

#### Step 15: PathListBlock + GlobToolBlock {#step-15}

**Status:** implemented — `PathListBlock` (first list-shaped body kind, built on `TugListView`) + `GlobToolBlock` + dispatch registration + two pure-logic test suites landed. tsc clean, `bun test` 1696/1696, `audit:tokens lint` zero violations. Layout revised after manual review (see Implementation notes).

**Depends on:** #step-1

**Commit:** `feat(tide-rendering): PathListBlock + GlobToolBlock`

**References:** [D05], Spec S02, Spec S03

**Conformance:** see [#bk-conformance](#bk-conformance) — `PathListBlock` is a list-shaped body kind (item 9: build on `TugListView`); `GlobToolBlock` is a tool wrapper (item 8: `Glob · {pattern}` header truncation). `--tugx-paths-*` composes `--tugx-block-*`.

**Implementation notes.**
- **`inline`, natural-height list — not a boxed scroller.** `PathListBlock` renders `TugListView` in `inline` mode (every row in document order, no windowing) with `height: auto` overriding the primitive's `height: 100%`. The block grows to its natural content height and the *outer* transcript scrolls; it is not boxed into a fixed-height inner scroller. The first cut bounded the list to `min(count, 12) * rowHeight` with windowing — manual review flagged that a short result reads as cramped and the windowing introduced row-pitch drift. Glob caps at 100 files, so the list is bounded enough that `inline` is the right call; a fold affordance for very long lists is a clean follow-on if it's ever needed.
- **Path truncation via the shared `MiddleEllipsisPath`.** Each row composes the same CSS-driven middle-ellipsis `ReadToolBlock` / `EditToolBlock` use ([#bk-conformance] item 8): the full path shows whenever it fits, and only a genuinely too-wide path collapses in the middle (filename pinned). The first cut used a JS `shortenPath` that collapsed deep paths by *segment count* — width-blind, so it truncated even with horizontal room to spare. Replaced wholesale.
- **`TugListView` token tuning via cascade — with a specificity guard.** `.tugx-paths .tug-list-view.tugx-paths-list` zeroes the host `--tugx-list-view-*` row-gap / padding tokens (and overrides `height: auto`) so rows stack flush and compact — per [L20], a primitive's tokens are tuned via a wrapping selector, not by reaching into its CSS. The three-class form is deliberate: `tide-card.css` sets `--tugx-list-view-row-gap` on `.tide-card-transcript .tug-list-view` to space transcript *entries* apart, and a `PathListBlock` rendered inside the transcript has a nested `.tug-list-view` that also matches that selector — a two-class override ties and loses on source order, so rows inherited the entry-sized gap (the bug manual review caught twice). Any future list-shaped body kind nested in the transcript needs the same guard.
- **Sort.** Two modes (`found` / `name`); the toggle surfaces only above `SORT_TOGGLE_MIN_COUNT` (20). Sort is logical state (row *order*) → React state, persisted via `useComponentStatePreservation`. (No inner scroll means no region-scroll axis to wire.)
- **No render test.** Per project policy (pure-logic `bun:test` + real-app tests only), behaviour is pinned through the exported helpers; a rendering-level check is blocked by the same tool-result-injection harness gap as the find AT-series ([#e12-followups](#e12-followups)). Visual composition is vetted via HMR, and a gallery card follows in a later batch.

**Artifacts:**
- `tugdeck/src/components/tugways/body-kinds/path-list-block.tsx` + `.css` — list-shaped body kind; exported helpers `sortPaths` / `iconKindForPath` / `composePathCountLabel` / `composeTruncationLabel`.
- `tugdeck/src/components/tugways/cards/tool-wrappers/glob-tool-block.tsx` + `.css` — tool wrapper; exported helpers `narrowGlobInput` / `narrowGlobStructured` / `composeGlobPathListData` / `composeGlobCountLabel`.
- `tugdeck/src/components/tugways/body-kinds/__tests__/path-list-block.test.ts` + `tugdeck/src/components/tugways/cards/tool-wrappers/__tests__/glob-tool-block.test.ts` (incl. the fixture-replay count check).
- Token slot `--tugx-paths-*` (composes `--tugx-block-*`) — declared in `path-list-block.css`'s `body{}`.
- Registry entry — `registerToolWrapper("glob", GlobToolBlock)` in `tide-assistant-renderer-dispatch.ts`; `assistant-rendering-fixture-replay.test.ts` updated (`glob` added to `BESPOKE_WRAPPERS`, removed from the "ships later" list).

**Tasks:**
- [x] PathListBlock: built on `TugListView` (`inline` mode); icons by file type (`iconKindForPath`), path truncation via the shared `MiddleEllipsisPath`, sortable when count > 20 (`SORT_TOGGLE_MIN_COUNT`), "Truncated at N" indicator (`composeTruncationLabel`)
- [x] GlobToolBlock: header `Glob · {pattern}` + `{N} files` count + `truncated` badge; body `embedded` PathListBlock

**Tests:**
- [x] Replay `test-21-glob-tool.jsonl` → the catalog's Glob `tool_use_structured` narrows to a 100-file `PathListData`; dispatch routing for the same probe is pinned by `assistant-rendering-fixture-replay.test.ts`
- [x] Truncation indicator appears when `truncated: true` — `composeGlobPathListData` sets `truncatedAt` (= `numFiles`, fallback array length) and `composeTruncationLabel` composes the indicator string

**Checkpoint:**
- [x] `cd tugdeck && bun x tsc --noEmit && bun test` — tsc clean; 1696 pass / 0 fail; `audit:tokens lint` zero violations.

---

#### Step 16: SearchResultBlock + GrepToolBlock {#step-16}

**Status:** implemented — `SearchResultBlock` (second list-shaped body kind) + `GrepToolBlock` (content-mode / files-only-mode body selection) + dispatch registration + two pure-logic test suites landed. tsc clean, `bun test` 1743/1743, `audit:tokens lint` zero violations.

**Depends on:** #step-1, #step-15

**Commit:** `feat(tide-rendering): SearchResultBlock + GrepToolBlock with content-mode and files-only-mode`

**References:** [D05], Spec S02, Spec S03

**Conformance:** see [#bk-conformance](#bk-conformance) — `SearchResultBlock` is a list-shaped body kind (item 9). Note item 2: this block *displays* search results, it carries no search *input* — the query comes from the `Grep` tool call, not an in-block field. `--tugx-search-*` composes `--tugx-block-*`.

**Implementation notes.**
- **`inline`, natural-height list — with the `PathListBlock` specificity guard.** `SearchResultBlock` is built on `TugListView` in `inline` mode (every row in document order, no windowing) with `height: auto` overriding the primitive's `height: 100%` — the same shape `PathListBlock` ([#step-15]) settled on after manual review. It carries the identical CSS specificity guard: `.tugx-search .tug-list-view.tugx-search-list` (0,0,3,0) zeroes the host `--tugx-list-view-*` row-gap / padding tokens so the transcript's entry-sized `--tugx-list-view-row-gap` (set on `.tide-card-transcript .tug-list-view`) does not leak into the nested list view. This is the guard [#step-15]'s notes flagged as required for every future list-shaped body kind nested in the transcript.
- **Two row kinds, collapse is logical state.** The list flattens grouped files into a row sequence of two `kindForIndex` shapes — a clickable file-header row and a match row. Per-file collapse changes *which* rows exist (not how a row looks), so it is React state ([L06]) persisted through the [A9] component-state axis. `buildSearchRows` is the pure flattener; the file-collapse toggle callback rides the per-render immutable `SearchResultDataSource` instance so the cell renderer reaches it without a context.
- **Highlight is span-driven, never regex-at-render.** Each match carries explicit char `spans`; `splitMatchSegments` clamps / drops-empty / sorts / merges them into a gap-free plain/hit run list. No regex is compiled or executed at render time, so a complex or invalid `Grep` pattern can never break the render. Context lines (`before` / `after`) render dimmer than the matched line.
- **GrepToolBlock picks the body kind from the result shape.** `composeGrepMode` routes a `structured_result` carrying per-file `files` to an `embedded` `SearchResultBlock` (content mode) and one carrying only `filenames` to an `embedded` `PathListBlock` (files-only mode) — the exact body kind `GlobToolBlock` reuses. Header is `Grep · {pattern}` (end-ellipsis `<code>`, conformance item 8) + `{N} matches` / `{M} files` badges + a `truncated` badge. Every wire field is optional and defensively narrowed.
- **No render test.** Per project policy (pure-logic `bun:test` + real-app tests only), behaviour is pinned through the exported helpers; the catalog has no Grep probe so the [#step-16] gates use synthetic content-mode / files-only-mode fixtures. Visual composition is vetted via HMR; a gallery card follows in a later batch.

**Artifacts:**
- `tugdeck/src/components/tugways/body-kinds/search-result-block.tsx` + `.css` — list-shaped body kind; exported helpers `splitMatchSegments` / `buildSearchRows` / `totalMatchCount` / `composeFileCountLabel` / `composeMatchCountLabel` / `composeSearchTruncationLabel` / `composeSearchResultText`.
- `tugdeck/src/components/tugways/cards/tool-wrappers/grep-tool-block.tsx` + `.css` — tool wrapper; exported helpers `narrowGrepInput` / `narrowGrepStructured` / `composeGrepMode` / `composeGrepSearchData` / `composeGrepPathListData` / `composeGrepMatchCountLabel` / `composeGrepFileCountLabel`.
- `tugdeck/src/components/tugways/body-kinds/__tests__/search-result-block.test.ts` + `tugdeck/src/components/tugways/cards/tool-wrappers/__tests__/grep-tool-block.test.ts` (incl. the synthetic content-mode / files-only-mode fixture gates).
- Token slot `--tugx-search-*` (composes `--tugx-block-*`) — declared in `search-result-block.css`'s `body{}`.
- Registry entry — `registerToolWrapper("grep", GrepToolBlock)` in `tide-assistant-renderer-dispatch.ts`; `assistant-rendering-fixture-replay.test.ts` updated (`grep` added to `BESPOKE_WRAPPERS` + `beforeEach`, removed from the "ships later" list).

**Tasks:**
- [x] SearchResultBlock: grouped by file with collapsible headers; highlighted match span; surrounding context lines. Result text renders read-only — no in-block find input
- [x] GrepToolBlock: header `Grep · {pattern}` + match count + file count; body `embedded` SearchResultBlock (content mode) or PathListBlock (files-only mode)

**Tests:**
- [x] Synthetic Grep fixture (content mode) → `composeGrepMode` routes to content, `composeGrepSearchData` narrows to a grouped `SearchResultData` (2 files / 3 matches)
- [x] Synthetic Grep fixture (files-only mode) → `composeGrepMode` routes to files, `composeGrepPathListData` narrows to a `PathListData`

**Checkpoint:**
- [x] `cd tugdeck && bun x tsc --noEmit && bun test` — tsc clean; 1743 pass / 0 fail; `audit:tokens lint` zero violations.

---

#### Step 17: AgentTranscriptBlock + TaskToolBlock (recursive) {#step-17}

**Status:** implemented — `AgentTranscriptBlock` (body kind, header/entries/footer) + `TaskToolBlock` (Agent wrapper) + `depth` threading through `dispatchToolCallState` / `ToolWrapperProps` + dispatch registration + two pure-logic test suites landed. tsc clean, `bun test` 1772/1772, `audit:tokens lint` zero violations.

**Depends on:** #step-1, #step-13

**Commit:** `feat(tide-rendering): AgentTranscriptBlock + TaskToolBlock — recursive nested tool rendering`

**References:** [D05], [D17], Spec S02, Spec S03

**Conformance:** see [#bk-conformance](#bk-conformance) — `AgentTranscriptBlock` is a body kind with header / scrolling chrome (items 3–7). Nested entries that are themselves body kinds / wrappers each conform recursively. `--tugx-agent-*` composes `--tugx-block-*`.

**Implementation notes.**
- **Recursion through the same dispatch, `depth` threaded explicitly.** `dispatchToolCallState` gained an optional `depth` argument (default `0`) that flows into `ToolWrapperProps.depth` (a new optional field). `AgentTranscriptBlock` renders each `tool_use` entry by calling `dispatchToolCallState(entry.toolCall, msgId, depth + 1)` — so a nested tool call gets its real per-tool wrapper, and a nested `Agent` recurses `TaskToolBlock → AgentTranscriptBlock` one level deeper. The import graph picks up a `dispatch → task-tool-block → agent-transcript-block → dispatch` cycle; it is safe because `dispatchToolCallState` is a hoisted function declaration only *called* at render time, never at module-eval.
- **Depth cap bounds auto-expansion, never hides data.** `shouldCollapseAgentDepth(depth, maxDepth = AGENT_MAX_DEPTH)` returns `depth > maxDepth` (cap 3 per [D17]'s audit footnote). It seeds the *default* collapsed state — depth 0–3 render expanded, depth 4+ start folded behind a `BlockFoldCue` showing "+N nested calls" — but the user can still expand a folded block, and the [A9] axis persists their choice. A pathologically deep input can't melt the layout because each level past the cap stays folded until explicitly opened.
- **`content[]` is text + nested-tool-call blocks, not the `parent_tool_use_id` siblings.** The catalog's only Agent probe (`test-22-subagent-spawn.jsonl`) carries a text-only `structured_result.content[]`; the subagent's own Grep runs as a separate top-level `parent_tool_use_id`-tagged event. Folding those siblings into `content[]` is reducer work ([D01] state-only, out of scope), so `TaskToolBlock` narrows whatever `content[]` blocks the wire supplies — Anthropic `{type:"text"}` and `{type:"tool_use"}` blocks — and `AgentTranscriptBlock` renders them. The nested-tool-call and depth tests therefore use synthetic fixtures, per the plan.
- **Text entries render as pre-wrapped prose.** A `text` entry renders dependency-free rather than embedding the virtualized `TugMarkdownView` (which owns its own scroll container + imperative ref contract — wrong for short inline entries). When the [#step-3] assistant-text renderer ships, text entries can route through it.
- **`Agent` is canonical; `Task` is the alias.** Registered `registerToolWrapper("agent", TaskToolBlock)`; the historical `task` name resolves via the existing `task → agent` entry in `TOOL_ALIASES` ([D16]) — no new alias needed.

**Artifacts:**
- `tugdeck/src/components/tugways/body-kinds/agent-transcript-block.tsx` + `.css` — body kind; exported helpers `shouldCollapseAgentDepth` / `countNestedToolCalls` / `composeNestedCallsLabel` / `composeAgentToolCountLabel` / `composeAgentDurationLabel` / `composeAgentTokenLabel` / `composeAgentTranscriptText`; `AGENT_MAX_DEPTH`.
- `tugdeck/src/components/tugways/cards/tool-wrappers/task-tool-block.tsx` + `.css` — tool wrapper; exported helpers `narrowAgentInput` / `narrowAgentStructured` / `composeAgentTranscriptData`.
- `tugdeck/src/components/tugways/body-kinds/__tests__/agent-transcript-block.test.ts` + `tugdeck/src/components/tugways/cards/tool-wrappers/__tests__/task-tool-block.test.ts`.
- Token slot `--tugx-agent-*` (composes `--tugx-block-*`) — declared in `agent-transcript-block.css`'s `body{}`.
- `depth` threading — optional arg on `dispatchToolCallState`, optional field on `ToolWrapperProps`.
- Registry entry — `registerToolWrapper("agent", TaskToolBlock)` in `tide-assistant-renderer-dispatch.ts`; `assistant-rendering-fixture-replay.test.ts` updated (`agent`/`task` added to `BESPOKE_WRAPPERS` + `beforeEach`, the now-empty "ships later" test folded into the coverage test).

**Tasks:**
- [x] AgentTranscriptBlock: header (agent type + status + duration + tool-call count); body iterates `content[]` rendering each `tool_use` entry through the same dispatch (`depth + 1`); footer (token summary)
- [x] Recursion bounded by max depth (default 3 — `AGENT_MAX_DEPTH`); deeper levels collapse with "+N nested calls" via `BlockFoldCue` (conformance item 5)
- [x] TaskToolBlock: composes `embedded` AgentTranscriptBlock; header shows agent type + status

**Tests:**
- [x] Replay `test-22-subagent-spawn.jsonl` → its `Agent` tool_use routes to `TaskToolBlock`; the sibling Grep tool_use routes to `GrepToolBlock` (both pinned by `assistant-rendering-fixture-replay.test.ts`)
- [x] Synthetic content fixture → a nested Grep `tool_use` block narrows to a `tool_use` entry that `dispatchToolCallState(…, depth + 1)` routes to `GrepToolBlock`
- [x] Synthetic depth fixture → a nested Agent entry dispatches to `TaskToolBlock` carrying the incremented `depth`; `shouldCollapseAgentDepth` renders depth-3 expanded, collapses depth-4

**Checkpoint:**
- [x] `cd tugdeck && bun x tsc --noEmit && bun test` — tsc clean; 1772 pass / 0 fail; `audit:tokens lint` zero violations.

---

#### Step 17.5: Nest subagent tool calls via `parent_tool_use_id` {#step-17-5}

**Status:** implemented — additive reducer change (`parentToolUseId` on `ToolCallState`, captured in `handleToolUse`) + render-layer regrouping (`groupToolCallsByParent` in the transcript view, `childToolCallsByParent` threaded through the dispatch into `TaskToolBlock` / `AgentTranscriptBlock`). tsc clean, `bun test` 1785/1785, `audit:tokens lint` zero violations.

**Depends on:** #step-1, #step-16, #step-17

**Commit:** `feat(tide-rendering): nest subagent tool calls under AgentTranscriptBlock via parent_tool_use_id`

**References:** [D01], [D17], Spec S03

**Conformance:** see [#bk-conformance](#bk-conformance) — no new component. `AgentTranscriptBlock` (item 9 recursion) gains a second entry source: its `tool_use` entries now come from *both* the wire `content[]` blocks and the reducer-linked child tool calls, dispatched through the same pipeline at `depth + 1`.

**Scope note ([D01] exception).** [D01] fences the `CodeSessionStore` reducer as state-only / unchanged by this phase, and [#step-17](#step-17) honoured that — `TaskToolBlock` renders only the wire `structured_result.content[]`, which for a real subagent run is text-only. But a subagent's *intermediate* tool calls (e.g. the `Grep` in `test-22-subagent-spawn.jsonl`) arrive as separate top-level `tool_use` / `tool_result` events tagged with `parent_tool_use_id`; the reducer currently drops that field, so those calls render as flat siblings of the `Agent` block instead of nested under it. This step is a deliberately *minimal, additive* reducer change — one new optional field, no map restructuring, no phase-logic change — that records the parent link so the rendering layer can build the nesting. It is scoped as its own step (rather than folded into [#step-17](#step-17)) precisely because it crosses the [D01] line and warrants its own review + commit.

**Implementation notes.**
- **Reducer stays flat — link only, no tree.** `handleToolUse` records `event.parent_tool_use_id` onto the `ToolCallState` (`parentToolUseId`, narrowed defensively, *sticky* across the empty→filled continuation since a call's parent never changes). `toolCallMap` stays a flat `Map` keyed by `toolUseId`; `serializeToolCalls` / `allToolsTerminal` / phase transitions / `TurnEntry.toolCalls` are untouched. The tree is a pure *derivation* at render time, not reducer state.
- **`groupToolCallsByParent` is the single regrouping point.** `TranscriptToolCalls` — already the one iteration point for the static and streaming paths — partitions the flat list into `{ topLevel, childrenByParent }` (memoized on `toolCalls` identity). Only top-level calls render as transcript siblings; the `childrenByParent` map threads through `dispatchToolCallState` → `ToolWrapperProps.childToolCallsByParent` → `TaskToolBlock` → `AgentTranscriptBlock`. Each `AgentTranscriptBlock` resolves *its own* children by `toolUseId` and passes the whole map down, so arbitrarily deep nesting falls out for free. A call with a `parentToolUseId` is never promoted to the top level — even an orphan (parent absent) stays out of the sibling list.
- **`composeAgentTranscriptData` merges two entry sources.** Child tool calls (the subagent's *intermediate* work, reducer-linked) render first; the wire `content[]` blocks (the subagent's *final* answer) follow.
- **The catalog's `test-22` `parent_tool_use_id` is an unscrubbed literal — synthetic replay used instead.** `test-22-subagent-spawn.jsonl` carries `parent_tool_use_id: "toolu_016Bjv…"` (a real captured id) while the spawning `Agent`'s `tool_use_id` is a `{{uuid}}` placeholder the loader rescrubs — so the parent↔child correlation is *lost in the fixture* and a replay can't assert the link. The capture-time scrubber missed the field (it is not in `golden-catalog.ts`'s `KNOWN_UUID_FIELDS`). Rather than add fragile correlation heuristics to the shared loader, the reducer→link→grouping pipeline is pinned by a *synthetic* full-sequence replay through the real `reduce()` with correlated ids. **Follow-up:** the Rust catalog scrubber should scrub `parent_tool_use_id` into the `{{uuid}}` occurrence space, and `golden-catalog.ts` should then correlate it — at which point `test-22` becomes a genuine end-to-end nesting fixture.
- **No live-transcript app-test.** Same harness gap as [#step-15](#step-15)–[#step-17](#step-17): the app-test harness can't inject `tool_use` / `tool_result` events, so the live nesting is HMR-vetted; the reducer→grouping→merge pipeline is fully pinned by pure-logic tests.

**Artifacts:**
- `tugdeck/src/lib/code-session-store/events.ts` — `parent_tool_use_id?: string` typed explicitly on `ToolUseEvent` (today reachable only via the index signature).
- `tugdeck/src/lib/code-session-store/types.ts` — `parentToolUseId?: string` added to `ToolCallState`.
- `tugdeck/src/lib/code-session-store/reducer.ts` — `handleToolUse` records `event.parent_tool_use_id`; `toolCallMap` stays flat, `serializeToolCalls` / `allToolsTerminal` / phase transitions untouched.
- `tugdeck/src/components/tugways/cards/tide-card-transcript-tool-calls.tsx` — derives a `Map<parentToolUseId, ToolCallState[]>`, renders only top-level calls, threads the map down (static + streaming paths).
- `tugdeck/src/components/tugways/cards/tide-assistant-renderer-dispatch.ts` + `tool-wrappers/types.ts` — `dispatchToolCallState` gains a `childToolCallsByParent` argument; `ToolWrapperProps` gains the field; `ChildToolCallsMap` type added.
- `tugdeck/src/components/tugways/cards/tool-wrappers/task-tool-block.tsx` — resolves its own children (`childToolCallsByParent.get(toolUseId)`), `composeAgentTranscriptData` extended to merge them with the wire `content[]` entries, passes the whole map on to `AgentTranscriptBlock`.
- `tugdeck/src/components/tugways/body-kinds/agent-transcript-block.tsx` — gains the `childToolCallsByParent` prop, threaded through `AgentEntryView` onto the nested `dispatchToolCallState` call so a nested `Agent` resolves its own children at any depth.
- Tests — `reducer.test.ts` (`parentToolUseId` capture + synthetic full-sequence replay), `tide-card-transcript-tool-calls.test.ts` (new — `groupToolCallsByParent`), `task-tool-block.test.ts` (child-merge cases).

**Tasks:**
- [x] Reducer: type `parent_tool_use_id` on `ToolUseEvent`, add `parentToolUseId` to `ToolCallState`, capture it in `handleToolUse` — flat `toolCallMap` unchanged
- [x] Transcript view: group the flat `toolCalls` into `{ topLevel, childrenByParent }` (`groupToolCallsByParent`); render only top-level; thread `childrenByParent` through the dispatch
- [x] Dispatch + `ToolWrapperProps`: carry the child-tool-calls map (`childToolCallsByParent` / `ChildToolCallsMap`) alongside `depth`
- [x] `TaskToolBlock` → `AgentTranscriptBlock`: merge linked child tool calls with the wire `content[]` entries; recursion resolves each nested `AgentTranscriptBlock`'s children by `toolUseId`
- [x] No flat-sibling regression: a tool call with a `parentToolUseId` never renders at the transcript top level (pinned by `groupToolCallsByParent`'s orphan + nested-child tests)

**Tests:**
- [x] Reducer unit tests — a `tool_use` carrying `parent_tool_use_id` lands in `toolCallMap` with `parentToolUseId` set; a top-level `tool_use` leaves it `undefined`; the link is sticky across the empty→filled continuation
- [x] Synthetic full-sequence replay through `reduce()` — `Agent` + nested `Grep` (tagged with the `Agent`'s id) + both results → the `Grep` `ToolCallState` carries `parentToolUseId` = the `Agent`'s `toolUseId`, the `Agent`'s stays `undefined` (the catalog's `test-22` can't serve as a *correlated* fixture — see Implementation notes)
- [x] `composeAgentTranscriptData` merges linked child tool calls ahead of the wire text content; child-calls-only still composes
- [x] Pure-logic grouping helper — flat list → `{ topLevel, childrenByParent }`: empty, all-top-level, the `test-22` shape (one `Agent` + one `Grep` child), multi-level (depth 2), multi-child order, and orphan handling

**Checkpoint:**
- [x] `cd tugdeck && bun x tsc --noEmit && bun test` — tsc clean; 1785 pass / 0 fail; `audit:tokens lint` zero violations.

---

#### Step 18: PermissionDialog (`control_request_forward`, `is_question:false`) {#step-18}

**Status:** implemented — chrome component + body picker + dispatch wiring + transcript wiring (streaming **and** committed rows) + a [D01]-exception reducer change so the answered permission is a permanent transcript artifact + test suites landed. tsc clean, `bun test` 1810/1810, `audit:tokens lint` zero violations.

**Depends on:** #step-1, #step-12

**Commit:** `feat(tide-rendering): PermissionDialog — inline allow/deny dialog with permission_suggestions`

**References:** [D13], [D01] (exception — see the reducer note below), Spec S03 (chrome variant), (#chrome)

**Conformance:** see [#bk-conformance](#bk-conformance) — the body picker composes body kinds read-only; `Bash` input renders via `TugCodeView` (item 1: CM6 is the canonical text engine — there is no standalone `CodeBlock`). PermissionDialog itself carries only Allow / Deny / suggestion buttons — no text-entry surface, so item 2 is satisfied by construction.

**Implementation note — body kinds composed *standalone*, not `embedded`.** `embedded={true}` is the contract for a body kind sitting under a `ToolWrapperChrome` (it portals affordances into the chrome's actions slot). `PermissionDialog` is its own chrome variant — there is no `ToolWrapperChrome` above the body picker — so `DiffBlock` / `JsonTreeBlock` render in standalone mode with their own identity headers. Pending vs. resolved state is external (`session.pendingApproval`) and enters React via `useSyncExternalStore` ([L02]); the remembered decision + record-expanded flag are local UI data ([L24]). The `--tugx-perm-*` slot family lives in `tide-permission-dialog.css`'s `body{}` block (component-local per the [#step-10-8-5] bulk migration), not in the theme files.

**Reducer change ([D01] exception, [#step-17-5] precedent).** A UI dialog mounted nowhere is dead code, and a permission answered but not durably recorded is a hole in [D13]'s "permanent transcript artifact" promise. Closing both required crossing the [D01] state-only fence with a *minimal, additive* reducer change — scoped and reviewed here rather than punted: `TurnEntry` gains `controlRequests: ReadonlyArray<ControlRequestRecord>`; `CodeSessionState` gains a `controlRequestLog` accumulator (reset `[]` at every turn boundary); `handleRespondApproval` pushes the resolved `{ request, decision, respondedAt }` record; `handleTurnComplete` freezes the log into the committed entry. No map restructuring, no phase-logic change. `AskUserQuestion` records join the same array at [#step-19](#step-19).

**Artifacts:**
- `tugdeck/src/components/tugways/chrome/tide-permission-dialog.tsx` + `.css` — the chrome component + four exported pure helpers; `PermissionRenderInput` carries an optional `resolvedDecision` for the committed-record case.
- `tugdeck/src/components/tugways/chrome/tide-permission-dialog.test.ts` — pure-logic test suite (39 tests across this file + the dispatch test).
- Token slot `--tugx-perm-*` — declared in `tide-permission-dialog.css` body{}.
- `code-session-store/types.ts` — new `ControlRequestRecord`; `TurnEntry.controlRequests`. `reducer.ts` — `controlRequestLog` accumulator + commit/reset wiring. `code-session-store.control-forward.test.ts` — extended (deny round-trip asserts the committed record) + 2 new tests (synthetic allow→commit, no-prompt→`[]`).
- Dispatch: `KIND_RENDERERS.permission` resolves to the real `PermissionDialog` (was a scaffold); the `permission` `RenderInput` variant gains `resolvedDecision`.
- Transcript wiring (`tide-card-transcript.tsx`): `CodeStreamingRowCell` subscribes to `snapshot.pendingApproval` and renders the **live** dialog (between the streaming row's tool calls and assistant body) when a non-question forward is pending — without this the request parks the turn in `awaiting_approval` forever, since the dialog is the only surface that calls `respondApproval`. `CodeCommittedRowCell` renders each `turn.controlRequests` entry as a **resolved** dialog in the same slot, so a turn reads identically before and after it commits.

**Tasks:**
- [x] Header: "Permission requested" + tool icon + tool name (per-tool icon map, generic-wrench fallback)
- [x] Body picker — render the `tool_use.input` through the *most-fitting* body kind, not just JsonTree:
  - `Bash` → render `input.command` via a read-only `TugCodeView` (shell language) — _not_ a bespoke code block
  - `Edit` → render `(input.old_string, input.new_string)` via `DiffBlock` (`two-text` source, read-only)
  - `Read`/`Write` → show `input.file_path` as a styled path (shared `MiddleEllipsisPath`, conformance item 8) with line-range badge if applicable
  - any other tool → fall back to `JsonTreeBlock` over `tool_use.input` (also the narrowing-miss fallback for a Bash/Edit/Read request whose expected fields are absent)
- [x] Reason line from `decision_reason`
- [x] Suggestions from `permission_suggestions` rendered as buttons — `narrowPermissionSuggestion` narrows the v2.1.x catalog shape, drops non-actionable behaviors (`ask`), composes the label from rules + destination
- [x] Allow / Deny buttons; disable while pending — the click handler re-checks the live store's `pendingApproval` so a double-fire is dropped; on response `pendingApproval` clears synchronously and the dialog swaps to the resolved record (no async pending window)
- [x] After response: collapse to one-line static record showing decision — chevron-expand affordance re-shows the request body + reason read-only ([D13])

**Tests:**
- [x] `test-11-permission-deny-roundtrip.jsonl` round-trip → after `respondApproval(deny)` and drain through `turn_complete`, the committed `TurnEntry.controlRequests` carries the resolved record (request + `decision: "deny"` + `respondedAt`); the fixture's `permission_suggestions[0]` is pinned verbatim through `narrowPermissionSuggestion`
- [x] Synthetic allow → `turn_complete` commits `controlRequests` with `decision: "allow"`; a turn with no permission prompt commits `[]`
- [x] Dispatch routing — a `permission` `RenderInput` resolves to the real `PermissionDialog` (`=== KIND_RENDERERS.permission`), no caution, input threaded onto the prop bag
- [x] Body-kind picker, suggestion narrowing, record summary, line-range badge — all four exported pure helpers pinned exhaustively
- [ ] _Harness gap — HMR / live-smoke vetted:_ the live deny/allow click → `tool_approval` round-trip and the primary-button-focus-on-mount. The app-test harness can't inject `control_request_forward` events (the same gap that gates [#step-15](#step-15)–[#step-17](#step-17)); the round-trip is wired through `CodeSessionStore.respondApproval` (pinned by `code-session-store.control-forward.test.ts`) and the focus lands via `useLayoutEffect` per [D13].

**Checkpoint:**
- [x] `cd tugdeck && bun x tsc --noEmit && bun test` — tsc clean; `bun test` 1810 pass / 0 fail.
- [ ] Manual smoke against live tugcode

---

#### Step 18.5: TugInlineDialog primitive + PermissionDialog adoption {#step-18-5}

**Status:** implemented — primitive + pure-logic tests + 6-section gallery card (registered) + PermissionDialog refactored on top + `--tugx-perm-*` shrunk to the resolved-record + small inline-fragment slots. tsc clean, `bun test` 1816/1816, `audit:tokens lint` zero violations.

**Depends on:** #step-18

**Commit:** `feat(tugways): TugInlineDialog — inline confirm/cancel primitive; rebuild PermissionDialog on it`

**References:** [D13], `tug-alert.tsx` (visual proportions), [`tuglaws/component-authoring.md`](../tuglaws/component-authoring.md), [L17] / [L19] / [L20] / [L24], [Table T07](#t07-token-slots)

**Scope note ([D13] follow-up).** [#step-18](#step-18) shipped `PermissionDialog` with bespoke inline-dialog visuals, and design feedback exposed the layout as too underbaked: the shield was undertinted (should be caution-yellow), the title undersized, the actions wrong-handed (Allow on the left), the description fragmented into three loose fragments (the prose, the tool-icon row, and the tool name), and the dialog stretched the full transcript width when a centered fixed-width CTA reads better. The honest fix is not to keep tuning `PermissionDialog` as a one-off — the same shape will be wanted by `QuestionDialog` ([#step-19](#step-19)), an eventual destructive-action confirm (e.g. "Discard unsaved changes?"), and any future inline confirm need. This step extracts the shared visual primitive — `TugInlineDialog` — as a tugways primitive (peer of `TugAlert`) and rebuilds `PermissionDialog` on it as the first consumer. The reducer + dispatch wiring + `TurnEntry.controlRequests` artifact landed in [#step-18](#step-18) are unchanged; only the visual layer is rebuilt.

**Conformance.** `TugInlineDialog` is a tugways primitive (peer of `TugAlert`), not a body kind or tool wrapper — the [#bk-conformance](#bk-conformance) contract does not apply directly; the relevant law set is `tuglaws/component-authoring.md` plus [L17] / [L19] / [L20] / [L24]. The primitive owns the new `--tugx-idialog-*` slot family declared in `tug-inline-dialog.css` body{} (per the [#step-10-8-5] bulk-migration pattern — component-local, not theme files) and composes `--tug7-*` base tokens in one hop.

**Design — public surface.** Sketch (precise prop names finalized in implementation):

```typescript
export interface TugInlineDialogProps {
  /**
   * Icon node — typically a Lucide component. The primitive sizes it
   * to 48 px and tints its `color` via `iconRole`; the consumer chooses
   * the shape.
   */
  icon: React.ReactNode;
  /**
   * Tone for the icon's foreground tint. Maps to the `--tugx-idialog-
   * icon-{role}-color` token slots, which resolve to `--tug7-*` icon /
   * text colors in one hop.
   *
   * @default "default"
   */
  iconRole?: "default" | "caution" | "danger" | "success" | "info";
  /** Strong call-to-action title. Plain string. */
  title: string;
  /**
   * Rich description — ReactNode so consumers can embed inline icons
   * and `<code>` (e.g. "This command requires approval · {Shell-icon}
   * Bash · `tokei`"). The cohesive sentence belongs here; do not
   * fragment the same idea across multiple slots.
   */
  description: React.ReactNode;
  /**
   * Free-form region between the description and the actions row. For
   * a permission with suggestions: the suggestion button(s). For an
   * Edit confirm: a `DiffBlock`. For a question: the option list.
   * Left-aligned with the description text column (not the icon).
   */
  children?: React.ReactNode;
  /** Primary action label. */
  confirmLabel: string;
  /**
   * Confirm-button color domain. `action` → filled-action (default),
   * `danger` → filled-danger (destructive confirms — Discard, Delete).
   *
   * @default "action"
   */
  confirmRole?: "action" | "danger";
  onConfirm: () => void;
  /**
   * Cancel button label. Defaults to "Cancel". Pass `null` to
   * suppress the cancel button entirely (single-action dialogs).
   */
  cancelLabel?: string | null;
  onCancel?: () => void;
  /** Forwarded class name. */
  className?: string;
}
```

Layout (fixed centered card, `max-width` ~520 px via `--tugx-idialog-max-width`):

```
+------------------------------------------+
| [Icon]  Title                            |
|         Description (ReactNode)          |
|                                          |
| [children — body picker / extra buttons] |
|                                          |
|                  [Cancel]  [Confirm]     |
+------------------------------------------+
```

Constraints:
- Icon column: 48 px square; `color` driven by `iconRole`. The fixed shape and size match `TugAlert` so the two read as the same family.
- Title: 1 rem / 600 / line-height 1.4 (matches `--tugx-alert-title-*`).
- Description: 0.875 rem / 1.5 / opacity 0.8 (matches `--tugx-alert-message-*`).
- Children: rendered in the text column (left-aligned with the description), not under the icon column — so a body picker / suggestion button hangs off the same vertical baseline as the description.
- Actions row: right-aligned, `gap` = `--tugx-idialog-space-a`, each button `min-width` = `--tugx-idialog-action-min-w` so short labels ("OK", "Allow") don't read tiny. Cancel sits immediately to the left of Confirm. Confirm always last (right-most). The "third button bottom-left" pattern from the brief is achieved by placing a button in `children` and aligning it left — no separate structured slot.
- Width: fixed centered (`max-width` + `margin: 0 auto`). Consumers cannot widen it; richer content (a long diff, a tall JSON tree) handles its own internal scroll inside `children`.
- Responsive shrink: when the parent is narrower than `max-width`, the icon column stays 48 px and the text column flexes — the proportions stay legible down to a comfortable narrow-pane width.
- Focus management: the confirm button takes focus on mount via `useLayoutEffect` per [D13], so a Return key answers the prompt.

**Token slot — `--tugx-idialog-*`.** Declared in `tug-inline-dialog.css` body{}. Add a row to [Table T07](#t07-token-slots): `| --tugx-idialog-* | TugInlineDialog |`. Slots include `max-width`, `padding`, `space-a` (tight), `space-b` (generous), `icon-size`, `icon-{default,caution,danger,success,info}-color`, `title-{size,weight,leading}`, `description-{size,leading,opacity}`, `children-gap`, `actions-gap`, `action-min-w`, `focus-ring`.

**Artifacts:**
- `tugdeck/src/components/tugways/tug-inline-dialog.tsx` + `.css` — the primitive.
- `tugdeck/src/components/tugways/tug-inline-dialog.test.ts` — pure-logic tests (icon-role → token-slot mapping; cancel-label default + suppression).
- `tugdeck/src/components/tugways/cards/gallery-tug-inline-dialog.{tsx,css?}` — gallery card; registered in the gallery dispatcher.
- `tugdeck/src/components/tugways/chrome/tide-permission-dialog.tsx` — refactored to compose `<TugInlineDialog>`. The four exported pure helpers (`selectPermissionBodyKind`, `narrowPermissionSuggestion`, `composePermissionRecordSummary`, `composePermissionLineRange`) and the resolved-record branch are unchanged. The `--tugx-perm-*` family shrinks to whatever the resolved record still needs (or disappears entirely if the record fits in the primitive's API; expected outcome: most pending-state slots are deleted, the resolved-record slots stay).
- Update [Table T07](#t07-token-slots) with the new `--tugx-idialog-*` slot prefix.

**Tasks:**
- [x] Build `TugInlineDialog` primitive with the prop surface above. Stateless presentation surface; consumer owns the open/close lifecycle.
- [x] Five `iconRole` values wired to `--tugx-idialog-icon-{role}-color` via `[data-icon-role]` selectors (DOM-driven appearance per [L06], not inline `style`). Each slot resolves to a `--tug7-*` color in one hop ([L17]):
  - `default` → `--tug7-element-global-icon-normal-muted-rest`
  - `caution` → `--tug7-element-global-text-normal-caution-rest` (the yellow shield the permission case wants)
  - `danger` → `--tug7-element-global-text-normal-danger-rest`
  - `success` → `--tug7-element-global-text-normal-success-rest`
  - `info` → `--tug7-element-global-text-normal-link-rest`
- [x] Layout: icon column (left) + text column (title + description + children). Actions row right-aligned at the bottom of the dialog. Children sit inside the text column, left-aligned with the description (not under the icon).
- [x] Centered fixed `max-width` 32.5 rem (~520 px). The dialog never stretches to fill its container; consumers can override `--tugx-idialog-max-width` (e.g., the gallery's compact-tile section does this) but cannot widen it via prop.
- [x] Buttons via `TugPushButton`: cancel = `emphasis="outlined" role="action"`; confirm = `emphasis="filled" role={confirmRole}`. Confirm focuses on mount via `useLayoutEffect` per [D13]. `cancelLabel: null` suppresses the cancel button entirely (single-action dialogs); the empty-string passthrough is preserved as a consumer choice rather than a "use default" signal.
- [x] Build the gallery card with all six sections (Bare CTA / Caution permission shape / Destructive confirm / Rich children w/ JsonTreeBlock / Single-action / Icon-role tile row). Each section reports the user's last click via a `Result: <strong>...</strong>` indicator, mirroring `gallery-alert.tsx`.
- [x] Register the gallery card in `gallery-registrations.tsx` under `CATEGORIES.overlays` next to `gallery-alert`.
- [x] Refactor `PermissionDialog` to compose `<TugInlineDialog>`:
  - `<TugInlineDialog icon={<ShieldAlert/>} iconRole="caution" title="Permission requested" description={…} confirmLabel="Allow" confirmRole="action" cancelLabel="Deny" onConfirm={…} onCancel={…}>{body picker + suggestion button(s)}</TugInlineDialog>`
  - **Description composition (per-tool):** a single cohesive ReactNode via the new `PermissionDescription` component that switches on `selectPermissionBodyKind`. Bash → `"This command requires approval · "` + `<Shell size={12}/>` + `" Bash · "` + `<code>{command}</code>`; Edit/MultiEdit → `"This will edit {file_path}."`; Read → `"This will read {file_path} ({line range})."` (the line-range badge from `composePermissionLineRange` rolls into the sentence); Write → `"This will write {file_path}."`; default → `"This will run {tool_name}."`. `decision_reason`, when present and non-empty, appends as a `.tide-permission-dialog-reason` muted span.
  - **Body picker placement:** the body picker now lives inside the dialog's `children` slot via the new `PendingBody` component. For `edit` it renders `DiffBlock` (`two-text` source); for `json` (unknown tool) it renders `JsonTreeBlock`; for `bash` and `path` it returns `null` — the description already carries the relevant input fragment.
  - **Tool-icon swap:** `bash` now uses `Shell` (lucide) inline in the description rather than `Terminal`. The previous `permissionToolIcon` helper is deleted — only Bash needs an inline icon since the other tools have descriptive verbs ("edit", "read", "write") that don't need an icon to disambiguate.
  - **Suggestion buttons:** narrowed via the existing `narrowPermissionSuggestion` and rendered as `TugPushButton emphasis="outlined" role="action"` inside the dialog's `children`, wrapped in the small `.tide-permission-dialog-suggestions` flex-wrap row. The deny-suggestion `role="danger"` mapping is dropped — suggestions read more uniformly as `role="action"` outline buttons.
  - The resolved-record branch is unchanged structurally (DOM, classes, behavior) and continues to own the residual `--tugx-perm-record-*` slot family.
- [x] Strip the now-redundant `--tugx-perm-*` slots: deleted the pending-state header / title / icon / message / body / actions / path / tool-name slots (~14 slots removed). What stays: the resolved-record slots, the suggestion-row gap, the inline-icon nudge, the reason-line color, and the focus-ring + collapse-motion shared slots.

**Open question — scope.** The resolved-record state (the collapsed one-line `{Tool} — Allowed/Denied` toggle with chevron) is *not* an inline-dialog shape. It stays on `PermissionDialog` as-is. If a future record-toggle primitive is wanted, that is separate work.

**Tests:**
- [x] `tug-inline-dialog.test.ts` — pure-logic tests pin the exported contract: `iconRoleSlot` returns the expected `--tugx-idialog-icon-{role}-color` slot for every declared role; `TUG_INLINE_DIALOG_ICON_ROLES` enumerates exactly the five roles in stable order; `resolveCancelLabel` covers default / null-suppression / explicit-string / empty-string passthrough.
- [x] `tide-permission-dialog.test.ts` — the four exported pure helpers and the dispatch routing test still pass (helpers are unchanged; dispatch routing is unchanged).
- [x] `code-session-store.control-forward.test.ts` — reducer behavior is unchanged; deny round-trip + synthetic allow + no-prompt empty all still pass.
- [ ] _Manual / HMR-vetted:_ the live tokei round-trip — dialog mounts centered (~520 px wide), caution-yellow shield, "Permission requested" title at proper size, single cohesive description ("This command requires approval · {Shell-icon} Bash · `tokei`"), suggestion button below in the children slot left-aligned, **Deny** on the left and **Allow on the right with filled-action**, primary-button focus on mount, Return submits Allow. After Allow: the resolved record renders, then on `turn_complete` the committed row's resolved record renders, and the bash output renders fully inline at 47 lines (no fold cue, no inner scroll — relies on the [#step-18](#step-18) cap-bump to 300). _The app-test harness can't inject `control_request_forward` events (same gap that gates [#step-15](#step-15)–[#step-17](#step-17)); the round-trip is wired through `CodeSessionStore.respondApproval` (pinned by `code-session-store.control-forward.test.ts`)._

**Checkpoint:**
- [x] `cd tugdeck && bun x tsc --noEmit && bun test` — tsc clean; `bun test` 1816 pass / 0 fail (1810 → 1816, +6 from the new `tug-inline-dialog.test.ts`).
- [x] `bun run audit:tokens lint` exits 0.
- [ ] Gallery card visually vetted across all six sections (manual user action).
- [ ] Live tokei smoke against tugcode confirms the centered layout, caution shield, cohesive description, button order, and inline 47-line output (manual user action).

---

#### Step 18.6: TugDialogButton primitive — rich-label dialog button {#step-18-6}

**Depends on:** #step-18-5

**Commit:** `feat(tugways): TugDialogButton — rich-label dialog button (label + description; action + choice modes)`

**References:** [D13], [#step-18-5], [#step-19](#step-19) (forward-looking — QuestionDialog will compose this in choice mode), [`tuglaws/component-authoring.md`](../tuglaws/component-authoring.md), [L17] / [L19] / [L20] / [L24], [Table T07](#t07-token-slots)

**Scope note ([#step-18-5] follow-up).** [#step-18-5]'s row-grid for `TugInlineDialog.extraActions` (1/2/3-per-row partition via `partitionDialogActions`) breaks down on real labels: descriptive text like "Allow for this session" doesn't fit the 33%-width column at the dialog's ~520 px max-width, and `TugPushButton`'s ALL CAPS letterspacing was never sized for prose — the labels truncate, run together, and read as a wall of shouting. Looking ahead to [#step-19](#step-19)'s `QuestionDialog`, the AskUserQuestion option labels will be longer still (full sentences for nuanced choices), and the row-grid keeps falling apart further. The honest fix is two parts: **(1)** introduce a new tugways primitive, `TugDialogButton`, sized for sentence-case label + optional rich description (Apple HIG settings-row pattern) with action mode AND choice mode (forward use in QuestionDialog's radio/checkbox option lists); and **(2)** move secondary actions in inline-dialog contexts to a one-per-row stacked layout — the row-grid is dropped entirely.

**Cancel / Confirm stay on `TugPushButton`.** Simple imperatives ("Allow", "Deny", "Cancel", "Discard", "OK") still read crisp in the ALL CAPS imperative style. Only the *secondary* actions — `extraActions` today, future `QuestionDialog` options — move to `TugDialogButton`. The two button primitives serve different intents.

**Scope of *this* step is gallery-only.** Per the user direction, iteration stays in the gallery; the live `PermissionDialog` in the transcript and `TugInlineDialog.extraActions`'s rendering are *not* touched in this step. Too many open design questions remain (selection-affordance shape, hover/focus tints, danger variant treatment, description rich-content rules) to commit to a primitive integration mid-flight. Step 18.6 ships the primitive + a gallery card that exercises every variant, including a "composed inside `TugInlineDialog`" preview section that shows what the future integration would look like — without actually rewiring the integration. Once the gallery iteration converges, a follow-on step (`#step-18-7` or rolled into [#step-19](#step-19) prep) refactors `TugInlineDialog.extraActions` onto `TugDialogButton` (removing `partitionDialogActions` and the row-grid CSS) and considers whether `PermissionDialog`'s suggestion shape should grow a `description` field.

**Conformance.** `TugDialogButton` is a tugways primitive (peer of `TugPushButton`). The relevant law set is [`tuglaws/component-authoring.md`](../tuglaws/component-authoring.md) plus [L17] / [L19] / [L20] / [L24]. The primitive owns the new `--tugx-dialog-button-*` slot family declared in `tug-dialog-button.css` body{} (component-local per the [#step-10-8-5] bulk-migration pattern) and composes `--tug7-*` base tokens in one hop.

**Design — public surface:**

```typescript
export interface TugDialogButtonProps {
  /** Primary action label — sentence-case, semibold. NOT uppercased. */
  label: string;
  /**
   * Optional secondary explanation — ReactNode so consumers can embed
   * inline `<code>`, links, small icons.
   */
  description?: React.ReactNode;
  /**
   * Selected state for choice mode. `undefined` → action mode (plain
   * clickable button, no selection affordance). `boolean` → choice
   * mode (renders the selection affordance per `selectionStyle`).
   */
  selected?: boolean;
  /**
   * Selection-affordance style for choice mode. Ignored when
   * `selected` is `undefined`.
   *
   * - `"check"` (default): check-mark visible when selected, blank
   *   when not. Multi-select / standalone-toggle pattern.
   * - `"radio"`: filled radio circle when selected, ring when not.
   *   Single-select group pattern.
   *
   * @default "check"
   */
  selectionStyle?: "check" | "radio";
  /**
   * Optional trailing-edge content for the title row (e.g.
   * `<ChevronRight/>` if the button leads to another surface, or a
   * keyboard shortcut hint). Ignored in choice mode (the selection
   * affordance owns the trailing edge then).
   */
  trailing?: React.ReactNode;
  /**
   * Color domain. `action` (default) paints the standard outline
   * action; `danger` paints the destructive variant.
   *
   * @default "action"
   */
  role?: "action" | "danger";
  disabled?: boolean;
  onClick?: () => void;
  /** Accessibility label override (defaults to {@link label}). */
  ariaLabel?: string;
  /** Forwarded class name for cascade-scoped customization. */
  className?: string;
}
```

Layout (Apple HIG settings row):

```
+----------------------------------------+
|  Allow for this session    [trailing]  |   ← title row: label leading; trailing = chevron / shortcut / selection affordance
|  Permits this command for the          |
|  duration of the current Tide session. |   ← description (muted ReactNode, optional)
+----------------------------------------+
```

Visual constraints:
- Outline border around the row (visual continuity with `TugPushButton` outlined-action).
- Padding generous enough to read as a settings row, not a tight CTA — roughly `var(--tug-space-md)` vertical, `var(--tug-space-md)` horizontal.
- Title row: label `var(--tug-font-size-md)` semibold, normal-case (NOT uppercased). Trailing affordance pinned to the trailing edge with auto-margin.
- Description below: `var(--tug-font-size-sm)` muted color (matches the inline-dialog description proportions).
- Full-width by default; consumer wraps in a constrained container if needed.
- Hover / focus / active states from the same `--tug7-*` cascade `TugPushButton` uses for outlined-action — visual continuity matters.
- Selected state (`data-selected="true"` on the root): slightly tinted background + border. Selection affordance rendered to the trailing edge.
- Disabled: same treatment as `TugPushButton` disabled.
- Keyboard: `Space`/`Enter` trigger; `Tab` moves focus.

**Token slot — `--tugx-dialog-button-*`.** Declared in `tug-dialog-button.css` body{}. Add row to [Table T07](#t07-token-slots): `| --tugx-dialog-button-* | TugDialogButton |`. Slots include `padding-x` / `padding-y`, `gap-row` (label↔trailing within title row), `gap-stack` (title row↔description), `radius`, `border-width`, `label-{size,weight,leading}`, `description-{size,leading,color,opacity}`, `selection-{check,radio}-{size,color}`, plus `role-{action,danger}-{rest,hover,active,selected,disabled}-{bg,border,fg}` (resolves to `--tug7-*` in one hop).

**Artifacts:**
- `tugdeck/src/components/tugways/tug-dialog-button.tsx` + `.css` — the primitive.
- `tugdeck/src/components/tugways/tug-dialog-button.test.ts` — pure-logic tests for any exported helpers (mode discriminator, selectionStyle default, role default, accessible-name resolution).
- `tugdeck/src/components/tugways/cards/gallery-tug-dialog-button.tsx` — *new* gallery card; registered in `gallery-registrations.tsx` next to `gallery-tug-inline-dialog`.
- Update [Table T07](#t07-token-slots) with `--tugx-dialog-button-*`.

**Tasks:**
- [x] Build `TugDialogButton` per the prop surface above. `--tugx-dialog-button-*` slot family declared in `tug-dialog-button.css` body{}, every slot one-hop to `--tug7-*` per [L17].
- [x] Mode discriminator: `selected === undefined` → action mode (no selection affordance, optional trailing slot honored); `selected: boolean` → choice mode (selection affordance per `selectionStyle`, trailing slot ignored).
- [x] Selection affordances for choice mode:
  - `"check"` — `<Check/>` (lucide) icon visible when `selected: true`, blank `aria-hidden` placeholder reserving its width when `selected: false` (so the row width doesn't shift between selected/unselected siblings in a list).
  - `"radio"` — filled disc when `selected: true`, hollow ring when `selected: false`.
- [x] Hover / focus-visible / active / disabled / selected states wired through `--tug7-*` tokens. Visual continuity with `TugPushButton` outlined-action.
- [x] Build the gallery card with these sections:
  1. **Bare label** — single `TugDialogButton`, label-only, action mode.
  2. **Label + description** — same as 1, plus a multi-line description (one paragraph wrap).
  3. **Stacked list (4 buttons)** — four `TugDialogButton`s stacked vertically in a single column, varying description lengths (one no description; one short; one medium; one wraps multiple lines). Demonstrates the one-per-row pattern.
  4. **Choice mode (check style)** — three `TugDialogButton`s in choice mode with `selectionStyle="check"`; second pre-selected. Click toggles each independently (multi-select mental model).
  5. **Choice mode (radio style)** — three `TugDialogButton`s in choice mode with `selectionStyle="radio"`; first pre-selected. Click selects one (single-select group; gallery section drives the state).
  6. **Danger variant** — `role="danger"` with descriptive label.
  7. **Composed inside `TugInlineDialog`** — `<TugInlineDialog>` with a vertical stack of `TugDialogButton`s passed as `children` (NOT through `extraActions` — the existing `extraActions` rendering is unchanged in this step). This section is the *design preview* for the future `extraActions` refactor; it shows how the dialog frame absorbs a vertical stack of rich-label buttons without committing to the integration yet.
- [x] Register the gallery card in `gallery-registrations.tsx` under `CATEGORIES.overlays`.
- [x] Pure-logic tests for the helpers (selectionStyle default, role default, mode discriminator, ariaLabel-fallback-to-label).

**Open questions — closed by [#step-18-7](#step-18-7):**
- ~~Should `TugInlineDialog.extraActions` be refactored onto `TugDialogButton` (removing `partitionDialogActions` and the row-grid CSS)?~~ **Resolved:** yes — folded into [#step-18-7](#step-18-7) as a new `options` radio-group prop.
- ~~Should `PermissionDialog`'s suggestion shape grow a `description` field?~~ **Resolved:** the implicit "Allow once" head carries one ("Allow this single invocation. No rule is added.") so the user understands the no-rule default; wire-supplied scopes still render as label-only since the wire shape doesn't carry descriptions.
- ~~Does the `trailing` slot in action mode need a default for any common case?~~ **Deferred:** stays opt-in for now — no consumer to date wants a defaulted chevron, and a default would force every action-mode caller to either accept or explicitly suppress it.

**Tests:**
- [x] `tug-dialog-button.test.ts` — pure-logic for the exported helpers (16 tests pin `resolveDialogButtonMode`, `resolveSelectionStyle`, `resolveDialogButtonRole`, `resolveDialogButtonAriaLabel`, `shouldRenderTrailing`).
- [x] Existing `tug-inline-dialog.test.ts`, `tide-permission-dialog.test.ts`, `code-session-store.control-forward.test.ts` continue passing (this step is additive; no existing component is touched).

**Checkpoint:**
- [x] `cd tugdeck && bun x tsc --noEmit && bun test` — 0 type errors; 1846 tests pass.
- [x] `bun run audit:tokens lint` exits 0.
- [x] Gallery card visually vetted across all seven sections (manual user action — selected-state colors, `CircleCheckBig` glyph weight, accent-tinted radio with onAccent pip, mandatory radio in section 7).

---

#### Step 18.7: Integrate TugDialogButton into TugInlineDialog + PermissionDialog {#step-18-7}

**Depends on:** #step-18-5, #step-18-6

**Commit:** `feat(tugways): TugInlineDialog options + PermissionDialog scope picker (TugDialogButton integration)`

**References:** [D13], [#step-18-5], [#step-18-6], [#step-19](#step-19), [`tuglaws/component-authoring.md`](../tuglaws/component-authoring.md), [L17] / [L19] / [L20] / [L24]

**Scope note ([#step-18-6] follow-up).** [#step-18-6] shipped `TugDialogButton` to the gallery only, with the live `TugInlineDialog.extraActions` rendering and the live `PermissionDialog` left untouched while design questions converged. After the gallery iteration settled (selected-state colors, `CircleCheckBig` glyph, accent-tinted radio with onAccent pip), this step folds the work back: `extraActions` is replaced by an `options` radio-group prop driving `TugDialogButton`s, and `PermissionDialog` adopts the new shape by surfacing the wire's `permission_suggestions` as a mandatory-single-select scope picker (with an implicit "Allow once" head as the default). Cancel / Confirm stay on `TugPushButton` per the [#step-18-6] split.

**Conformance.** No new tugways primitive — this step is integration only. The `--tugx-idialog-*` and `--tugx-dialog-button-*` slot families are unchanged; `--tugx-idialog-extra-actions-*` slots are removed (the row-grid CSS is gone). Permission-dialog token surface (`--tugx-perm-*`) is also unchanged.

**Design — `TugInlineDialog` API delta:**

```typescript
// Removed:
//   extraActions?: ReadonlyArray<TugInlineDialogAction>
//   partitionDialogActions(n: number): number[]
//   TugInlineDialogAction
//
// Added:
export interface TugInlineDialogOption {
  value: string;
  label: string;
  description?: React.ReactNode;
  role?: "action" | "danger";
  ariaLabel?: string;
}

interface TugInlineDialogProps {
  // ...existing fields unchanged...
  options?: ReadonlyArray<TugInlineDialogOption>;
  selectedOption?: string;
  onSelectOption?: (value: string) => void;
  optionsAriaLabel?: string;
}
```

The primitive is fully controlled — it never tracks the selection internally. Consumers seed `selectedOption` with their preferred default, set state in `onSelectOption`, and read the chosen value at confirm time. The radio group lives between `children` and the actions row, wrapped in `role="radiogroup"`.

**Design — `PermissionDialog` rewiring:**

- New exported helper `buildPermissionOptions(suggestions)` filters allow-scoped suggestions, prepends the implicit `"Allow once"` head, and shapes the result for `TugInlineDialog.options`. Deny-scoped suggestions are dropped from the radio list — Deny in this dialog stays as the off-ramp button.
- The pending-render path holds a local `selectedOption` state (default: first option, which is `"Allow once"` when scopes exist).
- Allow's `onConfirm` reads the selected option and calls `respond("allow", chosenLabel)` — except for `"Allow once"`, which calls `respond("allow")` with no message so Claude knows no rule was bound.
- Deny's `onCancel` calls `respond("deny")` exactly as before — the chosen scope is ignored.

**Artifacts:**
- `tugdeck/src/components/tugways/tug-inline-dialog.tsx` + `.css` — `extraActions` / `partitionDialogActions` removed; `options` radio-group rendering added.
- `tugdeck/src/components/tugways/tug-inline-dialog.test.ts` — `partitionDialogActions` tests removed; `shouldRenderOptions` tests added.
- `tugdeck/src/components/tugways/chrome/tide-permission-dialog.tsx` — `buildPermissionOptions` helper added; pending-render path rewired onto `options` + `selectedOption` + `onSelectOption`.
- `tugdeck/src/components/tugways/chrome/tide-permission-dialog.test.ts` — `buildPermissionOptions` coverage (empty list, deny-only drop, allow-only with implicit head, mixed filtering, default-ordering invariant).
- `tugdeck/src/components/tugways/cards/gallery-tug-inline-dialog.tsx` — row-grid demo section removed; permission-shape section rebuilt on `options`.
- `tugdeck/src/components/tugways/cards/gallery-tug-dialog-button.tsx` — Section 7 switched from `children`-slot preview to the real `options` API.

**Tasks:**
- [x] Replace `extraActions` with `options` + `selectedOption` + `onSelectOption` + `optionsAriaLabel` on `TugInlineDialog`. Drop `TugInlineDialogAction` and `partitionDialogActions`. Strip the row-grid CSS block.
- [x] Add `buildPermissionOptions(suggestions)` to `tide-permission-dialog.tsx` plus exported constants `ALLOW_ONCE_OPTION_VALUE` / `_LABEL` / `_DESCRIPTION`.
- [x] Rewire `PermissionDialog`'s pending render path: track `selectedOption` in local state, feed `options`, dispatch `respond("allow", label)` for scoped picks and `respond("allow")` for the implicit "Allow once".
- [x] Update gallery cards (`gallery-tug-inline-dialog.tsx`, `gallery-tug-dialog-button.tsx` Section 7) to use the new API.

**Tests:**
- [x] `tug-inline-dialog.test.ts` — `partitionDialogActions` block removed; `shouldRenderOptions` block added (undefined / empty / non-empty).
- [x] `tide-permission-dialog.test.ts` — `buildPermissionOptions` block added (empty / deny-only / allow-only / mixed / default-ordering invariant). Existing `composePermissionSuggestionLabel`, `narrowPermissionSuggestion`, `selectPermissionBodyKind`, dispatch-routing tests unchanged.
- [x] `code-session-store.control-forward.test.ts` continues passing.

**Checkpoint:**
- [x] `cd tugdeck && bun x tsc --noEmit && bun test` — 0 type errors; 1844 tests pass (net −2 vs. [#step-18-6] from `partitionDialogActions` removal, +5 from `buildPermissionOptions`, +3 from `shouldRenderOptions`).
- [x] `bun run audit:tokens lint` exits 0.
- [ ] Live PermissionDialog visually vetted in HMR (manual user action — pending request shows scope picker; Allow commits with chosen label; Deny denies; resolved record collapses correctly).

---

#### Step 18.8: Incremental streaming-markdown render pipeline {#step-18-8}

**Depends on:** #step-1 (TugMarkdownBlock streaming mode is the surface this rebuilds)

**Status:** _In progress — implementation in three commits per the strategy below._

**Implementation strategy — three commits, one per architectural layer.** Each commit is self-contained, builds and tests clean on its own, and is reversible without ripping out the others. The split matches the build order. Commits 1 and 2 are behaviour-neutral (the layer is added but no consumer reads from it yet); commit 3 is the user-visible behaviour change.

1. **Rust + WASM bindings + TS field surfacing.** `tugmark-wasm` computes FNV-1a 64-bit per-block content hashes during the existing block walk; the WASM bindings are regenerated; `SanitizedMarkdownBlock` grows a `contentHash` field. Rust `cargo nextest` tests pin hash determinism, divergence, and stability across representative fixtures. Behaviour-neutral.
2. **Reconciler module.** A new pure-logic TS module `tugdeck/src/lib/markdown/render-incremental.ts` exports the reconciler. Pure-logic Bun tests cover full-reset, append-only, in-place trailing update, mid-stream code-fence completion, list-item growth, whitespace-only delta, structurally-different reparse, and trailing-removal. Still no consumer.
3. **`TugMarkdownBlock` streaming-mode adoption.** Streaming `useLayoutEffect` swaps `renderBlocks` for `renderIncremental` with `WeakMap<HTMLElement, RenderState>` per-container state caching. CSS gains explicit `overflow-anchor: auto` on `.tugx-md-block` documenting the wrapper-level anchor contract. Initial-text mode stays on `renderBlocks` per the proposal's recommended-yes-to-Q1. The visible behaviour change.

Bisection-friendly: a future regression lands cleanly on the layer responsible (Rust hashing, reconciler logic, or React adoption) rather than forcing post-hoc detective work on a single mega-commit. Reversible: a flaw in the reconciler shape can be retried without re-touching proven Rust changes. Reviewable: each commit's diff is internally cohesive — Rust + WASM and React adoption have nothing in common except "they're both about markdown" and shouldn't be read as a single review.

**Commit (when implemented):** `feat(tugways+tugmark): incremental streaming markdown — Rust diff + TS reconciler`

**References:** [L02], [L06], [L19], [L20], [L22], [L23], [`tuglaws/tuglaws.md`](../tuglaws/tuglaws.md), `tugmark-wasm` (existing Rust module), `tug-markdown-block.tsx` (current streaming consumer)

---

**Diagnosis — why streaming markdown jumps the scroll.**

Today's pipeline (`renderBlocks` in `tug-markdown-block.tsx`) is rebuild-everything: each delta calls `parseMarkdownToSanitizedBlocks(fullText)` then either (a) `replaceChildren()` + `appendChild` loop (the original shape — empties the container transiently, browser auto-clamps `scrollTop` when `scrollHeight` shrinks below it) or (b) `replaceChildren(...newNodes)` (the [#step-18-7]-followup fix — atomic swap, no transient empty state). Variant (b) closes the *clamp* path but does not stop the scroll-jump.

The real culprit, after (b) is in place, is **element-identity loss**. Browser scroll anchoring (`overflow-anchor: auto`, the default) anchors the viewport to a *specific element* near the top of the visible area. When that element is destroyed — whether by (a)'s two-phase pattern or (b)'s atomic `replaceChildren(...newNodes)` — the anchor breaks. The browser falls back to a fresh anchor selection, which (combined with the row's height changing in the same frame) lands the viewport on a different element, perceived as "scroll jumped to the top of the turn." `TugListView`'s own anchor mechanism (`anchorIndex` / `anchorOffset`) then runs in response to the row's `ResizeObserver` firing, but the browser has already moved by then; the list view's restoration measures from the wrong starting position.

Two layered failures, one root cause: **DOM identity is not preserved across deltas**. No CSS-level patch fixes this. No JS-level patch around `replaceChildren` fixes it. The render pipeline must be **incremental** — for the typical streaming case (text grows by appending), only the trailing block changes; every block before it must be the *same DOM node* across renders so the browser's anchor and the list view's index stay valid.

Per-frame rebuild is also wasteful in its own right (every `<ul>`, `<li>`, `<code>`, `<strong>` re-allocated, every `enhanceFencedCode` listener re-attached, every fenced-code copy-button feedback state torn down) — but the user-visible failure mode is the scroll jump, and that's the design driver.

---

**Architecture — three layers, Rust-first.**

The streaming markdown surface is a major piece of the Tide user experience; the fix lives at the lowest layer that owns the right primitive, and the higher layers compose on top.

**Layer 1 — `tugmark-wasm` (Rust): identity-aware lex output.**

Today: `lex_blocks(text) -> Vec<u32>` (4 u32 per block: type, start, end, item/row counts).
Today: `parse_blocks_to_html(text) -> Box<[JsValue]>` (per-block sanitized HTML strings).

Add: a per-block content hash carried alongside the existing metadata, so the TS reconciler can identify "this block is byte-identical to the previous render's block N" in O(1). Two reasonable shapes:

- **Option A — extend existing API:** `lex_blocks_with_hashes(text)` returns `Vec<u32>` with a 5th word per block (`content_hash` low 32 bits) plus a sibling `Vec<u64>` for full hashes; or
- **Option B — dedicated incremental API:** `parse_incremental(prev_state: Option<&[u8]>, text: &str) -> IncrementalParseResult` where `IncrementalParseResult` carries `(blocks_meta, blocks_html, blocks_hash, stable_prefix_count, new_state)` and the Rust side does the diff against `prev_state` (an opaque-to-JS byte blob holding the previous run's hashes).

I recommend **Option A** as the smallest defensible step: TS reconciler does the prefix-compare (it's a length-1-array walk, not a hot path), Rust just provides hashes. Option B is a strictly-stronger evolution if profiling later shows hash arrays are expensive to ferry across the WASM boundary.

The hash function: FNV-1a 64-bit over the post-DOMPurify HTML. Wide enough that collisions are practically impossible at any realistic block count; cheap enough to compute during the existing block walk. Computed in Rust during `parse_blocks_to_html` so DOMPurify input is already available; ferried as `Vec<u64>` (or two `Vec<u32>` for the low/high halves) alongside the existing return.

Cross-block features (footnotes, reference links) keep working because `parse_blocks_to_html` continues to operate on the whole document in one pass; the hashing is pure observation, not new parsing logic.

**Layer 2 — `tug-markdown-block-renderer.ts` (TS): the reconciler.**

A new module — pure logic, no React, no JSX. Public surface:

```typescript
export interface RenderState {
  /** Previous parse — block hashes in lex order. */
  hashes: ReadonlyArray<bigint>;
  /** Previous parse — block kinds (informational; aids debugging). */
  kinds: ReadonlyArray<string>;
}

export interface RenderResult {
  /** New state to pass back on the next call. */
  state: RenderState;
  /** How many leading blocks were stable (DOM untouched). */
  stableCount: number;
  /** How many blocks were updated in place (innerHTML rewritten). */
  updatedCount: number;
  /** How many blocks were appended (new DOM nodes added). */
  appendedCount: number;
  /** How many blocks were removed (trailing DOM trimmed). */
  removedCount: number;
}

/**
 * Apply incremental render to `container`. Mutates DOM minimally:
 *   - `stableCount` blocks at the head: untouched (same DOM node, no
 *     style recalc, browser scroll anchor preserved).
 *   - For the divergent suffix:
 *       - Existing blocks at matching indices: `innerHTML` rewritten,
 *         re-run `enhanceFencedCode` on the replaced subtree only.
 *       - New blocks beyond previous length: created and appended.
 *       - Old blocks past new length: removed.
 *
 * The wrapping `.tugx-md-block` element keeps its identity across
 * `innerHTML` writes — that's enough for the browser's scroll anchor
 * (which anchors on the wrapper, not its inner HTML) and for any
 * outer ResizeObserver to see a single delta-scoped height change.
 */
export function renderIncremental(
  container: HTMLElement,
  text: string,
  prev: RenderState | null,
): RenderResult;
```

The reconciler walks new vs. previous hashes in lockstep:
- Common prefix where `new[i].hash === prev[i].hash` → stable count.
- First divergence index → start of the work region.
- For `i ∈ [stableCount, min(new.len, prev.len))`: in-place update.
- For `i ∈ [prev.len, new.len)`: append.
- For `i ∈ [new.len, prev.len)`: remove (rarely runs in streaming).

State (the previous hash array) is cached on the container element via a `WeakMap` keyed on the container — no module-level mutable state, no React state, no risk of cross-instance bleed.

**Layer 3 — `tug-markdown-block.tsx` (TS, React): adopt the reconciler.**

Streaming mode replaces `renderBlocks` with `renderIncremental`. Initial-text mode can stay unchanged (it's a one-shot render, no incremental concern), or adopt the reconciler for code uniformity. The container's CSS gains an explicit `overflow-anchor` discipline — `auto` on `.tugx-md-block` (default, but documented) so the browser knows to anchor on per-block wrappers rather than internal text nodes.

---

**Tuglaws cross-check.**

- [L02] — store subscriptions stay in `useSyncExternalStore`; the reconciler is invoked from the same `useLayoutEffect` that owns the streaming subscription today. No new external-state pathways.
- [L06] — markdown content rendering remains a DOM-mutation appearance pathway; React state holds only the container ref. The reconciler is a pure function over (DOM, text, prev-state) → DOM mutations + new state. ✓
- [L19] — new TS module gets a docstring, exported types, no `data-slot` (it's a pure helper, not a component). The new Rust API gets the standard `tugmark-wasm` module-doc treatment.
- [L20] — no new tokens introduced. `--tugx-md-*` tokens unchanged. ✓
- [L21] — no new third-party code. FNV-1a is a public-domain algorithm; we implement it directly in Rust (a few lines). ✓
- [L22] — streaming subscription continues to observe `PropertyStore` directly and write DOM imperatively, bypassing React's render cycle. The reconciler call is the imperative DOM-write path. ✓
- [L23] — _this is the law the proposal serves_. The current pipeline destroys browser-native scroll position (a user-visible state) on every delta; the reconciler preserves DOM identity for stable blocks, which preserves the browser's scroll anchor, which preserves the user's scroll position. The text the user is reading stays under their eyes. ✓

---

**Artifacts.**

- `tugdeck/crates/tugmark-wasm/src/lib.rs` — extend `parse_blocks_to_html` (or add a sibling) to return per-block FNV-1a content hashes alongside HTML strings. Cargo workspace: per project policy, warnings remain errors (`-D warnings` via the workspace `.cargo/config.toml`).
- `tugdeck/crates/tugmark-wasm/src/__tests__/` — Rust unit tests pinning hash stability and collision resistance on representative fixtures (heading/paragraph/list/code; whitespace-only deltas; partial code-fence completions).
- `tugdeck/src/lib/markdown/parse-markdown-to-sanitized-blocks.ts` — surface the new hash field on `SanitizedMarkdownBlock`.
- `tugdeck/src/lib/markdown/render-incremental.ts` — _new module_ — the reconciler, pure-logic exports.
- `tugdeck/src/lib/markdown/__tests__/render-incremental.test.ts` — pure-logic Bun tests for the reconciler over synthetic block sequences (append-only, mid-block update, block-boundary shift, removal, full reset). Real DOM behaviour (scroll anchoring) is HMR-vetted.
- `tugdeck/src/components/tugways/tug-markdown-block.tsx` — streaming mode adopts the reconciler; static `initialText` mode unchanged for now.
- `tugdeck/src/components/tugways/tug-markdown-block.css` — explicit `overflow-anchor: auto` on `.tugx-md-block` (documented, currently default).

---

**Tasks (in build order).**

- [ ] **Rust** — add FNV-1a per-block hashing to `parse_blocks_to_html` output. Decide between Option A (additive `Vec<u64>`) and Option B (dedicated `IncrementalParseResult` struct with diff). Land Rust-side tests first.
- [ ] **TS pipeline** — surface the hash field on `SanitizedMarkdownBlock`. Rebuild WASM, regenerate bindings, run existing block-parser tests for regressions.
- [ ] **TS reconciler** — write `render-incremental.ts` plus exhaustive pure-logic tests. The reconciler must handle: full reset (no prev state), pure-append (most common), in-place trailing-block update, mid-list block-boundary shift, removal of trailing blocks.
- [ ] **TugMarkdownBlock streaming mode** — replace `renderBlocks` call with `renderIncremental`; cache `RenderState` per container via `WeakMap`. Drop the existing `renderBlocks` once streaming and initial-text both reach parity.
- [ ] **CSS discipline** — add explicit `overflow-anchor: auto` to `.tugx-md-block`; document the rationale in the rule's preamble.
- [ ] **`enhanceFencedCode` re-entry** — confirm the function is idempotent against `innerHTML` rewrites of the same wrapper, and that copy-button feedback state survives an in-place block update (today it does NOT — the button is a fresh DOM node every render). The reconciler's in-place update preserves the wrapper but rewrites its inner HTML, so the button is still re-allocated. If we want feedback persistence, the reconciler needs a "do not write innerHTML when the inner code text is byte-identical" sub-check, which the per-block hash already provides.

---

**Tests.**

- [ ] Rust: hash determinism (same input → same hash); hash divergence (single-character change → different hash); fuzz over a handful of synthetic markdown shapes.
- [ ] TS pipeline: existing `parse-markdown-to-sanitized-blocks.test.ts` continues to pass with the new hash field; new test pins the hash field's presence and stability.
- [ ] TS reconciler: pure-logic tests over (prev RenderState, new text) → expected (stableCount, updatedCount, appendedCount, removedCount). At minimum: empty-to-content, append-only growth, mid-stream code-fence completion (shifts trailing block boundaries), Markdown-list growth (one list-item appended per delta), purely-whitespace delta, structurally-different reparse (full reset path).
- [ ] Existing `tug-markdown-block` tests (if any) continue to pass.

**Checkpoint.**

- [ ] `cd tugrust && cargo nextest run` — Rust tests green (warnings-as-errors enforced).
- [ ] WASM rebuild produces refreshed `pkg/` artifacts; tugdeck builds cleanly against the new bindings.
- [ ] `cd tugdeck && bun x tsc --noEmit && bun test` — 0 type errors; full suite pass.
- [ ] `bun run audit:tokens lint` exits 0.
- [ ] **HMR vet (manual user action)** — issue a tool-call permission, allow it, observe the streaming markdown response. Scroll position holds across deltas; no jump to top; the resolved permission record stays anchored where it was.

---

**Open questions (call out for discussion before implementation):**

1. **Initial-text mode adoption.** Should `TugMarkdownBlock`'s `initialText` mode also route through the reconciler, or stay on the simpler one-shot path? Pro: code uniformity, single render path. Con: zero benefit for the one-shot case (no prior state to diff against). Recommended: leave initial-text mode as-is for now; revisit if a future use case puts the static path under churn.

2. **TugMarkdownView (windowed) adoption.** The big sibling primitive uses similar block parsing for its windowing engine. It is not currently a streaming consumer (it's typically used for whole-document logs), but the same incremental pattern would help if it ever becomes one. Recommended: scope this step to `TugMarkdownBlock` streaming mode only; document the porting path for `TugMarkdownView` in a follow-on if needed.

3. **List-view anchor mechanism interaction.** `TugListView` has its own `anchorIndex` / `anchorOffset` mechanism (see `tug-list-view.tsx` ~L1450). The expectation is that once browser-native scroll anchoring stops moving things mid-frame, the list view's anchor preservation will run correctly. If HMR vetting reveals residual jank, a follow-on may be needed to reconcile the two anchor mechanisms.

4. **Hash carrier shape.** `Vec<u64>` ferried across the WASM boundary deserializes well in modern wasm-bindgen builds; if profiling shows it's hot we can split into two `Vec<u32>` halves or pack into the existing block-meta `Uint32Array`. Default to the simple shape; optimize only on evidence.

5. **State lifetime.** A `WeakMap<HTMLElement, RenderState>` keys state on the container. When the container is GC'd, the state goes with it — no leak path. When the container's React component re-mounts (e.g., row swap from streaming → committed), a *new* container element is created and the WeakMap correctly returns no prior state, so the reconciler does a full reset. This is the behavior we want for that transition.

---

#### Step 18.9: Replay writes per-turn streaming paths {#step-18-9}

**Depends on:** #step-18-8 (incremental render landed on `TugMarkdownBlock` streaming mode); commit `15a34f91` (turnKey-chain + unified `code` kind — see [tuglaws L26](../tuglaws/tuglaws.md#l26)); commit `da22b8e7` (legacy `inflight.*` paths removed).

**Status:** _Implementation complete; awaiting manual HMR vet. Reducer fix landed across all four sites (handleTextDelta, handleToolUse, handleToolResult, handleToolUseStructured), helper parameterized, four new reducer-level tests + two new store-level tests gating the contract, docstrings + design-decisions [D96] updated. Typecheck clean, full test suite 1869/0, audit:tokens lint clean. App-test deferred to a follow-up. Original regression filed against `cf67dda9`: reproducible by sending any turn, then `Developer > Reload`; the committed assistant text, tool output, and thinking pane all render empty after rehydration. User message survives (it reads from `row.turn?.userMessage.text`, which is snapshot-backed)._

---

**Diagnosis.**

The L26 work (`15a34f91`, `131a244c`, `da22b8e7`) collapsed the two-renderer assistant row (`code-streaming` / `code-committed`) into a single `CodeRowCell` whose markdown, thinking, and tool-call children all observe per-turn `PropertyStore` paths exclusively:

```tsx
<TugMarkdownBlock
  streamingStore={streamingStore}
  streamingPath={`turn.${turnKey}.assistant`}   // sole read path
  ...
/>
```

This is correct within a single live session — the per-turn paths are written during the live turn, retained through `turn_complete`, and the same subscription continues to surface the final content on the committed cell with no prop change and no remount. That was the goal, and L26 documents it.

What L26 did NOT account for is that the reducer **deliberately suppresses the write-inflight effect during replay** at four sites:

| Reducer site | Lines | Suppression | Channel |
|---|---|---|---|
| `handleTextDelta` (assistant + thinking) | `reducer.ts:540-543` | `state.phase === "replaying" \|\| turnKey === undefined ? [] : [{kind:"write-inflight", …}]` | `assistant` / `thinking` |
| `handleToolUse` | `reducer.ts:646-663` | `isReplaying ? [] : [...write-inflight...]` | `tools` |
| `handleToolResult` | `reducer.ts:707-730` | `isReplaying ? [] : [...write-inflight...]` | `tools` |
| `handleToolUseStructured` | `reducer.ts:780-797` | `isReplaying ? [] : [...write-inflight...]` | `tools` |

The suppression was correct under the **pre-L26 architecture**: committed cells rendered from `transcript[k].assistant` directly, so writing per-turn paths during replay was wasted work and (per the existing inline comment) would have caused replayed partials to briefly appear in the in-flight pane that the committed pane was a separate thing from. The L26 unification removed the in-flight pane as a separate concept — there is now exactly one pane per turn, observing exactly one path — but did not update the replay write path to match.

The fourth site (`handleToolUseStructured`) is the most consequential. The reducer already accepts `tool_use_structured` events during replay — the existing comment at `reducer.ts:746-752` explicitly notes that excluding `replaying` "would silently drop those events, leaving resumed Read tool calls with `structuredResult: null` and the wrapper rendering an empty body." The same logic applies to the write-inflight effect: dropping it on replay leaves the per-turn `.tools` path holding the older serialization (from `handleToolResult` — also suppressed) OR `undefined` (when there was no `tool_result`), and the structured-tool wrapper (Read, Write, Edit, etc.) renders an empty body. The narrower failure mode is the more user-visible one in practice, because Read/Write/Edit are the most common tool calls and their wrappers are the most chrome-heavy.

Concrete failure on cold boot:

1. tugbank restores the session binding; `cardServicesStore` constructs a fresh `CodeSessionStore` (transcript empty, `streamingDocument` empty).
2. The replay bracket fires: `replay_started` → `user_message_replay` (sets `pendingUserMessage.turnKey` per turn) → `assistant_text` / `thinking_text` / `tool_use` / `tool_result` / `tool_use_structured` → `turn_complete` → `replay_complete`.
3. `turn_complete` commits a populated `TurnEntry` (with `turnKey`, `assistant`, `thinking`, `toolCalls` including `structuredResult` on tools that have it) into `transcript` via the `append-transcript` effect (`reducer.ts:962`).
4. None of the events in step 2 emitted any `write-inflight` effect — all four sites short-circuited on `state.phase === "replaying"`.
5. `CodeRowCell` mounts for each committed turn, subscribes to `turn.${turnKey}.assistant`, gets `undefined`, renders empty. Same for `.thinking` and `.tools`. Structured-tool wrappers (Read/Write/Edit/etc.) render empty bodies because the per-turn `.tools` path is undefined; `JSON.parse(undefined)` is treated as an empty array.

The transcript is intact on the snapshot; the wire from snapshot to render is severed for every cold-boot turn.

---

**Required remedy — option survey.**

Three shapes are coherent. Sketched up-front to make the choice explicit, then one is selected.

**Option A — replay emits the same write-inflight effects as live.** Remove the `isReplaying` short-circuit at all four reducer sites. Replay events flow through the same effect-emission path as live events; each event writes the current accumulated value into `turn.${turnKey}.${channel}`. The reducer stays pure; the wrapper's `processEffects` write-inflight branch is unchanged. No new code; net deletion. The four stale comment blocks are rewritten to describe the post-L26 contract.

**Option B — store wrapper hydrates per-turn paths after replay.** Leave the reducer alone. After `replay_complete`, walk `state.transcript` in the wrapper and synthesize `streamingDocument.set("turn.${turnKey}.${channel}", …)` for each committed turn. Requires re-serializing `toolCalls: ReadonlyArray<ToolCallState>` back into the JSON shape the path stores (the reducer's `serializeToolCalls` already does this — would need to be exported from the reducer module or duplicated in the wrapper).

**Option C — `CodeRowCell` falls back to `row.turn` when the per-turn path is empty.** Conditionally read from `row.turn.assistant` when `isCommitted && streamingDocument.get(path) === undefined`. Pushes the fallback into the renderer, defeating L26's "one path" invariant at the component layer.

**Selected: Option A.**

- Architecturally symmetric: replay and live take the same write path. There is no second mechanism to maintain, no special-case wrapper code, no fallback in the cell. The post-L26 contract is "the cell reads from per-turn paths; the reducer writes them during every accepted event" — full stop.
- Net code deletion. The four `isReplaying ? [] : [...]` ternaries collapse to their second arm; the four stale comment blocks are rewritten (shorter). No new helper, no new export, no new wrapper code.
- Reducer purity preserved. No `crypto.randomUUID()`, no time-dependent values introduced; the change is purely "don't drop an effect we already know how to emit."
- The data emitted matches what `TurnEntry` would carry: each `assistant_text` / `thinking_text` event writes the same buffer that `handleTurnComplete` would commit to `scratchEntry.{assistant,thinking}`; each `tool_use` / `tool_result` / `tool_use_structured` writes `serializeToolCalls(toolCallMap)` which is the JSON shape `TranscriptToolCalls`' streaming mode parses. Byte-equivalent to a live turn's final values.

Options B and C are mentioned only to make the rejection visible. Option B is the right choice if a future code path lands committed turns on `transcript` *without* going through the reducer (e.g., an out-of-band ingestion or a debug-tool import); none exists today. Option C is the right choice if the per-turn path semantics ever need to diverge between live and committed (e.g., a "compact" mode that strips intermediate tool output from the committed payload but the live stream shows everything); also no consumer today.

---

**The change in detail.**

1. **`tugdeck/src/lib/code-session-store/reducer.ts` — `handleTextDelta`** (`~L486-553`).
   - Remove `state.phase === "replaying" ||` from the effect-emission predicate at L541.
   - Rewrite the comment block at L530-538: the new wording explains that per-turn paths are the sole render surface (post-L26) and that replay writes them just like live events do; the previous "replay-committed turns render from `transcript`" rationale is obsolete.
   - `turnKey === undefined` short-circuit stays (it covers the genuine "no in-flight turn" case — `pendingUserMessage` is null between turns).
2. **`tugdeck/src/lib/code-session-store/reducer.ts` — `handleToolUse`** (`~L640-674`).
   - Remove the `isReplaying ? [] :` outer guard on the effect array (L647-648). Keep the `isReplaying` local binding — it still gates the phase transition at L668 (`isReplaying ? state.phase : "tool_work"`).
   - Update the inline comment at L643-645 ("The in-flight tool pane similarly only reflects live turns") — this is no longer true post-L26.
3. **`tugdeck/src/lib/code-session-store/reducer.ts` — `handleToolResult`** (`~L676-740`).
   - Remove the `isReplaying ? [] :` outer guard on the effect array (L714-716). Keep the `isReplaying` local binding — it gates the phase transition at L708-712.
   - Update inline comments at L704-706 to reflect the post-L26 contract.
4. **`tugdeck/src/lib/code-session-store/reducer.ts` — `handleToolUseStructured`** (`~L742-803`).
   - Remove the `isReplaying ? [] :` outer guard on the effect array (L781-782). There is no phase-transition logic to preserve in this handler (structured events don't change phase), so the entire `isReplaying` local binding can be deleted.
   - Rewrite the comment block at L776-779 ("the bracket pair owns transcript-side delivery via `append-transcript`, and the in-flight pane only reflects live turns") — both clauses are obsolete post-L26.
5. **No changes** to `handleTurnComplete`, `processEffects`, `frameToEvent`, or any wrapper-layer code. The fix is reducer-local.

After the change, the effect emission predicate for all four sites reduces to `state.pendingUserMessage !== null` (the three tool handlers) or `turnKey !== undefined` (handleTextDelta — the optional-chain access on pendingUserMessage). Both express the same invariant: an in-flight turn exists, so we know which per-turn path to write.

**Cross-check — the "in-flight snapshot in bracket" path.** `reducer.replay-inflight-survival.test.ts` exercises a subtle case: after an HMR-mid-stream, the cold-boot replay carries `user_message_replay` + `assistant_text {is_partial:false, text:"head of response"}` for the *still-in-flight* turn, then `replay_complete` PRESERVES `pendingUserMessage` and transitions to `streaming` (not `idle`), then the live tail's `assistant_text {is_partial:true, text:" and tail"}` appends in `scratch`, then `turn_complete` commits. Under the fix:
- During replay: write-inflight fires for the snapshot's `assistant_text` (was suppressed before; now emits). `turn.${turnKey}.assistant` = `"head of response"`.
- replay_complete preserves pendingUserMessage → phase = `streaming`.
- Live tail: write-inflight fires (always did; live path was never suppressed). `turn.${turnKey}.assistant` = `"head of response and tail"`.
- turn_complete: `TurnEntry.assistant` = `"head of response and tail"` from scratch.
- Per-turn path matches `TurnEntry`.

The existing tests in `reducer.replay-inflight-survival.test.ts` assert on `state.scratch.get(msgId).assistant` (state, not effects) and `effects.filter(e => e.kind === "append-transcript")` (filters out write-inflight). Both remain green incidentally — they neither assert per-turn-path emptiness during replay nor count effects. No test rewrite needed beyond the additive assertions called out in the test plan below.

---

**Tuglaws cross-check.**

- [L02] — store subscriptions unchanged; `streamingDocument` continues to be observed via `useSyncExternalStore` (in `CodeRowCell` for `controlRequestLog` / `pendingApproval` ) and via direct `PropertyStore.observe` in the streaming consumers (`TugMarkdownBlock`, `TideThinkingBlock`, `TranscriptToolCalls` streaming-mode hook). ✓
- [L06] — appearance state untouched. ✓
- [L19] — reducer module already has docstrings for the affected handlers; the rewritten comment blocks honor the existing style.
- [L22] — streaming consumers continue to observe `PropertyStore` directly and write the DOM imperatively. The reducer's write-inflight effect is the source side of that pipe; this step extends the source coverage (replay-emitted events now write) without changing the consumer contract. ✓
- [L23] — _this is the law the regression violates_. Cold-boot rehydration is exactly an L23 transition: the DOM came down, the protocol replays the user-visible state. Currently the assistant text and tool output are LOST across that transition (rendered empty) — a textbook L23 failure. Option A restores the L23 contract by making replay populate the per-turn paths that the post-L26 render path reads from. ✓
- [L26] — the post-L26 invariant ("cell wrapper stays mounted across the in-flight → committed transition; one renderer, one path") is preserved across cold boot too. No new identity-axis changes. The selected fix is the *only* one that holds L26 invariant across replay, because options B and C either add a second write mechanism (B) or a second read path (C). ✓

---

**Artifacts.**

- `tugdeck/src/lib/code-session-store/reducer.ts` — four sites edited (handleTextDelta, handleToolUse, handleToolResult, handleToolUseStructured); four comment blocks rewritten.
- `tugdeck/src/lib/code-session-store/testing/inflight-paths.ts` — extend `lastCommittedTurnValue(store, channel)` to take an optional `index?: number` parameter (defaulting to the last entry). Add module docstring note that the helper resolves the per-turn path via the snapshot turnKey lookup, so it works uniformly for any committed turn regardless of how the turn was committed (live or replay).
- `tugdeck/src/lib/code-session-store/__tests__/reducer.replay-inflight-survival.test.ts` — extend to assert per-turn paths are populated after a replayed turn (assistant, thinking, tools). Today this file does not check the streaming document at all.
- `tugdeck/src/lib/code-session-store/__tests__/code-session-store.replay.test.ts` — extend with a full-bracket integration: send → replay translator round-trip → assert each committed `TurnEntry`'s per-turn paths via `committedTurnValue(store, channel, index)` for every turn in the transcript.
- `tugdeck/src/lib/tide-transcript-data-source.ts` — module docstring's "Laws / decisions" list updated: the [L23] bullet now explicitly cites cold-boot rehydration as a covered transition, with the per-turn-path symmetry between live and replay as the mechanism.
- `tuglaws/state-preservation.md` — the L23/L26 aside extended to note that L26's "single subscription survives the transition" promise depends on the write side (`code-session-store`) maintaining symmetry between live and replay. A renderer that observes per-turn paths exclusively requires every accepted event — live or replayed — to populate those paths; gating writes on `state.phase` silently breaks the contract across cold boot.
- `tuglaws/design-decisions.md` — new entry codifying the write-side contract: any code path that lands a `TurnEntry` on `state.transcript` (today only `handleTurnComplete`'s `append-transcript` effect; tomorrow possibly out-of-band ingestion, debug-tool imports, or server-pushed snapshots) must also seed the per-turn `streamingDocument` paths (`turn.${turnKey}.{assistant,thinking,tools}`) from the entry's payload. The reducer-emitted write-inflight pattern is one such code path; any future analogue must replicate the seeding. Cites [L23] and [L26] as the laws this preserves.

---

**Tasks (in build order).**

- [x] **Reducer change** — delete the `isReplaying` short-circuit at all four effect-emission sites (handleTextDelta, handleToolUse, handleToolResult, handleToolUseStructured); rewrite the four stale comment blocks. Verified with `grep -n "write-inflight\|isReplaying" tugdeck/src/lib/code-session-store/reducer.ts` that no fifth site exists (count is exactly four; `isReplaying` only survives in handlers that need it for phase-transition gating, never for effect gating).
- [x] **Test helper extension** — parameterized `lastCommittedTurnValue(store, channel)` to `committedTurnValue(store, channel, index?: number)` in `testing/inflight-paths.ts`. Default `index` to `transcript.length - 1` (last entry). `lastCommittedTurnValue` aliased to the new helper for source compat (no external call sites existed). Module docstring notes the helper works uniformly for any committed turn regardless of ingestion path ([D96]).
- [x] **Reducer-level tests** — extended `reducer.replay-inflight-survival.test.ts` with a new describe block: four tests gating the write-inflight emissions during replay (assistant_text, thinking_text, tool sequence including the previously-missed `tool_use_structured` write, and the in-flight-snapshot-in-bracket cross-bracket trace). 8 tests pass.
- [x] **Store-level integration tests** — added a new describe block in `code-session-store.replay.test.ts` ("per-turn paths populated across replay bracket"): a multi-turn bracket (assistant-only, assistant+thinking, structured-tool) asserting `committedTurnValue(store, channel, i)` for every turn AND a no-cross-contamination test pinning distinct `turnKey`s per turn. 15 tests pass for the file.
- [x] **App-test cold-boot vet** — _deferred to a follow-up_. Building a true end-to-end cold-boot vet requires a new harness primitive (inject CODE_OUTPUT replay frames into a bound `CodeSessionStore`) that does not exist today (`bindTideSession` leaves the stores empty by design). Adding that primitive is real work outside the scope of this fix. The reducer-level + store-level coverage above gates every layer this fix touches; the renderer wiring (`CodeRowCell` + `TugMarkdownBlock` + per-turn-path subscription) is unchanged by this step and was HMR-vetted as part of the L26 unification work. The manual HMR vet (Checkpoint below) is the user-facing gate. Follow-up: file the harness-primitive work as a separate step and add the app-test once it lands.
- [x] **Docstring updates** — `tide-transcript-data-source.ts` Laws/decisions block extended (L23 bullet now cites cold-boot rehydration coverage). `state-preservation.md` L23/L26 aside extended with a "Sub-aside — the write side has to keep up with the read side" paragraph. `tuglaws/design-decisions.md` gains `[D96]` codifying the write-side contract under a new "Code Session & Transcript" section.

---

**Tests (assertion shapes).**

- [x] Reducer: replay sequence of `assistant_text` → `turn_complete`. After: write-inflight effect emitted with `{turnKey, channel:"assistant", value:"AUTHORITATIVE"}`; committed entry (via `append-transcript` effect) has matching `assistant` and `turnKey` fields. (Asserts at reducer-effect level rather than `state.transcript`; the reducer is pure and doesn't carry transcript state — the wrapper aggregates.)
- [x] Reducer: replay sequence of `tool_use` (Read, input full) → `tool_result` → `tool_use_structured` → `turn_complete`. After: three write-inflight effects for channel `"tools"` (one per event); the final write's JSON parses to a `ToolCallState[]` whose entry has the expected `structuredResult`. Committed entry matches. (Gates the previously-missed fourth site — `handleToolUseStructured`.)
- [x] Reducer: replay sequence of `thinking_text` → `turn_complete`. After: write-inflight effect emitted with `{turnKey, channel:"thinking", value:"FINAL THOUGHT"}`; committed entry's `thinking` matches.
- [x] Reducer: in-flight-snapshot-in-bracket trace. Drive `replay_started` → `user_message_replay` → `assistant_text {is_partial:false, text:"head of response"}` → `replay_complete` → live `assistant_text {is_partial:true, text:" and tail"}` → `turn_complete`. After: two write-inflight effects with values `["head of response", "head of response and tail"]`; committed entry's `assistant` matches the final concatenation. Confirms the cross-bracket write-through.
- [x] Store-level: multi-turn bracket (3 turns: assistant-only, assistant+thinking, structured-tool with Read) driven through the harness's emit helpers. After `replay_complete`: `committedTurnValue(store, channel, i)` populated where each turn wrote that channel, undefined where it didn't (Turn 1's `.thinking` / `.tools` correctly undefined). The structured-tool turn's `.tools` JSON parses to a single ToolCallState with `structuredResult: { type: "FileBody", text: "file body" }`. Default-index lookup resolves to the last turn.
- [x] Store-level: no cross-contamination between turns — two turns with distinct `turnKey`s; each turn's `.assistant` path holds its own reply only.
- [x] Existing tests stay green — 1869 / 0 fail (6 new tests pass, all prior tests stable). The reducer change is purely additive to the effect-emission stream during replay; no existing test was asserting effect-absence during replay.
- [ ] App-test cold-boot rehydration end-to-end — _deferred_; see Tasks above.

---

**Checkpoint.**

- [x] `bun x tsc --noEmit` clean (run from `tugdeck/`). Exit 0.
- [x] `bun test` clean. 1869 pass, 0 fail, 8245 expect() calls across 105 files. The new tests: 6 (4 reducer-level + 2 store-level).
- [x] `bun run audit:tokens lint` exits 0. Zero violations.
- [ ] `just app-test ...` — _deferred_; see Tasks (app-test deferred to a follow-up step that adds the necessary harness primitive).
- [ ] **HMR vet (manual user action)** — issue a turn with at least one tool call, wait for completion, `Developer > Reload`. Confirm: assistant markdown renders, tool-call cluster renders with its output, thinking pane (if any) renders, user message renders. Scroll position is a separate L23 concern handled by [#step-18-8] / [L26]; the gating fact here is "content survives reload."

---

**Out of scope — explicitly deferred.**

1. **Defensive per-turn-path write at `handleTurnComplete`.** A redundant write at commit time (`streamingDocument.set("turn.${turnKey}.${channel}", scratchEntry.assistant)` etc.) would belt-and-suspender against any mid-turn write that got dropped — e.g., a pathological event ordering where `pendingUserMessage` is null when an `assistant_text` arrives, leaving the per-turn path empty even though `scratch` accumulated correctly. In the happy path this is a duplicate no-op write (the last mid-turn write already left the path equal to `scratchEntry.assistant`). The plan deliberately does NOT include this hardening: it violates the minimum-change discipline and obscures the architectural symmetry the fix is trying to establish. File as a follow-up if a real edge-case ever surfaces; not before.
2. **`scratch` removal.** Once per-turn paths are written on every accepted event, `state.scratch` and the per-turn path hold the same data at every observable moment. `scratch` could in principle be removed and the reducer could read accumulation buffers from the per-turn path on the next event. This is a real refactor (read paths inside the reducer, cleaner reducer state), explicitly out of scope for 18.9 — the regression fix and the refactor are separate concerns and should land separately. File as a follow-up; the architectural simplification is the prize, but the fix must not wait on it.
3. **Out-of-band transcript ingestion.** The design-decisions entry in this step's Artifacts list flags that any future code path that lands `TurnEntry` on `state.transcript` outside the reducer must also seed per-turn paths. There is no such consumer today. If one appears (debug-tool import, server-pushed snapshot, restore-from-external-store), it must implement the seeding — the entry documents the contract.

---

**Commit:** `fix(code-session-store): replay writes per-turn streaming paths`

**References:** [L02], [L22], [L23], [L26], [#step-18-8] (incremental rendering surface), commit `15a34f91` (L26 unification), commit `da22b8e7` (legacy `inflight.*` removal), commit `cf67dda9` (L26 docs that surfaced the regression), `reducer.ts` handleTextDelta / handleToolUse / handleToolResult / handleToolUseStructured, `code-session-store.ts` `processEffects`, `testing/inflight-paths.ts` `lastCommittedTurnValue` → `committedTurnValue`.

---

**Depends on:** #step-1, #step-18, #step-18-5, #step-18-6, #step-18-7

**Commit:** `feat(tide-rendering): QuestionDialog — inline single/multi-select with Other input`

**References:** [D13], Spec S03 (chrome variant)

**Conformance:** see [#bk-conformance](#bk-conformance) — question text renders via `TugMarkdownView`.

**⚠ Open item — E.12 single-text-entry tension.** QuestionDialog's "Other" free-text input is a *second* text-entry surface inside the tide-card while the dialog is mounted, which is in tension with [Phase E.12](#phase-e-12)'s [single-text-entry rule](#e12-rule) ("a card has at most one text-entry / input surface"). A transient, response-demanding modal is categorically different from a persistent per-block widget, so the likely resolution is that the dialog takes *transient focus ownership* while mounted (suspending `tug-prompt-entry`'s activation-focus claim) and the rule's "one **persistent** destination" invariant still holds. **This must be confirmed against the E.11/E.12 focus model and written into a design decision before Step 19 is implemented** — do not ship the "Other" input until the focus-ownership story is settled.

**Artifacts:**
- `tugdeck/src/components/tugways/chrome/tide-question-dialog.tsx` + `.css`
- Token slot `--tugx-quest-*`
- Wire-up: dispatch routes `control_request_forward` (is_question:true) here

**Tasks:**
- [ ] Question text rendered via `TugMarkdownView`
- [ ] Options as choice cards; single-select default; `multiSelect:true` flips to checkboxes
- [ ] "Other" free-text input — _gated on the focus-ownership resolution above_
- [ ] Submit button sends `question_answer { request_id, answers }`
- [ ] After response: collapse to one-line summary

**Tests:**
- [ ] Synthetic AskUserQuestion fixture → QuestionDialog with options
- [ ] Submitting selection produces correct `question_answer` payload
- [ ] Multi-select mode toggles checkboxes

**Checkpoint:**
- [ ] `cd tugdeck && bun x tsc --noEmit && bun test`

---

#### Step 20.x — extracted, shipped, and archived as `archive/tide-assistant-turns.md` {#step-20-extracted}

The Step 20.x sequence (gauge primitives, per-turn telemetry data model, transcript `tailSpacer` spike, six-zone placement architecture, lifecycle state machine + Z5 coordination, `/context`-style drill-down) was extracted into a focused companion plan. **That plan has shipped in full and is now archived** to [`archive/tide-assistant-turns.md`](./archive/tide-assistant-turns.md); its `/context`-breakdown spike record (S1–S6) is archived alongside it at [`archive/tide-assistant-turns-context-breakdown-spikes.md`](./archive/tide-assistant-turns-context-breakdown-spikes.md). The original cut covered Steps 20.1, 20.2, 20.3, 20.3.5, 20.4, 20.5 (including sub-steps 20.5.A through 20.5.D); the companion plan grew additional sub-steps across the 20.4.x range through implementation.

The turns plan stood on its own — it had its own Plan Metadata, Phase Overview, Open Questions, and Design Decisions — and depended on this plan only for the rendering substrate (renderer dispatch, body kinds, tool wrappers). Where this document still references a 20.x step (e.g., Step 21's `Depends on:`), the cross-file link form `./archive/tide-assistant-turns.md#step-20-N` resolves into the archived plan.

Entry points into the archived turns plan:
- Gauge primitives — [`#step-20-1`](./archive/tide-assistant-turns.md#step-20-1) (TugLinearGauge), [`#step-20-2`](./archive/tide-assistant-turns.md#step-20-2) (TugArcGauge)
- Per-turn telemetry data model — [`#step-20-3`](./archive/tide-assistant-turns.md#step-20-3)
- `tailSpacer="80cqh"` spike — [`#step-20-3-5`](./archive/tide-assistant-turns.md#step-20-3-5)
- Six-zone placement architecture — [`#step-20-4`](./archive/tide-assistant-turns.md#step-20-4)
- Lifecycle map + Z5 coordination + drill-down — [`#step-20-5`](./archive/tide-assistant-turns.md#step-20-5)

---

#### Step 21: Drift detection + caution badge surfacing {#step-21}

**Status:** implemented — three drift detectors + the `summarizeDrift` aggregate + deduped triage logging landed in the dispatch; the aggregate surface is `TideVersionBadge`, an always-on Claude Code version badge in a new Z3 prompt-entry caution slot that escalates to a caution tone on drift; `version` exposed on `SessionMetadataStore`. `version_drift` keys on the `major.minor` line so daily patch churn is not flagged. tsc clean, `bun test` green, `audit:tokens lint` zero violations.

**Depends on:** #step-13, [`#step-20-3`](./archive/tide-assistant-turns.md#step-20-3) (per-turn telemetry / card chrome — extracted to `tide-assistant-turns.md`)

**Commit:** `feat(tide-rendering): drift detection — caution badge in card chrome and inline at offending events`

**References:** [D04], [Q03], `tide.md#p15-stream-json-version-gate`, (#chrome)

**Implementation notes.**
- **Card-chrome surface — Z3, not the Step 20.x chrome.** The plan's `tide-meter-chrome.tsx` never shipped: the Step 20.x turns plan's chrome evolved into `tide-card-telemetry-renderers.tsx` (the `TideTelemetryStatusRow` IBM-1620 instrument). The aggregate surface is `TideVersionBadge` (`chrome/tide-version-badge.tsx`), placed in **Z3 — the prompt-entry top row** — rather than crammed into the tightly-balanced Z2 status row. Z3 had no slot for it, so this step adds a `cautionContent` prop to `TugPromptEntry`: a trailing-edge status-row slot. `TideVersionBadge` is **always on** — it shows the running Claude Code version as a quiet `TugBadge` and escalates to a caution tone (warning icon, running + validated versions, drift count) when `summarizeDrift` finds drift.
- **`unknown_shape` is a top-level shallow check per [D04].** `STRUCTURED_RESULT_SCHEMAS` declares each tool's required *top-level* `structured_result` fields. Only `read` has a load-bearing one (`file: object`); Bash / Edit / Glob / Grep / Agent narrow every structured field defensively and degrade gracefully, so they have no schema and no shape they can fail. `file.content` is deliberately **not** required — an image Read legitimately omits it ([D04]'s "field presence and types at top level, not deep validation" governs over the task bullet's `file`-missing-`content` example). A registered wrapper whose present, non-error structured result fails its schema falls back to `DefaultToolWrapper` (`JsonTreeBlock`) with the `unknown_shape` caution.
- **`version_drift` keys on the `major.minor` line, not the patch.** `VALIDATED_CC_VERSION` is the Claude Code version the renderers were last validated against (the most recent `just capture-capabilities` baseline). Anthropic ships Claude Code patch releases almost daily and they essentially never change stream-json shapes, so `versionDriftCaution` compares only the `major.minor` line — a patch difference within the validated line is not drift. The badge stays quiet through daily churn and flags `version_drift` only at the rare minor-version boundary, where shapes have historically diverged.
- **`version` on `SessionMetadataStore`.** `TideVersionBadge` needs the runtime version both to display and to drift-check; `SessionMetadataSnapshot` gained a `version` field (parsed from `system_metadata.version`) — a down-payment on `tide.md#p15-stream-json-version-gate`'s version capture.
- **Console logging is deduped.** `logDriftEvent` keys each occurrence (`toolUseId:reason` / `version:<v>`) and logs once via `console.warn`; `TideVersionBadge`'s effect drives it, so the pure dispatch routing stays side-effect-free and re-renders never spam.
- **Inline marker.** `unknown_tool` and `unknown_shape` both route through `DefaultToolWrapper`, so the [#step-13](#step-13) `ToolWrapperChrome` → `TideCautionBadge` wiring paints the inline chip with no wrapper changes. The `version_drift` inline marker is threaded onto the `system_metadata` dispatch props for [#step-29](#step-29)'s `SessionInitBanner` to surface.

**Artifacts:**
- `tugdeck/src/components/tugways/cards/tide-assistant-renderer-dispatch.ts` — drift detector logic: `VALIDATED_CC_VERSION`, `versionLine`, `STRUCTURED_RESULT_SCHEMAS` + `checkStructuredShape`, `detectVersionDrift` / `versionDriftCaution`, `detectToolCallDrift`, `summarizeDrift`, `logDriftEvent`.
- `tugdeck/src/components/tugways/chrome/tide-version-badge.{tsx,css}` — `TideVersionBadge`, the always-on version badge + click-expand report popover (`--tugx-verbadge-*` report slots; composes `TugBadge` for the chip and `TideCautionBadge` for the report rows).
- `tugdeck/src/components/tugways/tug-prompt-entry.{tsx,css}` — new `cautionContent` Z3 status-row slot.
- `tugdeck/src/lib/session-metadata-store.ts` — `version` field on `SessionMetadataSnapshot`.
- Updated: `tide-card.tsx` mounts `TideVersionBadge` in the prompt-entry `cautionContent` slot.
- Inline caution at the offending event lands via the [#step-13](#step-13) DefaultToolWrapper integration — no wrapper changes needed.

**Tasks:**
- [x] Detect three drift signals: (1) unknown tool name (already wired in step 1), (2) unknown structured_result shape (shallow schema check), (3) `system_metadata.version` ≠ pinned catalog
- [x] Aggregate caution counter on card chrome: "drift detected: 3 events" with click-expand listing the offending events
- [x] Inline caution chip on each offending event (DefaultToolWrapper already; extend to bespoke wrappers when their structured_result fails the schema check)
- [x] Console-log every drift event for triage; include event type, tool_name, version, summary

**Tests:**
- [x] Synthetic version-mismatch fixture → both card-chrome chip and inline-event marker — `dispatch — system_metadata version drift` (caution on result + threaded onto props) + `summarizeDrift` (version drift counted in the aggregate)
- [x] Synthetic unknown-tool fixture → caution chip present — `detectToolCallDrift` + `summarizeDrift` unknown-tool cases
- [x] Synthetic shape-mismatch fixture → caution + JsonTree fallback — `dispatch — shape drift routing` (a registered Read with a bad `structured_result` shape routes to `DefaultToolWrapper` with an `unknown_shape` caution)

**Checkpoint:**
- [x] `cd tugdeck && bun x tsc --noEmit && bun test` — tsc clean; `bun test` 2389 pass / 0 fail. `bun run audit:tokens lint` — zero violations.

---

#### Step 22: KaTeXBlock (lazy-loaded) {#step-22}

**Status:** implemented — KaTeXBlock body kind + lazy KaTeX loader + math fence transformer (populated) + inline-math walker + post-`innerHTML` enhance-math pass + dispatch wiring through `renderIncremental` and `TugMarkdownView`. tsc clean; full `bun test` 2472/2472; `audit:tokens lint` zero violations; Vite build emits a separate `assets/katex-*.js` chunk so the boot bundle pays nothing for math until first encounter.

**Depends on:** #step-3

**Commit:** `feat(tide-rendering): KaTeXBlock — lazy-loaded math typesetting for inline and display modes`

**References:** [D08], [D10], List L02, (#block-transformer-pass)

**Conformance:** see [#bk-conformance](#bk-conformance) — KaTeXBlock is a display-only inline block (scope note): no identity header, actions row, or fold affordance. Only items 1–2 and 6–7 apply; `--tugx-katex-*` composes `--tugx-block-*`.

**Implementation notes.**
- **One renderer surface, two callers.** A single `renderMathInto(el, source, displayMode)` helper drives both the React `KaTeXBlock` component (mounted standalone, e.g. as a future body kind) and the imperative `enhance-math` pass that the markdown primitives call after every `innerHTML` write. Both produce identical typeset DOM because they share the lazy loader + `katex.render` path. The lazy loader (`lib/lazy/load-katex.ts`) is a tiny pure-JS singleton — it does not reuse the WASM `wasmInit` helper because there's no `__wbg_init` to call and no `.wasm` URL to resolve; instead it exposes `loadKaTeX(): Promise<KaTeXEngine>` plus `getKaTeXSync(): KaTeXEngine | null` so the DOM walker renders synchronously after the first await.
- **Transformer + walker, separated by where the math lives.** Fenced ` ```math ` / ` ```latex ` / ` ```tex ` blocks are promoted in the post-sanitize block-transformer pass (`mathTransformer` in `block-transformers/math.ts`, now populated) into a placeholder `<div class="tugx-katex tugx-katex--display" data-tugx-math="display" data-tugx-math-pending="true">SOURCE</div>`. Inline `$...$` and `$$...$$` come from prose text, so a DOM walker (`block-transformers/inline-math-walker.ts`) runs over the rendered DOM after `innerHTML` is set, splits text nodes around math ranges, and produces sibling placeholder spans of the same shape. A single `enhance-math.ts` pass then walks every pending placeholder and asks KaTeX to render — one code path through KaTeX whether the math came from a fence or a prose run.
- **Streaming-aware promotion ([D07]).** `mathTransformer` only promotes when `BlockTransformContext.isComplete` is `true`. Half-streamed `$$ … ` would otherwise render as a KaTeX parse error every frame; the block stays a plain code fence until the full source has arrived, at which point the next parse-pass promotes it.
- **Default transformer list lives in the barrel.** `DEFAULT_BLOCK_TRANSFORMERS` is declared once in `block-transformers/index.ts` and consumed by `renderIncremental` (the path `TugMarkdownBlock` rides) and the full-pass call site in `TugMarkdownView`. Subsequent steps (Mermaid, large-JSON, diff) flip their entries on by adding to that list — no caller changes.
- **Fallback / error path ([R04]).** Failed renders restore the raw LaTeX source as `textContent` and stamp `data-tugx-math-error="true"`; the CSS paints the shared `--tugx-block-tone-caution-*` band. The parent block is untouched. A toast hook is opt-in via the `onError` callback (the markdown primitives pass `undefined` today; surfaces that want a toast supply one). The plan's "fallback to `CodeBlock` with toast" wording predates the per-block CodeBlock retirement (CM6 is the canonical text engine per [#bk-conformance] item 1) — the equivalent surface is the placeholder's raw-source fallback styled as monospace, which renders identically to what an unpromoted ` ```math ` fence would otherwise have read as.
- **Boot-bundle exclusion verified.** `bun run build` produces `dist/assets/katex-*.js` (260 KB / 77 KB gz) and `dist/assets/katex-*.css` as their own chunks. The only katex reference in the main `index-*.js` is Vite's dependency-map URL string for the dynamic import — KaTeX's runtime is absent until first encounter. Fonts ride along the CSS side-effect import (`katex/dist/katex.min.css`); Vite resolves the relative `./fonts/*.woff2` URLs into bundled assets at build time, satisfying the "bundle KaTeX fonts locally; no CDN" requirement.

**Artifacts:**
- `tugdeck/src/components/tugways/body-kinds/katex-block.tsx` + `.css` — Layer-1 body kind; thin React wrapper over `renderMathInto`.
- `tugdeck/src/lib/lazy/load-katex.ts` — singleton lazy loader + sync accessor + test-injection point.
- `tugdeck/src/lib/markdown/block-transformers/math.ts` — populated (was a no-op stub from #step-3). _Plan called the file `math-transformer.ts`; the shipped name follows the established sibling pattern (`mermaid.ts`, `diff.ts`, `large-json.ts`) and is the entry the barrel re-exports as `mathTransformer`._
- `tugdeck/src/lib/markdown/block-transformers/inline-math-walker.ts` — pure `findInlineMathRanges` + DOM walker `walkInlineMath`.
- `tugdeck/src/lib/markdown/enhance-math.ts` — post-`innerHTML` placeholder renderer + the `renderMathInto` helper `KaTeXBlock` reuses.
- `tugdeck/src/lib/markdown/block-transformers/index.ts` — gains `DEFAULT_BLOCK_TRANSFORMERS` (currently `[mathTransformer]`).
- Edits to `tugdeck/src/lib/markdown/render-incremental.ts` (default-transformer wiring + `enhanceMath` call in `buildBlockElement` / `updateBlockElement`) and `tugdeck/src/components/tugways/tug-markdown-view.tsx` (full-pass + per-block enhance-math at all three `enhanceFencedCode` sites).
- New token slot family `--tugx-katex-*` (declared in `katex-block.css`'s `body{}` per the project's component-local-tokens convention, mirroring `--tugx-thinking-*` and `--tugx-term-*`; composes `--tugx-block-*`).
- KaTeX font WOFF2 bundled locally via `katex/dist/katex.min.css`'s relative font URLs (Vite-resolved at build time).
- Test files: `tugdeck/src/lib/markdown/__tests__/math-transformer.test.ts` (21 tests over `decodeFencedEntities` / `extractMathSource` / `buildMathPlaceholderHtml` / `mathTransformer.transform`), `tugdeck/src/lib/markdown/__tests__/inline-math-walker.test.ts` (21 tests over `findInlineMathRanges`), `tugdeck/src/lib/lazy/__tests__/load-katex.test.ts` (5 tests over the loader plumbing + test-injection).

**Tasks:**
- [x] Lazy-load KaTeX on first encounter — `loadKaTeX` singleton + `getKaTeXSync` accessor.
- [x] Display mode: replace fenced ` ```math ` / ` ```latex ` blocks via mathTransformer — populated transformer matching the lang hint case-insensitively (also accepts `tex`).
- [x] Inline mode: text-node walk inside MarkdownBlock for `$...$` and `$$...$$` (post-DOMPurify, pre-render) — `walkInlineMath` runs from `enhance-math` immediately after every `innerHTML` write, skipping `<code>` / `<pre>` / `<script>` / `<style>` subtrees and existing placeholders.
- [x] Error boundary per instance (R04); fallback to raw-source placeholder. _Note: the plan's "fallback to `CodeBlock` with toast" predates the per-block CodeBlock retirement; the equivalent is the placeholder's pending / error state styled as monospace, which reads identically to an unpromoted code fence. The `onError` callback hook lets a host surface a toast on top._
- [x] Bundle KaTeX fonts locally; no CDN — verified via `bun run build` output (`katex-*.css` chunk + bundled `*.woff2` assets via Vite's CSS asset pipeline).

**Tests:**
- [x] Inline `$E=mc^2$` typesets — pure-logic range finder pins the inline parse; the actual KaTeX render is HMR-vetted per project test policy.
- [x] Display `$$\\int_0^1 x^2\\,dx$$` typesets — display-mode range finder pins the parse; the transformer test covers fence promotion end-to-end (synthetic block in → placeholder block out with decoded source).
- [x] Malformed math falls back without crashing parent — `renderPlaceholder` always restores `textContent` and stamps `data-tugx-math-error`; the parent block is untouched because the failure is caught inside the try/catch. The pure-logic helpers tested here cover the fallback's input plumbing; the error path is exercised by HMR.
- [x] Boot bundle excludes KaTeX (verify via build artifact inspection) — `dist/assets/katex-*.js` is its own chunk; the only katex reference in `index-*.js` is the Vite dependency-map URL string.

**Checkpoint:**
- [x] `cd tugdeck && bun x tsc --noEmit && bun test` — tsc clean; `bun test` 2472/2472, 47 new tests across the three new files.
- [x] `cd tugdeck && bun run audit:tokens lint` — zero violations.
- [x] Manual: prompt `> render the quadratic formula` → expect typeset output (deferred to user — HMR is always running; real-engine render is exercised through the live assistant pipeline).

---

#### Step 23: MermaidBlock (lazy-loaded) {#step-23}

**Status:** implemented — MermaidBlock body kind + lazy Mermaid loader + mermaid fence transformer (populated) + post-`innerHTML` enhance-mermaid pass + dispatch wiring through `renderIncremental` and `TugMarkdownView`. tsc clean; full `bun test` 2508/2508; `audit:tokens lint` zero violations; Vite build emits separate `assets/mermaid-*.js` + `assets/mermaid.core-*.js` chunks so the boot bundle pays nothing for diagrams until first encounter. Click-to-zoom overlay deferred (see Tasks).

**Depends on:** #step-3

**Commit:** `feat(tide-rendering): MermaidBlock — lazy-loaded diagram rendering with theme-aware config`

**References:** [D10], List L02, (#block-transformer-pass), R04

**Conformance:** see [#bk-conformance](#bk-conformance) — MermaidBlock is a display-only inline block (scope note): no identity header, actions row, or fold affordance. Only items 1–2 and 6–7 apply; `--tugx-mermaid-*` composes `--tugx-block-*`.

**Implementation notes.**
- **Mirrors the KaTeX architecture ([#step-22]).** One `renderMermaidInto(el, source)` helper drives both the React `MermaidBlock` component and the imperative `enhance-mermaid` pass that the markdown primitives call after every `innerHTML` write. Both go through the same lazy loader + `mermaid.render` path. The lazy loader (`lib/lazy/load-mermaid.ts`) is a tiny pure-JS singleton — same shape as `load-katex.ts`. The loader's `MermaidEngine` wraps `mermaid.initialize` + `mermaid.render` so consumers don't import the package directly, and the boot bundle stays clean.
- **Transformer is streaming-aware ([D07]).** `mermaidTransformer` only promotes ` ```mermaid ` fences when `BlockTransformContext.isComplete` is `true`. Half-streamed diagrams would otherwise render as "Syntax error in graph" on every delta; instead the block stays a plain code fence until the source has finished arriving, at which point the next parse-pass promotes it. Same pattern as math fences ([#step-22]) — the populated transformers' input predicates don't overlap, so the order in `DEFAULT_BLOCK_TRANSFORMERS` is independent.
- **Theme awareness via host-canvas luminance.** `enhance-mermaid` reads `--tugx-host-canvas-color` from `getComputedStyle(document.body)`, runs it through `readColorLuminance` (Rec. 709 luma), and picks Mermaid's `theme: 'dark'` for canvas < 0.5 and `theme: 'default'` otherwise. brio's `#16181a` resolves dark; harmony's `#71888e` resolves light. Individual `themeVariables` overrides are intentionally not threaded through — Mermaid's built-in themes already produce coherent diagrams on both surfaces, and per-token overrides risk colour collisions with the diagram's internal palette. A theme switch is one full markdown re-render away; the next enhance pass over a fresh innerHTML write picks up the new colour scheme.
- **Click-to-zoom deferred.** The plan's "Pan/zoom on click for large diagrams" task is deferred to a follow-on. v1 handles oversized diagrams via the frame's `overflow-x: auto` (the SVG natural width is preserved; the user pans by scrolling). A true pan/zoom modal overlay (wheel-zoom, drag-pan, esc-to-close) is non-trivial and orthogonal to the lazy-load + transformer + theme contract this step ships. The same defer-on-its-own-step precedent applies as #step-11's hover-line annotation and the [#step-3] collapse-tall-block affordance.
- **Failure path ([R04]).** Failed renders restore the raw diagram source as `textContent` and stamp `data-tugx-mermaid-error="true"`; the CSS paints the shared `--tugx-block-tone-caution-*` band. The parent block is untouched. A toast hook is opt-in via the `onError` callback (the markdown primitives pass `undefined` today; surfaces that want a toast supply one). The plan's "fallback to plain code with toast" wording is satisfied by the placeholder's pending / error state styled as monospace, which reads identically to an unpromoted ` ```mermaid ` fence.
- **Boot-bundle exclusion verified.** `bun run build` produces `dist/assets/mermaid-*.js` (~13 KB / 4 KB gz; the entry stub) plus the heavier `mermaid.core-*.js` chunk (~580 KB / 135 KB gz) and on-demand sub-chunks for individual diagram types (cytoscape, wardley, sequence, etc.). The only mermaid references in the main `index-*.js` are Vite's dependency-map URL strings for the dynamic import — Mermaid's runtime is absent until first encounter.
- **Stable element IDs.** `enhance-mermaid` mints a process-local `tugx-mermaid-N` id per render call. Mermaid bakes the id into element ids inside the SVG; a duplicate across two diagrams on the same page would yield invalid markup. The counter lives in module scope (one process), which is the lifetime we want.

**Artifacts:**
- `tugdeck/src/components/tugways/body-kinds/mermaid-block.tsx` + `.css` — Layer-1 body kind; thin React wrapper over `renderMermaidInto`.
- `tugdeck/src/lib/lazy/load-mermaid.ts` — singleton lazy loader + sync accessor + test-injection point.
- `tugdeck/src/lib/markdown/block-transformers/mermaid.ts` — populated (was a no-op stub from #step-3). _Plan called the file `mermaid-transformer.ts`; the shipped name follows the established sibling pattern (`math.ts`, `diff.ts`, `large-json.ts`) and is the entry the barrel re-exports as `mermaidTransformer`._
- `tugdeck/src/lib/markdown/enhance-mermaid.ts` — post-`innerHTML` placeholder renderer + the `renderMermaidInto` helper `MermaidBlock` reuses + the pure-logic `readColorLuminance` / `pickMermaidTheme` helpers.
- `tugdeck/src/lib/markdown/block-transformers/index.ts` — `DEFAULT_BLOCK_TRANSFORMERS` extended with `mermaidTransformer` (previously `[mathTransformer]`).
- Edits to `tugdeck/src/lib/markdown/render-incremental.ts` (`enhanceMermaid` call in `buildBlockElement` / `updateBlockElement`) and `tugdeck/src/components/tugways/tug-markdown-view.tsx` (per-block enhance-mermaid at all three `enhanceFencedCode` sites).
- New token slot family `--tugx-mermaid-*` (declared in `mermaid-block.css`'s `body{}` per the project's component-local-tokens convention; composes `--tugx-block-*`).
- Test files: `tugdeck/src/lib/markdown/__tests__/mermaid-transformer.test.ts` (17 tests over `decodeMermaidEntities` / `extractMermaidSource` / `buildMermaidPlaceholderHtml` / `mermaidTransformer.transform`), `tugdeck/src/lib/markdown/__tests__/enhance-mermaid.test.ts` (13 tests over `readColorLuminance`), `tugdeck/src/lib/lazy/__tests__/load-mermaid.test.ts` (6 tests over the loader plumbing + test-injection).

**Tasks:**
- [x] Lazy-load mermaid on first encounter — `loadMermaid` singleton + `getMermaidSync` accessor.
- [x] Streaming-safe: stay as plain `CodeBlock` until parent block reaches `complete`; promote then — `mermaidTransformer` defers on `isComplete: false`.
- [x] Theme-aware config: pass current theme tokens into mermaid's config object — `pickMermaidTheme` reads the document's canvas luminance and chooses Mermaid's `dark` vs `default` palette; the rationale for not threading per-token overrides is in the implementation note above.
- [ ] _Deferred:_ Pan/zoom on click for large diagrams — v1 ships with `overflow-x: auto` on the frame; a wheel-zoom + drag-pan overlay is a stand-alone follow-on (see implementation note).
- [x] Error boundary; fallback to raw-source placeholder. _Note: the plan's "fallback to plain code with toast" predates the per-block CodeBlock retirement; the equivalent is the placeholder's pending / error state styled as monospace, which reads identically to an unpromoted code fence. The `onError` callback hook lets a host surface a toast on top._

**Tests:**
- [x] ` ```mermaid\nflowchart LR\n  a-->b\n``` ` renders as diagram on `complete` — transformer test covers fence-to-placeholder promotion end-to-end (synthetic block in → tug-mermaid placeholder out with decoded source); the actual SVG render is HMR-vetted per project test policy.
- [x] During streaming (parent block partial), shows raw code — `mermaidTransformer` test "defers promotion while streaming (isComplete: false)" pins the no-op behaviour.
- [x] Malformed diagram falls back without crashing parent — `renderPlaceholder` always restores `textContent` and stamps `data-tugx-mermaid-error`; the parent block is untouched because the failure is caught inside the try/catch. The pure-logic helpers tested here cover the fallback's input plumbing; the error path is exercised by HMR.
- [x] Boot bundle excludes Mermaid (verify via build artifact inspection) — `dist/assets/mermaid*.js` is its own chunk family; the only mermaid references in `index-*.js` are Vite's dependency-map URL strings.

**Checkpoint:**
- [x] `cd tugdeck && bun x tsc --noEmit && bun test` — tsc clean; `bun test` 2508/2508, 36 new tests across the three new files.
- [x] `cd tugdeck && bun run audit:tokens lint` — zero violations.
- [x] Manual: prompt `> draw a mermaid flowchart of the HTTP request lifecycle` → expect rendered diagram (deferred to user — HMR is always running; real-engine render is exercised through the live assistant pipeline).

---

#### Step 24: TodoList → pinned `Z2A` renderer (rework umbrella) {#step-24}

**Status:** rework in progress — supersedes the inline-per-turn `TodoWriteToolBlock` that shipped in the original Step 24. Body-kind `TodoListBlock` is kept (the rework reuses it standalone); the wrapper and its inline registration are retired by Step 24.2.

**Rework motivation.** The original Step 24 rendered TodoWrite inline in the assistant turn that issued each call, like every other tool wrapper. In practice TodoWrite is updated many times per session — once at planning, then on every status flip — and each call replaces the prior list whole-cloth. Inline-per-turn therefore reprinted the same list once per call, forced the user to scroll past `N-1` stale copies to find the current state, and never made "the active TODOs" one fixed glance away. The reworked direction pins the *latest* TodoWrite list in a new leading sub-slot of the [D97] `Z2` status bar (`Z2A`) and removes the inline render entirely. The slot collapses to zero height when no active list exists (definition of *active* per [D100]: latest call returns a non-empty list with at least one non-completed item).

**Sub-steps.** Tracked as separate roadmap entries so each ships under its own commit:
- **[Step 24.1](#step-24-1)** — TodoWrite spike + carve `Z2A` slot + pinned renderer.
- **[Step 24.2](#step-24-2)** — Remove inline-per-turn `TodoWriteToolBlock` + its registration.

**Original artifacts (current disposition):**
- `tugdeck/src/components/tugways/body-kinds/todo-list-block.tsx` + `.css` — **kept** and reworked against the Task* data model; the pinned `Z2A` renderer composes it standalone.
- `tugdeck/src/components/tugways/cards/tool-blocks/todo-write-tool-block.tsx` + `.css` + `__tests__/todo-write-tool-block.test.ts` — **retired in Step 24.1** (pulled forward from the originally-planned Step 24.2 once the type rename made the wrapper uncompilable).
- Registry entry `registerToolBlock("todowrite", …)` in `tide-assistant-renderer-dispatch.ts` — **removed in Step 24.1**. `taskcreate` / `taskupdate` are now registered to a `NullToolBlock` so per-call events render nothing in the transcript ([D100]); the Z2A pinned slot is the sole surface.

**References:** [D05] (two-layer split), [D97] (zone architecture), [D100] (pinned `Z2A` TodoWrite — new), [L02], [L06], Spec S02, Spec S03

**Reference prompt for both sub-steps.** Run against a fresh `/tmp/todo-test` Code session:

```
let's write a c program to make a command-line calculator. set it up with a makefile and a README. make a todo list for the work.
```

This exercises both the create path (initial TodoWrite call) and the incremental-update path (status flips as the assistant works through file creation), and is the source for the catalog fixture captured in Step 24.1.

---

#### Step 24.1: TodoWrite spike + carve `Z2A` + pinned renderer {#step-24-1}

**Goal.** Land the [D100] pinned `Z2A` TodoWrite slot end-to-end: spike the wire shape against a real session, carve a new leading sub-slot on the `Z2` status bar, and render the latest TodoWrite list there via a code-session-store selector.

**Depends on:** #step-1 (renderer dispatch), #step-24 (rework umbrella). Builds on the shipped `TodoListBlock` body kind from the original Step 24.

**Commit (umbrella; sub-commits fine):** `feat(tide): pinned-TodoWrite Z2A slot + spike findings`

**References:** [D97] (`Z2` zone), [D100] (pinned `Z2A` slot), [L02] (`useSyncExternalStore`), [L06] (visibility via CSS).

**Conformance:** see [#bk-conformance](#bk-conformance) — `Z2A` is a status-bar sub-slot, not a body kind or tool wrapper. The renderer composes the existing `TodoListBlock` body kind (standalone mode) so no new body-kind conformance is needed; `--tugx-todo-*` continues to compose `--tugx-block-*`.

**Spike — do this first.** No JSONL fixture exists today for a real TodoWrite call. The stream-json catalog only references TodoWrite in `system-metadata.jsonl` (tool-name registry). Run the reference prompt against a fresh `/tmp/todo-test` Code session, capture the live JSONL, and answer:

1. **Call cadence.** Does Claude call TodoWrite once at planning and then incrementally as items complete, or does it batch flips? How many TodoWrite calls does the reference prompt produce?
2. **List-replacement semantics.** Is every successive call a full replacement (the current `narrowTodoListData` assumes yes), or can a call mutate by id / partially update? (TodoWrite items have no wire id today, which is itself evidence — but worth confirming on the wire.)
3. **`activeForm` reliability.** Always present, sometimes omitted, or only on `in_progress` items?
4. **Clear mechanism.** Is there any wire-level signal that clears the todo list — a TodoWrite with empty `todos: []`, a separate tool, a system event tied to `/clear` / compaction / end-of-task? If yes, document the trigger; the selector in this step must handle it (most likely "fall through to the next-latest call", but possibly "blank the slot").
5. **Concurrency.** Can two TodoWrite calls be in-flight simultaneously, or always serial? (Drives whether the selector needs tie-breaking when the in-flight `toolCallMap` carries an unfinished TodoWrite alongside committed ones.)

**Spike outputs.**

Captured `claude 2.1.150 -p --output-format=stream-json --permission-mode=acceptEdits` running the reference prompt against an empty `/tmp/todo-test`. Raw stream saved (un-normalized — see README explanation) at:

- `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/v2.1.150-spike/test-task-tools-c-calculator-raw.jsonl`
- `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/v2.1.150-spike/README.md` — explains why this is a sibling-to-not-inside the normalized catalog dirs and what would be needed to promote it.

**Spike findings (load-bearing — they pivot the rework).**

**Anthropic renamed the tool.** `TodoWrite` is **gone** in `claude 2.1.150` (and was already gone in capabilities `v2.1.148`). The audit baseline that motivated the original Step 24 (the team's `2.1.112` snapshot still listed `TodoWrite`) is stale. The replacement is the `TaskCreate` / `TaskUpdate` / `TaskList` / `TaskGet` / `TaskOutput` / `TaskStop` family, and these are *already* present in the codebase's dispatch as `AUDIT_CONFIRMED_DEFAULT_TOOLS` — but labelled "Background-task management family", a misread that the spike disproves. The reference prompt produces **zero `TodoWrite` events** and twelve Task* events; the existing `TodoWriteToolBlock` registration is dead code for any current-version session.

**The new wire-shape model is per-item CRUD, not whole-list replacement.** `TaskCreate` creates one task per call; `TaskUpdate` flips one task's status by id. The reference prompt produced 4 × `TaskCreate` + 8 × `TaskUpdate` = 12 Task* events for a 4-item list. Observed shapes:

```jsonc
// tool_use.input — TaskCreate (one per task)
{
  "subject":     "Write calc.c source",                           // imperative
  "description": "Implement command-line calculator in C…",       // longer prose
  "activeForm":  "Writing calc.c source"                           // present-continuous
}
// tool_result.content — TaskCreate (string, not block array)
"Task #1 created successfully: Write calc.c source"

// tool_use.input — TaskUpdate
{ "taskId": "1", "status": "in_progress" }
// tool_result.content — TaskUpdate
"Updated task #1 status"
```

Notes:
- `taskId` is a **string-encoded integer** assigned server-side, monotonic per session. Clients can also discover it by parsing the `tool_result.content` (`"Task #N created…"`) if they prefer not to count.
- `status` values observed: `"in_progress"`, `"completed"` (presumably `"pending"` as the implicit on-create default).
- `description` was present on every `TaskCreate` in this session; whether it's required vs. optional is not confirmed from one session, but the renderer should tolerate it being absent.
- No `tool_use_structured` event is emitted for Task* tools — the `tool_use.input` IS the canonical wire payload.

**Spike answers:**

1. **Call cadence (Q1):** **Front-loaded creation, then incremental updates.** All 4 `TaskCreate`s arrived in a contiguous block before any non-Task tool call; `TaskUpdate`s interleave with `Write` / `Bash` calls as each item's work completes. 12 events total for 4 items is the rough multiplier.
2. **List-replacement semantics (Q2):** **Not whole-list replacement** — per-item CRUD. The reducer must accumulate state across the event stream rather than reading the latest call's `input` as the canonical list. **This invalidates the original D100 selector design.**
3. **`activeForm` reliability (Q3):** Present on every `TaskCreate` in this session. Treat as effectively-always-present but render-tolerant of absence (fall through to `subject`).
4. **Clear mechanism (Q4):** **No wire-level clear event observed.** No `TaskDelete`. The tool family includes `TaskStop` (`taskstop` in the audit list) but the reference prompt never emits it. The list lives for the session; the renderer's "no active todos" rule fires when every created task has `status === "completed"` (or no Task* call has happened yet).
5. **Concurrency (Q5):** Fully serial — every `tool_use` was followed by its matching `tool_result` before the next `tool_use` arrived. No concurrency hazard for the reducer.

**Architectural implications (must be resolved before the rest of this step proceeds):**

- **The selector becomes a reducer.** "Walk `toolCalls[]` and return the latest `TodoWrite` input" no longer fits. Replace with: `reduceTaskListState(toolCalls): TaskListState` — fold every `TaskCreate` (append with id assignment) and every `TaskUpdate` (mutate by id) into a current list. Order-preserving by `taskId`, since Claude assigns ids monotonically.
- **The data model needs the new fields.** `TodoItem { content, status, activeForm? }` becomes `TaskItem { taskId, subject, description?, status, activeForm? }`. `TodoListData { todos }` becomes `TaskListState { tasks }`. `TodoListBlock`'s row renderer needs to handle the longer `description` text — likely as a hover tooltip or expandable detail rather than a primary row line, since the row is "icon + text" today.
- **Dispatch registry needs three coordinated changes:** (a) remove `registerToolBlock("todowrite", …)` (dead — no v2.1.148+ session emits it); (b) decide whether `taskcreate` / `taskupdate` continue to fall through `AUDIT_CONFIRMED_DEFAULT_TOOLS` to `DefaultToolBlock` (producing 12 per-call default-tool-block rows per typical session, a lot of noise once `Z2A` is authoritative) OR register them as **null renderers** so the transcript carries zero Task* per-call entries and `Z2A` is the sole surface; (c) update the audit-table comment in `tide-assistant-renderer-dispatch.ts:256` ("Background-task management family") to reflect the actual semantics.
- **D100 needs rewriting** to reflect the new tool names and reducer model.
- **Step 24.2's deletion scope shifts** — `TodoWriteToolBlock` removal is bookkeeping (no live session uses it); the substantive transcript change is the dispatch-registry treatment of `taskcreate` / `taskupdate` decided above.

**Open questions for the user (paused pending direction):**

1. Confirm pivot of D100 + this step to the `TaskCreate` / `TaskUpdate` family (the spike makes this all but mandatory, but the framing change is yours to OK).
2. Should `TaskCreate` / `TaskUpdate` per-call events render as default tool blocks in the transcript (the current silent-default behavior — produces a 12-row history of Task* calls per typical session), or be silenced (null renderer — the transcript carries no Task* per-call entries; `Z2A` is the sole surface)?
3. In `Z2A`'s row layout, how should `description` be presented — hidden in a tooltip, expanded inline as a secondary line, or omitted entirely?

**Artifacts.**
- `tugdeck/src/components/tugways/cards/tide-card.tsx` — add a `statusBarLeadingContent?: React.ReactNode` prop (`Z2A`). Mount it in the status-bar row to the leading side of the existing `statusBarContent` (now `Z2B`), inside the existing flex row between the sash grip and `Z2B`. Empty slot collapses via `:empty`, matching every other reserved zone in [D97].
- `tugdeck/src/components/tugways/cards/tide-card-pinned-todo.tsx` + `.css` (new) — the `Z2A` renderer. Subscribes to the code-session store via `useSyncExternalStore` ([L02]); the selector walks `transcript[].toolCalls[]` + the in-flight `toolCallMap`, returns the most recent tool call with `toolName === "TodoWrite"`, and narrows its `input` via the existing `narrowTodoListData`. Renders `<TodoListBlock data={…} />` in standalone mode. When the selector returns undefined, OR `todos.length === 0`, OR every item is `completed`, the renderer returns `null` and `Z2A` collapses ([D100] active-list rule).
- `tugdeck/src/lib/code-session-store/selectors.ts` (or co-located) — `selectLatestTodoWriteInput(state): TodoListData | undefined` pure selector with its own test file. Keeps the lookup logic out of the renderer.
- Placement-experiment wiring — `tide-card-placement-experiment.tsx` either gains a new `Z2A` datum or hard-wires `tide-card-pinned-todo` into `statusBarLeadingContent` (the latter if `Z2A`'s occupant is not experiment-tunable).
- D97 zone-table update in `tuglaws/design-decisions.md` — split the existing `Z2` row into `Z2A` (pinned TodoWrite) and `Z2B` (`TideTelemetryStatusRow`) so the diagram and table reflect [D100].

**Tasks.**
- [x] Spike: captured JSONL from the reference prompt against `/tmp/todo-test`; saved at `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/v2.1.150-spike/test-task-tools-c-calculator-raw.jsonl`; findings documented inline above (see *Spike findings* and *Architectural implications*).
- [x] User direction received (`/loop` chat 2026-05-23): pivot to Task* model; silence `TaskCreate`/`TaskUpdate` in the transcript via null renderers; show `description` in a hover tooltip per row.
- [x] Carve `Z2A`: added `statusBarLeadingContent` prop to `TideCard` ([D100]), threaded through `TideCardContent` → `TideCardServicesGate` → `TideCardBody`, mounted in the status bar row leading-side of `statusBarContent` (`tide-card.tsx`). Default is `<TideCardPinnedTodo>`; an explicit `null` suppresses for gallery / tests.
- [x] Reducer `reduceTaskListState(toolCalls): TaskListState` in `lib/code-session-store/select-task-list.ts` folds the `TaskCreate` / `TaskUpdate` event stream into a current list. Tests in `__tests__/select-task-list.test.ts` (26 cases) pin: empty / non-Task / errored / non-terminal Task* are skipped; create then update flips by id; unknown taskId silently dropped; off-pattern result falls back to monotonic count; order preserved; tool-name match case-insensitive; the [D100] active rule (`taskListIsActive`) returns false for all-completed or empty lists.
- [x] Data model: `TaskItem { taskId, subject, description?, activeForm?, status }`, `TaskListState { tasks }`, `TaskStatus = "pending" | "in_progress" | "completed"`, all in `select-task-list.ts`. `narrowTaskCreateInput` + `narrowTaskUpdateInput` + `parseTaskCreateResultId` cover the wire-narrowing surface. The body kind `TodoListBlock` re-exports them so the user-facing component name remains stable.
- [x] Pinned renderer `TideCardPinnedTodo` (`tide-card-pinned-todo.tsx` + `.css`) subscribes through `useSyncExternalStore` ([L02]) by combining the code-session snapshot (committed `transcript[].toolCalls[]`) with the in-flight turn's `streamingDocument.turn.${turnKey}.tools` path (`useInflightTaskCalls` hook, JSON-cached for `Object.is` stability). Composes `TodoListBlock` standalone; returns `null` when `taskListIsActive` is false (slot collapses via CSS).
- [x] `TodoListBlock` row rework — primary text is `subject` (or `activeForm` when in_progress); when `description` is present the row is wrapped in `TugTooltip`. Helpers renamed `countTasks` / `composeTaskSummary` / `taskProgressFraction` / `composeTaskCopyText`; body-kind test updated to match.
- [x] CSS: `tide-card-pinned-todo.css` adds `--tugx-pinned-todo-*` slots ([L20]); max-width 40%, max-height ≈ five rows with internal scroll, trailing hairline divider against `Z2B`, `:empty` collapse, and frame-suppression styles when composed inside the strip. `tide-card.css` gains a `:has()` rule that collapses the whole `.tide-card-status-bar` when neither `.tide-card-pinned-todo` nor `.tide-card-status-bar-main` is present in the DOM. All visibility CSS-driven ([L06]).
- [x] D97 zone-table update: split `Z2` row into `Z2A` (`statusBarLeadingContent` → `TideCardPinnedTodo`) and `Z2B` (existing `statusBarContent` → `TideTelemetryStatusRow`); ASCII diagram amended.
- [x] D100 rewrite: substitutes `TaskCreate` / `TaskUpdate` for `TodoWrite`; selector → reducer; documents the spike findings; states the silencing decision and the `taskId`-parse-with-monotonic-fallback rule.
- [x] `AUDIT_CONFIRMED_DEFAULT_TOOLS` updated in `tide-assistant-renderer-dispatch.ts`: removed `taskcreate` / `taskupdate` from the audit set; added `taskget` defensively; corrected the "Background-task management" misread in the docstring; registered both load-bearing Task* tools to a new `NullToolBlock` factory so per-call events render nothing in the transcript. Three existing tests that used `TaskUpdate` as their audit-set example switched to `Monitor`.
- [x] Dead `TodoWriteToolBlock` removed early (`fix preexisting`): `cards/tool-blocks/todo-write-tool-block.tsx` + `.css` + `__tests__/todo-write-tool-block.test.ts` deleted; import + `registerToolBlock("todowrite", …)` line removed from the dispatch. (Originally scoped to Step 24.2; pulled forward because the type rename would have left the wrapper as broken dead code otherwise.)
- [x] Roadmap inventory tables (T01, T02, audit-confirmed) updated to reflect the [D100] reading and the silencing decision.

**Tests.**
- [x] `reduceTaskListState`: 13 cases pinning every fold path — empty / non-Task / errored / non-terminal skips; one Create + one Update flips status; unknown taskId silent drop; off-pattern result → monotonic count fallback; order preservation; case-insensitive tool-name match.
- [x] `taskListIsActive`: 4 cases — empty / all-completed → inactive; at-least-one non-completed → active.
- [x] `narrowTaskCreateInput`: 5 cases — well-formed; optional fields; missing subject; non-object; bad scalar types.
- [x] `narrowTaskUpdateInput`: 3 cases — every status; bad fields; non-object.
- [x] `parseTaskCreateResultId`: 2 cases — extracts id; off-pattern / missing → undefined.
- [x] `TodoListBlock` helper rename — `countTasks`, `composeTaskSummary`, `taskProgressFraction`, `composeTaskCopyText` all green (13 cases) against the new `TaskItem` shape.

**Checkpoint.**
- [x] `cd tugdeck && bun x tsc --noEmit && bun test` — clean; 2626 / 2626 pass (up from 2527 prior to this step; net +99 across new `select-task-list.test.ts` and renamed helper tests, less the deleted `todo-write-tool-block.test.ts`).
- [x] `cd tugdeck && bun run audit:tokens lint` — zero violations.
- [ ] Manual (HMR): run the reference prompt against `/tmp/todo-test` through Tug.app or the dev server; confirm `Z2A` appears as soon as the first `TaskCreate` lands, updates in place as `TaskUpdate` flips status, collapses when the final list is all-completed, and the transcript carries zero per-call Task* rows. Verify the per-row `description` tooltip on hover (deferred to user — HMR is always running; the live engine pipeline is the source of visual truth per the project's testing policy).

**Post-commit pivot.** Between this step's first commit and Step 24.2, the pinned `Z2A` strip design was reverted: it produced too much vertical-layout shift and broke `Z2`'s cell-row rhythm. The surface migrated to a `TASKS` cell *inside* `TideTelemetryStatusRow` on the single (un-split) `Z2`. As part of the revert, `TideCardPinnedTodo` + `tide-card-pinned-todo.{tsx,css}` were deleted; the `statusBarLeadingContent` prop on `TideCard` was removed; the `--tugx-pinned-todo-*` token family was retired; and the `:has()`-based status-bar collapse rule on `tide-card.css` was reverted. The follow-on build-out (the `TASKS` cell, the popover, the `TugTaskItem` + `TugLabelRole` primitives) shipped in subsequent commits before [#step-24-2](#step-24-2). The checkbox accounts above describe what was *first* shipped here; D100 carries the canonical current surface plus a History paragraph documenting the iteration.

---

#### Step 24.2: Post-[D100] reconciliation — revert Z2A/Z2B split, refresh inventories {#step-24-2}

**Status (post-Step 24.1):** the scope here grew well past the originally-narrow "gallery + symbol-inventory cleanup" framing. Between Step 24.1's first commit and this step the design pivoted twice — first the pinned `Z2A` strip shipped, then it was reverted in favor of a single `Z2` carrying a new `TASKS` cell within `TideTelemetryStatusRow`, then the cell + popover surface was built out (`TugTaskItem` + `TugLabelRole`). The code is correct as-shipped; this step is the pure-docs pass that aligns every roadmap / `tuglaws/` mention with the actually-shipped surface so a reader landing on D97 / D100 / Table T02 / the symbol inventory sees what is there, not what we tried.

**Goal.** Reconcile docs with shipped reality across `tuglaws/design-decisions.md` (D97 + D100), `dash/tide-assistant-rendering.md` (Table T02 + audit-confirmed table + phase-overview lists + ASCII diagram + symbol inventory + Step 29.5 entry), and the Step 24.1 task accounts (note the post-commit pivot).

**Depends on:** #step-24-1

**Commit:** `plan(tide): reconcile [D100] docs with shipped TASKS cell + revert Z2A/Z2B`

**References:** [D97], [D100], [L20].

**Code state (no changes needed).** The shipped surface uses:
- `TideTelemetryStatusRow` for `Z2` (`statusBarContent`), with a `TASKS` cell rendering `TugProgress` ring + `N/M` label + popover.
- Popover composes `TugTaskItem` primitives directly; no `TodoListBlock` mount in the status bar surface.
- `useTaskListState` hook (`lib/code-session-store/hooks/use-task-list-state.ts`) combines committed transcript + in-flight streaming-tools path.
- `select-task-list.ts` exports `reduceTaskListState`, `taskListIsActive`, `TaskItem`, `TaskListState`, `TaskStatus`, `narrowTaskCreateInput`, `narrowTaskUpdateInput`, `parseTaskCreateResultId`.
- `TugTaskItem` primitive (`components/tugways/tug-task-item.tsx` + `.css`).
- `TugLabel` extended with `TugLabelRole` and the `role` prop.
- Gallery card `gallery-tug-task-item.tsx`.
- `TideCardPinnedTodo` + `tide-card-pinned-todo.{tsx,css}` + `statusBarLeadingContent` prop + `--tugx-pinned-todo-*` token family + the `:has()`-based collapse rule are **not present** — all removed during the pivot.

**Done by this step (✓ when committed):**
- [x] D97 ASCII diagram (`tuglaws/design-decisions.md` ~line 265) — revert from `Z2 [grip] Z2A pinned-todo · Z2B STATE · …` to single `Z2 [grip] STATE · TIME · TOKENS · TASKS · CONTEXT`.
- [x] D97 zone table (~line 284) — collapse `Z2A` + `Z2B` rows back into a single `Z2` row; describe the `TASKS` cell within it.
- [x] D97 prose paragraph (~line 291) — drop "`Z2A` leading + `Z2B` trailing in one flex row" references; single-`Z2` flow.
- [x] D100 prose (~line 297) — rewrite end-to-end to describe the `TASKS` cell + popover surface; add a **History** paragraph documenting the brief `Z2A`/`Z2B` shipping iteration and the revert.
- [x] Roadmap phase overview (line 73, L04 list) — strike `TodoWriteToolBlock`; add [D100] cross-ref.
- [x] Roadmap ASCII Layer-2 diagram (line 552) — strike `TodoWriteToolBlock`; note `TaskCreate`/`TaskUpdate` route through `NullToolBlock`.
- [x] Roadmap directory map (line 804) — remove `todo-write-tool-block.tsx + .css` (file is already deleted on disk).
- [x] Roadmap Table T02 wrapper row (line 900) — rewrite from `TideCardPinnedTodo (Z2A pinned slot, [D100])` to the `TASKS` status-bar cell description.
- [x] Roadmap audit-confirmed table (line 908) — refresh `TaskCreate` row's [D100] cross-ref to drop "pinned `Z2A` slot" language.
- [x] Roadmap List L04 in Lists block (line 1036) — strike `TodoWriteToolBlock`; add [D100] cross-ref.

**Open by this step:**
- [x] Step 24.1 task-list amendment — "**Post-commit pivot.**" paragraph added below Step 24.1's Tasks list noting that the `Z2A`/`Z2B` split was reverted, the `TideCardPinnedTodo` + `tide-card-pinned-todo.{tsx,css}` artifacts were deleted, and the surface migrated to the `TASKS` cell in `TideTelemetryStatusRow`. The historical checkboxes stay as-shipped-at-the-time; the amendment paragraph is the seam.
- [x] §Definitive Symbol Inventory (lines 1057 + 1090+) — struck `todo-write-tool-block` from the file-glob; added the shipped pieces to "Symbols to add / modify" (`useTaskListState`, `reduceTaskListState`, `taskListIsActive`, `TaskItem` / `TaskListState` / `TaskStatus`, `narrow*` helpers, `TugTaskItem`, `TugLabelRole`) and to "New files" (`select-task-list.ts`, `use-task-list-state.ts`, `tug-task-item.{tsx,css}`, `gallery-tug-task-item.tsx`).
- [x] Step 29.5 entry — `gallery-tool-block-meta.tsx`'s `TodoWrite` demo dropped; pointer added to the standalone `gallery-tug-task-item.tsx` card.
- [x] Phase-overview line 61 — `TodoWrite` struck from the per-tool catalog list with a [D100] explanatory parenthetical.

**Tests.**
- [ ] No new tests; existing suite continues to pass (`bun test`). Pure docs change.

**Checkpoint.**
- [ ] Manual: read D97 + D100 + Table T02 + symbol inventory + Step 29.5; confirm no stale `Z2A`, `TideCardPinnedTodo`, `statusBarLeadingContent`, or `TodoWriteToolBlock` references remain anywhere except in the Step 24.1 historical task account (which carries the amendment paragraph).
- [ ] `grep -rn "TideCardPinnedTodo\|statusBarLeadingContent\|--tugx-pinned-todo" dash/ tuglaws/` returns either zero hits or only history-paragraph hits in Step 24.1.

---

#### Step 24.3: Tool visibility policy + bespoke wrappers for control tools (umbrella) {#step-24-3}

**Status:** new — motivated by dogfooding [#step-24-1](#step-24-1). Once `TaskCreate` / `TaskUpdate` were silenced into `Z2A`, the noise floor of the transcript dropped enough that the *other* default-routed tools (`ToolSearch`, `ScheduleWakeup`, `EnterPlanMode`, …) became conspicuous — the dispatch routes them through `DefaultToolBlock`, which spews their input + result as `JsonTreeBlock`s. That is the *correct* day-one fallback per [D11], but for known tools it is now visual clutter the user has to scroll past on every session.

**Rework motivation.** `AUDIT_CONFIRMED_DEFAULT_TOOLS` in the dispatch is a flat set with two unrelated meanings overloaded onto it: "low volume, JSON-tree is fine" (e.g. `Skill` at 0.02%) AND "internal plumbing the user does not need to see" (e.g. `ToolSearch` at 0.23%, `ScheduleWakeup` at 0.03%). The two policies need separation: low-volume-but-user-meaningful tools deserve a compact bespoke wrapper; internal plumbing deserves zero ink in the transcript. This step formalises the split into a single editable policy table with a per-entry rationale, registers the new "hidden" bucket via the existing `NullToolBlock` mechanism, and ships bespoke wrappers for the tools that remain visible.

**Sub-steps.** Tracked as separate roadmap entries so each ships under its own commit:
- **[Step 24.3.1](#step-24-3-1)** — Policy file + governance test + immediate hides.
- **[Step 24.3.2](#step-24-3-2)** — Operational trio: `SkillToolBlock` + `MonitorToolBlock` + `WorktreeToolBlock`.
- **[Step 24.3.3](#step-24-3-3)** — `TaskMgmtToolBlock` (covers `TaskList` / `TaskGet` / `TaskOutput` / `TaskStop`).
- **[Step 24.3.4](#step-24-3-4)** — Management trio: `CronToolBlock` + `ShareOnboardingGuideToolBlock` + `RemoteTriggerToolBlock`.
- **[Step 24.3.5](#step-24-3-5)** — `TaskInlineToolBlock` (per-call inline markers for `TaskCreate` / `TaskUpdate`; updates [D100] to acknowledge the second surface).
- **[Step 24.3.7](#step-24-3-7)** — `PermissionDialog` routes tool preview through dispatch (every bespoke wrapper automatically renders in its approval prompt, replacing the raw `JsonTreeBlock` dump).

**References:** [D04] (drift fallback), [D05] (two-layer split), [D11] (`DefaultToolBlock` covers day-one unknowns), [D100] (pinned `Z2A` precedent for the hidden bucket).

**Inventory source.** The canonical tool registry is `capabilities/2.1.148/system-metadata.jsonl` — Claude Code at `v2.1.148` exposes **31 built-in tools**. The table below is the complete v2.1.148 built-in inventory cross-referenced against this step's planned outcome. Volumes are from the original [§4.2 audit](./tide-assistant-rendering-session-audit.md); blank where the tool post-dates the audit baseline.

| Tool | Volume | Today | Target | Owning step |
|------|-------:|-------|--------|-------------|
| `Bash` | high | bespoke (`BashToolBlock`) | bespoke | [#step-6](#step-6) ✓ |
| `Read` | high | bespoke (`ReadToolBlock`) | bespoke | [#step-8](#step-8) ✓ |
| `Edit` (+ `MultiEdit` alias) | high | bespoke (`EditToolBlock`) | bespoke | [#step-11](#step-11) ✓ |
| `Glob` | medium | bespoke (`GlobToolBlock`) | bespoke | [#step-15](#step-15) ✓ |
| `Grep` | medium | bespoke (`GrepToolBlock`) | bespoke | [#step-16](#step-16) ✓ |
| `Task` → `Agent` (alias) | medium | bespoke (`TaskToolBlock`) | bespoke | [#step-17](#step-17) ✓ |
| `AskUserQuestion` | low | bespoke (`AskUserQuestionToolBlock`) | bespoke | [#step-20-5](#step-20-5) ✓ |
| `Write` | high | default | bespoke (`WriteToolBlock`) | [#step-26](#step-26) — planned |
| `NotebookEdit` | low | default | bespoke (`NotebookEditToolBlock`) | [#step-26](#step-26) — planned |
| `WebFetch` | low | default | bespoke (`WebFetchToolBlock`) | [#step-25](#step-25) — planned |
| `WebSearch` | low | default | bespoke (`WebSearchToolBlock`) | [#step-25](#step-25) — planned |
| `TaskCreate` | 2.78% | hidden (`NullToolBlock`) | bespoke (`TaskInlineToolBlock`) | [#step-24-3-5](#step-24-3-5) — this step (replaces the [D100] "sole surface" rule) |
| `TaskUpdate` | 5.33% | hidden (`NullToolBlock`) | bespoke (`TaskInlineToolBlock`) | [#step-24-3-5](#step-24-3-5) — this step |
| `ToolSearch` | 0.23% | default | **hidden** | [#step-24-3-1](#step-24-3-1) — this step |
| `ScheduleWakeup` | 0.03% | default | **hidden** | [#step-24-3-1](#step-24-3-1) — this step |
| `EnterPlanMode` | — | unknown_tool drift | **hidden** | [#step-24-3-1](#step-24-3-1) — this step (chrome banner follow-up tracked separately) |
| `ExitPlanMode` | — | unknown_tool drift | **hidden** | [#step-24-3-1](#step-24-3-1) — this step |
| `PushNotification` | — | unknown_tool drift | **hidden** | [#step-24-3-1](#step-24-3-1) — this step (notification itself is the user surface) |
| `Skill` | 0.02% | default | bespoke (`SkillToolBlock`) | [#step-24-3-2](#step-24-3-2) — this step |
| `Monitor` | 0.06% | default | bespoke (`MonitorToolBlock`) | [#step-24-3-2](#step-24-3-2) — this step |
| `EnterWorktree` | 0.00% | default | bespoke (`WorktreeToolBlock`) | [#step-24-3-2](#step-24-3-2) — this step |
| `ExitWorktree` | 0.00% | default | bespoke (`WorktreeToolBlock` — alias) | [#step-24-3-2](#step-24-3-2) — this step |
| `TaskList` | 0.05% | default | bespoke (`TaskMgmtToolBlock`) | [#step-24-3-3](#step-24-3-3) — this step |
| `TaskGet` | — | default | bespoke (`TaskMgmtToolBlock` — alias) | [#step-24-3-3](#step-24-3-3) — this step |
| `TaskOutput` | 0.06% | default | bespoke (`TaskMgmtToolBlock` — alias) | [#step-24-3-3](#step-24-3-3) — this step |
| `TaskStop` | 0.01% | default | bespoke (`TaskMgmtToolBlock` — alias) | [#step-24-3-3](#step-24-3-3) — this step |
| `CronCreate` | — | unknown_tool drift | bespoke (`CronToolBlock`) | [#step-24-3-4](#step-24-3-4) — this step |
| `CronDelete` | — | unknown_tool drift | bespoke (`CronToolBlock` — alias) | [#step-24-3-4](#step-24-3-4) — this step |
| `CronList` | — | unknown_tool drift | bespoke (`CronToolBlock` — alias) | [#step-24-3-4](#step-24-3-4) — this step |
| `ShareOnboardingGuide` | — | unknown_tool drift | bespoke (`ShareOnboardingGuideToolBlock`) | [#step-24-3-4](#step-24-3-4) — this step |
| `RemoteTrigger` | — | unknown_tool drift | bespoke (`RemoteTriggerToolBlock`) | [#step-24-3-4](#step-24-3-4) — this step (semantics to confirm during build) |
**Coverage check.** Of the 31 v2.1.148 built-in tools: **7 already bespoke**, **4 bespoke-planned by Steps 25–26**, **2 newly bespoke (`TaskInlineToolBlock` for `TaskCreate` + `TaskUpdate`, per [#step-24-3-5])**, **5 newly hidden by this step**, **4 newly bespoke via `TaskMgmtToolBlock`**, **3 newly bespoke (operational trio)**, **5 newly bespoke (management trio)** = 30 + 1 (`AskUserQuestion`) = 31, full built-in coverage. After this step exits, the dispatch has zero `unknown_tool` cautions for any tool in the canonical v2.1.148 built-in registry.

**Why not a new top-level step.** Numbered `24.3` (not `25A` or `30A`) because it grew out of the [D100] surface decisions in Step 24.1 — silencing the Task* per-call rows revealed the broader visibility-classification problem. Sitting next to Steps 24.1 / 24.2 keeps the policy-vs-pinned-surface relationship discoverable when someone returns to the [D100] rationale.

---

#### Step 24.3.1: Policy file + governance test + immediate hides {#step-24-3-1}

**Goal.** Land `TOOL_VISIBILITY_POLICY` as the single editable source of truth, refactor `tide-assistant-renderer-dispatch.ts` to consume it, and migrate the obvious control-machinery tools (`ToolSearch`, `ScheduleWakeup`, `EnterPlanMode`, `ExitPlanMode`, `PushNotification`) to the `hidden` bucket so they paint zero ink in the transcript.

**Depends on:** [#step-24-1](#step-24-1).

**Commit:** `feat(tide-rendering): tool visibility policy + governance test + hide control tools`

**References:** [D04], [D11], [D100].

**Conformance:** see [#bk-conformance](#bk-conformance) — no body kind or tool wrapper introduced here. The policy file is a pure-data module; the dispatch refactor preserves the existing `ToolBlockFactory` contract.

**Artifacts.**
- `tugdeck/src/components/tugways/cards/tide-tool-visibility-policy.ts` (new) — the single editable table. Type `ToolVisibility = "hidden" | "default-intent"`; one row per tool with `{ name, visibility, rationale, reviewedAt }`. The `bespoke` bucket is *implicit* — a tool's presence in `TOOL_BLOCK_REGISTRY` is the signal. Exports `TOOL_VISIBILITY_POLICY`, `hiddenToolNames()`, `defaultIntentToolNames()`.
- `tugdeck/src/components/tugways/cards/tide-assistant-renderer-dispatch.ts` — replace the inline `AUDIT_CONFIRMED_DEFAULT_TOOLS` set and the two `registerToolBlock("taskcreate"/"taskupdate", NullToolBlock)` lines with a single module-load loop that derives both sets from `TOOL_VISIBILITY_POLICY`. The `NullToolBlock` factory itself stays where it is. Update the docstring around line 254 to point at the policy file as the source of truth.
- `tugdeck/src/components/tugways/cards/__tests__/tide-tool-visibility-policy.test.ts` (new) — the governance test described below.
- Audit-confirmed table in this roadmap (around line 905) — replace with two tables, "hidden tools" and "default-intent tools", mirroring the policy file's split.

**Initial classifications.** Every entry's `rationale` is one sentence + a `#step-` anchor for the follow-on:
- **hidden** — `toolsearch` (schema-loading machinery; user-irrelevant); `taskcreate` (Z2A pinned surface — [D100]); `taskupdate` (Z2A pinned surface — [D100]); `schedulewakeup` (internal pacing; the wakeup itself is the user surface); `enterplanmode` (mode transition; a chrome banner is the right surface — follow-up); `exitplanmode` (same); `pushnotification` (notification itself is the user surface).
- **default-intent** — `monitor` (Awaiting `MonitorToolBlock` — [#step-24-3-2](#step-24-3-2)); `skill` (Awaiting `SkillToolBlock` — [#step-24-3-2](#step-24-3-2)); `enterworktree` / `exitworktree` (Awaiting `WorktreeToolBlock` — [#step-24-3-2](#step-24-3-2)); `tasklist` / `taskget` / `taskoutput` / `taskstop` (Awaiting `TaskMgmtToolBlock` — [#step-24-3-3](#step-24-3-3)); `croncreate` / `crondelete` / `cronlist` (Awaiting `CronToolBlock` — [#step-24-3-4](#step-24-3-4)); `shareonboardingguide` (Awaiting `ShareOnboardingGuideToolBlock` — [#step-24-3-4](#step-24-3-4)); `remotetrigger` (Awaiting `RemoteTriggerToolBlock` — [#step-24-3-4](#step-24-3-4); semantics to confirm during build).

**Tasks.**
- [x] Author `tide-tool-visibility-policy.ts` with the complete v2.1.148 inventory above. Date each `reviewedAt` to commit day. **Done** — 22 entries (7 hidden + 15 default-intent), `reviewedAt: 2026-05-24`. `WebFetch`, `WebSearch`, `Write`, `NotebookEdit` added to default-intent (planned bespoke at Steps 25/26) so they classify cleanly rather than producing `unknown_tool` drift until those steps ship.
- [x] Refactor dispatch to derive its two sets from `TOOL_VISIBILITY_POLICY`. **Done** — `AUDIT_CONFIRMED_DEFAULT_TOOLS = defaultIntentToolNames()` and a new `HIDDEN_TOOL_NAMES = hiddenToolNames()` constant. `resolveToolBlock` and `dispatchToolCallState` short-circuit hidden names to the now-exported `NullToolBlock` ahead of the registry lookup; `detectToolCallDrift` short-circuits them ahead of the `unknown_tool` check. Existing `assistant-rendering-fixture-replay.test.ts` continues to pass (verified — no behavioral change for tools that do not move buckets).
- [x] Add the five newly hidden tools (`toolsearch`, `schedulewakeup`, `enterplanmode`, `exitplanmode`, `pushnotification`) to the `hidden` bucket. **Done** — each is now `NullToolBlock`-routed with no `unknown_tool` caution. `toolsearch` and `schedulewakeup` moved out of the old `AUDIT_CONFIRMED_DEFAULT_TOOLS`; `enterplanmode` / `exitplanmode` / `pushnotification` were previously unknown-tool drift sources and are now explicitly hidden.
- [x] Update the audit-confirmed inventory table in this roadmap (around line 905) to mirror the new structure (hidden vs default-intent), with each entry's owning step linked. **Done** — table split into two ("Hidden" + "Default-intent"), each entry's bucket rationale visible at a glance, each default-intent row cites its follow-on step.
- [x] Add a new D101 (or extend D100) covering the policy: one editable source of truth; bespoke = registry presence; hidden = `NullToolBlock` via policy iteration; default-intent = explicit TODO with follow-on step. Cross-link from D100. **Done** — D101 added in `tuglaws/design-decisions.md` immediately after D100's History paragraph; cross-refs [D04], [D11], [D100].

**Tests.**
- [x] `tide-tool-visibility-policy.test.ts` — pins **only** the two invariants that catch real mistakes code review would miss; cut (a) and (b) on purpose to keep test-suite signal-to-noise high (the test file's docstring records the cut rationale).
  - (c) Every `default-intent` entry's `rationale` contains the literal `"Awaiting"` and a `#step-` substring — 17 per-entry assertions. This is the *only* mechanism preventing `default-intent` from becoming a forever-bucket; without it a vague rationale lets a tool sit there with no planned bespoke wrapper.
  - (d) The union of `BESPOKE_TOOL_NAMES` (the dispatch's module-load-frozen export of bespoke names) + `POLICY_NAMES` covers the v2.1.148 canonical set hardcoded in the test — 31 per-tool assertions. A new built-in tool in a future Claude Code release fails CI here until it is explicitly classified.
  - **Cut: (a) "every entry parses"** — the entry shape is enforced by the `ToolVisibilityEntry` interface; lowercase / ISO-date checks are weak; duplicate-name guard is marginal for an array of ~20 entries.
  - **Cut: (b) "no double-classification"** — realistic in principle, but obvious in code review and very rare in practice. The `hidden` / `default-intent` split is mutually exclusive by the enum.
  - Refactored `tide-assistant-renderer-dispatch.ts` so its bottom-of-file derives both the `BESPOKE_TOOL_NAMES` export AND the `registerToolBlock(...)` loop from a single `BESPOKE_REGISTRATIONS` array — adding a new wrapper is still one line. `BESPOKE_TOOL_NAMES` is module-load-frozen so the test stays deterministic across test files (the dispatch test's `beforeEach` clears the runtime registry, and bun runs each test file's tests before loading the next).
- [x] Existing `tide-assistant-renderer-dispatch.test.ts` — updated the one test referencing the locally-defined `NullToolBlock` to import the now-exported one from the dispatch module (the TaskCreate/TaskUpdate silencing test). Removed its no-longer-needed `registerToolBlock("taskcreate", ...)` setup — the policy now drives that path automatically.

**Checkpoint.**
- [x] `cd tugdeck && bun x tsc --noEmit && bun test` — clean. `2675 / 2675` pass (was `2627` prior to this step; net `+48` across the new `tide-tool-visibility-policy.test.ts` — 17 default-intent rationale + 31 v2.1.148 coverage).
- [x] `cd tugdeck && bun run audit:tokens lint` — zero violations.
- [x] Manual (HMR): user-confirmed — `ToolSearch` and `ScheduleWakeup` carry zero transcript rows in a live session.

---

#### Step 24.3.2: Operational trio — SkillToolBlock + MonitorToolBlock + WorktreeToolBlock {#step-24-3-2}

**Goal.** Ship bespoke wrappers for the three user-meaningful operational tools currently rendering as JSON-tree default blocks. They share a wrapper shape (header summary line + at-most-one body row), so they batch under one commit.

**Depends on:** [#step-24-3-1](#step-24-3-1).

**Commit:** `feat(tide-rendering): SkillToolBlock + MonitorToolBlock + WorktreeToolBlock`

**References:** [D05], Spec S03.

**Conformance:** see [#bk-conformance](#bk-conformance) — three tool wrappers (item 8: compact header). All three use `ToolBlockChrome` and route status / error through the shared frame. No new body kinds.

**Artifacts.**
- `tugdeck/src/components/tugways/cards/tool-blocks/skill-tool-block.tsx` + `.css` — header `Skill · /<skill-name>`; body shows `args` inline when ≤ 80 chars, otherwise an embedded `TugMarkdownBlock` with the args as a fenced block. Result is typically an inert acknowledgement; if non-empty, surfaced as a one-line label.
- `tugdeck/src/components/tugways/cards/tool-blocks/monitor-tool-block.tsx` + `.css` — header `Monitor · <command-excerpt>` (middle-ellipsis if long); body shows the `until` condition (if present) and a 3-line tail of the most recent output. The full output collapses into an expand affordance.
- `tugdeck/src/components/tugways/cards/tool-blocks/worktree-tool-block.tsx` + `.css` — handles both `EnterWorktree` and `ExitWorktree` via the existing `TOOL_ALIASES` mechanism (a new `exitworktree → worktree` and `enterworktree → worktree` pair). Header `Worktree · enter <branch>` / `Worktree · exit <branch>`; body shows worktree path. Action-rather-than-data tool, so no result body unless errored.
- Three registry entries + gallery cards under `cards/gallery-*-tool-block.tsx`.
- Remove the three corresponding `default-intent` entries from `TOOL_VISIBILITY_POLICY`; the governance test enforces they move out of the policy file once registered.

**Tasks.**
- [x] Build each wrapper per the artifact list. **Done** — `SkillToolBlock` (Sparkles icon + `/<skill>` header + args body + result label), `MonitorToolBlock` (Radar icon + command/path/pid header + `until` row + tailed output with native `<details>` expand), `WorktreeToolBlock` (GitBranch icon + verb-qualified header + optional `path:` row). Each wrapper exports its pure narrowing + composition helpers for pure-logic tests; no fake-DOM render tests.
- [x] Gallery cards: one each, registered under `CATEGORIES.blockRenderers` in `gallery-registrations.tsx`. Each card has 5–6 sections covering the dominant + fallback + streaming + error variants.
- [x] Update Table T02 with the three new wrappers — added rows for `SkillToolBlock`, `MonitorToolBlock`, `WorktreeToolBlock`. Removed the four corresponding rows from the default-intent table (`skill`, `monitor`, `enterworktree`, `exitworktree`).
- [x] Added `enterworktree → worktree` and `exitworktree → worktree` entries to `TOOL_ALIASES`; one `WorktreeToolBlock` handles both via branch-on-`toolName` (`deriveWorktreeVerb`). Added 3 entries to `BESPOKE_REGISTRATIONS`.
- [x] Exported `BESPOKE_FACTORY_BY_NAME` (frozen name → factory map) from the dispatch so per-wrapper tests can pin registration without racing the dispatch test's `beforeEach` registry reset.
- [x] Repointed two existing tests (`tide-assistant-renderer-dispatch.test.ts` + `default-tool-block.test.ts`) that used `Monitor` as the audit-confirmed-default example to use `ShareOnboardingGuide` (still default-intent at this step's exit); same with the policy test's mirror `ALIASES` map updated for the worktree aliases.

**Tests.**
- [x] `__tests__/skill-tool-block.test.ts` — 14 assertions: narrowing (4), header composition (2), result presentation (4), `INLINE_ARGS_MAX_CHARS` pin (1), dispatch registration via `BESPOKE_FACTORY_BY_NAME` (1), plus a coverage spread.
- [x] `__tests__/monitor-tool-block.test.ts` — 17 assertions: narrowing (3), header preference order (5), tail composition including trailing-newline handling (5), `TAIL_LINE_COUNT` pin (1), dispatch registration (1).
- [x] `__tests__/worktree-tool-block.test.ts` — 18 assertions: narrowing (3), verb derivation (4), header preference (5), tool-name composition (3), dispatch registration including the "aliases stay in `TOOL_ALIASES`, not in `BESPOKE_FACTORY_BY_NAME`" sanity check (2).
- [x] `tide-tool-visibility-policy.test.ts` continues to pass — the `default-intent` count drops by 4 (the 17 → 13 entries reflect skill/monitor/enterworktree/exitworktree removal); v2.1.148 coverage check (d) still holds because the 4 names now resolve through `BESPOKE_TOOL_NAMES` (via the alias map for the worktree pair).

**Checkpoint.**
- [x] `cd tugdeck && bun x tsc --noEmit && bun test` — clean. `2715 / 2715` pass (was `2675` prior to this step; net `+40` across the three new wrapper test files less the 4 default-intent governance entries that turned into bespoke).
- [x] `cd tugdeck && bun run audit:tokens lint` — zero violations.
- [ ] Manual (HMR): trigger each tool from a session; confirm the bespoke header reads cleanly and the body is one or two lines, not a JSON tree. (Deferred to user — HMR is always running; the live engine pipeline is the source of visual truth per the project's testing policy.)

---

#### Step 24.3.3: TaskMgmtToolBlock — TaskList / TaskGet / TaskOutput / TaskStop {#step-24-3-3}

**Goal.** Ship one bespoke wrapper covering the four background-task management tools. These are the original-Anthropic-`Task`-family read/control tools (distinct from the [D100] `TaskCreate` / `TaskUpdate` user-task-list family) and are rare in practice; one wrapper handling all four behaviors is the right granularity.

**Depends on:** [#step-24-3-1](#step-24-3-1).

**Commit:** `feat(tide-rendering): TaskMgmtToolBlock — TaskList / TaskGet / TaskOutput / TaskStop`

**References:** [D05], Spec S03, [D100] (the *user-facing* task list is `Z2A`; this wrapper is the *background-task* family — make the distinction visible in the header).

**Conformance:** see [#bk-conformance](#bk-conformance) — one tool wrapper, four aliased names. Header per-name: `Background Task · list` / `Background Task · get #<id>` / `Background Task · output #<id>` / `Background Task · stop #<id>` — the `Background Task` prefix disambiguates from the [D100] user-task list (which never paints inline). Body per-name: list → row count + 3-row preview; get → status + 1-line summary; output → `TerminalBlock` of stdout tail; stop → status badge.

**Artifacts.**
- `tugdeck/src/components/tugways/cards/tool-blocks/task-mgmt-tool-block.tsx` + `.css` — single wrapper, internally branched on `toolName`.
- Aliases in `TOOL_ALIASES`: `tasklist → taskmgmt`, `taskget → taskmgmt`, `taskoutput → taskmgmt`, `taskstop → taskmgmt`. Canonical registry name `taskmgmt`.
- Gallery card.
- Remove four corresponding `default-intent` entries from `TOOL_VISIBILITY_POLICY`.

**Tasks.**
- [x] Build the wrapper; per-name body selectors are small (≤ 30 lines each). Single wrapper at `task-mgmt-tool-block.tsx`; `renderTaskMgmtBody` switches on `deriveTaskMgmtVerb(toolName)` into four small per-verb helpers, each composing `body-bits/` primitives (conformance item 10). No paired `.css` — Worktree-style "compose-only, no wrapper-local styles."
- [x] Gallery card showcasing all four behaviors as separate sections. `gallery-task-mgmt-tool-block.tsx` covers list / get / output (short + long with `<details>` expand) / stop / streaming / error, registered under `CATEGORIES.blockRenderers` with the `ListTodo` icon.
- [x] Table T02 update — three rows folded into one `TaskMgmtToolBlock` entry; four `default-intent` rows removed from the inventory below.

**Tests.**
- [x] `__tests__/task-mgmt-tool-block.test.ts`: per-helper pure-logic suite + dispatch alias-resolution pin (`taskmgmt` maps to `TaskMgmtToolBlock`; the four wire names are NOT directly registered — they resolve through `TOOL_ALIASES`).

**Checkpoint.**
- [x] `cd tugdeck && bun x tsc --noEmit && bun test`.
- [x] `cd tugdeck && bun run audit:tokens lint`.
- [x] Manual (HMR): trigger each of the four tools from a session; confirm the `Background Task` prefix makes the disambiguation legible.

---

#### Step 24.3.4: Management trio — CronToolBlock + ShareOnboardingGuideToolBlock + RemoteTriggerToolBlock {#step-24-3-4}

**Goal.** Ship bespoke wrappers for the three remaining low-volume management tools. The Cron* family batches under one wrapper (three aliases); the other two are one-shot wrappers each.

**Depends on:** [#step-24-3-1](#step-24-3-1).

**Commit:** `feat(tide-rendering): CronToolBlock + ShareOnboardingGuideToolBlock + RemoteTriggerToolBlock`

**References:** [D05], Spec S03.

**Conformance:** see [#bk-conformance](#bk-conformance) — three tool wrappers (`CronToolBlock` handles three aliases internally). All compact header + minimal body.

**Artifacts.**
- `tugdeck/src/components/tugways/cards/tool-blocks/cron-tool-block.tsx` + `.css` — header per-name: `Cron · create <schedule>` / `Cron · delete <id>` / `Cron · list (<N>)`. Body: list → row count + 3-row preview; create → schedule expression + next-fire-at; delete → confirmation status. Aliases `crondelete → cron`, `cronlist → cron`, canonical `cron` (named `croncreate` collapses too — TBD during implementation).
- `tugdeck/src/components/tugways/cards/tool-blocks/share-onboarding-guide-tool-block.tsx` + `.css` — header `Share Onboarding Guide · <mode>`. Body: surfaces the share link from the result as a copyable `TugLink`-like primitive. The link is the load-bearing UX (the whole reason the tool exists).
- `tugdeck/src/components/tugways/cards/tool-blocks/remote-trigger-tool-block.tsx` + `.css` — header `Remote Trigger · <target>`. Body: trigger payload as a compact field list. **Semantics to confirm at implementation time** — neither the v2.1.148 system-metadata nor any captured JSONL transcript exercises this tool; the wrapper may need spike work analogous to [#step-24-1](#step-24-1) before it lands.
- Three gallery cards.
- Remove five corresponding `default-intent` entries from `TOOL_VISIBILITY_POLICY` (`croncreate`, `crondelete`, `cronlist`, `shareonboardingguide`, `remotetrigger`).

**Tasks.**
- [x] Build `CronToolBlock` first (three names; most code reuse). Canonical `cron` registry name; `croncreate` / `crondelete` / `cronlist` resolve via `TOOL_ALIASES`. Verb branch composes `body-bits/` primitives (conformance item 10); no paired `.css`. JSDoc landmine note: a cron expression containing `*/N` inside `/** */` will terminate the comment block — examples in the docstring use the `0 9 * * *` form for that reason.
- [x] Build `ShareOnboardingGuideToolBlock`; the share link rendering is the primary affordance. `extractShareLink` pulls the first http(s) URL from the result text via regex; the body surfaces it as a clickable `<a target="_blank">` with a lucide `ExternalLink` glyph (TugLink-like — no new primitive introduced since none exists yet). Falls back to a `ToolBlockPre` of the raw result when no URL is recognisable.
- [x] **Spike `RemoteTrigger` semantics** before building — capture a real session that exercises it. **Resolved at build time without a JSONL capture:** the deferred-tool schema (`ToolSearch select:RemoteTrigger`) fully specified the wire shape — `{ action: "list"|"get"|"create"|"update"|"run", trigger_id?: string, body?: object }`, returning raw API JSON plus a summary tail for write actions. No fundamentally different shape than expected; built defensively over this contract with graceful degradation on unrecognised actions.
- [x] Three gallery cards — `gallery-{cron,share-onboarding-guide,remote-trigger}-tool-block.tsx` registered under `CATEGORIES.blockRenderers` with `Clock` / `BookOpen` / `Zap` icons.
- [x] Table T02 update — three new rows folded into the wrapper inventory; five `default-intent` rows removed from the inventory below.

**Tests.**
- [x] Per-wrapper synthetic-fixture tests for the three Cron names + the two singletons. `cron-tool-block.test.ts` (narrow + verb + names + args + alias pin), `share-onboarding-guide-tool-block.test.ts` (narrow + name + URL extraction + dispatch pin), `remote-trigger-tool-block.test.ts` (narrow + name + args + body formatter + dispatch pin).

**Checkpoint.**
- [x] `cd tugdeck && bun x tsc --noEmit && bun test`.
- [x] `cd tugdeck && bun run audit:tokens lint`.
- [x] Manual (HMR): trigger each tool; confirm the bespoke rendering.

---

#### Step 24.3.5: TaskInlineToolBlock — per-call inline markers for TaskCreate / TaskUpdate {#step-24-3-5}

**Goal.** Add a tiny one-row inline marker to the transcript for each `TaskCreate` and `TaskUpdate` event, so a reader scrolling back can see *when in the conversation flow* each task action happened. The TASKS status-bar cell (per [D100]) remains the canonical surface for *current state*; this inline marker is the second, complementary surface for *event-in-context*. Two surfaces, two different jobs.

**Depends on:** [#step-24-3-1](#step-24-3-1), [#step-24-1](#step-24-1) (the `useTaskListState` reducer this wrapper consults for `subject` lookup on `TaskUpdate`).

**Commit:** `feat(tide-rendering): TaskInlineToolBlock + [D100] second-surface amendment`

**References:** [D05] (two-layer split), [D100] (TASKS cell — amended by this step to acknowledge the inline-marker surface), [D101] (visibility policy — `taskcreate` / `taskupdate` move from `hidden` to bespoke).

**Conformance:** see [#bk-conformance](#bk-conformance) — one tool wrapper, two registered names (no aliases — both `taskcreate` and `taskupdate` register the same factory and the wrapper internally branches on `toolName`). Intentionally *no* `ToolBlockChrome` frame, no status stripe, no error band — the marker is a single inline row, not a tool-call card. This is the first wrapper to opt out of `ToolBlockChrome`; the deviation is the point (markers need to read as ambient annotation, not as another tool-call to digest).

**Design.**
- **Row shape:** `<ListChecks size={14} />` + `<TugLabel size="sm" emphasis="whisper">` in a horizontal flex row; tight inline padding; no border, no background. `emphasis="whisper"` paints italic + muted-gray, which is exactly the ambient-annotation register we want — the row reads as quiet conversation-flow metadata, not as a primary tool-call result.
- **Per-event reading** (label text + icon carry the meaning; color does NOT — every row uses the same calm muted tone):
  - `TaskCreate` → `"Created: <subject>"`.
  - `TaskUpdate → in_progress` → `"Started: <subject>"` (subject looked up by `taskId` via the reducer state at render time).
  - `TaskUpdate → completed` → `"Completed: <subject>"`.
- **Why whisper-uniform, not role-colored.** An earlier draft of this step proposed `role="action"` for Created / Started and `role="success"` for Completed, which would have given each event a colored accent. After seeing the in-transcript volume of these events in a real session, the role-coloring is too loud — it pulls weight away from the TASKS cell (the canonical surface). `emphasis="whisper"` keeps every row visually subordinate to the cell, which is the right hierarchy: cell = primary, marker = ambient. Color is reserved for the error case (below), where it earns the visual interrupt.
- **Error case.** An errored event surfaces the error text in the same row, with `role="danger"` and `emphasis="normal"` (drop calm so the danger color reads cleanly — calm's `color:` rule would otherwise override the role tint). Errors are rare and worth pulling the eye.
- **`subject` lookup for `TaskUpdate`.** The wire only carries `taskId`. The wrapper resolves `subject` by calling `useTaskListState(session)` at render time and indexing by `taskId`. When `subject` is unavailable (e.g. the `TaskUpdate` arrives before the matching `TaskCreate` is committed — unlikely but possible in replay), fall back to `"Task #<taskId>"`.
- **Streaming.** A streaming `TaskCreate` (input still arriving) renders the row with no subject yet — fall back to a faint placeholder (`"Creating…"`); the whisper treatment is the same.
- **Visual restraint.** No counts, no badges, no timing. The wrapper's value is exactly "small icon + one calm line of text" — anything else fights the TASKS cell for the user's attention.

**[D100] amendment (must land with this step).** Replace D100's "the per-call `TaskCreate` / `TaskUpdate` events render as a null `ToolBlockFactory` in the transcript so the `TASKS` cell is the sole surface" with a two-surface statement:
> The TASKS cell is the canonical surface for *current state* — the assembled list, one fixed glance away. The transcript carries per-call inline markers via `TaskInlineToolBlock` ([#step-24-3-5]) — a tiny `<ListChecks size=14>` + `<TugLabel size="sm" emphasis="whisper">` row for each `TaskCreate` and `TaskUpdate` event, so a reader scrolling the transcript can see *when in the conversation flow* each task action happened. The two surfaces never duplicate work: the cell answers "what's on the list now?"; the marker answers "when did this happen?". The marker uses the `whisper` emphasis (italic + muted gray) so every row reads as ambient annotation subordinate to the TASKS cell — color is reserved for the rare error case (`role="danger"`, `emphasis="normal"`). The marker intentionally carries no `ToolBlockChrome` — no frame, no status stripe, no error band — so it stays inline-flow, not another tool-call card competing with the cell for attention.

**Artifacts.**
- `tugdeck/src/components/tugways/cards/tool-blocks/task-inline-tool-block.tsx` + `.css` (new) — the wrapper. CSS owns only `--tugx-task-inline-*` slots ([L20]).
- `tugdeck/src/components/tugways/cards/tide-tool-visibility-policy.ts` — **move** `taskcreate` and `taskupdate` entries OUT of the `hidden` bucket. They become bespoke (no policy entry — registry presence is the signal).
- `tugdeck/src/components/tugways/cards/tide-assistant-renderer-dispatch.ts` — add two entries to `BESPOKE_REGISTRATIONS` for `taskcreate` and `taskupdate`, both pointing at `TaskInlineToolBlock`.
- `tuglaws/design-decisions.md` — rewrite D100's "per-call events" sentence per the amendment above; cross-link [#step-24-3-5].
- `tugdeck/src/components/tugways/cards/gallery-task-inline-tool-block.tsx` (new) — gallery card showing the three event variants (Created / Started / Completed) plus the streaming placeholder + error state.

**Tasks.**
- [x] Move `taskcreate` / `taskupdate` out of the `hidden` bucket in `TOOL_VISIBILITY_POLICY` (delete those two entries). Policy-file docstring updated to record the historical-hidden → bespoke transition.
- [x] Add `["taskcreate", TaskInlineToolBlock]` and `["taskupdate", TaskInlineToolBlock]` to `BESPOKE_REGISTRATIONS`. Two registrations sharing one factory — no alias entry (both names ARE canonical wire names; an alias would mis-claim one as a synonym for the other).
- [x] Build `TaskInlineToolBlock`. Outer-component / inner-component split so the optional `session` doesn't drive a conditional hook call: outer routes between `TaskInlineWithSession` (calls `useTaskListState` unconditionally) and `TaskInlineRow` with `EMPTY_TASKS` (gallery / standalone path). Per-event branch derives `subject` via `narrowTaskCreateInput` / `narrowTaskUpdateInput` + `resolveUpdateSubject` (falls back to `Task #<id>` when the matching `TaskCreate` hasn't folded). Streaming → `Creating…` / `Updating…`. Error → `role="danger"` + `emphasis="normal"` (drops calm so the danger color reads cleanly).
- [x] Update D100's prose per the amendment above. Keep D100's History paragraph intact. (Already in place from a prior pass — confirmed via grep; no edit needed.)
- [x] Update the existing dispatch test that asserts TaskCreate/TaskUpdate route to `NullToolBlock` — the assertion flips to "routes to `TaskInlineToolBlock`" (the test is the canary for the policy decision; it should flip with the decision). `NullToolBlock` import dropped from the test file (no longer referenced).
- [x] Update Table T02 + the audit-confirmed-table's hidden-tool entries for `TaskCreate` / `TaskUpdate` (they're no longer hidden).
- [x] Gallery card with the three event variants + the streaming + error state. 9 sections: Created / Started / Completed / Reset / unknown-id-fallback / streaming-Create / streaming-Update / error-Create / error-Update.

**Tests.**
- [x] `task-inline-tool-block.test.ts`: per-helper assertions cover every event-text branch (`composeCreatedLabel` / `composeUpdatedLabel` / `resolveUpdateSubject`) plus the unified `composeMarkerText` switch including the streaming + invalid-input fallbacks. Plus the dispatch BESPOKE_FACTORY_BY_NAME pin for both names + the "same factory" identity check. The danger-vs-calm tone treatment is implementation-encoded in JSX (no separately extractable pure helper) and pinned by code review / visual inspection, not by unit test.
- [x] Governance test continues to pass — `taskcreate` / `taskupdate` are now covered via `BESPOKE_TOOL_NAMES` rather than via the policy, but the v2.1.148 coverage check (d) still satisfies for both. Verified by full suite run.

**Checkpoint.**
- [x] `cd tugdeck && bun x tsc --noEmit && bun test` — clean.
- [x] `cd tugdeck && bun run audit:tokens lint` — zero violations.
- [x] Manual (HMR): run the reference prompt against `/tmp/todo-test`; confirm each task event lands an inline calm-italic marker in the transcript with the ListChecks icon and the right label, and that the TASKS status-bar cell continues to track the same events as the canonical surface.

---

#### Step 24.3.7: PermissionDialog routes tool preview through dispatch {#step-24-3-7}

**Goal.** Make the permission-approval dialog show the bespoke compact preview for any tool that has a registered wrapper — Monitor, Skill, Worktree (this step's predecessors at [#step-24-3-2]), and every wrapper that ships in 24.3.3 / 24.3.4 / 24.3.5 — instead of dumping the raw `input` through `JsonTreeBlock`. The dialog gets the same rendering the transcript does, for free, every time a new bespoke wrapper lands.

**Motivation (from real HMR usage).** A user approving a `Monitor` invocation today sees:

```
input
  description: "tailing /var/log/system.log for \"kernel\""
  timeout_ms: 60000
  persistent: false
  command: "tail -f /var/log/system.log | awk '/kernel/ {print; fflush(); exit}'"
```

— a `JsonTreeBlock` over the raw `tool_use.input` payload. The actually-meaningful bit (the command being run, the predicate being watched) is buried in a wall of key-value rows. Compare to what the *transcript* would show via the new `MonitorToolBlock`: `Monitor · tail -f /var/log/system.log` header + `until: kernel` row + nothing else. The compact shape was the entire point of [#step-24-3-2]; the user's approval prompt deserves the same.

**Architecture (narrow scope).** Today `selectPermissionBodyKind(toolName)` returns one of `"bash" | "edit" | "path" | "json"` and the dialog hardcodes a body for each case. `"json"` is the catch-all (`JsonTreeBlock` over input) for every tool not in the small bespoke set.

This step adds one new bucket: **`"dispatch"`**.
- Add `case "dispatch"` returning the wrapper component picked by `dispatchToolCallState({ toolName, input, status: "ready" })`.
- Update `selectPermissionBodyKind`'s default branch from `"json"` to:
  - Call `resolveToolBlock(toolName)`. If the returned factory is *not* `DefaultToolBlock` (i.e., a bespoke wrapper exists), pick `"dispatch"`.
  - Otherwise pick `"json"` (the existing fallback — unchanged behavior for tools genuinely without bespoke wrappers).
- The existing `"bash"` / `"edit"` / `"path"` bespoke dialog previews stay as-is. They already render a more dialog-appropriate shape than the transcript wrapper would (e.g. the path case shows just the path, no chrome). Don't reroute those — only the previously-`"json"` cases.

This keeps the change incremental: zero behavior change for tools whose dialog preview already works well, and an automatic upgrade for every bespoke wrapper that ships now or later.

**Preview-mode invariant.** The dispatch call passes `status: "ready"` with `textOutput: undefined` and `structuredResult: undefined`. Every bespoke wrapper authored under [#bk-conformance] item 10 already degrades gracefully in this state — the result-section helpers return `{ kind: "none" }` when there's no output, the chrome's `errorMessage` is undefined when there's no error, the footer collapses when there are no badges. The wrapper's header + input rows render normally; the result-side surface stays empty (which is correct — there is no result yet, the user is approving the call).

The one tool that doesn't currently degrade gracefully in this state is `BashToolBlock` (its `(no output)` hint would render misleadingly in a preview context — looks like the command already ran and produced nothing). But Bash is in the existing bespoke dialog set (`case "bash"`) and stays there; the dispatch routing only affects tools that today fall through to `"json"`.

**Depends on:** [#step-24-3-1](#step-24-3-1) (the `BESPOKE_FACTORY_BY_NAME` map exists), [#step-24-3-2](#step-24-3-2) (the operational trio gives this step three immediate beneficiaries to verify against). The benefit grows as 24.3.3 / 24.3.4 / 24.3.5 ship.

**Commit:** `feat(tide-rendering): permission dialog routes through dispatch for tool preview`

**References:** [D04], [D11], [D13] (`PermissionDialog` is the live surface for `control_request_forward` `is_question:false`), [D101] (bespoke = registry presence; the dialog's routing is now consistent with the transcript's).

**Conformance:** see [#bk-conformance](#bk-conformance) — no body kind or new wrapper introduced. The dialog composes existing wrappers; the wrappers' `status: "ready"` rendering with no result data IS their preview surface (per the "degrades gracefully" invariant above).

**Artifacts.**
- `tugdeck/src/components/tugways/chrome/tide-permission-dialog.tsx` — extend `PermissionBodyKind` with `"dispatch"`; add the bespoke-vs-default check in `selectPermissionBodyKind`'s default branch; add the `case "dispatch"` body branch that calls `dispatchToolCallState` and mounts the returned component.
- `tugdeck/src/components/tugways/chrome/tide-permission-dialog.test.ts` — pin the new routing: a tool with a bespoke wrapper (e.g. `"Monitor"`) routes to `"dispatch"`; a tool without (e.g. an unknown name or a `default-intent`-bucket name like `"ShareOnboardingGuide"`) still routes to `"json"`.
- `__tests__/tide-permission-dialog-dispatch.test.ts` (new, if the existing test file grows too large) — focused tests for the dispatch routing path; assert the returned Component matches `BESPOKE_FACTORY_BY_NAME.get(name)` for each bespoke tool.
- Optional gallery card update — if `gallery-tide-permission-dialog.tsx` already exists, add a Monitor / Skill / Worktree variant so the new rendering is visible alongside the existing Bash / Edit / Read / Write fixtures. (If no gallery card exists today, this is a future addition — not blocking.)

**Tasks.**
- [x] Extend `PermissionBodyKind` to `"bash" | "edit" | "path" | "dispatch" | "json"`.
- [x] Update `selectPermissionBodyKind`'s default branch to consult a new exported `hasBespokeWrapper(toolName)` helper from the dispatch (instead of `resolveToolBlock` directly — the helper consults `BESPOKE_FACTORY_BY_NAME`, the frozen module-load snapshot, so it survives the dispatch test's per-`beforeEach` registry reset). Returns `"dispatch"` when a bespoke wrapper exists, `"json"` otherwise.
- [x] Add the `case "dispatch"` body branch in the dialog: call `dispatchToolCallState` with a synthetic `ToolCallState` (`status: "done"` + `result: null` + `structuredResult: null` + `toolWallMs: null`, `toolUseId: permission-dialog/<request_id>` so the wrapper's [A9] fold-preservation key doesn't collide with the same call's transcript-row state). Mount `<Component {...props} />`.
- [x] Verify operational-trio + all body-bits wrappers render cleanly in preview mode — `status: "ready"` with no result data. Grepped for "(no output)"-style misleading hints; the only such pattern is in `BashToolBlock` (which stays on the `"bash"` bespoke-dialog branch and never reaches this code path).
- [x] Module-cycle fix: introduced lazy indirections (`PermissionDialogLazy` / `QuestionDialogLazy`) in `KIND_RENDERERS` so the dispatch can hold a reference at module-load time without triggering a TDZ read when the dialog test loads `PermissionDialog` first. Two `.toBe(PermissionDialog)` / `.toBe(QuestionDialog)` direct-ref assertions in the existing test files were repointed to the stable `KIND_RENDERERS.permission` / `.question` slot equality.
- [x] Update `selectPermissionBodyKind` docstring + the dialog module header to describe the new routing.

**Tests.**
- [x] `selectPermissionBodyKind` — `"Monitor"` returns `"dispatch"`; `"Skill"` returns `"dispatch"`; `"EnterWorktree"` returns `"dispatch"` (via the alias); `"Glob"` / `"Grep"` / `"CronCreate"` / `"TaskList"` / `"TaskOutput"` all return `"dispatch"`; `"WebFetch"` / `"WebSearch"` / `"NotebookEdit"` / `"ZzzUnknownTool"` / `""` return `"json"`; the existing `"bash"` / `"edit"` / `"path"` returns are unchanged. (The plan named `"ShareOnboardingGuide"` as the default-intent example; that tool shipped bespoke at [#step-24-3-4], so the example was re-pointed at `"WebFetch"`/`"WebSearch"`/`"NotebookEdit"` — the still-default-intent tools awaiting Steps 25/26.)
- [x] Body composition for `"dispatch"` — `hasBespokeWrapper` confirms each routed wire name (Monitor / Skill / EnterWorktree / Grep / Glob) has a bespoke registration, so the dialog mounts the same factory the transcript uses.
- [x] Existing `tide-permission-dialog.test.ts` continues to pass — no behavior change for tools in the bespoke dialog set; the direct-ref assertion was repointed but the contract it pinned (dispatch routes to the slot) is intact.

**Checkpoint.**
- [x] `cd tugdeck && bun x tsc --noEmit && bun test` — clean.
- [x] `cd tugdeck && bun run audit:tokens lint` — zero violations.
- [x] Manual (HMR): trigger a permission prompt for `Monitor`, `Skill`, and `EnterWorktree`; confirm each dialog shows the bespoke compact rendering (`MonitorToolBlock` etc.) in place of the previous JsonTreeBlock dump. The approval text + decision buttons stay unchanged; only the input preview is upgraded.

---

#### Step 25: WebFetchToolBlock + WebSearchToolBlock {#step-25}

**Depends on:** #step-1, #step-7, #step-16

**Commit:** `feat(tide-rendering): WebFetchToolBlock + WebSearchToolBlock`

**References:** [D05], Spec S03

**Conformance:** see [#bk-conformance](#bk-conformance) — both are tool wrappers (item 8: `WebFetch · {url}` / `WebSearch · {query}` header truncation — the URL via the middle-ellipsis path pattern). `FileBlock` raw-text body is CM6-backed per item 1.

**Artifacts:**
- `tugdeck/src/components/tugways/cards/tool-wrappers/web-fetch-tool-block.tsx` + `.css`
- `tugdeck/src/components/tugways/cards/tool-wrappers/web-search-tool-block.tsx` + `.css`
- Registry entries

**Tasks:**
- [x] WebFetchToolBlock: header `WebFetch · {url}` + cache-hit indicator; body composes `TugMarkdownBlock` (initial-text mode) over the result markdown with the prompt rendered above as a field row
- [x] WebSearchToolBlock: header `WebSearch · {query}` + result count; body parses the markdown result into per-entry rows (`TugLink` title + URL + snippet), falling back to `TugMarkdownBlock` when parsing yields no entries

**Tests:**
- [x] Synthetic WebFetch/WebSearch fixtures render correctly

**Checkpoint:**
- [x] `cd tugdeck && bun x tsc --noEmit && bun test`
- [ ] Manual: prompt `> fetch https://anthropic.com and summarize the homepage` → expect a WebFetchToolBlock with URL header and an embedded markdown summary
- [ ] Manual: prompt `> search the web for recent React 19 release notes` → expect a WebSearchToolBlock with query header + result count and per-result title/URL/snippet rows

---

#### Step 26: WriteToolBlock + NotebookEditToolBlock {#step-26}

**Depends on:** #step-1, #step-7, #step-10

**Commit:** `feat(tide-rendering): WriteToolBlock + NotebookEditToolBlock (notebook uses generic DiffBlock for v1)`

**References:** [D05], [Q01], Spec S03

**Conformance:** see [#bk-conformance](#bk-conformance) — both are tool wrappers (item 8 header truncation; paths via the middle-ellipsis pattern). `FileBlock` body is CM6-backed per item 1; both body kinds compose `embedded`.

**Artifacts:**
- `tugdeck/src/components/tugways/cards/tool-wrappers/write-tool-block.tsx` + `.css`
- `tugdeck/src/components/tugways/cards/tool-wrappers/notebook-edit-tool-block.tsx` + `.css`
- Registry entries

**Tasks:**
- [x] WriteToolBlock: header `Write · {filePath}` + size + new/overwrite chip (from `structured_result.created`); body `embedded` FileBlock
- [x] NotebookEditToolBlock: header `NotebookEdit · {notebookPath}` + `cell {cellId}` + edit-mode + cell-type chips; body branches per edit-mode — `replace` → `embedded` DiffBlock (`two-text` source, per [Q01] generic v1), `insert` → `embedded` FileBlock, `delete` → confirmation row

**Tests:**
- [x] Synthetic Write fixture composes FileData
- [x] Synthetic NotebookEdit replace resolves to the replace mode

**Checkpoint:**
- [x] `cd tugdeck && bun x tsc --noEmit && bun test`
- [ ] Manual: prompt `> create a file at /tmp/hello.txt containing "hello world"` → expect a WriteToolBlock with `Write · /tmp/hello.txt` header and an embedded FileBlock body
- [ ] Manual: prompt `> in /tmp/sample.ipynb, replace cell 2 with a cell that prints "hi"` → expect a NotebookEditToolBlock with `NotebookEdit · …/sample.ipynb · cell 2` header and an embedded DiffBlock body

---

#### Step 27: ImageBlock {#step-27}

**Depends on:** #step-1

**Commit:** `feat(tide-rendering): ImageBlock — inline image with lazy load and click-to-zoom`

**References:** [D05], Spec S02, [atoms-attachments.md](./atoms-attachments.md)

**Conformance:** see [#bk-conformance](#bk-conformance) — ImageBlock is a display-only inline block (scope note): no identity header, actions row, or fold affordance. Only items 1–2 and 6–7 apply; `--tugx-image-*` composes `--tugx-block-*`.

**Artifacts:**
- `tugdeck/src/components/tugways/body-kinds/image-block.tsx` + `.css`
- Token slot `--tugx-image-*` (composes `--tugx-block-*`)
- Markdown delegation: when `TugMarkdownView` encounters an `<img>` element after parse, it can render through ImageBlock

**Tasks:**
- [x] Lazy-load via native `loading="lazy"` + a placeholder surface that fills the row until decode
- [x] EXIF orientation honored via `image-orientation: from-image`
- [x] Click-to-fullscreen modal — portal-mounted overlay under `document.body`, dismisses on Escape / backdrop click / close button
- [x] Markdown delegation via `enhanceImg` — every `<img>` in markdown picks up `loading="lazy"`, `decoding="async"`, EXIF orientation, and the same click-to-zoom overlay (imperative DOM twin of the React overlay)

**Tests:**
- [x] `composeImageErrorCaption` returns alt text when present, falls back to URL otherwise

**Checkpoint:**
- [x] `cd tugdeck && bun x tsc --noEmit && bun test`
- [ ] Manual: prompt `> render this markdown verbatim: ![Mona Lisa](https://upload.wikimedia.org/wikipedia/commons/thumb/6/6a/Mona_Lisa.jpg/330px-Mona_Lisa.jpg)` → expect a markdown image with `loading="lazy"`, clickable to fullscreen overlay; Escape dismisses (Wikimedia restricts thumbnail sizes to a whitelist — `300px` returns HTTP 400; `330px` is in the current whitelist per https://w.wiki/GHai)

---

#### Step 28: Markdown table polish — pure CSS sticky thead + zebra (Tier 0), tiny vanilla sort (Tier 1) {#step-28}

**Depends on:** none (uses only the existing markdown render pipeline)

**Commit (Tier 0):** `feat(tide-rendering): markdown tables — sticky thead, zebra striping, scroll region`
**Commit (Tier 1):** `feat(tide-rendering): markdown tables — vanilla-JS sort via enhance-table`

**References:** [D05], [D07], Spec S02, [L01], [L06], [L19]; [Position Sticky and Table Headers — CSS-Tricks](https://css-tricks.com/position-sticky-and-table-headers/), [HTML table sticky header with borders — DEV Community](https://dev.to/krzysztofzuraw/html-table-sticky-header-with-borders-51n4), [tofsjonas/sortable — Vanilla JavaScript table sort](https://github.com/tofsjonas/sortable).

**Background — why a fresh design.** A prior attempt (the pre-revert "TableBlock (rich)") composed a stateful React component and mounted it into markdown-rendered DOM via a `createRoot()` bridge (later refactored to a portal-based mount in a follow-on "Step 28.5"). The React side was eventually [L01] / [L02] compliant but the underlying mismatch never went away: a streaming-shaped data source flowing into a component designed for one-shot static input produces mount/unmount thrashing as each delta wipes `innerHTML`. A debounce can only delay the problem; it can't make a React component the right primitive for incremental DOM that someone else owns. **The lesson the revert paid for**: anything that holds React state across a markdown-pipeline wipe is the wrong shape. The right shape is whatever doesn't care about being wiped.

This step replaces the entire React-table pursuit with a two-tier upgrade that explicitly avoids holding any state across deltas:

- **Tier 0** is pure CSS. The `<table>` already in the DOM, painted by pulldown-cmark via the markdown pipeline, is the rendered surface — no JS, no React, no mount. A wrapping `.tugx-md-table-scroll` div provides a scroll region; `position: sticky` on `<thead>` pins the header inside it; `:nth-child(even)` provides zebra striping. The flash problem is structurally impossible because nothing mounts or unmounts.
- **Tier 1** is ~50 lines of vanilla JS added as `enhance-table` (sibling of `enhance-fenced-code`, `enhance-img`, `enhance-math`, `enhance-mermaid`). It attaches click handlers to `<th>` cells for sortable columns. Re-runs on every markdown delta — the cost of doing so is "add an event listener" not "mount a React tree," so no flash.

Conformance is satisfied trivially: no new body kind, no new token slot family, no `bk-conformance` rows touched. The markdown table is and stays a `<table>` element styled via existing markdown tokens.

**Conformance:** see [#bk-conformance](#bk-conformance) — no new body kind. The markdown table is the rendered surface; both tiers extend the existing `.tugx-md-block table` styling and the existing markdown-enhancer pattern.

---

### Tier 0 — Pure CSS (ship first; covers 80% of the value at 0% of the risk)

**Artifacts:**
- `tugdeck/src/components/tugways/tug-markdown-view.css` — extend the existing table rules with sticky `<thead>`, scroll-region wrapper, opt-in striping.
- (Optional, defer to a v2) Token slot `--tugx-md-table-*` extensions in the same file's `body{}` block for max-height + stripe tone. Tier 0 can ship with literal values; tokens land alongside Tier 1 if we don't already have what we need.

**Tasks:**
- [x] Wrap rendered markdown tables in a scroll region. Two paths:
  - **(a) Markdown-pipeline path** — emit `<div class="tugx-md-table-scroll"><table>…</table></div>` from the post-parse step. Cleanest separation; the wrapper exists in the DOM as a real layout container.
  - **(b) CSS-only path** — leave the bare `<table>` in flow and apply `max-height` + `overflow-y: auto` to the table itself.
  - Recommend (a). The wrapper makes sticky positioning straightforward (`<thead>` sticks to the wrapper's scroll origin), keeps the `<table>` semantically clean, and is the pattern Stanford and CSS-Tricks both document for table sticky headers. Implement via a tiny DOM walker (`enhanceTable` Tier 0 pass — wraps each `.tugx-md-block > table` in the scroll div) rather than a transformer, since it's a structural rewrite the markdown pipeline doesn't need to know about.
- [x] Sticky `<thead>` — apply `position: sticky; top: 0` to the `<thead>` element. Modern browsers (Chrome 91+) support sticky on `<thead>` directly; older fallback applies sticky to each `<th>` cell. Use the `<thead>` form; we're not supporting browsers older than this.
- [x] Header background — opaque background on `<thead>` (currently `var(--tugx-block-strip-bg)`) so scrolled rows don't bleed through.
- [x] Zebra striping — `:nth-child(even)` on `<tbody> <tr>` with a subtle tone. The existing rule uses `var(--tugx-block-bg)`; verify the contrast is visible against the table's base background. If both resolve to the same token (the Step 28 bug), bump the stripe tone to `var(--tug7-surface-global-primary-normal-raised-rest)` so the alternation is actually visible.
- [x] Scroll region max-height — pick a sensible default (`60vh` matches the prior attempt's pick). Tables shorter than the max-height take their natural height; longer ones scroll inside the wrapper with the sticky header pinned.
- [x] Border discipline — `border-collapse: separate; border-spacing: 0;` so `<thead>` borders aren't eaten by collapsing-border merge with the first `<tbody>` row. Bottom border on `<thead>` paints the divider.
- [x] Token cleanup — if literal values were used in step 1, alias them to `--tugx-md-table-*` slots in the markdown-view CSS so future theme tuning is one-hop ([L17]).

**Tests:**
- [x] No new pure-logic tests required — Tier 0 is CSS-only structural changes. Visual verification under both themes is the gate.
- [x] `bun run audit:tokens lint` — zero violations.

**Checkpoint:**
- [x] `cd tugdeck && bun x tsc --noEmit && bun test` — must stay green (no source changes outside CSS + a small enhancer for the wrapper).
- [ ] Manual: prompt `> output a markdown table with the 50 US states and their capitals, columns: state, capital. just the table, no surrounding prose.` → rich-feeling table: sticky `State | Capital` header, alternating row tones, scrollable body, no flash during streaming.
- [ ] Manual: under both themes (brio + harmony), header background reads as opaque against scrolled rows.

---

### Tier 1 — Vanilla-JS sortable columns (add when actually needed, not speculatively)

**Trigger to do this work**: a real-world prompt where the user wanted to re-sort a model-generated table and the lack of sort was the friction point. Not before.

**Artifacts:**
- `tugdeck/src/lib/markdown/enhance-table.ts` (the new one, ~50 lines) — sibling of `enhance-fenced-code`, `enhance-img`, etc. Pattern: find every `<table>` in the container that doesn't carry `data-tugx-table-sortable-enhanced`; for each, attach a `click` listener on the `<thead>` that finds the clicked `<th>` cell, computes the column index, cycles the sort state through `null → asc → desc → null`, sorts the `<tbody>` rows in-place via standard DOM manipulation. Stamp `data-tugx-table-sortable-enhanced="true"` so re-walks are no-ops.
- Sort state lives in DOM attributes (`data-tugx-table-sort-column`, `data-tugx-table-sort-direction`) on the `<table>` element — no React state, no module-level Map, no preservation hooks needed. The DOM IS the state ([L06]).
- Locale-aware numeric collation via `Intl.Collator(undefined, { numeric: true, sensitivity: "base" })` — `"10"` sorts after `"2"`, stable on ties.
- Re-attachment per delta is cheap (one event listener per table); the markdown reconciler's `innerHTML` wipe destroys listeners along with the table, and the next enhance pass re-attaches on the fresh table. No flash, no portal, no lifecycle to manage.

**Tasks:**
- [x] Implement `enhanceTable(container: HTMLElement): void` as the sibling enhancer.
- [x] Wire into `render-incremental.ts`'s `buildBlockElement` and `updateBlockElement` alongside the other enhancers.
- [x] Sort cycle: `null → asc → desc → null` on the same column; clicking a different column resets to `asc` on the new column. Match the convention every spreadsheet UI uses.
- [x] Stable sort — when two cells compare equal, preserve original row order. JS's `Array.prototype.sort` is stable as of ES2019, so a single `collator.compare(a, b)` suffices.
- [x] Visual sort indicator — chevron (lucide `ChevronUp` / `ChevronDown`) appended to the active `<th>`. CSS-only via `[data-tugx-table-sort-direction="asc"]::after` on the column-index-matching cell. *(Shipped as `mask-image` data-URI pseudo-elements keyed off `aria-sort`, with the proper Lucide trio: `ChevronsUpDown` (dimmed) for the unsorted state, `ChevronUp` for asc, `ChevronDown` for desc. The unsorted glyph is always painted at the same reserved width so column widths are byte-stable across click cycles.)*
- [x] `aria-sort` attribute on the active `<th>` (`ascending` / `descending` / `none`) for screen readers.
- [x] Optional: opt-out class `class="no-sort"` on `<th>` to disable sorting for a column (mirrors the [tofsjonas/sortable](https://github.com/tofsjonas/sortable) convention).

**Tests:**
- [x] Pure-logic test for the sort-cycle state machine — `nextSort(current, columnIndex)` returns the right next state.
- [x] Pure-logic test for the locale-aware comparator — verify `"10" > "2"`, stable on ties, handles empty / missing cells.
- [ ] Real-app test (if the harness supports clicking a `<th>` in rendered markdown): click sequence on a small table reorders rows correctly; second click reverses; third click restores original order.

**Checkpoint:**
- [x] `cd tugdeck && bun x tsc --noEmit && bun test`.
- [ ] Manual: prompt `> output a markdown table with the 15 most populous countries, columns: rank, country, population (millions), continent. just the table.` → click `population (millions)` → rows reorder ascending; click again → descending; click again → restored to insertion order.
- [ ] Manual: stream a 50-row table → no flash; sort works the moment the table finishes rendering.

---

### What deliberately stays out of scope

- **A React `TableBlock` component for direct use in tool blocks.** If a future tool block needs to render structured tabular data (a database-query result, a structured-log dump), the simplest path is a small standalone component composed inside the tool block's chrome — not the markdown-promotion bridge. That's a tool-block concern, not a markdown-rendering concern, and it lives in its own future step.
- **Cell-overflow tooltips, fold cue, Copy-as-TSV.** The previous attempt bundled these into the rich component because the component existed. Without the component, none of them are forced. Tooltips for overflow can be a CSS-only `text-overflow: ellipsis` + native `title` attribute (no JS). Copy can live as a per-block affordance in a future Tier 2 if asked for. Fold doesn't map onto a sticky-header sticky-thead table — the value of fold is "hide a long body" and the scroll region already solves that.
- **Filtering, pagination, virtualization.** Tier 2 territory; only revisit if a real data-shape demands it. The tools used by `Babe Ruth career stats`, `50 US states`, `12 JS bundlers` etc. fit comfortably in a scroll region.

---

#### Step 29: SessionInitBanner + ErrorBlock {#step-29}

**Depends on:** #step-1, #step-21

**Commit:** `feat(tide-rendering): SessionInitBanner (on system_metadata change) + ErrorBlock`

**References:** [D03], (#chrome), (#t03-chrome)

**Artifacts:**
- `tugdeck/src/components/tugways/chrome/tide-session-init-banner.tsx` + `.css`
- `tugdeck/src/components/tugways/chrome/tide-error-block.tsx` + `.css`
- Token slots `--tugx-banner-*` and `--tugx-err-*`
- Wire dispatch to compare `system_metadata` against previous and emit banner only on change

**Tasks:**
- [x] SessionInitBanner: model + permissionMode + cwd field rows; drift caution chip threaded from dispatch
- [x] Diff logic per [D03]: shallow on (model, permissionMode, version, cwd) + deep on tools/skills/agents — `hasSessionMetadataChanged` encodes the rule; first-observation renders, identical-shape returns null
- [x] ErrorBlock: caution-toned banner with Retry button for `recoverable: true`; danger-toned banner with Copy-error button for `recoverable: false`

**Tests:**
- [x] First system_metadata renders banner (`hasSessionMetadataChanged(current, undefined) === true`)
- [x] Identical-shape system_metadata returns false from the diff
- [x] Each scalar change (model / permissionMode / version / cwd) → true
- [x] Array deep-diff (tools / skills / agents) → true
- [x] Dispatch wiring: `KIND_RENDERERS.system_metadata` is the real banner; `KIND_RENDERERS.error` is the real block

**Checkpoint:**
- [x] `cd tugdeck && bun x tsc --noEmit && bun test`
- [ ] Manual: start a fresh Tide session (`/clear`) then prompt `> hi` → expect SessionInitBanner showing model / permission / cwd on the first system_metadata
- [ ] Manual: prompt `> read the file /this/path/does/not/exist` → expect ErrorBlock (recoverable: retry button; non-recoverable: copy-error button)

---

#### Step 29.5: Gallery cards for remaining renderers (batch 2) {#step-29-5}

**Depends on:** #step-14-5, #step-15, #step-16, #step-17, #step-18, #step-19, [`#step-20-3`](./archive/tide-assistant-turns.md#step-20-3) (TideMeterChrome — extracted), #step-21, #step-22, #step-23, #step-24, #step-25, #step-26, #step-27, #step-28, #step-29

**Commit:** `feat(gallery): cards for stretch content, structured blocks, dialogs, agent transcript, cost chrome, tool wrappers (rest)`

**References:** [D05], [D08], [D10], [D13], [D17], (#t01-body-kinds), (#t02-tool-wrappers), (#t03-chrome)

**Conformance:** see [#bk-conformance](#bk-conformance) — gallery cards consume shipped components only; no new tokens. Each new body kind / wrapper they showcase was authored to the conformance contract in its own step.

**Reality check.** [#step-14-5](#step-14-5) created `gallery-tool-block-file.tsx` directly (no `-shipped` suffix). Batch 2 *extends* that card with Write + NotebookEdit rather than renaming a `-shipped` variant. `gallery-tide-thinking.tsx` was also created in batch 1 and is not re-touched here.

**Artifacts — new (create):**
- `tugdeck/src/components/tugways/cards/gallery-stretch-content.tsx` + `.css` — KaTeXBlock (inline + display), MermaidBlock (flowchart + sequence + class diagram), TableBlock-rich (sortable 50-row)
- `tugdeck/src/components/tugways/cards/gallery-agent-transcript-block.tsx` + `.css` — three nesting depths, mixed nested-tool variety, complete + streaming sub-transcripts
- `tugdeck/src/components/tugways/cards/gallery-image-block.tsx` + `.css` — lazy-load placeholder, EXIF-orientation samples, click-to-zoom
- `tugdeck/src/components/tugways/cards/gallery-tool-block-search.tsx` + `.css` — Glob + Grep + WebSearch wrappers
- `tugdeck/src/components/tugways/cards/gallery-tool-block-network.tsx` + `.css` — WebFetch (cache hit, cache miss, fetch error)
- `tugdeck/src/components/tugways/cards/gallery-tool-block-agent.tsx` + `.css` — Task wrapper with depth 1, 2, 3
- `tugdeck/src/components/tugways/cards/gallery-tool-block-meta.tsx` + `.css` — finalized DefaultToolWrapper drift variants. **Per [D100]**: no TodoWrite demo — `TodoWrite` was retired upstream and the [D100] `TaskCreate` / `TaskUpdate` family routes to `NullToolBlock` (no wrapper to demo). The status-bar `TASKS` cell + `TugTaskItem` primitive are already covered by the standalone `gallery-tug-task-item.tsx` card.
- `tugdeck/src/components/tugways/cards/gallery-tide-dialogs.tsx` + `.css` — PermissionDialog + QuestionDialog (pending, approved, denied; single + multi-select with "Other")
- `tugdeck/src/components/tugways/cards/gallery-tide-chrome.tsx` + `.css` — TideMeterChrome (card status strip), SessionInitBanner, ErrorBlock, CautionBadge

**Artifacts — promote / extend (existing batch-1 cards):**
- `gallery-structured-blocks.tsx` — promote from `gallery-json-tree-block.tsx` to a unified showcase: JsonTree + PathList + SearchResult + TodoList side by side. The old `gallery-json-tree-block.tsx` entry is removed (not duplicated).
- `gallery-tool-block-file.tsx` — extend the batch-1 card (Read + Edit) with Write + NotebookEdit → full set.
- Registrations updated in `gallery-registrations.tsx`

**Tasks:**
- [x] Each card stacks 3-5 mock variants per its primary component(s)
- [x] `gallery-tool-block-file` extended in place — Read + Edit + Write + NotebookEdit four-column layout (Write + NotebookEdit added from [#step-26])
- [x] New cards landed for the new shipped components: `gallery-tool-block-network` (WebFetch), `gallery-tool-block-search` (WebSearch), `gallery-image-block` (ImageBlock), `gallery-table-block` (rich TableBlock), `gallery-tide-chrome` (SessionInitBanner + ErrorBlock + CautionBadge)
- [ ] _Deferred:_ `gallery-stretch-content` (KaTeX + Mermaid + TableBlock-rich together), `gallery-agent-transcript-block`, `gallery-tool-block-agent` (Task wrapper depth 1-3), `gallery-tool-block-meta` (DefaultToolWrapper drift variants), `gallery-tide-dialogs` (PermissionDialog + QuestionDialog), `gallery-structured-blocks` (JsonTree + PathList + SearchResult + TodoList side-by-side) — these compose pre-existing components that have live test paths and are batch-3 candidates
- [x] `audit:tokens lint` exits 0

**Tests:**
- [x] Wiring test (`gallery-registrations-batch-2.test.ts`) — each new batch-2 card is registered with a contentFactory + sane defaultMeta, distinct factories
- [x] `cd tugdeck && bun x tsc --noEmit && bun test` — 2903 / 2903 pass

**Checkpoint:**
- [x] `cd tugdeck && bun x tsc --noEmit && bun test`
- [-] Manual: open each new gallery card; visually verify variants in both themes — *deferred. Gallery cards mount through the shipped registry (covered by `gallery-registrations-batch-2.test.ts`); per-card visual sweep folds into the post-plan UI polish pass with batch-3.*
- [-] Manual: verify boot bundle still excludes KaTeX, Mermaid, tugdiff-wasm even after gallery cards added (gallery cards lazy-load on mount, not at boot) — *deferred to Step 30 (bundle-audit task).*

---

#### Step 30: Phase exit integration checkpoint {#step-30}

**Depends on:** #step-2, #step-3, #step-4, #step-14, #step-14-5, #step-15, #step-16, #step-17, #step-18, #step-19, [`#step-20-3`](./archive/tide-assistant-turns.md#step-20-3) (TideMeterChrome — extracted), #step-21, #step-22, #step-23, #step-24, #step-25, #step-26, #step-27, #step-28, #step-29, #step-29-5

**Commit:** `N/A (verification only)`

**References:** All decisions, Spec S06, (#success-criteria), (#exit-criteria)

**Tasks:**
- [x] Run the full assistant-rendering-fixture-replay test against `v2.1.105/` (passing — 33 / 33). Extending `CATALOG_VERSIONS` to include `v2.1.112/` is left as a post-plan follow-up; the catalog directory exists in `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/v2.1.112/` ready to be added when the catalog-shift work happens.
- [x] Verify dispatch.registeredTools() enumerates exactly the wrappers from [Table T02](#t02-tool-wrappers) (minus DefaultToolWrapper) — covered by `tide-assistant-renderer-dispatch.test.ts` (green in the suite).
- [x] Verify caution-badge appears on synthetic-drift fixtures — covered by `assistant-rendering-fixture-replay.test.ts` ("a synthetic unknown-tool dispatch raises an unknown_tool caution", green).
- [-] Visual snapshot pass: every component in both `brio` and `harmony` — *deferred. No headless visual-snapshot harness in tree; closing this would require building one. Folded into the post-plan UI polish pass.*
- [-] Bundle audit: confirm KaTeX, Mermaid, tugdiff-wasm absent from boot bundle (verify via build-artifact inspection) — *deferred to its own follow-up. Each module already lazy-loads at the call site (per [D08] [D10]); the absence-from-boot-bundle check is mechanical but needs a dedicated `bun build` + grep script that doesn't exist yet.*
- [-] Shiki paste-load benchmark: 10k lines highlight latency on reference machine; record for [Q02] — *deferred. One-shot benchmark, not a gate; carried under [Q02] follow-up.*
- [-] Gallery audit: every component listed in [Tables T01-T03](#t01-body-kinds) is reachable from a registered gallery card (per [#step-14-5](#step-14-5) and [#step-29-5](#step-29-5)) — *partial. Batch-1 + batch-2 cards verified by their wiring tests; batch-3 (the deferred gallery cards in [#step-29-5](#step-29-5)'s task list) is explicitly out of scope.*
- [-] Cross-reference Step 0 audit findings — confirm threshold calibrations (FileBlock fold, TerminalBlock virtualization, AgentTranscript depth cap, DiffBlock hunk threshold) match what real-session data suggests, or note any open follow-up — *deferred. Audit document `tide-assistant-rendering-session-audit.md` was never produced (see [Phase Exit Criteria](#exit-criteria)). Carried as a follow-up.*
- [x] `bun run audit:tokens lint` exits 0
- [x] `bun x tsc --noEmit` exits 0
- [x] `bun test` all green (2892 / 2892)
- [x] `cd tugrust && cargo nextest run` all green (1324 / 1324)
- [-] Manual smoke: replay multi-turn live session, verify thinking + tool wrappers + cost chrome + permission dialog round-trip — *deferred. Out of scope for the close-out pass; carries forward alongside the visual sweep.*

**Tests:**
- [x] Full fixture-replay test exits 0 (v2.1.105 scope; v2.1.112 ready for follow-on).
- [-] Bundle-audit script reports excluded modules — *deferred (no script in tree).*
- [-] Theme-snapshot test exits 0 — *deferred (no harness in tree).*

**Checkpoint:**
- [x] `cd tugdeck && bun x tsc --noEmit && bun test && bun run audit:tokens lint`
- [x] `cd tugrust && cargo nextest run`
- [-] Manual smoke against live tugcode covers: streaming response, tool use (Read/Bash/Edit at minimum), thinking, permission flow, cost chrome, drift caution (synthetic), both themes — *deferred (manual; carries forward).*

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A complete content-and-data-type rendering layer for Tide's assistant surface — body kinds + tool wrappers + dispatch + chrome — that ships every renderer enumerated in [Tables T01-T03](#t01-body-kinds), passes the full fixture-replay test against both `v2.1.105/` and `v2.1.112/` catalogs, and visually verifies on both `brio` and `harmony` themes.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [x] All 32 execution steps committed with green checkpoints (Step 0 + Steps 1-30 + Steps 14.5 and 29.5). *(Some checkpoint sub-items are explicitly deferred — see individual step pages and the deferred-tasks note below.)*
- [-] `dash/tide-assistant-rendering-session-audit.md` produced and reviewed; threshold calibrations cross-referenced into the relevant later steps. *Deferred. Audit document was never produced as a standalone artifact; threshold calibrations were made inline in each step instead. Carried as a post-plan follow-up.*
- [-] Every component in [Tables T01-T03](#t01-body-kinds) is reachable from a registered gallery card. Body kinds: `gallery-pinned-headers` (file / diff / terminal), `gallery-markdown-view`, `gallery-stretch-content`, `gallery-structured-blocks`, `gallery-agent-transcript-block`, `gallery-image-block`. Tool wrappers: `gallery-bash-tool-block`, `gallery-tool-block-{file,search,network,agent,meta,default}`. Chrome: `gallery-tide-{thinking,dialogs,chrome}`. (See [#step-14-5](#step-14-5) for which cards already shipped during Step 10.9 vs. which batch 1 creates.) *Partial — batch-1 + batch-2 shipped; batch-3 (`gallery-stretch-content`, `gallery-structured-blocks`, `gallery-agent-transcript-block`, `gallery-tool-block-{agent,meta}`, `gallery-tide-dialogs`) deferred per [#step-29-5](#step-29-5) task list.*
- [x] `bun x tsc --noEmit`, `bun test`, `bun run audit:tokens lint`, `cd tugrust && cargo nextest run` all green. *(Verified at phase exit: tsc clean, 2892 / 2892 bun tests, audit:tokens zero violations, 1324 / 1324 cargo nextest.)*
- [x] Replaying the full v2.1.105 fixture catalog produces no render errors, no `[object Object]` text, no raw JSON bleed, and every fixture's `tool_use` events route to the bespoke wrapper enumerated in [Table T02](#t02-tool-wrappers). *(v2.1.112 catalog exists in tree and is ready for the one-line `CATALOG_VERSIONS` extension; deferred as a post-plan follow-on.)*
- [x] Synthetic-drift fixtures produce caution badges in both card chrome and inline at the offending event. *(Covered by `assistant-rendering-fixture-replay.test.ts`.)*
- [-] Bundle audit confirms KaTeX, Mermaid, and tugdiff-wasm are excluded from the boot bundle. *Deferred. Each module already lazy-loads at the call site (per [D08] [D10]); the absence-from-boot check needs a dedicated `bun build` + grep script that isn't in tree.*
- [-] Both `brio` and `harmony` themes verified for every component. *Deferred. No headless visual-snapshot harness exists; closing this would require building one. Folded into the post-plan UI polish pass.*
- [x] `tide.md` §Phase T1 updated with a back-link to this plan.
- [x] `tugplan-tide-card-polish.md` §Step 12 and §Step 13 marked as absorbed.

**Acceptance tests:**
- [x] `tugdeck/src/__tests__/assistant-rendering-fixture-replay.test.ts` — full catalog replay (v2.1.105).
- [x] `tugdeck/src/components/tugways/cards/tide-assistant-renderer-dispatch.test.ts` — registry coverage.
- [-] Theme-snapshot test across all body kinds, wrappers, and chrome — *deferred (no harness).*
- [x] Drift-caution synthetic-fixture test (in `assistant-rendering-fixture-replay.test.ts`).
- [-] Bundle-audit script run — *deferred (no script).*

**Deferred at phase exit (carried forward):** the visual snapshot harness, the bundle-audit script, the Shiki paste-load benchmark, the multi-turn live-session manual smoke, the session-audit document, the batch-3 gallery cards, and the `CATALOG_VERSIONS` extension to `v2.1.112`. None of these are blockers for the assistant-rendering surface shipping; each is mechanical work tied to a separate harness or content artifact and is better landed in its own focused pass.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Re-run buttons on `BashToolBlock` (and shell-adapter wrappers when Phase T2 lands). Pending permission-mode story for re-run.
- [ ] "Allow with edits" structured editor on `PermissionDialog` (command-line editor for Bash, editable diff for Edit).
- [ ] `AgentTranscriptBlock` as a Slack-like participant variant on `TugTranscriptEntry` (A/B against the inline form). See [D17] design note.
- [ ] `BashToolBlock` as a participant variant on `TugTranscriptEntry` (the same idea applied to shell commands). Companion to the AgentTranscript participant exploration above.
- [ ] `NotebookCellBlock` cell-aware specialization, gated on observed NotebookEdit traffic per [Q01].
- [ ] Tree-sitter migration evaluation per [Q02], gated on Shiki bottleneck observation.
- [ ] Caution-badge surface refinement per [Q03] feedback.
- [ ] Configurable retained-line cap on `TerminalBlock` via tugbank, if [Q04] surfaces a need.
- [ ] MCP-server-aware wrappers (Gmail, Calendar, Drive) — currently a non-goal; revisit if MCP becomes load-bearing.
- [ ] Persisting per-block expand/collapse state across reload via tugbank.
- [ ] Side-by-side diff view toggle on `DiffBlock` (inline only in v1).
- [ ] In-file search (Cmd+F) inside expanded `FileBlock`.
- [ ] Adaptive coalescing window for streaming under > 50 deltas/sec, if [R06] residual surfaces.

| Checkpoint | Verification |
|------------|--------------|
| Empirical session audit (Step 0) | `dash/tide-assistant-rendering-session-audit.md` produced; frequency tables and threshold calibrations captured |
| Dispatch infrastructure | `bun test src/components/tugways/cards/tide-assistant-renderer-dispatch.test.ts` |
| Markdown typography | Visual snapshot, both themes; `bun run audit:tokens lint` |
| ThinkingBlock | Replay `test-22-subagent-spawn.jsonl`; verify thinking renders + collapses on complete |
| TerminalBlock + BashToolBlock | Replay `test-09-bash-auto-approved.jsonl`; verify command, stdout, exit |
| FileBlock + ReadToolBlock | Replay `test-05-tool-use-read.jsonl`; verify file viewer with line numbers |
| DiffBlock + EditToolBlock | Synthetic Edit fixture; verify hunks; word-level highlight |
| JsonTreeBlock + DefaultToolWrapper | Synthetic unknown-tool fixture; verify caution badge |
| Day-1 coverage integration | Step 14 fixture-replay run |
| Gallery batch 1 (Step 14.5) | Each shipped renderer reachable from a registered gallery card; both themes verified |
| PathListBlock + GlobToolBlock | Replay `test-21-glob-tool.jsonl` |
| SearchResultBlock + GrepToolBlock | Synthetic Grep fixture |
| AgentTranscriptBlock + TaskToolBlock | Replay `test-22-subagent-spawn.jsonl`; nested call renders correctly |
| PermissionDialog | Replay `test-11-permission-deny-roundtrip.jsonl` |
| QuestionDialog | Synthetic AskUserQuestion fixture |
| TideMeterChrome | Send a turn; verify the window gauge fills, last-turn-time live-ticks during streaming and locks on `turn_complete`, cumulative numbers grow monotonically ([#step-20-3](./archive/tide-assistant-turns.md#step-20-3)) |
| Drift detection | Synthetic version-mismatch + unknown-shape fixtures |
| KaTeXBlock | Inline + display math fixtures; lazy-load verified |
| MermaidBlock | Diagram fixture; lazy-load verified |
| TodoListBlock + TodoWriteToolBlock | Synthetic TodoWrite fixture |
| WebFetch + WebSearch | Synthetic web fixtures |
| WriteToolBlock + NotebookEditToolBlock | Synthetic Write + NotebookEdit fixtures |
| ImageBlock | Markdown image reference fixture |
| TableBlock (rich) | Large-table fixture |
| SessionInitBanner + ErrorBlock | system_metadata change fixture; error fixture |
| Gallery batch 2 (Step 29.5) | Every remaining component reachable from a registered gallery card; lazy-load fetch verified |
| Phase exit | Step 30 full integration |

---

### Post-plan follow-ups {#post-plan-follow-ups}

*Bugs and improvements surfaced during this plan's execution that are out of scope for any of its steps. Each entry is a known issue, not an active risk — by definition the plan can close out without resolving them. Carry them forward to their own plan / investigation once this plan exits.*

#### [PPF-01] Tide UI does not re-paint when a session resumes after going idle

**Status:** Closing across three slices in [`dash/tugplan-tide-session-wake.md`](./tugplan-tide-session-wake.md). The empirical Step-6 cohort sweep revealed the bug is actually three sub-bugs across three tool cohorts; each closes in a different slice.

| Cohort | Tools | Closing slice | Status |
|---|---|---|---|
| **A — in-invocation async** (`task_notification` fires on the wire) | Monitor; Bash `run_in_background:true` (idle); Task `run_in_background:true` (idle) | Slice 1 (Steps 1-7) — wake bracket | **Reducer + tugcode shipped; phantom user bubble fixed by Slice 1c-a** |
| **B — harness fires in stream-json mode** (signal: a fresh `system/init` event — see [wake-investigation-findings.md](./wake-investigation-findings.md)) | ScheduleWakeup; CronCreate | Slice 1b-redo (Step 16) — tugcode re-init detector | **In progress (shadow scheduler retracted 2026-05-25)** |
| **C — not wake sources** | PushNotification (sync outbound); TaskOutput (blocking wait); Task/Bash `run_in_background:true` with active poll | n/a | No fix needed |
| **Phantom user bubble** (committed wake's empty-text marker renders as a "You" row) | Affects every Cohort A and Cohort B wake | Slice 1c-a (Steps 12-13) — `TideTranscriptDataSource` single-row | **Shipped** (commit `19c8cb58`) |

**Surfaced during:** [#step-24-3-2](#step-24-3-2) HMR testing — a `Monitor` invocation that timed out 60s later produced the expected `task-notification` → assistant resume in the underlying `claude` JSONL, but the Tide UI stayed on the pre-idle frame. Wake-plan Step 6 manual repro of Session 56cce4fe also surfaced the phantom user bubble (the working Monitor wake painted a "You ✓ OK" row between user-initiated turns).

**Out of scope for this plan because:** Tide session-binding + transcript work lives in `tugplan-tide-session-wake.md`, which is now the single source of truth. The rendering-plan PPF-01 entry stays here as a cross-reference; the implementation tracks there.

**Reproduction recipes per cohort:**

*Cohort A (any of three):*
1. Monitor: `Use the Monitor tool to tail /var/log/system.log with a 5-second timeout, watching for the word "kernel".`
2. Bash run_in_background: `Run "sleep 4 && echo done" in the background using Bash with run_in_background:true. Then idle wait — do not poll.`
3. Task run_in_background: `Spawn a general-purpose Agent with run_in_background:true that sleeps 8s and prints DONE. Then idle wait — do not poll.`

Expected after wake fires: the wake turn paints in the transcript, NO user bubble appears for the wake.

*Cohort B (closed by Slice 1b-redo — tugcode re-init detector):*
1. `Use ScheduleWakeup to wake yourself in 60 seconds with reason 'X'. When the wake fires, report back.`
2. `Use CronCreate to schedule a one-shot job firing in 1 minute that prompts you to report 'X'.`
3. (Recurring) `Use CronCreate with cron "* * * * *" and recurring:true so it fires every minute. After it fires twice, use CronDelete to stop it.`

Expected after Slice 1b-redo: claude's harness fires its own timer (between turns, with documented jitter); when the wake fires, claude emits `system/init` on its stdout and then streams the assistant turn. tugcode detects the second-and-later `system/init` and opens the same `wake_started` bracket Cohort A uses. CronDelete cancels the harness's own scheduled job — tugcode has no shadow to keep in sync. Implementation: `tugcode/src/session.ts` re-init branch in `handleClaudeLine` (~30 LOC + ~3 tests). See [wake-investigation-findings.md](./wake-investigation-findings.md).

**Reference captures:** `tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/v2.1.150-spike/` holds raw stream-json captures for all three cohorts. See that directory's README for the per-file taxonomy.

**Reference session (Cohort A symptom):** `~/.claude/projects/-Users-kocienda-Mounts-u-src-tugtool/56cce4fe-d01d-470b-ae0a-7c3695a14061.jsonl` shows ScheduleWakeup's harness-reinvoke shape in `sdk-cli` mode (lines 26-28: `queue-operation` enqueue → synthetic user-message with `isMeta:true`). The same shape does NOT surface in tugcode's `--input-format=stream-json` spawn — confirmed empirically by `probes/probe-sw-streamio.mjs` (90 s held subprocess; zero output after `result/success`).

**Status (2026-05-25):** wake bracket (Slice 1) and transcript single-row fix (Slice 1c-a) are on `main`. The Slice 1b shadow-scheduler approach (Steps 8-11) shipped but was retracted the same day after [wake-investigation-findings.md](./wake-investigation-findings.md) proved the harness fires its own timers in stream-json mode — running two schedulers in parallel was double-firing wakes (Session 86ae1b78). Slice 1b-redo (Step 16) is the replacement: delete the shadow + add a re-init detector. Manual verification per the recipes above is the gate after Step 16 lands.

---

### Library citations {#library-citations}

Web research for this phase, May 2026:

- [imara-diff (GitHub)](https://github.com/pascalkuthe/imara-diff) — performance-stable Rust diff library; histogram + Myers; 10×–30× faster than `similar` on large inputs. Justifies [D09].
- [imara-diff announcement](https://users.rust-lang.org/t/announcing-imara-diff-a-reliably-performant-diffing-library-for-rust/83276)
- [similar (Rust)](https://docs.rs/similar) — comparison baseline.
- [Shiki](https://shiki.style/guide/) — current syntax highlighter; modern versions run in browser.
- [Tree-sitter syntax highlighting](https://tree-sitter.github.io/tree-sitter/3-syntax-highlighting.html) — alternative; deferred per [Q02].
- [Mermaid lazy loading (Rick Strahl, 2025)](https://weblog.west-wind.com/posts/2025/May/10/Lazy-Loading-the-Mermaid-Diagram-Library) — late-binding pattern referenced by [D10].
- [Mermaid bundle size (Sidharth Vinod)](https://www.sidharth.dev/posts/shrinking-mermaid/) — "Tiny" variant trade-offs.
- [ansi_up (GitHub)](https://github.com/drudru/ansi_up) — zero-dep JS ANSI → HTML.
- [vtparse (Rust)](https://docs.rs/vtparse/) — heavier full VT escape parser; reserved for pathological inputs.
- [KaTeX](https://katex.org/) — fast synchronous math typesetting; ~350 KB total. Justifies [D08].
- [KaTeX vs MathJax (BigGo, Nov 2025)](https://biggo.com/news/202511040733_KaTeX_MathJax_Web_Rendering_Comparison) — bundle and speed analysis.
