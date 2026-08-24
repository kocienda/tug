# KBF mode, continued — brief {#brief}

*2026-08-11. Scoping document for the round of work that follows the KBF landing (`5d6991087`) and its follow-ons (`b83dad693`, `1e86cd245`). Five issue areas, lettered as filed. Each section states what is measured, what is believed, and what the remediation is — and marks the difference. Nothing here is a plan yet; the point is to agree on the shape of the work before writing one.*

## Where the tree stands {#brief-state}

Committed since the landing: the editor-ring conversion and the ⌥⇥ routing fix (`b83dad693`, `1e86cd245`), plus the sidebar three-state toggles (`84ba28923`, separate work).

Uncommitted on `main`, all from the current text-card round:

| file | what |
|---|---|
| `tug-text-card-editor.css` | ring drawn as a `::after` overlay above `.cm-gutters` — **verified by screenshot**, keep |
| `tug-text-card-editor.tsx` | `focusGroup`/`focusOrder` opt-in mirroring `TugTextEditor` — implicated in the ⌘F caret steal, see (A) |
| `text-card-status-bar.tsx` | `focusGroup`/`focusOrder` pass-through to the two popup buttons — working, keep |
| `text-card-find-bar.tsx` | `focusGroup`/`focusOrderBase` pass-through to `TugFindBar` — inert as wired, see (A) |
| `text-card.tsx` | the cycle wiring — **wrong**: the find bar renders outside any `CycleScope`, see (A) |
| `responder-chain-provider.tsx` | card-construction KBF exit — measured working, but on a build two edits stale; re-verify before keeping |
| `tuglaws/focus-language.md` | the {#kbf-transitions} inventory + the flush-editor ring paragraph — the inventory is what (C) audits |

`tests/app-test/at9995-textcard-ring-probe.test.ts` is an untracked scratch diagnostic. It gets deleted at the end of this round; its walk-probe pattern is worth keeping as the verification instrument while the round runs.

Known-red, pre-existing (confirmed by reverse-patch probe): `at0210` (1/2), `at0224` `[P21]` case, `at0339-session-find-bar` (0/2 — but see (A): its expected census is stale against the Z4B diet, so at least half of that red is the test's fault). Regressions from the current uncommitted work: `at0223` (0/2), two `at0224` find-bar cases.

## (A) The Find bar in the KBF cycle — session card and text card {#brief-find-bar}

**Text card, measured (at9995 walk probe, current bytes):** with the bar open, ⌥⇥ + eight Tabs walk editor → line-ending → file-type and wrap. The bar's four stops are never visited; `ringInBar` is false at every step. And ⌘F itself leaves the caret in the editor (`focusInEditor: true, focusInBar: false`) — the query field receives focus and has it granted away one frame later by `place() → realizeResolvedTarget() → grantTextSurface() → focusKeyViewViaContract() → editor's focus contract` (fifteen-frame stack capture; the watchdog is clean, `violations: 0`).

Two distinct defects:

1. **The bar's stops register into the wrong mode.** `useFocusable` records `modes: [focusMode]` from `FocusModeContext`, and `text-card.tsx` currently renders the bar in a bare fragment between two `CycleScope`s — so its stops join the base mode while the ⌥⇥ walk is bounded to the pushed cycle mode. The session card's wiring is the model (`session-card.tsx:4406-4426`): the bar renders **inside** `cycle.CycleScope`, orders 8–11, mounted only while open. The adjacent comment in `text-card.tsx` already claims this and the code no longer does it.
2. **The ⌘F caret steal.** With the editor registered as a focusable under the same id as its focus-contract responder, a React commit re-runs `place()` and the engine re-grants the text surface — pulling the caret out of the query field one frame after ⌘F put it there. The session card has the same editor-as-stop shape (`SESSION_CYCLE_ORDER_EDITOR = 19`, contract under the responder id) and does **not** steal, so the delta between `TugTextEditor`'s registration and `TugTextCardEditor`'s is where the answer lives — find the guard the composer's path has that the text card's lacks, rather than inventing a new one. (Reordering the editor 0 → 19 was already tried and changed nothing; the order experiment can be reverted or kept for parity, but it is not the fix.)

**Session card, believed working, one census to settle:** the user reports the session card's bar works. `at0339`'s expected order census (`0,1,4,5,6,7,8,9,10,11,19`) predates the Z4B diet — slot 4 is the off-code-route chip (Cwd/Changes, never mounted on the code route) and slot 6's Effort chip merged into the AI chip (`session-card.tsx:303-341` documents both gaps). The census wants updating to the T01 table, not the code. Its second test (key view never leaves the query field) must then be re-run against the corrected fixture before assuming it is also stale.

**Definition of done for (A):** on both cards, ⌘F lands the caret in the query field and it stays; ⌥⇥ from there parks it; Tab visits query → controls → the card's other stops in the declared order and wraps; the bar's stops vanish from the walk when the bar closes; at0223/at0224 back to their pre-round pass rates; at0339 green against an honest census. Every one of those is a walk-probe measurement, not an attribute read.

## (B) Engaged KBF means no blinking caret, anywhere {#brief-no-caret}

**The rule as filed: a blinking caret and a focus ring are mutually exclusive.** Today nothing enforces it, and there is no CSS keyed on `html[data-kbf]` that touches carets at all.

How carets actually paint (census):

- The `TugTextEditor` family (composer, find-bar query field, message editors, gallery editor) paints a **custom caret layer** gated hard on real DOM focus — `caret-layer.ts:266`: `if (!view.hasFocus) return []`. Parked = blurred = no caret. This family is already correct *whenever the engine actually parks*.
- The **text-card editor keeps the native caret** (`tug-text-card-editor/theme.ts:54`, `caretColor: var(--tugx-textcard-caret)`) — browser-driven, blinks whenever the element holds DOM focus.
- Native `<input>`/`<textarea>` (TugInput, TugTextarea, TugValueInput, TugFilterField) have **no caret CSS at all** — pure browser caret, same rule: focus = blink.

So caret visibility is governed entirely by DOM focus, which means (B) is **not a CSS project**. Hiding a caret while the editor still holds DOM focus would be a resting lie — keys would still land in the editor while nothing on screen says so. The invariant is an engine invariant: *while the route is `engine-routed`, no text surface holds DOM focus* (the watchdog's existing job), and *while the route is `dom-granted`, the mode's paint stands down*.

The enumerated cases where a caret and the engaged mode coexist today:

1. **Seeded stops ([P12] seed half)** — every `useSeedKeyView` sheet (rename, gallery, resume, history filter, Open Quickly, …) opens trap-engaged **and** caret-holding, by design: `parksTextStop()` requires `arrival === "movement"` and a seed is a placement. This is the deliberate carve-out that keeps every text-first sheet able to type on open.
2. **[P09] re-engage** — ⌥⇥ from a live caret forces the manual bit true while the route is still `dom-granted`, so mode-on and caret overlap until the park lands.
3. **The ⌘F grant** — a caret grant by design; mode may be engaged around it (e.g. bar opened from inside a cycle).
4. **Accessibility mode (Class C)** — every text stop takes a caret even when reached by movement. This carve-out is load-bearing and stays.

**Proposed resolution — key the paint on the route, not on more derivation surgery.** The engine already holds the exact bimodal state the rule wants: `KeyboardRoute = "engine-routed" | "dom-granted"` (`focus-manager.ts:175`). Project `data-kbf` (or a sibling paint gate) only while the route is `engine-routed`: a granted caret then reads as mode-paint-off (caret blinks, no rings anywhere), and a parked stop reads as mode-paint-on (ring, no caret — already true for the `TugTextEditor` family via the `hasFocus` gate). This dissolves case 1 without touching the seed rule — a seeded sheet opens caret-first with no rings, and the first Tab parks and brings the rings up — and it makes cases 2 and 3 self-resolving at the moment the park lands. Accessibility mode is exempted explicitly, as it is everywhere else.

What must be checked before committing to this: which non-ring paints currently key off `data-kbf`'s presence (the `html:not([data-kbf])` suppressions in `focus-ring.css`, choice/option-group separators) and whether any of them must stay up during a grant; and whether the projection change re-introduces the [R04] specificity hazard (it should not — the gate stays at projection, exactly the [P04] shape).

Backstop, after the engine invariant holds: a dev-mode assertion extending `checkCaretResponderInvariant` — a painted caret while `data-kbf` is projected is a reportable divergence, same shape as `caret-responder-divergence`.

## (C) The transitions inventory — audit {#brief-transitions-audit}

The {#kbf-transitions} tables in `tuglaws/focus-language.md` (uncommitted) are a start and are already missing real cases. Findings to fold in:

**Missing exits, confirmed in code:**

- **Dismissing a trapped surface does NOT clear the manual bit.** `popFocusMode` re-derives (`settleKbfEngagement`) but the only writers of `kbfManuallyEngaged` are ⌥⇥, the View items, `advanceKeyViewFocus` (which SETS it), and pointerdown. So: open a sheet, press Tab once inside it (manual bit goes on), dismiss the sheet — KBF stays engaged on the surface below, ring pointing at a context the user just left. The user's proposal — exiting a trapped mode exits KBF — is the fix; concretely, `popFocusMode` on a trap should clear the manual bit, letting the derivation then answer from the remaining inputs (a `kbfAtRest` key card underneath legitimately keeps the mode on).
- The **card-creation exit** is in the uncommitted work and in the table; it stays, re-verified.

**Sidebar cards (Lens, Jots, Gazette) — currently invisible in the doctrine:** all three declare `kbfAtRest: true` (as do devtools, keyboard-card, settings-card, two gallery cards — the doctrine's "the Lens, a diff card" list is stale against this census and should name the class by the registration, with the current members in a table). The transitions that need stating:

- **⌃⌘L / ⌃⌘J / ⌃⌘G show-or-activate** transfers the key card to a `kbfAtRest` card → engages, no gesture. The **hide** state transfers away → disengages, unless the manual bit holds. ⌘L's focus-return leg is the same edge in reverse.
- **⌘J (new jot)** activates Jots and drops a caret in the jot editor — an activation that engages Class B and *immediately* grants a caret. Under the (B) proposal this is coherent (mode on, paint standing down for the grant); without (B) it is a live case of ring-plus-caret. Worth a row either way.
- **Gazette is a Class B card with zero engine stops.** It engages the mode as key card and registers no `useFocusable`, no list, no seed — nothing to ring. That violates "an empty group never holds the keyboard" at card scale. Either Gazette registers its rail (ref chips, composer, send) as stops, or it drops `kbfAtRest` until it does. Decide; don't leave it.

**Audit deliverable:** re-derive the two tables from the code rather than from memory — one row per writer of each derivation input (all four), one row per transition, each row carrying its file:line. The audit is done when a grep for `setKbfManual|toggleKbfManual|clearKbfManualForPointer|kbfAtRest|kbf: false|hasEngagingTrap` finds no site the tables don't name.

## (D) Groundwork: Open Quickly, and the rework behind it {#brief-open-quickly}

Present state, so the near-future work starts from facts:

- Open Quickly is not a sheet — it is `TugCompletionPopup` in a deck-global overlay, a **trapped mode that opts out of KBF** (`kbf: false`, typing-first), field seeded by the engine, arrows/Enter handled locally, blur-dismiss with key-sink and in-panel exemptions.
- The ⌥⇥-acts-on-the-mode gate (`1e86cd245`) is committed but **unverified**: the third at0396 test passes with the gate patched out — the fixture's card is never bound, so the key-card tier no-ops in both directions. `bindSession("A")` + `awaitEngineReady("A")` are written; the run was never made. That run is owed before anything is built on top.
- Tab to the directory switcher works (two-candidate precondition; at0396 covers it). ⇧Tab back **parks** the field per [P12] — correct, and the single most likely thing a rework will want to feel different, since "Tab back and I can't type" is exactly the parked state working as designed on a typing-first surface.
- The **watchdog's portal blind spot** burns its reassert budget whenever the switcher's portalled menu opens. The exemption it needs already exists in `deliverToEngineLeaf` (a trapped surface's menu legitimately holds DOM focus elsewhere); give the watchdog the same rule. This is the one piece of (D) that is pure debt with a known fix and no design question.

The groundwork this round owes the rework: (C)'s trap-exit rule settled (Open Quickly is a trap; its dismissal semantics follow from it), (B)'s route-keyed paint settled (a typing-first trap is permanently `dom-granted` at rest — under the proposal it correctly shows no rings until a Tab parks), the watchdog exemption, and the at0396 discrimination run. With those four down, the rework starts on solid ground instead of on this round's open questions.

## (E) The double-ring is a plain-Return promise, and two wearers are lying {#brief-double-ring}

**The mechanism census (three paint paths, one meaning):**

1. **Engine-owned** `data-default-ring` via `persistentDefaultRing` (`tug-button.tsx:437` → `focus-manager.ts:3127` projection; ring at `tug-button.css:1816`). Thirteen call sites, all sheet/dialog defaults (alert, rename, resume-open, rewind, compaction, ai-config, question dialog's gated Submit, permission dialog, attachment preview, History Done).
2. **Entry-shell CSS** via `data-tug-entry-default` + `[data-entry-keyboard]` (`tug-entry-shell.css:236-305`) — deliberately not engine-registered (two shells would fight over one stack slot). Two wearers: the **Z5 submit** (`tug-prompt-entry.tsx:3426`) and the **find bar's default** (`tug-find-bar.tsx:315`).
3. **Hand-painted** — `.session-changes-done` (`session-changes-view.css:74-89`), unconditional.

**The offenders:**

- **Z5 submit.** `returnKeyAction` is a user setting, default `"newline"` (`editor-settings-store.ts:52`): plain Return inserts a newline and **Shift+Return submits**. The ring is honest only for users who flipped the setting to `"submit"` — so at the default, the promise is false for the app's most prominent default-ring. Fix: the shell-default treatment must read the effective return action; with `returnAction === "newline"` the Z5 button drops the ring (fill promotion may stay — it marks the live default, not the key). The find bar's wearer stays: Return in the query field really does fire find-next.
- **History Done.** Wears `persistentDefaultRing` unconditionally. The static read says the engine's default-button dispatch *does* fire it on plain Return (the shade's key view is the list, a non-button, so Return falls through to the registered default) — which contradicts the report that Shift+Return activates it. **Measure in the app before changing anything**: if plain Return is consumed by the list (row activation) in practice, the ring lies and comes off; if Return genuinely fires Done, the component is honest and the report was about the Z5 case's sibling look. Either way the answer is a measurement, not a debate.

**Proposal — a chord badge for Shift+Return defaults.** The ring stays reserved, permanently, for "plain Return fires this." For a control whose activation is Shift+Return, indicate the chord instead of borrowing the ring: a small keycap-style badge — `⇧⏎` in the button's own text color at reduced emphasis, set in a rounded-rect keycap outline — rendered at the button's trailing edge, visible under exactly the condition the ring used (`[data-entry-keyboard]` on the shell), and suppressed in KBF mode (where the engine's own marks own the vocabulary) and in background windows. The fill promotion stays as-is: "this is the entry's action" is still true; only the key claim changes. Rationale: any ring variant (dashed, doubled, recolored) still reads as a ring and dilutes the one promise the ring makes; a keycap badge is the only treatment in the deck that *names the key*, which is the actual information the user lacks. It also generalizes: if a third chord-activated default ever appears, the badge scales to any chord string, where ring variants do not. Alternatives considered and rejected: no indicator (the discoverability of Shift+Return is already the weak point); hover-only affordances (invisible exactly when the user is typing, which is when the question arises).

## Proof discipline for this round {#brief-proof}

Adopted after this session's failures, binding on every item above:

1. **A claim ships with the run that produced it, and the run postdates the last edit.** No measurement carried forward across an edit, ever. The at9995 walk probe (or its successor) re-runs after every change to (A)/(B) code and the reported table comes from that run.
2. **A suite counts as cover only after it has failed.** Before calling any behavior pinned, patch the behavior out (`tugutil file probe` with a reverse patch) and watch the suite go red. at0396's third test is the standing example of a green that discriminates nothing.
3. **Defects reported from the app get diagnosed in the app first** (`/api/eval` on the live instance's tugcast port), then pinned in the harness. The empty-deck fixture lesson: a fixture that omits the failing tier passes forever.

## Suggested sequencing {#brief-sequence}

1. **(A) text card** — restore the `CycleScope`, resolve the ⌘F steal by diffing the composer's registration path, fix at0223/at0224, correct at0339's census. Smallest, already half-instrumented, unblocks the user's daily irritation.
2. **(C) audit + trap-exit fix** — doctrine tables re-derived from code; `popFocusMode` clears the manual bit; Gazette decision.
3. **(B) route-keyed paint** — the projection change, then the caret backstop assertion.
4. **(E)** — the History Done measurement, the Z5 state-aware ring, the chord badge.
5. **(D)** — at0396 discrimination run + watchdog portal exemption; hand the Open Quickly rework a clean slate.

(2) before (3) because the trap-exit rule changes when the mode is on at all, and (B)'s paint gate should be tested against the corrected transitions, not the current ones. (E) and (D) are independent of everything and each other; they close the round.
