/**
 * The overlay page's reserved card id: the page the host keeps above every
 * card, for the transient surfaces nothing beneath it may draw ([B07]). It is
 * a page on the bus as a card's body is, under this id and of this kind, and
 * no card of the deck ever takes it. The host addresses the overlay's view by
 * the same id (`BodyViewController.overlayCardId`).
 *
 * @module lib/overlay-card
 */

export const OVERLAY_CARD_ID = "deck-overlay";
