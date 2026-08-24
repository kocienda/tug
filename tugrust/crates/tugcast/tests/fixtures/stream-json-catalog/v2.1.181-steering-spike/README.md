# Steering wire-behavior spike (Step 1 of dash/message-architecture.md)

How a message typed while the assistant is busy ("steering") gets picked up.

## Answer: merge into the running turn at the agent-loop iteration boundary

See **`queued-command-mechanism.md`** for the authoritative analysis (a corpus of
**470 real `queued_command` injections across 42 sessions**, claude 2.1.133–2.1.177).

Summary: a steered message is **merged into the running turn at the next
agent-loop iteration boundary** — injected as a `user_message` **threaded right
after the current step's `tool_result`** (93% of cases), after which the turn
continues (`stop=tool_use`). It is *not* deferred to the turn boundary (the <1%
exception). Wait time = time until the current step finishes (p50 8s, max ~7min).

Signature to detect it: a `user_message` (TUI: a `queued_command` attachment)
threaded after a `tool_result` while the turn is in flight.

## Files

- `queued-command-mechanism.md` — the authoritative corpus finding (read this).
- `merge-midturn-probe-transcript.txt` — a single raw-claude run of
  `tugcode/probe-tool-overlap.ts` that **bypasses tugcode**. Kept only as a
  labelled false start: one run can't distinguish merge from "buffered-without-a-
  gap," and it doesn't exercise the queue layer. Not evidence for anything.

## Two retracted readings (recorded so they don't recur)

1. "Merged, invisible" — from the single probe run. Unsafe (n=1, filtered view).
2. "The TUI never merges; it buffers to the turn boundary" — from looking only at
   `queue-operation` dequeues that happened to coincide with `turn_duration`.
   That was the <1% minority generalized into a law; the corpus (above) shows the
   merge-at-iteration-boundary rule clearly.

## Worked example

Session `5eefeaec` ("Tide is retired. This is now the `Dev` card."): enqueued at
13:19:09 while the assistant was mid-Bash; injected as a `queued_command`
attachment at 13:19:26.565, immediately after the tool_result at 13:19:26.564;
the assistant continued the same turn (`stop=tool_use` throughout) and
incorporated it ("I now have the full picture… your just-now note").

## Layer note

These records are the Claude Code **TUI** queue (`entrypoint: cli`). The **Dev
card** (tugcode + stream-json) holds its own `queuedSends` and flushes at
`turn_complete` — which is why cued messages feel "end-of-turn" there. The fix is
to forward mid-turn (`[P06]`) so claude merges at its iteration boundary like the
TUI. The remaining open sub-question (`[Q02]`, Step 6): whether the live
stream-json wire surfaces the merged `user_message` for immediate placement, or it
is placed on reload from JSONL.
