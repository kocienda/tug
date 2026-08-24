<!-- tugplan v2 -->

## Tide Interactive Dialogs {#tide-interactive-dialogs}

**Purpose:** Establish a `TideInteractiveDialog` **input-form primitive** that `PermissionDialog` and `QuestionDialog` both compose on; rename `session.peelNewest()` to `session.popInteractive()` and update every callsite; replace the weak "wrapper" prose with the precise "tool block" concept; lock in the lifecycle (pending / resolved / recorded) and cancel-gesture vocabulary across the family. The asymmetry between `PermissionDialog` (the dialog owns the entire record) and `AskUserQuestion` (input dialog + transcript-position tool block) is **load-bearing and grounded in the SDK's transport model** — this plan names it honestly rather than forcing unification.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-05-23 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

Tide today has two interactive transcript surfaces, and JSONL-transcript investigation (see `#investigation-asymmetry`) confirmed they are **structurally different artifacts** sharing only visual vocabulary:

1. **`PermissionDialog`** (`chrome/tide-permission-dialog.tsx`) — *out-of-band SDK control request*. The AI never sees the user's Allow/Deny decision in its conversation context, and JSONL never carries a durable record of the gating event (see updated `#investigation-asymmetry`). The dialog is therefore *pending-only* — once the user clicks Allow / Deny the dialog vanishes and leaves no record (Step 3.5 removes the former recorded chrome because it couldn't survive cold boot — `#step-3-5`). Composes on `TugInlineDialog`. `Deny` is a *positive decision* (sends `respondApproval({decision: "deny"})`), not a cancel.

2. **`QuestionDialog`** + **`AskUserQuestionToolBlock`** (`chrome/tide-question-dialog.tsx`, `cards/tool-wrappers/ask-user-question-tool-block.tsx`) — *in-band tool_use/tool_result*. The AI sees the user's answers naturally via the tool_result text content (e.g., `"User has answered your questions: 'Q?'='A'. You can now continue..."`). The dialog is the **input form** (pending state, sticky/floating, scroll-agnostic); the tool block is the **rendered representation** of the tool_use/tool_result pair at its natural conversation position. The split exists because the input form needs to be visible regardless of scroll, while the record lives where the tool_use lives.

Beyond those two surfaces, the recent AskUserQuestion deep-dive (paged wizard rail, lucide-icon vocabulary, `TugProgress` `inherit` role, salvage path, Cancel-Esc unification) produced a stack of one-off decisions that need to harmonise as a family.

#### Strategy {#strategy}

- **Stop fighting the asymmetry.** `TideInteractiveDialog` is the **input-form primitive** — it covers PermissionDialog's pending state and QuestionDialog's pending state. PermissionDialog has no post-decision chrome — Step 3.5 (`#step-3-5`) drops it once the wire reality showed JSONL can't durably reconstruct it; AskUserQuestion's tool block continues to render its tool_use/tool_result pair because that's where it naturally lives and its data IS in JSONL. See `[D08]`.
- **Rename `peelNewest` → `popInteractive`.** The function name should reflect the family it serves (interactive dialogs) and the LIFO stack mechanics (`pop` from a stack of pending interactives). See `[D09]`. Step 0 lands the rename first so every subsequent step writes the new name from the start.
- **Replace "wrapper" with "tool block" in prose.** The `*ToolBlock` components already use the right noun; the conceptual fuzziness is in calling them "wrappers" when they're really *renderers* of tool_use/tool_result pairs at their conversation positions. See `[D11]`.
- **Lock the lifecycle vocabulary.** `pending` (live input form) and `recorded` (durable transcript artifact) — used consistently across docs, doc-comments, and tests. See `[D12]`. Both PermissionDialog and QuestionDialog have only `pending` after Step 3.5; AskUserQuestion's *tool block* IS the recorded artifact (its data is in JSONL via tool_use/tool_result); PermissionDialog has *no* recorded artifact because the SDK never writes one to JSONL.
- **Esc / Cancel / Stop is one gesture.** Every cancel-class action resolves to `session.popInteractive()`. No `respondX({})` paths from a Cancel — those read to the model as "user picked the defaults" and are wrong. See `[D02]`.
- **Tests pin pure helpers; HMR vets the visual chrome.** Per project policy. No fake-DOM render tests.

#### Success Criteria (Measurable) {#success-criteria}

- `session.popInteractive()` exists; `session.peelNewest()` does not. Verified by `grep -r peelNewest tugdeck/src` returning zero results.
- Both interactive dialog surfaces compose on `TideInteractiveDialog` — verified by `grep` over `chrome/tide-permission-dialog.tsx` / `chrome/tide-question-dialog.tsx` for `TideInteractiveDialog` imports (no direct `TugInlineDialog` import in either).
- `Cancel` button on QuestionDialog calls `session.popInteractive()` — verified by `grep` + tests pinning the handler. (Salvage UI's `Cancel` is exempt per the `[D02]` carve-out; it stays on local-dismiss.)
- `tide-question-dialog.test.ts` passes post-migration without structural changes to existing assertions (semantics-preserving refactor). `tide-permission-dialog.test.ts` keeps its pending-side assertions intact; its `recordedPermissionPresentation` describe block is removed by Step 3.5 — that delta is expected, not a regression.
- `bun test` clean across the full suite (Step 2 baseline: 2586 pass; Step 3.5 nets out lower by the count of dropped recorded-chrome cases, with no green case turning red).
- `bun run audit:tokens lint` → zero violations.
- `bun x tsc --noEmit` → clean.
- Salvage path (AskUserQuestion only) continues to detect validation errors and post answers via `session.send` — pure helper tests still green.
- Prose audit: no instance of "wrapper" used to describe `*ToolBlock` components in tugdeck docstrings / doc-comments after Step 4.
- Recorded permission chrome removed: `grep -r controlRequestLog tugdeck/src` and `grep -r ControlRequestRecord tugdeck/src` both empty after Step 3.5; `tide-permission-dialog.tsx` returns `null` when `isPending === false`.

#### Scope {#scope}

0. Rename `session.peelNewest()` → `session.popInteractive()` and update every callsite.
1. Extract `TideInteractiveDialog` input-form primitive at `tugways/tide-interactive-dialog.tsx` (+ `.css`).
2. Migrate `PermissionDialog` onto `TideInteractiveDialog`. Preserve all current pending-form behaviour (scope picker, Allow/Deny, Deny carve-out).
3. Migrate `QuestionDialog` onto `TideInteractiveDialog`. Preserve wizard rail, auto-advance, layout stability, Cancel == `popInteractive`.
3.5. Drop the recorded permission chrome — JSONL has no durable record to reconstruct it. PermissionDialog becomes pending-only; `controlRequestLog` / `ControlRequestRecord` / `turn.controlRequests` are removed. Tool block alone tells the post-decision story. See `#step-3-5`.
4. Review `AskUserQuestionToolBlock` against the family vocabulary; align icons / progress indicators / banner tokens. Replace "wrapper" with "tool block" in tugdeck prose (docstrings, doc-comments).
5. Final integration checkpoint: pure-logic suite green, tsc green, audit-tokens lint clean, HMR-vetted live flows on both surfaces.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Adding any side-channel record for AskUserQuestion answers or permission decisions. Questions stay in-band via tool_use/tool_result (the tool block IS the rendered representation of that pair); permission decisions stay live-only post-Step-3.5 — the wire-side `tool_approval` frame is the SDK's commitment, and the tool_use / tool_result that follows IS the durable transcript artifact. Inventing a parallel `turn.controlRequests[]`-style accumulator on either side is no longer in scope; see `#step-3-5` for why the existing permission accumulator is being removed.
- Generalising the salvage path (post-validation-error answer recovery) to other tools. Salvage is `AskUserQuestion`-only — Bash / Edit / etc. validation errors continue to fall back to `DefaultToolWrapper`'s generic error band.
- Renaming `ToolWrapperChrome` / `DefaultToolWrapper` files or component names — see `[Q06]`. Prose cleanup happens here; component-file renames are a follow-on.
- Inlining the QuestionDialog at its tool_use conversation position (Path 2 from the design discussion). The sticky/floating placement is preserved — the dialog needs to be visible regardless of scroll. See `[D08]` for the rationale.
- Replacing `TugInlineDialog`. It stays as the lower-level primitive that `TideInteractiveDialog` composes on; non-interactive callsites (one-shot alerts, confirm prompts) keep using `TugInlineDialog` directly.
- Building a "salvage UI standard." Keep the AskUserQuestion-specific surface as-is.

#### Dependencies / Prerequisites {#dependencies}

- The just-landed AskUserQuestion work (commits `77f6b7c6` / `8dd1d7ae`): paged wizard, validation salvage, Cancel → `peelNewest`. This plan refines and harmonises that work — it does not redo it. Step 0 catches the recent `peelNewest` callsite that landed in `8dd1d7ae`.
- `session.peelNewest()` semantics (`code-session-store.ts:603`): LIFO peel queued sends, fall through to `interrupt()` for the running turn. The rename is name-only; semantics are unchanged.
- `TugInlineDialog`'s `confirmDisabled` + `cancelRole` props (landed earlier this session).
- `TugProgress` `inherit` role (landed this session). The salvage path and any in-flight indicators rely on it for tone-correct rendering.

#### Constraints {#constraints}

- The rename (Step 0) must be exhaustive — zero `peelNewest` references after the step. Mechanical search-and-replace plus test updates; no semantics change.
- The Step 2 migration must be **behaviour-preserving** for `PermissionDialog`'s pending input form (scope picker, Allow / Deny buttons, the Deny carve-out via `cancelRole="action"`). The post-decision lifecycle is then *removed* by Step 3.5 — the recorded chrome's behaviour does not need to be preserved because the chrome itself goes away (see `#step-3-5` for the durability argument).
- The migration must be **behaviour-preserving** for `QuestionDialog`'s wizard rail — including layout-stability measurement, auto-advance on single-select, `confirmDisabled` gating on the Submit-all button.
- All existing `tide-permission-dialog.test.ts` and `tide-question-dialog.test.ts` assertions must continue to pass after migration. New tests may be added; existing ones must not be silently modified.
- No new tokens introduced unless they replace a duplicated definition across the two surfaces.

#### Assumptions {#assumptions}

- `TugInlineDialog` is the right base layer to compose on. We are not redesigning the underlying primitive.
- The architectural asymmetry between PermissionDialog and AskUserQuestion is load-bearing (confirmed by JSONL investigation — see `#investigation-asymmetry`). Plans that try to force unification fight the SDK's transport model.
- The user accepts a phase that lifts a primitive and renames a function without adding net-new user-visible functionality. The user-visible outcome is "everything reads more consistent and is less likely to drift."

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan format relies on **explicit, named anchors** and **rich `References:` lines** in execution steps.

#### 1) Use explicit anchors everywhere you will cite later

- Append explicit anchors with `{#anchor-name}` (kebab-case, lowercase a-z + digits + hyphen only).
- Prefix conventions: `step-N`, `dNN-...`, `qNN-...`, `rNN-...`, `lNN-...`, `mNN-...`, `sNN-...`.

#### 2) `**Depends on:**` lines for execution step dependencies

Anchor references (`#step-N`), comma-separated. Omit the line for steps with no dependencies.

#### 3) `**References:**` lines are required for every execution step

Cite decisions by ID (`[D05]`), specs / lists / tables by label (`Spec S15`, `List L03`), open questions when resolved (`[Q03]`), and anchors as `#anchor-name`. Never cite line numbers.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] What does the `TideInteractiveDialog` primitive own vs delegate to `TugInlineDialog`? (RESOLVED) {#q01-primitive-boundary}

**Question:** Where does the boundary sit? Thin wrapper / lifecycle owner / lifecycle + session integration?

**Resolution:** RESOLVED — `TideInteractiveDialog` is the **input-form primitive** (thin wrapper variant). It owns the *pending input form* defaults (`cancelRole: "danger"`, `actions row: space-between`, `Esc / Cancel → popInteractive`) and nothing more. It does NOT own post-decision rendering. PermissionDialog has only a pending state (post-Step-3.5; the prior recorded chrome was removed because JSONL has no durable record to reconstruct from — see `#step-3-5`). AskUserQuestion's pending state is the dialog; its recorded state is the tool block at the tool_use position. The dialog primitive only ever sees the pending state. See `[D08]`.

#### [Q02] Should QuestionDialog gain a `turn.controlRequests` record like PermissionDialog has? (RESOLVED — now moot) {#q02-question-history}

**Question:** Today PermissionDialog persists decisions in `turn.controlRequests[]`. AskUserQuestion doesn't. Should we add one?

**Resolution:** RESOLVED (no — and the field itself is being removed). When this question was first answered, the rationale was: AskUserQuestion's answers round-trip via tool_use/tool_result — the conversation context already contains the record, so a parallel `turn.controlRequests[]` entry would duplicate state. That reasoning still holds. After Step 3.5 (`#step-3-5`), `turn.controlRequests` is removed entirely on the permission side too, because JSONL has no durable footprint for permission decisions (see updated `#investigation-asymmetry`). Both surfaces end up with the same shape: no `turn.controlRequests`. The asymmetry between them is purely on the pending input-form side now. See `[D10]`.

#### [Q03] Cancel button vocabulary on PermissionDialog — is `Deny` the cancel, or a separate Cancel button? (RESOLVED) {#q03-cancel-vocab}

**Question:** Today PermissionDialog uses `Deny` as a *positive decision* (`respondApproval({decision: "deny"})`), distinct from `popInteractive`. QuestionDialog uses `Cancel` (outlined-danger, `popInteractive`). Should PermissionDialog gain a separate `Cancel` button alongside `Deny`, or stay with `Deny` only and surface `popInteractive` via Esc?

**Why it matters:** `Cancel ≡ Esc ≡ popInteractive` is the family rule. If `Deny` is semantically the cancel, it should call `popInteractive`. If they're different, the dialog needs both buttons.

**Resolution:** RESOLVED — keep `Deny` as a positive decision (sends `respondApproval({decision: "deny"})`); surface `popInteractive` via Esc only. No separate `Cancel` button on PermissionDialog. The pending dialog passes `cancelRole="action"` to opt out of the family danger-tone default. Verified by HMR in Step 2: Allow / Deny paths and the recorded state render correctly; the family `space-between` actions-row layout reads as Mac HIG opposed-choices. Documented as a carve-out in `[D02]` and the `code-session-store.ts` `popInteractive` docstring.

#### [Q05] Should the salvage path live inside `TideInteractiveDialog`? (DEFERRED) {#q05-salvage-primitive}

**Question:** The validation-error salvage path is AskUserQuestion-only. The pattern — wrapper detects an error, mounts an inline recovery UI, posts a follow-up via `session.send` — is reusable. Worth hoisting?

**Resolution:** DEFERRED. Keep component-local in `AskUserQuestionToolBlock` per the user's direction. Revisit when a second concrete callsite emerges.

#### [Q06] Should `ToolWrapperChrome` / `DefaultToolWrapper` be renamed to `ToolBlockChrome` / `DefaultToolBlock`? (RESOLVED) {#q06-tool-wrapper-rename}

**Question:** `[D11]` deprecates "wrapper" in prose, but two component files keep the word in their names: `ToolWrapperChrome` (the shared frame) and `DefaultToolWrapper` (fallback for unrecognised tools). Should they be renamed for consistency?

**Why it matters:** Internal consistency. After the prose cleanup in Step 4, readers will see "tool block" in docs and "ToolWrapper*" in code, which is a small but persistent friction.

**Plan to resolve:** Done as a mechanical post-phase pass. PascalCase / camelCase / CONST symbols, kebab-case slots and classes, `default-tool-wrapper.*` and `tool-wrapper-chrome.*` file pairs, the `tool-wrappers/` directory, and prose in `tuglaws/component-authoring.md` + `tugdeck/styles/` theme-token comments all renamed in one cascade. App-test fixtures pinned zero references, so no test rewrites required.

**Resolution:** RESOLVED — renamed everywhere; `grep -r 'ToolWrapper\|tool-wrapper\|TOOL_WRAPPER' tugdeck/ tuglaws/` is empty.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| `peelNewest` rename misses a callsite, breaks Cancel/Esc/Stop | high | low | `grep -r peelNewest` after rename; integration HMR pass on prompt entry, both dialogs, salvage UI | First HMR run after Step 0 |
| Migration regresses PermissionDialog's pending ↔ resolved transition | high | med | Pin existing tests; HMR-vet against a real permission prompt | First HMR run after Step 2 |
| QuestionDialog's measurement-based layout-stability breaks after refactor | med | low | Keep the measurement helper in QuestionDialog (not the primitive); migration only swaps the outer chrome | Visible layout shift on Next/Back |
| The new primitive accumulates "yet another opinionated wrapper" without clear cuts vs. `TugInlineDialog` | med | low | `[D08]` pins the boundary: input-form only, no lifecycle ownership. Anything outside that is a follow-on | Step 1 PR review |
| Cancel == `popInteractive` confuses the model in PermissionDialog (today `Deny` is the positive decision) | med | low | This plan intentionally does NOT change PermissionDialog's `Deny` semantics — `[Q03]` surfaces the choice; default is "keep Deny" | If `[Q03]` flips |

**Risk R01: TugInlineDialog tests drift** {#r01-inline-dialog-tests}

- **Risk:** Hoisting opinionated defaults into a new primitive may inadvertently change `TugInlineDialog`'s prop defaults (since `TideInteractiveDialog` configures it).
- **Mitigation:** `TugInlineDialog` is not modified by this plan. The new primitive composes on top via call-site defaults, not by editing `TugInlineDialog`'s defaults.
- **Residual risk:** Anyone reading `tide-permission-dialog.tsx` post-migration has to follow two layers (`PermissionDialog → TideInteractiveDialog → TugInlineDialog`) to understand the final rendered chrome. Mitigated by the doc-strings on `TideInteractiveDialog`.

**Risk R02: Doc/code drift between asymmetry framing and reality** {#r02-asymmetry-drift}

- **Risk:** The asymmetry framing in `[D10]` is grounded in JSONL evidence captured at plan-write time. If Claude Code's SDK changes how permission frames are delivered (e.g., adds an AI-visible record), the framing breaks.
- **Mitigation:** Step 5's integration checkpoint includes a quick re-grep of the SDK frame shapes to confirm the asymmetry still holds.
- **Residual risk:** Low; SDK shape is stable.

---

### Design Decisions {#design-decisions}

> Record *decisions* (not options). Each decision includes the "why" so later phases don't reopen it accidentally.

#### [D01] `TideInteractiveDialog` is a new primitive that composes on `TugInlineDialog` (DECIDED) {#d01-new-primitive-on-tug-inline-dialog}

**Decision:** Introduce `tugways/tide-interactive-dialog.tsx` as a Tide-specific composition layer on top of `TugInlineDialog`. The two existing dialog callsites (`PermissionDialog`, `QuestionDialog`) migrate onto it. `TugInlineDialog` is not modified.

**Rationale:**
- `TugInlineDialog` is general-purpose; baking the input-form opinions (Cancel-Esc-popInteractive, danger-toned outlined cancel, Mac-HIG separation, `confirmDisabled` gating) into it would push those defaults onto non-interactive callsites (alerts, single-confirm prompts) that shouldn't carry them.
- A Tide-specific layer keeps the opinions in one place — every interactive input form in Tide composes on the same shell.
- The boundary is clean: `TugInlineDialog` owns the visible chrome (frame, icon column, title/description, options stack, actions row); `TideInteractiveDialog` owns the Tide opinions (button vocabulary, cancel convention, `confirmDisabled` default).

**Implications:**
- New file pair: `tugways/tide-interactive-dialog.{tsx,css}`.
- `PermissionDialog`, `QuestionDialog` swap their `TugInlineDialog` import for `TideInteractiveDialog`.
- `TugInlineDialog` keeps every existing prop unchanged.

#### [D02] Cancel ≡ Esc ≡ `popInteractive` across the family (DECIDED) {#d02-cancel-equals-esc-equals-popinteractive}

**Decision:** Every interactive surface's cancel gesture — button click, Esc keypress, Stop-button click — resolves to `session.popInteractive()`. No `respondX({})` paths that the assistant can read as "user picked the defaults."

**Rationale:**
- Validated this session: AskUserQuestion's `respondQuestion({})` cancel was read by the model as "user accepts the defaults," which was wrong.
- `popInteractive` is the unified pop-from-LIFO-stack gesture; it handles queued sends LIFO and falls through to `interrupt()` for the running turn.
- One gesture, one wire signal, one model reading.

**Implications:**
- QuestionDialog's `Cancel` button calls `session.popInteractive()`.
- Esc keeps reaching `popInteractive` through the responder chain (no per-dialog Esc handler).

**Carve-outs** (gestures that look like "cancel" but are *not* part of this rule):
- **PermissionDialog's `Deny` button** — a *positive decision* via `respondApproval({decision: "deny"})`, not a walk-away. See `[Q03]`.
- **AskUserQuestionToolBlock salvage UI's `Cancel` button** — a *local dismissal* of the recovery surface. The failed AskUserQuestion tool call has already resolved with an error before the salvage UI mounts; there is no pending interactive on the stack to pop. Calling `popInteractive` here would either no-op (empty queue) or interrupt an unrelated running turn — both wrong. The salvage Cancel uses local React state (`setSalvageCancelled(true)`) and stays that way.

#### [D03] Cancel button visual: outlined + danger, leading edge, Mac-HIG separation (DECIDED) {#d03-cancel-button-visual}

**Decision:** When an interactive surface renders a Cancel button, it uses:
- `emphasis="outlined"`, `role="danger"`,
- Leading edge of the actions row (Mac HIG `Don't Save` position),
- `justify-content: space-between` so Cancel and the primary action anchor opposite edges.

**Rationale:**
- Cancel is destructive-secondary (walk away from this), distinct from the primary action.
- Mac HIG separation makes the two choices read as opposed rather than as a tightly-grouped pair.
- Already in place on QuestionDialog; the primitive lifts it as the family default.

**Implications:**
- `TideInteractiveDialog` defaults `cancelRole` to `"danger"`.
- `TideInteractiveDialog`'s actions row uses `space-between` layout.
- PermissionDialog's `Deny` already uses outlined-action; this decision doesn't change `Deny` (see `[Q03]`).

#### [D04] Status icons: lucide only, one vocabulary across the family (DECIDED) {#d04-status-icons}

**Decision:** Row / state status indicators across the interactive family use lucide icons:
- `Check` — confirmed / completed / done
- `Circle` — empty / pending / not-yet
- `CircleDot` — recommended / soft default (the seeded radio option)
- `ChevronRight` — current / focused
- `Loader2` — in-flight / actively running (CSS-animated)

**Rationale:** Established for QuestionDialog. Lucide icons paint via `currentColor`, sit on the cap-height baseline cleanly, and respect `prefers-reduced-motion`.

**Implications:** QuestionDialog already uses `Check` / `Circle` / `CircleDot` / `ChevronRight`. Future interactive-family components pick from this vocabulary, not from text glyphs.

#### [D05] In-flight indicators: `TugProgress` ring with `role="inherit"` (DECIDED) {#d05-progress-role-inherit}

**Decision:** "Work in flight" indicators across the family render `TugProgress variant="ring" size="sm" role="inherit"` so the ring picks up surrounding text colour rather than the brand accent.

**Rationale:** Established for `StreamingPlaceholder` this session. The ring reads as part of the surrounding muted prose, not as a foreground accent. `role="inherit"` mirrors `TugBadge`'s `inherit` role.

**Implications:** `StreamingPlaceholder` already uses this. Any new in-flight surface in the family adopts the same shape.

#### [D06] Salvage path stays AskUserQuestion-only (DECIDED) {#d06-salvage-scope}

**Decision:** The "post-validation-error, mount inline recovery UI, post answers via `session.send`" pattern is implemented in `AskUserQuestionToolBlock` and only there.

**Rationale:** Per the user's direction. Premature generalisation without a second concrete callsite invites design churn.

**Implications:** `[Q05]` deferred. The salvage helpers stay in `cards/tool-wrappers/ask-user-question-tool-block.tsx`.

#### [D08] `TideInteractiveDialog` is the input-form primitive, not a lifecycle owner (DECIDED) {#d08-input-form-primitive}

**Decision:** `TideInteractiveDialog` owns the **pending input form** chrome and defaults only. It does NOT own post-decision rendering. Both PermissionDialog and QuestionDialog use it for their pending dialog and nothing else. AskUserQuestion's recorded state is its tool block at the tool_use position (`AskUserQuestionToolBlock`) — that's where the SDK's durable record naturally lives. PermissionDialog has no recorded state at all (Step 3.5 removed it once JSONL's lack of a durable permission record became clear — `#step-3-5`).

**Rationale:**
- JSONL investigation (`#investigation-asymmetry`) confirmed the two surfaces are structurally different artifacts. PermissionDialog operates out-of-band (SDK control frames invisible to the AI AND absent from JSONL); AskUserQuestion operates in-band (tool_use/tool_result visible to the AI and durable in JSONL). They share visual vocabulary but not transport channels.
- A primitive that owned post-decision lifecycle would either need to (a) require inlining the QuestionDialog at its tool_use position (Path 2 — out of scope, see `#non-goals`), (b) invent transcript positions that don't exist (Path 3 — the road Step 3.5 walked back from), or (c) bloat itself with shape both surfaces would override.
- An input-form-only primitive is the smallest cut that captures the shared concerns (cancel gesture, button styling, confirmDisabled, actions row) without misrepresenting what each surface can durably retain.

**Implications:**
- `TideInteractiveDialogProps` is `Omit<TugInlineDialogProps, "cancelRole"> & { cancelRole?: TugInlineDialogCancelRole }` — thin wrapper, no lifecycle props.
- The primitive does NOT subscribe to `session.pendingX` — callers do that and conditionally render the primitive.
- PermissionDialog renders the primitive while `isPending === true`, and renders nothing once the decision is made. The tool block's render of the tool_use/tool_result pair stays in `AskUserQuestionToolBlock`.
- Resolves `[Q01]`.

#### [D09] Rename `session.peelNewest()` to `session.popInteractive()` (DECIDED) {#d09-popinteractive-rename}

**Decision:** The session method `peelNewest` is renamed to `popInteractive`. Every callsite — Cancel handlers, Esc handlers, the Stop button, doc-comments, tests — updates in one mechanical pass (Step 0). Semantics are unchanged.

**Rationale:**
- `peelNewest` reads oddly at every callsite ("clicking Cancel should peel the newest...?"). The name was a stack-internals leak.
- `popInteractive` names the family (interactive dialogs) and the stack mechanic (`pop`). Reads correctly at every callsite: `Cancel handler → session.popInteractive()`; `Esc handler → session.popInteractive()`; `Stop button → session.popInteractive()`.
- Tighter than `popCancelInteractive` while preserving the two essential pillars (LIFO + family marker). The "cancel" verb stays present where it matters (button label, Esc semantics, `[D02]` prose).

**Implications:**
- `code-session-store.ts` — rename the method and any references.
- `chrome/tide-question-dialog.tsx` — update `handleCancel`.
- `cards/tool-wrappers/ask-user-question-tool-block.tsx` — update salvage UI Cancel handler.
- Prompt entry (`tide-prompt-entry/*`) — update Esc / Stop wiring.
- Tests pinning the method name.
- Doc-comments referencing the method.

#### [D10] The PermissionDialog ↔ AskUserQuestion asymmetry is load-bearing (DECIDED) {#d10-asymmetry-load-bearing}

**Decision:** PermissionDialog and AskUserQuestion are not variants of the same shape. They are structurally different artifacts that share visual vocabulary. This plan names the asymmetry honestly and does not attempt to force unification — including the asymmetry's hardest consequence: PermissionDialog has no durable transcript artifact, so it has no recorded chrome (Step 3.5 — `#step-3-5`).

**Rationale:**
- JSONL investigation (`#investigation-asymmetry`) confirmed: permission decisions are out-of-band SDK control frames (invisible to the AI AND absent from JSONL — the `control_request_forward` frame itself, the gating decision, and the request id all live only on the live control wire); AskUserQuestion answers are in-band tool_use/tool_result (visible to the AI AND durable in JSONL).
- The dialog/tool-block split for AskUserQuestion isn't accidental — it falls out of the SDK's transport model. The dialog is the input form (sticky/floating, scroll-agnostic); the tool block is the rendered representation of the tool_use/tool_result pair at its conversation position.
- PermissionDialog's *pending-only* shape isn't accidental either — there's no AI-side record to attach a separate component to, AND no JSONL record to reconstruct one from on cold boot. The earlier "recorded chrome" was a feature the wire couldn't durably support; Step 3.5 removes it.

**Implications:**
- Resolves `[Q02]` (no, don't add a `turn.controlRequests` record for questions — and the field itself is gone post-Step-3.5 because the permission side can't durably populate it either).
- The primitive is input-form only per `[D08]`.
- Future PRs that try to "unify" the two surfaces — or to restore the recorded permission chrome — should re-read `[D08]`, `[D10]`, and `#step-3-5-context` first.

#### [D11] "Wrapper" is deprecated in prose; "tool block" is the canonical term (DECIDED) {#d11-tool-block-vs-wrapper}

**Decision:** In documentation, doc-comments, and conversational prose, the rendered representation of a tool_use/tool_result pair is called a **tool block**, not a **tool wrapper**. The `*ToolBlock` component names already use the right noun; only the prose changes.

**Rationale:**
- "Wrapper" suggests the component is wrapping something underneath. It isn't — the tool block IS the rendered representation. There's nothing to wrap.
- "Tool block" is more accurate: it's a block in the transcript that renders a tool.
- The component-file names (`ToolWrapperChrome`, `DefaultToolWrapper`) retain "Wrapper" for now per `[Q06]` (DEFERRED).

**Implications:**
- Step 4 includes a prose audit: replace "wrapper" with "tool block" in tugdeck docstrings, doc-comments, and any plan-referenced prose.
- Component-file renames are out of scope (follow-on).

#### [D12] Lifecycle vocabulary: pending / recorded (DECIDED) {#d12-lifecycle-vocab}

**Decision:** The canonical lifecycle states across the family are:

- **`pending`** — awaiting user input. The dialog is up; no decision yet.
- **`recorded`** — the SDK has committed a durable artifact to the conversation transcript (i.e. a `tool_use` / `tool_result` pair in JSONL). The tool block at the tool_use position IS the recorded state.

Both PermissionDialog and QuestionDialog have only `pending`. Only `AskUserQuestionToolBlock` is `recorded`, because only it has a JSONL-durable backing pair (the AskUserQuestion tool_use + its answer-carrying tool_result). PermissionDialog has no recorded state — the SDK never writes one (Step 3.5, `#step-3-5`).

**Rationale:**
- Eliminates drift between "live", "settled", "resolved", "resolved-record", "recorded" wording variations. One vocabulary across docs, doc-comments, and tests.
- The earlier draft of this decision included a transient `resolved` state for PermissionDialog (an in-place pending → resolved → recorded transition). Step 3.5 (`#step-3-5`) collapsed that lifecycle to pending-only when the JSONL-shape investigation showed `recorded` couldn't be durably reconstructed for permissions. The two-state vocabulary above is what remains.

**Implications:**
- Plan prose uses these two terms consistently.
- Tests can pin state values using these names.
- Drop "live", "settled", and "resolved" from the family vocabulary.

---

### Deep Dives {#deep-dives}

#### Investigation — the AskUserQuestion / PermissionDialog asymmetry {#investigation-asymmetry}

JSONL transcript investigation (`~/.claude/projects/.../*.jsonl`) confirmed the architectural asymmetry between the two surfaces.

**Finding 1 — AskUserQuestion answers round-trip via tool_result.** When AskUserQuestion succeeds, the SDK delivers the answers back to the AI as text content in the matching `tool_result` frame:

```
"User has answered your questions: \"<question text>\"=\"<answer text>\". 
 You can now continue with the user's answers in mind."
```

The AI sees the full Q→A pairs in its conversation context, attached to the `tool_use_id` of the original `AskUserQuestion` call. AskUserQuestion is a first-class round-trip through the standard tool_use/tool_result mechanism.

**Finding 2 — Permission frames are entirely out-of-band.** A grep across the full project JSONL corpus (`~/.claude/projects/-Users-kocienda-Mounts-u-src-tugtool/*.jsonl`) returned **zero** `permission_request` / `permission_decision` / `tool_approval` / `control_request_forward` frames. The exhaustive enumeration of every JSONL `"type"` value yielded only `assistant` / `user` / `system` / `tool_use` / `tool_result` / `text` / `thinking` / `image` / `attachment` / a handful of UI bookkeeping types — never a control-channel frame. The SDK synthesises `control_request_forward` on the live wire from a `can_use_tool` control request (`tugcode/src/session.ts:2807`), and that is the *only* place that frame exists. Nothing in the JSONL transcript on disk carries the gating event, the gating decision, or the request id. The replay translator (`tugcode/src/replay.ts`) has no `can_use_tool` code path; it translates `assistant` / `user` content blocks into `tool_use` / `tool_result` / `tool_use_structured` / `assistant_text` frames and nothing else.

**Implication for the reducer.** `pendingApproval` is set only by `handleControlRequestForward`, which only accepts live phases. During JSONL replay `pendingApproval` is **always `null`** — there is no signal in JSONL that ever sets it. Any "derive on replay" strategy gated on `pendingApproval` is a permanent no-op. This is why Step 3.5 drops the recorded permission chrome rather than trying to reconstruct it (see `#step-3-5`).

**Finding 2.a — SDK denial-text pattern (deny-side signal that DOES survive into JSONL).** Although the gating frame itself is out-of-band, the *consequence* of a denial does land in JSONL — the SDK writes the rejection text into the matching `tool_result.content` and sets the entry-level `toolUseResult: "User rejected tool use"` marker. Verified across the full corpus:

- **Opener:** `"The user doesn't want to proceed with this tool use"` (the primary signature phrase).
- **Secondary phrase:** `"The tool use was rejected"` (the SDK's standard suffix to the opener).
- **Two stylistic suffix variants:**
  - *STOP form* — `"STOP what you are doing and wait for the user to tell you how to proceed."` (plain Deny click, no user follow-up).
  - *Clarify form* — `"To tell you how to proceed, the user said: <user message>"` (Deny + a user-supplied follow-up message).
- **Sample count:** 120 deny markers in this project's JSONL corpus; 124 across all projects. Both suffix variants share the opener + the secondary phrase.

The denial signal is therefore robust on the wire. What's missing is the *allow* side: a gated tool that was allowed produces a `tool_result` that is byte-identical to an ungated tool's `tool_result`, so JSONL cannot distinguish them. This is the architectural constraint Step 3.5 navigates.

**Finding 3 — The asymmetry is architectural.** The two surfaces' structural shapes fall out of their delivery channels:

| | PermissionDialog | AskUserQuestion |
|---|---|---|
| Channel | Out-of-band SDK control frame | In-band tool_use / tool_result |
| AI visibility | Invisible | Visible in tool_result text |
| Durable record on disk | **None** (deny-text leaks via `tool_result.content` but the gating event itself has no JSONL footprint, and the allow side has no signal at all) | **Already in conversation context** |
| Natural transcript position | None | At the tool_use position |
| UI shape | Pending dialog only — no recorded chrome (Step 3.5 removed it once the durability story was understood) | Input dialog (sticky) + tool block (at tool_use position) |

**Finding 4 — The "wrapper" misnomer hides a clean concept.** What we call "tool wrapper" is the *rendered representation* of a tool_use/tool_result pair at its transcript position. Calling it a wrapper suggests it's wrapping something — it isn't. It IS the tool's rendering. `[D11]` replaces "wrapper" with "tool block" in prose.

#### Surface audit — current state {#audit-current-state}

**`PermissionDialog`** (`chrome/tide-permission-dialog.tsx`):
- One component, *pending state only* after Step 3.5 (`#step-3-5`). The component renders the pending dialog while `isPending === true` and returns `null` once the decision is made. No recorded chrome (the SDK never writes a durable record to JSONL — see `#investigation-asymmetry`).
- Composes `TideInteractiveDialog` (post-Step-2) with: icon `ShieldAlert`, iconRole `caution`, title `"Permission requested"`, body via `PendingBody` (smart-picks a body kind by tool), `options` for scope picker, `confirmLabel: "Allow"`, `cancelLabel: "Deny"`, `cancelRole="action"` (positive-decision carve-out).
- History: none in `turn.controlRequests` (the field is removed in Step 3.5). The wire-side `tool_approval` frame is still sent live; the tool_use / tool_result pair that follows IS the durable record.
- Cancel = `Deny`, a positive decision (sends `respondApproval({decision: "deny"})`, not `popInteractive`).
- Esc currently → responder chain → `popInteractive` (post-rename).

**`QuestionDialog`** (`chrome/tide-question-dialog.tsx`):
- One component, `pending` state only. Renders `null` when no `pendingQuestion`.
- Composes `TugInlineDialog` with: icon `MessageCircleQuestion`, iconRole `info`, title `"Claude has questions"` / `"Claude has a question"`, body = the wizard rail or single-question option group, `confirmLabel: "Submit all"` (gated via `confirmDisabled`), `cancelLabel: "Cancel"` (role `"danger"`).
- History: none in `turn.controlRequests`. The conversation context holds the Q→A via tool_use/tool_result.
- Cancel = `popInteractive` (post-rename).
- Esc → responder chain → `popInteractive`.

**`AskUserQuestionToolBlock`** (`cards/tool-wrappers/ask-user-question-tool-block.tsx`):
- The rendered representation of the AskUserQuestion tool_use/tool_result pair at its conversation position. NOT a dialog.
- Renders `null` while streaming (the dialog is the surface during pending); renders Q&A summary post-answer; renders the salvage UI on validation errors with parseable input.
- Composes `ToolWrapperChrome` (the shared frame for tool blocks).
- Salvage UI Cancel handler: **local `setSalvageCancelled(true)` (React state), not `popInteractive`.** Correct semantics — the failed AskUserQuestion tool call has already resolved with an error before the salvage UI mounts; there is no pending interactive on the stack to pop. Local-dismiss is the right gesture. This is a deliberate carve-out from `[D02]`.
- Not migrated to `TideInteractiveDialog` — it's not an input form per `[D08]`. Reviewed in Step 4 for vocabulary alignment only.

#### The boundary question (resolved) {#primitive-boundary-question}

`[Q01]` is resolved by `[D08]`. The primitive is the input-form layer — see `Spec S01` for the prop contract. Implementation sketch:

```ts
export interface TideInteractiveDialogProps
  extends Omit<TugInlineDialogProps, "cancelRole"> {
  cancelRole?: TugInlineDialogCancelRole;  // defaults to "danger"
}

export const TideInteractiveDialog: React.FC<TideInteractiveDialogProps> = ({
  cancelRole = "danger",
  className,
  ...rest
}) => (
  <TugInlineDialog
    {...rest}
    data-slot="tide-interactive-dialog"
    cancelRole={cancelRole}
    className={cn("tide-interactive-dialog", className)}
  />
);
```

CSS scopes the actions-row `space-between` override under `.tide-interactive-dialog [data-slot="tug-inline-dialog-actions"]` — targeting the **documented `data-slot` surface** that `TugInlineDialog` exposes on its actions row (`tug-inline-dialog.tsx:383`), not the internal `.tug-inline-dialog-actions` class. This preserves `[L20]` composition sovereignty: the outer component reaches in only through the inner component's published surface, not its private CSS naming. If `TugInlineDialog` later refactors its internal class names, the slot selector keeps working.

#### Why this isn't a `TugInlineDialog` refactor {#why-not-tug-inline-dialog}

`TugInlineDialog` is also used by surfaces that are NOT input forms in this sense (one-shot alerts, transient confirms). Pushing the Cancel-Esc-popInteractive opinion into it would force those callsites either to opt out or inherit semantics that don't apply.

A Tide-specific layer on top — composable, narrowly-scoped — is the cheaper and reversible move.

---

### Specification {#specification}

#### Spec S01: `TideInteractiveDialog` prop contract {#s01-primitive-props}

**Default behaviours** that distinguish `TideInteractiveDialog` from `TugInlineDialog`:

| Behaviour | `TugInlineDialog` | `TideInteractiveDialog` |
|-----------|-------------------|-------------------------|
| `cancelRole` default | `"action"` | `"danger"` |
| Actions-row layout | `flex-end` (tightly grouped) | `space-between` (Mac HIG separation) |
| `confirmDisabled` semantics | Optional prop, default `false` | Same — surfaced by callers when gating submit |
| Esc handling | None (bubbles to responder chain) | None (explicit: stays the same) |
| Cancel onClick | Caller-supplied | Caller-supplied; family convention is `session.popInteractive()` (`[D02]`) |
| Lifecycle ownership | None | None — primitive is input-form only (`[D08]`) |

**Pass-through.** Every other `TugInlineDialog` prop flows through unchanged.

**Type:**

```ts
export interface TideInteractiveDialogProps
  extends Omit<TugInlineDialogProps, "cancelRole"> {
  cancelRole?: TugInlineDialogCancelRole;
}
```

#### Spec S02: Cancel semantics contract {#s02-cancel-semantics}

For every interactive-family surface:

1. Cancel button → `session.popInteractive()` directly OR a callback that ultimately calls `popInteractive()`. **Carve-outs:** PermissionDialog's `Deny` (positive decision per `[Q03]`); AskUserQuestionToolBlock salvage UI's `Cancel` (local dismissal — the failed tool call has already resolved; no pending interactive to pop). Per `[D02]`.
2. Esc keypress → responder chain → `CANCEL_DIALOG` action → prompt entry's `popInteractive()` handler. The dialog does not intercept Esc locally.
3. No `respondX({})` paths from a Cancel gesture. (Cancel ≠ "submit empty.")

#### Spec S03: Family visual vocabulary {#s03-visual-vocabulary}

- Status icons: per `[D04]`.
- In-flight indicator: per `[D05]`.
- Cancel button visual: per `[D03]`.
- Frame width: each surface picks its own (`PermissionDialog`: 520 px CTA-sized; `QuestionDialog`: 700 px wide for question prose). The primitive doesn't lock width.

#### Spec S04: Lifecycle state vocabulary {#s04-lifecycle-vocab}

Per `[D12]`:

| State | Meaning | PermissionDialog | QuestionDialog | AskUserQuestionToolBlock |
|-------|---------|------------------|----------------|--------------------------|
| `pending` | Awaiting user input | ✓ | ✓ | — (returns null while streaming; the dialog is the pending surface) |
| `recorded` | Committed to transcript history (JSONL-durable tool_use / tool_result pair) | — (no JSONL artifact — see `#step-3-5`) | — | ✓ (the tool block IS the recorded state) |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/components/tugways/tide-interactive-dialog.tsx` | New input-form primitive composing on `TugInlineDialog` |
| `tugdeck/src/components/tugways/tide-interactive-dialog.css` | Style overrides (actions-row `space-between`) |
| `tugdeck/src/components/tugways/tide-interactive-dialog.test.ts` | Pure-logic test pinning the default-substitution surface |

#### Files modified {#files-modified}

| File | Change |
|------|--------|
| `tugdeck/src/lib/code-session-store.ts` | Rename `peelNewest` → `popInteractive` (Step 0) |
| `tugdeck/src/lib/code-session-store/reducer.ts` | (Step 3.5) Remove `controlRequestLog` from state, the write in `handleRespondApproval`, the `controlRequests` projection in `buildTurnEntry`, and every `controlRequestLog: []` reset. Update doc-comments. |
| `tugdeck/src/lib/code-session-store/types.ts` | (Step 3.5) Remove `ControlRequestRecord`; remove `controlRequests` field from `TurnEntry`. |
| `tugdeck/src/components/tugways/chrome/tide-permission-dialog.tsx` | (Step 2) Pending state swaps `TugInlineDialog` → `TideInteractiveDialog`; explicit `cancelRole="action"` for `Deny`. (Step 3 follow-up) Recorded state was swapped to `ToolWrapperChrome` with the `recordedPermissionPresentation` helper. **(Step 3.5)** That recorded branch is now removed entirely — the component is pending-only and returns `null` once the decision is made. `decision` `useState`, `recordedPermissionPresentation`, the `ToolWrapperChrome` import + composition for the recorded path, and the recorded-state `TugBadge` chip all go. |
| `tugdeck/src/components/tugways/chrome/tide-permission-dialog.css` | (Step 3 follow-up) Removed all `--tugx-perm-record-*` / `--tugx-perm-collapse-*` tokens + the disclosure-pattern rules. **(Step 3.5)** The `.tide-permission-dialog-record-status[data-decision]` rule is removed too (the recorded chrome that owned it is gone). Two pending-state fragments remain (`-inline-icon`, `-reason`). |
| `tugdeck/src/components/tugways/chrome/tide-permission-dialog.test.ts` | (Step 3 follow-up) Replaced the `composePermissionRecordSummary` describe block with a `recordedPermissionPresentation` block. **(Step 3.5)** The `recordedPermissionPresentation` block is removed entirely (the helper no longer exists); pending-side describe blocks remain. |
| `tugdeck/src/components/tugways/chrome/tide-question-dialog.tsx` | Update `handleCancel` to call `popInteractive` (Step 0); swap `TugInlineDialog` → `TideInteractiveDialog` (Step 3); drop the local CSS override for actions-row `space-between` (moved into primitive) |
| `tugdeck/src/components/tugways/chrome/tide-question-dialog.css` | Remove the `.tide-question-dialog .tug-inline-dialog-actions { justify-content: space-between }` block |
| `tugdeck/src/components/tugways/cards/tool-wrappers/ask-user-question-tool-block.tsx` | Vocabulary alignment + prose cleanup (Step 4). **Salvage UI Cancel handler is NOT updated** — it stays on local `setSalvageCancelled` per the `[D02]` carve-out. |
| `tugdeck/src/components/tugways/tug-prompt-entry.tsx` | Update Esc / Stop wiring to call `popInteractive` (Step 0). |
| `tugdeck/src/components/tugways/cards/tide-card-transcript.tsx` | (Step 0) One prose reference: "peel-newest gesture" → "pop-interactive gesture". (Step 3) **Two-stage layout fix.** First-pass JSX reorder moved both slots to the end of the cell. Second-pass refactored permission rendering into a `ReadonlyMap<tool_use_id, ReactNode>` so permission entries threaded inline into `TranscriptToolCalls`; an orphan-permissions array stayed at the body foot; `EMPTY_PERMISSION_MAP` / `EMPTY_PERMISSION_ARRAY` sentinels were added. **(Step 3.5)** All of that goes — `permissionByToolUseId`, `orphanPermissions`, the sentinels, the body-foot orphan render, the inline-threading doc-comment block, and the `controlRequestLog` / `pendingApproval` reads that fed the slot computation. `questionSlot` and its body-foot render stay (questions still belong at the end of the cell). |
| `tugdeck/src/components/tugways/cards/tide-card-transcript-tool-calls.tsx` | (Step 3) Accept `permissionByToolUseId?: ReadonlyMap<string, ReactNode>` on both Static and Streaming variants; thread to `ToolCallsList`; render the matching permission node inside a `React.Fragment` keyed by `toolUseId`. **(Step 3.5)** That prop and the per-tool-block matching-permission render are removed; the `React.Fragment` collapses back to the bare `<Component key={toolUseId} … />`. |
| `tugdeck/src/lib/code-session-store/__tests__/code-session-store.queue.test.ts` | Rename `peelNewest` references — 4 occurrences (Step 0). |
| `tugdeck/src/lib/code-session-store/__tests__/code-session-store.control-forward.test.ts` | (Step 3.5) Drop the two synthetic-allow cases pinning `turn.controlRequests` writes; trim the `test-11` deny-replay case to keep only its outbound `tool_approval` and `prevPhase` assertions. |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `popInteractive` | method | `code-session-store.ts` | Renamed from `peelNewest`; same semantics |
| `TideInteractiveDialog` | React.FC | `tide-interactive-dialog.tsx` | The new input-form primitive |
| `TideInteractiveDialogProps` | interface | `tide-interactive-dialog.tsx` | Per Spec S01 |
| `DEFAULT_CANCEL_ROLE` | const | `tide-interactive-dialog.tsx` | `"danger"` |

---

### Documentation Plan {#documentation-plan}

- [x] Module docstring on `TideInteractiveDialog` explaining the boundary with `TugInlineDialog`, the `[D08]` input-form scope, the `[D02]` / `[D03]` defaults, and the family convention. *(Done in Step 1.)*
- [x] Module docstring on `code-session-store.ts` `popInteractive` method explaining the LIFO semantic and what "interactive" means in this family. *(Done in Step 0.)*
- [x] Cross-reference from `chrome/tide-permission-dialog.tsx` and `chrome/tide-question-dialog.tsx` to `TideInteractiveDialog`. *(Done in Steps 2 and 3 — both module docstrings name `TideInteractiveDialog` as the direct composition target with `TugInlineDialog` one layer down.)*
- [x] Step 4 prose audit: replace "wrapper" with "tool block" in tugdeck docstrings / doc-comments per `[D11]`. *(Done in Step 4 — see line ~844 for the full file list.)*

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Pure-logic unit** | Pin helpers (already done for question dialog, permission dialog) | Existing tests must continue to pass post-rename |
| **Default substitution** | Verify `TideInteractiveDialog` flips the right defaults | Step 1 |
| **Rename coverage** | Verify zero `peelNewest` references; `popInteractive` semantics preserved | Step 0 |
| **Live HMR** | Verify the rendered chrome reads correctly (permission allow/deny, question wizard, salvage) | Each migration step |

Pure-logic tests stay attached to the consumer modules. The primitive adds a tiny `tide-interactive-dialog.test.ts` that pins the default substitution + the `confirmDisabled` pass-through. No fake-DOM render tests.

---

### Execution Steps {#execution-steps}

> Commit after every step's checkpoints pass.

#### Step 0: Rename `session.peelNewest()` → `session.popInteractive()` {#step-0}

**Commit:** `refactor(tugdeck): rename peelNewest to popInteractive`

**References:** `[D09]` popInteractive rename, `[D02]` cancel semantics, (#audit-current-state)

**Artifacts:**
- Edits to `code-session-store.ts`, every callsite, tests, doc-comments.

**Tasks:**
- [x] Rename method in `code-session-store.ts:603`. Update the dispatch case in `tide-prompt-entry.tsx` (lines 910, 914, 974, 980, 988 — both call sites + the surrounding doc-prose).
- [x] Update `chrome/tide-question-dialog.tsx` `handleCancel` (line 807) and the surrounding doc-prose (lines 795, 797, 813).
- [x] Update the existing test cases in `src/lib/code-session-store/__tests__/code-session-store.queue.test.ts` (4 references, line 259 onward — rename the `it("peelNewest …")` block label and the 3 `store.peelNewest()` calls).
- [x] Update any other doc-comments referencing the method. (One more found and updated: `cards/tide-card-transcript.tsx:469` — "Stop / Esc peel-newest gesture" → "Stop / Esc pop-interactive gesture".)
- [x] `grep -r peelNewest tugdeck/src` returns zero results.
- [x] **Salvage UI is NOT touched** in this step — its Cancel handler uses local state (`setSalvageCancelled`) per the `[D02]` carve-out; that is correct behaviour and unchanged.
- [x] Rewrote the `popInteractive` doc-string to explain the LIFO semantic, what "interactive" means in this family, and the `[D02]` carve-outs (Documentation Plan item).

**Tests:**
- [x] Existing `code-session-store.queue.test.ts` cases (`peelNewest drains the queue newest-first (LIFO), then interrupts the turn`, etc.) renamed to `popInteractive …` and still passing — semantics unchanged. (6 pass / 0 fail in the file; 49 expect calls.)

**Checkpoint:**
- [x] `cd tugdeck && bun x tsc --noEmit` — clean (exit 0).
- [x] `cd tugdeck && bun test` — full suite green: 2576 pass / 0 fail / 9654 expect calls / 157 files.
- [x] `cd tugdeck && bun run audit:tokens lint` — zero violations.
- [x] `grep -r peelNewest tugdeck/src` → empty.
- [x] Manual HMR: Cancel button on question dialog, Esc keypress, Stop button — all three still cancel correctly. *(Verified by user in live session.)*

---

#### Step 1: Extract `TideInteractiveDialog` primitive {#step-1}

**Depends on:** #step-0

**Commit:** `feat(tugways): TideInteractiveDialog input-form primitive`

**References:** `[D01]` new primitive, `[D02]` cancel semantics, `[D03]` cancel button visual, `[D08]` input-form scope, Spec S01, (#why-not-tug-inline-dialog)

**Artifacts:**
- `tugdeck/src/components/tugways/tide-interactive-dialog.tsx`
- `tugdeck/src/components/tugways/tide-interactive-dialog.css`
- `tugdeck/src/components/tugways/tide-interactive-dialog.test.ts`

**Tasks:**
- [x] Implement `TideInteractiveDialog` per Spec S01. Default `cancelRole: "danger"`.
- [x] Created the actions-row `space-between` override in `tide-interactive-dialog.css`. Selector targets the published `[data-slot="tug-inline-dialog-actions"]` surface, not the internal `.tug-inline-dialog-actions` class — per `[L20]`. *(The matching block in `tide-question-dialog.css` will be removed in Step 3 when QuestionDialog migrates onto the primitive; until then the two coexist with no conflict because the primitive's CSS is not yet loaded — nothing imports `tide-interactive-dialog.tsx` yet.)*
- [x] Applied `[L19]` conformance with a deliberate scope. **No separate `data-slot="tide-interactive-dialog"` was added**: the primitive owns no DOM of its own — it returns a `TugInlineDialog` React element directly, and adding a wrapper div purely to carry an extra `data-slot` would change DOM topology (cascading specificity, layout, event-bubbling) for no real benefit. The family identifier is the `tide-interactive-dialog` className composed onto `TugInlineDialog`'s root — same precedent that `QuestionDialog` already uses (it composes on `TugInlineDialog` via className, with no separate data-slot). The module docstring on `.tsx` documents this choice. `@tug-pairings` annotation present at the top of the `.css` (acknowledging composition with `TugInlineDialog`'s tokens — the primitive owns no colour tokens of its own); no `@tug-renders-on` needed because the only rule in the file is layout-only (`justify-content`).
- [x] Module docstring per `[D01]` and `[D08]`. Cites `[D02]` for the cancel convention; `[L19]`, `[L20]`, `[L26]` for the contract; `[D03]` and `[D08]` for the visual/scope defaults.
- [x] Pure-logic test: `cancelRole="action"` override, default substitution, `confirmDisabled` pass-through (plus extras: className composition + ordering).

**Tests:**
- [x] `TideInteractiveDialog` defaults `cancelRole` to `"danger"` when omitted.
- [x] `cancelRole="action"` from the caller overrides the default.
- [x] `confirmDisabled` propagates to `TugInlineDialog` unchanged (true / false / undefined cases).
- [x] *(Bonus)* `tide-interactive-dialog` className composed onto consumer-supplied classes, family class first.

**Checkpoint:**
- [x] `bun x tsc --noEmit` — clean (exit 0).
- [x] `bun test src/components/tugways/tide-interactive-dialog.test.ts` — 10 pass / 0 fail / 20 expects.
- [x] `bun test` — full suite green: 2586 pass / 0 fail / 9674 expects / 158 files (+10 over Step 0's baseline).
- [x] `bun run audit:tokens lint` — zero violations.

---

#### Step 2: Migrate `PermissionDialog` onto `TideInteractiveDialog` {#step-2}

**Depends on:** #step-1

**Commit:** `refactor(tugways): PermissionDialog composes on TideInteractiveDialog`

**References:** `[D01]` new primitive, `[D02]` cancel semantics, `[D08]` input-form scope, `[Q03]` cancel vocab on permissions, (#audit-current-state)

**Artifacts:**
- Edits to `chrome/tide-permission-dialog.tsx`.

**Tasks:**
- [x] Swap `import { TugInlineDialog }` for `import { TideInteractiveDialog }`. (Kept the type-only `import type { TugInlineDialogOption }` — `buildPermissionOptions` still returns that type; the prop contract lives on `TugInlineDialog`.)
- [x] Pass `cancelRole="action"` explicitly so `Deny` keeps its outlined-action treatment (per `[Q03]` default resolution). Inline comment added at the JSX cite-point explaining the `[D02]` / `[Q03]` carve-out.
- [x] Verify the resolved-record state still in-place-transitions correctly (no remount under the same `request_id`) — `[L26]` mount-identity stability. **Verified:** `PermissionDialog` itself is the long-lived component; its `useState` for `decision` and `recordExpanded` survives the pending → resolved transition because the parent stays mounted. The pending → resolved transition swaps the *child* tree (`TideInteractiveDialog` → resolved-record `<div>`), which is expected — the dialog is replaced by the compact record once Allow/Deny is clicked. The migration changes only the pending-branch JSX (`TugInlineDialog` → `TideInteractiveDialog`); React-reconciliation identity at the consumer level is byte-identical because `PermissionDialog`'s own position, key, type, and renderer reference are unchanged.
- [x] Verify history-recording behaviour unchanged (the reducer doesn't depend on the visible chrome). **Verified:** `respondApproval` is called identically; the reducer writes `turn.controlRequests[]` unchanged.
- [x] Update module docstring: now names `TideInteractiveDialog` as the direct composition target, with the underlying `TugInlineDialog` named one layer down. `[L20]` line updated to reflect the two-layer composition.

**Tests:**
- [x] Existing `tide-permission-dialog.test.ts` cases still pass without modification (34 pass / 0 fail / 67 expects).
- [x] No new tests added — the migration is semantics-preserving and the existing pure-helper tests cover the public surface.

**Checkpoint:**
- [x] `bun x tsc --noEmit` — clean (exit 0).
- [x] `bun test src/components/tugways/chrome/tide-permission-dialog.test.ts` — 34 pass / 0 fail.
- [x] `bun test` — full suite green: 2586 pass / 0 fail / 9674 expects / 158 files (no regression from Step 1's baseline).
- [x] `bun run audit:tokens lint` — zero violations.
- [x] Manual HMR: trigger a permission prompt (`Bash` requiring approval); verify Allow / Deny *paths* and the *recorded state* render identically to pre-migration. *(Verified by user in live session. The `space-between` actions-row layout reads correctly as Mac HIG opposed-choices; functional paths and recorded-state visual unchanged.)*

---

#### Step 3: Migrate `QuestionDialog` onto `TideInteractiveDialog` {#step-3}

**Depends on:** #step-1

**Commit:** `refactor(tugways): QuestionDialog composes on TideInteractiveDialog`

**References:** `[D01]` new primitive, `[D02]` cancel semantics, `[D03]` cancel button visual, `[D08]` input-form scope, (#audit-current-state)

**Artifacts:**
- Edits to `chrome/tide-question-dialog.tsx`, `chrome/tide-question-dialog.css`.

**Tasks:**
- [x] Swap `TugInlineDialog` for `TideInteractiveDialog` (import + JSX open + JSX close).
- [x] Drop the local `.tide-question-dialog .tug-inline-dialog-actions { justify-content: space-between }` block from `tide-question-dialog.css` — the primitive owns it now. Frame-width override (`--tugx-question-frame-width: 700px`) kept. A short comment in the CSS records *why* the local override is gone (cross-reference to `[D03]` + the primitive's CSS rule).
- [x] *(Bonus)* Dropped the explicit `cancelRole="danger"` prop from the JSX — that is now the family default that `TideInteractiveDialog` supplies. Omitting it is the cleaner expression: the dialog gets the family vocabulary without restating it.
- [x] Verify the measurement helper for layout stability still works — component-local, untouched. The hidden measurement wrapper (`tide-question-dialog-measure`) lives in the `children` slot the primitive passes through verbatim.
- [x] Verify Cancel still resolves to `session.popInteractive()` (Step 0 already updated this) — `handleCancel` body is unchanged; the chrome swap does not perturb the callback.
- [x] Update module docstring: cross-references `TideInteractiveDialog` as the direct composition target ([D01] / [D08]); the stale **"Skip"** paragraph (which described the old `respondQuestion({})` cancel behaviour) is replaced with the current **"Cancel ≡ Esc ≡ `popInteractive`"** paragraph naming `[D02]` and the wire round-trip. `[L20]` line acknowledges the two-layer composition.

**Tests:**
- [x] Existing `tide-question-dialog.test.ts` cases still pass without modification (38 pass / 0 fail / 50 expects).
- [x] No new tests added — the migration is semantics-preserving and the existing pure-helper tests cover the public surface.

**Checkpoint:**
- [x] `bun x tsc --noEmit` — clean (exit 0).
- [x] `bun test src/components/tugways/chrome/tide-question-dialog.test.ts` — 38 pass / 0 fail.
- [x] `bun test` — full suite green: 2586 pass / 0 fail / 9674 expects / 158 files (no regression).
- [x] `bun run audit:tokens lint` — zero violations.
- [x] Manual HMR: a real AskUserQuestion flow with multi-question payload; verify wizard rail, auto-advance, Cancel button (`popInteractive`), Esc (`popInteractive`) all behave identically to pre-migration. *(Verified by user in live session: the migration itself works; wizard rail, auto-advance, and the family cancel gesture all behave correctly.)*

**Discovered-and-fixed during HMR review — body-slot ordering bug.** The user surfaced a layout problem present *before* this plan started: in `cards/tide-card-transcript.tsx`, the assistant-cell body mounted `permissionSlot` and `questionSlot` at fixed positions *near the top* of the body, above `TranscriptToolCalls` and `TugMarkdownBlock`. So when the AI emitted Bash + text + `AskUserQuestion`, the dialog appeared at the *top* of the cell with the tool output and text streaming in *below* it — inverted from conversational order.

- [x] *(First pass.)* Reordered the body JSX so the slots sit at the *end* of the cell. Sufficient for QuestionDialog (questions naturally belong at the end of an assistant turn — after the text that introduces them), but **insufficient for PermissionDialog** — the user's follow-up HMR showed the `Bash — Allowed` record sitting at the bottom of the cell with the assistant's prose commentary between it and the Bash tool block. The user's rule: *"This tool approval should appear immediately below the tool call. Nothing else should be able to weasel its way in there."*
- [x] *(Second pass — the architecturally correct fix.)* Threaded permission entries into the tool stream by `tool_use_id`. The wire ships `control_request_forward` frames with a `tool_use_id` field (verified against the v2.1.x stream-json catalog and the `ControlRequestForward` index signature — the SDK has carried it since 2.1.104), so a permission record always knows which tool block it gates.
  - In `tide-card-transcript.tsx`: split the old `permissionSlot` `ReactNode` output into two: a `ReadonlyMap<tool_use_id, ReactNode>` keyed by `tool_use_id`, and a defensive `orphanPermissions` array for entries that arrive without the field. Stable `EMPTY_PERMISSION_MAP` / `EMPTY_PERMISSION_ARRAY` sentinels are reused on every empty render so `useSyncExternalStore`'s `Object.is` check skips no-op re-renders.
  - In `tide-card-transcript-tool-calls.tsx`: accept `permissionByToolUseId?: ReadonlyMap<...>` on both Static and Streaming props; in `ToolCallsList`, after each rendered tool block, look up the matching node and render it as the immediate sibling within the same flex column. A tool block with no matching permission stays as a bare `Component`; a tool block with a permission renders inside a `React.Fragment` keyed by `toolUseId` so the pair reconciles as one unit.
  - In the body JSX: `permissionSlot` removed; `orphanPermissions` rendered at the body foot as a defensive fallback (typically empty); `questionSlot` stays at the foot (questions naturally belong at the end of the cell).
- [x] Slot keys (`request.request_id` on the permission node; `toolUseId` on the wrapping Fragment) preserve React-reconciliation mount identity (`[L26]`) across pending → resolved → recorded transitions of the permission UI.
- [x] Added a multi-paragraph comment above the body documenting the conversational-order rule + the inline-permission-threading rule, so future readers see both baked into the layout.

**Third pass during HMR review — unify the two post-interaction records.** With the layout now correct, the *visual* divergence between the two recorded surfaces became the next problem: PermissionDialog's recorded view was a custom button + chevron + "expand to see more" affordance (vintage scaffolding from a permission-only era), while AskUserQuestionToolBlock's recorded view was already a clean `ToolWrapperChrome`-based card. The user's read: *"They look similar but are different enough for no good reason. The disclosure feels silly; the always-expanded Q&A feels right."*

- [x] PermissionDialog's recorded branch now composes on `ToolWrapperChrome` — the same chrome the `AskUserQuestionToolBlock` recorded view uses. Both records read as siblings of the same family.
- [x] Dropped the chevron + click handler + `recordExpanded` `useState` + the `[data-collapsed]` / `[data-state="resolved"]` / `[data-decision]` DOM-attribute machinery. The record is always visible (no toggle); the body is intentionally empty (the gated tool block one position above already carries the input context — the Bash command, the file diff, the file path).
- [x] Replaced `composePermissionRecordSummary` (the old `"{Tool} — Allowed"` string composer) with `recordedPermissionPresentation` — a tiny pure helper that returns `{label: "Allowed"|"Denied"|"Resolved", icon: ReactNode}` for the chrome's `toolName` + `toolIcon` + `argsSummary` slots. Test coverage updated (the existing `composePermissionRecordSummary` describe block is replaced by a `recordedPermissionPresentation` describe block with one extra case pinning that each decision picks its own icon node).
- [x] CSS: dropped the entire `--tugx-perm-record-*` / `--tugx-perm-collapse-*` / `--tugx-perm-focus-ring` / `--tugx-perm-record-detail-pad` token family and every `.tide-permission-dialog-record-*` rule. The file went from ~187 lines to ~70 — most of it was scaffolding for the disclosure pattern. Two small rules remain (`.tide-permission-dialog-inline-icon` for the inline Shell glyph and `.tide-permission-dialog-reason` for the muted reason span — both used inside the *pending* dialog's description). Added one new rule: `.tide-permission-dialog-record-status[data-decision]` tints the decision word (success/danger) to match the lucide icon paired with it in the chrome header.
- [x] Updated the module docstring and `[L20]` cross-reference to name the new composition path: *pending* → `TideInteractiveDialog` → `TugInlineDialog`; *recorded* → `ToolWrapperChrome`. This component itself now contributes only the small inline-icon + reason fragments.

**Fourth pass — status-chip vocabulary.** With the chrome unified, the next snag was the `argsSummary` text both records carried — `4 of 4 answered` and `Allowed` / `Denied` rendered as mono-styled prose (inherited from the chrome's default `argsSummary` font family). The user's read: *"The monospace looks a little goofy."*

- [x] Both records now render their status text through `TugBadge` (`emphasis="tinted"`, `size="sm"`) inside the chrome's `argsSummary` slot. The badge owns its own padding, colour, and typography — no mono prose.
- [x] Roles per the family vocabulary: `action` for the AskUserQuestion question-count chip (neutral progress indicator); `success` for an allowed permission; `danger` for a denied permission; `action` for the out-of-band `Resolved` fallback.
- [x] `recordedPermissionPresentation` helper grew a third field (`badgeRole`) so the role is pinned by the same contract that picks the label and icon. The test cases assert the role mapping alongside label + icon.
- [x] Dropped the `.ask-user-question-tool-block-args` CSS rule (mono font + muted colour) — the badge owns its own styling.
- [x] Dropped the `.tide-permission-dialog-record-status[data-decision]` colour tints — the badge handles success / danger tone via its role token vocabulary, not the dialog's own CSS.

**Fifth pass — HMR survival.** Experimenting with badge sizes/styles surfaced a real defect: *the recorded chrome did not survive Vite's Fast Refresh.* When `PermissionDialog` / `QuestionDialog` reloaded, their recorded views fell out of the rendered tree.

Root cause: the slot computations in `tide-card-transcript.tsx` (`permissionByToolUseId`, `orphanPermissions`, `questionSlot`) memoised the React *elements* themselves. Each cached element carries the `Component` reference returned by `dispatchRenderInput` at the time the `useMemo` last ran. When Fast Refresh swaps the component function for a new one, the cached element's `type` still points at the *old* function — so React renders the stale version, and Fast Refresh can't remount the chrome to apply the edit. `TranscriptToolCalls` doesn't have this problem because it calls `dispatchToolCallState` *inline inside its `map()`* every render, always picking up the latest reference.

- [x] Refactored: the lightweight `SlotEntry[]` derivation stays inside `useMemo` (keyed on the data sources — `isCommitted` / `turn` / `controlRequestLog` / `pendingApproval`), but the React-element construction now runs **every render** in a plain `forEach` over the memoised entries. Same pattern for the question slot: `if (!isCommitted && pendingQuestion !== null) { ... }` inline, no `useMemo` over the element.
- [x] Added a stable `EMPTY_PERMISSION_ENTRIES` sentinel so the empty-case `useMemo` return preserves `Object.is` identity and the fast-path branch skips map/array allocation.
- [x] Added an explanatory comment block in `tide-card-transcript.tsx` so future readers see the **HMR contract** baked in: *"caching React elements inside `useMemo` would freeze the `Component` reference returned by `dispatchRenderInput`."* Same rule applies any time `dispatchRenderInput` or `dispatchToolCallState` is called from a memoised context.

---

#### Step 3.5: Drop the recorded permission chrome (JSONL has no durable record to reconstruct) {#step-3-5}

**Depends on:** #step-3

**Commit:** `refactor(tugways): drop recorded permission chrome — JSONL lacks a durable record`

**References:** `[D10]` asymmetry is load-bearing, (#investigation-asymmetry, #step-3)

##### Why this step exists {#step-3-5-context}

After the Step 3 visual-unification work, the user surfaced the real architectural defect underneath the polish: **the recorded permission chrome was not actually durable**. It survived neither full app relaunch nor a Developer Reload — once the in-memory store was rebuilt from JSONL on cold boot, `turn.controlRequests` came back empty and the chrome had nothing to render. The HMR-survival fix in the Step 3 fifth pass addressed *React-element caching* but did nothing for the underlying data-loss case, because the data itself was only ever populated by the live `respondApproval` action, never by replay.

An earlier draft of this step (titled "Persist permission decisions via JSONL replay derivation") proposed a `tool_result`-text inference under a `pendingApproval !== null` gate. That draft was based on a load-bearing wire-shape claim that turned out to be wrong: **`control_request_forward` is not in the JSONL transcript.** A re-verification of the JSONL corpus (see updated `#investigation-asymmetry`) confirmed:

- The `control_request_forward` frame is synthesised on the live wire by `tugcode/src/session.ts:2807` from the SDK's `can_use_tool` control request. No JSONL writer touches it. Across every JSONL in `~/.claude/projects/*/`, the `"type"` field's value is always one of `assistant` / `user` / `system` / `tool_use` / `tool_result` / etc. — never `control_request_forward`.
- The reducer's `pendingApproval` state is set only by `handleControlRequestForward`, which itself only accepts the live phases (`streaming` / `tool_work` / `awaiting_first_token` / `submitting`) — `replaying` is excluded.
- The replay translator (`tugcode/src/replay.ts`) has no `control_request_forward` / `can_use_tool` code path. It translates `assistant` / `user` JSONL entries into `tool_use` / `tool_result` / `assistant_text` / `tool_use_structured` frames and nothing else.

Together those three facts mean `pendingApproval` is **always `null` during replay**. The gated-only inference the earlier draft proposed could never fire on cold boot, so the recorded chrome would never come back. The draft was a no-op feature with a passing test suite.

##### What signals JSONL actually has — and why "allow" can't be reconstructed {#step-3-5-signal-landscape}

The wire signals that survive into JSONL for a permission flow:

- **Deny.** The tool_result lands with `is_error: true` and `content` carrying the SDK's literal rejection text (the verified opener `"The user doesn't want to proceed with this tool use"` plus the suffix `"The tool use was rejected"` — see `#investigation-asymmetry`'s SDK denial-text pattern subsection; 124 samples across all surveyed JSONLs). The entry-level `toolUseResult: "User rejected tool use"` field also lands.
- **Allow.** The tool runs and the tool_result carries the tool's actual output. **There is no wire signal that distinguishes a gated-and-allowed tool from an ungated tool.** Their post-decision shapes are byte-identical: a normal `tool_result` for that `tool_use_id` with `is_error: false` and the tool's real output. The allow click never enters JSONL; the gating decision never enters JSONL; nothing distinguishes "the user explicitly approved this Bash" from "this Bash was auto-approved by an allowlist rule."

The recorded permission chrome's job was to show which gated tool was allowed vs. denied. For denials we *can* recover that information by reading the tool_result text. For allows we *cannot*. The recorded chrome is therefore a feature that **cannot be delivered durably** for both decisions.

##### The user-visible decision {#step-3-5-decision}

The user-visible rule the team committed to in Step 3 was: *content the user has already seen does not get pulled away on a boundary*. The only way to satisfy that rule for the recorded permission chrome — given the wire reality above — is to **not render it in the first place**. Once a decision is made, the dialog vanishes. No badge. No record. No trace. The tool block alone carries the user-visible story.

This is symmetric and honest:

- **Allow click.** `respondApproval({decision: "allow"})` fires; reducer clears `pendingApproval`; `PermissionDialog` sees `isPending === false` and returns `null`; the tool runs normally; the tool block renders its output. No badge, no recorded chrome, no entry in transcript history.
- **Deny click.** `respondApproval({decision: "deny"})` fires; reducer clears `pendingApproval`; `PermissionDialog` returns `null`; the SDK lands a `tool_result` with `is_error: true` carrying the rejection text; the existing tool block renders the failed call with error styling and the SDK's literal text. No separate "Denied" chrome — that would be redundant signal and would re-introduce the same asymmetry Step 3.5 set out to close (since the chrome can't survive cold boot for allows, an asymmetric "deny-only" chrome would have the same durability problem in mirror form).
- **HMR / Developer Reload / cold-boot relaunch.** Identical end-state regardless of boundary: only the tool block survives, with its `is_error` styling and content. Visual continuity is exact, because the data backing it (`turn.toolCalls`) is durable in JSONL.

The live PermissionDialog (the *pending* interactive surface — where the user clicks Allow or Deny) **stays**. It's the input form. Only the post-decision recorded chrome is removed.

##### Why we don't try harder to keep "Denied" badges {#step-3-5-symmetric}

A "Denied" record would (a) live in the same `controlRequestLog → turn.controlRequests` path we're removing because it can't durably restore allows, (b) require the same persistence machinery we're tearing out, and (c) be redundant signal — the tool block already carries `is_error: true` plus the SDK's literal rejection text in its prose. An allow-less / deny-only chrome would mean: a user who denied a Bash would see a record on relaunch; a user who allowed the *same* Bash would see nothing. That asymmetry was the problem Step 3.5 was created to close in the first place. Symmetric absence is the honest answer.

##### What gets removed {#step-3-5-removals}

| Layer | What goes |
|---|---|
| Reducer state | `state.controlRequestLog: ControlRequestRecord[]` |
| `TurnEntry` | `controlRequests` field |
| Types | `ControlRequestRecord` (no remaining consumer) |
| Reducer writes | The `controlRequestLog: [...state.controlRequestLog, record]` write in `handleRespondApproval`; the `record: ControlRequestRecord` it built |
| Reducer projection | The `controlRequests: state.controlRequestLog` projection in `buildTurnEntry` |
| Reducer resets | Every `controlRequestLog: []` initializer / reset (initial state, `handleReplayStarted`, every per-turn reset site in `handleTurnComplete`, mid-turn transport-lost commit, etc. — found at the lines that appear in the existing `grep` of `controlRequestLog` over `reducer.ts`) |
| `PermissionDialog` component | The recorded-state branch (the entire `isPending === false` render path); the `recordedPermissionPresentation` helper; the `decision` `useState`; the `ToolWrapperChrome` composition for the recorded path; the `TugBadge` chip for the decision word |
| `PermissionDialog` CSS | The `.tide-permission-dialog-record-*` rules; the `[data-decision]` rule on the recorded chrome's status span. The two pending-state fragments (`.tide-permission-dialog-inline-icon`, `.tide-permission-dialog-reason`) stay |
| `PermissionDialog` tests | The `recordedPermissionPresentation` describe block; the recorded-chrome assertions; any case that pinned the `decision` `useState` transition |
| `tide-card-transcript.tsx` | `permissionByToolUseId`, `orphanPermissions`, `EMPTY_PERMISSION_MAP`, `EMPTY_PERMISSION_ARRAY`, the body-foot orphan-permission render, the inline-permission-threading doc-comment block, the `controlRequestLog` / `pendingApproval` reads that fed the slot computation |
| `tide-card-transcript-tool-calls.tsx` | The `permissionByToolUseId?: ReadonlyMap<...>` prop on Static and Streaming variants; the per-tool-block matching-permission render inside `ToolCallsList` (the `React.Fragment` keyed by `toolUseId` collapses back to the bare `<Component>`) |
| `code-session-store.control-forward.test.ts` | The two cases that pinned `turn.controlRequests` writes (the synthetic-allow "commits the answered permission into TurnEntry.controlRequests" and the empty-permissions companion) are removed; the `test-11` deny replay's `turn.controlRequests[0]` assertions are removed (the test keeps its outbound-frame and phase-restoration assertions — those exercise the wire-side commitment, which is what survives) |

The live `respondApproval` action still fires its `tool_approval` wire frame — that's how the SDK is told what to do with the gated tool. Only the *client-side* `controlRequestLog` accumulator is being removed.

##### Artifacts {#step-3-5-artifacts}

- `tugdeck/src/lib/code-session-store/reducer.ts`
- `tugdeck/src/lib/code-session-store/types.ts`
- `tugdeck/src/components/tugways/chrome/tide-permission-dialog.tsx`
- `tugdeck/src/components/tugways/chrome/tide-permission-dialog.css`
- `tugdeck/src/components/tugways/chrome/tide-permission-dialog.test.ts`
- `tugdeck/src/components/tugways/cards/tide-card-transcript.tsx`
- `tugdeck/src/components/tugways/cards/tide-card-transcript-tool-calls.tsx`
- `tugdeck/src/lib/code-session-store/__tests__/code-session-store.control-forward.test.ts`
- Reducer doc-comments around `handleRespondApproval`, `handleTurnComplete`, and the `CodeSessionState` field block formerly describing `controlRequestLog`.

##### Tasks {#step-3-5-tasks}

- [x] **Reducer state surgery.** Remove `controlRequestLog` from `CodeSessionState`; remove the write in `handleRespondApproval`; remove the `controlRequests: state.controlRequestLog` projection in `buildTurnEntry`; remove every `controlRequestLog: []` initializer / reset (initial state, `handleReplayStarted`, `handleTurnComplete` branches, transport-lost commit, etc.). Update doc-comments accordingly.
- [x] **Types surgery.** Remove `ControlRequestRecord` from `code-session-store/types.ts`; remove `controlRequests` from `TurnEntry`. Verify no remaining consumer via `grep`.
- [x] **PermissionDialog component surgery.** Drop the recorded-state branch entirely — the component now returns `null` whenever `isPending === false`. Remove the `decision` `useState`, the `recordedPermissionPresentation` helper, the `ToolWrapperChrome` import + composition for the recorded path, the `TugBadge` chip for the decision word. Update the module docstring to say the component is pending-only.
- [x] **PermissionDialog CSS surgery.** Drop the `.tide-permission-dialog-record-status[data-decision]` rule. Keep `.tide-permission-dialog-inline-icon` and `.tide-permission-dialog-reason` (still used by the pending dialog's description). Update the file docstring's `@tug-pairings` block to reflect that the recorded-chrome composition pair is gone.
- [x] **PermissionDialog tests surgery.** Drop the `recordedPermissionPresentation` describe block; drop any assertion about the recorded chrome's render output, the decision `useState`, or the recorded chrome's data-attributes.
- [x] **`tide-card-transcript.tsx` surgery.** Drop the `permissionByToolUseId` `ReadonlyMap` derivation, the `orphanPermissions` array, the `EMPTY_PERMISSION_MAP` / `EMPTY_PERMISSION_ARRAY` / `EMPTY_CONTROL_LOG` sentinels, the body-foot orphan-permission render, the doc-comment block about inline permission threading, and the `controlRequestLog` data-source read (its only consumer was the recorded-record half that's going away). Replace the inline-threaded machinery with a simple `permissionSlot` body-foot render driven by `pendingApproval` — mirrors `questionSlot` (built every render to survive HMR; renders `null` when no live pending request). Both slots live at the body foot; only one is ever non-null because the SDK only opens one control_request_forward at a time. The `questionSlot` stays untouched.
- [x] **`tide-card-transcript-tool-calls.tsx` surgery.** Drop the `permissionByToolUseId?: ReadonlyMap<string, ReactNode>` prop from both Static and Streaming variants; drop the per-tool-block matching-permission render inside `ToolCallsList`. The `React.Fragment` keyed by `toolUseId` collapses back to the bare `<Component key={toolUseId} … />` it was pre-Step-3. The pending permission dialog renders at the cell body foot via the new `permissionSlot` (see above), not inline with the tool block.
- [x] **`code-session-store.control-forward.test.ts` surgery.** Remove the two synthetic-allow cases that pinned `turn.controlRequests` writes (the "commits the answered permission" and "commits an empty controlRequests" cases). Trim the `test-11` deny-replay case to drop the `turn.controlRequests[0]` block — keep its outbound `tool_approval` frame assertion and the `prevPhase`-restoration assertion (those exercise the wire and reducer-phase commitments, which survive).
- [x] **Investigation-asymmetry update.** Already landed in this revision: Finding 2 expanded to cover the full out-of-band scope, Finding 2.a added for the SDK denial-text pattern, Finding 3's "Where the record lives" row updated. Confirm the prose still tracks the implementation after the Step 3.5 surgery.
- [x] **Code-search guardrails.** `grep -r controlRequestLog tugdeck/src` → empty. `grep -r ControlRequestRecord tugdeck/src` → empty. `grep -r recordedPermissionPresentation tugdeck/src` → empty (only inert docstring reference in `tide-permission-dialog.test.ts` explaining the removal). `grep -r controlRequests tugdeck/src` → only inert occurrences (docstrings in `tide-question-dialog.tsx` and `control-forward.test.ts` that explicitly explain the removal); no live type / property references.

##### Tests {#step-3-5-tests}

- [x] `tide-permission-dialog.test.ts` continues to pass on the pending-dialog assertions (the `recordedPermissionPresentation` cases are removed, not migrated). Net test-count delta: lower (by the dropped recorded-chrome cases); no green case turns red.
- [x] `code-session-store.control-forward.test.ts` continues to pass on its outbound-frame and phase-restoration assertions (the `turn.controlRequests` assertions are removed, not migrated). Net delta: lower.
- [x] No new tests added in this step — Step 3.5 is a feature *removal*, and the existing pure-helper coverage on the pending dialog is the right shape for what remains.

##### Checkpoint {#step-3-5-checkpoint}

- [x] `bun x tsc --noEmit` — clean.
- [x] `bun test` — full suite green: **2580 pass / 0 fail / 9654 expects / 158 files** (Step 3 baseline was 2586; the 6-case delta matches the 4 dropped `recordedPermissionPresentation` cases plus the 2 dropped `turn.controlRequests` cases in `control-forward.test.ts`).
- [x] `bun run audit:tokens lint` — zero violations.
- [x] Code-search guardrails (per `#step-3-5-tasks`) all empty.
- [x] Manual HMR: trigger an Allow flow — dialog disappears, tool runs, tool block renders output. Save an unrelated `.tsx` to trigger Fast Refresh; the post-decision state is unchanged (because there is no fragile recorded chrome left to lose). *(Verified by user post-Step-3.5 + interrupt-marker fix.)*
- [x] Manual HMR: trigger a Deny flow — dialog disappears, tool block renders with error styling + SDK rejection text. Same Fast Refresh test: state is unchanged. *(Verified by user.)*
- [x] Manual Developer Reload: identical end-state on both allow and deny — only the tool block survives, with its content unchanged. *(Verified by user.)*
- [x] Manual relaunch: fully quit Tide, re-launch on the same session. Visual continuity is exact: tool blocks (allow→output; deny→error band + rejection text) render from the JSONL-durable `turn.toolCalls`. No "missing chrome" gap, no false records. *(Verified by user. Pending-dialog survival across relaunch is descoped per `[D15]` — a different concern.)*

---

#### Step 4: `AskUserQuestionToolBlock` vocabulary alignment + "wrapper" prose cleanup {#step-4}

**Depends on:** #step-3

**Commit:** `chore(tugways): align AskUserQuestionToolBlock and replace wrapper prose with tool block`

**References:** `[D04]` status icons, `[D05]` progress indicators, `[D06]` salvage scope, `[D11]` tool-block vs wrapper prose, (#audit-current-state)

**Artifacts:**
- Possible minor edits to `cards/tool-wrappers/ask-user-question-tool-block.tsx` / `.css`.
- Prose updates in tugdeck docstrings / doc-comments where "wrapper" was used to describe `*ToolBlock` components.

**Tasks:**
- [x] Review the tool block's icons against `[D04]`. Streaming returns `null`; the answered state uses CSS `::before` `"→"` glyph prefixes on answer lines. `[D04]` governs *status* indicators (Check / Circle / CircleDot / ChevronRight / Loader2 — "state-of-item" icons). An answer-line bullet is closer to a list marker than a status icon, and the same `→` also appears in the salvaged-answer **text payload** posted back to the assistant via `composeSalvagedAnswerMessage` (line 345) — splitting the rendering into "icon here, text there" would create inconsistency without a real win. Leaving as text glyph.
- [x] Review the salvage path's `Cancel` and `Send answers` buttons against `[D03]`. Already aligned: Cancel is `outlined` / `danger` at the leading edge; Send answers is `filled` / `action` at the trailing edge; Mac-HIG separation.
- [x] Confirm the salvage banner uses the shared `--tugx-block-tone-caution-*` band. Confirmed — `--tugx-askquestion-salvage-banner-bg` aliases `var(--tugx-block-tone-caution-bg)` and `-color` aliases `var(--tugx-block-tone-caution-color)`.
- [x] Verify the tool block's `null`-while-streaming behaviour remains correct after Step 3. Verified — `if (status === "streaming") return null;` at line 415 is intact, and after Step 3.5 the live `QuestionDialog` still renders via the body-foot `questionSlot`, so the lifecycle handoff (dialog while pending → tool block once `ready`/`error`) is preserved.
- [x] Prose audit. Replaced "tool wrapper" / "tool-wrapper" with "tool block" / "tool-block" where the prose described a `*ToolBlock` component or the tool_use/tool_result rendering concept. Touched 16 files across `tool-wrappers/` (read-tool-block, middle-ellipsis-path, tool-wrapper-chrome `.tsx` + `.css`, types.ts), `body-kinds/` (path-list-block, diff-block, agent-transcript-block `.tsx` + `.css`, file-block, terminal-block, search-result-block), and the dispatch / transcript / gallery cross-references (`tide-assistant-renderer-dispatch.ts`, `tide-card-transcript-tool-calls.tsx`, `tide-card-transcript.tsx`, `gallery-tool-block-file.tsx` + `.css`, `gallery-registrations.tsx`, `tug-list-view.css`). Bare "wrapper" / "wrapping" left alone per the explicit rule (preserves legit uses like "thin wrapper on Radix", "wrapping chrome region"). Component / symbol / class-name / data-slot / directory-path references all left alone per `[Q06]` (`ToolWrapperChrome`, `DefaultToolWrapper`, `registerToolWrapper`, `resolveToolWrapper`, `TOOL_WRAPPER_REGISTRY`, `tool-wrapper-path`, `./tool-wrappers/`, etc.).

**Tests:**
- [x] Existing `ask-user-question-tool-block.test.ts` cases still pass without modification.

**Checkpoint:**
- [x] `cd tugdeck && bun x tsc --noEmit` — clean.
- [x] `cd tugdeck && bun test` — full suite green: **2580 pass / 0 fail / 9654 expects / 158 files** (matches Step 3.5 baseline; no regressions).
- [x] `cd tugdeck && bun run audit:tokens lint` — zero violations.
- [x] Manual HMR: trigger a normal AskUserQuestion (success path) and a validation-error AskUserQuestion (salvage path); verify both render in the family's visual vocabulary. *(Verified by user.)*

---

#### Step 5: Integration checkpoint {#step-5}

**Depends on:** #step-2, #step-3, #step-3-5, #step-4

**Commit:** `N/A (verification only)`

**References:** `[D01]` new primitive, `[D02]` cancel semantics, `[D09]` rename, `[D10]` asymmetry load-bearing, (#success-criteria, #step-3-5)

**Tasks:**
- [x] Verify both dialog surfaces (Permission, Question) compose on `TideInteractiveDialog`. Verified by grep: both `chrome/tide-permission-dialog.tsx` and `chrome/tide-question-dialog.tsx` import `TideInteractiveDialog`; PermissionDialog keeps a `import type { TugInlineDialogOption }` (type-only — the option contract still lives on `TugInlineDialog`); no direct `TugInlineDialog` component imports.
- [x] Verify Cancel == Esc == `popInteractive` across the family per `[D02]` (with PermissionDialog `Deny` exemption per `[Q03]`). Verified — QuestionDialog's Cancel calls `session.popInteractive()`; PermissionDialog's `Deny` keeps its `respondApproval({decision: "deny"})` semantics with `cancelRole="action"`; Esc reaches `popInteractive` via the responder chain on both surfaces. The salvage UI's local-dismiss carve-out is unchanged.
- [x] Cross-check pure-logic tests across all four files (`tide-permission-dialog`, `tide-question-dialog`, `tide-interactive-dialog`, `ask-user-question-tool-block`) — every case green; net test count reflects the Step 3.5 removals.
- [x] Cross-check the visual chrome on each surface via HMR. *(Verified by user across Steps 0–4.)*
- [x] **Continuity checkpoint** (`#step-3-5`): with a permission decided live (both Allow and Deny variants), fully quit and re-launch Tide on the same session. The post-decision state on cold boot is identical to the post-decision live state: Allow → only the tool block, rendering the tool's output; Deny → only the tool block, with `is_error` styling and the SDK's rejection text. No "missing chrome" gap. HMR / Developer Reload behave identically. Content the user has already seen does not get pulled away on any boundary. *(Verified by user post-Step-3.5 + interrupt-marker fix.)*
- [x] `grep -r peelNewest tugdeck/src` — empty (rename complete).
- [x] `grep -r controlRequestLog tugdeck/src` — empty (Step 3.5 removal complete).
- [x] `grep -r ControlRequestRecord tugdeck/src` — empty (Step 3.5 removal complete).
- [x] `grep -ri 'tool wrapper\|tool-wrapper' tugdeck/src --include='*.tsx' --include='*.ts'` — only `ToolWrapperChrome` / `DefaultToolWrapper` / `tool-wrapper-chrome` / `default-tool-wrapper` / `tool-wrapper-path` / `registerToolWrapper` / `resolveToolWrapper` / `TOOL_WRAPPER_REGISTRY` symbol-name references and `./tool-wrappers/*` directory-path references remain (all out of scope per `[Q06]`). Four prose hits I missed in Step 4 (`layout-tree.ts`, `tide-assistant-renderer-dispatch.ts:215`, `gallery-registrations.tsx` card title, `reducer.ts:1178`) cleaned up here; `gallery-registrations.test.ts` updated to match the new "File Tool Blocks" card title.
- [x] Quick SDK-shape sanity check: across the full project JSONL corpus, **0** `permission_request` / `permission_decision` / `control_request_forward` / `tool_approval` frames found (the wire-reality premise of `#step-3-5` still holds); **102** AskUserQuestion `tool_result` entries carry `"User has answered your questions: …"` text (asymmetry still load-bearing per `[D10]`); **182** denied `tool_result` entries match the verified `"The user doesn't want to proceed with this tool use."` opener (still useful for log-level inspection, even though Step 3.5 is no longer inferring decisions from it).

**Tests:**
- [x] Aggregate: full `bun test` suite green — **2580 pass / 0 fail / 9654 expects / 158 files**. No regressions.
- [x] `bun run audit:tokens lint` — zero violations.

**Checkpoint:**
- [x] `cd tugdeck && bun x tsc --noEmit` — clean.
- [x] `cd tugdeck && bun test` — full suite green.
- [x] `cd tugdeck && bun run audit:tokens lint` — zero violations.
- [x] HMR-verified live flows on Permission (allow + deny — recorded chrome removed per Step 3.5), Question (multi-question wizard + Cancel + Esc + Submit), AskUserQuestion validation salvage. *(Verified by user across Steps 0–4.)*

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A `TideInteractiveDialog` input-form primitive that `PermissionDialog` and `QuestionDialog` both compose on. `session.popInteractive()` replaces `peelNewest` at every callsite. "Wrapper" replaced by "tool block" in tugdeck prose. Family vocabulary (icons, lifecycle states, cancel gesture) consistent across the two surfaces.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [x] `session.popInteractive()` exists; `session.peelNewest()` does not.
- [x] `TideInteractiveDialog` ships at `tugways/tide-interactive-dialog.tsx` with module docstring, pure-logic test, CSS file.
- [x] `PermissionDialog` uses `TideInteractiveDialog` for its pending input-form chrome and returns `null` once the decision is made; existing pending-side tests pass; the recorded-chrome tests are removed per Step 3.5.
- [x] `QuestionDialog` uses `TideInteractiveDialog` for its pending input-form chrome; existing tests pass unchanged; the local actions-row CSS override is gone.
- [x] Cancel ≡ Esc ≡ `popInteractive` on QuestionDialog and the salvage UI (PermissionDialog's `Deny` exempt per `[Q03]`).
- [x] Prose audit: no instance of "tool wrapper" / "tool-wrapper" used to describe `*ToolBlock` components in tugdeck docstrings / doc-comments (bare "wrapper" / "wrapping" intentionally preserved per the rule).
- [x] **Symmetric continuity across boundaries** (`#step-3-5`): Allow and Deny decisions both leave a single, JSONL-durable artifact behind — the tool block (with output on allow; with `is_error` + SDK rejection text on deny). HMR, Developer Reload, and full app relaunch all reproduce that artifact from `turn.toolCalls` data with no false records, no missing-chrome gaps, and no asymmetric drift between decisions.
- [x] `controlRequestLog` / `ControlRequestRecord` / `turn.controlRequests` removed from `code-session-store` per Step 3.5 (`grep -r` confirms empty).
- [x] Open questions `[Q01]`, `[Q02]` resolved; `[Q03]` resolved during Step 2; `[Q05]`, `[Q06]` recorded as deferred follow-ons.
- [x] Tests + audit-tokens lint + tsc all green.

**Acceptance tests:**
- [x] `cd tugdeck && bun test` — full suite green.
- [x] `cd tugdeck && bun x tsc --noEmit` — clean.
- [x] `cd tugdeck && bun run audit:tokens lint` — zero violations.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [x] `[Q06]` — `ToolWrapperChrome` → `ToolBlockChrome`, `DefaultToolWrapper` → `DefaultToolBlock`, plus the full mechanical cascade (`ToolWrapperProps/Factory/Status`, `registerToolWrapper`, `resolveToolWrapper`, `TOOL_WRAPPER_REGISTRY`, `_resetToolWrapperRegistryForTests`, every `tool-wrapper-*` kebab slot/class, the `default-tool-wrapper.*` file pair, the `tool-wrapper-chrome.*` file pair, and the `tool-wrappers/` directory → `tool-blocks/`). Tuglaws prose + theme-token comments also updated.
- [ ] `[Q05]` — revisit salvage-path generalisation when a second concrete callsite emerges.
- [ ] Persistent/updatable todo list facility (the work pulled out of the original "Interactive Surfaces" framing). Separate plan.

| Checkpoint | Verification |
|------------|--------------|
| `peelNewest` rename complete | `grep -r peelNewest tugdeck/src` → empty |
| `TideInteractiveDialog` extracted | `grep -l TideInteractiveDialog tugdeck/src/components/tugways/*.tsx` returns the primitive file |
| PermissionDialog migrated | `tide-permission-dialog.tsx` imports `TideInteractiveDialog` and does NOT import `TugInlineDialog` directly |
| QuestionDialog migrated | Same shape for `tide-question-dialog.tsx` |
| "Wrapper" prose cleaned | `grep -ri 'tool wrapper\|tool-wrapper' tugdeck/src --include='*.tsx' --include='*.ts' --include='*.md'` — only component-name references remain |

---

### Addendum: Mid-Flight Survival {#addendum-mid-flight-survival}

Steps 0–5 nailed the input-form primitive and the JSONL-grounded asymmetry. Live HMR worked. But the Developer > Reload boundary surfaced a deeper class of bug after the phase landed: a dialog open at the moment of reload disappeared (and in the worst case the entire session binding too), violating the "content the user has already seen never gets pulled away" invariant the Step 3.5 continuity checkpoint already pinned.

Three fixes shipped post-phase to close that gap (commits `4c294be7` and `c48c8db4`):

- **Binding survives reload of an in-flight first turn.** `tugcast::do_list_card_bindings` emits `is_alive` per binding from its in-memory supervisor `SpawnState`; the client gate widens to `turn_count > 0 || is_alive` so `mode=resume` fires even when the in-flight turn hasn't committed yet. Without this, the gate took the `mode=new` branch and orphaned the live session.
- **Pending dialog rehydrates on reload.** `tugcode::emitInflightTurnFromActiveTurn` synthesizes a `tool_use` + `control_request_forward` pair from each pending `can_use_tool` entry on resume. The reducer accepts `control_request_forward` during `replaying` (stash only, no phase transition); `handleReplayComplete` lands in `awaiting_approval` with `prevPhase: "tool_work"` when a dialog was rehydrated, so the subsequent live `tool_result` post-Allow has a populated `toolCallMap` entry to land in (no dangling spinner).
- **Dev-mode session-id badge in Z4B** for diagnostic continuity across reload — label `Session: <first 8 chars>`, full id in `title`, ghost-styled to match the existing Z4B vocabulary.

That work closed the live-dialog hole — but uncovered three new ones surfaced during continued user testing:

1. **Answered question state does not survive HMR / Developer > Reload.** A user mid-way through a multi-question wizard loses every selection and the cursor position on any boundary. Per `[L23]`, selection / form-control values / content payloads are user data — they MUST be preserved.
2. **No survival across `Tug.app` relaunch — by design, per `[D15]`.** A request submitted with a pending Permission or Question dialog at the moment of `Tug.app` quit is gone on relaunch; the JSONL shows an unresolved tool_use the user can re-issue. App quit is a deliberate user gesture and not part of the survival contract (`[D14]` narrowed, `[D15]` policy). `[Q07]` documents the underlying SDK reality (no `can_use_tool` re-emit on `--resume`) but doesn't drive an implementation step.
3. **Turn telemetry resets on reload.** The status bar's `TIME`, `TOKENS`, and `CONTEXT` drop to `0m 00s / 0 / 12.6K / 1.00M` post-reload even when the in-flight snapshot delivered the assistant text and dialog correctly. The user loses sight of where the turn was costing-wise mid-stream.

**Strategy.** Tighten the survival contract for the two boundaries the user did not deliberately cross. Reload (HMR + Developer > Reload) — Step 6 closes the `[L23]` gap on question-dialog answers. Step 7 is the investigation that resolved `[Q07]` (NO — claude does not re-emit `can_use_tool` on `--resume`) and the policy crystallized into `[D15]`: app quit terminates in-flight dialogs, so Step 8 is descoped. Step 9 is the telemetry sibling: extend the in-flight snapshot to carry the current cost / usage tuple, still entirely within the reload survival horizon.

#### New Open Questions {#addendum-open-questions}

#### [Q07] Does `claude --resume` re-issue `can_use_tool` for an unresolved tool_use in the loaded JSONL? (RESOLVED — NO) {#q07-sdk-resume-can-use-tool}

**Question:** When `Tug.app` quits with a Permission / Question dialog open and re-launches, the session is restored via `claude --resume <session_id>`. JSONL on disk should contain the user message + the assistant message ending with `stop_reason: "tool_use"` (the assistant message finalizes before the tool runs — claude does not wait for the tool_result to flush). Does the SDK, on resume, recognize the un-resolved tool_use and re-issue the `can_use_tool` control_request so tugcode can re-forward the dialog?

**Why it matters:** The answer determines the architecture of Step 8.
- **YES**: the resume mechanism is sufficient; the only client-side change is widening the binding gate to fire `mode=resume` for "JSONL ends with an unresolved tool_use" — similar in shape to `is_alive` but derived from the JSONL parse rather than the in-memory supervisor.
- **NO**: tugcode must persist `pendingControlRequests` to sqlite on each `set` / `delete` and rehydrate the map on startup; the existing `emitInflightTurnFromActiveTurn` then runs unchanged once the spawn lands.

**Resolution: NO.** The SDK does not re-emit `can_use_tool` on `--resume`.

The investigation used a minimal 3-line JSONL matching the Claude Code 2.1.150 wire shape — `summary`, `user` ("Run `echo hello` …"), and `assistant` with `stop_reason: "tool_use"` carrying a `Bash` `tool_use` content block, no subsequent `user` / `tool_result` line. That's the on-disk state you would see if `Tug.app` quit while a permission dialog was open.

Running the same `claude --resume <id> --print --output-format stream-json --input-format stream-json --include-partial-messages --replay-user-messages --permission-prompt-tool stdio` incantation tugcode uses, two stdin scenarios were observed:

- *Idle stdin*: zero bytes on stdout. claude reads the conversation history, then exits cleanly without emitting any frame on its own initiative — no `system init`, no `control_request`, nothing. The SDK does not auto-act on resume.
- *One `{"type":"user","message":{...,"text":"ping"}}` frame on stdin*: claude emits the standard `system init` → `stream_event message_start` → `text_delta` `"p" / "ong"` → `result subtype: success` flow. The pending `tool_use` from JSONL is *not* surfaced. Neither a `can_use_tool` control_request nor any other reference to the unresolved Bash appears in the transcript. claude treats the unresolved `tool_use` as historical context only, then runs a fresh turn against the new user message.

This matches the in-tree understanding: `session.ts:2980` notes "Control requests are an out-of-band SDK channel — they never land in JSONL." The current `emitInflightTurnFromActiveTurn` re-synthesizes the dialog from tugcode's in-memory `pendingControlRequests` map. On Developer > Reload tugcode survives and the map is intact — that's why Step 5's fix worked. On app relaunch tugcode is killed and the map is gone.

**Why this doesn't drive a Step 8 implementation.** The NO answer originally implied a sqlite mirror of `pendingControlRequests` to survive the quit / relaunch boundary. We deliberately declined to build it — see `[D15]`. App quit is a user-initiated terminal action; the in-flight dialog is dropped, the assistant's tool_use sits in JSONL as a visibly-unresolved turn the user can re-issue. Step 8 is descoped to a one-line policy note.

#### New Design Decisions {#addendum-design-decisions}

#### [D13] In-flight survival is a three-layer contract; each scope owns its own mechanism (DECIDED) {#d13-survival-layering}

**Decision:** Three distinct survival mechanisms operate at three different scopes, and they MUST stay separate:

- **Wire-level continuity (tugcode)** — `emitInflightTurnFromActiveTurn` is the single source of truth for "what does a freshly-connected tugdeck see when it resumes a session." The snapshot synthesizes the in-flight turn's frames (`user_message_replay`, `assistant_text`, `tool_use`, `control_request_forward`, `cost_update`) so the reducer rebuilds an equivalent runtime state.
- **Reducer-level reconciliation (tugdeck `code-session-store`)** — replay-phase handlers (`handleControlRequestForward`'s `replaying` branch, `handleReplayComplete`'s `awaiting_approval` post-bracket landing) interpret the snapshot into the final post-resume state.
- **Per-component user data (the component itself)** — local component state (mid-flight question selections, salvage-form text, etc.) survives via `[L23]`'s A9 protocol (`useComponentStatePreservation` / `useSavedComponentState` / `CardStateBag`).

**Rationale:**
- Mixing these collapses concerns. The reducer should not know about per-question answers; the QuestionDialog should not know about replay brackets; tugcode should not know about `CardStateBag`.
- `[L23]` already pins this for non-Tide components (`tug-radio-group`, `tug-accordion`). Applying the same protocol to QuestionDialog's `selections` / `visited` / `currentIndex` aligns the dialog family with the rest of tugdeck.
- The seam is sharp: tugcode emits the wire-level snapshot, the reducer commits the post-resume state, and the component restores its own UI from the bag — three layers, three responsibilities.

**Implications:**
- Step 6 (the `[L23]` fix) is local to `tide-question-dialog.tsx`. No reducer change. No tugcode change.
- Steps 7–8 (relaunch survival) and Step 9 (telemetry) live at the wire / reducer layer. They do NOT touch `[L23]`.
- A future "save the dialog scroll position" requirement also lives in the A9 protocol, not in the snapshot.

#### [D14] HMR + Developer > Reload are the survival horizon for in-flight dialogs; app relaunch is not (DECIDED — narrowed) {#d14-relaunch-as-resume}

**Decision:** The system guarantees that an open Permission / Question dialog survives HMR and Developer > Reload (Steps 5 + 6). App quit / relaunch is *not* part of that contract — see `[D15]`. The user quit; the in-flight dialog terminates with the process. On the next launch the JSONL shows the unresolved tool_use as a visibly-incomplete turn, and the user re-issues if they still want the action.

**Rationale:**
- Reload (HMR or Developer > Reload) is a process-internal boundary the user did not ask for — the system owes them continuity across it. tugcode survives those boundaries with the `pendingControlRequests` map intact; that's why Step 5's wire-level rehydration was sufficient.
- App quit is a user-initiated terminal action. The honest cost / benefit reading is in `[D15]`: persisting a tugbank mirror of `pendingControlRequests` to recover from a deliberate quit is real bookkeeping cost (domain naming, deletion semantics, rehydrate ordering, leak guards) against a marginal UX gain the user can recover from with one re-issue.
- The investigation in `[Q07]` confirmed that recovering across relaunch would require that mirror (the SDK does not re-emit `can_use_tool` on `--resume`). We chose not to.

**Implications:**
- Steps 5 + 6 close the reload survival contract; the wire-level rehydration in `emitInflightTurnFromActiveTurn` handles tool dialogs and the QuestionDialog's `[L23]` A9 opt-in handles answer state.
- Step 8 is descoped (anchor retained). Step 9 (in-flight telemetry on resume) still belongs at the wire layer because it lives entirely within the reload horizon.
- An earlier draft of this decision framed relaunch as "just a wider-horizon reload" with symmetric architecture. That framing was wrong: relaunch is a *different class* of boundary because it crosses a deliberate user gesture, not just a process restart.

#### [D15] App quit terminates in-flight dialogs; the user re-issues (DECIDED) {#d15-quit-terminates}

**Decision:** When `Tug.app` quits with a Permission or Question dialog open, the dialog is dropped. On relaunch the user sees the assistant turn as it landed in JSONL — an `assistant` message ending in `stop_reason: "tool_use"` with no following `tool_result`. The user re-issues the prompt if they still want the action.

**Rationale:**
- The user initiated the quit. The system does not owe them recovery across a gesture they performed deliberately.
- The JSONL state is itself the signal: a visible tool_use with no result reads as "this didn't finish" without any additional UI affordance.
- The persistence layer needed to do better (`[Q07]` NO → tugbank-mirror of `pendingControlRequests` with set / delete / rehydrate-before-replay) is a meaningful chunk of code that has to stay correct forever. The same code budget spent elsewhere (telemetry, prompt UX, the actual conversation experience) returns more.
- HMR / Developer > Reload are different — those boundaries are *not* user-initiated, and tugcode's in-memory state survives them. That's why Step 5 (wire rehydration) and Step 6 (`[L23]` A9 on the dialog) are worth their cost.

**Non-implications:**
- This is not a license to drop user data on lesser boundaries. Reload still preserves the dialog; the answer state still preserves the wizard tuple; the conversation transcript still survives. Only the *deliberate quit* boundary is the terminating one.
- This does not preclude a future "graceful pre-quit hook that synthesizes an interrupt" (would tidy the JSONL by adding a deny-equivalent tool_result), but that is a polish item, not a survival requirement.

**Cross-link:** `[Q07]` resolution paragraph "Why this doesn't drive a Step 8 implementation" points here.

#### Addendum Execution Steps {#addendum-execution-steps}

#### Step 6: QuestionDialog answer-state survival via `[L23]` A9 protocol {#step-6}

**Depends on:** `#step-3` (QuestionDialog migration), `#addendum-mid-flight-survival`

**Commit:** `feat(tugways): QuestionDialog preserves answer state via L23 A9 protocol`

**References:** `[L23]` user data must be preserved across boundaries, `[D13]` survival layering, `tug-radio-group.tsx:211` reference pattern, `tug-accordion.tsx:246` reference pattern, [card-state-model.md](../tuglaws/card-state-model.md), [state-preservation.md](../tuglaws/state-preservation.md)

**Tasks:**
- [x] Define a `QuestionDialogPreservedState` interface capturing the three local-state fields: `selections: string[][]`, `visited: boolean[]`, `currentIndex: number`. (Shapes already pinned in the component; the interface just gives them a name on the wire.)
- [x] Derive a preservation key from `request.request_id`. A NEW request mounts fresh; the SAME request rehydrates its in-progress state. The key namespace must be Question-dialog-scoped (e.g. `question-dialog/<request_id>`) so it does not collide with other components.
- [x] Pull saved state via `useSavedComponentState<QuestionDialogPreservedState>(key)` inside the dialog component.
- [x] Seed `selections`, `visited`, and `currentIndex` from the saved state when present, else use the existing initializers. Keep the initializers pure; the rehydration arm is a single conditional branch.
- [x] Register a capture callback via `useComponentStatePreservation` that returns the current `{ selections, visited, currentIndex }` tuple.
- [x] Update the module docstring to cite `[L23]`, `[D13]`, and the new preservation contract.

**Tests:**
- [x] Pure-logic test: passing a saved-state snapshot through the component's seed path produces the expected initial `selections` / `visited` / `currentIndex` tuple.
- [x] Pure-logic test: capture callback's output round-trips through the seed path (encode-then-decode is the identity).
- [x] HMR vetted by user: mid-wizard, edit an unrelated CSS file. Selections persist; the current row stays focused; scroll position holds.
- [x] Developer > Reload vetted by user: mid-wizard (some questions answered, not yet submitted), reload. Same row is current, same options are selected, wizard count reflects the prior progress.

**Checkpoint:**
- [x] `bun test` green.
- [x] `bun x tsc --noEmit` clean.
- [x] `bun run audit:tokens lint` zero violations.
- [x] User-verified HMR + Developer > Reload across the multi-question wizard.

---

#### Step 7: Investigate SDK resume behavior for unresolved `tool_use` (`[Q07]`) {#step-7}

**Depends on:** `#step-3-5` (asymmetry investigation methodology)

**Commit:** `N/A (investigation only — outputs annotate [Q07] resolution)`

**References:** `[Q07]` SDK resume behavior, `[D14]` relaunch-as-resume, `tugcode/src/replay.ts` (existing JSONL parse path)

**Tasks:**
- [x] Capture a JSONL fixture at the exact mid-permission moment: start a session, submit a request that triggers a Bash permission, leave the dialog open without Allow/Deny, copy `~/.claude/projects/<encoded-dir>/<session_id>.jsonl` to a fixture path under the repo. *(Synthesized — see [`q07-evidence/synthesize-fixture.py`](q07-evidence/synthesize-fixture.py); a synthesized fixture matching the Claude Code 2.1.150 wire shape is functionally equivalent because the SDK's resume behavior is shape-driven.)*
- [x] Verify the fixture contains:
  - The user message
  - The assistant message ending with `stop_reason: "tool_use"` and a `tool_use` content block
  - NO `user` message with `tool_result` content (because the user never approved)
- [x] Spawn `claude --resume <session_id>` against the captured project dir manually (no tugcode in the loop). Observe whether claude re-issues the `can_use_tool` control_request on stdout. Document the observation in `[Q07]`. *(Both idle-stdin and ping-stdin runs captured under `q07-evidence/`; no `can_use_tool` emission in either.)*
- [x] Resolve `[Q07]` to YES or NO with concrete evidence (JSONL excerpt + observed re-issue or absence thereof) in the resolution block. *(Resolved NO.)*
- [x] Based on the resolution, sketch the Step 8 plan: **NO branch chosen.** Step 8 prose updated inline.

**Tests:**
- [x] N/A — investigation step.

**Checkpoint:**
- [x] `[Q07]` resolved with concrete evidence.
- [x] Step 8 plan committed inline with the right architecture branch.

---

#### Step 8: Permission / Question dialog survives `Tug.app` relaunch — DESCOPED {#step-8}

**Status:** DESCOPED per `[D15]`. App quit is a deliberate user action; the in-flight dialog terminates with the process. On relaunch the user sees the assistant turn in JSONL ending with an unresolved `tool_use` (no following `tool_result`) and re-issues if they still want the action. The reload survival contract — Steps 5 + 6 — remains in force.

The anchor `#step-8` is retained so existing references resolve. The cross-link reading is `[D14]` (narrowed) + `[D15]` (the policy). `[Q07]` documents the SDK behavior that would have driven the sqlite-mirror approach we declined to build.

---

#### Step 9: In-flight turn telemetry survives reload {#step-9}

**Depends on:** `#step-6` (the `[L23]` fix establishes the survival pattern), `#addendum-mid-flight-survival`

**Commit:** `fix(tide): in-flight cost / usage snapshot on resume`

**References:** `[D13]` survival layering — telemetry lives at the wire layer, `[L23]` no user-visible state lost on a boundary, `tugcode/src/session.ts:1111` (`lastMessageDeltaUsage`), `tugcode/src/session.ts:1118` (`lastMessageStartUsage`), `tugcode/src/session.ts:885` (`streamingUsageFrame` helper), `tugdeck/src/lib/code-session-store/reducer.ts` `handleStreamingUsage`.

**Frame choice (reconsidered from the original task wording).** The plan originally specified `cost_update`. On closer reading, `streaming_usage` is the cleaner fit — it's purpose-built for live intra-turn token display, drives `liveTurnUsage` (the very field the status bar's TOKENS / CONTEXT cells read mid-turn), and the reducer's `handleStreamingUsage` is already phase-tolerant. `cost_update` would have required faking `total_cost_usd: 0` / `num_turns: 0` / `duration_ms: 0` until the live `result` event lands; those fake zeros would briefly flash in any UI reading `lastCost`. Going with `streaming_usage` avoids the shim entirely.

**Tasks:**
- [x] Extend `emitInflightTurnFromActiveTurn` to synthesize a `streaming_usage` IPC frame using the best-available in-flight usage from `lastMessageDeltaUsage ?? lastMessageStartUsage`. Reuse the existing `streamingUsageFrame` helper (`session.ts:885`) which already gates on a non-empty `msg_id` and a `usage` carrying at least one of the four token fields — a turn the bracket fired against before `message_start` revealed a usage tuple stays quiet rather than emitting an all-zero frame.
- [x] Order: the frame lands AFTER `assistant_text` and BEFORE `tool_use` / `control_request_forward` so the reducer's `liveTurnUsage` is populated before the dialog renders.
- [x] Pin the wire order in `replay-hmr-mid-stream.test.ts` (four new tests: emit on delta-usage, fallback to start-usage, omit when no usage observed, order vs. assistant_text / tool_use / control_request_forward).
- [x] Reducer-side: `handleStreamingUsage` is already phase-tolerant (no phase check in the dispatch or the handler body). Pinned with a new test in `reducer.streaming-usage.test.ts` so a future regression that adds a phase guard surfaces.

**Tests:**
- [x] tugcode test: pending tool_use + `lastMessageDeltaUsage` populated → snapshot emits a `streaming_usage` with the usage tuple in the documented position.
- [x] Reducer test: in-flight `streaming_usage` during the replay bracket updates `liveTurnUsage` and `sessionInitTokens` regardless of phase.

**Checkpoint:**
- [x] User-verified: pre-reload status bar shows X tokens / Y context; Developer > Reload; post-reload status bar shows approximately the same X / Y (within rounding — the live `result` event will land with the precise number when the turn completes).
- [x] `bun test` green; `audit:tokens lint` zero violations.

---

#### Addendum Acceptance Criteria {#addendum-acceptance}

- [x] `[Q07]` resolved with documented SDK behavior evidence (Step 7, resolution paragraph inline).
- [x] QuestionDialog `selections` / `visited` / `currentIndex` survive both HMR and Developer > Reload (`[L23]` compliance verified by user — Step 6 commit `484fb3ad`).
- [x] Pending Permission / Question dialog *survival across `Tug.app` relaunch* deliberately descoped per `[D15]` — quit terminates the in-flight dialog; the user re-issues. Anchor `#step-8` retained for cross-references.
- [x] Post-reload status bar shows non-zero `TOKENS` / accurate `CONTEXT` reflecting the in-flight turn's usage estimate. *(Step 9 commit.)*
- [x] All earlier mid-flight survival behavior (Developer > Reload tool block continuity, no dangling spinner post-Allow) remains intact — no regressions on the work shipped in commits `4c294be7` and `c48c8db4`. *(Verified continuously across Steps 6 and 9.)*

---

### Plan Closeout {#closeout}

**Status: CLOSED — 2026-05-23.**

The plan started as a refactor (`TideInteractiveDialog` primitive unifying `PermissionDialog` and `QuestionDialog`'s pending input-form chrome) and grew an addendum mid-flight when reload survival gaps surfaced. Both phases are now shipped.

**Original phase (Steps 0–5):** `session.popInteractive` replaced `peelNewest`; `TideInteractiveDialog` shipped as the family primitive; `PermissionDialog` and `QuestionDialog` migrated; Step 3.5 dropped the recorded permission chrome once JSONL's wire reality made the asymmetry honest; Step 4 finished the "wrapper" → "tool block" prose audit; Step 5 was the integration checkpoint. `[D08]` (asymmetry load-bearing) and `[D10]` (no parallel `controlRequests` accumulator) are the load-bearing decisions of this phase.

**Survival addendum (Steps 6–9):** Step 5 + 6 close the **reload survival contract** (HMR + Developer > Reload). Wire-level rehydration in `emitInflightTurnFromActiveTurn` covers the dialog; the QuestionDialog opts into the `[L23]` A9 protocol for in-progress answer state; the in-flight token snapshot (`streaming_usage`) keeps the status bar's TOKENS / CONTEXT cells continuous across the bracket. `[D13]` (three-layer survival contract — wire / reducer / per-component) is the load-bearing decision of this phase.

**Deliberately out of scope:** Step 8 (app-quit / relaunch survival of pending dialogs) is descoped per `[D15]` — quit is a deliberate user action, the JSONL's visibly-unresolved tool_use IS the signal, the user re-issues. `[D14]` was narrowed to make that policy explicit.

**Follow-ons (named, not blocked):**
- `[Q05]` salvage-path generalisation — revisit at the second concrete callsite.
- Persistent / updatable todo list facility — separate plan.

**Shipped commits, mid-flight survival arc:**
- `4c294be7` fix(tide): survive Developer > Reload mid-dialog
- `c48c8db4` fix(tide): rehydrate pending tool_use on reload, restore phase to tool_work
- `05955cb2` plan(tide-dialogs): add mid-flight survival addendum
- `484fb3ad` feat(tugways): QuestionDialog preserves answer state via L23 A9 protocol (Step 6)
- `c79de775` plan(tide-dialogs): close [Q07] NO; descope Step 8 per [D15] (Step 7)
- `8cc2c345` fix(tide): in-flight cost / usage snapshot on resume (Step 9)

No further work in this plan. Future regressions on the survival behaviors above should re-read `[D13]` / `[D14]` / `[D15]` before re-litigating the architecture.
