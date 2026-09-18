import { describe, expect, test } from "bun:test";
import {
  CUT_THRESHOLD_PX,
  classifySamples,
  type PaneSample,
} from "../cut-detector";

function sample(
  paneId: string,
  over: Partial<PaneSample> = {},
): PaneSample {
  return {
    paneId,
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    animations: 0,
    gesture: false,
    visible: true,
    covered: false,
    ...over,
  };
}

function frame(...samples: PaneSample[]): Map<string, PaneSample> {
  return new Map(samples.map((s) => [s.paneId, s]));
}

describe("classifySamples", () => {
  test("a frame that holds still reports nothing", () => {
    const before = frame(sample("p1"));
    const after = frame(sample("p1"));
    expect(classifySamples(before, after)).toEqual([]);
  });

  test("an unanimated jump is a cut, with its per-axis delta", () => {
    const before = frame(sample("p1", { x: 100 }));
    const after = frame(sample("p1", { x: 400 }));
    const [record, ...rest] = classifySamples(before, after);
    expect(rest).toEqual([]);
    expect(record?.paneId).toBe("p1");
    expect(record?.dx).toBe(300);
    expect(record?.dy).toBe(0);
  });

  test("motion under a running animation is travel, not a cut", () => {
    const before = frame(sample("p1", { x: 100, animations: 1 }));
    const after = frame(sample("p1", { x: 400, animations: 1 }));
    expect(classifySamples(before, after)).toEqual([]);
  });

  test("a tween finishing between samples does not read as a cut", () => {
    // The later sample is quiet because the animation just ended; only the
    // earlier one still remembers what was carrying the motion.
    const before = frame(sample("p1", { x: 100, animations: 1 }));
    const after = frame(sample("p1", { x: 400, animations: 0 }));
    expect(classifySamples(before, after)).toEqual([]);
  });

  test("a frame under a pointer gesture is reported, not dropped", () => {
    // It owns its own geometry, so its motion is not the promise broken — but
    // dropping the record is how the detector stayed blind to the cut it
    // exists to find ([F05]). It comes back as its own kind, which the census
    // counts apart from a cut ([B05]).
    const before = frame(sample("p1", { x: 100, gesture: true }));
    const after = frame(sample("p1", { x: 400, gesture: true }));
    expect(classifySamples(before, after).map((r) => r.kind)).toEqual([
      "self-positioned",
    ]);

    // And still its own kind when the gesture ended between the two samples:
    // a frame the hand was placing at the earlier sample is not one the
    // imposer failed to carry.
    const released = frame(sample("p1", { x: 400, gesture: false }));
    expect(classifySamples(before, released).map((r) => r.kind)).toEqual([
      "self-positioned",
    ]);
  });

  test("sub-threshold drift is the browser re-resolving calc(), not a jump", () => {
    const before = frame(sample("p1", { x: 100 }));
    const after = frame(sample("p1", { x: 100 + CUT_THRESHOLD_PX }));
    expect(classifySamples(before, after)).toEqual([]);
  });

  test("a size change alone is a cut", () => {
    const before = frame(sample("p1", { width: 675 }));
    const after = frame(sample("p1", { width: 1230 }));
    const [record] = classifySamples(before, after);
    expect(record?.dw).toBe(555);
  });

  test("a frame that arrives with nothing animating it has appeared, not entered", () => {
    const before = frame(sample("p1"));
    const after = frame(sample("p1"), sample("p2", { x: 900 }));
    const [record, ...rest] = classifySamples(before, after);
    expect(rest).toEqual([]);
    expect(record?.kind).toBe("appeared");
    expect(record?.paneId).toBe("p2");
    // Nothing to subtract: an arriving frame has no earlier position.
    expect(record?.dx).toBe(0);
  });

  test("a frame that arrives already animating is carried", () => {
    const before = frame(sample("p1"));
    const after = frame(sample("p1"), sample("p2", { x: 900, animations: 1 }));
    expect(classifySamples(before, after)).toEqual([]);
  });

  test("a frame the settle is holding INVISIBLE has not appeared", () => {
    // The window between the commit that appends an arriving frame and its
    // ARRIVE beat, which is the last of the five: the frame is in the DOM, is
    // not animating, and is not on screen either. Requiring it to be animating
    // through that window would be requiring it to animate before its beat.
    const before = frame(sample("p1"));
    const after = frame(sample("p1"), sample("p2", { x: 900, visible: false }));
    expect(classifySamples(before, after)).toEqual([]);
  });

  test("but it has appeared the moment it paints with nothing carrying it", () => {
    // The other side of the same rule, so the hold is not a loophole: a frame
    // that becomes visible with no animation on it is the promise broken, and
    // it is the case the detector exists to find.
    const before = frame(sample("p1"));
    const after = frame(sample("p1"), sample("p2", { x: 900, visible: true }));
    const [record] = classifySamples(before, after);
    expect(record?.kind).toBe("appeared");
    expect(record?.paneId).toBe("p2");
  });

  test("a departing frame is not reported", () => {
    const before = frame(sample("p1"), sample("p2", { x: 900 }));
    const after = frame(sample("p1"));
    expect(classifySamples(before, after)).toEqual([]);
  });

  test("a move that lands behind a cover was not seen, and is not a cut", () => {
    // A column mode flip commits a revealed member at its tile behind the
    // survivor, which is held at the stacked full run they shared. The frame
    // wears the cover from that commit, so the later sample says so, and the
    // move nobody could see is not the promise broken.
    const before = frame(sample("p1", { y: 0, height: 600 }));
    const after = frame(sample("p1", { y: 0, height: 300, covered: true }));
    expect(classifySamples(before, after)).toEqual([]);
  });

  test("and a snap AS the cover comes off landed under it, and is not one either", () => {
    // A retiring member holds its old tile until the survivor has grown over
    // it, then snaps to the full run the survivor now occupies in front of
    // it. The cover comes off in the same release, so only the earlier
    // sample wears it — and the move it saw begin was one nobody could see
    // end.
    const before = frame(sample("p1", { y: 0, covered: true }));
    const after = frame(sample("p1", { y: 300, covered: false }));
    expect(classifySamples(before, after)).toEqual([]);
  });

  test("a frame covered at neither sample is judged as before", () => {
    const before = frame(sample("p1", { y: 0, covered: false }));
    const after = frame(sample("p1", { y: 300, covered: false }));
    expect(classifySamples(before, after)[0]?.kind).toBe("jump");
  });

  test("a jump is labelled as one", () => {
    const before = frame(sample("p1", { x: 100 }));
    const after = frame(sample("p1", { x: 400 }));
    expect(classifySamples(before, after)[0]?.kind).toBe("jump");
  });

  test("every jumping pane is reported", () => {
    const before = frame(sample("p1", { x: 0 }), sample("p2", { x: 500 }));
    const after = frame(sample("p1", { x: 300 }), sample("p2", { x: 800 }));
    expect(classifySamples(before, after).map((r) => r.paneId).sort()).toEqual([
      "p1",
      "p2",
    ]);
  });
});
