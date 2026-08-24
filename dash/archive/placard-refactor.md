<!-- devise-skeleton v4 -->

## TugPlacard — unify the Z2 status-row popups {#placard-refactor}

**Purpose:** Replace the two divergent Z2 status-row floating surfaces (five portaled Radix popovers + one pinned `/btw` panel) with a single card-scoped `TugPlacard` component that carries a redesigned, non-pane-like theme-tinged header and two per-surface behavior axes (dismiss, reposition), so every Z2 popup looks and behaves consistently: one open at a time, anchored under its trigger cell, dismissed by clicking away.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-07-11 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The dev card's Z2 telemetry status row (`DevTelemetryStatusRow` in `tugdeck/src/components/tugways/cards/dev-card-telemetry-renderers.tsx`) currently hangs **two structurally different floating surfaces** off its cells:

- **STATE / TIME / TOKENS / CONTEXT / WORK** open through `TugStatusCell`'s `popover` prop, which wraps the cell in a `TugPopover` (Radix, **portaled** to the deck-level canvas overlay). Their content is a `TugPopupListFrame` whose own `.tug-popup-list-title` header is drawn on the **card-titlebar token** (`--tug7-surface-card-primary-normal-titlebar-active`) with a leading icon and left-aligned title — "modeled on the pane title bar" per the code's own comments. Dismiss is chain-reactive (click-away / Escape / toggle). Not repositionable.
- **BTW** (`/btw`) opens through `TugStatusCell`'s `onActivate` prop, which pops `SideQuestionOverlay` → `TugPinnedPanel`. This one renders **in-DOM** inside the Z2 row (card-scoped, not portaled). Its `.tug-pinned-panel-header` uses the **same card-titlebar token** plus a `×` close button, and doubles as a **horizontal drag handle** (position persisted per-card through tugbank). Dismiss is pinned — only the `×` closes it; click-away and card-switch do not.

Three problems follow, all traceable to one root — both header families borrow the card/pane titlebar look while only one of them acts like a movable pane:

1. The title bars *look* like movable/resizable card-hosting panes but don't *act* like them (the popover family doesn't move at all; only BTW drags).
2. BTW stays up until dismissed, so it can layer over the other popups, with no visible reason it's a "more important" kind of surface.
3. BTW is horizontally repositionable while none of the others are — inconsistent and confusing.

This plan collapses the two families into one `TugPlacard` surface with a redesigned header and configurable behavior, resolving all three.

#### Strategy {#strategy}

- **Rename first, behavior-identical.** Do the `TugPinnedPanel` → `TugPlacard` rename as a pure mechanical step so the diff that changes behavior later is small and legible ([P01]).
- **Generalize the surface, don't rebuild it.** `TugPinnedPanel` already is a documented, card-scoped, in-DOM floating surface with a clean positioning contract. Add two behavior axes (`dismiss`, `reposition`) and a redesigned header to it rather than authoring a new component ([P02], [P03]).
- **Replace Radix per-surface machinery with one scoped hook.** The five log popovers lose their portal; a small `usePlacardAutoDismiss` hook (capture-phase outside-`pointerdown` + Escape, trigger excluded) reproduces the only popover behavior we still want ([P04], [R01]).
- **One host, one open slot.** A single placard host inside `DevTelemetryStatusRow` owns an `openPlacard` slot covering all six surfaces, giving strict one-at-a-time for free and letting the host measure each cell for under-trigger anchoring ([P05], [P06]).
- **Consolidate the header.** The placard owns the header; `TugPopupListFrame`'s own titlebar becomes optional so the Z2 bodies render headerless while the non-Z2 `card-path-menu` keeps its title ([P07]).
- **Sequence so tests stay green until the deliberate flip.** at0211 keeps passing through the rename; it is rewritten only in the step that intentionally changes BTW's behavior ([P08]).

#### Success Criteria (Measurable) {#success-criteria}

- No `TugPinnedPanel` / `tug-pinned-panel` identifiers, class names, or `data-slot`s remain in `tugdeck/src` or `tests/` (`grep -rn "pinned-panel\|PinnedPanel" tugdeck/src tests` returns only the retained tugbank domain-string note). (verify: grep)
- All six Z2 surfaces (STATE, TIME, TOKENS, CONTEXT, WORK, BTW) render as `TugPlacard` — no `TugPopover` remains in `dev-card-telemetry-renderers.tsx` or `tug-status-cell.tsx`. (verify: grep `TugPopover` in those two files → none)
- Opening any Z2 placard closes any other that was open (one-at-a-time), and clicking outside a placard dismisses it. (verify: new app-test assertions in the rewritten at0211)
- A Z2 placard opens horizontally aligned under the cell that triggered it, clamped inside the card. (verify: app-test geometry assertion)
- The placard header carries no icon, a centered title, reduced height, a theme-tinged surface that is **not** `--tug7-surface-card-primary-normal-titlebar-active`, and a `×` only when `dismiss="explicit"`. (verify: visual + CSS grep + app-test that no `.tug-placard-close` exists for an auto-dismiss placard)
- `bunx vite build` succeeds and the full affected suite passes: `just app-test at0206-z2-popup-list.test.ts at0211-btw-side-question-overlay.test.ts at0215-route-chrome.test.ts at0219-work-revamp.test.ts at0192-z2-cold-replay.test.ts at0084-dev-lifecycle-coordination.test.ts`. (verify: commands)

#### Scope {#scope}

1. Rename `TugPinnedPanel` and its pref module / CSS / tests to `TugPlacard` (A).
2. Redesign the placard header: no icon, centered title, reduced height, distinct theme-tinged surface, conditional `×` (B, part of B).
3. Add `dismiss` and `reposition` behavior axes + `usePlacardAutoDismiss` hook + under-trigger horizontal anchoring + in-DOM viewport guard (B, C, E).
4. Make `TugPopupListFrame`'s title/icon optional so Z2 bodies render headerless (D).
5. Migrate STATE/TIME/TOKENS/CONTEXT/WORK from portaled `TugPopover` to the single in-DOM placard host, re-plumbing `/context` and `/tasks` imperative opens (C, D).
6. Fold BTW into the same host as an auto-dismiss, non-repositionable placard; refold `SideQuestionOverlay` into a plain body; rewrite at0211 (E, F).

#### Non-goals (Explicitly out of scope) {#non-goals}

- Changing what any popup *shows* — the `TugPopupList` content vocabulary (rows, footers, copy affordances, task/job/goal assembly) is untouched.
- Changing `card-path-menu.tsx`, which legitimately stays a portaled `TugPopover` anchored to the card title element.
- Retiring the `reposition` capability outright — the API axis stays for future case-by-case use, even though no Z2 surface enables it after this plan.
- Migrating the tugbank persistence *domain string* (`dev.tugtool.tugways.pinned-panel`) — kept as-is to avoid orphaning saved positions ([P01]).
- Any change to the `SideQuestionStore`, the `/btw` wire protocol, or transcript-invisibility ([D07]-style) invariants.

#### Dependencies / Prerequisites {#dependencies}

- Existing components: `TugPinnedPanel` (`tugdeck/src/components/tugways/tug-pinned-panel.tsx`), `TugPinnedPanel` pref (`tug-pinned-panel-pref.ts`), `TugStatusCell` (`tug-status-cell.tsx`), `TugPopupList*` (`tug-popup-list.tsx`), `SideQuestionOverlay` (`cards/side-question-overlay.tsx`), `DevTelemetryStatusRow` + popover content (`cards/dev-card-telemetry-renderers.tsx`, `cards/dev-card-telemetry-popovers.tsx`).
- Theme tokens already present in `tugdeck/styles/themes/*.css`: `--tug7-surface-global-primary-normal-raised-rest`, `--tug7-surface-global-primary-normal-overlay-rest`, `--tug7-element-global-divider-normal-default-rest`, `--tug7-element-global-border-normal-default-rest`.
- Tuglaws: [L02], [L06], [L03], [L19], [L20] (see `tuglaws/tuglaws.md`).

#### Constraints {#constraints}

- **WARNINGS ARE ERRORS** for Rust (not touched here); tugdeck must pass `bunx vite build` — an import that works under dev esbuild can still fail the production rollup bundle, so the build gate is mandatory before "done" (project memory: verify-with-vite-build).
- tugdeck HMR is always live; no manual tugdeck build needed for iteration, but the production `vite build` gate stands.
- Persistent state goes through tugbank `/api/defaults/...`, never `localStorage` (project memory: no-localStorage). The reposition offset already obeys this; keep it.
- Appearance/position changes ride CSS + imperative DOM writes, never React state ([L06]).

#### Assumptions {#assumptions}

- Only `dev-card-telemetry-renderers.tsx` consumes `TugStatusCell`'s `popover`/`popoverRef` props (confirmed by grep: no other importer passes them), so removing the popover path from `TugStatusCell` is safe.
- Only `dev-card-telemetry-popovers.tsx` and `chrome/card-path-menu.tsx` consume `TugPopupListFrame` (confirmed by grep); making its title optional affects only these two, and card-path-menu keeps passing `title`.
- `openContextPopover`/`openWorkPopover` have no external or test importer (grep: only `dev-card-telemetry-renderers.tsx` + `dev-card.tsx`), so renaming them to `openContext`/`openWork` is self-contained.

**Affected app-tests (verified by grep over `tests/app-test`):**

- **Rewritten** (their behavior/DOM changes under this plan): `at0206-z2-popup-list.test.ts` (portal removal breaks its `[data-radix-popper-content-wrapper]` open/close gate, `.tug-popup-list-title` probe, and viewport assertions; also relies on toggle-close) — Step 4; `at0211-btw-side-question-overlay.test.ts` (BTW pinned→auto-dismiss) — Step 6; `at0215-route-chrome.test.ts` (the `?`-route asserts `.side-question-pane`, which the refold removes) — Step 5.
- **Regression-only** (touch the cells but never open a popup — must stay green, no edits expected): `at0219-work-revamp.test.ts` (clicks WORK, reads inner `[data-slot="tug-popup-list"]` / `.tug-popup-list-group-label` / `.dev-jobs-popover-kind` — all retained); `at0192-z2-cold-replay.test.ts` and `at0084-dev-lifecycle-coordination.test.ts` (read only `.dev-telemetry-status-value` / context numerator-denominator cell values).

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

Anchors are explicit and kebab-case; steps cite `[P##]` plan-local decisions, `Spec S##`, and `#anchors`. No line numbers.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Should BTW keep the drag affordance? (DECIDED) {#q01-btw-drag}

**Question:** With BTW now auto-dismissing and anchored under its cell like the log placards, should it still be horizontally draggable?

**Why it matters:** Repositionability was the user's third complaint (BTW being the lone draggable surface). Keeping it re-introduces the exact inconsistency being removed.

**Resolution:** DECIDED — no Z2 placard enables `reposition` (see [P06]). The `reposition` axis remains in the API for future use, but every current Z2 surface passes `reposition={false}` (the default). Retires complaint #3.

#### [Q02] Which theme surface for the redesigned header? (DECIDED) {#q02-header-token}

**Question:** The header must stay theme-tinged but stop reading as a card/pane titlebar. Which token?

**Resolution:** DECIDED — `--tug7-surface-global-primary-normal-raised-rest` for the header fill (a subtle raised tint, distinct from the card-titlebar token), with a `--tug7-element-global-divider-normal-default-rest` bottom hairline; the placard body keeps `--tug7-surface-global-primary-normal-overlay-rest`. See [P03] and `#header-redesign`.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Losing Radix's collision/viewport handling for the log popups | med | med | Port the popup-list viewport guard to a measured in-DOM equivalent; clamp anchor within card ([R01]) | A long popup overflows the card in a short pane |
| at0211 rewrite misses a behavior inversion | low | med | Enumerate every inverted assertion in the step ([P08], #step-6) | at0211 flakes or asserts stale pinned behavior |
| Under-trigger anchoring math off for narrow panes | low | med | Reuse the existing `computeTravel` clamp + `DRAG_INSET`/`RIGHT_INSET` insets ([R01]) | Placard clips card edge |

**Risk R01: In-DOM placement without Radix Popper** {#r01-no-popper}

- **Risk:** The five log popovers currently rely on Radix Popper for collision-aware anchoring and on `--radix-popover-content-available-height` (read by `tug-popup-list.css` as the scroller's hard ceiling). Rendering in-DOM drops both.
- **Mitigation:**
  - Anchor horizontally under the trigger cell using the same clamp math `TugPinnedPanel` already has (`computeTravel`, `DRAG_INSET`, `RIGHT_INSET`), seeded from the cell's measured offset within the Z2 row rather than a persisted fraction.
  - **Do not edit `tug-popup-list.css`.** Its `max-height` already reads `var(--radix-popover-content-available-height, 100dvh)`. That CSS is *shared* with `card-path-menu` (still a real Radix popover), so the placard must not swap the var name. Instead, the placard **writes `--radix-popover-content-available-height` imperatively onto its own root** (the popup-list frame is its descendant, so it inherits the value), computed as the upward gap from the placard's top edge to the card's top content edge (the placard grows upward from just above Z2). Card-path-menu keeps the genuine Radix-supplied value untouched; no shared-CSS change is needed.
- **Residual risk:** A pathologically short pane could still cramp a long popup; the scroller absorbs it exactly as today, bounded by the placard-written value instead of the Radix-supplied one.

---

### Design Decisions {#design-decisions}

#### [P01] Rename to TugPlacard; keep the persisted tugbank domain string (DECIDED) {#p01-rename}

**Decision:** Rename every `TugPinnedPanel` code identifier, file, CSS class, and `data-slot` to `TugPlacard` / `tug-placard`, but leave the tugbank domain *string* `dev.tugtool.tugways.pinned-panel` unchanged (rename only its exported constant, e.g. `PINNED_PANEL_DOMAIN` → `PLACARD_OFFSET_DOMAIN`, still valued `"dev.tugtool.tugways.pinned-panel"`).

**Rationale:**
- The name `TugPinnedPanel` is being retired by owner request; `TugPlacard` is the chosen name.
- The domain string is a persisted key; renaming it silently orphans every user's saved BTW drag position. The value is cheap to keep and costly to change.

**Implications:**
- All imports, JSX tags, prop-type names, `.tug-pinned-panel*` classes, `data-slot="tug-pinned-panel*"`, and `data-pinned-panel-close` become `tug-placard*` / `data-placard-close`.
- A one-line code comment records why the domain string diverges from the symbol name.

#### [P02] Two behavior axes on one component (DECIDED) {#p02-axes}

**Decision:** `TugPlacard` gains `dismiss?: "auto" | "explicit"` (default `"explicit"`) and keeps a `reposition?: boolean` (default `false`) prop. `dismiss="auto"` closes on outside-pointer/Escape and renders **no** `×`; `dismiss="explicit"` renders the `×` and nothing else dismisses. `reposition` gates the drag handler and grab cursor.

**Rationale:**
- The user asked for per-case dismiss and reposition configuration on the component.
- Defaults preserve the current `TugPinnedPanel` behavior (explicit, non-reposition) so the rename step is behavior-identical before any callsite opts into the new axes.

**Implications:**
- The header's `×` and the drag handlers become conditional on the axis props.
- `dismiss="auto"` needs a non-Radix outside-dismiss mechanism ([P04]).

#### [P03] Redesigned header: centered, icon-less, reduced-height, non-titlebar tint (DECIDED) {#p03-header}

**Decision:** The placard header renders a **centered** title, **no** leading icon, at reduced height, on `--tug7-surface-global-primary-normal-raised-rest` with a `--tug7-element-global-divider-normal-default-rest` bottom hairline. The `×` (explicit-dismiss only) is absolutely positioned at the right edge so the title stays optically centered.

**Rationale:**
- Owner wants a header that is theme-based but does **not** read as a card/pane titlebar; the raised token is theme-tinged yet distinct from `--tug7-surface-card-primary-normal-titlebar-active`.
- Centering + dropping the icon + absolute `×` breaks the "left icon, left title, right controls" pane-titlebar silhouette.

**Implications:**
- `TugPlacard`'s `header` prop shifts from arbitrary `ReactNode` to a `title: string` (callers stop passing icon+title nodes). Keep a `headerAccessory?` escape hatch only if a callsite needs it — none do today, so omit.
- `tug-placard.css` header rules are rewritten; `.tug-placard-header` remains the drag handle *only when* `reposition` is set.

#### [P04] usePlacardAutoDismiss replaces the portal's outside-dismiss (DECIDED) {#p04-auto-dismiss}

**Decision:** A new hook `usePlacardAutoDismiss({ open, dismiss, panelRef, triggerSelector, onClose })` attaches, while `open && dismiss === "auto"`, a **capture-phase** `pointerdown` listener on `document` that calls `onClose()` when the event target is outside the placard *and* outside the trigger, plus an Escape `keydown` handler. It participates in no responder chain (placards stay chain-free per `internal/floating-surface-notes.ts`).

**Rationale:**
- The in-DOM placard has no Radix Popper to provide click-outside/Escape; this hook reproduces only that behavior, scoped.
- Excluding the trigger prevents the "click cell → outside-dismiss fires → cell's onClick re-opens" flicker; the host's `openPlacard` toggle owns open/close cleanly.

**Implications:**
- The trigger exclusion is by DOM predicate — the host stamps a stable attribute on the trigger cells (e.g. `[data-placard-trigger]` on every Z2 cell) that the hook checks via `closest`. Stamping *all* cells (not just the active one) is what lets a click on a *different* cell swap surfaces cleanly: the hook ignores it (inside a trigger) and the cell's toggle ([P05]) does the swap.
- Listener is capture-phase so it fires before the trigger's own bubble handler.
- The Escape handler also honors **Cmd-.** (the chain's conventional cancel), so the keyboard dismiss matches what users expect from the surfaces it replaces.
- **Deliberate behavior change:** dropping the popovers' `observeDispatch` chain participation means an *unrelated* chain shortcut no longer dismisses an open placard (today's CONTEXT popover does). Outside-pointer + Escape/Cmd-. cover the common cases; this is the intended, less-surprising behavior for a card-scoped surface, recorded here so it is a decision rather than a silent regression.

#### [P05] Single placard host owns one open slot for all six surfaces (DECIDED) {#p05-single-host}

**Decision:** `DevTelemetryStatusRow` renders exactly one `TugPlacard` whose content is selected by a local `openPlacard: PlacardKind | null` state (`PlacardKind = "state" | "time" | "tokens" | "context" | "work" | "btw"`). Every cell's activation **toggles** this slot — `setOpenPlacard(cur => cur === key ? null : key)` — so re-clicking the active cell closes it; clicking a different cell swaps. Opening one implicitly closes any other.

**Rationale:**
- Owner chose strict one-at-a-time with zero layering. A single slot delivers it structurally, independent of the auto-dismiss hook.
- The host already renders all cells, so it can measure each cell's DOM node for under-trigger anchoring ([P06]).
- Toggle-close preserves the old `TugPopover` re-click-to-close behavior and is a hard requirement of `at0206`'s `closePopup` helper (it clicks the same cell and waits for the popup to disappear).

**Implications:**
- `TugStatusCell`'s `popover`/`popoverRef` props and its internal `TugPopover` wrapper are removed; all Z2 cells become `onActivate` buttons.
- `SideQuestionOverlay`'s own `open` state and `TugPinnedPanel` are removed; it becomes a pure body rendered inside the host's placard when `openPlacard === "btw"` ([P07]).
- The imperative handle `DevTelemetryStatusRowHandle` exposes `openContext()`, `openWork()`, `openSideQuestions()` (renamed/added from `openContextPopover`/`openWorkPopover`), each setting `openPlacard`.

#### [P06] Anchor under the trigger cell; no reposition on any Z2 placard (DECIDED) {#p06-anchor}

**Decision:** When a cell activates, the host measures that cell's horizontal offset within the Z2 row and passes it to the placard as the default left; the placard clamps it inside the card using the existing `computeTravel`/inset math. All six placards pass `reposition={false}`; BTW passes `dismiss="auto"` like the rest.

**Rationale:**
- Owner chose under-trigger anchoring to preserve the spatial cue of which instrument a placard belongs to, even without a portal.
- Owner chose maximum consistency (BTW auto-dismisses too), which — combined with no reposition — makes all six behave identically.

**Implications:**
- The persisted-offset path (`usePlacardOffset`/`writePlacardOffset`) is no longer exercised by any Z2 callsite but stays in the module for the retained `reposition` axis.
- The placard's horizontal position is written imperatively to `style.left` ([L06]), seeded from the measured cell offset rather than a tugbank fraction.
- **Positioning container:** the placard's `offsetParent` is `.dev-card-status-bar` (it is `position: relative` — see `dev-card.css`); `.dev-telemetry-status-row` is an unpositioned flex row, so do **not** add `position: relative` to it. Measure `anchorLeft` as `cell.getBoundingClientRect().left − statusBar.getBoundingClientRect().left`, and place the placard absolutely with `bottom: 100%` (resolved against the status bar, floating it just above Z2 — identical to the pinned panel today). `container-type: inline-size` on the status bar does not establish a positioning containing block, so this resolution is unchanged.

#### [P07] TugPopupListFrame title becomes optional; the placard owns the header (DECIDED) {#p07-frame-headerless}

**Decision:** `TugPopupListFrame`'s `title` (and `icon`) become optional. When omitted, the frame renders no `.tug-popup-list-title` chrome. The six Z2 content components stop passing `title`/`icon`; the placard header carries the title instead. `card-path-menu.tsx` keeps passing `title="Path"`.

**Rationale:**
- Two stacked headers (frame titlebar + placard header) on the same card-titlebar token is the visual redundancy the redesign removes.
- Making it opt-out (not a global strip) preserves the one legitimate non-Z2 consumer.

**Implications:**
- The title text for each Z2 placard moves to the host (e.g. a `PLACARD_TITLES` map: `state → "State"`, `time → "Time"`, …), matching the strings the content components previously passed to the frame.

#### [P08] Rewrite at0211 only in the BTW-migration step (DECIDED) {#p08-test-sequencing}

**Decision:** at0211's selector renames (`.tug-pinned-panel-header` → `.tug-placard-header`, `[data-pinned-panel-close]` → the auto-dismiss equivalents) and its behavioral assertion inversions land together in the BTW-migration step ([#step-6]), not the rename step. The rename step ([#step-1]) updates only the selector strings that the still-pinned BTW behavior keeps valid.

**Rationale:**
- Between the rename and the BTW migration, BTW is still explicit/draggable, so at0211's pinned/drag/persist assertions still hold — only class names changed.
- Bundling the inversion with the behavior change keeps each commit's tests self-consistent.

**Implications:**
- Step 1 keeps at0211 green with pure selector renames.
- Step 6 removes drag/persistence assertions and inverts "click-away does NOT dismiss" → "click-away DOES dismiss", and swaps the `×`-close path for a click-away close.

---

### Deep Dives (Optional) {#deep-dives}

#### Current surface inventory {#surface-inventory}

**Table T01: Z2 surfaces today → target** {#t01-surfaces}

| Cell | Today opens via | Machinery | Dismiss | Reposition | Target |
|------|-----------------|-----------|---------|-----------|--------|
| STATE | `TugStatusCell popover` | portaled `TugPopover` | chain-reactive | no | placard, `dismiss="auto"` |
| TIME | `TugStatusCell popover` | portaled `TugPopover` | chain-reactive | no | placard, `dismiss="auto"` |
| TOKENS | `TugStatusCell popover` | portaled `TugPopover` | chain-reactive | no | placard, `dismiss="auto"` |
| CONTEXT | `TugStatusCell popover` (+`popoverRef`) | portaled `TugPopover` | chain-reactive | no | placard, `dismiss="auto"`, imperative open |
| WORK | `TugStatusCell popover` (+`popoverRef`) | portaled `TugPopover` | chain-reactive | no | placard, `dismiss="auto"`, imperative open |
| BTW | `TugStatusCell onActivate` → `SideQuestionOverlay` | in-DOM `TugPinnedPanel` | pinned (`×`) | yes (drag) | placard, `dismiss="auto"`, no reposition |

#### Header redesign {#header-redesign}

Current header markup (`tug-pinned-panel.tsx`): `.tug-pinned-panel-header` = `[header-content (icon+title)] [× TugButton]`, drawn on `--tug7-surface-card-primary-normal-titlebar-active`, always a drag handle.

Target markup (`tug-placard.tsx`): `.tug-placard-header` = centered `.tug-placard-title` (string) with an absolutely-positioned `.tug-placard-close` `×` (rendered only when `dismiss="explicit"`). Fill `--tug7-surface-global-primary-normal-raised-rest`; bottom hairline `--tug7-element-global-divider-normal-default-rest`; reduced block padding (drop from `--tug-space-sm` to a tighter value, e.g. `4px`); `cursor: grab` / drag handlers apply only when `reposition`. The frame body keeps `--tug7-surface-global-primary-normal-overlay-rest`.

#### Auto-dismiss + one-at-a-time interaction {#dismiss-interaction}

Two independent mechanisms both enforce one-open-at-a-time, and that redundancy is intentional:

1. **Single `openPlacard` slot** ([P05]) — opening cell B sets the slot to B, unmounting A's content. This handles cell→cell switches without any pointer bookkeeping.
2. **`usePlacardAutoDismiss`** ([P04]) — clicking *outside every cell and the placard* closes the open one. This handles click-into-editor / click-blank-canvas.

The trigger exclusion ([P04]) is what keeps mechanism (2) from fighting the cell's own toggle: a pointerdown on a status cell is inside `[data-placard-trigger]`-scoped chrome, so the hook ignores it and lets the cell's activation (mechanism 1) run.

#### Imperative open re-plumb {#imperative-replumb}

`dev-card.tsx` `slashCommandSurfaces` routes today:
- `context: () => statusRowRef.current?.openContextPopover()`
- `tasks` / `bashes: () => statusRowRef.current?.openWorkPopover()`
- `btw: (arg) => { if (arg) sideQuestionStore.ask(arg); sideQuestionOverlayRef.current?.open(); }`

Target:
- `context: () => statusRowRef.current?.openContext()`
- `tasks` / `bashes: () => statusRowRef.current?.openWork()`
- `btw: (arg) => { if (arg) sideQuestionStore.ask(arg); statusRowRef.current?.openSideQuestions(); }`

`sideQuestionOverlayRef` (a `SideQuestionOverlayHandle` ref) and the `<SideQuestionOverlay ref=… />` mount in the Z2 status-bar JSX are removed; the `onOpenSideQuestions` prop wiring to the row (`onOpenSideQuestions: () => sideQuestionOverlayRef.current?.open()`) is removed because the BTW cell now sets the host slot directly.

---

### Specification {#specification}

**Spec S01: `TugPlacardProps`** {#s01-props}

```ts
export interface TugPlacardProps {
  /** Whether the placard is shown. When false, nothing renders. */
  open: boolean;
  /** Centered header title. */
  title: string;
  /** Placard body. */
  children: React.ReactNode;
  /** Caller styling — owns width and vertical placement. */
  className?: string;
  /**
   * Dismiss model:
   *  - "auto"     — outside-pointer / Escape dismiss; no × in header.
   *  - "explicit" — stays until the header × is clicked; nothing else dismisses.
   * @default "explicit"
   */
  dismiss?: "auto" | "explicit";
  /** Invoked on × (explicit) or on auto-dismiss. */
  onClose: () => void;
  /** Horizontal drag repositioning via the header. @default false */
  reposition?: boolean;
  /**
   * Default horizontal left (px, within the positioned container) to open at.
   * The host measures the trigger cell and passes its offset for under-trigger
   * anchoring; clamped inside the container. Ignored when a persisted
   * reposition offset exists.
   */
  anchorLeft?: number;
  /** Tugbank key persisting the reposition offset. Only meaningful with reposition. */
  persistKey?: string;
  /** Accessible label / tooltip for the close button (explicit only). */
  closeLabel?: string;
  /** Accessible label for the placard region. */
  "aria-label"?: string;
}
```

**Spec S02: `usePlacardAutoDismiss`** {#s02-hook}

```ts
function usePlacardAutoDismiss(args: {
  open: boolean;
  dismiss: "auto" | "explicit";
  panelRef: React.RefObject<HTMLElement>;
  /** CSS predicate for the trigger chrome to exclude (e.g. "[data-placard-trigger]"). */
  triggerSelector: string;
  onClose: () => void;
}): void;
```

Behavior: no-op unless `open && dismiss === "auto"`. Registers a capture-phase `document` `pointerdown` and a `keydown` (Escape) listener in a `useLayoutEffect` ([L03] — the listener must be live before any event it depends on). Calls `onClose()` when a pointerdown target is outside `panelRef` **and** not within `triggerSelector`, or on Escape. Cleans up on close/unmount.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| `openPlacard: PlacardKind \| null` (which surface is mounted) | structure / local-data | `useState` in `DevTelemetryStatusRow` | [L02]-adjacent (ephemeral UI, not external) |
| Placard horizontal position (`style.left`) | appearance / position | imperative DOM write, seeded from measured `anchorLeft` | [L06] |
| `--tugx-placard-available-height` viewport ceiling | appearance | imperative CSS custom property write | [L06], [R01] |
| Auto-dismiss outside-pointer / Escape subscription | (not state) | `useLayoutEffect` document listeners | [L03] |
| Reposition offset fraction (retained API, unused by Z2) | external / persisted | tugbank + `useSyncExternalStore` | [L02] |
| BTW `/btw` exchange count + telemetry snapshots | external | store + `useSyncExternalStore` (unchanged) | [L02] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/components/tugways/tug-placard.tsx` | Renamed from `tug-pinned-panel.tsx`; adds `dismiss`/`reposition`/`anchorLeft` axes, redesigned header, `usePlacardAutoDismiss`. |
| `tugdeck/src/components/tugways/tug-placard.css` | Renamed from `tug-pinned-panel.css`; rewritten header rules ([P03]). |
| `tugdeck/src/components/tugways/tug-placard-pref.ts` | Renamed from `tug-pinned-panel-pref.ts`; constant rename only, domain string kept. |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `TugPlacard` | component | `tug-placard.tsx` | Renamed from `TugPinnedPanel`; Spec S01 props. |
| `TugPlacardProps` | interface | `tug-placard.tsx` | Renamed; new axis props. |
| `usePlacardAutoDismiss` | hook | `tug-placard.tsx` | New (Spec S02). |
| `usePlacardOffset` / `writePlacardOffset` / `clampOffsetFraction` | fns | `tug-placard-pref.ts` | Renamed from `usePinnedPanelOffset` / `writePinnedPanelOffset`. |
| `PLACARD_OFFSET_DOMAIN` | const | `tug-placard-pref.ts` | Renamed from `PINNED_PANEL_DOMAIN`; value stays `"dev.tugtool.tugways.pinned-panel"` ([P01]). |
| `TugPopupListFrameProps.title` / `.icon` | prop | `tug-popup-list.tsx` | Made optional ([P07]). |
| `TugStatusCellProps.popover` / `.popoverRef` | prop | `tug-status-cell.tsx` | Removed; cells become `onActivate`-only ([P05]). |
| `PlacardKind` | type | `dev-card-telemetry-renderers.tsx` | New union of the six surface keys. |
| `PLACARD_TITLES` | const map | `dev-card-telemetry-renderers.tsx` | Surface key → header title ([P07]). |
| `DevTelemetryStatusRowHandle` | interface | `dev-card-telemetry-renderers.tsx` | `openContext()` / `openWork()` / `openSideQuestions()` replace `openContextPopover` / `openWorkPopover`. |
| `SideQuestionOverlay` | component | `cards/side-question-overlay.tsx` | Refolded into a body (no `TugPinnedPanel`, no `open` state) ([P05]). |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Integration (app-test)** | Drive the real Tug.app; assert live DOM/behavior | Placard open/close/toggle/anchor/one-at-a-time (at0206, at0211, at0215, at0219) |
| **Drift Prevention** | grep-based invariants | No `pinned-panel` / `TugPopover` residue in target files |

#### What stays out of tests {#test-non-goals}

- No jsdom render tests or mock-store assertions for `TugPlacard` — placard behavior is exercised in the real app (project memory: real-not-fake). The unit-level surface (`usePlacardAutoDismiss` predicate) is proven through the app-test that clicks away, not a synthetic event test.
- No test for the retained-but-unused `reposition` persistence path — it's dead-for-now API; adding coverage would assert behavior nothing ships.

---

### Execution Steps {#execution-steps}

> Commit after all checkpoints pass. Every step commits directly to `main` (project policy — user commits only; these steps are authored for the user or an authorized autonomous run).

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Rename TugPinnedPanel → TugPlacard (behavior-identical) | done | tugdeck(placard): rename TugPinnedPanel → TugPlacard |
| #step-2 | Header redesign + dismiss/reposition axes + auto-dismiss hook | done | tugdeck(placard): redesigned header + dismiss/reposition axes + auto-dismiss |
| #step-3 | Make TugPopupListFrame title optional | done | tugdeck(popup-list): make frame title/icon optional |
| #step-4 | Migrate the five log cells to the single placard host | done | tugdeck(dev-card): STATE/TIME/TOKENS/CONTEXT/WORK as one placard host |
| #step-5 | Fold BTW into the host; refold SideQuestionOverlay | done | tugdeck(dev-card): BTW as an auto-dismiss placard in the shared host |
| #step-6 | Rewrite at0211; integration verify | done | test(at0211): BTW placard is auto-dismiss, one-at-a-time, under-cell |

#### Step 1: Rename TugPinnedPanel → TugPlacard (behavior-identical) {#step-1}

**Commit:** `tugdeck(placard): rename TugPinnedPanel → TugPlacard (no behavior change)`

**References:** [P01] Rename + keep domain string (#p01-rename), Table T01 (#t01-surfaces)

**Artifacts:**
- `tug-placard.tsx` / `.css` / `tug-placard-pref.ts` (renamed from `tug-pinned-panel*`).
- Updated importers: `cards/side-question-overlay.tsx`, `internal/floating-surface-notes.ts` docstring ("Pinned" → "Placard" semantic-model entry).
- at0211 selector renames only.

**Tasks:**
- [ ] `git mv` the three files; rename `TugPinnedPanel`→`TugPlacard`, `TugPinnedPanelProps`→`TugPlacardProps`, `usePinnedPanelOffset`→`usePlacardOffset`, `writePinnedPanelOffset`→`writePlacardOffset`, `PINNED_PANEL_DOMAIN`→`PLACARD_OFFSET_DOMAIN` (value unchanged; add a one-line comment per [P01]).
- [ ] Rename CSS classes `.tug-pinned-panel*`→`.tug-placard*`, `data-slot="tug-pinned-panel*"`→`tug-placard*`, `data-pinned-panel-close`→`data-placard-close`.
- [ ] Update `side-question-overlay.tsx` import/JSX and the `.tug-pinned-panel.side-question-pane` selector in `side-question-overlay.css`.
- [ ] Update `floating-surface-notes.ts` docstring naming.
- [ ] In at0211, rename `.tug-pinned-panel-header`→`.tug-placard-header` and `[data-pinned-panel-close]`→`[data-placard-close]` (behavioral assertions unchanged — still pinned/draggable this step, per [P08]).

**Tests:**
- [ ] at0211 still passes (pinned behavior intact, only names changed).

**Checkpoint:**
- [ ] `grep -rn "PinnedPanel\|pinned-panel" tugdeck/src tests` → only the `PLACARD_OFFSET_DOMAIN` value string + its comment.
- [ ] `bunx vite build` succeeds.
- [ ] `just app-test at0211-btw-side-question-overlay.test.ts` passes.

#### Step 2: Header redesign + dismiss/reposition axes + auto-dismiss hook {#step-2}

**Depends on:** #step-1

**Commit:** `tugdeck(placard): redesigned header + dismiss/reposition axes + auto-dismiss`

**References:** [P02] Two axes (#p02-axes), [P03] Header (#p03-header), [P04] Auto-dismiss (#p04-auto-dismiss), [Q02] (#q02-header-token), Spec S01 (#s01-props), Spec S02 (#s02-hook), Risk R01 (#r01-no-popper), (#header-redesign)

**Artifacts:**
- `TugPlacard` with `dismiss`/`reposition`/`anchorLeft`/`title` props (Spec S01), redesigned header, `usePlacardAutoDismiss` (Spec S02), `--tugx-placard-available-height` viewport guard.
- Rewritten `.tug-placard-header` CSS ([P03]).

**Tasks:**
- [ ] Change the `header: ReactNode` prop to `title: string`; render a centered `.tug-placard-title`; drop the leading-icon slot.
- [ ] Render `.tug-placard-close` `×` only when `dismiss === "explicit"`, absolutely positioned right.
- [ ] Gate drag handlers + `cursor: grab` on `reposition`; when false, seed `style.left` from `anchorLeft` (clamped via existing `computeTravel`/`DRAG_INSET`/`RIGHT_INSET`).
- [ ] Add `usePlacardAutoDismiss` (Spec S02) and call it from `TugPlacard`.
- [ ] Write `--tugx-placard-available-height` imperatively (top-of-placard → card top content edge) and read it in `tug-popup-list.css`'s `max-height` (replacing `--radix-popover-content-available-height`, keeping a Radix fallback for card-path-menu).
- [ ] Rewrite header CSS to `--tug7-surface-global-primary-normal-raised-rest` fill + `--tug7-element-global-divider-normal-default-rest` hairline + reduced padding.
- [ ] Keep `side-question-overlay.tsx` passing `dismiss="explicit"` + `reposition` this step so BTW is unchanged until #step-5 (per [P08]); update its header usage to the new `title` prop (`title="/btw"`).

**Tests:**
- [ ] at0211 still passes (BTW still explicit + draggable; header class present).

**Checkpoint:**
- [ ] `bunx vite build` succeeds.
- [ ] `just app-test at0211-btw-side-question-overlay.test.ts` passes.
- [ ] Visual: BTW header is centered, icon-less, on the raised (not titlebar) tint.

#### Step 3: Make TugPopupListFrame title optional {#step-3}

**Depends on:** #step-1

**Commit:** `tugdeck(popup-list): make frame title/icon optional`

**References:** [P07] Frame headerless (#p07-frame-headerless)

**Artifacts:**
- `TugPopupListFrame` renders no `.tug-popup-list-title` when `title` is omitted.

**Tasks:**
- [ ] Make `TugPopupListFrameProps.title` and `.icon` optional; guard the title-block render.
- [ ] Leave `card-path-menu.tsx` (passes `title="Path"`) and all six Z2 content components unchanged **this step** (they still pass titles; the frame just tolerates omission). The Z2 components drop their titles in #step-4.

**Tests:**
- [ ] at0219 still passes (WORK popover content unchanged).

**Checkpoint:**
- [ ] `bunx vite build` succeeds.
- [ ] `just app-test at0219-work-revamp.test.ts` passes.

#### Step 4: Migrate the five log cells to the single placard host {#step-4}

**Depends on:** #step-2, #step-3

**Commit:** `tugdeck(dev-card): STATE/TIME/TOKENS/CONTEXT/WORK as one placard host`

**References:** [P05] Single host + toggle-close (#p05-single-host), [P06] Anchor + no reposition (#p06-anchor), [P07] (#p07-frame-headerless), Spec S01 (#s01-props), Table T01 (#t01-surfaces), Risk R01 (#r01-no-popper), (#imperative-replumb), (#dismiss-interaction)

**Artifacts:**
- `PlacardKind`, `PLACARD_TITLES`, `openPlacard` state, and one `<TugPlacard>` in `DevTelemetryStatusRow`.
- `TugStatusCell` with `popover`/`popoverRef` removed (all cells `onActivate`); docstring updated.
- `DevTelemetryStatusRowHandle` → `openContext()` / `openWork()`.
- `dev-card.tsx` slash routes updated to `openContext()` / `openWork()`.
- Rewritten `at0206-z2-popup-list.test.ts`.

**Tasks:**
- [ ] Add `openPlacard` state + one `TugPlacard` (`dismiss="auto"`, `reposition={false}`, `title={PLACARD_TITLES[openPlacard]}`) rendered as an absolutely-positioned child inside `.dev-telemetry-status-row` (offsetParent resolves to `.dev-card-status-bar` per [P06]), whose body switches on `openPlacard` among the five content elements (`statePopover`/`timePopover`/`tokensPopover`/`contextPopover`/`workPopover`, which stay assembled as today).
- [ ] Convert the five cells from `popover={…}` to `onActivate={() => setOpenPlacard(cur => cur === key ? null : key)}` (**toggle-close**, [P05]); stamp `data-placard-trigger` on all Z2 cells for the auto-dismiss exclusion ([P04]).
- [ ] Measure the activating cell's offset (`cell.left − statusBar.left`, [P06]) and pass it as `anchorLeft`.
- [ ] Write `--radix-popover-content-available-height` imperatively on the placard root from the upward gap to the card's top content edge (Risk R01 — no `tug-popup-list.css` change).
- [ ] Drop `title`/`icon` args from the five content components' `TugPopupListFrame` calls ([P07]); titles now come from `PLACARD_TITLES`.
- [ ] Remove `popover`/`popoverRef` and the `TugPopover` wrapper from `TugStatusCell`; keep the `onActivate` path and focus/registration logic; update the cell docstring (drop "Space/Enter open its popover natively" — Space/Enter now fire `onActivate` on the native `<button>`).
- [ ] Rename handle methods to `openContext()` / `openWork()` (set `openPlacard`); update `dev-card.tsx` `slashCommandSurfaces` `context`/`tasks`/`bashes` routes.
- [ ] Port the placard vertical placement (`bottom: calc(100% + gap)`) + width for the log kinds via `className`, reusing the log/state/item/wide width caps.
- [ ] **Rewrite `at0206-z2-popup-list.test.ts`:** its `openPopup`/`closePopup` helpers gate on `.closest('[data-radix-popper-content-wrapper]')` opacity — swap for the in-DOM placard's presence/opacity (the placard is not portaled). Relocate the `.tug-popup-list-title` `title` probe (that chrome is gone; the title now lives in the placard header — assert `.tug-placard-title` instead, or drop the probe). Keep the scroller row-cap assertion (`clientHeight <= 12*24+1`, unaffected) and re-verify the on-screen assertion under the new upward placement. `closePopup` (re-click the cell) works because of toggle-close.

**Tests:**
- [ ] at0206 (rewritten) passes — every Z2 log popup opens/closes via its cell, one at a time, on-screen, scroller-capped.
- [ ] at0219 passes (WORK cell click still opens the list; group labels/kinds intact).

**Checkpoint:**
- [ ] `grep -n "TugPopover" tugdeck/src/components/tugways/tug-status-cell.tsx tugdeck/src/components/tugways/cards/dev-card-telemetry-renderers.tsx` → none.
- [ ] `bunx vite build` succeeds.
- [ ] `just app-test at0206-z2-popup-list.test.ts at0219-work-revamp.test.ts` passes.
- [ ] Manual: clicking TIME then TOKENS shows only one placard; re-clicking TIME closes it; clicking blank canvas dismisses it; each opens under its cell.

#### Step 5: Fold BTW into the host; refold SideQuestionOverlay {#step-5}

**Depends on:** #step-4

**Commit:** `tugdeck(dev-card): BTW as an auto-dismiss placard in the shared host`

**References:** [P05] Single host (#p05-single-host), [P06] Anchor + no reposition (#p06-anchor), [Q01] (#q01-btw-drag), (#imperative-replumb), (#surface-inventory)

**Artifacts:**
- `SideQuestionOverlay` as a pure body (no `TugPinnedPanel`, no `open` state).
- BTW folded into `openPlacard` (`"btw"`), `dismiss="auto"`, `reposition={false}`, anchored under the BTW cell.
- `DevTelemetryStatusRowHandle.openSideQuestions()`; removed `sideQuestionOverlayRef` + `<SideQuestionOverlay>` mount + `onOpenSideQuestions` wiring in `dev-card.tsx`.
- Updated `at0215-route-chrome.test.ts` (the `?`-route side-question section).

**Tasks:**
- [ ] Strip `SideQuestionOverlay`'s `TugPinnedPanel`, `open`/`useImperativeHandle`, `persistKey`, and drag/right-align CSS; export it as the placard body (question/answer rows + footer) consuming the store via `useSyncExternalStore`.
- [ ] In the host, render the BTW body when `openPlacard === "btw"`; the BTW cell's `onActivate` sets the slot (toggle-close, [P05]) and passes its measured `anchorLeft`.
- [ ] Add `openSideQuestions()` to the handle (sets `openPlacard = "btw"`); update `dev-card.tsx` `btw` slash route to call it; remove `sideQuestionOverlayRef`, the `<SideQuestionOverlay ref=…>` mount, and the `onOpenSideQuestions` prop plumbing.
- [ ] Update `side-question-overlay.css` to drop `.side-question-pane` placement/width/drag rules (placement now owned by the host placard). Keep the inner question/answer row selectors (`.side-question-question`, `.side-question-answer`, `[data-slot="side-question-body"]`) — at0211/at0215 read those.
- [ ] **Update `at0215-route-chrome.test.ts`:** its `?`-route section waits on `.side-question-pane` (removed). Retarget to the BTW placard (`.tug-placard` mounting `[data-slot="side-question-body"]`, or the body selector directly); the transcript-untouched assertion is unchanged. If it asserted pinned persistence, drop that (BTW is now auto-dismiss).

**Tests:**
- [ ] at0215 (updated) passes — the `?`-route opens the BTW placard and the exchange never enters the transcript.
- [ ] at0211 rewrite deferred to #step-6 (the drag/persist/pinned inversion lands there per [P08]).

**Checkpoint:**
- [ ] `grep -rn "SideQuestionOverlayHandle\|sideQuestionOverlayRef\|side-question-pane" tugdeck/src` → none (handle folded into the row; pane class removed).
- [ ] `bunx vite build` succeeds.
- [ ] `just app-test at0215-route-chrome.test.ts` passes.
- [ ] Manual: `/btw x` opens the BTW placard under the BTW cell; clicking away dismisses it; opening TIME closes BTW.

#### Step 6: Rewrite at0211; integration verify {#step-6}

**Depends on:** #step-5

**Commit:** `test(at0211): BTW placard is auto-dismiss, one-at-a-time, under-cell`

**References:** [P08] Test sequencing (#p08-test-sequencing), [P05] (#p05-single-host), [P06] (#p06-anchor), [Q01] (#q01-btw-drag), (#success-criteria)

**Artifacts:**
- Rewritten at0211 reflecting the new BTW behavior.

**Tasks:**
- [ ] Remove the horizontal-drag + tugbank-persistence assertions (no reposition; [Q01]).
- [ ] Invert the "click away does NOT dismiss" assertion → "click away DOES dismiss"; remove the `[data-placard-close]` close path (auto-dismiss has no `×`) and close via click-away instead.
- [ ] Replace the "right-aligned above Z2" geometry with an "under the BTW cell, above Z2, clamped in card" assertion (compare the placard's left against the BTW cell's left within a tolerance).
- [ ] Add a one-at-a-time assertion: open BTW, then click a log cell (e.g. TIME) → the BTW body is gone and the TIME list is shown.
- [ ] Keep the transcript-invisibility invariant assertions (unchanged) and the BTW-count assertions.

**Tests:**
- [ ] at0211 (rewritten) passes.
- [ ] Full affected suite green together (regression sweep): at0206, at0211, at0215, at0219, at0192, at0084.

**Checkpoint:**
- [ ] `bunx vite build` succeeds.
- [ ] `just app-test at0206-z2-popup-list.test.ts at0211-btw-side-question-overlay.test.ts at0215-route-chrome.test.ts at0219-work-revamp.test.ts at0192-z2-cold-replay.test.ts at0084-dev-lifecycle-coordination.test.ts` passes.
- [ ] `grep -rn "pinned-panel\|PinnedPanel\|TugPopover" tugdeck/src/components/tugways/tug-status-cell.tsx tugdeck/src/components/tugways/cards/dev-card-telemetry-renderers.tsx` → clean.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A single `TugPlacard` surface backing all six Z2 status-row popups — consistent redesigned header, one open at a time, anchored under the triggering cell, dismissed by clicking away — with a documented `dismiss`/`reposition` API for future case-by-case use.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] No `TugPinnedPanel`/`pinned-panel` symbols/classes/slots remain except the retained tugbank domain string. (grep)
- [ ] No `TugPopover` in `tug-status-cell.tsx` or `dev-card-telemetry-renderers.tsx`. (grep)
- [ ] All six Z2 surfaces render as `TugPlacard`; one open at a time; re-click closes; click-away dismisses; each opens under its cell. (at0206 + at0211 + manual)
- [ ] Header is centered, icon-less, reduced-height, on the raised (non-titlebar) tint, `×` only for `dismiss="explicit"`. (visual + CSS grep)
- [ ] `bunx vite build` + the full affected suite (`at0206 at0211 at0215 at0219 at0192 at0084`) green. (commands)

**Acceptance tests:**
- [ ] at0206, at0211, at0215 (rewritten/updated) and at0219, at0192, at0084 (regression) all pass.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Revisit whether the `reposition` axis should be removed entirely if no surface ever adopts it.
- [ ] Consider a shared `TugPlacard` gallery entry once the header design settles.

| Checkpoint | Verification |
|------------|--------------|
| Rename complete | `grep -rn "PinnedPanel\|pinned-panel" tugdeck/src tests` clean but for the domain string |
| Portal removed | `grep -n "TugPopover"` in the two target files → none |
| Behavior unified | rewritten at0211 passes (auto-dismiss, one-at-a-time, under-cell) |
| Build gate | `bunx vite build` succeeds |
