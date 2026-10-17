import { afterEach, describe, expect, test } from "bun:test";

import { captureJot, setJotCaptureForwarder } from "../jot-capture";
import { getJotsStore } from "../jots-store";

let uninstall: (() => void) | null = null;

afterEach(() => {
  uninstall?.();
  uninstall = null;
});

describe("captureJot", () => {
  test("a card the forwarder takes captures in its own page, not this one's store", () => {
    const before = getJotsStore().getSnapshot();
    const taken: string[] = [];
    uninstall = setJotCaptureForwarder((cardId) => {
      taken.push(cardId);
      return true;
    });
    captureJot("jots");
    expect(taken).toEqual(["jots"]);
    expect(getJotsStore().getSnapshot().doc.jots.length).toBe(before.doc.jots.length);
    expect(getJotsStore().getSnapshot().editingId).toBe(before.editingId);
  });

  test("a card the forwarder declines captures in this page's store, opened", () => {
    const before = getJotsStore().getSnapshot().doc.jots.length;
    uninstall = setJotCaptureForwarder(() => false);
    captureJot("jots");
    const after = getJotsStore().getSnapshot();
    expect(after.doc.jots.length).toBe(before + 1);
    expect(after.editingId).toBe(after.doc.jots[after.doc.jots.length - 1].id);
  });

  test("an uninstalled forwarder is never asked", () => {
    let asked = false;
    const release = setJotCaptureForwarder(() => {
      asked = true;
      return true;
    });
    release();
    captureJot("jots");
    expect(asked).toBe(false);
  });
});
