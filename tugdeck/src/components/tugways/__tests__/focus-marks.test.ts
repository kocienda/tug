/**
 * focus-marks — the focus projection's tracked marks, as data.
 *
 * The engine replaced its document-wide scans for stale marks with the set of
 * elements it marked. These tests pin the three things that change rests on,
 * against stand-in elements (an attribute map and a connected flag — the
 * whole of {@link MarkTarget}), so no document is needed:
 *
 * - a mark left on an element the projection no longer names — the key view
 *   of a context that just deactivated — is cleared;
 * - a reprojection that names the same element writes nothing;
 * - an element that has left the document is not held by the bookkeeping.
 */

import { describe, expect, test } from "bun:test";

import { TrackedMark, type MarkTarget } from "../focus-marks";

/** An element as a mark sees it: attributes and whether it is in the document. */
class Stand implements MarkTarget {
  readonly attrs = new Map<string, string>();
  isConnected = true;
  constructor(readonly name: string) {}
  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
  /** What the projection does when it writes the mark. */
  mark(name: string, value = ""): void {
    this.attrs.set(name, value);
  }
}

const KEY_VIEW = ["data-key-view", "data-key-view-kbd"] as const;

/** One projection pass for the key-view mark, as `applyProjection` runs it. */
function project(marks: TrackedMark<Stand>, keep: Stand | null, id: string): number {
  let writes = marks.clearExcept(keep);
  if (keep !== null) {
    marks.track(keep);
    if (keep.attrs.get("data-key-view") !== id) {
      keep.mark("data-key-view", id);
      writes += 1;
    }
  }
  return writes;
}

describe("TrackedMark", () => {
  test("a mark from a deactivated context is cleared, kbd flavor and all", () => {
    const marks = new TrackedMark<Stand>([...KEY_VIEW]);
    const done = new Stand("done-button");
    project(marks, done, "done");
    done.mark("data-key-view-kbd");

    // Another pane takes focus: the projection now names a different element.
    const row = new Stand("row");
    const writes = project(marks, row, "row0");

    expect(done.hasAttribute("data-key-view")).toBe(false);
    expect(done.hasAttribute("data-key-view-kbd")).toBe(false);
    expect(marks.has(done)).toBe(false);
    expect(row.attrs.get("data-key-view")).toBe("row0");
    // One clear and one set.
    expect(writes).toBe(2);
  });

  test("a reprojection that changes nothing writes nothing", () => {
    const marks = new TrackedMark<Stand>([...KEY_VIEW]);
    const row = new Stand("row");
    expect(project(marks, row, "row0")).toBe(1);
    expect(project(marks, row, "row0")).toBe(0);
    expect(marks.size).toBe(1);
  });

  test("a projection that names nothing clears what it marked", () => {
    const marks = new TrackedMark<Stand>([...KEY_VIEW]);
    const row = new Stand("row");
    project(marks, row, "row0");
    expect(project(marks, null, "")).toBe(1);
    expect(row.hasAttribute("data-key-view")).toBe(false);
    expect(marks.size).toBe(0);
  });

  test("an element someone else unmarked costs no counted write", () => {
    const marks = new TrackedMark<Stand>(["data-default-ring"]);
    const button = new Stand("button");
    button.mark("data-default-ring");
    marks.track(button);
    // The default-ring unregister strips its own attribute.
    button.removeAttribute("data-default-ring");
    expect(marks.clearExcept(null)).toBe(0);
    expect(marks.size).toBe(0);
  });

  test("an element unmounted while marked is not held by the bookkeeping", () => {
    const marks = new TrackedMark<Stand>([...KEY_VIEW]);
    const gone = new Stand("unmounted-row");
    const stays = new Stand("standing-row");
    marks.track(gone);
    marks.track(stays);
    gone.isConnected = false;

    marks.forgetDetached();

    expect(marks.has(gone)).toBe(false);
    expect(marks.has(stays)).toBe(true);
    expect(marks.size).toBe(1);
  });
});
