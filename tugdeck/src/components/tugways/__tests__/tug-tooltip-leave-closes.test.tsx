/**
 * Leaving a trigger closes its bubble, and the neighbour's tooltip answers.
 *
 * Radix's "hoverable content" keeps a bubble up while the pointer crosses a
 * grace area, the hull of the exit point and the bubble, so a reader can
 * travel onto it. A label bubble wider than its button covers the buttons
 * beside it in that hull. Moving from one masthead button onto its neighbour
 * left the first bubble standing, and while the pointer stays inside the hull
 * the provider counts it as "in transit" and refuses every other open. The
 * pointer could rest on the neighbour indefinitely and its tooltip never came.
 * Tug's tooltips are labels with nothing in them to reach, so a leave closes
 * the bubble at once.
 *
 * The move onto the neighbour lands at the exit point, which is inside the
 * grace area wherever jsdom's zero-size rects put it, so the test is the case
 * of a pointer resting in the hull.
 *
 * @covers tugdeck/src/components/tugways/tug-tooltip.tsx
 */

import { afterAll, describe, expect, test } from "bun:test";
import React from "react";

import { installJsdom } from "../../../__tests__/jsdom-deck";

const substrate = installJsdom();

afterAll(() => substrate.restore());

describe("leaving a tooltip's trigger for its neighbour", () => {
  test("closes the first bubble and opens the neighbour's", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { TugTooltip, TugTooltipProvider } = await import("@/components/tugways/tug-tooltip");

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <TugTooltipProvider delayDuration={60}>
          <TugTooltip content="Set this card's width">
            <button type="button" data-testid="a">
              width
            </button>
          </TugTooltip>
          <TugTooltip content="Fit the card">
            <button type="button" data-testid="b">
              fit
            </button>
          </TugTooltip>
        </TugTooltipProvider>,
      );
    });
    const a = host.querySelector<HTMLButtonElement>('[data-testid="a"]')!;
    const b = host.querySelector<HTMLButtonElement>('[data-testid="b"]')!;
    const isOpen = (el: Element): boolean => el.getAttribute("aria-describedby") !== null;
    const wait = async (done: () => boolean): Promise<void> => {
      for (let i = 0; i < 50 && !done(); i++) {
        await act(async () => {
          await new Promise((r) => setTimeout(r, 10));
        });
      }
    };

    await act(async () => {
      a.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: document.body }));
      a.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }));
    });
    await wait(() => isOpen(a));
    expect(isOpen(a), "the first hover opens its bubble").toBe(true);
    expect(
      document.querySelector('[data-slot="tug-tooltip"]') !== null,
      "the bubble mounted — if not, Radix was loaded without a document earlier in this run",
    ).toBe(true);

    // Leave A for B, the way a real pointer does: A's native leave, React's
    // leave and enter (from `pointerout`/`pointerover`), then a move on B.
    await act(async () => {
      a.dispatchEvent(new PointerEvent("pointerleave", { bubbles: false, clientX: 0, clientY: 0 }));
      a.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: b }));
      b.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, relatedTarget: a }));
      b.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse", clientX: 0, clientY: 0 }));
    });
    expect(isOpen(a), "leaving A closes its bubble").toBe(false);

    await wait(() => isOpen(b));
    expect(isOpen(b), "resting on B opens B's bubble after its delay").toBe(true);

    await act(async () => root.unmount());
    host.remove();
  });
});
