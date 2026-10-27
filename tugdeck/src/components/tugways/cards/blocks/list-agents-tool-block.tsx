/**
 * `ListAgentsToolBlock` — Layer-2 wrapper for the `ListAgents` tool.
 *
 * `ListAgents` is the assistant asking who it can `SendMessage` to:
 * the subagents it spawned, teammates, other local Claude sessions,
 * and (when linked) cloud and Remote Control sessions. The input is
 * empty — `channel` and `q` exist in the schema but are not available
 * in this build — and the result is a text listing, one row per
 * agent, each leading with the `name [ref]` that is the address.
 *
 * Composition (Spec S03, [#bk-conformance]):
 *  - `BlockChrome` owns the frame: the tool name, the status stripe,
 *    the inline `SessionCautionBadge`, and the error band.
 *  - **Header** — the name alone; there is no input worth a target.
 *    The trailing `resultSummary` carries the row count once the
 *    listing has arrived.
 *  - **Body** — the listing as a tailed `BlockPre`, which is its
 *    natural shape: the harness formats the rows for a reader.
 *  - **Chrome-level fold + copy** — collapsed by default; the count
 *    in the header is the scan-level answer. Copy collects the
 *    listing.
 *
 * Streaming / error (Spec S03):
 *  - `status === "streaming"` → body is `null`.
 *  - `status === "error"` → chrome paints the error band.
 *  - `status === "ready"` → header + listing.
 *
 * Laws:
 *  - [L06] no React state for appearance.
 *  - [L19] `data-slot="list-agents-tool-block"`. No paired `.css`.
 *  - [L20] no new tokens.
 *
 * Decisions:
 *  - [D05] two-layer hybrid.
 *  - [D101] visibility policy — `listagents` is bespoke.
 *
 * @module components/tugways/cards/blocks/list-agents-tool-block
 */

import React from "react";

import { BlockBody, BlockPre } from "../../blocks/block-bits";
import { BlockChrome } from "../../blocks/block-chrome";
import type { ToolResultSummary } from "../../blocks/tool-result-summary";
import type { ToolBlockProps } from "../../blocks/types";

// ---------------------------------------------------------------------------
// Result reading
// ---------------------------------------------------------------------------

/**
 * Count the agent rows in a `ListAgents` listing. The harness prints
 * one row per agent, each beginning with a list marker (`-` or `*`)
 * or a bullet; lines that do not are the heading, blank spacing, or
 * the "no agents" sentence. Returns `0` for an empty or absent
 * listing — the caller then omits the count badge rather than
 * claiming "0 agents" over text it could not read.
 */
export function countListAgentsRows(textOutput: string | undefined): number {
  if (textOutput === undefined) return 0;
  let count = 0;
  for (const raw of textOutput.split("\n")) {
    const line = raw.trim();
    if (/^(?:[-*•]|\d+[.)])\s+\S/.test(line)) count += 1;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const ListAgentsToolBlock: React.FC<ToolBlockProps> = ({
  textOutput,
  status,
  phase,
  caution,
}) => {
  const hasResult = textOutput !== undefined && textOutput.length > 0;
  const rowCount = status === "error" ? 0 : countListAgentsRows(textOutput);
  const resultSummary: ToolResultSummary | undefined =
    rowCount > 0 ? { kind: "count", count: rowCount, noun: "agent" } : undefined;

  let body: React.ReactNode;
  if (status === "streaming" || !hasResult) {
    body = null;
  } else {
    body = (
      <BlockBody>
        <BlockPre>{textOutput}</BlockPre>
      </BlockBody>
    );
  }

  return (
    <BlockChrome
      rootSlot="list-agents-tool-block"
      toolName="ListAgents"
      resultSummary={resultSummary}
      status={status}
      phase={phase}
      caution={caution}
      notice={
        status === "error" && hasResult
          ? { tone: "error", text: textOutput }
          : undefined
      }
      copyText={hasResult ? textOutput : undefined}
    >
      {body}
    </BlockChrome>
  );
};
