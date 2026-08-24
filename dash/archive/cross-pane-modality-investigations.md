# Cross-Pane Modality & Event-Flow — Investigation Log

*A standalone encapsulation of a cluster of bugs in the **responder chain / pane
modality / portal lifecycle** layer, investigated 2026-05-31. Four were fixed;
one remains open. This is NOT a plan — it is a get-up-to-speed brief so a future
session can resume the open issue (and the broader review the cluster motivates)
quickly and completely.*

> **Read first:** [tuglaws/responder-chain.md](../tuglaws/responder-chain.md).
> Every issue below is an instance of its model being violated by a
> **process-global mechanism reachable across panes** where the law requires a
> **pane-scoped** one. The doc's §"The default button stack", §"First responder",
> §"Two walks, two questions", and §"Anti-patterns" are the directly relevant
> sections; two were amended by this work (see below).

---

## The unifying pattern

The app runs **multiple panes**, each able to host its own pane-modal sheet, but
several framework mechanisms are **single, process-global** singletons:

- the responder chain's **first responder** (exactly one, app-wide),
- the **default-button stack** (`ResponderChainManager.defaultButtonStack`),
- Radix `FocusScope`'s **document-global focus trap**,
- the **key card** (derived from the global first responder).

Every bug in this cluster is the same shape: **a keystroke or action that belongs
to pane A reaches a handler/surface in pane B** because it routed through one of
those globals instead of being scoped to the pane it originated in. The fix is
always the same shape too: **scope the mechanism to the originating pane** (the
first responder's `.tug-pane`, the editor's own `.tug-pane`, `inert` on the host
pane body, or structural-identity dispatch).

The user's framing, worth keeping: *"a sheet in a pane is pane-modal; it is a
critical error to allow this modality to leak out to other panes… this bug should
be impossible by construction if we were actually implementing a proper
responder-chain.md."*

---

## Investigation methodology that worked

Reasoning alone repeatedly produced wrong fixes here (the failure modes are focus
races and portal/lifecycle timing that don't reproduce in the app-test harness).
What worked, every time:

1. **Instrument with the dev-panel log**, not `console.log`. The WKWebView console
   is not visible in this setup; the in-app **Log inspector** (dev panel) reads
   `tugDevLogStore`. Log via
   `tugDevLogStore.info("xpane", "<message>", { data })` (source tag `xpane` so the
   user can filter). All such logging was removed after use — re-add it the same
   way for the open issue.
2. **Have the user reproduce** (these bugs reproduce reliably by hand but not in
   the harness) and **paste the `xpane` rows**. A widened `new Error().stack`
   captured at the suspect call site is the single most valuable signal — it named
   the real trigger in one shot after several wrong guesses.
3. **Fix at the framework layer**, then **prove the regression test has teeth**:
   temporarily revert the one-line fix and confirm the new app-test FAILS, then
   restore. Several harness tests passed against the bug because the setup didn't
   recreate the exact global-state ordering; teeth-checking caught that.

---

## SOLVED issues (2026-05-31)

All four landed on `main`. Regression tests `at0100`–`at0103`.

### 1. Sheet focus-trap leaked across panes — `8680c944`

- **Symptom:** a `TugSheet` open in pane B blocked focusing a prompt entry in
  pane A; clicking A's editor got yanked back into B's sheet.
- **Root cause:** `TugSheetContent` wrapped its content in Radix
  `FocusScope trapped={open}`. Radix's `trapped` installs a **document-global**
  `focusin` redirect — it pulls focus back into the scope from anywhere, including
  other panes.
- **Fix:** `trapped={false}`, keep `loop`. Same-pane modality is already enforced
  by the pane scrim (`useTugPaneScrim`) + `inert` on the host pane's
  `.tug-pane-body` — both pane-scoped. The global trap was pure leak.
- **File:** `tugdeck/src/components/tugways/tug-sheet.tsx`. **Test:** `at0100`.

### 2. Key-card dispatch from a component origin — `69465ac6`

- **Symptom:** `/rewind` typed in pane A could be handled by pane B's card.
- **Root cause:** `TugPromptEntry` dispatched the recognized local slash command
  via `useKeyCardDispatch` → `sendToKeyCard`, whose target is derived from the
  **global first responder**. When a sheet held first responder in pane B, the key
  card was B.
- **Fix:** route to the owning card by **structural identity** — the dev card
  passes `localCommandTargetId={`${cardId}-card-content`}`; the entry dispatches
  `RUN_SLASH_COMMAND` via `manager.sendToTarget(localCommandTargetId, …)`. Deleted
  the orphaned `use-key-card-dispatch.ts` (its only consumer was this
  mis-dispatch). Added `__tug.setFirstResponder` test affordance (surface v1.9.0).
  Documented the anti-pattern in responder-chain.md (§"Anti-patterns" →
  *"Key-card dispatch from a component / control origin"*).
- **Note:** `card-content` is a **registry sibling** of the prompt entry's chain
  (both `useResponder`/`useResponderForm` calls run in the dev-card body and read
  the same parent context), reachable only via the key card's **DOM-subtree
  search** — *not* via the prompt entry's `parentId` chain. So a parent-targeted
  `useControlDispatch` can't reach it; the host hands the entry the id explicitly.
- **Files:** `tug-prompt-entry.tsx`, `cards/dev-card.tsx`, `test-surface.ts`,
  `responder-chain.md`; deleted `use-key-card-dispatch.ts`. **Test:** `at0101`.

### 3. Default-button stack activated across panes — `8ed5c8d9`  ⟵ "the return key issue"

- **Symptom (the one the user chased hardest):** with an unbound dev card's
  "Choose Session" picker open in pane B, pressing **Return** in pane A's editor
  pressed pane B's picker **Open** button — spawning a session and dismissing the
  picker. Distinguishing clue from the user: *"It's the return key that's doing it…
  if I click the submit button, no contamination."*
- **Root cause:** the default-button stack
  (`ResponderChainManager.defaultButtonStack`) is **process-global**. Two
  activation sites peeked the global top and `.click()`ed it on Enter:
  the document keyboard pipeline **Stage 2** (`responder-chain-provider.tsx`) and
  **the editor keymap's submit-Enter defer** (`tug-text-editor.tsx`, the
  `peekDefaultButton` closure feeding `keymap.ts`'s submit branch). The picker's
  Open registers as a default button implicitly via
  `TugPushButton emphasis="filled" role="action"`. The actual trigger in the repro
  was the **editor keymap** site (the stack trace named
  `handleEnter → click → tug-button.handleClick → onOpen → close`), not Stage 2 —
  an early fix to Stage 2 alone did NOT resolve it.
- **Fix:** added `ResponderChainManager.peekDefaultButtonInScope(scope)` (walks the
  stack top-down, returns the first button contained in `scope`). Both activation
  sites now scope to the originating pane — Stage 2 to the **first responder's**
  `.tug-pane`; the editor keymap to the **editor's own** `.tug-pane`
  (`viewRef.current.dom.closest(".tug-pane")`). Fall back to the global peek only
  when there is no pane context (gallery / standalone). Documented in
  responder-chain.md (§"The default button stack").
- **Files:** `responder-chain.ts`, `responder-chain-provider.tsx`,
  `tug-text-editor.tsx`, `responder-chain.md`. **Test:** `at0102` (teeth: the test
  setup must register pane A's submit button BEFORE pane B's picker Open so B's
  Open is the global top — otherwise A's own button masks the bug).

### 4. Submit ignored the open completion — `464a777a`

- **Symptom:** with the completion popup open on a fragment (`/re`, `rewind`
  highlighted), submitting via the **button or Shift+Return** sent the fragment
  `/re` (→ "Unknown command") instead of the completed `/rewind`. Plain Enter / Tab
  already accept via the completion keymap; the button (chain SUBMIT) and
  Shift+Return bypass it (the completion keymap deliberately *yields* submit-class
  Enter).
- **Fix:** `performSubmit` calls `editor.acceptActiveCompletion()` before reading
  the draft. New `TugTextEditorDelegate.acceptActiveCompletion()` accepts the
  highlighted item iff the popup is interactive (`completionPopupIsInteractive`).
  Uniform for `/` commands and `@`-mentions (one completion engine).
- **Files:** `tug-text-editor.tsx`, `tug-prompt-entry.tsx`. **Test:** `at0103`.

---

## OPEN issue: tab-ifying an unbound dev card orphans its picker sheet

**Status:** diagnosed, NOT fixed. Reproduces reliably by hand; does not reproduce
in the harness as-is.

### Reproduction

1. Component Gallery open as a **tabbed** pane (several tabs).
2. Create an **unbound** dev card (floating pane) — its `DevProjectPicker`
   "Choose Session" sheet auto-presents.
3. **While the picker is open**, drag the dev card onto the Component Gallery
   pane's **tab bar** (tab-ify / cross-pane move).
4. **Result:** the picker sheet is orphaned — the new "Dev" tab shows an **empty
   body**, no picker.

### Root cause (code-grounded, three colliding facts)

1. **The card is preserved, not remounted.** Tab-ify routes through
   `deck-manager.ts#_moveCardToPane` (≈ line 2051), which **re-parents the
   `CardHost`** under the target pane to preserve dev-card sessions across moves
   (`card-host.tsx` is built around this — see its header comment). So
   `DevProjectPicker` (`cards/dev-card.tsx`, ≈ line 846) is **not** re-created; its
   present-once `shownRef` stays `true`, so `presentSheet` never re-fires.
2. **`_moveCardToPane` fires no move lifecycle event.** `cardWillMove` /
   `cardDidMove` are emitted only by `_repositionCard` (deck-manager ≈ lines
   986/997 and 1114/1122, gated on `positionChanged`). `_moveCardToPane` emits
   **neither** — so the picker has no signal to react to the move. This is a real
   gap: a move-into-a-tab *is* a move but is silent on that channel.
3. **The open sheet's portal target changes out from under it.** `useTugSheet` /
   `TugSheetContent` portal into the host pane's frame via `TugPaneFrameContext`.
   The re-parent swaps the frame element; the in-flight sheet does not survive the
   swap → orphaned.

`DevProjectPicker` subscribes only to `observeCardDidActivate` (guarded by
`shownRef`); it has **no** `observeCardDidMove` handling.

### Fix direction (framework-level — confirm by instrumenting first)

- Make `_moveCardToPane` fire `cardWillMove` / `cardDidMove`, consistent with
  `_repositionCard`. A tab-ify is a move and should be observable as one.
- A `useTugSheet` sheet should **re-anchor into its card's current pane frame** on
  a host move; OR, minimally, `DevProjectPicker` re-presents on `cardDidMove`
  (reset `shownRef` → `presentSheet()`, which re-`showSheet`s into the now-current
  `TugPaneFrameContext`). Decide which after the trace shows whether the sheet's
  portal can be re-anchored in place or must be re-presented.
- **Instrument before changing move semantics.** Suggested `xpane` log points:
  `cardWillMove`/`cardDidMove` (do they fire for tab-ify?), `DevProjectPicker`
  mount/unmount + `presentSheet`, `TugSheetContent` mount/unmount +
  `handleOpenChange`, and the identity of `TugPaneFrameContext` before/after. Have
  the user perform the exact drag-to-tab-bar repro and read the ordering.

### Why deferred

It lives in the cross-pane-move + portal + sheet-lifecycle layer — the same area
that produced the four bugs above and that the user explicitly wants to give
dedicated review time. It is an edge case (drag an unbound card with an open
picker onto a tab bar) and was raised at the tail of a long session; capturing the
diagnosis here lets the scheduled review pick it up cold.

---

## Where to start next session

1. Re-read [tuglaws/responder-chain.md](../tuglaws/responder-chain.md), especially
   §"The default button stack" and §"Two walks, two questions" — both now describe
   the pane-scoping invariant this cluster established.
2. For the open issue: instrument the tab-ify per above, reproduce, read the
   `xpane` trace, then fix `_moveCardToPane` + the sheet re-anchor / picker
   re-present. Pin it with an `at01xx` app-test (teeth-verify against the orphaned
   state).
3. Broader: audit every remaining process-global in the chain
   (`defaultButtonStack`, first responder, key card, any document/window listener)
   for a cross-pane reachability that should be pane-scoped. The recurring smell:
   `peek*()` / `sendToKeyCard` / a document-global listener consulted without a
   pane filter.
