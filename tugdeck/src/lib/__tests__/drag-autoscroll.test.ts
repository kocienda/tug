/**
 * The strips a card drag scrolls: a hand held at a rail's foot advances the
 * strip on frames of its own, onto the property and not the store, and the
 * end commits it once.
 */

import { describe, expect, test } from "bun:test";
import { createDragAutoscroll } from "../drag-autoscroll";
import type { AutoscrollTarget, DropZoneHost } from "../drop-zones";

function harness() {
  const applied: number[] = [];
  const committed: number[] = [];
  let scheduled = 0;
  let clock = 0;
  const target: AutoscrollTarget = { kind: "rail", side: "right", axis: "y", bandStart: 0, bandEnd: 1000, offset: 0, maxOffset: 500 };
  const host = {
    autoscrollTargetFor: (pointer: { x: number; y: number }) => (pointer.y > 900 ? target : null),
    applyScroll: (_t: AutoscrollTarget, offset: number) => applied.push(offset),
    commitScroll: (_t: AutoscrollTarget, offset: number) => committed.push(offset),
  } as unknown as DropZoneHost;
  const scroll = createDragAutoscroll({ host: () => host, paneId: "p", schedule: () => scheduled++, now: () => clock });
  return {
    applied,
    committed,
    scroll,
    scheduled: () => scheduled,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

describe("drag autoscroll", () => {
  test("a hand held at the foot advances the strip on its own frames, and commits once", () => {
    const h = harness();
    expect(h.scroll.advance({ x: 10, y: 995 })).toBe(false);
    expect(h.scheduled(), "the first frame at the edge asks for the next").toBe(1);
    h.tick(16);
    expect(h.scroll.advance({ x: 10, y: 995 })).toBe(true);
    h.tick(16);
    expect(h.scroll.advance({ x: 10, y: 995 })).toBe(true);
    expect(h.applied.length).toBe(2);
    expect(h.applied[1]).toBeGreaterThan(h.applied[0]);
    expect(h.committed, "nothing reaches the store mid-drag").toEqual([]);
    h.scroll.commit();
    expect(h.committed).toEqual([h.applied[1]]);
  });

  test("a hand off the edge moves nothing", () => {
    const h = harness();
    h.scroll.advance({ x: 10, y: 500 });
    h.tick(16);
    expect(h.scroll.advance({ x: 10, y: 500 })).toBe(false);
    h.scroll.commit();
    expect(h.applied).toEqual([]);
    expect(h.committed).toEqual([]);
  });
});
