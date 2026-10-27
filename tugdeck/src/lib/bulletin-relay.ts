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

export type BulletinTone = "default" | "success" | "danger" | "caution";

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
