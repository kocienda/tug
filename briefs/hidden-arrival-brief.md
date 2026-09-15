# The Session card arrives hidden in place, and reveals when its content has stopped moving

**Purpose:** Adding a Session card to a split column still plays three motions instead of two. The card's height is measured once, off-screen, and the picker it stands on keeps changing for seconds after that measure. The card must be drawn where it will stand, hidden with `visibility: hidden`, watched until its content is quiet, and only then revealed in one settle.

---

## Purpose {#purpose}

The user, after two arcs on this defect (`ebcb64175`, `ac19979dc`):

> This *still STILL* does a double hop (and more, if I'm honest). WHY? … We *must* find a way to skip that middle step.

> Nope. Wrong. Still doesn't work. Still gives three moves. … The *second time* I try to add a new card, it does the reveal in only two moves. This tells me the general approach is still wrong.

> There's a data source, right? WHAT IS IT? WHAT DATA IS IN IT? We need to determine that by API, and then write code that can properly measure that content for display.

And the shape they then asked for:

> Is there some way we can actually draw this session card with some CSS display or opacity property that allows the drawing to happen, but hides the content from the user? That way, we can actually have the layout happen, get the measure exactly from actual rendering, and then animate the card in?

The three screenshots that opened this: a slot with one card; the new Session card arriving partway; the column re-dividing under it a beat later.

---

## Evidence {#evidence}

**[F01] The picker's data source is one CONTROL request answered in two frames that do not carry the same data.** `SessionLedgerStore` (`tugdeck/src/lib/session-ledger-store.ts`) answers `list_sessions(project_dir)` as a `WorkspaceSnapshot { status, rows, dirExists?, scanning?, scanProgress? }`. On the host, `do_list_sessions` in `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs` emits phase one from the SQLite ledger with `build_listed_union(rows, &live, None)` (line 5890) and `scanning: true`, then phase two after an off-loop JSONL scan of `~/.claude/projects/<encoded cwd>/` with `build_listed_union(rows, &live, Some(scan))` (line 5954) and `scanning: false`. Phase-one rows carry no `file_size` and no `origin: "external"` sessions; phase two adds both. On the `tug` project the scan takes seconds cold and is near-instant warm, because the scanner caches by file. **(verified by reading both files)**

**[F02] Each `SessionRow` carries these fields, and the row draws three of the late ones.** `tugdeck/src/protocol.ts` line 125: `session_id, line_id, workspace_key, project_dir, created_at, last_used_at, turn_count, last_user_prompt, state, card_id, background, name, name_user_set, tag, synopsis, origin, terminal_live, file_size?, private?`. The rendered row is a title (`name`, else the callsign `tag`), a description (the synopsis, which arrives on its own schedule through the synopsis store keyed by `line_id`), and a rest sentence built from `turn_count`, `file_size`, and `last_used_at` (`session-identity-row.tsx`, "turns, size, when it last moved"). So a row's height can change when phase two lands or when a synopsis arrives, and the list's row count changes when phase two adds external sessions. **(field list and row construction verified; which of the three moved the card in the user's screenshots was not measured)**

**[F03] The list is capped, so the panel has a knowable maximum.** `.session-card-picker-list-view` is `max-height: 14.5rem` (232px) at `session-card.css` line 1216, with a row floor of 3.5rem. Once the list holds enough rows to fill the cap, no later frame can change the list's height; only a short list has a height phase two can move. `.session-card-picker-label` already reserves the scan indicator's height (line 1093) so the progress bar cannot shift the interface. **(verified)**

**[F04] The current measure is a one-shot render that is thrown away.** `DeckManager.addCard` (`tugdeck/src/deck-manager.ts` lines 2004–2150) builds an `OpeningForm`, awaits `openingForm.ready()`, then inside `land()` calls `measureOpeningForm` — a second React root under `MeasuringRenderProvider` and `TugTooltipProvider`, rendered at `paneRenderWidthOf(...)`, read once, and left for the next measure to reuse. The number becomes the opening bid in the same commit that appends the pane. Nothing observes that tree afterwards. **(verified)**

**[F05] `ready()` resolves at the wrong frame.** `ensureListed` in `session-ledger-store.ts` (line 262, bound 2s) holds through a phase-one frame with zero rows but resolves on a phase-one frame that carries rows. Phase two can then add rows and `file_size` seconds later. That is consistent with the first-versus-second asymmetry the user reports: warm, the two phases collapse into one and there are two motions; cold, the measure is taken over phase one and phase two moves the card. **(inference from [F01] and the store's code; the trace in the user's app would confirm which frame fired)**

**[F06] Every pane frame is already out of flow.** The imposer places members by absolute rects: `DeckCanvas` renders each `.tug-pane[data-pane-id]` with `position: absolute` from `frameStyle`. A column's members do not lay out against each other; they stand where the division puts them. So "mount the card without moving its neighbours" is not a new positioning mode. It is a pane the division has not yet allotted a share to. **(verified by reading `deck-canvas.tsx` around line 1128 and `layout-imposer`)**

**[F07] The sheet already reports its natural height through a `ResizeObserver`.** `tug-sheet.tsx` line 1470 observes the panel and calls `sheetPanelNaturalHeight(content)` (`scrollHeight` plus borders and margins); the report flows into `sheet-reservation.ts` as the member's floor. That observer is live for the whole time the sheet is up. It stops reporting only when the window is fully occluded, which is a harness condition, not a product one. **(verified)**

**[F08] `visibility: hidden` lays out; `display: none` does not.** A hidden element has a box, participates in layout, gets fonts and line breaks, and reports through `ResizeObserver` and `scrollHeight`, while taking no hit-testing, no focus, and no place in the accessibility tree. `opacity: 0` lays out too but leaves the element focusable and clickable. **(platform fact)**

**[F09] The previous approach's tests were blind.** The occluded harness window suspends `requestAnimationFrame` and `ResizeObserver`, so no test in the last two arcs could see a second height report or the re-division that followed. The user has ruled: no app-tests for this feature, ever. **(verified; see the `apptest-occlusion-stalls-raf` note)**

---

## Decisions {#decisions}

**[B01] The card is drawn in its own pane, in the column, hidden, before the column is re-divided.** `addCard` commits the pane with an *arriving* mark instead of rendering a throwaway copy. The imposer gives an arriving pane the column's width and a provisional height but leaves the standing members' shares exactly as they are, so nothing the user sees moves. The frame carries `visibility: hidden` for as long as the mark stands. This retires the measuring root, `MeasuringRenderProvider`'s use in `addCard`, and the measure-then-commit ordering of `height-before-commit-brief.md` [B01]: the measure is no longer a number read before the commit, it is the live card's own report while it is hidden.

**[B02] `visibility: hidden` is the hiding property, not `opacity: 0` and not `display: none`.** The user chose it and [F08] is why: layout and the height report happen, and the hidden card cannot take focus, clicks, or the accessibility cursor. The settle's own `opacity` hold stays what it is for the arrive beat; the two properties do different jobs and neither replaces the other.

**[B03] The reveal waits for the content to be quiet, and quiet is defined by the data, not by a timer alone.** The card reveals at the first of: the listing's settled frame (`scanning: false`) for the seed path; phase-one rows already numerous enough to fill the list cap ([F03]), since no later frame can then change the list's height; or a bound, so a stalled scan cannot hold the card hostage. The synopsis store is consulted the same way: the rows on screen either have their synopses or the bound expires. The bound is a product number chosen by looking at the `tug` project cold, not the 2s `ensureListed` carries today. `ensureListed` and `OpeningForm.ready` go away; the card's own render is the wait.

**[B04] The reveal is one commit that clears the arriving mark and writes the opening bid from the last hidden report.** That commit is the one the settle arms on: `room` for the neighbours plus `arrive` for the card, fused as today. The height it uses is the sheet's most recent `ResizeObserver` report while hidden ([F07]), through `memberFloorForSheetPanel`. Reports that land after the reveal are ordinary sheet reservations and behave as they do on any live card.

**[B05] The user sees nothing during the wait, and the wait is short.** The user's ruling. No cue, no placeholder, no motion of any member while the card is hidden: the column looks exactly as it did before the click. And the wait must not be long: the bound in [B03] is short, on the order of a few frames to a few hundred milliseconds, not the seconds a cold scan takes. When the bound expires the card reveals over what it has, and any later frame that changes the picker's height is an ordinary sheet reservation. On the `tug` project the cap rule of [F03] means phase one already fixes the list's height and the reveal does not wait on the scan at all; the bound is what protects a project with a short list from a long wait, at the price of a possible late adjustment there.

**[B06] No app-tests for this feature.** The user's instruction. Verification is by eye on the `tug` project, cold and warm, and by the deck trace the app already exposes. Pure unit tests on functions with no DOM are permitted where a function is pure enough to have one.

**[B07] The picker component is not forked for arrival.** The hidden card is the real card with the real picker reading the real stores. `useIsMeasuringRender` gating in `session-picker-form.tsx` becomes unnecessary once no second root exists and should be removed with the root, so the component has one render path again.

**[B08] An arriving pane is excluded from its column's division and drawn at the seat it will take.** The mark is a session-only `DeckState` field keyed by pane id, shaped like `openingBids` and never serialized. `placeMembers` and the column's share division are handed the standing members only, so their rects do not change; the canvas gives the arriving frame the column's width and, for height, the seat it will take once revealed, computed from its stack policy floor, overlapping the neighbour that will shrink. The overlap is invisible because the frame is hidden ([B02]). The seat is the truer height for the sheet's clamp ([F07]) and costs nothing a zero-height frame would save. The reveal commit ([B04]) removes the mark and writes the bid, and from that commit the pane is an ordinary member.

---

## Open Questions {#open-questions}

- None that change what gets written. The arriving pane's rect is settled by [B08]; the bound's value is settled by looking at the built app under [B05].

---

## Non-goals {#non-goals}

- **Measuring in a second React root.** That is the approach of the last two arcs. It measures one instant of a moving target and cannot be told when the target stops. It is replaced, not repaired.
- **Computing the picker's height from the row data instead of rendering.** Row height depends on wrapping, fonts, and synopsis length. The data can shortcut the *wait* ([F03], [B03]); it cannot substitute for the layout.
- **Revealing on phase one and letting phase two re-divide.** That is the third motion.
- **Pinning the card at the cap height.** `picker-height-list-cap-brief.md` [B01] chose a constant; it leaves air under a short list and was superseded by the measured opening bid. This brief keeps the measure and fixes when it is taken.
- **Removing the two-phase listing or the scan cache.** The host's shape is right: rows fast, then the union. The card must cope with it, not flatten it.
- **App-tests for this feature.** Ruled out by the user ([B06]).
- **Changing the settle's beat order, fusing, or `pendingArrivalsRef`.** The arrival machinery landed in `ac19979dc` stays; what changes is the commit it arms on.

---

## Exit {#exit}

An arc.

The order that matters. First, the deck state gains the *arriving* mark and the imposer learns to give an arriving pane a width and a rect without touching the standing members' shares ([B01], [B08]). Second, `DeckCanvas` renders an arriving frame with `visibility: hidden` and the settle's arm skips it, as it already skips a pending arrival. Third, `addCard` commits the pane at once with the mark, drops the measuring root and `ready()`, and subscribes to the sheet's reservation for that member plus the ledger and synopsis stores for the seed path, applying the quiet rule of [B03]. Fourth, the reveal commit ([B04]). Fifth, choose the bound by looking at the built app cold and warm ([B05]). Then delete `measureOpeningForm`, `MeasuringRenderProvider`'s use in the deck, `ensureListed`, and the `useIsMeasuringRender` gates ([B07]). Then look: a split column, a new Session card, cold and warm, and count the motions.
