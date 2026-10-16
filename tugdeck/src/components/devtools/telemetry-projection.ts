/**
 * Pure-logic projection from `CodeSessionState` (+ a live `now`) into
 * the rows the `TelemetryInspector` renders. Kept separate from the
 * component so tests can pin the (label, value, path) tuples without
 * a renderer.
 *
 * Why a projection layer at all: the inspector's job is to surface
 * every Step 20.3 field — that's 20+ values across 6 sections.
 * Building rows inline in JSX would be hard to test and would mix
 * presentation concerns with field discovery. The projection is the
 * single point of truth for "which fields exist."
 *
 * @module components/devtools/telemetry-projection
 */

import type { TurnEntry } from "@/lib/code-session-store/types";
import type { InspectionState } from "@/lib/telemetry-inspection-store";
import {
  deriveSessionTotals,
  liveTurnActiveMs,
  liveTurnAwaitingApprovalMs,
  liveTurnTransportDowntimeMs,
  liveTurnWallClockMs,
  perTurnContextSize,
} from "@/lib/code-session-store/telemetry";

export interface InspectorRow {
  label: string;
  value: string;
  fieldPath: string;
  hint?: string;
}

export interface InspectorSection {
  title: string;
  rows: ReadonlyArray<InspectorRow>;
}

/**
 * Build the section list for a card. The inspector consumes the
 * public snapshot for stable fields (transcript, identity) and the
 * internal reducer state for live-clock anchors not exposed publicly —
 * the slice an inspection carries, whether read in this page or relayed
 * from the page that holds the card.
 *
 * When `state` is `null` the projection returns a single empty-state
 * section so the inspector renders an explicit "no data" message
 * rather than silent zeros.
 */
export function projectTelemetryInspector(input: {
  state: InspectionState | null;
  transcript: ReadonlyArray<TurnEntry>;
  tickAt: number;
  tugSessionId: string | null;
  displayLabel: string | null;
}): ReadonlyArray<InspectorSection> {
  const { state, transcript, tickAt, tugSessionId, displayLabel } = input;

  if (state === null) {
    return [
      {
        title: "Card",
        rows: [
          {
            label: "Status",
            value: "No card selected.",
            fieldPath: "—",
            hint: "Pick a card in the dropdown above.",
          },
        ],
      },
    ];
  }

  const lastTurn = transcript.length > 0 ? transcript[transcript.length - 1] : null;

  return [
    cardIdentitySection(state, tugSessionId, displayLabel),
    phaseTransportSection(state),
    liveClocksSection(state, tickAt),
    liveCountersSection(state),
    lastCommittedTurnSection(lastTurn),
    sessionTotalsSection(transcript),
  ];
}

// ---------------------------------------------------------------------------
// Section builders
// ---------------------------------------------------------------------------

function cardIdentitySection(
  state: InspectionState,
  tugSessionId: string | null,
  displayLabel: string | null,
): InspectorSection {
  return {
    title: "Card identity",
    rows: [
      {
        label: "Tug session id",
        value: tugSessionId ?? state.tugSessionId,
        fieldPath: "CodeSessionSnapshot.tugSessionId",
      },
      {
        label: "Display label",
        value: displayLabel ?? state.displayLabel,
        fieldPath: "CodeSessionSnapshot.displayLabel",
      },
      {
        label: "Session mode",
        value: state.sessionMode,
        fieldPath: "CodeSessionSnapshot.sessionMode",
      },
    ],
  };
}

function phaseTransportSection(state: InspectionState): InspectorSection {
  return {
    title: "Phase + transport",
    rows: [
      {
        label: "Phase",
        value: state.phase,
        fieldPath: "CodeSessionSnapshot.phase",
      },
      {
        label: "Transport state",
        value: state.transportState,
        fieldPath: "CodeSessionSnapshot.transportState",
      },
      {
        label: "Interrupt in flight",
        value: state.interruptInFlight ? "true" : "false",
        fieldPath: "CodeSessionState.interruptInFlight",
      },
    ],
  };
}

function liveClocksSection(
  state: InspectionState,
  tickAt: number,
): InspectorSection {
  return {
    title: "Live in-flight clocks",
    rows: [
      {
        label: "Wall clock",
        value: formatMs(liveTurnWallClockMs(state, tickAt)),
        fieldPath: "liveTurnWallClockMs(state, tickAt)",
        hint: "now − pendingUserMessage.submitAt",
      },
      {
        label: "Awaiting approval",
        value: formatMs(liveTurnAwaitingApprovalMs(state, tickAt)),
        fieldPath: "liveTurnAwaitingApprovalMs(state, tickAt)",
        hint: "permission + question dialogs",
      },
      {
        label: "Transport downtime",
        value: formatMs(liveTurnTransportDowntimeMs(state, tickAt)),
        fieldPath: "liveTurnTransportDowntimeMs(state, tickAt)",
        hint: "offline + restoring",
      },
      {
        label: "Active",
        value: formatMs(liveTurnActiveMs(state, tickAt)),
        fieldPath: "liveTurnActiveMs(state, tickAt)",
        hint: "wall − awaiting − downtime, clamped ≥ 0",
      },
    ],
  };
}

function liveCountersSection(state: InspectionState): InspectorSection {
  return {
    title: "Live counters",
    rows: [
      {
        label: "Reconnect count",
        value: String(state.transportReconnectCount),
        fieldPath: "CodeSessionState.transportReconnectCount",
      },
      {
        label: "Max stream gap",
        value: formatMs(state.maxStreamGapMs),
        fieldPath: "CodeSessionState.maxStreamGapMs",
      },
      {
        label: "First assistant delta at",
        value:
          state.firstAssistantDeltaAt === null
            ? "null"
            : String(state.firstAssistantDeltaAt),
        fieldPath: "CodeSessionState.firstAssistantDeltaAt",
        hint: "Date.now() of first assistant_text",
      },
      {
        label: "First tool use at",
        value:
          state.firstToolUseAt === null ? "null" : String(state.firstToolUseAt),
        fieldPath: "CodeSessionState.firstToolUseAt",
        hint: "Date.now() of first tool_use",
      },
    ],
  };
}

function lastCommittedTurnSection(turn: TurnEntry | null): InspectorSection {
  if (turn === null) {
    return {
      title: "Last committed TurnEntry",
      rows: [
        {
          label: "Status",
          value: "No committed turns yet.",
          fieldPath: "—",
          hint: "Send a turn to populate this section.",
        },
      ],
    };
  }
  return {
    title: "Last committed TurnEntry",
    rows: [
      {
        label: "msgId",
        value: turn.msgId,
        fieldPath: "TurnEntry.msgId",
      },
      {
        label: "turnEndReason",
        value: turn.turnEndReason,
        fieldPath: "TurnEntry.turnEndReason",
      },
      {
        label: "wallClockMs",
        value: formatMs(turn.wallClockMs),
        fieldPath: "TurnEntry.wallClockMs",
      },
      {
        label: "awaitingApprovalMs",
        value: formatMs(turn.awaitingApprovalMs),
        fieldPath: "TurnEntry.awaitingApprovalMs",
      },
      {
        label: "transportDowntimeMs",
        value: formatMs(turn.transportDowntimeMs),
        fieldPath: "TurnEntry.transportDowntimeMs",
      },
      {
        label: "activeMs",
        value: formatMs(turn.activeMs),
        fieldPath: "TurnEntry.activeMs",
        hint: "wall − awaiting − downtime",
      },
      {
        label: "ttftMs",
        value: turn.ttftMs === null ? "null" : formatMs(turn.ttftMs),
        fieldPath: "TurnEntry.ttftMs",
      },
      {
        label: "ttftcMs",
        value: turn.ttftcMs === null ? "null" : formatMs(turn.ttftcMs),
        fieldPath: "TurnEntry.ttftcMs",
      },
      {
        label: "reconnectCount",
        value: String(turn.reconnectCount),
        fieldPath: "TurnEntry.reconnectCount",
      },
      {
        label: "maxStreamGapMs",
        value: formatMs(turn.maxStreamGapMs),
        fieldPath: "TurnEntry.maxStreamGapMs",
      },
      {
        label: "Context size (this turn)",
        value: String(perTurnContextSize(turn)),
        fieldPath: "perTurnContextSize(turn)",
        hint: "input + cache_read + cache_creation",
      },
      {
        label: "cost.inputTokens",
        value: String(turn.cost.inputTokens),
        fieldPath: "TurnEntry.cost.inputTokens",
      },
      {
        label: "cost.outputTokens",
        value: String(turn.cost.outputTokens),
        fieldPath: "TurnEntry.cost.outputTokens",
      },
      {
        label: "cost.cacheCreationInputTokens",
        value: String(turn.cost.cacheCreationInputTokens),
        fieldPath: "TurnEntry.cost.cacheCreationInputTokens",
      },
      {
        label: "cost.cacheReadInputTokens",
        value: String(turn.cost.cacheReadInputTokens),
        fieldPath: "TurnEntry.cost.cacheReadInputTokens",
      },
      {
        label: "cost.totalCostUsd",
        value: formatUsd(turn.cost.totalCostUsd),
        fieldPath: "TurnEntry.cost.totalCostUsd",
      },
    ],
  };
}

function sessionTotalsSection(
  transcript: ReadonlyArray<TurnEntry>,
): InspectorSection {
  const totals = deriveSessionTotals(transcript);
  return {
    title: "Session totals",
    rows: [
      {
        label: "Turn count",
        value: String(totals.turnCount),
        fieldPath: "deriveSessionTotals(transcript).turnCount",
      },
      {
        label: "Total wall clock",
        value: formatMs(totals.totalWallClockMs),
        fieldPath: "deriveSessionTotals(transcript).totalWallClockMs",
      },
      {
        label: "Total awaiting approval",
        value: formatMs(totals.totalAwaitingApprovalMs),
        fieldPath: "deriveSessionTotals(transcript).totalAwaitingApprovalMs",
      },
      {
        label: "Total transport downtime",
        value: formatMs(totals.totalTransportDowntimeMs),
        fieldPath: "deriveSessionTotals(transcript).totalTransportDowntimeMs",
      },
      {
        label: "Total active",
        value: formatMs(totals.totalActiveMs),
        fieldPath: "deriveSessionTotals(transcript).totalActiveMs",
      },
      {
        label: "Total input tokens",
        value: String(totals.totalInputTokens),
        fieldPath: "deriveSessionTotals(transcript).totalInputTokens",
      },
      {
        label: "Total output tokens",
        value: String(totals.totalOutputTokens),
        fieldPath: "deriveSessionTotals(transcript).totalOutputTokens",
      },
      {
        label: "Total cache read tokens",
        value: String(totals.totalCacheReadTokens),
        fieldPath: "deriveSessionTotals(transcript).totalCacheReadTokens",
      },
      {
        label: "Total cache creation tokens",
        value: String(totals.totalCacheCreationTokens),
        fieldPath: "deriveSessionTotals(transcript).totalCacheCreationTokens",
      },
      {
        label: "Total cost",
        value: formatUsd(totals.totalCostUsd),
        fieldPath: "deriveSessionTotals(transcript).totalCostUsd",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  const seconds = Math.floor(ms / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

export function formatUsd(value: number): string {
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(6)}`;
  if (value < 1) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}
