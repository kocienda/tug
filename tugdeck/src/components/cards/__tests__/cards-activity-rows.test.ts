/**
 * Pure-logic tests for the Workspaces card's Activity view: two flat groups,
 * Sessions then Files, across every workspace, newest first.
 *
 * `buildCardsRows` with `view: "activity"` is pure over its inputs and its
 * resolver seams, so the order — last live for sessions, time on disk for
 * files, unknown last, ties by workspace then deck order — is asserted here
 * over plain tables, with no registry, no ledger, and no DOM.
 */

import { describe, expect, it } from "bun:test";

import type { CardState, DeckState, TugPaneState } from "@/layout-tree";
import type { CardSessionBinding } from "@/lib/card-session-binding-store";

import {
  ACTIVITY_SCOPE,
  buildCardsRows,
  CardsDataSource,
  idOfRow,
  type CardsResolvers,
  type CardsRow,
  type LensCardsInputs,
  type SpaceRowsInput,
} from "../cards-data-source";

function card(id: string, componentId: string): CardState {
  return { id, componentId, title: "", closable: true };
}

function pane(id: string, cardIds: string[]): TugPaneState {
  return {
    id,
    position: { x: 0, y: 0 },
    size: { width: 100, height: 100 },
    cardIds,
    activeCardId: cardIds[0],
    title: "",
    acceptsFamilies: ["standard"],
  };
}

/** A deck holding one single-card pane per card, except where `stacks` groups them. */
function deck(cards: CardState[], stacks: string[][] = []): DeckState {
  const stacked = new Set(stacks.flat());
  const panes = [
    ...stacks.map((ids, i) => pane(`stack${i}`, ids)),
    ...cards.filter((c) => !stacked.has(c.id)).map((c) => pane(`p-${c.id}`, [c.id])),
  ];
  return { cards, panes, imposition: { sidebars: { dashes: { side: "left" } } }, hasFocus: true };
}

function space(id: string, name: string, d: DeckState, active = false): SpaceRowsInput {
  return { id, name, active, theme: `${id}-theme`, expanded: true, deck: d };
}

function binding(tugSessionId: string): CardSessionBinding {
  return {
    tugSessionId,
    lineId: tugSessionId,
    projectDir: "/Users/k/src/proj",
    workspaceKey: `ws:${tugSessionId}`,
    sessionMode: "new",
  };
}

/** Resolvers over tables: which group a kind files under, each file's path, each card's time. */
function resolvers(times: {
  sessions?: Record<string, number | null>;
  files?: Record<string, number | null>;
  paths?: Record<string, string>;
}): Partial<CardsResolvers> {
  const groups: Record<string, "sessions" | "files" | "tools"> = {
    session: "sessions",
    text: "files",
    settings: "tools",
  };
  return {
    group: (componentId) => groups[componentId] ?? "tools",
    textPath: (cardId) => times.paths?.[cardId] ?? null,
    textDisplayName: (cardId) => cardId,
    textUnsaved: () => false,
    viewPath: () => null,
    parkedFile: () => null,
    resolvedIdentity: () => null,
    sessionLabel: (b) => b.tugSessionId,
    sessionCallsignLine: (b) => `proj/${b.tugSessionId}`,
    defaultTitle: (componentId) => componentId,
    icon: () => null,
    cachedSessionLive: () => false,
    sessionLiveAt: (identity) => times.sessions?.[identity.cardId] ?? null,
    fileModifiedAt: (identity) => times.files?.[identity.cardId] ?? null,
  };
}

function inputs(
  spaces: SpaceRowsInput[],
  over: Partial<LensCardsInputs> = {},
): LensCardsInputs {
  const bindings = new Map<string, CardSessionBinding>();
  for (const s of spaces) {
    for (const c of s.deck.cards) {
      if (c.componentId === "session") bindings.set(c.id, binding(`t-${c.id}`));
    }
  }
  return {
    spaces,
    cardsRowOrder: { sessions: [], files: [], tools: [] },
    groupOrder: [],
    collapsedGroups: [],
    filterQuery: "",
    registryVersion: 0,
    bindings,
    tagVersion: 0,
    nameVersion: 0,
    changesets: null,
    bindingsCache: new Map(),
    view: "activity",
    ...over,
  };
}

/** The rows as `group:cardId`, headers as `[group]`. */
function shape(rows: CardsRow[]): string[] {
  return rows.map((row) => {
    if (row.type === "group-header") return `[${row.group}]`;
    if (row.type === "pane") return `${row.group}:${row.identity.cardId}`;
    return row.type;
  });
}

// Two workspaces, each with a session, a file and a tool.
const MAIN = space(
  "w1",
  "Main",
  deck([card("s-a", "session"), card("f-a", "text"), card("tool-a", "settings")]),
  true,
);
const VIDS = space(
  "w2",
  "Vids",
  deck([card("s-b", "session"), card("f-b", "text"), card("tool-b", "settings")]),
);

describe("Activity — the two groups", () => {
  it("lists Sessions then Files across every workspace, with no workspace headers and no Tools", () => {
    const rows = buildCardsRows(
      inputs([MAIN, VIDS]),
      resolvers({
        sessions: { "s-a": 100, "s-b": 200 },
        files: { "f-a": 300, "f-b": 50 },
      }),
    );
    expect(shape(rows)).toEqual([
      "[sessions]",
      "sessions:s-b",
      "sessions:s-a",
      "[files]",
      "files:f-a",
      "files:f-b",
    ]);
    const headers = rows.filter((r) => r.type === "group-header");
    expect(headers.every((h) => h.spaceId === ACTIVITY_SCOPE)).toBe(true);
  });

  it("each row carries the workspace it lives in", () => {
    const rows = buildCardsRows(inputs([MAIN, VIDS]), resolvers({}));
    const sb = rows.find((r) => r.type === "pane" && r.identity.cardId === "s-b");
    expect(sb?.type === "pane" ? sb.spaceId : null).toBe("w2");
    expect(sb?.type === "pane" ? sb.activity : null).toEqual({
      spaceName: "Vids",
      spaceTheme: "w2-theme",
      at: null,
    });
  });

  it("a group with nothing in it emits nothing, not an empty header", () => {
    const onlyTools = space("w3", "Tools", deck([card("t", "settings")]), true);
    expect(buildCardsRows(inputs([onlyTools]), resolvers({}))).toEqual([]);
  });
});

describe("Activity — sessions order by when they were last live", () => {
  it("a running turn is live now and sorts above every ended one", () => {
    const rows = buildCardsRows(
      inputs([MAIN, VIDS]),
      resolvers({ sessions: { "s-a": Number.POSITIVE_INFINITY, "s-b": 9_000_000 } }),
    );
    expect(shape(rows).slice(0, 3)).toEqual(["[sessions]", "sessions:s-a", "sessions:s-b"]);
  });

  it("a session the ledger knows nothing of sorts last", () => {
    const rows = buildCardsRows(
      inputs([MAIN, VIDS]),
      resolvers({ sessions: { "s-a": null, "s-b": 5 } }),
    );
    expect(shape(rows).slice(0, 3)).toEqual(["[sessions]", "sessions:s-b", "sessions:s-a"]);
  });
});

describe("Activity — files order by their time on disk", () => {
  it("newest first, and a file with no known time sorts to the bottom", () => {
    const three = space(
      "w1",
      "Main",
      deck([card("old", "text"), card("none", "text"), card("new", "text")]),
      true,
    );
    const rows = buildCardsRows(
      inputs([three]),
      resolvers({ files: { old: 10, none: null, new: 20 } }),
    );
    expect(shape(rows)).toEqual(["[files]", "files:new", "files:old", "files:none"]);
  });

  it("equal times keep the workspace order, then deck order, so nothing shuffles", () => {
    const rows = buildCardsRows(
      inputs([MAIN, VIDS]),
      resolvers({ files: { "f-a": 7, "f-b": 7 } }),
    );
    expect(shape(rows).filter((s) => s.startsWith("files:"))).toEqual([
      "files:f-a",
      "files:f-b",
    ]);
  });
});

describe("Activity — each card of a stack is its own row", () => {
  it("lists every card in a pane, at its own time, with ids that do not collide", () => {
    const stacked = space(
      "w1",
      "Main",
      deck([card("one", "text"), card("two", "text")], [["one", "two"]]),
      true,
    );
    const rows = buildCardsRows(
      inputs([stacked]),
      resolvers({ files: { one: 1, two: 2 } }),
    );
    expect(shape(rows)).toEqual(["[files]", "files:two", "files:one"]);
    const ids = rows.map(idOfRow);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("Activity — folds", () => {
  it("a folded group emits its header and nothing under it, by bare group name", () => {
    const rows = buildCardsRows(
      inputs([MAIN, VIDS], { activityCollapsedGroups: ["sessions"] }),
      resolvers({}),
    );
    expect(shape(rows)).toEqual(["[sessions]", "[files]", "files:f-a", "files:f-b"]);
  });

  it("a workspace's group fold does not fold Activity's group", () => {
    const rows = buildCardsRows(
      inputs([MAIN, VIDS], { collapsedGroups: ["w1:files", "w2:files"] }),
      resolvers({}),
    );
    expect(shape(rows)).toContain("files:f-a");
  });
});

describe("Activity — the filter matches the workspace name", () => {
  it("typing a workspace's name narrows both groups to that workspace", () => {
    const rows = buildCardsRows(
      inputs([MAIN, VIDS], { filterQuery: "vids" }),
      resolvers({}),
    );
    expect(shape(rows)).toEqual(["[sessions]", "sessions:s-b", "[files]", "files:f-b"]);
  });

  it("a row still matches on its own text", () => {
    const rows = buildCardsRows(
      inputs([MAIN, VIDS], { filterQuery: "f-a" }),
      resolvers({}),
    );
    expect(shape(rows)).toEqual(["[files]", "files:f-a"]);
  });

  it("the Workspaces view does not match a row on its workspace's name", () => {
    const ds = new CardsDataSource(
      inputs([MAIN, VIDS], { view: "workspaces", filterQuery: "vids" }),
      resolvers({}),
    );
    const panes = Array.from({ length: ds.numberOfItems() }, (_, i) => ds.rowAt(i)).filter(
      (row) => row?.type === "pane",
    );
    expect(panes).toEqual([]);
  });
});

describe("Activity — the data source says which view it is", () => {
  it("isActivity answers for the view the inputs name", () => {
    expect(new CardsDataSource(inputs([MAIN]), resolvers({})).isActivity()).toBe(true);
    expect(
      new CardsDataSource(inputs([MAIN], { view: "workspaces" }), resolvers({})).isActivity(),
    ).toBe(false);
  });
});

describe("Activity — the Workspaces view is untouched", () => {
  it("without the Activity view the projection is the workspace blocks", () => {
    const rows = buildCardsRows(
      inputs([MAIN, VIDS], { view: "workspaces" }),
      resolvers({}),
    );
    expect(rows[0].type).toBe("space-header");
    expect(rows.some((r) => r.type === "pane" && r.activity !== undefined)).toBe(false);
  });
});

describe("Activity — the data source", () => {
  it("names every listed file's path for the stat, filter and folds aside", () => {
    const ds = new CardsDataSource(
      inputs([MAIN, VIDS], {
        filterQuery: "zzz",
        activityCollapsedGroups: ["files"],
      }),
      resolvers({ paths: { "f-a": "/u/a.md", "f-b": "/u/b.md" } }),
    );
    expect(ds.activityFilePathsKey().split("\n").sort()).toEqual(["/u/a.md", "/u/b.md"]);
  });

  it("names none in the Workspaces view", () => {
    const ds = new CardsDataSource(
      inputs([MAIN], { view: "workspaces" }),
      resolvers({ paths: { "f-a": "/u/a.md" } }),
    );
    expect(ds.activityFilePathsKey()).toBe("");
  });

  it("a moved time re-runs the projection through the Activity version", () => {
    let fa = 1;
    const r = {
      ...resolvers({}),
      fileModifiedAt: (identity: { cardId: string }) =>
        identity.cardId === "f-a" ? fa : 2,
    } as Partial<CardsResolvers>;
    const ds = new CardsDataSource(inputs([MAIN, VIDS], { activityVersion: 0 }), r);
    const order = (): string[] =>
      Array.from({ length: ds.numberOfItems() }, (_, i) => ds.idForIndex(i)).filter((id) =>
        id.startsWith("activity:f-"),
      );
    expect(order()).toEqual(["activity:f-b", "activity:f-a"]);
    fa = 3;
    expect(ds.setInputsWithoutNotify(inputs([MAIN, VIDS], { activityVersion: 1 }))).toBe(true);
    expect(order()).toEqual(["activity:f-a", "activity:f-b"]);
  });
});
