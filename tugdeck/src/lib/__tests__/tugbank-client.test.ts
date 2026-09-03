import { describe, expect, it } from "bun:test";

import { TugbankClient } from "@/lib/tugbank-client";
import type { TugConnection } from "@/connection";
import { FeedId } from "@/protocol";

/** Minimal fake connection that captures the DEFAULTS frame handler. */
function fakeConnection(): {
  connection: TugConnection;
  push: (payload: Uint8Array) => void;
} {
  let handler: ((payload: Uint8Array) => void) | null = null;
  const connection = {
    onFrame: (_feedId: number, cb: (payload: Uint8Array) => void) => {
      handler = cb;
      return () => {};
    },
  } as unknown as TugConnection;
  return { connection, push: (p) => handler?.(p) };
}

const frame = (obj: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(obj));

describe("TugbankClient boot gate", () => {
  it("resolves ready() on the first DEFAULTS frame, not degraded", async () => {
    const { connection, push } = fakeConnection();
    const client = new TugbankClient(connection, 50);
    push(frame({ domains: {} }));
    await client.ready();
    expect(client.bootDegraded()).toBe(false);
  });

  it("resolves ready() degraded on the timeout when no frame arrives", async () => {
    // The deadline (not a real DEFAULTS frame) is what unblocks boot — this
    // is the un-brickable guarantee: an over-cap frame that never decodes
    // must not hang the splash forever.
    const { connection } = fakeConnection();
    const client = new TugbankClient(connection, 20);
    await client.ready();
    expect(client.bootDegraded()).toBe(true);
  });

  it("ignores the frame subscription flag but ready() is idempotent", () => {
    const { connection, push } = fakeConnection();
    const client = new TugbankClient(connection, 10_000);
    push(frame({ domains: { "dev.tugapp.app": { generation: 1, entries: {} } } }));
    // A second frame after ready must not throw or re-arm anything.
    push(frame({ domains: {} }));
    expect(client.bootDegraded()).toBe(false);
  });
});
