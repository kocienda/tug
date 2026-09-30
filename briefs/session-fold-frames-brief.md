# The session card's fold delivers its frames

**Purpose:** On the user's release deck a session card's fold and unfold show about six frames of nothing after the gesture and drop two more at the land, out of a ~270 ms motion — after the at-rest cost was made zero and after every instrument had called the fold healthy. This brief records what the fold actually costs on the real deck, why the instrument that judged it could not see that, and what the fix has to change.

---

## Purpose {#purpose}

The report, on 2026-09-28, minutes after the `animations-zero-at-rest` arc was joined and Tug relaunched from it: "WTF. Joined and relaunched. I get basically *zero frames* on a fold/unfold. Seriously WTF!!!" It follows the same report from 2026-09-27 that opened that arc ("We are back to getting basically *no frames* on a card fold/unfold … It's utterly frustrating how you tell me that they're fixed and cheap one moment, and then the source of all performance degradation in the next").

The at-rest arc did what it said: the deck's loops are gone from the main thread at rest. It did not fix the fold, and its own record said the fold reading on the user's deck was still owed ([B09] of `briefs/animations-zero-at-rest`, the arc's `baseline.md`). This brief is that reading, taken on the user's deck with the user's content, and the decisions it forces.

---

## Evidence {#evidence}

All readings are from the user's release deck on 2026-09-28 (`release-main`, port 55348, relaunched from `main` at `9cb59ea2a` plus the at-rest join; Studio Display; the audit session itself mid-turn throughout, so a transcript was streaming somewhere on the deck). Gestures were sent through `tugtool host tell set-card-folded`, which is the one door every fold gesture reaches — the Z2 control, Session ▸ Fold Session, and ⌃⌘Y (`tugdeck/src/components/tugways/action-vocabulary.ts:620`).

**[F01] The at-rest disease is gone from this deck.** `tugtool deck motion list`: 21 long-running loops — 6 pulsing dots and one wave — against the 223 dots the previous brief measured. A 5 s `/usr/bin/sample` of the WebContent main thread put 3,342 of 3,674 samples in `mach_msg` and 27 in `Page::updateRendering`: 91 % idle. `deck motion rest` read 11–14 updates/s over the floor, 87–132 ms/s held, worst gaps 49–58 ms — with a session mid-turn and the rendering timer nearly idle in the sample, so those are the turn's own tasks (feed JSON parse, React commits), not a loop. **(verified)**

**[F02] A session card's fold loses about a third of its frames; a sidebar card's fold loses none, on the same deck seconds apart.** A `requestAnimationFrame` gap recorder armed in the page *before* each gesture:

| card folded | direction | dead time before the first steady 16–17 ms tick | dropped at the land |
|---|---|---|---|
| jots (sidebar rail, 439 px, 235 elements) | fold / unfold | 0 ms / 0 ms | none |
| session `3dd62fc2` (1630 px, ~3.0k elements) | fold / unfold | 94 ms (4+90) / 96 ms | 34+27 / 47+48 ms |
| session `d2d780b1` (1630 px, ~3.4k elements, focused) | fold / unfold | 130 ms (99+31) / 106 ms | 40+51 / 47+40 ms |
| session `1f13d2ab` (1630 px, ~2.3k elements) | fold / unfold | 86 ms / 0 ms | 108+56 / 41+36 ms |
| `1f13d2ab`, four more folds | fold | 92, 105, 120 (+59), 92 ms | 26–45 ms pairs at ticks 13–17 |

One fold in full, tick by tick: `120 59 11 12 14 17 17 17 16 17 17 16 17 40 34 9 17 16 …`. Six frames of nothing, two catch-up frames, ten good ones, two dropped, then steady. The reading is the same on all three session cards, focused or not, and none of them was the streaming session's card (that one is in the Cards rail). **(verified)**

**[F03] Where a session fold's time goes.** A 1 ms `sample` of WebContent across one fold, 670 main-thread samples, 504 idle: `Page::updateRendering` 100 — `Document::resolveStyle` 78, `RenderLayerCompositor::updateCompositingLayers` 57 at the top level (`computeCompositingRequirements` 224 and `updateBackingAndHierarchy` 208 counting their recursion), `Document::updateLayout` 28 — beside rAF callbacks 48, event listeners 17, microtasks 20. Across a fold-and-unfold pair the same shape at twice the size. So the fold's frames are style, layout and the whole-page compositing walk, with a React commit on the first frame and on the land. **(verified)**

**[F04] The fold is a real `height` tween, by design, on a pane the whole page re-composites for.** `settle-frames` reports `<pane>:height` as a violation on every session fold and on no sidebar fold; `tugdeck/styles/chrome.css:172` transitions `height` on `.tug-pane` for the window-shade collapse, stands it down under `[data-imposer-settling]`, and says in its own comment that "the settle carries a frame's height as a real geometry tween". Every settle, sidebar or session, arms all eight panes (`settle-arm.panes: 8`). The page: 14,575 elements, 1,092 stacking contexts, 4,763 render-layer candidates (`deck motion layers`). A 1630 px pane with 2–3k elements re-laid-out every frame in that population is the multiplier the sidebar card does not have. **(verified from the trace rows, the stylesheet and the layer probe; that the height tween is the *whole* of the per-frame cost is inference — a fold with the height animated as a transform would confirm it)**

**[F05] The instrument that kept calling the fold fixed cannot see its first frames.** The `settle-frames` deck-trace row — the row `at0622` asserts on and the row every prior "verified green" fold reading came from — starts its clock at the settle's arm, after the gesture's React commit and first layout; `firstPaintDelayMs` reads `-1` on every row taken here. On the eight session folds above it reported 9–16 ticks and `gapsOverOneFrame` of 0 or 1 while the recorder in front of it saw 86–130 ms of no frames; its `longestGapMs` caught 61, 108 and 33 ms on three of them, each under `at0622`'s bar of two frames. WebKit on this machine supports no `longtask` performance entry, so the rAF recorder armed before the gesture and `sample` are the two instruments that can see the lead. **(verified)**

**[F06] The at-rest arc's own fold reading was taken on the wrong deck.** It read the fold on a Release build of its branch with one idle Session card and no workspace content: 16 ticks, one 41–47 ms gap at the gesture, nothing else. On the user's deck the same gap is 86–130 ms and the land drops two frames. The bench and the empty deck do not carry the population that prices the walk. **(verified against that arc's record)**

**[F07] Presented frames were not measured, and the display is in a scaled mode.** The Studio Display runs at "looks like" 3200×1800 over a 6400×3600 backing (native 5120×2880), which WindowServer composites and downsamples every frame; WindowServer was at 42 % CPU while these readings were taken, and a `screencapture -V` from the measuring shell wrote nothing for want of a Screen Recording grant. Whether the compositor drops frames the page delivered on time is unknown. **(the mode is verified; its effect is unmeasured)**

---

## Decisions {#decisions}

**[B01] The fold is judged by a recorder armed before the gesture, on the user's deck, and by nothing else.** The reading is the gap sequence from a `requestAnimationFrame` chain started before `set-card-folded` is sent, on the release build with the user's content and a session card of ordinary size, plus a 1 ms `sample` across the gesture. The `settle-frames` row is not evidence about the first frames of a fold ([F05]) and a bench or empty deck is not evidence about its cost ([F06]). "Fixed" means the leading dead time is under one frame and no gap in the motion exceeds one frame, read that way, on that deck, and written into the arc's record.

**[B02] The `settle-frames` row measures from the gesture, or says it cannot.** `firstPaintDelayMs` becomes a real number — the time from the fold's dispatch to the settle's first tick — and the row's `longestGapMs` includes it. `at0622`'s bar moves to the whole motion. An instrument that reports 16 clean ticks while a person sees a jump cut is worse than no instrument, because it is what let the last three verdicts stand.

**[B03] A session card's fold moves through a transform, not a layout property.** Whatever the settle does for a fold, the folding pane's per-frame motion must be compositor-only ([D9] of `tuglaws/animation-doctrine.md`): the `height` tween in [F04] is the thing that puts style, layout and the compositing walk into every frame, and no population diet makes a per-frame layout of a 1630 px pane free. How the pane's box reaches its folded size — a transform tween with one layout at each end, a clip, or the imposer carrying the fold as a scale — is the arc's design call; the invariant is that `settle-frames` reports no `height` violation on a session fold and [F03]'s walk leaves the frame loop.

> **Retired by measurement, 2026-09-29 — the fold ships a real `height` term and that is now the decided shape.** Every candidate this decision left to the arc was tried and none of them survived: a scale deforms a card's chrome at any fold ratio, and no cap admits a halving ([D135]); height-by-occlusion was benched under [D204] and moved neither the lead nor the gap, since a warm fold already leads by 1–3 ms and delivers every frame. What made the `height` term affordable was not removing it but paying it for the frame and *not* for its subtree: the **still crossing** (`data-still-crossing`, `lib/fold-crossing.ts`, `briefs/still-height-crossing-brief.md`) clips the pane's content box and holds the card's root at the larger of its First and Last heights, so the interior lays out once and only the frame's edge moves. So `settle-frames` **does** report a `height` violation on a fold, deliberately, and [D9] records it as a standing hit that `at0622` asserts by name rather than as a defect. [F03]'s walk left the frame loop by the other route this brief measured.

**[B04] The commit frame and the land frame are budgeted separately from the motion.** The 86–130 ms lead is one React commit plus one layout plus one compositing walk over the whole page, and the land is the same again. Making the motion compositor-only does not touch either. Each gets its own reading and its own bar — one frame — and the arc re-measures them after [B03] before deciding what they need, because the walk's share of them may already fall once the motion stops dirtying the tree.

**[B05] The display's scaled mode is read, not assumed.** Before any code moves, the fold is recorded at the display's default mode and at the scaled one, by the recorder in [B01]. If the page delivers its frames on time in [B01]'s reading and the eye still sees a cut at the scaled mode only, that is a WindowServer cost the deck cannot fix and the brief says so; if the readings match, [F07] is closed as a non-factor.

**[B06] The at-rest gauge and the fold recorder ride every future motion claim together.** The previous brief's [B08] said cheap is a reading on the user's deck; this one adds that a *gesture's* frames are read by the recorder in [B01] on the user's deck. A fold, a switch or a shade is not called smooth on a `settle-frames` row again.

---

## Open Questions {#open-questions}

- **Which transform shape the fold takes** ([B03]). A scale tween reads differently from a clip that reveals the folded masthead, and the folded card's face (`session-card.css:1627`, "it cuts rather than folding") already has opinions about what is visible mid-fold. This is a design spike inside the arc rather than a question the brief can settle in prose.
- **Whether the settle should arm all eight panes for a fold** ([F04]). Every pane takes a geometry tween on every fold today; whether the non-folding panes need one, or only the flow siblings do, is answerable by reading `deck-canvas.tsx`'s settle arm and the flow re-solve, and should be answered there before the arc decides what the land frame costs.
- **What the presented-frame instrument is** ([F07]). `screencapture -V` needs a Screen Recording grant for the process that runs the measurement; a CoreGraphics display-stream in the test harness would be the durable form. Not required for [B01], which reads delivery, but required to close [B05].

---

## Non-goals {#non-goals}

- **Re-litigating the at-rest work.** [F01]: it landed and it holds. This brief does not reopen the loops, the gauge or the budgets.
- **A layer or element diet as the fix.** `briefs/workspace-switch-cheap-brief.md` owns the population; here it is the multiplier on a per-frame layout that should not be happening at all ([B03]). Shedding layers to make a wrong-shaped fold cheaper is the [F08]-style mistake of the previous brief made again.
- **Touching the sidebar cards' fold.** It reads perfect ([F02]); the shade ease in `chrome.css` is theirs and works.
- **Calling anything fixed on the bench, an empty deck, or the `settle-frames` row.** [B01], [B02], [F05], [F06].

---

## Exit {#exit}

An arc. The order that matters:

1. Fix the instrument first ([B02]): `firstPaintDelayMs` real, the row's longest gap spanning the gesture, `at0622` red on the user-deck shape of [F02] before anything else moves — and the recorder of [B01] written down as a `tugtool`-drivable procedure so the reading is repeatable.
2. Read [B05] at both display modes and record it.
3. Make the session fold's motion compositor-only ([B03]), read it by [B01] on the user's deck, and record the reading.
4. Read the commit frame and the land frame after that ([B04]); open whatever they still need with their own numbers.
