<!-- devise-skeleton v4 -->

## Lens Joins the Imposition {#lens-joins-imposition}

**Purpose:** Bring the Lens into the layout imposition scheme: the imposition becomes a record carrying both the N-up kind and the Lens's side, the Lens renders as a regular pinned pane through the imposer's geometry (gaps on all four sides, rounded corners), and the bespoke `anchor` geometry mode, the app-wide Lens-position setting, and the Settings **General** tab all retire. The Lens Layouts section becomes the one home for every layout decision, with a two-axis picture-first picker.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-07-26 |

**Source brief:** `dash/lens-joins-imposition-brief.md` — read it first; this plan implements it.

---

### Phase Overview {#phase-overview}

#### Context {#context}

The layout imposition (D121) landed with the Lens sitting *outside* the scheme, and that costs three mechanisms that exist for no other reason: a bespoke geometry mode (`TugPaneState.anchor` and the anchored branch in `tugdeck/src/components/chrome/tug-pane.tsx`), a deck-state invariant policing `anchor ⊕ slot` (invariant 6 in `tugdeck/src/layout-tree.ts`), and a CSS channel (`--tug-imposer-inset-left` / `--tug-imposer-inset-right`, written by `deck-canvas.tsx`) whose only job is to tell the imposer where the Lens isn't.

It also puts a layout decision in the wrong place. "Which side is the Lens on" is answered today in an app-wide preference (Settings ▸ General → `set-lens-side` → `lensStore.anchorSide` → tugbank `dev.tugtool.lens/anchorSide`), far from where every other layout decision is made. Settings ▸ General contains **nothing but** that one chooser (`settings-lens-body.tsx`), so folding it into the Layouts section retires the whole tab.

#### Strategy {#strategy}

- **Model first, additive.** Introduce the `{ kind?, lens }` imposition record on `DeckState` and the wire format while the `anchor` machinery keeps working — every commit boundary leaves a working app.
- **Then flip the render.** The Lens becomes a *pinned imposed* pane placed by the imposer's own geometry module; `anchor` and everything that reads it retires in the same commit.
- **Then the picker.** Rebuild the Layouts section as the two-axis picture-first control (proposal **P4** from the gallery spike), with miniatures that live-reflect the chosen Lens side.
- **Delete last.** The Settings General tab, the `set-lens-side` action, and the `anchorSide` limb of the lens store go only once nothing needs them.
- **Identity is derived, never stored.** "The Lens pane" is the pane hosting the card whose `componentId === LENS_CARD_ID` — no replacement marker field on `TugPaneState`.
- **CSS-derived geometry stays absolute.** No `ResizeObserver` appears anywhere on the deck; the Lens's pins and the band insets remain plain CSS the browser re-resolves on reflow ([L06], D121).

#### Success Criteria (Measurable) {#success-criteria}

- The Lens renders with the imposition gap on all four sides (5px left/right/top, 32px bottom), rounded corners, and full pane chrome — verify by DOM measurement in `at0275` (rail frame rect vs canvas rect).
- Imposed cards never slide under the Lens: with the Lens open at width W on the right, the chain's far edge lands at `canvasWidth − W − 2·gap` (one gap off the Lens's near edge) — verify numerically in `at0275`.
- `TugPaneState.anchor` no longer exists; `grep -rn "\banchor\b" tugdeck/src/layout-tree.ts tugdeck/src/serialization.ts` shows only the migration read.
- Settings shows exactly three tabs (Session Card, Text Card, Maker); the General tab and `settings-lens-body.tsx` are gone.
- A pre-change v4 layout blob (string `imposition`, Lens pane with `anchor: "left"`) round-trips: the Lens opens on the left, slotted panes keep their slots, and the next save writes the record form with no `anchor` — verify with a serialization unit test.
- Switching Lens side from the Layouts section flips the live rail and re-packs the chain to the other edge with no reload, **and the choice survives a relaunch** — both verified in `at0275`.
- Window ▸ Tile leaves the Lens pane's stored width and position untouched — verify with a deck-manager unit test on `arrangeCards("tile")`.
- `cd tugdeck && bun test`, `bunx tsc --noEmit`, `bunx vite build`, and `just app-test-changed` all pass.

#### Scope {#scope}

1. `DeckImposition` record (`kind?` + `lens`) on `DeckState`, wire format, and migration (v4 string form, pane `anchor` harvest, tugbank `anchorSide` seed).
2. The Lens as a pinned imposed pane: `imposeLensStyle` in `lib/layout-imposer.ts`, retirement of `anchor` and the anchored geometry mode.
3. The two-axis Layouts picker (Lens side control + P4 miniature rows) with a shared `LayoutMiniature` component.
4. Deletion of `set-lens-side`, `lensStore.anchorSide` / `useLensAnchorSide` / `normalizeLensAnchorSide`, `settings-lens-body.tsx`, and the Settings General tab; rename of the mis-named `settings-general-body.tsx`.
5. Tuglaws amendments (D121, pane-model.md's geometry modes) and test updates (`at0275`, `at0236`, serialization/deck-manager/lens-store unit tests).

#### Non-goals (Explicitly out of scope) {#non-goals}

- No change to slot semantics, the step rule, eviction, or the freeze-on-clear behavior — the packing algorithm shipped and stays.
- No change to Cmd-L / ⌥⌘L focus and visibility semantics (`FOCUS_LENS`, `toggleLensPane`, the presence-is-open model). See [P02].
- No removal of the `gallery-slot-layout` design-spike card — it stays as the gallery record of the P4 decision.
- No change to the Lens's *content* (sections, rows, `SlotPicker`).
- No serialization version bump ([P06]).

#### Dependencies / Prerequisites {#dependencies}

- The layout imposition feature as landed on `main` (`lib/layout-imposer.ts`, D121, `at0275`).
- `dash/lens-joins-imposition-brief.md` (the design brief this plan implements).
- The gallery spike `components/tugways/cards/gallery-slot-layout.tsx` (the P4 direction and the `CanvasMini` miniature math to adapt).

#### Constraints {#constraints}

- Warnings are errors across the workspace; `bunx vite build` must pass before any step is called done (dev esbuild accepts imports the production rollup rejects).
- No `localStorage` / `sessionStorage` / IndexedDB — persistence rides the layout blob and tugbank.
- App-tests run selectively via `just app-test-changed`; new/edited tests must carry accurate `@covers` lines.
- Compose real Tug components ([L19]/[L20]) — the picker must not hand-roll selection controls.

#### Assumptions {#assumptions}

- The Lens remains a singleton (at most one Lens card in the deck) — already enforced by `showLensPane`'s find-or-create.
- The tugbank client cache is warm when `DeckManager.loadLayout()` runs (the layout blob itself arrives through the same API), so the one-time `anchorSide` seed can read synchronously — the same assumption `_createLensPane`'s `lensStore.getSnapshot()` read makes today.
- `at0275-layout-imposition.test.ts` is the app-test surface for imposition geometry and will absorb the Lens-geometry assertions rather than a new test file.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows the devise-skeleton v4 conventions: explicit `{#anchor}` headings, `[P##]` plan-local decisions, `[Q##]` open questions, `Spec S##` / `Table T##` / `Risk R##` labels, `**Depends on:**` lines with `#step-N` anchors, and rich `**References:**` lines citing plan artifacts — never line numbers.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] `imposition.lens` versus the Lens's open/closed state (DECIDED) {#q01-lens-vs-open-state}

**Question:** `toggle-lens` (⌥⌘L) opens and closes the Lens today via pane presence. Does the imposition record also own visibility (a `lens: "off"` value), or only the side?

**Why it matters:** An `"off"` value would make the record and pane presence two representations of one fact, which must then be kept in sync by every open/close path.

**Resolution:** DECIDED (user-confirmed, 2026-07-26) — see [P02]. `imposition.lens` carries the **side only**; open/closed stays exactly where it is (pane presence, `toggleLensPane`). There is no `"off"` value. A closed Lens means "no Lens end in the strip"; the remembered side is precisely what `imposition.lens` is for.

#### [Q02] What marks the Lens pane once `anchor` is gone? (DECIDED) {#q02-lens-identity}

**Question:** `anchor` is today's marker for "this pane is the rail" (z-index, merge exclusion, resize mode, `SlotPicker` guard, `movePane` width mirror). What replaces it?

**Resolution:** DECIDED — see [P04]. Identity is derived from content: the pane hosting the card with `componentId === LENS_CARD_ID`. No stored marker field.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Old v4 blobs mis-migrate (Lens side lost or slots dropped) | med | low | Precedence spec S02 + unit tests over real legacy shapes | Any report of the Lens flipping sides or slots vanishing after update |
| Band-inset off-by-one-gap (cards touch or under-run the Lens) | med | med | One geometry spec (S01) with the arithmetic written out; CSS and numeric twin both derive from it; `at0275` asserts the exact pixel positions | `at0275` failure |
| Lens focus/keyboard regressions from the render change (Cmd-L seed, first-responder restore) | med | low | The pane keeps identical chrome/`CardHost` structure — only frame pins change; run the lens-focused app-tests (`at0231`, `at0247`, `at0256`) via `just app-test-changed` | Selection advisory or focus test failure |
| Deleted `anchorSide` breaks lens-store hydration for existing users | low | low | The reducer's reject-and-keep hydrate discipline ignores unknown keys; the legacy key is read once by the deck migration, never written again | lens-store test failure |

**Risk R01: Migration precedence subtlety** {#r01-migration-precedence}

- **Risk:** Three sources can supply the Lens side (record, legacy pane `anchor`, tugbank `anchorSide`); a wrong precedence order silently flips a user's rail.
- **Mitigation:** Spec S02 fixes the order (record > pane anchor > tugbank seed > `"right"`); one unit test per source plus one per shadowing pair.
- **Residual risk:** A user who set the tugbank preference but never re-saved a layout blob gets the seed path — acceptable, that is exactly the preference they stated.

---

### Design Decisions {#design-decisions}

#### [P01] `DeckState.imposition` becomes a required record (DECIDED) {#p01-imposition-record}

**Decision:** `DeckState.imposition` changes from `imposition?: ImpositionKind` to a required `imposition: DeckImposition` where `DeckImposition = { kind?: ImpositionKind; lens: LensSide }` and `LensSide = "left" | "right"`, defined in `lib/layout-imposer.ts`. The default is `{ lens: "right" }`.

**Rationale:**
- The brief's model: the strip is the ordered thing (`[Lens, 1, 2, 3]` or `[1, 2, 3, Lens]`), and `lens` is independent of `kind` — `kind` absent plus `lens: "right"` reproduces today's default arrangement with the app-wide setting gone.
- A required record avoids two representations of the default (an absent record *and* `{ lens: "right" }` meaning the same thing).
- `kind?` optional preserves the existing "imposition off" semantics, including freeze-on-clear, keyed on `kind` going away.

**Implications:**
- Every `deckState.imposition !== undefined` gate becomes `deckState.imposition.kind !== undefined`. Exhaustive consumer list in Table T01.
- `buildDefaultLayout()` and `deserialize()` always produce an `imposition` with a `lens`.

#### [P02] Side only — visibility stays with pane presence (DECIDED) {#p02-side-only}

**Decision:** `imposition.lens` records only the side. The Lens's open/closed state remains the presence of the Lens pane, toggled by `toggleLensPane` (⌥⌘L) and `showLensPane`/`hideLensPane`. There is no `"off"` value and `toggle-lens` does not write the imposition.

**Rationale:**
- User-confirmed resolution of [Q01].
- Pane presence already *is* the open state ([P02] of the original lens plan); duplicating it invites drift.

**Implications:**
- `showLensPane`/`_createLensPane` reads the side from `deckState.imposition.lens` (no longer from `lensStore.anchorSide`).
- Changing `imposition.lens` while the Lens is closed just updates the record; the next open lands on the new side.

#### [P03] The Lens is pinned imposed — placed by the imposer, never a link in the chain (DECIDED) {#p03-pinned-imposed}

**Decision:** The Lens renders through a new `imposeLensStyle(side, collapsed)` in `lib/layout-imposer.ts`: pinned to its side at one imposition gap, top gap 5px, bottom gap 32px, width from the pane. It never takes a step in the chain — the band inset ends one gap off its near edge (Spec S01). It never evicts and never drags; it resizes only on its deck-facing edge (re-packing the strip live), the same exception the anchored rail has today.

**Rationale:**
- A locked requirement: an imposed card never slides under the Lens. If the Lens were an ordinary chain link, a crowded deck would overlap cards onto it.
- Going through the imposer's geometry module gives the Lens the gaps, the deeper bottom margin, and (by dropping `squareCorners`) rounded corners for free, and keeps all imposition geometry in one file.

**Implications:**
- `tug-pane.tsx` gains a `lensSide?: LensSide` prop (resolved by `DeckCanvas`, like `placement`) replacing its `stackState.anchor` read; the anchored style branch, `data-anchored`, and its CSS retire.
- The deck-facing-edge resize handler stays mechanically (width-only, snap-capable) but keys on the `lensSide` prop; the commit still mirrors width to `lensStore.setWidth` (reopen width — `widthPx` survives, only `anchorSide` retires).
- The Lens pane is never draggable and its title bar never starts a drag.

#### [P04] Lens identity is derived from content, not stored (DECIDED) {#p04-derived-identity}

**Decision:** "The Lens pane" is the pane whose `cardIds` include the card with `componentId === LENS_CARD_ID`. A shared selector `findLensPane(state: DeckState): TugPaneState | undefined` (new, in `tugdeck/src/deck-store-selectors.ts`) is the single predicate; `LENS_CARD_ID` moves to a leaf module so non-component code can import it (see [P09]).

**Rationale:**
- `anchor` retires and nothing should replace it as a stored marker — the fact is already in the deck's own tables.
- The Lens pane is single-card by construction (`acceptsFamilies: []`, `family: "lens"` un-mergeable both ways), so the derivation is stable.

**Implications:**
- Deck-state invariant 6 (`anchor ⊕ slot`) is replaced by: **at most one pane hosts the Lens card, and that pane carries no `slot`** (validated in `validateDeckState` against `cards[].componentId`).
- Consumers that read `pane.anchor` re-key on `findLensPane` / a `lensSide` prop: `deck-canvas.tsx` (z-index, rail resolution, placement gating), `deck-manager.ts` (`movePane` width mirror, `assignCardToSlot` guard), `slot-picker.tsx` (disabled guard), serialization (fit-skip).

#### [P05] Band insets carry the Lens width plus one gap (DECIDED) {#p05-band-insets}

**Decision:** With the Lens open at render width W on side S, `DeckCanvas` writes `--tug-imposer-inset-<S>: ${W + IMPOSITION_GAP_PX}px` (the other side `0px`); closed → both `0px`. `resolveSpan` in `lib/layout-imposer.ts` computes the identical inset (`lens.width + IMPOSITION_GAP_PX`) so the numeric twin and the CSS agree by construction. Full arithmetic in Spec S01.

**Rationale:**
- The Lens itself now stands one gap off the canvas edge, so its *near* edge sits at `W + gap` from that edge; the existing `pin = inset + gap + …` formula then lands the chain's far card exactly one gap off the Lens.
- W must be the same clamped render width `deck-canvas.tsx` already feeds `resolvePlacements` (`max(pane.size.width, sizePolicy.min.width)`) — the current inset code uses the raw stored width, which this change corrects in passing.

**Implications:**
- `imposeStyle`'s formulas are unchanged — only the inset values feeding them change.
- `imposeRect`'s callers pass the lens-derived span; unit tests pin CSS/numeric agreement at the new insets.

#### [P06] Migration is additive on v4 — no version bump (DECIDED) {#p06-migration}

**Decision:** The wire `imposition` accepts both the legacy string (`"two-up"`) and the new record; a legacy blob's Lens-pane `anchor` is read once into `imposition.lens`; when neither supplies a side, the persisted tugbank `dev.tugtool.lens/anchorSide` seeds it (read via a literal legacy key at the `DeckManager.loadLayout()` call site); final fallback `"right"`. `anchor` is never re-serialized. Precedence and shapes in Spec S02.

**Rationale:**
- Rides the additive-optional precedent `slot` set; old builds reading a new blob see an object where they expect a string, fail `isImpositionKind`, and drop the arrangement gracefully (the same posture the original plan took for unreadable kinds).
- The tugbank seed honors an existing user's stated preference exactly once; the layout blob owns the value from then on.

**Implications:**
- `deserialize()` gains a `fallbackLensSide` parameter (default `"right"`); the `main.tsx` card-id-harvest call passes nothing.
- The lens store's `anchorSide` limb can be deleted (Step 4) without stranding the migration — the seed reads the raw tugbank key.

#### [P07] The Layouts section is a two-axis picture-first picker (DECIDED) {#p07-two-axis-picker}

**Decision:** The Layouts section rebuilds on gallery proposal **P4**: a Lens-side control above the kind rows, every option a scale miniature of the actual deck (rail drawn on the chosen side, cards packed away from it with the step rule, overlap drawable). A new reusable `LayoutMiniature` component (`components/lens/layout-miniature.tsx`) renders the picture; all miniatures live-reflect the chosen Lens side — choose Lens Left and every picture flips. Spec S04.

**Rationale:**
- P4 was chosen from the four-proposal spike; the Windows 11 Snap Layouts idiom (the option is a picture of the result) was the strongest precedent.
- Live-reflecting the side makes a tile a picture of *the actual deck*, not an abstract N-up.

**Implications:**
- The current `TugChoiceGroup`-of-`TugSlotLayout` segments in `layouts-section.tsx` is replaced (its ghost-variant pipe-divider rendering issue becomes moot).
- Selection controls compose real Tug components ([L19]/[L20]): `TugChoiceGroup` for the two-segment side control, `TugRadioGroup`/`TugRadioItem` for the kind rows (rich `children` hosting miniature + label), laid out two-per-row by section CSS.

#### [P08] New action `set-imposition-lens`; `set-lens-side` retires (DECIDED) {#p08-lens-action}

**Decision:** A new `DeckManager.setImpositionLens(side: LensSide)` and dispatch action `set-imposition-lens` own the side. `set-lens-side` and `setLensAnchorSide` retire in Step 4; during the transition (Steps 1–3) `setLensAnchorSide` delegates to `setImpositionLens` so the Settings control keeps working until its tab is deleted.

**Rationale:**
- [L11]: controls emit actions; the picker needs a registered action.
- The delegation bridge keeps every commit boundary green.

**Implications:**
- `setImpositionLens` fires the will/did move ledger for the Lens card **and every slotted pane's active card** — flipping the side flips `packFrom`, so the whole chain moves (the same ledger discipline `assignCardToSlot` uses).

#### [P09] `LENS_CARD_ID` moves to a leaf module; `squareCorners` retires (DECIDED) {#p09-leaf-id-square-corners}

**Decision:** `LENS_CARD_ID` moves from `components/lens/lens-register-card.tsx` to a new leaf module `tugdeck/src/lib/lens-card-id.ts` (the register module imports it). The `CardMeta.squareCorners` field, its `data-square-corners` wiring in `tug-pane.tsx`, and its CSS rule retire entirely — the Lens was its only user and it now wants round corners.

**Rationale:**
- `serialization.ts` and `deck-store-selectors.ts` need the constant but must not drag the Lens's React component graph into their module graphs (unit tests import serialization directly).
- "Change everything; don't leave old code laying around": a general mechanism with zero users is old code.

**Implications:**
- Import-path updates in `deck-manager.ts` and `deck-canvas.tsx`.
- `card-registry.ts` drops the field; `tug-pane.css` drops the rule.

#### [P10] The mis-named Settings bodies get straightened out (DECIDED) {#p10-settings-rename}

**Decision:** When the General tab retires, `settings-general-body.tsx` (which actually renders the **Session Card** tab) is renamed to `settings-session-card-body.tsx` (+ its `.css` and imports), and `settings-lens-body.tsx`/`.css` are deleted. Settings drops to three tabs: Session Card, Text Card, Maker, defaulting to Session Card.

**Rationale:**
- The naming is crossed today (`settings-general-body` = Session Card tab; `settings-lens-body` = General tab); deleting one without renaming the other leaves the trap armed.

**Implications:**
- `settings-card.tsx`'s `TABS` array and `SettingsTabId` union shrink; the default `useState` tab becomes `"sessionCard"`.
- `at0236-settings-general-tab.test.ts` (which exercises the General tab) is rewritten against the surviving tabs or retired; its `@covers` lines must resolve.

---

### Deep Dives {#deep-dives}

#### Current anchored machinery — the full retirement inventory {#anchored-inventory}

Everything that reads or writes `anchor` / `anchorSide` today, and what happens to it:

**Table T01: `anchor` / `anchorSide` / `imposition` consumers** {#t01-consumers}

| Site | Today | Becomes |
|------|-------|---------|
| `layout-tree.ts` `TugPaneState.anchor` | stored field | **deleted**; invariant 6 → "at most one Lens pane, and it carries no slot" ([P04]) |
| `layout-tree.ts` `DeckState.imposition?` | optional kind | required `DeckImposition` record ([P01]) |
| `serialization.ts` parse/serialize `anchor` | round-trips | parse reads once for migration ([P06]); never serialized; fit-skip keys on Lens pane + `slot` |
| `serialization.ts` `imposition` | string | record, legacy string accepted (Spec S02) |
| `tug-pane.tsx` `anchorSide` / `anchored` / `data-anchored` / anchored style branch | anchor-derived render mode | `lensSide?: LensSide` prop; pinned style from `imposeLensStyle`; `data-lens` attribute ([P03]) |
| `tug-pane.tsx` `handleAnchoredResizeStart` | anchored width-only resize | kept mechanically, keyed on `lensSide`, renamed `handleLensResizeStart` |
| `tug-pane.tsx` drag-start tab-bar skip `.tug-pane[data-anchored]` | merge exclusion | `.tug-pane[data-lens]` (belt-and-suspenders; the Lens pane has no tab bar) |
| `tug-pane.css` `[data-anchored]` border rules, `[data-square-corners]` rule | flush-edge styling | **deleted** ([P03], [P09]) |
| `deck-canvas.tsx` `ANCHORED_PANE_ZINDEX`, `railPane = panes.find(anchor)` | anchor-keyed | `LENS_PANE_ZINDEX` (same 8999), rail via `findLensPane`, side via `imposition.lens` ([P04], [P05]) |
| `deck-canvas.tsx` placements `slot: pane.anchor === undefined ? …` | anchor guard | plain `pane.slot` (the invariant guarantees the Lens pane has none) |
| `deck-manager.ts` `setLensAnchorSide` | store write + live anchor flip | Steps 1–3: delegates to `setImpositionLens`; Step 4: **deleted** ([P08]) |
| `deck-manager.ts` `_createLensPane` `anchor: lensSnapshot.anchorSide` | writes anchor | no `anchor`; side comes from `deckState.imposition.lens` ([P02]) |
| `deck-manager.ts` `movePane` width mirror `existing.anchor !== undefined` | anchor-keyed | `findLensPane` predicate ([P04]); `lensStore.setWidth` mirror **stays** (reopen width) |
| `deck-manager.ts` `assignCardToSlot` anchored guard | anchor-keyed | Lens-pane predicate ([P04]) |
| `deck-manager.ts` `arrangeCards` | maps **every** pane; tile mode writes `size` over the rail | skips the Lens pane via `findLensPane` (Spec S03) — pre-existing defect fixed in passing |
| `deck-manager.ts` `addCard` `slot: 0` gate `imposition !== undefined` | kind check | `imposition.kind !== undefined` ([P01]) |
| `deck-manager.ts` `setImposition(kind\|null)` | replaces/deletes `imposition` | mutates `imposition.kind` only, preserving `lens`; freeze-on-clear unchanged |
| `action-dispatch.ts` `set-lens-side` | registered action | Step 4: **deleted**; `set-imposition-lens` registered in Step 1 ([P08]) |
| `slot-picker.tsx` `imposition` read + `host.anchor` guard | kind + anchor | `imposition.kind` + Lens-pane predicate |
| `layouts-section.tsx` `useImposition` | kind | reads the whole record (Step 3 rebuild consumes both axes) |
| `settings-lens-body.tsx` + `.css`, `settings-card.tsx` `general` tab | the app-wide setting | **deleted**; tabs shrink ([P10]) |
| `lib/lens-store/*` `anchorSide` (types, reducer event, store setter, persist/hydrate, `normalizeLensAnchorSide`, `use-lens-anchor-side.ts`) | preference store limb | **deleted** in Step 4; `widthPx` and everything else stays; legacy key read only by the migration seed ([P06]) |
| `lens-register-card.tsx` `squareCorners: true` | square rail corners | dropped; the constant `LENS_CARD_ID` moves to `lib/lens-card-id.ts` ([P09]) |

#### Why the Lens is the strip's fixed end, not a chain link {#fixed-end}

The imposer packs cards with the step rule (`lib/layout-imposer.ts`): `step = min(gap, (band − ΣcardWidths) / (cards − 1))` — one gap apart when they fit, equal overlaps sized to land the strip's far edge exactly on the band's far edge when they don't. If the Lens took a step in that chain, a crowded deck would overlap cards onto it, violating the locked never-under-the-Lens requirement. So the Lens holds its width and the cards share what remains — which is what the band inset already does. The change is only that the inset derives from the *layout record* (`imposition.lens` + the Lens pane's width) rather than from a stored `anchor`.

---

### Specification {#specification}

**Spec S01: Pinned-Lens geometry** {#s01-lens-geometry}

All values in layout pixels; `GAP = IMPOSITION_GAP_PX = 5`, `GAP_BOTTOM = IMPOSITION_GAP_BOTTOM_PX = 32`. `W` is the Lens pane's **render width**: `max(pane.size.width, sizePolicy.min.width)` — the same clamp `TugPane.renderWidth` and the placements memo apply.

- **Lens frame (expanded):** `{ [side]: "5px", top: "5px", bottom: "32px", width: "<W>px", height: "auto" }` — emitted by a new pure `imposeLensStyle(side: LensSide, collapsed: boolean): React.CSSProperties` in `lib/layout-imposer.ts`. Collapsed: keep the side and top pins, release `bottom`, and let `TugPane` set the window-shade stub height — the identical treatment the imposed-collapsed branch uses today.
- **Band insets (written by `DeckCanvas`'s `useLayoutEffect`):** Lens open on side S → `--tug-imposer-inset-S = ${W + GAP}px`, opposite side `0px`. Lens closed → both `0px`.
- **`resolveSpan(canvas, lens)`:** `lens: { side: LensSide; width: number } | null` (the *render* width, un-gapped); inset applied inside = `lens.width + GAP`. Numeric twin of the CSS by construction.
- **Derivation check (right-docked Lens, cards pack left):** Lens occupies `[canvasW − GAP − W, canvasW − GAP]`. Cards must span `[GAP, canvasW − W − 2·GAP]`. `imposeStyle`'s band = `100% − insetL − insetR − 2·GAP` = `canvasW − (W + GAP) − 2·GAP` = `canvasW − W − 3·GAP`; first pin = `insetL + GAP` = `GAP` ✓; chain far edge = `GAP + band` = `canvasW − W − 2·GAP` ✓ — one gap off the Lens's near edge.
- **Interaction:** no drag (title bar passes `onDragStart={undefined}`); resize only on the deck-facing edge (east for a left Lens, west for a right Lens), width-only, Option-snap capable, min = `MIN_LENS_WIDTH_PX` via sizePolicy, max = `window.innerWidth − ANCHORED_MIN_GUTTER_PX` (rename the constant `LENS_MIN_GUTTER_PX`); commit mirrors width to `lensStore.setWidth` (reopen width). Never `evictSlot`.
- **Attributes:** the frame carries `data-lens="<side>"` (replacing `data-anchored`); no flush-edge border overrides — standard rounded chrome.
- **Z-order:** `LENS_PANE_ZINDEX = 8999` (unchanged value, renamed constant).

**Spec S02: Wire format and migration** {#s02-wire-migration}

Wire stays `version: 4`. New serialized shape (always present):

```json
{ "version": 4, "cards": [...], "panes": [...], "imposition": { "kind": "three-up", "lens": "right" } }
```

`kind` is omitted when off: `"imposition": { "lens": "right" }`. Panes never carry `anchor` on write.

Parse (`parseV4`) resolves the record as:

- **kind:** `raw.imposition.kind` if `isImpositionKind`; else the legacy string `raw.imposition` itself if `isImpositionKind`; else absent. Slot parsing stays gated on a resolved kind, exactly as today.
- **lens**, first match wins:
  1. `raw.imposition.lens` when `"left"` or `"right"`;
  2. the legacy Lens pane's `anchor` (`"left"`/`"right"`) — the Lens pane found by `componentId === LENS_CARD_ID` among the parsed cards;
  3. the `fallbackLensSide` parameter (new 4th argument of `deserialize`, default `"right"`).
- **pane `anchor`:** read only to (a) supply rule 2 and (b) skip `fitPaneGeometry` for that pane on this load; never placed on the resulting `TugPaneState`. The fit-skip otherwise keys on `slot !== undefined` or being the Lens pane.

`DeckManager.loadLayout()` computes the fallback before deserializing: a small helper reads tugbank `dev.tugtool.lens` / key `"anchorSide"` via `getTugbankClient()?.get(...)` (the key literal lives only here, commented as the legacy migration read), normalizes to `"left"`/`"right"`/`undefined`, and passes it as `fallbackLensSide`. The value persists into the layout blob on the next save; the tugbank key is never written again. `buildDefaultLayout()` returns `imposition: { lens: "right" }` (the `main.tsx` harvest path and tests don't care).

**Spec S03: DeckManager API** {#s03-deck-manager}

- `setImposition(kind: ImpositionKind | null)`: mutates only `imposition.kind` (spreading the record, preserving `lens`). Behavior otherwise unchanged: kind change clamps slots with the whole-chain move ledger; `null` freezes each imposed pane at its live frame rect and deletes `kind`.
- `setImpositionLens(side: LensSide)`: no-op when unchanged. Writes `imposition.lens`; fires `notifyCardWillMove`/`DidMove` for the Lens pane's active card (when open) and for every slotted pane's active card (the side flip flips `packFrom`, moving the whole chain); `notify()` + `scheduleSave()`. Steps 1–2 transition detail: while `anchor` still exists (Step 1 only), also flip the live Lens pane's `anchor` so the render follows — this line is deleted with `anchor` in Step 2.
- `_createLensPane()`: side from `this.deckState.imposition.lens`; no `anchor` field; width from `lensStore.getSnapshot().widthPx` clamped to policy min, as today.
- `findLensPane(state)` (in `deck-store-selectors.ts`): returns the pane hosting the `LENS_CARD_ID` card, or `undefined`. Used by `movePane`, `assignCardToSlot`, `DeckCanvas`, `SlotPicker`, `arrangeCards`, and `validateDeckState`'s new invariant (the validator may inline the walk since it already indexes cards).
- `arrangeCards(mode)`: **skips the Lens pane** — it maps over every pane today with no derived-geometry check, and tile mode writes `size`, so Window ▸ Tile rewrites the rail's stored width and (once the Lens is pinned at that width) visibly resizes it and shifts the whole band. The pane passes through untouched and contributes no lifecycle-ledger entry. This is a pre-existing defect against the anchored rail, fixed here because the plan re-keys every other `anchor` consumer. Slotted panes are deliberately **not** skipped: their stored geometry is already ignored while imposed, eviction stays explicit ([D121]), and the stale write is what the freeze-on-clear path reads — the shipped behavior, unchanged.

**Spec S04: The two-axis Layouts picker** {#s04-picker}

Structure, top to bottom inside the section body:

1. **Lens side control** — a two-segment `TugChoiceGroup` (values `left` / `right`, `aria-label`s "Lens on left" / "Lens on right"), each segment's `icon` a `LayoutMiniature` showing only the rail on that side (no cards). Selection dispatches `set-imposition-lens` via the section's `selectValue` responder (same sender-id pattern the section uses today).
2. **Kind rows** — `TugRadioGroup` (values `off`, `two-up`, `three-up`, `four-up`) with `TugRadioItem` children whose content is `LayoutMiniature` + label ("Off", "Two Up", "Three Up", "Four Up"), laid out two per row by section CSS (the P4 two-column-rows shape). Selection dispatches `set-imposition`.

`LayoutMiniature` (`components/lens/layout-miniature.tsx` + `.css`): a pure presentational component `{ kind: ImpositionKind | null; lens: LensSide | null; selected?: boolean }`. It adapts the gallery spike's `CanvasMini`: a 16/10 frame; the rail drawn as a strip on the `lens` side (`RAIL_PCT ≈ 18%`); `kind === null` draws one wide free block; otherwise N blocks (`CARD_PCT ≈ 26%`) packed *away from the rail* with the miniature step rule `step = min(GAP_PCT, (field − 2·GAP_PCT − CARD_PCT·N) / (N − 1))`, absolutely positioned so overlap is drawable. Tokens come from the theme (the spike's `--tug7-*` choices are a starting point, re-audited with `bun run audit:theme-contrast` if new pairings appear). Every miniature in the section receives the **live** `imposition.lens`, so choosing a side flips all the pictures.

The section keeps: `registerLensSection` shape, `collapsedSummary` (now "Off" / kind label — side is not summarized), the `useLayoutEffect` content declaration ([L03]), and store reads via `useSyncExternalStore` ([L02]).

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| `imposition.lens` (the side) | structure | deck store + `useSyncExternalStore`; persisted in the layout blob | [L02], [L23] |
| `imposition.kind` | structure (unchanged) | deck store + `useSyncExternalStore` | [L02] |
| Lens frame geometry (pins, gaps) | appearance, CSS-derived | inline style from pure `imposeLensStyle`; band insets as CSS custom properties via `useLayoutEffect` | [L06], [L09], [L03] |
| Lens open/closed | structure (unchanged) | pane presence in `deckState.panes` | [L02] |
| Lens reopen width (`lensStore.widthPx`) | preference (unchanged) | lens store → tugbank | [L02], [L23] |
| Picker selection | none (controls emit actions) | `selectValue` → `set-imposition` / `set-imposition-lens` dispatch | [L11] |
| Miniature rendering | appearance | pure props → CSS | [L06], [L19] |

---

### Compatibility / Migration / Rollout {#rollout}

- **Compatibility policy:** wire stays `version: 4`; the `imposition` value widens from string to record (legacy string still parses). Old builds reading a new blob fail `isImpositionKind` on the object and drop the arrangement gracefully — panes keep their stored geometry.
- **Migration plan:** three-source lens-side resolution per Spec S02; pane `anchor` consumed on first load and gone from the next save; tugbank `dev.tugtool.lens/anchorSide` read once as the last-resort seed, never written again.
- **Rollout:** no flag. The change is self-migrating on first launch; rollback = revert the commits (an old build then re-fits the Lens pane as a free pane on next load — recoverable by reopening the Lens).

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/lib/lens-card-id.ts` | Leaf home for `LENS_CARD_ID` ([P09]) |
| `tugdeck/src/components/lens/layout-miniature.tsx` + `.css` | The reusable deck miniature ([P07], Spec S04) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `LensSide` | type | `lib/layout-imposer.ts` | `"left" \| "right"` — replaces `LensAnchorSide` as the canonical side type |
| `DeckImposition` | interface | `lib/layout-imposer.ts` | `{ kind?: ImpositionKind; lens: LensSide }` ([P01]) |
| `imposeLensStyle(side, collapsed)` | fn | `lib/layout-imposer.ts` | Spec S01 |
| `resolveSpan(canvas, lens)` | fn (modified) | `lib/layout-imposer.ts` | inset = `lens.width + GAP` ([P05]) |
| `packFromForRail(railSide)` | fn (unchanged semantics) | `lib/layout-imposer.ts` | now fed from `imposition.lens` when the Lens is open, `null` when closed |
| `DeckState.imposition` | field (modified) | `layout-tree.ts` | required record ([P01]) |
| `TugPaneState.anchor` | field | `layout-tree.ts` | **deleted** (Step 2) |
| `validateDeckState` invariant 6 | fn (modified) | `layout-tree.ts` | at-most-one-Lens-pane, Lens pane slotless ([P04]) |
| `findLensPane(state)` | fn | `deck-store-selectors.ts` | [P04] |
| `deserialize(json, w, h, fallbackLensSide?)` | fn (modified) | `serialization.ts` | Spec S02 |
| `DeckManager.setImpositionLens(side)` | method | `deck-manager.ts` | Spec S03, [P08] |
| `DeckManager.setLensAnchorSide` | method | `deck-manager.ts` | Step 1: delegates; Step 4: **deleted** |
| `set-imposition-lens` | action | `action-dispatch.ts` | [P08] |
| `set-lens-side` | action | `action-dispatch.ts` | **deleted** (Step 4) |
| `TugPaneProps.lensSide` | prop | `components/chrome/tug-pane.tsx` | replaces the `stackState.anchor` read ([P03]) |
| `handleLensResizeStart` | fn (renamed) | `components/chrome/tug-pane.tsx` | was `handleAnchoredResizeStart` |
| `LENS_PANE_ZINDEX` | const (renamed) | `components/chrome/deck-canvas.tsx` | was `ANCHORED_PANE_ZINDEX`, value 8999 |
| `LayoutMiniature` | component | `components/lens/layout-miniature.tsx` | Spec S04 |
| `CardMeta.squareCorners` | field | `card-registry.ts` | **deleted** ([P09]) |
| `LensAnchorSide`, `normalizeLensAnchorSide`, `DEFAULT_LENS_ANCHOR_SIDE`, `LENS_KEYS.ANCHOR_SIDE`, `anchorSide` state/event/setter, `useLensAnchorSide` | types/fns | `lib/lens-store/*` | **deleted** (Step 4); `widthPx` limb untouched |
| `SettingsGeneralBody` → `SettingsSessionCardBody` | component (renamed) | `components/tugways/cards/settings-session-card-body.tsx` | [P10] |
| `SettingsLensBody` | component | `components/tugways/cards/settings-lens-body.tsx` | **deleted** (Step 4) |

---

### Documentation Plan {#documentation-plan}

- [ ] Amend **[D121]** in `tuglaws/design-decisions.md`: the imposition is `{ kind?, lens }`; the Lens is the strip's pinned fixed end (never a chain link); `anchor` and invariant 6 replaced; also correct the stale "width-only imposed resize / resizing never evicts" language to the shipped universal-eviction rule (any manual move **or resize** releases a pane; the pinned Lens is the exception).
- [ ] Update `tuglaws/pane-model.md` § "Three geometry modes": anchored retires; the modes are **free**, **imposed (slotted)**, and **pinned (the Lens)** — pinned derives side from `imposition.lens` and width from the pane.
- [ ] Module docstrings updated where behavior moved (`layout-imposer.ts` packing note, `lens-register-card.tsx` invariant note, `lens-store` module notes dropping anchorSide).

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** (`bun:test`) | Pure geometry (`imposeLensStyle`, `resolveSpan`), serialization/migration precedence, deck-manager mutations, lens-store reducer after the limb removal | Steps 1, 2, 4 |
| **App-test** (`tests/app-test/`) | Real rendered geometry (Lens gaps, chain-vs-Lens clearance, live side flip), the picker driving the real deck, Settings tab count | Steps 2, 3, 4, 5 |
| **Golden / Contract** | Wire-shape assertions on `serialize()` output (record form, no `anchor`) | Step 1 |

#### What stays out of tests {#test-non-goals}

- No fake-DOM/RTL render tests and no mock-store assertion tests — banned patterns; real-app behavior lands in `tests/app-test/`.
- Cmd-L focus semantics are not re-tested here — unchanged by design ([P02]); the existing `at0231`/`at0247`/`at0256` suite covers them and runs via selection when `tug-pane.tsx`/`deck-manager.ts` change.
- The miniature's exact pixel art is not asserted — it is presentational; only its presence and side-flip response are checked in the app-test.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Every step below.
>
> Standard checkpoint battery, abbreviated in steps as **[full battery]**: `cd tugdeck && bun test` · `bunx tsc --noEmit` · `bunx vite build` · `just app-test-changed` (from the repo root).

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Imposition record: model, wire, migration, manager API | done | `87238f72f` |
| #step-2 | The Lens becomes a pinned imposed pane; `anchor` retires | done | `c6ad7421c` |
| #step-3 | The two-axis Layouts picker | done | `419edb15a` |
| #step-4 | Delete the app-wide setting, the store limb, and the General tab | done | `3306115d9` |
| #step-5 | Tuglaws amendments + integration checkpoint | done | `6f8dbbbb3` |

#### Step 1: Imposition record — model, wire, migration, manager API {#step-1}

**Commit:** `tugways(imposition): imposition becomes a {kind, lens} record with legacy migration`

**References:** [P01] imposition record, [P02] side only, [P06] migration, [P08] lens action, Spec S02, Spec S03, Table T01, Risk R01, (#anchored-inventory)

**Artifacts:**
- `LensSide`, `DeckImposition` in `lib/layout-imposer.ts`; `DeckState.imposition` required in `layout-tree.ts`.
- `lib/lens-card-id.ts` (constant moved; `lens-register-card.tsx` imports it).
- `deserialize` with `fallbackLensSide`; record-form `serialize`; the tugbank legacy-seed helper in `deck-manager.ts` `loadLayout()`.
- `DeckManager.setImpositionLens` + `set-imposition-lens` action; `setLensAnchorSide` delegating to it (transitional bridge).

**Tasks:**
- [ ] Define `LensSide` and `DeckImposition` in `lib/layout-imposer.ts`; make `DeckState.imposition: DeckImposition` required; `buildDefaultLayout()` returns `{ lens: "right" }`.
- [ ] `serialization.ts`: serialize the record always (omit `kind` when off, never `anchor` — but **keep parsing and emitting pane `anchor`** this step, the render still uses it); parse per Spec S02 with the three-source lens precedence; add the `fallbackLensSide` parameter.
- [ ] Move `LENS_CARD_ID` to `lib/lens-card-id.ts`; update imports in `lens-register-card.tsx`, `deck-manager.ts`, `deck-canvas.tsx`; import it in `serialization.ts` for the migration read.
- [ ] `deck-manager.ts`: `loadLayout()` reads the legacy tugbank `anchorSide` (literal key, commented as migration-only) and passes it to `deserialize`; `setImposition` mutates `kind` only (spread preserves `lens`); freeze-on-clear keyed on `kind`; `addCard`'s `slot: 0` gate → `.kind !== undefined`; add `setImpositionLens` per Spec S03 (including the transitional live-`anchor` flip); `setLensAnchorSide` becomes a one-line delegate to `setImpositionLens`; `_createLensPane` reads the side from `imposition.lens` (still writing `anchor` for the render, this step only).
- [ ] `action-dispatch.ts`: register `set-imposition-lens`; `set-lens-side` keeps working through the delegate.
- [ ] Flip the remaining `.imposition` consumers to `.kind` per Table T01: `deck-canvas.tsx` placements memo, `slot-picker.tsx`, `layouts-section.tsx` (`useImposition` returns the record; existing UI reads `.kind`).

**Tests:**
- [ ] Serialization unit tests: record round-trip; legacy string + pane `anchor: "left"` → `{ kind, lens: "left" }`; no sources → fallback param; record `lens` shadows pane `anchor`; slots still gated on kind; `serialize()` output contains the record and (still, this step) pane `anchor`.
- [ ] Deck-manager unit tests: `setImposition` preserves `lens`; `setImpositionLens` no-op / side write / move-ledger firing.

**Checkpoint:**
- [ ] [full battery]
- [ ] Launch the debug app: existing layout loads with the Lens where it was; Settings ▸ General side switch still flips the live rail (through the delegate).

---

#### Step 2: The Lens becomes a pinned imposed pane; `anchor` retires {#step-2}

**Depends on:** #step-1

**Commit:** `tugways(imposition): the Lens renders as a pinned imposed pane; anchor geometry mode retires`

**References:** [P03] pinned imposed, [P04] derived identity, [P05] band insets, [P09] squareCorners, Spec S01, Table T01, Risk R01, (#fixed-end, #s01-lens-geometry)

**Artifacts:**
- `imposeLensStyle` + modified `resolveSpan` in `lib/layout-imposer.ts`; `findLensPane` in `deck-store-selectors.ts`.
- `tug-pane.tsx` with `lensSide` prop, pinned render branch, `data-lens`, `handleLensResizeStart`; no anchored branch.
- `layout-tree.ts` without `anchor`; new invariant 6; `serialization.ts` never emitting `anchor`.
- Updated `at0275` with Lens-geometry assertions.

**Tasks:**
- [ ] `lib/layout-imposer.ts`: add `imposeLensStyle(side, collapsed)` (Spec S01); change `resolveSpan` to take `lens: { side, width } | null` with the `+ GAP` inset inside; update the module packing note.
- [ ] `deck-store-selectors.ts`: add `findLensPane(state)`.
- [ ] `deck-canvas.tsx`: resolve the rail via `findLensPane`; side from `deckState.imposition.lens` (used only while the Lens is open — `packFromForRail(null)` when closed, unchanged behavior); insets = clamped render width `+ IMPOSITION_GAP_PX` per [P05] (fixing the raw-width read in passing); rename `ANCHORED_PANE_ZINDEX` → `LENS_PANE_ZINDEX` keyed on the Lens pane; pass `lensSide` to its `TugPane`; drop the `pane.anchor` guard in the placements memo.
- [ ] `tug-pane.tsx`: replace the `stackState.anchor` read with the `lensSide` prop; pinned style branch = `imposeLensStyle` (+ collapsed stub height, as the imposed branch does); `data-lens` attribute; title-bar drag disabled for the Lens; resize renders only the deck-facing handle via `handleLensResizeStart` (mechanics unchanged from `handleAnchoredResizeStart`; rename `ANCHORED_MIN_GUTTER_PX` → `LENS_MIN_GUTTER_PX`); tab-bar merge skip keys on `[data-lens]`; delete the anchored branch and `data-anchored`; delete `squareCorners` wiring.
- [ ] `layout-tree.ts`: delete `TugPaneState.anchor`; invariant 6 → at most one pane hosts the `LENS_CARD_ID` card and that pane has no `slot` (walk `cards` by componentId).
- [ ] `deck-manager.ts`: `_createLensPane` writes no `anchor`; `movePane` width mirror and `assignCardToSlot` guard key on `findLensPane`; delete `setImpositionLens`'s transitional anchor flip; **`arrangeCards` skips the Lens pane** (Spec S03) so Window ▸ Tile no longer rewrites the rail's stored width.
- [ ] `serialization.ts`: stop emitting `anchor`; the parse keeps the read purely as migration input (Spec S02); fit-skip keys on Lens pane / `slot`.
- [ ] `slot-picker.tsx`: disabled guard via the Lens-pane predicate.
- [ ] CSS: delete `tug-pane.css` `[data-anchored]` and `[data-square-corners]` rules; `card-registry.ts` drops `squareCorners`; `lens-register-card.tsx` drops `squareCorners: true` and updates its docstring.
- [ ] Update `at0275`: assert the Lens frame rect (5px side/top, 32px bottom, rounded chrome i.e. non-zero `border-radius` on `.tug-pane-chrome`), the chain far edge at `canvasW − W − 2·GAP`, the eased overlap on Lens close, and a `setImpositionLens` side flip re-packing the chain live (dispatch via the store or the action; screenshot+measure loop for calibration, then remove the screenshot).

**Tests:**
- [ ] `layout-imposer` unit tests: `imposeLensStyle` shapes; `resolveSpan` inset arithmetic against the Spec S01 derivation check; CSS/numeric-twin agreement at the new insets.
- [ ] `layout-tree` unit tests: new invariant 6 (two Lens panes rejected; slotted Lens pane rejected).
- [ ] Serialization: `serialize()` output contains no `anchor`; legacy `anchor` still harvests.
- [ ] Deck-manager unit test: `arrangeCards("tile")` leaves the Lens pane's `size` and `position` untouched and fires no lifecycle entry for it, while still tiling every other pane.

**Checkpoint:**
- [ ] [full battery] — `at0275` among the selected tests, passing with the new assertions.
- [ ] Debug app: Lens floats with gaps and round corners; drag a slotted card wide — the chain overlaps but never crosses under the Lens; Lens edge-resize re-packs live; Lens has no other resize handles and cannot be dragged.

---

#### Step 3: The two-axis Layouts picker {#step-3}

**Depends on:** #step-2

**Commit:** `tugways(lens): two-axis Layouts picker — Lens side + P4 miniature rows`

**References:** [P07] two-axis picker, [P08] lens action, Spec S04, (#s04-picker)

**Artifacts:**
- `components/lens/layout-miniature.tsx` + `.css`.
- Rebuilt `components/lens/sections/layouts-section.tsx` + `.css`.

**Tasks:**
- [ ] Build `LayoutMiniature` per Spec S04, adapting the gallery spike's `CanvasMini` (frame, rail strip on the given side, packed blocks with the miniature step rule, absolute positioning for drawable overlap; `kind: null` = one wide free block).
- [ ] Rebuild `LayoutsSectionBody`: side control (two-segment `TugChoiceGroup`, miniature icons) above the kind rows (`TugRadioGroup`/`TugRadioItem` hosting miniature + label, two per row via CSS); both axes read the live record via `useSyncExternalStore`; dispatch `set-imposition-lens` / `set-imposition` through the section's `selectValue` responder with distinct sender ids; keep the `useLayoutEffect` content declaration and `collapsedSummary`.
- [ ] Verify keyboard navigation through the section (the Cmd-L seed and the Tab walk reach both controls) against `tuglaws/focus-language.md`.
- [ ] Run `bun run audit:theme-contrast` if the miniature introduces new token pairings.
- [ ] Extend `at0275`: drive the side flip and a kind change through the *real picker controls* (click the segments/rows) rather than raw dispatch; assert the miniatures flip when the side changes (`data-` attribute or rail-side DOM check).
- [ ] Add the **relaunch persistence** assertion (see Tests below) — this is the new persistence path's only end-to-end proof, and it inherits the assertion `at0236` retires in #step-4.

**Tests:**
- [ ] App-test coverage above (`@covers` updated for `layout-miniature.tsx` and the rebuilt section).
- [ ] **A picker-chosen Lens side survives an app relaunch.** Choose "Left" in the Layouts section, let the layout blob save (`scheduleSave`'s debounce), relaunch the app against the same tugbank, and assert the Lens mounts on the left. This is the round-trip that catches a serialize/parse asymmetry in the new record — the Step 5 migration proof only covers *legacy* blobs, and the live-flip assertion above only covers the in-session write. Follow `at0236`'s existing pattern for the seeded-tugbank relaunch (`mkTempTugbank` / `seedTugbankForLaunch` / `tugbankRead` from `_harness/tugbank-helpers`), reading the layout blob rather than `dev.tugtool.lens/anchorSide`.

**Checkpoint:**
- [ ] [full battery]
- [ ] Debug app: the section reads as pictures of the deck; choosing Lens Left flips every miniature and the live rail; screenshot review with the user before locking visuals.

---

#### Step 4: Delete the app-wide setting, the store limb, and the General tab {#step-4}

**Depends on:** #step-3

**Commit:** `tugways(settings): retire the General tab and the app-wide Lens side setting`

**References:** [P08] lens action, [P10] settings rename, [P06] migration (the seed survives the deletion), Table T01

**Artifacts:**
- Settings with three tabs; `settings-lens-body.tsx`/`.css` deleted; `settings-general-body.*` renamed to `settings-session-card-body.*`.
- Lens store without the `anchorSide` limb; `use-lens-anchor-side.ts` deleted; `set-lens-side` and `setLensAnchorSide` deleted.

**Tasks:**
- [ ] `settings-card.tsx`: drop the `general` tab from `TABS` and `SettingsTabId`; default tab `"sessionCard"`; delete `settings-lens-body.tsx` + `.css`.
- [ ] Rename `settings-general-body.tsx`/`.css` → `settings-session-card-body.tsx`/`.css` (`SettingsGeneralBody` → `SettingsSessionCardBody`); update imports and any test ids that say "general" for the session-card body.
- [ ] `action-dispatch.ts`: delete `set-lens-side`; `deck-manager.ts`: delete `setLensAnchorSide` and its `LensAnchorSide` import.
- [ ] `lib/lens-store/`: remove `anchorSide` from `types.ts` (`LensAnchorSide`, `DEFAULT_LENS_ANCHOR_SIDE`, `normalizeLensAnchorSide`, `LENS_KEYS.ANCHOR_SIDE`, snapshot field), `reducer.ts` (state field, `set_anchor_side` event, hydrate branch), `lens-store.ts` (setter, hydrate read, persist diff, `readAnchorSide`); delete `use-lens-anchor-side.ts`; update the module docstrings.
- [ ] Update `lib/lens-store/__tests__/reducer.test.ts` and `persistence.test.ts` for the removed limb.
- [ ] Rewrite or retire `tests/app-test/at0236-settings-general-tab.test.ts` against the three-tab Settings (verify its `@covers` lines resolve; `just app-test-covers-check`). Its two assertions have already moved: the **live side flip** and the **persistence-across-relaunch** round-trip both land in `at0275` in #step-3, so retiring it loses no coverage. Do not retire it before that step's tests are green.
- [ ] Sweep: `grep -rn "anchorSide\|set-lens-side\|LensAnchorSide\|settings-lens\|SettingsGeneralBody" tugdeck/src tests/` returns only the migration seed's commented literal in `deck-manager.ts`.

**Tests:**
- [ ] Lens-store unit tests green with the limb gone.
- [ ] Settings app-test asserts exactly three tabs and the Session Card default.

**Checkpoint:**
- [ ] [full battery] + `just app-test-covers-check`
- [ ] Debug app: Settings opens on Session Card with three tabs; the Layouts section is the only place the Lens side is set; a fresh-profile boot (no tugbank `anchorSide`) opens the Lens on the right.

---

#### Step 5: Tuglaws amendments + integration checkpoint {#step-5}

**Depends on:** #step-2, #step-3, #step-4

**Commit:** `tuglaws(pane-model): the Lens joins the imposition — D121 amendment, geometry modes update`

**References:** [P01]–[P10], Spec S01, Spec S02, (#documentation-plan, #success-criteria)

**Tasks:**
- [ ] Amend [D121] and `pane-model.md` per the Documentation Plan (including the stale width-only-resize language correction).
- [ ] Verify every Success Criterion in `#success-criteria`, item by item.
- [ ] Run the migration proof by hand once: seed the debug app with a saved pre-change layout blob (string `imposition` + `anchor` Lens pane), boot, verify side/slots/next-save shape.
- [ ] Final sweep for leftovers: `grep -rn "\banchor\b" tugdeck/src/layout-tree.ts tugdeck/src/serialization.ts tugdeck/src/components/chrome/` shows only the migration read and unrelated uses (popover anchors, scroll anchors).

**Tests:**
- [ ] `just app-test-changed` across the phase's full diff (expect `at0275`, the lens/settings tests, and any SWEEP ADVISED guidance followed).

**Checkpoint:**
- [ ] [full battery] from a clean working tree.
- [ ] This step's commit carries only the tuglaws docs; any code fixups discovered during verification land as follow-up commits scoped like the owning step's.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** The Lens is a pinned member of the imposition — its side lives in `imposition.lens`, it renders through the imposer with gaps and round corners, the `anchor` mode and the Settings General tab are gone, and the Layouts section is the single two-axis, picture-first home for every layout decision.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] All Success Criteria in `#success-criteria` verified (each names its measurement).
- [ ] Step Status Ledger fully `done` with commit hashes recorded.
- [ ] `bun test` / `tsc` / `vite build` / `just app-test-changed` / `just app-test-covers-check` green from a clean tree.

**Acceptance tests:**
- [ ] `at0275-layout-imposition.test.ts` — Lens geometry, chain clearance, live side flip through the real picker, and side persistence across relaunch.
- [ ] Serialization unit suite — migration precedence matrix (Spec S02).
- [ ] Deck-manager unit suite — `arrangeCards("tile")` skips the Lens pane.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Retire the `gallery-slot-layout` spike or convert it into a `LayoutMiniature` component-gallery entry.
- [ ] The known `TugSlot` nit: interactive slots render `border-radius: 0` because `TugButton`'s `rounded="none"` rule outranks `.tug-slot` — fix by selecting on `.tug-slot[data-rounded="none"]`.
- [ ] Consider a keyboard accelerator for cycling the imposition kind.

| Checkpoint | Verification |
|------------|--------------|
| Model + migration | serialization unit matrix; debug-app boot from a legacy blob |
| Pinned Lens | `at0275` geometry assertions; manual gap/corner inspection |
| Picker | `at0275` picker-driven flip; user screenshot review |
| Deletion | grep sweeps; three-tab Settings app-test |
