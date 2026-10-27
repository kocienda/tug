/**
 * Pure-logic tests for `ReportFindingsToolBlock`'s wire-narrowing,
 * anchor / meta / copy-text composition, and the dispatch registration
 * pin (`reportfindings` → `ReportFindingsToolBlock`).
 *
 * @module components/tugways/cards/blocks/__tests__/report-findings-tool-block
 */

import { describe, expect, test } from "bun:test";

import {
  ReportFindingsToolBlock,
  composeFindingAnchor,
  composeFindingMeta,
  formatReportFindingsText,
  narrowReportFindingsInput,
} from "../report-findings-tool-block";
import { BESPOKE_FACTORY_BY_NAME } from "../../session-assistant-renderer-registrations";

const finding = {
  file: "src/a.ts",
  line: 12,
  summary: "Null deref on empty list",
  failure_scenario: "[] in → crash",
  category: "correctness",
  verdict: "CONFIRMED",
  outcome: "fixed",
};

describe("narrowReportFindingsInput", () => {
  test("keeps well-formed findings and the level", () => {
    expect(
      narrowReportFindingsInput({ findings: [finding], level: "high" }),
    ).toEqual({
      findings: [{ ...finding, short_summary: undefined }],
      level: "high",
    });
  });

  test("drops a finding without a file or a summary, keeps the rest", () => {
    const out = narrowReportFindingsInput({
      findings: [{ file: "x.ts" }, { summary: "no file" }, finding, null, 3],
    });
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]?.file).toBe("src/a.ts");
  });

  test("a non-finite line is dropped", () => {
    const out = narrowReportFindingsInput({
      findings: [{ ...finding, line: Number.NaN }],
    });
    expect(out.findings[0]?.line).toBeUndefined();
  });

  test("a non-object input or missing findings is an empty report", () => {
    expect(narrowReportFindingsInput(null)).toEqual({ findings: [] });
    expect(narrowReportFindingsInput({ level: "low" })).toEqual({
      findings: [],
      level: "low",
    });
  });
});

describe("composeFindingAnchor / composeFindingMeta", () => {
  test("file:line when a line is known, else the file", () => {
    expect(composeFindingAnchor(finding)).toBe("src/a.ts:12");
    expect(composeFindingAnchor({ ...finding, line: undefined })).toBe("src/a.ts");
  });

  test("meta joins whichever of category, verdict, outcome are present", () => {
    expect(composeFindingMeta(finding)).toBe("correctness · CONFIRMED · fixed");
    expect(composeFindingMeta({ file: "f", summary: "s", verdict: "PLAUSIBLE" })).toBe(
      "PLAUSIBLE",
    );
    expect(composeFindingMeta({ file: "f", summary: "s" })).toBeUndefined();
  });
});

describe("formatReportFindingsText", () => {
  test("one numbered paragraph per finding", () => {
    expect(formatReportFindingsText({ findings: [finding] })).toBe(
      [
        "1. src/a.ts:12 — Null deref on empty list",
        "   correctness · CONFIRMED · fixed",
        "   [] in → crash",
      ].join("\n"),
    );
  });

  test("an empty report says so", () => {
    expect(formatReportFindingsText({ findings: [] })).toBe("No findings.");
  });
});

describe("dispatch registration", () => {
  test("reportfindings → ReportFindingsToolBlock", () => {
    expect(BESPOKE_FACTORY_BY_NAME.get("reportfindings")).toBe(
      ReportFindingsToolBlock,
    );
  });
});
