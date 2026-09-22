/**
 * `pendingFileInsert` slot — the store side of a file drop caught somewhere
 * other than the prompt entry. The catching surface holds neither the
 * `EditorView` nor the bytes store `processAttachmentFiles` needs, so it parks
 * the `File` objects here and the entry runs them through its own attachment
 * pipeline at the caret, then clears the slot.
 *
 * Driven through the real `CodeSessionStore` facade (no mock store) so the
 * snapshot-reference stability the consuming `useLayoutEffect` relies on
 * ([L02]) is exercised for real. What a dropped file *becomes* is not this
 * slot's business and is not asserted here: the insertion at the caret is a
 * real-editor behaviour and belongs to the app-test.
 */

import { describe, it, expect } from "bun:test";

import { CodeSessionStore } from "@/lib/code-session-store";
import { ConnectionLifecycle } from "@/lib/connection-lifecycle";
import type { TugConnection } from "@/connection";
import { TestFrameChannel } from "@/lib/code-session-store/testing/mock-feed-store";
import { FIXTURE_IDS } from "@/lib/code-session-store/testing/golden-catalog";

function constructStore(): CodeSessionStore {
  const conn = new TestFrameChannel();
  return new CodeSessionStore({
    conn: conn as unknown as TugConnection,
    lifecycle: new ConnectionLifecycle(),
    tugSessionId: FIXTURE_IDS.TUG_SESSION_ID,
    sessionMode: "new",
  });
}

function makeFile(name: string): File {
  return new File(["bytes"], name, { type: "text/plain" });
}

describe("CodeSessionStore — pendingFileInsert slot", () => {
  it("starts null", () => {
    const store = constructStore();
    expect(store.getSnapshot().pendingFileInsert).toBeNull();
  });

  it("insertFiles parks the dropped files, in order", () => {
    const store = constructStore();
    const first = makeFile("a.txt");
    const second = makeFile("b.png");
    store.insertFiles([first, second]);
    expect(store.getSnapshot().pendingFileInsert).toEqual([first, second]);
  });

  it("parks the File objects themselves, not a description of them", () => {
    // The entry hands them to `processAttachmentFiles`, which decodes image
    // bytes — so the slot has to carry the live objects a drop produced.
    const store = constructStore();
    const file = makeFile("shot.png");
    store.insertFiles([file]);
    expect(store.getSnapshot().pendingFileInsert?.[0]).toBe(file);
  });

  it("copies the list, so a caller's array is not a live handle on the slot", () => {
    // A drop's file list comes off a `DataTransfer`, whose lifetime ends with
    // the event; the slot outlives it until the entry consumes.
    const store = constructStore();
    const files = [makeFile("a.txt")];
    store.insertFiles(files);
    files.push(makeFile("b.txt"));
    expect(store.getSnapshot().pendingFileInsert).toHaveLength(1);
  });

  it("an empty list is not a gesture and parks nothing", () => {
    const store = constructStore();
    const before = store.getSnapshot();
    store.insertFiles([]);
    expect(store.getSnapshot()).toBe(before);
  });

  it("consumePendingFileInsert clears the slot back to null", () => {
    const store = constructStore();
    store.insertFiles([makeFile("a.txt")]);
    store.consumePendingFileInsert();
    expect(store.getSnapshot().pendingFileInsert).toBeNull();
  });

  it("consume while already null is a snapshot-ref-stable no-op", () => {
    const store = constructStore();
    const before = store.getSnapshot();
    store.consumePendingFileInsert();
    expect(store.getSnapshot()).toBe(before);
  });
});
