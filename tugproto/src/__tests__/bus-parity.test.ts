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
  {
    from: BODY_C2,
    to: "shell",
    kind: "card-facts",
    payload: {
      title: "notes.md",
      masthead: null,
      activity: null,
      telemetry: {},
      identity: { title: "notes.md", path: "/p/notes.md", unsaved: true },
      titleBar: [{ commandId: "reveal-card-file", icon: "FolderOpenDot", enabled: true }],
    },
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
  { from: SHELL, to: { card: "c1" }, kind: "card-command", payload: { command: "close-decision" } },
  { from: SHELL, to: { card: "c1" }, kind: "card-command", payload: { command: "content-action", id: "reveal-changes" } },
  { from: SHELL, to: { card: "c1" }, kind: "card-command", payload: { command: "reveal-line", payload: { line: 12, endLine: 14 } } },
  { from: SHELL, to: { card: "c1" }, kind: "card-command", payload: { command: "inspect", on: true } },
  {
    from: SHELL,
    to: { card: "c2" },
    kind: "card-command",
    payload: { command: "inspection", inspection: { transportState: "live", turns: 3 } },
  },
  { from: SHELL, to: { card: "c2" }, kind: "card-command", payload: { command: "reveal-settings", payload: { section: "sessionCard" } } },
  {
    from: SHELL,
    to: { card: "c2" },
    kind: "card-command",
    payload: { command: "dev-log", payload: { entries: [{ level: "info", source: "body", message: "ready", timestamp: 1700000000000 }] } },
  },
  {
    from: SHELL,
    to: { card: "c2" },
    kind: "card-command",
    payload: { command: "intent", payload: { kind: "resume", tugSessionId: "s1", projectDir: "/p", reason: "launch" } },
  },
  { from: SHELL, to: { card: "c2" }, kind: "card-command", payload: { command: "new-jot" } },
  { from: SHELL, to: { card: "c2" }, kind: "card-command", payload: { command: "refuse-hold" } },
  {
    from: SHELL,
    to: { card: "c2" },
    kind: "card-command",
    payload: { command: "ask", payload: { ask: { requestId: "r1", title: "Run them?", options: [{ value: "yes", label: "Yes" }] } } },
  },
  { from: BODY_C1, to: "shell", kind: "card-advice", payload: { advice: "fold-guard", guarded: true } },
  { from: BODY_C1, to: "shell", kind: "card-advice", payload: { advice: "close-advice", waive: true } },
  { from: BODY_C1, to: "shell", kind: "card-advice", payload: { advice: "sheet-reservation", heightPx: 240 } },
  { from: BODY_C1, to: "shell", kind: "card-advice", payload: { advice: "sheet-reservation", heightPx: null } },
  { from: BODY_C1, to: "shell", kind: "card-advice", payload: { advice: "opening-bid", heightPx: 480 } },
  { from: BODY_C1, to: "shell", kind: "card-advice", payload: { advice: "activate" } },
  { from: BODY_C1, to: "shell", kind: "card-advice", payload: { advice: "painted" } },
  { from: BODY_C1, to: "shell", kind: "card-advice", payload: { advice: "close-request" } },
  { from: BODY_C1, to: "shell", kind: "card-advice", payload: { advice: "add-card", componentId: "spike-slot-layout" } },
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
    from: BODY_C2,
    to: "shell",
    kind: "card-advice",
    payload: { advice: "deck-call", method: "setFlowOffset", args: [120] },
  },
  { from: BODY_C1, to: "shell", kind: "card-advice", payload: { advice: "close-guard", asks: true } },
  { from: BODY_C1, to: "shell", kind: "card-advice", payload: { advice: "close-decision", answer: "cancel" } },
  { from: BODY_C1, to: "shell", kind: "card-advice", payload: { advice: "capture-armed", armed: true } },
  {
    from: BODY_C1,
    to: "shell",
    kind: "card-advice",
    payload: { advice: "modal-hold", reason: "Compacting this session.", admitsFold: true },
  },
  { from: BODY_C1, to: "shell", kind: "card-advice", payload: { advice: "modal-hold", reason: null } },
  {
    from: BODY_C1,
    to: "shell",
    kind: "card-advice",
    payload: { advice: "inspection", inspection: { transportState: "live", turns: 3 } },
  },
  { from: BODY_C1, to: "shell", kind: "card-advice", payload: { advice: "ask-response", requestId: "r1", choice: "yes" } },
  {
    from: SHELL,
    to: "body",
    kind: "deck-facts",
    payload: { theme: "ironclad", zoom: 1.25, keyboardAccess: true, modifierLatch: ["shift"], focusRingModality: "pointer", appActive: true },
  },
  {
    from: SHELL,
    to: "body",
    kind: "deck-facts",
    payload: {
      theme: "ironclad",
      zoom: 1,
      keyboardAccess: false,
      modifierLatch: [],
      focusRingModality: "keyboard",
      appActive: true,
      frontmostProject: { binding: { tugSessionId: "s1", lineId: "l1", workspaceKey: "w1", projectDir: "/p" } },
      motionDemoted: true,
    },
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
  {
    from: SHELL,
    to: { card: "c1" },
    kind: "card-context",
    payload: {
      folded: false,
      arriving: false,
      firstResponderCardId: "c1",
      layerShown: true,
      spaceId: null,
      crossing: { still: 7, settled: false, width: false, heightFree: false, fold: null, held: { "--tugx-still-held-height": "842px" } },
    },
  },
  {
    from: SHELL,
    to: { card: "c2" },
    kind: "card-context",
    payload: {
      folded: false,
      arriving: false,
      firstResponderCardId: "c1",
      layerShown: true,
      spaceId: "space-1",
      arrangement: { deck: { panes: [] }, bandWidth: 1600 },
      followed: { cardId: "c1", binding: null },
      appInfo: { name: "Tug", version: "0.8.0" },
      railSide: "right",
    },
  },
  {
    from: SHELL,
    to: { card: "c3" },
    kind: "card-context",
    payload: { folded: false, arriving: false, firstResponderCardId: "c1", layerShown: false, spaceId: "space-2", parkedKey: true },
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
      painted: true,
      "close-request": true,
      "add-card": true,
      dispatch: true,
      "focus-exit": true,
      surface: true,
      logout: true,
      "deck-call": true,
      "close-guard": true,
      "close-decision": true,
      "capture-armed": true,
      "modal-hold": true,
      inspection: true,
      "ask-response": true,
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
      "close-decision": true,
      inspect: true,
      inspection: true,
      "content-action": true,
      "reveal-line": true,
      "reveal-settings": true,
      "dev-log": true,
      intent: true,
      "new-jot": true,
      ask: true,
      "refuse-hold": true,
    };
    expect([...advice].sort()).toEqual(Object.keys(allAdvice).sort());
    expect([...commands].sort()).toEqual(Object.keys(allCommands).sort());
  });
});
