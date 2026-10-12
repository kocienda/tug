/**
 * A fake `WebSocket` for tests that drive the ingest host's wire half on the
 * calling thread: install it as the global, and drive the socket the host
 * opened through {@link FakeWebSocket.last}. Timers come from
 * {@link QUIET_TIMERS}, which record nothing and never fire, because the
 * lifecycles under test are event-driven.
 */

import type { WireTimers } from "../wire-socket";

export class FakeWebSocket {
  static last: FakeWebSocket | null = null;
  binaryType = "blob";
  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  readonly sent: Array<string | ArrayBufferLike> = [];
  constructor(readonly url: string) {
    FakeWebSocket.last = this;
  }
  send(data: string | ArrayBufferLike): void {
    this.sent.push(data);
  }
  close(): void {}
  fireOpen(): void {
    this.readyState = 1;
    this.onopen?.({} as Event);
  }
  fireMessage(data: string | ArrayBuffer): void {
    this.onmessage?.({ data } as MessageEvent);
  }
  fireClose(code = 1006, reason = ""): void {
    this.readyState = 3;
    this.onclose?.({ code, reason } as CloseEvent);
  }
}

/** Timers that record and never fire. */
export const QUIET_TIMERS: WireTimers = {
  setTimeout: () => 1,
  clearTimeout: () => {},
  setInterval: () => 1,
  clearInterval: () => {},
};

/** Install {@link FakeWebSocket} as the global; returns a restore. */
export function installFakeWebSocket(): () => void {
  const original = (globalThis as { WebSocket?: unknown }).WebSocket;
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
  return () => {
    (globalThis as unknown as { WebSocket: unknown }).WebSocket = original;
    FakeWebSocket.last = null;
  };
}

/** Open the socket and answer tugcast's handshake. */
export function handshake(ws: FakeWebSocket): void {
  ws.fireOpen();
  ws.fireMessage(JSON.stringify({ protocol: "tugcast", version: 1 }));
}
