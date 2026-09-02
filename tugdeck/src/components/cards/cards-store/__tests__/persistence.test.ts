/**
 * Persistence behavior of `CardsStore` — that mutations issue PUT requests to
 * `/api/defaults/dev.tugtool.cards/*` with the right body shape, and that
 * nothing is ever written to the legacy domain. The reducer's pure-logic
 * semantics are exercised in reducer.test.ts; this test pins the wrapper's
 * wire shape.
 *
 * Uses a stubbed `globalThis.fetch` to capture calls. The singleton has no
 * tugbank client wired in test mode, so hydrate is a no-op and mutations still
 * issue fetch via `putRaw` — which is what we check.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";

import { cardsStore } from "@/components/cards/cards-store/cards-store";
import {
  CARDS_DOMAIN,
  CARDS_KEYS,
  LEGACY_CARDS_DOMAIN,
} from "@/components/cards/cards-store/types";

interface CapturedRequest {
  url: string;
  method: string;
  body: unknown;
}

let captured: CapturedRequest[] = [];
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  captured = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    captured.push({
      url,
      method: init?.method ?? "GET",
      body: init?.body !== undefined ? JSON.parse(String(init.body)) : null,
    });
    return new Response(null, { status: 200 });
  }) as typeof globalThis.fetch;
  (cardsStore as unknown as { _disposeForTest: () => void })._disposeForTest();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("CardsStore — persistence", () => {
  it("setCardsRowOrder PUTs the whole record, not just the group", async () => {
    cardsStore.setCardsRowOrder("files", ["card-a", "card-b"]);
    await Promise.resolve();
    const put = captured.find(
      (c) =>
        c.method === "PUT" && c.url.endsWith(`/${CARDS_KEYS.CARDS_ROW_ORDER}`),
    );
    expect(put).toBeDefined();
    expect(put!.url).toBe(
      `/api/defaults/${CARDS_DOMAIN}/${CARDS_KEYS.CARDS_ROW_ORDER}`,
    );
    expect(put!.body).toEqual({
      kind: "json",
      value: { sessions: [], files: ["card-a", "card-b"], tools: [] },
    });
  });

  it("setCardsGroupOrder PUTs a json array", async () => {
    cardsStore.setCardsGroupOrder(["tools", "files"]);
    await Promise.resolve();
    const put = captured.find(
      (c) =>
        c.method === "PUT" && c.url.endsWith(`/${CARDS_KEYS.CARDS_GROUP_ORDER}`),
    );
    expect(put).toBeDefined();
    expect(put!.body).toEqual({ kind: "json", value: ["tools", "files"] });
  });

  it("setCardGroupCollapsed PUTs the collapsed-group json array", async () => {
    cardsStore.setCardGroupCollapsed("tools", true);
    await Promise.resolve();
    const put = captured.find(
      (c) =>
        c.method === "PUT" &&
        c.url.endsWith(`/${CARDS_KEYS.CARDS_COLLAPSED_GROUPS}`),
    );
    expect(put).toBeDefined();
    expect(put!.body).toEqual({ kind: "json", value: ["tools"] });
  });

  it("no write ever names the legacy domain", async () => {
    // The legacy address is read-only. A write there would be a second home
    // for the same state, and the next build to stop reading it would lose
    // whatever had accumulated.
    cardsStore.setCardsRowOrder("sessions", ["s1"]);
    cardsStore.setCardsGroupOrder(["tools"]);
    cardsStore.setCardGroupCollapsed("files", true);
    await Promise.resolve();
    expect(captured.filter((c) => c.url.includes(LEGACY_CARDS_DOMAIN))).toEqual(
      [],
    );
  });

  it("a no-op mutation issues no PUT", async () => {
    cardsStore.setCardGroupCollapsed("tools", false); // never collapsed
    await Promise.resolve();
    expect(captured.filter((c) => c.method === "PUT").length).toBe(0);
  });
});
