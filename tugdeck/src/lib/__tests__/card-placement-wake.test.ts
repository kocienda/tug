/**
 * What wakes the placer without a deck commit: every inline `style` write
 * under the canvas — a stand-in's pins, a flow strip's offset or length, a
 * column's or a rail's arrangement property — and nothing outside it. The
 * placer's own writes, dropped in the task that made them, wake nothing, and
 * a released watch hears nothing more.
 *
 * @covers tugdeck/src/lib/card-placement.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { watchArrangementWrites } from "../card-placement";

const dom = new JSDOM("<!doctype html><body></body>");
const doc = dom.window.document;

const GLOBALS = ["MutationObserver"] as const;
const saved: Record<string, unknown> = {};
const scope = globalThis as unknown as Record<string, unknown>;

beforeAll(() => {
  for (const name of GLOBALS) saved[name] = scope[name];
  scope.MutationObserver = dom.window.MutationObserver;
});

afterAll(() => {
  // Restored by assignment: deleting a global slows every later file.
  for (const name of GLOBALS) scope[name] = saved[name];
});

/** A canvas holding a layer and two stand-ins, and an element beside it. */
function canvas() {
  const root = doc.createElement("div");
  root.innerHTML =
    '<div class="canvas"><div class="layer"><div class="tug-pane" data-pane-id="p1"></div><div class="tug-pane" data-pane-id="p2"></div></div></div><div class="beside"></div>';
  doc.body.replaceChildren(root);
  const el = (selector: string) => root.querySelector<HTMLElement>(selector)!;
  return { container: el(".canvas"), layer: el(".layer"), p2: el('[data-pane-id="p2"]'), beside: el(".beside") };
}

/** Let the observer deliver what the writes queued. */
const delivered = () => new Promise((r) => setTimeout(r, 0));

describe("the placer's wake on arrangement writes", () => {
  test("a flow-strip write on the canvas wakes it", async () => {
    const { container } = canvas();
    let wakes = 0;
    const watch = watchArrangementWrites(container, () => (wakes += 1));
    container.style.setProperty("--tug-imposer-flow-strip", "1620px");
    await delivered();
    expect(wakes).toBe(1);
    watch.release();
  });

  test("a stand-in's pin and a layer's property under it wake it", async () => {
    const { container, layer, p2 } = canvas();
    let wakes = 0;
    const watch = watchArrangementWrites(container, () => (wakes += 1));
    p2.style.left = "calc(560px + -60px)";
    layer.style.setProperty("--tug-flow-offset", "120px");
    await delivered();
    expect(wakes).toBeGreaterThanOrEqual(1);
    watch.release();
  });

  test("a write outside the canvas, or a non-style attribute, wakes nothing", async () => {
    const { container, beside, p2 } = canvas();
    let wakes = 0;
    const watch = watchArrangementWrites(container, () => (wakes += 1));
    beside.style.left = "40px";
    p2.setAttribute("data-pane-id", "p2");
    await delivered();
    expect(wakes).toBe(0);
    watch.release();
  });

  test("the placer's own write, dropped in its task, wakes nothing; a later write still does", async () => {
    const { container, p2 } = canvas();
    let wakes = 0;
    const watch = watchArrangementWrites(container, () => (wakes += 1));
    p2.style.clipPath = "polygon(0 0, 10px 0, 10px 10px)";
    watch.drop();
    await delivered();
    expect(wakes).toBe(0);
    p2.style.left = "300px";
    await delivered();
    expect(wakes).toBe(1);
    watch.release();
  });

  test("a released watch hears nothing more", async () => {
    const { container } = canvas();
    let wakes = 0;
    const watch = watchArrangementWrites(container, () => (wakes += 1));
    watch.release();
    container.style.setProperty("--tug-imposer-flow-strip", "900px");
    await delivered();
    expect(wakes).toBe(0);
  });
});
