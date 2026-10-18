/**
 * A pane-modal lock reaches a body page's card content.
 *
 * A banner or sheet locks its card by setting `inert` on the region under the
 * card root it portals into. The shell's pane has `.tug-pane-body` there; a
 * body page (`body/body-root.tsx`) has `.body-pane-root > .tug-pane-content`
 * and no `.tug-pane-body`, so a lock that looked only for the shell's class
 * locked nothing in a body. This mounts a `TugPaneBanner` over each shape.
 *
 * @covers tugdeck/src/components/tugways/use-pane-inert.ts
 * @covers tugdeck/src/components/tugways/tug-pane-banner.tsx
 * @covers tugdeck/src/components/tugways/tug-sheet.tsx
 */

import { afterAll, describe, expect, test } from "bun:test";
import React from "react";

import { installJsdom } from "../../../__tests__/jsdom-deck";

const substrate = installJsdom();

afterAll(() => substrate.restore());

async function mountBannerOver(cardEl: HTMLDivElement, visible: boolean) {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { TugPanePortalContext } = await import("../../chrome/tug-pane");
  const { TugPaneBanner } = await import("../tug-pane-banner");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const render = async (v: boolean) => {
    await act(async () => {
      root.render(
        <TugPanePortalContext value={cardEl}>
          <TugPaneBanner visible={v} variant="error" message="Session errored" />
        </TugPanePortalContext>,
      );
    });
  };
  await render(visible);
  return {
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

function bodyShapedCard(): { cardEl: HTMLDivElement; content: HTMLDivElement } {
  const frame = document.createElement("div");
  frame.className = "body-pane-frame";
  const cardEl = document.createElement("div");
  cardEl.className = "body-pane-root";
  const content = document.createElement("div");
  content.className = "tug-pane-content";
  cardEl.appendChild(content);
  frame.appendChild(cardEl);
  document.body.appendChild(frame);
  return { cardEl, content };
}

describe("a pane-modal lock in a body page", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  test("paneBodyOf names the shell's pane body, and a body page's content", async () => {
    const { paneBodyOf } = await import("../use-pane-inert");
    const shell = document.createElement("div");
    const paneBody = document.createElement("div");
    paneBody.className = "tug-pane-body";
    const inner = document.createElement("div");
    inner.className = "tug-pane-content";
    paneBody.appendChild(inner);
    shell.appendChild(paneBody);
    expect(paneBodyOf(shell)).toBe(paneBody);

    const { cardEl, content } = bodyShapedCard();
    expect(paneBodyOf(cardEl)).toBe(content);
    expect(paneBodyOf(null)).toBeNull();
  });

  test("a visible banner inerts a body page's card content, and its unmount releases it", async () => {
    const { cardEl, content } = bodyShapedCard();
    const mounted = await mountBannerOver(cardEl, true);
    expect(cardEl.querySelector('[data-slot="tug-pane-banner"]')).not.toBeNull();
    expect(content.hasAttribute("inert")).toBe(true);
    await mounted.unmount();
    expect(content.hasAttribute("inert")).toBe(false);
  });

  test("a banner that is not shown leaves the content live", async () => {
    const { cardEl, content } = bodyShapedCard();
    const mounted = await mountBannerOver(cardEl, false);
    expect(content.hasAttribute("inert")).toBe(false);
    await mounted.unmount();
  });
});
