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
  /** Sockets whose handshake was answered; each new client handshakes for itself. */
  const handshaken = new WeakSet<ServerWebSocket<unknown>>();

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
          if (!handshaken.has(ws)) {
            handshaken.add(ws);
            ws.send(JSON.stringify({ protocol: "tugcast", version: 1, capabilities: [] }));
          }
          return;
        }
        received.push(new Uint8Array(message));
      },
      close(ws) {
        // A socket that closes after a newer one opened — a replaced host's,
        // say — leaves the newer client alone.
        if (client !== ws) return;
        client = null;
      },
    },
  });

  return {
    url: `ws://127.0.0.1:${server.port}/ws`,
    received,
    handshaken: () => client !== null && handshaken.has(client),
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
