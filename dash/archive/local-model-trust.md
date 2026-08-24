## Local Model Trust — Grounded Headlines, Safe Routing, One Pack {#local-model-trust}

**Purpose:** Make the on-device model trustworthy for the two jobs it does — writing the PULSE session headline and deciding whether an unprefixed composer line means the shell — by grounding every headline in the digest it claims to describe, making a wrong SHELL verdict structurally hard to reach, and settling on a single model pack chosen by a declared-in-advance bake-off.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-07-30 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

A measurement pass on 2026-07-29 over 1123 real headlines from `release-main` found that the headline half of this feature is not summarizing — it is copying strings. 85% of headlines opened with `Fix`. 13% lifted a string out of the summarize prompt's own example block, including the label that block holds up as the failure to avoid. 8% opened with a literal tool name (`Edit`, `Bash`, `Write`, `Read`), which means the intent line restated the activity line. 9% carried a path or filename, which is what produced the mid-token truncation seen on the strip (`Write jul29-p…`): `trim_to_word_budget` cannot fire on a path because a path is one whitespace word, so `clip` cuts at `MAX_HEADLINE_CHARS` mid-token. The five register checks in `tests/model-eval/score.py` pass nearly all of these, because they score **form** and every one of these failures is well-formed. The harness cannot see the defect; that is not a bug in the harness, it is the boundary the harness has always declared (see its "What it cannot tell you" section).

Shell routing failed separately and worse. Two real lines meant for Claude were **executed**: `count the number of lines of code with tokei`, and a 134-character request to write a task list for a C calculator project. Both are irreversible by construction — the auto-routed row offers "send to Claude instead", but nothing un-runs a command. Two defects combine to produce this: `LocalModelService.verdict(from:labels:)` scans the label list in order with `String.contains`, and the deck calls it with `["shell", "prompt"]`, so **any** answer mentioning both words resolves to `shell` — the executing verdict — which is backwards from the error budget the feature is designed around. And nothing anywhere checks that a line the model called `shell` is actually shell-*shaped*.

Underneath both problems sits a model question that has been left open too long. The catalog currently offers `ternary-bonsai-8b-2bit` and holds `qwen3-4b-instruct-2507-4bit` in reserve, and a third pack, `lfm25-1-2b-instruct-4bit`, was surveyed, downloaded, and confirmed to load on 2026-07-29. Exactly one pack may ship: two multi-gigabyte downloads is not a configuration this app will ask a user to accept. The bake-off that picks the winner has never been run against a prompt that wasn't leaking answers, so every number recorded before now is suspect.

#### Strategy {#strategy}

- **Fix the irreversible thing first.** The verdict parse and the shell-shape veto are pure logic, need no inference, and remove the only failure mode in this feature that cannot be undone. They land before anything model-dependent.
- **Score truth in Rust, not in the register harness.** `model-eval` scores form because there is no ground truth for "what is this session working on". But there *is* ground truth for "is this headline derived from the digest it was given" — that is a checkable relation between two strings, and it belongs beside the normalizer in `session_overview.rs`.
- **Let the decontamination pay off twice.** With every prompt example now disjoint from every corpus digest, a lifted example is *by definition* ungrounded. The grounding rule subsumes lift detection, so the Rust gate never needs a copy of the Swift example list — and so cannot drift from it ([P05]).
- **Run each half of the bake-off only when its pipeline is final.** Scoring three packs against a prompt about to be rewritten spends inference on a baseline that will not survive ([P02]).
- **Declare the ruling criteria before seeing the numbers.** Otherwise the winner is whichever pack the last run happened to flatter (Table T02).
- **Every step names which harness moves and in which direction.** `just model-eval`, `just model-classify`, `just model-stats`. A step that moves none of them is either infrastructure or it is unfalsifiable.

#### Success Criteria (Measurable) {#success-criteria}

- `just model-classify` reports **zero false SHELL** for the shipping pack, with shell recall no worse than the pre-change baseline for that pack (`qwen` 30/35, `bonsai` 32/35). Verified: the harness exits 0, and its "line(s) meant for Claude were RUN" section is absent.
- Both real 2026-07-29 false-SHELL lines are present in `tests/model-eval/classify-corpus.json` and route to `prompt`. Verified: their per-case marks read `ok`.
- No headline reaches the PULSE strip whose content words are absent from its digest, that restates a single activity line, or that carries a path. Verified: Rust unit tests over `tests/model-eval/corpus` plus the real defective answers recorded in List L01, run by `cargo nextest run -p tugcast session_overview`.
- `just model-stats` reports a **grounding refusal rate** and a **re-ask rescue rate** as first-class numbers. Verified: `python3 tests/model-eval/analyze.py --self-test` passes with the new log line in its fixture set.
- `just model-eval` reports **`copied examples 0/13`** for the shipping pack. Verified: the harness's copied-examples line and its named list.
- The catalog offers exactly one pack. Verified: `catalog_is_internally_consistent` passes, and `CATALOG.iter().filter(|e| e.offered).count() == 1`.
- The headline change rate reported by `just model-stats` does not fall below its pre-change value for a comparable session count — the gate must not buy truth by going silent (Risk R02).

#### Scope {#scope}

1. `LocalModelService.verdict(from:labels:)` — exact-token label matching, replacing the ordered `contains` scan.
2. A PROMPT-only shell-shape veto in `tugdeck/src/lib/shell-line-classifier.ts`, applied at the single routing decision point in `tug-prompt-entry.tsx`.
3. A grounding gate beside `headline_register_report` in `tugrust/crates/tugcast/src/feeds/session_overview.rs`, with a one-shot corrective re-ask.
4. A rewrite of `LocalModelPrompts.summarize` in `tugapp/Sources/LocalModelService.swift` to paired input/output examples.
5. A three-pack bake-off across `just model-classify` and `just model-eval`, and the catalog change that follows from it.
6. New reporting in `tests/model-eval/analyze.py` for refusal and re-ask rates.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Constrained decoding / grammar-constrained output.** It would make the classify parse unfalsifiable-by-construction rather than fixed, and MLX Swift's support is not established at the current pin. Revisit if the veto proves insufficient.
- **Changing `compose_digest`'s wording or section structure.** It was rebalanced in the pulse rearchitecture and any change forces a corpus regeneration; the failures in this plan are not digest-composition failures.
- **Changing `clip`, `MAX_HEADLINE_CHARS`, or `trim_to_word_budget`.** The mid-path truncation is a *symptom* of an ungrounded headline, and the gate removes its cause. Nothing about the truncation code is wrong.
- **A new UI surface for headline staleness.** Considered and declined for this phase (see [P04]); a refusal holds the previous headline silently.
- **Adding MLXVLM or bumping the mlx-swift-examples pin** to reach architectures the current pin lacks. See [#rejected-candidates].
- **Re-scoring the catalog's historical `notes` figures.** Those numbers refer to prompt wordings four rewrites old and are not being refreshed; [P08] states what the freeze rule now means instead.

#### Dependencies / Prerequisites {#dependencies}

- A running instance with a pack installed. `just app-debug` builds, signs, and launches `debug-main`; `tugutil host instance list` reports its port (55302 at time of writing, but read it rather than assuming).
- All three packs installed. `ternary-bonsai-8b-2bit`, `qwen3-4b-instruct-2507-4bit`, and `lfm25-1-2b-instruct-4bit` were present under `~/Library/Application Support/Tug/models/` as of 2026-07-29; confirm with `tugutil host tell local_model_inventory` or by reading each directory's `tug-manifest.json`.
- The frozen digest corpus, `tests/model-eval/corpus/*.digest.txt` (13 entries), pinned by `corpus_digests_are_what_compose_digest_produces`.
- `tests/model-eval/classify-corpus.json` (71 labeled cases: 35 `shell`, 36 `prompt`).

#### Constraints {#constraints}

- **Warnings are errors.** `-D warnings` via `tugrust/.cargo/config.toml`; `cargo build` and `cargo nextest run` both fail on any warning.
- **There is no Swift test target.** `tugapp/` has no `Tests` directory and the Xcode project defines no test target, so Swift-side logic cannot carry a unit test. This directly constrains Step 1's checkpoint (Risk R04).
- **Banned test styles.** No fake-DOM/RTL (`happy-dom`, `jsdom` render, `@testing-library/react`), no mock-store assertion tests. Real-app behavior goes in `tests/app-test/` via the `just` recipes; everything else is pure-logic `bun:test` or `cargo nextest`.
- **App-test selection is derived, not swept.** `just app-test-changed`; every new test needs a `@covers` line. Do not run the full corpus.
- **The register harness cannot see the gate.** `tests/model-eval/harness.py` reads the requester's log line (`local model summarize answered raw=… headline=…`, emitted in `local_model.rs`), which fires *before* `session_overview.rs` decides anything. The gate is therefore invisible to `just model-eval` by construction — see [#harness-reach] for what verifies it instead.
- **The Swift instruction text cannot be varied per request.** `LocalModelPrompts.summarize` is a compile-time constant and the only per-request input is the digest, which is what forces the re-ask to work by appending to the digest ([P04]).
- **No plan-step numbers in durable artifacts.** Not in code, comments, docstrings, test names, or commit messages.

#### Assumptions {#assumptions}

- A headline that is genuinely about the session shares at least half its content words with the digest it was given, allowing for the leading verb (which a digest of tool lines will rarely contain). [Q02] tests this against the corpus before the threshold is fixed.
- Small quantized models form first-word priors from unpaired examples, which is the mechanism behind both the 85% `Fix` monoculture and the 13% lift rate. This is the same reasoning that already produced `classify`'s paired-example block, and that block does not exhibit either pathology.
- The two real false-SHELL lines are representative of the class rather than isolated flukes; `bonsai` reproduces both deterministically and `qwen` reproduces one.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows the devise-skeleton conventions: explicit `{#anchor}` on every heading cited later, `[P##]` for plan-local decisions, `[Q##]` for open questions, `S##` specs, `T##` tables, `L##` lists, `R##` risks, `**Depends on:**` lines carrying `#step-N` anchors, and `**References:**` lines citing labels and anchors, never line numbers.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Does pairing the summarize examples with inputs actually reduce lifting, or only change which strings get lifted? (DECIDED) {#q01-pairing-effect}

**Question:** `classify`'s paired-example block does not produce lifting; `summarize`'s unpaired block does. Is pairing the cause of that difference, or is it confounded by the two tasks' different output spaces (one closed label vs open prose)?

**Why it matters:** If pairing does not help, the prompt rewrite is churn, and the grounding gate is carrying the entire fix alone. That is survivable — the gate is the backstop either way ([P03]) — but it changes whether the rewrite is worth keeping.

**Options (if known):**
- Pairing reduces lifting materially: keep the rewrite, and the gate refuses less often.
- Pairing changes the lifted strings but not the rate: keep the rewrite only if the `Fix` monoculture improves, and lean entirely on the gate.
- Pairing makes register worse (a 1.2B pack may hold form better from bare exemplars): revert to unpaired and rely on the gate.

**Plan to resolve:** Step 6 measures `copied examples N/13` for all three packs against both the old and new prompt wording. `run.py` already reports this line, so the comparison is a direct read.

**Resolution:** **DECIDED — pairing works.** On the unpaired prompt the gate refused 13 of 13 `lfm25` answers; on the paired one, 5. `qwen`'s copied-example count went 1/13 to 0/13 and both its remaining refusals changed from example lifts to tool-name openers. The rewrite stays. See [#bakeoff-results].

#### [Q02] What grounding threshold refuses the real defects without refusing good headlines? (DECIDED) {#q02-grounding-threshold}

**Question:** Spec S01 requires "at least half the headline's content words appear in the digest". Is one-half right? A good headline may legitimately use a synonym the digest never spells (`Salvage corrupted changes ledger` against a digest that says *recover*).

**Why it matters:** Too strict and the gate refuses good headlines, the strip goes stale, and the liveliness the pulse depends on is lost (Risk R02). Too loose and lifted examples survive.

**Options (if known):**
- Require ≥50% of non-verb content words grounded.
- Require ≥1 grounded content word (very loose; catches only pure hallucination).
- Require all-but-one grounded (very strict).

**Plan to resolve:** Spike in-thread during #step-4. The inputs already exist: the 13 frozen digests, the headlines each pack produced against them (recorded by `run.py --json`), and the real defective answers in List L01. Sweep the threshold over that set and pick the value that rejects every entry in L01 while accepting every headline a human reads as correct. Record the chosen value and the sweep in the step's commit.

**Resolution:** **DECIDED — two thirds of the subject words**, swept in #step-4 over the 13 frozen digests and the real defective answers rather than argued.

The band is one word wide. Correct headlines ground no worse than 2/3 (`Explain maxwell equations and primality` against `conversation-only` is the tightest); the surviving defects ground 3/5 (`Fix typing lag in command-line calculator` against `parts-list-tail`, which really was about a command-line calculator — the words it invents are the ones that matter) and 1/3. So one half accepts a real defect and three quarters refuses a correct headline: two thirds is simultaneously the loosest value that refuses every defect and the strictest that accepts every correct one. Pinned by `the_grounding_threshold_is_the_loosest_that_still_refuses_the_defects`, because a constant that narrow is not safe as a comment.

#### [Q03] Can a 1.2B pack hold six-word register under a paired-example prompt? (DECIDED) {#q03-lfm-capacity}

**Question:** `lfm25-1-2b-instruct-4bit` is a third the parameters of the incumbent. Its two smoke answers were in register (`Wire local_model test run`, 4 words, verb-first), but two answers is not a measurement, and a paired-example prompt is longer and more structured than the current one.

**Why it matters:** It is the ruling criterion most likely to separate the packs, and it is the pack whose 0.66 GB download would otherwise win on size outright.

**Plan to resolve:** #step-6 scores all 13 digests. Watch normalizer rescue count specifically — a pack that passes the rubric only after `headline_register_report` rewrites it is drifting, and the rescue count sees that where the pass rate does not.

**Resolution:** **DECIDED — no.** `lfm25` holds register 3/13 under the paired prompt, down from 10/13 on the shorter unpaired one, and lifted one example phrase across three unrelated digests. Size and latency cannot buy that back. See [#bakeoff-results].

#### [Q04] Should a retired-but-installed pack keep answering? (DECIDED) {#q04-retired-pack-behavior}

**Question:** When the catalog demotes a pack to `offered: false`, a user who already installed it keeps a pack that is downloadable, selectable, and `auto`-eligible. Is that the desired behavior?

**Resolution:** DECIDED — yes, unchanged. The `CatalogEntry` docstring already states the intent ("a non-offered entry is otherwise fully supported… it simply is not part of the first-run choice"), `resolveRoute` honors an explicit pick literally, and `local-model-store.ts` already wires a `local_model_delete` control frame so the bytes are reclaimable from the existing UI. No new affordance is needed.

**But the second half of this — "`auto` resolves to the new winner, which follows from `catalog_rank` ordering" — was wrong, and #step-7's inspection found it.** It does not follow. `catalog_rank` is copied into each pack's `tug-manifest.json` **at install time**, precisely so the Swift service can order packs without knowing the catalog, and `resolveRoute`'s `auto` branch takes `LocalModelStore.installed().first` sorted by *that recorded* rank. Reordering `CATALOG` therefore does not reorder what is already on disk: a user who installed the old recommended pack keeps a stamp claiming rank 0 and keeps being routed to the retired pack indefinitely. Swift cannot re-derive the rank — not knowing the catalog is the whole reason the field exists.

`reconcile_catalog_ranks` in `local_model.rs` closes it, rewriting a drifted rank and nothing else. It runs once from `main`, gated on `TUG_INSTANCE_ID` naming a real instance, because the models directory is shared machine-wide and the integration tests spawn this binary.

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| R01 Prompt tuned to the losing pack | med | med | Score the rewrite on all three packs in the same step that rules ([P02]) | A pack wins classify but loses register |
| R02 Gate refuses too often; strip goes stale, emitter throughput drops | high | med | One corrective re-ask, skipped when the emit slot is contended ([P04]); refusal + rescue rates reported by `model-stats`; headline change rate is an exit criterion | Refusal rate above ~20% of ticks, or headline change rate below its pre-change value |
| R03 Veto collapses shell recall | med | low | Veto is PROMPT-only and gated on `model-classify` shell recall not regressing | Shell recall drops below baseline |
| R04 Swift parse fix has no unit test | med | high | Falsify through the real path (`just model-classify`) plus a crafted probe; see [#harness-reach] | Any future Swift-side logic of comparable consequence |
| R05 LFM2.5 quirks under an 8-token classify budget | med | med | `just model-classify` is run against it in #step-3 before anything is tuned to it | `outcome=refused` rate materially above the other packs |

**Risk R01: The prompt gets tuned to a pack that does not ship** {#r01-prompt-tuned-to-loser}

- **Risk:** The paired-example rewrite is iterated against whichever pack is convenient, then a different pack wins the bake-off and inherits a prompt shaped for someone else.
- **Mitigation:**
  - #step-6 scores the new prompt on all three packs and rules in the same step, so no pack has a tuning head start.
  - The rewrite's acceptance criteria are pack-independent (paired structure, corpus disjointness, verb variety), not "scores well on X".
- **Residual risk:** The author's intuition about what wording works is inevitably formed on whichever pack they iterate against. The gate limits the damage: a prompt that serves the winner poorly shows up as a high refusal rate, not as a wrong headline on the strip.

**Risk R02: Truth is bought with silence — per session, and across the emitter** {#r02-gate-goes-quiet}

- **Risk:** Two distinct failures wear the same face. **Per session:** the gate refuses so often that one session's headline stops moving. **Across the emitter:** because `spawn_next` keeps exactly one emit in flight at a time and `SUMMARIZE_TIMEOUT` is 6 s, a refusing session that re-asks holds the only emit slot for up to 12 s, so *every queued session* goes stale behind it. The second failure is the more dangerous one because no per-session number reveals it — the refusing session looks like it is working hard while the others simply never get their turn.
- **Mitigation:**
  - The re-ask is skipped whenever the emit slot is contended ([P04]), so a busy emitter never spends double inference on one session. A session with peers waiting takes the hold instead.
  - The refusal rate and the re-ask rescue rate are both reported by `just model-stats`, so the per-session trade is measured rather than assumed.
  - The headline change rate — already the standing "is the headline still tracking the work" number, and an aggregate across sessions — is the number that sees the *throughput* failure, and it is an exit criterion. A gate that buys truth with silence fails the phase whichever way the silence arrives.
- **Residual risk:** A session whose digest reliably provokes refusals sits on a stale headline. This is the accepted trade: a stale headline was true when it was written, and a wrong one never was.

**Risk R04: The Swift parse fix cannot be unit-tested** {#r04-no-swift-tests}

- **Risk:** `tugapp/` has no test target, so the single most consequential logic change in this plan — the one that stops prose from executing — lands with no test pinning it.
- **Mitigation:**
  - `just model-classify` exercises the real parse over 71 labeled lines through the live app, and is a one-sided gate.
  - The crafted probe in #step-1 puts a line to the model whose answer historically contains both label words, and the log's `verdict=` field records what the parse made of it.
  - The `outcome(of:)` classification already distinguishes `refused` from `error`, so ambiguity is observable in `model-stats` rather than silent.
- **Residual risk:** A future edit to `verdict(from:labels:)` can regress it with nothing failing until someone runs a harness that spends inference. Standing up a Swift test target is a worthwhile follow-on (see [#roadmap]).

---

### Design Decisions {#design-decisions}

#### [P01] One pack ships, and the ruling criteria are fixed before the numbers are seen (DECIDED) {#p01-one-pack}

**Decision:** Exactly one catalog entry is `offered` at phase end. The winner is chosen against the priority order in Table T02, which is fixed by this document before any bake-off runs.

**Rationale:**
- Two multi-gigabyte downloads is not a configuration this app asks a user to accept.
- Criteria declared after the fact select whichever pack the last run flattered. Declaring them first makes the bake-off a measurement rather than a rationalization.

**Implications:**
- `catalog_is_internally_consistent` already asserts exactly one `recommended` entry and that a recommended entry is `offered`; #step-7 adds an assertion that exactly one entry is `offered`.
- The losing packs stay in `CATALOG` as `offered: false`, which keeps them downloadable and selectable for future bake-offs at zero user-facing cost ([Q04]).

#### [P02] Model-independent fixes land first; the bake-off runs in two halves, each after its own pipeline is final (DECIDED) {#p02-sequencing}

**Decision:** The verdict parse and shell-shape veto land first, then the classify half of the bake-off. Then the grounding gate and the prompt rewrite, then the register half of the bake-off, which is where the ruling happens.

**Rationale:**
- A classify baseline taken before the parse fix measures a pipeline being deleted: the same model output resolves differently afterwards.
- A register baseline taken before the prompt rewrite measures wording being replaced.
- Splitting the bake-off is strictly better than one monolithic run: each half executes when the pipeline it scores is final, and neither half is spent twice.
- The irreversible defect (prose executing) is fixed first on principle, independent of any measurement.

**Implications:**
- The ruling cannot happen until both halves are in hand, so #step-6 carries the decision and #step-3 only collects.
- The pre-existing two-pack numbers become the "before" record and are not re-taken.

#### [P03] The grounding gate lives in Rust beside the normalizer, and refuses rather than rewrites (DECIDED) {#p03-gate-in-rust}

**Decision:** A pure function in `session_overview.rs`, adjacent to `headline_register_report`, decides whether a candidate headline is grounded in the digest it was given. A refused headline is not emitted; the previous headline stands. The gate never edits a headline's content.

**Rationale:**
- Rust is the only place that holds both strings — the digest that was sent and the headline that came back. The Swift service sees the digest but has no memory of prior headlines; the deck sees neither.
- Rewriting would be paraphrase, which is a second model with none of the first one's context. The normalizer's docstring already establishes this boundary ("Mechanical only… never rewrites content") and the gate honors it.
- Refusal is the only action that cannot itself be wrong. A gate that edits can introduce a new falsehood; a gate that declines cannot.

**Implications:**
- The gate is invisible to `just model-eval` (see [#harness-reach]); its verification is Rust unit tests plus `model-stats` telemetry.
- `apply_emit_outcome`'s existing empty-headline and unchanged-headline early returns are the natural precedent — a refusal is a third reason not to emit.

#### [P04] A refusal re-asks once with the failure named, then holds (DECIDED) {#p04-reask-once}

**Decision:** On refusal, the emitter re-asks the model once, appending a corrective line to the **digest** that names the rejected headline and the specific rule it broke — **but only when no other session is waiting for the emit slot.** If the second answer also fails the gate, or the re-ask was skipped, the previous headline stands until the next tick.

**Rationale:**
- Liveliness is a stated requirement of the pulse. A gate with no recovery path trades a visible wrongness for an invisible staleness (Risk R02).
- A small model told precisely what was wrong with its answer usually produces a better one; a blind retry at temperature 0 would produce the identical answer and is worthless.
- The queue condition is not a nicety. `spawn_next` runs `while in_flight.is_none()`, so **exactly one emit is in flight at a time across all sessions**, and `SUMMARIZE_TIMEOUT` is 6 s. An unconditional re-ask therefore lets one refusing session hold the only emit slot for up to 12 s while every queued session waits — refusals would degrade liveliness *globally*, not just for the session that refused, which is the opposite of what [P04] exists to protect.
- With the slot uncontended, a second inference costs nothing anyone can observe: the summarize path is off the user's critical path (unlike classify), and the tick was already committed at spawn.

**Implications:**
- The correction rides on the digest because `LocalModelPrompts.summarize` is a compile-time Swift constant and the digest is the only per-request input. This forces bookkeeping care: the re-ask sends `digest + correction` but `EmitOutcome.seen_digest` must record the **original** digest, or `last_digest` dedup breaks and the next tick re-summarizes identical evidence.
- `run_emit` cannot see the queue — `EmitJob` carries no view of it. So `spawn_next` must pass the decision in as a field on `EmitJob` (a `may_reask: bool` set from `queue.is_empty()` at spawn time). Reading a live queue from the spawned task would be a lock across the loop boundary and is not the design.
- Two log lines per refused tick, distinguishable so `analyze.py` can compute a rescue rate: a refusal line and a re-ask outcome. The skipped-re-ask case must be distinguishable from the attempted-and-failed case, or the rescue rate divides by the wrong denominator.
- Temperature is 0, so the correction text is the only thing that can change the answer. If re-asks are never rescued in practice, [P04] should be revisited in favor of the cheaper hold-only behavior.

#### [P05] The Rust gate holds no copy of the Swift example list (DECIDED) {#p05-no-example-copy}

**Decision:** The gate detects a lifted prompt example through the grounding rule alone. It does not carry a list of the examples.

**Rationale:**
- Every example in `LocalModelPrompts.summarize` is now disjoint from every corpus digest — that was the fourth-pass decontamination, and `run.py`'s `contamination()` check refuses to score a pair that violates it.
- Disjointness means a lifted example's content words are, by definition, absent from the digest. The grounding rule already rejects it.
- A duplicated example list in Rust would be a second source of truth that goes stale silently the first time someone edits the Swift string — which is precisely the failure mode the corpus freeze test exists to prevent elsewhere.

**Implications:**
- The decontamination is now load-bearing for the gate, not merely for the harness. The `run.py` contamination check becomes a de facto invariant of the gate's correctness, and the summarize docstring's closing instruction ("an example drawn from the corpus is an answer key, not a demonstration") should say so.

#### [P06] The verdict parse matches an exact token; ambiguity stays a refusal, not a synthesized PROMPT (DECIDED) {#p06-exact-token-parse}

**Decision:** `verdict(from:labels:)` tokenizes the model's output and matches a label only against the **first** label-like token, case-insensitively and punctuation-stripped. An output naming two labels, or none, returns `nil` — unchanged from today.

**Rationale:**
- The bug is specifically the ordered `contains` scan against `["shell", "prompt"]`: an output like `PROMPT (not SHELL)` resolves to `shell` today. Fixing the scan is the whole fix.
- Returning `nil` on ambiguity is already safe and already *better instrumented* than synthesizing `prompt` would be. The existing degraded path is: `nil` → `.failure("classification did not name a label")` → the bridge's `requestClassify` returns `null` → `tug-prompt-entry.tsx` routes to Claude because only an explicit `shell` verdict routes. Identical user-visible outcome, but `outcome(of:)` logs it as `refused`, which `model-stats` can count. Synthesizing `prompt` would log `ok` and erase the signal that the prompt is misbehaving.
- Keeping the failure visible matters more here than tidiness, because there is no Swift test to catch a regression (Risk R04).

**Implications:**
- No change to the deck, the bridge, or the degradation contract — the module docstring in `shell-line-classifier.ts` already promises that every degraded path resolves to Claude, and this preserves it exactly.
- `refused` becomes a number worth watching per pack in #step-3.

#### [P07] The shell-shape veto is PROMPT-only, and that is what distinguishes it from the rules that were removed (DECIDED) {#p07-prompt-only-veto}

**Decision:** A pure predicate in `shell-line-classifier.ts` may veto a `shell` verdict, turning it into a route to Claude. It can never produce a `shell` verdict, and it is never consulted on a `prompt` verdict.

**Rationale:**
- The module docstring records that an earlier revision's stopword list, ambiguous-opener list, and token-count rule were deliberately **removed**. Read carefully, the stated reason is that they *pre-empted the model on lines it should have seen* — "the classifier decided `which bun` and `open .` by itself and delegated only the leftovers." Those rules decided **toward shell**, and in doing so they took the irreversible decision away from the model without adding any safety.
- A PROMPT-only veto is the opposite instrument. It cannot pre-empt the model toward shell because it has no power to route to shell. It can only decline to execute, which is the direction the docstring's own asymmetry argument says doubt must resolve: "every degraded path here resolves to Claude… The shell is reached only by an explicit `shell` verdict." The veto adds one more degraded path to that list; it does not create a new way in.
- The distinction is therefore not a loophole in the old decision but an application of the reasoning behind it.

**Implications:**
- The veto's own docstring must make this argument in the module's terms, so the next reader does not mistake it for the return of the deleted rules.
- Applied at the routing decision point in `tug-prompt-entry.tsx`, where `verdict === "shell"` gates `routeToShell()`. It must also be applied before a `shell` verdict enters `ShellVerdictCache`, or a vetoed verdict would be cached and consulted again.
- Pure and DOM-free, so it is a plain `bun:test` file alongside `shell-line-classifier.test.ts`.

#### [P08] The prompt freeze rule protects bake-off comparability, not historical scores (DECIDED) {#p08-freeze-rule-restated}

**Decision:** `LocalModelPrompts`' freeze rule stands, restated: the wording must be identical across every pack in a single bake-off, and editing it is a deliberate act that invalidates the current bake-off and requires re-running it. It no longer claims to protect the scores recorded in `CatalogEntry.notes`, which refer to wordings four rewrites old.

**Rationale:**
- The docstring already concedes the recorded scores are stale and explains why they are not being refreshed. Leaving the freeze rule phrased as though it protects them makes the whole docstring read as bookkeeping nobody maintains.
- The property actually worth protecting is that a three-way comparison is a comparison — same wording, same corpus, same normalizer.

**Implications:**
- The docstring's fifth paragraph is rewritten in #step-5 to say this plainly.
- A future pack added to the catalog is scored on the then-current wording, and the bake-off is re-run rather than its old numbers being compared across wordings.

---

### Deep Dives {#deep-dives}

#### The three packs, and what the registry already ruled out {#rejected-candidates}

**Table T01: The packs on the table** {#t01-packs}

| id | on disk | `model_type` | notes |
|---|---|---|---|
| `ternary-bonsai-8b-2bit` | 2.31 GB | — | Current `recommended: true`. 2-bit ternary. Being retired unless it wins. |
| `qwen3-4b-instruct-2507-4bit` | 2.28 GB | `qwen3` | Current front-runner, `offered: false`. ctx 262144. |
| `lfm25-1-2b-instruct-4bit` | 0.66 GB | `lfm2` | Liquid on-device line, added 2026-07-29 as `offered: false`. ctx 128000. Non-thinking (a separate `Thinking` sibling carries CoT). Smoke answers: 408 ms cold, 268 ms warm, in register. |

The **architecture registry is the first filter on any candidate**, and it is cheap. `LocalModelBackend` imports MLXLLM and resolves a pack through mlx-swift-examples' `LLMModelFactory`, so a pack whose `config.json` `model_type` is unregistered fails the load outright rather than degrading. At the current pin (mlx-swift-examples 2.29.1, mlx-swift 0.29.1) the registry holds: `acereason`, `baichuan_m1`, `bailing_moe`, `bitnet`, `cohere`, `deepseek_v3`, `ernie4_5`, `exaone4`, `falcon_h1`, `gemma`, `gemma2`, `gemma3`, `gemma3_text`, `gemma3n`, `glm4`, `gpt_oss`, `granite`, `granitemoehybrid`, `internlm2`, `lfm2`, `lfm2_moe`, `llama`, `mimo`, `mistral`, `nanochat`, `olmo2`, `olmoe`, `openelm`, `phi`, `phi3`, `phimoe`, `qwen2`, `qwen3`, `qwen3_moe`, `smollm3`, `starcoder2`. This check is now recorded in the `CATALOG` docstring, because skipping it cost a wasted 2.78 GB download.

Three candidates were surveyed and rejected. Do not reopen them without new information:

- **`Qwen3.5-4B`** (Mar 2026, 3.06 GB): thinks by default, and no Instruct/non-thinking variant was released for the 3.5 line — it is an open community request, not an available artifact. With `summarizeMaxTokens = 24` and `classifyMaxTokens = 8`, a pack that emits `<think>` spends its entire budget before saying a word.
- **`gemma-4-E2B-it-qat-4bit`** (Jun 2026): the strongest small pack available and Apache-2.0, but the E-series stores full parameters on disk regardless of "effective" count — 4.36 GB, roughly 1.9× the budget — and `gemma4` is not in the registry either.
- **`Ministral-3-3B-Instruct-2512-4bit`** (Dec 2025, 2.78 GB): the best fit on paper — Mistral's edge line, vendor-documented for text classification and short content generation, non-thinking by construction, 256k ctx. But it is `mistral3` (`Mistral3ForConditionalGeneration`, with a Pixtral vision tower), which appears nowhere in mlx-swift-examples at any version, MLXVLM included. It cannot be loaded without implementing the architecture. Its download was deleted; re-acquiring it is cheap if a future pin adds `mistral3`.

**Table T02: Ruling criteria, in priority order, fixed before the bake-off** {#t02-ruling-criteria}

| Priority | Criterion | Why it ranks here |
|---|---|---|
| 1 | False SHELL count (`just model-classify`) | The only irreversible error in the feature. A pack that executes prose is disqualified regardless of anything else. |
| 2 | Grounding refusal rate + copied-example count (`just model-eval`, `model-stats`) | Measures whether the pack is summarizing or copying. A pack the gate must constantly refuse is not doing the job even if the strip stays honest. |
| 3 | Normalizer rescue count (`just model-eval`) | Register drift the pass rate hides. A pack passing the rubric only after `headline_register_report` rewrites it is drifting. |
| 4 | Download size | A real user-facing cost, already objected to once. A 0.66 GB pack that ties on 1–3 wins. |
| 5 | Median latency, both tasks | Matters, but classify already has a 2000 ms deck deadline all three packs clear comfortably. |
| 6 | Raw register pass rate (`all rules N/13`) | Ranks last deliberately: it is the number that reported 13/13 over a leaking prompt. It is a sanity floor, not a discriminator. |

#### The four failure signatures, with the real answers that produced them {#failure-signatures}

**List L01: Real defective headlines, and which gate rule catches each** {#l01-defects}

These are actual answers observed in production or in the eval harness. Each must be rejected by the gate, and each becomes a Rust unit-test case in #step-4.

1. `Bash make` — against `parts-list-tail`, whose *right now* section opens `- Bash(make)`. Caught by the **tool-name opener** rule (first word is a tool name present in the digest) and independently by **activity restatement** (every content word comes from one activity line). Also fails `verb_first` in `score.py`, but nothing enforced that at runtime.
2. `Write jul29-p…` — the mid-token truncation seen on the strip. Caught by the **path-bearing** rule: the headline's second token came from inside a digest tool target, and `clip` cut it mid-token because a path is one whitespace word and `trim_to_word_budget` cannot fire on it. Fixing the cause removes the symptom; `clip` needs no change.
3. `Fix cursor loss after descend` — returned by `qwen` against `tools-without-prompts`, deterministically, twice. It is example #4 from the decontaminated prompt, verbatim. Caught by **grounding**: the examples are disjoint from every digest ([P05]), so its content words are absent.
4. `Wire schema migration backfill` — returned by `lfm25` on a live tick. It is the positive rewrite inside the prompt's *negative-example* paragraph. Caught by **grounding**, same mechanism.
5. `Fix lagging editor input`, `Fix sed command lagging`, `Fix typing lag in command-line calculator` — the cluster from session `lag/2a4460f9`. Caught by **grounding** where the content words are absent from the digest, and the third also fails `no_article`.

The distribution behind these: 85% `Fix` openers, 13% prompt-example lifts, 8% tool-name openers, 9% path-bearing, out of 1123 headlines. Note that all three packs exhibit lifting — this is not a `bonsai` artifact, which is why [P03] and not a model swap is the fix.

#### Bake-off Results {#bakeoff-results}

Filled in by #step-3 (classify half) and #step-6 (register half). Both halves must be complete before the ruling, per [P02]. `lfm25` has no prior baseline, so its first numbers *are* its baseline.

**These tables are historical.** Every number below was taken against the pipelines this plan shipped — six-word headlines, the pre-grammar classify prompt, the pre-current-ask digest corpus. `dash/local-model-flow.md` rewrote all three, and this plan's own freeze rule ([P08]) says a prompt edit invalidates the standing bake-off. Read these as the record of what was measured then; the ruling in force is the one in that plan, not the one below.

**Table T03: Classify half — filled by #step-3** {#t03-classify-results}

Taken on `debug-tugdash-model-trust` (the dash's own debug instance; `debug-main` was not running). `false SHELL` is what production would have run — the model's verdict after the veto — and it is what the exit code answers. `pack's own` is the unfiltered model verdict, which is the Table T02 priority-1 discriminator now that the veto clears all three.

| pack | scored | accuracy | false SHELL | pack's own false SHELL | false PROMPT | shell recall | prompt recall | median ms |
|---|---|---|---|---|---|---|---|---|
| `ternary-bonsai-8b-2bit` | 70/71 | 67/70 | **0** | 2 | 3 | 31/34 | 36/36 | 828 |
| `qwen3-4b-instruct-2507-4bit` | 71/71 | 66/71 | **0** | 1 | 5 | 30/35 | 36/36 | 636 |
| `lfm25-1-2b-instruct-4bit` | 70/71 | 66/70 | **0** | **17** | 4 | 31/35 | 35/35 | 427 |

Pre-change reference, taken against the old parse and no veto, on the decontaminated prompt: `bonsai` 66/71 with 2 false SHELL, 3 false PROMPT, 32/35 shell recall, 623 ms; `qwen` 65/71 with 1 false SHELL, 5 false PROMPT, 30/35 shell recall, 416 ms.

**What removed each false SHELL: the veto, not the parse.** The parse fix removed none. Both packs with recorded baselines answer classify with a bare label — 5 characters for `shell`, 6 for `prompt`, visible as `output_chars` on the app's own request line — so the ordered-`contains` pathology has no answer to fire on, and `qwen`'s post-parse numbers came back identical to its pre-change baseline in every field. Probing `bonsai` directly on both real 2026-07-29 lines returned a clean single-token `shell` for each. The parse fix is a structural guard against a class of answer neither shipping pack produces; the veto is what made the gate pass.

**`lfm25` is disqualified on Table T02 priority 1.** It called 17 of 35 prose lines `shell`. Every one was refused by the veto, so nothing would have run — but a pack that reaches for the irreversible verdict on half the prose it sees is leaning on the veto as its classifier rather than being checked by it, and priority 1 is about the pack's own judgement for exactly this reason. Its 427 ms median and 0.66 GB download cannot buy that back, because size and latency rank fourth and fifth.

**The harness could not see the veto until this step changed it.** `classify.py` drives the control socket, so its reach ends at `LocalModelService` — the deck, where `vetoesShellVerdict` lives, is not on that path. The success criterion "zero false SHELL" was therefore unreachable by construction, the same blind spot [#harness-reach] records for the grounding gate and `model-eval`. `classify.py` now applies the real veto by running `tests/model-eval/veto-filter.ts` through bun and reports both numbers; the rules are imported, never re-expressed in Python.

On this corpus the veto is total: it refuses all 36 prose-labeled lines and none of the 35 commands. That is a strong result and also a limit on what the corpus can still discriminate — post-veto false SHELL is now 0 for any pack, so priority 1 has to be read off the `pack's own` column.

**Table T04: Register half — filled by #step-6** {#t04-register-results}

Both halves taken on the paired-example prompt from #step-5. **Refused** is the grounding gate run over each pack's own 13 answers — the number `model-eval` cannot see, obtained by running the real `ground_headline` over `run.py --json` captures.

| pack | `all rules` | rescues | **refused** | refused (old prompt) | `copied examples` | mean words | median ms |
|---|---|---|---|---|---|---|---|
| `ternary-bonsai-8b-2bit` | 11/13 | 3 | **2/13** | 3/13 | 0/13 | 5.0 | 1647 |
| `qwen3-4b-instruct-2507-4bit` | 9/13 | 0 | **2/13** | 2/13 | 0/13 | 4.5 | 1245 |
| `lfm25-1-2b-instruct-4bit` | 3/13 | 1 | **5/13** | 13/13 | 0/13 | 3.8 | 422 |

Old-prompt reference, same instance, unpaired examples: `bonsai` 12/13 with 5 rescues and 0/13 copied; `qwen` 12/13 with 0 rescues and **1/13** copied (`Fix cursor loss after descend` against `tools-without-prompts` — example #4, verbatim); `lfm25` 10/13 with 2 rescues and 0/13 copied.

**[Q01] resolved: pairing works, and `copied examples` was measuring the wrong thing.** The `lfm25` column is the whole answer — on the unpaired prompt the gate refused **13 of 13**, because it returned `Wire schema migration backfill` or `Fixing schema migration` for *every digest in the corpus*, including `conversation-only` and `parts-list-tail`. `run.py` scored that run `copied examples 0/13` and `all rules 10/13`. The register harness called the pack healthy while it was emitting one lifted string thirteen times. Pairing took it to 5/13. `qwen`'s copied count went 1/13 → 0/13 and, more tellingly, the *character* of its two refusals changed completely: they were prompt-example lifts (`Fix cursor loss after descend`, `Wire filetree cursor loss`) and are now both tool-name openers (`Write mlxspike fetch script`, `Write local-model-investigations.md`). Lifting is gone from the front-runner; what is left is the intent/activity collapse, which is a different failure with a different fix.

`copied examples` under-reports by construction: `lifted()` matches the whole word set, so `Fixing keymap conflicts` against the example `Resolve keymap shortcut conflicts` scores as clean. Every lift this bake-off found was found by the gate, not by the count. That is the case for [P05] made in numbers — the grounding rule subsumes lift detection and does it better.

**[Q03] resolved: no.** `lfm25` holds register 3/13 under the paired prompt, down from 10/13 on the shorter unpaired one — a longer, more structured prompt is exactly what a 1.2B pack cannot hold. It answered `two-goals-one-session` with the single word `Fix`, `conversation-only` with `Fix the session`, and `Fixing keymap conflicts` — a phrase lifted straight out of an example — for three unrelated digests. Its 422 ms median and 0.66 GB download are real, and they are not close to enough.

**The cost of the rewrite, stated plainly.** `bonsai` and `qwen` both lost raw register: 12/13 → 11/13 and 12/13 → 9/13. Part of that is off-list verbs scoring as misses on purpose (`qwen` opened with `Launch` and `Fire`, neither on `verbs.txt`), part is real (`Hardened Tug app auto update flow` is past tense; `Build calc with make and readme` uses `and`). Summarize latency also roughly doubled, because six paired digests are a much longer instruction than eight bare lines — `qwen` 631 ms → 1245 ms, well inside `SUMMARIZE_TIMEOUT` and off the user's critical path, but not free. Raw register ranks sixth in Table T02 deliberately: it is the number that reported 13/13 over a prompt that was leaking answers.

#### The ruling {#the-ruling}

**`qwen3-4b-instruct-2507-4bit` ships.** Walking Table T02 in order:

1. **False SHELL.** `qwen` 1, `bonsai` 2, `lfm25` 17. `qwen` wins and `lfm25` is disqualified outright — a pack that reaches for the executing verdict on half the prose it sees is being saved by the veto rather than checked by it.
2. **Grounding refusals + copied examples.** `bonsai` 2/13, `qwen` 2/13, `lfm25` 5/13. A tie at the top. `qwen`'s two are tool-name openers and `bonsai`'s two are borderline ungrounded paraphrases (`Fix tmux static build checksum failure` against a digest that says the checksum step failed on a gzip); neither pack lifts examples any more.
3. **Normalizer rescues.** `qwen` 0, `lfm25` 1, `bonsai` 3. `qwen` wins clearly — it writes headlines that are already in register rather than ones the normalizer has to cut down, and rescue count is exactly the drift the pass rate hides.
4. **Download size.** `lfm25` 0.66 GB would win, and cannot: it lost at priority 1. `qwen` 2.28 GB edges `bonsai` 2.31 GB, which is not a real difference.
5. **Latency.** `qwen` 1245 ms summarize / 636 ms classify beats `bonsai` 1647 / 828 on both. `lfm25` is fastest and disqualified.
6. **Raw register.** `bonsai` 11/13, `qwen` 9/13. The one criterion `bonsai` wins, and the one ranked last on purpose.

So the packs separated at **priority 1 and priority 3**: `lfm25` is out on the irreversible-error criterion, and `qwen` beats `bonsai` on register drift while tying on grounding. `bonsai` wins only the criterion this plan trusts least.

This **agrees** with the earlier two-pack read, which had `qwen` ahead on rescues (0 vs 5) and latency and behind on nothing that mattered. What has changed is the confidence: that read was taken against a prompt whose examples were answer keys, and `qwen`'s single copied example was the visible symptom. On a paired, decontaminated prompt it copies nothing.

**Sampling parameters: unchanged, deliberately.** `Qwen3-4B-Instruct-2507`'s card recommends temperature 0.7 / top-p 0.8 for open-ended generation. `LocalModelJob` sends temperature 0 for both tasks and keeps doing so. Classify has an 8-token budget and one correct answer out of two; summarize has 24 tokens and is scored by harnesses that must reproduce. Sampling would buy variety in a place where variety is the defect — and it would make `just model-classify`'s one-sided gate non-deterministic, which is the last property to trade away.

---

#### What can and cannot verify the gate {#harness-reach}

There are two summarize log lines, from two different files, and they see different things:

- `local model summarize answered raw=… headline=… normalized=… trimmed=… clipped=…` — emitted in `tugcast/src/local_model.rs`, at the requester. This is what `tests/model-eval/harness.py` scrapes, and therefore what `just model-eval` scores.
- `session overview: summarized raw=… headline=… normalized=… trimmed=… clipped=…` — emitted in `session_overview.rs`, inside the emit path, plus `session overview: emitted` when a frame actually goes out.

The grounding gate lives in the second path only. **`just model-eval` cannot see it**, and a Python reimplementation of the gate inside `run.py` would be a second source of truth that drifts — the same failure that once left the eval corpus scoring bytes the shipping code no longer produced (the README records this). So the gate's verification is split deliberately:

- **Correctness** is Rust unit tests over `tests/model-eval/corpus` — the *same 13 digests* `run.py` uses — plus every entry in List L01. Run by `cargo nextest run -p tugcast session_overview`.
- **Live behavior** is `just model-stats`, which gains a refusal rate and a re-ask rescue rate from the new log lines. `analyze.py --self-test` pins the parser against captured real lines of every shape, so a format drift shows as a zero rather than as silence.
- **The model's own copying** remains `just model-eval`'s `copied examples N/13` line, which is upstream of the gate and is exactly the signal that tells you whether the gate is being asked to work hard.

The same asymmetry applies to the Swift parse fix: with no Swift test target, `just model-classify` through the live app is the falsification instrument (Risk R04).

---

### Specification {#specification}

**Spec S01: The grounding gate** {#s01-grounding-gate}

A pure function in `session_overview.rs`:

```rust
pub enum GroundingVerdict {
    Grounded,
    Ungrounded { rule: &'static str, detail: String },
}

pub fn ground_headline(headline: &str, digest: &str) -> GroundingVerdict
```

It is called on `headline_register_report(&text).text` — after the normalizer, so the gate judges the string the strip would actually wear. It rejects on the first rule that fires, in this order:

1. **Empty** — an empty headline after register. (Also checked in `apply_emit_outcome` today; checking it here means the gate is total over its input and callers need no pre-check.)
2. **Tool-name opener** — the headline's first word, lowercased, equals the tool name of any activity line in the digest. Activity lines are `Name(target)` or bare `Name` (see `tool_line`), so the tool-name set is derived from the digest itself rather than from a hardcoded list, and a new Claude tool needs no change here.

   **The parse must be section-aware, and this is not optional.** `compose_digest` emits the user's prompts as `- <text>` lines too, under `What the user asked for:`. A naive scan of every `- ` line would admit prompt text into the tool-name set — `parts-list-tail`'s digest contains `- write a command line calculator in c`, which would put `write` in the set. Generalized, an ask opening `fix the lag…` poisons the set with `fix`, and the gate then refuses every legitimate `Fix …` headline for that session. Since `Fix` is the most common opener in the corpus by a wide margin, an unscoped parse is a false-positive generator aimed at the common case. Only lines following an activity heading (`What the session has been doing:` or `What it is doing right now:`) may contribute, and a contributing line must match the `Name(target)` form or be a single bare token that is shaped like a tool name (leading capital, no whitespace — `Bash`, `TodoWrite`).

   Section-awareness alone is *not* sufficient, which is why the shape test is also required: `compose_digest` synthesizes a `What it is doing right now:` section carrying **the newest ask verbatim** when a stretch contained a submission but no activity. So the user's own words appear under an activity heading by design, and only the shape test keeps them out of the tool-name set. A one-word ask (`- refactor`) is excluded by the leading-capital requirement.
3. **Path-bearing** — any headline token contains `/`, or contains the `…` marker that `clip` writes. A bare filename (`session_overview.rs`) is *allowed*: `score.py`'s rubric explicitly exempts identifiers and dotted paths as proper names, and the gate must not contradict the rubric. What is rejected is a path fragment and a clipped token.
4. **Activity restatement** — the headline's content-word set, minus its first word, is a subset of the content words of any single activity line. This is the intent/activity collapse: the headline is repeating what the digest already says the session is doing, instead of naming what it is for.
5. **Ungrounded** — fewer than the [Q02] threshold of the headline's content words (excluding the first word, which is the verb, and excluding a small stopword set) appear anywhere in the digest.

Word comparison uses the same normalization `run.py` settled on, ported to Rust: lowercase, split on hyphen/slash/underscore as well as whitespace, trim surrounding punctuation, and a crude suffix stem (`ing`, `ed`, `es`, `s`, then a trailing `e`) so `restart` matches `restarts` and `resumed`. That normalization exists because the first version of the contamination check compared surface forms and missed two of six known leaks; the same trap applies here.

The first word is exempt from grounding because it is the verb, and a digest of tool lines rarely contains one — `Salvage` will not appear in a digest about a corrupted ledger. This exemption is what makes the threshold in [Q02] a question about the *remaining* words.

**Spec S02: The verdict parse** {#s02-verdict-parse}

```swift
static func verdict(from output: String, labels: [String]) -> String?
```

Tokenize `output` on whitespace and punctuation. Lowercase each token. Walk the tokens in order and collect those that match a label. Return the single match if there is exactly one distinct label matched; return `nil` otherwise — both for "no label named" and for "two labels named". No change to the signature, the call site, or the `nil` contract ([P06]).

The pathology being removed: today `for label in labels where upper.contains(label.uppercased())` walks the *labels* in the caller's order, not the output's, so with `labels = ["shell", "prompt"]` an output of `PROMPT, definitely not SHELL` returns `shell`.

**Spec S03: The shell-shape veto** {#s03-shell-veto}

```typescript
export function vetoesShellVerdict(text: string): boolean
```

Pure, no store reads, no side effects. Returns `true` when a `shell` verdict for `text` must not be honored. Signals, any of which vetoes:

- **Sentence punctuation** outside quotes: a `?`, or a `.` followed by whitespace and a lowercase letter, or a `,` separating two multi-word clauses.
- **Bare English function words** outside quotes and outside a flag value: an article (`the`, `a`, `an`), a subject/object pronoun (`it`, `me`, `this`, `that`, `them`, `you`), or a preposition in prose position (`for`, `about`, `into`, `with` when not preceded by a flag). These are the same signals the classify prompt already tells the model to read as PROMPT, which is why applying them as a veto is consistent with the prompt rather than in tension with it.
- **Prose length**: more tokens than a command plausibly has *and* at least one function word. Length alone must not veto — `rg -n --hidden --glob '!target' TODO src tests` is long and is a command.

Quoting matters: `git commit -m "fix the thing for me"` is a command whose message is prose, and must not be vetoed. The veto therefore strips single- and double-quoted spans before looking for function words.

The veto is applied in `tug-prompt-entry.tsx` at the two places a `shell` verdict is consumed: at the routing decision, and before a `shell` verdict enters `ShellVerdictCache` — a cached vetoed verdict would otherwise be honored on a later submit of the same text.

**Spec S04: The bake-off protocol** {#s04-bakeoff-protocol}

For each pack, in a fixed order, on `debug-main`:

1. `PUT {"kind":"string","value":"<pack-id>"}` to `http://127.0.0.1:<port>/api/defaults/dev.tugtool.local-model/model`. Read `<port>` from `tugutil host instance list`; do not assume it.
2. Send one `summarize` tell to load the weights: `tugutil host tell local_model_summarize --instance debug-main -p "prompt=…"`. **This step is mandatory**, because `classify` deliberately fast-fails `not_resident` against a cold pack — `perform(_:)` returns `.failure("local model not resident")` and starts a background load rather than blocking. A `classify` run against a cold pack scores nothing.
3. `just model-classify debug-main` and `just model-eval debug-main`, each with a `--timeout` generous enough for the first call of the run (45–60 s has been sufficient; the default is 30 s).
4. Record: false SHELL, false PROMPT, shell recall, prompt recall, `refused` count, `copied examples`, normalizer rescue count, `all rules`, mean words, median ms for both tasks.

Two harness gotchas, both previously hit: the tugcast log file is named for the **UTC day**, so a run spanning midnight UTC writes into a new file (`harness.py` picks the newest by mtime, which handles it, but a manual `grep` will not); and a cold load of a multi-gigabyte pack can exceed the default timeout on its own.

#### Tuglaws Touched {#tuglaws-touched}

**[L23] — Internal implementation operations must never lose, destroy, or cease to apply user-visible state.** This is the law the grounding gate brushes against, and it must be answered rather than assumed. A gate that withholds an update is exactly the shape L23 polices. The plan's position: a refusal **keeps** the previous headline rather than losing it, so nothing user-visible is destroyed — but "cease to apply" is the live reading, and it bites twice (Risk R02): per session, and across the emitter, since one re-asking session can hold the single emit slot. The answer is threefold and all of it is verifiable: the re-ask recovers the common case ([P04]), the re-ask is skipped when the slot is contended so refusals cannot starve peers, and the **headline change rate** — an aggregate across sessions — is a phase exit criterion, so a gate that goes quiet fails the phase. If that number regresses, [L23] has been violated and the gate is wrong, not the law.

**[L10] — One responsibility per layer.** Honored. `shell-line-classifier.ts` answers a question about a line's shape; `tug-prompt-entry.tsx` decides routing. The veto does not migrate the routing decision into the lib, and the lib gains no knowledge of what routing does.

**[L07] — Action handlers access current state through refs or stable singletons, never stale closures.** Honored. `vetoesShellVerdict(text)` is pure and receives its input as an argument, so it introduces no closure over state. The submit handler already reads `verdictCacheRef.current`, and that pattern is unchanged.

**[L02], [L06], [L24] — State zones.** No new React state exists, in any zone. The veto is a pure function; the gate is in Rust; the PULSE overview frame continues to reach the deck through the store it already flows through. **The State Zone Mapping subsection is therefore deliberately omitted** rather than left blank — there is nothing to map, and an empty table would read as an oversight.

**[L29] — Every persisted or compared path routes through the canonicalization gateway.** Does not apply, despite Spec S01 having a rule named "path-bearing". That rule inspects path-*shaped tokens inside a digest string* to decide whether a headline is prose; it never persists a path, never compares two paths for identity, and never touches the filesystem. No canonicalization gateway is involved and none should be added.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugdeck/src/lib/__tests__/shell-verdict-veto.test.ts` | `bun:test` cases for `vetoesShellVerdict` — the two real false-SHELL lines, quoted-prose commands that must survive, long-but-real commands. |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `GroundingVerdict` | enum | `tugrust/crates/tugcast/src/feeds/session_overview.rs` | `Grounded` \| `Ungrounded { rule, detail }`; `rule` is a static string so it can go straight into a log field. |
| `ground_headline` | fn | same | Spec S01. Pure; takes headline and digest. |
| `content_words` | fn | same | Rust port of `run.py`'s `words()` + `stem()` normalization. Private. |
| `digest_tool_names` | fn | same | The tool-name set derived from a digest's activity lines, for Spec S01 rule 2. Private. |
| `GROUNDING_CORRECTION` | const | same | The corrective sentence appended to the digest on a re-ask ([P04]). |
| `run_emit` (existing) | async fn | same | The spawned per-session emit, `async fn run_emit(job: EmitJob) -> EmitOutcome`. Gains the gate call, the one-shot re-ask, and the original-digest bookkeeping. |
| `spawn_next` (existing) | fn | same | Spawns `run_emit` and holds `while in_flight.is_none()`, so one emit runs at a time. Gains the `may_reask` decision, set from `queue.is_empty()` at spawn ([P04]). |
| `EmitJob` (existing) | struct | same | Gains `may_reask: bool` — the spawned task cannot see the queue itself. |
| `EmitOutcome` (existing) | struct | same | Gains fields recording refusal rule, whether a re-ask was attempted, and whether it rescued the tick. |
| `verdict(from:labels:)` | static fn | `tugapp/Sources/LocalModelService.swift` | Spec S02. Signature and `nil` contract unchanged. |
| `LocalModelPrompts.summarize` | static let | same | Paired-example rewrite; docstring freeze paragraph restated per [P08]. |
| `vetoesShellVerdict` | fn | `tugdeck/src/lib/shell-line-classifier.ts` | Spec S03. Pure export. |
| `CATALOG` entries | const | `tugrust/crates/tugcast/src/local_model.rs` | `recommended`/`offered`/order set by the ruling. |
| `catalog_is_internally_consistent` | test | same | Gains an assertion that exactly one entry is `offered`. |
| refusal/re-ask parsing | fns | `tests/model-eval/analyze.py` | Refusal rate and re-ask rescue rate; covered by `--self-test`. |

---

### Documentation Plan {#documentation-plan}

- [ ] `tests/model-eval/README.md` — a subsection under "What it cannot tell you" recording that the grounding gate is *not* in this harness's reach and naming what verifies it instead ([#harness-reach]).
- [ ] `tugrust/crates/tugcast/src/feeds/session_overview.rs` — module/function docs for the gate stating the rules and why refusal beats rewriting; no invented rationale, no plan-step numbers.
- [ ] `tugdeck/src/lib/shell-line-classifier.ts` — the veto's docstring must make [P07]'s argument in that module's own terms, so it is not mistaken for the return of the deleted stopword rules.
- [ ] `tugapp/Sources/LocalModelService.swift` — the freeze paragraph restated per [P08].
- [ ] `tugrust/crates/tugcast/src/local_model.rs` — `CATALOG` docstring updated with the ruling's outcome; the architecture-registry note is already there.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust)** | `ground_headline` against the 13 frozen digests and every List L01 defect | The gate's correctness — it is unreachable from the register harness |
| **Unit (bun:test)** | `vetoesShellVerdict` over real command and prose lines | The veto; pure and DOM-free |
| **Contract (Rust)** | `catalog_is_internally_consistent`, `corpus_digests_are_what_compose_digest_produces` | Catalog invariants and corpus freshness |
| **Live harness** | `just model-classify` (gate, one-sided), `just model-eval` (rate), `just model-liveness` (smoke) | Anything that depends on a model's actual output |
| **Batch telemetry** | `just model-stats` | Refusal rate, re-ask rescue rate, headline change rate over real usage |
| **App-test** | `at0280-local-model-absent`, `at0282-pulse-two-level` | Only if the no-model degradation contract or the strip's two-level render changes |

#### What stays out of tests {#test-non-goals}

- **Swift-side logic** — there is no Swift test target in `tugapp/`. Falsified through the real path instead (Risk R04). Standing one up is a follow-on, not this phase.
- **A Python reimplementation of the gate in `run.py`** — a second source of truth that drifts; see [#harness-reach].
- **Mock-store assertion tests for the veto's call site** — banned in this codebase and unnecessary; the veto is a pure function and `tsc --noEmit` already catches interface drift at the call site.
- **New app-tests for the gate** — the refusal path needs a live model and a specific digest, which the transient app-test workspace cannot reliably produce. Covered at the Rust layer and observed in `model-stats`.
- **Latency assertions** — timing is reported by `model-stats` against thresholds, never asserted in a test.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Exact-token verdict parse | done | `861b75314` |
| #step-2 | PROMPT-only shell-shape veto | done | `b4df43794` |
| #step-3 | Routing bake-off — collect classify numbers for three packs | done | `48d9856a0` |
| #step-4 | Grounding gate in Rust | done | `60519f7bc` |
| #step-5 | Paired-example summarize prompt | done | `8db8b8015` |
| #step-6 | Register bake-off and the ruling | done | `7f66a048a` |
| #step-7 | Catalog: promote the winner, retire the rest | done | `610f2119f` |
| #step-8 | Integration checkpoint — live app, real session | partial | see [#step-8-status] |

---

#### Step 1: Exact-token verdict parse {#step-1}

**Commit:** `local-model(routing): match a verdict on an exact token, not a substring scan`

**References:** [P06] Exact-token parse, Spec S02, Risk R04, (#context, #harness-reach)

**Artifacts:**
- `LocalModelService.verdict(from:labels:)` rewritten per Spec S02.
- A docstring recording what the parse rejects and why ambiguity stays `nil`.

**Tasks:**
- [ ] Replace the ordered `contains` scan with tokenize-lowercase-match-exactly. Collect all distinct labels named; return the match only when exactly one label was named.
- [ ] Keep the `nil` return for both "no label" and "two labels". Do not synthesize `prompt` — the existing degraded path already lands on Claude and logs `refused`, which is the signal worth keeping ([P06]).
- [ ] Update the function docstring to state the contract; do not narrate the old bug's history.
- [ ] Confirm no other caller exists: `verdict(from:` appears only at its definition and in `perform(_:)`'s `.classify` arm.

**Tests:**
- [ ] None possible in Swift — no test target (see Risk R04). The falsification is the checkpoint below.

**Checkpoint:**
- [ ] `just app-debug` builds, signs, and launches with zero warnings.
- [ ] `just model-classify debug-main` runs green (exit 0, no "were RUN" section) against the currently-selected pack, at no worse accuracy than its recorded baseline.
- [ ] A crafted probe: `tugutil host tell local_model_classify --instance debug-main -p "text=<line>"` for at least three lines from `classify-corpus.json` known to be near the boundary; the log's `verdict=` field must agree with the label in every case, and any ambiguity must appear as `outcome=refused` rather than as a `shell`.

---

#### Step 2: PROMPT-only shell-shape veto {#step-2}

**Depends on:** #step-1

**Commit:** `local-model(routing): veto a shell verdict on a prose-shaped line`

**References:** [P07] PROMPT-only veto, Spec S03, Risk R03, (#context)

**Artifacts:**
- `vetoesShellVerdict` exported from `tugdeck/src/lib/shell-line-classifier.ts`.
- `tugdeck/src/lib/__tests__/shell-verdict-veto.test.ts`.
- The veto applied at both consumption points in `tug-prompt-entry.tsx`.

**Tasks:**
- [ ] Implement `vetoesShellVerdict` per Spec S03: strip quoted spans first, then test sentence punctuation, bare function words in prose position, and prose length gated on a function word being present.
- [ ] Write the docstring so it makes [P07]'s argument in the module's own terms — that the deleted stopword rules decided *toward shell* and pre-empted the model, and that a veto which can only decline to execute is the opposite instrument and follows the same asymmetry the module already documents.
- [ ] Apply the veto where `verdict === "shell"` gates `routeToShell()`, and before a `shell` verdict is written into `ShellVerdictCache`, so a vetoed verdict cannot be honored from cache on a later submit.
- [ ] Fix any pre-existing lint or type findings in the files touched.

**Tests:**
- [ ] `bun:test`: both real 2026-07-29 false-SHELL lines veto — `count the number of lines of code with tokei`, and the 134-character task-list request.
- [ ] `bun:test`: quoted prose survives — `git commit -m "fix the thing for me"`, `rg "the quick brown fox" src`.
- [ ] `bun:test`: long real commands survive — `rg -n --hidden --glob '!target' TODO src tests`, `FOO=1 make test ARGS="--nocapture"`.
- [ ] `bun:test`: every `shell`-labeled case in `classify-corpus.json` survives the veto. Read the corpus in the test so it cannot drift from the harness.

**Checkpoint:**
- [ ] `bunx tsc --noEmit` clean.
- [ ] `bun test tugdeck/src/lib/__tests__/shell-verdict-veto.test.ts tugdeck/src/lib/__tests__/shell-line-classifier.test.ts` green.
- [ ] `bunx vite build` succeeds — the debug app loads the production bundle, so an import that works under dev esbuild can still hang the app at the splash screen.
- [ ] `just app-test-changed` — the selection will include `at0216-shell-exchange` and `at0280-local-model-absent`, both of which declare `@covers` on `shell-line-classifier`.

---

#### Step 3: Routing bake-off — collect classify numbers for three packs {#step-3}

**Depends on:** #step-2

**Commit:** `local-model(eval): record the three-pack routing bake-off`

**References:** [P01] One pack, [P02] Sequencing, Spec S04, Table T01, Table T02, Risk R05, (#rejected-candidates)

**Artifacts:**
- Table T03 filled in, in this plan document (#bakeoff-results) — classify half only.
- `--json` result files retained under `tests/model-eval/` only if they are small; otherwise the table is the record.

**Tasks:**
- [ ] For each of the three packs in Table T01, run the Spec S04 protocol's classify half. Do not skip the warming `summarize` tell — a cold `classify` scores nothing.
- [ ] Record false SHELL, false PROMPT, shell recall, prompt recall, `refused` count, and median ms per pack.
- [ ] Do **not** rule yet. The ruling needs both halves and happens in #step-6 ([P02]).
- [ ] Note explicitly in the results whether the veto or the parse fix was what removed each previously-observed false SHELL — if the parse fix alone removed them, the veto's value is prospective and that should be said plainly rather than implied.

**Tests:**
- [ ] No new tests; this step runs existing harnesses.

**Checkpoint:**
- [ ] `just model-classify debug-main` exits 0 for all three packs — zero false SHELL each. A pack that cannot reach zero here is disqualified under Table T02 priority 1, and that disqualification is recorded.
- [ ] Shell recall for each pack is no lower than its pre-change baseline (`qwen` 30/35, `bonsai` 32/35; `lfm25` has no baseline, so its first number *is* the baseline).
- [ ] The results table is in the plan document with all three packs' rows filled.

---

#### Step 4: Grounding gate in Rust {#step-4}

**Depends on:** #step-3

**Commit:** `session-overview(pulse): refuse a headline the digest does not support`

**References:** [P03] Gate in Rust, [P04] Re-ask once, [P05] No example copy, [Q02] Grounding threshold, Spec S01, List L01, Risk R02, (#harness-reach, #failure-signatures)

**Artifacts:**
- `GroundingVerdict`, `ground_headline`, `content_words`, `digest_tool_names`, `GROUNDING_CORRECTION` in `session_overview.rs`.
- The gate wired into `run_emit` with a one-shot corrective re-ask, gated on `EmitJob.may_reask`.
- `EmitJob` carrying `may_reask`; `EmitOutcome` carrying the refusal rule, re-ask attempted, and rescue flags.
- Two new log lines, with space-free countable fields.
- A per-pack register capture used to resolve [Q02].

**Tasks:**
- [ ] **Capture the spike's inputs first.** No register results are committed to the repo — `git ls-files tests/model-eval` carries only `classify-corpus.json` — and #step-3 produced classify numbers only. So run `python3 tests/model-eval/run.py debug-main --json /tmp/<pack>.json` once per pack (13 inferences each, cheap) to get real headlines against the 13 frozen digests. Do not skip the warming `summarize` tell when switching packs (Spec S04).
- [ ] Resolve [Q02] as a spike over that capture plus every List L01 defect: sweep the threshold and pick the value that rejects all of L01 while accepting every headline a human reads as correct. Record the sweep and the chosen value in the commit body.
- [ ] Implement `content_words` as a Rust port of `run.py`'s `words()`/`stem()` — hyphen/slash/underscore split, punctuation trim, crude suffix stem. Surface-form comparison is not sufficient; that mistake already cost two missed leaks in the contamination check.
- [ ] Implement `digest_tool_names` **section-aware and shape-tested** per Spec S01 rule 2. This is the step's highest-risk detail: an unscoped parse admits the user's own prompt words and then refuses legitimate `Fix …` headlines, which is the most common opener in the corpus.
- [ ] Implement `ground_headline` per Spec S01, rejecting on the first rule that fires, in the specified order.
- [ ] Add `may_reask: bool` to `EmitJob`, set in `spawn_next` from `queue.is_empty()`. The spawned task cannot see the queue, and reading it across the loop boundary is not the design ([P04]).
- [ ] Wire the gate into `run_emit` after `headline_register_report`. On `Ungrounded`, log a refusal line, then re-ask once — **only if `may_reask`** — with `GROUNDING_CORRECTION` appended to the digest, naming the rejected headline and the rule.
- [ ] **Bookkeeping:** set `EmitOutcome.seen_digest` to the **original** digest, not the corrected one, or `last_digest` dedup breaks and the next tick re-summarizes identical evidence.
- [ ] **Log-field shape:** `analyze.py`'s `FIELD` regex is `(\w+)=("[^"]*"|\S+)` and every field it reads today is space-free. A field holding a headline (`headline=Bash make`) would parse as `Bash` and silently drop the rest. So the *countable* fields must be space-free — `rule=ungrounded`, `reask=skipped|failed|rescued` — and any headline text must be debug-formatted (`?headline`) so it arrives quoted. Do not add a space-bearing display field the analyzer is expected to count; that is why `harness.py` needs its own regex for the existing `raw = %text` line, and repeating that split by accident is the trap here.
- [ ] If the second answer also refuses, or the re-ask was skipped, emit nothing — the previous headline stands. Check the empty-headline case inside the gate so it is total over its input; note that `apply_emit_outcome` keeps owning the *unchanged-headline* dedup, because that needs `state.last_headline` and `EmitJob` does not carry it.
- [ ] Do not add a Rust copy of the Swift example list ([P05]).
- [ ] Add refusal-rate and re-ask-rescue-rate reporting to `tests/model-eval/analyze.py`. The rescue rate's denominator is re-asks *attempted*, not refusals — a skipped re-ask must not count as a failed one.
- [ ] Add the new log lines to `analyze.py`'s `--self-test` fixtures, as captured real lines.

**Tests:**
- [ ] Rust unit: every entry in List L01 is refused, each by its expected rule.
- [ ] Rust unit: for each of the 13 frozen digests, at least one hand-written correct headline is accepted. This is the false-positive guard and it is the test that keeps Risk R02 honest.
- [ ] Rust unit: a bare filename headline (`Trace session_overview.rs regression`) is accepted while a path-bearing one (`Write /tmp/calc/calc.c`) and a clipped one (`Write jul29-p…`) are refused — the gate must not contradict `score.py`'s identifier exemption.
- [ ] Rust unit: `digest_tool_names` over `parts-list-tail`'s digest yields exactly `{Write, Bash}` and does **not** contain `write` from the prompt line `- write a command line calculator in c`. Add a second case over a digest whose synthesized *right now* section is a verbatim ask, asserting no ask word enters the set.
- [ ] Rust unit: a headline opening `Fix` is accepted against a digest whose ask opens `fix …` — the direct regression guard for the poisoned-set failure.
- [ ] Rust unit: `seen_digest` records the original digest across a re-ask.
- [ ] Rust unit: a second refusal emits no frame and leaves `last_headline` untouched.
- [ ] Rust unit: with `may_reask: false`, a refusal performs no second summarize call and reports `reask=skipped`.
- [ ] `python3 tests/model-eval/analyze.py --self-test` covers the new lines, including that a quoted headline field with a space parses whole.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast session_overview` green, zero warnings.
- [ ] `cd tugrust && cargo nextest run` fully green.
- [ ] `python3 tests/model-eval/analyze.py --self-test` passes.
- [ ] `just app-debug`, then leave a real session running and confirm from `just model-stats debug-main` that a refusal rate is reported and is below ~20% of ticks. Above that, stop and revisit [Q02] rather than proceeding.
- [ ] With **two or more** sessions live, confirm the headline change rate has not fallen against its pre-change value. One session cannot reveal the throughput failure in Risk R02 — the emit slot is only contended when there is a queue.

---

#### Step 5: Paired-example summarize prompt {#step-5}

**Depends on:** #step-4

**Commit:** `local-model(pulse): pair the summarize examples with the digests they answer`

**References:** [P08] Freeze rule restated, [P05] No example copy, [Q01] Pairing effect, List L01, (#context, #failure-signatures)

**Artifacts:**
- `LocalModelPrompts.summarize` rewritten with paired input/output examples.
- The docstring's freeze paragraph restated per [P08].

**Tasks:**
- [ ] Rewrite the example block as input/output pairs, following `LocalModelPrompts.classify`'s shape — that block teaches by pairing and exhibits neither the monoculture nor the lifting.
- [ ] Give each example a miniature digest as its input, using the real section headings (`What the user asked for:` / `What the session has been doing:` / `What it is doing right now:`) and the real `Name(target)` activity-line form, so the model sees the shape it will actually be given.
- [ ] Vary the opening verbs deliberately to attack the 85% `Fix` monoculture. Every verb used must be on `tests/model-eval/verbs.txt`, or added to it with justification — the file is a closed list and a headline opening off-list scores a miss on purpose.
- [ ] Keep every example subject disjoint from all 13 digests in `tests/model-eval/corpus`. `run.py` exits 2 and names the offending pair if this is violated, so run it as a preflight before spending inference.
- [ ] Include a paired example that demonstrates *not* headlining the activity line — an input whose *right now* section is a tool line, with an output that names the purpose rather than the tool. This is the pathology the gate catches; the prompt should try to prevent it.
- [ ] Restate the docstring's freeze paragraph per [P08]: the freeze protects comparability within one bake-off, and no longer claims to protect the `CatalogEntry.notes` scores, which are four wordings stale.
- [ ] Do not touch `classify`, `generate`, or any of the token budgets.

**Tests:**
- [ ] No unit tests possible (no Swift test target). The register bake-off in #step-6 is the measurement.

**Checkpoint:**
- [ ] `just app-debug` builds and launches with zero warnings.
- [ ] `python3 tests/model-eval/run.py debug-main` does **not** exit 2 — the new examples are disjoint from the corpus.
- [ ] `just model-liveness debug-main` passes: one digest comes back, non-empty, inside the summarize ceiling.

---

#### Step 6: Register bake-off and the ruling {#step-6}

**Depends on:** #step-5

**Commit:** `local-model(eval): rule the three-pack bake-off and record the numbers`

**References:** [P01] One pack, [P02] Sequencing, [Q01] Pairing effect, [Q03] LFM capacity, Spec S04, Table T02, Risk R01, (#bakeoff-results)

**Artifacts:**
- Table T04 filled in (#bakeoff-results), completing the register half for all three packs.
- A written ruling naming the winner and citing Table T02 priority by priority.
- [Q01] and [Q03] marked resolved with their evidence.

**Tasks:**
- [ ] Run the Spec S04 protocol's register half for all three packs against the new prompt. Record `all rules`, normalizer rescue count, `copied examples`, mean words, median ms.
- [ ] For [Q01], also record `copied examples` per pack against the *previous* prompt wording, so the pairing effect is a comparison rather than an assertion. The old wording is recoverable from git.
- [ ] Rule, walking Table T02 in order and stating where the packs separated. If the ruling contradicts the earlier two-pack read, say so plainly rather than reconciling.
- [ ] Resolve [Q01] and [Q03] in this document with their numbers.
- [ ] If the winner has vendor-recommended sampling parameters differing from what `LocalModelJob` sends (temperature 0 today), fold that change in here and re-run its two harnesses — do not leave it implicit.

**Tests:**
- [ ] No new tests; existing harnesses.

**Checkpoint:**
- [ ] `just model-eval debug-main` run for all three packs, with `copied examples 0/13` for the winner. A non-zero count for the winner means the prompt rewrite did not do its job and the gate is carrying the whole load — record that and proceed, since the gate makes it safe, but say it explicitly.
- [ ] `just model-classify debug-main` re-run for the winner after any sampling-parameter change, still exit 0.
- [ ] The ruling is written into this document with the winner named and Table T02 walked in order.

---

#### Step 7: Catalog — promote the winner, retire the rest {#step-7}

**Depends on:** #step-6

**Commit:** `local-model(catalog): offer one pack for both on-device jobs`

**References:** [P01] One pack, [Q04] Retired-pack behavior, Table T01, (#rejected-candidates)

**Artifacts:**
- `CATALOG` in `local_model.rs` with the winner `recommended: true, offered: true`, the others `offered: false`.
- `catalog_rank` order reflecting the ruling.
- An extended `catalog_is_internally_consistent`.
- `notes` strings that describe the pack rather than quoting stale scores.

**Tasks:**
- [ ] Reorder `CATALOG` so the winner is index 0 — `catalog_rank` is position, and `auto` resolves by it, so ordering is the mechanism by which a user on `auto` moves to the winner.
- [ ] Set `recommended`/`offered` so exactly one entry is each.
- [ ] Extend `catalog_is_internally_consistent` with an assertion that exactly one entry is `offered`, alongside the existing exactly-one-`recommended` assertion.
- [ ] Rewrite each `notes` string to describe what the pack is, not what it once scored. The docstring already concedes the historical figures are stale; leaving them in `notes` propagates them.
- [ ] Verify [Q04]'s conclusion by inspection rather than assumption: a user holding a now-retired pack on an explicit selection keeps it (`resolveRoute` honors an explicit pick literally, and returns "no local model" rather than substituting if it is gone); a user on `auto` moves to the winner if installed. The existing `local_model_delete` control frame is the reclamation path and needs no new UI.
- [ ] Confirm nothing keys off a pack id as a string literal anywhere outside `CATALOG` and the eval corpus.

**Tests:**
- [ ] Rust: `catalog_is_internally_consistent` with the new `offered` assertion.
- [ ] Rust: `file_url_pins_the_revision` still passes — it indexes `CATALOG` by id, not position, so reordering is safe, but confirm rather than assume.
- [ ] `bun test tugdeck/src/lib/__tests__/local-model-store.test.ts` — the store's action set includes `local_model_delete`, and the picker must render the new ordering.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run` fully green, zero warnings.
- [ ] `tugutil host tell local_model_inventory --instance debug-main` reports exactly one offered pack, with the winner first.
- [ ] With the tugbank selection cleared to `auto`, a fresh `summarize` tell resolves to the winner — read `model=` from the app's own request log line.

---

#### Step 8: Integration checkpoint — live app, real session {#step-8}

**Depends on:** #step-1, #step-2, #step-4, #step-5, #step-6, #step-7

**Commit:** `N/A (verification only)`

**References:** [P03] Gate in Rust, [P04] Re-ask once, [P06] Exact-token parse, [P07] PROMPT-only veto, Risk R02, (#success-criteria, #harness-reach)

**Tasks:**
- [ ] Run a real working session against `debug-main` long enough to produce a dozen headline ticks, and read every headline on the strip against what the session was actually doing. This is the check no harness performs and the one the user's original complaint came from.
- [ ] Type both real false-SHELL lines into the composer and confirm each routes to Claude.
- [ ] Type several genuine commands (`git status`, `make test`, `rg TODO src`, `head Justfile`) and confirm each still routes to the shell — the veto must not have collapsed the feature it protects.
- [ ] Read `just model-stats debug-main` and confirm the refusal rate, the re-ask rescue rate, and the headline change rate are all reported and within the bounds in [#success-criteria].

**Tests:**
- [ ] `just app-test-changed` for the full accumulated diff of the phase.
- [ ] If the advisory prints CORE TIER ADVISED, run `just app-test` (the ~20-file core tier) and move on. Do not run the full corpus.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run` green; `bun test` green; `bunx tsc --noEmit` clean; `bunx vite build` succeeds.
- [ ] `just model-classify debug-main` exit 0; `just model-eval debug-main` shows `copied examples 0/13`; `just model-liveness debug-main` passes.
- [ ] No headline observed during the live session misdescribes the work. A single misdescription is a phase failure, not a rounding error — that is what "trustworthy" means here.

---

#### Step 8 status — what is verified and what is owed {#step-8-status}

**Verified.**

- `cd tugrust && cargo nextest run` — 1682/1682, zero warnings.
- `bun test` — 5874 pass, 0 fail across 691 files.
- `bunx tsc --noEmit` clean; `bunx vite build` clean.
- `just model-classify` for the shipping pack — exit 0, prompt recall 36/36, zero false SHELL.
- `just model-eval` for the shipping pack — `copied examples 0/13`.
- `just model-liveness` — PASS.
- Both real 2026-07-29 false-SHELL lines refused, and `git status` / `make test` / `rg TODO src` / `head Justfile` / `cargo nextest run` / `ls -la` all pass the veto untouched, run through the shipping `isShellCandidate` + `vetoesShellVerdict`.
- `auto` resolves to the winner on a machine holding all three packs, after the rank reconcile fires at launch.

**Owed, and not to be reported as done.**

- **App-test re-verification.** The core tier showed 6 failures while the app-test bundle was loading multi-gigabyte weights on every launch (`auto` began resolving to an installed pack). That load is now gated off under `TUGAPP_APP_TEST=1`, but the tier has **not** been re-run since, so those 6 are unexplained rather than fixed. Candidates were `harness-smoke/smoke-native`, `at0001`, `at0016`, `at0201`, `at0216`, `at0253` — a focus/gesture cluster, which is the shape memory pressure and timing produce.
- **The live headline read.** A dozen ticks against real work, judged by a human — the check no harness performs and the one the original complaint came from. It needs someone driving the app.
- **The two live rate readings** from `just model-stats`: grounding refusal rate below ~20% of ticks, and headline change rate not regressed, with **two or more sessions** live so the emit-slot contention path is exercised. The report renders both sections correctly but this instance has produced no overviews yet.

The refusal rate has a measured stand-in: run over each pack's real answers to the 13 frozen digests, the gate refuses **2/13 (15%)** for both surviving packs, under the ~20% bound, with every refusal a genuine defect. That is not the live number and does not substitute for it.

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** One on-device pack serving both PULSE headlines and shell routing, where a headline the digest does not support never reaches the strip and a prose line the model calls `shell` cannot execute.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] `just model-classify` exits 0 for the shipping pack with zero false SHELL and shell recall no worse than baseline.
- [ ] Both real 2026-07-29 false-SHELL lines route to Claude, verified live in the app and in the corpus.
- [ ] `ground_headline` refuses every defect in List L01 and accepts a correct headline for all 13 frozen digests (`cargo nextest run -p tugcast session_overview`).
- [ ] `just model-eval` reports `copied examples 0/13` for the shipping pack.
- [ ] `just model-stats` reports a grounding refusal rate and a re-ask rescue rate; refusal rate below ~20% of ticks and headline change rate not below its pre-change value.
- [ ] Exactly one `CATALOG` entry is `offered`, asserted by `catalog_is_internally_consistent`.
- [ ] Zero warnings across `cargo nextest run`, `bunx tsc --noEmit`, and `bunx vite build`.
- [ ] A live session's headlines read correctly to a human (#step-8).

**Acceptance tests:**
- [ ] `cd tugrust && cargo nextest run`
- [ ] `bun test` (full pure-logic suite)
- [ ] `just app-test-changed`
- [ ] `just model-classify debug-main`, `just model-eval debug-main`, `just model-liveness debug-main`, `just model-stats debug-main`

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] **A Swift test target for `tugapp/`.** Risk R04 is structural: the logic that decides whether a command executes has no unit test because there is nowhere to put one.
- [ ] **Constrained decoding for classify**, if the veto proves insufficient — it would make a malformed verdict impossible rather than caught.
- [ ] **Re-evaluate `mistral3` and `gemma4`** when the mlx-swift-examples pin next moves; both families were ruled out on the registry alone, not on quality.
- [ ] **Retire `ternary-bonsai-8b-2bit` from `CATALOG` entirely** once no installed base holds it, rather than leaving it as a permanent `offered: false` entry.
- [ ] **Reconsider [P04]** if the re-ask rescue rate proves near zero — the cheaper hold-only behavior would then be strictly better.

| Checkpoint | Verification |
|------------|--------------|
| Prose can no longer execute | `just model-classify` exit 0; both real false-SHELL lines typed live route to Claude |
| Commands still execute | `git status`, `make test`, `rg TODO src`, `head Justfile` all route to the shell live; shell recall at or above baseline |
| Headlines are grounded | `cargo nextest run -p tugcast session_overview`; `copied examples 0/13`; live read in #step-8 |
| Truth was not bought with silence | `just model-stats`: refusal rate under ~20%, headline change rate not regressed |
| One pack ships | `catalog_is_internally_consistent`; `local_model_inventory` shows one offered entry |
