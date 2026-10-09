/**
 * jots-store.test.ts — the `editingId` lifecycle on the real store.
 *
 * Drives a real `JotsStore` constructed with a null connection (the feed
 * stays inactive; the debounced `save` fires a caught, best-effort fetch that
 * never affects the synchronous snapshot). No mocks — the store's own methods
 * and snapshot are exercised directly.
 */

import { describe, expect, it } from "bun:test";

import { JotsStore } from "@/lib/jots-store";

describe("JotsStore editingId", () => {
  it("is null on a fresh store", () => {
    const store = new JotsStore(null);
    expect(store.getSnapshot().editingId).toBeNull();
  });

  it("createJot creates and opens the new row", () => {
    const store = new JotsStore(null);
    const id = store.createJot(null);
    const snap = store.getSnapshot();
    expect(snap.doc.jots.length).toBe(1);
    expect(snap.doc.jots[0].id).toBe(id);
    expect(snap.editingId).toBe(id);
  });

  it("commitEdit clears the open row (a populated row survives)", () => {
    const store = new JotsStore(null);
    const id = store.createJot(null);
    store.updateJot(id, "There is a tide");
    expect(store.getSnapshot().editingId).toBe(id);
    store.commitEdit();
    expect(store.getSnapshot().editingId).toBeNull();
    expect(store.getSnapshot().doc.jots.length).toBe(1);
  });

  it("discards a row left EMPTY on commit (create then escape without typing)", () => {
    const store = new JotsStore(null);
    store.createJot(null);
    expect(store.getSnapshot().doc.jots.length).toBe(1);
    // No text typed — closing the editor must not leave a blank row behind.
    store.commitEdit();
    expect(store.getSnapshot().editingId).toBeNull();
    expect(store.getSnapshot().doc.jots.length).toBe(0);
  });

  it("discards an existing row cleared to empty (whitespace only) on commit", () => {
    const store = new JotsStore(null);
    const id = store.createJot(null);
    store.updateJot(id, "hello");
    store.commitEdit();
    expect(store.getSnapshot().doc.jots.length).toBe(1);
    store.beginEdit(id);
    store.updateJot(id, "   ");
    store.commitEdit();
    expect(store.getSnapshot().doc.jots.length).toBe(0);
  });

  it("beginEdit opens an existing row", () => {
    const store = new JotsStore(null);
    const id = store.createJot(null);
    store.updateJot(id, "kept");
    store.commitEdit();
    store.beginEdit(id);
    expect(store.getSnapshot().editingId).toBe(id);
  });

  it("a commit-then-create chain opens a distinct new row (⌘Return)", () => {
    const store = new JotsStore(null);
    const first = store.createJot(null);
    store.updateJot(first, "first");
    store.commitEdit();
    const second = store.createJot(first);
    expect(second).not.toBe(first);
    expect(store.getSnapshot().editingId).toBe(second);
    expect(store.getSnapshot().doc.jots.length).toBe(2);
  });
});
