<!-- brief-skeleton v1 -->

# The update surface

**Purpose:** The app-update experience that landed with the non-modal work is functionally right and visually poor: a pill too small to notice, a popover that is a title and three buttons, a 2px underline for progress, and a ready-to-install state that is easy to miss. Replace it with what the `update-flow` spike settled — one surface with two sizes, an accent badge that expands into a ConfigureTug-style step-list dialog — without reopening any of the decisions the earlier brief made about how the flow works.

---

## Purpose {#purpose}

The user, after installing `0.8.0` in a lab VM and cutting `0.8.1` against it, saw the shipping surface for the first time and said: *"The UI for the whole sparkle/update experience is terrible. We need a spike card to design something very much better."* The notes were specific: the pill is too small; the pill should be the theme accent colour; the update dialog "is a horrid mess" and needs to look like an alert dialog, of which the app has abundant examples; the "Ready to install" state should show itself; and the flow of downloading and installing is wizard-like, so it should be built on the ConfigureTug model.

The spike (`tugdeck/src/spikes/spike-update-flow.tsx`) went through five rounds with the user looking at each, and settled. This brief is the roll-out of what it settled into `tugdeck/src/components/chrome/update-overlay.tsx` and its stylesheet. The user has said they expect notes once the real thing is in their hands; the design here is what to build first, not the last word.

This brief amends `briefs/non-modal-app-updates-brief.md`. Everything that brief decided about the host — the custom `SPUUserDriver`, the snapshot/action bridge, the app-menu door, the never-shown permission prompt, the release-notes pipeline — stands untouched. What changes is the deck's presentation, which that brief's [B04] and [B06] describe and which this one replaces.

---

## Evidence {#evidence}

**[F01] The shipping surface is a hand-rolled pill and a popover, in one file** — `tugdeck/src/components/chrome/update-overlay.tsx` (~430 lines) and `update-overlay.css`. The pill is a bare `<button>` with its own tokens (`--tugx-update-pill-*`), `font-size: xs`, a neutral overlay background, and a 2px accent underline whose width is the download percent. The popover is `TugPopover` holding an `<h2>`, an optional markdown block for the notes, a 4px progress bar, and a `.tugx-update-controls` row of `TugButton`s — three in a row for `available` (Install and Relaunch / Later / Skip This Version). It is mounted once at the deck level in `DeckCanvas` and portaled into `CanvasOverlayRoot`, upper right. **(verified)**

**[F02] The stage machine and the store are right and stay** — `tugdeck/src/lib/update-store.ts` mirrors `UpdateStage` in `tugapp/Sources/UpdateState.swift` one for one (`idle · checking · available · downloading · extracting · readyToInstall · installing · upToDate · error`), carries `version`, `build`, `releaseNotes`, `message`, `userInitiated`, and a separate `percent` read surface so progress never wakes React. `postUpdateAction` sends `install · later · skip · cancel · retry · dismiss · check` to the host. Nothing in the spike needed a stage, a field, or an action the store does not already have. **(verified)**

**[F03] Three behaviours in the shipping overlay are policy, not appearance, and must survive** — read out of `update-overlay.tsx`: (a) `upToDate` dismisses itself after 4 s by posting `dismiss`, because an answer with nothing left to do should not need clearing by hand; (b) a **user-initiated** check opens the popover on its answer (`available`, `upToDate`, `error`) and only then — tracked per stage so a later transition in the same flow does not reopen a popover the user closed; (c) `available` and `readyToInstall` show the mid-turn warning from `relaunchWarningLine(useMidTurnSessionTitles())`, naming the sessions a relaunch would cut off. **(verified)**

**[F04] The ConfigureTug wizard has exactly one progress indicator, and it is the dot** — `tugdeck/src/components/tugways/configure-tug.tsx` renders one `TugProgressIndicator`, `variant="pulsing-dot"`, per step row; busy is the dot breathing (`role="agent" state="running"`) and the detail line saying what is happening ("Installing…", "Use your browser to log in…"). There is no bar. The spike's first draft added a full-width bar under the download row and the user rejected it: *"This should look and work exactly like ConfigureTug."* **(verified)**

**[F05] `TugInlineDialog` sizes its trailing `actions` slot for a balanced pair** — `tug-inline-dialog.css:254` sets `width: var(--tugx-idialog-action-w)` (5rem) on every `.tug-button` in the cluster, and the description below the header is centred by the component's own rule. Three unequal buttons in that slot overflowed one another; a lone icon button in it centred its glyph in a 5rem box. Both were found in the spike and both are why the settled design puts the decision buttons in a bottom row and a single collapse control in the header. **(verified)**

**[F06] One app-test covers the shipping surface** — `tests/app-test/at0612-update-pill-popover.test.ts` declares `@covers` on `update-overlay.tsx` and drives it through `data-testid="update-pill"`, `update-popover`, `update-progress`, `update-release-notes`, `update-error-message`, and `update-mid-turn-warning`. No bun unit test reads the overlay. **(verified)**

**[F07] The settled spike, as the user saw it last** — a filled accent `TugBadge` (`size="lg"`) as the collapsed form, with a stage glyph (down-arrow for `available`, refresh for `readyToInstall`, a spinner for the transient stages, a check for `upToDate`; `danger` role for `error`, `success` for `upToDate`, outlined `inherit` for the transient stages); a `TugInlineDialog` as the expanded form, with the stage's icon and role, the title, the description, a step list of three ConfigureTug rows (Download / Unpack / Install and relaunch), and a bottom row with the rare action alone on the left and the decision pair on the right; a `TugIconButton` (chevrons-down-up) alone in the dialog's header slot, inset 1rem from the frame, that collapses to the badge; and the release notes as the dialog's body in the `available` state. The spike's title and description are a size up from the dialog's defaults (`--tugx-idialog-title-size: 1.0625rem`, `-description-size: 0.9375rem`), scoped. **(verified — it is the file on disk)**

---

## Decisions {#decisions}

**[B01] The pill and the dialog are one surface with two sizes.** Not a trigger and a popover: one thing, collapsed or expanded. The expanded form is the dialog in the canvas's upper right; the collapsed form is the badge in the same corner. A collapse control in the dialog's header collapses it, clicking the badge expands it, and **nothing else changes its size** — no stage transition, no timer, no focus event. This is what makes deferral a first-class gesture: an update arrives, the user collapses it, and it waits as a badge until a convenient moment. It replaces the earlier brief's [B04] (pill opens popover), and it makes its [B06] simpler to state: the size is the user's, always.

**[B02] Arrival size follows who asked.** A scheduled check that finds something **arrives collapsed** — the badge lights, nothing else moves, which is the earlier brief's "an update is information, not an emergency" carried forward. A check the **user started** arrives expanded on its answer (`available`, `upToDate`, `error`), because being shown the answer is what they asked for. This is [F03](b), restated for a surface that has sizes rather than an open/closed popover, and the same `userInitiated` flag decides it.

**[B03] The collapsed form is `TugBadge`, filled, in the theme accent.** `size="lg"`, `emphasis="filled"`, `role="accent"` for the two stages that hold a decision (`available`, `readyToInstall`); `role="danger"` filled for `error`; `role="success"` filled for `upToDate`; `emphasis="outlined"` with `role="inherit"` for the transient stages (`checking`, `downloading`, `extracting`, `installing`). Each stage carries a glyph as in [F07]. The badge is a shipping component with theme-aware tokens, so the pill stops carrying its own tokens (`--tugx-update-pill-*` go away) and stops being hand-rolled [L20]. The accent answers "should be the theme accent colour"; `lg` answers "too small."

**[B04] The expanded form is `TugInlineDialog`, composed, not a new dialog component.** Icon and `iconRole` from the stage (`info` for the offer and the transient stages, `success` for `readyToInstall` and `upToDate`, `danger` for `error`); the title and description per stage; the step list and the bottom row as the dialog's `children`. The dialog's `actions` slot holds the collapse control and nothing else [F05]. The title and description sizes are bumped one step through the dialog's own tokens, scoped to this surface, as the spike does — this is a decision read from across a window, not a permission strip in a transcript.

**[B05] The body is a ConfigureTug step list, and it looks and works exactly like ConfigureTug.** Three rows — *Download Tug &lt;version&gt;*, *Unpack the update*, *Install and relaunch* — each a `pulsing-dot` + label + detail line at ConfigureTug's metrics (60px fixed row height, 14px/13px, the same status→dot mapping: pending/stopped, active/paused-action, busy/running-agent, error/aborted-danger, done/completed-success). **No progress bar** [F04]. Progress is words in the detail line: Sparkle's byte counts when it has them ("43 MB of 70 MB"), a phrase when it does not ("Starting…", "Verifying the signature…", "Waiting for 1 session to finish its turn…"). The earlier brief's [B05] ("progress is appearance") therefore reduces to writing the detail text; the CSS-property plumbing for a bar width is deleted with the bar. The row component should be shared with, not copied from, ConfigureTug — if `configure-tug.tsx`'s step row cannot be lifted as-is, lift it into a `tugways` component both use rather than leaving two copies.

**[B06] Buttons go in a standard bottom row, not the header.** Right-hand group: the quiet one then the primary — *Later | Download* in `available`, *Later | Install and Relaunch* in `readyToInstall`, *Dismiss | Retry* in `error`, a lone *Cancel* while downloading, a lone *OK* for `upToDate`. Left-hand, alone and outlined (not ghost): *Skip This Version*, in `available` only. `TugPushButton`, `size="sm"`, `filled`/`accent` for the primary and `outlined` for the rest. This is where the earlier surface's three-in-a-row went wrong and where the header slot's pair-width contract [F05] made the first spike layout collide; a bottom row is the alert-dialog shape the app already uses everywhere.

**[B07] The offer carries the release notes as the dialog's body, above the step list.** In `available`, `releaseNotes` renders through `TugMarkdownBlock` (keyed on the text, as today, since static mode is mount-once and notes can arrive after the dialog is up), capped and scrolling. An absent notes file renders nothing there and blocks nothing, as before.

**[B08] The three policy behaviours in [F03] are kept, re-homed onto the new surface.** (a) `upToDate` still self-dismisses after 4 s; a user who collapsed it sees the badge go. (b) User-initiated answers expand per [B02]. (c) The mid-turn warning still shows in `available` and `readyToInstall`, as a caution-toned line in the dialog above the bottom row, and the *Install and relaunch* step's detail names the sessions when there are some — the spike's "2 sessions are mid-turn: …" is the shape.

**[B09] The mount, the store, the bridge, and the host do not change.** Still one `UpdateOverlay` in `DeckCanvas`, still portaled to `CanvasOverlayRoot`, still `useUpdateState` for renders and the `percent` read surface for the detail text, still `postUpdateAction` for every button. No new IPC, no Swift change, no new action. If the roll-out finds it needs one, that is a finding for the user, not a thing to add quietly.

**[B10] The app-test is retargeted, not deleted.** `at0612-update-pill-popover.test.ts` keeps its `@covers` and its subject; its selectors move to the new surface (`update-badge` / `update-dialog` for the two sizes, the other testids kept where the element survives, `update-progress` dropped with the bar). It should additionally pin the two things this brief adds that the old surface could not express: a scheduled `available` arrives collapsed, a user-initiated one arrives expanded, and neither a stage transition nor a timer changes the size afterwards [B01] [B02].

**[B11] The spike is deleted when the surface lands.** Its findings are in this brief and its component work is in the overlay; the file, its stylesheet, and its two lines in `spike-registry.tsx` go. The deleted-spike-in-a-saved-layout warning is expected and correct.

---

## Open Questions {#open-questions}

- **Should `readyToInstall` arriving in the background do anything beyond changing the badge?** Under [B01] it swaps the badge's words, glyph, and (already accent) colour and nothing else. The user's note was that ready-to-install "should show itself"; the settled spike answers that with the accent badge and a distinct glyph, not with an expansion. Whether that is enough is the kind of thing the user said they would have notes on after using it, and it is cheap to change either way. Ship [B01] as written and let the notes decide.

- **Width of the expanded dialog in the corner.** The spike's panel is 600px wide, which is what the dialog wants for three rows with detail lines. On a small window that is a large share of the canvas. Ship it, and if it reads as too much, the lever is dropping the per-row detail line for the pending rows rather than shrinking the type.

---

## Non-goals {#non-goals}

- **The Install and Relaunch bug.** The user reported that pressing it does nothing in the installed `0.8.1`. That is host-side (the `install` action's path through `UpdateController` and the postponed relaunch) and it is tabled by the user's explicit decision; this brief changes no host code [B09] and does not claim to fix it. Diagnose it from the VM's `UpdateController:` log lines when the user returns to it.

- **A modal, a sheet, or a card.** Considered when the spike was first shown; the user chose a popover-shaped, in-corner surface and the wizard-like flow inside it. Nothing here takes the room [B01] [B02].

- **A progress bar of any kind.** Rejected by the user against the ConfigureTug standard [F04] [B05]. Not to be re-proposed as "just a thin one."

- **Changing the stage machine, the snapshot, the actions, or the host driver.** [B09]. The earlier brief's host decisions stand.

- **Changing `TugInlineDialog`'s pair-width rule for the actions slot.** The roll-out uses a scoped override for its lone icon button, as the spike does. Whether a single icon action should be exempt in the component itself is a component question worth a line in a later pass, not this one.

- **Component-gallery entries for the badge or the dialog.** They are shipping components already; the update surface is a use of them, not a demo.

---

## Exit {#exit}

**An arc.** The shape is a replacement of one file's presentation under an unchanged store and bridge, with its one app-test retargeted:

1. Lift ConfigureTug's step row into a shared `tugways` component if it cannot be used as-is [B05], so the update surface and the wizard share one row rather than two copies.
2. Rewrite `update-overlay.tsx` / `.css` as the two-size surface: the badge, the dialog, the bottom row, the collapse control, the size rule [B01]–[B08]; delete the pill tokens, the underline, and the bar plumbing.
3. Retarget and extend `at0612-update-pill-popover.test.ts` [B10]; run it alone and in the changed selection.
4. Delete the spike [B11]; `just lint`; `just app-test-changed`.
5. `just app-release` and `just update-rehearse` so the user can watch the real surface against a local feed, which is where their notes will come from.
