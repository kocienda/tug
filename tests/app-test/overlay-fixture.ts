/**
 * overlay-fixture — the overlay page, read where it draws.
 *
 * The host keeps one page above every card, under the reserved card id
 * `deck-overlay`, and the app-modals (the version gate, the restore gate,
 * the setup wizard, the update wizard and its pill) and the shell's alerts
 * are drawn in it rather than in the shell's page. A test that reads one of
 * them reads the overlay's DOM through `App.body(OVERLAY_CARD)`, and clicks
 * in it the same way. What drives them stays in the shell: a control action,
 * an `onUpdateState` pushed to the shell's bridge, a logout request — the
 * shell relays each to the overlay.
 */

import type { App, BodyApp } from "./_harness";

/** The overlay page's card id (`tugdeck/src/lib/overlay-card.ts`). */
export const OVERLAY_CARD = "deck-overlay";

/** The overlay page, as a harness caller: `evalJS`, `waitForCondition`, the native clicks. */
export function overlayPage(app: App): BodyApp {
  return app.body(OVERLAY_CARD);
}

/**
 * Wait until the overlay page is up: its view made and its tree rendered.
 * The host makes the view when the shell boots, and again after a reload,
 * so a read named at the overlay just after either is a read of a view that
 * may not be there yet; this waits through that rather than failing on it.
 */
export async function overlayReady(app: App, timeoutMs = 20_000): Promise<BodyApp> {
  const overlay = overlayPage(app);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await overlay.evalJS<boolean>(`document.documentElement.hasAttribute("data-overlay-ready")`)) return overlay;
    } catch {
      // No view yet: the host has not made it.
    }
    if (Date.now() > deadline) throw new Error(`the overlay page was not up within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Wait until the restore gate — the app-modal the shell's restore fold
 * raises in the overlay page while a resumed card's replay reveals — has
 * come down. While it stands it is the overlay's claim on the whole window:
 * a click or a right-click anywhere lands on it and the keyboard is its, so
 * a gesture meant for a card is made after it has gone.
 */
export async function restoreGateGone(app: App, timeoutMs = 15_000): Promise<void> {
  const overlay = await overlayReady(app);
  await overlay.waitForCondition<boolean>(`document.querySelector('[data-slot="tug-restore-gate"]') === null`, { timeoutMs });
}
