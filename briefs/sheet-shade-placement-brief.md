# Sheets and shades are placed against a box that is not there

**Purpose:** A `display: contents` workspace wrapper now stands between every pane frame and the canvas container, and `tug-sheet.tsx` still resolves the canvas by DOM parentage — so both of its clamps measure a rect of zeros and neither ever re-measures. Every pane-modal sheet on the deck is mis-placed, and the two the user met are the two faces of it.

---

## Purpose {#purpose}

> "How can it be that this is the way the new session card renders? … What a comedy of errors. UGH! And the AI configuration sheet (⌘I) doesn't render visibly at all (I see only the scrim). We have botched basically everything about placing sheets and shades."

The screenshot shows an unbound Session card whose picker panel stands about 248 CSS px tall inside a frame at least twice that, with the Sessions list cut off mid-row and dead space below. The same card answers ⌘I with a scrim and no panel.

Two different surfaces, two different symptoms, and the reading that they are unrelated accidents is wrong. They are one cause with two faces, plus an older regression that has been sitting red underneath them.

---

## Evidence {#evidence}

**[F01] A `display: contents` wrapper now stands between every pane frame and the canvas container.** `workspaces-refine` (`f5c8d7d54`, 2026-09-16) made a workspace switch a style change: `deck-canvas.tsx` renders one `<div class="tug-space-layer">` per mounted workspace, shown as `display: contents` and hidden as `display: none` (`tugdeck/src/components/chrome/space-layer.css`). `git log --diff-filter=A` confirms both `space-layer.css` and `space-layer.ts` are new in that commit — the first workspaces arc (`b2174629f`) had no wrapper. **(verified)**

**[F02] The arc knew this breaks parentage-based canvas lookups, wrote the fix, and did not apply it to the sheet.** `tugdeck/src/components/chrome/space-layer.ts` exports `paneCanvasOf(el)`, which resolves the canvas by `closest([CANVAS_BACKGROUND_ATTRIBUTE])` — by what it *is* rather than where it sits. Its own doc names the five call sites it converted ("the drag clamp, the resize clamp, both snap-guide hosts, and `DeckManager`'s canvas-relative pane rect") and states the failure mode verbatim: *"`parentElement` still answers, and it answers with a rect of zeros. Every one of those readings would have gone quietly wrong rather than loudly."* `grep` for `paneCanvasOf` finds six uses, all in `tug-pane.tsx` and `deck-manager.ts`. **(verified)**

**[F03] `tug-sheet.tsx` still reads the canvas by parentage, at both clamps.** `tugdeck/src/components/tugways/tug-sheet.tsx:1436` (bottom-anchor clamp) and `:1558` (top-anchor clamp) both do `const canvas = paneFrameEl.parentElement`. That now resolves to the space layer, which generates no box, so `canvas.getBoundingClientRect()` is all zeros. **(verified by reading; the zero rect is specified behaviour for `display: contents` and is asserted by `space-layer.ts`'s own doc)**

**[F04] A zero canvas bottom pins a top-anchored panel at the resize floor, which is the picker the user photographed.** The top-anchor clamp computes `bottomLimit = Math.min(canvas.getBoundingClientRect().bottom, window.innerHeight)` — now `0` — then `available = bottomLimit − SHEET_CANVAS_GAP − clipBox.top − marginTop`, which goes strongly negative, and writes `max-height: Math.max(SHEET_RESIZE_MIN_HEIGHT, available)`. `SHEET_RESIZE_MIN_HEIGHT` is `250` (`tug-sheet.tsx:282`). The screenshot's panel measures ~248 CSS px. **(verified: the constant, the arithmetic, and the measurement agree)**

**[F05] The corpus already says so, in the assertion's own words.** `just app-test at0558-sheet-visibility.test.ts at0569-sheet-reservation.test.ts at0571-picker-card-arrival.test.ts` returns `VERDICT: FAIL (0/3 files green; 2/10 tests passed)`. `at0569` fails on *"the panel stands at its natural height rather than capped short"* — expected ≤ 1.5, received **118**. `at0558` fails `topCutPx` on three cases — expected ≤ 0.5, received **38** — including "the AI settings sheet is whole with a tall composer", and fails `panelOverlapsPeerPx` with **−368**. **(verified by running it)**

**[F06] The bottom-anchor clamp degrades differently, and that is the ⌘I face.** Every `rise` sheet — AI config, Usage, Help, Rewind, Memory, Skills, Agents, Hooks, Resume, Rename, Card Settings, the permission rules editor, and `presentAlertSheet` — passes `bottomAnchorSelector: MODAL_REST_LINE`, so it takes the bottom-anchor path. With a zero canvas box, `visibleBottom = Math.min(0, innerHeight) = 0` and `visibleTop = Math.max(0, 0) = 0`, so the downward floor and the upward ceiling are both computed against the viewport origin rather than against the canvas, and the clip is driven off the band it is supposed to occupy. `at0558`'s `topCutPx = 38` on the AI-settings cases is that displacement measured. **(verified as far as the arithmetic and the test; the user's specific "only the scrim" frame was not reproduced here, and [F09] names a second mechanism that can produce the same appearance)**

**[F07] Nothing re-clamps, ever, so no later pass repairs the first bad measure.** The clamps deliberately stopped observing the frame and the canvas ([B07]/[F06] of `sheet-visibility`) and re-measure on `window resize` plus `IMPOSER_SETTLE_END`, which they listen for on the *same* `paneFrameEl.parentElement`. `dispatchImposerSettleEnd` fires on `containerRef.current` with `bubbles: false` (`tugdeck/src/lib/settle-notice.ts`). The listener now sits on a child of the dispatch target, so a non-bubbling event never reaches it. That module's doc still states the invariant this depends on — *"every pane frame renders as a direct child of the canvas container … The dispatch is non-bubbling for that reason"* — and that sentence is now false. **(verified)**

**[F08] A third site was missed with the same shape.** `session-card-telemetry-renderers.tsx:1709` passes `bottomBoundEl={foldedForm ? (paneFrameEl?.parentElement ?? null) : null}` under a comment reading "The visible canvas is what caps a downward panel" — the same zero rect, capping the folded card's placard. **(verified by reading)**

**[F09] The presented state of every animated sheet and shade is not a state; it is the residue of a finished animation.** `tug-sheet.css` gives each presentation an "off" resting state — `rise`/`settle` rest at `translateY(28px); opacity: 0`, `scale-fade` at `scale(0.96); opacity: 0`, the shade at `translateY(-28px); opacity: 0`. Nothing in CSS expresses "presented". Visibility is established only when the enter animation completes and `tug-animator.ts` calls `wapiAnim.commitStyles()` to write the final values inline. `commitStyles()` throws `InvalidStateError` when the target is not being rendered, and the animator catches, cancels, and proceeds — returning the panel to `opacity: 0` with its scrim still up. The enter effect's own `g.finished.catch()` does nothing but comment; the exit effect's forces `setMounted(false)`. **(verified by reading; the asymmetry between the two catches is in the source)**

**[F10] Workspaces made that failure reachable rather than theoretical.** A hidden workspace layer is `display: none`, so its whole subtree is not being rendered — exactly `commitStyles()`'s throw condition. A sheet whose entrance is in flight when the user switches workspaces, or any sheet raised in a workspace that is not on screen, lands cancelled at `opacity: 0` and never recovers, because nothing re-runs the entrance except a `paneFrameEl` change. **(inference from [F09] and `space-layer.css`, not reproduced; a switch driven mid-entrance with the panel's computed `opacity` read afterwards would confirm it)**

**[F11] `at0558` is structurally blind to [F09].** Its `finishAnimations` helper calls `a.finish()` on every animation under the sheet before each measure, and its docblock explains why: the harness window is occluded, the document timeline never advances, and the panel would otherwise read `opacity: 0` forever. That workaround is also exactly what would hide a genuinely stuck entrance. **(verified by reading the test)**

**[F12] A second, older regression is sitting underneath all of this.** `at0571-picker-card-arrival` has been **red in the last 12 recorded runs**, back to `d4234b955` (2026-09-15); last green `ebcb64175`. The `hidden-arrival` arc lands in that range. Two assertions fail: the arrival's beat census is now `["move", "room", "arrive"]` where the test demands exactly `["room", "arrive"]` — a `move` beat crept back into what was promised as one settle, and the test's own comment anticipated precisely that — and `shares[newcomer]` is `undefined` against "the arrival wrote its weight into the column's division". **(verified by running it and reading the assertions)**

**[F13] The reds were available and unread for a day.** `tugtool apptest history` gives `at0558` last green `5f1536ffd` and `at0569` last green `a91288dc9`, both on 2026-09-15, with `f5c8d7d54` the next recorded run and red. `at0571` has been red for twelve. Between `5f1536ffd` and `f5c8d7d54` the only change to a pane frame's DOM parentage is [F01]. **(verified)**

**[F14] The surface has taken ten arcs in roughly a week.** `git log` on `tug-sheet.tsx` alone lists `session-modal`, `sheet-visibility`, `folded-card-surfaces`, `compaction-fold-door`, `sheet-reservation`, `picker-card-arrival`, `member-height-one-rule`, `height-before-commit`, `hidden-arrival`, and `compaction-fold-face`, with `unbound-floor` and both workspaces arcs adjacent. Each adjusted one term of a shared geometric equation. **(verified)**

---

## Decisions {#decisions}

**[B01] A surface resolves the canvas by identity, never by DOM parentage.** `paneCanvasOf()` already exists and already says this ([F02]); the defect is that it was applied to the five sites that read the *containing block* and not to the ones that read the *visible canvas*. Both readings want the same element and neither wants a parent. Every remaining `parentElement`-to-canvas lookup — `tug-sheet.tsx:1436`, `tug-sheet.tsx:1558`, `session-card-telemetry-renderers.tsx:1709` — moves to the helper. Revisit only if the canvas stops being identifiable by its own attribute.

**[B02] The settle-end notice must reach a listener wherever it sits, and the non-bubbling choice is retired.** [F07] is not a second bug; it is [B01] applied to the listener side, and fixing only the box would leave every sheet clamping once against a correct canvas and never again. The listener resolves its target through `paneCanvasOf` like everything else, and `settle-notice.ts`'s paragraph asserting direct-child parentage is deleted rather than amended — a doc that states a false invariant is worse than one that states none, because the next reader budgets against it.

**[B03] A measure that reads a zero-area canvas refuses instead of clamping.** The arc that introduced the wrapper wrote the rule already — *"a measurement taken in the dark reads zero and sticks"* — and armed pane geometry on the transition to shown. The sheet clamps never got it. A clamp that finds a zero canvas box writes nothing and leaves the previous cap standing; with no previous cap it leaves the CSS fallback. This is what turns the next occurrence of this class from a silent mis-placement into a no-op, and it is worth having independently of [B01] because it is the general guard rather than the specific repair.

**[B04] The presented state gets a home in CSS, and the enter path gets the fallback the exit path already has.** [F09] is the deeper defect and it outlives this particular wrapper: a panel whose visibility exists only as the residue of a completed animation is invisible whenever that animation is cancelled, suspended, or uncommittable. The presented geometry becomes a declared state the component writes when the entrance resolves — so a cancelled or throwing `commitStyles()` costs the *animation*, not the *panel* — and the enter effect's `catch` forces that state the way the exit effect's `catch` forces `setMounted(false)`. What this rules out is leaving the two catches asymmetric and calling the enter one "interrupted, nothing to do".

**[B05] The arrival beat regression is in scope, and it is fixed rather than re-pinned.** [F12] is a different cause from [F01]–[F08] and could be argued out of this work. It is kept in because it is the same surface, it is already red, and the standing memory that rewriting a pin buries a decision applies with full force: the `move` beat and the missing weight are corrected until `at0571` passes as written, and the test is not re-pointed to match current behaviour.

**[B06] A test that owns a surface is run by any arc that changes that surface.** [F13] is the reason all of this reached the user rather than a `VERDICT: FAIL`. The specific hole is worth naming: `unbound-floor`'s brief decided **"No app-tests"**, meaning no *new* ones — the harness cannot see that class of motion — and that decision was read as licence not to *run* `at0569` and `at0571`, the two existing tests that own the picker's height and arrival. Those are different things and the brief's wording collapsed them. Declining to write a test is a judgment; declining to run the one that already exists is not.

**[B07] `at0558` grows a case that does not finish the animations.** [F11] means the file that exists to prove a sheet is wholly visible cannot see the most likely way for it to be invisible. The force-finish stays for the geometry cases — it is the honest workaround for an occluded harness — and one case reads the panel's computed opacity on a path where the entrance was interrupted, so [F09]'s failure mode has somewhere to fail.

---

## Open Questions {#open-questions}

- **Whether the user's ⌘I frame is [F06] or [F09].** Both produce "scrim, no readable panel", and they want different fixes — [F06] is repaired by [B01] alone, [F09] needs [B04]. The audit established both mechanisms are live but did not reproduce the user's exact frame. What settles it: open the AI config sheet on a card in the shown workspace and read the panel's computed `opacity` together with its client rect. `opacity: 0` with a sane rect is [F09]; full opacity with a rect outside the card is [F06]. Worth doing first, because it decides whether [B04] is part of the first landing or a follow-on.

- **Whether anything outside the deck reads the canvas by parentage.** The sweep here covered `tugdeck/src` for `parentElement` and found three canvas-shaped lookups ([F03], [F08]). The rest are ancestor walks that terminate on a `closest()`-style predicate and are indifferent to an extra level. A guard that makes a fourth one impossible — a lint, or making the raw lookup unavailable — is a real option but not obviously worth its cost, and the shape of that guard is not settled here.

---

## Non-goals {#non-goals}

- **Reverting the workspace layer, or giving the shown wrapper a box.** `display: contents` is the right call for what it was chosen for — no new stacking context, no new containing block, a switch that costs a style recalculation. The defect is three unconverted call sites, not the wrapper.

- **Re-pointing `at0558`, `at0569` or `at0571` to match current behaviour.** Every one of them is failing because it is correct. `at0571`'s beat-census assertion in particular was written as a whole census specifically so a `move` creeping back would fail loudly, and it did its job.

- **Reopening what the sheet clamps observe.** The narrowing to `window resize` + `IMPOSER_SETTLE_END` was `sheet-visibility`'s answer to a sheet flickering its own cap through a settle, and that reasoning still holds. The notice needs to arrive ([B02]); it does not need to be replaced by an observer.

- **Redesigning the rest line, the anchor fallback, or the display-width tiers.** All three read correctly against `tuglaws/modal-rest-line.md`; the anchor follows the *resolved* element (`data-vertical-anchor` is written from `bottomAnchorEl !== null`, `tug-sheet.tsx:2360`), which is what that law asks for. Nothing found here argues against them.

- **Changing the unbound Session picker's top anchor.** It uses `presentation: "none"` and no rest line because an unbound card has no view slot, which is exactly the fallback the rest-line law describes and calls "not an exemption". It is on the right path; the path was broken under it.

---

## Exit {#exit}

An arc, and the order matters because the audit's own open question sits inside it.

Settle the ⌘I frame first — one reading of the AI config panel's computed opacity and client rect — because that is what decides whether [B04] lands with the rest or after it. Then the repair that everything else waits on: `paneCanvasOf` at the three sites ([B01]), the settle-end notice reaching its listeners with the false invariant deleted ([B02]), and the zero-box refusal ([B03]). Those three are one change to one subsystem and should land together; `at0558` and `at0569` are the read on whether they worked, and both should go green on it.

Then [B04], the presented state, which is its own shape of work and touches the animator boundary as well as the sheet. Then [B05], the arrival beat and the missing weight, until `at0571` passes as written. [B07]'s new case belongs with [B04], since it is the assertion that would have caught it.

[B06] is not a code step and should not be written as one; it is a habit this work exists to establish, and the place it becomes real is the next brief that decides "no app-tests" and has to say which existing ones it will still run.
