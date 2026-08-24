<!-- devise-skeleton v4 -->

## Background-Agent Transcript Restore on Resume {#subagent-resume}

**Purpose:** Restore a background (async) agent's full child-tool-call history and final answer into its Agent block when a Dev session is resumed (Maker ▸ Reload / cold resume), by reading Claude Code's out-of-band `subagents/agent-*.jsonl` transcripts and splicing them into the JSONL replay stream as parent-linked child frames.

---

### Plan Metadata {#plan-metadata}

| Field | Value |
|------|-------|
| Owner | Ken Kocienda |
| Status | draft |
| Target branch | main |
| Last updated | 2026-06-30 |

---

### Phase Overview {#phase-overview}

#### Context {#context}

At Claude Code 2.1.197 a `Agent` call can be **backgrounded** (async). When it is, the parent session's JSONL records only the launch: the `Agent` `tool_use` and a `tool_result` echo (`isAsync: true, status: "async_launched", agentId: …`) — **no child tool calls and no final answer**. The agent's actual work — every nested `Bash`/`Read`/… call plus its final answer — is persisted **out-of-band** in a separate file, `<sessionDir>/subagents/agent-<agentId>.jsonl`, with a `.meta.json` sidecar that records the launching `toolUseId`, `agentType`, `description`, and `spawnDepth`.

Live, the child calls stream inline to the deck tagged with `parent_tool_use_id`; the reducer links them and the Agent block renders them. But on **resume**, tugcode's JSONL replay translator (`translateJsonlSession`) reads only the **main** session JSONL — which has no children — and `claude --resume` does not re-emit the background agent's internal events (verified: after Maker ▸ Reload the Agent block goes empty). tugcode has **no reader** for the `subagents/` files. The result is a serious regression: a resumed session loses the entire background-agent transcript and renders an empty Agent block.

This plan closes that gap by teaching the resume/replay path to discover, read, and splice the subagent transcripts back in — reconstructing exactly the parent-linked child frames the live path produced, plus the final answer that only exists after completion.

#### Strategy {#strategy}

- **Splice in the replay translator, not the deck.** The deck reducer already links children by `parentToolUseId` and partitions them via `childToolCallsByParent`; the transcript renders a call as a child whenever its `parentToolUseId` is set. So the entire fix is producing the right frames — no deck rendering changes for the core path.
- **Key linkage off `.meta.json`, not fuzzy matching.** Each `agent-<id>.meta.json` carries the launching `toolUseId` directly. Link every call in a subagent file to that `toolUseId`; no need to parse the async echo or match `agentId` heuristically.
- **Keep `replay.ts` filesystem-free.** `session.ts` owns path resolution and fs (mirroring the existing `claudeProjectsRoot` injection); it discovers + reads the subagent transcripts and hands them to the pure translator via `ReplayInput`.
- **Flat stamping + natural recursion.** Every tool call in a given subagent file is a direct child of that file's `meta.toolUseId` (a nested agent has its *own* file). Stamp all frames from a file with that one parent id; nesting resolves by enumerating every file and stamping each by its own meta — no bespoke depth walk.
- **Synthesize the Agent's structured result.** Build a `tool_use_structured` for the Agent from the subagent transcript (final answer text + `totalToolUseCount` / `totalTokens` / `totalDurationMs`) so the header count badge, duration, and final answer restore — not just the intermediate calls.
- **Idempotent with the live gap-bridge.** For an agent still running at resume, spliced persisted calls and live new calls coexist; dedupe rides the reducer's existing per-`tool_use_id` idempotency.
- **Real content through real code.** Tests drive the *actual* captured subagent fixture through the real translator; a recurring capture probe locks the end-to-end path.

#### Success Criteria (Measurable) {#success-criteria}

- After a Maker ▸ Reload of a session containing a completed background agent, the Agent block renders **all** its child tool calls (not the empty block seen today), each independently collapsible, with the "N calls" badge matching the subagent transcript's tool-call count. (Verify live against session `1c53fe86-82ea-495f-9616-b200f7240f0e`.)
- The Agent block's final answer text and duration/token footer restore on resume. (Verify: composed `tool_use_structured` carries `content` + stats.)
- A tugcode replay unit test drives the real captured subagent fixture through `translateJsonlSession` and asserts child `tool_use` frames emit with `parentToolUseId === meta.toolUseId`. (Verify: `cd tugcode && bun test`.)
- A nested agent (spawnDepth ≥ 2) links its children under the correct inner Agent `tool_use`. (Verify: unit test with a two-level fixture.)
- Resuming a session with **no** background agents emits byte-identical replay frames to today (no regressions). (Verify: existing replay tests stay green.)
- A recurring capture probe exercises launch → complete → resume and **structurally** asserts restored children (count > 0, `parentToolUseId` set). **Non-gating / on-demand** — the deterministic gate is the real-fixture unit + deck fixture-replay tests. (Verify: catalog/probe run.)

#### Scope {#scope}

1. tugcode: discover + read `subagents/agent-*.jsonl` + `.meta.json` for a resumed session (`session.ts`).
2. tugcode: pure synthesis of parent-linked child `tool_use` / `tool_result` / `tool_use_structured` frames from a subagent transcript (`replay.ts`).
3. tugcode: splice those frames into `translateJsonlSession`, window-aware and nesting-aware.
4. tugcode: synthesize the Agent's `tool_use_structured` (final answer + stats) from the transcript.
5. tugcode: wire the resume orchestration to pass discovered transcripts into the translator.
6. Tests: real-fixture unit tests + a recurring capture probe + a deck fixture-replay assertion that the Agent block renders children after replay.
7. Rebuild the compiled `tugcode` binary; app-test; live verification.

#### Non-goals (Explicitly out of scope) {#non-goals}

- Changing the deck's Agent rendering (Part A/B already landed independent collapse + expanded-by-default; this plan feeds them data, it does not restyle them).
- Restoring background-agent progress for a *live, never-persisted* window (that is the existing `task_progress` path — untouched).
- Fixing the `Monitor` `InputValidationError` observed in the same session — that is a model tool-use miss (deferred-tool schema not loaded), not a Tug bug; the block already renders it gracefully.
- Reworking Claude Code's persistence or the `tool-results/` offload format — we consume what exists.

#### Dependencies / Prerequisites {#dependencies}

- Claude Code 2.1.197 subagent layout: `<claudeProjectsRoot>/<encodeProjectDir(projectDir)>/<claudeSessionId>/subagents/agent-<agentId>.jsonl` + `agent-<agentId>.meta.json`, with a sibling `tool-results/` offload dir. (Verified on disk this session.)
- The deck reducer's existing `parentToolUseId` linking + `childToolCallsByParent` partition (`reducer.ts`, `dev-card-transcript.tsx`) — consumed unchanged.
- The compiled `tugcode` binary must be rebuilt for the change to be live in the running Release app.

#### Constraints {#constraints}

- Replay is budgeted: `REPLAY_HARD_TIMEOUT_MS` (10s) and `REPLAY_LIVE_BUFFER_MAX`. Subagent reads must stay inside the budget; a whale session with many/large subagent files must not blow it.
- `replay.ts` is pure (takes a JSONL string, no fs) — the split must be preserved; discovery/reads live in `session.ts`.
- **WARNINGS ARE ERRORS** in Rust (capture harness / probes); tugcode tests must pass with no warnings.
- Real, not fake: tests drive real captured content through the real translator; no mock-store assertions or synthetic-only fixtures.

#### Assumptions {#assumptions}

- Every tool call within a single `agent-<id>.jsonl` is a direct child of that file's `meta.toolUseId` (a nested agent gets its own file). (Verified: subagent entries carry no `parent_tool_use_id`; nesting is expressed by separate files + `spawnDepth`.)
- `.meta.json` reliably carries `toolUseId` (the launching Agent's `tool_use.id`). (Verified: `{"agentType":"Explore","description":…,"toolUseId":"toolu_01Rvup4w…","spawnDepth":1}`.)
- `claude --resume` does **not** re-emit background-subagent internal events (so splicing is the sole source; no duplication from claude). (Verified: children absent after reload.)

---

### Reference and Anchor Conventions (MANDATORY) {#reference-conventions}

Anchors are explicit and kebab-case; steps cite decisions/specs/anchors, never line numbers. Plan-local decisions use `[P01]`.

---

### Open Questions (MUST RESOLVE OR EXPLICITLY DEFER) {#open-questions}

#### [Q01] Offloaded tool-result content (`tool-results/<id>.txt`) (OPEN) {#q01-offloaded-results}

**Question:** Do subagent `tool_result` blocks carry their content inline, or reference an external `tool-results/<hash>.txt` file (Claude Code's large-output offload)?

**Why it matters:** If large results are offloaded, spliced child result bodies would render empty/truncated unless we resolve the pointer and inline the content (bounded by a size cap).

**Options (if known):**
- Inline present in the subagent JSONL → no extra read needed.
- Pointer/reference → resolve against the sibling `tool-results/` dir during read, size-capped.

**Plan to resolve:** Spike in Step 1 — dump a large subagent `tool_result` block from the real fixture and inspect. Wire resolution into the reader only if referenced.

**Resolution:** DECIDED (resolved in #step-1) — **no resolver needed.** Large outputs are stored **inline** in the subagent `tool_result` as a `<persisted-output>` string carrying a 2KB preview plus the `tool-results/<hash>.txt` path (verified on the real fixture). This is exactly what the live path shows the model, so the reader passes `tool_result.content` through **verbatim** — preview wrapper and all. No `tool-results/` dereference.

#### [Q02] Structured-result synthesis fidelity in v1 (OPEN) {#q02-structured-result}

**Question:** Do we synthesize the Agent's `tool_use_structured` (final answer + `totalToolUseCount`/`totalTokens`/`totalDurationMs`) in v1, or ship intermediate calls only first?

**Why it matters:** Without it, resume restores the child calls but not the final answer text or the footer stats — a visibly incomplete Agent.

**Options:** include in v1 (recommended — it is the visible completion) / defer to a follow-on.

**Plan to resolve:** Decide DECIDED via [P06]; implement in #step-5.

**Resolution:** DECIDED — include in v1 (see [P06]).

#### [Q03] Recency-window interaction (OPEN) {#q03-window}

**Question:** When replay emits only a recency window (`opts.window`), must spliced children of an Agent that falls **outside** the window be suppressed?

**Why it matters:** Emitting children for a windowed-out parent would orphan them (no parent `tool_use` in the stream) and inflate the window.

**Plan to resolve:** Splice only for Agents whose `tool_use` is actually emitted in the window; gate the splice on the same emit decision the translator already makes.

**Resolution:** OPEN — resolved in #step-4 (splice is downstream of the per-entry emit, so a suppressed Agent emits no children by construction).

---

### Risks and Mitigations {#risks}

| Risk | Impact | Likelihood | Mitigation | Trigger to revisit |
|------|--------|------------|------------|--------------------|
| Perf on whale sessions (many/large subagent files) | med | med | Bounded reads, size caps, count/byte telemetry; stay inside replay budget | replay_timeout observed |
| Double-emit with live gap-bridge (still-running agent) | med | low | Per-`tool_use_id` reducer idempotency; splice persisted, live carries new | Duplicated child rows |
| Claude Code changes subagent layout / meta schema | high | low | Shape-guard the meta/read; on mismatch skip gracefully (empty children, one warn) — never crash replay | Capture probe drift |
| Nested-agent depth explosion | low | low | Enumerate files once, stamp by meta; deck `AGENT_MAX_DEPTH` bounds render | Pathological nesting |

**Risk R01: Replay budget blown by subagent reads** {#r01-perf}

- **Risk:** Reading and translating large subagent files pushes replay past `REPLAY_HARD_TIMEOUT_MS`.
- **Mitigation:** Read subagent files lazily/bounded; cap per-result body size; emit `dev::replay::subagent_*` byte/count telemetry; discovery is a cheap `readdir` + small meta parse.
- **Residual risk:** A truly pathological session (dozens of megabyte-scale agents) may still window; acceptable — the window path already exists.

**Risk R02: Duplicate children for a live-at-resume agent** {#r02-dupe}

- **Risk:** Splicing persisted calls while the live path also delivers them duplicates rows.
- **Mitigation:** The reducer already dedupes `tool_use` by id and refuses to clobber filled payloads; spliced + live frames sharing a `tool_use_id` collapse to one message.
- **Residual risk:** A call persisted with a different id than its live echo would double — not observed; guard via the capture probe.

---

### Design Decisions {#design-decisions}

#### [P01] Splice in tugcode's replay translator, not the deck (DECIDED) {#p01-splice-in-tugcode}

**Decision:** Reconstruct background-agent children entirely by emitting the right replay frames from tugcode; make no changes to deck rendering for the core path.

**Rationale:**
- The deck already links children by `parentToolUseId` and partitions via `childToolCallsByParent`; the Agent block already renders whatever children it is handed (Part A/B).
- Keeping the fix in the frame-producing layer means one code path serves both live and resumed sessions.

**Implications:** Deck work is limited to a verifying fixture-replay test; no reducer or component changes.

#### [P02] Link by `.meta.json` `toolUseId` (DECIDED) {#p02-meta-linkage}

**Decision:** Determine each subagent transcript's parent Agent from its `agent-<id>.meta.json` `toolUseId`, not by parsing the async-launch echo or matching `agentId`.

**Rationale:** The meta records the launching `tool_use.id` directly and unambiguously, including `agentType`/`description`/`spawnDepth`. It is the authoritative linkage.

**Implications:** Discovery pairs each `.jsonl` with its `.meta.json`; a file missing/!parseable meta is skipped (shape-guarded).

#### [P03] `session.ts` owns fs; `replay.ts` stays pure (DECIDED) {#p03-fs-split}

**Decision:** Discovery and reads live in `session.ts`; the discovered transcripts are passed into `translateJsonlSession` via `ReplayInput.ok.subagents`. `replay.ts` remains filesystem-free.

**Rationale:** Mirrors the existing `claudeProjectsRoot`/`jsonlPathFor` split; keeps the translator unit-testable with in-memory fixtures.

**Implications:** `ReplayInput.ok` gains a `subagents?: SubagentTranscript[]` field; the translator threads them without touching disk.

#### [P04] Flat stamping per file; nesting via enumeration (DECIDED) {#p04-flat-stamping}

**Decision:** Stamp every synthesized frame from a subagent file with `parentToolUseId = meta.toolUseId`. Handle nesting by enumerating **all** subagent files and stamping each by its own meta — the nested Agent's `tool_use` (a child of the outer agent) also owns a file whose calls stamp under the nested Agent.

**Rationale:** Every call in one file is a direct child of that file's launching Agent; there is no intra-file nesting to walk. Recursion falls out of enumerating files.

**Implications:** No bespoke depth traversal; `spawnDepth` is informational. Deck `AGENT_MAX_DEPTH` still bounds *rendering* depth.

#### [P05] Synthesize only tool frames from subagent entries (DECIDED) {#p05-tool-frames-only}

**Decision:** From subagent entries, emit only `tool_use`, `tool_result`, and `tool_use_structured` frames (parent-stamped) — never `turn_started` / `turn_complete` / `system_metadata`, which belong to the parent turn.

**Rationale:** The children are content *within* the parent Agent's turn; emitting turn-lifecycle frames from subagent entries would corrupt the parent turn's structure and telemetry.

**Implications:** A dedicated `synthesizeSubagentChildFrames` extractor, not a wholesale reuse of the per-entry turn translator.

#### [P06] Synthesize the Agent's structured result on resume (DECIDED) {#p06-structured-result}

**Decision:** Build a `tool_use_structured` for the Agent `tool_use` from the subagent transcript — `content` (final answer text blocks), `agentType`/`status` (agentType from the `.meta.json`), and `totalToolUseCount` / `totalTokens` / `totalDurationMs` **derived from the subagent entries** (count of `tool_use` blocks; summed assistant `usage`; last-minus-first entry timestamp) — so the header badge, footer stats, and final answer restore.

**Rationale:** On resume the persisted Agent result is the async echo (no content); without synthesis the block shows calls but no answer/stats. The deck's `composeAgentTranscriptData` already consumes exactly this shape. `.meta.json` carries **no** usage/stats (only `agentType`/`description`/`toolUseId`/`spawnDepth`), so the numbers come from the entries, not the meta.

**Implications:** Resolves [Q02] as include-in-v1. **Refinement discovered during #step-5:** the async-launch echo's `tool_use_structured` lands on the main JSONL *after* the parent Agent `tool_use` — i.e. after the splice point — so pure last-write-wins ordering would let the echo clobber the composed result. Instead the splice is **gated to genuinely-async agents** (`collectAsyncAgentToolUseIds` — a `user` entry whose `toolUseResult` is `isAsync`/`async_launched`), and the echo's structured frame is **dropped** in the emit loop for those agents, so the composed result is the **sole writer** of the Agent's `structuredResult` (more robust than ordering, and it means a foreground agent's real inline result is never disturbed). The final-answer `content` is reconstructed from the transcript's trailing assistant text (tool calls excluded — they arrive as parent-linked children); stats (`totalToolUseCount`/`totalTokens`/`totalDurationMs`) derive from the entries.

#### [P07] Idempotent with the live gap-bridge (DECIDED) {#p07-idempotency}

**Decision:** Splice persisted children unconditionally on replay; rely on the reducer's per-`tool_use_id` idempotency to dedupe against any live frames for an agent still running at resume.

**Rationale:** The reducer already keys `tool_use` messages by id and preserves filled payloads; spliced + live frames for the same call collapse.

**Implications:** No special "is it still running?" branch in the splice; correctness rides existing reducer behavior, asserted by test.

#### [P08] Rejected: restore children via `structured_result.content[]` (DECIDED) {#p08-reject-inline-content}

**Decision:** Do **not** reconstruct children by stuffing the subagent's `tool_use` blocks into the synthesized Agent `structured_result.content[]` (the way foreground agents surface their calls); use parent-linked separate frames ([P01]/[P04]) instead.

**Rationale:**
- The deck reaches Agent children two ways: `parentToolUseId`-linked separate `ToolUseMessage`s, **or** inline `tool_use` blocks in `structured_result.content[]` narrowed by `narrowContentEntry`.
- The inline path is tempting (one structured frame, no per-child splice, no window/ordering concern) but `narrowContentEntry` produces **display-only** children with `result: null` — it drops every child's `tool_result` body. The user requires the full sub-tool history *with* expandable output, so the inline path is disqualified.

**Implications:** We pay the splice complexity ([P04], Spec S04) to preserve child results — the correct trade. The inline path stays reserved for genuinely result-less inline content (foreground final answers).

---

### Deep Dives (Optional) {#deep-dives}

#### On-disk layout and linkage {#layout}

For session `1c53fe86-82ea-495f-9616-b200f7240f0e` (project `/Users/kocienda/Mounts/u/src/tugtool`):

```
~/.claude/projects/-Users-kocienda-Mounts-u-src-tugtool/
  1c53fe86-…-f7240f0e.jsonl                      # main session
  1c53fe86-…-f7240f0e/                            # sidecar dir (session-id named)
    subagents/
      agent-aa523090963dd46d9.jsonl               # the agent's full transcript
      agent-aa523090963dd46d9.meta.json           # {agentType, description, toolUseId, spawnDepth}
    tool-results/
      <hash>.txt                                  # offloaded large tool outputs
```

**Main JSONL** (relevant): `assistant` w/ `tool_use` name=`Agent` id=`toolu_01Rvup4w…`; `user` w/ `tool_result` = `{isAsync:true, status:"async_launched", agentId:"aa523090963dd46d9", …}`. No children.

**Subagent JSONL**: `assistant`/`user` entries in the same shape as a main transcript, each carrying `agentId`, `isSidechain:true`, and **no** `parent_tool_use_id`. ~40 `Bash`/`Read` calls in this session.

**meta.json**: `{"agentType":"Explore","description":"Find block renderer dependencies","toolUseId":"toolu_01Rvup4w9HGpYnJ4XHoeV3cK","spawnDepth":1}` — the `toolUseId` is the linkage key ([P02]).

#### Frame flow: live vs. resume {#flow}

- **Live:** claude streams subagent `tool_use`/`tool_result` inline tagged with `parent_tool_use_id`; `session.ts` forwards; reducer links → rendered. Ephemeral.
- **Resume today:** `translateJsonlSession(mainJsonl)` emits Agent `tool_use` + async-echo `tool_result`; no children exist → empty block.
- **Resume (this plan):** `session.ts` discovers subagent transcripts → `ReplayInput.ok.subagents`; the translator, upon emitting an Agent `tool_use` whose id matches a transcript's `meta.toolUseId`, splices `synthesizeSubagentChildFrames(transcript)` (parent-stamped child `tool_use`/`tool_result`) and replaces the async-echo result with a synthesized `tool_use_structured` ([P06]). Deck links + renders unchanged.

---

### Specification {#specification}

**Spec S01: `SubagentTranscript` (tugcode)** {#s01-subagent-transcript}

```
interface SubagentTranscriptMeta {
  agentType: string;        // "Explore"
  description: string;      // header detail
  toolUseId: string;        // parent Agent tool_use.id — the linkage key
  spawnDepth: number;       // informational; 1 = top-level agent
}
interface SubagentTranscript {
  meta: SubagentTranscriptMeta;
  entries: JsonlEntry[];    // parsed subagent JSONL entries (assistant/user)
}
```

**Spec S02: `ReplayInput.ok` extension** {#s02-replay-input}

`ReplayInput.ok` gains `subagents?: SubagentTranscript[]` (default `[]`). Absent/empty ⇒ byte-identical to today's behavior.

**Spec S03: `synthesizeSubagentChildFrames(transcript)`** {#s03-synthesize}

Pure. Extracts `tool_use` and `tool_result` blocks from `transcript.entries` and returns ordered `OutboundMessage[]` of `tool_use` / `tool_result` / `tool_use_structured`, where each **`tool_use`** carries `parentToolUseId = transcript.meta.toolUseId` (linkage rides the `tool_use` frame; the reducer keeps it sticky and merges `tool_result`/`tool_use_structured` by id, so those need no parent field). Emits **no** turn-lifecycle frames ([P05]). Also returns the composed Agent-level `tool_use_structured` payload for [P06] (final answer + stats), keyed to the parent Agent `tool_use`.

**Spec S04: Splice semantics in `translateJsonlSession`** {#s04-splice}

**The splice is mid-turn.** When the translator emits a `tool_use` whose id equals some transcript's `meta.toolUseId`, it yields that transcript's child frames **immediately after, while the Agent's turn scratch is still open** (before that turn's `turn_complete`) — otherwise the reducer can't resolve the child frames' `turnKey` and silently drops them. The synthesized Agent `tool_use_structured` ([P06]) is yielded **after** the async-echo entry has emitted its own `tool_use_structured`; because `handleToolStructured` is unconditional last-write-wins (`structuredResult: event.structured_result ?? null`, no clobber guard — verified in `reducer.ts`), the later synthesized payload simply wins. No suppression of the async echo is needed. Splice runs downstream of the per-entry emit decision, so a windowed-out Agent yields no children ([Q03]). Nesting: because a nested Agent's own child `tool_use` is itself spliced, its transcript matches on the next pass; enumerate all transcripts until none match ([P04]).

**Error/Warning Model:** A subagent file with missing/unparseable `.meta.json`, a malformed line, or a `toolUseId` that matches no emitted `tool_use` is **skipped** with a single `dev::replay::subagent_skip` warn — replay never crashes and never blocks on subagent data.

#### State Zone Mapping (tugdeck/tugways) {#state-zone-mapping}

No new deck state. The spliced child `tool_use` messages enter the store through the **existing** reducer path (external frames → store → `useSyncExternalStore`), identical to live children.

| State | Zone | Mechanism | Law |
|-------|------|-----------|-----|
| Restored child `ToolUseMessage`s (parent-linked) | structure (external → store) | existing reducer + `useSyncExternalStore` | [L02] |

---

### Definitive Symbol Inventory {#symbol-inventory}

#### New files {#new-files}

| File | Purpose |
|------|---------|
| `tugcode/src/__tests__/fixtures/subagent-resume/` | Real captured main JSONL (trimmed) + `agent-*.jsonl` + `.meta.json`, driven through the translator |
| `tugcode/src/__tests__/subagent-resume.test.ts` | Unit tests: discovery, synthesis, splice, structured-result, nesting, idempotency |

#### Symbols to add / modify {#symbols}

| Symbol | Kind | Location | Notes |
|--------|------|----------|-------|
| `SubagentTranscript`, `SubagentTranscriptMeta` | interface | `tugcode/src/replay.ts` (or `types.ts`) | Spec S01 |
| `subagentsDirFor(root, projectDir, sessionId)` | fn | `tugcode/src/session.ts` | Resolve `<…>/<sessionId>/subagents` |
| `readSubagentTranscripts(dir, fs?)` | fn | `tugcode/src/session.ts` | Discover + parse `agent-*.{jsonl,meta.json}`; shape-guarded; optional `tool-results` resolve ([Q01]) |
| `ReplayInput.ok.subagents` | field | `tugcode/src/replay.ts` | Spec S02 |
| `synthesizeSubagentChildFrames` | fn | `tugcode/src/replay.ts` | Spec S03 / [P05] |
| `composeAgentStructuredResult` | fn | `tugcode/src/replay.ts` | [P06] final answer + stats |
| `translateJsonlSession` (splice) | fn | `tugcode/src/replay.ts` | Spec S04 |
| resume orchestration (thread `subagents`) | edit | `tugcode/src/session.ts` (`runReplay` call site) | Discover + pass into `ReplayInput` |
| `test-45-bg-agent-resume` | probe | `tugrust/crates/tugcast/tests/common/probes.rs` + catalog | Recurring capture lock |

---

### Test Plan Concepts {#test-plan-concepts}

#### Test Categories {#test-categories}

| Category | Purpose | When to use |
|----------|---------|-------------|
| **Unit (real fixture)** | Discovery, synthesis, splice, structured-result, nesting, idempotency through the real translator on real captured content | tugcode core |
| **Integration** | `session.ts` resume orchestration discovers + threads subagents end-to-end | tugcode resume path |
| **Deck fixture-replay** | Replaying the fixture, the Agent block renders children + final answer | deck |
| **Golden / Capture** | Recurring probe: launch → complete → resume restores children | catalog drift lock |

#### What stays out of tests {#test-non-goals}

- No mock-store or fake-DOM render tests — the deck assertion drives the real reducer/store from real frames.
- No synthetic-only subagent JSONL — fixtures are the *actual* captured files (trimmed for size), per real-not-fake.
- `Monitor` validation error is not tested here — out of scope ([#non-goals]).

---

### Execution Steps {#execution-steps}

> Commit after all checkpoints pass. tugcode is a compiled binary — the final step rebuilds it and verifies live.

#### Step Status Ledger {#step-status-ledger}

| Step | Title | Status | Commit |
|---|---|---|---|
| #step-1 | Real fixtures + `tool-results` spike ([Q01]) | done | (dash) |
| #step-2 | `SubagentTranscript` + `readSubagentTranscripts` (fs) | done | (dash) |
| #step-3 | `synthesizeSubagentChildFrames` (pure) | done | (dash) |
| #step-4 | Splice into `translateJsonlSession` (window/nesting-aware) | done | (dash) |
| #step-5 | Synthesize Agent `tool_use_structured` ([P06]) | done | (dash) |
| #step-6 | Wire `session.ts` resume orchestration | done | (dash) |
| #step-7 | Idempotency + still-running-at-resume | done | (dash) |
| #step-8 | Deck fixture-replay assertion | done | (dash) |
| #step-9 | Recurring capture probe + catalog + drift | done | (dash) |
| #step-10 | Integration checkpoint | done | (verification only) |
| #step-11 | Rebuild binary + app-test + live verify | build+launch done; live verify pending user | (dash) |

#### Step 1: Real fixtures + `tool-results` spike {#step-1}

**Commit:** `test(tugcode): capture real background-agent subagent fixture for resume`

**References:** [P02] meta linkage, [Q01] offloaded results, Spec S01, (#layout)

**Artifacts:**
- `tugcode/src/__tests__/fixtures/subagent-resume/` — trimmed real main JSONL + `agent-<id>.jsonl` + `.meta.json` (copied from the live `1c53fe86…` session), and, if [Q01] finds pointers, a sample `tool-results/<hash>.txt`.

**Tasks:**
- [ ] Copy the real subagent `.jsonl` + `.meta.json` and a trimmed main JSONL into the fixture dir.
- [ ] Spike [Q01]: dump a large subagent `tool_result` block; determine inline vs. `tool-results/` pointer; record the finding in the plan/`[Q01]` resolution.

**Tests:**
- [ ] (data only — consumed by later steps)

**Checkpoint:**
- [ ] Fixture files present; [Q01] resolved with a one-line note (inline vs. pointer).

#### Step 2: `SubagentTranscript` + `readSubagentTranscripts` {#step-2}

**Depends on:** #step-1

**Commit:** `feat(tugcode): read subagents/agent-*.jsonl transcripts for resume`

**References:** [P02] meta linkage, [P03] fs split, [Q01], Spec S01, (#symbols)

**Artifacts:**
- `subagentsDirFor` + `readSubagentTranscripts` in `session.ts`; `SubagentTranscript`/`SubagentTranscriptMeta` types.

**Tasks:**
- [ ] Resolve `<sessionDir>/subagents`; `readdir` for `agent-*.jsonl` + paired `.meta.json`.
- [ ] Parse + shape-guard meta (`toolUseId` required); parse entries; skip-with-warn on malformed.
- [ ] If [Q01] found pointers, resolve `tool-results/<hash>.txt` bodies (size-capped).

**Tests:**
- [ ] `readSubagentTranscripts` on the real fixture returns one transcript with `meta.toolUseId === "toolu_01Rvup4w…"` and the expected entry count.
- [ ] Missing `subagents/` dir → `[]` (no throw). Malformed meta → skipped + warn.

**Checkpoint:**
- [ ] `cd tugcode && bun test subagent-resume` (green).

#### Step 3: `synthesizeSubagentChildFrames` (pure) {#step-3}

**Depends on:** #step-2

**Commit:** `feat(tugcode): synthesize parent-linked child frames from subagent transcript`

**References:** [P04] flat stamping, [P05] tool-frames-only, Spec S03, (#flow)

**Artifacts:**
- `synthesizeSubagentChildFrames(transcript)` in `replay.ts`.

**Tasks:**
- [ ] Extract `tool_use` / `tool_result` blocks from entries; emit `tool_use` / `tool_result` / `tool_use_structured` with `parentToolUseId = meta.toolUseId`.
- [ ] Emit **no** turn-lifecycle frames.

**Tests:**
- [ ] Real fixture → child `tool_use` frames all carry `parentToolUseId === meta.toolUseId`; count matches the transcript; no `turn_started`/`turn_complete` emitted.

**Checkpoint:**
- [ ] `cd tugcode && bun test` (green).

#### Step 4: Splice into `translateJsonlSession` {#step-4}

**Depends on:** #step-3

**Commit:** `feat(tugcode): splice subagent children into JSONL replay stream`

**References:** [P01] splice-in-tugcode, [P04] nesting, [Q03] window, Spec S02, Spec S04, (#flow)

**Artifacts:**
- `ReplayInput.ok.subagents`; splice logic in `translateJsonlSession`.

**Tasks:**
- [ ] Thread `subagents` through the OK branch; index by `meta.toolUseId`.
- [ ] On emitting a `tool_use` matching a transcript, yield its child frames **mid-turn** (before the Agent turn's `turn_complete`, Spec S04).
- [ ] Enumerate across passes so a nested Agent's transcript splices under its (spliced) parent ([P04]).
- [ ] Splice only downstream of the per-entry emit (window-safe, [Q03]).

**Tests:**
- [ ] Full replay of the fixture emits the Agent `tool_use` followed by its parent-linked children.
- [ ] `subagents: []` → frame stream byte-identical to pre-change.
- [ ] **Nesting** — if #step-1 captured a real two-level fixture, assert inner children link under the inner Agent id. Otherwise this test is **deferred** (not synthesized): the enumeration linkage ([P04]) is designed-in and covered once a real nested capture exists; record the deferral in the ledger, do not hand-craft a nested fixture (real-not-fake).

**Checkpoint:**
- [ ] `cd tugcode && bun test` (green, incl. existing replay tests).

#### Step 5: Synthesize the Agent `tool_use_structured` {#step-5}

**Depends on:** #step-4

**Commit:** `feat(tugcode): restore agent final answer + stats on resume`

**References:** [P06] structured-result, [Q02], Spec S03, (#flow)

**Artifacts:**
- `composeAgentStructuredResult`; replace the async-echo `tool_result` for the Agent with the synthesized structured result during splice.

**Tasks:**
- [ ] Compose `content` (final answer text), `agentType`/`status`, `totalToolUseCount`/`totalTokens`/`totalDurationMs` from meta + entry usage.
- [ ] Suppress/replace the async-echo result for that Agent.

**Tests:**
- [ ] Replayed Agent carries a `tool_use_structured` with non-empty `content` and a tool-use count matching the transcript.

**Checkpoint:**
- [ ] `cd tugcode && bun test` (green).

#### Step 6: Wire `session.ts` resume orchestration {#step-6}

**Depends on:** #step-4, #step-5

**Commit:** `feat(tugcode): discover + thread subagent transcripts into replay`

**References:** [P03] fs split, Spec S02, (#symbols)

**Artifacts:**
- Resume path discovers subagents and populates `ReplayInput.ok.subagents` before `translateJsonlSession`.

**Tasks:**
- [ ] At the `runReplay` build of `ReplayInput`, resolve the subagents dir + call `readSubagentTranscripts`; attach.
- [ ] Budget-guard: telemetry for count/bytes; bounded reads.

**Tests:**
- [ ] Integration: given the fixture on a tmp `claudeProjectsRoot`, the resume path yields child frames end-to-end.

**Checkpoint:**
- [ ] `cd tugcode && bun test` (green).

#### Step 7: Idempotency + still-running-at-resume {#step-7}

**Depends on:** #step-6

**Commit:** `test(tugcode): dedupe spliced + live children for running agent`

**References:** [P07] idempotency, Risk R02, (#r02-dupe)

**Tasks:**
- [ ] Drive a replay-then-live sequence sharing `tool_use_id`s; assert no duplication survives the reducer's idempotency (deck-side or a tugcode-frame-level assertion of stable ids).

**Tests:**
- [ ] Spliced child + a live echo of the same `tool_use_id` collapse to one message.

**Checkpoint:**
- [ ] `cd tugcode && bun test` (green).

#### Step 8: Deck fixture-replay assertion {#step-8}

**Depends on:** #step-6

**Commit:** `test(tugdeck): agent block restores children from replayed subagent`

**References:** [P01] splice-in-tugcode, [L02], (#state-zone-mapping)

**Tasks:**
- [ ] In a deck fixture-replay test, feed the spliced frame stream through the real reducer; assert `childToolCallsByParent[agentToolUseId]` is populated and the Agent block composes them (+ final answer from the structured result).

**Tests:**
- [ ] Reducer links children; `composeAgentTranscriptData` yields entries + final text.

**Checkpoint:**
- [ ] `cd tugdeck && bun test` (green); `bunx vite build` clean.

#### Step 9: Recurring capture probe + catalog + drift {#step-9}

**Depends on:** #step-6

**Commit:** `test(capture): add test-45-bg-agent-resume recurring probe`

**References:** Spec S04, Milestone M01, (#success-criteria)

> **Non-gating.** "Launch bg agent → await completion → resume" is inherently nondeterministic in duration and content (precedent: `test-43-schedulewakeup-wake` was skipped for this class of flakiness). The **deterministic** gating coverage is the real-fixture unit tests (#step-3, #step-4, #step-5) and the deck fixture-replay (#step-8). This probe is **on-demand, best-effort**, with a **purely structural** assertion — never content-exact — and does not gate phase close. If it proves flaky, mark it skipped with a documented reason rather than weakening the fixture tests.

**Tasks:**
- [ ] Add `test-45-bg-agent-resume` to `probes.rs` (launch bg agent → await completion → resume). Update the probe-count guard + catalog.
- [ ] Confirm the drift classifier tolerates subagent nondeterminism (reuse the `TOOL_ACTIVITY_MARKER` collapse if needed).

**Tests:**
- [ ] Probe (on-demand real-claude) asserts **structurally** that ≥1 child with `parentToolUseId` set is restored under the Agent post-resume — count > 0, never exact content/count.

**Checkpoint:**
- [ ] `cd tugrust && cargo nextest run` (probe table + drift green); if the probe is skipped for nondeterminism, the skip carries a documented reason and the drift/count guards still pass.

#### Step 10: Integration Checkpoint {#step-10}

**Depends on:** #step-6, #step-7, #step-8, #step-9

**Commit:** `N/A (verification only)`

**References:** (#success-criteria, #exit-criteria)

**Tasks:**
- [ ] Verify Steps 2–9 compose: discovery → synthesis → splice → structured-result → deck render, on the real fixture.

**Tests:**
- [ ] `cd tugcode && bun test` + `cd tugdeck && bun test` + `cd tugrust && cargo nextest run` all green.

**Checkpoint:**
- [ ] All three suites green; `bunx vite build` clean.

#### Step 11: Rebuild binary + app-test + live verify {#step-11}

**Depends on:** #step-10

**Commit:** `chore(tugcode): rebuild binary for subagent-resume`

**References:** (#success-criteria), Constraints (#constraints)

**Tasks:**
- [ ] `bun build --compile tugcode/src/main.ts --outfile tugrust/target/debug/tugcode`.
- [ ] `just app-test`.
- [ ] Live: resume session `1c53fe86-…` (Maker ▸ Reload) → Agent block renders all children + final answer.

**Tests:**
- [ ] app-test green.

**Checkpoint:**
- [ ] Live Maker ▸ Reload restores the full Agent transcript (no empty block).

---

### Deliverables and Checkpoints {#deliverables}

**Deliverable:** Resuming a Dev session restores each background agent's full child-tool-call history and final answer into its Agent block, reconstructed from the out-of-band `subagents/` transcripts.

#### Phase Exit Criteria ("Done means…") {#exit-criteria}

- [ ] Maker ▸ Reload of a completed-background-agent session renders all children (verified live on `1c53fe86-…`).
- [ ] Final answer + duration/token footer restore.
- [ ] Nested (spawnDepth ≥ 2) agents link correctly.
- [ ] No-subagent sessions replay byte-identically (existing tests green).
- [ ] tugcode + tugdeck + rust suites green; binary rebuilt; app-test green.

**Acceptance tests (gating):**
- [ ] `subagent-resume.test.ts` (unit, real fixture) green.
- [ ] Deck fixture-replay assertion green.

**Non-gating (on-demand):**
- [ ] `test-45-bg-agent-resume` probe runs and structurally confirms restored children (or is skipped with a documented reason — see #step-9).

#### Roadmap / Follow-ons (Explicitly Not Required for Phase Close) {#roadmap}

- [ ] Live progress for a still-running agent surfaced from the persisted transcript during the resume gap (beyond `task_progress`).
- [ ] Restore of foreground-subagent transcripts if a future Claude Code version offloads them too.

**Milestone M01: Background-agent transcripts survive resume** {#m01-resume-restore}

| Checkpoint | Verification |
|------------|--------------|
| Children restored on resume | Live Maker ▸ Reload on `1c53fe86-…` |
| Real-content unit coverage | `cd tugcode && bun test` |
| Drift-locked end-to-end | `test-45-bg-agent-resume` |
