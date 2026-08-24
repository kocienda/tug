# How mid-turn steering actually works — the `queued_command` mechanism

Authoritative finding for Step 1 of `dash/message-architecture.md`, from a
corpus survey of real session JSONL (no synthetic probes). Supersedes the earlier
single-run raw probe and the (wrong) "buffers to turn boundary, never merges"
reading.

## Corpus

`queued_command` attachments across all tugtool-project sessions:
**470 injections in 42 sessions**, claude **2.1.133–2.1.177**.

## The mechanism (what the JSONL shows)

A message typed while the assistant is working is recorded as a sequence:

1. `{"type":"queue-operation","operation":"enqueue","content":"…"}` — typed while busy.
2. (waits while the **current** agent-loop step runs)
3. `{"type":"queue-operation","operation":"remove"}` + `{"type":"attachment","attachment":{"type":"queued_command","prompt":"…"}}` — at the next iteration boundary, the item is dequeued and **injected into the running conversation, threaded immediately after the current step's `tool_result`**.
4. The assistant **continues the same turn** and incorporates it.

`remove` (without a paired pop) is the user cancelling (the `×`). `popAll` /
`dequeue` are queue drains.

## The numbers (n = 470)

What the `queued_command` threads **after** (the boundary):

| after | count | % |
|---|---|---|
| `tool_result` (mid-loop) | 437 | 93% |
| another queued attachment (chained) | 30 | 6% |
| assistant `stop=end_turn` (turn boundary) | 3 | <1% |

What threads **after** the injection (does the turn continue?):

| next | count | meaning |
|---|---|---|
| assistant `stop=tool_use` | 362 | turn **continues** — true mid-turn merge |
| chained attachment | 84 | another queued item |
| assistant `stop=end_turn` | 15 | merge was the last thing; turn then ended |
| user / null | 9 | — |

Wait time (enqueue → injection), n=452: **min 0s, p50 8s, p90 50s, max 413s**.
= time until the in-flight step finishes (seconds typically; minutes for a long
tool/turn).

## Conclusions

1. **The gap = the agent-loop iteration boundary** — concretely, the moment the
   current step's `tool_result` lands. 93% of steers inject there; only <1% wait
   for `end_turn`. It is *not* the whole-turn boundary (that's the rare case where
   no further tool step was pending).
2. **It is a true merge into the running turn** — the turn continues
   (`stop=tool_use`) after the injection in the large majority of cases. The
   steered message becomes a `user_message` interleaved *mid-turn*, after a
   `tool_result`, before the assistant's continuation.
3. **Signature to detect it:** a `user_message` (TUI: a `queued_command`
   attachment) threaded after a `tool_result`, with the surrounding assistant
   entries `stop=tool_use`.
4. Background `<task-notification>`s ride the identical path.

## The queue lives OUTSIDE the conversation; injection is at the boundary

Worked example, session `48d25803` (claude 2.1.183, TUI), full 28-line session:

```
L3  02:16:30 user "Run an agent to grep … three times"   (parent=root)
L8  02:16:40 queue-operation:enqueue "what's 2+2?"        (parent=ROOT — outside the tree)
L11 02:16:37 assistant tool_use:Agent                     (Explore run 1 launches)
L12 02:17:01 queue-operation:remove                        (drained at the boundary)
L13 02:17:01 user [tool_result]                            (the Agent run 1 returns)
L14 02:17:01 attachment:queued_command "what's 2+2?"       (parent=L13 — injected AFTER the tool_result)
L16 02:17:07 assistant "Run 1 done. A queued message came in … 2+2 = 4. Now run 2."  (stop=tool_use)
```

Key refinements over the bare corpus stats:

1. **The queued message is held OUTSIDE the conversation tree** — the
   `queue-operation:enqueue` record has `parentUuid: root`, not a position in the
   turn. It is the composer-area queue ("Press up to edit queued messages",
   "↓ to manage"), *not* a transcript row.
2. **Injection is harness-timed at the agent-loop boundary** — the instant the
   in-flight tool/agent returns its `tool_result`, the harness drains the queue
   (`remove`) and threads the message in as a `queued_command` attachment **after
   that `tool_result`**. "Somehow it knows" = the harness drives the loop and
   injects in the gap between iterations.
3. **It is recorded as a `queued_command` attachment, not a free `user` turn** —
   it attaches to the conversation at the injection point; the assistant reads it
   and continues the same turn.

UX consequence: a steered message is **invisible in the transcript while queued**
(it lives by the composer), and **appears in the transcript only at the boundary**
when the harness injects it.

## Layer note (why the Dev card differs today)

These `queue-operation` / `queued_command` records are written by the Claude Code
**TUI** (`entrypoint: cli`) — its own queue. The **Dev card** (tugcode +
stream-json input) does **not** use this; it holds `queuedSends` in the reducer
and flushes at `turn_complete`. That is exactly why cued messages feel "only at
the end of the turn" in the Dev card but merge mid-turn in the TUI. The underlying
claude behaviour (merge at the next iteration boundary when a message is written
to stdin mid-turn) is available to the Dev card **if it forwards mid-turn** — the
remaining open question is what the live stream-json wire surfaces for the merge
(a live event to place immediately, vs only the JSONL record on reload).
