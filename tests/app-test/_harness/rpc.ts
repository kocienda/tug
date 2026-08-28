/**
 * rpc.ts — Hand-written RPC client for the in-app test bridge.
 *
 * Wire format: newline-delimited JSON (NDJSON), one request or
 * response per line. Every request
 * carries a unique numeric `id`; the response shares it. Requests
 * and responses may interleave on the wire — correlation is by id.
 *
 * Error translation: when the server replies with `{ ok: false,
 * error: { name, message, stack? } }`, we map `error.name` onto one
 * of our classes (TimeoutError / AppCrashedError / VersionSkewError)
 * so test code can `catch (e) { if (e instanceof TimeoutError) ... }`.
 * Unknown names fall back to a plain `Error` whose `.name` is
 * preserved from the wire value.
 *
 * Transport: the caller passes in a duplex `Bun.Socket`-like handle
 * carrying `.write(buf)` and a push-based data stream. The RPC
 * client owns framing; it does not own socket lifecycle.
 *
 * NOT included here: subprocess lifecycle, version handshake,
 * `App` class wrappers — those live in `./index.ts`.
 */

import {
  AccessibilityPermissionMissingError,
  ActivationClickObstructedError,
  AppCrashedError,
  AppLifecycleTimeoutError,
  CoordinateOutOfBoundsError,
  NativeTypeAsciiOnlyError,
  TimeoutError,
  TugcodeLaunchError,
  TugcodeTranscriptMismatchError,
  TugcodeVersionSkewError,
  UnknownKeyError,
  VersionSkewError,
} from "./errors";
import type { Request, Response } from "./types";

/**
 * Per-variant "no id" request shape. `Omit<Request, "id">` on a
 * discriminated union collapses the variants; this distributive
 * helper preserves them.
 */
type RequestWithoutId = Request extends infer R
  ? R extends { id: number }
    ? Omit<R, "id">
    : never
  : never;

/**
 * Duplex transport the RPC client expects. Minimal surface so we can
 * feed it a real `Bun.Socket` in production and a mock in unit tests.
 */
export interface RpcTransport {
  /** Write raw bytes; must be a single framed line (ending in `\n`). */
  write(data: string): void;
  /**
   * Register a handler that receives raw chunks from the server. The
   * RPC client maintains its own line-buffer.
   */
  onData(handler: (chunk: string) => void): void;
  /** Register a handler invoked when the transport closes. */
  onClose(handler: (reason: { exitCode?: number | null; signal?: string | null }) => void): void;
}

/**
 * Multiplier on every RPC timeout budget, from `TUG_APPTEST_TIMEOUT_SCALE`.
 *
 * The budgets are sized for a file that has the machine to itself. Under the
 * parallel background runner several apps boot, render and settle at once, so the
 * same work legitimately takes longer in wall time — a budget that does not travel
 * with the contention turns concurrency into a wall of timeouts that look like
 * failures. The runner sets this to its own job count.
 *
 * At the default of 1 nothing is rewritten: a serial run puts exactly the bytes on
 * the wire it always did, including leaving the field absent so the server applies
 * its own per-method default.
 */
export const TIMEOUT_SCALE = ((): number => {
  const raw = Number(process.env.TUG_APPTEST_TIMEOUT_SCALE);
  if (!Number.isFinite(raw) || raw < 1) return 1;
  return Math.min(raw, 10);
})();

/**
 * The budget a caller's `timeoutMs` is actually enforced at, once the parallel
 * runner's scale is applied. A test asserting on a `TimeoutError`'s budget
 * wants this number, not the pre-scaling ask — the error reports what the
 * server was told to wait, which under contention is deliberately larger.
 */
export function enforcedTimeout(askedMs: number): number {
  return Math.round(askedMs * TIMEOUT_SCALE);
}

/**
 * The server's own per-method default budget, mirrored here so a scaled run can
 * restate it as an explicit number. Kept in step with
 * `TestHarnessConnection.swift`, which reads `timeoutMs ?? 5000` for `evalJS` and
 * `timeoutMs ?? 2000` for `waitForCondition`. A method absent from this table is
 * never given a default by the client — its budget stays the server's business.
 */
const SERVER_DEFAULT_TIMEOUT_MS: Record<string, number> = {
  evalJS: 5000,
  waitForCondition: 2000,
};

/**
 * The budget to put on the wire for `method`, given whatever the caller asked for.
 *
 * An explicit `timeoutMs` is scaled, not replaced — it is the caller's considered
 * number, and under contention it needs the same room every other budget gets.
 */
function scaledTimeout(method: string, explicit: number | undefined): number | undefined {
  if (TIMEOUT_SCALE === 1) return explicit;
  if (explicit !== undefined) return Math.round(explicit * TIMEOUT_SCALE);
  const serverDefault = SERVER_DEFAULT_TIMEOUT_MS[method];
  return serverDefault === undefined ? undefined : Math.round(serverDefault * TIMEOUT_SCALE);
}

/**
 * One in-flight RPC call.
 */
interface PendingCall {
  id: number;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  script?: string;
  timeoutMs?: number;
}

/**
 * The RPC client. Owns framing, id correlation, and error translation.
 * Lifecycle is managed by the caller (`close()` rejects all pending
 * calls with `AppCrashedError`).
 */
export class RpcClient {
  private readonly transport: RpcTransport;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private buffer = "";
  private closed = false;
  private closeReason: { exitCode?: number | null; signal?: string | null } = {};

  constructor(transport: RpcTransport) {
    this.transport = transport;
    transport.onData((chunk) => {
      this.ingest(chunk);
    });
    transport.onClose((reason) => {
      this.handleClose(reason);
    });
  }

  /**
   * Send a request and return a promise resolving to the response's
   * `value` (or throwing a translated error on `ok: false`).
   *
   * Note: the server enforces its own hard timeouts. The client-side
   * promise will resolve as soon as the server sends a response; we
   * do not duplicate the timer here. If the socket disconnects
   * before a response, `close()` rejects with `AppCrashedError`.
   */
  call<T>(req: RequestWithoutId): Promise<T> {
    if (this.closed) {
      return Promise.reject(
        new AppCrashedError(
          "RPC transport closed before call could be sent",
          this.closeReason.exitCode,
          this.closeReason.signal,
        ),
      );
    }
    const id = this.nextId++;
    const asked = "timeoutMs" in req ? (req as { timeoutMs?: number }).timeoutMs : undefined;
    const timeoutMs = scaledTimeout((req as { method: string }).method, asked);
    // Only carry the field when there is a number to carry: omitting it is how a
    // serial run lets the server apply its own default, and re-adding it as
    // `undefined` would serialize the key with a null on some JSON paths.
    const full = { ...req, ...(timeoutMs === undefined ? {} : { timeoutMs }), id } as Request;
    const line = `${JSON.stringify(full)}\n`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        id,
        resolve: resolve as (v: unknown) => void,
        reject,
        script: "script" in req ? (req as { script?: string }).script : undefined,
        timeoutMs,
      });
      try {
        this.transport.write(line);
      } catch (err) {
        this.pending.delete(id);
        reject(
          err instanceof Error
            ? err
            : new Error(`RPC transport write failed: ${String(err)}`),
        );
      }
    });
  }

  /**
   * Feed one chunk of server → client bytes into the RPC client.
   * Buffers across chunks until a `\n` is seen, then parses and
   * dispatches each line.
   */
  private ingest(chunk: string): void {
    this.buffer += chunk;
    let idx = this.buffer.indexOf("\n");
    while (idx !== -1) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.length > 0) {
        this.dispatchLine(line);
      }
      idx = this.buffer.indexOf("\n");
    }
  }

  private dispatchLine(line: string): void {
    let parsed: Response<unknown>;
    try {
      parsed = JSON.parse(line) as Response<unknown>;
    } catch (err) {
      // Malformed server output. Reject all pending calls; the server
      // is likely corrupt. This is a fatal-for-this-connection case.
      const msg = `RPC malformed server line: ${String(err)} (line=${line.slice(0, 120)})`;
      this.rejectAllPending(new Error(msg));
      return;
    }
    if (typeof parsed.id !== "number") {
      return; // discard — we never correlated against this
    }
    const pending = this.pending.get(parsed.id);
    if (!pending) {
      return; // response for unknown request; ignore
    }
    this.pending.delete(parsed.id);
    if (parsed.ok === true) {
      pending.resolve(parsed.value);
      return;
    }
    const err = translateError(
      parsed.error,
      pending.script,
      pending.timeoutMs,
    );
    pending.reject(err);
  }

  private handleClose(reason: { exitCode?: number | null; signal?: string | null }): void {
    this.closed = true;
    this.closeReason = reason;
    this.rejectAllPending(
      new AppCrashedError(
        `Tug.app subprocess exited (exitCode=${reason.exitCode ?? "null"}, signal=${reason.signal ?? "null"})`,
        reason.exitCode,
        reason.signal,
      ),
    );
  }

  private rejectAllPending(err: Error): void {
    const snapshot = Array.from(this.pending.values());
    this.pending.clear();
    for (const p of snapshot) {
      p.reject(err);
    }
  }
}

/**
 * Translate a wire `error` object into a JS error class. Exposed for
 * unit tests.
 *
 * Rules:
 * - `name === "TimeoutError"` → `TimeoutError`
 * - `name === "AppCrashedError"` → `AppCrashedError`
 * - `name === "VersionSkewError"` → `VersionSkewError`
 *   (expected / actual are best-effort, pulled from message if absent)
 * - `name === "CoordinateOutOfBoundsError"` → `CoordinateOutOfBoundsError` (Phase A)
 * - `name === "NativeTypeAsciiOnlyError"` → `NativeTypeAsciiOnlyError` (Phase A)
 * - `name === "AccessibilityPermissionMissingError"` →
 *   `AccessibilityPermissionMissingError` (Phase A preflight)
 * - `name === "UnknownKeyError"` → `UnknownKeyError` (Phase A)
 * - any other `name` → plain `Error` with `.name` copied from wire
 */
export function translateError(
  wire: { name: string; message: string; stack?: string },
  script?: string,
  timeoutMs?: number,
): Error {
  switch (wire.name) {
    case "TimeoutError":
      return new TimeoutError(wire.message, script, timeoutMs);
    case "AppCrashedError":
      return new AppCrashedError(wire.message);
    case "VersionSkewError": {
      // Server typically embeds expected/actual in message; best-effort
      // parse, otherwise leave as empty strings for test readability.
      const m = wire.message.match(/expected=([^\s,]+).*actual=([^\s,)]+)/);
      const expected = m?.[1] ?? "";
      const actual = m?.[2] ?? "";
      return new VersionSkewError(wire.message, expected, actual);
    }
    case "CoordinateOutOfBoundsError":
      return new CoordinateOutOfBoundsError(wire.message);
    case "NativeTypeAsciiOnlyError":
      return new NativeTypeAsciiOnlyError(wire.message);
    case "AccessibilityPermissionMissingError":
      return new AccessibilityPermissionMissingError(wire.message);
    case "UnknownKeyError":
      return new UnknownKeyError(wire.message);
    case "ActivationClickObstructedError":
      return new ActivationClickObstructedError(wire.message);
    case "TugcodeLaunchError":
      return new TugcodeLaunchError(wire.message);
    case "TugcodeVersionSkewError": {
      // Server-side message format mirrors VersionSkewError:
      // "...expected=<v>...actual=<v>...". Best-effort parse;
      // either field defaults to "" when unrecognized.
      const m = wire.message.match(/expected=([^\s,]+).*actual=([^\s,)]+)/);
      const expected = m?.[1] ?? "";
      const actual = m?.[2] ?? "";
      return new TugcodeVersionSkewError(wire.message, expected, actual);
    }
    case "TugcodeTranscriptMismatchError": {
      // No structured fields on the wire today — the harness-side
      // sidecar verifier (transcript.ts) constructs this directly
      // with full path + hash context. Server emits a bare message
      // form for consistency; the typed fields fall back to "".
      return new TugcodeTranscriptMismatchError(wire.message, "", "", "");
    }
    case "AppLifecycleTimeoutError": {
      // Server message format: "NSApplication <event> notification did
      // not fire within <ms>ms". Best-effort parse so the error's
      // `event` field is populated; on miss, fall back to "" so test
      // code that doesn't branch on event isn't penalized.
      const m = wire.message.match(/NSApplication\s+(\w+)\s+notification/);
      const event = m?.[1] ?? "";
      return new AppLifecycleTimeoutError(wire.message, event);
    }
    default: {
      const err = new Error(wire.message);
      // Preserve the server-side name for `.name`-based switches.
      Object.defineProperty(err, "name", { value: wire.name });
      if (wire.stack) {
        (err as Error & { serverStack?: string }).serverStack = wire.stack;
      }
      return err;
    }
  }
}
