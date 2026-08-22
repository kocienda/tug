<!-- devise-skeleton v5 -->

## The Join's Voice {#join-voice}

**Purpose:** The join arc's machinery is done and proven; this phase fixes how it speaks. The decision moves from a pane-modal sheet to an inline transcript surface, the landing narrates honestly in place, the terminal state rests as transcript ink instead of composer furniture, the lands-as preview stops lying about the draft, and the doctrine catches up with [D149].

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-22 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-22, fable.** Reviewed `plan:14e3b87a312a645a`. Lint: 0 errors, 0 warnings.
Oriented on: the whole document (first review), against the code read this session — `join-prompt-sheet.tsx`, `session-card.tsx`'s prompt wiring and `dash-join` route, `session-question-dialog.tsx`, `ask-user-question-tool-block.tsx`, `tug-prompt-entry.tsx`'s statusRow, `join-mode-controller.ts`, `dash-join-register.ts`, `changeset-join-store.ts`, `changeset-verb-store.ts`, `use-landing-receipts.ts`, `join_board.rs`, `agent_supervisor.rs`'s answer/join/beat paths, `ops.rs`'s message chain, `server.rs`'s draft handler, `path_resolver.rs`, [L29], [D142], and the stale doctrine section.
Applied: technical choice — Spec S02 had the hoisted macOS helpers as private, but `tugcast`'s `PathResolver` shares `resolve_synthetic`/`resolve_apfs_firmlink` for its `primary` selection, so they are now specified public; test-plan sanity — Step 5's "pure-level dismiss pin" could not fail for the right reason at that layer and was rewritten to defer to Step 6's real-layer pin; cold reader — the migrated helpers' destination was "the inline file (or a shared lib module)", now pinned to `join-prompt-inline.tsx` with the test file named; probes — `rg` replaced with `grep -rn` throughout (not a tool this repo standardizes on); holes — Spec S01 gained the reload-mid-landing recovery contract (per-mount surface, feed truth carries the outcome), matching the sheet's existing semantics rather than inventing restore plumbing. Tuglaws cross-check: [L02] honored (beats via `useSyncExternalStore` in the landing body, prompt fact via the card's existing feed subscription as props), [L06] (`data-state` + CSS), [L11] (wizard emits, card owns transport), [L22] (phase and rest timers local), [L20] (`QuestionWizard`/`TugSectionLabel` composed, nothing hand-rolled), [L29] (the plan's own subject, Steps 1–2), [D13] (one surface morphs), [D111] (the receipt ink is the terminal record), [D147]/[D149] untouched by explicit Non-goal; State Zone Mapping present and consistent with the mechanisms named in the steps.
Deferred: nothing.

---

### Phase Overview {#phase-overview}

#### Context {#context}

On 2026-08-22 a real join (dash `apptest-ledger`, landed as `0b2d404ca`) proved the arc's machine half end to end: arming fired on the last declared step's `done`, the pilot reconciled silently, the prompt raised itself on the bound card, "Join now" landed the squash, and the bindings swept. Every part of how the arc *spoke* failed in the same run, and each failure is captured:

1. **The decision scrimmed its own context.** The prompt mounts as a pane-modal `TugSheet` titled "Join?" that inerts and dims the pane body — including the run's ending narration, the exact text the decision is about.
2. **The landing kept asking.** After "Join now" the sheet's header still read "Join?" while the join executed, and the body showed only the bare `Joining apptest-ledger` — the `progress === null` arm — for the whole landing, though four progress beats are plumbed end to end.
3. **The terminal state squatted in the composer.** `Joined apptest-ledger into main | joined` rested indefinitely in the prompt entry's status row, cleared only by the next join or mode entry — while a durable transcript receipt row for the same event already exists and is the right record.
4. **The lands-as lied.** The sheet announced "landing with the branch description — no draft was written" while the join landed with the authored draft. Preview and execution resolve through the same `landing_message_preview` yet disagreed.
5. **The doctrine describes deleted machinery.** `tuglaws/dash-work-doctrine.md` § "The join finishes itself" still teaches the verdict gate, `--anyway`, the durable override, and the `verify_tier0`/`verify_tier1` config keys — all removed by [D149].

The machinery underneath — the durable `DashJoinPrompt` fact on the changesets feed, `request_id` staleness refusal, the head-keyed dismissal mark, the answer verb `changeset_join_prompt_answer`, the one-join-path invariant — is correct and does not move.

#### Strategy {#strategy}

- Rust first, client second: fix the two truth defects (the draft lookup's path keying, the missing feed bump on draft writes) before touching presentation, so the inline surface is born showing true words.
- The path fix is an [L29] repair, not a tolerance shim: the read-side key routes through the canonicalization gateway, which requires hoisting the gateway below `tugcast` so `tugdash-core` can reach it. The layering is part of the defect.
- Reuse, never rebuild: the inline surface re-hosts the existing frameless `QuestionWizard` and the sheet's pure helpers (`joinPromptAsParsed`, `answerForLabel`, `joinPromptMessage`, `joinLandingView`) unchanged; only the mount and its gating hook change shape.
- The landing morphs in place on the same surface ([D13] precedent: `AskUserQuestionToolBlock` morphs one chrome across ask → answered), which dissolves the "Join?"-during-execution defect structurally — there is no header to go stale.
- The terminal record is the ink row that already exists (`use-landing-receipts.ts` appends the server-formatted `/dash-join` summary on the join's `done` edge, [D111]); the composer register's narration learns to rest briefly and clear instead of resting forever.
- Diagnose before fixing the beat gap ([P08]): the store, wire, and keys are internally consistent on read; the defect must be reproduced under a pin before a cause is committed to.
- Doctrine last, once the code has settled, so the rewrite describes what shipped.

#### Success Criteria (Measurable) {#success-criteria}

- The join decision renders inline in the transcript flow with no scrim: while the prompt stands, the transcript's prior rows remain readable and scrollable (app-test assertion on the pane body not being `inert` and the prompt element living inside the transcript scroller).
- After "Join now", no interrogative text remains on the surface, at least one progress beat sentence renders before the terminal line, and the settled success line rests ~1.6s then the surface departs (app-test pins).
- After a landed join: the transcript carries the `/dash-join` receipt ink row, and the composer status row is empty within 3 seconds of the terminal frame (app-test pin; today it rests indefinitely).
- A draft written before or while a prompt stands is what the prompt shows: `message_source` is `draft` and the message is the authored text (Rust freshness test at the board layer + the re-aimed at0445 claim).
- `dash_draft_message` finds a row keyed under the gateway spelling when handed any other spelling of the same base root (Rust test using a symlinked directory; today `project_spellings` uses bare `std::fs::canonicalize` and can miss).
- `grep -n "verify_tier\|verdict gate\|--anyway" tuglaws/dash-work-doctrine.md` finds nothing in the join sections; [D142]'s modal wording carries an amendment note.

#### Scope {#scope}

1. Hoist the canonicalization gateway (`resolve_to_claude_form` and its macOS helpers) from `tugcast/src/path_resolver.rs` into `tugcore`, with `tugcast` delegating.
2. Key `tugdash-core`'s draft lookup (`dash_draft_message` / `project_spellings`) through the gateway.
3. Fire the changesets feed bump on dash draft writes; prove the standing prompt's message refreshes.
4. Replace the `TugSheet` mount of the join decision with an inline transcript-live-edge surface hosting the same wizard; preserve every raise/yield/close gate.
5. Morph the same surface into the landing narration; retire the sheet file.
6. Rest-then-clear the composer register's join narration; the ink receipt is the durable record.
7. Re-aim at0445 and the unit suite; add the beat and terminal pins.
8. Rewrite the stale doctrine section; amend [D142]; record the presentation decision as the next free global [D##].

#### Non-goals (Explicitly out of scope) {#non-goals}

- The Lens Dashes row and the Changes shade's dash lane keep their `dashJoinRegister` mounts unchanged — only the composer mount's terminal behavior changes.
- No join-time verification in any form. [D149] forbids re-proposing the terminal sandbox sweep and the join-time advisory; nothing here touches the reconcile-clean gate.
- The unified Changes pass (Z4A `Prompt | Changes`, guarded release) and dash entry points are separate plans.
- No change to the prompt's derivation, gating, `request_id` identity, dismissal-mark policy, or the answer wire.
- No change to `/dash-join`, "Review first" semantics, or the composer join mode itself.

#### Dependencies / Prerequisites {#dependencies}

- `roadmap/join-arc-2.md` landed (`0519182d2`) — the feedback spine (`expectServerJoin`), worktree-aware binding, and [D149] are assumed present.
- The app-test dash fixtures run on scratch repos (`tests/app-test/_harness/dash-fixture.ts`); at0445 exists and is green.

#### Constraints {#constraints}

- [L29]: every persisted or compared path routes through the canonicalization gateway — never a raw path, never bare `canonicalize`. The fix must not widen `project_spellings` into a tolerate-more-spellings shim.
- Tuglaws for all tugdeck work: [L02] external state via `useSyncExternalStore`, [L06] appearance through CSS/DOM, [L11] controls emit actions, [L22] local component facts stay local, [L20] compose `Tug*` components.
- Rust workspace: warnings are errors (`-D warnings`).
- App-tests are selective (`just app-test <file>`), never a sweep; output never piped.
- Crate layering: `tugcast` depends on `tugdash-core` depends on `tugcore`. The gateway may move down, never sideways.

#### Assumptions {#assumptions}

- `FeedRouter` state in `tugcast/src/server.rs` exposes the registry the dash handler already bumps through (`registry.changeset_all_bump().notify_one()` appears in the dash handler's outcome arms), so the draft handler can fire the same bump.
- The `QuestionWizard` is genuinely host-agnostic (its docstring says "Frameless: the durable transcript surface frames it") and needs no changes to be re-hosted.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows the devise-skeleton conventions: explicit `{#anchor}` headings, `[P##]` for plan-local decisions, `**References:**` lines citing labels and anchors, never line numbers, and `**Depends on:**` lines naming step anchors.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

None open. The direction was set explicitly by the user's review of the 2026-08-22 join (inline decision, honest landing phase, terminal state in the transcript), and the remaining calls are decided in [P01]–[P08] below.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Gateway hoist regresses path resolution | high | low | move code verbatim; `tugcast` delegates; existing tests stay in place | any watcher/picker path failure |
| Beat gap does not reproduce under the pin | med | med | [P08]: the pin asserts the outcome either way; findings recorded | pin passes without a code change |
| Inline surface disturbs transcript geometry | med | low | live-edge slot renders after the last row inside the scroller; no absolute positioning | scroll anchor jumps in at0445 |

**Risk R01: The gateway hoist moves platform-specific code** {#r01-gateway-hoist}

- **Risk:** `resolve_to_claude_form` leans on macOS-specific synthetic.conf and APFS firmlink resolution; moving it can subtly change behavior for every consumer (watchers, pickers, trash, session scanning).
- **Mitigation:** Move the functions byte-for-byte into `tugcore`; keep `tugcast::path_resolver::resolve_to_claude_form` as a delegating re-export so no call site outside the draft lookup changes; the existing `tugcast` tests keep running against the re-export.
- **Residual risk:** A future editor changes one copy's home without realizing the law text now points at `tugcore`; the doc step updates [L29]'s location sentence to close that.

**Risk R02: The beat display defect may be timing, not keying** {#r02-beat-timing}

- **Risk:** Static analysis found the store, the wire echo, and both read keys internally consistent (`workspaceKey`|`display_name` on both sides), yet the real join showed only the null arm. The cause may be the raise-time gap (frames arriving after the screenshot), a spelling mismatch in `project_dir` between the client's `workspaceKey` and the server's echo, or something not yet seen.
- **Mitigation:** [P08] — the app-test pin drives a real prompt-route join and asserts a beat renders. If it passes against current code, the finding (the narration works; the incident was the pre-first-beat gap) is recorded in this plan and the pin stays as the regression guard.
- **Residual risk:** A machine-speed-dependent gap that no deterministic pin can capture; accepted, since the terminal line and receipt are asserted regardless.

---

### Design Decisions {#design-decisions}

#### [P01] The decision mounts inline at the transcript's live edge; the sheet mount retires (DECIDED) {#p01-inline-decision}

**Decision:** The join prompt renders as an inline element inside the transcript scroller, after the last row, hosted by a new live-edge slot on `SessionCardTranscript` — not as a `TugSheet`.

**Rationale:**
- The sheet's own justification ("modal, because the whole point is that it is not missed") is satisfied by an inline surface at the live edge: it is summoned by the fact, appears where the user is already reading, and yields/raises under the same gates. What the modal added beyond that was blocking — and the scrim greyed out the run's ending narration, the exact context the decision needs.
- `QuestionWizard` (in `tugdeck/src/components/tugways/chrome/session-question-dialog.tsx`) is deliberately frameless and already hosts in a transcript block for `AskUserQuestion`; re-hosting is composition, not construction ([L20]).
- Every behavioral gate in `useJoinPromptSheet` (in `tugdeck/src/components/tugways/cards/join-prompt-sheet.tsx`) survives: answered-ids memory per mount, yield to an active landing mode, close when the fact clears, supersede on a new `request_id`, dismissal-is-"not-yet". The hook stops calling `showSheet` and instead returns what to render; the gates move with it.

**Implications:**
- `SessionCardTranscript` (`tugdeck/src/components/tugways/cards/session-card-transcript.tsx`) gains an explicit live-edge slot prop rendered after the final row inside the scroll content.
- The `session-card.tsx` wiring keeps its exact `onAnswer` / `onReviewFirst` bodies (answer → `expectServerJoin` → `narrateServerJoin`; review-first → `joinModeController.enter`).
- [D142]'s sentence "a durable `join.prompt` fact raises a card-hosted modal" is amended in the doc step ([P07]).

#### [P02] The landing narrates in place — the same surface morphs, and nothing asks during execution (DECIDED) {#p02-landing-in-place}

**Decision:** On "Join now" the inline surface morphs from the deciding body to the landing body — same element, no header, no remount — rendering the beats from `ChangesetJoinStore` and settling on the terminal line.

**Rationale:**
- The sheet's phase-swap already had the right idea ("the sheet stops being a question and becomes the surface the work plays on"); its defect was the frozen `showSheet({ title: "Join?" })` header, which `TugSheet` never re-derives. Inline, there is no separate header to go stale — the morph is total.
- [D13]'s morph precedent: `AskUserQuestionToolBlock` keeps one chrome mounted across ask → answered with no position shift; the join surface does the same across deciding → landing → settled.
- The pure helpers (`joinLandingView`, `BEAT_WORDS` from `tugdeck/src/lib/dash-join-register.ts`, `SETTLED_REST_MS`) move over unchanged, so the beat vocabulary stays single-sourced.

**Implications:**
- A settled success rests `SETTLED_REST_MS` (1600ms) then the surface departs. A failure rests until the fact changes or the user dismisses it — the inline surface carries an explicit dismiss affordance in the failed state, because inline has no host-provided ✕.
- The landing body keeps its own `useChangesetJoinLand` subscription ([L02]); the deciding/landing phase stays local `useState` ([L22]).

#### [P03] The terminal record is transcript ink; the composer register rests briefly, then clears (DECIDED) {#p03-terminal-is-ink}

**Decision:** The durable record of a landed join is the existing `/dash-join` receipt ink row; the composer status row's join narration clears itself after a short terminal rest instead of resting until replaced.

**Rationale:**
- The receipt already exists and is already correct: `use-landing-receipts.ts` (in `tugdeck/src/components/tugways/cards/`) appends the server-formatted summary as a shell-exchange ink row on the join's `done` edge ([D111] — the row records what the user did), persisted server-side and restored across reloads. Nothing new to build; the defect is only that the composer register *also* holds the sentence forever.
- The register's indefinite rest was a deliberate earlier decision ("a settled narration rests until it is replaced") made when there was no other terminal surface. With the ink row and the inline surface's settled line both present, an indefinite composer rest is a third copy of the same sentence squatting on an input surface.

**Implications:**
- `JoinModeController` (`tugdeck/src/lib/join-mode-controller.ts`) retires its `narration` on a timer after the land beat settles: when the store's `landProgress` for the narrated dash turns `terminal` with success, the controller clears `narration` after the same 1600ms rest and recomputes. A *failed* join keeps the narration — failure is the outcome the user must still act on, and the register's `join-failed` word is its standing surface.
- The Lens and shade mounts of `dashJoinRegister()` are untouched.
- The in-flight beats still narrate on the composer register (all three surfaces stay consistent while work runs); only the settled-success rest changes.

#### [P04] The draft read keys through the canonicalization gateway; the gateway moves to tugcore (DECIDED) {#p04-gateway-read}

**Decision:** `resolve_to_claude_form` (with its `resolve_synthetic` / `resolve_apfs_firmlink` helpers) moves from `tugcast/src/path_resolver.rs` into a new `tugcore` module; `tugcast` delegates; `tugdash-core::ops::project_spellings` composes its spellings from the gateway form first, raw appended — never bare `std::fs::canonicalize`.

**Rationale:**
- The write side already obeys [L29]: `apply_draft_request` in `tugcast/src/server.rs` keys the persisted row on `resolve_to_claude_form(project_dir)` and says so in its comment. The read side (`dash_draft_message` → `project_spellings` in `tugdash-core/src/ops.rs`) probes `std::fs::canonicalize` plus the raw string — the exact "bare `canonicalize`" [L29] bans, and on macOS `realpath(3)` expands the data-volume firmlink to a `/System/Volumes/Data/…` form the gateway never writes. Two spellings of one base root can therefore read as different projects, which is the silent-miss class [L29] exists to kill.
- `tugdash-core` cannot depend on `tugcast` (`tugcast` depends on it), and both depend on `tugcore` — so the layering, not a shim, is the fix. [L29]'s own text currently locates the gateway "in `tugcast/src/path_resolver.rs`"; the law's location sentence updates with the move.
- The lookup's existing migration bridge (legacy owner id, worktree-as-project rows) stays exactly as documented in `dash_draft_message`'s docstring — this decision changes how a spelling is normalized, not which rows are probed.

**Implications:**
- New module `tugcore::pathform` (file `tugrust/crates/tugcore/src/pathform.rs`) exporting `pub fn resolve_to_claude_form(&Path) -> PathBuf`; `tugcast::path_resolver::resolve_to_claude_form` becomes a one-line delegation so no other call site moves.
- `project_spellings` returns gateway form first, then the raw spelling when it differs; its docstring's Spec S05 contract sentence updates.
- A Rust test proves the round trip: write a row keyed under the gateway form, read via `dash_draft_message` from a symlinked spelling of the same directory, and get the draft.

#### [P05] The lands-as is live: draft writes bump the feed, and the inline surface re-reads the wire (DECIDED) {#p05-live-lands-as}

**Decision:** A dash draft write through `POST /api/draft` fires `changeset_all_bump`, and the inline decision surface renders `prompt.message` from props on every recompute — the sheet's render-once snapshot semantics die with the sheet.

**Rationale:**
- Today `draft_handler` / `apply_draft_request` in `tugcast/src/server.rs` write the row and return without any bump, so a standing prompt keeps its stale message until some other event recomputes the feed — and even then, the open sheet never repaints it, because `useJoinPromptSheet`'s effect is keyed on `request_id` alone and `showSheet`'s content closure renders once at raise. at0445's own docstring documents the consequence as a known limitation ("the sheet's message is a snapshot of the question it was raised for rather than a live view") — this decision deletes the limitation rather than re-documenting it.
- The `request_id` deliberately stays `<name>:<base_sha>:<dash_head>` ([P06]): the message is presentation, not identity, and a reworded lands-as must not invalidate a decision about an unchanged tree.

**Implications:**
- `apply_draft_request` (or `draft_handler` after it resolves) fires the same `registry.changeset_all_bump().notify_one()` the dash-bind handler fires on its outcome arms.
- A Rust test at the board layer: stand a prompt, write the draft row, recompute, and assert the same `request_id` now carries `message_source == "draft"` with the authored text.
- at0445's snapshot claim is rewritten to assert the live view (Step 6).

#### [P06] The request_id stays the three facts; message freshness never re-asks (DECIDED) {#p06-request-id-identity}

**Decision:** No change to the prompt's identity: `request_id = <name>:<base_sha>:<dash_head>`, staleness refusal, and the head-keyed dismissal mark are untouched.

**Rationale:**
- The identity protects the answer's correlation to the tree it was about; the message is what the tree would land *as*. Folding the message into identity would make every draft edit dismiss-and-re-raise the same question, which is the reflex-dismissal trainer the arc exists to retire.

**Implications:**
- A live message update repaints the standing ask in place; nothing closes, nothing re-raises, and an answer sent across the repaint still matches.

#### [P07] The doctrine catches up: the stale section is rewritten and [D142]'s modal wording is amended (DECIDED) {#p07-doctrine-catchup}

**Decision:** `tuglaws/dash-work-doctrine.md` § "The join finishes itself" is rewritten to the post-[D149] truth; [D142] gains an amendment note for the inline presentation; the presentation decision is recorded as the next free global `[D##]` in `tuglaws/design-decisions.md`.

**Rationale:**
- The section still teaches: "the verdict is the gate", "`tugutil dash join` refuses an unverified, red, or candidate-less join… `--anyway` is the escape", a *verification* as one of the runs under "one dash, one run", "every join rides a candidate… and verifies what that produced", and the `[tugtool.dash].verify_tier0` / `verify_tier1` config paragraph. All of that machinery was deleted by [D149]; a plan written against this text would rebuild it.
- What survives verbatim: the resolution ladder and workshop description, "a conflicted join is not a stall", the escalation rule ("an escalation is the user's, and only an intent question"), the occupancy rule minus its verification member, and "a failure fact is always terminal" minus tier vocabulary.
- The house pattern for amending a shipped decision is an explicit note (the "[D146] amends [D142]" precedent), not silent rewriting.

**Implications:**
- The rewrite states the current gate in one sentence: the join gate is reconcile-clean alone; verification belongs to the run's ending ([D149]).
- [D142]'s "raises a card-hosted modal" sentence gets a trailing amendment pointing at the new global decision.
- The new global decision records: the decision surface is inline transcript chrome; the landing morphs in place; the terminal record is the receipt ink; the composer register rests then clears.

#### [P08] Diagnosis before fix for the beat gap (DECIDED) {#p08-diagnose-beats}

**Decision:** The beat-display defect is reproduced under an app-test pin before any cause is committed to; the pin survives as the regression guard either way.

**Rationale:**
- Static reading found no key mismatch: the answer path sends `project_dir = workspaceKey` and `dash = display_name`, the server's beat frames echo both verbatim ("no spelling to reconcile ([L29])" per the emission comment in `agent_supervisor.rs`), and both readers (`JoinLandingBody`, the composer register via `landProgress`) use the same `${workspaceKey}|${dash}` key. Yet the real join rendered only the null arm. Committing to a fix now would be fixing a guess.
- The terminal frame demonstrably *did* arrive under the right key in the incident (the composer register showed the settled `joined` sentence), which narrows the space to the non-terminal beats: emission timing inside `join_in_with_progress`, frame batching, or the raise-to-first-beat gap.

**Implications:**
- Step 6's pin drives the prompt-route join on a fixture dash and asserts at least one non-terminal beat sentence renders before the settled line. If it fails, the fix lands in the same step with the cause named in the commit. If it passes, the finding is recorded here (Deep Dive addendum) and the incident is attributed to the pre-first-beat gap, which [P02]'s morph already narrates honestly ("Joining <dash>" as work-under-way).

---

### Deep Dives {#deep-dives}

#### The incident, reconstructed {#incident-timeline}

What the user saw on 2026-08-22, against what the code does:

- The prompt raised with "landing with the branch description — no draft was written", yet `0b2d404ca` landed with the authored draft subject and digest. Both readings go through `landing_message_preview` → `dash_draft_message` (`tugrust/crates/tugdash-core/src/ops.rs`). The join's execution path resolved the draft; the prompt's composition path did not. Two mechanisms can produce exactly this split, and both are real today: (a) the prompt was composed against a spelling of the base root whose bare-`canonicalize` probes miss the gateway-keyed row ([P04]) while the join ran against the client-sent `workspaceKey` whose raw spelling matches; (b) the prompt was composed before the draft write and never refreshed, because draft writes fire no bump and the open sheet renders once ([P05]). The plan fixes both; the Step 2 and Step 3 tests discriminate them.
- The landing showed the bare `Joining apptest-ledger` throughout — the `progress === null` arm of `joinLandingView` — while the composer register later showed the settled `joined` word, proving the terminal frame reached the store under the right key. See [P08].

**The diagnosis [P08] called for, answered under the pin (Step 6).** The beat machinery is sound and always was: driven through the real prompt route on a fixture dash, the surface paints every beat in order — `Joining <dash>` → `squashing` → `tearing down the workshop` → `releasing the branch` → `recording the landing` → `Joined <dash>`. There was no key mismatch to find. What the pin did have to answer for was its own method: a 120 ms sampler reported "no beat" against a narration that had rendered four, because a join on a scratch repository is over in well under a second. The pin is a `MutationObserver` over the landing line for that reason — it records what was painted rather than what a poll caught.

The same run surfaced a defect the static reading had not predicted, in the new surface rather than the old one: **a landing outlives its dash**. The instant the join lands, the dash's feed entry is gone and the card's `dashName` empties, so a landing body reading that live prop lost the store key it was watching at the exact moment the outcome arrived — reverting to "no progress yet", narrating `Joining ` with no name, never settling, and therefore never departing. The hook now captures the dash name at the press and holds it for the landing's life. This is the same class as the incident being fixed (a surface reading live state about a thing that has ceased to exist), and it is why the ending is pinned at the real layer.
- The settled sentence then rested in the composer status row indefinitely, by design (`narration` in `JoinModeController` clears only on the next `enter`/`retarget`/`performJoin`/`narrateServerJoin`). See [P03].

#### Where the arc speaks today {#speech-symbol-map}

| Surface | File | Key symbols |
|---------|------|-------------|
| Decision + landing sheet | `tugdeck/src/components/tugways/cards/join-prompt-sheet.tsx` (+ `.css`) | `useJoinPromptSheet`, `JoinPromptSheetBody`, `JoinLandingBody`, `joinPromptAsParsed`, `answerForLabel`, `joinPromptMessage`, `joinLandingView`, `SETTLED_REST_MS` |
| Card wiring | `tugdeck/src/components/tugways/cards/session-card.tsx` | the `useJoinPromptSheet` call (prompt from `boundDashEntry?.join?.prompt`, `landingActive = commitModeActive \|\| joinActive`, `onAnswer` → `answerPrompt` + `expectServerJoin` + `narrateServerJoin`, `onReviewFirst` → `joinModeController.enter`), the `"dash-join"` slash handler |
| Transcript host | `tugdeck/src/components/tugways/cards/session-card-transcript.tsx` | row rendering, per-turn trailing slots; gains the live-edge slot |
| Shared wizard | `tugdeck/src/components/tugways/chrome/session-question-dialog.tsx` | `QuestionWizard` (frameless), `ParsedQuestion` |
| Composer register | `tugdeck/src/components/tugways/tug-prompt-entry.tsx` (statusRow), `tugdeck/src/components/tugways/dash-join-register.tsx` | `DashJoinRegisterView`, `hasStatusRow` |
| Register derivation | `tugdeck/src/lib/dash-join-register.ts` | `dashJoinRegister`, `BEAT_WORDS`, `JOINABLE_STAGES` |
| Mode controller | `tugdeck/src/lib/join-mode-controller.ts` | `narration`, `narrateServerJoin`, `retarget`, `performJoin`, `derive` (register composition) |
| Beat store | `tugdeck/src/lib/changeset-join-store.ts` | `_land` map keyed `${workspaceKey}\|${dash}`, `LandProgress` (`terminal` settles, never clears), `useChangesetJoinLand`, `clearLand`, `answerPrompt` |
| Verb store + receipts | `tugdeck/src/lib/changeset-verb-store.ts`, `tugdeck/src/components/tugways/cards/use-landing-receipts.ts` | `expectServerJoin` (correlation for server-initiated joins), the `/dash-join` ink append on the `done` edge ([D111]) |
| Prompt fact | `tugrust/crates/tugcast/src/feeds/join_board.rs` | `standing_prompt` (gates: `join_ready`, quiet, dismissal mark; composes question, message via `landing_message_preview`, `prompt_options`), `join_state_for` |
| Answer + join + beats | `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs` | `do_changeset_join_prompt_answer` (re-derives, refuses stale `request_id`, three answer arms), `do_changeset_join` (beat emission via `join_in_with_progress`, echoed `project_dir`/`dash`) |
| Message chain | `tugrust/crates/tugdash-core/src/ops.rs` | `landing_message_preview`, `integrate_message`, `compose_landing_subject`, `strip_dash_scope`, `dash_draft_message`, `project_spellings`, `dash_draft_key` |
| Gateway (write side) | `tugrust/crates/tugcast/src/server.rs`, `tugrust/crates/tugcast/src/path_resolver.rs` | `draft_handler` / `apply_draft_request` (gateway-keyed row, sibling sweep, **no bump today**), `resolve_to_claude_form` |

#### The inline hosting mechanism {#inline-hosting}

`SessionCardTranscript` renders the transcript rows inside its scroller and already owns per-turn trailing slots. The join prompt is not a turn artifact, so it gets an explicit **live-edge slot**: a prop accepting a React element that the transcript renders after the final row, inside the scroll content, so it scrolls with the conversation and sits directly above the composer at rest. The session card composes the slot from the prompt hook's return value. The slot is generic (an element, not join-specific), so a future live-edge occupant does not re-plumb it. Scroll behavior: the surface appearing at the live edge participates in the transcript's existing bottom-anchoring; no scroll code is added.

---

### Specification {#specification}

**Spec S01: The inline surface's states** {#s01-inline-states}

One component, `JoinPromptInline` (new file `tugdeck/src/components/tugways/cards/join-prompt-inline.tsx` + `.css`), `data-slot="join-prompt-inline"`, `data-state` ∈ `deciding | landing | joined | failed`:

- `deciding` — the lands-as block (`TugSectionLabel` "lands as", message, provenance note per `joinPromptMessage`) above `QuestionWizard` with the server's three options. Message and note re-render from props on every wire update ([P05]).
- `landing` — the beat sentence from `joinLandingView` (null progress reads `Joining <dash>`, beats read `Joining <dash> — <beat word>`).
- `joined` — the settled line + detail; departs after `SETTLED_REST_MS`.
- `failed` — the settled failure line + detail + an explicit dismiss affordance; rests until dismissed or the fact changes.

The raise/close gates carry over from `useJoinPromptSheet` unchanged in meaning: per-mount answered-ids set; yield while `landingActive`; close (and spend the id as "not-yet"-equivalent only when genuinely dismissed, not when settled elsewhere) when the fact clears; supersede on a new `request_id`; ⎋ and decline answer "not-yet".

The surface is per-mount, like the sheet before it: a reload or card remount during a landing does not restore the landing body — the feed's truth carries the outcome (the receipt ink row on completion, the register's failure word on error), which is the same recovery contract the sheet had.

**Spec S02: The gateway in tugcore** {#s02-gateway-api}

`tugrust/crates/tugcore/src/pathform.rs`:

```rust
/// Resolve a directory path to the Claude form. Moved verbatim from
/// tugcast::path_resolver; see [L29].
pub fn resolve_to_claude_form(path: &Path) -> PathBuf
```

with `resolve_synthetic` / `resolve_apfs_firmlink` moving alongside it as **public** functions (macOS-gated as today) — `tugcast`'s `PathResolver` shares them for its `primary` selection, so they must remain reachable from `tugcast`. `tugcast::path_resolver::resolve_to_claude_form` delegates to the `tugcore` copy; the `PathResolver` watcher type stays in `tugcast`, calling the hoisted helpers. `tugdash-core::ops::project_spellings` becomes: gateway form first, raw appended when it differs.

**Spec S03: The draft-write bump** {#s03-draft-bump}

`POST /api/draft` fires `changeset_all_bump().notify_one()` after a successful set or clear. The bump is unconditional on owner kind — a commit draft write refreshing the feed is harmless, and a conditional here is a branch nobody will maintain.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone (appearance / local-data / structure) | Mechanism | Law |
|-------|--------------------------------------------|-----------|-----|
| standing prompt fact | external | feed snapshot via existing card subscription, passed as prop | [L02] |
| landing beats | external | `useChangesetJoinLand` (`useSyncExternalStore`) inside the landing body | [L02] |
| deciding/landing phase | local-data | component `useState` | [L22] |
| settled rest / departure | local-data | component effect + timer | [L22] |
| surface look per state | appearance | `data-state` attribute + CSS | [L06] |
| register narration retirement | external | `JoinModeController` observes the join store's terminal beat, clears `narration` on a timer, fires its own listeners | [L02], [L22] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugrust/crates/tugcore/src/pathform.rs` | the canonicalization gateway's new home (Spec S02) |
| `tugdeck/src/components/tugways/cards/join-prompt-inline.tsx` | the inline decision/landing surface (Spec S01) |
| `tugdeck/src/components/tugways/cards/join-prompt-inline.css` | its styles |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `resolve_to_claude_form` | fn (moved) | `tugcore/src/pathform.rs` | verbatim hoist; tugcast delegates |
| `project_spellings` | fn (modified) | `tugdash-core/src/ops.rs` | gateway form first, raw appended |
| `apply_draft_request` bump | behavior | `tugcast/src/server.rs` | Spec S03 |
| `JoinPromptInline` | component | `cards/join-prompt-inline.tsx` | hosts `QuestionWizard`; Spec S01 |
| `useJoinPrompt` | hook (reworked from `useJoinPromptSheet`) | `cards/join-prompt-inline.tsx` | returns the element/state to render instead of calling `showSheet` |
| live-edge slot | prop | `cards/session-card-transcript.tsx` | element after the last row, inside the scroller |
| narration retirement | behavior | `lib/join-mode-controller.ts` | settled-success narration clears after rest ([P03]) |
| `join-prompt-sheet.tsx` / `.css` | deleted | `cards/` | pure helpers (`joinPromptAsParsed`, `answerForLabel`, `joinPromptMessage`, `joinLandingView`, `SETTLED_REST_MS`) migrate to `join-prompt-inline.tsx` as exports; their tests re-home to `cards/__tests__/join-prompt-inline.test.ts` |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/dash-work-doctrine.md` — rewrite § "The join finishes itself" ([P07]).
- [ ] `tuglaws/design-decisions.md` — amendment note on [D142]; new global decision for the inline presentation.
- [ ] `tuglaws/tuglaws.md` — [L29]'s gateway-location sentence names `tugcore` (Spec S02).
- [ ] at0445 header docblock — the snapshot-message claim becomes the live-view claim ([P05]).

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust)** | gateway round trip, draft lookup spellings, prompt message freshness | Steps 1–3 |
| **Unit (TS)** | the pure helpers' tables (`joinPromptAsParsed`, `answerForLabel`, `joinPromptMessage`, `joinLandingView`) survive the migration byte-for-byte | Steps 4–5 |
| **App-test** | the pressed arc: inline raise, no scrim, beats, settle, ink receipt, register clearing | Step 6 |

#### What stays out of tests {#test-non-goals}

- Hook gating (answered-ids, yield, supersede) via mocked stores — banned pattern; the gates are covered by the re-aimed at0445 driving the real card.
- jsdom render tests of the inline surface — banned; the app-test asserts against the real DOM.
- The beat *timing* distribution — machine-dependent; only presence and order are pinned ([P08]).

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The gateway moves to tugcore | done | `e8e796fe9` |
| #step-2 | The draft read keys through the gateway | done | `c3e6da566` |
| #step-3 | Draft writes bump the feed; the prompt's message is fresh | done | `204704c87` |
| #step-4 | The decision mounts inline | done | `237c663e9` |
| #step-5 | The landing narrates in place; the register learns to rest | done | `38f316fb4` |
| #step-6 | The pressed arc re-aimed: at0445, beats, ink, register | done | `c50ad507e` |
| #step-7 | Doctrine and decisions catch up | done | `26a99e17c` |
| #step-8 | Integration Checkpoint | done | `469113890` |

#### Step 1: The gateway moves to tugcore {#step-1}

**Commit:** `Hoist the canonicalization gateway into tugcore`

**References:** [P04] gateway read, Spec S02, Risk R01, (#speech-symbol-map)

**Artifacts:**
- `tugrust/crates/tugcore/src/pathform.rs` with `resolve_to_claude_form` and its macOS helpers, moved verbatim from `tugcast/src/path_resolver.rs`; module registered in `tugcore/src/lib.rs`.
- `tugcast::path_resolver::resolve_to_claude_form` delegating to `tugcore::pathform::resolve_to_claude_form`; every existing `tugcast` call site and test unchanged.

**Tasks:**
- [ ] Move the function bodies byte-for-byte; keep the docstring (it carries the [L29] rationale) on the `tugcore` copy; the delegate gets a one-line pointer.
- [ ] Audit `tugcast/src/path_resolver.rs` for shared private helpers the watcher type also uses; anything both need stays accessible to both without duplication.

**Tests:**
- [ ] A `tugcore` test: on a symlinked temp directory, `resolve_to_claude_form(symlink)` equals `resolve_to_claude_form(target)`.
- [ ] The existing `tugcast` path-resolver tests pass unmoved (they now exercise the delegation).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcore -p tugcast`

---

#### Step 2: The draft read keys through the gateway {#step-2}

**Depends on:** #step-1

**Commit:** `Key the dash draft lookup through the gateway`

**References:** [P04] gateway read, Spec S02, (#incident-timeline)

**Artifacts:**
- `tugdash-core::ops::project_spellings` composing gateway form first, raw appended; its docstring updated; no other change to `dash_draft_message`'s probe order or migration bridge.

**Tasks:**
- [ ] Replace the `std::fs::canonicalize` arm with `tugcore::pathform::resolve_to_claude_form`; keep the raw-spelling fallback for historical rows exactly as documented.
- [ ] Sweep `tugdash-core` for any other bare `canonicalize` on a persisted or compared project path; fix what the sweep finds, leave OS-call-local uses alone.

**Tests:**
- [ ] The round trip: insert a `changeset_drafts` row keyed under the gateway spelling of a temp base root (as `apply_draft_request` would), then call `dash_draft_message` handing the repo as a symlinked spelling of the same directory — the draft is found. Under the old code this test fails on macOS.
- [ ] The existing `dash_draft_key` / draft-bridge tests stay green.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core`

---

#### Step 3: Draft writes bump the feed; the prompt's message is fresh {#step-3}

**Depends on:** #step-2

**Commit:** `Bump the changesets feed on draft writes`

**References:** [P05] live lands-as, [P06] request-id identity, Spec S03, (#incident-timeline)

**Artifacts:**
- `POST /api/draft` firing `changeset_all_bump().notify_one()` after a successful set or clear, via the same registry route the dash-bind handler uses.

**Tasks:**
- [ ] Wire the bump in `draft_handler` after `apply_draft_request` returns success; no bump on error responses.
- [ ] Confirm `tugutil draft set`'s server round trip (`tugutil/src/draft.rs::run_set`) needs no change — the bump is server-side.

**Tests:**
- [ ] Board-layer freshness: stand a prompt on a fixture dash (join-ready, candidate, no mark), assert `message_source == "description"`; write the draft row; recompute `join_state_for`; assert the same `request_id` now carries `message_source == "draft"` and the authored text. This pins [P06] (identity unmoved) and [P05] (message moved) in one test.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast -p tugdash-core`

---

#### Step 4: The decision mounts inline {#step-4}

**Commit:** `Mount the join decision inline at the transcript live edge`

**References:** [P01] inline decision, [P05] live lands-as, Spec S01, Risk R03, (#inline-hosting, #speech-symbol-map)

**Artifacts:**
- `join-prompt-inline.tsx` / `.css`: `JoinPromptInline` (deciding state) and the reworked `useJoinPrompt` hook; the pure helpers migrated with their tests.
- The live-edge slot on `SessionCardTranscript`; `session-card.tsx` composing the hook's output into it; the `TugSheet` raise deleted.

**Tasks:**
- [ ] Rework `useJoinPromptSheet` → `useJoinPrompt`: same inputs minus `showSheet`, returning the standing prompt to render (or null); every gate preserved per Spec S01. The card renders `JoinPromptInline` into the transcript's live-edge slot when the hook yields one.
- [ ] `JoinPromptInline` deciding state: lands-as block + `QuestionWizard` with `isPending` hard-true, `onSubmit`/`onDecline`/`onCancel` mapped exactly as the sheet body mapped them; message and note render from props so a wire refresh repaints in place ([P05]).
- [ ] Style with theme tokens; no gallery classes; the surface reads as transcript chrome, not a floating panel.

**Tests:**
- [ ] The migrated pure-helper unit tests pass unchanged (`joinPromptAsParsed`, `answerForLabel`, `joinPromptMessage` tables from `join-prompt-sheet.test.ts`, re-homed).

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build && bun test src/components/tugways/cards/__tests__`

---

#### Step 5: The landing narrates in place; the register learns to rest {#step-5}

**Depends on:** #step-4

**Commit:** `Narrate the landing in place and rest the composer register`

**References:** [P02] landing in place, [P03] terminal is ink, Spec S01, (#state-zone-mapping)

**Artifacts:**
- `JoinPromptInline` landing/joined/failed states with the beat subscription, settled rest, departure, and the failed-state dismiss affordance.
- `JoinModeController` narration retirement on settled success; `join-prompt-sheet.tsx` / `.css` deleted.

**Tasks:**
- [ ] Landing morph per [P02]: local phase state flips on `join-now`; `useChangesetJoinLand` inside the landing body; `joinLandingView` renders the sentence; success departs after `SETTLED_REST_MS`, failure rests with dismiss.
- [ ] Register retirement per [P03]: the controller observes the join store; a terminal success beat for the narrated dash clears `narration` after the same rest and recomputes. Failure narration stays.
- [ ] Delete the sheet files; `grep -rn "join-prompt-sheet" tugdeck/src` finds nothing.

**Tests:**
- [ ] `joinLandingView` table tests pass re-homed, unchanged. The failed state's resting/dismiss behavior is component behavior and is pinned at the real layer in Step 6, not faked at the pure level.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build && bun test src`

---

#### Step 6: The pressed arc re-aimed: at0445, beats, ink, register {#step-6}

**Depends on:** #step-3, #step-5

**Commit:** `Re-aim the join prompt pins at the inline surface`

**References:** [P01], [P02], [P03], [P05], [P08] diagnose beats, Risk R02, (#success-criteria)

**Artifacts:**
- `tests/app-test/at0445-join-prompt.test.ts` re-aimed: inline selectors (`data-slot="join-prompt-inline"`), the no-scrim assertion (pane body not `inert` while the ask stands), and the snapshot-message claim rewritten to the live view (write a draft while the ask stands; the lands-as repaints to the author's words with `data-source="draft"` under the same request).
- New pins in the same file (or a sibling if it grows unwieldy): after "Join now", at least one non-terminal beat sentence renders before the settled line; the settled line departs; the `/dash-join` receipt ink row is present; the composer status row carries no join register within 3 seconds of settle.

**Tasks:**
- [ ] Re-aim the five existing claims; every dismissal-policy assertion (durable mark, same-decision base move, red re-ask) is behavioral and survives untouched.
- [ ] The beat pin per [P08]: if it fails against the new surface, diagnose and fix in this step, naming the cause in the commit; if it passes, append the finding to (#incident-timeline) — the incident was the pre-first-beat gap — and keep the pin.

**Tests:**
- [ ] The re-aimed at0445 (this step's work *is* its tests).

**Checkpoint:**
- [ ] `just app-test at0445-join-prompt.test.ts` (bare — never piped)
- [ ] `just app-test-covers-check`

---

#### Step 7: Doctrine and decisions catch up {#step-7}

**Depends on:** #step-5

**Commit:** `Rewrite the join doctrine to the reconcile-clean gate`

**References:** [P07] doctrine catchup, [P04] gateway read, (#success-criteria)

**Artifacts:**
- `tuglaws/dash-work-doctrine.md` § "The join finishes itself" rewritten: keeps the ladder/workshop/escalation/occupancy/terminal-fact truths, states the reconcile-clean gate and run-ending verification, deletes the verdict gate, `--anyway`, the override, the verification run, "every join rides a candidate… and verifies", and the `verify_tier0`/`verify_tier1` paragraph.
- `tuglaws/design-decisions.md`: the next free global `[D##]` recording the inline presentation ([P01]–[P03] condensed); an amendment note on [D142]'s modal sentence pointing at it.
- `tuglaws/tuglaws.md` [L29]: the gateway-location sentence names `tugcore` (with `tugcast` re-export).
- at0445's header docblock already updated in Step 6; verify no other doc names the sheet (`grep -rn "join-prompt-sheet\|card-hosted modal" tuglaws roadmap tugplug`).

**Tasks:**
- [ ] The rewrite and the decision entries, per [P07]'s survives/deletes inventory.

**Tests:**
- [ ] `grep -n "verify_tier\|--anyway\|verdict gate" tuglaws/dash-work-doctrine.md` returns nothing.

**Checkpoint:**
- [ ] The rg probe above, and `tugutil plan lint roadmap/join-voice.md` still exits 0.

---

#### Step 8: Integration Checkpoint {#step-8}

**Depends on:** #step-6, #step-7

**Commit:** `N/A (verification only)`

**References:** [P01]–[P08], (#success-criteria)

**Tasks:**
- [ ] `tugutil dash replay <name>` — put the rounds on the live base, so what gets verified is what would land.
- [ ] `Replayed` / `Recorded`: verify the replayed tree with `sh scripts/verify-fit.sh <base-sha> <head-sha>`.
- [ ] `Current`: the base never moved, so the last step's checkpoint already verified these exact bytes — re-run nothing and say so.
- [ ] `Conflicted`: resolve the named round in the worktree, then verify as above.

**Tests:**
- [ ] None of its own. This step re-proves nothing the steps proved; it establishes that their work still holds on the base as it stands now.

**Checkpoint:**
- [ ] The replay reports its outcome, and the scoped verification is green **or** was correctly skipped as `Current`.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** The join arc's speech matches its machinery: an inline, unscrimmed decision showing true words, a landing that narrates and settles in place, a terminal record in the transcript, a composer that returns to being an input, and doctrine that describes the shipped gate.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] The decision renders inline with no scrim; prior transcript rows stay readable (app-test, Step 6).
- [ ] The landing shows no interrogative text, renders beats, settles, and departs (app-test, Step 6).
- [ ] The `/dash-join` ink row is the terminal record and the composer register clears after its rest (app-test, Step 6).
- [ ] A gateway-keyed draft row is found from any spelling of the base root (Rust test, Step 2).
- [ ] A draft written while the ask stands repaints the lands-as under the same `request_id` (Rust test, Step 3; app-test, Step 6).
- [ ] The doctrine's join sections carry no deleted machinery; [D142] carries its amendment (prose assertion + rg probe, Step 7).

**Acceptance tests:**
- [ ] Re-aimed at0445 green (Step 6).
- [ ] `cargo nextest run` green across the workspace at the last code step's checkpoint.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] The generality seam for per-project verify/build declarations (`roadmap/dash-generality.md`, queued next).
- [ ] The unified Changes pass and dash entry points (their own plans).
- [ ] A "joined" archaeology surface for browsing landed dashes.

| Checkpoint | Verification |
|------------|--------------|
| Rust truth fixes | Steps 1–3 nextest checkpoints |
| Client surfaces | Steps 4–5 tsc + vite build + bun test |
| Pressed arc | Step 6 `just app-test at0445-join-prompt.test.ts` |
| Fit | Step 8 replay procedure |
