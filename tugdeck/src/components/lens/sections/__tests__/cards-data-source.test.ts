/**
 * Pure-logic tests for the Lens Cards projection.
 *
 * `buildCardsRows` is pure over its inputs and its resolver seams, so the
 * whole two-level model — grouping, filing, ordering, filtering, collapse,
 * subrow emission — is exercised here with no registry, no stores, and no DOM.
 * The section on top of it then only has to render what this produces.
 *
 * Ports every case from the retired `files-data-source.test.ts` (path
 * helpers, disambiguators, ordering) and adds the pane-first cases.
 */

import { describe, expect, it } from "bun:test";

import type { CardState, DeckState, TugPaneState } from "@/layout-tree";
import type { CardSessionBinding } from "@/lib/card-session-binding-store";
import type { WorkspacesChangesetSnapshot } from "@/lib/changeset-types";

import {
  assignDisambiguators,
  basename,
  buildCardsRows,
  dirname,
  displayDir,
  displayPath,
  idOfRow,
  kindOfRow,
  LensCardsDataSource,
  summarizeGroup,
  type CardIdentity,
  type CardsResolvers,
  type CardsRow,
  type LensCardsInputs,
} from "../cards-data-source";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function card(
  id: string,
  componentId: string,
  title = "",
  closable = true,
): CardState {
  return { id, componentId, title, closable };
}

function pane(id: string, cardIds: string[], activeCardId?: string): TugPaneState {
  return {
    id,
    position: { x: 0, y: 0 },
    size: { width: 100, height: 100 },
    cardIds,
    activeCardId: activeCardId ?? cardIds[0],
    title: "",
    acceptsFamilies: ["standard"],
  };
}

function deck(cards: CardState[], panes: TugPaneState[]): DeckState {
  return { cards, panes, imposition: { sidebars: { lens: { side: "left" } } }, hasFocus: true };
}

function binding(
  tugSessionId: string,
  projectDir = "/Users/k/src/proj",
): CardSessionBinding {
  return {
    tugSessionId,
    projectDir,
    workspaceKey: `ws:${tugSessionId}`,
    sessionMode: "new",
  };
}

/** Resolvers driven by plain tables — no registry, no open registries. */
function resolvers(
  overrides: {
    groups?: Record<string, "sessions" | "files" | "tools" | "none">;
    paths?: Record<string, string>;
    unsaved?: Record<string, boolean>;
    labels?: Record<string, string>;
    callsignLines?: Record<string, string>;
  } = {},
): Partial<CardsResolvers> {
  const groups = overrides.groups ?? {};
  const paths = overrides.paths ?? {};
  return {
    group: (componentId) => groups[componentId] ?? "tools",
    textPath: (cardId) => paths[cardId] ?? null,
    textDisplayName: () => null,
    textUnsaved: (cardId) => overrides.unsaved?.[cardId] ?? false,
    viewPath: (cardId) => paths[cardId] ?? null,
    sessionLabel: (b) =>
      overrides.labels?.[b.tugSessionId] ?? `session ${b.tugSessionId}`,
    sessionCallsignLine: (b) =>
      overrides.callsignLines?.[b.tugSessionId] ?? `proj/${b.tugSessionId}`,
    defaultTitle: (componentId) => componentId,
    icon: () => null,
  };
}

const STANDARD_GROUPS = {
  session: "sessions" as const,
  text: "files" as const,
  "file-view": "files" as const,
  diff: "files" as const,
  settings: "tools" as const,
  "gallery-buttons": "tools" as const,
  lens: "none" as const,
};

function inputs(
  d: DeckState | null,
  over: Partial<LensCardsInputs> = {},
): LensCardsInputs {
  return {
    deck: d,
    cardsRowOrder: { sessions: [], files: [], tools: [] },
    groupOrder: [],
    collapsedGroups: [],
    filterQuery: "",
    registryVersion: 0,
    bindings: new Map(),
    tagVersion: 0,
    nameVersion: 0,
    changesets: null,
    ...over,
  };
}

/** Compact projection shape for readable assertions. */
function shape(rows: readonly CardsRow[]): string[] {
  return rows.map((row) => {
    if (row.type === "group-header") {
      return `header:${row.group}(${row.count})${row.collapsed ? "-collapsed" : ""}`;
    }
    if (row.type === "pane") return `pane:${row.rowKind}:${row.identity.title}`;
    return `  card:${row.identity.title}${row.active ? "*" : ""}`;
  });
}

// ---------------------------------------------------------------------------
// Path helpers (ported)
// ---------------------------------------------------------------------------

describe("path helpers", () => {
  it("basename takes the trailing segment", () => {
    expect(basename("/a/b/c.txt")).toBe("c.txt");
    expect(basename("c.txt")).toBe("c.txt");
  });

  it("dirname drops the trailing segment, empty at root", () => {
    expect(dirname("/a/b/c.txt")).toBe("/a/b");
    expect(dirname("/c.txt")).toBe("");
    expect(dirname("c.txt")).toBe("");
  });

  it("displayDir abbreviates a home prefix to ~", () => {
    expect(displayDir("/Users/kocienda/src")).toBe("~/src");
    expect(displayDir("/Users/kocienda")).toBe("~");
    expect(displayDir("/opt/src")).toBe("/opt/src");
  });

  it("displayDir abbreviates any user's home, not only the current one", () => {
    expect(displayDir("/Users/someone-else/src")).toBe("~/src");
  });

  it("displayDir leaves a bare /Users alone — there is no home to abbreviate", () => {
    expect(displayDir("/Users")).toBe("/Users");
  });

  it("displayPath abbreviates the whole path", () => {
    expect(displayPath("/Users/k/src/a.txt")).toBe("~/src/a.txt");
    expect(displayPath("a.txt")).toBe("a.txt");
  });
});

describe("assignDisambiguators", () => {
  it("returns null for a unique filename", () => {
    expect(
      assignDisambiguators([
        { title: "a.txt", path: "/x/a.txt" },
        { title: "b.txt", path: "/y/b.txt" },
      ]),
    ).toEqual([null, null]);
  });

  it("takes the shortest trailing run that separates a clash", () => {
    expect(
      assignDisambiguators([
        { title: "mod.rs", path: "/src/tugcast/mod.rs" },
        { title: "mod.rs", path: "/src/tugbank/mod.rs" },
      ]),
    ).toEqual(["tugcast", "tugbank"]);
  });

  it("walks further when the near directories also match", () => {
    expect(
      assignDisambiguators([
        { title: "mod.rs", path: "/tugcast/src/mod.rs" },
        { title: "mod.rs", path: "/tugbank/src/mod.rs" },
      ]),
    ).toEqual(["tugcast/src", "tugbank/src"]);
  });

  it("leaves a path-less entry undisambiguated", () => {
    expect(
      assignDisambiguators([
        { title: "Untitled", path: null },
        { title: "Untitled", path: null },
      ]),
    ).toEqual([null, null]);
  });
});

// ---------------------------------------------------------------------------
// The invariant: a single-card pane's row IS the card's row
// ---------------------------------------------------------------------------

describe("single-card panes", () => {
  it("emit exactly one row and no subrows", () => {
    const d = deck(
      [card("c1", "text")],
      [pane("p1", ["c1"])],
    );
    const rows = buildCardsRows(
      inputs(d, {}),
      resolvers({ groups: STANDARD_GROUPS, paths: { c1: "/x/a.txt" } }),
    );
    expect(shape(rows)).toEqual(["header:files(1)", "pane:file-pane:a.txt"]);
    expect(rows.filter((r) => r.type === "card")).toEqual([]);
  });

  it("carry the pane row kind of their group", () => {
    const d = deck(
      [card("s1", "session"), card("t1", "text"), card("g1", "settings")],
      [pane("p1", ["s1"]), pane("p2", ["t1"]), pane("p3", ["g1"])],
    );
    const rows = buildCardsRows(
      inputs(d, { bindings: new Map([["s1", binding("sess-1")]]) }),
      resolvers({ groups: STANDARD_GROUPS, paths: { t1: "/x/a.txt" } }),
    );
    const kinds = rows.filter((r) => r.type === "pane").map((r) => kindOfRow(r));
    expect(kinds).toEqual(["session-pane", "file-pane", "tool-pane"]);
  });

  it("a session pane's cardCount is 1, so no stack affordance can apply", () => {
    const d = deck([card("s1", "session")], [pane("p1", ["s1"])]);
    const rows = buildCardsRows(
      inputs(d, { bindings: new Map([["s1", binding("sess-1")]]) }),
      resolvers({ groups: STANDARD_GROUPS }),
    );
    const paneRow = rows.find((r) => r.type === "pane")!;
    expect(paneRow.type === "pane" && paneRow.cardCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The outline: always open, never foldable
// ---------------------------------------------------------------------------

describe("multi-card panes", () => {
  const galleryDeck = deck(
    [
      card("g1", "gallery-buttons", "Buttons"),
      card("g2", "gallery-buttons", "Input"),
      card("g3", "gallery-buttons", "Checkbox"),
      card("g4", "gallery-buttons", "Popover"),
    ],
    [pane("p1", ["g1", "g2", "g3", "g4"], "g2")],
  );

  it("emit a stack row plus one subrow per card in cardIds order", () => {
    const rows = buildCardsRows(
      inputs(galleryDeck),
      resolvers({ groups: STANDARD_GROUPS }),
    );
    expect(shape(rows)).toEqual([
      "header:tools(1)",
      "pane:stack-pane:Input",
      "  card:Buttons",
      "  card:Input*",
      "  card:Checkbox",
      "  card:Popover",
    ]);
  });

  it("the subrows are present with no state to set — there is no fold input", () => {
    // The projection takes collapsedGroups, a filter, and an order. None of
    // them is a per-pane fold, and no combination of them hides a subrow while
    // its pane row shows.
    const rows = buildCardsRows(
      inputs(galleryDeck, { cardsRowOrder: { sessions: [], files: [], tools: ["p1"] } }),
      resolvers({ groups: STANDARD_GROUPS }),
    );
    expect(rows.filter((r) => r.type === "card")).toHaveLength(4);
  });

  it("the pane row's identity is the ACTIVE card, not the first", () => {
    const rows = buildCardsRows(
      inputs(galleryDeck),
      resolvers({ groups: STANDARD_GROUPS }),
    );
    const paneRow = rows.find((r) => r.type === "pane")!;
    expect(paneRow.type === "pane" && paneRow.identity.cardId).toBe("g2");
  });

  it("mark exactly one subrow active", () => {
    const rows = buildCardsRows(
      inputs(galleryDeck),
      resolvers({ groups: STANDARD_GROUPS }),
    );
    const active = rows.filter((r) => r.type === "card" && r.active);
    expect(active).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Filing ([P04])
// ---------------------------------------------------------------------------

describe("a mixed-kind pane files under its active card's group", () => {
  const cards = [card("t1", "text"), card("g1", "settings", "Settings")];

  it("files under files when the text card is fronted", () => {
    const d = deck(cards, [pane("p1", ["t1", "g1"], "t1")]);
    const rows = buildCardsRows(
      inputs(d),
      resolvers({ groups: STANDARD_GROUPS, paths: { t1: "/x/a.txt" } }),
    );
    expect(rows[0]).toMatchObject({ type: "group-header", group: "files" });
  });

  it("moves to tools when the settings card is fronted", () => {
    const d = deck(cards, [pane("p1", ["t1", "g1"], "g1")]);
    const rows = buildCardsRows(
      inputs(d),
      resolvers({ groups: STANDARD_GROUPS, paths: { t1: "/x/a.txt" } }),
    );
    expect(rows[0]).toMatchObject({ type: "group-header", group: "tools" });
  });
});

// ---------------------------------------------------------------------------
// Groups and headers
// ---------------------------------------------------------------------------

describe("groups", () => {
  it("render in sessions, files, tools order", () => {
    const d = deck(
      [card("g1", "settings"), card("t1", "text"), card("s1", "session")],
      [pane("p1", ["g1"]), pane("p2", ["t1"]), pane("p3", ["s1"])],
    );
    const rows = buildCardsRows(
      inputs(d, { bindings: new Map([["s1", binding("sess-1")]]) }),
      resolvers({ groups: STANDARD_GROUPS, paths: { t1: "/x/a.txt" } }),
    );
    expect(
      rows.filter((r) => r.type === "group-header").map((r) => r.group),
    ).toEqual(["sessions", "files", "tools"]);
  });

  it("an empty group emits nothing at all — not an empty header", () => {
    const d = deck([card("t1", "text")], [pane("p1", ["t1"])]);
    const rows = buildCardsRows(
      inputs(d),
      resolvers({ groups: STANDARD_GROUPS, paths: { t1: "/x/a.txt" } }),
    );
    expect(rows.filter((r) => r.type === "group-header")).toHaveLength(1);
  });

  it("a collapsed group keeps its header and its count, and emits no rows", () => {
    const d = deck(
      [card("t1", "text"), card("t2", "text")],
      [pane("p1", ["t1"]), pane("p2", ["t2"])],
    );
    const rows = buildCardsRows(
      inputs(d, { collapsedGroups: ["files"] }),
      resolvers({
        groups: STANDARD_GROUPS,
        paths: { t1: "/x/a.txt", t2: "/x/b.txt" },
      }),
    );
    expect(shape(rows)).toEqual(["header:files(2)-collapsed"]);
  });

  it("render in the user's arranged group order", () => {
    const d = deck(
      [card("g1", "settings", "Settings"), card("t1", "text"), card("s1", "session")],
      [pane("p1", ["g1"]), pane("p2", ["t1"]), pane("p3", ["s1"])],
    );
    const rows = buildCardsRows(
      inputs(d, {
        groupOrder: ["tools", "files", "sessions"],
        bindings: new Map([["s1", binding("sess-1")]]),
      }),
      resolvers({ groups: STANDARD_GROUPS, paths: { t1: "/x/a.txt" } }),
    );
    expect(
      rows.filter((r) => r.type === "group-header").map((r) => r.group),
    ).toEqual(["tools", "files", "sessions"]);
  });

  it("an arranged group with no rows still yields its place to the next", () => {
    const d = deck(
      [card("g1", "settings", "Settings"), card("t1", "text")],
      [pane("p1", ["g1"]), pane("p2", ["t1"])],
    );
    const rows = buildCardsRows(
      inputs(d, { groupOrder: ["tools", "sessions", "files"] }),
      resolvers({ groups: STANDARD_GROUPS, paths: { t1: "/x/a.txt" } }),
    );
    expect(shape(rows)).toEqual([
      "header:tools(1)",
      "pane:tool-pane:Settings",
      "header:files(1)",
      "pane:file-pane:a.txt",
    ]);
  });

  it("collapsing one group leaves the others alone", () => {
    const d = deck(
      [card("t1", "text"), card("g1", "settings", "Settings")],
      [pane("p1", ["t1"]), pane("p2", ["g1"])],
    );
    const rows = buildCardsRows(
      inputs(d, { collapsedGroups: ["files"] }),
      resolvers({ groups: STANDARD_GROUPS, paths: { t1: "/x/a.txt" } }),
    );
    expect(shape(rows)).toEqual([
      "header:files(1)-collapsed",
      "header:tools(1)",
      "pane:tool-pane:Settings",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Ordering and order keys
// ---------------------------------------------------------------------------

describe("ordering", () => {
  const d = deck(
    [card("t1", "text"), card("t2", "text"), card("t3", "text")],
    [pane("p1", ["t1"]), pane("p2", ["t2"]), pane("p3", ["t3"])],
  );
  const r = resolvers({
    groups: STANDARD_GROUPS,
    paths: { t1: "/x/a.txt", t2: "/x/b.txt", t3: "/x/c.txt" },
  });

  it("no persisted order yields deck order", () => {
    const rows = buildCardsRows(inputs(d), r);
    expect(shape(rows).slice(1)).toEqual([
      "pane:file-pane:a.txt",
      "pane:file-pane:b.txt",
      "pane:file-pane:c.txt",
    ]);
  });

  it("ranked keys lead, in rank order", () => {
    const rows = buildCardsRows(
      inputs(d, { cardsRowOrder: { sessions: [], files: ["t3", "t1"], tools: [] } }),
      r,
    );
    expect(shape(rows).slice(1)).toEqual([
      "pane:file-pane:c.txt",
      "pane:file-pane:a.txt",
      "pane:file-pane:b.txt",
    ]);
  });

  it("unranked entries trail in deck order", () => {
    const rows = buildCardsRows(
      inputs(d, { cardsRowOrder: { sessions: [], files: ["t3"], tools: [] } }),
      r,
    );
    expect(shape(rows).slice(1)).toEqual([
      "pane:file-pane:c.txt",
      "pane:file-pane:a.txt",
      "pane:file-pane:b.txt",
    ]);
  });

  it("unranked order follows the CARD table, not the pane stacking order", () => {
    // `deck.panes` is z-order — fronting a card rewrites it. A list keyed off
    // it would reshuffle every time the user clicked between cards, so the
    // projection ties unranked entries by the identity card's index in
    // `deck.cards`, which is insertion order and does not move.
    const restacked = deck(
      [card("t1", "text"), card("t2", "text"), card("t3", "text")],
      // Same three panes as `d`, raised into a different stacking order.
      [pane("p3", ["t3"]), pane("p1", ["t1"]), pane("p2", ["t2"])],
    );
    const rows = buildCardsRows(inputs(restacked), r);
    expect(shape(rows).slice(1)).toEqual([
      "pane:file-pane:a.txt",
      "pane:file-pane:b.txt",
      "pane:file-pane:c.txt",
    ]);
  });

  it("stale keys are ignored", () => {
    const rows = buildCardsRows(
      inputs(d, {
        cardsRowOrder: { sessions: [], files: ["gone", "t2"], tools: [] },
      }),
      r,
    );
    expect(shape(rows).slice(1)[0]).toBe("pane:file-pane:b.txt");
  });

  it("one group's order does not reach another", () => {
    const mixed = deck(
      [card("t1", "text"), card("g1", "settings", "Settings")],
      [pane("p1", ["t1"]), pane("p2", ["g1"])],
    );
    const rows = buildCardsRows(
      inputs(mixed, {
        cardsRowOrder: { sessions: [], files: ["g1"], tools: ["t1"] },
      }),
      resolvers({ groups: STANDARD_GROUPS, paths: { t1: "/x/a.txt" } }),
    );
    expect(shape(rows)).toEqual([
      "header:files(1)",
      "pane:file-pane:a.txt",
      "header:tools(1)",
      "pane:tool-pane:Settings",
    ]);
  });
});

describe("order keys", () => {
  it("a single-card session pane keys by session, not by card", () => {
    const d = deck([card("s1", "session")], [pane("p1", ["s1"])]);
    const rows = buildCardsRows(
      inputs(d, { bindings: new Map([["s1", binding("sess-1")]]) }),
      resolvers({ groups: STANDARD_GROUPS }),
    );
    const paneRow = rows.find((r) => r.type === "pane")!;
    expect(paneRow.type === "pane" && paneRow.orderKey).toBe("sess-1");
  });

  it("an unbound session card falls back to its card id", () => {
    const d = deck([card("s1", "session")], [pane("p1", ["s1"])]);
    const rows = buildCardsRows(inputs(d), resolvers({ groups: STANDARD_GROUPS }));
    const paneRow = rows.find((r) => r.type === "pane")!;
    expect(paneRow.type === "pane" && paneRow.orderKey).toBe("s1");
  });

  it("any other single-card pane keys by card id", () => {
    const d = deck([card("t1", "text")], [pane("p1", ["t1"])]);
    const rows = buildCardsRows(
      inputs(d),
      resolvers({ groups: STANDARD_GROUPS, paths: { t1: "/x/a.txt" } }),
    );
    const paneRow = rows.find((r) => r.type === "pane")!;
    expect(paneRow.type === "pane" && paneRow.orderKey).toBe("t1");
  });

  it("a multi-card pane keys by pane id — the only stable identity a stack has", () => {
    const d = deck(
      [card("s1", "session"), card("s2", "session")],
      [pane("p1", ["s1", "s2"])],
    );
    const rows = buildCardsRows(
      inputs(d, {
        bindings: new Map([
          ["s1", binding("sess-1")],
          ["s2", binding("sess-2")],
        ]),
      }),
      resolvers({ groups: STANDARD_GROUPS }),
    );
    const paneRow = rows.find((r) => r.type === "pane")!;
    expect(paneRow.type === "pane" && paneRow.orderKey).toBe("p1");
  });
});

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

describe("filtering", () => {
  it("narrows pane rows and drops emptied groups' headers", () => {
    const d = deck(
      [card("t1", "text"), card("g1", "settings", "Settings")],
      [pane("p1", ["t1"]), pane("p2", ["g1"])],
    );
    const rows = buildCardsRows(
      inputs(d, { filterQuery: "alpha" }),
      resolvers({ groups: STANDARD_GROUPS, paths: { t1: "/x/alpha.txt" } }),
    );
    expect(shape(rows)).toEqual(["header:files(1)", "pane:file-pane:alpha.txt"]);
  });

  it("a header's count reflects the survivors, not the total", () => {
    const d = deck(
      [card("t1", "text"), card("t2", "text")],
      [pane("p1", ["t1"]), pane("p2", ["t2"])],
    );
    const rows = buildCardsRows(
      inputs(d, { filterQuery: "alpha" }),
      resolvers({
        groups: STANDARD_GROUPS,
        paths: { t1: "/x/alpha.txt", t2: "/x/beta.txt" },
      }),
    );
    expect(rows[0]).toMatchObject({ type: "group-header", count: 1 });
  });

  it("matches on the directory as DISPLAYED", () => {
    const d = deck([card("t1", "text")], [pane("p1", ["t1"])]);
    const rows = buildCardsRows(
      inputs(d, { filterQuery: "~/src" }),
      resolvers({
        groups: STANDARD_GROUPS,
        paths: { t1: "/Users/k/src/a.txt" },
      }),
    );
    expect(rows).toHaveLength(2);
  });

  it("a stack survives on a buried tab, showing only the matching children", () => {
    const d = deck(
      [
        card("g1", "gallery-buttons", "Buttons"),
        card("g2", "gallery-buttons", "Checkbox"),
        card("g3", "gallery-buttons", "Popover"),
      ],
      [pane("p1", ["g1", "g2", "g3"], "g1")],
    );
    const rows = buildCardsRows(
      inputs(d, { filterQuery: "checkbox" }),
      resolvers({ groups: STANDARD_GROUPS }),
    );
    expect(shape(rows)).toEqual([
      "header:tools(1)",
      "pane:stack-pane:Buttons",
      "  card:Checkbox",
    ]);
  });

  it("a stack matching on its OWN text keeps all its children", () => {
    const d = deck(
      [
        card("g1", "gallery-buttons", "Buttons"),
        card("g2", "gallery-buttons", "Checkbox"),
      ],
      [pane("p1", ["g1", "g2"], "g1")],
    );
    const rows = buildCardsRows(
      inputs(d, { filterQuery: "buttons" }),
      resolvers({ groups: STANDARD_GROUPS }),
    );
    expect(shape(rows)).toEqual([
      "header:tools(1)",
      "pane:stack-pane:Buttons",
      "  card:Buttons*",
      "  card:Checkbox",
    ]);
  });

  it("a session pane matches on its resolved label, not on its card id", () => {
    const d = deck(
      [card("s1", "session"), card("s2", "session")],
      [pane("p1", ["s1"]), pane("p2", ["s2"])],
    );
    const bindings = new Map([
      ["s1", binding("sess-1")],
      ["s2", binding("sess-2")],
    ]);
    const r = resolvers({
      groups: STANDARD_GROUPS,
      labels: { "sess-1": "proj/refactor", "sess-2": "proj/docs" },
    });
    expect(
      shape(buildCardsRows(inputs(d, { bindings, filterQuery: "refactor" }), r)),
    ).toEqual(["header:sessions(1)", "pane:session-pane:proj/refactor"]);
  });

  it("a named session is found by its name AND by the callsign it stopped showing", () => {
    // The row shows the user's own name and no callsign ([D141]). Both still
    // have to find it: the name because it is what they chose and what they
    // will type, the callsign because it is the permanent handle and hiding it
    // must not make it unfindable — that is the promise the whole rule rests
    // on.
    const d = deck(
      [card("s1", "session"), card("s2", "session")],
      [pane("p1", ["s1"]), pane("p2", ["s2"])],
    );
    const bindings = new Map([
      ["s1", binding("sess-1")],
      ["s2", binding("sess-2")],
    ]);
    const r = resolvers({
      groups: STANDARD_GROUPS,
      labels: { "sess-1": "parser rewrite", "sess-2": "proj/stocky-pixie" },
      callsignLines: {
        "sess-1": "proj/frothy-nurse",
        "sess-2": "proj/stocky-pixie",
      },
    });
    expect(
      shape(buildCardsRows(inputs(d, { bindings, filterQuery: "parser" }), r)),
    ).toEqual(["header:sessions(1)", "pane:session-pane:parser rewrite"]);
    // The callsign is not on the row and still matches — and the row it
    // returns is titled with the name, never with what the query typed.
    expect(
      shape(buildCardsRows(inputs(d, { bindings, filterQuery: "frothy" }), r)),
    ).toEqual(["header:sessions(1)", "pane:session-pane:parser rewrite"]);
  });

  it("a rename re-runs the projection", () => {
    // `nameVersion` is the store's "it changed" token, and since the name IS
    // the row's title ([D141]) the stale projection would show the callsign of
    // a session the user has already named — not just miss a match.
    const d = deck([card("s1", "session")], [pane("p1", ["s1"])]);
    const bindings = new Map([["s1", binding("sess-1")]]);
    let title = "proj/frothy-nurse";
    const r: Partial<CardsResolvers> = {
      ...resolvers({ groups: STANDARD_GROUPS }),
      sessionLabel: () => title,
      sessionCallsignLine: () => "proj/frothy-nurse",
    };
    const source = new LensCardsDataSource(
      inputs(d, { bindings, filterQuery: "parser" }),
      r,
    );
    expect(source.numberOfItems()).toBe(0);
    title = "parser rewrite";
    expect(
      source.setInputsWithoutNotify(
        inputs(d, { bindings, filterQuery: "parser", nameVersion: 1 }),
      ),
    ).toBe(true);
    expect(
      shape(
        Array.from({ length: source.numberOfItems() }, (_, i) =>
          source.rowAt(i),
        ),
      ),
    ).toEqual(["header:sessions(1)", "pane:session-pane:parser rewrite"]);
  });

  it("clearing the query restores the persisted order", () => {
    const d = deck(
      [card("t1", "text"), card("t2", "text")],
      [pane("p1", ["t1"]), pane("p2", ["t2"])],
    );
    const r = resolvers({
      groups: STANDARD_GROUPS,
      paths: { t1: "/x/alpha.txt", t2: "/x/beta.txt" },
    });
    const order = { sessions: [], files: ["t2", "t1"], tools: [] };
    const filtered = buildCardsRows(
      inputs(d, { cardsRowOrder: order, filterQuery: "a" }),
      r,
    );
    expect(filtered.length).toBeGreaterThan(1);
    const cleared = buildCardsRows(inputs(d, { cardsRowOrder: order }), r);
    expect(shape(cleared).slice(1)).toEqual([
      "pane:file-pane:beta.txt",
      "pane:file-pane:alpha.txt",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Exclusions and edge cases
// ---------------------------------------------------------------------------

describe("exclusions", () => {
  it("the Lens pane is not in its own mirror", () => {
    const d = deck(
      [card("lens-card", "lens"), card("t1", "text")],
      [pane("pl", ["lens-card"]), pane("p1", ["t1"])],
    );
    const rows = buildCardsRows(
      inputs(d),
      resolvers({ groups: STANDARD_GROUPS, paths: { t1: "/x/a.txt" } }),
    );
    expect(shape(rows)).toEqual(["header:files(1)", "pane:file-pane:a.txt"]);
  });

  it("a pane whose active card resolves to none is skipped", () => {
    const d = deck([card("x1", "mystery")], [pane("p1", ["x1"])]);
    const rows = buildCardsRows(
      inputs(d),
      resolvers({ groups: { mystery: "none" } }),
    );
    expect(rows).toEqual([]);
  });

  it("a null deck projects nothing", () => {
    expect(buildCardsRows(inputs(null), resolvers())).toEqual([]);
  });

  it("two panes bound to ONE session render two rows — the canvas has two panes", () => {
    const d = deck(
      [card("s1", "session"), card("s2", "session")],
      [pane("p1", ["s1"]), pane("p2", ["s2"])],
    );
    const rows = buildCardsRows(
      inputs(d, {
        bindings: new Map([
          ["s1", binding("sess-1")],
          ["s2", binding("sess-1")],
        ]),
      }),
      resolvers({ groups: STANDARD_GROUPS }),
    );
    expect(rows.filter((r) => r.type === "pane")).toHaveLength(2);
  });

  it("a pane whose active card is missing from the card table is skipped", () => {
    const d = deck([card("t1", "text")], [pane("p1", ["ghost"], "ghost")]);
    expect(buildCardsRows(inputs(d), resolvers({ groups: STANDARD_GROUPS }))).toEqual([]);
  });
});

describe("row ids", () => {
  it("are stable and non-colliding across the three row types", () => {
    const d = deck(
      [card("g1", "gallery-buttons", "Buttons"), card("g2", "gallery-buttons", "Input")],
      [pane("p1", ["g1", "g2"], "g1")],
    );
    const rows = buildCardsRows(inputs(d), resolvers({ groups: STANDARD_GROUPS }));
    const ids = rows.map(idOfRow);
    expect(ids).toEqual(["header:tools", "pane:p1", "card:g1", "card:g2"]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// The data source wrapper
// ---------------------------------------------------------------------------

describe("LensCardsDataSource", () => {
  const d = deck(
    [card("t1", "text"), card("g1", "settings", "Settings")],
    [pane("p1", ["t1"]), pane("p2", ["g1"])],
  );

  const r = resolvers({ groups: STANDARD_GROUPS, paths: { t1: "/x/a.txt" } });

  function source(over: Partial<LensCardsInputs> = {}): LensCardsDataSource {
    return new LensCardsDataSource(inputs(d, over), r);
  }

  it("every row is a cell, headers included", () => {
    const ds = source();
    for (let i = 0; i < ds.numberOfItems(); i += 1) {
      expect(ds.roleForIndex(i)).toBe("cell");
    }
  });

  it("firstPaneRowIndex skips the leading header", () => {
    const ds = source();
    expect(ds.firstPaneRowIndex()).toBeGreaterThan(0);
    expect(ds.rowAt(ds.firstPaneRowIndex()).type).toBe("pane");
  });

  it("firstPaneRowIndex is -1 when nothing projects", () => {
    expect(new LensCardsDataSource(inputs(null), r).firstPaneRowIndex()).toBe(-1);
  });

  it("visibleOrder omits a collapsed group's keys, matching what is mounted", () => {
    const all = source().visibleOrder();
    expect(all.length).toBeGreaterThan(0);
    const groups = source().groupByOrderKey();
    const collapsedGroup = groups.get(all[0])!;
    const narrowed = source({ collapsedGroups: [collapsedGroup] }).visibleOrder();
    expect(narrowed).not.toContain(all[0]);
  });

  it("visibleOrder never contains a header or subcard id", () => {
    const ds = source();
    for (const key of ds.visibleOrder()) {
      expect(key.startsWith("header:")).toBe(false);
      expect(key.startsWith("card:")).toBe(false);
    }
  });

  it("the census counts pane rows through a filter and a collapse", () => {
    const plain = source().censusByGroup();
    const narrowed = source({
      filterQuery: "zzz-no-match",
      collapsedGroups: ["files", "tools", "sessions"],
    }).censusByGroup();
    expect(narrowed).toEqual(plain);
  });

  it("unfilteredCount holds while a filter narrows the visible rows", () => {
    const ds = source({ filterQuery: "zzz-no-match" });
    expect(ds.numberOfItems()).toBe(0);
    expect(ds.unfilteredCount()).toBe(source().unfilteredCount());
  });

  it("isFiltering ignores a whitespace-only query", () => {
    expect(source({ filterQuery: "   " }).isFiltering()).toBe(false);
    expect(source({ filterQuery: "a" }).isFiltering()).toBe(true);
  });

  it("identical inputs do not recompute", () => {
    const ds = source();
    const before = ds.getVersion();
    const same = inputs(d);
    ds.setInputsWithoutNotify(same);
    expect(ds.setInputsWithoutNotify(same)).toBe(false);
    expect(ds.getVersion()).not.toBe(before);
  });

  it("indexForId finds a row and returns -1 for an absent one", () => {
    const ds = source();
    expect(ds.indexForId(ds.idForIndex(0))).toBe(0);
    expect(ds.indexForId("pane:nope")).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// The collapsed-group summary
// ---------------------------------------------------------------------------

describe("summarizeGroup", () => {
  /** Only the two fields the summary reads; the rest of a `CardIdentity` has
   *  no bearing on what a folded group says about itself. */
  function file(path: string | null): CardIdentity {
    return { path } as CardIdentity;
  }

  it("a non-file group says how many, and nothing else", () => {
    expect(summarizeGroup("sessions", [file(null), file(null)])).toBe("2");
    expect(summarizeGroup("tools", [file(null)])).toBe("1");
    expect(summarizeGroup("tools", [])).toBe("0");
  });

  it("a files group names the kind in words", () => {
    expect(summarizeGroup("files", [file("/x/a.md")])).toBe("1 Markdown");
  });

  it("kinds lead by count, ties alphabetically", () => {
    const summary = summarizeGroup("files", [
      file("/x/a.ts"),
      file("/x/b.md"),
      file("/x/c.md"),
      file("/x/d.css"),
    ]);
    expect(summary).toBe("2 Markdown · 1 CSS · 1 TypeScript");
  });

  it("one name covers a whole family, however it is spelled", () => {
    // Every image format is one bucket, `.ts` and `.tsx` are one language, and
    // the extension's case never reaches the reader.
    expect(
      summarizeGroup("files", [
        file("/x/a.png"),
        file("/x/b.JPG"),
        file("/x/c.heic"),
      ]),
    ).toBe("3 Images");
    expect(summarizeGroup("files", [file("/x/a.ts"), file("/x/b.tsx")])).toBe(
      "2 TypeScript",
    );
  });

  it("anything without an extension is text", () => {
    // A dotfile's leading dot names the file, an unsaved buffer has no path at
    // all, and `Makefile` simply has no extension — all three are text, which
    // is both the card they open into and what they honestly are.
    expect(
      summarizeGroup("files", [
        file("/x/Makefile"),
        file("/x/.env"),
        file(null),
      ]),
    ).toBe("3 Text");
  });

  it("an extension nobody has named keeps itself", () => {
    expect(summarizeGroup("files", [file("/x/a.parquet")])).toBe("1 PARQUET");
  });

  it("past the limit the remainder counts FILES, not kinds", () => {
    const summary = summarizeGroup("files", [
      file("/x/a.md"),
      file("/x/b.md"),
      file("/x/c.ts"),
      file("/x/d.css"),
      file("/x/e.png"),
      file("/x/f.png"),
      file("/x/g.rs"),
    ]);
    expect(summary).toBe("2 Images · 2 Markdown · 1 CSS · +2 more");
  });
});

// ---------------------------------------------------------------------------
// A session's dash — a row-internal line, so the row MODEL never sees it
// ---------------------------------------------------------------------------

describe("a session's dash", () => {
  const SESSION_GROUPS = { session: "sessions" as const, lens: "none" as const };

  /** A snapshot whose one dash binds `sessions`. */
  function snapshotWith(
    sessions: string[],
    extra: Partial<{
      name: string;
      ownerId: string;
      stage: string;
      review: string;
      stepCurrent: number;
      stepTotal: number;
    }> = {},
  ): WorkspacesChangesetSnapshot {
    return {
      projects: [
        {
          workspace_key: "ws",
          project_dir: "/Users/k/src/proj",
          display_name: "proj",
          no_repo: false,
          branch: "main",
          ahead: 0,
          behind: 0,
          head_sha: "abc",
          head_message: "head",
          unattributed: [],
          changesets: [
            {
              kind: "dash",
              owner_id: extra.ownerId ?? "tugdash/fix#1",
              display_name: extra.name ?? "fix",
              stage: extra.stage ?? "working",
              review: extra.review,
              step_current: extra.stepCurrent,
              step_total: extra.stepTotal,
              bound_sessions: sessions,
              base: "main",
              rounds: 0,
              worktree: "/tmp/wt",
              worktree_dirty: false,
              files: [],
            },
          ],
        },
      ],
    };
  }

  const oneSession = deck(
    [card("s1", "session")],
    [pane("p1", ["s1"])],
  );

  it("a bound session is ONE row — the dash adds none", () => {
    // The dash is a line inside the session's row, drawn from the row's own
    // leaf subscription. Nothing about it reaches the row model, which is what
    // makes the row count independent of what any dash is doing.
    const rows = buildCardsRows(
      inputs(oneSession, {
        bindings: new Map([["s1", binding("sess-1")]]),
        changesets: snapshotWith(["sess-1"]),
      }),
      resolvers({ groups: SESSION_GROUPS }),
    );
    expect(shape(rows)).toEqual([
      "header:sessions(1)",
      "pane:session-pane:session sess-1",
    ]);
  });

  it("binding a dash changes no row id and no row kind", () => {
    // The same deck, projected with and without a dash claiming the session.
    // Anything that differed here would be the row model carrying the binding,
    // which it must not: a bind would then reflow the list.
    const project = (changesets: ReturnType<typeof snapshotWith> | null) =>
      buildCardsRows(
        inputs(oneSession, {
          bindings: new Map([["s1", binding("sess-1")]]),
          changesets,
        }),
        resolvers({ groups: SESSION_GROUPS }),
      );
    const bound = project(snapshotWith(["sess-1"]));
    const unbound = project(snapshotWith(["someone-else"]));
    expect(bound.map(idOfRow)).toEqual(unbound.map(idOfRow));
    expect(bound.map(kindOfRow)).toEqual(unbound.map(kindOfRow));
  });

  it("filtering by the dash name keeps the session", () => {
    // The session's own text says nothing about the dash, so this passes only
    // because the dash name joined the pane row's match fields.
    const rows = buildCardsRows(
      inputs(oneSession, {
        bindings: new Map([["s1", binding("sess-1")]]),
        changesets: snapshotWith(["sess-1"], { name: "marmalade" }),
        filterQuery: "marmal",
      }),
      resolvers({ groups: SESSION_GROUPS }),
    );
    expect(shape(rows)).toEqual([
      "header:sessions(1)",
      "pane:session-pane:session sess-1",
    ]);
  });

  it("a dash name matches nothing once the session is filtered out", () => {
    const rows = buildCardsRows(
      inputs(oneSession, {
        bindings: new Map([["s1", binding("sess-1")]]),
        changesets: snapshotWith(["sess-1"]),
        filterQuery: "nothing-matches-this",
      }),
      resolvers({ groups: SESSION_GROUPS }),
    );
    expect(rows).toEqual([]);
  });

  it("the reorder's visible order is the pane rows, and only those", () => {
    const source = new LensCardsDataSource(
      inputs(oneSession, {
        bindings: new Map([["s1", binding("sess-1")]]),
        changesets: snapshotWith(["sess-1"]),
      }),
      resolvers({ groups: SESSION_GROUPS }),
    );
    expect(source.visibleOrder()).toEqual(["sess-1"]);
  });
});
