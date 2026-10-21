/**
 * A body going dormant while hidden, and catching up when shown.
 *
 * The page's visibility store (`lib/body-visibility-store.ts`) says when a
 * body has been hidden past its delay. Then the body stops working on
 * behalf of nobody: it empties its session subscription — tugcast sends it
 * nothing of any session, so its ingest worker has nothing to ingest, parse
 * or publish — stills its loops through the motion switch, and withdraws any
 * surface it raises over the deck. It keeps its DOM and its stores, so a
 * reveal shows what it had. And it writes its bag once as it sleeps, so a
 * draft typed before it went quiet is on disk while it sleeps, and a crash
 * then loses nothing an eviction would have kept.
 *
 * Shown again, it re-scopes its subscription and asks its session for what
 * it missed (`CodeSessionStore.catchUp`). It stays dormant — loops still,
 * surface withheld, `card.facts` saying so — until that catch-up's bracket
 * closes, and then wakes.
 *
 * And from the moment it sleeps until it wakes its content box wears the
 * content lid ({@link BODY_DORMANT_ATTRIBUTE}): a reveal shows what the body
 * had before the catch-up lands, and the reading (row 35) put that at several
 * display periods, so the revealed pane shows whole with its content lidded
 * and the caught-up content arrives at once.
 *
 * The decisions are {@link nextDormancy}, pure over the visibility snapshot,
 * so they are unit tests over data; {@link installBodyDormancy} wires them to
 * the page.
 *
 * Laws: [L22] the store is subscribed to directly, not through React; [L06]
 * the loops are stilled by the motion switch's root attribute, not by state.
 *
 * @module body/body-dormancy
 */

import type { BodyVisibilitySnapshot } from "../lib/body-visibility-store";
import { bodyVisibilityStore, type BodyVisibilityStore } from "../lib/body-visibility-store";

/** Where the page's dormancy stands. */
export interface DormancyState {
  /** The session subscription is dropped: the page hears nothing of its session. */
  readonly asleep: boolean;
  /** Shown again and asking for what it missed; still dormant until it has it. */
  readonly catchingUp: boolean;
}

export const AWAKE: DormancyState = { asleep: false, catchingUp: false };

/** On the page's root while it is dormant: the content lid stands (`body-page.css`). */
export const BODY_DORMANT_ATTRIBUTE = "data-body-dormant";

/** What the page does on a step. */
export type DormancyAct = "sleep" | "catch-up" | "wake" | null;

/**
 * The next state, and what to do, for a visibility snapshot. A hidden body
 * that the store calls dormant sleeps; a sleeping body that is shown catches
 * up; a body the store no longer calls dormant — it woke — is awake, and
 * one caught up says so through {@link caughtUp}.
 */
export function nextDormancy(
  state: DormancyState,
  visibility: Pick<BodyVisibilitySnapshot, "shown" | "dormant">,
): { state: DormancyState; act: DormancyAct } {
  if (state.asleep) {
    if (visibility.shown) return { state: { asleep: false, catchingUp: true }, act: "catch-up" };
    return { state, act: null };
  }
  if (state.catchingUp) return { state, act: null };
  if (visibility.dormant && !visibility.shown) return { state: { asleep: true, catchingUp: false }, act: "sleep" };
  return { state, act: null };
}

/** The catch-up's bracket closed: the page wakes. */
export function caughtUp(state: DormancyState): { state: DormancyState; act: DormancyAct } {
  if (!state.catchingUp) return { state, act: null };
  return { state: AWAKE, act: "wake" };
}

/** What dormancy does to the page, each the page's own. */
export interface BodyDormancyEffects {
  /** Re-apply the session subscription; it reads {@link InstalledBodyDormancy.asleep}. */
  rescope(): void;
  /** Still the page's loops, or let them run. */
  stillLoops(on: boolean): void;
  /** Lid the card's content box, or lift the lid. */
  lidContent(on: boolean): void;
  /** Withdraw the page's deck-scope surface, or draw it again. */
  withholdSurface(on: boolean): void;
  /** Write the card's bag to disk now, as a save-state call does. */
  saveBag(): void;
  /**
   * Ask the card's session for what it missed, and call `done` once the
   * answer's bracket has closed — at once for a card with no session.
   * Returns a release for the wait.
   */
  catchUp(done: () => void): () => void;
}

export interface InstalledBodyDormancy {
  /** Whether the page's session subscription is dropped. */
  readonly asleep: boolean;
  release(): void;
}

/** Follow the page's visibility store and carry out what {@link nextDormancy} decides. */
export function installBodyDormancy(
  effects: BodyDormancyEffects,
  store: Pick<BodyVisibilityStore, "getSnapshot" | "subscribe" | "wake"> = bodyVisibilityStore,
): InstalledBodyDormancy {
  let state = AWAKE;
  let releaseWait: (() => void) | null = null;
  const act = (next: { state: DormancyState; act: DormancyAct }): void => {
    state = next.state;
    switch (next.act) {
      case "sleep":
        // The bag first, captured from the DOM as it stands.
        effects.saveBag();
        effects.stillLoops(true);
        effects.lidContent(true);
        effects.withholdSurface(true);
        effects.rescope();
        return;
      case "catch-up":
        effects.rescope();
        releaseWait = effects.catchUp(() => {
          releaseWait = null;
          act(caughtUp(state));
        });
        return;
      case "wake":
        // The loops and the surface first: waking re-arms the store's clock,
        // and a body hidden again past its delay goes back to sleep inside
        // `wake()`, which must be the last word.
        effects.stillLoops(false);
        effects.lidContent(false);
        effects.withholdSurface(false);
        store.wake();
        return;
      case null:
        return;
    }
  };
  const follow = (): void => act(nextDormancy(state, store.getSnapshot()));
  const unsubscribe = store.subscribe(follow);
  follow();
  return {
    get asleep() {
      return state.asleep;
    },
    release() {
      unsubscribe();
      releaseWait?.();
    },
  };
}
