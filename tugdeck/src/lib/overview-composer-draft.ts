/**
 * The Overview composer's draft, between the moment the user stops typing it
 * and the moment they come back to it — across a rail hidden and shown, and
 * across a relaunch.
 *
 * **Why the draft is not the card's.** The Session card's prompt entry needs
 * only the framework's per-card bag: its card lives as long as the session
 * does, so `useCardStatePreservation` carries a draft across every transition
 * the entry sees. The Overview's rail does not work that way. Hiding it (⌃⌘O,
 * the Window menu, the card's own close) runs `hideSidebarPane`, which closes
 * the pane and **destroys the card**, and showing it again mints a fresh
 * `crypto.randomUUID()` card id ([F07]). And every workspace has an Overview
 * card of its own, while the draft is one: the user's half-asked question to
 * the Overview, whichever space they asked it from.
 *
 * A per-card bag got that wrong in the way the user saw: a draft carried into
 * every space's Overview landed in every space's bag, and clearing it cleared
 * only the bag of the card it was cleared in. On the next launch whichever
 * stale bag restored first brought the draft back, and the shell's hold
 * spread it to the rest — an atom the user had deleted, standing in the
 * prompt again after every relaunch.
 *
 * So the draft has one home, the shell's (`overview.draft`), which outlives
 * every card and is app-wide as the draft is. A body's composer proposes each
 * change of its words and pictures there ({@link forwardOverviewDraft}), and
 * the next Overview body's composer takes it on mount
 * ({@link takeShellOverviewDraft}). The shell writes what it holds to one
 * tugbank key ({@link OVERVIEW_DRAFT_DOMAIN}) and seeds itself from that key
 * at launch ({@link holdOverviewDraftInShell}), so a relaunch is one more
 * mount taking what the shell holds, and a let-go is a let-go everywhere.
 *
 * The pictures persist as references, the shape `capAttachmentBytes` reduces
 * them to — a path to the original and no image data — and the composer that
 * takes them reads the bytes back.
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
import type { TugbankClient } from "@/lib/tugbank-client";
import { getTugbankClient } from "@/lib/tugbank-singleton";
import { capAttachmentBytes } from "@/settings-api";
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
 * Where the shell keeps the draft across a relaunch: one key, app-wide, the
 * way the draft is. Never a card's bag — see the module doc for what a
 * per-card home did.
 */
export const OVERVIEW_DRAFT_DOMAIN = "dev.tugapp.overview";
/** The one key in {@link OVERVIEW_DRAFT_DOMAIN}. */
export const OVERVIEW_DRAFT_KEY = "draft";

/**
 * How long the words wait to be written after they change. A let-go is never
 * kept waiting: it is written the moment it lands, because it is the write
 * a relaunch must not miss.
 */
const DRAFT_WRITE_DELAY_MS = 250;

/** The shell's reach into tugbank for the draft, so a test can stand in for it. */
export interface OverviewDraftDisk {
  read(): unknown;
  write(value: DurableOverviewDraft): void;
}

/**
 * The draft as it rests on disk: the words in full and the pictures as
 * references. A let-go rests as `{ draft: null }` rather than as nothing,
 * because tugbank's `json` kind carries no bare `null`.
 */
export interface DurableOverviewDraft {
  draft: TugTextEditingState | null;
  attachmentBytes?: Record<string, unknown>;
}

/** What the shell holds, reduced to what is worth writing. */
export function durableOverviewDraft(held: OverviewComposerDraftState | null): DurableOverviewDraft {
  if (held === null) return { draft: null };
  const capped = capAttachmentBytes(held.attachmentBytes);
  return capped === null ? { draft: held.draft } : { draft: held.draft, attachmentBytes: capped };
}

/**
 * The tugbank disk for the shell's hold, or null when there is no client or
 * the run is a test that does not persist — test mode reads and writes no
 * deck state of its own unless it asked to ([D02]).
 */
export function tugbankOverviewDraftDisk(
  client: TugbankClient | null = getTugbankClient(),
): OverviewDraftDisk | null {
  if (client === null) return null;
  if (typeof window !== "undefined" && window.__tugTestMode === true && window.__tugPersistInTestMode !== true) {
    return null;
  }
  return {
    read: () => client.getValue(OVERVIEW_DRAFT_DOMAIN, OVERVIEW_DRAFT_KEY),
    write: (value) =>
      client.put(OVERVIEW_DRAFT_DOMAIN, OVERVIEW_DRAFT_KEY, { kind: "json", value }, "overview-draft"),
  };
}

/**
 * The shell's hold on the Overview draft: seeded from `disk` at install,
 * then each body's proposal applied, the words replacing the last and the
 * pictures standing until they move (`holdOverviewDraft`), and what it holds
 * written back — a let-go at once, words a moment later. Returns the
 * release, which writes anything still waiting.
 */
export function holdOverviewDraftInShell(
  bus: PageBus = pageBus(),
  disk: OverviewDraftDisk | null = tugbankOverviewDraftDisk(),
): () => void {
  const held = overviewDraft.on(bus);
  if (disk !== null) {
    const seeded = holdOverviewDraft(null, coerceOverviewDraftPayload(disk.read()));
    if (seeded !== null) held.set(seeded);
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  const write = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    disk?.write(durableOverviewDraft(held.getSnapshot()));
  };
  const flush = (): void => {
    if (timer !== null) write();
  };
  const release = held.onProposal((patch) => {
    held.update((prev) => holdOverviewDraft(prev, patch));
    if (disk === null) return;
    if (held.getSnapshot() === null) write();
    else if (timer === null) timer = setTimeout(write, DRAFT_WRITE_DELAY_MS);
  });
  if (typeof window !== "undefined") window.addEventListener("pagehide", flush);
  return () => {
    if (typeof window !== "undefined") window.removeEventListener("pagehide", flush);
    flush();
    release();
  };
}

/**
 * In an Overview body: tell a shell that reloads under the page the draft
 * the old shell held, which the new one starts without. Only a page that has
 * heard a shell before has one to tell. Returns the release.
 */
export function retellOverviewDraft(bus: PageBus = pageBus()): () => void {
  const held = overviewDraft.on(bus);
  return bus.onPeerHello(
    (peer) => {
      const value = peer === "shell" && held.arrived() ? held.getSnapshot() : null;
      if (value === null) return;
      held.propose({
        draft: value.draft,
        ...(value.attachmentBytes !== undefined ? { attachmentBytes: value.attachmentBytes } : {}),
      });
    },
    { name: "overview.draft:retell" },
  );
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
