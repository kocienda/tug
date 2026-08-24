<!-- devise-skeleton v4 -->

## AI Configuration — one chip, one mixer sheet {#ai-configuration}

**Purpose:** Collapse the Session card's four AI-configuration chips (Claude Code / Mode / AI Model / Effort) and three picker sheets into **one composite `AI` chip** and **one Layouts-style mixer sheet** that configures model, reasoning effort, and permission mode as a single OK/Cancel transaction — and collapse the Swift Session menu's ten configuration rows to four.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-08 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The Session card's Z4B row carries four chips for one concern — how the AI runs: `CLAUDE CODE` (`session-route-indicator-badge.tsx`), `MODE` (`permission-mode-chip.tsx`), `AI MODEL` (`model-chip.tsx`), and `EFFORT` (`effort-chip.tsx`). Each of the last three opens its own confirm-style picker sheet (`usePermissionSheet` in `permission-mode-chip.tsx`, `useModelPicker` in `model-picker-sheet.tsx`, `useEffortPicker` in `effort-picker-sheet.tsx`), all three built from the same `TugSheet` + `TugListView` recipe and all mounted on the card's single sheet host (`cardPickerSheet = useTugSheet()`, session-card.tsx). The Swift Session menu mirrors the same fragmentation: a Permission Mode submenu with four mode items plus Cycle, then AI Model…, Reasoning Effort…, Permission Rules… — ten rows for the one thought.

Under the chrome this is already almost one feature: all three settings read from one store (`SessionMetadataStore`), write through three parallel `use*` hooks (`use-model.ts` / `use-effort.ts` / `use-permission-mode.ts`), and persist to three parallel tugbank domains. What is fragmented is only the presentation. This phase collapses the presentation layer while leaving the store, the write hooks, the wire protocol, and the persistence domains in place — plus one small tugcode fix the transaction semantics surfaced (see [P04]).

#### Strategy {#strategy}

- Build bottom-up: pure helpers first ([P03] diff logic, summary formatting), then the tugcode `currentModel` fix ([P04]), then the sheet, then the chip, then the wiring swap, then the menu collapse, then deletions.
- The mixer sheet is the **Layouts idiom**: labeled rows of `TugChoiceGroup` segments (the exact component `layouts-section.tsx` composes — no extraction needed, it is already a shared `Tug*` component), a live composite caption up top, one description line below, OK/Cancel commit ([P02]).
- Nothing hits the wire until OK; OK diffs the pending triple against the open-time baseline and emits the minimal frame sequence ([P03]).
- The existing set paths survive unchanged as the write layer: `useModel().setModel`, `useEffort().setEffort`, `usePermissionMode().setMode` — the sheet calls them through an injected commit callback, so the Settings defaults context can inject `DefaultsMetadataAdapter` store writes instead ([P09]).
- The Swift menu keeps only what a menu is for: one `AI: <summary>…` door with a dynamic title, the no-look Cycle Permission Mode chord, and Add Working Directory… ([P07]).
- Delete at the end, in one step, after every consumer has moved — the deletions are the proof the collapse is complete.

#### Success Criteria (Measurable) {#success-criteria}

- The Z4B Code-route chip cluster renders exactly one AI-configuration chip (`data-slot="ai-chip"`); `model-chip`, `effort-chip`, `permission-mode-chip`, and `session-route-indicator-badge` no longer exist in the tree (verify: app-test asserts the new chip and the absence of the old slots).
- Opening the sheet, changing model + effort + mode, and pressing Cancel sends **zero** frames (verify: unit test on the commit-diff helper + app-test asserting chip values unchanged).
- Changing model + effort together and pressing OK sends `model_change` then `effort_change` (in that order), and the respawned claude carries **both** `--model` and `--effort` (verify: tugcode unit test on `buildClaudeArgs` + the `currentModel` record path).
- A commit whose turn went busy while the sheet was open applies **nothing** — no partial application — raises the idle caution, and leaves the sheet open with its pending values ([P03]) (verify: app-test drives a turn to in-flight with the sheet open, presses OK, asserts the chip unchanged and the sheet still up).
- The model override survives a **fork** and a **continue**, not just an effort respawn ([P04] three call sites) (verify: tugcode unit tests capturing spawn args for all three paths).
- `/model`, `/effort`, `/mode`, and `/ai` all open the one sheet, focused on the named row (`/ai` → sticky row); `/permissions` still opens the rules editor (verify: app-test).
- The Swift Session menu shows `AI: <model · effort · mode>…` (⌃⌘I), `Cycle Permission Mode` (⌃⌥⌘P), `Permission Rules…`, and `Add Working Directory…` where the ten rows were; the AI item dims while a turn is in flight (verify: manual + `computeCommandCapabilities` unit test on the new entry).
- Settings → Session Card → Assistant edits the three deck defaults through the same mixer sheet (verify: manual — pick a default, relaunch a fresh card, observe the seed).
- `bunx vite build` passes; `cd tugrust && cargo nextest run` untouched (no Rust changes); tugcode tests pass.

#### Scope {#scope}

1. New composite `AI` chip (`ai-chip.tsx`) absorbing the model/effort/mode display and the Claude Code chip's drift tick + right-click report popover.
2. New mixer sheet (`ai-config-sheet.tsx`) with three `TugChoiceGroup` rows, live summary caption, hover/cursor description line, disabled-in-place effort coupling, OK/Cancel transaction, and a footer (rules-editor link + Claude Code version/changelog line).
3. Pure helper module (`lib/ai-config.ts`): summary formatting, commit-diff computation, effort clamp rule, sticky-row persistence constants.
4. tugcode: track `currentModel` and re-apply `--model` on **every** spawn path — `spawnClaude`, `handleSessionFork`, `handleSessionContinue` ([P04] — an [L23] repair of a bug that exists today).
5. Slash routes: `/ai` added; `/model` `/effort` `/mode` become deep links into the one sheet; `/permissions` unchanged.
6. Swift Session menu collapse + command-registry updates, including a fifth `dynamicTitle` element on the `SlashBridge` tuple and the `AI: …` title it feeds from a new `aiSummary` field on `MenuStateSessionBlock`.
7. Settings → Assistant reuse via `DefaultsMetadataAdapter`.
8. Sticky last-edited row (`dev.tugtool.ai-config/lastRow`).
9. Deletion of the four superseded components and the three superseded sheets.

#### Non-goals (Explicitly out of scope) {#non-goals}

- No new wire messages. `model_change`, `effort_change`, `permission_mode` (tugproto/src/inbound.ts) are reused as-is; a coalesced `ai_config_change` message is a possible later cleanup, not part of this phase.
- No changes to the three tugbank persistence domains (`dev.model/`, `dev.effort/`, `dev.permission-mode/` and their `dev.tugtool.*` deck-default twins) or to the seed/restore logic in the three `use-*` hooks.
- No changes to `SessionMetadataStore` reconciliation, the optimistic-override machinery, or the model catalog (`model-catalog.ts` / `model-picker-data.ts`).
- No change to `Shift+Tab` cycling (⌃⌥⌘P), the `guardTurnIdleForSetting` bulletin, or the permission **rules** editor (`permission-rules-editor.tsx`).
- No keyboard-focus-navigation extensions beyond what the composed components already provide (the focus-walk subsystem is tabled — do not propose chords or ring extensions).

#### Dependencies / Prerequisites {#dependencies}

- `TugChoiceGroup` (tugdeck/src/components/tugways/tug-choice-group.tsx) — already shared, supports per-item `disabled`, `focusGroup` registration, deferred keyboard commit; no changes anticipated.
- `TugSheet` host pattern (`useTugSheet().showSheet`) and `PICKER_SHEET_ANCHOR` — reused unchanged.
- tugcode is a compiled binary: after the tugcode step, rebuild before any live verification (`just build-app` refreshes the bundle; app-tests never rebuild the binary on their own).

#### Constraints {#constraints}

- Warnings are errors across the workspace; `bunx vite build` must pass before any tugdeck step is called done.
- All tuglaws apply; see the State Zone Mapping ({#state-zone-mapping}). In particular [L02] (stores via `useSyncExternalStore`), [L06] (hover/preview appearance via DOM attributes, not React state), [L11] (controls dispatch `selectValue` through the responder chain — `TugChoiceGroup` has no `onChange`), [L19]/[L20] (compose `Tug*` components, composed children keep their tokens), [L07] (open-time reads come fresh from the store).
- No `localStorage` — the sticky row persists through tugbank `/api/defaults`.
- App-tests: selective runs via `just app-test-changed`; every new test carries `@covers`.

#### Assumptions {#assumptions}

- The claude CLI accepts the same selector strings for `--model` as for the `set_model` control request (`default` / `sonnet` / `fable` / …) — the selectors are what `model_change` already carries and what the picker rows hold.
- `TugChoiceGroup` segments at `size="xs"` fit five segments of the longest labels ("Accept Edits", "Extra-High") within the sheet width; if a row wraps, it wraps to a second line rather than truncating (CSS `flex-wrap` on the group's container). **Untested — verify visually in Step 3**, where the rows first render; discovering it in Step 4 would mean reopening the sheet after the chip is built on top of it.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows the devise-skeleton v4 conventions: explicit `{#anchor}` headings, `[P##]` plan-local decisions, `[Q##]` open questions, `**References:**` lines citing labels and anchors (never line numbers), and `**Depends on:**` lines using `#step-N` anchors.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Does an effort respawn preserve a prior `set_model` override? (DECIDED) {#q01-respawn-model-loss}

**Question:** When tugcode respawns claude to apply `--effort` (`handleEffortChange`, tugcode/src/session.ts), does the resumed process keep a model previously set via the `set_model` control request?

**Why it matters:** The sheet commits model + effort as one transaction; if the respawn drops the model, the transaction silently half-applies.

**Resolution:** DECIDED (see [P04]). Spike finding: `spawnClaude` builds args via `buildClaudeArgs` with `permissionMode`, `effort: this.currentEffort`, and `additionalDirectories` — but **no `model`**, even though `buildClaudeArgs` already supports a `config.model` → `--model` flag. tugcode tracks no model state at all (`handleModelChange` only forwards `set_model` to the live process). So in `--session-id` re-create mode the model override is definitely lost, and in `--resume` mode it depends on claude's session-state restoration, which the plan does not rely on. [P04] makes tugcode track `currentModel` explicitly, which resolves the question regardless of claude's behavior.

**Second spike finding (call-site census):** `spawnClaude` is **not** the only `buildClaudeArgs` caller. `handleSessionFork` and `handleSessionContinue` build their arg arrays directly (they pass `continue: true`, which `spawnClaude`'s `session-id`/`resume` shape cannot express), and each re-applies `effort: this.currentEffort` by hand. A fix that touches only `spawnClaude` therefore leaves fork and continue dropping the model exactly the way every respawn drops it today. [P04] patches all three, and folds the shared fields into one helper so the next flag cannot be missed the same way.

#### [Q02] What happens to the pending effort when the pending model doesn't support it? (DECIDED) {#q02-effort-clamp}

**Question:** The user selects Extra-High, then clicks Sonnet (which per the capability data omits `xhigh`). What is the pending effort now?

**Resolution:** DECIDED (see [P05]): the pending effort clamps to the nearest supported level at or below it in canonical `EFFORT_LEVELS` order (else the lowest supported level); if the pending model supports no effort at all, the pending effort becomes none and the row disables whole. The clamp is a pure function in `lib/ai-config.ts` with unit tests.

#### [Q03] Where does the Claude Code version line live in the defaults context? (DECIDED) {#q03-defaults-footer}

**Resolution:** DECIDED: the sheet footer (rules-editor link + version line) renders only in the session context. The Settings → Assistant instance omits the footer entirely — there is no session cwd for rules and no live version to report.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Model row overflows one segment line when the catalog grows | low | med | group container allows wrap to a second line; catalog is 5 rows today | catalog exceeds ~6 selectors |
| `--model <selector>` rejected by a future claude on respawn | med | low | tugcode skips the flag for `default`/null; selector strings come from claude's own capability list | respawn spawn-failure logs |
| Chip width churn from composite label | low | low | `TugStableOverlay` sizing against widest composition ([P01]) | visual QA |
| Menu title too wide with long model names | low | med | one-line revert to static `AI…` (drop the `dynamicTitle` resolver, keep everything else) | visual QA on the menu |

**Risk R01: Transaction ordering races the respawn** {#r01-transaction-ordering}

- **Risk:** OK sends `model_change` then `effort_change`; the `set_model` control request to the old process races its kill.
- **Mitigation:** tugcode processes inbound frames sequentially; `handleModelChange` records `currentModel` synchronously *before* `handleEffortChange` runs `killAndCleanup`, and the respawn re-applies `--model` from that record ([P04]). The `set_model` forwarded to the doomed process is harmless either way.
- **Residual risk:** none identified — the record, not the control request, is what the respawn reads.

---

### Design Decisions {#design-decisions}

#### [P01] One composite AI chip replaces four (DECIDED) {#p01-composite-chip}

**Decision:** A single `AiChip` (`ai-chip.tsx`, `data-slot="ai-chip"`) with caption `AI` and a value line of the form `Fable 5 · High · Auto` (model · effort · mode) replaces `SessionRouteIndicatorBadge`, `PermissionModeChip`, `ModelChip`, and `EffortChip` in the Z4B Code-route cluster (session-card.tsx, the block currently rendering the four chips with `SESSION_CYCLE_ORDER_CLAUDE_CODE/MODE/MODEL/EFFORT`).

**Rationale:**
- The four chips are one concern; four chips + three sheets is chrome, not information.
- The Claude Code chip was never a picker — its value (version) and diagnostics (drift) survive as chip adornments and sheet-footer content ([P10]).

**Implications:**
- Value resolution reuses the existing single-path helpers, byte-identical to today: model via `resolveModelLabel(snapshot.model, knownModelRows(snapshot.models, readModelCatalog()))` (`model-label.ts`); effort via `resolveEffortDisplay(...)` + `formatEffortLabel` (`effort.ts`) — the effort token is **omitted entirely** (not `-`) when `display.supported` is false; mode via `resolvePermissionMode(live, persisted)` + `formatPermissionMode` (`permission-mode.ts`), with the same per-card `useTugbankValue(PERMISSION_MODE_DOMAIN, cardId, …)` pre-population fallback `PermissionModeChip` uses today.
- Width-stabilized via `TugStableOverlay` with a single alternate: the widest composition (widest catalog model row title + `Extra-High` + `Accept Edits` joined with ` · `), so value changes never reflow the chip.
- Chip props mirror the old chips: `cardId`, `sessionMetadataStore` (a `ReadableMetadataStore`), `codeSessionStore` (for the drift walk), `onOpenSheet`, `disabled`, `focusGroup`, `focusOrder`. In the defaults context (`DefaultsMetadataAdapter`) `cardId` and `codeSessionStore` are omitted and drift/version render nothing.
- The Z4B cluster shrinks by three focus stops; `SESSION_CYCLE_ORDER_*` constants in session-card.tsx renumber (one `SESSION_CYCLE_ORDER_AI` replaces the four).
- Tooltip: `TugActionTooltip` bound to `` `${TUG_ACTIONS.RUN_SLASH_COMMAND}:ai` `` so the ⌃⌘I chord renders in the hover; content is the exact model id (or the label-with-caveat fallback the model chip shows today) plus drift count when present.

#### [P02] The sheet is a Layouts-style mixer with an OK/Cancel transaction (DECIDED) {#p02-mixer-sheet}

**Decision:** One sheet (`ai-config-sheet.tsx`, hook `useAiConfigSheet`) presented through the card's existing `cardPickerSheet` host (`showSheet({ title: "AI", … , presentation: "rise", bottomAnchorSelector: PICKER_SHEET_ANCHOR })`), containing: a composite summary caption; three labeled rows — MODEL / EFFORT / MODE — each a `TugChoiceGroup` (`size="xs"`, `sidePadding="xs"`) captioned by a `TugLabel` exactly as `layouts-section.tsx` does; a description line; a session-context footer; and the standard `tug-sheet-actions` Cancel/OK row with `persistentDefaultRing` on OK (the pattern of the three current sheet bodies).

**Rationale:**
- All three attributes have ≤5 short-labeled options — the segmented-row idiom that simplified the Lens Layouts section fits exactly, and `TugChoiceGroup` is the mandated composition (never hand-roll; [L19]).
- OK/Cancel earns its keep here specifically because an effort change costs a claude respawn: browsing options must never bounce the process, and transactional commit is what enables the coalescing in [P03].

**Implications:**
- **Options.** MODEL row: `resolvePickerModels(snapshot.models, snapshot.model, readModelCatalog())` read fresh at open time ([L07]); segment labels are the rows' `displayName` (data-driven — a fresh install shows the single honest `Default` from `UNKNOWN_CATALOG_OPTION`). EFFORT row: the five canonical `EFFORT_LEVELS` labels, always all five rendered, with unsupported ones disabled per [P05]. MODE row: `PERMISSION_MODE_MENU` (five modes incl. Bypass) labeled via `formatPermissionMode`.
- **Pending state** is plain `useState` in the sheet body (three values seeded from the open-time baseline), mirroring how the current picker bodies hold their in-sheet selection — dialog-local data, not appearance ([L06] does not apply to the selection itself).
- **Rows dispatch `selectValue`** through the responder chain with stable senders (`ai-config-model` / `ai-config-effort` / `ai-config-mode`); the body hosts one `useResponder` and routes by `event.sender`, the exact shape of `LayoutsSectionBody`'s handler ([L11]).
- **Summary caption** re-renders from the pending triple (same formatting helper as the chip), so it always previews exactly what OK will commit — and it is the same string the chip will show afterward.
- **Description line**: a stack of pre-rendered layers (one per option across all rows, text = the existing subtitle constants: the model rows' `compressContextPhrase(description)`, `EFFORT_SUBTITLES` relocated from `effort-picker-sheet.tsx`, `PERMISSION_MODE_SUBTITLES` relocated from `permission-mode-chip.tsx`), toggled by pointer-over and keyboard-cursor DOM attributes on the `layouts-section.tsx` machinery — a local `previewIdOf` over `[data-choice-value]`, a `MutationObserver` on the rows container watching `data-key-cursor` / `data-key-view-kbd`, `data-*-active` attributes — no React state for the preview ([L06]).
- **The preview resolver is a sibling of `layouts-section.tsx`'s, not a reuse of it.** That one deliberately returns `null` for a segment carrying `data-state="active"`, because in Layouts the "no preview" state means *show the committed plan* and hovering the current answer should not draw a tentative copy of it. This sheet has no committed/tentative duality — a description line has one job, describing whatever the pointer is over — so hovering the already-pending MODE segment must still describe that mode. Reusing the Layouts helper verbatim would instead fall through to the default layer and describe a *different row*. The sheet's copy drops the active-segment bail; everything else is the same shape.
- **The default layer** (nothing hovered, nothing cursored) is the pending selection of the most-recently-changed row; before anything has been changed, it is the pending selection of the row the sheet opened on (`focusRow ?? stickyRow ?? "model"`), so the line is never blank on the first frame.
- **Focus:** each row registers into a sheet-local `focusGroup` (`React.useId()`), orders 0/1/2, Cancel 3, OK 4; `useSeedKeyView` lands the ring on the `focusRow` argument's row (deep-link) or the sticky row ([P06]).
- **Open-time gate:** opening funnels through `guardTurnIdleForSetting` at the call sites (as `/model` and `/effort` do today), noun `"the AI configuration"`.

#### [P03] OK commits the diff as a minimal ordered frame sequence (DECIDED) {#p03-commit-diff}

**Decision:** A pure function `computeAiConfigCommit(baseline, pending)` in `lib/ai-config.ts` returns an **ordered array** of actions (Spec S02); the sheet executes it in array order through an injected `onCommit(actions)` callback. Order and minimality: mode change → one `permission_mode`; model change → one `model_change`; effort change → one `effort_change` (after the model action when both changed, so tugcode's `currentModel` record ([P04]) is set before the respawn). Unchanged attributes contribute nothing; Cancel/Escape emits nothing.

**Rationale:**
- Today changing model then effort costs two dialogs and applies blind; the diff makes the pair one respawn carrying both flags.
- An **array, not a record of optional fields.** The ordering is the load-bearing part of this decision (it is what makes Risk R01 benign), and a record pushes the ordering out of the pure function and into the executor — where it lives in session-card.tsx and cannot be unit-tested. As an array, "mode before model before effort" is a pure-function assertion in Step 1.
- Keeping the executor injected keeps the sheet wire-agnostic, so the Settings defaults context reuses it against plain store writes ([P11]).

**Implications:**
- Session-card executor walks the array and calls the existing single set paths — `model.setModel(selector)`, `effort.setEffort(level)`, `permissionMode.setMode(mode)` — which already handle optimistic reflection, per-card persistence, and the frames. No new send code.
- Baseline capture at open time uses the same resolution the rows use, so "changed" means changed relative to what the sheet displayed as current (for effort, the *effective* level — `snapshot.effort ?? DEFAULT_EFFORT_LEVEL` when supported — matching `useEffortPicker`'s `activeValue` logic, so re-confirming the default never respawns).
- **The guard runs again at OK, not only at open.** Opening funnels through `guardTurnIdleForSetting` ([P02]), but the sheet is a transaction the user can hold open across the start of a turn — and the set paths' seam declines a mid-turn change individually, which would half-apply a two-action commit (model sent, effort refused). So the session-card executor re-runs `guardTurnIdleForSetting("the AI configuration")` **once, before executing the first action**, and returns a refusal when it fails. On refusal the sheet stays open with its pending values intact (the caution says why) rather than closing on a commit that did nothing. All-or-nothing: the guard is checked once for the whole array, never per action.
- The defaults-context executor ([P09]) has no turn to race, so it takes no guard — the refusal hook is a session-context concern the injected executor owns, which is the point of injecting it.

#### [P04] tugcode tracks `currentModel` and re-applies `--model` on live-setting respawns (DECIDED) {#p04-tugcode-current-model}

**Decision:** In tugcode/src/session.ts, add a `private currentModel: string | null = null` alongside `currentEffort`; `handleModelChange` records it (a `"default"` selector records as `null` — the account default needs no flag) before forwarding `set_model`; **every** `buildClaudeArgs` caller passes `model: this.currentModel` (which `buildClaudeArgs` already supports as `config.model` → `--model`).

**Rationale:**
- This is an **[L23]** repair, not a nicety: an internal implementation operation (the respawn tugcode performs to apply `--effort` or `--add-dir`) silently ceases to apply user-visible state (the model the user picked). Today any effort or `/add-dir` respawn after a model change drops the override in `--session-id` re-create mode, and leans on unverified claude session-state restoration in `--resume` mode (spike in [Q01]).
- Makes the [P03] transaction ordering airtight (Risk R01): the record, written synchronously by the first frame, is what the second frame's respawn reads.

**Implications:**
- **Three call sites, not one** ([Q01] second spike). `spawnClaude` covers the effort / `/add-dir` / new-session respawns; `handleSessionFork` and `handleSessionContinue` each build their own arg array because they pass `continue: true`. All three already thread `effort: this.currentEffort` by hand, which is the precedent — and the reason a fourth flag is easy to forget. Fold the four fields the three share (`pluginDir`, `permissionMode`, `effort`, `additionalDirectories`, now plus `model`) into one private `liveSpawnConfig()` accessor and have each caller spread it, so a future flag lands in one place.
- A **fresh** session (`handleNewSession`) inherits `currentModel` too, since it routes through `spawnClaude`. That is the wanted behavior — the session card's mount-restore would re-apply the same selector anyway — but it means "New Session" keeps the model rather than reverting to the account default. Stated so it is a choice rather than a surprise.
- No tugproto change; the inbound allowlist and message shapes are untouched.
- tugcode is a compiled binary — rebuild (`just build-app`) before live verification.
- Unit-test at the `buildClaudeArgs` layer (already exported for tests) plus the record semantics of `handleModelChange`.

#### [P05] Effort coupling renders as disabled segments in place, with a clamp rule (DECIDED) {#p05-effort-disabled-in-place}

**Decision:** The EFFORT row always renders all five canonical levels; selecting a model live-recomputes support via `resolveEffortSupport(models, <pending selector>, readModelCatalog())` and sets `disabled: true` on unsupported segments (`TugChoiceItem.disabled`, which `TugChoiceGroup` already honors in both pointer and keyboard paths). A model with no effort support disables the whole row (`disabled` on the group). When the pending effort becomes unsupported, it clamps per `clampEffortToSupport(pending, supportedLevels)`: nearest supported level at or below in `EFFORT_LEVELS` order, else the lowest supported, else none.

**Rationale:**
- The row keeps its shape (no filtering reflow) and the model↔effort coupling is visible on one screen for the first time — today you discover it across two dialogs.

**Implications:**
- `resolveEffortSupport` takes the *pending* model selector (it already accepts a selector — it resolves via `resolvePickerModels` / `findModelRow`, whose contract is explicitly "a resolved model id, an optimistic display label, or a bare selector"), so no new resolution code.
- **The `default`-collapse case is accepted, and pinned by a test.** `modelIdToSelector` maps any row whose `description` is byte-identical to the `default` row's description back to `default` — mirroring the terminal, which checkmarks "Default" for a session on the account default. So when the catalog carries both a `default` row and an explicit row resolving to the same model, selecting the explicit row resolves to selector `default`, and that is also what the baseline comparison in [P03] sees. Harmless — same model, same supported levels, and a commit that emits nothing is correct when the two selectors name one model — but surprising enough to deserve a Step 1 test rather than a bug report later.
- **The EFFORT group's `value` when the pending effort is `null`.** `TugChoiceGroup` takes a required `value: string`, while [Q02]'s resolution admits a genuine no-level state (a model supporting no effort at all). That state passes `value=""`: no segment matches, so none paints `data-state="active"`, `measureIndicator` returns early on the `findIndex === -1` guard, and the non-animated variant renders no indicator element at all — so an empty value is inert rather than mispainted. The group also carries `disabled` in that state, which is what makes it legible.
- `clampEffortToSupport` is a pure export of `lib/ai-config.ts` with unit tests (resolves [Q02]).

#### [P06] Sticky last-edited row via `dev.tugtool.ai-config/lastRow` (DECIDED) {#p06-sticky-row}

**Decision:** The sheet remembers which attribute the user last actually changed (the last row whose pending value the user moved in a session that ended in OK with that row in the diff) as a deck-level tugbank default: domain `dev.tugtool.ai-config`, key `lastRow`, value `"model" | "effort" | "mode"`. On open with no explicit `focusRow`, keyboard focus seeds on that row; unset defaults to `"model"`.

**Rationale:**
- The user's stated usage: model switches are frequent, effort essentially never — the sheet should open ready for the common edit without reordering anything.

**Implications:**
- Row *order* stays fixed MODEL / EFFORT / MODE regardless of usage — focus memory moves, layout never does.
- Persistence follows the established pattern: `getTugbankClient().setLocalValue(...)` + fire-and-forget `PUT /api/defaults/dev.tugtool.ai-config/lastRow` (the `writePersistedModel` shape in `use-model.ts`); read via `useTugbankValue` with a narrow parser (unknown strings → `"model"`). Constants + parser live in `lib/ai-config.ts`. Deep links (`/model` etc.) override the memory and do **not** write it; only a committed change does.

#### [P07] Swift Session menu: ten rows → four, with a dynamic AI title (DECIDED) {#p07-menu-collapse}

**Decision:** Replace the menu group built in tugapp/Sources/AppDelegate.swift (the Permission Mode submenu + its four mode items + Cycle, and the AI Model… / Reasoning Effort… / Permission Rules… `sessionCommandItem`s) with:

```
AI: Fable 5 · High · Auto…      ⌃⌘I      (id session.ai, command "ai")
Cycle Permission Mode           ⌃⌥⌘P     (moves to the top level, unchanged id session.permissionMode.cycle)
Permission Rules…                         (unchanged — see below)
Add Working Directory…                    (unchanged)
```

**Rationale:**
- The registry gate already pushes per-item `title` (`MenuCommandGate.title`, applied in `validateMenuItem`), so the menu item can carry the same summary as the chip — the menu becomes a state display, not just a door, more than repaying the lost mode checkmarks. If the width reads badly, the revert is one line (drop the `dynamicTitle` resolver).
- Cycle keeps a visible menu home so ⌃⌥⌘P stays discoverable (macOS convention: no chord without a menu item); it must keep its Swift key equivalent literal, since AppKit's scan must own the chord.
- **Permission Rules… stays.** It was on the deletion list because it sits in the same menu band, not because this phase touches it — and the Non-goals say the rules editor is out of scope. Its `SLASH_BRIDGES` row is not just a menu item: `COMMANDS` is also what the keymap UI and the Keyboard Shortcuts sheet enumerate, so removing the row would delete the rules editor from the shortcuts surface too, leaving `/permissions` and the new sheet footer as its only doors. A fourth row is cheap; deleting a door is a touch. "Ten rows → three" becomes **ten → four**, which is the same collapse minus a gratuitous casualty.

**Implications:**
- **Swift:** delete the submenu construction loop, `setPermissionModeFromMenu(_:)`, and the hand-rolled `session.permissionMode` validation case in `validateMenuItem` (it existed only because the submenu parent had no backing command — it dies with the submenu). Add `sessionCommandItem("AI…", "ai", "session.ai")` (static fallback title; the gate's dynamic title overwrites it), move the Cycle item to the top level, and delete the AI Model… / Reasoning Effort… items. `Permission Rules…` and `Add Working Directory…` are untouched.
- **Registry (command-registry.ts):** remove `PERMISSION_MODES` + `PERMISSION_MODE_COMMANDS` (the `set-permission-mode:<mode>` entries and their `state` resolvers existed to power the submenu checkmarks) and their spread into `COMMANDS`; remove the `model` and `effort` rows from `SLASH_BRIDGES` (`permissions` stays); add an `ai` entry with `menuItemId: "session.ai"` and `validate: sessionSettingsChangeable` — note the **gate fix**: today's AI Model… enables on bare `sessionBound` and bounces mid-turn via `guardTurnIdleForSetting` after the fact; the new item gates honestly on `sessionSettingsChangeable`, matching the chip's `!canSubmit` disable. Move the ⌃⌘I binding in `SLASH_BRIDGE_BINDINGS` from `model` to `ai`.
- **`ai` cannot be a plain `SlashBridge` tuple.** The tuple type is `[name, title, menuItemId, validate?]` and `SLASH_BRIDGE_COMMANDS` maps it into a `CommandEntry` with no `dynamicTitle` — there is no slot for one, and `ai` is the first bridge that needs it. **Decision: widen the tuple with a fifth optional element** `dynamicTitle?: (chain) => string | undefined`, spread by the mapper the way `SLASH_BRIDGE_BINDINGS` already is. Widening beats hand-authoring `ai` as a standalone entry beside `cycle-permission-mode`: a standalone entry would have to restate `routing`, `action`, `payload`, and `mirrored` by hand, and the next bridge wanting a live title would face the same fork again.
- The resolver: ``dynamicTitle: (chain) => chain.menu.session?.aiSummary ? `AI: ${chain.menu.session.aiSummary}…` : undefined`` — `undefined` leaves the Swift item's static `AI…` standing, which is the correct fallback before the first push. The `dynamicTitle` hook already exists on `CommandEntry` and is read in `computeCommandCapabilities`.
- **Menu-state plumbing:** add `aiSummary: string` to `MenuStateSessionBlock` (lib/host-menu-state.ts) and to the `CommandMenuFacts` session projection inside `HostMenuStatePublisher.flush`. The publication site is **`cards/use-menu-state-publication.ts`** — the hook that owns the `publishSessionMenuState` call and already computes `permissionMode` through `resolvePermissionMode` with the tugbank fallback — not session-card.tsx. It holds `sessionMetadataStore`, so the summary composes from a snapshot read plus `readModelCatalog()`; all three resolvers are pure and synchronous, so this adds no subscription. **Swift:** add the field to the `MenuState` session-block parser in AppDelegate.swift. (The generic `commands` gate needs no Swift change — title application is already generic.)
- **The menu's effort token reads `snapshot.effort` only**, matching the chip. The hook has a per-card tugbank fallback in scope for *mode* and none for effort — inventing one here would be a second opinion on the chip's value, which is exactly what the shared `resolvePermissionMode` comment in that file warns against.
- **`cycle-permission-mode`** registry entry and the `SET_PERMISSION_MODE` / `CYCLE_PERMISSION_MODE` card handlers in session-card.tsx stay (the action-dispatch `set-permission-mode` registration in action-dispatch.ts may stay as dead-code tolerance or go — remove it, since its only dispatcher was the submenu).
- **`action-vocabulary.ts`:** `SET_PERMISSION_MODE` stays (the card handler remains a valid internal funnel for the cycle path? — no: `cycle` calls `setMode` directly; remove the `SET_PERMISSION_MODE` card handler and vocabulary entry only if nothing else dispatches it — verify with a grep during Step 7 and keep it if the removal cascades; keeping a dead handler is not acceptable, keeping a used one is).

#### [P08] Slash routes: `/ai` canonical, `/model` `/effort` `/mode` deep-link, `/permissions` untouched (DECIDED) {#p08-slash-routes}

**Decision:** Add `{ name: "ai", description: "Configure the AI — model, reasoning effort, permission mode" }` to `LOCAL_SLASH_COMMANDS` (lib/slash-commands.ts). In the session card's `slashCommandSurfaces` map: `ai` → open sheet at sticky row; `model` / `effort` / `mode` → open sheet focused at that row (all four behind `guardTurnIdleForSetting`); `permissions` → `permissionRulesSheet.openRulesSheet()` exactly as today.

**Rationale:**
- Muscle memory preserved; three sheet implementations deleted; `/permissions` already means the rules editor and must not be repointed.

**Implications:**
- The `LocalCommandName` union grows by `"ai"`; the exhaustive `Record` forces the surface wiring at compile time ([D23] pattern already in place).
- `/effort` on an effort-unsupported model still opens the sheet (row disabled, reason visible) — better than today's inert chip no-op.

#### [P09] The sheet works in both contexts through injected reads and writes (DECIDED) {#p09-two-contexts}

**Decision:** `useAiConfigSheet({ sessionMetadataStore, showSheet, onCommit, footer?, cardId? })` — the store is a `ReadableMetadataStore` (so `DefaultsMetadataAdapter` satisfies it), the commit executor is injected ([P03]), and the footer content is a session-context option ([Q03]).

**Implications:**
- Session card: `onCommit` fans out to the three `use-*` set paths; footer renders the rules-editor row (closing the AI sheet and opening `permissionRulesSheet` through the same single host — sequential, never stacked) and the version/changelog line.
- Settings (settings-session-card-body.tsx): the three chips + three picker hooks in the Assistant `TugBox` are replaced by one `AiChip` (defaults flavor) + one `useAiConfigSheet` whose `onCommit` writes `defaultsAdapter.modelStore.set` / `effortStore.set` / `permissionModeStore.set`; no footer. Baseline/pending semantics are identical because the adapter's snapshot carries selector/mode/effort in the same fields.

#### [P10] Drift and version reporting move, not die (DECIDED) {#p10-drift-absorbed}

**Decision:** The AI chip carries the `TriangleAlert` icon + `data-drift` hook when `summarizeDrift({ toolCalls, version })` reports events (the exact computation `session-route-indicator-badge.tsx` runs today, including the narrowed transcript subscription), and right-click opens the same `TugPopover` report (running vs `VALIDATED_CC_VERSION`, event rows). The sheet footer carries `Claude Code <version> · changelog` — the version resolution (`system_metadata.version` → tugbank `dev.tugtool.dev/ccVersion` fallback → `?`), the persist-on-change effect, and the `openUrlInOS(CLAUDE_CODE_CHANGELOG_URL)` click all relocate from the badge.

**Implications:**
- The relocations are transplants: keep `CC_VERSION_DOMAIN`/`CC_VERSION_KEY`, `parseLastKnownVersion`, `persistLastKnownVersion` (move them into the new chip module or a small shared helper — they are currently module-private to the badge). Note the badge lives in `components/tugways/chrome/`, not `cards/`.
- Left-click on the chip now opens the sheet (not the changelog); the changelog's only door becomes the footer link. The drift-report popover keeps right-click.
- **Right-click resolves to the report, and the copy affordance moves into it.** The collision is created by the merge, not inherited: today the badge binds `onContextMenu` to `popoverRef.open()` while `ModelChip` / `EffortChip` / `PermissionModeChip` each bind it to `useCopyableButton`'s copy menu — different chips, no conflict. One chip cannot have both. The report wins the gesture (it is the only door to the drift detail, whereas the summary string is readable on the chip face), and the copy affordance survives as a **row inside the report popover** that copies the composite summary. `useCopyableButton` is therefore **not** used on the AI chip.

#### [P11] Deletions (DECIDED) {#p11-deletions}

**Decision:** After all consumers move: delete `cards/model-chip.tsx`, `cards/effort-chip.tsx`, `cards/model-picker-sheet.tsx` (+ `.css`), `cards/effort-picker-sheet.tsx` (+ `.css`), **`chrome/session-route-indicator-badge.tsx`** (+ `.css` — it lives beside `session-caution-badge.tsx` in `components/tugways/chrome/`, not with the card chips), and from `cards/permission-mode-chip.tsx` the `PermissionModeChip` component, `usePermissionSheet`, and `PermissionModeSheetBody` (+ the file's chip/sheet CSS; if nothing else remains, the file and `permission-mode-chip.css` go entirely — `PERMISSION_MODE_SUBTITLES` relocates to the new sheet per [P02]). `sheet-option-list.css` stays if other pickers (rewind/resume/etc.) import it — verify with grep before removal.

**Implications:**
- `use-model.ts` / `use-effort.ts` / `use-permission-mode.ts`, all `lib/` pure modules, `DefaultsMetadataAdapter`, and the wire/persistence layers survive unchanged.

---

### Specification {#specification}

**Spec S01: Composite summary string** {#s01-summary-format}

`formatAiConfigSummary({ modelLabel, effortLabel, modeLabel })` joins the non-null parts with ` · `. `modelLabel` is `resolveModelLabel`'s output or `?` when null (the chip's honest-unknown treatment); `effortLabel` is omitted (not `-`) when effort is unsupported/unknown-support; `modeLabel` always present (`resolvePermissionMode` never returns null). Examples: `Fable 5 · High · Auto`, `Haiku 4.5 · Auto`, `? · Default`. The chip value line, the sheet caption, and the menu `aiSummary` all render this one function's output.

**Spec S02: Commit diff** {#s02-commit-diff}

```
interface AiConfigBaseline { modelSelector: string | null; effortLevel: string | null /* effective, null = unsupported */; mode: string; }
interface AiConfigPending  { modelSelector: string | null; effortLevel: string | null; mode: string; }
type AiConfigAction =
  | { kind: "mode";   value: PermissionMode }
  | { kind: "model";  value: string }
  | { kind: "effort"; value: string };
computeAiConfigCommit(baseline, pending): AiConfigAction[]
```

An action appears iff pending differs from baseline and pending is non-null. The array is emitted in the fixed order **mode → model → effort** ([P03]/[P04]) and the executor applies it in array order — so the ordering is a property of the pure function, asserted directly. Pure, unit-tested: no-change → `[]`; each single-field case; model+effort → exactly two actions with `model` at index 0; all three → `["mode","model","effort"]`.

**Spec S03: Sticky row** {#s03-sticky-row}

Domain `dev.tugtool.ai-config`, key `lastRow`, tagged value `{ kind: "string", value: "model" | "effort" | "mode" }`. `parseAiConfigRow(entry)` narrows unknown strings to `null`; consumers fall back to `"model"`. Written once per OK that commits at least one change, with the value = the changed row the user touched last (tracked in the sheet body as pending state moves).

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| Pending model/effort/mode in the open sheet | local-data (dialog-local) | `useState` in the sheet body (same as current picker bodies) | [L11] writes via `selectValue` responder |
| Description-line hover/cursor preview | appearance | pre-rendered layers + DOM attributes toggled by pointer handlers and a `MutationObserver` on `data-key-cursor` (the `layouts-section.tsx` machinery) | [L06] |
| Chip values (model/effort/mode/version/drift) | external | `SessionMetadataStore` / `CodeSessionStore` via `useSyncExternalStore` | [L02] |
| Sticky `lastRow` | external (persisted) | tugbank `useTugbankValue` + `setLocalValue` + PUT | [L02], no-localStorage rule |
| Drift popover open/closed | appearance | `TugPopoverHandle.open()` imperative (as the badge does today) | [L06] |
| Menu `aiSummary` | outward mirror | `publishSessionMenuState` block field | [L22] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/lib/ai-config.ts` | Pure helpers: `formatAiConfigSummary`, `computeAiConfigCommit`, `clampEffortToSupport`, `AI_CONFIG_DOMAIN`/`AI_CONFIG_LAST_ROW_KEY`, `parseAiConfigRow`, types `AiConfigRow` / `AiConfigAction` |
| `tugdeck/src/lib/__tests__/ai-config.test.ts` | Unit tests for the above (pure `bun:test`, no DOM) |
| `tugdeck/src/components/tugways/cards/ai-chip.tsx` | Composite Z4B chip ([P01], [P10]) |
| `tugdeck/src/components/tugways/cards/ai-config-sheet.tsx` (+ `.css`) | Mixer sheet + `useAiConfigSheet` ([P02], [P05], [P09]) |
| `tests/app-test/at####-ai-config-sheet.test.ts` | App-test for chip + sheet round trip (number assigned at authoring; `@covers` the new files + session-card.tsx) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `currentModel` | field | `tugcode/src/session.ts` | [P04]; recorded by `handleModelChange` above its no-process early return, `"default"` → null |
| `liveSpawnConfig` | fn (new, private) | `tugcode/src/session.ts` | [P04]; the fields shared by all three `buildClaudeArgs` callers, now including `model` |
| `spawnClaude`, `handleSessionFork`, `handleSessionContinue` | fn (modify) | `tugcode/src/session.ts` | all three spread `liveSpawnConfig()` — patching only `spawnClaude` leaves fork/continue dropping the model |
| `MenuStateSessionBlock.aiSummary` | field | `tugdeck/src/lib/host-menu-state.ts` | [P07]; plus the `CommandMenuFacts` session projection in `flush()` and `command-registry.ts`'s `CommandMenuFacts` session type |
| `aiSummary` supply | fn (modify) | `tugdeck/src/components/tugways/cards/use-menu-state-publication.ts` | [P07]; the hook that owns `publishSessionMenuState` |
| session block parser | struct (modify) | `tugapp/Sources/AppDelegate.swift` | parse `aiSummary` |
| `SlashBridge` | type (modify) | `tugdeck/src/components/tugways/command-registry.ts` | fifth optional element: `dynamicTitle`, spread by `SLASH_BRIDGE_COMMANDS` ([P07]) |
| `SLASH_BRIDGES` / `SLASH_BRIDGE_BINDINGS` | const (modify) | `tugdeck/src/components/tugways/command-registry.ts` | remove model/effort rows (**keep `permissions`**); add `ai` with ⌃⌘I, `sessionSettingsChangeable`, `dynamicTitle` |
| `cycleSpatialOrder` | memo (modify) | `tugdeck/src/components/tugways/cards/session-card.tsx` | toolbar arrow row shrinks to `[ROUTE, AI, SESSION, PROJECT, SUBMIT]` — renumbering alone leaves dead keys |
| `PERMISSION_MODE_COMMANDS` | const (delete) | `tugdeck/src/components/tugways/command-registry.ts` | submenu checkmark entries die with the submenu |
| `LOCAL_SLASH_COMMANDS` | const (modify) | `tugdeck/src/lib/slash-commands.ts` | add `ai` |
| `slashCommandSurfaces` | map (modify) | `tugdeck/src/components/tugways/cards/session-card.tsx` | `ai`/`model`/`effort`/`mode` → sheet deep links |
| `SESSION_CYCLE_ORDER_AI` | const | `tugdeck/src/components/tugways/cards/session-card.tsx` | replaces CLAUDE_CODE/MODE/MODEL/EFFORT orders; later orders renumber |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (bun, pure)** | `ai-config.ts` helpers: summary omission rules, diff minimality, clamp rule, lastRow parsing | Step 1 |
| **Unit (tugcode)** | `buildClaudeArgs` model flag; `handleModelChange` record semantics incl. `"default"` → null | Step 2 |
| **Unit (bun, pure)** | `computeCommandCapabilities` gate for the `ai` entry (dynamic title present/absent, enablement via `sessionSettingsChangeable`) — extends the existing `command-capabilities.test.ts` | Step 7 |
| **App-test** | Real app: chip renders composite value from an ingested `session_capabilities` (`window.__tug.ingestSessionMetadata`); chip press opens the sheet; segment click + OK updates the chip; Cancel does not; `/mode` deep-links focus | Step 8 |

#### What stays out of tests {#test-non-goals}

- No jsdom/fake-DOM render tests of the sheet or chip — banned pattern; the app-test drives the real surface.
- The hover description-preview machinery — appearance-only, mirrors a pattern already pinned by the Layouts section; asserting mid-flight DOM attributes in a background window is flake bait (rAF suspension).
- The effort-respawn end-to-end (real claude respawn) — covered at the tugcode unit layer; real-claude flows are on-demand only.
- Sticky-row persistence round-trip through tugbank HTTP — the write path is the same `setLocalValue` + PUT shape as three existing hooks; unit-test the parser only.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Commits land per the session's landing flow (the implement skill's dash rules); messages below follow the repo's `component(topic): summary` style.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Pure helpers: lib/ai-config.ts | done | a5c7e29e7 |
| #step-2 | tugcode currentModel on respawn | done | 1faad2808 |
| #step-3 | Mixer sheet: ai-config-sheet.tsx | done | 86f536724 |
| #step-4 | Composite chip: ai-chip.tsx | done | ba6f2f375 |
| #step-5 | Session card wiring swap | done | ffa1170b7 |
| #step-6 | Settings Assistant reuse | done | 75f50459b |
| #step-7 | Menu collapse: registry + Swift | done | 5823a48fe |
| #step-8 | App-test + old-surface deletions | done | 27b5c948e |
| #step-9 | Integration checkpoint | done | 4d0e6cfcf |

#### Step 1: Pure helpers: lib/ai-config.ts {#step-1}

**Commit:** `tugdeck(ai-config): pure helpers — summary, commit diff, effort clamp, sticky-row`

**References:** [P03] commit diff, [P05] effort clamp, [P06] sticky row, Spec S01, Spec S02, Spec S03, (#symbol-inventory)

**Artifacts:**
- `tugdeck/src/lib/ai-config.ts`, `tugdeck/src/lib/__tests__/ai-config.test.ts`

**Tasks:**
- [ ] `AiConfigRow = "model" | "effort" | "mode"`; `AI_CONFIG_DOMAIN = "dev.tugtool.ai-config"`, `AI_CONFIG_LAST_ROW_KEY = "lastRow"`, `parseAiConfigRow(entry: TaggedValue | undefined): AiConfigRow | null` (Spec S03).
- [ ] `formatAiConfigSummary` per Spec S01 (null model → `?`; null effort → omitted token).
- [ ] `computeAiConfigCommit(baseline, pending): AiConfigAction[]` per Spec S02 — an **ordered array**, mode → model → effort.
- [ ] `clampEffortToSupport(pending: string | null, supported: readonly string[]): string | null` per [P05], using `EFFORT_LEVELS` order from `lib/effort.ts`.

**Tests:**
- [ ] Summary: full triple, effort-omitted, unknown-model cases.
- [ ] Diff: no-change → `[]`; each single-field case; model+effort → two actions with `model` at index 0; all three → `["mode","model","effort"]` (the ordering is the point — assert `.map(a => a.kind)`).
- [ ] Clamp: `xhigh` → `high` when sonnet-shaped support; unsupported model → null; pending already supported → unchanged.
- [ ] Selector collapse ([P05]): a baseline resolved from a catalog whose explicit row shares the `default` row's `description` normalizes to `default`, so re-picking that row commits nothing.
- [ ] `parseAiConfigRow`: valid values pass, junk → null.

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/lib/__tests__/ai-config.test.ts`
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 2: tugcode currentModel on respawn {#step-2}

**Commit:** `tugcode(ai-config): track currentModel and re-apply --model on live-setting respawns`

**References:** [P04] currentModel, [Q01] respawn model loss, Risk R01, (#p04-tugcode-current-model)

**Artifacts:**
- `tugcode/src/session.ts` modified; tugcode unit tests extended.

**Tasks:**
- [ ] Add `private currentModel: string | null = null` beside `currentEffort` in `session.ts` (the effort field's doc block is the pattern).
- [ ] `handleModelChange(model)`: record `this.currentModel = model === "default" ? null : model` before the existing `set_model` forward — **above the `if (!this.claudeProcess) return` early return**, so a model set with no live process still carries to the next spawn, mirroring `handleEffortChange`'s pre-spawn record.
- [ ] Add a `private liveSpawnConfig()` returning the fields every spawn shares: `pluginDir`, `permissionMode`, `effort: this.currentEffort`, `model: this.currentModel`, `additionalDirectories`.
- [ ] Spread it at **all three** `buildClaudeArgs` call sites — `spawnClaude`, `handleSessionFork` (`continue` + `forkSession`), `handleSessionContinue` (`continue`) — each keeping only its own session-flag fields. Patching `spawnClaude` alone leaves fork and continue dropping the model ([Q01] second spike).

**Tests:**
- [ ] `buildClaudeArgs` with `model` set emits `--model <selector>`; without, no flag (extend the existing exported-fn tests in `tugcode/src/__tests__/session.test.ts`).
- [ ] `handleModelChange("default")` records null; `handleModelChange("sonnet")` records `"sonnet"` (test at whatever seam the existing session tests use; if none reaches the private field, assert via a spawn-args capture).
- [ ] `handleModelChange` with **no live process** still records — the early return must not skip the write.
- [ ] Spawn-args capture proves `--model` present on all three paths: an effort respawn, a fork, and a continue.

**Checkpoint:**
- [ ] tugcode test suite passes (run the repo's tugcode test command, e.g. `cd tugcode && bun test`).
- [ ] `just build-app` (tugcode is compiled into the bundle; needed before any later live verification).

---

#### Step 3: Mixer sheet: ai-config-sheet.tsx {#step-3}

**Depends on:** #step-1

**Commit:** `tugdeck(ai-config): mixer sheet — three TugChoiceGroup rows, live summary, OK/Cancel transaction`

**References:** [P02] mixer sheet, [P03] commit diff, [P05] disabled-in-place, [P06] sticky row, [P09] two contexts, [Q02], [Q03], Spec S01, Spec S02, (#state-zone-mapping)

**Artifacts:**
- `tugdeck/src/components/tugways/cards/ai-config-sheet.tsx` + `.css`

**Tasks:**
- [ ] `useAiConfigSheet({ sessionMetadataStore, showSheet, onCommit, renderFooter?, cardId? })` where `onCommit: (actions: AiConfigAction[]) => boolean` (false = refused, sheet stays open), returning `{ openAiConfigSheet(focusRow?: AiConfigRow) }`; open-time baseline reads per [P03]/[L07] (model options + active via `resolvePickerModels`; effective effort via `resolveEffortSupport` + `snapshot.effort ?? DEFAULT_EFFORT_LEVEL`; mode via `resolvePermissionMode` with the `cardId`-gated persisted fallback, matching `usePermissionSheet`).
- [ ] Sheet body per [P02]: summary caption (Spec S01 over pending), three `TugLabel` + `TugChoiceGroup` rows (senders `ai-config-model/effort/mode`; one `useResponder` routing `SELECT_VALUE` by sender), description-layer stack with the [L06] preview machinery, Cancel/OK `tug-sheet-actions` with `persistentDefaultRing`, sheet-local focus group seeded on `focusRow ?? stickyRow ?? "model"`.
- [ ] Local `previewIdOf` — the `layouts-section.tsx` shape **minus** the `data-state="active"` bail ([P02]); default layer = pending selection of the most-recently-changed row, falling back to the opened-on row.
- [ ] EFFORT row recompute + clamp on model selection ([P05], `clampEffortToSupport`); a no-effort model renders the group `disabled` with `value=""` ([P05]).
- [ ] `onCommit` returns whether it applied. OK: `computeAiConfigCommit` → `onCommit(actions)`; **if it returns refused, keep the sheet open and return** ([P03] idle guard); otherwise write sticky `lastRow` (Spec S03) iff the array is non-empty, then `close()`. Cancel/Escape: `close()` only.
- [ ] `renderFooter` slot rendered below the rows when provided ([Q03]).
- [ ] Relocate `EFFORT_SUBTITLES` and `PERMISSION_MODE_SUBTITLES` here (they die with their current homes in [P11]).

**Tests:**
- [ ] (Behavioral coverage lands in Step 8's app-test; this step's checkpoint is build + the Step 1 unit suite it composes.)

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 4: Composite chip: ai-chip.tsx {#step-4}

**Depends on:** #step-1

**Commit:** `tugdeck(ai-config): composite AI chip absorbing model/effort/mode display and CC drift report`

**References:** [P01] composite chip, [P10] drift absorbed, Spec S01, (#p01-composite-chip, #p10-drift-absorbed)

**Artifacts:**
- `tugdeck/src/components/tugways/cards/ai-chip.tsx`

**Tasks:**
- [ ] `AiChip({ cardId?, sessionMetadataStore, codeSessionStore?, onOpenSheet, disabled?, focusGroup?, focusOrder? })`: `TugPushButton` (`layout="label-top"`, `label="AI"`, `size="sm"`, `emphasis="tinted"`, `role="action"`, `data-slot="ai-chip"`), value = `TugStableOverlay` over `formatAiConfigSummary` with the widest-composition alternate ([P01]).
- [ ] Drift: when `codeSessionStore` present, the narrowed transcript subscription + `summarizeDrift` + `TriangleAlert` icon + `data-drift`, and the right-click `TugPopover` report — transplanted from `chrome/session-route-indicator-badge.tsx` (running / `VALIDATED_CC_VERSION` rows + event list).
- [ ] Version fallback + persist-on-change: transplant `CC_VERSION_DOMAIN`/`CC_VERSION_KEY`/`parseLastKnownVersion`/`persistLastKnownVersion` (export them from the chip module for the footer's use, or a tiny shared helper file).
- [ ] `TugActionTooltip` on `run-slash-command:ai` (resolves the ⌃⌘I chord through `commandShortcut`, which is why Step 7 must move the binding to `ai`).
- [ ] **No `useCopyableButton`** — right-click belongs to the drift report ([P10]). The copy affordance is a row inside the report popover that copies the composite summary.

**Tests:**
- [ ] (Covered by Step 8's app-test.)

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 5: Session card wiring swap {#step-5}

**Depends on:** #step-3, #step-4

**Commit:** `tugdeck(ai-config): session card renders the AI chip and routes /ai /model /effort /mode into the mixer`

**References:** [P01], [P03] executor order, [P08] slash routes, [P09] session context, [P10] footer, Spec S02, (#p08-slash-routes)

**Artifacts:**
- `session-card.tsx` modified; `lib/slash-commands.ts` modified.

**Tasks:**
- [ ] Replace the four-chip block (the `SessionRouteIndicatorBadge` / `PermissionModeChip` / `ModelChip` / `EffortChip` JSX on the Code route) with one `<AiChip …>`; add `SESSION_CYCLE_ORDER_AI` and renumber the cycle-order constants (CWD/CHANGES/SUBMIT/FIND/STATUS shift accordingly).
- [ ] **Shrink the arrow row, don't just renumber it.** `cycleSpatialOrder` hard-lists `[ROUTE, CLAUDE_CODE, SESSION, PROJECT, MODE, MODEL, EFFORT, SUBMIT]` as the toolbar's horizontal ring. Renumbering the constants leaves three keys pointing at stops that no longer exist; the row becomes `[ROUTE, AI, SESSION, PROJECT, SUBMIT]`.
- [ ] Replace the `usePermissionSheet` / `useModelPicker` / `useEffortPicker` hook calls with one `useAiConfigSheet` on the same `cardPickerSheet.showSheet` and `SESSION_CYCLE_PICKER_COMMIT_DISPOSITION`; `onCommit` walks the action array in order through `permissionMode.setMode` / `model.setModel` / `effort.setEffort` ([P03]).
- [ ] `onCommit` re-runs `guardTurnIdleForSetting("the AI configuration")` **once, before the first action**, and returns `false` on refusal so the sheet stays open ([P03]) — the open-time guard cannot cover a turn that starts while the sheet is up, and a partial apply is the one outcome the transaction exists to prevent.
- [ ] Footer (`renderFooter`): an "Edit permission rules…" row that closes the sheet and calls `permissionRulesSheet.openRulesSheet()`, plus the `Claude Code <version> · changelog` line (version resolution + `openUrlInOS` transplanted per [P10]).
- [ ] `LOCAL_SLASH_COMMANDS`: add `ai` ([P08]); `slashCommandSurfaces`: `ai` → `openAiConfigSheet()` (sticky), `model`/`effort`/`mode` → `openAiConfigSheet("model"|"effort"|"mode")`, all behind `guardTurnIdleForSetting("the AI configuration")`; `permissions` unchanged.
- [ ] Keep the `CYCLE_PERMISSION_MODE` and `SET_PERMISSION_MODE` card-content handlers as-is for now (the menu still dispatches them until Step 7).

**Tests:**
- [ ] `cd tugdeck && bun test` (existing suites — the exhaustive `LocalCommandName` record catches wiring gaps at compile time).

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit` (or the repo's typecheck path) and `bunx vite build`
- [ ] Manual smoke in the running app (HMR): chip renders, sheet opens, a mode-only change round-trips.

---

#### Step 6: Settings Assistant reuse {#step-6}

**Depends on:** #step-5

**Commit:** `tugdeck(ai-config): Settings Assistant edits deck defaults through the mixer`

**References:** [P09] two contexts, [Q03] no footer, (#p09-two-contexts)

**Artifacts:**
- `settings-session-card-body.tsx` modified.

**Tasks:**
- [ ] In the Assistant `TugBox`: replace the three chips + three picker hooks with one defaults-flavor `AiChip` (no `cardId`, no `codeSessionStore`) + one `useAiConfigSheet` on `assistantSheet.showSheet` with `sessionMetadataStore: defaultsAdapter` and `onCommit` writing `defaultsAdapter.permissionModeStore.set` / `modelStore.set` / `effortStore.set`; no footer.

**Tests:**
- [ ] (Manual: set a default model, open a fresh Session card, observe the seed apply via the existing `use-model.ts` mount-restore.)

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build`

---

#### Step 7: Menu collapse: registry + Swift {#step-7}

**Depends on:** #step-5

**Commit:** `tugapp+tugdeck(ai-config): Session menu ten rows → four; dynamic AI title; honest idle gate`

**References:** [P07] menu collapse, [P08], Spec S01, (#p07-menu-collapse)

**Artifacts:**
- `command-registry.ts`, `host-menu-state.ts`, session-card menu-state publication, `action-dispatch.ts`, `AppDelegate.swift` modified.

**Tasks:**
- [ ] `host-menu-state.ts`: add `aiSummary: string` to `MenuStateSessionBlock` and thread it through the `facts` projection in `flush()`; add the matching field to `CommandMenuFacts`'s session shape in `command-registry.ts`.
- [ ] **`cards/use-menu-state-publication.ts`** (not session-card.tsx — that hook owns the `publishSessionMenuState` call): supply `aiSummary` from the same `formatAiConfigSummary` inputs the chip uses, reading `snapshot.effort` directly with no per-card fallback ([P07]).
- [ ] `command-registry.ts`: widen `SlashBridge` with a fifth optional `dynamicTitle` element and spread it in `SLASH_BRIDGE_COMMANDS` ([P07]); remove the `model` and `effort` rows from `SLASH_BRIDGES` (**keep `permissions`**); add `["ai", "AI…", "session.ai", sessionSettingsChangeable, aiDynamicTitle]`; move ⌃⌘I in `SLASH_BRIDGE_BINDINGS` from `model` to `ai`; delete `PERMISSION_MODES` + `PERMISSION_MODE_COMMANDS` and their spread into `COMMANDS`.
- [ ] `AppDelegate.swift`: delete the Permission Mode submenu construction + `setPermissionModeFromMenu(_:)` + the `session.permissionMode` case in `validateMenuItem`; hoist the Cycle item (literal ⌃⌥⌘P key equivalent preserved) to the top level; delete the AI Model… / Reasoning Effort… items (**Permission Rules… stays**); add `sessionCommandItem("AI…", "ai", "session.ai")`; parse `aiSummary` in the session-block decode.
- [ ] `action-dispatch.ts`: remove the `SET_PERMISSION_MODE` registration if grep shows the submenu was its only dispatcher; then remove the session card's `SET_PERMISSION_MODE` handler and, if nothing else references it, the vocabulary constant — verify each removal with a grep before deleting, keep anything still dispatched.

**Tests:**
- [ ] Extend `src/lib/__tests__/command-capabilities.test.ts`: the `ai` entry gates on `sessionSettingsChangeable`, its gate carries `title: "AI: … …"` when `session.aiSummary` is set, and carries **no** `title` when it is empty (so the Swift static `AI…` stands).
- [ ] `src/components/tugways/__tests__/command-registry.test.ts` still reports `lintCommandTable() === []` — the widened tuple must not orphan a menu item or drop a door.

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/lib/__tests__/command-capabilities.test.ts src/components/tugways/__tests__/command-registry.test.ts` and `bunx vite build`
- [ ] `just build-app`; manual: menu shows four rows, AI item title tracks the chip, dims mid-turn, ⌃⌘I opens the sheet, ⌃⌥⌘P still cycles, Permission Rules… still opens the editor.

---

#### Step 8: App-test + old-surface deletions {#step-8}

**Depends on:** #step-5, #step-6, #step-7

**Commit:** `tugdeck(ai-config): delete superseded chips and pickers; app-test pins the mixer round trip`

**References:** [P11] deletions, (#test-plan-concepts, #success-criteria)

**Artifacts:**
- Deletions per [P11]; new `tests/app-test/at####-ai-config-sheet.test.ts` with `@covers` for `ai-chip.tsx`, `ai-config-sheet.tsx`, `lib/ai-config.ts`, and `session-card.tsx`.

**Tasks:**
- [ ] Delete `cards/model-chip.tsx`, `cards/effort-chip.tsx`, `cards/model-picker-sheet.tsx`(+css), `cards/effort-picker-sheet.tsx`(+css), **`chrome/session-route-indicator-badge.tsx`**(+css); strip `cards/permission-mode-chip.tsx` down to nothing and remove it (+css) once `PERMISSION_MODE_SUBTITLES` has moved; grep `sheet-option-list.css` importers and keep it if any survive.
- [ ] Grep for dangling imports of the deleted symbols (settings body, session-card, gallery/fixture files) and clean them.
- [ ] App-test (background mode, real app): ingest a `session_capabilities` fixture with two models (one effort-supporting, one not) via `window.__tug.ingestSessionMetadata`; assert the chip's composite value; open the sheet via chip click; assert three rows; click a mode segment + OK → chip reflects; reopen, change, Cancel → chip unchanged; `/mode` deep-link focuses the MODE row.
- [ ] App-test, the [P03] guard: with the sheet open, drive the session to a turn in flight, change a row, press OK → chip unchanged, sheet still open, caution raised.

**Tests:**
- [ ] The new app-test file (with `@covers` header; `just app-test-covers-check` clean).

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build` and `bun test`
- [ ] `just app-test-changed`

---

#### Step 9: Integration checkpoint {#step-9}

**Depends on:** #step-2, #step-8

**Commit:** `N/A (verification only)`

**References:** (#success-criteria), [P03], [P04]

**Tasks:**
- [ ] Verify the full transaction live: in the running app (rebuilt bundle from Step 2/7), change model + effort together, OK once; confirm from tugcode's spawn log line (`Spawning claude with args: …`) that the respawn carries both `--model` and `--effort`.
- [ ] Verify the [P04] census live on the other two paths: after a model change, run `/add-dir` (a `spawnClaude` respawn) and a session fork; confirm `--model` on both spawn log lines.
- [ ] Walk every success criterion in (#success-criteria).

**Tests:**
- [ ] `just app-test-changed` green across the branch's accumulated diff.

**Checkpoint:**
- [ ] `cd tugdeck && bunx vite build`; tugcode tests; `just app-test-changed`

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** One `AI` chip and one mixer sheet configure model, reasoning effort, and permission mode as a single confirmed transaction, with the Session menu collapsed to match; four chips, three picker sheets, and six menu rows deleted.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Every success criterion in (#success-criteria) verified as stated.
- [ ] `bunx vite build`, tugdeck `bun test`, tugcode tests, and `just app-test-changed` all green.
- [ ] No references to the deleted components remain (`grep -rn "ModelChip\|EffortChip\|PermissionModeChip\|SessionRouteIndicatorBadge\|useModelPicker\|useEffortPicker\|usePermissionSheet" tugdeck/src` → empty).

**Acceptance tests:**
- [ ] The Step 8 app-test.
- [ ] The Step 1 / Step 2 / Step 7 unit suites.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Coalesced `ai_config_change` wire message replacing the ordered two-frame commit.
- [ ] Migrating the three tugbank persistence domains into one `dev.tugtool.ai-config` record.
- [ ] Hover-preview of the summary caption (caption tracks hovered segment, not just pending) if the description line proves insufficient.

| Checkpoint | Verification |
|------------|--------------|
| Chip + sheet round trip | Step 8 app-test |
| Respawn carries `--model` + `--effort` | Step 9 spawn-log check + Step 2 unit tests |
| Menu collapse + dynamic title | Step 7 manual + capability unit test |
