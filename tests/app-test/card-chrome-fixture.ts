/**
 * card-chrome-fixture — a card's chrome, read where it is drawn: in the
 * card's own page.
 *
 * A card that carries its chrome draws its title bar and grips in its page,
 * and its pane in the shell is a stand-in that draws neither. A test that
 * presses the chrome from the shell's verbs (`app.nativeDrag…`, in the
 * shell's viewport points, the window's) needs the chrome's rect in those
 * points: the card's view origin, as the host reports it, plus the element's
 * rect in the page. The pane's own rect stays the stand-in's, which the
 * shell lays out as the arrangement's model.
 */

import type { App } from "./_harness";

/** A rect in the shell's viewport points, with its edges. */
export interface ChromeRect {
  x: number;
  y: number;
  width: number;
  height: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** `selector`'s rect in `card`'s page, in the shell's viewport points; null when the card has no visible view or no such element. */
export async function chromeRectOf(app: App, card: string, selector: string): Promise<ChromeRect | null> {
  const view = (await app.bodies()).find((b) => b.cardId === card);
  if (view === undefined || !view.visible) return null;
  const r = await app.body(card).evalJS<{ x: number; y: number; width: number; height: number } | null>(
    `(function () {
      var el = document.querySelector(${JSON.stringify(selector)});
      if (el === null) return null;
      var r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })()`,
  );
  if (r === null) return null;
  const x = view.frame.x + r.x;
  const y = view.frame.y + r.y;
  return { x, y, width: r.width, height: r.height, left: x, top: y, right: x + r.width, bottom: y + r.height };
}

/** How far a card's view reaches past its pane on every side, points (`CARD_APRON_PX`). */
const CARD_APRON = 10;

/**
 * Where `card`'s pane stands on screen now, in the shell's viewport points:
 * its view's presented frame less the apron. A card in the host's hand is
 * here, while its stand-in in the shell stays where the arrangement puts it.
 */
export async function heldRectOf(app: App, card: string): Promise<ChromeRect | null> {
  const view = (await app.bodies()).find((b) => b.cardId === card);
  if (view === undefined) return null;
  const f = view.presentedFrame;
  const x = f.x + CARD_APRON;
  const y = f.y + CARD_APRON;
  const width = f.width - 2 * CARD_APRON;
  const height = f.height - 2 * CARD_APRON;
  return { x, y, width, height, left: x, top: y, right: x + width, bottom: y + height };
}

/** {@link chromeRectOf}, which must be there within `timeoutMs`: a card's view shows a paint or two after its pane lands. */
export async function chromeRect(app: App, card: string, selector: string, timeoutMs = 5_000): Promise<ChromeRect> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await chromeRectOf(app, card, selector);
    if (r !== null && r.width > 0 && r.height > 0) return r;
    if (Date.now() > deadline) throw new Error(`card ${card} draws no ${selector} in a visible view`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The centre of `selector` in `card`'s page, in the shell's viewport points. */
export async function chromePoint(app: App, card: string, selector: string): Promise<{ x: number; y: number }> {
  const r = await chromeRect(app, card, selector);
  return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
}
