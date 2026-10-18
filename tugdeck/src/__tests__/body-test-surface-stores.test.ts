/**
 * A body's `window.__tug` feeds the body's own stores.
 *
 * The draft store, the ledger's `session_updated` handler and a card's
 * session store are each per page, and a body card reads the copy in its own
 * page — so a frame a test delivered on the shell's surface never reached it.
 * `publishDraftFrame`, `publishSessionUpdated` and `renderedRows` are on the
 * body's surface as well as the shell's.
 *
 * @covers tugdeck/src/test-surface.ts
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";

import { installJsdom } from "./jsdom-deck";

const substrate = installJsdom();

afterAll(() => substrate.restore());

afterEach(async () => {
  const { _resetForTest } = await import("../action-dispatch");
  _resetForTest();
  // A body's surface turns its deck trace on; its observers hang off this
  // jsdom window, which goes before the next file runs.
  const { deckTrace } = await import("../deck-trace");
  deckTrace.enable(false);
  const w = window as unknown as Record<string, unknown>;
  w.__tug = undefined;
  w.__tugTestMode = undefined;
});

describe("attachBodyTestSurface", () => {
  test("carries the page-store verbs, over this page's own handlers", async () => {
    const { attachBodyTestSurface } = await import("../test-surface");
    const { registerAction } = await import("../action-dispatch");
    const w = window as unknown as Record<string, unknown>;
    w.__tugTestMode = true;

    const pushes: unknown[] = [];
    registerAction("session_updated", (payload) => pushes.push(payload));

    attachBodyTestSurface({} as Parameters<typeof attachBodyTestSurface>[0]);
    const surface = w.__tug as Record<string, unknown>;

    expect(typeof surface.publishDraftFrame).toBe("function");
    expect(typeof surface.renderedRows).toBe("function");
    expect(typeof surface.publishSessionUpdated).toBe("function");

    const publish = surface.publishSessionUpdated as (json: string) => boolean;
    expect(publish(JSON.stringify({ session_id: "s1", usage: { turns: 1 } }))).toBe(true);
    expect(pushes).toEqual([{ session_id: "s1", usage: { turns: 1 }, action: "session_updated" }]);
    expect(publish("not json")).toBe(false);

    // A card this page holds no session store for reads as no rows.
    expect(await (surface.renderedRows as (id: string) => Promise<unknown>)("nobody")).toBeNull();
  });
});
