# Wake investigation — what claude actually does

**Date:** 2026-05-25
**Captures:** `tugcode/probes/wake-investigation/capture-{sw-60,cron-1m}-*.{stdout,jsonl,meta}`
**Probe script:** `tugcode/probes/wake-investigation/probe-harness.mjs`

This document settles, with empirical capture data and official documentation references, what Claude Code's harness actually does for ScheduleWakeup / CronCreate / CronDelete and what tugcode actually needs to implement. **Read this before touching any wake / scheduler code.** Step-6's earlier capture window was too short to see the harness fire; the conclusion drawn from it ("Cohort B doesn't fire in stream-json mode") was wrong.

## Top-line conclusion

**Claude has its own scheduler. tugcode does NOT need one.** The harness fires ScheduleWakeup / CronCreate timers in stream-json mode just like it does in interactive mode. The signal it emits on claude's stdout for tugcode to bracket the wake turn is a **fresh `system/init` event** — the same event type the harness emits at session spawn.

The shadow scheduler we built (`tugcode/src/scheduler.ts` `WakeScheduler` + `handleSchedulingToolUse` intercept + `cronIdToToolUseId` map + croner dependency) is wrong-headed and must be removed: it duplicates work the harness already does, double-fires wakes alongside the harness, and cannot reliably cancel itself when the harness's `CronDelete` runs.

## Best practice — prefer a Monitor over a bare timed wakeup for "notify me when X finishes"

`ScheduleWakeup`/`CronCreate` fire on a **guessed clock** (`delaySeconds`, or a cron time), with built-in jitter — a recurring task may fire up to 30 minutes late. So a bare timed wakeup used to poll "is the suite done yet?" tends to land long after the work actually finished (the stale-wake symptom that motivated the JOBS-cell scheduled-work surfacing). For a *completion* notification, prefer running the work as a **backgrounded job** (`Bash`/`Agent` with `run_in_background: true`) and a **`Monitor`** watching it: that path is **event-driven** (it fires on actual completion via `system/task_notification`, not a timer) and is **already tracked** in the Z2 `JOBS` cell, so the user can see and stop it. Scheduled wakeups now appear in the same cell with a live countdown and a "fired late" badge — which makes a duration mismatch ("fires in 52:00" against an 8-minute suite) self-evident — but the timer is still the wrong tool when an event-driven Monitor is available. Reserve `ScheduleWakeup`/`CronCreate` for genuinely time-based work (a periodic check, a deadline), not for polling another task to completion.

## What the official docs say

From [code.claude.com/docs/en/scheduled-tasks](https://code.claude.com/docs/en/scheduled-tasks):

- The harness's scheduler **checks every second for due tasks and enqueues them at low priority**. A scheduled prompt fires *between* turns, not mid-response.
- Tasks fire **while Claude Code is running and idle**. No external machinery is required.
- Jitter is built in: recurring tasks fire up to **30 minutes after** the scheduled time; one-shot tasks at the top or bottom of the hour fire up to **90 seconds early**. ScheduleWakeup `delaySeconds:N` actually fires at the next minute boundary after `now + N` seconds (empirically verified — see Capture A below).
- `CLAUDE_CODE_DISABLE_CRON=1` disables the scheduler entirely.

From the SDK type docs ([code.claude.com/docs/en/agent-sdk/typescript](https://code.claude.com/docs/en/agent-sdk/typescript)):

- `SDKSystemMessage` has only three documented subtypes: `"init"`, `"compact_boundary"`, `"plugin_install"`.
- `SDKTaskNotificationMessage` (the `system/task_notification` event tugcode already handles for Cohort A) is for **background task completions** (Bash `run_in_background`, Monitor watches, background subagents) — **not** for scheduled task firings.
- `SDKUserMessage.origin: SDKMessageOrigin` distinguishes `"human"`, `"channel"`, `"peer"`, `"task-notification"`, `"coordinator"`. No documented kind for scheduled-task fires.

## Capture A — ScheduleWakeup `delaySeconds:60`

**Session id:** `8ba612d0-0c9d-4e04-9a98-2c85b3c12fa9`
**Stdout capture:** `capture-sw-60-2026-05-25T14-25-36-113Z.stdout` (40 lines)
**Prompt sent at:** `14:25:37.919` (queue enqueue at `14:25:36.627`)
**ScheduleWakeup registered at:** `14:25:48` (tool_use returned)
**First turn closes at:** `14:25:52.773` (`result/success`)
**Harness fires at:** `14:27:00.680` — exactly the next minute boundary after `now + 60s`. **Tugcode-visible signal: a fresh `system/init` event.**

Stdout lines 29-40 (the wake turn, as tugcode would see them):

```
14:25:52.773  result/success                              ← first turn closes
14:27:00.680  system/init                                 ← !!! wake bracket signal !!!
14:27:00.680  system/status
14:27:03.424  stream_event message_start
14:27:03.424  stream_event content_block_start (text)
14:27:03.424  stream_event content_block_delta (text)
14:27:03.424  stream_event content_block_delta (text)
14:27:03.424  assistant: "PROBE_SW fired"
14:27:03.424  stream_event content_block_stop
14:27:03.487  stream_event message_delta
14:27:03.487  stream_event message_stop
14:27:03.488  result/success                              ← wake turn closes
```

What does NOT appear on stdout: any echo of the wake's `user_message` ("Reply with exactly 'PROBE_SW fired' and nothing else."); any `task_notification`; any `queue-operation` event. The wake's prompt is injected into claude's internal queue and never leaves the process.

In the JSONL (claude's persisted view, NOT what tugcode sees) the harness fire is visible as:

```
14:24:00.674  queue-operation enqueue
14:24:00.674  queue-operation dequeue
14:24:00.677  user (isMeta:true)  content="Reply with exactly 'PROBE_SW fired' and nothing else."
14:24:03.888  assistant            text="PROBE_SW fired"
```

(Times from an earlier sw-60 run with the same shape.)

## Capture B — CronCreate one-shot ~90s out

**Session id:** assigned per probe
**Stdout capture:** `capture-cron-1m-2026-05-25T14-25-40-894Z.stdout` (74 lines)
**Harness fires at:** `14:28:00.570` — at the next-minute boundary matching the cron expression claude registered.

Stdout lines 63-74 (the wake turn):

```
14:25:59.851  result/success                              ← first turn closes
14:28:00.570  system/init                                 ← !!! same signal as ScheduleWakeup !!!
14:28:00.570  system/status
14:28:02.178  stream_event message_start
14:28:02.178  stream_event content_block_start (text)
14:28:02.178  stream_event content_block_delta (text)
14:28:02.178  stream_event content_block_delta (text)
14:28:02.179  assistant: "PROBE_CRON1 fired"
14:28:02.179  stream_event content_block_stop
14:28:02.201  stream_event message_delta
14:28:02.201  stream_event message_stop
14:28:02.205  result/success
```

Byte-identical shape to Capture A. **The harness fire signal is the same for ScheduleWakeup and CronCreate.**

## What tugcode needs to do

### Detection

In `handleClaudeLine` (or `handleInterTurnEvent`), recognize a `system/init` event arriving **after** the session has already been initialized. Today tugcode forwards every `system/init` as a `session_init` IPC frame — fine on the first one, wrong on subsequent ones. The second-and-later `system/init` is the **wake bracket signal**.

Roughly:

```ts
// SessionManager state
private sessionInitSeen: boolean = false;

// handleClaudeLine, before routing
if (event.type === "system" && event.subtype === "init") {
  if (this.sessionInitSeen) {
    // Re-init → wake fire. Emit wake_started bracket and open ActiveTurn
    // so the subsequent stream events route through dispatchEventToTurn.
    this.openWakeBracket(event);
    return;  // do not forward as session_init
  }
  this.sessionInitSeen = true;
  // ... existing first-init handling ...
}
```

`openWakeBracket` mirrors what `handleTaskNotification` does for Cohort A:

```ts
private openWakeBracket(initEvent: Record<string, unknown>): void {
  const frame: WakeStarted = {
    type: "wake_started",
    session_id: this.sessionId,
    wake_trigger: {
      task_id: "",         // harness re-init carries no task id
      tool_use_id: "",     // ditto
      status: "completed",
      summary: "scheduled wake",
      output_file: "",
    },
    ipc_version: 2,
  };
  if (this.isInWake) return;  // nested wake guard
  writeLine(frame);
  this.isInWake = true;
  this.activeTurn = new ActiveTurn(this.nextSeq(), "", []);
}
```

### Wake trigger metadata (optional, defer to Slice 2)

The harness's re-init does NOT carry the wake's prompt or the originating tool's `tool_use_id`. To show "Resumed by ScheduleWakeup with reason X" chrome (the unresolved [Q02] in the plan), tugcode would need to remember every `ScheduleWakeup` / `CronCreate` tool_use it observes plus the cron id returned in the tool_result, and match the fired wake against the most-likely originator. This is **optional polish**, not a blocker.

### What to delete

All of this is wrong-headed and must come out:

| File | What it does | Why it's wrong |
|---|---|---|
| `tugcode/src/scheduler.ts` | `WakeScheduler` class shadowing the harness's timers with croner | Harness already does this; we double-fire |
| `tugcode/src/__tests__/scheduler.test.ts` | 13 tests for the shadow scheduler | The shadow scheduler is gone |
| `tugcode/src/__tests__/scheduler-intercept.test.ts` | 17 tests for tool_use intercepts | Intercepts only existed to feed the shadow |
| `tugcode/src/__tests__/scheduler-fire.test.ts` | 9 tests for fire paths + double-fire | Obsolete |
| `tugcode/src/__tests__/wake-scheduler-tool-input-drift.test.ts` | 4 drift tests pinning ScheduleWakeup/CronCreate input shapes | Useful if we later add chrome metadata; deferred |
| `croner` dependency in `tugcode/package.json` | Cron pattern parser + timer library | Not used by the redesign |
| `handleSchedulingToolUse`, `handleCronCreateResult` in `session.ts` | Tool-use intercepts that registered shadow jobs | Only existed to feed the shadow |
| `pendingCronCreateToolUseIds`, `cronIdToToolUseId` fields | Cron id ↔ tool_use_id mapping | Not needed once shadow is gone |
| Scheduler dispose / construct wiring in `SessionManager` | Lifecycle management for the shadow | Not needed |

Net code change: **delete ~700 lines + 43 tests; add ~30 lines + ~3 tests** for the re-init detector.

## Why we didn't see this in Step 6

The Step-6 probe (`probes/probe-sw-streamio.mjs`) held the subprocess for **90 seconds** after submitting a ScheduleWakeup `delaySeconds:60`. Empirically, the harness's actual fire time is "next minute boundary after `now + 60s`" — somewhere between 60 and 120 seconds after the prompt lands, plus the few seconds claude takes to register the tool call. So a 90-second hold can miss the fire by 0-30 seconds. The Step-6 capture concluded "no fire" because none arrived within the window, and the cohort taxonomy was built on that wrong conclusion.

**Lesson:** capture windows for harness-fired events need to be at least 2× the documented minimum interval, plus the maximum jitter.

## What about the Session 86ae1b78 anomaly?

In Session 86ae1b78 (recurring `* * * * *` CronCreate), the user saw both shadow fires AND harness fires interleaved. The harness fired once at `14:04:13` (within the recurring-jitter window) — claude responded `CRON_TICK 2` + `CronDelete`. That successfully cancelled the *harness's* cron (CronList confirmed empty), but our shadow kept firing every minute thereafter ("Still ignoring…") because the harness's CronDelete intercept did not propagate to our shadow's cancellation path.

This is the exact symptom of running two schedulers in parallel. The redesign — delete the shadow, trust the harness — fixes it by construction.

## Resume-mode behavior — scheduled wakes do NOT fire after resume

**Tested via `probe-resume.mjs` on 2026-05-25 (sessions f9977732, a2b0737b).**

**Setup:** spawn tugcode in `--session-mode new`, register a `ScheduleWakeup delaySeconds:60`, kill tugcode (SIGTERM → claude exits cleanly with code=0) ~10 seconds after the registration completes. Respawn tugcode in `--session-mode resume --resume-session <id>`, send a nudge user_message ("Just resuming. What's pending?"), hold for 150 seconds (past the scheduled fire time).

**Expected per docs ([code.claude.com/docs/en/scheduled-tasks](https://code.claude.com/docs/en/scheduled-tasks)):** *"Resuming with `claude --resume` or `claude --continue` brings back any task that hasn't expired … a one-shot whose scheduled time hasn't passed yet."*

**Observed:**

- The resumed claude **knows** the wakeup is scheduled — when asked "What's pending?" it reports *"The wakeup is scheduled to fire at 08:46:00 (~111s from when it was set). When it fires, I'll reply with exactly `RESUMED_SW fired`..."*
- The scheduled fire time (15:46:00 local) elapses without the harness firing.
- No `system/init` re-emit, no synthetic user_message, no assistant turn — the timer simply never goes off.
- The probe runs until 15:47:00 (a full minute past the scheduled fire) and observes nothing on claude's stdout beyond the nudge's own turn.

**Conclusion:** in `--input-format stream-json --output-format stream-json --resume <id>` mode, claude restores the scheduled task's **metadata** (it can describe what's pending) but the in-process scheduler does NOT actually fire restored tasks. This contradicts the published documentation, which doesn't carve out stream-json mode.

**Why this is an upstream behavior, not a tugcode bug:**

- The detector is correct: a re-init from the harness scheduler would still be classified as a wake by `handleClaudeLine`. The wake just doesn't arrive.
- No stream-json wire signal is produced for the restored task. Whatever fires the harness scheduler in interactive mode does not run in our spawn configuration after `--resume`.

**Implication for Tide:**

- A scheduled wake registered in session A, closed before the wake fires, then reopened via Tide's "resume" path → the wake will NOT fire. The user would have to re-register the task in the resumed session.
- For sessions that stay open continuously, this never comes up — the harness scheduler fires fine (Probes 1-4 verified live in sessions 95d18839, 017f1206, 5f5af4de, 2cad794c).

**Reproduce:**

```
cd tugcode/probes/wake-investigation
bun probe-resume.mjs
# Phase 1 (~20s): schedule wakeup, kill tugcode
# Phase 2 (~150s): respawn with --session-mode resume, wait for fire
# VERDICT line at the end: PASS or FAIL
```

Captures:
- `capture-resume-phase1-2026-05-25T15-44-04-036Z.{stdout,stderr}` — wake registration.
- `capture-resume-phase2-2026-05-25T15-44-04-036Z.{stdout,stderr}` — post-resume; no wake_started.
- `capture-resume-meta-2026-05-25T15-44-04-036Z.json` — verdict + line counts.

If a future Claude Code release fixes this, the probe will PASS without code changes; the detector already handles the fire signal correctly.

## Probe reproducibility

```
cd tugcode/probes/wake-investigation
bun probe-harness.mjs sw-60       240    # ScheduleWakeup, 4-min hold
bun probe-harness.mjs cron-1m     240    # CronCreate one-shot, 4-min hold
bun probe-harness.mjs cron-recur  300    # CronCreate recurring, 5-min hold (catches 2 fires)
bun analyze.mjs capture-<base>           # decode stdout into readable summary
```

Output goes to `capture-<kind>-<timestamp>.{stdout,stderr,jsonl,meta}`. The `.stdout` is what tugcode would see on claude's stdout; the `.jsonl` is claude's internal persisted view. Comparing the two answers "what does tugcode have visibility into?"
