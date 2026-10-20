/**
 * The shell's half of the overlay page.
 *
 * Where the host makes body views it also keeps an overlay above every card
 * ([B07]), and the shell asks for it at boot ({@link requestOverlay}). What the
 * overlay shows for the shell crosses from here: the restore gate's fold, the
 * host's update state and the live-turn count it is read beside, and the
 * surfaces anchored to cards at rest (`lib/overlay-surfaces.ts`). What the
 * overlay asks of the shell is answered here: an update action for the host,
 * the setup wizard's first session, and the modals it has up, which the
 * shell's menu reads. An alert the shell raises is asked of the overlay
 * ({@link overlayShowAlert}), and the Tug menu's Configure Tug… opens the
 * wizard there. Open Quickly is drawn there too ([B08]): the shell's open
 * state crosses, and its close and the file it chose come back.
 *
 * None of it carries a card's geometry while the card moves.
 *
 * @module lib/overlay-shell
 */

import type React from "react";
import type { CardDeck } from "../card-deck";
import {
  overlayAlert,
  overlayAppModal,
  overlayCloseOpenQuickly,
  overlayLiveTurns,
  overlayNetworkPath,
  overlayOpenConfigure,
  overlayOpenFile,
  overlayOpenFirstSession,
  overlayOpenQuickly,
  overlayRestoreGate,
  overlayUpdateAction,
  overlayUpdateState,
} from "../bus/declarations/overlay";
import { pageBus } from "../bus/page-bus";
import { postToHost } from "../host/channel";
import { overlayCreateToHost } from "../host/declarations/overlay";
import { appModalStore } from "./app-modal-store";
import { getAppLifecycle } from "./app-lifecycle";
import { hostCapabilitiesStore } from "./body-handoff";
import { setConfigureTugOnDemandSink } from "./configure-tug-request-store";
import { liveTurnsStore } from "./live-turns-store";
import { networkPathStore } from "./network-path-store";
import { openFileInCard } from "./open-file-in-card";
import {
  closeOpenQuickly,
  getOpenQuicklyOpen,
  getOpenQuicklySeq,
  subscribeOpenQuickly,
  subscribeOpenQuicklyRequests,
} from "./open-quickly-store";
import { OVERLAY_CARD_ID } from "./overlay-card";
import { restoreGateStore } from "./restore-gate-store";
import { openFirstSession } from "./shell-gate-deck";
import { tugDevLogStore } from "./tug-dev-log-store/tug-dev-log-store";
import { postUpdateAction, updateStore, type UpdateAction } from "./update-store";

/** Whether the host keeps an overlay page above the cards: it does wherever it makes body views. */
export function hostKeepsOverlay(): boolean {
  return hostCapabilitiesStore.get().bodyViews;
}

/** The options an alert takes, as `useTugAlert()` hands them. */
export interface RelayedAlertOptions {
  title?: string;
  message?: string | React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string | null;
  confirmRole?: "accent" | "action" | "agent" | "data" | "danger" | "option";
  icon?: string;
}

/**
 * Show an alert in the overlay and resolve whether it was confirmed. The
 * wait is on the person at the alert's buttons, so it arms no deadline
 * ([L33]); an overlay that has not said hello yet is held for, and a reload
 * of it asks again (`redeliver`). A message that is not text cannot cross,
 * so it is refused, never shown half.
 */
export function overlayShowAlert(options: RelayedAlertOptions = {}): Promise<boolean> {
  const { message } = options;
  if (message !== undefined && typeof message !== "string") {
    tugDevLogStore.warn("overlay", "an alert whose message is not text cannot be shown in the overlay");
    return Promise.resolve(false);
  }
  return overlayAlert
    .ask(
      {
        title: options.title,
        message,
        confirmLabel: options.confirmLabel,
        cancelLabel: options.cancelLabel,
        confirmRole: options.confirmRole,
        icon: options.icon,
      },
      { card: OVERLAY_CARD_ID, horizon: { person: "the alert's buttons" } },
    )
    .then((result) => result.ok && result.value.confirmed);
}

/**
 * Ask for the overlay, publish what it shows, and answer what it asks.
 * Returns the release ([L27]). A no-op where the host keeps no overlay.
 */
export function installOverlayShell(deck: CardDeck): () => void {
  if (!hostKeepsOverlay()) return () => {};
  const releases: Array<() => void> = [];

  // What the overlay shows for the shell.
  const relay = (subscribe: (l: () => void) => () => void, publish: () => void): void => {
    releases.push(subscribe(publish));
    publish();
  };
  relay(restoreGateStore.subscribe, () => overlayRestoreGate.set(restoreGateStore.getSnapshot()));
  // Every update snapshot, in order: the wizard reads its transitions
  // (`overlay.updateState`). The standing one goes again at each hello of
  // the overlay, a page that loaded after the host spoke.
  const sendUpdate = (): void => overlayUpdateState.dispatch(updateStore.getSnapshot(), { card: OVERLAY_CARD_ID });
  releases.push(updateStore.subscribe(sendUpdate));
  releases.push(
    pageBus().onAttach((cardId) => {
      if (cardId === OVERLAY_CARD_ID) sendUpdate();
    }),
  );
  relay(liveTurnsStore.subscribe, () => {
    const { titles } = liveTurnsStore.getSnapshot();
    overlayLiveTurns.set({ count: titles.length, titles: [...titles] });
  });
  relay(networkPathStore.subscribe, () => overlayNetworkPath.set({ ...networkPathStore.getSnapshot() }));

  // What the overlay asks of the shell.
  releases.push(overlayUpdateAction.handle(({ action }) => postUpdateAction(action as UpdateAction)));
  releases.push(overlayOpenFirstSession.handle(({ projectDir }) => openFirstSession(deck, projectDir)));
  // The overlay's modals are the app's: the menu reads them here.
  relay(overlayAppModal.subscribe, () => appModalStore.mirror(overlayAppModal.getFor(OVERLAY_CARD_ID)));

  // The Tug menu's Configure Tug… opens the overlay's wizard.
  setConfigureTugOnDemandSink(() => overlayOpenConfigure.dispatch({}, { card: OVERLAY_CARD_ID }));
  releases.push(() => setConfigureTugOnDemandSink(null));

  // Open Quickly, drawn in the overlay: opened here, closed from either side.
  // The app going inactive closes it, as it closed the shell's own — a
  // launcher left up behind a switched-away app strands it over whatever the
  // user comes back to — and the overlay page hears nothing of the app's
  // lifecycle.
  // Every open request is sent, a re-raise of one the shell still holds open
  // included, and a close counts only for the open it closed.
  const publishOpenQuickly = (): void => overlayOpenQuickly.set({ open: getOpenQuicklyOpen(), seq: getOpenQuicklySeq() });
  relay(subscribeOpenQuickly, publishOpenQuickly);
  releases.push(subscribeOpenQuicklyRequests(publishOpenQuickly));
  releases.push(
    overlayCloseOpenQuickly.handle(({ seq }, from) => {
      if (from.cardId === OVERLAY_CARD_ID && seq === getOpenQuicklySeq()) closeOpenQuickly();
    }),
    overlayOpenFile.handle(({ path, line }, from) => {
      if (from.cardId === OVERLAY_CARD_ID) openFileInCard(deck, path, line ?? undefined);
    }),
  );
  const lifecycle = getAppLifecycle();
  if (lifecycle !== null) releases.push(lifecycle.observeApplicationWillResignActive(() => closeOpenQuickly()));

  return () => {
    for (const release of releases.splice(0)) release();
  };
}

/**
 * Ask the host for the overlay's view. Sent at the very top of the shell's
 * boot, before the deck exists, so the overlay's page loads beside the
 * shell's rather than after it: a restore gate raised at the first restore
 * has its page up. Idempotent on the host; a no-op where it keeps none.
 */
export function requestOverlay(): void {
  if (hostKeepsOverlay()) postToHost(overlayCreateToHost, {});
}
