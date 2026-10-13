/**
 * `DECK_BUS` envelopes against the fixture the Rust half is held to.
 *
 * tugcast parses and writes bus envelopes with the serde types in
 * `tugrust/crates/tugcast-core/src/bus.rs`, whose tests round-trip every
 * entry of `fixtures/bus-parity.json`. Here the same fixture must equal
 * values written against `bus.ts`'s types, so a field renamed, retyped or
 * added on either side fails one half or the other.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUS_KINDS, type BusDelivered } from "../bus";

const FIXTURE = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "bus-parity.json"), "utf8")) as {
  delivered: unknown[];
};

const BODY_C1 = { pageId: "body-c1", role: "body", cardId: "c1" } as const;
const SHELL = { pageId: "shell-1", role: "shell", cardId: null } as const;

const DELIVERED: BusDelivered[] = [
  {
    from: BODY_C1,
    to: "shell",
    kind: "card-facts",
    payload: { title: "Dev", mastheadLine: null, activity: "idle", telemetry: { turns: 4, costUsd: 0.25 } },
  },
  { from: SHELL, to: { card: "c2" }, kind: "card-command", payload: { command: "find", query: "needle" } },
  {
    from: SHELL,
    to: { page: "body-c2" },
    kind: "card-command",
    payload: { command: "chord", chord: { key: "k", modifiers: ["meta", "shift"] } },
  },
  { from: SHELL, to: { card: "c1" }, kind: "card-command", payload: { command: "interrupt" } },
  { from: BODY_C1, to: "shell", kind: "card-advice", payload: { advice: "fold-guard", guarded: true } },
  {
    from: BODY_C1,
    to: "shell",
    kind: "card-advice",
    payload: { advice: "close-advice", confirm: true, message: "A turn is running." },
  },
  { from: BODY_C1, to: "shell", kind: "card-advice", payload: { advice: "sheet-reservation", reserved: false } },
  { from: BODY_C1, to: "shell", kind: "card-advice", payload: { advice: "opening-bid", widthPx: 640, heightPx: null } },
  {
    from: SHELL,
    to: "body",
    kind: "deck-facts",
    payload: { theme: "ironclad", zoom: 1.25, keyboardAccess: true, modifierLatch: ["shift"], appActive: true },
  },
];

describe("bus envelope parity", () => {
  test("delivered envelopes match the fixture", () => {
    expect(FIXTURE.delivered).toEqual(DELIVERED);
  });

  test("the fixture carries every kind", () => {
    const kinds = new Set(DELIVERED.map((e) => e.kind));
    expect([...kinds].sort()).toEqual([...BUS_KINDS].sort());
  });
});
