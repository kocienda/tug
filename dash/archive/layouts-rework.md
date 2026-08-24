# Layouts Rework — Jots, sidebar cards, content width presets, Z2/Z4B diet

This brief is the complete, decided design for a single interlocking change set. It is written to be sufficient on its own for a `/devise` plan in a fresh session: every decision below is final unless marked as a verification item, and the file/symbol references were confirmed against the tree as of 2026-08-06 (line numbers are approximate anchors, not contracts).

## Summary

1. **Snippets → Jots**, renamed full-depth (frontend, Rust, HTTP, feed, on-disk file), and lifted out of the Lens into its own card.
2. A new enshrined taxonomy: **content cards** (session, text, diff, image/file, pdf) participate in the N-Up slot band; **sidebar cards** (lens, jots, one more coming) pin to a deck edge and inset the band. The imposition record, the Layouts section, and the space allocator all generalize from "the Lens" to "sidebar cards".
3. **Content width presets** — slim 675px / comfy 800px / wide 1230px — with a deck-wide default in the Layouts section and a per-pane popup button in the pane title bar. The **window-shade collapse chevron is removed** and the popup takes its place.
4. A **Z2 diet** (remove the BTW cell; shrink value fonts and cell widths; keep label sizes) and a **Z4B diet** (remove Session and Project chips on the code route) so the Session card's width floor can drop from 800 to 675.
5. New shortcuts: **⌘J = New Jot**, **⌃⌘J = Show/Hide Jots**, and **Show Lens moves ⌥⌘L → ⌃⌘L** so ⌃⌘⟨letter⟩ becomes the sidebar-toggle grammar.

Everything interlocks: slim requires the Z2/Z4B diet; the width popup requires the chevron's slot; the Jots card requires the sidebar taxonomy; the Layouts section is the home for both the sidebar positions and the default width.

---

## Part A — Snippets → Jots: full-depth rename

Decision: rename **all the way down**, no compat shims, following the tugmark precedent (naming debt paid at extraction). No jot ever has a title; the row handle remains the incipit (first line).

Current inventory to rename (all confirmed present):

- **TS model**: `tugdeck/src/lib/snippets-doc.ts` — `Snippet { id, text }`, `SnippetsDoc`, `SnippetsFrame`, `SNIPPETS_VERSION`, `newSnippetId()` (`sn_` + 12 hex → `jt_` or keep prefix; recommend `jt_`, old ids remain valid since ids are opaque), `snippetIncipit()`, pure transforms, `mergeForeignDoc`, undo stack, `parseSnippetsFrame`.
- **Store**: `tugdeck/src/lib/snippets-store.ts` — `SnippetsStore`, `getSnippetsStore()`, `createSnippet(afterId)`, `updateSnippet` (500ms debounce), `deleteSnippet`, `setOrder`, `beginEdit`/`commitEdit` (empty row discarded, coalesced undo), echo suppression via `lastWrittenHash`, foreign-frame merge preserving the open row.
- **Rust**: `tugrust/crates/tugcast/src/snippets.rs` (validate, serialize pretty JSON + newline, SHA-256 hash, atomic temp+rename, 1 MiB cap), `tugrust/crates/tugcast/src/feeds/snippets.rs` (250ms mtime/len poll, 100ms debounce, PUT pulses a `Notify`), `tugcore::instance::snippets_path()` + `TUG_SNIPPETS_PATH` env (`tugrust/crates/tugcore/src/instance.rs:253-269`), HTTP routes `GET/PUT /api/snippets` (`tugrust/crates/tugcast/src/server.rs:913-917`), `FeedId::SNIPPETS = 0xA0` + label (`tugrust/crates/tugcast-core/src/protocol.rs:147-150`; TS mirror `tugdeck/src/protocol.ts:62-63`). Rust tests: `tugcast/src/integration_tests.rs`, `tugutil/tests/changes_cli.rs`.
- **Drag/insert**: `tugdeck/src/lib/snippet-drag.ts` (`SNIPPET_MIME = "application/x-tug-snippet"` → `application/x-tug-jot`), consumers in `tug-prompt-entry.tsx` (~1255-1305, 1721-1761), `tug-text-editor/drop-extension.ts` (~86, 123-129, 972-987), `code-session-store.ts:1443-1461` `insertSnippet`/`consumePendingSnippetInsert` + events (`events.ts:437-458`), reducer (`reducer.ts:1394-1410`), `pendingSnippetInsert` (`types.ts:964-975`).
- **On disk**: `<data dir>/Tug/snippets.json` → `jots.json`. Migration: on tugcast startup, if `jots.json` absent and `snippets.json` present, copy contents into `jots.json` (atomic write); leave `snippets.json` in place (never write to it again) so an older build on the same machine doesn't lose data; the machine-global file is the cross-build sync channel, so old and new builds transiently diverge — accepted.
- **Feed**: rename `SNIPPETS` → `JOTS`, **keep `0xA0`** (both ends ship together). Env: `TUG_SNIPPETS_PATH` → `TUG_JOTS_PATH`. HTTP: `/api/snippets` → `/api/jots`.

New names: `Jot`, `JotsDoc`, `jots-doc.ts`, `JotsStore`, `jot-drag.ts`, `tugcast::jots`, `feeds/jots.rs`, `jots_path()`, etc.

## Part B — The Jots card and the sidebar taxonomy

### B1. Taxonomy

New registration field on `CardRegistration` (`tugdeck/src/card-registry.ts`): `layoutRole: "content" | "sidebar"`, default `"content"`.

- **Content** cards participate in N-Up slots, ⌘1..⌘N `assign-slot`, and the width presets. Utility cards (settings, keyboard, devtools, gallery, about) stay `"content"` by default — the taxonomy constrains the layout system, it does not force every card into two boxes.
- **Sidebar** cards (lens, jots): excluded from slots and from `move-to-slot`/`assign-slot` validity; each gets a `{ side, pinned }` entry in the imposition record; excluded from width presets (they own their widths via the allocator and edge-resize).

### B2. The Jots card

- New componentId `"jots"`, registered `hidden: true` (out of the `[+]` picker, like lens/keyboard), `layoutRole: "sidebar"`, sizePolicy modeled on the Lens (`min 320×240`, `preferred 420×900` — tune at implementation).
- **Default position: right** (same default side as the Lens; same-side cards stack — see B3). Revisit later if needed.
- Content transplants from `tugdeck/src/components/lens/sections/snippets-section.tsx` (1073 lines) + `snippets-data-source.ts` + `snippets-section.css`: display/editor rows (`TugMessageEditor` on the CM6 substrate), create/edit grammar (Enter/double-click edit, Escape ascends, blur commits, ⌘Return commit+chain, Space creates below cursor, Delete → `TugConfirmPopover`), `useBlockReorder` drag, filter via `filterAndRank`, copy, undo/redo routing. What changes: the section rented Lens band chrome (`LensSection`, `sectionFocusGroup`, `LENS_BAND_FOCUS_ORDER`, lens filter store) — as a card it needs its own filter field, its own focus group wiring, its own `+` affordance, and substrate responder registration (CUT/COPY/PASTE/SELECT_ALL/UNDO/REDO) since it hosts an editing surface.
- The Lens shrinks to two sections: **Cards** and **Layouts** (`registerSnippetsSection()` and its `main.tsx:334-340` wiring removed; lens-store keys for snippets ordering do not exist — nothing to migrate there).
- Jots preferred/reopen width: mirror the Lens pattern — live width in the layout blob (`pane.size.width`), preferred reopen width in a per-card store (Lens uses `lensStore.widthPx`, tugbank domain `dev.tugtool.lens/widthPx`; give Jots `dev.tugtool.jots/widthPx` or generalize the mechanism — implementer's choice, but the reopen-width concept must survive).

### B3. Imposition generalization

Current record: `DeckImposition { kind?: ImpositionKind; lens: LensSide; lensPinned?: boolean }` (`tugdeck/src/lib/layout-imposer.ts:125`). New record:

```ts
interface DeckImposition {
  kind?: ImpositionKind;                 // one-up … six-up, unchanged
  contentWidth?: "slim" | "comfy" | "wide";  // deck-wide default, Part C
  sidebars: { [componentId: string]: { side: "left" | "right"; pinned?: boolean } };
}
```

- Migration in `serialization.ts` (~308-340, which already parses imposition defensively): `{lens, lensPinned}` → `sidebars: { lens: { side, pinned } }`. Absent `contentWidth` → `"comfy"`. Keep the defensive-parse habit; decide at implementation whether this needs a v5 bump or stays additive (precedent: `kind` widened without a bump).
- **Both sides may host sidebar cards simultaneously.** `resolveSpan` (`layout-imposer.ts:370-383`) insets the band by each side's visible rail width + gap.
- **Same-side stacking**: two sidebar cards on one side share a rail — one shared width, stacked vertically, with a draggable seam between them. (With Lens preferred 900 tall and full-height rails today, the stack splits the vertical extent; the existing full-height pin `top: 5px / bottom: 32px` generalizes to per-stack-member vertical spans.)
- `findLensPane` (`deck-store-selectors.ts:74`) generalizes to "panes hosting sidebar-role cards"; deck invariant #6 (`layout-tree.ts` `validateDeckState`) generalizes to "at most one pane per sidebar componentId, and it carries no slot". `imposeLensStyle`/`--tugx-lens-rail`/`LENS_WIDTH_PROPERTY` generalize to per-sidebar-pane equivalents; the CSS custom-property scheme (`--tug-imposer-inset-left/right` written by `deck-canvas.tsx:864-910`) now sums each side's rails.
- Drag-to-unpin, deck-facing-edge resize keeping the pin (`handleLensResizeStart`, `tug-pane.tsx:2210-2345` — the one existing width-change-without-eviction path), and the Layouts position control re-pinning all carry over per sidebar card.
- `assignCardToSlot` must refuse sidebar cards; `arrangeCards` (deck-manager.ts:1757) skips pinned sidebars (today it skips the pinned Lens).

### B4. Space allocator with the equal-resize rule

`allocateLensWidth`/`solveLensWidth` (`layout-imposer.ts:591-699`) generalizes: when imposition needs to steal or grant rail space, it solves for **one delta applied equally to every visible sidebar card** (not per-card independent solutions). Clamps: per-card `sizePolicy.min`, the existing grow/shrink fractions (`LENS_FLEX_GROW_FRACTION = 0.35` / `LENS_FLEX_SHRINK_FRACTION = 0.2` of each card's preferred width), and the ≤2px seam-residual acceptance test (`ALLOCATOR_RESIDUAL_TOLERANCE_PX`) — if the fit fails, move nothing, as today. Same two trigger moments: a Layouts-section click and a canvas resize come to rest (`retuneLensAllocation` → generalized). Same-side stacked cards share one rail width, so the equal-resize delta applies to rail widths (one per side), and each rail's delta is bounded by the tightest clamp among its stack members.

## Part C — Content width presets, the width popup, and collapse removal

### C1. The presets

- **slim = 675px** (decided), **comfy = 800px** (the current width, by definition), **wide = 1230px** (proportional to comfy × 120/78; adjustable taste — confirm or round during planning). Named exported constants beside `IMPOSITION_GAP_PX` in `layout-imposer.ts` (or a sibling module). The earlier ch-derivation was ballpark; the px values are now the spec.
- Presets apply to **content-role cards only**. They set the pane's width through the one geometry entry point: `DeckManager.movePane(paneId, pane.position, { width: preset, height: pane.size.height })` with **no opts** — verified to preserve `slot` (`deck-manager.ts:1664-1714`). Two handled caveats: `movePane` does not clamp to `sizePolicy.min` (the preset applier must clamp to the pane's stack policy — e.g. Settings' 720 floor beats slim); and the stale doc comments claiming resize never evicts (`deck-manager.ts:1655-1662`, `deck-manager-store.ts:20-27`) are wrong (resize does evict, `tug-pane.tsx:2165-2173`) — fix them in passing.
- Registration min/preferred updates: session/text/file-view cards `min.width` 800 → **675**, `preferred.width` 800 → resolved from the deck default preset at `addCard` time (replacing the hard-coded 800s in `session-card-registration.tsx:30-52`, `text-card-registration.tsx:31-39`, `file-view-card-registration.tsx:29-30`; diff-card and devtools `preferred` comments reference "the 800 default" — update). Keyboard/settings/utility cards keep their current mins. The session registration's rationale comment is **fiction** (describes four 21ch cells plus sash grips that no longer exist) — rewrite it against the post-diet Z2 (Part D).
- At `wide` on dense N-Ups, cards overlap — [D121] already declares overlap ordinary geometry; no special handling.
- Per-pane bookkeeping: additive-optional `widthPreset?: "slim" | "comfy" | "wide"` on `TugPaneState` (`layout-tree.ts:275-305`; precedent `slot?`/`collapsed?` — no version bump). The popup renders the check from it; **any manual resize clears it** (no resting lies). The deck-wide default changing (Layouts section) **applies immediately to all content panes**, overwriting per-pane deviations and stamping their `widthPreset` — the Layouts section's other controls all act on the live deck immediately, and the per-pane popup is how you dissent afterward (decided).

### C2. Window-shade collapse: removed outright

Collapse is pointer-only (no command, no chord, no Swift menu item — verified), so removal is a clean sweep:

- `CardTitleBar` chevron button + `handleCollapsePointerDown`/`handleCollapseClick` (`tug-pane.tsx:439-577`), `onCollapse`/`collapsed` props, `handleFrameCollapseToggle` (~2374), `onCardCollapsed` wiring (`deck-canvas.tsx:1374`), `togglePaneCollapse` (`deck-manager-store.ts:350`) / `_togglePaneCollapse` (`deck-manager.ts:3526`).
- `TugPaneState.collapsed?` (`layout-tree.ts:291`) and its serialization reads (`serialization.ts:403-415, 557-569`) — old blobs with `collapsed: true` deserialize with the field dropped; panes come back expanded (additive-optional, no bump).
- `imposeStyle(placement, paneWidth, collapsed)` / `imposeLensStyle(..., collapsed)` lose the param (`layout-imposer.ts:436-446, 743-759`); `COLLAPSED_FRAME_HEIGHT` (`tug-pane.tsx:2361`), collapsed frame-height branches (~2369-2434), resize-handle suppression (~2450), chrome class swap (~2470); collapsed special cases in the freeze path (`deck-manager.ts:1932`) and `assignCardToSlot` (`:2048`); drag-commit height preservation (`tug-pane.tsx:1929-1934`).
- CSS: `.tug-pane-chrome--collapsed` block (`tug-pane.css:233-248, 273`), the collapsed title-bar bg token (`:57`), the [D07] "turd" rule comment (`:175`).
- Tests: retire `tests/app-test/at0194-window-shade-collapse.test.ts`; update `layout-tree.test.ts` (collapsed round-trip describes at 559, 761), `layout-imposer.test.ts` (collapsed pin tests at 326-334, 392-396); update the gallery harness `gallery-title-bar.tsx` (local collapse demo at 36-150).
- pane-model.md's collapse references (lines ~37-55, 147, 264) and the [D97] mentions come out.

### C3. The width popup button (the chevron's replacement)

- A **`TugPopupMenu` with a ghost icon trigger cloned from the stack-badge pattern** (`tug-pane.tsx:496-540`) — explicitly *not* `TugPopupButton`, whose outlined identity is fixed and clashes with the ghost control cluster (its own header says: use `TugPopupMenu` directly when the trigger needs custom appearance).
- Sits in `.tug-pane-title-bar-controls` (`tug-pane.tsx:487`; CSS `tug-pane.css:426-431`) beside the stack badge, keeping close pinned trailing. Items: Slim / Comfy / Wide with a check on the pane's `widthPreset` (no check at a custom width). Shown on content-role panes only (sidebar panes and their rails manage width via edge-resize + allocator).
- Selection dispatches a registered **`set-card-width`** action (registry routing with payload, same shape as `set-imposition` in `action-dispatch.ts:490-527` / `command-registry.ts:1078-1093`); [L30]-clean, no default chord. Handler: clamp to stack sizePolicy → `movePane` width-only, no opts → stamp `widthPreset`.
- `tests/app-test/at0156-title-bar-controls.test.ts:68-77` pins the control set to exactly `[collapse-button, close-button]` — update to `[width-button, close-button]`. Add the new control to the gallery title-bar harness.

## Part D — Z2 diet (Session card status strip)

Current anatomy (`session-card-telemetry-renderers.tsx` `SessionTelemetryStatusRow` at 593, cells 1062-1179; `tug-status-cell.tsx/.css`): six cells STATE/TIME/TOKENS/CONTEXT/WORK/BTW, `flex: 0 0 auto` each, widths in ch on the row's 11px font (`tug-status-cell.css:55-79`: state 20ch, time 16ch, tokens 14ch, context 20ch, work 16ch, btw 10ch = 96ch), gaps `--tug-space-2xl` (24px), row `padding-inline` 24px, strip padding 8px. Labels: 9px mono letterspaced with the endcap-rule "wings" (`TugStatusCellLabel`, `tug-status-cell.tsx:59-79`; CSS 208-303 — 1px hairline fills + 1px×5px end ticks, all width-driven by `--tugx-session-status-cell-width`). Values: 13px (`0.8125rem`) bold sans (`:141`).

Changes (decided):

1. **Remove the BTW cell** entirely: the cell render (`renderers 1062-1179` btw branch, `btwCount` subscription at 703-716), its 10ch width rule, its collapse rung. `SideQuestionStore` and the placard body (`side-question-overlay.tsx`) **stay** — see D-btw below.
2. **Shrink value fonts, keep labels**: values `0.8125rem` (13px) → `0.75rem` (12px); row font `0.6875rem` (11px) → `0.625rem` (10px), which shrinks every ch-denominated cell width and the wings proportionally (~9%). Labels stay `0.5625rem` (9px). Accepted contingent on everything fitting (verification item V2).
3. **Tighten the gap**: inter-cell gap and row padding-inline `--tug-space-2xl` (24px) → `--tug-space-xl` (16px). Headroom arithmetic: post-diet the row is 5 cells = 86ch ≈ 465px at 10px + 4×16 gaps + 32 row padding + 16 strip padding ≈ **~590px intrinsic**, against slim's ~659px content box (675 − strip padding). Without the gap cut it's ~625px — still fits at 675, so the cut is comfort margin rather than necessity; keep it unless the tighter rhythm reads badly.
4. **Re-tighten per-cell ch budgets** to the current widest faces while in there (the inline rationale comments name the widest strings: TIME `4h 30m 00s` 10ch content, TOKENS `−208.3K`, etc.).
5. **Recompute the container-query collapse ladder** (`tug-status-cell.css:305-336`, container `session-status` = `.session-card-status-bar`, `session-card.css:330-333`): current rungs (520 hide btw / 460 hide time / 290 hide tokens / 200 hide work) were tuned for a different row; after the diet, recompute so degradation starts where overflow actually begins at the new cell budget (time should start collapsing a bit above the new intrinsic width). Fix the drifted ladder comment at `session-card-telemetry-renderers.css:105`.
6. Rewrite the session registration's width-floor rationale comment against this new row (Part C1).

**D-btw — where `/btw` answers now (decided):** the side-question placard **pops from the top of Z2, aligned to the right edge of the host card** — a transient surface opened when `/btw` completes (the `openSideQuestions()` → `showPlacard("btw")` path retargets from cell-anchored to strip-anchored, right-aligned). No persistent count cell. `PLACARD_TITLES.btw = "/btw"` and the placard body (annotation context, pendingContextStore "Add to context") carry over. Placard anchoring today measures cell centers relative to the status bar (`measureAnchorCenter`, renderers 624-637) with in-card clamping — the new anchor is the strip's top-right. [D122] ("the Z2 BTW cell is the one place BTW lives") is amended: the placard is the place; `/btw` is still merely how you ask.

## Part E — Z4B diet (composer chips row)

Z4B = the centered chip cluster in the prompt-entry toolbar (`session-card.tsx:4555-4647` `indicatorsContent` → `tug-prompt-entry.tsx:3476` `toolbarCenter` → `tug-entry-shell.tsx:194-199`; geometry rule: two flexible spacers center Z4B between fixed Z4A route group and Z5 submit — [D97] line 327).

Changes (decided):

- **Code route only**: unmount the **Session** chip (`chrome/session-id-badge.tsx`) and the **Project** chip (inline `session-card.tsx:4052-4077`) — both names already live in the pane title bar (`sessionCardTitleOverride` publishing at `session-card.tsx:4014-4050`). Remaining code-route cluster: identity badge + Mode + Model + Effort.
- **Shell and commit routes keep their chips** (shell: identity · Project · Cwd; commit: Project + Changes) — those routes aren't space-challenged (decided). Table T01 in [D110] is amended for the code route only.
- Click-action follow-ups for the removed chips are explicitly out of scope (a later enhancement).
- Width note for slim: the removed chips were the two most expensive variable faces, and the three remaining pickers reserve worst-case widths permanently via `TugStableOverlay` sizers (Mode reserves "Accept Edits", Model reserves the widest catalog title, e.g. "Opus 4.8 · 1M"). Z4B has **no** degradation machinery (no wrap, no ellipsis, no overflow rule — only the spacers flex). Verification item V3 covers fit at 675; levers if it's tight: chip padding, the identity badge's version string, `PATH_CHIP_MAX_CHARS` is moot on code route but the condensed face on `.tug-entry-shell-indicators` already buys room.

## Part F — The Layouts section becomes the layout home

`tugdeck/src/components/lens/sections/layouts-section.tsx` grows from two controls to three groups, all `TugRadioGroup emphasis="tile"` with `LayoutMiniature` drawings where applicable:

1. **Cards (N-Up)** — unchanged (`one-up`…`six-up` → `set-imposition`). Content cards only, as today.
2. **Card Width** — Slim / Comfy / Wide → new `set-content-width` action writing `imposition.contentWidth` and immediately applying to all content panes (C1). Miniatures can render the three widths at scale.
3. **Sidebar positions** — registry-driven: one Left/Right control **per registered sidebar card** (Lens, Jots; a future third appears for free), replacing the hard-coded "Lens Position" (`set-imposition-lens` generalizes to `set-sidebar-side` with a componentId payload). `LayoutMiniature` (`layout-miniature.tsx`, `RAIL_PCT = 18`) extends to draw rails on both sides and stacked same-side cards.

## Part G — Commands and shortcuts

Both ⌘J and ⌃⌘J are verifiably unbound everywhere (registry, CM6 keymaps, Swift menus, tuglaws/menus.md chord table). ⌃⌘L is also free (⌃⌘ occupancy: A C F H I K M P T).

| Command | Chord | Notes |
|---|---|---|
| `new-jot` | **⌘J** | Creates a jot, revealing the Jots card if hidden and focusing the new row's editor (capture in one gesture). Plain-⌘ tier claim justified by frequency (R3); `chord-tiers.md` currently lists ⌘J in the free pool annotated "for jump/go-to" — update that line in the same change (never silently diverge). |
| `toggle-jots` | **⌃⌘J** | Show/Hide Jots. Tug-machinery tier. |
| `toggle-lens` | **⌃⌘L** (moved from ⌥⌘L) | Decided. ⌃⌘⟨letter⟩ becomes the sidebar-toggle grammar. |
| `set-card-width` | none | Per-pane preset via the title-bar popup (C3); registry routing with payload. |
| `set-content-width` | none | Deck default via Layouts section. |
| `set-sidebar-side` | none | Generalizes `set-imposition-lens`. |

Registration pattern for the two chorded commands: follow `show-keyboard-shortcuts` ⌃⌘K exactly (`command-registry.ts:1107-1122`) — `chord({...}, { preventDefault: true, menuEligible: true })`, Swift menu item constructed with an **empty** key equivalent so the `applyCommandChords` sweep supplies it (this avoids the recorded shade-toggle anomaly where a Swift construction literal makes rebinding silently fail — `chord-tiers.md` documents it). `new-jot` handler follows the ⌃⌘K find-or-create-then-focus shape in `deck-canvas.tsx:602-620` and joins `DECK_CANVAS_VALIDATED_ACTIONS`. New `TUG_ACTIONS` constants; the checklist in `tuglaws/commands.md` "Adding a command" applies verbatim.

## Part H — Doctrine updates (tuglaws)

- **[D121]** amended: sidebar generalization (multi-card, bilateral, equal-resize allocator) + the width presets (note: presets do not violate "the imposer never sizes" — presets are applied by a command through `movePane`; the imposer still passes width through untouched).
- **[D122]** amended: `/btw`'s surface is the strip-anchored placard (D-btw), not a cell.
- **[D110] Table T01** amended: code route loses Session and Project.
- **[D97]** zone diagram fixed: it still shows `[grip] … [maximize]` flanks and five cells; the grips/maximize no longer exist in the DOM and the row changes again here.
- **pane-model.md**: collapse references removed; the three-geometry-modes table's "pinned" row generalizes from "hosts Lens card" to "hosts a sidebar-role card"; invariant #6 generalized.
- New design decision: the content/sidebar taxonomy + width presets + the equal-resize rule.
- **chord-tiers.md**: ⌘J free-pool annotation updated; Show Lens chord move recorded; menus.md chord table regenerates via `menus-doc.test.ts`.
- Free fix to fold in: `--tug-font-family-base` is referenced in `tugx-block.css:192` and `body-kinds/commit-block.css:27` but defined in no theme (silent invalid-var → inherit); define it or repoint the two rules.

## Part I — Test impact inventory

Rename sweep (jots): unit tests `snippets-doc.test.ts`, `snippets-store.test.ts`, `snippets-data-source.test.ts`, `code-session-store.snippet-insert.test.ts`; app-tests `at0241-lens-snippet-editor`, `at0245-lens-snippet-click-scroll`, `at0254-lens-snippet-editor-growth`, `at0255-lens-snippet-followons`, `at0290-snippet-delete-confirm-anchor`, `at9997-scratch-snippet-heavy-deck` — these also re-target from Lens rows to the Jots card, and their `@covers` lines must resolve to the renamed paths (`just app-test-covers-check`).

Lens-structure tests that assumed three sections: `at0266-lens-filter` (covers `sections/`), `at0341-lens-cross-section-arrows`, `at0297-lens-empty-label-row-height` (covers `snippets-section.css`), plus the band/keyboard suite (`at0351`, `at0248`, `at0256`, `at0277`, `at0282`, `at0296`).

Sidebar generalization: `at0276-lens-side-persists`, `at0230-pinned-lens-geometry`, `at0299-lens-edge-drag`, `at0231-lens-toggle-focus` (chord moves to ⌃⌘L), `at0247-relaunch-lens-keyboard`; imposer unit tests (`layout-imposer.test.ts` — lens-style and allocator describes); serialization/layout-tree tests for the imposition migration.

Collapse removal: retire `at0194`; update `at0156` (exact-control-set assertion), `layout-tree.test.ts:559,761`, `layout-imposer.test.ts:326-334,392-396`, `gallery-title-bar.tsx`.

Z2/Z4B: `at0211-btw-side-question-overlay` (re-anchor), `at0140-cycle-session-card` (cycle order loses Z2_BTW + Session/Project chips; constants at lines 100-105), `at0196-z4b-chip-buttons` (session-id-badge selectors — rework or retire), `at0215-composer-route-chrome` (T01 manifest + flanking geometry — re-verify at 675), `at0192`, `at0206`, `at0219`, `at0220`, `at0084`, `at0157`, `at0162`, `at0197`; `tuglaws/app-test-inventory.md` prose updates.

Commands: `command-registry.test.ts`, `command-routing-drift.test.ts` (explicit chord→command table ~line 326), `menus-doc.test.ts` (regenerates menus.md), `at0180`/`at0181`/`at0182`.

**There is no width regression test today** — add the first one: a slim-preset Session card at 675 with Z2 fully visible (no rung collapsed, no overflow) and Z4B flanks stationary.

## Part J — Verification items and known collateral at slim

- **V1 — Z2 fit at 675**: post-diet intrinsic ≈ 590px (with the gap cut; ~625px without) vs ~659px available; verify with real faces (STATE's longest phase label, TIME `4h 30m 00s`, CONTEXT `1.00M` denominators), then set the ladder rungs.
- **V2 — the 12px/10px font shrink is contingent on V1**: if faces don't fit, tighten ch budgets before reaching for smaller type (decided: 12px values acceptable "if everything fits").
- **V3 — Z4B fit at 675**: identity + Mode + Model + Effort with worst-case stabilizer widths + Z4A route group + Z5 submit; `at0215`'s flanking-geometry assertion is the tripwire (it currently runs at a 900px card). Levers listed in Part E.
- **Diff-document header**: `tug-diff-document.css` has one `@container (max-width: 900px)` rung and its comment says that recovers "the whole overflow at an 800px card" — at 675 it needs at least one more degradation rung.
- **Sonner toast**: placement reasoning at `session-card.css:250-258` assumes the 800 floor (356px toast + offset); re-check at 675 (the wrapper is `overflow: clip`, so worst case is clipping, not layout breakage).
- **Z2 placards** clamp in-card more aggressively at 675 (`session-card-telemetry-renderers.css:129` bounds them to the strip); degrades gracefully but eyeball it.
- **Choose Session sheet** (caps at 460px) beside a 675 card: the registration comment ties the old 800 to this; re-check the pairing.
- **Cross-build jots.json**: old builds keep reading/writing `snippets.json`; divergence during the transition is accepted (Part A).

## Decisions log (all final)

- Jots rename: full depth, `jots.json`, `/api/jots`, `TUG_JOTS_PATH`, feed `JOTS` keeping `0xA0`, MIME `application/x-tug-jot`. No titles, ever.
- Jots card: own hidden card, sidebar role, default right.
- Sidebars: bilateral simultaneous; same-side stacks share a rail; allocator steals/grants **equally** across visible sidebar cards.
- Presets: slim **675**, comfy **800**, wide **1230** (wide adjustable); deck default in Layouts applies immediately to all content panes; per-pane popup dissents; manual resize clears the preset stamp.
- Collapse/window-shade: removed outright, replaced by the width popup.
- Z2: BTW cell removed; values 13→12px, row 11→10px, labels stay 9px; gaps 24→16px; ladder recomputed. `/btw` pops from the top of Z2, right-aligned to the host card.
- Z4B: Session + Project chips removed on the **code route only**; click-action follow-ups deferred.
- Shortcuts: ⌘J new-jot, ⌃⌘J toggle-jots, Show Lens moves to ⌃⌘L.
