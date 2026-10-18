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
import type { CardStateBag } from "@/layout-tree";
import { dispatchShellAction, registerAction } from "@/action-registry";
import { setFirstBodyBagSeed } from "@/lib/body-handoff";
import { OVERVIEW_CARD_ID } from "@/lib/overview-card-id";

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
 *
 * Under per-card web views this module's state is the Overview body's page,
 * which goes with the card, so it no longer outlives the hide on its own. The
 * app-scoped copy is the shell's ({@link holdOverviewDraftInShell}): the
 * composer forwards every change of its words and pictures there
 * ({@link forwardOverviewDraft}), and the next Overview card's first body is
 * handed it as its bag ({@link overviewDraftSeedBag}), which the composer's
 * restore takes up as it takes up a relaunch's.
 */
export const overviewDraftHolder = {
  get(): TugTextEditingState | null {
    return _held;
  },
  set(draft: TugTextEditingState | null): void {
    _held = isEmptyDraft(draft) ? null : draft;
  },
};

/**
 * The deck action a body's composer hands its draft to the shell by
 * (`dispatchShellAction`, one of `SHELL_ACTIONS_FOR_CARDS`). The payload is
 * `{ draft, attachmentBytes? }`; `attachmentBytes` rides only when the
 * pictures moved, so a keystroke does not resend them.
 */
export const HOLD_OVERVIEW_DRAFT = "hold-overview-draft";

/**
 * Hand the composer's draft to the app-scoped holder: the shell's handler
 * where this page registers one, else over the bus to the shell. `null` (or
 * an empty draft) lets it go. Pass `attachmentBytes` when the pictures moved.
 */
export function forwardOverviewDraft(
  draft: TugTextEditingState | null,
  attachmentBytes?: Record<string, RestoredAttachmentEntry>,
): void {
  dispatchShellAction(HOLD_OVERVIEW_DRAFT, {
    draft: isEmptyDraft(draft) ? null : draft,
    ...(attachmentBytes !== undefined ? { attachmentBytes } : {}),
  });
}

/** The shell's copy: the draft the last Overview body forwarded, with its pictures. */
let _shellHeld: OverviewComposerDraftState | null = null;

/**
 * The shell's handler for {@link HOLD_OVERVIEW_DRAFT}. The words replace the
 * last; the pictures replace theirs when they came, and stand otherwise. A
 * draft with nothing in it, or a payload that is not one, clears the hold.
 */
export function holdOverviewDraftInShell(payload: Record<string, unknown>): void {
  const draft = isEditingState(payload.draft) ? payload.draft : null;
  if (isEmptyDraft(draft)) {
    _shellHeld = null;
    return;
  }
  const bytes = payload.attachmentBytes;
  const attachmentBytes =
    bytes !== null && typeof bytes === "object"
      ? (bytes as Record<string, RestoredAttachmentEntry>)
      : _shellHeld?.attachmentBytes;
  _shellHeld = {
    draft,
    ...(attachmentBytes !== undefined && Object.keys(attachmentBytes).length > 0 ? { attachmentBytes } : {}),
  };
}

/**
 * The bag a fresh Overview card's first body is handed (`body-handoff.ts`):
 * the held draft as the composer's payload, or nothing when none is held.
 */
export function overviewDraftSeedBag(): CardStateBag | undefined {
  return _shellHeld === null ? undefined : { content: _shellHeld };
}

/**
 * Install the shell's half: its handler for the forwarded draft, and the
 * seed of a fresh Overview card's first body. Returns the uninstall.
 */
export function installOverviewDraftShellHolder(): () => void {
  registerAction(HOLD_OVERVIEW_DRAFT, holdOverviewDraftInShell);
  const releaseSeed = setFirstBodyBagSeed(OVERVIEW_CARD_ID, overviewDraftSeedBag);
  return () => {
    releaseSeed();
    _shellHeld = null;
  };
}

/** For tests. */
export function _resetOverviewDraftShellHolderForTest(): void {
  _shellHeld = null;
  _held = null;
}
