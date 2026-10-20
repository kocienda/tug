/**
 * How a pane drag or resize ends, decided from what its release read: the
 * same decisions for a drag the shell tracks and one the host tracks.
 *
 * @covers tugdeck/src/lib/card-gesture-commit.ts
 */

import { describe, expect, test } from "bun:test";

import type { MovePaneOptions } from "../../deck-manager-store";
import {
  commitResizeEnd,
  dragOutcomeOf,
  freeDropOutcomeOf,
  type MovePane,
  type ZoneDragState,
} from "../card-gesture-commit";
import type { DropZone } from "../drop-zones";

const SLOT_0: DropZone = { kind: "slot", slot: 0, rect: { x: 0, y: 0, width: 400, height: 600 } };
const SLOT_1: DropZone = { kind: "slot", slot: 1, rect: { x: 420, y: 0, width: 400, height: 600 } };
const ZONES: ZoneDragState = { zones: [SLOT_0, SLOT_1], live: SLOT_0, origin: SLOT_0 };

const release = (over: Partial<Parameters<typeof dragOutcomeOf>[0]>) =>
  dragOutcomeOf({ moved: true, startedWithMeta: false, metaAtRelease: false, zone: null, pointer: { x: 0, y: 0 }, ...over });

describe("dragOutcomeOf", () => {
  test("a zone drop commits the zone the release point asks for", () => {
    expect(release({ zone: { ...ZONES }, pointer: { x: 600, y: 300 } })).toEqual({ kind: "zone", zone: SLOT_1, onOrigin: false });
  });

  test("a release back on the card's own place is a drop onto its origin, which commits nothing", () => {
    expect(release({ zone: { ...ZONES }, pointer: { x: 200, y: 300 } })).toEqual({ kind: "zone", zone: SLOT_0, onOrigin: true });
  });

  test("a press that never travelled is a click, and with ⌘ it reveals the stack", () => {
    expect(release({ moved: false, startedWithMeta: true, zone: { ...ZONES } })).toEqual({ kind: "click", revealStack: true });
    expect(release({ moved: false })).toEqual({ kind: "click", revealStack: false });
  });

  test("⌘ at the release frees a zone drag, and a drag with no zones is free", () => {
    expect(release({ zone: { ...ZONES }, metaAtRelease: true })).toEqual({ kind: "free", freedFromZone: true });
    expect(release({})).toEqual({ kind: "free", freedFromZone: false });
  });

  test("a zone drag with no zone to take it goes home, and a tab-bar zone merges", () => {
    expect(release({ zone: { zones: [], live: null, origin: null } })).toEqual({ kind: "zone-home" });
    const bar: DropZone = { kind: "tab-bar", paneId: "p2", rect: { x: 0, y: 0, width: 400, height: 36 } };
    expect(release({ zone: { zones: [bar], live: null, origin: SLOT_0 }, pointer: { x: 10, y: 10 } })).toEqual({
      kind: "zone-merge",
      zone: bar,
    });
  });
});

describe("freeDropOutcomeOf", () => {
  const base = { mergeTarget: null, position: { x: 103, y: 57 }, snap: null, size: { width: 500, height: 400 }, derived: false };

  test("a free drop commits the snapped rect, the snap winning on the axis it found", () => {
    expect(freeDropOutcomeOf({ ...base, snap: { x: 100, y: null } })).toEqual({
      kind: "move",
      position: { x: 100, y: 57 },
      size: { width: 500, height: 400 },
      evictSlot: false,
    });
  });

  test("a derived pane dropped free is evicted, and one over a pane's band merges into it", () => {
    expect(freeDropOutcomeOf({ ...base, derived: true })).toMatchObject({ kind: "move", evictSlot: true });
    expect(freeDropOutcomeOf({ ...base, mergeTarget: { paneId: "p2", insertIndex: 3 } })).toEqual({
      kind: "merge",
      targetPaneId: "p2",
      insertIndex: 3,
    });
  });
});

describe("commitResizeEnd", () => {
  const start = { position: { x: 20, y: 30 }, size: { width: 500, height: 400 } };
  const written = (release: Parameters<typeof commitResizeEnd>[3]) => {
    const out: Array<[string, { x: number; y: number }, { width: number; height: number }, MovePaneOptions | undefined]> = [];
    const move: MovePane = (paneId, position, size, opts) => {
      out.push([paneId, position, size, opts]);
    };
    commitResizeEnd(move, "p1", start, release);
    // One write per end.
    expect(out.length).toBe(1);
    return out[0];
  };

  test("a released resize writes the reported rect, evicting a derived pane", () => {
    expect(written({ kind: "free", rect: { x: 10, y: 12, width: 640, height: 480 }, evictSlot: true })).toEqual([
      "p1",
      { x: 10, y: 12 },
      { width: 640, height: 480 },
      { evictSlot: true },
    ]);
  });

  test("a slot-keeping end writes the width or the slot height alone, at the stored position", () => {
    expect(written({ kind: "width", width: 700 })).toEqual(["p1", { x: 20, y: 30 }, { width: 700, height: 400 }, undefined]);
    expect(written({ kind: "height", slotHeight: 320 })).toEqual([
      "p1",
      { x: 20, y: 30 },
      { width: 500, height: 320 },
      { slotHeight: 320 },
    ]);
    expect(written({ kind: "height", slotHeight: null })).toEqual([
      "p1",
      { x: 20, y: 30 },
      { width: 500, height: 400 },
      { slotHeight: null },
    ]);
  });
});
