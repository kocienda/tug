import { afterEach, describe, expect, test } from "bun:test";

import {
  chartRecipesFor,
  narrowCatalog,
  narrowOutcome,
  recipeFace,
  recipeSections,
  refreshRecipes,
  type RecipeOutcome,
} from "../chart-recipes-store";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** A list row with every field a row needs. */
function recipe(name: string, question = "q") {
  return { name, question, tells: "t", group: "g", form: "bar", sample: { form: "bar" } };
}

describe("chart recipes — narrowing", () => {
  test("the list's rows are read as they came, and a malformed row is dropped", () => {
    expect(
      narrowCatalog({
        status: "ok",
        recipes: [
          { ...recipe("commits", "How often?"), data: "git log", args: [] },
          recipe(""),
          { ...recipe("churn"), question: 3 },
          { ...recipe("hotspots"), tells: undefined },
          { ...recipe("landed"), group: undefined },
          { ...recipe("suite-times"), sample: null },
          recipe("gaps", "What ran dark?"),
        ],
      }),
    ).toEqual([recipe("commits", "How often?"), recipe("gaps", "What ran dark?")]);
  });

  test("a body with no list narrows to none", () => {
    expect(narrowCatalog({ status: "ok" })).toEqual([]);
    expect(narrowCatalog("nope")).toEqual([]);
  });

  test("an outcome with a spec is a chart", () => {
    const spec = { tugchart: 1, form: "bar" };
    expect(narrowOutcome({ status: "ok", recipe: "commits", summary: "3 commits", spec })).toEqual({
      kind: "chart",
      summary: "3 commits",
      spec,
    });
  });

  test("an outcome with a null spec is no data, with its summary", () => {
    expect(narrowOutcome({ status: "ok", recipe: "gaps", summary: "no gaps", spec: null })).toEqual({
      kind: "noData",
      summary: "no gaps",
    });
  });

  test("an error body is failed, with its message", () => {
    expect(narrowOutcome({ status: "error", message: "no such range" })).toEqual({
      kind: "failed",
      message: "no such range",
    });
  });

  test("a body that says neither is failed", () => {
    expect(narrowOutcome({ status: "ok" }).kind).toBe("failed");
    expect(narrowOutcome({ status: "ok", summary: "s" }).kind).toBe("failed");
    expect(narrowOutcome(null).kind).toBe("failed");
  });
});

describe("chart recipes — what a row shows", () => {
  const row = (outcome: RecipeOutcome) => ({ ...recipe("commits"), outcome });

  test("a chart draws live, with no line beside it", () => {
    const spec = { form: "line" };
    expect(recipeFace(row({ kind: "chart", summary: "3 commits", spec }))).toEqual({
      state: "live",
      spec,
      sampled: false,
      line: null,
    });
  });

  test("no data draws the sample beside the recipe's summary", () => {
    expect(recipeFace(row({ kind: "noData", summary: "no commits" }))).toEqual({
      state: "no-data",
      spec: { form: "bar" },
      sampled: true,
      line: "no commits",
    });
  });

  test("a failed read draws the sample beside the failure", () => {
    expect(recipeFace(row({ kind: "failed", message: "ledger" }))).toEqual({
      state: "failed",
      spec: { form: "bar" },
      sampled: true,
      line: "Could not read: ledger",
    });
  });

  test("a read still running draws nothing yet", () => {
    expect(recipeFace(row({ kind: "pending" }))).toEqual({
      state: "pending",
      spec: null,
      sampled: false,
      line: null,
    });
  });

  test("sections read in the order the catalog first names them, keeping row order", () => {
    const rows = [
      { ...row({ kind: "pending" }), name: "a", group: "Second" },
      { ...row({ kind: "pending" }), name: "b", group: "First" },
      { ...row({ kind: "pending" }), name: "c", group: "Second" },
    ];
    expect(recipeSections(rows).map(({ group, rows: members }) => [group, members.map((m) => m.name)])).toEqual([
      ["Second", ["a", "c"]],
      ["First", ["b"]],
    ]);
  });
});

describe("chart recipes — reading", () => {
  test("every recipe reaches an answer, and a read that fails becomes failed", async () => {
    globalThis.fetch = (async (input: string) => {
      const url = String(input);
      if (url === "/api/chart/list") {
        return answer({
          status: "ok",
          recipes: [
            recipe("commits"),
            recipe("gaps"),
            recipe("landed"),
          ],
        });
      }
      if (url.startsWith("/api/chart/commits")) {
        return answer({ status: "ok", recipe: "commits", summary: "s", spec: { form: "bar" } });
      }
      if (url.startsWith("/api/chart/gaps")) {
        return answer({ status: "error", message: "ledger" }, 500);
      }
      throw new Error("timed out");
    }) as typeof fetch;

    await refreshRecipes("/project/a");

    const { rows, listFailure } = chartRecipesFor("/project/a");
    expect(listFailure).toBeNull();
    expect(rows?.map((row) => [row.name, row.outcome])).toEqual([
      ["commits", { kind: "chart", summary: "s", spec: { form: "bar" } }],
      ["gaps", { kind: "failed", message: "ledger" }],
      ["landed", { kind: "failed", message: "timed out" }],
    ]);
  });

  test("the project is named in each recipe's read", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: string) => {
      const url = String(input);
      urls.push(url);
      if (url === "/api/chart/list") {
        return answer({ status: "ok", recipes: [recipe("commits")] });
      }
      return answer({ status: "ok", summary: "s", spec: null });
    }) as typeof fetch;

    await refreshRecipes("/a dir/b");

    expect(urls).toEqual(["/api/chart/list", "/api/chart/commits?project=%2Fa%20dir%2Fb"]);
  });

  test("a list that cannot be read says so", async () => {
    globalThis.fetch = (async () => {
      throw new Error("no route");
    }) as unknown as typeof fetch;

    await refreshRecipes("/project/b");

    expect(chartRecipesFor("/project/b")).toEqual({ rows: null, listFailure: "no route" });
  });

  test("a re-read keeps what it holds until each answer lands, and follows the list", async () => {
    const chart: RecipeOutcome = { kind: "chart", summary: "old", spec: { form: "bar" } };
    globalThis.fetch = (async (input: string) => {
      if (String(input) === "/api/chart/list") {
        return answer({ status: "ok", recipes: [recipe("commits"), recipe("gaps")] });
      }
      return answer({ status: "ok", summary: "old", spec: { form: "bar" } });
    }) as typeof fetch;
    await refreshRecipes("/project/c");

    let land: (response: Response) => void = () => {};
    const landed = new Promise<Response>((resolve) => {
      land = resolve;
    });
    let read = () => {};
    const reading = new Promise<void>((resolve) => {
      read = resolve;
    });
    globalThis.fetch = (async (input: string) => {
      if (String(input) === "/api/chart/list") {
        return answer({ status: "ok", recipes: [recipe("commits"), recipe("landed")] });
      }
      read();
      return landed;
    }) as typeof fetch;
    const refresh = refreshRecipes("/project/c");
    await reading;

    expect(chartRecipesFor("/project/c").rows?.map((row) => [row.name, row.outcome])).toEqual([
      ["commits", chart],
      ["landed", { kind: "pending" }],
    ]);

    land(answer({ status: "ok", summary: "new", spec: null }));
    await refresh;

    expect(chartRecipesFor("/project/c").rows?.[0]?.outcome).toEqual({ kind: "noData", summary: "new" });
  });

  test("a list that cannot be re-read leaves the rows standing and says why", async () => {
    globalThis.fetch = (async (input: string) => {
      if (String(input) === "/api/chart/list") {
        return answer({ status: "ok", recipes: [recipe("commits")] });
      }
      return answer({ status: "ok", summary: "s", spec: null });
    }) as typeof fetch;
    await refreshRecipes("/project/d");

    globalThis.fetch = (async () => {
      throw new Error("no route");
    }) as unknown as typeof fetch;
    await refreshRecipes("/project/d");

    const { rows, listFailure } = chartRecipesFor("/project/d");
    expect(listFailure).toBe("no route");
    expect(rows?.[0]?.outcome).toEqual({ kind: "noData", summary: "s" });
  });

  test("a list that comes back empty leaves the rows standing and says why", async () => {
    globalThis.fetch = (async (input: string) => {
      if (String(input) === "/api/chart/list") {
        return answer({ status: "ok", recipes: [recipe("commits")] });
      }
      return answer({ status: "ok", summary: "s", spec: null });
    }) as typeof fetch;
    await refreshRecipes("/project/e");

    globalThis.fetch = (async () => answer({ status: "ok", recipes: [] })) as unknown as typeof fetch;
    await refreshRecipes("/project/e");

    const { rows, listFailure } = chartRecipesFor("/project/e");
    expect(listFailure).toBe("the list named no recipes");
    expect(rows?.[0]?.outcome).toEqual({ kind: "noData", summary: "s" });
  });

  test("an answer still in flight does not clear a later read's failure", async () => {
    let land: (response: Response) => void = () => {};
    const landed = new Promise<Response>((resolve) => {
      land = resolve;
    });
    let read = () => {};
    const reading = new Promise<void>((resolve) => {
      read = resolve;
    });
    globalThis.fetch = (async (input: string) => {
      if (String(input) === "/api/chart/list") {
        return answer({ status: "ok", recipes: [recipe("commits")] });
      }
      read();
      return landed;
    }) as typeof fetch;
    const first = refreshRecipes("/project/f");
    await reading;

    globalThis.fetch = (async () => {
      throw new Error("no route");
    }) as unknown as typeof fetch;
    await refreshRecipes("/project/f");

    land(answer({ status: "ok", summary: "s", spec: null }));
    await first;

    const { rows, listFailure } = chartRecipesFor("/project/f");
    expect(listFailure).toBe("no route");
    expect(rows?.[0]?.outcome).toEqual({ kind: "noData", summary: "s" });
  });

  test("with no project there is nothing, and the same nothing each time", () => {
    expect(chartRecipesFor(null)).toBe(chartRecipesFor(null));
    expect(chartRecipesFor(null).rows).toBeNull();
  });
});
