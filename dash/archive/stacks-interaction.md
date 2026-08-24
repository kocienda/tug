# Stack Interaction — navigating the panes piled in one slot {#stacks-interaction}

**Purpose:** Give a slot's stack of imposed panes a local switching surface — a title-bar badge that shows the stack's depth, a picker that lists every pane in the slot, and a ⌘R chord that opens it — so a buried card can be brought to the front without a trip to the Lens.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-04 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The deck's layout imposer arranges panes into numbered **slots**, and [D121] settled that **slots are stacks**: any number of panes may hold one slot, assignment always raises, and the pane on top is the one you see. `pane-model.md` states the same rule — *"a slot is a vertical stack whose top Pane is visible, and the Lens list is the switching surface."*

The Lens list is the *only* switching surface today, and it is a remote one. A user looking at a slot has no way to tell from the deck that anything is behind the pane in front of them, and no way to reach it without leaving the card they are looking at, opening the rail, and finding the row. Worse, the deck actively hides the evidence: `pane-occlusion-controller.ts` stamps a fully-covered pane `data-occluded="true"` and CSS turns that into `visibility: hidden`, so a buried pane contributes not one pixel — not an edge, not a shadow — to say it exists.

This plan adds the local surface. A **stack badge** in the title bar makes the depth visible at rest and is the pointer target; a **stack picker** lists every pane in the slot and raises the one you choose; and **⌘R** ("reveal") opens the picker from the keyboard. The chord is free because this plan frees it: `Maker ▸ Reload` moves from ⌘R to ⇧⌘R.

#### Strategy {#strategy}

- **Derive, never store.** A slot's stack is `DeckState.panes` filtered by `slot`, ordered by the array's own z-order. Nothing new is persisted and no serialization version moves.
- **Render the picker from store data, not from resurrected DOM.** Buried panes are `visibility: hidden`; a picker built from the store never has to negotiate with the occlusion controller.
- **Compose the components that exist.** The picker is a `TugPopupMenu` — the same component the title bar's `…` menu already uses — and the badge is a `TugButton` acting as its trigger. No hand-rolled menu, no hand-rolled list focus.
- **Reach the pane the way the X button does.** `TugPane` already answers `CLOSE_PANE` by calling `titleBarRef.current?.requestClose()`. The reveal chord takes the identical path to a new `revealStack()` handle — which is also the one chain action a headless app-test is known to be able to drive.
- **Resolve the pointer gesture where it is already parked.** The drag machine's pointer-up has a branch for "the pointer never travelled, so this was a click on the title bar." Cmd-click opens the picker from inside that branch rather than from a second handler the frame's pointer capture would hide the events from ([P05]).
- **Own the chord at the menu bar.** AppKit resolves a menu key equivalent before the `WKWebView` ever sees a keydown, so ⌘R must be a menu item to fire reliably. Free it first, in its own commit, before anything depends on it.
- **Find out what the test tier can see before writing the tests.** Two mechanisms this feature rides — the rAF-gated drag threshold and the WAAPI-gated menu selection — are the kind that pass by not running. Spec S07 settles the first from the code and probes the second at Step 3.
- **Sequence so each commit stands alone:** free the chord ∥ derive the stack ∥ ready the menu → build the picker → wire the pointer path → wire the chord → gate its enablement → test → document. The first three are independent of one another.

#### Success Criteria (Measurable) {#success-criteria}

- A pane sharing its slot with one or more other panes renders a stack badge in its title bar carrying the slot's pane count; a pane alone in its slot, a free (unslotted) pane, and the Lens render none. (app-test: assert `[data-testid="tug-pane-title-bar-stack-badge"]` presence and text across a seeded deck with a 2-deep slot, a 1-deep slot, a free pane, and the Lens.)
- Clicking the badge opens a menu listing every pane in that slot, topmost first, with the front pane check-marked. (app-test: count `[role="menuitem"]` rows in the opened menu; assert the labels and the checked row.)
- Choosing a non-front row raises that pane: it becomes the deck's first responder and its frame carries the highest `z-index` of the slot. (app-test: `getFocusedCardId()` and a `z-index` read on both frames.)
- Cmd-clicking a title bar opens the same picker and does **not** raise the pane it was clicked on. (app-test: `click(selector, { metaKey: true })`, then assert the menu is open and `getFocusedCardId()` is unchanged.)
- Cmd-dragging a title bar still moves the pane (and still evicts it from its slot); it does not open the picker. (app-test, **foreground tier** per Spec S07: native drag with the command modifier; assert the frame moved and no menu is present.)
- ⌘R opens the picker for the focused pane and a second ⌘R closes it; the `Window ▸ Reveal Stack` item is validated **disabled** when the focused pane is free, is the Lens, or is alone in its slot. (app-test: `menuItemState("window.revealStack")` across the same seeded deck; `nativeKey("r", ["cmd"])` for the live chord.)
- `Maker ▸ Reload` fires on ⇧⌘R and nothing fires on ⌘R in the Maker menu. (at0168's static structure table.)

#### Scope {#scope}

1. Move `Maker ▸ Reload` from ⌘R to ⇧⌘R, freeing ⌘R.
2. Derive each slot's stack in `DeckCanvas` and hand every pane its stack depth and membership.
3. Add an optional controlled `open` / `onOpenChange` pair to `TugPopupMenu`.
4. Add the stack badge and the stack picker to `CardTitleBar`.
5. Open the picker on a Cmd-click of the title bar (click, not drag).
6. Add `Window ▸ Reveal Stack` (⌘R) and route it through the responder chain to the focused pane's picker.
7. Publish `stackDepth` in the host menu-state payload and validate the menu item against it.
8. App-tests and documentation.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Cycling the stack.** ⌃\` (`Window ▸ Cycle Panes`) stays a deck-wide cycle and is not touched. Repeated ⌘R + arrow + Return is the keyboard path through a stack; no per-slot cycle chord is added.
- **Any behavior for free (unslotted) panes.** This feature is about imposed panes. A free pane has no slot, therefore no stack, therefore no badge and no enabled chord. There is no "most recently active stack" fallback.
- **Cmd-click in the content area.** The meta modifier in a pane's content area keeps its existing meaning — interact with a background pane without raising it (`gesture-interpreter.ts`'s `meta` branch) — and this plan does not repurpose it.
- **Reviving buried panes' DOM.** The picker never asks the occlusion controller to reveal anything; no `paneOcclusionGesture.begin()` bracketing is introduced.
- **Changing how panes enter or leave a slot.** `assignCardToSlot`, the ⌘1..⌘9 chords, the Lens `SlotPicker`, and drag/resize eviction are all unchanged.
- **A tab strip.** The picker is a transient menu opened by a gesture. Nothing persistent is added to the title bar beyond the badge itself.

#### Dependencies / Prerequisites {#dependencies}

- The layout imposition system as it stands: `lib/layout-imposer.ts`, `TugPaneState.slot`, and [D121].
- `TugPopupMenu` (`components/tugways/internal/tug-popup-menu.tsx`) and `TugButton`.
- The host menu-state channel: `lib/host-menu-state.ts` ⇄ `AppDelegate.swift`'s `MenuState` struct and `validateMenuItem(_:)`.
- The responder chain's `useResponder` registration in `TugPane` and the `CardTitleBarHandle` imperative bridge.

#### Constraints {#constraints}

- **Warnings are errors** in the Rust workspace; this plan touches no Rust, but `bunx tsc --noEmit` and `bunx eslint` must stay clean, and `bunx vite build` must succeed before any tugdeck change is called done (the debug app loads the production rollup bundle).
- **AppKit resolves menu key equivalents before the web view sees the keydown.** Anything that must work as a global chord has to be a menu item, not only a `keybinding-map.ts` entry.
- **`:has()` does not invalidate on a descendant attribute change in WebKit** — if any styling needs to react to stack depth, the bit must be mirrored onto the element that carries the selector, not read through a descendant.
- **Background app-test windows run no rAF and throttle DOM timers**, so no assertion may hang off an animation completing. Menu-open assertions must poll for the menu element, not wait a fixed animation duration.
- **App-tests are selective.** `just app-test-changed` derives the run from the working diff via `@covers`; the full corpus is never run on the implementer's own initiative.

#### Assumptions {#assumptions}

- Pane z-order is the `DeckState.panes` array order, **last element topmost**. This is what `projectDeckState` in `lib/host-menu-state.ts` encodes (`focusedStack = stacks[stacks.length - 1]`, then `.reverse()` to publish topmost-first) and what `DeckCanvas` renders `z-index` from.
- `store.activateCard(cardId)` promotes the card's host pane to the top of the `panes` array. `focusCard` reorders z only and skips the lifecycle events; `transferFocusForActivation` wrapping `activateCard` is the full raise (`assignCardToSlot` is the reference call site).
- The Lens pane never carries a slot — `validateDeckState` invariant 6 rejects it — so every Lens exclusion in this plan is structural rather than a special case that has to be written.
- A pane's `slot` is already clamped to the active imposition kind by `clampSlot` at every write, so grouping by raw `slot` value is safe.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan uses explicit `{#anchor}` headings, `[P##]` for plan-local decisions (`[D##]` is reserved for the global `tuglaws/design-decisions.md`), and `**References:**` lines citing artifacts and anchors — never line numbers.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Should the badge show on every pane in the stack, or only the frontmost? (DECIDED) {#q01-badge-on-every-pane}

**Question:** Every pane in a slot shares the same depth. Does each one render a badge, or only the pane currently on top?

**Why it matters:** Panes in one slot may have different widths ([D121]: the imposer never touches a pane's width), so a wider buried pane is *not* fully covered and therefore is not occluded — it peeks out, title bar and all, and would show a second badge.

**Resolution:** DECIDED — see [P02]. Every pane in the stack renders the badge. The badge describes *the slot*, and a visible pane in that slot telling the truth about its slot is correct; suppressing it on all but the top pane would mean a peeking pane's title bar lies about where it is. Occlusion hides the badge along with everything else on a covered pane, so the common case shows exactly one.

#### [Q02] Does the reveal chord need to work when the deck is deselected? (DECIDED) {#q02-deselected-deck}

**Question:** A canvas-background click deselects — `activePaneId` is cleared and `getFirstResponderCardId()` returns null. Should ⌘R do anything then?

**Why it matters:** The host already special-cases a deselected deck for the card/pane navigation commands (`validateMenuItem` enables them when `!selectionActive && !panes.isEmpty` so the keyboard can re-enter the deck).

**Resolution:** DECIDED — see [P07]. No. Reveal Stack acts on *a specific pane's* stack; with nothing selected there is no such pane, and a command that silently picks one for the user is the "non-obvious target" failure. `stackDepth` is published as 0 when nothing is selected and the item validates disabled.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| ⌘R shadowing something unnoticed | med | low | at0168's static table is asserted by identifier + key + modifier mask; the Reload move and the new item both land in it | any new `keyEquivalent: "r"` |
| Cmd-click steals Cmd-drag on the title bar | med | med | resolve in the drag machine's existing no-travel branch, which already distinguishes the two ([P05]) | a report that a background pane can't be Cmd-moved |
| Controlled-open change destabilizes every existing popup menu | high | low | the new props are optional; absent them the component keeps its exact current uncontrolled behavior ([P06]) — **and Step 3 gives the component the `@covers` line it has never had**, so the regression is detectable | any menu regression after Step 3 |
| An app-test certifies a behavior the tier cannot exercise | high | med | Spec S07: the rAF-gated drag threshold is known and takes the foreground tier; the WAAPI-gated selection path is probed at Step 3, before at0347 is written | any new assertion that depends on a frame or an animation completing |
| Badge crowds the title bar at six-up widths | low | med | ghost icon button on the existing control rhythm, hidden entirely at depth 1 | a six-up deck with long titles |

**Risk R01: The picker raises a pane the user cannot then see** {#r01-raise-invisible}

- **Risk:** Choosing a row raises a pane whose frame is narrower than the pane it replaced, leaving a sliver of the previously-front pane still painted beside it and an ambiguous "which one is front" picture.
- **Mitigation:**
  - This is [D121]'s existing, accepted geometry — overlap is ordinary, and the same picture already results from a ⌘N slot assignment or a Lens row click.
  - The raise runs through `transferFocusForActivation`, so the newly-front pane's title bar takes its activated appearance and the outgoing one loses it; the active-pane treatment is the disambiguator that already exists.
- **Residual risk:** A user with wildly mismatched pane widths in one slot sees a busier composition than a same-width stack. Unchanged from today.

**Risk R02: `stackDepth` churns the menu-state wire** {#r02-menu-state-churn}

- **Risk:** A new field on the menu-state payload fires an extra post on every deck mutation that changes it.
- **Mitigation:**
  - `HostMenuStatePublisher` diffs the serialized projection and coalesces on a microtask; a field that does not change costs nothing.
  - `stackDepth` changes only when the focused pane changes or a slot's occupancy changes — strictly less often than `panes` itself, which is already published.
- **Residual risk:** None material.

---

### Design Decisions {#design-decisions}

#### [P01] A slot's stack is derived from `DeckState.panes`, never stored (DECIDED) {#p01-stack-is-derived}

**Decision:** The stack of a slot `k` is `state.panes.filter(p => p.slot === k)`, in the array's own order (last = topmost). No new field is added to `TugPaneState`, `DeckState`, or the serialized blob.

**Rationale:**
- The membership and the order are both already fully determined by state the deck owns; a stored copy could only ever disagree with it.
- [D121] already establishes that assignment raises and that `panes` order is z-order. Deriving keeps the new surface automatically correct across `assignCardToSlot`, drag/resize eviction, kind changes (which clamp slots), and pane close.
- No serialization version moves, so no migration and no restore-path risk.

**Implications:**
- A new pure selector, `slotStackOf(state, slot)`, joins `findLensPane` in `deck-store-selectors.ts` and is unit-testable without a DOM.
- `DeckCanvas` computes it once per render for every slotted pane — the same vantage point that already resolves `placement`, because (as `TugPaneProps.placement` documents) a pane cannot work out chain-wide facts from its own state.
- What reaches the pane is **not** the raw `TugPaneState[]` but a display-resolved `SlotStackEntry[]` (Spec S06): titles and the topmost flag are resolved by `DeckCanvas`, so `CardTitleBar` needs no store access to render its menu.

#### [P02] Every pane in a stack renders the badge (DECIDED) {#p02-badge-on-every-pane}

**Decision:** The badge renders on any pane whose slot holds more than one pane, front or buried, and is hidden when the slot holds exactly one, when the pane is free, and on the Lens.

**Rationale:**
- The badge is a statement about the *slot*, and a pane that is visible is entitled to tell the truth about the slot it stands in ([Q01]).
- Panes in one slot may differ in width, so a buried pane can be partially visible; suppressing its badge would make the one title bar the user can see the one that stays silent.
- Occlusion already solves the common case: a fully covered pane is `visibility: hidden`, badge included, so a same-width stack shows exactly one badge.

**Implications:**
- The badge's render condition is `stackDepth > 1` and nothing else — no "am I the top?" test, which would need a second cross-pane fact.

#### [P03] The picker is built from store data, never from revealed DOM (DECIDED) {#p03-picker-from-store}

**Decision:** The picker's rows come from the derived stack's `TugPaneState` records (title resolved the same way `projectDeckState` resolves it: `pane.title || activeCard.title || firstCard.title || "Untitled"`). Nothing in this feature asks the occlusion controller to reveal a pane.

**Rationale:**
- `pane-occlusion-controller.ts` gives a fully-covered pane `visibility: hidden` precisely so WebKit can drop its tile backing. "Show the title bars underneath" as live DOM would mean bracketing the gesture with `paneOcclusionGesture.begin()` / `.end()`, un-hiding every pane on the deck for the duration, and re-hiding them on a settle timer — a large, timing-sensitive cost for a list of strings the store already holds.
- A menu is also the better answer to the original question ("let me pick one of these") than a pile of peeking title bars, which would have to be disambiguated by geometry the deck deliberately allows to overlap.

**Implications:**
- The picker works identically whether the buried panes are occluded, partially visible, or offscreen.
- Title resolution logic is duplicated in two places (the menu-state projection and here); the plan factors it into one exported helper rather than copying it (see [#symbols]).

#### [P04] Selection raises through `transferFocusForActivation` + `activateCard` (DECIDED) {#p04-raise-path}

**Decision:** Choosing a picker row runs:

```ts
transferFocusForActivation({
  outgoingCardId: store.getFirstResponderCardId(),
  incomingCardId: pane.activeCardId,
  store,
  commitMutation: () => store.activateCard(pane.activeCardId),
});
```

**Rationale:**
- This is exactly what `assignCardToSlot` does for its raise, and its comment states why: a bare `activateCard` flips the first responder but skips the focus transfer, so the outgoing card never saves its focus bag and the incoming card never receives its focus claim (no caret until the user clicks into it).
- `focusCard` alone is the wrong tool — it reorders z-index and persists the pointer but fires no lifecycle events.

**Implications:**
- The picker's raise is indistinguishable from a Lens row click or a ⌘N assignment, which is the point: one gesture vocabulary.
- Selecting the row that is already front is a same-bit refresh, which `activateCard` documents as a no-op that still refreshes the persisted pointer — acceptable, no special case needed.

#### [P05] Cmd-click opens the picker on pointer-up without travel; Cmd-drag still drags (DECIDED) {#p05-cmd-click-not-drag}

**Decision:** The Cmd-click decision is resolved **in the drag machine's own no-travel branch**, not by a second gesture handler. `handleTitleBarPointerDown` calls `onDragStart` on a meta-modified press exactly as it does today; `handleDragStart` records `event.metaKey` in a ref alongside the origin it already snapshots; and `onPointerUp`'s existing `if (!dragMoved.current)` early return — the branch whose comment already reads *"The pointer never travelled, so this was a click on the title bar"* — opens the picker when that ref is set. A drag past the threshold latches `dragMoved` and the branch is never reached, so Cmd-drag is untouched.

**Rationale:**
- Cmd-drag on a title bar is meaningful today and must survive: for a free pane it is the Mac convention of moving a background window without raising it, and for an imposed pane the drag is how it is *evicted* from its slot (`handlePaneMoved` with `evictSlot`). Opening a menu on Cmd-*press* would kill both.
- The gesture interpreter already models this exact tension for cross-card activation — "a click and a drag want opposite outcomes here… park the decision; the gesture's ending resolves it" (`activation: "deferred"`). This is the same resolution applied one layer up — and the drag machine has *already* parked exactly this decision, so the resolution is a branch that exists rather than a mechanism that has to be built.
- **A pointer-up handler on `CardTitleBar` could not see the release at all.** `handleDragStart` calls `frame.setPointerCapture(...)` on pointerdown and attaches its move/up listeners to the frame; while that capture is held every pointer event retargets to the frame, so the title bar is off the propagation path. (`handleClosePointerUp` works only because the close *button* takes the capture itself.)
- **Deferring `onDragStart` until travel — the obvious alternative — costs three things.** The title bar would need its own capture and its own move listener; it would have to hand a native `PointerEvent` to a callback typed `(event: React.PointerEvent) => void` that reads `event.nativeEvent.pointerId`; and `captureFocusForDragStart` would run *after* the mousedown blur it exists to beat, losing the active card's focus bag on every Cmd-drag.

**Implications:**
- Nothing new tracks travel or containment: `DRAG_MOVE_THRESHOLD_PX` and the capture-scoped release are the drag machine's, reused rather than restated. A release outside the title bar is a release outside the *frame*'s capture only if the pointer left the window, which the existing branch already tolerates.
- The picker opens from `TugPane`, which already holds `titleBarRef` — the same handle Step 6's chain action calls. One opener, two callers.
- No change to `gesture-interpreter.ts` is needed or made — see [P10].

#### [P06] `TugPopupMenu` gains an optional controlled `open` / `onOpenChange` pair (DECIDED) {#p06-controlled-popup-menu}

**Decision:** `TugPopupMenuProps` grows optional `open?: boolean` and `onOpenChange?: (open: boolean) => void`. When `open` is `undefined` the component behaves exactly as today (internal `useState` seeded by `defaultOpen`); when supplied, the prop is the source of truth and every internal transition reports through `onOpenChange`.

**Rationale:**
- The keyboard path (⌘R) and the Cmd-click path both need to open the menu without a press on the trigger. The alternatives are worse: synthesizing a click on the trigger element is, in the component's own words about the existing trigger handle, "a guess at whichever DOM event Radix happens to listen on, and a lie about what the user did."
- The component is *already* internally controlled (`const [open, setOpen] = useState(defaultOpen)` bound to the Radix `Root`), so accepting an external value is a small, local change rather than a restructuring.
- `TugPopupMenuTriggerContext` is not the right lever here: it exists so an engine-routed key view can open the menu *it is the trigger for*, and it is consumed by `TugButton`. Our opener is a pane-level action, not a key landing on the badge.

**Implications:**
- Every existing call site (`CardTitleBar`'s `…` menu, `TugPopupButton`, `TugTabBar`'s overflow/add menus, `gallery-popup-button`) is untouched and must keep passing its current props unchanged.
- The controlled value must feed the same `open` variable the focus trap (`useFocusTrap({ active: open })`) and the `observeDispatch` subscription already read, so chain-reactive dismissal and the Escape ladder keep working in controlled mode.

#### [P07] The chord is a menu item, gated by a published `stackDepth` (DECIDED) {#p07-menu-owned-chord}

**Decision:** ⌘R is `Window ▸ Reveal Stack` (`identifier: "window.revealStack"`), firing `sendControl("reveal-stack")`. Its enablement is pulled from a new `stackDepth: number` field on the menu-state payload — the number of panes sharing the *focused* pane's slot, or `0` when the focused pane has no slot, is the Lens, or nothing is selected. The item validates enabled iff `stackDepth > 1`.

**Rationale:**
- AppKit resolves a menu key equivalent before the `WKWebView` sees the keydown — the `SHOW_SETTINGS` handler in `deck-canvas.tsx` documents the converse case (a chord the web layer must own precisely because no menu can be relied on). A chord that must work whenever the app is active belongs on a menu item, exactly as `focusLens` (⌘L) does.
- Pull-based validation from a cached `MenuState` is the established pattern for every conditional item in the bar (`selectionActive`, `session.*`, the Edit capability block).
- A disabled item is silent. An enabled item that no-ops would beep or, worse, look broken.

**⌘R while the picker is already open closes it, and the ordering that makes that deterministic is the chain's, not a race.** An open `TugPopupMenu` subscribes to `manager.observeDispatch` and closes on any chain dispatch that is not its own blink (`blinkingRef` is the sole exemption), and `REVEAL_STACK` travels the chain — so the chord's own dispatch reaches that observer. Two facts settle the outcome. First, `sendToFirstResponder` walks the chain and *then* calls `notifyDispatchObservers`, so the responder action always runs before any observer. Second, the subscription is gated on `open`, so a closed menu has no observer registered at all. `revealStack()` therefore **toggles** — `setStackMenuOpen((prev) => !prev)`, guarded by `slotStack.length > 1` — and both paths are single-valued: open → the toggle queues `false`, the observer then queues `false` again, the menu closes; closed → no observer exists, the toggle queues `true`, the menu opens. A chord that opens a surface should close it, and here that is also the only outcome the dispatch order permits.

**Implications:**
- `MenuStateDeckProjection` and `MenuStatePayload` grow one number; `MenuState` in `AppDelegate.swift` grows the matching `var stackDepth: Int = 0` and parses it.
- `Window ▸ Reveal Stack` sits beside `Previous Card` / `Next Card` / `Cycle Panes`, the existing pane-navigation cluster.
- The item's title stays `Reveal Stack` in both states. A verb that flips with visibility (the `session.toggleChanges` pattern) would need the open/closed bit on the menu-state wire, and a transient menu's open state is not something the host should be told about.

#### [P08] The badge is a layers glyph plus the count, and it is the picker's trigger (DECIDED) {#p08-badge-form}

**Decision:** The badge is a ghost `TugButton` (`subtype="icon-text"`, `emphasis="ghost"`, `role="action"`, `size="sm"`) rendering a `Layers` icon and the stack depth as its label, `data-testid="tug-pane-title-bar-stack-badge"`, placed at the head of `.tug-pane-title-bar-controls` — before the `…` menu, the collapse chevron, and the close box. It is the `TugPopupMenu` trigger.

`icon-text` is the subtype that carries both, and it is the one the component defines for this: `subtype="icon"` is the **square, icon-only** button, and passing it a label would render nothing. The icon rides `icon`, the count rides `children`, and the `aria-label` below is still required because the visible label is a bare number.

**Rationale:**
- One affordance that reads the same at depth 2 and depth 6, unlike a dot row which grows and stops being countable at a glance.
- A `TugButton` in the controls cluster inherits the title bar's existing button rhythm, hit target, and focus treatment; `TugBadge` is a non-interactive `<span>` and would have to be wrapped to be clickable, which is the hand-rolling the component set exists to prevent.
- Making the badge the trigger means the pointer path needs no separate open plumbing — Radix wires it — and only the keyboard and Cmd-click paths use the controlled prop from [P06].

**Implications:**
- The icon comes from `lucide-react`, which the title bar already imports (`MoreHorizontal`, `ChevronUp`, `ChevronDown`).
- Because the button carries state-dependent content (the count), it does not need width stabilization *per gesture* — the count changes only when the deck changes, not on click — but its minimum width should clear a two-digit count so a 10-deep slot does not reflow the controls.

#### [P09] Vocabulary: "slot stack", never bare "stack", in new code (DECIDED) {#p09-naming}

**Decision:** New symbols use `slotStack` / `stackDepth` / `revealStack`. The bare noun `stack` is not introduced as a variable name in any file this plan touches.

**Rationale:**
- `stack` is already overloaded in this codebase as a legacy synonym for *pane*: `TugPaneProps.stackState`, `stackCards`, `stackId`, and `projectDeckState`'s `const stacks = state.panes`. Thirty-odd live references.
- [D121] and `pane-model.md` nevertheless use "stack" in prose for exactly the thing this plan surfaces ("slots are stacks", "a slot is a vertical stack whose top Pane is visible"), so the *user-facing* word is right and only the *code* word is contested.
- `slotStack` is unambiguous against both.

**Implications:**
- User-visible strings say "Stack" (`Window ▸ Reveal Stack`); identifiers say `slotStack`.
- The legacy `stackState`/`stackId` names are not renamed by this plan — that is a separate sweep and would bloat every diff here.

#### [P10] No change to `gesture-interpreter.ts` (DECIDED) {#p10-no-interpreter-change}

**Decision:** The gesture interpreter's meta branch is left exactly as it is.

**Rationale:**
- Its `else if (event.metaKey) { reasons.push("meta") }` branch suppresses *activation* on a meta-modified press — "Mac convention: interact with a background window without raising it." That is precisely the behavior the Cmd-click path wants: open a pane's picker without raising that pane.
- The title bar already carries `data-tug-fr-preserve`, so the interpreter also skips chain promotion there; a menu opening from the title bar inherits the correct focus posture with no new marker.
- Adding a title-bar carve-out would mean teaching the interpreter about a surface it currently classifies generically — new coupling for no behavior change.

**Implications:**
- Cmd-click on the *front* pane's title bar opens the picker without activating that pane. Picking a row then raises the chosen one. Coherent, and the un-raised state is visible feedback that the click was a "look, don't touch" gesture.

---

### Deep Dives {#deep-dives}

#### How z-order is read and written {#z-order}

The deck stores z-order as the *order of the `panes` array*, last element topmost. Three facts follow, and every part of this plan rests on them:

1. **Reading the front pane of a slot:** filter `panes` by `slot`, take the **last** match. The picker lists rows in reverse array order so the topmost pane is the first row — the same convention `projectDeckState` publishes to the host (`.reverse()` after mapping, documented as "z-order topmost first").
2. **Writing a raise:** `store.activateCard(cardId)` promotes the card's host pane to the end of the array. `DeckCanvas` renders each frame's inline `z-index` from that order in the same commit, and `pane-occlusion-controller.ts` reads the `z-index` back off the frames in its `useLayoutEffect` — so a raise reveals the newly-front pane synchronously, in the same paint. No occlusion coordination is needed on our side.
3. **Nothing else moves.** A raise is not an arrangement change: `assignCardToSlot`'s comment notes that z-order moves nothing and therefore arms no imposer settle window. The picker's raise is geometry-free.

#### Why the front pane's peers are invisible, and why that is fine {#occlusion-interaction}

`pane-occlusion-controller.ts` stamps `data-occluded="true"` on a pane whose frame rect is fully covered by a single opaque pane above it, and `tug-pane.css` turns that into `visibility: hidden` across the subtree. The controller is deliberately asymmetric: **reveals are synchronous** (applied in a `useLayoutEffect` after every store commit, so the compositor never shows an exposed-but-hidden pane) while **hides are lazy** (a settle delay, deferred while any frame is animating).

For this plan that means:

- A raise from the picker un-hides the newly-front pane **in the same paint as the store commit**. There is nothing to wait for and nothing to bracket.
- The pane that was in front is hidden only after the settle delay, which is invisible to the user and irrelevant to any assertion this plan makes.
- The containment test is conservative — single-coverer only, alpha and radius checked, "when it cannot prove coverage it leaves the pane visible." So a *partially* covered pane in a stack stays visible, badge and all, which is [P02]'s case.

An app-test asserting badge counts must therefore not assume buried panes are unqueryable: `visibility: hidden` elements are still in the DOM and `querySelector` still finds them. Assert on the *visible* set by reading `getComputedStyle(el).visibility` or by seeding same-width panes and asserting the occluded one carries `data-occluded="true"`.

#### The path a reveal takes, end to end {#reveal-path}

```
⌘R  (AppKit menu key equivalent — resolved before the web view sees a keydown)
 └─ AppDelegate.revealStack(_:)            validateMenuItem gates on menuState.stackDepth > 1
     └─ sendControl("reveal-stack")
         └─ action-dispatch.ts  registerAction("reveal-stack")
             └─ responderChainManagerRef.sendToFirstResponder({ action: REVEAL_STACK, phase: "discrete" })
                 └─ TugPane's useResponder actions map
                     └─ titleBarRef.current?.revealStack()
                         └─ CardTitleBar setStackMenuOpen(prev => !prev)   [P07] toggle
                             └─ TugPopupMenu (controlled open, [P06])
                                 └─ …and then observeDispatch sees this very dispatch
                                     and closes an already-open menu — which is why
                                     the handle toggles rather than sets
```

The last three hops are the `CLOSE_PANE` precedent exactly: `TugPane` answers a chain action by calling an imperative handle on `CardTitleBar`, which owns the transient UI state. `focus-lens` is the precedent for the first three (a menu selector → `sendControl` → `registerAction` → `sendToFirstResponder`).

The two pointer paths are shorter and rejoin at the same handle. The badge click is Radix's own trigger handling — the badge *is* the trigger, so nothing is plumbed for it. The Cmd-click arrives from `TugPane`'s drag pointer-up, in the no-travel branch, and calls `revealStack()` on the same ref the chain action uses ([P05]) — so there is exactly one opener with three callers, not three openers.

---

### Specification {#specification}

#### Terminology {#terminology}

| Term | Meaning |
|------|---------|
| **slot** | A numbered position anchor in the active imposition, 0-based. `TugPaneState.slot`. |
| **slot stack** | Every pane holding the same slot, ordered by `DeckState.panes` (last = topmost). |
| **stack depth** | `slotStack.length`. A free pane and the Lens have depth 0, not 1 — they hold no slot. |
| **reveal** | Open the stack picker. Never means "un-hide DOM". |

**Spec S01: `slotStackOf`** {#s01-slot-stack-of}

```ts
/** Every pane holding `slot`, in z-order (last = topmost). Empty when the
 *  slot is unoccupied. `undefined` slot never matches — a free pane and the
 *  Lens are in no stack. */
export function slotStackOf(
  state: DeckState,
  slot: number | undefined,
): readonly TugPaneState[];
```

Returns `[]` for `undefined`. Pure; lives beside `findLensPane` in `deck-store-selectors.ts`; unit-testable with a hand-built `DeckState`.

**Spec S02: `paneDisplayTitle`** {#s02-pane-display-title}

```ts
/** The title a pane shows in any list: its own, else its active card's,
 *  else its first card's, else "Untitled". */
export function paneDisplayTitle(
  state: DeckState,
  pane: TugPaneState,
): string;
```

Extracted from the fallback chain currently inline in `projectDeckState` (`s.title || activeCard?.title || firstCard?.title || "Untitled"`), which is then rewritten to call it. One rule, two consumers ([P03]).

**Spec S06: `SlotStackEntry` — what a pane is handed about its stack** {#s06-slot-stack-entry}

```ts
/** One row of a slot's stack, already resolved for display. Ordered
 *  topmost-first, matching the host menu-state convention. */
export interface SlotStackEntry {
  /** The pane this row raises. */
  paneId: string;
  /** The card id to activate — the pane's `activeCardId`, resolved at
   *  projection time so the raise needs no second store read. */
  cardId: string;
  /** Display title, from `paneDisplayTitle`. */
  title: string;
  /** True for the pane currently at the front of the slot. */
  topmost: boolean;
}
```

`CardTitleBar` receives `readonly SlotStackEntry[]` and never touches the deck store: it has no access to one, and giving it one would put store reads in chrome that is otherwise driven entirely by props ([L10] — chrome and content stay in their lanes). `DeckCanvas` builds the entries, because it is already the vantage point that resolves `placement` and holds the snapshot.

**Spec S03: menu-state `stackDepth`** {#s03-menu-state-stack-depth}

Added to `MenuStateDeckProjection` and `MenuStatePayload`:

```ts
/** Panes sharing the focused pane's slot. 0 when the focused pane holds no
 *  slot (free pane or Lens) and when nothing is selected. Gates
 *  Window ▸ Reveal Stack, which is enabled iff this exceeds 1. */
stackDepth: number;
```

Computed in `projectDeckState` from the already-resolved `focusedStack`:

```ts
const stackDepth = state.activePaneId === undefined
  ? 0
  : slotStackOf(state, focusedStack?.slot).length;
```

**The invariant this rests on, stated because the two "focused"s are not the same concept.** `projectDeckState`'s `focusedStack` is `panes[panes.length - 1]` (z-order top, the reading behind `getFocusedCardId`), while the chord dispatches to the **first responder**, which is `activePaneId`'s pane (`getFirstResponderCardId`). The gate and the action agree because every raise path moves the pane to the end of the array *and* writes `activePaneId` in the same commit — `_commitStandardFirstResponderFlip` splices-and-pushes, and `focusCard` does the same — so whenever `activePaneId` is set, its pane **is** the last element. The `undefined` guard above covers the one state where they part: a deselected deck, where the array still has a last element and no pane is the first responder. If a future path ever sets `activePaneId` without re-ordering, this formula is where it will show up, and the unit test below (`stackDepth` 0 when `activePaneId` is undefined) is the tripwire.

Swift side: `var stackDepth: Int = 0`, parsed as `payload["stackDepth"] as? Int ?? 0`.

**Spec S04: `TugPopupMenu` controlled open** {#s04-controlled-open}

```ts
/** Controlled open state. Omit for the uncontrolled behavior every existing
 *  call site relies on. When supplied, this prop is authoritative and every
 *  internal transition — trigger press, Escape, click-outside, chain
 *  dismiss, item activation — reports through `onOpenChange` instead of
 *  writing local state. */
open?: boolean;
onOpenChange?: (open: boolean) => void;
```

Implementation shape:

```ts
const [openInternal, setOpenInternal] = useState(defaultOpen);
const isControlled = openProp !== undefined;
const open = isControlled ? openProp : openInternal;
const setOpen = (next: boolean): void => {
  if (!isControlled) setOpenInternal(next);
  onOpenChange?.(next);
};
```

Every existing `setOpen(...)` call inside the component then routes through this one function, so the focus trap (`useFocusTrap({ active: open })`), the `observeDispatch` dismissal, the `openSubKey` reset effect, and the blink-then-close selection path all keep reading and writing the same value they do today.

**Spec S05: `CardTitleBarHandle.revealStack`** {#s05-reveal-stack-handle}

```ts
/** Toggle the stack picker. Opens it as if the badge had been clicked;
 *  closes it when it is already open, which is also what the chord's own
 *  chain dispatch would do to it ([P07]). No-op when the pane holds no slot
 *  or its slot holds one pane (no badge is rendered, so there is no anchor). */
revealStack: () => void;
```

Joins `requestClose` / `requestCloseWith` on the existing handle.

**The open state must not outlive the badge.** `stackMenuOpen` can be `true` at the moment the badge stops rendering: a peer in the slot closes (⌘W, the X box), a drag evicts one, or a kind change clamps a slot — any of which drops `slotStack.length` to 1 while the menu is up. The trigger then unmounts with the menu open, so `useFocusTrap`'s `onCloseAutoFocus` never runs (the keyboard focus is left on a removed node) and the stale `true` means the badge mounts *already open* the next time this pane joins a stack. `CardTitleBar` therefore closes it on the way down:

```ts
useEffect(() => {
  if (slotStack.length <= 1) setStackMenuOpen(false);
}, [slotStack.length]);
```

This is the [P01] derivation paying off in the other direction: the picker's existence and its contents both follow the store, so the collapse case needs no notification — the prop it already reads is the signal.

**Spec S07: which tier each assertion runs in, and the probe that decides** {#s07-test-tier}

Background app-test windows run **no rAF** and throttle DOM timers. Two things this feature is built on live on the wrong side of that line, and both must be settled before at0347 is written rather than after.

**Known — the drag threshold is rAF-gated.** `dragMoved.current = true` is set *only* inside `applyDragFrame`, which runs from `requestAnimationFrame`. In a background window a synthetic Cmd-drag therefore never latches as a move: it falls into the no-travel branch and — under [P05] — **opens the picker**. So at0347's "the frame moved and no menu is present" would fail on both halves, and would do so by inverting the feature rather than by missing it. That case runs `foreground: true`, or not at all.

**Unknown — item selection is gated on a WAAPI promise.** `handleItemSelect` fires the caller's `onSelect` only inside `animate(target, blinkKeyframes, …).finished.then(...)`, a 350ms blink. Whether that promise resolves in a background window is not something this plan should guess at, and there is no precedent to inherit: **no test in the corpus opens a `TugPopupMenu` and clicks a row.** Every selection assertion in at0347 — and the ⌘R + arrow + Return keyboard path the non-goals name as the way through a stack — hangs off the answer.

**The probe, run at #step-3:** in a scratch app-test, open the title bar's existing `…` menu on a seeded card, click one of its rows, and assert the item's effect landed. Cheap, and it is the only thing that has to happen in a particular order for Step 8 to be writable.

**RESOLVED at #step-3 — selection lands in the background tier.** No scratch test was needed: `at0055-popup-close-restores-editor-focus.test.ts` already opens a `TugPopupMenu`, clicks one of its rows, and asserts the whole post-blink cascade (`.finished` → `onSelect` → `setOpen(false)` → `onCloseAutoFocus` → focus back on the editor's `contentDOM`). It runs, and passes, in the background group. The WAAPI blink promise therefore resolves without a frame, and the first row of the table below is the one that applies: **at0347 is one file**, and only the Cmd-drag case carries `foreground: true`. at0349 is not needed.

| Probe result | at0347 |
|---|---|
| Selection lands in the background tier | One file. Only the Cmd-drag case carries `foreground: true`. |
| Selection needs a foreground window | Split: at0347 keeps the badge, `data-stack-depth`, menu-opens, and row-contents assertions in the background tier; a foreground at0349 takes row selection, the raise, and Cmd-drag. |

Either way the split runs along one line — **what can be observed without a frame, versus what needs one** — and the file that needs a frame declares `foreground: true` and earns it, per the harness's own `@foreground` convention.

#### State Zone Mapping {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| Slot stack membership + order | structure (derived, not new) | `slotStackOf` over the `useSyncExternalStore` deck state in `DeckCanvas`, inside the `useMemo` that already builds `sortedStacks` / `zIndexMap`; passed to `TugPane` as a prop, as `placement` already is | [L02], [L09] |
| `stackDepth` handed to a pane | structure (derived prop) | plain prop through `TugPane` → `CardTitleBar`; no store of its own | [L02] |
| Stack-picker open/closed | local-data | `useState` in `CardTitleBar`, beside the existing `closeOpen`; fed to `TugPopupMenu`'s controlled pair | [L24] |
| `data-stack-depth` on the frame | appearance / test hook | direct DOM attribute rendered by `TugPane`, beside the existing `data-imposed` | [L06] |
| Menu-item enablement | structure mirrored outward | `HostMenuStatePublisher` diff + coalesce → `webkit.messageHandlers.menuState` | [L02] |
| Badge presence | derived at render | `stackDepth > 1` in JSX; no state | [L02] |

Nothing here introduces external state that React reads outside `useSyncExternalStore`, and nothing appearance-related is held in React state ([L06]).

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tests/app-test/at0347-stack-badge-picker.test.ts` | Badge presence/absence, picker contents, raise-on-select, Cmd-click opens without raising, Cmd-drag still drags |
| `tests/app-test/at0348-reveal-stack-chord.test.ts` | ⌘R opens the picker and a second ⌘R closes it; `window.revealStack` enablement across free / Lens / depth-1 / depth-2 |
| `tests/app-test/at0349-stack-picker-foreground.test.ts` | **Conditional** — the `foreground: true` cases. Always holds the Cmd-drag case; holds row selection and the raise too if the Spec S07 probe finds WAAPI does not resolve in a background window. If the probe comes back clean, this file is just the Cmd-drag case and at0347 keeps the rest. |

No new source files: every change lands in a module that already owns the concern.

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `slotStackOf` | fn (new) | `tugdeck/src/deck-store-selectors.ts` | Spec S01 |
| `paneDisplayTitle` | fn (new) | `tugdeck/src/deck-store-selectors.ts` | Spec S02; `projectDeckState` rewritten to call it |
| `SlotStackEntry` | interface (new) | `tugdeck/src/deck-store-selectors.ts` | Spec S06 |
| `TugPaneProps.slotStack` | prop (new) | `tugdeck/src/components/chrome/tug-pane.tsx` | `readonly SlotStackEntry[]`; empty for free panes and the Lens |
| `CardTitleBarProps.slotStack` | prop (new) | `tugdeck/src/components/chrome/tug-pane.tsx` | passed straight through |
| `CardTitleBarProps.onRevealPane` | prop (new) | `tugdeck/src/components/chrome/tug-pane.tsx` | `(entry: SlotStackEntry) => void`; the raise, wired in `DeckCanvas` |
| `CardTitleBarHandle.revealStack` | method (new) | `tugdeck/src/components/chrome/tug-pane.tsx` | Spec S05; toggles ([P07]) |
| `dragStartedWithMeta` | ref (new) | `tugdeck/src/components/chrome/tug-pane.tsx` | in `TugPane`'s drag state; read in `onPointerUp`'s no-travel branch ([P05]) |
| `data-stack-depth` | DOM attr (new) | `tugdeck/src/components/chrome/tug-pane.tsx` | on the frame, beside `data-imposed` |
| `TugPopupMenuProps.open` / `.onOpenChange` | props (new, optional) | `tugdeck/src/components/tugways/internal/tug-popup-menu.tsx` | Spec S04 |
| `TUG_ACTIONS.REVEAL_STACK` | const (new) | `tugdeck/src/components/tugways/action-vocabulary.ts` | `"reveal-stack"`, with the payload comment block the file's convention requires |
| `reveal-stack` handler | action (new) | `tugdeck/src/action-dispatch.ts` | `registerAction`, routes via `sendToFirstResponder` (the `focus-lens` shape) |
| `[TUG_ACTIONS.REVEAL_STACK]` | responder action (new) | `tugdeck/src/components/chrome/tug-pane.tsx` | in the existing `useResponder` map, beside `CLOSE_PANE` |
| `MenuStateDeckProjection.stackDepth` / `MenuStatePayload.stackDepth` | field (new) | `tugdeck/src/lib/host-menu-state.ts` | Spec S03 |
| `MenuState.stackDepth` | property (new) | `tugapp/Sources/AppDelegate.swift` | `var stackDepth: Int = 0` + parse |
| `revealStack(_:)` | @objc fn (new) | `tugapp/Sources/AppDelegate.swift` | `sendControl("reveal-stack")` |
| `window.revealStack` | menu item (new) | `tugapp/Sources/AppDelegate.swift` | `keyEquivalent: "r"`, Window menu, validated on `stackDepth > 1` |
| `maker.reload` | menu item (modified) | `tugapp/Sources/AppDelegate.swift` | `keyEquivalent: "r"` → `"r"` with `modifierMask: [.command, .shift]` |
| `.tug-pane-title-bar-stack-badge` | CSS class (new) | `tugdeck/src/components/chrome/tug-pane.css` | min-width clears a two-digit count |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/pane-model.md` § the imposition section — extend the sentence "a slot is a vertical stack whose top Pane is visible, and the Lens list is the switching surface" to name the local surface: the badge, the picker, and ⌘R.
- [ ] `tuglaws/design-decisions.md` — add **[D123]** for the stack-navigation surface, cross-referencing [D121] (which stays the geometry decision; D123 is the interaction one). Next free number confirmed: the file's highest is D122.
- [ ] `tuglaws/app-test-inventory.md` — entries for at0347 and at0348 in the established summary style.
- [ ] No `docs/*.md` dropfile; everything lands in the curated surfaces above.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (bun)** | `slotStackOf` / `paneDisplayTitle` / `projectDeckState` over hand-built `DeckState` values | Pure selector and projection logic — no DOM, no store |
| **App-test** | The badge, the picker, the raise, the pointer gestures, the chord, and menu validation against the real `Tug.app` | Everything with a title bar, a menu bar, or a z-order in it |
| **Contract (app-test)** | at0168's static menu-structure table | The ⌘R / ⇧⌘R move |

#### What stays out of tests {#test-non-goals}

- **The picker's visual composition.** `TugPopupMenu` is already covered; re-asserting its rendering here would test the component, not the feature.
- **jsdom render tests of `CardTitleBar`.** Banned pattern in this project — the badge and the picker are asserted against the real app, where occlusion, z-order, and AppKit menu validation are all real.
- **Occlusion timing.** `at0332-pane-occlusion.test.ts` owns the controller's behavior; this plan asserts only that a raise makes the chosen pane the front one, which is a store fact.
- **The Lens's own list.** Unchanged by this plan and covered by the Cards-section tests.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Every step below.

#### Step Status Ledger {#step-status-ledger}

Steps 1, 2, and 3 are mutually independent and may land in any order; everything from Step 4 on is sequenced.

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Free ⌘R — move Maker ▸ Reload to ⇧⌘R | done | bb3240604 |
| #step-2 | Derive the slot stack and hand it to every pane | done | 118f93b63 |
| #step-3 | Give TugPopupMenu an optional controlled open (+ its first `@covers`, + the Spec S07 probe) | done | b1d1bb6bc |
| #step-4 | The stack badge and the stack picker | done | 29dd573dd |
| #step-5 | Cmd-click the title bar opens the picker | done | 2ce731e55 |
| #step-6 | Window ▸ Reveal Stack (⌘R) through the chain | done | f8d2744b0 (walked before #step-5 — Step 5 calls the handle this step creates) |
| #step-7 | Publish stackDepth and gate the menu item | done | f1bf0769b |
| #step-8 | App-tests | done | 7e0fc5da5 |
| #step-9 | Documentation | done | 951cd91e2 |
| #step-10 | Integration checkpoint | done | a51f79bb1 |

---

#### Step 1: Free ⌘R — move Maker ▸ Reload to ⇧⌘R {#step-1}

**Commit:** `tugways(menus): move Maker ▸ Reload to ⇧⌘R, freeing ⌘R`

**References:** [P07] Menu-owned chord (#p07-menu-owned-chord), (#context, #constraints, #risks)

**Artifacts:**
- `tugapp/Sources/AppDelegate.swift` — the `reloadItem` construction in the Maker menu
- `tests/app-test/at0168-menu-structure.test.ts` — the static structure table

**How much of ⌘R is actually taken.** The Maker menu is `isHidden = !makerModeEnabled`, and AppKit skips hidden items when matching key equivalents — so in the shipping default ⌘R already reaches nothing, and the collision this step resolves is **maker mode only**. That is still worth its own commit and still has to land first: maker mode is the mode this feature will be built and demoed in, and a chord that works for users but beeps for the person implementing it is not a chord anyone can trust.

**Tasks:**
- [ ] In `AppDelegate.swift`, change the `maker.reload` item from `keyEquivalent: "r"` to `keyEquivalent: "r", modifierMask: [.command, .shift]`, following the `edit.redo` / `file.openQuickly` pattern already used in the file for promoted chords.
- [ ] Update at0168's table entry from `{ id: "maker.reload", key: "r", mods: MOD.command }` to `mods: MOD.command | MOD.shift`.
- [ ] Grep the repo for any doc or help text naming ⌘R as Reload and update it (`tuglaws/`, `tugdeck/src/components/tugways/cards/` help sheet content).

**Tests:**
- [ ] at0168 asserts `maker.reload` carries `r` with the command+shift mask.

**Checkpoint:**
- [ ] `just build`
- [ ] `just app-test at0168-menu-structure.test.ts`

---

#### Step 2: Derive the slot stack and hand it to every pane {#step-2}

**Depends on:** nothing — the derivation is independent of the chord, and this step may land before, after, or beside #step-1.

**Commit:** `tugways(imposer): derive each slot's stack and hand it to its panes`

**References:** [P01] Stack is derived (#p01-stack-is-derived), [P03] Picker from store (#p03-picker-from-store), [P09] Naming (#p09-naming), Specs S01-S02, Spec S06, (#z-order)

**Artifacts:**
- `tugdeck/src/deck-store-selectors.ts` — `slotStackOf`, `paneDisplayTitle`
- `tugdeck/src/lib/host-menu-state.ts` — `projectDeckState` rewritten to call `paneDisplayTitle`
- `tugdeck/src/components/chrome/deck-canvas.tsx` — compute and pass `slotStack`
- `tugdeck/src/components/chrome/tug-pane.tsx` — accept `slotStack`, stamp `data-stack-depth`

**Tasks:**
- [ ] Add `slotStackOf(state, slot)` to `deck-store-selectors.ts` per Spec S01, beside `findLensPane`. Returns `[]` for `undefined`, preserves `panes` order.
- [ ] Add `paneDisplayTitle(state, pane)` per Spec S02, lifting the fallback chain out of `projectDeckState`, and rewrite `projectDeckState` to call it (behavior identical).
- [ ] Add the `SlotStackEntry` interface per Spec S06 to the same module.
- [ ] In `deck-canvas.tsx`, build a `slot → readonly SlotStackEntry[]` map **inside the existing `useMemo` that already produces `sortedStacks` and `zIndexMap`** — same input, same commit boundary — and pass `slotStack` beside `placement={placementFor(stackState)}` in the `TugPane` render. Entries are **reversed** to topmost-first (#z-order), mapped via `paneDisplayTitle`, with `topmost` true for the first element.
- [ ] Read the deck from the `useSyncExternalStore` value the component already holds (`deckState`), **not** `store.getSnapshot()` — a render-time snapshot read is the [L02] violation this codebase keeps out by construction, and the memo above needs a value with render-stable identity anyway. Deriving inside that memo is also what keeps a pane's `slotStack` prop (and therefore the menu's `items` array) from being a fresh object on every unrelated render.
- [ ] Add `slotStack?: readonly SlotStackEntry[]` to `TugPaneProps` with a doc comment stating (as `placement`'s does) that `DeckCanvas` is the only vantage point that can resolve it, and that the entries arrive display-resolved so the title bar needs no store access.
- [ ] Render `data-stack-depth={String(slotStack.length)}` on the frame element beside the existing `data-imposed` attribute, for both test reach and future styling.

**Tests:**
- [ ] Unit: `slotStackOf` returns the panes of a slot in array order; `[]` for an unoccupied slot and for `undefined`; excludes panes with other slots.
- [ ] Unit: `paneDisplayTitle` walks pane title → active card title → first card title → `"Untitled"`.
- [ ] Unit: `projectDeckState` output is byte-identical to its previous behavior on an existing fixture (drift prevention for the extraction).

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx eslint src && bunx vite build`
- [ ] `cd tugdeck && bun test src/__tests__ src/lib/__tests__`
- [ ] `just build`

---

#### Step 3: Give TugPopupMenu an optional controlled open {#step-3}

**Depends on:** nothing — independent of both the chord and the derivation.

**Commit:** `tugways(popup-menu): accept an optional controlled open state`

**References:** [P06] Controlled popup menu (#p06-controlled-popup-menu), Spec S04, Risk table (#risks)

**Artifacts:**
- `tugdeck/src/components/tugways/internal/tug-popup-menu.tsx`

**`tug-popup-menu.tsx` has no `@covers` declaration anywhere in the corpus.** Nothing selects on a change to it, so `just app-test-changed` would run *nothing* for this diff and report green — a refactor of the component behind the title-bar `…` menu, `TugPopupButton`, `TugTabBar`'s overflow and add menus, and the gallery, guarded by nothing but the type-checker. Two tasks below fix that, and they are the reason this step is not a pure refactor commit.

**Tasks:**
- [ ] Add `open?: boolean` and `onOpenChange?: (open: boolean) => void` to `TugPopupMenuProps` with the doc comment from Spec S04.
- [ ] Replace the bare `useState` with the controlled-or-not pair from Spec S04, funnelling **every** existing write — `handleOpenChange`, the `openHandle` from `TugPopupMenuTriggerContext`, `onEscapeDismiss`, the `observeDispatch` chain dismissal, and the blink-then-close selection path — through the single `setOpen` helper.
- [ ] Confirm by reading that `useFocusTrap({ active: open })`, the `openSubKey` reset effect, and the `blinkingRef` guard all read the merged `open` value, not the internal state.
- [ ] Update the component's module docblock — the "Open state is locally controlled" section — to describe the optional external control.
- [ ] **Give the component a covering test.** Find the existing app-test that drives a `TugPopupMenu` consumer (a `TugTabBar` overflow menu or the title bar's `…` menu) and add `@covers tugdeck/src/components/tugways/internal/tug-popup-menu.tsx` to its header docblock, so this file is selectable forever after. If no such test exists, that fact is itself the finding: say so in the commit and fall back to `just app-test` (core tier) as this step's checkpoint rather than leaving `app-test-changed` to certify an empty selection.
- [ ] **Run the selection probe for #step-8 (Spec S07) here**, while the component is already open in the editor. Its answer decides how at0347 is written, and finding it out at Step 8 costs a rewrite of two test files.

**Tests:**
- [ ] The `@covers` addition above, plus the Spec S07 probe. The controlled path itself is exercised end-to-end by at0347 (#step-8); what this step owes is that the *uncontrolled* path — every current call site — is still under a test that will actually run.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx eslint src && bunx vite build`
- [ ] `just app-test-changed` — and read the selection it prints. An empty selection here means the `@covers` task above is not done; it does not mean the change is safe.

---

#### Step 4: The stack badge and the stack picker {#step-4}

**Depends on:** #step-2, #step-3

**Commit:** `tugways(lens-cards): stack badge and picker in the pane title bar`

**References:** [P02] Badge on every pane (#p02-badge-on-every-pane), [P03] Picker from store (#p03-picker-from-store), [P04] Raise path (#p04-raise-path), [P08] Badge form (#p08-badge-form), Spec S06, (#reveal-path, #z-order)

**Artifacts:**
- `tugdeck/src/components/chrome/tug-pane.tsx` — `CardTitleBar` badge + picker; `TugPane` passes through
- `tugdeck/src/components/chrome/deck-canvas.tsx` — `onRevealPane` wiring
- `tugdeck/src/components/chrome/tug-pane.css` — `.tug-pane-title-bar-stack-badge`

**Tasks:**
- [ ] Add `slotStack` and `onRevealPane` to `CardTitleBarProps`; pass both down from `TugPane`.
- [ ] In `CardTitleBar`, add `const [stackMenuOpen, setStackMenuOpen] = useState(false)` beside the existing `closeOpen`, and the depth-collapse effect from Spec S05 that closes it when `slotStack.length <= 1`.
- [ ] Render, as the first child of `.tug-pane-title-bar-controls` and only when `slotStack.length > 1`, a `TugPopupMenu` whose `trigger` is a ghost `TugButton` per [P08] — `subtype="icon-text"`, the `Layers` icon from `lucide-react` on `icon`, the count as `children`, `aria-label={`Stack of ${slotStack.length} cards`}`, `data-testid="tug-pane-title-bar-stack-badge"`. Not `subtype="icon"`: that is the square icon-only button and it renders no label.
- [ ] Build the menu `items` directly from `slotStack` — already topmost-first and display-resolved by Step 2 — as `{ id: entry.paneId, label: entry.title, selected: entry.topmost }`. Set `selected` on **every** item so the check column aligns, per `TugPopupMenuItem.selected`'s contract.
- [ ] Pass `open={stackMenuOpen}` / `onOpenChange={setStackMenuOpen}` and `align="end"`, matching the `…` menu.
- [ ] `onSelect={(paneId) => { const entry = slotStack.find(e => e.paneId === paneId); if (entry) onRevealPane?.(entry); }}`.
- [ ] In `deck-canvas.tsx`, implement `onRevealPane` as the [P04] raise, using the entry's pre-resolved `cardId`: `transferFocusForActivation({ outgoingCardId: store.getFirstResponderCardId(), incomingCardId: entry.cardId, store, commitMutation: () => store.activateCard(entry.cardId) })`.
- [ ] Add `.tug-pane-title-bar-stack-badge` to `tug-pane.css` with a `min-width` that clears a two-digit count, using the title bar's existing `--tug-*` tokens — no new hard-coded colors.

**Tests:**
- [ ] Covered by at0347 in #step-8 (the badge and picker are only meaningfully assertable against the real app).

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx eslint src && bunx vite build`
- [ ] `just build` and confirm in the running debug app: a two-pane slot shows `⧉2`, clicking it lists both panes, and choosing the back one brings it forward.

---

#### Step 5: Cmd-click the title bar opens the picker {#step-5}

**Depends on:** #step-4

**Commit:** `tugways(lens-cards): Cmd-click a title bar to reveal its stack`

**References:** [P05] Cmd-click not drag (#p05-cmd-click-not-drag), [P10] No interpreter change (#p10-no-interpreter-change), (#reveal-path)

**Artifacts:**
- `tugdeck/src/components/chrome/tug-pane.tsx` — `handleDragStart` (record the modifier) and its `onPointerUp` no-travel branch (act on it)

**This step adds no gesture handler.** The whole change lands inside the drag machine `TugPane` already runs, for the reason [P05] gives: the frame takes pointer capture at pointerdown, so a `CardTitleBar` pointer-up handler would never see the release, and deferring `onDragStart` to dodge that would break the drag-start focus save. What is left is a ref and a branch.

**Tasks:**
- [ ] In `handleDragStart`, beside the existing `dragStartPointer` snapshot, record `event.metaKey` into a new `dragStartedWithMeta` ref. Reset it at the end of the gesture with the other drag state (`dragOtherRects`, `latestAltKey`, `lastSnapResult`) so it cannot leak into the next press.
- [ ] In `onPointerUp`'s existing `if (!dragMoved.current)` early-return branch — the one commented "The pointer never travelled, so this was a click on the title bar" — call `titleBarRef.current?.revealStack()` when `dragStartedWithMeta.current` is set, before the branch's state reset. Nothing else in that branch changes: it still commits no geometry and still leaves a derived pane in its slot.
- [ ] Do **not** add a travel test, a containment test, or a second threshold: `dragMoved` already encodes travel against `DRAG_MOVE_THRESHOLD_PX`, and the frame's pointer capture already scopes the release.
- [ ] Leave the `.tug-button` early-return at the top of `handleTitleBarPointerDown` intact so a Cmd-click on the badge itself, the `…` button, the chevron, or the close box behaves as it does today — that guard is what keeps `onDragStart` (and therefore this path) from firing on the controls.
- [ ] Add a short comment citing [P05]: Cmd-drag on a title bar is both the background-window move and the slot eviction, so the decision waits for the gesture's ending — and this branch *is* that ending, already written.
- [ ] Confirm by reading `gesture-interpreter.ts` that no change is needed there: the `metaKey` branch already suppresses activation and the title bar already carries `data-tug-fr-preserve`.

**Tests:**
- [ ] Cmd-click-opens-without-raising is covered by at0347 in #step-8 and is background-safe: the no-travel branch runs on pointerup with no dependence on rAF.
- [ ] Cmd-drag-still-drags is covered by at0347's **foreground** case — see Spec S07; a background window cannot latch `dragMoved` at all.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx eslint src && bunx vite build`
- [ ] `just build` and confirm by hand: Cmd-click a stacked title bar opens the picker and the pane does not come forward; Cmd-drag the same title bar still moves the pane.

---

#### Step 6: Window ▸ Reveal Stack (⌘R) through the chain {#step-6}

**Depends on:** #step-4

**Commit:** `tugways(menus): Window ▸ Reveal Stack opens the focused pane's stack picker`

**References:** [P07] Menu-owned chord (#p07-menu-owned-chord), [P09] Naming (#p09-naming), Spec S05, (#reveal-path)

**Artifacts:**
- `tugdeck/src/components/tugways/action-vocabulary.ts` — `REVEAL_STACK`
- `tugdeck/src/action-dispatch.ts` — `reveal-stack` handler
- `tugdeck/src/components/chrome/tug-pane.tsx` — responder action + `CardTitleBarHandle.revealStack`
- `tugapp/Sources/AppDelegate.swift` — the menu item and its selector

**Tasks:**
- [ ] Add `REVEAL_STACK: "reveal-stack"` to `TUG_ACTIONS` with the payload comment block the file's convention requires (`payload — none. Open the focused pane's slot-stack picker.`), placed near `MOVE_TO_SLOT`.
- [ ] Add `revealStack` to `CardTitleBarHandle` per Spec S05 and implement it in the `useImperativeHandle` block as `setStackMenuOpen((prev) => !prev)`, guarded by `slotStack.length > 1`. The toggle is [P07]'s: the chord's own chain dispatch reaches the menu's `observeDispatch` subscription, and `notifyDispatchObservers` runs after the responder action, so a toggle is the one form that is single-valued in both directions. Step 5's Cmd-click reaches the same handle, where a toggle reads as the ordinary "click the badge again to dismiss".
- [ ] In `TugPane`'s `useResponder` actions map, add `[TUG_ACTIONS.REVEAL_STACK]: (_event: ActionEvent) => { titleBarRef.current?.revealStack(); }` beside `CLOSE_PANE`, which is the identical shape.
- [ ] In `action-dispatch.ts`, `registerAction("reveal-stack", …)` routing through `responderChainManagerRef.sendToFirstResponder({ action: TUG_ACTIONS.REVEAL_STACK, phase: "discrete" })`, copying `focus-lens`'s null-guard and warn.
- [ ] In `AppDelegate.swift`, add `@objc private func revealStack(_ sender: Any) { sendControl("reveal-stack") }`.
- [ ] Add the menu item to the Window menu next to `window.cyclePanes`: `NSMenuItem(title: "Reveal Stack", action: #selector(revealStack(_:)), keyEquivalent: "r").identified("window.revealStack")`.

**Tests:**
- [ ] Covered by at0348 in #step-8.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx eslint src && bunx vite build`
- [ ] `just build` and confirm by hand: ⌘R with a stacked pane focused opens its picker.

---

#### Step 7: Publish stackDepth and gate the menu item {#step-7}

**Depends on:** #step-2, #step-6

**Commit:** `tugways(menus): gate Reveal Stack on the focused pane's stack depth`

**References:** [P07] Menu-owned chord (#p07-menu-owned-chord), [Q02] Deselected deck (#q02-deselected-deck), Spec S03, Risk R02 (#r02-menu-state-churn)

**Artifacts:**
- `tugdeck/src/lib/host-menu-state.ts` — `stackDepth` on the projection and the payload
- `tugapp/Sources/AppDelegate.swift` — `MenuState.stackDepth`, parse, and `validateMenuItem`

**Tasks:**
- [ ] Add `stackDepth: number` to `MenuStateDeckProjection` and `MenuStatePayload` with the doc comment from Spec S03.
- [ ] Compute it in `projectDeckState` from the already-resolved `focusedStack`, returning `0` when `state.activePaneId === undefined` ([Q02]).
- [ ] Seed it as `0` in `HostMenuStatePublisher`'s initial `deckProjection` so the first post is well-formed.
- [ ] Swift: add `var stackDepth: Int = 0` to `MenuState` and parse it (`payload["stackDepth"] as? Int ?? 0`), matching `selectionActive`'s shape.
- [ ] Swift: in `validateMenuItem(_:)`, return `menuState.stackDepth > 1` for `"window.revealStack"`.

**Tests:**
- [ ] Unit: `projectDeckState` reports `stackDepth` 2 for a focused pane sharing a slot, 1 for a focused pane alone in its slot, 0 for a focused free pane, 0 for the Lens focused, and 0 when `activePaneId` is undefined.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx eslint src && bunx vite build`
- [ ] `cd tugdeck && bun test src/lib/__tests__`
- [ ] `just build`

---

#### Step 8: App-tests {#step-8}

**Depends on:** #step-5, #step-7

**Commit:** `tugways(app-test): cover the stack badge, picker, and reveal chord`

**References:** [P02] (#p02-badge-on-every-pane), [P04] (#p04-raise-path), [P05] (#p05-cmd-click-not-drag), [P07] (#p07-menu-owned-chord), Spec S07 (#s07-test-tier), (#success-criteria, #occlusion-interaction, #test-non-goals)

**Artifacts:**
- `tests/app-test/at0347-stack-badge-picker.test.ts`
- `tests/app-test/at0348-reveal-stack-chord.test.ts`

**Tasks:**
- [ ] Build a shared seed shape after `at0338-slot-chords.test.ts`'s `deckShape()`: a three-up deck, Lens right at 300px, **two panes both at slot 0** (`p1`/A front-most by array order, `p0`/Z behind it), one pane alone at slot 2 (`p2`/B), one free pane with no `slot` (`pFree`/F), and the Lens pane. Give the two slot-0 panes **different widths** so the buried one is not fully occluded and both badges are queryable — then add a same-width variant for the occlusion assertion.
- [ ] at0347 — badge, picker, raise, pointer gestures:
  - Badge present on both slot-0 panes with text `2`; absent on `p2`, on `pFree`, and on the Lens pane (assert via `data-testid` scoped by `data-pane-id`).
  - `data-stack-depth` reads `2` / `1` / `0` on the respective frames.
  - Click the badge; poll for the menu content element; assert two `[role="menuitem"]` rows, labels matching the two pane titles, topmost first, with the front pane's row checked.
  - Choose the back row; assert `getFocusedCardId()` is now the raised pane's card and that its frame's `z-index` exceeds the other's.
  - `app.click(titleBarSelector, { metaKey: true })` on the front pane's title bar: menu opens and `getFocusedCardId()` is unchanged. Background-safe — the no-travel branch runs on pointerup and needs no frame.
  - Native Cmd-drag of a title bar past the drag threshold: the frame's `left` moves and no menu content is in the DOM. **`foreground: true`, per Spec S07** — `dragMoved` latches only inside an rAF callback, so in a background window this drag opens the picker instead of moving anything and the assertion inverts.
  - Same-width variant: the buried pane carries `data-occluded="true"` and its badge computes `visibility: hidden` — the [P02] claim stated honestly (#occlusion-interaction).
  - `@covers tugdeck/src/components/chrome/tug-pane.tsx`, `@covers tugdeck/src/components/chrome/deck-canvas.tsx`, `@covers tugdeck/src/deck-store-selectors.ts`, `@covers tugdeck/src/components/tugways/internal/tug-popup-menu.tsx`
  - Honour Spec S07's split: if the #step-3 probe found that item selection needs a frame, the selection and raise assertions move to a foreground at0349 with the Cmd-drag case, and at0347 keeps what a frameless window can see. `log()`/`note()` whatever the split leaves out of the everyday tier — a silently narrowed test reads as coverage.
- [ ] at0348 — the chord and its gate:
  - `menuItemState("window.revealStack")` is enabled with a stacked pane focused, and disabled with `p2` (depth 1), `pFree`, and the Lens focused.
  - `nativeKey("r", ["cmd"])` with a stacked pane focused opens the picker; a second `nativeKey("r", ["cmd"])` closes it ([P07]'s toggle).
  - Nothing here re-asserts that ⌘R no longer reloads. at0168 owns that, structurally, and a "press ⌘R and confirm no reload" assertion would be vacuous in this bundle anyway: the Maker menu is hidden unless maker mode is on, and AppKit does not match key equivalents on hidden items — so the pass would prove nothing about the move.
  - `@covers tugapp/Sources/AppDelegate.swift`, `@covers tugdeck/src/lib/host-menu-state.ts`, `@covers tugdeck/src/action-dispatch.ts`, `@covers tugdeck/src/components/tugways/action-vocabulary.ts`
- [ ] Both files: `describe.skipIf(!SHOULD_RUN)`, a `TEST_TIMEOUT_MS` in the 90s range, no fixed waits tied to animation (background windows run no rAF) — poll for the menu element instead.
- [ ] Run `just app-test-covers-check` and fix any unresolved `@covers` path.

**Tests:**
- [ ] The two new files are themselves the tests.

**Checkpoint:**
- [ ] `just app-test-covers-check`
- [ ] `just app-test at0347-stack-badge-picker.test.ts at0348-reveal-stack-chord.test.ts`
- [ ] `just app-test-changed`

---

#### Step 9: Documentation {#step-9}

**Depends on:** #step-8

**Commit:** `tuglaws(pane-model): the slot stack's local switching surface`

**References:** [P01] (#p01-stack-is-derived), [P03] (#p03-picker-from-store), [P07] (#p07-menu-owned-chord), [P08] (#p08-badge-form), (#documentation-plan)

**Artifacts:**
- `tuglaws/pane-model.md`
- `tuglaws/design-decisions.md`
- `tuglaws/app-test-inventory.md`

**Tasks:**
- [ ] `pane-model.md`: extend the imposition section's "a slot is a vertical stack whose top Pane is visible, and the Lens list is the switching surface" to name the local surface — the badge (depth at rest), the picker (built from the store, not from revealed DOM), the Cmd-click and ⌘R paths, and the fact that the raise is the same `transferFocusForActivation` every other switch uses.
- [ ] `design-decisions.md`: add **[D123]** for the stack-navigation surface. Cite [D121] as the geometry it rests on, record that the stack is derived and never stored, that the picker is store-built because buried panes are `visibility: hidden`, that Cmd-click resolves in the drag machine's own no-travel branch (so Cmd-drag — both the background-window move and the slot eviction — survives, and no second gesture handler exists to fight the frame's pointer capture), that the chord toggles because its own chain dispatch reaches the menu's `observeDispatch` subscription, and that ⌘R is menu-owned because AppKit resolves key equivalents ahead of the web view. Name the touched files as the file's entries do.
- [ ] `app-test-inventory.md`: summary entries for at0347 and at0348 in the established prose style.
- [ ] Follow the no-hard-wrapping rule: one logical line per paragraph or bullet.

**Tests:**
- [ ] None (documentation).

**Checkpoint:**
- [ ] `grep -n "D123" tuglaws/design-decisions.md` returns the new entry and no duplicate number.
- [ ] The three docs render with no broken intra-repo links.

---

#### Step 10: Integration Checkpoint {#step-10}

**Depends on:** #step-1, #step-4, #step-5, #step-6, #step-7, #step-8, #step-9

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Walk every criterion in #success-criteria against the running debug app, in order.
- [ ] Confirm no regression in the surfaces the controlled-open change touches: open the title-bar `…` menu, a `TugPopupButton`, and a `TugTabBar` overflow menu; check each opens, closes on Escape, closes on an outside click, and closes on an external chord.
- [ ] Confirm ⌘R does nothing (no beep, no reload) with a free pane focused, and that ⇧⌘R still reloads in maker mode.
- [ ] Confirm the picker cannot outlive its badge (Spec S05): with a two-deep slot's picker open, close the other pane in that slot from the keyboard. The menu goes away, focus is somewhere sane, and re-stacking the pane shows a **closed** badge rather than one that opens on mount.

**Tests:**
- [ ] `just app-test` (core tier) — the badge and the picker sit in the title bar, which every card surface renders.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx eslint src && bunx vite build`
- [ ] `just build`
- [ ] `just app-test`

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A slot's stack of imposed panes is visible at rest and navigable in place — a title-bar badge showing the depth, a picker listing every pane in the slot, reachable by click, by Cmd-click, and by ⌘R.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Every criterion in #success-criteria holds in the real app (Step 10 walk-through).
- [ ] at0347 and at0348 pass, and both carry resolving `@covers` lines (`just app-test-covers-check`).
- [ ] at0168 passes with `maker.reload` on ⇧⌘R.
- [ ] `bunx tsc --noEmit`, `bunx eslint src`, and `bunx vite build` are clean in `tugdeck`.
- [ ] `just app-test` (core tier) is green.
- [ ] `pane-model.md`, `design-decisions.md` ([D123]), and `app-test-inventory.md` are updated.
- [ ] No new persisted state and no serialization version bump (verify: `slot` is the only imposition field on `TugPaneState` and it is unchanged).

**Acceptance tests:**
- [ ] `just app-test at0347-stack-badge-picker.test.ts at0348-reveal-stack-chord.test.ts at0168-menu-structure.test.ts`
- [ ] `cd tugdeck && bun test src/__tests__ src/lib/__tests__`

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] A per-slot cycle gesture (scroll-wheel riffle over the title bar, or repeated ⌘R stepping the selection) — deliberately deferred; the picker plus arrow keys covers the need and no new chord is spent until it is felt.
- [ ] Renaming the legacy `stackState` / `stackId` / `stackCards` pane-synonyms so "stack" means only "slot stack" in code ([P09]).
- [ ] Showing the badge's depth in the Lens's Cards section rows, so the rail and the deck agree about which panes are piled together.

| Checkpoint | Verification |
|------------|--------------|
| ⌘R is free | at0168 asserts `maker.reload` on ⇧⌘R |
| The stack is derived, not stored | unit tests on `slotStackOf`; no `TugPaneState` field added |
| The picker raises correctly | at0347 asserts focused card and `z-index` after selection |
| Cmd-drag survives Cmd-click | at0347's **foreground** case asserts the frame moved and no menu opened (Spec S07) |
| The chord is gated | at0348 asserts `menuItemState("window.revealStack")` across four focus states |
| The chord toggles | at0348 asserts a second ⌘R closes the picker |
| `TugPopupMenu` is selectable by `app-test-changed` | a `@covers` line naming it resolves under `just app-test-covers-check` |
| The picker cannot outlive its badge | closing a stacked peer with the picker open leaves no menu and no stale open state (Step 10 walk) |
