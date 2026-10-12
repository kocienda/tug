/**
 * `session-link` — a mirror's line to its session engine.
 *
 * A `CodeSessionStore` is a mirror: the engine that reduces its session runs
 * in an ingest host, and the store reaches it through the `SessionLink` an
 * opener returns. The link carries the store's local actions and test frames
 * as controls, each with the next sequence number, and closes the engine when
 * the store is disposed. Patches come back to the `SessionPatchTarget` the
 * store handed the opener, and only while the link is open: a patch posted
 * under a handle whose mirror is gone is dropped ([P06]).
 *
 * The handle is minted here, once per open, and never reused, so a store
 * rebuilt for the same session id (the reconnect restore) can never receive
 * the patches its predecessor's engine posted.
 *
 * {@link openInProcessSession} is the opener for any frame source — the
 * a test channel, a test's bare `{ onFrame, send }` fake, or a connection
 * asked for something only this thread can hold. It hosts one `IngestHost`
 * per session on this thread behind the cloning channel, feeds it the
 * source's session-feed frames exactly as the store's own feed subscription
 * used to receive them (replay-on-subscribe included, so the host keeps no
 * replay of its own), and writes the engine's frames through the source's
 * `send`. The connection's own opener puts the engine in the connection's
 * host instead — the ingest Worker, in production.
 */

import type { FeedIdValue } from "@/protocol";
import type { IngestFindControl, IngestSessionOpenControl } from "@tugproto/ingest";
import type { CodeSessionEvent } from "@/lib/code-session-store/events";
import type { TimerSource } from "@/lib/code-session-store/session-engine";
import { InProcessIngestChannel } from "./ingest-channel";
import { ENGINE_FEEDS, type FlushPolicyFactory } from "./ingest-host";
import { applySessionBatch, type PatchTarget, type SessionPatchTarget } from "./session-patch";

/** What a store says about the session it opens. */
export type SessionOpenOptions = Omit<IngestSessionOpenControl, "kind" | "handle">;

/** A find query, as a link posts it for its session. */
export type SessionFindRequest = Omit<IngestFindControl, "kind" | "handle">;

/** What only an in-process host can take: functions, which cannot cross a thread. */
export interface SessionLocalOptions {
  /** The replay clock's timers; tests inject a manual source. */
  readonly timerSource?: TimerSource;
  /**
   * When the host posts its batches; per message by default, so delivery is
   * synchronous. A test that reads the cadence passes a `Pacer` on a manual
   * clock.
   */
  readonly makePolicy?: FlushPolicyFactory;
}

/** The mirror's end of an open session. */
export interface SessionLink {
  readonly handle: string;
  /** Post a local action; returns its sequence number. */
  action(event: CodeSessionEvent): number;
  /** Post a decoded frame straight to the engine, past the session filter; returns its sequence number. */
  testFrame(feedId: number, decoded: unknown): number;
  /** Post a find query for the session's rendered text; its answer arrives as a `find-result` patch. */
  find(request: SessionFindRequest): void;
  /** Close the engine. What it posts while closing still arrives; nothing after. */
  close(): void;
}

/** Anything a store can open its session on. */
export interface SessionOpener {
  openSession(open: SessionOpenOptions, target: SessionPatchTarget, local?: SessionLocalOptions): SessionLink;
}

/** The frame I/O an in-process session host is fed by. */
export interface SessionFrameSource {
  onFrame(feedId: number, callback: (payload: Uint8Array) => void): () => void;
  send(feedId: FeedIdValue, payload: Uint8Array, flags?: number): void;
}

let openCount = 0;

/** A handle for one open of `tugSessionId`, never reused. */
export function mintSessionHandle(tugSessionId: string): string {
  openCount += 1;
  return `${tugSessionId}#${openCount}`;
}

/**
 * Open a session on `source` through an in-process host of its own. The
 * open's patches are applied to `target` synchronously, inside whatever call
 * produced them, as the store's own reduction always was.
 */
export function openInProcessSession(
  source: SessionFrameSource,
  open: SessionOpenOptions,
  target: SessionPatchTarget,
  local: SessionLocalOptions = {},
): SessionLink {
  const handle = mintSessionHandle(open.tugSessionId);
  let live = true;
  let seq = 0;
  const channel = new InProcessIngestChannel({
    send: (feedId, payload) => source.send(feedId as FeedIdValue, payload),
    sessionTimers: () => local.timerSource,
    replayOnOpen: false,
    ...(local.makePolicy !== undefined ? { makePolicy: local.makePolicy } : {}),
  });
  const patchTarget: PatchTarget = {
    page: null,
    session: (h) => (live && h === handle ? target : null),
  };
  channel.setBatchListener((batch) => {
    applySessionBatch(batch.entries, patchTarget);
  });
  channel.post({ kind: "session-open", handle, ...open });
  // Subscribed after the engine is open, so a source that replays its last
  // frame on subscribe replays it into the engine.
  const unsubs = ENGINE_FEEDS.map((feedId) =>
    source.onFrame(feedId, (payload) => {
      if (live) channel.ingestFrame(feedId, payload);
    }),
  );
  return {
    handle,
    action(event) {
      seq += 1;
      if (live) channel.post({ kind: "session-action", handle, seq, event });
      return seq;
    },
    testFrame(feedId, decoded) {
      seq += 1;
      if (live) channel.post({ kind: "session-test-frame", handle, seq, feedId, decoded });
      return seq;
    },
    find(request) {
      if (live) channel.post({ kind: "find", handle, ...request });
    },
    close() {
      if (!live) return;
      for (const unsub of unsubs) unsub();
      channel.post({ kind: "session-close", handle });
      live = false;
      channel.dispose();
    },
  };
}
