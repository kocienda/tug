## Local Model Flow — Grammar-Armed Routing, 64ch PULSE Intents, One Ruled Pack {#local-model-flow}

**Purpose:** Finish the shell classifier as one designed flow — grader band → prompt built around the grammar synopsis → local-model verdict → veto — and redesign the PULSE intent line (64 characters, biased to the newest ask, collapsing to a what-was-done retrospective at idle), then re-run the pack bake-off across those final pipelines with LFM2.5 as a live contender and ship exactly one pack.

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

Three finished phases meet here. `dash/local-model-trust.md` (steps 1–7 done, joined at `25ab4714d`) made the model accountable: exact-token verdict parse, PROMPT-only veto, grounding gate, paired-example summarize prompt, and a bake-off that ruled `qwen3-4b-instruct-2507-4bit` the one offered pack. `dash/shell-grammar-checker.md` (all 9 steps done, joined at `4c31269f4`) put a deterministic grammar grader (`tuggram`) in front of the model: a typed line is banded No/Unknown/Maybe/Yes, the No band skips the model, and the Maybe band arms it with the program's own documentation via `LocalModelPrompts.classifyWithGrammar`. `dash/rescue-or-rule-out-LFM.md` recorded that the 4-bit LFM2.5 pack lost the bake-off partly because 4-bit quantization damages a 1.2B model disproportionately, and named the unrun rescue experiments: the 8-bit quant, a prompt written for a small model, and the `lfm2_moe` 8B-A1B pack.

Every remaining thread reopens the same frozen thing. `classifyWithGrammar` is an additive appendix — base prompt verbatim plus a bolted-on paragraph — because [P08] of the trust plan froze the base wording while its bake-off stood. The PULSE intent line is judged unsatisfying at six words: the user wants 64-character intents biased substantially by the latest ask, moving as the machinery works, and collapsing into a summary of what was actually done when the session goes idle — all of which rewrites the summarize prompt, the digest, and the register rubric. And the trust plan's own freeze rule says a prompt edit invalidates the standing bake-off and obliges re-running it. So the qwen ruling is void the moment this phase starts, which is precisely the door the LFM rescue walks through. This is one phase, not three: finalize both pipelines, then run one bake-off against the final prompts, then rule.

#### Strategy {#strategy}

- **Pipelines final first, inference last.** Scoring packs against prompts about to be rewritten spends inference on baselines that will not survive — the trust plan's [P02], reapplied. Every mechanical and prompt change lands before the first bake-off run.
- **Every prior number is historical.** Tables T03/T04 in `dash/local-model-trust.md` and the baseline table in `dash/rescue-or-rule-out-LFM.md` were taken on the six-word register, the old digest, and the old prompts. They are the record of a ruling that was correct when made, not baselines for this phase. Nothing here is gated on "no worse than" a number measured on a pipeline that no longer exists; this phase's first runs establish its own baselines.
- **The asymmetry doctrine is untouchable.** A line sent to Claude that meant the shell costs one keystroke; a line sent to the shell that meant Claude has already executed. Every degraded path resolves to Claude; the veto stays PROMPT-only; the grader can withhold the model or arm it, never route. Nothing in this phase adds a path into the shell.
- **Ruling criteria fixed before numbers** (Table T02), with the retrospective's quality now a measured criterion and download size a ranked penalty the MoE pack must overcome decisively.
- **Per-pack prompts are legal but earned.** The shared prompts are written small-model-conscious first; a pack-specific profile exists only if the shared one demonstrably fails a pack the criteria would otherwise favor ([P06]).
- **Every step names which harness moves** — `just model-classify`, `just model-eval`, `just model-stats` — and in which direction. A step that moves none is infrastructure or it is unfalsifiable.

#### Success Criteria (Measurable) {#success-criteria}

- `just model-classify` exits 0 for the shipping pack (zero post-veto false SHELL), and the Maybe band is exercised by at least 12 corpus cases so the grammar-armed prompt has a measured error rate rather than an anecdote. Verified: the harness's per-band table shows `maybe` with ≥12 scored cases.
- The intent line is up to 64 characters, verb-first, and no word-count rule exists anywhere in the pipeline. Verified: `cargo nextest run -p tugcast session_overview` green with the new constants; `score.py` has no `MAX_WORDS`.
- A session that goes quiet after a completed turn gets exactly one retrospective headline summarizing the worked stretch, refused by the same grounding gate on the same terms as an intent. Verified: Rust unit tests over the emitter's paused-time harness, plus a live observation in the integration step.
- `just model-stats` reports the collapse rate (retrospectives emitted / idle stretches detected) alongside the existing refusal and rescue rates. Verified: `python3 tests/model-eval/analyze.py --self-test` covers the new log line.
- The bake-off is run for every candidate on the final pipelines, both halves plus the retrospective, and the ruling walks Table T02 in order in this document. Verified: Tables T03–T05 filled, ruling written.
- Exactly one `CATALOG` entry is `offered`. Verified: `catalog_is_internally_consistent`.
- Zero warnings across `cargo nextest run`, `bunx tsc --noEmit`, `bunx vite build`; `bun test` green.

#### Scope {#scope}

1. The 64-character register: `session_overview.rs` constants and trim, `score.py` rubric, `summarizeMaxTokens`.
2. Digest re-weighting in `compose_digest` — the newest ask as a first-class labeled section — with corpus regeneration.
3. The idle collapse: emitter trigger, retrospective digest, `summarize_done` task through the socket, Swift prompt, past-tense register.
4. `LocalModelPrompts.classify` / grammar variant rewritten as one designed pair; a Maybe-band corpus population.
5. `LocalModelPrompts.summarize` rewritten for 64ch current-ask-biased intents.
6. Per-pack prompt profiles in Swift, with the freeze rule restated to (pack, profile) pairs.
7. Grounding threshold re-swept for 64ch headlines.
8. Catalog entries, staging, and installation for the LFM2.5 candidates; the bake-off; the ruling; the catalog end-state.
9. Harness updates throughout: `classify.py` band coverage, `run.py` retrospective mode and multi-profile contamination, `analyze.py` collapse rate.

#### Non-goals (Explicitly out of scope) {#non-goals}

- **Deck rendering changes.** The strip renders whatever text the overview frame carries; 64ch flows through `pulse-store.ts` untouched. The retrospective frame carries a `"phase": "done"` field the deck ignores today; styling it is a follow-on.
- **Constrained decoding.** Same position as the trust plan: it would make the classify parse unfalsifiable-by-construction, and the veto plus the exact-token parse are holding.
- **Changing `isShellCandidate`, `vetoesShellVerdict`, or the band→action mapping** (`modelCallForBand`: no→skip, maybe→ask-with-grammar, yes/unknown→ask). The routing skeleton landed in the shell-grammar phase and is not in question.
- **Re-scoring bonsai.** `ternary-bonsai-8b-2bit` stays in `CATALOG` as `offered: false` and is not run in this bake-off. It lost on criteria that have not moved in its favor.
- **A Swift test target.** Still the standing structural gap (trust plan Risk R04); still a follow-on.
- **The trust plan's step-8 leftovers** — the 6-failure app-test cluster re-run and the two live `model-stats` rate readings — are owed to that plan, not folded in here, except where this phase's integration step naturally produces the readings.

#### Dependencies / Prerequisites {#dependencies}

- A running debug instance with `qwen3-4b-instruct-2507-4bit` installed; `tugutil host instance list` for the port — read it, never assume.
- The landed tuggram flow: `tuggram` crate (`tugrust/crates/tuggram/`), `ShellGrammarStore` (`tugdeck/src/lib/shell-grammar-store.ts`), `ShellInput::ShellGrammar` in `tugcast/src/feeds/shell.rs`, `classifyWithGrammar` in `LocalModelService.swift`.
- The landed trust flow: `ground_headline`, `headline_register_report`, the re-ask machinery in `session_overview.rs`; `vetoesShellVerdict`; the exact-token `verdict(from:labels:)`.
- Harnesses: `tests/model-eval/{classify.py,run.py,analyze.py,score.py,harness.py,liveness.py}`, `classify-corpus.json` (83 cases: 37 shell / 46 prompt; 14 carry `band: no`, no case carries `band: maybe` — that hole is this plan's Scope item 4), `corpus/` (13 frozen digests), `verbs.txt` (closed list), `veto-filter.ts`.
- Disk for the candidate packs: ~1.25 GB (LFM2.5 8-bit) + ~4.78 GB (MoE), staged under the models root's `.staging/`.

#### Constraints {#constraints}

- **Warnings are errors** (`-D warnings` via `tugrust/.cargo/config.toml`).
- **No Swift test target.** Swift-side logic is falsified through the live harnesses (`just model-classify`, `just model-eval`) and crafted `tugutil host tell` probes.
- **Banned test styles.** No fake-DOM/RTL, no mock-store assertion tests. Real-app behavior in `tests/app-test/` via the `just` recipes only; everything else is pure-logic `bun:test` or `cargo nextest`.
- **App-test selection is derived** (`just app-test-changed`, `@covers`); the 20-file budget is hard; never the full corpus.
- **Digest wording changes force corpus regeneration** through the Rust path: `TUG_REGENERATE_DIGESTS=1 cargo nextest run -p tugcast corpus_digests`, then re-verify `corpus_digests_are_what_compose_digest_produces`.
- **`run.py` exits 2 on contamination** — any prompt example subject appearing in a corpus digest. Run it as a preflight before spending inference; with per-pack profiles it must sweep every profile's examples ([P06] implication).
- **Harness reach is bounded.** `just model-eval` scrapes the requester's log line in `local_model.rs`, which fires before `session_overview.rs` decides anything — the gate, the re-ask, and the collapse are invisible to it. Their verification is Rust unit tests plus `analyze.py` over the emitter's own log lines. `classify.py` reaches the Swift service through the control socket; the deck's veto is applied by importing the real `veto-filter.ts` through bun, never re-expressed in Python.
- **Cold packs fast-fail classify.** `perform(_:)` returns `.failure("local model not resident")` and starts a background load. Every pack swap in the bake-off sends a warming `local_model_summarize` tell first and waits for `task=summarize … model=<id>` in the instance's `Logs/tugapp.log.*`.
- **No plan-step numbers in durable artifacts** — code, comments, docstrings, test names, commit messages.

#### Assumptions {#assumptions}

- A 64-character verb-first line is still headline register, and the existing normalizer rules (quotes, filler openers, leading articles, whitespace, trailing period) transfer unchanged; only the budgets move.
- Turn end (`turn_complete` / `turn_cancelled` → `SessionBeat::Turn`) followed by sustained quiescence is a faithful "went idle after doing work" signal. The `$`-only session's analogue is a settled shell exchange followed by the same quiescence.
- The grammar synopsis remains the deciding evidence for the Maybe band; rewriting the prompt around it changes how the model reads it, not what is sent (the deck's `grade.synopsis` plumbing is unchanged).
- LFM2.5's published claims (28T-token pretrain, heavy instruction post-train, non-thinking) still describe the 8-bit and MoE packs; the 4-bit pack's failures were at least partly quantization damage, which is the rescue hypothesis this bake-off tests rather than assumes.

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

This plan follows the devise-skeleton conventions: explicit `{#anchor}` on every heading cited later, `[P##]` plan-local decisions, `[Q##]` open questions, `S##` specs, `T##` tables, `L##` lists, `R##` risks, `**Depends on:**` lines with `#step-N` anchors, `**References:**` citing labels and anchors, never line numbers.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] What grounding threshold fits 64-character headlines? (OPEN — resolved by #step-7's sweep) {#q01-threshold-64ch}

**Question:** `GROUNDED_MIN_NUMERATOR/DENOMINATOR = 2/3` was swept against six-word headlines, where the subject after the verb is 3–5 words and the band between accepting defects and refusing good headlines was one word wide. A 64ch headline can carry 8–10 subject words; the same fraction may be looser or tighter in effect.

**Why it matters:** Too loose and lifted or invented content survives; too strict and the strip goes stale (trust plan Risk R02, unchanged).

**Plan to resolve:** Re-run the sweep with the same method: capture each pack's real 64ch answers to the regenerated corpus via `run.py --json`, run the real `ground_headline` over them plus every recorded defect, and pick the loosest value that refuses every defect and the strictest that accepts every correct headline. Pin with a test in the same spirit as `the_grounding_threshold_is_the_loosest_that_still_refuses_the_defects`.

**Resolution:** OPEN — resolved by #step-7; the sweep is the resolution mechanism, decided in advance.

#### [Q02] Is the 6-bit LFM2.5 quant worth a lane? (DECIDED — no lane; the 8-bit failed priority 1) {#q02-lfm-6bit}

**Question:** `mlx-community/LFM2.5-1.2B-Instruct-6bit` (0.96 GB) sits between the failed 4-bit and the candidate 8-bit.

**Why it matters:** Only if the 8-bit and 4-bit straddle the quality bar does the midpoint carry information; if 8-bit clears it, 6-bit only shaves 0.3 GB, and if 8-bit fails, 6-bit fails harder.

**Plan to resolve:** Decide at #step-8 from the 8-bit's first classify run: add the 6-bit lane only if the 8-bit passes priority 1 but the size criterion would be decisive against a larger winner. Default is to skip it.

**Resolution:** DECIDED — no 6-bit lane. The rule made the lane conditional on the 8-bit passing priority 1, and it did not, on either profile. The stated default (skip) therefore stands, decided by the rule written before the numbers rather than by the numbers. Recorded for a future attempt: mlx-community's 6-bit carries the same `TokenizersBackend` tokenizer that blocks its 8-bit sibling, but Liquid's own `LFM2.5-1.2B-Instruct-MLX-6bit` (0.96 GB) reads clean at this pin.

#### [Q03] Does the retrospective need its own verb list? (DECIDED — past forms extend `verbs.txt`) {#q03-retrospective-verbs}

**Question:** The retrospective line reads "what was actually done" — `Built the grammar grader, wired it into routing` — while `verbs.txt` holds plain command forms and `score.py`'s `verb_first` is membership in that closed list.

**Resolution:** DECIDED. The retrospective opens with a past-tense verb; the disambiguation between a standing intent and a completed stretch has to live in the line itself, because the strip gives the two the same pixels. `verbs.txt` gains a labeled past-forms section (the past form of each existing verb it needs, grown the same way the list has always grown), and `score.py` gains a `retrospective` scoring mode whose `verb_first` reads that section. The plain-form rule for intents is unchanged. See [P05].

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| R01 64ch invites prose back onto the strip | med | med | Verb-first survives; normalizer unchanged; `score.py` keeps every rule but the word count; grounding gate re-swept ([Q01]) | Live headlines reading as sentences in #step-11 |
| R02 Idle collapse fires mid-pause, not at done | med | med | Trigger requires a `Turn` (or settled `$` exchange) *and* sustained quiescence; any new beat un-collapses; one collapse per stretch | A live retrospective observed while the user is mid-task |
| R07 Collapse retries forever on a refused retrospective | high | high without the fix | `collapsed` marks on attempt, not on emit ([P11]); dedup cannot short-circuit ahead of it; pinned by an attempted-exactly-once test | Any future edit moving the mark back onto the emit path |
| R03 Per-pack profiles multiply eval cost and drift | med | med | Profiles exist only when earned ([P06]); `run.py` contamination sweeps all profiles; the log's `profile=` field keeps runs attributable | A profile edited without a bake-off re-run |
| R04 Swift changes carry no unit tests | med | high | Same instrument as the trust plan: live harnesses + crafted tell probes; the parse/veto/gate that make errors safe are all tested in Rust or bun | Any regression the harnesses catch late |
| R05 Corpus regeneration churns every downstream number | high | certain | Planned, not accidental: regen is its own step, old tables declared historical ([P09]), and all re-baselining happens after the digest is final | A second unplanned digest edit mid-phase |
| R06 MoE pack strains the machine (4.78 GB download, big resident set) | low | med | Scored last in the pack order; staged out-of-band; its lane is dropped without prejudice if load fails at the registry or memory level | `lfm2_moe` load failure in #step-8 |

**Risk R02: The collapse misreads a thinking pause as done** {#r02-collapse-timing}

- **Risk:** A session that pauses — the user reading, the assistant between turns — gets prematurely stamped with a past-tense summary, which reads as the tool declaring the work finished out from under the user.
- **Mitigation:**
  - The trigger is conjunctive: a turn actually ended (`SessionBeat::Turn`, or a settled `$` exchange), *and* no beat of any kind for `IDLE_COLLAPSE_AFTER` (30 s to start — well past the 20 s `IDLE_PERIOD`, so the ordinary intent cadence has already had its final say), *and* the stretch did work (activity since the last collapse).
  - Any subsequent beat clears the collapsed state and the next intent overwrites the retrospective — the collapse is a display state, not a terminal one.
  - `IDLE_COLLAPSE_AFTER` is a named tuning constant beside the cadence constants, moved by observation, not re-architecture.
- **Residual risk:** A genuinely slow externality (a long build the session is waiting on with no streamed output) can look idle. Accepted: the retrospective it produces is still true of the stretch so far, and the next beat replaces it.

**Risk R07: A refused retrospective retries every sweep, forever** {#r07-collapse-retry-loop}

- **Risk:** The collapse-due condition reads `settled_at` and `collapsed` rather than `new_beats`, so it does not inherit the brake that keeps a failing intent from re-firing — `commit_tick` zeroing the beat counters. If `collapsed` were marked only on a successful emit, a gate-refused retrospective would leave the session due again at the next 2-second sweep and every sweep after, spending an inference (two with a re-ask) forever on a session doing nothing.
- **Mitigation:**
  - `collapsed` marks on attempt — the model answered — not on emit ([P11]).
  - The digest-unchanged dedup is prevented from returning ahead of that mark, which would re-open the identical loop by a different door.
  - A test asserts the retrospective is requested exactly once across a long run of ticks with a refusing model stub.
- **Residual risk:** None known once marked on attempt; the failure mode requires `collapsed` to stay false through a completed model call, which the outcome echo makes unreachable. The standing exposure is a future edit moving the mark, which the test refuses.

---

### Design Decisions {#design-decisions}

#### [P01] One phase; every prior bake-off number is historical (DECIDED) {#p01-one-phase-history}

**Decision:** The classifier completion, the PULSE redesign, and the pack ruling are one phase. Tables T03/T04 of `dash/local-model-trust.md` and the fixed-bar table in `dash/rescue-or-rule-out-LFM.md` are declared historical records, cited for narrative only, never as gates.

**Rationale:**
- The trust plan's own freeze rule ([P08] there) makes any prompt edit void the standing bake-off; this phase edits every prompt.
- The 64ch register and the regenerated corpus change what every register number measures; "no worse than baseline" against the old pipeline is comparing across rulers.

**Implications:**
- This phase's first full runs (in #step-9) are its baselines; gates within the phase compare within the phase.
- `dash/rescue-or-rule-out-LFM.md` is superseded: its experiments A/B/C become lanes of #step-8/#step-9 and the file is removed in #step-10.

#### [P02] Pipelines final first; one bake-off; then the ruling (DECIDED) {#p02-sequencing}

**Decision:** Steps 1–7 finish every mechanical, prompt, digest, corpus, and harness change. Step 8 stages packs. Step 9 runs the whole bake-off — classify half, register half, retrospective — for all candidates against the final pipelines, and rules. Step 10 sets the catalog.

**Rationale:** Identical to the trust plan's [P02], with the halves now collapsible into one run because nothing between them changes: by step 9 the pipelines are frozen for the duration of the measurement.

**Implications:** No pack numbers are collected before #step-9. The incumbent is not "re-checked" along the way with runs that would tempt mid-phase tuning ([P08] here restates the freeze).

#### [P03] The 64-character register: verb-first survives, the word cap dies (DECIDED) {#p03-64ch-register}

**Decision:** `MAX_HEADLINE_CHARS` goes 56 → 64 and becomes the only budget. `MAX_HEADLINE_WORDS` and the word-count trim are removed; the joiner-tail cut (`TAIL_JOINERS`) survives, re-keyed to fire only when the headline exceeds the character budget — cut at the earliest joiner past word 3 that brings it under, else `clip`. `summarizeMaxTokens` goes 24 → 40. `score.py` drops `MAX_WORDS`/`within_budget`-by-words in favor of a ≤64-character check; `verb_first`, `no_article`, `no_and`, `sentence_case` are unchanged.

**Rationale:**
- Six words was the register's compression rule; the user has ruled it too strict. Character budget is what the strip actually has.
- The joiner cut exists to amputate parts-list tails, which is a shape defect independent of the budget that reveals it; keeping it keyed to overflow preserves the cure without re-imposing the cap.
- 40 tokens comfortably emits 64 characters (≈16 tokens of text) with slack for the model's phrasing, and stays far inside `SUMMARIZE_TIMEOUT`.

**Implications:**
- `HeadlineReport.trimmed` now means "the joiner cut fired", `clipped` unchanged. Tests in `session_overview.rs` that assert six-word behavior are rewritten to the new contract, not deleted.
- `trim_to_word_budget` is renamed to what it now does (`trim_tail_to_char_budget`); the public seam moves with it.
- The prompt's "SIX WORDS MAXIMUM" rule is replaced in #step-5; until then the old prompt over-compresses against the new budget, which is harmless and short-lived.

#### [P04] The digest leads with the current ask, as its own labeled section (DECIDED) {#p04-current-ask-section}

**Decision:** `compose_digest`'s single `What the user asked for:` section splits into `The standing goal:` (the pinned first prompt) and `The current ask:` (the newest prompt, when it differs). Section order: standing goal, current ask, background activity, right-now activity. The synthesized right-now-from-ask behavior is unchanged. The summarize prompt (#step-5) instructs: headline what the session is doing about the current ask — the ask names the subject, the right-now section says how it is being advanced, and the headline moves as the activity moves.

**Rationale:**
- The user's stated design: intents biased substantially by the latest declaration of intent, still evolving as the machinery churns. Today the newest ask is one bullet among up to three in one section, and the prompt points the model at the activity section instead.
- A labeled section is the only per-request lever strong enough for a small model; burying the bias in prompt prose is what the current wording already tries.

**Implications:**
- Every frozen digest regenerates (`TUG_REGENERATE_DIGESTS=1 cargo nextest run -p tugcast corpus_digests`), invalidating all recorded register numbers ([P01]) and requiring the `run.py` contamination preflight to be re-run.
- `ACTIVITY_HEADINGS` membership is how `digest_tool_activity` scopes itself, so renamed *prompt* headings are excluded from the tool-name set automatically — but the Rust corpus tests that quote heading strings must be updated, and the gate's section-awareness tests re-verified against the new headings.
- `run.py`, `harness.py`, and the summarize examples all speak the section headings; every occurrence updates in the same step so nothing scores against a phantom digest shape.

#### [P05] The idle collapse is an emitter state, a second summarize task, and past-tense register (DECIDED) {#p05-idle-collapse}

**Decision:** When a session with a completed turn (or settled `$` exchange) records no beat for `IDLE_COLLAPSE_AFTER` (30 s) and has activity since its last collapse, the emitter runs one retrospective emit: a whole-stretch digest (`compose_retrospective_digest` — standing goal, current ask, and one `What the session did:` section holding the full activity deque) is sent as task `summarize_done`, answered by a new Swift prompt (`summarizeRetrospective`) that asks for a past-tense verb-first line naming what was accomplished. The result passes `headline_register_report` unchanged and `ground_headline` in its retrospective mode ([P10]), and is published as an overview frame carrying `"phase": "done"`. **One retrospective is attempted per idle stretch, whatever the gate then decides** ([P11]). Any subsequent beat clears the collapsed flag; the next ordinary intent overwrites the retrospective.

**Rationale:**
- The user's design: an idle session's strip should say what was done, not strand the last intent.
- Past tense is the visible difference between a plan and a result on a strip that gives both the same pixels ([Q03]).
- Riding the existing emit machinery (queue, single in-flight slot, back-off, gate, register) means the collapse inherits every safety property already built instead of duplicating any — with the one exception [P11] closes by hand.

**Implications:**
- `SessionState` gains `settled_at: Option<Instant>` (set on `SessionBeat::Turn` and on a zero-exit `Shell(None)` settle, cleared by any other beat or human act) and `collapsed: bool` (set per [P11], cleared by any beat). The sweep gains a collapse-due arm alongside the cadence arm.
- `EmitJob` gains `retrospective: bool`; `run_emit` composes the retrospective digest and calls the new requester method for that variant. The re-ask applies to it on the same `may_reask` terms.
- **A failed `$` command does not arm the collapse.** A non-zero exit is `SessionBeat::Shell(Some(line))` — a recorded beat, which clears `settled_at` like any other. So `$ make` that fails, followed by silence, leaves the standing intent up rather than declaring the stretch done. That is the intended reading (the work ended on an error; "what was done" is not yet a true thing to say) and it is a deliberate consequence of the beat vocabulary, not an oversight — the implementer states it in the commit body rather than discovering it later.
- Plumbing is the grammar-param pattern: `local_model.rs` requester gains `summarize_done` riding `request_with("summarize_done", …)` under `SUMMARIZE_TIMEOUT`; `ProcessManager.swift`'s task switch gains a `"summarize_done"` arm; `LocalModelBackend.Kind` gains `summarizeDone(prompt:)`; `LocalModelService.perform` selects the retrospective prompt. A new `tugutil host tell local_model_summarize_done` action arm gives the harness the same seam.
- The emitter logs `session overview: collapsed` with the same field discipline (space-free countables, `?`-formatted text); `analyze.py` reports collapse rate and gains the line in `--self-test`.
- L23 is answered head-on: the collapse *replaces* user-visible state deliberately — that replacement is the feature — and it is recoverable by construction (any beat resumes intents). Nothing is lost; the last intent was already stale by the definition of the trigger.

#### [P06] Per-pack prompt profiles live in Swift, keyed by pack id; the freeze rule freezes (pack, profile) pairs (DECIDED) {#p06-profiles-in-swift}

**Decision:** `LocalModelPrompts` becomes a set of `PromptProfile` values — `classify`, `classifyWithGrammar`, `summarize`, `summarizeRetrospective`, plus the shared budgets — with a default profile and an override table keyed by pack-id prefix. `LocalModelService.perform` resolves the profile from `resolveRoute()`'s model id per request. The catalog's `notes` name the profile a pack ships with. The freeze rule is restated: within one bake-off, each pack is scored on exactly one named profile, byte-frozen for the run; editing any profile invalidates the bake-off for every pack scored on it. The `handle` log line gains `profile=<name>` so every scored answer is attributable.

**Rationale:**
- The user has ruled per-pack prompts acceptable — the preferred pack may win on its own terms rather than on wording tuned to a 4B incumbent.
- Swift is the only layer that knows the resident pack at request time on **both** transports: the deck's classify arrives via the `MainWindow` webkit handler and never traverses Rust, while summarize arrives via the tugcast socket. Text carried in the Rust catalog would need double plumbing and still couldn't reach the deck path; a manifest-stamped profile would need the reconcile machinery for every wording change. A Swift table keyed on pack id needs neither.
- Profiles are earned, not speculative: the default profile is written small-model-conscious from the start, and a pack-specific profile is authored only when the default demonstrably fails a pack the criteria would otherwise favor — the design question `dash/rescue-or-rule-out-LFM.md` said must be surfaced rather than quietly decided.

**Implications:**
- `run.py`'s contamination check sweeps the examples of *every* profile against the corpus, not just the default's — a lifted example is ungrounded regardless of which profile taught it.
- The trust plan's [P05] (no Rust copy of the example list) still holds and now covers all profiles for free, since the gate never knew about examples in the first place.
- `CatalogEntry` needs no new field; the pairing is declared in the Swift table and named in prose in `notes`.

#### [P07] The classify pair is designed around the synopsis, not appended to (DECIDED) {#p07-classify-pair}

**Decision:** `classify` and `classifyWithGrammar` are rewritten together as one designed pair per profile: a shared core (the task, the asymmetry, doubt→PROMPT, paired examples), with the grammar variant built around the synopsis as primary evidence — check the tail against the documentation; arguments the documentation accepts read SHELL, English the documentation gives no meaning reads PROMPT — rather than the current base-prompt-plus-appendix. The `{{GRAMMAR}}` substitution mechanism, the deck's synopsis plumbing, and `classifyMaxTokens = 8` are unchanged; the budget moves only if #step-9 measurement demands it.

**Rationale:**
- The appendix shape was forced by the old freeze rule protecting a live bake-off; that constraint is gone the moment this phase begins ([P01]).
- The grammar variant runs only on the Maybe band — the grader has already verified the opener resolves and could not account for the tail — so the variant's examples should teach exactly that judgment, including a wrong-flags-on-a-real-command SHELL/PROMPT contrast the current appendix never shows.

**Implications:**
- The corpus gains a Maybe-band population (#step-4): ~12–16 cases with `band: maybe` expectations — known commands with wrong or foreign flags, valid openers with English-shaped tails, plausible-but-off argument shapes — labeled by the asymmetry (when a human would hesitate, the label is `prompt`).
- `classify.py` already grades bands via the `tuggram` grade bin and scores per-band; its per-band table becomes the Maybe error-rate instrument with no code change beyond what the corpus provides.

#### [P08] Prompt work is blind: no candidate pack is scored before the bake-off (DECIDED) {#p08-blind-authoring}

**Decision:** During steps 1–7, prompts are validated only structurally (contamination, register lint, liveness smoke on the incumbent) — no candidate pack is installed or scored, and no incumbent harness run during authoring is recorded as a number.

**Rationale:** The trust plan's Risk R01 (prompt tuned to the pack the author iterates against) is sharper now that per-pack profiles are legal: the temptation is to tune the *default* profile against whichever pack is loaded. Blindness during authoring is the cheap structural defense.

**Implications:** Liveness smokes (`just model-liveness`) during authoring are pass/fail plumbing checks only. The first recorded numbers are #step-9's.

#### [P09] The regenerated corpus is the phase's single fixed measurement surface (DECIDED) {#p09-one-corpus}

**Decision:** The digest changes ([P04]) land once, early (#step-2), the corpus regenerates once, and every later step measures against that regenerated corpus. Any further digest-wording change discovered mid-phase stops the phase for an explicit re-regeneration decision rather than sliding through.

**Rationale:** The corpus freeze exists so numbers compare; two regenerations in one phase silently splits every table into incomparable halves (Risk R05).

**Implications:** The retrospective digest composer added in #step-3 gets its own frozen fixtures at birth (`corpus/*.done.txt`, pinned by a sibling of `corpus_digests_are_what_compose_digest_produces`), so #step-9's retrospective scoring has a fixed surface too.

#### [P10] `What the session did:` is an activity heading, and rule 2 reads past the retrospective's verb (DECIDED) {#p10-gate-retrospective-mode}

**Decision:** `What the session did:` joins `ACTIVITY_HEADINGS`, so `digest_tool_activity` scopes to it and the restatement rule stays live over a retrospective digest. `ground_headline` gains a mode parameter (`GroundingMode::Intent | GroundingMode::Retrospective`); in retrospective mode the **tool-name-opener rule skips the headline's first word** and is applied from the second word onward. Every other rule — path-bearing, activity restatement, the grounding fraction — is byte-identical across modes.

**Rationale:**
- Leaving the heading out of `ACTIVITY_HEADINGS` would make `digest_tool_activity` return nothing for a retrospective, silently disabling rules 2 **and** 4 on the one digest shape that is *entirely* tool lines. A retrospective that just restates `Bash(make)` is exactly the intent/activity collapse the gate was built to refuse, and it would sail through.
- But leaving rule 2 unmodified refuses correct retrospectives, because `stem()` is deliberately crude: it strips `ed`, so `stem("edited") == "edit" == stem("Edit")`. `Edited keymap shortcut conflicts` — a correct past-tense headline for a session that ran `Edit(keymap.ts)` — would be refused as a tool-name opener. `Read` is worse: it is its own past tense, so `Read the corrupted ledger` collides with no stemming at all. Past-tense register and a tool-name vocabulary overlap by construction; the collision is structural, not incidental.
- Skipping the first word is the minimal correction, and it costs nothing the gate was actually buying. Rule 2 exists to catch the headline whose *subject* is the tool; a past-tense verb that happens to spell a tool name is a verb, and rule 4 (activity restatement) still catches the case where the rest of the headline restates the line.

**Implications:**
- `ground_headline`'s signature gains the mode; the existing call site passes `Intent` and is otherwise untouched, so no intent behavior moves.
- The gate's docstring must state the collision and why the exemption is safe — a future reader deleting a one-word exemption is exactly the drift this note prevents.
- Two tests pin the choice, both in #step-3: `Edited keymap shortcut conflicts` accepted against a retrospective digest naming `Edit(keymap.ts)`, and a retrospective that restates a whole tool line refused by rule 4.

#### [P11] The collapse is marked on attempt, not on emit (DECIDED) {#p11-collapse-on-attempt}

**Decision:** `collapsed` is set when the retrospective was **attempted and the model answered** — an `EmitOutcome` carrying the `retrospective` echo with `seen_digest.is_some()` — regardless of whether the gate accepted the headline. Only the model-absent / call-failed path leaves `collapsed` false, and that path is already covered by the process-wide back-off.

**Rationale:**
- The collapse-due condition reads `settled_at` and `collapsed`, deliberately **not** `new_beats` — an idle session has no new beats, which is the whole point. So the intent path's natural brake does not apply: `commit_tick` zeroes the beat counters at spawn, which is what the module doc means by "a failing model can't make every subsequent sweep retry," and the collapse arm bypasses it entirely.
- Marking on successful emit therefore creates a retry loop with no exit: the gate refuses the retrospective → nothing emits → `collapsed` stays false → the session is due again at the next 2 s sweep, and every sweep after, burning an inference (two, with a re-ask) forever on a session doing nothing. This is the single worst failure mode the collapse could introduce, and it is invisible in a short test.
- "The model answered" is the right boundary because it is exactly the evidence that the attempt happened. A refused retrospective means the strip keeps the last intent — which is the correct display anyway, and identical to what a refused intent does.

**Implications:**
- `EmitOutcome` carries `retrospective: bool` so `apply_emit_outcome` can distinguish the two paths; it sets `state.collapsed = true` when `retrospective && seen_digest.is_some()`.
- The digest-unchanged dedup must not short-circuit ahead of this: a retrospective whose digest matches `last_digest` returns before the model is asked, leaving `seen_digest` `None` and `collapsed` false — the same loop. #step-3's dedup decision must therefore key on `(digest, retrospective)` or skip the dedup on the retrospective path, and the test for it is one of the step's required tests, not an afterthought.
- A test pins the loop shut directly: a refused retrospective is attempted exactly **once** across many subsequent sweeps.

---

### Deep Dives {#deep-dives}

#### The composed flow this phase completes {#composed-flow}

The shell route, end to end, after this phase — pieces marked ★ are this plan's work, everything else is landed:

1. The user types into the composer. `isShellCandidate` (first token in the login-PATH command set, or path-shaped) gates everything; the debounce fires `ShellGrammarStore.request(text)` and a plain `requestClassify(text)` concurrently.
2. On submit, `requestWithin(submitText, GRADE_SUBMIT_WAIT_MS)` yields the band. `modelCallForBand`: `no` → skip the model, route to Claude; `maybe` → ask with `grade.synopsis`; `yes`/`unknown` → ask plain.
3. The classify request reaches `LocalModelService` (webkit path from the deck; socket path from tugcast tells). ★ `perform` resolves the pack's `PromptProfile` and builds the instruction from the profile's designed pair ([P06], [P07]).
4. The answer passes the exact-token `verdict(from:labels:)`; only an explicit `shell` verdict, surviving `vetoesShellVerdict`, routes to the shell. Every degraded path resolves to Claude.

The PULSE flow: beats accumulate in `session_overview_task`; a due session's `run_emit` composes the digest — ★ standing goal / current ask / background / right now ([P04]) — and asks `summarize`; ★ the register imposes 64ch verb-first ([P03]); `ground_headline` refuses what the digest doesn't support (★ threshold from [Q01]); the strip wears the survivor. ★ When the session settles and goes quiet, one `summarize_done` over the whole-stretch digest collapses the intent into a past-tense retrospective ([P05]).

#### The candidates and the ruling criteria {#candidates}

**Table T01: Packs in this bake-off** {#t01-packs}

| id | size | `model_type` | registry | role |
|---|---|---|---|---|
| `qwen3-4b-instruct-2507-4bit` | 2.28 GB | `qwen3` | in | Incumbent; installed; re-scored on the final pipelines. |
| `lfm25-1-2b-instruct-8bit` ★new | 1.25 GB | `lfm2` | in | The rescue's Experiment A: the quant the 1.2B model was never tested at. `mlx-community/LFM2.5-1.2B-Instruct-8bit`. |
| `lfm25-8b-a1b-4bit` ★new | 4.78 GB | `lfm2_moe` | in | Experiment C: 8B total / ~1B active. `mlx-community/LFM2.5-8B-A1B-MLX-4bit`. Ships only on decisive quality (Table T02 note). |
| `lfm25-1-2b-instruct-6bit` (conditional) | 0.96 GB | `lfm2` | in | Only per [Q02]'s rule. `mlx-community/LFM2.5-1.2B-Instruct-6bit`. |

Not run: `ternary-bonsai-8b-2bit` (retired, stays `offered: false`), `lfm25-1-2b-instruct-4bit` (superseded by the 8-bit as the LFM 1.2B contender; its entry stays for installed-base continuity). Registry facts are per the trust plan's recorded `LLMModelFactory` list at mlx-swift-examples 2.29.1: `lfm2` and `lfm2_moe` are both present; verify the pin has not moved before staging.

**Table T02: Ruling criteria, in priority order, fixed before any number is taken** {#t02-ruling-criteria}

| Priority | Criterion | Instrument |
|---|---|---|
| 1 | The pack's own false SHELL count, per band — the unfiltered model verdict, with the Maybe band reported separately | `just model-classify` per-band table |
| 2 | Grounding refusal rate, intents **and** retrospectives, plus copied-example count | `ground_headline` over `run.py --json` captures (both modes); `run.py` lift line |
| 3 | Normalizer rescue count (both modes) | `just model-eval` |
| 4 | Download size — smaller wins a tie on 1–3; the MoE pack must **strictly beat both smaller packs on 1–3** to overcome its 4.78 GB, per the user's standing size objection | Table T01 |
| 5 | Median latency, classify and summarize | harness medians |
| 6 | Raw register pass rate | `run.py` — ranks last for the same reason as always: it once reported 13/13 over a leaking prompt |

A pack that needs its own profile to compete is scored on that profile, named in the tables; the profile's authoring cost and drift surface count against it in prose in the ruling, not as a numbered criterion.

**Table T03: Classify half** {#t03-classify-results}

| pack | profile | scored | accuracy | own false SHELL (all) | own false SHELL (maybe band) | post-veto false SHELL | false PROMPT | shell recall | prompt recall | median ms |
|---|---|---|---|---|---|---|---|---|---|---|
| qwen3-4b-instruct-2507-4bit | default | 99/99 | 88/99 | **1** | 0 | **0** | 11 | 37/48 | 51/51 | 626 |
| lfm25-1-2b-instruct-8bit | default | 87/99 | 77/87 | **14** | 5 | **1** | 9 | 33/42 | 44/45 | 423 |
| lfm25-1-2b-instruct-8bit | lfm-small | 98/99 | 97/98 | **36** | 6 | **1** | 0 | 48/48 | 49/50 | 218 |
| lfm25-8b-a1b-4bit | — | not scored | — | — | — | — | — | — | — | — |

`scored` is cases answered, not cases put: the 8-bit dropped 12 on the default profile by exceeding the 60 s timeout, which is itself a fact about the pack. `lfm-small`'s 97/98 accuracy is the deck's veto working, not the model — the pack answered SHELL to nearly everything (`false PROMPT` 0, shell recall 48/48), which is why the criterion that ranks first is the pack's *own* count and not accuracy. `lfm25-8b-a1b-4bit` has no row because it never loaded (#step-8).

**Table T04: Register half (intents)** {#t04-register-results}

| pack | profile | all rules | within budget | verb first | rescues | refused | copied | mean chars | median ms |
|---|---|---|---|---|---|---|---|---|---|
| qwen3-4b-instruct-2507-4bit | default | **10/13** | 13/13 | 11/13 | 0 | 1/13 | 0 | 47.1 | 1653 |
| lfm25-1-2b-instruct-8bit | default | **5/13** | 12/13 | 5/13 | 1 | 2/13 | 0 | 34.2 | 428 |

The 8-bit's 2/13 refusal rate is not the good number it looks like. It answered `Fix` (3 characters), `Fix app-debug`, and `Fixing file completion issues`; a headline carrying no claim gives the grounding gate nothing to refuse. Its `verb_first` 5/13 is the gerund the register was written against — `Fixing`, not `Fix` — and the two it *was* refused for are a truncation and an outright invention (`Resolve keymap shortcuts`, for a session about the overview cadence gate).

**Table T05: Retrospective** {#t05-retrospective-results}

| pack | profile | all rules | within budget | verb first | rescues | refused | median ms |
|---|---|---|---|---|---|---|---|
| qwen3-4b-instruct-2507-4bit | default | **11/13** | 12/13 | 12/13 | 3 | 2/13 | 1652 |
| lfm25-1-2b-instruct-8bit | default | **2/13** | 11/13 | 11/13 | 5 | **10/13** | 424 |

This is the lane where the 8-bit's failure is unmistakable, because writing full sentences gives the gate something to check. It returned `Fixed keymap conflicts and badge accuracy issues` for the Sparkle self-update session and `Fixed keymap conflicts and badge accuracy` for the local-model onboarding one — the same invented answer for unrelated digests, which is the canned-response failure the 4-bit sibling showed in the historical run. Ten of thirteen refused.

#### The ruling {#the-ruling}

**`qwen3-4b-instruct-2507-4bit` holds the offered place.** Walking Table T02 in order, on this phase's pipelines:

1. **The pack's own false SHELL.** The incumbent reached for the executing verdict once in 99 lines, and the deck's veto caught it: zero lines would have run. The 1.2B reached for it 14 times on the default profile and 36 on the profile written to rescue it, and in both runs one line cleared the veto and would have executed — `rg --frobnicate TODO src`, a line meant for Claude. Under the asymmetry doctrine that is not a rate to weigh, it is an event: the wrong SHELL cannot be taken back. The bake-off is decided here, and nothing below can reopen it.
2. **Grounding refusal and copied examples.** Incumbent 1/13 intents and 2/13 retrospectives; candidate 2/13 and 10/13. Neither pack copied a prompt example. See T04's note on why the candidate's intent figure flatters it.
3. **Normalizer rescues.** Incumbent 0 intents, 3 retrospectives. Candidate 1 and 5.
4. **Size.** The candidate wins: 1.25 GB against 2.28 GB. This is the tie-break on 1–3, and 1–3 are not tied. The MoE pack's 4.78 GB never had to be argued — it does not load.
5. **Latency.** The candidate wins, and not narrowly: 218–423 ms against 626 ms classifying, 424 ms against 1653 ms summarizing. It is fast at being wrong.
6. **Raw register pass rate.** Incumbent 10/13 and 11/13; candidate 5/13 and 2/13.

The candidate wins two criteria, both of them the two that were ranked last on purpose.

**On the profile.** `lfm-small` was authored under the one mid-bake-off authoring [P06] sanctions, against a diagnosed failure rather than a hunch: every one of the 14 lines the pack wrongly called SHELL opened on a token that also names a program — `make`, `sort`, `split`, `join`, `write`, `say`, `cut`, `yes` — which is a model reading the first word and stopping. The rewrite compressed the framing, led with the decisive test, and stacked minimal pairs sharing an opener. It made the pack's own count worse by a factor of two and a half. Leading with the SHELL rule and putting the SHELL half of every pair first taught a 1.2B that SHELL is the default answer, and it answered SHELL to nearly everything. The profile was removed rather than retuned: a second and third variant would be tuning until the number looked good, which is the practice the fixed-criteria discipline exists to prevent, and `overrides` ships empty. What the exercise bought is the record above, which is worth more than an empty table.

**On the LFM family.** The rescue is over. Experiment A ran and lost on the criterion that ranks first; Experiment B ran as `lfm-small` and lost harder; Experiment C never loaded at this pin. The 1.2B pack stays in the catalog for anyone already holding it and ships to nobody.

**Against the historical ruling.** This agrees with the qwen ruling recorded in the trust plan, which is worth stating plainly *because* it agrees: the pipelines changed underneath it — 64-character headlines, a re-weighted digest, rewritten prompts, a grammar-armed Maybe band, a retrospective lane that did not exist — so this is a fresh ruling that happens to land in the same place, not the old one still standing. [P01] declared every prior number historical, and none was consulted.

#### Bake-off protocol {#bakeoff-protocol}

**Spec S01: Per-pack protocol** {#s01-bakeoff-protocol}

For each pack, in Table T01 order, on the phase's debug instance:

1. `PUT {"kind":"string","value":"<pack-id>"}` to `http://127.0.0.1:<port>/api/defaults/dev.tugtool.local-model/model` — port from `tugutil host instance list`.
2. Warm: `tugutil host tell local_model_summarize --instance <id> -p "prompt=…"`; wait for `task=summarize … model=<pack-id>` in `Logs/tugapp.log.*`. Mandatory — classify fast-fails cold.
3. `python3 tests/model-eval/classify.py <instance> --timeout 60 --json /tmp/classify-<pack>.json`
4. `python3 tests/model-eval/run.py <instance> --timeout 90 --json /tmp/register-<pack>.json`, then the same with `--retrospective` (the `summarize_done` lane over the `corpus/*.done.txt` fixtures).
5. Gate refusals offline: `cd tugrust && cargo nextest run -p tugcast the_refusal_rate --nocapture` (reads the `/tmp/register-*.json` captures).
6. Record every Table T03–T05 column before touching the next pack.

Standing gotchas, inherited: the tugcast log file is named for the UTC day; a cold multi-gigabyte load can exceed default timeouts on the first call; `harness.py` picks the newest log by mtime.

#### Staging and installing a candidate pack {#pack-install}

New entries are authored `recommended: false, offered: false` in `CATALOG` (`tugrust/crates/tugcast/src/local_model.rs`). `catalog_is_internally_consistent` asserts exactly one recommended and exactly one offered entry, `CATALOG[0].recommended`, per-entry `total_bytes` summation, 40-char `hf_revision`, 64-char digests.

**Digests are computed locally, from the bytes — the API cannot supply them.** `https://huggingface.co/api/models/<repo>/tree/<revision>?recursive=true` returns `size` for every file but `lfs.sha256` **only for LFS-tracked files**, which in these repos means `model.safetensors` alone. Checked live against `mlx-community/LFM2.5-1.2B-Instruct-8bit`: `config.json`, `tokenizer.json` (4.7 MB), `tokenizer_config.json`, `generation_config.json`, `chat_template.jinja`, and `model.safetensors.index.json` all come back with no digest. Every existing `CATALOG` entry carries a sha256 for every file because they were hashed from downloaded bytes — the docstring says exactly that ("computed from the exact bytes that were scored during bring-up"). So the procedure is: **enumerate** the file set from the tree API at the pinned revision (do not copy another entry's shape — the LFM repos have no `merges.txt` or `vocab.json` and do carry `chat_template.jinja`), **download** every kept file at that revision, **hash locally** (`shasum -a 256`), take sizes from disk, and cross-check the safetensors digest against the API's LFS value as a corruption guard. Repo furniture (README, LICENSE, `.gitattributes`, eval artifacts) is excluded — MLX never reads it, so it is never downloaded.

Bytes may be staged out-of-band into `.staging/<id>/<name>.part` under the models root; `tugutil host tell local_model_download` resumes onto them, verifies every digest, and stamps `tug-manifest.json` without re-fetching. Since the digests must be computed from downloaded bytes anyway, the natural order is: fetch into staging, hash what landed, author the entry from those hashes, then let `local_model_download` verify — which turns the authoring step into its own end-to-end check.

---

### Specification {#specification}

**Spec S02: The 64ch register pipeline** {#s02-64ch-register}

In `tugrust/crates/tugcast/src/feeds/session_overview.rs`:

- `MAX_HEADLINE_CHARS: usize = 64`.
- `MAX_HEADLINE_WORDS` deleted. `trim_to_word_budget` becomes `trim_tail_to_char_budget(text: &str) -> String`: if `text` is within `MAX_HEADLINE_CHARS`, return unchanged; else find the earliest `TAIL_JOINERS` member at word index ≥ 3 whose cut brings the text within budget and cut there; else return unchanged (the subsequent `clip` handles it). `headline_register_report` calls it in the same position; `trimmed` = the joiner cut fired, `clipped` = `clip` still had to.
- In `tugapp/Sources/LocalModelService.swift`: `summarizeMaxTokens = 40`, comment updated to the 64-char strip contract.
- In `tests/model-eval/score.py`: `MAX_WORDS` deleted; `within_budget` = `len(headline) <= 64`; other checks unchanged; `retrospective: bool = False` parameter switching `verb_first` to the past-forms section of `verbs.txt` ([Q03]).

**Spec S03: The retrospective task, end to end** {#s03-retrospective}

- `session_overview.rs`: `IDLE_COLLAPSE_AFTER: Duration = Duration::from_secs(30)`, a `Cadence`-adjacent field so paused-time tests can steer it (add `idle_collapse_after` to `Cadence` with the production default). `SessionState.settled_at`/`collapsed` per [P05]. Sweep arm: due-for-collapse when `settled_at` is `Some`, `now - settled_at >= idle_collapse_after`, `!collapsed`, and there is activity recorded since the last collapse; commits a tick with `retrospective: true`. `collapsed` is set **on attempt** per [P11] — in `apply_emit_outcome`, when the `retrospective` echo on `EmitOutcome` is true and `seen_digest.is_some()`.
- `compose_retrospective_digest(prompts: &[String], activity: &[String]) -> Option<String>`: standing goal / current ask sections as [P04], then one `What the session did:` section holding every activity line. `None` on empty-everything. `What the session did:` is added to `ACTIVITY_HEADINGS` ([P10]).
- `ground_headline(headline, digest, mode: GroundingMode)`: rule 2 skips the first word in `Retrospective` mode; every other rule identical ([P10]).
- `local_model.rs`: requester method `summarize_done(prompt)` → `request_with("summarize_done", prompt, None, None)` under `SUMMARIZE_TIMEOUT`; a `local_model_summarize_done` arm in `actions.rs` beside `local_model_summarize`.
- `ProcessManager.swift` task switch: `case "summarize_done": kind = .summarizeDone(prompt: prompt)`. `LocalModelBackend.Kind` gains `summarizeDone(prompt: String)` with `task == "summarize_done"` and `inputChars` = prompt count. `LocalModelService.perform` runs it with the profile's `summarizeRetrospective` instructions and `summarizeMaxTokens`.
- The frame: `overview_frame` gains an optional phase — retrospectives publish `"phase": "done"`; intents publish no phase field. `pulse-store.ts` requires no change (unknown fields ignored); pinned by a Rust serialization test only.
- Logging: `session overview: collapsed` info line with `session`, `elapsed_ms`, `raw = %text`, `headline = ?text`, plus refusal/reask lines shared with the intent path. `analyze.py`: collapse rate = collapsed emits / collapse-due ticks, in `--self-test`.

**Spec S04: PromptProfile** {#s04-prompt-profile}

```swift
struct PromptProfile {
    let name: String                      // logged as profile=<name>
    let classify: String
    let classifyWithGrammar: String       // contains {{GRAMMAR}}
    let summarize: String
    let summarizeRetrospective: String
}
```

`LocalModelPrompts.default` is the shared small-model-conscious profile; `LocalModelPrompts.overrides: [(idPrefix: String, PromptProfile)]` is consulted by `profile(forModelId:)` — first prefix match wins, absent id (system backend) gets the default. Budgets stay shared statics. `perform` resolves the profile once per request from `resolveRoute()?.model?.id`. The docstring's freeze paragraph is restated per [P06]. The overrides table ships empty unless #step-9 earns an entry.

**Spec S05: Maybe-band corpus cases** {#s05-maybe-corpus}

12–16 new cases in `tests/model-eval/classify-corpus.json` with `band: "maybe"` expectations, in three families: (a) real commands with flags their grammar doesn't know (`rg --frobnicate TODO src`, label `prompt` — a human would hesitate, and doubt resolves to Claude; but `git commit --amend-message "x"` style near-misses are judged case by case and the label records the human call); (b) valid opener + English tail that happens to defeat the grader's accounting; (c) plausible argument shapes off by one (`tar -xvzq file.tgz`). Every opener must exist in the injected command set (`tuggram/data/corpus-commands.txt` ∪ catalog names) or be added to `corpus-commands.txt`; `tuggram`'s corpus tests (`every_recorded_band_still_holds` etc.) re-verify the recorded bands hermetically. The point is a measured Maybe error rate, not a gamed one: author lines from real hesitation, and let the labels fall where the asymmetry puts them.

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tests/model-eval/corpus/*.done.txt` | Frozen retrospective digests, regenerated through `compose_retrospective_digest` ([P09]). |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `MAX_HEADLINE_CHARS` | const | `tugrust/crates/tugcast/src/feeds/session_overview.rs` | 56 → 64; sole budget (Spec S02). |
| `trim_tail_to_char_budget` | fn | same | Replaces `trim_to_word_budget`; joiner cut on overflow only. |
| `IDLE_COLLAPSE_AFTER` / `Cadence.idle_collapse_after` | const/field | same | 30 s; test-steerable (Spec S03). |
| `SessionState.settled_at`, `SessionState.collapsed` | fields | same | The collapse trigger state ([P05]). |
| `compose_retrospective_digest` | fn | same | Whole-stretch digest (Spec S03). |
| `EmitJob.retrospective`, `EmitOutcome.retrospective` | fields | same | Which task the emit runs; the echo is what lets `apply_emit_outcome` mark `collapsed` on attempt ([P11]). |
| `GroundingMode` | enum | same | `Intent` \| `Retrospective`; rule 2 skips the first word in the latter ([P10]). |
| `ground_headline` | fn | same | Gains the mode parameter; existing call site passes `Intent`, unchanged otherwise. |
| `ACTIVITY_HEADINGS` | const | same | Gains `What the session did:` ([P10]). |
| `GROUNDED_MIN_*` | consts | same | Re-swept value from [Q01], pinned by test. |
| heading strings in `compose_digest` | consts/inline | same | `The standing goal:` / `The current ask:` ([P04]). |
| `overview_frame` phase | fn | same | `"phase": "done"` on retrospectives (Spec S03). |
| `summarize_done` requester + `request_with` arm | fns | `tugrust/crates/tugcast/src/local_model.rs` | Spec S03. |
| `local_model_summarize_done` | action arm | `tugrust/crates/tugcast/src/actions.rs` | Harness seam. |
| new `CatalogEntry` values | const | `local_model.rs` | Table T01 candidates, `offered: false` at authoring (#pack-install). |
| `PromptProfile`, `profile(forModelId:)` | struct/fn | `tugapp/Sources/LocalModelService.swift` | Spec S04. |
| `LocalModelPrompts.*` rewrites | static lets | same | [P03], [P04], [P05], [P07] wordings; freeze restated. |
| `Kind.summarizeDone` | enum case | `tugapp/Sources/LocalModelBackend.swift` | Spec S03. |
| `"summarize_done"` task arm | switch case | `tugapp/Sources/ProcessManager.swift` | Spec S03. |
| `summarizeMaxTokens` | static let | `LocalModelService.swift` | 24 → 40. |
| `score.py` rubric | fns | `tests/model-eval/score.py` | Spec S02; retrospective mode. |
| `verbs.txt` past-forms section | data | `tests/model-eval/verbs.txt` | [Q03]. |
| `run.py --retrospective`, multi-profile contamination | fns | `tests/model-eval/run.py` | Specs S01, S04. |
| collapse-rate parsing | fns | `tests/model-eval/analyze.py` | Spec S03; `--self-test` fixtures. |
| Maybe-band cases | data | `tests/model-eval/classify-corpus.json` | Spec S05. |

State Zone Mapping is deliberately omitted: no new frontend state exists in any zone — the deck is untouched this phase.

---

### Documentation Plan {#documentation-plan}

- [ ] `LocalModelService.swift` — the prompt docstring's freeze paragraph restated to (pack, profile) pairs ([P06]); the six-word history paragraphs condensed to what still governs.
- [ ] `session_overview.rs` — module docs gain the collapse: the trigger, the one-per-stretch contract, and why the retrospective rides the same gate.
- [ ] `tests/model-eval/README.md` — the retrospective lane, the collapse rate, and the per-profile contamination sweep recorded under the harness-reach section.
- [ ] `local_model.rs` `CATALOG` docstring — the new ruling's outcome and the profile each pack pairs with.
- [ ] `dash/rescue-or-rule-out-LFM.md` — deleted in #step-10; its still-relevant mechanics live in this plan's #pack-install and Spec S01.

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (Rust)** | Register pipeline at 64ch, retrospective digest composer, collapse trigger on the paused-time emitter harness, gate threshold sweep pin, frame serialization | Everything the register harness cannot see |
| **Contract (Rust)** | `corpus_digests_are_what_compose_digest_produces` + retrospective sibling; `catalog_is_internally_consistent`; `tuggram` corpus band tests | Corpus freshness, catalog invariants, band expectations |
| **Live harness** | `just model-classify` (per-band, one-sided), `just model-eval` (+ retrospective lane), `just model-liveness` | Anything depending on a model's actual output |
| **Batch telemetry** | `just model-stats` | Refusal, rescue, collapse, change rates over real use |

#### What stays out of tests {#test-non-goals}

- **Swift-side logic** — no test target; falsified via live harnesses and tell probes (Risk R04).
- **New app-tests** — no deck behavior changes; the existing `at0280`/`at0282` contracts are unaffected, and `just app-test-changed` covers the accumulated diff at the integration step.
- **Python reimplementations of Rust decisions** — the gate, the bands, and the veto are imported or exercised through their real implementations, never re-expressed.
- **Latency assertions** — reported by `model-stats`, never asserted.

---

### Execution Steps {#execution-steps}

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | The 64-character register | done | `0660b0cae` |
| #step-2 | Current-ask digest and corpus regeneration | done | `b6cf3d0e4` |
| #step-3 | The idle collapse | done | `f85237163` |
| #step-4 | Maybe-band corpus population | done | `28ab7358e` |
| #step-5 | The prompt rewrites — classify pair, summarize, retrospective | done | `cdccb6c4f` |
| #step-6 | Per-pack prompt profiles | done | `c4604d2ee` |
| #step-7 | Grounding threshold re-sweep | done | `73bfd589b` |
| #step-8 | Candidate packs — catalog, staging, install | done | `e8c16e85c` |
| #step-9 | The bake-off and the ruling | done | `20d06bc23` |
| #step-10 | Catalog end-state and doc retirement | done | `a5ed8622d` |
| #step-11 | Integration checkpoint — live app | done | `c92b1fd89` |

---

#### Step 1: The 64-character register {#step-1}

**Commit:** `session-overview(pulse): retire the word cap for a 64-character headline budget`

**References:** [P03] 64ch register, [P01] Historical numbers, Spec S02, (#context, #strategy)

**Artifacts:**
- `MAX_HEADLINE_CHARS = 64`; `MAX_HEADLINE_WORDS` and `trim_to_word_budget` replaced by `trim_tail_to_char_budget` per Spec S02.
- `summarizeMaxTokens = 40` with its comment retold for the new contract.
- `score.py` on the character budget, with the retrospective-mode parameter stubbed against the not-yet-populated past-forms section.

**Tasks:**
- [ ] Rewrite the trim per Spec S02; keep `TAIL_JOINERS` and the never-below-three-words guard; update `HeadlineReport` field docs to the new meanings.
- [ ] Rewrite every `session_overview.rs` test asserting six-word behavior to the new contract — the joiner-cut tests keep their spirit (parts-list tails still amputate) keyed to overflow.
- [ ] `score.py`: drop `MAX_WORDS`; `within_budget` = ≤64 chars; add the `retrospective` parameter reading a `# past forms` section of `verbs.txt` (add the section header with a first population of past forms for the existing verbs the examples will use).
- [ ] Note in `dash/local-model-trust.md`'s bake-off tables that the numbers predate the 64ch register and are historical ([P01]) — one sentence above Table T03 there, no renumbering.

**Tests:**
- [ ] Rust unit: a 70-char headline with a joiner at word 4 cuts to within 64; one with no joiner clips with `…`; a 60-char nine-word headline passes untouched (the case the old cap would have mangled).
- [ ] Rust unit: `headline_register_report` flags — `trimmed` only on a joiner cut, `clipped` only on `clip`.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast session_overview` green, zero warnings.
- [ ] `cd tests/model-eval && python3 -c "from score import score; assert score('Wire grammar grader bands into the composed submit path')['within_budget']; assert not score('x'*70)['within_budget']"` — a 9-word 55-char line passes the budget, a 70-char line fails it.
- [ ] `just app-debug` builds with the Swift budget change.

---

#### Step 2: Current-ask digest and corpus regeneration {#step-2}

**Depends on:** #step-1

**Commit:** `session-overview(pulse): lead the digest with the current ask, regenerate the corpus`

**References:** [P04] Current-ask section, [P09] One corpus, Risk R05, (#composed-flow)

**Artifacts:**
- `compose_digest` emitting `The standing goal:` / `The current ask:` per [P04].
- The 13 frozen digests regenerated; every harness and test speaking the new headings.

**Tasks:**
- [ ] Split the prompt section per [P04]; when the newest prompt *is* the pinned first (young session), emit only `The standing goal:`. The synthesized right-now-from-ask block is unchanged.
- [ ] Confirm `digest_tool_activity`'s scoping survives by membership in `ACTIVITY_HEADINGS` (it does — any non-member heading turns activity off); update the corpus tests that quote prompt headings.
- [ ] `TUG_REGENERATE_DIGESTS=1 cargo nextest run -p tugcast corpus_digests`; review the regenerated files by eye — this is the one look a human gets before the whole phase measures against them.
- [ ] Update `run.py` / `harness.py` anywhere the old heading string appears; re-run the contamination preflight (`python3 tests/model-eval/run.py <instance>` must not exit 2 — the summarize examples still carry old headings until #step-5, so if contamination trips on heading text alone, note it and carry the fix into #step-5 rather than pre-editing the frozen prompt here).

**Tests:**
- [ ] Rust unit: a two-prompt session's digest carries both sections in order; a one-prompt session carries only the standing goal; the gate's section-awareness tests still exclude ask words from the tool-name set under the new headings.
- [ ] `corpus_digests_are_what_compose_digest_produces` green against the regenerated files.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast` green, zero warnings.
- [ ] `git diff --stat tests/model-eval/corpus` shows exactly the 13 digests regenerated.

---

#### Step 3: The idle collapse {#step-3}

**Depends on:** #step-2

**Commit:** `session-overview(pulse): collapse an idle session's intent into a what-was-done retrospective`

**References:** [P05] Idle collapse, [P09] One corpus, [P10] Gate retrospective mode, [P11] Collapse on attempt, [Q03] Retrospective verbs, Spec S03, Risk R02, (#composed-flow)

**Artifacts:**
- The full vertical slice per Spec S03: trigger state, sweep arm, retrospective digest, `GroundingMode` on the gate, `summarize_done` through the socket, `Kind.summarizeDone`, a first-cut `summarizeRetrospective` prompt (refined in #step-5), the `"phase": "done"` frame, the collapse log line, `analyze.py` collapse rate, the `local_model_summarize_done` tell.
- `corpus/*.done.txt` fixtures pinned at birth ([P09]).

**Tasks:**
- [ ] Implement the trigger per Spec S03. `settled_at` sets on `SessionBeat::Turn` and on `SessionBeat::Shell(None)`; any other recorded beat and every `human_act` clear it and clear `collapsed`. Record in the commit body that a failed `$` command therefore does not arm the collapse, and why that is the intended reading ([P05]).
- [ ] The collapse-due sweep arm runs beside the cadence arm, honoring `Gates` and the queue/active machinery unchanged; the committed tick marks the job `retrospective: true`.
- [ ] Add `What the session did:` to `ACTIVITY_HEADINGS` and give `ground_headline` its `GroundingMode` parameter, rule 2 skipping the first word in retrospective mode ([P10]). Document the past-tense/tool-name stem collision in the function's docstring — `stem("edited") == stem("Edit")`, and `Read` needs no stemming at all — so the exemption is not deleted as redundant later.
- [ ] `run_emit`: on `retrospective`, compose via `compose_retrospective_digest`, call `requester.summarize_done`, and run the same register + gate + `may_reask` path with `GroundingMode::Retrospective`; log `session overview: collapsed` with the Spec S03 fields.
- [ ] **Set `collapsed` on attempt, per [P11]** — `apply_emit_outcome` marks it when the outcome's `retrospective` echo is true and `seen_digest.is_some()`, i.e. the model answered, whatever the gate then ruled. Marking it on successful emit instead produces an unbounded retry loop (the collapse arm has no `new_beats` brake), which is the single worst thing this step could ship.
- [ ] Dedup: a retrospective whose digest equals `last_digest` must not return before the model is asked — that path leaves `seen_digest` `None` and re-opens the same loop ([P11]). Key the digest-unchanged dedup off `(digest, retrospective)` or skip it on the retrospective path; state the choice in the commit body.
- [ ] Plumb Rust→Swift per Spec S03 (requester method, actions arm, `ProcessManager` case, `Kind` case, `perform` arm with a first-cut past-tense prompt).
- [ ] `analyze.py`: collapse rate with the new line in `--self-test` as a captured real line.

**Tests:**
- [ ] Rust (paused-time emitter harness, the same style as `a_prose_only_session_emits_within_the_idle_period`): a session with a Turn then quiet past `idle_collapse_after` gets exactly one retrospective; a beat after the collapse resumes intents and re-arms exactly one future collapse; a session with no Turn never collapses; a mid-stretch pause under the window never collapses.
- [ ] Rust: **a refused retrospective is attempted exactly once** across many subsequent sweeps — the direct pin on [P11]'s loop. Run it with a model stub that answers with something the gate refuses, and assert the request count is 1 after a long run of ticks.
- [ ] Rust: the same, for the dedup path — a retrospective digest identical to the last intent digest still reaches the model, and still marks `collapsed`.
- [ ] Rust: `Edited keymap shortcut conflicts` is **accepted** against a retrospective digest whose activity includes `Edit(keymap.ts)` ([P10]'s stem collision), and a retrospective that restates a whole tool line is **refused** by rule 4 — the pair that proves the heading is scoped in and the verb exemption is narrow.
- [ ] Rust unit: `compose_retrospective_digest` sections; `overview_frame` phase field serialization.
- [ ] `python3 tests/model-eval/analyze.py --self-test`.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast` green, zero warnings.
- [ ] `just app-debug`; `tugutil host tell local_model_summarize_done --instance <id> -p "prompt=<a .done.txt fixture>"` answers with a line, visible in the app log with `task=summarize_done`.

---

#### Step 4: Maybe-band corpus population {#step-4}

<!-- No dependency: the routing corpus is independent of the digest corpus and the register work. -->

**Commit:** `model-eval(classify): give the maybe band a measured population`

**References:** [P07] Classify pair, Spec S05, (#success-criteria)

**Artifacts:**
- 12–16 `band: "maybe"` cases in `classify-corpus.json`; `corpus-commands.txt` grown as needed; `_doc` updated.

**Tasks:**
- [ ] Author per Spec S05, verifying each expected band through the grade bin (`cargo run -p tuggram --bin grade`) before recording it — the corpus records what the grader *does*, hermetically re-checked by `tuggram`'s corpus tests.
- [ ] Keep the one-sided gate honest: any `maybe` case labeled `shell` must also survive `vetoesShellVerdict` (the veto-filter run in `classify.py` will tell).

**Tests:**
- [ ] `cd tugrust && cargo nextest run -p tuggram` green — `every_recorded_band_still_holds` and the injected-set test absorb the new cases.

**Checkpoint:**
- [ ] The corpus parses; `python3 tests/model-eval/classify.py --help` path unchanged; band counts in the corpus: ≥12 `maybe`, 14 `no` intact.

---

#### Step 5: The prompt rewrites — classify pair, summarize, retrospective {#step-5}

**Depends on:** #step-2, #step-3, #step-4

**Commit:** `local-model(prompts): design the classify pair around the synopsis, retell summarize at 64 characters`

**References:** [P03] 64ch, [P04] Current-ask bias, [P05] Retrospective, [P07] Classify pair, [P08] Blind authoring, (#composed-flow)

**Artifacts:**
- The default profile's four prompts rewritten: `classify` + `classifyWithGrammar` as one designed pair; `summarize` for 64ch current-ask-biased intents with paired examples in the new digest headings; `summarizeRetrospective` refined with paired examples in the `What the session did:` shape and past-tense openers.

**Tasks:**
- [ ] Classify pair per [P07]: shared core, doubt→PROMPT, paired examples; the grammar variant teaches synopsis-checking with at least one wrong-flags contrast pair. `{{GRAMMAR}}` mechanism unchanged.
- [ ] Summarize: replace "SIX WORDS MAXIMUM" with the 64-character rule stated as character room, keep verb-first plain-form and every other register rule; instruct the current-ask bias per [P04]; every example digest uses the real new headings and `Name(target)` forms; opening verbs on `verbs.txt` (plain section).
- [ ] Retrospective: same register rules with past-tense openers from the past-forms section; examples show a whole-stretch digest answered by what was accomplished, not a restated activity line.
- [ ] Keep every example subject disjoint from all 13 regenerated digests and the `.done.txt` fixtures — `run.py` preflight enforces it (exit 2 names the pair).
- [ ] Rewrite `run.py`'s `example_lines()` to anchor on structure, not length. Today it harvests any 2–6-word line whose first word stems to a known verb — the old word budget in disguise, which would silently drop every 64ch example from both lift detection and the contamination guard. Do **not** simply widen the bound: the length filter is also what keeps instruction prose out of the example set (`Not "Fixing", not "Building" — Fix, Build.` is a 6-word verb-initial line). The paired format already gives a reliable anchor — take the line following each `HEADLINE:` marker — which is exact where any length heuristic is a guess, and works for retrospective examples with no verb-list change.
- [ ] Restate the freeze docstring per [P06]'s coming shape (the profile struct arrives next step; write the doc once, here).

**Tests:**
- [ ] No Swift tests possible; validation is structural per [P08].

**Checkpoint:**
- [ ] `just app-debug` builds, zero warnings.
- [ ] `python3 tests/model-eval/run.py <instance>` does not exit 2 — the contamination sweep is a static source-text check and covers the retrospective examples too, even though the `--retrospective` scoring lane itself arrives in #step-9.
- [ ] `just model-liveness <instance>` passes (plumbing smoke only, not a recorded number).

---

#### Step 6: Per-pack prompt profiles {#step-6}

**Depends on:** #step-5

**Commit:** `local-model(prompts): resolve instructions through a per-pack profile`

**References:** [P06] Profiles in Swift, Spec S04, Risk R03, (#candidates)

**Artifacts:**
- `PromptProfile`, `profile(forModelId:)`, an empty overrides table; `perform` resolving per request; `profile=<name>` on the `handle` log line; `run.py` contamination sweeping all profiles; `harness.py` tolerating the new log field.

**Tasks:**
- [ ] Implement Spec S04; the four existing prompt constants become the default profile's fields; call sites in `perform` read the resolved profile.
- [ ] Add `profile` to the request log fields in `handle`; extend `harness.py`'s parsing so existing extraction is order-tolerant (the `VERDICT` regex trap from the grammar phase — a new field must not blind the parser; make the addition and run a captured-line self-check).
- [ ] `run.py`: contamination iterates every profile's examples. The existing mechanism (`summarize_prompt()`) reads the Swift source text anchored on the literal `static let summarize = """` — the profile refactor moves that string, so the extraction **must** move with it in the same commit or the guard silently returns empty and reports all-clear. Extend the extraction to every profile's `summarize` and `summarizeRetrospective` literals, and add a self-check that extraction found at least one example per profile (an empty extraction is a failure, not a clean bill).

**Tests:**
- [ ] `python3 tests/model-eval/run.py <instance>` preflight still exact on the default profile; a deliberately contaminated scratch profile (added locally, not committed) trips exit 2 — verify, then remove.

**Checkpoint:**
- [ ] `just app-debug` builds; one `local_model_summarize` tell shows `profile=default` in the app log.
- [ ] `python3 tests/model-eval/analyze.py --self-test` (log-shape fixtures updated).

---

#### Step 7: Grounding threshold re-sweep {#step-7}

**Depends on:** #step-5

**Commit:** `session-overview(pulse): re-sweep the grounding threshold for 64-character headlines`

**References:** [Q01] Threshold, [P03] 64ch, Risk R01, (#s02-64ch-register)

**Artifacts:**
- The swept `GROUNDED_MIN_*` values (moved or confirmed), pinned by an updated sweep test; the sweep recorded in the commit body.

**Tasks:**
- [ ] Capture the incumbent's real 64ch answers: `python3 tests/model-eval/run.py <instance> --json /tmp/register-sweep.json` (this is calibration input, not a bake-off number — [P08] is about scoring packs, and the sweep needs real answer shapes; use the incumbent only, and record nothing in the tables).
- [ ] Sweep the fraction over those answers, the regenerated digests, and every historical defect from trust-plan List L01 (re-expressed against the new digests where headings changed); pick per [Q01]'s rule; update the pin test's name/story if the value moved.

**Tests:**
- [ ] `cargo nextest run -p tugcast session_overview` — every List-L01-descendant defect refused, a correct headline accepted per digest, at the chosen value.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run -p tugcast` green; the commit body carries the sweep table.

---

#### Step 8: Candidate packs — catalog, staging, install {#step-8}

**Depends on:** #step-6

**Commit:** `local-model(catalog): stage the LFM2.5 rescue candidates`

**References:** [Q02] 6-bit lane, Table T01, Risk R06, (#pack-install, #candidates)

**Artifacts:**
- `CatalogEntry` values for `lfm25-1-2b-instruct-8bit` and `lfm25-8b-a1b-4bit` (`recommended: false, offered: false`), bytes staged and installed, load confirmed.

**Tasks:**
- [ ] Verify the mlx-swift-examples pin still registers `lfm2` and `lfm2_moe` before downloading anything (the recorded 2.78 GB lesson).
- [ ] Author entries per #pack-install, in that order: enumerate the file set from the tree API at the pinned revision (the LFM repos differ from qwen's — no `merges.txt`/`vocab.json`, and a `chat_template.jinja`), fetch into `.staging/<id>/`, **hash every file locally** (`shasum -a 256`) and size it from disk. The API supplies a digest only for the LFS `model.safetensors`; use it to cross-check that one file and nothing else. Then run `catalog_is_internally_consistent`.
- [ ] Finish the install via `local_model_download` onto the staged bytes — it verifies every digest, which makes the authoring step check itself — and confirm `tug-manifest.json` stamps and a warming summarize answers with `model=<id>` for each.
- [ ] Apply [Q02]'s rule for the 6-bit lane after the 8-bit's first *smoke* (a single tell, not a scored run); record the decision in the commit body.

**Tests:**
- [ ] `cd tugrust && cargo nextest run -p tugcast local_model` — catalog invariants, `file_url_pins_the_revision`.

**Checkpoint:**
- [ ] `tugutil host tell local_model_inventory --instance <id>` lists the new packs installed; each answers a warming tell.

---

#### Step 9: The bake-off and the ruling {#step-9}

**Depends on:** #step-3, #step-7, #step-8

**Commit:** `local-model(eval): run the flow bake-off and rule`

**References:** [P01], [P02], [P06], [P08], Spec S01, Tables T01–T05, Risks R03, R06, (#bakeoff-protocol)

**Artifacts:**
- `run.py --retrospective` (the `summarize_done` lane over `corpus/*.done.txt`, scored with `score.py`'s retrospective mode) — built here, before any pack is scored, so every pack gets all three lanes.
- Tables T03–T05 filled; a written ruling walking Table T02 in order; any earned per-pack profile authored, named, and re-scored under it (a profile authored mid-bake-off restarts that pack's lanes, not the others').

**Tasks:**
- [ ] Build the retrospective harness lane; verify against the incumbent's plumbing (one smoke) before the scored runs. `harness.py` scrapes the app's request line by task, so the lane must match `task=summarize_done` and **not** collide with `task=summarize` — the same field-shape trap that once made every answered classify line invisible by anchoring a regex to end-of-line. Check the extraction against a captured line of each task before spending a run.
- [ ] Run Spec S01 for each Table T01 pack in order; fill T03–T05 as each pack completes; the MoE lane is dropped without prejudice on a load/memory failure (Risk R06) and the drop recorded.
- [ ] If the 8-bit LFM fails the default profile in a way a small-model profile plausibly rescues (the rescue doc's Experiment B), author `lfm-small` per Spec S04 — shorter, fewer pairs — re-run its lanes under it, and mark the profile in every table row. This is the one sanctioned mid-bake-off authoring, and it invalidates nothing scored on other profiles ([P06]).
- [ ] Rule: walk Table T02 in this document, state where the packs separate, apply the MoE's strictly-better bar, and name the winner and its profile. If the ruling contradicts the historical qwen ruling, say so plainly — the pipelines changed; that is the expected shape of news, not a contradiction to explain away.

**Tests:**
- [ ] No new tests beyond the harness lane; the runs are the measurement.

**Checkpoint:**
- [ ] `just model-classify <instance>` exits 0 for every candidate (post-veto); the per-band table shows the Maybe band scored.
- [ ] Tables T03–T05 complete; the ruling section written into this document.

---

#### Step 10: Catalog end-state and doc retirement {#step-10}

**Depends on:** #step-9

**Commit:** `local-model(catalog): offer the ruled pack, retire the rescue brief`

**References:** [P01], [P06], Table T02, (#candidates, #documentation-plan)

**Artifacts:**
- `CATALOG` reordered: winner at index 0, `recommended: true, offered: true`, all others demoted; `notes` naming each pack's profile; `dash/rescue-or-rule-out-LFM.md` deleted.

**Tasks:**
- [ ] Reorder and set flags; `reconcile_catalog_ranks` (already landed, launch-gated on `TUG_INSTANCE_ID`) moves installed bases — confirm by inspection that a machine holding the old winner on `auto` resolves to the new one after relaunch.
- [ ] Rewrite `notes` to describe pack + profile, no quoted scores.
- [ ] Remove the rescue doc via `tugutil file rm`; its surviving mechanics live in this plan (#pack-install, Spec S01).

**Tests:**
- [ ] `catalog_is_internally_consistent`; `file_url_pins_the_revision`; `bun test tugdeck/src/lib/__tests__/local-model-store.test.ts` (picker ordering).

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run` fully green; `local_model_inventory` shows exactly one offered pack, winner first; with selection cleared to `auto`, a summarize tell logs `model=<winner>` and `profile=<its profile>`.

---

#### Step 11: Integration checkpoint — live app {#step-11}

**Depends on:** #step-9, #step-10

**Commit:** `N/A (verification only)`

**References:** [P03], [P04], [P05], [P07], Risks R01, R02, (#success-criteria)

**Tasks:**
- [ ] Drive a real session on the debug instance: read a dozen 64ch intents against the actual work, submit a fresh ask and watch the intent re-aim to it, then let the session settle and watch the intent collapse into a past-tense retrospective — and resume work to watch the retrospective yield.
- [ ] Type the standing probe set: both historical false-SHELL lines route to Claude; `git status`, `make test`, `rg TODO src`, `head Justfile` route to the shell; one deliberately wrong-flag line on a known command (a Maybe-band shape) routes wherever the model rules, with `grammar=true` visible on its log line.
- [ ] `just model-stats <instance>`: refusal rate, rescue rate, collapse rate, and headline change rate all reported; with two or more sessions live, the emit-slot contention path exercised (this run also discharges the trust plan's owed live-rate reading, and should say so).
- [ ] `just app-test-changed` for the phase's accumulated diff; if CORE TIER ADVISED, run `just app-test` and move on.

**Tests:**
- [ ] The acceptance sweep below.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run` green; `bun test` green; `bunx tsc --noEmit` clean; `bunx vite build` clean.
- [ ] `just model-classify` exit 0; `just model-eval` clean on the shipping pack in both modes; `just model-liveness` passes.
- [ ] No live headline — intent or retrospective — misdescribes the work. A single misdescription is a phase failure, not a rounding error.

#### What #step-11 verified, and what it could not {#step-11-record}

Mechanically green, all on the shipping pack: `cargo nextest run` 1772 passed, `bun test` 5907 passed with 0 failures, `bunx tsc --noEmit` and `bunx vite build` clean, the prompt/corpus contamination sweep clean over 9 examples across both lanes, `analyze.py --self-test` 13/13. `just model-classify` exits 0 at 88/99 with one own false SHELL that the veto catches and a Maybe band scored 17/17 over 17 cases. `just model-eval` 10/13 and `just model-eval-done` 11/13, both with zero copied examples, reproducing the #step-9 captures exactly. `just model-liveness` PASS. The derived app-test selection for the phase's accumulated diff is 11 files, all green.

The standing probe set routes through the whole composed pipeline — grader band, synopsis for a Maybe, model verdict, then the deck's own veto — and both historical false-SHELL lines reach Claude: the `tokei` line by the veto refusing the model's SHELL, the task-list line by the model answering PROMPT itself. `make test`, `rg TODO src`, and `head Justfile` route to the shell. Two Maybe-band lines (`git commit --amend-message "wip"`, `ls --sort=size`) carry `grammar=true` and are ruled SHELL. `git status` routes to Claude — a false PROMPT, one of the eleven this pack is recorded as making, costing one keystroke.

**Not verified here, and deliberately not:** the live-session half — a dozen 64ch intents read against real work, a fresh ask re-aiming the intent, a settled session collapsing to a retrospective, and resumed work yielding it back. There is no headless path to it: the control socket exposes no session-submit action, so nothing can drive a real turn from a script, and a 30-second idle collapse cannot live inside an app-test. `just model-stats` reports all four rates including the collapse line, and three of them read empty for the same reason — they count OVERVIEW frames, which only a real session emits.

That gap is not a harness that needs writing. The last exit criterion is that no live headline misdescribes the work, and whether a headline describes a session well is a judgement with no ground truth — the rubric scores register, the gate scores grounding, and neither can score *right*. It is read by a person using the build.

---

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** One shipping on-device pack, chosen on the final pipelines, serving a complete shell-classifier flow (band → designed prompt pair → exact-token verdict → veto) and a redesigned PULSE line (64ch current-ask-biased intents that collapse to a grounded what-was-done retrospective at idle).

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] `just model-classify` exits 0 for the shipping pack, with the Maybe band scored over ≥12 cases (per-band table).
- [ ] 64ch register everywhere: no word-count rule in `session_overview.rs` or `score.py`; `summarizeMaxTokens = 40`.
- [ ] The current ask is a labeled digest section; the corpus regenerated once; `corpus_digests_are_what_compose_digest_produces` and its retrospective sibling green.
- [ ] The idle collapse works live and in the paused-time tests: one retrospective **attempted** per idle stretch whatever the gate rules ([P11]), past-tense, gated in retrospective mode ([P10]), resumable.
- [ ] The grounding threshold is re-swept and pinned for 64ch ([Q01] closed).
- [ ] Tables T03–T05 filled for every candidate; the ruling written; exactly one `offered` entry; `notes` name profiles.
- [ ] `just model-stats` reports collapse rate alongside refusal/rescue/change rates; `analyze.py --self-test` green.
- [ ] Zero warnings: `cargo nextest run`, `bunx tsc --noEmit`, `bunx vite build`; `bun test` green.

**Acceptance tests:**
- [ ] `cd tugrust && cargo nextest run`
- [ ] `bun test`
- [ ] `just app-test-changed`
- [ ] `just model-classify <instance>`, `just model-eval <instance>` (both modes), `just model-liveness <instance>`, `just model-stats <instance>`

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] **Deck styling for `"phase": "done"`** — a visual register for the retrospective on the strip and the Lens row.
- [ ] **A Swift test target** — the standing structural gap, now covering profile resolution too.
- [ ] **The trust plan's app-test cluster re-run** — still owed to that plan's step 8.
- [ ] **Constrained decoding for classify** — unchanged position; revisit only if the veto proves insufficient.
- [ ] **Retire `ternary-bonsai-8b-2bit` and `lfm25-1-2b-instruct-4bit` entries entirely** once no installed base holds them.

| Checkpoint | Verification |
|------------|--------------|
| Prose cannot execute | `just model-classify` exit 0; historical false-SHELL lines route to Claude live |
| The Maybe band is measured | per-band table, ≥12 scored cases |
| Intents are 64ch, ask-biased, alive | live read in #step-11; `score.py` char budget; regenerated corpus |
| Idle collapses to truth, once | paused-time Rust tests incl. attempted-exactly-once; a live collapse observed and grounded |
| One pack, ruled on final pipelines | Tables T03–T05 + ruling; `catalog_is_internally_consistent` |
| Truth not bought with silence | `model-stats`: refusal <~20% of ticks, change rate healthy, collapse rate reported |
