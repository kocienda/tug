import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  diagramForms,
  loadDiagramForms,
  narrowDiagramForms,
  resetDiagramFormsForTest,
} from "../diagram-forms-store";

const realFetch = globalThis.fetch;

beforeEach(() => {
  resetDiagramFormsForTest();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** A form as the store holds it. */
function form(name: string) {
  return { name, shows: "s", said: ["a word"], ask: `/explain x as ${name}`, sample: { form: name } };
}

/** The same form as the list sends it. */
function listed(name: string) {
  return { ...form(name), kind: "diagram" };
}

describe("diagram forms — narrowing", () => {
  test("the list's rows are read as they came, and a malformed row is dropped", () => {
    expect(
      narrowDiagramForms({
        status: "ok",
        forms: [
          listed("flow"),
          listed(""),
          { ...listed("bar"), kind: "chart" },
          { ...listed("sequence"), shows: 3 },
          { ...listed("layers"), said: "levels" },
          { ...listed("stack"), said: ["architecture", 4] },
          { ...listed("states"), ask: undefined },
          { ...listed("line"), sample: undefined },
          { ...listed("heat"), sample: null },
          listed("tree"),
        ],
      }),
    ).toEqual([form("flow"), form("tree")]);
  });

  test("a body with no list narrows to none", () => {
    expect(narrowDiagramForms({ status: "ok" })).toEqual([]);
    expect(narrowDiagramForms({ status: "error", message: "forbidden" })).toEqual([]);
    expect(narrowDiagramForms("nope")).toEqual([]);
  });
});

describe("diagram forms — reading", () => {
  test("before any read there is nothing, and the same nothing each time", () => {
    expect(diagramForms()).toBe(diagramForms());
    expect(diagramForms()).toEqual({ forms: null, failure: null });
  });

  test("the list is read once from the diagram kind, and held", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: string) => {
      urls.push(String(input));
      return answer({ status: "ok", forms: [listed("flow"), listed("tree")] });
    }) as typeof fetch;

    await loadDiagramForms();
    await loadDiagramForms();

    expect(urls).toEqual(["/api/chart/forms?kind=diagram"]);
    expect(diagramForms()).toEqual({ forms: [form("flow"), form("tree")], failure: null });
  });

  test("surfaces arriving together take one read", async () => {
    let reads = 0;
    globalThis.fetch = (async () => {
      reads += 1;
      return answer({ status: "ok", forms: [listed("flow")] });
    }) as unknown as typeof fetch;

    await Promise.all([loadDiagramForms(), loadDiagramForms()]);

    expect(reads).toBe(1);
  });

  test("a list that cannot be read says so, and the next arrival reads again", async () => {
    globalThis.fetch = (async () => {
      throw new Error("no route");
    }) as unknown as typeof fetch;
    await loadDiagramForms();
    expect(diagramForms()).toEqual({ forms: null, failure: "no route" });

    globalThis.fetch = (async () => answer({ status: "ok", forms: [listed("flow")] })) as unknown as typeof fetch;
    await loadDiagramForms();
    expect(diagramForms()).toEqual({ forms: [form("flow")], failure: null });
  });

  test("a list that names no diagram form is a failure", async () => {
    globalThis.fetch = (async () =>
      answer({ status: "ok", forms: [{ ...listed("bar"), kind: "chart" }] })) as unknown as typeof fetch;

    await loadDiagramForms();

    expect(diagramForms()).toEqual({ forms: null, failure: "the list named no diagram forms" });
  });

  test("an answer that is not JSON is a failure", async () => {
    globalThis.fetch = (async () => new Response("<html>", { status: 502 })) as unknown as typeof fetch;

    await loadDiagramForms();

    expect(diagramForms().forms).toBeNull();
    expect(diagramForms().failure).not.toBeNull();
  });
});
