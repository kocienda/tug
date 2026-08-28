/**
 * @file Cross-surface invariants for the four floating surfaces.
 *
 * `tug-popover`, `tug-confirm-popover`, `tug-alert`, and `tug-sheet`
 * all migrated to chain-native control in A2.8 of the responder-chain
 * integration audit. They share enough structure that a single table
 * is worth keeping in the codebase as a reference for future
 * contributors; they also differ in load-bearing ways, and the
 * variations are just as important to document.
 *
 * This file exports nothing. It exists solely to carry the invariants
 * table and a short "which semantic model does each surface follow"
 * explanation near the code it describes. Each of the four surface
 * files references back here in its top-of-file docstring.
 *
 * ## Invariants table
 *
 * ```
 *                                       popover   confirm-popover   alert    sheet
 *   Internal state + imperative handle    ✓             ✓  (*1)      ✓        ✓
 *   useOptionalResponder with
 *     dialog handlers                     ✓  (*2)       ✓            ✓        ✓
 *   observeDispatch subscription          ✓  (*3)       ✓            ✗ (*4)   ✗ (*4)
 *   Radix dismissal → cancelDialog
 *     re-emission                         ✓             n/a (*5)     ✓        ✓ (*6)
 *   Safari focus-shift fix                ✓             ✓            ✓        ✓
 *   No-provider fallback                  ✓             ✓            ✓        ✓ (*7)
 * ```
 *
 * - (*1) `TugConfirmPopover` composes `TugPopover` and drives it via
 *        a `TugPopoverHandle` ref; open/close state lives in the
 *        underlying `TugPopover`, not in confirm-popover itself.
 * - (*2) `TugPopover` registers its responder inside
 *        `TugPopoverContentShell`, a nested component rendered only
 *        while `Popover.Content` is actually mounted. This is
 *        load-bearing — see tug-popover.tsx for the full rationale.
 * - (*3) `TugPopoverContentShell` filters `observeDispatch` events by
 *        `document.activeElement`: dispatches while focus is inside
 *        the popover (form controls, inputs, switches) do not
 *        dismiss. See tug-popover.tsx for the heuristic's limits.
 * - (*4) `tug-alert` and `tug-sheet` are modal. An alert blocks the
 *        whole app until the user confirms/cancels; a sheet is
 *        card-modal with an opaque scrim. "Close on any chain
 *        activity" would surprise users whose modal disappears
 *        because an unrelated keyboard shortcut fired. Both surfaces
 *        therefore opt out of `observeDispatch` subscription entirely.
 * - (*5) `TugConfirmPopover` has no Radix primitive of its own — it
 *        delegates open/close to `TugPopover`, which re-emits
 *        `cancelDialog` from its own `handleOpenChange`. Confirm-
 *        popover's inner responder catches the re-emission and
 *        resolves the pending promise.
 * - (*6) `tug-sheet` handles Escape and Cmd+. directly in its
 *        `onKeyDown` handler, dispatching `cancelDialog` through the
 *        chain. It does not wrap a Radix primitive with an
 *        `onOpenChange` callback, so there's no centralized "Radix
 *        dismissal" event to intercept — the dispatch lives at the
 *        keydown site.
 * - (*7) `tug-sheet`'s no-provider fallback is implicit: without a
 *        manager the `cancelDialog` dispatch path short-circuits and
 *        the sheet falls back to calling its internal close handler
 *        directly. There is no dedicated no-provider test because
 *        the sheet is primarily exercised through `useTugSheet()`
 *        which assumes a provider context.
 *
 * ## Semantic models
 *
 * Three different "when should I close?" models are in play:
 *
 * - **Chain-reactive** (popover, confirm-popover): close on any
 *   external chain activity while open. These surfaces are transient,
 *   anchored, and non-blocking — the user may dismiss them by
 *   switching focus or firing a shortcut elsewhere. `observeDispatch`
 *   is the primary signal; Radix click-outside and Escape are
 *   secondary. The popover variant adds a focus-inside filter so
 *   form controls nested inside can emit actions without self-
 *   dismissing their container.
 *
 * - **Modal** (alert, sheet): stay open until the user explicitly
 *   resolves. These surfaces physically block interaction with
 *   surrounding content (an alert with an overlay; a sheet with a
 *   scrim that swallows pointer events). `observeDispatch` is NOT
 *   used — dismissal requires a confirm/cancel button, Escape, or
 *   Cmd+. The close path is routed through `cancelDialog` so the
 *   Promise API adapters (`alert()`, `useTugSheet()`) can resolve
 *   from a single chain handler.
 *
 * - **Exclusive** (a sheet opened with `exclusive`): modal, plus the
 *   keyboard exits removed. A sheet covering a RUN rather than a
 *   decision takes its card's modal hold (`lib/card-modal-hold-store`)
 *   while open, and Escape, Cmd+., a later `showSheet` on the same
 *   host, and the pane's close routes are all refused through the
 *   holder's own `onRefused` rather than acting. The `close(result)`
 *   callback handed to the sheet's content is the run's door and is
 *   untouched, so completion and the sheet's own Cancel still work.
 *
 * - **Pinned** (`tug-placard`): non-blocking like a popover, but
 *   stays open until the user explicitly closes it with the panel's
 *   `×` — no click-outside, no Escape, no card-deactivation dismissal.
 *   Because it does NOT block interaction, it does NOT participate in
 *   the responder chain at all (no dialog handlers, no
 *   `observeDispatch`, no `cancelDialog`). The key structural
 *   difference from the popover: it renders **in-DOM** inside the card
 *   (not portaled to the deck overlay), which is what makes staying
 *   open across card deactivation safe — it hides with its own card
 *   rather than lingering over a neighbour. It owns its position (a
 *   horizontal drag persisted through tugbank) instead of anchoring
 *   via Radix Popper.
 *
 * ## Where this fits
 *
 * A2.8 also extracted `suppressButtonFocusShift` into
 * `./safari-focus-shift.ts`. That utility is used by all four
 * surfaces to work around macOS Safari's refusal to move focus to
 * `<button>` on click, which otherwise breaks the
 * `findResponderForTarget` walk. See that file's docstring for the
 * full explanation.
 */

export {};
