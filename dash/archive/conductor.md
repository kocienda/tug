## The Conductor — name and expose the session-rotation primitive {#conductor}

**Purpose:** Extract the session-rotation act out of the dash arc into a named layer — the **conductor** — with a typed request, a tugcast op, a `tugutil session rotate` verb, and doctrine; then prove it by making `plan-devise`'s review hand-off the first non-arc score.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main (via the `conductor` dash worktree) |
| Last updated | 2026-08-25 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-25, opus.** Reviewed `plan:a01d8f30134441e1`. Lint: 0 errors, 1 warning (fixed — this section did not exist).
Oriented on: the whole document, first pass, read against `agent_supervisor.rs`, `dash_arc_runner.rs`, `session_ledger.rs`, `tugutil/src/dash.rs`, `tugcode/src/session.rs`, `tugproto/src/inbound.ts`, the deck's `code-session-store`, and `plan-devise/SKILL.md`.
Applied: **the hand-back hole** — `restore_deck_model` is reachable only from `dash_arc_runner.rs`'s `finish`/`stop`, so a scoreless rotation would pin the card on the stage model forever (its own doc comment says the selector survives the user's `/new`) while the deck's selector kept showing the old one; raised with the owner, who chose a one-turn hand-back, now [P13], wired into Step 3, the receipt in [S04], the risk table, and the exit criteria. **[P04]'s perform-at-request-time shortcut** — `turn_active` is written true in exactly one place (`dispatch_one`'s `user_message` intercept), so a turn tugcast did not open reads idle while claude works, and the shortcut would have rotated mid-turn and killed the requesting claude, which the plan's own non-goals call *never*; deleted, with the tick driven directly in tests instead. **Step 3's live checkpoint** — as written it rotated the card implementing this dash away mid-run, and under an arc would have been refused `arc_running` by [P06] anyway; rewritten onto a second, unbound card, with the refusal made its own assertion. **Step 4's recorder gap** — `replay_lineage` reads through `&dyn SessionsRecorder`, so `SessionLedger::set_stage_provenance` alone leaves the columns unreadable; added the trait method and both impls. **[P03]'s CLI plumbing** — `post_dash_api`'s failure text and `calling_session_id`'s refusal are both dash-flavored literals that a rotation must not print, so both gain a subject; also corrected the claim that the port loop special-cases `unknown_session` — it branches only on `status != "ok"`. **Step 1** — noted the one forced shape change (`document`/`arc` `String` → `Option`) with a byte-identical assertion, and widened the checkpoint to `-p tugdash-core` since `stage_model` moves there. **Step 7** — the `grep "Opus"` checkpoint was false as written (the arc branch legitimately keeps one mention) and the "only on Opus" sentence in §5's tail was unlisted; both corrected.
Verified and left alone: [P12]'s no-deck-change claim (`frameToEvent` defaults every field, `stageNoteText("review","opus","")` really does read `review · opus`, and `handleSessionStage` never touches `arc`); [P05]'s dependency reasoning (`tugdash-core` does depend on `tugutil-core`); [P02]'s and [S01]'s field set; the tugcode widening (`isInboundMessage` is verb-list-derived, so no per-field validation blocks a free-form `name`); and the whole of Step 5.
Deferred: nothing.

---

### Phase Overview {#phase-overview}

#### Context {#context}

Tug mediates every claude session through tugcast and tugcode. That mediation already buys a capability a terminal claude cannot have: tugcast can retire the claude session seated under a card and seat a fresh one — on a chosen model, with a chosen opening prompt — while the card, its transcript, its callsign, and its durable ink all stay exactly where they were. The dash arc uses this three times per run (devise → review → implement).

The capability has no name and no door. It lives as the private function `rotate` in `tugrust/crates/tugcast/src/feeds/dash_arc_runner.rs`, which builds a `StageSpec` and hands it to `AgentSupervisor::drive_stage` in `tugrust/crates/tugcast/src/feeds/agent_supervisor.rs`. Nothing outside `dash_arc_runner.rs` constructs a `StageSpec`. The only session-addressed server op near it is `arc_run` in `tugrust/crates/tugcast/src/server.rs`, which binds a dash and deliberately rotates nothing.

The cost of that shows in `tugplug/skills/plan-devise/SKILL.md` §5: outside an arc, the skill branches on the model it happens to be running on — reviews inline on Opus, otherwise stops and prints a `/tugplug:plan-review` chip for the user to click after switching models by hand. The arc rotates models with nobody clicking anything. The same machinery could carry that review turn; it does not, because no skill can ask for a rotation.

This plan gives the layer its name, moves the act behind a typed boundary, opens two doors onto it (an op and a verb), writes the doctrine, and converts `plan-devise` to use it.

The governing document is [`dash/conductor-brief.md`](conductor-brief.md), whose decisions `[B01]`–`[B09]` this plan honors. Every plan-local decision below either implements a `[B##]` or settles one of the brief's three open questions.

#### Strategy {#strategy}

- **Move the seam before widening it.** Step 1 relocates the act into `tugcast/src/conductor/` with the arc as its first caller and *no behavior change at all* — every existing arc test passes unchanged, which is the checkpoint that proves only the seam moved.
- **Widen the wire second.** The rotation wire types (`SessionStageSpec`, `SessionStage`) currently hard-code the arc: `name` is the three arc stages and `arc` is required. A non-arc rotation needs a free-form stage label and no score. That is a tugproto + tugcode change with a deliberately empty deck diff.
- **Then open the doors.** The op and the verb land together, with the turn-end placement `[B03]` demands and a refusal path that is never silent.
- **Fix the restore leg before shipping a client.** A rotation's transcript is an *invariant* `[B05]`, and today the restore path reconstructs stage dividers from the arc record — so a non-arc rotation would lose its history on relaunch. That is a real gap, not a follow-on.
- **Compose the opening prompt from documents, never from a sentence** `[B09]` — and put that composition in the conductor, where every score gets it.
- **`plan-devise` last.** It is the acceptance test: if the conductor cannot carry that one hand-off cleanly, it has not been extracted.

#### Success Criteria (Measurable) {#success-criteria}

- `StageSpec`, `drive_stage`, and `restore_deck_model` no longer exist on `AgentSupervisor`; `rotate`/`hand_back` live in `tugcast/src/conductor/` and `dash_arc_runner.rs` calls them (verified: `cargo nextest run` green with the arc's own tests unmodified, Step 1).
- A `RotationRequest` cannot be constructed without naming the card and the tug session it rotates — the invariant floor of `[B05]` (verified: Rust test, Step 1).
- `tugutil session rotate --stage review --prompt '…'` run from inside a turn on a Session card returns a receipt, performs nothing during that turn, and performs the rotation on that turn's idle transition (verified: Rust integration test over the real supervisor + tick, Step 3).
- A rotation carrying no `arc` and no `document` draws a stage divider reading `review · opus` and leaves the transcript above it untouched (verified: bun unit test on `stageNoteText` + reducer, and the live-render leg of `at0474-dash-arc-transcript.test.ts`, Step 2 and Step 4).
- A card rotated by a scoreless request onto a named model is back on the user's own model one turn later, with no score having ended (verified: Rust integration test over `conductor_tick`, Step 3).
- After a relaunch, a card that was rotated with no arc behind it replays as one scroll with its divider (verified: Rust test over `replay_lineage`, Step 4).
- `/tugplug:plan-devise` outside an arc ends by asking for a rotation to the review model and ending its turn — no model fork, no chip — and falls back to the chip only when the rotation is refused (verified: skill text + the refusal's own receipt, Step 7).
- `tuglaws/conductor.md` exists, is registered in `tuglaws/INDEX.md`, and states the three kinds of carried thing and the turn-end placement (verified: prose assertion, Step 6).

#### Scope {#scope}

1. A `conductor` module in tugcast owning the rotation act, its request type, its refusals, and the opening-prompt composition.
2. Wire widening so a rotation is expressible without a dash arc behind it.
3. `POST /api/session` (`rotate` / `rotate_cancel`) and `tugutil session rotate`.
4. Durable per-session stage provenance so a non-arc rotation survives a relaunch.
5. `tuglaws/conductor.md`, its INDEX entry, and the two cross-references it forces.
6. `plan-devise` and `plan-review` skill text.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Renaming `tugutil` to `tug`.** It collides with Tug.app's `Tug` binary on case-insensitive APFS; tried and rolled back.
- **Carrying context across a rotation.** A rotation is a fresh claude session by definition `[B05]`; context continuity is `/compact`'s job.
- **Rotating mid-turn.** Never — the requesting claude would be killed by its own request `[B03]`.
- **A general multi-card orchestrator.** The conductor seats sessions under *one* card.
- **Rewriting the arc's decision logic.** `dash_arc.rs` — `arc_action`, `ArcFacts`, `Rotation` — is untouched; only the act moves `[B06]`.
- **A `--score` flag on the verb** (see [P07]) — the request type carries a score; the CLI face does not expose one in this phase.
- **Surviving a tugcast restart with a pending rotation** (see [P06]) — a request is a promise about *this* turn's end, and the turn does not survive the restart either.
- **A deck-side "will rotate at turn end" affordance.** Settled against in [P08]; the ask is visible in the asking turn, the act is visible as the divider.

#### Dependencies / Prerequisites {#dependencies}

- The dash arc as it stands after `a9c0d1235` — `dash_arc_runner.rs`, `dash_arc.rs`, and the identity transfer in `agent_bridge.rs` are the substrate this refactors.
- The deck's conductor turn attribution (`TurnOrigin` `"conductor"`, `conductorPromptPending`), landed in `97f94b485` and `773c58a49`. This plan consumes it and does not change it.
- A built `tugutil` on the dash worktree for any manual exercise of the verb — note that `~/.local/bin/tug*` symlinks point at the base checkout, so a bare `tugutil` from a worktree runs *old* code. Use the worktree's `target/debug/tugutil` by absolute path.
- Skill text changes do nothing until Tug.app is rebuilt: `tugplug/` hooks and skills run from the app bundle, not the repo.

#### Constraints {#constraints}

- **Warnings are errors.** `tugrust/.cargo/config.toml` sets `-D warnings`; a warning fails the build and the test run.
- **Ledger discipline.** `sessions.db` is the per-instance ledger; new columns go in as additive, idempotent `ALTER TABLE sessions ADD COLUMN` guarded like `forked_from_session_id` / `fork_point` already are. This is *not* the shared `changes.db` schema and does not touch `CHANGES_SCHEMA_VERSION`.
- **One consumer per mpsc.** The turn-end idle edge is already fanned to two sibling channels (`turn_complete_tx` for base-motion, `arc_tick_tx` for the arc). A third consumer needs a third channel, not a second receiver.
- **`tugutil` reaches tugcast over loopback HTTP only**, through the try-each-instance port loop in `post_dash_api` (`tugrust/crates/tugutil/src/dash.rs`); every tugcast API refuses non-loopback callers.
- **The deck must not need a change.** `frameToEvent` already defaults every missing `session_stage` field to `""` and `stageNoteText` already omits an empty model or document, so widening the wire must stay inside what the deck already tolerates.

#### Assumptions {#assumptions}

- A card runs at most one score at a time; a one-shot rotation requested on a card bound to a live arc is a conflict to refuse, not a queue to build ([P06]).
- The user is present at the card when a skill asks for a rotation, so the asking turn's own text is a real surface for the receipt ([P08]).
- `tugcode`'s respawn gate (`773c58a49`) serializes respawns, so a rotation arriving behind another respawn is ordered rather than raced.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

The brief carried three open questions. All three were settled in this devise round by reading the code the brief named, as the brief's Exit section directed; none was deferred and none required asking the user. They are recorded as decisions rather than questions:

- *Where does the review model come from when a skill asks for "the review model"?* → [P05]. No roles table; the stage label resolves through the project's existing `[tugtool.dash]` stage-model keys.
- *What does the verb print, and what does the user see on the card at the moment of the ask?* → [P08]. A receipt line on stdout inside the asking turn; the card's artifact is the divider the rotation already draws.
- *Should a rotation request be cancellable before the turn ends?* → [P09]. Yes — `--cancel`, and a second request supersedes the first.

Round 1 of review raised a fourth, which the owner settled in the review turn rather than deferring: *what ends a rotation that has no score to end?* → [P13]. It is recorded as a decision for the same reason as the other three.

No `[Q##]` remains open in this plan.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| The extraction changes arc behavior subtly | high | med | Step 1 moves code without editing it and leaves every arc test unmodified | any arc test needing an edit in Step 1 |
| A one-shot rotation collides with a live arc on the same card | high | low | refuse at request time with a named reason ([P06]) | a user asks to queue rather than refuse |
| A non-arc rotation loses its transcript on relaunch | high | high without Step 4 | durable stage provenance on the session row ([P10]) | a divider missing after relaunch |
| `plan-devise` rotates where no Tug session exists | med | med | the verb refuses without `TUG_SESSION_ID`; the skill falls back to the chip ([P11]) | a terminal-claude devise run losing its review |
| A scoreless rotation leaves the card pinned on the stage model | high | high without [P13] | a hand-back armed at rotation and fired on the next turn-end tick ([P13]) | a card still on the review model two turns after a `session rotate` |
| A parked request fires into a turn tugcast never opened | high | low | no perform-at-request-time path; the request always waits for a turn-end edge ([P04]) | any proposal to re-add an immediacy shortcut |

**Risk R01: The extraction is a behavior change in disguise** {#r01-extraction-drift}

- **Risk:** `drive_stage` carries three load-bearing subtleties — model frame *first* (tugcode records the selector and its next spawn reuses it), the `Spawning`-branch enqueue *inside* the lock with the prompt dispatched after, and refusals *returned* rather than logged. A rewrite rather than a move loses one of them silently.
- **Mitigation:**
  - Move the function body verbatim; change only the type it destructures and the `self` it hung off.
  - Keep the frame-ordering assertions that live in `agent_supervisor.rs`'s tests (`stage_spec`, the `StageDelivery::Sent` / `Queued` cases, the `SpawnState` → refusal matrix) — relocate them beside the conductor unchanged.
  - Add a pure `frames_for(&RotationRequest)` so the ordering is asserted over data rather than over a live supervisor.
- **Residual risk:** the queued path still needs a live-ish supervisor to assert; that test moves rather than improves.

**Risk R02: A rotation the user did not expect** {#r02-unexpected-rotation}

- **Risk:** a skill asks for a rotation, the user reads the turn's end as the work finishing, and the card silently becomes a different session on a different model.
- **Mitigation:** the ask prints a receipt naming the model, the stage, the prompt, and that the card hands back after, inside the turn that asked ([P08], [P13]); the act draws the divider naming the stage and model; `--cancel` withdraws a pending request ([P09]); the hand-back returns the card before the user's next turn, so the card the user resumes typing into is theirs ([P13]).
- **Residual risk:** a user who does not read the turn still sees the divider only after the fact. That is the same contract the arc already ships.

**Risk R03: `[B09]`'s prompt composition reaches for git on every rotation** {#r03-git-on-rotation}

- **Risk:** composing the opening prompt shells out to `git log` scoped to the document's paths, on a path that runs inside a sweep.
- **Mitigation:** the composition already runs inside `read`'s `spawn_blocking` (the arc's fact-gathering is blocking by construction and does one scoped git read for implement stages today); the new read is bounded to the paths one document names, and a failure degrades to omitting the "what moved" paragraph rather than failing the rotation.
- **Residual risk:** a document naming very many paths makes a longer git invocation. Bounded by the cap in [S02].

---

### Design Decisions {#design-decisions}

#### [P01] The conductor is a tugcast module, not a service (DECIDED) {#p01-conductor-module}

**Decision:** The conductor is `tugrust/crates/tugcast/src/conductor/` — `mod.rs` (the request type, refusals, and `rotate`/`hand_back`) and `prompt.rs` (the opening-prompt composition of `[B09]`). It borrows `&AgentSupervisor` rather than owning one, and holds exactly one piece of state of its own: the pending-rotation registry of [P06].

**Rationale:**
- The act needs the supervisor's per-session ledger, spawn queue, and `dispatch_one`; making the conductor own them would be a second supervisor.
- A module with free functions over `&AgentSupervisor` is the smallest thing that satisfies `[B06]`'s "typed interface with its own tests".
- `feeds/` is for feed engines that own a task; the conductor is a primitive its clients call, so it sits beside `session_ledger.rs` at the crate root rather than under `feeds/`. Its one task (the pending-rotation drain) is spawned from `main.rs` like the others.

**Implications:**
- `AgentSupervisor::drive_stage` and `AgentSupervisor::restore_deck_model` are deleted; their bodies become `conductor::rotate` and `conductor::hand_back`.
- `StageSpec`, `StageDelivery`, and `StageRefusal` move out of `agent_supervisor.rs`. `StageSpec` is superseded by `RotationRequest`; `StageDelivery`/`StageRefusal` are renamed `Delivery`/`Refusal` in their new home, since "stage" is now one word for what a rotation seats rather than the name of the operation.

#### [P02] `RotationRequest` states the invariant floor by omission (DECIDED) {#p02-rotation-request}

**Decision:** `RotationRequest` carries exactly `[B05]`'s parameters and nothing else. It is constructed through `RotationRequest::new(session: TugSessionId, prompt: String, stage: String)` with the rest set by builder-style setters; the card, the tug session id, the transcript, the ink, the lineage, and the user's model to return to are **not fields** and cannot be set.

**Rationale:**
- `[B05]` asks for the invariant floor to be written down so nobody parameterizes it later. A type whose only constructor takes the session it rotates *on* — never the identity it rotates *to* — expresses that in the compiler rather than in a comment.
- The transcript, ink, and lineage are invariant because nothing in the request can address them: they follow from the identity transfer in `agent_bridge.rs` (`inherit_fork_identity` + `set_fork_provenance(…, None)`), which the conductor never calls and cannot parameterize.
- The user's model to return to is `LedgerEntry::deck_model`, read by `hand_back` and never written by a request.

**Implications:**
- The parameter set is `model`, `effort`, `prompt`, `stage`, `score`, plus the two the arc needs to make its divider read correctly (`document`, `plan`, `steps`).
- A doc comment on the type names the floor explicitly, and a Rust test asserts the constructor's shape so a later field addition is a deliberate edit to a test that says why.

#### [P03] The op is `POST /api/session`, spelled where a session op belongs (DECIDED) {#p03-session-api-route}

**Decision:** The tugcast door is a new loopback route `POST /api/session` taking `op: "rotate" | "rotate_cancel"`, not a new op on `POST /api/dash`.

**Rationale:**
- `[B07]` asks for "a tugcast op (`session_rotate`, beside `arc_run`)". `arc_run`'s request struct is `DashApiRequest` — `op`, `tug_session_id`, `project_dir`, `dash` — and a rotation names no dash. Adding `model`, `prompt`, `stage`, and `effort` to a dash-shaped struct would put the conductor's whole parameter set inside a type whose name says it is about dashes.
- The verb is `tugutil session rotate` `[B03]` because it is the session that rotates. The route follows the same reasoning: `/api/session` `op: rotate`.
- This is a spelling refinement of `[B07]`, not a departure from it: the op exists, it is a tugcast op, and it lands together with the verb and the doctrine, which is what `[B07]` actually decides.

**Implications:**
- `post_dash_api` in `tugrust/crates/tugutil/src/dash.rs` is generalized to `post_instance_api(path, subject, body)`; `post_dash_api` becomes a one-line wrapper passing `"/api/dash"` and `"dash binding"` so no dash verb changes.
- `subject` is needed because the loop's own failure text is dash-flavored today — `"dash binding goes through a running Tug instance, but none was found"` is a literal in `post_dash_api`, and a rotation must not report a dash binding it never asked for.
- The loop's behavior is unchanged and does **not** special-case `unknown_session`: it treats any response whose `status` is not `"ok"` as "not this instance", records the body's `message` as `last_error`, and tries the next port. The only thing `unknown_session`'s 404 needs is that the body stay readable, which `http_status_as_error(false)` already guarantees — so answering 404 with that message is enough, and no new branch is added.
- `calling_session_id`'s refusal text is likewise dash-flavored (`"dash binding names the calling session…"`). It gains a `subject: &str` parameter so `rotate` reads *"a rotation names the calling session"*; every dash call site passes what it says today.

#### [P04] The verb runs from inside a turn and lands at that turn's end (DECIDED) {#p04-turn-end-placement}

**Decision:** `tugutil session rotate` records a *pending* rotation against the calling session and returns immediately. The conductor performs it on that session's next idle transition — the same turn-end edge the arc and base-motion already consume, on a third sibling mpsc (`conductor_tick_tx`).

**Rationale:**
- `[B03]`: a rotation mid-turn kills the claude that asked for it. This is exactly `arc_run`'s existing contract ("It binds and returns; it never rotates"), and the comment in `apply_dash_request` says why.
- The idle edge is already computed in `AgentSupervisor`'s dispatcher (`is_turn_end` with `replay_brackets_open == 0`) and already fanned to two channels; a third is the established shape and the comment there says why an mpsc cannot simply be subscribed twice.

**Implications:**
- `AgentSupervisor` grows `pub conductor_tick_tx: OnceLock<mpsc::Sender<String>>` beside `arc_tick_tx`, sent to at the same site.
- `main.rs` spawns `conductor::run_conductor(…)` beside the arc engine, with the same `CancellationToken`.
- **There is no perform-immediately shortcut.** A request is *always* parked and always waits for a turn-end edge, even when the entry reads `turn_active == false` at request time. `turn_active` is set true in exactly one place — `dispatch_one`'s `user_message` intercept (`agent_supervisor.rs:8018`) — plus the wake edge, so a turn tugcast did not itself open reads as idle while claude is working. Performing on that reading would rotate mid-turn and kill the claude that asked, which this plan's own non-goals call *never*. Parking is safe under a wrong reading; performing is not.
- The consequence is honest and is what the receipt says: a rotation asked for outside any turn lands at the end of the session's **next** turn. Nothing is lost — the request is a promise about a turn's end, and a caller who is not in a turn is asking about the next one.
- Testability does not need the shortcut: the tick is a real `mpsc::Sender<String>`, so an integration test sends the session id on `conductor_tick_rx` directly. That is driving the actual mechanism, not faking a turn.

#### [P05] The stage label *is* the role; there is no roles table (DECIDED) {#p05-stage-is-role}

**Decision:** When `--model` is omitted and `--stage` names one of `devise` / `review` / `implement`, the verb resolves the model from the project's existing `[tugtool.dash]` keys (`devise_model` / `review_model` / `implement_model`). An omitted `--model` with any other stage label means the account default. `--model` always wins.

**Rationale:**
- The brief's first open question asked whether roles belong beside the stage models or are the same table. Reading `DashConfig` (`tugrust/crates/tugutil-core/src/config.rs`) answers it: `review_model` is already spelled as "the model the review stage runs on", with nothing dash-specific in its meaning. A second table would be the same fact twice.
- `[B02]` forbids new vocabulary for the operation. "Role" would be new vocabulary for something `stage` already names.
- It keeps the skill's ask to one line with no JSON parsing: `tugutil session rotate --stage review --prompt '…'` resolves the project's declared review model by itself.

**Implications:**
- `stage_model(&DashConfig, ArcStage)`, today a private function in `dash_arc_runner.rs`, moves to `tugdash_core::arc::stage_model` so tugutil and tugcast share one resolution. (`tugdash-core` depends on `tugutil-core`, so `DashConfig` is in scope there; the reverse is not true, which is why it does not go in `tugutil-core`.)
- The resolution happens in the **verb**, not the server: the CLI is where the project root is known from cwd, and the server would have to re-derive it.
- A project that declares no `review_model` rotates on the account default — the same "no `model_change` frame at all" path the arc already takes.

#### [P06] One score per card; a colliding request is refused, not queued (DECIDED) {#p06-one-score-per-card}

**Decision:** The pending-rotation registry holds at most one request per tug session id, in memory, keyed inside the conductor. A `rotate` request naming a session that is bound to a dash with a live (non-`done`, non-`stopped`) arc is **refused** with `arc_running`. A pending request does not survive a tugcast restart.

**Rationale:**
- Two schedulers driving one card is the seam `[F06]` says produced every bug the streamline audit found. Refusing is the one behavior that cannot produce an interleaving.
- Bounded state: the arc's own in-flight bookkeeping is a per-arc `ArcState` map; this is the same shape, keyed by session.
- A request is a promise about the end of a turn that is in flight *right now*. A tugcast restart ends that turn by killing the claude running it, so a request surviving the restart would fire into a session that never finished the work it was scheduled behind.

**Implications:**
- The refusal is returned to the verb, which exits non-zero with the reason — visible in the asking turn ([P08]) rather than logged and dropped ([L31]).
- The arc-liveness check reads `tugdash_core::arc::read_arc` for the session's bound dash, exactly as `bound_arcs` does; no arc record, no binding, or a `done`/`stopped` arc all mean "no score running".
- A second `rotate` on a session that already has one pending **replaces** it and says so in the receipt — the natural reading of a caller changing its mind mid-turn.

#### [P07] The request carries a score; the verb does not offer one (DECIDED) {#p07-score-not-exposed}

**Decision:** `RotationRequest` has a `score: Option<String>` field, which the arc runner fills with the dash name and which reaches tugcode as the `arc` field of the stage spec — the value tugcode threads into `TUG_DASH_ARC`. The `tugutil session rotate` verb exposes **no** flag for it in this phase; a one-shot rotation carries no score.

**Rationale:**
- `[B05]` lists the score among the parameters, and the type honors that. But `TUG_DASH_ARC` is read by `plan-devise`, `plan-review`, and `dash-implement` as "a dash arc is driving you", and by `dash_arc_runner` as a dash name it will `read_arc` on. Letting a caller set it to an arbitrary string would make three skills believe an arc runs them and find no record behind the name.
- The generalization the brief describes — "the document the conductor answers to" — is a rename of the environment variable and a widening of what the stage skills read. That is its own change with its own blast radius, and nothing in this phase needs it.

**Implications:**
- `tuglaws/conductor.md` records the score as a parameter of the primitive with the CLI gap named explicitly, so the next score to need one knows where to add it.
- The wire field stays spelled `arc`; renaming it would touch `agent_bridge.rs`'s parser, tugcode, tugproto, the deck's `frameToEvent`, and the replay path for no behavior gained.

#### [P08] The ask is a receipt in the asking turn; the act is the divider (DECIDED) {#p08-receipt-shape}

**Decision:** `tugutil session rotate` prints a `TUG-ROTATION-RECEIPT:` line naming the stage, the resolved model, and when it will happen (plus the whole payload under `--json`). A refused request exits non-zero with the refusal's reason on stderr. Nothing new is drawn on the card at request time; the card's artifact is the stage divider the rotation already draws, composed by `stageNoteText`.

**Rationale:**
- The brief's second open question asked whether the receipt is a receipt line only or also a divider-shaped note ahead of the `session_stage` frame. Reading the deck settles it: a pending-rotation note would be a new CONTROL action, a new store field, a new reducer case, and a new effect — four new surfaces to render a sentence whose subject arrives seconds later and renders itself.
- It is not an `[L31]` silence. The ask happens *inside a turn the user is watching*, in a Bash tool block; the receipt is in that block, and a refusal fails the command loudly rather than returning quietly.
- The precedent for an unsolicited card-visible receipt is `record_arc_receipt`, and it exists because an arc *ends* with nobody waiting. A rotation request has somebody waiting: the turn that asked.

**Implications:**
- No tugdeck change in this phase, which is also what keeps the deck diff empty ([P12]).
- `format_rotation_receipt` is a pure function in tugutil with a table test, following `format_arc_receipt`'s precedent.

#### [P09] A pending rotation is cancellable, and the last word wins (DECIDED) {#p09-cancel}

**Decision:** `tugutil session rotate --cancel` clears the calling session's pending rotation and prints a receipt saying whether there was one. A second `rotate` supersedes a first.

**Rationale:**
- The brief's third open question. The registry makes both trivial — a `remove` and an `insert` — and the alternative is a promise the user cannot withdraw.
- Reading the arc's stop path (`stop` / `finish` in `dash_arc_runner.rs`, `append_arc_stop`) shows why cancellation here is *not* that: an arc stop is a durable record with a resume path, because an arc is a document-driven schedule. A pending rotation has no document and no next stage; withdrawing it leaves nothing behind, which is the correct amount of ceremony for a promise about the next few seconds.

**Implications:**
- `--cancel` takes no other flags; combining it with `--prompt` is a usage error.
- Cancelling with nothing pending exits 0 and says so — a state, not an error, matching `dash docs-dir`'s precedent.

#### [P10] Stage provenance is durable on the session row, not reconstructed from the arc (DECIDED) {#p10-durable-stage-provenance}

**Decision:** The `sessions` table gains `stage_label TEXT` and `stage_model TEXT`, written at the same site that writes fork provenance (`agent_bridge.rs`, where the `session_stage` announcement is consumed and `set_fork_provenance` is called). `replay_lineage` in `agent_supervisor.rs` composes its entries from those columns, consulting the arc record only for the `arc` and `document` fields a dash arc's divider carries.

**Rationale:**
- `[B05]` makes the transcript an invariant of a rotation. Today `replay_lineage` returns `None` unless it finds a dash binding *and* an arc record — so after a relaunch, a card rotated with no arc behind it replays only its newest session and the earlier work disappears. That breaks the invariant for exactly the client `[B08]` introduces.
- The lineage *chain* is already arc-independent: it is walked over `forked_from_session_id`, which the rotation writes with `fork_point: NULL` `[F03]`. Only the per-entry facts come from the arc. Moving those two facts onto the row makes the whole path arc-independent with no new query.
- Additive nullable columns on the per-instance `sessions.db` are the established migration shape here (`forked_from_session_id`, `fork_point`, `tag`, `synopsis` all arrived this way, each guarded for idempotence).

**Implications:**
- `PendingFork` gains `stage_label: Option<String>` and `stage_model: Option<String>`, filled where the bridge already parses the announcement.
- A row written before this change has NULL columns; `replay_lineage` falls back to the arc record for those, so existing arcs replay exactly as they do today.
- The "a chain whose every entry is stage-less carries no lineage" guard is unchanged — it just now reads the row rather than the record.

#### [P11] `plan-devise` always hands the review to the conductor, and falls back to the chip only on refusal (DECIDED) {#p11-plan-devise-no-model-fork}

**Decision:** `plan-devise` §5's model fork is deleted. Outside an arc the skill finishes the plan, asks for a rotation to the review stage, and ends its turn. If the verb refuses — no `TUG_SESSION_ID`, no running instance, an arc already on the card — the skill prints the `/tugplug:plan-review <path>` chip as it does today and says the review was not scheduled.

**Rationale:**
- `[B04]` retires "never switch the user's model" and `[B08]` names this the acceptance test. Keeping an "on Opus, review inline" branch would leave the primitive exercised only on the models it was written to work around.
- The reason the inline-on-Opus branch existed was that no rotation could be asked for. It is a workaround, and `[F04]` says so.
- The refusal path is real: `plan-devise` can run in a terminal claude with no Tug session at all, and a skill that assumed otherwise would strand the review.

**Implications:**
- The arc branch at the top of §5 is unchanged: under an arc the runner still rotates and the skill must not.
- `plan-review`'s "The card runs this automatically after `/tugplug:plan-devise`, on the review model" sentence becomes true in general rather than under an arc, and its §hand-off text is adjusted to match.
- `plan-devise`'s guardrail list loses "Review it on Opus, hand it over otherwise" and "Never switch the user's model, in either direction", replaced by the conductor's own rule.

#### [P12] The deck is not changed (DECIDED) {#p12-no-deck-change}

**Decision:** No file under `tugdeck/src/` is edited by this plan. New deck-side *tests* are allowed; production changes are not.

**Rationale:**
- The deck already tolerates everything the widening produces: `frameToEvent` defaults every missing `session_stage` field to `""`, `stageNoteText` omits an empty model and an empty document and accepts an arbitrary stage string, and the reducer's `handleSessionStage` opens the conductor's turn from `prompt`/`turnKey` with no arc anywhere in the path.
- Keeping the deck diff empty is the cheapest possible proof that the conductor is genuinely the same primitive the arc has been using — a widening that needed deck work would mean the arc's rotation and a bare rotation are not the same act.

**Implications:**
- If a deck change turns out to be needed, that is a finding worth surfacing rather than a task to absorb quietly: stop and say so.
- The `at0474` live-render leg is extended with a case rather than replaced.

#### [P13] A scoreless rotation is a one-stage score, and hands the card back after its turn (DECIDED) {#p13-one-shot-hand-back}

**Decision:** A rotation carrying no `score` and naming a `model` registers a **pending hand-back** against the session it rotated. On that session's next turn-end tick the conductor calls `hand_back`, restoring the deck's own model, and clears the registration. A rotation carrying a score registers nothing — the score's end is what hands back, as it does today.

**Rationale:**
- `restore_deck_model` is called from exactly two sites, both in `dash_arc_runner.rs` (`finish` and `stop`). A rotation with no score reaches neither, so without this the card stays on the stage model *permanently* — the function's own doc comment records that tugcode's manager reuses the selector on every later spawn, "including through the user's own `/new`".
- The deck is not told: `handleSessionStage` appends a divider and touches nothing else, and no `session_stage` field feeds the model selector. So the pinned card would show the user's model while running the stage's — a control at rest asserting something the session does not hold.
- `deck_model` already holds the right answer and is already written only by a WebSocket client's own `model_change` (`agent_supervisor.rs:8044`, pinned by `only_a_deck_model_change_is_remembered_for_the_restore`). Nothing new has to be remembered; the hand-back only has to be *scheduled*.
- One turn is the right window because one turn is what the client asks for: `plan-devise` hands over a single review turn, and the review's own turn end is the score's end.

**Implications:**
- The conductor's state grows a second map beside the pending-rotation registry: `PendingHandBacks`, keyed by tug session id, holding nothing but the fact. Same lifetime rules as [P06] — in memory, dropped by a tugcast restart.
- A rotation with no model registers no hand-back: nothing was changed, so there is nothing to restore.
- A second rotation arriving before the hand-back fires replaces the registration rather than stacking one; the card is handed back once, after the last stage.
- The receipt says so, so the ask is not silent about it: `TUG-ROTATION-RECEIPT: review · opus · at this turn's end · hands back after`.

---

### Deep Dives {#deep-dives}

#### What a rotation is made of today {#anatomy-of-a-rotation}

Reading the path end to end, a rotation is five things happening in a fixed order. Every one of them is load-bearing, and the extraction must preserve all five.

1. **A `model_change` frame, first** (`drive_stage`). tugcode's `handleModelChange` records the selector on the manager and *every later spawn reuses it*; a model set after the spawn would be flipped underneath a claude that had already started. A rotation declaring no model sends **no frame at all** rather than one carrying `"default"` — omitting it is what "the account default" means here.
2. **A `session_command: new` frame carrying the stage object.** tugcode's `handleNewSession(stage)` kills the current claude, mints a fresh session id, records `currentArc = stage.arc ?? null` (which is what puts or clears `TUG_DASH_ARC` on every subsequent spawn), writes the `session_stage` IPC line, then writes the synthetic `session_init`.
3. **A `user_message` frame carrying the prompt**, dispatched through `dispatch_one` so it opens a journal row and marks the turn active exactly as a typed prompt would. The prompt *also* rides the stage object, because tugcode echoes it on `session_stage` and that echo is how the deck opens the turn it is about to watch.
4. **The identity transfer**, in `agent_bridge.rs`: the `session_stage` line is parsed, `inherit_fork_identity` moves the callsign, and `set_fork_provenance(new, parent, None)` writes the lineage edge with a NULL fork point — which is what distinguishes a rotation from a rewind for every later reader.
5. **The `arc-stage` dash-log line**, also written by the bridge — because the record names claude's session id and nobody knows it until claude announces it. This is arc-only and stays arc-only: the write is already guarded on the announcement carrying an `arc` name *and* on `ArcStage::parse` succeeding, so a rotation with no score writes nothing and needs no new guard.

Step 1 moves (1)–(3). Steps (4) and (5) already live in the bridge and are already arc-tolerant; Step 4 of this plan adds the durable half of (4) that the restore path needs.

#### Where the arc keeps its own decisions {#arc-keeps-deciding}

`[B06]` splits *deciding* from *doing*. After this plan the line falls here:

- **Stays in `dash_arc.rs`:** `arc_action`, `ArcFacts`, `Rotation`, `StepLedgerFacts`, `step_range`, `context_max_from_breakdown`. Untouched.
- **Stays in `dash_arc_runner.rs`:** the sweep, `bound_arcs`, `ArcState` and its in-flight guard, `read`/`ArcReading`, `retain_done_count`, `session_snapshot`, `finish`/`stop`, `format_arc_receipt`, `format_arc_stop_receipt`, `lints_as_plan`, and the `append_arc_plan` / `append_arc_note` writes that a rotation triggers. These are all about *deciding* and *recording*.
- **Moves to the conductor:** the frame building and sending (`drive_stage`), the model restore (`restore_deck_model`), `StageSpec` → `RotationRequest`, `stage_model` (to `tugdash-core`, shared with tugutil), and `opening_prompt` (enriched per `[B09]`).

`rotate` in the runner keeps its re-read-under-guard preamble and its `in_flight_at` bookkeeping, and shrinks to: build a `RotationRequest`, call `conductor::rotate`, record what came back.

#### The two meanings of "stage", and the two meanings of "conductor" {#vocabulary-collisions}

Two words in this area already mean something else, and the doctrine has to say so or it will be misread.

- **`stage`.** `tuglaws/dash-lifecycle.md` §"The stages, and derive vs declare" uses *stage* for one of the seven derived words describing a dash (`derive_stage`). The arc's *stage* is a rotation of a session. They are unrelated. `dash-lifecycle.md` gains one sentence saying so and pointing at `conductor.md`.
- **`conductor`.** `tuglaws/ledger-reliability.md` `[LR9]` already calls Tug.app "the conductor" of the quiesce ladder, and `tugcore/src/quiesce.rs`, `ProcessManager.swift`, and `InstanceConfig.swift` echo it in prose. No symbol is named `conductor` there, so `tugcast::conductor` collides with nothing in code — but the word does. Step 6 respells those prose uses as "the shutdown conductor (Tug.app)" where they are load-bearing, and `conductor.md` names the collision so a reader of one is not surprised by the other.

The deck, meanwhile, has *already* ratified this meaning of the word: `TurnOrigin` includes `"conductor"`, `conductorPromptPending` gates a replayed opener's attribution, and the transcript labels such a row `Conductor` with its own icon and accent (landed `97f94b485`). `[B01]`'s claim that the name is unused is one commit out of date, and in the direction that supports it: the naming is already half-shipped, and this plan finishes it.

---

### Specification {#specification}

**Spec S01: `RotationRequest`** {#s01-rotation-request}

```rust
pub struct RotationRequest {
    /// The card's tug session id — the session that rotates. Not a
    /// parameter of what it rotates *to*.
    session: TugSessionId,
    /// The stage's opening prompt. Composed from documents, never a
    /// caller's sentence, when the caller is a score ([B09]).
    prompt: String,
    /// The stage label — free text; `devise` / `review` / `implement` are
    /// the arc's three, and the divider renders whatever it is given.
    stage: String,
    /// The model this stage runs on. `None` = the account default, which
    /// sends no `model_change` frame at all.
    model: Option<String>,
    /// The reasoning effort this stage runs at. `None` leaves it as it is.
    effort: Option<String>,
    /// The score driving this rotation — today a dash name, reaching
    /// tugcode as `arc` and the child as `TUG_DASH_ARC` ([P07]).
    score: Option<String>,
    /// Divider facts the arc supplies; each defaults to absent.
    document: Option<String>,
    plan: Option<String>,
    steps: Option<String>,
}
```

The invariant floor — the card, the tug session id, the transcript and its ink, the lineage chain, and the user's model to return to — is expressed by **not being here**. `session` names which card rotates; nothing in the type can address what it rotates into.

`Delivery` is `Sent` | `Queued`; `Refusal` is `UnknownSession` | `Idle` | `Errored` | `Closed` | `QueueOverflow` | `NoInputTx` | `SendFailed` | `ArcRunning`, each with the `reason()` word it is recorded and shown by. The first seven are `StageRefusal`'s, moved verbatim; `ArcRunning` is new ([P06]) with reason `"arc running"`.

**Spec S02: The opening prompt a score hands over** {#s02-opening-prompt}

`[B09]`. `conductor::prompt::compose(…)` builds the prompt from three document facts and nothing a model wrote:

1. **The ask and the document.** As today: `/tugplug:plan-devise a plan for <document>, honoring every [B##] decision it records 🢂 <target>` for devise; `/tugplug:plan-review <plan>` for review; `/tugplug:dash-implement <plan>[ Steps N-M]` for implement.
2. **Where to start.** The repo-relative paths the document's own `[F##]` findings name, as a `start there` line. Extraction rule: scan the document for backtick-delimited tokens containing `/` or ending in a known source extension, keep those that resolve to an existing file under the project root, deduplicate preserving first-seen order, and cap at 12. A document naming none contributes no line.
3. **What moved since.** `git log --oneline <last commit touching the document>..HEAD -- <those paths>`, capped at 20 lines, introduced as *what changed in those files since this document was written*. Resolved with a new `pub fn last_commit_touching(root, path) -> Option<String>` and `pub fn commits_touching_since(root, since, paths, cap) -> Vec<String>` in `tugdash-core` (which already has `git_output` / `git_stdout` helpers, currently `pub(crate)`). A git failure, an unborn HEAD, or a document git has never seen contributes no line — never an error.
4. **Where the score is.** For a resumed arc: `this arc was stopped in <stage> — <reason>; it is resuming`. Read from `ArcRecord::stopped` / `resume`, which the runner already has in hand.

Composition is a pure function over `(ask, paths, commits, arc_state)` so every clause is a table test. The impure gathering (the file existence checks, the two git reads) happens in the runner's existing `spawn_blocking` fact-gathering pass and is handed to the pure composer.

**Spec S03: `POST /api/session`** {#s03-session-api}

Request:

```json
{ "op": "rotate", "tug_session_id": "…", "project_dir": "…",
  "stage": "review", "prompt": "…",
  "model": "opus", "effort": "high" }
```

`op: "rotate_cancel"` takes `tug_session_id` only. `project_dir` passes through the `[L29]` gateway (`resolve_to_claude_form`) exactly as `apply_dash_request` does. Responses: `200 {"status":"ok","pending":true,"replaced":bool}`, `200 {"status":"ok","cancelled":bool}`, `404 {"status":"error","message":"unknown_session"}` (which the CLI's port loop reads as "not mine" and moves past), or `400`/`500` with a message. Loopback only.

**Spec S04: `tugutil session rotate`** {#s04-rotate-verb}

```
tugutil session rotate --prompt <text> [--stage <label>] [--model <selector>]
                       [--effort <level>] [--project <dir>] [--json]
tugutil session rotate --cancel [--json]
```

- `--prompt` is required (except with `--cancel`); `--stage` defaults to `rotate`.
- `--model` omitted + `--stage` in {`devise`,`review`,`implement`} → the project's declared stage model ([P05]); otherwise the account default.
- The session is `$TUG_SESSION_ID`, and its absence is the actionable refusal `calling_session_id` writes, re-subjected to name a rotation rather than a dash binding ([P03]).
- Success prints `TUG-ROTATION-RECEIPT: <stage> · <model|account default> · at this turn's end` — with ` · hands back after` appended when a model was named ([P13]) — plus the prompt's first line; `--json` prints the whole payload through `print_ok`.
- Every refusal exits 1 with `error: <reason>` on stderr.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugrust/crates/tugcast/src/conductor/mod.rs` | `RotationRequest`, `Delivery`, `Refusal`, `frames_for`, `rotate`, `hand_back`, the pending registry, `run_conductor` |
| `tugrust/crates/tugcast/src/conductor/prompt.rs` | `[B09]` opening-prompt composition ([S02]) |
| `tugrust/crates/tugutil/src/session.rs` | the `session` command group and `rotate` verb ([S04]) |
| `tuglaws/conductor.md` | the doctrine ([B07]) |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `RotationRequest` | struct | `tugcast/src/conductor/mod.rs` | replaces `StageSpec` ([S01]) |
| `Delivery` / `Refusal` | enum | `tugcast/src/conductor/mod.rs` | `StageDelivery` / `StageRefusal` moved; `Refusal::ArcRunning` added |
| `rotate` / `hand_back` | async fn | `tugcast/src/conductor/mod.rs` | bodies of `drive_stage` / `restore_deck_model` |
| `frames_for` | fn | `tugcast/src/conductor/mod.rs` | pure; the three frames in order |
| `run_conductor` | async fn | `tugcast/src/conductor/mod.rs` | drains pending rotations on the turn-end tick |
| `AgentSupervisor::drive_stage` | async fn | `tugcast/src/feeds/agent_supervisor.rs` | **deleted** |
| `AgentSupervisor::restore_deck_model` | async fn | `tugcast/src/feeds/agent_supervisor.rs` | **deleted** |
| `AgentSupervisor::conductor_tick_tx` | field | `tugcast/src/feeds/agent_supervisor.rs` | beside `arc_tick_tx` |
| `PendingFork::stage_label` / `::stage_model` | field | `tugcast/src/feeds/agent_supervisor.rs` | ([P10]) |
| `SessionLedger::set_stage_provenance` / `::stage_provenance` | fn | `tugcast/src/session_ledger.rs` | writes and reads the two new columns |
| `SessionsRecorder::stage_provenance` | trait fn | `tugcast/src/feeds/agent_supervisor.rs` | + both impls (`LedgerSessionsRecorder`, `NoopSessionsRecorder`) ([P10]) |
| `replay_lineage` | fn | `tugcast/src/feeds/agent_supervisor.rs` | reads the row, falls back to the arc record |
| `PendingHandBacks` | struct | `tugcast/src/conductor/mod.rs` | the one-shot hand-back registry ([P13]) |
| `calling_session_id` | fn | `tugutil/src/dash.rs` | gains a `subject` so the refusal names a rotation, not a dash binding ([P03]) |
| `session_handler` / `apply_session_request` | fn | `tugcast/src/server.rs` | `POST /api/session` ([S03]) |
| `stage_model` | fn | `tugdash-core/src/arc.rs` | moved from `dash_arc_runner.rs`, made `pub` ([P05]) |
| `last_commit_touching` / `commits_touching_since` | fn | `tugdash-core/src/ops.rs` | ([S02]) |
| `post_instance_api` | fn | `tugutil/src/dash.rs` | generalizes `post_dash_api`, taking the path and the subject its failure text names ([P03]) |
| `Commands::Session` | enum variant | `tugutil/src/cli.rs` | new command group ([S04]) |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit** | Pure composition — frames in order, prompt clauses, receipt wording | every step |
| **Integration (Rust)** | The real supervisor + real in-memory session ledger harness in `dash_arc_runner.rs`'s tests, counting frames landing in a session's spawn queue | Steps 1, 3, 4 |
| **Contract** | The arc's existing tests, unmodified, as the proof that only the seam moved | Step 1 |
| **Deck unit (bun)** | `stageNoteText` and the reducer over a rotation with no arc and no document | Step 2 |
| **App-test** | The live render of a divider drawn from a synthetic non-arc `session_stage` frame | Step 4 |

#### What stays out of tests {#test-non-goals}

- **An end-to-end app-test that runs `tugutil session rotate` from a real claude turn.** The brief's Exit item 5 asks for one; it would be a real-claude test, which this project runs on demand only, and its failure modes would be claude's rather than the conductor's. The same assertion is made where it is falsifiable: a Rust integration test that a request performs nothing while `turn_active` and performs the right frames on the tick ([#step-3]), plus the live-render leg for the divider ([#step-4]). This substitution is deliberate and is the one place this plan does not do exactly what the brief's Exit section describes.
- **The full app-test corpus.** Selection is derived from `@covers`; `just app-test-changed` is the run.
- **tugdeck production behavior beyond the divider.** Nothing in the deck changes ([P12]); a test asserting the deck still works would be asserting `tsc`.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Extract the conductor | done | `e5d3483aa` |
| #step-2 | Widen the wire so a rotation need not be an arc's | done | `6f811603e` |
| #step-3 | The op and the verb | done | `65247bc8e` |
| #step-4 | Durable stage provenance so a rotation restores | done | `22625308a` |
| #step-5 | Hand over a score, not a sentence | done | `db640616d` |
| #step-6 | Write the doctrine | done | `bc3a9ccd7` |
| #step-7 | plan-devise on the conductor | done | `57c8bab5b` |
| #step-8 | Integration Checkpoint | done | `4cda84c96` |

#### Step 1: Extract the conductor {#step-1}

**Commit:** `tugcast(conductor): move the rotation act out of the arc runner`

**References:** [P01] conductor module, [P02] RotationRequest, Spec S01, Risk R01, (#anatomy-of-a-rotation, #arc-keeps-deciding)

**Artifacts:**
- `tugrust/crates/tugcast/src/conductor/mod.rs` (new), registered in `tugcast/src/main.rs`'s module list beside `session_ledger`.
- `agent_supervisor.rs` shrinks by `StageSpec`, `StageDelivery`, `StageRefusal`, `drive_stage`, `restore_deck_model` and their tests.
- `dash_arc_runner.rs`'s `rotate` becomes a caller.

**Tasks:**
- [ ] Create `conductor/mod.rs` with `RotationRequest` per [S01] — private fields, `new(session, prompt, stage)`, and setters for `model`, `effort`, `score`, `document`, `plan`, `steps`. Doc-comment the invariant floor in the type's own docstring, in the brief's three categories.
- [ ] Move `StageDelivery` → `Delivery` and `StageRefusal` → `Refusal` verbatim, adding `Refusal::ArcRunning` with `reason()` `"arc running"` (used in [#step-3]).
- [ ] Add `pub fn frames_for(request: &RotationRequest) -> (Vec<Frame>, Frame)` returning the pre-prompt frames in order and the prompt frame separately — lifted from `drive_stage`'s frame-building half with no logic change. The `model_change` frame is emitted **only** when a model is named; the stage object carries `name`/`document`/`plan`/`arc`/`steps`/`prompt` in the order it does today. One shape change is forced and is the only one: `document` and `arc` are `String` on `StageSpec` and so are emitted unconditionally, while on `RotationRequest` they are `Option` and are omitted when absent. For an arc rotation both are always `Some`, so the emitted object is byte-identical — assert that rather than assuming it.
- [ ] Move `drive_stage`'s body to `pub async fn rotate(supervisor: &AgentSupervisor, request: &RotationRequest) -> Result<Delivery, Refusal>`, preserving the branch-inside-the-lock structure, the back-push order on `Spawning`, and the post-lock send on `Live`.
- [ ] Move `restore_deck_model`'s body to `pub async fn hand_back(supervisor: &AgentSupervisor, session: &TugSessionId) -> Result<(), Refusal>`.
- [ ] Update `dash_arc_runner.rs`: `rotate` builds a `RotationRequest` from the `Rotation` and `ArcReading` it already has and calls `conductor::rotate`; `finish` and `stop` call `conductor::hand_back`. Everything else in the runner is untouched.
- [ ] Move `stage_model` from `dash_arc_runner.rs` to `pub fn stage_model(config: &DashConfig, stage: ArcStage) -> Option<String>` in `tugdash-core/src/arc.rs`, and call it from the runner ([P05] needs it shared in [#step-3]).
- [ ] Relocate the `drive_stage` / `restore_deck_model` tests from `agent_supervisor.rs` into `conductor/mod.rs`, adjusting only the constructor they use.

**Tests:**
- [ ] Unit: `frames_for` on a request with a model returns three frames with `model_change` first; without a model, two.
- [ ] Unit: `frames_for` on a request built from an arc's `Rotation` emits a stage object byte-identical to the one today's `StageSpec` emits for the same facts — the guard on the `String` → `Option` change in `document` / `arc`.
- [ ] Unit: a `RotationRequest` built with only the constructor's three arguments produces the same stage object a `StageSpec` with all-`None` optionals produced — the invariant floor cannot be widened without touching this test.
- [ ] Integration: the moved `StageDelivery::Sent` / `Queued` cases and the full `SpawnState` → `Refusal` matrix, unchanged in substance.
- [ ] Contract: **every existing test in `dash_arc_runner.rs` passes with no edit**. Any test needing an edit is a behavior change and must be explained before it is made ([R01]).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast -p tugdash-core` (`stage_model` moved to `tugdash-core`, so its tests move with it)
- [ ] `cd tugrust && cargo build` (warnings are errors)
- [ ] `git diff --stat tugrust/crates/tugcast/src/feeds/dash_arc_runner.rs` shows only the call sites and the removed `stage_model`, and no change to any `#[test]`/`#[tokio::test]` body in that file.

---

#### Step 2: Widen the wire so a rotation need not be an arc's {#step-2}

**Depends on:** #step-1

**Commit:** `tugcode(conductor): let a rotation carry a free stage label, no score, and an effort`

**References:** [P02] RotationRequest, [P07] score not exposed, [P12] no deck change, (#anatomy-of-a-rotation)

**Artifacts:**
- `tugproto/src/inbound.ts` — `SessionStageSpec` widened.
- `tugcode/src/types.ts` — the outbound `SessionStage` widened to match.
- `tugcode/src/session.ts` — `newSession` records effort and omits absent fields.

**Tasks:**
- [ ] `SessionStageSpec`: `name: string` (was the three-way union); `arc?: string`; `document?: string`; add `effort?: string`. Update each field's docstring to say what it means for a rotation with no score behind it — in particular that an absent `arc` is what *clears* `TUG_DASH_ARC` on the fresh spawn.
- [ ] `SessionStage` (outbound, `tugcode/src/types.ts`): `stage: string`, `document?: string`, `arc?: string`, and note that the bridge's parser already treats every field but `parentSessionId`/`newSessionId`/`stage` as optional.
- [ ] `newSession(stage)`: set `this.currentEffort = stage.effort` **before** `spawnClaude` when the spec names one, so the level rides the single spawn instead of costing a second respawn through `handleEffortChange`. Emit `document`/`arc`/`steps` on the `session_stage` line only when present.
- [ ] Confirm — and assert — that `this.currentArc = stage?.arc ?? null` already clears `TUG_DASH_ARC` for a scoreless rotation. No change expected here; the test is the point.
- [ ] Verify no Rust change is needed in `agent_bridge.rs`: `parse_session_stage` already requires only parent/new/stage and reads `arc`/`model` as `Option`, and the `arc-stage` write is already guarded on an arc name *and* `ArcStage::parse`.

**Tests:**
- [ ] Unit (tugcode, extend `src/__tests__/session-stage-rotation.test.ts`): a stage spec with `name: "review"`, no `arc`, and no `document` emits a `session_stage` line carrying the label and omitting the absent fields, followed by `session_init`.
- [ ] Unit (tugcode): a spec carrying `effort` spawns once, with the level applied, and does not respawn.
- [ ] Unit (tugcode): a scoreless rotation spawns claude **without** `TUG_DASH_ARC` in its environment, and a scored one with it.
- [ ] Unit (Rust, `agent_bridge.rs`): `parse_session_stage` on a line with no `arc` and no `document` yields an announcement whose `arc` is `None`, and no `arc-stage` line is written for it.
- [ ] Unit (bun, `tugdeck/src/lib/code-session-store/`): `stageNoteText("review", "opus", "")` reads `review · opus`; the reducer folds a `session_stage` with no arc into a stage divider plus a conductor-origin turn.

**Checkpoint:**
- [ ] `cd tugcode && bun test`
- [ ] `cd tugdeck && bun test src/lib/code-session-store`
- [ ] `cd tugrust && cargo nextest run -p tugcast`
- [ ] `cd tugdeck && bunx tsc --noEmit`
- [ ] `git status --short tugdeck/src` lists no modified file outside `__tests__`.

---

#### Step 3: The op and the verb {#step-3}

**Depends on:** #step-1, #step-2

**Commit:** `tugcast(conductor): request a rotation from inside a turn`

**References:** [P03] session API route, [P04] turn-end placement, [P05] stage is role, [P06] one score per card, [P08] receipt shape, [P09] cancel, Spec S03, Spec S04, Risk R02

**Artifacts:**
- `conductor/mod.rs` — the pending registry and `run_conductor`.
- `tugcast/src/server.rs` — `POST /api/session`.
- `tugcast/src/main.rs` — the third tick channel and the spawned task.
- `tugutil/src/session.rs`, `tugutil/src/cli.rs`, `tugutil/src/main.rs` — the verb.

**Tasks:**
- [ ] Add `PendingRotations` to the conductor: a `Mutex<HashMap<String, RotationRequest>>` with `park` (returning whether it replaced one), `withdraw`, and `take`.
- [ ] Add `AgentSupervisor::conductor_tick_tx: OnceLock<mpsc::Sender<String>>` and send to it at the same idle-transition site that feeds `turn_complete_tx` and `arc_tick_tx`.
- [ ] Add `PendingHandBacks` beside it ([P13]): a `Mutex<HashSet<String>>` of tug session ids owed a hand-back, with `arm` / `disarm` / `take`.
- [ ] Write `run_conductor(ctx, tick_rx)`: on each tick, in this order — `take` the named session's request if any and `rotate` it, arming a hand-back when the request named a model and carried no score; otherwise `take` a hand-back owed by that session and call `conductor::hand_back`. A tick never does both, because the rotation's own turn has not ended yet. On refusal, log and drop rather than retrying — the refusal already reached the caller.
- [ ] Park always ([P04]): a request is parked whatever the entry's `turn_active` reads. There is no perform-at-request-time path.
- [ ] Add the arc-collision refusal: before parking, resolve the session's dash binding and `read_arc`; a record that is neither `done` nor `stopped` refuses with `Refusal::ArcRunning`.
- [ ] `server.rs`: `POST /api/session` per [S03], loopback-gated, `project_dir` through `resolve_to_claude_form`, ledger work on the blocking pool, `unknown_session` as a 404 so the CLI's port loop stays able to try the next instance.
- [ ] `tugutil`: generalize `post_dash_api` into `post_instance_api(path, body)`; add the `Session` command group and `rotate` verb per [S04]; resolve the model through `tugdash_core::arc::stage_model` when `--model` is absent and the label is an arc stage; print the receipt (pure `format_rotation_receipt`) or exit 1 with the refusal.
- [ ] Document the verb in `tugutil session rotate --help` text with the turn-end placement stated plainly — the help is where a model reads the contract.

**Tests:**
- [ ] Integration (Rust, the `dash_arc_runner` test harness pattern — real supervisor, real in-memory ledger, a session parked `Spawning`): a parked request puts **no** frames in the queue; a tick sent on `conductor_tick_tx` then puts exactly the rotation's frames there, with `model_change` first when a model is named. Asserted with `turn_active` both true **and** false at park time — the "no immediacy" guarantee of [P04] is the point of the second case.
- [ ] Integration ([P13]): a scoreless rotation naming a model arms a hand-back; the *next* tick sends one `model_change` carrying the entry's `deck_model` and nothing else, and a third tick sends nothing. A scoreless rotation naming no model, and a scored one, arm nothing.
- [ ] Integration: two `park` calls leave one request, and the second's receipt reports the replacement.
- [ ] Integration: `withdraw` on a parked request leaves the tick a no-op; `withdraw` with nothing parked reports "nothing pending".
- [ ] Integration: a request for a session bound to a dash with a live arc record refuses `ArcRunning` and parks nothing; the same session with a `done` arc parks normally.
- [ ] Unit: `format_rotation_receipt` for a named model, for the account default, and for a replacement.
- [ ] Unit (tugutil): `--model` absent with `--stage review` resolves the project's `review_model`; with an unknown label resolves to the account default; `--model` always wins.
- [ ] Unit (tugutil): `--cancel` with `--prompt` is a usage error.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast -p tugutil`
- [ ] `cd tugrust && cargo build`
- [ ] **Not from the card implementing this dash.** The live exercise rotates the card it is run on: run it there and the implementing session is retired mid-dash and replaced by a review of this plan. Under an arc it does not even get that far — the session is bound to a dash with a live arc, so [P06] refuses it `arc_running`, which is the wrong thing to be measuring. Do the exercise on a **second Session card**, on the same project, bound to no dash: `<worktree>/tugrust/target/debug/tugutil session rotate --stage review --prompt 'say which model you are' --json` prints a receipt, performs nothing during that turn, rotates that card at the turn's end on the project's declared review model, and hands it back at the *next* turn's end ([P13]).
- [ ] On the card running this dash, the same command is expected to fail: it exits 1 with `error: arc running`. That refusal is the assertion.

---

#### Step 4: Durable stage provenance so a rotation restores {#step-4}

**Depends on:** #step-2

**Commit:** `tugcast(conductor): record a rotation's stage on the session row so it replays`

**References:** [P10] durable stage provenance, [P12] no deck change, [B05] the transcript is an invariant, (#anatomy-of-a-rotation)

**Artifacts:**
- `session_ledger.rs` — two additive columns and `set_stage_provenance`.
- `agent_bridge.rs` — the write, beside `set_fork_provenance`.
- `agent_supervisor.rs` — `replay_lineage` reads the row.
- `tests/app-test/at0474-dash-arc-transcript.test.ts` — one new case.

**Tasks:**
- [ ] Add `stage_label TEXT` and `stage_model TEXT` to the `sessions` table, in the same idempotent `ALTER TABLE … ADD COLUMN` style the `forked_from_session_id` / `fork_point` pair uses (a duplicate-column error is the already-migrated case, not a failure). This is the per-instance `sessions.db`; `CHANGES_SCHEMA_VERSION` is not involved.
- [ ] `SessionLedger::set_stage_provenance(session_id, label, model)`, writing both columns and notifying like its siblings.
- [ ] `PendingFork` gains `stage_label` / `stage_model`; the `session_stage` branch of the bridge fills them from the announcement it already parses, and the consumption site that calls `set_fork_provenance` calls `set_stage_provenance` too when they are present.
- [ ] Add `fn stage_provenance(&self, session_id: &str) -> Option<(String, Option<String>)>` to the `SessionsRecorder` trait (`agent_supervisor.rs:532`) and implement it on **both** impls: `LedgerSessionsRecorder` delegates to the ledger, `NoopSessionsRecorder` returns `None`. `replay_lineage` takes `&dyn SessionsRecorder`, not a `SessionLedger`, so `set_stage_provenance` alone does not make the columns readable from there.
- [ ] `replay_lineage`: build each entry's `stage` / `model` from the recorder's answer; consult the arc record (via the dash binding) only for `arc` and `document`, and only when there is one. Drop the early `return None` on a missing dash binding or missing arc record — the "every entry is stage-less ⇒ no lineage" guard is what remains.
- [ ] Extend `at0474-dash-arc-transcript.test.ts` with a case injecting a `session_stage` frame carrying no `arc` and no `document`, asserting the divider renders `review · opus` and that everything above it is untouched. Update its `@covers` if the case reaches a file the header does not already declare.

**Tests:**
- [ ] Unit (Rust): a fresh ledger and a ledger opened over a pre-migration file both accept `set_stage_provenance`.
- [ ] Integration (Rust): a two-session chain with stage columns and **no** dash binding produces a two-entry lineage whose first entry carries the label and model and no `arc`.
- [ ] Integration (Rust): a three-stage arc chain produces byte-identical lineage entries to today's, including `arc` and `document` — the regression guard for the fallback.
- [ ] Integration (Rust): a chain whose entries carry no stage columns and no arc record still yields `None`.
- [ ] App-test: the new `at0474` case.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast`
- [ ] `just app-test-changed`
- [ ] `just db-inspect sessions "PRAGMA table_info(sessions)"` shows both columns (inspect a copy — never point `sqlite3` at a live ledger).

---

#### Step 5: Hand over a score, not a sentence {#step-5}

**Depends on:** #step-1

**Commit:** `tugcast(conductor): compose a stage's opening prompt from the documents`

**References:** [B09] a stage opens on a score, Spec S02, Risk R03, (#arc-keeps-deciding)

**Artifacts:**
- `conductor/prompt.rs` (new).
- `dash_arc_runner.rs` — `opening_prompt` deleted; its facts gathered in `read` and handed over.
- `tugdash-core/src/ops.rs` — two new public git readers.

**Tasks:**
- [ ] Add `pub fn last_commit_touching(root: &Path, path: &str) -> Option<String>` (`git log -1 --format=%H -- <path>`) and `pub fn commits_touching_since(root: &Path, since: &str, paths: &[String], cap: usize) -> Vec<String>` (`git log --oneline <since>..HEAD -- <paths>`) to `tugdash-core`, built on the existing `git_stdout` helper. Both are total: any failure yields `None` / an empty vector.
- [ ] Add `pub fn cited_paths(document_source: &str, project_root: &Path, cap: usize) -> Vec<String>` — the extraction rule of [S02], pure over the source plus a filesystem existence check.
- [ ] Write `conductor::prompt::compose(ask: &str, paths: &[String], commits: &[String], resume: Option<(&str, &str)>) -> String` — pure, assembling the ask, the `start there` line, the `what changed since` block, and the resume clause, each omitted when empty.
- [ ] Move the three per-stage `ask` strings out of `dash_arc_runner::opening_prompt` into `conductor::prompt::stage_ask(stage, document, target, plan, steps)`, unchanged in wording.
- [ ] In `dash_arc_runner::read`, gather the document source, its cited paths, its last commit, and the commits since — all inside the existing `spawn_blocking` pass — and carry them on `ArcReading`. `rotate` passes them to `compose` and puts the result on the `RotationRequest`.

**Tests:**
- [ ] Unit: `compose` with all four clauses; with no paths; with no commits; with a resume; with none of them (byte-identical to today's bare ask — the regression guard).
- [ ] Unit: `cited_paths` finds backticked repo paths, ignores backticked prose and non-existent paths, deduplicates, and respects the cap.
- [ ] Integration (Rust, a real temp git repo): `last_commit_touching` + `commits_touching_since` over a document and a file changed after it; an unborn HEAD and an untracked document both yield nothing rather than an error.
- [ ] Integration: the devise rotation's prompt for a project whose brief cites two real files names both of them.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast -p tugdash-core`
- [ ] `cd tugrust && cargo build`

---

#### Step 6: Write the doctrine {#step-6}

**Depends on:** #step-3, #step-5

**Commit:** `tuglaws(conductor): name the layer that seats a session`

**References:** [B01] the name, [B02] the verbs, [B05] the three kinds of carried thing, [B07] three faces, [P07] score not exposed, (#vocabulary-collisions)

**Artifacts:**
- `tuglaws/conductor.md` (new), `tuglaws/INDEX.md`, `tuglaws/dash-lifecycle.md`, `tuglaws/ledger-reliability.md`.

**Tasks:**
- [ ] Write `tuglaws/conductor.md`: what the conductor is and why it is called that; the three verbs it has and no others (*seats*, *rotates*, *holds the lineage*); the three kinds of carried thing — invariants, parameters, always-dropped — as the load-bearing section; the turn-end placement and why a mid-turn rotation is never possible — including that there is no perform-at-request-time path and why ([P04]); how a score ends and hands the card back, and that a scoreless rotation is a one-stage score for exactly that reason ([P13]); the three faces (op, verb, doctrine) and where each lives; how a score hands over a part rather than a title ([S02]); and the two collisions of [#vocabulary-collisions], including that the score parameter has no CLI flag yet and why ([P07]).
- [ ] Register it in `tuglaws/INDEX.md` under a heading where a reader looking for session machinery will find it, with the one-line summary the file's siblings use.
- [ ] `tuglaws/dash-lifecycle.md`: add a short "Arcs and stages" note saying that the arc is the dash's score, that a *stage* there is a rotation and not one of the seven derived dash stages, and pointing at `conductor.md` for what a rotation is. Add it to the See also list.
- [ ] `tuglaws/ledger-reliability.md` `[LR9]`: respell "The conductor (Tug.app)" as "The shutdown conductor (Tug.app)" so the two senses are distinguishable in the one place the word is load-bearing prose.
- [ ] No prose in any of these files hard-wraps.

**Tests:**
- [ ] None of its own — this step is prose. Its checkpoint is the reading, and the assertions below are mechanical.

**Checkpoint:**
- [ ] `grep -n "conductor.md" tuglaws/INDEX.md tuglaws/dash-lifecycle.md` finds the registration and the cross-reference.
- [ ] `tuglaws/conductor.md` states all three kinds of carried thing from [B05] and names the turn-end rule; read it once against the brief's [B01]–[B09] and confirm each decision is either stated or deliberately out of scope.

---

#### Step 7: plan-devise on the conductor {#step-7}

**Depends on:** #step-3, #step-6

**Commit:** `tugplug(conductor): hand the review to the conductor instead of to a chip`

**References:** [B04] a skill may choose the model, [B08] the first non-arc score, [P05] stage is role, [P11] no model fork, Spec S04

**Artifacts:**
- `tugplug/skills/plan-devise/SKILL.md` §5 and its Guardrails.
- `tugplug/skills/plan-review/SKILL.md` §hand-off text.

**Tasks:**
- [ ] Rewrite `plan-devise` §5's non-arc half: finish the plan, then ask for the review with `tugutil session rotate --stage review --prompt "/tugplug:plan-review <path>"`, report that the review will open on the project's declared review model at this turn's end, and end the turn. Delete the Opus/non-Opus fork entirely.
- [ ] Add the refusal fallback: a non-zero exit means the review was not scheduled — say so plainly and print the `/tugplug:plan-review <path>` chip as the next gesture, exactly as the current non-Opus branch does.
- [ ] Rewrite §5's closing paragraph too — *"Reviewing is the one exception, and only on Opus: there the review is the same turn's second half…"* is the same fork stated a second time, and deleting only the branch would leave the prose asserting a fork that no longer exists.
- [ ] Leave the arc branch at the top of §5 untouched — including its *"Do not review it, on any model, including Opus"* line, which stays true and is why the Opus grep below is scoped rather than absolute.
- [ ] Re-word the guardrail list: drop "Review it on Opus, hand it over otherwise" and "Never switch the user's model, in either direction"; add that a skill may name the model for the stage it asks for, and that the conductor hands the card back to the user's own model at the end of the stage's turn ([P13]) — which is true of a one-shot rotation as well as of an arc.
- [ ] `plan-review`: its opening sentence already promises "The card runs this automatically after `/tugplug:plan-devise`, on the review model" — adjust its §hand-off so the non-arc ending matches what actually happens now, and keep the arc rule as it is.
- [ ] Rebuild Tug.app so the bundled plugin carries the new text (`tugplug/` runs from the app bundle, never from the repo).

**Tests:**
- [ ] None automated: the artifacts are skill prose, and the behavior they drive is a live turn. The falsifiable check is the checkpoint below.

**Checkpoint:**
- [ ] `grep -n "Opus" tugplug/skills/plan-devise/SKILL.md` returns **exactly one** line: the arc branch's "Do not review it, on any model, including Opus." Every other mention — the review-inline branch, the "only on Opus" closing sentence, and the guardrail — is gone.
- [ ] On a rebuilt Tug.app, run `/tugplug:plan-devise` on a small throwaway idea outside an arc: the turn ends with a rotation receipt, the card rotates to the review model, and `/tugplug:plan-review` opens as its own visible turn with nobody clicking anything. When the review's turn ends, the card is back on the model the user was on ([P13]).
- [ ] The same run with `TUG_SESSION_ID` unset (a terminal claude) prints the chip and says the review was not scheduled.

---

#### Step 8: Integration Checkpoint {#step-8}

**Depends on:** #step-4, #step-5, #step-7

**Commit:** `conductor: integration checkpoint`

**References:** [P01] conductor module, [P11] no model fork, [P12] no deck change, (#success-criteria)

**Tasks:**
- [ ] `tugutil dash replay conductor` — put the rounds on the live base, so what gets verified is what would land.
- [ ] `Replayed` / `Recorded`: verify the replayed tree with the project's declared verify command (`tugutil dash config --json` reports it; this repo declares `sh scripts/verify-fit.sh {base} {head}`), substituting `{base}`/`{head}` with the replayed range.
- [ ] `Current`: the base never moved, so the last step's checkpoint already verified these exact bytes — re-run nothing and say so.
- [ ] `Conflicted`: resolve the named round in the warm worktree, then verify as above.

**Tests:**
- [ ] None of its own. This step re-proves nothing the steps proved; it establishes that their work still holds on the base as it stands now.

**Checkpoint:**
- [ ] The replay reports its outcome, and the scoped verification is green **or** was correctly skipped as `Current`.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** The conductor — a named, tested, documented session-rotation primitive in tugcast, reachable from a tugcast op and a `tugutil session rotate` verb, with the dash arc and `plan-devise` as its first two clients.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] The rotation act lives in `tugcast/src/conductor/` and the arc calls it (Rust tests, Step 1).
- [ ] Every arc test that existed before this plan passes unmodified (contract check, Step 1).
- [ ] A rotation is expressible with a free stage label, no score, and an effort (tugcode + Rust tests, Step 2).
- [ ] A rotation asked for mid-turn happens at that turn's end and never before (Rust integration test, Step 3).
- [ ] A rotation asked for on a card already running an arc is refused with a named reason (Rust test, Step 3).
- [ ] A pending rotation can be withdrawn and can be superseded (Rust tests, Step 3).
- [ ] A scoreless rotation onto a named model hands the card back one turn later (Rust test, Step 3).
- [ ] A card rotated with no arc behind it replays as one scroll after a relaunch (Rust test, Step 4).
- [ ] A stage's opening prompt names where to start and what moved since the document was written (unit + integration tests, Step 5).
- [ ] `tuglaws/conductor.md` exists, is indexed, and states the invariant floor and the turn-end rule (prose assertion, Step 6).
- [ ] `plan-devise` carries its own review hand-off with no model fork and no click (live run, Step 7).

**Acceptance tests:**
- [ ] Rust: a `RotationRequest` cannot be built without the invariant floor (Step 1).
- [ ] Rust: request → no frames while the turn is open → the rotation's frames on the tick, on the named model (Step 3).
- [ ] App-test: a `session_stage` with no arc and no document draws a divider and leaves the transcript above it untouched (Step 4).

#### Follow-ons (Explicitly Not Required for Phase Close) {#follow-ons}

- [ ] A CLI flag for the score, and the `TUG_DASH_ARC` → general-score rename it implies ([P07]).
- [ ] A deck affordance showing a pending rotation before the turn ends ([P08] settled against for now).
- [ ] The interruption-doctrine brief, which this phase's boundary is the prerequisite for.

| Checkpoint | Verification |
|------------|--------------|
| The seam moved and nothing else | Step 1: arc tests unmodified and green |
| A rotation needs no arc | Step 2: tugcode + bridge tests |
| The verb lands at the turn's end | Step 3: Rust integration test |
| The transcript is an invariant | Step 4: `replay_lineage` tests + `at0474` |
| A stage opens on a score | Step 5: `compose` table tests |
| The primitive is documented | Step 6: `conductor.md` + INDEX |
| The first non-arc score works | Step 7: live `plan-devise` run |
