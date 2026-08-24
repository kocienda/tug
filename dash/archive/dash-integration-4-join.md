## Join mode — the landing surface {#join-mode}

**Purpose:** Give the dash lane the landing surface the main lane already has: `/dash-join` turns the composer into the join-message editor over a previewed merge, the Changes shade's dash lane fronts the four landing outcomes with the act that unblocks each, and a landed or discarded dash leaves a durable receipt in the transcript. Implements [phase 4](dash-integration-plan.md#phase-4) of the dash integration program.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Target branch | main (runs as the `join-lane` dash) |
| Program plan | [dash-integration-plan.md](dash-integration-plan.md#phase-4) |
| Last updated | 2026-08-14 |

---

### Review Record {#review-record}

<!-- Appended by /tugplug:plan-review; the stamp is written by `tugutil plan stamp`. -->

**Round 1 — 2026-08-14, opus.** Reviewed `plan:12802870531d07f8`. Lint: 0 errors, 0 warnings, clean before and after. Oriented on: the whole document — a first pass, no prior round.

Applied, naming: the user settled that an operation carries one name on every surface a user can see, and that the name is its `tugutil` verb path — now [P08], with the two card-verb renames it forces (`/join` → `/dash-join`, `/dash` → `/dash-bind`), the two receipt command strings it corrects (`/dash-join`, `/dash-release`), the deprecated-alias rule that keeps a retired spelling from submitting the user's line to Claude as a prompt, and the `tugutil commit` / `tugutil dash commit` collision the rule exposed. `/dash-commit` is reserved and deliberately unshipped this phase; `/commit` keeps its base-branch meaning on bound cards. Step 5 grew the rename tasks and an alias assertion; the scope list, documentation plan, and symbol inventory follow.

Applied, correctness — three defects that would each have failed during implementation. Step 1 named a test that could not pass: `join_in` returns `Err` on a stale journal at `ops.rs:1651`, *before* the `opts.preview` arm at `1659`, so `join_preflight_in` could never report `stale-journal`; the step now reorders the guard, states the resulting `--preview` behavior change plainly, and corrects two error strings that instruct the user to run `tugdash join …`, a binary that does not exist (the verb is `tugutil dash join`). Step 6 would have rendered one dash's blockers under another dash's name: `JoinState` is keyed by `entryKey`, which is `session:<tugSessionId>` — one slot per card, not per dash — so two previewing rows clobber each other; only the fronted row previews now, and the keying is recorded so a later re-key is a deliberate act. Step 7's release receipt had nowhere to live: `ReleasePhase` is `idle|pending|error` and `changeset_release_ok` resets to a shared frozen `RELEASE_IDLE`, leaving no terminal edge and no field, so the step now adds a `done` phase; it also names `dash_detail_entries_in` as the only round-subject accessor and pins the capture before `release_in`.

Applied, smaller: the three new app-tests were renumbered `at0417`–`at0419` because `at0410` and `at0411` are live files and the tree already carries one accidental `at0412` collision. [P07]'s [L30] rationale claimed a uniformity the registry does not have — `select-composer-route:changes` is deliberately unregistered, for a reason the file records — so the decision now names that precedent and says why Join differs. [P01]'s interface list was missing `kind` and `setLandHook`, which step 3 already assumed.

Deferred: nothing new. [Q01] and [Q02] stand as the author left them. Left alone: step 3's hedge about renaming `commitReady`/`commitPhase`/`commitError` only if mechanical — it states its own tiebreak (keep `commit-mode-controller.test.ts` unmodified) and that tiebreak is right.

Not verified by this review: the alias policy in [P08] is settled from the tree's own precedent (`tugplug/skills/join/SKILL.md` keeps a retired spelling alive rather than deleting it) rather than from an existing card-verb alias mechanism — there is none today, so step 5 builds the first one.

---

### Phase Overview {#phase-overview}

#### Context {#context}

Phases 1–3.1 built everything a dash landing needs except the room it happens in. A dash has an identity, a session binding, a derived stage, a maintained join draft, and a lane in the Changes shade that renders all of it — **read-only**. The one gesture that lands it, `/dash-join`, currently submits a `/tugplug:dash-join` skill turn: the model shells out to `tugutil dash join`, reads the output, and reports back in prose. That works, and it will keep working as the headless path, but it is the wrong shape for the gesture a user reaches for most: it spends a turn, it puts the preview in the transcript instead of in front of the button, and it gives the join message no editor.

Meanwhile the machinery a real landing surface would need is **already built and entirely unconsumed**, which is the single most important fact for anyone implementing this plan:

- `tugdeck/src/lib/changeset-verb-store.ts` already carries `JoinState` / `ReleaseState`, the `join()` / `release()` senders, and the `useChangesetJoin` / `useChangesetRelease` hooks. Program-plan item 1 ("deck senders join `changeset-verb-store`") is **done**.
- `tugcast/src/feeds/agent_supervisor.rs` already handles `changeset_join` and `changeset_release` end to end — registry guard, git-worktree guard, `spawn_blocking` over `tugdash_core::join_in` / `release_in`, the aggregate bump, and the `_ok` / `_err` broadcasts. On a landed join or a release it already clears the dash's draft row **and** every session binding for the dash's owner key. Program-plan item 6's server half is **done**.
- `tugdeck/src/lib/changeset-join-store.ts` already carries the whole conflict-resolution ladder overlay — `changeset_join_resolve` sender, per-file streaming deltas, terminal resolved/unresolved/candidate state.
- `tugcast/src/feeds/draft_engine.rs` already composes a **dash** draft target (`DraftTarget::Dash { base, branch, worktree }`, keyed `owner_kind: "dash"`), so the Auto-Message button works for a join message with no new server work.

A search of `tugdeck/src` for `useChangesetJoin`, `useChangesetRelease`, and `useChangesetJoinResolve` returns exactly one hit outside their own modules: `main.tsx`, attaching the singletons. Nothing renders them. This phase is therefore **almost entirely a UI phase over finished plumbing**, plus two honest additions the surface forces: a preview that reports blockers, and receipts.

#### Strategy {#strategy}

- **Land the truth-telling Rust first.** A landing surface that offers a button it cannot honor is worse than no surface. Step 1 makes `--preview` report the blockers the execute path checks, so beat 1 shows exactly what beat 2 will do.
- **Share the composer machinery rather than copy it.** `tug-prompt-entry.tsx` holds ~250 lines of commit-mode composer plumbing. Join needs all of it with different verbs, so the composer learns one `landingMode` slot over an interface both controllers satisfy ([P01]) — written once, and mutual exclusion becomes structural.
- **Build the mode before the room.** The composer + controller (steps 3–5) is what makes `/dash-join` real; the lane's four-outcome face (step 6) is what makes it discoverable. In that order the mode is testable before the presentation exists.
- **Receipts after there is something to receipt.** Join and release receipts (steps 7–8) fire only from the card, so they cannot be verified end to end until the card can land. They come after the UI, not before it.
- **The destructive act comes last and alone.** Release plus its discard preflight (the consolidation plan's [release ruling](archive/changes-commit-dash-consolidation.md#p14-release)) is its own step, at the end, so no earlier step's checkpoint can destroy a dash by accident.

#### Success Criteria (Measurable) {#success-criteria}

- Typing `/dash-join` on a card bound to a dash puts the composer into join mode seeded with the dash's maintained join draft, with the Z4A route group showing three segments and `Join` selected (app-test asserts the seeded document text and the segment's selected state).
- `tugutil dash join <name> --preview --json` on a dash whose repo root is checked out to a non-base branch reports a `blockers` array containing `{"kind":"off-base", …}` and exits 0 (Rust test + CLI run).
- With a clean preview, pressing the join affordance lands a squash on the base branch and appends exactly one `/dash-join` receipt row to the transcript; the row survives Maker ▸ Reload byte-identically (app-test asserts the row before and after a reload).
- A dash with zero commits past base and a clean worktree renders `empty` in the lane with the release affordance fronted, and offers **no** Join button (app-test over a `createDash` with no round).
- A dash whose `stage` is `landing` renders a "Resume teardown" affordance that sends `changeset_join { continue: true }` (unit test over the verb store's frame; app-test over the affordance's presence).
- `bun test` (7.5k+), `cargo nextest run` (2.5k+), `bunx tsc --noEmit`, `bunx vite build`, and the derived `just app-test-changed` selection are all green at every step boundary.

#### Scope {#scope}

1. `tugdash_core::ops::join_preflight_in` and structured `JoinBlocker`s on `JoinOutcome`, reported by `--preview` and printed by the CLI.
2. `blockers`, `continue`, and `session_id` through the `changeset_join` / `changeset_release` CONTROL verbs and the deck's verb store.
3. A `LandingMode` interface, `CommitModeController` conforming to it unchanged, and a new `JoinModeController` with `evaluateJoinLandGate`.
4. One `landingMode` slot in `tug-prompt-entry.tsx`; a third Z4A route segment, present only while a dash is bound.
5. `/dash-join` as a local mode-entering verb (replacing today's skill submission), with the session card's coupling, staged land, and menu-state publication.
5a. The card-verb renames [P08] requires — `/join` → `/dash-join`, `/dash` → `/dash-bind` — with the retired spellings kept as deprecated aliases, and `/dash-commit` reserved but unshipped.
6. The dash lane's four-outcome face: join, blocked, empty→release, conflicted, and resume-teardown.
7. Server-formatted join and release summaries persisted to the shell ledger, and a bespoke receipt renderer for them.
8. The conflict-resolution lane over the existing `changeset-join-store` overlay, ending in a candidate land.
9. Release from the lane row with the discard preflight.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Strategy selection in the UI.** The card always sends `squash`. `merge` and `rebase` stay CLI-only ([Q01]).
- **Retrofitting commit's turn gate.** `evaluateCommitLandGate` reads `codeSessionStore.canInterrupt`; the consolidation plan's [landing-gate ruling](archive/changes-commit-dash-consolidation.md#p08-gates) asked for a lifecycle-idle predicate. Join's gate matches commit's shipped shape so the two agree; correcting both is deferred ([Q02]).
- **A chord for the Join route.** The segment, `/dash-join`, and the lane affordance are the entrances; no key equivalent is assigned ([P07]).
- **The `tugplug:dash-join` skill.** It survives byte-unchanged as the headless/agentic path over the same `tugutil dash join` verb. Only the card's local `/dash-join` handler changes.
- **The Lens's dash section and the card chrome chip.** Phase 2's surfaces are untouched; phase 5 adds the stale-review mark to them.
- **Relocation.** A bound card's shell, cwd, and primary `workspace_key` binding stay in the base checkout (the program plan's [binding-is-an-overlay ruling](dash-integration-plan.md#p01-overlay)).

#### Dependencies / Prerequisites {#dependencies}

- Phases 1, 2, 2.1, 3, and 3.1 shipped. Specifically: `CardSessionBinding.dash` (`{id, name}`), `DashChangesetEntry` with `owner_id` / `branch` / `stage` / `rounds` / `worktree_dirty` / `round_subjects` / `draft`, and `ChangesRouteController`'s `dashes` array.
- `git >= 2.38` for `git merge-tree --write-tree`, which `--preview` already requires and refuses without.
- A `landing`-stage dash for the resume-teardown assertions is produced by interrupting a join; the app-test fixture fakes it by writing a join journal directly rather than crashing a real one (see [#deep-dives]).

#### Constraints {#constraints}

- **Warnings are errors.** The Rust workspace enforces `-D warnings`.
- **[L02]** external state enters React through `useSyncExternalStore` only; **[L06]** appearance through CSS/DOM, never React state; **[L22]** store→store wiring observes the store directly; **[L19]** compose `Tug*` components, never hand-roll chrome; **[L29]** persisted/compared paths go through the canonicalization gateway — draft addressing keys on `workspaceKey`, never `projectDir`.
- **[L30]** every user-invocable command is a registry entry. The Join route segment gets one even though it carries no binding.
- App-tests are selected, never swept: every new test carries `@covers`, and the run is `just app-test-changed`.

#### Assumptions {#assumptions}

- `changeset_draft_set` is owner-kind agnostic (verified: `do_changeset_draft_set` passes `request.owner_kind` straight through to the ledger), so the deck can write a `dash` draft row with no server change.
- The draft engine's dash target already produces a usable join message (verified: `DraftTarget::Dash` composes from base/branch/worktree), so Auto-Message in join mode needs no new server work.
- A dash is **empty** exactly when `rounds === 0 && !worktree_dirty`. This holds because `join_in` auto-commits worktree dirt *before* testing `ahead == 0`, so any dirt makes the dash non-empty. It is the same predicate the lane already uses to gate its diff pop-out (`hasRange`).
- The `stage === "landing"` word in `DashChangesetEntry` is exactly "a join journal exists" (verified: `derive_stage`'s `landing` argument is `read_join_journal(...).is_some()`), so it is a sound trigger for the resume affordance without exposing the journal's phase.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Should the card expose the join strategy? (DEFERRED) {#q01-strategy}

**Question:** `changeset_join` accepts `squash` | `merge` | `rebase`, and `JoinOptions` honors all three. The card will always send `squash`. Should join mode offer a strategy picker?

**Why it matters:** adding it later is additive (a chip in the Z5 rail or the lane row, one field on the sender that already exists); adding it now costs chrome, a persistence question, and a test matrix, on a control that every observed dash landing would leave alone.

**Plan to resolve:** revisit if a real landing wants `merge` or `rebase` — the CLI path (`tugutil dash join <name> --strategy merge`) covers that case today with no UI at all.

**Resolution:** DEFERRED. The default is not a guess: squash is what `JoinStrategy::default()` is, what every skill path sends, and what the `Tug-Dash` trailer and History badge are shaped around.

#### [Q02] Should the landing gate move off `canInterrupt`? (DEFERRED) {#q02-idle-predicate}

**Question:** `evaluateCommitLandGate` takes `turnInProgress: codeSessionStore.getSnapshot().canInterrupt === true`. The consolidation plan's landing-gate decision called for one exported predicate over the lifecycle state and explicitly named `canInterrupt` as "the proxy" it did not want. `evaluateJoinLandGate` will mirror the shipped shape. Should both move to a lifecycle predicate in this phase?

**Why it matters:** two landing gates that disagree about what "a turn is running" means would be worse than one that is imprecise. Mirroring keeps them in step; correcting them is a separate, testable change across a shipped surface.

**Plan to resolve:** a follow-on that introduces the predicate in `turn-lifecycle`'s published face and retrofits both gates in one commit, with the existing commit-gate tests as the regression net.

**Resolution:** DEFERRED to phase 5's polish. This plan pins the *equality* of the two gates ([P05]), which is what makes the later correction a one-line change in one place.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| The `landingMode` refactor destabilizes the shipped commit surface | high | med | The interface is extracted from `CommitModeController`'s existing public shape, so the class is unchanged; `commit-mode-controller.test.ts` (37 assertions) is the regression net and must stay green untouched | any edit to `CommitModeController`'s body in #step-3 |
| A preview races the tree and the land is refused anyway | med | med | Blockers are re-derived at land time by `join_in` itself, unchanged; the card treats a `_err` on execute as a blocked presentation and re-previews | a land refusal reaching the user as an unexplained error string |
| Landing from the card leaves a stale binding or draft | med | low | Already handled server-side and verified in this plan's reading; #step-11 asserts it end to end rather than assuming it | any change to `do_changeset_join`'s success arm |
| Release destroys work from a mis-click | high | low | Shade-only, two-beat, with the discard preflight listing round subjects ([release ruling](archive/changes-commit-dash-consolidation.md#p14-release)); no prompt-entry verb, no chord | any proposal to add `/dash-release` |
| The join receipt and the commit receipt drift | med | med | One renderer module per receipt kind, both parsing a server-formatted string, both pinned by a Rust test asserting the exact bytes and a deck test parsing them back | any hand-formatted receipt string appearing client-side |

**Risk R01: The composer's mode swap regresses commit** {#r01-composer-swap}

- **Risk:** `tug-prompt-entry.tsx` is 3,892 lines and the commit-mode machinery is threaded through ~15 hooks and refs. Renaming its input from `commitMode` to `landingMode` touches every one.
- **Mitigation:**
  - The change is a **type swap plus label parameterization**, not a restructure: every `commitModeRef.current?.x()` call keeps its call site and its ordering; only the declared type and the user-facing strings move.
  - `at0253-commit-dialog.test.ts` runs unchanged in #step-4's checkpoint and must stay green before the join half is wired.
  - The `data-commit-empty` attribute keeps its spelling (`data-landing-empty` would be a CSS rename with no functional gain and a real chance of a missed selector); a comment records why.
- **Residual risk:** a commit-mode behavior with no test coverage could shift silently. The borrowed-height pin and the single-undo auto-message fold are the two most likely; both are exercised by hand during #step-4's build.

**Risk R02: `join_in`'s cwd guard is meaningless from tugcast** {#r02-cwd-guard}

- **Risk:** `join_in` refuses when `std::env::current_dir()` starts with the dash worktree. Called from tugcast that reads the *server's* cwd, which has nothing to do with the card. The guard neither protects the card path nor fires on it — but it *could* fire spuriously if tugcast were ever launched from inside a worktree.
- **Mitigation:** the guard is left exactly where it is (it is correct and load-bearing for the CLI path) and is deliberately **not** among the preflight blockers ([P02]); the plan records why, so a later reader does not "fix" the omission.
- **Residual risk:** a tugcast started with its cwd inside a dash worktree would refuse every join from the card with a message about running from the repo root. Out of scope to fix here; noted for phase 5.

---

### Design Decisions {#design-decisions}

#### [P01] One `LandingMode` interface; two controllers (DECIDED) {#p01-landing-mode}

**Decision:** Extract the interface `tug-prompt-entry` needs from a landing mode — `kind`, `subscribe`, `getSnapshot`, `setMessageProvider`, `notifyMessageChanged`, `persistMessage`, `requestDraft`, `cancelDraft`, `land`, `leave`, `exit`, `setLandHook`, plus a snapshot shape — into `tugdeck/src/lib/landing-mode.ts`. `CommitModeController` conforms to it **with no change to its body**. A new `JoinModeController` conforms to it too, with its own gate, its own draft owner key, and its own land verb. The prompt entry holds exactly one `landingMode` prop.

**Rationale:**
- The composer owns one document, so at most one landing mode can be active. A single slot makes that structural rather than a rule two controllers must both remember.
- The ~250 lines of editor-swap, borrowed-height, debounced-persist, and auto-message-stream machinery are genuinely identical for both landings; duplicating them creates two copies that must be kept in step forever — the same duplication phase 3 removed from the dash skills' doctrine text.
- Two controllers rather than one generalized controller keeps the shipped commit surface's internals and its 430-line test file untouched, which is where the regression risk actually lives.

**Implications:**
- `CommitModeSnapshot` and `JoinModeSnapshot` share a common supertype `LandingSnapshot` carrying `active`, `seedMessage`, `canLandIgnoringMessage`, `landReady`, `draftPhase`, `draftText`, `persistedMessage`, `edited`, `landPhase`, `landError`, `draftError`; each adds its own fields (commit: `fileCount`, `claimableCount`; join: `dash`, `outcome`, `conflicts`, `blockers`).
- The prompt entry's user-facing strings ("Commit", "Cancel commit", "Write a commit message") become functions of `landingMode.kind`.
- A host with no landing mode (the Component Gallery) keeps rendering an empty leading slot, unchanged.

#### [P02] `--preview` reports the blockers the execute path checks (DECIDED) {#p02-preview-blockers}

**Decision:** Factor the execute path's preflight into `pub fn join_preflight_in(repo_root: &Path, name: &str) -> Result<Vec<JoinBlocker>, String>` in `tugdash-core::ops`, and have the `--preview` arm call it and return the result on `JoinOutcome.blockers`. The execute path keeps its own inline checks byte-for-byte, so no landing behavior changes. `JoinBlocker` is `{ kind: JoinBlockerKind, detail: String }` with `kind ∈ { OffBase, BaseDirt, StaleJournal, Empty }`.

**Rationale:**
- The commit/join two-beat doctrine is that beat 1 shows exactly what beat 2 will do. Today a clean preview can still be refused at land — the surface would promise a landing it cannot deliver.
- Deriving these client-side is worse on every axis: the base-dirt intersection is real git logic (`base...branch` diff ∪ worktree dirt, intersected with the base's dirty tracked paths) that would be re-implemented in TypeScript, and the stale journal is not exposed on the wire at all.
- The CLI gains an honest `--preview` for free, which is the surface the `dash-join` skill reads.

**Implications:**
- `JoinOutcome` gains `blockers: Vec<JoinBlocker>`, serialized additively (`#[serde(default, skip_serializing_if = "Vec::is_empty")]`) so every existing `--json` consumer is unaffected.
- The execute path is *not* rewritten to consume `join_preflight_in`. Duplication is accepted here deliberately: rewriting the one code path that mutates the user's repository, to save a dozen lines, is a bad trade. A Rust test asserts the two agree on each blocker kind.
- The cwd guard is not a blocker ([R02]).
- `Empty` is reported as a blocker rather than as an error, because on the preview path it is a *finding*, and the card's response to it is an affordance (release), not a refusal.

#### [P03] The Join route is a third segment, present only while bound (DECIDED) {#p03-third-segment}

**Decision:** The Z4A route group becomes `Prompt | Changes | Join`, with the Join segment rendered only when `cardSessionBindingStore.getBinding(cardId)?.dash` is present. The group stays a pure VIEW of whichever landing mode is active — `value` is derived, and the segments dispatch `enter()` / `exit()` on the matching controller.

**Rationale:**
- A route is a mode that owns the composer's whole document, and the join message is exactly that. Leaving it out of the group would make join the one document-owning route with no visible tab.
- A bound card must keep its one-gesture path to a base-branch commit: a dash is where the work happens, but the base checkout still accumulates changes worth committing. Making the Changes segment polymorphic would take that away.
- Conditioning on the binding means an unbound card's chrome is byte-identical to today's.

**Implications:**
- `SELECT_COMPOSER_ROUTE`'s payload widens to `"prompt" | "changes" | "join"`; the session card's handler gains a `join` arm.
- The group's `value` derivation becomes: join mode active → `"join"`, commit mode active → `"changes"`, else `"prompt"`.
- Entering one landing mode exits the other (enforced in the controllers' `enter()`, not in the view).

#### [P04] `/dash-join` enters the mode; it no longer submits a turn (DECIDED) {#p04-join-verb}

**Decision:** The session card's local `join` slash handler stops calling `buildCommandSubmission("tugplug:dash-join", args)` and instead resolves a target dash and calls `joinModeController.enter()`. Grammar: bare `/dash-join` = the bound dash; `/dash-join <name>` = an explicit dash in this project; `/dash-join <name> <message…>` seeds the join message as an edited draft, exactly as `/commit <message>` does. An unresolvable name is a pane-bulletin caution, never a silent no-op.

**Rationale:**
- The landing is the user's act and belongs in front of the button, not in a turn. Spending a model turn to run a git command the card can run directly is the seam this phase closes.
- The `dash-join` skill survives untouched as the agentic path (`/tugplug:dash-join <name>`), so nothing is lost — the two entrances differ in who is driving, which is the honest distinction.
- Seeding from args mirrors `/commit`'s shipped semantics, so the two landings are learned once.

**Implications:**
- `/dash-join`'s current `canSubmit` hard refusal goes away: entering a mode mid-turn is harmless (drafting stays live mid-turn per the consolidation doctrine); only the *land* is gated.
- `slash-commands.ts`'s `join` description is rewritten to name the mode rather than the skill.
- The unbound-and-nameless case ("`/dash-join` with no dash anywhere") cautions with the same shape `/dash-bind` uses: *"No dash bound — /dash-join &lt;name&gt;"*.

#### [P05] Join's land gate mirrors commit's, field for field (DECIDED) {#p05-gate-parity}

**Decision:** `evaluateJoinLandGate(input): JoinLandGate` is a pure exported function in `join-mode-controller.ts`, ordered and shaped exactly like `evaluateCommitLandGate`: `turn` → `pending` → `outcome` → `empty-message`. `turnInProgress` reads `codeSessionStore.getSnapshot().canInterrupt === true`, the same proxy commit reads ([Q02]).

**Rationale:**
- Two landing gates that disagree about "a turn is running" is the failure this parity prevents.
- Ordering matters for the same reason it does in commit: the reasons map to the Join button's disable-and-hint precedence, turn first.

**Implications:**
- The `outcome` reason covers "no clean-or-resolved preview yet": the gate fails unless the join state is `preview` with empty `conflicts` and empty `blockers`, **or** the resolve ladder produced a `candidateCommit`.
- The gate is enforced twice, exactly as commit's is: once at the affordance (the Z5 Join button's disabled state) and once inside `land()`, because the staged path fires a beat later after the shade animates out.

#### [P06] Join and release receipts are server-formatted shell-ledger ink (DECIDED) {#p06-receipts}

**Decision:** On a landed join, `do_changeset_join` formats an S01 join summary in Rust, writes it to the shell ledger as `NewShellExchange { command: "/dash-join", output: summary, exit_code: Some(0), cwd: project_dir }`, and adds `summary` to `changeset_join_ok`. Release does the same with `command: "/dash-release"` and an S02 release summary. The deck's `use-landing-receipts.ts` grows a join arm and a release arm; a new `session-join-receipt-block.tsx` registers both commands and parses the summaries.

**Rationale:**
- This is the shipped commit-receipt pattern applied unchanged (one Rust formatter, durable through the ledger, restored on reload via `list_shell_exchanges`, non-context per the shell-route doctrine). The client-side `formatJoinReceiptInk` / `formatReleaseReceiptInk` were deleted when commit moved server-side; this is their honest replacement.
- One formatter per receipt kind means the live row and the restored row cannot drift.
- `/dash-release` as the receipt's command string names what happened even though no such typed verb exists — the row records the *act*, and the release gesture is shade-only by ruling.

**Implications:**
- `changeset_join` and `changeset_release` payloads gain an optional `session_id` (neither carries one today), because the ledger row is keyed by it. Absent, the receipt is skipped and the landing still succeeds — the same "a ledger error never fails the verb" rule the commit path follows.
- The receipt renderer is a sibling module, not a branch inside `session-commit-receipt-block.tsx`: the display facts differ (a join has a base branch, a round count, and a dash name; it has no per-file ± election), and a shared renderer would be a union type with two disjoint halves.

#### [P07] The Join route gets a registry entry and no chord (DECIDED) {#p07-no-chord}

**Decision:** Register `select-composer-route:join` in `command-registry.ts` with a title, `key-card` routing, and **no bindings**. Assign no key equivalent in this phase.

**Rationale:**
- Every user-invocable command is a registry entry ([L30]); the segment is user-invocable, so it gets one whether or not it carries a chord. Note the precedent is *not* uniform and the implementer will notice: `select-composer-route:prompt` is registered, but `:changes` deliberately is not — the comment above the prompt entry in `command-registry.ts` explains that the Changes route's door is the Session menu's Show/Hide Changes toggle, so a second entry would name a control's internal state as a command. Join has no such menu twin, which is why it takes an entry of its own rather than following Changes.
- The obvious chord is taken: `⌃⌘J` is **Show Jots**, and `⌘J` is **New Jot**. Displacing either for a gesture that already has three entrances (the segment, `/dash-join`, the lane affordance) would be a bad trade.
- A binding can be added later with no structural change — the entry is already there for the keymap pane and the collision lint to see.

**Implications:** the group's Join segment renders no `tooltipShortcut`, unlike Prompt (`⌃⌘P`) and Changes (`⌃⌘C`). That asymmetry is visible and intended.

#### [P08] One operation, one name: the name is the `tugutil` verb path (DECIDED) {#p08-one-name}

**Decision:** An operation is spelled the same way on every surface a user can see it — CLI, card verb, skill, receipt row, menu label — and that spelling is its `tugutil` verb path, hyphenated. `tugutil dash join` ⇒ `dash-join` ⇒ `/dash-join`. This phase renames the card verbs that violate it and ships no new name that does.

| Surface | Was | Is | Rides |
|---|---|---|---|
| Card verb | `/join` | `/dash-join` | `tugutil dash join` |
| Card verb | `/dash` | `/dash-bind` | `tugutil dash bind` (minting on a missing dash stays its behavior) |
| Receipt row | `/join` | `/dash-join` | `tugutil dash join` |
| Receipt row | `/release` | `/dash-release` | `tugutil dash release` |
| Card verb | `/commit` | `/commit` | `tugutil commit` |
| Card verb | `/plan-review` | `/plan-review` | `tugutil plan` |
| Skill | `dash-join` | `dash-join` | `tugutil dash join` |

**Rationale:**
- A user who has seen an operation once should be able to type it, read it in a receipt, and find it in `--help` without learning three spellings. `/join` / `dash-join` / `tugutil dash join` was three.
- The rule is mechanical, so it settles the next name before anyone argues about it — there is no taste left in the decision.
- It is also a collision detector. Applying it surfaced that `tugutil commit` (land this session's changes on the base) and `tugutil dash commit` (record a round on a dash worktree) are two operations wearing one word, which phase 4 puts in front of a dash-bound card for the first time.

**Implications:**
- `/dash-commit` is **reserved** for the round verb and ships no card verb in this phase. `/commit` keeps its meaning — land on the base branch — on bound and unbound cards alike ([P03]'s second rationale). Naming the reservation is what keeps a later phase from spending the word twice.
- The retired card spellings (`/join`, `/dash`) stay registered as deprecated aliases that run the new handler and raise a one-time pane-bulletin naming the new verb. This is the shape `tugplug/skills/join/SKILL.md` already uses for the retired skill spellings; a verb that silently stops matching would submit the user's line to Claude as a prompt, which is the one outcome worse than a rename.
- `LocalCommandName` is a literal union derived from `LOCAL_SLASH_COMMANDS`, and the session card keys an exhaustive `Record<LocalCommandName, …>` off it, so a rename is compiler-enforced across every handler — `bunx tsc --noEmit` is the completeness check, not a grep.

---

### Deep Dives {#deep-dives}

#### What is already built (the inventory this plan wires) {#machinery-inventory}

| Piece | Where | State |
|---|---|---|
| `changeset_join` sender, `JoinState`, `useChangesetJoin` | `tugdeck/src/lib/changeset-verb-store.ts` | **built, unconsumed** |
| `changeset_release` sender, `ReleaseState`, `useChangesetRelease` | same | **built, unconsumed** |
| `changeset_join_resolve` ladder overlay | `tugdeck/src/lib/changeset-join-store.ts` | **built, unconsumed** |
| `do_changeset_join` / `do_changeset_release` | `tugcast/src/feeds/agent_supervisor.rs` | **built** — incl. draft clear + binding clear on success |
| `join_in` (preview, preflight, journal, teardown, candidate land) | `tugdash-core/src/ops.rs` | **built** |
| `release_in` | same | **built** |
| Dash draft generation (`DraftTarget::Dash`) | `tugcast/src/feeds/draft_engine.rs` | **built** |
| Dash lane rows, fronting, range pop-out, read-only draft ink | `session-changes-dash-lane.tsx` | **built, read-only** |
| `Tug-Dash` trailer parser for the History badge | `tugdeck/src/lib/landing-receipt.ts` | **built** |
| Commit mode: controller, composer machinery, Z5 rail, staged land, receipt block | `commit-mode-controller.ts`, `tug-prompt-entry.tsx`, `session-commit-receipt-block.tsx` | **built — the model to mirror** |

#### The four outcomes, and where each one comes from {#outcome-derivation}

| Outcome | Derived from | Presentation |
|---|---|---|
| clean | `JoinState.phase === "preview"`, `conflicts` empty, `blockers` empty | Join affordance enabled; the message editor is the whole surface |
| conflicted | `JoinState.conflicts` non-empty (from a preview, or from an execute that cleanly aborted) | the resolve lane over `changeset-join-store`; on `resolved` with a `candidateCommit`, a candidate land |
| blocked | `JoinState.blockers` non-empty ([P02]); or a `changeset_join_err` detail on execute | the named blocker plus the act that clears it; no Join affordance |
| empty | `blockers` carries `Empty`; derivable client-side as `rounds === 0 && !worktree_dirty` | "nothing to join — release this dash?" with the release affordance fronted ([release ruling](archive/changes-commit-dash-consolidation.md#p14-release)) |
| interrupted teardown | `DashChangesetEntry.stage === "landing"` | "Resume teardown" → `changeset_join { continue: true }` |

The client-side empty predicate is kept as a **pre-preview** face (the lane can say "empty" before any round trip), and the server's `Empty` blocker is the authority once a preview lands. They agree by construction — see [#assumptions].

#### Blocker kinds, and the act that clears each {#blocker-acts}

| Kind | `join_in`'s check | The unblocking act the card names |
|---|---|---|
| `OffBase` | repo root's `rev-parse --abbrev-ref HEAD` ≠ the dash's base | "Check out `<base>` first" |
| `BaseDirt` | base's dirty tracked paths ∩ (`base...branch` diff ∪ worktree dirt) | "Commit or stash `<paths>`" — and the paths are this card's own Changes lane, one gesture away |
| `StaleJournal` | `read_join_journal(...).is_some()` | "Resume the interrupted teardown" — the same affordance `stage === "landing"` fronts |
| `Empty` | `rev-list --count base..branch == 0` | "Release this dash" |

#### Faking a `landing`-stage dash in an app-test {#landing-fixture}

The resume-teardown affordance keys on `stage === "landing"`, which is `read_join_journal(...).is_some()`. Crashing a real join mid-teardown is not something a test can do reliably. Instead the fixture writes the journal file directly and lets the normal derivation do the rest — the test then exercises the *presentation and the frame*, which is what it is for. The journal's on-disk home and shape are `write_join_journal`'s in `tugdash-core/src/ops.rs`; read it there rather than guessing, and remove the file in `afterAll` so the dash can still be released.

This is not a mock: the derivation, the feed, the entry, and the affordance are all real. Only the *cause* of the journal is synthetic, and the cause is not what is under test.

---

### Specification {#specification}

**Spec S01: the join receipt summary** {#s01-join-summary}

Server-formatted in `tugcast/src/feeds/changeset.rs`, beside `format_commit_summary` and following its shape exactly (a fixed machine header, an optional JSON facts line, then the verbatim message). `·` is U+00B7 and `−` is U+2212, matched exactly so a hand-typed dash never false-parses.

```
joined <short-sha> · <dash> → <base> · <N> round(s)
<full join message>
```

`<short-sha>` is the first 10 characters of the landing commit. The message is the squash message `join_in` actually used (the maintained draft, or the override the card sent) — trimmed, never truncated.

**Spec S02: the release receipt summary** {#s02-release-summary}

```
released <dash> · discarded <N> round(s)<, <M> dirty file(s)>
<round subject 1>
<round subject 2>
…
```

The round subjects are the ones the discard preflight showed, so the receipt is a record of exactly what the confirm destroyed. A clean dash (no rounds, no dirt) renders the header line alone.

**Spec S03: `JoinBlocker` on the wire** {#s03-blocker-wire}

```rust
#[derive(Debug, Clone, Serialize)]
pub struct JoinBlocker {
    /// `off-base` | `base-dirt` | `stale-journal` | `empty`
    pub kind: String,
    /// The human line, identical to the `Err` string the execute path returns.
    pub detail: String,
    /// Paths, for `base-dirt`; empty otherwise.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub paths: Vec<String>,
}
```

Carried on `JoinOutcome.blockers` and echoed verbatim into `changeset_join_ok` as `blockers`. The deck reads it into `JoinState.blockers: readonly JoinBlocker[]`, with an unknown `kind` degrading to a rendered `detail` line and no affordance — never a crash, never a swallowed blocker.

**Spec S04: the widened `changeset_join` / `changeset_release` payloads** {#s04-payloads}

`changeset_join` gains two optional fields, both defaulting to today's behavior:

| Field | Type | Meaning |
|---|---|---|
| `continue` | bool, default `false` | resume an interrupted teardown from the journal (`JoinOptions.continue_join`) |
| `session_id` | string, optional | the card's tug session id, for the receipt's ledger row ([P06]) |

`changeset_release` gains `session_id` on the same terms. A missing `session_id` skips the receipt and never fails the verb.

#### State Zone Mapping {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| Join mode `active` + its target dash | structure | `JoinModeController` store + `useSyncExternalStore` | [L02] |
| Join preview/land phase, conflicts, blockers | structure | existing `changeset-verb-store` (`JoinState`) | [L02] |
| Resolve-ladder progress and candidate | structure | existing `changeset-join-store` (`ResolveState`) | [L02] |
| The join message document | local data (durable) | CM6 doc, persisted debounced to `(workspaceKey, "dash", owner_id)` via `changeset-draft-store` | [L22], [L29] |
| `data-commit-empty` on the entry root (message-empty CSS gate) | appearance | DOM attribute set from the editor's update listener | [L06], [L22] |
| The composer's borrowed height on mode entry | appearance | `scrollDOM.style.minHeight`, cleared on exit | [L06] |
| Z4A route group value | appearance (derived) | computed from the two controllers' snapshots; no second home | [L02] |
| Lane row expansion, discard-preflight expansion | local data (view-scope) | `useState` in the lane, exactly as the existing fold | [L24] |
| Staged land callback (fire after the shade hides) | structure | `useRef` + `useSheetDelegate`'s `sheetDidHide`, mirroring the staged commit | [L07] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/lib/landing-mode.ts` | The `LandingMode` interface + `LandingSnapshot` supertype ([P01]) |
| `tugdeck/src/lib/join-mode-controller.ts` | `JoinModeController`, `evaluateJoinLandGate`, `JoinLandGate` |
| `tugdeck/src/lib/__tests__/join-mode-controller.test.ts` | Gate table + controller lifecycle |
| `tugdeck/src/components/tugways/cards/session-join-receipt-block.tsx` | The `/dash-join` + `/dash-release` receipt renderer ([P06]) |
| `tugdeck/src/components/tugways/cards/session-join-receipt-block.css` | Its slot styles |
| `tugdeck/src/components/tugways/cards/__tests__/session-join-receipt-block.test.ts` | Summary parse round-trip |
| `tugdeck/src/components/tugways/cards/session-changes/session-changes-dash-landing.tsx` | The lane row's landing face: outcome, blockers, affordances |
| `tests/app-test/at0417-join-mode.test.ts` | `/dash-join` enters the mode, seeds the draft, shows the third segment |
| `tests/app-test/at0418-join-outcomes.test.ts` | Empty → release fronted; blocked → named act; `landing` → resume |
| `tests/app-test/at0419-join-receipt.test.ts` | A real land leaves one `/dash-join` row that survives a reload |

The numbers are `at0417`–`at0419` because `at0410`–`at0416` are taken and a contiguous run beats reusing `at0409` (free only because `at0409-plan-review-borrow.test.ts` was deleted in `b15d1a629`, so the number still names something else in old transcripts). `at0410-text-card-file-drop.test.ts` and `at0411-atom-chip-label-survives-annotator.test.ts` are live files; the tree already carries one accidental collision (`at0412-plan-review-verb.test.ts` and `at0412-text-card-asset-strip.test.ts`), which is exactly the confusion a fresh number avoids. `ls tests/app-test/` before creating a file, and take the next free number if the corpus has grown since this plan was written.

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `JoinBlocker`, `JoinBlockerKind` | struct/enum | `tugdash-core/src/ops.rs` | Spec S03 |
| `join_preflight_in` | fn | `tugdash-core/src/ops.rs` | [P02]; `pub`, re-exported from `lib.rs` |
| `JoinOutcome.blockers` | field | `tugdash-core/src/ops.rs` | additive, skip-if-empty |
| `run_join` | fn | `tugutil/src/dash.rs` | print blockers under the preview arm |
| `ChangesetJoinPayload.continue_join`, `.session_id` | fields | `tugcast/src/feeds/agent_supervisor.rs` | Spec S04 |
| `ChangesetReleasePayload.session_id` | field | same | Spec S04 |
| `format_join_summary`, `format_release_summary` | fn | `tugcast/src/feeds/changeset.rs` | Specs S01, S02 |
| `JoinState.blockers`, `.summary`; `ReleaseState.summary` | fields | `tugdeck/src/lib/changeset-verb-store.ts` | |
| `JoinArgs.continueJoin`, `.sessionId` | fields | same | |
| `LandingMode`, `LandingSnapshot`, `LandingKind` | interface/type | `tugdeck/src/lib/landing-mode.ts` | [P01] |
| `JoinModeController`, `evaluateJoinLandGate` | class/fn | `tugdeck/src/lib/join-mode-controller.ts` | [P05] |
| `TugPromptEntryProps.landingMode` | prop | `tugdeck/src/components/tugways/tug-prompt-entry.tsx` | replaces `commitMode` |
| `select-composer-route:join` | registry entry | `tugdeck/src/components/tugways/command-registry.ts` | [P07], no bindings |
| `LOCAL_SLASH_COMMANDS` `dash-join` / `dash-bind` | entries | `tugdeck/src/lib/slash-commands.ts` | [P08]; `join` / `dash` survive as deprecated aliases |
| `ReleaseState.phase` `"done"` | variant | `tugdeck/src/lib/changeset-verb-store.ts` | the release receipt's terminal edge ([P06]) |
| `SELECT_COMPOSER_ROUTE` payload doc | comment | `tugdeck/src/components/tugways/action-vocabulary.ts` | widen to three values |
| `useLandingReceipts` | fn | `tugdeck/src/components/tugways/cards/use-landing-receipts.ts` | join + release arms |
| `SessionChangesDashLane` | component | `session-changes-dash-lane.tsx` | takes the landing props; delegates the face |

---

### Documentation Plan {#documentation-plan}

- [x] `tuglaws/tracking-changes.md` — the landing section gains the one-slot landing mode, the outcomes table (five rows: the four plus the interrupted teardown), and the server-formats-once receipt rule.
- [x] `tuglaws/slash-commands.md` — the recipes section gains "Name a command" ([P08]'s rule) and "Retire a spelling" (the alias mechanism and why an unmatched verb is worse than a rename).
- [x] `tugplug/skills/dash-join/SKILL.md` — a paragraph naming the card's join mode as the interactive twin over the same verb.
- [ ] `tuglaws/design-decisions.md` — **not written.** The `[D##]` was conditional on the review judging [P01] to be a global rule; round 1 did not, so it stays plan-local. The rule is stated in `tracking-changes.md`'s landing section, which is where a reader looking for it would be.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Rust unit** | `join_preflight_in`'s blocker table; the summary formatters' exact bytes | Steps 1, 7 |
| **Rust wire** | The widened payloads parse, and default to today's behavior when absent | Step 2 |
| **Deck unit (bun)** | The pure gate; the controller's lifecycle; the summary parsers | Steps 2, 3, 8 |
| **App-test** | The real app, real dash, real CLI: mode entry, outcomes, receipt durability | Steps 5, 6, 11 |

#### What stays out of tests {#test-non-goals}

- **Render tests over the composer's mode swap** — banned shape (fake-DOM/RTL). The swap is covered where it is real: an app-test asserting the composer's document text after `/dash-join`.
- **Mock-store assertions** — banned. The controller tests drive real store singletons reset per case, the way `commit-mode-controller.test.ts` does.
- **A real interrupted join** — the teardown's crash window is not reproducible from a test; the journal is written directly and the derivation is exercised for real ([#landing-fixture]).
- **The resolve ladder's AI rung** — it runs a scribe child; the lane's presentation is tested against injected `changeset_join_resolve_*` frames through the store's existing `_ingestJoinFrameForTest` hook, and the ladder itself is already covered in `tugdash-core::resolve`.
- **`merge` / `rebase` strategies from the card** — the card never sends them ([Q01]).

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Preview reports blockers | done | `4c625a170` |
| #step-2 | Blockers, continue, and session id on the wire | done | `b11137fac` |
| #step-3 | The `LandingMode` interface and `JoinModeController` | done | `1efdd2955` |
| #step-4 | The composer takes one landing mode | done | `112a039e5` |
| #step-5 | `/dash-join` enters join mode | done | `36df48ea8` |
| #step-6 | The dash lane's four-outcome face | done | `3f6048cc9` |
| #step-7 | Server-formatted join and release summaries | done | `9b482233c` |
| #step-8 | The join receipt block | done | `85ffb8b14` |
| #step-9 | The resolve lane | done | `3c835119b` |
| #step-10 | Release, with the discard preflight | done | `bdd71a2a0` |
| #step-11 | Integration checkpoint | done | `bc36cdc89` |

---

#### Step 1: Preview reports blockers {#step-1}

**Commit:** `tugdash(join-lane): --preview reports the blockers the execute path checks`

**References:** [P02] preview blockers, Spec S03, Risk R02, (#blocker-acts, #outcome-derivation)

**Artifacts:**
- `JoinBlocker` + `join_preflight_in` in `tugdash-core/src/ops.rs`, re-exported from `lib.rs`
- `JoinOutcome.blockers`, additive
- The CLI's preview arm printing them

**Tasks:**
- [ ] Add `JoinBlocker` per Spec S03. Keep `kind` a `String` on the struct (matching `JoinOutcome.strategy`'s existing shape) rather than a serialized enum, so the JSON is stable and additive.
- [ ] Write `join_preflight_in(repo_root, name) -> Result<Vec<JoinBlocker>, String>`: resolve the branch and base via `branch_name` / `dash_base`, then check, in this order — `StaleJournal` (`read_join_journal(...).is_some()`), `OffBase` (`rev-parse --abbrev-ref HEAD` in the repo root ≠ base), `BaseDirt` (`dirty_tracked_paths(repo_root)` ∩ (`diff --name-only base...branch` ∪ `dirty_tracked_paths(worktree)`)), `Empty` (`rev-list --count base..branch == 0` **and** the worktree is clean). Each `detail` is the same sentence the execute path's `Err` returns, so the two surfaces read identically.
- [ ] Do **not** include the cwd guard ([R02]); leave `join_in`'s inline check exactly where it is and add a one-line comment at the guard naming why it is absent from the preflight.
- [ ] **Move the `opts.preview` arm above the stale-journal guard** (or gate that guard on `!opts.preview`). Today `join_in` returns `Err("A previous join of dash '…' is incomplete…")` *before* it reaches the preview arm, so a preview of a journalled dash never previews at all — and `join_preflight_in` called from the preview arm could never report `StaleJournal`, which would make the test below unpassable. Read the order in `join_in` before editing: branch-exists → `continue_join` → stale-journal `Err` → `opts.preview` → cwd guard → off-base → base-dirt → `commit_worktree_dirt` → `ahead == 0`.
- [ ] This is a deliberate **preview** behavior change, and the only one in this step: `--preview` on a journalled dash stops erroring and starts returning a preview carrying a `stale-journal` blocker. That is [P02]'s whole point — the execute path is still what refuses, and it is untouched.
- [ ] Correct the two stale CLI names in these strings while you are here: `join_in` tells the user to run `tugdash join <name> --continue` and the merge-tree guard says `tugdash join --preview requires git >= 2.38`. There is no `tugdash` binary — the verb is `tugutil dash join`. Because the blocker's `detail` is this same sentence, leaving it would put a nonexistent command in front of the user in the card.
- [ ] Call `join_preflight_in` from the `opts.preview` arm of `join_in` and put the result on the returned `JoinOutcome`. The conflict computation is unchanged and still runs — a blocked dash can also conflict, and the card wants both.
- [ ] Leave the execute path's inline checks untouched ([P02] rationale).
- [ ] `run_join` in `tugutil/src/dash.rs`: under the preview arm, after the clean/conflict lines, print `Blocked:` and one indented `kind — detail` line per blocker.

**Tests:**
- [ ] `preview_reports_off_base_when_the_root_is_on_another_branch` — create a dash, check the root out to a scratch branch, preview, assert one `off-base` blocker.
- [ ] `preview_reports_intersecting_base_dirt_and_names_the_paths` — dirty a file in the base that the dash also changed; assert `base-dirt` with that path in `paths`. Dirty a *disjoint* file; assert no blocker.
- [ ] `preview_reports_a_stale_journal` — write a journal, preview, assert `stale-journal`. This is the test that pins the reordering above; it fails with an `Err` rather than a blocker if the guard is left in front of the preview arm.
- [ ] `preview_reports_empty_for_a_dash_with_no_rounds` — a fresh dash, clean worktree; assert `empty`. Add a round; assert no `empty`.
- [ ] `a_clean_dash_previews_with_no_blockers` — the happy path stays empty.
- [ ] `preflight_and_the_execute_path_agree` — for each blocker kind, assert that `join_in` with `preview: false` returns an `Err` whose string equals the blocker's `detail`.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core -p tugutil`
- [ ] `cd tugrust && cargo build` (warnings are errors)
- [ ] `tugutil dash join <a real dash> --preview --json` prints a `blockers` key and exits 0

---

#### Step 2: Blockers, continue, and session id on the wire {#step-2}

**Depends on:** #step-1

**Commit:** `tugdash(join-lane): carry blockers, continue, and session id through changeset_join`

**References:** [P02] preview blockers, [P06] receipts, Spec S03, Spec S04, (#outcome-derivation)

**Artifacts:**
- Widened `ChangesetJoinPayload` / `ChangesetReleasePayload` and their parsers
- `blockers` on the `changeset_join_ok` broadcast
- `JoinState.blockers`, `JoinArgs.continueJoin` / `.sessionId`, `ReleaseArgs`-equivalent on the deck

**Tasks:**
- [ ] `parse_changeset_join_payload`: read `continue` (bool, default false) into a new `continue_join` field and `session_id` (optional non-empty string). Read `session_id` in `parse_changeset_release_payload` too.
- [ ] `do_changeset_join`: pass `continue_join` into `JoinOptions` in place of today's hardcoded `false`; add `"blockers": outcome.blockers` to the `changeset_join_ok` body.
- [ ] `changeset-verb-store.ts`: add `blockers: readonly JoinBlocker[]` to `JoinState` (with a local `JoinBlocker` interface mirroring Spec S03 and a defensive reader that drops malformed entries), populate it on `changeset_join_ok`, and thread `continueJoin` / `sessionId` through `JoinArgs` and the `join()` sender. Add `sessionId` to `release()`.
- [ ] `JOIN_IDLE` gains a frozen empty `blockers`; `clearJoin` still resets to it.
- [ ] A `preview` reply with non-empty `blockers` still lands in `phase: "preview"` — blocked is a *finding about* a preview, not a distinct phase. The card reads `blockers` to decide the face ([#outcome-derivation]).

**Tests:**
- [ ] Rust: `changeset_join_payload_defaults_continue_to_false` and `…_reads_continue_and_session_id`.
- [ ] Rust: `changeset_release_payload_session_id_is_optional`.
- [ ] Rust wire: a `changeset_join_ok` body with no blockers serializes without a `blockers` key (skip-if-empty holds through the json! body).
- [ ] bun: feeding a `changeset_join_ok` with `previewed: true` and a `blockers` array leaves `phase === "preview"` and the blockers readable; a malformed blocker entry is dropped, not thrown.
- [ ] bun: `join(..., { preview: false, continueJoin: true })` sends a frame carrying `continue: true`.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`
- [ ] `cd tugdeck && bun test src/lib/__tests__/changeset-verb-store.test.ts`
- [ ] `cd tugdeck && bunx tsc --noEmit`

---

#### Step 3: The `LandingMode` interface and `JoinModeController` {#step-3}

**Depends on:** #step-2

**Commit:** `tugdash(join-lane): one LandingMode interface; JoinModeController beside CommitModeController`

**References:** [P01] landing mode, [P05] gate parity, [Q02] deferred idle predicate, Risk R01, (#state-zone-mapping)

**Artifacts:**
- `tugdeck/src/lib/landing-mode.ts`
- `tugdeck/src/lib/join-mode-controller.ts`
- `tugdeck/src/lib/__tests__/join-mode-controller.test.ts`

**Tasks:**
- [ ] Write `landing-mode.ts`: `LandingKind = "commit" | "join"`; `LandingSnapshot` with the fields named in [P01]'s implications; `LandingMode` with `kind`, `subscribe`, `getSnapshot`, `setMessageProvider`, `notifyMessageChanged`, `persistMessage`, `requestDraft`, `cancelDraft`, `land`, `leave`, `exit`, `setLandHook`.
- [ ] Make `CommitModeController` conform: add `readonly kind = "commit"` and rename the snapshot's `commitReady` → `landReady`, `commitPhase` → `landPhase`, `commitError` → `landError` **only if** the rename is mechanical at every call site; otherwise keep the commit names and have `LandingSnapshot` declare the shared names with commit's fields aliased in `derive()`. Prefer whichever leaves `commit-mode-controller.test.ts` passing with the smallest diff — that file is the regression net and its assertions should not be rewritten to fit a refactor.
- [ ] Write `JoinModeController` on `CommitModeController`'s exact structure: constructor takes `{ changesController, codeSessionStore }`; subscribes to the code-session store, the changes controller, the verb store, and the draft store; derives a snapshot; recomputes on change with a field-by-field equality check so `getSnapshot` stays referentially stable.
- [ ] `enter(dash: { ownerId: string; name: string }, seedMessage?: string)` records the target, writes a non-empty seed into the dash draft as `edited: true`, sets `active`, and calls `commitModeController.exit()` through an injected dependency so the two modes cannot both be up ([P03] implications).
- [ ] The join snapshot's `dash` field carries the resolved `DashChangesetEntry` fields the surface needs (`ownerId`, `name`, `base`, `rounds`, `worktreeDirty`); `outcome` is the derived word from [#outcome-derivation]; `conflicts` and `blockers` come straight off `JoinState`.
- [ ] `preview()` sends `changeset_join { preview: true }` for the target; `enter()` fires one automatically, because a mode that opens without knowing whether it can land is the thing this phase exists to fix.
- [ ] Draft addressing keys on `(changesController.workspaceKey, "dash", target.ownerId)` — `workspaceKey`, never `projectDir` ([L29]).
- [ ] `evaluateJoinLandGate` per [P05]: `turn` → `pending` → `outcome` → `empty-message`, exported pure.
- [ ] `land(message)` re-checks the gate against live state, then routes through `landHook` if installed (the staged path) or fires inline; `performJoin` re-checks again and sends `changeset_join { preview: false, message, candidate? }`, subscribing until the phase leaves `pending` and exiting the mode on `done`.

**Tests:**
- [ ] `evaluateJoinLandGate` table: each reason in precedence order, plus the pass case; a `preview` with blockers fails on `outcome`; a resolved candidate passes even with a non-empty `conflicts` history.
- [ ] `enter` seeds an edited dash draft and exits commit mode.
- [ ] `enter` fires exactly one preview.
- [ ] The snapshot is referentially stable across an unrelated store notification.
- [ ] `land` is a no-op when the gate fails, and the mode stays up.
- [ ] `dispose` releases every subscription ([L27]).

**Checkpoint:**
- [ ] `cd tugdeck && bun test src/lib/__tests__/join-mode-controller.test.ts src/lib/__tests__/commit-mode-controller.test.ts` — **both** green, the commit file unmodified
- [ ] `cd tugdeck && bunx tsc --noEmit`

---

#### Step 4: The composer takes one landing mode {#step-4}

**Depends on:** #step-3

**Commit:** `tugdash(join-lane): the prompt entry holds one landing-mode slot`

**References:** [P01] landing mode, [P03] third segment, [P07] no chord, Risk R01, (#state-zone-mapping)

**Artifacts:**
- `tug-prompt-entry.tsx`'s `landingMode` prop and parameterized chrome
- The Z4A route group's third segment
- `select-composer-route:join` in the command registry

**Tasks:**
- [ ] Rename the prop `commitMode: CommitModeController` → `landingMode: LandingMode`, and the local `commitSnap` / `commitActive` / `commitModeRef` / `inCommitModeRef` family to `landing*` equivalents. Every call site keeps its position and ordering — this is a type swap, not a restructure ([R01]).
- [ ] Keep the DOM attribute spelled `data-commit-empty` and add a comment saying why (a CSS rename buys nothing and risks a missed selector).
- [ ] Parameterize the user-facing strings on `landingMode.kind`: the Z5 land button's label and tooltip ("Commit" / "Join"), the cancel labels, the route segment's tooltip ("Write a commit message" / "Write the join message"), and the Auto-Message tooltip (unchanged text, both kinds).
- [ ] Z5's land button reads `landReady` / `canLandIgnoringMessage` from the shared snapshot; the unavailable tooltip becomes kind-specific ("Unavailable while a turn is running or the changeset is empty" / "Unavailable until the preview is clean").
- [ ] Add the third route segment, rendered only when the host passes `joinAvailable` (the session card derives it from the binding, [P03]). Its `value` is `"join"`, it carries no `tooltipShortcut` ([P07]), and the group's `value` derivation becomes the three-way one.
- [ ] Register `select-composer-route:join` in `command-registry.ts` with `routing: "key-card"`, a title of `Join Route`, and no `bindings` (about half the table's entries carry none, so this is ordinary); widen the payload comment in `action-vocabulary.ts` to three values. If a registry lint refuses an entry with no door, `__tests__/command-routing-drift.test.ts` and `__tests__/keybinding-map.test.ts` are where it will fire — read [P07] before appeasing it.
- [ ] The Component Gallery's prompt entry passes no landing mode and renders an empty leading slot, exactly as today.

**Tests:**
- [ ] `cd tugdeck && bun test` — the whole deck suite, because this step touches the composer every card mounts.
- [ ] `just app-test at0253-commit-dialog.test.ts` — commit mode green **before** any join wiring exists. This is the step's real assertion.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `just app-test at0253-commit-dialog.test.ts`
- [ ] `just app-test-changed`

---

#### Step 5: `/dash-join` enters join mode {#step-5}

**Depends on:** #step-4

**Commit:** `tugdash(join-lane): /dash-join enters join mode instead of submitting a turn`

**References:** [P04] join verb, [P08] one name, [P03] third segment, [P05] gate parity, (#outcome-derivation)

**Artifacts:**
- The session card's `JoinModeController` instance and its coupling
- The renamed + rewritten `dash-join` slash handler, and `/dash-bind`
- `at0417-join-mode.test.ts`

**Tasks:**
- [ ] Instantiate `JoinModeController` in `session-card.tsx` beside `commitModeController`, disposing it on unmount ([L27]).
- [ ] Rename the card verbs per [P08]: in `LOCAL_SLASH_COMMANDS` (`tugdeck/src/lib/slash-commands.ts`) `join` → `dash-join` and `dash` → `dash-bind`. `LocalCommandName` is a literal union over that array and the session card keys an exhaustive `Record<LocalCommandName, Surface>` off it, so `bunx tsc --noEmit` names every handler that has to move — do not hunt them by grep.
- [ ] Keep `join` and `dash` registered as deprecated aliases ([P08]): same handler, plus a one-time pane-bulletin naming the new spelling. Mark them so the composer's command picker does not list them — an alias is for muscle memory, not for discovery. An unmatched verb submits the user's line to Claude as a prompt, which is why they cannot simply be deleted.
- [ ] Rewrite the `dash-join` handler per [P04]: parse `[name] [message…]`; resolve the target — an explicit name against `changesController.getSnapshot().dashes` by `display_name`, a bare invocation against `cardSessionBindingStore.getBinding(cardId)?.dash?.id` matched by `owner_id`; caution on no match; otherwise `joinModeController.enter(target, seed)`. Drop the `canSubmit` refusal.
- [ ] Extend the `SELECT_COMPOSER_ROUTE` handler with a `join` arm entering join mode on the bound dash (a no-op when unbound, which is also when the segment is absent).
- [ ] Mode ↔ shade coupling: entering join mode shows the Changes shade and closes the find bar, exactly as commit mode does; exiting hides it unless the shade has swapped to History. Reuse the existing effect by observing an `anyLandingActive` derivation rather than writing a second one.
- [ ] The staged land: install a land hook on `JoinModeController` that parks the callback and exits the mode, so `sheetDidHide` fires the join after the shade animates out — the same shape as the staged commit.
- [ ] Pass `landingMode = joinActive ? joinModeController : commitModeController` and `joinAvailable = binding.dash !== undefined` to the prompt entry.
- [ ] `slash-commands.ts`: rewrite `dash-join`'s description to *"Land a dash — opens the join editor over a previewed merge"*.
- [ ] `use-menu-state-publication.ts`: publish join-mode readiness alongside commit's, so the Session menu's landing item can gate on the active mode rather than assuming commit.

**Tests:**
- [ ] `at0417-join-mode.test.ts` (`@covers` the controller, the prompt entry, the session card, `slash-commands.ts`): create a real dash with a round via `dash-fixture`, bind it, type `/dash-join`, and assert — the composer's document equals the dash's maintained join draft, the Z4A group shows three segments with Join selected, the Changes shade is up, and Escape returns the composer to the prompt with the message preserved on re-entry.
- [ ] Same file: `/dash-join <name> some message` seeds `some message`.
- [ ] Same file: on an unbound card the third segment is absent and bare `/dash-join` cautions.
- [ ] Same file: typing the retired `/join` enters the same mode and raises the bulletin naming `/dash-join` ([P08]) — the alias is the one part of the rename a user can hit by accident, so it is the part that gets an assertion.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `just app-test at0417-join-mode.test.ts`
- [ ] `just app-test-changed`

---

#### Step 6: The dash lane's four-outcome face {#step-6}

**Depends on:** #step-5

**Commit:** `tugdash(join-lane): the dash lane fronts the landing outcome and the act that clears it`

**References:** [P02] preview blockers, [P05] gate parity, Spec S03, (#outcome-derivation, #blocker-acts, #landing-fixture)

**Artifacts:**
- `session-changes-dash-landing.tsx`
- The lane row's landing face and its Join / Resume affordances
- `at0418-join-outcomes.test.ts`

**Tasks:**
- [ ] Write `SessionChangesDashLanding`: takes the entry, the `JoinState`, and callbacks; renders the outcome word and, per [#blocker-acts], one line per blocker naming the unblocking act. Compose `TugBadge` / `TugListRow` / `TugPushButton`; hand-rolled chrome is a law violation ([L19]).
- [ ] The fronted (this card's) dash row gains the Join affordance when the outcome is clean, disabled with a reason otherwise — the affordance-level half of the two-level gate ([P05]).
- [ ] `stage === "landing"` renders "Resume teardown", sending `changeset_join { continue: true }`. It renders regardless of outcome, because a stale journal blocks everything else.
- [ ] The empty outcome renders the "nothing to join — release this dash?" line **without a button**. The release affordance itself lands in #step-10; a disabled placeholder would be a dead control shipping for one step, which is worse than a line of prose that is already true.
- [ ] Non-fronted dash rows stay read-only: landing is a gesture on *this card's* dash (the [overlay rule](dash-integration-plan.md#p01-overlay)), and offering it on a stranger's dash would land work from a card that never touched it.
- [ ] **Only the fronted row previews, and only on expand.** `JoinState` is keyed by `entryKey`, which `ChangesRouteController` builds as `session:<tugSessionId>` — one slot per *card*, not per dash (`_joins` / `_joinInflight` in `changeset-verb-store.ts`). Two rows previewing therefore overwrite each other, and the loser renders the winner's blockers under its own dash name. Non-fronted rows show the entry's static facts and no outcome face at all, which is also what [the overlay rule](dash-integration-plan.md#p01-overlay) wants. Previewing on expand rather than on render is then a cost win on top — a lane with six dashes fires no `merge-tree` runs on open — but the correctness reason is the keying, and a later change that re-keys `JoinState` by `(project_dir, dash)` is what would unlock a per-row face.

**Tests:**
- [ ] `at0418-join-outcomes.test.ts` (`@covers` the landing component, the lane, the verb store): a dash with a round and a clean base → clean, Join enabled. Dirty an intersecting file in the base → `base-dirt` named with the path, Join disabled. A dash with no rounds → empty, release line, no Join. A written join journal → "Resume teardown" ([#landing-fixture]); remove the journal in `afterAll`.
- [ ] bun: the outcome derivation is a pure function with its own table test (clean / conflicted / blocked / empty / landing), so the component is not where that logic is proved.

**Checkpoint:**
- [ ] `cd tugdeck && bun test && bunx tsc --noEmit && bunx vite build`
- [ ] `just app-test at0418-join-outcomes.test.ts`
- [ ] `just app-test-changed`

---

#### Step 7: Server-formatted join and release summaries {#step-7}

**Depends on:** #step-2

**Commit:** `tugdash(join-lane): join and release receipts as server-formatted shell-ledger ink`

**References:** [P06] receipts, Spec S01, Spec S02, Spec S04

**Artifacts:**
- `format_join_summary` / `format_release_summary` in `tugcast/src/feeds/changeset.rs`
- Shell-ledger rows and `summary` on both `_ok` frames

**Tasks:**
- [ ] Write both formatters beside `format_commit_summary`, following its construction exactly (fixed header, U+00B7 / U+2212, verbatim message tail).
- [ ] `do_changeset_join`: on a landed join (`!previewed && commit_hash.is_some()`), format the summary and — when the payload carried a `session_id` and a shell ledger is present — write a `NewShellExchange { command: "/dash-join", output: summary, exit_code: Some(0), cwd: project_dir }`. A ledger error warns; it never fails the join.
- [ ] The join message the receipt shows must be the one `join_in` actually used. `JoinOutcome` does not carry it, so add `message: Option<String>` to `JoinOutcome`, set from `final_msg` on the integrate paths and from the journal on the teardown-resume path. Additive and skip-if-none.
- [ ] `do_changeset_release`: the same, with `command: "/dash-release"` and the S02 summary. The round subjects come from the dash detail read **before** `release_in` tears the branch down — capture them alongside `dash_owner_key`, for the same reason that capture exists.
- [ ] Add `"summary"` to both `_ok` bodies.
- [ ] Deck: `JoinState.summary` populates on the existing `done` transition. **Release has no terminal state to hang one on** — `ReleasePhase` is `"idle" | "pending" | "error"`, and `changeset_release_ok` calls `_setRelease(entryKey, RELEASE_IDLE)`, which deletes the map entry and hands back a shared frozen object. Add a `"done"` phase carrying `summary`, set it on the `_ok` arm, and leave `clearRelease` as the way back to idle. Without this, step 8's release arm has no edge to observe (pending → idle is indistinguishable from a manual clear) and nowhere to read the summary from.
- [ ] The release summary's round subjects need a `DashDetail`, and the only accessor is `dash_detail_entries_in(repo_root)` — there is no single-dash variant. Call it and filter by name **before** `release_in` runs, alongside the existing `dash_owner_key` capture; after the teardown the branch is gone and the subjects are unrecoverable.

**Tests:**
- [ ] Rust: `format_join_summary_names_the_dash_the_base_and_the_rounds` — assert the exact string, the way the commit formatter's tests do.
- [ ] Rust: `format_join_summary_keeps_the_full_multi_line_message`.
- [ ] Rust: `format_release_summary_lists_the_round_subjects` and `…_of_a_clean_dash_is_one_line`.
- [ ] Rust: `join_outcome_carries_the_message_it_committed`.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast -p tugdash-core`
- [ ] `cd tugrust && cargo build`

---

#### Step 8: The join receipt block {#step-8}

**Depends on:** #step-6, #step-7

**Commit:** `tugdash(join-lane): the /dash-join and /dash-release receipts render as transcript ink`

**References:** [P06] receipts, Spec S01, Spec S02

**Artifacts:**
- `session-join-receipt-block.tsx` + `.css` + its parse test
- `use-landing-receipts.ts`'s join and release arms
- `at0419-join-receipt.test.ts`

**Tasks:**
- [ ] Write `parseJoinReceipt` / `parseReleaseReceipt` against Specs S01/S02, each returning `null` on a non-matching first line so the generic `ShellExchangeBlock` renders raw output — the same fallback discipline the commit block uses.
- [ ] `SessionJoinReceiptBlock` composes `BlockChrome` with `CommitShaText` for the landing sha, the dash name and base as the identity line, `resultSummary` badges for the round count, and the message body via `CommitMessage`. The release variant has no sha: its identity is the dash name and the discard count, and its body is the round subjects.
- [ ] Register both matchers (`/dash-join`, `/dash-release`) with `registerCommandBlock` at import time, and add the side-effect import beside the commit block's in `session-card-transcript.tsx`.
- [ ] `use-landing-receipts.ts`: add a join arm (`phase` reaching `"done"` with a non-null `summary`) and a release arm. Update the module docblock, which currently states that join and release leave no receipts.

**Tests:**
- [ ] bun: `parseJoinReceipt` round-trips the exact string the Rust test asserts (copy it verbatim — that is what keeps the two ends pinned to one format).
- [ ] bun: a legacy or truncated output parses to `null`.
- [ ] `at0419-join-receipt.test.ts` (`@covers` the receipt block, the receipts hook, `agent_supervisor.rs`): create a dash with a round, `/dash-join` it from the card, land it, assert exactly one `/dash-join` receipt row with the landing sha and the dash name — then Maker ▸ Reload and assert the row is byte-identical. Release the dash in `afterAll` only if the join did not already tear it down.

**Checkpoint:**
- [ ] `cd tugdeck && bun test && bunx tsc --noEmit && bunx vite build`
- [ ] `just app-test at0419-join-receipt.test.ts`
- [ ] `just app-test-changed`

---

#### Step 9: The resolve lane {#step-9}

**Depends on:** #step-6

**Commit:** `tugdash(join-lane): conflicted joins route into the resolution ladder and land the candidate`

**References:** [P05] gate parity, (#outcome-derivation)

**Artifacts:**
- The conflicted face in `session-changes-dash-landing.tsx`
- The resolve overlay wired to `changeset-join-store`

**Tasks:**
- [ ] The conflicted outcome renders the conflicting paths and a "Resolve" affordance calling `ChangesetJoinStore.resolve(projectDir, dash)`.
- [ ] While `phase === "resolving"`, render the per-file progress as a mini-transcript from `ResolveState.progress` — a `/btw`-style progress layer, which is the shape the store was built for. Motion is CSS or `TugAnimator`, never `requestAnimationFrame` ([L13]), and no gesture's outcome hangs off an animation.
- [ ] On `resolved` with a `candidateCommit`, show the resolved files with the rung that resolved each, and enable the land as a candidate land: `land()` sends `changeset_join { preview: false, candidate }`. `evaluateJoinLandGate` already passes this case ([P05] implications).
- [ ] On `partial`, list what is still unresolved and offer no land — the ladder's honest dead end, which the CLI reports the same way.
- [ ] Clear the resolve state after a successful land, so a reused dash name never inherits a stale candidate.

**Tests:**
- [ ] bun: drive `_ingestJoinFrameForTest` through delta → ok(resolved, candidate) and assert the derived face at each phase.
- [ ] bun: an `ok` with a non-empty `unresolved` derives `partial` and no candidate.
- [ ] The AI rung itself is not tested here ([#test-non-goals]).

**Checkpoint:**
- [ ] `cd tugdeck && bun test && bunx tsc --noEmit && bunx vite build`
- [ ] `just app-test-changed`

---

#### Step 10: Release, with the discard preflight {#step-10}

**Depends on:** #step-6, #step-8

**Commit:** `tugdash(join-lane): release from the dash lane, behind the discard preflight`

**References:** [P06] receipts, Spec S02, (#outcome-derivation)

**Artifacts:**
- The lane row's Release affordance and its two-beat preflight

**Tasks:**
- [ ] Add the Release affordance to the dash row — **shade-only**, on the row, with no prompt-entry verb and no chord. The empty outcome fronts it; every other outcome carries it as a secondary act.
- [ ] Beat 1: a dash with work (`rounds > 0 || worktree_dirty`) expands the row into `discards <k> rounds · <n> dirty files` with `round_subjects` listed. A clean dash gets the light confirm. Beat 1 shows exactly what beat 2 does.
- [ ] Beat 2 sends `changeset_release { project_dir, dash, session_id }`. The row disappears on the next aggregate recompute — there is no client-side flip.
- [ ] Gate the affordance on the same turn/pending predicate the Join affordance uses, rendered disabled with a reason rather than merely bouncing.
- [ ] The dirty-file count comes from the entry's `files` array, which the lane already renders; do not re-derive it.

**Tests:**
- [ ] bun: the preflight's summary line is a pure function — table-test `(rounds, dirtyCount) → line` including the singular forms and the clean case.
- [ ] app-test: extend `at0418-join-outcomes.test.ts` with a release of a **purpose-created** dash (never the one another case is using), asserting the preflight lists the round subject and that the entry is gone after the confirm.

**Checkpoint:**
- [ ] `cd tugdeck && bun test && bunx tsc --noEmit && bunx vite build`
- [ ] `just app-test at0418-join-outcomes.test.ts`
- [ ] `just app-test-changed`

---

#### Step 11: Integration checkpoint {#step-11}

**Depends on:** #step-1, #step-2, #step-3, #step-4, #step-5, #step-6, #step-7, #step-8, #step-9, #step-10

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #documentation-plan, #outcome-derivation)

**Tasks:**
- [ ] Land a real dash end to end from the card: `/dash-bind <name>`, a round, `/dash-join`, edit the message, land. Verify the receipt, the History badge reading the `Tug-Dash` trailer, and that the dash's draft row **and** every session binding for it are gone afterwards (the server already does this; this is the first time it is checked from the surface that triggers it).
- [ ] Verify the composer returns to the prompt route with the pre-mode draft intact.
- [ ] Write the documentation-plan updates.
- [ ] Confirm `just app-test-covers-check` passes for the three new test files.

**Tests:**
- [ ] The three new app-test files plus `at0253`, `at0405`, `at0406`, `at0407`, `at0408` — the dash and commit surfaces this phase touches.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run`
- [ ] `cd tugdeck && bun test && bunx tsc --noEmit && bunx vite build`
- [ ] `just app-test-covers-check`
- [ ] `just app-test-changed`

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** The dash lane's landing surface — `/dash-join` opens the join-message editor over a previewed merge, the Changes shade fronts the outcome and the act that clears it, and every landing or discard leaves a durable receipt.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] `/dash-join` never submits a turn; the `tugplug:dash-join` skill is unchanged and still works (invoke it once by hand).
- [ ] Each of the five outcomes — clean, conflicted, blocked, empty, interrupted teardown — is reachable and named in the lane, with an affordance that does something.
- [ ] A join or release receipt survives Maker ▸ Reload byte-identically.
- [ ] `commit-mode-controller.test.ts` and `at0253-commit-dialog.test.ts` pass unmodified.
- [ ] `cargo nextest run`, `bun test`, `bunx tsc --noEmit`, `bunx vite build`, `just app-test-changed`, and `just app-test-covers-check` all green.

**Acceptance tests:**
- [ ] `at0417-join-mode.test.ts`
- [ ] `at0418-join-outcomes.test.ts`
- [ ] `at0419-join-receipt.test.ts`

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] [Q01] a strategy control, if a real landing ever wants `merge` or `rebase`
- [ ] [Q02] the lifecycle-idle predicate, retrofitting both landing gates
- [ ] A key equivalent for the Join route ([P07])
- [ ] `join_in`'s cwd guard, which is inert from tugcast ([R02])
- [ ] Phase 5's stale-review mark on the lane and the chrome chip

| Checkpoint | Verification |
|------------|--------------|
| Preview tells the truth | `tugutil dash join <name> --preview --json` reports blockers matching what a real land refuses on |
| The mode is real | `at0417-join-mode.test.ts` |
| The outcomes are reachable | `at0418-join-outcomes.test.ts` |
| The receipt is durable | `at0419-join-receipt.test.ts` |
| Commit is undisturbed | `at0253-commit-dialog.test.ts` + `commit-mode-controller.test.ts`, both unmodified |
