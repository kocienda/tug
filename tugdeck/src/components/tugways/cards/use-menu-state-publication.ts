/**
 * useMenuStatePublication — publishes the session card's session state to
 * the host menu-state aggregator (`lib/host-menu-state.ts`), which
 * forwards it to the Swift host for menu validation (Stop enablement,
 * the permission-mode checkmark, rewind/copy gates, the Commit Changes gate).
 *
 * Publication is a side effect, not render-driving, so the effect
 * subscribes to the stores directly ([L22]) instead of re-publishing
 * render-bound hook values: store emissions far outnumber renders
 * (every streaming token), and conversely a publication must fire even
 * when no rendered value changed. The card publishes unconditionally;
 * the aggregator decides whether the block rides the wire payload by
 * checking which card is the focused pane's active card.
 *
 * The transcript-derived facts are cached against the snapshot's
 * `Object.is`-stable transcript reference, so per-token emissions
 * recompute nothing — they re-read two booleans and the publisher's
 * diff suppresses the unchanged payload.
 */

import { useEffect } from "react";

import type { CodeSessionStore } from "@/lib/code-session-store";
import type { CommitModeController } from "@/lib/commit-mode-controller";
import type { JoinModeController } from "@/lib/join-mode-controller";
import type { TurnEntry } from "@/lib/code-session-store/types";
import type { SessionMetadataStore } from "@/lib/session-metadata-store";
import type { ShadeViewController } from "@/lib/shade-view-controller";
import { cardSessionBindingStore } from "@/lib/card-session-binding-store";
import { sessionNameStore } from "@/lib/session-name-store";
import { clearSessionMenuState, publishSessionMenuState } from "@/lib/host-menu-state";
import { getDeckStore } from "@/lib/deck-store-registry";
import { cardFoldedOf } from "@/deck-store-selectors";
import { getTugbankClient } from "@/lib/tugbank-singleton";
import {
  PERMISSION_MODE_DOMAIN,
  formatPermissionMode,
  parsePersistedPermissionMode,
  resolvePermissionMode,
} from "@/lib/permission-mode";
import { formatAiConfigSummary } from "@/lib/ai-config";
import { knownModelRows, resolveModelLabel } from "@/lib/model-label";
import { formatEffortLabel, resolveEffortDisplay } from "@/lib/effort";
import { readModelCatalog } from "@/lib/model-catalog";

/** The transcript facts the menu cares about, derived per reference. */
function deriveTranscriptFacts(transcript: ReadonlyArray<TurnEntry>): {
  hasAssistantMessage: boolean;
  hasTurns: boolean;
} {
  return {
    hasAssistantMessage: transcript.some((t) =>
      t.messages.some((m) => m.kind === "assistant_text"),
    ),
    hasTurns: transcript.length > 0,
  };
}

export function useMenuStatePublication(
  cardId: string,
  codeSessionStore: CodeSessionStore,
  sessionMetadataStore: SessionMetadataStore,
  shadeViewController: ShadeViewController,
  commitModeController: CommitModeController,
  joinModeController: JoinModeController,
): void {
  useEffect(() => {
    let cachedTranscript: ReadonlyArray<TurnEntry> | null = null;
    let cachedFacts = { hasAssistantMessage: false, hasTurns: false };

    const publish = (): void => {
      const snap = codeSessionStore.getSnapshot();
      if (snap.transcript !== cachedTranscript) {
        cachedTranscript = snap.transcript;
        cachedFacts = deriveTranscriptFacts(snap.transcript);
      }
      // Same fallback chain as the permission-mode chip, so the menu
      // checkmark can never disagree with the chip.
      const persisted = parsePersistedPermissionMode(
        getTugbankClient()?.get(PERMISSION_MODE_DOMAIN, cardId),
      );
      const shadeView = shadeViewController.getSnapshot();
      const metadata = sessionMetadataStore.getSnapshot();
      const mode = resolvePermissionMode(metadata.permissionMode, persisted);
      const catalog = readModelCatalog();
      const effortDisplay = resolveEffortDisplay(
        metadata.models,
        metadata.model,
        // The chip's effort reads `snapshot.effort` and nothing else. This hook
        // has a per-card tugbank fallback in scope for the MODE, and none for
        // effort — inventing one here would be a second opinion on the chip's
        // value, which is exactly what the shared-resolver rule above forbids.
        metadata.effort,
        catalog,
      );
      publishSessionMenuState(cardId, {
        cardId,
        sessionBound: cardSessionBindingStore.getBinding(cardId) !== undefined,
        canInterrupt: snap.canInterrupt,
        canChangeSettings: snap.canSubmit,
        permissionMode: mode,
        // Composed from the same three resolvers the chip runs — all pure and
        // synchronous, so this adds no subscription.
        aiSummary: formatAiConfigSummary({
          modelLabel: resolveModelLabel(
            metadata.model,
            knownModelRows(metadata.models, catalog),
          ),
          effortLabel: effortDisplay.supported
            ? formatEffortLabel(effortDisplay.level)
            : null,
          modeLabel: formatPermissionMode(mode),
        }),
        changesVisible: shadeView === "changes",
        historyVisible: shadeView === "history",
        // The folded flag is the PANE's, so it is read from the deck store
        // rather than from anything this card holds. Null-tolerant because the
        // registry is: a test that bootstraps a card without a DeckManager
        // reads not-folded, which is the resting answer anyway.
        folded: (() => {
          const deckStore = getDeckStore();
          return deckStore === null
            ? false
            : cardFoldedOf(deckStore.getSnapshot(), cardId);
        })(),
        // Whichever landing is up is the one the menu item acts on ([P01]), so
        // the published bit is the active mode's readiness rather than
        // commit's alone — a menu that assumed commit would read as dead the
        // whole time a join is being authored.
        commitReady: joinModeController.getSnapshot().active
          ? joinModeController.getSnapshot().landReady
          : commitModeController.getSnapshot().landReady,
        // There is something for Unname to clear. Read fresh off the binding
        // each publish, so the item enables and disables as the name moves.
        hasCustomName: (() => {
          const binding = cardSessionBindingStore.getBinding(cardId);
          return (
            binding !== undefined &&
            sessionNameStore.getName(binding.tugSessionId) !== null
          );
        })(),
        ...cachedFacts,
      });
    };

    const unsubscribes = [
      codeSessionStore.subscribe(publish),
      sessionMetadataStore.subscribe(publish),
      cardSessionBindingStore.subscribe(publish),
      shadeViewController.subscribe(publish),
      // Commit readiness moves on the message's empty ↔ non-empty edge as well
      // as on the turn / changeset stores, and only the controller sees the
      // first of those.
      commitModeController.subscribe(publish),
      joinModeController.subscribe(publish),
      // The name moves under the card — a `/rename`, a `/unname`, or another
      // session taking the name away — and the Unname item's enablement has to
      // move with it.
      sessionNameStore.subscribe(publish),
    ];
    // The deck store is one more input for the same reason the others are: a
    // fold lands as a deck commit, and the item's verb has to move with it
    // without waiting for some other store to happen to emit. Null when no
    // DeckManager was constructed, which the publish above already tolerates.
    const deckStore = getDeckStore();
    if (deckStore !== null) unsubscribes.push(deckStore.subscribe(publish));
    publish();

    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
      clearSessionMenuState(cardId);
    };
  }, [
    cardId,
    codeSessionStore,
    sessionMetadataStore,
    shadeViewController,
    commitModeController,
  ]);
}
