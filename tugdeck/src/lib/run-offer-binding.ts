/**
 * `run-offer-binding` — what joins a container's runnable offers to the
 * card's shell session.
 *
 * Two functions over one container of rendered markdown, both stateless:
 * {@link syncRunOffers} draws every offer frame in it from the shell
 * session's stores, and {@link pressRunOffer} turns a click on a frame's Play
 * into a run or a stop. Every fact they act on is read at the call: the
 * frames from the live DOM, since a rebuild replaces them, and the runs from
 * {@link RunOfferStore}, since the DOM is not where a result is kept.
 *
 * @module lib/run-offer-binding
 */

import {
  RUN_OFFER_ADD_CLASS,
  RUN_FRAME_SELECTOR,
  RUN_OFFER_PLAY_CLASS,
  runOfferCommand,
  runOfferFrames,
  runOfferNeedsTerminal,
  syncRunOfferFrame,
} from "./markdown/enhance-run-offer";
import { runOfferKey, type RunOfferRun, type RunOfferStore } from "./run-offer-store";
import type { ShellSessionStore } from "./shell-session-store";
import { tugDevLogStore } from "./tug-dev-log-store/tug-dev-log-store";

/**
 * The offer frames of a container, each with the key of the offer it draws
 * and the run that belongs to it. The run is matched among all the offers
 * of the container at once, because an offer whose position shifted is told
 * from one that was never run by which positions are still held.
 */
function keyedFrames(
  container: HTMLElement,
  offers: RunOfferStore,
  scope: string,
): Array<{ frame: HTMLElement; key: string; command: string; run: RunOfferRun | undefined }> {
  const keyed = runOfferFrames(container).map((frame, index) => {
    const command = runOfferCommand(frame);
    return { frame, command, key: runOfferKey(scope, index, command) };
  });
  const present = new Set(keyed.map((entry) => entry.key));
  return keyed.map((entry) => ({ ...entry, run: offers.match(entry.key, present) }));
}

/**
 * Draw every offer in `container`.
 *
 * `commandsFinal` is whether the text the offers were written in has stopped
 * changing. Until it has, Play stays disabled: the click is the user's
 * consent to the command they can see, and a command still streaming is not
 * yet the one they would be consenting to. Play is also disabled while any
 * exchange is in flight, because the shell runs one command at a time; the
 * offer that is running shows Stop.
 */
export function syncRunOffers(
  container: HTMLElement,
  shell: ShellSessionStore,
  scope: string,
  commandsFinal: boolean,
): void {
  const canRun = commandsFinal && shell.getSnapshot().inflight === null;
  const hasQueue = shell.hasContextQueue();
  for (const { frame, run } of keyedFrames(container, shell.offers, scope)) {
    syncRunOfferFrame(frame, {
      canRun,
      run,
      staged: !hasQueue ? null : run !== undefined && shell.offerRunStaged(run),
    });
  }
}

/**
 * Draw every offer in `container` as a picture of the card it came from:
 * Play shown as it stands on a finished turn, and each offer's run under it.
 * Nothing here can run, so nothing listens for a press, and a result offers
 * no Add to context, which belongs to a card's queue.
 */
export function drawRunOffers(container: HTMLElement, offers: RunOfferStore, scope: string): void {
  for (const { frame, run } of keyedFrames(container, offers, scope)) {
    syncRunOfferFrame(frame, { canRun: true, run, staged: null });
  }
}

/**
 * Act on a click inside `container`. Returns whether the click was on one of
 * an offer's controls, so the caller knows it was handled.
 *
 * A press on a running offer stops it. A press on any other starts it,
 * through the same `exec` every shell command goes through, so the refusals
 * that door makes apply here unchanged. A press on a result's Add to context
 * queues that result for the next submission, or takes it back out.
 */
export function pressRunOffer(
  target: EventTarget | null,
  container: HTMLElement,
  shell: ShellSessionStore,
  scope: string,
): boolean {
  if (!(target instanceof Element)) return false;
  const add = target.closest(`.${RUN_OFFER_ADD_CLASS}`);
  if (add !== null && container.contains(add)) {
    const owner = add.closest(RUN_FRAME_SELECTOR);
    const run = keyedFrames(container, shell.offers, scope).find((entry) => entry.frame === owner)?.run;
    if (run !== undefined) shell.toggleOfferRunContext(run);
    return true;
  }
  const play = target.closest(`.${RUN_OFFER_PLAY_CLASS}`);
  if (play === null || !container.contains(play)) return false;
  const frame = play.closest(RUN_FRAME_SELECTOR);
  const hit = keyedFrames(container, shell.offers, scope).find((entry) => entry.frame === frame);
  if (hit === undefined) return true;

  if (hit.run?.status === "running") {
    shell.kill();
    return true;
  }
  // An offer that needs a terminal draws no Play; a click that reached one
  // anyway starts nothing.
  if (frame instanceof HTMLElement && runOfferNeedsTerminal(frame)) return true;
  shell.exec(hit.command, { origin: "offer", offerKey: hit.key });
  // The offer's earlier run may sit under the position the offer used to
  // hold. Once this press has an answer under the offer's own key, that one
  // is replaced like any other earlier run.
  if (hit.run !== undefined && hit.run.key !== hit.key && shell.offers.get(hit.key) !== undefined) {
    shell.offers.forget(hit.run.key);
  }
  // `exec` answers every command it takes with a run or a refusal. A press
  // that left neither went nowhere, and silence is the one answer a press
  // may not get.
  if (shell.offers.get(hit.key) === undefined) {
    tugDevLogStore.warn("run-offer", "play pressed and nothing started", {
      inflight: shell.getSnapshot().inflight !== null,
      emptyCommand: hit.command.trim().length === 0,
    });
  }
  return true;
}
