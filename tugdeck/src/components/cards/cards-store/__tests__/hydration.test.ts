/**
 * Where the Cards store's persisted state is read from, and what it makes of
 * what it finds there.
 *
 * `dev.tugapp.cards` is the address, one key per persisted list. Nothing else
 * is consulted: a key absent from it hydrates to the built-in default rather
 * than to some other domain's answer.
 *
 * Drives the real `_hydrateFromTugbank` path by injecting a fake tugbank
 * client that answers for the domain.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";

import { cardsStore } from "@/components/cards/cards-store/cards-store";
import { CARDS_DOMAIN, CARDS_KEYS } from "@/components/cards/cards-store/types";
import { setTugbankClient, getTugbankClient } from "@/lib/tugbank-singleton";
import type { TugbankClient, TaggedValue } from "@/lib/tugbank-client";

function jsonArray(value: string[]): TaggedValue {
  return { kind: "json", value } as TaggedValue;
}

function rowOrder(value: Record<string, string[]>): TaggedValue {
  return { kind: "json", value } as TaggedValue;
}

type Stored = Record<string, TaggedValue>;

/**
 * A minimal tugbank client answering for the Cards domain — only `get`,
 * `onDomainChanged` and `setLocalValue` are touched on this path.
 */
function fakeClient(current: Stored): TugbankClient {
  return {
    get(domain: string, key: string): TaggedValue | undefined {
      if (domain === CARDS_DOMAIN) return current[key];
      return undefined;
    },
    setLocalValue(domain: string, key: string, value: TaggedValue): void {
      if (domain === CARDS_DOMAIN) current[key] = value;
    },
    onDomainChanged(): () => void {
      return () => {};
    },
  } as unknown as TugbankClient;
}

let originalClient: TugbankClient | null;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalClient = getTugbankClient();
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (): Promise<Response> =>
    new Response(null, { status: 200 })) as unknown as typeof globalThis.fetch;
  (cardsStore as unknown as { _disposeForTest: () => void })._disposeForTest();
});

afterEach(() => {
  setTugbankClient(originalClient);
  globalThis.fetch = originalFetch;
  (cardsStore as unknown as { _disposeForTest: () => void })._disposeForTest();
});

describe("CardsStore — where the state resolves from", () => {
  it("reads the domain when it holds the key", () => {
    setTugbankClient(
      fakeClient({ [CARDS_KEYS.CARDS_GROUP_ORDER]: jsonArray(["tools"]) }),
    );
    // getSnapshot triggers lazy _ensureInitialized -> _hydrateFromTugbank.
    expect(cardsStore.getSnapshot().cardsGroupOrder).toEqual(["tools"]);
  });

  it("lands on the defaults when the domain holds nothing", () => {
    setTugbankClient(fakeClient({}));
    const snap = cardsStore.getSnapshot();
    expect(snap.cardsRowOrder).toEqual({ sessions: [], files: [], tools: [] });
    expect(snap.cardsGroupOrder).toEqual([]);
    expect(snap.collapsedCardGroups).toEqual([]);
  });
});

describe("CardsStore — the retired fields leave no trace", () => {
  it("a stored sectionOrder / collapsedSections / sessionOrder hydrates to nothing", () => {
    // The section registry these described is gone, and so are the two lists
    // `cardsRowOrder` superseded. A snapshot that still carried them would be
    // a shape with no reader.
    setTugbankClient(
      fakeClient({
        sectionOrder: jsonArray(["changeset", "log"]),
        collapsedSections: jsonArray(["changeset"]),
        sessionOrder: jsonArray(["s1", "s2"]),
        textFileOrder: jsonArray(["card-a"]),
      }),
    );
    const snap = cardsStore.getSnapshot();
    expect(Object.keys(snap).sort()).toEqual([
      "cardsGroupOrder",
      "cardsRowOrder",
      "collapsedCardGroups",
    ]);
    expect(snap.cardsRowOrder).toEqual({ sessions: [], files: [], tools: [] });
  });
});

describe("CardsStore — the row-order reader", () => {
  it("a stored record missing a group reads that group as empty", () => {
    setTugbankClient(
      fakeClient({
        [CARDS_KEYS.CARDS_ROW_ORDER]: rowOrder({ sessions: ["s9"] }),
      }),
    );
    expect(cardsStore.getSnapshot().cardsRowOrder).toEqual({
      sessions: ["s9"],
      files: [],
      tools: [],
    });
  });

  it("a malformed group list rejects the whole record", () => {
    // Reject-and-keep: half-hydrating one group from a value the writer never
    // produced would be worse than keeping the state that is already there.
    setTugbankClient(
      fakeClient({
        [CARDS_KEYS.CARDS_ROW_ORDER]: {
          kind: "json",
          value: { sessions: ["ok"], files: [7], tools: [] },
        } as TaggedValue,
      }),
    );
    expect(cardsStore.getSnapshot().cardsRowOrder).toEqual({
      sessions: [],
      files: [],
      tools: [],
    });
  });

  it("hydrates the collapsed-group list", () => {
    setTugbankClient(
      fakeClient({ [CARDS_KEYS.CARDS_COLLAPSED_GROUPS]: jsonArray(["tools"]) }),
    );
    expect(cardsStore.getSnapshot().collapsedCardGroups).toEqual(["tools"]);
  });
});
