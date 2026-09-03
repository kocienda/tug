/**
 * rename-session-sheet.tsx — the `/rename` session-name surface ([#step-13d]).
 *
 * `/rename <text>` (arg-bearing per [D23]) sets the bound session's name
 * directly; bare `/rename` opens a one-field dialog seeded with the current
 * name. Both funnel through {@link commitRename}: optimistically update the Z4B
 * chip via {@link sessionNameStore}, then send the `rename_session` CONTROL
 * frame — tugcast writes the ledger and broadcasts `session_updated`, which
 * makes the name authoritative for the chip + the session chooser.
 *
 * The optimistic chip write is paired with a settle waiter holding the name it
 * replaced, so a refused rename puts the old name back instead of leaving the
 * chip showing a name the ledger never took. Both paths report the outcome in
 * the card's bulletin when the ack lands, rather than claiming success on the
 * gesture — the dialog closes on submit and has no other way to speak.
 *
 * Compositional — the bare dialog composes the card's shared `TugSheet` (via
 * `showSheet`), `TugInput`, and `TugPushButton`; composed children keep their
 * own tokens ([L20]). No-op when the card has no bound session.
 *
 * Laws: [L02] binding read via the store, [L07] resolve the binding fresh at
 *       invoke time, [L20] composed children keep tokens.
 * Decisions: [D15] pane sheets are overlays, [D23] local slash-command dispatch.
 *
 * @module components/tugways/cards/rename-session-sheet
 */

import React, { useCallback, useState } from "react";

import { TugInput } from "@/components/tugways/tug-input";
import { TugPushButton } from "@/components/tugways/tug-push-button";
import { useSeedKeyView } from "@/components/tugways/use-focusable";
import type { ShowSheetOptions } from "@/components/tugways/tug-sheet";
import { cardSessionBindingStore } from "@/lib/card-session-binding-store";
import { getConnection } from "@/lib/connection-singleton";
import { encodeRenameSession } from "@/protocol";
import {
  renameRefusalDetail,
  sessionNameStore,
} from "@/lib/session-name-store";
import type { TugPaneBulletinApi } from "@/components/tugways/tug-pane-bulletin";
import { MODAL_REST_LINE } from "./modal-rest-line";

export interface UseRenameSessionSheetArgs {
  /** Card whose bound session is renamed. */
  cardId: string;
  /** The card's shared sheet host (`useTugSheet().showSheet`). */
  showSheet: (options: ShowSheetOptions) => Promise<string | undefined>;
  /**
   * The card's pane bulletin, read at ack time — the ref it comes from is
   * populated by an anchor rendered inside the provider, so it is only good
   * to read live, never to capture.
   */
  notify: () => TugPaneBulletinApi | null;
}

export interface RenameSessionSheetController {
  /** `/rename <text>` — set the name directly (no dialog). */
  renameTo: (name: string) => void;
  /** bare `/rename` — open the one-field dialog seeded with the current name. */
  openRenameSheet: () => void;
}

export function useRenameSessionSheet({
  cardId,
  showSheet,
  notify,
}: UseRenameSessionSheetArgs): RenameSessionSheetController {
  // Optimistic chip update + the `rename_session` frame, with the replaced name
  // held for the refusal path. Read the binding fresh ([L07]); a no-op when the
  // card isn't bound. A blank name clears the name.
  const commitRename = useCallback(
    (name: string) => {
      const binding = cardSessionBindingStore.getBinding(cardId);
      const connection = getConnection();
      if (binding === undefined || connection === null) return;
      const trimmed = name.trim();
      const previous = sessionNameStore.getName(binding.lineId);
      const bulletin = notify();
      sessionNameStore.setName(binding.lineId, trimmed);
      sessionNameStore.awaitSettle(
        binding.lineId,
        trimmed,
        previous,
        (settle) => {
          if (settle.ok) {
            // A name another line wore is taken by the newest gesture ([P11]),
            // and the bulletin says whom it was taken from — a name that
            // vanished off another card unannounced would be a change at a
            // distance.
            const takenFrom = (settle.displaced ?? [])
              .map((holder) => holder.tag)
              .filter((tag) => tag.length > 0);
            bulletin?.success(
              trimmed.length === 0
                ? "Session name cleared"
                : `Session renamed to “${trimmed}”`,
              takenFrom.length === 0
                ? undefined
                : {
                    description: `The name was taken from ${takenFrom.join(", ")}.`,
                  },
            );
            return;
          }
          bulletin?.danger(
            previous === null
              ? "The session was not renamed"
              : `The session is still named “${previous}”`,
            {
              description: renameRefusalDetail(settle.reason),
              sticky: true,
            },
          );
        },
      );
      const frame = encodeRenameSession(binding.lineId, trimmed);
      connection.send(frame.feedId, frame.payload);
    },
    [cardId, notify],
  );

  const renameTo = useCallback(
    (name: string) => commitRename(name),
    [commitRename],
  );

  const openRenameSheet = useCallback(() => {
    const binding = cardSessionBindingStore.getBinding(cardId);
    if (binding === undefined) return;
    const current = sessionNameStore.getName(binding.lineId) ?? "";
    void showSheet({
      title: "Rename Session",
      icon: "Pencil",
      presentation: "rise",
      bottomAnchorSelector: MODAL_REST_LINE,
      content: (close) => (
        <RenameSheetBody
          initialName={current}
          onSubmit={(name) => {
            commitRename(name);
            close("rename");
          }}
          onCancel={() => close()}
        />
      ),
    });
  }, [cardId, showSheet, commitRename]);

  return { renameTo, openRenameSheet };
}

interface RenameSheetBodyProps {
  initialName: string;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}

function RenameSheetBody({
  initialName,
  onSubmit,
  onCancel,
}: RenameSheetBodyProps): React.ReactElement {
  const [value, setValue] = useState(initialName);
  // Author the field + action buttons into the sheet's trapped focus mode: Tab
  // walks name field → Cancel → Save. Text-first ([P14]/[#step-6]): the engine
  // seeds the key view onto the FIELD (caret on open). Save is the surface's sole
  // Return consumer, so it opts into `persistentDefaultRing` — it keeps its ring
  // the whole time (Return's home) while the caret stays in the field.
  const focusGroup = React.useId();
  const FIELD_ORDER = 0;
  const CANCEL_ORDER = 1;
  const SAVE_ORDER = 2;
  useSeedKeyView(`${focusGroup}:${FIELD_ORDER}`);
  return (
    <div className="rename-session-sheet">
      <TugInput
        value={value}
        placeholder="Session name (blank to clear)"
        aria-label="Session name"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          // Return in the field commits. Escape / Cmd-. → TugSheet dismiss.
          if (e.key === "Enter") {
            e.preventDefault();
            onSubmit(value);
          }
        }}
        data-testid="rename-session-input"
        focusGroup={focusGroup}
        focusOrder={FIELD_ORDER}
      />
      <div className="tug-sheet-actions">
        <TugPushButton
          size="sm"
          emphasis="outlined"
          role="action"
          onClick={() => onCancel()}
          data-testid="rename-cancel"
          focusGroup={focusGroup}
          focusOrder={CANCEL_ORDER}
        >
          Cancel
        </TugPushButton>
        <TugPushButton
          size="sm"
          emphasis="primary"
          onClick={() => onSubmit(value)}
          data-testid="rename-save"
          focusGroup={focusGroup}
          focusOrder={SAVE_ORDER}
          persistentDefaultRing
        >
          Save
        </TugPushButton>
      </div>
    </div>
  );
}
