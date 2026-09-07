/**
 * The Overview composer's draft, between the moment the user stops typing it
 * and the moment they come back to it — across a rail hidden and shown, and
 * across a relaunch.
 *
 * **Why there are two homes rather than one.** The Session card's prompt entry
 * needs only the framework's per-card bag: its card lives as long as the
 * session does, so `useCardStatePreservation` carries a draft across every
 * transition the entry sees. The Overview's rail does not work that way.
 * Hiding it (⌃⌘O, the Window menu, the card's own close) runs
 * `hideSidebarPane`, which closes the pane and **destroys the card**, and
 * showing it again mints a fresh `crypto.randomUUID()` card id — so the bag,
 * which is keyed by card id, is written under an id nothing will ever ask for
 * again. That is the answer to the arc's open question ([F07]): the rail does
 * unmount on hide, and the framework's channel alone cannot carry a draft
 * across one.
 *
 * So the draft has two homes and each covers what the other cannot:
 *
 * - This module-level holder — app-scoped, like the composer's bytes store and
 *   its completion provider — survives the unmount, which is what a hide is.
 *   It does not survive a relaunch, because nothing in the renderer does.
 * - The `useCardStatePreservation` bag, written by the composer around this
 *   holder, is persisted through tugbank and is what survives a relaunch. On a
 *   relaunch the rail's card id comes back off the saved layout unchanged, so
 *   the bag is found.
 *
 * The composer seeds the holder on restore and reads it on mount, so which of
 * the two answered is never a question the field has to ask.
 *
 * @module components/overview/overview-composer-draft
 */

import {
  coerceAttachmentBytes,
  isEditingState,
  pruneOrphanedImageAtoms,
  type RestoredAttachmentEntry,
} from "@/lib/composer-draft-payload";
import type { TugTextEditingState } from "@/lib/tug-text-types";

/**
 * What the Overview composer preserves: one draft snapshot and the image
 * bytes its atoms stand for. The Session entry's payload carries a `route`
 * beside these; this composer has exactly one route and so carries none.
 */
export interface OverviewComposerDraftState {
  draft: TugTextEditingState | null;
  /**
   * Snapshot of the composer's `AtomBytesStore` — base64 image bytes for the
   * atoms currently in the draft. Across a relaunch the entries arrive
   * reduced to references (an empty `content` and a `path` to the original on
   * disk), because `capDurableCardState` persists no image data; rehydration
   * reads the bytes back after the restore, which is step 3's machinery
   * ([B09]). Omitted when the composer holds no pictures.
   */
  attachmentBytes?: Record<string, RestoredAttachmentEntry>;
}

/**
 * Coerce a restored payload into {@link OverviewComposerDraftState}. Anything
 * that is not the shape restores as an empty composer rather than a crash,
 * and an image atom with no route back to its bytes is spliced out — the same
 * postcondition the Session entry's own coercion holds.
 */
export function coerceOverviewDraftPayload(
  raw: unknown,
): OverviewComposerDraftState {
  if (raw === null || typeof raw !== "object") return { draft: null };
  const obj = raw as Partial<OverviewComposerDraftState>;
  const attachmentBytes = coerceAttachmentBytes(obj.attachmentBytes);
  const draft = pruneOrphanedImageAtoms(
    isEditingState(obj.draft) ? obj.draft : null,
    attachmentBytes,
  );
  return { draft, attachmentBytes };
}

/** A draft with no words and no pictures is the same as no draft at all. */
export function isEmptyDraft(draft: TugTextEditingState | null): boolean {
  return draft === null || (draft.text.length === 0 && draft.atoms.length === 0);
}

let _held: TugTextEditingState | null = null;

/**
 * The live holder — the half of the draft's home that survives the rail being
 * hidden. App-scoped for the reason the composer's bytes store is: the card is
 * app-wide and single-instance, so there is exactly one draft to hold.
 */
export const overviewDraftHolder = {
  get(): TugTextEditingState | null {
    return _held;
  },
  set(draft: TugTextEditingState | null): void {
    _held = isEmptyDraft(draft) ? null : draft;
  },
};
