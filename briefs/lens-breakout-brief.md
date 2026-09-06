# Lens Breakout: the four sections become four sidebar cards

**Purpose:** Dissolve the Lens card into four sidebar cards — Cards, Dashes, Layout, Tripwires — deleting the section machinery that made the Lens a second card system in miniature. The Lens name retires.

---

## Purpose {#purpose}

The Lens is a mishmash: one card holding four sub-sections (Cards, Dashes, Layout, Tripwires), each acting as its own card-like content. Breaking them out into real sidebar cards reduces the number of UI concepts in the code, simplifies scrolling, and gives the user full flexibility in arranging the content — the rail arrangement machinery (stack, split, reorder, per-side placement) replaces everything the Lens re-implemented privately. Depends on the rail promotion dash (`notes/rail-promotion-brief.md`) having joined first, so the rails can hold and address four-plus members.

---

## Evidence {#evidence}

**[F01] The Lens contains a parallel card system.** `tugdeck/src/components/lens/lens-section-registry.ts` is a second registry with its own definition shape (`kind`, `title`, `glyph`, `collapsedSummary`, `body`, `presence`, `filterable`), and around it orbit section-scoped clones of deck-level machinery: `lens-section-presence.ts` + `lens-section-presence-probe.tsx` (shown-at-all — the deck answers this with open/closed panes), `lens-filter-store.ts`, `lens-section-content.ts`, `block-reorder.ts` + `block-drop-caret.tsx` (bespoke drag-reorder — the deck has a drop-zone engine), `lensStore.sectionOrder` / `collapsedSections` (the deck persists rail order and open panes), and the band `lens-section-band.tsx` (a title bar in miniature). **(verified)**

**[F02] The four sections are already separate, portable files.** `tugdeck/src/components/lens/sections/`: `cards-section.tsx` (~1144 lines), `layouts-section.tsx` (~1394), `dashes-section.tsx` (~1001), `tripwires-section.tsx` (~563), each self-registering, each with a sibling `.css`, written against the deliberately thin `LensSectionHost` (`{ lensCardId, focusGroup }`) — bodies import nothing from `lens/`. **(verified)**

**[F03] The Lens scroll model is a pressure dance, not a scroller.** `.lens-content { overflow: hidden }`; sections are content-sized flex children that shrink under pressure and hand overflow to each list's own `TugListView` scroller, with carve-outs: Tripwires scrolls its whole column as one document, Layout has no scroller (fixed rows), and a jot-editor sibling-pinning rule survives in `lens-section-band.css` from before Jots left. Four cards each owning one ordinary host scroll region replaces all of it. **(verified)**

**[F04] Jots is the worked precedent.** Jots was a Lens band and is now its own sidebar card (`jots-card.tsx` says so in its header); `tugdeck/src/components/jots/jots-card-registration.tsx` is the template a sidebar-card registration takes — `layoutRole: "sidebar"`, `hidden: true`, `kbfAtRest: true`, un-mergeable family, width constants, `sidebar-width-store` for reopen width. **(verified)**

**[F05] The rails are member-general.** `imposition.rails[side]` keys by componentId with order and shares that deliberately outlive their members; `setRailOrder` keeps unknown ids so a closed member's place survives; the width allocator folds same-side members into one rail policy. Nothing caps membership at two. **(verified)**

**[F06] Lens-specific residue in shared code.** The Lens predates `sidebar-width-store.ts` and keeps its width in `lensStore` at domain `dev.tugapp.lens` key `widthPx`; `_sidebarPreferredWidth()` in `deck-manager.ts` special-cases it. `findLensPane` (`deck-store-selectors.ts:130`), `LENS_RAIL_PROPERTY` (`layout-imposer.ts:980`), the legacy Lens shim in `deck-manager.ts:1410`, and `pane-model.md`'s "the Lens open at its pin is the factory deck" all name the Lens directly. **(verified)**

**[F07] `lensStore` persists more than sections.** Domain `dev.tugapp.lens` keys: `widthPx`, `sectionOrder`, `cardsRowOrder`, `cardsGroupOrder`, `cardsCollapsedGroups`, `collapsedSections` (plus deprecated `sessionOrder`/`textFileOrder`). The `cards*` keys belong to the Cards section's own presentation and must survive the breakout. **(verified)**

---

## Decisions {#decisions}

**[B01] Four sidebar cards: Cards, Dashes, Layout, Tripwires.** Each `LensSectionDefinition` becomes a `CardRegistration` with `layoutRole: "sidebar"`, on the Jots template [F04]. Section bodies port largely as-is [F02]. Each card takes the standard `sidebar-width-store` reopen width; no new `lensStore.widthPx`-style special case.

**[B02] The Lens name retires.** User's call. No card inherits it; the componentId `lens`, `LENS_CARD_ID`, `findLensPane`, `LENS_RAIL_PROPERTY`, the `focus-lens`/`toggle-lens` commands, and the `dev.tugapp.lens` domain all go (via migration, [B06]). The rail-side custom property generalizes to the per-side naming the allocator already uses elsewhere.

**[B03] Empty cards show an empty state; nothing autohides.** User's call. The `presence(host)` mechanism dies with the section registry: a Dashes card with no dashes and a Tripwires card with no tripwires each render an honest empty state. Content never adds or removes a card from the rail.

**[B04] The factory deck's right rail holds Cards, Dashes, Layout, Tripwires — in that order.** User's call. A launch finding no persisted layout builds all four open on the right rail in that rail order, stacked (the default mode), Cards frontmost. `pane-model.md`'s factory-deck paragraph is rewritten to say so.

**[B05] Section state maps onto deck state.** `sectionOrder` → seeds `imposition.rails.right.order` in the layout migration; `collapsedSections` → open/closed cards (a collapsed section maps to a closed card); `collapsedSummary` goes away — the stack badge, rail toggles, and menu rows are how an out-of-the-way card is reached. The filter field and the Escape ladder become per-card. `lens-selection-store.ts` (the layout selection the nudge/split chords act on) survives, owned by the Cards card, renamed accordingly.

**[B06] Two migrations, one release.** (1) The deck layout blob: a persisted layout containing a `lens` pane maps to the four cards on that pane's side, in the persisted `sectionOrder` (collapsed sections closed), keeping the rail's width. (2) The store: `cardsRowOrder` / `cardsGroupOrder` / `cardsCollapsedGroups` move from `dev.tugapp.lens` to the Cards card's own domain; `widthPx` seeds the Cards entry in `sidebar-width-store`; the `dev.tugapp.lens` domain is then dead.

**[B07] Deleted outright:** `lens-section-registry.ts`, `lens-section-band.tsx/.css`, `lens-content.tsx/.css`, `block-reorder.ts`, `block-drop-caret.tsx`, `lens-section-presence.ts`, `lens-section-presence-probe.tsx`, `lens-section-content.ts`, `lens-filter-store.ts` (replaced per-card), `lens-register-card.tsx`, the Lens shims and special cases in [F06], and the jot-editor carve-out CSS [F03].

**[B08] Sequencing inside the dash: Tripwires pilots; Layout lands last.** Tripwires is the smallest section, already owns its scroll, and has its own store — the cheapest proof of the porting recipe. Layout goes last because it is the section that *operates on* the arrangement it now lives inside. The Lens card itself is deleted only after all four cards stand.

**[B09] Docs move with the code.** `pane-model.md` (factory deck, "the Lens and Jots today" in the pinned-mode row, the rail/column prose that names the Lens), `chord-tiers.md` cross-references, and the generated table in `menus.md`. Tests: the `lens/` test suites port or retire with their subjects; new `*.test.ts` app-tests carry `@covers` per the harness contract.

---

## Open Questions {#open-questions}

- **What the Cards card's `lensGroup`-style grouping means for the card that lists cards.** `cards-groups.ts` groups by `CardRegistration.lensGroup` (`sessions`/`files`/`tools`); the field's name outlives the Lens. Rename to something like `overviewGroup`/`cardsGroup` during the port, or leave as debt? Settle in the dash — a rename is mechanical but touches every registration.

---

## Non-goals {#non-goals}

- **The rail chords and 3+-member rail geometry.** That is the rail promotion dash, which joins first.
- **Any new arrangement features.** No cross-rail drops, no new modes; the four cards ride the machinery exactly as Jots does.
- **Keeping "Lens" as the Cards card's name.** Considered and rejected by the user: the name earned its meaning when it was four things; as one list it is just Cards.
- **Autohiding empty cards.** Considered and rejected [B03]: content silently reordering the sidebar is the one behavior the presence mechanism bought, and it is not wanted.

---

## Exit {#exit}

A direct **`/dash`**, run after the rail promotion dash joins. The decisions are made above; the parts are many but the order is settled [B08], and the dash's task list is written from this brief.
