/**
 * What a body tells the shell about its card, and only when it changes.
 *
 * The shell draws a body card's chrome — its masthead, its phase, its close
 * and fold gestures — from the last `card-facts` and `card-advice` it heard.
 * Close advice and the fold guard are asked synchronously at gesture time in
 * the shell, so across pages the body pushes them on change and the shell
 * answers from the last push. A keystroke that leaves `waive` where it was
 * sends nothing.
 *
 * A card that registered a close guard — a Text card holding unsaved edits —
 * also says whether its guard would ask (`close-guard`), on change, so the
 * shell's close gesture can front the card before it asks the body to
 * decide. A card with no guard says nothing of the kind, and the shell
 * closes it as it always has.
 *
 * {@link BodyPublisher} is the diffing half, over plain read functions, so it
 * is tested without a page; {@link installBodyPublisher} wires it to the
 * card's stores and the document.
 *
 * @module body/body-publisher
 */

import type { BusMasthead, BusMessage, CardFacts } from "@tugproto/bus";
import { cardTitleStore } from "../lib/card-title-store";
import { cardServicesStore } from "../lib/card-services-store";
import { sessionRestoreRegistry } from "../lib/session-restore";
import { readCardCloseAdvice } from "../lib/card-close-advice";
import { getCardCloseGuard, watchCardCloseGuard } from "../lib/card-close-guard";
import { cardMayFold } from "../lib/card-fold";
import { ownLiveCardIdentity } from "../lib/card-identity";
import { paneTitleBarItemsStore } from "../lib/pane-title-bar-items-store";
import { commandValidationSource } from "../lib/host-menu-state";
import { commandEntry, validateCommand } from "../components/tugways/command-registry";
import { getResponderChainManager } from "../action-registry";
import { sessionPhaseFromSnapshot } from "../lib/code-session-store/use-session-phase";

/** What the publisher reads, each answered fresh on every call. */
export interface BodyPublisherSources {
  readFacts(): CardFacts;
  /** The card's close advice: true when a close need not confirm. */
  readWaive(): boolean;
  /** The card's fold guard: true when a fold may proceed. */
  readGuarded(): boolean;
  /** Whether the card's close guard would ask, or null when it registered none. */
  readAsks(): boolean | null;
}

export class BodyPublisher {
  private lastFacts: string | null = null;
  private lastWaive: boolean | null = null;
  private lastGuarded: boolean | null = null;
  private lastAsks: boolean | null = null;

  constructor(
    private readonly sources: BodyPublisherSources,
    private readonly send: (message: BusMessage) => void,
  ) {}

  /** Read every fact and advice; send each that differs from the last sent. */
  publish(): void {
    const facts = this.sources.readFacts();
    const encoded = JSON.stringify(facts);
    if (encoded !== this.lastFacts) {
      this.lastFacts = encoded;
      this.send({ kind: "card-facts", payload: facts });
    }
    const waive = this.sources.readWaive();
    if (waive !== this.lastWaive) {
      this.lastWaive = waive;
      this.send({ kind: "card-advice", payload: { advice: "close-advice", waive } });
    }
    const guarded = this.sources.readGuarded();
    if (guarded !== this.lastGuarded) {
      this.lastGuarded = guarded;
      this.send({ kind: "card-advice", payload: { advice: "fold-guard", guarded } });
    }
    const asks = this.sources.readAsks();
    if (asks !== null && asks !== this.lastAsks) {
      this.lastAsks = asks;
      this.send({ kind: "card-advice", payload: { advice: "close-guard", asks } });
    }
  }

  /**
   * A pointer went down in the body: ask to be activated, every time. What
   * the body last heard about being first responder can be a press behind,
   * so it is not the judge: a second press that lands before the context
   * the first one earned would otherwise go unasked, and the keyboard and
   * the shell's key card would part. The shell knows, and an activation of
   * the card already key costs it nothing.
   */
  pointerDown(): void {
    this.send({ kind: "card-advice", payload: { advice: "activate" } });
  }
}

/** The card's facts as its stores hold them now. */
export function readBodyCardFacts(cardId: string): CardFacts {
  const masthead = cardTitleStore.getMasthead(cardId);
  const snapshot = cardServicesStore.getServices(cardId)?.codeSessionStore.getSnapshot() ?? null;
  return {
    title: cardTitleStore.get(cardId) ?? "",
    masthead: masthead === null ? null : (masthead as unknown as BusMasthead),
    activity: snapshot === null ? null : sessionPhaseFromSnapshot(snapshot),
    telemetry: {
      canInterrupt: snapshot?.canInterrupt === true ? 1 : 0,
      compacted: snapshot !== null && snapshot.compactionSeed !== null ? 1 : 0,
    },
    // What the card holds as this page's own registries know it; the shell's
    // identity reads for the card answer from it.
    identity: (ownLiveCardIdentity(cardId) as Record<string, unknown> | null) ?? null,
    // The pane's title-bar controls the card contributes, each with the
    // registry's enablement asked of this page's chain, which holds the
    // card's responders; the shell's title bar draws them from it.
    titleBar:
      paneTitleBarItemsStore.get(cardId)?.map((item) => {
        const entry = commandEntry(item.commandId);
        return { ...item, enabled: entry !== undefined && validateCommand(entry, commandValidationSource()) };
      }) ?? null,
  };
}

/**
 * Publish `cardId`'s facts and advice from now on: once at install, and again
 * on every notify of the card's session store, the restore registry, the
 * services store, the title store, the title-bar items store, the page's
 * responder chain, the close-guard registry and the card's own close guard,
 * and on every `input` in the document.
 * A capture-phase `pointerdown` asks for activation. Returns the uninstall.
 */
export function installBodyPublisher(
  cardId: string,
  send: (message: BusMessage) => void,
): () => void {
  const publisher = new BodyPublisher(
    {
      readFacts: () => readBodyCardFacts(cardId),
      readWaive: () => readCardCloseAdvice(cardId)?.waive === true,
      readGuarded: () => cardMayFold(cardId),
      readAsks: () => {
        const guard = getCardCloseGuard(cardId);
        return guard === null ? null : guard.needsDecision();
      },
    },
    send,
  );
  // The chain answers the title-bar items' enablement, and it changes with no
  // other notice — a responder registering, the key card moving — so the
  // publisher hears it too. The chain mounts with the page's React tree,
  // after this install, so it is attached on the first publish that finds it.
  let releaseChain: (() => void) | null = null;
  const publish = (): void => {
    if (releaseChain === null) releaseChain = getResponderChainManager()?.subscribe(publish) ?? null;
    publisher.publish();
  };

  // The session store is rebuilt when the card rebinds, so its subscription
  // follows the services store.
  let releaseSession: (() => void) | null = null;
  let watched: unknown = null;
  const followSession = (): void => {
    const store = cardServicesStore.getServices(cardId)?.codeSessionStore ?? null;
    if (store === watched) return;
    releaseSession?.();
    watched = store;
    releaseSession = store === null ? null : store.subscribe(publish);
  };
  const onServices = (): void => {
    followSession();
    publish();
  };
  const onPointerDown = (): void => publisher.pointerDown();

  const releases = [
    cardServicesStore.subscribe(onServices),
    sessionRestoreRegistry.subscribe(publish),
    cardTitleStore.subscribe(publish),
    paneTitleBarItemsStore.subscribe(publish),
    // The card's close guard says when its answer moves, so the shell's proxy
    // reads a fact that moved with the buffer, not with whatever else notified.
    watchCardCloseGuard(cardId, publish),
  ];
  document.addEventListener("input", publish, true);
  document.addEventListener("pointerdown", onPointerDown, true);
  followSession();
  publish();

  return () => {
    for (const release of releases) release();
    releaseSession?.();
    releaseChain?.();
    document.removeEventListener("input", publish, true);
    document.removeEventListener("pointerdown", onPointerDown, true);
  };
}
