<!-- brief-skeleton v1 -->

# A sidebar card's height is measured from its content, with a carve-out for streams

**Purpose:** Three arcs have tried to make a rail stand its cards at the height their content needs, and every one has shipped with wrong numbers, because every number is a hand-maintained sum of pixel constants that nothing in the build can check. In Flow today Layout is clipped, Jots scrolls, and Cards holds a band of empty space, with a screen of vacancy under all three. This brief reverses the decision that a card must declare its height from state and never measure it: a card's natural height is the measured height of a content element that can never depend on the height it feeds. Cards whose content is by nature as tall as their pane — the Overview transcript, and any stream like it — are carved out by declaration.

---

## Purpose {#purpose}

> "I'm set to Flow. You've clipped the Layout card horridly, and Jots is still scrolling even with all that room under Layout!!! … It feels like we're not converging on a set of workable algorithms. This just doesn't feel close."

The screenshot: a right rail in Flow holding Cards, Jots and Layout. Cards shows four sessions and one file, then empty space below its FILES group. Jots shows ten rows with a scrollbar, its eleventh cut off. Layout shows a two-line caption, the drawing, the preset strip and the top of its OPTIONS header, cut mid-line. Below Layout the rail's vacancy runs for a full screen. Flow's one promise is that each card stands at its content's height. None of the three does.

This is the third brief on this rail. `briefs/rail-vertical-allocation-brief.md` built the allocator and declared the appetites. `briefs/rail-appetite-truth-brief.md` re-derived every appetite from its CSS rules and proved them with a test. `briefs/rail-seams-belong-to-the-hand-brief.md` gave Fit's seams to the hand and left Flow, the seed and Fit to Content reading the same declarations. This brief takes the declarations away.

---

## Evidence {#evidence}

**[F01] Layout is clipped because its caption is declared as one line and rendered as two.** `LAYOUT_CAPTION_PX = 42` in `layout-card.tsx` is the title line plus one note line. The note in the screenshot is "4 cards side by side, 675 px each — the deck and the right rail scroll", which wraps at the rail's width now that the tail names two scrolling things. The OPTIONS header added in `268737f0a` is a further line the comfort sum was written before. The card asks for less than it draws, and Flow gives it exactly what it asks. **(verified — the constant, the screenshot, and the two commits)**

**[F02] Jots scrolls because `JOTS_ROW_HEIGHT_PX = 28` is not the height of a jot row.** Jots declares `JOTS_HEADER_PX + jots.length × 28` as natural (`jots-card.tsx:985–988`). Eleven jots stand taller than that on screen, so the card is short by a row and scrolls. The previous brief's `[B01]` re-derived this constant "from the row's own rule" and the app test that pinned it was green. **(verified — the declaration; the row's true pitch was not measured, which is the point)**

**[F03] Cards over-declares, so it stands over empty space.** Its census by row kind (`cards-data-source.ts:897`) sums a session row, a group header and a file row at fixed heights. In the screenshot the sum exceeds what four sessions and one file paint, and Flow stands the card at the sum. **(verified — the screenshot; the per-kind constant that is wrong was not identified)**

**[F04] The allocator did exactly what it was told, in all three cases.** `flowHeightsOf` returns `max(floor, natural · weight)` per member, and the heights census asserts it. There is no allocator defect in the picture. **(verified — read at `adeff213b`)**

**[F05] Every appetite is a sum of pixel constants, and nothing in the build can tell when one goes stale.** The constants describe line heights, paddings, gaps, row pitches and caption line counts. Each was correct when written and each is invalidated by an ordinary change to CSS, to a caption's copy, to a rail's width, or to a card's chrome. The check the previous brief added (`[B13]`, `scrollHeight ≤ clientHeight + 1` at declared natural) runs on one fixture at one width and passed while `[F01]`–`[F03]` were all true. Three arcs in a row have shipped with wrong appetites; the contract is not maintainable. **(verified — by the three arcs' history)**

**[F06] The no-measurement rule was made for a specific loop, and that loop has a structural cause.** The rail-vertical brief's `[B03]` refused DOM measurement on the precedent of the composer's line-box metric (2026-09-07): a publisher that re-measured on `geometryChanged`, which its own publish caused, and whose measured value depended on the field's height. The loop needs both legs: the measurement must feed the layout *and* depend on it. A measurement of an element whose height does not depend on the pane's height has only one leg and cannot oscillate. **(verified — `tug-text-editor/line-box-metric.ts` and the memory of the incident)**

**[F07] The machinery downstream of a natural is sound and stays.** `cardAppetiteStore`, `DeckState.appetites`, the quiet-period settle, the signature term, the Fit seed (`seedSharedHeights`) and Fit to Content all consume a `natural` per card and do not care where it came from. Only the producers — the `useCardAppetite` calls in six cards and the constants behind them — are wrong. **(verified)**

**[F08] Overview is the one card whose content is as tall as its pane by nature.** It declares `natural = Infinity` (`overview-card.tsx:963`), the allocator reads a stream as one screen of itself in Flow, and Fit's seed gives a stream the discretionary pool. Its transcript is a virtualized list whose rendered rows depend on its height, so a measurement of it would have both loop legs. **(verified)**

**[F09] `overflow-y: scroll` is now permanent on every sidebar scroller ([D182]), so a card's content width, and therefore its wrapped height, no longer changes when the bar appears.** That removes the one way a content measurement could depend on the card's own height indirectly, through a scrollbar arriving and reflowing the text. **(verified — landed today)**

---

## Decisions {#decisions}

### The measurement

**[B01] A sidebar card's natural height is measured, from one content element, by a `ResizeObserver`.** Each sidebar card names a single **content element** — the column of everything it draws, from its toolbar to its last row — and a `ResizeObserver` on that element publishes its border-box height as the card's `natural` through the existing store. The content element is not the pane, not the scroller, and not anything stretched to fill either. Its height is a function of the rail's width and the card's data only. Card-specific constants (`LAYOUT_CAPTION_PX`, `JOTS_ROW_HEIGHT_PX`, the Cards row-kind census and their kin) are deleted. This reverses the rail-vertical brief's `[B03]`: that decision protected against `[F06]`'s loop, and `[B02]` here cuts the loop structurally rather than by forbidding measurement.

**[B02] The content element must not depend on its pane's height, and a test proves it per card.** The invariant: with the rail at a fixed width, the content element's measured height is identical when its pane is 300px tall and when it is 1200px tall. It holds by construction when the content element is an in-flow block inside an `overflow-y: scroll` scroller with no `height: 100%`, `min-height: 100%`, or block-axis `flex: 1` between the scroller and the element. A `TugListView`'s content is its spacer-plus-window column, whose height is the sum of row heights and the spacers' written heights, not the viewport's. The per-card check lives in `at0542` and is the successor of the previous brief's `[B13]` check, which asserted the declaration matched the content; this asserts the measurement cannot be moved by what it feeds.

**[B03] Comfort is retired. The only tier is natural, bounded below by the registered floor.** Comfort existed so Fit's ladder could hold a card at a readable height before dividing the rest, and the rail-seams arc removed the live ladder from Fit. The seed now reads floors and naturals; Flow reads naturals; nothing reads comfort. `CardAppetite` becomes `{ natural }`, `useCardAppetite` takes one number, and the registrations' `greedRank` survives only for the seed's slack.

**[B04] The measurement is published on the store's existing quiet period and nothing else.** A `ResizeObserver` fires per layout; the store's settle already waits `RESIZE_RETUNE_QUIET_MS` and compares snapshots, so a card whose content is still settling publishes once, after it stops. No new timer, no polling. Under Fit a publish commits no imposition (the rail-seams `[B02]`); under Flow it re-stands the strip, which is what Flow means.

### The carve-out

**[B05] A card whose content is as tall as its pane by nature declares itself a stream, and a stream is never measured.** `CardRegistration` gains `heightSource: "content" | "stream"`, default `"content"`. A stream publishes no measurement and no number: the store reads its natural as `Infinity`, which is what Overview publishes today. Flow stands a stream at one screen of the run; Fit's seed hands it the discretionary pool; a rail of streams alone divides equally. The registry is the right place because whether a card's content depends on its height is a fact about the kind of card, not about any instance of it, and it belongs beside `layoutRole` and `minHeight`.

**[B06] Overview is a stream, and the rule for the next one is written down.** A card is a stream when any of these is true: its rows are virtualized against its own viewport; it follows its content's tail (a transcript, a log, a feed); or it has no finished height at all. A future session-like card, a trip log that streams, or a live diff would all declare `"stream"`. A card that merely scrolls is not a stream. The doctrine paragraph in `tuglaws/pane-model.md` states the test in these words so the decision is made at registration and not rediscovered in an allocator bug.

**[B07] The invariant test is what admits a card as `"content"`.** A card registered as `"content"` must pass `[B02]`'s check; a card that cannot is a stream and says so. This is how the carve-out stays honest: the choice between the two is a test's verdict, not a judgment.

### What does not move

**[B08] Fit, the seed, Fit to Content and the layout row are unchanged.** The rail-seams arc's rule stands. The seed and Fit to Content read the measured naturals in place of the declared ones and are otherwise untouched. `Stack | Fit | Flow` rows, the badge menu and the caption tail are as landed.

**[B09] Floors stay registered, not measured.** A floor is the least a card can paint without breaking, which is a design number rather than a fact about content, and it must exist before the card has rendered. `minHeight` on the registration is unchanged.

---

## Open Questions {#open-questions}

- **Whether the first paint after a card mounts should wait for its first measurement.** A newly opened sidebar has a floor and no natural for one frame. The recommendation is to stand it at its floor in Flow and let the first publish re-stand it, the same as any content change; the alternative, a deferred first commit, adds a state nobody sees for long. Settle in the app.
- **Whether a stream may also carry a *preferred* height.** Overview at one screen is right; a future feed card might want less. If so, a stream's registration could carry a run fraction. Not needed for anything registered today.

---

## Non-goals {#non-goals}

- **Correcting the constants again.** Rejected by `[F05]`: three arcs of corrected constants each shipped wrong.
- **Measuring the pane or the scroller.** A scroller's `scrollHeight` is `max(content, client)` under `overflow-y: scroll`, so it reports the pane's height whenever the content is shorter, which is one loop leg. Only the content element is measured.
- **A measurement in Fit that moves a seam.** Still the rail-seams rule; content never moves a seam.
- **A card-level collapse to the title bar.** Still its own feature.
- **Re-serializing appetites.** They remain session state, derived on every launch.

---

## Exit {#exit}

**An arc.** The shape, in the order it must land:

1. **The invariant check, red where it must be** (`[B02]`, `[B07]`) — per content card, measured height at two pane heights is equal; written against the content element each card will name, so it fails on any card whose column is stretched today.
2. **The registry flag and the store's one tier** (`[B03]`, `[B05]`) — `heightSource` on `CardRegistration`, Overview declared `"stream"`, `CardAppetite` reduced to `{ natural }`, the store reading a stream as `Infinity`, and every consumer of `comfort` retired, including the seed's comfort stage and the census rows that assert it.
3. **The observers** (`[B01]`, `[B04]`) — a content element and a `ResizeObserver` per content card, replacing each card's constants and census; the check goes green; the Flow screenshot's three defects are gone with no allocator change.
4. **The doctrine** (`[B06]`) — `tuglaws/pane-model.md` states that a card's height is measured from a content element that cannot depend on its pane, names the stream test, and retires "declared, never measured" with a pointer to why.

Step 1 must precede step 3, or a stretched column measures its own pane and the loop the old rule feared is back. Step 2 is separable and small.
