# Zoom rectangles between the update pill and the UpdateTug wizard

**Purpose:** Clicking the update pill makes the pill vanish and a wizard appear, with nothing that says the one became the other. The wanted nicety is a run of classic Mac OS zoom rectangles, out from the pill to the wizard on open and back from the wizard to the pill on close, so the motion tells the story of the transformation.

---

## Purpose {#purpose}

The user's words: "add old-timey-style Classic MacOS zoom rectangles when I click on the app-update pill and it opens to the UpdateTug component, as well as the reverse, when I collapse the UpdateTug component into the pill. The idea is to use this motion to *tell the story* of the transformation."

Today the pill's click flips one flag. The pill renders null and the wizard fades in at the centre of the window, in the same commit, and nothing connects the two. On Close the wizard vanishes and the pill reappears at the top of the window, again with nothing between them.

---

## Evidence {#evidence}

**[F01] The pill and the wizard share no parent, and only a store connects them** — `tugdeck/src/components/chrome/update-pill.tsx` reads `useUpdateTugOpen` and returns null while the wizard is open; `tugdeck/src/components/tugways/update-tug.tsx` is the store's only writer, through `setUpdateTugOpen` in `tugdeck/src/lib/update-tug-request-store.ts`. Both subscribe to the same store, so the pill unmounts in the same commit that mounts the wizard. Whichever side arrives cannot measure the side that left. **(verified)**

**[F02] The pill's box is a portaled, top-centred accent strip** — `update-pill.css` pins `.tugx-update-pill-anchor` to `top: 0`, centred with auto margins over a fit-content box, inside the canvas overlay root, which is `position: fixed; inset: 0`. The pill itself is 28px tall with squared top corners and a 1px border in `--tug7-element-control-border-filled-accent-rest`. Its width follows the label, so its rect is only known once it is on screen. **(verified)**

**[F03] The wizard is a Radix AlertDialog whose exit is instant on purpose** — `tugdeck/src/components/tugways/tug-alert.css` gives `.tug-alert-content[data-state="open"]` a 150ms fade with a scale from 0.96, and gives the closed state no animation at all. The comment there records why: Radix Presence holds a closing layer until `animationend`, that event arrived unreliably and never arrives for a 0s animation, and a held layer leaves the whole document click-dead. The panel is `position: fixed`, centred by `translate(-50%, -50%)`, and `update-tug.css` widens it to 560px. **(verified)**

**[F04] The wizard has two doors and the pill is only one of them** — `revealCount` on the update snapshot is bumped by the Tug menu item and by Sparkle's own reveal; the request store's nonce is the pill's click. Both doors are consumed and dropped while a sibling app-modal holds the app, so a pill click can be refused with nothing opening. **(verified, from the two effects in `update-tug.tsx`)**

**[F05] Close does not always bring the pill back** — the pill shows only while the stage is one of the live stages and the pill's own hidden flag is clear. The wizard also closes itself on an `idle` snapshot, and Done on `upToDate` and Dismiss on `error` end the flow. In each of those cases no pill mounts after the wizard leaves. The hidden flag is pill-local `useState` that the wizard cannot read. **(verified)**

**[F06] The motion laws already assign this shape of motion a home** — L13 gives programmatic, multi-element motion with completion promises to TugAnimator, and `tugdeck/src/components/tugways/tug-animator.ts` resolves duration tokens, scales them by the timing setting, honours `isTugMotionEnabled()`, and documents starting a whole sequence in one frame with per-effect delays rather than chaining on `finished`. L14 keeps TugAnimator out of Radix's enter and exit lifecycle. The doctrine's D6 says a finite effect must end and be droppable; its D9 compositor-only rule is scoped to pane settles and audited on `.tug-pane` descendants, which the overlay root is not. **(verified)**

**[F07] Reduced motion has one switch** — `scale-timing.ts` sets `data-tug-motion="off"` on the body and the animator reads the same source. App-tests run with `--tug-timing: 0`, and the alert CSS records that a 0s exit animation is exactly the case that wedges Radix. **(verified)**

**[F08] Classic zoom rects were discrete frames with a trail, spaced to accelerate toward the destination** — the original Finder drew a sequence of outline rectangles interpolated between the source and destination rects, keeping the last few visible as a trail, and the steps bunched up as they approached the destination. The user confirmed the acceleration from memory. Not measured against an original; if fidelity matters beyond taste, an emulator run would settle it. **(not verified)**

---

## Decisions {#decisions}

**[B01] The rectangles are discrete frames whose only animated property is opacity.** Each rectangle in a run is planted once at its own geometry, written inline, and turned on and off on a schedule. Nothing interpolates position or size. This is more faithful to the original than a smooth tween, and it avoids the trap a scale transform on a 1px border springs, where the stroke thickens with the box. It also keeps the run inside the transform-and-opacity discipline the doctrine prefers, even though D9 does not bind the overlay root.

**[B02] The run's shape: eight rectangles, a trail of three, one `moderate` duration for the whole run, spacing eased so the rectangles bunch toward the destination.** The stroke is 1px solid in `--tug7-element-control-border-filled-accent-rest`, the pill's own border colour, so what travels reads as the pill's edge growing into the panel and the panel's edge going home. Trail depth and the ease curve are taste knobs to look at live; the counts here are the starting values, and the acceleration is settled by [F08].

**[B03] The departing side stashes its rect and the arriving side claims it.** [F01] rules out either side measuring the other. So the pill's click handler measures its own box and stashes it before calling `requestUpdateTug`; the wizard's close callback measures the panel and stashes it before clearing the open flag. The wizard's layout effect on open, and the pill's layout effect on mount, each claim the stash, measure themselves as the destination, and run the rectangles. A one-slot stash with a sweep one tick after it is written means a refused click ([F04]) or a close with no returning pill ([F05]) leaves nothing behind, and the pill's hidden flag never has to cross to the wizard.

**[B04] Only the pill's click zooms on open.** A wizard raised by the Tug menu or by Sparkle opens exactly as it does today. The story is about the click, and a menu-opened wizard has no gesture at the pill to grow from. This holds even when the pill happens to be showing at the time; the user settled it.

**[B05] Every close stashes, and the zoom-in runs if and only if the pill mounts.** The wizard cannot know whether the pill will return ([F05]), and it does not need to: the pill claims the stash on mount, and an unclaimed stash is swept. A flow that ended, or a pill hidden with its x before a menu-opened wizard closed, sees the wizard vanish as it does today.

**[B06] The arriving element's reveal is CSS keyed on a data attribute, never a promise.** The layout effect that starts a run sets `data-zoom` on the arriving element before first paint. Under that attribute the wizard's entrance becomes a fade with no scale, delayed by the run's duration, so the last rectangle and the panel's edge coincide with no inward bounce; the pill gets the `fast` fade with the same delay. Neither reveal waits on JavaScript, so a cancelled or failed run still shows the surface on schedule, and the rectangles stay pure decoration that D6 lets be dropped at any moment.

**[B07] Radix Presence is not touched.** The wizard's entrance gains a delay under `data-zoom`; its exit stays instant, exactly as [F03] requires. The run on close starts from a rect measured before the open flag clears and needs nothing from the departing layer. This is L14 applied.

**[B08] The run lives in one module, owned once.** `tugdeck/src/components/chrome/zoom-rects.ts` with a paired CSS file: a function that plants the rectangles in the canvas overlay root, starts every opacity effect in one frame through TugAnimator with per-rectangle keyframe offsets, and removes them when the run finishes; plus the stash from [B03]. A new run removes any previous run's rectangles first, and canvas unmount removes whatever stands. The rectangles are `pointer-events: none` and sit above the scrim.

**[B09] Reduced motion plants nothing and delays nothing.** When the animator reports motion disabled, or the timing scale is zero, no rectangles are created and `data-zoom` is not set, so the CSS delay never applies. The snap is the zoom, and the 0s-animation hazard of [F07] never arises.

**[B10] The proof is a sampled app-test.** Click the pill and sample the overlay each frame: the rectangles' geometry runs monotonically from the pill's rect to the panel's, none remain once the panel is visible, and the reverse holds on Close. A second case under timing zero asserts no rectangle is ever planted and the panel is visible on the first frame after the click. A motion claim without a sampler is not verified; the existing pill and wizard tests should not change.

---

## Open Questions {#open-questions}

- Whether a dashed stroke, as a nod to the original's dithered XOR line, reads better than solid. Worth one try in the same session as the trail-depth look; solid is the default until it loses.

---

## Non-goals {#non-goals}

- **A smooth tween of one rectangle from pill to panel.** It is not what the original did, and animating a bordered box's size either runs layout or thickens the stroke. Rejected by [B01].
- **Zooming on the menu and Sparkle doors.** Rejected by [B04].
- **An exit animation on the wizard's Radix layer.** [F03] records the wedge this causes. Rejected by [B07].
- **Crossing the pill's hidden flag to the wizard, or adding a bridge field for any of this.** The claim model in [B03] and [B05] makes both unnecessary.
- **Gating the panel's or pill's visibility on the run's completion promise.** Rejected by [B06].

---

## Exit {#exit}

An arc. The first steps, in the order they must land:

1. The zoom module and its CSS: the stash, the run, the sweep, the standing-rect removal, and the reduced-motion early return.
2. The wizard side: stash on close, claim and run in the open layout effect, `data-zoom` and the delayed fade-only entrance in `update-tug.css`.
3. The pill side: stash on click, claim and run on mount, `data-zoom` and the delayed fade in `update-pill.css`.
4. The sampled app-test from [B10], with its `@covers` lines naming the module, the pill and the wizard.
5. A live look at trail depth, ease curve and stroke, adjusting the constants in the module.
