## The unified Changes pass {#unified-changes-pass}

**Purpose:** Make Changes one room and one landing. The composer's route group becomes an invariant `Prompt | Changes`, the Changes door enters commit mode or join mode according to what the card is mated to, the project's other dashes come out of a collapsed count into visible rows, releasing a dash reaches every dash nobody live is holding and confirms through a fact-sheet popover, and a dash landing can no longer emit a doubled `tugdash(a): tugdash(b):` subject.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-08-16 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-16, opus.** Reviewed `plan:ced563b51e1a1954`. Lint: 0 errors, 0 warnings. Oriented on: the whole document (first review), read against the real code in `session-changes-*`, `tug-prompt-entry.tsx`, `session-card.tsx`, `changeset-verb-store.ts`, `tugdash-core/src/ops.rs`, and the seven app-tests the pass touches.

Applied: **an enumeration hole** — Step 3 deleted the two-beat discard without naming `at0418-join-outcomes.test.ts`, the one test that drives both beats and asserts the preflight's text plus `data-confirming` directly; added [Table T03](#t03-confirm-breakage) and the rewrite tasks, and confirmed at0425's `RELEASE` selector survives. **A lost assertion behind that hole** — at0418 asserts the round subject inside the discard block, but `TugConfirmPopover.message` is a flat string that cannot carry a list; resolved as [P11](#p11-subjects-stay-on-the-row) after finding that `DashRow` already renders `round_subjects` in `session-changes-dash-subjects`, so the inline block was duplicating the row's own list — the popover names counts and consequences, the subjects stay on the row, and at0418's assertion moves rather than dies. **A shared state slot** — `release()` is keyed by `changesController.entryKey`, so `ReleaseState` is one slot per *card*, exactly like `JoinState`; widening Release to N rows would have let two rows render each other's phase. Added [P12](#p12-one-release-in-flight): one in-flight gate folded into the release bundle's `disabledReason`, mirroring `DashLaneBinding`'s existing refusal, rather than a store migration. **A fabricated dependency** — Step 5 (Rust + skills) declared `Depends on: #step-1` when it touches nothing Steps 1–4 touch; removed, with a comment recording that its position is a preference, not a constraint. **The mandatory laws cross-check** was missing; added [#tuglaws-cross-check](#tuglaws-cross-check) naming [L02], [L06], [L11], [L19], [L20], [L24], [L26], [L27], and [D123] with a verdict each — [L27] is load-bearing, since [P06](#p06-release-reach)'s reach rule is that law's predicate read from the client. One selector typo fixed (`session-changes-dash-dash-row`).

Verified rather than assumed: `bound_sessions` already means live-sessions-only and is pinned by `test_dash_status_bound_sessions_are_live_only`, so the reach rule introduces no second definition of "bound"; `release_in` carries no bound-session guard and the destructive base-overlap case is already refused server-side, which is what makes [P09](#p09-client-side-guard) safe; and the `select-composer-route:join` command entry justifies itself in its own docblock by the segment being deleted, so it goes with it.

Deferred: nothing. The one genuine fork — the doubled squash prefix, where the surviving behavior is deliberate and defended by `integrate_message_leaves_another_scope_alone` — was raised with the owner during authoring and settled as [P10](#p10-foreign-scope) (strip any foreign scope **and** stop drafts writing one), so it is a decision rather than an open question.

---

### Phase Overview {#phase-overview}

#### Context {#context}

The dash machinery is closed (`roadmap/closing-dash-backend-issues-brief.md`) and the identity round shipped (`4d888adbf`). What remains is the seam the owner named on 2026-08-16: **the user does not think of commits and joins as different subjects**, so there must be one surface for looking at what is in flight and one for landing it. Today the app splits them three ways. The Z4A route group grows a third `Join` segment only when a dash is in reach, so the composer's chrome changes shape under the user. `TOGGLE_CHANGES_VIEW` (⌃⌘C, and the Swift Session menu's Show/Hide Changes) **always enters commit mode** — on a dash-bound card the one obvious door to Changes opens the wrong landing. And the Changes shade's dash lane renders the project's other dashes behind a collapsed `Also on this project: N dashes` fold, so a dash somebody else is working is a number rather than a situation — exactly the failure the unattributed-files bucket avoids by showing its rows.

Structurally the code already agrees with the consolidation. `join-mode-controller.ts` opens by declaring join mode "commit mode's twin": same snapshot shape, same enter/leave/exit/land triggers, both driven through one `LandingMode` slot "so the composer drives both through one slot and neither has to know the other exists." The shade already hosts files and dashes in one view (`session-changes-view.tsx`). So this is a presentation-and-reach pass, not an architecture pass — no new stores, no new wire verbs, no new controllers.

Three smaller things ride along because they are the same seam. Release already exists end to end (`ChangesetVerbStore.release`, `changeset_release` / `_ok` / `_err`, `release_in` in `tugdash-core/src/ops.rs`) but is reachable only from the fronted row's landing face, behind a two-beat inline arm rather than the project's own confirm popover. The `bound_sessions` field the reach rule needs is already computed, already means *live sessions only*, and is already pinned by a test. And the doubled squash subject from `5ba5ce400` turns out to be half-fixed and half-deliberate — see [P10](#p10-foreign-scope) — which changes what the fix is.

#### Strategy {#strategy}

- **Delete rather than add.** The consolidation's largest single act is removing the conditional `Join` segment and the `joinAvailable` prop; the group's segment count becomes invariant, which also removes a class of layout shift under the user's pointer.
- **The room is invariant; the act tells the truth.** The segment says *Changes* always; the Z5 land button keeps `Commit` / `Join` from `LANDING_WORDS`, and the segment's tooltip follows the binding.
- **Reach is derived, never stored.** Release eligibility is a pure function of `entry.bound_sessions` and the card's own session id — no new state, no new subscription ([P06](#p06-release-reach)).
- **Enumerate before rewriting.** The identity round found a fifth consumer a four-item review had missed. Every step below carries the full enumeration of the selectors and tests it breaks, gathered by grep in this session and listed in [Table T01](#t01-breakage) and [Table T02](#t02-fold-breakage).
- **One confirm mechanism.** `TugConfirmPopover` exists and is the project's confirmation idiom; the two-beat inline arm is replaced by it rather than joined to it.
- **Rust last.** The scope fix is independent of the frontend and lands after it, so a red app-test can never be ambiguous about which half caused it.

#### Success Criteria (Measurable) {#success-criteria}

- The Z4A route group renders exactly two segments on every card, bound or unbound (`routeValues()` in at0417 returns `["prompt", "changes"]` with a dash bound — today it returns three).
- ⌃⌘C on a dash-bound card raises the shade **and** puts the composer in join mode: the Z5 land button reads `Join` and the route segment reads `changes` as active.
- ⌃⌘C on an unbound card is byte-identical to today: shade up, commit mode, land button reads `Commit`.
- With two dashes in the project and one bound, the shade renders **both** dash rows with no expand gesture (`document.querySelectorAll('[data-slot="session-changes-dash-row"]').length === 2` immediately after the shade opens), and no `session-changes-dash-lane-fold` element exists anywhere.
- A project with no dashes renders no lane element at all (unchanged from today's `if (dashes.length === 0) return null`).
- Release is offered on the fronted row and on a row whose `bound_sessions` is empty, and is **absent** (not merely disabled) on a row whose `bound_sessions` names a session that is not this card's.
- Clicking Release opens a `tug-confirm-popover` whose message names the rounds, the files, and — when the worktree is dirty — that uncommitted files are handed back to the base branch. No release frame is sent until Confirm.
- `integrate_message(repo, "mine", "tugdash/mine", Some("tugdash(theirs): borrowed work"))` returns a subject containing exactly one `tugdash(` occurrence.
- The three skills that author join drafts instruct a bare subject, and `just app-test-covers-check` passes with every touched test file declaring its `@covers`.

#### Scope {#scope}

1. The composer route group: delete the `Join` segment, the `joinAvailable` prop, the `select-composer-route:join` command entry, and the host's `"join"` route branch.
2. The Changes door: `TOGGLE_CHANGES_VIEW` and the `changes` route resolve to join mode when the card is mated to a dash, commit mode otherwise.
3. The dash lane: delete the other-dashes fold; render every dash row under a plain group label.
4. Release: replace the two-beat inline arm with `TugConfirmPopover`, widen the message to a fact sheet, and extend the gesture's reach to parked and orphaned dashes.
5. The squash subject: strip any leading `tugdash(<anything>): ` in `integrate_message`, and instruct the three draft-authoring skills to write a bare subject.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **The Lens Dashes section.** It is the account-global roster and parked dashes must stay findable there; the shade's rows are project-scope. Untouched.
- **Merging the shade's file rows and dash rows into one list component.** A dash is not a claim — `TugChangesList`'s rows carry claim / disclaim / hunk-election affordances that must never appear on a dash. The consolidation is about the *fold*, not about respelling the row ([P05](#p05-bare-names)).
- **Server-side release guarding.** `release_in` gets no `bound_sessions` check; the CLI stays a power tool ([P09](#p09-client-side-guard)).
- **Entry points into dash workflows** (starting a dash from a visible surface). That is the next round in `roadmap/dash-closure-brief.md`.
- **The Join sheet hunt itself.** This plan's dash is the hunt's *subject*; the hunt is a hand-driven exercise, not a step here.

#### Dependencies / Prerequisites {#dependencies}

- The identity round (`4d888adbf`) is landed — [P05](#p05-bare-names) leans on the settled rule that a surface whose rows *are* dashes names them bare.
- `bound_sessions` is emitted by the server for every dash entry (`tugdash-core/src/ops.rs::bound_sessions_for`, surfaced through `tugcast-core/src/types.rs` and typed at `changeset-types.ts::DashChangesetEntry`).
- `TugConfirmPopover` supports controlled mode with an external anchor (`tugdeck/src/components/tugways/tug-confirm-popover.tsx`).

#### Constraints {#constraints}

- **WARNINGS ARE ERRORS** in the Rust workspace (`tugrust/.cargo/config.toml` enforces `-D warnings`).
- A tugdeck change is not done until `bunx vite build` is clean — app-test instances serve the prod rollup bundle, not the Vite dev server.
- A Rust change needs `just build-app` before any app-test can observe it.
- **The app-test corpus does not run from a dash worktree.** The recipe refuses (`justfile`), because every `tugutil dash` verb resolves the *main* repo root, so a lane fixture created from a worktree is invisible to the app under test. Step 6's checkpoint therefore runs on `main` — see [R04](#r04-worktree-checkpoint).
- Never pipe an app-test invocation into `grep`/`head`/`tail`; the pipeline's exit status becomes the filter's. Use `TUG_APPTEST_JSON=<path>` for a machine-readable result.
- The tugplug skills run from the **app bundle**, not the repo — a repo edit to `tugplug/skills/**` has no effect on a live session until the app is rebuilt.

#### Assumptions {#assumptions}

- A card mated to a dash lands by joining. Its base-checkout files remain commit mode's business and stay reachable by **Leave** ([P03](#p03-leave-is-the-escape-hatch)).
- `bound_sessions` reflects only *this instance's* `sessions.db`. A session open in another instance (a debug build watching the same repo) is invisible to the reach rule — accepted, see [R02](#r02-instance-scope).
- No user-visible surface other than the Z4A group sends `SELECT_COMPOSER_ROUTE` with `"join"`; the grep in this session found the command-registry entry and no other sender.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

Standard: explicit `{#anchor}` headings, kebab-case, `[P##]` for plan-local decisions (never `[D##]`, which belongs to `tuglaws/design-decisions.md`), `S##` specs, `T##` tables, `R##` risks, `#step-N` for steps. `**References:**` cite artifacts and anchors, never line numbers.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

None open. The one genuine fork — what to do about the doubled squash prefix, given that the surviving half is deliberate and defended by a passing test — was raised with the owner during authoring and settled as [P10](#p10-foreign-scope).

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Deleting the Join segment breaks five app-tests that assert it | med | high | [Table T01](#t01-breakage) enumerates every one; Step 1 updates them in the same commit | any lane test red after Step 1 |
| `bound_sessions` is this-instance-only | low | med | Popover names the bound session; the CLI remains unguarded | a second instance becomes a normal workflow |
| Retiring a deliberate, tested behavior (foreign scope) | low | high | Owner-settled ([P10](#p10-foreign-scope)); the test is replaced, not deleted silently | someone wants a foreign scope preserved |
| Step 6's checkpoint cannot run from the dash worktree | med | high | Run the lane suite on `main` after the join, or with the dash's build; see [R04](#r04-worktree-checkpoint) | the recipe learns to run from a worktree |

**Risk R01: The Join-segment deletion has more consumers than it looks** {#r01-segment-consumers}

- **Risk:** Five app-test files assert `data-choice-value="join"` or a three-segment group. Missing one leaves a red test whose cause is a deleted element rather than a broken behavior.
- **Mitigation:**
  - [Table T01](#t01-breakage) lists all five with the exact assertion each makes, gathered by `grep -rn 'data-choice-value\|routeValues' tests/app-test`.
  - Step 1 updates them in its own commit, so the diff shows the rewrite beside the deletion.
- **Residual risk:** A test added between authoring and implementation. `just app-test-changed` derives the run from `@covers`, so a new one is selected automatically.

**Risk R02: The reach rule sees only this instance** {#r02-instance-scope}

- **Risk:** A dash bound to a session open in a *different* Tug instance reads as parked here, so this shade offers Release on a dash somebody is actively holding.
- **Mitigation:**
  - `bound_sessions_for` is documented as this-instance-only (its own `[P08]`/`[Q02]`), so the limitation is inherited, not introduced.
  - The popover states the stake (rounds, files, hand-back) so a mistaken release is an informed act, not a silent one.
  - `release_in` refuses when the base checkout has its own uncommitted changes to a path the dash also changed — the destructive overlap case is already server-guarded.
- **Residual risk:** Real. Accepted as a developer-only edge; not worth cross-instance machinery.

**Risk R03: A popover anchored to a hover-revealed control unmounts under itself** {#r03-popover-anchor}

- **Risk:** `TugConfirmPopover`'s own docblock warns that anchoring to a row's hover-revealed button makes the anchor unmount when the pointer leaves, after which the popover re-resolves and hops.
- **Mitigation:** Anchor to the **row** element (`.session-changes-dash-row`), which is always mounted, exactly as the component's docblock prescribes for in-list confirmation.
- **Residual risk:** None known; this is the documented shape.

**Risk R04: The integration checkpoint cannot run from the dash worktree** {#r04-worktree-checkpoint}

- **Risk:** The lane app-tests create real fixture dashes through `tugutil dash`, which resolves the main repo root — so the corpus refuses to run from a linked worktree, and `TUG_APPTEST_ALLOW_WORKTREE=1` does not fix the cause.
- **Mitigation:** Step 6 states the constraint and runs the suite from the **main checkout**. If this plan is walked on a dash, Step 6's checkpoint is run after the join, or the run is shaped on `main` from the start (which is how the identity round and the backend campaign were both run).
- **Residual risk:** The checkpoint is not simultaneous with the dash build. Steps 1–5 each carry their own narrower checkpoint, so a regression is still caught at its own step.

---

### Design Decisions {#design-decisions}

#### [P01] One room, one landing — the route group is always `Prompt | Changes` (DECIDED) {#p01-one-room}

**Decision:** Delete the conditional `Join` segment and the `joinAvailable` prop. *Changes* is the room; selecting it (or pressing ⌃⌘C, or Show/Hide Changes) enters whichever landing mode the card's binding implies — join mode when mated to a dash, commit mode otherwise.

**Rationale:**
- The owner's framing: a human does not think of commits and joins as different subjects, so the chrome must not present them as siblings.
- The two are never simultaneously meaningful. A card is mated to a dash or it is not; offering both was offering a choice that has one correct answer the code already knows.
- The group's population becoming state-independent removes a layout shift: today the toolbar grows a third segment when a bind lands, under the user's pointer.
- The Z5 land button already carries the honest verb, so nothing is lost by making the segment generic ([P02](#p02-land-button-verb)).

**Implications:**
- `tug-prompt-entry.tsx` drops `joinAvailable`; the group's `value` reduces to `landingActive ? "changes" : "prompt"`.
- `session-card.tsx`'s `handleSelectComposerRoute` takes no route argument — it resolves the mode from the binding.
- `TOGGLE_CHANGES_VIEW` stops hard-coding `commitModeController` ([Spec S03](#s03-changes-door)).
- The `select-composer-route:join` command-registry entry is deleted: its own docblock justifies its existence by "the door is the composer's Join segment", and that door is gone.
- Five app-tests need updating ([Table T01](#t01-breakage)).

#### [P02] The segment names the room; the button names the act (DECIDED) {#p02-land-button-verb}

**Decision:** `LANDING_WORDS.commit.land = "Commit"` and `LANDING_WORDS.join.land = "Join"` are unchanged. The segment's *tooltip* becomes binding-dependent — `LANDING_WORDS.join.routeTooltip` ("Write the join message") on a mated card, `LANDING_WORDS.commit.routeTooltip` ("Write a commit message") otherwise.

**Rationale:**
- A generic segment label plus a generic button would leave the user unable to tell what pressing it does. The invariant word belongs on the stable chrome; the variable word belongs on the act.
- `LANDING_WORDS` already holds both vocabularies keyed by `LandingKind` and the composer already picks by mode — no new mechanism.

**Implications:** The `Changes` item's `tooltip` reads from the active landing kind rather than a constant. `tooltipShortcut` stays `TOGGLE_CHANGES_VIEW` in both cases, because that chord now opens both.

#### [P03] Leave is the escape hatch for a bound card's base files (DECIDED) {#p03-leave-is-the-escape-hatch}

**Decision:** On a dash-mated card, the Changes door always opens join mode. Files in the base checkout attributed to that session remain visible in the shade but are not landable from that card until it leaves the dash.

**Rationale:**
- Binding is an overlay: the card stays on base and Changes/diffs follow the dash, so the dash is the unit of landing for a mated card.
- A join lands the dash's own commits; `commit_worktree_dirt` commits the dash worktree's dirt first, and base dirt overlapping the dash's files is already a *blocker* rather than something the join sweeps up. So "commit the base files" is genuinely a different act, not a variant of landing.
- **Leave** already exists on the fronted row and is ungated by the turn, so the escape hatch is one click and needs nothing new.

**Implications:** The shade keeps showing base-checkout files on a mated card (no filtering). Nothing warns about them; the rows are their own evidence.

#### [P04] The other-dashes fold is deleted (DECIDED) {#p04-no-fold}

**Decision:** Remove `restCollapsed` and the `session-changes-dash-lane-fold` cue from `SessionChangesDashLane`. Every dash renders as a row. The group label stays as a plain, non-interactive label. A project with no dashes still renders no lane.

**Rationale:**
- The owner's analogy: unattributed files work because the shade *shows* them and offers the repair beside them. A count behind a fold is not a situation, it is a rumor.
- Each row is already compact (one `TugListRow` at `density="compact"`), and rows are collapsed-by-default individually — so showing them costs one line each, not a wall of detail.
- It removes at0405's chronic `click on … dash-lane-fold did not land (attempt 1)` diagnostic, the last open item in the backend campaign's addendum — the click that misses is on the control being deleted.

**Implications:** `restCollapsed` state and its `BlockFoldCue` go; the `restLabel` text stays as a label. at0405 and at0427 both drive `GROUP_FOLD` and need updating ([Table T02](#t02-fold-breakage)).

#### [P05] The shade's dash rows keep their own grammar and name dashes bare (DECIDED) {#p05-bare-names}

**Decision:** The shade's dash rows keep their existing richer sentence — `TugBadge(display_name) · base · rounds · dirty · stage · step i/N · review · divergence marks` — and name the dash **bare**, not `#name`. `DashFactsRun` is not reused here.

**Rationale:**
- This corrects `roadmap/dash-closure-brief.md#unified-changes`, which proposed reusing `DashFactsRun`. That was an overreach by the brief's author: `DashFactsRun` carries name/stage/steps/review only, so adopting it would *lose* base, rounds, dirty, and the four divergence marks — a downgrade on the widest surface in the app.
- The settled identity doctrine (`dash-ui-report.md#one-format`) says the `#` sigil marks a dash named **inside a session**; a surface whose rows *are* dashes names them bare, which is why the Lens Dashes roster does. The shade's dash lane is such a surface.
- The Lens rail is narrow and the shade is wide; one grammar for both would be sized for the wrong one.

**Implications:** No change to the row's sentence in this pass. The consolidation is the fold ([P04](#p04-no-fold)) and the reach ([P06](#p06-release-reach)), not the spelling.

#### [P06] Release's reach is a pure function of `bound_sessions` (DECIDED) {#p06-release-reach}

**Decision:** Release is offered when the dash is **this card's own** (fronted/bound), or when `bound_sessions` is empty. It is **absent** — no button, not a disabled one — when `bound_sessions` is non-empty and does not contain this card's tug session id. Formally: [Spec S01](#s01-release-reach).

**Rationale:**
- The owner's rule: a shade may release its own dash and dashes no open session holds; a dash bound to another session is that session's to release.
- `bound_sessions` already means exactly *live sessions bound to this dash* — pinned by `test_dash_status_bound_sessions_are_live_only`, which asserts a closed session's row is never reported and that a dash whose cards have all closed reads as parked. The predicate the rule needs is already computed and already tested; nothing new is derived.
- **Absent rather than disabled** because the refusal is not about timing — nothing the user does *here* will ever make it available. A disabled control with a reason is the right idiom for "not yet"; for "not here" it is clutter that invites waiting.

**Implications:** `DashLaneBinding` grows a release arm reaching every row (as Adopt does), or a sibling bundle does — see [Spec S01](#s01-release-reach). The landing face's Release stays for the fronted row, now driven by the same predicate.

#### [P07] The turn gate is always locally readable (DECIDED) {#p07-turn-gate}

**Decision:** A release waits out a turn in the session bound to the dash. In practice the gate is always the *card's own* `turnInProgress`, because the only two cases that render a button are (a) this card's dash — its own turn — and (b) a dash with no live bound session at all, which by definition has no turn.

**Rationale:**
- The owner's rule ("in all cases, a dash can only be released when there is no turn operating in the session bound to it") turns out to need no cross-session turn lookup: [P06](#p06-release-reach)'s reach rule removes the only case where another session's turn could matter.
- This is worth stating explicitly so a future reader does not build a cross-session turn probe to satisfy a rule that is already satisfied.

**Implications:** The existing `releaseHint = turnInProgress ? "Wait for the turn to finish" : null` is the whole gate. On a parked-dash row it is vacuous but harmless, and keeping one expression avoids two gates that could disagree.

#### [P08] The discard confirms in a popover, and the message is a fact sheet (DECIDED) {#p08-confirm-popover}

**Decision:** Replace the two-beat inline `Release → Discard` arm with `TugConfirmPopover` in controlled mode, anchored to the dash **row**, `confirmRole="danger"`, confirm label `Discard`. The message states what will be destroyed and — when the worktree is dirty — that uncommitted files are handed back to the base branch. Formally: [Spec S02](#s02-confirm-message).

**Rationale:**
- `TugConfirmPopover` is the project's confirmation idiom and already solves the hard parts: chain-native dispatch, external dismissal, `danger` defaulting focus to Cancel so Return cannot destroy anything.
- The two-beat arm cannot be reused for the non-fronted rows without duplicating its state per row; one controlled popover serves N anchors, which is the documented "in-list confirmation" shape.
- "Are you sure" is not consent. The hand-back is the sharpest fact in the whole dash system — `dash release` writes the worktree's uncommitted files back into the base checkout, deliberately, so a teardown never destroys typed work — and a person who has not been told that has not agreed to it.
- Anchoring to the row rather than the button is the component's own documented rule ([R03](#r03-popover-anchor)).

**Implications:** `confirmingDiscard` state moves out of the landing face and up to the lane, keyed by `owner_id`, so one popover instance serves every row. The existing `discardPreflightLine` is widened, not replaced. `widthStabilize={{ alternateLabel: "Discard" }}` on the button is no longer needed — the label stops changing.

#### [P09] The reach guard is client-side only (DECIDED) {#p09-client-side-guard}

**Decision:** `release_in` gains no `bound_sessions` check. The rule lives in the shade.

**Rationale:**
- `tugutil dash release` is a power tool used by test fixtures, cleanup recipes (the `app-test` preamble sweeps stranded `tugdash/at04??-*` dashes), and the operator. Teaching it to refuse on a live binding would break the sweep and give the operator no way to clean up after a crashed instance.
- The destructive case that genuinely cannot be undone — the base checkout holding its own uncommitted edit to a path the dash also changed — is *already* refused server-side, before anything moves.
- A UI reach rule and a CLI safety rule are different things; conflating them would make the sweep depend on session-ledger state.

**Implications:** A test-fixture release path is unaffected by this plan. The guard's correctness is an app-test concern, not a Rust one.

#### [P10] No landing emits a doubled scope, and drafts stop inviting one (DECIDED) {#p10-foreign-scope}

**Decision:** Widen `integrate_message`'s idempotent strip to remove **any** leading `tugdash(<anything>): `, not only this dash's own name. Separately, instruct the three skills that author join drafts to write a subject with **no** scope prefix, because the landing adds one.

**Rationale:**
- Owner-settled during authoring, after the investigation contradicted the brief. The state on disk: `integrate_message_does_not_double_this_dashs_own_prefix` already landed (that is the half-fix), while `integrate_message_leaves_another_scope_alone` **asserts** `tugdash(mine): tugdash(theirs): borrowed work` on the rationale that a foreign scope is "content, not an accident of composition".
- `5ba5ce400`'s `tugdash(close-backend): tugdash(backend): …` is exactly the foreign-scope case — the draft's scope did not match the dash's name — so it was preserved *by design*, and the brief's claim that this is an unfixed bug was wrong.
- But `tugdash(a): tugdash(b): …` is never a good commit subject, whoever authored it. The rationale defending it describes an intent no observed message has ever had.
- Fixing only the landing leaves the skills writing scopes that are then silently stripped; fixing only the skills leaves a hand-typed join message able to double. Both halves, so neither path can produce it.

**Implications:** `integrate_message_leaves_another_scope_alone` is **replaced** (not deleted) by a test asserting the foreign scope is now stripped — the behavior change is recorded where the old contract lived. `tugplug/skills/dash-implement/SKILL.md`, `dash-on/SKILL.md`, and `dash-join/SKILL.md` each gain the no-scope instruction. Skills run from the app bundle, so a repo edit needs a rebuild to take effect in a live session.

#### [P11] The round subjects stay on the row, not in the popover (DECIDED) {#p11-subjects-stay-on-the-row}

**Decision:** The confirm message names counts and consequences; it does not list the round subjects. The subjects stay where they already are — `session-changes-dash-subjects`, rendered in the row's expanded detail.

**Rationale:**
- `TugConfirmPopover`'s `message` is a single string in one `TugLabel`. A subject list cannot be marked up inside it, and a newline-joined blob would size the popover off the longest commit subject in the dash.
- The information is not lost: `DashRow` already renders `entry.round_subjects` when expanded, and the fronted row is expanded by default. The inline discard block was **duplicating** the row's own list a few pixels below it.
- Deleting the duplicate is the simplification the pass is for; the fact sheet keeps the facts a reader cannot get by looking (`what is handed back`, `what happens to the plan`).

**Implications:** at0418's `RELEASE_SUBJECT` assertion moves from the discard block to the row's subject list ([Table T03](#t03-confirm-breakage)). The `session-changes-dash-landing-discard-subjects` element and its CSS are deleted with the block.

#### [P12] One release in flight per card (DECIDED) {#p12-one-release-in-flight}

**Decision:** While `releaseState.phase === "pending"`, every row's Release control is disabled with the reason `A discard is in flight`. The verb store's one-slot-per-card `ReleaseState` is kept as is.

**Rationale:**
- `ChangesetVerbStore.release(entryKey, …)` is called with `changesController.entryKey` — the **card's** changes entry — so `_releases` holds one `ReleaseState` per card, exactly as `JoinState` does. Widening Release to N rows ([P06](#p06-release-reach)) without saying anything would let two rows' releases share one state slot and render each other's phase.
- The round trip's *routing* is safe regardless — `_releaseInflight` is keyed by `verbKey(projectDir, dash)`, so each `_ok` / `_err` finds its own dash — so this is a display and arming concern, not a correctness-of-delivery one.
- Serializing at the control is one boolean and needs no store change; keying `ReleaseState` per dash would be a store migration for a case the popover already makes rare (only one row can be armed at a time).

**Implications:** The lane's release bundle carries a `disabledReason` that folds the turn gate ([P07](#p07-turn-gate)) and the in-flight gate together. This mirrors `DashLaneBinding.disabledReason`, which already refuses on `join.phase === "pending"`.

---

### Specification {#specification}

**Spec S01: The release reach predicate** {#s01-release-reach}

A pure function over data the shade already has. No store, no subscription, no new wire field.

```
canReleaseFromHere(entry, ownTugSessionId, boundDashId):
  bound = entry.bound_sessions ?? []
  if entry.owner_id == boundDashId        -> true    # this card's own dash
  if bound.length == 0                    -> true    # parked or orphaned
  if bound.includes(ownTugSessionId)      -> true    # mated, fronting aside
  else                                    -> false   # another live session holds it
```

`false` means **render no Release control at all** on that row ([P06](#p06-release-reach)). `true` renders it, disabled with the reason `Wait for the turn to finish` while `turnInProgress` ([P07](#p07-turn-gate)).

The `bound.includes(ownTugSessionId)` arm is not redundant with the first: a card can be mated to dash A (so A is fronted) while dash B also lists this session — rare, but the predicate should answer by fact rather than by fronting.

**Spec S02: The confirm popover's message** {#s02-confirm-message}

Composed from the entry alone. Sentences, joined by a space; each clause omitted when it has nothing to say.

| Condition | Clause |
|---|---|
| always | `Release <name>: deletes the branch and worktree.` |
| `rounds > 0` or `files.length > 0` | `Discards <N rounds> · <M files>.` (the existing `discardPreflightLine` shape) |
| `worktree_dirty` | `Uncommitted files in the worktree are handed back to <base>.` |
| `bound_sessions` non-empty and excludes this session | *(unreachable — no button renders)* |
| `bound_sessions` empty and the dash records a plan | `The plan is restored to <base>.` |

The hand-back clause is the one that must never be dropped: it is the difference between consent and a click. The plan clause reflects `restore_plan_to_base`, which runs before teardown precisely so discarding a dash cannot destroy the authored plan document.

**The round subjects are not in the message** — see [P11](#p11-subjects-stay-on-the-row). `TugConfirmPopover` takes a flat `message: string` rendered in one `TugLabel`, so a list cannot live there; and it does not need to, because the row already renders `round_subjects` in `session-changes-dash-subjects` when expanded.

**Table T03: What the confirm-popover change breaks** {#t03-confirm-breakage}

| File | Assertion today | After |
|---|---|---|
| `tests/app-test/at0418-join-outcomes.test.ts` | Beat 1 click reveals `[data-slot="session-changes-dash-landing-discard"]`; its text contains `Discards 1 round · 1 file` **and** the round subject; beat 2 clicks `[data-slot="session-changes-dash-release"][data-confirming="true"]` | one click opens `[data-slot="tug-confirm-popover"]` whose message contains the counts and the hand-back; the round subject is asserted against the row's own `session-changes-dash-subjects`; the confirm click lands on the popover's Discard button |
| `tests/app-test/at0425-dash-conflicted-landing.test.ts` | `RELEASE = [data-slot="session-changes-dash-release"]` — presence only | unchanged; the button survives, only its second beat moves |

**Spec S03: The Changes door resolves by binding** {#s03-changes-door}

One helper in `session-card.tsx`, used by both doors:

```
enterChanges():
  binding = cardSessionBindingStore.getBinding(cardId)
  dashId  = binding?.dash?.id
  entry   = dashId ? changesController.getSnapshot().dashes.find(d => d.owner_id === dashId) : undefined
  if entry: joinModeController.enter(joinTargetFromEntry(entry))
  else:     commitModeController.enter()
```

- `TOGGLE_CHANGES_VIEW` calls `enterChanges()` where it currently calls `commitModeController.enter()`. Its *exit* branch must now check both controllers: today it tests `commitModeController.getSnapshot().active` and falls through to `shadeViewController.hide()`; it must exit whichever landing is active.
- The Z4A `changes` segment calls the same `enterChanges()`.
- A bound card whose dash entry has not yet composed into the snapshot falls back to commit mode rather than dead-ending — the same tolerance today's `handleSelectComposerRoute` shows by returning early.

**Table T01: What the Join-segment deletion breaks** {#t01-breakage}

| File | Assertion today | After |
|---|---|---|
| `tests/app-test/at0417-join-mode.test.ts` | `routeValues(app)` equals `["prompt","changes","join"]`; `waitForRoute(app,"join",…)` at five call sites | two segments; the route reads `changes` while join mode is up |
| `tests/app-test/at0418-join-outcomes.test.ts` | `[data-choice-value="join"][data-state="active"]` | `[data-choice-value="changes"][data-state="active"]` |
| `tests/app-test/at0425-dash-conflicted-landing.test.ts` | `el.getAttribute("data-choice-value") === "join"` | `=== "changes"` |
| `tests/app-test/at0426-dash-resolution-review.test.ts` | same as at0425 | same change |
| `tests/app-test/at0340-composer-routes.test.ts` | docblock claims a two-segment group; drives ⌃⌘C into Changes on an unbound card | unchanged behavior, but gains the bound-card case ([#step-1](#step-1)) |

**Table T02: What the fold deletion breaks** {#t02-fold-breakage}

| File | Uses | After |
|---|---|---|
| `tests/app-test/at0405-changes-dash-lane.test.ts` | `GROUP_FOLD = [data-slot="session-changes-dash-lane-fold"]`, clicked to reveal the non-fronted row (the source of the chronic "did not land" retry noise) | the row is present without any click; the fold selector and its retry go |
| `tests/app-test/at0427-dash-divergence-marks.test.ts` | same `GROUP_FOLD`, clicked before asserting marks on a non-fronted dash | same |

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| Which landing mode a card's Changes door opens | derived, not state | Read `cardSessionBindingStore` + the changes snapshot at gesture time ([Spec S03](#s03-changes-door)) | [L02] |
| Route group's selected value | derived | `landingActive ? "changes" : "prompt"` from the landing controller's snapshot | [L02] |
| Release eligibility per row | derived | Pure function of `entry.bound_sessions` + own session id ([Spec S01](#s01-release-reach)) | [L02] |
| Which row's discard popover is open | local-data, view-scope | `useState<string | null>(pendingReleaseOwnerId)` in the lane; a half-armed confirm is not something to remember | [L24] |
| The popover's anchor element | local-data | `useState<HTMLElement | null>` set from the row element on open | [L24] |
| Release in-flight / error | external | `useChangesetRelease(entryKey)` via `useSyncExternalStore` | [L02] |
| Disabled appearance of a gated Release | appearance | CSS on the button's `disabled` attribute; the reason renders as face text, never a `title` | [L06] |
| Popover confirm/cancel dispatch | structure | Responder chain (`confirmDialog` / `cancelDialog`), owned by `TugConfirmPopover` | [L11] |

#### Tuglaws cross-check {#tuglaws-cross-check}

| Law | How this plan stands against it |
|---|---|
| **[L02]** external state enters React through `useSyncExternalStore` | **Honored.** No new store and no new subscription. Release eligibility is derived at render from `entry.bound_sessions` (already in the snapshot the view subscribes to) and `cardSessionBindingStore` (already subscribed). Release phase rides the existing `useChangesetRelease`. The one risk was reading the binding imperatively inside `enterChanges()` — that is a *gesture-time read*, not a render-time one, and matches how `handleSelectComposerRoute` already reads it. |
| **[L06]** appearance goes through CSS and DOM, never React state | **Honored.** The disabled look rides the `disabled` attribute; refusal reasons render as face text (never a `title`, which is unreachable on a disabled control). Nothing in this plan puts a tone or a measurement in React state. |
| **[L11]** controls emit actions; responders handle them | **Honored.** The confirm/cancel path is `TugConfirmPopover`'s own chain dispatch (`confirmDialog` / `cancelDialog`), targeted at its own responder. The route group keeps dispatching `selectValue`; only the values change. |
| **[L19]** component authoring — compose existing components | **Honored, and it is the point of [P08](#p08-confirm-popover).** The two-beat inline arm was a hand-rolled confirmation beside a `TugConfirmPopover` that already exists; this replaces it. |
| **[L20]** token sovereignty | **Honored.** Deleting CSS only. The popover's chrome stays `tug-popover.css`'s; the lane never references popover tokens. |
| **[L24]** view-scope local data in `useState` | **Honored.** `pendingRelease` (which row is armed) and its anchor are view-scope — a half-armed confirm is not something to remember, the same reasoning the deleted `confirmingDiscard` carried. |
| **[L26]** collapse by unmount | **Honored.** [P04](#p04-no-fold) removes a fold; per-row detail still collapses by unmount inside `DashRow`'s `expanded` branch, untouched. |
| **[L27]** bound-ness is defined over live sessions | **Honored, and load-bearing.** [P06](#p06-release-reach)'s reach rule is exactly [L27]'s predicate read from the client; `bound_sessions_for` is its server face and `test_dash_status_bound_sessions_are_live_only` is its pin. The plan adds no second definition of "bound". |
| **[D123]** one name, one producer | **Honored via [P05](#p05-bare-names).** The shade names dashes bare because its rows *are* dashes; the `#` sigil marks a dash named inside a session. No new spelling is introduced. |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

None. Every change edits an existing module.

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `joinAvailable` | prop | `tugdeck/src/components/tugways/tug-prompt-entry.tsx` | **delete**, with its docblock |
| `onSelectRoute` | prop | same | narrow to `onEnterChanges?: () => void` |
| `entryRouteChoice` | local | same | two static items; `value` drops the `kind` check; `Changes` tooltip reads the active landing kind ([P02](#p02-land-button-verb)) |
| `SELECT_VALUE` handler | responder action | same | drop the `event.value === "join"` branch |
| `handleSelectComposerRoute` | fn | `tugdeck/src/components/tugways/cards/session-card.tsx` | becomes `enterChanges()`, no argument ([Spec S03](#s03-changes-door)) |
| `TOGGLE_CHANGES_VIEW` handler | responder action | same | enter via `enterChanges()`; exit whichever landing is active |
| `SELECT_COMPOSER_ROUTE` handler | responder action | same | drop the `"join"` branch |
| `select-composer-route:join` | command entry | `tugdeck/src/components/tugways/command-registry.ts` | **delete** — its stated door was the segment |
| `restCollapsed`, `session-changes-dash-lane-fold` | state + element | `tugdeck/.../session-changes/session-changes-dash-lane.tsx` | **delete** ([P04](#p04-no-fold)) |
| `DashLaneRelease` | interface | same | new: `{ canRelease(entry): boolean; release(entry): void; disabledReason: string | null }` |
| `pendingRelease` | state | same | `owner_id | null` + anchor element; one `TugConfirmPopover` for the lane ([P08](#p08-confirm-popover)) |
| `releaseConfirmMessage` | fn | same (exported for unit test) | [Spec S02](#s02-confirm-message) |
| `canReleaseFromHere` | fn | same (exported for unit test) | [Spec S01](#s01-release-reach) |
| `confirmingDiscard` | state | `tugdeck/.../session-changes/session-changes-dash-landing.tsx` | **delete** — the popover owns the confirm now |
| `discardPreflightLine` | fn | same | widened into `releaseConfirmMessage`'s clause set, or kept and called by it |
| `integrate_message` | fn | `tugrust/crates/tugdash-core/src/ops.rs` | strip any leading `tugdash(<anything>): ` ([P10](#p10-foreign-scope)) |
| `integrate_message_leaves_another_scope_alone` | test | same | **replace** with `integrate_message_strips_a_foreign_scope` |
| join-draft instructions | docs | `tugplug/skills/{dash-implement,dash-on,dash-join}/SKILL.md` | subject carries no `tugdash(<name>):` scope |

---

### Documentation Plan {#documentation-plan}

- [ ] `tugplug/skills/dash-implement/SKILL.md`, `dash-on/SKILL.md`, `dash-join/SKILL.md` — the join draft's subject carries no scope prefix; the landing adds it.
- [ ] `roadmap/dash-closure-brief.md#unified-changes` — correct the `DashFactsRun` claim per [P05](#p05-bare-names), and record that the doubled-prefix item was half-landed already per [P10](#p10-foreign-scope).
- [ ] Module docblocks for `session-changes-dash-lane.tsx` (the fold is gone; release reaches parked dashes) and `tug-prompt-entry.tsx` (the route group is invariant).

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **App-test** | Drive the real app against a real dash created by the real CLI | Every behavior in this plan that a user can see |
| **Unit (bun)** | Pure functions with no DOM | `canReleaseFromHere`, `releaseConfirmMessage` |
| **Rust (nextest)** | `integrate_message` over a seeded dash repo | The scope strip |

The lane's app-tests build **real dashes in the live repository**. Leave no `tugdash/*` branch, worktree, `rr-cache` entry, or working-tree modification behind; check `git branch --list 'tugdash/*'` after a red run, because a failed `beforeAll` skips its own cleanup.

#### What stays out of tests {#test-non-goals}

- **No jsdom / RTL render tests** of the lane or the route group — banned project-wide; the app-tests drive the real DOM in the real app.
- **No mock-store assertion tests** for the release round trip. `changeset_release` is already exercised end to end; asserting that a mocked store's `release()` was called pins the mock, not the app.
- **No cross-instance reach test.** [R02](#r02-instance-scope) is an accepted limitation, not a behavior — a test would pin the limitation in place.
- **No test that Release is disabled mid-turn on a *parked* row.** [P07](#p07-turn-gate) makes that gate vacuous by construction; testing it would assert a coincidence.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | One room, one landing — the route group goes invariant | done | `3d2b9a0c0` |
| #step-2 | The project's other dashes come out of the fold | done | `36167235f` |
| #step-3 | The discard confirms in a popover | done | `851ed96e3` |
| #step-4 | Release reaches every dash nobody is holding | done | `bf30362a8` |
| #step-5 | No landing emits a doubled scope | done | `531572bfc` |
| #step-6 | Integration checkpoint — the whole lane in one invocation | done | `2ddcace0a` |

#### Step 1: One room, one landing — the route group goes invariant {#step-1}

**Commit:** `tugways(composer-routes): one Changes room whose door opens the landing the card is mated to`

**References:** [P01](#p01-one-room) one room, [P02](#p02-land-button-verb) segment vs button, [P03](#p03-leave-is-the-escape-hatch) the escape hatch, [Spec S03](#s03-changes-door), [Table T01](#t01-breakage), [R01](#r01-segment-consumers), (#context, #state-zone-mapping)

**Artifacts:**
- `tug-prompt-entry.tsx` with a two-item route group and no `joinAvailable`
- `session-card.tsx` with `enterChanges()` serving both doors
- `command-registry.ts` without the `select-composer-route:join` entry
- Five updated app-tests

**Tasks:**
- [ ] Delete the `joinAvailable` prop and its docblock from `tug-prompt-entry.tsx`; delete the conditional `join` item from `entryRouteChoice`'s `items`.
- [ ] Reduce the group's `value` to `landingActive ? "changes" : "prompt"`.
- [ ] Make the `Changes` item's `tooltip` read from the active landing kind ([P02](#p02-land-button-verb)); leave `tooltipShortcut` as `TOGGLE_CHANGES_VIEW`.
- [ ] Narrow `onSelectRoute` to `onEnterChanges?: () => void`; drop the `"join"` branch from the entry's `SELECT_VALUE` handler.
- [ ] In `session-card.tsx`, rewrite `handleSelectComposerRoute` as `enterChanges()` per [Spec S03](#s03-changes-door); point `TOGGLE_CHANGES_VIEW` at it, and fix its exit branch to exit whichever landing is active (today it tests only `commitModeController`).
- [ ] Drop the `"join"` branch from the `SELECT_COMPOSER_ROUTE` handler and delete the `select-composer-route:join` command entry.
- [ ] Update `tugdeck/src/components/tugways/__tests__/command-routing-drift.test.ts` and `keybinding-map.test.ts` if either enumerates the deleted entry.
- [ ] Update the five app-tests in [Table T01](#t01-breakage); add `@covers` for any newly-exercised source file and keep every existing one resolving.

**Tests:**
- [ ] at0340 gains a case: on a card bound to a real dash, ⌃⌘C raises the shade **and** the Z5 land button reads `Join`, while the route segment reading `changes` is active.
- [ ] at0340 keeps the unbound case verbatim — ⌃⌘C gives commit mode and a `Commit` button — so the consolidation is proved not to have changed the common path.
- [ ] at0417's `routeValues(app)` asserts exactly `["prompt","changes"]` with a dash bound.
- [ ] at0417's five `waitForRoute(app,"join")` sites assert `changes` instead; the join mode itself is still proved by the Z5 button's word.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit`
- [ ] `cd tugdeck && bun test`
- [ ] `cd tugdeck && bunx vite build`
- [ ] `just app-test tests/app-test/at0340-composer-routes.test.ts tests/app-test/at0417-join-mode.test.ts`

---

#### Step 2: The project's other dashes come out of the fold {#step-2}

**Depends on:** #step-1

**Commit:** `tugways(dash-lane): every dash in the project is a visible row, not a count behind a fold`

**References:** [P04](#p04-no-fold) no fold, [P05](#p05-bare-names) bare names, [Table T02](#t02-fold-breakage), (#context)

**Artifacts:**
- `session-changes-dash-lane.tsx` without `restCollapsed` or its fold cue
- `session-changes-dash-lane.css` without the fold's layout rules
- at0405 and at0427 updated

**Tasks:**
- [ ] Delete `restCollapsed` state and the `BlockFoldCue` carrying `data-slot="session-changes-dash-lane-fold"`; render `rest` unconditionally.
- [ ] Keep the group label (`Also on this project: N dashes` / `Dashes: N`) as a plain label; drop the flex/interaction CSS the cue needed.
- [ ] Leave the per-row expansion default untouched — the fronted row opens, the rest stay collapsed — so the change is *visibility of rows*, not of detail.
- [ ] Confirm the empty case still returns `null` before any label renders.
- [ ] Update the module docblock: the lane no longer folds, and why (the unattributed-files precedent).

**Tests:**
- [ ] at0405: with two dashes and one bound, both `session-changes-dash-row` elements are present with **no** click; the `GROUP_FOLD` selector and its retry wrapper are deleted.
- [ ] at0405 asserts no element matches `[data-slot="session-changes-dash-lane-fold"]` anywhere — the deletion is pinned, not just unused.
- [ ] at0427 reaches the non-fronted dash's divergence marks without a fold click.
- [ ] A project with zero dashes renders no `session-changes-dash-lane` element (extend an existing shade test rather than adding a file, if one already opens a dash-free shade).

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bunx vite build`
- [ ] `just app-test tests/app-test/at0405-changes-dash-lane.test.ts tests/app-test/at0427-dash-divergence-marks.test.ts`
- [ ] `git branch --list 'tugdash/*'` prints nothing after the run

---

#### Step 3: The discard confirms in a popover {#step-3}

**Depends on:** #step-2

**Commit:** `tugways(dash-release): the discard confirms in a popover that names what it destroys`

**References:** [P08](#p08-confirm-popover) confirm popover, [P11](#p11-subjects-stay-on-the-row) subjects stay on the row, [Spec S02](#s02-confirm-message), [Table T03](#t03-confirm-breakage), [R03](#r03-popover-anchor), (#state-zone-mapping)

**Artifacts:**
- `releaseConfirmMessage` in `session-changes-dash-lane.tsx`, unit-tested
- One `TugConfirmPopover` in the lane, controlled, row-anchored
- `session-changes-dash-landing.tsx` without `confirmingDiscard`

**Tasks:**
- [ ] Write `releaseConfirmMessage(entry)` per [Spec S02](#s02-confirm-message), reusing `discardPreflightLine`'s counting for the discards clause.
- [ ] Lift the confirm to the lane: `pendingRelease: { ownerId, anchor } | null`, one `TugConfirmPopover` in controlled mode with `confirmRole="danger"`, `confirmLabel="Discard"`, anchored to the **row element** ([R03](#r03-popover-anchor)).
- [ ] The landing face's Release button becomes a one-beat control that opens the popover; delete `confirmingDiscard`, the `data-confirming` attribute, the `widthStabilize` alternate label, and the inline `session-changes-dash-landing-discard` block **including its duplicate subject list** ([P11](#p11-subjects-stay-on-the-row)) plus their CSS.
- [ ] Keep `releaseHint` as the disabled reason and keep it in the face's `refusals` list — a disabled button's `title` is unreachable.
- [ ] Confirm dispatches `actions.release(entry)`; cancel clears `pendingRelease` and sends nothing.
- [ ] Rewrite at0418's release section per [Table T03](#t03-confirm-breakage) — it is the only test that drives both beats, and it asserts the preflight's text and `data-confirming` directly. Verify at0425's `RELEASE` selector still resolves (the button survives; only its second beat moves).

**Tests:**
- [ ] Unit (`bun test`): `releaseConfirmMessage` includes the hand-back sentence exactly when `worktree_dirty`, names the base branch, and omits the discards clause for a dash with no rounds and no files.
- [ ] at0418: one click opens `[data-slot="tug-confirm-popover"]`; its message contains `Discards 1 round · 1 file` and the hand-back sentence; the popover's Discard button lands the release and the existing receipt assertions stay verbatim.
- [ ] at0418: the round subject is still on screen — asserted against the row's own `session-changes-dash-subjects`, proving [P11](#p11-subjects-stay-on-the-row) dropped a duplicate rather than the information.
- [ ] at0418 or at0405: Cancel closes the popover and the dash still exists (no `changeset_release` sent) — the half that proves the first beat is not itself destructive.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build`
- [ ] `just app-test tests/app-test/at0418-join-outcomes.test.ts tests/app-test/at0405-changes-dash-lane.test.ts`
- [ ] `git status --short` shows no fixture bytes handed back into the checkout

---

#### Step 4: Release reaches every dash nobody is holding {#step-4}

**Depends on:** #step-3

**Commit:** `tugways(dash-release): a shade may discard its own dash and any dash no live session holds`

**References:** [P06](#p06-release-reach) reach, [P07](#p07-turn-gate) turn gate, [P09](#p09-client-side-guard) client-side, [P12](#p12-one-release-in-flight) one in flight, [Spec S01](#s01-release-reach), [R02](#r02-instance-scope)

**Artifacts:**
- `canReleaseFromHere` in `session-changes-dash-lane.tsx`, unit-tested
- A `DashLaneRelease` bundle reaching every row, as `DashLaneBinding` already does
- `session-changes-view.tsx` supplying it

**Tasks:**
- [ ] Write `canReleaseFromHere(entry, ownTugSessionId, boundDashId)` per [Spec S01](#s01-release-reach) and export it for unit test.
- [ ] Add the `DashLaneRelease` bundle and thread it from `session-changes-view.tsx`, which already holds `tugSessionId`, `boundDashId`, and `turnInProgress`; send through `getChangesetVerbStore()?.release(...)` with the card's session id so the receipt is attributed.
- [ ] Render the Release control on every row for which the predicate is true — in the row's trailing cluster beside Adopt/Leave for non-fronted rows, and in the landing face for the fronted one.
- [ ] Render **nothing** when the predicate is false; do not render a disabled button ([P06](#p06-release-reach)).
- [ ] Fold the two gates into one `disabledReason` on the release bundle ([P12](#p12-one-release-in-flight)): `A discard is in flight` while `releaseState.phase === "pending"`, else `Wait for the turn to finish` while `turnInProgress`, else null. `ReleaseState` is one slot per card because `release()` is keyed by `changesController.entryKey` — so arming a second row mid-flight must be refused rather than allowed to share the slot.
- [ ] Confirm no change to `release_in` ([P09](#p09-client-side-guard)); the Rust side is untouched by this step.

**Tests:**
- [ ] Unit (`bun test`): the predicate's four arms — own dash, empty `bound_sessions`, `bound_sessions` containing this session, `bound_sessions` naming another — including `bound_sessions` absent entirely (an older sender), which must read as parked.
- [ ] App-test on a real fixture dash bound to nobody: the non-fronted row offers Release, and confirming discards it (the row leaves the lane).
- [ ] App-test: with the fixture dash's `bound_sessions` naming another session (drive it by binding a second card, or by a synthesized aggregate frame if a second card is impractical in the harness), the row renders **no** `[data-slot="session-changes-dash-release"]`.
- [ ] Every touched test file carries a resolving `@covers` for `session-changes-dash-lane.tsx`.

**Checkpoint:**
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build`
- [ ] `just app-test-changed`
- [ ] `just app-test-covers-check`

---

#### Step 5: No landing emits a doubled scope {#step-5}

<!-- Deliberately no `Depends on:` — the Rust strip and the skill docs touch
     nothing Steps 1–4 touch. It is sequenced fifth by the strategy's
     "Rust last" preference, not by a real dependency, so it can land
     independently if the frontend work stalls. -->

**Commit:** `tugdash(join-message): strip any leading dash scope, and drafts stop writing one`

**References:** [P10](#p10-foreign-scope) foreign scope, (#context, #documentation-plan)

**Artifacts:**
- `integrate_message` stripping any `tugdash(<anything>): ` prefix
- `integrate_message_strips_a_foreign_scope` replacing the old contract test
- Three skill files instructing a bare subject

**Tasks:**
- [ ] In `tugrust/crates/tugdash-core/src/ops.rs`, widen `integrate_message`'s strip from `format!("tugdash({}): ", name)` to any leading `tugdash(…): ` — match the literal `tugdash(`, the first `)` after it, and the following `: `, so a body containing a parenthesis later is untouched.
- [ ] Update the function's docblock: it currently states that a foreign scope "passes through untouched", which stops being true.
- [ ] Replace `integrate_message_leaves_another_scope_alone` with `integrate_message_strips_a_foreign_scope`, asserting exactly one `tugdash(` in the result for the `tugdash(theirs): borrowed work` input, and keep the existing idempotence and unprefixed-body tests green.
- [ ] Add the no-scope instruction to the join-draft section of `tugplug/skills/dash-implement/SKILL.md`, `dash-on/SKILL.md`, and `dash-join/SKILL.md` — the subject is bare, because the landing wraps it as `tugdash(<name>): …`.
- [ ] Note in the plan's handoff that skills run from the app bundle, so the instruction only reaches a live session after a rebuild.

**Tests:**
- [ ] Rust: `integrate_message_strips_a_foreign_scope` — one `tugdash(` occurrence for a foreign-scoped body.
- [ ] Rust: the existing `integrate_message_does_not_double_this_dashs_own_prefix` and `integrate_message_wraps_an_unprefixed_body_and_the_bare_fallback` stay green unchanged — the widening must not disturb either.
- [ ] Rust: a body whose text merely *contains* `tugdash(` later in the line is not stripped.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugdash-core`
- [ ] `cd tugrust && cargo build` (warnings are errors)
- [ ] `just build-app`

---

#### Step 6: Integration checkpoint — the whole lane in one invocation {#step-6}

**Depends on:** #step-1, #step-2, #step-3, #step-4, #step-5

**Commit:** `N/A (verification only)`

**References:** [R04](#r04-worktree-checkpoint), [Table T01](#t01-breakage), [Table T02](#t02-fold-breakage), (#success-criteria)

**Tasks:**
- [ ] Confirm every success criterion in [#success-criteria](#success-criteria) by running the surfaces, not by reading the diff.
- [ ] Run the lane suite from the **main checkout** — the corpus refuses to run from a dash worktree ([R04](#r04-worktree-checkpoint)).
- [ ] Verify no `tugdash/*` branch, worktree, `rr-cache` entry, or working-tree modification is left behind.
- [ ] Grep the tree for the deleted names — `joinAvailable`, `data-choice-value="join"`, `session-changes-dash-lane-fold`, `confirmingDiscard`, `data-confirming`, `session-changes-dash-landing-discard`, `select-composer-route:join` — and confirm zero hits outside this plan document.

**Tests:**
- [ ] The five dash-lane app-tests plus the two composer-route files in one invocation.

**Checkpoint:**
- [ ] `just app-test tests/app-test/at0405-changes-dash-lane.test.ts tests/app-test/at0417-join-mode.test.ts tests/app-test/at0418-join-outcomes.test.ts tests/app-test/at0425-dash-conflicted-landing.test.ts tests/app-test/at0426-dash-resolution-review.test.ts tests/app-test/at0427-dash-divergence-marks.test.ts tests/app-test/at0340-composer-routes.test.ts`
- [ ] `cd tugdeck && bunx tsc --noEmit && bun test && bunx vite build`
- [ ] `cd tugrust && cargo nextest run`
- [ ] `git branch --list 'tugdash/*'` and `git status --short` both clean of fixture residue

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** One Changes room — an invariant `Prompt | Changes` group whose door opens the landing the card is mated to, a dash lane with no fold, a release gesture that reaches every dash nobody live is holding and confirms through a popover that names the hand-back, and a landing that can no longer emit a doubled scope.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Two route segments on every card, bound or unbound (at0417).
- [ ] ⌃⌘C opens join mode on a mated card and commit mode otherwise, with the Z5 button naming which (at0340).
- [ ] Every project dash is a visible row; no fold element exists (at0405, at0427).
- [ ] Release is present on own and parked dashes, absent on another live session's, and confirms through `tug-confirm-popover` with the hand-back named (at0405 + unit).
- [ ] `integrate_message` yields exactly one `tugdash(` for a foreign-scoped body (`cargo nextest run -p tugdash-core`).
- [ ] Three skills instruct a bare join-draft subject.
- [ ] `just app-test-covers-check` passes; `bunx tsc --noEmit`, `bun test`, `bunx vite build`, and `cargo nextest run` are all clean.

**Acceptance tests:**
- [ ] at0340, at0405, at0417, at0418, at0425, at0426, at0427 green in one invocation.
- [ ] `bun test` unit coverage for `canReleaseFromHere` and `releaseConfirmMessage`.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] **The Join sheet hunt.** This plan's dash is the intended live subject: exercise the join surface through implementing → built → conflicted → landed in the release instance, and either capture the misbehavior with the protocol in `closing-dash-backend-issues-brief.md#join-sheet` or downgrade the report.
- [ ] Entry points into dash workflows — starting and binding a dash from the surfaces that now show one.
- [ ] Head+tail elision for capped review diffs (cosmetic since the stat became truthful).
- [ ] The deferred lifecycle items: queue-a-landing-for-turn-end, a lane click affordance for `dash replay`, post-rebase checkpoint runs.

| Checkpoint | Verification |
|------------|--------------|
| One room | at0340's bound and unbound ⌃⌘C cases |
| Two segments | at0417's `routeValues` equals `["prompt","changes"]` |
| No fold | at0405 asserts zero `session-changes-dash-lane-fold` elements |
| Release reach | Unit predicate over four arms + at0405's present/absent cases |
| Informed consent | Popover message contains the hand-back sentence for a dirty worktree |
| No doubled scope | `integrate_message_strips_a_foreign_scope` |

---

## Implementation addendum {#addendum}

**Written 2026-08-16, after the plan landed.** Everything above is the plan as reviewed; this records what implementation actually did, where it departed from the plan and why, and one claim the plan got wrong. It postdates the review stamp, so `tugutil plan status` now reads **`stale`** — because the document finished, not because it drifted, the same way `base-motion-replay-plan.md` reads.

### Status {#addendum-status}

All six steps `done`. Landed on `main` as **`2ddcace0a`** — *"Make Changes one room and one landing"* — squashed from six rounds on `tugdash/unified-changes`.

Verification at close: `bunx tsc --noEmit`, `bun test` (6908 pass, 15 new), `bunx vite build`, `cargo nextest run` (2818 pass), `cargo build` under `-D warnings`, `just app-test-covers-check`, and the seven-file lane + composer-route app-test invocation **7/7 files, 10/10 tests** from the main checkout.

### What changed under implementation {#addendum-deviations}

Five departures from the plan as written. None changed the deliverable; all are recorded because a cold reader comparing plan to diff would otherwise find them unexplained.

1. **[P02]'s tooltip could not read the active landing kind.** The card passes `joinActive ? joinModeController : commitModeController`, so `landingMode.kind` says `join` only while a join is *already up* — a mated card sitting in the prompt would have shown "Write a commit message". The tooltip has to follow the **binding**, which is what [P02]'s own text says. `joinAvailable` was therefore not simply deleted but **retyped** as `changesLandingKind: LandingKind`, carrying the same expression the old prop computed.

2. **[Spec S03]'s exit branch mattered more than the plan implied.** The plan noted `TOGGLE_CHANGES_VIEW`'s exit tests only `commitModeController`. Once the chord could *open* a join, that omission became a live defect: pressing ⌃⌘C a second time on a mated card fell through to `shadeViewController.hide()` and dropped the shade out from under an active join. at0340's bound case drives the chord both directions for exactly this.

3. **[P12] became props, and `DashLandingActions.release` was deleted.** Folding the two gates into one `disabledReason` meant the landing face could no longer compute its own `releaseHint` — it now takes `releaseAvailable` and `releaseDisabledReason` from the lane's release bundle, so the fronted row's Release and a parked row's cannot disagree. With the dispatch moved to `DashLaneRelease`, the landing actions' `release` arm had no caller and went with it.

4. **[Spec S02]'s plan clause was gated on the wrong condition.** The spec said *"`bound_sessions` empty and the dash records a plan"*. `restore_plan_to_base` runs **unconditionally** before teardown, so the implemented condition is `plan_path !== undefined`. The spec's extra qualifier would have hidden a true fact from a reader whose dash was bound.

5. **The negative reach case was not testable, so the seeder was extended.** `bound_sessions` is computed from `sessions.db` rows, so a client-side `bind_dash_ok` cannot fabricate "another live session holds this dash" — and no ledger-seed field could write a binding. `SeedSession` (tugcast) and `LedgerSeedSession` (the harness) gained `dash_id` / `dash_name`, applied through the same `set_dash_binding` a real `bind_dash` uses. Without this, at0405 could have asserted only the permissive half of the reach rule. `TugConfirmPopover` also gained `data-slot`s on its parts (`tug-confirm-cancel`, `tug-confirm-confirm`, `tug-confirm-message`) so at0418 aims a real pointer at the act it means rather than walking the button list by label text.

### One claim the plan got wrong {#addendum-correction}

**The fold deletion did not retire at0405's chronic `did not land (attempt 1)` diagnostic, as [P04](#p04-no-fold) claimed it would.** The `session-changes-dash-lane-fold` instance is gone with the control, but the same diagnostic now fires on `session-changes-dash-fold` — the **row's own** expand cue. The cause was never that particular control: the lane is the shade's last block over an aggregate that recomposes on its own schedule, so any coordinate read there can go stale between aiming and clicking. Covered by the retry, green, and still worth fixing at the source. It stays open in `dash-closure-brief.md#tail` with this narrower diagnosis.

### The worktree risk held exactly as written {#addendum-worktree}

The corpus refused the linked worktree, by name and with its reason. Steps 1–5 carried their own frontend and Rust checkpoints on the dash; Step 6's app-test half ran from the main checkout after the landing. Confirmed by running it rather than assumed. Any future plan walked as a dash inherits this shape.

### The Join sheet hunt, incidentally exercised {#addendum-join-hunt}

The pairing [#join-hunt](dash-closure-brief.md#join-hunt) proposed worked: this dash went created → implementing → built → landed through the shade by hand, on real work, in a real instance. The join surface behaved at every stage, and at0425's archaeology read the resulting squash back — `tugdash(unified-changes): Make Changes one room and one landing`, one scope, which is the scope fix proving itself on its own landing. That is the deliberate-exercise receipt §4 asks for. Writing the downgrade is the next step, not a conclusion this document may draw on its own.

### Next {#addendum-next}

In order, per `dash-closure-brief.md#program`:

1. **Close the Join sheet report** — write the downgrade into `closing-dash-backend-issues-brief.md#join-sheet` with this run as its receipt, or capture a misbehavior if the owner saw one during the landing. Cheap, and it ends a standing tripwire.
2. **Entry points into dash workflows** ([#entry-points](dash-closure-brief.md#entry-points)) — the last UX item, and a design round with the owner before any plan. Every surface that now *shows* a dash is a candidate place to start, bind, or join one; the shade's rows are newly load-bearing here, since they are visible and carry gestures for the first time.
3. **Archive the six historical documents** the brief's `#document-map` names, so `roadmap/` reads as only the live surface.
4. **The pull-driven tail** — including this addendum's re-diagnosed click noise.
