# Tunable content-card gap

**Purpose:** Content cards on the deck stand too close to the window edges, to each other, and to the sidebar rails. The gap should be larger, and it should be a setting the user can tune from the Layout card rather than a constant in the source.

---

## Purpose {#purpose}

The user's words: "I want to change the way that content cards are laid out on the deck. Let's give them larger margins/gaps. This includes the gaps on the top and bottom between the cards and the OS window, in between cards, and between the content cards and the sidebar rails/cards. Let's make this a setting I can tune. Obviously, this will also include updating the layout algorithms."

Three distances are named: card to window edge (top, bottom, and the sides when no rail stands there), card to card (between slots, and between the members of a split column), and card to rail. Every one of them is resolved by the layout imposer and its numeric twins, so a tunable gap is a change to the layout arithmetic first and a settings row second.

---

## Evidence {#evidence}

**[F01] One constant is the card gap at every edge.** `IMPOSITION_GAP_PX = 5` in `tugdeck/src/lib/layout-imposer.ts` is the pane's stand-off from the canvas top, from the left and right canvas edges when no rail stands there, the seam between two column members, the spacing between slots in flow (the strip length is `Σ (extent + gap)`) and in fit (the band is `span − 2 × gap`), and the one gap the band spends at each end beside a rail. The imposer reads it numerically about forty times. **(verified)**

**[F02] The CSS twin of the card gap is a baked literal, unlike every other length.** The imposer emits `calc()` strings for `left`, `top` and `bottom`, and its `GAP` string is `` `${IMPOSITION_GAP_PX}px` `` — a literal. The bottom gap, the rail edge inset and the rail gutter each cross into CSS as a custom property (`--tug-imposer-gap-bottom`, `--tug-rail-edge-inset`, `--tug-rail-gutter`) with the numeric twin as the `var()` fallback, stamped on the document root in `tugdeck/src/main.tsx`. The card gap is the one length a stylesheet cannot read and a property write cannot move. **(verified)**

**[F03] The bottom gap already has the mechanism a tunable gap needs.** `IMPOSITION_GAP_BOTTOM_MAKER_PX = 32` (8px strip offset + ~19px strip + one card gap of air) holds in maker builds; release builds use the card gap. The value is a module-level mutable read through `impositionGapBottomPx()`, settled once at boot by `setImpositionGapBottom(makerMode)`, which returns whether it moved; `main.tsx` then stamps the property and calls `deck.retuneSidebarAllocation()` to re-impose. That is the template: a getter for the arithmetic, a property for the CSS, one re-impose cue on change. **(verified)**

**[F04] The rail is described by two further lengths, both already properties.** `RAIL_EDGE_INSET_PX = 0` is a pinned rail's stand-off from the window edge on its outer side and top; it is zero on purpose, because a rail is a panel of the window and not a card on the paper. `RAIL_GUTTER_PX = 12` is the air from the rail's inner edge to the first card, wider than the card gap on purpose, and the rail's one-sided shadow fills most of it. A standing rail pushes the span in by `edgeInset + width + gutter − gap` (`railSpanInsetPx`), so the gutter must stay at least the card gap or the span's own end gap overspends it. **(verified)**

**[F05] Thirteen numeric reads live outside the imposer.** `deck-manager.ts` (`_placeRunHeight`, the flow band width), `deck-store-selectors.ts` (seam travel), `lib/drop-zones.ts` (a column's seam), `components/chrome/rail-width-draft.ts` (snap targets one gap off another pane's edge), `components/chrome/tug-pane.tsx` (the Option-drag snap and the bullseye exit clamp), `lib/sheet-reservation.ts` (a member's floor, `SHEET_CANVAS_GAP − gap`), `layout-imposition.ts`, and `components/chrome/deck-canvas.tsx` (margin caps, seam hit strips, flow-band drag triggers) all import the constant. The pane's hand-snap importing the same symbol is what puts an imposed pane and a snapped pane on one rhythm. **(verified)**

**[F06] Tests read the constant symbolically, and a few spell out 5.** Twenty-seven references in tugdeck unit tests and the app-test fixtures (`tests/app-test/space-allocator-fixture.ts` re-exports it as `GAP`; `at0569-sheet-reservation.test.ts` imports it) take the symbol, so they follow a getter whose default is unchanged. `at0569`'s prose and `at0362`'s docblock say "5" by hand. **(verified)**

**[F07] Deck-wide layout choices persist on the `DeckImposition` record.** The record in the `dev.tugapp.deck.layout` blob carries `kind`, `contentWidth`, `layout` and the resize rule as independent axes, each absent reading as a default. The content-width axis is the closest sibling: three named presets with pixels in one table (`CONTENT_WIDTH_PX`), labels in one table (`CONTENT_WIDTH_LABELS`), applied by `setContentWidth` through one `_commitImposition`, and surfaced on the Layout card as a captioned `TugChoiceGroup` row. **(verified)**

**[F08] The Layout miniature draws its own gap.** `CARD_GAP_PCT = 3.5` in `layout-miniature.tsx` is a deliberately exaggerated fraction of the drawing, not the deck's pixel gap scaled, so the miniature does not read the constant and does not change. **(verified)**

---

## Decisions {#decisions}

**[B01] One setting, Gap, drives every card distance.** The card gap at the window edges, between slots, between column members, and the band's end gaps beside a rail are all one number today ([F01]), and the user named them together. A single knob keeps the rhythm one rhythm: a pane the imposer places and a pane the hand snaps still land on the same grid ([F05]). Separate knobs for edge, seam and rail would have to be kept in ratio by hand to look right, which is a tuning burden the user did not ask for.

**[B02] The rail gutter tracks the gap by a fixed extra.** The gutter becomes `gap + RAIL_GUTTER_EXTRA_PX`, with the extra set to 7 so today's 12 holds at the default 5. This keeps [F04]'s two invariants under every preset: the gutter is always wider than a card gap, and `railSpanInsetPx` never overspends. The user chose tracking over an independent 12. The rail's shadow is sized to the gutter and may want a look at the widest preset, which is a tuning note, not a blocker.

**[B03] The maker bottom gap is the strip clearance plus the gap.** `IMPOSITION_GAP_BOTTOM_MAKER_PX` stops being a bare 32 and becomes a clearance constant of 27 plus the live gap, so the dev-info stamps keep exactly one gap of air above them at every preset ([F03]). A release build's bottom gap is the live gap, as today. `railGapBottomPx` is unchanged in form and follows.

**[B04] The rail edge inset stays zero.** The user asked about content cards; a rail is a panel of the window and stands flush by design ([F04]). Nothing in this work moves a rail's outer edge or top.

**[B05] The card gap becomes a live value on the bottom gap's pattern.** A getter (`impositionGapPx()`) replaces the numeric reads, a `--tug-imposer-gap` property with the default as fallback replaces the baked literal in every emitted `calc()` ([F02]), and a setter returns whether the value moved so the caller stamps the property and re-imposes, exactly as `setImpositionGapBottom` does ([F03]). The exported constant survives as the default's name, so symbolic test references ([F06]) keep meaning what they meant. Column shares are fractions of the run and flow offsets are clamped in CSS, so stored layout state survives a change without migration; the re-impose cue is enough.

**[B06] The gutter and the maker bottom gap derive at read time, not at stamp time.** The three CSS properties (`--tug-imposer-gap`, `--tug-rail-gutter`, `--tug-imposer-gap-bottom`) are re-stamped together whenever the gap changes, and the numeric getters compute from the live gap, so there is one source of truth and no second number to keep in step.

**[B07] The setting is a preset choice row, persisted as a `gap` axis on `DeckImposition`.** Four named presets with their pixels in one table beside `CONTENT_WIDTH_PX`, labels in a sibling table, absent reading as the default. The Layout card gets a captioned row next to Width, built the way the content-width row is ([F07]), and the write goes through one `_commitImposition` so the settle measures once. The user chose presets over a free number; a pixel field remains a small later swap if presets prove too coarse.

**[B08] The default stays 5 for now.** The user will retune on the live deck and change the default afterwards. So this work changes no pixel until a preset is chosen, every existing test holds at its current numbers, and the default's eventual move is one line in the preset table plus whichever tests spell 5 by hand ([F06]).

**[B09] Preset pixels are a starting proposal.** Something like 5, 12, 20 and 32, named in the Layout card's one-word idiom. The numbers are taste the user will settle by looking; the brief fixes only that there are four, that the first is today's 5, and that they live in one table.

---

## Open Questions {#open-questions}

- **Preset names and pixels.** Proposed in [B09]; settled by the user looking at the deck, not by prose. Does not change what gets written, only the table's contents.

---

## Non-goals {#non-goals}

- **Separate knobs for edge gap, seam gap and rail gutter.** Rejected in [B01]; one rhythm, one number.
- **Moving the rail's outer edge or top.** Rails stay flush ([B04]).
- **Changing the default gap in this work.** Deferred by the user until after retuning ([B08]).
- **A free numeric field.** The user chose presets ([B07]).
- **Scaling the Layout miniature's gap.** It draws an exaggerated gap of its own and is independent of the deck's pixel gap ([F08]).
- **Changing content-width presets or the N-up kinds.** A larger gap narrows the band and the imposer already handles a band narrower than its slots through flow travel and fit; no width or kind changes with it.

---

## Exit {#exit}

**An arc.** The natural order:

1. Make the card gap live in `layout-imposer.ts`: getter, setter, property, the `GAP` string as a `var()`, the gutter and maker bottom gap derived from it ([B02], [B03], [B05], [B06]). Stamp all three properties in `main.tsx` and wire the change cue to the existing re-impose path. Unit tests in `src/lib/__tests__` follow the symbol; add one that moves the gap and checks `railSpanInsetPx`, `flowBandEdges`, the flow strip length and `railGapBottomPx` move with it.
2. Move the thirteen outside numeric reads ([F05]) to the getter, so snap, seams, drop zones, caps, sheet reservation and run heights all track.
3. Add the `gap` axis to `DeckImposition` with its preset tables and a `setGap` that commits once ([B07]); persist and restore through the layout blob.
4. Add the Layout card row ([B07]); check the focus-order census tests that enumerate the card's rows, since a new always-live control is what broke `at0312` and `at0339` before.
5. Verdict: the app-tests that import the gap ([F06]) run once at the end, alone, with the default unchanged, plus one app-test that selects a non-default preset and reads a frame's rect against the expected pins.
