/**
 * A fake tugcast for tests that drive the ingest host over a real socket:
 * a `Bun.serve` WebSocket that answers tugcast's text handshake
 * (`{protocol:"tugcast", version:1}`) and then lets the test push raw binary
 * messages — whole frames, several frames, or a frame cut anywhere — exactly
 * as the `/ws` proxy may deliver them. Everything the client writes is kept,
 * in order.
 */

import type { ServerWebSocket } from "bun";

export interface FakeTugcast {
  /** The `ws://` URL to connect to. */
  readonly url: string;
  /** Text and binary messages the client sent, in order. */
  readonly received: Array<string | Uint8Array>;
  /** Whether a client has completed the handshake. */
  readonly handshaken: () => boolean;
  /** Push one binary WebSocket message to the connected client. */
  sendBinary(bytes: Uint8Array): void;
  /** Close the connected client's socket from the server side. */
  hangUp(code?: number, reason?: string): void;
  stop(): void;
}

export function startFakeTugcast(): FakeTugcast {
  const received: Array<string | Uint8Array> = [];
  let client: ServerWebSocket<unknown> | null = null;
  let handshaken = false;

  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined;
      return new Response("websocket only", { status: 400 });
    },
    websocket: {
      open(ws) {
        client = ws;
      },
      message(ws, message) {
        if (typeof message === "string") {
          received.push(message);
          if (!handshaken) {
            handshaken = true;
            ws.send(JSON.stringify({ protocol: "tugcast", version: 1, capabilities: [] }));
          }
          return;
        }
        received.push(new Uint8Array(message));
      },
      close() {
        client = null;
        handshaken = false;
      },
    },
  });

  return {
    url: `ws://127.0.0.1:${server.port}/ws`,
    received,
    handshaken: () => handshaken,
    sendBinary(bytes) {
      if (client === null) throw new Error("fake tugcast: no client connected");
      client.sendBinary(bytes);
    },
    hangUp(code = 1001, reason = "") {
      client?.close(code, reason);
    },
    stop() {
      server.stop(true);
    },
  };
}
