<!-- brief-skeleton v1 -->

# The settle engine and the Beat

**Purpose:** The deck's motion is sound and lives in one 8,291-line component, and it has six named beats with no object that is a beat. Before the settle is changed again — the `departing` mark, height by translation, one hold — the settle needs a module of its own and the Beat needs to exist, so the next arc edits a thing rather than a region of a file.

---

## Purpose {#purpose}

`briefs/graphics-animations-asks.md` asked for a system rather than one-off fixes, and named the Beat as the second of five concepts:

> One object above `animate()` in `tug-animator.ts` that owns five things: the start pose written to the DOM by the frame before any clock exists, a start tied to a painted frame and never to a task, transform and opacity on layers that already stand, one hand-back of the end pose, and its own frame record.

Three audits later (2026-10-01 to 2026-10-02) the settle architecture is in good shape and the Beat is still unbuilt, and `DeckCanvas` has grown with every arc. The third audit's verdict was to move past the asks brief's scope, with the Beat and the canvas's size named as design work rather than fixups. The user asked for the sketches and then:

> write the first two

This is the first. It pairs the two because they are both behaviour-preserving, the extraction creates the module the Beat's callers live in, and they share one reading.

Updated 2026-10-03 after three more arcs landed (`c7b4ae09e`, `0a16691e8`, `a6232e3ac`): `at0654` is deleted and its readings live in `briefs/zero-red-app-tests-brief.md`; three bars were re-budgeted on the user's word; the canvas grew two more settle writers. A third brief, `briefs/settle-window-commit-brief.md`, now carries the large commit inside the settle window, and this one is written to run before it.

---

## Evidence {#evidence}

**[F01] `DeckCanvas` is 8,291 lines, 27 top-level functions and 17 banner sections, and one ~5,600-line component function.** `wc -l` and `grep` at `7b216491d`. Its concerns, by banner: the z-order map and sidebar ranks, the pane-raise and pane-focus subscribers, the settle (`arm` at `deck-canvas.tsx:5250`, the Last pass, `BEAT_RECIPE` at `:936`, the ghosts at `:6045` and `:6116`, the sweep, `drainArrivals`, the inline restorer), the workspace layers and their loops, the overlays, the responder registrations, and the imposer's flow offset. `a6232e3ac` added two more settle writers to it on 2026-10-03: every arrangement variable is now written to the shown layer as well as the canvas (`setArrangement`), and `whenBeatBegins` takes a `stale` arm that cancels an arrival's fades when a later `arm` supersedes the settle. Both belong to the engine and move with it. **(verified, read)**

**[F02] The rail-width-drag arc showed the extraction shape that works here.** `8295073f6` took 440 lines out of `tug-pane.tsx` into `chrome/rail-width-draft.ts`, a draft owner the canvas instantiates once and provides through context; the pane became an emitter of begin/change/commit/cancel. `space-layer-loops.ts` and `pane-occlusion-controller.ts` are the same shape, already beside the canvas. **(verified, read from the commit)**

**[F03] The settle has six beats as recipe names and no beat object.** `BEAT_RECIPE` maps `depart`, `room`, `shrink`, `move`, `grow`, `arrive` to `MotionRecipe`s, and the Last pass builds each from keyframes and `animate()` inline. The pre-launched flow move is built a second way, in `arm`, with its own `land`. The five properties the asks brief named are each present somewhere in the canvas, and no one place owns them. **(verified, read)**

**[F04] The raw `element.animate()` sites in product code are two, not twenty-two.** A census that matched `.animate(` found 22 calls; 20 are `g.animate(` or `settle.animate(`, the animator's group API, in `tug-sheet.tsx`, `tug-pane-banner.tsx`, `tug-modal-input-dialog.tsx`, `session-card.tsx` and `block-reorder.ts`. The raw sites are the settle's play-pending marker, `el.animate(null, …)` at `deck-canvas.tsx:6239`, and `panel.animate(` in `tugways/chrome/find-wrap-overlay.tsx:75`. The frame probe and the trace mention `el.animate()` in comments only. **(verified, grep at HEAD; the third audit's count of 22 was the matcher's, and is corrected here)**

**[F05] The fan-out ratchet names `deck-canvas.tsx` at its ceiling.** New app-tests (`at0672-pane-press-raises-in-its-task`, the rail tests) leave the canvas out of their `@covers` because `ACCEPTED_FANOUT` only pays down, so an edit to `pane-raise` or `paneZIndexMap` selects no test by derivation. The ceiling is a symptom of the file's size, not a policy anyone wants. **(verified, read from the test headers)**

**[F06] The frame record already exists per settle, not per beat.** `startSettleFrameRecord(el)` in `arm`, and `settle-frame-probe.ts`, record the settle window; `tugtool deck motion slide` and `at0622`'s fixture read it. The asks brief's "one instrument, one bar, every beat" is a per-beat row with a fixed bar, and nothing today identifies which beat a frame belonged to. **(verified, read)**

**[F07] L14's boundary stands.** Radix Presence owns enter and exit for Radix-managed surfaces through CSS `@keyframes` and `data-state`; TugAnimator does not cross it. The sheet, banner and modal sites in `[F04]` are TugAnimator groups on elements whose insertion and removal the code controls, so they are inside the animator's side of the line. **(verified, read against `tuglaws/tuglaws.md` L14)**

---

## Decisions {#decisions}

**[B01] The settle leaves `DeckCanvas` first, as a `settle-engine.ts` the canvas instantiates once, with no behaviour change.** `arm`, the pre-launch, the Last pass, the beats, the ghosts, the sweep, `drainArrivals` and the inline restorer move together, because they share the refs that hold a settle's state. The canvas keeps the subscription and hands the engine its root and the store. The same move, smaller, takes the z-order map and the pane-raise writer into `pane-stacking.ts`. The reading is the one `[B05]` names. This lands before the Beat because the Beat's first callers are the six settle beats, and they should be edited in their own file.

**[B02] The Beat is one object above `animate()` in `tug-animator.ts`, and it owns the five properties.** A `Beat` is created with a recipe name, its targets, and a start-pose writer; it writes the start pose to the DOM when planned, starts on a painted frame (the current task's rendering update when created in a task, which is what pre-launch already relies on), animates only transform and opacity on elements that exist at plan time, hands back the end pose once through one `land`, and writes its own row to the frame record with its recipe name. It does not fix the two standing D9 hits (the division's `height`, width over the raster cap); a Beat that carries one of them declares it, so the record names which beat paid. The six settle beats and the pre-launched move become Beats; the second way of building the move in `arm` goes.

**[B03] The lint refuses raw `element.animate()` and entrance `@keyframes` outside a declared set.** The shape is `react-door.test.ts`'s: a sweep over `tugdeck/src` that reads a file calling `.animate(` on anything but the animator's group, or declaring an entrance `@keyframes` in a product stylesheet, as a breach unless the file is in a declared carve-out list. The list starts with the animator itself, the Radix-bound stylesheets L14 names, the instruments (`settle-frame-probe.ts`), and the registered loops. The two raw sites in `[F04]` are converted or declared, with a reason, before the lint lands. `bun run audit:motion` is the natural host if its scanner can carry the rule; a new test is the fallback.

**[B04] The group API stays, and is not the lint's target.** `g.animate(` is how TugAnimator makes a tween; the twenty sites in `[F04]` are correct uses of it. Turning every opacity fade in a sheet into a Beat is not this work. A Beat is for motion that moves a layer the deck arranges; a group is for everything else.

**[B05] Both halves land only with the unit tests and the settle app-tests read the same before and after, alone, at HEAD.** A behaviour-preserving refactor's reading is that nothing moved: the unit tests, `at0622` at its 2026-10-03 budgets (resize-to-fit 2.5 frames), `at0566`, `at0605` and `at0643` as corrected and re-budgeted that day, the fixtures' numbers within their recorded ranges. `at0654` no longer exists; the five readings it carried are in `briefs/zero-red-app-tests-brief.md` and are not this arc's to move. `ACCEPTED_FANOUT` pays down for `deck-canvas.tsx` by whatever the extraction earns, and the new modules take `@covers` lines from the tests that exercise them.

---

## Open Questions {#open-questions}

- **Where does the Beat's start pose come from for a beat the Last pass plans?** The pre-launched move computes it from the store; the Last pass measures it. Both are "First"; whether a Beat takes a pose or a function that produces one decides how much of the Last pass survives as reconciliation. Settled while writing the first Beat.
- **Can `audit:motion` host the lint?** Read its scanner; if it already walks TypeScript for motion rules, the rule goes there, otherwise a test.
- **Does the per-beat frame record change `at0622`'s fixture?** The fixture reads a settle row. A beat row beside it is additive if the settle row stays; the fixture decides.

---

## Non-goals {#non-goals}

- **The `departing` mark, height by translation, the large commit in the settle window, and one hold.** `briefs/departing-and-height-crossing-brief.md`, `briefs/settle-window-commit-brief.md` and a later brief. This arc makes them legible; it does not build them. In particular the canvas's whole-snapshot `useSyncExternalStore` moves into the engine as it is; narrowing it to selector reads is the commit brief's [B03].
- **Changing any recipe, duration or curve.** Behaviour-preserving throughout.
- **Making every group animation a Beat.** `[B04]`.
- **Breaking up `tug-pane.tsx` (5,138 lines).** Real, and a different file with a different set of concerns.
- **Loosening any frame bar.**

---

## Exit {#exit}

**An arc.** First the settle engine and the stacking module leave the canvas (`[B01]`), with the reading taken before and after (`[B05]`). Then the Beat is written in the animator and the pre-launched move becomes the first Beat, since it is the one with a store-computed start pose; the six Last-pass beats follow. Then the two raw sites are converted or declared and the lint lands (`[B03]`). The reading is taken once more at the end.
