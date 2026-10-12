/// <reference lib="webworker" />

/**
 * `ingest-worker` — the dedicated module Worker that holds tugcast's socket.
 *
 * The page's `TugConnection` is a facade over this thread. Here one
 * `IngestHost` owns the WebSocket, its handshake, heartbeat, watchdog and
 * reconnect, and the framing; it posts what the wire produced to the page as
 * batches of patches, paced to the display period by a `Pacer`, with the
 * payload buffers transferred. The page answers with controls.
 *
 * Logging from this thread cannot reach the page's log stores directly —
 * loading them here would make a second, unread copy — so the dev-log port's
 * sink turns each call into a `log` patch the page replays.
 *
 * A control the host throws out of leaves its state unknown, so the Worker
 * does not carry on: it posts one `failed` message, and the page replaces this
 * thread with a host of its own. A throw the Worker does not catch — its
 * module failing to load, or one out of a socket or timer callback — reaches
 * the page as the Worker's `error` event, to the same end.
 *
 * ## The spike
 *
 * A `spike` message runs the platform proof the Worker rests on, outside the
 * protocol: open the page's own `ws://<host>/ws`, complete tugcast's
 * handshake, subscribe to the feeds the message names (snapshot feeds, whose
 * retained value tugcast delivers on subscribe, so a frame arrives without
 * waiting on the 15 s heartbeat), and transfer the first binary frame back.
 * `at0726` keeps guarding that this WebKit allows it. The page's own socket
 * is not touched; tugcast serves any number of clients.
 */

import { controlFrame, encodeFrame } from "@/protocol";
import { installDevLogSink } from "@/lib/dev-log-port";
import { IngestHost } from "@/lib/ingest/ingest-host";
import { Pacer } from "@/lib/ingest/pacer";
import type { IngestWorkerFailure } from "@/lib/ingest/ingest-channel";
import type { SessionControl } from "@/lib/ingest/session-patch";

/** Asks the Worker to prove it can hold the socket. */
export interface IngestSpikeRequest {
  readonly kind: "spike";
  readonly wsUrl: string;
  readonly feeds: readonly number[];
}

/** What the spike saw: the handshake reply, one frame's bytes, and the Worker's globals. */
export type IngestSpikeResponse =
  | {
      readonly kind: "spike-result";
      readonly ok: true;
      readonly handshake: { protocol?: unknown; version?: unknown };
      readonly firstFrameBytes: ArrayBuffer;
      readonly hasRaf: boolean;
    }
  | {
      readonly kind: "spike-result";
      readonly ok: false;
      readonly stage: "open" | "handshake" | "frame";
      readonly error: string;
      readonly hasRaf: boolean;
    };

const PROTOCOL_NAME = "tugcast";
const PROTOCOL_VERSION = 1;

const scope = self as unknown as DedicatedWorkerGlobalScope;

function runSpike(request: IngestSpikeRequest): void {
  const hasRaf = typeof (scope as { requestAnimationFrame?: unknown }).requestAnimationFrame === "function";
  let stage: "open" | "handshake" | "frame" = "open";
  let settled = false;
  let handshake: { protocol?: unknown; version?: unknown } | null = null;

  const fail = (error: string): void => {
    if (settled) return;
    settled = true;
    const response: IngestSpikeResponse = { kind: "spike-result", ok: false, stage, error, hasRaf };
    scope.postMessage(response);
    ws.close();
  };

  const ws = new WebSocket(request.wsUrl);
  ws.binaryType = "arraybuffer";

  ws.onopen = () => {
    stage = "handshake";
    ws.send(JSON.stringify({ protocol: PROTOCOL_NAME, version: PROTOCOL_VERSION }));
  };

  ws.onmessage = (event: MessageEvent) => {
    if (settled) return;
    if (handshake === null) {
      if (typeof event.data !== "string") {
        fail("expected a text handshake reply, got binary");
        return;
      }
      try {
        handshake = JSON.parse(event.data) as { protocol?: unknown; version?: unknown };
      } catch {
        fail(`handshake reply is not JSON: ${event.data.slice(0, 120)}`);
        return;
      }
      if (handshake.protocol !== PROTOCOL_NAME || handshake.version !== PROTOCOL_VERSION) {
        fail(`handshake reply names ${String(handshake.protocol)} v${String(handshake.version)}`);
        return;
      }
      stage = "frame";
      ws.send(encodeFrame(controlFrame("subscribe_feeds", { feeds: [...request.feeds] })));
      return;
    }
    if (!(event.data instanceof ArrayBuffer) || event.data.byteLength === 0) return;
    settled = true;
    const bytes = event.data;
    const response: IngestSpikeResponse = {
      kind: "spike-result",
      ok: true,
      handshake,
      firstFrameBytes: bytes,
      hasRaf,
    };
    scope.postMessage(response, [bytes]);
    ws.close();
  };

  ws.onerror = () => fail("the socket reported an error");
  ws.onclose = (event: CloseEvent) => fail(`the socket closed (${event.code}${event.reason ? `: ${event.reason}` : ""})`);
}

const host = new IngestHost(
  (batch, transfer) => scope.postMessage(batch, transfer),
  (flush, periodMs) => new Pacer(flush, periodMs),
  { awaitPageAck: true },
);

installDevLogSink({
  log: (level, source, message, data) => host.log({ level, source, message, data }),
  lifecycle: (tag, fields) => host.log({ lifecycle: { tag, fields } }),
});

scope.onmessage = (event: MessageEvent<SessionControl | IngestSpikeRequest>) => {
  const message = event.data;
  if (message.kind === "spike") {
    runSpike(message);
    return;
  }
  try {
    host.handle(message);
  } catch (err) {
    const failure: IngestWorkerFailure = {
      kind: "failed",
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    };
    scope.postMessage(failure);
  }
};
