/**
 * place-properties.test.ts — a frame new to a slot adopts the slot's standing
 * values, and a frame that already carries them keeps its own.
 *
 * The door is pure over a layer's readers and their inline styles, so it is
 * tested here over fakes; `at0456` is where the wiring is proved on the
 * live deck.
 */

import { describe, expect, test } from "bun:test";

import {
  adoptColumnProperties,
  columnWriter,
} from "@/components/chrome/place-properties";

/** An inline style that is a map, and nothing else. */
function fakeStyle(): CSSStyleDeclaration & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    setProperty: (name: string, value: string) => void values.set(name, value),
    removeProperty: (name: string) => {
      const prior = values.get(name) ?? "";
      values.delete(name);
      return prior;
    },
    getPropertyValue: (name: string) => values.get(name) ?? "",
  } as unknown as CSSStyleDeclaration & { values: Map<string, string> };
}

interface FakeFrame {
  style: ReturnType<typeof fakeStyle>;
  closest: () => Element;
}

/** A layer whose readers of slot 0 are `readers`, and frames that sit in it. */
function fakeLayer(): { layer: Element; frame: () => FakeFrame; readers: FakeFrame[] } {
  const readers: FakeFrame[] = [];
  const layer = {
    querySelectorAll: () => readers,
  } as unknown as Element;
  const frame = (): FakeFrame => ({ style: fakeStyle(), closest: () => layer });
  return { layer, frame, readers };
}

const SEAM = "--tug-slot-0-seam-0";
const OTHER_SLOT = "--tug-slot-1-seam-0";

describe("place-properties: adopting a slot's standing values", () => {
  test("a frame new to the slot takes the values the layer last wrote", () => {
    const { layer, frame, readers } = fakeLayer();
    const standing = frame();
    readers.push(standing);
    columnWriter(layer, 0, false)(SEAM, "0.3");
    expect(standing.style.values.get(SEAM)).toBe("0.3");

    const arriving = frame();
    adoptColumnProperties(arriving as unknown as HTMLElement, 0);
    expect(arriving.style.values.get(SEAM)).toBe("0.3");
  });

  test("a frame that already carries a slot value keeps it", () => {
    const { layer, frame } = fakeLayer();
    columnWriter(layer, 0, false)(SEAM, "0.3");

    const returning = frame();
    returning.style.setProperty(SEAM, "0.3125");
    adoptColumnProperties(returning as unknown as HTMLElement, 0);
    expect(returning.style.values.get(SEAM)).toBe("0.3125");
  });

  test("only the slot's own values are adopted, and a cleared one is not", () => {
    const { layer, frame } = fakeLayer();
    columnWriter(layer, 1, false)(OTHER_SLOT, "0.5");
    const write = columnWriter(layer, 0, false);
    write(SEAM, "0.4");
    write(SEAM, null);

    const arriving = frame();
    adoptColumnProperties(arriving as unknown as HTMLElement, 0);
    expect([...arriving.style.values.keys()]).toEqual([]);
  });
});
