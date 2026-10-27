/**
 * The deck bulletin stack is drawn where nothing covers it, and stands clear
 * of the sidebar rails.
 *
 * Wherever the host makes body views every card stands over the shell's
 * page, so a deck bulletin the shell drew there was covered by the card
 * beneath it — a right rail most of all, since the stack sits in the corner
 * it fills. The shell relays each one to the overlay page, as text, and both
 * pages' stacks are offset by the rails' reach through a custom property on
 * the provider's host element.
 *
 * @covers tugdeck/src/components/tugways/tug-bulletin.tsx
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import React from "react";

import { installJsdom } from "../../../__tests__/jsdom-deck";

const substrate = installJsdom();
afterAll(() => substrate.restore());

afterEach(async () => {
  const { setBulletinRelay, setBulletinInsets } = await import("../tug-bulletin");
  setBulletinRelay(null);
  setBulletinInsets({ left: 0, right: 0 });
  document.body.innerHTML = "";
});

describe("the deck bulletin relay", () => {
  test("sends every tone to the relay, as text, and never to this page's stack", async () => {
    const { bulletin, setBulletinRelay } = await import("../tug-bulletin");
    const sent: unknown[] = [];
    setBulletinRelay((relayed) => sent.push(relayed));

    bulletin("Plain");
    bulletin.success("Saved", { duration: 3000 });
    bulletin.caution("Usage at 85%", { description: "Check usage at claude.ai" });
    bulletin.danger("Usage limit reached", { sticky: true, okLabel: "Got it" });

    expect(sent).toEqual([
      { tone: "default", message: "Plain" },
      { tone: "success", message: "Saved", duration: 3000 },
      { tone: "caution", message: "Usage at 85%", description: "Check usage at claude.ai" },
      { tone: "danger", message: "Usage limit reached", sticky: true, okLabel: "Got it" },
    ]);
  });

  test("drops what cannot cross: a callback, and an endless duration", async () => {
    const { relayedBulletinOf } = await import("../tug-bulletin");
    const relayed = relayedBulletinOf("default", "Exported", {
      duration: Infinity,
      action: { label: "View", onClick: () => {} },
    });
    expect(relayed).toEqual({ tone: "default", message: "Exported" });
    // What crosses survives the bus's JSON whole.
    expect(JSON.parse(JSON.stringify(relayed))).toEqual(relayed);
  });
});

describe("the stack's rail insets", () => {
  test("are written on the provider's host at mount and follow every change", async () => {
    const { act } = await import("react");
    const { createRoot } = await import("react-dom/client");
    const { TugBulletinProvider, setBulletinInsets } = await import("../tug-bulletin");

    // A rail stood before the stack mounted: the host carries it at once.
    setBulletinInsets({ left: 0, right: 268 });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(React.createElement(TugBulletinProvider, null));
    });
    try {
      const host = container.querySelector<HTMLElement>(".tug-bulletin-host");
      expect(host).not.toBeNull();
      expect(host!.style.getPropertyValue("--tug-bulletin-inset-right")).toBe("268px");
      expect(host!.style.getPropertyValue("--tug-bulletin-inset-left")).toBe("0px");

      // The rail closes: the stack goes back to the window's edge.
      setBulletinInsets({ left: 0, right: 0 });
      expect(host!.style.getPropertyValue("--tug-bulletin-inset-right")).toBe("0px");
    } finally {
      await act(async () => root.unmount());
    }
  });
});
