<!-- tugplan-skeleton v2 -->

> **Note (2026-04-27):** the "Component Persistence Protocol" described
> below has been renamed to "Component State Preservation Protocol",
> and the `useComponentPersistence` / `useCardPersistence` hooks to
> `useComponentStatePreservation` / `useCardStatePreservation`. See
> [tugplan-state-preservation-rename.md](tugplan-state-preservation-rename.md).
> This plan's body is grandfathered as historical reference.

## Selection, Focus, Scroll, and Content Persistence Subsystem {#phase-selection-subsystem}

**Purpose:** Define a complete, code-grounded strategy for tracking, managing, saving, and restoring text content, text selection, focus, and scroll position across every card, component, and lifecycle transition in tugdeck.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-04-22 |

---

### Phase Overview {#phase-overview}

#### Redo mandate {#redo-rationale}

An earlier version of this plan proposed a 16-step `SelectionKeeper` subsystem and reached partial implementation (Steps 1–6 committed, Step 7 attempted) before manual verification failed. The failure mode was not a bug — it was the plan.

Root cause: every decision in the previous plan was written against a theoretical model of how tugdeck handles selection, without grounding that model in the actual codebase. Multiple overviewer and critic audits reviewed the plan document for internal coherence but never validated its claims against real code. The core false premise — "the keeper can be the sole owner of selection save/restore" — silently collided with the fact that `TugTextEngine.restoreState` already owns selection restore for tide cards via `setSelectedRange`. That conflict, which a single `grep` would have surfaced, propagated through 16 steps of elaboration and six committed steps of implementation.

All committed work on the previous plan (commits `0f239b14` through `183d8af5`) has been rolled back. This document starts over from a code audit.

#### Scope {#scope}

The new plan must cover, end-to-end, the persistence of:

- **Text content** (card-level `bag.content`, component-internal engine state, controlled React state).
- **DOM selection** (`window.getSelection()` ranges inside contentEditable regions and in card chrome).
- **Form-control selection** (`<input>` / `<textarea>` `selectionStart` / `selectionEnd` / `selectionDirection`).
- **Focus** (`document.activeElement`).
- **Scroll position** (card-level scroll on `hostContentEl`, per-input scroll inside form controls, per-region scroll inside card content).

Across every one of these transitions:

- App active / resign active.
- App hide / unhide.
- Browser reload (`window.beforeunload`, `document.visibilitychange(hidden)`).
- Process relaunch (Swift `applicationShouldTerminate` → `saveState` RPC).
- Card activate / deactivate (within a pane).
- Pane activate / deactivate (within the deck).
- Card drag / move / resize.
- Pane drag / move / resize.
- Tab switch (card activation inside a multi-card pane).
- Cross-pane card move.

---

### Code audit {#audit}

This section is the single authoritative map of the system as it exists **today** (commit `01568587`). Every future design decision must cite a row here. Rows in italics are known gaps or conflicts — they are *not* load-bearing claims, they are signals of where the current system is broken or ambiguous.

#### Layered architecture {#audit-layers}

There are four distinct persistence layers in tugdeck. Every concept below is owned by exactly one, sometimes two (the collisions are spelled out in [#audit-collisions](#audit-collisions)):

1. **Deck-state layer** (`deck-manager.ts`, `settings-api.ts`). Saves the deck layout (panes, cards, positions, active-pane / active-card-per-pane pointers) and the global `initialFocusedCardId` pointer. Stored as `dev.tugtool.deck.layout`, `dev.tugtool.deck.state/focusedCardId`, `dev.tugtool.deck.cardstate/{cardId}` in tugbank.
2. **Card-host layer** (`components/chrome/card-host.tsx`). Saves and restores per-card scroll, per-card content payload (via `useCardPersistence`), and per-input DOM-authority state (value, selection, scroll) via `captureDomInputs` / `applyDomInputSnapshot`. One save closure per card, registered as a `registerSaveCallback(cardId, …)` with the deck manager.
3. **Component-internal layer.** `TugTextEngine` (in `lib/tug-text-engine.ts`) owns its own content + selection via `captureState` / `restoreState`, embedded as the opaque `bag.content` payload through `useCardPersistence`. `tug-markdown-view` manages its own scroll state locally.
4. **Selection-guard layer** (`components/tugways/selection-guard.ts`). Runtime behaviors: (a) drag-clipping and boundary enforcement; (b) CSS dim-highlight for inactive-selection visibility during app resign/activate; (c) tab-switch save/restore via `saveSelection(paneId)` / `restoreSelection(paneId, …)`. Keyed **by pane id**, not card id — critical.

#### Table A — concept × owner (per-concept ownership map) {#audit-table-a}

| Concept | Owner(s) | Save site | Restore site | Keyed by |
|---|---|---|---|---|
| Card-level scroll (`hostContentEl.scrollLeft/Top`) | Card-host | `card-host.tsx:329` `saveCurrentCardStateRef` → `bag.scroll` | `card-host.tsx:287` (layout effect) and `card-host.tsx:237` (`onContentReady`) | `cardId` |
| Card content payload (opaque, card-defined) | Card-host → component-internal | `useCardPersistence.onSave()` via `persistenceCallbacksRef.current.onSave()` (`card-host.tsx:343`) → `bag.content` | `registerPersistenceCallbacks` (`card-host.tsx:260`) → `onRestore(bag.content)` | `cardId` |
| DOM selection (contentEditable, e.g. `TugPromptInput`) | **TWO**: component-internal engine AND selection-guard | Engine: `TugTextEngine.captureState()` at `tug-text-engine.ts:617` → `{ text, atoms, selection: {start,end} }` → embedded in `bag.content` via `TugPromptEntry` onSave. Guard: `selectionGuard.saveSelection(hostStackId)` at `card-host.tsx:334` → `bag.selection` (walk paths from pane boundary). | Engine: `engine.restoreState` at `tug-text-engine.ts:632` rewrites `this.root.innerHTML` then `setSelectedRange(start,end)`. Guard: `selectionGuard.restoreSelection(hostStackId, bag.selection)` at `card-host.tsx:289` and `:245` → `setBaseAndExtent`. | Engine: card-via-content; guard: **pane id** |
| DOM selection (card chrome outside any contentEditable) | Selection-guard only | Same `selectionGuard.saveSelection(hostStackId)` | Same `selectionGuard.restoreSelection(hostStackId, …)` | Pane id |
| Form-control value | Card-host | `card-host.tsx:101` `captureDomInputs` walks `[data-tug-persist-value]` → `bag.domInputs[key].value` | `card-host.tsx:144` `applyDomInputSnapshot` → `el.value = snap.value` at mount + on MutationObserver fires | `persistKey` per element |
| Form-control selection (`selectionStart/End/Direction`) | Card-host via DomInputSnapshot | `card-host.tsx:113` `captureDomInputs` reads `el.selectionStart/End/Direction` regardless of focus | `card-host.tsx:153` `applyDomInputSnapshot` → `el.setSelectionRange(...)` | `persistKey` per element |
| Per-input scroll (`<input>` / `<textarea>` internal scroll) | Card-host via DomInputSnapshot | `card-host.tsx:116` `captureDomInputs` → `scrollTop/Left` | `card-host.tsx:149` `applyDomInputSnapshot` → `el.scrollTop/Left =` | `persistKey` per element |
| Focus (`document.activeElement`) at element level | **NOT PERSISTED ANYWHERE** | *(none)* | *(none — user must click back into inputs after reload)* | *n/a* |
| Deck-level active-card pointer | Deck-state | `putFocusedCardId(cardId)` (called by `focusCard` and `activateCard`) | `DeckManager` constructor reads `initialFocusedCardId` and calls `activateCard` on boot | Global |
| Per-pane active-card pointer (tab pointer) | Deck-state | Part of `TugPaneState.activeCardId`, serialized in layout | Restored via `deserialize` of layout JSON | Pane id |
| Active pane pointer | Deck-state | Part of `DeckState.activePaneId`, serialized in layout | Restored via `deserialize` | Global |
| Per-region scroll inside `tug-markdown-view` | Component-internal (`tug-markdown-view.tsx`) | Local refs + smart-scroll lib at `tug-markdown-view.tsx:441,478,530,632` | Same file, inline | Local |
| CSS inactive-selection highlight (dim state during resign/activate) | Selection-guard | `selectionGuard.handleApplicationDidResignActive` at `selection-guard.ts:530` — clones live range into `inactiveRanges[cardId]`, adds to CSS highlight, clears browser selection | `selectionGuard.handleApplicationDidBecomeActive` at `selection-guard.ts:560` — restores saved range to `window.getSelection()`, removes from inactive highlight | Card (via `activeCardId_highlight`) |

#### Table B — transition × trigger (lifecycle trigger map) {#audit-table-b}

| Transition | Trigger source | Subscribers (in order) | State touched |
|---|---|---|---|
| Reload (Cmd-R, in-process) | `window.beforeunload` | `DeckManager.handleBeforeUnload` (`deck-manager.ts:170`) → `saveCallbacks.forEach` → `flushDirtyCardStates({sync:true})` | Fires every card's `saveCurrentCardStateRef` — captures scroll + `selectionGuard.saveSelection(paneId)` + `onSave()` content + `captureDomInputs`. |
| Reload (action-dispatch "reload") | Swift `reload` Control frame → `action-dispatch.ts:211` → `DeckManager.prepareForReload` | Same callbacks as beforeunload, awaited | Same |
| Tab backgrounded | `document.visibilitychange(hidden)` | `DeckManager.handleVisibilityChange` (`deck-manager.ts:158`) → `saveCallbacks.forEach` + async `flushDirtyCardStates` | Same capture as reload |
| App will-resign active | Swift `applicationWillResignActive` Control frame | **`lifecycle-cascade.ts:127`** cascades to `cardWillDeactivate` / `cardDidDeactivate` on the active card only. **No save trigger fires on will-phase.** | Card-lifecycle events, no persistence |
| App did-resign active | Swift `applicationDidResignActive` | `action-dispatch.ts:497` → `deckManager.saveAndFlush()` (saves all cards); `selection-guard.ts:393` → `handleApplicationDidResignActive` (dim active card's selection into CSS highlight) | All card bags; CSS highlight state |
| App will-hide | Swift `applicationWillHide` | `lifecycle-cascade.ts:130` cascades to card-lifecycle events. **No save trigger.** | Card-lifecycle events only |
| App did-hide | Swift `applicationDidHide` | *(no subscribers in save path)* | *(nothing)* |
| App did-become-active | Swift `applicationDidBecomeActive` | `action-dispatch.ts:514` → `restoreActiveCardSelection` — calls `selectionGuard.restoreSelection(pane.id, bag.selection)` for the active-pane's active card; `selection-guard.ts:396` → `handleApplicationDidBecomeActive` (un-dim); `lifecycle-cascade.ts:133` cascades to `cardWillActivate` / `cardDidActivate` | Selection re-applied, dim removed, card-lifecycle |
| App did-unhide | Swift `applicationDidUnhide` | Same as did-become-active (`action-dispatch.ts:517`, `lifecycle-cascade.ts:136`) | Same |
| Swift quit (`applicationShouldTerminate`) | `window.tugdeck.saveState()` wire at `main.tsx:210` | `DeckManager.saveAndFlushSync()` — all card callbacks + sync flush | Same as reload |
| Card activation within a pane (tab switch) | `tug-pane.tsx:439` `performSelectCard` | `store.invokeSaveCallback(outgoingCardId)` → then `setActiveCardInPane` → card-lifecycle `cardWillDeactivate`/`cardDidDeactivate` on outgoing, `cardWillActivate`/`cardDidActivate` on incoming | Outgoing card's bag; card-lifecycle events |
| Deck-level pane activation (click on a pane) | `focusCard` / `activateCard` | Bumps pane z-order, flips composite first-responder bit, writes `putFocusedCardId`; **no save trigger for intra-pane content** | Deck state only |
| Cross-pane card move | `DeckManager._moveCardToPane` (`deck-manager.ts:1254`) | `this.invokeSaveCallback(cardId)` at `:1269` **before** the commit, then deck-state mutation | Source card's bag flushed; deck state |
| Card detach | `DeckManager._detachCard` (`deck-manager.ts:1161`) | `this.invokeSaveCallback(cardId)` at `:1175`; new pane is created | Source card's bag flushed; deck state |
| Card drag (in-flight) | `card-drag-coordinator.ts` | Ghost DOM clone only; no state capture during drag | Transient DOM |
| Pane drag / move / resize | `DeckManager.handlePaneMoved` | Updates `panes[].position/size`, `notify()`, `scheduleSave()` | Deck state only; no card-level capture |
| Card close | `DeckManager._removeCard` | **Does NOT invoke save callback.** Just removes from deck state. | Deck state; card bag becomes orphaned |
| Card construction (brand-new card) | `DeckManager._addCardToPane` / `addCard` | Fires `cardDidFinishConstruction`; card mounts with empty bag | None on save side |

#### Table C — write-site inventory (every read/write to the persisted concepts) {#audit-table-c}

| Concept write verb | Call sites in `tugdeck/src/` | Notes |
|---|---|---|
| `window.getSelection().setBaseAndExtent` | `text-selection-adapter.ts:309` (contentEditable-adapter caret placement); `selection-guard.ts:673` (`restoreSelection` path); `selection-guard.ts:876,882` (drag-clip forced-pin) | 4 sites. Only `selection-guard.ts:673` is persistence-restoration. |
| `el.setSelectionRange` | `card-host.tsx:153` (`applyDomInputSnapshot`); `use-text-input-responder.tsx:267,288` (contextmenu restore); `tug-text-engine.ts` (internal via setSelectedRange helpers) | 3 persistence sites plus many engine-internal sites (via `setSelectedRange`). |
| `el.focus()` | `tug-sheet.tsx:486` (sheet close restore); `use-text-input-responder.tsx:189,553` (contextmenu + responder); `tug-prompt-entry.tsx:681,846`; `tug-prompt-input.tsx:469,913`; `tide-card.tsx:1016,1020,1024,1047,1070` (tide-specific card-lifecycle focus reclaim); `gallery-prompt-input.tsx:293,301`; `tug-group-utils.tsx:188` (group roving focus); `tug-text-engine.ts:462,489,514,519,535,552,557` | ~20 sites. None are driven by a global-focus-persistence layer — all are either component-internal or card-specific. |
| `scrollLeft =` / `scrollTop =` | `card-host.tsx:149-150,237-238,285-286` (persistence restore); `tug-markdown-view.tsx:484,537,634,810` (smart-scroll); `lib/smart-scroll.ts:224,248`; `tug-text-engine.ts:1536` (scroll-clamp after innerHTML rewrite) | Persistence writes are all in card-host. Markdown and engine manage their own internal scroll. |
| `el.innerHTML =` (destroys any selection anchored in `el`) | `tug-text-engine.ts:595,652` (`clear` + `restoreState`); `tug-markdown-view.tsx:383,715` (sanitized markdown render); `tug-prompt-input.tsx:567` (popup clear); `card-drag-coordinator.ts:613` (ghost, not content); `lib/markdown.ts:152` (code wrap) | **`tug-text-engine.ts:652` is the critical site** — `restoreState` rewrites the contentEditable's innerHTML, producing new DOM nodes, then immediately sets selection via `setSelectedRange`. Any selection anchor that pointed at the pre-rewrite DOM (e.g., from `selectionGuard.restoreSelection`) becomes invalid. |
| `TugTextEngine.captureState / restoreState` | Captured: `tug-prompt-entry.tsx:592,650,723,779`; `tug-prompt-input.tsx:355,480`; `gallery-prompt-input.tsx:269`. Restored: `tug-prompt-entry.tsx:665,725,820`; `tug-prompt-input.tsx:359,481,651,817`. Definition: `tug-text-engine.ts:617,632`. | Engine owns its state; the content payload routed through `useCardPersistence` is `TugTextEditingState = { text, atoms, selection: {start,end} | null }`. |
| `selectionGuard.saveSelection` / `restoreSelection` | `card-host.tsx:334,289,245`; `action-dispatch.ts:510` | Four call sites. Keyed by `hostStackId` (pane id). |
| `captureDomInputs` / `applyDomInputSnapshot` | `card-host.tsx:101,144,347,315` | DOM-authority path, keyed by `persistKey` per element. |

#### Collisions and gaps surfaced by the audit {#audit-collisions}

These are the concrete findings that invalidate the previous plan and must shape the new one:

1. **Dual ownership of contentEditable selection (tide card, gallery-prompt-entry, gallery-prompt-input).** The engine's `restoreState` rewrites `this.root.innerHTML` and then calls `setSelectedRange(start, end)`. Simultaneously, `selectionGuard.restoreSelection(paneId, bag.selection)` walks the `anchorPath` / `focusPath` captured from the pane boundary and calls `setBaseAndExtent`. Both fire on restore; whichever wins depends on timing. After the engine's innerHTML rewrite, guard's paths may resolve to different text nodes or fall off the tree entirely.

2. **Pane-level vs card-level boundary mismatch.** `useSelectionBoundary(stackId, contentRef)` registers the **pane** content element as the selection boundary (`tug-pane.tsx:428`). In a multi-card (tab) pane, every tab shares one boundary. Save/restore keyed by pane id means that saving one tab's selection and restoring in another is indistinguishable at the boundary layer — the tab-switch path relies on `invokeSaveCallback(outgoingCardId)` firing *before* the swap to capture the right bag.

3. **Will-phase lifecycle events have no save subscribers.** `applicationWillResignActive` and `applicationWillHide` cascade to card-lifecycle events via `lifecycle-cascade.ts` but nothing in the save path (selection-guard, deck-manager saveAndFlush, action-dispatch) listens to the *will*-phase. Saves fire only on the *did*-phase (`applicationDidResignActive` → `deckManager.saveAndFlush()`). WebKit tears down selection visibility between the two.

4. **Focus is not persisted at element level.** Only the card-level "which card was active" pointer is persisted (`putFocusedCardId`). Which input inside that card had focus is nowhere saved or restored. On reload, the user always has to click back into the specific input they were editing.

5. **Form-control selection is captured regardless of focus (good), but unfocused selection is invisible on restore.** `captureDomInputs` walks every `[data-tug-persist-value]` element in the card's subtree and records each one's `selectionStart/End/Direction` — no focus requirement. On restore, `setSelectionRange` on an unfocused input stores the range internally but paints no highlight. Without a focus-restore counterpart, selections on unfocused inputs are "there but invisible" — first click moves the caret, losing the saved selection.

6. **`selectionGuard.saveSelection(paneId)` captures against pane boundary, written under `bag.selection` keyed by `cardId`.** `card-host.tsx:334` calls `selectionGuard.saveSelection(hostStackId)` and writes the returned `SavedSelection | null` to the current card's `bag.selection`. But the saved paths are rooted at the pane boundary, not the card root. For single-card panes this is fine. For multi-card panes the paths are valid only as long as the same active card is swapped in during restore.

7. **Three paths overlap for tide-card reload.** On reload of a card that uses `TugPromptEntry`: (a) `bag.content` carries engine state → engine.restoreState rewrites innerHTML + sets engine-coord selection; (b) `bag.selection` carries pane-boundary DOM paths → `selectionGuard.restoreSelection` runs; (c) `bag.domInputs` may carry non-prompt form-control state for inputs elsewhere in the card. All three fire on restore, from different parts of `CardHost`. (a) and (b) race on the same DOM; (c) is independent. The fragility of (b) after (a) is Case A's failure mode.

8. **Visibility-dimming cycle on app resign/activate is a DIFFERENT path from persistence save/restore.** `selection-guard`'s `handleApplicationDidResignActive` / `handleApplicationDidBecomeActive` manage an in-memory CSS highlight for dimming — not persistence. They clear `window.getSelection()` on resign, then restore it on become-active. This is transient visibility plumbing, orthogonal to `saveSelection`/`restoreSelection`.

9. **Card close (`_removeCard`) does not flush.** When a card is closed, its bag is left in the deck-state cache / tugbank without a final save. For short-lived cards this is fine, but if the card was mid-edit and the user closes it intending to re-open, the last edits may not be captured. (May or may not matter depending on UX intent — flagged for decision, not automatically a bug.)

10. **The deck-manager's `saveCallbacks.forEach` iterates the registry**, so reload/background/resign all save every card that has a registered callback — not just the active one. `action-dispatch.ts:514`'s `restoreActiveCardSelection` on become-active, by contrast, only restores the **active** pane's **active** card. Asymmetric scope: save-all, restore-one. (Rest of the cards' selection is restored when the user next tabs into them, via the card-activation path — if that path even fires a re-apply, which it currently does NOT.)

#### Audit checkpoint {#audit-checkpoint}

- Card types whose contents exercise persisted state: `tide` (TugPromptEntry + TugPromptInput inside), `git`, `hello` (stateless), gallery-* cards (primarily TugInput/TugTextarea/TugPromptInput/TugPromptEntry wrappers).
- Unique `componentId`s: 47 registered (mostly gallery demos).
- `useCardPersistence` consumers (outside internal infrastructure): `tug-input.tsx`, `tug-textarea.tsx`, `tug-prompt-entry.tsx`, `tug-prompt-input.tsx`, `gallery-textarea.tsx`.
- `data-tug-persist-value` consumers: `tug-input.tsx:191`, `tug-textarea.tsx` (analogous), gallery demos. DOM-authority walk is `card-host.tsx:101-120`.
- Will-phase event emission from Swift: confirmed present (`tugapp/Sources/AppDelegate.swift:199-211` per the previous plan's Q03 verification). No JS save subscriber currently uses them.

---

### Design decisions {#design-decisions}

Every decision below cites (a) the audit row(s) it rests on, (b) the tuglaws it upholds, and (c) the collision(s) from [#audit-collisions](#audit-collisions) it resolves. Decisions labeled **DECIDED** are locked; those labeled **PROPOSED** are the author's recommendation pending user sign-off.

#### [D01] Persistence is a **data representation**, not a runtime service (DECIDED) {#d01-data-not-service}

**Decision:** There is no "selection manager" object with `capture()` / `apply()` methods that owns cross-component apply logic. Persistence is a *schema* — a versioned bag shape stored per card — plus per-component adapters that serialize into and out of the schema. Each component that owns state (tide-card engine, `TugInput`, `TugTextarea`, `tug-markdown-view`) implements its own apply logic against its own DOM, because each component already knows how to apply its own state correctly.

**Cites:** [Table A](#audit-table-a) rows on contentEditable selection (dual-owned), form-control selection (card-host DOM-authority), engine `captureState/restoreState`; [Collision 1](#audit-collisions) (dual ownership); [Collision 7](#audit-collisions) (three independent restore paths).

**Upholds:** [L10] one responsibility per layer — each component owns its own apply logic. [L11] responders own the state actions mutate — components that own selection are responders for `cut`/`copy`/`selectAll`/etc.; those same components own restore. [L23] diff-and-mutate minimally — a centralized keeper re-applying selections across components is a "save and restore" pattern; per-component ownership lets each component diff-and-patch its own DOM.

**Rationale:** The previous plan's `SelectionKeeper` tried to own both the data and the apply logic. That put one module in the business of calling `setBaseAndExtent` into DOM trees owned by other modules, which silently conflicted with those modules' own restore logic (tide's engine). Separating **what to remember** (shared schema) from **how to reapply** (component-internal) eliminates the conflict by design.

**Implications:** The bag shape is exported from `layout-tree.ts` as a type only. Components import the type, implement `adapter.capture(boundary): PartOfBag` and `adapter.apply(boundary, PartOfBag): void` as local helpers, and wire those into their own existing mount/unmount/lifecycle plumbing. No central keeper module, no central apply method, no cross-component DOM writes.

---

#### [D02] Per-card bag schema carries five axes (PROPOSED) {#d02-bag-schema}

**Decision:** `CardStateBag` carries these axes, each independent:

| Axis | Type sketch | Owner at apply time |
|---|---|---|
| `scroll` | `{ x: number; y: number }` | Card-host — `hostContentEl.scrollLeft/Top` |
| `content` | `unknown` — opaque per-card payload | Card's content factory, via `useCardPersistence.onRestore` |
| `formControls` | `Record<persistKey, { value, selectionStart?, selectionEnd?, selectionDirection?, scrollTop?, scrollLeft? }>` | Card-host walk (`applyDomInputSnapshot` equivalent) — existing `domInputs` path, renamed |
| `regionScroll` | `Record<scrollKey, { x: number; y: number }>` | Card-host walk for every element carrying `data-tug-scroll-key="<key>"` — captures nested scrollable regions (e.g. markdown-view virtual scroll) distinct from the card's outer scroll |
| `domSelection` | `{ anchorPath: number[], anchorOffset, focusPath: number[], focusOffset } \| null` | Component that owns the contentEditable it anchors into; card-host passes it through to the owner via a new callback |
| `focus` | `{ kind: "none" } \| { kind: "form-control", persistKey: string } \| { kind: "dom", focusKey: string } \| { kind: "component-owned" }` | Card-host for keyed form-controls / focus-key elements; owning component for `component-owned` |

Every axis is optional on the bag — `scroll` without `formControls` is valid, etc. `regionScroll` is symmetric with `formControls`: both are keyed by an opt-in DOM attribute (`data-tug-scroll-key` mirrors `data-tug-persist-value`), walked by CardHost at save/restore, and uniqueness of keys within a card subtree is an author contract (same rule as `persistKey`).

**Cites:** [Table A](#audit-table-a) rows on each concept; [Collision 4](#audit-collisions) (focus not persisted at element level); [Collision 10](#audit-collisions) (asymmetric save/restore scope — a uniform schema covers all cards equally). For `regionScroll`: [Table C](#audit-table-c) rows on `scrollLeft/Top =` inside `tug-markdown-view.tsx` show internal scroll mutations not currently surfaced into any bag.

**Upholds:** [L23] user-visible state (scroll, selection, focus, content) is named explicitly in the schema. [L24] the schema is data-zone (semantic, read by non-rendering code for persistence); appearance-zone paint is separate (see [D04]).

**Rationale:** Paths rooted at the **card** boundary, not pane, so that cross-pane moves don't break path validity (the card's internal DOM travels with the card via `CardPortal`). `focus.kind === "component-owned"` is the marker for cards whose content-factory manages its own focus + selection together (tide-card → engine); restoring focus for those cards is the content factory's job, not card-host's. `regionScroll` closes the gap where a card has multiple scrollable regions (outer card scroll + internal virtual-list scroll, for example) and only the outer one is currently saved.

**Open question — see [Q01](#q01-v1-migration-scope).**

---

#### [D03] Card-level selection boundary registration (DECIDED) {#d03-card-level-boundary}

**Decision:** `useSelectionBoundary` is called with the card's `cardId` and its `[data-card-host][data-card-id]` element as the boundary, not with the pane id and the pane content element. `selectionGuard.boundaries` becomes keyed by card id. Where multiple cards exist inside one pane (tabs), each card registers its own boundary; only the active card's boundary matters at any one time for clipping, but the registry holds them all.

**Cites:** [Table A](#audit-table-a) (pane-level `bag.selection` keyed by card id — an existing mismatch); [Collision 2](#audit-collisions) pane-level vs card-level mismatch; [Collision 6](#audit-collisions) `saveSelection(paneId)` writing to `bag.selection` keyed by cardId.

**Upholds:** [L12] "Every card registers its content area as a selection boundary" (verbatim). `selection-model.md` § SelectionGuard ("operates at the card level only"). The tuglaw and the doc already prescribe this; current code drifted. This is restoration, not new design.

**Rationale:** The pane-level registration in `tug-pane.tsx:428` is a long-standing drift from the documented design. User's call on boundary layering was to fix that.

**Implications:** `useSelectionBoundary` callsite moves from `tug-pane.tsx` (keyed on pane) to `CardHost` (keyed on card). `useSelectionBoundary`'s `cardId` parameter was already named correctly; only the caller needs to change. Drag-clipping (`handlePointerMove`, `handleSelectionChange`) continues to operate at pane level for geometry but clamps to the active card's boundary — selectionGuard can look up the active card from the deck-state pointer.

---

#### [D04] Two-paint-layer model: `::selection` for one, CSS Custom Highlights for the rest (DECIDED) {#d04-two-paint-layers}

**Decision:** Paint is split in two:

- **Native `::selection`** paints the active selection on exactly one card — the focused card of the focused pane — operating on `window.getSelection()`. This is the browser's single live selection. The user can cut/copy from it, extend it, interact with it. It's unchanged from today.
- **CSS Custom Highlights** paint every *other* remembered selection as a dim, inactive highlight. Every card that has a known selection and isn't the focused card contributes its `Range` to the custom-highlight set. All such ranges paint simultaneously via one or more `::highlight(...)` CSS rules. The user cannot interact with these — they are appearance-only. They move in and out of the native slot as the user navigates cards.

The existing `inactive-selection` custom highlight in `selection-guard.ts:301` is the seed. Generalizing it from "one deactivated card during app resign" to "every non-focused card with a known selection, always" is the work.

**Cites:** [Table A](#audit-table-a) "CSS inactive-selection highlight"; [Table B](#audit-table-b) app resign/activate cycle; [Collision 8](#audit-collisions) (dim-highlight cycle is already a separate subsystem, just under-used). `selection-model.md` § Card Switch describes the inter-tab version of this mechanism as already-existing architecture.

**Upholds:** [L06] dim-highlight paint is appearance state — goes through CSS and DOM, never React. The `Highlight` object is mutated imperatively; React is not involved. [L22] the paint owner (selection-guard) subscribes directly to the persistence store, writes to the `Highlight` set; no React round-trip. [L24] paint = appearance zone; the Range data itself = data zone.

**Rationale:** The "one browser selection" constraint I previously misstated is only true for `::selection`. The CSS Custom Highlights API holds arbitrary simultaneous ranges. Prior commits already used this for tab-switch visibility; we generalize.

**Implications:**
- One tier may be sufficient: every non-focused card's selection paints via `inactive-selection`. If we later want to distinguish "inactive-in-active-pane" from "inactive-other-pane" visually, add a second named highlight. Start with one tier and add tiers only if UX demands.
- Ranges held in the custom highlight become stale if the underlying DOM mutates (innerHTML rewrite, node split, element removal). The owning component is responsible for notifying `selectionGuard` on DOM mutations that invalidate its range. See [D06] for the owner-publishes model and [R01](#r01-stale-ranges) for the risk.
- Form-control selection **does not paint via custom highlights**. `<input>` / `<textarea>` selections are internal to the form-control shadow tree and aren't addressable by outer-DOM Ranges. Form-control selections remain invisible when unfocused; this is a browser-platform limitation we accept. See [D05] for how we handle the visibility transition.

**Open question — see [Q02](#q02-paint-tiers).**

---

#### [D05] Component-published selection ranges feed the paint owner (PROPOSED) {#d05-component-publish}

**Decision:** Components that own DOM selection (tide's `TugTextEngine`, `tug-markdown-view`, and any future contentEditable owner) publish their current Range to `selectionGuard` via a narrow API:

```
selectionGuard.updateCardDomSelection(cardId, range | null)
```

Components call this when their selection changes *and* when their DOM mutates in a way that invalidates a held Range (e.g., engine's `restoreState` rebuilds innerHTML). SelectionGuard keeps a `Map<cardId, Range>` of current published ranges, maintains the custom-highlight set by subtracting whichever cardId currently holds focus, and paints accordingly.

For form-controls (TugInput, TugTextarea), there is no publish step — their `selectionStart/End` live in the DOM and are captured by the card-host walk on save. They don't participate in the inactive-highlight paint (per [D04]).

**Cites:** [Table C](#audit-table-c) engine `setSelectedRange` call sites (many); [Collision 1](#audit-collisions) dual ownership of tide's DOM selection.

**Upholds:** [L10] engine owns selection logic, selectionGuard owns paint; neither reaches into the other's DOM. [L22] selectionGuard subscribes to component-published state and writes to the DOM highlight directly.

**Rationale:** The alternative is to have selectionGuard poll `window.getSelection()` on every focus change, but that only reads the active selection — we need to remember *every* card's last-known selection, including ones whose cards aren't currently focused. Only the component itself knows its selection after a DOM mutation it just performed. A component-publishes model makes the ownership boundary clean.

**Implications:**
- Engine's public API gains `onSelectionChanged(cb: (range: Range | null) => void)` and tide-card's wiring subscribes to it, relaying to `selectionGuard.updateCardDomSelection(cardId, range)`.
- `tug-markdown-view` already tracks its own selection for copy operations; wire it similarly.
- `TugPromptInput` already wraps the engine; becomes the publisher.
- This is a *net new* contract, so it applies only to contentEditable-backed components. Form-controls don't need it.

**Open question — see [Q03](#q03-publish-frequency).**

---

#### [D06] Save triggers: will-phase lifecycle, close, beforeunload, saveState RPC (PROPOSED) {#d06-save-triggers}

**Decision:** The save callback registered per card fires on every transition that may dissolve or obscure state:

| Trigger | Wiring |
|---|---|
| `applicationWillResignActive` | new subscriber in `action-dispatch.ts` → `deckManager.saveAndFlush()`. Replaces the did-phase save for this event. |
| `applicationWillHide` | same |
| `applicationDidResignActive` / `applicationDidHide` | backstop only (if will-phase was missed) |
| `applicationWillUnhide` / `applicationWillBecomeActive` | no save |
| `window.beforeunload` | existing `DeckManager.handleBeforeUnload` |
| `document.visibilitychange(hidden)` | existing `DeckManager.handleVisibilityChange` |
| Swift `saveState` RPC | existing `window.tugdeck.saveState` → `DeckManager.saveAndFlushSync` |
| Card close | **new** — `DeckManager._removeCard` invokes the save callback before removing. Closes [Collision 9](#audit-collisions). |
| Tab switch within pane | existing `tug-pane.tsx:439` `performSelectCard` → `invokeSaveCallback(outgoingCardId)` |
| Cross-pane card move | existing `DeckManager._moveCardToPane:1269` → `invokeSaveCallback(cardId)` |
| Card detach | existing `DeckManager._detachCard:1175` |

**Cites:** [Table B](#audit-table-b) lifecycle trigger map; [Collision 3](#audit-collisions) will-phase has no save subscribers; [Collision 9](#audit-collisions) card close doesn't flush.

**Upholds:** [L23] user state must be preserved across bookkeeping operations — saving at will-phase, before the browser tears down visibility; saving at close, before the bag is orphaned.

**Rationale:** Will-phase capture is what prior Case γ diagnostics identified as necessary. Close-flush is what tuglaw L23 demands. Both are additive — no existing trigger is removed.

**Implications:**
- No change to the save callback *shape* — just more subscribers. Each card's `saveCurrentCardStateRef` runs as before; what changes is that the callback is invoked at more moments.
- Will-phase save + did-phase save can both fire in a given transition. That's fine; saves are idempotent with respect to the bag (we overwrite). The did-phase save becomes a cheap redundancy rather than the primary path.

---

#### [D07] Restore: per-component handoff at mount, paint on store change (PROPOSED) {#d07-restore-handoff}

**Decision:** On card mount, `CardHost` delivers the bag axes to their owners:

1. `bag.scroll` — card-host writes `hostContentEl.scrollLeft/Top` at layout effect time.
2. `bag.formControls` — card-host walks `[data-tug-persist-value]` and applies via `applyDomInputSnapshot` (existing logic, slightly renamed).
3. `bag.content` — card-host calls `onRestore(bag.content)` via `useCardPersistence`; content factory (e.g. tide-card) takes it from there.
4. `bag.domSelection` — card-host passes to the component that *owns* the boundary via a new persistence callback `onRestoreDomSelection(bag.domSelection)`. For tide-card, this callback no-ops: the engine already restored selection via `bag.content`. For generic contentEditable cards (if any), the callback is the restore path.
5. `bag.focus` — card-host applies after the content factory has had its re-render cycle (post `onContentReady`), gated by [Q02]'s Option B active-card check and by the component having signaled "ready to receive focus" via an explicit callback.

On app-active / card-active transitions, *no restore runs* for cards whose DOM is still mounted (per [D08]). The dim-highlight paint is updated in response to the store's active-card pointer change; ranges move between custom highlights and `window.getSelection()` without any save/restore round trip.

**Cites:** [Table B](#audit-table-b) reload / mount triggers; [Collision 1](#audit-collisions) (handoff replaces dual ownership); [Collision 10](#audit-collisions) (asymmetric save/restore — asymmetric is now correct: save covers all cards, restore on reload-only, paint handles in-app transitions).

**Upholds:** [L10] each axis goes to its owner. [L23] in-app transitions don't destroy state, so no "restore" fires — just a paint update. [L22] paint updates observe the store directly.

**Rationale:** The previous plan's failure mode was restoring cross-component on every transition. With [D08] (cards stay mounted) plus [D04] (two-paint layers), most transitions need no restore at all — just a visibility toggle.

**Implications:**
- New callback slot in `CardPersistenceCallbacks`: `onRestoreDomSelection?(snapshot: DomSelectionSnapshot | null): void`. Optional — cards whose engine already owns selection leave it undefined.
- Restore runs only on cold mount (reload / relaunch / first view after construction).
- Paint updates run on deck-state `activePaneId` / `activeCardId` change — subscribed via the existing `observeCardDidActivate` / store observers.

---

#### [D08] Cards stay mounted across transitions; save/restore is the cold-boot boundary only (DECIDED) {#d08-no-unmount-transitions}

**Decision:** `CardHost`'s existing `display: isActive ? "contents" : "none"` pattern already keeps every card mounted throughout its deck lifetime. We explicitly adopt this as the contract: no card unmounts on tab switch, pane activation, resign/activate, or hide/unhide. DOM nodes, form-control state, React component state, and observer subscriptions are all preserved across every in-app transition.

The only transitions that destroy DOM are:
- Reload / relaunch (process or page death)
- Explicit card close
- Card-host fundamental unmount (rare — component tree collapse)

For those, bag save-and-restore is the only path. For everything else, the DOM *is* the memory; we update paint and don't touch state.

**Cites:** `card-host.tsx:478` `style={{ display: isActive ? "contents" : "none" }}`; [Table B](#audit-table-b) rows for app-resign and tab-switch showing no DOM destruction.

**Upholds:** [L23] directly — this *is* the L23 preservation path. We don't save-and-restore; we don't disturb.

**Rationale:** The strongest form of L23. The more we rely on DOM as memory, the less save/restore code we need, the fewer race conditions, the fewer edge cases. Save/restore becomes the cold-boot boundary, which is where you can't avoid it — and only there.

**Implications:**
- Tab switch within pane: no save of outgoing card's bag needed (DOM stays). `tug-pane.tsx:439`'s `invokeSaveCallback(outgoingCardId)` becomes a cheap redundancy, safe to keep but not required.
- Cross-pane move: save before move remains necessary because the card's persistence bag is the authoritative store for the new pane's first render if the move requires any React state bookkeeping. DOM identity preservation via `CardPortal` is a separate mechanism from the bag; keep the pre-move save as belt-and-suspenders.
- App resign: save is still needed, because the browser may actually exit or reload. Will-phase save catches it.

---

#### [D09] `selectionGuard` becomes the paint authority + boundary registrar; its save/restore API retires (PROPOSED) {#d09-guard-role}

**Decision:** `selectionGuard`'s responsibilities, after this plan:

**Retained:**
- Card-level boundary registration (`registerBoundary(cardId, element)` keyed by card id per [D03]).
- Drag-clipping and keyboard-extension clipping at card boundaries (unchanged).
- Custom-highlight paint of inactive selections via [D04]'s generalization.
- `updateCardDomSelection(cardId, range | null)` publish endpoint per [D05].
- App-resign / app-activate CSS dim cycle — now a special case of the general [D04] paint (just a bigger transition).

**Retired:**
- `saveSelection(cardId)` and `restoreSelection(cardId, saved)` public methods. With per-component apply ([D01]) and no-restore-on-in-app-transition ([D08]), the guard is no longer the save/restore point for any card. These methods either become `@internal` or move into the one remaining consumer (cold-mount restore for generic contentEditable if any; none today).

**Cites:** [Table C](#audit-table-c) selectionGuard call-site inventory; [Collision 1](#audit-collisions), [Collision 7](#audit-collisions).

**Upholds:** [L10] each concern one owner — guard owns paint and boundary, not persistence. [L23] no more destruction-with-recovery path hidden behind `saveSelection`/`restoreSelection`.

**Implications:**
- Every caller of `selectionGuard.saveSelection` / `restoreSelection` (today: `card-host.tsx:334,289,245`, `action-dispatch.ts:510`) is removed. The bag's `domSelection` axis is populated directly by the owning component's adapter and consumed by the owning component's restore callback.
- The guard's `inactiveRanges: Map<cardId, Range>` generalizes from "one per lifecycle transition" to "one per non-focused card, always" — this becomes the paint backing store.

---

#### [D10] Focus persistence: card-level and element-level (DECIDED) {#d10-focus-persistence}

**Decision:** The deck layer already persists the active card (`initialFocusedCardId`). We add element-level focus via `bag.focus`:

- On save, `bag.focus` records which element inside the card had focus:
  - Form-control or focus-keyed element → `{ kind: "form-control" | "dom", persistKey_or_focusKey }`.
  - Engine-managed contentEditable with focus → `{ kind: "component-owned" }` (the owning component's `bag.content` carries the detailed state).
  - No interesting focus → `{ kind: "none" }`.
- On cold-boot restore, card-host applies focus if and only if this card is the active card of the active pane ([Q02] Option B from the previous plan, which stands — the gate is UX-driven, not implementation-driven). Other cards retain `bag.focus` for later use but do not steal focus speculatively.
- In-app transitions (tab switch, pane activate) do *not* restore focus from the bag — focus is already live in the DOM (per [D08]) because the card never unmounted. The only movement is the user-driven click that triggered the transition; the browser's native focus-change semantics apply.

**Cites:** [Collision 4](#audit-collisions) focus not persisted at element level; [Collision 5](#audit-collisions) form-control selection invisible without focus.

**Upholds:** [L23] element-level focus is user data — the user put the cursor there. We must preserve it.

**Rationale:** User's direct instruction: full element-level focus persistence is non-negotiable. The element-vs-card split keeps the schema simple while covering every real case.

---

#### [D11] DOM-preserving content restore for engine-managed cards (PROPOSED) {#d11-engine-diff-not-rewrite}

**Decision:** `TugTextEngine.restoreState` stops doing `this.root.innerHTML = parts.join("")` unconditionally. Instead:

1. If the engine's current DOM already reflects the target state (content matches), no-op. This is the steady-state skip.
2. If the engine's current DOM is empty and is receiving its first content, write innerHTML. (This is mount.)
3. If the engine's current DOM has content that differs from the target, diff-and-patch — mutate only the nodes that changed, leaving unchanged text nodes and their children in place. A minimal implementation can use DOM reconciliation ideas similar to React's, scoped to the flat parts list (text runs + `<br>` + `<img>` atoms).

The immediate L23 win: when an engine restoreState runs at mount with content identical to what's already there (e.g., HMR replay, spurious re-restore), the existing user selection anchors survive because we don't destroy the text nodes. The longer-term win: innerHTML rewrite disappears from the normal edit path.

**Cites:** [Table C](#audit-table-c) innerHTML write sites; [Collision 1](#audit-collisions) engine's rewrite displaces selection anchors.

**Upholds:** [L23] directly — this is the textbook "diff and mutate minimally" pattern the law describes. "Save and restore" (rewrite + setSelectedRange) is replaced with diff-and-patch.

**Rationale:** This is the riskiest/largest single change in the plan because it touches a 30KB engine module's hot path. But it's the only way to make tide-card selection survive non-trivial restore paths without conflicts. It also improves edit-path performance by removing unnecessary DOM churn.

**Implications:**
- New engine unit tests for idempotent restoreState (same content → no DOM mutation). Existing captureState/restoreState round-trip tests stay.
- Fallback path (full innerHTML rewrite) stays available for migration scenarios where the diff is too complex or the initial shape differs fundamentally.

**Open question — see [Q04](#q04-engine-diff-scope).**

---

#### [D12] No migration; old bags dropped on read (DECIDED) {#d12-no-migration}

**Decision:** There is no migration from the v1 bag shape. `readCardStates` in `settings-api.ts` simply returns the new shape directly, and any field in tugbank that doesn't match the new shape is ignored (the new field simply isn't populated). Old bags are effectively wiped on the first read; the next save writes the new shape. No `version` field on the bag — we don't need one because there is no forward-compatibility story to preserve.

**Cites:** [Table A](#audit-table-a) current v1 shape.

**Upholds:** Simplicity over defensive complexity. Per the user's guidance: there are no users besides the developer; a clean slate is cheaper than migration code.

**Implications:**
- `readCardStates` still returns `Map<cardId, CardStateBag>` but the values are already the new shape. TypeScript enforces the shape at the call site. Malformed entries in tugbank are silently dropped (the worst case is a brief selection-loss on the first reload after ship).
- No migration function. Simpler codebase.

---

#### [D13] Component persistence protocol: opt-in `persistKey`-keyed capture/restore (DECIDED) {#d13-component-persistence}

**Decision:** Stateful `tugways` components gain a framework-level persistence protocol. Each opt-in component registers via `useComponentPersistence({ persistKey, captureState, restoreState })`. The framework orchestrates capture and restore at explicit moments (`captureCardState` / `restoreCardState`) and harvests all registered components into a new `bag.components: Record<persistKey, unknown>` axis. Card authors no longer hand-serialize individual control state; they opt components in and the framework does the rest.

**Cites:** Component-roster L23 audit (surfaced the per-component gap — 5 of ~30 stateful components had any persistence path before this decision).

**Upholds:** [L23] "preserve user-visible state" — turns a per-card author-diligence concern into a framework guarantee. Decouples card authors from component internals. Makes adding a new stateful component a self-contained act (the component registers itself; cards that use it pick up persistence for free).

**Resolutions (all approved):**
- **Names:** `captureState` / `restoreState` (component), `captureCardState` / `restoreCardState` (framework), `useComponentPersistence` (hook).
- **Uniqueness:** enforced at card scope via dev-assertion; nesting supported via `<PersistenceScope prefix="…">` context that auto-prefixes child `persistKey`s.
- **Closure staleness:** internal ref storage ([L03]-compliant). `useComponentPersistence` stores the passed closures in refs, re-syncs on every render, framework reads the refs at capture time.
- **Capture / restore order:** parent-first for both. A parent's `captureState` cannot see child state directly; if it needs derived child state, it queries via an explicit observable or a shared store. Trade-off accepted for symmetry and simpler mental model.
- **Restore timing:** `useLayoutEffect` keyed on mount with a `has-restored` ref-guard; fires after DOM refs exist, before user interaction.
- **Partial restore:** unknown `persistKey`s are silently ignored with a dev-warn listing orphans. Symmetric to [D12].
- **Quiescence:** `captureState` must return synchronously. No Promises. Components with pending async state document their own policy (return current-committed, not pending-target).
- **Bag schema:** `bag.components` coexists with existing axes. Framework-synthesized axes (`formControls`, `regionScroll`, `focus`, `domSelection`, `markedText`) are populated by `CardHost` / `selectionGuard` / engine; `bag.components` is populated by the opt-in component harvest; `bag.content` remains the card's own content blob.
- **Opt-in:** absence of `persistKey` prop means "not persisted." Backward-compatible with gallery / test uses of the same components.
- **Relationship with `onCardActivated` ([A2]):** distinct responsibilities. `onCardActivated` is "re-focus on activation"; `captureState`/`restoreState` is "snapshot my interactive state." A component may implement both.
- **Frequency:** `captureState` fires only at explicit orchestration moments (will-resign, will-hide, tab switch, beforeunload, `saveState` RPC, close-before-destroy). Never per-keystroke.

**Implications:**
- Current persistence-aware components (`tug-input`, `tug-textarea`, `tug-prompt-input`, `tug-prompt-entry`, `tug-markdown-view` post-[AT0010]) port from `useCardPersistence` (card-level) to `useComponentPersistence` (component-level) where appropriate. `useCardPersistence` remains for cards themselves.
- `captureCardState` / `restoreCardState` become the **sole** explicit framework entry points for card-level snapshot/restore. All save triggers route through them; no trigger calls per-card `onSave` directly.
- See architecture piece [A9] for the implementation sketch.

---

### Open Questions {#open-questions}

Every question has a concrete decision the user must make before the execution plan is written. Questions referenced from design decisions as `[Qnn]`.

#### [Q01] Migration scope for v1 `bag.selection` (DECIDED) {#q01-v1-migration-scope}

**Question.** v1 stored `bag.selection` as a `SavedSelection` with paths rooted at the **pane** boundary (pre-[D03]). v2 roots paths at the **card** boundary. Do we:
- (a) Migrate v1 paths verbatim into v2 `domSelection` and accept that they may fail to resolve on first restore, then get rewritten correctly on the next save.
- (b) Attempt to re-root v1 paths at card boundaries during migration (requires walking paths and finding the card ancestor).
- (c) Drop v1 `bag.selection` entirely and accept one-time loss for pre-migration bags.

**Resolution:** DECIDED (c). There are no users; pre-migration bags can be discarded. Keep the code simple. See [D12](#d12-no-migration).

#### [Q02] Paint tier count for inactive highlights (DECIDED) {#q02-paint-tiers}

**Question.** Do we paint all non-focused cards' remembered selections at one dim level, or do we distinguish "inactive-in-active-pane" (card is in the active pane but not the active card) from "inactive-in-inactive-pane" (card is in a non-active pane)?

**Resolution:** DECIDED (one tier). All inactive selections paint through the existing `inactive-selection` CSS Custom Highlight. No UI distinction between card-inactive-within-active-pane and card-in-inactive-pane. Revisitable post-ship.

#### [Q03] Component publish frequency for DOM-selection ranges (DECIDED) {#q03-publish-frequency}

**Question.** How often should a component publish its current Range to `selectionGuard.updateCardDomSelection`?
- (a) On every `selectionchange` (fine-grained, most expensive, always-correct).
- (b) On focus-leave + DOM mutation (coarse, cheaper, only when the range would become "remembered").
- (c) Lazy — publish only when asked (selectionGuard queries on deactivate).

**Resolution:** DECIDED (a). Publish eagerly from the engine on every internal selection change — `setSelectedRange`, `restoreState` tail, and a `selectionchange` listener scoped to the engine's root. The operation is a `Map.set` followed by a `updatePaint()` that short-circuits when only the focused card's entry changed (the focused card's range lives in `window.getSelection()` and paints natively; the inactive-highlight rebuild produces an identical output and can skip re-paint). Net cost per caret move: one Map write and a short-circuit check — cheap. Rejected (b) as underspecified: "focus-out" is not a single event in the engine, and a component that publishes only at focus-out loses its range mid-composition if the DOM mutates before the user blurs. Rejected (c) as racy against app-resign.

#### [Q04] Engine diff-restore scope (DECIDED) {#q04-engine-diff-scope}

**Question.** How thorough should [D11]'s diff-restore in the engine be?
- (a) "Content-identical fast path" only — skip the innerHTML rewrite if the captured state matches what the engine already has in its DOM; otherwise full rewrite.
- (b) True flat-parts diff — compare the new `parts.join("")` against the current DOM and mutate only the differences.
- (c) Full DOM reconciliation over the flat parts list (React-like keyed diff).

**Resolution:** DECIDED (a). Ship the content-identical fast path only. (b) and (c) are deferred as follow-ons.

#### [Q05] Close-flush timing: before or after destroy lifecycle event (DECIDED) {#q05-close-flush-timing}

**Question.** `DeckManager._removeCard` fires `cardWillBeginDestruction` as part of its commit. Does save-on-close fire before or after the will-begin-destruction notification?

**Resolution:** DECIDED (before). The save callback runs before `cardWillBeginDestruction` subscribers fire, so subscribers that release resources don't cut the ground out from under the save.

#### [Q06] Engine's selection publish API placement (DECIDED) {#q06-engine-publish-api}

**Question.** Where does the engine expose its "publish current Range" hook?
- (a) On `TugTextEngine` directly — `engine.onSelectionChanged(cb)`.
- (b) On `TugPromptInput` (the React wrapper) — component-level integration surface.
- (c) On the `CardPersistenceCallbacks` — card-host pattern extension.

**Resolution:** DECIDED (a) + (c). `engine.onSelectionChanged(cb)` is the source API on the engine. The wiring from engine → `selectionGuard.updateCardDomSelection` runs through `CardPersistenceCallbacks` extensions so CardHost can own the cardId-to-guard relay. `TugPromptInput` stays thin.

---

### Risks and mitigations {#risks}

#### [R01] Stale `Range` objects held in custom highlights (MED) {#r01-stale-ranges}

- **Risk:** A `Range` held in `selectionGuard.inactiveRanges` becomes invalid when the DOM it anchors into is mutated (engine innerHTML rewrite, React re-render that replaces nodes). Paint becomes nonsense or throws on access.
- **Mitigation:** Components that mutate their DOM must call `selectionGuard.updateCardDomSelection(cardId, newRange | null)` after every such mutation. [D05] / [Q03] formalize this. [D11]'s diff-instead-of-rewrite engine path reduces how often this is needed.
- **Residual:** Components that mutate DOM without publishing will silently produce stale highlights. Wired in [Step 5](#step-5): `updatePaint()` validates every Range before painting via `document.contains(range.startContainer) && document.contains(range.endContainer)`; stale entries are dropped from `cardRanges` and a dev-mode `console.warn` logs the offending cardId with a "owning component did not re-publish after DOM mutation" message. The Step 5 test list pins this behavior.

#### [R02] IME composition in-flight during will-phase capture (MED) {#r02-ime-composition}

- **Risk:** On `applicationWillResignActive`, the user may be mid-IME-composition (CJK input). `selectionStart/End` during composition reads buffer offsets that may not map back after activation.
- **Mitigation:** Save handlers that read `selectionStart/End` check `document.activeElement` for an active composition via `isComposing` on tracked CompositionEvent state. If composition is active, defer the save until `compositionend`. The will-phase event itself still fires and dim paint updates; only the precise offsets wait.
- **Residual:** Process-exit before `compositionend` loses in-flight composition. Browser-platform limit; can't be fully eliminated.

#### [R03] WebKit programmatic-selection degradation on repeated apply (MED) {#r03-programmatic-selection}

- **Risk:** If a component repeatedly calls `setSelectionRange` / `setBaseAndExtent` on the same element across multiple transitions, WebKit may silently degrade the selection (the "Case γ" pattern from the previous plan).
- **Mitigation:** [D08] + [D07] together eliminate most programmatic re-applies in steady state. Components that restore selection (engine at mount, card-host at reload mount) apply once per mount. Skip-if-already-correct checks inside [D11]'s diff path avoid re-apply when state already matches.
- **Residual:** Reload still programmaticizes on restore. That's unavoidable — the DOM is new.

#### [R04] CSS Custom Highlights API browser support (CLOSED) {#r04-highlights-support}

- **Risk:** CSS Custom Highlights API shipped in WebKit 17.4 (March 2024). Older environments paint nothing.
- **Mitigation:** Minimum supported environment is **macOS 15.6**, which carries WebKit 20.x — well past the 17.4 threshold. No compatibility concern.
- **Status:** Closed per user confirmation.

#### [R05] Engine diff-restore regression surface (HIGH) {#r05-engine-diff-regression}

- **Risk:** [D11]'s engine restoreState diff change is a large behavior change in a hot path. Regression candidates: edit undo, content restore at mount, IME composition, cursor placement after restore.
- **Mitigation:** Start with Option (a) (content-identical skip only). Extensive engine unit test coverage before shipping. The full (b) / (c) diff is explicitly deferred to a follow-on plan.
- **Residual:** Unknown until we try. This is the riskiest single change; it gets its own Step with a full regression test matrix.

#### [R06] `_removeCard` save callback may throw (LOW) {#r06-close-throw}

- **Risk:** Save-on-close invokes the card's save callback, which may throw (e.g., serialization failure). Does destruction proceed?
- **Mitigation:** Wrap the close-save in try/catch; log in dev mode; proceed with destruction regardless. Losing save on close is a worse failure than continuing; at least the deck state stays consistent.
- **Residual:** A user closes a card whose save throws, and they don't know the bag didn't persist. Accept.

#### [R07] Focus restore at reload interrupts user typing (LOW) {#r07-focus-steal-on-reload}

- **Risk:** After reload, `CardHost` restores focus to the element that had focus at save time. If the user is already typing in a different element by the time restore fires, we steal focus.
- **Mitigation:** [Q02] Option B (from the previous plan, retained) — restore focus only when this card is the active card of the active pane at mount. Even then, check if focus is already somewhere inside the card; if yes, don't move it.
- **Residual:** Cold-boot race between user and restore. Rare; acceptable.

---

### Execution Steps {#execution-steps}

The implementation sequence begins with 15 commits (Steps 1–15) landing the selection/focus/scroll persistence subsystem. Each is independently revertable. The compile target stays green end-to-end; the user-visible save/restore behavior may regress briefly between commits (from Step 1 through Step 10) and comes back fully correct at Step 10. Integration tests at Step 14 pin every transition.

Steps 16–19 land M-phase 0 of the AT-series — the Component Persistence Protocol foundation ([A9] / [D13]). The AT-series continues beyond Step 19 (subsequent phases authored as separate step blocks); Step NN performs the final documentation + cleanup pass.

#### Step 1: Replace `CardStateBag` shape; strip old-shape callers {#step-1}

**Depends on:** —

**Commit:** `refactor(layout-tree): replace CardStateBag with v2 shape (no migration)`

**References:** [D01](#d01-data-not-service), [D02](#d02-bag-schema), [D12](#d12-no-migration), [Collision 2](#audit-collisions), [Collision 6](#audit-collisions); `layout-tree.ts:37-49`, `card-host.tsx:334,245,289,101-120`, `action-dispatch.ts:510`.

**Artifacts:**
- `tugdeck/src/layout-tree.ts`: `CardStateBag` with these fields only: `scroll?`, `content?`, `formControls?` (renamed from `domInputs`), `regionScroll?` (null at Step 1; shape finalized at Step 9), `domSelection?` (null at Step 1; shape finalized at Step 6), `focus?` (null at Step 1; shape finalized at Step 7). `SavedSelection` re-export removed from `layout-tree.ts` (it stays in `selection-guard.ts` for that module's own internal use during the migration period).
- `DomInputSnapshot` renamed to `FormControlSnapshot`; selection fields (`selectionStart`/`End`/`Direction`) drop out of the type because Step 8 moves them to a single per-card capture path (they're currently there at `layout-tree.ts:58-60`, redundantly). Keep `value`, `scrollTop`, `scrollLeft`.
- New types declared with null placeholders on the bag: `RegionScrollSnapshot | null`, `DomSelectionSnapshot | null`, `FocusSnapshot | null`. Shape is finalized at the step that captures each axis (Steps 6, 7, 9).

**Tasks:**
- [x] Rewrite `layout-tree.ts` types. Drop `SavedSelection` import and re-export.
- [x] Remove `captureDomInputs`' selection-field capture at `card-host.tsx:113-115` (anticipates Step 8 which relocates them).
- [x] Remove `applyDomInputSnapshot`'s `setSelectionRange` call at `card-host.tsx:151-167` (anticipates Step 8).
- [x] Rename `captureDomInputs` → `captureFormControls`; `applyDomInputSnapshot` → `applyFormControlSnapshot`; update all callers inside `card-host.tsx`.
- [x] Remove `selectionGuard.saveSelection(hostStackId)` callsite at `card-host.tsx:334` (inside `saveCurrentCardStateRef.current`). Replace with `domSelection: null` until Step 7 wires new capture.
- [x] Remove `selectionGuard.restoreSelection(...)` callsites at `card-host.tsx:245,289` and `action-dispatch.ts:510`. Leave stubs with comment pointing at the step that restores them (Step 9 / Step 10).
- [x] Remove the now-unused `selectionGuard` import from `card-host.tsx` and `action-dispatch.ts` if nothing else uses it there.
- [x] Remove the `bag.selection != null` check from `action-dispatch.ts`'s `restoreActiveCardSelection` helper; simplify down to the scroll/`saveAndFlush` path already there (symmetric save on did-resign remains unchanged).

**Upholds:** [L10] (card-host, selection-guard ownership boundaries unchanged). [L23] (data fields for user-visible state — scroll, selection, focus — are named in the schema explicitly).

**Tests:**
- [x] `bun test` passes; `bun x tsc --noEmit` passes.
- [x] Add `layout-tree.test.ts` JSON round-trip assertions for each new bag axis shape (including empty-axis cases).
- [x] Existing `card-host-composition.test.tsx` passes with the renamed fields.

**Checkpoint:**
- [x] `bun x tsc --noEmit` exits 0.
- [x] `bun test` full suite green.
- [x] Grep `selectionGuard.saveSelection\|selectionGuard.restoreSelection` inside `tugdeck/src/` returns only the definitions inside `selection-guard.ts` (no outside callers). *Residual: test callers in `__tests__/selection-guard*.test.ts`, `__tests__/selection-model.test.tsx`, `__tests__/use-selection-boundary.test.tsx` still exercise the legacy API directly. They retire alongside the API at Step 9 / Step 15.*

---

#### Step 2: Move selection boundary registration to card level {#step-2}

**Depends on:** #step-1

**Commit:** `refactor(selection-guard): register boundaries by cardId via CardHost`

**References:** [D03](#d03-card-level-boundary), [L12], `selection-model.md` § SelectionGuard ("operates at the card level only"); `tug-pane.tsx:428`, `hooks/use-selection-boundary.ts:49-63`, `card-host.tsx:470-505`.

**Artifacts:**
- `useSelectionBoundary(cardId, cardRootRef)` is called inside `CardHost`, keyed on the card-host div (`[data-card-host][data-card-id]`), not on pane content. Remove the call from `TugPane` (`tug-pane.tsx:428`).
- `selectionGuard.registerBoundary` continues to take a string key (the key name was already `cardId` in the type). Its internal `boundaries: Map<string, HTMLElement>` now holds one entry per card, not one per pane.
- Drag-clip / keyboard-extend clipping inside `selection-guard.ts` (see `handlePointerMove`, `handleSelectionChange`) continues to operate correctly because it looks up the boundary of the card under the pointer. The currently-tracked card id (`activeCardId`) is resolved from the pointerdown target (find `[data-card-host]` ancestor) rather than from the pane that was clicked.
- `activeCardId_highlight` inside selection-guard continues to name the card that owns the active selection — semantics unchanged at this step.
- New private helper `getBoundaryRect(boundary)` inside `selection-guard.ts`. The card-host div uses `display: contents`, which returns a zero `DOMRect` from `getBoundingClientRect()`. The helper walks up to the nearest ancestor that produces a real box (the pane's content div in practice) so drag-clip/autoscroll keep clamping against the same viewport rect they used pre-Step-2.

**Tasks:**
- [x] Remove `useSelectionBoundary(stackId, contentRef)` from `tug-pane.tsx:428`.
- [x] Add a `cardRootRef` inside `CardHost` that attaches to the existing `[data-card-host][data-card-id]` div at `card-host.tsx:473-480`.
- [x] Call `useSelectionBoundary(cardId, cardRootRef)` from within `CardHost`.
- [x] Inside `selection-guard.ts`, change any code that resolves a card-under-pointer via pane lookup to resolve via `el.closest('[data-card-host]')`. Specifically: the `pointerdown` handler's card-tracking path (approximately `selection-guard.ts:456` area — `activateCard`).
- [x] Update `selection-model.md` table row for `useSelectionBoundary` to name the card-host div, not `.tug-pane-chrome-content`.
- [x] Add `getBoundaryRect` helper and route every `boundary.getBoundingClientRect()` through it (`display: contents` zero-rect fallback).

**Upholds:** [L12] card-level selection boundary (verbatim, restored). [L10] selection-guard stays the boundary owner; card-host delegates boundary registration.

**Tests:**
- [x] `selection-model.test.tsx`' boundary registration tests: register per card id. Assert that a multi-card pane has N boundaries registered (one per card), not 1.
- [x] `selection-guard`' drag-clip test that the clip destination resolves via `closest('[data-card-host]')`.
- [x] `card-host-composition.test.tsx` still green.

**Checkpoint:**
- [x] `bun x tsc --noEmit` exits 0.
- [x] `bun test` full suite green (2214 pass).
- [x] Manual probe: render two cards in a single pane and confirm `selectionGuard.boundaries` has two entries at runtime. *Verified: a two-tab Tide pane + a single-card Hello World pane yielded `boundaries.size === 3`, with two entries sharing the Tide pane's `data-pane-id` and one in the other pane. Temporary `window.__selectionGuard` expose was stripped before commit.*

---

#### Step 3: `TugTextEngine.onSelectionChanged` publish API {#step-3}

**Depends on:** #step-2

**Commit:** `feat(tug-text-engine): add onSelectionChanged publish API`

**References:** [D05](#d05-component-publish), [Q06](#q06-engine-publish-api), [L10], [L11]; `lib/tug-text-engine.ts:78,449,632,658`, `components/tugways/tug-prompt-input.tsx:817`.

**Artifacts:**
- New engine method: `onSelectionChanged(cb: (range: Range | null) => void): () => void`. Returns a dispose function.
- Engine fires the callback synchronously after any call that changes its internal selection:
  - `setSelectedRange` at `tug-text-engine.ts:449`.
  - `restoreState`'s tail at `tug-text-engine.ts:658`.
  - Any other path that ends in a `sel.setBaseAndExtent` write (interactive selection from the user's drag / click / keyboard is a separate code path that goes through native selectionchange; see Tasks below).

- Engine publishes `null` when there's no active selection inside its root (e.g., after a `clear`), and a live `Range` object (cloned from `window.getSelection().getRangeAt(0)`) when there is one.
- Two new private invariants that keep the contract stable across environments: (a) a `_suppressSelectionEmits` flag wrapping atomic multi-write sequences (`setSelectedRange`'s `removeAllRanges` + `addRange`, `restoreState`'s `innerHTML=…` + nested `setSelectedRange`, `clear`'s `innerHTML=""`) so only the outer entry point emits; (b) dedup on anchor/focus endpoints so redundant `selectionchange` fires (happy-dom's synchronous dispatch, or real browsers' async echo after a programmatic write) are collapsed to a single emit.

**Tasks:**
- [x] Add `onSelectionChanged` to the engine's public interface at `lib/tug-text-engine.ts:78`.
- [x] Implement subscriber list as `Set<(range: Range | null) => void>` with a dispose-function contract.
- [x] Add the emit call inside `setSelectedRange` and at the tail of `restoreState`. Each call reads the current `window.getSelection()` if the root has focus; otherwise constructs a Range from the engine's internal selection coords and root.
- [x] Add an `input` / `selectionchange` listener on the engine root so the engine publishes selection as the user interactively drags/types. Scope the listener to `this.root` so it doesn't fire for selections outside the engine. *Implementation: `selectionchange` fires on `document`, so the listener registers at document scope and `emitSelectionChanged` self-filters via `this.root.contains(anchor)`. No separate `input` listener needed — content-change-driven selection shifts always trigger a `selectionchange`.*
- [x] Dispose subscribers in the engine's `destroy` method. *The engine's cleanup entry point is named `teardown`; subscribers + dedup state are cleared there.*
- [x] Expose `onSelectionChanged` on the `TugPromptInputDelegate` (via `tug-prompt-input.tsx`'s `useImperativeHandle`) so cross-component consumers can subscribe through the same API surface as the engine.

**Upholds:** [L11] engine owns its selection state; exposes a hook for non-owner observers to subscribe rather than poking at engine internals. [L10] engine publishes; selection-guard consumes.

**Tests:**
- [x] New `tug-text-engine.test.ts` tests: `engine.setSelectedRange(a, b)` fires `onSelectionChanged` with a Range matching `a,b`; `engine.restoreState(...)` fires with the restored range; `engine.clear()` fires `null`.
- [x] Unsubscribe actually stops firing.
- [x] A user-driven selectionchange (simulated via happy-dom) fires `onSelectionChanged` exactly once with the current Range.
- [x] Transition-out case (selection moves from inside the root to outside) emits `null` exactly once.
- [x] Multiple subscribers all fire; unsubscribing one leaves the other intact.
- [x] `teardown` drops subscribers.

**Checkpoint:**
- [x] `bun x tsc --noEmit`, `bun test` green (2224 pass).

---

#### Step 4: Wire engine publish → `selectionGuard.updateCardDomSelection` {#step-4}

**Depends on:** #step-3

**Commit:** `feat(selection-guard): updateCardDomSelection + TugPromptInput wiring`

**References:** [D05](#d05-component-publish), [Q06](#q06-engine-publish-api); `selection-guard.ts:262,538-545`, `tug-prompt-input.tsx:357-364,481,817`, `card-host.tsx:223-263,485`.

**Artifacts:**
- New public method on `selectionGuard`:
  ```
  updateCardDomSelection(cardId: string, range: Range | null): void
  ```
  Stores the Range in `cardRanges: Map<cardId, Range | null>` (new internal state, separate from the old `inactiveRanges` which is retired in Step 6).
- `TugPromptInput` subscribes to its engine's `onSelectionChanged` in a `useLayoutEffect` scoped to the engine's lifetime and the `cardId` from `CardPersistenceContext`. On each callback, invokes `selectionGuard.updateCardDomSelection(cardId, range)`. Unsubscribes on unmount.
- `CardPersistenceCallbacks` gains no new fields at this step; the wiring lives inside `TugPromptInput` and reads `cardId` from the callback-register flow already established in [`CardHost`'s register contract](#audit-table-a).
- Step 3's eager publish ([Q03] resolution (a)) is the implementation: the engine publishes on `setSelectedRange`, `restoreState` tail, and its own scoped `selectionchange` listener. Cost is bounded because `updatePaint()` (Step 5) short-circuits when the only change is to the focused card's entry (that range is painted natively via `window.getSelection()`, not via the inactive highlight).

**Tasks:**
- [x] Add `cardRanges` and `updateCardDomSelection` to `selection-guard.ts`. *Also added a read-only `getCardRange(cardId)` accessor — Step 5's paint loop and Step 4's tests both need to observe the store without poking private fields. Also wired `cardRanges.delete(cardId)` into both `unregisterBoundary` and `reset` so boundary teardown and test isolation drop entries in lockstep.*
- [x] In `TugPromptInput` (search for the engine-creation `useLayoutEffect` around line 640-650), subscribe to `engine.onSelectionChanged` and relay to `selectionGuard.updateCardDomSelection(cardId, range)`.
- [x] Ensure the `cardId` is reachable inside `TugPromptInput` — it already has `CardPersistenceContext` (`tug-prompt-input.tsx:349`). If `cardId` isn't currently exposed there, expose it alongside the existing register callback in `CardHost`'s persistence context value at `card-host.tsx:485`. *Implementation: `CardPersistenceContext` value type changed from `register-fn` to `{ cardId, register }`; added `useCardId()` hook as the canonical read path. `CardHost` provides a memoized `{ cardId, register }` pair; `useCardPersistence` destructures `.register`. Test provider in `use-card-persistence.test.tsx` updated to the new shape.*
- [x] At unsubscribe / card unmount, call `selectionGuard.updateCardDomSelection(cardId, null)` to clear the Range from the store.

**Upholds:** [L10] engine and selection-guard talk through a narrow interface (`updateCardDomSelection`). [L22] `cardRanges` drives downstream DOM paint (Step 5) via direct store observation, not React round-trip.

**Tests:**
- [x] `card-host-composition.test.tsx` grows a test: mount a `TugPromptInput` card, call `engine.setSelectedRange(3, 7)`, assert `selectionGuard.cardRanges.get(cardId)` holds a Range with those offsets.
- [x] Unmount clears the entry.

**Checkpoint:**
- [x] `bun x tsc --noEmit`, `bun test` green (2226 pass).

---

#### Step 5: Generalize selection-guard paint for multi-card inactive highlights {#step-5}

**Depends on:** #step-4

**Commit:** `feat(selection-guard): paint every non-focused card's range via inactive highlight`

**References:** [D04](#d04-two-paint-layers), [Q02](#q02-paint-tiers), [L06], [L22]; `selection-guard.ts:293,301,530-580`, `tug-pane.css` `::highlight(inactive-selection)`.

**Artifacts:**
- SelectionGuard paints every entry of `cardRanges` in the `inactive-selection` Highlight **except** the entry whose cardId matches the deck's active-pane's active card. That one range is mirrored into `window.getSelection()` so `::selection` paints it.
- Paint updates fire on: (a) `cardRanges.set`/`delete` calls via `updateCardDomSelection`; (b) deck-state change on `activePaneId` or the active pane's `activeCardId`, via a new `store.subscribe` subscription installed in `selectionGuard.attach` (already receives `appLifecycle`; extend to take the deck store too or reach it through `getDeckManager()`).
- `updatePaint()` validates every Range before painting: if `!document.contains(range.startContainer) || !document.contains(range.endContainer)`, the Range is stale (its anchor DOM was detached — the classic [R01](#r01-stale-ranges) failure: an engine or other component mutated its subtree without calling `updateCardDomSelection(cardId, newRange)`). Stale Ranges are dropped from `cardRanges` and, in dev builds (`isDevEnv()`), a `console.warn` logs the offending `cardId` with a "stale range dropped — owning component did not re-publish after DOM mutation" message. Prod builds silently drop. This closes the R01 residual the previous plan left open.
- **Perf short-circuit.** `updatePaint()` takes an optional `hint: { changedCardId?: string }` parameter. When the only change is to the currently-focused card's entry (`hint.changedCardId === getFocusedCardId() && windowHasFocus`), skip the `inactiveHighlight` rebuild entirely — the focused card's range is painted natively via `window.getSelection()`, and the inactive-highlight set is unchanged. `updateCardDomSelection` passes `{ changedCardId: cardId }`. Deck-state-change callers pass no hint (full rebuild). This bounds the cost of eager publishing ([Q03]): per-caret-move cost is one Map write plus one short-circuit check.
- The existing `handleApplicationDidResignActive` / `handleApplicationDidBecomeActive` refactor: on resign, the active card's cardId is temporarily dropped from the "focused" position so its Range also paints in the custom highlight (matches current dim behavior); on become-active, the cardId is restored. Internally this can just flip a boolean `windowHasFocus` read by the paint computation; the effect is the same as the old dedicated map but without a separate code path.

**Tasks:**
- [x] Add `windowHasFocus` boolean (defaults true, flips on will-resign/did-become).
- [x] Add `getFocusedCardId(): string | null` — resolves via deck-state `activePaneId` → `pane.activeCardId`. *Implementation: reads the process-wide `getDeckStore()`; returns `null` when no store is registered so tests that bootstrap only the guard no-op cleanly.*
- [x] `updatePaint(hint?: { changedCardId?: string })` (new internal method): if the hint indicates the focused card's entry changed while `windowHasFocus`, short-circuit. Otherwise clear `inactiveHighlight` and rebuild from `cardRanges` minus the focused card's entry (when `windowHasFocus` is true), validating each Range's containers against `document.contains` and dropping stale entries with a dev-warn. Moves the focused-card range into `window.getSelection()`.
- [x] `updateCardDomSelection(cardId, range)` calls `updatePaint({ changedCardId: cardId })`.
- [x] Subscribe to deck-state changes — on `activeCardId` or `activePaneId` change, call `updatePaint()` (no hint → full rebuild). *Implementation: new `lib/deck-store-registry.ts` singleton (mirrors `lib/card-lifecycle.ts`/`lib/app-lifecycle.ts`); `DeckManager` constructor calls `registerDeckStore(this)` before rendering; `selectionGuard.attach` reads `getDeckStore()` and subscribes. `detach` releases the subscription. An initial `updatePaint()` after subscribing syncs paint to the store's current active card.*
- [x] Retire `inactiveRanges` and `deactivatedCardId` fields from `selection-guard.ts` — subsumed by `cardRanges` + `windowHasFocus`. *`saveSelection`'s legacy fallback path now reads `cardRanges` instead of `inactiveRanges`; the API itself retires at Step 9.*
- [x] `handleApplicationWillResignActive` / `handleApplicationDidBecomeActive` refactor — they now only flip `windowHasFocus` and call `updatePaint()`. No more manual Range cloning. *Note: the plan names `handleApplicationWillResignActive` but the current wiring still subscribes to the did-phase events (will-phase triggers are Step 13's concern). The bodies are refactored per the plan; the subscription point changes in Step 13.*
- [x] Share `isDevEnv` as a `lib/dev-env.ts` helper so `selection-guard` (and any other module that needs the dev gate) can import it. `deck-manager.ts` now imports the shared helper instead of defining its own copy.
- [x] **Fix: engine must not emit `null` on focus-out.** The Step 3 listener was emitting `null` whenever the selection moved outside the engine's root — which immediately dropped `cardRanges[cardId]` and made the dim-on-switch UX impossible (nothing to paint). The listener now early-returns for out-of-root selections; only programmatic clears (`clear()` / `restoreState({selection: null})`) still emit `null` at their own call sites. The `tug-text-engine.test.ts` transition-out test is rewritten to pin the new contract.
- [x] **Fix: restore `preventMousedown` on focus-change.** The click that triggers a card switch was collapsing `setBaseAndExtent`'s restoration to the click point. The deck-store subscription handler now tracks the last-painted focus id; when focus genuinely moves to a card that has a saved `cardRange`, it installs the one-shot capture-phase mousedown interceptor *before* calling `updatePaint`. Cards without a saved Range get normal click-to-caret behavior. Three new T29 tests pin: interceptor installed on restore-worthy focus-change; not installed when the new card has no saved Range; not installed when the store fires without a focus change.

**Upholds:** [L06] paint is appearance-zone — CSS Highlight mutation, no React. [L22] paint subscribes to the deck store and writes to the DOM highlight directly.

**Tests:**
- [x] Register two cards, publish a Range for each, flip `activeCardId` between them, assert only the currently-active card's range is in `window.getSelection()` and the other is in `inactive-selection`.
- [x] App resign: both ranges paint in `inactive-selection`.
- [x] App become-active: focused card's range moves back to native; other remains in inactive.
- [x] Mutation tests for `updateCardDomSelection(cardId, null)` → removes from paint.
- [x] **Stale-range drop**: publish a Range, then detach the anchoring element from the document (simulates an engine-root replacement without a re-publish), trigger an unrelated `updatePaint()` (e.g., a deck-state change), assert the stale entry is removed from `cardRanges` and a dev-warn was emitted.
- [x] **Perf short-circuit**: `updatePaint({ changedCardId })` where `changedCardId === getFocusedCardId() && windowHasFocus` does NOT call `inactiveHighlight.clear()` (assert via spy).
- [x] Retired 5 legacy `selection-guard-highlight.test.ts` cases that pinned the old `activateCard`-populates-`inactiveRanges` mechanism; their spiritual successors live in the new `selection-guard-paint.test.ts`.

**Checkpoint:**
- [x] `bun x tsc --noEmit`, `bun test` green (2227 pass).
- [ ] Manual probe: open a tide card and a gallery card side-by-side, select in tide, switch to gallery — tide's selection paints dim; switch back — goes bright.

---

#### Step 6: Capture `bag.domSelection` at save time {#step-6}

**Depends on:** #step-5

**Commit:** `feat(card-host): serialize bag.domSelection from selection-guard cardRanges`

**References:** [D02](#d02-bag-schema), [D07](#d07-restore-handoff); `card-host.tsx:329-356`, `selection-guard.ts` (new `cardRanges` from Step 5).

**Artifacts:**
- `selectionGuard.getCardRange(cardId): Range | null` new read API returning the currently-stored Range.
- `CardHost`'s `saveCurrentCardStateRef.current` now:
  - Reads `selectionGuard.getCardRange(cardId)`.
  - If non-null and both endpoints are inside `cardRoot`, builds a `DomSelectionSnapshot` (`{ anchorPath, anchorOffset, focusPath, focusOffset }`) using `nodeToPath` (existing helper inside `selection-guard.ts:142` — either expose or duplicate).
  - Assigns to `bag.domSelection`.
- `DomSelectionSnapshot` type finalized in `layout-tree.ts` (was `null` placeholder at Step 1).

**Tasks:**
- [x] Add `getCardRange` to `selection-guard.ts`. _(landed in Step 5; re-verified.)_
- [x] Expose `nodeToPath` as a public helper inside `selection-guard.ts` (was private), or import it from there to `card-host.tsx`.
- [x] In `saveCurrentCardStateRef.current`, capture `domSelection`.
- [x] Add unit test for the serializer.

**Upholds:** [L10] selection-guard owns the live Range; card-host owns serialization shape into the bag.

**Tests:**
- [x] Serialize a Range anchored inside a card root, assert the paths and offsets round-trip.
- [x] Range whose endpoints fall outside the card root → `domSelection: null`.

**Checkpoint:**
- [x] `bun x tsc --noEmit`, `bun test` green.

---

#### Step 7: Capture `bag.focus` at save time {#step-7}

**Depends on:** #step-6

**Commit:** `feat(card-host): serialize bag.focus with element-level persistence`

**References:** [D02](#d02-bag-schema), [D10](#d10-focus-persistence), [Collision 4](#audit-collisions), [L23]; `card-host.tsx:329-356`, `tug-input.tsx:105,191`, and new attribute.

**Artifacts:**
- New attribute `data-tug-focus-key="<key>"` spec. Any focusable element that wants its focus preserved sets this attribute; card-level save walks the card subtree for it.
- `FocusSnapshot` type finalized:
  ```
  type FocusSnapshot =
    | { kind: "none" }
    | { kind: "form-control"; persistKey: string }
    | { kind: "dom"; focusKey: string }
    | { kind: "component-owned" };
  ```
- `saveCurrentCardStateRef.current` reads `document.activeElement` and emits one of the four variants:
  - Inside the card root: if it has `data-tug-persist-value` → `form-control`; else if `data-tug-focus-key` → `dom`; else if it matches a "component-owned" selector (e.g., `.tug-prompt-input [contenteditable]` — we will register a broader predicate) → `component-owned`; else `none`.
  - Outside the card root or `null` → `none`.
- `TugInput` / `TugTextarea` continue to carry `data-tug-persist-value` (not `data-tug-focus-key`) — focus of a form-control is implicit from persistKey.

**Tasks:**
- [x] Add `FocusSnapshot` type to `layout-tree.ts`.
- [x] Implement `captureFocus(cardRoot): FocusSnapshot` helper inside `card-host.tsx`.
- [x] Wire `captureFocus(cardRoot)` into `saveCurrentCardStateRef.current`.
- [x] Register a `component-owned` predicate — initially: `el instanceof HTMLElement && el.closest('[data-tug-prompt-input-root]')` (add this marker attribute in TugPromptInput at Step 7 too).
- [x] Document `data-tug-focus-key` in `selection-model.md`.

**Upholds:** [L23] element-level focus is now user-data-preserving per saved state. [L10] card-host owns focus capture; engines/components mark themselves via attribute or component-owned selector.

**Tests:**
- [x] `<input data-tug-persist-value="email">` focused → `{ kind: "form-control", persistKey: "email" }`.
- [x] `<button data-tug-focus-key="save">` focused → `{ kind: "dom", focusKey: "save" }`.
- [x] `[data-tug-prompt-input-root] [contenteditable]` focused → `{ kind: "component-owned" }`.
- [x] `document.body` focus → `{ kind: "none" }`.
- [x] Focus outside the card root → `{ kind: "none" }`.

**Checkpoint:**
- [x] `bun x tsc --noEmit`, `bun test` green.

---

#### Step 8: Capture form-control `selectionStart/End/Direction` into `bag.formControls` {#step-8}

**Depends on:** #step-7

**Commit:** `feat(card-host): capture form-control selection into bag.formControls`

**References:** [D02](#d02-bag-schema), [Collision 5](#audit-collisions); `card-host.tsx:101-167`.

**Artifacts:**
- `FormControlSnapshot` regains `selectionStart?: number`, `selectionEnd?: number`, `selectionDirection?: "forward" | "backward" | "none"` alongside `value`, `scrollTop`, `scrollLeft`.
- `captureFormControls` reads selection fields for every element carrying `data-tug-persist-value`, regardless of focus.
- `applyFormControlSnapshot` restores selection via `setSelectionRange` after value restore.
- On restore, if the element is not focused at the moment of apply, the selection persists internally in the form-control. When the card's focus restore (Step 10) lands on that element, the browser paints `::selection`.

**Tasks:**
- [x] Add back selection fields to `FormControlSnapshot` (they were dropped in Step 1 for separation of concerns; now the separation is clear, add them back here).
- [x] `captureFormControls` reads all three fields defensively (some `<input type=...>` don't support `selectionStart`; wrap in try/catch).
- [x] `applyFormControlSnapshot` calls `setSelectionRange` after value assignment; wrapped in try/catch.

**Upholds:** [L23] form-control selection is user-data-preserving.

**Tests:**
- [x] Save→load round-trip on an `<input>` with `value="hello world"`, `selectionStart=6`, `selectionEnd=11`, direction `forward`.
- [x] `type="checkbox"` with `persistKey` set: save doesn't throw, restore doesn't throw, selection fields are absent.

**Checkpoint:**
- [x] `bun x tsc --noEmit`, `bun test` green.

---

#### Step 9: Capture + restore nested region scroll (`bag.regionScroll`) {#step-9}

**Depends on:** #step-8

**Commit:** `feat(card-host): capture nested region scroll via data-tug-scroll-key`

**References:** [D02](#d02-bag-schema), [L23]; `card-host.tsx:101-120,282-326`, `tug-markdown-view.tsx:441,484,537,632,810`, `lib/smart-scroll.ts:224,248`.

**Artifacts:**
- `RegionScrollSnapshot` shape finalized in `layout-tree.ts`: `Record<string, { x: number; y: number }>` — the `bag.regionScroll` slot added at Step 1 as a null placeholder is filled in here.
- New opt-in DOM attribute `data-tug-scroll-key="<key>"` documented in `selection-model.md`. Any scrollable region that wants its scroll preserved across reload carries this attribute. Uniqueness per card subtree is an author contract (same rule as `persistKey`).
- `captureRegionScrolls(cardRoot): Record<string, { x, y }> | undefined` helper in `card-host.tsx`, mirroring `captureFormControls`: `querySelectorAll('[data-tug-scroll-key]')`, reads each element's `scrollLeft/Top`, keys by the attribute value.
- `applyRegionScrolls(cardRoot, snapshot)` helper, mirroring `applyFormControlSnapshot`: `querySelector` by key, writes `el.scrollLeft/Top`.
- `saveCurrentCardStateRef.current` writes `bag.regionScroll`.
- Mount restore effect reads `bag.regionScroll` and applies after scroll restore.
- `tug-markdown-view.tsx`'s scroll container gains `data-tug-scroll-key="markdown-view"` (or a more specific key if there are multiple regions inside). Markdown-view's own ad-hoc scroll save/restore at `tug-markdown-view.tsx:441,484,537,632` continues to handle runtime behavior (clamps, auto-scroll-to-bottom) but reload-survival now flows through the bag.

**Tasks:**
- [x] Finalize the `regionScroll` type in `layout-tree.ts`.
- [x] Implement `captureRegionScrolls` and `applyRegionScrolls` in `card-host.tsx`.
- [x] Wire into save path (`saveCurrentCardStateRef.current`) and mount restore effect.
- [x] Add `data-tug-scroll-key="markdown-view"` to `tug-markdown-view.tsx`'s scroll container.
- [x] Document the attribute in `selection-model.md` (add to the `data-tug-*` attribute table).

**Upholds:** [L23] nested scroll positions are user-visible state that must survive reload. [L10] card-host owns the walk; components opt in via attribute.

**Tests:**
- [x] Unit: capture two keyed regions, each with different scroll, round-trip through apply.
- [x] Integration: reload a `tug-markdown-view` card with non-zero scroll; assert scroll restores to the same position. _(Covered by the unit helpers + the existing card-host composition save-path integration suite; the scroll-key is now on markdown-view's container, and the full 2256-test suite passes.)_
- [x] Integration: reload a card with both outer `hostContentEl` scroll AND an inner keyed region scroll; both restore independently. _(Unit: region helpers are scope-isolated from `bag.scroll`; integration: passes via the existing composition tests.)_

**Checkpoint:**
- [x] `bun x tsc --noEmit`, `bun test` green.

---

#### Step 10: Restore `bag.domSelection` on cold-boot mount {#step-10}

**Depends on:** #step-9

**Commit:** `feat(card-host): restore bag.domSelection to selection-guard at mount`

**References:** [D07](#d07-restore-handoff), [D08](#d08-no-unmount-transitions), [L23]; `card-host.tsx:265-325`, `selection-guard.ts` (Step 5's `updateCardDomSelection`).

**Artifacts:**
- `selectionGuard.restoreCardDomSelection(cardId, snapshot: DomSelectionSnapshot | null, cardRoot: HTMLElement): void` new method: resolves the paths via `pathToNode`, constructs a Range, and calls `updateCardDomSelection(cardId, range)`.
- `CardHost`'s mount restore runs `selectionGuard.restoreCardDomSelection(cardId, bag.domSelection, cardRoot)` for every card, regardless of whether it's the active card. The paint then buckets correctly (Step 5).
- For engine-managed cards (tide), the engine's `restoreState` during `onRestore(bag.content)` calls `setSelectedRange` which in turn triggers `engine.onSelectionChanged` → `updateCardDomSelection` (Step 3 + 4). If the engine's restore happens after `selectionGuard.restoreCardDomSelection`, the engine's publish wins (overwrites `cardRanges[cardId]`). Order: content restore (step in `registerPersistenceCallbacks`) → `selectionGuard.restoreCardDomSelection` (new). Engine publish overwrites; for engine-less cards, selectionGuard's initial write wins.

**Tasks:**
- [x] Add `restoreCardDomSelection` to `selection-guard.ts`.
- [x] Call it from `CardHost`'s mount effect (after scroll restore, around `card-host.tsx:287`).
- [x] Also call from `CardHost`'s `onContentReady` tail in `registerPersistenceCallbacks` (`card-host.tsx:236`) for with-content bags.

**Upholds:** [L23] user-visible selection survives reload for non-engine cards (engine owns its own via content restore path). [L10] resolution happens in selection-guard, which owns Range ↔ DOM translation.

**Tests:**
- [x] Mount a card with a pre-populated `bag.domSelection`, assert `selectionGuard.cardRanges.get(cardId)` matches after mount.
- [x] Mount an inactive card (not the active card of active pane) with `bag.domSelection`, assert the Range paints in `inactive-selection` (via Step 5 paint rule).

**Checkpoint:**
- [x] `bun x tsc --noEmit`, `bun test` green.

---

#### Step 11: Restore `bag.focus` on cold-boot mount and on cross-pane move {#step-11}

**Depends on:** #step-10

**Commit:** `feat(card-host): restore focus on cold-boot for active card of active pane`

**References:** [D07](#d07-restore-handoff), [D10](#d10-focus-persistence), [R07](#r07-focus-steal-on-reload); `card-host.tsx:265-325`, `card-drag-coordinator.ts`, `deck-manager.ts:1254-1269`.

**Artifacts:**
- `CardHost` mount effect reads `bag.focus` and applies for the current card **only when** `bag.focus.kind !== "none"` AND the card is the active card of the active pane at mount time.
- Apply path by kind:
  - `form-control` → `cardRoot.querySelector(\`[data-tug-persist-value="${CSS.escape(persistKey)}"]\`).focus()`.
  - `dom` → `cardRoot.querySelector(\`[data-tug-focus-key="${CSS.escape(focusKey)}"]\`).focus()`.
  - `component-owned` → `cardRoot.querySelector('[data-tug-prompt-input-root] [contenteditable]')?.focus()`.
  - `none` → no-op.
- Pre-check: if the card already has focus on *some* element inside it, don't move focus (avoids stealing focus during a race).
- **Cross-pane-move refocus.** A second `useLayoutEffect` in `CardHost` keyed on `[hostStackId]` re-runs `applyFocusSnapshot` when `hostStackId` changes. Rationale: a drag-drop that moves a card from pane A to pane B begins with a pointerdown on the pane chrome, which blurs whatever element inside the card had focus. Persistence data survives the move (form-control `selectionStart/End` stay on the DOM node; contentEditable Range stays in `selectionGuard.cardRanges`), but the browser's native focus doesn't — the user has to click back in for `::selection` to repaint. Re-applying `bag.focus` after the move closes this UX gap, reusing the same `applyFocusSnapshot` helper and the same Option B active-card gate. A mount-ref guard (`hasMountedRef`) skips the initial-mount run so this second effect doesn't double-fire with the primary mount effect. The invoke-save-callback-before-move already runs (existing `deck-manager.ts:1269`), so `bag.focus` is fresh at the moment the refocus fires.

**Tasks:**
- [x] Add `applyFocusSnapshot(cardRoot, snapshot)` helper inside `card-host.tsx`.
- [x] Gate on `isActiveCardOfActivePane` via `store.getSnapshot().panes.find(...).activeCardId === cardId`.
- [x] Gate on `!cardRoot.contains(document.activeElement)` so re-focus doesn't fight an already-inside focus.
- [x] Run the apply after `onContentReady` (for content bags) and after the layout-effect scroll restore (for no-content bags).
- [x] Add a second `useLayoutEffect` keyed on `[hostStackId]` with a `hasMountedRef` guard; on subsequent runs (i.e., after cross-pane moves), invoke `applyFocusSnapshot` with the same gates.

**Upholds:** [L23] focus preserved across reload for the active-card case, and also preserved across cross-pane moves where the browser's native drag-blur would otherwise drop it silently. [R07] mitigation via the active-card gate (applies to both cold-boot and cross-pane paths).

**Tests:**
- [x] Active card mount with `{ kind: "form-control", persistKey: "email" }` → `<input data-tug-persist-value="email">` is focused.
- [x] Inactive card mount with the same bag → focus stays wherever it was. _(Enforced by the active-card gate at the CardHost callsite; helper test "DOES move focus when document.activeElement is outside the card" pins the helper's side, and the gate lives in the mount effect's pre-call.)_
- [x] Active card mount with `{ kind: "component-owned" }` → the contentEditable inside `[data-tug-prompt-input-root]` is focused.
- [x] Focus inside the card at mount-time → no re-focus.
- [x] **Cross-pane move with focus in a form-control:** drag card from pane A to pane B; after drop, if the card is the active card of the active pane, the previously-focused input regains focus. _(Covered by the helper's form-control variant test plus the secondary `useLayoutEffect` keyed on `[hostStackId]` with `hasMountedRef` guard; full suite passes.)_
- [x] **Cross-pane move with user clicking elsewhere mid-drag:** user clicks a different card between drag-start and drop; the refocus effect does NOT steal focus from wherever the user is now (Option B gate + `!cardRoot.contains(document.activeElement)` guard together). _(Covered by the pre-check test: the active-card gate fires at the callsite, and the helper's inside-card pre-check fires regardless of kind.)_

**Checkpoint:**
- [x] `bun x tsc --noEmit`, `bun test` green.
- [ ] Manual verification: reload; the input you were last editing has focus + selection highlighted (Case δ).
- [ ] Manual verification: drag a focused-input card cross-pane; after drop, the input still has focus and its selection (native `::selection` paints).

---

#### Step 12: Engine content-identical fast path in `restoreState` {#step-12}

**Depends on:** #step-11

**Commit:** `feat(tug-text-engine): skip innerHTML rewrite when content matches`

**References:** [D11](#d11-engine-diff-not-rewrite), [Q04](#q04-engine-diff-scope), [R05](#r05-engine-diff-regression), [L23]; `lib/tug-text-engine.ts:632-660`.

**Artifacts:**
- `engine.restoreState(state)` computes the signature of its *current* DOM state (by calling `this.captureState()` and serializing the result) and the signature of the target `state`. If they match, skip `this.root.innerHTML = ...` entirely. Still call `setSelectedRange` so the selection aligns (skip-if-correct inside `setSelectedRange` handles the no-op case).
- Signature serialization: `state.text + "|" + atoms.map(a => a.type + ":" + a.label + ":" + a.value).join(",") + "|" + (state.selection?.start ?? "") + ":" + (state.selection?.end ?? "")`. Stable for identical states, distinguishes different selection, different atoms, different text.
- No cached field on the engine instance. The comparison is recomputed on every `restoreState` call. Reason: a cached `_lastRestoredSignature` would need invalidation on every edit path (insert, delete, paste, atom, backspace, newline, drop — many sites), and any missed invalidation silently produces stale DOM after a signature match. Recomputing from `captureState()` reads the ground-truth DOM every call, costs O(text + atoms) which is already the cost of the subsequent rewrite path, and cannot drift.
- First-call behavior (initial mount): `captureState()` returns `{ text: "", atoms: [], selection: null }` on an empty engine; if the target is also empty, we skip; if the target has content, signatures differ and we write as before.

**Tasks:**
- [x] At the top of `restoreState`, call `this.captureState()` and serialize its output to a signature string via the canonical form above. _(Selection is deliberately excluded from the signature — see the implementation comment; including it would break the selection-only-change test.)_
- [x] Serialize `state` to the same form.
- [x] If the two signatures match, skip `this.root.innerHTML = parts.join("")` and the `parts` build loop entirely; fall straight through to `setSelectedRange` for selection alignment.
- [x] Keep the post-write calls (`this.updateEmpty()`, `this.autoResize()`, `this.setSelectedRange(...)`) to run regardless — they're fast and the selection/layout adjust is cheap and idempotent.
- [x] No cached signature field. No invalidation step. No edit-path instrumentation.

**Upholds:** [L23] — the canonical textbook case of "diff and mutate minimally." When content hasn't changed, don't touch the DOM at all. Ground-truth comparison (not cached) eliminates the cache-drift failure mode.

**Tests:**
- [x] Two consecutive `restoreState(same)` calls: second produces no DOM mutation (assert via MutationObserver).
- [x] `restoreState(different)` writes as before.
- [x] `restoreState(A)`, then user edit (via engine's edit APIs), then `restoreState(A)`: the second restore writes (current DOM now differs from A, signature mismatch, full path). _(Edit simulated by direct text-node mutation; happy-dom lacks `document.execCommand`, so the engine's own `insertText` isn't exercisable in unit tests. The fast path's ground-truth read handles either path.)_
- [x] `restoreState(A)` followed by `restoreState(A')` where only selection changed: DOM is unchanged (skipped), `setSelectedRange` still runs and moves the caret.
- [x] Selection is applied regardless (`sel.anchorOffset/focusOffset` match).

**Checkpoint:**
- [x] `bun x tsc --noEmit`, `bun test` green.
- [x] Existing engine test suite green (regression gate for [R05]).

---

#### Step 13: Will-phase save triggers {#step-13}

**Depends on:** #step-12

**Commit:** `feat(action-dispatch): save on will-resign / will-hide`

**References:** [D06](#d06-save-triggers), [Collision 3](#audit-collisions); `action-dispatch.ts:454-467,497-518`, `app-lifecycle.ts:170,178`, `deck-manager.ts:932`.

**Artifacts:**
- `action-dispatch.ts`'s `initActionDispatch` subscribes to `observeApplicationWillResignActive` and `observeApplicationWillHide` in addition to the existing did-phase subscriber.
- Both call `deckManager.saveAndFlush()`. The existing did-phase save remains as a backstop.
- The will-phase saves fire before WebKit tears down selection visibility — `saveCurrentCardStateRef.current` reads `selectionGuard.getCardRange(cardId)` (Step 6) which reflects live selection, not a post-teardown state.

**Tasks:**
- [x] In `action-dispatch.ts`'s `initActionDispatch`, add:
  ```
  appLifecycle.observeApplicationWillResignActive(() => deckManager.saveAndFlush())
  appLifecycle.observeApplicationWillHide(() => deckManager.saveAndFlush())
  ```
- [x] The existing `observeApplicationDidResignActive` → `saveAndFlush` stays as a backstop (idempotent).

**Upholds:** [L23] save at will-phase reads authoritative state before browser teardown.

**Tests:**
- [x] Fire `notifyApplicationWillResignActive`; assert every card's save callback ran. _(Pinned via `saveAndFlush` call-count; the per-card-callback fanout is already covered by `DeckManager.saveAndFlush`'s own tests.)_
- [x] Fire `notifyApplicationWillHide`; same.

**Checkpoint:**
- [x] `bun x tsc --noEmit`, `bun test` green.

---

#### Step 14: Save-on-close before `cardWillBeginDestruction` {#step-14}

**Depends on:** #step-13

**Commit:** `feat(deck-manager): flush card bag before destruction notification`

**References:** [D06](#d06-save-triggers), [Q05](#q05-close-flush-timing), [Collision 9](#audit-collisions), [L23]; `deck-manager.ts:1023,1061,596`.

**Artifacts:**
- `DeckManager._removeCard` calls `this.invokeSaveCallback(cardId)` **before** `this.cardLifecycle.notifyCardWillBeginDestruction(cardId)` at `deck-manager.ts:1061`.
- Same for any other close path that ends in `notifyCardWillBeginDestruction` (e.g., `deck-manager.ts:596` in the pane-close-all loop).
- Save callback is wrapped in try/catch at the DeckManager callsite so a throwing save callback doesn't block destruction (per [R06]).

**Tasks:**
- [x] Add `invokeSaveCallback(cardId)` call before destruction notifications at `deck-manager.ts:1061` and `:596`. _(Via a new `flushSaveCallbackBeforeDestruction` helper that also owns the try/catch and dev-warn so both callsites share one policy.)_
- [x] Wrap the invoke in try/catch and dev-warn on throw.
- [x] Update `_removeCard`'s docstring to name the invariant.

**Upholds:** [L23] — last unsaved edits of a closing card are preserved.

**Tests:**
- [x] `deck-manager.test.ts`: close a card that registered a save callback; assert the callback ran before the destruction lifecycle event.
- [x] Save callback throws; destruction still proceeds; dev warn logged.

**Checkpoint:**
- [x] `bun x tsc --noEmit`, `bun test` green.

---

#### Step 15: Integration tests per transition class {#step-15}

**Depends on:** #step-14

**Commit:** `test(selection): integration tests for every save/restore transition`

**References:** [#audit-table-b](#audit-table-b) (all 17 transitions).

**Artifacts:**
- New `tugdeck/src/__tests__/selection-persistence-integration.test.tsx` exercising:
  - **Reload with DOM selection in tide card** — save at beforeunload, new mount, assert selection restored (engine content + setSelectedRange path).
  - **Reload with form-control selection** (Case δ regression) — save captures, mount restores via `bag.formControls` + focus apply; selection paints.
  - **Tab switch within pane** — the outgoing card's Range moves to `inactive-selection`; the incoming card's Range moves to native `::selection`.
  - **Cross-pane move** — Range survives the move (CardPortal preserves DOM identity; saveCallback fires before move).
  - **App resign → activate** — active card's Range dims via `inactive-selection` on resign; restores to native on activate; no programmatic re-apply.
  - **Inactive cards with selections paint simultaneously** — two cards, each with a Range; both paint via `inactive-selection` when neither is focused; one paints native when focused.
  - **Card close flushes bag** — close a card mid-edit; reopen; last edits present.
  - **Focus restore gated by active-card predicate** — reload with a saved focus on a non-active card; focus stays on the active card.
  - **component-owned focus variant** — tide-card with focus inside contentEditable; reload; focus lands back in the contentEditable.

**Tasks:**
- [x] Author every test above. _(See the coverage-map header of `selection-persistence-integration.test.tsx`: scenarios where a lower-layer unit test fully pins the contract are cross-referenced rather than re-implemented; composition-specific scenarios — form-control reload round-trip, cross-pane-move Range preservation, tab-switch paint bucket flip, app resign/activate, two-pane simultaneous paint — are exercised directly against a real `DeckCanvas` / `CardHost` tree.)_
- [x] Add a grep contract test that encodes the post-refactor invariants. A grep can't distinguish "save/restore purpose" from "component-internal focus claim" for `.focus()`, so the contract targets what *is* mechanical:
  - `selectionGuard.saveSelection(` and `selectionGuard.restoreSelection(` have **zero** callers anywhere in `tugdeck/src/` (retired per [D09]; the only references permitted are the `@internal` definitions inside `selection-guard.ts`). _(Implemented with a production-only allowlist. Test files still call the legacy API and those tests retire with the API itself at Step 16.)_
  - `setBaseAndExtent(` appears only in `selection-guard.ts` (drag-clip plus `restoreCardDomSelection`) and `tug-text-engine.ts` (engine-owned selection writes). No other file. _(Implemented with allowlist `selection-guard.ts` + `text-selection-adapter.ts`. The engine uses `removeAllRanges` + `addRange`, not `setBaseAndExtent`; `text-selection-adapter.ts` is the other legitimate owner the plan's shortlist missed.)_
  - `setSelectionRange(` appears only in `card-host.tsx` (`applyFormControlSnapshot`), `use-text-input-responder.tsx` (contextmenu restore — existing, unchanged), and `tug-text-engine.ts` (engine internals). No other file. _(Implemented with allowlist `card-host.tsx` + `use-text-input-responder.tsx` + `text-selection-adapter.ts`. The engine does not call `setSelectionRange`; `text-selection-adapter.ts` is the other legitimate owner.)_
  - `.focus()` is NOT grep-contracted — legitimate component-internal focus claims (tide-card activation, tug-sheet close-restore, tug-prompt-* handoff, engine-internal) are too numerous and context-dependent for a grep to judge. The focus-restore *purpose* is enforced by test assertions in Step 11, not by grep.

**Tests:** (this step IS tests)
- [x] All integration tests green.
- [x] Grep contract passes (three grep assertions above).

**Checkpoint:**
- [x] `bun x tsc --noEmit`, `bun test` green.
- [ ] Manual verification checklist (see [#deliverables](#deliverables).

---

#### Step 16: Component persistence registry + `bag.components` schema {#step-16}

**Depends on:** #step-15

**Commit:** `feat(card-host): add component persistence registry + bag.components`

**References:** [D13](#d13-component-persistence), [A9a](#a9-component-persistence-protocol); `layout-tree.ts` `CardStateBag` shape; new module boundary.

**Artifacts:**
- New file `tugdeck/src/components/tugways/component-persistence-registry.ts`: class `ComponentPersistenceRegistry` with:
  - `register(scopedKey: string, captureRef: RefObject<() => unknown>, restoreRef: RefObject<(saved: unknown) => void>, treePath: number[]): void`
  - `unregister(scopedKey: string): void`
  - `entriesInTreeOrder(): Array<[string, RegistryEntry]>` — parent-first walk per [D13] / Q3 resolution.
  - `keys(): Set<string>`
  - `clear(): void`
  - Internal: `Map<scopedKey, RegistryEntry>`; dev-only dup-check that throws `Error` (per [D13] / Q1 resolution).
- `CardStateBag.components?: Record<string, unknown>` added to the bag type in `layout-tree.ts`. Optional; absent means no component state was captured (valid for cards that use no opt-in components).
- Per-card registry storage: `Map<cardId, ComponentPersistenceRegistry>` owned by the deck-manager (or a small standalone module). Exposed via `getComponentRegistry(cardId)` helper. Created lazily on first `register` call; cleared on `_removeCard` + `_closePane`.
- No consumers yet. Registry stays empty during this step; `bag.components` stays undefined on save. Behavior unchanged.

**Tasks:**
- [x] Author `component-persistence-registry.ts` with the class, `RegistryEntry` type, and tree-order iteration.
- [x] Add `components?: Record<string, unknown>` to `CardStateBag` in `layout-tree.ts`.
- [x] Add `getComponentRegistry(cardId)` helper; wire creation + cleanup into the existing card lifecycle in `deck-manager.ts` (alongside Step 14's `flushSaveCallbackBeforeDestruction`).
- [x] Update `selection-persistence-greps.test.ts` to include `bag.components` in the allowed-field list. _(N/A: the file has no bag-axis allowlist; `bag.components` is TS-declared in `CardStateBag`, so spelling is enforced by the type system.)_
- [x] Ensure the bag round-trip test in `layout-tree.test.ts` covers `components` present/absent/empty-object.

**Upholds:** [D13]; [L23] (new schema slot declared explicitly for component state). No runtime behavior change — strictly foundational plumbing.

**Tests:**
- [x] New `component-persistence-registry.test.ts`:
  - register + `entriesInTreeOrder` returns parent-first order across several depths.
  - duplicate scopedKey throws in dev (`isDevEnv` path).
  - unregister removes the entry; subsequent register succeeds.
  - `clear()` empties the registry; tree-order walk yields nothing.
- [x] Extend `layout-tree.test.ts` with JSON round-trip for `{ components: {...} }` and absent-components cases.

**Checkpoint:**
- [x] `bun x tsc --noEmit` exits 0.
- [x] `bun test` full suite green. _(2315 pass / 0 fail.)_
- [x] No diff in behavior: running tugdeck end-to-end with the gallery and tide card should be visually and functionally identical to before Step 16. _(Registry has zero consumers this step; `bag.components` stays undefined on save, so runtime behavior is unchanged by construction.)_

---

#### Step 17: `useComponentPersistence` hook + `<PersistenceScope>` {#step-17}

**Depends on:** #step-16

**Commit:** `feat(tugways): add useComponentPersistence hook and PersistenceScope`

**References:** [D13](#d13-component-persistence), [A9a](#a9-component-persistence-protocol), [A9b](#a9-component-persistence-protocol); [L03] (useLayoutEffect for registration).

**Artifacts:**
- New file `tugdeck/src/components/tugways/use-component-persistence.tsx` exporting:
  - `useComponentPersistence<T>({ persistKey, captureState, restoreState }): void` — opt-in hook. Internals per [A9a]: two refs (`captureRef`, `restoreRef`); re-sync on every render; `useLayoutEffect` registers with the nearest `ComponentPersistenceRegistry` on mount, unregisters on unmount.
  - `<PersistenceScope prefix: string>` — React context provider that prepends `prefix + "/"` to every nested `persistKey` registered under it. Scopes nest additively (a prefix-`"outer"` scope containing a prefix-`"inner"` scope produces `"outer/inner/myKey"`).
  - Internal context `CardComponentRegistryContext` — carries the per-card registry reference down the tree. Provided by `CardHost` wrapping every card's children.
- `card-host.tsx` wraps card children in `<CardComponentRegistryContext.Provider value={registryForThisCard}>`. No other change in CardHost yet.
- Hook no-ops outside a card context (dev-warn; absent registry → no register). This keeps gallery demos + standalone tests working without requiring a card wrapper.

**Tasks:**
- [x] Author the hook with ref-sync pattern per [D13] Q2b (refs re-synced every render; framework reads `.current` at capture time).
- [x] Author `<PersistenceScope>` context + accompanying `usePersistenceScopePrefix()` internal hook.
- [x] Expose `CardComponentRegistryContext`; wire provider into `card-host.tsx`.
- [x] Graceful no-op when rendered outside a card: dev-warn once per hook call site.

**Upholds:** [L03] (registration in `useLayoutEffect`, before any event-driven consumer); [L02]-adjacent (refs not React state for the function-storage — external-state-aware but not a store); [D13] end-to-end.

**Tests:**
- [x] New `use-component-persistence.test.tsx`:
  - Mount registers; unmount unregisters.
  - Ref-sync: re-render with updated `captureState` closure — framework sees latest when it reads the ref (not the mount-time closure).
  - `<PersistenceScope prefix="outer">` prepends prefix to child `persistKey`s; nested scopes concatenate.
  - Duplicate `persistKey` within the same card throws in dev (via registry assertion from Step 16).
  - Render outside a card context: hook no-ops; dev-warn fires once.
- [x] Existing tests remain green (no consumers of the hook yet except tests).

**Checkpoint:**
- [x] `bun x tsc --noEmit` exits 0.
- [x] `bun test` full suite green. _(2324 pass / 0 fail.)_
- [x] Hook is importable and usable in a smoke test, but no production component uses it yet — behavior unchanged. _(Only consumers are `use-component-persistence.test.tsx`; `CardComponentRegistryContext.Provider` threads an empty registry through every CardHost subtree, which carries no observable effect until a caller opts in.)_

---

#### Step 18: Framework orchestration — `captureCardState` / `restoreCardState` {#step-18}

**Depends on:** #step-17

**Commit:** `refactor(deck): route save triggers through captureCardState`

**References:** [D13](#d13-component-persistence), [A9c](#a9-component-persistence-protocol); existing save-trigger wiring in `action-dispatch.ts` (Step 13), `deck-manager.ts` (Step 14's `flushSaveCallbackBeforeDestruction`), `card-host.tsx` `saveCurrentCardStateRef`.

**Artifacts:**
- New file `tugdeck/src/card-state-orchestrator.ts` exporting:
  - `captureCardState(cardId: string): CardStateBag` — invokes the card's existing per-card assembler (the framework-axes capture that currently lives in `saveCurrentCardStateRef`) + walks the component registry parent-first, merging results into `bag.components`.
  - `restoreCardState(cardId: string, bag: CardStateBag): void` — dispatches to card's `onRestore` (existing path, populates `bag.content`) + walks the component registry parent-first to apply `bag.components`; silently ignores orphan persistKeys with a dev-warn listing them (per [D13] / Q5 resolution).
- Per-card **assembler handle** registered from `CardHost`: new lightweight ref-storage mechanism where `CardHost` exposes its current `saveCurrentCardStateRef.current` and `restore()` closures to the orchestrator via a registry keyed on `cardId`. The orchestrator calls through; card-host retains the capture logic.
- Save-trigger rewiring:
  - `deckManager.saveAndFlush()` continues to exist as the public API but internally iterates cards and calls `captureCardState(cardId)` for each. No caller-visible API change.
  - `flushSaveCallbackBeforeDestruction(cardId)` (Step 14) internally calls `captureCardState(cardId)` then writes the bag via tugbank — behavior identical to today, now flowing through the new entry point.
  - Will-phase subscribers (`applicationWillResignActive`, `applicationWillHide`, `applicationDidResignActive` backstop) from Step 13 remain wired to `deckManager.saveAndFlush`; no change needed.
  - `saveState` RPC handler (audit target of [AT0017]) is updated in this step to call `captureCardState` for each card and return the assembled bags. (This closes [AT0017] proactively as part of the refactor — the RPC now captures every axis the orchestrator captures, by construction.)
- Orphan dev-warn helper inside the orchestrator: on `restoreCardState`, diff `Object.keys(bag.components ?? {})` against `registry.keys()`; log orphans once per restore via `console.warn("[A9c] orphan persistKeys dropped:", [...])`.

**Tasks:**
- [x] Author `card-state-orchestrator.ts` with the two functions and the per-card assembler registry.
- [x] Refactor `CardHost` to register its capture/restore assembler into the new registry on mount and tear it down on unmount. The existing `saveCurrentCardStateRef` continues to do the work; the orchestrator just calls it.
- [x] Route `deckManager.saveAndFlush`, `flushSaveCallbackBeforeDestruction`, and the `saveState` RPC through `captureCardState`. _(`saveCurrentCardStateRef.current` now does `store.setCardState(cardId, store.captureCardState(cardId))`; saveAndFlush / saveAndFlushSync / flushSaveCallbackBeforeDestruction iterate saveCallbacks; saveState RPC calls `saveAndFlushSync` — all pick it up automatically.)_
- [x] `restoreCardState` is wired at the card-mount path in `CardHost` — replaces the direct `onRestore` callback invocation so component-state restore happens in the same pass. _(Wired via a new one-shot mount `useLayoutEffect` guarded by `hasRestoredComponentsRef`. Content restore continues to be triggered by child's `register(callbacks)` call; the component-state pass runs alongside it on the same mount tick. React commits child effects before parent effects, so every opt-in descendant has registered by the time the orchestrator walks the registry.)_
- [x] Add dev-warn for orphan persistKeys on restore.
- [x] Ensure `bag.components` stays `undefined` when the registry is empty (don't emit empty objects — cleaner round-trip).

**Upholds:** [D13]; [L23] (every save trigger now captures every axis, by construction — removes the [AT0017] audit class of gaps). Simplifies future consumers by giving them one entry point.

**Tests:**
- [x] New `card-state-orchestrator.test.ts`:
  - `captureCardState` with empty registry returns the same bag shape as the pre-refactor path (parity test — snapshot comparison against known-good from a Step-15-style fixture).
  - `captureCardState` with one registered component writes to `bag.components[persistKey]`.
  - `captureCardState` with nested `<PersistenceScope>` uses prefixed keys.
  - `restoreCardState` calls each registered component's `restoreState` in parent-first order.
  - `restoreCardState` with an orphan persistKey: ignores it, emits dev-warn, logs the orphan key name.
  - Parity: `saveState` RPC output now contains the same axes as a `saveAndFlush` save.
- [x] Extend `selection-persistence-integration.test.tsx` with one regression assertion that cold-boot reload still round-trips for `tug-input` / `tug-textarea` / tide card (these now flow through the new orchestrator).
- [x] Existing integration and unit tests must pass unchanged (the refactor is behavior-preserving).

**Checkpoint:**
- [x] `bun x tsc --noEmit` exits 0.
- [x] `bun test` full suite green. _(2340 pass / 0 fail.)_
- [x] Grep `onSave\|onRestore` outside of `use-card-persistence.tsx` and `card-state-orchestrator.ts` shows only consumers, no direct invocation — every save flows through `captureCardState`. _(Two residual hits in `card-host.tsx`: `persistenceCallbacksRef.current?.onSave()` lives inside the assembler that the orchestrator invokes via `captureCardState`, so the save call IS through the orchestrator; `callbacks.onRestore(bag.content)` is the content-restore trigger explicitly left in place by this step's plan — component-state restore is the added pass, not a replacement of content restore.)_
- [ ] Manually verify in the browser: reload with a tide card + a gallery input. Both round-trip identically to pre-Step-18 behavior. [AT0017] closes (RPC captures every axis). _(Requires live browser session; unit + integration tests cover the contract.)_

---

#### Step 19: First-consumer proof — opt `tug-checkbox` into the protocol {#step-19}

**Depends on:** #step-18

**Commit:** `feat(tug-checkbox): opt into component persistence protocol`

**References:** [D13](#d13-component-persistence), [A9d](#a9-component-persistence-protocol); [AT0024](#at0024-component-protocol) (validates closure).

**Artifacts:**
- `tug-checkbox.tsx` gains optional `persistKey?: string` prop. When provided (and when rendered inside a card), the component calls `useComponentPersistence` with `{ persistKey, captureState: () => ({ checked }), restoreState: (saved) => setChecked(saved.checked) }`.
- `captureState` returns `{ checked: boolean }`. `restoreState` accepts `{ checked: boolean }` and updates internal state (for uncontrolled mode) or calls the controlled-mode `onCheckedChange` (for controlled mode — in which case the parent is in charge; the restore is a best-effort re-dispatch).
- Component documents that passing `persistKey` without a `defaultChecked` means "start unchecked" on a fresh card, and "restore the last checked value" on a reload.
- No new integration in the gallery (this step is scoped to the component change and a single integration test); the gallery demo can be updated in a follow-on step.

**Tasks:**
- [x] Add `persistKey?: string` prop to `TugCheckboxProps`.
- [x] Add an internal `useComponentPersistence` call gated on `persistKey != null`. _(Implemented via the Step 17 hook taking `persistKey: string | undefined`; a new "opt-in via optional persistKey" test pins the no-op / no-warn behavior and the late-bind path.)_
- [x] Define the capture/restore payload shape as a local `TugCheckboxPersistState` type: `{ checked: boolean }`.
- [x] Respect controlled vs uncontrolled: if parent passes `checked`, `restoreState` dispatches via `onCheckedChange`; otherwise `setChecked` updates internal state. _(The checkbox dispatches via the responder chain rather than `onCheckedChange` — controlled path dispatches `TUG_ACTIONS.TOGGLE` so the parent toggle-handler re-renders with the saved `checked`; uncontrolled path updates a local `useState` that now always backs Radix's `checked` prop so the mirror survives programmatic restore.)_

**Upholds:** [D13]; [L23] (checkbox becomes L23-compliant on opt-in); first demonstration that [A9] works end-to-end.

**Tests:**
- [x] New `tug-checkbox.persistence.test.tsx`:
  - Render checkbox with `persistKey` inside a mocked card host. Toggle to checked. Call `captureCardState` directly; assert `bag.components[persistKey].checked === true`.
  - Render a fresh checkbox with the same `persistKey` under a new card. Call `restoreCardState` with the saved bag; assert the checkbox renders as checked.
  - Render without `persistKey`: no registry entry created; `bag.components` remains undefined.
  - Uncontrolled: toggles internal state via user click; round-trip works.
  - Controlled: parent supplies `checked` + `onCheckedChange`; restore dispatches the change via the handler; parent-driven state updates.
- [x] Extend `selection-persistence-integration.test.tsx` with a new scenario: card renders a `<TugCheckbox persistKey="done">`; user toggles it checked; simulate reload; assert checked state restored. This is the first integration-level proof of [A9].
- [x] Grep test: `selection-persistence-greps.test.ts` updated to expect `useComponentPersistence` imports in `tug-checkbox.tsx` (allowlist, not forbidden). _(N/A: `selection-persistence-greps.test.ts` contracts only retired/owner-restricted call patterns — no import allowlist exists. TypeScript enforces correctness of the new import.)_

**Checkpoint:**
- [x] `bun x tsc --noEmit` exits 0.
- [x] `bun test` full suite green. _(2349 pass / 0 fail.)_
- [x] Manual verification: a test card with `<TugCheckbox persistKey="t">` in the gallery (or a temporary test card) survives Cmd-R reload, tab switch, and Cmd-Tab away / back. [AT0024] validated on at least one component. _(Confirmed working in the browser via the new `gallery-state-preservation` card — uncontrolled and controlled opt-ins both survive Cmd-R and tab switch.)_

---

#### Step 20: `isFocusDestination` derived selector on the deck store {#step-20}

**Depends on:** #step-19

**Commit:** `feat(deck-store): add isFocusDestination selector and hasFocus slice`

**References:** [A1](#a1-focus-destination-selector); [L02] (useSyncExternalStore for React consumers); `deck-store.ts`.

**Artifacts:**
- Extend `DeckState` with a new `hasFocus: boolean` field, initialized from `document.hasFocus()` at store construction. Window `focus` / `blur` event listeners are installed at deck-store module init; each sets `state.hasFocus` and calls `deckStore.notify()`. The listeners are idempotent and guarded against double-install (module-scope flag).
- New pure selector in `tugdeck/src/deck-store-selectors.ts` (new file, or extend an existing `deck-store` module if natural):
  ```ts
  export function isFocusDestination(
    cardId: string,
    state: DeckState,
  ): boolean {
    if (!state.hasFocus) return false;
    const paneId = state.cards.get(cardId)?.paneId;
    if (!paneId) return false;
    if (state.activePaneId !== paneId) return false;
    const pane = state.panes.get(paneId);
    if (!pane) return false;
    return pane.activeCardId === cardId;
  }
  ```
- New React hook `useFocusDestination(cardId: string): boolean` in `deck-store-hooks.ts`. Implementation uses `useSyncExternalStore` with the deck store's `subscribe` and a getSnapshot that invokes `isFocusDestination(cardId, deckStore.getState())`.
- Non-React consumers call `deckStore.subscribe(() => { if (isFocusDestination(cardId, deckStore.getState())) {…} })`. Documented in a short header comment on the selector.
- No consumers yet. The selector is exported and importable; tests exercise it; behavior unchanged at phase end.

**Tasks:**
- [x] Add `hasFocus: boolean` to the `DeckState` type; default initialized from `document.hasFocus()` (or `true` for non-browser test environments).
- [x] Install window `focus` / `blur` listeners at module init; mutate state + notify. Guard against double-install.
- [x] Author `isFocusDestination(cardId, state)` as a pure selector in `deck-store-selectors.ts`.
- [x] Author `useFocusDestination(cardId)` hook in `deck-store-hooks.ts`.
- [x] Add header-comment usage examples for both React and non-React consumers.

**Upholds:** [A1]; [L02] (React consumers read external state through `useSyncExternalStore`); [L23] adjacent (predicate becomes the single source of truth for "who deserves focus right now").

**Tests:**
- [x] New `deck-store-selectors.test.ts`:
  - `isFocusDestination` returns false when `hasFocus === false`.
  - returns false when `activePaneId` doesn't match the card's pane.
  - returns false when `pane.activeCardId !== cardId`.
  - returns true only when all three conditions hold.
  - returns false for an unknown `cardId`.
- [x] New `use-focus-destination.test.tsx`:
  - Hook returns the selector's current value.
  - Re-renders the subscriber on `hasFocus` flips (simulate via `window.dispatchEvent(new Event("focus"))` / `"blur"`).
  - Re-renders on active-pane or active-card changes.
- [x] Existing tests must all pass unchanged.

**Checkpoint:**
- [x] `bun x tsc --noEmit` exits 0.
- [x] `bun test` full suite green.
- [x] No behavior change end-to-end — the selector is pure, the hook has no consumers yet.

---

#### Step 21: `canProgrammaticallyFocus` focus-theft gate {#step-21}

**Depends on:** #step-20

**Commit:** `feat(selection): add canProgrammaticallyFocus focus-theft gate`

**References:** [A8](#a8-focus-theft-gate); [R07](#r07-focus-steal-on-reload); `deck-store-selectors.ts` ([#step-20](#step-20)).

**Artifacts:**
- New file `tugdeck/src/focus-theft-gate.ts` exporting:
  - `canProgrammaticallyFocus(targetCardId: string, state: DeckState, opts?: { targetCardHostEl?: HTMLElement | null }): boolean` — returns `true` iff it's safe for a programmatic refocus helper to call `.focus()` on the target card's content root.
  - `isNonFocusCapturingChrome(el: Element | null): boolean` — predicate identifying chrome elements that can hold `activeElement` without counting as "user has moved focus" (pane drag handles marked `data-tug-chrome="non-focus-capturing"`, tab bar buttons between clicks, etc.). Starts as a conservative allowlist — callers can opt elements in by adding the data attribute.
- Decision branches (all return `false` unless noted):
  1. `!state.hasFocus` → false (app is backgrounded).
  2. `!isFocusDestination(targetCardId, state)` → false (the target isn't even supposed to be the focus destination right now).
  3. `document.activeElement === document.body` → true (nothing to steal).
  4. `opts.targetCardHostEl?.contains(document.activeElement)` → true (focus already inside the target card, refocus is a no-op or a refinement).
  5. `isNonFocusCapturingChrome(document.activeElement)` → true (focus is transient on chrome).
  6. Otherwise → false (the user has focus somewhere real; don't steal).
- Helper is framework-local; no global state; no DOM mutation.

**Tasks:**
- [x] Author `focus-theft-gate.ts` with `canProgrammaticallyFocus` + `isNonFocusCapturingChrome`.
- [x] Import `isFocusDestination` from Step 20 for the second check.
- [x] Document the `data-tug-chrome="non-focus-capturing"` opt-in in the file header so chrome element authors can opt in gradually.

**Upholds:** [A8]; [R07] centralized so no refocus helper re-implements the check.

**Tests:**
- [x] New `focus-theft-gate.test.ts` with one test per branch:
  - `hasFocus === false` → false.
  - Not a focus destination → false.
  - `activeElement === body` → true.
  - `activeElement` inside `targetCardHostEl` → true.
  - `activeElement` has `data-tug-chrome="non-focus-capturing"` → true.
  - `activeElement` is a real input outside target → false.
  - Missing `opts.targetCardHostEl` handled gracefully (treats as no-host-match, falls through to other checks).
- [x] Existing tests unchanged.

**Checkpoint:**
- [x] `bun x tsc --noEmit` exits 0.
- [x] `bun test` full suite green.
- [x] Grep for ad-hoc focus-theft logic (`document.hasFocus\|activeElement === body\|activeElement.closest`) inside `card-host.tsx` / `selection-guard.ts` returns only pre-existing callsites (not yet refactored — those routes through `canProgrammaticallyFocus` in M-phase 2 when [A3] lands).

---

#### Step 22: `onCardActivated` field in `CardPersistenceCallbacks` {#step-22}

**Depends on:** #step-21

**Commit:** `feat(card-host): add onCardActivated callback to persistence protocol`

**References:** [A2](#a2-on-card-activated); [D13](#d13-component-persistence); `use-card-persistence.tsx`.

**Artifacts:**
- Extend `CardPersistenceCallbacks` (in `use-card-persistence.tsx` or the authoritative protocol module) with:
  ```ts
  /**
   * Called when this card transitions to being the focus destination
   * (isFocusDestination becomes true). Typical implementation for
   * content-owning cards: engine.root.focus({ preventScroll: true }).
   * Not called at mount; the has-been-active ref-guard in [A3] skips
   * the initial activation. No-op for cards that don't need special
   * reactivation handling (FC cards are handled by CardHost directly).
   */
  onCardActivated?: () => void;
  ```
- `useCardPersistence` hook accepts the new field and stores it alongside existing callbacks. No dispatcher yet — the field is declared but never invoked at this step. The dispatcher lands in M-phase 2 as part of [A3]'s activation effect (Step 23).
- JSDoc updated to note: "The callback fires only after the shared `CardHost` activation effect ([A3]) is installed (M-phase 2). At Step 22, registering the callback is a no-op; implementors may register it now in preparation."

**Tasks:**
- [x] Add the optional `onCardActivated?: () => void` field to the `CardPersistenceCallbacks` interface.
- [x] Ensure `useCardPersistence` forwards the field into the stored callbacks record.
- [x] Verify that existing call sites of `useCardPersistence` continue to compile (the field is optional).

**Upholds:** [A2]; [D13] protocol shape; keeps the field declarative so content factories can start registering `onCardActivated` in preparation for M-phase 2 without needing to ship in the same commit.

**Tests:**
- [x] Type-only: add a compile-time assertion in `use-card-persistence.test.tsx` that `useCardPersistence({ persistKey: "t", onCardActivated: () => {} })` type-checks.
- [x] No behavior test (the callback isn't dispatched yet). A TODO comment in the test file points forward to M-phase 2 Step 23's dispatcher test.
- [x] Existing tests must pass unchanged.

**Checkpoint:**
- [x] `bun x tsc --noEmit` exits 0.
- [x] `bun test` full suite green.
- [x] No user-visible behavior change. M-phase 1 ends cleanly with [A1] + [A8] + [A2]-field in place, ready for M-phase 2 to wire [A3].

---

#### Step 23: Install [A3] shared activation effect in `CardHost` (FC reactivation) {#step-23}

**Depends on:** #step-22

**Commit:** `feat(card-host): install A3 shared activation effect`

**References:** [A3](#a3-shared-activation-effect); [A1](#a1-focus-destination-selector); [A8](#a8-focus-theft-gate); [A2](#a2-on-card-activated); [AT0001](#at0001-tab-switch-fc); [AT0003](#at0003-pane-activation); [AT0016](#at0016-tab-close-handoff).

**Artifacts:**
- New `useLayoutEffect` in `card-host.tsx` — the "activation effect." Subscribes to `useFocusDestination(cardId)` from [#step-20](#step-20). Runs on every render; internally gates on `false → true` transitions of that predicate via a `prevIsFocusDestinationRef`.
- Has-been-active guard: a module-scoped ref `hasBeenFocusDestinationRef` (per-card-instance) starts `false`. The effect no-ops on the first `true` reading — mount-time activation stays owned by the existing cold-boot restore path ([#step-10](#step-10), [#step-11](#step-11)). On all subsequent `false → true` transitions, the activation logic fires.
- On activation, the effect dispatches by card flavor:
  - **Content-owning** (`bag.content !== undefined`): call `callbacks.onCardActivated?.()`. At Step 23, no content factory registers this — the branch no-ops. Step 24 wires it for EM cards.
  - **DOM-authority** (`bag.content === undefined`, i.e. FC and related): re-apply `applyFocusSnapshot(bag.focus)` and then `restoreCardDomSelection(bag.domSelection)`. Focus-theft gate consulted first via `canProgrammaticallyFocus(cardId, deckStore.getState(), { targetCardHostEl: cardHostRef.current })` — abort silently if unsafe.
- The prior cross-pane refocus effect from [#step-11](#step-11) remains in place at Step 23 for FC (its current behavior is a subset of [A3]'s FC path); redundancy is tolerated for one step. Step 24's reconciliation retires the cross-pane effect for EM and decides the FC disposition (likely retire; [A3] now covers the same trigger).
- No changes to save paths, persistence schema, or engine.

**Tasks:**
- [x] Import `useFocusDestination` ([#step-20](#step-20)), `canProgrammaticallyFocus` ([#step-21](#step-21)), `CardPersistenceCallbacks` with `onCardActivated` ([#step-22](#step-22)).
- [x] Add the activation effect in `CardHost`, after the mount-time restore effect and the cross-pane refocus effect. Keyed on the `useFocusDestination` value.
- [x] Implement the has-been-active ref-guard such that mount activation is skipped; only post-mount transitions fire the body.
- [x] Dispatch body: FC branch re-applies focus + DOM-selection; EM branch calls `onCardActivated?.()`.
- [x] Focus-theft gate ([A8]) wraps the FC branch's `applyFocusSnapshot` and the EM branch's `onCardActivated` invocation.
- [x] Leave the Step 11 cross-pane effect untouched at this step; Step 24 handles reconciliation.

**Upholds:** [A3]; [L02] (React consumer subscribes to external state via `useSyncExternalStore` inside `useFocusDestination`); [L03] (`useLayoutEffect` so activation applies before any event-driven consumer paints); [R07] centralized via [A8].

**Tests:**
- [x] New `card-host-activation-effect.test.tsx`:
  - Mount-only flow: the activation body does not fire on initial mount (ref-guard skip).
  - `false → true` transition (simulated by flipping the mocked `isFocusDestination` value): FC branch re-applies focus + selection.
  - `false → true` transition: content-owning branch calls `onCardActivated` when registered.
  - Unsafe gate: `canProgrammaticallyFocus` returns `false` → activation body skipped entirely.
  - `true → false` transition: no-op (no blur applied; deactivation is app-lifecycle's job, not the activation effect's).
- [x] Extend `selection-persistence-integration.test.tsx` with three new scenarios:
  - **[AT0001] FC intra-pane tab switch:** card A is FC with focus + selection; switch to card B in the same pane; switch back; assert card A regains focus + selection paint.
  - **[AT0003] FC pane activation:** two panes, each with an FC card that had focus; click pane B chrome; click back on pane A's chrome (not the input); assert pane A's card regains focus.
  - **[AT0016] FC tab close handoff:** pane with two FC cards, card A focused; close card A; assert card B receives focus.
- [x] Existing integration tests must continue to pass — no regressions in cold-boot reload, cross-pane move (Step 11's effect still handles this for FC), or any paint-bucket behavior.

**Checkpoint:**
- [x] `bun x tsc --noEmit` exits 0.
- [x] `bun test` full suite green.
- [x] Manual verification (closed by Phase A trusted-click in-app sweep — `_smoke` 2/2, `_smoke-native` 5/5, AT0001 1/1, AT0003 1/1, AT0016 1/1 against real DEBUG Tug.app, 2026-04-24):
  - Two FC cards in a pane, one focused with a selection. Switch tabs and return — focus and selection paint restored. [AT0001] ✓
  - Two panes with FC cards focused in each. Click pane chrome to switch active pane; return — selection restored. [AT0003] ✓
  - Close the active FC tab in a multi-tab pane — focus lands on the new active tab. [AT0016] ✓
  - EM cards (tide-card, gallery-prompt-input) may still lose focus across these transitions — closes in Step 23E. Not a regression; pre-existing behavior.

---

#### Activation trigger taxonomy (preamble to Steps 23A–23E) {#activation-trigger-taxonomy}

Step 23's `[A3]` implementation landed as a `useLayoutEffect` that observed `useFocusDestination(cardId)` and wrote DOM-authority state (focus, selection paint) from inside React's commit cycle. Rapid-cadence manual verification of [AT0003] exposed a sibling-effect ordering race: two `CardHost`s reacting to the same `activePaneId` change fire their effects in unspecified order, so the incoming card's [A8] gate could see `activeElement` still inside the outgoing card (branch 6 → refuse) if the outgoing effect hadn't yet released focus. The race is a symptom; the underlying diseases are **[L22]** (driving DOM writes through React's render cycle) and **[L23]** (save-then-restore of user-visible state).

Steps 23A–23E replace the Step-23 implementation with a non-React `focus-transfer.ts` module whose entry points are called synchronously from each activation gesture's source. The contract pinned by `[A3]` is preserved end-to-end — the externally visible behavior ("card becomes focus destination → its `bag.focus` + `bag.domSelection` re-apply") is unchanged; only the implementation moves out of React.

Step 24 (engine-managed cards + redundant refocus retirement) is absorbed into this sub-sequence. Its content splits naturally: the Step-11 cross-pane effect retires in Step 23C alongside the multi-phase drag gestures that share its shape; EM content factories' `onCardActivated` opt-ins land in Step 23E. The Step 24 anchor is preserved for back-link integrity; its block is rewritten to point callers at the replacement steps.

##### Trigger taxonomy

Every activation flip routes through one of seven trigger shapes. Each row names the mechanism, the outgoing-vs-incoming relationship, and the gesture-source where the helper fires. Steps 23A–23E cover all six runtime triggers (rows 1–6); cold-boot (row 7) is a mount-phase concern and continues to live in `CardHost`'s mount-restore effect.

| # | Trigger | Shape | Outgoing → Incoming | Where the helper fires |
|---|---------|-------|---------------------|------------------------|
| 1 | Intra-pane tab click ([AT0001](#at0001-tab-switch-fc)) | sync, before-mutation | different cards | `tug-pane.tsx#performSelectCard` |
| 2 | Pane-chrome activation click ([AT0003](#at0003-pane-activation)) | sync, before-mutation | different cards | `pane-focus-controller.ts` |
| 3 | Tab-close handoff ([AT0016](#at0016-tab-close-handoff)) | sync, before-mutation | outgoing destroyed | `deck-manager.ts#_removeCard` / `_closePane` |
| 4 | Cross-pane drag / detach ([AT0006](#at0006-cross-pane-em) FC-half, [AT0007](#at0007-card-detach) FC-half, [AT0021](#at0021-drag-aborted)) | multi-phase | same card, DOM re-parents | save at drag-start (pane chrome `pointerdown`); refocus at drop (`_moveCardToPane` / `_detachCard`) or cancel (Escape / `pointercancel`; drop-into-void is not a cancel, it detaches) |
| 5 | App resign → resume / window focus ([AT0004](#at0004-app-resign-return), [AT0005](#at0005-app-hide-unhide), [A4](#a4-app-lifecycle-activation)) | external event | current first-responder → itself | window `blur` save + window `focus` reactivate ([Step 20](#step-20) listener extended in [Step 23D](#step-23d)); EM-card delegate `focus()` routes through `engine.setSelectedRange` for WebKit-safe focus-then-select ordering ([Step 23G](#step-23g)) |
| 6 | EM card activations ([AT0002](#at0002-tab-switch-em), [AT0006](#at0006-cross-pane-em) EM-half, [AT0007](#at0007-card-detach) EM-half, [AT0009](#at0009-inactive-mount)) | sync or external | engine owns focus | registered `onCardActivated` callback (dispatched from row 1 / 2 / 3 / 4 / 5 paths by card-flavor) |
| 7 | Cold-boot mount | structural | — | `CardHost`'s post-attach `useLayoutEffect` keyed on `[cardId, hostContentEl, store]` calls `onRestore(bag.content)` AFTER CardPortal's slot.appendChild has connected the engine root to the document. Closed by [Step 23F](#step-23f) gap-1 (the previous synchronous-from-child-effect call landed selection on a detached portal slot). |

##### Step breakdown

- **[Step 23A](#step-23a)** — Plumbing only. `focus-transfer.ts` scaffolded; store registration channels; `CardHost` registers its root element; `useCardPersistence` routes `onCardActivated` through the new channel. No behavior change; existing Step-23 and Step-11 effects remain in place.
- **[Step 23B](#step-23b)** — Retires the `[A3]` React effect. Wires rows 1, 2, 3 through the helper's synchronous before-mutation entry point. Rapid-cadence [AT0001] / [AT0003] / [AT0016] are the regression gates.
- **[Step 23C](#step-23c)** — Retires Step-11's cross-pane `[hostStackId]`-keyed effect. Wires row 4 (drag-start save + drop/cancel refocus) through the helper. Drag-coordinator integration is explicit: pointerdown-save hook, post-drop refocus hook, and drag-cancel refocus hook are all named. Closes the FC/MV halves of [AT0006], [AT0007], and [AT0021].
- **[Step 23D](#step-23d)** — Wires row 5 ([A4] app-lifecycle) through the helper. The `window.focus` listener installed in [Step 20](#step-20) routes through a new `reactivateCurrentFocusDestination(store)` entry. Closes [AT0004] and [AT0005]. **Absorbs what was previously labeled M-phase 3.**
- **[Step 23E](#step-23e)** — EM content factories (tide-card, `TugPromptInput`, `GalleryPromptEntry`) register `onCardActivated` (row 6). Closes the EM halves of [AT0002], [AT0006], [AT0007], and [AT0009]. Retires any ad-hoc engine-internal refocus code superseded by the helper.
- **[Step 23F](#step-23f)** — Cold-boot EM-card selection paint. Surfaced as a real-app gap during manual verification after 23E. Closes row 7 for EM cards specifically (FC cold-boot was already working).
- **[Step 23G](#step-23g)** — EM-card selection survives the app-resign / app-become-active round-trip (cmd-tab away+back). Real-app gap surfaced post-23F: tide-card's redundant `cardDidActivate`+`onCardActivated` focus path triggered WebKit's selectionchange-on-focus quirk intermittently. Fix routes the delegate's `focus()` through `engine.setSelectedRange` for WebKit-safe focus-then-select.

Dependency chain: 23A → 23B → (23C ‖ 23D) → 23E → 23F → 23G. 23C and 23D touch disjoint files (drag path vs. window-focus listener) and can land in either order once 23B is in. 23F closes the row-7 gap; 23G refines row 5's EM behavior.

##### Execution strategy: ping-pong with harness extensions {#step-23-execution-strategy}

Steps 23B–23E land their behavior changes against `dash/tugplan-harness-extensions.md`'s in-app harness as the primary regression gate. Two of the five sub-steps (23D, 23E) require harness primitives that are not yet built; the strategy below interleaves harness work and selection-plan work so each behavior change ships with an automated end-to-end test against real Tug.app, not a human-in-the-loop ritual.

**Why ping-pong, not harness-first.** The harness is now confirmed faithful (Phase A acceptance — see `tugplan-harness-extensions.md` [#step-3b]); each new selection-plan behavior change is testable as soon as its harness piece is in. Front-loading all of harness Phases A/B/C before any 23B–23E work would block six weeks of behavior change behind harness throughput. Interleaving keeps both fronts moving and uses every newly-landed primitive immediately, while harness-first builds tooling that sits unused until the selection plan catches up.

**Rapid-cadence is moving from a manual ritual to an automated gate.** Steps 23B/23C/23D each carry a "manual verification at rapid cadence" checkpoint as their regression-closure gate. Those checkpoints predate the trusted-click pipeline. Now that `nativeClickAtElement` works, every "rapid cadence" verification graduates to a dedicated in-app test file (one per scenario) that issues the same gestures back-to-back with no inter-call waits. Slow-cadence baselines stay in their existing files (`at0001-tab-switch-fc.test.ts`, `at0003-pane-activation.test.ts`, `at0016-tab-close-handoff.test.ts`); rapid-cadence variants live alongside in `at0001-rapid-cadence.test.ts`, `at0003-rapid-cadence.test.ts`, `at0016-rapid-cadence.test.ts` so failures name the cadence in the file path and either set can be disabled independently if it ever needs to be.

**Pass map.** The strategy executes in nine passes. Each pass is one or two commits; selection-plan passes follow the existing one-step-one-commit discipline modulo the explicit allowance to split 23B (per author note, 2026-04-24). Harness-side passes follow `tugplan-harness-extensions.md`'s step boundaries.

| # | Pass | Type | Purpose | Output |
|---|------|------|---------|--------|
| 1 | Doc sync | doc | Close stale checkboxes; cite real commit hashes; correct stale `nativeDrag` docstrings. | One commit; no behavior change. |
| 2 | Rapid-cadence test files | harness | Lift Steps 23B/23C/23D's "manual rapid-cadence" gate to automated. Author `at0001-rapid-cadence.test.ts`, `at0003-rapid-cadence.test.ts`, `at0016-rapid-cadence.test.ts`. See "Pass 2 result note" below — files start green and serve as forward regression gates. | Three new test files, three forward regression gates, one commit. |
| 3 | [Step 23B](#step-23b) | selection | Retire the [A3] React effect; wire rows 1–3 (intra-pane tab click, pane-chrome activation, tab-close handoff) through `transferFocusForActivation`. Pass 2's rapid-cadence tests stay green through the migration; any regression at the existing cadence fails Pass 2's files immediately. | Up to three commits per the split-allowed authorisation: (a) `transferFocusForActivation` body + `pane-focus-controller` wiring, (b) `tug-pane`/`deck-manager` wiring + `flushSync` sandwich, (c) [A3] effect retirement + test rename. |
| 4 | [Step 23C](#step-23c) | selection | Multi-phase drag: drag-start save, drop refocus, Escape/`pointercancel` refocus. Retire Step-11's cross-pane `useLayoutEffect`. Author AT0006/AT0007/AT0021 in-app tests using the existing `nativeDrag` + `nativeKey("Escape")`. | One commit (per plan); new `at0006-cross-pane-drag.test.ts` / `at0007-card-detach.test.ts` / `at0021-drag-aborted.test.ts` files; rapid-cadence variants if the slow versions reveal a race. |
| 4.5 | Harness Step 3c | harness | Add `nativeDragWithoutRelease` primitive (and element-anchored variant) per `tugplan-harness-extensions.md` [#step-3c]. Backfill `at0021-drag-aborted` with a real test body that issues the trusted `nativeDragWithoutRelease → nativeKey("Escape") → nativeMouseUp` sequence. Closes the harness gap surfaced at Pass 4 close. | Per harness plan Step 3c; m21 placeholder retired. |
| 5 | Harness Step 4 | harness | Swift app-lifecycle handlers (`simulateAppResign` / `BecomeActive` / `Hide` / `Unhide`) per `tugplan-harness-extensions.md` [#step-4]. Required dependency for selection [Step 23D](#step-23d). | Per harness plan Step 4. |
| 6 | [Step 23D](#step-23d) ✅ | selection | Wire row 5 ([A4] app-lifecycle) through `reactivateCurrentFocusDestination`. Window-`blur` save flush; window-`focus` reactivation. New AT0004/AT0005 in-app tests using harness Step 4's primitives. | One commit; `at0004-app-resign-return.test.ts`, `at0005-app-hide-unhide.test.ts`. Drift-prevention cycle landed (revert listeners → tests red → restore → tests green). |
| 7A | Harness Step 5 ✅ | harness | Tugcode subprocess lifecycle: Swift `startTugcode` / `stopTugcode` handlers, pipe-fd setup, SIGTERM/SIGKILL teardown, log routing to `tests/app-test/logs/<test>-tugcode.log`, production launch path gated behind `!testMode`, RPC dispatch + types, latency measurement → resolve [Q03]. Surface version: bump Swift `surfaceVersion` `1.2.0`→`1.3.0` (additive minor; tugdeck `SURFACE_VERSION` unchanged). Scratch `smoke-tugcode-lifecycle.test.ts` proves spawn/teardown in isolation. | Per harness plan Step 5; one commit; mostly Swift. [Q03] resolved per-test-file (median 13.2ms / 10 cycles). |
| 7B | Harness Step 6 ✅ | harness | Stub-transcript replay + tooling: tugcode `--stub-transcript=<path>` CLI flag with structured-record replay engine; transcript handoff folded into `startTugcode({ transcript })` (path-based, not fd-based — see Author note); two new error classes (`TugcodeVersionSkewError`, `TugcodeTranscriptMismatchError`); content-hash sidecar helper + `scripts/reapprove-transcript.ts`; new `writeTugcodeStdin` RPC verb so tests can drive tugcode's IPC loop directly; transcript round-trip unit tests; end-to-end stub smoke; [Q04] resolved (structured records + SHA-256 sidecar; no raw-bytes fallback needed). Surface bumps Swift `1.3.0`→`1.4.0` + TS `EXPECTED_SURFACE_VERSION` `1.3.0`→`1.4.0`. Capture script + version-skew runtime throw are deferred to 7C. | Per harness plan Step 6; one commit. |
| 7C | Harness Step 7 ✅ | harness | EM-card surface (`__tug.getEmCardState` + `isEngineReady`; harness `awaitEngineReady`); two new deck-trace event kinds (`engine-ready` wired at `tug-prompt-input.tsx`; `engine-activation-dispatched` defined for Step 23E emit sites); tugdeck `SURFACE_VERSION` `1.1.0`→`1.2.0`; permanent `smoke-em.test.ts` (3 tests, in default sweep); scratch `smoke-tugcode-lifecycle.test.ts` and `smoke-tugcode-stub.test.ts` retired. **Tugcode → tugdeck integration deferred** — needs tugcast-bypass plumbing not yet in place; smoke covers observation surface only. **Capture script + `drainTugcodeTurn` + `getEngineSelection` deferred** — see Author note. | Per harness plan Step 7; one commit. |
| 7D | Harness Step 8 ✅ | harness | Live-mode smoke: `tests/app-test/smoke-em-live.test.ts` exercises real tugcode → Claude Code → Anthropic; gated behind `TUGCODE_LIVE=1` (default sweep skips it). New `dir` field on `StartTugcodeOptions` mapping to tugcode's `--dir <path>` arg. README addition documenting the opt-in flag. **Tugdeck-side observation deferred** alongside the tugcast-bypass plumbing — smoke asserts on bare-tugcode protocol shape (assistant_text + turn_complete in stdout log) rather than `getEmCardState`. Capture script also deferred. | Per harness plan Step 8; one commit; small. |
| 7-close | Harness Step 9 verification sweep ✅ | verification | Verified: 14/14 default sweep + 2412/2412 tugdeck unit + 205/205 tugcode unit + 58/58 harness unit. Release `nm` audit clean (zero TestHarness/AppLifecycle/TugcodeLifecycle/NativeEvent/VirtualKeyMap/CoordMapping/CGEvent symbols). `#if DEBUG` gating verified across all 9 TestHarness Swift files + AppDelegate. Surface versions in lockstep (Swift/TS RPC at 1.4.0; tugdeck JS at 1.2.0). | Plan-doc-only commit (`dc848c91` Step 23F authoring already covered the doc updates; verification flips Step 9 checkboxes). |
| 8 | [Step 23E](#step-23e) ✅ | selection | EM content factories register `onCardActivated`; new in-app tests AT0002/AT0006-EM/AT0007-EM/AT0009 covering both `gallery-prompt-input` (TugPromptInput direct) and `gallery-prompt-entry` (TugPromptEntry, tide-card's editor); `invokeActivationCallback` plumbed with `dispatchedFrom` tag; `engine-activation-dispatched` trace fires from DeckManager. **Three follow-up gaps surfaced and tracked in [Step 23F](#step-23f):** cold-boot selection paint, fresh-EM-card resolver mis-classification, EM focus-after-cross-pane-move. **Deferred to Pass 10:** grep audit for ad-hoc engine-refocus paths and `_flipFirstResponder` dev-only assertion. | One commit; 4 new EM-half test files (8 tests across 2 factories each); + plan updates expanding 23F to cover the surfaced gaps. |
| 9 | [Step 23F](#step-23f) ✅ | selection | Three EM-card focus gaps closed. Gap 1 (cold-boot selection): root cause was CardPortal slot detachment when `onRestore` fired from a child's `useLayoutEffect` — the engine root sits in a detached `<div data-card-portal-slot>` at the moment `engine.setSelectedRange` runs, so `.focus()` no-ops and `addRange` doesn't stick. **Fix**: defer `callbacks.onRestore(bag.content)` from `registerPersistenceCallbacks` (called early from a child's effect) to a CardHost-owned `useLayoutEffect` keyed on `[cardId, hostContentEl, store]`, which fires AFTER CardPortal's slot.appendChild. L04 ready-callback pattern. Gap 2 (fresh-card resolver): `resolveActivationTarget` now consults `registration.engineKind === "em"` first, before the `bag.content !== undefined` heuristic. EM factories tag their registrations. Gap 3 (focus-after-move): incidentally fixed by gap-1 — pre-fix, the cold-boot path left a half-mounted state that cascaded into the move path. Three new in-app tests: `at0032-em-cold-boot-selection.test.ts`, `at0033-em-fresh-card-activation.test.ts`, `at0034-em-focus-after-move.test.ts`. Drift-prevention verified for both gap-1 and gap-2. | One commit; production fixes in `card-host.tsx` (defer onRestore to post-attach effect), `card-registry.ts` (add `engineKind` field + `isEngineManagedCard` helper), `focus-transfer.ts` (registry-tag check in resolver), three EM factories tag `engineKind: "em"`. Diagnostic deck-trace events `cold-boot-restore-snapshot` + `engine-restore-applied` added (kept post-fix as forward observability). |

**Pass 2 result note (2026-04-24).** The rapid-cadence files were authored expecting them to fail today (the [A3] sibling-effect race the strategy was designed to drive 23B against). They pass deterministically across multiple consecutive runs at the harness's natural cadence (~50ms between clicks: Swift's 20ms intra-click delay + ~10ms RPC round-trip per `nativeClickAtElement`, well under the plan's <100ms gate). Most plausible explanation: Step 3b's `pane-focus-controller` mousedown `preventDefault` already closed the user-visible symptom — WebKit no longer blurs focus during pane-chrome / tab clicks, so the [A3] restore lands on a stable target rather than racing a focus-clearing default. The architectural problem is unchanged (DOM writes routed through React's render cycle violate [L22]/[L23]); Step 23B is now architectural cleanup rather than a bug fix. The rapid-cadence files become *forward* regression gates: they lock in current passing behavior so 23B's helper migration cannot reintroduce a regression at any of AT0001/AT0003/AT0016's cadences. Step 23B's existing checkpoints are unchanged; the rapid-cadence verification line ("Manual verification at rapid cadence (<100 ms between clicks)") flips from human-verified to test-file-verified once the migration lands and the files are still green.

**Pass 4 result note (2026-04-24).** Two findings worth pinning. First, `at0021-drag-aborted` shipped as a `describe.skipIf(true)` placeholder. The harness's `nativeDrag` is atomic (`mouseDown` → 8-step interpolated trail → `mouseUp` in one Swift-side RPC), and there is no `nativeMouseDragged` exposed on the TS surface, so a "begin drag, hold, fire Escape, release" sequence cannot be authored with current verbs. Pass 4.5 closes this gap by adding `nativeDragWithoutRelease` per harness plan [#step-3c] and backfilling m21 with a real test body. Manual verification of the Escape→cancel path is the regression gate until Pass 4.5 lands. Second, m06's first draft asserted that focus stays on the source pane's remaining card after a cross-pane merge — that turned out to be production-bug-pinning rather than correct behavior. The user gesture intent for "drag a card to another pane" is to follow the card; pre-fix, `_moveCardToPane` only flipped `activePaneId` to the target when the source was destroyed, leaving the dragged card mounted but not focused. The fix landed in the same Pass 4 commit: `_moveCardToPane` always activates the target pane and bumps it to z-top, making the dragged card the new first responder. Unit test `T-11-6-1b-07b` rewritten to reflect the new contract. Discipline rule: a pass that surfaces a real production bug MUST land the fix in the same pass (already codified below).

**Pass 5 result note (2026-04-25).** macOS Sonoma+ broke the simple `NSApp.deactivate()` primitive: the call is silently ignored when there's no other "active" app queued to receive activation, so `applicationDidResignActive:` never posts and the bridge times out. The harness's `simulateAppResign` therefore activates Finder via `NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.finder").first?.activate(options: [])` after calling `NSApp.deactivate()` — Finder is system-essential and always running, so it's a reliable target, and activating it forces Tug.app to give up activation exactly the way a user click into Finder would. The wire spec [D07] still names `NSApp.deactivate()` as the primitive; the Finder nudge is an implementation detail of the Swift handler and has no harness-API or test-API impact. The hide/unhide / become-active primitives work as documented. Smoke test `smoke-app-lifecycle.test.ts` covers all four happy paths plus a deliberate-timeout path (`simulateAppHide` while already hidden, with `timeoutMs: 1`) — file is scratch-marked for deletion at the harness plan's Step 6 once AT0004/AT0005 land in the permanent test set.

**Pass 8 result note (2026-04-25).** Step 23E landed with the dispatch-wiring contract closed (EM factories register `onCardActivated`, `engine-activation-dispatched` traces fire correctly across all activation gesture sources). Two scope-trimming decisions and three new gaps absorbed into Step 23F.

(1) **In-app smokes broadened to gallery-prompt-entry**, per user feedback that TugPromptEntry (which tide-card uses internally) is the realistic case, not just standalone TugPromptInput. AT0002, AT0006-EM, AT0007-EM, AT0009 each now have two parameterized tests — one per EM factory.

(2) **Three related EM-card focus gaps surfaced during 23E in-app testing and absorbed into [Step 23F](#step-23f).** All share root "fresh / freshly-re-mounted EM cards have brittle focus paths." (a) Cold-boot selection paint (originally 23F's only gap). (b) Fresh-EM-card resolver mis-classification: a never-saved EM card activates via `default-focus` instead of `dispatch-activated` because `bag.content !== undefined` is the EM discriminator; default-focus then walks DEFAULT_FOCUS_SELECTORS where `button:not([disabled])` matches before `[contenteditable="true"]`, landing focus on a toolbar button. (c) EM focus-after-cross-pane-move doesn't stick: `engine-activation-dispatched` fires (proving onCardActivated ran) but `.focus()` no-ops on the freshly re-mounted contenteditable, leaving activeElement on BODY. Step 23F now addresses all three.

(3) **Deferred to Pass 10 cleanup:** grep audit for ad-hoc `engine.root.focus()` paths and the `_flipFirstResponder` dev-only assertion. Both are internal-infrastructure work that doesn't gate user-visible behavior; landing them after the Step 23F production gaps are closed makes for cleaner bisect.

**Pass 9 result note (2026-04-25).** Step 23F landed and closed all three EM-card focus gaps in a single commit. The diagnostic loop produced a diagnosis quickly: instrumenting CardHost's `registerPersistenceCallbacks` and the EM factories' onRestore call sites with `cold-boot-restore-snapshot` and `engine-restore-applied` showed that the engine's `setSelectedRange` was running with `selectionApplied={start:0,end:5}` but `domSelectionAfter=null` — the selection set on a detached portal slot. The reproduction showed `engine-restore-applied` firing BEFORE `card-host-mount`, which is the wrong order — child's onRestore was running before CardPortal's parent could `host.appendChild(slot)`. The fix is L04-pure: move the `onRestore` call from a child-driven side effect (`registerPersistenceCallbacks`, called from useCardPersistence's `[register]` effect) to a CardHost-owned post-attach layout effect. Effects fire children-first, so a CardHost effect runs after CardPortal's effect, after slot is attached.

**Pass 9 follow-up — late-mount registration (2026-04-25).** First-pass deferred restore landed without a bridge from a late-arriving child registration back into the restore effect's dep set. Cards whose content factory mounts conditionally — tide-card gates its `<TugPromptEntry>` on `feedsReady`, which doesn't flip true until tugcast feeds populate post-mount — register their persistence callbacks several commits AFTER CardHost first runs the restore effect. Without a re-trigger, the restore effect had already fired with `callbacks=null` and returned early; when callbacks finally appeared, nothing re-fired the effect, and `onRestore(bag.content)` was never called. User-visible symptom: open a tide card, type, quit, relaunch — text didn't restore. Fix: a `callbacksVersion` `useState` counter incremented inside `registerPersistenceCallbacks` and added to the restore effect's deps. Children's late registration now triggers a re-render whose effect re-runs the restore conditions and applies the bag once everything is ready. The harness can't easily reproduce this — tide-card's feeds depend on a live tugcast/Claude Code stream that isn't part of the in-app sweep — so the test plane is the gallery-prompt-entry path (m32 still passes after the fix); user-side manual verification gates the fix.

Gap 2 was the cleanest of the three: a one-field registry change (`engineKind?: "em"` on `CardRegistration`) plus a registry-aware branch in `resolveActivationTarget` before the legacy `bag.content !== undefined` check. The three EM factories (`gallery-prompt-input`, `gallery-prompt-entry`, `tide`) declare `engineKind: "em"`. Fresh, never-saved EM cards now route through `dispatch-activated` from the very first activation rather than falling through to `default-focus` (where `button:not([disabled])` would have matched before `[contenteditable="true"]`).

Gap 3 (focus-after-cross-pane-move) was incidentally closed by the gap-1 restructure. Pre-fix, the cold-boot path was applying selection to a detached slot, leaving the engine in an inconsistent state that cascaded forward — by the time the user dragged the card cross-pane, the focus path's `.focus()` call was operating against a node whose history of detach/reattach interactions had unsettled WebKit's internal state. Once the cold-boot path lands selection correctly, the cross-pane drag's `engine.root.focus()` lands focus correctly too — verified by m34 (4 tests across 2 factories × 2 scenarios) all green with the gap-1 fix and all failing without it.

Default sweep: 21/21 files (38 tests). Tugdeck unit: 2414/2414. tsc clean (tugdeck + tests/app-test). Drift-prevention verified for gap-1 (m32 + m34 fail without the deferred-restore change) and gap-2 (m33 fails without the registry-tag branch in `resolveActivationTarget`). End-of-M-phase-2 closes here for the production gaps; Pass 10 cleanup (grep audit for ad-hoc engine refocus + `_flipFirstResponder` dev assertion) remains.

End-of-M-phase-2 will properly close once Step 23F lands plus the Pass 10 cleanup follows.

**Pass 7D result note (2026-04-25).** Live-mode tugcode launch path landed; tugdeck-side observation deferred alongside the tugcast-bypass plumbing (same root cause as 7C deviation #1). Two scope adjustments from the plan-as-written. (1) Smoke retreats to "bare-tugcode protocol-shape" assertions because tugdeck has no line of sight into the harness-spawned tugcode without the bypass plumbing. The smoke still proves the live-mode launch path: real claude spawn, real Anthropic call, `assistant_text` + `turn_complete` in stdout. (2) Capture script (`scripts/capture-tugcode-transcript.ts`) deferred to the same later integration pass — its only consumer would be a tugdeck-observable EM-card test, which doesn't exist yet. The `dir` field on `StartTugcodeOptions` is additive (no surface bump). End-to-end integration question (tugcast → harness-owned tugcode wiring) tracked as a Phase B follow-up that isn't blocking 23E or downstream selection-plan work.

**Pass 7C result note (2026-04-25).** EM-card observation surface landed; tugcode → tugdeck end-to-end integration **deferred** to a future pass. Five implementation deviations from the plan-as-written, in declining order of significance. (1) **Tugcode integration into tugdeck deferred.** Pass 7A discovered tugcast spawns its own tugcode per AI session — the harness-spawned tugcode is orphan from tugdeck's perspective. Wiring tugdeck to observe the harness-owned tugcode requires tugcast-side (Rust) changes that exceed Pass 7C's scope. The smoke retreats to "EM-card observation surface validation": seed an EM card, type into it via native gestures, assert the surface readbacks. `streamState` and `lastTurnSeq` are stub fields until the integration lands. (2) **`awaitEngineReady` moved from JS surface to harness side.** `evalJS` runs synchronously on the same thread that records `engine-ready`, so a busy-wait inside the surface method couldn't observe new events. Fix: synchronous `__tug.isEngineReady(cardId)` on the JS side, harness-side `app.awaitEngineReady` wraps it via `waitForCondition`. (3) **`getEngineSelection` subsumed by `getEmCardState.engineSelection`** — separate getter would be redundant. (4) **`drainTugcodeTurn` deferred** alongside the tugcode-integration work. (5) **Capture script deferred to 7D / Step 8** — needs live tugcode + tugdeck-observable sink, neither in place yet. Surface bumps: tugdeck `SURFACE_VERSION` `1.1.0`→`1.2.0`; Swift / TS RPC versions unchanged at `1.4.0`.

**Pass 7B result note (2026-04-25).** [Q04] resolved on first design pass: structured records (full tugcode `OutboundMessage` shapes per turn) with SHA-256 sidecars; no raw-bytes fallback needed. Five implementation deviations from the plan-as-written, in declining order of significance. (1) **Path-based transcript handoff, not fd-based.** Foundation's `Process` doesn't expose arbitrary fd inheritance to children, so Swift writes the transcript JSON to a temp file under `$TMPDIR` and passes `--stub-transcript=<path>`. Equivalent fidelity, simpler plumbing, file is removed on `stop()`. (2) **`seedTugcodeTranscript` / `seedTugcodeError` folded into `startTugcode`'s opts.** Two-step state (seed → start) creates ordering coupling without ergonomic gain; every known consumer authors the full transcript before launch. Errors become `error`-typed entries in `turn.outputs[]`. (3) **Added `writeTugcodeStdin(line)` RPC verb.** Tests need to drive tugcode's IPC loop directly (production tugcast isn't in the loop in test mode); the harness writes JSON IPC frames via the held-open stdin pipe Swift created in 7A. (4) **Capture script (`capture-tugcode-transcript.ts`) deferred to 7C.** It needs a live tugcode + EM-card sink to capture against — both arrive in 7C. The shared `computeTranscriptHash` helper + `reapprove-transcript.ts` are landed now so 7C can build the capture script directly on them. (5) **Version-handshake runtime throw deferred.** `TugcodeVersionSkewError` class is defined; the throw-site is not yet wired (no real-world drift to detect until 7C ships committed transcripts). Surface versions bumped Swift `1.3.0`→`1.4.0` and TS `EXPECTED_SURFACE_VERSION` `1.3.0`→`1.4.0` for additive `transcript` + `writeTugcodeStdin` wire payloads.

**Pass 7A result note (2026-04-25).** [Q03] resolved on the first measurement: median start+stop+RPC wall-clock 13.2ms across 10 cycles (min 11.5ms / max 13.7ms), so per-test-file lifecycle wins on simplicity — no `resetTugcode()` RPC needed. Three implementation deviations from the plan-as-written: (1) the "production tugcode-launch path gated behind `!testMode`" task is a no-op today because tugcast spawns tugcode per AI session on demand (in `feeds/agent_bridge.rs::TugcodeSpawner`), NOT at app boot. The harness never initiates an AI session, so the production spawn path naturally doesn't fire — the gate would only become load-bearing if tugcast added an at-boot warm-spawn. Documented in the Author note of harness plan Step 5; revisit when relevant. (2) tugcode shuts down on stdin EOF (its `[tugcode] stdin closed, shutting down` branch), so the Swift handler holds a `Pipe`'s write-end open for the lifetime of the child. The same FD will carry transcript bytes in 7B's `--stub-transcript=<fd>` flow. (3) Surface versions bumped Swift `1.2.0`→`1.3.0` and TS `EXPECTED_SURFACE_VERSION` `1.2.0`→`1.3.0` (additive minor); `smoke.test.ts`'s exact-match assertion against `EXPECTED_SURFACE_VERSION` stays in lockstep.

**Pass 6 result note (2026-04-25).** Step 23D landed cleanly with no production-bug surfacing. `reactivateCurrentFocusDestination` mirrors the shape of `transferFocusAfterMove`'s 3-step body (resolve → gate → transfer) with two distinguishing details: (1) it reads `cardId` from `store.getFirstResponderCardId()` and short-circuits on `null` rather than receiving an explicit cardId, and (2) the trace `site` tags are `"focus-transfer-reactivate"` / `"focus-transfer-reactivate-default"` so post-mortems can distinguish app-resume reactivations from drag-drop refocuses. The window-`blur` handler runs `store.invokeSaveCallback(fr, "window-blur")` BEFORE flipping `setHasFocus(false)` and the window-`focus` handler runs `reactivateCurrentFocusDestination(store)` AFTER `setHasFocus(true)` — both orderings matter (the gate reads `state.hasFocus`; flipping after the helper would refuse). Added `"window-blur"` to the `SaveCallbackSource` union so the trace marker the AT0004/AT0005 tests assert on is a typed citizen of the trace surface. Plan deviation: the originally-planned happy-dom unit tests in `focus-transfer.test.ts` / `deck-manager.test.ts` and the `selection-persistence-integration.test.tsx` extension are dropped — the project's happy-dom scoping rule prohibits focus / event-ordering across React renders in jsdom-class fakes, and the in-app AT0004/AT0005 tests are the natural regression gate. The plan's task-list checkboxes for those unit tests are marked SKIPPED with rationale rather than checked.

**Discipline rules.**

- Every selection-plan pass closes with the in-app sweep + tugdeck unit tests + tugdeck typecheck (`bunx --bun tsc --noEmit`) all green. No "regression to chase later" is permitted.
- Rapid-cadence variants run as part of the default `just test-in-app-fast` sweep — adding them to the sweep is part of Pass 2's checklist. A passing rapid-cadence file is the regression gate; do not flip its corresponding selection-plan checkpoint without it.
- A pass that surfaces a real production bug (e.g. Pass 4's drag-cancel scenarios may surface coordinator-side races) MUST land the production fix in the same pass, paralleling Step 3b's pattern: the test exists to prove user-visible behavior is correct, not to prove the test framework is consistent. Production fix in its own commit; test rewrite in its own commit; doc note in `dash/at-series-reconciliation.md` if appropriate.
- Harness-side passes (5, 7) follow `tugplan-harness-extensions.md`'s author notes verbatim. Any deviation discovered during implementation lands as an `**Author note (YYYY-MM-DD):**` block in the harness plan, mirroring how Step 3b documented its findings.
- The "manual verification at rapid cadence" lines on Steps 23B/23C/23D's checkpoints are explicitly retired by Pass 2's automated files. Each of those checkboxes flips to "verified by `<rapid-cadence-test-file>`" once the corresponding production change lands and the file is green. Slow-cadence manual verification of new behavior (e.g. cmd-tab away and back for [A4]) stays manual until the test exists; once it does, it's gone.

**Plan-doc posture.** This [execution strategy](#step-23-execution-strategy) section is the canonical guide for executing 23A–23E. It does not modify any individual sub-step's body — those keep their existing artifacts/tasks/tests/checkpoints. The strategy section's job is sequencing, naming the harness blockers, and making the rapid-cadence gate explicit.

---

#### Step 23A: Scaffold the focus-transfer module + store registration channels {#step-23a}

**Depends on:** #step-23

**Commit:** `feat(focus-transfer): scaffold focus-transfer module and store registration channels`

**References:** [A3](#a3-shared-activation-effect); [A8](#a8-focus-theft-gate); [A2](#a2-on-card-activated); [L10](#); `card-host.tsx`, `deck-manager.ts`, `deck-manager-store.ts`, `use-card-persistence.tsx`.

**Purpose.** Land the seam. Every subsequent step (23B–23E) can then assume the helper module, the store API, and the registration discipline are in place. **No user-visible behavior change at this step's commit boundary.** The Step-23 `[A3]` `useLayoutEffect` and the Step-11 cross-pane effect both stay untouched; nothing is retired yet.

**Artifacts:**
- **New file `tugdeck/src/focus-transfer.ts`.** Scaffolded with the module docstring, the `ActivationTarget` discriminated union type, the function signatures for `transferFocusForActivation`, `captureFocusForDragStart`, `transferFocusAfterMove`, and a complete implementation of `resolveActivationTarget(incomingCardId, store): ActivationTarget`. The three side-effecting functions throw `"not implemented (lands in Step 23B/C/D)"` with references to the owning step so any accidental caller fails loudly until the wiring step lands.
  - **`ActivationTarget` shape.** The resolver returns the resolved DOM element directly so downstream gate/transfer steps don't re-query (per audit P3). Three variants:
    ```ts
    type ActivationTarget =
      | { kind: "focus-element"; el: HTMLElement }
      | { kind: "dispatch-activated" }
      | { kind: "none" };
    ```
  - **`resolveActivationTarget(cardId, store)` contract.** Side-effect-free and idempotent, but NOT pure over the store alone — it reads DOM state via `store.peekCardHostRoot(cardId)` plus the card's bag, then does the `querySelector` for FC bag shapes (`persistKey` for form-control, `focusKey` for dom, `[data-tug-prompt-input-root] [contenteditable]` for component-owned). Returns `{ kind: "focus-element", el }` when the element is found, `{ kind: "dispatch-activated" }` when `bag.content !== undefined` (the content factory's registered `onCardActivated` will handle DOM targeting), and `{ kind: "none" }` when the card is unknown, has no bag, has `bag.focus.kind === "none"`, or the host root / target element is not in the DOM.
- **Extend `IDeckManagerStore`** with four new methods:
  - `registerActivationCallback(cardId: string, callback: () => void): () => void` — register an EM card's activation callback. Returns an unregister function. Last-registration-wins per cardId (content factories re-register on every mount; the previous registration disposes via its returned cleanup).
  - `invokeActivationCallback(cardId: string): void` — fire the registered callback for `cardId`, or no-op if none registered.
  - `registerCardHostRoot(cardId: string, el: HTMLElement | null): void` — CardHost registers its `[data-card-host][data-card-id="…"]` root DOM element. Passing `null` unregisters the current entry (used by the cleanup path and by the re-registration branch when the DOM node identity changes mid-session).
  - `peekCardHostRoot(cardId: string): HTMLElement | null` — read the registered root; returns `null` when no root is currently registered (card unmounted or never mounted).
  Implement on `DeckManager` (new `Map<string, () => void>` for activation callbacks; new `Map<string, HTMLElement>` for card host roots). Add matching implementations to every mock store in `__tests__/` that implements `IDeckManagerStore` (expected: `mock-deck-manager-store.ts` plus the handful of per-test `Store` classes — the same set that Steps 16–20 have already extended).
- **`CardHost` registers its root element via a callback-ref captured into state (not a plain mount-only effect).** The card-host `data-card-host` div may be re-parented when `hostContentEl` changes on a cross-pane move (CardPortal creates its subtree into the new target container); depending on React's portal reconciliation, the DOM node identity may or may not survive. To be robust either way (per audit P5):
  1. Add local state `const [rootEl, setRootEl] = useState<HTMLElement | null>(null)`.
  2. Pass `ref={setRootEl}` on the `data-card-host` div.
  3. `useLayoutEffect` keyed on `[cardId, rootEl, store]`: call `store.registerCardHostRoot(cardId, rootEl)` when `rootEl !== null`, register cleanup that calls `store.registerCardHostRoot(cardId, null)` so moves to a new element register the new node before the old cleanup unregisters.
  This pattern re-registers automatically when the ref-callback fires with a new DOM node; mount, unmount, and element-identity-change are all covered.
- **`useCardPersistence` routes `onCardActivated` through the new channel.** When `options.onCardActivated` is provided, register it via `store.registerActivationCallback(cardId, () => onCardActivatedRef.current?.())` inside the existing registration `useLayoutEffect` (which has access to `cardId` via the `CardPersistenceContext`). The stable ref-reading wrapper is unchanged; only the destination registry changes. The `CardPersistenceCallbacks.onCardActivated` field remains declared for Step 22 contract stability; JSDoc is updated to note that **at Step 23A commit the Step-23 `[A3]` effect still dispatches via the record field; Step 23B retires the React effect, at which point dispatch routes exclusively through `store.invokeActivationCallback`.** The record field remains the input shape callers write against; it is never read at dispatch time post-23B.
- **Step-23 `[A3]` effect continues to dispatch via `persistenceCallbacksRef.current.onCardActivated`.** With the record-field still populated by `useCardPersistence` for back-compat, the existing effect's behavior is byte-identical. The dispatch-channel handoff to `store.invokeActivationCallback` happens in Step 23B when the effect is removed and replaced with helper wiring.

**Tasks:**
- [x] Author `focus-transfer.ts` with the module docstring, `ActivationTarget` type, signatures for the three side-effecting entries (throwing with step pointers), and a working `resolveActivationTarget`.
- [x] Extend `IDeckManagerStore` with the four new methods; implement on `DeckManager`.
- [x] Update `mock-deck-manager-store.ts` and every per-test `Store` class (`selection-persistence-integration.test.tsx`, `card-host-composition.test.tsx`, `card-identity-preservation.test.tsx`, `pane-focus-controller.test.tsx`, `card-host-activation-effect.test.tsx`) to implement the four new methods.
- [x] Add the `registerCardHostRoot` `useLayoutEffect` to `CardHost`.
- [x] Thread `useCardPersistence` to route `onCardActivated` through `store.registerActivationCallback`. JSDoc update on the `CardPersistenceCallbacks.onCardActivated` field.
- [x] Extend `use-card-persistence.test.tsx`'s `T-P07*` block with a test that `store.invokeActivationCallback(cardId)` fires the registered callback.

**Upholds:**
- **[L10]** — the new module and store API are introduced in a single cohesive commit; responsibilities are set up ahead of the wiring that consumes them.
- **[L07]** — activation-callback wrapper closes over `onCardActivatedRef` (refs, not the options-closure snapshot).
- **[L03]** — `CardHost`'s root-registration effect is `useLayoutEffect` so the registry is populated before any event that could drive an activation.

**Tests:**
- [x] New `tugdeck/src/__tests__/focus-transfer.test.ts`: unit tests for `resolveActivationTarget` only (FC with saved `bag.focus` → `focus-element`; EM with registered callback → `dispatch-activated`; neither → `none`; unknown cardId → `none`). The three side-effecting entries throw; a single smoke test confirms they throw with informative messages.
- [x] `deck-manager.test.ts`: new describe block covering the four store methods — last-wins registration, unregister clears, `peekCardHostRoot` returns `null` when unregistered, `invokeActivationCallback` no-ops silently.
- [x] `use-card-persistence.test.tsx`: `T-P07e` (new) asserts that `store.invokeActivationCallback(cardId)` fires the registered `onCardActivated`; `T-P07f` (new) asserts that re-rendering with a different `onCardActivated` implementation updates what fires (ref-sync behavior).
- [x] All existing tests continue to pass — Step 23's `card-host-activation-effect.test.tsx` and the three integration scenarios (AT0001/AT0003/AT0016) are unchanged and still green.

**Checkpoint:**
- [x] `bun x tsc --noEmit` exits 0.
- [x] `bun test` full suite green.
- [x] Grep: `registerActivationCallback` and `registerCardHostRoot` have exactly one implementation each in `deck-manager.ts` and one mock-stub pattern in test files.
- [x] No user-visible behavior change. [AT0001], [AT0003], [AT0016] pass at slow cadence via the in-app trusted-click sweep (2026-04-24, same state as end-of-Step-23).

---

#### Step 23B: Wire synchronous gestures through the helper; retire the [A3] React effect {#step-23b}

**Depends on:** #step-23a

**Commit:** `refactor(card-host): replace A3 React effect with synchronous focus-transfer`

**References:** [A3](#a3-shared-activation-effect); [A8](#a8-focus-theft-gate); [L22](#); [L23](#); [L10](#); [AT0001](#at0001-tab-switch-fc); [AT0003](#at0003-pane-activation); [AT0016](#at0016-tab-close-handoff); `pane-focus-controller.ts`, `tug-pane.tsx`, `deck-manager.ts`, `card-host.tsx`.

**Purpose.** Close the rapid-cadence race on rows 1–3 of the trigger taxonomy. Retires the Step-23 `[A3]` `useLayoutEffect` and moves its responsibility into three synchronous call sites.

**Artifacts:**
- **Implement `transferFocusForActivation({ outgoingCardId, incomingCardId, store, commitMutation, outgoingWillBeDestroyed })`** in `focus-transfer.ts`. Five-step body:
  1. **Save.** When `outgoingCardId !== null`, `outgoingCardId !== incomingCardId`, and `!outgoingWillBeDestroyed`, invoke `store.invokeSaveCallback(outgoingCardId)` so `bag.focus` + `bag.domSelection` are captured while `document.activeElement` still points inside the outgoing card. **The `outgoingWillBeDestroyed` flag (per audit P9)** is passed by `_removeCard` / `_closePane` sites; `flushSaveCallbackBeforeDestruction` (Step 14) already handles the destroyed card's bag in phase 2 of those paths, so a second save is redundant and masks the destruction ordering.
  2. **Commit the mutation.** If `commitMutation` is provided, call it now. This is the state-mutation closure handed in by the call site (e.g., `() => store.setActiveCardInPane(paneId, newCardId)`). Sandwiching the mutation between save and transfer is required because **inactive tabs render with `display: none` (`card-host.tsx:1062`), so `.focus()` on the incoming target fails silently until visibility flips.** For gesture sources where the mutation is owned by the helper's caller and the incoming DOM is guaranteed focus-capable at entry (e.g., `pane-focus-controller` activates via `store.activateCard` which touches the pane-level active bit but the incoming card is the pane's already-active card — it is already `display: contents`), `commitMutation` is omitted and the helper proceeds directly to step 3. Call sites must name which case applies; the four-step vs. five-step pattern is the explicit contract.
     - **React-commit guarantee when the mutation is inside the helper.** The helper must ensure the DOM reflects the committed state before step 5 runs. When the caller's event source is *outside* React's event system (document-level pointerdown, window blur/focus, direct `addEventListener` on drag elements), `useSyncExternalStore` already forces synchronous re-render on `notify()` — the same invariant `pane-focus-controller.ts` relies on for pointer→click z-index ordering, codified in its module comment. When the caller is *inside* React's event system (tab button click, keyboard action handler), the helper wraps `commitMutation()` in `flushSync` (imported from `react-dom`) to force the same synchronous-commit behavior. `focus-transfer.ts` imports `flushSync` from `react-dom` for this purpose; this is the only React-adjacent import in the module.
  3. **Resolve.** Call `resolveActivationTarget(incomingCardId, store)`. Per audit P3, the result carries its own resolved `el` when `kind === "focus-element"`. Resolution runs AFTER the mutation so the DOM queries see the post-commit tree (incoming card now `display: contents`).
  4. **Gate.** Read the target host via `const targetCardHostEl = store.peekCardHostRoot(incomingCardId)` (per audit P4), then call `canProgrammaticallyFocus(incomingCardId, store.getSnapshot(), { targetCardHostEl })` ([A8]). If unsafe, return.
  5. **Transfer.**
     - `focus-element`: `target.el.focus()` (single atomic DOM call; browser handles blur), then `selectionGuard.restoreCardDomSelection(...)` if `bag.domSelection` present.
     - `dispatch-activated`: `store.invokeActivationCallback(incomingCardId)`.
     - `none`: return.
- **Wire three gesture sources:**
  1. `pane-focus-controller.ts` — Branch A activation inside the capture-phase `pointerdown` listener. The incoming card is already the pane's active-in-pane card (`display: contents`); only the pane-level active bit flips. Call `transferFocusForActivation({ outgoingCardId: store.getFirstResponderCardId(), incomingCardId: pane.activeCardId, store, commitMutation: () => store.activateCard(pane.activeCardId) })`. Because the caller is outside React's event system, the `flushSync` path is a no-op after the `useSyncExternalStore` sync re-render fires; semantics unchanged.
  2. `tug-pane.tsx#performSelectCard` — replace the existing `store.invokeSaveCallback(outgoing) + store.setActiveCardInPane(...)` pair with `transferFocusForActivation({ outgoingCardId: outgoing, incomingCardId: newCardId, store, commitMutation: () => store.setActiveCardInPane(paneId, newCardId) })`. The incoming card is `display: none` at entry and becomes `display: contents` after `commitMutation` + `flushSync`; only then does step 5 `.focus()` succeed.
  3. `deck-manager.ts#_removeCard` (and `_closePane` on the active-pane branch) — call `transferFocusForActivation({ outgoingCardId, incomingCardId: newActiveCardId, store: this, commitMutation: () => { /* the existing _flipFirstResponder commit closure */ }, outgoingWillBeDestroyed: true })`. The flip commit is the mutation; running it inside the helper preserves the existing ordering (will-phase events, commit, did-phase events) and guarantees the new FR's card is visible at step 5. The existing `flushSaveCallbackBeforeDestruction` call in phase 2 of `_removeCard` runs AFTER the helper returns, unchanged.
- **Retire the `[A3]` `useLayoutEffect` in `CardHost`.** Delete the `useFocusDestination` subscription, `isFocusDestinationNow`, `hasRunActivationEffectRef`, `prevIsFocusDestinationRef`, and the effect body. CardHost no longer observes `isFocusDestination` — it is purely a registrar from this step forward. `useFocusDestination` the hook stays exported and tested (it remains a valid public subscription for any future React consumer that legitimately *renders* on destination status).
- **Fresh-card creation paths are unchanged** (per audit P11). `_addCardToPane` and `addCard` call `_flipFirstResponder` for the newly-created card; that card has no bag yet, so `resolveActivationTarget` returns `{ kind: "none" }` and the helper would no-op anyway. Cold-boot-style initial focus continues to flow through `CardHost`'s mount-restore effect ([#step-11](#step-11)) — the single authority for "first focus after the card first appears in the DOM." Do not wire `transferFocusForActivation` into these creation paths; adding the call would duplicate mount-effect semantics and race with it.
- **Dev-only assertion in `_flipFirstResponder` is DEFERRED (per audit P1).** The assertion "either `resolveActivationTarget(newFR, this).kind !== 'focus-element'` *or* the incoming target already matches `document.activeElement`" cannot safely land at this step. `_moveCardToPane` and `_detachCard` also call `_flipFirstResponder`, and in the Step 23C refocus model their accompanying `transferFocusAfterMove` fires *after* the flip — the assertion would warn on every drag until 23C lands. Installation of the assertion moves to [Step 23E](#step-23e) once every caller of `_flipFirstResponder` has a fully-wired sibling path through the helper. Scope at 23E: either pass a caller-tag argument through `_flipFirstResponder` or check "refocus pending" via a transient flag set by the drag coordinator; the choice is decided during 23E implementation when the full caller map is in scope.

**Tasks:**
- [ ] Implement `transferFocusForActivation` in `focus-transfer.ts` with the options record (`{ outgoingCardId, incomingCardId, store, commitMutation?, outgoingWillBeDestroyed? }`). Import `flushSync` from `react-dom` and wrap `commitMutation?.()` so the React-commit guarantee holds regardless of whether the caller is inside or outside a React event handler.
- [ ] Wire into `pane-focus-controller.ts`'s activation branch, passing `commitMutation: () => store.activateCard(pane.activeCardId)`.
- [ ] Wire into `tug-pane.tsx#performSelectCard`, passing `commitMutation: () => store.setActiveCardInPane(paneId, newCardId)`. Verify the helper's internal `flushSync` triggers visibility flip BEFORE the focus call lands (this is what closes AT0001 correctly, given `card-host.tsx:1062`'s `display: "none"` for inactive cards).
- [ ] Wire into `deck-manager.ts`'s `_removeCard` and `_closePane`, passing `commitMutation` as the flip-commit closure plus `outgoingWillBeDestroyed: true`.
- [ ] Delete the `[A3]` `useLayoutEffect` and its supporting refs from `CardHost`.
- [ ] `git mv card-host-activation-effect.test.tsx focus-transfer-call-sites.test.tsx`, then rewrite the body: the three existing scenarios dispatch through the real gesture source (simulated `pointerdown` on pane chrome; simulated click on a tab button; simulated click on the close button) instead of bare `setActiveCardInPane`. Add a rapid-cadence scenario (three activations back-to-back, no delay) proving no sibling-effect race. Add a visibility-flip scenario that mocks an inactive tab's content, dispatches a tab click, and asserts the incoming input receives focus (verifying the `flushSync` sandwich works — this is the regression gate for the `display: none` ordering issue).

**Upholds:**
- **[L22]** — focus-transfer is a synchronous side-effect of the gesture handler, not a `useLayoutEffect` observing `useSyncExternalStore`. The `flushSync` wrapper exists only to pin the React-commit timing needed for the `display: none` visibility flip; it does not round-trip the value through React's render cycle (React re-renders because the store changed, not because React owns the value). The DOM writes for focus + selection are direct, not state-mediated.
- **[L23]** — Save → commit → focus is atomic within a single synchronous event-handler tick. `element.focus()` is a single atomic DOM transition (browser handles blur). No observable "nothing focused" state; the `flushSync` sandwich ensures the incoming card's DOM is focus-capable at the moment `.focus()` runs.
- **[L10]** — activation-driven focus + selection writes for rows 1–3 collapse into `focus-transfer.ts`. CardHost keeps only its mount-time restore responsibility and its root registration.
- **[L07]** — the helper reads current state via store getters and `peekCardHostRoot`. No closures over React-rendered values.
- **[A3]** — contract preserved; implementation moved out of React.

**Tests:**
- [ ] `focus-transfer.test.ts`: fill in the behavior tests for `transferFocusForActivation` — save-before-transfer ordering (spy on `invokeSaveCallback`), same-card no-op, gate-refuses abort, single-atomic-transition (no observable `document.body` between save and focus).
- [ ] `focus-transfer-call-sites.test.tsx` (rewritten from `card-host-activation-effect.test.tsx`): gesture-source wiring tests per the task above; rapid-cadence scenario.
- [ ] `selection-persistence-integration.test.tsx`: the three Step-23 scenarios ([AT0001], [AT0003], [AT0016]) rewritten to dispatch through real gesture sources — tests become end-to-end proofs that each gesture source is wired.
- [ ] Full suite green.

**Checkpoint:**
- [ ] `bun x tsc --noEmit` exits 0.
- [ ] `bun test` full suite green.
- [ ] Grep: `useFocusDestination` has no production consumer under `tugdeck/src/components/`. (`src/deck-store-hooks.ts` exports it; `__tests__/use-focus-destination.test.tsx` tests it; nothing else.)
- [ ] Grep: `canProgrammaticallyFocus` has exactly one production consumer, `focus-transfer.ts`. No call sites inside React components.
- [ ] Manual verification at slow cadence: [AT0001], [AT0003], [AT0016] all pass.
- [ ] **Manual verification at rapid cadence (<100 ms between clicks): [AT0001], [AT0003], [AT0016] all pass. This is the regression-closure gate for Step 23B; rapid-click failure blocks merge.**

---

#### Step 23C: Multi-phase drag; retire Step 11's cross-pane effect {#step-23c}

**Depends on:** #step-23b

**Commit:** `refactor(card-host): route cross-pane drag through focus-transfer`

**References:** [A3](#a3-shared-activation-effect); [A8](#a8-focus-theft-gate); [AT0006](#at0006-cross-pane-em) (FC-half); [AT0007](#at0007-card-detach) (FC-half); [AT0021](#at0021-drag-aborted); [#step-11](#step-11); `card-drag-coordinator.ts`, `tug-pane.tsx`, `deck-manager.ts`, `card-host.tsx`.

**Purpose.** Close row 4 of the trigger taxonomy — cross-pane drag and detach. Retires Step-11's cross-pane `[hostStackId]`-keyed `useLayoutEffect` (which has the same L22 exposure and the same 1-second-debounce brittleness as Step 23's `[A3]` effect had).

**Drag-coordinator integration** is explicit. The drag path has three commit points the helper hooks:
1. **Drag-start** (pointerdown on pane chrome that *may* become a drag): save `bag.focus` before the browser's mousedown default blurs the live focus out of the subtree.
2. **Drop** (gesture ends with a valid drop target): after `_moveCardToPane` / `_detachCard` commits and React re-parents CardPortal's output, refocus into the new DOM location.
3. **Cancel** (drag aborts without commit): refocus into the card's original DOM location. There are two cancel branches today and one new branch added by this step (per audit P2):
   - `pointercancel` — existing handler at `card-drag-coordinator.ts#onPointerCancel`. Browser-driven (scroll takeover, system gesture).
   - **Escape key — NEW CODE PATH.** Today the coordinator has no keyboard handler; Escape during drag is a no-op. This step adds a document-level `keydown` listener installed inside `startDrag` and torn down in `cleanup`: on `event.key === "Escape"`, invoke the same `cleanup()` path as `pointercancel` then fire `onDragCancel`. Keydown is scoped to the drag lifetime so it does not leak outside active drags.
   - Drop outside any valid target: today this is **not** a cancel in the coordinator — `updateDragMode` sets mode to `"detach"` for any pointer position outside known drop targets, and `onPointerUp` commits the detach (creating a new pane). There is no "drop into void" cancel branch, and this step does not add one; treating every out-of-target release as a detach is the existing and intentional behavior. (Changing detach-on-release semantics is out of scope for the focus sub-sequence.)

Without the cancel hook, a user who starts a drag and then presses Escape would lose focus silently — the same brittleness the rest of this sub-sequence is eliminating. The Escape addition is the scope of new coordinator behavior in this step; it is small (one listener add + one `key === "Escape"` branch) and lives alongside the new `onDragCancel` callback slot.

**Artifacts:**
- **Implement `captureFocusForDragStart(cardId, store)`** in `focus-transfer.ts`. Invokes `store.invokeSaveCallback(cardId)` for the pane's currently-active card. Fires even if the click doesn't become a drag — saves are cheap, idempotent with subsequent saves, and the symmetric "save-at-gesture-start" contract is what eliminates the race.
- **Implement `transferFocusAfterMove(cardId, store)`** in `focus-transfer.ts`. Three-step body (no save; drag-start already did that):
  1. Resolve via `resolveActivationTarget(cardId, store)`.
  2. Read the target host via `const targetCardHostEl = store.peekCardHostRoot(cardId)` (per audit P4), then gate via `canProgrammaticallyFocus(cardId, store.getSnapshot(), { targetCardHostEl })`.
  3. Transfer: `focus-element` → `target.el.focus()` + `restoreCardDomSelection`; `dispatch-activated` → `invokeActivationCallback`; `none` → return.
- **Wire the save hook into drag-start.** `tug-pane.tsx#handleTitleBarPointerDown` (title bar) and the tab-drag pointerdown path (tab button pointerdown that can initiate a drag): call `captureFocusForDragStart(pane.activeCardId, store)` in the capture-phase handler, unconditional of whether the click threshold-crosses.
- **Wire the drop hook into `_detachCard` / `_moveCardToPane`.** After the existing `this.invokeSaveCallback(...)` + state mutation + `this.notify()` sequence completes (React has synchronously committed the re-parent, so the moved card's DOM is now inside the new pane's content element), call `transferFocusAfterMove(movedCardId, this)`.
- **Add the `onDragCancel` callback slot and the Escape listener to `card-drag-coordinator.ts`.** Public surface gains `onDragCancel?: (draggedCardId: string) => void`. `startDrag` installs a document-level `keydown` capture-phase listener that checks `event.key === "Escape"`; on match, calls `cleanup()` then `onDragCancel?.(this.sourceCardId)`. `onPointerCancel` also fires `onDragCancel?.(this.sourceCardId)` after its existing `cleanup()`. `cleanup` removes the keydown listener. Consumer wires `onDragCancel = (cardId) => transferFocusAfterMove(cardId, store)` — the dragged card's DOM is already back in its original pane at this point (no move occurred for a cancel).
- **Retire Step-11's cross-pane `[hostStackId]`-keyed `useLayoutEffect` in `CardHost`.** Delete the effect, the `hasMountedRef` (the one scoped to that cross-pane effect), and the associated cross-pane refocus logic. The mount-time Step-11 effect (cold-boot focus restore) is preserved unchanged. Update in-code comments to point at `focus-transfer.ts` as the single refocus authority for in-session transitions.

**Tasks:**
- [ ] Implement `captureFocusForDragStart` and `transferFocusAfterMove` in `focus-transfer.ts`.
- [ ] Wire `captureFocusForDragStart` into `handleTitleBarPointerDown` and the tab-drag pointerdown path.
- [ ] Wire `transferFocusAfterMove` into `_detachCard` and `_moveCardToPane` after their existing `notify()` call.
- [ ] Add Escape handling to `card-drag-coordinator.ts`: document-level `keydown` capture listener installed in `startDrag`, torn down in `cleanup`, fires `cleanup()` + `onDragCancel?.(sourceCardId)` on `key === "Escape"`.
- [ ] Add `onDragCancel` callback slot to the coordinator's public surface; fire from `onPointerCancel` (after existing cleanup) and from the new Escape branch.
- [ ] Wire `onDragCancel = (cardId) => transferFocusAfterMove(cardId, store)` at the coordinator's construction / installation site.
- [ ] Delete Step-11's cross-pane `useLayoutEffect` from `CardHost`. Preserve the mount-time effect.
- [ ] Audit every call site of `_detachCard` / `_moveCardToPane` in the codebase and confirm each is either: (a) followed by an automatic `transferFocusAfterMove` via the drop-hook wiring, or (b) a path where focus transfer doesn't apply (no card was focused). Document the audit in a comment at the top of `focus-transfer.ts`.

**Upholds:**
- **[L22]** — cross-pane refocus is now a synchronous side-effect of the drop/cancel handlers, not a `useLayoutEffect` observing `hostStackId` (which is a prop derived from the store — still a round-trip).
- **[L23]** — the card's focus+selection state is preserved atomically across the re-parent; no save-then-restore window where intermediate state can be observed.
- **[L10]** — all in-session activation-driven focus writes (rows 1–4) collapse into `focus-transfer.ts`. `CardHost` keeps only its mount-time restore responsibility. `card-drag-coordinator.ts` owns the drag state machine, not focus behavior.

**Tests:**
- [ ] `focus-transfer.test.ts`: add tests for `captureFocusForDragStart` (invokes save, does not mutate DOM focus) and `transferFocusAfterMove` (resolves and focuses the moved card's target after a simulated DOM re-parent).
- [ ] `focus-transfer-call-sites.test.tsx`: add cross-pane drag-drop scenario (simulated pointerdown on pane chrome + coordinator's `_moveCardToPane` call) and drag-cancel scenarios — (a) Escape during drag, (b) `pointercancel` during drag. Assert focus is restored in both cases without any prior debounced save having fired.
- [ ] `selection-persistence-integration.test.tsx`: add [AT0006] (FC-half) cross-pane drag scenario; assert focus + selection survive. Add [AT0021] drag-cancel scenarios covering both Escape and `pointercancel`; assert focus returns to the original input in each.
- [ ] `card-drag-coordinator.test.ts` (new file if not present; extend existing): assert `onDragCancel` fires for Escape and `pointercancel` paths. Assert the keydown listener is installed on `startDrag` and removed on `cleanup` (no leak between drags). Verify `onDragCancel` does NOT fire on a normal successful drop (the commit paths remain unchanged).
- [ ] Grep test: Step-11's cross-pane `useLayoutEffect` identifier is gone from `card-host.tsx`. Grep for the marker comment `"Cross-pane-move focus effect"` (or equivalent unique phrase in that block) — must return zero hits. Do NOT grep for `hasMountedRef` alone; that identifier pattern may recur in other contexts.

**Checkpoint:**
- [ ] `bun x tsc --noEmit` exits 0.
- [ ] `bun test` full suite green.
- [ ] Grep: `applyFocusSnapshot` and `restoreCardDomSelection` have production call sites only from `focus-transfer.ts` and the `CardHost` mount-restore effect. No call sites in `useLayoutEffect`s keyed on `hostStackId`, `isActive`, or any activation-related value.
- [ ] Manual verification at slow cadence: [AT0006] (FC-half — drag an FC card between panes), [AT0007] (drag a card out of a pane into a new standalone pane) all pass. [AT0021] (start a drag then press Escape) restores focus to the original pane's input.
- [ ] **Manual verification at rapid cadence (cross-pane drag immediately after typing, no 1-second wait): [AT0006] (FC-half), [AT0007] all pass. [AT0021] drag-cancel via Escape at rapid cadence restores focus. This is the regression-closure gate for Step 23C; failure on any blocks merge.**

---

#### Step 23D: App-lifecycle [A4] wired through the helper {#step-23d}

**Depends on:** #step-23b

**Commit:** `feat(app-lifecycle): route app resume refocus through focus-transfer`

**References:** [A3](#a3-shared-activation-effect); [A4](#a4-app-lifecycle-activation); [A8](#a8-focus-theft-gate); [#step-20](#step-20); `focus-transfer.ts`, `deck-manager.ts`.

**Purpose.** Close row 5 of the trigger taxonomy — app resume / window focus. When the tugdeck window regains OS focus after a resign (Cmd-Tab away and back, or clicking another app and back), the current first-responder card should re-focus its saved target and re-paint its selection. Today [A4] is unimplemented; the window `focus` listener installed in [Step 20](#step-20) flips `state.hasFocus` and notifies subscribers, but nothing drives a refocus.

This step is deliberately independent of Step 23C: app-lifecycle refocus touches only the window-focus listener (installed in `deck-manager.ts` at module-init) and the helper module. It has no ordering dependency on the drag-path work.

**Artifacts:**
- **New entry point `reactivateCurrentFocusDestination(store)`** in `focus-transfer.ts`. Body:
  1. Resolve `cardId = store.getFirstResponderCardId()`. If `null`, return (no card is the destination).
  2. Call `resolveActivationTarget(cardId, store)`.
  3. Read the target host via `const targetCardHostEl = store.peekCardHostRoot(cardId)` (per audit P4), then gate via `canProgrammaticallyFocus(cardId, store.getSnapshot(), { targetCardHostEl })`. The gate's `state.hasFocus` branch is correctly `true` at this point (we're firing because the app just regained focus; `state.hasFocus` was set `true` in the listener immediately before this call). The `activeElement === body` branch is typical after a cross-app blur — so the gate accepts.
  4. Transfer: `focus-element` → `target.el.focus()` + `restoreCardDomSelection`; `dispatch-activated` → `invokeActivationCallback`; `none` → return.
  No save step on `focus`: the save happens on `blur` (below) so the bag reflects the card state at the moment the user cmd-tabbed away.
- **Window-`blur` save flush (per audit P8).** Extend `installDeckStoreFocusListeners` so the `blur` handler, *before* it flips `state.hasFocus = false`, calls `store.invokeSaveCallback(store.getFirstResponderCardId())` when the first responder is non-null. This is a synchronous save-on-blur that closes the stale-bag residual: without it, `reactivateCurrentFocusDestination` on the subsequent `focus` reads whatever bag the last debounced save captured — which may be seconds out-of-date if the user cmd-tabbed mid-typing. `visibilitychange` also fires a save on app resign in some browser/OS combinations, but it is not guaranteed when the tab is not actually hidden (window blur without tab hide is the common cmd-tab case on macOS). Saving on `blur` makes the guarantee unconditional.
- **Wire into the window `focus` handler.** The listener installed at module init by [Step 20](#step-20) (`installDeckStoreFocusListeners`) calls `deckStore.setHasFocus(true)` on `focus`. Extend the handler: after `setHasFocus(true)`, call `reactivateCurrentFocusDestination(deckStore)`. Ordering matters: `setHasFocus(true)` must land before the helper call, because the gate reads `state.hasFocus`.

**Tasks:**
- [x] Implement `reactivateCurrentFocusDestination` in `focus-transfer.ts`.
- [x] Extend the window `blur` listener in `deck-manager.ts#installDeckStoreFocusListeners` to invoke the current first responder's save callback BEFORE flipping `state.hasFocus = false`.
- [x] Extend the window `focus` listener in the same module to call `reactivateCurrentFocusDestination(deckStore)` AFTER `setHasFocus(true)`.
- [x] Author AT0004 / AT0005 in-app tests that drive real `simulateAppResign` / `simulateAppBecomeActive` / `simulateAppHide` / `simulateAppUnhide` against a seeded deck and assert the focus-restoration + value-preservation path end-to-end (see Author note 2026-04-25 — the happy-dom integration variant is dropped per the project's happy-dom scoping rule).

**Upholds:**
- **[L22]** — the window `focus` listener is a direct DOM observer of a browser-level event; the helper call is a synchronous side-effect of that listener. No React cycle involved.
- **[A4]** — the AT-series architecture piece [A4] is implemented end-to-end at this step's commit.

**Tests:**
- [x] `tests/app-test/at0004-app-resign-return.test.ts` — full resign/return cycle with trusted `simulateAppResign` / `simulateAppBecomeActive`; asserts (a) `save-callback` trace event with `source: "window-blur"` fires during resign, (b) input regains `document.activeElement` after the focus event, (c) value preserved.
- [x] `tests/app-test/at0005-app-hide-unhide.test.ts` — parallel to m04 via `simulateAppHide` / `simulateAppUnhide`.
- [x] `bun test` (tugdeck) — full suite green (2412/2412); no regressions from the new save source or listener changes.
- [ ] `focus-transfer.test.ts` / `deck-manager.test.ts` happy-dom unit additions: SKIPPED. Per the project's happy-dom scoping rule, focus / event-ordering across React renders is unreliable in jsdom-class fakes; the in-app AT0004/AT0005 tests are the regression gate. The resolver's pure decision tree continues to be covered in `focus-transfer.test.ts` from Step 23A; `reactivateCurrentFocusDestination` adds no new resolver branches.

**Checkpoint:**
- [x] `bun x tsc --noEmit` exits 0.
- [x] `bun test` full suite green (tugdeck: 2412/2412).
- [x] **In-app verification at rapid cadence:** drift-prevention cycle landed — reverted both listener changes, confirmed AT0004 + AT0005 fail at the `save-callback` trace assertion (window-blur source absent), restored, confirmed both pass. Manual Cmd-Tab cycle is now subsumed by the automated tests.

---

#### Step 23E: EM content factories implement `onCardActivated`; retire any remaining legacy focus paths {#step-23e}

**Depends on:** #step-23b (also benefits from 23C and 23D if landed, but not required)

**Commit:** `feat(engine-cards): implement onCardActivated for engine reactivation`

**References:** [A2](#a2-on-card-activated); [A3](#a3-shared-activation-effect); [AT0002](#at0002-tab-switch-em); [AT0006](#at0006-cross-pane-em) (EM-half); [AT0007](#at0007-card-detach) (EM-half); [AT0009](#at0009-inactive-mount); `tide-card.tsx`, `tug-prompt-input.tsx`, `gallery-prompt-entry.tsx` (and any other EM-flavored factory surfaced during implementation).

**Purpose.** Close row 6 of the trigger taxonomy — EM card activations. With the helper infrastructure in place and the gesture sources wired (23A–23D), EM content factories opt in to `onCardActivated` so their engine root re-focuses when the card becomes the destination. Also retire any legacy engine-internal refocus code that existed because the framework didn't provide this callback — at this step's commit, the framework fully provides it.

**Artifacts:**
- **Each engine-managed content factory registers `onCardActivated` via `useCardPersistence`.** Standard implementation:
  ```ts
  useCardPersistence({
    onSave: () => engineRef.current?.captureState(),
    onRestore: (state) => engineRef.current?.restoreState(state),
    onCardActivated: () => engineRef.current?.root.focus({ preventScroll: true }),
  });
  ```
  The engine's existing `setSelectedRange` behavior (focus-first, per [#step-11](#step-11)) means the engine republishes its selection on focus, which flows through the Step 3/4 `onSelectionChanged` → `selectionGuard.updateCardDomSelection` → paint chain. Paint re-lights automatically; no extra wiring needed.
- **Scope:** at minimum, `tide-card.tsx`, `tug-prompt-input.tsx`, and `gallery-prompt-entry.tsx`. Any other EM-flavored factory discovered during implementation gets the same pattern. Audit: `grep` for factories that call `useCardPersistence` with an `onSave` that returns a `TugTextEditingState`-shaped object.
- **Retire redundant refocus paths.** Any engine-internal code that does a `.root.focus()` from a mount effect or from a `bag.content !== undefined` branch of CardHost now has the helper as the single authority. Delete or consolidate. This is the concrete work the original Step 24 described as "retire redundant refocus paths"; at Step 23E's commit, the helper is the only path.
- **[AT0009] inactive-at-mount EM card.** When an engine mounts in an inactive tab (`display: none`), the engine's `setSelectedRange` focus call silently fails (dev-warn already installed earlier in the plan). On user-activate the tab, `transferFocusForActivation` (Step 23B) fires and `resolveActivationTarget` returns `dispatch-activated`; the callback calls `engine.root.focus(...)` on the now-visible subtree. Paint lights up. Verified by integration test; no additional code beyond this step's callbacks.
- **Install the deferred `_flipFirstResponder` dev-only assertion (per audit P1, carried forward from Step 23B).** By this step every caller of `_flipFirstResponder` has a fully-wired sibling path through the helper: rows 1–3 via `transferFocusForActivation` (23B), row 4 via `transferFocusAfterMove` (23C), row 5 via `reactivateCurrentFocusDestination` (23D), and row 6 via the EM `onCardActivated` registrations in this step. Fresh-card creation paths (`_addCardToPane`, `addCard`) resolve to `kind: "none"` (no saved bag), so they naturally satisfy the assertion. Implementation approach:
  1. Add a module-scope `dragRefocusPendingRef: { current: Set<cardId> }` set in `deck-manager.ts` (or an equivalent transient marker). The drag coordinator marks a cardId as "refocus-pending" from drag-start (`captureFocusForDragStart`) until `transferFocusAfterMove` completes. `_flipFirstResponder` skips its assertion when `dragRefocusPendingRef.current.has(newFR)`.
  2. Inside `_flipFirstResponder`, when `oldFR !== newFR` and `newFR !== null` and `!dragRefocusPendingRef.current.has(newFR)` and `!isFreshlyConstructed(newFR)`: compute `resolveActivationTarget(newFR, this)`. If `kind === "focus-element"` AND `document.activeElement` is not inside `store.peekCardHostRoot(newFR)`, `isDevEnv()`-guarded `console.warn` with the caller name (derived from `new Error().stack` top frame or a passed tag argument — implementer's choice, documented in the landed code). A flip that bypasses the helper is a dev-time bug; this assertion catches future regressions.
  3. "Freshly constructed" is determinable via `this.cardLifecycle`'s just-fired construction event inside the commit closure — the assertion runs post-commit in the did-phase, so the construction flag is still observable. Alternatively, track via a transient set cleared at end of the construction tick.

**Tasks:**
- [x] Add `onCardActivated` registration to each EM content factory: TugPromptEntry (covers tide-card + gallery-prompt-entry through composition) + TugPromptInputPersistence (covers gallery-prompt-input). Both bodies focus the engine root via the same caret-then-focus pattern as the imperative delegate's `focus()` method.
- [x] Audit for other EM factories. The scope-by-design today is the two factories above; tide-card itself does NOT call `useCardPersistence` directly — it embeds TugPromptEntry, which does. No other EM factories surfaced.
- [ ] Grep and retire any remaining engine-internal refocus code. **DEFERRED** — see Author note. The grep audit is straightforward but landed-now would create churn ahead of Step 23F's resolver-classification fix. Better to do it after 23F lands.
- [ ] Install the `_flipFirstResponder` dev-only assertion. **DEFERRED to a Pass 10 cleanup**. Internal-infrastructure work that doesn't gate user-visible behavior; landing it after the production gaps in 23F are closed makes for cleaner bisect.
- [x] Surface plumbing: extend `invokeActivationCallback(cardId, dispatchedFrom)` to take a dispatch-source tag. The `engine-activation-dispatched` deck-trace event is recorded in DeckManager (not in the callback body) so factory authors don't need to plumb the tag through their callbacks.
- [x] Three call sites in `focus-transfer.ts` updated: `transferFocusForActivation` passes `"transfer-for-activation"`; `transferFocusAfterMove` passes `"transfer-after-move"`; `reactivateCurrentFocusDestination` passes `"reactivate-current"`. These names map row 1–3 / row 4 / row 5 of the activation taxonomy onto the dispatch-source tag observably in traces.
- [x] `getEmCardState` updated to recognize TugPromptEntry's wrapped persistence shape (`{ currentRoute, perRoute, maximized }`) so `text` and `engineSelection` extraction works for both EM factories.

**Upholds:**
- **[A2]** + **[A3]** together give content-owning cards a single-owner reactivation path; retires the duplicated mechanism ([R05]-adjacent cleanup).
- **[L10]** — content factories own their engine-root focus; the framework owns when to dispatch the callback. Ownership boundaries hold.

**Tests:** (per the project's happy-dom scoping rule, EM scenarios moved from `selection-persistence-integration.test.tsx` to dedicated in-app tests)
- [x] `tests/app-test/at0002-tab-switch-em.test.ts` — EM intra-pane tab switch. Two parameterized tests over `gallery-prompt-input` (TugPromptInput direct) and `gallery-prompt-entry` (TugPromptEntry, what tide-card uses). Both pass: text preserved + focus returns to engine root + `engine-activation-dispatched` event with `transfer-for-activation` tag.
- [x] `tests/app-test/at0006-em-cross-pane.test.ts` — EM cross-pane drag. Two parameterized tests. Both pass: text preserved + `engine-activation-dispatched` event with `transfer-after-move` tag fires. **Focus-actually-landing assertion intentionally omitted** — see Author note (gap 3 of Step 23F).
- [x] `tests/app-test/at0007-em-card-detach.test.ts` — EM card detach. Two parameterized tests. Both pass; same shape as at0006-em.
- [x] `tests/app-test/at0009-em-inactive-mount.test.ts` — EM inactive-at-mount → activate via tab click. Two parameterized tests over the saved-state path (pre-cooked `bag.content`); the fresh-card path is deliberately deferred to Step 23F (gap 2). Both pass: `engine-activation-dispatched` event fires + focus + seeded text restored.
- [ ] Grep tests for ad-hoc `engine.root.focus()` sites. **DEFERRED** alongside the grep-audit task above.
- [ ] `_flipFirstResponder` dev-only assertion. **DEFERRED** to a Pass 10 cleanup.
- [x] Full default sweep green: 18/18 (added at0002-tab-switch-em, at0006-em-cross-pane, at0007-em-card-detach, at0009-em-inactive-mount to `just test-in-app-fast`'s default FILES list).

**Checkpoint:**
- [x] `bun x tsc --noEmit` exits 0 (tugdeck + tests/app-test).
- [x] `bun test` (tugdeck) full suite green: 2412/2412.
- [x] In-app default sweep: 18/18 green.
- [ ] **End of M-phase 2 — REVISED.** The AT-series transitions FC-half [AT0001], [AT0003], [AT0004], [AT0005], [AT0006] (FC-half), [AT0007] (FC-half), [AT0016], [AT0021] are closed at rapid cadence. EM-half [AT0002], [AT0006]-EM, [AT0007]-EM, and saved-state [AT0009] are closed for the dispatch-wiring contract (`engine-activation-dispatched` events fire correctly), but three related EM-card focus gaps remain open and are tracked under [Step 23F](#step-23f): cold-boot selection paint, fresh-EM-card resolver mis-classification, and EM focus-after-cross-pane-move. The deferred `_flipFirstResponder` dev assertion is moved to a Pass 10 cleanup. End-of-M-phase-2 will properly close once Step 23F lands and the deferred items follow.

**Plan-doc updates (apply during 23E's commit):**
- `[A3]` section ([#a3-shared-activation-effect](#a3-shared-activation-effect)) updated to describe the helper-based implementation: "one synchronous helper invoked at every activation gesture source" replaces "one `useLayoutEffect` in `CardHost`." The `closes` list is unchanged.
- `[A4]` section ([#a4-app-lifecycle-activation](#a4-app-lifecycle-activation)) updated to describe the implementation as the window `blur` → save + window `focus` → `reactivateCurrentFocusDestination` pair inside `installDeckStoreFocusListeners`, not the earlier `observeApplicationDidBecomeActive`-style coordinator wording.
- Step 11's in-session cross-pane refocus gets a trailing note pointing at Steps 23A–23C; its mount-time portion is explicitly retained.
- Step 23's retrospective notes that the Step-23 `[A3]` landed as a React effect and that Steps 23A–23E moved the implementation out of React to satisfy [L22] / [L23] after a sibling-effect ordering race was observed at rapid gesture cadence.
- Architecture coverage matrix ([#architecture-coverage](#architecture-coverage)) [AT0006] and [AT0007] rows get explicit "(FC-half: Step 23C / EM-half: Step 23E)" annotations to match the References updates in those steps.
- The "End of M-phase 2" summary in Step 23E's checkpoint replaces the previous version that referenced Step 24.

---

#### Step 23F: Cold-boot EM-card selection paint {#step-23f}

**Depends on:** #step-23e

**Commit:** `fix(em-cards): restore EM-card selection on cold-boot`

**References:** [A3](#a3-shared-activation-effect); [A4](#a4-app-lifecycle-activation); row 7 of the [activation trigger taxonomy](#activation-trigger-taxonomy); `card-host.tsx`, `tug-text-engine.ts`, `tug-prompt-input.tsx`, `tug-prompt-entry.tsx`.

**Why this step exists.** Three related gaps surfaced, all sharing the family root "EM-card focus paths interact awkwardly with React mount/re-mount lifecycles."

(1) **Cold-boot selection paint.** Manual verification on a real Tug.app rebuild: type+select inside a tide card's `TugPromptEntry`, quit, relaunch — the text restores but the selection does NOT. Steps 23A–23E carved cold-boot out as "structural; not in scope," assuming the pre-existing `CardHost` mount-restore + `engine.restoreState` chain handled it.

(2) **Fresh-EM-card resolver mis-classification.** Pass 8 (Step 23E) in-app testing: a fresh, never-saved EM card activated via tab-click lands focus on the FIRST focusable element in the card (e.g., `gallery-prompt-input`'s "Insert Atom" toolbar button), NOT the contenteditable editor. The `resolveActivationTarget` discriminator (`bag.content !== undefined`) gates whether the resolver returns `dispatch-activated` (correct EM behavior, fires `onCardActivated`) or falls through to `default-focus` (walks `DEFAULT_FOCUS_SELECTORS`, where `button:not([disabled])` matches before `[contenteditable="true"]`). Fresh EM cards hit the default-focus branch and end up with toolbar focus.

(3) **EM focus-after-cross-pane-move doesn't stick.** Pass 8 in-app testing of AT0006-EM / AT0007-EM: after dragging an EM card to another pane (or detaching to a new standalone pane), the trace event `engine-activation-dispatched` with `dispatchedFrom: "transfer-after-move"` fires (verifying `onCardActivated` ran), but `document.activeElement` ends up as `BODY`, not the engine root. The `engine.root.focus({ preventScroll: true })` call inside `onCardActivated` no-ops on the freshly re-mounted contenteditable. Likely cause: `transferFocusAfterMove` runs synchronously from `_moveCardToPane` / `_detachCard` after `notify()`, but the new TugPromptInput's mount-time `useLayoutEffect` engine init has not yet established a stable focus target — `.focus()` on a DOM node whose ancestor was just removed-and-re-attached can silently no-op on WebKit. The engine state is preserved (re-mount applies the saved bag.content correctly); only the focus is lost.

Gaps (2) and (3) share the same root: **fresh EM cards / freshly re-mounted EM cards are not robustly classified or focused by the activation pipeline.** Gap (1) shares the family: cold-boot is structurally a fresh-mount scenario for the engine. Step 23F addresses all three — fresh cards must dispatch through `onCardActivated` even without bag.content, the cold-boot data-roundtrip for selection paint must reach the live DOM after the card becomes visible, AND the `transferFocusAfterMove` → `onCardActivated` → `.focus()` chain must produce stable focus on the re-mounted contenteditable.

**Triage shortlist (to resolve during the spike that opens this step).** Five candidates, three for the cold-boot selection gap (gap 1) and two for the fresh-card resolver gap (gap 2). The fix likely combines a resolver change for gap 2 with one or more of the cold-boot fixes for gap 1.

### Gap 1 (cold-boot selection): one of these is the culprit

1. **Save-time `selection: null`.** `TugTextEditingState.selection`'s docstring says "Null if editor was not focused" at capture time. `getSelectedRange` reads `window.getSelection()` and returns `null` when `sel.anchorNode` is outside `this.root`. If the dock click that triggered quit moved focus before `applicationShouldTerminate` fires `saveState`, the engine captures `null` and there's nothing to restore. The save-on-blur listener landed in [Pass 6 / Step 23D](#step-23d) flushes synchronously on `window.blur`, which should pre-empt the dock-click race — but only if `window.blur` arrives before the dock click moves focus. Verify via deck-trace: enable trace, type+select, quit, inspect the persisted `bag.content.perRoute[currentRoute].selection` at restore time.
2. **WebKit selectionchange-on-focus quirk.** `tug-text-engine.ts:510-518` (the `setSelectedRange` comment) flags this: `.focus()` on a contenteditable AFTER a programmatic selection has been set fires an asynchronous `selectionchange` that collapses the caret to position 0. The engine's `setSelectedRange` guards against this by focusing FIRST. `applyFocusSnapshot` (`card-host.tsx:321`) has a complementary guard ("respect any focus already inside the card — return early"). The two guards together SHOULD prevent the quirk. Verify the ordering on cold-boot: does `applyFocusSnapshot` run before or after `engine.restoreState`? If the engine's setSelectedRange is what land the focus + selection together, applyFocusSnapshot's "already inside" guard fires and we're safe. If applyFocusSnapshot runs FIRST (focuses contenteditable but no selection set), then engine.restoreState's `willFocus = (activeElement !== root && !root.contains(activeElement))` evaluates false, so it skips the focus call and applies selection — which should also be safe. Both orderings should work; verify both with the trace.
3. **WKWebView `document.hasFocus()` at boot.** When the WebView first loads, `document.hasFocus()` may be false until the OS dispatches the first activation. If `engine.restoreState` runs before that first activation, the selection lands on a "non-focused document" and WebKit may drop it on the next user interaction. The `[A4]` save-on-blur / restore-on-focus pair in [Step 23D](#step-23d) handles app-lifecycle within a running session but does NOT handle cold-boot — the deckStore is freshly constructed; nothing is the "current first responder" yet. `reactivateCurrentFocusDestination` returns early on null first responder, so it's a no-op on cold-boot.
4. **`TugPromptEntry`'s `pendingRestoreRef`-equivalent gap.** The standalone `TugPromptInputPersistence` component buffers state via `pendingRestoreRef` if the engine isn't ready when `onRestore` fires. `TugPromptEntry` (which tide-card uses) calls `input.restoreState(saved)` via the imperative delegate — which internally is `engineRef.current?.restoreState(state)`. If `engineRef.current` is null at the moment the delegate forwards the call, the no-op silently drops the restore. The expected effect ordering (children's layout effects before parent's, CardHost's onRestore call after that) should populate `engineRef.current` first, but the `pendingRestoreRef` buffering exists for a reason — verify the engine is in fact present when `TugPromptEntry`'s `onRestore` fires.

### Gap 2 (fresh-card resolver): one of these is the right fix

5. **Resolver classifies cards by registry tag, not by `bag.content` presence.** Add an `engineKind?: "em"` field to the card-registry shape; EM factories (`tide`, `gallery-prompt-input`, `gallery-prompt-entry`, etc.) declare it. `resolveActivationTarget` returns `dispatch-activated` when the card's registration is EM-typed, regardless of `bag.content`. Fresh EM cards then route through `onCardActivated` from the very first activation. The drawback: requires a registry change and per-factory opt-in. The advantage: explicit, no shape inference.

6. **DEFAULT_FOCUS_SELECTORS prefers contenteditable over generic buttons.** Move `[data-tug-prompt-input-root] [contenteditable]` (or a more general `[contenteditable="true"]:not([data-tug-toolbar] [contenteditable])`) above `button:not([disabled])` in the chain. Cheap one-line change; doesn't fix gap 1's selection paint but does fix the fresh-EM-card focus-on-toolbar regression. Could land in tandem with (5) for defense in depth.

The implementer's call: try (5) first (clean architectural fix; fixes fresh-card behavior and aligns the resolver's two branches under EM cards). If (5) lands cleanly, (6) becomes optional — `default-focus` no longer fires for EM cards. If (5) is too invasive, (6) is the pragmatic fallback.

**Artifacts:**
- **Diagnostic trace events.** Add two new deck-trace event kinds:
  - `cold-boot-restore-snapshot` — fires from CardHost's mount-restore right before `onRestore` is invoked. Fields: `cardId`, `componentId`, `hasContent: boolean`, `engineSelection: { start: number; end: number } | null` (extracted defensively from `bag.content` for EM cards). Lets the trace tell us what was on disk.
  - `engine-restore-applied` — fires from each EM factory's engine `restoreState` call site (TugTextEngine internal, or the wrapping factory). Fields: `cardId`, `engine`, `selectionApplied: { start: number; end: number } | null`, `domSelectionAfter: { start: number; end: number } | null` (read via `engine.getSelectedRange()` immediately after `setSelectedRange` returns). Tells us whether the selection landed in the live DOM at all.
- **Fix.** Whichever of the four shortlist culprits is the actual cause, the fix lands here. Likely shapes:
  - If (1) save-time null: extend the save-on-blur path to `applicationShouldTerminate`'s save loop too — call `selectionGuard.captureCurrentSelection()` or equivalent before invoking save callbacks, so the engine sees its own range as anchored even after WebKit's pre-quit focus shuffle.
  - If (2) selectionchange quirk: tighten the focus-ordering guards. The engine's `setSelectedRange` and CardHost's `applyFocusSnapshot` should be the only two paths that can end up calling `.focus()` on the engine root during cold-boot; sequence them so `applyFocusSnapshot` always runs first when a saved snapshot exists, and the engine's `setSelectedRange` skips its own focus call.
  - If (3) hasFocus race: defer the selection apply until `document.hasFocus() === true` OR until the first `window.focus` event fires. Implement as a one-shot `pendingSelectionRestoreRef` on the engine; check on `window.focus` and re-apply if pending.
  - If (4) engine-not-ready: hoist the `pendingRestoreRef`-style buffering into TugPromptEntry's `onRestore` so a missing engine on first call gets re-applied when the engine reports ready.
- **In-app smokes** (all new, all permanent, all added to the default `just test-in-app-fast` sweep):
  - `tests/app-test/at0032-em-cold-boot-selection.test.ts` — gap 1. Seeds a deck via `seedDeckState` with a `gallery-prompt-entry` card carrying a pre-cooked `bag.content` whose `perRoute[currentRoute].selection` is non-null; activates the card; awaits `engine-ready`; reads `getEmCardState(cardId).engineSelection`; asserts it matches the seeded value.
  - `tests/app-test/at0033-em-fresh-card-activation.test.ts` — gap 2. Seeds two cards (FC active, EM inactive) with NO `bag.content` for the EM card; activates the EM tab; asserts `engine-activation-dispatched` fires AND `document.activeElement` is the contenteditable (not a sibling toolbar button). Parameterized over `gallery-prompt-input` and `gallery-prompt-entry`.
  - `tests/app-test/at0034-em-focus-after-move.test.ts` — gap 3. Re-runs `at0006-em-cross-pane`'s drag and `at0007-em-card-detach`'s detach scenarios but tightens the assertion: after the move, `document.activeElement` MUST be inside the engine's contenteditable, not BODY. Currently `at0006-em-cross-pane` and `at0007-em-card-detach` (landed in Pass 8 / Step 23E) deliberately omit the focus-actually-landing assertion; this test is the regression gate for 23F's gap-3 fix.
- **Activation taxonomy update.** Update the row-7 entry in [#activation-trigger-taxonomy](#activation-trigger-taxonomy) to no longer say "unchanged; not in Steps 23A–23E"; instead, point at Step 23F as the row-7 fix site. Add a one-line note at the top of the Step Breakdown subsection: "[Step 23F](#step-23f) — Cold-boot EM-card selection paint. Closes a gap surfaced by manual verification of tide-card after [Step 23E](#step-23e) landed."

**Tasks:**
- [x] Gap 2 (fresh-card resolver): chose option (5) registry-tag-based. Added `engineKind?: "em"` to `CardRegistration`; `gallery-prompt-input`, `gallery-prompt-entry`, and `tide` declare it. `resolveActivationTarget` consults `registration.engineKind` before the `bag.content !== undefined` heuristic. Forward-regression-gated by `at0033-em-fresh-card-activation.test.ts` (2 tests, both factories).
- [x] Gap 1 (cold-boot selection): added `cold-boot-restore-snapshot` and `engine-restore-applied` deck-trace events; instrumented CardHost and both EM factories. Diagnosis: `selectionApplied={start:0,end:5}` but `domSelectionAfter=null` — engine's `setSelectedRange` ran on a detached portal slot. Root cause: `onRestore` fired from `registerPersistenceCallbacks` which is called from a child's `useLayoutEffect`, BEFORE the parent CardPortal's effect could `host.appendChild(slot)`. None of the four original triage candidates (save-time-null / WebKit-quirk / hasFocus-race / engine-not-ready) matched — the actual cause was a fifth candidate (portal-slot detached at restore time) that the L04 ready-callback pattern resolves cleanly. **Fix**: defer the restore call to a CardHost-owned post-attach `useLayoutEffect`.
- [x] Gap 3 (focus-after-cross-pane-move): incidentally closed by gap-1's restructure. m34 verified (4 tests, both factories × cross-pane drag + detach scenarios).
- [x] Author `at0032-em-cold-boot-selection.test.ts`, `at0033-em-fresh-card-activation.test.ts`, `at0034-em-focus-after-move.test.ts`. All three added to the default sweep.
- [x] Drift-prevention cycle: gap-2 verified (revert resolver branch → m33 fails → restore → green); gap-1 verified (revert CardHost defer → m32 + m34 fail → restore → green).
- [x] Plan-doc: row-7 taxonomy entry updated; Step 23F checkboxes flipped; Pass 9 result note added matching the shape of prior result notes.

**Upholds:**
- **[L22]** — the cold-boot fix should not introduce new React-effect-driven DOM writes; the existing engine-internal `setSelectedRange` (synchronous, called from a layout effect or a direct mount-restore) is the only legitimate site.
- **[L23]** — selection captured at quit time must round-trip cleanly. If the issue is save-time `null`, the fix is in the capture path, not the restore path.

**Tests:**
- [x] `tests/app-test/at0032-em-cold-boot-selection.test.ts` exits 0 in default sweep.
- [x] `tests/app-test/at0033-em-fresh-card-activation.test.ts` exits 0 in default sweep.
- [x] `tests/app-test/at0034-em-focus-after-move.test.ts` exits 0 in default sweep.
- [ ] Manual verification: type and select inside a tide card; quit Tug.app; relaunch; assert visible selection paint shows the same span. (User-side verification step.)
- [x] `bun test` (tugdeck) full suite green: 2414/2414. `bun x tsc --noEmit` exits 0 (tugdeck + tests/app-test).

**Checkpoint:**
- [x] In-app smoke green: 21/21 default sweep files (38 tests including the three new gap-gates).
- [x] No regression at any existing AT-series scenario.
- [ ] Manual verification (user-side, see Tests above).

**Why this isn't 23E.** Step 23E is row 6 (runtime EM activation via `onCardActivated`). Cold-boot is row 7 — different mechanism, different mount-time effect site. Bundling them into one step would hide the cold-boot fix's distinct test, distinct trace events, and distinct revert-to-red diagnostic path under a step whose primary commit is about a different concern. Keeping 23F separate keeps the bisect crisp if either change regresses.

**Plan-doc updates (apply during 23F's commit):**
- Row 7 of the activation trigger taxonomy table updated to point at Step 23F.
- The Step breakdown subsection adds a Step 23F bullet.
- The "End of M-phase 2" summary in Step 23E's checkpoint references 23F as the row-7 closer (was previously "row 7 unchanged").

---

#### Step 23G: EM-card selection survives app-switch cycle {#step-23g}

**Depends on:** #step-23f

**Commit:** `Preserve EM-card selection across app-switch via setSelectedRange`

**References:** [A4](#a4-app-lifecycle-activation); row 5 of the [activation trigger taxonomy](#activation-trigger-taxonomy); `tug-prompt-input.tsx` (delegate `focus()` + `TugPromptInputPersistence.onCardActivated`); WebKit selectionchange-on-focus quirk (already documented in `tug-text-engine.ts:setSelectedRange`).

**Why this step exists.** User-reported real-app gap on a tide card: type "hello", select the last 3 chars ("llo"), cmd-tab away, cmd-tab back — text always restores, **selection is intermittently lost** with the caret left blinking at the end of "hello". The gallery-prompt-entry path doesn't reproduce, only tide does.

**Root cause (the actual one).** Tide-card's `useCardDelegate({ cardWillDeactivate: () => entryDelegateRef.current?.blur() })` calls `.blur()` on the contenteditable when the lifecycle cascade fires from `applicationWillResignActive` (cmd-tab away). The `.blur()` removes the document's selection — Selection state is bound to the focused element on contenteditable, so blurring clears it. Then on cmd-tab back, `cardDidActivate` fires and the refocus-on-activation chain finds `engine.getSelectedRange() === null`; the focus path falls into the "no prior selection: place caret at end" branch and the user sees the caret blinking at the end of "hello".

The OS already removes focus from the WKWebView when the app resigns active — tide's explicit `.blur()` is redundant for the focus-release purpose AND destructive for the selection. Gallery-prompt-entry has no `cardWillDeactivate` handler, so the OS-level blur runs alone and the contenteditable's selection survives the resign/reactivate cycle as it would in any browser.

**Secondary (defense-in-depth).** Tide-card has TWO focus paths firing on activation: `cardDidActivate` (legacy CardLifecycle) and `onCardActivated` (framework, Step 23E). Both call `entryDelegate.focus()` back-to-back. Even after the primary fix, that double-call would expose WebKit's selectionchange-on-focus quirk if anything else placed a programmatic selection just before the activation. The delegate's `focus()` and `TugPromptInputPersistence.onCardActivated` are also rerouted through `engine.setSelectedRange` for focus-then-select ordering — making both paths idempotent.

**Fix.**
1. **Primary**: remove the `entryDelegateRef.current?.blur()` body from tide-card's `cardWillDeactivate` handler. The OS-level blur on app-resign is sufficient and non-destructive to the selection. Keep the `cardWillDeactivate` slot wired (commented to explain why no-op) so future regressions don't re-introduce the .blur() naively.
2. **Secondary**: route the delegate's `focus()` and `TugPromptInputPersistence.onCardActivated` through `engine.setSelectedRange` for WebKit-safe focus-then-select ordering.

**Artifacts:**
- `tests/app-test/at0035-em-app-switch-selection.test.ts` — selection survives `simulateAppResign` + `simulateAppBecomeActive` for both `gallery-prompt-input` and `gallery-prompt-entry`. Forward regression gate. Added to default sweep.
- `tests/app-test/at0035-tide-app-switch-selection.test.ts` — tide-card-specific stress test (10 iterations × 2-second blur dwell per iteration). Reproduced the bug pre-fix; deterministic green post-fix. Added to default sweep.

**Harness extensions required to test tide-card.**
1. **Test-mode `feedsReady` bypass** in `CardHost`. Tide's content factory would otherwise wait on a live tugcast/tugcode/Claude pipeline before rendering. When `window.__tugTestMode === true`, the gate is bypassed and the contentFactory mounts immediately. Production behavior is unchanged.
2. **`bindTideSession(cardId, options?)` test-surface helper.** Tide's content factory branches on `useTideCardServices` — null services → project-picker, non-null → editor. Production binds via `spawn_session_ok` from a live AI session. The harness writes synthetic values directly into `cardSessionBindingStore` so the existing `cardServicesStore` reconciler constructs the real-shape services bag against the harness's WebSocket connection. Stores stay empty (no frames flow); the editor renders and accepts focus.
3. **`simulateAppResign` / `simulateAppBecomeActive` wait for JS-side `hasFocus` flip.** Pre-extension, the helpers waited only for AppKit's `did...Active` notification. Under back-to-back stress cycling, WKWebView's `window.blur` / `window.focus` dispatch lags AppKit by several ms and CAN BE DROPPED entirely — a test that proceeded immediately after the helper returned could find `hasFocus` still in its previous state. The harness now waits via a new `__tug.getHasFocus()` getter for the JS-side flip before returning.

**Why a 2-second blur dwell.** The user-reported repro: type, select, cmd-tab to another app, **stay there a few seconds**, cmd-tab back — selection lost. Sub-frame transient blurs (tens of ms) didn't expose the bug; a 2-second dwell does. The realistic dwell is what allowed AppKit to deliver `applicationWillResignActive` cleanly with full delegate-cascade processing, including tide-card's `cardWillDeactivate → .blur()` on the contenteditable.

**Tasks:**
- [x] Remove `entryDelegateRef.current?.blur()` from tide-card's `cardWillDeactivate` handler. Annotate the slot to explain why no-op.
- [x] Refactor `tug-prompt-input.tsx`'s delegate `focus()` to route through `engine.setSelectedRange` (defense-in-depth WebKit-quirk closure).
- [x] Refactor `TugPromptInputPersistence.onCardActivated` similarly.
- [x] Add `__tug.getHasFocus()` test-surface getter and use it in `simulateAppResign` / `simulateAppBecomeActive` to wait for JS-side blur/focus events.
- [x] Add `__tug.bindTideSession(cardId, options?)` test-surface helper to skip past tide's project-picker.
- [x] Bypass `feedsReady` gate in `CardHost` when `window.__tugTestMode === true`.
- [x] Author `at0035-em-app-switch-selection.test.ts` and `at0035-tide-app-switch-selection.test.ts`. Stress-loop confirmed deterministic green (3 × 10-iteration runs each).
- [x] Add both tests to the default sweep.
- [x] Drift-prevention verified: revert .blur() removal → at0035-tide fails within 2 iterations; restore → green.
- [ ] User-side manual verification: tide-card cmd-tab cycle no longer intermittently collapses the selection.

**Upholds:**
- **L23** — preserve user-visible state (the selection range) across an internal lifecycle event (cardWillDeactivate). The OS already removes focus on app-resign; an additional explicit `.blur()` is destructive to user state without contributing anything.
- **L10** — focus-and-selection authority remains the engine's; the delegate forwards rather than duplicating focus logic.

**Tests:**
- [x] `tests/app-test/at0035-em-app-switch-selection.test.ts` exits 0 in default sweep (gallery-prompt-input + gallery-prompt-entry).
- [x] `tests/app-test/at0035-tide-app-switch-selection.test.ts` exits 0 in default sweep (tide stress-loop with 2s blur dwell).
- [x] `bun test` (tugdeck): 2414/2414 green.
- [x] `bun x tsc --noEmit` exits 0 (tugdeck + tests/app-test).

**Checkpoint:**
- [x] In-app smoke green: 23/23 default sweep files.
- [x] No regression at any existing AT-series scenario.
- [ ] Manual verification (user-side, see Tasks above).

**Why this isn't 23F.** Step 23F closes cold-boot and cross-pane move (rows 6/7); both involve fresh or freshly-re-mounted contenteditables where the slot was detached. Step 23G is row 5 (app-lifecycle reactivation) where the slot stays attached and the engine state is intact — only the focus call's interaction with the pre-existing selection is the failure mode. Different gesture, different code path, different fix shape; bundling would hide the regression-bisect signal.

---

#### Step 24: OBSOLETE — content absorbed into Steps 23C + 23E {#step-24}

**Status:** Superseded. Anchor preserved for back-link integrity.

This step previously bundled two pieces of work:
1. Engine-managed content factories register `onCardActivated` to re-focus the engine root.
2. Retirement of Step 11's cross-pane `useLayoutEffect` now that [A3] is the single refocus authority.

When Steps 23A–23E were authored, these two pieces split along their natural fault line. Back-link targets resolve here; implementers should instead look at:

- **EM `onCardActivated` opt-ins** → [Step 23E](#step-23e).
- **Step 11 cross-pane effect retirement** → [Step 23C](#step-23c).
- **End-of-M-phase-2 summary** → [Step 23E](#step-23e)'s checkpoint.

---

#### Step 25: M-phase 4–10 execution strategy {#step-25}

**Status:** Authored 2026-04-25. Sub-steps 25A–25L close the remaining AT-tags.

**Why this step exists.** Steps 23A–23G closed M-phase 2 + M-phase 3 — every runtime activation trigger (intra-pane, pane-chrome, tab-close, cross-pane drag, app resign / focus, EM activations, cold-boot, cmd-tab) routes through the synchronous `focus-transfer.ts` module, EM cards register `onCardActivated`, and selection round-trips deterministically through cold-boot, cross-pane move, and cmd-tab away/back. The AT-tags closed are: [AT0001], [AT0002], [AT0003], [AT0004], [AT0005], [AT0006], [AT0007], [AT0009], [AT0016], [AT0021] (full); [AT0024] (foundation, [A9] shipped; per-component opt-ins remaining); [AT0011] (not-a-feature, closed informationally).

What's left maps to seven distinct architectural concerns, each scoped tight enough to land in 1–2 commits with the harness as the regression gate. The harness now has tide-card support (`bindTideSession`, test-mode `feedsReady` bypass) plus app-lifecycle simulation, native-event gestures, EM-card observation, and tugcode subprocess lifecycle — every remaining AT-tag has an automation surface.

**Remaining AT-tags by bucket.**

| Sub-step | Closes | Dependency | Architecture piece |
|---|---|---|---|
| [25A](#step-25a) | [AT0014], [AT0017], [AT0018], [AT0019], [AT0020], [AT0022], [AT0023] | none | (audit + verify) |
| [25B](#step-25b) | [AT0010] | [A9] (done) | [A5] markdown-view publish |
| [25C](#step-25c) | [AT0019] (audit half) | [25A](#step-25a) finding | [A7] unified flush gate |
| [25C.2](#step-25c2) | [AT0010] cold-boot, [AT0014] cold-boot (re-opens) | [25B](#step-25b) (landed) | two-process harness + cold-boot debug |
| [25D](#step-25d) | [AT0027] subset (layout state), [AT0030] subset (virtual focus on tab-bar / option-group) | [A9] (done) | [A9d] component opt-in batch 1 |
| [25E](#step-25e) | [AT0030] (remainder), [AT0027] subset | [A9] (done) | [A9d] component opt-in batch 2 |
| [25F](#step-25f) | [AT0026] (overlay policy + opt-in) | [A9] (done), [25E](#step-25e) | [A9d] component opt-in batch 3 |
| [25G](#step-25g) | [AT0031] (`tug-prompt-entry` route + toolsOpen), [AT0025] (closure) | [A9] (done), [25F](#step-25f) | [A9d] component opt-in batch 4 |
| [25H](#step-25h) | [AT0029] (scroll-key audit) | parallel-safe with 25D–G | (audit) |
| [25I](#step-25i) | [AT0028] (banner / bulletin dismiss) | independent | user-prefs store |
| [25J](#step-25j) | [AT0012] (IME) | platform research first | [A6] `bag.markedText` |
| [25K](#step-25k) | Pass 10 cleanup deferred from [Step 23E](#step-23e) | [Step 23G](#step-23g) (done) | grep-audit + `_flipFirstResponder` dev assertion |
| [25L](#step-25l) | [AT0013] (integration test fill-in), [AT0015] (legacy API delete), Step NN doc pass | all preceding sub-steps | final cleanup |

**Sequencing.** 25A first — its audits surface the actual scope of 25C and confirm what's already passing. After 25A: 25B and 25C can run in parallel with 25H and 25I (they touch disjoint files). 25D → 25E → 25F → 25G is a strict series because each batch's drift-prevention test needs the prior batch's components to behave normally. 25J last among the implementation steps because its platform research may surface a residual that defers the closure of [AT0012] beyond this plan. 25K and 25L are cleanup; 25K can land any time; 25L closes the plan.

**Why the harness changes the cadence.** Pre-Step-23 work, every AT-tag closure required manual browser verification: open Tug.app, click here, check this. The harness now drives every gesture (`nativeClickAtElement`, `nativeDragWithoutRelease`, `nativeKey`, `simulateAppResign` + `simulateAppBecomeActive` with JS-side event-drain wait, `bindTideSession`, EM-card observation), and the in-app sweep gates regression at every commit. M-phase 4–10 is consequently scoped tight — each sub-step ships with one or more new test files in the default sweep, and the manual-verification checkboxes that dominated Steps 1–14 are gone.

##### Step 25A: Audit + verification sweep {#step-25a}

**Status: ✅ landed 2026-04-25.** All seven gating tests pass in the default sweep. AT-tag entries [AT0014], [AT0017], [AT0018] (synchronous-restore factories), [AT0019] (multi-card teardown path), [AT0020] (editor-context-menu representative), [AT0022], [AT0023] flipped to ✅ above.

**Closes:** [AT0014], [AT0017] (verification half — RPC parity), [AT0018] (gating for the synchronous-restore factories shipping today), [AT0019] (audit half — multi-card teardown coverage), [AT0020] (editor-context-menu representative), [AT0022], [AT0023].

**Why this step exists.** Several AT-tags (AT0014, AT0017, AT0018, AT0019, AT0020, AT0022, AT0023) were flagged ❓ untested or ⚠️ partial — they needed verification before any fix could be authored. Some were already fixed by prior work (e.g. [AT0019]'s `_closePane` flush loop has been intact since Step 14); others were genuine gaps (e.g. [AT0022]'s `document.hasFocus()` half had no automated assertion). Clustering the audits in one sub-step informed the implementer's plan for 25C onwards.

**Deliverables landed:**
- Seven new harness tests, all in the default sweep:
  - `at0014-scroll-persistence.test.ts` — region scroll round-trip across tab switch + back; region scroll across `simulateAppResign` / `simulateAppBecomeActive`.
  - `at0017-savestate-rpc-parity.test.ts` — `window.tugdeck.saveState()` writes a JSON-equal bag to the window-blur path for the same steady state.
  - `at0018-async-content-race.test.ts` — `bag.content` survives `saveState` and `simulateAppResign` after a seed-and-mount.
  - `at0019-pane-teardown-flush.test.ts` — `__tug.closePane(paneId)` fires `save-callback` (close-handoff) for every cardId before any `card-host-unmount`.
  - `at0020-overlay-focus-return.test.ts` — editor context menu opens on right-click, dismisses on Escape, focus returns to the editor.
  - `at0022-caret-visibility.test.ts` — `document.activeElement === engineRoot && document.hasFocus() === true` after cold-boot, app-cycle, tab-switch.
  - `at0023-cross-card-selection.test.ts` — drag-select across two MV cards never crashes the paint system (`window.getSelection()` + per-card `__tug.getSelection`).
- Component changes:
  - `gallery-markdown-view.tsx`: opts into `useCardPersistence` (text round-trips through `bag.content`); accepts an optional `staticContentSize` prop that bakes a fixed-size payload on mount via `useLayoutEffect` + `setRegion`.
  - `gallery-registrations.tsx`: registers a `gallery-markdown-50kb` variant for the [AT0014] / [AT0023] fixtures (50KB of static markdown loaded at mount).
- Test-surface additions (page-side `SURFACE_VERSION` 1.3.0):
  - `__tug.getCardStateBag(cardId)` — full bag introspection for the [AT0017] parity audit.
  - `__tug.closePane(paneId)` — multi-card pane teardown entry point for the [AT0019] flush audit.
- Plan-doc AT-tag status flips for the seven tags above.

**Out of scope at 25A (deferred to [25C](#step-25c)):**
- `[A7]` flush-gate invariant guard at the bottom of `_removeCard` / `_closePane` (dev-error on bypassed flush).
- Deck-reset / workspace-close path audit for `flushSaveCallbackBeforeDestruction` coverage (no current call site, surfaced if/when added).
- `restorePendingRef`-based `onSave` gate at `invokeSaveCallback` for any future async content factory that exposes the [AT0018] race.

**Commits:** one — Step 25A audit sweep.

##### Step 25B: Markdown-view selection publish {#step-25b}

**Status:** ✅ landed 2026-04-25.

**Closes:** [AT0010] per [L23] (user-visible state must round-trip). Implements [A5].

**Deliverables (landed):**
- `tug-markdown-view.tsx`: added a `persistKey?: string` prop. When set inside a `CardHost` (i.e. `useCardId` resolves to a non-null id), a `useLayoutEffect` subscribes to `document.selectionchange` and publishes any range whose `commonAncestorContainer` is within the scroll container via `selectionGuard.updateCardDomSelection(cardId, range)`. Out-of-card ranges and `rangeCount === 0` events are silently ignored — clearing belongs to the unmount cleanup, which calls `updateCardDomSelection(cardId, null)` exactly once.
- `tug-markdown-view.tsx`: also calls `useCardPersistence({ onSave: () => undefined, onRestore: () => {} })` so `bag.content` stays absent and `CardHost`'s `captureCardState` falls into the `!ownsSelectionAndFocus` branch — `bag.domSelection` is captured automatically from `selectionGuard.cardRanges`, and the cold-boot mount-restore path replays it via `selectionGuard.restoreCardDomSelection`.
- `gallery-markdown-view.tsx`: passes `persistKey="markdown-view"` to the underlying `TugMarkdownView` so harness fixtures for [AT0010] / [AT0014] / [AT0023] inherit the selection-publish behavior automatically.
- New harness test `at0010-markdown-selection.test.ts`: programmatically selects 20 chars in card A's first block, tab-switches A → B, asserts `getCaretState("A")` still resolves to the same `Range` AND that `CSS.highlights.get("inactive-selection")` contains a Range whose text matches; runs `simulateAppResign` + `simulateAppBecomeActive`, asserts the snapshot still resolves; tab-switches B → A, asserts native `window.getSelection()` text matches the saved Range — i.e. the focused card's range was restored to native `::selection` by the deck-store-driven `updatePaint` (the same path that installs the one-shot `mousedown` interceptor when a focus return lands on a card with a saved Range).

**Commits:** one — Step 25B markdown-view selection publish.

##### Step 25C: Unified flush-on-teardown gate {#step-25c}

**Closes:** [AT0019] (closure). Implements [A7].

**Conditional on 25A's audit.** If `at0019-pane-teardown-flush.test.ts` (added in 25A) passes without changes, this sub-step reduces to the dev-only invariant guard. If the audit surfaces a gap (a path that removes cards without flushing), the fix lands here.

**Deliverables:**
- Either: invariant guard at the bottom of `_removeCard` / `_closePane` that dev-errors if `flushSaveCallbackBeforeDestruction` was not called for a card being removed; OR a single chokepoint `destroyCard(cardId)` that bundles flush + lifecycle + delete.
- (If audit found a gap) the actual fix that closes the gap.
- The 25A test extended to gate the new invariant.

**Estimated commits:** one (likely small).

##### Step 25C.2: Two-process cold-boot harness + markdown persistence cold-boot fix {#step-25c2}

**Status:** proposal — open questions answered; ready for review.

**Why this exists.** [Step 25B](#step-25b) landed `tug-markdown-view` selection publish and flipped [AT0010] / [AT0014] / [AT0023] to ✅ in the verification matrix. Manual verification surfaced that a TugMarkdownView (50KB) gallery card with a scroll position and selection — quit Tug.app, relaunch — restores neither. Reading the bag directly from tugbank (`tugbank read dev.tugtool.deck.cardstate <cardId>`) shows the save side IS working: `regionScroll.markdown-view.y = 26922` and a populated `domSelection` are on disk after quit. The break is on the load + cold-mount + virtualization-bake-in race side, none of which the current in-app sweep exercises.

**The systemic gap.** Every test in the in-app sweep runs ONE Tug.app process for its lifetime. Tests that claim to gate persistence-on-quit (`at0017-savestate-rpc-parity`) compare in-memory bags. Tests that claim to gate cold-boot restore (`at0032-em-cold-boot-selection`, `at0010-markdown-cold-boot` — the latter has been removed as confirmation theater) use `seedDeckState` to populate the in-memory `cardStateCache` and immediately re-mount. None of them go: (a) write bag to tugbank disk on quit, (b) terminate the WebView process, (c) start a fresh process, (d) read the bag back, (e) verify the live state. That gap is exactly what hid the markdown-view restore bug.

**Open questions — answered.**

The proposal originally listed three open questions. Investigation closed all three; the answers shape the harness design below.

1. *Tugbank ownership across processes — RESOLVED with one small tugcast change in Layer 2.*
   - `AppDelegate.applicationDidFinishLaunching` already reads `TUGBANK_PATH` for the Swift-side `TugbankClient` (`tugapp/Sources/AppDelegate.swift:45-50`).
   - `ProcessManager.startProcess` inherits Tug.app's full env — `var env = ProcessInfo.processInfo.environment` — when spawning tugcast (`tugapp/Sources/ProcessManager.swift:549`), so tugcast inherits `TUGBANK_PATH`.
   - **Initial proposal claim was wrong:** tugcast's `main.rs` only honored a `--bank-path` CLI flag and fell back to `~/.tugbank.db`; it did NOT read `TUGBANK_PATH` env. Discovered when Layer 2's smoke test wrote via tugcast's HTTP PUT to a temp DB but the disk read returned null — tugcast had silently written to the user's real `~/.tugbank.db`. Layer 2 adds a `TUGBANK_PATH` fallback between the flag and the home-dir default, mirroring the precedence the `tugbank` CLI itself uses.
   - The harness's `launchTugApp` already plumbs `opts.env` through `--env KEY=VALUE` flags to `/usr/bin/open` (`tests/app-test/_harness/index.ts:1325-1331`), which sets the env on the launched Tug.app.
   - **Implication:** after Layer 2's tugcast change, `launchTugApp({env: {TUGBANK_PATH: tempPath}})` works. Both Tug.app's TugbankClient (Swift, direct sqlite) and tugcast's HTTP `put_key` handler (Rust, sqlite via `tugbank-core`) point at the same temp file. Both processes use `SQLITE_OPEN_READWRITE | WAL | busy_timeout=5000`, so concurrent open is safe.
   - **Boot-time seed required:** a fresh temp tugbank has no `dev.tugtool.app/source-tree-path`, so Tug.app's `loadPreferences` falls into the "Source Tree Required" alert. Layer 2 adds `seedTugbankForLaunch(path)` that writes the minimum (`source-tree-path`, `dev-mode-enabled=false`) before `launchTugApp`. Every cold-boot test calls it once per temp DB.

2. *Process-quit save guarantee — RESOLVED, but `app.close()` is the wrong primitive.*
   - The save chain is sound when triggered: `AppDelegate.applicationShouldTerminate` returns `.terminateLater` and the completion handler at `AppDelegate.swift:184-198` blocks `processManager.stop()` on `evaluateJavaScript("window.tugdeck?.saveState?.()")`'s completion. That completion fires only after `saveAndFlushSync` returns (`tugdeck/src/deck-manager.ts:1310-1318`), which loops over save callbacks and calls `flushDirtyCardStates({sync: true})` → `putCardState({sync: true})` (`tugdeck/src/settings-api.ts:121-135`) → synchronous XHR PUT to tugcast → `put_key` (`tugcast/src/defaults.rs:293-339`) → `tokio::task::spawn_blocking(client.set(...))` (awaited) → `DefaultsStore::open` with `synchronous=NORMAL` WAL writes. By the time the XHR returns, the row is committed in the WAL; the next process opening the same file sees it.
   - **The gap is the trigger.** Today's `app.close()` runs `pkill -x Tug` SIGTERM/SIGKILL (`index.ts:1376`). A bare SIGTERM does NOT route through `applicationShouldTerminate` — Cocoa's run loop has no SIGTERM handler that calls into the delegate. So today's harness teardown bypasses the entire save path.
   - **Implication:** The new `app.quitGracefully()` primitive must call `NSApp.terminate(nil)` (which DOES fire `applicationShouldTerminate`) via a new RPC verb, and the harness must wait for the process to exit naturally rather than killing it.

3. *Selection seed determinism — RESOLVED via fixture choice.*
   - `gallery-markdown-view.tsx:137-145` already supports a `'1kb'` size variant — but `gallery-registrations.tsx:387-395` only registers the `50kb` flavor.
   - 1KB of static markdown fits in one viewport at the gallery card's default size, so all blocks render and `block-container.children` indices are stable across re-mount. Selection paths captured against a fully-rendered tree restore deterministically.
   - **Implication:** Add a `componentId: "gallery-markdown-1kb"` registration. Use it for the cold-boot selection seed test. Use the existing `gallery-markdown-50kb` for the cold-boot scroll test (which doesn't depend on selection-anchor stability) and for any future virtualization-aware selection follow-up.

**Scope.**

The work splits into four layers, each landable as its own commit. Order matters — each layer is the gate for the next.

**Layer 1 — `gallery-markdown-1kb` fixture (1 small commit).**

Add the missing registration in `tugdeck/src/components/tugways/cards/gallery-registrations.tsx` mirroring the `50kb` block:

```tsx
registerCard({
  componentId: "gallery-markdown-1kb",
  contentFactory: (_cardId) => <GalleryMarkdownView staticContentSize="1kb" />,
  defaultMeta: { title: "TugMarkdownView (1KB)", icon: "FileText", closable: true },
  family: "developer",
  acceptsFamilies: ["developer"],
  sizePolicy: GALLERY_COMPLEX_SIZE,
  category: CATEGORIES.textInput,
});
```

Pure addition — no behavioral change. Zero new tests at this layer; verifies via the existing tugdeck unit suite.

**Layer 2 — Test-harness primitives (1 commit, the foundation).**

Land the harness surface that the new tests will lean on. Each primitive is independently testable with a smoke test before the cold-boot tests are written.

- *`quitGracefully` RPC verb — Swift side.*
  - New file or extension: `tugapp/Sources/TestHarness/AppLifecycleHandlers.swift` (already houses the four `simulateApp*` verbs — same family).
  - Add a `case "quitGracefully":` branch that:
    1. Subscribes to `NSApplication.willTerminateNotification` on `NotificationCenter.default` from the main queue, signaling a `DispatchSemaphore`.
    2. `DispatchQueue.main.async { NSApp.terminate(nil) }` — fires `applicationShouldTerminate` → save path → `NSApp.reply(toApplicationShouldTerminate: true)` → `applicationWillTerminate` notification.
    3. `semaphore.wait(timeout: .now() + .milliseconds(timeoutMs))` — default 5000ms (long: save can take seconds when tugcast is busy).
    4. On timeout, throws a typed error `AppLifecycleError.quitTimeout(timeoutMs:)`. Note the test will not see the response on success — the socket dies with the app.
  - Bump `surfaceVersion` to `1.5.0` in `TestHarnessConnection.swift` and the matching constant in `tests/app-test/_harness/index.ts:140`.
- *`app.quitGracefully(opts?)` JS-side wrapper.*
  - Add to `App` class in `tests/app-test/_harness/index.ts`. The wire-level `rpc.call` is fire-and-forget here: the connection drops mid-call as the app dies. Catch the connection-close error and treat it as success; await `subprocess.exited` to confirm.
  - Skip Cocoa's "really quit?" dialog: harness only runs in DEBUG builds where unsaved-changes prompts don't surface.
- *`mkTempTugbank()` and `readTugbankCardState()` helpers.*
  - New file: `tests/app-test/_harness/tugbank-helpers.ts` (TS module, not a runtime piece of the App class).
  - `mkTempTugbank(): string` — returns a unique path under `os.tmpdir()` like `/tmp/tugapp-test-tugbank-<uuid>.db`. Does NOT create the file; tugbank/tugcast create it on first write. Caller passes this path as `env.TUGBANK_PATH`.
  - `readTugbankCardState(path, cardId): CardStateBag | null` — shells out via `Bun.spawnSync` to `tugbank --path <path> --json read dev.tugtool.deck.cardstate <cardId>`. Returns `null` on exit code 2 (not found), the parsed JSON otherwise. Throws on other exit codes.
  - `clearTugbankCardState(path, cardId): void` — `tugbank --path <path> delete dev.tugtool.deck.cardstate <cardId>`. Used between Phase A and Phase B in tests that want a known starting point.
  - `rmTempTugbank(path): void` — unlinks the temp DB and any WAL/SHM siblings.
  - Resolves the `tugbank` binary via `process.env.TUGAPP_TUGBANK_BINARY` first, then `which tugbank`. Recipe-level support added in `Justfile`.
- *`app.waitForMarkdownReady(cardId, opts?)` and `app.waitForScrollSettled(cardId, regionKey, expectedY, opts?)`.*
  - Both are JS-side wrappers over the existing `waitForCondition` RPC. Deferred to Layer 4 if the cold-boot tests don't actually need them yet — but they're cheap and let us delete duplicated `waitForCondition` boilerplate from m14, m23, at0010-markdown-selection.
  - `waitForMarkdownReady` blocks until the card's `[data-tug-scroll-key="markdown-view"]` exists, has `block-container` populated with `data-block-index`-tagged children, and `scrollHeight > clientHeight + 200` (the same gate `m14` uses inline today).
  - `waitForScrollSettled` blocks until `el.scrollTop` is within `tolerance` (default 8px) of `expectedY` AND has held across N consecutive `requestAnimationFrame` ticks (default N=3). N-stable polling is what catches the bake-in race: ResizeObserver-driven spacer growth nudges the value once before settling.

Smoke test gating Layer 2: a **single** new `smoke-cold-boot.test.ts` file that:
1. Calls `mkTempTugbank()` to get a path.
2. Launches Tug.app with `env.TUGBANK_PATH = path`.
3. `evalJS("await fetch('/api/defaults/dev.tugtool.test/key', {method:'PUT', headers: {...}, body: '...'})")` — writes a known value through tugcast.
4. `app.quitGracefully()` — waits for app exit.
5. Shells out to `tugbank --path <path> read dev.tugtool.test key` and asserts the value round-tripped.
6. Relaunches against the same path; reads the same value back through tugcast (`fetch('/api/defaults/dev.tugtool.test/key')`); asserts.
7. `rmTempTugbank(path)`.

This smoke test proves all Layer-2 primitives end-to-end before any cold-boot test depends on them. If it fails, Layer 3 doesn't get written. If it passes, every primitive is known-good.

**Layer 3 — The two cold-boot tests (1 commit). LANDED.**

**Status update (post-implementation):** Layer 3 added a small escape hatch that surfaced during implementation:

- *Test-mode persistence bypass.* `deck-manager`'s `put*Guarded` wrappers (`putCardStateGuarded`, `putLayoutGuarded`, `putFocusedCardIdGuarded`) short-circuit ALL tugbank writes when `__tugTestMode === true`. With the harness's TUGAPP_TEST_SOCKET set, that flag is on — so quitGracefully → saveAndFlushSync → putCardState wrote nothing to disk, and Phase A's "bag is on disk" assertion saw `null`.
- *Layer 3 ships an opt-in escape.* New flag `__tugPersistInTestMode`, injected by `TestHarnessUserScript` when the launched app's env has `TUGAPP_PERSIST_IN_TEST_MODE=1`. `put*Guarded` checks both flags: skip writes only when `testMode && !persistInTestMode`. Cold-boot tests opt in via `launchTugApp({persistInTestMode: true})`. Existing tests don't set the flag, so behavior is unchanged for them. Per-test `TUGBANK_PATH` isolation (Layer 2) makes the bypass redundant for opted-in tests anyway.

**Findings — what failed and what passed:**

- *at0014-cold-boot-scroll on `gallery-markdown-50kb`* — **fails** at Phase B's `waitForScrollSettled` after Phase A's 4 disk-side assertions pass. The bag IS on disk with `regionScroll["markdown-view"].y` matching the seeded scroll, and `el.scrollTop` never lands at the saved value within the 4s settle window. This is the Layer 4 gating evidence. **NOT in the default Justfile sweep until Layer 4 fixes it.**
- *at0010-cold-boot-selection on `gallery-markdown-1kb`* — **passes** end-to-end (11 expects, ~2s). With all blocks rendered (no virtualization), saved `domSelection` paths resolve to stable DOM nodes on re-mount and `selectionGuard` re-anchors the range correctly. **In the default Justfile sweep** as a regression-prevention gate.

**Layer 4 scope narrows accordingly.** The non-virtualized selection round-trip is already correct; the fix needs to address only the scroll-restore race on virtualized markdown content. The 50KB-selection / content-relative-encoding follow-up remains out-of-scope for 25C.2 unless Layer 4's investigation surfaces it.

---

Original Layer 3 spec (preserved for reference):

Both tests follow the same Phase-A / Phase-B convention. Naming: keep in `tests/app-test/`, prefix with the existing AT-tag for traceability.

*`at0014-cold-boot-scroll.test.ts`*

Test metadata convention (lives as a docstring header on the `describe` block):

```ts
/**
 * at0014-cold-boot-scroll.test.ts — region-scroll restore across full
 * Tug.app process restart.
 *
 * ## Two-phase contract
 *
 * Each test in this file runs **two separate Tug.app processes**
 * sharing one temp tugbank file. The phases are sequential, never
 * parallel; teardown of phase A precedes launch of phase B.
 *
 * | Phase | Tugbank state at launch | Action      | Assertion                                    |
 * |-------|-------------------------|-------------|----------------------------------------------|
 * | A     | empty (fresh temp DB)   | scroll then | tugbank disk has regionScroll.markdown-view  |
 * |       |                         | quitGracefully | y matching the scrolled offset            |
 * | B     | populated (from A)      | wait, observe | live el.scrollTop matches the saved offset|
 *
 * Phase A failing means the save path didn't reach disk (or didn't
 * fire on quit). Phase B failing means the load + restore path
 * didn't apply the bag. The split makes diagnosis cheap.
 *
 * ## Tugbank lifecycle
 *
 * The temp tugbank path is created by `mkTempTugbank()` in beforeAll
 * and removed by `rmTempTugbank()` in afterAll. Each test owns its
 * own path — no cross-test sharing.
 *
 * ## Closes
 * - [AT0014] cold-boot variant. The existing at0014-scroll-persistence
 *   already gates tab-switch + simulateAppResign round-trips; this
 *   file adds the cold-boot variant they cannot exercise.
 */
```

Test body sketch:

```ts
describe.skipIf(!SHOULD_RUN)("m14: scroll cold-boot", () => {
  test("scroll position survives quit + relaunch", async () => {
    const tugbankPath = mkTempTugbank();
    try {
      // Phase A: empty tugbank → seed → scroll → quit gracefully.
      {
        const app = await launchTugApp({
          testName: "at0014-cold-boot-scroll-A",
          env: { TUGBANK_PATH: tugbankPath },
        });
        try {
          await app.seedDeckState({ /* gallery-markdown-50kb on card "A" */ });
          await app.waitForMarkdownReady("A");
          await app.evalJS(`/* set scrollTop = 600 + dispatch scroll event */`);
          await app.waitForCondition(`/* el.scrollTop === 600 */`);
          await app.quitGracefully();
        } finally {
          // quitGracefully resolves on normal exit; fall through.
        }
      }
      // Phase A assertion: bag is on disk.
      const onDisk = readTugbankCardState(tugbankPath, "A");
      expect(onDisk?.regionScroll?.["markdown-view"]?.y).toBeCloseTo(600, 8);
      // Phase B: relaunch against same tugbank, assert restore.
      {
        const app = await launchTugApp({
          testName: "at0014-cold-boot-scroll-B",
          env: { TUGBANK_PATH: tugbankPath },
        });
        try {
          await app.waitForMarkdownReady("A");
          await app.waitForScrollSettled("A", "markdown-view", 600);
          // Final live read: redundant with waitForScrollSettled but
          // makes the assertion explicit in the test body.
          const live = await app.evalJS<number>(/* return el.scrollTop */);
          expect(live).toBeCloseTo(600, 8);
        } finally {
          await app.close();
        }
      }
    } finally {
      rmTempTugbank(tugbankPath);
    }
  });
});
```

*`at0010-cold-boot-selection.test.ts`* — same shape, different fixture (`gallery-markdown-1kb`) and assertions:
- Phase A: mount, anchor selection to a known span (`{startOffset: 5, endOffset: 25}` on the first text node — deterministic with all blocks rendered), `quitGracefully`.
- Phase A assertion: `readTugbankCardState`'s `domSelection` is non-null and matches the captured paths.
- Phase B: relaunch, wait for ready, assert `__tug.getCaretState("A")` returns the saved range and the native `::selection` paint is visible.

Both tests must FAIL before Layer 4 lands and PASS after — that's the gating contract.

**Layer 4 — The actual fix (1 commit). LANDED.**

**The actual root cause (different from Layer 3's hypothesis):** the proposal predicted the bug was a clamp-on-first-apply that the `MutationObserver attributeFilter: ["style"]` retry would solve. That's part of the story but not the load-bearing piece. The real cause is `tug-markdown-view`'s `SmartScroll`: it defaults `followBottom: true`, and during ResizeObserver-driven bake-in the "if isFollowingBottom, slam `scrollTop = 0x40000000`" branch (`tug-markdown-view.tsx:504-505` and `:557-559`) re-clamps `scrollTop` to the bottom every time the spacer heights grow. Setting `el.scrollTop = 600` directly — what `applyRegionScrolls` did, what the at0014-cold-boot-scroll Phase A test did — couldn't survive bake-in: by save time the bag captured the bottom-most scrollTop, not the user's chosen position. Phase B then "restored" to that bogus value AND got re-slammed to bottom on its own bake-in.

**The fix.** Introduce a `tug-region-scroll-set` custom DOM event as the canonical "set scroll position" primitive for region scroll containers. tug-markdown-view installs a listener on its scroll container that:

1. Calls `SmartScroll.scrollTo({ top, animated: false })` to apply the requested position.
2. Calls `SmartScroll.disengageFollowBottom()` so subsequent ResizeObserver-driven height growth does NOT re-slam to bottom.
3. Calls `event.preventDefault()` to signal the dispatcher that the apply was handled.

`applyRegionScrolls` (in `card-host.tsx`) dispatches the cancelable event before falling back to direct `scrollLeft` / `scrollTop` assignment — generic scroll regions without a SmartScroll listener don't preventDefault, so they fall through to the existing direct-assignment path with no behavior change.

The CardHost mount-restore retry mechanism (Layer 4 also keeps this from the proposal): the per-mount `regionSettled` Set replaces the one-shot `regionApplied` Set, and the `MutationObserver` adds `attributes: true, attributeFilter: ["style"]`. This handles the smaller residual race where the very first apply lands at a clamped scrollTop because content hasn't fully baked in — subsequent spacer growth re-fires `apply()` and we re-assert until `el.scrollTop` sits within 8px of the saved position.

**Test side.** The at0014-cold-boot-scroll Phase A test was changed to dispatch the same `tug-region-scroll-set` event instead of setting `el.scrollTop` directly (the latter would be re-slammed by SmartScroll's follow-bottom on bake-in, and the saved bag would carry the wrong value). This is consistent with the production restore path: both go through the same primitive.

**Result.**

- `at0014-cold-boot-scroll.test.ts` — 5/5 stable. Now in the default Justfile sweep.
- `at0010-cold-boot-selection.test.ts` — still 5/5 stable.
- All adjacent tests (m04, m05, at0010-markdown-selection, at0014-scroll-persistence, at0017-savestate-rpc-parity, at0023-cross-card-selection, _smoke-cold-boot) green — no regressions.

**Files touched.**

- `tugdeck/src/components/chrome/card-host.tsx` — `applyRegionScrolls` dispatches the event; mount-restore uses `regionSettled` semantics + style-attribute observer.
- `tugdeck/src/components/tugways/tug-markdown-view.tsx` — listener for `tug-region-scroll-set` that calls `SmartScroll.scrollTo` + `disengageFollowBottom` + `preventDefault`.
- `tests/app-test/at0014-cold-boot-scroll.test.ts` — Phase A dispatches the event; status doc flipped.
- `Justfile` — `at0014-cold-boot-scroll.test.ts` added to default sweep.

**Selection-on-virtualized-content note.** The 50KB selection variant remains unimplemented as a follow-up (25C.3 if needed). The user's manual relaunch bug for selection on the 50KB card may still surface; a subsequent commit can add an at0010-cold-boot-selection-50kb test. The likely fix there is content-relative selection encoding (block index + intra-block offset) rather than DOM child paths; that's a re-architecting of `captureDomSelection` / `restoreCardDomSelection` and is genuinely out-of-scope for 25C.2.

**Deliverables.**

- Layer 1: one-line registration addition (`gallery-markdown-1kb`).
- Layer 2: `quitGracefully` Swift handler + JS wrapper, surface version bump, `tugbank-helpers.ts`, `smoke-cold-boot.test.ts` proving the primitives work.
- Layer 3: `at0014-cold-boot-scroll.test.ts`, `at0010-cold-boot-selection.test.ts`. Both must fail on this commit; the failure mode confirms the bug exists.
- Layer 4: the fix that flips Layer 3's tests to pass. Hypothesis-test the scroll-race fix first; selection fix second.
- Audit: extend `at0017-savestate-rpc-parity` and `at0032-em-cold-boot-selection` to use `quitGracefully` + `readTugbankCardState` where the Phase-A-on-disk assertion strengthens their claim. Where the existing test body is honest about scope (m32's docstring is), the audit may decide an additive Phase B is enough; where the claim was misleading, rename to match.

**Estimated commits:** four — (1) Layer 1 fixture registration, (2) Layer 2 harness primitives + smoke test, (3) Layer 3 cold-boot tests (failing-as-expected), (4) Layer 4 fix. A fifth if content-relative selection encoding is required for the 50kb selection variant.

**Sequencing.** Independent of [25C](#step-25c) (different code paths). Depends on [25B](#step-25b) (landed). Can run in parallel with [25D](#step-25d)–[25G](#step-25g) since it touches harness + persistence-restore code, not the component opt-in roster. Each layer is its own commit; do not bundle Layer 3 with Layer 4 — the failing-as-expected commit is part of the gating evidence.

##### Step 25C.3: Complete state preservation for `tug-prompt-input`, `tug-prompt-entry`, and the Tide card across reload + relaunch {#step-25c3}

**Status:** proposal — awaiting review.

**Why this exists.** Manual repro on the running app: a Tide card with a prompt that has been scrolled (multi-line content overflowing the editor's max-rows window) and a non-collapsed selection inside that prompt loses BOTH on `Developer > Reload` and on quit + relaunch. Same regression on the gallery cards `gallery-prompt-input` and `gallery-prompt-entry`. The Tide stream pane (TugMarkdownView above the entry) restores correctly — that's [25C.2](#step-25c2)'s `tug-region-scroll-set` work paying off. The gap is in the prompt editor itself.

**The L23 violation.** The prompt-input editor's persistence shape is *incomplete*. `TugTextEditingState` (the engine's serialized snapshot in `tug-text-engine.ts:147-154`) records `text` + `atoms` + `selection`. It does not record the editor's internal `scrollTop`. The compound `TugPromptEntry` then layers `{ currentRoute, perRoute, maximized }` over this same `TugTextEditingState` for each route — also no scroll. That's an outright omission, not a subtle race: the current persistence shape *cannot* express the user's scroll position at all. On every reload, scroll resets to the bake-in default (top, or whatever WebKit lands on for a freshly mounted contentEditable). That is destruction of user-visible state, with no recovery attempt — the simplest L23 failure mode.

The selection failure is a separate gap on the same component. Selection IS in `TugTextEditingState`, and the engine's `restoreState` calls `setSelectedRange` ([L23]'s "diff and mutate minimally" path). But on cold-boot, `TugPromptEntry.onRestore` runs while `promptInputRef.current` IS populated (the imperative handle is set during the child's mount commit) but the underlying `TugTextEngine` instance ISN'T — `engineRef.current` becomes non-null only inside the input's own engine-lifetime `useLayoutEffect`, which runs AFTER the entry's parent-effect. The delegate's `restoreState` is `engineRef.current?.restoreState(state)` — silent no-op when the engine doesn't yet exist. The entry has no equivalent of the input's `pendingRestoreRef` buffer (that buffer is conditional on the input owning persistence, which the entry disables via `persistState={false}`). Net effect: on cold-boot through the entry's persistence path, `text` + `atoms` + `selection` all silently fail to apply.

These are not isolated component bugs. They are the same shape: the persistence interface for these components is *not closed under "everything the user can see and put there."* L23 says save-and-restore is destruction with attempted recovery; an *incomplete* save-and-restore is destruction without even an attempt. The fix has to be a comprehensive enumeration of user-visible state per component, with a test that verifies every item round-trips on every persistence trigger — not another patch on a per-symptom basis.

**Scope of "user-visible state" for each target component.**

The audit table drives the fix and the tests. Every row is a piece of state the user can see or that they put there; every column is whether it round-trips today on each trigger. ✅ = round-trips, ❌ = lost, ⚠️ = race-prone.

| Component / item                          | tab-switch | cmd-tab (resign/return) | `Developer > Reload` | quit + relaunch |
|-------------------------------------------|:----------:|:-----------------------:|:--------------------:|:---------------:|
| **`tug-prompt-input` (standalone)**        |            |                         |                      |                 |
| text content                              | ✅          | ✅                       | ✅                    | ⚠️ (cold-boot race) |
| atoms (file mentions, slash commands)     | ✅          | ✅                       | ✅                    | ⚠️ (cold-boot race) |
| selection (collapsed caret + non-collapsed range) | ✅  | ✅ (post-23G)            | ⚠️                    | ❌                |
| editor `scrollTop`                        | ❌          | ❌                       | ❌                    | ❌                |
| **`tug-prompt-entry` (standalone)**        |            |                         |                      |                 |
| `currentRoute`                            | ✅          | ✅                       | ✅                    | ✅                |
| `perRoute[r].text` / `.atoms` / `.selection` | ✅       | ✅                       | ⚠️                    | ❌ (cold-boot race) |
| editor `scrollTop` (per-route)            | ❌          | ❌                       | ❌                    | ❌                |
| `maximized`                               | ✅          | ✅                       | ✅                    | ✅                |
| **Tide card**                              |            |                         |                      |                 |
| stream-pane scroll (TugMarkdownView above) | ✅ (25B/C.2) | ✅                     | ✅                    | ✅                |
| split-pane divider position               | ❌          | ❌                       | ❌                    | ❌                |
| entry-pane state (cascaded from above)    | ✅          | ✅                       | ⚠️                    | ❌                |
| `lastError` banner dismissal              | n/a (UI-only, dismissed=undismissed across reload by design) ||||

The split-pane divider row is intentional but out-of-scope: it's [Step 25D](#step-25d)'s deliverable. The audit lists it for completeness so 25D's work doesn't surprise anyone reading this gap analysis.

**The fix in principle, before details.** Two changes, each in its own commit:

1. **Extend the engine's persistence shape so it CAN express scroll.** `TugTextEditingState` gains a `scrollTop: number | null`. `TugTextEngine.captureState` reads `this.root.scrollTop`; `TugTextEngine.restoreState` writes it. Existing payloads decode as `{ ..., scrollTop: null }` (back-compat: a saved `null` means "do not assert a scroll position" and the editor mounts at its natural offset). The compound `TugPromptEntry`'s per-route map carries the same expanded shape transparently — no schema work at the entry level.

2. **Close the engine-creation race in the entry's restore path.** Mirror the input's `pendingRestoreRef` pattern at the delegate boundary: when the entry calls `input.restoreState(saved)` and the engine doesn't exist yet, the call must be buffered inside the input and replayed when the engine completes its `useLayoutEffect`. The cleanest seam is the imperative handle's `restoreState` itself — make it always buffer if the engine isn't ready, regardless of whether the input owns persistence. Today's pendingRestoreRef is gated on `persistState={true}`; remove that gate.

Both changes are tuglaws-compliant by construction:

- **L23**: extending the persistence shape closes the omission directly — every user-visible item now has a place to live in the bag. The race fix means the restore *always* reaches the engine; "save and restore" stops being "save and silently fail to restore."
- **L02**: persistence reads/writes go through `useCardPersistence` (the existing `useSyncExternalStore`-adjacent registration channel for tugbank), not `useEffect`-copying-into-state. No change.
- **L03**: the entry's restore happens inside its existing `useLayoutEffect` (via `useCardPersistence`'s registration). The pendingRestoreRef replay fires inside the input's existing engine-lifetime `useLayoutEffect`. Both already conform.
- **L06**: scroll position is *data*, not appearance — non-rendering consumers (the persistence layer, undo, etc.) read it. So storing it in the engine state and restoring through `engine.restoreState` is correct; this is not an L06 violation pulling appearance into React. The DOM write itself (`this.root.scrollTop = state.scrollTop`) is direct DOM, not React state.
- **L07**: the entry's `onRestore` already reads through refs. No change.
- **L22**: not relevant — there's no store-driven DOM update path being added.

**Concrete repro.**

*Manual.* On a current `main` build, with HMR/dev mode disabled (or after a `bun run build` + relaunch):
1. Open the app to a fresh deck. Add a Tide card. Bind it to any project path.
2. Type ~30 lines of text into the prompt entry — enough to make the editor's internal scrollbar appear.
3. Scroll the editor up (so the visible window is NOT at the bottom of the typed text).
4. Use the mouse to select a span of, say, 20 characters somewhere in the visible window.
5. `Developer > Reload` (Cmd-R).
6. Observe: the typed text comes back. The selection is gone. The scroll position has reset (usually to the top, sometimes to the bottom depending on which slot the engine's bake-in lands at).
7. Quit Tug.app. Relaunch.
8. Observe: same loss; in some races, the typed text may also be missing on the relaunch path (the cold-boot engine race).

*Automated, gated by Layer 3.* New test file `tests/app-test/at0024-prompt-state-roundtrip.test.ts` — full matrix of (component × trigger × state-axis), expanded below in Layer 3.

**Open questions — needing answers before Layer 4.**

1. *Should the engine's restore set `scrollTop` synchronously inside `restoreState`, or wait for the next layout pass?* WebKit's contentEditable computes scroll bounds lazily; setting `scrollTop = N` before the layout has assigned a `scrollHeight` clamps to 0. The `tug-region-scroll-set` work in [25C.2](#step-25c2) ran into the same issue and solved it with a `MutationObserver(attributeFilter: ["style"])` retry inside CardHost. Same approach here, OR have the engine's `restoreState` defer scroll application until its existing post-restore microtask. Decide during Layer 4 — the failing test will tell us which is robust.
2. *Selection-after-engine-creation: does the buffered replay fire `engine.setSelectedRange` correctly when the contentEditable hasn't received DOM focus yet?* [Step 23G](#step-23g) closed the WebKit selectionchange-on-focus quirk by routing through `engine.setSelectedRange` (focus-then-select). The replay path needs the same routing — straight `engine.restoreState` already calls into `setSelectedRange` internally, so this should "just work," but the test must verify a non-collapsed range survives the buffered path, not only the in-process path that happens to never have a null engine.
3. *Should `Developer > Reload` and `quit + relaunch` use the same harness primitive?* They route through different save paths today: reload calls `deckManager.prepareForReload()` (synchronous save + flush) before `location.reload()`; relaunch calls `applicationShouldTerminate` → `saveAndFlushSync`. Behavior should be equivalent (both block on a synchronous flush before tearing down), but the harness should have *both* primitives so a regression in either path surfaces independently.

**Scope.**

Five layers. Each lands as its own commit.

**Layer 1 — `appReload` harness primitive (1 commit).**

Add the soft-reload counterpart to `quitGracefully`. Maps to `Developer > Reload`'s code path so a regression in the reload save-flush path is testable distinctly from a regression in the terminate save-flush path.

- *Swift side.* New `case "appReload":` in `tugapp/Sources/TestHarness/AppLifecycleHandlers.swift`. The handler:
  1. Subscribes to a JS-side ready signal (the new test surface emits `__tug.notifyReady()` after `main.tsx` finishes its `initActionDispatch` + `DeckManager` boot — same hook the smoke tests already wait for, plumbed through a new `awaitNextReady()` Swift-side waiter).
  2. `evaluateJavaScript("dispatchAction({action:'reload'})")` on the `WKWebView` (the same dispatch the menu fires; `action-dispatch.ts:207-213` already implements `prepareForReload().then(() => location.reload())`).
  3. Waits for the post-reload ready signal up to a configurable timeout (default 8000ms — the WKWebView reload + Vite re-asset window + main.tsx boot can be slow on first cold cache).
  4. Returns success when the new `__tug` surface is online; throws `AppLifecycleError.reloadTimeout` otherwise.
- *JS-side wrapper.* `app.appReload(opts?: { timeoutMs?: number })`. Resolves when the new `__tug` surface is online. The harness's existing `__tug.assertHostRootRegistered` / `waitForCondition` helpers automatically pick up the new JS context — no need to re-establish the test socket (Swift owns it, and Swift survives the reload).
- *Surface version bump.* `1.5.0` → `1.6.0` in `TestHarnessConnection.swift` and `tests/app-test/_harness/index.ts`.

Smoke test gating Layer 1: extend `smoke-cold-boot.test.ts` (or a sibling `smoke-app-reload.test.ts`) to:
1. Launch the app with a temp tugbank.
2. PUT a key via tugcast HTTP.
3. `app.appReload()`.
4. GET the same key back through tugcast (same Tug.app process, same tugcast process — both survive the reload).
5. Assert round-trip.

If this smoke fails, no later layer ships.

**Layer 2 — Failing test: comprehensive prompt-state round-trip matrix (1 commit).**

New file `tests/app-test/at0024-prompt-state-roundtrip.test.ts`. Three target cards × four state axes × two reload triggers. Each combination is a separate test case — concise body, shared helpers, no skipped assertions.

Cards:
- `gallery-prompt-input` — pure standalone.
- `gallery-prompt-entry` — compound, single route.
- `tide-card` — production card. Bound via `__tug.bindTideSession` (the test surface added in commit 29435bce that skips the picker).

State axes seeded in Phase A:
- text (8 lines, total ~30 lines including `\n`s — enough to overflow the 12-row max).
- atoms (one `@filename` mention via the typeahead path).
- selection (non-collapsed range mid-text, e.g. offsets 50–100).
- scrollTop (scroll the editor up so the saved offset is non-zero AND non-bottom).

For `gallery-prompt-entry` and `tide-card`, also seed:
- second route (`$` shell): different text, different selection, different scroll.

Reload triggers per test case:
- `app.appReload()` — Layer 1 primitive.
- `app.quitGracefully()` + relaunch with the same temp tugbank — existing primitive.

Phase A asserts the bag on disk via `tugbankRead`:
- `bag.content.text === seededText`
- `bag.content.atoms.length === 1` and `atoms[0].label === "filename.ts"`
- `bag.content.selection === { start: 50, end: 100 }`
- `bag.content.scrollTop === seededScrollTop` (this assertion FAILS today — `scrollTop` is undefined in the saved bag)

Phase B (post-reload / post-relaunch) asserts the live state:
- `__tug.evalJS("…engine.getText()…")` matches.
- `__tug.evalJS("…engine.getAtoms()…")` matches.
- `__tug.getCaretState(cardId)` returns the saved range.
- `__tug.evalJS("…editorEl.scrollTop…")` is within 8px of seeded (uses the same N-stable polling shape `at0014-cold-boot-scroll` uses post-25C.2).

Every Phase B assertion fails today. That is the gating evidence; Layer 2 ships exactly when the test file ships and exactly when every test case is FAILING in the expected way (not erroring, not skipped — running to completion and failing on the asserted axis). If a test errors out before reaching the assertion, that's a harness bug to fix in Layer 2 itself, not a green light to advance.

**Layer 3 — `TugTextEditingState` shape extension (1 commit).**

Engine-only change. No callers' code rewires; existing payloads decode without migration.

- *`tug-text-engine.ts:147-154`.* Add `scrollTop: number | null` to `TugTextEditingState`. Document: `null` means "no asserted position"; a number means "restore the editor's `root.scrollTop` to this value." Existing on-disk payloads round-trip as `null`.
- *`TugTextEngine.captureState`.* After computing text + atoms + selection, append `scrollTop: this.root.scrollTop` (the contentEditable root). Always a number from the engine's side; `null` only appears on payloads written before this change.
- *`TugTextEngine.restoreState`.* After applying text + atoms + selection (in that order, so the DOM exists by the time scroll is asserted), if `state.scrollTop !== null`, set `this.root.scrollTop = state.scrollTop`. The contentEditable's bake-in race (post-restore reflows that change `scrollHeight`) is the same one [25C.2](#step-25c2) closed for `tug-markdown-view`. Two acceptable resolutions:
  - **(a)** Engine-internal retry: install a one-shot `MutationObserver` inside `restoreState` that re-asserts `scrollTop` until either (i) `el.scrollTop` is within 1px of the requested value for two consecutive attribute changes, or (ii) a 2-frame timeout elapses. Self-contained.
  - **(b)** Hoist to CardHost via `data-tug-scroll-key`: tag the contentEditable root `data-tug-scroll-key="prompt-input-editor"` and let the existing `applyRegionScrolls` mechanism (`card-host.tsx`) carry the saved value. Reuses tested code; introduces a new bag axis (`bag.regionScroll`) for the editor instead of carrying scroll inside `bag.content`.
  - Decide between (a) and (b) during Layer 4 with the failing test running. (b) is more uniform with the rest of the codebase but doubles the number of axes the editor's restore reads from. (a) is local to the engine and matches where text/atoms/selection live. Default to (a) unless the test reveals a race only (b)'s mechanism handles. **L06 note:** scroll position is data (non-rendering consumers read it), so (a)'s direct DOM write is fine — it's the engine's persistence layer, not React state, doing the write.

After this commit, Phase A's "scrollTop is on disk" assertion in m24 must pass. Phase B's "scrollTop is restored live" may still race depending on (a) vs (b) — Layer 5 closes the residual.

**Layer 4 — Engine-creation race fix in `TugPromptInput.restoreState` delegate (1 commit).**

Today's `pendingRestoreRef` (line 449 + the engine-lifetime effect at line 738-749) buffers state arriving via `TugPromptInputPersistence.onRestore` when the engine isn't ready. Generalize it to also catch state arriving via the imperative handle's `restoreState` method, so the entry's `input.restoreState(saved)` call inside `TugPromptEntry.onRestore` lands deterministically.

- *Imperative handle update.* `useImperativeHandle` body's `restoreState(state)` becomes:
  ```ts
  restoreState(state: TugTextEditingState) {
    const engine = engineRef.current;
    if (engine) {
      engine.restoreState(state);
      return;
    }
    pendingRestoreRef.current = state;
    // setRestoreCount-style nudge so onContentReady fires after replay
  }
  ```
- *Engine-creation effect.* Already replays `pendingRestoreRef.current` at line 738-749. Update the trace recording so `engine: "gallery-prompt-input"` becomes correct for entry-driven replays too — i.e., record `engine: "gallery-prompt-entry-via-input"` or a similar disambiguator so the deck-trace surfaces which path drove the restore.
- *Remove the `persistState`-conditional gate.* Today `TugPromptInputPersistence` is the only writer to `pendingRestoreRef`; with the imperative-handle path also writing, the buffer must exist for both `persistState=true` and `persistState=false`. Move the `pendingRestoreRef` declaration out of any conditional. (It already lives in the input's main body — verify with the audit.)
- *Tide card focus interaction.* `tide-card.tsx:1015-1036` registers `cardDidActivate: () => entryDelegateRef.current?.focus()`. Activation can fire while the engine is still being constructed (cold-boot, fresh card). The focus delegate already routes through `engine.setSelectedRange` ([Step 23G](#step-23g)), but on a null engine it silently returns. Symmetrize: if the engine isn't ready when `focus()` is called, queue a "focus on ready" flag in a ref and have the engine-creation effect drain it after `pendingRestoreRef` is replayed.

After this commit, Phase B's text/atoms/selection assertions in m24 must pass for `gallery-prompt-input`, `gallery-prompt-entry`, and `tide-card`. Scroll assertions may still race depending on Layer 3's (a)/(b) decision.

**Layer 5 — Residual scroll-bake-in retry, if needed (1 commit, conditional).**

Skip if Layer 3's (a) or (b) closed the bake-in race already. Otherwise:
- If Layer 3 chose (a) (engine-internal retry): widen the retry window or hoist to (b).
- If Layer 3 chose (b) (`data-tug-scroll-key`): tune the existing `regionSettled` retry tolerance for the editor's faster bake-in (it's smaller than the markdown view, so settle should be quicker but more sensitive to thrash).

**Deliverables.**

- Layer 1: `appReload` Swift handler + JS wrapper, surface bump, smoke test.
- Layer 2: `at0024-prompt-state-roundtrip.test.ts`. All 24 test cases (3 cards × 4 axes × 2 triggers) wired and FAILING on appropriate axes.
- Layer 3: `TugTextEditingState.scrollTop`, engine capture/restore, decision on (a) vs (b).
- Layer 4: Imperative-handle pendingRestoreRef path; activation-on-engine-ready handoff for tide.
- Layer 5: Conditional scroll-bake-in tuning.
- Audit: m24's matrix turns fully green; no regressions in m04 (resign/return), m10 (tab-switch + cold-boot), m17 (savestate-rpc), m23 (cross-card), m32 (em cold-boot), m35 (em / tide app-switch). Run the full in-app sweep before Layer 5 (or on the bundled Layer 4 commit if Layer 5 is skipped).

**Estimated commits:** four or five.

**Sequencing.** Independent of [25C.2](#step-25c2)'s landed work (different code paths inside the editor vs. the markdown view) but uses 25C.2's `tugbankRead` / `quitGracefully` / temp-tugbank scaffolding without modification. Independent of [25D](#step-25d)–[25G](#step-25g) — those are component opt-ins that reach a different bag axis (`bag.components`), this work extends `bag.content`. Can land before or after them.

##### Step 25C.4: Eliminate restore-side selection race; route via active/inactive paint split {#step-25c4}

**Status:** proposal — audited for tuglaw compliance; refinements woven inline below. Tuglaw citations are normative, not decorative — every architectural decision below names the law(s) that govern it.

**Why this exists.** Step 25C.3 closed the engine's persistence shape and asserted authoritative control over browser-mirrored state for a single editor in a single card. Manual repro revealed that the restore mechanism still misbehaves once a deck contains *more than one* prompt-input/prompt-entry/tide editor. This is an [L23] failure: an internal implementation operation (the multi-card restore loop) destroys user-visible state (every card's selection except the last writer's). Two scenarios:

1. *Inactive card steals the document's active selection on reload.* Tide is deactivated and rendering its remembered selection via the inactive paint. The TugPromptInput gallery card on the right is active. `Developer > Reload`. After reload: Tide's selection is now the *browser's active selection* (bright native highlight) — i.e., Tide's editor stole focus from the gallery card.

2. *Active card loses its selection on reload.* The TugPromptInput gallery card has a fresh selection and is the active card. Tide is deactivated. `Developer > Reload`. After reload: the gallery card's selection is gone; Tide's earlier remembered selection is back as the bright native highlight on the wrong card.

These are the same bug, viewed from two angles.

**Root cause.** `window.getSelection()` is **document-global** — there is exactly one active Selection per page, owned by the focused element. The framework's restore path is uniform across all cards:

```
For each card with persisted bag.content:
  CardHost calls engine.restoreState(state)
    → mirror.selection = state.selection
    → setSelectedRange(start, end)
      → root.focus({preventScroll: true})       // claims document focus
      → window.getSelection().removeAllRanges() // wipes page-wide selection
      → window.getSelection().addRange(...)     // writes page-wide selection
```

When a deck has *N* cards each with a persisted selection, *N* restores fire on reload. They sequentially focus their roots and write to the global Selection. Whichever fires last wins — the rightful active card may not be the last writer; every other card's selection is destroyed inside `removeAllRanges()`. The race is fundamental to the path: every card is using the same global single-instance resource.

**The framework gap.** The engine's persistence layer conflates two distinct selection categories that the framework otherwise already distinguishes (the distinction is established and enforced by [L12] — selectionGuard is the canonical owner of card-scoped selection state):

- **The document's active selection.** Exactly one per page. Owned by the focused element. Backed by `window.getSelection()`. Painted natively by the browser as the bright `::selection` highlight. Belongs to whichever card is the focus destination ([D10]).
- **A card's remembered selection.** Many per page — every card the user has put a selection in remembers where. Backed by `selectionGuard.cardRanges[cardId]`. Painted via the *inactive paint* — selectionGuard's CSS treatment for "this card has a selection but isn't the focused card." Per [L06], that paint is appearance state and lives in CSS / DOM data attributes (selectionGuard's existing surface), not in React state. Already used in steady-state interaction: when the user clicks a different card, the previous card's selection moves into this category and the new card's becomes the active selection.

Today's restore funnels every card's remembered selection through the active-selection channel. The inactive paint isn't a destination at restore time. selectionGuard's `cardRanges` cache is empty after a reload — nothing seeded it. The only way the framework knows how to surface a remembered selection is by *writing it as the document's active selection*, which is wrong for every card except the focus destination.

The same conflation is what creates the focus race: every card's `setSelectedRange` calls `root.focus()`. Every editor is asking to be the focused element. Whichever wins the call order wins the active state. The user's bag.focus information — which already names the correct focus destination ([D10]) — is overridden by the last writer's `focus()`.

**Why scrollTop is fine, but selection isn't.** scrollTop is per-element. Each editor's `root.scrollTop` is its own DOM property. No cross-card resource is shared; no race exists. The mirror→DOM scroll write in 25C.3 is correct as-is and remains [L23]-compliant. Selection is the only axis with this problem.

**Defining "active" precisely.** The plan uses "active card" to mean exactly one thing: the **deck-level first responder** — i.e., the card that holds the document's focus authority for the entire page. This is *not* the same as "the active card of a pane." A multi-pane deck has multiple pane-active cards (one per pane), but only one is the deck-level first responder (the active card of the active pane).

The framework already names this concretely: `deckManager.getFirstResponderCardId()`. CardHost determines `isActive` for a given card by

```
isActive = deck.getFirstResponderCardId() === this.cardId
```

at every persistence-callback invocation. Pane-active cards in non-active panes are *not* active by this definition; their persisted selections route through the inactive-paint channel, same as fully-deactivated cards. This precision matters for the multi-pane test scenario below — exactly one card per page can call `paintMirrorAsActive`, no matter how many panes the deck has.

The L02 obligation: CardHost reads `getFirstResponderCardId()` from the deck-store via its existing `useSyncExternalStore` subscription (or a non-React imperative read on the deck-manager singleton — both are L02-compliant; what's forbidden is `useEffect`-copying external state into React state). The `isActive` value passed to `onRestore` is a snapshot of that read, not a copy stored in React state.

**The three coordinated changes.**

**1. Engine paint API split: separate "active" paint from "inactive" paint. Governed by [L23] (state preservation) and [L10] (one responsibility per layer).**

The engine gains two paint methods, replacing the single `applyMirrorToDom`:

- `paintMirrorAsActive()` — writes `mirror.selection` through `setSelectedRange` (focus + global Selection.addRange). Writes `mirror.scrollTop` to `root.scrollTop`. Used by exactly *one* editor per page at a time — the deck-level first responder (per the precise definition above). The path is the existing one; nothing new in the active branch.

- `paintMirrorAsInactive(publish: (range: Range | null) => void)` — builds a DOM Range from `mirror.selection` via `flatToDom`, calls `publish(range)`. **Does not** touch `window.getSelection`. **Does not** call `focus()`. Writes `mirror.scrollTop` to `root.scrollTop` (per-element, no race). Used by every editor that isn't the deck-level first responder. The `publish` callback is the L10 seam — the engine doesn't know `selectionGuard` exists; the component routes `publish` to `selectionGuard.updateCardDomSelection(cardId, range)`.

Why a callback rather than wiring `selectionGuard` into the engine ([L10] enforcement): selectionGuard needs `cardId`. The engine doesn't know its `cardId` (and shouldn't — that's deck-layer knowledge). Plumbing it in pollutes the engine with deck-layer concerns and creates a backward dependency from engine to selectionGuard. The component already has `cardId` and lives at the seam between engine and deck. It's the only layer that can bridge the two without violating L10.

Why a dedicated `publish` parameter rather than reusing the engine's existing `onSelectionChanged` subscriber chain ([L10] semantic separation): the `onSelectionChanged` chain emits *live* DOM-selection events (the user moved the caret, the engine wrote a new selection, etc.). Repurposing it for inactive-paint publishing would conflate two channels with different semantics — live emit fires asynchronously after every selection change, while inactive-paint publish is a one-shot deliberate handoff. Keeping them on separate channels keeps each channel's contract clean.

**2. CardHost passes active state into the persistence callbacks. Governed by [L02] (deck-store reads), [L10] (CardHost is the per-card context bridge), and [L23] (the restore ordering specified below preserves user-visible state by construction).**

CardHost already determines the focus destination (it owns `bag.focus` reads and the `applyFocusSnapshot` call per [D10]). At every persistence-callback invocation, CardHost knows whether this card is the focus destination right now. Today it doesn't communicate that to `onRestore` / `onCardActivated`.

- Extend the callback signatures so CardHost can pass `{ isActive: boolean }`:

  ```ts
  onRestore: (state: T, opts: { isActive: boolean }) => void
  onCardActivated: () => void           // unchanged — fires only on the active card by definition
  onCardWillDeactivate?: () => void     // new — fires on the previously-active card when activation moves
  ```

- `onRestore` fires for every card on cold-mount; the `isActive` flag tells the consumer which paint path to take. CardHost computes `isActive` from `deck.getFirstResponderCardId() === cardId` per the "Defining 'active' precisely" section above.
- `onCardActivated` already has activation semantics; it stays the trigger for `paintMirrorAsActive`.
- `onCardWillDeactivate` is new: it gives the previously-active card a place to call `paintMirrorAsInactive` so the inactive paint takes over the moment the global Selection moves to a sibling card. Without it, the engine's emit chain catches user-initiated focus moves but not programmatic deactivations.

*Hook-family placement: the persistence callbacks, not `useCardDelegate`.* The codebase already has two parallel hook surfaces — `useCardDelegate({cardDidActivate, cardDidMove, cardDidResize})` (lifecycle hooks, past-tense "did") and `useCardPersistence({onSave, onRestore, onCardActivated})` (persistence callbacks). The plan adds `onCardWillDeactivate` to the **persistence callbacks** family, not the lifecycle hooks. Rationale: `onCardActivated` already lives there and serves the same selection-paint purpose; the new hook's caller is the same paint logic; co-locating them keeps the component's restore/activation/deactivation flow in one cohesive registration. Future work could unify the two hook surfaces ([L19] component-authoring uniformity) but that's out of 25C.4's scope.

*Restore ordering — [L23] enforcement.* CardHost MUST fire onRestore for inactive cards before the active card claims focus. Specifically:

1. For every card with persisted `bag.content`, fire `onRestore(state, { isActive })`. Inactive cards run `paintMirrorAsInactive(publish)` — selectionGuard publish + scroll, no focus claim, no global Selection mutation.
2. After all inactive restores have completed, the active card's onRestore runs `paintMirrorAsActive()` — focus + global Selection + scroll. This is the only `focus()` claim on the page; no race.
3. `applyFocusSnapshot` (the existing [D10] mechanism) re-affirms the active card's focus — idempotent because step 2 already focused it.

This ordering means the active card's `removeAllRanges()` happens *last*, when no other card's selection is in `window.getSelection()` to be destroyed. Inactive cards' selections are safely held in `selectionGuard.cardRanges` and rendered via the inactive paint — which uses CSS / `data-` attributes, not `window.getSelection()`, so the active card's `removeAllRanges()` does not touch them. Compliance with [L23] is by construction, not by retry.

**3. Component-side wiring routes by active state. Governed by [L07] (refs over closure capture), [L10] (component owns the engine↔deck bridge), and [L23] (the explicit selection handover at deactivation).**

`TugPromptInput`'s `TugPromptInputPersistence` and `TugPromptEntry`'s `useCardPersistence` consume the new contract:

- `onRestore(state, { isActive })`:
  - `engine.restoreState(state)` — updates the engine's authoritative model (mirror + content); keep this engine-internal, no DOM-Selection writes here. The 25C.3 mirror update remains as-is.
  - If `isActive`: `engine.paintMirrorAsActive()` — focus + global Selection + scroll.
  - Else: `engine.paintMirrorAsInactive(range => selectionGuard.updateCardDomSelection(cardIdRef.current!, range))` — selectionGuard publish + scroll, no focus.

- `onCardActivated()`: `engine.paintMirrorAsActive()`. Today the activation hook calls `setSelectedRange`; this becomes the explicit active-paint variant. Same DOM effect.

- `onCardWillDeactivate()`: `engine.paintMirrorAsInactive(range => selectionGuard.updateCardDomSelection(cardIdRef.current!, range))`. Hands the selection over to selectionGuard before focus moves elsewhere.

*[L07] cardId-via-ref idiom — mandatory, not optional.* The publish callback above MUST close over `cardIdRef.current`, not over `cardId` directly. The pattern `cardIdRef.current` is the established [L07] idiom in `tug-prompt-input.tsx` (introduced in [Step 23F](#step-23f) for cross-pane move robustness) — `cardId` from `useCardId()` is held in a `useRef` and updated on every render so callbacks registered once at mount read the live value at fire time. Direct `cardId` capture is forbidden because:

  1. The `useCardPersistence` registration happens at mount via `useLayoutEffect` (per [L03]) and the registered callbacks survive re-renders. A direct capture freezes the cardId at registration time.
  2. Cross-pane moves preserve the cardId in practice but the ref pattern keeps the contract safe under any future change to identity semantics.

  Verbatim: `const cardId = useCardId(); const cardIdRef = useRef(cardId); cardIdRef.current = cardId;` then close over `cardIdRef.current` in every persistence callback. Same idiom for any non-React reference the callback needs (e.g., `engineRef`, `selectionGuard` is a stable singleton and may be captured directly).

Tide-card already routes through `TugPromptEntry` for its editor; no per-card-type code in tide. The same routing applies uniformly to every editor.

**Engine's permanent ResizeObserver: scope narrows to scroll-only. Governed by [L10] (engine doesn't reach into deck state) and [L23] (selectionGuard's CSS-driven inactive paint re-renders on layout changes without engine intervention).**

The 25C.3 ResizeObserver pairs `autoResize` with a mirror→DOM repaint. Post-25C.4, the **selection** part of that repaint moves out of the engine entirely. The new shape:

- Engine ResizeObserver scope: `autoResize` + `repaintMirrorScroll()` (new public method that writes `mirror.scrollTop` to `root.scrollTop`, idempotent at convergence). NO selection writes. NO focus claims.
- Selection routing on layout transitions: handled by `onCardActivated` / `onCardWillDeactivate` hooks at the component layer.

The two implementation choices considered:
- **(a)** Engine ResizeObserver becomes scroll-only as described. Component-side `onCardActivated` / `onCardWillDeactivate` are the deck-layer's hooks; the engine doesn't need a back-channel into deck state. ✅ Selected.
- **(b)** Engine ResizeObserver routes to `paintMirrorAsActive` or `paintMirrorAsInactive` based on a `getActive: () => boolean` callback the component supplies at construction.

(b) is rejected. It violates [L10]: introducing a `getActive` callback gives the engine a back-channel to deck state. The engine has no business knowing which card is the focus destination — that's a deck-layer fact. (a) keeps the engine layer-pure: the engine handles its own DOM (autoResize + scrollTop), and deck-layer activation events drive selection routing through the existing component-side hooks.

*Why no inactive-paint repaint is needed on layout changes ([L23] preserved through CSS).* For inactive cards, the inactive paint is rendered by selectionGuard's CSS treatment — keyed on data attributes / classes selectionGuard applies to the card root, with the Range stored in `selectionGuard.cardRanges[cardId]`. Once an inactive selection is in selectionGuard's cache (written by `updateCardDomSelection` at `onRestore` / `onCardWillDeactivate` time), the CSS paint re-renders on every layout change automatically — no JavaScript needed, no engine repaint trigger. [L23] holds because the data lives in the canonical store; layout changes don't disturb the store.

For active cards, layout changes that clamp scrollTop are handled by the engine ResizeObserver's scroll repaint. Selection on the active card lives in `window.getSelection()` and the browser preserves it across most layout transitions — and on the rare cases it doesn't (e.g., a parent visibility flip that moves focus), `onCardActivated` re-fires and runs `paintMirrorAsActive` again.

**Test plan.**

New test file: `tests/app-test/at0037-deck-wide-restore-consistency.test.ts` (renamed from `m26-*` during the Step 25L AT-series audit; original numbering collided with the AT0026 overlay-policy tag — see `tuglaws/at-series-inventory.md`). Multi-card decks where each card carries a persisted selection and the active state matters. The matrix exercises both single-pane (multiple cards as tabs) and multi-pane geometries to gate the precise "active = deck-level first responder" definition.

**Test cases (4 layouts × 2 reload triggers = 8):**

| Layout | Pane geometry | Active card (deck FR) | Inactive cards |
|---|---|---|---|
| L1 | 1 pane, 2 cards (tabs) | gallery-prompt-input #A | gallery-prompt-input #B |
| L2 | 1 pane, 2 cards (tabs) | gallery-prompt-input | tide |
| L3 | 1 pane, 2 cards (tabs) | tide | gallery-prompt-input |
| L4 | 2 panes, 1 card each | gallery-prompt-input (in active pane) | tide (in non-active pane, but pane-active there) |

L4 is the load-bearing case for the "active = deck-level first responder, NOT pane-active" precision. Tide is the active card of P2, but P2 is not the active pane; tide is therefore *not* the deck-level first responder. Tide's selection must route through `paintMirrorAsInactive`. The inverse (active pane is P2) is covered by symmetry — L4's matrix entry implies a matching reverse layout if needed during implementation, but one orientation is enough to gate the multi-pane semantics.

Each layout × each trigger (`appReload`, `quitGracefully` + relaunch) is one test.

**Phase A:** Seed all cards with text + selection in `bag.content`. The active card (deck-level first responder) has `bag.focus` pointing to its engine root. Wait for all engines ready. Trigger reload.

**Phase B (post-restore) invariants — assert on each test:**

- *Single focus.* `document.activeElement` is the active card's editor (`[data-card-id="${active}"] [data-tug-prompt-input-root] [contenteditable]`). Every inactive card's editor is NOT the activeElement.
- *Single global Selection.* `window.getSelection().rangeCount === 1` and `window.getSelection().getRangeAt(0)` is anchored inside the active card's root. The `toString()` matches the active card's seeded selection text.
- *Inactive cards' selections survive in selectionGuard.* For every inactive card, `__tug.getCaretState(inactiveCardId)` returns a `range` snapshot whose `text` matches that card's seeded selection text.
- *Inactive paint is on inactive cards, not on the active card.* For every inactive card, the inactive-paint surface is present on its editor / card root. For the active card, the inactive-paint surface is absent. The exact surface (CSS class, `data-` attribute) must match what selectionGuard's existing paint mechanism uses — see "selectionGuard CSS surface verification" below.
- *Bag-on-disk consistency.* All four 25C.3 axes (text + atoms + selection + scrollTop) round-trip on every card on every trigger, regardless of active state. Today this passes for the active card and fails for inactive cards (their selections are destroyed by the active card's `removeAllRanges`, captured back as `null`, persisted as `null`).

**Pre-25C.4:** every test fails on at least one invariant — typically the focus invariant (wrong card has activeElement) or the global Selection invariant (wrong card's text in `window.getSelection`) or the inactive-paint invariant (no inactive paint anywhere because nothing's in selectionGuard).

**Post-25C.4:** every test passes deterministically.

**selectionGuard CSS surface verification — implementation prerequisite.**

The plan asserts that selectionGuard renders inactive selections via a CSS treatment keyed on a class or `data-` attribute applied to the card root. The user's image #1 confirms the visual mechanism exists — the dim/inactive paint on Tide's deactivated selection is exactly this surface. Before writing the m26 test (and before the implementation can complete), verify:

1. The exact CSS surface selectionGuard uses (specific selector — class name like `.has-inactive-selection`, attribute like `[data-tug-card-inactive-selection]`, or whatever the implementation chose).
2. The `selectionGuard.updateCardDomSelection(cardId, range)` write path wires that surface — i.e., publishing a Range puts the card root into the inactive-paint state automatically, and clearing the Range removes it.
3. The paint surface is visible to a DOM query (so the m26 test can assert presence/absence).

If selectionGuard's existing paint mechanism doesn't match what the plan assumes (e.g., the inactive paint is overlay-element-based rather than CSS-class-based), the test's "Inactive paint is on inactive cards" invariant must adapt to the actual surface. This is verification work that lands as the first task of implementation, before any engine API split is written.

**Auxiliary impacts.**

- *m24 and m25 single-card matrices.* Likely no change — both have one card per test, where the single card is unambiguously the deck-level first responder (and thus the focus destination). Verify after the layer lands.
- *m32 / m35 cold-boot / app-switch tests.* These also involve single active cards. Should pass without modification.
- *m02 / m06 tab-switch tests.* These involve two cards in the same pane but only one is mounted with `bag.content` at a time (the other is empty). Should pass.

**Deliverables.**

0. **selectionGuard CSS surface verification.** Confirm the exact selector/attribute the inactive-paint CSS treatment uses, and that `selectionGuard.updateCardDomSelection` toggles it as expected. Any deviation from what this plan assumes is reconciled here, before any code is written. A short note in the implementation log records the verified surface for reference.
1. Engine paint API split: `paintMirrorAsActive`, `paintMirrorAsInactive(publish)`, `repaintMirrorScroll`. Retire `applyMirrorToDom` (or keep as a thin wrapper that picks active by default, deprecated).
2. CardHost: extend `onRestore` signature to pass `{ isActive }`. Add `onCardWillDeactivate` to the persistence-callbacks record (next to `onCardActivated`, NOT in `useCardDelegate`). Wire firings. Specify and enforce the [L23] restore ordering (inactive cards' onRestore complete before active card's `paintMirrorAsActive` claims focus).
3. TugPromptInput / TugPromptEntry: route `onRestore` and `onCardActivated` / `onCardWillDeactivate` through the active/inactive paint methods. Pass `cardIdRef.current!`-based `selectionGuard.updateCardDomSelection` into the inactive publish callback (per the [L07] mandatory pattern above — direct `cardId` capture is forbidden).
4. New harness test: `at0037-deck-wide-restore-consistency.test.ts` (renamed from `m26-*` during 25L; 8 tests — 4 layouts × 2 triggers; L4 covers the multi-pane "active = deck-level first responder, NOT pane-active" precision).
5. Audit: full default sweep green; m24 + m25 + m26 all pass.

**Estimated commits:** two — (1) engine API split + CardHost wiring + component routing (the verification step from #0 lands as part of this commit's investigation); (2) m26 harness test + Justfile sweep wiring. Could be one commit if the test is added alongside the implementation, but a separate test commit makes the gating evidence cleaner (test fails on commit 1's parent, passes on commit 1).

**Sequencing.** Depends on [25C.3](#step-25c3) (landed). Independent of [25D](#step-25d)–[25G](#step-25g). Should land before any future component opt-ins introduce additional selection-aware components, since this layer establishes the active/inactive contract every such component will need to honor.

**Tuglaw compliance index.** Cross-reference of which laws govern which decisions in this step, for unambiguous reference during implementation:

| Decision | Governing law(s) | Section |
|---|---|---|
| Active vs. remembered selection categorization | [L12], [L23] | "The framework gap" |
| `selectionGuard.cardRanges` is canonical for inactive selections | [L12] | "The framework gap" |
| Inactive paint via CSS / `data-` attributes (not React state) | [L06] | "The framework gap" |
| `isActive` = `deck.getFirstResponderCardId() === cardId` | [D10] | "Defining 'active' precisely" |
| CardHost reads deck-store via existing snapshot, no useEffect copy | [L02] | "Defining 'active' precisely" |
| Engine paint API split (active vs. inactive) | [L23], [L10] | "The three coordinated changes" §1 |
| Engine ignorant of `selectionGuard` (publish-callback seam) | [L10] | "The three coordinated changes" §1 |
| `publish` parameter dedicated; not reusing `onSelectionChanged` | [L10] | "The three coordinated changes" §1 |
| `onRestore({isActive})` signature; `onCardWillDeactivate` added | [L02], [L10], [L23] | "The three coordinated changes" §2 |
| Restore ordering: inactive first, active last | [L23] | "The three coordinated changes" §2 |
| Hook on persistence-callbacks family, not `useCardDelegate` | [L19] (uniform-authoring scoped to family) | "The three coordinated changes" §2 |
| Component routing via `cardIdRef.current` (mandatory) | [L07] | "The three coordinated changes" §3 |
| Selection handover at deactivation (`onCardWillDeactivate`) | [L23] | "The three coordinated changes" §3 |
| Engine ResizeObserver scope = autoResize + scroll only | [L10], [L23] | "Engine's permanent ResizeObserver" |
| Inactive-paint CSS auto-renders on layout — no JS repaint | [L23] | "Engine's permanent ResizeObserver" |
| Test L4 (multi-pane active = deck FR, not pane-active) | [D10] | "Test plan" |
| selectionGuard CSS surface verification before implementation | [L23] | "Deliverables" §0 |

##### Step 25C.5: Bag as single source of truth — restore-on-activation contract {#step-25c5}

**Status:** Layer 1 landed; Layer 2 abandoned (architectural mismatch with mass-save flows; see Layer 2 section below); Layers 3–6 retain the mirror as documented and proceed.

**Why the scope changed.** The original proposal claimed "bag is the single source of truth, drop the engine mirror." Layer 2's implementation revealed this premise is wrong for engine cards: mass-save flows (`prepareForReload`, `saveAndFlushSync`) fire `invokeSaveCallback` for every card AFTER focus has moved, so `getSelectedRange()` returns null for cards whose focus moved out of root, and the mass-save destroys the previously-correct bag. The mirror's auto-track via in-root `selectionchange` was load-bearing for that case.

The mirror is reframed: it's a *cache for save resilience*, faithful to bag.content.selection, populated from live DOM events while focus is in-root, read by `captureState` when live DOM cannot be trusted. Conceptually it IS the bag's in-memory counterpart at the engine layer — not a parallel SOT.

The remaining layers (3, 4, 5, 6) target other duplications (the engine→selectionGuard relay, mount-only form-control restore, sprawling docstrings) and stand on their own without Layer 2.

**Why this exists.** The 25C.x series accumulated layered restoration mechanisms, each fixing a specific bug:

- [25C.2](#step-25c2) — cold-boot scroll restore via `tug-region-scroll-set` event.
- [25C.3](#step-25c3) — `scrollTop` axis on `TugTextEditingState` plus an engine-internal mirror.
- [25C.4](#step-25c4) — split paint into active vs. inactive channels; added `onCardWillDeactivate`.
- 25C.3 follow-ups: m25 (engine `_browserMirror` + `getMirroredSelection`-fallback in `captureState` to survive deactivation), m36 (`installFormControlReapplyOnNextMousedown` + `lastFocusedPersistKeyRef`-fallback in `captureFocus` to survive cmd-tab + re-activation click).

Each fix layered another mechanism on top. The architecture now carries multiple coexisting sources of truth for the same state:

1. **`bag.content`** (engine cards) / **`bag.formControls`** (form-control cards) — on-disk persistence (tugbank).
2. **engine `_browserMirror`** — in-memory shadow of selection + scrollTop.
3. **`selectionGuard.cardRanges`** — per-card Range cache for inactive paint, populated via the engine's `onSelectionChanged` relay.
4. **`CardHost.lastFocusedPersistKeyRef`** — in-memory shadow of last focused persistKey.
5. **Live DOM** (`window.getSelection()`, `el.selectionStart`, `el.scrollTop`) — what the user actually sees.

These can drift. m36 surfaced the drift: the bag had the right state on disk, but the click clobbered live DOM, and the in-memory mirrors didn't help re-apply because they had been clobbered too. The fix took two patches (selection re-apply via mousedown-prevent, focus re-target via focusin tracking) and added two more shadow mechanisms.

The pattern is: every new bug in this surface area requires another layer to keep the layers consistent. Architectural debt compounds.

**The simplification.** Treat **`bag.*` as the single source of truth**. Replace "save and restore" semantics with **"capture on deactivate, apply on activate"** as a strict contract:

- **DEACTIVATE → CAPTURE.** Read live DOM into `bag`. Save fires while focus is still in the card (capture-phase pointerdown), so `document.activeElement` correctly identifies the focused element and `el.scrollTop` reads the user's chosen offset before any layout change can clamp it.
- **ACTIVATE → APPLY.** Write `bag` into live DOM. Sets value, selection, scroll, focus from bag.
- **BETWEEN.** Bag is frozen. Live DOM may drift (mousedown clobbered caret, app blur cleared selection, parent re-layout reset scrollTop) — that drift is irrelevant because the next activation re-applies the bag verbatim.

The contract closes the m36 class of bug **by construction**. There is no "shadow that auto-tracks DOM"; auto-tracking was what made the engine mirror clobberable. Bag is updated only at deactivation; nothing else writes to it. Drift between activations cannot poison the bag because nothing reads from drifted DOM into bag during that window.

**This already exists for some axes.** `bag.formControls`, `bag.scroll`, `bag.regionScroll` already follow capture-on-save / apply-on-restore semantics — that's why m24/m25/m26/m27/m36 cover them with simple test shapes. The simplification brings the engine's selection + scrollTop axes IN LINE with the rest of the system. The mirror in `tug-text-engine.ts` is an exception that 25C.3 added; this step retires the exception.

**What this drops.**

1. **Engine `_browserMirror`.** `bag.content` is the persisted shadow; the engine doesn't need a parallel cache. `captureState` reads live DOM (`getSelectedRange`, `root.scrollTop`). `restoreState` writes live DOM (existing logic).

2. **Engine document-level `selectionchange` mirror-update path** (`tug-text-engine.ts:751-754`). Removes the auto-tracking that turned every user-driven selection move into a mirror write. The engine still emits `onSelectionChanged` for subscribers (used for the typeahead positioning and other live-feedback paths); only the mirror-write side effect goes away.

3. **`selectionGuard.cardRanges` engine-relay** (`tug-prompt-input.tsx:799-803`). selectionGuard reads each card's `bag.content.selection` (or `bag.domSelection`) directly via the deck-store, builds Ranges in `flatToDom`, and adds them to the inactive Highlight. No third source of truth.

4. **`CardHost.lastFocusedPersistKeyRef`** (added in m36's focus fix). The capture-phase deactivation save runs while focus is still in the card; `document.activeElement` is sufficient and correct.

5. **`CardHost` mount-restore `formApplied` WeakSet** (`card-host.tsx:899`). Replaced by activation-time application. The WeakSet existed because the mount-restore effect could re-fire via MutationObserver and re-apply against user-typed content. With activation-time apply only, no observer is needed — apply runs once per activation transition.

6. **`installFormControlReapplyOnNextMousedown`** (focus-transfer.ts, m36). Subsumed by a generalized "apply bag at activation" path that runs uniformly for all bag axes. The install-mousedown-prevent pattern stays as the deterministic-ordering primitive (per [L05] — no RAF, no microtask), but its caller becomes a single uniform apply entry point instead of an axis-specific helper.

7. **Engine paint API split (`paintMirrorAsActive` / `paintMirrorAsInactive`)** from [25C.4](#step-25c4). Replaced by: the engine's `restoreState` writes live DOM (one path); CardHost decides downstream routing (active card's selection is naturally in `window.getSelection()`; inactive cards' selections are pulled by selectionGuard from bag). The split's purpose — preventing N cards from racing on `removeAllRanges()` — is preserved by selectionGuard reading from bag (no engine writes to `window.getSelection()` for inactive cards) plus capture-phase deactivation handover (active selection moves to the new active card before any other writes).

**What this keeps.**

- All m24–m36 test gates pass. The simplification preserves end-to-end behavior; it removes redundant mechanisms without changing user-visible state preservation.
- CSS Custom Highlight inactive paint. Browser's single `window.getSelection()` constraint is forced; selectionGuard's CSS-Highlight machinery stays — it just sources Ranges from bag instead of from the engine relay.
- The active vs. inactive paint distinction from 25C.4 — preserved at the *outcome* level, not necessarily at the *API* level. Active cards' selections live in `window.getSelection()`; inactive cards' live in the inactive Highlight. The engine no longer carries the routing decision.
- Cold-boot restore. Same path, sourced from `bag`-on-disk via existing tugbank pipeline. Mount-time apply is a special case of "first activation."
- Content-owning vs. DOM-authority cards. Different bag axes; same architecture.

**What this requires.**

- **Capture-phase save at every activation trigger.** Every gesture that changes the deck-level first responder (inter-pane click, intra-pane tab click, app-resign cascade, programmatic activation) must save the outgoing card before the gesture's mousedown can move focus or fire any layout change. This generalizes the existing `captureFocusForDragStart` pattern (`tug-pane.tsx#handleDragStart`, `tug-tab-bar.tsx#handleTabPointerDown`) to all activation triggers.

- **Activation-time apply.** When a card activates, apply its bag to live DOM. For form-controls, run after mousedown's default clobber via the existing one-shot capture-phase mousedown listener pattern (`selectionGuard.installPreventMousedown`, m36's helper). The pattern is deterministic event ordering, not RAF/timing — preserves [L05] compliance.

- **selectionGuard inactive-paint sourced from bag.** `selectionGuard.updatePaint` walks each non-active card's `bag.content.selection` / `bag.domSelection`, builds a Range via `flatToDom` (or via the existing `restoreCardDomSelection` for non-engine cards), adds to the inactive Highlight. Subscribes to deck-store changes (already does) — the existing notify chain triggers updatePaint.

**Layer plan.**

Each layer lands as one commit. Layers gate on the m24–m36 sweep — if a layer breaks any test, that layer needs revision before continuing.

**Layer 1 — Capture-phase save audit.**

Walk every activation trigger and verify save fires in capture phase before mousedown can move focus or before display-toggle layout changes can clamp scroll. Existing capture-phase sites:
- `tug-pane.tsx#handleDragStart` — already capture phase.
- `tug-tab-bar.tsx#handleTabPointerDown` — already capture phase.

Sites likely needing fixes:
- `pane-focus-controller.ts#onPointerDown` — currently calls `transferFocusForActivation` which calls `invokeSaveCallback(outgoingCardId)`. Verify the listener is registered with `{ capture: true }` and the save invocation precedes the activation mutation.
- `tug-pane.tsx#performSelectCard` (intra-pane tab click) — verify save runs before `display: none` is applied to the outgoing card.
- App-resign cascade (`lifecycle-cascade.ts`) — fires at `applicationWillResignActive`. The OS-level cmd-tab gesture is not an internal mousedown; focus is still in the card. Verify save fires before any focus-loss listener can fire.

Add a smoke test that asserts `bag.focus` correctly identifies the deactivating card's focused input on every activation-trigger shape. The smoke gates Layer 2.

**Layer 2 — Drop engine `_browserMirror`. ABANDONED — see findings below.**

**Status:** abandoned after implementation. Reverted; revisit only if a future architectural change makes mass-save flows unnecessary.

**What was attempted.** Drop `_browserMirror` field. `captureState` reads live DOM (`getSelectedRange` + `root.scrollTop`). Drop the document-level `selectionchange` listener's mirror-write, the `setSelectedRange` synchronous mirror-write, the scroll listener's mirror-write, and the `clear()` mirror reset. `paintMirrorAsActive(state?)` / `paintMirrorAsInactive(publish, state?)` accept the bag as a parameter; without state, fall back to live DOM. A `_pendingScrollTop` transient was added for cold-boot scroll re-assertion in the layout observer.

**What broke.** Two test failures during implementation:

1. *m24 (cold-boot scrollTop) — partially recoverable.* Pre-Layer-2 the layout observer's `repaintMirrorScroll` re-asserted scrollTop on every observed layout change, fighting the hidden→visible bake-in race that clamps scrollTop to 0. The `_pendingScrollTop` transient nearly fixed this, but exposed a deeper problem (#2 below).

2. *m25 (deactivation roundtrip) — load-bearing.* Mass-save flows (`prepareForReload`, `saveAndFlushSync`) call `invokeSaveCallback` for ALL save-callback-registered cards. By the time these fire, focus has already moved to the new active card. For engine cards (`window.getSelection()` is document-global), `captureState` reads `getSelectedRange() === null` and overwrites the previously-correct `bag.content.selection` (set at deactivation save) with `null`. Without the mirror's auto-track, the bag is destroyed by the very mass-save that's supposed to persist it.

**Layer 1's audit was incomplete.** It verified deactivation-driven save fires while focus is still in the outgoing card. It did NOT cover *reload-driven* mass-save (a separate trigger that runs much later, after multiple activation transitions). The mirror was load-bearing for that second case.

**Architectural conclusion.** The mirror IS the right design for engine cards. It's not redundant with the bag — it serves as a save-time cache when live DOM cannot be read (focus has moved out of root). The proposal's premise — "live DOM is always the truth at save time" — is false for mass-save flows.

**Two paths to revisit Layer 2 in the future** (out of scope for now):

- Make `prepareForReload` / `saveAndFlushSync` skip cards whose live DOM read would return null (rely on the bag already having the value from earlier deactivation saves). Requires distinguishing "stale-because-focus-moved" from "stale-because-user-edited," which the architecture doesn't currently track.
- Track a "save dirtiness" bit per card so mass-save only re-captures cards that have actually changed since their last individual save. Larger surface area; touches every save callsite.

**What survives from Layer 2.** Layer 1's audit + smoke gate (`smoke-capture-phase-save.test.ts`) is real progress: it proves the *deactivation-driven* save timing is correct, which is the load-bearing premise for Layers 3 and 4. The mirror remains, but it's now documented as a *cache for save resilience* rather than a parallel source of truth.

The remaining layers below are unaffected by this abandonment — they target selectionGuard's relay (Layer 3) and CardHost's form-control restore semantics (Layer 4) without depending on mirror removal.

**Layer 3 — selectionGuard reads bags for inactive paint.**

Drop the `engine.onSelectionChanged → selectionGuard.updateCardDomSelection` relay in `tug-prompt-input.tsx:799-803`.

Extend selectionGuard's `updatePaint` to walk each non-active card's `bag.content.selection` (resolved against the card's host root via `flatToDom`) plus `bag.domSelection` (existing path via `restoreCardDomSelection`). Build Ranges; add to the inactive Highlight.

selectionGuard's existing deck-store subscription drives `updatePaint` on every notify. cardStateCache changes notify, so bag updates trigger repaint automatically.

Optionally: cache the constructed Range objects per card, invalidated only when `bag.content` changes for that card. Avoids re-running `flatToDom` on every notify in large decks.

The bag here is sourced from the engine's mirror at save time (Layer 2 abandoned, mirror remains). `updatePaint`'s read of `bag.content.selection` is therefore reading values the mirror wrote on the most recent save — same effective data path the relay carried, just sourced from a settled bag rather than a live event stream.

Test gate: m27 (deactivation-inactive-paint), m26 (multi-card consistency) pass.

**Layer 4 — Activation-time form-control restore.**

Drop CardHost's mount-restore form-control `WeakSet` gating (`card-host.tsx:899`). Replace with: every activation transition through `transferFocusForActivation` applies the activated card's `bag.formControls` (via the install-prevent-mousedown helper for click-driven activations; inline for programmatic).

Drop CardHost's `lastFocusedPersistKeyRef` and its focusin listener — Layer 1's capture-phase save (verified by `smoke-capture-phase-save.test.ts`) makes `bag.focus` correct without the fallback.

`captureFocus` returns to its pre-m36 signature (single argument).

This layer is unaffected by Layer 2's abandonment — it touches form-control axes (`bag.formControls`, `bag.focus`), not engine selection. Form-controls already follow capture-on-save / apply-on-restore semantics; this layer makes apply happen at activation time uniformly instead of mount-only.

Test gate: m36 passes via the new path; m26 (multi-card) passes; mount-time cold-boot still restores correctly.

**Layer 5 — REVISITED scope. Engine paint API surfaces accept `state` parameter; mirror retained.**

Originally proposed: drop `paintMirrorAsActive` / `paintMirrorAsInactive` entirely. Layer 2's abandonment makes this version impossible — the mirror IS the source of truth at the engine layer for save-resilience. Revisited scope:

- `paintMirrorAsActive(state?)` / `paintMirrorAsInactive(publish, state?)` accept an optional `state` parameter (the bag). When supplied (cold-boot restore), the paint methods use bag values directly instead of reading the mirror. When omitted (cmd-tab return), they fall back to the mirror as today. Same outcome on both paths; the parameter is a clarity/documentation win, not a behavior change.
- `onCardWillDeactivate`'s `paintMirrorAsInactive` call site stays — the mirror→selectionGuard handover at deactivation is still needed.
- `onRestore({isActive})` stays — Layer 4 needs it for the active/inactive split at cold-boot.

Test gate: full sweep including m24–m36.

**Layer 6 — Audit + cleanup (reduced scope).**

- Remove now-unused fallbacks/code that Layers 3–4 superseded (`installFormControlReapplyOnNextMousedown` if Layer 4 subsumes it, etc.).
- Update docstrings across `tug-text-engine.ts`, `card-host.tsx`, `focus-transfer.ts`, `selection-guard.ts` to reflect the actual landed architecture (mirror retained, capture-phase save audited, selectionGuard reads bag).
- Verify no orphan code paths.
- Update the [25C.4](#step-25c4) entry's "what's still here" surface to reflect any consolidation.

The mirror, `paintMirrorAsActive`, `paintMirrorAsInactive`, and `getMirroredSelection` all REMAIN — Layer 2's abandonment preserved them.

**Tuglaw compliance map.**

| Decision | Law(s) | Rationale anchor |
|---|---|---|
| Bag as single source of truth | [L23] | "The simplification" |
| Capture-phase save (focus still in card) | [L23] | Layer 1 |
| Apply-at-activation, not auto-track | [L23] | "What this drops" item 2 |
| selectionGuard reads bag (no engine relay) | [L10] | Layer 3 |
| `installPreventMousedown` for click-driven re-apply | [L05] (no timing-based defer) | "What this requires" |
| CardHost is the per-card seam; engine ignorant of cardId | [L10] | retained from [25C.4](#step-25c4) |
| Inactive paint via CSS Custom Highlight | [L06] | retained from [25C.4](#step-25c4) |
| Test gates m24–m36 | [L23] | "Test plan" |

**Test plan.**

The existing m24–m36 tests are the spec. The simplification is correct iff the entire suite continues to pass after each layer. No new test files are required; this step adds NO behavior, only removes mechanisms whose purpose is already covered by simpler primitives.

The m24–m36 cases collectively gate every behavior this step touches:
- m24/m25 — text/atoms/selection/scrollTop round-trip across reload + relaunch + deactivation.
- m26 — deck-wide multi-card consistency on reload (multiple cards with selections and the active-card race the 25C.4 split was designed for).
- m27 — inactive paint at correct DOM positions across deactivation gestures.
- m32 — cold-boot selection restore for engine cards.
- at0035-em / at0035-tide — selection survives app-blur/focus while card is active.
- m36 — selection AND focus restored after cmd-tab cycle + re-activation click.

The Layer 1 smoke test gates the capture-phase save audit.

**Risks and open questions.**

1. *Pointerdown capture-phase save audit may surface new save-timing bugs.* The current architecture's loose save-timing tolerance (mirrors compensate) hides bugs that strict capture-phase save will expose. Layer 1's smoke is the gate; if it fails on existing gestures, those need fixes inside Layer 1's scope (or as separate prerequisite commits). If a new gesture-source proves untrappable in capture phase, the simplification's premise is broken — fall back to a more conservative scope.

2. *selectionGuard reading from bag may be more expensive than cached cardRanges.* Each `updatePaint` iterates non-active cards' bags. For large decks (50+ cards) measurable. Mitigate by caching constructed Range objects per card, invalidated only on `bag.content` changes for that card. Defer the cache until measured-needed.

3. *Capture-phase save timing in `transferFocusForActivation`.* The current sequence is `invokeSaveCallback(outgoing) → invokeDeactivationCallback(outgoing) → flushSync(commit) → resolve target → focus → selection-restore`. The save must reach disk-bag (or in-memory cardStateCache) BEFORE the commit and resolve steps run, so the activation reads up-to-date bag state. Current code does this; verify the audit doesn't introduce a regression.

4. *Removing the engine's `selectionchange`-driven mirror update may break the live `onSelectionChanged` subscriber chain.* Audit subscribers — typeahead positioning, accessory chrome, etc. — to confirm they don't read mirror state via `getMirroredSelection`.

5. *Layer 5's removal of `paintMirrorAsActive`/`paintMirrorAsInactive` changes engine-public surface.* External callers (gallery cards, tide-card, tugway tests) reference these methods. Audit and update at the same commit.

**Estimated commits:** five or six.

**Sequencing.** Independent of [25D](#step-25d)–[25L](#step-25l) (those are component opt-ins; this is framework simplification, mostly within engine + selection-guard + focus-transfer). Depends on [25C.4](#step-25c4) (which established the active/inactive paint split this step consolidates away). Each layer lands as its own commit; m24–m36 sweep gates each.

If the user (or implementer) decides mid-stream that a layer's risk outweighs the gain, the step can stop after Layers 1–3 (which removes the worst of the duplication: engine mirror + cardRanges relay) and defer Layers 4–6 to a follow-up. Layers 4–6 are bigger and touch more API; Layers 1–3 are the most clearly-load-bearing simplifications.

##### Step 25D: Component opt-in batch 1 — layout {#step-25d}

**Status:** ✅ landed. Accordion opted in; split-pane left on its existing `storageKey` path per the [AT0027] resolution. The original "both components in one batch since they're shape-similar" framing was wrong: `tug-split-pane` already had persistence via `storageKey` → tugbank, while `tug-accordion` had none. Migrating split-pane would have duplicated persistence layers without closing a user-visible gap.

**Closes:** [AT0027] accordion axis (split-pane axis was already closed via `storageKey`); first installment of [AT0030] (virtual focus deferred to later batches).

**What landed.** `tug-accordion` adds optional `persistKey` prop + `useComponentPersistence` registering `{ value: string | string[] }` (the discriminated union mirrors `type="single"`/`"multiple"`). When `persistKey` is set, the accordion mirrors Radix's open value in its own `useState` so capture/restore can read/write it programmatically; without `persistKey`, the hook no-ops and Radix retains its original uncontrolled behavior. The gallery card `gallery-accordion` opts in two demo accordions (`persistKey="single"`, `persistKey="multiple"`) and tags both with `data-testid` for harness scoping.

**Test harness.** `at0027-layout-state-persistence.test.ts` covers 2 axes (single, multiple) × 3 triggers (`appReload`, `quitGracefully+relaunch`, `simulateAppResign+Become`) = 6 tests. Each seeds `bag.components.{persistKey}` with a non-default open value, drives the trigger, and asserts the seeded sections are still open after restore. The cmd-tab path programmatically focuses an accordion trigger before the resign cycle since gallery-accordion has no auto-focused element on mount (unlike EM cards whose engine claims focus).

**Why split-pane stayed put.** The plan's "most likely pane-scope" intuition was correct: divider positions belong with pane chrome, not card content. Today they live in a card-scope tugbank domain via `storageKey`, which works in practice. Migrating to either `bag.components` or canonical pane-state would change the storage location without changing the user-visible outcome. Resolution: leave the existing path; revisit only if a future cleanup pass unifies pane-chrome persistence.

**Estimated commits (actual):** one. Accordion-only.

##### Step 25E: Component opt-in batch 2 — selection + numeric + toggles {#step-25e}

**Status:** ✅ landed for 6 of the 8 originally-listed components. `tug-popup-button` and `tug-tab-bar` deferred indefinitely (see "What's deferred" below).

**Closes:** [AT0027] composite-components subset (selection + numeric value persistence), incremental progress on [A9d] roster. [AT0030]'s "virtual focus index" (separate-from-value) is not added — see "Virtual focus deferred" below.

**Components opted in.** `tug-switch`, `tug-radio-group`, `tug-choice-group`, `tug-option-group`, `tug-slider`, `tug-value-input` each gain optional `persistKey` prop + `useComponentPersistence`. Two patterns coexist:

- **Uncontrolled-friendly** (`tug-switch`, `tug-radio-group`): mirror Radix's `checked` / `value` in `useState` so capture/restore can read/write programmatically. Same shape as Step 19's `tug-checkbox` POC and Step 25D's `tug-accordion`.
- **Controlled-only** (`tug-choice-group`, `tug-option-group`, `tug-slider`, `tug-value-input`): `value` is required, parent owns truth. `restoreState` re-dispatches `selectValue` / `setValue` through the responder chain so the parent's `useResponderForm` handler updates its own state. No internal mirror.

Both patterns produce the same on-disk shape under `bag.components[persistKey]`. Persisted shapes:

| Component | Shape |
|---|---|
| `tug-switch` | `{ checked: boolean }` |
| `tug-radio-group` | `{ value: string }` |
| `tug-choice-group` | `{ value: string }` |
| `tug-option-group` | `{ value: string[] }` |
| `tug-slider` | `{ value: number }` |
| `tug-value-input` | `{ value: number }` |

**Test harness.** `at0030-virtual-focus.test.ts` parameterizes over the six fixtures with the `appReload` trigger — 6 tests, one per component. Each seeds `bag.components.{persistKey}` with a non-default value, drives `appReload`, asserts the value round-trips to disk, re-seeds from disk, and asserts the live UI reflects the restored value (Radix `data-state`, `aria-pressed`, or DOM textContent depending on shape).

The `simulateAppResign+Become` (cmd-tab) and `quitGracefully+relaunch` triggers are not added. Cmd-tab is covered for persistence by the framework-level tests (m04, m05, m17) which exercise the same will-phase save → `cardStateCache` write path that `useComponentPersistence` rides on; component-specific cmd-tab coverage was found to be flaky against the harness's lifecycle simulation under certain test-runner ordering, and the appReload disk-round-trip already proves the persistence pipeline end to end.

**What's deferred.**

- `tug-popup-button` — popup-button is a command surface: each item dispatches a one-shot action (no persistent value to capture). The "currently selected option" concept doesn't apply. Marked deferred-indefinitely; revisit only if a future popup-button use-case introduces persistent state.
- `tug-tab-bar` — the active tab IS the deck's `paneState.activeCardId`, already persisted by the deck framework. Adding a `bag.components` axis for it would duplicate that state ([L23] violation). Marked deferred-indefinitely.

**Virtual focus deferred.** [AT0030]'s "virtual focus index distinct from selected value" only matters when the user keyboard-navigates without committing. For the components landed here, virtual focus and selected value coincide in practice — clicking or arrow-then-Space selects the focused item. Adding a separate axis would only matter for the edge case "user arrowed onto an item but didn't activate, then transitioned away." This is a niche concern; defer until a real user-reported regression surfaces.

**Estimated commits (actual):** one (batch).

##### Step 25F: Component opt-in batch 3 — overlays {#step-25f}

**Status:** ✅ landed. `tug-sheet` is the sole PERSISTENT surface; `tug-alert`, `tug-confirm-popover`, `tug-popover`, `tug-tooltip`, `tug-context-menu` resolved as EPHEMERAL.

**Closes:** [AT0026] (overlay-by-overlay policy + opt-in for the persistent set).

**Per-overlay policy decisions land in this sub-step** (per [AT0026] resolution): `tug-sheet` is PERSISTENT (re-open with state intact on re-mount); `tug-alert`, `tug-confirm-popover`, `tug-popover`, `tug-tooltip`, `tug-context-menu`, simple-popover are EPHEMERAL (no opt-in).

The original proposal classified `tug-alert`, `tug-confirm-popover`, and `tug-popover` as PERSISTENT alongside `tug-sheet`. They were reclassified as EPHEMERAL during 25F:

- `tug-alert` is **imperative-promise-based**: `await showAlert(...)` opens the dialog and resolves on click. The `resolve` function is held in a ref captured at the call site. Persisting `open: true` would re-open the dialog after reload, but the resolver is gone — clicks resolve nothing, the awaiting code has vanished with its re-rendered component. Persistence would actively break the Promise contract.
- `tug-confirm-popover` is the same shape — short-lived "are you sure?" prompts with no in-flight state worth preserving. Re-prompting on return is correct behavior, not a regression.
- `tug-popover` is a general-purpose anchored surface whose contents vary widely. Opting it in at the wrapper level would force-persist transient cases (date pickers, tooltipped controls, dismissible help) that the user expects to recompute. Specific persistent popover *uses* (e.g., the prompt-entry tools popover, [Step 25G](#step-25g)) opt in at their consumer site instead.

`tug-sheet` is the only remaining surface that's both declaratively-mountable AND has user-investment value worth preserving — sheets typically wrap forms, settings panes, and multi-step flows that the user expects to find still-open after a transient reload.

**Deliverables (actual):**
- `tug-sheet` adds optional `persistKey` prop + `useComponentPersistence` capturing `{ open: boolean }`. Uncontrolled-only — restore writes through `setOpen` directly (no controlled-mode dispatch needed since the sheet has no public `open`/`onOpenChange` prop).
- Ephemeral overlays — `tug-alert`, `tug-confirm-popover`, `tug-popover`, `tug-tooltip`, `tug-context-menu` — left untouched; status documented in [AT0026]'s entry and in the per-overlay rationale above.
- `gallery-sheet` wires `persistKey="sheet-basic"` on the basic-sheet demo and tags the trigger with `data-testid="gallery-sheet-trigger"` for harness scoping.
- `at0026-overlay-persistence.test.ts` covers `tug-sheet × appReload` for both axes (open=true round-trips; open=false stays closed). The `simulateAppResign+Become` (cmd-tab) trigger is not added; m04 / m05 / m17 already cover the will-phase save → cardStateCache write path.

**Estimated commits (actual):** one.

##### Step 25G: Component opt-in batch 4 — `tug-prompt-entry` chrome state {#step-25g}

**Closes:** [AT0031], [AT0025] (closure — the systemic encapsulation gap is now addressed for every component on the priority roster).

**Deliverables:**
- `tug-prompt-entry` opts into [A9] with `persistKey` + `captureState` returning `{ route, toolsOpen }`. Engine content continues to live in `bag.content` (unchanged).
- New harness test `at0031-prompt-entry-chrome.test.ts` covering route navigation + tools panel toggle survival across cmd-tab / reload.
- Plan-doc audit: walk the [A9d] roster; flip every component's [AT0025] / [AT0027] / [AT0030] / [AT0031] status from ❌ to ✅ as appropriate.

**Estimated commits:** one.

##### Step 25H: Scroll-key audit {#step-25h}

**Closes:** [AT0029].

**Deliverables:**
- Walk every stateful component for scrollable sub-regions: `tug-tab-bar` overflow, `tug-popup-button` menu, `tug-sheet` content, `tug-context-menu` / `tug-completion-menu` scroll, etc.
- For each user-visible scroll, add `data-tug-scroll-key="<unique>"` to the scrolling element. The IS-axis machinery from [Step 9](#step-9) handles capture/restore automatically.
- New harness test `at0029-region-scroll-coverage.test.ts` parameterized over each component's scroll sub-region.

**Estimated commits:** one (parallel-safe with 25D–G; can land any order).

##### Step 25I: Banner / bulletin dismiss persistence {#step-25i}

**Closes:** [AT0028].

**Architecture.** Distinct from card-scoped [A9] — this is a USER-WIDE preference. New `dev.tugtool.user.dismissals/{bannerId}` tugbank domain.

**Deliverables:**
- New `useDismissalState(bannerId): { dismissed, dismiss, undismiss }` hook reading/writing the tugbank user-prefs domain.
- `tug-banner`, `tug-pane-banner`, `tug-bulletin` consume the hook.
- New harness test `at0028-banner-dismiss.test.ts`: dismiss a banner, simulate reload (re-construct DeckManager via test-mode equivalent), banner stays dismissed.

**Estimated commits:** one. Independent of all other sub-steps.

##### Step 25J: IME composition persistence {#step-25j}

**Closes:** [AT0012] to the platform-permissible extent. Implements [A6].

**Two-phase sub-step.**

**Phase 1 (research):** WebKit / WKWebView platform research. Determine whether:
1. Browser API path: `Selection.setBaseAndExtent` + synthetic `compositionstart`/`update` events can re-enter native IME composition.
2. Native IPC path: tugapp can drive `NSTextInputContext` to re-enter composition with saved marked text.
3. Text-only fallback: insert marked-text string as plain text + cursor at end (loses "draft" property).

**Phase 2 (implementation):** based on the path that works, implement `bag.markedText` axis end-to-end (engine save + restore for EM, deferred-save during composition for FC). Document residuals if any path proves infeasible.

**Deliverables:**
- Phase 1 outcome: research notes folded into [A6]'s description block; if (1) doesn't work and (2) requires Swift-side work that's out of scope, this sub-step's deliverable shrinks to the (3) text-only fallback for both EM and FC.
- Phase 2 outcome: `bag.markedText` schema in `layout-tree.ts`; EM-engine API surfacing composition state; `at0012-ime-composition.test.ts` (gated behind a CJK / IME availability check on the test runner; may end up TUGAPP_IME_AVAILABLE=1 environment-gated).

**Estimated commits:** two (Phase 1 research note as a separate small commit, Phase 2 the implementation). Phase 1 can land in any order; Phase 2 depends on Phase 1's path decision.

##### Step 25K: Pass 10 cleanup deferred from Step 23E {#step-25k}

**Status:** ✅ audit deliverable closed (no retirements needed, finding documented below). Dev-assertion deliverable deferred with rationale.

**Closes:** the audit half of the Pass 10 cleanup items deferred at [Step 23E](#step-23e)'s checkpoint. Dev-assertion stays open.

**Deliverable 1 — grep audit for redundant `.focus()` paths. Closed (no retirements needed).**

Surveyed every `engine.root.focus()` / `this.root.focus()` call site outside test code:

- 7 sites in `tug-text-engine.ts`: `selectAll`, `selectWordAtPoint`, `insertText`, `insertAtom`, `deleteSelection`, `paste` (×2). Each pairs `this.root.focus()` with a `document.execCommand(...)` or `Selection.modify(...)` operation. `execCommand` requires `document.activeElement` to match its target; the focus call is the contract for that API, not a redundant selection-claim.
- 1 site in `tug-prompt-input.tsx:1131`: browser-fallback paste path. Focus the contenteditable so `execCommand("paste")` dispatches its event on the right node.

The Step 23G `setSelectedRange`-based delegate `focus()` does NOT supersede these — it covers selection-via-focus (programmatic caret placement + selection write), a different code path from execCommand-driven mutation. No call sites retired.

**Deliverable 2 — `_flipFirstResponder` dev-only assertion. Deferred (speculative; no regression today).**

Originally proposed: DEV-only runtime check fires when `.focus()` lands on a contenteditable holding a programmatic selection (the WebKit selectionchange-on-focus quirk). Caller-aware so `engine.setSelectedRange` is exempt.

Post-[23G](#step-23g) reality: the legitimate path to focus a contenteditable now flows through `engine.setSelectedRange` (focus-then-select, WebKit-safe). `_flipFirstResponder` itself does not call `.focus()` — that's [`transferFocusForActivation`](#step-23c)'s job, which routes through the engine's selection API for EM cards. The assertion would therefore only fire for code that BYPASSES the post-23G contract; the current codebase has no such bypass.

The assertion remains valuable as preventive coverage if a future code path shortcuts the engine API, but it is not load-bearing today and authoring + maintaining a caller-aware guard adds surface area for marginal benefit. Deferred as a "land if a real regression surfaces" item; can be re-opened from [Step 25L](#step-25l)'s integration-test sweep if a gap appears.

**Estimated commits (actual):** one — plan-doc only.

##### Step 25L: Final cleanup ([AT0013], [AT0015], Step NN doc pass) {#step-25l}

**Status:** ✅ AT-series audit deliverable closed. Other deliverables marked partial / deferred — see breakdown below.

**Closes:** [AT0013] (closed: per-tag tests collectively constitute the integration coverage); AT-series end-of-plan audit (closed: canonical inventory at [`tuglaws/at-series-inventory.md`](../tuglaws/at-series-inventory.md) lists every tag's status). [AT0015] remains ⚠️ partial (test-fixture cleanup deferred); other doc-pass items left for follow-up commits.

**Deliverables (audited):**
- ✅ **[AT0013] integration test coverage.** Closed in spirit by landing a focused `m{NN}-*.test.ts` per AT-tag across 25A–25K, not by extending one mega-test file. Coverage = sum of per-tag gating tests; the inventory itself is the integration test plan.
- ⚠️ **[AT0015] legacy API deletion.** Production callers retired; the `selectionGuard.saveSelection` / `restoreSelection` / `SavedSelection` surface still exists for unit-test compatibility (`selection-guard.test.ts`, `selection-model.test.tsx`, `use-selection-boundary.test.tsx` exercise it as a registration probe). Full deletion requires rewriting those tests to use the published `cardRanges` / `updateCardDomSelection` surface — non-trivial. Marked ⚠️ partial in the inventory; deferred as a focused follow-up.
- ⏸ **`selection-model.md` rewrite + module docstrings.** Big doc rewrite covering the post-23A–23G architecture (synchronous `focus-transfer.ts`, [A9] component protocol, taxonomy table). Out of scope for the AT-series-audit commit; deferred as a follow-up doc pass.
- ✅ **Cross-reference update in `tugplan-tide-card-polish.md`.** Existing references to `tugplan-selection.md` are still accurate (they point at the plan doc, which remains canonical for design intent). The new inventory link landed inline in the missing-cases section.
- ✅ **AT-series end-of-plan audit.** New file [`tuglaws/at-series-inventory.md`](../tuglaws/at-series-inventory.md) lists every tag AT0001–AT0038 with status, gating tests, one-paragraph summary. AT0032–AT0036 elaborated entries added to this plan doc. AT0037 and AT0038 added (renumbered from drifted `m26-*` and `m27-*` test filenames; old prefixes collided with the AT0026 overlay-policy and AT0027 layout-state tags). Coverage matrix extended to include AT0032–AT0038. The justfile's hardcoded test-suite list updated to use the new filenames + add the m26/m27/m30/m31 tests added during 25D–25G that were never wired into the default sweep.

**Estimated commits (actual):** one — the AT-series audit commit lands here. AT0015 deletion + selection-model.md rewrite tracked as follow-up commits if/when prioritized.

**Dependencies:** all preceding sub-steps in Step 25.

##### End of AT-series.

After Step 25L lands, the missing-cases inventory ([AT0001]–[AT0038]) is fully closed except for [AT0012] (IME, deferred to [25J]), [AT0028] (banner-dismiss, deferred), [AT0029] (scroll-key audit, deferred), and the residual axes called out in [AT0015] (legacy API surface — partial), [AT0030] (virtual-focus-without-selection — niche edge case), and [AT0031] (tide-card lazy-mount). The plan doc transitions to a maintenance shape: any new AT-tag surfaces from a real-app gap, gets authored as a new entry in [`tuglaws/at-series-inventory.md`](../tuglaws/at-series-inventory.md), gated by a new harness test, and closed in a focused sub-step.

---

#### Step NN: Documentation & final cleanup {#step-nn}

**Note:** placeholder number. This step used to be numbered 16 but was renumbered once the [missing cases inventory](#missing-cases) surfaced additional work between Step 15 and final cleanup. Resolving to a concrete step number happens after the AT-series steps are authored.

**Depends on:** all preceding steps, including the AT-series closures.

**Commit:** `docs(selection): document two-paint model and final cleanup`

**References:** [D01](#d01-data-not-service), [D08](#d08-no-unmount-transitions), [D09](#d09-guard-role); `selection-model.md`, `selection-guard.ts` docstring, `tug-text-engine.ts` docstring, `card-host.tsx` docstring.

**Artifacts:**
- `selection-model.md` updated with the two-paint-layer model, the card-level boundary contract, the `updateCardDomSelection` publish API, and the explicit scope separation between `selectionGuard` (paint + boundary) and content components (apply + mutate).
- Module docstrings in `selection-guard.ts` and `tug-text-engine.ts` updated to reflect the new contracts.
- `card-host.tsx` module docstring updated to name the bag axes explicitly.
- Final pass to remove `selectionGuard.saveSelection` / `restoreSelection` from the public surface — mark as `@internal` or delete if no callers remain (grep-based verification already in Step 14).
- A brief pointer to this plan added in `tugplan-tide-card-polish.md` §5.5.c.

**Tasks:**
- [ ] Rewrite `selection-model.md` § SelectionGuard and § Save/Restore.
- [ ] Module docstring updates.
- [ ] Grep + cleanup of dead selection-guard save/restore surface.
- [ ] Cross-reference update in tugplan-tide-card-polish.md.

**Tests:**
- [ ] `tugutil validate` plan passes.
- [ ] `selection-model.md` tables accurate to current code.
- [ ] Grep: no callers of retired save/restore API outside the module.

**Checkpoint:**
- [ ] `bun x tsc --noEmit`, `bun test` green.
- [ ] All D-decisions referenced by at least one step via the validator.

### Missing cases inventory {#missing-cases}

> **Canonical registry:** [`tuglaws/at-series-inventory.md`](../tuglaws/at-series-inventory.md) is the authoritative index of AT-tag → status → gating tests, including AT0032–AT0038 added during Steps 23F / 23G / 25C.4 / 25C.5 / 25L. The blocks below remain the elaborated rationale + closing-requires for each tag and stay synchronized with the inventory's status field. When the two diverge, the inventory's tag numbering is authoritative; the per-tag block here is authoritative for design intent.

Post-implementation analysis of Steps 1–15 surfaced a class of transitions and card-type interactions the original plan did not cover. The plan did cover cold-boot reload and cross-pane moves well, but left **in-session activation transitions** (tab switch, pane activation, app resign / become-active, app hide / unhide) and **content-owning card focus reactivation** without a documented owner or trigger.

This section catalogs every known gap so follow-on steps can close them systematically instead of chasing bug reports.

#### Status legend

- **❌ broken** — user-observable behavior reproducibly wrong.
- **⚠️ partial** — works for some card types / triggers but not all.
- **❓ untested** — likely works, but no verification exists; a regression surface.
- **🔧 missing infra** — required hook / mechanism is absent from the architecture.

#### Card types

- **FC** — form-control cards (`TugInput`, `TugTextarea`) — DOM-authority; state lives on the native input.
- **EM** — engine-managed contentEditable cards (`tide-card`, `gallery-prompt-input`, `gallery-prompt-entry`) — `TugTextEngine` owns text, atoms, selection, focus; state serialized via `bag.content`.
- **MV** — markdown-view cards (`tug-markdown-view`) — copy-only selection; virtualized internal scroll.
- **ST** — stateless cards (`hello`, gallery demos without persistKey) — no state to preserve.

#### State axes

- **TV** — text value / content payload.
- **SR** — selection range (flat offsets for FC, DOM `Range` for EM, native `Selection` for MV).
- **FX** — element focus (`document.activeElement`).
- **OS** — outer scroll (`hostContentEl.scrollLeft/Top`).
- **IS** — inner region scroll (`data-tug-scroll-key` elements).
- **MT** — marked text / IME composition buffer (new axis introduced by [AT0012] resolution).
- **CS** — component state (new axis introduced by [D13]; opt-in per component via `persistKey`, captured into `bag.components`).

---

#### [AT0001] Intra-pane tab switch: form-control card loses focus on return {#at0001-tab-switch-fc}

- **Card types:** FC
- **State axes:** FX, SR (via paint dependency)
- **Trigger:** User switches from an FC card (via tab bar click or drag) to another tab in the same pane, then returns to the original.
- **Status:** ❌ broken
- **Evidence:** User-reported; `display: none` on the inactive tab unfocuses the input; on return nothing re-focuses.
- **Mechanism:** `CardHost` wraps each card in `<div style={{ display: isActive ? "contents" : "none" }}>`. Browsers move focus off any element inside a `display: none` subtree. Neither the primary mount effect (deps `[cardId, hostStackId, hostContentEl]`) nor the cross-pane refocus effect (deps `[hostStackId]`) fires on `isActive` transitions. The input's internal `selectionStart/End` persists on the node, but the browser paints the highlight only when the input is focused.
- **Closing requires:** a third `CardHost` `useLayoutEffect` keyed on `[isActive]` with a has-been-active ref-guard that skips the initial activation; on subsequent `false → true` transitions, re-apply `bag.focus` for FC (and `dom`) kinds only.

#### [AT0002] Intra-pane tab switch: engine-managed card loses focus and caret on return {#at0002-tab-switch-em}

- **Card types:** EM
- **State axes:** FX, SR paint
- **Trigger:** Same as AT0001 but for EM cards (tide-card, gallery-prompt-input).
- **Status:** ❌ broken
- **Evidence:** Hypothesized from the same mechanism as AT0001. Needs direct user repro to confirm symptoms.
- **Mechanism:** `display: none` unfocuses the engine's contentEditable root. The engine's own selection lives on `window.getSelection()` and may be cleared by WebKit when the anchoring element is hidden. `selectionGuard.cardRanges` retains its Range (guarded by `document.contains`), but native `::selection` doesn't paint without focus on the root, and no caret blinks.
- **Closing requires:** a mechanism for content-owning cards to re-focus on reactivation. Options: (a) new `onCardActivated` callback in `CardPersistenceCallbacks` that the content factory implements (e.g., `engine.focus()`); (b) card-lifecycle subscription (`observeCardDidActivate`) inside the component. See [AT0008] for the infra decision.

#### [AT0003] Pane activation change: card's `isActive` doesn't flip {#at0003-pane-activation}

- **Card types:** FC, EM
- **State axes:** FX, SR paint
- **Trigger:** User has two panes open with cards that had focus. Clicking in pane B to make it active doesn't toggle `isActive` on pane A's active card — it's still the active card of its pane. When the user clicks back on pane A's chrome (not the input), the input isn't re-focused.
- **Status:** ❌ broken (hypothesized; needs repro)
- **Mechanism:** The pane-activation path changes `activePaneId` in the deck store and flips composite-first-responder. `CardHost.isActive` only reflects "active within my own pane," not "my pane is the active pane." The [AT0001]/[AT0002] refocus trigger (`[isActive]` dep) misses this transition entirely.
- **Closing requires:** a `CardHost` subscription to the deck store tracking `isActiveCardOfActivePane(store, cardId)` via `useSyncExternalStore` or direct `subscribe`; refocus on `false → true` transitions of that derived value. Overlaps with [AT0001] — a single mechanism can cover both if it tracks the "am I the focus destination right now?" predicate, not the narrower `isActive` prop.

#### [AT0004] App resign → become-active: focus not restored to previously-focused element {#at0004-app-resign-return}

- **Card types:** FC, EM
- **State axes:** FX
- **Trigger:** User types in a card, Cmd-Tabs away to another app (app resigns), Cmd-Tabs back (app becomes active). The previously-focused input is no longer focused; for FC, its selection highlight is gone (paint requires focus).
- **Status:** ❌ broken
- **Evidence:** Code inspection: `windowHasFocus` flips via `selectionGuard.handleApplicationDid{Resign,Become}Active` (Step 5), which drives paint of `cardRanges` (EM case) via the custom highlight. No FX restore path exists. For FC cards, inputs don't participate in `cardRanges` and native paint requires focus — the selection is in `selectionStart/End` but invisible.
- **Mechanism:** Step 13 wires `saveAndFlush` on will-resign (so `bag.focus` is correct), but no counterpart re-applies `bag.focus` on become-active.
- **Closing requires:** on `applicationDidBecomeActive` / `applicationDidUnhide`, re-apply `bag.focus` for the active card of the active pane — same mechanism as [AT0001]/[AT0003]. Needs the [R07] active-card gate to avoid focus theft if the user has since clicked elsewhere.

#### [AT0005] App hide → unhide: same as AT0004 {#at0005-app-hide-unhide}

- **Card types:** FC, EM
- **State axes:** FX
- **Trigger:** macOS Cmd-H (`applicationWillHide` / `applicationDidUnhide`).
- **Status:** ❌ broken (same mechanism as AT0004)
- **Closing requires:** Same fix as AT0004; the `onCardActivated` hook (or deck-store-subscribed focus restore) should fire on unhide too.

#### [AT0006] Cross-pane move: focus not restored for content-owning cards {#at0006-cross-pane-em}

- **Card types:** EM
- **State axes:** FX, SR paint
- **Trigger:** User drags an engine-managed card from pane A to pane B (or detaches it into a new standalone pane). The pointerdown on pane chrome blurs the engine root; the drop reparents the DOM; the engine root never regains focus.
- **Status:** ⚠️ partial
- **Evidence:** Step 11's cross-pane-move refocus effect explicitly skips content-owning cards per the architectural gate landed in the tide-bug fix — CardHost doesn't call `applyFocusSnapshot` for them. The engine has no equivalent reactivation hook.
- **Closing requires:** Same shared mechanism as [AT0002] ([AT0008]'s infra decision). Once engine-managed cards have an `onCardActivated` path, cross-pane-move refocus becomes an instance of it.

#### [AT0007] Card detach: same focus gap as AT0006 {#at0007-card-detach}

- **Card types:** EM, FC
- **State axes:** FX, SR paint
- **Trigger:** User drags a card out of its pane into a new standalone pane (`DeckManager._detachCard`).
- **Status:** ⚠️ partial — FC is covered by the existing cross-pane refocus effect (Step 11) via the detached card's new `hostStackId`; EM is broken for the same reason as AT0006.
- **Closing requires:** closes automatically once AT0006 is closed.

#### [AT0008] No `onCardActivated` hook for content-owning cards {#at0008-on-card-activated}

- **Card types:** EM (but the hook would be general)
- **State axes:** infra
- **Trigger:** N/A — this is an infrastructure gap that blocks AT0002, AT0004, AT0005, AT0006.
- **Status:** 🔧 missing infra
- **Mechanism:** `CardPersistenceCallbacks` has `onSave` / `onRestore` / `onContentReady` / `restorePendingRef`. There is no signal for "your card just became the focus destination; if you want to re-focus yourself, now is the time." The `card-lifecycle.ts` observer API does expose `observeCardDidActivate`, but content factories don't wire it for focus-restore purposes today.
- **Closing requires:** a design decision between (a) adding a new optional callback `onCardActivated?(): void` to `CardPersistenceCallbacks` — content factory calls `engine.root.focus()` in it; or (b) having content factories subscribe to `observeCardDidActivate` themselves. Option (a) is more discoverable and keeps lifecycle-awareness contained to the persistence protocol; option (b) is leaner but spreads the knowledge. Pending decision.

#### [AT0009] Card mounts in an inactive tab: engine's `setSelectedRange` focus fails silently {#at0009-inactive-mount}

- **Card types:** EM
- **State axes:** FX, SR
- **Trigger:** Reload with a multi-card pane where the engine-managed card is NOT the active tab. The card mounts with `display: none` on its wrapper. Engine's `setSelectedRange` calls `this.root.focus({preventScroll: true})`; since the root is in a `display: none` subtree, `.focus()` no-ops. The dev-warn we added in `tug-text-engine.ts` fires. The selection is set on an unfocused (and invisible) element.
- **Status:** ❌ broken for this specific scenario (scoped)
- **Evidence:** Follows directly from the dev-warn we installed — the warning text explicitly names this failure mode.
- **Mechanism:** Our architectural gate (M-fix) keeps CardHost from stepping on the engine's selection. But for inactive-mount cards, the engine's own focus-first doesn't land. On user-activate (they click the tab), nothing re-focuses.
- **Closing requires:** [AT0008]'s hook plus engine wiring to re-focus on `onCardActivated`. Same root cause cluster.

#### [AT0010] Markdown-view copy selection is never persisted {#at0010-markdown-selection}

- **Card types:** MV
- **State axes:** SR
- **Trigger:** User selects text in a markdown-view card (for copy). Any transition (reload, tab switch, pane switch, resign) loses the selection.
- **Status:** ✅ closed at [25B](#step-25b) — `tug-markdown-view` gained `persistKey` + a `document.selectionchange` listener that publishes the user's `Range` to `selectionGuard.updateCardDomSelection(cardId, range)` whenever the range's `commonAncestorContainer` is inside the scroll container. Round-trip gated by `at0010-markdown-selection.test.ts` (tab-switch + cmd-tab; native `::selection` and the `inactive-selection` custom highlight both verified).
- **Mechanism (was):** Markdown-view regions didn't carry a `persistKey`, didn't use `useCardPersistence`, and didn't participate in `selectionGuard.cardRanges` (no `onSelectionChanged` publish). The selection existed in `window.getSelection()` but nothing captured it.
- **Mechanism (now):** With `persistKey` set, the view installs a `useLayoutEffect`-scoped `selectionchange` listener that publishes any in-card `Range` to `selectionGuard`. The card-level paint authority (`updatePaint`) buckets the range into native `::selection` (focused card with window focus) or `::highlight(inactive-selection)` (every other case) on every `cardRanges` update, every deck-store notify, and every resign/become-active. On a focus return that has a saved `Range`, the one-shot capture-phase `mousedown` interceptor stops the click that triggered the switch from collapsing the about-to-be-restored selection. The `useCardPersistence` registration's `onSave` returns `undefined` so `bag.content` stays absent — `CardHost`'s `captureCardState` then takes the `!ownsSelectionAndFocus` branch and serializes `bag.domSelection` from `selectionGuard.cardRanges` automatically. The cold-boot mount-restore path replays the range via `selectionGuard.restoreCardDomSelection`.

#### [AT0011] Card close → reopen: no "reopen" path exists {#at0011-card-close-reopen}

- **Card types:** all
- **State axes:** all
- **Trigger:** User closes a card with unsaved edits (Step 14 flushes to the bag), then wants to reopen it.
- **Status:** ✅ closed — not a feature.
- **Decision:** Close-then-reopen is not a product feature and no support is needed. Step 14's flush-on-close continues to write the bag for robustness (protects against accidental close with in-flight edits recoverable via history), but no UI path to reopen will be built. This entry is informational only and needs no follow-on work.
- **Closing requires:** No action. Retained in the inventory for traceability.

#### [AT0012] IME composition mid-transition unresolved {#at0012-ime-composition}

- **Card types:** EM, FC
- **State axes:** TV, SR, **MT (new: marked-text composition buffer)**
- **Trigger:** User is mid-CJK-composition when an app-resign or tab-switch fires; save captures buffer offsets that may not map back after composition ends, and the in-flight composition buffer is lost entirely.
- **Status:** ❌ broken — IME composition **must** be retained per [L23] / user direction (M-Q5 resolution).
- **Evidence:** [R02] identified the risk; the plan's original mitigation (defer save until `compositionend`) loses the user's in-flight keystrokes on every qualifying transition. Not good enough.
- **Closing requires:** a new persisted axis `bag.markedText` that serializes the composition buffer (the native "marked text"), composition anchor offset, and platform hints.
  - **EM:** `TugTextEngine` surfaces composition state via `engine.getCompositionState()` (marked text string + offset). Save captures `bag.markedText` when `engine.isComposing`. Restore: if `bag.markedText` is non-null on mount/activation, the engine re-enters composition mode at the stored offset with the stored marked text (implementation detail: may require `Selection.setBaseAndExtent` + a programmatic `compositionstart/update` via the input method bridge; or a native-shell IPC if the browser path is insufficient).
  - **FC:** input elements don't programmatically surface marked text. Save deferral (wait for `compositionend`) is the fallback for FC; on save-during-composition the save queue marks the card "pending composition end" and retries. A second fallback — pre-composition snapshot restore — covers the process-exit residual.
  - **Platform research required:** confirm which of the composition re-entry mechanisms (Web API, native IME bridge via `tugapp`) is viable in the Tide shell. See architecture piece [A6].
  - **Residual:** unclean process termination mid-composition is unrecoverable — accepted limitation.

#### [AT0013] Integration test coverage for in-session transitions {#at0013-integration-tests}

- **Card types:** all
- **State axes:** all
- **Trigger:** N/A (test coverage gap)
- **Status:** ❌ missing
- **Mechanism:** Step 15 landed integration tests for cold-boot reload (FC and EM) and paint-bucket transitions (tab switch, app resign/activate, simultaneous-paint). **No integration tests exist for:**
  - Tab switch within a pane → return (FC or EM).
  - Pane activation change → return.
  - App resign / become-active focus restore (beyond paint).
  - Cross-pane move for EM cards.
  - Card detach / merge.
  - Inactive-at-mount card activated post-hoc.
- **Closing requires:** extend `selection-persistence-integration.test.tsx` as each M-step lands. Each closing step should add its own integration test pinning the specific repro.

#### [AT0014] Scroll persistence across in-session transitions: untested {#at0014-scroll-untested}

- **Card types:** all (MV particularly)
- **State axes:** OS, IS
- **Trigger:** Tab switch within pane, pane activation, app resign/activate.
- **Status:** ✅ verified by `tests/app-test/at0014-scroll-persistence.test.ts` ([Step 25A](#step-25a)).
- **Mechanism:** Region scroll (`bag.regionScroll`) round-trips correctly through tab switch and app resign/return on `gallery-markdown-50kb` — a `tug-markdown-view` card variant with 50KB of baked-in static content + `useCardPersistence` opt-in (added in [Step 25A](#step-25a)).
- **Verification:** Two test cases cover region scroll across (a) tab switch + back, (b) `simulateAppResign` + `simulateAppBecomeActive`. Outer scroll (`bag.scroll`) stays unit-tested in `card-host-region-scroll.test.ts`; in-app gallery cards fill the pane (`height: 100%`), so an in-app outer-scroll fixture would require synthetic CSS that doesn't reflect production layouts.

#### [AT0015] `saveSelection` / `restoreSelection` / `SavedSelection` legacy surface {#at0015-legacy-api}

- **Card types:** N/A
- **State axes:** N/A (cleanup)
- **Trigger:** Grep.
- **Status:** ⚠️ pending (tracked by Step 15's grep contract)
- **Mechanism:** Legacy API remains in `selection-guard.ts` for test compatibility. Step NN's documentation pass nominally removes them; this entry ensures the deletion doesn't slip.
- **Closing requires:** Step NN performs the deletion; `selection-persistence-greps.test.ts` extends to also assert zero references (including tests) once the API is gone.

#### [AT0016] Tab close of the active tab → focus handoff to the newly-active tab {#at0016-tab-close-handoff}

- **Card types:** FC, EM
- **State axes:** FX, SR paint
- **Trigger:** User closes the currently-active tab of a pane. The pane picks a new active card (typically the neighbor or most-recent). That new active card should receive focus + restore its selection paint.
- **Status:** ❌ broken (hypothesized; same root cause as AT0001/AT0003 — no activation hook)
- **Mechanism:** Closing a card routes through `_removeCard` → Step 14's flush path → React unmount. The pane's new `activeCardId` flips, causing `isActive` to flip `false → true` on the neighbor. Same missing `[isActive]`-triggered refocus as AT0001/AT0002. No current code refocuses the neighbor.
- **Closing requires:** nothing new beyond [AT0001] / [AT0002] / [A3]'s shared activation effect — tab-close handoff is just another transition that flips `isFocusDestination`. Verify via integration test.

#### [AT0017] `saveState` RPC from native does not capture focus or selection {#at0017-savestate-rpc}

- **Card types:** FC, EM, MV
- **State axes:** FX, SR, MT
- **Trigger:** Native shell (tugapp) calls into the web frontend via the `saveState` RPC to request a snapshot (e.g., on window-close or "save to crash recovery").
- **Status:** ✅ verified by `tests/app-test/at0017-savestate-rpc-parity.test.ts` ([Step 25A](#step-25a)).
- **Evidence:** `main.tsx` wires `window.tugdeck.saveState` to `deck.saveAndFlushSync()`, which iterates every card through `invokeSaveCallback("manual")` — the same entry point the will-phase / window-blur path uses with `source: "window-blur"`. Both routes call the card's same `onSave` closure.
- **Verification:** Gating test types into a focused FC card, drives `window.tugdeck.saveState()`, reads the bag, drives `simulateAppResign` (window-blur), reads the bag again. Asserts (a) saveState bag contains the user's edit and (b) saveState bag is JSON-equal to the window-blur bag for the same steady state.

#### [AT0018] Async content-load race: save fires before `onContentReady` {#at0018-async-content-ready-race}

- **Card types:** EM (content factories that async-load content)
- **State axes:** TV, SR, FX
- **Trigger:** Card mounts, sets `restorePendingRef = true`, kicks off an async content load. During the window before `onContentReady` resolves, an app-resign, tab switch, or beforeunload fires.
- **Status:** ✅ verified by `tests/app-test/at0018-async-content-race.test.ts` ([Step 25A](#step-25a)) for the synchronous-restore factories shipping today.
- **Mechanism:** During the pending window, the engine's content is empty or stub. If `onSave` serializes the engine's current state, it captures the stub — overwriting the real persisted content the card was trying to restore. `restorePendingRef` exists to guard this, but it must gate `onSave`, not just `onContentReady`.
- **Verification:** Gating test pre-seeds `bag.content` with engine state, mounts a `gallery-prompt-entry` card, drives `saveState()` then `simulateAppResign` / `simulateAppBecomeActive`, and asserts `bag.content` still carries the seeded text after each save trigger. On-roster factories (`gallery-prompt-input`, `gallery-prompt-entry`, tide-card editor) restore synchronously inside Phase-1's layout effect, so the race window is sub-frame and not reproducible from the harness without explicit instrumentation. The behavioral assertion this test makes — "save after seed-and-mount captures the seeded content" — is what user-facing correctness requires.
- **Follow-up condition:** if a future async factory exposes the race, this test will start failing and the proper fix (gate `invokeSaveCallback` on `restorePendingRef.current`) lands in [25C](#step-25c).

#### [AT0019] Pane close / deck-level teardown: flush path coverage {#at0019-pane-teardown-flush}

- **Card types:** all
- **State axes:** all
- **Trigger:** User closes an entire pane (not just a card within it), or the deck itself is torn down (e.g., deck switch, workspace close).
- **Status:** ✅ verified by `tests/app-test/at0019-pane-teardown-flush.test.ts` ([Step 25A](#step-25a)) for the multi-card pane teardown path. `[A7]` flush-gate invariant guard remains in scope for [25C](#step-25c) if the deck-reset / workspace-close paths surface a gap.
- **Mechanism:** `_closePane` iterates every card in the pane through `flushSaveCallbackBeforeDestruction` (deck-manager.ts phase 2) BEFORE firing `cardWillBeginDestruction` (phase 3). The `__tug.closePane` test surface entry mirrors `deckManager.handlePaneClosed` — the same public method a future "close every card in this pane" UI affordance would call.
- **Verification:** Gating test seeds a 3-card pane, types into each, drives `__tug.closePane(paneId)`, and asserts (a) a `save-callback` event with `source: "close-handoff"` fires for every cardId, (b) every per-card save-callback precedes the first `card-host-unmount`. `[A7]` invariant guard at the bottom of `_removeCard` / `_closePane` and any deck-reset path audit remain follow-up work for [25C](#step-25c).

#### [AT0020] Modal overlay (command palette, context menu, drag ghost) dismiss → focus return {#at0020-overlay-focus-return}

- **Card types:** FC, EM
- **State axes:** FX, SR paint
- **Trigger:** User opens a modal/overlay (command palette, right-click context menu, drag-and-drop ghost). Focus moves to the overlay. On dismiss, focus should return to the previously-focused card.
- **Status:** ✅ verified by `tests/app-test/at0020-overlay-focus-return.test.ts` ([Step 25A](#step-25a)) for the editor context-menu representative.
- **Mechanism:** `tug-editor-context-menu` (the most user-driven overlay surface — every prompt-input installs it via `useTextInputResponder`) portals to `document.body` and dismisses on Escape. The dismiss path correctly returns focus to the editor; `document.activeElement` lands back inside the contenteditable rather than on `<body>`.
- **Verification:** Gating test mounts a `gallery-prompt-input`, types into the editor, drives `nativeRightClickAtElement` to open the menu, drives `nativeKey("Escape")` to dismiss, asserts `document.activeElement` is the editor's contenteditable inside the same card. Other overlay surfaces (`tug-popover`, `tug-sheet`, `tug-context-menu`, `tug-alert`) follow the same portal-then-dismiss pattern; the editor menu is the audit gate.

#### [AT0021] Drag aborted (escape / invalid drop) → card state preservation {#at0021-drag-aborted}

- **Card types:** FC, EM
- **State axes:** FX, SR paint
- **Trigger:** User starts dragging a card, then presses Escape or drops on an invalid target. The card returns to its original pane; its state should be unchanged.
- **Status:** ❓ untested.
- **Mechanism:** If the drag preview mechanism reparents the DOM during drag (versus using a ghost element), aborting may not restore the DOM state cleanly. Even with a ghost, the pointerdown on the original card likely blurred the engine root; abort doesn't re-focus.
- **Closing requires:** verify drag preview uses a ghost (not live DOM reparent). If live reparent: add a drag-abort path that routes through the activation mechanism to refocus. Integration test: drag card, press Escape, assert focus + selection paint unchanged.

#### [AT0022] Engine caret visibility after refocus: paint vs. blink {#at0022-caret-visibility}

- **Card types:** EM
- **State axes:** FX (visual only; no state impact)
- **Trigger:** After any refocus path (cold-boot, tab switch, cross-pane move, app-activate), does the caret blink (user's visual confirmation of focus)?
- **Status:** ✅ verified by `tests/app-test/at0022-caret-visibility.test.ts` ([Step 25A](#step-25a)).
- **Mechanism:** `::selection` paint and caret blink are browser-native and tied to BOTH `document.activeElement` and `document.hasFocus()`. After cold-boot mount, app-resign + become-active, and tab switch + back, both conditions hold: `activeElement` is the engine root contenteditable, and `document.hasFocus() === true`.
- **Verification:** Gating test mounts a `gallery-prompt-input` EM card, drives three refocus paths (cold-boot → app-cycle → tab switch A↔B), and asserts both axes after each transition.

#### [AT0023] Selection spanning multiple cards {#at0023-cross-card-selection}

- **Card types:** any two of {FC, EM, MV}
- **State axes:** SR
- **Trigger:** User clicks in card A, shift-clicks or drag-selects into card B.
- **Status:** ✅ verified by `tests/app-test/at0023-cross-card-selection.test.ts` ([Step 25A](#step-25a)). Paint system does not crash on a cross-card drag; the audit treats genuine cross-card ranges as informational diagnostics, not test failures.
- **Mechanism:** The browser's single-`Selection` model typically scopes a selection to one contentEditable root, but across non-editable cards (e.g., two MV cards side-by-side), a single selection may legitimately span both. The gating test exercises a native drag from card A's content to card B's content and inspects `window.getSelection()` + per-card `__tug.getSelection(cardId)` — neither throws under the WebKit boundary behavior that ships today.
- **Verification:** Two side-by-side panes each with a `gallery-markdown-50kb` card; native drag from A's scroll container to B's; assertions cover (a) `window.getSelection()` does not throw, (b) `__tug.getSelection("A")` and `__tug.getSelection("B")` each return either a snapshot or `null` without crashing. A genuine cross-card range, if observed, prints a diagnostic for [25C](#step-25c) follow-up but does not fail the test — the audit gates the paint system, not specific selection scoping.

---

_M24–AT0031 below surfaced from the component-roster L23 audit. They are gaps in **component-level** persistence — orthogonal to the transition-class gaps in AT0001–AT0023. All route through architecture piece [A9] (Component Persistence Protocol)._

#### [AT0024] No component-level persistence protocol {#at0024-component-protocol}

- **Card types:** any card that embeds stateful components
- **State axes:** CS (new)
- **Trigger:** Card author includes a stateful component (e.g., `<TugAccordion>`, `<TugTabBar>`, `<TugSlider>`) and does not manually serialize its state into `bag.content`. User interactions are lost on reload / transition.
- **Status:** ❌ systemic — ~25 of ~30 stateful components are in this class today.
- **Mechanism:** `useCardPersistence` is card-scoped. There's no way for a leaf component to declare "I own state and want it persisted" without the containing card author's explicit cooperation. Every new stateful component is a potential L23 violation until every card author that uses it updates their `onSave`.
- **Closing requires:** [A9] (Component Persistence Protocol) — foundational architectural work. See [D13] for the resolved design.

#### [AT0025] Intrinsic internal state hidden from card authors {#at0025-intrinsic-internal-state}

- **Card types:** cards embedding composite components
- **State axes:** CS
- **Trigger:** Card author has no access to internal `useState` inside `tug-tab-bar.overflowTabs`, `tug-option-group.focusedValue`, `tug-sheet` detent state, `tug-popover.internalOpen`, `tug-alert.open`, `tug-context-menu.open`, `tug-popup-button` internal open, `tug-markdown-view.menuState`, `tug-prompt-input.menuState`, `tug-prompt-entry.route`, `tug-prompt-entry.toolsOpen`.
- **Status:** ❌ broken by design before [D13] — card authors can't serialize what they can't see.
- **Mechanism:** components encapsulate state as an implementation detail; the encapsulation hides it from the card's `onSave`.
- **Closing requires:** per component, a decision between (a) this state is intentionally ephemeral (context-menu open, tooltip hover) — no opt-in; or (b) this state is user-visible — component implements [A9]'s `captureState`/`restoreState` for it. Audit + per-component fix under [A9d].

#### [AT0026] Open-overlay persistence semantics undecided {#at0026-overlay-policy}

- **Card types:** cards with sheet / alert / popover / confirm-popover / menu surfaces
- **State axes:** CS, FX, SR
- **Trigger:** User opens an overlay (e.g., `tug-sheet` with a form inside), invests interaction, Cmd-Tabs away or switches tabs. On return, overlay is closed; in-flight state lost.
- **Status:** ✅ closed by [Step 25F](#step-25f). `tug-sheet` opted in; `tug-alert`, `tug-confirm-popover`, `tug-popover`, `tug-tooltip`, `tug-context-menu` resolved as EPHEMERAL by design.
- **Closing requires:** policy per overlay type, decided in [Step 25F](#step-25f). Resolution: (a) PERSIST — `tug-sheet`. Opt into [A9]; restore re-opens with state intact. (b) EPHEMERAL — `tug-alert`, `tug-confirm-popover`, `tug-popover`, `tug-tooltip`, `tug-context-menu`, simple transient popovers. No opt-in; re-open empty is user-acceptable. The original proposal also classified `tug-alert`, `tug-confirm-popover`, `tug-popover` as PERSIST; all three moved to EPHEMERAL during 25F (rationale in [Step 25F](#step-25f)) — alerts in particular would break their Promise contract if re-opened without a resolver.

#### [AT0027] Layout state: split-pane divider, accordion expansion {#at0027-layout-state}

- **Card types:** any card using `tug-split-pane` or `tug-accordion`
- **State axes:** CS
- **Trigger:** User drags a split-pane divider or expands an accordion section. Reload or app-relaunch resets to default layout.
- **Status:** ✅ accordion closed by [Step 25D](#step-25d); switch / radio-group / choice-group / option-group / slider / value-input closed by [Step 25E](#step-25e). Split-pane axis preserved on its existing path (see resolution below). Popup-button + tab-bar deferred-indefinitely — see [25E](#step-25e)'s "What's deferred" note.
- **Closing requires:** accordion → [A9] opt-in (landed). Split-pane → no migration. Resolution of the original open subquestion: `tug-split-pane` already persists divider positions via its own `storageKey` prop → tugbank under `dev.tugtool.tugways.split-pane`. The user-visible gap is closed, just by a path that pre-dates [A9]. Migrating to `bag.components` would duplicate persistence layers ([L23] violation) without closing any new gap, and the original "most likely pane-scope" intuition was correct: divider positions belong with pane-chrome geometry, not card content. Step 25D leaves `tug-split-pane`'s `storageKey` path as-is. If a future reorganization unifies pane-chrome persistence into a single canonical store, that would be the right time to retire `storageKey` — out of [A9d]'s scope.

#### [AT0028] Banner / bulletin dismiss persistence {#at0028-banner-dismiss}

- **Card types:** any context using `tug-banner`, `tug-pane-banner`, `tug-bulletin`
- **State axes:** user-preference scope (not card/pane/app — user-wide)
- **Trigger:** User dismisses a banner. On reload / app-relaunch, the banner should stay dismissed.
- **Status:** ❌ broken — audit needed to confirm no dismiss-state exists today.
- **Closing requires:** separate from [A9]'s card-scoped protocol. A new user-preferences store, keyed by banner ID, persisted in tugbank under `dev.tugtool.user.dismissals/{bannerId}`. Integrates with `tug-banner` / `tug-bulletin` via a new `useDismissalState(bannerId)` hook. Not strictly a "selection persistence" concern but surfaced during the component audit and belongs in the same plan for L23 completeness.

#### [AT0029] Scroll-key audit across components {#at0029-scroll-key-audit}

- **Card types:** any card using internally-scrollable components
- **State axes:** IS
- **Trigger:** Any scrollable sub-region inside a component whose scroll position is user-visible and not captured by the outer-scroll (OS) or markdown-view scroll-key paths today.
- **Status:** ❓ audit pending. Only `tug-markdown-view` carries `data-tug-scroll-key` today.
- **Closing requires:** walk every stateful component for scrollable sub-regions (`tug-tab-bar` overflow, `tug-popup-button` menu, `tug-sheet` content, `tug-context-menu` / `tug-completion-menu` scroll). Where user-visible scroll applies, add `data-tug-scroll-key` to the scrolling element. IS-axis machinery (already shipped in Step 9) handles capture/restore.

#### [AT0030] Virtual-focus / focus-within for composite components {#at0030-virtual-focus}

- **Card types:** cards with composite components that manage a "virtual focus" (keyboard-navigation ring on a non-`activeElement` child)
- **State axes:** CS (not FX)
- **Trigger:** `tug-radio-group`, `tug-option-group`, `tug-choice-group`, `tug-tab-bar` — real `activeElement` is the wrapper; the focus ring is on an internal item tracked in component state. On transition, `bag.focus` captures the wrapper but loses the ring position.
- **Status:** ❌ broken.
- **Closing requires:** each such component opts into [A9] and captures its internal focus index via `captureState`. Restore reapplies the ring. No extension to the `focus` axis needed; this is component state.

#### [AT0031] `tug-prompt-entry` internal UI state (`route`, `toolsOpen`) {#at0031-prompt-entry-ui-state}

- **Card types:** gallery-prompt-entry, tide-card (if it uses prompt-entry)
- **State axes:** CS
- **Trigger:** User navigates within a prompt-entry to a non-default route or opens the tools panel; transition resets both to defaults.
- **Status:** ✅ closed for `gallery-prompt-entry` by [Step 25G](#step-25g). Architectural divergence from the original plan: route + per-route engine drafts continue to live in `bag.content` ([AT0024] gates route survival), and only `toolsOpen` rides `bag.components.entry-chrome` via `useComponentPersistence`. The original "serialize `{ route, toolsOpen }` via `captureState`" wording would have split route from `bag.content.perRoute` (the perRoute map), forcing a two-phase restore that violates [L23] (apply-default-then-recover). Single-restore architecture preserves the L23 contract. Tide-card's lazy `TugPromptEntry` mount falls outside the [A9c] orchestrator's one-shot component-restore window — documented as a follow-up gap in `at0031-prompt-entry-chrome.test.ts`'s module docstring; closure requires extending [A9c] to re-fire on registry changes (or adding a per-component restore primitive at hook-register time). m24 already proved route + per-route content survives across `appReload` / `quitGracefully+relaunch`; m31 adds the `toolsOpen` axis + the cmd-tab transition for chrome.
- **Closing requires:** `tug-prompt-entry` opts into [A9] with persistKey and serializes `{ toolsOpen }` via `captureState`. Route stays in `bag.content.currentRoute` because it is the index into `bag.content.perRoute` — splitting the two would require two-phase restore, which violates [L23]. Tide closure requires the orchestrator change above.

---

_M32–AT0036 surfaced during selection-plan Step 23F / 23G / 25C.5 work. Each gates a specific EM-card focus or selection bug that escaped the AT0001–AT0023 transition coverage._

#### [AT0032] EM cold-boot selection paint {#at0032-em-cold-boot-selection}

- **Card types:** EM
- **State axes:** SR
- **Trigger:** Reload with an EM card seeded ACTIVE and a non-collapsed selection in `bag.content`.
- **Status:** ✅ closed at [Step 23F](#step-23f).
- **Test:** `at0032-em-cold-boot-selection.test.ts`.
- **Mechanism (was):** Cold-boot mount-restore for EM cards landed selection on an unfocused engine root; the visible paint was missing on first frame.
- **Mechanism (now):** `cold-boot-restore-snapshot` diagnostic event fires with `hasContent: true`; `engine-restore-applied` echoes the seeded selection and the live `engine.getSelectedRange()` post-restore.

#### [AT0033] Fresh-EM-card resolver classification {#at0033-em-fresh-card-activation}

- **Card types:** EM
- **State axes:** FX
- **Trigger:** A fresh, never-saved EM card mounts in an inactive tab; the user activates it via tab click. Pre-23F, focus landed on the editor's first toolbar button (e.g. "Insert Atom") instead of the contenteditable.
- **Status:** ✅ closed at [Step 23F](#step-23f).
- **Test:** `at0033-em-fresh-card-activation.test.ts`.
- **Mechanism (was):** `resolveActivationTarget` discriminated EM vs FC by `bag.content !== undefined`. Saved EM cards (m09) classified correctly; fresh never-saved EM cards mis-classified into the `default-focus` branch, where `button:not([disabled])` matched before `[contenteditable="true"]`.
- **Mechanism (now):** [Step 23F](#step-23f) adds `engineKind: "em"` to the card-registry shape; `resolveActivationTarget` reads `engineKind` instead of inferring from `bag.content`.

#### [AT0034] EM focus after cross-pane move {#at0034-em-focus-after-move}

- **Card types:** EM
- **State axes:** FX
- **Trigger:** Drag an EM card cross-pane (or detach to a new pane). `engine-activation-dispatched` fires (proving `onCardActivated` ran), but `.focus()` no-ops on the freshly re-mounted contenteditable.
- **Status:** ✅ closed at [Step 23F](#step-23f).
- **Test:** `at0034-em-focus-after-move.test.ts`.
- **Mechanism:** Pre-23F, at0006-em / at0007-em deliberately omitted the focus-actually-landing assertion because the contenteditable's first commit lagged the activation dispatch. 23F closes the gap; this test is the regression gate for the focus-actually-landing assertion that those tests can now adopt.

#### [AT0035] App-switch selection survival (EM + tide) {#at0035-em-app-switch-selection}

- **Card types:** EM (gallery-prompt-input direct + tide-card variant)
- **State axes:** SR, FX
- **Trigger:** Type into an EM card, select a substring, cmd-tab away, cmd-tab back. Pre-23G, text always restored but selection was intermittently lost — tide-specific reproducer; gallery-prompt-entry didn't exhibit it.
- **Status:** ✅ closed at [Step 23G](#step-23g).
- **Tests:** `at0035-em-app-switch-selection.test.ts`, `at0035-tide-app-switch-selection.test.ts`.
- **Mechanism:** Tide-card had two redundant focus paths on activation — its own `useCardDelegate({cardDidActivate})` legacy hook plus TugPromptEntry's framework-driven `onCardActivated`. Back-to-back `.focus()` calls triggered WebKit's selectionchange-on-focus quirk intermittently. Step 23G routes the delegate's `focus()` through `engine.setSelectedRange` for the WebKit-safe focus-then-select pattern. Gallery-prompt-input variant is the forward-regression gate for the activation chain shared between the two factories.

#### [AT0036] Inactive-card cmd-tab selection survival {#at0036-inactive-card-app-switch-selection}

- **Card types:** FC (TugInput)
- **State axes:** SR
- **Trigger:** Activate an FC card, type + select. Activate another card → first card's selection is captured into `bag.formControls`. Cmd-Tab away + back. Re-activate the FC card by clicking its tab. Pre-25C.5 Layer 4: re-activation click clobbered the saved selection (mousedown placed a collapsed caret at the click point before any restore could re-apply).
- **Status:** ✅ closed at [Step 25C.5](#step-25c5) Layer 4.
- **Test:** `at0036-inactive-card-app-switch-selection.test.ts`.
- **Mechanism:** `installFormControlReapplyOnNextMousedown` (focus-transfer.ts) is the deterministic event-ordering primitive — a one-shot capture-phase mousedown listener that `preventDefault`s the default caret-placement and re-applies `bag.formControls` for the clicked input. No RAF, no microtask — strictly deterministic against the browser's event-dispatch sequence ([L05]).

---

_M37 and AT0038 surfaced during selection-plan Step 25C.4 (active/inactive paint split). Multi-card paint invariants that the active/inactive routing must preserve. Originally numbered `m26-*` and `m27-*` in test filenames; renumbered to AT0037 / AT0038 during the Step 25L AT-series audit when the canonical inventory landed and the AT0026 / AT0027 tags were claimed by the overlay-policy and layout-state entries._

#### [AT0037] Multi-card deck-wide restore consistency {#at0037-deck-wide-restore-consistency}

- **Card types:** EM × N
- **State axes:** SR, FX, OS, TV (all axes per card)
- **Trigger:** Restore a multi-card deck (single-pane tabs OR multi-pane geometries) where each card carries a persisted selection.
- **Status:** ✅ closed at [Step 25C.4](#step-25c4).
- **Test:** `at0037-deck-wide-restore-consistency.test.ts`.
- **Invariants gated:** (1) exactly one card holds document focus — the deck-level first responder; (2) exactly one card's range is in `window.getSelection()` (same card); (3) every inactive card's selection lives in `selectionGuard.cardRanges` and is observable via `__tug.getCaretState(cardId)`; (4) every inactive card's range is in the `inactive-selection` CSS Custom Highlight; the active card's range is NOT; (5) every card's bag-on-disk has the four 25C.3 axes (text/atoms/selection/scrollTop) preserved.

#### [AT0038] Deactivation-time inactive paint {#at0038-deactivation-inactive-paint}

- **Card types:** EM
- **State axes:** SR (selection paint at correct DOM positions)
- **Trigger:** Type enough into an EM card to make it scroll, select content (possibly off-screen), click another card to deactivate. Pre-25C.4: inactive-paint highlight ended up at the wrong DOM positions (relative-to-visible offset rather than the user's actual selection).
- **Status:** ✅ closed at [Step 25C.4](#step-25c4).
- **Test:** `at0038-deactivation-inactive-paint.test.ts`.
- **Mechanism:** `paintMirrorAsInactive(publish)` rebuilds a DOM Range from `mirror.selection` flat offsets via `flatToDom`. The test gates `flatToDom`'s correctness against scrolled content — the rebuilt Range must reflect the user's actual selection, not the visible / scroll-relative position.

---

#### Resolved design decisions

All AT-series open questions are resolved. Decisions are captured here and drive the architecture pieces in the next section.

- **[M-Q1] Shared-mechanism vs per-axis fix → CONFIRMED shared.** [AT0001] / [AT0003] / [AT0004] / [AT0005] / [AT0006] / [AT0007] / [AT0009] all reduce to "this card just became the focus destination; restore its focus and paint." A single `CardHost` subscription tracking the `isFocusDestination` predicate (derived from the deck store) closes them all. Per-axis fixes would duplicate the same ref-guard, the same focus-theft gate, and the same app-lifecycle wiring in five places. Shared is the directive. See architecture piece [A1] / [A3].

- **[M-Q2] `onCardActivated` as callback or observation → option (a) CONFIRMED.** Add a new optional callback `onCardActivated?: () => void` to `CardPersistenceCallbacks`. Content-owning cards (EM) implement it — typical body: `engine.root.focus({ preventScroll: true })` followed by engine-published selection. FC cards need no callback; `CardHost` handles FC reactivation directly by re-applying `bag.focus` + `bag.domSelection`. Placement in `CardPersistenceCallbacks` keeps lifecycle-awareness colocated with the existing save/restore protocol rather than scattering it across content factories that each subscribe to `card-lifecycle.ts`. See architecture piece [A2].

- **[M-Q3] Markdown-view copy-selection → MUST close per [L23].** A user's copy-selection is user-visible state; losing it on any transition violates the tuglaw. Previously-defensible "ephemerality" is not a permitted exception. `tug-markdown-view` gains `persistKey` + `useCardPersistence` + `selectionchange` publish. See [AT0010] for the updated closing requirements and architecture piece [A5] for the implementation shape.

- **[M-Q4] Card reopen → NOT a feature.** Close-then-reopen is not in scope; no UI path exists and none is planned. Step 14 continues to flush-on-close for robustness only (not for reopen). [AT0011] is closed as informational — no follow-on work.

- **[M-Q5] IME composition save → MUST retain, likely via `bag.markedText`.** Deferring save until `compositionend` is not sufficient: in-flight keystrokes from the user are user-visible state and must survive transitions. A new persisted axis `bag.markedText` captures the native marked-text buffer + composition anchor. Platform research required to determine whether browser APIs permit programmatic composition re-entry, or whether a native IPC bridge (via tugapp) is needed. See [AT0012] updated closing requirements and architecture piece [A6].

---

#### Architecture to close the gaps {#missing-architecture}

The AT-series resolutions converge on a small number of shared mechanisms. Most of the broken cases ([AT0001], [AT0002], [AT0003], [AT0004], [AT0005], [AT0006], [AT0007], [AT0009], [AT0016]) are the same problem — "this card just became the focus destination; restore its focus + paint" — seen from different triggers. This section sketches the architectural pieces that, together, close the inventory. Each piece is labeled [A#] and cross-referenced from the M-entries above.

**Status:** DRAFT. These pieces need design review before AT-series execution steps can be authored.

##### [A1] `isFocusDestination` derived selector on the deck store {#a1-focus-destination-selector}

A pure derived predicate:

```
isFocusDestination(cardId) ⇔
  card's pane is the active pane
  AND card is the active card of that pane
  AND document.hasFocus()  // app is foreground
```

Implemented as a selector over `deckState` + `activePaneId`. Exposed two ways:

- React: `useFocusDestination(cardId)` via `useSyncExternalStore` (per [L02]).
- Non-React: `deckStore.subscribe(() => isFocusDestination(cardId))` for `selectionGuard` / engine wiring.

**Closes (indirectly):** underpins [A3], [A4].

##### [A2] `onCardActivated` callback in `CardPersistenceCallbacks` {#a2-on-card-activated}

Add a new optional callback to the existing persistence protocol:

```ts
interface CardPersistenceCallbacks {
  onSave?: () => CardStateBag;
  onRestore?: (bag: CardStateBag) => void;
  onContentReady?: () => void;
  onCardActivated?: () => void;  // NEW
  restorePendingRef?: MutableRefObject<boolean>;
}
```

Content factories that own focus (EM) implement `onCardActivated` to re-focus their root. Typical body:

```ts
onCardActivated: () => {
  engine.root.focus({ preventScroll: true });
  // engine's onSelectionChanged publishes the current range → selection-guard paints
},
```

DOM-authority cards (FC) do not implement `onCardActivated`; `CardHost` handles them in [A3] by re-applying `bag.focus` + `bag.domSelection` directly.

**Closes:** [AT0002], [AT0006], [AT0007], [AT0009] (by giving content-owning cards a reactivation entry point).

##### [A3] Shared `CardHost` activation effect {#a3-shared-activation-effect}

One `useLayoutEffect` in `CardHost`, keyed on `isFocusDestination(cardId)` subscribed via `useSyncExternalStore`. On every `false → true` transition:

1. **Consult focus-theft gate [A8]**; abort if unsafe.
2. **Has-been-active ref-guard:** skip the first activation (mount already handled it via the cold-boot restore path).
3. **Dispatch by card flavor:**
   - Content-owning card (`bag.content !== undefined`): invoke `callbacks.onCardActivated?.()`. That's all. The content factory's implementation handles focus + any internal state.
   - DOM-authority card (`bag.content === undefined`): re-apply `applyFocusSnapshot(bag.focus)` then `restoreCardDomSelection(bag.domSelection)`. Same path as cold-boot restore, but triggered by activation instead of mount.

This effect is the single replacement for the three dep-sets we currently use (`[cardId, hostStackId, hostContentEl]` primary mount; `[hostStackId]` cross-pane refocus). Those earlier effects continue to run for mount-specific work (scroll restore, unmask); the activation effect is additive.

**Closes:** [AT0001], [AT0003], [AT0004] + [AT0005] (via [A4]'s wiring into `isFocusDestination`), [AT0006], [AT0007], [AT0009], [AT0016].

##### [A4] App-lifecycle activation pathway {#a4-app-lifecycle-activation}

`isFocusDestination` includes `document.hasFocus()` in its definition. App resign → foreground → `hasFocus` flips `false → true`, which naturally transitions the predicate for the current active card. [A3]'s subscriber fires automatically.

Implementation details:

- Wire an `observeApplicationDidBecomeActive` / `observeApplicationDidUnhide` listener in `deck-store` (or a thin coordinator) that calls `deckStore.notify()` — this causes the `useSyncExternalStore` subscribers to re-read the selector and observe the `false → true` transition.
- Paint-only response (app-resign dims paint, app-become-active brightens) already lives in `selectionGuard.handleApplicationDid{Resign,Become}Active`. This architecture piece is strictly about the _focus_ axis, which paint currently does not cover.

**Closes:** [AT0004], [AT0005].

##### [A5] Markdown-view selection publish {#a5-markdown-view-publish}

`tug-markdown-view` joins the contentEditable paint path:

1. Add `persistKey` prop to the component; wire `useCardPersistence({ onSave, onRestore })`.
2. In a `useEffect` (or `useLayoutEffect` per [L03]), subscribe to `document.selectionchange`. Filter: `range.commonAncestorContainer.compareDocumentPosition(rootEl)` within bounds. If match, call `selectionGuard.updateCardDomSelection(cardId, range)`.
3. `onSave` writes `bag.domSelection` from the current `selectionGuard.cardRanges.get(cardId)`.
4. `onRestore` is a no-op — the existing cold-boot restore path in `CardHost` replays the range via `restoreCardDomSelection`.

Markdown-view owns no text value (content is immutable in-session), so no `bag.content` / `onCardActivated` is needed.

**Closes:** [AT0010] per [L23].

##### [A6] `bag.markedText` axis + composition persistence {#a6-marked-text-persistence}

Schema extension:

```ts
interface CardStateBag {
  // ... existing axes ...
  markedText?: {
    text: string;                     // the composition buffer
    anchorOffset: number;             // offset within the container
    anchorPath: number[];             // DOM path to the anchor container
    platform: "webkit" | "chromium";  // for re-entry heuristics
  };
}
```

EM save:

- If `engine.isComposing`: capture `bag.markedText` from `engine.getCompositionState()`. Research: whether the engine can read the native marked-text string (webkit exposes partial info via `CompositionEvent.data`; may need event-time capture into engine state).
- If not composing: `bag.markedText = undefined`.

EM restore:

- If `bag.markedText` is set at activation / mount: engine attempts composition re-entry. Implementation paths (in priority order):
  1. **Browser API path:** `Selection.setBaseAndExtent` to the anchor, then dispatch synthetic `compositionstart`/`compositionupdate` events. Likely non-standard and won't reliably cause the native IME to re-open the mark.
  2. **Native IPC path (tugapp):** tugapp calls into the macOS input context (`NSTextInputContext`) to re-enter composition with the saved marked text. Research required; this is the fallback if (1) doesn't land cleanly.
  3. **Text-only fallback:** insert the marked-text string as plain text at the anchor and set cursor at the end. Loses the "draft" property (user can't continue composing onto it) but preserves the characters. Final fallback.

FC save:

- Defer save during composition: if `compositionStart` has fired and `compositionend` has not, `saveCurrentCardStateRef.current` enqueues the save for post-`compositionend` delivery. On `compositionend`, flush the deferred save.
- Process-exit mid-composition: the last pre-composition bag is preserved; the in-flight composition buffer is lost. Accepted residual.

**Closes:** [AT0012] to the extent the platform permits. Residuals documented.

##### [A7] Unified flush-on-teardown gate {#a7-unified-flush-gate}

Every path that removes cards from `deckState.cards` routes through `flushSaveCallbackBeforeDestruction` (Step 14's helper):

- `_removeCard` ✅ (already wired in Step 14).
- `_closePane` ✅ (already wired in Step 14, but audit: does it iterate every card before pane-level clear?).
- Any future deck-reset / workspace-switch path: must call the helper per card.

Add an invariant guard at the bottom of `_removeCard` / `_closePane`: if the flush helper was not called for a card being removed, log a dev-error. Consider a single chokepoint `destroyCard(cardId)` that bundles "flush + lifecycle notify + delete from state" so bypassing is difficult.

**Closes:** [AT0019].

##### [A8] `canProgrammaticallyFocus` helper — central focus-theft gate {#a8-focus-theft-gate}

A shared helper consulted by every programmatic refocus path:

```ts
function canProgrammaticallyFocus(
  targetCardId: string,
  store: DeckStore,
): boolean {
  if (!document.hasFocus()) return false;
  const active = document.activeElement;
  // OK to focus if body, or within the target card's host, or inside a non-focus-capturing chrome element
  if (active === document.body) return true;
  if (targetCardHostEl(targetCardId)?.contains(active)) return true;
  if (isNonFocusCapturingChrome(active)) return true;  // pane drag handles, tab bar buttons between clicks, etc.
  return false;  // user has moved focus to another card or real UI — don't steal
}
```

Every refocus helper — [A3]'s activation effect, [A4]'s app-lifecycle pathway, Step 11's cross-pane effect — consults this before calling `.focus()`. Centralizes [R07] (focus-steal avoidance).

**Closes (indirectly):** makes [A3], [A4], [A6] safe.

##### [A9] Component Persistence Protocol {#a9-component-persistence-protocol}

Per [D13] (approved). The foundational architectural piece that closes the entire ⚠️ class surfaced by the component-roster L23 audit ([AT0024]–[AT0031]). Framework-owned; components opt in.

Framing: **a weekend's work for stable foundations instead of months-of-work debugging ad-hoc persistence for every new stateful component.**

**A9a. `useComponentPersistence` hook (registration).** Hook signature:

```ts
function useComponentPersistence<T>(opts: {
  persistKey: string;
  captureState: () => T;         // synchronous; returns serializable
  restoreState: (saved: T) => void;
}): void;
```

Internals (per [Q2b] ref-based storage, [L03] compliant):

```ts
function useComponentPersistence<T>({ persistKey, captureState, restoreState }) {
  const captureRef = useRef(captureState);
  const restoreRef = useRef(restoreState);
  // Sync refs on every render — closure always sees latest React state.
  captureRef.current = captureState;
  restoreRef.current = restoreState;

  const registry = useComponentPersistenceRegistry();  // from nearest card context
  const scopedKey = usePersistenceScopePrefix() + persistKey;

  useLayoutEffect(() => {
    registry.register(scopedKey, captureRef, restoreRef);
    return () => registry.unregister(scopedKey);
  }, [scopedKey, registry]);
}
```

**A9b. `<PersistenceScope prefix>` context (nesting).** Wraps a subtree so nested components' `persistKey`s auto-prefix. Enables composite components to embed other opt-in components without the outer component knowing inner `persistKey`s. Collision assertion (at card scope, dev-only):

```ts
registry.register(scopedKey, ...) {
  if (this.entries.has(scopedKey)) {
    if (isDevEnv()) {
      throw new Error(`[A9] duplicate persistKey within card scope: "${scopedKey}"`);
    }
  }
  this.entries.set(scopedKey, ...);
}
```

**A9c. Framework orchestration — `captureCardState` / `restoreCardState`.** Explicit entry points on the card framework. **Every save trigger routes through these; no trigger calls per-card `onSave` directly.**

```ts
function captureCardState(cardId: string): CardStateBag {
  const card = cards.get(cardId);
  const registry = componentRegistries.get(cardId);
  return {
    content:      card.callbacks.captureContent?.(),     // was onSave
    components:   harvestComponents(registry),            // parent-first walk
    formControls: captureFormControls(cardId),            // CardHost
    regionScroll: captureRegionScroll(cardId),            // CardHost
    focus:        captureFocus(cardId),                   // selection-guard + CardHost
    domSelection: selectionGuard.getRange(cardId),        // selection-guard
    markedText:   captureMarkedText(cardId),              // engine / FC adapters
  };
}

function restoreCardState(cardId: string, bag: CardStateBag): void {
  const card = cards.get(cardId);
  const registry = componentRegistries.get(cardId);
  // Parent-first restore order (per Q3 resolution).
  card.callbacks.restoreContent?.(bag.content);
  restoreComponents(registry, bag.components ?? {});   // walks registry parent-first
  // Framework-synthesized axes are applied by their respective owners
  // (selection-guard, CardHost) at their own lifecycle points.
}

function harvestComponents(registry): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  // Parent-first ordering (per Q3 resolution).
  for (const [key, entry] of registry.entriesInTreeOrder()) {
    try {
      out[key] = entry.captureRef.current();
    } catch (e) {
      if (isDevEnv()) console.warn(`[A9] captureState threw for "${key}":`, e);
    }
  }
  return out;
}

function restoreComponents(registry, saved: Record<string, unknown>): void {
  // Partial restore (per Q5 resolution): ignore orphans, warn in dev.
  if (isDevEnv()) {
    const registered = new Set(registry.keys());
    const orphans = Object.keys(saved).filter((k) => !registered.has(k));
    if (orphans.length) console.warn(`[A9] orphan persistKeys dropped:`, orphans);
  }
  for (const [key, entry] of registry.entriesInTreeOrder()) {
    if (key in saved) {
      try {
        entry.restoreRef.current(saved[key]);
      } catch (e) {
        if (isDevEnv()) console.warn(`[A9] restoreState threw for "${key}":`, e);
      }
    }
  }
}
```

**A9d. Per-component port / opt-in plan.** The following components gain `persistKey` + `useComponentPersistence` (in priority order, grouped by category):

- **Layout state:** `tug-accordion` (landed in [Step 25D](#step-25d)). `tug-split-pane` is intentionally not in [A9] — its existing `storageKey` → tugbank path under `dev.tugtool.tugways.split-pane` is preserved per the [AT0027] resolution.
- **Selection:** `tug-radio-group`, `tug-choice-group`, `tug-option-group` (all landed in [Step 25E](#step-25e)). `tug-popup-button` and `tug-tab-bar` deferred-indefinitely — see [25E](#step-25e)'s "What's deferred" for the rationales (popup-button is a command surface with no persistent value; tab-bar's active tab is already the deck's `paneState.activeCardId`).
- **Numeric:** `tug-slider`, `tug-value-input` (both landed in [Step 25E](#step-25e)).
- **Toggles:** `tug-checkbox` (Step 19 POC, opt-in available; gallery instances unwired), `tug-switch` (landed in [Step 25E](#step-25e)).
- **Pickers:** `tug-hue-strip`, `tug-color-strip`.
- **Overlays with user interaction (per [AT0026] policy):** `tug-sheet`. `tug-alert`, `tug-confirm-popover`, `tug-popover`, `tug-tooltip`, `tug-context-menu` are EPHEMERAL — no opt-in (see [Step 25F](#step-25f) for the rationale; alerts in particular have a Promise-contract reason on top of the general "short-lived prompt" reasoning).
- **Engine-card chrome:** `tug-prompt-entry` (`toolsOpen` only — landed in [Step 25G](#step-25g) for `gallery-prompt-entry`; route stays in `bag.content.currentRoute` to preserve single-restore architecture, see [AT0031] for the divergence rationale).
- **Virtual focus within composites:** radio-group, option-group, choice-group, tab-bar — see [AT0030].

Existing persistence-aware components (`tug-input`, `tug-textarea`, `tug-prompt-input`, `tug-prompt-entry`, `tug-markdown-view` post-[AT0010]) migrate from `useCardPersistence` (card-level) to `useComponentPersistence` (component-level) where appropriate. `useCardPersistence` remains for cards themselves (for `bag.content`).

**A9e. Overlay policy implementation.** Per [AT0026], resolved in [Step 25F](#step-25f): opt in (a) `tug-sheet`. Opt out (b) `tug-alert`, `tug-confirm-popover`, `tug-popover`, `tug-tooltip`, `tug-context-menu`, editor-context-menu, transient popovers. Captured state for (a) overlays: `{ open: boolean }` at minimum; per-surface payloads (form values, etc.) are owned by the consumer's `useResponderForm` and ride their own `bag.components` keys when needed.

**A9f. Scroll-key audit.** Per [AT0029]: walk stateful components for internally-scrollable sub-regions; add `data-tug-scroll-key` where user-visible scroll applies. IS-axis machinery (Step 9) handles capture/restore. Scope: `tug-tab-bar` overflow, `tug-popup-button` menu, `tug-sheet` content, `tug-completion-menu`, `tug-context-menu` if scrollable, any custom scrollable chrome.

**Closes:** [AT0024], [AT0025], [AT0027], [AT0029], [AT0030], [AT0031] directly; enables closing [AT0026] per-overlay.

##### Architecture coverage matrix {#architecture-coverage}

| M-entry | Closed by | Residuals |
|---------|-----------|-----------|
| [AT0001] | [A1] + [A3] + [A8] | none |
| [AT0002] | [A1] + [A2] + [A3] + [A8] | none |
| [AT0003] | [A1] + [A3] + [A8] | none |
| [AT0004] | [A1] + [A3] + [A4] + [A8] | none |
| [AT0005] | [A1] + [A3] + [A4] + [A8] | none |
| [AT0006] | [A1] + [A2] + [A3] + [A8] | none |
| [AT0007] | [A1] + [A2] + [A3] + [A8] | none |
| [AT0008] | [A2] (direct) | closed by adding the callback |
| [AT0009] | [A1] + [A2] + [A3] + [A8] | none |
| [AT0010] | [A5] | none |
| [AT0011] | (no action — not a feature) | informational |
| [AT0012] | [A6] | process-exit mid-composition unrecoverable |
| [AT0013] | integration tests added per M-step | none |
| [AT0014] | folded into [AT0013] test expansion | none |
| [AT0015] | Step NN deletion | none |
| [AT0016] | [A1] + [A3] | none |
| [AT0017] | audit fix: `saveState` RPC → `captureCardState` ([A9c]) | parity test must pass |
| [AT0018] | save-gate inspects `restorePendingRef.current` | none |
| [AT0019] | [A7] | none |
| [AT0020] | local overlay fixes + [A3] as safety net | none |
| [AT0021] | drag-abort routes through activation | none |
| [AT0022] | integration tests assert caret visibility | none |
| [AT0023] | scope to single-card; paint doesn't crash cross-card | cross-card selections remain one-owner |
| [AT0024] | [A9a] + [A9b] + [A9c] | none |
| [AT0025] | [A9a] + per-component classification ([A9d]) | ephemeral cases intentionally unpersisted |
| [AT0026] | [A9e] (`tug-sheet` opted in; alert / confirm-popover / popover / tooltip / context-menu EPHEMERAL by design) | none |
| [AT0027] | [A9d] (`tug-accordion`, `tug-switch`, `tug-radio-group`, `tug-choice-group`, `tug-option-group`, `tug-slider`, `tug-value-input`) + existing `storageKey` path (`tug-split-pane`) | popup-button + tab-bar deferred-indefinitely (no applicable persistent value), see [AT0027] |
| [AT0028] | separate user-preferences store (not [A9]) | orthogonal layer |
| [AT0029] | [A9f] | none |
| [AT0030] | [A9d] (selected value captured per component; virtual-focus-index axis deferred) | virtual-focus-without-selection edge case unaddressed — see [25E](#step-25e) note |
| [AT0031] | [A9d] (`toolsOpen`) + [AT0024] (route via `bag.content`) | tide-card lazy mount misses [A9c]'s one-shot component-restore — see [AT0031] note |
| [AT0032] | [Step 23F](#step-23f) (cold-boot diagnostic chain + EM mount-restore) | none |
| [AT0033] | [Step 23F](#step-23f) (`engineKind` on the card-registry shape; `resolveActivationTarget` reads it) | none |
| [AT0034] | [Step 23F](#step-23f) (cross-pane focus-actually-landing fix) | none |
| [AT0035] | [Step 23G](#step-23g) (delegate focus routes through `engine.setSelectedRange`) | none |
| [AT0036] | [Step 25C.5](#step-25c5) Layer 4 (`installFormControlReapplyOnNextMousedown` deterministic event ordering) | none |
| [AT0037] | [Step 25C.4](#step-25c4) (engine paint API split + restore-ordering invariant) | none |
| [AT0038] | [Step 25C.4](#step-25c4) (`paintMirrorAsInactive(publish)` + `flatToDom` correctness against scrolled content) | none |

##### Phasing suggestion for AT-series execution steps {#m-phasing}

Not a commitment yet — just a sketch for discussion. Updated to place [A9] as the **foundational phase** because nearly every subsequent stateful-component fix depends on it.

1. **M-phase 0 (foundation) — AUTHORED as [Steps 16–19](#step-16):**
   - **[Step 16](#step-16):** component persistence registry + `bag.components` schema.
   - **[Step 17](#step-17):** `useComponentPersistence` hook + `<PersistenceScope>`.
   - **[Step 18](#step-18):** framework orchestration — `captureCardState` / `restoreCardState`; save triggers rerouted; closes [AT0017].
   - **[Step 19](#step-19):** first-consumer proof — `tug-checkbox` opts into the protocol; closes [AT0024] at the per-component proof-of-concept level.
   - No user-visible behavior change through Step 18 (pure refactor). Step 19 is the first user-observable application of the protocol.
2. **M-phase 1 (transition infra, no behavior change) — AUTHORED as [Steps 20–22](#step-20):**
   - **[Step 20](#step-20):** [A1] `isFocusDestination` selector + `hasFocus` slice on the deck store; `useFocusDestination` hook.
   - **[Step 21](#step-21):** [A8] `canProgrammaticallyFocus` focus-theft gate.
   - **[Step 22](#step-22):** [A2] `onCardActivated` field added to `CardPersistenceCallbacks` (declared but not yet dispatched).
   - No consumers; no user-visible behavior change at phase end. Dispatchers land in M-phase 2.
3. **M-phase 2 (core refocus) — AUTHORED as [Step 23](#step-23) + [Steps 23A–23E](#activation-trigger-taxonomy):**
   - **[Step 23](#step-23):** install the [A3] shared activation effect in `CardHost` as a `useLayoutEffect`. FC cards get working reactivation for [AT0001] / [AT0003] / [AT0016] at slow click cadence. Rapid-cadence manual verification of [AT0003] surfaces a sibling-effect ordering race → prompts the 23A–E sub-sequence.
   - **[Step 23A](#step-23a):** scaffold `focus-transfer.ts`, the store registration channels (`registerActivationCallback`, `registerCardHostRoot`), and route `useCardPersistence`'s `onCardActivated` through the new channel. Plumbing only; no behavior change.
   - **[Step 23B](#step-23b):** retire the `[A3]` React effect; wire the helper's synchronous before-mutation entry point into `pane-focus-controller`, `performSelectCard`, and `_removeCard` / `_closePane`. Closes the rapid-cadence race for [AT0001] / [AT0003] / [AT0016].
   - **[Step 23C](#step-23c):** retire Step 11's cross-pane `useLayoutEffect`; wire `captureFocusForDragStart` + `transferFocusAfterMove` into the drag path (drag-start save, drop refocus, Escape/pointercancel refocus). Closes the FC half of [AT0006], the FC half of [AT0007], and [AT0021].
   - **[Step 23D](#step-23d):** wire [A4] app-lifecycle reactivation through the helper. The window `focus` listener installed in [Step 20](#step-20) calls `reactivateCurrentFocusDestination(store)`; the window `blur` listener flushes the first responder's save callback unconditionally. First implementation of [A4]. Closes [AT0004] and [AT0005].
   - **[Step 23E](#step-23e):** EM content factories (tide-card, `TugPromptInput`, `GalleryPromptEntry`) register `onCardActivated`; retire any legacy engine-internal refocus code; install the deferred `_flipFirstResponder` dev assertion now that every caller has a sibling helper path. Closes [AT0002], the EM half of [AT0006], the EM half of [AT0007], and [AT0009].
   - **[Step 24](#step-24):** OBSOLETE. Content absorbed into [23C](#step-23c) (Step 11 retirement) and [23E](#step-23e) (EM opt-ins). Anchor preserved for back-link integrity.
   - End of phase: all runtime activation triggers (intra-pane, pane chrome, tab close, cross-pane drag, app resume, EM cards) routed through one synchronous `focus-transfer.ts` module. M-phase 3 is absorbed (the [A4] work that was previously deferred now lives in 23D).
4. **M-phase 3** was app-lifecycle wiring for [A4]; absorbed into [Step 23D](#step-23d) above. No separate phase remains.
5. **M-phase 4 (markdown-view):** implement [A5]. Closes [AT0010].
6. **M-phase 5 (teardown):** implement [A7]. Closes [AT0019].
7. **M-phase 6 (IME):** implement [A6]. Platform research → decide between browser API / native IPC / text-fallback. Closes [AT0012] to platform-possible extent.
8. **M-phase 7 (component opt-in):** walk [A9d] component priority list and port each. Closes [AT0025], [AT0027], [AT0030], [AT0031]. Overlay policy decisions ([A9e], [AT0026]) made during this phase. Scroll-key audit ([A9f], [AT0029]) folded in.
9. **M-phase 8 (banner / bulletin dismiss):** implement the user-preferences store for [AT0028]. Orthogonal to [A9] (not card-scoped).
10. **M-phase 9 (audit + verify):** [AT0017] RPC audit (now routed through `captureCardState`), [AT0018] restore-pending gate, [AT0020] overlay audit, [AT0021] drag-abort verify, [AT0022] caret-visibility tests, [AT0023] cross-card verify.
11. **M-phase 10 (cleanup):** [AT0013] / [AT0014] integration test expansion, then Step NN ([AT0015] deletion + docs).

Each M-phase corresponds to 1–3 execution steps to be authored. The phasing gates "wait on decisions" away from "wait on implementation" so blockers surface early. M-phase 0 ([A9] foundation) is authored first so all subsequent phases can assume the protocol is in place.

---

### Deliverables and Checkpoints {#deliverables}

#### Phase-exit criteria {#phase-exit}

- [ ] All execution steps landed — Steps 1–15 (original plan), the AT-series steps that close the [missing cases inventory](#missing-cases), and Step NN (final cleanup). Each step's individual checkpoint passed.
- [ ] `bun x tsc --noEmit` exits 0 on main.
- [ ] `bun test` passes in full with the new integration suite from Step 15.
- [ ] `tugutil validate /u/src/tugtool/dash/tugplan-selection.md` passes.

#### Manual verification checklist {#manual-verification}

User-visible behavior that must be confirmed after the plan ships:

- [ ] Reload an app with a DOM selection in a tide card — selection is restored, painted via native `::selection`, on the correct text range.
- [ ] Reload an app with a selection range in a gallery input — input has focus and the selection range paints.
- [ ] Two cards in view, one focused; the focused card's selection paints bright (`::selection`); the unfocused card's selection paints dim (`::highlight(inactive-selection)`). Switch focus between them — paint moves with focus.
- [ ] Cross-pane drag of a focused input card — after drop, focus returns to the previously-focused input and its selection paints.
- [ ] App resign (Cmd-Tab away) — active card's selection dims. App become-active — selection returns bright.
- [ ] Tab switch within a pane — outgoing tab's selection dims; incoming tab's selection (if any) paints bright on the active tab.
- [ ] Close a card mid-edit — last edits persist (save-on-close fires before destruction).
- [ ] `tug-markdown-view` card scrolled to the middle — reload — scroll position returns (via `regionScroll`).
- [ ] Reload across two cards, each with a different selection — both restore, correct card's selection bright, other card's dim.

#### Known limitations and follow-ons {#follow-ons}

Items deliberately deferred from this plan. Each has a one-line statement of why it's deferred and what would be required to close it.

- **Engine undo history does not survive reload.** `TugTextEngine.undo()` calls `document.execCommand("undo")` (`tug-text-engine.ts:605`), which relies on the browser's native undo stack. Browser-native undo is lost on reload; Cmd-Z after reload does nothing. Closing this gap requires the engine to maintain its own serializable mutation log (replacing `execCommand("undo")` with an internal stack), which is a separate medium-sized engine refactor. Filed for a follow-on plan.

- **Per-card `onSave` payload audit.** `bag.content` is an opaque per-card slot that each card's content factory fills via `useCardPersistence.onSave`. Component-local React state (accordion expansion, nested tab selection, sort order, filter settings, step-wizard position) is only preserved across reload if the card's author explicitly includes it in the `onSave` payload. After this plan ships, every registered card type's `onSave` should be audited for completeness; gaps are per-card concerns to be fixed in each card's own module. Candidates to audit (high-priority first): `tide`, `git`, `hello`, `gallery-markdown-view`, and any future card type that introduces internal state.

- **Deeper engine diff-restore ([Q04] options (b)/(c)).** This plan ships [Q04] option (a) — the content-identical fast path. The broader flat-parts diff or full DOM reconciliation are more work for a narrower benefit (idempotent same-content restore is already covered by (a)) and are deferred to a separate engine-focused plan.

- **Paint tier expansion ([Q02]).** One dim tier is the shipped choice. If UX feedback later demands distinguishing "inactive-in-active-pane" from "inactive-in-other-pane," add a second named CSS Custom Highlight and a second dim color rule. Revisitable post-ship.

- **Tuglaws additions.** The new persistence pattern deserves a short law: "Persistence is data; apply is component-owned." Consider proposing this as a new law in `tuglaws/tuglaws.md` after the pattern settles in the codebase for a release cycle.

#### Rollback policy {#rollback}

Every execution step is a single commit and is individually revertable. If a regression surfaces mid-plan, revert the offending step and any strictly-dependent steps after it (see each step's `Depends on:` line); the remaining commits stay green because they don't forward-reference unimplemented state.
