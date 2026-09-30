# A new session card's body arrives at opacity zero, on the frame after its commit paints

> **Open, and waiting on the settle fixup pass, 2026-09-29.** No arc has been walked from this brief. It was deliberately held: the handoff it describes lands inside the settle window, so its readings would have been taken against a settle whose React commit had just moved behind the next painted frame ([D204]) and whose three broken invariants were not yet re-derived. Those are closed now, and the instruments this brief would use are gated and cleared per arm. Two things from the pass go with it. The frame-level bar — lead at most one display frame, no gap over two, no off-curve tick, no rect change after landing — is the bar the handoff should be held to, and `at0622-deck-settle-frames.test.ts` shows the shape a leg takes. And the diagnostic written to watch this very beat, `zz-probe-session-body-handoff.test.ts`, was **deleted**: both its legs reported the body already mounted at census index 0, so the beat was over before it started looking. The Z2 row's churn after the body becomes visible is therefore unasked by any test as of this writing, and it is the reading this brief's arc has to build first.

**Purpose:** Opening a new Session card flashes. The card's *arrival* on the deck is quiet-gated and correct; what flashes is the second beat nobody gated — the picker → body handoff, where the whole interior mounts onto an already-visible card behind an opacity ramp whose first half is never painted, then re-lays out and re-inks in front of the user. Z2 is where it reads worst. This brief says where the frames go and what the entrance owes.

---

## Purpose {#purpose}

The report, 2026-09-28: "When I open a new session card, the components *flash* as the card comes onto the deck. This is *especially* noticeable in the Z2 area. We can't have this. Opening a new session card must be *buttery smooth*." And, asking for this document: "No jittering (especially in Z2!) on new cards!"

This is the same family of defect as the session fold's (`briefs/session-fold-first-frame-brief.md`): a motion whose first frame is gated behind a React commit, on the deck's heaviest card. It is a different beat, with a different instrument, and its own reading.

---

## Evidence {#evidence}

**[F01] Opening a new Session card is two beats, and the first is already right.** The card is added marked `arriving`, drawn `visibility: hidden` at its final seat (`tugdeck/src/components/chrome/tug-pane.tsx`, `TugPaneProps.arriving`), and revealed by one commit only when its content is quiet or `ARRIVAL_REVEAL_BOUND_MS` (250 ms, `tugdeck/src/lib/arrival-reveal.ts`) expires — `_watchArrival` / `_revealArrival` in `tugdeck/src/deck-manager.ts`. The Session card's quiet source is the picker's (`session-card-registration.tsx`, `arrivalQuiet: () => sessionPickerQuiet()`), because what arrives is the picker: `SessionCardContent` returns `<SessionProjectPicker>` while `services === null` (`tugdeck/src/components/tugways/cards/session-card.tsx`, the unbound branch). Nothing in this beat flashes. **(verified by reading)**

**[F02] The body mounts on the binding flip, onto a visible and empty card, behind a 200 ms opacity ramp and nothing else.** When the binding lands, the same function returns `<SessionCardServicesGate>` — a different tree — and masthead, Z2, transcript host and composer mount for the first time. Their entrance is an empty-deps `useLayoutEffect` that writes `opacity: 0` inline and calls `el.animate()` over `--tug-motion-duration-moderate` (200 ms) via `TugAnimator` (`session-card.tsx`, "First-mount fade-in"). Its stated purpose is to share a beat with the picker sheet's exit — but the picker defers the spawn until the exit has fully played (`session-card.tsx`, the `close("open")` → `window.setTimeout` deferral), the ack flips the binding after that, and the body lands on a card that is already empty. The beat the fade was written for no longer exists. **(verified by reading)**

**[F03] The body's mount is a ~65 ms main-thread task.** Measured with `tests/app-test/zz-probe-session-body-handoff.test.ts`, which installs a `requestAnimationFrame` census in the page and flips the binding in the same script: `bindSession` returns at 5–8 ms; the microtask queued after it — which runs after React's synchronous commit of the body — runs at 66–74 ms; the first painted frame is at 92–98 ms. Five runs, the last on today's tree after `194fef08c` (pane-render-scoping), which did not move it. **(verified — the probe's `Diagnostics:`)**

**[F04] The fade's clock starts inside the commit, so the first painted frame is at opacity 0.52.** The animation's `startTime` on the document timeline resolves to 22–29 ms — inside the task, not at the first paint. By the first frame the compositor shows (92–98 ms) the ramp is ~70 ms in, and computed opacity is 0.49–0.53 on every run. Half the fade is never painted: the interior appears in one step at half brightness after a five-frame freeze, then brightens over ~130 ms. That step is the flash. **(verified — `anim=1@70ms start=29` beside `op=0.515734` on the first tick)**

**[F05] The second painted frame is 42–54 ms after the first, and the card re-lays out by 1.5 px between them.** Two to three more dropped frames at the start of the visible ramp, and the card root's height moves 507.4–507.6 → 509. Z2 is `position: sticky; bottom: 0` against that box, so the row the user is looking at shifts on the second frame they see — on the same frame the opacity jumps. What writes the 1.5 px is not identified; it is post-commit work (a passive effect or a measure), inferred from its timing. **(the gap and the height are verified; the cause is inferred)**

**[F06] Z2's geometry is final from the first painted frame; its ink is not.** All five status cells are present at their final widths and positions on the first tick, and the row's host and the entry region never change size after it (leg 1: zero geometry changes after first paint, across runs). Cell widths are fixed in `ch` (`session-card.css`, `--tugx-z2-cell-*`), so a value landing does not move a neighbour. But every instrument in the row reads a store that answers over the wire after mount (`session-card-telemetry-renderers.tsx`, `SessionTelemetryStatusRow`: the session snapshot, `useModelContextMax`, `useJobsState`, `useTaskListState`, `useSessionStateChanges`, `useArcForSession`, the sparkline), and leg 2 shows one injected `system_metadata` frame re-inking the row at ~200 ms, inside the ramp. Z2 reads worst because it is the densest cluster of small bright text on its own surface at the card's bottom edge — a 52 % → 100 % step is most visible exactly there — and because its ink is what changes while the ramp runs. **(verified)**

**[F07] Two mechanisms proposed in the sketch are not in the reading.** A container-query first-pass pop on Z2's `@container session-status` rungs (`tug-status-cell.css`) did not occur — the cells were at final geometry on frame one. A font-swap reflow of the `ch`-sized cells cannot occur — `public/fonts.css` registers every face once, `font-display: block`. Both are withdrawn. **(verified — measured absent; read closed)**

**[F08] These numbers are a bench reading.** A 760 × 560 card alone on the harness deck. The user's release deck holds more, and the fold's history (`settle-frames-row-misses-the-lead`) is that a bench lead understates the deck's. The shape — commit, then a clock already running, then a late second frame — is the finding; the sizes are the bench's. **(the caveat is the fold arcs' measured experience; this beat has not yet been read on the user's deck)**

---

## Decisions {#decisions}

**[B01] The body's entrance starts on the frame after its commit paints, at opacity zero.** The inline `opacity: 0` the layout effect already writes is kept — it is what makes the first painted frame dark rather than a pop to full — and the ramp is started from that painted frame rather than from inside the commit: a `requestAnimationFrame` after the commit, or an explicit `startTime` taken at that frame; the arc reads which is cleaner against `TugAnimator`. Frame one is then 0 and all 200 ms are seen. This is L22's shape read the other way round from the fold's: there the motion must start *before* React, here the motion must not start *until* React's commit has painted — in both, the commit's cost is moved out of the motion's window rather than shaved. It rules out re-tuning the duration or the curve: a ramp whose first half is unpainted is not fixed by lengthening it.

**[B02] The body is held at zero until it is quiet, bounded — the same contract the arrival already has.** The deck holds an arriving card hidden until its content is quiet or 250 ms elapses ([F01]); the body gets the same shape: the ramp starts on the first painted frame after the body's first store answers have landed, or at the bound, whichever is first. The quiet source is the body's, not the picker's — Z2's instruments are the loudest members and the row is the reason. This is what stops Z2 re-inking mid-fade ([F06]) and it costs the user nothing they have: the card is already empty when the body mounts ([F02]), and the bound caps the hold at what the deck already judged acceptable for an arrival. A `null` quiet source — a gallery, a fixture — reveals on the first paint, as it does for the arrival.

**[B03] Nothing the user can see changes after the first painted frame except the opacity.** The card root's height, the Z2 host, the entry region and every status cell's box hold their frame-one geometry through the ramp and after it. [F05]'s 1.5 px is a defect to be found and closed by the arc, not tolerated: whatever measures after the commit either does so before the first paint or holds its geometry. Under [B02] the ramp starts after the body's first answers, which also puts the post-commit tail where it cannot be seen — but the bar is on the geometry, not on the timing that happens to hide it.

**[B04] The bar is the probe, promoted to a pin, plus the user's own deck.** `zz-probe-session-body-handoff.test.ts` becomes an `at####` test with `@covers` on the session card, its CSS, the telemetry renderers and the status-cell CSS, holding: the first painted frame of the body at opacity ≤ 0.05; no gap over one display frame from that frame to the ramp's end; no card-root, host, entry or cell geometry change after the first painted frame; no Z2 ink change while the ramp runs; and `ticks` above the suspension floor so an occluded window fails on `suspended` rather than passing on zeros. And, per [F08] and the fold's lesson, one reading on the user's release deck with a `requestAnimationFrame` gap recorder armed before the New session click, before the arc calls itself done. The deck's stated promise — a layout change travels rather than jumps — is held to on this beat by this test.

**[B05] Making the commit cheaper is not the fix.** The body's ~65 ms commit is a freeze on a card that is showing nothing ([F02]), so its cost is invisible once the entrance starts after it ([B01]). `194fef08c` landed between readings and moved nothing; the fold spent two arcs inside its commit and the lead did not follow the work (`session-fold-first-frame-brief.md` [F03]). An arc walking this brief that finds itself profiling the body's render has left the brief; a reading of what the 65 ms is made of is welcome as a paragraph, and is not a step.

---

## Open Questions {#open-questions}

- **What writes the 1.5 px on the second frame.** [F05] has its timing and not its author. A `/usr/bin/sample` across the handoff, or a `ResizeObserver`/mutation trace on the card root between the first two ticks, names it; [B03] says it goes either way.
- **Whether the picker's exit should overlap the body's entrance.** Today the sheet exits fully, the spawn is sent, the ack lands, the body mounts — so the user sees an empty card for the exit's length plus a round trip plus the commit, and then the body. [B01] and [B02] make what follows the empty card correct; they do not decide whether the empty card should exist. A crossfade — the sheet still up while the body mounts under it, the two swapped on one frame — is the alternative, and it is a question of feel, which is the user's call and the reason it is not a `[B##]`.
- **Why WebKit resolves the start time inside the task.** The measured effect is certain ([F04]); the mechanism — a timeline time cached at first read within the task — is inferred. It decides only which of [B01]'s two implementations is the cleaner one, and the arc reads it in `tug-animator.ts` against the first painted frame rather than settling it here.

---

## Non-goals {#non-goals}

- **The arrival beat.** [F01]: gated, measured, correct. This brief does not touch `_watchArrival`, the picker's quiet source, or the `arrive` fade.
- **A container-query or font fix on Z2.** [F07]: neither mechanism is in the reading. A change to `tug-status-cell.css`'s rungs or to `fonts.css` in the name of this defect is a change to something that is not broken.
- **Shrinking the body's commit.** [B05].
- **Reshaping the fade.** 200 ms `ease-out` opacity stays; what changes is when its clock starts and what it waits for.
- **The ARC width flip.** `--tugx-z2-cell-*-arc` (`session-card.css`) re-widths four of five cells when `useArcForSession` answers — a real post-mount geometry change on an arc-bound session, and not a new-card case. Named here so it is not re-discovered as this defect; it is its own.
- **The motion-guard breaker and the fold.** Separate defects, separate briefs; the breaker is a hand switch and stays one.
- **A new instrument.** The probe exists and is committed (`261741992`); [B04] promotes it, and `tugtool deck motion gesture` plus a rAF recorder read the user's deck.

---

## Exit {#exit}

An arc. First act: one reading of a real New session on the user's release deck with a `requestAnimationFrame` gap recorder armed before the click, written down as a paragraph beside the bench numbers — [F08] is the reason it comes first. Then [B01], the ramp started on the painted frame after the commit, read once with the probe. Then [F05]'s author found and [B03] held. Then [B02], the body's quiet source and the bounded hold, with Z2's instruments as its members. Then [B04], the probe promoted to a pin. The arc is done when the pin is green, the user's deck reads one frame of lead and none dropped, and the user opens a new Session card and sees nothing move but the fade.
