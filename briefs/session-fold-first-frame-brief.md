# The session fold starts moving from the keypress, not from React's commit

**Purpose:** A session card's fold and unfold still show a jump cut after two arcs — one that measured the fold and one that removed three forced style passes from inside its commit. The frames are not lost inside the commit; they are lost waiting for it. The fold's first moving frame is gated behind a full React render of the deck, which is the round trip L22 forbids for exactly this reason, and this brief is the order to move the first frame out from behind it.

---

## Purpose {#purpose}

The report, on 2026-09-28, after `session-fold-commit-frame` was joined and Tug rebuilt: "I am still not getting smooth fold/unfold transitions … WHERE ARE WE? How do we get smooth fold/unfold transitions. It doesn't seem like this should be so unspeakably difficult." And, pointing at the laws: "We also have tuglaws that *explicitly call out* the way to avoid the kind of React problems you are enumerating now. WHY AREN'T YOU USING THEM?"

Two arcs have now worked the fold, and the user cannot tell the difference. `session-fold-frames` measured it and fixed nothing visible. `session-fold-commit-frame` removed about 230 ms of script-forced style work from inside the commit that launches the motion, met every one of its own per-fix bars, and the lead the user sees barely moved. Both worked *inside* the window. This brief says the window itself is the defect.

---

## Evidence {#evidence}

**[F01] The motion delivers its frames; the lead and the land do not.** Between the first moving frame and the last, every fold series on every card runs at the display's rate — [F01] of the previous brief, unchanged, and re-confirmed by every series the last arc took. What the user sees as a cut is the wait *before* the first moving frame and a hitch *at* the last one. **(verified — `briefs/session-fold-frames-readings.md`)**

**[F02] The lead is ~90 ms on the user's deck, and it sits before the fold's commit.** On the user's 1630 px card, 90 ms passes between the last quiet `requestAnimationFrame` and the commit that writes `data-folded`, `data-fold="moving"` and `data-fold-crossing` together — five to six frames of a frozen deck. The unfold's land adds 40–66 ms in the frame where the crossing ends and the still crossing's held height is released. On the bench, `at0622`'s fold leg reads 34 ms of lead against a 17 ms bar, 13 ms of it before the canvas's settle arms at all. **(verified — the readings paper's closing section, and the arc's step-5 census)**

**[F03] Removing forced style work from inside the commit did not shorten the lead.** `session-fold-commit-frame` (`bd92f18d5`) cut nine forced style resolutions from the episode arm (~80 ms), the occlusion sweep's forced layout (~120 ms on a shared-column card), and the list view's read-after-write chains (~30–50 ms). The `chains` verb confirms each is gone. `at0622`'s fold leg read 31–34 ms before and 34 ms after. The work removed was real, and the lead was not made of it. **(verified — the same paper, "What the four fixes cost, and what the bench still says")**

**[F04] The fold is a React state change, and its first frame waits on a whole-deck commit.** The path, read from the code: the key handler updates the deck store → the canvas's store subscriber runs synchronously (`deck-canvas.tsx`, the arm inside `_commitImposition`'s notify, ~4359–4690) and takes First rects, ends and begins resize episodes, and stamps `data-imposer-settling` → React renders and commits the deck — fourteen pane frames and seven transcripts on the user's deck → the canvas's Last-pass `useLayoutEffect` measures Last rects and arms the FLIP tween → the first moving frame paints. Nothing moves until the whole deck has rendered and committed. **(verified by reading; the *cost* of the render step on the user's deck is inferred from [F02] and is what [B03] confirms)**

**[F05] This is the shape L22 names, and the laws already say how to avoid it.** L22: "When external state drives direct DOM updates, observe the store directly — don't round-trip through React's render cycle … that injects React's scheduling (re-render → paint → effect) between the data change and the DOM update, causing frame delays." L24/L06: the fold's in-flight pose — the held-height still, the inverse transform, the crossing marks — is appearance-zone state, with no non-rendering consumer. The sash drags obey this and are smooth: the pointer writes the DOM each frame and React catches up. The fold was built as a state change first and given a tween afterward. **(verified — `tuglaws/tuglaws.md` L22, L24, L06; `tug-pane.tsx`'s gesture path)**

**[F06] The seam to start motion before React already exists.** The canvas's store subscriber is already the place where the settle is armed ahead of React's render: it measures First rects, marks the frames, and the occlusion controller's mid-settle branch (added by the last arc) relies on that mark being present "in the very commit that launched the motion." The fold crossing's own primitives — `markFoldCrossing`, `markStillCrossing`, `heldHeightOnMark` in `tugdeck/src/lib/fold-crossing.ts` — take a frame and a height and write the DOM; they do not need React to have rendered. **(verified by reading)**

**[F07] The two previous briefs each named the wrong culprit going in.** [F03], [F04] and [F06] of `session-fold-commit-frame`'s brief each named a specific dirtying write, and the instrument disagreed with all three; every correction came from resolving a probe's own `line:col` rather than from reading the source the brief cited. This brief's diagnosis of the 90 ms is read from the code path, not sampled from the window. **(verified — the readings paper's closing paragraph)**

---

## Decisions {#decisions}

**[B01] The fold's first frame is written from the canvas's store subscriber, before React renders.** The held-height still and the FLIP inverse transform for the folding frame go on the DOM synchronously in the arm, from the First rects the arm already holds and the target height the store already knows, so the compositor is moving the card within one frame of the keypress. React's render and commit then land *under* the motion, where their cost is invisible, and the Last pass reconciles against a frame that is already moving rather than starting it. This is L22 applied to the fold, and it is the same shape that makes the sash drags smooth. It rules out any further attempt to make the deck commit fast enough to hide behind — the commit's floor on a fourteen-frame deck is the problem, not its excess.

**[B02] The still crossing's held height is released one frame after the land, not on it.** `endStillCrossing` drops the held height in the frame where the crossing ends, and that frame pays the transcript's layout (40–66 ms on the user's card). The release moves to the next tick after the crossing's end event, so the arrival paints first and the layout follows it. Nothing the eye sees changes: the held height at the land *is* the settled height.

**[B03] The arc opens with one 1 ms `/usr/bin/sample` of the 90 ms window on the user's deck, and reads it before writing code.** Not a reading for its own sake — [F07] is the reason. If the sample shows the React render, [B01] proceeds as written. If it shows something else in the window — a synchronous save, a font measure, a store sweep — that is named and fixed first, and [B01] still proceeds, because the round trip is wrong by law whether or not it is the whole of the 90 ms. One sample, one paragraph in `briefs/session-fold-frames-readings.md`, and no other reading before the fix.

**[B04] The bar is unchanged.** [B07] of the previous brief stands: `at0622`'s fold leg green at one display frame of lead and no gap over one frame, both directions, three cards, on the user's release deck — and the user pressing ⌃⌘Y and not seeing a cut. The bar does not move; the deck gets faster.

**[B05] No more work inside the commit, and no change to the motion's shape.** [F03] closes the first: the forced flushes are gone and the lead did not follow them. [F01] and [P09]/[D135] close the second. An arc walking this brief that finds itself shaving a layout effect or reshaping the tween has left the brief.

---

## Open Questions {#open-questions}

- **What exactly the 90 ms is made of.** [F04] is a read of the code path; [B03]'s sample is what turns it into a measurement. It cannot be settled here because nobody has yet profiled that window — the previous arcs sampled the commit and the motion, not the wait.
- **Whether the imposer's Last pass can adopt a pre-commit inverse transform without double-applying it.** The FLIP today measures First in the subscriber and Last in the layout effect, and writes the inverse once from the pair. A transform already on the frame when Last is measured is either read through (and cancelled) or read as part of the geometry. `getBoundingClientRect` includes transforms; `offset*` does not — which the Last pass reads, and whether the fold crossing's `adoptFoldCrossing` path already handles a mark it did not write, is the first thing the arc reads in `deck-canvas.tsx`'s Last pass. The answer decides whether [B01] hands the running tween to the Last pass or has the Last pass skip the frame it already started.

---

## Non-goals {#non-goals}

- **The motion-guard breaker.** A separate defect found the same day — a `rest` trip with no loops running, and a recovery that waited on a hold edge that could never come — fixed directly on `main` (`breaker.ts`, `shouldRecover`). It stilled the pulsing dots; it did not touch the fold.
- **A layer or element diet.** `briefs/workspace-switch-cheap-brief.md` owns the population. A smaller deck makes the commit cheaper; [B01] makes its cost irrelevant to the first frame, which is the fix that survives a bigger deck.
- **Any further shaving inside the commit.** Rejected by [F03] with numbers. Two arcs did this; the third does not.
- **Reshaping the motion.** [F01], [P09], [D135].
- **The sidebar cards' fold and the at-rest work.** Both read perfect in the previous arcs.
- **A new instrument.** `at0622`, `tugtool deck motion gesture` and `chains`, and `/usr/bin/sample` are the whole kit.

---

## Exit {#exit}

An arc. First act: [B03]'s sample of the 90 ms window on the user's deck, read and written down. Then the Last-pass question in Open Questions, read from `deck-canvas.tsx` and `fold-crossing.ts`. Then [B01] — the still and the inverse transform written from the subscriber — read once with `tugtool deck motion gesture` on the user's deck. Then [B02] — the held height released a tick after the land. The arc is done when `at0622`'s fold leg is green and the user presses ⌃⌘Y and sees the card move on the next frame.
