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
import { readCardFoldGuard } from "../lib/card-fold";
import { sessionPhaseFromSnapshot } from "../lib/code-session-store/use-session-phase";

/** What the publisher reads, each answered fresh on every call. */
export interface BodyPublisherSources {
  readFacts(): CardFacts;
  /** The card's close advice: true when a close need not confirm. */
  readWaive(): boolean;
  /** The card's fold guard: true when a fold may proceed. */
  readGuarded(): boolean;
  /** Whether the deck's first responder is this card. */
  isFirstResponder(): boolean;
}

export class BodyPublisher {
  private lastFacts: string | null = null;
  private lastWaive: boolean | null = null;
  private lastGuarded: boolean | null = null;

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
  }

  /** A pointer went down in the body: ask to be activated unless already the first responder. */
  pointerDown(): void {
    if (this.sources.isFirstResponder()) return;
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
  };
}

/**
 * Publish `cardId`'s facts and advice from now on: once at install, and again
 * on every notify of the card's session store, the restore registry, the
 * services store and the title store, and on every `input` in the document.
 * A capture-phase `pointerdown` asks for activation. Returns the uninstall.
 */
export function installBodyPublisher(
  cardId: string,
  isFirstResponder: () => boolean,
  send: (message: BusMessage) => void,
): () => void {
  const publisher = new BodyPublisher(
    {
      readFacts: () => readBodyCardFacts(cardId),
      readWaive: () => readCardCloseAdvice(cardId)?.waive === true,
      readGuarded: () => readCardFoldGuard(cardId),
      isFirstResponder,
    },
    send,
  );
  const publish = (): void => publisher.publish();

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
  ];
  document.addEventListener("input", publish, true);
  document.addEventListener("pointerdown", onPointerDown, true);
  followSession();
  publish();

  return () => {
    for (const release of releases) release();
    releaseSession?.();
    document.removeEventListener("input", publish, true);
    document.removeEventListener("pointerdown", onPointerDown, true);
  };
}
