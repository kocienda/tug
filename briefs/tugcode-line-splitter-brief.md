<!-- brief-skeleton v1 -->

# One capped line splitter in tugcode, and stdin writes that notice backpressure

**Purpose:** tugcode reads three line-delimited streams (its own stdin, claude's stdout, claude's stderr) with three copies of the same `buffer += chunk; indexOf("\n")` loop, none of which caps the buffer. It writes to claude's stdin ignoring the write result. A stream that stops producing newlines is an unbounded allocation, and a wedged claude is an unbounded queue.

---

## Purpose {#purpose}

Item 8 of `briefs/audit-punch-list.md`:

> 8. One capped `LineSplitter` replacing the three copies in tugcode, plus checking the stdin write result in `session.ts` so a wedged claude cannot grow Bun's buffer unbounded.

---

## Evidence {#evidence}

**[F01] Three copies of the splitter** — `tugcode/src/ipc.ts` `readLine()` (stdin, with `trim()` and `validateMessage`), `session.ts` around line 5177 (claude stderr, forwards each line verbatim and classifies by substring), and `session.ts::runStdoutDrain` around line 6447 (claude stdout, `trim()` then `handleClaudeLineGuarded`). Each decodes with a streaming `TextDecoder`, appends to a string, and slices on `indexOf("\n")`. The bodies differ only in what they do with a line. **(verified)**

**[F02] No ceiling** — none of the three bounds `buffer`. A child that emits megabytes without a newline, or a corrupted stream, grows the string until the process dies. The equivalent carry buffer in `tugapp/Sources/ProcessManager.swift::logPipe` has the same shape. **(verified)**

**[F03] The stdin write ignores its result** — `session.ts` near line 8086: `stdin.write(userInput); stdin.flush();`. Bun's `FileSink.write` returns the bytes accepted or a promise when the pipe is full; `flush` returns the same. Neither is read. The largest single message is bounded by `MAX_IMAGE_SIZE_BYTES` (5 MB decoded, `session.ts:170`), so one message into a wedged child is 5 MB of kernel and Bun buffering with no signal to the caller. **(verified)**

**[F04] Lines over a few megabytes are not a legitimate input** — stream-json frames from claude are one JSON object per line; the largest the catalog fixtures hold (`tugrust/crates/tugcast/tests/fixtures/stream-json-catalog/`) are tool results, which claude itself truncates. A cap in the tens of megabytes is above anything real and below anything that would take the process down. **(verified for the catalog; the ceiling claude applies to a tool result is not pinned here)**

**[F05] Existing tests reach the drain only through private pokes** — `session.test.ts` monkeypatches `(manager as any).spawnClaude` to feed stdout; there is no unit under test for the splitting itself. **(verified)**

---

## Decisions {#decisions}

**[B01] One `LineSplitter` class in `tugcode/src/line-splitter.ts` with `push(chunk: Uint8Array): string[]`, `end(): string | null`, and a `maxLineBytes` option.** It owns the `TextDecoder` and the carry. A line that crosses the cap is dropped, counted, and logged once through `logSessionLifecycle` with the stream name and the byte count; the splitter then resynchronises at the next newline rather than dying. Trimming and empty-line skipping stay with the callers, since stdin wants them and stderr must forward verbatim ([F01]).

**[B02] All three readers use it; `ipc.ts::readLine` stays an async generator over it.** The stderr classifier keeps its first-match-wins substring rule unchanged; this brief does not touch what the lines mean.

**[B03] The cap is 16 MiB.** Above any frame the catalog has seen ([F04]) by an order of magnitude, below the point where a runaway stream matters. One constant, in the splitter, named so a future reader finds the reasoning.

**[B04] `stdin.write` and `flush` results are awaited, and the session records `stdinBackpressured` while a write is pending.** A write that does not complete within the existing turn timeout is surfaced through the same path a stalled turn already takes; nothing new is invented for the user. No second queue in front of Bun's: one queue is one place to be wrong.

**[B05] The Swift `logPipe` carry is out of scope.** It reads Vite and tugcast log lines, which are bounded by the writers, and it lives in a different build. Noted so it is not forgotten.

---

## Open Questions {#open-questions}

- None. The splitter is a pure function with a test; the write change is three lines plus the flag.

---

## Non-goals {#non-goals}

- **Retyping the frames the splitter yields.** The untyped stream-json wire is item 16 of the punch list and its own arc.
- **Changing the stderr classification strings.** Pinning them to the catalog drift test is item 9's territory.
- **A general backpressure queue with its own cap in front of claude's stdin.** [B04] says why.

---

## Exit {#exit}

An arc. Two steps: the splitter with unit tests (chunk boundaries inside a multibyte character, a line split across chunks, an over-cap line followed by a normal one, `end()` with a partial line) and the three call sites moved onto it; then the awaited stdin writes with a test that feeds a never-draining fake stdin and asserts the flag and the timeout path. `bun test` in `tugcode/` is the verdict for both; the `@covers`-derived app-test selection for `session.ts` runs once after the second step.
