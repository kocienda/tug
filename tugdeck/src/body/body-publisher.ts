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
 * A card held by a modal run (`/compact` in flight) says so (`modal-hold`),
 * with the reason and whether the run admits the fold, and says again when
 * the hold goes. The shell's chrome holds by it, and a door there that meets
 * the hold asks this page to speak the refusal (`refuse-hold`).
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
import { restorePassGate, sessionRestoreRegistry } from "../lib/session-restore";
import { readCardCloseAdvice } from "../lib/card-close-advice";
import { getCardCloseGuard, watchCardCloseGuard } from "../lib/card-close-guard";
import { cardMayFold } from "../lib/card-fold";
import { cardModalHoldStore } from "../lib/card-modal-hold-store";
import { ownLiveCardIdentity } from "../lib/card-identity";
import { paneTitleBarItemsStore } from "../lib/pane-title-bar-items-store";
import { commandValidationSource } from "../lib/host-menu-state";
import { commandEntry, validateCommand } from "../components/tugways/command-registry";
import { getResponderChainManager } from "../action-registry";
import { getFocusManager, observeFocusManagerRegistration } from "../components/tugways/focus-manager";
import { cardJoinReady, sessionPhaseFromSnapshot } from "../lib/code-session-store/use-session-phase";
import { cardSessionBindingStore } from "../lib/card-session-binding-store";
import type { CodeSessionSnapshot } from "../lib/code-session-store";
import { deriveRestoreGateHold } from "../lib/session-card-restore-gate";
import { contentTelemetry } from "../lib/rail-fit";

/** What the publisher reads, each answered fresh on every call. */
export interface BodyPublisherSources {
  readFacts(): CardFacts;
  /** The card's close advice: true when a close need not confirm. */
  readWaive(): boolean;
  /** The card's fold guard: true when a fold may proceed. */
  readGuarded(): boolean;
  /** Whether the card's close guard would ask, or null when it registered none. */
  readAsks(): boolean | null;
  /** The card's modal hold — its reason and whether it admits the fold — or null when it has none. */
  readHold(): { reason: string; admitsFold: boolean } | null;
}

export class BodyPublisher {
  private lastFacts: string | null = null;
  private lastWaive: boolean | null = null;
  private lastGuarded: boolean | null = null;
  private lastAsks: boolean | null = null;
  private lastHold: string | null = null;

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
    const hold = this.sources.readHold();
    const holdEncoded = JSON.stringify(hold);
    // The first read of no hold says nothing: the shell holds none until told.
    if (holdEncoded !== (this.lastHold ?? "null")) {
      this.lastHold = holdEncoded;
      this.send({
        kind: "card-advice",
        payload:
          hold === null
            ? { advice: "modal-hold", reason: null }
            : { advice: "modal-hold", reason: hold.reason, admitsFold: hold.admitsFold },
      });
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

/**
 * The card's cold restore, for the shell's restore gate (`restore-gate-store.ts`),
 * which holds the app-modal for a body card as it did for a shell-hosted one
 * ([B29] of the bodies migration): `restoreHold` 1 for as long as
 * `deriveRestoreGateHold` holds the card — the replay window and the reveal
 * behind it — with the turns loaded and asked for beside it; nothing at all
 * otherwise, so a turn outside a restore moves no fact. The silence deadline
 * is the card's own store's, so a stalled replay errors the card here and the
 * hold goes with the next publish. Telemetry, because it is the card's own
 * opaque numbers: the bus carries it without a shape of its own.
 */
export function restoreHoldTelemetry(snapshot: CodeSessionSnapshot | null): Record<string, number> {
  if (snapshot === null || !deriveRestoreGateHold(snapshot)) return {};
  return {
    restoreHold: 1,
    restoreTurnsLoaded: snapshot.transcript.length,
    restoreTurnsTarget: snapshot.restoreWindowTurns,
  };
}

/**
 * Whether this page paints keyboard-focus mode (`kbfPaint`, 0 or 1), once its
 * focus engine stands: the shell wears this page's answer while this card
 * holds the keyboard, so a caret live here stands the shell's paint down too
 * (`lib/yielded-kbf-paint.ts`).
 */
export function kbfPaintTelemetry(): Record<string, number> {
  const manager = getFocusManager();
  return manager === null ? {} : { kbfPaint: manager.kbfPainting() ? 1 : 0 };
}

/** The card's facts as its stores hold them now. */
export function readBodyCardFacts(cardId: string, readContent = false): CardFacts {
  const masthead = cardTitleStore.getMasthead(cardId);
  const snapshot = cardServicesStore.getServices(cardId)?.codeSessionStore.getSnapshot() ?? null;
  return {
    title: cardTitleStore.get(cardId) ?? "",
    masthead: masthead === null ? null : (masthead as unknown as BusMasthead),
    // The key with the card's arc join folded in, as `useSessionPhase` reads
    // it here: every other page reads this card's phase from this report.
    activity: snapshot === null ? null : sessionPhaseFromSnapshot(snapshot, cardJoinReady(cardId)),
    telemetry: {
      canInterrupt: snapshot?.canInterrupt === true ? 1 : 0,
      compacted: snapshot !== null && snapshot.compactionSeed !== null ? 1 : 0,
      ...restoreHoldTelemetry(snapshot),
      // The card's content height and what its scroller shows, for the
      // shell's Resize Sidebars to Fit, which cannot read this page.
      ...(readContent ? contentTelemetry() : {}),
      ...kbfPaintTelemetry(),
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
 * on every notify of the card's session store, the restore registry and the
 * restore pass's gate (an unattached Session card waives its close confirm
 * only once the pass has settled), the
 * services store, the title store, the title-bar items store, the page's
 * responder chain, the modal-hold store, the close-guard registry and the
 * card's own close guard,
 * and on every `input` in the document.
 * A capture-phase `pointerdown` asks for activation. Returns the uninstall.
 */
export function installBodyPublisher(
  cardId: string,
  send: (message: BusMessage) => void,
  options: { watchContent?: boolean } = {},
): () => void {
  const publisher = new BodyPublisher(
    {
      readFacts: () => readBodyCardFacts(cardId, options.watchContent === true),
      readWaive: () => readCardCloseAdvice(cardId)?.waive === true,
      readGuarded: () => cardMayFold(cardId),
      readAsks: () => {
        const guard = getCardCloseGuard(cardId);
        return guard === null ? null : guard.needsDecision();
      },
      readHold: () => {
        const hold = cardModalHoldStore.getFor(cardId);
        return hold === null ? null : { reason: hold.reason, admitsFold: hold.admitsFold === true };
      },
    },
    send,
  );
  // The chain answers the title-bar items' enablement, and it changes with no
  // other notice — a responder registering, the key card moving — so the
  // publisher hears it too. The chain mounts with the page's React tree,
  // after this install, so it is attached on the first publish that finds it.
  let releaseChain: (() => void) | null = null;
  // The card's content element resizes with no store notice — a rail card's
  // rows load, its pane is resized — so the content reading the facts carry
  // is watched where it changes. The element mounts with the card, after
  // this install, so it is looked for again on every publish.
  // Only a rail card's kind is read for its content (`watchContent`); the
  // root renders after this install, so its content element is waited for.
  let watchedContent: Element | null = null;
  const contentWatch =
    options.watchContent !== true || typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => publisher.publish());
  const watchContent = (): void => {
    if (contentWatch === null) return;
    const content = document.querySelector("[data-card-content]");
    if (content === watchedContent) return;
    contentWatch.disconnect();
    watchedContent = content;
    if (content === null) return;
    contentArrival?.disconnect();
    contentArrival = null;
    contentWatch.observe(content);
  };
  let contentArrival: MutationObserver | null =
    contentWatch === null || typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver(() => {
          if (document.querySelector("[data-card-content]") !== null) publish();
        });
  contentArrival?.observe(document, { childList: true, subtree: true });
  const publish = (): void => {
    if (releaseChain === null) releaseChain = getResponderChainManager()?.subscribe(publish) ?? null;
    watchContent();
    publisher.publish();
  };
  // The focus engine's paint answer moves with no store notice, and the
  // engine mounts after this install — on a card whose stores may never
  // notify again — so its registration is heard, and the engine followed.
  let releaseFocus: (() => void) | null = null;
  const followFocus = (): void => {
    releaseFocus?.();
    releaseFocus = getFocusManager()?.subscribe(publish) ?? null;
    publish();
  };
  const releaseFocusRegistration = observeFocusManagerRegistration(followFocus);

  // The session store is rebuilt when the card rebinds, so its subscription
  // follows the services store.
  let releaseSession: (() => void) | null = null;
  let watched: unknown = null;
  const followSession = (): void => {
    const services = cardServicesStore.getServices(cardId);
    const store = services?.codeSessionStore ?? null;
    if (store === watched) return;
    releaseSession?.();
    watched = store;
    // The changes feed moves the arc's join offer, which the phase key folds in.
    const changes = services?.changesController ?? null;
    const releases = [store?.subscribe(publish), changes?.subscribe(publish)];
    releaseSession = store === null ? null : () => releases.forEach((release) => release?.());
  };
  const onServices = (): void => {
    followSession();
    publish();
  };
  const onPointerDown = (): void => publisher.pointerDown();

  const releases = [
    cardServicesStore.subscribe(onServices),
    sessionRestoreRegistry.subscribe(publish),
    restorePassGate.subscribe(publish),
    // The card's arc binding, which the phase key's join offer reads.
    cardSessionBindingStore.subscribe(publish),
    cardTitleStore.subscribe(publish),
    paneTitleBarItemsStore.subscribe(publish),
    // A run's hold moves the fold guard as well as the hold itself.
    cardModalHoldStore.subscribe(publish),
    // The card's close guard says when its answer moves, so the shell's proxy
    // reads a fact that moved with the buffer, not with whatever else notified.
    watchCardCloseGuard(cardId, publish),
  ];
  document.addEventListener("input", publish, true);
  document.addEventListener("pointerdown", onPointerDown, true);
  // What the scroller shows moves with the page, which resizes with its pane.
  window.addEventListener("resize", publish);
  followSession();
  followFocus();

  return () => {
    contentWatch?.disconnect();
    contentArrival?.disconnect();
    window.removeEventListener("resize", publish);
    for (const release of releases) release();
    releaseSession?.();
    releaseChain?.();
    releaseFocusRegistration();
    releaseFocus?.();
    document.removeEventListener("input", publish, true);
    document.removeEventListener("pointerdown", onPointerDown, true);
  };
}
