/**
 * Docket card reuse and seeds: a card is found by `(projectDir, docketId)` in
 * the open registry and in the deck's bags, a seed never keeps a malformed
 * field, and a thread's filed items are exactly what a Move and a Remove act on.
 */
import { afterEach, describe, expect, test } from "bun:test";

import {
  findDocketCardByTarget,
  registerOpenDocketCard,
  unregisterOpenDocketCard,
} from "../docket-card-open-registry";
import { filedItemsOf } from "../docket-filing";
import type { DocketThread } from "../docket-types";
import { coerceDocketSeed, findDocketCardInDeck } from "../open-docket-in-card";

const HERE = "/u/src/tug";

afterEach(() => {
  unregisterOpenDocketCard("card-a");
  unregisterOpenDocketCard("card-b");
});

describe("findDocketCardByTarget", () => {
  test("matches the project and the id, and nothing less", () => {
    registerOpenDocketCard("card-a", {
      getTarget: () => ({ projectDir: HERE, docketId: "aaaa0001" }),
      setTarget: () => {},
    });
    registerOpenDocketCard("card-b", {
      getTarget: () => ({ projectDir: "/u/src/other", docketId: "aaaa0001" }),
      setTarget: () => {},
    });
    expect(findDocketCardByTarget({ projectDir: HERE, docketId: "aaaa0001" })?.cardId).toBe(
      "card-a",
    );
    expect(findDocketCardByTarget({ projectDir: HERE, docketId: "aaaa0002" })).toBeNull();
  });
});

describe("findDocketCardInDeck", () => {
  test("reads a card's bag, skipping other kinds and unseeded dockets", () => {
    const bags: Record<string, unknown> = {
      c1: { target: { root: HERE, sha: "aaaa0001" } },
      d1: {},
      d2: { projectDir: HERE, docketId: "aaaa0001" },
    };
    const store = {
      getSnapshot: () => ({
        cards: [
          { id: "c1", componentId: "commit" },
          { id: "d1", componentId: "docket" },
          { id: "d2", componentId: "docket" },
        ],
      }),
      getCardState: (id: string) => ({ content: bags[id] }),
    } as unknown as Parameters<typeof findDocketCardInDeck>[0];
    expect(findDocketCardInDeck(store, { projectDir: HERE, docketId: "aaaa0001" })).toBe("d2");
    expect(findDocketCardInDeck(store, { projectDir: HERE, docketId: "ffff0000" })).toBeNull();
  });
});

describe("coerceDocketSeed", () => {
  test("keeps the well-formed fields and drops the rest", () => {
    expect(coerceDocketSeed({ projectDir: HERE, docketId: "aaaa0001", thread: "arc:x@t" })).toEqual(
      { projectDir: HERE, docketId: "aaaa0001", thread: "arc:x@t" },
    );
    expect(coerceDocketSeed({ projectDir: "", docketId: 7, showRetired: "yes" })).toEqual({});
    expect(coerceDocketSeed(null)).toBeNull();
  });

  test("an editSketch rides the seed like a thread", () => {
    expect(
      coerceDocketSeed({ projectDir: HERE, docketId: "aaaa0001", editSketch: "3f9a1c2e" }),
    ).toEqual({ projectDir: HERE, docketId: "aaaa0001", editSketch: "3f9a1c2e" });
    expect(coerceDocketSeed({ projectDir: HERE, editSketch: "" })).toEqual({ projectDir: HERE });
  });
});

describe("filedItemsOf", () => {
  test("a thread's filed cells, and the store keys the server gave it", () => {
    const thread: DocketThread = {
      key: "arc:rail@2026-11-20T10:00:00Z",
      start: "2026-11-20T10:00:00Z",
      sketch: { id: "0a1b2c3d", versions: 2, filed: false },
      brief: { title: "Rail", source: "filed", snapshot: "abc123", filed: true },
      arc: { name: "rail", created: "2026-11-20T10:00:00Z", fate: "live", filed: true },
      sessions: [
        { uuid: "048e4155-f644-46f7-a839-d22ac02a564f", filed: false },
        { uuid: "9a9a9a9a-f644-46f7-a839-d22ac02a564f", filed: true },
      ],
      commits: [{ sha: "63de5762a", subject: "x", role: "round", filed: false }],
      // A session is filed by its line: the key is the line's, not the uuid.
      filed_keys: ["arc:rail@2026-11-20T10:00:00Z", "brief:abc123", "session:line-9a"],
    };
    const { items, keys } = filedItemsOf(thread, HERE);
    expect(keys).toEqual(["arc:rail@2026-11-20T10:00:00Z", "brief:abc123", "session:line-9a"]);
    // The brief has no source path left to file from, so a Move leaves it.
    expect(items.map((i) => i.kind)).toEqual(["arc", "session"]);
  });
});
