/**
 * `LogRow` — one row in the Log inspector list.
 *
 * Layout: timestamp · level chip · source tag · message · (optional
 * data toggle). Visual vocabulary is delegated to `TugLabel`; the
 * level chip is the one bit of custom paint, sourced from
 * `--tugx-devlog-*` slots declared in `log-inspector.css`.
 *
 * Conformance: [L19] small focused component. [L20] reads only
 * `--tugx-devlog-*` slots for the chip + tag styling; `TugLabel`
 * owns its own token family for the message text.
 *
 * @module components/devtools/log-row
 */

import React, { useState } from "react";

import { TugLabel } from "@/components/tugways/tug-label";

import type { TugDevLogEntry } from "@/lib/tug-dev-log-store/types";

export interface LogRowProps {
  entry: TugDevLogEntry;
}

/**
 * Format a `Date.now()` timestamp as `HH:MM:SS.mmm` in the local
 * timezone. Stable width for column alignment.
 */
function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

function formatData(data: unknown): string {
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

export const LogRow: React.FC<LogRowProps> = ({ entry }) => {
  // Expandable data pane is per-row local state — the data is the same
  // entry reference across renders, so collapse/expand only affects
  // this row's DOM, not the store. Cleared on unmount when the entry
  // rolls out of the buffer (correct: a rolled-out entry can't be
  // expanded again).
  const [expanded, setExpanded] = useState(false);
  const hasData = entry.data !== undefined;

  return (
    <div
      className="tug-devlog-row"
      data-level={entry.level}
      data-expanded={expanded ? "true" : "false"}
    >
      <div className="tug-devlog-row-line">
        <TugLabel
          size="3xs"
          mono
          emphasis="calm"
          className="tug-devlog-row-time"
        >
          {formatTimestamp(entry.timestamp)}
        </TugLabel>
        <span
          className="tug-devlog-row-level"
          data-level={entry.level}
          aria-label={`level: ${entry.level}`}
        >
          {entry.level}
        </span>
        <TugLabel
          size="3xs"
          mono
          emphasis="calm"
          className="tug-devlog-row-source"
        >
          {entry.source}
        </TugLabel>
        <TugLabel size="xs" className="tug-devlog-row-message">
          {entry.message}
        </TugLabel>
        {hasData ? (
          <button
            type="button"
            className="tug-devlog-row-toggle"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-label={expanded ? "Collapse data" : "Expand data"}
          >
            {expanded ? "−" : "+"}
          </button>
        ) : null}
      </div>
      {expanded && hasData ? (
        <pre className="tug-devlog-row-data">{formatData(entry.data)}</pre>
      ) : null}
    </div>
  );
};
LogRow.displayName = "LogRow";
