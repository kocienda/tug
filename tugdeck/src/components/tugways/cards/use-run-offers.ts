/**
 * `useRunOffers` — make the runnable offers in one markdown block live.
 *
 * A `tugrun` fence is drawn by the markdown enhance pass, which knows nothing
 * of the card it is in, so the frame it builds can only be copied. This hook
 * is the card's half: handed to the block as `onAnnotated`, it adopts the
 * frames after every pass, keeps them drawn from the card's shell session,
 * and runs or stops a command when its Play is pressed.
 *
 * The shell session arrives by context ({@link RunOfferShellContext}) and not
 * by prop, for the reason the annotation scope does: the block sits several
 * components below the transcript host, and none of the ones between has any
 * other use for it. Outside a provider the hook does nothing, and the offer
 * stays a block that can be copied.
 *
 * Laws:
 *  - [L22] the stores drive DOM writes, so they are observed directly and
 *    nothing round-trips through a render.
 *  - [L06] Play's pose and the result under the command are DOM, written from
 *    the store on every pass, never React state; a running result's clock is
 *    written the same way, once a second.
 *  - [L03] the store subscriptions are made in a layout effect, before a
 *    click could depend on them.
 *  - [L07] the click reads the scope and the shell through refs.
 *  - [L27] the click listener and both subscriptions hand back a release,
 *    called when the block unmounts.
 *
 * @module components/tugways/cards/use-run-offers
 */

import React from "react";

import { drawRunOffers, pressRunOffer, syncRunOffers } from "@/lib/run-offer-binding";
import { LivenessClock } from "@/lib/run-liveness";
import type { RunOfferStore } from "@/lib/run-offer-store";
import type { ShellSessionStore } from "@/lib/shell-session-store";

/** The shell session the offers beneath a transcript run in. */
export const RunOfferShellContext = React.createContext<ShellSessionStore | null>(null);

/**
 * The runs a page draws but cannot make: the share page's, which holds the
 * card's runs as they were when the share was made. Under it the offers look
 * as they do on the card, Play included, and nothing can be pressed. A shell
 * session, where there is one, wins.
 */
export const RunOfferRunsContext = React.createContext<RunOfferStore | null>(null);

/**
 * `scope` names the message the block renders, and is the first part of
 * every offer's key. It must read the same after a reload, because the key
 * is what a ledgered result finds its offer by. `commandsFinal` is whether
 * that message has finished streaming.
 *
 * Returns the callback to hand `TugMarkdownBlock` as `onAnnotated`.
 */
export function useRunOffers(
  scope: string,
  commandsFinal: boolean,
): (container: HTMLElement) => void {
  const shell = React.useContext(RunOfferShellContext);
  const drawn = React.useContext(RunOfferRunsContext);
  const live = React.useRef({ shell, drawn, scope, commandsFinal });
  live.current = { shell, drawn, scope, commandsFinal };

  /** The container last annotated, and the release of the listener on it. */
  const listening = React.useRef<{ container: HTMLElement; release: () => void } | null>(null);

  // A running offer's footer reads elapsed time and the age of its last
  // output. The clock rewrites it in place and runs only while one is drawn.
  const clock = React.useRef<LivenessClock | null>(null);
  if (clock.current === null) {
    clock.current = new LivenessClock(() => listening.current?.container ?? null);
  }

  const sync = React.useCallback((): void => {
    const container = listening.current?.container;
    const { shell: store, drawn: runs, scope: at, commandsFinal: final } = live.current;
    if (container === undefined) return;
    if (store !== null) {
      syncRunOffers(container, store, at, final);
      clock.current?.check();
    } else if (runs !== null) drawRunOffers(container, runs, at);
  }, []);

  const onAnnotated = React.useCallback(
    (container: HTMLElement): void => {
      if (listening.current?.container !== container) {
        listening.current?.release();
        const onClick = (event: MouseEvent): void => {
          const store = live.current.shell;
          if (store === null) return;
          if (pressRunOffer(event.target, container, store, live.current.scope)) {
            event.preventDefault();
          }
        };
        container.addEventListener("click", onClick);
        listening.current = {
          container,
          release: () => container.removeEventListener("click", onClick),
        };
      }
      sync();
    },
    [sync],
  );

  // The shell's in-flight slot, the offers' runs and the context queue all
  // move a frame.
  React.useLayoutEffect(() => {
    if (shell === null) return;
    const releaseShell = shell.subscribe(sync);
    const releaseOffers = shell.offers.subscribe(sync);
    const releaseContext = shell.subscribeContext(sync);
    sync();
    return () => {
      releaseShell();
      releaseOffers();
      releaseContext?.();
    };
  }, [shell, sync]);

  // The message settling is what enables Play, and no store says so.
  React.useLayoutEffect(() => {
    sync();
  }, [scope, commandsFinal, sync]);

  React.useLayoutEffect(
    () => () => {
      listening.current?.release();
      listening.current = null;
      clock.current?.stop();
    },
    [],
  );

  return onAnnotated;
}
