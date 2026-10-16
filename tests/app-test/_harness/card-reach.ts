/**
 * card-reach.ts — reaching a card's DOM from a test.
 *
 * A card that is a body is its own page: its DOM is not in the shell's
 * document, and an expression the shell evaluates finds nothing of it.
 * `App.body(cardId)` is the only way a test reaches such a card's DOM, and
 * `tests/app-test/scripts/card-dom-census.ts` lists every shell-evaluated
 * expression that still reaches into a card (`just
 * app-test-body-scope-check` fails on one not on its allow-list).
 *
 * The helpers here answer for a card wherever it is: in its body when it has
 * one, and in the shell's document for a card that is not (yet) a body, so a
 * file that uses them keeps passing on either path.
 */

import type { App, BodyApp } from "./index";
import { enforcedTimeout } from "./rpc";
import { keyboardInCardHost } from "./selectors";

/**
 * The page that holds `cardId`'s DOM: its body when the host holds a bound
 * body for it, and the shell otherwise.
 */
export async function cardPage(app: App, cardId: string): Promise<App | BodyApp> {
  const body = (await app.bodies()).find((b) => b.cardId === cardId);
  return body !== undefined && (body.state === "bound" || body.state === "ready") ? app.body(cardId) : app;
}

/**
 * Whether the keyboard is in `cardId`, stated as two facts in their two pages.
 *
 * The deck's half, in the shell: `getActiveCardId()` is `cardId` — the
 * composite first-responder bit, the card the engine follows as its key card.
 * Not `getFocusedCardId()`, despite the name: that one reports the topmost
 * pane's active card, a z-order fact that never goes null while any pane
 * exists. The card's half, in the page holding the card: the key view, the
 * first responder or real DOM focus is inside its host
 * (`keyboardInCardHost`).
 */
export async function keyboardIsInCard(app: App, cardId: string): Promise<boolean> {
  const deck = await app.evalJS<boolean>(
    `typeof window.__tug !== "undefined" && window.__tug.getActiveCardId() === ${JSON.stringify(cardId)}`,
  );
  if (!deck) return false;
  return (await cardPage(app, cardId)).evalJS<boolean>(keyboardInCardHost(cardId));
}

/** Wait until {@link keyboardIsInCard} holds; throws with the card named when it does not by `timeoutMs` (scaled as `waitForCondition`'s is). */
export async function waitForKeyboardInCard(app: App, cardId: string, opts: { timeoutMs: number }): Promise<void> {
  const budget = enforcedTimeout(opts.timeoutMs);
  const deadline = Date.now() + budget;
  while (!(await keyboardIsInCard(app, cardId))) {
    if (Date.now() >= deadline) throw new Error(`the keyboard did not reach card ${cardId} within ${budget} ms`);
    await Bun.sleep(50);
  }
}

/**
 * The body of the deck's card of `componentId`, once the host holds it ready:
 * for a file that opens a card (the Overview by its chord, say) rather than
 * seeding one under an id it names. Throws when no such card stands ready in
 * `timeoutMs`.
 */
export async function bodyOfKind(app: App, componentId: string, timeoutMs = 30_000): Promise<BodyApp> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const bodies = await app.bodies();
    const ready = bodies.find((b) => b.componentId === componentId && b.state === "ready");
    if (ready?.cardId !== undefined && ready.cardId !== null) return app.body(ready.cardId);
    if (Date.now() >= deadline) {
      const held = bodies.map((b) => `${b.cardId}:${b.componentId}:${b.state}`).join(", ") || "none";
      throw new Error(`no ready body holds a ${componentId} card within ${timeoutMs} ms (the host holds ${held})`);
    }
    await Bun.sleep(50);
  }
}
