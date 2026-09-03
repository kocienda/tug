/**
 * recent-documents.test.ts — the Open Recent MRU: ordering, de-dupe,
 * cap, seeding from tugbank, and clearing. Persistence rides the real
 * `setTugbankClient` seam with an in-memory fake (no network).
 */

import { beforeEach, describe, expect, it } from "bun:test";

import { TEXT_CARD_DEFAULTS_DOMAIN } from "@/lib/text-card-settings";
import {
  RECENT_DOCUMENTS_MAX_BYTES,
  RECENT_DOCUMENTS_STORE_LIMIT,
  clearRecentDocuments,
  coerceOpenedAt,
  coerceRecentDocuments,
  getRecentDocuments,
  getRecentOpenedAt,
  noteRecentDocument,
  subscribeRecentDocuments,
} from "@/lib/recent-documents";

// The module list is a process-global (the real app singleton). bun
// interleaves test files at hook boundaries, so state that routes through
// the shared tugbank singleton can't be asserted deterministically here —
// persistence I/O is exercised by the app-test. These tests drive the
// in-memory list (deterministic within one synchronous test body) and the
// pure coercion helper.

beforeEach(() => {
  clearRecentDocuments();
});

describe("noteRecentDocument", () => {
  it("keeps most-recent-first order with no duplicates", () => {
    noteRecentDocument("/a.txt");
    noteRecentDocument("/b.txt");
    noteRecentDocument("/a.txt"); // re-open moves /a to the front
    expect(getRecentDocuments()).toEqual(["/a.txt", "/b.txt"]);
  });

  it("caps the stored list", () => {
    for (let i = 0; i < RECENT_DOCUMENTS_STORE_LIMIT + 5; i++) {
      noteRecentDocument(`/f${i}.txt`);
    }
    const list = getRecentDocuments();
    expect(list.length).toBe(RECENT_DOCUMENTS_STORE_LIMIT);
    // Newest survives, oldest evicted.
    expect(list[0]).toBe(`/f${RECENT_DOCUMENTS_STORE_LIMIT + 4}.txt`);
    expect(list).not.toContain("/f0.txt");
  });

  it("ignores an empty path", () => {
    noteRecentDocument("");
    expect(getRecentDocuments()).toEqual([]);
  });
});

describe("coerceRecentDocuments", () => {
  it("drops dupes and non-strings, preserving order", () => {
    expect(
      coerceRecentDocuments(["/a.txt", "/a.txt", 42, "", "/b.txt"]),
    ).toEqual(["/a.txt", "/b.txt"]);
  });

  it("returns empty for a non-array (missing entry)", () => {
    expect(coerceRecentDocuments(undefined)).toEqual([]);
    expect(coerceRecentDocuments(null)).toEqual([]);
    expect(coerceRecentDocuments("nope")).toEqual([]);
  });

  it("caps at the store limit", () => {
    const many = Array.from(
      { length: RECENT_DOCUMENTS_STORE_LIMIT + 5 },
      (_, i) => `/f${i}.txt`,
    );
    expect(coerceRecentDocuments(many).length).toBe(RECENT_DOCUMENTS_STORE_LIMIT);
  });

  it("caps by bytes when paths are pathologically long", () => {
    // Each path is ~4 KB; the byte cap binds well before the count cap.
    const longPath = "/" + "x".repeat(4096);
    const many = Array.from({ length: 20 }, (_, i) => longPath + i);
    const out = coerceRecentDocuments(many);
    const bytes = JSON.stringify(out).length;
    expect(bytes).toBeLessThanOrEqual(RECENT_DOCUMENTS_MAX_BYTES);
    expect(out.length).toBeLessThan(20);
    // Newest-first order is preserved among the survivors.
    expect(out[0]).toBe(longPath + "0");
  });
});

describe("clearRecentDocuments", () => {
  it("empties the list", () => {
    noteRecentDocument("/a.txt");
    clearRecentDocuments();
    expect(getRecentDocuments()).toEqual([]);
  });
});

describe("subscribeRecentDocuments", () => {
  it("fires on note and clear, and stops after unsubscribe", () => {
    let count = 0;
    const unsubscribe = subscribeRecentDocuments(() => {
      count += 1;
    });
    noteRecentDocument("/a.txt");
    expect(count).toBe(1);
    clearRecentDocuments();
    expect(count).toBe(2);
    unsubscribe();
    noteRecentDocument("/b.txt");
    expect(count).toBe(2); // no further notifications after unsubscribe
  });

  it("fires on a re-note of the already-newest path (its last-opened advanced)", () => {
    noteRecentDocument("/a.txt");
    let count = 0;
    const unsubscribe = subscribeRecentDocuments(() => {
      count += 1;
    });
    // The MRU order is unchanged, but the last-opened timestamp moved — the
    // "Last opened …" label must refresh, so listeners fire.
    noteRecentDocument("/a.txt");
    expect(count).toBe(1);
    unsubscribe();
  });
});

describe("last-opened timestamps", () => {
  it("records a timestamp on note, cleared on clear", () => {
    expect(getRecentOpenedAt("/a.txt")).toBeNull();
    noteRecentDocument("/a.txt");
    const t = getRecentOpenedAt("/a.txt");
    expect(typeof t).toBe("number");
    clearRecentDocuments();
    expect(getRecentOpenedAt("/a.txt")).toBeNull();
  });

  it("coerceOpenedAt keeps finite numbers keyed by non-empty path", () => {
    expect(coerceOpenedAt({ "/a.txt": 5, "": 9, "/b.txt": "x", "/c.txt": 7 })).toEqual({
      "/a.txt": 5,
      "/c.txt": 7,
    });
    expect(coerceOpenedAt(null)).toEqual({});
    expect(coerceOpenedAt(["/a.txt"])).toEqual({});
  });
});

// The domain constant is part of the wire contract with the Swift host.
it("stores under the text-card defaults domain", () => {
  expect(TEXT_CARD_DEFAULTS_DOMAIN).toBe("dev.tugapp.text-card");
});
