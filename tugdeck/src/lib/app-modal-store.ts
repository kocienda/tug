/**
 * app-modal-store.ts — whether an app-modal wizard is on screen.
 *
 * `ConfigureTug`, `UpdateTug` and `TugVersionGate` are Radix `AlertDialog`s
 * portalled into the canvas overlay, so pointer input and focus are trapped
 * for the web view. AppKit is not trapped: the menu bar still validates and
 * still fires, and ⌘N under an open wizard opens a Session card behind it.
 * The fix needs one fact — "an app-modal is up" — readable by the menu-state
 * aggregator, and this is it.
 *
 * Keyed by owner rather than counted. The three writers publish from a layout
 * effect on their own open state ([L03]: the menu push has to be correct on
 * the frame the modal paints, not a tick later), and a layout effect can
 * re-run for reasons that have nothing to do with the modal opening or
 * closing. A `Set` of owners is idempotent under that; a count is not. It
 * also means a writer that re-mounts without tearing down cleanly repairs
 * itself on its next write rather than leaving the deck frozen.
 *
 * Nothing else reads this. It is a publication seam onto
 * {@link module:lib/host-menu-state}, not a new state zone, and no React
 * component subscribes to it — a modal that is open already knows it is open.
 *
 * @module lib/app-modal-store
 */

import { useLayoutEffect } from "react";

/** The three surfaces that take the app modally. */
export type AppModalOwner = "configure-tug" | "update-tug" | "version-gate";

const openOwners = new Set<AppModalOwner>();
const subscribers = new Set<() => void>();

function notify(): void {
  for (const subscriber of subscribers) subscriber();
}

export const appModalStore = {
  /**
   * Publish one owner's open state. Idempotent per owner, and notifies only
   * when the set of owners actually changes — the subscriber is the menuState
   * publisher, whose flush is coalesced but not free.
   *
   * The edge is the *set*, not {@link isOpen}. The subscriber publishes two
   * facts, and one of them ({@link isOpenFor}) is per-owner: a second modal
   * opening over the first moves no aggregate, so an aggregate-only edge
   * would leave `updateTugOpen` published as whatever it was — Configure
   * Tug… dark after the update wizard closed, or live while it stood.
   */
  setOpen(owner: AppModalOwner, open: boolean): void {
    const changed = open ? !openOwners.has(owner) : openOwners.has(owner);
    if (!changed) return;
    if (open) {
      openOwners.add(owner);
    } else {
      openOwners.delete(owner);
    }
    notify();
  },

  /** Whether any of the three is on screen. */
  isOpen(): boolean {
    return openOwners.size > 0;
  },

  /** Whether one particular modal is on screen. */
  isOpenFor(owner: AppModalOwner): boolean {
    return openOwners.has(owner);
  },

  /**
   * Whether a modal OTHER than `owner` is on screen.
   *
   * This is what a wizard's own door asks before raising it ([B04]): a
   * request arriving while a sibling holds the app is dropped rather than
   * queued, and a wizard must not count itself as the thing in its way.
   */
  isOpenExcept(owner: AppModalOwner): boolean {
    for (const open of openOwners) {
      if (open !== owner) return true;
    }
    return false;
  },

  subscribe(subscriber: () => void): () => void {
    subscribers.add(subscriber);
    return () => {
      subscribers.delete(subscriber);
    };
  },
};

/**
 * Publish one modal's open state for as long as it is mounted.
 *
 * A layout effect rather than an effect ([L03]): the menu bar validates on
 * the user's next click, and a push that lands a frame late is a frame in
 * which ⌘N still opens a card behind the wizard. The teardown clears the
 * owner, so a modal that unmounts without ever having closed still releases
 * the deck.
 */
export function usePublishAppModalOpen(owner: AppModalOwner, open: boolean): void {
  useLayoutEffect(() => {
    appModalStore.setOpen(owner, open);
    return () => {
      appModalStore.setOpen(owner, false);
    };
  }, [owner, open]);
}

/** Test seam: forget every owner. Never called by the app. */
export function resetAppModalStore(): void {
  const wasOpen = openOwners.size > 0;
  openOwners.clear();
  if (wasOpen) notify();
}
