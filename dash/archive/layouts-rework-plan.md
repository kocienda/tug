<!-- tugplan: authored by /tugplug:devise against tuglaws/devise-skeleton.md v4 -->

## Layouts Rework — Jots, Sidebar Cards, Width Presets, Z2/Z4B Diet {#layouts-rework}

**Purpose:** Ship the interlocking layout change set decided in `dash/layouts-rework.md`: Snippets renamed **Jots** full-depth and lifted into its own sidebar card; a content/sidebar card taxonomy generalizing the pinned-Lens machinery; content width presets (slim 675 / comfy 800 / wide 1230) replacing the window-shade collapse; the Z2/Z4B diets that make slim viable; and the ⌘J / ⌃⌘J / ⌃⌘L chord set.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-06 |
| Source brief | `dash/layouts-rework.md` (all decisions final) |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The Snippets section never belonged in the Lens — it is a capture surface, not a lens onto the deck. Meanwhile the layout system has a hard-wired special case: the pinned Lens (`imposition.lens` + `lensPinned` + `imposeLensStyle` + the space allocator) is a fully general "pane pinned to a deck edge that insets the imposition band," reachable only via `findLensPane()` matching `componentId === LENS_CARD_ID`. Lifting Snippets out as a **Jots card** forces that special case to become a declared trait — `layoutRole: "sidebar"` — and once the taxonomy exists, content cards get the other half: width presets. The Session card's 800px width floor is derived from Z2's instrument cells, so slim (675) requires the Z2/Z4B diet; the width popup requires the collapse chevron's slot; the Layouts section is the home for both sidebar positions and the default width. Everything interlocks, which is why this is one phase.

#### Strategy {#strategy}

- **Rename first, in two green commits**: the wire layer (Rust + HTTP + feed + on-disk file + the TS touchpoints that speak to it) lands as one commit so the tree never has a frontend calling a route that doesn't exist; the TS-internal symbol/file rename follows as a second, purely mechanical commit.
- **Generalize before adding**: promote the Lens special case to the `sidebars` map with Lens as its only occupant (pure parity, existing tests still pass), then add bilateral + stacking + the equal-resize allocator, and only then introduce the Jots card as the second occupant.
- **Diet before slim**: Z2 and Z4B shed weight before any registration min drops to 675 or any preset can be applied, so no commit ever produces a card narrower than its chrome.
- **Collapse removal and the width popup land together**: the popup takes the chevron's slot, so `at0156`'s exact-control-set assertion changes once, not twice.
- **Doctrine and tests close the phase**: tuglaws amendments, the first width regression test, and the verification sweep (V1–V3 and the slim collateral list) are explicit steps, not afterthoughts.

#### Success Criteria (Measurable) {#success-criteria}

- `rg -i snippet` in `tugdeck/src`, `tugrust/`, `tugcode/` returns zero hits outside the one migration function that reads legacy `snippets.json` and its test (verify: grep).
- A fresh launch with an existing `snippets.json` and no `jots.json` produces `jots.json` with identical content and leaves `snippets.json` untouched; the Jots card shows the migrated rows (verify: Rust integration test + manual launch).
- Lens and Jots can be pinned on opposite sides simultaneously and on the same side stacked, with the imposition band inset correctly on both sides; the allocator resizes all visible sidebar rails by one equal delta within clamps (verify: `layout-imposer.test.ts` allocator describes + `at0230`/`at0299` descendants).
- A Session card at the slim preset (675px) shows Z2 fully populated — five cells, no ladder rung collapsed — and Z4B's flanking geometry holds (verify: the new width regression app-test).
- ⌘J creates a jot (revealing the card if hidden, focusing the new row's editor), ⌃⌘J toggles the Jots card, ⌃⌘L toggles the Lens; `menus.md` regenerates cleanly via `menus-doc.test.ts` (verify: `at0180`-family + new app-test coverage).
- The collapse chevron, `collapsed` state, and all its special-case branches are gone; old layout blobs with `collapsed: true` deserialize with panes expanded (verify: `layout-tree.test.ts` round-trip + grep for `collapsed`).
- `cargo nextest run` green, `bunx vite build` green, `bun test` green, `just app-test-changed` green at each step boundary.

#### Scope {#scope}

1. Full-depth Snippets → Jots rename: TS model/store/drag, Rust persistence/feed/routes/env, on-disk `jots.json` with startup migration, MIME type, feed label (id `0xA0` kept).
2. `layoutRole: "content" | "sidebar"` on `CardRegistration`; the Jots card (hidden, sidebar, default right); the Lens shrinks to Cards + Layouts sections.
3. Imposition record generalization: `sidebars` map, `contentWidth`, serialization migration, bilateral rails, same-side stacking with a draggable seam, equal-resize allocator.
4. Content width presets slim 675 / comfy 800 / wide 1230; per-pane `widthPreset` stamp; title-bar width popup replacing the removed collapse chevron; deck-wide default in the Layouts section applying immediately.
5. Z2 diet (BTW cell removed, 12px/10px fonts, 16px gaps, ladder recompute, `/btw` placard re-anchored to the strip's top-right) and Z4B diet (Session + Project chips removed on the code route only).
6. Commands `new-jot` ⌘J, `toggle-jots` ⌃⌘J, `toggle-lens` moved ⌥⌘L → ⌃⌘L; unchorded `set-card-width`, `set-content-width`, `set-sidebar-side`.
7. Tuglaws amendments ([D121], [D122], [D110] T01, [D97] diagram, pane-model.md, chord-tiers.md, new taxonomy decision) and the full test-impact sweep from the brief's Part I.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Click actions for the removed Z4B Session/Project chips (explicit follow-up enhancement).
- The third sidebar card (a future feature; the registry-driven Layouts controls make it appear for free when it registers).
- Any compat shim for old builds: cross-build `jots.json`/`snippets.json` divergence during the transition is accepted.
- Jot titles — never, by decision. The row handle remains the incipit (first line).
- Rebalancing sidebar default sides (Jots default right is revisitable later, not here).
- Shell/commit route Z4B changes (those routes keep their chips).

#### Dependencies / Prerequisites {#dependencies}

- The brief `dash/layouts-rework.md` (committed alongside this plan) — the decisions record.
- No pending migrations on `snippets.json`'s format; `SNIPPETS_VERSION` carries over as `JOTS_VERSION` unchanged.

#### Constraints {#constraints}

- **Warnings are errors** in the Rust workspace (`-D warnings`).
- Tuglaws bind all tugdeck work: [L01] one render, [L02] external state via `useSyncExternalStore`, [L03] `useLayoutEffect` for registrations events depend on, [L06] appearance via CSS/DOM, [L09] cards never set geometry, [L19] component authoring guide, [L23] preserve user-visible state, [L25] deck→pane→card, [L30] command funnels. ([L20] is token-scope ownership — cite it only where this plan touches component tokens, not as a "reuse the component" law.)
- No localStorage/IndexedDB — persistence via tugbank `/api/defaults/<domain>/<key>` (jots doc itself stays on its machine-global file + feed, as snippets was).
- App-tests run selectively (`just app-test-changed`); every new/renamed test carries `@covers` lines that resolve (`just app-test-covers-check`).
- Only the user commits on `main`; step commits happen per the implement skill's dash/authorization rules.

#### Assumptions {#assumptions}

- File/symbol references below were confirmed against the tree 2026-08-06; line numbers in the brief are approximate anchors, not contracts — re-locate by symbol name if drifted.
- Feed id `0xA0` can keep its number across the label rename because both ends ship together in one tree.
- `comfy = 800` is the current default width by definition, so a blob without `contentWidth` migrating to `"comfy"` is behavior-preserving.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows `tuglaws/devise-skeleton.md` v4: explicit `{#anchor}` headings, kebab-case, no phase numbers in anchors; stable labels `[P##]`/`[Q##]`/`S##`/`T##`/`L##`/`R##`; `**Depends on:**` lines cite step anchors; `**References:**` lines cite plan artifacts and anchors, never line numbers. Global design decisions are cited as `[D###]` by reference to `tuglaws/design-decisions.md`.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Does the imposition migration need a v5 blob bump? (DECIDED) {#q01-blob-version}

**Question:** The layout blob at tugbank `dev.tugtool.deck.layout/layout` is at v4. Does replacing `{lens, lensPinned}` with `sidebars` (and adding `contentWidth`, dropping `collapsed`) require a version bump?

**Why it matters:** A wrong call either breaks old-blob loads or accretes dead compat branches.

**Resolution:** DECIDED (see [P03]) — stay at v4 with defensive parsing. Precedent: `ImpositionKind` was widened without a bump, and `serialization.ts` already parses imposition defensively. The reader accepts both shapes (`{lens, lensPinned}` legacy → `sidebars: { lens: { side, pinned } }`) and the writer emits only the new shape. `collapsed` and `widthPreset` are additive-optional per the `slot?` precedent.

#### [Q02] Exact `wide` value (DECIDED) {#q02-wide-value}

**Question:** Is `wide = 1230px` final?

**Resolution:** DECIDED — 1230 (comfy × 120/78, rounded). The brief marks it "adjustable taste"; it is a single named constant (`CONTENT_WIDTH_WIDE_PX`), so retuning later is a one-line change. Do not block on it.

#### [Q03] Jots card sizePolicy values (DECIDED) {#q03-jots-sizepolicy}

**Question:** What min/preferred does the Jots card register?

**Resolution:** DECIDED — model on the Lens: `min 320×240`, `preferred 420×900`, tuned at implementation if the transplanted content wants different floors. The reopen-width mechanism ([P11]) is the durable part; the numbers are tunable.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Z2/Z4B don't actually fit at 675 with real faces | high | low | V1–V3 arithmetic pre-verified (~590–625px intrinsic vs ~659px available); ladder rungs recomputed; Z4B levers enumerated | The new width regression test fails |
| Same-side stacking geometry (shared rail, seam, vertical spans) is the phase's largest new mechanism | med | med | Generalizes the existing full-height pin (`top: 5px / bottom: 32px`) to per-member spans; its persistent state (`order` + `sidebarSplit`) is specified up front in Spec S01 rather than discovered mid-build; lands in its own step with imposer + serialization unit tests before the Jots card exists | Allocator or pin tests churn repeatedly |
| The allocator's hardcoded `3·gap` gets copied forward unchanged into the two-rail solve | high | med | Spec S02 states the generalized band identity and mandates deriving the gap count from `resolveSpan`; the `R=1`-reproduces-today's-numbers test catches it immediately | `R=1` allocator numbers move at all |
| Rename sweep misses a reference (TS, Rust, tests, `@covers` lines) | med | med | Grep gates in step checkpoints; `just app-test-covers-check`; the wire layer and TS-internal renames are separate commits so breakage bisects | Any `snippet` grep hit outside the migration path |
| Old-build divergence on the machine-global jots file | low | accepted | Migration copies, never moves; `snippets.json` is left in place and never written again | — (accepted by decision) |
| Collapse removal drops user-visible state from old blobs | low | accepted | Additive-optional drop: panes come back expanded, nothing else lost; [L23] weighed and accepted in the brief | — |

**Risk R01: Slim doesn't fit** {#r01-slim-fit}

- **Risk:** After the diets, real Z2 faces or Z4B's stabilized pickers overflow a 675px card.
- **Mitigation:** Verify with worst-case faces (STATE's longest phase label, TIME `4h 30m 00s`, CONTEXT `1.00M`, Model "Opus 4.8 · 1M"); Z2 levers: per-cell ch budgets before smaller type; Z4B levers: chip padding, identity badge version string, the condensed `.tug-entry-shell-indicators` face.
- **Residual risk:** A future chip or cell addition re-breaks slim silently — which is exactly why the width regression test is a phase deliverable.

**Risk R02: Allocator regression** {#r02-allocator}

- **Risk:** The equal-resize generalization breaks the existing single-Lens behavior (seam residual, clamps, "move nothing on failure").
- **Mitigation:** Step 4 lands the generalized record with Lens as sole occupant and all existing allocator tests green before Step 5 touches the solve; the ≤2px `ALLOCATOR_RESIDUAL_TOLERANCE_PX` acceptance test and the grow/shrink fractions are preserved as written.
- **Residual risk:** Multi-rail solutions have more clamp interactions; the tightest-clamp-per-rail rule in Spec S02 bounds them.

---

### Design Decisions {#design-decisions}

> All restate final decisions from `dash/layouts-rework.md`; none are reopenable here.

#### [P01] Full-depth rename, no shims, feed id kept (DECIDED) {#p01-full-rename}

**Decision:** Snippets → Jots all the way down: files, symbols, `jots.json`, `/api/jots`, `TUG_JOTS_PATH`, feed label `JOTS` **keeping id `0xA0`**, MIME `application/x-tug-jot`, id prefix `jt_` for new jots (old `sn_` ids remain valid — ids are opaque).

**Rationale:** Follows the tugmark precedent — naming debt paid at extraction. Both ends ship together, so the feed number and route can change labels without a compat window.

**Implications:** Startup migration in tugcast: if `jots.json` absent and `snippets.json` present, atomically copy contents to `jots.json`; leave `snippets.json` in place forever, never write it again. Cross-build divergence accepted.

#### [P02] `layoutRole` taxonomy (DECIDED) {#p02-layout-role}

**Decision:** `CardRegistration` gains `layoutRole: "content" | "sidebar"`, default `"content"`. Content cards participate in N-Up slots, ⌘1..⌘N `assign-slot`, and width presets. Sidebar cards (lens, jots) are excluded from slots and presets, and each gets a `{ side, pinned }` entry in the imposition record.

**Rationale:** The taxonomy constrains the layout system; it does not force every card into two boxes — utility cards (settings, keyboard, devtools, gallery, about) stay `"content"` by default.

**Implications:** `assignCardToSlot` refuses sidebar cards; `arrangeCards` skips pinned sidebars; deck invariant #6 generalizes to "at most one pane per sidebar componentId, and it carries no slot".

#### [P03] Sidebars map, defensive migration, no version bump (DECIDED) {#p03-sidebars-map}

**Decision:** `DeckImposition` becomes `{ kind?, contentWidth?, sidebars: { [componentId]: { side: "left" | "right"; pinned?: boolean } } }`. Serialization migrates `{lens, lensPinned}` → `sidebars.lens` defensively at v4; absent `contentWidth` → `"comfy"`.

**Rationale:** Resolves [Q01]; precedent is `kind` widening without a bump; the reader is already defensive.

**Implications:** `findLensPane` generalizes to sidebar-pane selection; `imposeLensStyle` / `--tugx-lens-rail` / `LENS_WIDTH_PROPERTY` become per-sidebar-pane equivalents; `--tug-imposer-inset-left/right` sum each side's rails.

#### [P04] Equal-resize allocator (DECIDED) {#p04-equal-resize}

**Decision:** When imposition steals or grants rail space, the allocator solves for **one delta applied equally to every visible sidebar rail** (not per-card independent solves), clamped per-card by `sizePolicy.min` and the existing grow/shrink fractions, with the ≤2px seam-residual acceptance test preserved — if the fit fails, move nothing.

**Rationale:** User-specified behavior; keeps the allocator's closed-form character and its "never half-apply" discipline.

**Implications:** Same-side stacked cards share one rail width, so the delta applies per rail (one per side) and each rail's delta is bounded by the tightest clamp among its stack members (Spec S02).

#### [P05] Width presets and application semantics (DECIDED) {#p05-width-presets}

**Decision:** slim **675** / comfy **800** / wide **1230**, named exported constants. Presets apply to content-role panes only, through `DeckManager.movePane(paneId, pane.position, { width, height: pane.size.height })` with **no opts** (preserves `slot`). The deck-wide default (Layouts section) applies **immediately to all content panes**, overwriting per-pane deviations and stamping `widthPreset`; the per-pane popup is how you dissent afterward. **Any manual resize clears the pane's `widthPreset`** (no resting lies).

**Rationale:** Presets do not violate [D121]'s "the imposer never sizes" — a command sizes via `movePane`; the imposer passes width through untouched. Overlap at `wide` on dense N-Ups is ordinary geometry per [D121].

**Implications:** The preset applier must clamp to the pane's stack `sizePolicy.min` (e.g. Settings' 720 floor beats slim) because `movePane` does not clamp. Two stale doc comments claiming resize never evicts (`deck-manager.ts` movePane header, `deck-manager-store.ts` header) are wrong — resize does evict — and get fixed in passing.

#### [P06] Collapse removed; popup is a TugPopupMenu ghost trigger (DECIDED) {#p06-collapse-popup}

**Decision:** Window-shade collapse is removed outright (it is pointer-only — no command, chord, or Swift menu item exists). Its title-bar slot is taken by a width popup: **`TugPopupMenu` with a ghost `TugButton` icon trigger**, following the two existing uses in `tug-pane.tsx` itself — explicitly *not* `TugPopupButton`, whose outlined identity clashes with the ghost control cluster.

**Rationale:**
- `tug-pane.tsx` **already composes `TugPopupMenu` twice** with ghost `TugButton` triggers inside `.tug-pane-title-bar-controls`: the stack badge (`subtype="icon-text"`, `emphasis="ghost"`, `<Layers/>`, `data-testid="tug-pane-title-bar-stack-badge"`) and the section menu (`subtype="icon"`, `<MoreHorizontal/>`, `data-testid="tug-pane-title-bar-menu-button"`). Pane chrome using `TugPopupMenu` directly is established in-file practice, and the width control should read as a sibling of those two. Copy their prop shape.
- **Note the header, and don't be derailed by it.** `TugPopupMenu` lives at `components/tugways/internal/tug-popup-menu.tsx` and its docblock says "Internal building block — app code should use TugPopupButton instead." That directive is aimed at *app/card* code; `tug-pane.tsx` is pane chrome and is already one of its two sanctioned composers (the header names `TugPopupButton` and `TugTabBar`; the pane's own uses predate this plan). If the ambiguity bothers the implementer, the honest fix is a one-line amendment to that docblock naming pane chrome as a composer — not routing the width control through `TugPopupButton`.
- **Rejected: the existing `titleBarMenuItems` hook.** `tug-pane.tsx` already accepts a generic `titleBarMenuItems: { id, label, checked?, onSelect }[]` that renders the `MoreHorizontal` overflow popup in the same cluster, and width *could* ride it. It should not: width is a frequently-reached, state-bearing control that wants a persistent affordance showing the current preset, whereas the overflow menu is a grab-bag whose contents are invisible until opened. A dedicated trigger is the discoverable choice. (Named here so an implementer who finds `titleBarMenuItems` knows it was considered and declined.)

**Implications:** Popup shows Slim/Comfy/Wide with a check on `widthPreset` (no check at a custom width); content-role panes only. `at0156`'s exact control set becomes `[width-button, close-button]`. Old blobs' `collapsed: true` deserializes with the field dropped; panes return expanded.

#### [P07] Z2 diet and the strip-anchored `/btw` placard (DECIDED) {#p07-z2-diet}

**Decision:** Remove the BTW cell entirely; values 13px → 12px (`0.8125rem` → `0.75rem`), row font 11px → 10px (`0.6875rem` → `0.625rem`) shrinking all ch-denominated widths and label wings ~9%; labels stay 9px; inter-cell gap and row padding-inline 24px → 16px (`--tug-space-2xl` → `--tug-space-xl`); ch budgets re-tightened; container-query ladder recomputed. The `/btw` answer surface becomes a transient placard popping **from the top of Z2, right-aligned to the host card** — `SideQuestionStore` and the placard body stay; only the anchor changes.

**Rationale:** Post-diet intrinsic ≈ 590px (with gap cut; ~625px without) vs ~659px available at slim — the gap cut is comfort margin, kept unless the tighter rhythm reads badly.

**Amended at implementation (the gap cut is reverted, and the ch budgets grow):** built and looked at, the tighter rhythm *did* read badly — five readings clustered in the middle of a strip with ~110px of unspent width on either side, which reads as damage rather than as an instrument. The gap goes back to `--tug-space-2xl` (24px) and the per-cell ch budgets are raised (17/14/13/18/14, the pre-diet row's proportions) so the row **spends** the slim width: ~644px of a ~673px strip. The type stays at the diet's 12px/10px — the space was bought back in width, where slim had room, rather than in point size, where it did not. The container-query ladder moves with it (645/525/415), and the numbers are pinned by `at0358`.

**Implications:** [D122] amended: the placard is where BTW lives; `/btw` is merely how you ask. The session registration's width-floor rationale comment (which describes four 21ch cells plus sash grips that no longer exist — fiction) is rewritten against the post-diet row.

#### [P08] Z4B diet, code route only (DECIDED) {#p08-z4b-diet}

**Decision:** On the **code route only**, unmount the Session chip (`chrome/session-id-badge.tsx`) and the inline Project chip — both names already live in the pane title bar via `sessionCardTitleOverride`. Shell (identity · Project · Cwd) and commit (Project + Changes) routes keep their chips. Click-action follow-ups deferred.

**Rationale:** Those routes aren't space-challenged; the removed chips were the two most expensive variable faces on the route that is.

**Implications:** [D110] Table T01 amended for the code route only. Z4B has no degradation machinery (no wrap/ellipsis/overflow — only the spacers flex), so fit at 675 is verified, not assumed (V3).

#### [P09] Chord set and registration pattern (DECIDED) {#p09-chords}

**Decision:** `new-jot` = **⌘J** (plain-⌘ tier justified by capture frequency), `toggle-jots` = **⌃⌘J**, `toggle-lens` moves **⌥⌘L → ⌃⌘L** — ⌃⌘⟨letter⟩ becomes the sidebar-toggle grammar. All three verified unbound (⌃⌘ occupancy: A C F H I K M P T). `set-card-width` / `set-content-width` / `set-sidebar-side` are registered actions with payloads, no chords.

**Rationale:** Frequency earns ⌘J its tier; the grammar makes the pair ⌃⌘J/⌃⌘L self-teaching.

**Implications:** Registration follows `show-keyboard-shortcuts` ⌃⌘K exactly: `chord({...}, { preventDefault: true, menuEligible: true })`, Swift menu item constructed with an **empty** key equivalent so the `applyCommandChords` sweep supplies it (avoids the recorded shade-toggle anomaly where a Swift literal makes rebinding silently fail). `chord-tiers.md`'s ⌘J free-pool annotation ("for jump/go-to") is updated in the same change — never silently diverge. `new-jot` reveals the card if hidden and focuses the new row's editor (capture in one gesture), following the ⌃⌘K find-or-create-then-focus shape and joining `DECK_CANVAS_VALIDATED_ACTIONS`.

#### [P10] Same-side stacking shares a rail (DECIDED — amended at implementation) {#p10-stacking}

> **Amended after review of the built app: a shared rail is a stack, not a split.** Two sidebar cards on one side stand **front-to-back**, exactly as two panes sharing a slot do — same pin, same width, same *full* vertical run — and the title bar's stack badge and picker ([D123]) are how you reach the covered one. The split design below shipped first and was wrong in the way that only shows when you look at it: dividing the rail spends a whole rail to show two half-cards, which is what the Snippets section was already doing inside the Lens, only less space-efficient. Lifting Jots out was supposed to give it a full rail when it is the one you are looking at.
>
> What that changes from the text below: `sidebarSplit`, `sidebars[id].order`, the seam and its drag, and `sidebarStackShares` / per-member spans are all **removed, not adjusted** — front-to-back has nothing to remember but each card's side, so the persistent state Spec S01 argued for is gone with it. A legacy blob's `sidebarSplit` and `order` are dropped on read. What survives unchanged: the shared rail width, the allocator's equal-Δ rule ([P04]) and its tightest-member clamp, and the rule that a rail never writes its own width. One thing had to be *added*: rails now hold a z-**band** rather than the single fixed z-index the Lens had, because two rails standing in one place have to be orderable against each other — with one fixed value the covered card is unreachable. Pinned by `at0359`.

**Decision (superseded, kept for the record):** Two sidebar cards on one side share a rail: one shared width, stacked vertically, a draggable seam between them. The existing full-height pin (`top: 5px / bottom: 32px`) generalizes to per-stack-member vertical spans.

**Rationale:** Bilateral simultaneous sidebars are supported; same-side is the *default* configuration (Lens and Jots both default right), so stacking must be first-class, not an edge case.

**Implications:**
- The allocator's equal delta applies to rail widths (one per side); rail clamp = tightest member clamp (Spec S02).
- **The stack carries persistent state**: the seam's split fraction and the members' top/bottom order both survive relaunch, as `sidebarSplit` and `sidebars[id].order` in Spec S01. Since the default deck stacks Lens and Jots on the right, these are visible on first launch — dropping them would be an [L23] violation on the out-of-the-box configuration, not an obscure corner.
- The seam drag changes vertical spans only. It must never write a width: width belongs to the rail, and the rail is the allocator's unknown.

#### [P11] Jots reopen width mirrors the Lens pattern (DECIDED) {#p11-jots-width}

**Decision:** Live width lives in the layout blob (`pane.size.width`); preferred reopen width lives in a per-card store — Lens uses `lensStore.widthPx` at tugbank domain `dev.tugtool.lens/widthPx`; Jots gets `dev.tugtool.jots/widthPx` (or the mechanism generalizes — implementer's choice, but the reopen-width concept must survive).

**Rationale:** [L23] — a hidden-then-shown sidebar returns at its remembered width.

---

### Deep Dives {#deep-dives}

#### Current pinned-Lens machinery (what generalizes) {#lens-machinery}

The entire sidebar concept exists today as a Lens-only special case. The generalization is a promotion, not an invention:

- **Record:** `DeckImposition { kind?: ImpositionKind; lens: LensSide; lensPinned?: boolean }` in `tugdeck/src/lib/layout-imposer.ts` (~line 125).
- **Three geometry modes** (pane-model.md): free (no slot), pinned (hosts Lens, `lensPinned !== false`), imposed (`slot: number`). The "pinned" row's definition changes from "hosts Lens card" to "hosts a sidebar-role card".
- **Selection:** `findLensPane` (`tugdeck/src/lib/deck-store-selectors.ts` ~74) matches `componentId === LENS_CARD_ID`; deck invariant #6 in `layout-tree.ts` `validateDeckState` enforces at-most-one Lens pane with no slot.
- **Band inset:** `resolveSpan` (`layout-imposer.ts` ~370-383) insets the imposition band by the visible rail width + gap; CSS custom properties `--tug-imposer-inset-left/right` are written by `deck-canvas.tsx` (~864-910); `imposeLensStyle` + `--tugx-lens-rail` + `LENS_WIDTH_PROPERTY` carry the rail geometry. Imposition emits `calc()` over custom properties — no ResizeObserver on the deck [L06].
- **Slot math (unchanged):** `offset = k/(N-1) × max(0, band − w)`; one-up special-cased to center (0.5). [D121]: "a slot is a position anchor, not a rect — the imposer places panes and never sizes them."
- **Allocator:** `allocateLensWidth` / `solveLensWidth` / `chainOf` / `worstSeamError` (`layout-imposer.ts` ~591-699): closed-form least-squares band solve; clamps `LENS_FLEX_GROW_FRACTION = 0.35`, `LENS_FLEX_SHRINK_FRACTION = 0.2` of preferred width; acceptance `ALLOCATOR_RESIDUAL_TOLERANCE_PX = 2` — else move nothing. Two trigger moments: a Layouts-section click, and a canvas resize coming to rest (`retuneLensAllocation`).
- **Interactions that carry over per sidebar card:** drag-to-unpin; deck-facing-edge resize keeping the pin (`handleLensResizeStart`, `tug-pane.tsx` ~2210-2345 — the one existing width-change-without-eviction path); the Layouts position control re-pinning.
- **Skips:** `arrangeCards` (`deck-manager.ts` ~1757) skips the pinned Lens; `assignCardToSlot` must refuse sidebar cards.

#### Snippets full-stack inventory (what renames) {#snippets-inventory}

- **TS model** `tugdeck/src/lib/snippets-doc.ts`: `Snippet { id, text }`, `SnippetsDoc`, `SnippetsFrame`, `SNIPPETS_VERSION`, `newSnippetId()` (`sn_` + 12 hex → `jt_`), `snippetIncipit()`, pure transforms, `mergeForeignDoc`, undo stack, `parseSnippetsFrame`.
- **Store** `tugdeck/src/lib/snippets-store.ts`: `SnippetsStore`, `getSnippetsStore()`, `createSnippet(afterId)`, `updateSnippet` (500ms debounce), `deleteSnippet`, `setOrder`, `beginEdit`/`commitEdit` (empty row discarded, coalesced undo), echo suppression via `lastWrittenHash`, foreign-frame merge preserving the open row.
- **Rust:** `tugrust/crates/tugcast/src/snippets.rs` (validate, pretty JSON + trailing newline, SHA-256 hash, atomic temp+rename, 1 MiB cap); `tugrust/crates/tugcast/src/feeds/snippets.rs` (250ms mtime/len poll, 100ms debounce, PUT pulses a `Notify`); `tugcore::instance::snippets_path()` + `TUG_SNIPPETS_PATH` env (`tugrust/crates/tugcore/src/instance.rs`); routes `GET/PUT /api/snippets` (`tugrust/crates/tugcast/src/server.rs` ~913-917); `FeedId::SNIPPETS = 0xA0` + label (`tugrust/crates/tugcast-core/src/protocol.rs` ~147-150; TS mirror `tugdeck/src/protocol.ts` ~62-63). Rust tests: `tugcast/src/integration_tests.rs`, `tugutil/tests/changes_cli.rs`.
- **Drag/insert:** `tugdeck/src/lib/snippet-drag.ts` (`SNIPPET_MIME = "application/x-tug-snippet"` → `application/x-tug-jot`); consumers: `tug-prompt-entry.tsx` (~1255-1305, ~1721-1761), `tug-text-editor/drop-extension.ts` (~86, ~123-129, ~972-987), `code-session-store.ts` `insertSnippet`/`consumePendingSnippetInsert` (~1443-1461), `events.ts` (~437-458), `reducer.ts` (~1394-1410), `pendingSnippetInsert` in `types.ts` (~964-975).
- **Section UI** `tugdeck/src/components/lens/sections/snippets-section.tsx` (1073 lines) + `snippets-data-source.ts` + `snippets-section.css`: display/editor rows (`TugMessageEditor` on the CM6 substrate), Enter/double-click edit, Escape ascends, blur commits, ⌘Return commit+chain, Space creates below cursor, Delete → `TugConfirmPopover`, `useBlockReorder` drag, filter via `filterAndRank`, copy, undo/redo routing. Registered via `registerSnippetsSection()` wired in `main.tsx` (~334-340). The section **rents** Lens band chrome: `LensSection`, `sectionFocusGroup`, `LENS_BAND_FOCUS_ORDER`, the lens filter store — as a card, Jots needs its own filter field, focus-group wiring, `+` affordance, and substrate responder registration (CUT/COPY/PASTE/SELECT_ALL/UNDO/REDO), since it hosts an editing surface. There are no lens-store keys for snippets ordering — nothing to migrate there.

#### Z2 anatomy today (what the diet changes) {#z2-anatomy}

`session-card-telemetry-renderers.tsx`: `SessionTelemetryStatusRow` (~593), cell renders (~1062-1179); `tug-status-cell.tsx/.css`. Six cells STATE/TIME/TOKENS/CONTEXT/WORK/BTW, each `flex: 0 0 auto`, widths in ch on the row's 11px font (`tug-status-cell.css` ~55-79: state 20ch, time 16ch, tokens 14ch, context 20ch, work 16ch, btw 10ch = 96ch). Gaps `--tug-space-2xl` (24px); row `padding-inline` 24px; strip padding 8px. Labels: 9px mono letterspaced with endcap-rule "wings" (`TugStatusCellLabel`, `tug-status-cell.tsx` ~59-79; CSS ~208-303 — 1px hairline fills + 1px×5px end ticks, width-driven by `--tugx-session-status-cell-width`). Values: 13px (`0.8125rem`) bold sans. Container-query ladder (`tug-status-cell.css` ~305-336; container `session-status` = `.session-card-status-bar`, `session-card.css` ~330-333): rungs 520 hide btw / 460 hide time / 290 hide tokens / 200 hide work — tuned for the old row; the ladder comment at `session-card-telemetry-renderers.css` ~105 has drifted from the CSS and gets fixed. The BTW cell's `btwCount` subscription lives at renderers ~703-716. Placard anchoring measures cell centers relative to the status bar (`measureAnchorCenter`, renderers ~624-637) with in-card clamping — the re-anchor targets the strip's top-right; `session-card-telemetry-renderers.css` ~129 bounds placards to the strip. `PLACARD_TITLES.btw = "/btw"` and the placard body (`side-question-overlay.tsx`: annotation context, pendingContextStore "Add to context") carry over unchanged.

**Headroom arithmetic (V1, pre-verified):** post-diet 5 cells = 86ch ≈ 465px at 10px + 4×16 gaps + 32 row padding + 16 strip padding ≈ **~590px intrinsic** vs slim's ~659px content box (675 − strip padding). Without the gap cut: ~625px — still fits; the cut is comfort margin. While in the file, re-tighten per-cell ch budgets to the current widest faces (inline rationale comments name them: TIME `4h 30m 00s` = 10ch content, TOKENS `−208.3K`, etc.).

#### Z4B geometry today (what the diet changes) {#z4b-anatomy}

Z4B = the centered chip cluster in the prompt-entry toolbar: `session-card.tsx` ~4555-4647 `indicatorsContent` → `tug-prompt-entry.tsx` ~3476 `toolbarCenter` → `tug-entry-shell.tsx` ~194-199. Geometry rule ([D97]): two flexible spacers center Z4B between the fixed Z4A route group and Z5 submit. The Session chip is `chrome/session-id-badge.tsx`; the Project chip is inline at `session-card.tsx` ~4052-4077; both names publish to the pane title bar via `sessionCardTitleOverride` (~4014-4050). Remaining code-route cluster: identity badge + Mode + Model + Effort — and the three pickers reserve worst-case widths permanently via `TugStableOverlay` sizers (Mode reserves "Accept Edits"; Model reserves the widest catalog title, e.g. "Opus 4.8 · 1M"). Z4B has **no** degradation machinery. Fit levers if V3 is tight: chip padding, the identity badge's version string, the condensed face on `.tug-entry-shell-indicators` (`PATH_CHIP_MAX_CHARS` is moot on the code route).

#### Collapse removal inventory {#collapse-inventory}

Collapse is pointer-only (verified: no command, no chord, no Swift menu item), so removal is a clean sweep:

- `CardTitleBar` chevron + `handleCollapsePointerDown`/`handleCollapseClick` (`tug-pane.tsx` ~439-577); `onCollapse`/`collapsed` props; `handleFrameCollapseToggle` (~2374); `onCardCollapsed` wiring (`deck-canvas.tsx` ~1374); `togglePaneCollapse` (`deck-manager-store.ts` ~350) / `_togglePaneCollapse` (`deck-manager.ts` ~3526).
- `TugPaneState.collapsed?` (`layout-tree.ts` ~291) and serialization reads (`serialization.ts` ~403-415, ~557-569).
- `imposeStyle(placement, paneWidth, collapsed)` / `imposeLensStyle(..., collapsed)` lose the param (`layout-imposer.ts` ~436-446, ~743-759); `COLLAPSED_FRAME_HEIGHT` (`tug-pane.tsx` ~2361); collapsed frame-height branches (~2369-2434); resize-handle suppression (~2450); chrome class swap (~2470); collapsed special cases in the freeze path (`deck-manager.ts` ~1932) and `assignCardToSlot` (~2048); drag-commit height preservation (`tug-pane.tsx` ~1929-1934).
- CSS: `.tug-pane-chrome--collapsed` (`tug-pane.css` ~233-248, ~273), the collapsed title-bar bg token (~57), the [D07] "turd" rule comment (~175).
- Tests/harness: retire `tests/app-test/at0194-window-shade-collapse.test.ts`; `layout-tree.test.ts` collapsed round-trip describes (~559, ~761); `layout-imposer.test.ts` collapsed pin tests (~326-334, ~392-396); gallery harness `gallery-title-bar.tsx` local collapse demo (~36-150). pane-model.md collapse references (~37-55, 147, 264) and [D97] mentions come out.

---

### Specification {#specification}

**Spec S01: The generalized imposition record** {#s01-imposition-record}

```ts
interface DeckImposition {
  kind?: ImpositionKind;                       // one-up … six-up, unchanged
  contentWidth?: "slim" | "comfy" | "wide";    // deck-wide default; absent → "comfy"
  sidebars: {
    [componentId: string]: {
      side: "left" | "right";
      pinned?: boolean;
      /** Position within its side's stack, ascending from the canvas top.
       *  Absent → append in registration order. Only meaningful when two
       *  sidebar cards share a side. */
      order?: number;
    };
  };
  /** Where the draggable seam sits in a shared rail, as the top member's
   *  fraction of the rail's vertical run (0.5 = even split). Keyed by side.
   *  Absent → 0.5. Persisted because the seam is a user gesture ([L23]). */
  sidebarSplit?: { left?: number; right?: number };
}
```

Reader accepts legacy `{lens, lensPinned}` and maps to `sidebars.lens`; writer emits only the new shape; blob stays v4 ([P03]). `resolveSpan` insets the band by each side's visible rail width + gap; `--tug-imposer-inset-left/right` sum each side's rails.

**`order` and `sidebarSplit` are not optional polish.** Lens and Jots both default to the right side, so a stacked rail is the *out-of-the-box* configuration, not an edge case — the vertical split and the top/bottom order are visible on first launch and are changed by user gestures (seam drag, and re-ordering if offered). Under [L23] both must round-trip the blob. Clamp `sidebarSplit` values to a sane range on read (e.g. `[0.15, 0.85]`) so a corrupt blob cannot produce a zero-height member, and fall back to 0.5 on anything non-finite.

**Spec S02: Equal-resize allocation** {#s02-equal-resize}

This is the phase's most intricate change, so it is specified to the arithmetic. Read `layout-imposer.ts`'s "The space allocator" module note first — the existing closed form and its reasoning are preserved verbatim; only the band identity and the unknown change.

**What the current code assumes.** `solveLensWidth` ends with

```
B* = Σ aⱼ(gap − cⱼ) / Σ aⱼ²
L* = canvasWidth − 3·gap − B*
```

That `3·gap` is hardcoded for **exactly one rail**: the Lens stands one gap off the canvas edge, and the chain is inset one gap at each end of what remains. It is not a general constant, and it is the single most likely thing to be copied forward unchanged and be quietly wrong.

**The generalized band identity.** With `R` = the number of *visible* rails (0, 1, or 2):

```
band = canvasWidth − Σ railWidth − (R + 3)·gap        // R=1 reproduces today's 3·gap + one rail
```

So `R = 0` → `band = canvasWidth − 3·gap` is wrong by one gap versus today's no-Lens path; keep the existing `resolveSpan` behavior as the source of truth (a closed rail contributes neither width nor gap) and derive the gap count from it rather than from this formula, so the numeric twin and the CSS stay in agreement by construction — which is the property the module note says the two halves exist to preserve.

> **Amended after living with the built app: one shared WIDTH, not one shared delta.** Three faults surfaced in use, and the ruling that fixed them replaced this rule. (1) The equal-Δ scheme preserved the *difference* between rails, and its anchors weren't durable — a non-Lens rail's "preferred" width was its live pane width, which is where the allocator writes its own answers, so every solve re-anchored on the last grant and one rail ratcheted wide: the sidebars ended at visibly different widths, which contravenes the tenet that sidebars are a uniform class. Now the solve emits **one width every standing rail takes** (`T / R`, clamped), so unequal rails are unrepresentable, and the shrink anchor reads the card's durable store (`lensStore` / `sidebarWidthStore`), never the live pane. (2) `LENS_FLEX_GROW_FRACTION` is **removed**: a rail may grow to the **slim** content width (675) and no further, whatever Card Width the deck is set to — a rail is a reading surface — carried into the allocator as `maxRailWidth`. Shrinkage keeps the −20% allowance and the tightest-member floor below. (3) `setContentWidth` now ends in the same retune the kind rows run — it was the one Layouts click with no re-solve behind it, which left every seam open after a width change. Acceptance (≤2px worst seam or move nothing) is unchanged.
>
> The text below is the delta-rule as planned, kept for the record.

**The equal-Δ rule ([P04]).** The solve yields a *target total* rail width `T = Σ preferred − (B* − bandAtPreferred)`, i.e. the total the seams want. One delta is shared:

```
Δ = (T − Σ preferredᵢ) / R
railᵢ = preferredᵢ + Δ,  for every visible rail i
```

**Clamping.** Each rail's Δ is bounded by the *tightest* clamp among its stack members:

```
lowᵢ  = max( max over members(sizePolicy.min),
             round(preferredᵢ × (1 − LENS_FLEX_SHRINK_FRACTION)) )
highᵢ = round(preferredᵢ × (1 + LENS_FLEX_GROW_FRACTION))
```

Because the rule is *one shared* Δ, a clamp binding on one rail binds the gesture: recompute `Δ` as the value that satisfies every rail's bounds — `Δ = clamp(Δ, maxᵢ(lowᵢ − preferredᵢ), minᵢ(highᵢ − preferredᵢ))`. If that interval is empty, Δ = 0. Do **not** clamp rails independently; independent clamping is exactly the per-card solve [P04] rules out, and it silently produces unequal deltas.

**Acceptance, unchanged in spirit.** Accept iff `worstSeamError(...) ≤ ALLOCATOR_RESIDUAL_TOLERANCE_PX` (2) at the resulting widths; otherwise **move nothing** — no fallback to preferred, per the module note's "`null` — the Lens does not move" reasoning, which applies unchanged to rails.

**Two signature changes this forces** (both easy to miss):

1. `AllocatorInput` carries scalar `preferredWidth` / `minWidth`. These become **per-rail** (an array or a `{left?, right?}` record). The scalar shape cannot express a two-rail solve.
2. `worstSeamError` builds its span inline as `{ x: 0, width: canvasWidth − (lensWidth + gap), height: 0 }` — it ignores `side` entirely, which is sound for one rail and wrong for two. It must build its span from the generalized `resolveSpan` so the error is measured against the picture the browser will actually paint (the module note is emphatic that this test is asked of the picture, not of the linear form).

Triggers unchanged: a Layouts-section click, and a canvas resize coming to rest (the `retuneLensAllocation` path, renamed). `R = 1` must reproduce today's numbers exactly — that is the regression test.

**Spec S03: Width preset semantics** {#s03-preset-semantics}

Constants `CONTENT_WIDTH_SLIM_PX = 675`, `CONTENT_WIDTH_COMFY_PX = 800`, `CONTENT_WIDTH_WIDE_PX = 1230`, exported beside `IMPOSITION_GAP_PX` (or a sibling module). Applier: resolve preset px → clamp to the pane's stack `sizePolicy.min` → `movePane(paneId, pane.position, { width, height: pane.size.height })` with no opts → stamp `TugPaneState.widthPreset`. Manual resize (any path that isn't the applier) clears `widthPreset`. Deck default (`imposition.contentWidth`) applies immediately to all content panes on change. New content panes resolve `preferred.width` from the deck default at `addCard` time.

**Table T01: Commands added / changed** {#t01-commands}

| Command | Chord | Routing | Notes |
|---|---|---|---|
| `new-jot` | ⌘J | deck-canvas validated action | Reveal Jots card if hidden, create jot, focus row editor |
| `toggle-jots` | ⌃⌘J | deck-canvas validated action | Show/Hide Jots card |
| `toggle-lens` | ⌃⌘L (was ⌥⌘L) | existing | Chord move only |
| `set-card-width` | — | registry with payload `{paneId, preset}` | Per-pane popup (shape of `set-imposition`) |
| `set-content-width` | — | registry with payload `{preset}` | Deck default, Layouts section |
| `set-sidebar-side` | — | registry with payload `{componentId, side}` | Generalizes `set-imposition-lens` |

Registration pattern for the chorded rows: `chord({...}, { preventDefault: true, menuEligible: true })` with an empty Swift key equivalent, per [P09]. New `TUG_ACTIONS` constants; the checklist in `tuglaws/commands.md` "Adding a command" applies verbatim.

**List L01: Registration width changes** {#l01-registration-widths}

- `session-card-registration.tsx`: `min.width` 800 → 675; `preferred.width` resolved from deck default; **rewrite the fictional rationale comment** against the post-diet Z2.
- `text-card-registration.tsx`: `min.width` 800 → 675; preferred from deck default.
- `file-view-card-registration.tsx`: `min.width` 800 → 675; preferred from deck default.
- diff-card and devtools registrations: update comments referencing "the 800 default".
- Keyboard/settings/utility cards: mins unchanged.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| `imposition.sidebars` / `contentWidth` | structure | deck store (layout blob → tugbank `dev.tugtool.deck.layout/layout`), read via `useSyncExternalStore` | [L02] |
| `TugPaneState.widthPreset?` | structure | deck store, serialized additive-optional | [L02] |
| `imposition.sidebarSplit` (seam position) | structure | deck store, serialized; the live drag writes a CSS custom property and commits on pointer-up | [L02], [L06], [L23] |
| `sidebars[id].order` (stack order) | structure | deck store, serialized | [L02], [L23] |
| Rail widths / band insets | appearance | CSS custom properties written by imposition (`--tug-imposer-inset-*`, per-sidebar rail vars), `calc()` styles | [L06] |
| Jots doc + edit state | external data | `JotsStore` (renamed `SnippetsStore`) via `useSyncExternalStore` | [L02] |
| Jots reopen width | preference | per-card store on tugbank `dev.tugtool.jots/widthPx` | [L02], no localStorage |
| Jots filter text | local-data | component `useState` (ephemeral, card-local) | [L24] |
| Width popup open/check | local + derived | `TugPopupMenu` internal; check derived from `widthPreset` | [L19] |
| `/btw` placard visibility | external data | `SideQuestionStore` (unchanged), anchor now strip-derived in CSS/DOM | [L02], [L06] |
| Substrate responders (Jots editors) | registration | `useLayoutEffect` registration | [L03] |

---

### Compatibility / Migration / Rollout {#rollout}

- **On-disk:** tugcast startup: if `jots.json` absent and `snippets.json` present → atomic copy (temp + rename) into `jots.json`; `snippets.json` left in place, never written again. Old builds keep using `snippets.json`; divergence accepted ([P01]).
- **Layout blob:** v4 defensive migration per Spec S01; `collapsed` dropped on read (panes return expanded); `widthPreset` additive-optional.
- **Feed/wire:** id `0xA0` unchanged; label and route rename ship atomically with the frontend in one tree.
- **Rollback:** each step is an independent green commit; reverting a step reverts a coherent slice.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/lib/jots-doc.ts` | renamed `snippets-doc.ts` |
| `tugdeck/src/lib/jots-store.ts` | renamed `snippets-store.ts` |
| `tugdeck/src/lib/jot-drag.ts` | renamed `snippet-drag.ts` |
| `tugdeck/src/components/jots/jots-card.tsx` (+ css) | the Jots card (transplant from `snippets-section.tsx`) |
| `tugdeck/src/components/jots/jots-card-registration.tsx` | registration: hidden, sidebar role, default right |
| `tugrust/crates/tugcast/src/jots.rs` | renamed `snippets.rs` + startup migration fn |
| `tugrust/crates/tugcast/src/feeds/jots.rs` | renamed `feeds/snippets.rs` |
| `tests/app-test/at####-slim-width-regression.test.ts` | the first width regression test (number assigned at implementation) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `layoutRole` | field | `tugdeck/src/card-registry.ts` `CardRegistration` | `"content" \| "sidebar"`, default content |
| `DeckImposition.sidebars` / `.contentWidth` / `.sidebarSplit` | fields | `layout-imposer.ts` | Spec S01; `sidebars[id]` carries `{side, pinned?, order?}` |
| `AllocatorInput.preferredWidth` / `.minWidth` | fields | `layout-imposer.ts` | scalar → per-rail (Spec S02) |
| `worstSeamError` | fn | `layout-imposer.ts` | span must come from generalized `resolveSpan`, not its inline single-rail span (Spec S02) |
| `CONTENT_WIDTH_{SLIM,COMFY,WIDE}_PX` | consts | `layout-imposer.ts` (or sibling) | 675 / 800 / 1230 |
| `TugPaneState.widthPreset?` | field | `layout-tree.ts` | additive-optional |
| `findSidebarPanes` | fn | `deck-store-selectors.ts` | generalizes `findLensPane` |
| `imposeSidebarStyle` | fn | `layout-imposer.ts` | generalizes `imposeLensStyle`; loses `collapsed` param |
| `allocateSidebarWidths` / `solveSidebarWidths` | fns | `layout-imposer.ts` | generalize `allocateLensWidth`/`solveLensWidth` per Spec S02 |
| `jots_path()` / `TUG_JOTS_PATH` | fn/env | `tugrust/crates/tugcore/src/instance.rs` | renamed |
| `FeedId::JOTS` | const | `tugcast-core/src/protocol.rs` + `tugdeck/src/protocol.ts` | keeps `0xA0` |
| `JOT_MIME` | const | `jot-drag.ts` | `application/x-tug-jot` |
| `newJotId()` | fn | `jots-doc.ts` | `jt_` + 12 hex |
| `TUG_ACTIONS.NEW_JOT` / `TOGGLE_JOTS` / `SET_CARD_WIDTH` / `SET_CONTENT_WIDTH` / `SET_SIDEBAR_SIDE` | consts | `command-registry.ts` / `action-dispatch.ts` | Table T01 |

---

### Documentation Plan {#documentation-plan}

- [ ] [D121] amended (sidebar generalization + presets note: "presets are applied by a command through `movePane`; the imposer still passes width through untouched").
- [ ] [D122] amended (`/btw` surface = strip-anchored placard).
- [ ] [D110] Table T01 amended (code route loses Session + Project).
- [ ] [D97] zone diagram fixed (stale `[grip] … [maximize]` flanks and cell count; row changes again here).
- [ ] New global design decision: content/sidebar taxonomy + width presets + equal-resize rule.
- [ ] `pane-model.md`: collapse references removed; pinned row generalized; invariant #6 generalized.
- [ ] `chord-tiers.md`: ⌘J free-pool annotation updated; Show Lens move recorded. `menus.md` regenerates via `menus-doc.test.ts`.
- [ ] `tuglaws/app-test-inventory.md` prose updated for renamed/retired tests.
- [ ] Free fix: `--tug-font-family-base` referenced in `tugx-block.css` (~192) and `body-kinds/commit-block.css` (~27) but defined in no theme (silent invalid-var → inherit) — define it or repoint the two rules.
- [ ] Optional, if the ambiguity bit during #step-8: amend `internal/tug-popup-menu.tsx`'s docblock to name **pane chrome** alongside `TugPopupButton` and `TugTabBar` as a sanctioned composer, so its "app code should use TugPopupButton instead" line stops reading as a prohibition on the two uses already in `tug-pane.tsx` ([P06]).

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** | doc/store transforms, imposer math, allocator solves, serialization migration | every lib change |
| **Integration (Rust)** | migration copy, feed poll/PUT, route rename | `cargo nextest run` |
| **App-test** | real gestures on the real app: card behavior, chords, geometry | renamed + updated per the brief's Part I; selected via `just app-test-changed` |
| **Drift Prevention** | `command-routing-drift.test.ts` chord table, `menus-doc.test.ts` regeneration, the new width regression test | commands + slim fit |

Key app-test impact (from the brief, Part I): rename sweep re-targets `at0241`, `at0245`, `at0254`, `at0255`, `at0290`, `at9997` from Lens rows to the Jots card with resolving `@covers`; Lens-structure tests assuming three sections (`at0266`, `at0341`, `at0297`, `at0351`, `at0248`, `at0256`, `at0277`, `at0282`, `at0296`); sidebar tests (`at0276`, `at0230`, `at0299`, `at0231` — chord moves to ⌃⌘L, `at0247`); collapse (retire `at0194`; update `at0156`); Z2/Z4B (`at0211` re-anchor, `at0140` cycle order loses Z2_BTW + chips, `at0196` rework-or-retire, `at0215` re-verify flanking at 675, plus `at0192`, `at0206`, `at0219`, `at0220`, `at0084`, `at0157`, `at0162`, `at0197`); commands (`command-registry.test.ts`, `command-routing-drift.test.ts`, `menus-doc.test.ts`, `at0180`/`at0181`/`at0182`). Unit renames: `snippets-doc.test.ts`, `snippets-store.test.ts`, `snippets-data-source.test.ts`, `code-session-store.snippet-insert.test.ts`.

#### What stays out of tests {#test-non-goals}

- jsdom render tests and mock-store assertion tests — banned patterns; behavior is covered by app-tests driving the real app.
- Cross-build `snippets.json`/`jots.json` divergence — accepted by decision, not testable in one tree.
- Same-side seam drag ergonomics beyond geometry assertions — visual polish is eyeballed, not asserted.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass** — applies to every step. TS steps additionally verify with `bunx vite build` (the debug app loads the prod rollup bundle). App-test selection is always `just app-test-changed` unless a step names files.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Wire-layer rename: Rust, routes, feed, file, migration | done | `2af21235e` |
| #step-2 | TS-internal rename: files, symbols, MIME | done | `14254bcd6` |
| #step-3 | `layoutRole` taxonomy on CardRegistration | done | `e726e5eef` |
| #step-4 | Imposition record generalization (Lens parity) | done | `ce7743530` |
| #step-5 | Bilateral sidebars, stacking, equal-resize allocator | done | `fdabb0613` |
| #step-6 | The Jots card; Lens shrinks to two sections | done | `c55b253be` |
| #step-7 | Commands: ⌘J, ⌃⌘J, ⌃⌘L move | done | `66ecd1fc1` (landed with the at0278 repair round) |
| #step-8 | Collapse removal + width popup + `widthPreset` | done | `346145e58` |
| #step-9 | Z2 diet + strip-anchored `/btw` placard | done | `a5f8a3c7b` |
| #step-10 | Z4B diet (code route) | done | `0eb7c8429` |
| #step-11 | Slim floors, deck default width, Layouts section | done | `572260369` |
| #step-12 | Doctrine updates + font-family-base fix | done | `d76499ff3` |
| #step-13 | Width regression test + slim collateral sweep | done | `9333c88e3` |
| #step-14 | Integration checkpoint | done | verification only (no commit); see #step-14-record |

#### Step 1: Wire-layer rename — Rust, routes, feed, file, migration {#step-1}

**Commit:** `tugcast(jots): rename snippets wire layer to jots — jots.json + migration, /api/jots, JOTS feed label, TUG_JOTS_PATH`

**References:** [P01] Full-depth rename, (#snippets-inventory, #rollout)

**Artifacts:** `tugcast/src/jots.rs`, `tugcast/src/feeds/jots.rs`, `jots_path()`, `TUG_JOTS_PATH`, `/api/jots` routes, `FeedId::JOTS` (0xA0) + labels both ends, startup migration, TS wire touchpoints repointed.

**Tasks:**
- [ ] `git mv` `tugrust/crates/tugcast/src/snippets.rs` → `jots.rs` and `feeds/snippets.rs` → `feeds/jots.rs`; rename all module symbols; preserve behavior exactly (validate, pretty JSON + newline, SHA-256, atomic temp+rename, 1 MiB cap; 250ms poll, 100ms debounce, PUT pulses `Notify`).
- [ ] `tugcore::instance`: `snippets_path()` → `jots_path()` returning `<data dir>/Tug/jots.json`; env override `TUG_SNIPPETS_PATH` → `TUG_JOTS_PATH`.
- [ ] Startup migration in tugcast init: if `jots.json` absent and `snippets.json` present, atomically copy contents into `jots.json`; never write `snippets.json` again; leave it in place.
- [ ] `server.rs`: routes `GET/PUT /api/snippets` → `/api/jots`.
- [ ] `tugcast-core/src/protocol.rs`: `FeedId::SNIPPETS` → `FeedId::JOTS`, **value stays `0xA0`**, label string updated; mirror in `tugdeck/src/protocol.ts`.
- [ ] Repoint the TS wire touchpoints only (fetch URLs in `snippets-store.ts`, feed name in `protocol.ts`) — internal TS symbol names stay `snippet*` until #step-2.
- [ ] Update Rust tests (`tugcast/src/integration_tests.rs`, `tugutil/tests/changes_cli.rs`) and add a migration test: seeded `snippets.json`, no `jots.json` → identical `jots.json`, source untouched; second launch does not re-copy.

**Tests:**
- [ ] Migration integration test (above).
- [ ] Feed test still green under the renamed module (poll + PUT notify path).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run`
- [ ] `rg -i snippet tugrust/` returns only the migration function + its test
- [ ] `bunx vite build` (wire touchpoints compile)

---

#### Step 2: TS-internal rename — files, symbols, MIME {#step-2}

**Depends on:** #step-1

**Commit:** `tugdeck(jots): rename snippets model/store/drag to jots — jt_ ids, x-tug-jot MIME`

**References:** [P01] Full-depth rename, (#snippets-inventory)

**Artifacts:** `jots-doc.ts`, `jots-store.ts`, `jot-drag.ts`; all consumer call-sites renamed; unit tests renamed.

**Tasks:**
- [ ] `git mv` `snippets-doc.ts` → `jots-doc.ts`, `snippets-store.ts` → `jots-store.ts`, `snippet-drag.ts` → `jot-drag.ts`; rename every symbol (`Snippet`→`Jot`, `SnippetsDoc`→`JotsDoc`, `SnippetsStore`→`JotsStore`, `getSnippetsStore`→`getJotsStore`, `createSnippet`→`createJot`, `snippetIncipit`→`jotIncipit`, `SNIPPETS_VERSION`→`JOTS_VERSION`, `parseSnippetsFrame`→`parseJotsFrame`, etc.). Behavior identical.
- [ ] `newSnippetId()` → `newJotId()` emitting `jt_` + 12 hex; old `sn_` ids remain valid (ids are opaque — no migration of existing ids).
- [ ] `SNIPPET_MIME` → `JOT_MIME = "application/x-tug-jot"`; rename drag/insert plumbing across `tug-prompt-entry.tsx`, `tug-text-editor/drop-extension.ts`, `code-session-store.ts` (`insertSnippet`→`insertJot`, `consumePendingSnippetInsert`→`consumePendingJotInsert`), `events.ts`, `reducer.ts`, `types.ts` (`pendingSnippetInsert`→`pendingJotInsert`).
- [ ] Rename unit tests: `snippets-doc.test.ts`→`jots-doc.test.ts`, `snippets-store.test.ts`→`jots-store.test.ts`, `code-session-store.snippet-insert.test.ts`→`…jot-insert.test.ts` (`snippets-data-source` renames in #step-6 with the section transplant).

**Tests:**
- [ ] Renamed unit suites green with identical assertions.

**Checkpoint:**
- [ ] `bun test` (tugdeck)
- [ ] `bunx vite build`
- [ ] `rg -i snippet tugdeck/src --glob '!components/lens/sections/*'` returns zero hits (the Lens section renames in #step-6)

---

#### Step 3: `layoutRole` taxonomy on CardRegistration {#step-3}

**Depends on:** #step-2

**Commit:** `tugdeck(layout): add layoutRole content|sidebar to CardRegistration; lens declares sidebar`

**References:** [P02] layoutRole taxonomy, (#lens-machinery)

**Artifacts:** `layoutRole` field; Lens registration declares `"sidebar"`; slot guards.

**Tasks:**
- [ ] Add `layoutRole?: "content" | "sidebar"` (resolved default `"content"`) to `CardRegistration` in `tugdeck/src/card-registry.ts`; expose a resolved accessor.
- [ ] Lens registration declares `layoutRole: "sidebar"`. All other registrations untouched (utility cards stay content by default).
- [ ] `assignCardToSlot` (`deck-manager.ts`) refuses sidebar-role cards; ⌘1..⌘N `assign-slot` validity excludes them.

**Tests:**
- [ ] Unit: registry default resolution; `assignCardToSlot` refusal for a sidebar-role card.

**Checkpoint:**
- [ ] `bun test` && `bunx vite build`
- [ ] `just app-test-changed`

---

#### Step 4: Imposition record generalization (Lens parity) {#step-4}

**Depends on:** #step-3

**Commit:** `tugdeck(imposer): generalize DeckImposition to a sidebars map; migrate lens/lensPinned; per-sidebar styles`

**References:** [P03] Sidebars map, Spec S01, [Q01], (#lens-machinery)

**Artifacts:** Spec S01 record with Lens as sole occupant; serialization migration; generalized selectors/invariants/styles. **Pure parity — no new behavior.**

**Tasks:**
- [ ] Replace `DeckImposition {kind?, lens, lensPinned?}` with Spec S01's shape in `layout-imposer.ts`.
- [ ] `serialization.ts` imposition parse: accept legacy `{lens, lensPinned}` → `sidebars: { lens: { side, pinned } }`; absent `contentWidth` → `"comfy"`; writer emits new shape only; stay v4 defensive per [P03].
- [ ] `findLensPane` (`deck-store-selectors.ts`) → `findSidebarPanes` (panes hosting sidebar-role cards); keep a thin lens-specific helper where call-sites want one.
- [ ] Deck invariant #6 (`layout-tree.ts` `validateDeckState`): "at most one pane per sidebar componentId, and it carries no slot".
- [ ] `imposeLensStyle`/`--tugx-lens-rail`/`LENS_WIDTH_PROPERTY` → per-sidebar-pane equivalents (`imposeSidebarStyle`, per-componentId rail vars); `deck-canvas.tsx`'s `--tug-imposer-inset-left/right` writes sum each side's rails (one rail per side at this step).
- [ ] **Preserve `LENS_WIDTH_PROPERTY`'s deliberate design when generalizing it.** It is *unregistered* on purpose, and every expression that reads it supplies the React-known width as the `var()` fallback, so a frame rendering before the property is written lands on exactly the geometry it would have had. A registered property has an initial value instead of an absence and the fallback would never be reached. Per-pane properties must keep both properties: unregistered, always with a fallback. (`--tugx-lens-rail` *is* registered as a `<number>` in `tug-pane.css` so its expression can compute with it — that one stays registered.)
- [ ] `resolveSpan` insets by each side's visible rail width + gap (left and right both honored, even though only Lens occupies one).
- [ ] Rename the allocator entry points (`allocateLensWidth`→`allocateSidebarWidths`, `retuneLensAllocation`→generalized name) without changing the solve; `arrangeCards` skips pinned sidebar panes (was: pinned Lens).
- [ ] Carry over per-sidebar: drag-to-unpin, deck-facing-edge resize keeping the pin (`handleLensResizeStart` generalized), Layouts re-pinning (control itself updates in #step-11).

**Tests:**
- [ ] `serialization` unit: legacy blob → migrated record; new blob round-trips.
- [ ] `layout-imposer.test.ts` lens-style + allocator describes green under new names (assertions unchanged).
- [ ] `layout-tree.test.ts` invariant tests updated to the generalized wording.

**Checkpoint:**
- [ ] `bun test` && `bunx vite build`
- [ ] `just app-test-changed` (expect `at0230`, `at0276`, `at0299`, `at0247` in the selection, all green — parity proof)

---

#### Step 5: Bilateral sidebars, same-side stacking, equal-resize allocator {#step-5}

**Depends on:** #step-4

**Commit:** `tugdeck(imposer): bilateral sidebar rails, same-side stacks with draggable seam, equal-resize allocation`

**References:** [P04] Equal-resize, [P10] Stacking, Spec S02, Risk R02, (#lens-machinery)

**Artifacts:** Two simultaneous rails; shared-rail stacks with per-member vertical spans + seam; Spec S02 solve.

**Tasks:**
- [ ] Support sidebar entries on both sides at once: `resolveSpan` and the inset custom properties handle left+right rails simultaneously. Derive the gap count from `resolveSpan` (a closed rail contributes neither width nor gap) so the numeric twin and the CSS agree by construction — see Spec S02's warning about the hardcoded `3·gap`.
- [ ] Same-side stacking: members share one rail width; the full-height pin (`top: 5px / bottom: 32px`) generalizes to per-stack-member vertical spans computed from `sidebarSplit[side]`; a draggable seam between members adjusts the split (vertical-span change only — never a width change).
- [ ] Persist the stack per Spec S01: `sidebars[id].order` and `imposition.sidebarSplit`, written through the deck store and serialized; read clamps the split to `[0.15, 0.85]` and falls back to 0.5 on anything non-finite. The live drag may write a CSS custom property for smoothness, but the commit lands on pointer-up ([L06] for the drag, [L02] for the commit).
- [ ] Implement Spec S02 in `solveSidebarWidths`: one shared Δ across visible rails, clamped by the intersection of every rail's bounds (**never** per-rail independently); `AllocatorInput`'s scalar `preferredWidth`/`minWidth` become per-rail; `worstSeamError` builds its span from the generalized `resolveSpan` instead of its current inline single-rail span. Preserve `LENS_FLEX_GROW_FRACTION`/`LENS_FLEX_SHRINK_FRACTION`/`ALLOCATOR_RESIDUAL_TOLERANCE_PX` semantics and the move-nothing failure mode; both trigger moments unchanged.

**Tests:**
- [ ] Imposer unit: bilateral insets (gap count correct at R=0/1/2); stack span math from `sidebarSplit`; seam-drag split invariants (rail width untouched).
- [ ] Serialization unit: `order` + `sidebarSplit` round-trip; out-of-range and non-finite splits clamp/fall back on read.
- [ ] Allocator unit: **R=1 reproduces today's numbers exactly** (the regression guard); equal-Δ across two rails; a clamp binding on one rail bounds the shared Δ rather than desyncing the rails; residual-failure → no movement.

**Checkpoint:**
- [ ] `bun test` && `bunx vite build`
- [ ] `just app-test-changed`

---

#### Step 6: The Jots card; Lens shrinks to two sections {#step-6}

**Depends on:** #step-5

**Commit:** `tugdeck(jots): lift snippets section into the Jots sidebar card; Lens = Cards + Layouts`

**References:** [P01], [P02], [P11] Reopen width, [Q03], (#snippets-inventory, #state-zone-mapping)

**Artifacts:** `components/jots/jots-card.tsx` (+css), `jots-card-registration.tsx`; `snippets-section.tsx`/`snippets-data-source.ts`/`snippets-section.css` deleted; `registerSnippetsSection()` + its `main.tsx` wiring removed.

**Tasks:**
- [ ] Register componentId `"jots"`: `hidden: true` (out of the `[+]` picker, like lens/keyboard), `layoutRole: "sidebar"`, sizePolicy `min 320×240` / `preferred 420×900` ([Q03]), default side **right** in `imposition.sidebars` on first show.
- [ ] Transplant the section's content: display/editor rows (`TugMessageEditor` on the CM6 substrate), the full edit grammar (Enter/double-click edit, Escape ascends, blur commits, ⌘Return commit+chain, Space creates below cursor, Delete → `TugConfirmPopover`), `useBlockReorder` drag, `filterAndRank` filtering, copy, undo/redo routing — against the renamed `JotsStore`. Rename `snippets-data-source.ts` → `jots-data-source.ts` in the move.
- [ ] Replace rented Lens chrome (`LensSection`, `sectionFocusGroup`, `LENS_BAND_FOCUS_ORDER`, lens filter store) with card-level equivalents: own filter field (local `useState`), own focus-group wiring, own `+` affordance.
- [ ] Register substrate responders CUT/COPY/PASTE/SELECT_ALL/UNDO/REDO (`useLayoutEffect` [L03]) — the card hosts an editing surface.
- [ ] Reopen width per [P11]: `dev.tugtool.jots/widthPx` (or generalize the Lens mechanism).
- [ ] Remove the Lens section: delete `registerSnippetsSection()` + `main.tsx` wiring; Lens renders Cards + Layouts only. No lens-store ordering keys exist — nothing to migrate.
- [ ] Re-target the section app-tests to the card (`at0241`, `at0245`, `at0254`, `at0255`, `at0290`, `at9997`) with `@covers` lines resolving to the new paths; update the Lens-structure suites that assumed three sections (`at0266`, `at0341`, `at0297`, `at0351`, `at0248`, `at0256`, `at0277`, `at0282`, `at0296`).

**Tests:**
- [ ] Renamed `jots-data-source.test.ts` green.
- [ ] Re-targeted app-tests green.

**Checkpoint:**
- [ ] `bun test` && `bunx vite build`
- [ ] `just app-test-covers-check`
- [ ] `just app-test-changed`
- [ ] `rg -i snippet tugdeck/ tests/` returns zero hits

---

#### Step 7: Commands — ⌘J new-jot, ⌃⌘J toggle-jots, ⌃⌘L toggle-lens {#step-7}

**Depends on:** #step-6

**Commit:** `tugdeck(commands): ⌘J new-jot, ⌃⌘J toggle-jots; Show Lens moves ⌥⌘L→⌃⌘L`

**References:** [P09] Chords, Table T01, (#t01-commands)

**Artifacts:** Three chord registrations; `TUG_ACTIONS` constants; regenerated `menus.md`.

**Tasks:**
- [ ] Register `new-jot` (⌘J) and `toggle-jots` (⌃⌘J) following the `show-keyboard-shortcuts` ⌃⌘K pattern in `command-registry.ts`: `chord({...}, { preventDefault: true, menuEligible: true })`; Swift menu items with **empty** key equivalents so `applyCommandChords` supplies them ([P09]).
- [ ] `new-jot` handler in `deck-canvas.tsx` follows the ⌃⌘K find-or-create-then-focus shape: reveal Jots if hidden → `createJot` → focus the new row's editor; joins `DECK_CANVAS_VALIDATED_ACTIONS`. `toggle-jots` mirrors the Lens toggle.
- [ ] Move `toggle-lens` ⌥⌘L → ⌃⌘L (registry chord + any Swift mirror).
- [ ] Follow `tuglaws/commands.md` "Adding a command" checklist verbatim; update `chord-tiers.md` (⌘J free-pool annotation; Show Lens move) in this commit.
- [ ] Update `command-routing-drift.test.ts`'s explicit chord→command table; `menus-doc.test.ts` regenerates `menus.md`; update `at0231` (Lens toggle chord), `at0180`/`at0181`/`at0182` as selected.

**Tests:**
- [ ] `command-registry.test.ts`, `command-routing-drift.test.ts`, `menus-doc.test.ts` green.
- [ ] App-test: ⌘J from a hidden-Jots deck creates + reveals + focuses (extend a re-targeted jots suite or add coverage in the `at0241` descendant).

**Checkpoint:**
- [ ] `bun test` && `bunx vite build`
- [ ] `just app-test-changed`

---

#### Step 8: Collapse removal + the width popup + `widthPreset` {#step-8}

**Depends on:** #step-3, #step-4

<!-- #step-4 is a real dependency, not bookkeeping: this step strips the `collapsed`
     parameter from `imposeSidebarStyle`, which does not exist until #step-4 renames
     `imposeLensStyle`. Running Step 8 first would mean editing the old symbol and
     re-editing it in Step 4. -->


**Commit:** `tugdeck(pane): remove window-shade collapse; title-bar width popup with slim/comfy/wide presets`

**References:** [P05] Presets, [P06] Collapse/popup, Spec S03, (#collapse-inventory)

**Artifacts:** Collapse machinery deleted per #collapse-inventory; `CONTENT_WIDTH_*_PX` constants; `TugPaneState.widthPreset?`; `set-card-width` action; the popup control.

**Tasks:**
- [ ] Sweep the entire #collapse-inventory: chevron + handlers, props, `handleFrameCollapseToggle`, `onCardCollapsed`, `togglePaneCollapse`/`_togglePaneCollapse`, `TugPaneState.collapsed?` + serialization reads (dropped on read — panes return expanded), the `collapsed` params on `imposeStyle`/`imposeSidebarStyle`, `COLLAPSED_FRAME_HEIGHT` + branches + resize-handle suppression + chrome class swap, freeze-path and `assignCardToSlot` special cases, drag-commit height preservation, all CSS blocks + the collapsed bg token + the [D07] comment.
- [ ] Add `CONTENT_WIDTH_SLIM_PX = 675` / `COMFY = 800` / `WIDE = 1230` beside `IMPOSITION_GAP_PX`.
- [ ] Add `widthPreset?: "slim" | "comfy" | "wide"` to `TugPaneState` (additive-optional, `slot?` precedent); every manual-resize path clears it.
- [ ] Register `set-card-width` (registry routing with `{paneId, preset}` payload, shape of `set-imposition`); handler per Spec S03: clamp to stack `sizePolicy.min` → `movePane` width-only no-opts → stamp `widthPreset`.
- [ ] Build the popup: `TugPopupMenu`, ghost icon trigger cloned from the stack-badge pattern in `tug-pane.tsx`, sitting in `.tug-pane-title-bar-controls` beside the stack badge, close pinned trailing; items Slim/Comfy/Wide, check from `widthPreset`; rendered on content-role panes only.
- [ ] Fix the two stale never-evicts comments (`deck-manager.ts` movePane header, `deck-manager-store.ts` header) — resize does evict.
- [ ] Tests/harness: retire `at0194`; `at0156` control set → `[width-button, close-button]`; `layout-tree.test.ts` collapsed round-trips; `layout-imposer.test.ts` collapsed pin tests; `gallery-title-bar.tsx` swaps the collapse demo for the width control.

**Tests:**
- [ ] Unit: old blob with `collapsed: true` deserializes expanded; `widthPreset` round-trips; manual resize clears it; preset applier clamps (Settings' 720 floor beats slim) and preserves `slot`.
- [ ] App-test: `at0156` updated set green.

**Checkpoint:**
- [ ] `bun test` && `bunx vite build`
- [ ] `rg -w collapsed tugdeck/src/lib tugdeck/src/components --glob '*.ts*'` shows no pane-collapse hits
- [ ] `just app-test-changed`

---

#### Step 9: Z2 diet + strip-anchored `/btw` placard {#step-9}

<!-- No dependencies: the Z2 diet touches only Session-card chrome and is independent
     of the rename and the layout work. It is ordered here because #step-11 cannot drop
     the width floor to 675 until this and #step-10 have landed — but it may be built in
     parallel with steps 1-8 if convenient. -->

**Commit:** `tugways(session): Z2 diet — drop BTW cell, 12px/10px type, 16px gaps, recomputed ladder; /btw placard pops from the strip`

**References:** [P07] Z2 diet, Risk R01, (#z2-anatomy)

**Artifacts:** Five-cell Z2; recomputed ladder; strip-anchored placard; rewritten registration rationale comment (comment only — the min value changes in #step-11).

**Tasks:**
- [ ] Remove the BTW cell: render branch, `btwCount` subscription, 10ch width rule, its ladder rung. `SideQuestionStore` + placard body stay.
- [ ] Re-anchor: `openSideQuestions()` → `showPlacard("btw")` retargets from cell-anchored (`measureAnchorCenter`) to the strip's top-right, right-aligned to the host card, with the existing in-card clamping; `PLACARD_TITLES.btw = "/btw"` carries over.
- [ ] Type: values `0.8125rem` → `0.75rem`; row font `0.6875rem` → `0.625rem` (shrinks ch widths + wings ~9%); labels stay `0.5625rem`.
- [ ] Space: inter-cell gap + row padding-inline `--tug-space-2xl` → `--tug-space-xl`.
- [ ] Re-tighten per-cell ch budgets to the widest real faces (the inline rationale comments name them); verify V1 with real faces (STATE's longest phase label, TIME `4h 30m 00s`, CONTEXT `1.00M`) — if a face doesn't fit, tighten ch budgets before touching type (V2).
- [ ] **Re-derive the ch budgets by measurement, not by scaling.** The cell width is `ch` resolved against the *row's* font (11px → 10px), while the value inside renders at 13px → 12px in a *different* face (bold sans). Two fonts shrinking at two rates: the "~9% proportional" figure describes the cell box, and tells you nothing about whether the content still fits it. Measure each widest face in the built app at the new sizes and set each cell's ch from that; do not scale the current numbers.
- [ ] Recompute the container-query ladder so degradation starts just above the new intrinsic width (time collapses first); fix the drifted ladder comment in `session-card-telemetry-renderers.css`.
- [ ] Rewrite the session registration's width-floor rationale comment against the post-diet row (value change deferred to #step-11).
- [ ] Update app-tests: `at0211` (placard re-anchor), `at0140` (cycle order loses Z2_BTW; constants near the file top), plus `at0192`/`at0206`/`at0219`/`at0220`/`at0084`/`at0157`/`at0162`/`at0197` as selected.

**Tests:**
- [ ] `at0211` green against the strip anchor; `at0140` green with the shortened cycle.

**Checkpoint:**
- [ ] `bunx vite build`
- [ ] `just app-test-changed`
- [ ] Manual: `/btw` placard pops from the strip's top-right; five cells fully visible at an 800 card

---

#### Step 10: Z4B diet (code route) {#step-10}

**Depends on:** #step-9

**Commit:** `tugways(session): Z4B diet — drop Session and Project chips on the code route`

**References:** [P08] Z4B diet, Risk R01, (#z4b-anatomy)

**Artifacts:** Code-route Z4B = identity + Mode + Model + Effort; shell/commit routes untouched.

**Tasks:**
- [ ] On the code route only, unmount `chrome/session-id-badge.tsx` and the inline Project chip from `indicatorsContent` in `session-card.tsx` (both names remain in the title bar via `sessionCardTitleOverride` — untouched).
- [ ] Leave shell (identity · Project · Cwd) and commit (Project + Changes) clusters exactly as they are.
- [ ] Update app-tests: `at0196` (session-id-badge selectors — rework or retire), `at0215` (T01 manifest + flanking geometry), `at0140` (cycle loses the chips) and others as selected.

**Tests:**
- [ ] `at0215` green on the amended manifest; `at0196` resolved.

**Checkpoint:**
- [ ] `bunx vite build`
- [ ] `just app-test-changed`

---

#### Step 11: Slim floors, deck default width, the Layouts section {#step-11}

**Depends on:** #step-8, #step-9, #step-10, #step-5

**Commit:** `tugdeck(layout): 675 content floors, deck-wide contentWidth default, Layouts = N-Up + Card Width + Sidebar positions`

**References:** [P05] Presets, Spec S03, List L01, Table T01, (#s03-preset-semantics)

**Artifacts:** List L01 registration changes; `set-content-width` + `set-sidebar-side` actions; the three-group Layouts section; extended miniatures.

**Tasks:**
- [ ] Apply List L01: session/text/file-view `min.width` → 675; `preferred.width` resolved from `imposition.contentWidth` at `addCard` time; comment updates in diff-card/devtools registrations; the session rationale comment (rewritten in #step-9) now states the real 675 derivation.
- [ ] Register `set-content-width` (`{preset}`): writes `imposition.contentWidth` and immediately applies to **all content panes** via the Spec S03 applier (overwriting per-pane deviations, stamping `widthPreset`).
- [ ] Generalize `set-imposition-lens` → `set-sidebar-side` (`{componentId, side}`).
- [ ] Layouts section (`components/lens/sections/layouts-section.tsx`) grows to three `TugRadioGroup emphasis="tile"` groups: **Cards** (N-Up, unchanged), **Card Width** (Slim/Comfy/Wide → `set-content-width`), **Sidebar positions** (registry-driven, one Left/Right control per registered sidebar card — Lens, Jots; a future third appears for free).
- [ ] Extend `LayoutMiniature` (`layout-miniature.tsx`, `RAIL_PCT = 18`): rails on both sides, stacked same-side cards, width miniatures at scale.
- [ ] Update imposer/serialization tests for `contentWidth` application; `at0276` (side persistence via the generalized action).

**Tests:**
- [ ] Unit: deck-default change restamps all content panes; new-card preferred width follows the default; sidebar panes excluded from preset application.
- [ ] App-test: Layouts controls drive side + width live.

**Checkpoint:**
- [ ] `bun test` && `bunx vite build`
- [ ] `just app-test-changed`

---

#### Step 12: Doctrine updates + font-family-base fix {#step-12}

**Depends on:** #step-11, #step-7

**Commit:** `tuglaws(layout): amend D121/D122/D110/D97, generalize pane-model, add the sidebar taxonomy decision`

**References:** [P02], [P04], [P05], [P07], [P08], [P09], (#documentation-plan)

**Artifacts:** Every item in #documentation-plan.

**Tasks:**
- [ ] Work through #documentation-plan verbatim: [D121] (sidebar generalization + presets note), [D122] (placard surface), [D110] T01 (code route), [D97] diagram, the new global taxonomy decision, `pane-model.md` (collapse out, pinned row + invariant #6 generalized), `app-test-inventory.md` prose.
- [ ] `chord-tiers.md` was updated in #step-7; verify `menus.md` is regenerated and consistent.
- [ ] Fix `--tug-font-family-base`: define it in the theme skeleton or repoint `tugx-block.css` and `body-kinds/commit-block.css` to an existing token (check `tuglaws/theme-engine.md` for the authoring doctrine; validate with `bun run audit:theme-contrast` if tokens change).

**Tests:**
- [ ] `menus-doc.test.ts` green (menus.md consistent).

**Checkpoint:**
- [ ] `bun test` && `bunx vite build`
- [ ] `rg 'lensPinned|window-shade|snippet' tuglaws/` returns only historical/decision-log mentions that are intentionally retained

---

#### Step 13: Width regression test + slim collateral sweep {#step-13}

**Depends on:** #step-11

**Commit:** `tests(app-test): first width regression test — slim Session card at 675; slim collateral fixes`

**References:** Risk R01, [P07], [P08], (#z2-anatomy, #z4b-anatomy)

**Artifacts:** The new app-test; the brief's Part J collateral resolved.

**Tasks:**
- [ ] New app-test (number from the inventory, `@covers` the width-preset applier + Z2/Z4B surfaces): apply slim to a Session card → assert width 675, Z2 fully visible (no ladder rung collapsed, no overflow), Z4B flanking geometry stationary (the `at0215`-style assertion at 675).
- [ ] **Diff-document header**: `tug-diff-document.css` has one `@container (max-width: 900px)` rung whose comment claims it recovers the whole overflow at an 800 card — add at least one more degradation rung below it for 675.
- [ ] **Sonner toast**: re-check placement reasoning at `session-card.css` (~250-258, assumes the 800 floor; 356px toast + offset); wrapper is `overflow: clip`, so worst case is clipping — adjust the offset if clipped.
- [ ] **Z2 placards** at 675: eyeball the aggressive in-card clamping; adjust only if it reads badly.
- [ ] **Choose Session sheet** (caps 460px) beside a 675 card: re-check the pairing the old registration comment tied to 800.
- [ ] Re-verify V3 with worst-case faces (Model "Opus 4.8 · 1M", Mode "Accept Edits"); pull the Part E levers only if the regression test fails.

**Tests:**
- [ ] The new width regression test green.

**Checkpoint:**
- [ ] `just app-test-covers-check`
- [ ] `just app-test-changed`

---

#### Step 14: Integration checkpoint {#step-14}

**Depends on:** #step-1, #step-2, #step-6, #step-7, #step-8, #step-11, #step-12, #step-13

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Walk every Success Criteria bullet and check it against the built app: rename greps, migration launch, bilateral + stacked sidebars with equal allocation, slim Session card, the three chords, collapse gone, blobs migrating.
- [ ] Manual pass on the default configuration: Lens + Jots both visible on the right (the stacked default), seam drag, ⌘J capture from a content card.

**Tests:**
- [x] `cd tugrust && cargo nextest run` — 2000 passed, 6 skipped.
- [x] `bun test` (7433) && `bunx vite build`.

**Checkpoint:**
- [x] `just app-test` core tier — 20/20 files, 39/39 tests. The phase's diff is far past the 20-file selection budget, so `app-test-changed` refuses by design and the core tier is the answer to that; the layout, sidebar, Z2/Z4B, and stack families were each run directly as their steps landed.
- [x] `just app-test-covers-check` — 318 files, every `@covers` resolving and in budget.
- [x] Success Criteria walked; the record is below.

#### Step 14 record — what was verified, and how {#step-14-record}

| Criterion | Verdict |
|---|---|
| No `snippet` outside the migration path | Greps clean across `tugdeck/src`, `tugrust/`, `tugcode/`, `tests/`, `tuglaws/`. Four leftovers the sweep had missed were fixed here (a motion-slot constant, a focus-key fixture, the model-eval vocabulary, and a `changes_cli` fixture that used "snippets" as a sample dash name and would have left the grep gate reading dirty forever). What remains is `jots::migrate_from_snippets` and its tests, plus captured Claude transcripts under `tugcode/src/__tests__/fixtures` where the word is ordinary English. |
| `snippets.json` → `jots.json` migration | Rust integration tests (9) covering copy, idempotence, and the absent/present matrix. |
| Bilateral + stacked sidebars, equal allocation | `at0359` (new), `at0230`, `at0299`, `at0303`; imposer unit describes for R=0/1/2 and the equal-Δ solve. |
| Slim Session card, Z2 + Z4B intact | `at0358` (new), and it was checked against a real regression rather than assumed. |
| The three chords | `at0231`, `command-registry.test.ts`, `command-routing-drift.test.ts`, `menus-doc.test.ts`. |
| Collapse gone; old blobs migrate | Grep clean of pane-collapse; `layout-tree.test.ts` round-trips a `collapsed: true` blob to an expanded pane, and a split-era blob to a stack. |
| Toolchain green at each boundary | Recorded per step above. |

**Left to the user, deliberately:** the manual pass — living with the stacked default, the ⌘J capture gesture, and the Layouts miniatures. Those are judgments about how it reads, and this phase has twice been corrected by exactly that kind of look (the Z2 diet, and the split rail).

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** One coherent change set on `main` in which Jots is a first-class sidebar card, the layout system speaks content/sidebar natively, content cards have three width presets with slim actually fitting, and the doctrine + tests record all of it.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] All #success-criteria bullets pass (each names its verification).
- [ ] Step Status Ledger shows every step `done` with its commit hash.
- [ ] No `snippet` references outside the migration path and intentionally retained history.
- [ ] `menus.md`, `chord-tiers.md`, and the amended decisions are internally consistent.

**Acceptance tests:**
- [ ] The new slim width regression app-test.
- [ ] The re-targeted jots app-test family with resolving `@covers`.
- [ ] `layout-imposer.test.ts` allocator + bilateral/stacking describes.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Click actions for the title-bar Session/Project names (the deferred Z4B follow-up).
- [ ] The third sidebar card (future feature; appears in Layouts for free).
- [ ] Retuning `wide` (single-constant change) and Jots' default side if usage argues for it.

| Checkpoint | Verification |
|------------|--------------|
| Rust workspace green | `cd tugrust && cargo nextest run` |
| Frontend green | `bun test` && `bunx vite build` |
| App behavior | `just app-test-changed` per step; core tier on harness-adjacent changes |
| Coverage declarations | `just app-test-covers-check` |
