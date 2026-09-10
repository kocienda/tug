# The app-test ask dialog is one row

**Purpose:** The inline dialog a gated `just app-test` raises is as tall as a small card while saying almost nothing. Cut it to a single header row — two action buttons, no provenance line, no file list, and the countdown as a draining hairline on the frame's bottom edge.

---

## Purpose {#purpose}

> "The inline dialog for running app-tests is way too tall. It doesn't need to be nearly that tall."

Asked to slim it, three candidates were put on a spike at real width. On the first round the user cut more than the candidates had:

> "We can remove the radio buttons and just give two action buttions: Skip | Run, eh? … 'REQUESTED BY A COMMAND ON THIS MACHINE' is an information-free display. It's… ummm… *obvious*. No need to say this. No need to list the tests, either. Who cares, really. Just need the timer."

On the second round, of three one-row treatments differing only in where the timer lives, the chosen one was **B3 — the timer as a hairline**.

So the work is not "make the dialog shorter." It is: the prompt carries the question, the two things the developer can do, and the time remaining — and nothing else reaches the surface.

---

## Evidence {#evidence}

**[F01] The height is five stacked rows, four of which are removable.** `session-app-test-ask-dialog.tsx` renders, in order: the `TugInlineDialog` header row (title + `Continue`), a provenance line, the caller's detail line, a vertical `TugRadioGroup` whose two items each carry their own description, and a countdown sentence — separated by the frame's `--tugx-idialog-frame-gap: 0.875rem` over `--tugx-idialog-padding`'s `1.5rem` bottom. Read out of the component and `tug-inline-dialog.css`. **(verified)**

**[F02] The one-row shape already exists in the primitive and needs no new token.** `inlineDialogLayout()` in `tug-inline-dialog.tsx` returns `"header"` when there is no description, no children, and no options, and the frame then takes `--tugx-idialog-padding-header: 0.625rem 0.75rem`. `.tug-inline-dialog-actions` is already built for a balanced pair — every `.tug-button` inside it takes `--tugx-idialog-action-w: 5rem`. So `Skip | Run` on the title row is the primitive's own shape, not an override of it. **(verified — rendered in the spike, which composes the real primitive.)**

**[F03] The resulting dialog is roughly a quarter of the height.** One `2.25rem` row inside `0.625rem`/`0.75rem` of padding is about `3.6rem` against the present stack's five rows, four gaps, and `1.5rem` of bottom padding. This is arithmetic over the token values plus the spike's on-screen comparison, **not a measurement in the running app** — the spike prints each variant's `getBoundingClientRect().height` beside it, and reading those two numbers is what would confirm the ratio.

**[F04] Nothing the caller supplies is lost by dropping the description rows.** The `app-test` recipe passes `--description "$FG_LIST"` (the test basenames) and a third `:description` field on each `--option`. The names are already printed by the run's own report; the option descriptions ("The other N are running now either way", "Keeps the screen yours") restate what the labels say. Read out of the recipe's `tugtool host ask` invocation. **(verified)**

**[F05] The countdown's present contract is "commits the *selected* option", and two buttons have no selection.** The component's docstring and `PendingAsk.unattendedChoice`'s doc comment in `code-session-store/types.ts` both say the count decides *when* and never *what*, so moving the radio to "skip" and walking away skips. A button pair cannot honour that — there is nothing to move. **(verified)**

**[F06] The protocol allows up to eight options.** `MAX_OPTIONS = 8` in `tugcast/src/server.rs`, and `/api/ask` is deliberately not dev-gated, so any local process can raise a question with more options than a button row can hold. The two-option question is the app-test case, not the protocol's guarantee. **(verified)**

**[F07] The app-test round trip pins the shape it is about to lose.** `at0320-app-test-ask-dialog.test.ts` selects on `[data-slot="tug-radio-group"]`, `[data-slot="tug-radio-item"]`, the single `actions` button as `CONTINUE`, and `[data-slot="session-app-test-ask-dialog-countdown"]`; its keyboard case arrows from `Continue` into the options and moves the selection, and its unattended case asserts that what the count will commit is what is checked. **(verified)**

---

## Decisions {#decisions}

**[B01] The two-option question renders as one header row: `Skip` then `Run`, in the frame's trailing cluster.** No description slot, no body, no options block — the primitive's `"header"` layout [F02]. `Run` is `emphasis="primary"` and carries `persistentDefaultRing`; `Skip` is `emphasis="outlined"`. Revisit only if the row cannot hold a real caller's title at the card widths people use, which the truncating `.tug-inline-dialog-title` already handles by ellipsis.

**[B02] Three or more options keep today's stacked radio shape.** The button pair is the two-option shape, and eight buttons on a row is not a shape [F06]. The dialog branches on `options.length === 2`. This keeps `/api/ask` general and keeps `tugtool host ask`'s `value:label[:description]` grammar untouched — no Rust change, and no exposure on the standalone contract.

**[B03] The provenance line is removed.** It could only ever have read "Requested by a command on this machine", so it spent a row to say nothing. Its anti-impersonation job now rests on what it always actually rested on: the frame, the app's own caution-tinted `TerminalSquare`, and the title being rendered as a plain string with no rich content from the wire. To keep the statement available without spending height, it moves to the frame's accessible description (an `aria-description` on the dialog root), where a screen reader and the accessibility inspector still get it. Revisit if a second non-app-test caller ever makes "which command?" a real question — that would want the *caller's identity*, which this line never carried anyway.

**[B04] The file list is removed from the prompt, and the recipe stops sending it.** Drop `--description` and the `:description` field of both `--option` specs from the `app-test` recipe's `tugtool host ask` call, and shorten the labels to `Run` and `Skip` [F04]. The dialog still renders a `description` when a caller supplies one — the slimness comes from the caller saying less *and* the component dropping its own chrome, not from the component refusing caller text.

**[B05] The countdown is a 2px rule along the frame's bottom edge, draining left-anchored from full width to zero.** It replaces the sentence. The tick writes the fill's `width` through a ref, the same way it writes the sentence's text today — no React state, no per-second re-render of the subtree ([L06], [L24]). The rule is inset inside the frame's border and clipped to the frame's radius.

**[B06] The countdown element keeps the `data-slot="session-app-test-ask-dialog-countdown"` name and gains `data-remaining`, written by the same tick.** A countdown with no text would otherwise be invisible to `at0320`, which has no business asserting on a CSS width. The attribute is the test's and the accessibility tree's reading of the same number the fill's width shows.

**[B07] With no radio to select, the count commits `unattendedChoice` exactly; `Escape` and `Return` keep their present meanings.** `Return` presses the default button (`Run`), `Escape` answers with the declining option (`Skip`), and the timeout commits `unattendedChoice` — which is `run-all` for the app-test question. The default ring goes on `unattendedChoice` when the caller set one, and on the declining option when they did not, so the ring is still the whole of the preselection. This is a real semantic change from [F05]: "move the selection to skip and walk away" is gone, and skipping now requires saying so. It was taken knowingly — the ring showing what will happen is what made it safe to leave running, and a button pair shows that as plainly as a checked radio did. `PendingAsk.unattendedChoice`'s doc comment and the component docstring must both be rewritten; leaving them saying "the selected option" would leave the codebase's own account of the prompt false.

**[B08] The hairline's accessible reading is a `progressbar` on the rule itself.** `role="progressbar"` with `aria-valuemax` at `countdownSecs`, and `aria-valuenow` / `aria-valuetext` written by the tick. The number left the screen; it must not leave the accessibility tree.

**[B09] The spike is deleted when the shape lands.** `tugdeck/src/spikes/spike-ask-dialog-height.tsx`, `spike-ask-dialog-height.css`, its two lines in `spike-registry.tsx`, and the spike-count pin in `src/__tests__/card-taxonomy.test.ts` back to 14. The hairline's CSS graduates into `session-app-test-ask-dialog.css`; nothing graduates into `tug-inline-dialog.css` [F02].

---

## Open Questions {#open-questions}

- **Does a 2px rule read on the six themes, under the card-modal scrim?** The spike shows it static on whatever theme is current; the scrimmed live dialog is the case that matters, and `--tug7-surface-toggle-primary-normal-caution-rest` over the raised surface at 2px is the thing to look at. Settled by putting the built dialog up on a light theme and a dark one. If it does not read, the fallback is a taller rule or the frame's border itself draining, not a return of the sentence.
- **Should the last few seconds say something the rule cannot?** Thirty seconds of draining is legible; the difference between eight seconds and three is not [spike B3's own note]. A numeral or a tint change under ~5s would restore urgency at some cost in quiet. Settled by watching one real countdown run out.

---

## Non-goals {#non-goals}

- **A timer numeral beside the buttons (spike B1).** Rejected: reads as a fact about the dialog rather than about either button, and is weakest at the one thing the count must say — what happens at zero.
- **The count inside the `Run` button (spike B2).** Rejected: it forces the action slot from `5rem` to `6rem`, so the pair stops reading as balanced, and it makes a control's label change once a second.
- **Changing `/api/ask`, `tugtool host ask`, or `MAX_OPTIONS`.** The protocol stays as it is [B02]; this is a rendering change plus one recipe's arguments.
- **Touching the focus trap, the card-modal scrim, or the **Awaiting** reading in Z2.** All three are correct as they stand and are load-bearing for reasons unrelated to height ([P16], [P19], `session-phase-visual.ts`). The spatial order inside the dialog does change — two buttons on one row replace the Continue↔options seam loop — but that is a consequence of [B01], not a redesign of the focus language.
- **Slimming the permission or question dialogs to match.** They are different prompts from a different source, and the reasons their rows exist have not been examined here.

---

## Exit {#exit}

**An arc.** The work is one component, one stylesheet, one recipe invocation, one app-test, and two doc comments — a shape a task list can carry.

Rough order, because two of these gate the others:

1. The component and its stylesheet: branch on `options.length === 2` [B02], render the header-only pair [B01], drop the provenance and detail markup [B03], add the hairline with its `data-slot`, `data-remaining`, and `progressbar` role [B05] [B06] [B08], and replace the Continue↔options spatial seams with the two-button row.
2. The countdown's commit path and the prose that describes it: `unattendedChoice` exactly [B07], with the component docstring and `PendingAsk`'s doc comment rewritten in the same step — they are the codebase's account of the semantics and must not outlive them.
3. The `app-test` recipe's `tugtool host ask` arguments [B04]. Independent of 1 and 2, but the dialog should be able to render the shorter question before the recipe starts sending it.
4. `at0320-app-test-ask-dialog.test.ts` [F07]: the keyboard case becomes a two-stop row, the unattended case reads `data-remaining` and asserts the ring is on what the count will commit, and the provenance assertion is replaced by one on the accessible description [B03]. This is the step that proves the round trip still closes, so it lands with 1–3 rather than after them.
5. Delete the spike [B09].
