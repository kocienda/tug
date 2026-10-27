/**
 * The TIME popup on an arc card reads the arc by its stages and steps.
 *
 * A card no arc is bound to keeps the per-turn log; one whose arc has rotated
 * a stage shows the stage strip, stage rows, implement's steps with their
 * commits, the open step live, the pending steps and the audit projected, and
 * a step that took two turns opens to them.
 *
 * @covers tugdeck/src/components/tugways/cards/session-card-telemetry-popovers.tsx
 * @covers tugdeck/src/lib/arc-time.ts
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import React from "react";

import { installJsdom } from "../../../../__tests__/jsdom-deck";
import type { ArcStep, ArcTimeline } from "@/lib/changeset-types";
import type { TurnEntry } from "@/lib/code-session-store/types";

const substrate = installJsdom();
afterAll(() => substrate.restore());

const MIN = 60_000;
const SEC = 1_000;
const T0 = Date.parse("2026-10-27T15:42:05.922Z");
const at = (m: number, s = 0) => T0 + m * MIN + s * SEC;

const timeline: ArcTimeline = {
  stages: [
    { stage: "devise", at_ms: at(0), model: "opus" },
    { stage: "review", at_ms: at(15, 30), model: "opus" },
    { stage: "implement", at_ms: at(26, 39), model: "opus" },
  ],
  steps: [
    { n: 1, total: 4, title: "Sheets, register and DOCUMENTS", spans: [{ start_ms: at(27, 7), end_ms: at(34, 55) }], end: "done", commit: "315f6074a" },
    { n: 2, total: 4, title: "Every rung reports", spans: [{ start_ms: at(35, 9), end_ms: at(49, 11) }], end: "done", commit: "f6c778d6c" },
    { n: 3, total: 4, title: "Resolve again", spans: [{ start_ms: at(49, 30) }] },
  ],
  marks: [],
  run_through: 4,
  typical_audit_ms: 19 * MIN + 42 * SEC,
};

const ledger: ArcStep[] = [
  { title: "Sheets, register and DOCUMENTS", status: "done" },
  { title: "Every rung reports", status: "done" },
  { title: "Resolve again", status: "in progress" },
  { title: "The durable ledger", status: "pending" },
];

let seq = 0;
/** A committed turn; only the fields the popup reads are real. */
function turn(start: number, wall: number, active: number): TurnEntry {
  seq += 1;
  return {
    turnKey: `t${seq}`,
    msgId: `m${seq}`,
    origin: "user",
    messages: [],
    result: "success",
    endedAt: start + wall,
    wallClockMs: wall,
    awaitingApprovalMs: 0,
    transportDowntimeMs: 0,
    activeMs: active,
    ttftMs: 1000,
    ttftcMs: null,
    reconnectCount: 0,
    maxStreamGapMs: 0,
    turnEndReason: "complete",
    cost: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalCostUsd: 0 },
  } as unknown as TurnEntry;
}

const transcript: TurnEntry[] = [
  turn(at(0, 1), 15 * MIN + 25 * SEC, 15 * MIN + 20 * SEC), // devise
  turn(at(15, 31), 11 * MIN + 5 * SEC, 11 * MIN), // review
  turn(at(26, 40), 8 * MIN + 20 * SEC, 7 * MIN + 41 * SEC), // step 1
  turn(at(35, 0), 9 * MIN, 8 * MIN + 50 * SEC), // step 2, ends on a question
  turn(at(45, 0), 4 * MIN + 15 * SEC, 4 * MIN), // step 2, answered
];

afterEach(() => {
  document.body.innerHTML = "";
});

async function render(el: React.ReactElement): Promise<{ host: HTMLElement; unmount: () => void | Promise<void> }> {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(el));
  return { host, unmount: () => act(() => root.unmount()) };
}

const text = (host: HTMLElement) => host.textContent ?? "";

describe("TimePopoverContent on an arc card", () => {
  test("reads by stages and steps, with the open step live and the rest projected", async () => {
    const { TimePopoverContent } = await import("../session-card-telemetry-popovers");
    const { host, unmount } = await render(
      <TimePopoverContent
        transcript={transcript}
        inflight={{ currentTurnActiveMs: 2 * MIN }}
        arc={{ timeline, ledger, stopped: false, done: false }}
        nowMs={at(52)}
      />,
    );
    const body = text(host);
    for (const word of ["DEVISE", "REVIEW", "IMPLEMENT", "AUDIT"]) expect(body).toContain(word);
    expect(body).toContain("Sheets, register and DOCUMENTS");
    expect(body).toContain("315f607");
    expect(body).toContain("in flight");
    expect(body).toContain("The durable ledger");
    expect(body).toContain("2 of 4 done");
    // Two finished steps make a pace, so the rest is projected.
    expect(body).toContain("at this arc's pace");
    expect(body).toMatch(/~\d+h \d+m \d+s/);
    expect(host.querySelector("[data-slot='session-time-popover-arc-strip']")).not.toBeNull();
    await unmount();
  });

  test("a step that took two turns opens to them", async () => {
    const { act } = await import("react");
    const { TimePopoverContent } = await import("../session-card-telemetry-popovers");
    const { host, unmount } = await render(
      <TimePopoverContent
        transcript={transcript}
        inflight={null}
        arc={{ timeline, ledger, stopped: false, done: false }}
        nowMs={at(52)}
      />,
    );
    const disclose = host.querySelector<HTMLButtonElement>("button[aria-label=\"Show step 2's turns\"]");
    expect(disclose).not.toBeNull();
    expect(host.querySelectorAll(".session-time-arc-nested")).toHaveLength(0);
    await act(async () => disclose!.click());
    expect(host.querySelectorAll(".session-time-arc-nested")).toHaveLength(2);
    await unmount();
  });

  test("a stopped arc projects nothing", async () => {
    const { TimePopoverContent } = await import("../session-card-telemetry-popovers");
    const { host, unmount } = await render(
      <TimePopoverContent
        transcript={transcript}
        inflight={null}
        arc={{ timeline, ledger, stopped: true, done: false }}
        nowMs={at(52)}
      />,
    );
    const body = text(host);
    expect(body).toContain("none while stopped");
    expect(body).toContain("stopped");
    expect(body).not.toMatch(/~\d+h \d+m \d+s/);
    await unmount();
  });

  test("a card with no arc keeps the per-turn log", async () => {
    const { TimePopoverContent } = await import("../session-card-telemetry-popovers");
    const { host, unmount } = await render(
      <TimePopoverContent transcript={transcript} inflight={null} arc={null} />,
    );
    const body = text(host);
    expect(body).not.toContain("IMPLEMENT");
    expect(body).toContain("turns");
    expect(body).toContain("avg");
    await unmount();
  });
});

describe("composeArcTimeCopyText", () => {
  test("stages, then their steps indented, then the totals", async () => {
    const { composeArcTimeCopyText } = await import("../session-card-telemetry-popovers");
    const { computeArcTime } = await import("@/lib/arc-time");
    const reading = computeArcTime({ timeline, ledger, stopped: false, done: false, transcript, inflightMs: null, nowMs: at(52) });
    const lines = composeArcTimeCopyText(reading).split("\n");
    expect(lines[0]).toMatch(/^devise\t/);
    expect(lines).toContain("  1\tSheets, register and DOCUMENTS\t315f607\t0h 7m 41s");
    expect(lines.some((l) => l.startsWith("  4\tThe durable ledger\tpending\t~"))).toBe(true);
    expect(lines.some((l) => l.startsWith("audit\tprojected\t~0h 19m 42s"))).toBe(true);
    expect(lines[lines.length - 1]).toMatch(/^projected\t~/);
  });
});
