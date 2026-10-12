/**
 * `whenSettled()` and `isSettled()` — the explicit path for a reader that
 * must see what its own action did ([P09]).
 *
 * The store is a mirror of an engine that, in production, answers from the
 * ingest Worker one message hop later. Here the hop is made visible: the
 * connection's channel holds every batch the host posts until the test
 * releases it. Both answer at once when nothing is outstanding; after an
 * action they wait for the engine's acknowledgment of it — of the last seq
 * posted before the call, not of later ones — and a dispose releases anyone
 * still waiting.
 */

import { describe, expect, it } from "bun:test";

import { TugConnection } from "@/connection";
import { CodeSessionStore } from "@/lib/code-session-store";
import { ConnectionLifecycle } from "@/lib/connection-lifecycle";
import { InProcessIngestChannel, type IngestChannel } from "@/lib/ingest/ingest-channel";
import type { SessionBatch, SessionControl } from "@/lib/ingest/session-patch";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";

/** An in-process channel whose batches wait for {@link HeldChannel.release}. */
class HeldChannel implements IngestChannel {
  private readonly inner = new InProcessIngestChannel();
  private readonly held: SessionBatch[] = [];
  private listener: ((batch: SessionBatch) => void) | null = null;

  constructor() {
    this.inner.setBatchListener((batch) => this.held.push(batch));
  }
  post(control: SessionControl, transfer?: ArrayBuffer[]): void {
    this.inner.post(control, transfer);
  }
  setBatchListener(listener: (batch: SessionBatch) => void): void {
    this.listener = listener;
  }
  setFailureListener(): void {}
  dispose(): void {
    this.inner.dispose();
  }
  /** Deliver the first `count` held batches (all of them by default). */
  release(count = this.held.length): void {
    for (const batch of this.held.splice(0, count)) this.listener?.(batch);
  }
  get pending(): number {
    return this.held.length;
  }
}

function makeStore(): { store: CodeSessionStore; channel: HeldChannel } {
  const channel = new HeldChannel();
  const conn = new TugConnection("ws://test.invalid/ws", { channel });
  const store = new CodeSessionStore({
    conn,
    lifecycle: new ConnectionLifecycle(),
    tugSessionId: FIXTURE_IDS.TUG_SESSION_ID,
    sessionMode: "new",
  });
  channel.release();
  return { store, channel };
}

/** Whether `promise` has resolved, after letting queued microtasks run. */
async function resolved(promise: Promise<void>): Promise<boolean> {
  let done = false;
  void promise.then(() => {
    done = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  return done;
}

describe("CodeSessionStore.whenSettled / isSettled", () => {
  it("answers at once when nothing is outstanding", async () => {
    const { store } = makeStore();
    expect(store.isSettled()).toBe(true);
    expect(await resolved(store.whenSettled())).toBe(true);
  });

  it("waits for the acknowledgment of the action, and the mirror reads what it did once it comes", async () => {
    const { store, channel } = makeStore();
    store.send("hello", []);
    expect(store.isSettled()).toBe(false);
    // The mirror has not heard back: the send has not reached it.
    expect(store.getSnapshot().phase).toBe("idle");
    const settled = store.whenSettled();
    expect(await resolved(settled)).toBe(false);

    channel.release();
    expect(store.isSettled()).toBe(true);
    expect(await resolved(settled)).toBe(true);
    expect(store.getSnapshot().phase).toBe("submitting");
  });

  it("waits for the last seq posted before the call, not for later ones", async () => {
    const { store, channel } = makeStore();
    store.send("first", []);
    const first = store.whenSettled();
    store.send("second", []);
    const second = store.whenSettled();
    expect(channel.pending).toBe(2);

    channel.release(1);
    expect(await resolved(first)).toBe(true);
    expect(await resolved(second)).toBe(false);
    expect(store.isSettled()).toBe(false);

    channel.release();
    expect(await resolved(second)).toBe(true);
    expect(store.isSettled()).toBe(true);
  });

  it("releases anyone still waiting when the store is disposed", async () => {
    const { store } = makeStore();
    store.send("hello", []);
    const settled = store.whenSettled();
    store.dispose();
    expect(await resolved(settled)).toBe(true);
    expect(store.isSettled()).toBe(true);
  });

  it("bounded: a host that never answers ends the wait at the budget, and the mirror is read as it stands", async () => {
    const { store, channel } = makeStore();
    store.send("hello", []);
    expect(await store.whenSettledWithin(20)).toBe(false);
    expect(store.getSnapshot().phase).toBe("idle");
    // The expired wait left nothing behind: a later answer still settles the store.
    channel.release();
    expect(store.isSettled()).toBe(true);
  });

  it("bounded: an answer inside the budget settles the wait as true", async () => {
    const { store, channel } = makeStore();
    store.send("hello", []);
    const settled = store.whenSettledWithin(5_000);
    channel.release();
    expect(await settled).toBe(true);
    expect(store.getSnapshot().phase).toBe("submitting");
  });
});
