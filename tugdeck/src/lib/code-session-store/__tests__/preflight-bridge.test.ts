/**
 * The resume preflight beat across the ingest Worker's hop.
 *
 * `notifyResumeBindingLanded()` opens `replayPreflightActive`, and that beat
 * is what raises `TugRestoreGate` before a resumed card's body mounts. The
 * reducer runs in the engine, one message hop away in production, so the
 * mirror raises the beat itself the moment the binding lands and holds it
 * until the engine acknowledges the action: from then on the engine's own
 * snapshot says whether the beat is up. Here the hop is made visible by a
 * channel that holds every batch until the test releases it.
 */

import { describe, expect, it } from "bun:test";

import { TugConnection } from "@/connection";
import { CodeSessionStore } from "@/lib/code-session-store";
import { ConnectionLifecycle } from "@/lib/connection-lifecycle";
import { InProcessIngestChannel, type IngestChannel } from "@/lib/ingest/ingest-channel";
import type { SessionBatch, SessionControl } from "@/lib/ingest/session-patch";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";
import { FeedId } from "@/protocol";

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
  /** Deliver every held batch. */
  release(): void {
    for (const batch of this.held.splice(0)) this.listener?.(batch);
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
    sessionMode: "resume",
  });
  channel.release();
  return { store, channel };
}

describe("the resume preflight beat across the engine's hop", () => {
  it("is up, and published, the moment the binding lands, before the engine answers", () => {
    const { store, channel } = makeStore();
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    expect(store.getSnapshot().replayPreflightActive).toBe(false);

    store.notifyResumeBindingLanded();
    expect(channel.pending).toBeGreaterThan(0);
    expect(store.getSnapshot().replayPreflightActive).toBe(true);
    expect(notified).toBe(1);

    // The engine's answer carries the beat itself.
    channel.release();
    expect(store.isSettled()).toBe(true);
    expect(store.getSnapshot().replayPreflightActive).toBe(true);
  });

  it("ends at the acknowledgment, so a beat the engine declined reads down", () => {
    const { store, channel } = makeStore();
    // The replay starts in the engine before the binding's action reaches
    // it, so the engine declines the beat: the card is no longer idle there.
    store._ingestFrameForTest(FeedId.CODE_OUTPUT, {
      type: "replay_started",
      ipc_version: 2,
      tug_session_id: FIXTURE_IDS.TUG_SESSION_ID,
    });
    store.notifyResumeBindingLanded();
    expect(store.getSnapshot().replayPreflightActive).toBe(true);

    channel.release();
    expect(store.getSnapshot().phase).toBe("replaying");
    expect(store.getSnapshot().replayPreflightActive).toBe(false);
  });
});
