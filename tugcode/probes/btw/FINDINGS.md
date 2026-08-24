# `side_question` control-request probe — FINDINGS

Probe for `dash/add-btw.md` [Q01] (does Claude service a `side_question`
control-request over stream-json, idle **and** mid-turn?) and [Q02] (what does
the response look like on the wire?).

**CLI:** claude 2.1.204 · **Probe:** `probe-btw-control.mjs`
**Capture:** `capture-btw-control-2026-07-09T00-53-51-510Z.*`
· session `039fcd25-696f-471c-9908-214ee2c9c292`, cwd `/private/tmp/btw-control-probe`

## Method

Spawn `claude` directly with tugcode's stream-json arg vector
(`--input-format stream-json --output-format stream-json --verbose
--include-partial-messages --replay-user-messages --permission-mode
bypassPermissions --session-id <uuid>`). Seed a memorable fact
(`XYLOPHONE-42`) with a normal user turn, then write side-question
**control-requests** to stdin:

```json
{"type":"control_request","request_id":"btw-idle-1","request":{"subtype":"side_question","question":"…"}}
```

- **IDLE case** — fired after the seed turn's `result` settled.
- **MID-TURN case** — kicked off a long streaming turn (an 800-word essay on
  the printing press), then fired the side question **6s in, while the essay
  was still streaming**, and let both settle.

The distinction matters: an earlier run used a count-to-30 turn that finished
in 3.4s, so the "mid-turn" question actually landed after the turn settled.
The essay turn streams for ~40s, making the overlap unambiguous.

## [Q01] — RESOLVED: serviced idle AND mid-turn

**Both cases are serviced, and both answered correctly from the live
conversation context** (`XYLOPHONE-42`, the seeded fact — proving the side
question reads the full conversation).

- **Idle:** control-request `btw-idle-1` → `control_response` with
  `response.response = "XYLOPHONE-42"`.
- **Mid-turn:** control-request `btw-midturn-1` was answered **while the essay
  turn was still streaming** — the mid-turn `control_response` (capture line
  33, `00:54:35`) arrived **33 seconds and ~75 frames before** the essay
  turn's own `result` (line 108, `00:55:08`). `midturnResponseBeforeEssayResult:
  true` in the meta.
- **The main turn was unperturbed:** the essay `result` is the full,
  well-formed 600-word essay ("# The Printing Press: A History of the Machine
  That Remade the World…") — the side question did not interrupt, truncate, or
  corrupt it.

→ **Branch A (native control-request) is confirmed.** No fallback ([P06] /
Branch B) is needed. `/btw` mid-turn works over stream-json.

## [Q02] — RESOLVED: one progress frame, then a single settled answer

Each side question produces a **two-frame** sequence on stdout:

1. a **progress** frame:
   ```json
   {"type":"system","subtype":"control_request_progress","request_id":"<id>","status":"started","uuid":"…","session_id":"…"}
   ```
   This is the stream-json analogue of the remote path's `onProgress`. It
   carries only `status:"started"` here — no retry/streaming payload was
   observed.
2. the **terminal** `control_response` carrying the settled answer:
   ```json
   {"type":"control_response","response":{"subtype":"success","request_id":"<id>","response":{"response":"XYLOPHONE-42","synthetic":false}}}
   ```

The answer text is **not** streamed token-by-token — it arrives whole in the
one terminal `control_response`. `synthetic` was `false` in both cases; the
field is present. This confirms the **single settled answer** model ([P05]);
progressive rendering stays deferred ([#non-goals]).

## Exact `control_response` nesting (finalizes Spec S01)

```
event.type                         === "control_response"
event.response.subtype             === "success"
event.response.request_id          === <the client request_id, echoed>
event.response.response.response   === <answer string, or null>
event.response.response.synthetic  === <boolean; may be absent → default false>
```

- **Correlate** on `event.response.request_id`.
- **Extract** the answer from `event.response.response.response` and the flag
  from `event.response.response.synthetic`.

This matches the plan's static prediction (Spec S01) exactly.

**Parser predicate for `trySideQuestionControlResponse`:**
`event.type === "control_response"` && `event.response?.request_id` is in
`pendingSideQuestions`. The leading `system/control_request_progress` frame
shares the `request_id` but is **not** a `control_response` — it is ignored by
the predicate (tugcode may optionally observe it, but does not need to). The
catch must run **before** turn routing and before the `system/init` wake check
(a `system/init` for the essay turn appears at line 23, mid-stream), exactly
where `initialize`/`pendingRewindRequests` are caught today — this is why the
mid-turn response is caught the same way the idle one is (Risk R01).

## History cleanliness

`jsonlMentionsSideQuestionText: false` — neither the idle nor the mid-turn
side-question text (nor its answer) entered the session JSONL. The exchange is
CLI-side ephemeral (`threadHistory:false`), so replay/reload will not see it
([P05]). `jsonlLen` grew only from the two real user turns.

## Summary for the decision gate (#step-2)

| Question | Resolution |
|---|---|
| [Q01]a idle serviced? | **Yes** — correct context-aware answer |
| [Q01]b mid-turn serviced? | **Yes** — answered mid-stream, essay uninterrupted |
| [Q02] shape | **One `control_request_progress` (started) then one terminal `control_response`**; answer whole, not streamed; `synthetic:false` present |
| Branch | **A (native control-request)** — no fork fallback needed |
| Nesting | `event.response.response.{response,synthetic}`, correlate on `event.response.request_id` |
