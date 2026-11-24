/**
 * The connection's watch scope: the sessions a page lists and so hears the
 * glance feeds of, beside the sessions it is bound to. It rides the `init`
 * hello and every `sessions` post, and narrowing the bound set leaves it as
 * it was — the order a listing page's bind and its intent replay take.
 */

import { describe, expect, test } from "bun:test";
import { TugConnection } from "@/connection";
import type { IngestChannel } from "@/lib/ingest/ingest-channel";
import type { SessionControl } from "@/lib/ingest/session-patch";

/** A channel that keeps the scope-bearing controls the facade posts. */
function recordingChannel(): { channel: IngestChannel; posted: SessionControl[] } {
  const posted: SessionControl[] = [];
  const channel: IngestChannel = {
    post: (control) => {
      if (control.kind === "init" || control.kind === "sessions") posted.push(control);
    },
    setBatchListener: () => {},
    setFailureListener: () => {},
    dispose: () => {},
  };
  return { channel, posted };
}

describe("TugConnection — the watch scope", () => {
  test("a page watches nothing until it names some, and its hello says so", () => {
    const { channel, posted } = recordingChannel();
    new TugConnection("ws://test.invalid/ws", { channel, page: { role: "body", cardId: "c1" } }).connect();
    expect(posted).toEqual([expect.objectContaining({ kind: "init", sessions: [], watch: [] })]);
  });

  test("watching all goes out with the bound set, and narrowing the bound set keeps it", () => {
    const { channel, posted } = recordingChannel();
    const conn = new TugConnection("ws://test.invalid/ws", { channel, page: { role: "body", cardId: "c1" } });
    conn.setWatch("all");
    conn.setSessions(["s1"]);
    conn.setSessions([]);
    conn.setWatch([]);
    expect(posted.slice(1)).toEqual([
      { kind: "sessions", sessions: [], watch: "all" },
      { kind: "sessions", sessions: ["s1"], watch: "all" },
      { kind: "sessions", sessions: [], watch: "all" },
      { kind: "sessions", sessions: [], watch: [] },
    ]);
  });

  test("a host built by the watch's own post is initialized with it", () => {
    const { channel, posted } = recordingChannel();
    const conn = new TugConnection("ws://test.invalid/ws", { channel, page: { role: "body", cardId: "c1" } });
    conn.setWatch(["s1", "s2"]);
    expect(posted).toEqual([
      expect.objectContaining({ kind: "init", sessions: [], watch: ["s1", "s2"] }),
      { kind: "sessions", sessions: [], watch: ["s1", "s2"] },
    ]);
  });
});
