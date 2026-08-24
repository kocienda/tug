# goal-loop probe findings

Probes for `dash/slash-command-plan.md` — the `/goal`, `/loop`, and `/btw`
wire behavior on the CLI version in `capabilities/LATEST`. Each section names
its capture files; the captures are the contract, this file is the summary.

## /goal lifecycle — [Q01] (probe-goal.mjs) {#q01-goal}

**CLI:** claude 2.1.204 · **Capture:** `capture-goal-2026-07-08T14-58-18-964Z.*`
· driven directly over stream-json with tugcode's `buildClaudeArgs` vector
(minus `--permission-prompt-tool stdio` and `--plugin-dir`),
`--permission-mode bypassPermissions`, cwd `/private/tmp/goal-probe`.

### The headline: a goal run is ONE result cycle, not many turns

Setting a goal starts work immediately (the user turn is rewritten to the
`<command-name>/goal</command-name>` envelope). When the evaluator judges the
condition unmet at a would-be stop, the harness injects a **synthetic `user`
event** into the SAME message cycle and claude continues. The whole goal run
— four claude-counted turns in the capture — produced exactly **one terminal
`result`** (`num_turns: 4`). There is **no `system/init` re-init and no
per-continuation `result`** anywhere inside the run.

Consequences:
- **tugcode needs no new bracketing.** A goal run is a single `ActiveTurn`
  under the existing machinery; the wake cohorts (A/B) are not involved.
- The Dev card sees one long turn. Turn accounting: claude's `result`
  reports the internal turn count (`num_turns`), but the bracket count is 1.

### The continuation event shape

```json
{
  "type": "user",
  "message": { "role": "user", "content": [ { "type": "text",
    "text": "Stop hook feedback:\n[<the full condition>]: <evaluator's reason>" } ] },
  "parent_tool_use_id": null,
  "isSynthetic": true
}
```

- **`isSynthetic: true` is the discriminant** — no other user event in the
  capture carries it. The text prefix is `Stop hook feedback:\n[`, then the
  verbatim condition in brackets, then `]: ` and the evaluator's reason.
- The evaluator's reason (the thing worth surfacing in UI) is the text after
  `]: `.
- These events persist to the session JSONL, so **replay will see them** —
  the deck must classify synthetic user events or they render as user prose.

### Status and clear

- `/goal` (bare) after the goal achieved: a fresh `system/init` + immediate
  assistant text `"No goal set. Usage: /goal <condition>"` + `result`
  (`num_turns: 0`). **The upstream docs' "achieved entry" display was NOT
  observed** on 2.1.204 over stream-json — status forgets an achieved goal.
  No `<command-name>` envelope and no `<local-command-stdout>` — the output
  is plain assistant text.
- `/goal clear` sent while a goal run is live: injected as a **plain user
  text event into the running cycle** (no envelope, no init). Claude
  acknowledges and stands down, but the evaluator fired **two more** Stop
  hook feedback rounds before quiescing — a clear is not instantaneous, and
  claude answers each residual feedback with "the goal has been cleared."
- `<local-command-stdout>` count across the whole capture: **0**. Nothing
  about /goal rides the local-command output path.

### Goal state observability

There is **no dedicated goal state event** on the wire. Observable signals:
1. Goal set — the `<command-name>/goal</command-name>` envelope user event
   (with the condition in `<command-args>`).
2. Goal active + latest reason — each `isSynthetic` Stop-hook-feedback user
   event.
3. Goal ended — the terminal `result` of the cycle (achieved), or the
   clear acknowledgment (assistant text) after a `/goal clear`.

Anything the deck tracks (condition, active/achieved/cleared, latest reason)
must be reduced from those three signals.

### Preconditions

`bypassPermissions` in a fresh `/private/tmp` cwd ran the goal without any
trust refusal — no hook-disabled or trust-dialog error was observed.

## /loop + resume — [Q02] (probe-loop.mjs) {#q02-loop}

**CLI:** claude 2.1.204 · **Captures:** `capture-loop-*-2026-07-08T15-04-34-180Z.*`
+ `capture-loop-meta-2026-07-08T15-04-34-180Z.json` · same spawn vector as the
goal probe.

### Tool-per-mode (confirmed)

- **Self-paced** `/loop <prompt>` → **`ScheduleWakeup`** (one call to arm; a
  second `{stop}` call ends the loop when the stop condition is met).
- **Interval** `/loop 1m <prompt>` → **`CronCreate`** (plus a teardown call
  at loop end). No `ScheduleWakeup` in interval mode.

### Wake fire on the wire

A wake arrives as a **fresh `system/init` in the same process** — Cohort B
exactly as the wake plan's [D05] re-init detector expects
(`dash/archive/tugplan-tide-session-wake.md#d05-reinit-detector`) —
followed by the loop prompt re-injected as a
`<command-name>/loop</command-name>` envelope `user` event and a normal
result cycle. No `system/task_notification` was observed in either mode
(`taskNotifications: 0`); the re-init IS the wake signal here.

### Resume retest — the 2026-05-25 scheduler bug is FIXED

Phase resume-sw: schedule a 60s `ScheduleWakeup`, kill claude at ~20s,
respawn with `--resume <session>`:

> **PASS — the scheduled wake fired in the resumed process** (`RESUMED_SW`
> marker observed; fresh init + wake cycle in the phase-2 capture).

This reverses the archived finding in
`dash/archive/wake-investigation-findings.md` (2.1.150: "metadata
restored, fire never happened"). **Consequence for the plan: tugcode
respawns claude with `--resume`, so a live loop now survives model/effort
changes, Reload, and app restarts** — the durability step shrinks to
verification + keeping the deck's scheduled rows honest across respawn
(they must NOT be falsely marked stopped, since the wake will still fire).

### Goal across resume

Phase resume-goal: set a 30-turn goal, kill mid-run at ~25s, respawn with
`--resume`, nudge with "Just resuming. What's pending?":

- The resumed claude **immediately resumed the goal work** — it described
  the pending condition and kept appending lines within the nudge turn's
  tool loop, without being asked to continue.
- **Evaluator re-arm was not directly observed**: the resumed turn never
  reached a stop boundary inside the 75s hold (one long tool loop), so no
  `Stop hook feedback` event appears in the capture. Whether the Stop-hook
  evaluator is re-armed after resume remains UNCONFIRMED; the conversation
  context alone is enough to keep claude working the goal at least through
  the next turn.
- Deck implication: after a respawn/resume, treat a previously-active goal
  as possibly-active rather than clearing it outright.

### Regression found and fixed from this finding

The deck's `session_init` stale-marking (`markRunningJobsStopped` in
`tugdeck/src/lib/code-session-store/select-jobs.ts`) flipped **every**
non-terminal row — including `scheduled` — citing the 2.1.150-era
no-refire finding. On 2.1.204 that falsely marks a surviving wakeup/cron
`stopped` right before its wake actually fires. Fixed to flip `running`
rows only (which also matches [D102]'s own wording); pinned by the
inverted unit test in `select-jobs.test.ts` and the live app-test
`tests/app-test/at0197-scheduled-survives-respawn.test.ts`.

## /btw headless — [Q03] (probe-btw.mjs) {#q03-btw}

**CLI:** claude 2.1.204 · **Capture:** `capture-btw-2026-07-08T15-05-07-785Z.*`
· cwd `/private/tmp/btw-probe`, seeded with a context fact before the side
question.

**`/btw` is NOT available over the headless bridge.** Sending
`/btw what is the magic word I told you earlier?` produced an immediate
assistant response + `result` with the literal text:

> `/btw isn't available in this environment.`

- `num_turns: 0` — the refusal is a **local, zero-cost response**; no model
  turn is burned and no `<command-name>` envelope is emitted.
- No "Unknown command" error — claude recognizes the command and refuses it
  explicitly for the environment.
- The exchange **does enter the session JSONL** (the `/btw` user line and
  the refusal both persist), so it is not history-free headless even as a
  refusal.
- Corroborating: `btw` is absent from the `slash_commands` catalog in
  `capabilities/2.1.204/system-metadata.jsonl`, so the Dev card's
  unknown-command check would flag it client-side today anyway.

**Implication for [Q04]:** upstream has no headless side-question channel —
a native Tug `/btw` would have to be built from scratch (a parallel
tool-less query). The cheap, honest branch is hide-with-notice; a Tug-side
implementation is follow-on work.
