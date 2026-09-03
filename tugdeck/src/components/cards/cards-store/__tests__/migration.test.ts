/**
 * Where the Cards store's persisted state is read from, now that it has a
 * domain of its own.
 *
 * The rows' arrangement lived on the retired rail card's domain, because the
 * rows were first drawn as a section of the rail. `dev.tugapp.cards` is the
 * address now, and `dev.tugapp.lens` is read behind it so a user's
 * arrangement survives the move. The fallback is per key rather than per
 * domain: a user may have written one of the three since the move and none of
 * the others.
 *
 * Drives the real `_hydrateFromTugbank` path by injecting a fake tugbank
 * client that answers for both domains.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";

import { cardsStore } from "@/components/cards/cards-store/cards-store";
import {
  CARDS_DOMAIN,
  CARDS_KEYS,
  LEGACY_CARDS_DOMAIN,
  WIDTH_PX_KEY,
} from "@/components/cards/cards-store/types";
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
 * A minimal tugbank client answering for the new domain and the legacy one —
 * only `get`, `onDomainChanged` and `setLocalValue` are touched on this path.
 */
function fakeClient(current: Stored, legacy: Stored = {}): TugbankClient {
  return {
    get(domain: string, key: string): TaggedValue | undefined {
      if (domain === CARDS_DOMAIN) return current[key];
      if (domain === LEGACY_CARDS_DOMAIN) return legacy[key];
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
  it("reads the new domain when it holds the key", () => {
    setTugbankClient(
      fakeClient(
        { [CARDS_KEYS.CARDS_GROUP_ORDER]: jsonArray(["tools"]) },
        { [CARDS_KEYS.CARDS_GROUP_ORDER]: jsonArray(["files"]) },
      ),
    );
    // getSnapshot triggers lazy _ensureInitialized -> _hydrateFromTugbank.
    expect(cardsStore.getSnapshot().cardsGroupOrder).toEqual(["tools"]);
  });

  it("falls back to the legacy domain when the new one is empty", () => {
    setTugbankClient(
      fakeClient({}, { [CARDS_KEYS.CARDS_GROUP_ORDER]: jsonArray(["files"]) }),
    );
    expect(cardsStore.getSnapshot().cardsGroupOrder).toEqual(["files"]);
  });

  it("lands on the defaults when neither domain holds anything", () => {
    setTugbankClient(fakeClient({}, {}));
    const snap = cardsStore.getSnapshot();
    expect(snap.cardsRowOrder).toEqual({ sessions: [], files: [], tools: [] });
    expect(snap.cardsGroupOrder).toEqual([]);
    expect(snap.collapsedCardGroups).toEqual([]);
  });

  it("resolves each key on its own, not the record as a whole", () => {
    // A user who has rearranged their rows since the move but not collapsed a
    // group since: the moved key comes from the new domain and the unmoved one
    // from the legacy domain, in the same hydrate.
    setTugbankClient(
      fakeClient(
        { [CARDS_KEYS.CARDS_ROW_ORDER]: rowOrder({ sessions: ["s-new"] }) },
        {
          [CARDS_KEYS.CARDS_ROW_ORDER]: rowOrder({ sessions: ["s-old"] }),
          [CARDS_KEYS.CARDS_COLLAPSED_GROUPS]: jsonArray(["tools"]),
        },
      ),
    );
    const snap = cardsStore.getSnapshot();
    expect(snap.cardsRowOrder.sessions).toEqual(["s-new"]);
    expect(snap.collapsedCardGroups).toEqual(["tools"]);
  });
});

describe("CardsStore — the retired fields leave no trace", () => {
  it("a legacy sectionOrder / collapsedSections / sessionOrder hydrates to nothing", () => {
    // The section registry these described is gone, and so are the two lists
    // `cardsRowOrder` superseded. A snapshot that still carried them would be
    // a shape with no reader.
    setTugbankClient(
      fakeClient(
        {},
        {
          sectionOrder: jsonArray(["changeset", "log"]),
          collapsedSections: jsonArray(["changeset"]),
          sessionOrder: jsonArray(["s1", "s2"]),
          textFileOrder: jsonArray(["card-a"]),
        },
      ),
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
      fakeClient({ [CARDS_KEYS.CARDS_ROW_ORDER]: rowOrder({ sessions: ["s9"] }) }),
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

describe("CardsStore — seeding the reopen width", () => {
  it("copies a legacy width onto the new domain, where sidebarWidthStore reads", () => {
    // `sidebarWidthStore` knows only `dev.tugapp.cards`; without this the
    // user's hand-chosen width would silently become the registered default.
    const current: Stored = {};
    setTugbankClient(
      fakeClient(current, { [WIDTH_PX_KEY]: { kind: "i64", value: 408 } }),
    );
    cardsStore.getSnapshot();
    expect(current[WIDTH_PX_KEY]).toEqual({ kind: "i64", value: 408 });
  });

  it("never overwrites a width already on the new domain", () => {
    const current: Stored = { [WIDTH_PX_KEY]: { kind: "i64", value: 500 } };
    setTugbankClient(
      fakeClient(current, { [WIDTH_PX_KEY]: { kind: "i64", value: 408 } }),
    );
    cardsStore.getSnapshot();
    expect(current[WIDTH_PX_KEY]).toEqual({ kind: "i64", value: 500 });
  });

  it("writes nothing when neither domain has a width", () => {
    const current: Stored = {};
    setTugbankClient(fakeClient(current, {}));
    cardsStore.getSnapshot();
    expect(WIDTH_PX_KEY in current).toBe(false);
  });
});
