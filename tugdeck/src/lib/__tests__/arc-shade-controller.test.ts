import { describe, it, expect } from "bun:test";

import { ArcShadeController } from "../arc-shade-controller";

describe("ArcShadeController", () => {
  it("rests lowered", () => {
    expect(new ArcShadeController().getSnapshot()).toBe(false);
  });

  it("raise and lower commit the state", () => {
    const c = new ArcShadeController();
    c.raise();
    expect(c.getSnapshot()).toBe(true);
    c.lower();
    expect(c.getSnapshot()).toBe(false);
  });

  it("toggle flips it both ways", () => {
    const c = new ArcShadeController();
    c.toggle();
    expect(c.getSnapshot()).toBe(true);
    c.toggle();
    expect(c.getSnapshot()).toBe(false);
  });

  it("tells its listeners of a change and not of a no-op", () => {
    const c = new ArcShadeController();
    let heard = 0;
    const off = c.subscribe(() => {
      heard += 1;
    });
    c.raise();
    c.raise();
    expect(heard).toBe(1);
    c.lower();
    c.lower();
    expect(heard).toBe(2);
    off();
    c.raise();
    expect(heard).toBe(2);
  });

  it("a listener that lowers another surface sees the new state", () => {
    const c = new ArcShadeController();
    const seen: boolean[] = [];
    c.subscribe(() => seen.push(c.getSnapshot()));
    c.toggle();
    c.toggle();
    expect(seen).toEqual([true, false]);
  });
});
