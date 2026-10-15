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
import { BUS_KINDS, type BusDelivered, type CardAdvice, type CardCommandKind } from "../bus";

const FIXTURE = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "bus-parity.json"), "utf8")) as {
  delivered: unknown[];
};

const BODY_C1 = { pageId: "body-c1", role: "body", cardId: "c1" } as const;
const BODY_C2 = { pageId: "body-c2", role: "body", cardId: "c2" } as const;
const SHELL = { pageId: "shell-1", role: "shell", cardId: null } as const;

const DELIVERED: BusDelivered[] = [
  {
    from: BODY_C1,
    to: "shell",
    kind: "card-facts",
    payload: {
      title: "Dev",
      masthead: { kind: "session-masthead", sessionId: "s-1" },
      activity: "idle",
      telemetry: { canInterrupt: 0, compacted: 1 },
    },
  },
  {
    from: BODY_C2,
    to: "shell",
    kind: "card-facts",
    payload: { title: "Session", masthead: null, activity: null, telemetry: {} },
  },
  { from: SHELL, to: { card: "c2" }, kind: "card-command", payload: { command: "find", query: "needle" } },
  { from: SHELL, to: { card: "c1" }, kind: "card-command", payload: { command: "focus-prompt" } },
  { from: SHELL, to: { card: "c1" }, kind: "card-command", payload: { command: "interrupt" } },
  { from: SHELL, to: { card: "c1" }, kind: "card-command", payload: { command: "turn-previous" } },
  { from: SHELL, to: { card: "c1" }, kind: "card-command", payload: { command: "turn-next" } },
  {
    from: SHELL,
    to: { page: "body-c2" },
    kind: "card-command",
    payload: { command: "chord", chord: { key: "k", modifiers: ["meta", "shift"] } },
  },
  { from: SHELL, to: { card: "c1" }, kind: "card-command", payload: { command: "dispatch", id: "copy-session-id" } },
  {
    from: SHELL,
    to: { card: "c1" },
    kind: "card-command",
    payload: { command: "dispatch", id: "set-permission-mode", payload: { mode: "plan" } },
  },
  { from: SHELL, to: { card: "c1" }, kind: "card-command", payload: { command: "focus-enter", edge: "last" } },
  { from: SHELL, to: { card: "c1" }, kind: "card-command", payload: { command: "surface-activate", path: [0, 2, 1] } },
  { from: SHELL, to: { card: "c1" }, kind: "card-command", payload: { command: "surface-dismissed" } },
  { from: BODY_C1, to: "shell", kind: "card-advice", payload: { advice: "fold-guard", guarded: true } },
  { from: BODY_C1, to: "shell", kind: "card-advice", payload: { advice: "close-advice", waive: true } },
  { from: BODY_C1, to: "shell", kind: "card-advice", payload: { advice: "sheet-reservation", heightPx: 240 } },
  { from: BODY_C1, to: "shell", kind: "card-advice", payload: { advice: "sheet-reservation", heightPx: null } },
  { from: BODY_C1, to: "shell", kind: "card-advice", payload: { advice: "opening-bid", heightPx: 480 } },
  { from: BODY_C1, to: "shell", kind: "card-advice", payload: { advice: "activate" } },
  { from: BODY_C1, to: "shell", kind: "card-advice", payload: { advice: "close-request" } },
  { from: BODY_C1, to: "shell", kind: "card-advice", payload: { advice: "dispatch", id: "close" } },
  {
    from: BODY_C1,
    to: "shell",
    kind: "card-advice",
    payload: { advice: "dispatch", id: "set-column-mode", payload: { slot: 0, mode: "split" } },
  },
  { from: BODY_C1, to: "shell", kind: "card-advice", payload: { advice: "focus-exit", direction: "next" } },
  { from: BODY_C1, to: "shell", kind: "card-advice", payload: { advice: "focus-exit", direction: "previous", empty: true } },
  {
    from: BODY_C1,
    to: "shell",
    kind: "card-advice",
    payload: {
      advice: "surface",
      surface: {
        title: "Time",
        className: "session-telemetry-status-placard",
        growth: "up",
        anchorX: 320,
        lineY: 590,
        html: "<div class=\"tug-popup-list\">rows</div>",
        scroll: [{ path: [0, 1], top: 480 }],
      },
    },
  },
  { from: BODY_C1, to: "shell", kind: "card-advice", payload: { advice: "surface", surface: null } },
  { from: BODY_C1, to: "shell", kind: "card-advice", payload: { advice: "logout" } },
  {
    from: SHELL,
    to: "body",
    kind: "deck-facts",
    payload: { theme: "ironclad", zoom: 1.25, keyboardAccess: true, modifierLatch: ["shift"], focusRingModality: "pointer", appActive: true },
  },
  {
    from: SHELL,
    to: { card: "c1" },
    kind: "card-context",
    payload: { folded: false, arriving: true, firstResponderCardId: "c1", layerShown: true, spaceId: "space-1" },
  },
  {
    from: SHELL,
    to: { card: "c2" },
    kind: "card-context",
    payload: { folded: true, arriving: false, firstResponderCardId: null, layerShown: false, spaceId: null },
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

  test("the fixture carries every advice variant and every command", () => {
    const advice = new Set<CardAdvice["advice"]>();
    const commands = new Set<CardCommandKind>();
    for (const e of DELIVERED) {
      if (e.kind === "card-advice") advice.add(e.payload.advice);
      if (e.kind === "card-command") commands.add(e.payload.command);
    }
    const allAdvice: Record<CardAdvice["advice"], true> = {
      "fold-guard": true,
      "close-advice": true,
      "sheet-reservation": true,
      "opening-bid": true,
      activate: true,
      "close-request": true,
      dispatch: true,
      "focus-exit": true,
      surface: true,
      logout: true,
    };
    const allCommands: Record<CardCommandKind, true> = {
      find: true,
      "focus-prompt": true,
      interrupt: true,
      "turn-previous": true,
      "turn-next": true,
      chord: true,
      dispatch: true,
      "focus-enter": true,
      "surface-activate": true,
      "surface-dismissed": true,
    };
    expect([...advice].sort()).toEqual(Object.keys(allAdvice).sort());
    expect([...commands].sort()).toEqual(Object.keys(allCommands).sort());
  });
});
