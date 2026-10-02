/**
 * `AiChip` — the Z4B composite AI settings chip.
 *
 * One chip where three stood: `MODE`, `AI MODEL`, and `EFFORT` were three
 * faces of one question — how the AI runs — and three chips plus three pickers
 * is chrome, not information. This is a two-line `TugPushButton` carrying an
 * `AI Model Settings` caption over `Fable 5 · High · Auto` (model · effort ·
 * mode), and pressing it opens the one mixer sheet ([ai-config-sheet.tsx]).
 * The Claude Code version chip stands beside it, unmerged
 * ([session-route-indicator-badge.tsx]) — it reports the runtime, not a
 * setting, so it keeps its own face, changelog click, and drift report.
 *
 * **Nothing is lost in the merge.** Each value resolves through the same single
 * helper its old chip used — `resolveModelLabel`, `resolveEffortDisplay`,
 * `resolvePermissionMode` — so the composite reads byte-identically to the
 * faces it replaces, with the effort token OMITTED (not dashed) when the model
 * supports none. Right-click keeps the value chips' copy affordance
 * (`useCopyableButton`), now covering the whole composition in one string.
 *
 * **It sizes to what it says.** The chip is deliberately NOT width-stabilized:
 * stabilization exists to stop a row of chips from shuffling sideways when one
 * of them changes, and the collapse left Z4B with two. With nothing downstream
 * to push around, a fixed width bought only a permanent margin of empty chip,
 * so the face is a plain span and the button is as wide as the settings it is
 * reporting.
 *
 * Laws: [L02] every value enters through `useSyncExternalStore` on the
 *       metadata store; [L06] no React state for appearance — the copy menu's
 *       disclosure belongs to `useCopyableButton`'s popover; [L19]/[L20]
 *       composes `TugPushButton` and `TugActionTooltip`, each keeping its own
 *       tokens.
 *
 * @module components/tugways/cards/ai-chip
 */

import "./ai-chip.css";

import React from "react";
import { useSyncExternalStore } from "@/lib/gesture-scope";

import { TugPushButton } from "@/components/tugways/tug-push-button";
import { TugActionTooltip } from "@/components/tugways/tug-action-tooltip";
import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { useCopyableButton } from "@/components/tugways/use-copyable-text";
import type { ReadableMetadataStore } from "@/lib/session-metadata-store";
import { useTugbankValue } from "@/lib/use-tugbank-value";
import { readModelCatalog } from "@/lib/model-catalog";
import { knownModelRows, resolveModelLabel } from "@/lib/model-label";
import { formatEffortLabel, resolveEffortDisplay } from "@/lib/effort";
import {
  PERMISSION_MODE_DOMAIN,
  formatPermissionMode,
  parsePersistedPermissionMode,
  resolvePermissionMode,
} from "@/lib/permission-mode";
import { formatAiConfigSummary } from "@/lib/ai-config";

export interface AiChipProps {
  /**
   * The card whose persisted permission mode pre-populates the mode token
   * before the live `system_metadata` round-trips ([D07]). **Omit for the
   * defaults context** (Settings → Assistant): with no card behind the chip
   * there is no per-card value, so the store's mode — the deck default —
   * stands alone.
   */
  cardId?: string;
  /** Metadata store supplying model, effort, and permission mode. */
  sessionMetadataStore: ReadableMetadataStore;
  /** Open the shared mixer sheet — the same opener `/ai` routes to. */
  onOpenSheet: () => void;
  /** Dim + disable the chip (e.g. on the Shell route). */
  disabled?: boolean;
  /** Author the chip into a focus group ([P02]). */
  focusGroup?: string;
  /** Order within {@link focusGroup}. */
  focusOrder?: number;
}

/**
 * The composite Z4B settings chip. See the module docstring for what it
 * absorbed and where the Claude Code chip's duties stayed.
 */
export function AiChip({
  cardId,
  sessionMetadataStore,
  onOpenSheet,
  disabled,
  focusGroup,
  focusOrder,
}: AiChipProps): React.ReactElement {
  const snapshot = useSyncExternalStore(
    sessionMetadataStore.subscribe,
    sessionMetadataStore.getSnapshot,
  );

  // Per-card persisted mode — the pre-population fallback before the live
  // round-trip ([D07]). In the defaults context the read misses and the
  // fallback is forced null, so the store's mode wins.
  const persistedMode = useTugbankValue<string | null>(
    PERMISSION_MODE_DOMAIN,
    cardId ?? "",
    parsePersistedPermissionMode,
    null,
  );

  // ---- The composite value ----

  const rows = knownModelRows(snapshot.models, readModelCatalog());
  const modelLabel = resolveModelLabel(snapshot.model, rows);
  const effortDisplay = resolveEffortDisplay(
    snapshot.models,
    snapshot.model,
    snapshot.effort,
    readModelCatalog(),
  );
  const mode = resolvePermissionMode(
    snapshot.permissionMode,
    cardId === undefined ? null : persistedMode,
  );

  const value = formatAiConfigSummary({
    modelLabel,
    effortLabel: effortDisplay.supported
      ? formatEffortLabel(effortDisplay.level)
      : null,
    modeLabel: formatPermissionMode(mode),
  });

  // The hover names the exact model — the chip's face is abbreviated and the
  // resolved id is what a reader is actually checking.
  const tooltip =
    snapshot.model !== null
      ? snapshot.model
      : modelLabel !== null
        ? `${modelLabel} — exact model resolves on the first turn`
        : "Model not reported by the session";

  const copy = useCopyableButton(`AI Model Settings: ${value}`);

  return (
    <>
      <TugActionTooltip
        action={`${TUG_ACTIONS.RUN_SLASH_COMMAND}:ai`}
        content={tooltip}
      >
        <TugPushButton
          ref={copy.ref as React.Ref<HTMLButtonElement>}
          onContextMenu={copy.onContextMenu}
          layout="label-top"
          label="AI Model Settings"
          size="sm"
          emphasis="tinted"
          role="action"
          className="ai-chip"
          data-slot="ai-chip"
          aria-label="AI Model Settings"
          disabled={disabled}
          focusGroup={focusGroup}
          focusOrder={focusOrder}
          // Wrapped, not passed through: the button hands its click event to
          // the handler, and the opener's first parameter is a row name.
          onClick={() => onOpenSheet()}
        >
          <span data-slot="ai-chip-value">{value}</span>
        </TugPushButton>
      </TugActionTooltip>
      {copy.contextMenu}
    </>
  );
}
