## Dash Integration — One-Gesture Planning {#one-gesture-planning}

**Purpose:** Collapse the `devise` → `vet` → "do the fixups" round trip into a single gesture: after `devise` writes a plan, the card borrows Opus, runs the review as a visible turn in the same session, and gives the user's model back — and `/tugplug:vet` is retired.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main (runs as a dash) |
| Program plan | [dash-integration-plan.md](dash-integration-plan.md) §[Phase 2.1](dash-integration-plan.md#phase-2-1), its [P07 (devise absorbs vet)](dash-integration-plan.md#p07-devise-absorbs-vet) — that document's label namespace, distinct from this plan's |
| Last updated | 2026-08-14 |

---

### Review Record {#review-record}

**Round 1 — 2026-08-14, opus (post-implementation audit).** This plan built the review gesture and shipped before running it on itself; the record is therefore an audit of the merged tree (`eb5953baa`) rather than a pre-implementation review. Lint: 0 errors, 1 warning (PL023, now satisfied by this section).

Applied — two findings under the holes-and-failure-modes axis, both real, both fixed:

- **The park's "user moved on" guard was one-sided.** It abandoned only on a non-empty `queuedSends`, but a turn submitted from a *settled* session sends straight out instead of queueing, so a user turn could start with `queuedSends` empty and the review would ride in behind it, uncautioned. The park now also treats an unsettled beat that follows a settled one it did not act on as somebody else's turn. `canSubmit` being phase **and** transport is what makes that precise — a settled beat reaches a park unacted-on exactly when the wire is down — so reconnecting still submits and only a real turn abandons.
- **The release fired into a running turn.** `CodeSessionStore.setModel` carries no `canSubmit` gate of its own (the gate lives in `useModel`, which the borrow deliberately bypasses), so an unmount mid-review put a `model_change` on the wire mid-flight and rested on claude honoring it there — unverified, and if it does not, the live session keeps the borrowed model. `dispose` now defers the release to the turn's settle, on a one-shot subscription detached from the controller so it can outlive the card. The borrow registration is held until that release actually fires, so a remount's mount-restore stands down instead of racing it.

Also applied: **PL024**, a plan-level error when no step in a plan carries a Tests block. PL011 has to stay a warning for the integration-checkpoint shape, but PL020 can only inspect Tests blocks that exist — so a per-step warning alone made *no* test planning cheaper than wrong test planning. The rule that cannot be satisfied by omission is the plan-level one. The parser also learned `~~~` fences, so a plan whose sample markdown contains a backtick fence can still hide it.

Deferred: nothing raised as an Open Question. Two items were considered and rejected rather than deferred — narrowing `read_label`'s bracket form (the `**[T01] …` bold declaration is used across the real corpus, so the change would break valid plans), and giving the park a timeout (the park settles off session snapshots by design; a timer would be the first one in this machine, and "the user came back an hour later" is a review still worth running).

---

### Phase Overview {#phase-overview}

#### Context {#context}

The plan lifecycle today is `idea → brief → /tugplug:devise → /tugplug:vet → "do the fixups" → /tugplug:implement`. The fourth and fifth beats are a seam, not a safeguard. `tugplug/skills/vet/SKILL.md` is `disallowed-tools: Task, Write, Edit` — read-only *by construction* — so the only thing it can do with what it finds is hand it back, and the answer has been invariably "do the fixups". Nothing was protected by the split: the reviewer and the author were the same conversation on the same model, so the second pass bought a round trip and no independence.

Two requirements shape the merge. The review must run on **Opus regardless of the model that devised the plan**, and — since fixups are where judgment actually lands — the fixups must run there too. And the review must be **visible while it happens**: a plan review is minutes of reading and editing, and work that disappears for minutes is exactly what this product exists to prevent.

A headless subprocess was considered and rejected. It satisfies the model requirement and fails the visibility one: a foreground `Bash` call renders as a running tool block with nothing in it, because `tugcode/src/session.ts:1970` deliberately swallows the entire `tool_progress` family (`bash_progress` carries `elapsed_time_seconds` and no output — "nothing to render in the Session card"). Backgrounding it and polling `TaskOutput` would put the review in the JOBS cell but leave the reasoning itself off-transcript. Neither is what a review should look like here.

The mechanism that satisfies both is already shipped, in two halves. `set_model` is a **live control request to the running claude** — `SessionManager.handleModelChange` records the selector and sends `{subtype: "set_model", model}` down the existing process (`tugcode/src/session.ts:7071`), no respawn, no session loss, pinned by `tugcode/src/__tests__/model-respawn.test.ts`. And the card already submits skill-invoking turns on the user's behalf: `/join` does exactly this in `session-card.tsx` — `buildCommandSubmission("tugplug:join", args)` (from `tugdeck/src/lib/slash-commands.ts:367`) followed by `codeSessionStore.send(submission.text, submission.atoms)`, forwarded as a leading `command` atom so claude expands it as a **user** invocation, which is the path that clears a skill's `disable-model-invocation` guard.

So the review becomes a second turn in the same session, on Opus, driven by the card — with full tool blocks, streaming as it goes. And because the model was borrowed rather than chosen, it has to be given back.

Program-plan phases 1 and 2 are merged to `main` (`a4477d50b`, `b53bdd718`). This phase touches none of that machinery. It precedes phase 3 because phase 3 rewrites the skill roster and would otherwise rewrite a skill this phase deletes, and because phase 3's `dash step` verbs need the Step Status Ledger grammar built here.

#### Strategy {#strategy}

- **Make the review a turn, not a process.** Everything the reviewer does is transcript ink: Read blocks, Grep blocks, Edit blocks rewriting the plan.
- **Borrow the model; never spend the user's setting.** The card swaps the live model for the review turn and swaps it back, and does it on a path that **never touches per-card persistence** — which makes crash recovery free ([P02](#p02-borrow-never-persists)).
- **Split vetting by what each half is good at.** Mechanical conformance becomes `tugutil plan lint`; judgment stays with the model. Same reasoning the program plan applies to `dash step` in its [P04 (step verbs)](dash-integration-plan.md#p04-step-verbs).
- **Let the skill say when it is ready, over the server.** `devise` signals plan-ready through a `tugutil` verb that the running tugcast broadcasts, so the hand-off does not depend on how the user spelled the invocation ([P04](#p04-server-signal)).
- **Promote the rubric to doctrine** so the reviewer, `audit`, and a human all read one copy.
- **Build bottom-up:** linter → rubric → signal → borrow machinery → card wiring → skills → an end-to-end run.

#### Success Criteria (Measurable) {#success-criteria}

- `tugutil plan lint dash/dash-integration-2-visibility.md` exits 0; `tugutil plan lint dash/dash-notes.md` exits 2 with `not a plan document`.
- `tugutil plan lint dash/dash-integration-2.1-one-gesture.md` exits 0 — the checker passes the plan that specifies it.
- Every seeded violation in [Table T01](#t01-lint-rules) is reported by a unit test with the right code, severity, and line.
- A `plan_review_request` frame that arrives **while the devise turn is still in flight** on a card whose session is on `sonnet` produces: the request parked, then — once that turn settles — the model chip reading Opus, a submitted turn carrying the `tugplug:review-plan` command atom with the plan path as its tail ([P10](#p10-submission-is-an-atom)), and — on *that* turn's settle — the chip back on Sonnet (app-test).
- **`GET /api/defaults/dev.model/<cardId>` is byte-identical before the request and after the restore** — the borrow never wrote the user's remembered selector (app-test).
- A card already resolving to Opus performs **no** `model_change` in either direction ([P03](#p03-compare-resolved-ids)) — asserted at the store layer.
- An interrupted review turn restores the model exactly as a completed one does (store-layer test).
- One real end-to-end run: `/tugplug:devise` on a Sonnet card produces a reviewed, revised plan with a Review Record, with every reviewer action visible in the transcript, and the card back on Sonnet.
- `grep -rn "tugplug:vet" tugplug/ tuglaws/ CLAUDE.md` returns only the deprecation stub.
- `cargo nextest run` green with zero warnings; `bun test` green; `bunx vite build` clean; `just app-test-changed` green.

#### Scope {#scope}

1. `tugutil-core::plan` — devise-skeleton parse, ledger grammar, lint rules.
2. `tugutil plan lint` — the CLI verb, envelope, exit codes.
3. `tuglaws/plan-review-rubric.md` + its `INDEX.md` entry.
4. `tugutil plan review-request` → `POST /api/plan-review` → a broadcast frame the card receives.
5. The non-persisting model borrow/release path and the pure `plan-review-controller` state machine.
6. Card wiring: controller mount, turn submission, the announcement, the restore on every terminal outcome.
7. `review-plan` skill; `devise` rewritten; `vet` retired to a stub; skeleton v5 with the Review Record.
8. App-tests and the end-to-end run.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **A headless reviewer subprocess.** Rejected on visibility grounds — see [#context](#context).
- **SharedAgent.** `tugcast/src/shared_agent.rs:904` spawns its workers with `--disallowedTools '*'`, `MAX_THINKING_TOKENS=0`, `--strict-mcp-config`, and a neutral empty cwd, in 2 s / 6 s latency lanes with warm-pooled workers recycled every 40 turns. A reviewer is the inverse of all of it — it must read the repo, think, and edit for minutes — and would hold a `max_workers` slot the classify lane depends on.
- **Changing `audit`.** It stays the read-only post-implementation pass with its own verdict; it only gains a rubric citation and loses its "counterpart to `/tugplug:vet`" phrasing.
- **Skill renames** (`dash-implement`, `dash-run`, …) and **`dash step` verbs** — program-plan phase 3.
- **Wiring lint into `implement`/`dash`** — see [Q02](#q02-lint-as-a-gate).
- **Effort borrowing.** Effort has no live control subtype (it respawns); only the model is borrowed.

#### Dependencies / Prerequisites {#dependencies}

- Program-plan phases 1 and 2, merged (`a4477d50b`, `b53bdd718`).
- A running tugcast instance for the `devise` → card signal ([P04](#p04-server-signal)). The skill degrades to printing the command when none is reachable.
- The live model catalog (`tugdeck/src/lib/model-catalog.ts`) — the borrow resolves selectors through it and never against a hardcoded list.

#### Constraints {#constraints}

- **`setModel` in `tugdeck/src/lib/use-model.ts` persists.** It calls `writePersistedModel(cardId, selector)` → a `PUT /api/defaults/dev.model/<cardId>` ([D07]). The borrow must not go through it ([P02](#p02-borrow-never-persists)).
- **Model changes are gated on `canSubmit`.** `useModel`'s `setModel` declines while a turn is in flight unless `fromRestore` is set. Borrow and restore both happen *between* turns, so they never fight the gate — which is exactly why a request arriving mid-turn parks instead of acting ([P11](#p11-request-parks)). The controller must never assume it can swap mid-turn.
- **`applyModel` moves a value `useModel`'s mount-restore effect depends on.** Any borrow re-runs that effect; it must be suppressed for the borrow's duration or it will revert and persist ([#step-5](#step-5)).
- **Persistent state goes through tugbank**, never Web storage.
- **Warnings are errors** (`tugrust/.cargo/config.toml` sets `-D warnings`).
- **The debug app loads the prod rollup bundle** — `bunx vite build` before declaring a tugdeck change done.
- **App-tests never rebuild the binary.** A Rust change needs `just build-app` first.
- **`bun`, never `npm`.**

#### Assumptions {#assumptions}

- Auto-submitting the review turn is wanted behavior, not a surprise: it is what "one gesture" means. It is announced before it happens and interruptible like any turn ([P09](#p09-unconditional-but-interruptible)).
- An Opus review on every devise run is an acceptable cost; it replaces a `/vet` invocation plus a fixup round that were already being paid for.
- Plans are small enough to review whole (the largest in `dash/` is under 600 lines).

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

Anchors are explicit (`{#kebab-case}`), plan-local decisions are `[P01]` (never `[D01]` — that prefix belongs to `tuglaws/design-decisions.md`), and every execution step carries `**Commit:**`, `**References:**`, Tasks, Tests, and a Checkpoint, with `**Depends on:**` citing step anchors. This plan must lint clean under the checker it builds.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] What happens to the borrow if the card is closed or the app quits mid-review? (RESOLVED — see [P02]) {#q01-crash-recovery}

**Question:** The live session is on Opus and the controller never gets to restore. What does the user come back to?

**Why it matters:** A borrowed model that outlives the borrow is a durable lie about what the card is running — precisely the failure the "no resting lies" rule names.

**Resolution:** DECIDED by [P02](#p02-borrow-never-persists). Because the borrow never writes `dev.model/<cardId>`, the *persisted* selector remains the user's own throughout. On the next mount, `useModel`'s existing mount-restore effect compares the seed against the session's current selector and re-applies the seed when they differ — so a crashed borrow is repaired by machinery that already ships, with no recovery code of our own. This is the main reason the borrow must not persist.

**Residual, stated rather than fixed:** the mount-restore only runs when a seed exists — `use-model.ts` returns early on `seedModel === null`. A card with nothing persisted of its own *and* no deck-wide default has no seed, so a process death mid-review leaves that session resting on the review model until the user picks something. We accept it here rather than seeding on borrow (which would write the very key [P02] exists to keep untouched): the repair is one pick, the window is a crash window, and a card that has never expressed a model preference has no remembered value to lie about. Revisit if it is ever observed in practice.

#### [Q02] Should `implement` and `dash` refuse to walk a plan that fails `plan lint`? (DEFERRED) {#q02-lint-as-a-gate}

**Question:** Should `/tugplug:implement` lint before walking, and stop on error-severity diagnostics?

**Why it matters:** It would catch a hand-mangled ledger before a step walk builds on it — and would also break every pre-existing plan at the moment someone wants to build.

**Plan to resolve:** Defer to program-plan phase 3, which rewrites `implement` anyway and adds the `dash step` verbs sharing this parser. The corpus calibration in [#step-1](#step-1) supplies the missing input: how much of the real corpus lints clean.

**Resolution:** DEFERRED to [dash-integration-plan.md#phase-3](dash-integration-plan.md#phase-3).

#### [Q03] Should the review turn be skippable for a trivial plan? (DEFERRED) {#q03-skip-for-trivial}

**Question:** A three-step plan may not merit a full Opus review.

**Why it matters:** Cost, and the risk that an always-on ceremony gets ignored.

**Plan to resolve:** Ship unconditional ([P09](#p09-unconditional-but-interruptible)) and watch. A skip heuristic is a policy question that needs real usage data, and an escape hatch added early would recreate the seam this phase exists to remove. Interrupting the turn is the manual skip.

**Resolution:** DEFERRED — revisit after a few weeks of real runs.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| The borrow clobbers the user's remembered model | high | low | borrow/release never call `writePersistedModel`; an app-test asserts `dev.model/<cardId>` is byte-identical across a full cycle | any report of a card waking on the wrong model |
| The restore never fires (error, interrupt, unmount) | med | med | restore is driven by turn **settle**, not turn success; the controller restores on interrupt and on unmount; [Q01](#q01-crash-recovery) covers the process-death case for free | a card observed resting on Opus after a review |
| An unsupervised turn edits the plan badly | med | low | every edit is a git diff — on the dash worktree when the card is bound to a dash, on `main`'s working tree when it is not; the Review Record makes each fixup legible; the turn is interruptible | a reviewer edit the user would not have accepted |
| The borrow is reverted mid-review by `useModel`'s mount-restore | high | low | the borrow and the restore effect are made mutually exclusive in [#step-5](#step-5) and pinned by a test — the interaction is real, since `applyModel` moves a value the effect depends on ([P02](#p02-borrow-never-persists)) | a chip observed flipping back before the review turn ends |
| Opus unavailable on the account | low | low | the review selector is resolved through the live catalog; unresolvable → no borrow, review runs on the current model, and the card says so once | account-tier feedback |
| The linter is stricter than the real corpus | med | med | severities split; calibrated against every plan in `dash/` in [#step-1](#step-1); only errors gate | a plan that is fine but cannot pass |
| Auto-submitted turns feel like loss of control | med | med | announced before submission, interruptible, and the borrow releases on interrupt ([P09](#p09-unconditional-but-interruptible)) | first "why did it just do that" |

**Risk R01: The merged review becomes theater** {#r01-review-theater}

- **Risk:** The review round degrades into a formality that always says "looks good", and plan quality drops below what the two-step produced.
- **Mitigation:**
  - It runs on Opus regardless of the devising model ([P01](#p01-review-is-a-turn)).
  - It is a fresh turn with the plan re-read from disk, not the author's working memory.
  - The Review Record is written into the plan, so a vacuous round is visible in the artifact rather than invisible in a transcript.
  - Every reviewer action is on-transcript, so a shallow pass is watchable in real time — the property the subprocess design would have destroyed.
- **Residual risk:** A weak review still produces a clean-looking record. Re-invoking `review-plan` by hand from a fresh session remains the escape hatch, and is strictly stronger than the old `/vet` because it can act on what it finds.

**Risk R02: Two turns where there was one** {#r02-two-turns}

- **Risk:** The transcript now carries an assistant turn the user did not type, which complicates rewind, fork, and "what did I ask for" reading.
- **Mitigation:** The submission is a normal user-invoked command turn — the same shape `/join` already produces — so rewind and fork treat it like any other. Its text names exactly what it is: `/tugplug:review-plan <path>`.
- **Residual risk:** A rewind past the review turn leaves a plan already revised on disk. The Review Record is what makes that legible.

---

### Design Decisions {#design-decisions}

#### [P01] The review is a turn in the same session, on a borrowed model (DECIDED) {#p01-review-is-a-turn}

**Decision:** After `devise` finishes, the card sets the session's model to the review model, submits `/tugplug:review-plan <path>` as a turn, and restores the previous model when that turn settles.

**Rationale:**
- It satisfies both requirements at once. The whole turn is Opus, so vetting *and* fixups are — which a report-only reviewer could not deliver, since the edits would have been transcribed by whatever model was driving the session.
- Every reviewer action is transcript ink: Read, Grep, and Edit blocks streaming as they happen. A subprocess would have been invisible, because `tool_progress` is swallowed (`tugcode/src/session.ts:1970`) and carries no output anyway.
- Both halves are shipped machinery: `set_model` is live (`session.ts:7071`, no respawn), and the card already submits skill turns (`session-card.tsx`, `buildCommandSubmission`).
- It stays agentless. No `Task`, no sub-agent, no swarm — one session, two turns.

**Implications:**
- The review must be its own skill so a turn can invoke it ([P05](#p05-review-plan-skill)).
- The borrow needs a release path on every terminal outcome, not just success.

#### [P02] The borrow is live-only and never persists (DECIDED) {#p02-borrow-never-persists}

**Decision:** Borrow and release send `model_change` and update the optimistic chip value, and **never** call `writePersistedModel`. The card's `dev.model/<cardId>` tugbank entry is untouched by the whole cycle.

**Rationale:**
- `useModel`'s `setModel` persists by design ([D07]) — that is right for a user's pick and wrong for a loan. Borrowing through it would write `opus` into the card's remembered selector, and a crash mid-review would make that lie durable.
- Not persisting makes crash recovery free ([Q01](#q01-crash-recovery)): the persisted selector stays correct, so the existing mount-restore effect in `use-model.ts` realigns the live session on the next mount. No recovery code of our own, and no new failure mode.
- `CodeSessionStore.setModel` already sends the frame without persisting — persistence lives in the hook, not the store — so the non-persisting path is a composition of what exists, not a new mechanism.

**Implications:**
- `borrowModel` / `releaseModel` are named exports with the no-persistence property stated at the definition and pinned by a test, so a later refactor cannot quietly route them through `setModel`.
- The chip reflects the borrow (`sessionMetadataStore.applyModel`) — the user sees Opus while Opus is running. A settled control shows what the session actually holds.

#### [P03] "If different" is decided on the resolved catalog row (DECIDED) {#p03-compare-resolved-ids}

**Decision:** Before borrowing, resolve both the session's current selector and the review selector against the live catalog. If they land on the same catalog row, do nothing — no borrow, no restore, no frames.

**Rationale:**
- Selector spellings and models are not one-to-one. A Max account on `default` may already be running Opus; comparing the strings `default` and `opus` would report a difference that does not exist and flicker the chip through two pointless control requests.
- The catalog is the existing authority for this: `resolveModelSelector` (`model.ts`) resolves a spelling to its row through `resolveCatalogSelector` and returns that row's **selector** (`row.value`), across releases where claude respelled it — the same resolution that keeps a remembered pick working.
- Row identity, not model id, is what the deck actually holds: `modelIdToSelector` deliberately collapses a row whose description matches `default`'s onto `"default"` (`model-picker-data.ts`), which is precisely the mechanism that detects "this account's `default` already *is* Opus". Comparing ids would defeat it.

**Implications:**
- The captured value for the restore is the **selector** (`sonnet`, `default`, …), not the resolved id — that is what `model_change` carries and what `handleModelChange` records (`"default"` records as `null`, the honest absence of a `--model` flag).
- Unresolvable review selector → no borrow, and the review runs on the current model with a one-time notice.

#### [P04] `devise` signals readiness through the server, not the composer (DECIDED) {#p04-server-signal}

**Decision:** `devise` ends by running `tugutil plan review-request --plan <abs-path>`, which `POST`s to the running tugcast, which broadcasts a `plan_review_request` frame. The deck receives it the way it receives every server broadcast — a `registerAction` handler in `action-dispatch.ts` that walks `cardIdForSession` and writes into a store — and the card's controller subscribes to that store ([P11](#p11-request-parks)).

**Rationale:**
- It is invocation-spelling agnostic. A local slash verb in `session-card.tsx` (the `/join` shape) would only catch `/devise`; a user typing `/tugplug:devise`, or `devise` reached any other way, would silently skip the review. The signal has to come from the skill, which knows it finished, not from the composer, which knows how it started.
- It carries the plan path exactly, with no parsing of transcript content and no guessing.
- It is the shipped pattern: `tugutil draft set` already `POST`s to `/api/draft` with port discovery via `resolve_port_any` (`tugutil/src/commands/tell.rs`), and phase 2 established that a `POST /api/dash` must broadcast so the deck repaints.

**Implications:**
- New HTTP route and broadcast frame; no new deck→tugcode inbound message, so the tugcode inbound allowlist is untouched.
- The deck side is a `registerAction("plan_review_request", …)` beside `bind_dash_ok` / `bind_dash_err`, plus a new latching `plan-review-request-store.ts` — **not** a subscription taken out by the card. Broadcast handlers are registered app-wide at dispatch setup, and the card reads the store; that is the shipped shape (`bind_dash_ok` → `cardSessionBindingStore`, `bind_dash_err` → `dashBindErrorStore`), and it is also what lets a request that arrives before the controller exists survive to be seen ([P11](#p11-request-parks)).
- No reachable tugcast → the verb fails actionably and `devise` prints the review command for the user to run by hand. The gesture degrades to the old two-step rather than silently skipping the review.

#### [P05] The review is its own skill, `review-plan` (DECIDED) {#p05-review-plan-skill}

**Decision:** `tugplug/skills/review-plan/SKILL.md` is a new skill: read the plan, run `tugutil plan lint`, apply the rubric against the real code, **edit the plan in place**, append the Review Record. The card invokes it automatically after devise; the user may invoke it by hand on any plan.

**Rationale:**
- A turn can only invoke a skill, so the review has to be one.
- It is also the re-entry path for hand-written plans, plans edited after devising, and plans devised before this phase — one rubric, one code path, two entrances.
- `/vet` goes away in the sense that matters: the user never types it. What replaces it is not read-only, which is the whole point.

**Implications:** `vet` becomes a one-release stub pointing at `review-plan` ([#step-7](#step-7)), removed in program-plan phase 5. Skills ship inside `Tug.app/Contents/Resources/tugplug` (the Xcode copy phase does `rm -rf` then `cp -R`), so a deletion propagates on the next build; what the stub protects is typed muscle memory and the `/tugplug:vet …` chips left clickable in existing transcripts.

#### [P06] Mechanical conformance is a linter; judgment is the model (DECIDED) {#p06-lint-vs-judgment}

**Decision:** Section order, anchor uniqueness, label discipline, step field presence, `Depends on:` resolution, ledger integrity, and banned test shapes are checked by `tugutil plan lint`. Design soundness, sequencing, technical choice, and tuglaws adherence are the reviewer's.

**Rationale:**
- A deterministic check that always runs beats a rule a model must remember on every pass — the reasoning the program plan applies to `dash step` in its [P04 (step verbs)](dash-integration-plan.md#p04-step-verbs).
- It spends the Opus turn's attention on the part only a model can do.
- The parse is needed anyway for phase 3's ledger-editing verbs: machinery built one phase early and used twice.

**Implications:** The parser lives in `tugutil-core::plan`, not a new `tugplan-core` crate — `tugutil-core` already owns plan resolution (`src/resolve.rs`, `config.rs::find_tugplans`), and `tugdash-core` already depends on it, so phase 3 reaches the ledger grammar with no dependency inversion. No markdown crate enters the workspace; the skeleton grammar is line-oriented and the scanner is hand-rolled.

#### [P07] The rubric is doctrine in `tuglaws/`, and its absence is not fatal (DECIDED) {#p07-rubric-doctrine}

**Decision:** The review criteria live in `tuglaws/plan-review-rubric.md`. `review-plan` reads it; if it is absent, the skill proceeds on the criteria carried in its own text and says so.

**Rationale:** The judgment was the valuable part of `vet` and it was trapped in skill prose. As doctrine it is citable by `review-plan`, by `audit`, and by a human. A project without `tuglaws/` must degrade, not fail.

#### [P08] The Review Record lives in the plan, right after Plan Metadata (DECIDED) {#p08-review-record}

**Decision:** The devise skeleton goes to v5 with `### Review Record {#review-record}` immediately after Plan Metadata. `review-plan` appends one entry per round.

**Rationale:** Merging the verdict into the gesture means nobody reads a verdict message; the record has to live in the artifact. Placing it early answers "has this been reviewed, and what did it find?" before a cold reader invests in the body.

**Implications:** `plan lint` treats it as optional but warns when absent — `PL023` in [Table T01](#t01-lint-rules).

#### [P09] The review turn is unconditional, announced, and interruptible (DECIDED) {#p09-unconditional-but-interruptible}

**Decision:** The card always submits the review turn when the signal arrives and the gate passes. It posts a one-line announcement naming the model it is borrowing before submitting. Interrupting the turn releases the borrow exactly as completion does.

**Rationale:**
- An opt-out flag recreates the seam this phase removes — the old flow's failure mode was precisely a decision point between authoring and reviewing.
- Unannounced is not the same as unconditional. The user should never wonder why the model chip changed.
- Interrupt is the honest escape hatch, and it already exists for every turn.

**Implications:** The release path is driven by the review turn's **settle** (completed, errored, or interrupted), never by turn success — and settle means *this* turn's settle, which the machine can only recognize after it has watched the turn start ([P12](#p12-armed-running-settled)).

#### [P10] The submission is a command atom, and assertions name the atom (DECIDED) {#p10-submission-is-an-atom}

**Decision:** The review turn is submitted through `buildCommandSubmission("tugplug:review-plan", planPath)` — a leading `command` atom plus the path as the tail. Every test asserts the **atom** (`{kind:"atom", type:"command", value:"tugplug:review-plan"}`) and the tail text, never a literal `"/tugplug:review-plan …"` string.

**Rationale:** `buildCommandSubmission` (`slash-commands.ts`) returns `text = TUG_ATOM_CHAR (+ " " + args)`; the command name lives only in the atom. The rendered row reads `/tugplug:review-plan <path>` and the wire text is reassembled downstream, but `submission.text` never contains that string — an assertion written against it would fail on a working implementation, which is the worst kind of test.

**Implications:** The app-test asserts either the atom on the submitted turn or the row's rendered text, and the plan's success criteria say so.

#### [P11] A request that arrives mid-turn parks; it is never refused (DECIDED) {#p11-request-parks}

**Decision:** `devise` fires the signal from **inside its own turn**, so the frame routinely lands while `canSubmit` is false. That is the normal case, not an error: the request is latched in the request store and the controller acts on it when the current turn settles. Only `already-reviewing` and `model-unknown` refuse.

**Rationale:**
- Treating "a turn is in flight" as a gate failure would refuse the review on the happy path — the signal cannot arrive any other way, because the skill that sends it is what the turn is running.
- It is also the only ordering that works with the model gate: `useModel`'s `setModel` declines mid-turn by design ([L28] — a control acts on a lifecycle by subscribing to its published state), and the borrow must not fight that. Parking makes the borrow happen where the plan already said it happens: *between* turns.
- Latching in the store rather than in the controller means a request that arrives before the card's controller exists is still seen.

**Implications:**
- The park is bounded: a parked request is dropped if a *different* user turn is submitted first, so the review can never surprise someone who has moved on. That drop is a caution, not silence.
- The gate's `turn` reason disappears from `evaluatePlanReviewGate` — the shape in [Spec S02](#s02-borrow-machine) reflects this.

#### [P12] The machine is armed → running → settled, never idle → settled (DECIDED) {#p12-armed-running-settled}

**Decision:** After submitting, the controller enters `armed` and only enters `running` once it has observed the session leave the idle phase. The release fires on the transition **out of** `running`.

**Rationale:** There is no turn-settled event to subscribe to. `CodeSessionStore` publishes `canSubmit` off its phase machine, and at the instant `send()` returns the phase has not yet moved — `canSubmit` is still true. A machine that released on "next idle" would release the borrow milliseconds after taking it and run the whole review on the model it just gave back. The three-beat shape is what makes the release correspond to the turn it belongs to.

**Implications:**
- An `armed` state that never sees the turn start (a send that failed outright) must still release — it falls back to releasing when the phase is idle *and* no turn was observed within the store's next notification, so a lost submission cannot strand a borrow.
- Release stays idempotent: a second settle sends no second `model_change`.

---

### Deep Dives {#deep-dives}

#### Where the existing pieces are (read this before writing code) {#code-map}

| What | Where | Note |
|---|---|---|
| Live model set | `tugcode/src/session.ts:7071` `handleModelChange` | records the selector (`"default"` → `null`) then sends `{subtype:"set_model", model}`; no respawn — pinned by `__tests__/model-respawn.test.ts` |
| Model survival across respawns | `tugcode/src/session.ts:3168` `currentModel` + `liveSpawnConfig` | tugcode re-applies the recorded selector on any respawn it performs |
| Deck model set + persistence | `tugdeck/src/lib/use-model.ts` — `setModel`, `writePersistedModel`, mount-restore effect | `setModel` = `applyModel` + `writePersistedModel` + `codeSessionStore.setModel`; the borrow must use only the first and third |
| Selector ↔ catalog | `tugdeck/src/lib/model.ts` (`resolveModelSelector`, `isModelSelector`), `model-selector.ts`, `model-picker-data.ts` (`modelIdToSelector`), `model-catalog.ts` | resolution survives claude respelling a selector between releases; never hardcode a model list |
| Current selector of a live session | the mount-restore effect in `use-model.ts` | `model !== null ? modelIdToSelector(model, knownModelRows(models, readModelCatalog())) : "default"` — reuse this expression, do not re-derive it |
| Card-submitted skill turn | `tugdeck/src/components/tugways/cards/session-card.tsx` (`join:` handler), `tugdeck/src/lib/slash-commands.ts:367` `buildCommandSubmission` | leading `command` atom → claude expands it as a USER invocation, clearing `disable-model-invocation` |
| Controller pattern | `tugdeck/src/lib/commit-mode-controller.ts` (+ its `__tests__`) | per-card façade folding upstream stores into one referentially-stable snapshot, with an exported pure gate |
| Broadcast frame → card | `tugdeck/src/action-dispatch.ts` — `registerAction("bind_dash_ok" \| "bind_dash_err" \| "unbind_dash_ok", …)` + `cardIdForSession` | the ONLY way a server broadcast reaches a card: a dispatch-time handler resolves the session id to a card and writes a store; the card subscribes to the store, never to the frame |
| Turn phase / `canSubmit` | `tugdeck/src/lib/code-session-store.ts` — the phase machine, `canSubmit`, `canInterrupt` | there is **no** settled event; settle is inferred from a phase transition ([P12](#p12-armed-running-settled)) |
| CLI → server → deck | `tugutil/src/draft.rs` (`POST /api/draft`, `resolve_port_any` from `commands/tell.rs`); phase 2's `POST /api/dash` broadcast | the template for `plan review-request` |
| `--json` envelope | `tugutil/src/output.rs` — `JsonResponse<T>`, `print_ok`, `JsonIssue` | `JsonIssue` already carries `code`/`severity`/`message`/`file`/`line`/`anchor` — exactly a lint diagnostic |
| Exit codes | `tugutil/src/changes.rs::finish` over `AppError::Exit1/2/3` | reuse; do not invent a second convention |
| CLI test convention | `tugutil/tests/*_cli.rs` (`assert_cmd`, `tempfile`, `serial_test`) | `dash_binding_cli.rs` is the closest sibling |
| Skill packaging | `tugapp/Tug.xcodeproj/project.pbxproj`, "Copy Rust binaries, tugdeck dist, capabilities, and tugplug" | `rm -rf` + `cp -R` into `Resources/tugplug` |
| Skills inventory | `tugcode/src/__tests__/skills-inventory.test.ts`, `pulse-voice-labels.test.ts` | they write **synthetic** skill dirs (one named `vet`); they do not read the real `tugplug/` and need no change |

#### What a real plan actually looks like {#real-plan-shape}

Calibrated against `dash/dash-integration-2-visibility.md`, `dash/facts-library-access-plan.md`, `dash/robustify-file-tracking.md`:

- Title `## … {#anchor}`; top-level sections `### …`; subsections and steps `#### …`.
- The ledger is `#### Step Status Ledger {#step-status-ledger}` then a pipe table headed `| Step | Title | Status | Commit |`, rows like `| #step-1 | Changes dash lane | done | \`95effa736\` |`.
- Steps are `#### Step N: <title> {#step-n}` with `**Commit:**`, `**References:**`, `**Tasks:**`, `**Tests:**`, `**Checkpoint:**`, and `**Depends on:**` on every step but the first.
- **`**Artifacts:**` is in the skeleton but absent from real plans** — it must be optional.
- `**References:**` mixes label citations and parenthesized anchors: `[P01], [P02], Spec S01, (#data-map)`.
- Not every file in `dash/` is a plan: briefs, notes, and the program plan itself are not. Detection must be positive, not positional.

#### The borrow cycle, end to end {#borrow-cycle}

1. `devise` writes the plan and, **still inside its own turn**, runs `tugutil plan review-request --plan <abs-path>`, then ends the turn saying the review is next.
2. tugcast broadcasts `plan_review_request`; `action-dispatch.ts` resolves `tug_session_id` → card and latches the request in the request store ([P04](#p04-server-signal)).
3. The controller sees the latched request. A turn is in flight — it always is, at this point — so the request **parks** ([P11](#p11-request-parks)). It is dropped, with a caution, only if the user submits a different turn first.
4. The devise turn settles. The controller evaluates the gate ([Spec S02](#s02-borrow-machine)): a review already running, or an unknown session model → caution, no submission. An unresolvable review selector is not a gate failure — it means run without borrowing.
5. Same catalog row as the review model ([P03](#p03-compare-resolved-ids)) → skip the borrow entirely and go to step 7.
6. Capture the current **selector**; `borrowModel(reviewSelector)` — `applyModel` + `codeSessionStore.setModel`, no persistence, and mount-restore suppressed for the duration ([#step-5](#step-5)).
7. Announce, then `codeSessionStore.send(…)` with the submission from `buildCommandSubmission("tugplug:review-plan", planPath)` ([P10](#p10-submission-is-an-atom)) — the machine enters `armed`.
8. The controller observes the phase leave idle: `armed` → `running` ([P12](#p12-armed-running-settled)). The turn runs on Opus, in the transcript, editing the plan.
9. On the transition out of `running` — completed, errored, or interrupted — `releaseModel(capturedSelector)` if a borrow happened. Unmount mid-review does the same. Release is idempotent.
10. Process death mid-review needs no handling in the common case: persistence was never touched, so `use-model.ts`'s mount-restore repairs the live session on the next mount ([Q01](#q01-crash-recovery), whose one residual is stated there).

---

### Specification {#specification}

**Spec S01: The lint model** {#s01-lint-model}

```rust
pub enum Severity { Error, Warning }

pub struct Diagnostic {
    pub code: String,           // "PL001"
    pub severity: Severity,
    pub message: String,
    pub line: Option<usize>,    // 1-indexed
    pub anchor: Option<String>, // "#step-3"
}

pub struct PlanDoc { /* title, anchors, sections, labels, steps, ledger */ }

pub fn parse(source: &str) -> Result<PlanDoc, NotAPlan>;
pub fn lint(doc: &PlanDoc) -> Vec<Diagnostic>;
```

`parse` returns `NotAPlan` unless the document has a `{#plan-metadata}` or `{#execution-steps}` section. `Diagnostic` maps one-to-one onto the existing `JsonIssue`, so the CLI converts rather than defines.

**Table T01: Lint rules** {#t01-lint-rules}

| Code | Severity | Rule |
|---|---|---|
| PL001 | error | A required section is missing (`#plan-metadata`, `#phase-overview`, `#execution-steps`, `#step-status-ledger`, `#deliverables`) |
| PL002 | error | Two headings declare the same `{#anchor}` |
| PL003 | error | An anchor uses anything but `[a-z0-9-]` |
| PL004 | warning | A `###`/`####` heading carries no explicit anchor |
| PL005 | error | `[D##]` used as a plan-local decision heading (must be `[P##]`) |
| PL006 | error | A label id (`P`/`Q`/`S`/`T`/`L`/`R`/`M`) is declared twice |
| PL007 | warning | A label id is not two digits |
| PL008 | error | A step has no `**Commit:**` line |
| PL009 | error | A step has no `**References:**` line |
| PL010 | error | A step has no Tasks block |
| PL011 | error | A step has no Tests block |
| PL012 | error | A step has no Checkpoint block |
| PL013 | error | A `**Depends on:**` entry names an anchor that does not exist |
| PL014 | error | A step depends on a later step |
| PL015 | error | No Step Status Ledger table under `{#step-status-ledger}` |
| PL016 | error | Ledger rows and `#### Step N` headings are not the same set |
| PL017 | error | A ledger status is not `pending` / `in progress` / `done` |
| PL018 | warning | A ledger row is `done` with no commit recorded |
| PL019 | warning | A `**References:**` line cites line numbers |
| PL020 | error | A Tests block names a banned test shape (`happy-dom`, `jsdom`, `@testing-library/react`, mock-store assertions) |
| PL021 | warning | A `**References:**` line is `N/A` or carries no citation |
| PL022 | warning | A step anchor does not match its step number |
| PL023 | warning | No `{#review-record}` section ([P08](#p08-review-record)) |

Severities split so only errors gate: the corpus predates any checker, and a single severity would either be too weak to run or fail plans that are fine. Exit 1 on any error; warnings exit 0; exit 2 for unreadable / not-a-plan.

**PL020 is scoped to the Tests block, strictly.** The banned shapes are matched only inside a step's Tests block — never in Tasks, prose, or a table. A plan that *names* the ban in order to enforce it (this one does, in [#step-3](#step-3) and [#test-non-goals](#test-non-goals)) must lint clean; a checker that greps the whole document would fail the doctrine that defines it.

**Spec S02: The borrow state machine** {#s02-borrow-machine}

```ts
type PlanReviewPhase =
  | { kind: "idle" }
  | { kind: "parked"; planPath: string }                                    // [P11]
  | { kind: "armed"; planPath: string; borrowedFrom: string | null }        // [P12] submitted, turn not yet observed
  | { kind: "running"; planPath: string; borrowedFrom: string | null };
```

`borrowedFrom` is the captured **selector** (`null` when no borrow happened — same catalog row, or unresolvable review selector). Exported pure gate, mirroring `evaluateCommitLandGate`:

```ts
export function evaluatePlanReviewGate(input: {
  phase: PlanReviewPhase;       // a review already parked / armed / running?
  sessionModelKnown: boolean;   // models[].length > 0 || model !== null
}): { ok: true } | { ok: false; reason: "already-reviewing" | "model-unknown" };
```

Two inputs the earlier shape carried are deliberately gone. `turnInProgress` is not a gate reason ([P11](#p11-request-parks)): a turn in flight is the *expected* state when the request arrives, so it parks rather than failing. `reviewSelectorResolves` is not one either — it means "run the review without borrowing" plus a one-time notice.

Transitions:

| From | On | To | Effect |
|---|---|---|---|
| `idle` | request | `parked` | latch the path |
| `parked` | turn settles | `armed` \| `idle` | gate; capture, maybe borrow, announce, submit — or caution and drop |
| `parked` | a different turn is submitted | `idle` | drop with a caution ([P11](#p11-request-parks)) |
| `armed` | phase leaves idle | `running` | — |
| `armed` | no turn observed and the session is idle | `idle` | release (a submission that never became a turn) |
| `running` | settle (completed / errored / interrupted) | `idle` | release if `borrowedFrom !== null` |
| any | unmount | `idle` | release if `borrowedFrom !== null` |

Release is idempotent — a second settle must not send a second `model_change`. A request arriving while `parked`/`armed`/`running` is `already-reviewing`.

**Spec S03: The readiness signal** {#s03-signal}

```
tugutil plan review-request --plan <path> [--port <n>] [--instance <name>] [--json]
```

`POST http://127.0.0.1:<port>/api/plan-review` with `{tug_session_id, plan_path}`; the port is discovered with `resolve_port_any` exactly as `tugutil draft set` does. tugcast broadcasts:

```json
{ "type": "plan_review_request", "tug_session_id": "…", "plan_path": "/abs/path/plan.md" }
```

Exit 0 on accept; non-zero with an actionable message when no tugcast is reachable (the skill then prints the manual command). The review model comes from the tugbank default `dev.tugtool.plan-review` / `model`, seeded `opus` — a value, not a constant, because "always Opus" is explicitly *for now*.

**Spec S04: Review Record format** {#s04-review-record}

```markdown
### Review Record {#review-record}

**Round 1 — 2026-08-13, opus.** Lint: 0 errors, 3 warnings (2 fixed).
Applied: sequencing — Step 4 depended on a later step, reordered; test plan — Step 2
proposed an RTL render test, rewritten as an app-test; law [L02] — the new store read
bypassed `useSyncExternalStore`, corrected in Spec S01.
Deferred: the migration-window question, now [Q03].
```

One paragraph per round, appended. Prose, not a table — a table invites one-word entries, and the value is the specificity.

#### State Zone Mapping (tugdeck/tugways plans) {#state-zone-mapping}

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| `PlanReviewPhase` (idle / parked / armed / running + `borrowedFrom`) | structure | `plan-review-controller` store + `useSyncExternalStore` | [L02] |
| The latched review request | structure | `plan-review-request-store` written by the `action-dispatch` handler, read by the controller — never a card-held frame subscription | [L02] |
| The borrowed model on the chip | local-data (session truth) | `sessionMetadataStore.applyModel` — the existing optimistic path; the chip re-renders from its own subscription | [L02], [D03] |
| The user's persisted selector | local-data (durable) | **not written** during a borrow; `dev.model/<cardId>` via tugbank only on a user pick | [D07] |
| The announcement line | appearance | pane bulletin (`paneBulletinRef`), the `/dash` caution path | [L06] |
| Controller ↔ card registration | structure | `useLayoutEffect` at mount, so the controller is subscribed before any latched request is read | [L03] |
| Turn state the borrow acts on | structure (read-only, upstream) | subscribe to `CodeSessionStore`'s published phase / `canSubmit`; never reach into the running turn, never re-derive its state beside the source | [L28] |
| Every subscription this feature takes | lifecycle | each `subscribe` / `registerAction` returns its unregister, invoked on controller dispose and card unmount — inert is not released | [L27] |

[L28] is the law this feature lives under: the borrow is a *control* acting on the turn lifecycle, and it acts only by subscribing to `canSubmit` and the phase — which is also why a mid-turn request parks instead of forcing a model change into a live turn ([P11](#p11-request-parks)).

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugrust/crates/tugutil-core/src/plan.rs` | skeleton parse, ledger grammar, lint rules ([S01](#s01-lint-model), [T01](#t01-lint-rules)) |
| `tugrust/crates/tugutil/src/plan.rs` | the `plan` namespace CLI shell (`lint`, `review-request`) |
| `tugrust/crates/tugutil/tests/plan_cli.rs` | `assert_cmd` integration tests |
| `tugdeck/src/lib/plan-review-request-store.ts` | the latch a broadcast `plan_review_request` lands in, keyed by card ([P04](#p04-server-signal)) |
| `tugdeck/src/lib/plan-review-controller.ts` | the borrow state machine + exported pure gate ([S02](#s02-borrow-machine)) |
| `tugdeck/src/lib/__tests__/plan-review-controller.test.ts` | pure tests for the machine, including park, arm, and release-on-interrupt |
| `tuglaws/plan-review-rubric.md` | the review doctrine ([P07](#p07-rubric-doctrine)) |
| `tugplug/skills/review-plan/SKILL.md` | the review skill ([P05](#p05-review-plan-skill)) |
| `tests/app-test/at0409-plan-review-borrow.test.ts` | chip flip, submission text, restore, and persistence-untouched |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `Diagnostic`, `Severity`, `PlanDoc`, `Step`, `LedgerRow` | types | `tugutil-core/src/plan.rs` | [Spec S01](#s01-lint-model) |
| `parse`, `lint` | fn | `tugutil-core/src/plan.rs` | |
| `PlanCommands` | enum | `tugutil/src/cli.rs` | `Lint`, `ReviewRequest` |
| `Commands::Plan` | variant | `tugutil/src/cli.rs`, `src/main.rs` | dispatches to `plan::dispatch` |
| `POST /api/plan-review` | route | `tugcast/src/main.rs` | broadcasts `plan_review_request` ([Spec S03](#s03-signal)) |
| `PlanReviewRequest` | frame type | `tugcast-core/src/types.rs` | additive |
| `borrowModel`, `releaseModel` | fn | `tugdeck/src/lib/use-model.ts` | `applyModel` + `codeSessionStore.setModel`, **never** `writePersistedModel` ([P02](#p02-borrow-never-persists)); suppress mount-restore while a borrow is live ([#step-5](#step-5)) |
| `currentModelSelector`, `resolvesToSameModel` | fn | `tugdeck/src/lib/use-model.ts` | the one derivation the mount-restore already uses; row-identity comparison ([P03](#p03-compare-resolved-ids)) |
| `registerAction("plan_review_request", …)` | handler | `tugdeck/src/action-dispatch.ts` | `cardIdForSession` → `planReviewRequestStore.latch` — beside `bind_dash_ok` ([P04](#p04-server-signal)) |
| `planReviewRequestStore` | store | `tugdeck/src/lib/plan-review-request-store.ts` | latches one pending request per card; `take()` clears it |
| `PlanReviewPhase`, `evaluatePlanReviewGate`, `createPlanReviewController` | types/fn | `tugdeck/src/lib/plan-review-controller.ts` | mirrors `commit-mode-controller`; every subscription it takes is released in `dispose()` ([L27]) |
| `PLAN_REVIEW_DOMAIN`, `PLAN_REVIEW_MODEL_KEY` | const | `tugdeck/src/lib/model-domains.ts` | `dev.tugtool.plan-review` / `model`, seeded `opus` |

---

### Documentation Plan {#documentation-plan}

- [ ] `tuglaws/plan-review-rubric.md` — new; `tuglaws/INDEX.md` entry under **Templates**.
- [ ] `tuglaws/devise-skeleton.md` — v5 with the Review Record section.
- [ ] `tugplug/skills/review-plan/SKILL.md` — new.
- [ ] `tugplug/skills/devise/SKILL.md` — rewritten hand-off and signal step.
- [ ] `tugplug/skills/vet/SKILL.md` — replaced by the stub.
- [ ] `tugplug/skills/audit/SKILL.md` — drop the `/tugplug:vet` counterpart phrasing; cite the rubric.
- [ ] `tugplug/CLAUDE.md` — skill roster and the flow line.
- [ ] `CLAUDE.md` — the `tugplug/` row's skill list.
- [ ] `tugplug/.claude-plugin/plugin.json` — drop `vet` from `description`/`keywords`.
- [ ] `tuglaws/tracking-changes.md` or `design-decisions.md` — record the borrow-never-persists rule, since it is a general model-handling law, not a plan-review detail.
- [ ] `dash/dash-integration-plan.md` — Phase 2.1 marked shipped; note the parser landed in `tugutil-core::plan`.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust)** | parse/lint rules | every code in [T01](#t01-lint-rules) |
| **Integration (CLI)** | `assert_cmd` over the real binary | `plan lint` exit codes and envelope; `review-request` against a live and an absent tugcast |
| **Corpus calibration** | lint every plan in `dash/` | drift guard keeping the rules honest against real documents |
| **Pure (bun)** | the borrow state machine | park-on-mid-turn, arm→run→settle, gate precedence, release on settle/interrupt/unmount, idempotent release, skip-when-same-row, dispose leaves nothing subscribed |
| **App-test** | the real card | chip flips, the submitted command **atom** ([P10](#p10-submission-is-an-atom)), restore, and `dev.model/<cardId>` untouched |
| **Real end-to-end** | one actual devise → review run | proves the gesture; done by hand in [#step-8](#step-8) |

#### What stays out of tests {#test-non-goals}

- **No test that calls a model.** The app-test drives the controller with an injected `plan_review_request` frame and a stubbed turn lifecycle; the one genuine Opus run is the manual checkpoint in [#step-8](#step-8). Real-claude tests are on-demand only.
- **No assertions on reviewer prose.** Assert the contract — chip, the submitted command atom, persisted value, plan file changed — never the generation.
- **No mock-store or fake-DOM tests.** Banned. The controller is pure, so it needs neither.
- **No assertion on animation.** Background windows run no rAF; nothing here hangs off one.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Plan parser and lint rules | done | `c56eef322` |
| #step-2 | `tugutil plan lint` | done | `5f42a89e2` |
| #step-3 | The review rubric | done | `332f3d05c` |
| #step-4 | The readiness signal | done | `4de031866` |
| #step-5 | Non-persisting model borrow | done | `a9c988b7a` |
| #step-6 | The plan-review controller | done | `44c2eb5bc` |
| #step-7 | Skills, skeleton v5, vet retirement | done | `2ea1114ad` |
| #step-8 | Integration checkpoint — one real gesture | in progress | automated sweep green; the by-hand gesture is the user's |

#### Step 1: Plan parser and lint rules {#step-1}

**Commit:** `tugutil-core(plan): parse the devise skeleton and lint it`

**References:** [P06] lint vs judgment, Spec S01, Table T01, (#real-plan-shape)

**Tasks:**
- [ ] Add `tugrust/crates/tugutil-core/src/plan.rs` per [Spec S01](#s01-lint-model): a hand-rolled line scanner collecting headings/anchors, per-step `**Field:**` lines, the ledger table, and label declarations. No markdown crate.
- [ ] `parse` returns `NotAPlan` unless a `{#plan-metadata}` or `{#execution-steps}` section is present — positive detection, since `dash/` also holds briefs, notes, and the program plan.
- [ ] Implement every rule in [Table T01](#t01-lint-rules). `**Artifacts:**` and `**Depends on:**` are optional.
- [ ] Declare the module in `tugutil-core/src/lib.rs`; re-export what the CLI needs.
- [ ] **Calibrate against the real corpus:** lint every plan-shaped file in `dash/` and read the output. Where a rule fires on a document that is genuinely fine, demote it or fix the rule — never edit a plan to satisfy the checker. Record severity changes and why in the commit body.

**Tests:**
- [ ] Unit: one focused fixture per [T01](#t01-lint-rules) code, asserting code, severity, and line.
- [ ] Unit: a conforming minimal plan yields zero diagnostics.
- [ ] Unit: a brief parses as `NotAPlan`.
- [ ] Corpus: every plan-shaped file in `dash/` yields **zero error-severity** diagnostics; resolve the directory from `CARGO_MANIFEST_DIR` and skip cleanly when absent, so the crate stays testable outside this repo.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugutil-core`
- [ ] The corpus test passes against `dash/` **as it stands** — no plan edited to make it green.

---

#### Step 2: `tugutil plan lint` {#step-2}

**Depends on:** #step-1

**Commit:** `tugutil(plan): add the plan lint verb`

**References:** [P06] lint vs judgment, Spec S02, Table T01, (#code-map)

**Tasks:**
- [ ] Add `PlanCommands` to `tugutil/src/cli.rs` and a `Commands::Plan` variant dispatched from `src/main.rs`, following the `Commands::Dash` shape.
- [ ] Add `tugutil/src/plan.rs` as a thin shell over `tugutil_core::plan`, mirroring `src/dash.rs`.
- [ ] Human output: `path:line: CODE severity message` per diagnostic, then a summary. `--json` maps diagnostics onto the existing `JsonIssue` — do not define a second issue type — and picks the envelope by outcome: `output::print_ok` for clean-or-warnings, `JsonResponse::error` for a run carrying any error diagnostic, since `print_ok` hardcodes `status: "ok"`.
- [ ] Exit codes: 0 clean-or-warnings, 1 on any error, 2 unreadable / not-a-plan, routed through `changes::finish`'s `AppError`.
- [ ] Explicit path only — no `resolve_plan` cascade, no `PLAN_SEARCH_DIRS`.

**Tests:**
- [ ] Integration (`tests/plan_cli.rs`): conforming plan → 0; seeded error → 1 naming the code; brief → 2 `not a plan document`; missing file → 2.
- [ ] Integration: `--json` parses and carries `schema_version`, `command`, `status`, and the diagnostics under `issues` — `status: "ok"` for a warnings-only run, `status: "error"` when an error diagnostic is present.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugutil`
- [ ] `cd tugrust && cargo run -p tugutil -- plan lint ../dash/dash-integration-2-visibility.md` → exit 0.
- [ ] `cd tugrust && cargo run -p tugutil -- plan lint ../dash/dash-integration-2.1-one-gesture.md` → exit 0 — the checker passes its own plan.
- [ ] `cd tugrust && cargo run -p tugutil -- plan lint ../dash/dash-notes.md` → exit 2.

---

#### Step 3: The review rubric {#step-3}

**Commit:** `tuglaws(plan-review-rubric): promote the vet criteria to doctrine`

**References:** [P07] rubric doctrine, [P06] lint vs judgment

**Tasks:**
- [ ] Write `tuglaws/plan-review-rubric.md` carrying, as a rubric rather than skill prose: the five assessment axes from the retiring `vet` skill (plan quality and coherence; technical choices; implementation strategy and sequencing; holes, pitfalls, failure modes; test-plan sanity); the tuglaws cross-check obligation (name the specific laws; for tugdeck work verify the State Zone Mapping); the banned test shapes (`happy-dom`, `jsdom` render, `@testing-library/react`, mock-store assertion tests, reflexive per-mutator pin tests); the "does this leave the architecture better" test; and the cold-reader test.
- [ ] State what the rubric does **not** cover and why: everything in [Table T01](#t01-lint-rules) belongs to the linter, so a reviewer never spends attention on anchor spelling.
- [ ] Add the `tuglaws/INDEX.md` entry under **Templates**, beside `devise-skeleton.md`.
- [ ] Cite the rubric from `tugplug/skills/audit/SKILL.md` — same five axes, unchanged behavior.

**Tests:**
- [ ] N/A — documentation; verified by the reviewer applying it in [#step-8](#step-8).

**Checkpoint:**
- [ ] Diff the retiring `tugplug/skills/vet/SKILL.md` against the rubric by hand and confirm no axis was dropped in the move.
- [ ] `tuglaws/INDEX.md` links resolve.

---

#### Step 4: The readiness signal {#step-4}

**Depends on:** #step-2

**Commit:** `tugutil(plan): signal plan-review readiness through the running tugcast`

**References:** [P04] server signal, Spec S03, (#code-map)

**Tasks:**
- [ ] Add `plan review-request --plan <path>` to `tugutil/src/plan.rs`, `POST`ing `/api/plan-review` with port discovery via `resolve_port_any` — the `tugutil draft set` shape, including its actionable "no reachable Tug instance" error.
- [ ] Add `PlanReviewRequest` to `tugcast-core/src/types.rs` (additive) and the `POST /api/plan-review` route in `tugcast/src/main.rs`, broadcasting to the card bound to `tug_session_id` — the pattern phase 2 established for `POST /api/dash`.
- [ ] Resolve `--plan` to an absolute path before sending; the card must never receive a path relative to a cwd it does not share.

**Tests:**
- [ ] Rust: the route broadcasts the frame with the session id and absolute plan path.
- [ ] Integration: `review-request` against a live tugcast exits 0; with none reachable, exits non-zero with the remedy text.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugutil -p tugcast`
- [ ] `cd tugrust && cargo build` — zero warnings.

---

#### Step 5: Non-persisting model borrow {#step-5}

**Commit:** `tugdeck(model): add a borrow/release path that never writes the card's persisted selector [D03][D07]`

**References:** [P02] borrow never persists, [P03] compare resolved ids, Q01, (#code-map)

**Tasks:**
- [ ] Add `borrowModel(selector)` and `releaseModel(selector | null)` to `tugdeck/src/lib/use-model.ts`: `sessionMetadataStore.applyModel` + `codeSessionStore.setModel` and **nothing else**. State the no-persistence property in the docblock as a requirement with its reason ([Q01](#q01-crash-recovery)), not as a remark.
- [ ] Export a `currentModelSelector(snapshot)` helper wrapping the expression the mount-restore effect already uses (`modelIdToSelector(model, knownModelRows(models, readModelCatalog()))`, else `"default"`), and use it in both places so the derivation exists once.
- [ ] Add `resolvesToSameModel(a, b)` over the live catalog for the [P03](#p03-compare-resolved-ids) comparison — same **catalog row** (`resolveModelSelector`'s `row.value`), not same model id.
- [ ] **Make the borrow and the mount-restore mutually exclusive.** `borrowModel` calls `applyModel`, which moves `snapshot.model` — a dependency of `useModel`'s mount-restore effect, so the borrow *re-runs* it. The effect is inert only because `sentRef.current` is already true; on the path where readiness was never reached (`models.length === 0 && model === null`) it early-returns **without arming**, and the borrow's own `applyModel` is what first makes `model` non-null — at which point the effect resolves a current selector that differs from the seed and calls `setModel(seed, {fromRestore: true})`, reverting the model mid-review *and* persisting. Suppress the restore while a borrow is live (a module-level borrow flag the effect checks, or arm `sentRef` in `borrowModel`), and state the invariant in the docblock as a requirement.
- [ ] Add `PLAN_REVIEW_DOMAIN` / `PLAN_REVIEW_MODEL_KEY` to `model-domains.ts`, seeded `opus`.

**Tests:**
- [ ] bun: `borrowModel` sends the frame and applies the chip value and performs **no** tugbank write (assert against a fake client that fails the test on any `setLocalValue`/PUT).
- [ ] bun: `releaseModel(null)` is a no-op; `releaseModel("default")` sends `default`.
- [ ] bun: `resolvesToSameModel("default", "opus")` is true when the catalog resolves both to the same row, false otherwise.
- [ ] bun: a borrow taken while the mount-restore has **not** yet armed (`models: []`, `model: null`, a non-null seed) sends exactly one `model_change` — the borrow's — and no `writePersistedModel`. This is the [#risks](#risks) row it pins.

**Checkpoint:**
- [ ] `bun test` green; `bunx tsc --noEmit` clean.

---

#### Step 6: The plan-review controller {#step-6}

**Depends on:** #step-4, #step-5

**Commit:** `session-card(plan-review): borrow opus for the review turn and give the model back [L02][L03][L27][L28]`

**References:** [P01] review is a turn, [P02] borrow never persists, [P09] unconditional but interruptible, [P10] submission is an atom, [P11] request parks, [P12] armed → running → settled, Spec S02, (#borrow-cycle), (#state-zone-mapping)

**Tasks:**
- [ ] Add `tugdeck/src/lib/plan-review-request-store.ts`: a latch holding at most one pending request per card, with `latch`, `take`, and a `subscribe` that returns its unregister ([L27]).
- [ ] Add `registerAction("plan_review_request", …)` to `action-dispatch.ts` beside `bind_dash_ok`: validate the payload fields, walk `cardIdForSession(tug_session_id)`, and latch. This is how a broadcast reaches a card ([P04](#p04-server-signal)) — the card never subscribes to a frame.
- [ ] Add `tugdeck/src/lib/plan-review-controller.ts` per [Spec S02](#s02-borrow-machine): the `PlanReviewPhase` snapshot (`idle` / `parked` / `armed` / `running`), the exported pure `evaluatePlanReviewGate`, and the transition table — mirroring `commit-mode-controller`'s façade shape, and disposing every subscription it takes ([L27]).
- [ ] Wire it in `session-card.tsx` with a `useLayoutEffect` mount registration ([L03]) so the controller is reading the request store before a latched request could be missed. On a latched request: **park** ([P11](#p11-request-parks)) — the devise turn is still in flight, which is the normal case, not a refusal.
- [ ] On the parked turn's settle: run the gate, capture the selector, borrow when [P03](#p03-compare-resolved-ids) says the rows differ, announce through the pane bulletin, then `codeSessionStore.send(…)` from `buildCommandSubmission("tugplug:review-plan", planPath)` and enter `armed` ([P12](#p12-armed-running-settled)).
- [ ] Enter `running` only after observing the session phase leave idle; release on the transition **out of** `running` — completed, errored, or interrupted — and on unmount. Release is idempotent. An `armed` state whose turn never starts releases too.
- [ ] Drop a parked request, with a caution, if the user submits a different turn first.
- [ ] Unresolvable review selector → run the review with no borrow plus a one-time caution; gate failures (`already-reviewing`, `model-unknown`) → caution and no submission.

**Tests:**
- [ ] bun: a request arriving mid-turn parks and submits on settle (the happy path — assert it is **not** refused); a parked request is dropped when a different turn is submitted.
- [ ] bun: gate precedence for each reason; skip-borrow when the selectors resolve to the same row; `armed` does not release on the idle it was submitted from; release on settle, on interrupt, and on unmount; a second settle sends no second `model_change`.
- [ ] bun: the controller's `dispose()` leaves no live subscription on the request store or the session store ([L27]).
- [ ] App-test (`at0409-plan-review-borrow.test.ts`, `@covers` the controller + the request store + `use-model.ts` + `session-card.tsx` + `action-dispatch.ts`): inject a `plan_review_request` on a card whose session resolves to a non-Opus model *while a turn is in flight*; assert it parks, then on settle the chip reads Opus, the submitted turn carries the `tugplug:review-plan` command atom with the plan path as its tail ([P10](#p10-submission-is-an-atom)) — never asserting a literal `/tugplug:review-plan …` string, which `submission.text` does not contain — the chip returns to the original model after that turn settles, and **`GET /api/defaults/dev.model/<cardId>` is byte-identical before and after**.

**Checkpoint:**
- [ ] `bun test` green; `bunx tsc --noEmit` clean; `cd tugdeck && bunx vite build` clean.
- [ ] `just build-app` then `just app-test tests/app-test/at0409-plan-review-borrow.test.ts` green.

---

#### Step 7: Skills, skeleton v5, vet retirement {#step-7}

**Depends on:** #step-3, #step-6

**Commit:** `tugplug(review-plan): fold vetting and fixups into the devise gesture; retire vet`

**References:** [P05] review-plan skill, [P08] review record, [P04] server signal, Spec S04, (#code-map)

**Tasks:**
- [ ] `tuglaws/devise-skeleton.md`: bump to v5; add `### Review Record {#review-record}` immediately after Plan Metadata with the [Spec S04](#s04-review-record) shape.
- [ ] Write `tugplug/skills/review-plan/SKILL.md`: read the plan from disk; run `tugutil plan lint` and fix every diagnostic; read `tuglaws/plan-review-rubric.md` and apply it against the real code (degrading per [P07](#p07-rubric-doctrine) when absent); **apply fixups directly**; append the Review Record; report what changed and hand off with `` `/tugplug:implement <path>` ``. Guardrails: no sub-agents, edit only the plan file, never report "looks good" without having read the code the plan touches.
- [ ] Rewrite `tugplug/skills/devise/SKILL.md`: drop the `/tugplug:vet` hand-off; after writing the plan, run `tugutil plan review-request --plan <abs-path>` and tell the user the review turn is coming and on which model; if the verb fails (no reachable tugcast), print `` `/tugplug:review-plan <path>` `` for the user to run by hand rather than declaring the plan ready.
- [ ] Replace `tugplug/skills/vet/SKILL.md` with the stub: frontmatter naming it retired, a body that prints `` `/tugplug:review-plan <plan-path>` `` and stops, `Read` only.
- [ ] `tugplug/skills/audit/SKILL.md`: replace the "counterpart to `/tugplug:vet`" phrasing with a description that stands alone.
- [ ] `tugplug/CLAUDE.md`, `CLAUDE.md`, `tugplug/.claude-plugin/plugin.json`: roster, flow line, and keywords.
- [ ] Record the borrow-never-persists rule in `tuglaws/design-decisions.md` — it governs any future feature that wants to run a turn on a different model, not just this one.
- [ ] Grep for stragglers: `grep -rn "tugplug:vet" tugplug/ tuglaws/ CLAUDE.md dash/dash-integration-plan.md`. Leave `dash/archive/` alone — it is history.

**Tests:**
- [ ] `bun test` (the `tugcode` skills-inventory and pulse-voice suites use **synthetic** skill fixtures, one named `vet`; they must stay green untouched — a failure means one was reading the real plugin dir, which is the bug).
- [ ] `just hooks-test`.

**Checkpoint:**
- [ ] `grep -rn "tugplug:vet" tugplug/ tuglaws/ CLAUDE.md` returns only the stub.
- [ ] `bun test` and `just hooks-test` green.
- [ ] `just build-app`, then confirm `Tug.app/Contents/Resources/tugplug/skills/` carries `review-plan` and the stub — skills ship from the bundle, so a repo edit alone changes nothing for the running app.

---

#### Step 8: Integration checkpoint — one real gesture {#step-8}

**Depends on:** #step-6, #step-7

**Commit:** `N/A (verification only)`

**References:** [P01] review is a turn, [P02] borrow never persists, [P09] unconditional but interruptible, Risk R01, (#success-criteria), (#borrow-cycle)

**Tasks:**
- [ ] Run the whole gesture for real on a card set to **Sonnet**: `/tugplug:devise <idea>` → the signal lands mid-turn and parks → the devise turn ends → watch the chip flip to Opus → watch the review turn read the code and edit the plan in the transcript → confirm the chip returns to Sonnet. The park is the beat to watch: if the review fires before the devise turn is done, or never fires, the defect is in [#step-6](#step-6)'s transition table.
- [ ] Confirm `GET /api/defaults/dev.model/<cardId>` still reads `sonnet` after the cycle.
- [ ] Read the reviewer's actual edits. Confirm they are real improvements and confined to the plan file (`git diff` on the worktree). A bad edit is a skill-text bug in [#step-7](#step-7) — fix it and re-run.
- [ ] Interrupt a review turn mid-flight and confirm the model is restored.
- [ ] Run the by-hand path: `/tugplug:review-plan <existing-plan>` on a plan devised before this phase, and confirm it appends a Review Record.
- [ ] Time the review turns; if they routinely run long enough to feel stuck, that is a finding for the announcement wording, not for the mechanism.

**Tests:**
- [ ] Aggregate: `cd tugrust && cargo nextest run`, `bun test`, `bunx tsc --noEmit`, `cd tugdeck && bunx vite build`, `just app-test-changed`, `just hooks-test`.

**Checkpoint:**
- [ ] Every aggregate command green.
- [ ] One real devise → review → restore cycle observed end to end, with the persisted selector unchanged.
- [ ] The interrupt path restores the model.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** `/tugplug:devise` produces a linted, Opus-reviewed, already-revised plan in one gesture — the review visible as a turn in the transcript, the user's model borrowed and given back — and `/tugplug:vet` is a stub awaiting deletion.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] `tugutil plan lint` implements every rule in [Table T01](#t01-lint-rules), calibrated so the existing `dash/` corpus passes with zero errors.
- [ ] `tugutil plan review-request` reaches the card through the running tugcast, and degrades actionably when none is reachable.
- [ ] A request arriving while the devise turn is in flight **parks and then runs** — it is never refused ([P11](#p11-request-parks)).
- [ ] The card borrows the review model, submits the `tugplug:review-plan` command atom with the plan path, and restores on every terminal outcome of *that* turn — completed, errored, interrupted, unmounted.
- [ ] The borrow never writes `dev.model/<cardId>` (app-test), so a process death mid-review is repaired by the existing mount-restore (with the seedless residual noted in [Q01](#q01-crash-recovery)).
- [ ] The borrow is never reverted by `useModel`'s mount-restore, including on the not-yet-armed path ([#step-5](#step-5)).
- [ ] A card already on the review model performs no `model_change` in either direction.
- [ ] `review-plan` exists as a skill and applies fixups; `vet` is a stub; no live surface names `/tugplug:vet` except that stub.
- [ ] `tuglaws/plan-review-rubric.md` exists, is indexed, and carries every axis the retired skill had.
- [ ] `cargo nextest run` (workspace, zero warnings), `bun test`, `bunx vite build`, `just app-test-changed`, `just hooks-test` all green.

**Acceptance tests:**
- [ ] Corpus lint over `dash/` — zero error-severity diagnostics.
- [ ] `at0409-plan-review-borrow.test.ts` — park-then-run, chip flip, the submitted command atom, restore, persisted value untouched.
- [ ] Controller unit tests — park-on-mid-turn, arm→run→settle, gate precedence, skip-when-same-row, release on settle/interrupt/unmount, idempotent release, dispose.

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Gate `implement`/`dash` on `plan lint` ([Q02](#q02-lint-as-a-gate)) — program-plan phase 3.
- [ ] `dash step start|done` over this parser's ledger grammar — program-plan phase 3.
- [ ] Delete the `vet` stub — program-plan phase 5.
- [ ] A skip heuristic for trivial plans ([Q03](#q03-skip-for-trivial)).
- [ ] Generalize the borrow: any card gesture that wants a specific model for one turn (a `/audit` on Opus, a cheap-model summarization) should reuse `borrowModel`/`releaseModel` rather than growing its own.

| Checkpoint | Verification |
|------------|--------------|
| Parser and rules | `cargo nextest run -p tugutil-core`; corpus test over `dash/` |
| Lint CLI | `cargo run -p tugutil -- plan lint ../dash/dash-integration-2-visibility.md` → 0; `… dash-integration-2.1-one-gesture.md` → 0; `… dash-notes.md` → 2 |
| Signal | `cargo nextest run -p tugutil -p tugcast`; live and absent-tugcast CLI runs |
| Borrow | `bun test` (no-persistence assertion); `just app-test tests/app-test/at0409-plan-review-borrow.test.ts` |
| Skills and docs | `grep -rn "tugplug:vet" tugplug/ tuglaws/ CLAUDE.md` → stub only; `just build-app` ships `review-plan` |
| The gesture | one real Sonnet → Opus → Sonnet cycle with the persisted selector unchanged |
