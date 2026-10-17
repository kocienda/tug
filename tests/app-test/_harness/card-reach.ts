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

import type { App, BodyApp, DeckTraceEvent } from "./index";
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

/** A mark in every page's deck trace: the shell's (under `null`) and each body's, by card id. */
export type PageMarks = Map<string | null, number>;

/**
 * Mark the deck trace in every page — the shell and each card's body. Each
 * page keeps its own ring, so "what happened since" is asked of each.
 */
export async function markEveryPage(app: App): Promise<PageMarks> {
  const marks: PageMarks = new Map([[null, await app.markDeckTrace()]]);
  for (const b of await app.bodies()) {
    if (b.cardId !== null) marks.set(b.cardId, await app.body(b.cardId).markDeckTrace());
  }
  return marks;
}

/**
 * Every page's trace events since its mark, page by page: the shell's, then
 * each marked body's. The pages keep separate clocks, so events of two pages
 * are never ordered against each other; a body that has gone since its mark
 * contributes nothing.
 */
export async function traceSinceEveryPage(app: App, marks: PageMarks): Promise<DeckTraceEvent[]> {
  const live = new Set((await app.bodies()).map((b) => b.cardId));
  const events: DeckTraceEvent[] = [];
  for (const [cardId, mark] of marks) {
    if (cardId === null) events.push(...(await app.getDeckTrace({ since: mark })));
    else if (live.has(cardId)) events.push(...(await app.body(cardId).getDeckTrace({ since: mark })));
  }
  return events;
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

/**
 * The body of the deck's card of `componentId`, once the host has painted it
 * and placed it with a size: the state a native click or key can land in. A
 * `ready` body is mounted but may still be unplaced (a zero frame), and a
 * point computed in its viewport then lands outside the view. Throws when no
 * such body stands in `timeoutMs`.
 */
export async function waitForBodyPainted(app: App, componentId: string, timeoutMs = 30_000): Promise<BodyApp> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const bodies = await app.bodies();
    const placed = bodies.find(
      (b) => b.componentId === componentId && b.painted && b.visible && b.frame.width > 0 && b.frame.height > 0,
    );
    if (placed?.cardId !== undefined && placed.cardId !== null) return app.body(placed.cardId);
    if (Date.now() >= deadline) {
      const held =
        bodies
          .map((b) => `${b.cardId}:${b.componentId}:${b.state}:${b.painted ? "painted" : "unpainted"}:${b.frame.width}x${b.frame.height}`)
          .join(", ") || "none";
      throw new Error(`no painted, placed body holds a ${componentId} card within ${timeoutMs} ms (the host holds ${held})`);
    }
    await Bun.sleep(50);
  }
}

/**
 * A body handle for the deck's card of `componentId`, resolved at each call:
 * for a file that opens a card by its chord, menu or sidebar toggle rather
 * than seeding one under an id it names, and reads it before and after the
 * card is closed and opened again. Every call finds the ready body holding
 * a card of the kind, as {@link bodyOfKind} does, and runs there; a call
 * with no such body standing ready in `timeoutMs` throws as it would.
 */
export function kindBody(app: App, componentId: string, timeoutMs = 30_000): BodyApp {
  const template = app.body(`kind:${componentId}`);
  return new Proxy(template, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== "function" || prop === "constructor") return value;
      return (...args: unknown[]) =>
        bodyOfKind(app, componentId, timeoutMs).then((body) => (body as unknown as Record<string | symbol, (...a: unknown[]) => unknown>)[prop](...args));
    },
  });
}
