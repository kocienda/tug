## The Lens — anchored pane, focus integration, and dev-panel retirement {#lens-frame}

**Purpose:** Ship the Lens — a right-side panel that renders one scrolling stack of reorderable, collapsible **sections** where the Tug dev panel sits today — as a real **anchored pane** hosting an ordinary registered card, plus the two sections (Log, Telemetry) and the Settings move that let the dev panel be deleted. This is **M3a** of the Lens direction; the Changeset section (M3b) and a Git History section (M3c) are later plans that only add section registrants.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-07-14 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The Dev card's transcript established the house display grammar: one scroll of sections whose blocks expand, sticky headers telescoping via a pin stack (`--tugx-pin-stack-top`). The Lens generalizes that grammar to a **panel-level workbench** — co-resident sections (changeset, git history, telemetry, log) visible together, *without tab-switching*. The hallmark that makes a stack of sections beat a tab bar is the **informative collapsed header**: a collapsed section is not a dead title but a one-line live summary that answers the section's question at a glance. This is a hard requirement of the section contract — every section must supply a collapsed-summary factory.

The Lens takes over the screen location and keybinding budget of the current **Tug dev panel** (`tugdeck/src/components/tug-dev-panel/`), a fixed right-side overlay with a three-tab strip (Telemetry / Log / Settings) and **zero** focus-system integration. This plan retires it. An earlier draft of this plan built the Lens as a bespoke fixed overlay that hosted a "card" *outside* `CardHost`/`TugPane` — which violated **[L25]** (Deck → Pane → Card is the canonical hierarchy; geometry and chrome are Pane responsibilities). That design is discarded. The Lens now ships the law-faithful way: a real **anchored pane** whose geometry is *derived* (pinned to the right edge) rather than free, hosting an ordinary `registerCard`ed card through the normal `CardHost`. The pane/card machinery — `FocusContext`, responder scope, the four per-content contexts, portal-preserved React identity, title-bar chrome — is the point: it makes Cmd-L, focus restore, and the `…` menu nearly free.

#### Strategy {#strategy}

- Design a new **anchored-pane** treatment at the pane layer ([P01]): a `TugPaneState` marker whose geometry resolves to right-edge / full-height / persisted-width, non-draggable, resizable only on its left edge, excluded from snap and card-merges. Everything else about it is an ordinary pane.
- Host an ordinary `registerCard({ componentId: "lens", hidden: true, … })` card inside that pane via the normal `CardHost` — **no bespoke shell, no synthetic `CardIdContext`, no bypass** ([P01]). The Lens toggle is the `showSingletonCard` precedent (`deck-manager.ts`), specialized to create the singleton in an anchored pane.
- Route Cmd-L's focus-in through the **same activation path a click takes** — `transferFocusForActivation` → `applyBagFocus` → `adoptKeyCard` (`focus-transfer.ts`) — which already handles the late-mount "open-then-focus" case via `armKeyboardRestore`. No bespoke focus plumbing ([P05]).
- Land in milestone slices, each independently green: **(A)** anchored-pane API + lens card + store + keybindings + focus in/out; **(B)** section registry + sticky band + drag reorder + `…` menu; **(C)** Log + Telemetry sections; **(D)** Settings "General" tab move; **(E)** dev-panel deletion + test sweep.
- Model the section **band** on `TugTranscriptEntry`'s participant band (a sticky title row writing `--tugx-pin-stack-top`), **not** `BlockChrome` — a BlockChrome band would nest M3b's changeset content three sticky levels deep ([P06]).
- Reuse house patterns wholesale: the dev-panel store shape (tugbank reducer) for section prefs, the pane resize feel, `TugPopupMenu` for the `…` menu, an existing house drag for reorder. No new libraries.

#### Success Criteria (Measurable) {#success-criteria}

- Opt-Cmd-L shows/hides the Lens pane; its open state and width persist across reload. Verified by an app-test toggling via the control action and re-reading the deck layout + lens store. ([#step-3])
- Cmd-L moves keyboard focus **into** the Lens (opening it if hidden) through the normal activation path, Tab walks section-to-section, and Escape (or Cmd-L again) restores the previously active card. Verified by an app-test asserting `store.getFirstResponderCardId()` / `focusManager.keyCard()` before/inside/after. ([#step-3], [#step-6])
- The Lens pane is a real pane: it appears in `deckState.panes`, its card in `deckState.cards`, and it is exempt from drag/snap/merge. Verified by an app-test inspecting the deck snapshot and attempting a drag. ([#step-2])
- Sections render in a persisted order that survives reload; dragging a section rewrites both the persisted order and the FocusManager group-walk order. Verified by an app-test. ([#step-6])
- The title-bar `…` menu lists every registered section with a checkmark reflecting visibility; toggling shows/hides and persists. Verified by an app-test. ([#step-7])
- The Log section renders real `tugDevLogStore` entries with a live count collapsed-summary; Telemetry renders the active dev card's real telemetry and names it. Verified by app-tests driving a real session. ([#step-8], [#step-9])
- The dev panel is gone; `bunx tsc --noEmit && bunx vite build && bun test && (cd tugrust && cargo nextest run)` green; grep finds no dev-panel references. ([#step-11])

#### Scope {#scope}

1. Anchored-pane API at the pane layer (marker, derived geometry, drag/snap/merge exclusion, left-edge resize) + its serialization/compat story.
2. The Lens card (`registerCard`, hidden) hosted by `CardHost` in the anchored pane; the `dev.tugtool.lens` store; keybindings (retire `Opt-Cmd-/`; add `Opt-Cmd-L` toggle, `Cmd-L` focus); focus in / between / out via the normal activation path.
3. Section registry + host-agnostic section contract (required collapsed-summary), sticky band, drag reorder, `…` visibility menu.
4. Two sections: Log and Telemetry.
5. Move the dev panel's focus-ring-modality setting to a new "General" tab on the Settings card.
6. Delete the dev panel and sweep the app-test suite.

#### Non-goals (Explicitly out of scope) {#non-goals}

- The **Changeset** (M3b) and **Git History** (M3c) sections. The frame must be section-agnostic enough that they only add registrants.
- Showing a Lens section as its own deck card (future; the contract must not preclude it).
- Deck reflow. v1 overlays the free panes like the dev panel — free panes do not shrink.
- Any change to the changeset card itself (retired in M3b).

#### Dependencies / Prerequisites {#dependencies}

- The Deck → Pane → Card model (`layout-tree.ts`, `deck-manager.ts`, `deck-canvas.tsx`, `tug-pane.tsx`, `card-host.tsx`) and the v4 layout serialization (`serialization.ts`).
- The FocusManager per-card context + the activation path (`focus-transfer.ts` `applyBagFocus`/`transferFocusForActivation`).
- The block grammar re-home to `tugdeck/src/components/tugways/blocks/` (landed, `f6904982b`).
- tugbank defaults persistence (`/api/defaults/<domain>/<key>`).

#### Constraints {#constraints}

- **Tuglaws — [L25] above all.** Read `tuglaws/tuglaws.md`, `tuglaws/pane-model.md`, `tuglaws/focus-language.md`, `tuglaws/responder-chain.md`, `tuglaws/component-authoring.md`. Fill the [State Zone Mapping](#state-zone-mapping). Name touched laws in each commit. **If any instruction here conflicts with a law, the law wins — surface it in [Open Questions](#open-questions), don't plan around it.**
- **Real Tug components only.** Compose `TugPopupMenu` / `TugIconButton` / `TugLabel` / `TugRadioGroup`. Never hand-roll a menu, button, or radio.
- **No localStorage.** Persistence goes through tugbank (the deck layout blob + `dev.tugtool.lens`).
- **No height estimates / no windowing.** The section scroller is a plain `overflow-y:auto` div, sections rendered inline at real measured heights.
- **Appearance is CSS/DOM ([L06]); external state enters React via `useSyncExternalStore` ([L02]); FocusManager and deck state are structure ([L22]) — never mirrored in `useState`.**
- **Tooling.** bun, never npm. Every step passes `bunx tsc --noEmit && bunx vite build && bun test`. Swift/menu steps additionally run `just app-test-build` (rebuild + resign). App-tests are real (`tests/app-test/`, `just app-test`) — no jsdom, no mocks.
- **Artifact hygiene.** No plan-step numbers in code. No rationale/backstory comments.

#### Assumptions {#assumptions}

- `Cmd-L` is unbound in both tracks. **Verified:** `grep KeyL keybinding-map.ts` → no match; no Swift menu item uses `keyEquivalent: "l"` with `.command`. Re-verify at implementation time.
- The normal activation path resolves the open-then-focus ordering. **Verified:** `applyBagFocus` (`focus-transfer.ts`) calls `adoptKeyCard(cardId)` and, when the focusable is not yet mounted (`deferred-dom`), `armKeyboardRestore(resolution.key)` — so activating a just-created lens card lands the ring when its content registers, with no bespoke plumbing ([P05]).
- The log store's persisted filter prefs (domain `dev.tugtool.dev-panel`) may keep that domain string for data continuity after the dev panel is deleted, as long as the constant is re-homed off the deleted store ([P09]).

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

Explicit `{#anchor}` headings; plan-local decisions `[P01]`… (never `[D01]`); steps cite decisions/specs/anchors, never line numbers.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Wire-contract shape for the anchored pane (DECIDED) {#q01-wire-contract}

**Question:** How does an anchored pane serialize into the v4 layout blob (`dev.tugtool.deck.layout` = `{version:4, cards, panes[], activePaneId?}`), and does it reopen on reload?

**Why it matters:** `TugPaneState` today is `{ id, position, size, cardIds, activeCardId, title, acceptsFamilies, collapsed? }` — no anchor concept. `serialization.ts` `parseV4` also *fits* every pane to the canvas (`fitPane`, `FIT_MARGIN`), which would fight a derived right-edge geometry. Choosing wrong breaks reload or corrupts free-pane layout.

**Options:** (a) additive optional field `anchor?: "right"` on `TugPaneState`, round-tripped by `parseV4`/serialize, anchored panes exempt from `fitPane`; (b) a reserved pane id; (c) keep the pane out of the blob and reconstruct at runtime from `dev.tugtool.lens`.

**Resolution:** DECIDED — option (a), recorded as [P02]. Additive optional field (like `collapsed?`) needs **no version bump**; old blobs simply have no anchored pane; `parseV4` skips `fitPane` for a pane carrying `anchor`. The open lens pane thus persists and reopens anchored on reload (consistent with every other pane). Migration/compat story in [P02].

#### [Q02] `…` visibility menu — is there a prior pane-menu affordance to match? (DEFERRED — [#step-7]) {#q02-overflow-affordance}

**Question:** `pane-model.md` names a `toggleMenu` responder action on panes; the direction asks to "bring back" a prior pane-menu affordance and match it. Does one exist?

**Why it matters:** Visual consistency; avoid inventing a divergent treatment.

**Plan to resolve:** **Verified now:** `toggleMenu` is named in `pane-model.md` but is **not** implemented — it is absent from `action-vocabulary.ts` and from `TugPane`'s responder actions (which are `CLOSE`, `CLOSE_ALL`, tab actions only). `git log -S toggleMenu -- tugdeck/src` surfaces only refactors, no prior `…` menu. So the `…` is **new** pane-title-bar chrome. Default to the house pattern: a `TugIconButton` (`MoreHorizontal`) triggering a `TugPopupMenu`, placed to the left of the collapse chevron in `CardTitleBar`. Re-run the search at implementation time.

**Resolution:** DEFERRED to [#step-7] with the documented default.

#### [Q03] Persist section collapse, or keep it session-local? (DECIDED — persist, [P03]) {#q03-collapse}

**Question:** Is per-section collapse persisted (`collapsedSections` key) or component-local ([L24] `useState`)?

**Why it matters:** The direction lists `collapsedSections` as a store key **and** flags collapse as a "decide persisted-vs-local" call.

**Resolution:** DECIDED — persist it in `dev.tugtool.lens` ([L02]); the expand/collapse *appearance* is a `data-collapsed` attribute + CSS ([L06]). Collapse is a user arrangement of the same class as section order/visibility, all persisted. See [P03], [State Zone Mapping](#state-zone-mapping).

#### [Q04] Does an anchored (derived-geometry) pane conflict with [L09]/[L25]? (DECIDED — no) {#q04-law-check}

**Question:** [L09] says "TugPane owns geometry; Cards never set their own position/size." An anchored pane's geometry is *derived* from an anchor descriptor rather than a stored `position`. Is that a law conflict?

**Resolution:** DECIDED — **no conflict.** The pane still *owns* its geometry; it merely computes it from an `anchor` descriptor instead of a free `position`. Geometry ownership stays at the pane layer; the card supplies content identity only. This is squarely within [L09]/[L25]. Recorded so a reviewer doesn't re-litigate it. The z-order question (an anchored pane must paint above free panes) is a real design point, resolved in [P04].

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| `fitPane` clamps the anchored pane's derived geometry | high | med | `parseV4` skips `fitPane` for anchored panes ([P02]); app-test asserts right-edge geometry after reload | Lens reopens mis-sized after reload |
| Deleting `tug-dev-panel-store` breaks the log store's domain import | med | high | Re-home the domain constant off the store before deletion ([P09], [#step-8]) | tsc error on `DEV_PANEL_DOMAIN` |
| Shared inspector helpers live under the deleted dir | med | high | Relocate them out of `tug-dev-panel/` as sections consume them ([P10], [#step-8]/[#step-9]) | build breaks at [#step-11] deletion |
| Anchored pane drags/snaps like a free pane | med | med | Exclude from drag start, snap rect snapshot, and merge hit-test ([P01]); app-test attempts a drag and asserts no move | Lens can be dragged off the right edge |

**Risk R01: Anchored geometry vs. the canvas-fit clamp** {#r01-fitpane}

- **Risk:** `serialization.ts parseV4` fits every pane into the canvas (`fitPane`/`FIT_MARGIN`); an anchored pane's derived right-edge geometry would be corrupted on reload.
- **Mitigation:** [#step-2] makes `parseV4` (and any in-session clamp) skip panes carrying `anchor`; an app-test reloads with the lens open and asserts geometry.
- **Residual risk:** None once the skip is in place.

---

### Design Decisions {#design-decisions}

#### [P01] The Lens is an anchored pane hosting an ordinary card (DECIDED) {#p01-anchored-pane}

**Decision:** Design an **anchored-pane** treatment at the pane layer and host an ordinary registered card in it via the normal `CardHost`.

- **Pane marker:** add an optional `anchor?: "right"` field to `TugPaneState` (`layout-tree.ts`). Extensible to other edges later; only `"right"` in v1.
- **Derived geometry:** in the deck-canvas → `TugPane` render path, a pane with `anchor: "right"` resolves to `right:0; top:0; bottom:0; width: size.width` instead of free `position`/`size`. The derivation lives at the pane render layer (where geometry already lives, [L09]).
- **Behavior:** non-draggable (title-bar `onDragStart` is a no-op for anchored panes); resizable **only** on the west (left) edge (the other seven `RESIZE_EDGES` are suppressed); excluded from `snapshotCardRects`/`computeSnap` and from tab-bar merge hit-testing; `acceptsFamilies: []` (or a lens-only family) so no card merges into it.
- **The card:** `registerCard({ componentId: "lens", hidden: true, contentFactory: (cardId) => <LensContent cardId={cardId} />, defaultMeta: { title: "Lens", closable: true }, acceptsFamilies: [] })`. Hosted by the normal `CardHost` (which already provides `CardIdContext`, the responder scope, and the four per-content contexts). **No bespoke shell; no synthetic `CardIdContext`; no `CardHost`/`TugPane` bypass.**

**Rationale:** [L25]/[L09] — geometry and chrome belong to the pane; content identity to the card. Hosting through `CardHost` gives the Lens its `FocusContext`, responder scope, and title-bar chrome for free, which is what makes Cmd-L, focus restore, and the `…` menu nearly free.

**Implications:** `TugPaneState` gains `anchor?`; `TugPane` gains an anchored branch for geometry/drag/resize; `deck-canvas` z-computation places anchored panes above free panes but below the overlay base ([P04]); `serialization.ts` must **explicitly parse** `anchor` in `parseV4`'s field-by-field pane rebuild (it is dropped otherwise) and exempt anchored panes from `fitPane` ([P02]).

#### [P02] The anchored lens pane persists in the layout blob; `open`=presence, live `width`=pane `size.width` (DECIDED) {#p02-persistence}

**Decision:** The anchored lens pane is a real member of `deckState.panes` (its card a real member of `deckState.cards`) whenever the Lens is open. **`open` = the pane's presence** (add on show, `handlePaneClosed` on hide — the `showSingletonCard` precedent). **Live `width` = the anchored pane's `size.width`** in the v4 blob, updated by the left-edge resize commit. The **reopen width** is mirrored to `dev.tugtool.lens/widthPx` so a hide→show cycle (which removes the pane) restores the user's preferred width. **Section prefs** (`sectionOrder`, `hiddenSections`, `collapsedSections`) live in `dev.tugtool.lens`.

Wire/compat: `anchor?` is an **additive optional** field on the pane — no version bump (same as `collapsed?`). Old blobs have no anchored pane; a hypothetical old build reading a new blob would see an unknown field and (lacking anchored handling) render a free pane at its stored `size` — a graceful, non-crashing degradation.

**Serialization gotcha (both sides).** `serialize()` writes `panes: deckState.panes` wholesale, so the write side carries `anchor` for free — BUT `parseV4` (`serialization.ts`) does **not** round-trip a pane by spread; it **reconstructs each pane field-by-field** (copying only `id`/`position`/`size`/`cardIds`/`activeCardId`/`title`/`acceptsFamilies`/`collapsed`) and drops every field it doesn't explicitly copy. So `anchor` is **silently dropped on read** unless [#step-2] adds it to that reconstruction — the lens would reopen as a *free* pane after reload even though the blob on disk was correct. Two edits in `parseV4`, both required: (1) parse and carry `anchor` in the rebuilt `TugPaneState`; (2) **skip `fitPaneGeometry`** for anchored panes — it runs unconditionally per pane today and would floor/cap the derived rail width against the canvas ([R01]).

**Rationale:** Keeps live geometry in the pane where [L25]/[L09] demand it; the lens domain holds only the *preferred reopen width* (a preference, not live geometry) and the section prefs. `open`=presence mirrors the Settings singleton exactly (`showSingletonCard` → activate-or-add; close removes), the lowest-surprise house pattern.

**Implications:** New deck-manager method to create the singleton in an *anchored* pane (`addCard` today only makes free panes); the left-edge resize commit writes `size.width` and mirrors to `dev.tugtool.lens/widthPx`.

#### [P03] Lens store: section prefs + reopen width under `dev.tugtool.lens` (DECIDED) {#p03-lens-store}

**Decision:** A store `tugdeck/src/lib/lens-store/` (mirroring `tug-dev-panel-store/`'s pure-reducer + lazy-init + tugbank-hydrate + PUT-on-diff shape) under domain `dev.tugtool.lens`, keys: `widthPx` (i64, reopen width), `sectionOrder` (json `string[]`), `hiddenSections` (json `string[]`), `collapsedSections` (json `string[]`). It does **not** own `open` (that is pane presence, [P02]).

**Rationale:** The dev-panel-store is a proven, law-conformant ([L02], ref-stable, no localStorage) template. Section prefs are card/panel-content concerns, not deck-layout geometry, so they belong in a content-domain store, not the layout blob.

**Implications:** Persisted lists tolerate unknown/removed section kinds (a future-shape entry must not crash) — mirror the dev-panel reducer's reject-and-keep hydrate.

#### [P04] Anchored panes paint above free panes but BELOW the overlay base (DECIDED) {#p04-ztier}

**Decision:** `deck-canvas.tsx`'s z-index computation assigns an anchored pane a z that is **above every free pane yet strictly below the canvas-overlay base** — concretely `calc(var(--tug-z-overlay-base) - 1)` = **8999**, the exact tier the dev panel uses today (`tug-dev-panel.css`). Free panes get tiny array-order z (`CARD_ZINDEX_BASE + arrayIndex` = 1..N), so 8999 clears them with vast headroom.

**Rationale:** This is the single subtlest stacking constraint. `CanvasOverlayRoot` is the `--tug-z-overlay-base` = **9000** tier that *every* popup, menu, and tooltip portals into — including the Lens's own `…` menu and any section popovers. If the anchored pane were given a z **above** 9000 (the naive reading of "a tier above everything"), those popups would paint **behind the Lens** and be invisible — the exact bug `tug-dev-panel.css` documents and dodges by sitting at 8999. So the anchored pane must sit *under* the overlay base: above free panes (so the rail is never occluded by a card), below the overlay (so its own popups paint on top). The overlay root is a canvas sibling at 9000, so it clears 8999 automatically.

**Implications:** The z computation special-cases `anchor` with a constant just under `--tug-z-overlay-base` (not a large "always on top" number); document it beside the existing `zIndexMap` logic and cite the `tug-dev-panel.css` precedent. An app-test opens the `…` menu with the Lens present and asserts the menu is on top (hit-testable), guarding against a regression to an above-overlay z.

#### [P05] Cmd-L focus-in reuses the normal activation path (DECIDED) {#p05-focus-activation}

**Decision:** Cmd-L (`FOCUS_LENS`): ensure the lens pane exists (create if absent), then activate its card through `transferFocusForActivation({ incomingCardId: lensCardId, … })` — the *same* helper a tab click / pane activation uses. Focus-out: stash the prior `store.getFirstResponderCardId()` on Cmd-L entry; Escape inside the Lens (a `CANCEL_DIALOG` handler on the lens content) or Cmd-L again re-activates the stashed card via the same helper. Tab walks sections via `FocusContext.setGroupOrder` (rewritten on reorder, [P08]); ⌥⇥ cycles sections via `use-cycle-mode`.

**Rationale:** **Verified** `applyBagFocus` (which `transferFocusForActivation` calls) runs `adoptKeyCard(cardId)` and, when the target focusable is not yet mounted (`deferred-dom`), `armKeyboardRestore(resolution.key)` — so the open-then-focus ordering is handled by the existing path with **no bespoke plumbing**. This is the payoff of hosting a real card in a real pane.

**Implications:** The `FOCUS_LENS` chain handler lives at the deck/canvas level (where `SHOW_SETTINGS` is handled, `deck-canvas.tsx`), because the keybinding dispatches through the chain and the pane may be absent when Cmd-L fires.

#### [P06] The section band models `TugTranscriptEntry`, not `BlockChrome` (DECIDED) {#p06-band-model}

**Decision:** The section band is a sticky title row (glyph + title + collapsed-summary + drag grip + chevron) writing `--tugx-pin-stack-top` for its subtree via the `TugTranscriptEntry` pattern: a `useLayoutEffect` + `ResizeObserver` measuring the band header height onto the section root (`Math.ceil(px) + TIER_GAP_PX`). Nested clearance replicates the `.changeset-entry-block` pin-clearance pair in `changeset-card.css`.

**Rationale:** A `BlockChrome`-based band would make M3b's changeset content nest three sticky levels deep (panel band → block chrome → block header). Modeling the participant band keeps it two levels and reuses a proven, non-cyclic clearance-capture.

**Implications:** Copy the `ResizeObserver` measurement discipline verbatim — **do not** seed synchronously with `getBoundingClientRect` (the `TugTranscriptEntry` docstring documents the O(n²) reflow that causes). A static `--tugx-pin-stack-top` CSS fallback covers the first frame.

#### [P07] Section contract: host-agnostic body, required collapsed-summary (DECIDED) {#p07-section-contract}

**Decision:** `LensSectionDefinition` separates a **band descriptor** (`kind`, `title`, `glyph`, the **required** `collapsedSummary` factory) from a **body factory** (`(host: LensSectionHost) => React.ReactNode`). A body imports nothing from `lens/`; anything it needs arrives via the `host` argument. Reserved capability hooks (`findSegments?`, `followBottom?`, `responderNeeds?`) are declared in the type, unimplemented.

**Rationale:** M3-future may render a section as its own deck card; a body reaching into panel internals would preclude that. Keeping `collapsedSummary` in the *descriptor* lets the band render a live summary while the body is collapsed/unmounted.

**Implications:** The Log/Telemetry bodies take data from their own global/per-card stores, not the panel. `collapsedSummary` subscribes to the same store and returns a one-line node.

#### [P08] Reorder rewrites both persisted order and the FocusManager group order (DECIDED) {#p08-reorder}

**Decision:** Drag-and-drop reorder (grounded in an existing house drag pattern, not a new DnD library) commits the new order to `lensStore.setSectionOrder(...)`; the lens content renders in `sectionOrder` and, in a `useLayoutEffect`, calls `focusManager.contextFor(lensCardId).setGroupOrder([...visible section groups])` so the Tab walk tracks the visual order.

**Rationale:** [L22] — group order is structure owned by the FocusManager, driven off the store, never a parallel `useState`. Persisted order + synchronized keyboard walk is the point of "reorderable sections."

**Implications:** Live drag preview is DOM-only ([L06]/[L08]); only the drop commits the store.

#### [P09] Re-home the log store's persistence domain off the deleted store (DECIDED) {#p09-log-domain}

**Decision:** Before deleting `tug-dev-panel-store/`, move the `DEV_PANEL_DOMAIN = "dev.tugtool.dev-panel"` constant the log store depends on into the log store's own module (keep the **same string** so persisted filter prefs survive). Repoint `tug-dev-log-store/__tests__/persistence.test.ts`.

**Rationale:** `tug-dev-log-store.ts` imports `DEV_PANEL_DOMAIN` from `tug-dev-panel-store/types`; the store is panel-independent, so the coupling is incidental. Keeping the string avoids orphaning users' persisted log filters.

**Implications:** The log store gains a local `LOG_STORE_DOMAIN`; no data migration.

#### [P10] Relocate shared inspector helpers out of `tug-dev-panel/` before deletion (DECIDED) {#p10-relocate-helpers}

**Decision:** Five helpers the sections re-use live under `tug-dev-panel/` (deleted in [#step-11]) and are **moved** (`git mv`) into `tugdeck/src/components/lens/internal/` as the consuming steps land, tests included:

| Helper (current) | Consumed by | Moves in |
|---|---|---|
| `tug-dev-panel/copy-as-json.ts` | Log + Telemetry | [#step-8] |
| `tug-dev-panel/inspectors/log-row.tsx` | Log | [#step-8] |
| `tug-dev-panel/field-row.tsx` | Telemetry | [#step-9] |
| `tug-dev-panel/field-section.tsx` | Telemetry + Settings | [#step-9] |
| `tug-dev-panel/inspectors/telemetry-projection.ts` | Telemetry | [#step-9] |

**Rationale:** [#step-11] deletes `tug-dev-panel/` entirely; a body importing a helper from the old path would break at deletion.

**Implications:** [#files-deleted] must not list the moved helpers; the section bodies (and the Settings General body, [#step-10]) import from `lens/internal/`.

#### [P11] Telemetry follows the last non-lens key card; no manual picker (DECIDED) {#p11-telemetry-follows}

**Decision:** The Telemetry section reads the **last non-lens key card** (track the previous `focusManager.keyCard()` that is not the lens card id, subscribed via `useSyncExternalStore(focusManager.subscribe, …)`), resolves `cardServicesStore.getServices(thatCardId)`, names the card in its band, and empty-states when none exists. It drops the dev panel's manual `selectedCardId` picker.

**Rationale:** The Lens is always-present chrome; "the dev card I'm working in" is the natural subject. Because focusing the Lens itself makes *it* the key card, the section must remember the *previous* non-lens key card rather than the literal current one. `focusManager.subscribe` + notify-on-`setKeyCard`-change makes this reactive.

**Implications:** A small "last non-lens key card" selector; `notifyCardGone` wiring (`main.tsx` `knownCardIdsForDevPanel`) is not needed and is removed with the dev panel.

#### [P12] The dev panel's Settings tab becomes a new "General" tab on the Settings card (DECIDED) {#p12-settings-move}

**Decision:** Move the focus-ring-modality control (`SettingsInspector` content) to a **new** user-facing "General" tab on the Settings card (`settings-card.tsx`). The existing `SettingsTabId` value `"general"` — mislabeled "Dev Card", rendering `SettingsGeneralBody` — is renamed to `"devCard"` (grep consumers first), freeing `"general"` for the real General tab.

**Rationale:** Focus-ring modality is a genuine app setting that has outgrown the dev surface; the id/label mismatch is a latent trap, fixed while here.

**Implications:** New General body composing `TugRadioGroup` via `useResponderForm` (the `settings-app-body.tsx` shape); `focusRingModalityStore` + `dev.tugtool.app/focusRingModality` persistence unchanged; imports `field-section` from its relocated `lens/internal/` home ([P10]).

---

### Specification {#specification}

#### Terminology {#terminology}

- **Lens** — the right-side panel. **Anchored pane** — a pane whose geometry is derived (right-edge rail) rather than free. **Section** — one reorderable/collapsible unit in the Lens stack. **Band** — a section's sticky title row. **Collapsed-summary** — the required one-line live node a band shows when collapsed.

**Spec S01: `LensSectionDefinition`** {#s01-section-def}

```ts
export interface LensSectionDefinition {
  kind: string;                       // stable id, e.g. "log", "telemetry"
  title: string;
  glyph: React.ReactNode;
  collapsedSummary: (host: LensSectionHost) => React.ReactNode; // REQUIRED — the hallmark
  body: (host: LensSectionHost) => React.ReactNode;             // host-agnostic
  findSegments?: unknown;   // reserved — declared, not implemented
  followBottom?: unknown;
  responderNeeds?: unknown;
}
export function registerLensSection(def: LensSectionDefinition): void;
export function getRegisteredLensSections(): ReadonlyMap<string, LensSectionDefinition>;
```

`LensSectionHost` exposes only what a body needs from the panel (e.g. `{ lensCardId, focusGroup }`) — no panel internals ([P07]).

**Spec S02: anchored-pane geometry + interaction** {#s02-anchored-pane}

A pane with `anchor: "right"` (`TugPaneState`): geometry `right:0; top:0; bottom:0; width: size.width`; drag disabled; resize confined to the west edge; excluded from snap and merge; z above free panes but below the overlay base (8999, [P04]); `acceptsFamilies: []`. `serialization.ts parseV4` must **explicitly parse** `anchor` in its field-by-field pane rebuild (dropped otherwise) and skip `fitPane` for it.

**Spec S03: generic pane title-bar menu, contributed by the active card** {#s03-title-bar}

The `…` menu is a **generic pane affordance whose contents the active card contributes** — NOT lens-specific chrome baked into `TugPane`. This realizes the `toggleMenu` pane responder action `pane-model.md` already reserves, and keeps `tug-pane.tsx` free of any lens import ([L10]/[L25]).

- **Contribution channel (mirrors `cardTitleStore`).** A new module-scope store `paneTitleBarMenuStore` (sibling of `lib/card-title-store.ts`, same shape: `subscribe`/`getSnapshot`/`set(cardId, items | null)`, keyed by `cardId`) lets any card publish its title-bar menu items (or `null` for none). `cardTitleStore` is the exact precedent: a card publishes into a per-card store, `TugPane` subscribes and renders — no card-specific coupling in the pane.
- **Generic render in `CardTitleBar`.** `CardTitleBar` subscribes to `paneTitleBarMenuStore` for the active card. When that card has published items, it renders a `TugIconButton` (`MoreHorizontal`) to the **left** of the collapse chevron, triggering a `TugPopupMenu` built from the published items; when the card published nothing, no `…` renders (every non-contributing pane is unchanged). `tug-pane.tsx` imports only the generic store — never `getRegisteredLensSections`/`lensStore`.
- **The lens card contributes.** `LensContent` publishes one item per `getRegisteredLensSections()` entry — label = section title, `checked = !hiddenSections.includes(kind)`, action toggles `lensStore.setHidden(kind, …)` — into `paneTitleBarMenuStore.set(lensCardId, …)`, and clears it (`set(lensCardId, null)`) on unmount. Present whenever the lens pane is open (the title bar always renders). The section-visibility logic lives entirely in the lens layer; the pane just renders what it's handed.

#### State Zone Mapping (tugdeck/tugways) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| Lens `open` | structure | anchored pane presence in `deckState` (add / `handlePaneClosed`) | [L22], [L25] |
| Lens live `width` | structure | anchored pane `size.width` in the v4 blob; west-edge resize commit | [L09], [L25] |
| Lens reopen `width` | data | `lensStore.widthPx` (tugbank) | [L02] |
| `sectionOrder` | data | `lensStore` | [L02] |
| section Tab-walk order | structure | `FocusContext.setGroupOrder`, driven off `sectionOrder` | [L22], [L03] |
| `hiddenSections` | data | `lensStore` | [L02] |
| `collapsedSections` | data | `lensStore`; expand/collapse visual via `data-collapsed` + CSS | [L02], [L06] |
| anchored-pane derived geometry | appearance | computed `right/top/bottom/width` at pane render | [L06], [L09] |
| section band sticky offset | appearance | `--tugx-pin-stack-top` via `useLayoutEffect` + `ResizeObserver` | [L06], [L03] |
| Lens focus in/out | structure | `transferFocusForActivation` / `applyBagFocus` / stashed prior | [L22] |
| Telemetry "last non-lens key card" | structure (read) | `focusManager.subscribe` + `keyCard()` selector | [L07], [L02] |
| drag-reorder live preview | appearance | DOM-only until drop | [L06], [L08] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/lib/lens-store/{types.ts,reducer.ts,lens-store.ts}` | `dev.tugtool.lens` store (section prefs + reopen width) |
| `tugdeck/src/components/lens/lens-content.tsx` | the card content: the section stack (registered as `"lens"`) |
| `tugdeck/src/components/lens/lens-content.css` | `--tugx-lens-*` content chrome |
| `tugdeck/src/components/lens/lens-section-registry.ts` | `registerLensSection` + `LensSectionDefinition` |
| `tugdeck/src/components/lens/lens-section-band.tsx` + `.css` | sticky band (models `TugTranscriptEntry`) |
| `tugdeck/src/components/lens/lens-register-card.ts` | `registerLensCard()` + `LENS_CARD_ID` |
| `tugdeck/src/components/lens/sections/{log-section.tsx,telemetry-section.tsx}` | the two sections |
| `tugdeck/src/lib/pane-title-bar-menu-store.ts` | generic per-card title-bar menu channel (mirrors `card-title-store.ts`); the lens card contributes its `…` items ([P01], Spec S03) |
| `tugdeck/src/components/tugways/cards/settings-general-body.tsx` (new "General") | focus-ring modality body |

**Relocated (moved, not new — [P10])** into `tugdeck/src/components/lens/internal/`: `copy-as-json.ts`, `log-row.tsx` ([#step-8]); `field-row.tsx`, `field-section.tsx`, `telemetry-projection.ts` ([#step-9]).

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `anchor?: "right"` | field | `layout-tree.ts` `TugPaneState` | new; additive-optional |
| anchored geometry / drag / resize branch | logic | `tug-pane.tsx` | derive geometry; disable drag; west-only resize; snap/merge exclusion |
| anchored z-tier | logic | `deck-canvas.tsx` | z = 8999 (below `--tug-z-overlay-base`), above free panes ([P04]) |
| explicit `anchor` parse + `fitPane` skip | logic | `serialization.ts` `parseV4` | field-by-field rebuild drops `anchor` unless parsed ([P02], [R01]) |
| `paneTitleBarMenuStore` + generic `…` render | store + logic | `pane-title-bar-menu-store.ts`, `tug-pane.tsx` `CardTitleBar` | card-contributed menu; no lens import in `tug-pane.tsx` (Spec S03) |
| `showLensPane` / `hideLensPane` / `toggleLensPane` | methods | `deck-manager.ts` | anchored singleton (mirrors `showSingletonCard`) |
| `LENS_CARD_ID` | const | `lens-register-card.ts` | `"lens"` |
| `FOCUS_LENS`, `TOGGLE_LENS` | action consts | `action-vocabulary.ts` | new |
| Cmd-L / Opt-Cmd-L bindings | entries | `keybinding-map.ts` | new |
| `"toggle-lens"` + `FOCUS_LENS` handlers | `registerAction` / chain handler | `action-dispatch.ts` (+ deck-canvas responder) | new |
| "Show Lens" menu item | Swift | `AppDelegate.swift` (replaces `maker.devPanel`) | `Opt-Cmd-L` |
| `LOG_STORE_DOMAIN` | const | `tug-dev-log-store.ts` | re-home ([P09]) |
| `SettingsTabId` `"general"`→new; old→`"devCard"` | union edit | `settings-card.tsx` | [P12] |

#### Files deleted (in [#step-11]) {#files-deleted}

`tugdeck/src/components/tug-dev-panel/` (all) — **except** the five [P10] helpers already moved to `lens/internal/`; `tugdeck/src/lib/tug-dev-panel-store/` (all); the three `registerAction` dev-panel entries in `action-dispatch.ts`; the `maker.devPanel` menu item + `showDevPanel(_:)` handler in `AppDelegate.swift`; the `registerDevPanelInspectorTabs()` call + `knownCardIdsForDevPanel` block in `main.tsx`; the `TugDevPanel` mount + import in `deck-manager.ts`.

---

### Test Plan Concepts {#test-plan-concepts}

Real app-tests only (`tests/app-test/`, `just app-test`). New at-numbers: **at0230–at0235** (max used is `at0229`, a two-file collision; `at0227` is a gap best left alone). Claim sequentially from at0230.

| Category | Purpose |
|----------|---------|
| Integration (app-test) | anchored-pane geometry + no-drag; lens toggle persistence; Cmd-L focus in/out; reorder persistence; `…` visibility toggle; Log + Telemetry real data; reload keeps anchored geometry |
| Unit (`bun test`) | `lens-store` reducer purity + hydrate; section registry register/get; `serialization` round-trips `anchor` + skips `fitPane` |

#### What stays out of tests {#test-non-goals}

- No jsdom/RTL render tests, no mock-store assertions, no synthetic fixtures — banned; drive the real app.
- No pixel snapshots of the band; assert structure/attributes and store/deck/focus state.

---

### Execution Steps {#execution-steps}

> Commit after all checkpoints pass. Every step runs `bunx tsc --noEmit && bunx vite build && bun test`; Swift/menu steps additionally run `just app-test-build`. Name touched laws in each commit.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Lens store (`dev.tugtool.lens`) | done | ca9c17f5c |
| #step-2 | Anchored-pane API + serialization | done | 65009de26 |
| #step-3 | Lens card + toggle + keybindings + Swift menu | done | 22dc467ad |
| #step-4 | Section registry + contract + stack render | done | bc2d9cc20 |
| #step-5 | Sticky section band + collapse | done | 2478a2b93 |
| #step-6 | Drag reorder + group-order sync + focus in/out | done | 8c7357867 |
| #step-7 | Title-bar `…` visibility menu | done | bb0b60d8c |
| #step-8 | Log section | done | 659605feb |
| #step-9 | Telemetry section | done | dbcbbec85 |
| #step-10 | Settings "General" tab move | done | 14365d9a4 |
| #step-11 | Delete dev panel + test sweep | done | 43fd3a7c0 |

---

#### Step 1: Lens store (`dev.tugtool.lens`) {#step-1}

**Commit:** `tugdeck(lens-store): tugbank store for section order/visibility/collapse + reopen width [L02]`

**References:** [P03] lens store, Spec S01, (#p03-lens-store, #state-zone-mapping)

**Artifacts:** `tugdeck/src/lib/lens-store/{types.ts,reducer.ts,lens-store.ts}` + `__tests__/`.

**Tasks:**
- [ ] Mirror `tugdeck/src/lib/tug-dev-panel-store/`: pure ref-stable `reducer.ts`, `types.ts` (domain `dev.tugtool.lens`, `LENS_KEYS`, snapshot shape), class wrapper with lazy `_ensureInitialized`, tugbank hydrate, `onDomainChanged` live push, PUT-on-diff.
- [ ] Keys: `widthPx` (i64), `sectionOrder`/`hiddenSections`/`collapsedSections` (json `string[]`). Tolerate missing/unknown values on hydrate (reject, keep) — mirror the dev-panel reducer.
- [ ] API: `subscribe`, `getSnapshot`, `setWidth`, `setSectionOrder`, `setHidden(kind, hidden)`, `setCollapsed(kind, collapsed)`.

**Tests:** `bun test` reducer no-op reference stability; each setter; malformed `sectionOrder` rejected on hydrate.

**Checkpoint:** `bunx tsc --noEmit && bunx vite build && bun test`

---

#### Step 2: Anchored-pane API + serialization {#step-2}

**Depends on:** #step-1

**Commit:** `tugdeck(pane): anchored pane treatment (derived right-edge geometry, west-only resize) [L09][L25]`

**References:** [P01] anchored pane, [P02] persistence, [P04] z-tier, [Q01], [R01], (#p01-anchored-pane, #p02-persistence, #s02-anchored-pane)

**Artifacts:** `layout-tree.ts` `TugPaneState.anchor?`; `tug-pane.tsx` anchored branch; `deck-canvas.tsx` z-tier; `serialization.ts` explicit `anchor` parse + `fitPane` skip.

**Tasks:**
- [ ] Add `anchor?: "right"` to `TugPaneState` (`layout-tree.ts`); `validateDeckState` unaffected (anchored panes obey the same card invariants).
- [ ] `tug-pane.tsx`: when `stackState.anchor === "right"`, derive geometry `right:0; top:0; bottom:0; width: size.width` instead of `position`/`size` absolute placement; make the title-bar `onDragStart` a no-op; restrict `RESIZE_EDGES` to `["w"]`; exclude the pane from `snapshotCardRects`/snap and from merge tab-bar hit-testing.
- [ ] `deck-canvas.tsx`: in the `zIndexMap` computation, assign anchored panes a **constant just below the overlay base** — `calc(var(--tug-z-overlay-base) - 1)` = 8999, the `tug-dev-panel.css` precedent — NOT a large above-everything number (which would bury the Lens's own `…`/section popups behind it). Free panes keep their `CARD_ZINDEX_BASE + arrayIndex` z ([P04]).
- [ ] `serialization.ts` `parseV4`: **explicitly parse and carry `anchor`** in the field-by-field pane reconstruction — the loop rebuilds each pane from named fields and drops anything not copied, so an un-parsed `anchor` is silently lost on reload ([P02] serialization gotcha). AND **skip `fitPaneGeometry`** for anchored panes (it runs unconditionally per pane today and would floor/cap the derived rail width) ([R01]). `serialize()` already writes `panes` wholesale, so the write side needs no change.
- [ ] West-edge resize commit writes `size.width` to the pane (live geometry) **and** mirrors it to `lensStore.setWidth` (reopen width) — both, per [P02]. `showLensPane` reads `lensStore.widthPx` when re-creating the pane.

**Tests:**
- [ ] `bun test`: `serialization` round-trips a pane with `anchor:"right"` (asserts `anchor` survives `serialize`→`deserialize`, the exact drop-on-read regression) and does not `fitPane` it.
- [ ] app-test **at0230**: seed a deck blob with an anchored lens pane; assert it renders pinned right (geometry) and a drag attempt on its title bar does not move it; reload and assert geometry + `anchor` survive.

**Checkpoint:** `bunx tsc --noEmit && bunx vite build && bun test`; `just app-test` (at0230)

---

#### Step 3: Lens card + toggle + keybindings + Swift menu {#step-3}

**Depends on:** #step-2

**Commit:** `tugdeck+tugapp(lens): lens card in an anchored pane; retire ⌥⌘/, add ⌥⌘L/⌘L [L25][L22]`

**References:** [P01] lens card, [P02] singleton, [P05] focus activation, (#p01-anchored-pane, #p05-focus-activation, #symbols)

**Artifacts:** `lens/lens-register-card.ts`, `lens/lens-content.tsx` (+ css); `action-vocabulary.ts`, `keybinding-map.ts`, `action-dispatch.ts`; `deck-manager.ts` anchored-singleton methods; `AppDelegate.swift`.

**Tasks:**
- [ ] `lens-register-card.ts`: `LENS_CARD_ID = "lens"`; `registerLensCard()` → `registerCard({ componentId: LENS_CARD_ID, hidden: true, family: "lens", acceptsFamilies: [], contentFactory: (cardId) => <LensContent cardId={cardId} />, defaultMeta: { title: "Lens", closable: true } })`. `family: "lens"` (a family no free pane's `acceptsFamilies` lists) plus `acceptsFamilies: []` on the anchored pane makes the lens card un-mergeable in both directions — belt-and-suspenders on top of the anchored pane already being non-draggable and single-card. Call from `main.tsx`. **INVARIANT (surfaced by at0230):** `registerLensCard()` MUST run at boot **unconditionally** — never behind a maker/feature gate — and before `loadLayout`. `filterRegisteredCards` drops panes whose only card's `componentId` is unregistered at load, so a gated lens card would evaporate the anchored rail on every reload. (Not app-testable: test mode ignores the persisted layout and starts empty — the invariant is enforced by registering `registerLensCard()` before the `DeckManager` constructor in `main.tsx`.)
- [ ] `LensContent`: a placeholder section stack for now (real sections land in [#step-4]+); a plain `overflow-y:auto` div; owns `--tugx-lens-*` ([L20], one-hop [L17]).
- [ ] `deck-manager.ts`: add `showLensPane()` (if the lens card exists → `activateCard`; else create an **anchored** pane + the lens card at `lensStore.widthPx` — the anchored analogue of `addCard`/`showSingletonCard`), `hideLensPane()` (`handlePaneClosed`), `toggleLensPane()`.
- [ ] `action-vocabulary.ts`: add `FOCUS_LENS: "focus-lens"`, `TOGGLE_LENS: "toggle-lens"`.
- [ ] `keybinding-map.ts`: `{ key:"KeyL", meta:true, action: FOCUS_LENS, preventDefaultOnMatch:true }` and `{ key:"KeyL", meta:true, alt:true, action: TOGGLE_LENS, preventDefaultOnMatch:true }` (browser-dev parity). Verify Cmd-L unbound first.
- [ ] `action-dispatch.ts`: `registerAction("toggle-lens", () => store.toggleLensPane())` (mirrors `show-dev-panel-toggle`). `FOCUS_LENS` chain handler at the deck-canvas level (where `SHOW_SETTINGS` lives): stash `store.getFirstResponderCardId()` → `showLensPane()` → activate the lens card via `transferFocusForActivation` ([P05]); if the lens is already the key card, re-activate the stashed card (toggle-out).
- [ ] `AppDelegate.swift`: replace the `maker.devPanel` item (`"Show Dev Panel"`, keyEquivalent `"/"`, `showDevPanel` → `sendControl("show-dev-panel-toggle")`) with `"Show Lens"`, keyEquivalent `"l"`, `[.command,.option]`, `showLens(_:)` → `sendControl("toggle-lens")`, identifier `maker.lens`. Keep the pane-model.md Swift menu vocabulary consistent.

**Tests:**
- [ ] app-test **at0231**: dispatch `toggle-lens`; assert the anchored lens pane appears in the deck snapshot and persists; dispatch again → gone. Dispatch `FOCUS_LENS` on a closed lens; assert it opens **and** `store.getFirstResponderCardId()` / `focusManager.keyCard()` is the lens card (exercises the activation-path late-mount ring via `armKeyboardRestore`). Dispatch Escape/`FOCUS_LENS`-again; assert the prior card is restored.

**Checkpoint:** `bunx tsc --noEmit && bunx vite build && bun test`; `just app-test-build && just app-test` (at0231; Swift changed)

---

#### Step 4: Section registry + contract + stack render {#step-4}

**Depends on:** #step-3

**Commit:** `tugdeck(lens): section registry + host-agnostic LensSectionDefinition [L02]`

**References:** [P07] section contract, Spec S01, (#p07-section-contract, #s01-section-def)

**Artifacts:** `lens/lens-section-registry.ts`; `LensContent` renders registered sections.

**Tasks:**
- [ ] Define `LensSectionDefinition` (Spec S01) with the **required** `collapsedSummary` and the separate host-agnostic `body`; declare (not implement) the reserved hooks. `LensSectionHost` = `{ lensCardId, focusGroup }` (minimal).
- [ ] `LensContent` render list: start from `sectionOrder`, append registered-but-unordered kinds (stable), drop `hiddenSections`; render each via a `LensSection` wrapper (band + body); ignore unknown kinds.

**Tests:** `bun test`: register two stub sections; assert order + hidden filtering; a definition missing `collapsedSummary` is a tsc error.

**Checkpoint:** `bunx tsc --noEmit && bunx vite build && bun test`

---

#### Step 5: Sticky section band + collapse {#step-5}

**Depends on:** #step-4

**Commit:** `tugdeck(lens): sticky section band (models TugTranscriptEntry) + persisted collapse [L06][L03]`

**References:** [P06] band model, [P03] collapse persisted, [Q03], (#p06-band-model, #q03-collapse)

**Artifacts:** `lens/lens-section-band.tsx` + `.css`.

**Tasks:**
- [ ] Band = sticky title row: glyph + title + `collapsedSummary` (when collapsed) + drag grip (placeholder until [#step-6]) + chevron. Chevron toggles `lensStore.setCollapsed(kind, …)`.
- [ ] Write `--tugx-pin-stack-top` via `useLayoutEffect` + `ResizeObserver` (`Math.ceil(px) + TIER_GAP_PX`), copying `tug-transcript-entry.tsx` — **no** synchronous `getBoundingClientRect` seed. Static CSS fallback for the first frame.
- [ ] Nested clearance: replicate the `.changeset-entry-block` pin-clearance pair from `changeset-card.css`.
- [ ] Collapse appearance: `data-collapsed` + CSS ([L06]); body hidden when collapsed, band `collapsedSummary` renders live.

**Tests:** app-test **at0232** (collapse): folded into **at0235** in [#step-8] — collapse needs a *registered* section to act on, and no section exists until the Log section lands, so the collapse assertions (`data-collapsed="true"`, body unmounted, live summary present, `collapsedSections` persisted) are made against the real Log section inside at0235.

**Checkpoint:** `bunx tsc --noEmit && bunx vite build && bun test`; `just app-test`

---

#### Step 6: Drag reorder + group-order sync + focus in/out {#step-6}

**Depends on:** #step-5

**Commit:** `tugdeck(lens): drag-reorder sections, setGroupOrder + Tab/⌥⇥ section focus [L22][L08]`

**References:** [P08] reorder, [P05] focus, (#p08-reorder, #p05-focus-activation)

**Artifacts:** reorder interaction in the band/content; `setGroupOrder` sync; section focus groups + ⌥⇥ cycle.

**Tasks:**
- [ ] Ground the drag in an existing house drag pattern (pane drag coordinator / `TugTabBar` tab drag) — no new DnD lib. Live preview DOM-only ([L06]/[L08]); commit `lensStore.setSectionOrder(...)` on drop.
- [ ] `useLayoutEffect` keyed on rendered order: `focusManager.contextFor(LENS_CARD_ID).setGroupOrder([...visible section groups])`.
- [ ] Give each section a `focusGroup`/`focusOrder` so Tab walks sections; wire ⌥⇥ section cycling via `use-cycle-mode` (register `CYCLE_FOCUS_MODE` on the lens card content responder). Escape inside the lens → `CANCEL_DIALOG` handler → restore the stashed prior card ([P05]).

**Tests:** app-test **at0233** (authored in [#step-9], where ≥2 real sections exist): drag section B above A; assert `sectionOrder` persisted + DOM order matches + Tab from the title bar reaches sections in the new order; Escape restores the prior card. Escape-to-focus-out is a **content-local** `CANCEL_DIALOG` responder on the Lens content that re-dispatches `FOCUS_LENS` (deck-canvas toggle-out restores the stashed prior card). It must live in the Lens content — NOT at the deck-canvas level — so it is only in the chain when focus is actually inside the Lens: a deck-canvas `CANCEL_DIALOG` actions-map entry consumes *every* Escape (marking it handled → `preventDefault`), which blocks unrelated Escape gestures such as at0021's mid-drag abort. This is viable once the Lens has real focusable section content (Steps 8/9) so DOM focus lands inside it.

**Checkpoint:** `bunx tsc --noEmit && bunx vite build && bun test`; `just app-test`

---

#### Step 7: Generic pane title-bar menu + lens visibility items {#step-7}

**Depends on:** #step-3, #step-4

**Commit:** `tugdeck(pane): generic card-contributed title-bar menu; lens contributes section visibility [L10][L11]`

**References:** [Q02] affordance, Spec S03, (#q02-overflow-affordance, #s03-title-bar)

**Artifacts:** new `tugdeck/src/lib/pane-title-bar-menu-store.ts`; the generic `…` render in `CardTitleBar` (`tug-pane.tsx`); the lens card's contribution in `LensContent`.

**Tasks:**
- [ ] **Generic channel:** create `pane-title-bar-menu-store.ts` mirroring `lib/card-title-store.ts` exactly (module-scope store, `subscribe`/`getSnapshot`/`set(cardId, items | null)`, keyed by cardId; items are a plain `{ id, label, checked?, onSelect }[]` shape). `tug-pane.tsx` imports only this store.
- [ ] **Generic render:** in `CardTitleBar`, subscribe to `paneTitleBarMenuStore` for the active card (`useSyncExternalStore`, keyed like the existing `cardTitleStore` subscription already in `TugPane`). When the active card has published items, render a `TugIconButton` (`MoreHorizontal`) to the **left** of the collapse chevron, opening a `TugPopupMenu` built from the items; render nothing when the card published none, so every existing pane is byte-unchanged. Re-run `git log -S MoreHorizontal -- tugdeck/src` first ([Q02]); absent a prior treatment, this is the default. Never hand-roll the menu.
- [ ] **Lens contributes:** in `LensContent`, publish one item per `getRegisteredLensSections()` entry (label = section title, `checked = !hiddenSections.includes(kind)`, `onSelect` toggles `lensStore.setHidden(kind, …)`) via `paneTitleBarMenuStore.set(lensCardId, items)`, recomputed when the registry or `hiddenSections` changes; clear with `set(lensCardId, null)` on unmount. All section-visibility logic stays in the lens layer.

**Tests:** app-test **at0234** (authored in [#step-9], where ≥2 real sections exist to toggle): open the `…` menu on the lens pane, toggle a section off; assert it leaves the stack and `hiddenSections` persisted; toggle back on and assert it returns. Assert a free (non-lens) pane renders no `…` button.

**Checkpoint:** `bunx tsc --noEmit && bunx vite build && bun test`; `just app-test`

---

#### Step 8: Log section {#step-8}

**Depends on:** #step-4, #step-5

**Commit:** `tugdeck(lens): Log section re-hosts tugDevLogStore + LogInspector; re-home log domain [L02]`

**References:** [P07] host-agnostic, [P09] log domain, [P10] relocation, (#p09-log-domain, #p10-relocate-helpers)

**Artifacts:** `lens/sections/log-section.tsx`; `LOG_STORE_DOMAIN` in `tug-dev-log-store.ts`; `lens/internal/{copy-as-json.ts,log-row.tsx}` relocated.

**Tasks:**
- [ ] **Relocate ([P10]) first:** `git mv` `tug-dev-panel/copy-as-json.ts` → `lens/internal/copy-as-json.ts` and `tug-dev-panel/inspectors/log-row.tsx` → `lens/internal/log-row.tsx` (tests too); repoint all importers (the dev panel's own inspectors during the coexistence window).
- [ ] Re-home the domain: `LOG_STORE_DOMAIN = "dev.tugtool.dev-panel"` (same string, [P09]) inside `tug-dev-log-store.ts`; drop the `tug-dev-panel-store/types` import; repoint `tug-dev-log-store/__tests__/persistence.test.ts`.
- [ ] Log descriptor: title "Log", a log glyph, `collapsedSummary` = live counts from `tugDevLogStore.getSnapshot()` (e.g. `124 · 3 warn · 1 error`) via `useSyncExternalStore`.
- [ ] Body: lift the `LogInspector` rendering (filters + `LogRow` list) into the section, importing from `lens/internal/`; unchanged behavior (reads `tugDevLogStore`, owns its own scroll [L06]). `registerLensSection` from `main.tsx`. `window.tugDevLog` wiring in `main.tsx` untouched.

**Tests:** app-test **at0235**: emit entries via `window.tugDevLog` (attached under the test harness on the prod bundle via a widened guard in `main.tsx`); assert the Log section renders them, the collapsed summary counts match, and a level filter narrows the list. Also carries the folded-in at0232 collapse assertions.

**Checkpoint:** `bunx tsc --noEmit && bunx vite build && bun test`; `just app-test`

---

#### Step 9: Telemetry section {#step-9}

**Depends on:** #step-4, #step-5

**Commit:** `tugdeck(lens): Telemetry section follows the last non-lens key card [L07][L02]`

**References:** [P11] telemetry follows, [P10] relocation, (#p11-telemetry-follows, #p10-relocate-helpers)

**Artifacts:** `lens/sections/telemetry-section.tsx`; `lens/internal/{field-row.tsx,field-section.tsx,telemetry-projection.ts}` relocated.

**Tasks:**
- [ ] **Relocate ([P10]) first:** `git mv` `field-row.tsx`, `field-section.tsx`, `inspectors/telemetry-projection.ts` → `lens/internal/` (tests too); repoint importers.
- [ ] Body: lift `TelemetryInspector`, drop `selectedCardId`; a "last non-lens key card" selector via `useSyncExternalStore(focusManager.subscribe, …)` (remember the prior `keyCard()` that is not `LENS_CARD_ID`, since focusing the lens makes it the key card, [P11]); resolve `cardServicesStore.getServices(thatCardId)`, subscribe to its `codeSessionStore`, use `projectTelemetryInspector` + `_getInternalStateForDevPanel` + `useLifecycleTick`, importing helpers from `lens/internal/`. Name the followed card in the band; empty-state when none exists.
- [ ] `collapsedSummary`: a key live stat from the followed card's snapshot. `registerLensSection` from `main.tsx`.

**Tests:** app-test extends **at0235**: open a real dev card, run a turn, focus the lens; assert the Telemetry section still names that dev card and shows non-empty telemetry + a live collapsed stat.

**Checkpoint:** `bunx tsc --noEmit && bunx vite build && bun test`; `just app-test`

---

#### Step 10: Settings "General" tab move {#step-10}

**Depends on:** #step-9

**Commit:** `tugdeck(settings): move focus-ring modality to a new General tab; rename mislabeled id [L11]`

**References:** [P12] settings move, [P10] relocation, (#p12-settings-move, #p10-relocate-helpers)

**Artifacts:** `settings-card.tsx` tab set; a new General body.

**Tasks:**
- [ ] Rename the existing `SettingsTabId` `"general"` (labeled "Dev Card", body `SettingsGeneralBody`) to `"devCard"`; grep all consumers of the `"general"` id / `TAB_CARDS` / body switch and update.
- [ ] Add a **new** `"general"` tab (label "General") hosting the focus-ring modality control — lift `SettingsInspector`'s content into a new body following `settings-app-body.tsx` (`useResponderForm` + `TugRadioGroup`, `focusRingModalityStore`, `dev.tugtool.app/focusRingModality` unchanged); import `field-section` from `lens/internal/` ([P10]). Order tabs so "General" reads first.

**Tests:** app-test: open Settings, select General, flip focus-ring modality; assert `dev.tugtool.app/focusRingModality` persisted. (Extend an existing settings app-test if one covers the card.)

**Checkpoint:** `bunx tsc --noEmit && bunx vite build && bun test`; `just app-test`

---

#### Step 11: Delete dev panel + test sweep {#step-11}

**Depends on:** #step-3, #step-8, #step-9, #step-10

**Commit:** `tugdeck+tugapp(dev-panel): delete the dev panel; the Lens supersedes it [L25][L02]`

**References:** [P01], [P09], [P10], [P11], (#files-deleted, #symbol-inventory)

**Artifacts:** deletions in [#files-deleted].

**Tasks:**
- [ ] Confirm the five [P10] helpers are already gone from `tug-dev-panel/` (moved in [#step-8]/[#step-9]); if any remain, relocate before deleting.
- [ ] Delete `tugdeck/src/components/tug-dev-panel/` and `tugdeck/src/lib/tug-dev-panel-store/` (both entire).
- [ ] Remove the `TugDevPanel` import + sibling mount in `deck-manager.ts`.
- [ ] Remove the three `registerAction` dev-panel entries + `tugDevPanelStore` import in `action-dispatch.ts`.
- [ ] Remove `registerDevPanelInspectorTabs()` + the `knownCardIdsForDevPanel` block in `main.tsx`.
- [ ] Remove the dead `showDevPanel(_:)` handler in `AppDelegate.swift` if not already replaced in [#step-3].
- [ ] Sweep `tests/app-test/` for dev-panel references; adapt to lens equivalents. Confirm no test drives `show-dev-panel-toggle`.
- [ ] Confirm `Opt-Cmd-/` unbound in both tracks (grep).

**Tests:** full `bun test` + `just app-test` green; grep clean.

**Checkpoint:**
- [ ] `bunx tsc --noEmit && bunx vite build && bun test`
- [ ] `just app-test-build && just app-test`
- [ ] `grep -rn "tug-dev-panel\|TugDevPanel\|show-dev-panel\|maker.devPanel" tugdeck/src tugapp/Sources tests/app-test` → no matches

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** The Lens — an anchored pane hosting an ordinary card that renders a focus-bearing, reorderable/collapsible section stack with informative collapsed headers, hosting Log and Telemetry — replaces the Tug dev panel, which is deleted, all within the Deck → Pane → Card model ([L25]).

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] The Lens is a real anchored pane (in `deckState.panes`) with its card in `deckState.cards`, exempt from drag/snap/merge; geometry survives reload. (at0230)
- [ ] `Opt-Cmd-L` shows/hides it; `Cmd-L` focuses in via the normal activation path; Escape / Cmd-L focuses out (restores prior card). (at0231)
- [ ] Section order, visibility, and collapse persist across reload under `dev.tugtool.lens`; width persists (pane geometry + reopen mirror). (at0230/at0232/at0233/at0234)
- [ ] Every registered section supplies a live collapsed-summary; Log shows level counts, Telemetry names the followed card. (at0235)
- [ ] The dev panel is deleted; `bunx tsc --noEmit && bunx vite build && bun test && (cd tugrust && cargo nextest run)` green; grep finds no dev-panel references. ([#step-11])
- [ ] `Opt-Cmd-/` unbound in both tracks.

**Acceptance tests:** at0230 (anchored pane + reload), at0231 (toggle + focus in/out), at0232 (collapse), at0233 (reorder + Escape restore), at0234 (`…` visibility), at0235 (Log + Telemetry real data).

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] **M3b** — Changeset section (lift `changeset-card.tsx`); retire the changeset card.
- [ ] **M3c** — Git History section (new `GIT_LOG` feed + `git-log-store` + read-only `TugCodeView`).
- [ ] Cardable-in-future — render a Lens section as its own deck card (the contract already permits it).
- [ ] Deck reflow — free panes shrink to make room instead of the anchored pane overlaying them.

| Checkpoint | Verification |
|------------|--------------|
| Anchored pane + focus | at0230, at0231 |
| Sections (band/reorder/menu) | at0232, at0233, at0234 |
| Log + Telemetry | at0235 |
| Dev-panel gone | [#step-11] grep + full green |
