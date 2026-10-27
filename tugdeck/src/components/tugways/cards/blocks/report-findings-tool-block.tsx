/**
 * `ReportFindingsToolBlock` — Layer-2 wrapper for the `ReportFindings`
 * tool.
 *
 * `ReportFindings` is how a code review hands its verified findings to
 * the host as data rather than prose: one call, the findings ranked
 * most-severe first, each anchored to a file and line. The call IS
 * the review's output — the input carries everything the user reads,
 * and the result is a one-line acknowledgement. So unlike every other
 * wrapper the body is built from the *input*, and the block mounts
 * expanded (`tool-collapse-defaults`): the user reads and acts on it
 * the way they do the `AskUserQuestion` artifact.
 *
 * Input shape (v2.1.311): `{ findings: Finding[], level? }` where a
 * `Finding` is `{ file, summary, failure_scenario, line?, category?,
 * short_summary?, verdict?, outcome? }`.
 *
 * Composition (Spec S03, [#bk-conformance]):
 *  - `BlockChrome` owns the frame: the tool name, the status stripe,
 *    the inline `SessionCautionBadge`, and the error band.
 *  - **Header** — the name; the args slot carries the effort level
 *    when one was given; the trailing `resultSummary` is the finding
 *    count ("3 findings"), present in both collapse states.
 *  - **Body** — one stacked `BlockFieldRow` per finding, labelled by
 *    rank: the anchor (`file:line`) as a `<code>`, the summary, a
 *    muted meta line (category · verdict · outcome, whichever are
 *    present), and the failure scenario as a `BlockPre`. An empty
 *    findings list renders the sentence a reviewer would write.
 *  - **Chrome-level fold + copy** — expanded by default. Copy
 *    collects a plain-text rendering of the findings.
 *
 * Streaming / error (Spec S03):
 *  - `status === "streaming"` → body is `null`.
 *  - `status === "error"` → chrome paints the error band; the
 *    findings still render (they are the input, not the result).
 *  - `status === "ready"` → header + findings.
 *
 * Laws:
 *  - [L06] no React state for appearance.
 *  - [L19] `data-slot="report-findings-tool-block"`. No paired `.css`.
 *  - [L20] no new tokens.
 *
 * Decisions:
 *  - [D05] two-layer hybrid.
 *  - [D101] visibility policy — `reportfindings` is bespoke.
 *
 * @module components/tugways/cards/blocks/report-findings-tool-block
 */

import React from "react";

import { TugTooltip } from "@/components/tugways/tug-tooltip";

import {
  BlockBody,
  BlockFieldRow,
  BlockPre,
} from "../../blocks/block-bits";
import { BlockChrome } from "../../blocks/block-chrome";
import type { ToolResultSummary } from "../../blocks/tool-result-summary";
import type { ToolBlockProps } from "../../blocks/types";

// ---------------------------------------------------------------------------
// Wire-shape narrowing
// ---------------------------------------------------------------------------

/** One verified finding, as the review reported it. */
export interface ReportedFinding {
  file: string;
  summary: string;
  failure_scenario?: string;
  line?: number;
  category?: string;
  short_summary?: string;
  verdict?: string;
  outcome?: string;
}

/** `ReportFindings` tool input (from `tool_use.input`). */
export interface ReportFindingsInput {
  findings: ReportedFinding[];
  level?: string;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Narrow the wrapper-side `unknown` input to `ReportFindingsInput`.
 * Defensive: a non-object input or a missing / non-array `findings`
 * yields an empty list; an entry without a string `file` and
 * `summary` is dropped, since without both there is nothing to
 * anchor or to say; every optional field is kept only when it is a
 * non-empty string (or, for `line`, a finite number).
 */
export function narrowReportFindingsInput(value: unknown): ReportFindingsInput {
  if (value === null || typeof value !== "object") return { findings: [] };
  const v = value as Record<string, unknown>;
  const findings: ReportedFinding[] = [];
  if (Array.isArray(v.findings)) {
    for (const raw of v.findings) {
      if (raw === null || typeof raw !== "object") continue;
      const f = raw as Record<string, unknown>;
      const file = optionalString(f.file);
      const summary = optionalString(f.summary);
      if (file === undefined || summary === undefined) continue;
      findings.push({
        file,
        summary,
        failure_scenario: optionalString(f.failure_scenario),
        line:
          typeof f.line === "number" && Number.isFinite(f.line)
            ? f.line
            : undefined,
        category: optionalString(f.category),
        short_summary: optionalString(f.short_summary),
        verdict: optionalString(f.verdict),
        outcome: optionalString(f.outcome),
      });
    }
  }
  return { findings, level: optionalString(v.level) };
}

// ---------------------------------------------------------------------------
// Composition helpers
// ---------------------------------------------------------------------------

/** `file:line` when a line is known, else the bare file. */
export function composeFindingAnchor(finding: ReportedFinding): string {
  return finding.line !== undefined
    ? `${finding.file}:${finding.line}`
    : finding.file;
}

/**
 * The muted meta line under a finding — `category · verdict · outcome`
 * over whichever are present, `undefined` when none are.
 */
export function composeFindingMeta(finding: ReportedFinding): string | undefined {
  const parts = [finding.category, finding.verdict, finding.outcome].filter(
    (part): part is string => part !== undefined,
  );
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * Plain-text rendering of the whole report — what Copy writes. One
 * numbered paragraph per finding: anchor, summary, meta, scenario.
 */
export function formatReportFindingsText(input: ReportFindingsInput): string {
  if (input.findings.length === 0) return "No findings.";
  return input.findings
    .map((finding, index) => {
      const lines = [
        `${index + 1}. ${composeFindingAnchor(finding)} — ${finding.summary}`,
      ];
      const meta = composeFindingMeta(finding);
      if (meta !== undefined) lines.push(`   ${meta}`);
      if (finding.failure_scenario !== undefined) {
        lines.push(`   ${finding.failure_scenario}`);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const ReportFindingsToolBlock: React.FC<ToolBlockProps> = ({
  input,
  textOutput,
  status,
  phase,
  caution,
}) => {
  const report = React.useMemo(() => narrowReportFindingsInput(input), [input]);

  const argsSummary =
    report.level !== undefined ? (
      <TugTooltip content={report.level} side="bottom" truncated>
        <code
          data-slot="report-findings-tool-block-target"
          data-tugx-findable=""
          className="tool-call-header-clamp"
        >
          {report.level}
        </code>
      </TugTooltip>
    ) : undefined;

  const resultSummary: ToolResultSummary | undefined =
    status === "streaming"
      ? undefined
      : { kind: "count", count: report.findings.length, noun: "finding" };

  let body: React.ReactNode;
  if (status === "streaming") {
    body = null;
  } else {
    body = renderFindingsBody(report);
  }

  return (
    <BlockChrome
      rootSlot="report-findings-tool-block"
      toolName="ReportFindings"
      argsSummary={argsSummary}
      resultSummary={resultSummary}
      status={status}
      phase={phase}
      caution={caution}
      notice={
        status === "error" && textOutput !== undefined && textOutput.length > 0
          ? { tone: "error", text: textOutput }
          : undefined
      }
      copyText={() => formatReportFindingsText(report)}
    >
      {body}
    </BlockChrome>
  );
};

function renderFindingsBody(report: ReportFindingsInput): React.ReactNode {
  if (report.findings.length === 0) {
    return (
      <BlockBody>
        <BlockPre>No findings.</BlockPre>
      </BlockBody>
    );
  }
  return (
    <BlockBody>
      {report.findings.map((finding, index) => {
        const meta = composeFindingMeta(finding);
        return (
          <BlockFieldRow
            key={`${index}-${finding.file}`}
            label={String(index + 1)}
            layout="stacked"
          >
            <div data-slot="report-findings-tool-block-finding">
              <div>
                <code data-slot="report-findings-tool-block-anchor">
                  {composeFindingAnchor(finding)}
                </code>{" "}
                <span data-slot="report-findings-tool-block-summary">
                  {finding.summary}
                </span>
              </div>
              {meta !== undefined ? (
                <div data-slot="report-findings-tool-block-meta">
                  <code>{meta}</code>
                </div>
              ) : null}
              {finding.failure_scenario !== undefined ? (
                <BlockPre>{finding.failure_scenario}</BlockPre>
              ) : null}
            </div>
          </BlockFieldRow>
        );
      })}
    </BlockBody>
  );
}
