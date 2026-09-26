# A progress indicator must cost no row height

**Purpose:** The UpdateTug wizard's rows grow taller when the step they describe starts working, because the progress bar is laid out as a third line inside the row's content column. A row's height must be a property of the row, not of its state.

---

## Purpose {#purpose}

The user's words, on seeing the check row grow a barber-pole bar while `checking`: "I *never* want the size of rows to change like this. Adding a progress indicator *must not* add another row. Fix this design."

The wizard opens with four plinths of one height. Press *Check Now* and the first plinth grows — label, detail line, and now a bar beneath them — and the three rows below it, and the Close button, are pushed down. The same happens on `downloading`, on `extracting`, and on `installing`, each time to a different row, so the panel's geometry moves at four points in a flow the user is watching rather than driving.

---

## Evidence {#evidence}

**[F01] The row stacks its two content slots, and its height is a floor rather than a height** — `tugdeck/src/components/tugways/tug-step-row.tsx` renders `{detail && <span …>}` and `{body && <div …>}` as consecutive children of `.tug-step-row-main`, which is `flex-direction: column`. `tug-step-row.css` applies the host's `--tugx-step-row-h` as `min-height`, so a row carrying both simply grows past it. **(verified, both files read)**

**[F02] The row's own stylesheet states the opposite, twice** — its header says "Every row is the SAME fixed height whatever its state, so a step growing from one line to label + detail + CTA never makes its host hop," and the comment on `.tug-step-row-body` says the slot "takes the detail's place rather than stacking below it, so such a row is the same two lines as every other row." Neither is true of the code beneath them. This is a contract the component states and does not keep, which is why every caller has been free to break it without noticing. **(verified)**

**[F03] Every busy stage sets both slots** — in `tugdeck/src/components/tugways/update-tug-rows.tsx`, `deriveUpdateRows` assigns a `detail` and a `body` together on `checking` (`IndeterminateBar`), `downloading` (`TransferBar` plus `StopCostLine`), `extracting` (`TransferBar`), and `installing` (`IndeterminateBar`). Four of the flow's stages, landing on three different rows. **(verified)**

**[F04] ConfigureTug keeps the invariant by hand, and its answer does not transfer** — `configure-tug.css` raises `--tugx-step-row-h` to `104px` on `[data-step="project-dir"]` alone and holds it across that row's choose / creating / failed / chosen states, so the row never hops within itself. That works because exactly one of its rows is ever special. In UpdateTug any of four rows becomes the busy one, so the equivalent is paying the tall height on all four, permanently, with three of them carrying a blank line at any moment. **(verified)**

**[F05] How much the row grows is not established** — the mechanism above is certain; the magnitude is not. Arithmetic from the stylesheets alone (headline 19.6px, two 2px column gaps, a 18.85px detail line, and a body slot at its `min-height: calc(13px * 1.45)`) predicts a row of about 61px against a 60px floor, which is a smaller jump than the screenshots show. So something in the bar's laid-out box is taller than `size={6}` suggests, or the reading of the screenshots is wrong. Either way the number belongs to a measurement in the running app rather than to this document, and [B07] is where it gets taken. **(not verified — `getBoundingClientRect().height` on each row at each stage would settle it)**

**[F06] Every row already carries a progress indicator that answers "working"** — `tugStepRowDotVisual` maps `busy` to `{role: "agent", state: "running"}`, and the row's comment records that `active` deliberately does not breathe and only `busy` does. So on `checking` and `installing` the barber-pole bar is the second element in the row saying the same thing, and it is the one that costs a line. **(verified)**

**[F07] The house already states this principle, for another surface** — `tuglaws/entity-presentation.md` on the transcript's verdict mark: "**It costs no layout metric.** A verdict lands *after* the ink is painted. `text-decoration` never reflows, so a late answer can add the signal to a streaming transcript without moving anything. A border, a padding, or a font change here would not have that property, and none may be added." A progress indicator is the same kind of thing — a late signal about work in flight — and the rule was written for exactly this hazard. **(verified)**

**[F08] The download row's body carries prose as well as a control** — on `downloading`, `body` holds `<TransferBar />` and `<StopCostLine />`, the latter painting "Stopping discards 4.2 MB — the download starts over." from a store subscription. That sentence is prose rather than a control, so moving the bar out of the column does not by itself give the download row back its two-line shape. **(verified)**

---

## Decisions {#decisions}

**[B01] A progress indicator costs no layout metric.** This generalises [F07] from the transcript's verdict mark to any late signal about work in flight: a thing that appears because work started may not move anything that was already on screen. It rules out every design in which the indicator is a member of the content column, and it is the standard the rest of these decisions are measured against. Revisiting it would mean deciding that a wizard's geometry is allowed to move under the reader, which is the complaint that opened this brief.

**[B02] `TugStepRow` gains an `edge` slot, and `body` keeps the meaning it has today.** The new slot renders a strip along the bottom of the plinth — `position: absolute; inset-inline: 0; bottom: 0` on a now-`position: relative` row — so it is chrome on the plinth rather than content in the column, and cannot be misused into a height. `body` stays a stacking slot, because ConfigureTug's file chooser legitimately uses it as one and answers for the height it costs ([F04]). Naming the slot for what it is, rather than repairing `body` to match its comment, is what keeps the two cases from having to share one word.

**[B03] The strip carries its own bottom radii rather than being clipped by the plinth.** `overflow: hidden` on the row would clip the strip to `--tugx-block-chrome-radius` for free, but it would also clip any CTA focus ring drawn with a positive `outline-offset`. Since enforcement is coming from a test rather than from clipping ([B06]), the plinth has no other reason to hide its overflow, and matching the radii on the strip costs one rule and risks nothing.

**[B04] Both bars move to the edge: determinate where there is a fraction, a barber pole where there is not.** `TransferBar` keeps its painted `--tugx-progress-indicator-value` write and serves `downloading` and `extracting`; `IndeterminateBar` serves `checking` and `installing`. Neither is deleted. At the edge an indeterminate strip costs nothing, so the redundancy [F06] names is no longer a reason to remove one — it is only a reason it could be removed later, which [Open Questions] carries.

**[B05] The stop-cost warning folds into the download row's painted detail line.** `StopCostLine` goes away as an element and its warning joins `ProgressDetail`'s sentence — "4.2 MB of 18 MB · 1.1 MB/s · 12s left — stopping discards it" — shedding the ETA first when the 560px panel needs room, which is the same "grows as the facts arrive" logic `transferDetailLine` already has. This keeps the row at two lines like every other row and keeps a consequential warning visible, rather than pinning the row taller for a sentence that shows in one stage. `data-progress` and `data-rate` stay on the span, because `at0612` reads them.

**[B06] The height stays `min-height`, and an app-test enforces the invariant.** Making it a hard `height` with `overflow: hidden` would turn a future violation into a visible clip, but it would also clip legitimately in the case nobody predicted, and it buys nothing the test does not. A static lint refusing `detail` and `body` on one row is the wrong shape for a different reason: it would be false on ConfigureTug's project-dir row, which has both and answers for it.

**[B07] The check drives the wizard through every stage and measures every row against the idle panel.** Over the bridge, with the machinery `at0612` already has: seed each stage's snapshot, measure all four rows, and assert each row's height equals its height on the opened panel. That catches the class rather than the instance — a future detail line that wraps to two lines at some width trips it, and no static check could see that. It is also where [F05]'s unmeasured number finally gets taken.

**[B08] The row's two stale comments are rewritten to describe what the file does.** [F02] is half the reason this went unnoticed for as long as it did: a reader checking whether the row hops finds a stylesheet promising it does not. The comments become an account of the `edge` slot and of `min-height` being a floor that a test defends.

---

## Open Questions {#open-questions}

- Whether the indeterminate edge strip earns its place beside the breathing dot ([F06]). At the edge it is free, so this is a question about the look rather than about layout, and it is settled by watching a real check and a real install rather than by argument. If it loses, deleting `IndeterminateBar` is a deletion and the dot carries the signal alone.

---

## Non-goals {#non-goals}

- **Pinning all four rows to the tall height.** ConfigureTug's move applied to a wizard where any row can be the busy one ([F04]): the panel grows permanently and three rows carry a blank line at all times. Rejected — it spends layout on nothing and breaks again the first time a detail line wants two lines.
- **The bar replacing the detail line.** What `.tug-step-row-body`'s comment already claims happens ([F02]). Rejected: "Looking for a newer version…" is more informative than the bar, and losing it to make room for the bar is a regression wearing a fix's clothes.
- **Hiding the stop-cost behind a hover or a tooltip.** It costs no height, but a user who presses *Stop for Now* without hovering never learns that the download starts over. Rejected by [B05].
- **`height` plus `overflow: hidden` as the enforcement.** Rejected by [B06]; the clipping risk is real and the test covers more.
- **A lint refusing `detail` and `body` together.** Rejected by [B06] — false on the one legitimate case in the tree.
- **Touching ConfigureTug's project-dir row.** It already keeps the invariant, by a mechanism that is correct for its situation. Nothing here changes it.

---

## Exit {#exit}

An arc. The first steps, in the order they must land:

1. The `edge` slot on `TugStepRow` and its stylesheet — the strip's position, its own bottom radii, and the two rewritten comments.
2. `deriveUpdateRows` moving both bars from `body` to `edge`, and folding the stop-cost sentence into `ProgressDetail`'s painted line.
3. The app-test that walks every stage and pins each row's height to its height on the opened panel.
4. A live look at the strip's weight and at the indeterminate case, settling the open question above.
