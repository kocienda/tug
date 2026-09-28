# The session fold's commit and land stop dropping frames

**Purpose:** A session card's fold and unfold still show a jump cut on the user's deck after the `session-fold-frames` arc, because that arc measured the fold and fixed nothing the eye can see. The readings it took name four script-forced style and layout passes that make up the lost frames. This brief is the order to fix them — not to read them again.

---

## Purpose {#purpose}

The report, on 2026-09-28, after the `session-fold-frames` arc was joined and Tug relaunched: "this *seriously did not deliver* anything worth having. I can't tell the difference on card fold/unfold. I have no idea why you touched all these files or what good it did. I *still get* dropped frames all the time." And then: "*I want the fix!* … no more navel gazing. Drive for FIXES!"

That arc's readings paper (`briefs/session-fold-frames-readings.md`) already contains the diagnosis, with numbers, and its own closing section is titled *Follow-on: the fold's commit, with numbers*. Nothing here is a new finding; it is that section promoted to the thing that gets built. The four fixes below are the whole deliverable. A reading is taken only to prove a fix landed, never as a step of its own.

---

## Evidence {#evidence}

All numbers are from `briefs/session-fold-frames-readings.md`, taken on the user's release deck on 2026-09-28 with `tugtool deck motion gesture`, `tugtool deck motion chains`, and 1 ms `/usr/bin/sample` profiles across folds of three session cards (`3dd62fc2`, `d2d780b1` at 1630 px; `1f13d2ab` at 813 px in a shared column).

**[F01] The motion is not where the frames go.** Between the lead and the land every fold series on every card runs at the display's own rate. Two compositor-only shapes (scale+counter-scale, `clip-path`) were built behind a live switch and cut per-frame `updateLayout` from 137 to 41–53 samples and `updateBackingAndHierarchy` from 306 to 100–112 — and delivered not one more frame, because none was being dropped there. **(verified; [P09] of that arc)**

**[F02] The lead is 137–335 ms — eight to twenty frames — on every card, both directions.** The tell's own round trip reads the same (137–319 ms), an independent witness that the main thread is held for the whole of it. Layout and the compositing walk inside it total under one frame (`updateLayout` 3–5 samples, `updateCompositingLayers` 10–11). The rest is **`Document::resolveStyle` forced by script reads inside the commit**: two whole-page style resolutions on a single-column card, three on a shared-column card. **(verified)**

**[F03] The first forced flush is `discoverScrollers` under `beginResizeEpisode`, inside the canvas's store subscriber.** `deck-canvas.tsx:4641` begins a resize episode on every armed frame whose size changed, synchronously under `_commitImposition`'s notify and before React has rendered anything; `resize-episode.ts:257` (`discoverScrollers`) reads `.tug-pane-content`'s `scrollHeight > clientHeight` on each. The `chains` verb attributed 9 read→write→read chains to it, one per pane frame, and the sampled cost is ~80 ms. The write that dirties the tree ahead of the first read is attributed by the chains verb to the arm's own container property writes; which write it is exactly is the first thing the fix confirms by re-arming `chains`, not something this brief guesses at. **(the cost and the read site are verified; the dirtying write is attributed, not read)**

**[F04] The second is the transcript list view's layout effects reading after they write.** `tug-list-view.tsx:4522` writes `data-evict-active` / `data-evict-fallbacks` on the scroll container in a layout effect; effects declared after it in the same commit (`pinToBottom`, `applyRestoreTarget`, the `data-tug-scroll-state` writer) read `clientHeight` and `scrollTop`. 15 + 13 chains, ~30–50 ms. **(verified)**

**[F05] The third is the pane occlusion controller's offset sweep, on column-changing folds.** `pane-occlusion-controller.ts:202` (`computeOccludedSet`) reads `offsetLeft/Top/Width/Height` on every shown pane frame after the imposition's writes — a forced whole-page layout, ~120 ms on the shared-column card and absent from the single-column leads. **(verified)**

**[F06] The unfold's land pays the transcript view slot's return in one frame — ~100 ms on a 1630 px card.** `session-card.css:1620` takes `.session-view-slot` out of layout (`display: none`) at `data-fold="settled"`, which is what makes the at-rest fold free; `session-card.tsx:2577` removes that attribute on the unfold's land, and the completion's commit then pays the list view's style, render tree and layout in one frame (`resolveStyle` 25–36, `updateLayout` 28–37 samples). The fold's own land is teardown and a repaint, ~65 ms across two ticks and under two frames by itself. **(verified)**

**[F07] The instrument to read all of this with exists and is red.** `at0622-deck-settle-frames.test.ts`'s session-fold leg holds `firstPaintDelayMs` and `longestGapFrames` to one display frame from the gesture and fails today at 34 ms; the `settle-frames` row carries `commitDelayMs`; `tugtool deck motion gesture` prints the series from the user's deck; and the readings paper's *Procedure* section is the exact command sequence. **(verified)**

---

## Decisions {#decisions}

**[B01] The deliverable is the four fixes, and nothing else.** No new instrument, no new reading section, no shape work on the motion ([F01] closed that). Each fix is judged by one number that already has a reader: the `chains` verb for the three read-after-write hazards, the gesture series for the land. Anything this arc learns that is not a fix goes in one paragraph at the end of the readings paper, not in a new document.

**[B02] Fix 1 — the resize episode does not read geometry on a tree the same task just dirtied.** Either the scrollers are discovered after the commit's own style pass (the canvas's Last-pass layout effect already runs after layout and holds every episode; the episode can be *begun* there with the First rect it already measured), or they are discovered from the deck state and the pane's own content element without asking `scrollHeight`. Which of the two is decided by reading `resize-episode.ts`'s anchor contract — the anchor is taken at begin, and a begin that moves past the commit must still anchor against the *outgoing* geometry, so the First rects the arm already holds are the input. Bar: no `resolveStyle` under `discoverScrollers` in a lead-scoped sample, and the `chains` verb reports no chain rooted in `beginResizeEpisode` on a fold.

**[B03] Fix 2 — the list view's evict attributes and its geometry reads do not interleave within a commit.** The evict-attribute writes are instrumentation (the file says so: "nothing in CSS may key off them"), so they can be batched to after every read in that commit, or deferred to a `requestAnimationFrame`, without changing anything a reader sees. Bar: the `chains` verb reports no `clientHeight`/`scrollTop` chain rooted in the list view on a fold.

**[B04] Fix 3 — the occlusion sweep does not force a layout inside the fold's commit.** `computeOccludedSet` is a read that a fold does not need mid-commit: occlusion is a fact about the settled deck, and the controller already has a notion of when it runs. It runs after the settle's release, or reads its geometry from the imposer's own Last rects instead of `offset*`. Bar: no `updateLayout` under `offsetLeft` in a lead-scoped sample of the shared-column card.

**[B05] Fix 4 — the unfold's view slot comes back into layout under the tween, not at the land.** The at-rest `display: none` stays (it is what makes the folded card cost nothing). What changes is *when* it lifts on the unfold: `data-fold="settled"` comes off on the unfold's **first** frame rather than its last, so the slot's style, render tree and layout land under the motion's first frames — which are already the lead — rather than in the completion's frame. The still crossing already clips the interior at the held height, so the slot re-entering layout mid-motion moves nothing the eye can see. If a reading shows the slot's return lengthening the lead by more than it shortens the land, the fallback is `content-visibility: hidden` on the slot at rest instead of `display: none`, which keeps the render tree and drops only the paint. Bar: the unfold's land under two frames on a 1630 px card.

**[B06] Order: 1, 3, 2, 4 — biggest first, and each read on the user's deck before the next starts.** Fix 1 is ~80 ms on every fold; fix 3 is ~120 ms but only on column-changing folds; fix 2 is ~30–50 ms; fix 4 is the land, a separate frame. A fix that reads green on the bench and unchanged on the user's deck is not landed ([F06] of the previous brief), so each fix ends with the readings paper's procedure run once and its series written down beside the fix's name. That is the one reading per fix [B01] allows.

**[B07] "Fixed" is the at0622 fold leg green, and the user seeing it.** The bar the previous arc set and could not meet is unchanged: leading dead time under one display frame and no gap over one frame across the motion, both directions, three cards, on the user's release deck. `at0622`'s fold leg going green on the bench is necessary; the user pressing ⌃⌘Y and not seeing a cut is the acceptance.

---

## Open Questions {#open-questions}

- **Which write dirties the tree ahead of `discoverScrollers`'s first read** ([F03]). The chains verb attributes it to the arm's container writes; the exact property decides whether fix 1 moves the read or moves the write. Settled by re-arming `tugtool deck motion chains` across one fold before touching anything — a five-minute read, and the arc's first act.
- **Whether fix 4's early lift lengthens the lead** ([B05]). The slot's return costs ~100 ms wherever it lands; the decision is whether it hides under the lead (where the frames are already lost) or gets cheaper under `content-visibility`. Settled by the reading fix 4 ends with.

---

## Non-goals {#non-goals}

- **Any change to the fold's motion or shape.** [F01]: the motion delivers its frames; [P09] of the previous arc and [D135] stand.
- **A layer or element diet.** `briefs/workspace-switch-cheap-brief.md` owns the population; the four costs here are forced flushes, which a smaller page makes cheaper and a fixed read order makes zero.
- **A new instrument or readings section.** Everything needed exists ([F07]). One series per fix, in the existing paper.
- **Touching `at0622`'s bar.** The fold leg stays at one frame and goes green by the deck getting faster, not by the bar moving.
- **The sidebar cards' fold, and the at-rest work.** Both read perfect; neither is opened.

---

## Exit {#exit}

An arc. First act: re-arm `chains` across one fold and name the write ahead of `discoverScrollers`. Then the four fixes in [B06]'s order, each ending with one gesture series on the user's deck written into `briefs/session-fold-frames-readings.md` under the fix's name. The arc is done when `at0622`'s fold leg is green and the user's own fold reads under one frame of lead on three cards, both directions.
