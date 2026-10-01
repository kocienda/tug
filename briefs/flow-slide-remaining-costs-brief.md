<!-- brief-skeleton v1 -->

# The flow slide: the six costs left after the rail fix

**Purpose:** Activating a card across the flow strip still does not animate smoothly on a real deck. One cause was a regression and is fixed in the working tree; six more were measured in the same investigation and are untouched. This brief records what each one is, how sure the reading is, and the order they are taken in.

---

## Purpose {#purpose}

The user, on the live deck (2026-09-30):

> *Right now* on this deck with these cards, clicking in the Workspaces sidebar card to go from slot 1 to slot 4 *does not smoothly animate*. It jumps and I lose frames.

And after the first cause was found:

> Sidebar cards in their rails DO NOT MOVE when slots change. PERIOD EVER.

The gesture is a Workspaces row click (`focus-session-card`) that moves focus between the cards in slots 1 and 4 and slides the flow strip one card width. On the `release-main` deck it delivered 2–3 frames in its first 200 ms where 12 were due, then two long frames when the settle ended. The deck held about 23,000 elements: three session cards in slots 1, 2 and 4, a left rail of Dashes, Jots and Overview, and a right rail of Workspaces and Layout, at 2874×1640 and 2×.

The rail regression is context here and not subject. The flow slide's pre-launched tween ran on every shown pane, rails included; it now runs only on panes that read the strip's offset (`tugdeck/src/components/chrome/deck-canvas.tsx`, the prelaunch loop), and `tests/app-test/at0621-intra-workspace-slide.test.ts` asserts the rail pane's rect never changes across a slot walk. That fix is uncommitted in the working tree as this is written.

What remains is six costs. None is a regression in that sense. Each is something the design currently carries.

---

## Evidence {#evidence}

All readings are from the user's `release-main` instance through the loopback eval door, driving the real row click, with `/usr/bin/sample` on the WebContent, GPU and `Tug` processes. Frame gaps came from a `requestAnimationFrame` recorder armed before the gesture; main-thread blocking from a zero-timer heartbeat. Every reading below predates the rail fix reaching a build, so the gesture-level numbers include the rails' share.

**[F01] `--tugx-pane-dot-ink` restyles a whole pane on every focus change.** The property is declared on `.tug-pane` and overridden on `.tug-pane:not([data-focused="true"])` (`tugdeck/src/components/tugways/tug-pane.css`, about line 810). It is an ordinary custom property, so it inherits into every descendant. Flipping `data-focused` on one pane and forcing style cost 15 ms at about 2,000 elements, 26 ms at about 4,000, and 47–53 ms on the Overview at about 10,000. A computed-style diff over every 25th descendant of a session pane showed the ink as the only property that changed on all 158 of 158 sampled elements. With the value pinned inline on the pane so it could not change, the same flip cost 1 ms or less. No layout was involved. **(verified, measured and confirmed by pinning)**

**[F02] That restyle lands inside the deferred React commit, during the slide.** The `data-focused` attribute flips in the deferred commit rather than the click task. From `tug:react-notify` to `tug:last-pass` the commit ran 41–62 ms as shipped and 8–10 ms with the ink pinned on every pane, across eight gestures each way. **(verified, measured)**

**[F03] Three highlights are registered for the life of the page with no ranges, and WebKit pays for each at every text paint.** `CSS.highlights` held `transcript-find-match`, `transcript-find-active` and `inactive-selection`, each with zero ranges. In the samples covering the gesture's first frames, `MarkedText::collectForHighlights` was 162 of 321 paint samples: it resolves a `::highlight()` pseudo-element style per text box per registered name, whether or not the highlight has ranges. **(verified, profiled)**

**[F04] The find highlighter keeps its pair registered on purpose, on a premise the profile contradicts.** `tugdeck/src/components/tugways/transcript-find-highlighter.ts` says the pair is "never removed from `CSS.highlights`: an empty highlight paints nothing, so there is nothing to clean up." It paints nothing and it is not free. `selection-guard.ts` registers `inactive-selection` the same way; `filter-mark-painter.ts` already sets and deletes its own name around use. **(verified, read from the code)**

**[F05] Unregistering the three saved little on this gesture.** Main-thread blocking in the first 260 ms fell from about 200 ms to about 185 ms over eight gestures each way, and the frame gap did not move. Paint was not the bottleneck of this gesture. The tax in [F03] applies to every text repaint in the app, streaming transcripts included; that wider cost was not measured. **(verified for this gesture; the app-wide cost is inferred from the mechanism)**

**[F06] Starting a transform animation on a pane costs a long first frame, and the cost grows with what the pane holds.** Bare `el.animate` tweens were run from the eval door with no app work at all. The three content panes moving 680 px delivered 10–11 of 12 frames in the first 200 ms, with a first gap of 58–64 ms. An identity tween that moves nothing gave a first gap of about 26 ms on a 1,272-element session pane, 23–26 ms on one of 3,444, 58 ms on one of 3,456, none on the 1,314-element Layout pane, and 125–130 ms on the Overview at 12,349. **(verified, measured; single readings per session pane, two on the Overview)**

**[F07] That cost is spread over three processes, so the gap stands while the web main thread is idle.** With the ink pinned, the highlights unregistered and the rail tweens stilled together, main-thread blocking in the lead halved, from about 215 ms to about 110 ms, and the gap to the second frame stayed at about 150 ms. Samples ending shortly after the click showed text paint into ordinary (non-tiled) layers in the web process; 50–58 busy samples on the GPU process's `RemoteRenderingBackend` queue per one-second window against 12 in two seconds at rest; and about 34 samples per gesture on `Tug`'s own main thread in `CAIOSurfaceCreate`, most of it building a colour space from an ICC profile per new surface. No layer creation showed in the web process. **(verified, profiled)**

**[F08] Why the engine repaints at animation start is not known.** The panes are standing layers (`will-change: transform`), and a `data-focused` flip alone repaints almost nothing (2–3 ms of paint and commit, measured in isolation). The working guess is that a running transform animation changes compositing decisions for the pane's descendants, which then need fresh backing stores. That is inference from the three-process shape in [F07], and nothing here proves it.

**[F09] Two long frames at the land, in every run.** Around 430–490 ms after the click, two consecutive frames of 28–45 ms. A phase reading put them at 0 ms of style and layout and 25–38 ms of paint and layer commit. The DOM writes at that moment are the settle's hand-back: inline style on every pane, `data-imposer-settling` removed from the canvas and every pane, and the flash class. Whether the cost is the mirror of [F06] or the hand-back itself was not investigated. **(verified that they occur and that they are paint-side; cause not investigated)**

**[F10] Any frame with a style change costs about 6 ms on this deck before paint.** Writing a 1 px width on a hidden fixed element each frame, at rest, read 6–7 ms from the frame's start to the end of style and layout, and 1 ms of paint. At-rest samples put nearly all of it in `updateCompositingLayersAfterStyleChange` and `computeCompositingRequirements`. `tugtool deck motion layers` reported 23,116 elements, 1,435 stacking contexts and 7,226 render-layer candidates. A steady tween frame read 10–12 ms to the end of style and layout plus 2–6 ms of paint, against a 16.7 ms period. The tween-frame figure includes the probe's own write. **(verified, measured)**

**[F11] The Overview card is the largest thing on the deck, is not skipped when unseen, and grows as sessions work.** It held about 9,600 elements at the start of the investigation and 12,349 half an hour later: 908 approximate stacking contexts, 173 `position: sticky` elements, 48,605 characters of text, and no element with `content-visibility: auto`. It is the pane [F06] prices at 125–130 ms. With the rail fix it no longer joins a flow slide. **(verified, measured)**

**[F12] Three things were ruled out.** The focus flip's own paint is 2–3 ms. The `data-imposer-settling` and `data-resize-episode` marks cost 0–2 ms to flip. A write of the flow offset costs 1 ms. **(verified, measured in isolation)**

### The re-reading, on the rebuilt deck (2026-10-01)

Taken per [B05] on the user's `release-main` instance running `6d294fcf1`, which carries the rail fix, the ink fix [B01] and the highlight rule [B03]. Same instruments: the loopback eval door, a `requestAnimationFrame` recorder and a zero-timer heartbeat armed in the page before each gesture, the gesture driven as pointer and click events on the Workspaces row, and `/usr/bin/sample` on the WebContent, GPU and `Tug` processes. **The deck is not the deck above.** A relaunch took it to 10,927 elements, 718 stacking contexts and 3,456 render-layer candidates, against 23,116, 1,435 and 7,226; the Overview held 3,745 elements against 12,349; the two session panes held about 1,400 and 3,940. Two session cards stood in slots 1 and 4, at 2874×1640 and 2×. Every number below is that deck's, and a difference from the numbers above is the fixes and the smaller deck together, not the fixes alone.

**[F13] The real gesture now delivers its frames.** Sixteen Workspaces-row clicks, eight each way between slots 1 and 4: 10–12 of 12 frames in the first 200 ms (2–3 above), the first frame 34–41 ms after the click, no gap in the first six frames over 23 ms. Main-thread blocking in the first 260 ms read 212–226 ms, essentially unchanged from [F05]'s ~200, so the frames came back without the main thread getting quieter: the lead's cost was frame-blocking work off the main thread, or work the main thread no longer does inside a frame. **(verified, measured)**

**[F14] The start cost of a transform animation is gone on this deck.** The bare identity-tween bisect of [F06], three runs per pane on all seven panes: first frame 10–24 ms after the animation starts and worst start gap 17–34 ms on every pane, the Overview included (23–58 ms on session panes and 125–130 ms on the Overview above). A bare 680 px tween on both content panes together delivered 11–12 of 12 frames in its first 200 ms with a first gap of 16–30 ms (10–11 and 58–64 above). **(verified, measured; the Overview is a third of the size it was)**

**[F15] The land frames are gone, and the bare tween answers where they came from.** The settle marks went on 31–35 ms after the click and off 444–458 ms after; no frame over one period landed at the hand-back in any of twenty gestures. An occasional single 26–43 ms frame remains mid-slide, near 340–356 ms, in about half the gestures (and a few at 780–1,170 ms, after the slide). A bare 680 px tween with no hand-back ends on one 19–26 ms frame followed by a 6–13 ms catch-up in every run: that is the end of an animation with no fill snapping its panes back, and it is the size the bare tween's end costs. So [F09]'s two 28–45 ms land frames were neither the start cost's mirror nor intrinsic to an animation's end; on this build the hand-back's writes land without a long frame. **(verified, measured; which of the three fixes removed them is not separated)**

**[F16] The paint tax is gone from the gesture's samples, and the compositing walk is what remains.** Across four gestures sampled at 1 ms, the WebContent main thread spent 35 samples in rendering updates: 19 in `RenderLayerCompositor::computeCompositingRequirements` under `updateCompositingLayersAfterStyleChange`, about 5 painting backing stores and committing layers, and none in `MarkedText::collectForHighlights` (162 of 321 paint samples above). The `Tug` main thread's sample showed `CAIOSurfaceCreate` on a single stack line. The GPU process's `RemoteRenderingBackend` work-queue share was not broken down. **(verified, profiled; GPU and `Tug` shares partial)**

**[F17] What the re-reading says about [F08].** The guess that a running transform animation changes compositing decisions so that a pane's descendants need fresh backing stores predicted a start cost that scales with what the pane holds. On this deck a moving pane of 3,940 elements starts as cleanly as one of 34, and the paint and surface creation [F07] priced at animation start barely show. Either the guess was wrong, or what it described was driven by the inherited restyle [F01] and the highlight resolution [F03] that both fixes removed, which re-styled and re-painted every text box in a moving pane. This reading cannot separate the two, and the smaller deck weakens it further: the Overview that priced the start at 125–130 ms is a third of its old size. **(inference from [F13]–[F16])**

---

## Decisions {#decisions}

**[B01] The dot ink stops inheriting.** The ink reaches only the element that paints it, either by declaring it on the dots field under a selector keyed on the pane's focus, or by registering the property with `inherits: false` as was done for `--tug-imposer-flow-offset`. Which of the two is the implementer's call; the requirement is that a focus flip no longer invalidates the pane's subtree. The look of the dots does not change. This is taken first because [F01] is confirmed by pinning, the fix is small, and it is paid on every focus change in the app, not only on this gesture.

**[B02] The ink fix carries a pin that cannot flap.** The test flips focus on a pane and asserts that a deep descendant's computed `--tugx-pane-dot-ink` does not change, or an equivalent count of restyled descendants. It does not assert a duration: [F01]'s milliseconds are the evidence, and a timing bar on style recalc is the kind that rotates.

**[B03] A highlight is registered only while it has ranges.** This reverses the highlighter's standing choice in [F04], whose stated reason was that an empty highlight costs nothing. All three names follow the rule `filter-mark-painter.ts` already keeps: set on first range, deleted when the last range goes. What would revisit this: an engine that skips empty highlights at paint, at which point the rule is harmless rather than wrong.

**[B04] The highlight rule carries a pin on the registry.** With no find active and no inactive selection standing, `CSS.highlights.size` is zero; with a find active it holds the find's names and they paint. The app-wide paint saving is not asserted, because [F05] did not measure it.

**[B05] The tween's start cost and the land frames are re-measured before anything is designed.** [F06], [F07] and [F09] were all read while the rails were still joining the slide. The first act is the same bare-tween bisect and the same lead-window samples on the user's deck, on a build carrying the rail fix. Only that reading says how much of the 60 ms and of the land frames is left, and whether [F08]'s guess survives.

**[B06] The premise that a slide over standing layers is free regardless of content is withdrawn.** `briefs/deck-animation-pipeline-brief.md` rests its first decision on it. [F06] contradicts it on this engine with real content: an animation that moves nothing costs up to 130 ms to start. The standing promotion stays; what goes is the claim that it settles the first frame.

**[B07] Frame headroom and the Overview's size belong to the unification work, not to an arc of their own.** [F10] and [F11] are properties of how much is on the deck. They are carried into `briefs/graphics-animations-asks.md` as findings, with the numbers above, so that work starts from a measured floor: about 6 ms per style-changing frame at 7,000 layer candidates.

**[B08] No bar on these readings is loosened to pass.** `at0622`'s lead clauses stay where they are. A change here is accepted on a before-and-after reading on the user's deck, not on a bench whose rails are small: that is how the rail regression went unseen.

---

## Open Questions {#open-questions}

- **Why does the engine repaint when a transform animation starts on a standing layer [F08]?** It decides whether the start cost can be removed (a property of how the pane's descendants are layered) or only bounded (by holding less inside a moving pane). Settles it: the re-measurement in [B05], then a bisect inside one session pane, removing sticky elements, stacking contexts and blended layers in turn under a bare identity tween.

- **Are the land frames the mirror of the start cost, or the hand-back's own writes [F09]?** Settles it: a bare tween with no hand-back, read at its end on the rebuilt deck. If the bare tween lands clean, the cost is the settle's writes.

- **Should the Overview's rows be skipped when unseen, or should the card hold fewer of them [F11]?** The first keeps every post and changes how the engine treats them; the second changes what the card shows. That is a product call about the Overview, and it is the user's.

- **How much does [B03] save across the app?** Not measured. Settles it: a paint-heavy reading, such as a long streaming turn, sampled before and after.

---

## Non-goals {#non-goals}

- **The rail regression.** Fixed and pinned in the working tree; described under Purpose so this brief reads whole.
- **Loosening any frame bar.** [B08].
- **A new animation primitive or pipeline.** That is `briefs/graphics-animations-asks.md`. This brief feeds it findings and does not pre-empt it.
- **Designing a fix for the start cost before [B05]'s reading.** Every earlier fix for this gesture was designed against a bench and missed; the multiplier is content the bench does not carry.
- **Reducing the compositing walk by hand.** [F10] is recorded as a floor. Cutting stacking contexts card by card is a wide change with no measured target yet.
- **Auto-demoting motion on a slow deck.** The product does not take the user's animations away on a reading.

---

## Exit {#exit}

**An arc.** The shape of the first steps:

1. The dot ink stops inheriting, with its pin [B01], [B02].
2. Highlights register only while they have ranges, with the registry pin [B03], [B04].
3. On a build carrying the rail fix and steps 1 and 2, re-take the readings on the user's deck: frames in the first 200 ms for the real gesture, the bare-tween bisect, the lead-window samples, and the land frames [B05]. Record them beside the numbers above.
4. Write [F10], [F11] and the withdrawn premise into the unification material [B06], [B07].

Steps 1 and 2 are independent of each other. Step 3 comes after both, so its reading is taken on the deck as it will stand. What follows step 3 depends on what it reads, and the two open questions about the start and the land are what it answers.
