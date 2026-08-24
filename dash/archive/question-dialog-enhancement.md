<!-- devise-skeleton v4 -->

## QuestionDialog Parity — Free-Text and Decline Affordances {#question-dialog-enhancement}

**Purpose:** Bring Tug's inline `QuestionDialog` to parity with the Claude Code TUI by adding the two answer affordances it lacks — **`Type something`** (a free-text answer per question) and **`Chat about this`** (dismiss the questions and reply in prose) — wired end to end through the answer protocol, so a Tug user can resolve any in-cap `AskUserQuestion` exactly as they can in the terminal.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-06-18 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Tug already renders `AskUserQuestion` as a first-class inline wizard (`QuestionDialog`, `chrome/dev-question-dialog.tsx`): N options uncapped, single- and multi-select, multi-question rail + panel, answers round-tripped as a `question_answer` frame. What it's missing versus the native CLI are the two rows the harness renders below the options: **`Type something`** (answer a question with free text instead of a listed label) and **`Chat about this`** (abandon the structured questions and type a normal reply). Today Tug's only escape is Cancel → `popInteractive` → interrupt, which rejects the tool rather than answering it.

The answer protocol already supports both outcomes; nothing new needs inventing on the wire. A free-text answer is just a string value in the existing `answers` record (keyed by question text). A decline-and-reply uses the answer's optional top-level **`response`** field — Claude then receives "The user responded: …" and the tool resolves (distinct from an interrupt). The 2–4-options-per-question cap is enforced upstream in Claude Code's own schema and is out of scope here (see the rewritten "AskUserQuestion — shape and affordances" section in `CLAUDE.md`); Tug's existing salvage path for >4 payloads is untouched.

#### Strategy {#strategy}

- Build bottom-up so each layer is independently verifiable: protocol field → tugcode emit → store action → dialog UI → durable artifact → gallery.
- Add **one** optional field (`response`) to the existing `question_answer` contract — no new inbound message type, so the tugcode inbound allowlist dance is avoided.
- Reuse existing tugways text primitives (`TugInput` single-line, `TugTextarea` multiline) + `use-text-input-responder` so the substrate CUT/COPY/PASTE/SELECT_ALL/UNDO/REDO work — never hand-roll an input ([feedback: use existing Tug components]).
- Free-text answers and the decline reply are **user data** → they survive reload via the dialog's existing [A9] preservation ([L23]).
- `Type something` and `Chat about this` are mutually exclusive resolutions for distinct scopes: free text answers *one question*; decline abandons *the whole prompt*.
- Pure helpers (answer-frame composition, free-text-vs-labels precedence) get unit tests; the live dialog behavior is verified with `just app-test`; gallery fixtures cover the new states + the existing salvage path.

#### Success Criteria (Measurable) {#success-criteria}

- A question can be answered with free text: the dialog accepts typed input for a question, and the emitted `answers[questionText]` equals the typed string (not a label). (`buildQuestionAnswers` unit test + `just app-test`)
- `Chat about this` resolves the tool with a freeform reply: the `question_answer` frame carries `response: <text>` (in the #step-1-confirmed decline shape); tugcode forwards it as `updatedInput.response`; the turn continues (not interrupted). (tugcode `formatQuestionAnswer` unit test + `just app-test`)
- The free-text field and decline field are real editing surfaces: Cmd-A/C/X/V/Z work inside them (substrate responder registered). (`just app-test`)
- Free-text answers and an in-progress decline reply survive a Developer ▸ Reload mid-flow. (`just app-test` reload)
- The durable `AskUserQuestionToolBlock` renders a free-text answer verbatim and shows a "replied in chat" state for a declined prompt. (artifact unit test + visual)
- `bun run check`, `bun test`, `just lint`, `just app-test` all pass. (commands)

#### Scope {#scope}

1. `tugproto` `QuestionAnswer`: add optional `response?: string`.
2. tugcode `formatQuestionAnswer` + `handleQuestionAnswer`: thread and emit `response` into `updatedInput`.
3. Store: `respondQuestion` payload, `RespondQuestionActionEvent`, and `handleRespondQuestion` carry `answers` **or** `response`.
4. `QuestionDialog`: per-question `Type something` free-text capture + the `Chat about this` decline field; extend preserved state.
5. `AskUserQuestionToolBlock`: render free-text answers + the declined-prompt state.
6. Gallery fixtures + the test prompts; confirm the `CLAUDE.md` note is accurate.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Changing or circumventing the upstream **2–4 options-per-question** cap (enforced in Claude Code before Tug receives anything). The salvage path in `AskUserQuestionToolBlock` is untouched.
- An "arm the prompt entry, route the next message as the response" flow for `Chat about this` (the CLI's literal behavior). We do the self-contained inline-field variant instead ([P02]); the prompt-arming variant is a possible follow-on.
- Rendering >4 options live (impossible — the live tool rejects it); >4 is exercised only via a synthetic gallery fixture against the salvage path.
- Reworking the wizard rail/panel geometry, focus trap, or the Cancel ≡ Esc ≡ interrupt path ([D02]).

#### Dependencies / Prerequisites {#dependencies}

- None external. Touches `tugproto/`, `tugcode/` (bun-compiled — needs `just app-debug` rebuild to exercise live; no HMR), and `tugdeck/` (HMR-live).

#### Constraints {#constraints}

- Tugdeck laws: [L02] external state via `useSyncExternalStore`; [L03] responder registration in `useLayoutEffect`; [L06] appearance via CSS/DOM; [L11] editing surfaces own a responder; [L19] `.tsx`+`.css` pair + docstring; [L20] component-token sovereignty; [L23]/[A9] in-progress answer state survives reload; [L24] selection/text is component data.
- [D13] inline (not modal) question prompts; [D01]/[D08] `TugInlineDialog` host.
- tugcode is a compiled binary — protocol/tugcode changes require a `just app-debug` rebuild to test live; tugdeck changes are HMR-live.
- No mock-store / fake-DOM render tests — pure-logic `bun:test` + `just app-test`.

#### Assumptions {#assumptions}

- Claude Code's `AskUserQuestion` answer accepts an optional top-level `response` (in `updatedInput`) meaning "user replied freeform instead of answering" — verified against current Anthropic docs during devise. When `response` is present, `answers` is omitted (decline replaces, not augments).
- A free-text answer for a question is returned as that question's `answers` value (an arbitrary string); the model reads it as the answer. No per-option "Other" sentinel is needed.
- The existing per-request [A9] preservation key (`question-dialog/<request_id>`) is the right scope to also carry free-text / decline state.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

Explicit `{#anchor}` headings; plan-local decisions `[P01]`+ (never `[D##]`, which a step may cite by reference); rich `**References:**` lines; no line numbers.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Does the answer carry `response` alongside `answers`, or instead of it? (DECIDED) {#q01-response-vs-answers}

**Question:** When the user declines via `Chat about this`, does the frame send both `answers` and `response`, or `response` only?

**Why it matters:** Determines the `respondQuestion` payload shape and how Claude interprets the result.

**Resolution:** DECIDED in direction (see [P04]), exact shape confirmed in #step-1. A decline carries the freeform `response`; a normal/free-text resolution carries `answers`. They are distinct outcomes (answer the questions vs. abandon them and reply), never mixed. The docs show `answers` present in the output example with `response` as the add-on "only when the user dismisses the structured questions", so the precise decline payload — **`response`-only vs. `answers: {}` + `response`** — is slightly ambiguous; #step-1's checkpoint pins it against a live Claude session (and confirms the model reads it as a freeform reply, not an empty answer) and `formatQuestionAnswer` matches whatever that is. See Risk R01.

#### [Q02] How does free text interact with a question's label selection? (DECIDED) {#q02-freetext-vs-labels}

**Question:** If a question has both picked labels and typed free text, which wins?

**Resolution:** DECIDED (see [P01]) — free text, when present for a question, **is** that question's answer and replaces any label selection; the rail shows the typed text as the answer summary. A question is answered *either* by options *or* by free text, never a blend. Engaging the free-text field clears that question's label selection (and vice-versa).

#### [Q03] `Chat about this`: inline field or arm-the-prompt? (DECIDED) {#q03-decline-ux}

**Question:** Does decline open an inline freeform field in the dialog, or dismiss the dialog and capture the user's next prompt submission?

**Resolution:** DECIDED (see [P02]) — inline freeform field (`TugTextarea`) within the dialog, submitted as the `response`. Self-contained, single resolution locus, no cross-component pending-state. The arm-the-prompt variant is recorded as a follow-on (#roadmap).

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Claude misreads a `response`-only answer | med | low | Match the documented field exactly; verify the model's reading in app-test with a real session | app-test shows Claude treating decline as an empty answer |
| Free-text field eats dialog keyboard (trap/responder conflict) | med | med | Reuse `use-text-input-responder` + the focus-trap seam the options list already uses; app-test Cmd-keys + Tab | Cmd-A/typing dead, or Tab can't leave the field |
| Geometry shift when the free-text field reveals | low | med | Reserve the affordance row; reveal the field in the existing panel without moving the rail (mirror the "constant geometry" rule) | dialog jumps when toggling free text |

**Risk R01: `response`-only decline misread by the model** {#r01-decline-reading}

- **Risk:** If the frame shape is off, Claude treats the decline as "no answer" or errors.
- **Mitigation:** Emit exactly `updatedInput.response = <text>` inside the existing `behavior: "allow"` envelope; pin `formatQuestionAnswer` with a unit test; confirm live in app-test.
- **Residual risk:** Model phrasing of "The user responded: …" is upstream and not ours to control.

---

### Design Decisions {#design-decisions}

#### [P01] Free text is a per-question answer that replaces labels (DECIDED) {#p01-freetext-answer}

**Decision:** `Type something` captures a single-line free-text value per question; when set, it is that question's `answers` value and supersedes any selected labels. Stored as a parallel `freeTexts: (string | null)[]` in the wizard state.

**Rationale:**
- The wire value is already an arbitrary string keyed by question text — no protocol change.
- "Either options or free text" is the simplest mental model and matches the CLI (typing replaces the pick).

**Implications:**
- `buildQuestionAnswers` prefers `freeTexts[i]` when non-null/non-empty, else the joined labels.
- Engaging free text clears that row's label selection; picking a label clears its free text.
- `freeTexts` joins `selections`/`visited` in `QuestionDialogPreservedState` ([A9]).

#### [P02] `Chat about this` is an inline freeform field emitting `response` (DECIDED) {#p02-decline-inline}

**Decision:** A `Chat about this` affordance reveals an inline multiline `TugTextarea`; submitting it calls `respondQuestion(requestId, { response: text })`, which resolves the tool with the freeform reply. Distinct from Cancel (interrupt).

**Rationale:**
- Self-contained — the question resolves in one place, no cross-component prompt-arming or lingering pending state.
- Produces the correct wire outcome (`updatedInput.response`) that the protocol already supports.

**Implications:**
- New store path for a `response` answer ([P04]); dialog gains a decline mode + its own preserved text.
- Cancel/Esc/interrupt semantics are unchanged.

#### [P03] Reuse tugways text primitives + the shared input responder (DECIDED) {#p03-reuse-inputs}

**Decision:** Use `TugInput` (single-line, free-text answer) and `TugTextarea` (multiline, decline reply), each wired through `use-text-input-responder` so CUT/COPY/PASTE/SELECT_ALL/UNDO/REDO are live.

**Rationale:**
- Hand-rolled inputs in tugways go keyboard-dead without the substrate responder ([feedback: substrate responders]); the primitives already solve this.

**Implications:**
- Verify the chosen primitive registers the responder (or wire `use-text-input-responder` explicitly); the field must coexist with the dialog's focus trap as a focus stop.

#### [P04] `respondQuestion` accepts answers OR a response (DECIDED) {#p04-store-payload}

**Decision:** Extend the store path so `respondQuestion(requestId, { answers })` and `respondQuestion(requestId, { response })` are both valid; `RespondQuestionActionEvent` and `handleRespondQuestion` carry whichever, and the emitted `question_answer` frame includes `answers` or `response` accordingly.

**Rationale:**
- One action, two outcomes — keeps the reducer's phase-restore + clear logic in one place.

**Implications:**
- `tugproto` `QuestionAnswer` gains optional `response?`; tugcode `formatQuestionAnswer` emits it in the exact decline shape confirmed in #step-1.

#### [P05] The 2–4 cap and salvage path are unchanged (DECIDED) {#p05-cap-untouched}

**Decision:** This plan does not touch the upstream option cap or the `AskUserQuestionToolBlock` salvage detector. Rendering remains uncapped (already true).

**Rationale:**
- The cap is enforced inside Claude Code before Tug sees the request; nothing here can or should change it (see `CLAUDE.md`).

#### [P06] Text fields ride the engine's [P25] guard; only wizard semantics are wired (DECIDED) {#p06-keyboard-model}

**Decision:** The free-text and decline fields are plain `TugInput`/`TugTextarea` focus stops. We do **not** add a custom key seam — the focus engine's [P25] guard (`responder-chain-provider`) already yields caret arrows, typing, Space, Enter, and Cmd-A/C/X/V/Z to a focused native `INPUT`/`TEXTAREA` and keeps Tab moving to the next stop. We wire only the wizard-level semantics on top:
- Single-line free-text field: **Enter = advance** via the field's own `onKeyDown` (the engine passes Enter through to the focused input) — mark visited + reuse the advance machinery (`armAdvance` / focus-restore), NOT the option-*label* commit; the value is already in `freeTexts[i]` from `onChange`. "Return walks the wizard" survives.
- Multi-line decline field: **Enter = newline**, **Cmd/⇧-Enter or `Send reply` = submit**.
- The existing `Cancel → Submit → Back → Next → Options` Tab cycle, the spatial-arrow grid, and Esc-cancels are preserved; each field is added as a focus stop + spatial-grid node.

**Rationale:**
- The engine already solves caret-vs-spatial-plane (same path the prompt editor uses); inventing a seam would duplicate [P25] and risk drift.

**Implications:**
- No `behavior.captures` wiring on the fields; the app-test verifies caret/Cmd-keys/Tab/Return behavior rather than any custom interception code.

---

### Specification {#specification}

#### Answer wire shapes {#answer-shapes}

**Spec S01: `question_answer` frame** {#s01-frame}
- Normal / free-text: `{ type: "question_answer", request_id, answers: Record<string,string> }` — values are option labels (joined by bare `,` for multi-select) or a verbatim free-text string.
- Decline: `{ type: "question_answer", request_id, response: string }` — no `answers`.

**Spec S02: tugcode `updatedInput`** {#s02-updated-input}
- Answer path: `{ ...originalInput, answers }`.
- Decline path: `{ ...originalInput, response }`.
- Both wrapped in `{ subtype: "success", request_id, response: { behavior: "allow", updatedInput } }`.

#### State Zone Mapping (tugdeck/tugways) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| Per-question free-text answer (`freeTexts`) | local-data (user) | `useState` + [A9] preserve via `QuestionDialogPreservedState` | [L24], [L23] |
| Decline reply text | local-data (user) | `useState` + [A9] preserve | [L24], [L23] |
| Decline mode active (which surface shows) | local-data (user) — survives reload | `useState` flag + [A9] preserve; CSS swaps the surface | [L06], [L23], [L24] |
| Free-text / decline input responder | responder registration | `use-text-input-responder` in `useLayoutEffect` | [L03], [L11] |
| Answer outcome (answers vs response) | — | reducer `send-frame` effect | [L02] |
| "is this still pendingQuestion?" | external | `useSyncExternalStore` (unchanged) | [L02] |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When |
|----------|---------|------|
| **Unit (bun:test)** | Pin pure helpers: `buildQuestionAnswers` free-text precedence, `formatQuestionAnswer` response path, store action shaping | New/changed pure logic |
| **Integration (app-test)** | Live dialog: free-text answer, decline reply, Cmd-keys in fields, reload-restore | The interactive behavior |
| **Visual (gallery)** | Free-text state, decline state, salvage (>4) fixture | Render states |

#### What stays out of tests {#test-non-goals}

- Fake-DOM/RTL and mock-store tests — banned; behavior verified via `just app-test`.
- The model's prose interpretation of `response` — upstream, not assertable.

---

### Execution Steps {#execution-steps}

> Commit after all checkpoints pass. References cite plan artifacts/anchors, never line numbers.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Protocol + tugcode: optional `response` in the answer | done | 11665ada |
| #step-2 | Store: respondQuestion carries answers or response | done | c9f6be1e |
| #step-3 | Dialog: `Type something` free-text answer | done | f45b33af |
| #step-4 | Dialog: `Chat about this` decline reply | done | 2881396c |
| #step-5 | Durable artifact: free-text + declined states | done | 199b1dd3 |
| #step-6 | Gallery fixtures + integration checkpoint | done | 494daf71 |

#### Step 1: Protocol + tugcode — optional `response` in the answer {#step-1}

**Commit:** `tugcode: AskUserQuestion answer carries an optional freeform response`

**References:** [P04] store-payload, [P02] decline-inline, Spec S01, Spec S02, (#answer-shapes)

**Artifacts:**
- `tugproto/src/inbound.ts`: add `response?: string` to `QuestionAnswer`.
- `tugcode/src/control.ts` `formatQuestionAnswer`: accept an optional `response`; emit `{ ...originalInput, response }` when present, else `{ ...originalInput, answers }`.
- `tugcode/src/session.ts` `handleQuestionAnswer`: pass `msg.response` through.
- No inbound-allowlist edit — `question_answer` already exists; this only adds a field.

**Tasks:**
- [ ] **First, pin the exact decline payload against a live Claude session** ([Q01], Risk R01): emit a decline and observe what Claude Code accepts and how it reads it — `response`-only vs. `answers: {}` + `response`, and that it lands as a freeform reply (not an empty answer). Shape the rest of the step (and `formatQuestionAnswer`) to match what the live tool actually wants.
- [ ] Add the optional field to the shared type.
- [ ] Branch `formatQuestionAnswer` on `response` presence (answer vs decline `updatedInput`), matching the confirmed shape.
- [ ] Thread `response` from `handleQuestionAnswer`.

**Tests:**
- [ ] tugcode unit (control test): `formatQuestionAnswer` emits `updatedInput.answers` for the answer path and the confirmed decline shape (carrying `response`) for the decline path.

**Checkpoint:**
- [ ] `cd tugcode && bun test` (control/session suites green); `bun run check` in tugcode/tugproto.
- [ ] Live confirmation: a real session's decline resolves the tool with the freeform reply (verified manually or in `just app-test` once the dialog path lands in #step-4).

#### Step 2: Store — respondQuestion carries answers or response {#step-2}

**Depends on:** #step-1

**Commit:** `tugdeck: question store path accepts a freeform response answer`

**References:** [P04] store-payload, Spec S01, (#answer-shapes)

**Artifacts:**
- `code-session-store/events.ts` `RespondQuestionActionEvent`: add optional `response?: string` (keep `answers` optional-or-present per the decline branch).
- `code-session-store.ts` `respondQuestion`: accept `{ answers } | { response }`.
- `code-session-store/reducer.ts` `handleRespondQuestion`: emit a `question_answer` frame with `answers` or `response`; phase-restore + `pendingQuestion: null` unchanged.

**Tasks:**
- [ ] Widen the action + public method signatures.
- [ ] Emit the correct frame field; leave the clear/restore logic intact.

**Tests:**
- [ ] store unit (reducer): a `respond_question` with `response` emits a `question_answer` send-frame carrying `response` (matching the #step-1-confirmed decline shape); the answers path is unchanged.

**Checkpoint:**
- [ ] `bun test src/lib/code-session-store` green; `bun run check`.

#### Step 3: Dialog — `Type something` free-text answer {#step-3}

**Depends on:** #step-2

**Commit:** `tugdeck: question dialog supports a free-text answer per question`

**References:** [P01] freetext-answer, [P03] reuse-inputs, [P06] keyboard-model, [Q02], [L23], [L24], (#state-zone-mapping)

**Artifacts:**
- `dev-question-dialog.tsx`: add a `Type something` affordance to each question's panel that reveals a **controlled** `TugInput` (value from React state); add `freeTexts: (string|null)[]` to wizard state + `QuestionDialogPreservedState` + `isPreservedQuestionState` (the type guard) + `seedQuestionDialogState`; update `buildQuestionAnswers` to prefer free text; extend the **"answered" predicate(s)** so a free-text-only question counts as answered; rail answer summary shows the typed text; engaging free text clears labels and vice-versa.
- `dev-question-dialog.css`: the revealed-field layout (reserve the row; constant geometry preserved per [L06]).

**Preservation note (K2):** the free-text fields are **controlled** (`value` from React state + `onChange`) because `buildQuestionAnswers`, the rail summary, and the "answered" predicate all read the value from React state. Preserve via the dialog's React-state `QuestionDialogPreservedState` bag ([A9]) — do **NOT** also set `TugInput`'s `componentStatePreservationKey`: its own docstring marks it **uncontrolled-only** ("setting `.value` on a controlled input is overwritten on the next render"), so wiring both double-owns the value. (Trade-off: the bag restores the text but not the caret position on reload — acceptable, not a bug.)

**Tasks:**
- [ ] Extend the selection model with `freeTexts` and the FULL preserve round-trip — `QuestionDialogPreservedState`, the `isPreservedQuestionState` **type guard** (so a reload of new-shape state validates rather than dropping to defaults — [F4]), and `seedQuestionDialogState` (realign to question count).
- [ ] **(F1) Make free text count as an answer in the Submit gate.** `buildQuestionAnswers` is not enough — the Submit-enable path runs through `countAnswered` / `wouldAllBeAnswered` (and the rail `done` status / `countConfirmedAnswers` / `composeRowAnswerLabel`), all keyed on `selections[i].length > 0`. A free-text-only question has empty `selections[i]`, so without this Submit stays **disabled** and the user is stuck. Update the "is question i answered?" predicate to `selections[i].length > 0 || (freeTexts[i] ?? "").trim() !== ""`, and surface the typed text in the rail summary.
- [ ] **(F2) Keyboard model.** The engine already protects focused native fields: `responder-chain-provider`'s [P25] guard yields *all arrows to the caret* when a focused `INPUT`/`TEXTAREA`/contenteditable is active, skips hijacking Enter to the default button, and skips chain-action dispatch (native Cmd-A/C/X/V/Z). So a plain `TugInput` authored as a focus stop gets caret arrows, typing, Space, Cmd-keys, and Tab-moves-on **for free** — no custom seam, no `captures` behavior needed (same path the prompt-entry editor rides). The work is layering the *wizard semantics* on top: (c) preserve the existing `Cancel/Submit/Back/Next/Options` Tab cycle + Esc-cancels untouched.
- [ ] **(K3) Enter in the free-text field → advance.** The engine passes Enter through to the focused `<input>`, so wire it via the field's own `onKeyDown` (`TugInput` extends native input attrs): on Enter (no Shift), `preventDefault`, mark the question visited, and reuse the **advance machinery** — `armAdvance` / `nextAdvanceIndex` + the `pendingFocusKeyRef` → `armKeyboardRestore` focus-restore — so "Return walks the wizard" survives. The value is already in `freeTexts[i]` from `onChange`; this is NOT an option-*label* commit (don't route it through `handleOptionActivate`), just the shared advance+focus path.
- [ ] **(K1) Reach + reveal + focus the field.** Activating `Type something` must reveal the field **and land focus in it** — reuse the dialog's `pendingFocusKeyRef` + `manager.armKeyboardRestore` (the same mechanism option-commit/advance uses); dismissing the field restores focus to the options. Extend the `spatialOrder` `useMemo` + the `QUESTION_*_ORDER` constants with the field's node so a bare arrow can reach it (today the grid is `[buttonRow, navRow, optionsRow]` with the options as one node).
- [ ] `buildQuestionAnswers`: free text wins when present (else joined labels).

**Tests:**
- [ ] `buildQuestionAnswers` unit: free text overrides labels; empty/whitespace free text falls back to labels; mixed questions compose correctly.
- [ ] "answered" predicate unit ([F1]): a free-text-only question reads as answered (Submit gate would enable); empty free text + no labels reads unanswered.
- [ ] `seedQuestionDialogState` + `isPreservedQuestionState` unit ([F4]): new-shape state with `freeTexts` validates and realigns; a missing/!array `freeTexts` falls back cleanly.

**Checkpoint:**
- [ ] `bun test` (dialog pure-helper suite) + `bun run check`.
- [ ] `just app-test` (keyboard is the focus): activating `Type something` lands focus in the field (K1); caret Left/Right + Cmd-A/C/X/V/Z work inside it and do NOT move the wizard ([P25]); a bare arrow can reach the field from an adjacent row (K1); **Enter in the field advances the wizard** (K3); Tab enters/leaves cleanly; Submit **enables** on a free-text-only answer (F1); the answer round-trips as the typed string; Developer ▸ Reload mid-type restores the text.

#### Step 4: Dialog — `Chat about this` decline reply {#step-4}

**Depends on:** #step-2, #step-3

**Commit:** `tugdeck: question dialog supports decline-and-reply (Chat about this)`

**References:** [P02] decline-inline, [P03] reuse-inputs, [P06] keyboard-model, [Q01], [Q03], Risk R01, (#r01-decline-reading)

**Scope clarity (F5):** `Chat about this` is **dialog-level** — it abandons the *entire* prompt (all questions at once), like Cancel, not a per-question control. It is mutually exclusive with answering: entering decline mode supersedes the wizard.

**Artifacts:**
- `dev-question-dialog.tsx`: a dialog-level `Chat about this` control that switches the dialog into **decline mode** — an inline `TugTextarea` plus its own **`Send reply`** action (distinct from the options `Submit`), with a way back out to the questions. Submit-reply → `session.respondQuestion(requestId, { response })`; decline text joins preserved state; distinct from Cancel (which still interrupts).
- `dev-question-dialog.css`: decline-mode layout within the existing panel (constant geometry — the panel is already sized to the tallest question).

**Tasks:**
- [ ] Add decline mode (a dialog-level toggle, not per-question) and define what `Submit`/`Back`/`Next`/the rail do while in it — recommend: decline mode replaces the wizard body with the reply field + `Send reply`; the options `Submit` is hidden/disabled in decline mode; a `Back to questions` control exits decline mode.
- [ ] Wire a **controlled** `TugTextarea` (value from React state; focus-stop) and its `Send reply` submit path → `respondQuestion({ response })`.
- [ ] **(F2)** The engine's [P25] guard already yields caret arrows / typing / Cmd-keys to the focused `TugTextarea` (no seam needed). Layer the textarea's submit semantics: **Return = newline**, **Cmd/⇧-Return or the `Send reply` button = submit** (the prompt-entry convention); Esc still cancels the dialog.
- [ ] **(K1) Decline-mode spatial grid.** The current `spatialOrder` is wizard-only; entering decline mode must swap in its own grid (e.g. `[[Cancel, Send reply], [Back to questions], [textarea]]`) and land focus in the textarea on entry (reuse `pendingFocusKeyRef` / `armKeyboardRestore`); exiting via `Back to questions` restores the wizard grid + focus.
- [ ] **(K2)** Controlled textarea (value in React state, preserved via the bag) — do **not** also set `TugTextarea`'s `componentStatePreservationKey` (uncontrolled-only per its docstring; mixing double-owns the value).
- [ ] Preserve in-progress decline text + the decline-mode flag via [A9] (extend `QuestionDialogPreservedState` + its type guard + seed).
- [ ] Keep Cancel ≡ Esc ≡ interrupt unchanged (decline is a *resolution*, Cancel is a *rejection*).

**Tests:**
- [ ] Pure helper (if extracted): decline payload shaping → `respondQuestion({ response })`; preserved-state round-trip includes decline text + mode flag.

**Checkpoint:**
- [ ] `bun run check`.
- [ ] `just app-test`: `Chat about this` → reply field opens (wizard body replaced) **and focus lands in it** (K1); Cmd-keys + caret arrows work in it; Return inserts a newline, Cmd/⇧-Return submits; `Send reply` resolves the tool and the turn continues with Claude acknowledging the freeform response (NOT interrupted); arrows stay within the decline-mode grid (K1); `Back to questions` returns to the wizard + restores focus; Cancel still interrupts; reload mid-compose restores the reply text and decline mode.

#### Step 5: Durable artifact — free-text + declined states {#step-5}

**Depends on:** #step-1

**Commit:** `tugdeck: AskUserQuestionToolBlock renders free-text answers and declines`

**References:** [P01] freetext-answer, [P02] decline-inline, Spec S01

**Artifacts:**
- `ask-user-question-tool-block.tsx`: render a free-text answer verbatim in the recorded summary; render a "replied in chat" state when the result carried `response` instead of `answers`.

**Tasks:**
- [ ] Detect the `response`-carrying result shape and render the declined state.
- [ ] Render free-text answer values verbatim (no label assumptions).

**Tests:**
- [ ] artifact unit: summary composition for a free-text answer and for a declined result.

**Checkpoint:**
- [ ] `bun test` (artifact suite) + `bun run check`.

#### Step 6: Gallery fixtures + integration checkpoint {#step-6}

**Depends on:** #step-3, #step-4, #step-5

**Commit:** `tugdeck: gallery fixtures for free-text / decline / salvage question states`

**References:** [P01], [P02], [P05], (#success-criteria)

**Artifacts:**
- Gallery fixture(s) for: a question answered by free text, a declined prompt, and a synthetic >4-options payload exercising the existing salvage path.

**Tasks:**
- [ ] Author the fixtures; register in the gallery.
- [ ] Verify the full gate.

**Tests:**
- [ ] Visual via gallery.

**Checkpoint:**
- [ ] `bun run check && bun test && just lint` green.
- [ ] `just app-test` end-to-end: free-text answer, decline reply, reload-restore, Cmd-keys; plus the live salvage path via the 6-language prompt.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Tug's `QuestionDialog` resolves any in-cap `AskUserQuestion` with options, free text, or a declined freeform reply — at parity with the Claude Code TUI.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Free-text answer round-trips as the typed string. (app-test + unit)
- [ ] `Chat about this` resolves the tool via `response` and the turn continues. (app-test + tugcode unit)
- [ ] Cmd-A/C/X/V/Z work in both new fields. (app-test)
- [ ] Free-text + decline text survive Developer ▸ Reload. (app-test)
- [ ] Durable artifact shows free-text answers and a declined state. (unit + visual)
- [ ] `bun run check && bun test && just lint && just app-test` green.

**Acceptance tests:**
- [ ] Unit: `buildQuestionAnswers` (free-text precedence), `formatQuestionAnswer` (response path), store reducer (response frame).
- [ ] app-test: free-text answer, decline reply, reload, Cmd-keys.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] `Chat about this` arm-the-prompt variant (dismiss dialog, route the next prompt submission as the `response`) — the CLI's literal behavior, if the inline field proves limiting.
- [ ] Per-option "Type something" inline at a specific option slot (vs. one field per question), if requested.

| Checkpoint | Verification |
|------------|--------------|
| Free-text + decline wired end to end | `just app-test` across both paths |
| No regression to options/cancel | existing dialog suites + app-test |
| Green gate | `bun run check && bun test && just lint && just app-test` |
