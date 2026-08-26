# Stream-JSON Golden Catalog

This directory holds the **authoritative machine-readable golden fixtures** for the tugcast/tugcode/claude stream-json protocol. Every committed `v<version>/` subdirectory is a frozen snapshot of what `CodeSessionStore` sees when a specific `claude` version is running behind the tugcast WebSocket feed. The drift regression test at `tugrust/crates/tugcast/tests/stream_json_catalog_drift.rs` uses these fixtures as ground truth; if the fixtures say something exists, the reducer must handle it.

> **Layer caveat [D07].** Fixtures reflect the layer that `CodeSessionStore` actually consumes — *after* tugcast framing and *after* tugcode wrapping — not raw `claude` stream-json. Drift in any of the three layers (claude itself, tugcode's wrapper, tugcast's framing) is equally disruptive to the reducer, so one fixture catalog catches all three.

**Source of truth.** The originating design — the `#deep-version-bump-runbook` deep dive in the *tugplan-golden-stream-json-catalog* work — has shipped and is archived. **This README is the living reference** for the catalog as it stands. Where the differ has evolved since the original plan (e.g. the `shape_sequence` order reduction described under "Classification criteria" below), this file is authoritative and the archived tugplan is historical context.

**Cross-links:**
- the *transport-exploration* work — human-readable prose catalog of stream-json event types (may lag behind these fixtures; see its version banner)
- the *tugplan-golden-stream-json-catalog* work — the archived originating design for this catalog, the differ, and the runbook below

## Fixture layout

```
tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/
├── README.md                                   # this file
├── v2.1.104/                                   # frozen snapshot — one dir per claude version
│   ├── manifest.json                           # per-probe status + skip reasons
│   ├── schema.json                             # derived shape schema per event type
│   ├── test-01-basic-round-trip.jsonl          # normalized event stream for probe 1
│   ├── test-02-longer-response-streaming.jsonl
│   ├── ... (35 total)
│   └── test-35-askuserquestion-flow.jsonl
└── v2.1.105/                                   # subsequent version — same shape
    ├── manifest.json
    ├── schema.json
    ├── test-01-basic-round-trip.jsonl
    ├── ... (35 total)
    └── test-35-askuserquestion-flow.jsonl
```

**Keep old version directories.** Each version dir is ~350 KB (35 JSONL files × ~10 KB), so retention is cheap and lets future investigators reproduce historical behavior. It also means a local claude rollback to an older version makes the drift test pass without any re-capture. Never delete a `v*/` directory as part of a version bump.

**Directory name is the version string verbatim** (after sanitizing path separators). Pre-release tags are fine: `v2.1.105-beta.1/` is a valid directory name. Do not attempt to alias a beta to the eventual stable release.

## Placeholder vocabulary

Every fixture is processed by `normalize_event` (#deep-normalization) so that re-captures produce byte-identical output where the raw protocol carries varying values (UUIDs, timestamps, costs, paths). Placeholders appear in both JSONL event streams and the `manifest.json` / `schema.json` metadata.

| Placeholder | Replaces | When it fires |
|-------------|----------|---------------|
| `{{uuid}}` | A 36-character 8-4-4-4-12 hex UUID, OR any string value appearing under a leaf-identifier key (`session_id`, `tool_use_id`, `msg_id`, `request_id`, `task_id`, `tug_session_id`) | Key-based substitution regardless of whether the content parses as a real UUID — covers `"pending-cont-xyz"`-style sentinels |
| `{{iso}}` | An ISO-8601 timestamp leaf string matching `YYYY-MM-DDTHH:MM:SS` | Value-based substitution on any string leaf (no key requirement) |
| `{{text:len=N}}` | The value of a leaf string under a text-content key (`text`, `output`) | Key-based; the stored replacement records the character length so real-world size regressions are still visible |
| `{{f64}}` / `{{i64}}` | A leaf number under an allowlisted key (`total_cost_usd`, `duration_ms`, `duration_api_ms`, `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `runtime_ms`) | Key-based; `{{f64}}` for fractional, `{{i64}}` for integer. Non-allowlisted numeric fields (`seq`, `is_partial`) are preserved exactly because their values carry semantic meaning |
| `{{cwd}}/...` | Any leaf string that starts with the current `$HOME` | Value-based; the suffix after `$HOME` is appended so relative-path structure survives normalization |

**Why `content` is not in the text-content key list.** Anthropic's raw stream-json often uses `content` for *arrays of typed content blocks* rather than a leaf string. Collapsing it unconditionally to `{{text:len=N}}` would erase that structural polymorphism and hide real shape drift (for example, a new block variant being introduced). The walker recurses into `content` and the inner leaf `text` field is what gets collapsed. If a future claude version starts emitting a top-level `content: "string"` leaf, add it to the allowlist at that point rather than pre-emptively.

## Version-bump runbook

This is the workflow you run when claude ships a new version and the drift test can no longer find a matching golden. It is deliberately **manual**. The drift test is not in CI, not in the pre-commit hook, and not part of the default `cargo nextest run -p tugcast` suite — those all stay cheap on purpose. When the runbook fires, one developer runs it, classifies each change, and commits one atomic version-bump.

### When to run the workflow

Exactly three triggers. If none apply, don't run it.

1. **The drift test fails** with something like `no golden schema at .../v<X.Y.Z>/schema.json — per [D13] there is no version fallback`. This is the hard signal that claude has updated to a version that has no golden fixtures yet. The drift test's `v<version>/` lookup will not fall back to a previous version.
2. **You notice `claude --version` now reports a version newer than any committed `v*/` fixture dir**, even without running the drift test. Running the workflow preemptively avoids surprise failures during a later `CodeSessionStore` change.
3. **You're about to merge a change to `CodeSessionStore` or any other downstream consumer of the fixtures**, and the current claude version has no golden fixtures. You need fresh fixtures as your ground truth before reviewing the consumer change.

**Non-triggers** (skip the workflow):
- Claude version unchanged since the last successful drift run. Nothing to do.
- Pre-commit hook or CI runs — the drift test is deliberately not in either per `[D05]`. Don't wire it in.

### The workflow

Assumes `TUG_REAL_CLAUDE=1` is set in your shell or prefixed on every command. All paths below are relative to the tugtool repo root.

```sh
# 1. Confirm the installed claude version.
claude --version
# Expected output: something like "2.1.105 (Claude Code)"

# 2. Capture with stability. TUG_STABILITY=3 runs each probe 3 times and
#    asserts shape-identity across runs so you don't commit a fixture
#    built from one flaky capture. Expect roughly 5-6 minutes end-to-end
#    for the full 35-probe run.
#
#    As the final step, the capture binary also extracts the probe-28
#    system_metadata payload into the repo-root `capabilities/` tree and
#    updates `capabilities/LATEST` — Tug.app and tugdeck both consume
#    that snapshot at build time.
#
#    Scrub ANTHROPIC_API_KEY from the environment (the capture binary's
#    pre-flight will refuse to run otherwise) so claude authenticates via
#    your Max/Pro subscription instead of per-token API billing.
cd tugrust
env -u ANTHROPIC_API_KEY TUG_STABILITY=3 TUG_REAL_CLAUDE=1 \
  cargo nextest run -p tugcast --features real-claude-tests \
  --run-ignored only capture_all_probes

# 3. Review the run summary in the new v<new-version>/manifest.json.
#    Every probe should be `passed`, `shape_unstable` (accepted variance,
#    see below), or `skipped` with an explicit reason pointing at a
#    tide.md §T0.5 follow-up item.
cat crates/tugcast/tests/fixtures/stream-json-catalog/v<new-version>/manifest.json

# 4. Diff the new version dir against the previous version's dir.
#    Normalized placeholders keep this diff readable — real shape drift
#    stands out.
git diff --no-index \
  crates/tugcast/tests/fixtures/stream-json-catalog/v<old-version>/ \
  crates/tugcast/tests/fixtures/stream-json-catalog/v<new-version>/

# 5. Confirm the capabilities artifact rolled. The capture binary wrote
#    a single-line JSONL snapshot to `capabilities/<new-version>/` and
#    updated `capabilities/LATEST` to the new version string.
cat ../capabilities/LATEST
ls ../capabilities/<new-version>/

# 6. Classify each change using the criteria in the next section.
#    Benign changes → straight commit. Semantic changes → fix the
#    consumer first, commit alongside the new fixtures.

# 7. Commit the new version dir, the capabilities snapshot, and any
#    consumer fixes as one atomic version-bump change.
git add crates/tugcast/tests/fixtures/stream-json-catalog/v<new-version>/
git add ../capabilities/<new-version>/ ../capabilities/LATEST
git commit -m "test(tugcast): advance golden baseline to claude <new-version>"

# 8. Verify the drift test now passes.
env -u ANTHROPIC_API_KEY TUG_REAL_CLAUDE=1 \
  cargo nextest run -p tugcast --features real-claude-tests \
  --run-ignored only stream_json_catalog_drift_regression
# Expected: 1 passed, "stream_json_catalog_drift_regression: clean"
# with any new-field or new-event-type findings downgraded to warnings.
```

### Classification criteria

For each shape difference the diff surfaces, assign it to exactly one of three classes.

**What the differ absorbs before you ever see it.** The per-probe sequence comparison does not run on the raw event stream — it runs on a *shape reduction* (`shape_sequence` in `tests/common/catalog.rs`). Two kinds of run-to-run non-determinism are collapsed out and never reach the classification step:

- **Streaming-partial and usage-frame counts.** Consecutive `assistant_text` / `thinking_text` partials collapse to one (token batching makes the count non-deterministic). `streaming_usage` frames are dropped from the *order* comparison entirely — they flush at transport-dependent points and the reducer reads them by recency, not by position.
- **Tool-call count and interleaving.** A contiguous run of `tool_use` / `tool_result` / `tool_use_structured` events collapses to a single `tool_activity` token. Whether the agent made two `Glob` calls or three on a given capture, batched them in parallel, or interleaved their events differently is agent non-determinism, not protocol shape — `CodeSessionStore` pairs those events by `tool_use_id`, never by sequence position.

The event-type **set** check stays strict through all of this: a probe that *stops* emitting `tool_use_structured` or `streaming_usage`, or emits a brand-new event type, still fails (`RemovedSequenceSlots`) or warns (`NewSequenceSlots`). Only the *ordering* check is reduced. So a `ReorderedSequence` finding is now always a genuine transposition of the turn skeleton — never the agent doing N versus N±1 tool calls.

**One carve-out: `MODEL_OPTIONAL_EVENT_TYPES`** (`tests/common/catalog.rs`). A small set of event types that claude emits based on per-turn model behavior rather than a protocol contract — `thinking_text` is the canonical case — are stripped from the probe-sequence comparison on **both** sides before any diff. Their presence AND their absence are run-to-run variance (claude chooses whether to think per turn, and the choice flips on the same prompt), so neither produces a finding — no FAIL and no WARN, symmetrically. A WARN that can never be cleared by a refresh would be noise, not signal. Their field *shape*, when a capture does carry one, is still pinned by the event-shape diff. The probe table also lists them in `optional_events` for capture-time stability checks; this constant is the drift differ's counterpart.

There is a related but distinct position-exemption: `INTERSTITIAL_EVENT_TYPES` (`streaming_usage`, `rate_limit_event`, `prompt_anchor`). Those frames genuinely occur every turn, but their *position* in the stream is non-deterministic (they're flushed/echoed at points that race the content stream), so `shape_sequence` drops them from the *order* check while the set check still pins their existence. Model-optional (presence-varying) and interstitial (position-varying) are the two axes of benign non-determinism the differ accounts for.

#### Benign — no consumer change needed

Commit the new fixture, keep the old. Examples:

- **A new optional field** appears on an existing event type. Example: `system_metadata` gains an `inference_geo` field that wasn't in the previous version. The differ reports this as `NewField` at WARN severity.
- **A new optional event type** appears in a probe's sequence. Example: `thinking_text` starts appearing in a probe that didn't emit it before. The differ reports this as `NewSequenceSlots` at WARN severity.
- **A previously-REQUIRED event is now sometimes absent** across stability runs → demoted to OPTIONAL. The probe table gets an amendment but no consumer changes. Expect this to surface as `shape_unstable` in the manifest.
- **A new discriminant arm appears in a polymorphic event.** Example: `tool_use_structured.by_tool_name` gains a `NewTool` entry. The differ reports this as `NewToolUseUnion` at WARN severity. Commit and move on unless `CodeSessionStore` actively cares about that tool.

#### Semantic — consumer change required

Fix the consumer **first**, then commit the new fixture alongside the consumer fix in one atomic commit:

- **An existing required field disappears from an event.** Example: `assistant_text.text` renamed to `assistant_text.content`. Differ reports `MissingRequiredField` at FAIL severity.
- **An existing field's type changes.** Example: `cost_update.total_cost_usd` shifts from `number` to `string`. Differ reports `TypeMismatch` at FAIL severity.
- **A previously-REQUIRED event is now absent across all stability runs** — it was removed from the protocol. The consumer reducer must stop expecting it.
- **A probe's required event sequence changes in a way the reducer relies on.** Example: `cost_update` now fires before `assistant_text` instead of after. Differ reports `RemovedSequenceSlots` or `ReorderedSequence` at FAIL severity.
- **A polymorphic discriminant's shape changes** for a tool the consumer actively uses. Example: Read's `structured_result.file.content` becomes `structured_result.file.body`.

#### Ambiguous — stop, think, discuss

- **A probe that used to pass now `shape_unstable`s across stability runs**, and reclassifying events REQUIRED → OPTIONAL doesn't fix it. Something upstream is flapping; root-cause it before committing.
- **Session-command probes (`test-13`/`test-17`/`test-20`) behave differently** than they did in the previous version. Might be a new tugcode bug or might be legitimate claude behavior. Log a new §T0.5 follow-up and mark the probe skipped until diagnosed.
- **A probe produces completely new event types the prose never mentioned** and `CodeSessionStore` has no idea how to handle. Needs a decision: add to reducer? ignore? version-gate?
- **The new version regresses**: a previously-stable probe now fails outright against live claude. This is an upstream bug, not a drift. Log it, skip the probe, capture the rest, come back later.

**When in doubt, default to Semantic (safer) rather than Benign (risks silent consumer breakage).**

### Edge cases

- **Capture fails reproducibly on one probe.** Don't commit the partial `v<new-version>/` dir. Log a §T0.5 follow-up (P16-style), mark that probe `skipped` in the probe table (see `tests/common/probes.rs` — add a `skip_reason` pointing at the tide item), re-run the capture, commit the now-complete `v<new-version>/`. The new version is still the baseline; one skipped probe does not block a version bump.
- **Capture fails reproducibly on *many* probes.** Likely a tugcode regression or claude regression. Don't commit. Investigate the root cause first. Log separate `P<N>` follow-ups for each distinct failure mode.
- **Claude version regression** (e.g., you rolled back from `2.1.105` to `2.1.104`): the drift test now asks for `v2.1.104/` which already exists, so it just passes. No action needed.
- **Pre-release / beta versions** (`2.1.105-beta.1`): capture to `v2.1.105-beta.1/` — the dir name uses the version string verbatim after sanitizing slashes.
- **Multiple versions in one day**: same workflow per version. Each version gets its own dir. Don't try to consolidate.
- **The orphaned-tmux-session trap (prevention is in place, but).** The tugcast test harness spawns a real `tug-test-<port>` tmux session per probe. Prior to the Step-8-followup fix, those sessions leaked on any crash that bypassed Rust's `Drop` machinery (kernel SIGKILL, panic-during-panic, Ctrl-C during setup), because tmux sessions live in the tmux server daemon's process tree and SIGKILLing tugcast doesn't reach them. Left long enough, the accumulation exhausted the macOS pty pool and new sessions started failing with `tmux: failed to create session / fork failed: Device not configured`. The fix is a two-part cleanup in `tests/common/mod.rs`: (A) an `impl Drop for TestTugcast` that runs `tmux kill-session -t tug-test-<port>` *before* the child is SIGKILLed, and (C) a startup reaper that runs exactly once per test process and kills any `tug-test-*` session whose embedded port is no longer bound by a live process. Between those two, every spawn self-cleans and every startup purges stragglers from past crashes. If you still see the error, run `tmux list-sessions -F '#S' | grep '^tug-test-' | xargs -I {} tmux kill-session -t {}` as a manual belt-and-suspenders and investigate why both (A) and (C) were bypassed.
- **`ANTHROPIC_API_KEY` in the environment.** Both the capture binary and the drift test refuse to run with this variable set, to prevent silently switching from your Max/Pro subscription to per-token API billing. Use `env -u ANTHROPIC_API_KEY` on the command line rather than permanently unsetting it in your shell.

### Who runs it, and when

- **Triggered by a developer**, not by CI or automation. The drift test exists specifically as a manual gate, not a continuous check.
- **Typical cadence**: once every few days to once every couple of weeks, depending on how often Anthropic ships claude updates.
- **Not run**: on every commit, every PR, every `cargo nextest` invocation, or every developer's machine. The real-claude test suite is explicitly excluded from routine workflows per `[D05]` exactly to keep them cheap.
- **Results of a workflow run** — the new `v<version>/` dir plus any consumer fixes — land as one atomic commit. Suggested message style: `test(tugcast): advance golden baseline to claude <new-version>` for a pure fixture refresh, or `fix(code-session-store): handle <semantic change>; advance fixtures to v<new-version>` for a consumer-fix version.

## How to add a new probe to the table

The probe table lives at `tugrust/crates/tugcast/tests/common/probes.rs` and is the single source of truth for both the capture binary and the drift test. Adding a new probe means adding one entry to the `PROBES` constant and (optionally) re-running the capture workflow to get it into the current baseline.

**Minimum viable probe:**

```rust
ProbeRecord {
    name: "test-36-my-new-scenario",
    input_script: &[ProbeMsg::UserMessage {
        text: "the prompt that drives the scenario",
    }],
    required_events: &["session_init", "system_metadata", "turn_complete"],
    optional_events: &[],
    prerequisites: &[],
    timeout_secs: 30,
    skip_reason: None,
},
```

**Guidance:**

- **Name** `test-<NN>-<slug>`. `NN` is a two-digit decimal zero-padded so lexicographic file order matches probe order. The slug is a short kebab-case description.
- **`input_script`** is a list of `ProbeMsg` values — `UserMessage`, `UserMessageWithAttachments`, `Interrupt`, `ToolApproval`, `QuestionAnswer`, `SessionCommand`, `ModelChange`, `PermissionMode`, `WaitForEvent`, `Sleep`, `RewindPreview`/`SessionRewind` (`/rewind` bridge), and `CaptureAnchor`/`ConsumeEvent` (consuming waits that disambiguate turn instances in a multi-turn probe — e.g. capturing turn 2's `prompt_anchor`, or gating on turn 2's `turn_complete`, instead of the first buffered one). See `tests/common/probes.rs` for the concrete shapes.
- **`required_events`** — event types that *must* appear. Start conservative (include everything you expect to see); the Step 4 stability run will demote flapping events to optional automatically.
- **`optional_events`** — event types that *may* appear but are not shape-checked if absent.
- **`prerequisites`** — capture-time preconditions. `TugplugPluginLoaded` is satisfied when `$project_dir/tugplug/` exists on disk (true for the capture binary, false for some other test harnesses). `DenialCapableTool` is currently always considered satisfied.
- **`timeout_secs`** — generous budget. Anything over ~45 s will hit the §T0.5 P19 "45s WebSocket reset" ceiling and fail; until P19 is fixed, probes requiring long turns must be `skip_reason`-gated.
- **`skip_reason`** — `Some("blocked on tide.md §T0.5 P<N> — <one-line reason>")` for probes that are blocked on a known upstream bug. Capture-time execution bypasses the probe and emits an empty JSONL file with an explicit `skipped` status in the manifest. This is how we keep blocked probes in the table without polluting the fixtures.

After editing the probe table, re-run the capture workflow against the current claude version to get the new probe into the baseline. The drift test will then pin its shape on subsequent runs.

## How to classify REQUIRED vs OPTIONAL

When the capture surfaces a probe as `shape_unstable` or when a new probe's event sequence isn't 100 % consistent across stability runs, you need to decide which events are REQUIRED (must appear in every run) and which are OPTIONAL (may appear in some runs but not others). The differ uses this classification to decide what's benign variance versus real drift.

**Default**: every event is REQUIRED. Only demote to OPTIONAL after `TUG_STABILITY=3` has surfaced empirical flapping. This conservative default prevents silent tolerance of absent events that should have appeared.

**Indicators that an event is genuinely OPTIONAL:**

- The capture reports `shape_unstable` with a diagnostic of the form `canonical event-type sequence differs at stability run X/3` — the flapping event is present in some runs and absent in others.
- The event is `thinking_text`, `assistant_text` (complete), or another streaming-side slot that claude's token batching sometimes skips on short outputs.
- The event is a trailing `assistant_text` after `turn_complete` — sometimes emitted as a post-turn cleanup, sometimes not.

**Indicators that an event is still REQUIRED** (don't demote):

- The event is `session_init`, `system_metadata`, `cost_update`, or `turn_complete` — these are the structural bookends of every turn and should never be absent.
- The event is a `tool_use` / `tool_result` / `tool_use_structured` triple for a probe that explicitly asks claude to use a tool. If they're flapping, something is actually wrong — don't paper over it by marking them OPTIONAL.
- The event is `control_request_forward` in a probe that explicitly exercises the permission flow. Same reasoning.

**When you demote**: remove the event from `required_events` and add it to `optional_events` in the probe table. Re-run the capture to confirm the probe now reports `passed` (not `shape_unstable`). Commit the probe-table change and the new fixtures as one atomic change.

**When you don't demote and the flapping is real**: log a §T0.5 follow-up, mark the probe `skip_reason`-gated with a pointer, and re-run the capture. The probe stays in the table as a known-broken marker until the root cause is fixed.

## Future automation (explicitly out of scope for Layer A)

The runbook above is manual by design. Nothing in Layer A automates version-bump detection, capture, or diffing. The following are explicit follow-ons that can land later but are **not** required for it:

- `scripts/bump-claude-version.sh` — wrapper that runs steps 1–7 of the workflow, prints a classification summary, and prompts for confirmation before committing.
- Weekly scheduled CI run of the drift test against the latest published `claude` — a soft signal (failing build that doesn't block merges) that a capture is due. Requires a CI mini-runner with `TUG_REAL_CLAUDE=1` and a real `claude` binary on the subscription, which is infrastructure we don't currently have.
- A `git` pre-push hook that compares the locally-installed claude version against the most recent `v*/` fixture dir and warns if they differ. Low-priority nicety.
- A cross-version structural differ — a tool that summarizes `v<old>/` vs `v<new>/` as a human-readable "what changed in claude" report, better than raw `git diff`. Bonus tooling on top of the fixture format.
