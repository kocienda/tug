// JSON-lines IPC protocol implementation

import type {
  ErrorEvent,
  ErrorFrameSite,
  InboundMessage,
  OutboundMessage,
} from "./types.ts";
import { isInboundMessage } from "./types.ts";
import { logSessionLifecycle } from "./session-lifecycle-log.ts";

/**
 * Async generator that reads JSON lines from stdin.
 * Yields valid InboundMessage objects, logs invalid lines to stderr.
 */
export async function* readLine(): AsyncGenerator<InboundMessage, void, unknown> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });

    let lineEnd = buffer.indexOf("\n");
    while (lineEnd >= 0) {
      const line = buffer.slice(0, lineEnd).trim();
      buffer = buffer.slice(lineEnd + 1);

      if (line.length > 0) {
        const msg = validateMessage(line);
        if (msg) {
          yield msg;
        }
      }

      lineEnd = buffer.indexOf("\n");
    }
  }
}

/**
 * Promise-chain tail that serializes every `Bun.write` to stdout.
 *
 * **Why this is required.** `Bun.write(Bun.stdout, ...)` is async,
 * and a single message larger than the OS pipe buffer (~64 KiB on
 * macOS, ~64 KiB on Linux) is written via multiple `write(2)`
 * syscalls under the hood. Concurrent `writeLine` calls that each
 * exceed the pipe buffer can therefore **interleave** at the syscall
 * level: bytes from message B land in the middle of message A's
 * stdout output. Tugcast's `BufReader::lines()` then reads a
 * `\n`-terminated unit that's a corrupted concatenation, and the
 * downstream `splice_tug_session_id` / `Frame::new` produces a wire
 * frame whose header length is consistent with the corrupted line
 * but whose payload doesn't parse as JSON on the browser side.
 *
 * The replay path is where this surfaces — it emits frames in rapid
 * succession (per-JSONL-entry), and an image-bearing
 * `add_user_message` is large enough to trigger multi-syscall
 * splitting. Pre-Step-5c, image attachments were always small
 * because they were nested in JSON content blocks already; the same
 * corruption would have been latent then but hidden by the
 * already-small frame sizes. Post-Step-5c the wire shape moves
 * image bytes through CODE_OUTPUT during replay (the `content`
 * array carries the image inline), so the threshold gets crossed
 * routinely.
 *
 * The fix: maintain a single `Promise` tail; every `writeLine` awaits
 * the prior tail before issuing its own `Bun.write`, and updates the
 * tail to its own completion. The chain is fire-and-forget at the
 * call site — callers never see the promise — but the writes
 * themselves are strictly ordered. Cost is one closure + microtask
 * per `writeLine`; the underlying `write(2)` syscall sequence
 * matches the call sequence on a per-message granularity.
 *
 * `writeLineAndExit` continues to await directly because it needs
 * the bytes flushed before `process.exit` is called; it slots into
 * the same tail so its emission is also serialized with prior
 * `writeLine` calls.
 */
let writeTail: Promise<unknown> = Promise.resolve();

/**
 * Write an outbound message as a JSON line to stdout.
 *
 * Fire-and-forget for the caller, but **serialized** with all other
 * `writeLine` / `writeLineAndExit` calls so concurrent large writes
 * cannot interleave at the syscall level. See `writeTail`'s docstring
 * for the corruption pattern this prevents.
 */
export function writeLine(msg: OutboundMessage): void {
  const json = JSON.stringify(msg) + "\n";
  writeTail = writeTail.then(() => Bun.write(Bun.stdout, json));
}

/**
 * Wait for every `writeLine` queued before this call to flush to
 * stdout. Test helpers (`captureStdout` / `captureIpcOutput`) call
 * this after `await fn()` to ensure all queued writes have hit the
 * mock `Bun.write` before assertion.
 *
 * Production callers don't normally need this — `writeLine` is
 * fire-and-forget by design — but a flush point is useful at clean
 * shutdown / replay-completion boundaries where the caller wants
 * "all my emissions are visible to downstream" semantics.
 *
 * Idempotent and cheap when the queue is empty (resolves on the
 * next microtask).
 */
export async function drainPendingWrites(): Promise<void> {
  // Snapshot the current tail and await it. New writeLine calls
  // appended after this snapshot are NOT awaited by this call —
  // they'd be drained by a subsequent call.
  await writeTail;
}

/**
 * Write a final outbound message and call `process.exit(code)` only
 * after the bytes have been flushed to stdout. Used by the early-exit
 * watcher in `SessionManager` so the bridge actually receives the
 * `resume_failed` / `error` IPC line before tugcode dies — a plain
 * `writeLine(...); process.exit(...)` races the async write against
 * the exit and silently drops the frame.
 *
 * Awaits `Bun.write` (which only resolves once the bytes are in the
 * stdout pipe) before exiting. Goes through the same `Bun.write`
 * path as `writeLine` so test mocks see it identically.
 */
export async function writeLineAndExit(
  msg: OutboundMessage,
  code: number,
): Promise<void> {
  // Wait for any prior `writeLine` calls to drain so this exit-bound
  // frame doesn't race ahead of in-flight serialized writes, then
  // perform a direct (non-chained) `Bun.write` so the bytes are on
  // the pipe before `process.exit` fires. The chained-`.then(...)`
  // path adds one microtask before the actual write begins; for an
  // exit-bound frame that's enough for `process.exit` to fire while
  // the write is still pending, producing a zero-byte stdout the
  // bridge can't parse.
  await writeTail;
  const json = JSON.stringify(msg) + "\n";
  await Bun.write(Bun.stdout, json);
  process.exit(code);
  // process.exit normally never returns. In tests `process.exit` is
  // stubbed to a no-op so the test process survives — let the function
  // simply return in that case rather than throwing.
}

/**
 * Build an `error` frame and log a `tugcode.error_frame` line beside it.
 *
 * An `error` frame is the bridge's most consequential outbound message —
 * the only one that locks a card body behind the deck's "Protocol error"
 * banner — and for a long time it was the one frame emitted with no
 * telemetry at all, so tugcast's `tugcode_stderr` capture could not say
 * which of the dozen sites had fired. This builder is the single
 * construction point: the log line and the frame carry the same `site`,
 * and a `grep tugcode.error_frame` answers "which frame" in one read.
 *
 * Callers that write to stdout want {@link emitErrorFrame}; this builder is
 * for the two paths that cannot — an exit-bound frame going through
 * {@link writeLineAndExit}, and a frame pushed into a batch of translated
 * replay messages.
 */
export function errorFrame(
  site: ErrorFrameSite,
  message: string,
  recoverable: boolean,
): ErrorEvent {
  logSessionLifecycle("tugcode.error_frame", { site, message, recoverable });
  return { type: "error", message, recoverable, site, ipc_version: 2 };
}

/**
 * Write an `error` frame to stdout and log it. The ordinary emit path;
 * see {@link errorFrame} for why every site goes through one of the two.
 */
export function emitErrorFrame(
  site: ErrorFrameSite,
  message: string,
  recoverable: boolean,
): void {
  writeLine(errorFrame(site, message, recoverable));
}

/**
 * Validate and parse a JSON line into an InboundMessage.
 * Returns null on failure, logs error to stderr.
 */
export function validateMessage(raw: string): InboundMessage | null {
  try {
    const parsed = JSON.parse(raw);
    if (isInboundMessage(parsed)) {
      return parsed;
    } else {
      console.error(`[tugcode] Invalid message type: ${JSON.stringify(parsed)}`);
      return null;
    }
  } catch (err) {
    console.error(`[tugcode] JSON parse error: ${err}`);
    return null;
  }
}
