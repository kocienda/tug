<!-- brief-skeleton v1 -->

# Tripwires phase 5: the card, rolled out from the spike

**Purpose:** Phase 5 of `briefs/tripwires-multi-phase-brief.md`. The parent's [B09] said the card adopts the Arcs card's conventions wholesale and every dead thing goes live or goes. Rather than argue the shape in prose, it was drawn: `tugdeck/src/spikes/spike-tripwires-card.tsx` is three rounds of the user's feedback settled into a card over fixture data. This brief records what the spike found and decided, so the shipping card at `tugdeck/src/components/tripwires/` can be rebuilt to it, and the spike deleted.

---

## Purpose {#purpose}

The parent's Phase 5 reads:

> **Covers:** The full pass [B09]. Conventions from the arcs card, collapsed band with live count, activation of rows and atoms, the model knob, the awaiting act and release [B05], probe output, the L06 fix, scoped errors. Grow `at0492` to cover pause through the UI, a populated log, keyboard activation, the three dot meanings, and the arc atoms [F14].
>
> **Done when:** the card passes the arcs card's conventions check by inspection, no control on it is dead, and the app-test covers every control and every state.

The user's framing at the start of the spike: "I need to see what we're going to get here, give feedback on your design proposals, and iterate with you until we arrive on an approach I like." Three rounds later the approach is liked, with these words from the rounds carried forward: on the shipped card's hover, "we can never bomb the user with this much text"; on the shipped log's type, "I'm not seeing any of the outsized text we have in the shipping version, which is also good — let's keep it this way"; on the log's growth, "we can't have an endless trip log"; and on the rows, "we're going to need some focus-caret/keyboard mode support."

Phases 1 through 4 have landed. The roster rides a feed (`34f4e4dd1`), so the store the card reads is already the right one; the deck already has `trip` and `dismiss` posts beside `setKnobs`. What this phase changes is the card, one shared component, one ledger policy, and the app-test.

---

## Evidence {#evidence}

**[F01] The spike is the design, and it composes shipping components throughout.** `spike-tripwires-card.tsx` and its stylesheet draw the whole card over five fixture tripwires chosen to show every row shape at once: awaiting with an arc, awaiting with none, running with a session, paused with a long log, armed and silent. Every piece is a `Tug*` component or a block-family component: `TugListView` with `RAIL_LIST_PRESENTATION`, `TugListRow` flush and compact, `BlockHeader` for the register band, `BlockFoldCue` for the fold, `TugEditorContextMenu` for the verbs, `TugPopupButton` for the model knob, `TugClamp` for the brief, `TugSessionIdentity` for the worker chip, `TugProgressIndicator` for the dots, `TugAtomRef` for the arc. Nothing is hand-rolled, so the layout transfers as-is. **(verified — the file; `tsc`, `vite build`, and `card-taxonomy.test.ts` green)**

**[F02] The shipped card's brief hover is a wall of text.** `tripwires-card.tsx` wraps the "Asks the AI to" row's gist in a `TugTooltip` carrying the whole brief, and a real brief is paragraphs; the user's screenshot shows the tooltip covering the entire rail. The spike shows the whole brief behind a two-line `TugClamp` with the clamp's own More and Less reveal, and opens no tooltip anywhere. **(verified — `tripwires-card.tsx` `TripwireDetail`, and the screenshot)**

**[F03] The shipped log sets its arc atom and headline larger than the rail's rows.** The user's screenshot shows a `TugAtomRef` arc pill and a headline both a step above the 12px rail measure. The spike keeps every line at the rail's one measure, and the user asked to keep it that way. **(verified — screenshot; the spike renders the arc as a `TugAtomRef` inside the trip's meta line at `2xs`)**

**[F04] The block header's `section` altitude reads a step larger than a rail row.** `block-strip.css` sets `--tugx-toolheader-name-size` to `--tug-font-size-sm` (13px) at every altitude, and `RAIL_LIST_PRESENTATION` sets the rail's rows to 12px, so a register band under a row read as a child larger than its parent. The spike's second round added a fourth altitude, `row`, to `BlockAltitude` in `block-strip.tsx` and its tier in `block-strip.css`: `xs` name and detail, a 1.6 line box, the section's sans detail face, and `2xs`/`sm` strip padding. That change is already in the working tree outside `spikes/`. **(verified — `block-strip.tsx`, `block-strip.css`)**

**[F05] The trip log has no retention and the reader's window is the only cap.** `trips_for_tripwire` in `tugtool-core/src/tripwire_ledger.rs` is documented as "the log is the record — no retention policy trims it, and `limit` is the reader's window"; the only `DELETE FROM trips` rows are the crashed-`claimed` sweeps. So a tripwire that fires on every landing grows its log without bound, and the card would page through it forever. **(verified — `tripwire_ledger.rs:1401`)**

**[F06] The engine already releases an awaiting trip when its arc goes.** `sweep_awaiting` in `tugcast/src/feeds/tripwire.rs:502` settles every awaiting trip whose arc no longer exists, runs on the tick and ahead of every landing's guards, and its docstring says why: "the thing the user does about one — join the arc or discard it — is itself the answer." `tugarc_core::tripwire_dismiss` settles the awaiting or adopted trip and discards its arc as one act, and `POST /api/tripwires/{name}/dismiss` exposes it; the store's `dismiss` already posts there. So the release [B05] asked for exists in two halves; what is missing is the card saying so. **(verified — `tripwire.rs`, `tripwire_dismiss.rs`, `tripwires_api.rs`, `tripwires-store.ts`)**

**[F07] The deck has no tripwire actions in its vocabulary.** `action-vocabulary.ts` carries `TOGGLE_TRIPWIRES` and nothing else for the feature. The spike's verbs dispatch `SET_VALUE` with a string payload as a stand-in, and its docstring says so. **(verified — grep of `action-vocabulary.ts`)**

**[F08] Rail rows walk by arrow only when the card says so.** The Arcs card registers with `kbfAtRest: true`, seeds its first row as the key view, and passes `selectionRequired`; the shipped Tripwires card seeds but does not register `kbfAtRest`, and its trip rows are stops with no delegate. The spike does all three and authors every row control — pause, cue, model, Seen, older — into the card's one focus group. **(verified — `arcs-card-registration.tsx`, `tripwires-card.tsx`, the spike)**

**[F09] What the spike leaves unbuilt, by design.** Nothing on it dispatches except the pause toggle, which mutates fixture state. The worker chip is a literal `SessionIdentity`; the shipping card reads `useSessionIdentity(running_session)`. The session dot on a running row is the spike's `TugProgressIndicator`, where the shipping row's `TripwireSessionDot` opens the session on a card, a gesture Phase 3 built. The collapsed band counts fixture rows. **(verified — the file)**

---

## Decisions {#decisions}

**[B01] The card is the spike, one for one.** Each tripwire is a two-line block: line one the name behind a `Radar` glyph, a hairline, the working session as a chip when one is running, then the pause control and the fold cue at the end; line two a fixed-width mark box, the lifecycle sentence, and the branch as a calm label at the row's size. A row with a trip in flight or a question outstanding carries a register band beneath, a `BlockHeader` at the `row` altitude. The collapsed band is the card's first line above the roster, with a hairline under it, carrying armed, running, awaiting and paused counts wearing the rows' own dots. The spike's `data-slot` names (`tripwire-row`, `tripwire-eyebrow`, `tripwire-line`, `tripwire-register`, `tripwire-fold`, `tripwire-trip`, `tripwire-rollup`, `tripwire-band`, `tripwire-definition`, `tripwire-probe-tail`, `tripwire-log-error`) and its `data-state` / `data-trip-state` attributes are the shipping card's, so `at0492` can be written against the spike before the card exists. The user settled the layout across three rounds; what would reopen it is a rail width the block cannot fit.

**[B02] The fold replaces the second level, and Enter opens it.** The shipped card pushes to a detail level with a back control; the spike folds the row open in place over the definition rows and the trip log, the Arcs card's own gesture, and the user chose it. Row activation toggles the fold. Opening the session a running trip is in stays on the session dot and on the context menu, never on activation, because a row with no session would then have a dead Enter. The `TripwireDetail` component, its head row, and `data-tripwires-level` go.

**[B03] An awaiting trip is released by its arc's fate when it authored one, and by a Seen act when it did not.** The band under an arc-bearing awaiting row reads "Holding until `<arc atom>` is joined or discarded" and carries no control: [F06] shows the engine already settles the trip when the arc goes, so the band states a rule that holds rather than offering a button that duplicates the Join sheet. An awaiting trip with no arc has nothing else to end its hold, so its band reads the headline and carries a Seen act at its trailing end, which dispatches the existing `dismiss`, a settle with nothing to discard. The context menu's Release item is the same verb under the keyboard's name. This closes the parent's open question under [B05]; the third candidate, supersession by a later landing, is not built (see Non-goals).

**[B04] The trip log is windowed, rolled up, and retained.** Three pieces, each one constant. The fold opens over the five most recent log rows and a "Show 25 older of N" cue pages in twenty-five at a time. Consecutive trips that never ran fold into one row, "Didn't run ×9 — busy ×7, no-match ×2", with the span they cover; consecutive trips that ran and found nothing fold the same way, "Finished with nothing to report ×8 — probe 0 ×8". The two kinds never fold into each other, and a trip with a headline, a failure, an outstanding question, or a session is never folded, because those are the rows the log exists for. And the ledger keeps the most recent five hundred trips per tripwire, pruned at record time, the regime `apptest_results.db` already runs, which reverses the "no retention policy" the ledger's own docstring states [F05] and is the piece that makes the older cue bottom out. The rows a trip's headline needs are the newest ones, so a five-hundred-row cap loses nothing a reader would page to.

**[B05] The brief is never a hover, and nothing on the card is.** The definition's "Asks the AI to" row shows the whole brief behind a two-line `TugClamp`; the More reveal is the door, and `briefGist` and the definition's `full` field go with the tooltip that consumed them. No other row on the card opens a tooltip, and the fold cue keeps only the short hover `BlockFoldCue` owns. The user's words: "we can never bomb the user with this much text."

**[B06] One measure for the whole card.** Every line reads at the rail's 12px: the sentence, the branch, the register band, the trip rows, the arc atom in a trip's meta line, the probe tail at 11px mono. The shipped log's outsized atom and headline [F03] are not carried over, and the app-test pins the trip row's atom at the meta line's size so they cannot return.

**[B07] The block header's `row` altitude is a shared component change and ships with this arc.** It is already in the working tree [F04] and is the correct fix under [L20]: the header owns its scale, and a card reaching into `--tugx-toolheader-*` from outside is how one surface's tuning becomes every surface's. The four altitudes are `leaf`, `entry`, `section`, `row`, and the spike's stylesheet no longer overrides anything of the header's.

**[B08] The card speaks the focus language as the Arcs card does.** It registers with `kbfAtRest: true`, seeds the first row as the key view, and passes `selectionRequired` so a cursor is always on a row. Every control on a row joins the card's one focus group so Tab reaches it in reading order: pause, fold cue, model popup, Seen, older. Trip rows in the fold are not stops; the arc atom and the session dot inside them are reachable through the row's context menu and by pointer, and a stop per log row would make the Tab walk scale with the log.

**[B09] Every verb is an action in the vocabulary and a store call.** Mint `PAUSE_TRIPWIRE`, `RESUME_TRIPWIRE`, `TRIP_TRIPWIRE`, `RELEASE_TRIPWIRE`, `OPEN_TRIPWIRE_SESSION`, and `SET_TRIPWIRE_MODEL` in `action-vocabulary.ts`, wired to `setKnobs`, `trip`, `dismiss`, and the Phase 3 adoption dispatch. The context menu carries Pause or Resume, Trip now, Open session, and Release, each disabled item wearing its reason in its label as the Arcs row menu does. The model knob is a `TugPopupButton` over the session default and the three model names, dispatching `SET_TRIPWIRE_MODEL` with the name as payload; `setKnobs` already accepts `model`. The spike's `SET_VALUE` stand-ins [F07] go.

**[B10] Marks paint from attributes, and errors are scoped.** A trip's mark wraps its glyph in a box carrying `data-state`, and colour is CSS on that attribute; the `TripMark` class computation and the `tripwires-glyph-*` classes go. A failed log fetch renders under the row whose log it is, as a danger label in the fold, never as a strip over the card; the store's single `error` field becomes per-tripwire for the log, with the roster-level error kept only for the feed itself.

**[B11] The spike graduates and is deleted.** The row block, the register band, the fold, the roll-up, the collapsed band, and the stylesheet move into `tugdeck/src/components/tripwires/`; the `row` altitude is already in place; `spike-tripwires-card.tsx`, its stylesheet, and its two registry lines are deleted in the same arc. A pane holding the spike in a saved layout drops on next launch with the `filterRegisteredCards` warning, which is expected.

---

## Open Questions {#open-questions}

- **Does the roll-up read its rows off the wire, or does the server fold them?** The spike folds client-side over the rows it has, which is enough for a five-hundred-row cap. If the API is expected to serve the log to the skill as well as the card [B08 in the parent], a server-side fold would give both the same rows; a client-side fold keeps the API honest and the card free to change the rule. Settled by whichever the arc finds cheaper to test; the brief leans client-side because the rule is presentation.

---

## Non-goals {#non-goals}

- **Supersession as a release.** A later landing on the same branch does not settle an awaiting trip. The arc's fate and the Seen act cover both cases [B03], and a landing that silently answers a question the user had not looked at is the failure the awaiting state exists to prevent.
- **Trip rows as focus stops.** Rejected under [B08]; the Tab walk must not grow with the log.
- **A hover anywhere on the card.** Rejected under [B05]. The clamp and the fold are the doors.
- **A lay form, a timeout knob, or showing trips in the Arcs card.** Unchanged from the parent's non-goals.
- **A separate rail-collapsed form for the band.** The user chose the card's first line; a folded-rail form would be new rail machinery for no reader yet.
- **Keeping the two-level navigation as an option.** The fold is the shape; a switch between them would be two cards.

---

## Exit {#exit}

**An arc.** Its first steps, in the order they have to land:

1. Add trip retention to `tripwire_ledger.rs`: the most recent five hundred per tripwire, pruned at record time, with the docstring at `trips_for_tripwire` rewritten and a test that records five hundred and one and reads five hundred [B04].
2. Mint the tripwire actions in `action-vocabulary.ts` and wire them to the store's existing posts, adding a per-tripwire log error to the snapshot [B09] [B10].
3. Rebuild `tripwires-card.tsx` and `tripwires-card.css` from the spike: the block, the band, the register, the fold with the clamp and the roll-up, the verbs, the marks on attributes, the focus group and registration [B01] [B02] [B03] [B05] [B06] [B08] [B10]. Delete `TripwireDetail`, `briefGist`, and the definition's `full` field.
4. Grow `at0492-tripwires-card.test.ts` to the parent's list: pause through the control, the fold by Enter and by cue, a populated log with a roll-up row and the older cue, the model knob, the three dot meanings, the arc atom's size, the Seen act on an arc-less awaiting trip, and the band's counts [F14 in the parent].
5. Delete the spike and its two registry lines, and update the taxonomy test's spike count if it pins one [B11].

The `row` altitude [B07] is already written and rides step 3's commit.
