import { describe, expect, it } from "bun:test";

import { FALLBACK_FRAME_PERIOD_MS } from "../settle-frame-probe";
import { PERIOD_MIN_GAPS, type SettleGapRow, SettleGapSampler } from "../settle-gap-sampler";

/** A sampler over a frame queue the test fires by hand, at the times it names. */
function harness() {
  const frames = new Map<number, (at: number) => void>();
  let next = 1;
  const rows: SettleGapRow[] = [];
  const sampler = new SettleGapSampler({
    requestFrame: (cb) => {
      const id = next++;
      frames.set(id, cb);
      return id;
    },
    cancelFrame: (id) => {
      frames.delete(id);
    },
    record: (row) => void rows.push(row),
  });
  const frameAt = (at: number): void => {
    const due = [...frames.values()];
    frames.clear();
    for (const cb of due) cb(at);
  };
  /** Frames at each time in turn. */
  const run = (times: readonly number[]): void => {
    for (const at of times) frameAt(at);
  };
  return { sampler, frames, rows, run };
}

/** `n` frames one period apart from `from`. */
function smooth(from: number, n: number, period: number): number[] {
  return Array.from({ length: n }, (_, i) => from + i * period);
}

describe("SettleGapSampler", () => {
  it("records nothing over a clean settle", () => {
    const h = harness();
    h.sampler.start(() => "move");
    h.run(smooth(1000, 20, 1000 / 60));
    h.sampler.stop();
    expect(h.rows).toEqual([]);
  });

  it("records one row per late frame, with the beat, the gap and its offset", () => {
    const h = harness();
    let beat = "set-up";
    h.sampler.start(() => beat);
    const p = 1000 / 60;
    h.run(smooth(1000, 4, p));
    beat = "move";
    // Two frames missed: the next arrives three periods after the last.
    h.run([1000 + 6 * p, 1000 + 7 * p]);
    h.sampler.stop();
    expect(h.rows).toHaveLength(1);
    const [row] = h.rows;
    expect(row.beat).toBe("move");
    expect(row.gapMs).toBeCloseTo(3 * p, 6);
    expect(row.periodMs).toBeCloseTo(p, 6);
    expect(row.offsetMs).toBeCloseTo(6 * p, 6);
  });

  it("does not read the lead: the gap to the first frame is not a row", () => {
    const h = harness();
    h.sampler.start(() => "set-up");
    // The first frame comes long after the start; only frame-to-frame gaps count.
    h.run(smooth(5000, 5, 1000 / 60));
    expect(h.rows).toEqual([]);
  });

  it("learns the display's period from the frames, so a 120 Hz drop is a row", () => {
    const h = harness();
    h.sampler.start(() => "move");
    const p = 1000 / 120;
    const n = PERIOD_MIN_GAPS + 2;
    h.run(smooth(0, n, p));
    // Two periods at 120 Hz is under the 60 Hz fallback's tolerance, and a row here.
    h.run([(n - 1) * p + 2 * p]);
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0].periodMs).toBeCloseTo(p, 6);
    expect(2 * p).toBeLessThan(FALLBACK_FRAME_PERIOD_MS * 1.5);
  });

  it("a late frame and the one catching up behind it do not teach a short period", () => {
    // The live shape: WebKit delivers a late frame and its catch-up a few ms
    // apart. A period learned off the smallest gap read 2 ms and called every
    // ordinary frame after it late.
    const h = harness();
    h.sampler.start(() => "move");
    const p = 1000 / 60;
    const times = smooth(0, 12, p);
    const t = times[times.length - 1];
    // Late by two frames, its catch-up 2 ms behind it on the next vsync, then on cadence.
    h.run([...times, t + 3 * p - 2, t + 3 * p, ...smooth(t + 4 * p, 20, p)]);
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0].gapMs).toBeCloseTo(3 * p - 2, 6);
    expect(h.rows[0].periodMs).toBeCloseTo(p, 6);
  });

  it("a first settle a quarter of whose gaps are catch-ups still reads the display's period", () => {
    // The streaming harness's first fold: a lower quartile of these read 4–6 ms.
    const h = harness();
    h.sampler.start(() => "shrink");
    const p = 1000 / 60;
    const times: number[] = [0];
    let t = 0;
    // Three late frames, each with its catch-up, among six on cadence.
    for (const late of [false, true, false, true, false, true, false, false, false]) {
      if (late) {
        t += 2 * p - 2;
        times.push(t);
        t += 2;
      } else {
        t += p;
      }
      times.push(t);
    }
    h.run(times);
    // The late frames before the ring could read count against the 60 Hz fallback;
    // every row carries a period of a whole display frame, never a catch-up's.
    expect(h.rows.length).toBeGreaterThan(0);
    for (const row of h.rows) expect(row.periodMs).toBeGreaterThan(p * 0.9);
    // And a later frame on cadence is not late.
    const before = h.rows.length;
    h.run(smooth(t + p, 5, p));
    expect(h.rows.length).toBe(before);
  });

  it("runs nothing at rest: stop cancels the frame, and a start while running keeps the window", () => {
    const h = harness();
    expect(h.frames.size).toBe(0);
    h.sampler.start(() => "a");
    h.sampler.start(() => "b");
    expect(h.frames.size).toBe(1);
    h.run([0, 50]);
    expect(h.rows.map((r) => r.beat)).toEqual(["b"]);
    h.sampler.stop();
    expect(h.frames.size).toBe(0);
    expect(h.sampler.running).toBe(false);
    h.sampler.stop();
  });

  it("a fresh window does not measure across the rest before it", () => {
    const h = harness();
    h.sampler.start(() => "move");
    h.run(smooth(0, 3, 1000 / 60));
    h.sampler.stop();
    h.sampler.start(() => "move");
    h.run(smooth(10_000, 3, 1000 / 60));
    expect(h.rows).toEqual([]);
  });

  it("where there is no frame, starts nothing and stops cleanly", () => {
    let cancels = 0;
    const sampler = new SettleGapSampler({
      requestFrame: () => null,
      cancelFrame: () => {
        cancels += 1;
      },
      record: () => {
        throw new Error("a frameless page records nothing");
      },
    });
    sampler.start(() => "move");
    expect(sampler.running).toBe(false);
    sampler.stop();
    expect(cancels).toBe(0);
  });
});
