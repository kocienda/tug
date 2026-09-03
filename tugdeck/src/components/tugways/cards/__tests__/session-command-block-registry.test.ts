/**
 * Governance test for `session-command-block-registry.ts` — pins the
 * registry's classification rules on the [D101] grammar ([P05]):
 *
 *  - Resolution is TOTAL: every command resolves to a renderer, and
 *    the default is the generic `ShellExchangeBlock` — raw output
 *    always renders; richness is opt-in.
 *  - No double registration: a duplicate `name` throws. There is no
 *    alias/bucket system to make an override legitimate, so a repeat
 *    is always a wiring mistake.
 *  - Matchers resolve in registration order — first claim wins.
 *  - A reset registry resolves everything to the generic default (the
 *    total-default contract with no registrations).
 *
 * Each test resets the registry first, so module-load registrations (the
 * shipped `commit-receipt` renderer, [P08]) don't leak in and the synthetic
 * registrations below are the whole population under test.
 *
 * @module components/tugways/cards/__tests__/session-command-block-registry
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  _putCommandBlockRegistryForTests,
  _resetCommandBlockRegistryForTests,
  _takeCommandBlockRegistryForTests,
  registerCommandBlock,
  registeredCommandBlocks,
  resolveCommandAttribution,
  resolveCommandBlock,
  resolveCommandPresentation,
} from "../session-command-block-registry";
import type { CommandBlockRenderer } from "../session-command-block-registry";
import { ShellExchangeBlock } from "../shell-exchange-block";

const RendererA: CommandBlockRenderer = () => null;
const RendererB: CommandBlockRenderer = () => null;

// The registry is module-static and the runner shares one module graph across
// files, so this file borrows the shipped population rather than destroying
// it: cleared for the synthetic registrations below, handed back afterwards so
// a file running later in the same process still sees the receipts that ship.
let shipped: unknown[] = [];

beforeEach(() => {
  shipped = _takeCommandBlockRegistryForTests();
});
afterEach(() => {
  _resetCommandBlockRegistryForTests();
  _putCommandBlockRegistryForTests(shipped);
});

describe("session-command-block-registry", () => {
  test("a reset registry is empty — everything resolves to the default", () => {
    expect(registeredCommandBlocks()).toEqual([]);
    expect(resolveCommandBlock("/commit")).toBe(ShellExchangeBlock);
  });

  test("resolution is total: any command defaults to the generic exchange block", () => {
    expect(resolveCommandBlock("git status")).toBe(ShellExchangeBlock);
    expect(resolveCommandBlock("")).toBe(ShellExchangeBlock);
    expect(resolveCommandBlock("   ")).toBe(ShellExchangeBlock);
    expect(resolveCommandBlock("some | weird && pipeline")).toBe(ShellExchangeBlock);
  });

  test("a registered matcher claims its command; misses still default", () => {
    registerCommandBlock("git-status", (c) => c.startsWith("git status"), RendererA);
    expect(resolveCommandBlock("git status")).toBe(RendererA);
    expect(resolveCommandBlock("  git status --short  ")).toBe(RendererA);
    expect(resolveCommandBlock("git log")).toBe(ShellExchangeBlock);
  });

  test("first registration wins when two matchers claim the same command", () => {
    registerCommandBlock("first", (c) => c.startsWith("ls"), RendererA);
    registerCommandBlock("second", () => true, RendererB);
    expect(resolveCommandBlock("ls -la")).toBe(RendererA);
    expect(resolveCommandBlock("pwd")).toBe(RendererB);
  });

  test("double registration of a name throws", () => {
    registerCommandBlock("git-status", (c) => c.startsWith("git status"), RendererA);
    expect(() =>
      registerCommandBlock("git-status", () => true, RendererB),
    ).toThrow('Command block "git-status" is already registered');
  });

  test("registeredCommandBlocks reports registration (= resolution) order", () => {
    registerCommandBlock("b", () => false, RendererB);
    registerCommandBlock("a", () => false, RendererA);
    expect(registeredCommandBlocks()).toEqual(["b", "a"]);
  });

  test("attribution defaults to shell and is declared per registration", () => {
    registerCommandBlock("plain", (c) => c === "ls", RendererA);
    registerCommandBlock("landed", (c) => c === "/land", RendererB, {
      attribution: "git",
    });
    // The default is the literal truth about a $-route row, so a registration
    // that says nothing gets it.
    expect(resolveCommandAttribution("ls")).toBe("shell");
    expect(resolveCommandAttribution("/land")).toBe("git");
    // Total on the same terms as the renderer resolve.
    expect(resolveCommandAttribution("git status")).toBe("shell");
  });

  test("presentation defaults to entry and is declared per registration", () => {
    registerCommandBlock("plain", (c) => c === "ls", RendererA);
    registerCommandBlock("note", (c) => c === "arc step demo done", RendererB, {
      attribution: "wheel",
      presentation: "quiet",
    });
    // The default is the shape every exchange has always worn, so a
    // registration that says nothing gets it — as does an unclaimed command.
    expect(resolveCommandPresentation("ls")).toBe("entry");
    expect(resolveCommandPresentation("arc step demo done")).toBe("quiet");
    expect(resolveCommandPresentation("git status")).toBe("entry");
  });

  test("attribution resolves by the same walk as the renderer", () => {
    // First claim wins for both, from one registration — the property that
    // stops a row from wearing one registration's block under another's
    // header.
    registerCommandBlock("first", (c) => c.startsWith("/x"), RendererA, {
      attribution: "git",
    });
    registerCommandBlock("second", (c) => c.startsWith("/x"), RendererB);
    expect(resolveCommandBlock("/xyz")).toBe(RendererA);
    expect(resolveCommandAttribution("/xyz")).toBe("git");
  });
});
