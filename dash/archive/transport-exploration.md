# Transport Exploration — Phase 1 Findings

*Live document. Updated as we probe the tugcast/tugcode transport.*

> **Version banner.** This document was empirically verified against `claude 2.1.87` (initial capture, 2026-03-29) and `2.1.104` (multi-session router Step 10 integration run, 2026-04-12), and re-baselined to `2.1.158` on 2026-05-30 (dev-card parity Step 7a — full 36-probe catalog, adding `test-36-slash-rewind`). The **authoritative machine-readable golden fixtures** live at [`tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/`](../tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/) and are ground truth — this prose catalog is a human-readable summary that may lag behind the fixtures. If the drift test fails, the fixtures are correct and this document is stale; update the prose to match.
>
> **Cross-links:** [`tide.md#p2-followup-golden-catalog`](tide.md#p2-followup-golden-catalog) (originating dev item) · [`tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/README.md`](../tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/README.md) (developer-facing recovery guide, placeholder vocabulary, and version-bump runbook).

**Date:** 2026-03-29 (initial), 2026-04-12 (2.1.104 re-baseline)
**Method:** Direct tugcode probing via `tugtalk/probe.ts` (legacy probe harness, preserved as historical path) — bypasses tugcast, connects to tugcode's stdin/stdout JSON-lines protocol. 35 tests completed.

---

## Known divergences from prose catalog

Deltas surfaced by the Step 4 `2.1.104` baseline capture run. The fixtures at [`tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/v2.1.104/`](../tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/v2.1.104/) are authoritative; the bullets below flag where this prose lags or where `2.1.104` behaves differently from the `2.1.87` snapshot this document was originally written against.

### New fields in `2.1.104` (not mentioned in original prose)

The following top-level fields surfaced in the `2.1.104` capture and are now recorded in `v2.1.104/schema.json`. They are additive — no breaking changes to existing fields.

- `cost_update`: `modelUsage` (per-model token breakdown), `speed`, `service_tier`, plus richer `usage` nesting.
- `system_metadata`: `inference_geo` (region-of-inference hint), additional slots in the tools/skills arrays.
- `session_init` / various: `ipc_version` (now consistently `2`).
- `tool_use` / subagent events: `task_id` correlation field.

The original `2.1.87` prose described the *shapes* we observed at that time — the `2.1.104` captures extend them, and the golden schemas track the extended shapes.

### Probes with inherent optional-event variance (classified `shape_unstable` but accepted)

Two probes produced different canonical event sequences across `TUG_STABILITY=3` runs. This is real streaming optionality from Claude, not drift, and is accepted per [D08] REQUIRED vs OPTIONAL semantics.

- **test-05** — `thinking_text` is sometimes emitted before `tool_use`, sometimes not. Treated as OPTIONAL.
- **test-18** — a trailing `assistant_text complete` event is sometimes emitted after `turn_complete`, sometimes not. Treated as OPTIONAL.

### Probes skipped at capture time (upstream bugs blocking full run)

Six probes are marked with `skip_reason` in `v2.1.104/manifest.json` and emit empty JSONL files. They point at the relevant tide.md §T0.5 entries:

- **test-10** (long streaming), **test-25** (`/tugplug:plan` invocation), **test-35** (`AskUserQuestion` flow) — blocked by **§T0.5 P19** (HIGH): 45s WebSocket reset on long-running capture probes. Every probe with a wall-clock > ~45s dies with "Connection reset without closing handshake" regardless of per-probe `timeout_secs`.
- **test-13, test-17, test-20** (`session_command: new`/`continue`/`fork`) — blocked by **§T0.5 P16**: session_command routing bug. Step 4 canary confirmed the symptom extends beyond the original probe.

### Corrections against the original prose

- **test-08 `control_request_forward`.** The original prose said CRF is required for permission-deny flows; `2.1.104` confirms this. An earlier capture attempt briefly suggested CRF was missing, but root-cause analysis showed it was a `WaitForEvent` buffer-consumption bug in the capture harness, not prose drift. After the `peek_code_output_event` fix landed, the event ships as originally documented.
- **Stream partial counts are non-deterministic.** Any prose-level expectation about "N partial `assistant_text` events" should be read as *shape*, not *count*. The Step 4 canonical-sequence comparator collapses consecutive duplicate event types before stability checks — count variance is not drift.

---

**Action items live in [tug-conversation.md](tug-conversation.md)** — items T1-T6 (transport fixes), U1-U18 (UI work), C1-C15 (terminal-only commands), E1-E6 (exploration areas). This document is the exploration journal.

---

## Setup

Tugcode spawns Claude Code as a subprocess with `--output-format stream-json --input-format stream-json --verbose --permission-prompt-tool stdio --include-partial-messages --replay-user-messages`. Communication is JSON-lines over stdin (inbound) and stdout (outbound). Stderr carries tugcode's own logs.

---

## Test 1: Basic Round-Trip

**Sent:** `{ type: "user_message", text: "Say hello in exactly 5 words." }`

**Event sequence:**
1. `protocol_ack` — `{ version: 1, session_id: "pending", ipc_version: 2 }`
2. `session_init` — `{ session_id: "05086f97-..." }`
3. `system_metadata` — rich object (see below)
4. `assistant_text` — partial, 5 chars: `"Hello"`
5. `assistant_text` — partial, 20 chars: `"Hello there, how are you?"`
6. `cost_update` — `$0.0642`, 1 turn
7. `assistant_text` — complete, 25 chars (full text)
8. `turn_complete` — `{ msg_id, seq: 2, result: "success" }`

**Findings:**
- Round-trip works. Send `user_message`, get streamed `assistant_text` events back.
- Short response produced only 2 partials. Batching is coarse for small outputs.

---

## Test 2: Longer Response (Streaming Behavior)

**Sent:** `{ type: "user_message", text: "Write a short paragraph (about 100 words) explaining why the sky is blue." }`

**Event sequence:**
1. `system_metadata`
2. `thinking_text` — partial, delta: `"The user is asking me to write a short paragraph explaining why the sky is blue. This is a general knowledge question, not related to the"`
3. `thinking_text` — partial, delta: `" codebase."`
4. `assistant_text` — partial (6 chunks, ~100-140 chars each)
5. `cost_update` — `$0.0263`
6. `assistant_text` — complete, 634 chars (full text)
7. `turn_complete`

**Findings:**

### Streaming text model: DELTAS for partials, FULL TEXT for complete

- **Partial events:** `text` field contains a **delta** (new chunk only), not accumulated text. Lengths: 134, 102, 144, 116, 120, 18 — these are chunk sizes, not growing totals.
- **Complete event:** `text` field contains the **full accumulated text** (634 chars).
- **Implication for tug-markdown:** Must accumulate deltas in a buffer during streaming. Can verify/replace with the full text from the complete event.

### `thinking_text` is a separate event type

- Arrives before `assistant_text` when extended thinking is active.
- Same delta model as `assistant_text` partials.
- Same `msg_id` as the subsequent `assistant_text` events.
- Fields: `type`, `msg_id`, `seq`, `text` (delta), `is_partial`, `status`.
- This is the data source for a `tug-thinking` collapsible block.

### Streaming frequency

- 6 partial events for ~634 chars ≈ one partial per ~100 chars.
- At typical LLM output speeds (~50 tokens/sec), this means roughly 1-2 events per second.
- Comfortable for rAF-throttled rendering — no need for aggressive batching.

### Event ordering

`system_metadata` → `thinking_text` (partials) → `assistant_text` (partials) → `cost_update` → `assistant_text` (complete) → `turn_complete`

---

## Test 3: Slash Command — `/cost`

**Sent:** `{ type: "user_message", text: "/cost" }`

**Event sequence:**
1. `system_metadata`
2. `cost_update` — `$0.0000`, 15 turns
3. `turn_complete`

**Findings:**
- Slash commands work — `/cost` is interpreted as a command, not sent to Claude.
- **No `assistant_text` at all.** The formatted cost table shown in the terminal is not exposed as text in stream-json mode.
- The structured data (`cost_update`) is available, but the UI must render its own display.

---

## Test 4: Slash Command — `/status`

**Sent:** `{ type: "user_message", text: "/status" }`

**Event sequence:**
1. `system_metadata`
2. `cost_update` — `$0.0000`, 16 turns
3. `turn_complete`

**Findings:**
- Same pattern as `/cost` — no text output, only structured events.
- Status information (model, session, context) is already in `system_metadata` sent on every turn.
- **Slash commands that produce terminal-rendered UI produce no text events in stream-json mode.** The graphical UI must render its own status/cost displays from structured data.

---

## Test 5: Tool Use (Read File)

**Sent:** `{ type: "user_message", text: "Read the first 3 lines of CLAUDE.md and tell me what they say." }`

**Event sequence:**
1. `system_metadata`
2. `tool_use` — partial: `{ tool_name: "Read", tool_use_id: "toolu_01Lva...", input: {} }`
3. `tool_use` — complete: `{ ..., input: { file_path: "/Users/.../CLAUDE.md", limit: 3 } }`
4. `tool_result` — `{ tool_use_id: "toolu_01Lva...", output: "1\t# Claude Code Guidelines...", is_error: false }`
5. `tool_use_structured` — `{ tool_use_id: "toolu_01Lva...", structured_result: { type: "text", file: { filePath, content, numLines, startLine, totalLines } } }`
6. `assistant_text` — partials (3 chunks)
7. `cost_update` — `$0.0519`
8. `assistant_text` — complete
9. `turn_complete`

**Findings:**

### `tool_use` streams incrementally

- First event has `input: {}` (empty — tool call is being constructed).
- Second event has full `input: { file_path, limit }`.
- Same `tool_use_id` on both. UI can show "Reading..." on the first, populate details on the second.

### `tool_result` vs `tool_use_structured`

- `tool_result`: simple `output` string + `is_error` boolean. The text representation.
- `tool_use_structured`: rich typed data. For Read, includes `file` object with `filePath`, `content`, `numLines`, `startLine`, `totalLines`.
- Both share the same `tool_use_id` for correlation.
- **`tool_use_structured` is the data source for rich custom block renderers.** The structured result has typed fields the UI can render meaningfully (file viewer, diff view, etc.).

### Tool event ordering

`tool_use` (partial) → `tool_use` (complete) → `tool_result` → `tool_use_structured` → `assistant_text`

---

## Event Type Catalog (Observed So Far)

| Event | When | Key Fields | Text? |
|-------|------|-----------|-------|
| `protocol_ack` | After handshake | `version`, `session_id`, `ipc_version` | No |
| `session_init` | After claude spawns | `session_id` | No |
| `system_metadata` | Start of every turn | tools, model, slash_commands, plugins, agents, skills, mcp_servers, version, permissionMode | No |
| `thinking_text` | Before response | `msg_id`, `seq`, `text` (delta), `is_partial`, `status` | Yes (thinking) |
| `assistant_text` | During response | `msg_id`, `seq`, `text` (delta on partial, full on complete), `is_partial`, `status` | Yes (response) |
| `tool_use` | Tool invoked | `msg_id`, `seq`, `tool_name`, `tool_use_id`, `input` (streams empty→full) | No |
| `tool_result` | Tool completed | `tool_use_id`, `output` (text), `is_error` | No |
| `tool_use_structured` | Tool completed | `tool_use_id`, `tool_name`, `structured_result` (typed) | No |
| `cost_update` | Near end of turn | `total_cost_usd`, `num_turns` | No |
| `turn_complete` | End of turn | `msg_id`, `seq`, `result` | No |

---

## `system_metadata` Fields

Sent at the start of every turn. Contains everything the UI needs for chrome/status:

```json
{
  "type": "system_metadata",
  "session_id": "05086f97-...",
  "cwd": "/Users/kocienda/Mounts/u/src/tugtool",
  "tools": ["Task", "AskUserQuestion", "Bash", "Edit", "Glob", "Grep", "Read", "Write", ...],
  "model": "claude-opus-4-6",
  "permissionMode": "acceptEdits",
  "slash_commands": ["update-config", "debug", "simplify", "batch", "loop", "schedule", "claude-api", "commit", ...],
  "plugins": [{ "name": "tugtool", "path": "...", "source": "tugtool@inline" }],
  "agents": ["general-purpose", "statusline-setup", "Explore", "Plan", "claude-code-guide"],
  "skills": ["update-config", "debug", "simplify", "batch", "loop", "schedule", "claude-api", "commit"],
  "mcp_servers": [{ "name": "claude.ai Gmail", "status": "needs-auth" }, ...],
  "version": "2.1.87",
  "output_style": "default",
  "fast_mode_state": "off",
  "apiKeySource": "ANTHROPIC_API_KEY",
  "ipc_version": 2
}
```

**Note:** `slash_commands` here are Claude Code built-ins + plugin-contributed commands. Tugplug skills (`/plan`, `/implement`, `/merge`, `/dash`) are NOT in this list — they appear as entries in `skills` without the `/` prefix. The UI needs to merge both sources for the slash command popup.

---

## Process Management Issue

**Found before any messages were sent.** After ~2 weeks of use, 137 orphaned tugcode (bun) processes were running. Tugcast exits when the app quits, but its child tugcode processes are not killed — they become orphans and accumulate indefinitely.

**Root cause:** No process group management. Tugcast spawns tugcode but doesn't SIGTERM children on shutdown. Card close doesn't kill the associated tugcode.

**Added to Phase 2 (Transport Hardening) work list.**

---

## Test 6: Interrupt Mid-Stream

**Sent:** Long essay prompt, then `{ type: "interrupt" }` after 3 partial events.

**Event sequence:**
1. `thinking_text` — partial
2. `assistant_text` — 3 partials (~277 chars total)
3. **>>> `interrupt` sent**
4. `cost_update` — `$0.0000`
5. `assistant_text` — complete, 277 chars (the accumulated partial text)
6. `turn_complete` — `{ result: "error" }` ← not "cancelled"!

**Findings:**
- **Interrupt works quickly.** Generation stops after the next chunk boundary.
- **No `turn_cancelled` event.** Instead, `turn_complete` fires with `result: "error"`.
- **The final complete event still arrives.** It contains the accumulated text up to the interrupt point, with `is_partial: false, status: "complete"`. The text isn't lost.
- **Tugcode logs:** `"Interrupting current turn via control_request interrupt"` → receives `control_response` with `subtype: "success"`.
- **Implication for UI:** Listen for `turn_complete` with `result: "error"` as the interrupt signal. Don't wait for a separate `turn_cancelled` event — it doesn't exist.

---

## Test 7: Multiple Tool Calls in One Turn

**Sent:** `"Read the first line of CLAUDE.md and the first line of package.json in tugdeck/. Tell me both."`

**Event sequence:**
1. `tool_use` — partial: Read, `input: {}`
2. `tool_use` — complete: Read, `input: { file_path: "CLAUDE.md", limit: 1 }`
3. `tool_use` — partial: Read #2, `input: {}`
4. `tool_result` — first Read result
5. `tool_use_structured` — first Read structured result
6. `tool_use` — complete: Read #2, `input: { file_path: "tugdeck/package.json", limit: 1 }`
7. `tool_result` — second Read result
8. `tool_use_structured` — second Read structured result
9. `assistant_text` — 3 partials + complete
10. `turn_complete`

**Findings:**
- **Multiple tool calls interleave.** Tool use #2's partial arrives before tool #1's result. The tools run concurrently.
- **Each tool has its own `tool_use_id`** for correlation. The UI can track them independently.
- **Tool events and results interleave.** Don't assume all `tool_use` events arrive before any `tool_result` events.

---

## Test 8: Tool Error (Nonexistent File)

**Sent:** `"Read the file /nonexistent/path/that/does/not/exist.txt"`

**Event sequence:**
1. `tool_use` — partial then complete: Read with nonexistent path
2. `control_request_forward` — **new event type!**

```json
{
  "type": "control_request_forward",
  "request_id": "05f295db-...",
  "tool_name": "Read",
  "input": { "file_path": "/nonexistent/path/that/does/not/exist.txt" },
  "decision_reason": "Path is outside allowed working directories",
  "permission_suggestions": [{
    "type": "addRules",
    "rules": [{ "toolName": "Read", "ruleContent": "//nonexistent/path/that/does/not/**" }],
    "behavior": "allow",
    "destination": "session"
  }],
  "tool_use_id": "toolu_018QZXCEb...",
  "is_question": false
}
```

**Findings:**
- **Permission denial is a `control_request_forward`, not a `tool_result` with `is_error: true`.**
- This event requires a response — the UI must either approve or deny. Without a response, the turn hangs.
- `decision_reason` explains why: "Path is outside allowed working directories".
- `permission_suggestions` offers what rules to add to allow it.
- `is_question: false` means this is a permission gate, not a clarifying question.
- **This is the tool approval flow.** The event name is `control_request_forward`, not `tool_approval_request` or `permission_request` as we assumed in the roadmap.

---

## Test 9: Bash Tool Call (Auto-Approved)

**Sent:** `"Run this bash command: echo 'hello from bash'"`

**Event sequence:**
1. `tool_use` — Bash, `input: { command: "echo 'hello from bash'", description: "..." }`
2. `tool_result` — `output: "hello from bash"`, `is_error: false`
3. `tool_use_structured` — `{ stdout: ..., stderr: ..., interrupted: ..., isImage: ..., noOutputExpected: ... }`
4. `assistant_text` + `turn_complete`

**Findings:**
- Bash auto-approved in `acceptEdits` mode — no permission prompt.
- `tool_use_structured` for Bash has rich fields: `stdout`, `stderr`, `interrupted`, `isImage`, `noOutputExpected`.
- The `tool_result.output` is the plain text output; `tool_use_structured.structured_result` has the separated stdout/stderr.

---

## Test 10: Long Streaming (300 Words)

**Sent:** `"Write exactly 300 words about the history of the internet. Count carefully."`

**Results:** 24 partial events + 1 complete over 13.4 seconds. Total text: 2174 chars.

**Streaming frequency analysis:**

| Metric | Value |
|--------|-------|
| Partial events | 24 |
| Total time | 13.4s |
| Events/second | ~1.8 |
| Avg chunk size | ~90 chars |
| Min chunk size | 33 chars |
| Max chunk size | 125 chars |
| Total text length | 2174 chars |

**Findings:**
- **~2 events per second** during active streaming. Comfortable for UI rendering.
- **Chunk sizes vary** from 33 to 125 chars. Not fixed-size; depends on LLM token boundaries.
- **`thinking_text` arrives first** (single partial in this case), then all `assistant_text` partials, then `cost_update`, then the final complete, then `turn_complete`.
- At 2 events/sec, rAF throttling (16ms) is overkill — the events are already slower than frame rate. Simple re-render on each partial would work fine.

---

## Updated Event Type Catalog

| Event | When | Key Fields | Notes |
|-------|------|-----------|-------|
| `protocol_ack` | After handshake | `version`, `session_id`, `ipc_version` | `session_id` is `"pending"` initially |
| `session_init` | After claude spawns | `session_id` | Real session ID |
| `system_metadata` | Start of every turn | tools, model, slash_commands, plugins, agents, skills, mcp_servers, version | Slash command list source for UI |
| `thinking_text` | Before response | `msg_id`, `seq`, `text` (delta), `is_partial`, `status` | Extended thinking content |
| `assistant_text` | During response | `msg_id`, `seq`, `text` (delta on partial, full on complete), `is_partial`, `status` | Main response content |
| `tool_use` | Tool invoked | `msg_id`, `seq`, `tool_name`, `tool_use_id`, `input` | Streams: empty input → full input |
| `tool_result` | Tool completed | `tool_use_id`, `output` (text), `is_error` | Plain text result |
| `tool_use_structured` | Tool completed | `tool_use_id`, `structured_result` | Rich typed data (file, bash, etc.) |
| `control_request_forward` | Permission needed | `request_id`, `tool_name`, `input`, `decision_reason`, `permission_suggestions`, `is_question` | **Not** `tool_approval_request` |
| `cost_update` | Near end of turn | `total_cost_usd`, `num_turns` | |
| `turn_complete` | End of turn | `msg_id`, `seq`, `result` | `result` is `"success"` or `"error"` (includes interrupt) |

---

## Test 11: Permission Approval Round-Trip (Deny)

**Sent:** `"Read the file /nonexistent/file.txt"` with auto-DENY

**Event sequence:**
1. `tool_use` — Read, partial then complete
2. `control_request_forward` — `{ tool_name: "Read", decision_reason: "Path is outside allowed working directories", is_question: false }`
3. **>>> `tool_approval` sent:** `{ type: "tool_approval", request_id: "...", decision: "deny", message: "Denied by probe script" }`
4. `tool_result` — `{ is_error: true, output: "Denied by probe script" }`
5. `tool_use_structured` — `type: unknown`
6. `assistant_text` — Claude explains the file doesn't exist
7. `turn_complete` — `result: "success"`

**Findings:**
- **Permission round-trip works.** UI sends `tool_approval` (not `control_response`), tugcode translates to `control_response` for Claude.
- **Inbound format for permissions:** `{ type: "tool_approval", request_id, decision: "allow" | "deny", updatedInput?, message? }`
- **Inbound format for questions:** `{ type: "question_answer", request_id, answers: { key: value } }`
- On deny, `tool_result` arrives with `is_error: true` and the deny message as output.
- Claude handles the denial gracefully — explains the failure to the user.

---

## Test 12: Slash Commands — `/compact`, `/model`

**`/compact`:** 6.2 seconds to compact (session had 48 turns from probing). Events: `system_metadata` → `cost_update` → `turn_complete`. No text.

**`/model`:** Instant. Same pattern — no text, no interactive picker in stream-json mode.

**Finding:** Slash commands that are interactive in the terminal (model picker, etc.) produce no interactive events in stream-json mode. The graphical UI must build its own pickers and send the corresponding inbound messages directly:
- Model change: `{ type: "model_change", model: "claude-sonnet-4-6" }`
- Permission mode: `{ type: "permission_mode", mode: "acceptEdits" }`
- Session commands: `{ type: "session_command", command: "fork" | "continue" | "new" }`

---

## `control_request_forward` — The Unified Gate Event

This is the single most important event for UI interaction beyond text streaming. It handles **both** permission requests and `AskUserQuestion` calls through one event type:

```json
{
  "type": "control_request_forward",
  "request_id": "uuid",
  "tool_name": "Read" | "Bash" | "AskUserQuestion" | ...,
  "input": { /* tool input or question definitions */ },
  "decision_reason": "string | undefined",
  "permission_suggestions": [{ "type": "addRules", "rules": [...], "behavior": "allow" }],
  "tool_use_id": "toolu_...",
  "is_question": false | true,
  "ipc_version": 2
}
```

**Dispatching logic for the UI:**

| `is_question` | `tool_name` | UI Action | Response Type |
|---------------|-------------|-----------|---------------|
| `false` | any tool | Show permission dialog (tool name, input, reason) | `tool_approval` |
| `true` | `AskUserQuestion` | Show question UI (from `input` questions) | `question_answer` |

**Permission response:** `{ type: "tool_approval", request_id, decision: "allow" | "deny", updatedInput?, message? }`

**Question response:** `{ type: "question_answer", request_id, answers: { questionKey: "answer" } }`

---

## Inbound Message Types (UI → Tugcode)

Complete catalog of messages the UI can send:

| Type | Purpose | Key Fields |
|------|---------|-----------|
| `protocol_init` | Handshake | `version: 1` |
| `user_message` | Send prompt | `text`, `attachments[]` |
| `tool_approval` | Answer permission prompt | `request_id`, `decision`, `updatedInput?`, `message?` |
| `question_answer` | Answer AskUserQuestion | `request_id`, `answers: {}` |
| `interrupt` | Stop current turn | (no fields) |
| `permission_mode` | Change permission mode | `mode: "default" \| "acceptEdits" \| "bypassPermissions" \| ...` |
| `model_change` | Switch model | `model: "claude-opus-4-6" \| "claude-sonnet-4-6" \| ...` |
| `session_command` | Session management | `command: "fork" \| "continue" \| "new"` |
| `stop_task` | Stop a running task | `task_id` |

---

## Key Protocol Corrections (vs. Roadmap Assumptions)

1. **Permission AND question events are both `control_request_forward`.** Differentiated by `is_question` flag. The roadmap assumed separate `tool_approval_request` and `question` event types — there's one unified event.

2. **Interrupt produces `turn_complete` with `result: "error"`, not `turn_cancelled`.** There is no `turn_cancelled` event type.

3. **`assistant_text` partials are deltas, not accumulated text.** The complete event has full text. UI must accumulate.

4. **Slash commands produce no `assistant_text`.** The UI must render its own displays from structured events (`system_metadata`, `cost_update`).

5. **Tool events interleave with concurrent calls.** Don't assume sequential tool_use → tool_result ordering across different tool_use_ids.

6. **Interactive terminal features (model picker, status display) have no stream-json equivalent.** The UI must build its own UI and send `model_change`, `permission_mode`, `session_command` messages directly.

7. **`system_metadata` is the slash command source.** Contains `slash_commands[]` (Claude Code built-ins) and `skills[]` (plugin-contributed). Both should be merged for the prompt input's slash command popup.

---

## Test 13: Session Command — New Session

**Sent:** `{ type: "session_command", command: "new" }` after initial handshake, then a user message.

**Event sequence:**
1. `session_init` — original session `05086f97...`
2. **>>> `session_command: new` sent**
3. `error` — `"Claude process stream ended unexpectedly"` (recoverable: true)
4. Tugcode respawns claude: `--permission-mode acceptEdits` (no `--resume` — fresh session)
5. `session_init` — new session, but `session_id: "pending"`
6. **>>> `user_message` sent** (too early!)
7. Timeout — new process not ready

**Findings:**
- **`session_command: "new"` kills the current claude process and spawns a new one.** The old stream ends, which produces a recoverable `error` event.
- **The new session emits `session_init` with `session_id: "pending"` before it's fully ready.** A second `session_init` with the real session ID presumably comes later, but the probe timed out before seeing it.
- **The UI must wait for `session_init` with a non-`"pending"` session_id before sending messages.** Sending too early causes the message to be lost.
- **This is a transport gap:** The readiness signal after a session command is unclear. The UI needs a definitive "new session ready" event.
- **Added to Phase 2 work list:** Session command readiness signaling.

---

## `AskUserQuestion` Flow (Documented from Code, Not Yet Tested Live)

From reading `tugcode/src/session.ts` and `tugcode/src/control.ts`:

When an agent calls `AskUserQuestion`, it arrives as `control_request_forward` with:
- `is_question: true`
- `tool_name: "AskUserQuestion"`
- `input` contains the question definitions (from the agent's `AskUserQuestion` tool call)

The UI responds with:
```json
{
  "type": "question_answer",
  "request_id": "the-request-id-from-control_request_forward",
  "answers": { "question_key": "selected answer" }
}
```

Tugcode translates this into a `control_response` with `behavior: "allow"` and the answers nested in `updatedInput.answers`. This hasn't been tested end-to-end yet — it would require running a `/plan` skill that triggers the clarifier agent.

---

## Updated Event Type Catalog (Final)

### Outbound Events (Tugcode → UI)

| Event | When | Key Fields | Response Required? |
|-------|------|-----------|-------------------|
| `protocol_ack` | After handshake | `version`, `session_id`, `ipc_version` | No |
| `session_init` | After claude spawns | `session_id` (may be `"pending"`) | No (but wait for non-pending before sending) |
| `system_metadata` | Start of every turn | tools, model, slash_commands, skills, plugins, agents, mcp_servers, version, permissionMode | No |
| `thinking_text` | Before response | `msg_id`, `seq`, `text` (delta), `is_partial`, `status` | No |
| `assistant_text` | During response | `msg_id`, `seq`, `text` (delta on partial, full on complete), `is_partial`, `status` | No |
| `tool_use` | Tool invoked | `msg_id`, `seq`, `tool_name`, `tool_use_id`, `input` | No |
| `tool_result` | Tool completed | `tool_use_id`, `output`, `is_error` | No |
| `tool_use_structured` | Tool completed | `tool_use_id`, `structured_result` (typed) | No |
| `control_request_forward` | Permission or question | `request_id`, `tool_name`, `input`, `decision_reason`, `is_question` | **YES** — `tool_approval` or `question_answer` |
| `cost_update` | Near end of turn | `total_cost_usd`, `num_turns` | No |
| `turn_complete` | End of turn | `msg_id`, `seq`, `result` (`"success"` or `"error"`) | No |
| `error` | Error occurred | `message`, `recoverable` | No |

### Inbound Messages (UI → Tugcode)

| Type | Purpose | Key Fields |
|------|---------|-----------|
| `protocol_init` | Handshake | `version: 1` |
| `user_message` | Send prompt | `text`, `attachments: []` |
| `tool_approval` | Answer permission | `request_id`, `decision: "allow"\|"deny"`, `updatedInput?`, `message?` |
| `question_answer` | Answer question | `request_id`, `answers: { key: value }` |
| `interrupt` | Stop turn | *(empty)* |
| `permission_mode` | Change mode | `mode` |
| `model_change` | Switch model | `model` |
| `session_command` | Session mgmt | `command: "fork"\|"continue"\|"new"` |
| `stop_task` | Stop a task | `task_id` |

---

## Key Architectural Insights for UI Design

1. **The UI is a state machine driven by outbound events.** Each event transitions the UI: idle → streaming (on first `assistant_text` partial), streaming → idle (on `turn_complete`), idle → awaiting-permission (on `control_request_forward`), etc.

2. **`system_metadata` populates the chrome.** Model name, slash commands, skills, permission mode, tool list — all come from this one event. The UI should cache it and update on each turn.

3. **Tool calls are observable.** `tool_use` → `tool_result` → `tool_use_structured` gives the UI everything it needs to show what tools Claude is using, with rich structured data for custom renderers.

4. **Permission and question UIs are the same gate.** One event type (`control_request_forward`), two response types. The `is_question` flag dispatches.

5. **Text accumulation is the UI's job.** Partials are deltas. The UI accumulates them into a buffer for rendering. The final `complete` event provides the full text for verification/replacement.

6. **Slash commands are passthrough.** Send as `user_message` text starting with `/`. Claude Code handles routing. No special handling needed on the UI side.

7. **Interactive commands need custom UI.** `/model`, `/status`, `/cost` produce no text. The UI must build pickers/displays and send `model_change`, etc. directly.

---

## Findings from Claude Code Documentation Research

Comprehensive review of code.claude.com docs. Key items that affect the transport and UI:

### Stream-JSON Event Types (from docs, not yet observed in probes)

- **`stream_event`** — wraps raw Anthropic API streaming deltas. Contains `.event.delta.type == "text_delta"` with `.event.delta.text` for token-by-token text. We haven't seen this in our probes — tugcode may be translating these into `assistant_text` events before forwarding.
- **`system` with `subtype: "api_retry"`** — emitted on retryable API errors. Fields: `attempt`, `max_retries`, `retry_delay_ms`, `error_status`, `error` (type: `authentication_failed`, `billing_error`, `rate_limit`, etc.). The UI should show retry status.
- **`system` with `subtype: "compact_boundary"`** — emitted during compaction. Contains `compactMetadata: { trigger: "auto"|"manual", preTokens }`.

### Permission Modes (affects tool approval flow)

| Mode | Auto-approved | Needs prompt |
|------|--------------|-------------|
| `default` | Read only | Everything else |
| `acceptEdits` | Read + edit files | Bash, WebFetch, etc. |
| `plan` | Read only (no edits) | Everything else |
| `auto` | All + classifier checks | Classifier-blocked actions |
| `bypassPermissions` | Everything | Nothing |
| `dontAsk` | Pre-approved only | Nothing (auto-deny rest) |

**Mode cycling:** `Shift+Tab` cycles `default` → `acceptEdits` → `plan` → `auto`. The UI should support this.

### Tools Requiring Permission (must render approval UI)

Bash, Edit, Write, NotebookEdit, ExitPlanMode, Skill, WebFetch, WebSearch, PowerShell

### Tools Auto-Approved (no prompt needed)

Agent, AskUserQuestion, CronCreate/Delete/List, EnterPlanMode, EnterWorktree, ExitWorktree, Glob, Grep, Read, TaskCreate/Get/List/Update/Stop, TodoWrite, ToolSearch

### Session Resume Behavior

- Full message history restored, tool state preserved
- **Session-scoped permissions are NOT restored** — must re-approve
- Model and config from original session preserved
- `--fork-session` creates new session ID but preserves history (original unchanged)
- Multiple terminals on same session: messages interleave, each sees only its own during session

### AskUserQuestion in Non-Interactive Mode

- In `-p` (print) mode: AskUserQuestion fails by default (no user)
- Can be handled via `PreToolUse` hook matching `AskUserQuestion` — return `permissionDecision: "allow"` with `updatedInput` containing `answers`
- **Background subagents auto-fail on AskUserQuestion** — only foreground subagents pass through to user
- This confirms our code reading: `control_request_forward` with `is_question: true` is the mechanism

### Compaction Details

- Auto at ~95% capacity (configurable via `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`)
- CLAUDE.md files survive (re-read from disk)
- **Skill descriptions do NOT survive compaction** — skills reload on next invocation
- Clears older tool outputs first, then summarizes conversation

### Context Window Load Order

1. System prompt (~4,200 tokens)
2. Auto memory MEMORY.md (~680 tokens)
3. Environment info (~280 tokens)
4. MCP tools deferred (~120 tokens)
5. Skill descriptions (~450 tokens) — NOT re-injected after compact
6. User CLAUDE.md files (~2,100 tokens)
7. User prompts and tool results

**~20% of window used at startup before any user interaction.** Important for token counting UI.

### Subagent Details

- Cannot spawn other subagents (no recursion)
- Background subagents get permissions pre-approved at spawn; auto-deny anything else
- Only summary text returns to parent context (not full file reads)
- Auto-compaction at ~95% capacity
- Configurable: model, tools, permissions, hooks, MCP servers, skills, memory, isolation, effort, background

### Plan Mode Workflow

Claude researches → presents plan → user chooses:
- (a) approve + auto mode
- (b) approve + acceptEdits
- (c) approve + manual review
- (d) keep planning

Each option can clear planning context. The UI should present these choices when plan mode is active.

---

## Phase 2 Work Items (Accumulated)

### Transport Fixes (tugcast/tugcode code changes)

1. **Process lifecycle management.** Tugcode processes outlive tugcast. 137 zombies after 2 weeks. Tugcast must SIGTERM children on shutdown and use process groups. Card close must kill associated tugcode.
2. **Session command readiness.** After `session_command: "new"` or `"fork"`, `session_init` fires with pending ID before new process is ready. Need clear readiness signal.
3. **`api_retry` event forwarding.** ✅ DONE — tugcode now forwards `subtype: "api_retry"` from `routeTopLevelEvent` as the `api_retry` IPC message. (Still worth auditing for other dropped `system` subtypes.) UI surfacing tracked separately as the dev-card `api_retry` banner.
4. **`--no-auth` CLI flag for tugcast.** Skip session cookie and origin validation for local development/testing. Needed to test the full WebSocket path.
5. **Slash command invocation mechanism.** ALL slash commands (both built-in and plugin) are consumed by Claude Code's client-side dispatcher with no stream-json output. This affects every command — `/cost`, `/model`, `/compact`, `/dash`, `/plan`, etc. The graphical UI needs a new inbound message type (e.g., `{ type: "slash_command", command, args }`) that tugcode routes to Claude Code's slash command handler, with output forwarded to the stream. This is the single biggest transport gap.
6. **`@` file reference handling.** Terminal injects file content client-side. Tugcode/tugcast need either: (a) a mechanism for the UI to send file content with messages, or (b) the UI handles this entirely client-side via attachments.

### UI Requirements (graphical UI must implement)

7. **Permission mode switcher.** Mode selector sending `permission_mode` messages. Cycle: default → acceptEdits → plan → auto.
8. **Session-scoped permissions reset on resume.** Handle re-approval after session resume.
9. **All terminal-only features** listed in the "Terminal-Only Features" section above — ~30 items across display, interaction, permissions, session, streaming, and content categories.

---

## Test 14: Message During Active Turn

**Sent:** "Write 200 words about the ocean", then mid-stream: "Stop. Just say 'INTERRUPTED'."

**Event sequence:**
1. First message starts streaming (14 text events, 543 chars)
2. **>>> second `user_message` sent after partial #2**
3. First response completes normally — `turn_complete #1 (success)`
4. `system_metadata` (new turn)
5. Second response streams — `turn_complete #2 (success)`

**Findings:**
- **Sending a message mid-stream does NOT interrupt.** The current turn completes fully, then the new message is processed as the next turn.
- **Messages are queued.** Claude Code processes them in order. The second message waits for `turn_complete` on the first.
- **To actually stop a turn, use `interrupt`.** A new `user_message` is not a cancellation mechanism.
- **The second response has full context** of both the first response and the second message.

---

## Test 15: `/btw` Side Question

**Sent:** `"/btw What is 2+2?"`

**Result:** `system_metadata` → `cost_update` → `turn_complete`. Zero text events.

**Finding:** `/btw` is a terminal-only feature. The ephemeral overlay, no-history-impact behavior has no stream-json representation. Like all interactive slash commands, the graphical UI must implement its own version if desired.

---

## Test 16: `model_change` Round-Trip

**Sequence:**
1. Ask "What model are you?" (Opus) → "I'm Claude Opus 4.6, made by Anthropic."
2. Send `{ type: "model_change", model: "claude-sonnet-4-6" }`
3. Receive synthetic `assistant_text` [COMPLETE]: `"Set model to claude-sonnet-4-6"`
4. Ask "What model are you?" (Sonnet) → "I'm Claude Sonnet 4.6, made by Anthropic."
5. `system_metadata` now shows `model: "claude-sonnet-4-6"`

**Findings:**
- **Model change is immediate.** Takes effect on the very next turn.
- **Produces a synthetic `assistant_text` event** confirming the change. Not from the model — instant, not streamed.
- **`system_metadata` updates** to reflect the new model.
- **Goes through control_request mechanism** internally (tugcode translates to `control_request` for Claude CLI).
- Model changed back to opus at end of test.

---

## Test 17: Session Resume (`session_command: "continue"`)

**Sequence:**
1. Send marker message: "Remember PROBE_MARKER_1774819234844" → "OK."
2. Send `{ type: "session_command", command: "continue" }`
3. `session_init` fires with `session_id: "pending-cont..."` (different from `"pending"` for new sessions)
4. Ask "What was the marker?" → "PROBE_MARKER_1774819234844" ← remembered!

**Findings:**
- **`continue` resumes in place.** No process kill, no `error` event. Seamless.
- **Context is fully preserved.** The marker was remembered across the continue command.
- **`session_init` with `"pending-cont..."` is safe to send to immediately** — unlike `"new"` which has a readiness gap.
- **Session command behavior differs by type:**

| Command | Process | `session_init` ID | Readiness | Context |
|---------|---------|-------------------|-----------|---------|
| `"new"` | Kill + respawn | `"pending"` → delayed real ID | **Gap — must wait** | Fresh |
| `"continue"` | In-place | `"pending-cont..."` | **Immediate** | Preserved |
| `"fork"` | Not tested | TBD | TBD | Preserved (copy) |

---

## Test 18: Message During Turn (detailed, from Test 14)

Documented above in Test 14.

---

## Test 19: `/compact` and `compact_boundary`

**Sent:** "Say 'one'" → turn_complete → "/compact"

**Result:** `/compact` behaves like other slash commands — `system_metadata` → `cost_update` → `turn_complete`. **No `compact_boundary` event observed.** Tugcode may filter these, or they only appear in raw Claude CLI stream-json, not in tugcode's translated output.

**Bonus finding — rich `cost_update`:** The cost event contains detailed token usage:
```json
{
  "total_cost_usd": 0.0736,
  "num_turns": 1,
  "duration_ms": 1912,
  "duration_api_ms": 1907,
  "usage": {
    "input_tokens": 3,
    "cache_creation_input_tokens": 11081,
    "cache_read_input_tokens": 8491,
    "output_tokens": 5,
    "server_tool_use": { "web_search_requests": 0, "web_fetch_requests": 0 },
    "service_tier": "..."
  }
}
```
This is everything a token counter/cost display needs.

---

## Test 20: Session Fork

**Sent:** `{ type: "session_command", command: "fork" }`

**Result:** Same pattern as `"new"` — kills process, `error` (recoverable), respawn, `session_init` with `"pending-fork"`. Readiness gap — message sent immediately was lost.

**Updated session command table:**

| Command | Process | `session_init` ID | Readiness | Context |
|---------|---------|-------------------|-----------|---------|
| `"new"` | Kill + respawn | `"pending"` | **Gap — must wait** | Fresh |
| `"continue"` | In-place | `"pending-cont..."` | **Immediate** | Preserved |
| `"fork"` | Kill + respawn | `"pending-fork"` | **Gap — must wait** | Preserved (copy) |

**Pattern:** Commands that respawn the claude process (`new`, `fork`) have a readiness gap. `continue` is in-place and immediate. The UI must detect the pending ID prefix and wait for the real session_init before sending messages.

---

## Terminal-Only Features — Graphical UI Must Implement

These features exist in the Claude Code terminal but produce **no events in stream-json mode**. The graphical UI must build its own versions. This is a significant body of work — each item needs design and implementation.

### Display / Status (no text output from slash commands)

| Terminal Feature | Slash Command | Data Source for UI | Priority |
|-----------------|---------------|-------------------|----------|
| **Cost display** | `/cost` | `cost_update` event (rich: tokens, USD, duration) | High |
| **Status display** | `/status` | `system_metadata` (model, tools, permissions, session) | High |
| **Context usage** | `/context` | `cost_update.usage` (input/output/cache tokens) + context window math | High |
| **Model display + picker** | `/model` | `system_metadata.model` + send `model_change` | High |
| **Permission mode display + switcher** | `/permissions` | `system_metadata.permissionMode` + send `permission_mode` | High |
| **Diff view** | `/diff` | Must run git diff ourselves or request via tool | Medium |
| **Export conversation** | `/export` | Must serialize from our own conversation state | Medium |
| **Copy last response** | `/copy` | Accumulate from `assistant_text` events | Medium |

### Interactive Features (terminal UI has no stream-json equivalent)

| Terminal Feature | Slash Command | What the UI Needs | Priority |
|-----------------|---------------|-------------------|----------|
| **Session picker** | `/resume` | List sessions, preview, rename, branch filter. Data from filesystem/API. | High |
| **Side question** | `/btw` | Ephemeral overlay, no history impact. Must implement own overlay + separate API call. | Medium |
| **Plan mode chooser** | `/plan` | Present approve/reject/keep-planning options after plan generation. | Medium |
| **Compact with focus** | `/compact [focus]` | Compaction indicator + optional focus text input. | Medium |
| **Session rename** | `/rename` | Text input, update session metadata. | Low |
| **Checkpoint rewind** | `/rewind` | **Resolved → [dev-card #step-7](tug-dev-card-claude-code-parity.md#step-7).** Two dimensions (see [`/rewind` empirical capture](#rewind-empirical-capture-2158)): **conversation** = truncate JSONL + `--resume` (no wire verb); **code** = [`rewind_files`](#rewind-files-control-request) control request. Summarize from/up to here = in-process compaction, no wire verb → **deferred**. Typed `/rewind` bounces. | Low |
| **Session fork/branch** | `/branch` | Fork current session, checkpoint management. (`/branch` likewise bounces in stream-json; unprobed.) | Low |
| **Color/theme picker** | `/color`, `/theme` | Custom UI for theme selection. | Low |
| **Vim mode toggle** | `/vim` | Keybinding mode switch for prompt input. | Low |

### `/rewind` empirical capture (claude 2.1.158) {#rewind-empirical-capture-2158}

Captured for dev-card parity Step 7a ([`tug-dev-card-claude-code-parity.md#step-7a`](tug-dev-card-claude-code-parity.md#step-7a), decision [D10]). This is the **final synthesis** of a multi-pass reverse-engineering of `/rewind` against `claude 2.1.158` — the typed-command bounce, the terminal-UI screenshots, and a series of live probes. Earlier partial conclusions (including a wrong "purely client-side, no wire protocol" first pass and a mistaken "conversation rewind is unreachable") are superseded; the resolved state is below. Pinned as `test-36-slash-rewind`.

#### The complete stdin input surface

Enumerated from the binary (not sampled) — this is the hard boundary for everything a stream-json client (tugcode) can ask claude to do:

- **5 message types:** `user`, `bash_command`, `control_request`, `assistant`, `system`. Anything else is logged `"Ignoring unknown message type"` and dropped.
- **43 `control_request` subtypes** — incl. `initialize`, `interrupt`, `set_model`, `set_permission_mode`, `can_use_tool`, `rename_session`, `get_context_usage`, `seed_read_state`, **`rewind_files`**, … The **only** rewind-relevant verb is `rewind_files`. There is **no** `rewind_conversation`, `compact`, or `summarize` control verb, and `initialize` accepts no client-supplied conversation history (`initialMessages` is populated internally from the resumed JSONL only).

A dev-card feature is reachable only if it maps onto this surface, *or* onto something tugcode can do to the local session files.

#### Architectural frame — in-process host ops vs. wire-exposed ops

`claude` is one binary in two modes. The **interactive TUI** is a single process holding *both* the UI and the agent core (message array, model loop, compaction), so its `/rewind` mutates the in-memory message array directly (`messages.slice(0, idx)`) and runs the compaction engine (`SXK`) on a slice — no wire, no message. **Bridge mode** (`--input-format stream-json`, what tugcode drives) is a headless agent core; tugcode is a *separate process* limited to the surface above. The TUI's in-memory operations have a wire equivalent only where Anthropic exposed one: they exposed the **file** half of rewind (`rewind_files` — file history lives in claude's process) but **not** the conversation-array slice or scoped compaction. This is why the four features split the way they do.

**Finding 1 — typed `/rewind` is not a wire verb.** Driven over stream-json as a `user_message`, `claude 2.1.158` bounces it with a *synthetic* turn — `assistant.model: "<synthetic>"`, `num_turns: 0`, `total_cost_usd: 0`, zero tokens — emitting `"/rewind isn't available in this environment."` Same terminal-rendered-locally class as `/permissions`, `/diff`, `/help`. The TUI's `/rewind` is a client-side picker; the typed string never reaches a handler. Pinned IPC sequence (10 events): `session_init · context_breakdown · session_capabilities · system_metadata · context_breakdown · content_block_start · assistant_text · cost_update · assistant_text · turn_complete`.

**Finding 2 — conversation rewind = JSONL truncation + `--resume` (PROVEN).** The transcript is a per-session JSONL at `~/.claude/projects/<slug>/<session-id>.jsonl` — a `parentUuid`-chained record log of user/assistant turns plus bookkeeping records (`queue-operation`, `last-prompt`, `mode`, `attachment`, `ai-title`). **The JSONL *is* the conversation:** the model API is stateless, so claude rebuilds context from this file each turn. To rewind to a turn, **truncate the file to that turn boundary (drop the tail records) and `--resume` the same `session_id`.** Verified live: a 3-turn session chopped to 2 turns resumed cleanly and recalled only the retained turns — no artifacts, no re-responses, nothing for claude to "detect" (there is no external ledger of what the conversation "should" be). **Constraints discovered:**
1. Cut at a clean turn boundary (before the target `user` record).
2. **Do not chop across a `/compact` boundary** — compaction rewrites the resume pointers, so chopping past it yields `"No conversation found"`. On disk a compaction shows as a `subtype:"compact_boundary"` system record and/or an `isCompactSummary:true` user record; refuse a rewind whose chop range (anchor → tip) contains either.
3. A **hand-authored / synthetic** transcript under a *new* session-id is rejected (`"No conversation found"`). **But a byte-for-byte COPY of a real registered session, written under a fresh session-id, IS resumable** (verified live 2026-05-31): `cp <sid>.jsonl <newid>.jsonl` (optionally tail-truncated) + `--resume <newid>` resumes cleanly and recalls only the copied turns. The earlier "new session-id ⇒ rejected" generalization was too broad — it's *fabricated* content that's rejected, not a new filename. This is what makes the dev-card's **forking** rewind ([#step-7-2]) work without `--fork-session`: copy the truncated history to a fresh id, resume it, leave the original intact. A near-empty copy (all conversation turns dropped, only leading bookkeeping records left) IS rejected — keep ≥1 retained turn.
4. **In stream-json mode claude emits no `system:init` (and `--fork-session` writes no fork file) until the first input.** So the fork's new id can't be learned passively at spawn — which is the second reason the dev-card mints its own id and copies rather than relying on `--fork-session`'s deferred materialization.

(The TUI does the in-memory equivalent: `messages.slice(0, rewindToMessageIndex)`, telemetry `tengu_conversation_rewind`.) Note: *adding* a fabricated `assistant` turn over the wire is accepted into context but claude detects it as pre-filled; *removing* tail records has no such tell. Rewind only removes.

**Finding 3 — code rewind = the `rewind_files` control request.** "Restore the code" is not blind filesystem work — claude snapshots files it edits via Edit/Write (*not* bash or manual edits — binary string: *"Rewinding does not affect files edited manually or via bash."*) into a per-session `fileHistory`, and exposes restore over a control request. Full protocol + live capture: [`#rewind-files-control-request`](#rewind-files-control-request). Reachable over the bridge once file checkpointing is enabled.

**Finding 4 — Summarize from/up to here = in-process compaction; NO wire verb (DEFERRED).** The two "Summarize" options run claude's **compaction engine** (`SXK`/`yXK`) over a message *slice* anchored at the picked turn (`direction:"from"|"up_to"`, optional `userContext`; `up_to` forks context), making a real model call and persisting an `is_compact_summary` user message with `summarize_metadata:{messagesSummarized, userContext, direction}`. This is an **in-process host op** — there is no scoped-compaction control verb, and the only wire summarization is the whole-conversation `/compact` user command (arg = `<optional custom summarization instructions>`, auto-chosen boundary; emits `compact_boundary` with `preserved_segment{head_uuid, anchor_uuid, tail_uuid}`). A client could only *approximate* scoped summarize via chop→`/compact`→re-append, whose final splice is unverified. **Decision (2026-05-30): Summarize is out of scope for the dev-card `/rewind`** ([#step-7]); revisit only if claude ships an anchored-compact control verb (the natural sibling of `rewind_files`).

**The terminal UX (from screenshots).** Step 1 — a picker listing the session's own user messages, each annotated with a per-turn diff stat (`+239 -25`, or "No code changes") and a `(current)` marker; only messages with a surviving checkpoint are code-restorable (the "how far back" limit). Step 2 — a confirm sheet whose options are conditional on `canRewind`: **Restore code and conversation · Restore conversation · Summarize from here · Summarize up to here · Never mind**. When a turn changed no code, only the conversation option appears ("The code will be unchanged").

**Implication for [#step-7] (`/rewind` sheet).** The dev-card ships **three of the four** wire-reachable features: diff-stat preview + code restore (`rewind_files{dry_run:true|false}`, requires `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true`, now set in `spawnClaude`), conversation restore (JSONL truncate + `--resume`), and cancel. Summarize is deferred (Finding 4). `/rewind` is **not** a `SessionPickerSheet` (sessions) consumer — it is a turns-within-this-session picker with a restore-options confirm form (its own `RewindSheet`).

### `rewind_files` control request (claude 2.1.158) {#rewind-files-control-request}

The code-restore half of `/rewind`. A **client → claude** control request (same direction as `interrupt` / `set_model`, the *opposite* of the `control_request_forward` tool gate). Grounded against the `2.1.158` binary (zod schemas) and a live round-trip; pinned in [`tugrust/crates/tugcast/tests/fixtures/control-requests/rewind-files.v2.1.158.json`](../tugrust/crates/tugcast/tests/fixtures/control-requests/rewind-files.v2.1.158.json).

**Request** (sent on claude's stdin):
```json
{ "type": "control_request", "request_id": "<string>",
  "request": { "subtype": "rewind_files", "user_message_id": "<uuid>", "dry_run": true } }
```
**Response** (on claude's stdout):
```json
{ "type": "control_response",
  "response": { "subtype": "success", "request_id": "<string>",
    "response": { "canRewind": true, "filesChanged": ["<path>"], "insertions": 0, "deletions": 1 } } }
```

- `user_message_id` — the uuid of the user message to rewind to the point **before**.
- `dry_run: true` → returns `{canRewind, filesChanged, insertions, deletions}` **without** applying (this is what populates the picker's diff stats and decides which confirm options show). `dry_run: false`/omitted → **applies** the restore (reverts the files on disk) and returns `{canRewind: true}`.
- Gating (the "how far back" limit): `{canRewind:false, error:"File rewinding is not enabled."}` when checkpointing is off; `{canRewind:false, error:"No file checkpoint found ..."}` for a message with no surviving snapshot.
- Enablement: default-on for the interactive terminal (`!CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING`); **opt-in** in SDK/stream-json mode via `CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true`. tugcode now sets this at spawn (`tugcode/src/session.ts spawnClaude`).
- A standalone CLI form also exists: `claude --rewind-files <user_message_id>` (requires `--resume`; rejects combination with a prompt).

**Live capture (2026-05-30).** Turn 1 had claude `Write` `note.txt` ("HELLO"); then `rewind_files{dry_run:true}` → `{canRewind:true, filesChanged:["…/note.txt"], insertions:0, deletions:1}`; then `rewind_files{dry_run:false}` → `{canRewind:true}` and `note.txt` was **deleted on disk**. Reproduction driver is recorded in the fixture's `_provenance` (spawn flags + stdin sequence).

**Not yet captured through tugcode.** The round-trip above was driven *directly* against claude. Surfacing it through tugcode (a `rewind_files` inbound IPC → claude control request → relay the `control_response` as an outbound IPC) is the first implementation task of [#step-7]; a probe-table entry that drives it end-to-end lands then.

### Permission and Approval UI

| Terminal Feature | Trigger | What the UI Needs | Priority |
|-----------------|---------|-------------------|----------|
| **Tool approval dialog** | `control_request_forward` (`is_question: false`) | Show tool name, input preview, reason. Allow/deny buttons. "Always allow" option per `permission_suggestions`. | Critical |
| **AskUserQuestion dialog** | `control_request_forward` (`is_question: true`) | Render questions with options, collect answers. Single-select and multi-select. | Critical |
| **Permission mode indicator** | `system_metadata.permissionMode` | Persistent indicator in chrome showing current mode. | High |

### Session Lifecycle UI

| Terminal Feature | Trigger | What the UI Needs | Priority |
|-----------------|---------|-------------------|----------|
| **New session** | `session_command: "new"` | Handle readiness gap (wait for non-pending `session_init`). Clear conversation. | High |
| **Resume session** | `session_command: "continue"` | Reload conversation history. Session picker. | High |
| **Fork session** | `session_command: "fork"` | Same readiness gap as new. Create branched conversation. | Medium |
| **Session name display** | `system_metadata` | Show session name in chrome. | Medium |

### Streaming and Response UI

| Terminal Feature | Trigger | What the UI Needs | Priority |
|-----------------|---------|-------------------|----------|
| **Streaming cursor/indicator** | `assistant_text` (partial) | Blinking cursor or spinner during streaming. | High |
| **Thinking/reasoning display** | `thinking_text` events | Collapsible thinking block (shows reasoning before response). | High |
| **Tool use display** | `tool_use` → `tool_result` → `tool_use_structured` | Rich tool call visualization: tool name, input, output, duration. | High |
| **Interrupt button** | Sends `interrupt` | Stop button during streaming. State: `turn_complete(result: "error")`. | High |
| **API retry indicator** | `system` (`subtype: "api_retry"`) | Show retry count, delay, error type during retries. | Medium |
| **Compaction indicator** | `compact_boundary` (if tugcode exposes it) | Show when context is being compacted. | Medium |
| **Cost per turn** | `cost_update` | Running cost display, updated per turn. | Medium |

### Content Features

| Terminal Feature | Mechanism | What the UI Needs | Priority |
|-----------------|-----------|-------------------|----------|
| **Image support** | `user_message.attachments` with `media_type: "image/*"` | Drag-drop, paste, file picker. Base64 encoding. Preview thumbnails. | Medium |
| **File attachment** | `user_message.attachments` | Text file content as attachment. | Medium |
| **Syntax-highlighted code blocks** | `assistant_text` with markdown code fences | tug-markdown renders these via Shiki/TugCodeBlock. | High (Phase 3) |
| **Copy code block** | Click-to-copy on code blocks | Copy button per code block. | High (Phase 3) |

---

## Test Summary (20 Tests Completed)

| # | Test | Key Finding |
|---|------|-------------|
| 1 | Basic round-trip | Works. `user_message` → streamed `assistant_text` → `turn_complete`. |
| 2 | Long streaming | Deltas, ~2 events/sec, ~90 chars/chunk. |
| 3 | `/cost` | No text. Structured `cost_update` only. |
| 4 | `/status` | No text. Data in `system_metadata`. |
| 5 | Tool use (Read) | `tool_use` → `tool_result` → `tool_use_structured` with rich typed data. |
| 6 | Interrupt | `turn_complete(result: "error")`. No `turn_cancelled`. |
| 7 | Multiple tools | Interleaved, concurrent. Different `tool_use_id` per call. |
| 8 | Permission denied | `control_request_forward` with `is_question: false`. |
| 9 | Bash tool | Auto-approved in acceptEdits. Rich `tool_use_structured`. |
| 10 | Long streaming (300w) | 24 partials, 13.4s, 2174 chars. |
| 11 | Permission deny round-trip | `tool_approval(deny)` → `tool_result(is_error: true)`. Works. |
| 12 | `/compact`, `/model` | No text output. |
| 13 | Session new | Kill/respawn. Readiness gap (`"pending"` session_id). |
| 14 | Message during turn | Queued, doesn't interrupt. Processed after `turn_complete`. |
| 15 | `/btw` | No text. Terminal-only. |
| 16 | Model change | Immediate. Synthetic confirmation text. `system_metadata` updates. |
| 17 | Session continue | In-place, immediate, context preserved. |
| 18 | (see 14) | — |
| 19 | `/compact` | No `compact_boundary`. Rich `cost_update` with token details. |
| 20 | Session fork | Kill/respawn. Readiness gap (`"pending-fork"`). Like `new`. |

---

## Test 21: Glob Tool (Auto-Approved, No Rich Structured Data)

**Sent:** "Use the Glob tool to find all .md files in the dash/ directory."

**Result:** `tool_use: Glob` → `tool_result` (file list as text) → `tool_use_structured` with `type: "unknown"`. Standard tool flow, auto-approved, no rich structured data (unlike Read/Bash which have typed structured results).

---

## Test 22: Subagent Spawn (Agent Tool)

**Sent:** "Use an Explore agent to find where TugConnection is defined."

**Event sequence:**
1. `tool_use: Agent` — partial, then complete with `{ description, prompt, subagent_type: "Explore" }`
2. `tool_use: Grep` — subagent's first search (different `tool_use_id`)
3. `tool_result` for Grep — "No files found"
4. `tool_use: Grep` — subagent's second search
5. `tool_result` for Grep — found `connection.ts:60`
6. `tool_use: Read` — subagent reads the file
7. `tool_result` for Read — file content
8. `tool_result` for Agent — subagent's final summary
9. `tool_use_structured` for Agent
10. `assistant_text` — parent's response

**Critical findings:**

- **Subagent tool calls are fully visible.** Every Grep, Read, Write, Bash the subagent uses appears as a normal `tool_use`/`tool_result` pair in the event stream.
- **No separate `SubagentStart`/`SubagentStop` events in CodeOutput.** Those are hooks-only. The transport shows subagent activity as nested tool use under the parent Agent `tool_use_id`.
- **The Agent `tool_use.input` contains `subagent_type`** — the UI can identify which agent type is running (Explore, Plan, general-purpose, or tugplug agents).
- **The Agent `tool_result` contains the subagent's summary text** — the final answer the subagent produced.
- **Subagent tool calls interleave with the Agent lifecycle.** Between `tool_use: Agent` and its `tool_result`, all the subagent's internal tool calls appear. The UI can bracket these by tracking the Agent's `tool_use_id`.

**Implication:** The graphical UI can show real-time subagent activity (which tools it's calling, what files it's reading) without any hook-based feed infrastructure. The CodeOutput stream already exposes everything. The hooks/feed system adds *semantic* context (plan step, workflow phase) but the raw activity is visible through the transport alone.

---

## Test 23: Image Attachment

**Sent:** `user_message` with a 1x1 PNG attached:
```json
{
  "type": "user_message",
  "text": "I'm attaching a tiny image. What can you see?",
  "attachments": [{
    "filename": "test-pixel.png",
    "content": "<base64>",
    "media_type": "image/png"
  }]
}
```

**Result:** Claude sees the image and describes it: "It's a tiny solid yellow square." Thinking text shows reasoning about the image. Normal `assistant_text` streaming for the response.

**Findings:**
- **Image attachments work through the transport.** Base64-encoded image in `attachments[]` with `media_type: "image/png"`.
- **No special event types** — the image is part of the `user_message`, not a separate event. Response arrives as normal `assistant_text`.
- **Supported types** (from tugcode code): `image/png`, `image/jpeg`, `image/gif`, `image/webp`. Max ~5MB decoded.
- **UI needs:** Drag-drop/paste → base64 encode → attach to `user_message`. Show thumbnail preview before send.

---

## Updated Test Summary (23 Tests)

| # | Test | Key Finding |
|---|------|-------------|
| 1 | Basic round-trip | Works |
| 2 | Long streaming | Deltas, ~2 events/sec |
| 3 | `/cost` | No text, structured data only |
| 4 | `/status` | No text |
| 5 | Tool use (Read) | `tool_use` → `tool_result` → `tool_use_structured` |
| 6 | Interrupt | `turn_complete(result: "error")` |
| 7 | Multiple tools | Interleaved, concurrent |
| 8 | Permission denied | `control_request_forward` |
| 9 | Bash tool | Auto-approved, rich structured result |
| 10 | Long streaming (300w) | 24 partials, 13.4s |
| 11 | Permission deny round-trip | Works |
| 12 | `/compact`, `/model` | No text output |
| 13 | Session new | Kill/respawn, readiness gap |
| 14 | Message during turn | Queued, doesn't interrupt |
| 15 | `/btw` | No text, terminal-only |
| 16 | Model change | Immediate, synthetic confirmation |
| 17 | Session continue | In-place, immediate, preserved |
| 19 | `/compact` | No `compact_boundary`, rich `cost_update` |
| 20 | Session fork | Kill/respawn, readiness gap |
| 21 | Glob tool | Auto-approved, no rich structured data |
| 22 | Subagent spawn | **All subagent tool calls visible in stream** |
| 23 | Image attachment | Works via base64 in `attachments[]` |

---

## Test 24: `@` File References

**Sent:** `"What's in @CLAUDE.md?"` and `"What's in @tugdeck/package.json?"`

**Result:** Claude answered correctly in both cases, but **no Read tool call was made**. It answered from session context (CLAUDE.md is loaded as instructions; package.json was read earlier in the session).

**Critical finding: `@` file completion is entirely a terminal-side feature.**
- In the terminal, `@` triggers a file picker; the client reads the file and injects the content into the message before sending.
- In stream-json mode via `user_message`, `@CLAUDE.md` is just literal text — no file injection occurs.
- **The graphical UI must implement its own `@` completion:** detect `@` in the prompt input, show a fuzzy file finder popup, and on selection either inject file content into the message text or add it as a text attachment.

**Added to Terminal-Only Features list.**

---

## Test 25: Tugplug Skill Invocation (`/plan`)

**Sent:** `"/plan Add a --no-auth flag to tugcast..."` as a `user_message`

**Result:** Completed instantly with zero events — same pattern as `/cost`, `/status`. The slash command was consumed by Claude Code's client-side dispatcher and produced no output in stream-json mode.

**Then sent:** `"Invoke the /plan skill to plan this idea: Add a --no-auth flag to tugcast"` (natural language, not slash)

**Result:** Claude tried to use the `Skill` tool:
```
tool_use: Skill → input: { skill: "plan", args: "..." }
tool_result: error → "Skill plan is not a prompt-based skill"
```

Claude then pivoted to `EnterPlanMode` and spawned two Explore agents that read ~10 files over 70+ seconds. All subagent tool calls visible in the stream.

**Critical findings:**

1. **Tugplug skills (`/plan`, `/implement`, `/merge`, `/dash`) cannot be invoked via `user_message`.** The `/plan` slash command is consumed client-side with no stream-json output. The `Skill` tool rejects it as "not a prompt-based skill."

2. **This is a fundamental gap for the graphical UI.** These are the most important tugplug commands and they don't work through the transport. The UI needs a different invocation mechanism — either:
   - (a) A new inbound message type (e.g., `{ type: "skill_invoke", skill: "plan", args: "..." }`) that tugcode handles specially
   - (b) Changing tugplug skill definitions to be invocable via the Skill tool
   - (c) Having the UI spawn a separate Claude Code process for skill execution

3. **`EnterPlanMode` IS a tool that works.** It enters Claude's built-in plan mode (research → design → present plan → user approves). This is Claude Code's native planning, NOT tugplug's orchestrated planning with clarifier/author/conformance/critic agents.

4. **Long-running interactions need progress UI.** The plan exploration ran 70+ seconds with continuous tool calls. The UI must show activity during this.

**Added to Phase 2 work list: Skill invocation mechanism for graphical UI.**

---

## `api_retry` — Forwarding RESOLVED (UI pending)

> **Update (2026-06-01): the forwarding gap below is CLOSED.** Tugcode's
> `routeTopLevelEvent` now routes `subtype: "api_retry"` to an `api_retry` IPC
> message (`session.ts`), the `ApiRetry` type is defined and in the outbound union
> (`tugcode/src/types.ts`), and tugcast relays CODE_OUTPUT generically. What
> remains is **tugdeck-side rendering only** — the dev-card `api_retry` banner
> (decode → reducer snapshot state → banner spec → DOM-ticked countdown),
> distinguishing transient (`rate_limit`/`overloaded`/5xx) from likely-fatal
> (`authentication_failed`/`billing_error`) categories. Tracked as the dev-card
> parity `api_retry` banner step. The original finding is preserved below for the
> record.

**Original finding (HISTORICAL — now resolved).** Tugcode dropped `api_retry`
events. Verified at the time by reading `session.ts` `routeTopLevelEvent`:

The `system` event handler only routed two subtypes:
- `subtype: "init"` → `session_init`
- `subtype: "compact_boundary"` → `compact_boundary`

All other `system` subtypes — including `api_retry` — fell through with no output, so the UI saw nothing during rate limits or API errors.

**Impact (at the time):** during API failures, the user saw a spinner with no explanation. No retry count, no delay indicator, no error type.

**Fix (since landed):** `api_retry` forwarding in tugcode's `routeTopLevelEvent`:
```typescript
} else if (subtype === "api_retry") {
  messages.push({
    type: "api_retry",
    attempt: event.attempt,
    max_retries: event.max_retries,
    retry_delay_ms: event.retry_delay_ms,
    error_status: event.error_status,
    error: event.error,
    ipc_version: 2,
  });
}
```

Still worth auditing for other dropped `system` subtypes we might care about.

---

## Auth Bypass — What We'd Learn

Testing through tugcast WebSocket would reveal:
- **Binary framing correctness.** Does the `[FeedId][length][payload]` encoding/decoding work round-trip for conversation events?
- **Feed multiplexing.** How do conversation events interleave with terminal, git, filesystem, stats feeds?
- **Reconnection behavior.** What happens when the WebSocket drops and reconnects mid-conversation? Does bootstrap replay conversation state?
- **Bootstrap content.** What's in the initial snapshot for the CodeOutput feed? Last N events? Full history?
- **Lag detection.** If the client falls behind on CodeOutput frames, does it re-enter bootstrap state?
- **Multiple clients.** Can two browser tabs connect to the same tugcast and see the same conversation?

**Action item:** Add `--no-auth` CLI flag to tugcast. Small change: when flag is set, `validate_request_session` and `check_request_origin` return `true` unconditionally.

---

## Test 26: `/dash` and `/tugplug:dash` Skill Invocation

**Sent:** `"/dash test-probe say hello world"` as `user_message`
**Then:** `"/tugplug:dash test-probe say hello world"` (fully-qualified name)

**Result:** Both produce instant completion, zero events. The fully-qualified name doesn't help.

**Critical finding: ALL slash commands are consumed by Claude Code's client-side dispatcher, regardless of qualification.** The dispatch happens before stream-json processing. `/dash`, `/tugplug:dash`, `/cost`, `/plan` — all identical: consumed internally, no events in the stream.

In the terminal, `/dash` shows output (agent spawning, progress, results) because the terminal renders output from the same process. In stream-json mode, the slash command handler runs the skill internally, but no events flow to the stream output.

**This means slash commands are fundamentally a terminal input mechanism with no stream-json equivalent.** Stream-json is for `user_message` → Claude API → streamed response. Slash commands bypass Claude entirely and are handled by the harness.

**Implication for the graphical UI:** Cannot invoke ANY slash command (built-in or plugin) via the `user_message` transport. The UI needs a completely different invocation mechanism.

---

## Deep Dive: How Slash Command Output Actually Works in Tugcode

**Discovered by reading `session.ts` `routeTopLevelEvent`.**

Claude Code's slash command mechanism works like this:

1. Text starting with `/` is sent to Claude's stdin as a normal `user` message.
2. Claude Code's harness intercepts it as a slash command and processes it internally — the model never sees it.
3. For simple commands (`/cost`, `/status`), Claude Code emits a `result` event containing the formatted output text.
4. **Then, on session replay**, Claude Code emits a `{ type: "user", isReplay: true, message: { content: "<local-command-stdout>...</local-command-stdout>" } }` event.
5. Tugcode's `case "user"` handler (lines 318-347) detects `isReplay === true`, extracts `<local-command-stdout>` content, and emits it as `assistant_text`.

**This explains our Test 3 (`/cost`):** We saw `cost_update` (from the `result` event) + `turn_complete`, but no `assistant_text` with the formatted cost text. The text only appears on **replay** (session resume), not on first execution.

**Critical question for orchestrator skills (`/dash`, `/plan`):** When these run, they spawn agents, make tool calls, produce progress output. Does this output go through `<local-command-stdout>` on replay? Or does the orchestrator's output come as normal streaming events (`tool_use`, `assistant_text`, `control_request`)? If the latter, tugcode should already be forwarding those events — but our tests showed zero events.

**Possible explanations for why orchestrator skills produce zero events:**
1. The orchestrator skill runs in a **separate execution context** whose stdout isn't connected to the stream-json pipe.
2. The skill output goes through the `<local-command-stdout>` mechanism but the tags are only emitted on replay, and we never resumed the session after running the skill.
3. The skill errored silently and produced no output.
4. There's a skill invocation pathway we haven't found.

---

## RESOLVED: Slash Command Mystery

**Root cause: `--plugin-dir` was pointing to the wrong directory.**

Tugcode's `getTugtoolRoot()` resolves to the project root (`/u/src/tugtool`), which finds the root-level `.claude-plugin/plugin.json` (name: `tugtool`). But the tugplug skills live under `tugplug/skills/`, and the `tugplug` plugin definition is at `tugplug/.claude-plugin/plugin.json`. The root-level plugin doesn't expose the skills.

**Fix:** Point `--plugin-dir` to `tugplug/` instead of the project root.

**Test 29: `/tugplug:ping` with correct `--plugin-dir`**

With `--plugin-dir /u/src/tugtool/tugplug`:

```
system:init → skills includes: tugplug:ping, tugplug:plan, tugplug:merge, tugplug:dash, tugplug:implement
stream:text_delta → "**pong** — 2026-03-29T00:00:00Z"
USER [isReplay=true] → <command-name>/tugplug:ping</command-name>
RESULT → success
```

**All tugplug skills are visible and invocable.**

**Test 30: `/tugplug:dash status` with correct `--plugin-dir`**

Full orchestrator skill output visible:

```
THINKING → "The user is running /tugplug:dash status..."
USER [isReplay=true] → <command-name>/tugplug:dash</command-name><command-args>status</command-args>
ASSISTANT_TOOL: Bash → tugcode dash list
tool_result → JSON with dash list
TEXT → "No active dashes."
RESULT → success (44 events, 5.2s)
```

**The entire orchestrator execution is visible in the stream.** Thinking, tool calls (Bash), tool results, and the final text response — all flowing through the same event stream we've been testing.

**What this means:**
1. **Slash commands DO work through stream-json** — they produce full event streams including tool calls, streaming text, and result events.
2. **The problem was never the protocol** — it was a misconfigured `--plugin-dir` that prevented the plugin from loading.
3. **tugcode needs a fix:** `getTugtoolRoot()` must resolve to `tugplug/` (or the root plugin must properly reference the tugplug skills). This is a one-line fix in tugcode.
4. **The graphical UI sends `/tugplug:dash args` as a normal `user_message`** and it just works. No special invocation mechanism needed.

**Phase 2 work items:**
- **Item #5 updated:** "fix `--plugin-dir` in tugcode to point to `tugplug/`" — one-line fix.
- **New item:** Tugcode's `case "assistant"` handler drops text from synthetic messages (`model: "<synthetic>"`). Built-in skill commands like `/cost` and `/compact` produce their text output as an `assistant` message with `model: "<synthetic>"`, but tugcode skips all `assistant` text assuming it was already delivered via `stream_event`. Fix: detect `model === "<synthetic>"` and emit the text as `assistant_text`.

---

## Test 31-33: Built-In Command Classification (Fresh Probe)

With the correct `--plugin-dir`, testing built-in commands directly against Claude CLI:

| Command | Raw CLI Output | Category |
|---------|---------------|----------|
| `/cost` | `assistant` text: "Total cost: $0.00..." + `result` | **Skill** (text available but tugcode drops it) |
| `/compact` | `assistant` text: "Error: No messages to compact" + `result` | **Skill** (text available but tugcode drops it) |
| `/status` | `result`: "Unknown skill: status" | **Terminal-only** (not a skill) |
| `/model` | `result`: "Unknown skill: model" | **Terminal-only** (not a skill) |

**Three categories of `/` commands:**

| Category | In `system_metadata.slash_commands`? | Stream-JSON? | Text? |
|----------|--------------------------------------|-------------|-------|
| **Skills** (`/cost`, `/compact`, `/commit`, `/review`, `/tugplug:dash`, etc.) | Yes | Full events | Yes (needs tugcode fix for synthetic messages) |
| **Terminal-only** (`/status`, `/model`, `/clear`, `/vim`, `/btw`, `/resume`, etc.) | No | "Unknown skill" | No — must be reimplemented in UI |
| **Name collision** (`/plan` = built-in terminal command AND `tugplug:plan` skill) | `tugplug:plan` is in skills list | Use fully-qualified `tugplug:plan` | Yes |

**No more mystery.** The entire slash command landscape is mapped.

---

## Test 27: `@` File References (Tests 24a, 24b)

See Test 24 above. Confirmed terminal-only.

---

## Test 28: `system_metadata` Deep Dive — Plugin Skill Visibility

**Full `system_metadata` dump reveals:**

| Field | Contents | Notable |
|-------|----------|---------|
| `slash_commands` (18) | `update-config`, `debug`, `simplify`, `batch`, `loop`, `schedule`, `claude-api`, `commit`, `compact`, `context`, `cost`, `heapdump`, `init`, `pr-comments`, `release-notes`, `review`, `security-review`, `insights` | **Tugplug skills (`dash`, `plan`, `implement`, `merge`) are MISSING** |
| `skills` (8) | `update-config`, `debug`, `simplify`, `batch`, `loop`, `schedule`, `claude-api`, `commit` | Subset of `slash_commands` |
| `agents` (5) | `general-purpose`, `statusline-setup`, `Explore`, `Plan`, `claude-code-guide` | **Tugplug's 12 agents are MISSING** |
| `plugins` (1) | `{ name: "tugtool", path: "...", source: "tugtool@inline" }` | Plugin IS loaded |

**Root cause investigation:**

The `commit` skill lives in `.claude/skills/commit/SKILL.md` (project-level) — it's a **prompt-based skill** (markdown body that becomes Claude's instructions, `disable-model-invocation: true`). These appear in `system_metadata`.

The tugplug skills (`dash`, `plan`, `implement`, `merge`) live in `tugplug/skills/*/SKILL.md` — they're **orchestrator skills** (have `allowed-tools` restrictions, hooks, use `Task` tool for agent dispatch). These do NOT appear in `system_metadata`.

**This is a two-tier skill system:**

| Skill Type | Example | `allowed-tools`? | In `system_metadata`? | Invocable via Skill tool? | `/` dispatch? |
|-----------|---------|-------------------|----------------------|--------------------------|---------------|
| Prompt-based | `commit`, `review` | No | Yes | Yes | Yes (terminal) |
| Orchestrator | `dash`, `plan`, `implement` | Yes | **No** | **No** ("not a prompt-based skill") | Yes (terminal only?) |

**Critical implication:** Orchestrator skills are invisible to the stream-json protocol. They're dispatched by the terminal's `/` handler but have no programmatic invocation path. The graphical UI cannot invoke `/dash` or `/plan` through the transport.

---

## Hooks — Unexplored Dimension

Hooks fire during tool execution and can modify behavior. We haven't explored:

1. **Do hook-produced events appear in the CodeOutput stream?** When a `PreToolUse` hook modifies tool input or blocks a tool, does any event indicate this to the UI?
2. **Hook-injected context** — hooks can return `additionalContext` that's added to the conversation. Does this show up as a visible event?
3. **The `Notification` hook event** fires for `permission_prompt`, `idle_prompt`, `auth_success`, `elicitation_dialog`. Are any of these surfaced in CodeOutput?
4. **Tugplug's auto-approval hooks** — when `auto-approve-tug.sh` allows a tool, does the UI see any indication that a hook (not the user) approved it?
5. **Hook execution time** — blocking hooks can delay tool execution. Does the UI see a delay between `tool_use` and `tool_result` with no indication of why?

**This matters because:** The graphical UI might need to show hook activity (which hook ran, what it decided, how long it took). Without this, hooks are invisible to the user — tools just take longer or behave differently with no explanation.

---

## Plugin System — Open Questions

1. **How does the terminal's `/` handler know about orchestrator skills?** It must read plugin `SKILL.md` files directly, separate from what Claude Code reports in `system_metadata`.
2. **Can we enumerate all available skills (both types) programmatically?** The UI needs a complete list for the slash command popup.
3. **Is there an API to invoke an orchestrator skill?** The CLI presumably has one since the terminal can do it. Maybe a specific CLI flag or IPC mechanism.
4. **Plugin hot-reload** — if we modify a tugplug skill, does the running session pick it up? Or does it need a restart?
5. **Plugin hooks registration** — when do `hooks.json` entries take effect? At session start? Per-turn?

---

## Test 34: Plugin Agent Enumeration (Correct `--plugin-dir`)

**Dumped full `system_metadata` with `--plugin-dir tugplug/`:**

```
agents: [
  "general-purpose", "statusline-setup", "Explore", "Plan", "claude-code-guide",
  "tugplug:overviewer-agent", "tugplug:author-agent", "tugplug:committer-agent",
  "tugplug:reviewer-agent", "tugplug:dash-agent", "tugplug:architect-agent",
  "tugplug:integrator-agent", "tugplug:coder-agent", "tugplug:critic-agent",
  "tugplug:conformance-agent", "tugplug:auditor-agent", "tugplug:clarifier-agent"
]
skills: [... 8 built-in + tugplug:merge, tugplug:dash, tugplug:plan, tugplug:implement]
plugins: [{ name: "tugplug", path: ".../tugplug", source: "tugplug@inline" }]
```

**Finding:** All 12 tugplug agents + 4 skills visible with correct `--plugin-dir`. The T1 fix resolves all plugin visibility issues.

---

## Test 35: Live `/tugplug:plan` — AskUserQuestion Flow

**Sent:** `"/tugplug:plan Add a --no-auth flag to tugcast for development testing"` with correct `--plugin-dir`

**Event sequence (322 events over 48s):**
1. `system:init` with all tugplug skills visible
2. Orchestrator text: "**Plan** — Starting new plan from idea"
3. `Agent` tool spawns clarifier → `system:task_started` event
4. Clarifier reads codebase: Glob, Grep, Read tool calls all visible via `system:task_progress`
5. Clarifier completes → `system:task_completed`
6. Orchestrator processes clarifier result
7. `AskUserQuestion` tool call → **`control_request`** with questions:
   - "When --no-auth is active, which security checks should be bypassed?"
   - Options: "Session cookie + origin check", ...
8. Probe timed out (didn't answer)

**New event types discovered:**

| Event | When | Key Fields |
|-------|------|-----------|
| `system:task_started` | Agent spawned | `task_id`, `tool_use_id`, `description`, `task_type` |
| `system:task_progress` | Agent working | `task_id`, `description` (current tool), `usage` (token count) |
| `system:task_completed` | Agent done | `task_id` |

**AskUserQuestion confirmed:** Arrives as `control_request` with `subtype: "can_use_tool"`, `tool_name: "AskUserQuestion"`, `input.questions[]` with `question`, `header`, `options[]`. Tugcode would forward this as `control_request_forward` with `is_question: true`. The UI responds with `question_answer`.

---

## Phase 1 Complete

35 tests completed. All major interaction patterns verified. All findings captured in [tug-conversation.md](tug-conversation.md) action items (T1-T6, U1-U23, C1-C15, E1-E6).

**Deferred to Phase 2 (blocked on transport fixes):**
- End-to-end tugcast WebSocket testing (needs T6 `--no-auth`)
- Hook visibility investigation (E3 — open but non-blocking)
- Background tasks, MCP, elicitation (E6 — open but non-blocking)

---

## `/permissions` rules — read/write/apply capture (dev-card parity [#step-1-5])

Empirical spec for the `/permissions` **rules editor** ([#step-1-6]) — distinct from the permission **mode** chip ([#step-1]). Captured from: the terminal `/permissions` UI (all six tabs), the real on-disk settings files in this repo, and the official Claude Code settings docs (`code.claude.com/docs/en/settings`).

### UI surface (terminal `/permissions`)

Tab bar, left→right: **Permissions · Recently denied · Allow · Ask · Deny · Workspace**. `←/→` switch, `↓` select, `Esc` cancel.

| Tab | Description copy | Body |
|-----|------------------|------|
| Recently denied | "No recent denials. Commands denied by the auto mode classifier will appear here." | runtime list (empty when none) |
| Allow | "Claude Code won't ask before using allowed tools." | Search box + `1. Add a new rule…` + numbered existing rules |
| Ask | "Claude Code will always ask for confirmation before using these tools." | Search box + `Add a new rule…` |
| Deny | "Claude Code will always reject requests to use denied tools." | Search box + `Add a new rule…` |
| Workspace | "Claude Code can read files in the workspace, and make edits when auto-accept edits is on." | original cwd (read-only) + `Add directory…` |

### On-disk shape (confirmed against this repo's `.claude/settings.local.json`)

```jsonc
"permissions": {
  "allow": [ "Bash(./tugcode/target/debug/tugcode init:*)", "Skill(dash)", "WebFetch(domain:docs.claude.com)", "Read(//tmp/**)", "WebSearch", ... ],
  "ask":   [ ... ],          // absent here → Ask tab empty
  "deny":  [ ... ],          // absent here → Deny tab empty
  "additionalDirectories": [ ... ],   // the Workspace tab; absent here → only the read-only cwd shows
  "defaultMode": "default"   // the *mode* (Step 1), NOT a rule — lives in the same object
}
```

- **Allow-tab list maps 1:1 (same order) to `permissions.allow`.** The numbered terminal rows are exactly the array entries; `1. Add a new rule…` is a UI affordance, not data.
- **Matcher grammar:** `Tool` (bare, e.g. `WebSearch`) or `Tool(specifier)`. Observed specifiers: `Bash(<cmd>:*)` (prefix match, `:*` wildcard tail), `Read(//abs/path/**)` (glob), `WebFetch(domain:<host>)`, `Skill(<name>)`. Per docs the canonical form is `Tool(npm run *)` / `Read(./.env)` — the `:*` and `//…` forms are how this repo's rules happen to be written.

### Scopes & precedence (docs)

| Scope | File | Shared | Notes |
|-------|------|--------|-------|
| User | `~/.claude/settings.json` | no | this repo: has general settings, **no `permissions` block** |
| Project | `.claude/settings.json` | yes (git-committed) | this repo: **absent** |
| Local | `.claude/settings.local.json` | no (gitignored) | **this repo's rules live here** |
| Managed | system/MDM | yes (admin) | cannot be overridden |

Precedence high→low: **Managed > CLI args > Local > Project > User.** Rules **merge across scopes (union), not override.** → the dev-card editor must read the union and be scope-aware on write.

### Recently-denied source

Runtime, **not persisted to settings.json**. UI copy: denials from the **auto-mode classifier**. Cross-checks with the `control_request_forward` (`is_question:false`) deny decisions the dev card already sees on the wire ([#step-15]). → 1.6 sources this tab from a session-local deny log, with per-row "add to Allow/Ask/Deny".

### Apply semantics — **LIVE (no respawn)**

Docs (`code.claude.com/docs/en/settings`): *"Claude Code watches your settings files and reloads them when they change, so edits to most keys apply to the running session without a restart. This includes `permissions`, `hooks`, and credential helpers… The reload covers user, project, local, and managed settings, and the `ConfigChange` hook fires for each detected change."*

→ **[#step-1-6] writes-and-continues**: write the settings file via tugcast filesystem, the running claude reloads `permissions` automatically. No respawn, no confirmation-to-restart flow.

> **Confirm-at-1.6-start caveat:** the docs describe Claude Code generally; the process tugcode spawns runs in **print / stream-json** mode. Same binary, so the file watcher almost certainly runs there too — but this is the one claim not yet verified *in our spawn context*. Cheap check when 1.6 starts: write a `deny` rule into `settings.local.json` mid-session and confirm the next matching tool call is blocked without respawning tugcode's claude. If (unexpectedly) print-mode doesn't watch, 1.6 falls back to write-then-respawn.

### Read path for the dev card

Purely **filesystem** — none of the rules data comes over stream-json (`system/init` carries tools + permission *mode*, not the allow/ask/deny rules). → dev-card route is a **tugcast filesystem read/write of the settings files, scope-aware**, as [#step-1-6] hypothesized.

### Default write scope for "Add a new rule"

Docs don't state it. The terminal add-rule flow presents a scope picker (Local/Project/User); Local is the natural default (gitignored, personal). → 1.6 offers a scope choice on add, defaulting to **Local** (`.claude/settings.local.json`). Not blocking; refine if the terminal picker's default proves otherwise.

---

## `/permissions` "Recently denied" — denial wire signal (probe)

Probe to answer: how does a denied tool call surface over stream-json, so the dev-card Recently-denied tab can be sourced? Setup: throwaway repo `/tmp/tug-perm-probe.*`, `claude` spawned with the tugcode flags (bidirectional `stream-json`, `--permission-prompt-tool stdio`, `--verbose`), **no `--plugin-dir`** so tugplug's `auto-approve-tug.sh` hook doesn't pre-empt the decision.

### Finding — denials ride the `result` event's `permission_denials[]`

A turn whose tool call was denied emits, on its terminal `result` event:

```jsonc
"permission_denials": [
  { "tool_name": "Bash",
    "tool_use_id": "toolu_…",
    "tool_input": { "command": "curl -s https://example.com", "description": "…" } }
]
```

An undenied turn carries `"permission_denials": []`. Captured via a `deny` rule (`Bash(curl:*)`) in `default` mode — rules resolve **before** the classifier, so this is classifier-independent and reproducible. The denied tool also surfaces to the model as an error `tool_result` (the model then continues in prose); the structured signal for UI is the `result.permission_denials` array.

### tugcode already parses it — but drops it at the IPC boundary

`session.ts` stores `event.permission_denials` into `resultMetadata.permission_denials` (typed in `protocol-types.ts`, covered by `session.test.ts`). BUT the `CostUpdate` IPC frame (`types.ts` `interface CostUpdate`) does **not** include the field — so tugcast/tugdeck never receive it today. (Grep: `permission_denials` appears only in tugcode, nowhere in tugcast/tugdeck.)

### Dev-card Recently-denied plan (ties to [#step-15])

1. Add `permission_denials` to the `CostUpdate` frame (data already in hand at tugcode) — tugcode rebuild (no HMR).
2. tugcast passes it through; tugdeck accumulates denials per-session in a store that feeds the Recently-denied tab.
3. Each row = `tool_name` + `tool_input`; "add to Allow/Ask/Deny" derives a matcher (e.g. `Bash(curl:*)`) and writes via the `/api/permissions` endpoint already built.

### Auto-mode-classifier variant — NOT yet confirmed

Auto mode IS enabled for this account (`system:init` → `permissionMode:"auto"`, model `claude-opus-4-8[1m]`), but during the probe the classifier model was in a **transient outage** ("…temporarily unavailable, so auto mode cannot determine the safety of Bash right now"), so a true *classifier* denial couldn't be forced — every classifier-gated action returned the outage message instead of a deny. The classifier denial uses the same `permission_denials` channel; **re-probe when the classifier recovers** to confirm whether it adds a `reason`/`message` beyond `{tool_name, tool_use_id, tool_input}`. (Probe dir + scripts kept at `/tmp/tug-perm-probe.klH6Ir/` for the rerun.)
