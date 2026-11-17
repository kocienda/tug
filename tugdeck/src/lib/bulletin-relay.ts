/**
 * The bulletin relay slot — where a deck bulletin goes instead of this page's
 * stack.
 *
 * Wherever the host keeps an overlay above the cards, the shell installs a
 * relay here (`lib/overlay-shell.ts`) and `tug-bulletin.tsx` sends every deck
 * bulletin through it to the overlay page. The slot lives in lib so the shell
 * can fill it without importing a component; `tug-bulletin.tsx` re-exports it.
 *
 * @module lib/bulletin-relay
 */

import type { TugTone } from "@/components/tugways/tug-vocabulary";

export type BulletinTone = Extract<TugTone, "default" | "success" | "danger" | "caution">;

/** A deck bulletin as it crosses to the overlay page: text only. */
export interface RelayedBulletin {
  tone: BulletinTone;
  message: string;
  description?: string;
  duration?: number;
  sticky?: boolean;
  okLabel?: string;
}

let bulletinRelay: ((relayed: RelayedBulletin) => void) | null = null;

/**
 * Send every deck bulletin to `relay` instead of this page's stack, or show
 * them here again with `null`. The shell installs one wherever the host
 * keeps an overlay above the cards (`lib/overlay-shell.ts`).
 */
export function setBulletinRelay(relay: ((relayed: RelayedBulletin) => void) | null): void {
  bulletinRelay = relay;
}

/** The relay installed now, or `null` where bulletins show in this page. */
export function getBulletinRelay(): ((relayed: RelayedBulletin) => void) | null {
  return bulletinRelay;
}

let deckBulletin: ((tone: BulletinTone, message: string) => void) | null = null;

/**
 * Install the page's deck bulletin, for lib code that has an outcome to say
 * and no component in reach. `tug-bulletin.tsx` fills it when it loads, which
 * is on every page that can show one.
 */
export function setDeckBulletin(raise: ((tone: BulletinTone, message: string) => void) | null): void {
  deckBulletin = raise;
}

/**
 * Say `message` in a deck bulletin, through the relay where one is
 * installed. Lib code's door to it: a figure's header is plain DOM with no
 * card's bulletin in reach. On a page with no bulletin (the share page, a
 * test) it is logged instead.
 */
export function raiseDeckBulletin(tone: BulletinTone, message: string): void {
  if (deckBulletin === null) {
    console.warn(`bulletin (${tone}): ${message}`);
    return;
  }
  deckBulletin(tone, message);
}
