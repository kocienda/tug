import { afterEach, describe, expect, test } from "bun:test";

import { chartRecipesFor, narrowCatalog, narrowOutcome, refreshRecipes } from "../chart-recipes-store";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("chart recipes — narrowing", () => {
  test("the list's rows are read as they came, and a malformed row is dropped", () => {
    expect(
      narrowCatalog({
        status: "ok",
        recipes: [
          { name: "commits", question: "How often?", form: "bar", data: "git log", args: [] },
          { name: "", question: "No name", form: "bar" },
          { name: "churn", question: 3, form: "area" },
          { name: "gaps", question: "What ran dark?", form: "bar" },
        ],
      }),
    ).toEqual([
      { name: "commits", question: "How often?", form: "bar" },
      { name: "gaps", question: "What ran dark?", form: "bar" },
    ]);
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

describe("chart recipes — reading", () => {
  test("every recipe reaches an answer, and a read that fails becomes failed", async () => {
    globalThis.fetch = (async (input: string) => {
      const url = String(input);
      if (url === "/api/chart/list") {
        return answer({
          status: "ok",
          recipes: [
            { name: "commits", question: "q", form: "bar" },
            { name: "gaps", question: "q", form: "bar" },
            { name: "landed", question: "q", form: "bar" },
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
        return answer({ status: "ok", recipes: [{ name: "commits", question: "q", form: "bar" }] });
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

  test("with no project there is nothing, and the same nothing each time", () => {
    expect(chartRecipesFor(null)).toBe(chartRecipesFor(null));
    expect(chartRecipesFor(null).rows).toBeNull();
  });
});
