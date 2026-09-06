<!-- brief-skeleton v1 -->

# The Flow Band Occludes Rather Than Cuts

**Purpose:** A flow deck slices every straddling card with a full-height razor at the band's edge. The cut is at an arbitrary interior line, it lands mid-glyph, and it reads as breakage. Replace the cut with real occlusion — the card slides *behind* the rail — and cap the one strip a rail cannot cover.

---

## Purpose {#purpose}

> "It is *downright weird* the way that cards are clipped when they run off the end of the flow layout. I do not like this. We need a different solution."

The report came with a screenshot: a card cut vertically down its middle, showing the tail ends of its lines with no edge, no corner radius, and no shadow — the geometry simply stops. The complaint is not that a card is partly visible. It is that the boundary is a guillotine at a line nothing on screen explains.

The current behaviour is deliberate and is written down. `tuglaws/pane-model.md:125` states it as the second of two rules — "**the band clips**: a flow pane's ink stops at the band edges through a `clip-path` in `imposeStyle`'s flow branch" — and defends it as what makes "the half-visible card IS the affordance" true in pixels rather than only in arithmetic. That defence is sound about *why the ink must stop*. It never established that the ink must stop by being **cut**.

---

## Evidence {#evidence}

**[F01] The razor is one `clip-path` and about sixty lines of algebra defending it.** `tugdeck/src/lib/layout-imposer.ts:1441`–1500: the flow branch of `imposeStyle` emits `clip-path: inset(…)` built from `bandClip`, `clipLeft`/`clipRight`, `offsetOfViewport`, `bandOfViewport`, `FLOW_CLIP_SLACK_PX` (32) and `FLOW_CLIP_STEP_GAIN` (1000). Fit emits no clip at all. **(verified — read out of the source.)**

**[F02] Rails already stand above every free card. The occlusion this brief wants exists; the clip forbids it.** `tugdeck/src/components/chrome/deck-canvas.tsx:902` builds the z map: a rail gets `SIDEBAR_PANE_ZINDEX_BASE + rank` (8990–8999), every free card gets `CARD_ZINDEX_BASE + i` (1..N). A flow card travelling toward a rail is painted under it today, and would disappear behind it cleanly if it were allowed to arrive. **(verified.)**

**[F03] The region the razor protects is five pixels wide.** `imposeSidebarStyle` (`layout-imposer.ts:2892`) pins a rail at `left: GAP` on the left and `100% - width - GAP` on the right, with `IMPOSITION_GAP_PX = 5` (`layout-imposer.ts:831`). The "margin the rail stands off the window edge … the one region no rail width can cover" is exactly that 5px strip, on each side. The deck is spending a full-height cut across its tallest surface to defend it. **(verified.)**

**[F04] There is no vertical leak to defend at all.** A free pane takes `top: run.top`, `bottom: run.bottom` (`imposeStyle:1399`), and a rail takes the same run through `railMemberPins` — `GAP` at the top, `GAP_BOTTOM` at the bottom. A card passing behind a rail is exactly the rail's vertical extent and cannot peek above or below it. A size-locked card is shorter and centred inside the same run, so it cannot either. **(verified.)**

**[F05] The step-gain machinery exists solely to keep the razor from shearing a flush card's shadow off.** The comment block at `layout-imposer.ts:1459`–1480 records the defect: a plain `max(−SLACK, overhang)` spends the slack as the card *approaches* the edge and has spent all of it at flush — and flush is where slot 0 rests whenever the strip is home and where the last slot rests at the far end, which the clamp pins there. Both cards lost their drop shadow and their whole flash ring on that side, permanently, and ⌃⌘1 and the last digit are the two chords most likely to land on them. The step function is a correct fix to a problem the clip created. Deleting the clip deletes the problem. **(verified — the fix is pinned by `layout-imposer-flow.test.ts:945`, "the band clip spends its slack all at once, or not at all".)**

**[F06] The flow strip's veil readout never depended on the clip, and survives the change within its own resolution.** The veils are pure arithmetic over three numbers — `flowOffset`, `strip.width`, `band` — published as `--flow-strip-offset` and `--flow-strip-band-share` and projected by CSS (`flow-strip.css`, `flow-strip.tsx`). No term in either rectangle reads anything the clip writes. What the clip underwrote was the *agreement* between that arithmetic and what paints, and that agreement is preserved by geometry: `deck-canvas.tsx:1835` writes `--tug-imposer-inset-<side>` as `railWidth + GAP`, and the band's own left edge is `INSET_LEFT + GAP`, so the band edge stands one `GAP` **inboard of the rail's inner edge**. Under occlusion the ink therefore stops at the rail's inner edge, which is 5px outboard of where it stops today, on each railed side. On a side with no rail the inset is `0px`, the band edge is `GAP` from the window, and the cap ([B02]) stops the ink there exactly. **(verified by reading the two expressions; the 5px is arithmetic, not a measurement — a screenshot at a band edge would confirm it.)**

**[F07] Three test files assert the clip, and one of them is the load-bearing pin.** `tugdeck/src/lib/__tests__/layout-imposer-flow.test.ts` (five references, two whole tests), `tests/app-test/at0454-flow-mode.test.ts` (the margin pin), `tests/app-test/at0121-list-view-container-focus.test.ts` (incidental). `at0454` is the one that matters: it drives a card to straddle a band edge and asserts, via `elementFromPoint` in the rail's outer margin, that **background** answers there while the same card still answers inside the band. **(verified.)**

**[F08] The canvas ground is not a flat colour — it is a 24px grid, and a flat cap would sever it.** `tugdeck/src/globals.css:31`–37 paints `body` with `--tug7-surface-global-primary-normal-canvas-rest` *plus* two `linear-gradient` background images at `background-size: 24px 24px`, in `--tug7-surface-global-primary-normal-grid-rest`. A cap painted in the flat canvas colour would therefore read as a 5px stripe down each window edge, cutting every horizontal grid line short and dropping the vertical line at x=0 — forty-odd interruptions down the height of the window. This is the failure the cap's colour question was worried about, and it is real rather than hypothetical. **(verified — read out of the source.)**

**[F09] The deck canvas spans the window, and the margin currently answers as bare canvas.** The deck root and `containerRef` are both `position: absolute; inset: 0` inside `#deck-container`, which is `width: 100%; height: 100%` on the body (`deck-canvas.tsx:3509`, `:3531`, `globals.css:40`) — the same premise the clip's `100vw` term already rests on. `containerRef` also carries `CANVAS_BACKGROUND_ATTRIBUTE`, and `gesture-interpreter.ts:310` matches it on **target identity**, so a press in the rail's outer margin strikes that element today and reads as a deliberate deselect. **(verified.)**

**[F10] The third test file is unrelated and stays untouched.** `at0121-list-view-container-focus.test.ts:209` reads the `clipPath` of a list-view cursor caret's `::before` and asserts it is `none` — a guard against a tapered-trapezoid caret shape returning, with no connection to the flow band or to `imposeStyle`. The grep hit and the dependency are different things here. **(verified — read in full.)**

---

## Decisions {#decisions}

**[B01] The band stops the ink by occlusion, not by cutting it.** The `clip-path` and everything built to serve it — `bandClip`, `clipLeft`/`clipRight`, `offsetOfViewport`, `bandOfViewport`, `FLOW_CLIP_SLACK_PX`, `FLOW_CLIP_STEP_GAIN` — come out, and the flow branch collapses to the single `style.left` expression the rest of the module looks like. What stops the card is the rail, which is opaque, is already above it ([F02]), and casts its own shadow over what it covers. A card that ends in a rail's shadow says *there is more, behind this*, the way a physical deck says it; a card that ends in a razor says something is broken. The half-visible card remains the affordance — it stops being sliced and starts being overlapped. Revisit if rails ever stop being opaque or stop outranking free cards.

**[B02] A margin cap covers the strip no rail can stand in, and it carries the ground rather than a fill.** Two elements — one per margin, because two margins is what there is; a single element with a hollow `clip-path` would be one node at the cost of reintroducing a clip expression for nothing. Each is `top: 0; bottom: 0`, `width: IMPOSITION_GAP_PX`, at `left: 0` and `right: 0` of `containerRef`, at a z between the topmost free card and `SIDEBAR_PANE_ZINDEX_BASE` — above every card, below every rail. That is [F03]'s five pixels and nothing else.

**Each cap paints the body's own ground, grid included** — `background-color: var(--tug7-surface-global-primary-normal-canvas-rest)`, the two `linear-gradient`s in `--tug7-surface-global-primary-normal-grid-rest`, at `background-size: 24px 24px` — because [F08] says a flat fill is a visible stripe. It is one token pair rather than a judgment call, and it is right in every theme by construction: the cap is not *matched* to the ground, it **is** the ground, declared a second time. The alignment is bought with **`background-attachment: fixed`**, which anchors the pattern to the viewport rather than to the element's own box, so both caps land in phase with the body's grid without a single length being computed. Without it the left cap happens to align — its origin is the window's — and the right cap does not, since its own left edge falls at `windowWidth − 5` and that is not a multiple of 24; the repair for that would be a `background-position` phrased against `100vw`, which is exactly the algebra this change exists to retire.

**The cap is static geometry**: no `var()`, no offset term, nothing to re-resolve on reflow. It does inherit the clip's premise — the canvas spans the window ([F09]) — but inherits it in a far weaker form. What a violation costs the clip is a sliver of card in the margin; what it costs the cap is a grid line out of phase.

**[B03] The cap swallows the press, and reads as canvas while doing it.** `clip-path` clipped hit-testing as well as paint, so today the cut-away part of a card takes no clicks. A transparent-to-pointers cap would hand those five pixels to a card the user cannot see, which is a worse bug than the one being fixed even at that width. So the cap takes the press, and the card beneath never sees it.

Having taken it, the cap does with it what that margin does today: **each cap carries `CANVAS_BACKGROUND_ATTRIBUTE`**, so a press there still reads as bare canvas and still deselects. [F09] is why that is a restoration rather than an addition — `containerRef` holds the attribute now and the gesture interpreter matches it on target identity, so a cap that omitted it would quietly make five pixels of canvas stop behaving like canvas. Swallowing means *the card does not get it*, which is the whole of what was asked; it does not mean the press has to vanish.

**[B04] The gap between a rail's inner edge and the band edge is air the card crosses, not a leak.** [F06]'s 5px: on a railed side the card is visible in the seam for one `GAP` before it goes behind the rail. That is what sliding under something looks like, and suppressing it would need a dynamic, inset-driven cap — surrendering [B02]'s static geometry to hide the very moment that makes the occlusion legible. The overpaint is 5px against a band of several hundred, well under the sliver threshold the space allocator already grades against, so the strip's veil readout keeps telling the truth at the resolution it claims.

**[B05] On a side with no rail, the card runs to the window edge.** The inset is `0px`, the cap covers the band edge exactly ([F06]), and past it the canvas's own `overflow: hidden` does the rest. A cut at the window edge is what every window on the machine does and reads as nothing at all — which is the entire difference from a cut at an interior line, and the whole of why this change is worth making.

**[B06] `tuglaws/pane-model.md:125` keeps its first rule verbatim and rewrites its second.** The allocator's sliver scoring — a candidate that would leave a hairline of a card loses to one ending on a slot boundary or cutting an honest slice — stands unchanged: a hairline emerging from behind a rail is still a hairline, and the rule was never about the clip. The second rule, "the band clips", becomes the rails occlude and the margin is capped, carrying the same guarantee about the far edge that the veil readout depends on.

**[B07] `at0454`'s margin pin is retargeted, not retired.** The guarantee under test — *no card ink answers in the rail's outer margin while the same card answers inside the band* — is exactly the guarantee [B02] and [B03] make. `elementFromPoint` in that margin should now find the cap. The assertion changes from "background answers" to "the cap answers, and it is not a card", which is the same claim in the new vocabulary. Its `@covers` lines already name both files this touches.

---

## Non-goals {#non-goals}

- **Quantizing travel to card boundaries so the leading edge never cuts.** Considered and rejected. It removes the sliced-left-edge case honestly, but it costs the flush end-pin — the far end of the strip would carry dead air at its right rather than landing flush — and it does not help a card wider than the band, which straddles under any quantization. Occlusion fixes both without touching travel at all.
- **Drawing only whole cards.** Considered and rejected. Cleanest picture, but it deletes the peek that tells the reader there is more, and it makes cards pop into existence rather than emerge — trading a bad edge for a bad transition.
- **A soft edge: fading the overhang out over the last ~64px.** Considered and rejected. It is the smallest change by far and keeps every existing expression, but it treats the symptom: the half-card is still guillotined, just gradually, and it adds a per-pane mask layer to the surface the FLIP settle is most careful about ([D135]).
- **Touching the space allocator.** Its flow scoring stays exactly as it is ([B06]).
- **Touching vertical overflow.** An overflowing column or rail slides its strip up behind the run ([P12]) and has its own half-visible-member story at the bottom edge. Whether that edge wants the same treatment is a real question and it is not this one.

---

## Exit {#exit}

**A plan.** The work is small, ordered, and has one natural phase boundary.

The first phase is the deletion and its replacement, in one commit so the deck is never left with neither guard: strip the clip out of `imposeStyle`'s flow branch and delete the four constants and helpers that served it ([B01]), add the two caps to `containerRef` with their z, width, ground and pointer behaviour ([B02], [B03]), and rewrite the two clip tests in `layout-imposer-flow.test.ts` — the second of which ("spends its slack all at once") pins a defect that no longer exists and is deleted rather than ported.

The phase boundary is the first point at which the deck can be looked at: the app-test retarget ([B07]) and `tuglaws/pane-model.md:125` ([B06]) are the second phase, and both want the change on screen first — `at0454`'s new assertion should be written against what the cap actually answers, not against what it is predicted to answer, and the law should be written in the language of what the deck now does.

**References:** [F01] [F02] [F03] [F04] [F05] [F06] [F07] [F08] [F09] [F10] [B01] [B02] [B03] [B04] [B05] [B06] [B07] [D135] [P12]
