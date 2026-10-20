/**
 * A move's press marks the frame the host is about to carry.
 *
 * While the host carries its view, the view travels under the hand and the
 * title bar's `data-pointer-within` flickers off; the frame's
 * `data-gesture="true"` is what keeps the grab dots the hand is holding lit.
 * It comes off at the first move the page hears after the release, or at the
 * next press, and not at a move before the release: the page hears the hand's
 * moves while the view travels under it.
 *
 * @covers tugdeck/src/body/body-chrome.ts
 */

import { afterAll, describe, expect, test } from "bun:test";
import { installJsdom } from "../../__tests__/jsdom-deck";

const substrate = installJsdom();
const { container, win } = substrate;

afterAll(() => substrate.restore());

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function bar(): { frame: HTMLElement; handle: HTMLElement } {
  container.innerHTML = '<div class="tug-pane body-chrome-frame"><div class="tug-pane-title-bar"><span class="tug-pane-grab-handle"></span></div></div>';
  return {
    frame: container.querySelector<HTMLElement>(".tug-pane")!,
    handle: container.querySelector<HTMLElement>(".tug-pane-grab-handle")!,
  };
}

const pointer = (type: string, buttons: number): Event => {
  const Ctor = (win as unknown as { PointerEvent?: typeof MouseEvent; MouseEvent: typeof MouseEvent }).PointerEvent ?? (win as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent;
  return new Ctor(type, { bubbles: true, buttons });
};

describe("a carried card's frame", () => {
  test("is marked at the press, held through the moves and the release, and lifted at the first move after it", async () => {
    const { markCarried } = await import("../body-chrome");
    const { frame, handle } = bar();
    markCarried({ target: handle } as never);
    expect(frame.getAttribute("data-gesture")).toBe("true");
    await tick();
    win.dispatchEvent(pointer("pointermove", 0));
    expect(frame.getAttribute("data-gesture")).toBe("true");
    win.dispatchEvent(pointer("pointerup", 0));
    expect(frame.getAttribute("data-gesture")).toBe("true");
    win.dispatchEvent(pointer("pointermove", 0));
    expect(frame.hasAttribute("data-gesture")).toBe(false);
  });

  test("is lifted by the next press", async () => {
    const { markCarried } = await import("../body-chrome");
    const { frame, handle } = bar();
    markCarried({ target: handle } as never);
    await tick();
    win.dispatchEvent(pointer("pointerdown", 1));
    expect(frame.hasAttribute("data-gesture")).toBe(false);
  });
});
