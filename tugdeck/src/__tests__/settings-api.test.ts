/**
 * settings-api unit tests.
 *
 * Tests cover:
 * - putCardState sends correct URL and body format (mock fetch)
 * - putCardState / putLayout report write success honestly on both the fetch
 *   and synchronous-XHR branches
 * - readDeckState returns null when not cached
 * - readDeckState returns the string value from cache
 * - putFocusedCardId sends correct URL and body format (mock fetch)
 * - readCardStates returns populated Map for known card IDs
 * - readCardStates skips missing entries
 * - readDefaultProjectPath / resolveDefaultProjectPath explicit-vs-resolved
 *   precedence, and putDefaultProjectPath's wire shape (mock fetch)
 */

import { describe, test, expect, mock, afterEach } from "bun:test";
import {
  putCardState,
  putLayout,
  readDeckState,
  putFocusedCardId,
  readCardStates,
  readSessionRecentProjects,
  insertSessionRecentProject,
  capDurableCardState,
  pruneOrphanedCardDefaults,
  CARD_KEYED_DOMAINS,
  SESSION_RECENT_PROJECTS_MAX,
  readDefaultProjectPath,
  putDefaultProjectPath,
  resolveDefaultProjectPath,
} from "../settings-api";
import type { CardStateBag } from "../layout-tree";
import type { TugbankClient, TaggedValue } from "../lib/tugbank-client";

// ---------------------------------------------------------------------------
// fetch mock helpers
// ---------------------------------------------------------------------------

/** Build a minimal Response-like object for mocking fetch. */
function makeResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// TugbankClient mock helpers
// ---------------------------------------------------------------------------

/** Create a minimal TugbankClient mock with a backing store. */
function makeMockClient(
  store: Record<string, Record<string, TaggedValue>> = {}
): TugbankClient {
  return {
    get(domain: string, key: string): TaggedValue | undefined {
      return store[domain]?.[key];
    },
    readDomain(domain: string): Record<string, TaggedValue> | undefined {
      return store[domain];
    },
  } as TugbankClient;
}

const CARDSTATE_DOMAIN = "dev.tugapp.deck.cardstate";

// ---------------------------------------------------------------------------
// putCardState
// ---------------------------------------------------------------------------

describe("putCardState", () => {
  afterEach(() => {
    mock.restore();
  });

  test("sends PUT to correct URL with json-tagged body", async () => {
    const calls: { url: string; init: RequestInit }[] = [];

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: url as string, init: init ?? {} });
      return makeResponse(200, {});
    }) as unknown as typeof fetch;

    const cardId = "card-abc-123";
    const bag: CardStateBag = { scroll: { x: 10, y: 50 }, content: { key: "val" } };
    putCardState(cardId, bag);

    // Give the fire-and-forget promise a tick to run.
    await new Promise((r) => setTimeout(r, 0));

    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(
      `/api/defaults/dev.tugapp.deck.cardstate/${encodeURIComponent(cardId)}`
    );
    expect(calls[0].init.method).toBe("PUT");

    const body = JSON.parse(calls[0].init.body as string);
    expect(body.kind).toBe("json");
    expect(body.value.scroll.x).toBe(10);
    expect(body.value.scroll.y).toBe(50);
    expect((body.value.content as Record<string, string>).key).toBe("val");
  });

  test("card ID with special characters is percent-encoded in URL", async () => {
    const calls: { url: string }[] = [];

    globalThis.fetch = (async (url: string | URL | Request) => {
      calls.push({ url: url as string });
      return makeResponse(200, {});
    }) as unknown as typeof fetch;

    const cardId = "card/with spaces&chars";
    putCardState(cardId, {});
    await new Promise((r) => setTimeout(r, 0));

    expect(calls[0].url).toBe(
      `/api/defaults/dev.tugapp.deck.cardstate/${encodeURIComponent(cardId)}`
    );
  });
});

// ---------------------------------------------------------------------------
// Write acknowledgment
//
// A card-state write that never landed used to resolve exactly like one that
// did, so a quit taken while tugbank was restarting dropped the user's typing
// while the host logged success. Both branches now answer honestly.
// ---------------------------------------------------------------------------

/** Install a synchronous XMLHttpRequest stub that answers with `status`. */
function stubSyncXhr(status: number): void {
  globalThis.XMLHttpRequest = class {
    status = 0;
    open(): void {}
    setRequestHeader(): void {}
    send(): void {
      this.status = status;
    }
  } as unknown as typeof XMLHttpRequest;
}

describe("write acknowledgment", () => {
  afterEach(() => {
    mock.restore();
  });

  test("putCardState resolves true on 2xx and false on a rejected status", async () => {
    globalThis.fetch = (async () => makeResponse(200, {})) as unknown as typeof fetch;
    expect(await putCardState("card-ok", {})).toBe(true);

    globalThis.fetch = (async () => makeResponse(500, {})) as unknown as typeof fetch;
    expect(await putCardState("card-bad", {})).toBe(false);
  });

  test("putCardState resolves false when the request itself throws", async () => {
    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    expect(await putCardState("card-down", {})).toBe(false);
  });

  test("putCardState sync branch reports the XHR status, not just exceptions", async () => {
    stubSyncXhr(200);
    expect(await putCardState("card-ok", {}, { sync: true })).toBe(true);

    stubSyncXhr(503);
    expect(await putCardState("card-bad", {}, { sync: true })).toBe(false);
  });

  test("putCardState sync branch resolves false when send throws", async () => {
    globalThis.XMLHttpRequest = class {
      status = 0;
      open(): void {}
      setRequestHeader(): void {}
      send(): never {
        throw new Error("network error");
      }
    } as unknown as typeof XMLHttpRequest;

    expect(await putCardState("card-thrown", {}, { sync: true })).toBe(false);
  });

  test("putLayout resolves true on 2xx, false on a rejected status or throw", async () => {
    globalThis.fetch = (async () => makeResponse(200, {})) as unknown as typeof fetch;
    expect(await putLayout({})).toBe(true);

    globalThis.fetch = (async () => makeResponse(404, {})) as unknown as typeof fetch;
    expect(await putLayout({})).toBe(false);

    globalThis.fetch = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    expect(await putLayout({})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// putFocusedCardId
// ---------------------------------------------------------------------------

describe("putFocusedCardId", () => {
  afterEach(() => {
    mock.restore();
  });

  test("sends PUT to correct URL with string-tagged body", async () => {
    const calls: { url: string; init: RequestInit }[] = [];

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: url as string, init: init ?? {} });
      return makeResponse(200, {});
    }) as unknown as typeof fetch;

    putFocusedCardId("card-xyz");
    await new Promise((r) => setTimeout(r, 0));

    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe("/api/defaults/dev.tugapp.deck.state/focusedCardId");
    expect(calls[0].init.method).toBe("PUT");

    const body = JSON.parse(calls[0].init.body as string);
    expect(body.kind).toBe("string");
    expect(body.value).toBe("card-xyz");
  });
});

// ---------------------------------------------------------------------------
// readDeckState
// ---------------------------------------------------------------------------

describe("readDeckState", () => {
  test("returns null when domain is not cached", () => {
    const client = makeMockClient();
    expect(readDeckState(client)).toBeNull();
  });

  test("returns the string value from cache", () => {
    const cardId = "card-focused-789";
    const client = makeMockClient({
      "dev.tugapp.deck.state": {
        focusedCardId: { kind: "string", value: cardId },
      },
    });
    expect(readDeckState(client)).toBe(cardId);
  });

  test("returns null when entry has unexpected tagged format", () => {
    const client = makeMockClient({
      "dev.tugapp.deck.state": {
        focusedCardId: { kind: "json", value: { not: "a string" } },
      },
    });
    expect(readDeckState(client)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readCardStates
// ---------------------------------------------------------------------------

describe("readCardStates", () => {
  test("returns empty Map when cardIds array is empty", () => {
    const client = makeMockClient();
    const result = readCardStates(client, []);
    expect(result.size).toBe(0);
  });

  test("returns populated Map for cards with stored state", () => {
    const bag1: CardStateBag = { scroll: { x: 0, y: 100 } };
    const bag2: CardStateBag = { scroll: { x: 20, y: 30 }, content: "hello" };

    const client = makeMockClient({
      [CARDSTATE_DOMAIN]: {
        "card-1": { kind: "json", value: bag1 },
        "card-2": { kind: "json", value: bag2 },
      },
    });

    const result = readCardStates(client, ["card-1", "card-2"]);
    expect(result.size).toBe(2);
    expect(result.get("card-1")?.scroll?.y).toBe(100);
    expect(result.get("card-2")?.scroll?.x).toBe(20);
    expect(result.get("card-2")?.content).toBe("hello");
  });

  test("skips missing entries — absent cards are not in the returned Map", () => {
    const bag: CardStateBag = { scroll: { x: 5, y: 10 } };

    const client = makeMockClient({
      [CARDSTATE_DOMAIN]: {
        "card-present": { kind: "json", value: bag },
      },
    });

    const result = readCardStates(client, ["card-present", "card-missing"]);
    expect(result.size).toBe(1);
    expect(result.has("card-present")).toBe(true);
    expect(result.has("card-missing")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pruneOrphanedCardDefaults
// ---------------------------------------------------------------------------

describe("pruneOrphanedCardDefaults", () => {
  afterEach(() => {
    mock.restore();
  });

  const tagged = (v: unknown): TaggedValue => ({ kind: "json", value: v });

  test("deletes non-live card ids across every card-keyed domain", async () => {
    // "live" is present; "dead" is orphaned. Each domain carries both.
    const store: Record<string, Record<string, TaggedValue>> = {};
    for (const domain of CARD_KEYED_DOMAINS) {
      store[domain] = { live: tagged(1), dead: tagged(1) };
    }
    const client = makeMockClient(store);

    const deletes: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "DELETE") deletes.push(url as string);
      return makeResponse(200, {});
    }) as unknown as typeof fetch;

    pruneOrphanedCardDefaults(client, new Set(["live"]));
    await new Promise((r) => setTimeout(r, 0));

    // One DELETE per domain, all for "dead", none for "live".
    expect(deletes.length).toBe(CARD_KEYED_DOMAINS.length);
    for (const domain of CARD_KEYED_DOMAINS) {
      expect(deletes).toContain(`/api/defaults/${domain}/dead`);
      expect(deletes).not.toContain(`/api/defaults/${domain}/live`);
    }
  });

  test("covers cardstate, permission-mode, and model", () => {
    expect(CARD_KEYED_DOMAINS).toContain("dev.tugapp.deck.cardstate");
    expect(CARD_KEYED_DOMAINS).toContain("dev.permission-mode");
    expect(CARD_KEYED_DOMAINS).toContain("dev.model");
  });

  test("skips a domain absent from the cache", async () => {
    // Only cardstate present; the other domains return undefined → skipped.
    const client = makeMockClient({
      "dev.tugapp.deck.cardstate": { dead: tagged(1) },
    });
    const deletes: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "DELETE") deletes.push(url as string);
      return makeResponse(200, {});
    }) as unknown as typeof fetch;

    pruneOrphanedCardDefaults(client, new Set());
    await new Promise((r) => setTimeout(r, 0));

    expect(deletes).toEqual(["/api/defaults/dev.tugapp.deck.cardstate/dead"]);
  });
});

// ---------------------------------------------------------------------------
// dev recent-projects (step 4m)
// ---------------------------------------------------------------------------

describe("insertSessionRecentProject", () => {
  test("prepends a new path to an empty list", () => {
    expect(insertSessionRecentProject([], "/tmp")).toEqual(["/tmp"]);
  });

  test("moves an existing path to the front (dedup)", () => {
    expect(insertSessionRecentProject(["/a", "/b", "/c"], "/b")).toEqual([
      "/b",
      "/a",
      "/c",
    ]);
  });

  test("caps the list at SESSION_RECENT_PROJECTS_MAX", () => {
    const over = ["/a", "/b", "/c", "/d", "/e"];
    const next = insertSessionRecentProject(over, "/f");
    expect(next.length).toBe(SESSION_RECENT_PROJECTS_MAX);
    expect(next[0]).toBe("/f");
    // Oldest entry drops off.
    expect(next).not.toContain("/e");
  });
});

describe("readSessionRecentProjects", () => {
  test("returns [] when the key is unset", () => {
    const client = makeMockClient({});
    expect(readSessionRecentProjects(client)).toEqual([]);
  });

  test("returns the paths array from a json-tagged value", () => {
    const client = makeMockClient({
      "dev.tugapp.dev": {
        "recent-projects": {
          kind: "json",
          value: { paths: ["/a", "/b"] },
        } as TaggedValue,
      },
    });
    expect(readSessionRecentProjects(client)).toEqual(["/a", "/b"]);
  });

  test("drops non-string entries defensively", () => {
    const client = makeMockClient({
      "dev.tugapp.dev": {
        "recent-projects": {
          kind: "json",
          value: { paths: ["/a", 42, null, "", "/b"] },
        } as TaggedValue,
      },
    });
    expect(readSessionRecentProjects(client)).toEqual(["/a", "/b"]);
  });

  test("returns [] when the value shape is wrong", () => {
    const client = makeMockClient({
      "dev.tugapp.dev": {
        "recent-projects": { kind: "json", value: "not-an-object" } as TaggedValue,
      },
    });
    expect(readSessionRecentProjects(client)).toEqual([]);
  });
});

// PUT behavior for `putSessionRecentProjects` is covered by T-DEV-07 in
// session-card.test.tsx (which asserts the bind effect fires it with the
// right payload). Duplicating it here would require an unmocked
// `fetch`, but session-card.test.tsx process-globally replaces the
// exported `putSessionRecentProjects` with a recorder to keep session-card's
// bind effect from racing with other test files' fetch stubs.

describe("capDurableCardState — strip the dead cellHeights field", () => {
  test("drops cellHeights of any size, keeps anchor + scroll", () => {
    const bag: CardStateBag = {
      scroll: { x: 0, y: 9 },
      regionScroll: {
        "session-card-transcript": {
          x: 0,
          y: 5000,
          meta: { anchor: { index: 900, offset: 2 }, cellHeights: new Array(50).fill(60) },
        },
      },
    };
    const out = capDurableCardState(bag);
    const region = out.regionScroll!["session-card-transcript"];
    expect((region.meta as Record<string, unknown>).cellHeights).toBeUndefined();
    expect((region.meta as Record<string, unknown>).anchor).toEqual({ index: 900, offset: 2 });
    expect(region.y).toBe(5000);
    expect(out.scroll).toEqual({ x: 0, y: 9 });
    // The input bag (the in-memory copy) is NOT mutated.
    expect(
      ((bag.regionScroll!["session-card-transcript"].meta as Record<string, unknown>)
        .cellHeights as number[]).length,
    ).toBe(50);
  });

  test("a bag with no cellHeights is returned unchanged (same reference)", () => {
    const bag: CardStateBag = {
      regionScroll: { r: { x: 0, y: 0, meta: { anchor: { index: 1, offset: 0 } } } },
    };
    expect(capDurableCardState(bag)).toBe(bag);
  });

  test("a bag with no regionScroll is returned unchanged", () => {
    const bag: CardStateBag = { scroll: { x: 0, y: 0 } };
    expect(capDurableCardState(bag)).toBe(bag);
  });

  test("strips cellHeights from every region that carries it", () => {
    const bag: CardStateBag = {
      regionScroll: {
        big: { x: 0, y: 0, meta: { cellHeights: new Array(900).fill(1) } },
        small: { x: 0, y: 0, meta: { cellHeights: new Array(3).fill(1) } },
      },
    };
    const out = capDurableCardState(bag);
    expect((out.regionScroll!.big.meta as Record<string, unknown>).cellHeights).toBeUndefined();
    expect((out.regionScroll!.small.meta as Record<string, unknown>).cellHeights).toBeUndefined();
  });
});

describe("capDurableCardState — attachment bytes become references", () => {
  /** The `attachmentBytes` map off a capped bag. */
  function cappedBytes(out: CardStateBag): Record<string, Record<string, unknown>> {
    return (out.content as Record<string, unknown>).attachmentBytes as Record<
      string,
      Record<string, unknown>
    >;
  }

  test("a path-bearing entry keeps its path and sheds every byte", () => {
    const bag: CardStateBag = {
      content: {
        route: "❯",
        draft: { text: "hi", atoms: [], selection: null },
        attachmentBytes: {
          b1: {
            content: "AAAA",
            mediaType: "image/png",
            thumbnailDataUrl: "data:image/png;base64,QUJD",
            path: "/data/draft-attachments/abc.png",
          },
        },
      },
    };
    const out = capDurableCardState(bag);
    expect(cappedBytes(out).b1).toEqual({
      content: "",
      mediaType: "image/png",
      path: "/data/draft-attachments/abc.png",
    });
    const content = out.content as Record<string, unknown>;
    expect(content.route).toBe("❯");
    expect(content.draft).toEqual({ text: "hi", atoms: [], selection: null });
    // The input bag is not mutated — the in-memory cache keeps its bytes.
    expect(
      (
        (bag.content as Record<string, unknown>).attachmentBytes as Record<
          string,
          Record<string, unknown>
        >
      ).b1.content,
    ).toBe("AAAA");
  });

  /**
   * The Success Criterion in one assertion: a card with three dropped images
   * persists three short path strings and no image data at all. A thumbnail
   * here would re-grow the surface that once stalled boot at ~18 MB.
   */
  test("no entry carries image data of any kind — no content, no thumbnail", () => {
    const bag: CardStateBag = {
      content: {
        attachmentBytes: {
          b1: { content: "A".repeat(4096), mediaType: "image/png", thumbnailDataUrl: "data:x", path: "/d/1.png" },
          b2: { content: "B".repeat(4096), mediaType: "image/jpeg", thumbnailDataUrl: "data:y", path: "/d/2.jpg" },
          b3: { content: "C".repeat(4096), mediaType: "image/gif", thumbnailDataUrl: "data:z", path: "/d/3.gif" },
        },
      },
    };
    const entries = Object.values(cappedBytes(capDurableCardState(bag)));
    expect(entries).toHaveLength(3);
    for (const entry of entries) {
      expect(entry.content).toBe("");
      expect(entry.thumbnailDataUrl).toBeUndefined();
      expect(typeof entry.path).toBe("string");
    }
  });

  test("an entry with no path degrades to a media type alone", () => {
    const bag: CardStateBag = {
      content: {
        attachmentBytes: { b1: { content: "AAAA", mediaType: "image/png" } },
      },
    };
    expect(cappedBytes(capDurableCardState(bag)).b1).toEqual({
      content: "",
      mediaType: "image/png",
    });
  });

  test("a malformed entry is dropped, and an all-malformed map removes the field", () => {
    const bag: CardStateBag = {
      content: {
        route: "$",
        attachmentBytes: { junk: null, alsoJunk: { content: "x" } },
      },
    };
    const content = capDurableCardState(bag).content as Record<string, unknown>;
    expect(content.attachmentBytes).toBeUndefined();
    expect(content.route).toBe("$");
  });

  test("a content payload without attachmentBytes is returned unchanged", () => {
    const bag: CardStateBag = {
      content: { route: "$", draft: null },
    };
    expect(capDurableCardState(bag)).toBe(bag);
  });

  test("caps attachmentBytes and cellHeights in one pass", () => {
    const bag: CardStateBag = {
      content: {
        attachmentBytes: { b: { content: "x", mediaType: "image/png", path: "/d/b.png" } },
      },
      regionScroll: { r: { x: 0, y: 0, meta: { cellHeights: [1, 2, 3] } } },
    };
    const out = capDurableCardState(bag);
    expect(cappedBytes(out).b).toEqual({
      content: "",
      mediaType: "image/png",
      path: "/d/b.png",
    });
    expect((out.regionScroll!.r.meta as Record<string, unknown>).cellHeights).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// default project directory
// ---------------------------------------------------------------------------

describe("default project directory", () => {
  afterEach(() => {
    mock.restore();
  });

  test("readDefaultProjectPath returns the stored string", () => {
    const client = makeMockClient({
      "dev.tugapp.app": {
        "default-project-path": { kind: "string", value: "/Users/x/code" },
      },
    });
    expect(readDefaultProjectPath(client)).toBe("/Users/x/code");
  });

  test("readDefaultProjectPath returns null when unset", () => {
    expect(readDefaultProjectPath(makeMockClient())).toBeNull();
  });

  test("readDefaultProjectPath ignores a non-string entry", () => {
    const client = makeMockClient({
      "dev.tugapp.app": {
        "default-project-path": { kind: "bool", value: true },
      },
    });
    expect(readDefaultProjectPath(client)).toBeNull();
  });

  test("resolveDefaultProjectPath prefers the explicit value over home", () => {
    const client = makeMockClient({
      "dev.tugapp.app": {
        "default-project-path": { kind: "string", value: "/Users/x/code" },
      },
    });
    expect(resolveDefaultProjectPath(client, "/Users/x")).toBe("/Users/x/code");
  });

  test("resolveDefaultProjectPath falls back to <home>/tug when unset", () => {
    expect(resolveDefaultProjectPath(makeMockClient(), "/Users/x")).toBe(
      "/Users/x/tug",
    );
  });

  test("resolveDefaultProjectPath tolerates a trailing slash on home", () => {
    expect(resolveDefaultProjectPath(makeMockClient(), "/Users/x/")).toBe(
      "/Users/x/tug",
    );
  });

  test("resolveDefaultProjectPath returns null with no explicit value and no home", () => {
    expect(resolveDefaultProjectPath(makeMockClient(), null)).toBeNull();
  });

  test("an empty explicit value reads through to the home fallback", () => {
    const client = makeMockClient({
      "dev.tugapp.app": { "default-project-path": { kind: "string", value: "" } },
    });
    expect(resolveDefaultProjectPath(client, "/Users/x")).toBe("/Users/x/tug");
  });

  /**
   * Stand in for tugcast: `/api/fs/stat` answers with `canonicalOf` (absent ⇒
   * the gateway refuses the path), everything else with 200. Returns the call
   * log so a test can assert what was sent where.
   */
  function mockPathServer(
    canonicalOf: Record<string, string>,
    putStatus = 200,
  ): { url: string; init: RequestInit }[] {
    const calls: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: url as string, init: init ?? {} });
      if ((url as string) === "/api/fs/stat") {
        const body = JSON.parse((init?.body as string) ?? "{}") as {
          paths?: string[];
        };
        const canonical: Record<string, string> = {};
        for (const p of body.paths ?? []) {
          if (canonicalOf[p] !== undefined) canonical[p] = canonicalOf[p];
        }
        return makeResponse(200, { exists: {}, canonical });
      }
      return makeResponse(putStatus, {});
    }) as unknown as typeof fetch;
    return calls;
  }

  test("putDefaultProjectPath PUTs the canonical path to the app domain", async () => {
    // The typed spelling reaches the gateway; the canonical one is what gets
    // stored ([L29] — this is a persisted key).
    const calls = mockPathServer({ "/u/src/code": "/Users/x/src/code" });

    const stored = await putDefaultProjectPath("/u/src/code");

    expect(stored).toBe("/Users/x/src/code");
    expect(calls.map((c) => c.url)).toEqual([
      "/api/fs/stat",
      "/api/defaults/dev.tugapp.app/default-project-path",
    ]);
    expect(calls[1].init.method).toBe("PUT");
    expect(JSON.parse(calls[1].init.body as string)).toEqual({
      kind: "string",
      value: "/Users/x/src/code",
    });
  });

  test("putDefaultProjectPath stores nothing when the gateway won't resolve the path", async () => {
    const calls = mockPathServer({});

    expect(await putDefaultProjectPath("relative/code")).toBeNull();
    // No PUT: a path that skipped the gateway is never persisted.
    expect(calls.map((c) => c.url)).toEqual(["/api/fs/stat"]);
  });

  test("putDefaultProjectPath reports a rejected write rather than claiming it stored", async () => {
    mockPathServer({ "/Users/x/code": "/Users/x/code" }, 500);
    expect(await putDefaultProjectPath("/Users/x/code")).toBeNull();
  });

  test("putDefaultProjectPath clears the setting without a gateway round trip", async () => {
    const calls = mockPathServer({});

    expect(await putDefaultProjectPath("")).toBe("");
    expect(calls.map((c) => c.url)).toEqual([
      "/api/defaults/dev.tugapp.app/default-project-path",
    ]);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      kind: "string",
      value: "",
    });
  });
});
