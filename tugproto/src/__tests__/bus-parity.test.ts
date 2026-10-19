/**
 * `DECK_BUS` envelopes against the fixture the Rust half is held to.
 *
 * tugcast parses and writes bus envelopes with the serde types in
 * `tugrust/crates/tugcast-core/src/bus.rs`, whose tests round-trip every
 * entry of `fixtures/bus-parity.json` verbatim. Here the same fixture must
 * equal values written against `bus.ts`'s envelope types, so an envelope
 * field renamed or retyped on either side fails one half or the other.
 * Payloads are opaque to both halves; the fixture carries one envelope per
 * kind and one per target form.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUS_ENVELOPE_KINDS, type BusEnvelopeDelivered } from "../bus";

const FIXTURE = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "bus-parity.json"), "utf8")) as {
  delivered: Array<{ kind: string; to: unknown }>;
};

const BODY_C1 = { pageId: "body-c1", role: "body", cardId: "c1" } as const;
const BODY_C2 = { pageId: "body-c2", role: "body", cardId: "c2" } as const;
const SHELL = { pageId: "shell-1", role: "shell", cardId: null } as const;

const DELIVERED: BusEnvelopeDelivered[] = [
  { from: BODY_C1, to: "shell", kind: "hello", payload: { role: "body", cardId: "c1", componentId: "session" } },
  { from: SHELL, to: "body", kind: "hello", payload: { role: "shell" } },
  {
    from: SHELL,
    to: { card: "c1" },
    kind: "state",
    key: "layout.selection",
    card: "c1",
    version: 4,
    ack: { "body-c1": 2 },
    payload: { ids: ["c1", "c2"], anchorId: "c1", cursor: null },
  },
  { from: SHELL, to: "body", kind: "state", key: "deck.facts", version: 1, payload: { theme: "ironclad", zoom: 1.25 } },
  {
    from: BODY_C1,
    to: "shell",
    kind: "action",
    key: "layout.selection",
    card: "c1",
    proposal: 2,
    payload: { ids: ["c2"] },
  },
  { from: SHELL, to: { card: "c2" }, kind: "request", key: "card.closeDecision", requestId: "8f2c", payload: {} },
  { from: SHELL, to: { card: "c2" }, kind: "request", key: "session.ask", requestId: "8f2d", withdraw: true },
  {
    from: BODY_C2,
    to: { page: "shell-1" },
    kind: "reply",
    key: "card.closeDecision",
    requestId: "8f2c",
    payload: { ok: true, value: { answer: "close" } },
  },
];

describe("bus envelope parity", () => {
  test("delivered envelopes match the fixture", () => {
    expect(FIXTURE.delivered).toEqual(DELIVERED as unknown as typeof FIXTURE.delivered);
  });

  test("the fixture carries every envelope kind", () => {
    const kinds = new Set(FIXTURE.delivered.map((e) => e.kind));
    expect([...kinds].sort()).toEqual([...BUS_ENVELOPE_KINDS].sort());
  });

  test("the fixture carries every target form", () => {
    const forms = new Set(
      FIXTURE.delivered.map((e) => (typeof e.to === "string" ? e.to : Object.keys(e.to as object)[0])),
    );
    expect([...forms].sort()).toEqual(["body", "card", "page", "shell"]);
  });
});
