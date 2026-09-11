# Session Minimize, second pass — a fold that only moves in a wall, a control that moves to Z2, and a masthead that stopped answering

**Purpose:** The arc that landed `148f8a5ca` from `briefs/session-minimize-brief.md` built the minimized form but not the transition the brief required: on the shapes a user actually minimizes in, the card cuts. The user also wants the control moved out of the prompt entry into Z2 with the Show Transcript bar removed, and reports that the masthead's right-click menu is gone.

---

## Purpose {#purpose}

The user's notes on the landed work, verbatim:

> I *explicitly asked* for an excellent animation, and got none at all. The transition into and out of minimized mode *sucks*. Horridly jarring. Non-starter. This must *animate smoothly*. The prompt-entry area must appear *from the moment* un-minimize completes, not some time later.

> I think we should probably move the minimize control from Z4A into Z2 and remove the "Show Transcript" bar completely. The control should just live at the left of Z2 whether minimized or not.

> There is a *huge regression* on the session card masthead. We lost the right-click menu.

The first is a defect against [B06] of the parent brief. The second is a design change that supersedes [B03] and [B04] there. The third is a regression report with a screenshot: an open Session card, a right-click on the description line, and the app's "No Actions" fallback where the session's copies should be.

The parent brief is cited below as *the parent*; its labels are cited as `parent [B06]`. The landed decision record is [D185].

---

## Evidence {#evidence}

**[F01] The fold is carried by the imposer's settle, and the settle never arms for a minimize outside a split column.** The card's interior folds on `--tugx-imposer-settle-duration`, on the argument ([D185]) that the pane frame's height is a real geometry tween the settle runs. But the settle arms only when `arrangementSignature` changes (`components/chrome/deck-canvas.tsx`), and that signature is built from each pane's id, slot and **width**, the rails, the flow offset, bullseye, and the **split** columns' allocation. A pane's minimized flag, its pinned height, and a stacked slot's height are not terms. A minimize on a free pane or on a one-up stacked slot changes nothing the signature reads, so no settle launches and nothing tweens the frame. **(verified, read from the code)**

**[F02] Free pane, measured: the frame finishes in about 110ms, the interior in 412ms, and Z2 lands before either.** Sampled every frame on an 820×620 free pane. Minimize: the frame goes 620 → 533 → 319 → 243 → 201 → 181 → 173 between 16ms and 111ms; the composer's grid track goes 214 → 0 between 27ms and 412ms; the Z2 row's top reaches its final position at 45ms and the bar is present from 16ms. The frame's short ease is the pre-existing window-shade rule in `styles/chrome.css` (`.tug-pane { transition: height var(--tug-motion-duration-fast) }`, [D07], 100ms), not the settle. What the eye gets is a 100ms snap with a 400ms collapse happening inside it under `overflow: hidden`. Show: the frame is back at 620 by 108ms; the transcript slot flips from `display: none` to `flex` at 11ms; the composer's track grows 0 → 214 until 424ms, and the Z2 row rides down from 533 to 392 for the 300ms after the frame has stopped. That is the "prompt entry appears some time later" the user saw. **(verified, measured in the running app)**

**[F03] Stacked slot, measured: the frame is a cut in both directions.** Same card in a one-up imposition, slot 0, alone in its column. Minimize: the frame goes 1041 → 173 in one frame (21ms); the Z2 row is measured at −66px, above the frame's top edge, and walks down into view over the next 250ms as the composer folds. Show: the frame is 1041 at 16ms; the composer grows over 400ms; Z2 walks from 992 to 778 behind it. The imposer writes an imposed frame's height as geometry with no transition, so here not even the 100ms shade ease applies. This is the shape a deck with an imposition puts every card in, and it is the likeliest shape the user tested. **(verified, measured)**

**[F04] Split wall, measured: the motion the arc described exists, here and only here.** Three cards in a split column, the middle one folded: its frame goes 685 → 173 over 36–433ms, the composer's track 214 → 0 over the same window, and the neighbour below travels 873 → 361 in step. Show is the mirror. This is exactly what at0555 gates, and at0555 seeds a split wall. The arc's own test could not see [F02] or [F03] because it never measured the other two shapes. **(verified, measured; matches `tests/app-test/at0555-session-minimize-motion.test.ts`)**

**[F05] On show, the transcript is revealed at the flag's flip and the composer at the fold's end.** The view slot's `display: none` is keyed on `data-fold="settled"`, and the card rewrites that attribute to `"moving"` on the first frame of a show; the entry region's track then interpolates for the full settle window. So the two folded regions come back on two different clocks: the transcript at once, the composer 400ms later. The frame, meanwhile, is done by 110ms on a free pane and by 16ms in a slot. **(verified, read from `cards/session-card.css` and the census)**

**[F06] Z2 has about 8px of slack at the slim width.** `tug-status-cell.css` sizes the five cells so that cells, gaps and inline padding come to ~649px inside a ~657px content box at slim (675), on purpose: the surplus becomes the endcap wings, and the first `@container` rung that hides TIME fires at 645px. A control placed in the row's flow at its leading edge is ~24px plus a gap, three times the slack; unless the cell budgets give it back, TIME collapses on every slim card the moment the control mounts. **(verified, read from the stylesheet)**

**[F07] Nothing flanks the Z2 cells today, and the row refuses focus.** [D97]'s Z2 entry records that the sash grip and the maximize toggle that once flanked the row are gone. The row is centred by `justify-content: center` with equal flexing margins; the strip carries `data-tug-focus="refuse"` so a click on a cell or a gap never pulls focus off the editor; the cells are cycle stops at orders 12 onward inside their own `CycleScope`. A button at the row's leading edge is a control inside a surface whose contract is to refuse focus, and it has to be a real stop without changing that contract for the cells. **(verified, read from `cards/session-card.tsx`)**

**[F08] The masthead's right-click menu is gone on the user's live Session cards.** A right-click on the description line of an open card gets the app's "No Actions" fallback where the session's copies were. That is the fact this brief works from; the user has it on screen and has said so. What the harness shows is only where the gap in coverage is: `at0387-session-identity-menu.test.ts` is green on current `main`, and a scratch probe that right-clicked the description, the title and the activity line on a seeded card — free pane and imposed slot, open, minimized, shown again — was answered by the row's menu every time. So the seeded card the tests build is not the card the user has, and the loss lives in what differs: a live session driven by tugcode, an arc binding on the title (the screenshot's card is titled by its arc), a markdown beat, and whatever gesture the user right-clicks with. The handler path itself — `identityMenu` on the masthead's `SessionIdentityRow`, `onContextMenuCapture` claiming the press, the fallback in `responder-chain-provider.tsx` firing only when nothing called `preventDefault` — is byte-identical before and after `148f8a5ca`, so the cause is upstream of the handler, not in it. One known mechanism produces exactly this symptom: the title bar's drag takes pointer capture on a primary-button press, and a **ctrl-click** is `button === 0`, so the `contextmenu` it raises is retargeted to the pane and no handler in the bar sees it. **(the loss is the user's report and is taken as verified; the cause is not yet established, and the harness's green is evidence about the harness)**

**[F09] An unbound Session card that is minimized is a blank box at a full share.** In the wall census the third card, minimized but never bound, drew a bare title bar over an empty body about 210px tall: the minimized form is the masthead, Z2 and the bar, and all three exist only for a bound session. **(verified, screenshot from the census run)**

**[F10] The tier without the bar is about 144px, which fits six at a 900px canvas.** at0551 reads the built tier as 88 (masthead) + the Z2 row + a 29px bar = 173. Dropping the bar takes the tier to ~144; with the imposition's 5px gap that is 6 per 900px against the parent's 5, and against the stated goal of 8–10. **(arithmetic on verified numbers)**

**[F11] TASKS and JOBS sit a few pixels higher than STATE, TIME and CONTEXT.** Visible on the user's screenshot: the two work cells' label rules and endcaps are a smidge above the other three. The two shapes are different constructions (`tug-status-cell.css`): STATE, TIME and CONTEXT put a `.session-telemetry-status-value` span inside the value wrap, while TASKS and JOBS put one `.tug-progress-indicator` there, stretched to the cell, carrying its two glyphs and its count inside itself. The row centres its cells vertically, so a value row whose box is a different height from the span's line box moves the label rule above it by half the difference. **(the offset is verified on the screenshot; the cause is inferred from the two constructions and is confirmed by measuring the two value rows' heights)**

**[F12] The row's arithmetic, in pixels.** The cells are budgeted in `ch` at the row's 10px sans type; the stylesheet's own total — five cells at 80ch, four gaps of 24px and 16px of row padding coming to ~649px — puts 1ch at about 6.7px. So the budgets are STATE 18ch ≈ 121px, TIME 15ch ≈ 101px, CONTEXT 19ch ≈ 128px, TASKS 14ch ≈ 94px, JOBS 14ch ≈ 94px; the row's own inset is 8px a side inside the strip's 8px a side. A `sm` icon button is 24px; with an 8px gap to STATE it needs 32px. **(verified, read from the stylesheet; the per-cell pixels are derived)**

---

## Decisions {#decisions}

**[B01] The fold is one motion on every shape the card can stand in — free, stacked slot, split — and the frame is part of it.** The parent's [B06] asked for a motion with a shape and a fixed beat; what landed is that motion in one of three shapes and a cut in the other two ([F02], [F03], [F04]). The frame's height has to travel on the same clock as the interior wherever the card is. Concretely: a minimize must arm the settle — the pane's minimized state (or its pinned height) becomes a term of `arrangementSignature`, so the same tween that carries a split member carries a free pane and a stacked slot — and the [D07] window-shade ease on `.tug-pane` must not run underneath it at a different duration. The acceptance is the census, not a screenshot: on each of the three shapes, the frame, the Z2 row, and the composer's track start together and end together, within the settle's window.

**[B02] The composer is on screen the instant the unfold ends, and nothing walks after the frame stops.** The user's requirement, made measurable: at the frame's last moving sample, the entry region is at its rest height and the Z2 row is at its rest position. That rules out the current show, where the frame is done at 108ms and the composer arrives at 424ms ([F02]). It also rules out the transcript popping in at the flag's flip while the composer folds up under it ([F05]): the two folded regions come back on one clock. How the interior is made to track the frame — the track's transition retimed to the frame's tween, or the frame driving the interior's height directly — is the arc's to work out; the numbers above are what it is judged by.

**[B03] The minimize control lives at the leading edge of Z2, in both states, and the Show Transcript bar is removed.** The user's decision, superseding the parent's [B03] and [B04]. One control, one seat, two glyphs: it minimizes an open card and shows a minimized one. The Z4-lead seat in the prompt entry retires with the bar; [D97]'s diagram and [D185] are corrected when the Z2 seat is real. The way back is no longer a bar under Z2 but the same control the reader used to get there, which is what "whether minimized or not" means.

**[B04] The minimized form becomes the masthead and Z2, nothing under.** A consequence of [B03] worth stating: the tier drops from 173 to about 144 ([F10]). The masthead's two-line beat, the wall register ([D185]), and the fixed tier are unchanged. The size policy's pinned height follows the new tier and is read back off the built card, as before.

**[B05] The control's width is paid for by the cells' endcap wings, not by TIME.** At slim the row has 8px to spare and the control needs about 32 ([F06]). The stylesheet already says the surplus over the cells' need *is* the wings, so the wings are where the width comes from: the five budgets are re-measured so that five cells, the control and its gap fill the slim row, and the three `@container` rungs are re-measured against the new totals. Letting TIME collapse at slim, or leaving the control to overlap STATE's wing, are both rejected: the slim preset is the width Z2 was sized to show everything at, and that promise stands.

**[B06] The Z2 control is a real focus stop and the minimized card's Return-home.** The bar carried `persistentDefaultRing` so Return on a focused minimized card showed the transcript ([D185]); that role moves to the control. The strip's `data-tug-focus="refuse"` stays on the cells and gaps ([F07]) and the control is authored outside that refusal, in the card's cycle at the order the bar held. Minimized, it is the one stop that is not a cell; open, it is the stop before the cells.

**[B07] The masthead regression is fixed first, on the user's own card, and nothing above is built until it is.** A regression the user has on screen outranks a feature change, and a passing app-test is not a counter-argument to it. The arc's first step is to stand in front of the user's real deck — the live, arc-bound card in the screenshot — and find why the press never reaches the row: instrument the `contextmenu` path in a debug build, check the ctrl-click capture mechanism ([F08]) and the three differences the seeded card lacks, and fix what is found. The reproduction that comes out of that becomes an app-test beside at0387, so the harness covers the card the user has rather than the card it can seed. The arc does not close this item on the strength of a green run.

**[B08] The motion test gates all three shapes.** at0555 measures a split wall and passed while two of three shapes cut ([F04]). It is extended — or joined by a sibling — so that a free pane and a stacked slot are censused by the same sampler with the same claims. A fold that lands green while cutting on the shape the user is looking at is the failure this brief exists to prevent.

**[B09] Where the 32px comes from: two characters off CONTEXT, two off JOBS, and half the row's inset.** The user's direction, made arithmetic against [F12]:

| Term | Today | Proposed | Gives back |
|---|---|---|---|
| CONTEXT | 19ch ≈ 128px | 17ch ≈ 114px | ~13px |
| JOBS | 14ch ≈ 94px | 12ch ≈ 80px | ~13px |
| Row inset, each side | 8px | 4px | 8px |
| **Total** | | | **~34px** |

That clears the 32px with two to spare and leaves the strip's own 8px, which is what keeps the outermost wing off the card edge, untouched. CONTEXT's widest face today is a numerator like `236.2K` with `/ 1M` beside it at 12px bold, about 80px; 17ch ≈ 114px still leaves it wings. JOBS's widest face is `None` between two 12px dots with their channels, about 70px; 12ch ≈ 80px still clears it. Two consequences the arc measures rather than assumes: the pair rule that TASKS and JOBS are equal ([F06]'s stylesheet says the eye reads a width difference between neighbours as a claim of importance) is broken by two characters, and if that shows, the equal-pair form is one character off each rather than two off JOBS; and the ARC reading, where TASKS widens to 18ch and JOBS gives back to 10ch so the row's total holds, has to be re-budgeted from the new total — `Implement` between two dots needs about 16ch, which would put JOBS at 8ch, below what `None` between dots needs, so the ARC face gets what it measures and JOBS keeps its floor. The three `@container` rungs are re-measured against the new totals with the control in the row, as [B05] says.

**[B10] The five cells share one value-row height.** The fix for [F11] is not a nudge on TASKS and JOBS: the value wrap in every cell is given one declared height that both constructions fill, so the label rules line up by construction and stay lined up when a face changes. A `translateY` on the two work cells would hold until the next face change and then be wrong again.

---

## Open Questions {#open-questions}

- **The count goal, again.** Six at 900px with the bar gone ([F10]); the parent's open question stood at five. Eight needs a tier near 108, and the floor is now the 88px masthead plus Z2. Whether the goal is revised or the tier is, and how — a one-line Z2, a shorter masthead when minimized — is still the user's call and still not answered by this pass.

- **The Z2 control on an unbound card.** Z2 exists only for a bound session, so an unbound card has no seat for the control and no minimized form ([F09]). Whether an unbound card minimizes at all — today it does, to a blank box — and what it shows if it does, is undecided.

- **The frame's tween and the interior's, mechanically.** [B01] and [B02] say what is observed, not how. Two routes are plausible: make minimize a settle term and let the interior's existing transition ride the settle's window, or let the card drive its own frame height and drop the interior's separate clock. The choice affects `deck-canvas.tsx`, whose test fan-out is at its recorded ceiling, and is the arc's to make with the census in hand.

---

## Non-goals {#non-goals}

- **Keeping the Show Transcript bar as a second way back.** [B03] removes it; two doors of the same kind on one card is what the user is taking away.
- **Keeping the Z4-lead seat for anything else.** It was created for this control ([D97] as corrected by `148f8a5ca`); with the control gone it is an empty seat and is retired, not repurposed.
- **A cross-fade or a staged fold.** [D185]'s argument that the interior must follow the frame's real geometry holds; what failed is that the frame did not move, not that the interior tracked it.
- **Changing the beat's wall register or the two-line masthead.** Landed, tested, and not in the user's notes.
- **Letting TIME collapse at slim to make room for the control.** Rejected by [B05].
- **Treating the masthead menu as unconfirmed because the harness cannot see it.** [B07]: the user's report is the fact; the harness's job is to catch up to it.

---

## Exit {#exit}

**An arc**, on this brief.

The order the steps must land in: the masthead menu, found and fixed on the user's own card and then covered by a test beside at0387 ([B07]); then the fold, made one motion on all three shapes with the frame in it and the composer landing with the frame, gated by a census that samples all three ([B01], [B02], [B08]); then Z2 — the value rows brought to one height ([B10]), the budgets cut to [B09]'s table and the rungs re-measured, the control seated at the leading edge with the bar removed, the focus role moved, and the tier re-read ([B03]–[B06], [B09]); and last the doctrine — [D97]'s diagram loses the Z4-lead seat and gains the Z2 seat, and [D185] is amended to say where the fold actually runs and where the control actually is.
