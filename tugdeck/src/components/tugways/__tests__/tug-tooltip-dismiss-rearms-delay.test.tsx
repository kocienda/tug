/**
 * A tooltip closed from outside Radix leaves the delay armed for the next one.
 *
 * `TugTooltip` closes its bubble on a click, a dispatch, a menu or another
 * bubble — none of which Radix hears. Radix re-arms its provider's "the next
 * open waits" flag only when it closes a bubble itself, so a close that
 * merely turned the `open` prop off left the flag down and the next hover in
 * the page opened at once, whatever Settings ▸ General ▸ Tooltip Delay said.
 * A hover that opens at once opens inside its own `pointermove`, so the
 * assertion is that right after the second hover the bubble is still closed,
 * and that it opens after the delay.
 *
 * @covers tugdeck/src/components/tugways/tug-tooltip.tsx
 */

import { afterAll, describe, expect, test } from "bun:test";
import React from "react";

import { installJsdom } from "../../../__tests__/jsdom-deck";

const substrate = installJsdom();

afterAll(() => substrate.restore());

describe("a tooltip dismissed from outside Radix", () => {
  test("leaves the next hover waiting its delay", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { TugTooltip, TugTooltipProvider } = await import("@/components/tugways/tug-tooltip");
    const { dismissTooltips } = await import("@/lib/tooltip-dismiss");

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <TugTooltipProvider delayDuration={60}>
          <TugTooltip content="Says what it does">
            <button type="button" data-testid="trigger">
              go
            </button>
          </TugTooltip>
        </TugTooltipProvider>,
      );
    });
    const trigger = host.querySelector<HTMLButtonElement>('[data-testid="trigger"]')!;
    const isOpen = (): boolean => trigger.getAttribute("aria-describedby") !== null;
    const hover = async (): Promise<void> => {
      await act(async () => {
        trigger.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }));
        trigger.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }));
      });
    };
    const settle = async (): Promise<void> => {
      for (let i = 0; i < 50 && !isOpen(); i++) {
        await act(async () => {
          await new Promise((r) => setTimeout(r, 10));
        });
      }
    };

    await hover();
    expect(isOpen(), "the first hover waits its delay").toBe(false);
    await settle();
    expect(isOpen(), "and then opens").toBe(true);
    // Radix re-arms the delay from the bubble's own close, so the bubble has
    // to have mounted. It cannot if Radix was first loaded in this run by a
    // file with no jsdom: `@radix-ui/react-use-layout-effect` picks a no-op
    // when `document` is absent at module load, and `Presence` never mounts.
    expect(
      document.querySelector('[data-slot="tug-tooltip"]') !== null,
      "the bubble mounted — if not, Radix was loaded without a document earlier in this run",
    ).toBe(true);

    // A dismissal Radix never hears: the gesture path a click takes. Radix
    // re-arms its delay on a zero `window.setTimeout` — jsdom's queue — so the
    // wait is taken on that queue too.
    await act(async () => {
      dismissTooltips();
      await new Promise((r) => window.setTimeout(r, 20));
    });
    expect(isOpen(), "the dismissal closes it").toBe(false);

    await hover();
    expect(isOpen(), "the next hover waits its delay too, rather than opening at once").toBe(false);
    await settle();
    expect(isOpen(), "and then opens").toBe(true);

    await act(async () => root.unmount());
    host.remove();
  });
});
