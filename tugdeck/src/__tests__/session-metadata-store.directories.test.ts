/**
 * The session's granted folders on the metadata snapshot.
 *
 * `system_metadata.additional_directories` is a whole list: a frame that
 * carries it, even empty, is the answer, and one that omits it (the replay's
 * synthesized frame, the turn-free capabilities) says nothing. tugcode sends
 * the list on the spawn frame and after every granted `/add-dir`; claude's
 * `system/init` sends it on every turn.
 */

import { describe, expect, test } from "bun:test";
import { SessionMetadataStore } from "../lib/session-metadata-store";
import { Subscribable } from "../lib/subscribable";

class MockFeedStore extends Subscribable {
  private _data: Map<number, unknown> = new Map();

  getSnapshot(): Map<number, unknown> {
    return this._data;
  }

  emit(feedId: number, payload: unknown): void {
    const next = new Map(this._data);
    next.set(feedId, payload);
    this._data = next;
    this.notify();
  }
}

const FEED_ID = 0x40;

/** A `system_metadata` frame as tugcast forwards it after its merge. */
function frame(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "system_metadata",
    session_id: "sess-dirs",
    model: "claude-opus",
    permissionMode: "default",
    cwd: "/u/project",
    ...extra,
  };
}

function store(): { feed: MockFeedStore; meta: SessionMetadataStore } {
  const feed = new MockFeedStore();
  return { feed, meta: new SessionMetadataStore(feed as never, FEED_ID) };
}

describe("the session's granted folders", () => {
  test("start empty", () => {
    expect(store().meta.getSnapshot().additionalDirectories).toEqual([]);
  });

  test("a frame's list is the snapshot's, in its order", () => {
    const { feed, meta } = store();
    feed.emit(FEED_ID, frame({ additional_directories: ["/u/shared", "/u/docs"] }));
    expect(meta.getSnapshot().additionalDirectories).toEqual(["/u/shared", "/u/docs"]);
  });

  test("a frame without the list keeps the one already held", () => {
    const { feed, meta } = store();
    feed.emit(FEED_ID, frame({ additional_directories: ["/u/shared"] }));
    feed.emit(FEED_ID, frame({ model: "claude-sonnet" }));
    expect(meta.getSnapshot().additionalDirectories).toEqual(["/u/shared"]);
    expect(meta.getSnapshot().model).toBe("claude-sonnet");
  });

  test("an empty list is none, not a gap", () => {
    const { feed, meta } = store();
    feed.emit(FEED_ID, frame({ additional_directories: ["/u/shared"] }));
    feed.emit(FEED_ID, frame({ additional_directories: [] }));
    expect(meta.getSnapshot().additionalDirectories).toEqual([]);
  });

  test("a grant's frame replaces the list and leaves the rest", () => {
    const { feed, meta } = store();
    feed.emit(FEED_ID, frame({ additional_directories: ["/u/shared"] }));
    feed.emit(FEED_ID, frame({ additional_directories: ["/u/shared", "/u/docs"] }));
    const snap = meta.getSnapshot();
    expect(snap.additionalDirectories).toEqual(["/u/shared", "/u/docs"]);
    expect(snap.cwd).toBe("/u/project");
    expect(snap.permissionMode).toBe("default");
  });

  test("a new session's sparse frame clears the folders and keeps the rest", () => {
    // After `/new` tugcode sends `{cwd, additional_directories: []}` for a
    // session tugcast holds no row for, so it arrives unmerged. It says the
    // new session has no folders, and nothing about the catalog, the mode or
    // the version, which the new session shares with the last.
    const { feed, meta } = store();
    feed.emit(
      FEED_ID,
      frame({
        version: "2.1.322",
        slash_commands: ["tugplug:brief"],
        additional_directories: ["/u/shared"],
      }),
    );
    feed.emit(FEED_ID, { type: "system_metadata", cwd: "/u/project", additional_directories: [] });
    const snap = meta.getSnapshot();
    expect(snap.additionalDirectories).toEqual([]);
    expect(snap.slashCommands.map((c) => c.name)).toEqual(["tugplug:brief"]);
    expect(snap.permissionMode).toBe("default");
    expect(snap.version).toBe("2.1.322");
    expect(snap.model).toBe("claude-opus");
  });

  test("capabilities say nothing about the folders", () => {
    const { feed, meta } = store();
    feed.emit(FEED_ID, frame({ additional_directories: ["/u/shared"] }));
    feed.emit(FEED_ID, { type: "session_capabilities", models: [], commands: [] });
    expect(meta.getSnapshot().additionalDirectories).toEqual(["/u/shared"]);
  });
});
