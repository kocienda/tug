/**
 * What a body tells the shell about its card: the card's own shared stores
 * (`bus/declarations/card.ts`), set on every read.
 *
 * The shell draws a body card's chrome — its masthead, its phase, its close
 * and fold gestures — from the card's `card.facts` and `card.holds`. Close
 * advice and the fold guard are asked synchronously at gesture time in the
 * shell, so across pages the body keeps them current and the shell answers
 * from its replica. A store sends only a value that changed, so a keystroke
 * that leaves `waive` where it was sends nothing.
 *
 * A card that registered a close guard — a Text card holding unsaved edits —
 * also says whether its guard would ask (`closeGuardAsks`), so the shell's
 * close gesture can front the card before it asks the body to decide. A
 * card with no guard says null, and the shell closes it as it always has.
 *
 * A card held by a modal run (`/compact` in flight) says so (`modalHold`),
 * with the reason and whether the run admits the fold. The shell's chrome
 * holds by it, and a door there that meets the hold asks this page to speak
 * the refusal (`refuse-hold`).
 *
 * {@link BodyPublisher} sets the stores from plain read functions, so it is
 * tested on the test bus without a document; {@link installBodyPublisher}
 * wires it to the card's stores and the document.
 *
 * @module body/body-publisher
 */

import type { PageBus } from "../bus/page-bus";
import { pageBus } from "../bus/page-bus";
import {
  cardContent,
  cardFacts,
  cardHolds,
  cardKbfPaint,
  cardRestoreHold,
  type CardFactsValue,
} from "../bus/declarations/card";
import { cardActivate } from "../bus/declarations/verbs";
import { chordCaptureState } from "../lib/chord-capture-state";
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
import { readPageContent } from "../lib/rail-fit";

/** What the publisher reads, each answered fresh on every call. */
export interface BodyPublisherSources {
  readFacts(): CardFactsValue;
  /** The card's close advice: true when a close need not confirm. */
  readWaive(): boolean;
  /** The card's fold guard: true when a fold may proceed. */
  readGuarded(): boolean;
  /** Whether the card's close guard would ask, or null when it registered none. */
  readAsks(): boolean | null;
  /** The card's modal hold — its reason and whether it admits the fold — or null when it has none. */
  readHold(): { reason: string; admitsFold: boolean } | null;
  /** Whether a chord capture is armed in the card. */
  readCaptureArmed(): boolean;
  /** The card's cold restore while the restore gate holds it, or null. */
  readRestoreHold(): { turnsLoaded: number; turnsTarget: number } | null;
  /** The card's content reading, for a rail card, or null. */
  readContent(): { content: number; shown: number } | null;
  /** Whether the page paints keyboard-focus mode, or null before its focus engine stands. */
  readKbfPaint(): boolean | null;
}

/** The chrome a card draws in its own page that the host carries a press on. */
const CHROME_PRESS_SURFACES = ".body-chrome-frame .tug-pane-title-bar, .body-chrome-frame .tug-pane-resize";

export class BodyPublisher {
  constructor(
    private readonly sources: BodyPublisherSources,
    private readonly bus: PageBus,
  ) {}

  /** Read every fact and hold, and set the card's stores; each sends only what changed. */
  publish(): void {
    const s = this.sources;
    cardFacts.on(this.bus).set(s.readFacts());
    cardHolds.on(this.bus).set({
      waive: s.readWaive(),
      guarded: s.readGuarded(),
      closeGuardAsks: s.readAsks(),
      modalHold: s.readHold(),
      captureArmed: s.readCaptureArmed(),
    });
    cardRestoreHold.on(this.bus).set(s.readRestoreHold());
    cardContent.on(this.bus).set(s.readContent());
    cardKbfPaint.on(this.bus).set(s.readKbfPaint());
  }

  /**
   * A pointer went down in the body: ask to be activated, every time. What
   * the body last heard about being first responder can be a press behind,
   * so it is not the judge: a second press that lands before the context
   * the first one earned would otherwise go unasked, and the keyboard and
   * the shell's key card would part. The shell knows, and an activation of
   * the card already key costs it nothing.
   *
   * A press on the chrome a card draws in its own page — its title bar or a
   * grip — is the pointer's activation, which slides no strip under the
   * hand (`reveal: false`): the host carries the press, and a click's
   * release reveals the card (`host-card-gesture.ts`).
   */
  pointerDown(onChrome = false): void {
    cardActivate.on(this.bus).dispatch({ reveal: onChrome ? false : undefined });
  }
}

/**
 * The card's cold restore, for the shell's restore gate (`restore-gate-store.ts`),
 * which holds the app-modal for a body card as it did for a shell-hosted one
 * ([B29] of the bodies migration): the turns loaded and asked for, for as
 * long as `deriveRestoreGateHold` holds the card — the replay window and the
 * reveal behind it — and null otherwise, so a turn outside a restore moves
 * nothing. The silence deadline is the card's own store's, so a stalled
 * replay errors the card here and the hold goes with the next publish.
 */
export function readRestoreHold(snapshot: CodeSessionSnapshot | null): { turnsLoaded: number; turnsTarget: number } | null {
  if (snapshot === null || !deriveRestoreGateHold(snapshot)) return null;
  return { turnsLoaded: snapshot.transcript.length, turnsTarget: snapshot.restoreWindowTurns };
}

/**
 * Whether this page paints keyboard-focus mode, once its focus engine
 * stands: the shell wears this page's answer while this card holds the
 * keyboard, so a caret live here stands the shell's paint down too.
 */
export function readKbfPaint(): boolean | null {
  return getFocusManager()?.kbfPainting() ?? null;
}

/** The card's facts as its stores hold them now. */
export function readBodyCardFacts(cardId: string): CardFactsValue {
  const masthead = cardTitleStore.getMasthead(cardId);
  const snapshot = cardServicesStore.getServices(cardId)?.codeSessionStore.getSnapshot() ?? null;
  return {
    title: cardTitleStore.get(cardId) ?? "",
    masthead,
    // The key with the card's arc join folded in, as `useSessionPhase` reads
    // it here: every other page reads this card's phase from this report.
    activity: snapshot === null ? null : sessionPhaseFromSnapshot(snapshot, cardJoinReady(cardId)),
    canInterrupt: snapshot?.canInterrupt === true,
    compacted: snapshot !== null && snapshot.compactionSeed !== null,
    // What the card holds as this page's own registries know it; the shell's
    // identity reads for the card answer from it.
    identity: ownLiveCardIdentity(cardId),
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

/** An installed publisher: publish now, synchronously, or uninstall. */
export interface InstalledBodyPublisher {
  publish(): void;
  release(): void;
}

/**
 * Publish `cardId`'s facts and holds from now on: once at install, and again
 * on every notify of the card's session store, the restore registry and the
 * restore pass's gate (an unattached Session card waives its close confirm
 * only once the pass has settled), the
 * services store, the title store, the title-bar items store, the page's
 * responder chain, the modal-hold store, the chord capture, the close-guard
 * registry and the card's own close guard,
 * and on every `input` in the document.
 * A capture-phase `pointerdown` asks for activation (`card.activate`), unless
 * ⌘ is held.
 */
export function installBodyPublisher(
  cardId: string,
  options: { watchContent?: boolean },
): InstalledBodyPublisher {
  const publisher = new BodyPublisher(
    {
      readFacts: () => readBodyCardFacts(cardId),
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
      readCaptureArmed: () => chordCaptureState.isArmed(),
      readRestoreHold: () => readRestoreHold(cardServicesStore.getServices(cardId)?.codeSessionStore.getSnapshot() ?? null),
      // The card's content height and what its scroller shows, for the
      // shell's Resize Sidebars to Fit, which cannot read this page.
      readContent: () => (options.watchContent === true ? readPageContent() : null),
      readKbfPaint,
    },
    pageBus(),
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
  // A ⌘-press interacts with a background card without raising it, the Mac
  // convention the shell's own press keeps (`gesture-interpreter.ts`): a
  // ⌘-click on the chrome looks at the stack, a ⌘-drag moves the card.
  // A secondary-button press raises a context menu without activating the
  // card, the same convention the shell's press keeps (`button !== 0`,
  // `gesture-interpreter.ts`): a right-click on a background card's content
  // does not take the keyboard or move the deck's first responder.
  const onPointerDown = (event: PointerEvent): void => {
    if (event.metaKey || event.button !== 0) return;
    publisher.pointerDown(event.target instanceof Element && event.target.closest(CHROME_PRESS_SURFACES) !== null);
  };

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
    // A chord capture armed here parks the host's menu bar, which the shell pushes.
    chordCaptureState.subscribe(publish),
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

  return {
    publish,
    release: () => {
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
    },
  };
}
