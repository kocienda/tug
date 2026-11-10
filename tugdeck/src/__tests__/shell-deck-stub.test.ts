/**
 * A test's stand-in for the shell's deck goes in through
 * `registerStubShellDeck`, and nothing else registers one.
 *
 * The rule exists because of how it failed. The restore gate began following
 * the registered deck's workspaces on 2026-11-09, eleven test files held
 * doubles with no workspaces facet, and the suite went red in whichever of
 * them ran after a file that had woken the gate: seventeen failures, every
 * one green alone. The helper states the facet; this scan keeps a new double
 * from going round it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { IDeckManagerStore } from "@/deck-manager-store";
import { getShellDeck, registerShellDeck } from "@/lib/deck-store-registry";
import { registerStubShellDeck } from "./shell-deck-stub";

const SRC = join(import.meta.dir, "..");

afterEach(() => registerShellDeck(null));

describe("registerStubShellDeck", () => {
  test("registers the test's own object, with an inert workspaces facet", () => {
    const stub = { getSnapshot: () => ({ cards: [] }) } as unknown as IDeckManagerStore;
    registerStubShellDeck(stub);
    const deck = getShellDeck();
    expect(deck).toBe(stub);
    expect(deck!.spaceOf("any")).toBeNull();
    expect(deck!.getSpacesSnapshot().activeSpaceId).toBeNull();
    const release = deck!.subscribeSpaces(() => {});
    expect(typeof release).toBe("function");
    release();
  });

  test("leaves the members a test stated as it stated them", () => {
    const spaceOf = () => "space-1";
    const getSpacesSnapshot = () => ({ activeSpaceId: "space-1" });
    const stub = { spaceOf, getSpacesSnapshot } as unknown as IDeckManagerStore;
    registerStubShellDeck(stub);
    expect(getShellDeck()!.spaceOf).toBe(spaceOf);
    expect(getShellDeck()!.getSpacesSnapshot as unknown).toBe(getSpacesSnapshot);
  });
});

describe("the tests' shell decks", () => {
  test("none is registered except through registerStubShellDeck", () => {
    const direct: string[] = [];
    for (const file of new Bun.Glob("**/*.{ts,tsx}").scanSync(SRC)) {
      if (!file.includes("__tests__") && !/\.test\.tsx?$/.test(file)) continue;
      // The helper is the one caller, and this file only names the call.
      if (file.startsWith("__tests__/shell-deck-stub.")) continue;
      const source = readFileSync(join(SRC, file), "utf8");
      // `registerShellDeck(null)` withdraws a deck, which is every test's to do.
      for (const m of source.matchAll(/\bregisterShellDeck\(\s*([^)\s][^),]*)/g)) {
        if (m[1]!.trim() !== "null") direct.push(`${file}: registerShellDeck(${m[1]!.trim()}…`);
      }
    }
    expect(direct).toEqual([]);
  });
});
