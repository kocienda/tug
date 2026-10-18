/**
 * A stuck scroller in a surface the shell draws stays on its newest row.
 *
 * The body renders a Z2 placard hidden and the shell draws its markup in a
 * panel clamped to the shell's own room — a different height from the hidden
 * copy's. The body's scroller sticks to its bottom (`TugPopupListScroller`'s
 * `stickToBottom`), but an absolute `scrollTop` copied once leaves the drawn
 * copy short of its bottom by the difference (`at0543` read 84 px). The
 * intent rides the markup (`data-stick-to-bottom`), and the drawer pins the
 * drawn scroller to its own bottom — on first draw, as rows append, and not
 * once the reader has scrolled up from it.
 *
 * jsdom lays nothing out, so the scroller's box is modelled: each row is
 * `ROW_PX` tall and the drawn scroller's room is `ROOM_PX`.
 *
 * @covers tugdeck/src/lib/shell-surface.ts
 * @covers tugdeck/src/components/tugways/tug-popup-list.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ShellSurface } from "@tugproto/bus";

import { installJsdom } from "../../__tests__/jsdom-deck";

const substrate = installJsdom();
const { win } = substrate;
const JsdomEvent = win.Event as typeof Event;

const ROW_PX = 20;
let ROOM_PX = 116;

/** A ResizeObserver the test delivers by hand: jsdom lays nothing out. */
const observers: FakeResizeObserver[] = [];
class FakeResizeObserver {
  readonly targets = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) {
    observers.push(this);
  }
  observe(el: Element): void {
    this.targets.add(el);
  }
  unobserve(el: Element): void {
    this.targets.delete(el);
  }
  disconnect(): void {
    this.targets.clear();
  }
  deliver(): void {
    const entries = [...this.targets].map((target) => ({ target }) as unknown as ResizeObserverEntry);
    if (entries.length > 0) this.callback(entries, this as unknown as ResizeObserver);
  }
}
const scope = globalThis as unknown as Record<string, unknown>;
let savedResizeObserver: unknown;

const proto = (win as unknown as { HTMLElement: { prototype: HTMLElement } }).HTMLElement.prototype;
const savedDescriptors = new Map<string, PropertyDescriptor | undefined>();
const tops = new WeakMap<Element, number>();

function stuck(el: Element): boolean {
  return el.hasAttribute("data-stick-to-bottom");
}

beforeAll(() => {
  savedResizeObserver = scope.ResizeObserver;
  scope.ResizeObserver = FakeResizeObserver;
  for (const name of ["scrollHeight", "clientHeight", "scrollTop"]) {
    savedDescriptors.set(name, Object.getOwnPropertyDescriptor(proto, name));
  }
  Object.defineProperty(proto, "scrollHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return stuck(this) ? this.children.length * ROW_PX : 0;
    },
  });
  Object.defineProperty(proto, "clientHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return stuck(this) ? ROOM_PX : 0;
    },
  });
  Object.defineProperty(proto, "scrollTop", {
    configurable: true,
    get(this: HTMLElement) {
      return tops.get(this) ?? 0;
    },
    set(this: HTMLElement, value: number) {
      const max = Math.max(0, this.scrollHeight - this.clientHeight);
      tops.set(this, Math.max(0, Math.min(max, value)));
    },
  });
});

afterAll(() => {
  // Restored by assignment: deleting a global slows every later file.
  scope.ResizeObserver = savedResizeObserver;
  for (const [name, descriptor] of savedDescriptors) {
    if (descriptor !== undefined) Object.defineProperty(proto, name, descriptor);
  }
  substrate.restore();
});

function logHtml(rows: number): string {
  const cells = Array.from({ length: rows }, (_, i) => `<div data-slot="tug-popup-list-row">#${i + 1}</div>`);
  return `<div class="tug-popup-list-grid"><div data-slot="tug-popup-list-scroller" data-stick-to-bottom="" class="tug-popup-list-scroller tug-popup-list-grid-scroller">${cells.join("")}</div></div>`;
}

function surfaceOf(rows: number, scroll: ShellSurface["scroll"]): ShellSurface {
  return {
    title: "Time",
    className: "session-telemetry-status-placard",
    growth: "up",
    anchorX: 40,
    lineY: 300,
    html: logHtml(rows),
    scroll,
  };
}

function distanceFromBottom(el: Element): number {
  return el.scrollHeight - (el.scrollTop + el.clientHeight);
}

describe("ShellSurfaceDrawer — a stuck scroller", () => {
  test("opens on its newest row, follows appended rows, and lets a reader scroll up", async () => {
    const registry = await import("../canvas-overlay-registry");
    const { ShellSurfaceDrawer } = await import("../shell-surface");
    const root = document.createElement("div");
    document.body.appendChild(root);
    registry.register(root);
    const placeholder = document.createElement("div");
    placeholder.setAttribute("data-body-placeholder", "");
    placeholder.setAttribute("data-card-id", "A");
    document.body.appendChild(placeholder);
    const drawer = new ShellSurfaceDrawer({ onActivate() {}, onDismiss() {} });
    try {
      // The body's hidden copy stood at its own bottom: 20 rows in a 200 px
      // room, 200 px down. Copied as is, that top is 84 px short here.
      drawer.draw("A", surfaceOf(20, [{ path: [0, 0], top: 200 }]));
      const scroller = root.querySelector("[data-stick-to-bottom]")!;
      expect(scroller).not.toBeNull();
      expect(distanceFromBottom(scroller)).toBe(0);

      drawer.draw("A", surfaceOf(22, []));
      expect(root.querySelector("[data-stick-to-bottom]")).toBe(scroller);
      expect(distanceFromBottom(scroller)).toBe(0);

      // The reader scrolls up: the copy stops following.
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new JsdomEvent("scroll"));
      drawer.draw("A", surfaceOf(24, []));
      expect(scroller.scrollTop).toBe(0);

      // And back to the bottom: it follows again.
      scroller.scrollTop = scroller.scrollHeight;
      scroller.dispatchEvent(new JsdomEvent("scroll"));
      drawer.draw("A", surfaceOf(26, []));
      expect(distanceFromBottom(scroller)).toBe(0);

      // The box settles shorter after the draw (the panel's clamp, a row
      // below the scroller): the copy re-pins when its box changes, as the
      // body's own scroller does, rather than standing short of the bottom.
      ROOM_PX = 100;
      const before = scroller.scrollTop;
      expect(distanceFromBottom(scroller)).toBe(16);
      for (const observer of observers) observer.deliver();
      expect(scroller.scrollTop).toBeGreaterThan(before);
      expect(distanceFromBottom(scroller)).toBe(0);
    } finally {
      ROOM_PX = 116;
      drawer.dispose();
      registry.unregister(root);
      root.remove();
      placeholder.remove();
    }
  });
});
