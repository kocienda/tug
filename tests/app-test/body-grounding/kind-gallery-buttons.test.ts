/**
 * kind-gallery-buttons.test.ts — the maker kinds are bodies, with the
 * gallery's TugPushButton card standing for them: the gallery, spike and
 * fixture cards share one registration shape and one door (maker tooling),
 * and whatever is true of this one's body is true of theirs.
 *
 * One body gallery card, seeded with maker tooling on:
 *
 * - **It mounts as a body** holding the card, and the shell's document holds
 *   none of the gallery.
 * - **Its data** — the card's own: its sections are the body's rows.
 * - **Its own interactions** — the width-stabilized view toggle, clicked in
 *   the body, flips its label there.
 * - **Its surface** — the body paints the content pane's surface, read off
 *   the composite.
 *
 * @covers tugdeck/src/components/tugways/cards/gallery-registrations.tsx
 * @covers tugdeck/src/components/tugways/cards/gallery-push-button.tsx
 * @covers tugdeck/src/spikes/spike-registry.tsx
 * @covers tugdeck/src/fixtures/fixture-registrations.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "../_harness";
import { pollFor } from "./_bodies";
import { expectContentSurface, kindDeck, standUpKind } from "./_kind-bodies";
import { cardKind } from "./_kinds";

const TEST_NAME = "body-grounding-kind-gallery-buttons";
const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;
const READ_MS = 5_000;

const GB = "kgb-buttons";
const ROOT = '[data-testid="gallery-buttons"]';
const SECTIONS = `${ROOT} .cg-section`;
const VIEW_PRIMARY = "Inline";
const VIEW_ALTERNATE = "Side by side";
const TOGGLE = '[data-kind-check="view-toggle"]';
/** The label a width-stabilized button shows: its active variant, beside the hidden alternate. */
const TOGGLE_LABEL = `${TOGGLE} [data-tug-stable="active"]`;

const present = (selector: string): string => `document.querySelector(${JSON.stringify(selector)}) !== null`;
const count = (selector: string): string => `document.querySelectorAll(${JSON.stringify(selector)}).length`;
const textOf = (selector: string): string => `((document.querySelector(${JSON.stringify(selector)}) || {}).textContent || "").trim()`;
/** Mark the view-toggle button — the one whose active label is the primary one — so a click can name it. */
const markToggle = `(function () {
  var b = Array.from(document.querySelectorAll(${JSON.stringify(`${ROOT} button`)})).find(function (el) {
    var active = el.querySelector('[data-tug-stable="active"]');
    return active !== null && (active.textContent || "").trim() === ${JSON.stringify(VIEW_PRIMARY)};
  });
  if (!b) return false;
  b.setAttribute("data-kind-check", "view-toggle");
  b.scrollIntoView({ block: "center" });
  return true;
})()`;

describe.skipIf(!SHOULD_RUN)("body-grounding kind check: the maker kinds, by the gallery's TugPushButton card", () => {
  test(
    "the gallery card mounts as a body, its sections are there, and its view toggle flips in the body",
    async () => {
      const app = await launchTugApp({ testName: TEST_NAME });
      try {
        await app.seedDeckState({ state: kindDeck(cardKind("gallery-buttons"), GB), focusCardId: GB });
        const body = await standUpKind(app, cardKind("gallery-buttons"), GB);
        // card-dom: shell
        expect(await app.evalJS<boolean>(present(ROOT)), "the shell's document holds none of the gallery").toBe(false);

        // ── Its data: the card's sections are the body's rows ───────────
        const sections = await pollFor(() => body.evalJS<number>(count(SECTIONS)), (n) => n > 3, READ_MS);
        note(`gallery sections in the body: ${sections}`);
        expect(sections, "the body shows the card's sections").toBeGreaterThan(3);

        // ── Its interaction: the view toggle flips its label in the body ─
        expect(await body.evalJS<boolean>(markToggle), "the view toggle stands in the body").toBe(true);
        await Bun.sleep(300);
        await body.nativeClickAtElement(TOGGLE);
        const flipped = await pollFor(() => body.evalJS<string>(textOf(TOGGLE_LABEL)), (t) => t === VIEW_ALTERNATE, READ_MS);
        expect(flipped, "a click in the body flips the toggle's label").toBe(VIEW_ALTERNATE);
        await body.nativeClickAtElement(TOGGLE);
        const back = await pollFor(() => body.evalJS<string>(textOf(TOGGLE_LABEL)), (t) => t === VIEW_PRIMARY, READ_MS);
        expect(back, "a second click flips it back").toBe(VIEW_PRIMARY);

        // ── Its surface ──────────────────────────────────────────────────
        await expectContentSurface(app, GB, 0.3);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
