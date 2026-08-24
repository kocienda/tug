## QuestionDialog → Single Morphing Block {#question-dialog-improvements}

**Purpose:** Rebuild the `AskUserQuestion` surface so the live "asking" UI and the durable answered record are ONE persistent `BlockChrome` mounted at the tool_use position — the option/button chrome simply disappears on submit, leaving the Q→A record in place with no width, treatment, or position shift — and fix four adjacent papercuts (option truncation, double-confirm on single questions, typing fonts, and the chat-about affordance).

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-06-22 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Today the `AskUserQuestion` tool has **two separate component surfaces at two different transcript positions**. The live "asking" UI is `QuestionDialog` (`chrome/dev-question-dialog.tsx`), mounted at the assistant-row *foot* and framed by `TugInlineDialog` — a 520px-capped, centered, raised card. The durable answered record is `AskUserQuestionToolBlock` (`cards/blocks/ask-user-question-tool-block.tsx`), mounted at the *tool_use* position and framed by `BlockChrome` — a full-width, flat block. The two hand off across the tool lifecycle (the block returns `null` while the dialog is live), so when the user submits, a 520px raised card unmounts at the foot and a full-width flat block mounts a slot up — a jarring jump in width, surface treatment, and position. The same 520px cap is also why option buttons truncate.

The user's directive: *the answered transcript record should be the basis for how the live questions are constructed*, so that on submit "the answer options section just goes away, leaving the block-renderer look with the answers." We confirmed (via `tugcode`/`code-session-store`) that a `tool_use` Message for the AskUserQuestion call exists in `pending` status concurrently with `pendingQuestion`, correlated by `tool_use_id`. That makes a single in-place morph possible: the tool block owns both states, and the same mounted `BlockChrome` swaps only its body.

#### Strategy {#strategy}

- **Invert ownership.** `AskUserQuestionToolBlock` becomes the single owner of both states at the tool_use position; the foot-slot `QuestionDialog` handoff is removed.
- **Extract a frameless wizard.** Pull the interactive guts out of `TugInlineDialog` into a `QuestionWizard` body the block renders inside its `BlockChrome`. Keep the heavy machinery (focus trap, spatial order, A9 preservation, constant-geometry sizers) intact.
- **Persist the chrome across the morph.** One `BlockChrome` stays mounted from `pending` through `ready`; only `children` swap (live wizard ↔ Q→A summary). This is what makes the transition truly zero-shift.
- **Keep the reskinned paged wizard** for multi-question payloads (rail + panel), now living inside the block body — per the user's call.
- **Fix the four papercuts** as small, independently-checkpointed steps after the structural move lands: single-question gesture count, typing fonts, the chat-about rework, and the scrim rework.
- **Rework the card-modal scrim** ([P19] law) so the in-place question block is the single bright island — a deliberate CSS selector change (dim the live turn's sibling blocks + prose, keep the question block bright), not a verification pass.

#### Success Criteria (Measurable) {#success-criteria}

- On submit, the `BlockChrome` frame does not change width, x-position, or surface treatment; only the option rows + action row vanish and the answers remain. (Verify: app-test screenshot before/after submit; the chrome root's bounding box left/width are unchanged.)
- Option rows render at full transcript block width and no option label/description truncates for a representative long-option payload. (Verify: app-test with a long-option fixture; no `text-overflow: ellipsis` clipping on option labels.)
- A single single-select question with the recommended default submits in ONE Return (Send enabled + focused on mount); a deliberate change to a non-default option submits in pick → Send. No gesture is spent re-confirming the preseeded default. (Verify: unit test on the Submit gate + app-test keystroke count.)
- The free-text answer field and the chat-about reply field render in the user's configured editor font (`--tug-font-family-editor`). (Verify: computed-style assertion / visual.)
- In chat-about (decline) mode: the top action row reads `Back` + `Reply`, there is no bottom `Back to questions` button, the hint reads `Return for a new line • Shift-Return to send reply`, Shift-Return sends, and the whole-question Cancel is NOT reachable without going Back first. (Verify: app-test decline flow.)
- `cd tugrust && cargo nextest run` and `bun test` (tugdeck) pass; `bun run audit:theme-contrast` unaffected.

#### Scope {#scope}

1. Move live "asking" ownership into `AskUserQuestionToolBlock`; remove the foot-slot `questionSlot` and the dispatch `question` kind.
2. Extract `QuestionWizard` (frameless interactive surface) from `QuestionDialog`; render it inside `BlockChrome` while live.
3. Persist one `BlockChrome` across `pending → ready` so the morph is in-place (zero-shift), with collapse suppressed while live.
4. Single-question: keep an explicit Send, remove the review/auto-advance detour.
5. Editor font for the free-text answer field and the chat-about reply field.
6. Chat-about rework: `Back`+`Reply` top actions, drop bottom `Back to questions`, new hint text, Shift-Return send, no whole-question Cancel from decline mode.
7. Rework the card-modal scrim so the in-place question block is the single bright island; confirm full-width option layout (truncation fix).

#### Non-goals (Explicitly out of scope) {#non-goals}

- Changing the answered Q→A summary's content/format (it already exists and is the target look).
- Changing the salvage path (`SalvageWizard`) beyond what the shared `QuestionWizard` extraction requires.
- Changing the wire protocol, tugcode bridging, or `respondQuestion` semantics.
- Replacing the multi-question paged wizard with an all-stacked layout (explicitly rejected by the user this round — keep the reskinned wizard).
- The PermissionDialog foot-slot (untouched; only the question slot moves).

#### Dependencies / Prerequisites {#dependencies}

- Confirmed fact: a `tool_use` Message (status `pending` → dispatch `streaming`) coexists with `pendingQuestion`, correlated by `tool_use_id` (`code-session-store` reducer `handleControlRequestForward`; `control_request_forward.tool_use_id`).
- `ToolBlockProps` already exposes `toolUseId` and `session` — no new dispatch plumbing required to correlate or to round-trip the answer.
- `BlockChrome` header already supports a `phase` (`awaiting`) reading on its lifecycle dot.

#### Constraints {#constraints}

- Tuglaws apply ([L02], [L03], [L06], [L19], [L20], [L23], [L24]) — see #state-zone-mapping. WARNINGS-ARE-ERRORS for any Rust touched (none expected). bun only; tugdeck HMR is live.
- Mount identity must hold across `pending → ready` ([L26]) for the morph — the block is keyed by `message.messageKey` in `CodeRowBody`, which is stable, so the same component instance persists; the plan must not introduce a remount on the transition.
- Real code paths only — verification is via the running Tug.app app-test and real fixtures, not jsdom render tests or mock-store assertions.

#### Assumptions {#assumptions}

- AskUserQuestion is always the assistant's last in-flight action while a question is pending (the turn is blocked), so exactly one `pending` AskUserQuestion tool block is live at a time, and `pendingQuestion.tool_use_id === toolUseId` is an unambiguous 1:1 match.
- The card-level providers the foot dialog relies on (focus manager, responder chain / escape ladder, A9 bag, the `[P19]` scrim host) are equally in scope at the tool_use position, since both sit inside the same `CardHost`/transcript subtree.
- The dispatch's awaiting-dialog join already reflects the pending question: `CodeRowBody` passes `awaitingToolUseId = pendingApproval?.tool_use_id ?? pendingQuestion?.tool_use_id` into `dispatchToolCallState`, so the tool row's lifecycle dot already reads `awaiting` — the block reads/forwards it rather than recompute ([Q02]/[P10]).

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

Anchors are explicit and kebab-case; plan-local decisions use `[P01]`; global tuglaws decisions are cited by reference as `[D##]`/`[L##]`/`[P19]`-style law tags (e.g. the card-modal/scrim laws live in `tuglaws/`).

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Card-modal scrim must dim the live turn's OTHER blocks while the question block stays bright (OPEN) {#q01-scrim-mid-transcript}

**Question:** The card-modal scrim (`dev-card.css`, the `[data-inline-dialog-pending="true"]` rules) was built around the foot-slot dialog as a **sibling** of the turn body: it dims every transcript cell except the one that `:has(.dev-question-dialog)`, and within the live cell it explicitly dims the prose (`.dev-card-transcript-code-body`), treating the bright island as a sibling of that body. When the live question moves *inside* the tool block (inside `CodeRowBody`), what is the correct set of selectors so the question tool block is the single bright island while everything else in the live turn dims?

**Why it matters:** This is a deliberate CSS rework, not a marker move — and it carries a hard CSS hazard: **opacity creates a group; a descendant cannot render brighter than a dimmed ancestor.** If any common ancestor of the question block is dimmed, the question block can never be re-lit.

**What the code confirms (de-risked):**
- The live cell stays excepted from the wholesale dim because `:has(.dev-question-dialog)` still matches once the wizard carries that marker class (the wizard is inside the cell).
- The turn body `<div ref=bodyRef>` is **not** opacity-dimmed, and tool blocks are **not** `.dev-card-transcript-code-body` descendants (that class is on the prose `TugMarkdownBlock` only). So there is **no common dimmed ancestor** over the question block → the group-opacity dead-end is avoided.
- The remaining work: keep dimming the prose, and **add** dimming for the live turn's *sibling* tool blocks (`.tool-block-chrome:not(:has(.dev-question-dialog))` within the live cell) so the question block is the lone bright island. Today those sibling tool blocks in the live turn are not explicitly dimmed.

**Plan to resolve:** Implemented as its own step (#step-6) with explicit selectors; the opacity-group hazard is a standing watch-item — never apply a wholesale dim to the turn body `<div>` or the live cell, only to specific siblings.

**Resolution:** OPEN — resolved in #step-6 (scrim rework).

#### [Q02] `awaiting` dot is already wired via `awaitingToolUseId` (DECIDED) {#q02-awaiting-phase}

**Question:** Does the block need to source `phase="awaiting"` itself, or is it already supplied?

**Why it matters:** Avoid double-sourcing the dot's reading.

**Resolution:** DECIDED (already wired). `CodeRowBody` passes `awaitingToolUseId = pendingApproval?.tool_use_id ?? pendingQuestion?.tool_use_id` into `dispatchToolCallState`, which folds it into the tool row's `phase` so the lifecycle dot already reads `awaiting` while a question is pending. The block does **not** recompute the phase — it only needs to actually render `BlockChrome` while live (today it `return null`s during streaming, so the chrome+dot never mount). [P10] is therefore mostly existing behavior; see #step-2. No `deriveToolCallPhase` override required.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Focus-trap / escape ladder behaves differently mid-transcript | high | med | Spike early in #step-2; the providers are card-level so should be position-agnostic | Escape mis-routes or trap leaks |
| History-collapse wrapper folds the live question away | high | low | Force-expand + disable chevron via a `BlockChrome` prop while `isLive` ([P07]); AskUserQuestion already mounts expanded by default | A pending question can be collapsed |
| Wrapper swap to force-expand causes a remount (breaks the morph) | high | low | Force-expand is a prop through the constant wrapper, NOT removing `ToolBlockHistoryCollapse` while live ([P07], [L26]) | A flash/remount on `pending → ready` |
| A9 reload mid-question loses in-progress answers after the foot→block move | med | low | Keep the `question-dialog/<request_id>` key; the bag is restored at card mount regardless of position | Reload mid-question drops selections |
| Constant-geometry sizers / ResizeObserver misbehave inside a collapsible block | med | low | Sizers are CSS-grid intrinsic; keep them; verify the panel floor still ratchets | Panel height wobbles on advance |
| Mount identity breaks on `pending → ready` (remount instead of morph) | high | low | Do not change the block's React key; verify the same instance persists | A flash/reflow on submit |

**Risk R01: Mid-transcript focus & scrim** {#r01-focus-scrim}

- **Risk:** The card-modal focus trap, escape ladder, and scrim were validated only for the foot-slot dialog.
- **Mitigation:** Spike in #step-2 against the running app; move the bright-island marker class onto the block root if the scrim keys off it; keep `useFocusTrap`/`useInlineDialogScope` wiring identical (they are position-agnostic by construction).
- **Residual risk:** Subtle stacking-context differences mid-transcript may need a CSS nudge.

**Risk R02: Collapse hides the question** {#r02-collapse}

- **Risk:** Every tool block is wrapped in `ToolBlockHistoryCollapse`; a collapsed block would hide a live, blocking question.
- **Mitigation:** While `isLive`, force the block expanded and render the chevron disabled ([P07]).
- **Residual risk:** None expected once enforced.

---

### Design Decisions {#design-decisions}

#### [P01] Single morphing block at the tool_use position (DECIDED) {#p01-single-morphing-block}

**Decision:** `AskUserQuestionToolBlock` owns BOTH the live "asking" state and the durable answered state, rendering one persistent `BlockChrome` at the tool_use position whose `children` swap between the live wizard and the Q→A summary.

**Rationale:**
- True zero-shift: the same mounted frame stays put across `pending → ready`, so submit only removes the option/action chrome (the user's "just poof" requirement).
- Eliminates the dual-position handoff (foot dialog vs. tool block) that caused the width/treatment/position jump.

**Implications:**
- The block reads `session.pendingQuestion` via `useSyncExternalStore` and branches on `isLive`.
- The foot-slot `questionSlot` and the dispatch `question` kind are removed.
- Mount identity must hold ([L26]) — no key change on the transition.

#### [P02] Live frame is BlockChrome; drop TugInlineDialog for questions (DECIDED) {#p02-block-frame}

**Decision:** The live surface wears the full block-renderer frame (`BlockChrome`: tool header + lifecycle dot, full transcript width, flat treatment). `TugInlineDialog` is no longer used by the question surface.

**Rationale:**
- Width and treatment must match the answered record for a seamless morph; `BlockChrome` is that record's frame.
- Resolves option truncation for free (full block width replaces the 520px `--tugx-idialog-max-width`).

**Implications:**
- The live header reads the tool identity (`AskUserQuestion`) rather than a "Claude has a question" titled card — an accepted, intended consequence.
- Header dot reads `awaiting` while live (see [Q02]).

#### [P03] Keep the reskinned paged wizard for multi-question (DECIDED) {#p03-keep-wizard}

**Decision:** Multi-question payloads keep the rail+panel paged wizard (one question in the panel at a time), reskinned to live inside the block body. Single-question payloads render their options inline (no rail/panel).

**Rationale:**
- User's explicit call this round (guided one-at-a-time flow over an all-stacked layout).

**Implications:**
- For multi-question, the body still swaps rail+panel → stacked Q→A on submit (the frame stays put, so width/position don't shift; the multi-Q body morph is the accepted residual).
- Constant-geometry sizers stay relevant and are retained.

#### [P04] Single-question: accept the seeded default in one Return, Send still visible (DECIDED) {#p04-single-question}

**Decision:** For a single-question payload, the Send button is enabled and focused on mount (the first option is already preseeded), so a single Return accepts the seeded default and submits. Send stays visible; changing the pick still routes through pick → Send. The review/auto-advance index is never entered for a single question.

**Rationale:**
- Current behavior is already two Returns (pick commits the *preseeded* default + arms focus to Submit, then Submit). The user's complaint ("hitting return twice") is that the **first Return is spent re-confirming a default that was already selected** — it feels like a no-op. The fix is to not require that confirming gesture for the default.
- This reconciles the two signals: the user's prose wants one gesture for the common "accept the recommendation" case; their AskUserQuestion answer wants a visible Send button to remain. Both hold: default = one Return; deliberate change = pick then Send.

**Implications:**
- The Submit gate for a single question must treat the preseed as confirmable (Send enabled on mount), rather than requiring a prior `visited`-marking pick.
- `armAdvance`/`nextAdvanceIndex` must not route a single-question pick into the review index; picking a *different* option re-selects and keeps focus answerable, with Send still the commit.
- This decision is **single-question only**; multi-question keeps its existing per-row commit + review flow ([P03]).
- The implementer must first re-establish the exact current gesture count against `main` (the trace above is the expectation) so the step targets the real friction and is not a no-op.

#### [P05] Submit/Cancel live in a body action row (DECIDED) {#p05-action-row}

**Decision:** The wizard's Submit/Cancel (and decline-mode Back/Reply) render as an action row at the foot of the `QuestionWizard` body, not portaled into the `BlockChrome` header actions slot.

**Rationale:**
- Keeps focus-trap ordering and spatial-grid nodes local to the wizard.
- They vanish cleanly with the body swap on submit (the "poof").

**Implications:**
- The chrome header actions slot is left to its normal (Copy/chevron) affordances.

#### [P06] Correlate the live question by tool_use_id (DECIDED) {#p06-correlation}

**Decision:** `isLive = status === "streaming" && pendingQuestion?.tool_use_id === toolUseId`. The live question payload is read from `pendingQuestion.input`; the answer round-trips with `pendingQuestion.request_id`.

**Rationale:**
- `control_request_forward.tool_use_id` is the confirmed stable correlation id; `ToolBlockProps` already carries `toolUseId`.

**Implications:**
- No new dispatch plumbing; the block subscribes to the store for `pendingQuestion`.

#### [P07] Suppress collapse while live (DECIDED) {#p07-suppress-collapse}

**Decision:** While `isLive`, the block is force-expanded and its history-collapse chevron is rendered disabled (non-interactive).

**Rationale:**
- A pending question is blocking; it must not be foldable away.

**Implications:**
- The collapse boolean is owned by `ToolBlockHistoryCollapse`, which wraps the block in `CodeRowBody` (`block-chrome.tsx` gates `blockCollapsed ? null : children`). Force-expand MUST be threaded as a prop/signal *through* `BlockChrome` (or the collapse handle) while live — keeping the same wrapper element mounted.
- It must NOT be done by having `CodeRowBody` skip the `ToolBlockHistoryCollapse` wrapper while live: swapping the wrapper in/out changes the element tree across `pending → ready` and **breaks the morph's mount identity ([L26])**, causing a remount/flash. The wrapper stays constant; only its effective `collapsed` is pinned false + chevron disabled.
- Favorable default: AskUserQuestion is in `EXPANDED_BY_DEFAULT` and the expansion override is keyed per `toolUseId` (a new question = new id), so a live question always *arrives* expanded; the force-expand only has to defeat a manual chevron click while live.

#### [P08] Editor font for user-typing inputs (DECIDED) {#p08-editor-font}

**Decision:** The free-text answer field (`TugInput`) and the chat-about reply field (`TugTextarea`) use the editor font tokens (`--tug-font-family-editor`, with matching size/line-height) — the same family the prompt-entry editor uses, reflecting the user's configured font.

**Rationale:**
- Communicates "user typing" and matches the prompt entry, per the user's request.

**Implications:**
- A cascade-scoped CSS rule on the question free-text / decline fields sets the font family (and size) to the editor tokens ([L20] instance override; the inputs keep their own component tokens otherwise).

#### [P09] Chat-about (decline) mode rework (DECIDED) {#p09-chat-about}

**Decision:** In decline mode: the top action row is `Back` + `Reply` (replacing `Cancel` + `Send reply`); the bottom `Back to questions` button is removed entirely; the hint reads `Return for a new line • Shift-Return to send reply`; Shift-Return submits the reply and plain Return inserts a newline; the whole-question Cancel is NOT present in decline mode (the user must `Back` to the questions first to cancel).

**Rationale:**
- User's explicit spec. Removing Cancel from decline mode prevents tearing down the whole question from a sub-mode.

**Implications:**
- `handleExitDecline` is bound to the new top `Back`; `respondDecline` to `Reply`.
- Remove `QUESTION_BACK_TO_QUESTIONS_ORDER` and rework the decline spatial grid (Back + Reply on top, then the reply textarea).
- `handleDeclineKeyDown` keys send on Shift-Return (drop or keep ⌘-Return as a silent alias, but the hint advertises Shift-Return).

#### [P10] Header dot reads awaiting while live (DECIDED — already wired) {#p10-awaiting-dot}

**Decision:** While a question is pending, the block's `BlockChrome` lifecycle dot reads `awaiting` (waiting on the user), not `in_flight`. This is sourced by the **existing** `awaitingToolUseId` join in `CodeRowBody`, not recomputed in the block.

**Rationale:**
- Accurately models "blocked on user input" and distinguishes from a still-streaming tool.
- `CodeRowBody` already passes `awaitingToolUseId = pendingApproval?.tool_use_id ?? pendingQuestion?.tool_use_id` into `dispatchToolCallState`, which folds it into the row's `phase` ([Q02]).

**Implications:**
- The block does NOT set `phase` itself; it only needs to actually render `BlockChrome` while live (today it `return null`s during streaming, so the chrome+dot never mount). No `deriveToolCallPhase` override.

---

### Deep Dives (Optional) {#deep-dives}

#### Live → answered handoff today vs. after (#handoff-model) {#handoff-model}

**Today (two surfaces, two positions):**

```
TugTranscriptEntry.body
 ├─ CodeRowBody
 │    └─ <AskUserQuestionToolBlock status="streaming"/>   → renders null
 └─ {questionSlot}  (body foot)
      └─ <QuestionDialog/> in TugInlineDialog (520px card)   ← live UI here
```
On submit: `QuestionDialog` unmounts at the foot; `AskUserQuestionToolBlock` flips to `ready` and renders the Q→A block at the tool_use position → width + treatment + position jump.

**After (one surface, one position):**

```
TugTranscriptEntry.body
 └─ CodeRowBody
      └─ <AskUserQuestionToolBlock/>  (one persistent BlockChrome)
            children = isLive ? <QuestionWizard/> : <QuestionSummaryList/>
```
On submit: `pendingQuestion` clears → `isLive` flips false → same `BlockChrome` swaps `children` from wizard to summary. No frame change; only the body morphs (and for single-question it's literally "options + action row removed, answers stay").

#### Component decomposition (#decomposition) {#decomposition}

- `QuestionWizard` (new, frameless) — all interactive state + the rail/panel wizard, single-question options, free-text field, decline mode, Submit/Cancel action row, focus trap, spatial order, A9 preservation, flash-advance, panel sizers. Renders NO `TugInlineDialog`.
- `AskUserQuestionToolBlock` — owns `BlockChrome`; branches `children` on `isLive`; suppresses collapse + sets `awaiting` while live; keeps answered/declined/salvage/error bodies.
- `QuestionDialog` (foot-slot wrapper) and the dispatch `question` kind / `QuestionDialogLazy` — removed.

---

### Specification {#specification}

#### State Zone Mapping (tugdeck/tugways) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| `pendingQuestion` (is a question live for this block?) | external/local-data | `session` store + `useSyncExternalStore` | [L02] |
| `isLive` (derived: streaming && id match) | structure (derived) | pure render-time derivation, no state | [L02] |
| `selections` / `visited` / `freeTexts` / `currentIndex` | local-data (user data) | `useState` + A9 preservation, key `question-dialog/<request_id>` | [L23], [L24] |
| `declineMode` / `declineText` | local-data (user data) | `useState` + A9 preservation | [L23], [L24] |
| option selected mark, current-row tint, flash-advance | appearance | CSS + `data-*` attrs + TugAnimator (DOM writes) | [L06] |
| collapse-suppressed-while-live | structure/appearance | prop to collapse wrapper + chevron `disabled` | [L06] |
| Submit/Cancel/Back/Next/Reply focus order | structure | focus-group order + spatial grid (engine) | [L03] |
| panel-height floor (constant geometry) | appearance | `useLayoutEffect` DOM `min-height` ratchet + ResizeObserver | [L03], [L06] |
| header dot `awaiting` | appearance | `phase` prop on `BlockChrome` | [L06] |
| editor font on typing inputs | appearance | cascade-scoped CSS using `--tug-font-family-editor` | [L06], [L20] |

#### Internal Architecture (#internal-architecture) {#internal-architecture}

- The block subscribes to `pendingQuestion` once; when `isLive`, it forwards `pendingQuestion` (request id + input) and `session` into `QuestionWizard`.
- `respondQuestion(request_id, { answers })` / `{ response }` unchanged; called from `QuestionWizard`'s Submit / Reply.
- `BlockChrome` stays mounted across the transition; `data-slot="dev-question-dialog"` (the bright-island marker) moves to the block root or the wizard root so the scrim continues to target it ([Q01]).

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files (if any) {#new-files}

| File | Purpose |
|------|---------|
| (none required) | `QuestionWizard` may be a new export within `dev-question-dialog.tsx`, or split into `chrome/question-wizard.tsx` + `.css` if the file grows unwieldy — author's discretion during #step-1. |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `QuestionWizard` | component | `chrome/dev-question-dialog.tsx` (or new `chrome/question-wizard.tsx`) | Frameless interactive surface extracted from `QuestionDialog`; Submit/Cancel as body action row |
| `QuestionDialog` | component | `chrome/dev-question-dialog.tsx` | Removed (foot-slot wrapper retired) |
| `AskUserQuestionToolBlock` | component | `cards/blocks/ask-user-question-tool-block.tsx` | Branch `children` on `isLive`; subscribe to `pendingQuestion`; `awaiting` phase; suppress collapse |
| `questionSlot` | local var | `cards/dev-card-transcript.tsx` | Removed |
| `KIND_RENDERERS.question` / `QuestionDialogLazy` | dispatch entry | `cards/dev-assistant-renderer-dispatch.ts` | Removed |
| `QUESTION_BACK_TO_QUESTIONS_ORDER` | const | `chrome/dev-question-dialog.tsx` | Removed; decline spatial grid reworked |
| `nextAdvanceIndex` / `armAdvance` (single-Q path) | fn | `chrome/dev-question-dialog.tsx` | Adjust so a single-question pick targets Send, not review |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** | Pure helpers: advance logic, answer building, decline keymap | `dev-question-dialog` + `ask-user-question-tool-block` pure helpers |
| **Integration (app-test)** | Real Tug.app drive: ask → answer → morph, decline flow, single-question gesture count | The structural and behavioral changes |
| **Drift Prevention** | Mount identity holds across `pending → ready`; no remount | The morph correctness |

#### What stays out of tests {#test-non-goals}

- jsdom render-tree assertions and mock-store tests — banned; the morph and focus behavior are validated through the real app-test harness instead.
- Pixel-exact screenshot diffing of the whole transcript — too brittle; assert the chrome root's bounding box (left/width) is stable across submit, not a full-frame diff.

---

### Execution Steps {#execution-steps}

> Commit after all checkpoints pass. tugdeck HMR is live (no manual build); rebuild tugcode only if its source changes (none expected). App-tests via `just app-test`.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Extract frameless `QuestionWizard` | done | cb48345a3 |
| #step-2 | Block owns both states (the morph) | done | 38476ee18 |
| #step-3 | Single-question: accept the seeded default in one Return | done | ad68f4f7b |
| #step-4 | Editor font for typing inputs | done | 8b1f3ddb2 |
| #step-5 | Chat-about (decline) rework | done | b80c99333 |
| #step-6 | Scrim rework for the mid-transcript bright island | done | 58bae683b |
| #step-7 | Integration checkpoint | done | 31e3ffbb4 |

---

#### Step 1: Extract frameless `QuestionWizard` {#step-1}

**Commit:** `refactor(tugdeck): extract frameless QuestionWizard from QuestionDialog`

**References:** [P02] block frame, [P03] keep wizard, [P05] action row, (#decomposition, #internal-architecture, #state-zone-mapping)

**Artifacts:**
- `QuestionWizard` component containing the full interactive surface (state, focus trap, spatial order, A9 preservation, rail/panel wizard, single-question options, free-text, decline mode, flash-advance, panel sizers) WITHOUT `TugInlineDialog`.
- Submit/Cancel (and decline Back/Reply) rendered as a body action row inside `QuestionWizard` ([P05]).
- `QuestionDialog` temporarily renders `QuestionWizard` in a minimal container at the foot slot so the app keeps working.

**Tasks:**
- [ ] Move the interactive guts of `QuestionDialog` into `QuestionWizard`; keep the A9 key (`question-dialog/<request_id>`), focus-trap, spatial order, and sizers verbatim.
- [ ] Replace the `TugInlineDialog` `actions` slot usage with an in-body action row; carry `data-slot="dev-question-dialog"` (bright-island marker) on the wizard root.
- [ ] Point the foot-slot `QuestionDialog` at `QuestionWizard` (interim container) to keep ask/answer functional.
- [ ] Keep `parseQuestions`/pure helpers exported as-is (still consumed by the tool block + salvage).

**Tests:**
- [ ] Existing pure-helper unit suites still pass unchanged (`bun test` for `dev-question-dialog`).

**Checkpoint:**
- [ ] `just app-test` — asking a single and a multi-question payload still works and answers round-trip.
- [ ] `bun test` (tugdeck) green; tsc clean.

---

#### Step 2: Block owns both states (the morph) {#step-2}

**Depends on:** #step-1

**Commit:** `feat(tugdeck): AskUserQuestion live+answered share one BlockChrome (zero-shift)`

**References:** [P01] single morphing block, [P02] block frame, [P06] correlation, [P07] suppress collapse, [P10] awaiting dot (already wired), [Q02] awaiting phase (decided), Risk R02, (#handoff-model)

**Artifacts:**
- `AskUserQuestionToolBlock` subscribes to `pendingQuestion`, computes `isLive` ([P06]), and renders `QuestionWizard` inside its `BlockChrome` while live; otherwise the existing answered/declined/salvage/error body.
- One persistent `BlockChrome` across `pending → ready` (no key change → mount identity holds, [L26]). The brief pre-`pendingQuestion` streaming window (tool_use exists, `control_request_forward` not yet arrived) still renders `null`; `BlockChrome` mounts at `isLive` and persists through `ready`.
- Collapse suppressed + chevron disabled while live via a `BlockChrome` force-expand prop through the constant `ToolBlockHistoryCollapse` wrapper ([P07] — wrapper is NOT swapped, [L26]). The dot already reads `awaiting` via `awaitingToolUseId` ([P10]).
- Foot-slot `questionSlot` removed from `dev-card-transcript.tsx`; `KIND_RENDERERS.question` / `QuestionDialogLazy` removed from the dispatch; `QuestionDialog` wrapper deleted.

**Tasks:**
- [ ] Add `pendingQuestion` subscription (`useSyncExternalStore`) and `isLive` derivation in the block.
- [ ] Render `QuestionWizard` as the live body; pass `pendingQuestion` + `session`. Keep `return null` for the pre-`pendingQuestion` streaming window.
- [ ] Force-expand + disable chevron while live via a prop threaded through `BlockChrome`/the collapse handle — do NOT remove the `ToolBlockHistoryCollapse` wrapper ([P07], [L26]).
- [ ] Remove the foot-slot `questionSlot`, the dispatch `question` kind, and the now-dead `QuestionDialog`; confirm no other consumer (gallery) references `KIND_RENDERERS.question` before deleting.

**Tests:**
- [ ] Drift: assert the block is the same component instance across submit (no remount) — app-test observes the chrome root's bounding box left/width unchanged before/after submit.

**Checkpoint:**
- [ ] `just app-test` — ask → answer: the surface morphs in place; the answer record is exactly where the options were; no width/position jump.
- [ ] Reload mid-question (Developer ▸ Reload) restores in-progress selections (A9 continuity).
- [ ] `bun test` green; tsc clean.

> Scrim isolation ([Q01]) and full-width/truncation are handled in #step-6 (a deliberate CSS rework, not a verification).

---

#### Step 3: Single-question — accept the seeded default in one Return {#step-3}

**Depends on:** #step-2

**Commit:** `fix(tugdeck): single AskUserQuestion accepts the default in one Return`

**References:** [P04] single-question, (#success-criteria)

**Artifacts:**
- For a single-question payload: Send enabled + focused on mount (preseed is confirmable); a single Return submits the seeded default; changing the pick still routes pick → Send; the review index is never entered.

**Tasks:**
- [ ] Re-establish the exact current gesture count on `main` first (expected: two Returns, the first re-confirming the preseed) so the change targets real friction.
- [ ] For a single question, enable + focus Send on mount; do not require a prior `visited`-marking pick to enable it.
- [ ] Ensure `armAdvance`/`nextAdvanceIndex` never routes a single-question pick into the review index.
- [ ] Leave the multi-question per-row commit + review flow unchanged.

**Tests:**
- [ ] Unit: the single-question Submit gate is satisfied by the preseed (Send enabled on mount); the advance/target logic resolves to Send, not a review index.

**Checkpoint:**
- [ ] `just app-test` — a single single-select question with the recommended default: ONE Return submits.
- [ ] `just app-test` — picking a non-default option then Return-on-Send submits the changed answer.
- [ ] `bun test` green.

---

#### Step 4: Editor font for typing inputs {#step-4}

**Depends on:** #step-2

**Commit:** `style(tugdeck): question typing fields use the editor font`

**References:** [P08] editor font, (#state-zone-mapping)

**Artifacts:**
- The free-text answer field and the chat-about reply field render in `--tug-font-family-editor` (with matching size/line-height), scoped to the question surface.

**Tasks:**
- [ ] Add cascade-scoped CSS on the free-text (`TugInput`) and decline (`TugTextarea`) fields setting the editor font tokens ([L20] instance override).

**Tests:**
- [ ] (Visual / computed-style) the fields use the editor family.

**Checkpoint:**
- [ ] `just app-test` — type in both fields; font matches the prompt entry.
- [ ] `bun run audit:theme-contrast` unaffected.

---

#### Step 5: Chat-about (decline) rework {#step-5}

**Depends on:** #step-2

**Commit:** `feat(tugdeck): rework AskUserQuestion chat-about affordance`

**References:** [P09] chat-about, (#success-criteria)

**Artifacts:**
- Decline mode top action row: `Back` + `Reply`. No whole-question Cancel in decline mode.
- Bottom `Back to questions` button removed; `QUESTION_BACK_TO_QUESTIONS_ORDER` removed; decline spatial grid reworked.
- Hint text: `Return for a new line • Shift-Return to send reply`. Shift-Return sends; plain Return = newline.

**Tasks:**
- [ ] Replace decline-mode actions: `Back` → `handleExitDecline`, `Reply` → `respondDecline`.
- [ ] Remove the bottom `Back to questions` control and its focus order; rework the decline spatial grid (Back + Reply, then textarea).
- [ ] Update `handleDeclineKeyDown` to send on Shift-Return; update the hint string.

**Tests:**
- [ ] Unit: decline keymap (Shift-Return → send; plain Return → no send).

**Checkpoint:**
- [ ] `just app-test` — enter chat-about, confirm `Back`/`Reply` top row, no bottom Back-to-questions, no Cancel; Shift-Return sends; Back returns to questions.

---

#### Step 6: Scrim rework for the mid-transcript bright island {#step-6}

**Depends on:** #step-2

**Commit:** `fix(tugdeck): scrim isolates the in-place AskUserQuestion block`

**References:** [P02] block frame, [Q01] scrim, Risk R01, (#success-criteria)

**Artifacts:**
- Reworked `dev-card.css` `[data-inline-dialog-pending="true"]` rules so the live question's tool block is the single bright island and the rest of the live turn dims:
  - The live cell stays excepted via `:has(.dev-question-dialog)` (the wizard carries that marker class).
  - Keep dimming the live turn's prose (`.dev-card-transcript-code-body`).
  - **Add** dimming for the live turn's sibling tool blocks — e.g. within the live cell, `.tool-block-chrome:not(:has(.dev-question-dialog))` dims + goes inert — so the question block alone stays bright + interactive.
- Confirmed option rows render full-width with no truncation; any leftover 520px-era width assumption removed from the option-list CSS (the option list previously lived inside the 520px `--tugx-idialog-max-width`).

**Tasks:**
- [ ] Rework the scrim selectors per the above; **never** apply a wholesale dim to the live turn body `<div>` or the live cell itself (group-opacity hazard — a descendant of a dimmed ancestor cannot be re-lit). Dim only specific siblings.
- [ ] Verify Escape still routes through the trap's cancel ladder at the mid-transcript position.
- [ ] Drive a long-option fixture; confirm no option label/description clips.

**Tests:**
- [ ] (Visual) the question block is the only bright, interactive element in the live turn; all sibling blocks + prose dim and go inert.
- [ ] (Visual) long-option fixture shows no truncation.

**Checkpoint:**
- [ ] `just app-test` — with a question pending, the live turn's other blocks/prose are dimmed and inert while the question block is bright; Escape cancels; a long-option payload renders untruncated.

---

#### Step 7: Integration checkpoint {#step-7}

**Depends on:** #step-3, #step-4, #step-5, #step-6

**Commit:** `N/A (verification only)`

**References:** [P01]–[P10], (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Verify all steps work together: ask → morph → answer (single + multi), decline flow, fonts, full-width, scrim, mount identity.
- [ ] Cross-check the tuglaws named in the commits ([L02]/[L03]/[L06]/[L19]/[L20]/[L23]/[L24]/[L26]) hold for the touched code; note them in the relevant commits.

**Tests:**
- [ ] Full `bun test` (tugdeck) + `cd tugrust && cargo nextest run` (no Rust change expected, run as a guard).

**Checkpoint:**
- [ ] `just app-test` end-to-end scenario passes for single, multi, and decline; chrome bounding box stable across submit.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A single `BlockChrome`-framed `AskUserQuestion` surface that morphs in place from interactive questions to the durable answer record with no width/treatment/position shift, plus the single-question, font, and chat-about fixes.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Submit removes only the option + action chrome; the chrome frame's left/width are unchanged (app-test bounding-box check).
- [ ] Options render full-width and untruncated for a long-option fixture.
- [ ] A single single-select question with the recommended default submits in one Return; a non-default change submits in pick → Send.
- [ ] Free-text + chat-about fields use the editor font.
- [ ] Chat-about top row is `Back`+`Reply`, no bottom Back-to-questions, hint reads `Return for a new line • Shift-Return to send reply`, Shift-Return sends, no whole-question Cancel from decline.
- [ ] A9 reload mid-question restores in-progress answers.
- [ ] `bun test` + `cargo nextest run` green.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Revisit whether multi-question should optionally adopt an all-stacked layout for an even more seamless multi-Q morph.
- [ ] Sweep stale "Dev" references in `tuglaws/` (tracked separately).

| Checkpoint | Verification |
|------------|--------------|
| Zero-shift morph | app-test: chrome root bounding box stable across submit |
| No truncation | app-test: long-option fixture renders untruncated |
| Single-question gestures | unit + app-test: pick → Send (two) |
| Typing fonts | computed-style / visual matches prompt entry |
| Chat-about spec | app-test decline flow matches [P09] |
| Tests | `bun test` + `cargo nextest run` green |
