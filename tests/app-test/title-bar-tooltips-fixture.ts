/**
 * title-bar-tooltips-fixture.ts — the deck, selectors and hover gestures the
 * at0404-title-bar-tooltips-* files share.
 *
 * The Text card draws its pane's chrome in its own page, so every control,
 * bubble and menu is read there (`app.body("A")`), and the page's one pane
 * needs no scope. Hover is synthesized the way at0334 does it — a
 * `pointerenter` plus a `pointermove` on the trigger — because a background
 * app-test window runs no rAF and nothing here may hang off an animation
 * completing.
 *
 * @module tests/app-test/title-bar-tooltips-fixture
 */

import { expect } from "bun:test";

import type { App, BodyApp } from "./_harness";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 120_000;

/** The settle window (`IMPOSITION_SETTLE_MS`), with room for the tween. */
export const AFTER_LAND_MS = 900;

/** The page whose controls are read: the Text card's own (`app.body("A")`). */
type Page = App | BodyApp;

export const BADGE = '[data-testid="tug-pane-title-bar-stack-badge"]';
export const SLOT_BADGE = '[data-testid="card-slot-badge-trigger"]';
export const BULLSEYE = '[data-testid="tug-pane-title-bar-bullseye-button"]';
export const REVEAL_BUTTON = '[data-testid="tug-pane-title-bar-item-reveal-card-file"]';
export const OPTIONS_BUTTON = '[data-testid="tug-pane-title-bar-item-show-card-settings"]';
export const WIDTH_BUTTON = '[data-testid="tug-pane-title-bar-width-button"]';
export const FOLD_BUTTON = '[data-testid="tug-pane-title-bar-fold-button"]';
export const MOVE_SPACE_BUTTON = '[data-testid="tug-pane-title-bar-move-space-button"]';
export const CLOSE_BUTTON = '[data-testid="tug-pane-close-button"]';
export const WIDTH_MENU = '[data-testid="tug-pane-title-bar-width-menu"]';

const BUBBLE = '[data-slot="tug-tooltip"]';
/**
 * The chip is always read as a DIRECT child of the bubble: the bubble also
 * holds a visually-hidden `[role="tooltip"]` copy of everything for the screen
 * reader, and a descendant selector would find that copy's chip too.
 */

export const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

export const FIXTURE_CONTENT = "fixture line 1\nfixture line 2\n";

/**
 * Two panes in slot 0 so the stack badge has something to report, at
 * MISMATCHED widths so the buried one is not fully covered and the front one
 * stays hoverable. The front card is a Text card because a Text card is what
 * publishes title-bar items — without one the card-contributed buttons do not
 * render at all, and there would be nothing to hover.
 */
export function deckShape() {
  return {
    cards: [
      { id: "Z", componentId: "gallery-animator", title: "Card Z", closable: true },
      { id: "A", componentId: "text", title: "File", closable: true },
    ],
    panes: [
      {
        id: "p0",
        position: { x: 40, y: 40 },
        size: { width: 620, height: 460 },
        cardIds: ["Z"],
        activeCardId: "Z",
        title: "",
        acceptsFamilies: ["standard"],
        slot: 0,
      },
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 480, height: 460 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["standard"],
        slot: 0,
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

/**
 * An expression evaluating to the element a control's tooltip HANGS FROM: the
 * span wrapper where there is one, the control itself where there is not.
 */
const anchorExpr = (selector: string): string =>
  `(function () {
    var el = document.querySelector(${JSON.stringify(selector)});
    if (el === null) throw new Error("no trigger: " + ${JSON.stringify(selector)});
    // Two anchor classes, because two components solve the same composition
    // problem in their own file: a control already claimed by a Radix
    // \`asChild\` slot cannot also be the tooltip's trigger, so each wraps a
    // span the bubble can address. The cluster's is
    // \`.tug-pane-title-bar-tooltip-anchor\`; the slot chip's is its own.
    // A control that needs no wrapper — the target — is its own anchor.
    return el.closest(".tug-pane-title-bar-tooltip-anchor")
      || el.closest(".card-slot-badge-anchor")
      || el;
  })()`;

/**
 * An expression evaluating to THIS control's bubble, or null.
 *
 * Found through the trigger rather than by taking whatever bubble happens to
 * be in the document. An open Radix tooltip points its trigger's
 * aria-describedby at the announced copy inside its own content, so following
 * that link can never hand back the previous control's bubble mid-handover —
 * which a bare document-wide query would do, and would do intermittently.
 */
const bubbleExpr = (selector: string): string =>
  `(function () {
    var anchor = ${anchorExpr(selector)};
    var id = anchor.getAttribute("aria-describedby");
    if (!id) return null;
    var announced = document.getElementById(id);
    return announced === null
      ? null
      : announced.closest(${JSON.stringify(BUBBLE)});
  })()`;

/**
 * Take the pointer OFF a control, and wait until it no longer describes a
 * bubble.
 *
 * Needed before a second hover of the same control, and for a reason worth
 * knowing: Radix's trigger latches "the pointer is inside me" and only clears
 * the latch on leave, so a second `pointerenter` while the latch stands is
 * dropped on the floor and the bubble never reopens.
 *
 * The leave is dispatched as a POINTEROUT carrying a relatedTarget outside the
 * element, because that is what React derives its synthetic `onPointerLeave`
 * from — a bare `pointerleave` does not bubble and the synthetic system never
 * sees it.
 *
 * The wait reads `aria-describedby` — the trigger's own statement that it has
 * a bubble — rather than the bubble's presence in the DOM. A closing Radix
 * tooltip stays mounted for its exit animation, and a background app-test
 * window runs no rAF, so waiting for the element to go could wait forever.
 */
async function unhover(app: Page, selector: string): Promise<void> {
  await app.evalJS<null>(
    `(function () {
      var anchor = ${anchorExpr(selector)};
      anchor.dispatchEvent(
        new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }),
      );
      return null;
    })()`,
  );
  await app.waitForCondition<boolean>(
    `${anchorExpr(selector)}.getAttribute("aria-describedby") === null`,
    { timeoutMs: 8000 },
  );
}

/** Put the pointer on a control and wait for its bubble to stand. */
async function hover(app: Page, selector: string): Promise<void> {
  await unhover(app, selector);
  await app.evalJS<null>(
    `(function () {
      var anchor = ${anchorExpr(selector)};
      anchor.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false }));
      anchor.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));
      return null;
    })()`,
  );
  await app.waitForCondition<boolean>(`${bubbleExpr(selector)} !== null`, {
    timeoutMs: 8000,
  });
}

/**
 * Hover a control and read its bubble's phrase — the visible text, with any
 * chord chip stripped off the end.
 */
export async function hoverPhrase(app: Page, selector: string): Promise<string> {
  await hover(app, selector);
  return app.evalJS<string>(
    `(function () {
      var bubble = ${bubbleExpr(selector)};
      // Radix renders the phrase TWICE inside the bubble: once to be seen,
      // and once more in a visually-hidden [role="tooltip"] node that is what
      // a screen reader announces. Reading the whole subtree's text would
      // hand back the phrase doubled, so take the visible children only.
      var text = Array.prototype.filter
        .call(bubble.childNodes, function (n) {
          return !(n.nodeType === 1 && n.getAttribute("role") === "tooltip");
        })
        .map(function (n) { return n.textContent || ""; })
        .join("");
      var chip = bubble.querySelector(":scope > .tug-tooltip-shortcut");
      if (chip !== null) text = text.replace(chip.textContent || "", "");
      return text.trim();
    })()`,
  );
}

/** The chord chip on a control's bubble, or null when it carries none. */
export async function chipText(app: Page, selector: string): Promise<string | null> {
  return app.evalJS<string | null>(
    `(function () {
      var bubble = ${bubbleExpr(selector)};
      if (bubble === null) return null;
      var chip = bubble.querySelector(":scope > .tug-tooltip-shortcut");
      return chip === null ? null : chip.textContent.trim();
    })()`,
  );
}

/**
 * Poll a standing bubble's chip until it reads `want`, and return whatever it
 * last read. A rebind reaches the tooltip through a store notification, so the
 * update is a render away rather than an awaited round trip.
 */
export async function waitForChip(
  app: Page,
  selector: string,
  want: string,
  timeoutMs = 8000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  let last: string | null = null;
  while (Date.now() < deadline) {
    last = await chipText(app, selector);
    if (last === want) return last;
    await wait(100);
  }
  return last;
}

/** The Text card's page, once it draws its title bar. */
export async function cardChrome(app: App): Promise<BodyApp> {
  const page = app.body("A");
  await page.waitForCondition<boolean>(`document.querySelector('[data-testid="tug-pane-title-bar"]') !== null`, {
    timeoutMs: 10000,
  });
  return page;
}

const KEYMAP_DOMAIN = "dev.tugapp.keymap";

/**
 * Send one request to the defaults HTTP surface from the shell's page and
 * wait for its answer. The write lands in tugbank and comes back to every
 * page as a DEFAULTS push — the shell's, and the card's page that draws the
 * title bar — which is how any other process's write arrives. A local set
 * would reach the shell's cache alone.
 */
async function defaultsRequest(app: App, method: "PUT" | "DELETE", commandId: string, body?: unknown): Promise<void> {
  const url = `/api/defaults/${KEYMAP_DOMAIN}/${encodeURIComponent(commandId)}`;
  const init = body === undefined ? { method } : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  await app.evalJS<null>(
    `(window.__at0404_written = undefined,
      fetch(${JSON.stringify(url)}, ${JSON.stringify(init)})
        .then(function (r) { window.__at0404_written = r.ok; })
        .catch(function () { window.__at0404_written = false; }),
      null)`,
  );
  expect(await app.waitForCondition<boolean>(`window.__at0404_written`, { timeoutMs: 10000 }), `${method} ${url}`).toBe(true);
}

/** Write one command's override the way any other process would. */
export async function writeOverride(app: App, commandId: string, bindings: unknown[]): Promise<void> {
  await defaultsRequest(app, "PUT", commandId, { kind: "string", value: JSON.stringify(bindings) });
}

/** Drop the override — a deletion, which is how "use whatever ships" is spelled. */
export async function resetOverride(app: App, commandId: string): Promise<void> {
  await defaultsRequest(app, "DELETE", commandId);
}
