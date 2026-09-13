# The sparkline is visible and flat at rest, always

**Purpose:** A fresh Session card shows no activity sparkline at all, when the design says a quiet session shows a visible flatline. The instrument must never be absent.

---

## Purpose {#purpose}

The user's report, on a new session card reading "No turns. Ready." with nothing where the tape belongs:

> The sparkline *vanishes* in too many cases now, like *right now* in this new session card. This is a *direct violation* of the design intent. The sparkline must be *visible and flat* when there is no activity. This *must not happen*.

The reading of the masthead's trailing edge at that moment is empty ink. No line, no baseline, no box. A session that has done nothing looks like a session with no instrument.

---

## Evidence {#evidence}

**[F01] The flat-at-rest rule is already the code's stated contract.** `tugdeck/src/components/tugways/session-identity-row.tsx` mounts the tape unconditionally wherever a mount asks for one, with a comment saying a session that has done no work "shows a FLATLINE, which is the instrument reading zero rather than the instrument being absent". The masthead passes `tape` unconditionally in `tugdeck/src/components/tugways/session-masthead.tsx`. So the vanish is a regression against a settled rule, not an open design question. **(verified)**

**[F02] The data path produces a flat line, not an empty one.** For a session with no meters, `compositeSeries` in `tugdeck/src/lib/session-activity-store.ts` returns a window of eighty zeros. `rebuildTape` in `tugdeck/src/lib/sparkline-tape.ts` turns that into eighty zero-valued points spanning the visible width, and zero-seeds any span the bins do not cover. `drawSparkline` in `tugdeck/src/lib/sparkline-geometry.ts` returns early only for an empty tape, and otherwise strokes the staircase at the baseline with the held tail to the right edge. So "no data means no line" is not the mechanism. **(verified)**

**[F03] A fresh tape is born inert and paints exactly once.** `lastChangeAt` starts at zero in `SparklineTape`, so `start()` finds the window flat, transitions to flat-dormant, paints once, and stops the scroll. By design an idle tape holds no timers and no animation, so nothing ever repaints it until a data event arrives. That one paint is the whole picture the card will show for as long as the session is quiet. **(verified)**

**[F04] Every road to a lost first paint is inside the paint protocol.** Three candidates, read out of `tugdeck/src/lib/sparkline-tape.ts` and `tugdeck/src/components/tugways/tug-sparkline.tsx`:

- The born-inert paint is dropped or deferred: `paint()` returns without drawing while a rebase is pending, and the surface draws through whatever painter is current at call time.
- The parked scroll's transform disagrees with the painted origin. Design decision D133 names this exact symptom, "a repaint that assumes the clock under a transform held at an older reading is a truncated or vanished resting flatline". A fresh Session card passes through pane creation, possible reparenting, and an intersection gate with a 500 ms hidden pause, which is the path with the most moving parts.
- Colour is resolved once at canvas claim, from computed style on the container, and posted to the render worker. A colour read before the masthead's chrome ink resolves draws a line that reads as nothing.

Which road this card took is **not verified**. The dev panel (Opt-Cmd-/) logs every tape transition and the "start time still pending" warning on the `sparkline` channel, and reading it on the vanished card would name the road.

**[F05] D133 records four prior defects in this same protocol with this same symptom.** The design-decisions entry lists "truncates, hops, clears, judders, sometimes vanishes" as the complaint the registration-hardening round fixed. The instrument's rest state has been lost to protocol corrections four times before this one. **(verified)**

**[F06] No app-test pins a fresh card's visible flatline.** The only tests naming the sparkline are `at0257` (Cards reorder), `at0293` (typing latency), and `at0294` (imposer flip settle). None asserts that a new Session card's tape has ink before any turn. **(verified)**

---

## Decisions {#decisions}

**[B01] The zero reading becomes a stylesheet fact, not a canvas fact.** `.tug-sparkline` draws its own 1 px baseline by CSS, positioned at the same y the geometry uses for zero, layered under the canvas. The canvas then only ever adds ink above the baseline. A dropped paint, a stale transform, a lost acknowledgement, or a mis-resolved colour can lose the activity, but it can no longer lose the instrument. This is [L06] applied to the instrument's rest state, and after [F05] it is cheaper and safer than hardening the protocol a fifth time. The canvas still strokes its own zero line, so a live tape looks as it does today.

**[B02] The CSS baseline rides the same ink as the canvas.** It takes `currentColor` at the same line alpha the geometry uses, so the baseline and the canvas's zero stroke are one line, not two. The masthead pins the tape's colour to the chrome foreground, and the baseline must inherit through the same path.

**[B03] The road this card took is pinned for the record, from the live card, before the fix lands.** The dev panel's `sparkline` channel on the vanished card is the evidence. Pinning it does not gate [B01]; it decides whether a protocol correction is also warranted, and it keeps [F04] from being three guesses forever.

**[B04] One app-test pins the contract.** A fresh Session card, before any turn, has a non-transparent baseline row in its tape region. The test carries `@covers` for the sparkline stylesheet and the identity row. Without this pin the next protocol change can lose the rest state again without a red.

---

## Open Questions {#open-questions}

- Which of the three roads in [F04] this card took. Settled by reading the dev panel on the vanished card. If it is the transform road, a protocol correction is added alongside [B01]; if colour, the claim-time colour read is moved after style resolution.

---

## Non-goals {#non-goals}

- **Hardening the paint protocol as the only fix.** Rejected on [F05]. A fifth correction to when the canvas paints leaves the rest state hostage to the sixth.
- **Gating the tape on activity.** The identity row's comment already rejects this: an accessory that comes and goes with its data is one the reader cannot trust, and it moves the line beside it.
- **Making the tape React state to force a repaint.** [L06] forbids it; the tape is canvas and CSS.

---

## Exit {#exit}

An arc. The first steps in order: read the dev panel on a vanished card and record the road; add the CSS baseline to `tugdeck/src/components/tugways/tug-sparkline.css` at the geometry's zero y, inheriting the instrument's colour; confirm by eye on a fresh Session card and on a live one that the baseline and the canvas stroke read as one line; write the app-test pin. A protocol correction follows only if the recorded road calls for one.
