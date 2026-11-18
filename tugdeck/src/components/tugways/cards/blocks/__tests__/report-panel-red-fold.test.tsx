/**
 * A red card caps its failure and folds the rest.
 *
 * A failure's title and message arrive at any length: a check's command with
 * two hundred paths in it, a file's diagnostics by the kilobyte. The card
 * shows the model's preview of them and, only when the preview held
 * something back, a "Full output" fold under it. A failure that fits is
 * drawn whole with no fold.
 */

import { afterAll, describe, expect, test } from "bun:test";
import React from "react";

import { installJsdom } from "../../../../../__tests__/jsdom-deck";
import { FAILURE_PREVIEW_CHARS } from "../../../../../lib/report-panel-model";
import type { Report, RunUnit } from "../../../../../lib/report-store";

const substrate = installJsdom();

afterAll(() => substrate.restore());

function finishedRun(red: Partial<RunUnit>): Report {
  return {
    toolUseId: "t",
    label: "app-test",
    text: "at0339 FAIL",
    done: 2,
    total: 2,
    failures: 1,
    unit: "file",
    units: [
      { name: "at0277", index: 0, status: "pass", secs: 7 },
      { name: "at0339", index: 1, status: "fail", secs: 14, ...red },
    ],
  };
}

async function mountPanel(run: Report) {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { ReportPanel } = await import("../report-panel");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<ReportPanel run={run} state="finished" nowMs={100_000} callFailed />);
  });
  return {
    host,
    unmount: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

describe("a red card's failure", () => {
  test("is drawn whole, with no fold, when it fits the preview", async () => {
    const panel = await mountPanel(finishedRun({ title: "clears", message: "Expected 1\nReceived 0" }));
    const red = panel.host.querySelector('[data-slot="tug-report-panel-red"]');
    expect(red?.querySelector(".tug-report-panel-red-title")?.textContent).toBe("clears");
    expect(red?.querySelector(".tug-report-panel-red-message")?.textContent).toBe("Expected 1\nReceived 0");
    expect(red?.querySelector(".tug-report-panel-red-full")).toBeNull();
    await panel.unmount();
  });

  test("is capped, and the rest waits in a fold, when it is long", async () => {
    const message = Array.from({ length: 200 }, (_, i) => `TUG-NOTE: line ${i} ${"x".repeat(80)}`).join("\n");
    const panel = await mountPanel(finishedRun({ title: "(stopped at the 20s budget, unfinished)", message }));
    const red = panel.host.querySelector('[data-slot="tug-report-panel-red"]');
    const preview = red?.querySelector(".tug-report-panel-red-preview");
    expect(preview).not.toBeNull();
    const shown = preview?.textContent ?? "";
    expect(shown.length).toBeLessThanOrEqual(FAILURE_PREVIEW_CHARS + 2);
    expect(shown.endsWith("…")).toBe(true);
    const fold = red?.querySelector(".tug-report-panel-red-full");
    expect(fold).not.toBeNull();
    expect(fold?.textContent).toContain("Full output");
    expect(fold?.textContent).toContain("201 lines");
    // Closed, the fold holds none of the text: the card is its preview.
    expect(fold?.textContent).not.toContain("line 199");
    await panel.unmount();
  });
});
