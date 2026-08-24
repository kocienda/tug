## Keyboard Focus Mode (KBF) {#kbf-mode}

**Purpose:** Replace the three ambient arrow-ownership mechanisms (the empty-input release, the boundary latch, and the emptiness-conditioned Tab/arrow handoffs) with one explicit, named, user-controlled mode — **KBF mode** — in which rings paint and the engine owns movement keys, while mode OFF gives text surfaces unconditional key ownership and paints no rings at all. Ships the derived mode bit, the parked text stop, the list-attached-field contract that fixes Open Quickly, and the corresponding doctrine and test surgery.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | vetted — fixups folded in 2026-08-10 |
| Target branch | main |
| Last updated | 2026-08-10 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The arrow-traversal work (`53233fdc6`, archived at [dash/archive/arrow-traversal.md](archive/arrow-traversal.md)) made arrows move keyboard focus everywhere, but never gave the app a mode: whether an arrow moves a caret or a ring is recomputed on every keydown from ambient DOM state, and the most load-bearing input is whether the focused text field happens to be empty. The full diagnosis, the design, and every design question — all now DECIDED — are in [dash/kbf-mode-brief.md](kbf-mode-brief.md). The sharpest casualty is Open Quickly: on open (empty query, seeded key view), `resolveArrowRelease` returns `"released"`, the spatial move declines, and the liveliness net consumes ↓ before the popup's own `onKeyDown` (`tugdeck/src/components/tugways/tug-completion-popup.tsx`, the `onKeyDown` handler) ever runs — so ↓ either rings the directory switcher or does nothing, in exactly the state a fast open-quickly gesture passes through.

This plan implements the brief's design D1–D7 verbatim. The brief is the *why*; this document is the *how*, standalone: every file, symbol, and behavior an implementer needs is named here.

#### Strategy {#strategy}

- **Additive before subtractive.** Land the engine mode bit, its projection, and the list-attached-field contract first, while the old mechanisms still run — every intermediate commit leaves the app working.
- **The engine owns the bit** ([P01]): `manuallyEngaged` is a `FocusManager` boolean; auto-engagement is derived from surface presence (trap stack + key-card declaration + accessibility mode), never latched.
- **One projection, one CSS gate** ([P02]/[P04]): `data-kbf` on `<html>`, written by the same `applyProjection()` pass that writes `data-focus-mode`; every ring rule in `focus-ring.css` gains it as an ancestor gate.
- **Fix the exemption before deleting the release.** The list-attached-field contract ([P08]) replaces what the empty-input release was buying for filter fields, so it lands before `arrow-release.ts` dies.
- **Delete in one step** ([P06]): the release module, the boundary latch, the Tab/arrow handoffs, and `enterAt`/`enterToward` go together, because they are one compensation network — removing half leaves dead doors.
- **Paint and movement stand down together** ([P04]/[P07], #step-5): the ring gate and the ladder's mode gate are one commit. Gating the rings while the movement stages still walk would ship an app where focus moves invisibly, which is worse than either endpoint.
- **Doctrine moves in the same phase**: `tuglaws/focus-language.md` is rewritten, and at0345 inverts, in the steps that change the behavior they pin.

#### Success Criteria (Measurable) {#success-criteria}

- Open Quickly: with an empty query and ≥1 result, ↓ highlights the next result and ↑ the previous, from the first keystroke; typing then deleting back to empty does not change arrow behavior. (New app-test, #step-10.)
- Mode OFF: no element in the deck carries `data-key-view-kbd` at all, and no `[data-key-cursor]` bar or `[data-key-within]` outline paints; a caret-holding editor keeps all four plain arrows regardless of content; two presses of ↑ at a document edge move nothing out of the editor. (Mode-division app-test.)
- Mode ON (⌥⇥): rings paint; Tab/⇧Tab and arrows move the ring; `Space` commits; a text stop **arrived at by engine movement** is ringed with **no caret** until Return or a printable character grants one. (Parked-stop app-test.)
- A text-first surface still opens with a caret: the rename sheet, the resume-sheet filter, and the session question dialog put the caret in their seeded field on open, ring and all. (Parked-stop app-test, second half — [P12] seed rule.)
- One Escape closes a sheet while the caret is in a field inside it — no double-Escape regression. (Escape-ladder app-test.)
- `just hooks-test`-class checks: `cd tugdeck && bun test` green, `bunx vite build` clean, and the selective app-test run derived by `just app-test-changed` green at phase end.

#### Scope {#scope}

1. The derived KBF mode bit in the focus engine, its `data-kbf` projection, and the `kbf: false` trap flag.
2. Manual engagement (⌥⇥, Escape rung, pointerdown-clears, printable/Return grants on parked stops) and the promotion of `useCycleMode` mechanics to the general mechanism.
3. The ring gate: the projection withholds the `data-key-view-kbd` paint flavor in mode OFF, and one `html:not([data-kbf])` suppression covers the cursor bar and the within mark; `persistentDefaultRing` exempt.
4. The list-attached-field contract, adopted by every `TugFilterField` consumer and by Open Quickly.
5. Deletion of `arrow-release.ts`, the `data-tug-arrow-release` channel, the boundary latch, `onArrowExit`, `onTabWhenEmpty`, `enterAt`/`enterToward`, and the arrow repeat gating.
6. Class-A (trap-derived) and Class-B (per-card declared) auto-engagement, with accessibility mode permanently engaged.
7. Doctrine surgery on `tuglaws/focus-language.md` (+ a sweep of the other laws) and the app-test/unit-test rework.

#### Non-goals (Explicitly out of scope) {#non-goals}

- No changes to the spatial plane, `rowGridOrder`, seams, the liveliness net's *mechanics*, cursor handles, descended row scopes (`handleListKey`), `place()`, the gesture interpreter, or the projection/watchdog/steal-ledger machinery — all survive untouched per the brief's "What this deletes".
- No changes to accelerators, chords, menus (beyond the one new item), or the responder chain: ⌘F, ⌘S, ⌘., Escape-to-dismiss are identical in both modes. KBF governs movement, not commands.
- No deck-edge tint or status glyph for the mode cue — the rings are the cue (DECIDED in the brief, D5).
- No hunk navigation for the diff card (revisit only if it grows furniture; brief Q6).
- No reopening of the tabled focus-walk/ring chord subsystem (see memory: keyboard focus nav tabled) beyond what this brief's decisions require.

#### Dependencies / Prerequisites {#dependencies}

- [dash/kbf-mode-brief.md](kbf-mode-brief.md) — the decided design; this plan cites its D1–D7 and Q1–Q7 by those labels.
- `tuglaws/focus-language.md`, `tuglaws/tuglaws.md` ([L02][L03][L06][L22]), `tuglaws/list-view-usage.md`.
- The app-test harness (`just app-test-changed`, `@covers` declarations — see `tests/app-test/README.md`).

#### Constraints {#constraints}

- Rust-workspace warnings-are-errors does not apply here, but tugdeck must pass `bunx vite build` (the debug app loads the prod rollup bundle) and `bun test`.
- [L01]–[L06], [L22]: no second `root.render`, external state via `useSyncExternalStore` only, layout-effect registration, appearance via CSS+DOM, engine structure never mirrored into React state.
- No `localStorage`; any persisted preference rides tugbank defaults (none is planned — the mode bit is session-transient by design).
- App-tests: selective runs via `@covers`; never the full corpus.

#### Assumptions {#assumptions}

- The brief's auto-engagement inventory (verified by sweep 2026-08-10) is current; #step-2 re-verifies the trap call-site list before wiring the flag.
- `useFocusTrap`'s `trapped` default (`true`, no call site passes it explicitly) still holds — the `kbf` flag is a new orthogonal option, not a change to `trapped`.
- at0248/at0277/at0282 stay green with KBF force-engaged at test start; if they don't, the mode division has leaked into the descend machinery and that is a bug in the implementation, not the tests.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

All seven brief-level questions were resolved by the owner on 2026-08-10 and are recorded in the brief's closing section with groundings; this plan restates them as decisions [P07] (Tab in OFF, brief Q1), [P05] (persistence across activation, brief Q2), [P04] (persistentDefaultRing, brief Q3), [P09] (⌥⇥ in forced modes, brief Q4), [P10] (Jots/diff dispositions, brief Q5/Q6), and [P11] (menu discoverability, brief Q7). No open questions remain.

**Where this plan amends the brief.** Four decisions are narrower or differently-mechanized than the brief's wording, each because the brief's wording does not survive contact with the code. They are amendments, not reopenings — the brief's intent is preserved in every case, and each is argued at its decision:

| Brief | Plan | Why |
|---|---|---|
| Q1: "with a live caret, Tab belongs to the text surface" | [P07]: multi-line surfaces own Tab; a single-line `INPUT` spends it on movement | a plain `<input>` has no Tab meaning, so the brief's rule plus never-fall-through makes Tab a dead key — and takes Open Quickly's own directory switcher out of reach |
| D1: "Every ring rule in `focus-ring.css` gains that attribute as a gate" | [P04]: the projection withholds `data-key-view-kbd`; two suppressions cover the rest | an ancestor-prefix gate raises the leaf rule above every item-group suppression and repaints the "double ring" the language spent three attempts removing ([R04]) |
| D4: a text stop while engaged is parked | [P12]: parked when *arrived at by movement*; seeded stops and accessibility mode grant | an unqualified rule opens every text-first sheet in the app ringed and caret-less, and strands assistive tech with no caret anywhere |
| Class A: "any `useFocusTrap` push is the auto-engager" | Spec S01: any **trapped** mode entry | `pushFocusMode` also carries non-trapped descend scopes, which are navigation, not surfaces |

#### [Q01] Attached-list commit gesture (DECIDED per-site) {#q01-attached-list-commit}

**Question:** When ↑/↓ drive an attached list from a caret-holding field, what commits the cursored row?

**Resolution:** DECIDED — the field's existing commit gesture per site: Open Quickly's `Enter` commits the highlighted item (already in `tug-completion-popup.tsx`'s `onKeyDown`); a `TugFilterField` site keeps `Return` meaning what its delegate says today. The contract ([P08], Spec S02) carries only cursor movement; commit stays the surface's.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Parked-stop grant transitions (printable/Return/click) regress WebKit focus | high | med | idempotent grants ([R01]), IME gating, at-suite coverage | any watchdog steal ledger entry naming the entry shell |
| A text-first surface opens with no caret | high | med | the seed rule ([P12]): only engine *movement* parks; a seed / explicit placement grants | any sheet whose field needs a keystroke before it types |
| Escape ladder rung misordered | high | med | explicit rung spec (Spec S04) + escape-ladder app-test before ship | a sheet needing two Escapes |
| Ring gate misses a paint site | med | low (was med) | the projection withholds the flavor rather than the CSS out-selecting it ([P04], [R04]); one suppression for the two marks that stay stamped | a ring painting in mode OFF |
| A `data-key-view-kbd` probe reads absent where a test expected focus | med | high (by design) | the flavor now *means* "a ring is painted"; position probes move to `[data-key-view]` (#step-10) | any at-suite asserting focus position in a mode-OFF surface |
| Future trap becomes a KBF surface unintentionally | med | high (by design) | `kbf: false` flag exists from day one ([P03]) | next typing-first HUD |

**Risk R01: The parked text stop is where the implementation risk lives** {#r01-parked-stop}

- **Risk:** Parking (ring, blurred editor, no DOM grant) was removed once because caret-less states bred illegal rings and focus drift; the transitions back *into* typing are `.focus()` grants and each must be idempotent and IME-safe.
- **Mitigation:** Parking never focuses a *text* surface — it routes the stop `engine-routed`, and realization parks the sink. Note that `parkKeySink()` **is** a focus write: it focuses the sink element and thereby blurs the editor. What parking avoids is WebKit's blur-on-re-focus hazard on the editor itself (focus-language, "Grants are idempotent"); what it incurs is a blur, which puts it under [L23] — the re-grant must land the caret where it was, and `grantTextSurface`'s idempotency guard (focus-manager.ts, the "surface ALREADY holds DOM focus" branch, written for exactly CM6's caret-normalizing focus path) is what keeps that true. The printable-grant path fires only on `!event.isComposing`, no ⌘/⌃ modifiers, `event.key.length === 1`, and grants focus synchronously inside the capture keydown so the browser's own text insertion lands in the newly focused editor — no synthetic re-dispatch. Return rides the existing Return-descend grant.
- **Residual risk:** dead-key/IME edge sequences on the first character typed into a parked stop; covered by a manual pass with a non-Latin input source before phase close. CM6 selection across a park/re-grant round trip is checked in #step-6's app checkpoint.

**Risk R02: Escape ladder precedence** {#r02-escape-ladder}

- **Risk:** The KBF-disengage rung landing above any dismissable surface makes Escape stop closing things — the most user-visible possible regression.
- **Mitigation:** The rung is specified as the *last* branch of the existing act-dispatch Escape ladder in `responder-chain-provider.tsx` (the branch list at its "single Escape ladder" comment): `onEscapeDismiss` surfaces first, non-trapped ascends, `escapeExits` cycles, and only then a bare `manuallyEngaged` clear. Covered by the escape-ladder app-test in #step-10.
- **Residual risk:** third-party (Radix) layers consuming Escape before the document ladder — unchanged from today.

**Risk R03: Mode OFF hides every ring some surface leaned on** {#r03-ring-dependents}

- **Risk:** A surface that used a resting ring to explain itself looks wrong in mode OFF.
- **Mitigation:** `persistentDefaultRing` / `data-default-ring` is exempt from the gate ([P04]) — it is a promise about Return, not a focus mark, and it rides its own attribute, so neither the withheld flavor nor the suppression list touches it. The brief found every current site but two is a Class-A auto-engaging surface; the residuals (session entry's own `data-tug-entry-default` promotion, session-history view) get a visual check in #step-5.
- **Residual risk:** none identified beyond the visual check.

**Risk R04: The ring gate as a CSS ancestor prefix would invert the cascade** {#r04-css-specificity}

- **Risk:** The obvious spelling of the gate — prefixing `[data-key-view-kbd]` with `html[data-kbf]` — takes the leaf-ring rule from (0,1,0) to (0,2,1) and so *above* every item-group suppression that exists to defeat it: `.tug-list-view[data-key-view-kbd] { outline: none }` and its siblings (`tug-choice-group.css`, `tug-option-group.css`, `tug-tab-view.css`) are (0,2,0) and win today on specificity alone. Gating that way paints a leaf ring on every group key view — the "double ring" failure `focus-ring.css` records as three separate failed attempts — and ties `html[data-app-active="false"]` at (0,2,1), reintroducing exactly the source-order fragility that rule's comment exists to prevent.
- **Mitigation:** Do not raise any painting rule's specificity. [P04] gates at the **projection** (the flavor is never stamped in mode OFF, so ~40 component selectors keyed on `[data-key-view-kbd]` stop matching with no cascade change at all) and suppresses the two remaining marks with a rule anchored on `html` in the established `data-app-active` shape.
- **Residual risk:** a future component painting from `[data-key-cursor]`/`[data-key-within]` through a pseudo-element the suppression does not name; the #step-5 sweep is written to look for `::before`/`::after` marks specifically, not just `outline`.

---

### Design Decisions {#design-decisions}

#### [P01] The mode bit lives on the FocusManager coordinator, derived, deck-global (DECIDED) {#p01-engine-bit}

**Decision:** `FocusManager` (the coordinator class in `tugdeck/src/components/tugways/focus-manager.ts`) gains a private `kbfManuallyEngaged: boolean` and a public derivation `kbfEngaged(): boolean` = `accessMode === "accessibility" || kbfManuallyEngaged || autoEngagingSurfaceActive()`. Consumers read it through the manager's existing `subscribe` channel (`useSyncExternalStore` in React, direct reads in the ladder).

**Rationale:**
- Brief D1: derived, not raw — a sheet closing can never strand the mode, because auto-engagement is implied by presence, never latched.
- Brief Class C: accessibility keyboard-access mode (`keyboardAccessStore.getMode() === "accessibility"`, already mirrored into the manager via `setKeyboardAccessMode` in `responder-chain-provider.tsx`) is **permanently engaged** — it belongs in the derivation itself, non-negotiable.
- [L02]/[L22]: engine structure, single source of truth, never mirrored in React state.

**Implications:**
- `autoEngagingSurfaceActive()` reads (a) the **active context's** focus-mode stack for any pushed entry whose `kbf !== false` (Class A — traps pushed on background cards do not engage), and (b) the key card's `CardRegistration.kbfAtRest === true` declaration (Class B).
- Every mutation path that can change the answer (mode push/pop, key-card change, manual toggle, access-mode change) already calls `reproject()`/notifies; the derivation makes those notifications carry the mode too.

#### [P02] Projection: one attribute, `data-kbf` on `<html>` (DECIDED) {#p02-projection}

**Decision:** `FocusManager.applyProjection()` (focus-manager.ts, the diff-then-write convergence pass that already writes `FOCUS_MODE_ATTRIBUTE` onto `document.documentElement`) gains a `data-kbf` write: present (empty value) when `kbfEngaged()`, absent otherwise. `FocusProjection` gains the corresponding boolean from `computeProjection()`.

**Rationale:** Brief D1 "Projection: one attribute", [L06] appearance via CSS+DOM; riding the existing pass keeps state-driven convergence (any reproject heals drift) and gives the watchdog the mark for free.

**Implications:** No component reads the mode in React for appearance. `data-kbf` is the mode's public mark — what CSS selects on it is `html:not([data-kbf])` suppressions ([P04]), never a prefix that raises a painting rule's specificity ([R04]); the ring's own trigger is withheld at the projection instead.

#### [P03] Auto-engagement is derived from the trap; `kbf: false` is the escape hatch (DECIDED) {#p03-trap-flag}

**Decision:** `pushFocusMode` options (focus-manager.ts) and `UseFocusTrapOptions` (`use-focus-trap.tsx`) gain `kbf?: boolean` (default engage). `TugCompletionPopup` (`tug-completion-popup.tsx`, its `useFocusTrap({ active: true, onEscapeDismiss })` call) passes `kbf: false` — the one exempt trap today.

**Rationale:** Brief Class A: any `useFocusTrap` push is the auto-engager, so the enumeration (TugSheet, TugAlert, TugPopover/TugConfirmPopover, TugContextMenu, TugEditorContextMenu, internal TugPopupMenu, session question/permission dialogs, app-test ask dialog, Settings chord capture) needs no per-surface list to maintain. The flag must exist from day one or the next typing-first HUD reproduces the Open Quickly bug exactly (brief Risk 4).

**Implications:** The Settings ▸ Keyboard chord capture stays an ordinary engaging trap; its armed capture must be able to record ⌥⇥ itself, which works because the chord-capture guard in `captureListener` (`chordCaptureState.isArmed()`) runs before any KBF gesture handling.

#### [P04] The ring gate is the projection, not a CSS prefix; `data-default-ring` is exempt (DECIDED) {#p04-css-gate}

**Decision:** Two mechanisms, in this order:

1. **`data-key-view-kbd` is withheld in mode OFF.** `computeProjection()` (focus-manager.ts) already derives the paint trigger as `keyViewKbd: state.keyViewKeyboard || this.ringFollowsPointer`; it gains `&& this.kbfEngaged()`. `focus-ring.css`'s own header calls this attribute "**One trigger**", and it is exactly that: a pure paint signal, not a position record. The *unflavored* `data-key-view` is untouched, so every behavioral reader (`deliverToEngineLeaf`'s `querySelector("[data-key-view]")`, the watchdog, `arrowReleaseSubject`'s `inKeyView` containment while it still exists) sees no change.
2. **One suppression for the two marks that stay stamped.** `[data-key-cursor]` and `[data-key-within]` keep carrying position and containment truth in both modes — 27 and several app-tests respectively read them as structure — so their *paint* is suppressed rather than their attribute withheld, in `focus-ring.css`, anchored on `html` in the same shape (and for the same documented specificity reason) as the existing `data-app-active` rule:

```css
html:not([data-kbf]) :is([data-key-cursor], [data-key-within]) {
  outline: none;
  background-image: none;
}
/* The movement cursor's bar is a generated pseudo-element, which no outline
   suppression reaches (`tug-list-view.css`, `tug-accordion.css`). */
html:not([data-kbf]) [data-key-cursor]::before {
  content: none;
}
```

`[data-default-ring]` (the `persistentDefaultRing` treatment in `internal/tug-button.css`) is exempt from both mechanisms — it rides its own attribute and paints in both modes (brief Q3: a promise about Return, not a focus position).

**Rationale:** Brief D2 ("No focus ring is painted anywhere" in OFF) + D3 (rings ⇔ engaged). The rejected spelling — an `html[data-kbf]` ancestor prefix on the paint rules — is a cascade inversion, not a gate: see [R04]. Withholding the flavor also means the gate cannot *miss* a rule: the ~40 selectors keyed on `[data-key-view-kbd]` across ~20 component stylesheets (`tug-sheet.css`, `tug-alert.css`, `tug-popover.css`, `tug-switch.css`, `tug-value-input.css`, `tug-list-row.css`'s `:has()` selection tints, `lens-section-band.css`, `jots-card.css`, the item-group suppressions) all stand down at once, with their relative specificities exactly as they are today.

**Implications:**
- Per-component suppressions are untouched, because nothing about the cascade changes.
- `data-key-view-kbd` now *means* "a ring is painted here". An app-test using it as a position probe in a mode-OFF surface must move to `[data-key-view]` (#step-10 does this sweep; 60 app-test files reference the attribute today).
- Withholding is a projection write like any other, so the watchdog heals it and [L06] holds — no component reads the mode in React.
- The `[data-cycling="false"]` ring-suppression block in focus-ring.css is subsumed and deleted (#step-5); the `[data-cycling="true"]` submit-fill stand-down rules in `tug-prompt-entry.css`/`tug-entry-shell.css` are re-keyed in #step-3.

#### [P05] `manuallyEngaged` persists across card activation; pointerdown clears it (DECIDED) {#p05-persistence}

**Decision:** The bit is deck-global and survives keyboard-driven card switches (⌘L and friends). A document capture-phase `pointerdown` clears it — the existing mouse-exit rule in `use-cycle-mode.tsx` (its capture `pointerdown` listener) generalized to one provider-level listener. `CYCLE_FOCUS_MODE` keeps `routing: "key-card"` (the toggle still needs the key card to seed the ring), but the bit it flips is the engine's.

**Rationale:** Brief Q2 (persisting is the friendlier answer; pointerdown clears it anyway) and D5's table.

**Implications:** On key-card change while engaged, the engine seeds the new key card's ring (its commit-home / first-in-mode) so the mode never points at nothing.

#### [P06] The deletions land as one step, after the exemption exists (DECIDED) {#p06-deletions}

**Decision:** `arrow-release.ts` (module + `arrow-release.test.ts`), the `data-tug-arrow-release` channel and its CM6 producer (`projectRelease` / `resolveEditorRelease` / the `ViewPlugin` and latch state in `tug-text-editor/keymap.ts`), the boundary latch (`armedEdge`, `LATCH_EDGE`, `EXIT_DIRECTION`, the latch keydown branches), `onArrowExit` (keymap config + every host wire), `onTabWhenEmpty` and the empty-Tab rule, `enterAt`/`enterToward` in `use-cycle-mode.tsx`, and the arrow repeat gating in `arrowNavListener`/`arrowFallbackListener` are all deleted in #step-7, which depends on the attached-list contract (#step-4) and the mode gate (#step-5) landing first.

**Rationale:** Brief "What this deletes" — every one is compensation for the missing parked state; removing half leaves dead doors (a host handoff with no receiver, a release with no reader).

**Implications:** Host wiring to touch: `tug-text-editor.tsx`, `tug-message-editor.tsx`, `tug-prompt-entry.tsx`, `cards/session-card.tsx`, `tug-find-bar.tsx`, `lens-section-band.tsx`, `jots-card.tsx`, `cards/resume-sheet.tsx`, `chrome/session-question-dialog.tsx`, `session-history/session-history-view.tsx` (the grep set for `onArrowExit|onTabWhenEmpty|data-tug-arrow-release|filterFieldDidRequestAdvance` as of 2026-08-10). `keymap-arrow-history.test.ts` keeps its Cmd/Opt-history halves; latch cases are deleted.

#### [P07] Tab in mode OFF: a *multi-line* caret owns it; a single-line field and the nowhere state walk; the engine never yields Tab to WebKit (DECIDED) {#p07-tab-off}

**Decision:** Three cases in mode OFF, resolved structurally — by the *kind* of surface, never by its content:

1. **A multi-line text surface with a live caret owns Tab** — contentEditable / `TEXTAREA`, or anything advertising `data-tug-tab-consume` right now (an open completion). Indent and completion-accept are real Tab meanings and stay unconditional; the empty-Tab handoff dies.
2. **A single-line field (`INPUT`) with a live caret does not own Tab.** A single-line field has no indent and no Tab meaning of its own — a Tab there is a request to leave. It engages KBF and takes one step, exactly like the nowhere case.
3. **The nowhere state** (active card, no caret — a diff card, transcript prose after a stray click) engages KBF and takes one step.

The native-Tab fallback in `focusWalkListener` (`responder-chain-provider.tsx` — today it yields when `advanceKeyViewFocus` returns `false`) is removed: a Tab the engine cannot spend is consumed, never handed to WebKit.

**Rationale:** Brief Q1 — symmetric with ⌥⇥, and the most-tried key always produces a visible landing; the never-fall-through corollary is explicit in the brief. Case 2 is the amendment the brief's phrasing missed: "with a live caret, Tab belongs to the text surface" strands Tab as a **dead key** in every mode-OFF single-line field, because a plain `<input>` has no Tab behavior to belong to it and the engine no longer yields to WebKit. Concretely that would take the directory switcher in Open Quickly — which the brief promises ⌥⇥ and Tab both reach — and the ⌘F find bar's own controls out of keyboard reach entirely. The single-line/multi-line split is a structural predicate (tag kind), not a content predicate, so it is not a reintroduction of the emptiness rule this whole plan exists to delete.

**Implications:**
- The predicate in `focusWalkListener` is: own Tab iff `document.activeElement` is contentEditable, a `TEXTAREA`, or inside `[data-tug-tab-consume="true"]`, or `keyViewConsumesTab()`. Everything else — `INPUT`, no caret, engine-routed — walks, engaging first if `kbfEngaged()` is false.
- `data-tug-tab-consume` handling is unchanged: it is checked before the walk, so a single-line field that genuinely wants Tab (a future field with its own completion) opts back in through the existing channel.
- Never-fall-through applies to subtrees not authored as engine stops too (a portalled third-party layer, a native form). Any such surface must register focusables or its Tab is consumed — a tripwire worth a dev-log warn when the walk is empty (#step-5).

#### [P08] The list-attached field: one declared contract, both modes (DECIDED) {#p08-attached-list}

**Decision:** A text field may declare an attached list. While the caret is in that field, ↑/↓ drive the attached list's cursor and never leave the field, in both modes, regardless of emptiness. Mechanically: the field's wrapper (the element whose inner `<input>` holds focus) carries `data-tug-attached-list`; the document ladder's arrow stages yield vertical arrows whenever `document.activeElement` is inside `[data-tug-attached-list]`; the field's own React `onKeyDown` drives the cursor. Spec S02 has the component API.

**Rationale:** Brief D7 — one rule fixes Open Quickly, covers every `TugFilterField`, and retires `filterFieldDidRequestAdvance` plus the automatic empty-input release.

**Implications:** `TugFilterFieldDelegate.filterFieldDidRequestAdvance` (declared in `tug-filter-field.tsx`) is replaced by cursor-driving methods at its call sites ([P06] lists them). Open Quickly needs nothing beyond the attribute + `kbf: false` — it opens in mode OFF with the caret in the field, and its existing `onKeyDown` finally runs.

**The highlight mark (DECIDED at implementation, #step-4).** An attached list cannot wear `data-key-cursor`: the movement cursor paints only while the keyboard is *in* that list — it never is, the caret is in the field — and [P04] suppresses it outright in mode OFF, which is exactly where an attached list is most load-bearing. So the attached cursor rides `data-attached-cursor`, **exempt** from the mode gate the way `data-default-ring` is, on the same grounds: it is not a focus position, it is a field's statement about which row its next Return means. `TugListView` gains `attachedCursorMove` / `attachedCursorIndex` / `attachedCursorRelease` over an index independent of the movement cursor's.

**Four sites, not five.** `session-history-view.tsx` renders `TugHistoryList` — a plain mapped list with no cursor model and no per-row focus stops — so it has no cursor to attach to. Its `filterFieldDidRequestAdvance` (hand the key view to the list container) remains correct and is the one consumer [P06]'s deletion of that delegate method must spare.

#### [P09] ⌥⇥ inside a forced (auto-engaged) mode returns the keyboard from a typing descend to the ring; it never disengages a forced mode (DECIDED) {#p09-alt-tab-forced}

**Decision:** When `kbfEngaged()` is true and the caret is live (typing descend, brief D6), ⌥⇥ re-engages manually and places the ring back at the stop it left. When the derivation is ON only because a surface forces it, ⌥⇥ never turns the mode off.

**Rationale:** Brief Q4 — the D6 re-engage gesture made uniform.

**Implications:** `toggle` semantics become: engaged-and-ring-live → clear manual (if the derivation then still holds, the keyboard goes to the typing descend's caret only if one exists — otherwise stays); caret-live → set manual + return to ring. The exact state table is Spec S04.

#### [P10] Class-B card dispositions (DECIDED) {#p10-class-b}

**Decision:** `CardRegistration` (`tugdeck/src/card-registry.ts`) gains `kbfAtRest?: boolean`. Auto-engage (true): Lens, Jots (list level; an open jot is a typing descend, Escape ascends to the jot's row — today's behavior, the editor already lives in a non-trapped descend scope with blur-commit in `jots-card.tsx`), Settings (+ its bodies), Keyboard, Gazette, Devtools. OFF at rest (false/absent): Session, Text, File view, Diff (registers no focus stops today; the empty-group rule forbids engaging a surface with nothing to ring), Hello. Gallery cards follow their subject; `gallery-cycle-demo.tsx` becomes the KBF demo.

**Two entries resolved at implementation (#step-2), both by this decision's own empty-group check:**

- **Pulse has no card.** Pulse is the Z2 strip plus `lib/pulse-store` and the DevTools Telemetry tab; there is no `registerCard` for it and therefore no `componentId` to declare. The brief's inability to name it was the correct signal.
- **About is OFF.** `about-card.tsx` renders static text — no `useFocusable`, no Tug control, zero focus stops. Engaging it would be a mode pointing at no ring, which is exactly what put the diff card at OFF.

Settings' panel bodies and DevTools' Log/Telemetry bodies are **tabs of their parent card** (tab `CardState`s carrying sentinel componentIds), not registrations of their own, so one declaration each covers them.

**Rationale:** Brief Class B table + Q5/Q6 resolutions.

**Implications:** The invariant to pin: **every engine-routed stop is reachable only in KBF mode; in mode OFF the keyboard is either in a text surface or nowhere** (brief D3).

#### [P11] Discoverability: a menu item with a decorative chord (DECIDED) {#p11-menu-item}

**Decision:** A "Keyboard Focus" View-menu item fires the toggle, with ⌥⇥ shown as display-only text — *not* registered as an AppKit key equivalent. Mechanically: `menuItemId: "view.keyboardFocus"` on the `CYCLE_FOCUS_MODE` entry in `command-registry.ts` **without** `menuEligible` on its chord (preserving the reason recorded in that entry's comment: a real key equivalent is scanned above every surface that wants a modified Tab, the Settings chord capture among them), plus a Swift-side `NSMenuItem` in `tugapp/Sources/AppDelegate.swift` with `keyEquivalent: ""` and the "⌥⇥" glyph rendered as trailing title text, `.identified("view.keyboardFocus")`.

**Rationale:** Brief Q7, grounded in the existing registry comment and the `menuEligible` promotion mechanics in `keymap-registry.ts`.

**Implications:** Requires `just build-app` to test (tugapp change); the JS side's gate/chord sync (`host-menu-state.ts`) picks the item up by `menuItemId` as usual.

#### [P12] The parked text stop and the both-marks state (DECIDED) {#p12-parked-stop}

**Decision:** While KBF is engaged, **arriving at a text stop by engine movement** parks it: the engine routes it `engine-routed` (sink parked, no DOM grant, no caret) and the ring paints on the input area. Return grants the caret without typing (the existing Return-descend). A printable character clears `manuallyEngaged`, grants the caret, and types the character. While KBF is engaged *and* a caret is live in a stop, the stop wears **both** ring and caret. Rings exist iff KBF is engaged — one sentence, the whole rule.

Two placements are **not** engine movement and therefore **grant**, not park:

- **A seeded or explicitly-placed text stop.** A surface that seeds its own key view onto a field (`useSeedKeyView`) or places the key view at a text stop deliberately is declaring a text-first entry point, and it must open with a caret. This is not a corner case: `rename-session-sheet.tsx` seeds its field and says so in its own comment ("the engine seeds the key view onto the FIELD (caret on open)"), and so do `gallery-sheet.tsx`, `resume-sheet.tsx`, the attachment preview, and the session question / permission dialogs. Every one of them is a Class-A auto-engaging surface, so an unqualified park rule would open every text-first sheet in the app ringed and caret-less. The brief's D4 is about *arrow landings*; parking is scoped to movement accordingly.
- **Accessibility mode.** Class C is permanently engaged, and an engine-routed key view in accessibility mode has real DOM focus mirrored onto the key-view element (`focusKeyView`'s accessibility branch, and `applyProjection`'s re-mirror). Parking a text stop there would mirror focus onto the field's *wrapper* and leave an assistive-tech user with no caret in any field until they typed a character. Parking is disabled outright when `accessMode === "accessibility"`: text stops grant exactly as they do today.

**Rationale:** Brief D4 — this restores the pre-`53233fdc6` parked state and repeals focus-language's "never wears a focus ring" axiom, which the brief traces as the root of the whole compensation network. The two carve-outs preserve the two properties the axiom was protecting that are still true: a text-first surface types immediately, and assistive tech always has real focus on a real widget.

**Implications:** Parking is a change to the **route derivation**, which today is documented as content-free and lives at more than one site. All of them move together (Spec S05): `classifyRoute` (the pure `target.kind` + focus-contract classifier — its "Never a per-call flag: there is no way to author a contradiction" comment must be rewritten, because the mode now is an input), `focusKeyView`'s independent re-derivation of `this.route` from `responderHasFocusContract`, and — the one most easily missed — `focusKeyView`'s `isBareNativeControl` branch, which **grants** any bare `<input>`/`<textarea>` with no contract-bound responder. That branch is exactly the filter-field and HUD class, and it is deliberately symmetric with the watchdog's legality predicate, so park and legality must move as a pair or parking silently fails there while the watchdog calls the resulting focus legal.

`this.route` is a **cache**, recomputed only inside `realizeTarget`/`focusKeyView`. Toggling the mode while a text stop holds the key view leaves it stale, so `setKbfManual`/`toggleKbfManual` and any derivation input change must re-realize the current target (Spec S05), not merely reproject.

at0345 (`tests/app-test/at0345-editor-never-rings.test.ts`) inverts: a parked stop *does* ring; a mode-OFF editor does *not*; and a seeded sheet field rings *and* holds the caret.

---

### Deep Dives {#deep-dives}

#### The document keyboard ladder, as it stands {#ladder-today}

All stages are document capture-phase keydown listeners installed in one layout effect in `tugdeck/src/components/tugways/responder-chain-provider.tsx`, in registration order (the install block near the file's end): `noteKeyboardInput` → `focusWalkListener` (Tab; yields to `data-tug-tab-consume` and to native when the walk is empty) → `arrowNavListener` (spatial plane; consults `resolveArrowRelease(arrowReleaseSubject(document.activeElement), direction)` and drops released-but-repeat presses) → `captureListener` (chords/bindings; `chordCaptureState.isArmed()` guard; Escape-yield to the ladder) → `actDispatchListener` (Space/Enter/Escape; hosts the single Escape ladder: (1) keyViewCaptures, (2) top mode `onEscapeDismiss`, (4) non-trapped ascend, (5) `escapeExits` cycle pop, (3) trapped-no-callback dev-warn) → `keyViewDelegateListener` (`KeyViewBehavior.onKey`) → `arrowFallbackListener` (the liveliness net; second `resolveArrowRelease` consult + repeat gate + `moveKeyViewLinear` + `place()`) → `engineScrollKeyListener` → bubble-phase `bubbleListener`.

KBF's changes to this ladder are surgical: `arrowNavListener` and `arrowFallbackListener` gain a `kbfEngaged()` gate and an `[data-tug-attached-list]` yield and lose their `resolveArrowRelease` consults and repeat gates; `focusWalkListener` gains the engage-and-step path (nowhere state *and* single-line field, [P07]) and loses the native fallback; `keyViewDelegateListener`'s slot gains the printable-grant branch ahead of the delegate (#printable-grant); `actDispatchListener`'s Escape ladder gains rung (6): bare `manuallyEngaged` clear. Everything else is untouched.

#### Engagement, seeding, and the fate of `useCycleMode` {#cycle-promotion}

`useCycleMode` (`use-cycle-mode.tsx`) is **promoted, not deleted** (brief: "What this deletes", last paragraph). What it keeps: the trapped-mode push carrying `commitDisposition` + `escapeExits`, the commit-home seed (`focusFirstInMode` + `focusKeyView`), the resting-focus landing on relinquish (the layout effect watching the engine-derived `cycling` flip), and `CycleScope`. What changes: `toggle()` no longer flips a card-local notion — it calls the new `FocusManager.toggleKbfManual()`, and the card's push/pop rides a subscription to the manager bit, so the deck-global bit and the card's trapped walk cannot desync. What dies: `enterAt`/`enterToward` (both exist only to receive handoffs from a text surface) and the hook's own capture-phase pointerdown listener (generalized to one provider-level listener per [P05]).

Manual engagement on a card **without** a cycle scope (Lens, a Class-B card already engaged, a diff card): the engine seeds `focusFirstInMode()` on the card's current mode and paints. The session card keeps its wiring shape — `CYCLE_FOCUS_MODE` handler on the card-content responder (session-card.tsx, the action map entry near `[TUG_ACTIONS.CYCLE_FOCUS_MODE]`), `restingFocus: () => entryDelegateRef.current?.focus()`, `data-cycling` on the card root — with the handler now calling the manager toggle.

#### The printable-grant mechanics {#printable-grant}

The grant must be synchronous inside the capture keydown so the browser's own text-insertion pipeline (beforeinput → input) lands the character in the just-focused editor — no synthetic event re-dispatch, no clipboard tricks. Placement: a new branch at the top of `keyViewDelegateListener`'s slot (after chords, before the delegate), firing only when: `kbfEngaged()`, the key view is a parked text stop, `event.key.length === 1`, no `metaKey`/`ctrlKey`, and `!event.isComposing`. It clears `manuallyEngaged`, realizes the stop's dom-grant (the same contract grant Return-descend uses), and **returns without preventDefault** — the browser types the character into the newly focused editor. Space is a printable here (it types a space into the field), which takes precedence over Space-commits on a *text* stop only; non-text stops keep Space-commit.

#### Deletion inventory, by file {#deletion-inventory}

| File | What goes |
|---|---|
| `src/components/tugways/arrow-release.ts` | entire module |
| `src/components/tugways/__tests__/arrow-release.test.ts` | entire file |
| `src/components/tugways/tug-text-editor/keymap.ts` | `projectRelease`, `resolveEditorRelease`, the release/latch `ViewPlugin`, `armedEdge` state, `LATCH_EDGE`, `EXIT_DIRECTION`, `onArrowExit` in `TugTextEditorKeymapConfig`, `EditorArrowExitDirection`, all plain-arrow latch keydown branches (Enter/history/gap-fill bindings stay) |
| `src/components/tugways/responder-chain-provider.tsx` | both `resolveArrowRelease` consults + imports, both repeat gates, the native-Tab fallback |
| `src/components/tugways/use-cycle-mode.tsx` | `enterAt`, `enterToward`, the capture pointerdown listener (moved to provider) |
| `src/components/tugways/tug-filter-field.tsx` | `filterFieldDidRequestAdvance` (replaced per Spec S02) |
| hosts (the [P06] list) | `onArrowExit` / `onTabWhenEmpty` / advance wiring |
| unit tests | latch cases of `keymap-arrow-history.test.ts` siblings; any `keymap-editor-release`-named suite |

Before deleting, re-run the grep that produced this inventory (`grep -rln 'filterFieldDidRequestAdvance\|onArrowExit\|onTabWhenEmpty\|data-tug-arrow-release' tugdeck/src`) — the codebase moves.

---

### Specification {#specification}

**Spec S01: The derivation** {#s01-derivation}

```
kbfEngaged() =
     accessMode === "accessibility"                                  // Class C, non-negotiable
  || kbfManuallyEngaged                                              // ⌥⇥ / menu item
  || activeContext.modeStack.some(m => m.trapped && m.kbf !== false) // Class A: traps
  || cardRegistry.get(keyCardComponentId)?.kbfAtRest === true        // Class B: declared cards
```

`m.trapped &&` is load-bearing, and is the correction to the brief's looser phrasing. Class A is "a surface that **traps** the keyboard", not "anything on the mode stack": `pushFocusMode` also carries **non-trapped descend scopes** — a list row scope (`tug-list-view.tsx`) and an accordion section scope (`tug-accordion.tsx`) — which are pushed *while already navigating*, not because a surface appeared. Engaging on those would make a descend an engagement event and would let a mode-OFF card enter KBF by descending. `useFocusTrap` passes `trapped: true` (its default, no call site overrides it), so the enumeration in the brief's Class A table is exactly what this predicate resolves to.

The bit is never stored derived; every read computes. Notification: any mutation of an input notifies the manager's subscribers, calls `reproject()`, **and re-realizes the current target** so the cached keyboard route cannot go stale against the new mode (Spec S05).

**Spec S02: The attached-list component contract** {#s02-attached-list}

- The field component (TugFilterField; Open Quickly's `TugInput` wrapper in `tug-completion-popup.tsx`) stamps `data-tug-attached-list` on the wrapper element that contains the focused `<input>` (containment test in the ladder, same reasoning as `arrowReleaseSubject`'s `inKeyView` containment: the active element is the inner input, the marker rides the wrapper).
- Ladder rule: `arrowNavListener` and `arrowFallbackListener` return early for ↑/↓ when `document.activeElement?.closest('[data-tug-attached-list]') !== null`. Horizontal arrows are unaffected (caret keys).
- `TugFilterFieldDelegate` replaces `filterFieldDidRequestAdvance?(): void` with `attachedListMoveCursor?(direction: "up" | "down"): boolean` (return false = nothing to move, key falls through to the caret). Each of the five sites maps it onto the list it already owns (the Lens section's list cursor handle via `lens-section-content.ts` registration; the picker/resume/history rows likewise). Commit stays per-site ([Q01]).

**Spec S03: `data-kbf` projection and the withheld flavor** {#s03-data-kbf}

`computeProjection()` adds `kbf: boolean`; `applyProjection()` writes/removes the attribute on `document.documentElement` diff-then-write, counting writes like every other mark. The watchdog needs no new class: the attribute is healed by the same reprojection.

In the same pass, `computeProjection()`'s existing `keyViewKbd` derivation gains the mode as a factor ([P04]):

```
keyViewKbd = (keyViewKeyboard || ringFollowsPointer) && kbfEngaged()
```

`applyProjection`'s existing set/remove of `data-key-view-kbd` then does the rest, diff-then-write, with no new branch. `data-key-view`, `data-key-cursor`, `data-key-within`, and `data-default-ring` are stamped exactly as they are today in both modes.

**Spec S04: Gesture × state table** {#s04-gestures}

| Gesture | OFF, caret live | OFF, nowhere | ON (manual), ring on non-text stop | ON, parked text stop | ON (auto), caret live (typing descend) |
|---|---|---|---|---|---|
| ⌥⇥ | set manual; seed key card's commit-home | same | clear manual; caret to card's resting destination | same | set manual; ring returns to last stop ([P09]) |
| Tab | multi-line / tab-consuming surface's (indent/completion); a single-line `INPUT` engages + one step ([P07]) | engage + one step ([P07]) | linear walk (never native) | linear walk | surface's, by the same split |
| ↑/↓ | caret (or attached list) | consumed, no-op | spatial plane + net | spatial plane + net | caret (or attached list) |
| Printable | types | — | (non-text stop: per stop) | clear manual, grant, type ([P12]) | types |
| Return | surface's | — | scope default | grant caret, no text | surface's |
| Space | types | — | commits stop | types (printable rule) | types |
| Escape | ladder as today | ladder | ladder rungs 1–5, then clear manual (rung 6) | same | auto: dismisses surface in one press (rung 2) |
| Pointerdown | — | — | clears manual; click places focus | same | same |

**Spec S05: The park predicate and the route sites** {#s05-park-predicate}

```
parksTextStop(target) =
     kbfEngaged()
  && accessMode !== "accessibility"        // [P12] Class C carve-out
  && targetIsTextContract(target)          // contract-bearing responder OR bare native control
  && arrivalWasEngineMovement              // [P12] seed / explicit placement grants
  && !descendedInto                        // Return / printable / click already granted
```

`arrivalWasEngineMovement` is a property of the **placement**, not of engine state: `moveKeyViewSpatial`, `moveKeyViewLinear`, `focusNext`/`focusPrevious`, and the walk are movement; `useSeedKeyView`'s placement, an explicit `realizeTarget` from a surface, `focusFirstInMode`'s commit-home seed, and a pointer placement are not. Carry it as an option on the placement (alongside `modality`) rather than inferring it — an inference over "did the key view change by one step" is exactly the ambient-predicate class this plan deletes.

Three sites in `focus-manager.ts` derive or consume the route, and all three take the predicate:

| Site | Today | Under KBF |
|---|---|---|
| `classifyRoute(target)` | pure `target.kind` + `responderHasFocusContract` | same, then `parksTextStop` downgrades a `dom-granted` verdict to `engine-routed`. Its "never a per-call flag" comment is rewritten: the mode is a derivation input, and the *placement's* arrival kind is a per-placement input — both are recorded state, not caller opinion. |
| `focusKeyView()`'s re-derivation of `this.route` | `responderHasFocusContract(keyViewId)` | same predicate, same answer — the two must not diverge. |
| `focusKeyView()`'s `isBareNativeControl` grant branch | grants any uncontracted `INPUT`/`TEXTAREA`/`SELECT` | parks it instead when `parksTextStop` holds. Its twin, the coordinator's `isBareNativeControl` legality read behind `legalKeyboardElement`, must agree — grant and legality stay symmetric, or the watchdog blesses a caret the mode says should not exist. |

**Cache invalidation.** `this.route` is recomputed only inside `realizeTarget`/`focusKeyView`. Every derivation input (manual toggle, mode push/pop, key-card adoption, access-mode change) therefore re-realizes the current target after notifying — a bare `reproject()` would repaint the marks while leaving the keyboard routed by the old mode's answer.

#### State Zone Mapping {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| `kbfManuallyEngaged` | structure | `FocusManager` field, mutated imperatively, read via subscribe | [L22], [L02] |
| `kbfEngaged()` (derived) | structure | pure derivation over engine state | [L22] |
| `data-kbf` on `<html>` | appearance | `applyProjection()` diff-then-write | [L06] |
| `kbf` trap flag | structure | `pushFocusMode` option, per mode entry | [L22] |
| `kbfAtRest` | structure | `CardRegistration` static declaration | — |
| `data-tug-attached-list` | structure (a declared contract projected into the DOM for the ladder to read — the same class as `data-tug-tab-consume`, not appearance) | component-stamped DOM attribute, ladder-read | [L24] |
| arrival kind on a placement | structure | placement option, recorded with the target | [L22] |
| ring paint in/out of mode | appearance | withheld `data-key-view-kbd` + one `html:not([data-kbf])` suppression | [L06] |
| caret preservation across park → re-grant | user data | `grantTextSurface` idempotency guard | [L23] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `kbfManuallyEngaged` | private field | `focus-manager.ts` FocusManager | [P01] |
| `kbfEngaged()` | method | `focus-manager.ts` FocusManager | Spec S01 |
| `toggleKbfManual()` / `setKbfManual(v)` | methods | `focus-manager.ts` FocusManager | notify + reproject |
| `kbf?: boolean` | option | `pushFocusMode` opts, `FocusModeEntry`, `UseFocusTrapOptions` | [P03] |
| `kbfAtRest?: boolean` | field | `card-registry.ts` CardRegistration | [P10] |
| `kbf: boolean` | field | `FocusProjection` | Spec S03 |
| `KBF_ATTRIBUTE = "data-kbf"` | const | `focus-manager.ts` | Spec S03 |
| `keyViewKbd` derivation | modified | `focus-manager.ts` `computeProjection()` | `&& kbfEngaged()` — [P04] mechanism 1 |
| `parksTextStop()` | private method | `focus-manager.ts` FocusContext | Spec S05 |
| `arrival?: "movement" \| "placement"` | option | `realizeTarget` / `place()` opts, recorded on the target | Spec S05, [P12] seed rule |
| `classifyRoute` / `focusKeyView` / `isBareNativeControl` branch | modified | `focus-manager.ts` | Spec S05 — the three route sites move together |
| `attachedListMoveCursor` | delegate method | `tug-filter-field.tsx` | Spec S02, replaces `filterFieldDidRequestAdvance` |
| `data-tug-attached-list` | DOM attribute | field wrappers | Spec S02 |
| `"view.keyboardFocus"` | menuItemId + NSMenuItem | `command-registry.ts`, `tugapp/Sources/AppDelegate.swift` | [P11] |

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tests/app-test/at0393-kbf-mode-division.test.ts` | OFF: no `data-key-view-kbd` anywhere, no cursor bar, arrows never move a ring; ON: rings + movement |
| `tests/app-test/at0394-open-quickly-arrows.test.ts` | ↓ selects first result on empty query; Tab reaches the directory switcher ([P07] case 2) |
| `tests/app-test/at0395-kbf-parked-stop.test.ts` | movement-arrived stop: ring + no caret, printable types and lands; seeded sheet field: ring + caret on open ([P12] seed rule) |
| `tests/app-test/at0396-kbf-escape-ladder.test.ts` | one Escape closes a sheet from a caret inside it |

(at0392 is the current highest at-number in `tests/app-test/`; confirm before authoring, the corpus moves.)
| `tugdeck/src/components/tugways/__tests__/kbf-derivation.test.ts` | Spec S01 unit coverage |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** (`bun test`, DOM-free) | the derivation (Spec S01), the park predicate (Spec S05), gesture-policy pure functions | every engine-policy branch |
| **App-test** (real Tug.app) | mode division, Open Quickly, parked stop, Escape ladder, the inverted at0345, rewritten at0341–43 | every user-visible behavior in this plan |
| **Drift prevention** | at0248/at0277/at0282 stay green with KBF force-engaged | descend machinery must be untouched |

#### Blast radius, and the probe migration {#blast-radius}

This phase touches the three most widely-covered files in the deck. As of 2026-08-10: **65** app-test files declare `@covers` on `focus-manager.ts`, **14** on `focus-ring.css`, **5** on `responder-chain-provider.tsx`; **60** files reference `data-key-view-kbd` and **27** reference `data-key-cursor`. Two consequences the plan budgets for rather than discovers:

- The selection `just app-test-changed` derives at #step-11 will be corpus-scale (~70 serialized app launches). That is the correct run and it is expensive; schedule it as the phase's closing act, not as an inner-loop check.
- `data-key-view-kbd` changes meaning ([P04]): it marks a *painted ring*, not a focus position. Any suite using it as a position probe in a surface that is mode-OFF must move to `[data-key-view]`. #step-5 runs this sweep as a survey **immediately after the gate lands**, over the 60 referencing files, so the migration is one bounded pass rather than 70 red results at the end.

#### Survey results (#step-5, measured not predicted) {#probe-survey}

60 app-test files reference `data-key-view-kbd`, 209 occurrences. Rather than classify all 209 by reading, the gate was landed and a representative slice **run**, which converts guesses into facts:

| Suite | Result | Disposition |
|---|---|---|
| at0109-focus-ring | PASS | Tab engages ([P07]), so a gallery ring assertion still sees its ring. This is the load-bearing reason the Tab-engages rule matters: it keeps ~20 component focus suites green. |
| at0127-list-view-cursor | PASS | same |
| at0248-lens-list-cursor-keys | PASS | Class-B card, engaged at rest — and it passes **unmodified**, which is the drift check the plan wanted (no leak into the descend machinery) |
| at0139-cycle-mode-scope | PASS *(after a fix)* | see below |
| at0126-keyboard-ring-cold-boot | **FAIL — position probe** | Both cases assert `data-key-view-kbd` on a restored ring after relaunch, in a gallery card that is not `kbfAtRest`. The mode bit is session-transient by design, so a cold boot lands in mode OFF: the key view is restored, the ring is not painted. Migrate both probes to `[data-key-view]` (#step-10). |
| at0140-cycle-session-card | **FAIL — behavior rewrite** | Its last assertion presses ⌥⇥ from the editor stop (caret granted) and expects `data-cycling="false"`. Under [P09] a live caret makes ⌥⇥ a request to RETURN to the ring, not to exit — so exiting is now a press from a ring position. **at0140 joins at0341/at0342/at0343 on #step-10's rewrite list**; the plan did not list it. |

**A real bug the run caught.** `settleKbfEngagement` gated its *notify* on the derived answer changing, so ⌥⇥ on a card already engaged by its own `kbfAtRest` (the gallery cycle demo) changed the manual bit and told nobody — the card's cycle scope never went up. The manual bit is observable state in its own right; the notify is now unconditional and only the repaint/re-land half is gated on a flip.

The two failures above are the whole predicted blast radius made concrete, and both are the designed consequence rather than a defect. They are left red across #step-6–#step-9 and fixed in #step-10, which is where test rework belongs.

#### What stays out of tests {#test-non-goals}

- jsdom render tests and mock-store assertions — banned pattern (drive real code paths on real content).
- Per-theme ring color assertions — the gate is presence/absence of paint, not hue; transitions poison mid-flight style reads (assert the un-animated property).
- IME dead-key sequences — manual pass before phase close (Risk R01 residual); not automatable in the harness.

---

### Execution Steps {#execution-steps}

> **Commit after all checkpoints pass.** Every commit runs `cd tugdeck && bun test && bunx vite build` at minimum; app-test checkpoints name their files. Commits go directly on `main` (repo convention). New app-tests must carry `@covers` headers (`just app-test-covers-check`).

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Engine bit, derivation, projection | done | `754273ec2` |
| #step-2 | Trap flag + card declarations | done | `14ede3379` |
| #step-3 | Manual engagement gestures | done | `923966c9c` |
| #step-4 | Attached-list contract | done | `b82993a4a` |
| #step-5 | The mode gate: rings and the ladder | done | `a849d166b` |
| #step-6 | Parked text stop | done | `5aec187ad` |
| #step-7 | The deletions | done | `c1aa0c408` |
| #step-8 | Menu item | done | `a0d1d357e` |
| #step-9 | Doctrine surgery | done | `007e57f4f` |
| #step-10 | Test rework + new suites | done | `43ba9c2eb`, `02c6437cb`, `705041e07`, then the follow-on suites (see #close) |
| #step-11 | Integration checkpoint | done | see #close |

> **The per-step hashes above are dead references.** They were commits on the `tugdash/kbf-mode` worktree, which `/join` squashed into a single commit on `main` — **`5d6991087`** — and then removed. They are kept because the round-by-round summaries in the dash log (`tug log`) are still readable by them, and because the ordering tells you what landed with what. To read the shipped state, read `main`.

**#step-10 is partial. What is done, and what is not:**

| Item | State |
|---|---|
| at0126 probe migration (position probe → `[data-key-view]`) | done, green |
| at0140 rewrite (both editor-stop landings park) | done, green 4/4 |
| at0343 latch half replaced by the mode-OFF arrow rule; renamed `at0343-prompt-arrow-history` | done, green 2/2 |
| at0341 / at0342 | pass **unmodified**; only their `@covers` needed repointing off the deleted module |
| at0345 inverted (`at0345-editor-ring-mode-division`) | done in #step-6, green |
| at0396 open-quickly arrows | done, green — the plan's headline regression is proven fixed |
| `just app-test-covers-check` | green across 356 files |
| at0248 / at0277 / at0282 drift check | at0248 verified green unmodified (#step-5); at0277 / at0282 **not yet run** |
| **at0395 mode-division suite** | **not written** |
| **at0397 parked-stop suite** (the [P12] seed half, on a real sheet) | **not written** — the movement half is covered by at0345 |
| **at0398 escape-ladder suite** | **not written** |
| **[P07] case 2: Tab from Open Quickly's field reaches the directory switcher** | **not working.** The switcher IS authored into the popup's focus group at the accessory order and the Tab split routes the key to the walk, but the landing does not arrive. First suspect is the popup's own `onBlur` dismiss guard. Recorded in at0396 as an explicit non-assertion rather than a skipped test. |

**Why this order.** The paint gate and the ladder's mode gate are **one commit** (#step-5), and the attached-list contract lands before them. The alternative — gating the rings first and the movement stages several commits later — ships an app where mode OFF still walks the key view with nothing painted: focus moves invisibly for the length of the phase, which is a worse state than either endpoint and contradicts "every intermediate commit leaves the app working". And the arrow gate cannot precede the attached-list contract, because in mode OFF the session picker's filter reaches its rows today *through* the empty-input release; gating arrows before its replacement exists would break it for a commit.

#### Step 1: Engine bit, derivation, projection {#step-1}

**Commit:** `tugways(kbf): add the derived KBF mode bit and its data-kbf projection`

**References:** [P01] engine bit, [P02] projection, Spec S01, Spec S03, (#ladder-today)

**Artifacts:** `kbfManuallyEngaged`, `kbfEngaged()`, `setKbfManual`/`toggleKbfManual`, `KBF_ATTRIBUTE`, `FocusProjection.kbf`, the `applyProjection()` write; no consumer yet — behavior unchanged.

**Tasks:**
- [ ] Add the field + derivation to `FocusManager` (focus-manager.ts), reading `this.accessMode`, the active context's mode stack (**trapped entries only**, Spec S01), and the key card's registration (import the registry lookup; tolerate an unregistered componentId as `false`).
- [ ] Thread `kbf` through `computeProjection()`/`applyProjection()` per Spec S03 — the `data-kbf` write only; the `keyViewKbd` factor lands in #step-5 with the rest of the gate.
- [ ] Ensure every input mutation notifies, reprojects, **and re-realizes the current target** (mode push/pop, key-card adoption, access-mode set, manual set) — the cached `this.route` must never outlive a mode change (Spec S05).

**Tests:**
- [ ] `__tests__/kbf-derivation.test.ts`: manual on/off; trap with/without `kbf: false`; a **non-trapped descend scope does not engage**; background-card trap does not engage; accessibility overrides everything; `kbfAtRest` card.

**Checkpoint:**
- [ ] `cd tugdeck && bun test && bunx vite build`
- [ ] In the running app (HMR): `document.documentElement.hasAttribute("data-kbf")` is false at rest, true while a sheet is open (verify via TugDevPanel/evalJS).

---

#### Step 2: Trap flag + card declarations {#step-2}

**Depends on:** #step-1

**Commit:** `tugways(kbf): kbf trap flag and per-card kbfAtRest declarations`

**References:** [P03] trap flag, [P10] Class-B dispositions, (#s01-derivation)

**Tasks:**
- [ ] Add `kbf?: boolean` to `pushFocusMode` opts / `FocusModeEntry` / `UseFocusTrapOptions`; default engage.
- [ ] `TugCompletionPopup` passes `kbf: false`.
- [ ] Add `kbfAtRest?: boolean` to `CardRegistration`; declare true on Lens, Jots, Settings, Keyboard, About, Gazette, Pulse, Devtools registrations; leave Session/Text/File-view/Diff/Hello absent. (Find each registration by grepping `registerCard` call sites for the componentIds in the brief's Class-B table. The brief could not name Pulse's `componentId` — resolve it here.)
- [ ] Apply the **empty-group check** to every card declared `true`, the same test that put the diff card at OFF (brief Q6): the card must register at least one focus stop, directly or through Tug components that register their own (a `TugPushButton` counts). A card that auto-engages onto nothing is a mode pointing at no ring.
- [ ] Re-verify the brief's Class-A trap call-site list by grepping `useFocusTrap(` — new call sites since 2026-08-10 get the default (engage) unless typing-first.

**Tests:**
- [ ] Extend `kbf-derivation.test.ts` for the flag and a declared card.

**Checkpoint:**
- [ ] `cd tugdeck && bun test && bunx vite build`
- [ ] App: `data-kbf` present with the Lens as key card; absent with a session card at rest; absent while Open Quickly is up.

---

#### Step 3: Manual engagement gestures {#step-3}

**Depends on:** #step-2

**Commit:** `tugways(kbf): route ⌥⇥, pointerdown-clear, and the Escape rung through the engine bit`

**References:** [P05] persistence, [P09] forced modes, Spec S04, (#cycle-promotion), Risk R02

**Tasks:**
- [ ] `useCycleMode`: `toggle()` calls `toggleKbfManual()`; the push/pop of the card's cycle scope subscribes to the manager bit (push when engaged & key card & has scope; pop + `restingFocus` on disengage). Keep `commitDisposition`, `escapeExits`, `CycleScope`, the relinquish layout effect.
- [ ] Move the mouse-exit capture `pointerdown` listener from `use-cycle-mode.tsx` into the provider (one listener: clears `manuallyEngaged`; the click's own placement then proceeds — preserve the no-caret-flash behavior by popping `moveDomFocus: false` as today).
- [ ] Provider-level default for `CYCLE_FOCUS_MODE` when no card handler claims it: toggle the bit and seed `focusFirstInMode()`. **Verify the fallback actually fires** — the registry entry is `routing: "key-card"` (`command-registry.ts`), and today only the session card and the gallery demo register a handler. If a key-card-routed action does not fall through the chain to a provider-level responder, ⌥⇥ is dead on the Lens and the diff card, which is precisely where the general mode needs it.
- [ ] Key-card change while engaged: seed the new key card's ring (commit-home / first-in-mode) in `adoptKeyCard`.
- [ ] Escape rung (6) in `actDispatchListener`'s ladder: base mode + `manuallyEngaged` → clear it, land the resting destination; sits **below** every existing rung.
- [ ] ⌥⇥ from a typing descend inside a forced mode re-engages to the ring ([P09]); never disengages a forced mode.

**Tests:**
- [ ] Unit: toggle/pointerdown/Escape transitions against Spec S04 where DOM-free; the rest lands in #step-10's app-tests.

**Checkpoint:**
- [ ] `cd tugdeck && bun test && bunx vite build`
- [ ] App: ⌥⇥ on a session card enters the cycle (ring on submit); ⌥⇥ again restores the caret; ⌘L to the Lens with the bit set keeps the mode; a click anywhere clears it.

---

#### Step 4: Attached-list contract {#step-4}

**Depends on:** #step-2

**Commit:** `tugways(kbf): list-attached fields own their vertical arrows in both modes`

**References:** [P08] attached list, Spec S02, [Q01], (#ladder-today)

**Tasks:**
- [ ] Ladder: yield ↑/↓ in `arrowNavListener` and `arrowFallbackListener` when the active element is inside `[data-tug-attached-list]` (before the release consults, which still exist until #step-7).
- [ ] `tug-filter-field.tsx`: add `attachedListMoveCursor` to the delegate; stamp the attribute on the wrapper when the delegate supplies it; field `onKeyDown` claims ↑/↓ through it; delete nothing yet.
- [ ] Adopt at the five sites (`lens-section-band.tsx`, `jots-card.tsx`, `session-card.tsx` picker, `resume-sheet.tsx`, `session-history-view.tsx`): map to each list's cursor.
- [ ] Open Quickly: stamp the attribute on the `TugCompletionPopup` field wrapper so the ladder yields and the popup's existing `onKeyDown` (ArrowDown/ArrowUp/Enter/Escape) finally runs on an empty query.

**Tests:**
- [ ] Unit: field-level policy (delegate present → arrows claimed; absent → untouched) where testable DOM-free.

**Checkpoint:**
- [ ] `cd tugdeck && bun test && bunx vite build`
- [ ] App: Open Quickly, empty query, ≥2 roots — ↓ highlights the first result (not the switcher); Lens filter — ↓ moves the section's row cursor with the caret staying put.

---

#### Step 5: The mode gate — rings and the ladder, in one commit {#step-5}

**Depends on:** #step-1, #step-3, #step-4

**Commit:** `tugways(kbf): rings and movement keys both answer to the mode bit`

**References:** [P04] ring gate, [P07] Tab, Risk R03, Risk R04, (#s03-data-kbf), (#blast-radius)

**Artifacts:** paint and movement stand down together — the point of the single commit is that no shipped state has focus moving invisibly.

**Tasks (paint):**
- [ ] `computeProjection()`: `keyViewKbd = (keyViewKeyboard || ringFollowsPointer) && kbfEngaged()` ([P04] mechanism 1). No CSS specificity anywhere is touched by this.
- [ ] `styles/focus-ring.css`: add the two `html:not([data-kbf])` suppressions from [P04] for `[data-key-cursor]` / `[data-key-within]` and the cursor bar's `::before`. Anchor on `html` for the reason the file's own `data-app-active` comment records.
- [ ] Sweep for paint sites the two mechanisms miss — specifically **pseudo-element** marks, which no `outline` suppression reaches: `grep -rn --include='*.css' 'data-key-cursor\]::\|data-key-within\]::\|data-key-view-kbd\]::' tugdeck/src tugdeck/styles`. Known today: `tug-list-view.css` and `tug-accordion.css` cursor bars, `jots-card.css`'s cell bar, the editor's `::after` key-view border.
- [ ] Delete the `[data-cycling="false"]` suppression block (subsumed — the flavor is now withheld outright in mode OFF) and the `[data-cycling="true"] [data-key-within]` block if the within suppression covers it; verify against the session card cycling visuals first.
- [ ] Leave `[data-default-ring]` / `persistentDefaultRing` (internal/tug-button.css) untouched by both mechanisms; visually check the two mode-OFF residual surfaces: the session entry's `data-tug-entry-default` promotion and the session-history view.

**Tasks (ladder):**
- [ ] `arrowNavListener` / `arrowFallbackListener`: gate the ring stages on `kbfEngaged()`. Mode OFF → the stages no-op (the release consults and repeat gates stay in place until #step-7 deletes them; the gate simply runs first). Mode ON → unchanged.
- [ ] `focusWalkListener` per [P07]: multi-line / `data-tug-tab-consume` surfaces keep Tab; a single-line `INPUT` with a caret, and the nowhere state, engage KBF and take one step; remove the native-Tab yield so a Tab the engine cannot spend is consumed.
- [ ] Dev-log warn (never a user-visible beep) when the walk is empty and the Tab is swallowed — the tripwire for a subtree that was never authored as engine stops.
- [ ] Route `advanceKeyViewFocus`'s other callers (the View menu's Next / Previous Keyboard Focus) through the same engage-and-step so they behave in mode OFF.

**Tasks (probe survey — do it here, while the change is one commit):**
- [ ] Grep the 60 app-test files referencing `data-key-view-kbd` and classify each use: *ring assertion* (keep — and it now also asserts the mode) vs *position probe* (migrate to `[data-key-view]`). Record the list; the migrations themselves land in #step-10.

**Tests:**
- [ ] Unit: the nowhere / single-line / multi-line Tab predicate; the projection's `keyViewKbd` factor.

**Checkpoint:**
- [ ] `cd tugdeck && bun test && bunx vite build`
- [ ] App: no ring anywhere at rest on a session card, and no list cursor bar in a mode-OFF list; rings appear the moment a sheet opens or ⌥⇥ engages; a Lens list still shows its cursor bar (Class-B engaged).
- [ ] App: mode OFF, arrows in the prompt move only the caret; click transcript prose → Tab paints a ring and steps; in the prompt, Tab still indents.

---

#### Step 6: Parked text stop {#step-6}

**Depends on:** #step-3, #step-5

**Commit:** `tugways(kbf): restore the parked text stop; printable and Return grant the caret`

**References:** [P12] parked stop, Spec S05, Risk R01, (#printable-grant), Spec S04

**Tasks:**
- [ ] Implement `parksTextStop()` per Spec S05, including both carve-outs: **accessibility mode never parks**, and a **seeded / explicitly-placed** text stop grants rather than parks.
- [ ] Thread the placement's `arrival` through `place()` / `realizeTarget` and record it with the target; movement performers (`moveKeyViewSpatial`, `moveKeyViewLinear`, `focusNext`/`focusPrevious`, the walk) pass `"movement"`, everything else `"placement"`. Do not infer it.
- [ ] Apply the predicate at **all three route sites** (Spec S05): `classifyRoute` (and rewrite its "never a per-call flag" comment), `focusKeyView`'s re-derivation, and `focusKeyView`'s `isBareNativeControl` grant branch — with the coordinator's `isBareNativeControl` legality read kept symmetric so the watchdog does not bless a caret the mode forbids.
- [ ] Printable-grant branch per #printable-grant (capture stage, synchronous grant, no preventDefault, IME/modifier/length gates); clears `manuallyEngaged`. Return-descend keeps its existing grant path; verify idempotency (the substrate's `view.hasFocus` guard).
- [ ] CSS: the parked stop's ring on the input area (the editor stop's registered element) paints under the #step-5 gate; the both-marks state (ring + live caret while engaged) needs no new rule — verify the editor's own key-view treatment (`::after` border, per the focus-ring.css comment) composes.
- [ ] D6 semantics: after a typing descend, Escape behaves per Spec S04 (manual already cleared → falls through; auto surface → rung 2 dismisses in one press).
- [ ] Invert `tests/app-test/at0345-editor-never-rings.test.ts`: parked stop rings; mode-OFF editor never rings; a seeded sheet field rings *and* carries the caret; rename if its name no longer describes it (keep the at-number).

**Tests:**
- [ ] Unit: `parksTextStop` truth table — movement vs placement, accessibility on/off, contract-bearing vs bare native control, descended vs not.
- [ ] at0345 (inverted) green; falsification check: force a mode-OFF ring and see it red.

**Checkpoint:**
- [ ] `cd tugdeck && bun test && bunx vite build`
- [ ] `just app-test tests/app-test/at0345-*.test.ts`
- [ ] App: ⌥⇥ → arrow onto the editor stop → ring, no caret; type "x" → caret live, "x" in the document, mode manual-cleared.
- [ ] App: open the rename sheet — caret in the field on open, ring painted, typing lands immediately (the seed rule). Same for the resume-sheet filter and a session question dialog with a text field.
- [ ] App: park a stop with a mid-document caret, then re-grant — the selection comes back where it was ([L23], R01).
- [ ] App: with accessibility keyboard-access mode on, every text stop still takes a caret.

---

#### Step 7: The deletions {#step-7}

**Depends on:** #step-4, #step-5, #step-6

**Commit:** `tugways(kbf): delete the release policy, boundary latch, and handoff contracts`

**References:** [P06] deletions, (#deletion-inventory), [P08]

**Tasks:**
- [ ] Execute the deletion inventory table verbatim, re-running its grep first.
- [ ] `arrowNavListener`/`arrowFallbackListener`: delete the release consults and the repeat gates outright — the mode gate landed in #step-5 already does the work, and what remains in mode OFF is the plain "a focused text surface owns its arrows" shape.
- [ ] Remove `filterFieldDidRequestAdvance` from the delegate and all five sites (superseded in #step-4).
- [ ] Delete the latch halves of the keymap unit tests; keep Cmd/Opt history coverage (`keymap-arrow-history.test.ts`).

**Tests:**
- [ ] `bun test` green with the deleted suites gone; no references remain (`grep` returns empty).

**Checkpoint:**
- [ ] `cd tugdeck && bun test && bunx vite build`
- [ ] App: mode OFF — ↑ held at a non-empty prompt's top edge never leaves the editor; empty prompt — arrows still never leave; Lens filter arrows still drive rows (attached list, not release).

---

#### Step 8: Menu item {#step-8}

**Depends on:** #step-3

**Commit:** `tugways+tugapp(kbf): Keyboard Focus menu item with decorative ⌥⇥`

**References:** [P11] menu item

**Tasks:**
- [ ] `command-registry.ts`: add `menuItemId: "view.keyboardFocus"` to the `CYCLE_FOCUS_MODE` entry; do **not** add `menuEligible` to its chord; update the entry's "chord-only, deliberately" comment to record the decorative-chord decision.
- [ ] `tugapp/Sources/AppDelegate.swift`: add the View-menu `NSMenuItem` with `keyEquivalent: ""`, `.identified("view.keyboardFocus")`, title carrying the ⌥⇥ glyph as text (match the file's existing item idiom).
- [ ] `just build-app`.

**Tests:**
- [ ] The command-routing drift test (`__tests__/command-routing-drift.test.ts`) and menus doc test pass with the new `menuItemId`.

**Checkpoint:**
- [ ] `cd tugdeck && bun test && bunx vite build`; `just build-app`
- [ ] App: the menu item toggles the mode; Settings ▸ Keyboard chord capture can still record ⌥⇥ while armed.

---

#### Step 9: Doctrine surgery {#step-9}

**Depends on:** #step-5, #step-6, #step-7

**Commit:** `tuglaws(kbf): rewrite focus-language for the mode division`

**References:** brief "Doctrine surgery" section, [P12], [P04], [P08]

**Tasks:**
- [ ] `tuglaws/focus-language.md`, per the brief's section list: mode division opens "Motion: two planes"; delete the boundary-latch paragraph, both empty-field-spends rules, the landing-grants rule, the never-wears-a-ring rule and its "the box, not the DOM node" corollary, and "Crossing out is always a discrete press"; rewrite "Three carriers" (wash keeps its job; ring absence in OFF is the rule); strengthen "plain arrows are caret keys" (unconditional in OFF; Cmd-history unaffected); **keep the three-in-a-row failure history as a note** explaining why the old rule existed and why the mode retires it; contract table gains the `data-kbf` gate row; authoring contract gains the attached-list contract and the `kbf: false` flag.
- [ ] Record the two rules an author cannot derive from the mode sentence alone: **a seeded text stop grants, a moved-to one parks** ([P12]), and **`data-key-view-kbd` means a painted ring, not a focus position** ([P04]) — the latter belongs in the contract table beside the attribute.
- [ ] Note the Tab split ([P07]): multi-line surfaces own Tab, single-line fields spend it on movement, and the engine never hands Tab to WebKit.
- [ ] Sweep the other laws for invalidated statements — `tuglaws/list-view-usage.md` (amended by `53233fdc6`) at minimum; `component-authoring.md` and `design-decisions.md` cross-references.
- [ ] No hard-wrapped prose.

**Tests:** none (doc step).

**Checkpoint:**
- [ ] A grep of `tuglaws/` for "boundary latch", "arrow-release", "onArrowExit", "onTabWhenEmpty", "enterAt" returns only historical notes that identify themselves as such.

---

#### Step 10: Test rework + new suites {#step-10}

**Depends on:** #step-5, #step-6, #step-7

**Commit:** `app-test(kbf): mode-division, open-quickly, parked-stop, and escape-ladder suites; arrow suites rewritten`

**References:** brief "Test impact", (#new-files), (#blast-radius), [P04], [P07], [P08], [P12], Risk R02

**Tasks:**
- [ ] Work the probe-migration list produced by #step-5's survey: every *position* probe on `data-key-view-kbd` in a mode-OFF surface moves to `[data-key-view]`; every *ring* assertion stays and now doubles as a mode assertion.
- [ ] Rewrite `at0341-lens-cross-section-arrows`, `at0342-picker-arrow-traversal` (KBF engaged at start where they exercise ring motion), `at0343-prompt-arrow-latch-history` (latch half deleted; Cmd-history half kept), and — added by #step-5's survey — `at0140-cycle-session-card`, whose ⌥⇥-from-the-editor-stop exit becomes a return-to-the-ring under [P09].
- [ ] Migrate `at0126-keyboard-ring-cold-boot`'s two probes from `data-key-view-kbd` to `[data-key-view]`: a cold boot restores the key view but not the mode, so the ring is correctly unpainted (#step-5 survey).
- [ ] Run `at0248-lens-list-cursor-keys`, `at0277-lens-row-accessories-keyboard`, `at0282-lens-row-arrow-escape` with KBF force-engaged at test start; they must pass unmodified — a failure is an implementation leak into the descend machinery, fix the code not the test.
- [ ] Author the four new suites from #new-files (at0393–at0396, confirming the highest at-number first; `@covers` headers pointing at `focus-manager.ts`, `responder-chain-provider.tsx`, `tug-completion-popup.tsx`, `tug-filter-field.tsx` as appropriate).
- [ ] `just app-test-covers-check`.

**Tests:** the step *is* tests.

**Checkpoint:**
- [ ] `just app-test <the four new files> tests/app-test/at0341-*.test.ts tests/app-test/at0342-*.test.ts tests/app-test/at0343-*.test.ts tests/app-test/at0345-*.test.ts tests/app-test/at0248-*.test.ts tests/app-test/at0277-*.test.ts tests/app-test/at0282-lens-row-arrow-escape.test.ts`

---

#### Step 11: Integration checkpoint {#step-11}

**Depends on:** #step-8, #step-9, #step-10

**Commit:** `N/A (verification only)`

**References:** (#success-criteria), (#exit-criteria), (#blast-radius)

**Tasks:**
- [ ] `just app-test-changed` over the phase's full diff; run what it selects. Expect a corpus-scale selection (~70 serialized launches — see #blast-radius) and budget for it as a single closing run, not an inner-loop check.
- [ ] Manual pass: the Spec S04 table row by row on a real session card + Lens + one sheet; the IME first-character check (Risk R01 residual) with a non-Latin input source.
- [ ] Manual pass with accessibility keyboard-access mode on: every text stop takes a caret, every engine-routed stop still mirrors real focus ([P12] Class C carve-out).
- [ ] Verify the D3 invariant by inspection: no engine-routed stop reachable in mode OFF.

**Checkpoint:**
- [ ] `cd tugdeck && bun test && bunx vite build`
- [ ] `just app-test-changed` — VERDICT green.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** KBF mode shipped: a derived, engine-owned, `data-kbf`-projected keyboard-focus mode with manual (⌥⇥/menu) and derived (trap/card/accessibility) engagement, the parked text stop, the list-attached-field contract, the deletion of the three ambient mechanisms, and matching doctrine + tests.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Every #success-criteria bullet verified by its named test or check.
- [ ] `arrow-release.ts` and the boundary latch no longer exist; grep for the deletion inventory returns empty.
- [ ] `tuglaws/focus-language.md` describes the shipped model; the old axiom survives only as a history note.
- [ ] Step Status Ledger fully `done` with commit hashes.

#### Phase close — #step-10 finished, #step-11 run {#close}

*2026-08-11, from the KBF audit. This section supersedes the "not written" rows in the #step-status-ledger note and the checkpoint table below it; both are left standing because they record what was true at handoff.*

**One real defect found, and it is the one the handoff could not have found by reading.** The paint moved onto the keyboard route when [the paint-route division](../tuglaws/focus-language.md#kbf-paint-route) landed; the **movement** stages did not follow. `arrowNavListener` still gated on `kbfEngaged()`, so in the one state the division exists to describe — mode engaged, caret granted, marks standing down — the engine kept steering wherever a surface declared a spatial order. Measured on the question dialog: typing in the free-text answer field, ↓ carried the ring off to a button and took the caret with it, and the ↑ back left the stop *parked*, so a user mid-sentence could not type. Nothing painted at the moment of the theft.

The fix is [P07]'s split applied to the arrow plane — horizontal arrows belong to any caret, vertical arrows belong to a multi-line surface — and it is structural, by the kind of surface, not by the mode and not by the content. Doctrine updated at "Arrow ownership"; pinned by **at0402**, which was watched red before it was watched green (a reverse-patch probe of the fix reproduces the theft exactly).

**The proof surface had to be rebuilt before it could be run.** at0397 (paint route), at0398 (chord ring), and at0399 (shade focus) were deleted within days of landing — at0397/at0398 graded as pixel cosmetics, which reads their instrument rather than their subject — while `tuglaws/focus-language.md` went on citing all three as "Pinned by". All three are restored and pass unmodified; `ACCEPTED_FANOUT` for `focus-manager.ts` went 26 → 29 to carry them and at0402. The reasoning is in [app-test-audit.md](app-test-audit.md#correction-kbf). Four suites whose deletion stands (at0202, at0203, at0204, at0251) are now named **unpinned** in the doctrine instead of cited as cover.

**`bun test` was red on `main` for a day.** `kbf-derivation.test.ts`'s ⌥⇥-over-a-caret case still encoded pre-`parkAtKeyView` semantics: it asserted the second press returns `true`, when the whole point of the park is that it flips the route and makes the second press the toggle's other half. The code was right, the test was stale, and no commit in that window ran the suite the plan requires on every commit.

**The transitions inventory dropped its line numbers.** Half of them had drifted six to seventy-five lines within a day. Sites are now named by file and symbol, which is what the inventory's own audit `grep` matches on anyway.

**#step-11, run 2026-08-11.** The selection derived from the phase's source diff is **90 files** — the selector refuses a scoped run over 20, so it was run as three explicit batches. Result: **88 green, 2 red, neither from this work** — both reproduce identically with the KBF change reverse-patched out, and neither is a focus suite:

| suite | state |
|---|---|
| `at0210-text-card-options` (1/2) | the options menu never mounts. Recorded known-red in the continued brief before this work, so this one is genuinely pre-existing |
| `at0357-content-width-default` (1/2) | a pane content-width assertion (412 vs 320). **Not attributed further:** uncommitted `layout-imposer.ts` / `deck-manager.ts` work by another writer was live in the tree during the run, which is exactly this assertion's subject. It is not KBF's, and whether it is `main`'s or that work's is for whoever owns those bytes to settle — the reverse-patch probe only clears this phase |

Green alongside them: every focus suite the phase touches, including the drift set (at0248 / at0277 / at0282 unmodified), the two that were red at the continued brief's writing (at0223, at0224), at0339, and the whole harness smoke tier. `bun test` 6416 pass / 0 fail, `tsc --noEmit` clean, `vite build` clean, `app-test-covers-check` green.

**What is still owed, and is deliberately not blocking:** the two manual passes the plan named as residual risks — the IME first-character check with a non-Latin input source ([R01]), and an accessibility-keyboard-access pass confirming every text stop still takes a caret ([P12] Class C). Neither is automatable in the harness; Class C remains the least-covered carve-out in the model.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] `gallery-cycle-demo` → full KBF gallery demo with copy explaining the mode.
- [ ] Diff-card hunk navigation (would flip it to auto-engage; brief Q6's revisit trigger).
- [ ] Reopening the tabled focus-walk chord subsystem, if ever, now on top of a real mode.

| Checkpoint | Verification |
|------------|--------------|
| Open Quickly regression dead | open-quickly app-test — **shipped as at0396**, green |
| Mode division holds | mode-division app-test — **at0395, not written** |
| Text-first surfaces still open with a caret | parked-stop app-test — **at0397, not written**; the *movement* half is covered by at0345 |
| No double-Escape | escape-ladder app-test — **at0398, not written** |
| Full phase | `just app-test-changed` VERDICT — **not run** |

---

## Addendum — implementation handoff (2026-08-10) {#addendum}

*Written at the end of the implementation run, for the session that picks this up. Everything below is either state you need or something that cost real app-test runs to learn. The plan body above is unchanged except where it says DECIDED-at-implementation; this section is the delta between "the plan" and "what is actually true on disk."*

### Where the work is {#addendum-state}

**Steps 1–9 are shipped on `main` as `5d6991087`** (squash-landed from `tugdash/kbf-mode`, which is gone). The tree is clean. There is no dash to resume — start follow-up work from `main`, on a new dash if you want one.

Step 10 is **partial** and step 11 is **not started**. The per-item state is in the ledger note under #step-status-ledger; the work list below is the same information ordered for doing rather than for auditing.

Verification commands that were green at hand-off (run from the repo root unless noted):

```bash
cd tugdeck && ./node_modules/.bin/tsc --noEmit     # clean
cd tugdeck && bun test                             # 6349 pass, 424 files
cd tugdeck && bunx --bun vite build                # clean
just app-test-covers-check                         # green, 356 files
just app-test tests/app-test/at0345-*.test.ts tests/app-test/at0396-*.test.ts \
              tests/app-test/at0140-*.test.ts tests/app-test/at0343-*.test.ts \
              tests/app-test/at0126-*.test.ts      # all green at hand-off
```

Use `./node_modules/.bin/tsc`, not `bunx tsc` — a bare `bunx tsc` from the wrong directory installs TypeScript 7 into a cache and type-checks nothing you care about.

### The work list {#addendum-work}

Ordered by value. (0) and (1) were filed as real broken behaviors — (0) was one, (1) turned out to be a missing precondition in the diagnosis rather than a defect; (2)–(4) are missing proof of behavior that is believed working; (5)–(6) are the closing checks; (7) is what the first two turned up on the way past.

#### 0. A parked text stop paints no ring — the old suppressions were never converted {#addendum-editor-ring}

**Reported from the app, 2026-08-10:** ⌥⇥ then Tab through the prompt entry, and no ring ever lands on the composer's editor. The engine is right and the paint is wrong.

The engine half works and is already pinned: the composer's editor registers a real stop (`tug-text-editor.tsx`'s `useFocusable` under the responder id, opted in by `TugPromptEntry`'s `editorFocusGroup`/`editorFocusOrder`), the walk lands on it, and `computeProjection` stamps `data-key-view-kbd` on the editor host. at0345 case 4 walks Tab to that stop and finds the attribute.

Nothing paints, because two blanket suppressions written under the pre-KBF axiom survived the phase:

- `tug-text-editor.css` — `.tug-text-editor:is([data-key-view-kbd], [data-key-cursor], [data-key-within]) { outline: none; background-image: none; }` at (0,3,0), beating the global ring rule in every key state. Its comment states the old axiom outright ("a text editor NEVER wears a ring") and closes with "Pinned by at0345: no `.tug-text-editor` anywhere in the deck may compute a visible outline."
- `tug-entry-shell.css` — the same kill on `.tug-entry-shell-input-area`, under a banner reading "There is no caret-less keyboard state left to carry."

That banner names exactly the state [P12] reinstated. The suppressions are now simply false, and they no longer earn their keep even for the case that motivated them: the ⌘F find-bar ring they were written to remove was a **caret grant**, which is mode OFF, which withholds the attribute at projection. The gate does that job now.

**Why the suite stayed green:** at0345 case 4 asserts the *attribute* and the *absence of a caret*. The computed-style probe (`RINGED_EDITORS`) runs only in the mode-OFF cases, where it asserts absence. The comment says "RINGS it"; no pixel is ever read. Attribute-green, pixel-dark — and it is worth noticing that this is the failure mode the whole projection-gating design makes easy, since the attribute is the contract everywhere else.

**DONE (2026-08-10), uncommitted on `main`.** What landed, and what the measurements settled:

- Both suppression blocks are gone, plus a **third** found by the same search: `.tug-text-card-editor[data-key-view-kbd] { outline: none }`, whose comment reasoned from the `[data-cycling]` context this phase deleted. All three banners are rewritten to teach the current rule. `focus-ring.css`'s own doctrine paragraph no longer lists "a caret-bearing text editor" among the surfaces exempt from the ring.
- **The ring is INSET and drawn on `.cm-editor`, not on the stop element.** Two corrections, both forced by measurement rather than argued:
  1. The composer's editor spans the pane edge to edge (measured `[41, 505, 898, 162]` in a 900px pane at x=40), so the default `+2px` ring paints outside the card on both sides and over the transcript above.
  2. `.cm-editor` is an in-flow child filling the host **to the pixel** with an opaque background, so an inset outline on the host is painted and then covered. `.cm-scroller` inside it sets no background, so the ring drawn one level down shows. The `.tug-entry-shell-input-area` suppression stays, now for the reason that actually applies: it is the editor's parent, so it takes `data-key-within`, and the two boxes are the same rectangle.
- at0345 case 4 now reads the computed outline and requires `style !== "none"`, `width > 0`, and **`offset < 0`**. The mode-OFF absence probe (`RINGED_EDITORS`) was extended to `.tug-text-editor > .cm-editor` — without that every absence assertion in the file would have passed without ever looking at the box that paints.
- The input-area comment's claim that the substrate clips the outline to a top/bottom bar was **not** what the measurement showed (`overflow: visible` the whole way up); the real problem is the overhang. The comment is corrected.

**And a second bug the fix exposed** (found by the user immediately after, and fixed in the same pass): **⌥⇥ advanced.** `useCycleMode`'s `enter()` called `focusFirstInMode()` unconditionally, so engaging the mode from a caret in the composer seeded the **commit-home** — the ring appeared somewhere the keyboard had never been. That is now `FocusContext.enterModeAtKeyView()`: keep the ring on the current key view when it is a stop in the entered mode, seed the first stop only when it is not, and land as a **movement** arrival so a text stop parks. Parking matters for more than looks — it moves the route to `engine-routed`, which is what lets the *second* ⌥⇥ disengage, since [P09] makes the gesture re-engage while the route is `dom-granted`. The doctrine is in `tuglaws/focus-language.md` ("Engaging the mode is not a movement through it") along with the flush-editor ring geometry.

Note the interaction, because it is the reason this went unnoticed for a whole phase: the advance was invisible *because* the ring was invisible. With the composer's ring suppressed, the only visible effect of ⌥⇥ was a ring appearing on the submit button, which reads as a seed rather than as a jump.

at0140 was reworked accordingly — seven `⌥⇥ → route` sites became one `engageAndTabToRoute` helper (⌥⇥ rings the editor's stop, one Tab wraps to the route, since the editor is the cycle's LAST stop), and the file docstring no longer teaches the seed.

Verified: `tsc --noEmit` clean, `bun test` 6367 pass / 427 files, `vite build` clean, `app-test-covers-check` green (359 files), and green app-test runs of at0345, at0140, at0139, at0343, at0396, at0341, at0342, at0126, at0248, at0209, at0223, at0048, at0339-focus-marks-background-window — **plus at0277 and at0282-lens-row-arrow-escape, which closes item (5) below.**

**Two PRE-EXISTING failures were found and are NOT from this work** — both confirmed by `tugutil file probe` with a reverse patch of the change, which reproduced them identically against unmodified sources. They belong to the original KBF landing (`5d6991087`) and are new work:

- `at0339-session-find-bar` (0/2). The focus-order census reads `0,1,5,7,8,9,10,11,19` where it expects `0,1,4,5,6,7,8,9,10,11,19` — orders **4 and 6 are missing from the DOM**, so this is a registration question, not a paint one. Its second test times out waiting for the key view to leave the query field.
- `at0224-card-active-keyboard` (5/6). "[P21] broken after cycling to the never-focused text card: key card B, first responder outside card T."

#### 1. `Tab` from Open Quickly's field does not reach the directory switcher — [P07] case 2 {#addendum-tab-switcher}

**This is the one thing in the phase that is known not to work.** Everything else here is unwritten tests.

What is true:
- `TugCompletionPopup`'s query field is a single-line `INPUT`, so `focusWalkListener` correctly declines to treat it as Tab-owning and routes the key to the walk (`advanceKeyViewFocus`), which engages KBF and steps.
- The switcher **is** authored as a focus stop: `open-quickly-overlay.tsx` renders its `TugPopupButton` with `focusGroup={COMPLETION_POPUP_FOCUS_GROUP}` and `focusOrder={COMPLETION_POPUP_ACCESSORY_ORDER}`, which is exactly what `tug-completion-popup.tsx`'s own docstring demands.
- The landing never arrives: the switcher gets neither `data-key-view-kbd` nor DOM focus, within 6s.

First suspect, and the reason it is first: **the popup's own `onBlur` dismiss guard**. `tug-completion-popup.tsx`'s `onBlur` dismisses when focus leaves the query field, with three exemptions (focus moved inside the panel, focus moved to the engine key sink, or the caller's `dismissGuard` holds). A Tab that engages KBF parks the sink and moves the ring — so the sequence is *blur the field → park the sink → ring the switcher*, and if the popup dismisses on the blur before the ring lands, the switcher query is asking about an unmounted element. The sink exemption exists precisely for this shape, so the question is whether it is firing (is the sink inside the popup's jail, or the document-level one?) and whether the dismiss beats the projection.

How to find out cheaply: reinstate the temporary probe pattern from #addendum-harness below — a `tugDevLogStore.warn` in `focusWalkListener` reporting `focusManager.keyView()` and `focusManager.currentFocusMode()` after the step, plus an assertion on whether `[data-slot="tug-completion-popup"]` is still mounted one tick after the Tab. That distinguishes "the walk found nothing" from "the walk landed and the surface went away."

Note the walk is **mode-bounded**: it services only focusables registered into the current mode. If the switcher's `useFocusable` registers into the base mode rather than the popup's pushed mode (i.e. it renders *outside* the `FocusModeScope`), the walk set is a single element and there is nowhere to step. Check that before blaming the blur — `accessory={switcher}` is passed as a prop into the popup and rendered inside its panel, so it *should* be inside the scope, but "should" is what this class of bug lives on.

The assertion is already written and commented out in place at the end of `at0396-open-quickly-arrows.test.ts` — restore it when the behavior works. It was deliberately left as an explicit non-assertion rather than a `test.skip`, so it reads as unfinished rather than as a kept promise.

**DONE (2026-08-10), uncommitted on `main` — but the item as filed was about `Tab`, and the gesture that was actually broken here is `⌥⇥`. Both are settled below; read the second half, it is the real defect.**

**The `Tab` half: the behavior was never broken — the switcher was never on screen.**

`open-quickly-overlay.tsx` renders the accessory only when `candidates.length > 1`. The scenario this was diagnosed in had exactly one candidate: no card was bound, so the list was the default project directory and nothing else. With no accessory in the DOM the popup's walk holds a single stop, Tab engages the mode and has nowhere to step, and the ring stays on the field — which is correct, and which is indistinguishable from the reported symptom if you only ever query for the switcher. "The landing never arrives" was true and meant nothing.

Seed a second candidate and every part of the chain works, first try, with no source change:

| after | key view | `activeElement` | popup |
|---|---|---|---|
| open | the field | the field (caret) | up |
| `Tab` | the switcher button | the key sink | **still up** |
| `⇧Tab` | the field | the key sink | up |
| `Space` | — | menu | up |

So the two suspects were both innocent, and both for good reasons. `onBlur`'s **key-sink exemption fires exactly as designed** — the sequence really is blur the field → park the sink → ring the switcher, and the popup survives it. And the switcher **is** inside the `FocusModeScope`: the walk is mode-bounded and it finds two stops, so `accessory` reaching the panel as a prop does render it inside the scope after all.

Note the ⇧Tab row: returning to the field **parks** it — ring, no caret — because it is a text stop reached by movement ([P12]). That is the design, and it is worth stating because it looks like a bug from the outside ("Tab back to the field and I can't type"); a printable character grants the caret.

What landed is the test that was missing. `at0396-open-quickly-arrows.test.ts` gains a second test covering the table above, the commented-out non-assertion is gone, and the file docstring records the more-than-one-candidate precondition — because the next person to diagnose this will otherwise repeat the same measurement of an element that is not there.

**The `⌥⇥` half: a real defect, and a much bigger one than this item. `⌥⇥` was a dead key on every surface whose card registers no handler.**

Reported from the app immediately after the `Tab` half was called done: ⌥⇥ in Open Quickly does nothing at all.

⌥⇥'s registry entry carried `routing: "key-card"`. The chord resolves through the **global** keymap path — `keymapRegistry.matchChord` → `dispatchCommand` — which dispatches to the key card, finds no handler, reports unhandled, and stops. The fallback that flips the bit lived in `responder-chain-provider.tsx`, in the branch that handles a **scoped action binding**, which the global chord never reaches. Its comment read "So the fallback lives here, at the dispatch site, where it provably runs." It never ran, and the comment is the reason nobody looked: it names the exact failure and asserts it cannot happen.

So the gesture worked on precisely one surface — the session card, whose responder does register `CYCLE_FOCUS_MODE` — and was dead on every other: the Lens, a diff card, anything Class-B, and any floating surface over a deck with no claiming card. Those are the surfaces the deleted comment listed as the fallback's whole reason for existing.

The fix moves the command to `routing: "registry"` with its handler in `action-dispatch.ts`, beside the `NEXT`/`PREVIOUS_KEYBOARD_FOCUS` pair it belongs with. The handler asks the key card first (a card with a cycle scope wants the toggle at its own responder — the session card pushes its cycle mode and seeds its commit-home there) and falls back to the global toggle when nothing claims it. The misplaced branch in the key pipeline is deleted.

**The generalizable lesson, and the reason this is worth this much prose: a fallback belongs to the COMMAND, not to a door.** ⌥⇥ has three doors — the chord, the View menu item, and the palette — all dispatching one id. A tier implemented at one of them is a gesture that works from that door alone, and the two-tier structure is invisible from the other two. `tuglaws/menus.md`'s generated chord table is regenerated for the routing change (`TUG_WRITE_MENUS_DOC=1`).

**That was not the end of it, and the state below is where this actually stands.**

Routing the command correctly exposed a second, worse defect, found by reading the user's live debug instance rather than the harness (`/api/eval` on its tugcast port; a `window`-capture keydown probe recorded the real press). ⌥⇥ in Open Quickly was not doing nothing — it was **dismissing the popup**. The chord dispatched, the key-card tier answered because the session card behind the popup registers `CYCLE_FOCUS_MODE`, that card entered its own cycle and pulled the key view into itself, DOM focus landed on `cm-content` — neither inside the popup's panel nor on the engine key sink — and the popup's `onBlur` closed it.

The rule that follows: **⌥⇥ acts on whatever owns the keyboard now, which is the focus mode, not on whichever card is frontmost.** At the base mode the key card is asked first; while a floating surface holds a trapped mode, the card is never consulted. That gate is in `action-dispatch`'s handler and is what is committed.

**It is NOT verified, and Open Quickly is being reworked rather than patched further** (user's call, 2026-08-10). The third at0396 test is committed in an unproven state — it passes, but a probe that patched the gate back out **also passed**, which means it does not yet discriminate. The reason is in the fixture: the seeded card renders but is never bound, so it registers no handler and the key-card tier no-ops in both directions. `bindSession("A")` + `awaitEngineReady("A")` were added as the fix for that and the run was never made. Treat the test as unfinished, not as cover.

**The lesson worth more than the fix.** Three consecutive green reports came out of the harness while the gesture was broken in the app, because every one of those tests was built on an **empty deck** — and the empty deck is precisely the fixture in which the failing tier does not exist. A test whose fixture omits the condition under test will pass forever. The live-instance read took ten minutes and settled what three test runs could not; for a defect reported from the app, go to the app first.

**And the process lesson, which is the more expensive one.** The `Tab` half above was declared done, with a passing test, while the gesture the user had actually pressed was untested and broken. The work-list item said `Tab`; the report said ⌥⇥; those are different code paths that meet only at the word "tab". When a report and a plan item disagree about the gesture, the report is the ground truth — test the keystroke that was pressed, not the one that was written down.

**Found while probing, and NOT fixed here:** opening the switcher's menu makes the focus watchdog fight it. The Radix menu is portalled, so it takes real DOM focus while the route is `engine-routed`; the watchdog reasserts the sink once, then logs `correction failed: park (no key sink)` four times and exhausts its reassert budget. `violations` stays **0** and the menu works, so this is log noise and a spent budget rather than broken behavior — but the engine already carries the exemption this wants, in `deliverToEngineLeaf`'s "a trapped surface on top of the stack owns the keyboard, and its menu holds real DOM focus somewhere else in the tree". The watchdog has no equivalent. Same family as item (7) below.

#### 2. `at0395-kbf-mode-division.test.ts` — not written {#addendum-at0395}

The plan's headline division, and the one suite that would catch a regression of the whole phase. What it must assert, per #success-criteria:

- **Mode OFF:** on a session card at rest, **no element in the deck carries `data-key-view-kbd` at all** (`document.querySelectorAll("[data-key-view-kbd]").length === 0`), no `[data-key-cursor]` bar paints, and `<html>` has no `data-kbf`. A caret-holding editor keeps all four plain arrows; two presses of ↑ at a document edge move nothing out of it. (That last one overlaps at0343 — keep it anyway, it is cheap and it is the division's whole point.)
- **Mode ON:** ⌥⇥ engages, `data-kbf` appears, rings paint, Tab/⇧Tab and the arrows move the ring, `Space` commits.
- **The derived half:** opening a sheet engages the mode with no ⌥⇥, and closing it disengages — the property that makes the bit derived rather than latched.
- **Class B:** ⌘L to the Lens shows a cursor bar at rest with no gesture at all.

The `[data-key-view-kbd]`-count assertion is the strongest single line in the phase; write it first.

#### 3. `at0397-kbf-parked-stop.test.ts` — not written {#addendum-at0397}

The **movement half is already covered** by `at0345-editor-ring-mode-division` (parked stop rings with no caret; a printable grants the caret, clears the mode, and types the character). What is *not* covered anywhere is the **seed half**, which is the carve-out that keeps every text-first sheet usable:

- Open the rename sheet: its field has the caret **on open**, ring and all, and typing lands immediately with no Return. Same for the resume-sheet filter and a session question dialog with a text field.
- The accessibility carve-out: with keyboard-access mode set to `accessibility`, every text stop takes a caret even when reached by movement.

This is the highest-risk uncovered behavior in the phase — [P12]'s seed rule is what stands between this design and "every sheet in the app opens unable to type," and right now nothing proves it in the real app.

#### 4. `at0398-kbf-escape-ladder.test.ts` — not written {#addendum-at0398}

One Escape closes a sheet while the caret is in a field inside it — no double-Escape regression (Risk R02). Also worth pinning in the same file: at the **base** mode with KBF manually engaged and no cycle scope (the Lens is the case), Escape clears the mode — rung (6) — and does not reach anything else.

#### 5. Drift runs: at0277 / at0282 {#addendum-drift}

**DONE (2026-08-10).** `at0277-lens-row-accessories-keyboard` and `at0282-lens-row-arrow-escape` both pass **unmodified**, alongside `at0248-lens-list-cursor-keys` (run at #step-5). That is the drift check the plan wanted, and it says the mode division did not leak into the descend machinery.

#### 6. #step-11 in full {#addendum-step-11}

Nothing here has been done. Budget the app-test run as a closing act — the selection will be corpus-scale (~70 serialized launches; see #blast-radius):

```bash
just app-test-changed
```

Plus the three manual passes the harness cannot do: the Spec S04 gesture table row by row on a real session card + Lens + one sheet; the IME first-character check with a non-Latin input source (Risk R01's residual); and an accessibility-mode pass confirming every text stop takes a caret and every engine-routed stop still mirrors real focus.

#### 7. Regressions inherited from the landing, and the watchdog's portal blind spot {#addendum-inherited}

Three things found while working items (0) and (1), none of them caused by that work. The first two were confirmed pre-existing by `tugutil file probe` with a reverse patch, which reproduced them identically against unmodified sources.

- **`at0339-session-find-bar` (0/2).** The focus-order census reads `0,1,5,7,8,9,10,11,19` against an expected `0,1,4,5,6,7,8,9,10,11,19`. Orders **4 and 6 are absent from the DOM**, so this is a registration question, not a paint one — start at what stopped rendering, not at the gate. Its second test then times out waiting for the key view to leave the query field.
- **`at0224-card-active-keyboard` (5/6).** "[P21] broken after cycling to the never-focused text card: key card B, first responder outside card T."
- **The watchdog does not know about portalled menus.** A Radix menu opened from an engine-routed stop takes real DOM focus while the route is `engine-routed`; the watchdog reasserts the sink once, fails four times with `park (no key sink)`, and exhausts its reassert budget. `violations` stays 0 and behavior is correct, so this is noise plus a spent budget — but it burns the exact resource that exists to catch a real peer fighting the engine, which makes the next genuine one harder to see. The rule it wants already exists in `deliverToEngineLeaf`: a trapped surface on top of the mode stack owns the keyboard, and its menu legitimately holds DOM focus elsewhere in the tree. Give the watchdog the same exemption.

### at-numbers and the fan-out budget {#addendum-numbering}

`at0396` is taken (by this phase). `at0393` / `at0394` belong to other work that has since landed. **Free: `at0395`, `at0397`, `at0398`** — which happen to be exactly the three suites above, so the names in the work list are the names to use. Confirm with `ls tests/app-test/ | grep -oE '^at[0-9]{4}' | sort -u | tail` before authoring; the corpus moves.

`ACCEPTED_FANOUT` in `tests/app-test/scripts/select-tests.ts` was raised **64 → 65** for `focus-manager.ts` when at0345 gained a `@covers` on it (the argument is recorded in place). **Each of the three new suites will need a `@covers` on `focus-manager.ts` and will push it further.** Raise it once, deliberately, with the count and the reason — the file's own comment asks for that and it is a good rule.

### Invariants a follow-up must not break {#addendum-invariants}

These are load-bearing and every one of them is a place where a plausible-looking simplification reintroduces a bug that was already paid for:

- **`settleKbfEngagement` must ALWAYS notify.** Only the repaint + re-land half is gated on the derived answer flipping. Gating the notify on the derived value is why ⌥⇥ on a card already engaged by its own `kbfAtRest` changed the manual bit and told nobody, so the gallery cycle demo's scope never went up.
- **`parksTextStop()` reads the ARRIVAL; `hasParkedTextStop()` reads the STATE.** The first answers "should arriving here park?" and is a question about the placement. The second answers "is the keyboard parked at a text stop right now?" and is what a keystroke responds to. Making the second ask the arrival question is why typing at a parked stop did nothing — any later re-realization resets the arrival, and then the ring says one thing and the predicate another.
- **The three route sites move together**, and the watchdog's `isBareNativeControl` legality read is the fourth. `classifyRoute`, `focusKeyView`'s re-derivation, `focusKeyView`'s bare-native-control grant branch, and `checkFocusInvariant`'s legality class must agree. If grant and legality diverge, a second focus authority (Radix mount-autofocus, the browser default) fills the vacuum and the watchdog *blesses* it — parking fails silently, which is the worst failure mode available here.
- **`regrantCurrentTarget` must preserve the arrival.** A watchdog re-grant repairs the placement that already happened; letting it fall back to the `"placement"` default silently un-parks a stop the engine moved to.
- **The route must be derived above the `typeof document` guard in `focusKeyView`.** It is engine state (`dispatchKeyToKeyView` gates on it), not a DOM effect, so it has to settle whether or not there is a document.
- **`useCycleMode`'s scope stays `kbf: false`.** `trapped: true` there buys Escape semantics, not a surface. Letting it count as Class A makes the mode its own cause: clearing the manual bit leaves it engaged by the very cycle the clear was meant to end, and nothing can ever leave the mode from inside a cycle.
- **`advanceKeyViewFocus` engages before it steps.** This is what keeps ~20 component focus suites (at0109, at0113–at0127, …) green: they Tab into a control and assert a ring, and the ring only exists because Tab turned the mode on. Move the engage out of the shared performer and they all go red at once.
- **Never gate a ring by prefixing a paint rule with `html[data-kbf]`.** That takes the leaf rule from (0,1,0) to (0,2,1), above every item-group `outline: none` suppression at (0,2,0), and repaints the double ring `focus-ring.css` records three failed attempts at removing ([R04]). The gate is the withheld flavor; the only CSS is `html:not([data-kbf])` **suppressions**.
- **Mode entry must not advance.** `useCycleMode.enter()` calls `enterModeAtKeyView()`, which keeps the ring on the current key view and seeds the first stop only when there is none. Restoring the unconditional `focusFirstInMode()` puts the ring somewhere the keyboard has never been — and, worse, does it invisibly if any editor's ring is ever suppressed again.
- **The mode-entry landing must be a MOVEMENT arrival.** Landing it as a placement would grant the caret instead of parking, which paints no ring (a caret is mode OFF) and leaves the route `dom-granted` — and [P09] re-engages rather than disengaging on a `dom-granted` route, so ⌥⇥ would stop being a toggle from the one place it is most used.
- **A flush editor's ring is drawn on `.cm-editor`, inset.** Moving it back onto the stop element makes it invisible (an opaque in-flow child covers an inset outline) or makes it overhang the card (outset). Both failure modes look like "the ring is broken" and neither is a specificity problem, so neither responds to the usual fix.
- **`data-attached-cursor` and `data-default-ring` are exempt from the mode gate, by design.** Neither is a focus position. If a future suppression list grows, do not sweep them in.

### Harness knowledge paid for in app-test runs {#addendum-harness}

Each of these cost at least one full run to learn. They are not in `tests/app-test/README.md`.

- **`tugutil file probe` with a `git diff -R` reverse patch answers "was this already broken?" definitively**, and it is cheap. Write `git diff -R -- <src paths> > /tmp/revert.diff`, then `tugutil file probe --patch /tmp/revert.diff -- bash -c 'cd tugdeck && bunx --bun vite build >/dev/null 2>&1 && cd .. && just app-test <file>'`. The rebuild inside the probe is not optional — app-tests serve the prod bundle, so without it you re-run the same bytes and conclude the opposite. Rebuild again afterwards, since the probe restores sources but not `dist`. This settled two failures as pre-existing in about a minute each; reasoning about whether a CSS change could plausibly move a first responder would have taken longer and convinced nobody.
- **Assert pixels, not just attributes, whenever CSS is the deliverable.** at0345 asserted `data-key-view-kbd` and the absence of a caret, and shipped a ring that painted nothing for a whole phase. The trap is specific to projection gating: the attribute is the contract everywhere else, so reading it feels like reading the truth. When a suppression rule may exist, read `getComputedStyle`. And when the paint moves to a different element than the attribute, **extend the absence probes to the new element too** — otherwise every "no ring here" assertion in the file keeps passing while looking at the wrong box.
- **A one-off `note()` dumping the computed-style + `getBoundingClientRect` chain from the stop up through four ancestors is worth the run it costs.** It answered "outset or inset?", "who clips?", and "does a child cover it?" in a single 4-second run, and two of those three answers contradicted what the existing comments claimed. Delete it once it has paid out — the assertion it produced is what stays.
- **A cycle stop's key-view element IS the editor**, not an ancestor of it. The composer's text stop registers on the substrate under the editor's responder id, so the ring attribute rides that element: match `[data-key-view-kbd][data-slot="tug-text-editor"]`, not `[data-key-view-kbd] [data-slot="tug-text-editor"]`. That single space cost a diagnostic round in at0345 and again in at0140. Scope it to the surface too (`[data-slot="tug-prompt-entry"] …`) — with the find bar open there are two text stops on the card.
- **The dev log is reachable from a test and is the fastest way to see engine internals**, but three details bite: the entries are at `window.tugDevLog.getSnapshot().entries` (not the snapshot itself), the subsystem field is **`source`**, not `channel`, and **`debug`-level entries do not show up** — use `tugDevLogStore.warn` for a temporary probe. Getting any of the three wrong returns `[]`, which reads exactly like "the code never ran" and sends you chasing the wrong thing.
- **When a wait times out, check which of several identical waits it was.** The harness reports the failing *script*, and a script like `EDITOR_FOCUSED` may appear three times in one test. at0140's first failure looked like the exit path and was actually the landing two steps earlier. A `note()` between them costs one run and settles it.
- **`note()` is the right instrument** — the `Diagnostics:` section of the report is designed for this, it survives a passing run, and it is how the parked-stop round trip was confirmed end to end (`{kbf:true, ringed, sink active}` → type `x` → `{kbf:false, editorText:"x"}`).
- **Never pipe `just app-test`.** The gate rewrites it, and on a passing run a `| grep` prints nothing and exits 1 — a green run reported as a silent failure.
- **The Bash cwd reverts between calls in a worktree.** Every command needs its own explicit `cd`. This bit twice, once running the whole repo's test corpus by accident and once type-checking nothing.
- **`just app-test` builds `Tug-apptest.app` on first use in a fresh worktree** and that first invocation is slow enough to blow past the tool's output cap. Run it once bare to warm it, then run tests.

### What the implementation decided that the plan did not {#addendum-decisions}

All of these are folded into the plan body above at their decisions, but collected here so a reader knows the plan was amended rather than merely followed. (5) and (6) were decided in the follow-up pass, after the phase landed.

1. **The attached-list highlight is its own gate-exempt mark** (`data-attached-cursor`), because the movement cursor paints only while the keyboard is *in* its list — which an attached list never is — and because [P04] suppresses `data-key-cursor` in mode OFF, which is exactly where an attached list matters most. Owner chose this over reusing `data-key-cursor` with a carve-out. See [P08].
2. **Pulse has no card and About registers no focus stops**, so neither takes `kbfAtRest`. See [P10].
3. **Session history is not an attached-list site** — it renders `TugHistoryList`, which has no cursor model and no per-row stops — so `filterFieldDidRequestAdvance` survives for that one consumer instead of being deleted. See [P08] and #deletion-inventory.
4. **at0140 joined the rewrite list** the plan did not have it on, and **at0341 / at0342 needed no behavioral rewrite at all** (only `@covers` repointing) — they drive surfaces where the mode is already engaged. See #probe-survey.
5. **Engaging the mode does not advance.** The plan said what the mode IS and what the arrows and `Tab` do inside it, and never said where the ring lands at the moment of engagement — so the pre-mode "seed the commit-home" behavior survived by default. It is wrong: the ring says where the keyboard is, and a gesture that engages *and* relocates answers a question nobody asked. Now `enterModeAtKeyView()`. See #addendum-editor-ring.
6. **A flush editor insets its ring onto the substrate.** [P04] settled that the gate is the withheld attribute and never a CSS prefix, which is still right — but it left the *geometry* of a full-bleed stop's ring unstated, and the two editors that fill their host edge to edge (the composer, the Text card) cannot use the standard outset ring at all. Both corrections are recorded in `tuglaws/focus-language.md`.
