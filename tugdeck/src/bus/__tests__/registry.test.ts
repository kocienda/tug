/**
 * The registry is the whole vocabulary: nothing is declared outside
 * `src/bus/declarations/`, everything declared there is listed in
 * `bus/registry.ts`, and every codec round-trips its sample.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { INVALID } from "../codec";
import { jsonEqual } from "../equal";
import { REQUESTS, ROUTED_ACTIONS, SHARED_STORES } from "../registry";
import { createTestBus, type TestBus } from "../test-bus";
import { deckAddCard, deckInterruptLiveSessions, deckShowSingletonCard } from "../declarations/arrangement";
import { paneRevealCard } from "../declarations/pane";

const SRC = join(import.meta.dir, "..", "..");
const DECLARATIONS = join(SRC, "bus", "declarations");
// A type argument may nest one generic inside another (`<Record<string, T>>`).
const CALL = /(?<!function )\bdefine(SharedStore|Action|Request)\s*(<(?:[^<>]|<(?:[^<>]|<[^<>]*>)*>)*>)?\s*\(/g;
const HAS_CALL = new RegExp(CALL.source);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

/** The code lines of a file: no comment lines. */
function codeOf(path: string): string {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
}

const registered = [...SHARED_STORES, ...ROUTED_ACTIONS, ...REQUESTS];

describe("the bus registry", () => {
  test("no declaration lives outside src/bus/declarations/", () => {
    const strays = sourceFiles(SRC)
      .filter((path) => !path.startsWith(DECLARATIONS) && !path.includes(`${join("bus", "__tests__")}`))
      .filter((path) => HAS_CALL.test(codeOf(path)))
      .map((path) => relative(SRC, path));
    expect(strays).toEqual([]);
  });

  test("everything declared in src/bus/declarations/ is registered", async () => {
    const files = readdirSync(DECLARATIONS).filter((n) => n.endsWith(".ts"));
    let calls = 0;
    const exported = new Set<unknown>();
    for (const name of files) {
      calls += [...codeOf(join(DECLARATIONS, name)).matchAll(CALL)].length;
      const mod = (await import(join(DECLARATIONS, name))) as Record<string, unknown>;
      for (const value of Object.values(mod)) {
        const kind = (value as { kind?: unknown } | null)?.kind;
        if (kind === "store" || kind === "action" || kind === "request") exported.add(value);
      }
    }
    expect(registered.length).toBe(calls);
    expect(new Set<unknown>(registered)).toEqual(exported);
  });

  test("keys are unique across stores, actions and requests", () => {
    const keys = registered.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("every codec decodes its own sample to an equal value", () => {
    const codecs = [
      ...SHARED_STORES.flatMap((s) => [
        [`${s.key} value`, s.declaration.codec],
        ...(s.declaration.proposals ? [[`${s.key} proposals`, s.declaration.proposals]] : []),
      ]),
      ...ROUTED_ACTIONS.map((a) => [`${a.key} payload`, a.declaration.codec]),
      ...REQUESTS.flatMap((r) => [
        [`${r.key} payload`, r.declaration.codec],
        [`${r.key} reply`, r.declaration.replyCodec],
      ]),
    ] as Array<[string, { decode(v: unknown): unknown; sample: unknown }]>;
    const failing = codecs
      .filter(([, c]) => {
        const decoded = c.decode(JSON.parse(JSON.stringify(c.sample)));
        return decoded === INVALID || !jsonEqual(decoded, c.sample);
      })
      .map(([name]) => name);
    expect(failing).toEqual([]);
  });

  test("every store's initial value is one its codec admits", () => {
    const failing = SHARED_STORES.filter((s) => s.declaration.codec.decode(s.declaration.initial) === INVALID).map((s) => s.key);
    expect(failing).toEqual([]);
  });

  test("every store a declaration names in `after` is a registered store", () => {
    const stores = new Set(SHARED_STORES.map((s) => s.key));
    const dangling = SHARED_STORES.flatMap((s) =>
      (s.declaration.after ?? []).filter((a) => !stores.has(a.key)).map((a) => `${s.key} after ${a.key}`),
    );
    expect(dangling).toEqual([]);
    // The orders the shell and the bodies rely on are declared, not inherited from import order.
    const afterOf = (key: string) => SHARED_STORES.find((s) => s.key === key)?.declaration.after?.map((a) => a.key);
    expect(afterOf("card.painted")).toEqual(["card.facts"]);
    expect(afterOf("card.context")).toEqual(["card.crossing"]);
  });
});

describe("deck.cards", () => {
  test("is the one deck-wide card-facts store: listed, and the three it replaced are gone", () => {
    const keys = registered.map((r) => r.key);
    expect(keys).toContain("deck.cards");
    for (const gone of ["deck.cardBindings", "deck.cardActivities", "arrangement.cardFacts"]) {
      expect(keys).not.toContain(gone);
    }
  });
});

describe("the deck verbs any card makes", () => {
  let testBus: TestBus | undefined;
  afterEach(() => {
    testBus?.dispose();
    testBus = undefined;
  });

  test("are registered", () => {
    const keys = registered.map((r) => r.key);
    for (const key of ["deck.addCard", "deck.showSingletonCard", "deck.interruptLiveSessions", "pane.revealCard"]) {
      expect(keys).toContain(key);
    }
  });

  test("each reaches the shell from a body, and the request's reply comes back", async () => {
    testBus = createTestBus();
    const shell = testBus.shell();
    const body = testBus.body("c-asker", "session");
    const heard: Array<[string, unknown, string | null]> = [];
    deckAddCard.on(shell.bus).handle((p, from) => heard.push(["deck.addCard", p, from.cardId]));
    deckShowSingletonCard.on(shell.bus).handle((p, from) => heard.push(["deck.showSingletonCard", p, from.cardId]));
    paneRevealCard.on(shell.bus).handle((p, from) => heard.push(["pane.revealCard", p, from.cardId]));
    deckInterruptLiveSessions.on(shell.bus).handle(() => ({ interrupted: ["s1"], unacknowledged: ["s2"] }));
    await testBus.flush();

    deckAddCard.on(body.bus).dispatch({ cardId: "c-new", componentId: "text", initialContent: { path: "/a" }, origin: "c-asker", opening: undefined });
    deckShowSingletonCard.on(body.bus).dispatch({ componentId: "settings" });
    paneRevealCard.on(body.bus).dispatch({ cardId: "c-asker" });
    const asked = deckInterruptLiveSessions.on(body.bus).ask({}, { horizon: { ms: 1_000 } });
    await testBus.flush();

    expect(heard).toEqual([
      ["deck.addCard", { cardId: "c-new", componentId: "text", initialContent: { path: "/a" }, origin: "c-asker" }, "c-asker"],
      ["deck.showSingletonCard", { componentId: "settings" }, "c-asker"],
      ["pane.revealCard", { cardId: "c-asker" }, "c-asker"],
    ]);
    expect(await asked).toEqual({ ok: true, value: { interrupted: ["s1"], unacknowledged: ["s2"] } });
  });
});
