import { describe, expect, test } from "bun:test";
import { namesEntry, reloadScopeOf, type GraphNode, type PageEntry } from "../scoped-reload";

interface FixtureNode extends GraphNode {
  readonly id: string;
  readonly file: string;
  isSelfAccepting?: boolean;
  acceptedHmrDeps: Set<FixtureNode>;
  acceptedHmrExports: Set<string> | null;
  importedBindings: Map<string, Set<string>> | null;
  importers: Set<FixtureNode>;
}

/** A graph built from `importer → imported` edges; every node analyzed, none accepting unless said. */
function graph(edges: readonly [string, string][], accepting: readonly string[] = []): Map<string, FixtureNode> {
  const nodes = new Map<string, FixtureNode>();
  const node = (name: string): FixtureNode => {
    let found = nodes.get(name);
    if (!found) {
      found = {
        id: name,
        file: name,
        isSelfAccepting: accepting.includes(name),
        acceptedHmrDeps: new Set(),
        acceptedHmrExports: null,
        importedBindings: null,
        importers: new Set(),
      };
      nodes.set(name, found);
    }
    return found;
  };
  for (const [importer, imported] of edges) node(imported).importers.add(node(importer));
  return nodes;
}

const ENTRIES: Record<string, PageEntry> = {
  "main.tsx": "shell",
  "body-main.ts": "body",
  "overlay-main.ts": "overlay",
  "spike-page.ts": "spike",
};
const entryOf = (node: FixtureNode): PageEntry | null => ENTRIES[node.file] ?? null;

// The deck's shape: one root picking a page entry, the entries importing a
// shared library, a component boundary in the bodies.
const DECK: [string, string][] = [
  ["entry.ts", "main.tsx"],
  ["entry.ts", "body-main.ts"],
  ["entry.ts", "overlay-main.ts"],
  ["entry.ts", "spike-page.ts"],
  ["main.tsx", "layout-imposer.ts"],
  ["layout-imposer.ts", "geometry.ts"],
  ["body-main.ts", "transcript.tsx"],
  ["transcript.tsx", "geometry.ts"],
  ["transcript.tsx", "transcript-model.ts"],
  ["body-main.ts", "transcript-model.ts"],
  ["overlay-main.ts", "geometry.ts"],
];

describe("reloadScopeOf", () => {
  test("a module only the shell imports reloads the shell alone", () => {
    const nodes = graph(DECK, ["transcript.tsx"]);
    expect(reloadScopeOf([nodes.get("layout-imposer.ts")!], entryOf)).toEqual({
      kind: "reload",
      entries: ["shell"],
      boundaries: [],
    });
  });

  test("a module every page imports names each entry its paths reach, and keeps the boundary another path met", () => {
    const nodes = graph(DECK, ["transcript.tsx"]);
    const scope = reloadScopeOf([nodes.get("geometry.ts")!], entryOf);
    expect(scope.kind).toBe("reload");
    if (scope.kind !== "reload") return;
    expect(scope.entries).toEqual(["overlay", "shell"]);
    expect(scope.boundaries.map(({ boundary }) => boundary.file)).toEqual(["transcript.tsx"]);
  });

  test("a path past a boundary still reaches the entry beside it, and a boundary only reloading pages hold is not updated", () => {
    const nodes = graph(DECK, ["transcript.tsx"]);
    const scope = reloadScopeOf([nodes.get("transcript-model.ts")!], entryOf);
    expect(scope.kind).toBe("reload");
    if (scope.kind !== "reload") return;
    expect(scope.entries).toEqual(["body"]);
    expect(scope.boundaries).toEqual([]);
  });

  test("an edit every path accepts is Vite's own update", () => {
    const nodes = graph(DECK, ["transcript.tsx"]);
    expect(reloadScopeOf([nodes.get("transcript.tsx")!], entryOf)).toEqual({ kind: "update" });
  });

  test("an importer that accepts the dep stops the path", () => {
    const nodes = graph(DECK);
    const imposer = nodes.get("layout-imposer.ts")!;
    nodes.get("main.tsx")!.acceptedHmrDeps.add(imposer);
    expect(reloadScopeOf([imposer], entryOf)).toEqual({ kind: "update" });
  });

  test("an edit to a page entry reloads that page", () => {
    const nodes = graph(DECK);
    expect(reloadScopeOf([nodes.get("overlay-main.ts")!], entryOf)).toEqual({
      kind: "reload",
      entries: ["overlay"],
      boundaries: [],
    });
  });

  test("the shared root itself, or a root outside the pages, is left to Vite's full reload", () => {
    const nodes = graph([...DECK, ["stray-root.ts", "geometry.ts"]]);
    expect(reloadScopeOf([nodes.get("entry.ts")!], entryOf)).toEqual({ kind: "unscoped" });
    expect(reloadScopeOf([nodes.get("geometry.ts")!], entryOf)).toEqual({ kind: "unscoped" });
  });

  test("a module no page has run yet stops the path, as Vite's walk does", () => {
    const nodes = graph(DECK);
    nodes.get("layout-imposer.ts")!.isSelfAccepting = undefined;
    expect(reloadScopeOf([nodes.get("geometry.ts")!], entryOf)).toEqual({
      kind: "reload",
      entries: ["body", "overlay"],
      boundaries: [],
    });
  });

  test("an import cycle under an entry ends at the entry", () => {
    const nodes = graph([...DECK, ["geometry.ts", "layout-imposer.ts"]]);
    const scope = reloadScopeOf([nodes.get("layout-imposer.ts")!], entryOf);
    expect(scope.kind).toBe("reload");
    if (scope.kind !== "reload") return;
    expect(scope.entries).toEqual(["body", "overlay", "shell"]);
  });
});

describe("namesEntry", () => {
  test("reads the entries a tug:reload carries", () => {
    expect(namesEntry({ entries: ["shell", "body"] }, "body")).toBe(true);
    expect(namesEntry({ entries: ["shell"] }, "body")).toBe(false);
    expect(namesEntry(null, "shell")).toBe(false);
    expect(namesEntry({}, "shell")).toBe(false);
  });
});
