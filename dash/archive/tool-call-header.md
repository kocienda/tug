<!-- tugplan-skeleton v2 -->

## Tool-Call Header Regularization {#tool-call-header}

**Purpose:** Replace the ad-hoc, per-tool header treatments across all 21 tool-call blocks with one designed-once `ToolCallHeader` Tug component — a leftmost lifecycle **pulsing-dot** that fully tracks the call (streaming → awaiting approval → success / error / interrupted), a single typographic treatment for the tool name, properly-aligned non-clipping atom chips, full multi-line command display, and shared primitives for diff counts and item/line counts — then migrate every block onto it.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-05-30 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The dev-card transcript renders every tool call through a Layer-2 wrapper that composes a shared frame, `ToolBlockChrome` (`tool-block-chrome.tsx`), around a body kind. The chrome's *header* is supposed to be the "consistent frame so the user can scan the transcript and spot tool calls at a glance" (its own docstring). In practice the header has drifted: 21 wrappers each hand-roll their args summary, their counts, their badges, and their streaming treatment, producing the visual mess in the attached screenshots — a streaming **ring** that floats in the body *below* the header (`StreamingPlaceholder`), a left-border color stripe that nobody reads as "state," atom chips that clip at the top and bottom of the header line-box, single-line commands truncated with an ellipsis, and three mutually-inconsistent idioms for rendering counts.

Two facts make this the moment to fix it. First, the design-system already ships the exact primitive the state indicator needs: `TugProgressIndicator`'s `pulsing-dot` variant has the five lifecycle states (`running / paused / stopped / completed / aborted`) with a state→role color mapping (blue running, yellow paused, green completed, red aborted) — it was built to *be* the project-standard "work in flight" glyph and is already the session-state indicator in the status bar. Second, `session-phase-visual.ts` is a worked example of flattening a multi-axis lifecycle into the indicator's `phase / phaseVisual` API; the tool-call layer needs the same treatment one level down. The pieces exist; this plan assembles them into one header and brings every block into line.

#### Strategy {#strategy}

- **Model the lifecycle first.** Before any pixels move, define a `ToolCallPhase` that the dot can render, and a `toolCallPhaseVisual` mapping (mirroring `session-phase-visual.ts`). Derive the phase in `dispatchToolCallState` from the tool message's `status` plus the awaiting-approval signal plus interruption — so the header is a pure function of state ([L02]/[L06]).
- **Extract a real component.** Pull the header out of `ToolBlockChrome` into a dedicated, gallery-backed `ToolCallHeader` (`.tsx` + `.css`, owned tokens, [L19]/[L20]). The chrome keeps owning the frame/body/footer and just composes the header.
- **Standardize the trailing metadata.** Build three shared header primitives — `ToolHeaderCount` (item/line counts), `ToolHeaderDiffStat` (`+N −M`), `ToolHeaderTruncated` (capped-result flag) — so glob/grep/edit/read/write/notebook stop hand-rolling spans.
- **Fix the chip line-box and add multi-line command display** as explicit, separable layout decisions — the two things the current single-line sticky header structurally cannot do.
- **Migrate by family, verify continuously.** Bash/terminal, file-path (read/edit/write/notebook), search (glob/grep), and the body-bits wrappers each migrate as a flat step with its own checkpoint, then an integration step proves the whole gallery + real transcript.

#### Success Criteria (Measurable) {#success-criteria}

- Every tool block renders its header through `ToolCallHeader` — zero wrappers compose `ToolBlockChrome`'s header slots directly (verify: grep for the old header markup yields only the new component; `registeredTools()` count == blocks-using-`ToolCallHeader` count).
- The leftmost pulsing dot reflects all five phases for a real call: in-flight, awaiting-permission, awaiting-question, success, error, and interrupted (verify: gallery story per phase + an app-test that drives a permission prompt and asserts `data-phase="awaiting"` on the live tool row).
- Atom chips never clip vertically in the header (verify: gallery visual + a computed-style assertion that the chip's rendered box is fully inside the header content box; the `translateY(3px)` hack is deleted).
- A long bash command renders in full across multiple lines with no `text-overflow: ellipsis` and no horizontal scroll (verify: gallery story with a 600-char command; assert `scrollWidth <= clientWidth` and no ellipsis pseudo).
- Diff counts and item/line counts each render through exactly one shared primitive (verify: grep finds `ToolHeaderDiffStat` / `ToolHeaderCount` at every count site; the bespoke `.{glob,grep}-tool-block-count`, `.edit-tool-block-stats` rules are deleted).
- `cd tugrust && cargo nextest run` unaffected; `bun test` (pure-logic) green for the new phase-mapping + count-format helpers; `just app-test` parity story passes.

#### Scope {#scope}

1. A `ToolCallPhase` type + `toolCallPhaseVisual` mapping + derivation in `dispatchToolCallState`.
2. A new `ToolCallHeader` component (`.tsx` + `.css` + gallery) owning the dot, name typography, optional icon, args region, and a metadata slot.
3. Shared header metadata primitives: `ToolHeaderCount`, `ToolHeaderDiffStat`, `ToolHeaderTruncated`.
4. Chip line-box fix (delete the `translateY` nudge; correct header alignment so chips don't clip).
5. Multi-line, non-truncating command/args display mode.
6. Migration of all 21 tool blocks + `DefaultToolBlock` onto the new header.
7. Awaiting-approval ↔ tool-call correlation so the dot can show the waiting state.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Redesigning the body kinds (`TerminalBlock`, `DiffBlock`, `FileBlock`, `PathListBlock`, `JsonTreeBlock`) — only the *header* changes.
- Changing the footer-badge content semantics (exit code, "no output", duration) — they may *move* into the regularized system but their meaning is unchanged.
- The permission/question *dialog* rendering itself (`dev-permission-dialog.tsx`, `dev-question-dialog.tsx`) — only the correlation signal it exposes to the header.
- The tool-visibility policy (`dev-tool-visibility-policy.ts`) and drift detection — untouched.
- IndexedDB / SessionCache work (slated for removal elsewhere).

#### Dependencies / Prerequisites {#dependencies}

- `TugProgressIndicator` + `pulsing-dot` variant (already shipped).
- `session-phase-visual.ts` as the mapping pattern to mirror.
- `CodeSessionSnapshot.pendingApproval` / `pendingQuestion` (already on the snapshot).
- `TugAtomChip`, `TugBadge`, `TugTooltip` primitives (already shipped).

#### Constraints {#constraints}

- Tuglaws: [L01] one render; [L02] external state via `useSyncExternalStore`; [L03] `useLayoutEffect` for registrations; [L06] appearance via CSS/DOM, never React state; [L13] motion via CSS keyframes / `TugAnimator`; [L17] one-hop token resolution; [L19] component-authoring (`.tsx`+`.css`, docstring, exported props, `data-slot`); [L20] component-token sovereignty.
- HMR is always running — no manual builds for tugdeck.
- Use existing Tug components (TugBadge/TugAtomChip/TugProgressIndicator/TugTooltip); never hand-roll.
- Warnings-are-errors carries into TS/lint: leave zero new lint findings; fix pre-existing findings the migration touches.

#### Assumptions {#assumptions}

- The five `TugProgressIndicator` states cover every tool-call lifecycle reading the user named (success, failure, interruption, waiting). No new indicator variant is needed.
- Moving the command to its own multi-line row inside the header (rather than a separate band) keeps the sticky-pin telescoping behavior intact. Validated at [#step-4].
- The awaiting-approval signal correlates to a specific tool call via `tool_use_id`, which the `control_request_forward` wire event already carries and the snapshot already stores — confirmed by the [Q01] spike.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

Standard skeleton conventions apply. Anchors are explicit kebab-case; steps carry `**Depends on:**` and `**References:**` lines citing decisions ([D01]…), specs, and section anchors — never line numbers.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] How does the header learn a specific tool call is awaiting approval? (DECIDED) {#q01-awaiting-correlation}

**Question:** `ToolBlockProps` today carries only `status: streaming|ready|error`. To paint the dot yellow ("waiting / yell") the header must know *this* call is the one blocked on a permission or question dialog.

**Spike result (2026-05-30):** The `control_request_forward` wire event **already carries `tool_use_id`** — confirmed across the catalog from v2.1.104 through the current v2.1.154 (e.g. `test-11-permission-deny-roundtrip.jsonl`: `{ type: "control_request_forward", is_question: false, tool_name: "Read", tool_use_id: "…", request_id: "…" }`). It is merely absent from the *typed* `ControlRequestForward` interface, so it currently passes through the `[key: string]: unknown` index signature unnamed. Crucially, `extractForward` (reducer.ts) strips only `type` and keeps every other field, so **`snapshot.pendingApproval.tool_use_id` / `pendingQuestion.tool_use_id` are already populated today** — the join key flows all the way to the snapshot, just unused.

**Decision:** Direct id-join (the trivial form of the original option C). Promote `tool_use_id?: string` to a typed field on `ControlRequestForward`; set `phase = "awaiting"` when `pendingApproval?.tool_use_id === toolCall.toolUseId` (or `pendingQuestion?.tool_use_id`). No fragile shape-match (old option B) and no positional inference (old option A) — robust even with concurrent pending calls.

**Question variant confirmed by construction:** tugcode builds the forward at one site (`session.ts` `handle…`, `subtype === "can_use_tool"`): `tool_use_id: request.tool_use_id`, `is_question: toolName === "AskUserQuestion"`. Permission and question forwards share that single construction path — `is_question` only sets a boolean, it does **not** gate `tool_use_id`, which is copied from the SDK request unconditionally. The Agent SDK types the `can_use_tool` request's `tool_use_id` as a required `string`, and AskUserQuestion routes through the *same* `can_use_tool` subtype. So the question variant carries `tool_use_id` by construction — no empirical fixture needed; the absence of an `is_question:true` fixture in the catalog is a test-coverage gap, not a behavioral unknown.

**Resolution:** DECIDED — id-join on `tool_use_id`, structurally guaranteed for both permission and question forwards.

#### [Q02] Do diff/item counts live in the header or the footer? (DECIDED) {#q02-count-placement}

**Question:** Today counts are split — `read` shows a line-range badge in the header *and* "Showing N of M" in the footer; `edit` shows `+N −M` in the header; `glob`/`grep` show "N files/matches" in the header; `bash` shows duration/exit in the footer. Should the regularized system put all counts in one place?

**Decision (owner, 2026-05-30):** **Counts live in the header.** This is already the dominant placement — the refactor's job is to make the *format and typography* consistent, not to relocate counts. Every count kind (diff `+N −M`, item/line counts, truncated flag) renders trailing in the header through the [D06] shared primitives. `read`'s footer "Showing N of M lines" string is converted to a header `ToolHeaderCount` and the footer string is dropped.

**Note:** Post-mortem *execution* signals that are not counts — bash exit code, "(no output)", interrupted, duration — remain footer concerns; they are status, not counts, and [D02]'s dot already carries the headline error/interrupt state. The header carries the call's *shape* (counts); the footer carries the call's *outcome* (exit/duration).

**Resolution:** DECIDED — all counts in the header via [D06] primitives.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Multi-line command breaks sticky-header telescoping | med | med | Validate the `ResizeObserver`-driven `--tugx-toolblock-header-height` write still tracks a taller header ([#step-4]) | Pinned header overlaps body on scroll |
| Awaiting correlation misfires on concurrent calls | med | low | [Q01] escalation path to reducer-side stamping | Two `pending` calls in one turn |
| Dot + left-border stripe + icon = visually noisy | low | med | [D02] makes the stripe secondary/removable and the icon opt-out ([D08]) | Gallery review reads as cluttered |
| 21-block migration churns golden/fixture tests | med | high | Migrate per-family with a checkpoint each; update fixtures in the same step | `bun test` snapshot diffs balloon |

**Risk R01: Telescoping regression from a taller header** {#r01-telescoping}

- **Risk:** The chrome writes its measured header height into `--tugx-toolblock-header-height` so an inner actions row can pin beneath it; a multi-line command changes that height mid-stream.
- **Mitigation:** The existing `ResizeObserver` already observes the header element and re-writes on resize — verify it fires for the command-row growth and that the seeded first-paint value is correct.
- **Residual risk:** A one-frame-late offset on the very first paint of an unusually tall command; acceptable and self-corrects.

---

### Design Decisions {#design-decisions}

#### [D01] One `ToolCallHeader` component, composed by `ToolBlockChrome` (DECIDED) {#d01-one-header}

**Decision:** Extract the header row from `ToolBlockChrome` into a standalone `ToolCallHeader` component with its own `.tsx`/`.css`/gallery; the chrome composes it and keeps owning the frame, body region, error band, and footer.

**Rationale:**
- The user's mandate is "one common component we can design once, then customize and reuse." The header is the part that drifted; isolating it gives one design surface and one test surface.
- Keeps `ToolBlockChrome`'s existing responsibilities (actions-slot portal, fold/copy opt-ins, sticky pin height) intact — those are frame concerns, not header-content concerns.

**Implications:** New `--tugx-toolheader-*` token family ([L20]); the chrome's `--tugx-toolblock-header-*` tokens move/alias into it; every wrapper passes structured props (phase, name, icon, args, meta) instead of raw `argsSummary`/`toolIcon`/`footerBadges` header bits.

#### [D02] The pulsing-dot is the canonical lifecycle indicator; the border stripe is demoted (DECIDED) {#d02-dot-canonical}

**Decision:** A leftmost `TugProgressIndicator variant="pulsing-dot"` in the header is the single authoritative state signal. It replaces the in-body `StreamingPlaceholder` ring as the "in flight" cue. The left-border `data-status` stripe is demoted to a subtle secondary accent (kept for at-a-glance error scanning, or removed if the gallery reads cluttered — [R01-adjacent]).

**Rationale:**
- The user asked for exactly this: a pulsing dot in the leftmost header position, not a ring in the body.
- One glyph, five states, already themed and motion-correct ([L13]). The body ring and the border stripe are two *more* redundant state signals; collapsing to one is the regularization.

**Implications:** `StreamingPlaceholder`'s ring usage in bodies goes away (the body simply renders nothing while streaming; the header dot carries the signal). The dot's `state`/`role` come from [D03]'s phase via `phaseVisual`.

#### [D03] A `ToolCallPhase` lifecycle, derived in dispatch (DECIDED) {#d03-phase-model}

**Decision:** Introduce `ToolCallPhase = "in_flight" | "awaiting" | "success" | "error" | "interrupted"` (plus an implicit neutral/`idle`). Add `toolCallPhaseVisual(phase): { state, role }` mirroring `devSessionPhaseVisual`. Derive the phase in `dispatchToolCallState` and thread it on `ToolBlockProps` alongside the existing `status` (which stays for body composition).

**Rationale:**
- `streaming|ready|error` cannot express *awaiting approval*, *success*, or *interrupted* — the four readings the user explicitly named.
- Mirroring `session-phase-visual.ts` keeps one mental model and one tested mapping shape across the app.

**Mapping:**
- `in_flight` → `{ state: running, role: action }` (blue)
- `awaiting` → `{ state: paused, role: caution }` (yellow — permission/question)
- `success` → `{ state: completed, role: success }` (green)
- `error` → `{ state: aborted, role: danger }` (red)
- `interrupted` → `{ state: aborted, role: danger }` (red; distinguished by label/tooltip, not color)

**Implications:** Derivation reads `ToolUseMessage.status`, the awaiting signal ([Q01]), and an interruption signal (bash structured `interrupted`, or turn end reason). `ToolBlockStatus` is retained but `status === "ready"` splits into `success` vs neutral at the header.

#### [D04] Atom chips align to the header line-box; the `translateY` hack is deleted (DECIDED) {#d04-chip-alignment}

**Decision:** Fix the header's vertical rhythm so `TugAtomChip` sits centered without the `transform: translateY(3px)` nudge, and so nothing clips the chip's baked-text SVG (today the args slot's `overflow: hidden` + baseline alignment clip it — screenshot Image #1).

**Rationale:** The nudge is a per-pixel patch over a line-box mismatch; it breaks the moment the header gains a second row ([D05]). A chip that clips is a visible defect.

**Implications:** Header uses `align-items: center` for the identity row and a contained line-box; the chip utility's `vertical-align: middle` is honored; `overflow` clipping moves off the element that holds chips.

#### [D05] Commands/args render in full, multi-line, never truncated (DECIDED) {#d05-multiline-args}

**Decision:** The args region supports a non-truncating, wrapping multi-line presentation for command-shaped content (bash, grep, cron). No `text-overflow: ellipsis`, no hover-expand, no horizontal scroll — the full command is always visible.

**Rationale:** Directly requested. The current single-line `<code>` with end-ellipsis hides the part of a long command that matters and forces a tooltip; the screenshots show this failing.

**Implications:** The command moves to its own row beneath the identity row (dot + icon + name + trailing meta), so wrapping doesn't fight the inline badges. Atom-chip paths (read/edit/write) stay single-row identity (a basename chip needs no wrapping); only command-shaped args get the multi-line row. Sticky-height tracking re-verified ([R01]).

#### [D06] One primitive per count kind (DECIDED) {#d06-count-primitives}

**Decision:** Three shared header primitives replace all hand-rolled count markup: `ToolHeaderDiffStat` (`+N −M`, tone-add/remove), `ToolHeaderCount` (localized "N files"/"N matches"/"N lines"), `ToolHeaderTruncated` (capped-result flag). Each is a thin wrapper over `TugBadge` with fixed role/emphasis so every block reads identically.

**Rationale:** Today: `edit` hand-rolls `+N −M` spans, `glob`/`grep` hand-roll count + "truncated" spans, `read`/`write`/`notebook` use raw `TugBadge`, `read` also puts a count in the footer. Five idioms for one concept.

**Implications:** Bespoke CSS (`.edit-tool-block-stats*`, `.glob-tool-block-count`, `.glob-tool-block-truncation`, `.grep-tool-block-count`, etc.) is deleted; counts format through one tested helper.

#### [D07] Per-tool icon is centralized and opt-out (DECIDED) {#d07-icon-registry}

**Decision:** Keep per-tool lucide icons but resolve them from one central `toolIconFor(name)` map instead of each wrapper importing its own; `ToolCallHeader` takes `showIcon?: boolean` (default true) so a surface can suppress the icon when it would conflict with the leftmost dot.

**Rationale:** The user wants per-tool icons *and* the option to hide them next to the dot. One registry also makes the icon set auditable and consistent in size (some blocks use 12, most 14).

**Implications:** Wrappers stop importing lucide icons individually; the registry is the single source. Icon size is fixed in the header CSS, not per-wrapper.

---

### Deep Dives {#deep-dives}

#### Audit: every tool-call header today {#audit}

**Table T01: Current per-block header inventory** {#t01-audit}

| Block | Icon | Identity (args) | Trailing meta (idiom) | Footer | Streaming |
|-------|------|-----------------|-----------------------|--------|-----------|
| Bash | Terminal | `<code>` command, end-ellipsis + tooltip | — | exit/interrupted/(no output)/duration | body ring |
| Read | FileText | `TugAtomChip` basename | line-range `TugBadge` | "Showing N of M lines" (string) | body ring |
| Edit | FilePenLine | `TugAtomChip` basename | `+N −M` (bespoke spans) | — | body ring |
| Write | FilePlus | `TugAtomChip` | `TugBadge`×5 | — | body ring |
| NotebookEdit | Notebook | `TugAtomChip` | `TugBadge`×7 | — | body ring |
| Glob | Search | `<code>` pattern | "N files" + "truncated" (bespoke spans) | — | body ring |
| Grep | Search | `<code>` pattern | "N matches" + "truncated" (bespoke spans) | — | body ring |
| Agent (Task) | Bot | `<code>` description | — | — | body ring |
| AskUserQuestion | MessageCircleQuestion | — | `TugBadge`×4 | — | body ring |
| Skill | Sparkles | `<code>`×2 | — | — | `copyText`/`fold` |
| Monitor | Radar | `<code>` | — | — | `copyText` |
| Worktree | GitBranch | `<code>` | — | — | `copyText` |
| TaskMgmt | ListTodo | `<code>` | — | — | `copyText` |
| Cron | Clock | `<code>` | — | — | `copyText` |
| WebFetch | Globe | — | `TugBadge`×3 | — | `copyText` |
| WebSearch | Search | `<code>` | `TugBadge`×3 | — | `copyText` |
| RemoteTrigger | Zap | `<code>` | — | — | `copyText` |
| ShareOnboardingGuide | BookOpen | `<code>` | — | — | `copyText` |
| TaskInline | (none) | inline marker | — | — | — |
| Default | Wrench | — | — | — | body ring |

**What this shows:** (1) the state cue is a body ring everywhere plus a border stripe — never a header dot; (2) three icon sizes; (3) five distinct count idioms; (4) two args idioms (`<code>` vs chip) with no multi-line option; (5) chips only used by the four file-path blocks and they clip.

#### State-signal flow today {#state-flow}

`reducer` sets `ToolUseMessage.status: pending|done|error` → `dispatchToolCallState` maps to `streaming|ready|error` → wrapper picks body (`StreamingPlaceholder` ring while streaming) and passes `status` to `ToolBlockChrome` → chrome paints `data-status` border stripe + (for streaming) the body shows a ring. Nowhere does *awaiting approval*, *success*, or *interrupted* enter the tool row — those live only on the session-level status bar. [D03] closes that gap at the row level.

---

### Specification {#specification}

**`ToolCallHeader` props (contract):**
- `phase: ToolCallPhase` — drives the dot via `toolCallPhaseVisual`.
- `toolName: string` — single typographic treatment (`--tugx-toolheader-name-*`).
- `icon?: ReactNode` / `showIcon?: boolean` (default true) — per-tool glyph, suppressible ([D07]).
- `identity?: ReactNode` — the single-row identity content (a chip, a short label).
- `command?: ReactNode` — the multi-line, non-truncating command row ([D05]); mutually-or-additively renders below identity.
- `meta?: ReactNode` — trailing metadata cluster (counts/diff-stats/truncated via [D06] primitives).
- `actionsSlotRef` / portal target — preserved from the chrome's existing actions contract.

**`ToolCallPhase`** and **`toolCallPhaseVisual`** per [D03].

**Shared primitives** per [D06]: `ToolHeaderDiffStat`, `ToolHeaderCount`, `ToolHeaderTruncated`.

**`toolIconFor(name): ReactNode`** per [D07] — central registry keyed by canonical tool name.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/components/tugways/cards/tool-blocks/tool-call-header.tsx` + `.css` | The header component ([D01]) |
| `tugdeck/src/components/tugways/cards/tool-blocks/tool-header-meta.tsx` + `.css` | `ToolHeaderCount` / `ToolHeaderDiffStat` / `ToolHeaderTruncated` ([D06]) |
| `tugdeck/src/components/tugways/cards/tool-blocks/tool-icons.ts` | `toolIconFor` registry ([D07]) |
| `tugdeck/src/lib/code-session-store/tool-call-phase-visual.ts` + `__tests__` | `ToolCallPhase` + `toolCallPhaseVisual` ([D03]) |
| `tugdeck/src/components/tugways/cards/gallery-tool-call-header.tsx` | Gallery stories (per-phase, chip, multi-line command) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `ToolCallHeader` | component | `tool-call-header.tsx` | [D01] |
| `ToolCallPhase` | type | `tool-call-phase-visual.ts` | [D03] |
| `toolCallPhaseVisual` | fn | `tool-call-phase-visual.ts` | [D03] |
| `deriveToolCallPhase` | fn | `dev-assistant-renderer-dispatch.ts` | from status + awaiting + interrupt |
| `ToolBlockProps.phase` | field | `tool-blocks/types.ts` | threaded alongside `status` |
| `ControlRequestForward.tool_use_id` | field | `code-session-store/types.ts` | promote from index-signature to typed optional ([Q01]) |
| `ToolHeaderCount`/`DiffStat`/`Truncated` | components | `tool-header-meta.tsx` | [D06] |
| `toolIconFor` | fn | `tool-icons.ts` | [D07] |
| `StreamingPlaceholder` | component | `tool-block-chrome.tsx` | ring usage removed; header dot replaces ([D02]) |

---

### Test Plan Concepts {#test-plan-concepts}

| Category | Purpose | When |
|----------|---------|------|
| Unit (bun:test, pure) | `toolCallPhaseVisual` mapping; `deriveToolCallPhase`; count formatters | [#step-1], [#step-3] |
| Gallery (visual) | Per-phase dot; chip no-clip; multi-line command; count primitives | [#step-2]–[#step-4] |
| Real-app (`just app-test`) | Live permission prompt drives `data-phase="awaiting"`; interrupted call goes red | [#step-6], [#step-9] |
| Drift/contract | Fixture-replay transcripts still route + render after migration | [#step-9] |

No mock-store assertion tests; no fake-DOM render tests — pure-logic + gallery + real-app only.

---

### Execution Steps {#execution-steps}

> Commit after all checkpoints pass. Migrate by family with a checkpoint each.

#### Step 1: Tool-call phase model + visual mapping {#step-1}

**Commit:** `feat(tool-header): add ToolCallPhase model and toolCallPhaseVisual mapping`

**References:** [D03] phase model, (#state-flow, #d03-phase-model), mirrors `session-phase-visual.ts`

**Artifacts:** `tool-call-phase-visual.ts` + tests; `deriveToolCallPhase` in dispatch; `ToolBlockProps.phase`.

**Tasks:**
- [ ] Define `ToolCallPhase` + `toolCallPhaseVisual` (state×role per [D03]).
- [ ] `deriveToolCallPhase(message, { awaiting, interrupted })`; thread `phase` on `ToolBlockProps` in `dispatchToolCallState` (leave `status` intact for bodies).
- [ ] Awaiting + interrupt inputs stubbed for now (awaiting wired at [#step-6]).

**Tests:**
- [ ] Unit: every phase maps to the documented `{state, role}`.
- [ ] Unit: `deriveToolCallPhase` covers pending/done/error × awaiting/interrupt.

**Checkpoint:**
- [ ] `cd tugdeck && bun test tool-call-phase`

---

#### Step 2: `ToolCallHeader` component + gallery {#step-2}

**Depends on:** #step-1

**Commit:** `feat(tool-header): ToolCallHeader component with leftmost pulsing-dot`

**References:** [D01] one header, [D02] dot canonical, [D07] icon registry, (#d01-one-header, #d02-dot-canonical, #specification); [L19]/[L20]

**Artifacts:** `tool-call-header.tsx`+`.css`; `tool-icons.ts`; `gallery-tool-call-header.tsx`.

**Tasks:**
- [ ] Build the header: leftmost `pulsing-dot` (`phaseVisual={toolCallPhaseVisual}`), optional icon (`showIcon`), name typography, `identity`/`command`/`meta`/actions slots.
- [ ] `toolIconFor` registry; fixed icon size in CSS.
- [ ] Own `--tugx-toolheader-*` tokens; preserve the actions-slot portal + sticky-height write.
- [ ] Gallery stories: one per phase + icon-on/off.

**Tests:**
- [ ] Gallery renders all five phases with correct dot color.

**Checkpoint:**
- [ ] HMR: gallery shows the per-phase dots and no console errors.

---

#### Step 3: Shared header metadata primitives {#step-3}

**Depends on:** #step-2

**Commit:** `feat(tool-header): ToolHeaderCount/DiffStat/Truncated primitives`

**References:** [D06] count primitives, [Q02] placement, (#d06-count-primitives, #q02-count-placement)

**Artifacts:** `tool-header-meta.tsx`+`.css` + formatter tests.

**Tasks:**
- [ ] `ToolHeaderDiffStat`, `ToolHeaderCount` (localized plural), `ToolHeaderTruncated` over `TugBadge` — all render trailing in the header per [Q02].
- [ ] Gallery story for the meta cluster.

**Tests:**
- [ ] Unit: count formatter plural/locale; diff-stat sign formatting.

**Checkpoint:**
- [ ] `cd tugdeck && bun test tool-header-meta`

---

#### Step 4: Chip alignment fix + multi-line command row {#step-4}

**Depends on:** #step-2

**Commit:** `fix(tool-header): chips no longer clip; commands render multi-line`

**References:** [D04] chip alignment, [D05] multi-line args, Risk R01, (#d04-chip-alignment, #d05-multiline-args, #r01-telescoping)

**Artifacts:** header CSS line-box + command-row rules; delete `translateY(3px)` nudge.

**Tasks:**
- [ ] Delete the chip `translateY` hack; fix header line-box so chips center and never clip (Image #1).
- [ ] Add the wrapping, non-truncating command row beneath identity (no ellipsis, no h-scroll).
- [ ] Re-verify the `ResizeObserver` header-height write tracks the taller header (R01).
- [ ] Gallery: long-command story + chip story.

**Tests:**
- [ ] Gallery: 600-char command wraps fully; chip box fully inside header box.

**Checkpoint:**
- [ ] HMR visual: no clip, no ellipsis, sticky header still telescopes on scroll.

---

#### Step 5: Compose `ToolCallHeader` into `ToolBlockChrome`; retire the body ring {#step-5}

**Depends on:** #step-3, #step-4

**Commit:** `refactor(tool-block): chrome composes ToolCallHeader; drop body streaming ring`

**References:** [D01], [D02], (#d01-one-header, #d02-dot-canonical)

**Artifacts:** `tool-block-chrome.tsx`/`.css` updated to render `ToolCallHeader`; `StreamingPlaceholder` ring usage removed.

**Tasks:**
- [ ] Chrome renders `ToolCallHeader` (passing through phase/name/icon/identity/command/meta); keep frame/body/error/footer + actions portal + fold/copy opt-ins.
- [ ] Remove the in-body ring (header dot is the signal); demote/limit the border stripe per [D02].
- [ ] Bridge: wrappers still pass old props until migrated per-family (chrome adapts).

**Tests:**
- [ ] Existing dispatch/chrome tests pass; gallery chrome story intact.

**Checkpoint:**
- [ ] `cd tugdeck && bun test tool-block && cargo` n/a — `bun test`

---

#### Step 6: Wire awaiting-approval correlation (resolve [Q01]) {#step-6}

**Depends on:** #step-5

**Commit:** `feat(tool-header): dot shows awaiting state during permission/question`

**References:** [Q01] correlation (DECIDED — id-join), [D03], (#q01-awaiting-correlation)

**Artifacts:** `tool_use_id?: string` promoted onto `ControlRequestForward` (`code-session-store/types.ts`); awaiting derivation in the transcript view / `deriveToolCallPhase`.

**Tasks:**
- [ ] Add typed `tool_use_id?: string` to `ControlRequestForward` (value already flows via `extractForward` → snapshot; this only names it).
- [ ] Thread the awaiting flag: `pendingApproval?.tool_use_id === toolCall.toolUseId || pendingQuestion?.tool_use_id === toolCall.toolUseId` → `phase: "awaiting"`.

**Tests:**
- [ ] Unit: id-join sets `awaiting` for the matching call only (permission and question forwards).
- [ ] `just app-test`: trigger a permission prompt; assert the live tool row shows `data-phase="awaiting"` (yellow dot), then `success` after Allow.

**Checkpoint:**
- [ ] `just app-test <permission-parity-test>` → `VERDICT: PASS`

---

#### Step 7: Migrate Bash + search family (bash/glob/grep) {#step-7}

**Depends on:** #step-5, #step-6

**Commit:** `refactor(tool-blocks): bash/glob/grep onto ToolCallHeader + shared meta`

**References:** [D05] multi-line command, [D06] counts, (#audit, #t01-audit)

**Tasks:**
- [ ] Bash command → multi-line command row; footer badges stay (post-mortem).
- [ ] Glob/grep counts + truncated → `ToolHeaderCount` / `ToolHeaderTruncated`; pattern → command row.
- [ ] Delete bespoke `.{glob,grep}-tool-block-count*` rules.

**Tests:**
- [ ] Gallery stories per block; fixture replay green.

**Checkpoint:**
- [ ] `cd tugdeck && bun test bash glob grep`

---

#### Step 8: Migrate file-path family (read/edit/write/notebook) {#step-8}

**Depends on:** #step-5

**Commit:** `refactor(tool-blocks): file-path blocks onto ToolCallHeader; chip clip fixed`

**References:** [D04] chip alignment, [D06] diff stats, (#d04-chip-alignment, #d06-count-primitives)

**Tasks:**
- [ ] Read/edit/write/notebook identity → chip in the fixed line-box; `+N −M` → `ToolHeaderDiffStat`; line/range counts → `ToolHeaderCount`.
- [ ] Resolve read's split count ([Q02]); delete `.edit-tool-block-stats*`.

**Tests:**
- [ ] Gallery; chip-no-clip assertion; fixture replay green.

**Checkpoint:**
- [ ] `cd tugdeck && bun test read edit write notebook`

---

#### Step 9: Migrate body-bits + remaining blocks; integration checkpoint {#step-9}

**Depends on:** #step-7, #step-8

**Commit:** `refactor(tool-blocks): migrate remaining blocks; retire legacy header markup`

**References:** [D01], [D02], [D07], (#audit, #success-criteria)

**Tasks:**
- [ ] Migrate agent/skill/monitor/worktree/taskmgmt/cron/webfetch/websearch/remote-trigger/share-onboarding/ask-user-question/task-inline/default onto `ToolCallHeader` (icons via `toolIconFor`).
- [ ] Remove all legacy header markup paths from `ToolBlockChrome`; delete dead tokens/CSS.
- [ ] Sweep: zero wrappers touch old header slots directly.

**Tests:**
- [ ] Full `bun test`; fixture-replay transcripts render; `just app-test` parity story.

**Checkpoint:**
- [ ] `cd tugdeck && bun test` green; `just app-test` → `VERDICT: PASS`; grep proves no legacy header markup remains.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** One `ToolCallHeader` Tug component — leftmost lifecycle pulsing-dot tracking in-flight/awaiting/success/error/interrupted, single name typography, non-clipping chips, full multi-line commands, and shared count/diff-stat primitives — adopted by every tool-call block.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Every block routes its header through `ToolCallHeader` (grep proof).
- [ ] Dot reflects all five phases including awaiting (app-test).
- [ ] No chip clipping; `translateY` hack deleted (gallery + computed-style).
- [ ] Long commands render multi-line, no ellipsis (gallery).
- [ ] Counts/diff-stats each go through one primitive; bespoke CSS deleted.
- [ ] `bun test` green; `just app-test` parity `VERDICT: PASS`; `cargo nextest run` unaffected.

| Checkpoint | Verification |
|------------|--------------|
| Header unified | grep: only `ToolCallHeader` renders tool headers |
| Lifecycle complete | app-test asserts `data-phase` across permission flow |
| Chips/commands | gallery visual + assertions |
| Counts unified | grep: `ToolHeader{Count,DiffStat,Truncated}` at every count site |
