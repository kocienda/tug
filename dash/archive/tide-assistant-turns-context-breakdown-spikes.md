# Step 20.4.7.D — Spike findings (companion to tide-assistant-turns.md)

This document carries the findings for the six spikes (S1–S6) that gate [Step 20.4.7.D](tide-assistant-turns.md#step-20-4-7-d) — the cross-crate `/context`-style breakdown work. It is a companion to `tide-assistant-turns.md`; the parent step references each section here from its spike checklist.

**Headline outcome.** S2's verdict re-shapes the step: `/context` is not programmatically accessible through the Claude Agent SDK. There is no slash-command execution surface; the "send `/context` as a user message and scrape the synthetic assistant response" path is rejected for transcript-pollution reasons. **Local tokenization is therefore load-bearing, not optional**, and the rest of the spikes (S3 tokenizer choice, S4 update cadence, S5 settings access, S6 persistence shape) follow from that constraint.

---

## S1 — SDK surface inventory

**Plan reference:** [#step-20-4-7-d](tide-assistant-turns.md#step-20-4-7-d) Spike S1.
**SDK version inspected:** `@anthropic-ai/claude-agent-sdk@0.2.42` (bundled `claudeCodeVersion: 2.1.42`).
**Scope:** every context-relevant surface the SDK exposes, MCP excluded by design.

### Question

Which SDK properties / methods / messages expose the data tugcode needs to build a `/context`-style per-category token breakdown? For each surface: what does it carry, is it read-once-at-init or queryable-per-turn, and is the *content* (tokenizable bytes) available or only an *identifier* (name)?

### Findings

#### The init message — `SDKSystemMessage { subtype: 'init' }`

Emitted once by the CLI when the SDK session comes up. Carries:

| Field | Shape | What it carries | Useful for tokenization? |
|---|---|---|---|
| `claude_code_version` | `string` | CLI version | No — metadata only |
| `model` | `string` | Selected model id | No directly — but lets us look up `contextWindow` |
| `cwd` | `string` | Working dir | No |
| `permissionMode` | `PermissionMode` | Permission policy | No |
| `apiKeySource` | `ApiKeySource` | Auth origin | No |
| `tools` | `string[]` | **Names** of enabled tools | Names only — schemas are not in the message |
| `agents` | `string[] \| undefined` | **Names** of custom agents | Names only — prompts are not in the message |
| `skills` | `string[]` | **Names** of available skills | Names only — manifests are not in the message |
| `slash_commands` | `string[]` | Names of slash commands | Names only |
| `plugins` | `{ name, path }[]` | Plugin name + on-disk path | Path lets us read content from disk |
| `mcp_servers` | `{ name, status }[]` | Per-server status | **Skipped** per "Out of scope: MCP" |
| `betas` | `string[]?` | Active betas | No |
| `output_style` | `string` | Output formatting | No |

Tugcode already projects most of these onto its own `SystemMetadata` IPC (see `tugcode/src/types.ts` `SystemMetadata` and `tugcode/src/session.ts:495–528` for the projection). It does NOT today read tool schemas, agent prompts, or skill manifests — only names propagate.

#### Per-turn result — `SDKResultMessage` (success + error)

Emitted at the end of each turn. Carries `usage: NonNullableUsage` (`BetaUsage` non-null) and `modelUsage: Record<string, ModelUsage>`. `ModelUsage` per model:

```typescript
{
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
  contextWindow: number;        // per-model context cap — useful
  maxOutputTokens: number;
}
```

Tugcode projects this as `cost_update` (`tugcode/src/session.ts:748`). The popover's 20.4.7.C view already reads it. The `inputTokens` figure here is wire-accurate Claude truth and is the load-bearing calibration signal for S3.

#### Per-turn methods on `Query`

The Query interface (`sdk.d.ts:996`) has these query / introspection methods:

| Method | Returns | Useful for context breakdown? |
|---|---|---|
| `initializationResult()` | `{ commands, output_style, available_output_styles, models, account }` | Same data as the init message, callable after the fact. No category content. |
| `supportedCommands()` | `SlashCommand[]` (name + description + argumentHint) | Enumerate only. No invocation surface — see S2. |
| `supportedModels()` | `ModelInfo[]` with `contextWindow: number` | **Useful** — gives us the per-model context cap independent of selected model. |
| `accountInfo()` | `AccountInfo` | No |
| `mcpServerStatus()` | `McpServerStatus[]` | Skipped — MCP excluded |
| `interrupt()`, `setModel()`, `setPermissionMode()`, etc. | mutation | N/A |

#### Compaction signals

`SDKCompactBoundaryMessage` (`sdk.d.ts:1216`):

```typescript
{
  type: 'system',
  subtype: 'compact_boundary',
  compact_metadata: { trigger: 'manual' | 'auto', pre_tokens: number },
  uuid, session_id
}
```

Plus `SDKStatus = 'compacting' | null` and a `PreCompactHookInput` hook. Tugcode already projects `compact_boundary` (`tugcode/src/types.ts:307`).

`pre_tokens` is the input-token count immediately before compaction. We can use this to (a) reset our running Messages token counter at compaction time and (b) calibrate our local tokenizer against Claude's truth opportunistically.

#### What the SDK does NOT expose

These are the structural gaps that shape the cross-crate implementation choices:

1. **No actual system-prompt content.** The CLI builds its own system prompt internally; the SDK only lets us supply an extra `systemPrompt` / `appendSystemPrompt` on `query()` options. Tugcode currently passes neither — meaning the system-prompt bytes the model sees are entirely internal to Claude Code and not addressable from the SDK.
2. **No tool schema payloads.** `init.tools` is `string[]` (names). Tool JSON-schemas live inside the CLI binary; the SDK does not surface them.
3. **No agent / skill / plugin content.** Names + (for plugins) paths only. Tugcode can read the on-disk content for any of these by walking `~/.claude/agents/`, `~/.claude/skills/`, and plugin paths, but the SDK does not hand the content to us pre-resolved.
4. **No memory-file enumeration.** Memory files (`CLAUDE.md`, project `CLAUDE.md`, `~/.claude/projects/<encoded-cwd>/memory/MEMORY.md` + linked files) are loaded by the CLI itself. Tugcode would need to mirror the CLI's discovery rules.
5. **No slash-command execution.** See S2.
6. **No per-category token breakdown event.** The thing we want does not exist on the wire. Either we synthesize it ourselves (current plan) or we wait for [anthropics/claude-agent-sdk-typescript#66](https://github.com/anthropics/claude-agent-sdk-typescript/issues/66) / [#507 on the python sibling](https://github.com/anthropics/claude-agent-sdk-python/issues/507) to ship.

### Decision

**Path B from the plan's "architectural decisions" — re-tokenize each component locally from SDK-exposed state plus disk reads tugcode performs itself.** Path A (slash-command scrape) is non-viable per S2; Path C (wait for upstream) is indefinite.

Implementation implication for tugcode:
- For category content, tugcode reads from disk the same files the CLI reads: `~/.claude/CLAUDE.md`, project `CLAUDE.md` in `cwd`, the project's MEMORY.md if present, `~/.claude/agents/*.md` (for agent names that appeared in init), `~/.claude/skills/<name>/SKILL.md`, plugin `agents/` and `skills/` subdirs.
- For the system-prompt bytes, **use a stable approximation** — tugcode does not have access to the actual CLI-internal prompt. Either (a) hardcode a "system prompt" token estimate calibrated against `usage.input_tokens` of the first turn (the calibration trick from S3 absorbs this), or (b) attribute all CLI-internal bytes to a single `system_prompt` bucket and accept that the exact split between "system prompt" and "system tools" is an estimate.
- The `contextWindow` cap comes from `modelUsage[model].contextWindow` after the first turn, or from `supportedModels()` at init.

### Follow-ups for the implementation tasks

- Tugcode needs a small "static-categories tokenizer" pass that runs at session_init and walks `~/.claude/CLAUDE.md`, `cwd/CLAUDE.md`, `~/.claude/skills/{names from init}/SKILL.md`, `~/.claude/agents/{names from init}.md`, plugin paths. Cache the per-file token counts keyed by `(path, mtime)` so re-runs (HMR, reload, resume) are free.
- Bundle the tool-schema token counts as a static table indexed by tool name + Claude Code version. The set of built-in tools is small (~15) and changes only with CLI upgrades. The static table is the simplest path to per-tool token counts without bundling the tool schemas in tugcode.
- The wire frame's `categories[].id` enum (`system_prompt | system_tools | custom_agents | memory_files | skills | messages | autocompact_buffer`) maps directly onto these disk-read groupings; `messages` is the only category that updates per turn and is sourced from `cost_update.usage.input_tokens` minus the static-category sum.

---

## S2 — Slash-command access from the Claude Agent SDK

**Plan reference:** [#step-20-4-7-d](tide-assistant-turns.md#step-20-4-7-d) Spike S2.
**SDK version inspected:** `@anthropic-ai/claude-agent-sdk@0.2.42`.

### Question

Can the SDK execute `/context` (or any slash command) programmatically and capture its structured response? If yes, what's the surface and the response shape?

### Findings

#### Surfaces present in the SDK

| Surface | What it does | Executes a slash command? |
|---|---|---|
| `Query.supportedCommands()` (`sdk.d.ts:1050`) | Returns `SlashCommand[]` — `{ name, description, argumentHint }` | No — enumerate only |
| `Query.initializationResult()` (`sdk.d.ts:1044`) | Returns `{ commands, output_style, available_output_styles, models, account }` | No — same enumerate-only `commands` array |
| `SDKSystemMessage { subtype: 'init' }.slash_commands` | `string[]` (names) | No |
| `SDKControlRequestInner` union (`sdk.d.ts:1332`) | All control-request subtypes: `interrupt`, `can_use_tool`, `initialize`, `set_permission_mode`, `set_model`, `set_max_thinking_tokens`, `mcp_*`, `hook_callback`, `rewind_files`, `stop_task` | **No `execute_slash_command` subtype** |
| Sending `prompt: "/context"` via `query()` | Sends as a user message to the LLM | **Not the same thing** — the model would receive `/context` as text, not Claude Code's local handler |

#### What I checked and what I did not find

- No `Query.invokeCommand(name, args)` method, no `Query.runSlashCommand`, no equivalent.
- No control-request subtype that names a slash command to invoke.
- No SDK message type that carries a structured slash-command response. (No `SDKSlashCommandResultMessage` or similar.)
- The `SDKSystemMessage { subtype: 'init' }.slash_commands` array is `string[]` — not `{ name, handler }`. Confirms commands are CLI-side, not addressable.

#### The "synthetic assistant message" near-miss

In `tugcode/src/session.ts:554–587` the code handles built-in slash commands like `/cost` and `/compact` by detecting `message.model === "<synthetic>"` and emitting their assistant-text content directly. This means **some** slash commands surface their output through the message stream as synthetic assistant text. If `/context` did the same, sending it as a user-message would produce a parseable synthetic response.

But:
1. We have no way to confirm `/context` produces a synthetic message without running it end-to-end against a live Claude Code instance — and even then the output is human-formatted terminal text (table with ANSI colors), not structured JSON. Parsing it would be brittle to formatting changes.
2. Sending `/context` as a user-message would pollute the session transcript with a `/context` user turn the user did not type. This is observable: it would show up in `--continue`, `--resume`, and the JSONL replay. Unacceptable.
3. Even if we could fire-and-forget invisibly, the output is a terminal-shaped table; we would be scraping a UI surface rather than reading a data surface.

### Decision

**Slash-command execution is not viable as a data path.** `/context` cannot be programmatically invoked through the SDK with a structured response. Even the "send as user message" scrape path is rejected for transcript-pollution and parser-brittleness reasons.

This makes **local tokenization (Path B from architectural decision 1)** the only viable approach. See S3 for the tokenizer choice and the per-session calibration trick that pins our totals to Claude's observed `usage.input_tokens` truth.

### Follow-ups

- Watch [anthropics/claude-agent-sdk-typescript#66](https://github.com/anthropics/claude-agent-sdk-typescript/issues/66) and [claude-agent-sdk-python#507](https://github.com/anthropics/claude-agent-sdk-python/issues/507). If either ships a structured `/context` accessor, this step can swap implementations behind the existing wire frame without changing the renderer.
- If a future SDK adds a `Query.runSlashCommand()` that returns structured JSON, the `categories[]` projection becomes a direct map rather than a tokenized reconstruction, and the calibration trick from S3 becomes optional rather than load-bearing.

---

## S3 — Tokenization strategy

**Plan reference:** [#step-20-4-7-d](tide-assistant-turns.md#step-20-4-7-d) Spike S3.
**Accuracy bar:** within 5–10% of `/context` per-category totals — see the plan's "Accuracy bar" section.

### Question

Which tokenizer gets us inside the 5–10% accuracy bar at the lowest implementation + runtime cost? The plan prefers (b) a local approximation over (a) Anthropic's `count_tokens` API; this spike picks the specific tokenizer and lands the design that keeps drift inside the bar.

### Candidates

| Option | Local? | Accuracy for Claude 4.x | Cost | Verdict |
|---|---|---|---|---|
| (a) Anthropic `count_tokens` HTTP API | No | Exact | ~460-token preamble per call, network latency | Reject — over-precise for our bar, expensive at our cadence |
| (b1) `@anthropic-ai/tokenizer` npm package | Yes | "Rough approximation" per Anthropic (last accurate for Claude 2) | Free, sync, BPE-based | **Choose** — with the calibration trick below |
| (b2) `tiktoken` / `gpt-tokenizer` (OpenAI tokenizers) | Yes | ~10–30% drift on Claude | Free, sync | Reject — OpenAI BPE; wrong vocab |
| (b3) Character heuristic (`len/3.5`) | Yes | 20–40% drift on code-heavy content | Free, trivial | Reject — outside the bar |
| (b4) `@tokenlens/tokenizer` or other third-party Claude-aware packages | Yes | Varies | Free | Worth tracking but unproven; not the first cut |

### Findings on `@anthropic-ai/tokenizer`

- Published as `@anthropic-ai/tokenizer` on npm by Anthropic.
- Anthropic's own docs state: *"This package can be used to count tokens for Anthropic's older models. As of the Claude 3 models, this algorithm is no longer accurate, but can be used as a very rough approximation."* ([Token counting docs](https://docs.anthropic.com/en/docs/build-with-claude/token-counting))
- The package itself is small, runs offline, and exposes `countTokens(text: string): number`.
- "Very rough" is unquantified. Without an empirical benchmark, we have to assume worst-case 15–25% drift on certain inputs (the bias is likely toward over-estimating tokens on dense code, since the Claude 2 vocab merges fewer code-style ngrams than current models).

### The calibration trick — why "very rough" still fits the 5–10% bar

The popover's display total is the sum of all per-category token counts. We have two anchors:

1. **Local tokenization gives per-category proportions** — relative sizes are stable across tokenizer choice because tokenizer drift is largely *content-shape-uniform* (a tokenizer that over-counts code by 18% over-counts every code-heavy category by roughly the same percentage).
2. **`cost_update.usage.input_tokens` gives Claude's exact total** — wire-accurate, comes for free with every turn we already track.

Strategy: tokenize per-category locally, then **scale every category by a per-session calibration ratio** computed from observed truth.

#### Calibration algorithm

```
At session_init:
  static_total_estimate = tokenize(system_prompt)
                        + sum(tokenize(t) for t in tools)
                        + sum(tokenize(a) for a in custom_agents)
                        + sum(tokenize(m) for m in memory_files)
                        + sum(tokenize(s) for s in skills)
  // Emit a provisional context_breakdown with raw estimates;
  // calibration_ratio = 1.0 until first turn lands.

After first turn_complete:
  observed = cost_update.usage.input_tokens   // Claude's truth for turn 1's input
  estimated = static_total_estimate + tokenize(first_user_message)
  calibration_ratio = observed / estimated     // typically 0.85–1.15
  // Re-emit context_breakdown with categories[].tokens scaled by ratio.

After every subsequent turn_complete:
  // messages_tokens is observed directly:
  messages_tokens = cost_update.usage.input_tokens
                  - static_total_estimate * calibration_ratio
  // Static categories stay at their calibrated values.
  // Emit context_breakdown with updated messages tokens.
```

This pins our display **total** to Claude's truth (within 1 token of `input_tokens`) while letting our per-category proportions drift on the local tokenizer. Per-category drift stays well inside the 5–10% bar because:

- Bulk drift is absorbed by `calibration_ratio`.
- Residual per-category drift depends only on *between-category* tokenizer non-uniformity — which is small (BPE drift biases are mostly content-shape-uniform, and our categories all contain natural-language + code mixtures of similar shape).
- Memory files re-tokenized per turn (on mtime change) use the same ratio.

#### When calibration would fail

- Sessions with zero user-message text in turn 1 (e.g., resume scenarios where the first observed turn is mid-conversation). Mitigation: skip calibration until the first turn whose `cost_update` arrives in a fresh session; carry forward the prior session's ratio if available; fall back to `ratio = 1.0` for resumes (the displayed total is still pinned to observed `input_tokens` — only the per-category split drifts).
- Per-turn cache-read bias: `usage.input_tokens` in the SDK is the non-cached input; cached reads are `cache_read_input_tokens` separately. The breakdown is interested in *content size*, not *billing size*. We use the sum `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` as the calibration anchor, which more closely matches "what's in the context window."
- Compaction. After `compact_boundary`, the static categories don't change but `messages_tokens` resets to a value Claude internally chose. The first post-compact `cost_update` gives us that value via `usage.input_tokens` minus the calibrated static sum. No special handling beyond the normal post-turn re-emit.

### Decision

**`@anthropic-ai/tokenizer` + per-session calibration ratio.**

Dependency to add to `tugcode/package.json`:
```json
"dependencies": {
  "@anthropic-ai/tokenizer": "^0.0.4"  // pin to current; recheck on cli upgrades
}
```

Implementation surface:
- New `tugcode/src/context-breakdown.ts` module that owns the static-categories tokenization (cached by `path:mtime`), the calibration ratio (per-session state), and the per-turn frame emission.
- Hooked into `session.ts` at session_init (initial emit) and at `cost_update` (recompute + emit).
- Hooked into `compact_boundary` (re-emit with reset messages count).

### Follow-ups

- Benchmark `@anthropic-ai/tokenizer` against `count_tokens` on a representative session (one shipping commit's worth of conversation) and record the actual drift in this section as evidence that calibration keeps us inside the 5–10% bar in practice. This is gallery-vettable: emit the raw + calibrated counts side-by-side in a dev-only debug mode.
- If `@tokenlens/tokenizer` (or any other claude-vocab tokenizer) ships a real Claude 4 BPE, swap behind the same module boundary without touching the wire frame or renderer.

### Drift benchmark appendix — measured 2026-05-18

Empirical validation per #step-20-4-7-d-0. Harness: `tugcode/scripts/benchmark-context-tokenizer.ts`. Ground truth: Anthropic `count_tokens` API against `claude-sonnet-4-5`. Samples: project `CLAUDE.md`, four tugplug agent definitions concatenated, two tugplug skill manifests concatenated, the user's `MEMORY.md` index, five memory entry files concatenated, plus three message-shaped samples (short user prompt, long code file, long natural-language excerpt).

Raw drift (local tokenizer vs. API), before any calibration:

| Category | Bytes | Local | API | Raw drift |
|---|---|---|---|---|
| `system_prompt_proxy` (project CLAUDE.md) | 2,746 | 751 | 755 | −0.53% |
| `custom_agents` (4 files) | 54,040 | 14,046 | 14,619 | −3.92% |
| `skills` (2 files) | 38,867 | 10,099 | 10,694 | −5.56% |
| `memory_files` (MEMORY.md) | 3,784 | 1,045 | 1,090 | −4.13% |
| `memory_files_entries` (5 files) | 3,573 | 1,000 | 1,040 | −3.85% |
| `messages_short` ("Run the tests…") | 37 | 9 | 16 | −43.75% |
| `messages_code` (TypeScript types.ts) | 13,644 | 3,747 | 4,272 | −12.29% |
| `messages_natural` (CLAUDE.md head) | 2,746 | 751 | 755 | −0.53% |

Static-category drift after calibration (anchor = `system_prompt_proxy`, `calibration_ratio = 1.0053`):

| Category | Local | Calibrated | API | Residual drift |
|---|---|---|---|---|
| `custom_agents` | 14,046 | 14,121 | 14,619 | −3.41% |
| `skills` | 10,099 | 10,153 | 10,694 | −5.06% |
| `memory_files` | 1,045 | 1,051 | 1,090 | −3.58% |
| `memory_files_entries` | 1,000 | 1,005 | 1,040 | −3.37% |

**All four static categories land inside the 5–10% bar after calibration**, with worst case 5.06% (skills). The calibration ratio is essentially 1.0 against the natural-language anchor — the local tokenizer under-counts uniformly by ~4% on prose-shaped content, and one anchor's worth of calibration absorbs nearly all of it.

The two outliers (`messages_short` at −43.75%, `messages_code` at −12.29%) are real tokenizer limitations but **do not affect the design**, because the design does not locally tokenize message content. Per the calibration algorithm above:

```
messages_tokens = cost_update.usage.input_tokens − static_total_estimate * calibration_ratio
```

Messages tokens come from Claude's observed `usage.input_tokens` truth via subtraction; the local tokenizer never touches message bodies. The `messages_*` rows in the benchmark above were a stress-test of "what if we did locally tokenize messages" — and confirm we shouldn't. Subtraction is correct.

Notes on the outliers, for reference:
- `messages_short` (−43.75%): the API wraps each `messages: [{role, content}]` payload with ~7 tokens of role-envelope overhead. For a 9-token body that's a 43% relative drift; for a 1,000-token body it's <1%. This is a fixed-cost-per-message phenomenon — uniform across messages — and is absorbed by the calibration ratio over the session.
- `messages_code` (−12.29%): the Claude 2 BPE that `@anthropic-ai/tokenizer` ships has fewer code-style merges than the current Claude 4 vocab. Code under-counts by ~12% even after calibration. Again, the design subtraction skips this entirely.

**Verdict (initial):** the S3 calibration design appeared validated against the synthetic anchor — proceed with the ratio.

**Post-mortem (post-implementation reversal):** during 20.4.7.D.3 implementation review we found that the per-session calibration ratio breaks on resumed sessions. On a resume, the first `cost_update` arrives with `observed_input` including all prior conversation; the anchor (`static_total + new_user_msg_tokens`) is much smaller; the computed ratio comes out >1.0 and — for moderate-history sessions — falls inside the defensive `[0.5, 2.0]` clamp. The accepted-but-wrong ratio then warps every static category by a too-large factor on display.

The fix landed in a fixup commit after D.3: **calibration was dropped entirely.** `messages_tokens` is now derived by direct subtraction: `messages_tokens = max(0, observed_input - static_total)`. The benchmark table above already shows that raw per-category drift (without calibration) is 0.5–5.6% for natural-language content — comfortably inside the 5–10% bar — so the calibration trick was a clever optimization that introduced a worse bug than it fixed.

Lessons:
- The benchmark anchor (a single natural-language file) didn't represent the resume case. A resume-aware benchmark would have caught this earlier; we'd want one before adding any future per-session scaling.
- Defensive clamps that admit "plausible but wrong" inputs are worse than clamps that admit "obviously wrong" inputs. The `[0.5, 2.0]` range let bad ratios through silently. If we ever re-introduce calibration, we'd want a stricter signal that we're on a fresh session (e.g., gate on transcript length) rather than a numerical range.
- Subtraction-from-observed is robust on both fresh and resumed sessions, has no tunable parameters, and produces correct totals by construction. Worth defaulting to this shape for any future "derived from observed truth" feature.

The post-fix design:
- Static categories tokenize once at session_init and again on file edit (via mtime cache).
- Messages tokens = observed input − static total. No scaling. No per-session state beyond the cache.
- Resume case: works correctly by construction; the supervisor's bind-attach re-emits the persisted breakdown so the popover starts populated.

Follow-up benchmarks worth running once 20.4.7.D.5 lands a live popover:
- Real-world category-level drift: open a session, compare Tide's popover values against `/context`'s terminal output. Confirm per-category residual stays inside 5–10% on representative content.
- Resume regression: open → submit → reload → confirm popover still shows correct numbers with no transient warp.

---

## S4 — Update frequency & caching design

**Plan reference:** [#step-20-4-7-d](tide-assistant-turns.md#step-20-4-7-d) Spike S4.
**Depends on:** S1 (SDK surface), S3 (tokenizer choice).

### Question

How often does the breakdown need to update? Which categories are session-stable vs. per-turn-mutable? Is there any mid-session path that breaks the "fixed categories are fixed" assumption?

### Findings

#### Category mutation classes

| Category | Mutation cadence | How tugcode detects | Re-tokenize policy |
|---|---|---|---|
| `system_prompt` | Once per session (CLI-internal; tied to `claude_code_version`) | Read from a static-table keyed by version | Cache by `version`; recompute only on CLI upgrade mid-session (rare) |
| `system_tools` | Once per session (set in `init.tools`) | `init.tools` names → static-table lookup by name + version | Cache by `(version, sorted tool names)` |
| `custom_agents` | Once per session (set in `init.agents`) | Read `~/.claude/agents/<name>.md` for each name | Cache by `(path, mtime)`; re-read only if `mtime` changes |
| `skills` | Once per session (set in `init.skills`) | Read `~/.claude/skills/<name>/SKILL.md` for each name | Cache by `(path, mtime)` |
| `memory_files` | **Re-read each turn** by the CLI; rarely mutates | Re-tokenize iff `mtime` of `~/.claude/CLAUDE.md`, `cwd/CLAUDE.md`, project MEMORY.md (and linked files) changes | Cache by `(path, mtime)` |
| `messages` | **Per turn** (monotonic growth, with compaction resets) | Observe `cost_update.usage.input_tokens` after each `turn_complete` | Re-derive each turn (no caching needed — it's a single subtraction) |
| `autocompact_buffer` | Once per session (depends on user setting + a CLI-internal constant) | Read `~/.claude/settings.json` `autoCompactEnabled` at init — see S5 | Recompute only on settings change (not currently detected mid-session) |

#### Mid-session mutation paths that need handling

1. **CLI upgrade mid-session.** Theoretically possible if the user reinstalls Claude Code while a session is open. The static-categories cache key includes `claude_code_version`; on cache miss the static categories re-tokenize. In practice this requires the session to survive a CLI binary swap, which it usually doesn't.
2. **Memory-file mtime change.** The user edits `~/.claude/CLAUDE.md` or project `CLAUDE.md` between turns. Caught by `mtime` check before re-tokenizing. Re-emit `context_breakdown` if the new tokenization differs.
3. **`/compact` (manual or auto).** `SDKCompactBoundaryMessage` arrives with `compact_metadata.pre_tokens`. Tugcode treats this as a "messages count just reset" signal — re-emit `context_breakdown` after the next `cost_update`. The static categories are unchanged.
4. **Settings change mid-session.** The user toggles `autoCompactEnabled` in `~/.claude/settings.json` between turns. Not currently detected by tugcode. Acceptable — the user would need to restart Claude Code anyway for the autocompact setting to take effect; the breakdown's display will agree with whatever Claude Code is *currently* doing once the session is restarted.
5. **`/clear` or session reset.** Tugcode treats this as a new session — re-emit from scratch.

#### Emission cadence

Following from the mutation classes:

| Event | Action |
|---|---|
| `init` (SDK system message) | Tokenize all static categories with cache; emit provisional `context_breakdown` with `calibration_ratio = 1.0` |
| First `cost_update` after `init` | Calibrate per S3; re-emit `context_breakdown` |
| Each subsequent `cost_update` | Recompute `messages_tokens` from `usage.input_tokens` − calibrated static sum; re-emit |
| `compact_boundary` | Note the boundary; next `cost_update` will carry the new low-water-mark `usage.input_tokens` — re-emit then |
| Memory-file mtime change detected pre-turn | Re-tokenize that file; re-emit if the new sum differs from the cached |
| Each `turn_complete` | The `cost_update` precedes it — no separate work, the breakdown is already current |

#### Why per-turn re-emit is cheap

Re-emitting `context_breakdown` per turn is a fixed-size operation:
- Static categories: cache hit (no work).
- Memory files: `mtime` stat is sub-millisecond per file; ~3 files max.
- Messages: arithmetic.
- Frame serialization: a JSON object with ~7 entries — single-digit microseconds.

The cost is dominated by the cache miss path, which only runs at session init or on mtime change. Both paths tokenize a handful of files of total bytes ≤ tens of KB — `@anthropic-ai/tokenizer` BPE tokenization runs in microseconds per KB. Worst case at session init: tens of milliseconds. Per turn: microseconds.

### Decision

- **Emit cadence:** init, first cost_update (calibration), every cost_update thereafter, after compact_boundary.
- **Cache keys:** `(path, mtime)` for file-backed categories; `(version, sorted names)` for the static-table tool/system-prompt counts.
- **Mutation handling:** re-stat memory files each turn; static categories cached for the session lifetime.
- **No mid-turn emit needed** — categories don't mutate within a turn.

### Follow-ups

- The cache lives on the tugcode process; HMR / supervisor restart loses it. The S6 persistence layer carries only the last emitted frame, not the cache. Cache misses on a fresh tugcode are cheap (tens of ms at init) so this is fine — no need to persist the cache itself.
- If `inotify`-style file watchers are added later (out of scope here), memory-file mtime changes could trigger mid-turn re-emits. Current design polls on the per-turn boundary, which is sufficient for the popover's responsiveness expectations.

---

## S5 — Autocompact buffer settings access

**Plan reference:** [#step-20-4-7-d](tide-assistant-turns.md#step-20-4-7-d) Spike S5.
**SDK version inspected:** `@anthropic-ai/claude-agent-sdk@0.2.42` (bundled `claudeCodeVersion: 2.1.42`).

### Question

How does tugcode learn:
1. Whether the user has autocompact enabled?
2. The current reserved-buffer size (token count) when enabled?

Two candidate paths from the plan: an SDK query, or a direct read of Claude Code's per-user config file.

### Findings

#### Path 1 — SDK exposes autocompact setting?

Searched `sdk.d.ts` exhaustively for `autoCompact`, `autocompact`, `compact.*setting`, `compact.*buffer`, `reserved.*token`, `buffer.*token`. Found:

- `SDKStatus = 'compacting' | null` — runtime status, not a setting.
- `SDKCompactBoundaryMessage` — fires after the fact, carries `pre_tokens` only.
- `PreCompactHookInput` — hook fires before compaction, carries no buffer size.

**No SDK surface exposes the user's autocompact setting or the reserved-buffer size.**

#### Path 2 — Direct read of `~/.claude/settings.json`

Confirmed by inspecting the running user's settings:

```json
// ~/.claude/settings.json
{
  "enabledPlugins": {},
  "alwaysThinkingEnabled": true,
  "effortLevel": "xhigh",
  "autoUpdatesChannel": "latest",
  "theme": "dark-ansi",
  "autoCompactEnabled": false,   // <-- the field we need
  "skipAutoPermissionPrompt": true,
  "env": { "ENABLE_CLAUDEAI_MCP_SERVERS": "false" },
  "feedbackSurveyState": { ... }
}
```

The `autoCompactEnabled` boolean is a stable, top-level key. Schema is documented (Claude Code respects standard config locations: `~/.claude/settings.json`, `~/.claude/settings.local.json`, project-level `.claude/settings.json`, `.claude/settings.local.json`).

**Confirmed: tugcode can read `~/.claude/settings.json` at session init and learn `autoCompactEnabled` reliably.**

#### Reserved-buffer size

No source in `~/.claude/settings.json` carries the reserved-buffer size — it's an internal Claude Code constant. Per the plan's research, current value is ~33k tokens (reduced from ~45k in early 2026). This is hardcoded in the CLI binary.

Options:
- **Hardcode the constant in tugcode** — `AUTOCOMPACT_BUFFER_TOKENS = 33000`. Track the CLI version it was measured against. Worst-case staleness: the popover shows a slightly-wrong buffer slice until tugcode is updated.
- **Derive empirically from `compact_boundary.compact_metadata.pre_tokens`** — when auto compaction fires, `pre_tokens` ≈ `context_max − buffer`, so `buffer ≈ context_max − pre_tokens`. Requires waiting for the first auto-compact in a session to learn it; useless at session init.

The pragmatic combo: **hardcode + observe**. Start with `AUTOCOMPACT_BUFFER_TOKENS = 33000`; if `compact_boundary` arrives with a `pre_tokens` value that implies a different buffer size, update the in-memory constant for the rest of the session and re-emit `context_breakdown`. Persist the observed value to the S6 store keyed by `claude_code_version` so subsequent sessions start with the calibrated value.

### Decision

**Settings access:** tugcode reads `~/.claude/settings.json` at session init via `fs/promises.readFile` + `JSON.parse`. Cache the parsed result; re-read on next session init. Look up `autoCompactEnabled: boolean` (default to `true` if missing — that matches Claude Code's documented default behavior).

**Reserved buffer:** start with hardcoded `AUTOCOMPACT_BUFFER_TOKENS = 33000` (current per claudefa.st guide; will need bumping as Claude Code evolves). On every `compact_boundary` event, infer the buffer from `pre_tokens` and update the constant for the rest of the session. Optionally persist the inferred value back to the S6 store keyed by `claude_code_version`.

**Wire frame behavior:** `categories[]` includes `autocompact_buffer` only when `autoCompactEnabled === true` AND the reserved count is non-zero. When disabled, the category is absent from the wire frame entirely; the renderer paints one fewer slice and a larger `free_space`.

### Implementation surface in tugcode

```typescript
// New: tugcode/src/claude-code-settings.ts
export interface ClaudeCodeSettings {
  autoCompactEnabled: boolean;
  // ... other fields tugcode may read in the future
}

export async function readClaudeCodeSettings(): Promise<ClaudeCodeSettings> {
  const path = `${os.homedir()}/.claude/settings.json`;
  try {
    const raw = await fs.readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      autoCompactEnabled: typeof parsed.autoCompactEnabled === "boolean"
        ? parsed.autoCompactEnabled
        : true,  // CLI default
    };
  } catch {
    return { autoCompactEnabled: true };  // safe default
  }
}

// New constant:
export const AUTOCOMPACT_BUFFER_TOKENS_DEFAULT = 33_000;
```

The context-breakdown emitter reads settings once at session init and treats the value as immutable for the session.

### Follow-ups

- Mid-session settings change is not detected. If a future Tide UX surfaces an "autocompact buffer" toggle that writes to `~/.claude/settings.json`, tugcode would need a settings reload trigger. Out of scope here.
- If Claude Code ever exposes the reserved-buffer size through the SDK (e.g., via `initializationResult()` or a new `ConfigInfo` surface), switch to that and retire the hardcoded constant.
- Project-level `.claude/settings.json` could override the user-level setting. Current implementation reads the user-level file only. Document this as a known gap; address if it matters in practice. The `cwd` from `init` would be the discovery root for the project-level override.

---

## S6 — Persistence shape for `context_breakdown` frames

**Plan reference:** [#step-20-4-7-d](tide-assistant-turns.md#step-20-4-7-d) Spike S6.
**Depends on:** S1 (wire-frame shape), S5 (autocompact handling).

### Question

Where does the latest `context_breakdown` frame land in the sqlite session ledger? Three candidates from the plan:
- (a) Extension to the [#step-20-4-8](tide-assistant-turns.md#step-20-4-8) `session_state_changes` ledger.
- (b) New `context_breakdown_latest` single-row-per-session table (UPSERT semantics).
- (c) New `context_breakdown_history` append-only table.

The chosen shape must NOT carry any MCP-related field per the plan's "Out of scope: MCP" section.

### Analysis

#### Access pattern

The popover only ever wants the **latest** breakdown for the current session. At session bind, the supervisor inlines the latest breakdown onto the bind response so the snapshot's `lastContextBreakdown` populates before the popover opens. There is no consumer today for the full history.

#### Volume

If we emit on init + every turn_complete + every compact_boundary, a busy session might accumulate 50–200 breakdowns per session. Across a corpus of active sessions, this is small (single-digit MB per year), but it's also un-needed weight for a feature whose access pattern is "latest only."

#### 20.4.8's ledger is wrong-shaped

`session_state_changes` is a transition log for the indicator's tone axes (`phase`, `transportState`, `interruptInFlight`). It explicitly avoids fields outside that triple per the plan's "ledger axes ≡ indicator's tone axes" invariant. Cramming `context_breakdown` into it would break that invariant and confuse the table's purpose. Reject (a).

#### History table is premature

(c) appends every frame. The hypothetical future "context-growth over time" surface would benefit — but it's hypothetical. We can always derive coarse history from the existing `cost_update` rows + cached static-category counts; the static categories don't change within a session, so historical messages-tokens reconstructs to ±5% accuracy from the per-turn `usage.input_tokens` series alone. Adding (c) now would persist data we don't read. Reject (c).

#### Latest-only is right-sized

(b) `context_breakdown_latest` UPSERTs one row per session. The popover reads it once at bind. Storage stays bounded. When a future "context-growth over time" surface arrives, it can either (i) derive from `cost_update` series + cached statics, or (ii) add `context_breakdown_history` as a separate table without migrating `_latest`. Pick (b).

### Decision

**New table: `context_breakdown_latest`. One row per session. UPSERT on each `context_breakdown` frame. Payload stored as a JSON blob mirroring the wire frame verbatim.**

#### Schema

```sql
CREATE TABLE IF NOT EXISTS context_breakdown_latest (
  session_id  TEXT PRIMARY KEY,
  payload     BLOB NOT NULL,
  captured_at INTEGER NOT NULL
);
```

Plus a paired `CREATE TRIGGER IF NOT EXISTS context_breakdown_latest_cascade_delete_on_session AFTER DELETE ON sessions` mirroring the cascade triggers used by `turn_telemetry` and `session_metadata` in the same file. No FK constraint — the cascade trigger preserves the "forget cascades" contract without coupling INSERT ordering.

Notes on schema choices:
- **JSON blob, not per-column.** The single access pattern is PK lookup; the renderer reads a fixed-shape struct from the parsed JSON; the wire-frame TypeScript types validate the payload on both ends. Per-column storage would duplicate that validation without buying indexed-field queries we don't need. Promoting a new category in the future becomes a TypeScript-only change. This decision mirrors the `session_metadata` precedent in the same `session_ledger.rs` file, whose existing comment justifies the blob approach in nearly identical terms.
- **No `mcp_tools` category in the wire frame**, so no MCP bytes ever reach this table. Per "Out of scope: MCP" in the plan.
- **`session_id` column name** matches the convention used by `turn_telemetry` / `session_metadata` in the same file (the column is the Claude-assigned session id, which IS the Tug-tracked session at this layer).
- **`captured_at`** is the wall-clock millisecond timestamp when the row was last written — for debugging / staleness audits. Distinct from any time field the payload itself may carry.

Tradeoff intentionally accepted: no `WHERE messages_tokens > X` style queries. If a future "context-growth over time" surface needs them, it lives in a separate `context_breakdown_history` table that can parse the blob into per-category columns at insert time, leaving `_latest` as the popover's source of truth.

Per-session axes the payload itself carries (in the wire frame JSON), not as separate columns:
- `context_max` — the model's context-window cap.
- `categories[]` — per-category id + label + token count. Wire frame's array shape is what the renderer wants; no normalization needed at the persistence layer.
- `autocompact_buffer` — present in `categories[]` only when the user has the buffer enabled (per S5); absent otherwise. Renderer trusts the wire-frame shape.
- `calibration_ratio` — the per-session scaling from S3, carried in the wire frame so a resume can re-emit calibrated frames before the first new turn lands.
- `claude_code_version` — the cache-key axis from S4; a CLI upgrade rewrites the row with re-tokenized values.

#### Writer / reader paths

- **Persistence lives in the tugcast `SessionLedger`** (`tugrust/crates/tugcast/src/session_ledger.rs`), the same sqlite store that already owns `sessions`, `turns`, `turn_telemetry`, and `session_metadata`. *Not* the separate `tugbank-core` typed-defaults store — that one is reserved for user-preferences-style key-value defaults, while `SessionLedger` is the per-session metadata store the supervisor already owns and cascade-deletes on `forget`. (Earlier drafts of this section called it "tugbank"; that was wrong.)
- **Writer:** symmetric with the `record_turn_telemetry` precedent from `#step-20-3-4`. tugcode emits the `context_breakdown` frame; the supervisor forwards it to tugdeck unchanged; tugdeck's reducer consumes it and dispatches a `record_context_breakdown` CONTROL action back to the supervisor; the supervisor calls `SessionLedger.record_context_breakdown(&row)`. Reducer-as-persistence-boundary keeps the supervisor agnostic of the wire shape and matches the existing pattern.
- **Reader:** at session bind, the supervisor SELECTs the row by `session_id` (matching the `session_id` column convention used by `turn_telemetry` / `session_metadata`) and inlines it onto the bind response. The reducer's bind handler projects it onto `CodeSessionSnapshot.lastContextBreakdown`. If no row exists, `lastContextBreakdown === null` and the popover hits its 20.4.7.C fallback per the plan's "Fallback contract".

#### Transport-close behavior

The plan asks whether transport-close should clear the latest breakdown or preserve it across reconnect. Decision: **preserve it.** The breakdown describes session-level facts (system prompt size, memory file contents, accumulated messages) that survive a transport flap. Clearing on transport-close would briefly degrade the popover to its fallback view during a reconnect, which is jarring and wrong. Keep the row; let the next live `context_breakdown` frame overwrite it on the next turn.

#### 20.4.8 MCP-column audit

When [#step-20-4-8](tide-assistant-turns.md#step-20-4-8) lands, audit its `session_state_changes` schema for any MCP-related column or row variant. If found, delete it as part of this step's persistence work. Current 20.4.8 schema (per the roadmap as of 2026-05-18) has no MCP columns — the schema is exactly `(id, tug_session_id, at_ms, phase, transport_state, interrupt_in_flight)`. Confirmed clean — no MCP cleanup needed if 20.4.8 lands as currently designed.

### Decision summary

- **Shape:** `context_breakdown_latest` table, one row per session, UPSERT semantics.
- **Persistence cadence:** every emitted frame (init + per-turn + post-compact).
- **No MCP columns.**
- **Transport-close:** preserve the row.
- **Bind reader:** supervisor inlines the row onto the bind response.

### Follow-ups

- If a future "context-growth over time" surface lands, add a separate `context_breakdown_history` append-only table at that point. The two tables can coexist; `_latest` stays the popover's source of truth.
- The `calibration_ratio` column is currently per-session. If we want cross-session calibration (e.g., "carry forward last session's ratio for a quick startup before the first new turn lands"), a separate `context_breakdown_calibration_history` table keyed by `(cwd, claude_code_version)` could store rolling averages. Out of scope for this step.
- 20.4.8 schema is currently MCP-clean; re-audit at implementation time and add a `DROP COLUMN` migration here if anything slipped in.
