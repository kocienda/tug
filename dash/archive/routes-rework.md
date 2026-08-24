## Routes Rework — retire the `!` layer, surface the two real routes {#routes-rework}

**Purpose:** Retire the `!` bang layer entirely and replace it with the two routes the composer actually has — **Prompt** and **Changes** — surfaced as a two-item `TugChoiceGroup` in Z4A, while Find lifts out of the composer into a ⌘F find bar above Z2 and `!btw` / `!shell` demote to ordinary slash commands.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-03 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

The composer's Z4A slot currently holds a filled accent `!` button opening a `TugPopupMenu` of four "bang routings" — `!shell` ⌃⌘S, `!btw` ⌃⌘B, `!find` ⌃⌘G, `!history` ⌃⌘H — backed by `tugdeck/src/lib/bang-commands.ts` (registry + `matchBangCommandLine`, whose fallthrough makes `!<anything>` a shell escape hatch). That design was minted in `883216849` when the sticky routes were demoted (`8243cb1d6`), replacing an earlier `TugChoiceGroup` of three routes (`361b29eec`).

Daily use has settled which of those are real. `!history` has never been used and its shade has a better door (⇧⌘H / Session ▸ History). `!shell` is largely obsolete: the shell-line classifier (`lib/shell-line-classifier.ts` + `lib/shell-grammar-store.ts`) now auto-routes a typed command line to the shell without a prefix. `!find` is hobbled by a non-standard chord and by living inside the prompt editor at all. Meanwhile the *most* useful route — Changes — is not in the `!` list at all, because committing is a `CommitModeController` mode rather than a routing, reachable only by ⇧⌘C / `/commit` / Session ▸ Commit…. And `!btw` appears in two places (the `!` menu and the Z2 BTW status cell).

So the routing concept survives but the access pattern is wrong. There are exactly two things that own the composer as a whole — typing a prompt, and authoring a commit — and those become two visible tabs. Everything else is a one-shot verb (a slash command) or belongs outside the composer entirely (find).

#### Strategy {#strategy}

- **Add every replacement door before removing any old one.** The find bar and the `/shell` / `/btw` commands land first; the bang layer is deleted only once nothing depends on it. No commit in this plan leaves a capability unreachable.
- **Find first.** ⌘F is already plumbed end-to-end in Tug.app; the Session card just never registered a `FIND` responder. Landing the bar before the bang retirement means ⌃⌘G's removal costs nothing.
- **Extract, don't rebuild.** `TextCardFindBar` is already the shared find face composed over a `FindSession`; its only Text-card-specific part is a ~25-line engine delegate. The Session bar is that component with a different engine.
- **The Changes tab already exists mechanically.** `CommitModeController` swaps the composer document on enter/exit and persists the message durably. The choice group *renders* that state rather than owning any state of its own, so every existing enter/exit path moves the tab for free.
- **One atomic Z4A swap.** The bang button's removal and the choice group's arrival are one step, so the slot is never empty in a landed commit and the keyboard focus-cycle registration (`routeFocusGroup` / `routeFocusOrder`) never lapses.
- **Docs and tests trail the behavior**, in their own steps, so a behavior step is never blocked on prose.

#### Success Criteria (Measurable) {#success-criteria}

- `rg -n 'bang' tugdeck/src --type ts --type tsx` returns no hits outside deleted-file history; `tugdeck/src/lib/bang-commands.ts` does not exist. (grep)
- Typing `!` at position 0 in the composer opens no popup and submits as literal prose to Claude. (app-test)
- ⌘F on a frontmost Session card opens the find bar and lands the caret in its query field; Edit ▸ Find… validates *enabled* (not greyed) on a frontmost Session card. (app-test + manual menu check)
- With the find bar open, typing a term paints transcript matches, ⌘G advances, ⇧⌘G retreats, Escape closes the bar and dissolves the highlights, and a subsequent ⌘F reopens with the previous query pre-filled and selected. (app-test)
- Z4A renders no route control at all in the Component Gallery, where `TugPromptEntry` has no `CommitModeController`. (manual — Maker ▸ New Component Gallery Card)
- Z4A shows a two-segment control reading **Prompt | Changes**; clicking Changes raises the Changes shade and turns the composer into the commit-message editor; clicking Prompt restores the stashed prompt draft verbatim. (app-test)
- ⇧⌘C, ⇧⌘P, `/changes`, `/prompt`, Session ▸ Show Changes, `/commit`, Escape-in-commit-mode all leave the Z4A selection agreeing with `CommitModeController.getSnapshot().active`. (app-test)
- `/shell echo hi` lands a settled shell exchange row; `/btw <q>` opens the BTW placard and adds zero transcript entries. (app-test)
- ⇧⌘P selects the Prompt tab; ⌃⌘P cycles the permission mode, from both the tugdeck binding and Session ▸ Permission Mode ▸ Cycle. (app-test + manual)
- `cd tugdeck && bunx tsc --noEmit && bunx vite build` clean. (command)

#### Scope {#scope}

1. Delete the bang layer: registry, matcher, Z4A `!` button + popup, the `!` completion trigger, the ⌃⌘S/B/G/H/C chip chords, the session card's `bangCommandSurfaces`, and every doc/test reference.
2. Demote `!shell` → `/shell` and `!btw` → `/btw` as arg-taking local slash commands with their existing dispatch surfaces unchanged.
3. Delete `!history` (route only). The History shade, ⇧⌘H, Session ▸ History, and the `/tugplug:history` skill are untouched.
4. Extract a shared `TugFindBar` from `TextCardFindBar`; mount it in the Session card above Z2, opened by ⌘F.
5. Replace the Z4A `!` button with a two-item `TugChoiceGroup` (Prompt | Changes) bound to `CommitModeController`.
6. Add `/prompt` and `/changes` tab-switching slash commands; move the permission-mode cycle to ⌃⌘P and give ⇧⌘P to the Prompt tab.
7. Update `tuglaws/design-decisions.md` [D97]'s zone table, add a global design decision for the two-route model, refresh `lib/help-content.ts`, and update/retire the affected unit tests and app-tests.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Retiring the History shade, ⇧⌘H, Session ▸ History, or `/tugplug:history` (decided: route only — see [P04]).
- Any change to the shell auto-router (`lib/shell-line-classifier.ts`, `lib/shell-grammar-store.ts`) or to what it classifies.
- Any change to the find *engine* — `FindSession`, `TranscriptFindEngine`, `transcript-search-index.ts`, `transcript-search.ts`, the CSS Custom Highlight painter, `FindWrapOverlay`, `FindTargetRegistry`. Only the front door moves.
- A third tab, or any per-tab draft beyond the one commit mode already keeps.
- A `/find` slash command — ⌘F is the door ([P12]).
- A Swift Session ▸ Show Prompt menu item (listed as a follow-on in [#roadmap]).
- Renaming `CommitModeController` or its files to "changes route" vocabulary; the user-visible word is "Changes", the internal name stays.

#### Dependencies / Prerequisites {#dependencies}

- None external. Every mechanism this plan composes already ships: `TugChoiceGroup`, `TugEntryShell`, `TugFindCluster`, `FindSession`, `CommitModeController`, the responder chain's `FIND` action, and the Swift Edit ▸ Find… round-trip.

#### Constraints {#constraints}

- **Warnings are errors** in the Rust workspace; this plan touches no Rust, but `bunx tsc --noEmit` must stay clean.
- **`bunx vite build` must pass before any tugdeck change is called done** — the debug app loads the production rollup bundle, and an import that works under dev esbuild can hang the app at the splash screen.
- **App-tests are selective**: `just app-test-changed` derives the run from the working diff via `@covers`. Never run the full corpus. Any new test must carry `@covers` (`just app-test-covers-check` enforces it).
- **[L02]** external state enters React only through `useSyncExternalStore`; **[L06]** appearance changes go through CSS/DOM, never React state; **[L03]** registrations events depend on use `useLayoutEffect`; **[L11]** controls dispatch actions and the owning responder applies them.
- Only the user commits to git, except where a step is executed under explicit autonomous authorization.

#### Assumptions {#assumptions}

- ⌃⌘P is free: it appears in neither `keybinding-map.ts` (verified — the only ctrl+meta entries are `KeyS`/`KeyB`/`KeyC`/`KeyG`/`KeyH`, all deleted by this plan) nor any `AppDelegate.swift` `keyEquivalent`, and macOS claims no system chord there.
- ⇧⌘P becomes free at the menu bar once Session ▸ Permission Mode ▸ Cycle moves, so the tugdeck binding will receive it in Tug.app.
- The shell auto-router is good enough that a misclassified line is rare and `/shell` is a sufficient override.
- `/shell` and `/btw` are not in the `isHiddenSlashCommand` allowlist (`lib/slash-supported.ts`) — `lib/__tests__/slash-supported.test.ts` currently asserts they are "not local, not hidden" — so adding them to `LOCAL_SLASH_COMMANDS` is sufficient to make them match and dispatch.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

Standard devise-skeleton conventions apply: explicit `{#anchor}` headings, plan-local decisions labelled `[P01]`…, global decisions cited as `[D##]`, no line-number citations.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Does the find bar's flow insertion disturb transcript scroll position? (OPEN) {#q01-find-bar-scroll}

**Question:** The find bar mounts as a flow sibling between `.session-view-slot` and `.session-card-status-bar`, so opening it shrinks the transcript viewport by the bar's height. Does the transcript's follow-bottom / scroll-anchoring behavior ([D07]) absorb that cleanly, or does the view jump?

**Why it matters:** A jump at the exact moment the user asks to search is the worst possible time for one — it moves the content they are about to search through. If flow insertion jumps, the bar must instead float over the transcript's bottom edge (absolute, above Z2), which changes the CSS but not the component.

**Options (if known):**
- Flow sibling (shrinks the transcript) — matches the Text card's docked bar and the [D97] zone rhythm.
- Absolute overlay pinned above Z2 (covers the transcript's last rows) — no reflow, but occludes content.

**Plan to resolve:** Build it flow-first in [#step-2] and watch a real card with the transcript scrolled to bottom and to a mid-point. `SessionTranscriptHost` already handles Z2 telemetry growth without repositioning the scroll ([D97] states the transcript pane is a flex column sized so Z2 growth takes space the list cedes), which is the same geometry, so flow is the informed default rather than a coin flip.

**Resolution:** RESOLVED — **flow sibling**, shipped in [#step-2]. The bar is a direct child of `.session-card-top-column` with `flex: 0 0 auto`, so the view slot (`flex: 1 1 auto`, `min-height: 0`) cedes the height, exactly as it already does for Z2 telemetry growth. The scroller's `scrollTop` is untouched by the insertion, so a mid-scroll transcript keeps its top edge anchored and only loses viewport height from the bottom; a bottom-pinned transcript is held by [D07] follow-bottom. The overlay fallback is not needed, so [P07]'s coexistence claim stands unchanged. Record the placement in the [D97] amendment written by [#step-6].

#### [Q02] Should the Changes tab be disabled when the project is not a git repository? (OPEN) {#q02-changes-tab-disabled}

**Question:** `TugChoiceGroup` supports a per-item `disabled`. Should the Changes segment grey out when there is nothing commitable (no repo / no changeset)?

**Why it matters:** A tab that always looks live but opens an empty shade is mildly dishonest; a tab that greys out unpredictably is worse. `evaluateCommitLandGate` in `lib/commit-mode-controller.ts` already computes an ordered land-gate reason, so the data exists.

**Plan to resolve:** Ship it always-enabled in [#step-4] (the current ⇧⌘C behavior is unconditional entry — the `TOGGLE_CHANGES_VIEW` handler in `session-card.tsx` calls `commitModeController.enter()` regardless of whether there are changes) and revisit only if the empty state reads badly.

**Resolution:** DEFERRED — always-enabled matches today's ⇧⌘C semantics exactly, so shipping it is a no-op rather than a guess. Revisit alongside the Changes empty-state polish noted in [#roadmap].

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Losing `!` as a force-to-shell override strands a misclassified command | med | med | `/shell <cmd>` ships in [#step-3], *before* the bangs are removed | A misroute the user hits more than once a week |
| ⌘F never reaches the web view in Tug.app | high | low | The chain already round-trips `find`; the only missing piece is a responder ([#deep-dive-cmd-f]) | Edit ▸ Find… validates disabled on a session card |
| Moving the permission cycle off ⇧⌘P breaks muscle memory | low | high | Both doors move together (chord + Swift menu), and the Session ▸ Permission Mode submenu shows the new chord | User reaches for ⇧⌘P and gets the Prompt tab |
| Z4A focus-cycle ring breaks when the button is swapped | med | med | The swap is atomic in [#step-4] and `TugChoiceGroup` accepts the same `focusGroup` / `focusOrder` props the button used | ⌥⇥ cycling skips or traps at Z4A |
| Two `FindWrapOverlay` mounts on the Session card | low | med | The bar mounts the overlay; the card's own mount is removed in the same step ([#step-2]) | A doubled wrap graphic on wrap |

**Risk R01: The bang retirement lands before a replacement door** {#r01-capability-gap}

- **Risk:** Deleting `bang-commands.ts` in a commit that precedes `/shell`, `/btw`, or the find bar leaves a shipped build where a capability has no door at all.
- **Mitigation:**
  - Step order is fixed: find bar ([#step-1], [#step-2]) → `/shell` + `/btw` ([#step-3]) → bang retirement and the Z4A swap together ([#step-4]).
  - [#step-4]'s checkpoint explicitly re-verifies each replacement door in the running app before the deletion is called done.
- **Residual risk:** ⌘/ changes meaning between [#step-4] and nothing else — it repoints from the retired bang picker to the `/` completion in the same step ([P09]), so there is no window where it is dead.

**Risk R02: `matchBangCommandLine` removal changes what reaches Claude** {#r02-submit-path}

- **Risk:** The submit path in `tug-prompt-entry.tsx` currently runs `matchBangCommandLine(commandLine) ?? matchLocalSlashCommand(commandLine)`. Removing the first half means any line starting with `!` now flows to `send()` as prose. A user who types `!ls` out of habit sends "!ls" to Claude instead of running it.
- **Mitigation:**
  - This is the intended behavior — `!` returns to being ordinary text.
  - The auto-router still classifies a bare `ls` to the shell, so the muscle-memory path (`ls`) works better than the bang path did.
- **Residual risk:** One turn burned on a habit-typed `!cmd`. Accepted; no notice surface is added for it (a `!`-specific notice would be a vestige, which [P02] forbids).

---

### Design Decisions {#design-decisions}

#### [P01] The composer has exactly two routes: Prompt and Changes (DECIDED) {#p01-two-routes}

**Decision:** The composer's Z4A slot holds a two-item `TugChoiceGroup` — **Prompt** and **Changes** — and these are the only routes. A route is defined as *a mode that owns the composer's whole document*; anything that does not own the document is a one-shot verb (a slash command) or lives outside the composer entirely.

**Rationale:**
- That definition is the one the code already obeys: `CommitModeController` is the only thing that swaps the editor document (stashing the prompt draft in `preCommitDraftRef` and restoring it verbatim on exit). `!shell` / `!btw` / `!find` / `!history` never did — they consumed one submission and cleared.
- Calling those four "routings" was the original error; they are verbs wearing a routing's sigil.
- Two segments is the honest count, and a segmented control is the right control for a small closed set with one selected at a time.

**Implications:**
- The choice group is *controlled* by `CommitModeController` state — it holds no state of its own, so ⇧⌘C, `/commit`, the Session menu, a successful land, Escape, and a shade self-close all move the selection without any extra wiring.
- **No controller means no group.** `TugPromptEntry`'s `commitMode?: CommitModeController` prop is optional and `cards/gallery-prompt-entry.tsx` renders the entry without one (and without `findSession` or `routeFocusGroup`). Because the group is a *view of the controller*, Z4A renders it only when `commitMode !== undefined` and renders nothing otherwise — a two-segment control whose Changes half cannot act would be a resting lie in the Component Gallery.
- `lib/route-constants.ts`'s `DEFAULT_ROUTE` (`"❯"`, the prompt-history key) is unaffected — prompt history stays keyed to the one Prompt route, and commit messages persist separately in the changeset draft store.

#### [P02] The bang layer retires with no vestige (DECIDED) {#p02-bang-retirement}

**Decision:** `tugdeck/src/lib/bang-commands.ts` is deleted along with every consumer: the Z4A `!` button and its `TugPopupMenu`, `BANG_PICKER_ICONS` / `COMMAND_PICKER_ITEMS`, the `bangCommandCompletionProvider` and its `"!"` trigger registration, the ⌃⌘S/B/G/H chip-seed chords and the ⌃⌘C `!changes` alias, `bangCommandSurfaces`, the submit-path `matchBangCommandLine` call, the `isBangCommand` sigil branches in `lib/command-atom.ts` and `lib/slash-commands.ts`, and the `SHOW_SLASH_COMMAND_NOTICE` branch that teaches `/shell` → `!shell`. A leading `!` becomes ordinary prose.

**Rationale:**
- Two command namespaces with two sigils was a tax paid on every surface: the picker, the completion popup, the chip label, the reconstructed command line, the help text, and the unknown-command notice each carried a bang branch.
- With routings reduced to two tabs and verbs reduced to slash commands, there is exactly one namespace left, so the second sigil has nothing to distinguish.
- "No vestige" is explicit: no `!` notice, no `!`-to-`/` redirect, no deprecation shim. The redirect currently points the wrong way (`SHOW_SLASH_COMMAND_NOTICE` teaches users that `/shell` "moved" to `!shell`) and simply goes.

**Implications:**
- `buildSlashCommandLine` always writes the `/` sigil for a `command` atom; `chipDisplayLabel` always renders a command chip without a bang.
- `matchLocalSlashCommand` becomes the sole submit-path matcher.
- The unit tests in `tugdeck/src/__tests__/slash-commands.test.ts` (its `bang routings (matchBangCommandLine)` describe block) and `tugdeck/src/lib/__tests__/slash-supported.test.ts` (its "the bang routings left the slash inventory entirely" test) invert: those names are now *in* the slash inventory.

#### [P03] `!shell` and `!btw` demote to arg-taking local slash commands (DECIDED) {#p03-slash-demotions}

**Decision:** `/shell <command>` and `/btw <question>` are added to `LOCAL_SLASH_COMMANDS` in `tugdeck/src/lib/slash-commands.ts` with `takesArgs: true`, and their surfaces in `session-card.tsx` are the existing `bangCommandSurfaces.shell` / `.btw` bodies moved verbatim into `slashCommandSurfaces`.

**Rationale:**
- Both are one-shot verbs — exactly what a slash command is.
- `/shell` is the deliberate net under the auto-router: the classifier decides by default, and a user who knows better can force it. Keeping an explicit override costs one registry entry and removes the "what if it misroutes" objection to deleting `!shell`.
- `/btw`'s duplication resolves itself: with the `!` menu gone, the Z2 BTW status cell is the one *place* BTW lives, and `/btw` is merely how you ask. The cell is the answer surface; the command is the question surface. That is one feature with two organs, not two doors.

**Implications:**
- The usage cautions change text (`"Usage: !shell <command> (or just !<command>)"` → `"Usage: /shell <command>"`; `"Usage: !find <query>"` is deleted with `!find`).
- `/shell` and `/btw` now appear in the `/` completion popup, which is a discoverability gain over the `!` popup they left.
- The `slashCommandSurfaces` record is exhaustive over `LocalCommandName`, so adding the registry entries without the surfaces is a compile error — the type system enforces the pairing.

#### [P04] `!history` is deleted; the History shade is untouched (DECIDED) {#p04-history-route-only}

**Decision:** The `history` bang registry entry, its ⌃⌘H chord, and `bangCommandSurfaces.history` are deleted. `ShadeViewController`'s `"history"` view, ⇧⌘H (`TOGGLE_HISTORY_VIEW`), Session ▸ Show History, `SessionHistoryView`, and the `/tugplug:history` skill all remain exactly as they are.

**Rationale:**
- The route was the unused part; the shade has a working door and a Swift menu item.
- The `!history <question>` variant (wrapping the question in `/tugplug:history` and sending it on the record) has a direct replacement the user already has: type `/tugplug:history <question>` in the composer, which is a real Claude slash command.

**Implications:**
- The mutual-exclusion line `commitModeController.exit()` before `shadeViewController.show("history")` survives in the `TOGGLE_HISTORY_VIEW` handler; only the copy inside the deleted `bangCommandSurfaces.history` goes.
- With the Prompt/Changes tab bound to commit-mode state ([P01]), toggling History still exits commit mode and therefore still snaps the tab back to Prompt — correct, and free.

#### [P05] `/prompt` and `/changes` switch tabs; every other slash command leaves the tab alone (DECIDED) {#p05-slash-tab-switching}

**Decision:** `/prompt` and `/changes` are added to `LOCAL_SLASH_COMMANDS` (no args) and durably switch the Z4A selection — `/prompt` calls `commitModeController.exit()`, `/changes` calls `commitModeController.enter()`. No other slash command changes the selected tab.

**Rationale:**
- This is what "`/` is a typing accelerator to change tabs" means concretely: the tab names are typeable, and typing one moves you there and leaves you there.
- Making tab-switching a *property of two specific commands* rather than of the `/` key means `/model`, `/rewind`, `/btw` and the rest keep their one-shot semantics — a verb runs and you are where you were.
- `/changes` and `/commit` coexist without redundancy: `/commit [message]` enters with a seed message (an act of committing); `/changes` is the bare tab switch (an act of looking).

**Implications:**
- `/changes` while already on Changes is a no-op — `enter()` / `exit()` are idempotent against the controller's own `active` flag.
- It is the only `LOCAL_SLASH_COMMANDS` entry whose effect is a *mode* rather than a surface, which is the honest reading: it selects a route.

**AMENDED DURING IMPLEMENTATION — `/prompt` is not shipped.** This decision assumed `/prompt` would be typeable from the Changes route. It is not, and the reason is [P01] itself: the Changes route *owns the composer's document*, so `performSubmit` lands the message verbatim and returns **before** the slash-command interception runs. Nothing typed in Changes is read as a command. That leaves `/prompt` reachable only from the Prompt route, where it names the route you are already on — a registered command that can never act, which is a resting lie in the `/` popup. `/changes` is unaffected (it is typed from Prompt, where commands do run) and ships. The ways back from Changes are ⇧⌘P, ⇧⌘C, the Z4A tab, and Escape — four doors, none of them typed. Pinned by `at0340-composer-routes.test.ts` and by a `matchLocalSlashCommand("/prompt") === null` unit assertion.

#### [P06] Find lifts out of the composer into a ⌘F bar above Z2 (DECIDED) {#p06-find-bar}

**Decision:** Transcript find is reached by ⌘F, which opens a find bar mounted between the transcript view slot and the Z2 status bar in `session-card.tsx`. `!find` and its ⌃⌘G chord are deleted. The `TugFindCluster` that today renders conditionally in Z4B (gated on `findActive`) moves into the bar.

**Rationale:**
- ⌘F is the chord every application has used for decades; ⌃⌘G was chosen only to dodge a fullscreen-chord collision that never applied to ⌘F itself.
- Find is not a thing you *say to Claude*, so routing it through the prompt editor's submit path was a category error — it made find a submission, which is why it needed a dissolve-on-next-submit rule and an Escape-when-empty rule inside the composer.
- Putting the query in its own field means the query and the prompt draft stop competing for one document.
- The geometry matches the Changes shade's bottom edge and the Text card's docked bar: a strip immediately above the status bar.

**Implications:**
- Three composer behaviors are deleted as vestiges: the submit-path "dissolve lingering find highlights before dispatch" block, the empty-editor Escape branch that clears the find session before the pane-collapse gesture, and the `findActive &&` cluster render in Z4B.
- `FIND_NEXT` / `FIND_PREVIOUS` stay registered on the `TugPromptEntry` responder (gated on `count > 0`, route-independent) so ⌘G cycles with the caret in the composer, *and* the bar registers its own pair so ⌘G works with the caret in the query field. Per [P13] both are live only while the bar is open, since nothing clears the session but closing the bar.
- The Session card's standalone `FindWrapOverlay` mount is removed — the bar mounts one, and a find is only live while the bar is open.

#### [P07] The find bar is not a shade; it coexists with Changes and History (DECIDED) {#p07-find-not-a-shade}

**Decision:** The find bar is a flow sibling above `.session-card-status-bar`, outside `.session-view-slot` and outside `ShadeViewController`'s `"none" | "changes" | "history"` union. Its open/closed state is structural React state in `SessionCardBody`, independent of the shade.

**Rationale:**
- Making find a third shade value would force it to be mutually exclusive with Changes, so ⌘F would silently dismiss a commit message in progress — unacceptable.
- Living outside the view slot means the shades (which are bottom-anchored to the transcript region and `modalScopeSelector`-scoped to the transcript pane) now rise from the top of the *find bar* when it is open. They stack naturally: transcript / find bar / Z2.
- It matches the Text card, where the find bar is a docked flow sibling, not an overlay.

**Implications:**
- The Escape ladder gains a rung, ordered by proximity: with the caret in the query field the bar's own `Prec.high` CM6 Escape closes the bar first; the shade's Escape and the pane-collapse gesture are unchanged and unreachable from inside the bar.
- No `ShadeViewController` change at all.

#### [P08] ⇧⌘P selects Prompt; the permission-mode cycle moves to ⌃⌘P (DECIDED) {#p08-chords}

**Decision:** ⇧⌘P selects the Prompt tab. `CYCLE_PERMISSION_MODE` moves from ⇧⌘P to ⌃⌘P in **both** doors: the `keybinding-map.ts` entry and the Swift `Session ▸ Permission Mode ▸ Cycle Permission Mode` menu item's `keyEquivalent` modifier mask in `tugapp/Sources/AppDelegate.swift`. ⇧⌘C keeps toggling Changes.

**Rationale:**
- ⇧⌘P was genuinely taken — this was found during design, not assumed — and the user chose to move the incumbent rather than give up the P mnemonic for Prompt.
- Both doors must move together or the Swift menu keeps swallowing ⇧⌘P at the menu bar and the tugdeck binding never fires.
- ⌃⌘P sits in the ⌃⌘ band this plan is simultaneously vacating (⌃⌘S/B/C/G/H all retire), so the band stays coherent rather than becoming a graveyard.

**Implications:**
- A new action `SELECT_COMPOSER_ROUTE` (payload `"prompt" | "changes"`) is added to `action-vocabulary.ts` and handled on the session card's `card-content` responder. ⇧⌘P binds it with `value: "prompt"`, `scope: "key-card"`, `preventDefaultOnMatch: true`.
- ⇧⌘C keeps its existing `TOGGLE_CHANGES_VIEW` action and handler untouched — it is a toggle, and with two tabs a toggle is also a complete round-trip, so no Prompt-specific Swift menu item is needed.

#### [P09] ⌘/ repoints from the bang picker to the `/` completion (DECIDED) {#p09-cmd-slash}

**Decision:** ⌘/ keeps its `OPEN_COMMAND_PICKER` action but its meaning becomes "focus the editor and open the slash-command completion popup" — implemented by seeding a leading `/` through the existing `seedCommandChip`-adjacent path rather than by synthesizing an Enter keydown on a Radix trigger.

**Rationale:**
- ⌘/ is worth keeping as the keyboard door to command discovery; only its target is stale.
- The current implementation is a workaround for Radix (`trigger.focus()` then a synthetic bubbling `Enter`, because a programmatic `.click()` fires no pointerdown). With the popup menu gone, that workaround goes with it and the implementation becomes a plain editor insert.
- The action name still reads true — it opens a command picker, just the `/` one.

**Implications:**
- `TugPromptEntryDelegate.openCommandPicker` survives with a new body; `pickerTriggerRef` is deleted.
- The `"/"` completion provider is position-0 gated (`wrapPositionZero`), so seeding a `/` into an empty document opens the popup and seeding into a non-empty one correctly does not.

#### [P10] `TugFindBar` is extracted from `TextCardFindBar` and takes its `FindSession` as a prop (DECIDED) {#p10-find-bar-extraction}

**Decision:** A new shared component `TugFindBar` (`tugdeck/src/components/tugways/tug-find-bar.tsx`) owns everything `TextCardFindBar` owns today *except* `FindSession` construction and the engine delegate, which move to the host. `TextCardFindBar` becomes a thin wrapper that constructs the CM6-engine session (its existing `documentFindEngine`) and renders `TugFindBar`; the Session card passes its already-constructed `findSession`.

**Rationale:**
- The Session card constructs its `FindSession` at card scope (seeded from persisted find options) and hands it to `SessionTranscriptHost`, which binds `TranscriptFindEngine` to it. That session must outlive the bar, so the bar cannot own construction.
- The Text card's session is bar-scoped and is cleared on unmount. Keeping that ownership in the wrapper means the Text card's behavior is bit-for-bit unchanged by the extraction.
- Everything else is genuinely shared: the `TugEntryShell` + `TugTextEditor` + `TugFindCluster` + ↑/↓ composition, the `Prec.high` Enter / Shift-Enter / Escape keymap, the `updateListener` query mirror, focus-on-mount, the `{focusQuery, refreshCount}` imperative handle, the `FIND` / `FIND_NEXT` / `FIND_PREVIOUS` responder, and `FindWrapOverlay`.

**Implications:**
- `TugFindBar` props: `session: FindSession`, `onClose: () => void`, `cardRootRef: React.RefObject<HTMLElement | null>`, `placeholder: string`, `data-testid?: string`.
- `TugFindBar` does **not** clear its session on unmount — session lifetime is the host's business. `TextCardFindBar` keeps its `useEffect(() => () => session.clear(), [session])`; the Session card clears on close.
- The Text card's `TextCardFindBarHandle` forwards to `TugFindBar`'s handle unchanged, so `text-card.tsx`'s `openFindBar` / `closeFindBar` and `tug-text-card-editor.tsx`'s `FIND` responder need no edits.

#### [P11] The Session card registers `FIND`; no Swift change is needed for ⌘F (DECIDED) {#p11-find-responder}

**Decision:** ⌘F is claimed by registering a `FIND` handler on the session card's `card-content` responder. The only other edit is adding `preventDefaultOnMatch: true` to the existing browser-dev ⌘F entry in `keybinding-map.ts`.

**Rationale:**
- See [#deep-dive-cmd-f]: the chord is already plumbed end to end and menu enablement is already derived from chain validation. The missing piece is one handler.
- Adding `preventDefaultOnMatch` suppresses the browser's native find in dev; in Tug.app AppKit has already consumed the chord at the menu bar, so the flag is inert there.

**Implications:**
- Edit ▸ Find… stops validating disabled on a frontmost Session card the moment the handler exists — no `host-menu-state.ts` edit.
- The handler is idempotent: closed → open the bar; open → `focusQuery()` on the bar's imperative handle (matching the Text card's ⌘F-while-open behavior).

#### [P12] There is no `/find` slash command (DECIDED) {#p12-no-slash-find}

**Decision:** Find gets exactly one door — ⌘F (plus Edit ▸ Find… and ⌘G/⇧⌘G for navigation). No `/find` is added to `LOCAL_SLASH_COMMANDS`.

**Rationale:**
- The whole point of [P06] is that find stops being a submission. A `/find <query>` command would reintroduce the composer-as-search-box shape through a different sigil.
- ⌘F is more discoverable than any slash command, being the universal chord.

**Implications:**
- Users with `!find` muscle memory get nothing on `/find` — it falls through to the [D14] unknown-command notice, which is the correct and honest outcome ([P02]: no vestige).

#### [P13] Closing the find bar ends the search; the query survives to the next ⌘F (DECIDED) {#p13-find-session-lifetime}

**Decision:** Closing the find bar calls `findSession.clear()` — highlights dissolve and ⌘G / ⇧⌘G go inert. The **query text** is remembered on the card and pre-filled (and fully selected) when ⌘F next opens the bar. The bar's lifetime is the search's lifetime.

**Rationale:**
- This must be decided explicitly rather than inherited. Today's transcript contract is the *opposite*: `!find` deliberately leaves live matches after clearing the composer, which is why `TugPromptEntry`'s `FIND_NEXT` / `FIND_PREVIOUS` handlers are gated on `count > 0` rather than on any route. That behavior existed only because find *was* a submission — there was no bar to keep open, so the matches had to outlive the gesture. With a persistent bar, "keep it open to keep cycling" is the natural affordance and the old rule loses its reason to exist.
- `FindSession.clear()` wipes query and calls `engine.clear()`; there is no "keep the query, drop the paint" mode, and adding one would be new API surface bought for a behavior the bar makes unnecessary.
- One find behavior across the deck: the Text card's `closeFindBar` already clears the search and refocuses the editor. Two cards with the same bar and different dismissal semantics would be worse than either choice.
- Preserving the query across close/reopen is the standard macOS behavior (Safari, Xcode) and is what makes the clear-on-close acceptable — reopening resumes where you were with one keystroke.

**Implications:**
- The Session card holds the last query in a ref (not state — nothing renders from it) and `TugFindBar` accepts an `initialQuery` prop that seeds and selects the CM6 document at mount.
- ⌘G / ⇧⌘G with the bar closed are a documented no-op (the existing `count > 0` gate makes this fall out for free). "⌘G opens the bar and re-runs the remembered query" is a reasonable future refinement and is listed in [#roadmap], not built here.
- The submit-path dissolve vestige is still deleted — a submission has nothing to do with find — but the composer's empty-editor Escape rung is deleted too, since with the bar owning dismissal there is never a live search while the bar is closed.
- The Z4B `TugFindCluster` render is still deleted: with no live search outside the bar, there is nothing for an out-of-bar count badge to report.

---

### Deep Dives {#deep-dives}

#### ⌘F is already plumbed — what actually exists today {#deep-dive-cmd-f}

The full chain, verified:

1. **Swift menu.** `tugapp/Sources/AppDelegate.swift` builds an Edit ▸ Find submenu with "Find..." (`keyEquivalent: "f"`, identifier `edit.find`), "Find Next" (⌘G, `edit.findNext`), and "Find Previous" (⇧⌘G, `edit.findPrevious`).
2. **Handler.** `performFind` is a pure round-trip: `sendControl("find")`. There are no `performKeyEquivalent` overrides, no `NSEvent` local monitors, and no WKWebView find usage anywhere in `tugapp/Sources` — nothing else in the app touches ⌘F.
3. **Adapter.** `tugdeck/src/action-dispatch.ts` maps the `find` control frame to `TUG_ACTIONS.FIND` and dispatches via `sendToFirstResponderForContinuation`, alongside `FIND_NEXT` / `FIND_PREVIOUS`.
4. **Enablement.** `tugdeck/src/lib/host-menu-state.ts` computes `find: chain.validateAction(TUG_ACTIONS.FIND)` and pushes menu state to the host. **This is the frontend's claim signal**: if no responder validates `FIND`, the menu item greys out, AppKit eats the chord with a beep, and it never reaches the web view.
5. **Current responders for `FIND`.** Only `tug-code-view.tsx`, `tug-text-card-editor.tsx`, and the open `TextCardFindBar` itself. **The Session card registers none** — which is exactly why ⌘G/⇧⌘G reach the session's find session today (via `TugPromptEntry`'s responder) but ⌘F does not.

So "do what it takes to claim ⌘F" turns out to be one responder registration. No Swift work, no WebKit fight.

#### The zone geometry, and where the bar goes {#deep-dive-zone-geometry}

[D97] partitions the session card into `Z0`–`Z5` numbered spatially top-to-bottom. The relevant fact for this plan: **`Z2` is the status bar at the *bottom* of the transcript pane** (STATE · TIME · TOKENS · CONTEXT · WORK · BTW, plus the PULSE strip beneath), sitting outside `TugListView` so it never scrolls. Below it is the split-pane sash, then the prompt-entry pane (`Z3` collapsed status row, the editor, then the `Z4A` / `Z4B` / `Z5` toolbar row).

The Changes shade is a `TugSheetContent presentation="shade" shadeAnchor="bottom" shadeAutoSize shadePassive` inside `.session-view-pane[data-view="changes"]` — it rises *from the top of Z2* over the transcript while the prompt entry stays live beneath. That is what "above Z2" means, and it is the same place the Text card's find bar sits relative to its own status bar.

The DOM order inside the transcript pane is: `.session-view-slot` (transcript / changes / history panes) → `FindWrapOverlay` → `PaneBulletinAnchor` → `.session-card-status-bar` → the PULSE strip. **The find bar inserts immediately before `.session-card-status-bar`**, as a flow sibling. Because the pane is a flex column with the list at `flex 1 1 auto`, the bar takes its height from the list exactly as Z2 telemetry growth does.

Note that [D97]'s zone table is stale *twice over* for `Z4A`: it still lists the occupant as "route choice-group (`Code` / `Shell` / `btw`) — three recipients per [D110]", which describes the design retired in `361b29eec`, not the `!` button that replaced it. [#step-6] corrects it to the two-tab group this plan ships.

#### How commit mode already behaves as a tab {#deep-dive-commit-mode-as-tab}

`lib/commit-mode-controller.ts` (`CommitModeController`) exposes `enter(seedMessage?)`, `exit()`, `persistMessage(text)`, `requestDraft(force)`, `cancelDraft()`, `land(message)`, plus `subscribe` / `getSnapshot` ([L02]).

`tug-prompt-entry.tsx` reacts to the `active` flip in a `useLayoutEffect` ([L03], so the document change lands in the same paint as the mode flip):

- **On enter:** stash `editor.captureState()` into `preCommitDraftRef`; measure and pin the composer's current rendered height as a `min-height` on the CM6 scroller (so switching over a tall draft does not collapse the editor and jump the layout); replace the document with `buildCommitModeState(seedMessage ?? persistedMessage ?? "")`; seed the `data-commit-empty` attribute; focus.
- **On exit:** restore `preCommitDraftRef.current ?? EMPTY_EDIT_STATE`; drop the borrowed height; clear the wave caret; focus.

Meanwhile the commit message itself is durable — a 500 ms debounced `persistMessage` writes it into the changeset draft store — so cancel-and-re-enter resumes it. Other mode-scoped swaps already in place: Z5 becomes the commit rail (Cancel ✕ / Auto-message / Commit), Z4B becomes the commit cluster (Project + "Changes / N files / claim N"), completion / argument-hint / paste / inline-matcher are all suppressed, and the Z4A `!` button is `disabled`.

**This is a tab in everything but appearance.** The choice group therefore adds no state — it renders `commitActive ? "changes" : "prompt"` and dispatches into `enter()` / `exit()`.

One consequence worth stating plainly: because the group is controlled by the controller and not the other way round, the eight existing entry/exit paths (⇧⌘C, ⌃⌘C, Session ▸ Show Changes, `/commit`, the shade's self-close, a successful land, Cancel ✕, Escape / ⌘.) each move the visible selection with zero new code.

#### Existing behaviors deleted as vestiges of find-in-the-composer {#deep-dive-find-vestiges}

Three pieces of `tug-prompt-entry.tsx` exist only because find used to be a submission, and go with [P06]:

1. **Submit-path dissolve.** Before dispatch, `performSubmit` clears the find session if its query is non-empty, so stale highlights never outlive a new submission.
2. **Escape-when-empty branch.** On an empty editor, Escape clears live find highlights *before* the pane-collapse gesture — "dismiss find" first, "collapse the entry" second.
3. **Z4B cluster gate.** `findActive` (a `useSyncExternalStore` read of `findSession.getSnapshot().query !== ""`) conditionally mounts `TugFindCluster` in the Z4B chip row beside the Mode / Model / Effort chips.

With the bar owning the query, its lifetime is the bar's lifetime: closing the bar clears the session, and nothing about submitting a prompt has anything to do with find.

---

### Specification {#specification}

#### Terminology and Naming {#terminology}

| Term | Meaning |
|------|---------|
| **Route** | A mode that owns the composer's entire document. Exactly two: Prompt, Changes. |
| **Prompt route** | The default composer: assistant prompts, slash commands, and auto-routed shell lines. |
| **Changes route** | Commit mode: the composer is the commit-message editor and the Changes shade is up. |
| **Slash command** | A one-shot verb typed as `/name [args]`. Does not change the route, except `/changes` ([P05]). |
| **Find bar** | The ⌘F strip above Z2. Not a route, not a shade. |

The user-visible segment labels are **Prompt** and **Changes**; the slash commands are `/prompt` and `/changes`; the choice-group values are the strings `"prompt"` and `"changes"`.

**Spec S01: Chord changes** {#s01-chords}

| Chord | Before | After |
|---|---|---|
| ⌘F | `FIND` — no Session responder, menu item disabled | Opens the Session find bar (or re-focuses its query field) |
| ⌘G / ⇧⌘G | Find next / previous, gated on `count > 0` | Unchanged |
| ⇧⌘C | Toggle Changes shade + commit mode | Unchanged (now also moves the visible tab) |
| ⇧⌘P | Cycle permission mode | **Select the Prompt route** |
| ⌃⌘P | (unbound) | **Cycle permission mode** (tugdeck binding + Swift menu) |
| ⌘/ | Open the Z4A bang picker menu | Open the `/` completion popup ([P09]) |
| ⌃⌘S | Seed a `!shell` chip | **deleted** |
| ⌃⌘B | Seed a `!btw` chip | **deleted** |
| ⌃⌘C | `!changes` alias → toggle Changes | **deleted** (⇧⌘C remains) |
| ⌃⌘G | Seed a `!find` chip | **deleted** |
| ⌃⌘H | Seed a `!history` chip | **deleted** |
| ⇧⌘H | Toggle History shade | Unchanged |

#### Command registry — after {#s02-command-registry}

**Spec S02: New `LOCAL_SLASH_COMMANDS` entries** {#s02-new-commands}

| Name | `takesArgs` | Description string | Surface |
|---|---|---|---|
| `shell` | `true` | `"Run one shell command from here"` | Moved verbatim from `bangCommandSurfaces.shell`, caution text updated |
| `btw` | `true` | `"Ask a quick side question, answered from the conversation with no tools"` | Moved verbatim from `bangCommandSurfaces.btw` |
| `prompt` | `false` | `"Switch the composer to the prompt route"` | `commitModeController.exit()` |
| `changes` | `false` | `"Switch the composer to the Changes route"` | `commitModeController.enter()` |

Registry order matters only for popup presentation; place `shell` and `btw` near the existing action-shaped commands and `prompt` / `changes` adjacent to `commit`.

#### State Zone Mapping (tugdeck/tugways) {#state-zone-mapping}

> The zone partition itself is **[L24]** — appearance / local data / structure, with the zone dictating the mechanism. [L06] enforces the appearance zone; [L02] and [L07] govern the structure zone's entry points. [L23] is cited only where it genuinely applies: preserving user-visible state across an internal operation.

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| `findBarOpen` (Session card) | local data | `useState` in `SessionCardBody`, mirroring `text-card.tsx`'s `findOpen` | [L24] |
| Last find query (for re-seeding on ⌘F) | local data | a ref on the Session card — nothing renders from it ([P13]) | [L24], [L07] |
| Find query / options / count / active ordinal | structure | existing `FindSession` store + `useSyncExternalStore` via `TugFindCluster`'s `FindSurface` | [L02], [L24] |
| Find query text itself | local data (imperative) | the CM6 document, mirrored out through an `updateListener` — no controlled-input round-trip; [L22]-adjacent, as `TextCardFindBar`'s own doc puts it | [L24], [L22] |
| Match painting (transcript) | appearance | CSS Custom Highlights (`::highlight(transcript-find-match)` / `-active`), re-claimed on paint | [L06] |
| Match painting (Text card) | appearance | CM6 decoration state | [L06] |
| Z4A choice-group `value` | structure (derived) | `commitActive`, already read from `CommitModeController` via `useSyncExternalStore` | [L02] |
| Route selection itself | structure | `CommitModeController` — the group is controlled and holds none | [L02], [L11] |
| Choice-group focus registration | structure | `focusGroup` / `focusOrder` props, same values the `!` button used | [L03] |
| Commit message draft | structure (durable) | debounced `persistMessage` → changeset draft store | [L23] |
| Stashed prompt draft across a route switch | structure | `preCommitDraftRef` (unchanged) — capture-and-replay across an internal swap | [L23] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/components/tugways/tug-find-bar.tsx` | Shared find bar: entry shell + CM6 query field + `TugFindCluster` + ↑/↓ + find responder + wrap overlay, over a host-supplied `FindSession` ([P10]) |
| `tugdeck/src/components/tugways/tug-find-bar.css` | Bar styling, generalized from `text-card-find-bar.css` |
| `tests/app-test/at0339-session-find-bar.test.ts` | ⌘F open → search → ⌘G cycle → Escape close (at0338 was taken by the slot-chords suite after this plan was written, so the pair landed at at0339 / at0340) |
| `tests/app-test/at0340-composer-routes.test.ts` | Z4A tab group, ⇧⌘P / ⇧⌘C, `/prompt` / `/changes`, draft stash-and-restore |

#### Files deleted {#deleted-files}

| File | Note |
|------|------|
| `tugdeck/src/lib/bang-commands.ts` | Registry, `matchBangCommandLine`, `isBangCommand`, `BangCommandName` |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `TugFindBar` | component | `components/tugways/tug-find-bar.tsx` | New; props per [P10] |
| `TugFindBarHandle` | interface | `components/tugways/tug-find-bar.tsx` | `{ focusQuery(): void; refreshCount(): void }` |
| `TugFindBarProps.initialQuery` | prop | `components/tugways/tug-find-bar.tsx` | Seeds + selects the CM6 doc at mount ([P13]); Text card passes none |
| `lastFindQueryRef` | ref | `cards/session-card.tsx` | Remembers the query across a close/reopen cycle ([P13]) |
| `SESSION_CYCLE_ORDER_FIND` | const | `cards/session-card.tsx` | Deleted with the Z4B cluster; renumber the orders after it |
| `entryRouteChoice` | JSX const | `tug-prompt-entry.tsx` | `undefined` when `commitMode` is absent, so the gallery renders no route control ([P01]) |
| `TextCardFindBar` | component | `cards/text-card-find-bar.tsx` | Reduced to a session-owning wrapper over `TugFindBar`; `documentFindEngine` stays here |
| `LOCAL_SLASH_COMMANDS` | const | `lib/slash-commands.ts` | +`shell`, `btw`, `prompt`, `changes` (Spec S02) |
| `buildSlashCommandLine` | fn | `lib/slash-commands.ts` | Drop the `isBangCommand` sigil branch — always `/` |
| `chipDisplayLabel` | fn | `lib/command-atom.ts` | Drop the `isBangCommand` branch |
| `slashCommandSurfaces` | const | `cards/session-card.tsx` | +`shell`, `btw`, `prompt`, `changes` surfaces |
| `bangCommandSurfaces` | const | `cards/session-card.tsx` | Deleted |
| `SELECT_COMPOSER_ROUTE` | action | `components/tugways/action-vocabulary.ts` | New; payload `"prompt" \| "changes"` |
| `TUG_ACTIONS.FIND` handler | responder action | `cards/session-card.tsx` card-content | New ([P11]) |
| `TUG_ACTIONS.SELECT_VALUE` handler | responder action | `tug-prompt-entry.tsx` | New; keyed on the group's `senderId` |
| `entryRoutePopup` | JSX const | `tug-prompt-entry.tsx` | Replaced by a `TugChoiceGroup` (rename to `entryRouteChoice`) |
| `COMMAND_PICKER_ITEMS`, `BANG_PICKER_ICONS`, `pickerTriggerRef` | consts/refs | `tug-prompt-entry.tsx` | Deleted |
| `openCommandPicker` | callback | `tug-prompt-entry.tsx` | Rebodied per [P09] |
| `bangCommandCompletionProvider` | fn | `cards/completion-providers/local-commands.ts` | Deleted |
| `KEYBINDINGS` | const | `components/tugways/keybinding-map.ts` | ⌘F gains `preventDefaultOnMatch`; ⇧⌘P → `SELECT_COMPOSER_ROUTE`; ⌃⌘P → `CYCLE_PERMISSION_MODE`; five ⌃⌘ entries deleted |
| `HELP_SHORTCUTS` | const | `lib/help-content.ts` | Bang rows replaced by ⌘F / ⇧⌘P / `/` rows |
| Cycle Permission Mode menu item | Swift | `tugapp/Sources/AppDelegate.swift` | `modifierMask: [.command, .shift]` → `[.command, .control]` |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/design-decisions.md` — amend [D97]'s zone table: `Z4A`'s occupant becomes the two-item Prompt / Changes choice group (it currently reads "route choice-group (`Code` / `Shell` / `btw`)", stale by two generations), and note the find bar's position between the transcript pane and Z2.
- [ ] `tuglaws/design-decisions.md` — add a new global decision recording the two-route model, the bang retirement, and the find-bar placement, citing this plan.
- [ ] `tugdeck/src/lib/help-content.ts` — `HELP_SHORTCUTS` rows for `/`, ⌘F, ⇧⌘C, ⇧⌘P, ⇧⌘H, ⌃⌘P, ⌃\`, Esc.
- [ ] Module doc blocks that describe the retired design: `lib/slash-commands.ts` (its "bang command is a *routing*" framing), `lib/command-atom.ts`, `cards/text-card-find-bar.tsx` (references "the prompt entry's ⌕ route"), `components/tugways/keybinding-map.ts` (the ⌃⌘G rationale comment), and `tug-prompt-entry.tsx`'s stale delegate doc claiming ⇧⌘C only enters on an empty composer.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (`bun test`)** | Pure registry + matcher behavior | `matchLocalSlashCommand` over the new commands; `buildSlashCommandLine` sigil; the slash-inventory assertions that currently exclude the bang names |
| **App-test** | Real Tug.app, real card, real gestures | Every surface change: ⌘F, the tab group, `/shell`, `/btw`, the chord moves |
| **Drift prevention** | Keep the retirement complete | A grep-style assertion that no `!`-prefixed routing survives in the composer |

#### What stays out of tests {#test-non-goals}

- **The find engine** (index projection, matcher, highlight painting) — already covered by the existing find tests (`at0271-find-tool-headers.test.ts` and friends); this plan changes the door, not the engine, so re-asserting match correctness would be duplicated coverage.
- **The Text card's find behavior after extraction** — covered by re-running its existing app-tests unchanged; that is the point of the extraction being behavior-preserving. No new Text card tests.
- **`CommitModeController` internals** (land gate, auto-message draft phases) — unchanged by this plan and already covered.
- **Mock-store or jsdom render assertions of the choice group** — banned patterns; the tab group is proven by driving the real card.

---

### Execution Steps {#execution-steps}

> Commit after all checkpoints pass. Every step's checkpoint includes `cd tugdeck && bunx tsc --noEmit && bunx vite build` — the debug app loads the production rollup bundle, so a dev-only-valid import hangs the app at the splash screen.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Extract `TugFindBar` from `TextCardFindBar` | done | (dash) |
| #step-2 | Mount the Session find bar; claim ⌘F | done | (dash) |
| #step-3 | `/shell` and `/btw` local slash commands | done | (dash) |
| #step-4 | Retire the bang layer; Z4A becomes the route tabs | done | (dash) |
| #step-5 | Route chords and `/prompt` / `/changes` | done | (dash) |
| #step-6 | Docs: [D97], the new global decision, help content | done | (dash) |
| #step-7 | App-tests: rewrite the bang suites, add the two new ones | done | (dash) |
| #step-8 | Integration checkpoint | done | (dash) |

---

#### Step 1: Extract `TugFindBar` from `TextCardFindBar` {#step-1}

**Commit:** `tugways(routes-rework): extract the shared find bar from the Text card`

**References:** [P10] Find-bar extraction, [P06] Find lifts out of the composer, (#deep-dive-find-vestiges, #symbols)

**Artifacts:**
- `tugdeck/src/components/tugways/tug-find-bar.tsx`, `tug-find-bar.css`
- `tugdeck/src/components/tugways/cards/text-card-find-bar.tsx` reduced to a wrapper

**Tasks:**
- [ ] Create `TugFindBar` holding everything `TextCardFindBar` has today *except* `FindSession` construction and `documentFindEngine`: the `TugEntryShell` composition with `TugFindCluster` in `toolbarCenter` and the outlined ↑ / filled ↓ `TugPushButton` pair in `toolbarTrailing`; the `TugTextEditor` query field (`borderless`, `maxRows={6}`, `preserveState={false}`); the `Prec.high` keymap (Enter → `session.next()`, Shift-Enter → `session.previous()`, Escape → `onClose()`); the `EditorView.updateListener` query mirror; focus-on-mount; the `{focusQuery, refreshCount}` imperative handle; the `useOptionalResponder` registering `FIND` / `FIND_NEXT` / `FIND_PREVIOUS`; and the `FindWrapOverlay` sibling inside the `ResponderScope`.
- [ ] Props: `session`, `onClose`, `cardRootRef`, `placeholder`, optional `data-testid` (default the Text card's existing `"text-card-find-input"` at the call site, not in the shared component).
- [ ] Do **not** clear the session on unmount inside `TugFindBar` — session lifetime is the host's ([P10]).
- [ ] Reduce `TextCardFindBar` to: keep `documentFindEngine`, keep the `sessionRef` lazy construction seeded from `readFindOptions` with the `putFindOptions` hook, keep `useEffect(() => () => session.clear(), [session])`, and render `<TugFindBar session={session} placeholder="Find in file" data-testid="text-card-find-input" … />`. Forward `TextCardFindBarHandle` to `TugFindBar`'s handle so `text-card.tsx` and `tug-text-card-editor.tsx` need no edits.
- [ ] Move the shared rules out of `text-card-find-bar.css` into `tug-find-bar.css`, leaving only Text-card-specific overrides behind (if any).
- [ ] Update the `TextCardFindBar` module doc: it currently describes itself as "the Dev entry's find face, minus the route popup" and references "the prompt entry's ⌕ route", both of which describe a design that no longer exists.

**Tests:**
- [ ] No new tests — the extraction is behavior-preserving by construction and is proven by the Text card's existing app-tests.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `just app-test-changed` — the Text card find tests selected by the diff pass unchanged
- [ ] In the running app: open a Text card, ⌘F opens the bar, typing searches, Enter/Shift-Enter cycle, ⌘F again re-focuses the query field, Escape closes

---

#### Step 2: Mount the Session find bar; claim ⌘F {#step-2}

**Depends on:** #step-1

**Commit:** `tugways(routes-rework): lift transcript find into a ⌘F bar above Z2`

**References:** [P06] Find lifts out of the composer, [P07] Find is not a shade, [P11] Session registers FIND, [P13] Find-session lifetime, [Q01] Find-bar scroll, Spec S01, (#deep-dive-cmd-f, #deep-dive-zone-geometry, #deep-dive-find-vestiges)

**Artifacts:**
- `session-card.tsx`: `findBarOpen` state, the bar mount, the `FIND` responder, the removed `FindWrapOverlay` mount
- `tug-prompt-entry.tsx`: three find vestiges removed
- `keybinding-map.ts`: ⌘F gains `preventDefaultOnMatch`

**Tasks:**
- [ ] Add `findBarOpen` React state to `SessionCardBody` plus `openFindBar` / `closeFindBar` callbacks, mirroring `text-card.tsx`'s `findOpen` / `openFindBar` / `closeFindBar`. Per [P13], `closeFindBar` stashes the live query into a `lastFindQueryRef`, calls `findSession.clear()`, and returns focus to the composer.
- [ ] Add an `initialQuery` prop to `TugFindBar` (from #step-1) that seeds and fully selects the CM6 document at mount, and pass `lastFindQueryRef.current` from the Session card ([P13]). The Text card passes nothing and is unaffected.
- [ ] Mount `<TugFindBar session={findSession} placeholder="Find in transcript" … />` as a **flow sibling immediately before** the `.session-card-status-bar` div, outside `.session-view-slot` ([P07], and see #deep-dive-zone-geometry for the exact DOM order). Pass `cardRootRef={sessionCardRootRef}`.
- [ ] Register `TUG_ACTIONS.FIND` on the session card's `card-content` responder: closed → `openFindBar()`; open → `findBarRef.current?.focusQuery()`.
- [ ] Remove the session card's standalone `FindWrapOverlay` mount — `TugFindBar` mounts one ([P06] implications).
- [ ] Add `preventDefaultOnMatch: true` to the existing ⌘F entry in `keybinding-map.ts`, and update **two** stale comments: the table row listing ⌘F as "stage 1 (card stub)", and — importantly — the block comment above the card/canvas/dialog group, which currently argues *against* setting the flag ("⌘F inside a WebView runs without a browser UI to collide with"). Leaving that comment in place would contradict the edit directly beneath it. Note in the rewrite that the flag is app-wide: in browser dev, ⌘F on a card with no find responder is now silently swallowed rather than opening the browser's find, which is intended.
- [ ] Delete the three composer find vestiges in `tug-prompt-entry.tsx` (#deep-dive-find-vestiges): the submit-path dissolve block, the empty-editor Escape branch that clears the find session, and — in `session-card.tsx` — the `findActive` `useSyncExternalStore` read plus the `findActive && <TugFindCluster …/>` render in the Z4B chip row. All three are safe to delete **because** of [P13]: no search is ever live while the bar is closed. Leave the `FIND_NEXT` / `FIND_PREVIOUS` responder handlers on `TugPromptEntry` intact ([P06]).
- [ ] Delete `SESSION_CYCLE_ORDER_FIND` in `session-card.tsx` — the Z4B cluster removed above is its only consumer, and `tugdeck/tsconfig.json` sets `strict: true` but not `noUnusedLocals`, so nothing will flag it. Close the gap it leaves at position 4 in the ⌥⇥ cycle ring by renumbering the orders after it, so the ring stays contiguous.
- [ ] Resolve [Q01]: check the transcript's scroll position across an open/close cycle with the list at bottom and at a mid-point. If flow insertion jumps the view, switch the bar's CSS to an absolute overlay pinned above Z2 and record which shipped — but note the fallback is **not** free: an overlay occludes the transcript's last rows, and because the Changes shade is bottom-anchored to the transcript region, an overlaid bar and a raised shade would paint over each other instead of stacking. If [Q01] resolves to overlay, re-check [P07]'s coexistence claim before calling the step done.

**Tests:**
- [ ] Covered by the new app-test in #step-7 (`at0339-session-find-bar.test.ts`); this step's proof is the manual checkpoint below.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] In the running app: ⌘F on a Session card opens the bar with the caret in the query field; typing paints matches; ⌘G / ⇧⌘G cycle from both the query field and the composer; Escape closes and dissolves highlights; ⌘F while open re-focuses the query field; ⌘F after a close reopens with the previous query pre-filled and selected ([P13])
- [ ] Edit ▸ Find… is **enabled** (not greyed) with a Session card frontmost
- [ ] ⇧⌘C raises the Changes shade **with the find bar still open** — the two coexist ([P07])
- [ ] `just app-test-changed`

---

#### Step 3: `/shell` and `/btw` local slash commands {#step-3}

**Depends on:** #step-2

**Commit:** `tugways(routes-rework): demote shell and btw to slash commands`

**References:** [P03] Slash demotions, Spec S02, Risk R01, (#terminology)

**Artifacts:**
- `lib/slash-commands.ts`: two new registry entries
- `session-card.tsx`: two new surfaces in `slashCommandSurfaces`

**Tasks:**
- [ ] Add `shell` and `btw` to `LOCAL_SLASH_COMMANDS` with `takesArgs: true` and the descriptions in Spec S02.
- [ ] Add their surfaces to `slashCommandSurfaces`, moving the bodies from `bangCommandSurfaces.shell` / `.btw` verbatim: `btw` asks via `sideQuestionStore.ask(arg)` when the arg is non-empty and always opens the placard through `statusRowRef.current?.openSideQuestions()`; `shell` cautions on an empty arg, cautions when `shellSessionStore.getSnapshot().inflight !== null`, else `shellSessionStore.exec(command)`.
- [ ] Update the shell usage caution to `"Usage: /shell <command>"`.
- [ ] Leave `bangCommandSurfaces` in place for now — it is deleted in #step-4. Both registries dispatch through the same `RUN_SLASH_COMMAND` handler, and the slash registry is consulted first, so the two coexist without conflict during this step.

**Tests:**
- [ ] `tugdeck/src/__tests__/slash-commands.test.ts`: `matchLocalSlashCommand("/shell git status")` → `{name:"shell", args:"git status"}`; `matchLocalSlashCommand("/btw why")` → `{name:"btw", args:"why"}`.
- [ ] `tugdeck/src/lib/__tests__/slash-supported.test.ts`: invert the "the bang routings left the slash inventory entirely" test for `shell` and `btw` — they are now local commands (leave `find` and `history` asserted absent).

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] In the running app: `/shell echo hi` lands a settled shell exchange row; `/btw <q>` opens the BTW placard with the transcript entry count unchanged; both appear in the `/` completion popup

---

#### Step 4: Retire the bang layer; Z4A becomes the route tabs {#step-4}

**Depends on:** #step-3

**Commit:** `tugways(routes-rework): retire the bang layer, restore the Z4A route tabs`

**References:** [P01] Two routes, [P02] Bang retirement, [P04] History route-only, [P09] ⌘/ repoint, Risk R01, Risk R02, (#deep-dive-commit-mode-as-tab, #deleted-files, #symbols)

**Artifacts:**
- `lib/bang-commands.ts` deleted
- `tug-prompt-entry.tsx`: `!` button → `TugChoiceGroup`, `SELECT_VALUE` handler, `openCommandPicker` rebodied
- `session-card.tsx`: `bangCommandSurfaces` and the bang notice branch deleted
- `keybinding-map.ts`: five ⌃⌘ entries deleted
- `cards/completion-providers/local-commands.ts`: `bangCommandCompletionProvider` deleted
- `cards/use-session-card-services.ts`: the `"!"` completion trigger deleted

**Tasks:**
- [ ] **Z4A swap (atomic with the deletion so the slot is never empty and the focus ring never lapses).** Replace `entryRoutePopup` with `entryRouteChoice`: a `TugChoiceGroup` with `items` `[{value:"prompt", label:"Prompt"}, {value:"changes", label:"Changes"}]`, `value={commitActive ? "changes" : "prompt"}`, an explicit `senderId` (e.g. `"tug-prompt-entry-route"`), `size="xs"`, `aria-label="Route"`, and the **same** `focusGroup={routeFocusGroup}` / `focusOrder={routeFocusOrder}` the `!` button carried. Do **not** pass `disabled` while commit mode is active — the group is how you leave Changes.
- [ ] **Gate the group on `commitMode !== undefined`** ([P01] implications): `TugPromptEntry`'s `commitMode` prop is optional, and `cards/gallery-prompt-entry.tsx` mounts the entry with no controller (and no `findSession` / `routeFocusGroup`). Render `entryRouteChoice` as `undefined` in that case so `TugEntryShell`'s `toolbarLeading` slot is simply empty — a Changes segment that cannot act would be a resting lie. Verify in the Component Gallery, not just by reading the prop type.
- [ ] Add a `TUG_ACTIONS.SELECT_VALUE` handler to `TugPromptEntry`'s own `useResponder` actions, guarded on `event.sender === <senderId>`: `"changes"` → `commitModeController.enter()`, `"prompt"` → `exitCommitMode()` (the existing callback, which persists a typed message before exiting so a re-entry resumes it). `TugChoiceGroup` dispatches `SELECT_VALUE` through `useControlDispatch` to the parent responder ([L11]), so the entry's own responder is the correct home.
- [ ] Delete `lib/bang-commands.ts`.
- [ ] Delete from `tug-prompt-entry.tsx`: the `BANG_COMMANDS` / `matchBangCommandLine` import, `BANG_PICKER_ICONS`, `COMMAND_PICKER_ITEMS`, `pickerTriggerRef`, and the `matchBangCommandLine(commandLine) ??` half of the submit-path matcher (leaving `matchLocalSlashCommand(commandLine)`). Drop any now-unused lucide icon imports (`SquareTerminal`, `MessageSquareDashed`, `Search`, `HistoryIcon`) — **warnings are errors**, and an unused import will fail the build.
- [ ] Rebody `openCommandPicker` per [P09]: focus the editor and seed a leading `/` so the position-0-gated `"/"` completion provider opens the popup. Keep the `TugPromptEntryDelegate.openCommandPicker` method name and the `OPEN_COMMAND_PICKER` action.
- [ ] Delete `bangCommandSurfaces` from `session-card.tsx`, its `BangCommandName` import, and the bang branch of the `RUN_SLASH_COMMAND` handler's surface lookup (leaving the `slashCommandSurfaces` lookup). Delete the `isBangCommand` "That Command Moved" branch from the `SHOW_SLASH_COMMAND_NOTICE` handler.
- [ ] Delete `bangCommandCompletionProvider` from `cards/completion-providers/local-commands.ts` and the `"!"` entry from the `completionProviders` map in `cards/use-session-card-services.ts`.
- [ ] Delete the ⌃⌘S / ⌃⌘B / ⌃⌘C / ⌃⌘G / ⌃⌘H entries from `keybinding-map.ts` and rewrite the block comment above them (it currently explains the ⌃⌘ chip-seed family and the ⌃⌘G-not-⌃⌘F rationale). Keep ⌘/ and ⇧⌘C / ⇧⌘H.
- [ ] Drop the `isBangCommand` branches in `lib/slash-commands.ts`'s `buildSlashCommandLine` (always `/`) and `lib/command-atom.ts`'s chip-label helper, and remove both imports.
- [ ] Update the `lib/slash-commands.ts` module doc, which currently frames slash commands against "bang commands are *routings*".

**Tests:**
- [ ] `tugdeck/src/__tests__/slash-commands.test.ts`: delete the `bang routings (matchBangCommandLine)` describe block and the `matchBangCommandLine` / `isBangCommand` imports; keep and adjust the two atom-reconstruction tests so a `command` atom always reconstructs with the `/` sigil.
- [ ] `tugdeck/src/lib/__tests__/slash-supported.test.ts`: drop the `isBangCommand` import and rewrite the inventory test for the post-retirement registry.

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `rg -n 'bang|BANG' tugdeck/src` returns nothing
- [ ] In the running app: Z4A shows **Prompt | Changes**; clicking Changes raises the shade and turns the composer into the message editor; clicking Prompt restores a previously-typed prompt draft verbatim; ⇧⌘C moves the selection both ways; typing `!` at position 0 opens no popup and submits as prose; ⌘/ opens the `/` completion popup; ⌥⇥ focus cycling still reaches Z4A

---

#### Step 5: Route chords and `/prompt` / `/changes` {#step-5}

**Depends on:** #step-4

**Commit:** `tugways(routes-rework): ⇧⌘P selects Prompt, permission cycle moves to ⌃⌘P`

**References:** [P05] Slash tab switching, [P08] Chords, Spec S01, Spec S02, (#s01-chords)

**Artifacts:**
- `action-vocabulary.ts`: `SELECT_COMPOSER_ROUTE`
- `keybinding-map.ts`: ⇧⌘P and ⌃⌘P entries
- `tugapp/Sources/AppDelegate.swift`: the Cycle Permission Mode key equivalent
- `lib/slash-commands.ts` + `session-card.tsx`: `/prompt`, `/changes`

**Tasks:**
- [ ] Add `SELECT_COMPOSER_ROUTE` to `action-vocabulary.ts` with a payload doc comment (`value: "prompt" | "changes"`), following the existing `SELECT_VALUE` documentation style.
- [ ] Handle it on the session card's `card-content` responder: narrow `event.value` to the two strings, then `commitModeController.enter()` / `.exit()`.
- [ ] In `keybinding-map.ts`: change the ⇧⌘P entry from `CYCLE_PERMISSION_MODE` to `SELECT_COMPOSER_ROUTE` with `value: "prompt"`, keeping `scope: "key-card"` and `preventDefaultOnMatch: true`; add a ⌃⌘P entry (`ctrl: true, meta: true`) for `CYCLE_PERMISSION_MODE` with the same scope and flag. Rewrite the long comment above the old ⇧⌘P entry, which explains the TUI Shift-Tab history and the ⇧⌘P mnemonic — the mnemonic argument now belongs to Prompt.
- [ ] In `tugapp/Sources/AppDelegate.swift`, change the "Cycle Permission Mode" item's `modifierMask` from `[.command, .shift]` to `[.command, .control]`. Nothing else in the Swift menus needs to change: no menu item claims ⇧⌘P afterwards, so the chord reaches the web view and the tugdeck binding fires.
- [ ] Add `prompt` and `changes` to `LOCAL_SLASH_COMMANDS` (no args) with the Spec S02 descriptions, and their surfaces in `slashCommandSurfaces` (`exit()` / `enter()`).

**Tests:**
- [ ] `tugdeck/src/__tests__/slash-commands.test.ts`: `matchLocalSlashCommand("/prompt")` and `("/changes")` match with empty args; `("/prompt foo")` returns `null` (no-arg commands reject trailing args).

**Checkpoint:**
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] Build and launch Tug.app: ⇧⌘P selects the Prompt tab from the Changes tab; ⌃⌘P cycles the permission mode and the chip updates; Session ▸ Permission Mode ▸ Cycle Permission Mode shows ⌃⌘P and works
- [ ] In the running app: `/changes` and `/prompt` switch the tab; `/model` (a one-shot) leaves the tab where it was

---

#### Step 6: Docs — [D97], the new global decision, help content {#step-6}

**Depends on:** #step-5

**Commit:** `tuglaws(routes-rework): two composer routes, bang layer retired`

**References:** [P01] Two routes, [P02] Bang retirement, [P06] Find bar, [P07] Find is not a shade, [Q01] Find-bar scroll, (#documentation-plan, #deep-dive-zone-geometry)

**Artifacts:**
- `tuglaws/design-decisions.md`: [D97] amended + one new decision
- `tugdeck/src/lib/help-content.ts`

**Tasks:**
- [ ] Amend [D97]'s zone table: `Z4A`'s occupant is the two-item Prompt / Changes choice group. The current entry reads "route choice-group (`Code` / `Shell` / `btw`) — three recipients per [D110]", which is stale by two generations (it predates even the `!` button).
- [ ] Amend [D97]'s prose and ASCII diagram where they name the old occupant (`[Code][Shell][btw]` in the diagram, and the paragraph describing what the toolbar fills `Z4A` / `Z4B` with), and document the find bar's position between the transcript pane and the `Z2` status bar — recording whichever placement [Q01] settled on.
- [ ] Add a new global design decision recording: the two-route model and its definition of a route ([P01]); the bang layer's retirement with no vestige ([P02]); `/shell` and `/btw` as one-shot verbs ([P03]); find as a ⌘F bar that is not a shade ([P06]/[P07]); and the chord map (Spec S01). Cite this plan by path.
- [ ] Rewrite `HELP_SHORTCUTS` in `lib/help-content.ts`. Its current rows advertise `!`, ⌘/ as "the routing picker", ⌃⌘S "seed a !shell routing", ⇧⌘C "empty composer enters commit mode" (also stale — the as-built handler always enters), and ⇧⇥ for the permission mode (the map says ⇧⌘P, now ⌃⌘P). Replace with the verified post-change set and update the doc comment above it, which claims every row is "verified against `keybinding-map.ts`".
- [ ] Sweep the module doc blocks listed in [#documentation-plan] for stale descriptions of the retired design.

**Tests:**
- [ ] None (documentation only).

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `/help` in a running session card lists only chords that exist, each verified against `keybinding-map.ts` and the Swift menus
- [ ] `rg -n 'Code.*Shell.*btw|!shell|!btw|!find|!history' tuglaws/ tugdeck/src` returns nothing outside archived roadmap files

---

#### Step 7: App-tests {#step-7}

**Depends on:** #step-5

**Commit:** `app-test(routes-rework): retire the bang suites, cover the find bar and route tabs`

**References:** [P01] Two routes, [P02] Bang retirement, [P03] Slash demotions, [P06] Find bar, [P08] Chords, Spec S01, Spec S02, (#success-criteria, #test-non-goals)

**Artifacts:**
- `tests/app-test/at0339-session-find-bar.test.ts` (new)
- `tests/app-test/at0340-composer-routes.test.ts` (new)
- Four existing suites updated

**Tasks:**
- [ ] **New `at0339-session-find-bar.test.ts`** — ⌘F opens the bar with the caret in the query field; typing a term paints both matches and actives the first; ⌘G advances and ⇧⌘G retreats; ⌘F while open re-focuses the query field; Escape closes the bar and dissolves the highlights; **a second ⌘F reopens with the previous query pre-filled and selected, and ⌘G while closed is inert** ([P13]); ⇧⌘C raises the Changes shade with the bar still open ([P07]). `@covers tugdeck/src/components/tugways/tug-find-bar.tsx`, `@covers tugdeck/src/components/tugways/cards/session-card.tsx`.
- [ ] **New `at0340-composer-routes.test.ts`** — Z4A renders exactly two segments labelled Prompt and Changes; clicking Changes raises the shade and swaps the composer document; clicking Prompt restores a typed prompt draft verbatim (the [P01] stash-and-restore); ⇧⌘C and ⇧⌘P move the selection; `/changes` and `/prompt` move it; a one-shot (`/btw`) leaves it alone. `@covers tugdeck/src/components/tugways/tug-prompt-entry.tsx`, `@covers tugdeck/src/lib/commit-mode-controller.ts`, `@covers tugdeck/src/lib/slash-commands.ts`.
- [ ] **Rewrite `at0215-bang-chrome.test.ts`** → the Z4A route-chrome test. Its four current cases map over: (1) the static chip set keeps its assertion, minus the find cluster which has left Z4B; (2) the `!` picker case becomes the two-segment tab group; (3) the flanking-cell geometry case keeps its value but needs a new stimulus — `!find` no longer mounts a Z4B cluster, and the obvious substitute (the commit cluster's "Changes / N files") only appears in commit mode, where Z4A and Z5 have *also* swapped, so it would be measuring a different layout than the original assertion did. Assert the geometry across a **Prompt↔Changes switch** instead: that is the real Z4B width event now, and it exercises exactly the invariant the case was written to protect; (4) the `!btw` round-trip becomes `/btw`. Rename the file to match its new subject and update its `@covers` (the `bang-commands.ts` line must go — `app-test-covers-check` fails on a path that no longer resolves).
- [ ] **Update `at0222-one-shot-commands.test.ts`** — `!shell` → `/shell`, `!find` → the ⌘F bar (or delete that case as now covered by at0338), and the namespace-split case (case 3, asserting the `/` popup offers no bang routings) inverts: `/shell` and `/btw` are now *in* the `/` popup and there is no `!` popup. Note this suite is currently `describe.skip` for an unrelated reason (case 4 pins the bare-command routing to a login-PATH check); keep the skip unless case 4 is also resolved, but still update the code so it is not stale when re-enabled.
- [ ] **Update `at0216-shell-exchange.test.ts`** — `!shell <cmd>` → `/shell <cmd>`; case 2, the `!pwd` escape hatch, no longer has a mechanism: replace it with the auto-router equivalent (a bare `pwd` classified to the shell) or drop it and say so in the docblock. Cases 1, 3, and 4 (statefulness, the non-context styling hook, the restore interleave) are unaffected.
- [ ] **Update `at0211-btw-side-question-overlay.test.ts`** — `!btw` → `/btw` throughout, including the docblock. The four assertions (placard opens, transcript count unchanged, auto-dismiss and reopen, one-at-a-time) are unaffected.
- [ ] **Update `at0271-find-tool-headers.test.ts`** — it drives `!find` to reach tool-call block headers; switch it to the ⌘F bar. Its subject (index/painter agreement on collapsed tool headers) is unchanged.
- [ ] Run `just app-test-covers-check`.

**Tests:**
- [ ] The two new suites above.

**Checkpoint:**
- [ ] `just app-test-covers-check`
- [ ] `just app-test-changed` — the selection derived from this plan's diff passes
- [ ] `just app-test tests/app-test/at0339-session-find-bar.test.ts tests/app-test/at0340-composer-routes.test.ts` passes

---

#### Step 8: Integration Checkpoint {#step-8}

**Depends on:** #step-6, #step-7

**Commit:** `N/A (verification only)`

**References:** [P01]–[P12], Spec S01, Spec S02, (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Walk every criterion in [#success-criteria] against a freshly built Tug.app.
- [ ] Confirm no capability lost a door: shell override (`/shell`), side questions (`/btw` + the Z2 BTW cell), transcript find (⌘F + Edit ▸ Find…), project history (⇧⌘H + Session ▸ Show History + `/tugplug:history`), committing (the Changes tab + ⇧⌘C + `/changes` + `/commit` + Session ▸ Show Changes).
- [ ] Confirm the retirement is total: `rg -n 'bang|BANG' tugdeck/src tests/app-test` is empty, and `tugdeck/src/lib/bang-commands.ts` does not exist.

**Tests:**
- [ ] `cd tugdeck && bun test`
- [ ] `just app-test` — the ~20-file core tier, as a whole-app sanity read after a change this broad

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `cd tugdeck && bun test`
- [ ] `just app-test`

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** A Session card whose composer has two visible routes (Prompt | Changes) in Z4A, whose find is a ⌘F bar above Z2, and which carries no `!` layer of any kind.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] `tugdeck/src/lib/bang-commands.ts` is deleted and `rg -n 'bang|BANG' tugdeck/src tests/app-test` is empty (grep)
- [ ] Z4A renders a two-segment Prompt | Changes control whose selection always agrees with `CommitModeController.getSnapshot().active` across all eight entry/exit paths (at0340)
- [ ] ⌘F opens the Session find bar and Edit ▸ Find… validates enabled on a frontmost Session card (at0339 + manual menu check)
- [ ] `/shell` and `/btw` match and dispatch; `/find`, `/history`, `/prompt` and `/changes` do not exist (bun test + at0340)
- [ ] ⇧⌘P selects Prompt and ⌃⌘P cycles the permission mode from both the binding and the Swift menu (at0340 + manual)
- [ ] The Text card's find behavior is unchanged after the extraction (its existing app-tests, unmodified)
- [ ] [D97]'s zone table names the real Z4A occupant and `/help` lists only chords that exist (manual)

**Acceptance tests:**
- [ ] `tests/app-test/at0339-session-find-bar.test.ts`
- [ ] `tests/app-test/at0340-composer-routes.test.ts`
- [ ] `tests/app-test/at0215-*` (rewritten route chrome)
- [ ] `tests/app-test/at0211-btw-side-question-overlay.test.ts`
- [ ] `tests/app-test/at0216-shell-exchange.test.ts`
- [ ] `cd tugdeck && bun test`

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] A Swift `Session ▸ Show Prompt` menu item paired with `Show Changes`, so both routes appear in the menu bar (needs a control-frame action, an `action-dispatch` adapter, and a `host-menu-state` field).
- [ ] **⌘G with the find bar closed should reopen it and re-run the remembered query**, which is what macOS Find Next does in most apps. [P13] leaves it a documented no-op (the existing `count > 0` gate) rather than growing the scope here.
- [ ] **If a third route ever arrives, the selection has to move out of `CommitModeController`.** After this plan that controller quietly doubles as the route selector, which is right for two routes and wrong for three — the successor is a small route controller holding the selected route, with commit mode as one of its values. Writing this down now so it is a known consequence rather than a later surprise.
- [ ] Revisit [Q02] — disabling the Changes segment when nothing is commitable — alongside Changes empty-state polish.
- [ ] Consider whether the Changes segment should carry the changed-file count, folding the Z4B commit cluster's "Changes / N files" into the tab itself.
- [ ] `at0222-one-shot-commands.test.ts` is still `describe.skip` for an unrelated reason (its bare-command routing case pins the login-PATH membership check); re-enable when the bare-typed classifier work lands.

#### Refinements after landing {#refinements}

Everything below shipped on `main` after the dash joined, in response to using the thing. They amend the plan rather than extend it; [D122] carries the doctrine.

- **Neither route has a typeable name.** `/prompt` never shipped (it could not act — see [P05]'s amendment), and `/changes` is now deleted too. A lone route command with no twin is a half-namespace nobody can predict from the other half, and a slash command is a one-shot verb where a route is a mode you stay in. `/commit [message]` remains the *verb*. Doors: the Z4A tabs, ⇧⌘P / ⇧⌘C, Escape.
- **⌘F toggles, with no carve-out** — including from inside the bar, which is the load-bearing half, since ⌘F lands the caret in the query field and so the second press of any real toggle attempt comes from there.
- **Find and Changes exclude each other**, wired off `CommitModeController`'s active flag so every door agrees. Opening the bar leaves Changes via a new `leave()` (persists a typed message, unlike the land path's bare `exit()`). This reverses [P07]'s coexistence claim, which was right about find not being a *shade* and wrong about two bottom-of-card modes being able to share the space.
- **The cluster moved to the trailing edge, count first** — count, options, ↑ / ↓ as one group. The absolute-centring CSS override went with it.
- **The bar joined the card's focus cycle** — orders 8…11 in `SESSION_CYCLE_GROUP`, between the Z4 toolbar and the Z2 cells, registered through a second `CycleScope` and carrying their own row in the spatial grid. The card has one Tab order and the bar takes its seat in it. An empty composer or query field spends `Tab` on entering that cycle at its own seat (`useCycleMode.enterAt`), so the key moves the keyboard along the order ⌥⇥ already walks. Dismissing the bar hands the keyboard back only when the bar was holding it, and by exiting the cycle rather than claiming the editor under a pushed mode.
  - `enterAt` originally refused when the cycle was already up, which broke the case where the caret *walked* into the field: `Tab` into an empty query field, `Tab` again, and the refusal handed the key back to `indentWithTab` and typed a tab character. Entering is conditional now; the step never is. Pinned by at0339 leg 7b.
  - A first attempt built a private base-mode focus group beside the cycle. That was the wrong shape — two orders on one card, no spatial order on the new one, stops ⌥⇥ could not reach — and it is recorded in `focus-language.md` as the worked counter-example.
- **The query field soft-wraps and grows** — `lineWrap` on, up to 8 rows, then it scrolls vertically. It never scrolls sideways: a query that ran off the edge would hide the very text you are reading the results against.
- **Return / ⇧Return follow the caret** — the ↓ / ↑ twins in the query field, submit in the composer. This already fell out of the substrate keymap; at0339 now pins it.

| Checkpoint | Verification |
|------------|--------------|
| Bang layer gone | `rg -n 'bang\|BANG' tugdeck/src tests/app-test` empty; `lib/bang-commands.ts` absent |
| Two routes visible and correct | `just app-test tests/app-test/at0340-composer-routes.test.ts` |
| ⌘F claimed | `just app-test tests/app-test/at0339-session-find-bar.test.ts` + Edit ▸ Find… enabled |
| Text card unregressed | Its existing find app-tests pass unmodified |
| Build clean | `cd tugdeck && bunx tsc --noEmit && bunx vite build` |
| Whole app sane | `just app-test` (core tier) |
