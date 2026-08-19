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

  test("a frame under a pointer gesture owns its own geometry", () => {
    const before = frame(sample("p1", { x: 100, gesture: true }));
    const after = frame(sample("p1", { x: 400, gesture: true }));
    expect(classifySamples(before, after)).toEqual([]);

    // Still exempt when the gesture ended between the two samples.
    const released = frame(sample("p1", { x: 400, gesture: false }));
    expect(classifySamples(before, released)).toEqual([]);
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

  test("a departing frame is not reported", () => {
    const before = frame(sample("p1"), sample("p2", { x: 900 }));
    const after = frame(sample("p1"));
    expect(classifySamples(before, after)).toEqual([]);
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
