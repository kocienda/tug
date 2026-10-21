/**
 * The verbs the shell asks of a card's body, answered in the body.
 *
 * Each is a routed action owned by the card (`bus/declarations/verbs.ts`):
 * the shell dispatches it to the card, the bus holds it until the card's
 * page has said hello, and this page runs it against what only it holds —
 * its chain and registry, its focus walk, its card's editor, stores and
 * modal run. The two questions the shell asks — a close decision and a
 * question for the card's session — are requests the same way, answered
 * by the person at the card. `bindBody` answers them for its card before it
 * says hello.
 *
 * @module body/body-verbs
 */

import type { PageBus } from "../bus/page-bus";
import {
  cardCloseDecision,
  cardContentAction,
  cardFlash,
  cardRefuseHold,
  cardsShrink,
  commandForCard,
  devtoolsLogEntries,
  focusEnter,
  focusExit,
  jotsNewJot,
  sessionAsk,
  sessionIntent,
  settingsReveal,
  textRevealLine,
} from "../bus/declarations/verbs";
import { dispatchCommand, sendToCardContent } from "../command-dispatch";
import { shrinkCardsState } from "../components/cards/cards-escape";
import { enterKeyViewWalk, getFocusManager } from "../components/tugways/focus-manager";
import { getCardCloseGuard } from "../lib/card-close-guard";
import { endPaneFrameFlash, flashPaneFrame } from "../lib/flash-pane-border";
import * as paneFrameRegistry from "../components/chrome/pane-frame-registry";
import { bodyPaneId } from "./body-card-deck";
import { refuseCardModalHold } from "../lib/card-modal-hold-store";
import { cardServicesStore } from "../lib/card-services-store";
import type { PendingAsk } from "../lib/code-session-store/types";
import { pendingAskStore } from "../lib/pending-ask-store";
import { CARDS_CARD_ID } from "../lib/cards-card-id";
import { getJotsStore } from "../lib/jots-store";
import { requestSettingsReveal } from "../lib/settings-reveal";
import { SETTINGS_SECTION_IDS, type SettingsSectionId } from "../lib/settings-sections-pref";
import { getOpenTextCard } from "../lib/text-card-open-registry";
import { tugDevLogStore } from "../lib/tug-dev-log-store/tug-dev-log-store";
import { TUG_DEV_LOG_LEVELS, type TugDevLogEntry, type TugDevLogLevel } from "../lib/tug-dev-log-store/types";
import { parseBodyIntent, type BodyIntent } from "./body-intent";

/** What answering the verbs needs of the bound page. */
export interface BodyVerbHost {
  cardId: string;
  componentId: string;
  /** Replay a session the shell decided for the card after handing it here, as the bind's own intent was. */
  replayIntent(intent: BodyIntent): void;
}

/** Whether `value` is a log entry as the shell relays one, its id left to this page. */
function isRelayedLogEntry(value: unknown): value is Omit<TugDevLogEntry, "id"> {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<Omit<TugDevLogEntry, "id">>;
  return (
    typeof entry.timestamp === "number" &&
    typeof entry.level === "string" &&
    TUG_DEV_LOG_LEVELS.includes(entry.level as TugDevLogLevel) &&
    typeof entry.source === "string" &&
    typeof entry.message === "string"
  );
}

/** Answer the shell's verbs for `host`'s card on `bus`. Returns the release. */
export function answerBodyVerbs(bus: PageBus, host: BodyVerbHost): () => void {
  const { cardId, componentId } = host;
  // A ring told before this page's frame has mounted — a card the shell rang
  // as it made it — waits for the frame rather than being lost.
  const framePaneId = bodyPaneId(cardId);
  let awaitFrame: (() => void) | null = null;
  const stopAwaitingFrame = (): void => {
    awaitFrame?.();
    awaitFrame = null;
  };
  const releases: Array<() => void> = [
    // A command whose owner is the key card, routed here while this card is
    // key: it runs against this page's own chain, whose key card is the
    // card's pane responder (`BodyRoot`), and its own registry.
    commandForCard.on(bus).handle(({ id, payload }) => {
      dispatchCommand(id, payload);
    }),
    // The walk coming back in from the shell lands on this page's first or
    // last stop; with none, it goes back out, marked so the shell keeps it
    // rather than handing it here again.
    focusEnter.on(bus).handle(({ edge }) => {
      if (enterKeyViewWalk(getFocusManager(), edge)) return;
      focusExit.on(bus).dispatch({ direction: edge === "first" ? "next" : "previous", empty: true });
    }),
    // A chain action the shell addressed to this card's content: this page's
    // chain holds that responder, and nothing forwards it on from here.
    cardContentAction.on(bus).handle(({ action }) => {
      sendToCardContent(cardId, action);
    }),
    // The shell rang this card's pane, or rang another subject: the ring is
    // drawn on this page's frame, which stands opaque over the shell's.
    cardFlash.on(bus).handle(({ lit }) => {
      stopAwaitingFrame();
      const frame = paneFrameRegistry.getElement(framePaneId);
      if (!lit) {
        if (frame !== null) endPaneFrameFlash(frame);
        return;
      }
      if (frame !== null) {
        flashPaneFrame(frame);
        return;
      }
      awaitFrame = paneFrameRegistry.subscribe(framePaneId, () => {
        const mounted = paneFrameRegistry.getElement(framePaneId);
        if (mounted === null) return;
        stopAwaitingFrame();
        flashPaneFrame(mounted);
      });
    }),
    // An open of the file this card holds, from another page: the line it
    // asked for is revealed in this card's own editor.
    textRevealLine.on(bus).handle(({ line, endLine, columns }) => {
      getOpenTextCard(cardId)?.revealLine(line, endLine, columns);
    }),
    // A reveal the shell parked for the Settings card, now that this page
    // holds it: the card's own consumer takes it.
    settingsReveal.on(bus).handle(({ section }) => {
      if (SETTINGS_SECTION_IDS.includes(section as SettingsSectionId)) requestSettingsReveal(section as SettingsSectionId);
    }),
    // ⌘J's capture, for this Jots card: the editor opens from this page's store.
    jotsNewJot.on(bus).handle(() => {
      getJotsStore().createJot(null);
    }),
    // A session the shell decided for this card after handing it here — a
    // harness spawn, a resume asked for elsewhere.
    sessionIntent.on(bus).handle((raw) => {
      const intent = parseBodyIntent(raw);
      if (intent === null) {
        tugDevLogStore.error("body", "a forwarded intent did not parse; ignored", { cardId });
        return;
      }
      host.replayIntent(intent);
    }),
    // A door in the shell met this card's modal hold: the run holding it
    // speaks the refusal here, in the card it concerns.
    cardRefuseHold.on(bus).handle(() => {
      refuseCardModalHold(cardId);
    }),
    // The shell's log, for the devtools card's Log tab: this page logs
    // almost nothing of its own.
    devtoolsLogEntries.on(bus).handle(({ entries }) => {
      tugDevLogStore.adopt("shell", entries.filter(isRelayedLogEntry));
    }),
    // The shell's close gesture asks this card's own close guard: its sheet
    // comes up here, in the card it concerns, and its answer is the reply.
    cardCloseDecision.on(bus).handle(async () => {
      const guard = getCardCloseGuard(cardId);
      return { answer: guard === null ? ("close" as const) : await guard.run() };
    }),
    sessionAsk.on(bus).handle((ask, _from, signal) => showAsk(cardId, ask, signal)),
  ];
  // The shell's Escape met a layout selection: the Cards table runs here,
  // where the filter is (`cards-escape.ts`).
  if (componentId === CARDS_CARD_ID) {
    releases.push(
      cardsShrink.on(bus).handle(() => {
        shrinkCardsState();
      }),
    );
  }
  return () => {
    stopAwaitingFrame();
    for (const release of releases.splice(0)) release();
  };
}

/**
 * Park `ask` on `cardId`'s session, so its dialog comes up in this page, and
 * resolve with the choice made there. A session this page has not stood up
 * yet — the card is still restoring — shows it once it stands. A withdrawal,
 * or the shell going away, takes the dialog down.
 */
function showAsk(cardId: string, ask: PendingAsk, signal: AbortSignal): Promise<{ choice: string }> {
  return new Promise((resolve) => {
    let parkedOn: { setPendingAsk(ask: PendingAsk | null): void } | null = null;
    let unwatch: (() => void) | null = null;
    const show = (): boolean => {
      const session = cardServicesStore.getServices(cardId)?.codeSessionStore ?? null;
      if (session === null) return false;
      parkedOn = session;
      session.setPendingAsk(ask);
      return true;
    };
    const stopWatching = (): void => {
      unwatch?.();
      unwatch = null;
    };
    // The dialog's answer comes back through the page's store, which sees a
    // question it does not hold and hands the choice here.
    const releaseRelay = pendingAskStore.relay(ask.requestId, (choice) => {
      releaseRelay();
      stopWatching();
      resolve({ choice });
    });
    signal.addEventListener(
      "abort",
      () => {
        releaseRelay();
        stopWatching();
        parkedOn?.setPendingAsk(null);
      },
      { once: true },
    );
    if (!show()) {
      unwatch = cardServicesStore.subscribe(() => {
        if (show()) stopWatching();
      });
    }
  });
}
