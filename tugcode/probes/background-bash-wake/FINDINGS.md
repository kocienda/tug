# [Q01] — what the live SDK sends when a backgrounded Bash completes

Captured 2026-09-04 by `probe-tugcode.mjs` in this directory. Capture set:
`capture-bgbash-2026-09-04T15-36-06-376Z.{stdout,stderr,jsonl,meta,raw.stdout}`.

The probe launches `sleep 8 && echo background-done` with `run_in_background: true`,
tells the model to answer one word and end the turn, then holds 45 seconds past
the first `turn_complete`. That is the incident's shape in miniature: a turn that
ends having launched something, and a completion that arrives after it.

Three views, because no single one holds the whole answer:

| View | File | What it is |
|---|---|---|
| tugcode's stdout | `.stdout` | The IPC frames tugcast and the deck actually see. |
| tugcode's stderr | `.stderr` | tugcode redirects every `console.*` here (`main.ts:42`), so the `unhandled system subtype` lines land in it. |
| claude's persisted transcript | `.jsonl` | Where the `<task-notification>` envelope survives as a `user` record. |
| the raw claude wire | `.raw.stdout` | Phase 2 — claude spawned directly with tugcode's own args, so the `system` events survive verbatim. |

## Versions

- **`@anthropic-ai/claude-agent-sdk`: `0.2.141`** (`tugcode/node_modules/@anthropic-ai/claude-agent-sdk/package.json`).
- **claude CLI: `2.1.258`** (the `version` field on every `.jsonl` record).
- The tugcode binary was the bundle's, `Tug.app/Contents/MacOS/tugcode` — this
  checkout has no `tugrust/target/` build. The probe prefers the checkout build
  and falls back, so a later run in a built checkout needs no edit.

## The frame order between the first `turn_complete` and the next assistant content

tugcode's stdout, verbatim ordering with capture timestamps:

```
15:36:11.540  turn_complete
15:36:11.540  activity_delta
15:36:11.540  context_breakdown
              ← 7.13 s gap: the sleep ←
15:36:18.673  task_updated
15:36:18.673  wake_started
15:36:18.716  system_metadata
15:36:18.716  context_breakdown
15:36:19.504  streaming_usage
15:36:19.506  content_block_start
15:36:19.506  assistant_text        ("The background command finished…")
```

The raw wire under it, for the same stretch:

```
15:37:01.970  result/success                        ← the turn ending
15:37:09.116  system/background_tasks_changed       (tasks: [])
15:37:09.116  system/task_updated
15:37:09.116  system/task_notification              ← the wake trigger
15:37:09.143  system/init                           ← a SECOND init, mid-session
15:37:09.143  system/status
15:37:09.941  stream_event …
```

**The gap is the whole of the incident.** Between `turn_complete` and the next
frame there are 7.13 seconds in which the session has ended a turn, has no work
in flight that any frame announces, and is about to be woken. Nothing in the
stream marks the session as still-busy across it. The runner read exactly this
gap as idle, six times.

## Answers, in the order [Q01] asks them

**Did `task_started` arrive, and did its `tool_use_id` match the launching `tool_use`?**
Yes and yes. The launching `tool_use` carried `tool_use_id: toolu_01Hgc…` and
`task_started` carried the same id, 85 ms later, along with a `task_id` in
claude's own short-id space (`b7p4flzut`). Both spaces are on the frame, so the
launch is joinable to the wake from either end. It arrives **inside** the turn,
before `turn_complete` — which is what makes [B03]'s latch-at-launch possible.

**Did `wake_started` arrive, and from which source?**
Yes — tugcode synthesizes it from `system/task_notification`
(`session.ts:1135`, `makeWakeStarted`), not from `task_updated` and not from the
envelope. Its `wake_trigger` carries `task_id`, `tool_use_id`, `status` and the
`output_file`, so the wake names the launch it answers.

**Did a `user`-role `<task-notification>` envelope appear on tugcode's stdout as any frame?**
**No.** `grep -c task-notification` on the `.stdout` capture returns **0**. The
envelope reaches the model, and claude persists it in the `.jsonl` as a
`type: "user"` record — but tugcode forwards `user` events only as
`tool_result` / `goal_feedback` / `compact_summary` / `prompt_anchor`, and this
one is none of those. It is invisible downstream.

Two things worth having, from the raw wire, that the plan did not assume:

- **On the wire the envelope is not a `user` event at all.** claude emits it as
  `system/task_notification`; the `user` record in the `.jsonl` is claude's own
  persistence of the resulting turn, minted locally. So a live-path recognizer
  ([P03]) has a **typed** frame to key on rather than a string match on prose.
- **The persisted record carries `origin: {"kind": "task-notification"}` and
  `promptSource: "sdk"`.** Either is a stronger recognizer than the `<task-notification>`
  text, and both survive on the replay path where the raw system event does not.

**Was `background_tasks_changed` logged as unhandled?**
Yes — once, at the launch. `noteUnhandledSystemSubtype` dedupes on a `Set` keyed
by subtype (`session.ts:6000`), so the **second** one — which the raw wire shows
arriving with the wake, carrying `tasks: []` — produced no line. The raw capture
has two; tugcode's stderr has one. Reading the stderr count as an event count
would be wrong.

## The verbatim lines

Identifiers replaced per the catalog's placeholder vocabulary
(`tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/README.md`):
`{{uuid}}` for any leaf under `session_id` / `tool_use_id` / `task_id` / `uuid`,
`{{i64}}` for `end_time`.

`system/task_started` — inside the turn, 85 ms after the `tool_use`:

```json
{"type":"system","subtype":"task_started","task_id":"{{uuid}}","tool_use_id":"{{uuid}}","description":"Run sleep then echo in background","is_backgrounded":true,"task_type":"local_bash","uuid":"{{uuid}}","session_id":"{{uuid}}"}
```

`system/background_tasks_changed` — at the launch, one entry:

```json
{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"{{uuid}}","task_type":"local_bash","description":"Run sleep then echo in background"}],"uuid":"{{uuid}}","session_id":"{{uuid}}"}
```

`system/background_tasks_changed` — again at the wake, now empty. tugcode logs
no line for this one (the dedupe above):

```json
{"type":"system","subtype":"background_tasks_changed","tasks":[],"uuid":"{{uuid}}","session_id":"{{uuid}}"}
```

`system/task_updated` — note the status is under `patch`, not on the frame:

```json
{"type":"system","subtype":"task_updated","task_id":"{{uuid}}","patch":{"status":"completed","end_time":{{i64}}},"uuid":"{{uuid}}","session_id":"{{uuid}}"}
```

`system/task_notification` — the wake trigger:

```json
{"type":"system","subtype":"task_notification","task_id":"{{uuid}}","tool_use_id":"{{uuid}}","status":"completed","output_file":"/private/tmp/claude-501/{{cwd-slug}}/{{uuid}}/tasks/{{uuid}}.output","summary":"Background command \"Run sleep then echo in background\" completed (exit code 0)","uuid":"{{uuid}}","session_id":"{{uuid}}"}
```

The envelope, as claude persists it (`.jsonl`; not on tugcode's stdout):

```json
{"parentUuid":"{{uuid}}","isSidechain":false,"promptId":"{{uuid}}","type":"user","message":{"role":"user","content":"<task-notification>\n<task-id>{{uuid}}</task-id>\n<tool-use-id>{{uuid}}</tool-use-id>\n<output-file>/private/tmp/claude-501/{{cwd-slug}}/{{uuid}}/tasks/{{uuid}}.output</output-file>\n<status>completed</status>\n<summary>Background command \"Sleep then echo in background\" completed (exit code 0)</summary>\n</task-notification>"},"uuid":"{{uuid}}","timestamp":"{{iso}}","permissionMode":"default","origin":{"kind":"task-notification"},"promptSource":"sdk","queueSkipAttachments":true,"userType":"external","entrypoint":"sdk-cli","cwd":"/private/tmp/background-bash-wake","sessionId":"{{uuid}}","version":"2.1.258","gitBranch":"HEAD"}
```

And the launching `tool_use` as tugcode forwards it, for the id join:

```json
{"type":"tool_use","msg_id":"{{uuid}}","seq":0,"tool_name":"Bash","tool_use_id":"{{uuid}}","input":{"command":"sleep 8 && echo background-done","description":"Sleep then echo in background","run_in_background":true},"ipc_version":2}
```

## What this changes for the later steps

- **[P03]'s recognizer keys on a typed frame, not on prose.** `system/task_notification`
  is a real wire event with `task_id` and `tool_use_id` on it. The plan allowed
  for a string match against the envelope; it does not need one on the live path.
  The envelope's `origin.kind` is the recognizer for the replay path, where the
  system event is not persisted.

  **Step 5 built the string recognizer anyway, and this capture is what it is
  pinned against.** `handleUserEnvelope` (`tugcode/src/session.ts`) matches the
  envelope with `extractTaskNotificationWake`, the same function the replay path
  uses, and `isInWake` drops the duplicate when the typed event also arrived —
  which on this wire it always does, so the arm fires for nothing today. That is
  the reason to have it: the busy latch's whole guarantee is that a wake is
  announced, and a wire that quietly stopped emitting `system/task_notification`
  would take the guarantee down with it and announce nothing. The verbatim
  envelope below is the fixture in
  `tugcode/src/__tests__/wake-envelope-live.test.ts`, which drives both shapes
  through the drain together and asserts exactly one `wake_started` comes out.

  The other half is a refusal. `routeTopLevelEvent`'s `case "user"` reads any
  plain-string content as a submission echo and latches it as the `/rewind`
  anchor, so an envelope reaching the in-turn router would move the anchor off
  the user's last prompt onto a background job's completion notice. It returns
  early on a recognised envelope instead.
- **[P04]'s provisional latch has a real close.** `task_started` arrives inside
  the launching turn and joins to the `tool_use` by `tool_use_id`, so the latch
  opened at the `tool_use` can be confirmed rather than left provisional — the
  `Monitor` case R02 accepts is the one where `task_started` never comes, and
  this capture shows that for a Bash launch it does.
- **`task_updated` carries `status` under `patch`.** A Step 5 fixture that reads
  `event.status` on a `task_updated` will read `undefined`. tugcode already
  handles this correctly (`session.ts:1167`); a new reader must not regress it.
- **Do not count `unhandled system subtype` lines.** The dedupe makes the line a
  first-sighting notice, not an occurrence count.

## Two defects found while building the probe

Neither is in this arc's scope; both are recorded because the next person to
copy a probe will meet them.

1. **`../wake-investigation/probe-tugcode.mjs` is stale against the inbound wire.**
   It sends `{type:"user_message", text, attachments}`. The contract in
   `tugproto/src/inbound.ts:62` is `{type:"user_message", content: ContentBlock[]}`.
   tugcode accepts the message and the model receives an **empty prompt** — the
   first run of this probe produced "I don't see a question or task in your
   message." with no error anywhere. A stale probe that reports a plausible
   non-answer is worse than one that fails, and nothing in the path complains.
2. **tugcode spawns claude with `--permission-mode default`.** A probe that
   drives a tool call has to send `{type:"permission_mode", mode:"bypassPermissions"}`
   after `protocol_init`, or the turn ends on an unanswered `can_use_tool` having
   launched nothing. This probe does; the sibling did not need to.
