<!-- tugplan-skeleton v2 -->

## TugSheet Presentation Modes {#tug-sheet-presentation}

**Purpose:** Give `TugSheet` a presentation-mode vocabulary so the sheet's *animation behavior* is a caller choice, not a fixed trait of the component. Today every sheet drops from the card title bar. That animation has a specific semantic — "something new is arriving on this card" — and it misfits surfaces whose semantic is different (a session-restore placeholder that was *already* part of the card, a passive acknowledge, a programmatic mount under test). The uncommitted tide restore work in the tree sidestepped this by *not* using a sheet at all for the restoring-session UI, which is itself evidence that the sheet's options are too narrow.

This plan adds three modes — `emerge`, `fade`, `immediate` — alongside the existing drop-from-title-bar behavior as the default `drop` mode. The final-rest geometry of the sheet is unchanged in all modes; only the enter/exit choreography differs. Once the modes land, we come back to the tide restore work and integrate them to deliver the reconnect experience.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-04-21 |
| Roadmap anchor | —|
| Related work | uncommitted tide restore placeholder (`tide-session-restore.ts`, `TideRestoring`) |

---

### Phase Overview {#phase-overview}

#### Context {#context}

`TugSheet` is the card-level modal surface (`tugdeck/src/components/tugways/tug-sheet.tsx`). Its enter and exit animations are hard-coded inside two `useLayoutEffect` blocks: the content panel translates between `translateY(-100%)` and `translateY(0)`, the overlay fades 0↔1, both at `--tug-motion-duration-moderate`. There is no caller-level opt-out and no mode selector.

When we designed the tide reconnect UX, we wanted an inline "Restoring session…" panel to appear on the card body while `spawn_session(mode=resume)` was in flight. Presenting that through a sheet was the natural fit — it is a modal, card-scoped interstitial with a Cancel action, which is exactly what `TugSheet` was built for. But the drop-from-title-bar animation read wrong for this case: the session is *already* the card's subject, so "announcing" it by dropping a sheet in made the UI feel like a new thing was being introduced instead of the card acknowledging its in-progress state. We sidestepped the mismatch by building a non-sheet panel (`TideRestoring`) with its own DOM, duplicating chrome and losing the `inert`-body / focus-scope / escape-to-cancel wiring we already get from the sheet. That decision is the symptom, not the fix: the sheet's *options* missed the mark, not the sheet itself.

The costs of the missing vocabulary, concretely:

- **Duplicated chrome.** `TideRestoring` re-invents padding, focus, border, and dismissal wiring instead of composing `TugSheet`.
- **Inconsistent card-modal semantics.** A restoring-session placeholder is card-modal in every behavioral sense (body `inert`, Escape should cancel, focus should trap) but isn't one structurally.
- **No immediate-present option for tests or initial mount.** Test harnesses and programmatic "sheet is already open when we render" paths are forced through the animation.
- **One animation shape fits every intent.** Drop-from-title-bar is a strong announcement gesture; it's overkill for passive acknowledgements.

#### Strategy {#strategy}

- **Presentation mode is a caller choice, not a component trait.** Add a `presentation` prop on `TugSheetContent` and a matching field on `ShowSheetOptions`. Default remains `drop` so existing call sites continue to animate identically.
- **Animation selection through the existing `group` animator.** Each mode is a pair of keyframe sets (enter / exit) executed by the same `group({ duration })` path. No new animation infrastructure; only a small switch inside the two `useLayoutEffect` blocks.
- **Final-rest geometry is invariant across modes.** The sheet sits in the same position, at the same size, with the same chrome, regardless of how it got there. Modes only affect the transition frames.
- **Tokens own the duration.** A per-mode duration token (e.g., `--tug-motion-duration-fast` for `fade`, `--tug-motion-duration-moderate` for `drop` / `emerge`, zero for `immediate`) keeps timing editable without code changes.
- **`immediate` is not "broken animation."** It is a first-class mode that skips the enter/exit animation entirely — both the overlay fade and the content transform. Useful for test harnesses and for cases where the sheet must already be on-screen at mount (e.g., session-restore-on-reload, where animating in would flash before the app has finished hydrating).
- **No new dismissal semantics.** Every mode dismisses through the existing chain-native `cancelDialog` path. Animation changes don't touch responder wiring.
- **Tuglaws apply.** [L06] — animation changes stay in CSS + DOM, driven by `group`, never React state. No new re-renders per-mode.

#### Success Criteria (Measurable) {#success-criteria}

**API:**
- `TugSheetContent` accepts `presentation?: "drop" | "emerge" | "fade" | "immediate"`, defaulting to `"drop"`. (verification: tsc + test)
- `ShowSheetOptions` (used by `useTugSheet().showSheet`) accepts a matching `presentation` field that forwards to `TugSheetContent`. (verification: tsc + test)
- Existing call sites continue to animate exactly as they do today without source changes. (verification: manual — open any existing sheet, compare before/after)

**Behavior per mode:**
- `drop` — content `translateY(-100%)` → `translateY(0)` + overlay `0` → `1`; exit reverses. (unchanged)
- `emerge` — content `scale(0.96)` + `opacity(0)` → `scale(1)` + `opacity(1)`; overlay `0` → `1`; exit reverses. Transform origin is the clip container's centroid.
- `fade` — content `opacity(0)` → `opacity(1)`; overlay `0` → `1`; no transform on either. Exit reverses.
- `immediate` — no animation at all; sheet is fully visible on the first committed frame after mount, and fully gone on the first committed frame after close. No `group` invocation.

**Card-modal invariants (unchanged across modes):**
- Body `inert` is applied on open and removed on close. (verification: existing tests pass unchanged)
- Focus scope traps Tab / Shift-Tab while open. (verification: existing tests pass unchanged)
- Escape / Cmd+. dispatch `cancelDialog` and close the sheet. (verification: existing tests pass unchanged)
- `onClosed` fires after the (possibly zero-duration) exit completes for all four modes. (verification: test per mode)

**Tokens:**
- Per-mode duration resolves through a single token with a documented default:
  - `drop`, `emerge` → `--tug-motion-duration-moderate`
  - `fade` → `--tug-motion-duration-fast`
  - `immediate` → `0ms` (no animation path taken)
- A consumer can override duration per call if a case demands it, but the token default covers the common path.

#### Non-goals {#non-goals}

- **No new dismissal paths.** Click-to-dismiss-overlay, swipe-to-dismiss, drag-handle, etc. remain out of scope. Sheet dismissal stays explicit (Cancel, Escape, Cmd+., `close()`).
- **No per-element animations inside the sheet body.** Modes govern the sheet chrome's enter/exit only. Consumers who want to animate their own content keep doing so independently.
- **No swap / replace transition between two sheets.** That is a separate feature (a transition *between* sheets, not a presentation *of* one). Deferred.
- **No new alignment / sizing options.** Final-rest geometry is still centered, title-bar-aligned, `max-width: 460px`. Size / position work is a separate plan if it lands.
- **No popover / confirm-popover / alert changes.** `TugPopover`, `TugConfirmPopover`, and `TugAlert` keep their existing animations.

#### Assumptions {#assumptions}

- Existing `group` animator (`@/components/tugways/tug-animator`) handles zero-duration animations correctly, or can be trivially extended to short-circuit. (Verify during Step 1.)
- Animation timings measured against `--tug-motion-duration-*` tokens are visually acceptable for all four modes — no per-mode easing fine-tuning beyond `ease-out` / `ease-in`. (Revisit if manual smoke says otherwise.)
- No call site will need more than one mode per sheet instance — the mode is chosen at `showSheet()` / render time and does not change for the lifetime of the mount. (If this breaks, revisit the API.)

---

### Open Questions {#open-questions}

- **Q1: Should `emerge` animate the overlay?** The panel scale-and-fade can stand alone; overlay fade reinforces the "it came from the card" feel but adds visual weight. Start with overlay-fade included; pull it if manual smoke says the emerge is calmer without.
- **Q2: Does `fade` want a tiny scale component (0.98→1) or pure opacity?** The stance today is pure opacity ("gentlest option"). A 2% scale is visually imperceptible but gives the animator something to ease, which can mask framerate hitches. Revisit if `fade` feels jittery.
- **Q3: What does `immediate` do about focus scope's entry focus?** FocusScope's `onMountAutoFocus` fires regardless of animation, so the keyboard entry point is identical. Confirmed — no action needed, but note it in the mode's doc comment.

---

### Work Plan {#work-plan}

The plan lands in four commits. Each commit leaves the build green; `drop` mode remains the default throughout so existing call sites never regress.

#### Step 1 — Add `presentation` prop and wire `drop` as the default {#step-1}

**Why:** Establishes the caller-level knob without changing behavior. Getting the prop + default in place first means the remaining steps are pure additions of new mode branches.

**Work:**
- Add `presentation?: "drop" | "emerge" | "fade" | "immediate"` to `TugSheetContentProps` (default `"drop"`).
- Add matching field to `ShowSheetOptions`; forward through `renderSheet()` to `<TugSheetContent>`.
- Extract the enter/exit animation bodies into a small internal helper keyed by mode; today's behavior is the `drop` branch.
- Confirm `group` handles a zero-duration / no-ops path cleanly (spike) — if not, add a guard in the helper.

**Verification:**
- `bun run check` clean, `bun test` green.
- Manual: open an existing sheet (any of: tide picker, popover demos in gallery). Animation identical to pre-change.

#### Step 2 — Implement `emerge` and `fade` modes {#step-2}

**Why:** These are the two new non-trivial animation paths. Landing them together lets us compare side-by-side in the gallery before committing to either.

**Work:**
- `emerge` — content keyframes `{ transform: scale(0.96), opacity: 0 }` → `{ transform: scale(1), opacity: 1 }`; overlay fade identical to `drop`; `transform-origin: center center` set in CSS on the content panel.
- `fade` — content keyframes `{ opacity: 0 }` → `{ opacity: 1 }`; overlay fade identical to `drop`.
- Duration tokens: `emerge` → `--tug-motion-duration-moderate`; `fade` → `--tug-motion-duration-fast`.
- Add a gallery demo card that presents all three animated modes side-by-side (three buttons, three sheets) so the difference is visible in one place.

**Verification:**
- Gallery card shows all three modes, dismiss with Escape + Cancel works in each.
- Manual comparison: `emerge` reads as "materializes in place," `fade` reads as "passive acknowledge."

#### Step 3 — Implement `immediate` mode {#step-3}

**Why:** Zero-animation path earns its own step because the code path is different (short-circuit, no `group` invocation, still fires `onClosed` after the close-side commit).

**Work:**
- `immediate` skips the `group({ duration })` call entirely in both enter and exit effects. Sheet is fully visible / fully gone on the first committed frame.
- `onClosed` still fires — the mount/unmount flow that drives `onClosed` depends on `mounted` transitioning, not on animation completion. Verify with a test.
- Gallery demo card gains a fourth button for `immediate`.

**Verification:**
- Test: `immediate` mode, `close()` called, `onClosed` fires on next committed render with no animation frame between.
- Manual: rapid open/close in `immediate` mode does not leak `inert`, does not lose focus restoration.

#### Step 4 — Integrate into tide restore; retire `TideRestoring`'s bespoke chrome {#step-4}

**Why:** Close the loop on what started this plan. Replace the custom `TideRestoring` panel with a sheet presented in `fade` (or `emerge` — decided at integration time). Inherit `inert`-body, focus-scope, Escape-to-cancel from the sheet instead of re-inventing them.

**Work:**
- Replace `TideRestoring`'s custom backdrop + panel with a `showSheet({ presentation: "fade", … })` call from the tide card.
- Remove `.tide-card-restoring-backdrop`, `.tide-card-restoring-panel`, and the inline `TideRestoring` JSX body; keep only the tokens/styles that a sheet body needs (title, monospace project path, footer row).
- Retry/Cancel become sheet-body actions dispatched through the existing `useTugSheetClose` / `close("cancel")` / `close("retry")` Promise flow.
- Confirm `onClosed` sequencing still allows the picker to re-present with its notice on timeout / cancel / resume_failed.

**Verification:**
- Manual smoke: reload the app with a card mid-session. Restoring sheet appears, Cancel dismisses it, Retry re-fires `spawn_session(mode=resume)`. Resume failure re-presents the picker with the retry notice.
- No regressions against the existing tide picker flow (fresh card open still drops the project picker sheet with `drop`).
- `bun run check` + `bun test` + `cargo nextest run` clean.

---

### Resolved Decisions {#resolved-decisions}

- **D1 — Four modes, not more.** `drop`, `emerge`, `fade`, `immediate`. Slide-from-bottom, slide-from-edge, and cross-fade-replace were considered and rejected: slide variants fragment the "sheets come from the title bar" mental model; cross-fade is a transition between sheets, not a presentation mode, and belongs in a separate plan.
- **D2 — Scale + opacity, not pure scale.** The `emerge` mode pairs a scale transform with an opacity fade. Pure scale reads as mechanical; the combined treatment reads as "materializing."
- **D3 — `immediate` is first-class.** It earns a mode name and a caller-facing opt-in, rather than being a hidden test-only shortcut. Restore-on-reload is a production case where animating in would flash before hydration settles.
- **D4 — Duration via tokens, not per-mode magic numbers.** `drop` / `emerge` at moderate; `fade` at fast; `immediate` at zero.

---

### Tuglaws Walkthrough {#tuglaws-walkthrough}

To be recorded at Step 4 close. Primary laws in play:

- **[L06] appearance via CSS / DOM** — all mode differences are keyframe sets executed by `group`, never React state toggles.
- **[L11] controls emit actions; responders handle actions** — dismissal path unchanged; modes are a pure presentation concern.
- **[L20] token sovereignty** — new duration bindings resolve through existing motion tokens; no raw ms literals in code.
