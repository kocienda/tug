/**
 * quit-guard-store — whether a quit asks first, and the asking ([L02]).
 *
 * The Quit item asks the shell whether it will ask the user. With no turn in
 * flight the answer is no and the quit goes straight on; otherwise
 * {@link QuitGuard.request} bumps a monotonic nonce and the app-level
 * `QuitGuard` runs {@link QuitGuard.ask} in the shell's alert. A nonce, as in
 * `logout-store.ts`, so there is no state for the orchestrator to consume.
 *
 * "Active" is `liveTurnsStore`'s answer and never a second opinion ([L28]): it
 * folds in body cards, and it reads the same `canInterrupt` that the termination
 * pipeline acts on, so the guard cannot disagree with what a quit stops. The
 * guard only asks. Turns keep running under the alert, so Cancel costs nothing,
 * and a confirmed quit leaves the interrupting to `prepareForTermination`.
 *
 * Everything the guard reads arrives through {@link QuitGuardContext}, so the
 * decision is reachable from a unit test with no deck, no alert and no host.
 *
 * @module lib/quit-guard-store
 */

import { postToHost } from "../host/channel";
import { quitConfirmedToHost, quitRequestedToHost } from "../host/declarations/lifecycle";
import { useSyncExternalStore } from "@/lib/gesture-scope";
import { page } from "../bus/page";
import { getConnectionLifecycle } from "./connection-lifecycle";
import { liveTurnsStore } from "./live-turns-store";
import { Subscribable } from "./subscribable";

/** The Quit alert's message, naming what a quit would stop. */
export function quitConfirmMessage(titles: readonly string[]): string {
  if (titles.length === 1) return `'${titles[0]}' is still working. Quitting will stop it.`;
  return `${titles.length} sessions are still working: ${titles.join(", ")}. Quitting will stop them.`;
}

/** What the guard reads and does, structural so a test can pass plain objects. */
export interface QuitGuardContext {
  liveTurns: {
    getSnapshot: () => { readonly titles: readonly string[] };
    subscribe: (listener: () => void) => () => void;
  };
  /**
   * Whether a question can reach the person. The alert crosses to the overlay
   * over tugcast's bus feed, so with that wire down it would never draw, and
   * the turns it would protect have nothing left to run on.
   */
  canAsk: () => boolean;
  /** Go on with the quit. */
  quit: () => void;
}

/** The alert the guard shows, as `useTugAlert()` hands it. */
export type QuitAlert = (options: {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  confirm: { role: "danger" };
  signal: AbortSignal;
}) => Promise<boolean>;

export class QuitGuard extends Subscribable {
  private nonce = 0;
  private asking = false;

  constructor(private readonly context: QuitGuardContext) {
    super();
  }

  getSnapshot = (): number => this.nonce;

  /**
   * A quit was asked for: whether the user will be asked about it. False means
   * there is nothing to protect, or no way to ask, and the caller goes on with
   * the quit. A request made while the question is up joins it, and stacks no
   * second alert; the wire comes first, so a question it left stranded cannot
   * hold a later request.
   */
  request(): boolean {
    if (!this.context.canAsk()) return false;
    if (this.asking) return true;
    if (this.context.liveTurns.getSnapshot().titles.length === 0) return false;
    this.asking = true;
    this.nonce += 1;
    this.notify();
    return true;
  }

  /**
   * Show the question and act on its outcome. Confirming quits and Cancel does
   * not. The work ending while the question is up takes the question back and
   * quits, because the user already asked to and nothing is left to protect; a
   * turn starting after that reopens nothing.
   */
  async ask(showAlert: QuitAlert): Promise<void> {
    const { liveTurns, quit } = this.context;
    const { titles } = liveTurns.getSnapshot();
    if (titles.length === 0) {
      this.asking = false;
      quit();
      return;
    }
    const workEnded = new AbortController();
    const release = liveTurns.subscribe(() => {
      if (liveTurns.getSnapshot().titles.length === 0) workEnded.abort();
    });
    let confirmed = false;
    try {
      confirmed = await showAlert({
        title: "Quit Tug?",
        message: quitConfirmMessage(titles),
        confirmLabel: "Quit",
        cancelLabel: "Cancel",
        confirm: { role: "danger" },
        signal: workEnded.signal,
      });
    } finally {
      release();
      this.asking = false;
    }
    if (confirmed || workEnded.signal.aborted) quit();
  }
}

/** The shell's guard. A body or the overlay mounts no `QuitGuard`, so this is only ever the shell's to run. */
export const quitGuard = new QuitGuard({
  liveTurns: liveTurnsStore,
  canAsk: () => getConnectionLifecycle()?.isOpen() ?? true,
  quit: () => postToHost(quitConfirmedToHost, {}),
});

/**
 * ⌘Q from a page's funnel, which takes the chord ahead of AppKit, so every page
 * registers `quit-application` with this as its action. A card's body or the
 * overlay mounts no guard, and hands the request to the host: its bounded ask of
 * the shell is the Quit item's, and it holds when the shell or tugcast does not.
 * In the shell it is the same request that page call makes, except that nobody
 * is waiting on the answer, so "nothing to ask" goes on with the quit from here.
 */
export function requestQuit(): void {
  if (page.isBody) {
    postToHost(quitRequestedToHost, {});
    return;
  }
  if (!quitGuard.request()) postToHost(quitConfirmedToHost, {});
}

/** React read of the quit-request nonce ([L02]); changes each time the guard has a question to ask. */
export function useQuitRequest(): number {
  return useSyncExternalStore(quitGuard.subscribe, quitGuard.getSnapshot);
}
