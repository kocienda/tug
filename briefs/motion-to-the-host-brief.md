<!-- brief-skeleton v1 -->

# Motion to the host: beat plans, Core Animation on the bodies, and the bar read on the window

**Purpose:** With a card's content in its own process, the one thing left on the shell's thread during a settle is the shell's own chrome, and the one thing that can still stall a body's motion is the shell deciding where it goes. This brief moves the bodies' motion to the host: the shell plans a settle as it does today and posts each body's beats to the host, which runs them as Core Animation on the body's container, anchored to the same clock as the shell's chrome beats. The asks' bar is then read on the window's frames, not one document's.

Stage 3 of `briefs/per-card-web-views-program-brief.md`.

---

## Purpose {#purpose}

The asks: a new card, a fold, a column move, a flow slide, with no gap over one display period from the first frame to the land and a one-frame land, with three or four sessions streaming. After stage 2 the bodies snap at the land. After this stage they move.

---

## Evidence {#evidence}

**[F01] The settle engine already plans before it moves.** `useSettleEngine` (`components/chrome/settle-engine.ts:461`) runs the beats `depart`, `room`, `shrink`, `move`, `grow`, `arrive` and the land (`:3810-4065`, `:4255-4300`) from a plan (`settle-plan.ts`, beat math `lib/pane-flip.ts`); the Last pass reads once and writes after (stage 6 [B03], `lib/set-up-apply.ts`). Pane frames are animated by FLIP `transform` with origin `0 0`, width and height tweens, and opacity, through `TugAnimator` WAAPI (`:3093, 3359, 3564`, `:369, 3048, 3485`). **(verified, read)**

**[F02] The crossing reaches into the body by attributes and events.** `data-fold-crossing`, `data-still-crossing`, `--tugx-still-held-height/-width`, `data-still-settled` on the frame; `markStillCrossing`, `settleStillCrossing`, `endStillCrossing` (`lib/fold-crossing.ts:345, 381, 575`); the body registers interiors the engine calls into (`:180, 192`) and reacts to `tug-still-crossing-end` and `tug-fold-crossing-end` CustomEvents; `beginResizeEpisode` dispatches `tug-scroll-preserve-begin/end` into the body's scrollers (`lib/resize-episode.ts`, `settle-engine.ts:47`); `smartScrollForElement` is reached from both (`lib/smart-scroll.ts:278`). With separate documents each of these is a message or is gone. **(verified, read)**

**[F03] The ingest hold is the shell's.** `TugConnection` parks ingest batches while the motion gate is closed (`connection.ts:478, 500-525`), the Worker caps the hold at `MIN_HOLD_CAP_MS` = 1000, and the hold rides `RENDER_INPUT`, which stage 1 made per page. A body's stream has no reason to stop for the shell's settle once the shell's thread is not the one drawing it. **(verified, read)**

**[F04] Stage 6's numbers are the before.** First frame after a fold's commit 77–83 ms on the harness; the height crossing's frames are style and compositing in any shape; fold in-motion 28–42 ms, land 28–42 ms on the user's aged deck; ⌘N set-up 141–416 ms. `tuglaws/animation-doctrine.md` [D9] records the height crossing as a standing hit with the clip and containment shapes benched and failed (`at0736`). **(verified, read from the record)**

**[F05] Core Animation runs on the render server.** A `CABasicAnimation` or `CAKeyframeAnimation` on a layer's `position`, `bounds` or `transform` is committed once and interpolated by the render server at display rate, independent of the committing process's main thread after the commit; `beginTime` is in `CACurrentMediaTime()` terms, and a WKWebView's content is a remote layer tree hosted in the same window. **(WebKit and Core Animation's documented behaviour; the frame-rate claim under a stalled shell is stage 2's spike reading, and this brief depends on it)**

---

## Decisions {#decisions}

**[B01] The shell plans; the host moves the bodies.** The settle engine keeps every pass it has: `arm`, First, the store commit, the Last pass's one read phase, the plan. For every body in the plan it posts a `beatPlan` to the host: an ordered list of beats, each with the container's start and end rect, start and end opacity, duration, easing (the same curve names the chrome uses, resolved by the host to `CAMediaTimingFunction` or a keyframe list), and one absolute `startTime` per beat. The host builds the Core Animation for each beat on the body's container layer (`position` and `bounds` for a move or a crossing, `opacity` for depart and arrive), commits them in one transaction, and sets the model values to the landing rect so nothing snaps when the animations are removed. The shell runs its chrome beats as today.

**[B02] One clock.** The shell computes each beat's `startTime` on `performance.now()`, converts through `performance.timeOrigin` to wall time, and the host converts wall time to `CACurrentMediaTime()` once at launch and on every wake; every WAAPI chrome animation is started with an explicit `startTime` and every CA body animation with the matching `beginTime`. The skew between a chrome frame and its body frame is read by the host's frame instrument (stage 2 [B01]) and the shell's gap sampler side by side; it is the program brief's open question and this stage's first reading.

**[B03] Set-up-and-go, read for a body.** A body's box is set once, before the first frame: the host sets the body view's final frame inside the container at the commit, and the body pays one layout in its own process while the container is still at First. A shrink or a grow then clips and translates the container ([D9]'s "new shape for the division" is the host's layer, where a bounds animation costs no layout anywhere). The still-crossing hold, `registerCrossingInterior`, `resize-episode` and the CustomEvents retire for bodies: one bus message, `crossing {phase: begin|land, size}`, tells the body its final size is coming and when it has landed, and `smart-scroll`'s pin and restore run in the body on that. The folded form is a chrome strip in the shell with the body hidden beneath it, decided here from the fold's reading rather than left to stage 2's interim.

**[B04] The ingest hold is retired for bodies.** A body streams through a settle; its frames are its own process's. The shell's gate holds only the shell's own batches, which after stage 5 are none. The one-period bar is read with three sessions streaming into three bodies, which is the condition the program was opened on.

**[B05] Parked workspaces hide their bodies, and a hidden body costs nothing.** `activate-space` posts the new arrangement; the host hides the departing layer's bodies and shows the arriving ones at their rects, in the same transaction as the shell's layer swap. A hidden WKWebView suspends its rendering on its own. Stage 6's `display: none` on parked content ([D212]) stays for the shell's chrome and is no longer needed for card content.

**[B06] The bar is read on the window.** The host's display-link instrument counts the window's frames and gaps across a settle and reports them beside the shell's gap rows; `tugtool deck motion settle` prints both, labels the body beats by card, and `at0696`–`at0708`'s per-gesture files read the window's row as the bar. A reading of record for ⌘N, fold, slot and split on the user's aged deck with three streams, before and after, goes into the program record with the honesty rules in force.

**[B07] The chrome follows if the skew says so.** If [B02]'s reading shows the chrome beats and body beats a frame apart under load, the pane's title bar and tab strip become host-drawn strips above the body (a second small web view per card is ruled out; an `NSView` with the shell's tokens is the shape), and the shell keeps only columns, rails and overlays. This is an escalation the reading opens, not a plan.

---

## Open Questions {#open-questions}

- **What is the skew?** [B02]; the first reading of the stage.
- **Does an animated `bounds` on the container with `masksToBounds` show the body's edge cleanly at a shrink, or does the body need its own inner clip?** Looked at on the user's deck with the fold.
- **The flow slide and the rails.** The band's travel is a transform on every pane; with bodies it is one `beatPlan` per visible body plus the chrome's; the rails' slide is chrome only. Read as the fifth and sixth gestures once the four hold.

---

## Non-goals {#non-goals}

- **Moving the plan to the host.** The shell stays the authority on arrangement; the host never decides where a body goes.
- **A third bench of height by translation inside a document.** Ruled; the division moves to the host's layer.
- **Changing the beat vocabulary or the curves.** The doctrine's beats and timings stand; they are executed in two places.

---

## Exit {#exit}

**An arc.** The shape: the beat plan protocol and the host's animations ([B01]) with the clock ([B02]) and its skew reading first; set-up-and-go for a body and the crossing message ([B03]); the hold ([B04]); parked workspaces ([B05]); the window bar in the verb and the tests ([B06]); the escalation only if opened ([B07]). It joins when ⌘N, fold, slot and split hold the asks' bar on the window on the user's aged deck with three streams, written into the program record, or when the reading says why not.
