# Solidify the departure ghost

**Purpose:** A closing card leaves a copy of itself behind, and the copy is drawn a few pixels away from where the card stood before it fades. The code that manages that copy has no contract holding its geometry, its identity, or its lifetime, so this is the second time in a day it has leaked. It must not be able to leak again.

---

## Purpose {#purpose}

The user's report, watching a Session card close in a flow band:

> We *copy* a card, move it, and then fade it? … Making snapshots is *almost always an undesirable wart*. We should really operate on the actual components as much as possible.

and, having heard the history:

> Write a brief to *solidify* the code that manages the ghost. We can't have this hopping around as we do now. The ghost/copy must not *ever* leak like this again.

What the reader sees is three frames: the live card; a copy of it shifted right and down by the width of the strip gap; the copy fading. The card has not moved. The copy is mispositioned. The question the brief answers is how the ghost is held to one rule so that neither this leak nor its cousins can recur, without deciding here whether the ghost should exist at all.

---

## Evidence {#evidence}

**[F01] The ghost is a month old; the face is a day old.** — `520f094eb` (2026-08-19, the layout-imposer-motion dash) introduced `.tug-pane-exit-ghost`: an inert `position: fixed` tile planted at the departing frame's last measured rect, carrying only the pane's background and radius, faded over `PANE_EXIT_GHOST_MS` and removed. `ebcb64175` (2026-09-15 09:00, the height-before-commit arc) added the **face**: on `cardWillBeginDestruction` the whole `.tug-pane` subtree is deep-cloned, stripped of six identity attributes (`FACE_IDENTITY_ATTRS`), marked `aria-hidden` and `inert`, and planted inside the ghost so the card fades "as itself rather than as a blank rectangle". `git log -S` on both strings; `tuglaws/animation-doctrine.md` line 122 and `tuglaws/pane-model.md` line 465 record the ghost's doctrine. **(verified)**

**[F02] The copy is drawn offset because the clone keeps the frame's inline geometry.** — The live frame's `style` attribute carries `position: absolute` and the imposer's `left`/`top` (`tug-pane.tsx`, the `style={{ position: "absolute", ...modeStyle, ...exitStyle, … }}` block). `cloneNode(true)` keeps that attribute. The stylesheet pins the face with `.tug-pane-exit-ghost > .tug-pane-exit-face { position: absolute; inset: 0 }` (`tug-pane.css`), but inline `left`/`top` outrank a class rule, so the face is laid out *inside the ghost* at the pane's own canvas coordinates — the strip gap `IMPOSITION_GAP_PX` (5px) plus the border, which is the shift in the screenshots. The ghost itself is placed correctly; its contents are not. **(verified by reading; the shift in the screenshots matches the arithmetic, and the fix was not applied so the reproduction is still live)**

**[F03] Nothing tests where the face is.** — `at0450` asserts a ghost exists mid-fade and is gone at rest; `at0571` asserts the ghost carries a face and that the face carries the picker. No test compares the ghost's rect, or the face's rect, to the rect the frame was measured at. The mispositioning is invisible to the corpus. **(verified)**

**[F04] The ghost has exactly one door in and three doors out, and they are not in one place.** — In: the Last pass, for every pane the arm measured that has no frame after the commit (`deck-canvas.tsx`, "The departures"). Out: the `depart` beat's landing removes it; the unmount teardown does not (it clears tweens and transforms, not ghosts); a retarget between `arm` and the beat leaves the beat's completion handler to remove it "unconditional on the generation". The face's own lifetime is a third thing: taken on `cardWillBeginDestruction`, held in `departureFacesRef`, consumed by the next Last pass, and the map cleared "so a stale face can never be planted in a later departure's ghost". Three refs, two beats, and a subscriber own one object's lifetime between them. **(verified by reading)**

**[F05] The face is a live DOM subtree with live styles, not a picture.** — The clone carries every class, every inline style, every custom property, and every descendant of the pane, including portaled sheet content (the picker) and anything a card renders with `position: fixed`. `FACE_IDENTITY_ATTRS` strips what addresses a node by name; it does not strip geometry, `data-*` state attributes a stylesheet keys on, or ids on descendants that were not in the list. The docstring on `departureFacesRef` already concedes "the handful of CSS rules keyed on `data-slot` tune details a 240ms fade does not show". The class of leak in [F02] — a property the clone carried that the ghost did not expect — is open-ended as long as the clone is the whole subtree with its styles intact. **(verified by reading; not enumerated)**

**[F06] The frame's teardown and the ghost's are unrelated code paths.** — The real pane is unmounted by React on the removal commit; the ghost is appended to the canvas container outside React ([L06] territory). A frame carries `settleTweensRef` entries, resize episodes, and fold crossings, all ended by name in the settle; a ghost carries none and is tracked only in the local `departures` array of one Last pass closure. A stranded ghost — one whose `depart` beat never ran — is exactly the case the completion handler's comment describes, and the only guard against it is that comment. **(verified by reading)**

**[F07] Yesterday's two cuts were a different defect from this one.** — The 479px single-frame jumps fixed in `eb21d9c82` and in the uncommitted `land()` change were survivors mis-measured by the settle's arm; the ghost was correctly placed throughout. This brief is about the ghost's own geometry and lifetime, and does not reopen those. **(verified by the `at0576` census)**

---

## Decisions {#decisions}

**[B01] The ghost stays, for now, as the carrier of a departure; this brief hardens it rather than replacing it.** The user's instruction is to solidify the code that manages the ghost. Replacing the ghost with a departing state on the real component is a larger change with its own brief (see Non-goals), and hardening the ghost is worth doing even if that change lands later, because every rule below is a rule the replacement would also have to keep. Revisit if the replacement lands first, in which case most of this brief becomes moot and should be retired with it.

**[B02] The face carries no geometry of its own. Ever.** The ghost owns position and size; the face is a picture that fills it. The clone must be stripped of every inline geometry property — `position`, `left`, `top`, `right`, `bottom`, `width`, `height`, `transform`, `transform-origin`, `inset`, `visibility`, `opacity`, `z-index` — on the root node, and the face rule must be the only thing that places it. This is a **strip list beside `FACE_IDENTITY_ATTRS`**, named, exported, and tested, not a one-off `removeProperty("left")`. [F02] is the leak; this is what makes it impossible rather than fixed.

**[B03] The ghost's rect is the frame's last measured rect, and a test reads them against each other on every frame of the fade.** One rule places the ghost, one rule fills it, and `at0450`'s card-close gesture (or a dedicated file) samples the ghost's and the face's bounding rects on every animation frame of the `depart` beat and asserts both equal the rect the arm measured, within a pixel. A ghost that stands anywhere else, or a face that stands anywhere inside the ghost but at its edges, fails the census. [F03] says this is the missing gate.

**[B04] The face is inert in every sense, and the strip list says so.** `inert`, `aria-hidden`, `pointer-events: none` on the root, and no node under it may answer a live selector — the identity strip extends to every `id` on every descendant, not only the six attributes on the root. A test asserts that while a ghost stands, no selector the deck, the harness, or the focus machinery uses resolves inside it. This is the [F05] class, closed by enumeration where it can be and by test where it cannot.

**[B05] The ghost has one owner with one lifetime, and every path out of the settle takes it away.** A ghost is registered the moment it is planted, in one ref beside `settleTweensRef`, and removed by name in every exit: the `depart` beat landing, the window sweep, a retarget's arm, and the canvas unmount. The "unconditional on the generation" comment in the completion handler stops being the only guard. `at0450`'s existing "no ghost at rest" assertion extends to every one of those exits, so a stranded ghost is a red test rather than a tile the user finds later. This is [F04] and [F06] made into a rule.

**[B06] The face is taken once, at the last moment the frame exists, and consumed once.** That is already the intent of `departureFacesRef`'s clear-after-plant; the decision is to make it a property the test can read: a face never outlives the Last pass that follows the notification that took it, and a Last pass never plants a face taken for a different pane. A counter on the ref, or a test that closes two cards in one gesture and checks each ghost wears its own face, pins it.

**[B07] The ghost's CSS is a closed contract, and the pane's is not allowed to reach into it.** `.tug-pane-exit-ghost` and `.tug-pane-exit-face` are the only two selectors that style the ghost, and the face rule wins over anything the clone brought with it by construction (the strip in [B02]), not by specificity. No `.tug-pane` rule keyed on a `data-*` attribute may change the ghost's box; if a rule needs to tune the fade's appearance, it is written on the ghost's selectors.

---

## Open Questions {#open-questions}

- **Whether the face should be a clone at all, or a raster.** A `cloneNode` of a live card is the open-ended leak class in [F05]. A rasterized still (a canvas snapshot or a bitmap of the frame) has no styles to leak and no selectors to answer, but it costs a paint and it is not something the deck does anywhere today. This brief does not settle it because the strip list in [B02] and the tests in [B03] and [B04] close every leak found so far without it; it should be revisited if a third leak of the [F05] class appears.

---

## Non-goals {#non-goals}

- **Replacing the ghost with a departing state on the real component.** The user's instinct is correct and recorded: a snapshot is a wart, and the deck already has the symmetric half in the `arriving` mark. A `departing` mark that keeps the real frame mounted, inert, and excluded from the imposer's arithmetic through the fade would make the ghost, the face, and both strip lists unnecessary. That is its own brief, and it is *deferred*, not rejected: this brief hardens what exists so the deck is correct in the meantime, and nothing here makes the replacement harder.
- **Reopening the settle's arm.** The two single-frame cuts of the last two days ([F07]) were the arm mis-measuring survivors; they are fixed and tested by `at0576`, and this brief does not touch that path.
- **Changing what the fade looks like.** Its duration, curve, and the decision that a card fades as itself rather than as a blank tile are as decided in `ebcb64175` and `tuglaws/animation-doctrine.md`; the ghost merely has to stand where the card stood.

---

## Exit {#exit}

**An arc.** The shape of the first steps:

1. Name the geometry strip list beside `FACE_IDENTITY_ATTRS` and apply it to the clone's root; make the face rule the only placement ([B02], [B07]).
2. Extend the identity strip to every `id` under the face and assert inertness with a selector census ([B04]).
3. Register planted ghosts in one ref and remove them by name on every settle exit ([B05]); pin one-face-one-ghost across a two-card close ([B06]).
4. Add the per-frame rect census to `at0450`'s card-close gesture, or a dedicated `at05xx`, comparing ghost and face rects to the measured First rect on every frame of the `depart` beat ([B03]).
5. Update `tuglaws/animation-doctrine.md`'s departure paragraph and `pane-model.md`'s note on the exit ghost to state the contract: the ghost owns geometry, the face owns nothing, and one ref owns the lifetime.

Step 1 lands first because it is the live defect; the census in step 4 should be written to fail against the tree as it stands before step 1, so the gate is known to see what it gates.
