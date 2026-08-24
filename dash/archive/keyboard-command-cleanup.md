## Keyboard Command Cleanup — Chord Tiers, Moves, and ⌘. Parity {#keyboard-command-cleanup}

**Purpose:** Adopt the modifier-key algebra as written doctrine (`tuglaws/chord-tiers.md`), move nine keyboard shortcuts onto it, add Claim All / Disclaim All as registry commands, and make ⌘. a registry-backed twin of ⎋ everywhere a surface dismisses. This is the ground-clearing phase before the systematic menu-by-menu command audit.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-06 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The command table ([L30], `tugdeck/src/components/tugways/command-registry.ts`) made every chord a registry fact, but the chords themselves were assigned ad hoc over time. The design brief at `dash/keyboard-command-cleanup-brief.md` (decisions locked 2026-08-06) fixes that with a **modifier algebra**: two base tiers (⌘ universal, ⌃⌘ Tug machinery) and two operators (⇧ counterpart, ⌥ variant), from which every modifier set derives a one-sentence meaning. Several shipped chords violate the algebra (⇧⌘P Prompt Route, ⇧⌘C/⇧⌘H shade toggles, ⇧⌘M auto-message, ⌥⌘T Next Theme, ⌘I Insert File), two Changes-shade bulk verbs have no chords at all, and five components hand-match ⌘. instead of reading the `cancel-dialog` bindings from the registry.

This plan writes the algebra into `tuglaws/`, executes the chord moves, adds the two new commands, and converts the ⌘. hand-matchers — leaving a clean, explainable keymap before the menu-by-menu audit re-scores every remaining item against the tiers.

#### Strategy {#strategy}

- Doctrine first: land `tuglaws/chord-tiers.md` + the global design decision before any code moves, so every commit can cite the rule it implements.
- Chord moves are pure registry edits plus their Swift construction-literal twins and test-pin transcription updates — one commit, mechanically verifiable.
- New commands (Claim All / Disclaim All) follow the existing `commit-auto-message` scoped-binding precedent exactly; no new machinery.
- ⌘. parity is a matcher change, not a routing change: each of the five surfaces keeps its documented dismissal path and only the chord *match* moves to the registry.
- Everything renders chords via `commandShortcut(id)` / the keymap pane projection already, so display surfaces update for free; the work is the table, the Swift literals, and the pinned test expectations.

#### Success Criteria (Measurable) {#success-criteria}

- `tuglaws/chord-tiers.md` exists, is linked from `tuglaws/commands.md`, `tuglaws/tuglaws.md` ([L30]), and `tuglaws/INDEX.md`, and `tuglaws/design-decisions.md` carries a new **D126** entry (verify by reading the four files).
- Every chord in **Table T01** resolves to its new value through the real pipeline: the updated `SHIPPED_CHORDS` rows in `tugdeck/src/components/tugways/__tests__/command-routing-drift.test.ts` pass (`bun test`).
- The native menu bar shows the new chords: updated `STATIC_ITEMS` rows in `tests/app-test/at0168-menu-structure.test.ts` pass.
- Every pin in **List L02** carries its new spelling and passes — the unit pins, the four app-test chord drives, and the generated doc region.
- `tuglaws/menus.md`'s generated chord table matches the registry: `menus-doc.test.ts` passes with no rewrite pending (it diffs the checked-in region against `generateChordTable()`).
- ⌃⌘A / ⌃⇧⌘A appear as scoped rows for the new commands in the keymap pane projection (`buildKeymapRows` output includes them; unit-verifiable via `settings-keymap-rows.ts`).
- `isCancelChordEvent` has its own unit pins: it matches ⌘., refuses ⎋, and follows a user override of `cancel-dialog`.
- The five converted components contain no literal `metaKey && (key|code) === "."` match; each calls the shared registry-backed matcher (verify by grep).
- `bunx vite build` succeeds; `just app-test-changed` verdict PASS; registry lints (`lintCommandTable`, `lintActionCoverage`, `lintNativeLocked`, `lintChordCollisions`) pass at import (they throw in DEV and run in `command-registry.test.ts`).

#### Scope {#scope}

1. Author `tuglaws/chord-tiers.md`; add D126; cross-link commands.md / tuglaws.md / INDEX.md.
2. Move seven existing chords and re-home two more (Table T01) in `command-registry.ts`, with the four Swift construction-literal twins in `tugapp/Sources/AppDelegate.swift`, the pinned-test transcriptions of **List L02**, and the regenerated `tuglaws/menus.md` chord table.
3. Add `claim-all-changes` / `disclaim-all-changes` commands (⌃⌘A / ⌃⇧⌘A, composer-scoped) wired to `ChangesRouteController`.
4. Registry-backed ⌘. matcher; convert the five hand-matching components; add ⌘. parity to dismissal surfaces that today handle only ⎋.

#### Non-goals (Explicitly out of scope) {#non-goals}

- The systematic menu-by-menu audit (names, menuEligible/scope review, free-pool grants) — the follow-on phase this plan clears the ground for.
- Re-homing Cascade ⌃⌥C / Tile ⌃⌥T — deferred to the menu pass with the whole Window menu on the table (see [Q02]).
- Rebinding UI changes: scoped bindings remain visible-but-not-rebindable in the keymap pane (its documented [Q03] stance in `settings-keymap-rows.ts`).
- ⌘. in text-field *revert* contexts (filter field, value input, slider) — see [P06]; ⎋-revert is editing currency, not surface dismissal.
- Touching `NATIVE_LOCKED`, the substrate text-editing bindings (⌃U/⌃W/⌥F/⌥B), or the CM6 ⌘↩ submit / ⌘↑↓ history handlers (candidates for `ACTIONS_OUTSIDE_THE_TABLE` review in the audit phase, not here).
- Rewriting historical chord mentions inside existing `design-decisions.md` entries (D122–D124 reference ⇧⌘P/⇧⌘C as shipped at the time); D126 supersedes them going forward.

#### Dependencies / Prerequisites {#dependencies}

- The command registry / keymap registry architecture already on main ([L30], `commands.md`) — no schema work needed.
- `dash/keyboard-command-cleanup-brief.md` — the locked design source this plan implements.

#### Constraints {#constraints}

- **Warnings are errors** across the Rust workspace; Swift edits must build clean (`tugapp`).
- tugdeck changes must pass `bunx vite build` (the release rollup can fail where dev esbuild succeeds).
- App-tests run selectively: `just app-test-changed` (never the full corpus); every new/changed test keeps valid `@covers` lines.
- No `localStorage`; any persistence goes through tugbank (none is added here — overrides already live in `dev.tugtool.keymap`).
- Chords are identified by `KeyboardEvent.code` + four modifier flags; labels are display-only (`chord-format.ts`).

#### Assumptions {#assumptions}

- macOS reserved chords stay as listed in the brief (⌃⌘Q, ⌃⌘D, ⌃⌘Space, ⇧⌘3/4/5, ⇧⌘Q, ⇧⌘/, ⌥⌘⎋, ⌘Space, ⌘⇥, ⌘`, ⌃-arrows, ⌃Space); none of the new chords collide with them (⌃⌘C/H/T/I/M/A/P, ⌃⇧⌘A, ⌃⌥⌘P are all unreserved).
- User keymap overrides (tugbank `dev.tugtool.keymap`) are per-command binding lists; moving a *default* does not disturb an existing override (absent = registry default), so no migration is needed.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Gate for the Changes bulk-verb chords (DECIDED) {#q01-claim-gate}

**Question:** When are ⌃⌘A / ⌃⇧⌘A live — while the Changes shade is visible, or while commit mode is active?

**Why it matters:** A chord live at the wrong time either fires on invisible state or goes dead while the user is looking at the buttons it mirrors.

**Resolution:** DECIDED (see [P03]). Reading `session-card.tsx`'s `TOGGLE_CHANGES_VIEW` handler: raising the Changes shade *is* entering commit mode (`commitModeController.enter()`), and the handler's own comment says "Showing Changes is Changes mode." `tug-prompt-entry.tsx` already gates its `COMMIT_AUTO_MESSAGE` scoped registration on `commitActive` — the new bindings register at the same site under the same gate.

#### [Q02] Cascade/Tile ⌃⌥ home (DEFERRED) {#q02-cascade-tile}

**Question:** `window.cascade` ⌃⌥C and `window.tile` ⌃⌥T sit in a modifier set the algebra doesn't generate (⌃⌥ with no ⌘).

**Resolution:** DEFERRED to the menu-by-menu audit — candidate homes (⌃⌥⌘ window-arrangement) should be weighed with the whole Window menu on the table. `chord-tiers.md` records the anomaly explicitly so it reads as a known debt, not an endorsement.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Muscle-memory breakage for shipped chords | med | high (by design) | Keymap pane + menus show the new chords from one source; users can override any of them in Settings ▸ Keyboard | User feedback after ship |
| A missed test pin fails after a chord move | med | med | List L02 enumerates every pin found by **two** sweeps — the glyph grep and the modifier-literal grep, because a glyph grep cannot see `{ code: "KeyP", metaKey: true, ctrlKey: true }`, which is how every app-test spells a chord | Any red test naming an old chord |
| ⌃⌘C dead in some focus context (WebKit/AppKit eats ⌃-chords?) | med | low | ⌃⌘P and ⌃⌘F already ship and work through the same pipeline; at0340's updated chord drive proves ⌃⌘C end-to-end | at0340 failure |
| ⌘. matcher changes double-fire cancel (local + global funnel) | med | low | The conversions keep each surface's existing propagation posture (documented per-surface in [#cancel-cluster]); only the match predicate changes | A dialog closing twice / beeping |

**Risk R01: at0253's ⇧⌘C collision workaround goes stale** {#r01-at0253-stale}

- **Risk:** `tests/app-test/at0253-commit-dialog.test.ts` documents avoiding the ⇧⌘C *chord drive* because headless key synthesis collided with ⌥⇧⌘C Copy-as-Plain-Text ([D117]); after the move to ⌃⌘C the workaround text is stale and the collision may no longer exist.
- **Mitigation:** Update the comment; do not rework the test's drive mechanism in this plan (behavior unchanged).
- **Residual risk:** None — comment-only.

---

### Design Decisions {#design-decisions}

#### [P01] The modifier algebra is doctrine, written to `tuglaws/chord-tiers.md` (DECIDED) {#p01-modifier-algebra}

**Decision:** Chord assignment follows two base tiers — **⌘ the universal tier** (verbs any Mac user knows + highest-frequency Tug verbs; digits are places) and **⌃⌘ the Tug tier** (Tug's own machinery: surfaces, shades, modes, themes, app-specific features) — and two operators that keep the key and add a modifier: **⇧ = the counterpart** (reverse / widen / undo) and **⌥ = the variant** (same verb, altered object or form). Composition gives every other set its meaning: ⌥⇧⌘ = both twists ("…as Plain Text"), ⌃⇧⌘ = counterpart of a Tug-tier command, ⌃⌥⌘ = variant/advanced form of a Tug-tier command (the "super-advanced" tier). Plain ⌥ and plain ⌃ letters are closed forever (glyph typing; the caret's emacs set), with ⌥⇥ and ⌃` grandfathered non-printing exceptions.

**Rationale:**
- Consistency, clarity, explainability — every chord's shape becomes a one-sentence derivation instead of a memorized fact.
- The algebra was already half-latent in shipped bindings (⌘V→⌥⌘V→⌥⇧⌘V; ⌘Z→⇧⌘Z; ⌘W→⌥⌘W), so adopting it moves few chords.

**Implications:**
- Spec S01 fixes the document's contents; the [L30] entry and `commands.md` gain cross-links so "Adding a command" step 1 includes picking the tier.
- Rules codified alongside: the pairing rule (a composed chord shares its key with its base), the arrows exemption (⌘/⌥⌘-arrow families have no letter base; ⇧ still means "to the extreme"), the scarcity rule (plain ⌘'s free slots — D, Y, J, E + punctuation — go only to many-times-an-hour commands), and ⌘. parity ([P05]).

#### [P02] Nine chords move in one commit, defaults only (DECIDED) {#p02-chord-moves}

**Decision:** Apply Table T01 as registry-default edits (plus Swift construction-literal twins and pinned-test transcriptions). User overrides are untouched; no migration.

**Rationale:**
- Overrides are per-command lists in tugbank where *absent means registry default* — a default move is exactly the case the override design already absorbs.
- One commit keeps the drift-test transcription honest: the test pins what shipped, and the commit that moves a chord is the commit that re-transcribes the pin.

**Implications:**
- Four Swift literals change in `buildMenuBar()` (`session.toggleChanges`, `session.toggleHistory`, `session.permissionMode.cycle`, `view.nextTheme`); `session.insertFile` needs no Swift edit (its `keyEquivalent` is `""` at construction; ⌘I arrives via the registry sweep and will arrive as ⌃⌘I the same way).
- Freed defaults returned to the pool and recorded in `chord-tiers.md`: ⇧⌘P, ⇧⌘C, ⇧⌘H, ⇧⌘M, ⌥⌘T, ⌘I.

#### [P03] Claim All / Disclaim All are first-responder commands scoped to the composer, gated on commit mode (DECIDED) {#p03-claim-commands}

**Decision:** Two new `TUG_ACTIONS` (`claim-all-changes`, `disclaim-all-changes`), two new `COMMANDS` entries with `routing: "first-responder"` and default bindings ⌃⌘A / ⌃⇧⌘A carrying `scope: { kind: "responder", responderId: COMPOSER_RESPONDER_SCOPE }`. `tug-prompt-entry.tsx` registers them via `useKeybindings` beside the existing `COMMIT_AUTO_MESSAGE` registration (same `commitActive` gate, chords read from `keymapRegistry.bindingsOf(...)`, never spelled again). `session-card.tsx` handles both in its `useResponder` actions map (the map that already holds `TOGGLE_CHANGES_VIEW`), calling `changesController.claim(paths)` / `changesController.disclaim(paths)`.

**Rationale:**
- The Changes shade is a **passive** sheet — the composer keeps focus while it is up (`session-changes-view.tsx` module doc) — so the composer's responder is where the chords are genuinely live; this follows the `commit-auto-message` registration precedent, which `commands.md` names as the sanctioned scoped pattern.
- ⌃⌘A joins the Changes neighborhood (⌃⌘C shade, ⌃⌘M message, ⌃⌘A claim); ⌃⇧⌘A is the ⇧-counterpart of ⌃⌘A per the algebra, one finger from its pair.

**Implications:**
- **Registration and handling live in different components, unlike `commit-auto-message`.** That command registers *and* handles in `tug-prompt-entry.tsx` (the `commitKeybindings` memo and the composer's own actions map). These two register there — same gate, same `bindingsOf` projection — but handle in `session-card.tsx`, because the card is the only component holding `changesController`. The chain makes this work: the composer's responder sits below the card's, so a first-responder action the composer does not claim falls through to the card (the walk documented at `session-card.tsx`'s card-content responder). The split is deliberate; the gate is where the surface is, the semantics are where the controller is.
- **Semantics — ⌃⌘A is a composite verb, deliberately stronger than either shade button.** The shade wires *two* bulk buttons (`onClaimAllUnattributed` and `onClaimAllOrphaned` in `session-changes-view.tsx`); the chord claims both buckets at once: `changesController.claim([...snap.unattributed, ...snap.orphaned].map(f => f.path))`. A single keyboard verb whose meaning is "make everything claimable in front of me mine" is worth more than a chord that mirrors one of two buttons and leaves the user to reach for the mouse for the other; the buttons remain the granular path. Disclaim All = `changesController.disclaim(snap.entry.files.map(f => f.path))`.
- **The pair is not an inverse on one set** — ⌃⌘A acts on what is *not yet* this session's, ⌃⇧⌘A on what *is*. ⇧-as-counterpart is carrying "the opposite bulk verb of this shade," not "the same set, reversed." `chord-tiers.md` records that reading so the algebra is not later read as promising set-inversion.
- Handlers no-op when the relevant path list is empty or a claim/disclaim round-trip is pending (read the phase non-reactively from `changeset-verb-store` by `changesController.entryKey`, the same store `useChangesetClaim`/`useChangesetDisclaim` wrap).
- Door coverage: bindings are the door (no `menuItemId`), so `lintCommandTable` passes without `internal`. The keymap pane shows them as scoped, non-rebindable rows — the existing `[Q03]` stance.
- `command-routing-drift.test.ts` also carries a routing-expectation map (near the top of the file, `[TUG_ACTIONS.TOGGLE_CHANGES_VIEW]: "key-card"` etc.); add rows for both new ids as `"first-responder"`.

#### [P04] Next Theme's chord enters the registry (DECIDED) {#p04-next-theme-registry}

**Decision:** `next-theme` (today: registry entry with `menuItemId: "view.nextTheme"`, **no bindings** — the ⌥⌘T chord exists only as a Swift construction literal) gains a registry binding: ⌃⌘T with `menuEligible: true, preventDefault: true`. The Swift literal updates to ⌃⌘T as the pre-first-push default.

**Rationale:**
- [L30]: a chord that exists only as a Swift literal is invisible to the keymap pane, to overrides, and to `resolveChord`.
- Verified in `host-menu-state.ts`: an entry that is **not** `mirrored` still gets a chord claim in the push when `keymapRegistry.menuChords()` claims its menu item — so a binding alone suffices; no `mirrored`/gate work needed.

**Implications:** Next Theme becomes rebindable and appears in the keymap pane's View group for free (the row model groups by menu-item-id namespace).

#### [P05] ⌘. parity is a matcher change; routing stays per-surface (DECIDED) {#p05-cancel-matcher}

**Decision:** Add one exported helper in `keymap-registry.ts` — `isCancelChordEvent(event)` — that returns true when the event matches any `cancel-dialog` binding **except** Escape (`chordMatchesEvent` from `chord-format.ts` over `keymapRegistry.bindingsOf(TUG_ACTIONS.CANCEL_DIALOG)`, skipping `chord.key === "Escape"`). The five hand-matching components call it in place of their literal `metaKey && key === "."` predicates; each keeps its documented dismissal action and propagation posture unchanged. Escape stays exactly where it is today (engine ladder for alert/sheet/context-menu; local for placard).

**Rationale:**
- The five handlers are *not* naive bypasses — each documents why chain routing is unreliable for its surface (portaled popover whose buttons never promote; placard outside any focus mode). The [L30] defect is only the authored chord match, which also mis-matches by `event.key` label instead of `code` identity.
- Excluding Escape from the helper prevents the conversions from stealing Escape from the engine's ladder on surfaces that deliberately don't handle it locally.

**Implications:**
- A user rebind of Cancel updates every surface at once — the whole point of the funnel.
- `tug-editor-context-menu.tsx`'s extra `ctrlKey` alternative (`metaKey || ctrlKey`) is dropped: the registry chord is the one truth.

#### [P06] Parity scope: dismissal yes, field-revert no (DECIDED) {#p06-parity-scope}

**Decision:** ⌘. mirrors ⎋ wherever ⎋ *dismisses a surface or backs out of a mode* (alerts, sheets, popovers, placards, context menus, overlays, lightboxes). ⎋ that *reverts an in-field edit* (`tug-filter-field`, `tug-value-input`, `tug-slider`) stays Escape-only: that ⎋ is form-control currency inside a typing surface, and ⌘. there would be both surprising and outside macOS convention. This line is written into `chord-tiers.md`.

**Rationale:** The user's directive is "everywhere we now support escape usages to cancel, dismiss sheets and alerts, etc." — dismissal semantics. Field-revert is the one ⎋ family with different semantics (edit the value, not leave the surface).

**Implications:** The parity audit (List L01) classifies every non-engine ⎋ handler found by grep; included surfaces gain the helper, excluded ones get nothing.

#### [P07] One global design decision, D126 (DECIDED) {#p07-d126}

**Decision:** Append **D126** to `tuglaws/design-decisions.md` in the house style (bold-statement paragraph, trailing law/decision citations): the adoption of the chord-tier algebra, the Table T01 moves, the two new commands, and ⌘. parity — citing [L30], [D117] (the stale at0253 note), and superseding the chord spellings embedded in **D122–D125** prose without editing those entries.

**[D124] is the entry D126 most directly supersedes** and must be named: it is where ⇧⌘P was given to Prompt Route, where `CYCLE_PERMISSION_MODE` was moved to ⌃⌘P "in *both* doors … because either alone leaves the menu bar swallowing the chord," and where ⌃⌘S/B/C/G/H were deleted "which is what leaves the ⌃⌘ band free." D126 is spending exactly the band D124 cleared, and re-homing both chords D124 placed — the continuity is the point, so it is stated rather than left for a reader to reconstruct. [D125] is named too, as the entry that retired the ⌃⌘C `!changes` alias whose stale comment this plan removes.

---

### Deep Dives {#deep-dives}

#### Where chords live and how they reach surfaces {#chord-plumbing}

- **Defaults** are `bindings` arrays on entries in `tugdeck/src/components/tugways/command-registry.ts` (the `COMMANDS` array), built by the `chord()` helper (global scope) or written literally for scoped bindings (`COMPOSER_RESPONDER_SCOPE`). There is no separate keymap data file.
- **Matching identity** is `KeyboardEvent.code` + the four modifier flags; `label` is display-only (`chord-format.ts`: `chordMatchesEvent`, `formatChord`, `codeToKeyEquivalent`).
- **The push:** `keymapRegistry.menuChords()` returns `Record<menuItemId, ChordSpec | null>` from the first `menuEligible` binding per entry; `host-menu-state.ts` folds it into the menuState `commands` block. Key fact verified for [P04]: a non-`mirrored` entry still receives a chord claim when its menu item is claimed (`if (!mirrored && !(menuItemId in chords)) continue;` — presence in `chords` is sufficient).
- **Swift side:** `applyCommandChords(in:)` in `tugapp/Sources/AppDelegate.swift` walks the menu tree writing `keyEquivalent` + mask from each gate's three-state chord (`.absent` keeps the construction literal, `.detach` clears, `.apply` writes). Construction literals in `buildMenuBar()` are pre-first-push defaults only — but they should still be edited to the new chords so a cold-start menu bar never flashes stale chords.
- **Display:** every UI surface renders via `commandShortcut(id)` (`keymap-registry.ts`) — e.g. `tug-prompt-entry.tsx` tooltip for the Changes toggle, `shell-interactive-staging.ts`, `help-content.ts`. These update automatically; no authored strings exist for the moved chords outside comments.

#### The five ⌘. hand-matchers {#cancel-cluster}

| File | Current match | Dismissal path (KEPT) | Notes |
|---|---|---|---|
| `tug-alert.tsx` (content `onKeyDown`) | `e.metaKey && e.key === "."` | `handleOpenChange(false)` | Escape is engine-ladder via `onEscapeDismiss`; Radix Escape suppressed |
| `tug-confirm-popover.tsx` (`handleKeyDown`) | same | `manager.sendToTarget(responderId, CANCEL_DIALOG)` (identity-routed; documented why first-responder routing is unreliable for the portaled popover) | Bubble-phase after the capture keybinding listener |
| `tug-sheet.tsx` (`handleKeyDown`) | same | `requestCancel()` | Escape engine-owned |
| `tug-placard.tsx` (document capture listener) | `key === "Escape" \|\| (key === "." && metaKey)` | `onCloseRef.current()`; deliberately does not preventDefault/stopPropagation | Keeps its local Escape (placards push no focus mode); becomes `key === "Escape" || isCancelChordEvent(e)` |
| `tug-editor-context-menu.tsx` (window capture) | `e.key === "." && (e.metaKey \|\| e.ctrlKey)` | `dismiss()` with preventDefault+stopPropagation | Drops the ctrl alternative per [P05] |

#### ⎋-surface parity audit seed {#escape-audit}

Grep basis: `key === "Escape"` handlers outside `__tests__` and outside modifier-guard contexts. Classification per [P06]:

**List L01: parity audit** {#l01-parity-audit}
- INCLUDE (dismissal): `dev-error-overlay.ts` (overlay dismiss), `src/components/tugways/body-kinds/image-block.tsx` (lightbox), `src/lib/markdown/enhance-img.ts` (image overlay), `tug-text-editor/completion-extension.ts` (completion popup dismiss — see the shape note below).
- EXCLUDE (in-flight revert / field-revert / engine-owned / archive): `tug-filter-field.tsx`, `tug-value-input.tsx`, `tug-slider.tsx` (revert semantics, [P06]); `cards/gallery-mutation-tx.tsx` — its Escape sends `PREVIEW_HUE` with `phase: "cancel"`, aborting an in-flight scrub, which is the *same* revert family as the slider and not a dismissal; `responder-chain-provider.tsx` and `focus-act.ts` (the engine's own Escape plumbing — ⌘. already reaches the funnel as a global `cancel-dialog` binding); `settings-keymap-body.tsx` (chord-capture UI — ⎋/⌘. there are *recordable input*, never dismissal); `src/_archive/**` (dead).
- **Shape note for `completion-extension.ts`:** its Escape is not a branch you can sit beside. The handler builds a `consumes` boolean from an `||` chain of `event.key` comparisons and then runs `switch (event.key)`. ⌘. needs a term in the `consumes` chain *and* a predicate branch taken before the switch — a `case "."` would match `event.key`, which is precisely the label-vs-`code` mis-match [P05] exists to end. The branch tests `isCancelChordEvent(event)`, never a key label.
- The implementer re-runs the grep at execution time and classifies any new hits by the same rule; the rule, not this snapshot, is the contract.

#### Tests that pin the moved chords {#pinned-tests}

A pin is spelled one of three ways, and no single grep sees all three: as a **glyph** (`"⇧⌘C"` in a comment, a title, or an `expect(…).toBe`), as a **code-plus-modifiers literal** (`{ code: "KeyP", metaKey: true, ctrlKey: true }` — how every app-test drives a chord), or as a **generated doc region** diffed by a test. The list below is the union of all three sweeps.

**List L02: every pin the moves disturb** {#l02-pins}

*Unit (tugdeck):*
- `__tests__/command-routing-drift.test.ts` — `SHIPPED_CHORDS` (chord → command-id pairs resolved through the real pipeline) pins ⇧⌘P (prompt route), ⌃⌘P (cycle permission), ⇧⌘C, ⇧⌘H; also a routing-expectation map keyed by `TUG_ACTIONS`. Update the four rows, add ⌃⌘T → `next-theme` (it gains a global binding) and ⌃⌘I → `insert-file`. Note the loop skips non-global bindings (`if (binding.scope.kind !== "global") continue;`), so the composer-scoped commands cannot be pinned here — they get routing-map rows only.
- `__tests__/keybinding-map.test.ts` — the "the two P chords" describe block **asserts both P chords through `matchChord`**: ⇧⌘P must resolve to `select-composer-route:prompt` and ⌃⌘P to `cycle-permission-mode`. After the move both assertions are wrong, in opposite directions — ⇧⌘P resolves to nothing and ⌃⌘P resolves to the *prompt route*. Re-transcribe both tests and the module docblock's "permission cycling lives on ⌃⌘P — ⇧⌘P is the composer's Prompt route" sentence; the "bare ⌘P matches neither" and Tab cases stand unchanged.
- `__tests__/keymap-registry.test.ts` — two tests pin ⇧⌘M: one asserts `formatChord(binding.chord)` is `"⇧⌘M"` for `COMMIT_AUTO_MESSAGE`, the next builds a `KeyM` meta+shift event to prove a scoped chord stays out of the global layer. Both become ⌃⌘M (`ctrlKey: true`, `shiftKey: false`).
- `__tests__/text-editing-menu-shortcuts.test.ts` — `expect(entry.shortcut).not.toBe("⇧⌘C")` still passes (Copy as Plain Text is ⌥⇧⌘C), but its docblock rationale — "⇧⌘C … is Session ▸ Show Changes" — goes stale the moment ⇧⌘C is free. Comment-only.
- `__tests__/chord-format.test.ts` — uses ⌃⌘P as a *formatting* fixture (`formatChord({key:"KeyP", ctrl:true, meta:true})`). It asserts nothing about which command holds it. **Leave alone.**

*App-tests:*
- `at0168-menu-structure.test.ts` — `STATIC_ITEMS` pins `session.permissionMode.cycle` (`p`, command|control → command|control|option) and `session.insertFile` (`i`, command → command|control). Neither shade toggle nor `view.nextTheme` is pinned there (View is dynamic; the shade items aren't in the static table).
- `at0340-composer-routes.test.ts` — *drives* ⇧⌘C (×4) and ⇧⌘P (×3) via `pressChord`; update every drive to ⌃⌘C / ⌃⌘P, plus the docblock's numbered scenario list and the assertion text that names the chords.
- `at0177-permission-cycle-keys.test.ts` — drives `("KeyP", "p", { meta: true, ctrl: true })`. Becomes `{ meta: true, ctrl: true, alt: true }`. The file is *named* for this chord; check its docblock too.
- `at0088-permission-mode-chip.test.ts` — an inline `new KeyboardEvent("keydown", { code: "KeyP", …, metaKey: true, ctrlKey: true })`. Same modifier addition.
- `at0220-settings-chips-turn-lock.test.ts` — the `PRESS_CYCLE` constant, same shape, same addition.
- `at0339-session-find-bar.test.ts` — drives `("KeyC", "c", { meta: true, shift: true })` to reach Changes. Becomes ⌃⌘C.
- `at0253-commit-dialog.test.ts` — comment-only reference to the old ⇧⌘C collision (Risk R01).
- `at0179-dynamic-keybinding.test.ts`, `at0181-keymap-chord-sweep.test.ts`, `at0182-keymap-override.test.ts` — read the registry dynamically and carry no literal for any moved chord (both sweeps come back clean). Expected to pass unchanged.

*Generated doc region:*
- `tuglaws/menus.md` — the `<!-- generated:chords -->` table is regenerated and **diffed** by `__tests__/menus-doc.test.ts`, which fails on any drift. Six rows change in Step 2 (⇧⌘C, ⇧⌘H, ⇧⌘M, ⇧⌘P, ⌃⌘P, ⌘I) and two rows are added in Step 3. Regenerate in place with `TUG_WRITE_MENUS_DOC=1 bun test src/components/tugways/__tests__/menus-doc.test.ts` and commit the doc with the registry change — never hand-edit the region.

**The two sweeps** (run both; the first cannot see what the second finds):
- Glyphs — `grep -rn '⇧⌘C\|⇧⌘H\|⇧⌘P\|⇧⌘M\|⌥⌘T\|⌃⌘P' tugdeck/src tests/app-test tugapp/Sources tuglaws` (`tuglaws/` is in scope for this plan's prose sweep; `design-decisions.md` is excluded by [P07]). Fix the hits describing the moved commands; leave ⌥⇧⌘C / ⌥⇧⌘V alone.
- Modifier literals — `grep -rn '"Key[CHMPIT]"' tests/app-test tugdeck/src` and read each hit's modifier record.

#### Comment debt riding the moves {#comment-debt}

Stale prose to update in the same commits (comments state what the code does — no history, per repo comment rules). The glyph sweep finds all of these; the list is what it currently returns, so a hit not below is a new one to classify by the same rule.

*tugdeck source:*
- `command-registry.ts` `select-composer-route:prompt` entry comment ("promoting ⇧⌘P would take a plain letter chord…") — rewrite for ⌃⌘P citing chord-tiers.
- `command-registry.ts` `commit-auto-message` comment ("⇧⌘M, live only while…") → ⌃⌘M.
- `action-vocabulary.ts` — four comments: `TOGGLE_CHANGES_VIEW` "Bound to ⇧⌘C", `SELECT_COMPOSER_ROUTE` "⇧⌘P for `\"prompt\"`", `CYCLE_PERMISSION_MODE` "Bound to ⌃⌘P", and the commit-mode "the ⇧⌘P route select" note. Missed by the original sweep list; the vocabulary is where a reader looks first for what a verb is bound to.
- `keymap-registry.ts` — the collision-lint comment naming "the commit surface's ⇧⌘M" and the shadowing docblock's "Copy as Plain Text advertised ⇧⌘C while ⇧⌘C was Show Changes" (that example loses its subject once ⇧⌘C is free — re-point it at the ⌃⌘C pair or drop the second clause).
- `session-card.tsx` — the `TOGGLE_CHANGES_VIEW` / `TOGGLE_HISTORY_VIEW` handler comments (including the **stale "⌃⌘C alias"** mention: that alias was deleted with the bang layer and the comment outlived it), the ⇧⌘P route-select comment, the ⌃⌘P permission-cycle comment, and the three commit-mode entry-point comments naming ⇧⌘C.
- `tug-prompt-entry.tsx` — "⇧⌘M invokes Auto-Message", the "⇧⌘M scoped binding" [L02] note, the "⇧⌘M and the pencil-sparkles button are two doors" handler comment, and the "⇧⌘C over a typed prompt stashes" / commit-entry-path comments.
- `session-changes-view.tsx` module doc and header comment ("⇧⌘C is the toggle" / "dismissed by ⇧⌘C") → ⌃⌘C.
- `responder-chain-provider.tsx` and `responder-chain.ts` — both name ⌃⌘P as the permission cycle in their focus/key-card comments → ⌃⌥⌘P.
- `action-dispatch.ts` — "matching the ⌃⌘P cycle" → ⌃⌥⌘P.
- `cards/gallery-tooltip.tsx` — an authored `shortcut="⇧⌘P"` demo prop. It is gallery furniture, not a live binding, but it is a chord the app no longer has; give it a chord that still exists.
- `internal/tug-popup-menu.tsx` — a `"⇧⌘C"` docstring example for the presentational `shortcut` prop. Same treatment.
- `lib/help-content.ts` and `lib/shell-interactive-staging.ts` render chords via `commandShortcut` — verify no authored chord strings; update label text only if a literal appears.

*tuglaws prose* (outside `design-decisions.md`, which [P07] leaves alone):
- `turn-lifecycle.md` (three places), `tuglaws.md` [L07]/[L02] discussion, and `app-test-inventory.md` (two summaries) all say **⇧⌘P cycles the permission mode**. That is already wrong on main — the cycle has been ⌃⌘P since [D124] — and becomes doubly wrong here. Correct them to ⌃⌥⌘P.
- `route-lifecycle.md`'s `SELECT_ROUTE` row lists "⇧⌘C / ⇧⌘S / ⇧⌘B / ⇧⌘F", three of which left with the bang layer. Reduce it to the surviving route chord.

---

### Specification {#specification}

**Table T01: Chord moves and additions** {#t01-chord-moves}

| Command id | Entry today | New default binding (code + flags, label) | Swift literal edit |
|---|---|---|---|
| `select-composer-route:prompt` | `KeyP` meta+shift | `KeyP` ctrl+meta, label "p" | none (no menu item) |
| `cycle-permission-mode` | `KeyP` ctrl+meta | `KeyP` ctrl+alt+meta, label "p" | `session.permissionMode.cycle`: mask `[.command,.control]` → `[.command,.control,.option]` |
| `toggle-changes-view` | `KeyC` meta+shift | `KeyC` ctrl+meta, label "c" | `session.toggleChanges`: `[.command,.shift]` → `[.command,.control]` |
| `toggle-history-view` | `KeyH` meta+shift | `KeyH` ctrl+meta, label "h" | `session.toggleHistory`: `[.command,.shift]` → `[.command,.control]` |
| `commit-auto-message` | `KeyM` meta+shift, composer-scoped | `KeyM` ctrl+meta, label "m", same scope | none (no menu item) |
| `next-theme` | **no bindings** (Swift literal ⌥⌘T only) | ADD `KeyT` ctrl+meta, label "t", `menuEligible`, `preventDefault` | `view.nextTheme`: `[.command,.option]` → `[.command,.control]` |
| `insert-file` | `KeyI` meta, `menuEligible` | `KeyI` ctrl+meta, label "i", keep `menuEligible`+`preventDefault` | none (construction `keyEquivalent` is `""`) |
| `claim-all-changes` (NEW) | — | `KeyA` ctrl+meta, label "a", composer-scoped, `preventDefault` | none |
| `disclaim-all-changes` (NEW) | — | `KeyA` ctrl+meta+shift, label "a", composer-scoped, `preventDefault` | none |

All moved global bindings keep their existing `preventDefault`/`menuEligible` options unless the table says otherwise. Freed defaults: ⇧⌘P, ⇧⌘C, ⇧⌘H, ⇧⌘M, ⌥⌘T, ⌘I.

**Spec S01: `tuglaws/chord-tiers.md` contents** {#s01-chord-tiers-doc}

Transcribe Part 1 of `dash/keyboard-command-cleanup-brief.md` into tuglaws house style (italic thesis line up top, `*Cross-references:*` line citing [L30], commands.md, menus.md, design-decisions.md; no hard-wrapped prose):
1. The algebra — two base tiers, two operators, the composed sets with their one-liners, closed sets with the two grandfathered exceptions.
2. The six rules: pairing, arrows exemption, scarcity, closed sets, ⌘. parity (with the [P06] dismissal-vs-revert line), menu-placement-is-a-chord-decision (cite commands.md four-layer resolution).
3. The free-pool ledger: plain-⌘ free letters ranked with convention caveats (D, Y safest; J, E claimable; B, U, P reserved with reasons; punctuation ⌘' ⌘; ⌘\ free; ⌘[ ⌘] reserved for navigation), digits taken, and the six freed chords from Table T01.
4. The macOS never-bind list (from #assumptions).
5. Known anomalies: Cascade/Tile ⌃⌥ ([Q02] deferral), the ⌥⌘/ DevTools wink, ⌘T maker-debug-only, and **the shade toggles' un-detachable menu claim** — `toggle-changes-view` / `toggle-history-view` carry a non-`menuEligible` registry binding *and* a Swift construction literal, so `menuChords()` never claims `session.toggleChanges` / `session.toggleHistory` and never publishes the `null` that would detach it. A user rebind of either command therefore leaves the old chord standing on the menu item, where AppKit keeps eating it. Pre-existing and not introduced here, but it is the one place where "every chord is the user's to move" is not yet true end-to-end, so the doctrine doc names it rather than letting a reader infer otherwise.
6. Cross-links back: commands.md "Adding a command" gains a tier-selection clause; [L30]'s law text in tuglaws.md gains a pointer sentence; INDEX.md gains a one-line entry.

**Spec S02: `isCancelChordEvent`** {#s02-cancel-matcher}

```ts
// chord-format.ts — widened parameter, same body
export type ChordEventFields = Pick<KeyboardEvent, "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">;
export function chordMatchesEvent(event: ChordEventFields, chord: Chord): boolean

// keymap-registry.ts
export function isCancelChordEvent(event: ChordEventFields): boolean
```
Returns true iff the event matches any binding of `TUG_ACTIONS.CANCEL_DIALOG` whose `chord.key !== "Escape"`, via `chordMatchesEvent`. Reads the singleton `keymapRegistry` so overrides apply. No Escape matching — Escape ownership is per-surface ([P05]).

`chordMatchesEvent` is declared `(event: KeyboardEvent, …)` today while reading only those five fields, so a `Pick<…>` argument will not typecheck against it. Widen the *matcher's* parameter to `ChordEventFields` rather than casting at each call site: the cast would be a lie repeated five times, and the widening is what lets one predicate serve native listeners and React synthetic events alike (React's `KeyboardEvent` is structurally compatible on all five). The existing `KeyboardEvent` callers are unaffected — a `KeyboardEvent` satisfies the narrower type.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| (none new) | — | Chord moves are registry data edits; claim/disclaim handlers call the existing `ChangesRouteController` + `changeset-verb-store`; scoped bindings ride the existing `useKeybindings` registration in `tug-prompt-entry.tsx` | [L02] (stores already wired), [L30] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tuglaws/chord-tiers.md` | The modifier-algebra doctrine (Spec S01) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `TUG_ACTIONS.CLAIM_ALL_CHANGES` | const `"claim-all-changes"` | `tugdeck/src/components/tugways/action-vocabulary.ts` | [P03]; name per action-naming.md |
| `TUG_ACTIONS.DISCLAIM_ALL_CHANGES` | const `"disclaim-all-changes"` | same | |
| `claim-all-changes` / `disclaim-all-changes` entries | `CommandEntry` ×2 | `command-registry.ts` | first-responder routing, composer-scoped bindings (Table T01) |
| 7 edited `bindings` | data | `command-registry.ts` | Table T01 moves |
| `isCancelChordEvent` | fn | `keymap-registry.ts` | Spec S02 |
| `ChordEventFields` + widened `chordMatchesEvent` | type + signature | `chord-format.ts` | Spec S02; existing `KeyboardEvent` callers unaffected |
| Claim/disclaim action handlers | entries in `useResponder` actions map | `cards/session-card.tsx` | beside `TOGGLE_CHANGES_VIEW`; call `changesController` |
| Scoped-binding registration | extend the `commitKeybindings` memo | `tug-prompt-entry.tsx` | same `commitActive` gate, `bindingsOf` both new ids |
| 4 `keyEquivalent`/mask literals | data | `tugapp/Sources/AppDelegate.swift` (`buildMenuBar`) | Table T01 rightmost column |
| `SHIPPED_CHORDS` + routing map rows | test data | `__tests__/command-routing-drift.test.ts` | List L02 |
| P-chord pins ×2 + docblock | test edits | `__tests__/keybinding-map.test.ts` | List L02 — both assertions invert |
| ⇧⌘M pins ×2 | test edits | `__tests__/keymap-registry.test.ts` | List L02 |
| `isCancelChordEvent` pins | new tests | `__tests__/keymap-registry.test.ts` | matches ⌘., refuses ⎋, follows an override |
| `STATIC_ITEMS` rows ×2 | test data | `tests/app-test/at0168-menu-structure.test.ts` | permissionMode.cycle, insertFile |
| Chord drives | test edits | `at0340`, `at0177`, `at0088`, `at0220`, `at0339` | List L02 |
| `generated:chords` region | generated doc | `tuglaws/menus.md` | `TUG_WRITE_MENUS_DOC=1`; pinned by `menus-doc.test.ts` |
| **D126** | decision entry | `tuglaws/design-decisions.md` | [P07] |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/chord-tiers.md` (Spec S01)
- [ ] `tuglaws/commands.md` — cross-link in the Chords section + Cross-References list + "Adding a command" step 1 tier clause
- [ ] `tuglaws/tuglaws.md` — one pointer sentence in [L30]; correct the ⇧⌘P permission-cycle mention in the [L07]/[L02] discussion ([#comment-debt])
- [ ] `tuglaws/INDEX.md` — one-line entry
- [ ] `tuglaws/design-decisions.md` — D126
- [ ] `tuglaws/menus.md` — the `generated:chords` region, **regenerated not hand-edited** (`TUG_WRITE_MENUS_DOC=1`), in Step 2 and again in Step 3
- [ ] `tuglaws/turn-lifecycle.md`, `tuglaws/app-test-inventory.md`, `tuglaws/route-lifecycle.md` — stale chord prose ([#comment-debt])

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (bun)** | Registry lints, drift-test chord/routing transcriptions, the P-chord and ⇧⌘M pins, keymap-row projection for the new scoped commands, and new `isCancelChordEvent` pins | Steps 2–4 |
| **App-test (selective)** | Native menu chord masks (at0168), end-to-end chord drives (at0340, at0177, at0088, at0220, at0339), keymap sweep/override invariants (at0181/at0182) | Step 2, integration |
| **Drift Prevention** | `SHIPPED_CHORDS` re-transcription is the new pin; `menus-doc.test.ts` holds `tuglaws/menus.md` to the registry; `lintActionCoverage` forces the new actions into the table | Steps 2–3 |

#### What stays out of tests {#test-non-goals}

- End-to-end app-test of ⌃⌘A/⌃⇧⌘A claiming real changeset entries — the app-test replay workspace's changeset entries are transient (~2s), so long Changes-shade flows are not app-testable by standing precedent; coverage is the registry/unit layer (dispatch + lints + row projection) plus the existing Rust round-trip tests for claim/disclaim verbs.
- jsdom render tests and mock-store assertions — banned patterns.
- Re-testing the five converted surfaces' dismissal behaviors — unchanged routing; only the match predicate moved. Coverage is the grep criterion, the existing suites, and the `isCancelChordEvent` unit pins: the predicate is the only thing that changed, so the predicate is the only thing that needs a new test.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Doctrine: chord-tiers.md, D126, cross-links | done | (this run) |
| #step-2 | Chord moves: registry, Swift literals, pinned tests | done | (this run) |
| #step-3 | Claim All / Disclaim All commands | done | (this run) |
| #step-4 | ⌘. matcher + parity sweep | done | (this run) |
| #step-5 | Integration checkpoint | done | (verification only) |

#### Step 1: Doctrine — chord-tiers.md, D126, cross-links {#step-1}

**Commit:** `tuglaws(chord-tiers): adopt the modifier algebra for chord assignment; D126`

**References:** [P01] modifier algebra, [P06] parity scope, [P07] D126, Spec S01, [Q02] deferral, (#context, #documentation-plan)

**Artifacts:**
- `tuglaws/chord-tiers.md`; edits to `commands.md`, `tuglaws.md` ([L30]), `INDEX.md`, `design-decisions.md` (D126).

**Tasks:**
- [ ] Author `tuglaws/chord-tiers.md` per Spec S01, sourcing content from `dash/keyboard-command-cleanup-brief.md` Part 1; include Table T01's moves as the worked example and the freed-pool ledger.
- [ ] Add the cross-links (commands.md Chords section + Cross-References + Adding-a-command step 1; tuglaws.md L30 pointer; INDEX.md line).
- [ ] Append D126 to `design-decisions.md` in house style ([P07]); do not edit D122–D124 prose.

**Tests:**
- [ ] None (docs); links resolve by inspection.

**Checkpoint:**
- [ ] Every relative link in the new/edited docs resolves (`grep -o '\](\S*\.md[^)]*)' tuglaws/chord-tiers.md` and open each; anchors named in this plan exist).

---

#### Step 2: Chord moves — registry, Swift literals, pinned tests {#step-2}

**Depends on:** #step-1

**Commit:** `tugways(keymap): move seven chords onto the chord-tier algebra`

**References:** [P02] chord moves, [P04] next-theme registry, Table T01, Risk R01, (#chord-plumbing, #pinned-tests, #comment-debt)

**Artifacts:**
- Edited `bindings` on seven entries in `command-registry.ts`; four Swift literals in `AppDelegate.swift`; every pin in List L02; the regenerated `tuglaws/menus.md` chord table; the comment/prose updates in [#comment-debt].

**Tasks:**
- [ ] Apply Table T01's seven move/add rows (all but the two NEW commands) in `command-registry.ts`, updating the entry comments listed in [#comment-debt].
- [ ] Edit the four `buildMenuBar()` literals (Table T01 rightmost column) in `tugapp/Sources/AppDelegate.swift`.
- [ ] Update `SHIPPED_CHORDS` (⌃⌘P prompt-route, ⌃⌥⌘P cycle-permission, ⌃⌘C, ⌃⌘H; add ⌃⌘T next-theme and ⌃⌘I insert-file rows) in `command-routing-drift.test.ts`.
- [ ] Re-transcribe the two unit pins the original sweep missed: `keybinding-map.test.ts`'s "the two P chords" block (both assertions invert — see List L02) and `keymap-registry.test.ts`'s two ⇧⌘M cases. Update both files' docblocks.
- [ ] Update `STATIC_ITEMS` in `at0168-menu-structure.test.ts` (permissionMode.cycle mods, insertFile mods).
- [ ] Update every app-test chord drive in List L02: `at0340` (⇧⌘C→⌃⌘C ×4, ⇧⌘P→⌃⌘P ×3, plus docblock and assertion text), `at0177`, `at0088`, `at0220` (⌃⌘P→⌃⌥⌘P), `at0339` (⇧⌘C→⌃⌘C); refresh the stale at0253 comment (Risk R01).
- [ ] Regenerate the `tuglaws/menus.md` chord table: `cd tugdeck && TUG_WRITE_MENUS_DOC=1 bun test src/components/tugways/__tests__/menus-doc.test.ts`, then re-run it bare to confirm it diffs clean. Commit the doc with the registry change.
- [ ] Run **both** sweeps from [#pinned-tests] — glyphs (including `tuglaws/`) and modifier literals — and fix every remaining hit describing a moved chord (leave ⌥⇧⌘C / ⌥⇧⌘V and `chord-format.test.ts`'s formatting fixture alone).
- [ ] Rebuild Tug.app (Swift changed) so app-tests exercise the new literals.

**Tests:**
- [ ] `cd tugdeck && bun test src/components/tugways/__tests__/` — the whole tugways unit slice, not the two files: the moves reach `keybinding-map`, `keymap-registry`, and `menus-doc` as well as the drift test.
- [ ] `just app-test-select` first — the derived selection is driven by `@covers`, and `AppDelegate.swift` is a broad target, so read what it picked before running it. Then `just app-test-changed` (at0168, at0340, at0177, at0088, at0220, at0339 must all be in it; if any is missing, name it explicitly on the command line).

**Checkpoint:**
- [ ] Full tugways unit slice green; `menus-doc.test.ts` diffs clean with no pending rewrite; `bunx vite build` succeeds; `just app-test-changed` VERDICT PASS.

---

#### Step 3: Claim All / Disclaim All commands {#step-3}

**Depends on:** #step-2

**Commit:** `tugways(changes): Claim All ⌃⌘A and Disclaim All ⌃⇧⌘A as registry commands`

**References:** [P03] claim commands, [Q01] gate, Table T01 (NEW rows), (#symbols, #state-zone-mapping)

**Artifacts:**
- Two `TUG_ACTIONS` constants; two `COMMANDS` entries; extended `commitKeybindings` memo in `tug-prompt-entry.tsx`; two handlers in `session-card.tsx`; drift-test routing rows.

**Tasks:**
- [ ] Add `CLAIM_ALL_CHANGES`/`DISCLAIM_ALL_CHANGES` to `action-vocabulary.ts` (kebab-case per action-naming.md, placed in the vocabulary's session/changes grouping).
- [ ] Add the two `CommandEntry` rows (Table T01 NEW rows): `routing: "first-responder"`, titles **"Claim All Changes"** / **"Disclaim All Changes"**, composer-responder-scoped bindings, `preventDefault: true`; entry comments state the commit-mode gate and the shade-button twinning.
- [ ] Extend the `commitKeybindings` memo in `tug-prompt-entry.tsx` to also map `bindingsOf` both new ids (same `commitActive` gate, same KeyBinding projection).
- [ ] Add both handlers to the `useResponder` actions map in `cards/session-card.tsx` (beside `TOGGLE_CHANGES_VIEW` — the card, not the composer, because the card holds `changesController`; the composer's unhandled action falls through to it): compute paths per [P03] semantics from `changesController.getSnapshot()` — Claim All takes `snap.unattributed` **and** `snap.orphaned` together — guard on empty paths and on a pending claim/disclaim phase read non-reactively from `changeset-verb-store` by `changesController.entryKey`, then call `changesController.claim(paths)` / `.disclaim(paths)`.
- [ ] Add the two routing-expectation rows in `command-routing-drift.test.ts` (routing map only — the `SHIPPED_CHORDS` loop skips non-global bindings).
- [ ] Regenerate the `tuglaws/menus.md` chord table again: the two new scoped bindings add rows (the table carries scoped chords — `⇧⌘M … JS, responder` is the precedent).

**Tests:**
- [ ] `command-registry.test.ts` (lints: door coverage sees bindings; `lintActionCoverage` sees both wires) and `command-routing-drift.test.ts` green.
- [ ] Unit-verify the keymap-pane projection in `src/components/tugways/cards/__tests__/settings-keymap-rows.test.ts` (the file exists): `buildKeymapRows` output includes both commands, `scoped: true` on each binding, grouped under `UNGROUPED` ("Other Commands") since neither has a `menuItemId`.

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/components/tugways/__tests__/ src/components/tugways/cards/__tests__/` green — the second path is where the keymap-row test lives; `bunx vite build` succeeds; manual smoke in the debug app: with the Changes shade up, ⌃⌘A claims the unattributed **and** orphaned buckets and ⌃⇧⌘A disclaims the session entry.

---

#### Step 4: ⌘. matcher + parity sweep {#step-4}

**Depends on:** #step-1

**Commit:** `tugways(cancel-chord): registry-backed ⌘. matcher; parity on dismissal surfaces`

**References:** [P05] cancel matcher, [P06] parity scope, Spec S02, List L01, (#cancel-cluster, #escape-audit)

**Artifacts:**
- `isCancelChordEvent` in `keymap-registry.ts`; five converted components; parity additions on List L01's INCLUDE surfaces.

**Tasks:**
- [ ] Widen `chordMatchesEvent` to `ChordEventFields` in `chord-format.ts`, then implement `isCancelChordEvent` per Spec S02.
- [ ] Convert the five surfaces in [#cancel-cluster], preserving each dismissal path and propagation posture exactly; drop the context menu's `ctrlKey` alternative.
- [ ] Re-run the ⎋ grep from [#escape-audit], classify per [P06], and add the matcher beside the Escape branch on each INCLUDE surface (dev-error-overlay, the two image-overlay paths, the completion popup). `gallery-mutation-tx.tsx` is EXCLUDE — its Escape aborts an in-flight scrub, which is revert, not dismissal.
- [ ] For `completion-extension.ts`, follow the shape note in [#escape-audit]: a term in the `consumes` chain **and** a predicate branch ahead of the `switch (event.key)`, testing `isCancelChordEvent(event)` — never a `case "."`.
- [ ] Verify no literal ⌘. match remains: `grep -rn 'key === "\."\|code === "Period"' tugdeck/src --include='*.ts*'` returns only `keymap-registry.ts`/`chord-format.ts`/registry data.

**Tests:**
- [ ] New unit pins for `isCancelChordEvent` in `__tests__/keymap-registry.test.ts` (pure logic over the registry, no DOM): a ⌘. event matches; an ⎋ event does **not** (the exclusion is the whole reason the engine keeps its ladder); a registry carrying a user override of `cancel-dialog` matches the override's chord and not the default. Three assertions, and each one is a way the helper could be silently wrong.
- [ ] Existing suites for the five surfaces stay green (no behavioral change intended).

**Checkpoint:**
- [ ] Grep criterion above holds; the `isCancelChordEvent` pins green; `bunx vite build` succeeds; manual smoke: ⌘. closes an alert, the confirm popover, a sheet, a placard, and the editor context menu; ⌘. dismisses the completion popup and an image lightbox; ⎋ still aborts a gallery hue scrub and ⌘. does not.

---

#### Step 5: Integration Checkpoint {#step-5}

**Depends on:** #step-2, #step-3, #step-4

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #test-plan-concepts)

**Tasks:**
- [ ] Confirm every success criterion in [#success-criteria], including the keymap pane visually showing the new tier layout (Settings ▸ Keyboard) and the Session/View menus showing ⌃⌘C/⌃⌘H/⌃⌥⌘P/⌃⌘T/⌃⌘I.
- [ ] Re-run both sweeps from [#pinned-tests] one last time across the whole working diff — a comment added during Steps 3–4 can reintroduce an old spelling.

**Tests:**
- [ ] `cd tugdeck && bun test src/components/tugways/__tests__/ src/components/tugways/cards/__tests__/ src/lib/__tests__/` — the tugways unit slice **plus** `cards/__tests__/`, where `settings-keymap-rows.test.ts` lives (the slice alone misses it), plus `lib/__tests__/` for `host-menu-state.test.ts`: it pins no moved chord today, but [P04] changes what `menuChords()` publishes for `view.nextTheme`, and this is the step that verifies the whole projection rather than a file list.

**Checkpoint:**
- [ ] `bunx vite build` clean; `menus-doc.test.ts` diffs clean; `just app-test-changed` VERDICT PASS across the full working diff.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** The chord-tier doctrine on paper in `tuglaws/`, all nine chord moves/additions live through the registry with menus/keymap-pane/tests agreeing, and ⌘. behaving as ⎋'s twin on every dismissal surface.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] All five steps `done` in the ledger with commits recorded (user lands them).
- [ ] Success criteria in [#success-criteria] each verified.
- [ ] [Q02] recorded as deferred in `chord-tiers.md`'s anomalies section.

**Acceptance tests:**
- [ ] `command-routing-drift.test.ts`, `command-registry.test.ts`, `keybinding-map.test.ts`, `keymap-registry.test.ts`, `menus-doc.test.ts`, `settings-keymap-rows.test.ts` green.
- [ ] `just app-test-changed` VERDICT PASS.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] The systematic menu-by-menu command audit (names, tiers, menuEligible/scope per chord, free-pool grants).
- [ ] Cascade/Tile ⌃⌥ re-home ([Q02]).
- [ ] `ACTIONS_OUTSIDE_THE_TABLE` review of the CM6 ⌘↩ submit and ⌘↑↓ history handlers.

| Checkpoint | Verification |
|------------|--------------|
| Doctrine linked | chord-tiers.md reachable from commands.md, tuglaws.md [L30], INDEX.md |
| Chords moved end-to-end | every List L02 pin green: at0168, at0340, at0177, at0088, at0220, at0339, drift, keybinding-map, keymap-registry |
| Doc region regenerated | `menus-doc.test.ts` diffs clean with no pending `TUG_WRITE_MENUS_DOC` rewrite |
| New commands live | keymap-pane rows + manual ⌃⌘A/⌃⇧⌘A smoke |
| ⌘. parity | grep criterion + `isCancelChordEvent` unit pins + manual smoke across the six surfaces |
