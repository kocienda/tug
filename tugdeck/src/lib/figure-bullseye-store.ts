/**
 * figure-bullseye-store.ts — the one figure the deck is showing at full
 * size, if any.
 *
 * A diagram is laid out at its natural width, and in a card narrower than
 * that it shrinks to a floor and then scrolls sideways
 * (`chart-block.css`). The target in a diagram's header **bullseyes the
 * figure**: it is drawn again, alone, centred over the whole deck at its
 * natural width, with its keyed table, and scaled down only when the window
 * itself is narrower — so it never scrolls sideways. It is the figure's
 * counterpart of a pane's bullseye ([D131]): a presentation over the deck
 * that writes nothing and is left by Escape, a click outside, or the target
 * again.
 *
 * A card's page cannot draw past its own card, so the figure is drawn in the
 * overlay page above every card ([B07]). What crosses is the spec, never
 * pixels: the overlay draws it with the same renderer the card did. The
 * shell holds the truth — this store, in the shell's page — and relays it
 * as `overlay.figureBullseye`; the overlay's copy adopts it and sends its
 * close back through {@link setFigureBullseyeCloseSink}. Where the host keeps
 * no overlay the shell's page draws it itself, from this store.
 *
 * Every show is numbered, and a close names the show it closed, so a close
 * that crosses the bus after a new show was raised does not take the new one
 * down (the Open Quickly store's rule, for the same hop).
 *
 * A module-singleton subscribable store ([L02]).
 *
 * @module lib/figure-bullseye-store
 */

import { overlayShowFigureBullseye } from "../bus/declarations/overlay";
import type { ChartLayers } from "./lazy/load-tuggraphics";
import { createSubscribable } from "./subscribable";

/** The figure the deck shows at full size: its spec and the door it came through. */
export interface BullseyeFigure {
  source: string;
  layers: ChartLayers;
}

/** The store's snapshot: the figure shown, or `null`, and the number of the latest show. */
export interface FigureBullseyeState {
  figure: BullseyeFigure | null;
  seq: number;
}

let state: FigureBullseyeState = { figure: null, seq: 0 };
const listeners = createSubscribable();
let closeSink: ((seq: number) => void) | null = null;

/** Subscribe to changes. Returns an unsubscribe function. */
export function subscribeFigureBullseye(listener: () => void): () => void {
  return listeners.subscribe(listener);
}

/** The current state (the `useSyncExternalStore` snapshot). */
export function getFigureBullseye(): FigureBullseyeState {
  return state;
}

/** Show `figure` at full size, in place of any figure already shown. */
export function showFigureBullseye(figure: BullseyeFigure): void {
  state = { figure, seq: state.seq + 1 };
  listeners.notify();
}

/**
 * Take the figure down. With `seq`, only if it is still the show that number
 * names; a close for an older show is dropped.
 */
export function closeFigureBullseye(seq?: number): void {
  if (state.figure === null) return;
  if (seq !== undefined && seq !== state.seq) return;
  state = { figure: null, seq: state.seq };
  listeners.notify();
  closeSink?.(state.seq);
}

/** Take the shell's state, in the page that draws the figure for it. */
export function adoptFigureBullseye(next: FigureBullseyeState): void {
  if (next.seq === state.seq && next.figure?.source === state.figure?.source && next.figure?.layers === state.figure?.layers) {
    return;
  }
  state = next;
  listeners.notify();
}

/** Where a close in the page that draws the figure goes, naming the show it closed: the shell. */
export function setFigureBullseyeCloseSink(sink: ((seq: number) => void) | null): void {
  closeSink = sink;
}

/**
 * Ask the shell to show `figure` at full size, from whichever page the target
 * was pressed in. In the shell's own page the action runs at once.
 */
export function requestFigureBullseye(figure: BullseyeFigure): void {
  overlayShowFigureBullseye.dispatch({ source: figure.source, layers: figure.layers });
}
