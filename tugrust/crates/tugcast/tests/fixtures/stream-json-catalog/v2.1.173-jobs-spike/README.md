# Spike captures — background-job lifecycle, raw `claude` stream-json

Raw upstream `claude` stream-json captures (unnormalized, single-run, no schema)
taken to pin the background-job wire shapes for the Z2 JOBS cell
(`dash/jobs-tracking.md`). Same conventions as `../v2.1.150-spike/`: these are
the **raw claude layer**, not the post-tugcode/post-tugcast layer the proper
version directories hold. If a capture proves load-bearing for an ongoing drift
test, promote it through the probe-table runbook in `../README.md`.

## Files

| File | Captured | Notes |
|------|----------|-------|
| `test-jobs-lifecycle-raw.jsonl` | `claude 2.1.173`, 2026-06-11 | One 276-line persistent session (`--input-format stream-json --output-format stream-json --verbose --include-partial-messages --replay-user-messages --permission-mode bypassPermissions` — tugcode's exact spawn args) walking six background-job phases. Produced by `probes/probe-jobs-lifecycle.mjs`. Phase map below. |
| `test-monitor-lifecycle-raw.jsonl` | `claude 2.1.173`, 2026-06-11 | One 150-line persistent session (same spawn args) walking three Monitor phases via `probes/probe-monitor-lifecycle.mjs`: M1 two events then natural exit (`b45wg0dww`), M2 timeout kill (`b68lbmhxr`), M3 persistent watcher stopped via a `stop_task` control request (`be0zn8grq`). **Key finding:** mid-life monitor events wake claude via `system/init` re-inits (the scheduled-wake mechanism — task-id-less; tugcode forwards them as synthetic `wake_started{task_id:""}`), NOT via `task_notification`. A monitor's only `task_notification` is terminal, fired alongside `task_updated`, with agreeing statuses: natural exit → `task_updated{completed}` + `notification{completed, "stream ended"}`; timeout AND control-request stop → `task_updated{killed}` + `notification{stopped}`. The launch echo has two forms: `"Monitor started (task <id>, timeout <n>ms)."` and `"Monitor started (task <id>, persistent — runs until TaskStop or session end)."`. See `dash/monitors-in-jobs.md` for the Q01–Q03 resolutions derived from this capture. |
| `probes/probe-jobs-lifecycle.mjs` | 2026-06-11 | The capture harness. Re-run with `bun probes/probe-jobs-lifecycle.mjs <out.jsonl>` to re-verify on a future claude release. |
| `probes/probe-monitor-lifecycle.mjs` | 2026-06-11 | Monitor companion harness (arm/events/exit, timeout, persistent + control-request stop). Re-run with `bun probes/probe-monitor-lifecycle.mjs <out.jsonl>`. |

## Phase map (`test-jobs-lifecycle-raw.jsonl`)

| Phase | task_id | Scenario | Lifecycle observed |
|-------|---------|----------|--------------------|
| P1 | `bkn113zww` | bg Bash, clean completion, idle wait | `task_started` (mid-turn) → turn `result` → **inter-turn** `task_updated{status:"completed"}` + `task_notification{status:"completed"}` → wake turn |
| P2 | `bmvgzc1fh` | bg Bash exits non-zero | `task_updated{status:"failed"}` arrived **mid-turn** (job died before the launch turn ended); `task_notification{status:"failed"}` inter-turn → wake turn |
| P3 | `btq9s0fcy` | **control-request** `{subtype:"stop_task"}` (the tugcode/tugdeck stop path) | `task_updated{status:"killed"}` + `task_notification{status:"stopped"}` + `control_response{subtype:"success"}` — all without a wake turn |
| P4 | `b23x5wfss` | `TaskStop` **tool** stop | same `killed` / `stopped` pair as P3 |
| P5 | `ac57e6163e2ab0290` | **foreground** Agent (control case) | `task_started` fires (`task_type:"local_agent"`) and `task_notification{status:"completed"}` fires; **no** `task_updated`; frame shape is **identical** to the background case |
| P6 | `ab5660790736ebc09` | background Agent | `task_started` → `task_progress`×4 → `task_updated{completed}` + `task_notification{completed}`; the async subagent's own bg Bash children (`bhvz4e7gv`, `bi2qk0cqb`) fire their own full lifecycles in the parent stream |

## Pinned shapes (claude 2.1.173)

```jsonc
// system/task_started — mid-turn, right after the launching tool call runs
{"type":"system","subtype":"task_started","task_id":"bkn113zww",
 "tool_use_id":"toolu_…","description":"Sleep 6 seconds then echo marker",
 "task_type":"local_bash"}                    // agents: "local_agent" + subagent_type (+ prompt)

// system/task_updated — patch-based status flip; mid-turn or inter-turn
{"type":"system","subtype":"task_updated","task_id":"bkn113zww",
 "patch":{"status":"completed","end_time":1781226041319}}
// patch.status vocabulary observed: "completed" | "failed" | "killed"

// system/task_notification — the wake trigger (already forwarded as wake_started)
{"type":"system","subtype":"task_notification","task_id":"…","tool_use_id":"…",
 "status":"completed","summary":"…","output_file":"…"}
// status vocabulary observed: "completed" | "failed" | "stopped"

// bg Bash launch tool_result
//   content: "Command running in background with ID: <id>. Output is being
//             written to: <path>. …"
//   tool_use_result: {…, "backgroundTaskId":"<id>"}
// bg Agent launch tool_result
//   tool_use_result: {"isAsync":true,"status":"async_launched","agentId":"<id>",
//                     "description":"…","outputFile":"<path>"}
```

## Question resolutions (for `dash/jobs-tracking.md`)

- **[Q01] — shapes pinned above. The frame carries NO backgrounded discriminant.**
  A foreground Agent emits a `task_started` (and even a `task_notification`)
  byte-shape-identical to the background case; `task_type` distinguishes bash
  from agent, not background from foreground. The only reliable gate is the
  frame's `tool_use_id` → the launching tool call's `input.run_in_background
  === true`, which the deck already holds on its `ToolUseMessage`. A foreground
  agent's `task_notification` then falls out naturally as an unknown-id flip
  (ignored).
- **[Q02] — both.** `task_updated` is the canonical terminal flip and arrives
  mid-turn (P2: fast failure) or inter-turn (P1: idle completion);
  `task_notification` follows inter-turn as the wake trigger. tugcode must
  forward task frames from **both** routing tiers, confirming the plan's
  both-tiers decision.
- **[Q04] — yes, confirmation fires.** The control-request stop produces
  `task_updated{status:"killed"}` + `task_notification{status:"stopped"}` (plus
  a `control_response` ack). No optimistic flip is needed; the wire-confirmed
  rule stands.
- Stopped-status notifications did **not** trigger a wake turn; completed/failed
  ones did.
