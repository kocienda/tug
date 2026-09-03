/**
 * ai-config-sheet.tsx — the one sheet that configures how the AI runs.
 *
 * Model, reasoning effort, and permission mode used to be three chips opening
 * three confirm-style pickers. They are one thought — "how should Claude run
 * for this session?" — and this sheet is that thought's single surface.
 *
 * **What is in it is not its own.** The body is {@link AiConfigEditor} — the
 * readout, the scope line, and the three channels — the same component the
 * Settings card's AI Model box shows. This module is the sheet *around* it: the
 * title, the doors, and the transaction.
 *
 * **It is a transaction.** Nothing reaches the wire until OK. That matters
 * here specifically because an effort change costs a claude respawn: browsing
 * options must never bounce the process, and holding the change until OK is
 * what lets a model + effort pick collapse into ONE respawn carrying both
 * flags ({@link computeAiConfigCommit}). Cancel and Escape send nothing at all.
 * The Settings panel drives the same channels with no transaction at all — it
 * writes deck defaults live, which cost nothing to change — so the transaction
 * is this sheet's disposition, not the controls'.
 *
 * **The executor is injected.** `onCommit` receives the ordered action array
 * and answers whether it applied — so the session card can re-check the
 * turn-idle guard and refuse (leaving the sheet open with its pending values
 * rather than closing on a commit that did nothing).
 *
 * **⌃⌘I is a toggle.** The chord that opens the sheet closes it again while it
 * is up, dismissing rather than committing — the same two-halved arrangement
 * the usage panel carries for ⌃⌘U: the opener answers the press when it
 * reaches the card, the mounted body answers it off the chain when it does
 * not. Re-presenting instead would swap the sheet for a fresh instance and
 * replay its entrance, which reads as a judder rather than as a command.
 *
 * **Choosing is free; committing is not.** Every control selects *live* into
 * the sheet's pending state — arrows audition a value and the readout and the
 * channel's own description follow at once — because inside a transaction a
 * selection has no side effect to defer ([P24]'s deferred form is for controls
 * whose selection acts). Only OK sends anything.
 *
 * Compositional component — composes `TugSheet`, `AiConfigEditor`, and
 * `TugPushButton`; its own CSS is the doors' column. Composed children keep
 * their own tokens [L20].
 *
 * Laws: [L02] store state is read through the store API; [L06] no React state
 *       for appearance (the pending SELECTION is dialog-local data, not
 *       appearance, so it is ordinary `useState`); [L07] the open-time baseline
 *       is read fresh from the store, never from a render closure; [L11] every
 *       control emits through the responder chain and none has a change
 *       callback; [L19]/[L20] composed `Tug*` components.
 *
 * @module components/tugways/cards/ai-config-sheet
 */

import "./ai-config-sheet.css";

import React, { useCallback, useEffect, useRef, useState } from "react";

import { TUG_ACTIONS } from "@/components/tugways/action-vocabulary";
import { useResponderChain } from "@/components/tugways/responder-chain-provider";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { useSeedKeyView } from "@/components/tugways/use-focusable";
import type { ShowSheetOptions } from "@/components/tugways/tug-sheet";
import type { ReadableMetadataStore } from "@/lib/session-metadata-store";
import { readModelCatalog } from "@/lib/model-catalog";
import {
  AI_CONFIG_ROW_COUNT,
  AI_CONFIG_ROW_OFFSET,
  AiConfigEditor,
} from "./ai-config-editor";
import {
  PERMISSION_MODE_DOMAIN,
  parsePersistedPermissionMode,
} from "@/lib/permission-mode";
import { getTugbankClient } from "@/lib/tugbank-singleton";
import { useTugbankValue } from "@/lib/use-tugbank-value";
import {
  AI_CONFIG_DEFAULT_ROW,
  AI_CONFIG_DOMAIN,
  AI_CONFIG_LAST_ROW_KEY,
  AI_CONFIG_UNKNOWN_MODEL,
  computeAiConfigCommit,
  parseAiConfigRow,
  resolveAiConfigSources,
  type AiConfigAction,
  type AiConfigBaseline,
  type AiConfigRow,
  type AiConfigSources,
} from "@/lib/ai-config";
import { MODAL_REST_LINE } from "./modal-rest-line";

/** Focus orders within the sheet's own group: rows, then the action buttons. */
const CANCEL_FOCUS_ORDER = AI_CONFIG_ROW_COUNT;
const OK_FOCUS_ORDER = AI_CONFIG_ROW_COUNT + 1;

// ---------------------------------------------------------------------------
// Sticky row
// ---------------------------------------------------------------------------

/**
 * Remember the row the user actually changed, so the sheet opens focused where
 * the habit is. Optimistic local-cache write (so readers reflect instantly)
 * plus a PUT to the defaults endpoint — the shape the three per-setting hooks
 * already use. A PUT failure logs and otherwise vanishes: the cache holds for
 * the session and a fresh load falls back to the default row.
 */
function writeStickyRow(row: AiConfigRow): void {
  const client = getTugbankClient();
  if (client !== null) {
    client.setLocalValue(AI_CONFIG_DOMAIN, AI_CONFIG_LAST_ROW_KEY, {
      kind: "string",
      value: row,
    });
  }
  fetch(`/api/defaults/${AI_CONFIG_DOMAIN}/${AI_CONFIG_LAST_ROW_KEY}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "string", value: row }),
  }).catch((err) => {
    console.warn("[ai-config] lastRow PUT failed:", err);
  });
}

// ---------------------------------------------------------------------------
// useAiConfigSheet — the shared, card-hosted mixer sheet
// ---------------------------------------------------------------------------

/** Args for {@link useAiConfigSheet}. */
export interface UseAiConfigSheetArgs {
  /**
   * The card whose persisted permission mode pre-populates the baseline.
   */
  cardId?: string;
  /**
   * Metadata store supplying the model list, the resolved model, the effort
   * override, and the live permission mode.
   */
  sessionMetadataStore: ReadableMetadataStore;
  /**
   * The card's shared sheet host (`useTugSheet().showSheet`). Routing every
   * card sheet through one host means opening this one replaces any other open
   * sheet instead of stacking a second.
   */
  showSheet: (options: ShowSheetOptions) => Promise<string | undefined>;
  /**
   * Apply the committed actions **in array order**, answering whether they
   * were applied. `false` keeps the sheet open with its pending values — the
   * session card returns it when the turn-idle guard refuses, so a commit that
   * did nothing never looks like one that succeeded.
   */
  onCommit: (actions: AiConfigAction[]) => boolean;
  /**
   * One line saying **whose** settings these are, under the readout.
   */
  scopeNote: string;
  /**
   * Extra content below the rows — the session context's rules-editor door and
   * Claude Code version line.
   */
  renderFooter?: (close: () => void) => React.ReactNode;
  /**
   * What a committed change does to an enclosing focus cycle ([P15]) —
   * forwarded to the sheet. `"relinquish"` exits cycling (caret to the
   * prompt); `"retain"` keeps cycling (ring back on the chip).
   */
  commitDisposition?: "retain" | "relinquish";
}

/** Imperative handle to the card-hosted AI configuration sheet. */
export interface AiConfigSheetController {
  /**
   * Present the sheet, reading the baseline fresh from the store ([L07]) — or,
   * when this sheet is the one already showing, dismiss it. `/ai` and ⌃⌘I are
   * the same door in both directions, as `/usage` and ⌃⌘U are.
   *
   * `focusRow` deep-links the keyboard ring to a named row (`/model`,
   * `/effort`, `/mode`); omitted, the ring lands on the sticky row.
   */
  openAiConfigSheet: (focusRow?: AiConfigRow) => void;
}

/**
 * Own the mixer sheet once at the card level, so the AI chip, `/ai`, and the
 * three deep-link slash commands all present the *same* sheet.
 */
export function useAiConfigSheet({
  cardId,
  sessionMetadataStore,
  showSheet,
  onCommit,
  scopeNote,
  renderFooter,
  commitDisposition,
}: UseAiConfigSheetArgs): AiConfigSheetController {
  // The pre-population fallback before the first `system_metadata` round-trip
  // on a fresh card mount ([D07]), matching what the chip displays.
  const persistedMode = useTugbankValue<string | null>(
    PERMISSION_MODE_DOMAIN,
    cardId ?? "",
    parsePersistedPermissionMode,
    null,
  );

  const stickyRow = useTugbankValue<AiConfigRow | null>(
    AI_CONFIG_DOMAIN,
    AI_CONFIG_LAST_ROW_KEY,
    parseAiConfigRow,
    null,
  );

  // Is *this* sheet the one currently mounted, and how do we close it? The
  // shared sheet host is single-slot, so `showSheet`'s promise resolving is the
  // authoritative "no longer showing" signal — it fires on OK, on Cancel, on
  // Escape, and on another sheet superseding this one. `closeRef` is the body's
  // own `close` callback, registered while it is mounted. This is the half of
  // the ⌃⌘I toggle that runs when the command DOES reach the card; the body
  // carries the other half for when it does not.
  const shownRef = useRef(false);
  const closeRef = useRef<(() => void) | null>(null);

  const openAiConfigSheet = useCallback(
    (focusRow?: AiConfigRow) => {
      // Already up: this door closes it. Without this a second ⌃⌘I called
      // `showSheet` again, and the single-slot host answers that by swapping
      // the mounted sheet for a fresh instance — the same panel, re-entering,
      // which reads as a judder rather than as a command.
      if (shownRef.current) {
        closeRef.current?.();
        return;
      }

      // One reading of the session, shared with the Settings card's AI Model
      // box — the sheet freezes it as its baseline, that panel re-reads it
      // every render.
      const sources = resolveAiConfigSources(
        sessionMetadataStore.getSnapshot(),
        readModelCatalog(),
        cardId === undefined ? null : persistedMode,
      );

      shownRef.current = true;
      void showSheet({
        title: "AI Model Settings",
        icon: "Sparkles",
        iconRole: "agent",
        // Accordion rows that pair a model name with its scope note and
        // controls — a single column, and a narrow one: nothing inside asks for
        // more than the decision width.
        displayWidth: "sm",
        onCommitDisposition: commitDisposition,
        presentation: "rise",
        bottomAnchorSelector: MODAL_REST_LINE,
        content: (close) => (
          <AiConfigSheetBody
            sources={sources}
            openRow={focusRow ?? stickyRow ?? AI_CONFIG_DEFAULT_ROW}
            onCommit={onCommit}
            scopeNote={scopeNote}
            renderFooter={renderFooter}
            registerClose={closeRef}
            close={() => close()}
          />
        ),
      }).then(() => {
        shownRef.current = false;
        closeRef.current = null;
      });
    },
    [
      showSheet,
      sessionMetadataStore,
      cardId,
      persistedMode,
      stickyRow,
      onCommit,
      renderFooter,
      commitDisposition,
    ],
  );

  return { openAiConfigSheet };
}

// ---------------------------------------------------------------------------
// Sheet body
// ---------------------------------------------------------------------------

interface AiConfigSheetBodyProps {
  /**
   * The session as it read at open time: the channels' options, and the triple
   * that is the commit diff's baseline. Frozen for the sheet's lifetime — a
   * transaction diffs against the state it opened on.
   */
  sources: AiConfigSources;
  /** The row the keyboard ring lands on. */
  openRow: AiConfigRow;
  /** Apply the ordered actions; `false` keeps the sheet open. */
  onCommit: (actions: AiConfigAction[]) => boolean;
  /** Whose settings these are — see {@link UseAiConfigSheetArgs.scopeNote}. */
  scopeNote: string;
  renderFooter?: (close: () => void) => React.ReactNode;
  /** The opener's handle on this body's dismissal — see {@link useAiConfigSheet}. */
  registerClose: React.MutableRefObject<(() => void) | null>;
  close: () => void;
}

function AiConfigSheetBody({
  sources,
  openRow,
  onCommit,
  scopeNote,
  renderFooter,
  registerClose,
  close,
}: AiConfigSheetBodyProps): React.ReactElement {
  const baseline = sources.value;

  // The pending triple is dialog-local DATA, not appearance ([L06] governs the
  // preview, not the choice).
  const [pending, setPending] = useState<AiConfigBaseline>(baseline);
  /** The row the user last moved — the sticky value, and the default layer. */
  const [lastChangedRow, setLastChangedRow] = useState<AiConfigRow | null>(null);

  const onChange = useCallback(
    (next: AiConfigBaseline, changed: AiConfigRow) => {
      setPending(next);
      setLastChangedRow(changed);
    },
    [],
  );

  const focusGroup = React.useId();
  useSeedKeyView(`${focusGroup}:${AI_CONFIG_ROW_OFFSET[openRow]}`);

  useEffect(() => {
    registerClose.current = () => close();
    return () => {
      registerClose.current = null;
    };
  }, [registerClose, close]);

  // The other half of the ⌃⌘I toggle, the same shape the usage panel uses for
  // ⌃⌘U. `ai` is a key-card-routed command, and a sheet can be up with no key
  // card — this body is portalled out of the card's subtree, so the walk finds
  // no `card` ancestor and the dispatch reaches the opener's toggle above not
  // at all. It is still *announced*: observers hear it whether or not a
  // responder handled it. So the open sheet watches the chain for its own
  // command and takes that press as "put me away" too. Either half alone
  // leaves a door that only opens. It closes the way Cancel and Escape do: a
  // toggle-off is a dismissal, and nothing reaches the wire.
  const manager = useResponderChain();
  useEffect(() => {
    if (manager === null) return;
    return manager.observeDispatch((event) => {
      if (event.action !== TUG_ACTIONS.RUN_SLASH_COMMAND) return;
      const value = event.value as { name?: string } | undefined;
      if (value?.name !== "ai") return;
      close();
    });
  }, [manager, close]);

  const confirm = (): void => {
    const actions = computeAiConfigCommit(baseline, pending);
    if (actions.length > 0) {
      // A refusal (the turn went in flight while the sheet was up) leaves the
      // sheet standing with its pending values — the caution says why, and no
      // part of the transaction has been applied.
      if (!onCommit(actions)) return;
      if (lastChangedRow !== null) writeStickyRow(lastChangedRow);
    }
    close();
  };

  return (
    <div className="ai-config-sheet" data-slot="ai-config-sheet">
      {/* The editor entire — readout, scope line, channels. The sheet adds
          only what makes it a transaction: the doors and the action row. */}
      <AiConfigEditor
        sources={sources}
        value={pending}
        onChange={onChange}
        scopeNote={scopeNote}
        focusGroup={focusGroup}
      />

      {renderFooter !== undefined && (
        <div className="ai-config-footer">{renderFooter(close)}</div>
      )}

      <div className="tug-sheet-actions">
        <TugPushButton
          size="sm"
          data-slot="ai-config-cancel"
          emphasis="outlined"
          role="action"
          onClick={close}
          focusGroup={focusGroup}
          focusOrder={CANCEL_FOCUS_ORDER}
        >
          Cancel
        </TugPushButton>
        <TugPushButton
          size="sm"
          data-slot="ai-config-ok"
          emphasis="primary"
          onClick={confirm}
          focusGroup={focusGroup}
          focusOrder={OK_FOCUS_ORDER}
          persistentDefaultRing
        >
          OK
        </TugPushButton>
      </div>
    </div>
  );
}
