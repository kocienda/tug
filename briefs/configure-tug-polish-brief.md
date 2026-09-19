<!-- brief-skeleton v1 -->

# Configure Tug polish: the default ring, the dots, and a way out of a login

**Purpose:** The Configure Tug wizard paints its double default ring on the wrong button, breathes its dots on rows where nothing is happening, and offers a logged-in user no way to log out from the row that says they are logged in.

---

## Purpose {#purpose}

Three notes from the user, looking at the on-demand wizard (Tug ▸ Configure Tug…) on a fully configured machine:

- "Default buttons in the onboarding experience do not have a double border around them. They should." The screenshot shows **Done** wearing the double ring while **Choose** — the button the active row is actually asking the user to press — wears none.
- "The dots next to an item *should not pulse* unless there is actual activity being undertaken for that item. Otherwise, an item's dot should be blue and not pulsing." The project-directory row's dot breathes while the wizard waits on the user.
- "When I'm logged in, the 'Logged In' item should offer some kind of secondary button to the left of the green checkmark that would allow me to raise up the 'Log Out…' dialog. Otherwise, it's unclear how I would change my login."

---

## Evidence {#evidence}

**[F01] The double ring is an opt-in, and only Done opts in** — `tugdeck/src/components/tugways/configure-tug.tsx` passes `persistentDefaultRing` on the Done button alone. The step CTAs are `TugPushButton` with `emphasis="filled"` and `role="action"`, which `internal/tug-button.tsx` registers as Return's home by emphasis (`isDefaultButton`) but which never paints `data-default-ring` without the opt-in. So Return already fires Choose while the ring sits on Done: the promise and the paint disagree. **(verified)**

**[F02] One ring per surface is structural** — `internal/tug-button.tsx` documents that "Return's home is ONE concept": the button Enter activates and the button that wears the ring must be the same, and the focus manager stamps `data-default-ring` on exactly one node. Two buttons opting in on the same surface would fight for the stamp. **(verified)**

**[F03] The wizard's active rows breathe because `active` maps to `running`** — `dotVisual` in `configure-tug.tsx` maps `active` (the user's turn) to `{ role: "action", state: "running" }`, the same animated pose as `busy` (an async action in flight). The pulsing-dot glyph's `running` is the breathing pose; `paused` is a full-size dot with a static ring and no animation; `stopped` is a reduced quiet dot. At the wizard's 14px the presence ladder is gone, so `paused` and `completed` occupy the same box (`internal/tug-progress-pulsing-dot.tsx`, `presenceScale`). **(verified)**

**[F04] Logout is already a one-call funnel** — `requestLogout()` in `tugdeck/src/lib/logout-store.ts` bumps a nonce; `tug-logout.tsx` watches it and runs the "Log Out of Claude?" confirm, the interrupt loop over every card, and the `claude_logout` frame. The File-menu item and the `/logout` slash command both call it. It no-ops when already logged out. **(verified)**

**[F05] A done row renders only the check** — `StepRow` shows the green check when `status === "done" && !cta`, and renders the secondary CTA only in the `cta || secondaryCta` branch. A done row with a secondary CTA and no primary CTA is not a shape the row can draw today. The action slot is already a flex row with a `--tug-space-md` gap. **(verified)**

**[F06] The confirm can sit over the open wizard** — `TugAlert` and `ConfigureTug` share the `tug-alert-overlay` / `tug-alert-content` classes at z-index 99990/99991 in the same canvas overlay; a later-mounted Radix alert paints above and nests its focus scope. On a confirmed logout, `authStore` flips logged-out, the wizard's `required` claim becomes true, and the already-open wizard reshapes itself to the login-only rows with Done hidden. On cancel, nothing changes. This is read from the code, not exercised in the app. **(inferred)**

**[F07] The on-demand wizard is the app's gesture for changing an answer** — the project-directory row reopens only when `showingOnDemand` is true, and the file's comments say each on-demand visit "is the gesture for changing an answer". The first-run wizard keeps rows settled. **(verified)**

**[F08] Existing coverage** — `tests/app-test/at0440-configure-tug-version-row.test.ts` and `at0441-configure-tug-git-row.test.ts` open the wizard on demand via `dispatchControlAction("configure-tug")` and pin the install and git rows. Nothing pins the default ring, the dot's animation state, or the sign-in row's affordances. `tugdeck/src/spikes/spike-configure-tug.tsx` mirrors the row shapes for HMR iteration. **(verified)**

---

## Decisions {#decisions}

**[B01] The wizard names one Return home per render, and that button wears the double ring.** If any row is `active` or `error`, that row's primary CTA gets `persistentDefaultRing` and Done gets `neverDefaultButton`. If no row wants anything from the user, Done keeps the ring as it does today. This makes the paint match the promise [F01] under the one-ring invariant [F02]. The project-directory Choose lives in the row body rather than the action slot, but it is the same `TugPushButton`, so the same prop applies, and the chooser field's Return already submits the same handler.

**[B02] Retry and Try Again on an error row wear the ring too; Update on a settled row does not.** An error row's retry is the row's only forward move and is not destructive, so Return belongs to it. Update is an optional offer on a row that is already done — it is not what the user is being asked to do, and it stays an outlined button without a ring.

**[B03] `active` maps to `paused` with role `action`: a full blue dot, static ring, no animation.** Only `busy` keeps `running`, which also covers the probing and reconnecting rows, where work genuinely is in flight. `paused` is chosen over `stopped` so the row that wants the user's attention is as present as a done row, just blue rather than green [F03]. The file header's "pulsing-dot row" line and the D106 gloss are reworded to say the pulse means activity, not the user's turn.

**[B04] The logged-in row gains a "Log Out…" secondary CTA whose handler is `requestLogout()`.** The wizard adds no logout logic of its own; TugLogout owns the confirm, the interrupt loop, and the frame [F04]. The ellipsis matches the menu title because the button raises a dialog.

**[B05] The secondary button is `ghost` emphasis, to the left of the green check, in the existing action slot.** `StepRow`'s done branch is changed to render a secondary CTA beside the check [F05]. Ghost is what the git row's Skip and Recheck already use, and the user confirmed ghost is right for these secondary buttons.

**[B06] The Log Out… button is offered only on the on-demand wizard.** The on-demand visit is the app's gesture for changing an answer [F07], and a first-run user has no reason to undo the login they just made. The condition is `showingOnDemand`, the same latch the project-directory row reopens on.

**[B07] The confirm stacks over the open wizard rather than closing it first.** Cancel must return the user to the wizard they were looking at, and the wizard already reshapes itself when auth flips [F06]. If exercising this in the app shows the two Radix focus scopes fighting, the fallback is to close the on-demand wizard before requesting logout and let it reopen itself on the auth flip.

**[B08] Coverage lands with the change.** An on-demand app-test with `@covers` for `configure-tug.tsx` pins: the active row's CTA carries `data-default-ring` and Done does not; the active row's dot carries no breathing attribute; the sign-in row shows Log Out…, clicking it raises the "Log Out of Claude?" alert, and the test presses Cancel. The test must never confirm, since that would log the test machine out. The spike file picks up the same three changes so it stays honest [F08].

---

## Open Questions {#open-questions}

- Whether the stacked confirm [B07] behaves cleanly with two trapped Radix focus scopes is inferred from the code, not observed. The first step that exercises it in the app settles it, and the fallback is named in the decision.

---

## Non-goals {#non-goals}

- **Two persistent rings.** Ringing both Done and the active row's CTA was not considered acceptable: the ring is a promise about Return, and only one button can keep it [F02].
- **A logout affordance on the first-run wizard.** Rejected per [B06].
- **Reworking the pulsing-dot glyph.** The glyph already has the static blue pose the wizard needs; the change is in the wizard's mapping, not the component.
- **A wizard-local logout flow.** Everything from confirm to frame already lives in TugLogout [F04]; duplicating any of it here is a second path to one act.

---

## Exit {#exit}

**An arc.** The three changes are independent and small, all in `configure-tug.tsx` with a `StepRow` reshape, and land in any order. A natural first step is the Return-home rule [B01]/[B02], since it touches every row; then the dot mapping [B03] with its comment and D106 gloss; then the Log Out… button [B04]–[B07] with the `StepRow` done-branch change. The app-test [B08] and the spike update close it out, and the stacked-confirm behaviour is checked in the running app when the button lands.
