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
 * @module lib/overview-composer-draft
 */

import {
  coerceAttachmentBytes,
  isEditingState,
  pruneOrphanedImageAtoms,
  type RestoredAttachmentEntry,
} from "@/lib/composer-draft-payload";
import type { TugTextEditingState } from "@/lib/tug-text-types";
import { installedPageBus, pageBus, type PageBus } from "@/bus/page-bus";
import { holdOverviewDraft, overviewDraft } from "@/bus/declarations/relays";

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
 * app-scoped copy is the shell's (`overview.draft`, held by
 * {@link holdOverviewDraftInShell}): the composer proposes every change of its
 * words and pictures there ({@link forwardOverviewDraft}), and the next
 * Overview body's composer seeds itself from the replica on mount
 * ({@link takeShellOverviewDraft}).
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
 * Hand the composer's draft to the shell's hold, in a body: a proposal to
 * `overview.draft`. `null` (or an empty draft) lets it go. Pass
 * `attachmentBytes` when the pictures moved, so a keystroke does not resend
 * them. A page that is not a body holds the draft itself, in
 * {@link overviewDraftHolder}.
 */
export function forwardOverviewDraft(
  draft: TugTextEditingState | null,
  attachmentBytes?: Record<string, RestoredAttachmentEntry>,
  bus: PageBus | null = installedPageBus(),
): void {
  if (bus?.page.role !== "body") return;
  overviewDraft.on(bus).propose({
    draft: isEmptyDraft(draft) ? null : draft,
    ...(attachmentBytes !== undefined ? { attachmentBytes } : {}),
  });
}

/**
 * The shell's hold on the Overview draft: apply each body's proposal, the
 * words replacing the last and the pictures standing until they move
 * (`holdOverviewDraft`). Returns the release.
 */
export function holdOverviewDraftInShell(bus: PageBus = pageBus()): () => void {
  const held = overviewDraft.on(bus);
  return held.onProposal((patch) => held.update((prev) => holdOverviewDraft(prev, patch)));
}

/**
 * Hand `take` the draft the shell holds, once it has arrived — now, or when
 * the shell's snapshot reaches a body that came up before it — and only when
 * the shell holds one. Nothing in a page that is not a body. Returns the
 * release, which a composer that seeded itself otherwise calls.
 */
export function takeShellOverviewDraft(
  take: (held: OverviewComposerDraftState) => void,
  bus: PageBus | null = installedPageBus(),
): () => void {
  if (bus?.page.role !== "body") return () => {};
  const held = overviewDraft.on(bus);
  let release: (() => void) | null = null;
  const offer = (): boolean => {
    if (!held.arrived()) return false;
    release?.();
    release = null;
    const value = held.getSnapshot();
    if (value !== null) take(value);
    return true;
  };
  if (offer()) return () => {};
  release = held.subscribe(() => void offer());
  return () => {
    release?.();
    release = null;
  };
}

/** For tests. */
export function _resetOverviewDraftHolderForTest(): void {
  _held = null;
}
