# Local model liveness — brief

Follow-on work from the PULSE two-level display (`dash/pulse-improvements.md`, landed on the `pulse-display` dash). That plan shipped the display and the register guarantee. This brief covers the question it left open: **how do we know the thing is alive, and fast enough to be worth having?**

Written 2026-07-28.

---

## The position this starts from

We are not doing AI evals here, and the distinction matters enough to write down so nobody re-proposes it.

Scoring a model against a fixed corpus is the wrong instrument for this feature. There is no ground truth for "what is this session working on" — two competent people write different headlines and both are right, so scoring against a reference measures agreement with whoever wrote the reference. That genre is retired here (see [Retiring the re-score](#retiring-the-re-score) below).

What replaces it is not a weaker eval. It is a different question, asked in three places:

- **Form** is already guaranteed and needs nothing further. `headline_register` in `tugrust/crates/tugcast/src/feeds/session_overview.rs` is a pure function with unit tests, and it holds the register whether or not the model cooperates. Anything a form eval would catch is already caught in CI, for free, forever.
- **Liveness** is untested and is the real gap. See [1](#1-the-liveness-smoke-test).
- **Performance** is unbounded and unmeasured. See [2](#2-turnaround-constraints).

**Groundedness — whether a headline is actually about the work — is deliberately not tested.** It was proposed (a discriminator over real digests, no golden answers) and rejected by the owner: this code gets used every day on real sessions, and actual usage is the only groundedness that means anything. A synthetic groundedness check is a slippery slope back into the genre we just retired. Recorded here so the idea stays dead.

---

## 1. The liveness smoke test

**The gap.** Nothing exercises the real path end to end. It is covered at both ends and nowhere in the middle:

```
digest → LocalModelRequester::summarize → control socket → LocalModelService (Swift)
       → MLX → reply → headline_register → overview_frame → PulseStore → strip / Lens
```

`session_overview.rs` unit tests cover the emitter with a stub. `at0282-pulse-two-level.test.ts` covers the deck with published frames. `at0280-local-model-absent.test.ts` covers the model being *absent*. The middle — the socket, the Swift service, the runtime, a real answer coming back — has no coverage at all.

**What to build.** One test. Not in CI: it needs a downloaded pack, so it is on-demand, in the same spirit as the real-claude tests.

- Feed a known digest through the real `summarize` path.
- Assert a frame comes back: non-empty, within the turnaround ceiling from [2](#2-turnaround-constraints), and passing `headline_register` unchanged (i.e. the model produced something already in register — if the normalizer had to fix it, that is worth seeing, not failing on).
- Assert nothing about *what* it says. That is the owner's eye, and this test has no opinion.

**Skip cleanly when no pack is installed**, with a message naming Tug ▸ **Set Up Tug…** as the way to get one. A test that fails on a machine without a model is a test people learn to ignore.

**Open question:** which layer to drive it from. A Rust integration test in tugcast is closest to the code but needs a live Tug.app on the other end of the control socket; an app-test has the app already but reaches the model path awkwardly. The CONTROL `local_model_summarize` proof-of-life action already exists and may be the cheapest driver — worth looking at first.

---

## 2. Turnaround constraints

**Two findings from reading the current code.**

**`REQUEST_TIMEOUT` is a transport deadline, not a performance budget.** `local_model.rs:746` sets 10s, shared by every task — classify, summarize, generate. It answers "did the app answer at all," which is not the question. A 24-token headline that takes 8s is a broken feature, and it never trips this.

**Nothing is measured.** No duration is recorded anywhere on the path. On failure the emitter `warn!`s (`session_overview.rs:501`) and enters back-off (60s → 600s). Refusals, timeouts, and slow answers all vanish into the log with no count and no duration. We currently cannot answer "is it fast enough" or "how often does it fail" even after using it all day.

**What to build.**

- **A per-task budget, separate from the transport deadline.** `summarize` gets its own ceiling, well under the shared 10s, so the timeout means something. Classify wants a much tighter one than summarize — it sits in the composer's path where a person is waiting, whereas summarize runs on a background task where the cost of slowness is staleness and battery, not jank. That asymmetry is the reason one shared constant was always wrong.
- **A "slow" threshold below the ceiling** that records rather than fails. The interesting signal is the drift from 2s to 6s, not the cliff at the timeout.
- **Recorded durations and outcome counts** per task: attempts, successes, timeouts, refusals, transport failures.
- **Normalizer work rate.** How often `headline_register` changed the string at all, and how often it had to clip. This is the honest read on whether the prompt is working, and [Q01] of the display plan already leans on it — *"if clipping is common at 56 the model is not in register"*. Today that rate is invisible.

**Starting numbers, explicitly provisional.** These are shape, not measurement — set them for real from the first live session, exactly as [Q01] and [Q02] are meant to be:

| Bound | Proposed | Why |
|---|---|---|
| `summarize` slow threshold | ~3s | Prefill on a ~1500-char digest dominates; 24 output tokens are cheap |
| `summarize` ceiling | ~6s | Comfortably under `EMIT_FLOOR` (15s), so cadence stays designed rather than inference-bound |
| `classify` ceiling | ~1s | A person is waiting on this one |

The cadence point is the load-bearing one. `EMIT_FLOOR` is 15s. If inference creeps toward it, the emitter's cadence stops being the thing we designed and starts being whatever the hardware happens to do — and that failure is silent today.

**Where the numbers surface.** They originate in tugcast (Rust) and the natural home for reading them is the dev panel's Telemetry tab (Opt-Cmd-/), which needs a channel from tugcast to the deck. That is the main design decision for this item. The cheaper first move is structured `tracing` output read via `just logs-debug` — no new plumbing, enough to answer the question, and it can be promoted to the panel later if it earns it. Start there unless the panel turns out to be nearly free.

---

## 3. Retiring the re-score {#retiring-the-re-score}

[P05] of `dash/pulse-improvements.md` obliged a full re-score against `~/bonsai-eval/pulse_8b.py` because the `summarize` prompt changed. **That obligation is withdrawn** — it is the genre described at the top of this brief, and the bars it scores against carry no information about whether this feature works.

The legitimate residue is one narrow comparative question, and only when a change might have broken a decision already made: *did this prompt change break the model choice?* Same pack, same hardware, old prompt against new, does it still produce grounded output at all. An n of two, run by hand, when there is a reason. Not a gate, not a score, not a bar.

The `LocalModelPrompts` freeze rule in `tugapp/Sources/LocalModelService.swift` **stays** — it is doing a different job. It keeps catalog entries comparable on identical wording, which is a real property of the catalog, and it is what makes a prompt change a deliberate act rather than a drive-by edit. Changing a prompt should still be conscious; it just no longer summons a scoring run.

---

## Work items

- [x] Liveness smoke test, on-demand, skipping cleanly without a pack ([1](#1-the-liveness-smoke-test)). Driving layer decided: the existing `tests/model-eval` harness — `just model-liveness`.
- [x] Split the per-task timeout off `REQUEST_TIMEOUT`; give `summarize` and `classify` their own ceilings ([2](#2-turnaround-constraints)). `SUMMARIZE_TIMEOUT` 6s and `CLASSIFY_TIMEOUT` 2s; the proposed 1s classify ceiling became a *slow threshold* instead, because 2s is one of three constants that must agree.
- [x] Record turnaround durations and outcome counts per task; emit them as structured `tracing` first, dev-panel Telemetry only if it is nearly free. One line per request from both perspectives, read in batch by `just model-stats`. The panel was not nearly free and is deliberately not extended.
- [x] Record the normalizer's work rate — changed and clipped — as the standing read on the prompt. `HeadlineReport` distinguishes `normalized` / `trimmed` / `clipped`, since a trim means the model wrote a parts list and a clip means it wrote prose.
- [ ] Set the real numbers from live sessions, alongside [Q01] and [Q02] of the display plan. Left open deliberately: the instrument shipped, the numbers need a week of accumulated use. See `dash/local-model-liveness-completion.md`, which closed the four items above.
- [x] Retire the [P05] re-score obligation ([3](#retiring-the-re-score)).

## Explicitly not doing

- Any groundedness or quality check over a fixture set. Actual daily usage is the groundedness.
- Any scored eval, leaderboard, or pass-bar for headline quality.
- CI coverage of the live model path. It needs a downloaded pack and real hardware; on-demand is the honest form.
