/**
 * `TelemetryInspector` — first inspector tab. Surfaces per-turn
 * telemetry (Step 20.3 fields) for the selected card. Live in-flight
 * clocks tick via `useLifecycleTick`.
 *
 * Data path:
 *   - The card's inspection comes from `telemetryInspectionStore`, read via
 *     `useSyncExternalStore` (per [L02]): the card's own services when this
 *     page holds the card, the relay from its body when it does not.
 *   - Its fields are the public `CodeSessionSnapshot`'s transcript + identity.
 *   - Its state is the internal `CodeSessionState`'s live-clock anchors
 *     (`awaitingApprovalSince`, etc.).
 *   - The projection helper turns both into `(label, value, fieldPath)`
 *     tuples that `FieldRow` renders.
 *
 * Conformance: [L02], [L19], [L20] (reads only `--tugx-devpanel-*`
 * slots), read-only — no mutations of the card session.
 *
 * @module components/devtools/telemetry-inspector
 */

import React, { useCallback } from "react";
import { useSyncExternalStore } from "@/lib/gesture-scope";

import { useLifecycleTick } from "@/lib/code-session-store/hooks/use-lifecycle-tick";
import { telemetryInspectionStore } from "@/lib/telemetry-inspection-store";
import { BlockCopyButton } from "@/components/tugways/body-kinds/affordances/block-copy-button";

import { copyAsJson } from "./copy-as-json";
import { FieldRow } from "./field-row";
import { FieldSection } from "./field-section";

import { projectTelemetryInspector } from "./telemetry-projection";

import "./telemetry.css";

export interface TelemetryInspectorProps {
  selectedCardId: string | null;
}

const NOOP_SUBSCRIBE = (): (() => void) => () => {};

export const TelemetryInspector: React.FC<TelemetryInspectorProps> = ({
  selectedCardId,
}) => {
  // The card's inspection, wherever the card is: the store re-renders the
  // inspector when the card's services appear or go, when a field it draws
  // moves, and when a relayed inspection lands.
  const inspection = useSyncExternalStore(
    useCallback(
      (onChange: () => void) =>
        selectedCardId === null ? NOOP_SUBSCRIBE() : telemetryInspectionStore.subscribe(selectedCardId, onChange),
      [selectedCardId],
    ),
    useCallback(() => (selectedCardId === null ? null : telemetryInspectionStore.read(selectedCardId)), [selectedCardId]),
  );
  const snapshot = inspection?.fields ?? null;

  // Drive the live tick at 1Hz while a turn is in flight. When no
  // services / snapshot is available, fall back to an "idle" phase
  // so the tick stays at zero.
  const phase = snapshot?.phase ?? "idle";
  const tickAt = useLifecycleTick(phase, 1000);

  const internalState = inspection?.state ?? null;

  const sections = projectTelemetryInspector({
    state: internalState,
    transcript: snapshot?.transcript ?? [],
    tickAt,
    tugSessionId: snapshot?.tugSessionId ?? null,
    displayLabel: snapshot?.displayLabel ?? null,
  });

  // The suite's copy affordance: it owns the Copy → Copied flash, which
  // fires only when the write succeeds (`copyAction` resolves `true`).
  const handleCopy = useCallback(async (): Promise<boolean> => {
    const payload = {
      tugSessionId: snapshot?.tugSessionId ?? null,
      displayLabel: snapshot?.displayLabel ?? null,
      phase: snapshot?.phase ?? null,
      transportState: snapshot?.transportState ?? null,
      transcript: snapshot?.transcript ?? [],
      // Surface the internal state's live-clock anchors so a paste
      // captures everything needed to reproduce a given moment.
      internalLiveAnchors: internalState
        ? {
            awaitingApprovalSince: internalState.awaitingApprovalSince,
            awaitingApprovalAccumulatedMs: internalState.awaitingApprovalAccumulatedMs,
            transportNonOnlineSince: internalState.transportNonOnlineSince,
            transportDowntimeAccumulatedMs: internalState.transportDowntimeAccumulatedMs,
            transportReconnectCount: internalState.transportReconnectCount,
            lastStreamEventAt: internalState.lastStreamEventAt,
            maxStreamGapMs: internalState.maxStreamGapMs,
            firstAssistantDeltaAt: internalState.firstAssistantDeltaAt,
            firstToolUseAt: internalState.firstToolUseAt,
            interruptInFlight: internalState.interruptInFlight,
          }
        : null,
      tickAt,
    };
    return copyAsJson(payload);
  }, [snapshot, internalState, tickAt]);

  return (
    <div className="tug-devpanel-inspector tug-devpanel-inspector-telemetry">
      <div className="tug-devpanel-inspector-toolbar">
        <BlockCopyButton
          size="xs"
          emphasis="outlined"
          copyAction={handleCopy}
          disabled={selectedCardId === null}
          aria-label="Copy telemetry as JSON"
        />
      </div>
      {sections.map((section) => (
        <FieldSection key={section.title} title={section.title}>
          {section.rows.map((row) => (
            <FieldRow
              key={`${section.title}/${row.label}`}
              label={row.label}
              value={row.value}
              fieldPath={row.fieldPath}
              hint={row.hint}
            />
          ))}
        </FieldSection>
      ))}
    </div>
  );
};
TelemetryInspector.displayName = "TelemetryInspector";
