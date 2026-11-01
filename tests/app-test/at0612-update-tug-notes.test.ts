/**
 * AT0612: the update wizard's release notes, driven entirely from the bridge.
 *
 * `at0612-update-tug-pill.test.ts` names the claims the rest of the update
 * feature rests on. This file pins the notes:
 *
 * - **The offered version's notes are drawn as markdown**, and notes that land
 *   after the wizard is up are drawn too.
 * - **A long note scrolls in its own region**, so it cannot push a row or the
 *   Close button off the panel, or the panel off the window.
 * - **No notes means no region**, and the flow's controls stand as they were.
 * - **"All release notes" opens GitHub's releases page through the path every
 *   external link takes**, read here at `window.open`, which the host answers
 *   with `NSWorkspace`. The stub is what keeps this file from opening a browser.
 *
 * @covers tugdeck/src/components/tugways/update-tug.tsx
 * @covers tugdeck/src/components/tugways/update-tug-rows.tsx
 * @covers tugdeck/src/components/tugways/update-tug.css
 * @covers tugdeck/src/components/tugways/tug-markdown-block.tsx
 * @covers tugdeck/src/components/tugways/tug-link.tsx
 * @covers tugdeck/src/overlay/overlay-main.ts
 * @covers tugdeck/src/lib/os-open.ts
 * @covers tugdeck/src/lib/update-store.ts
 */

import { describe, expect, test } from "bun:test";

import { note, type App } from "./_harness";
import {
  ALL_NOTES,
  CLOSE,
  NOTES,
  SHOULD_RUN,
  STEP_ROWS,
  TEST_TIMEOUT_MS,
  WIZARD,
  anchoredBox,
  cta,
  elementCount,
  goIdle,
  nextReveal,
  push,
  snapshot,
  ui,
  waitForClickable,
  waitForWizard,
  withUpdateDeck,
} from "./update-tug-fixture";

/** Far longer than any region: sixty list items under two headings. */
const LONG_NOTE = [
  "# Tug 0.9.0",
  "",
  "A **long** release.",
  "",
  "## The first part",
  "",
  ...Array.from({ length: 30 }, (_, i) => `- Change ${i} in the first part.`),
  "",
  "## The second part",
  "",
  ...Array.from({ length: 30 }, (_, i) => `- Change ${i} in the second part.`),
].join("\n");

/** The bottom edge of the lowest step row, and of the Close button. */
async function bottomEdges(app: App): Promise<{ rows: number; close: number; panel: number }> {
  return ui(app).evalJS(
    `(function () {
       var rows = document.querySelectorAll(${JSON.stringify(STEP_ROWS)});
       return {
         rows: rows[rows.length - 1].getBoundingClientRect().bottom,
         close: document.querySelector(${JSON.stringify(CLOSE)}).getBoundingClientRect().bottom,
         panel: document.querySelector(${JSON.stringify(WIZARD)}).getBoundingClientRect().bottom,
       };
     })()`,
  );
}

describe.skipIf(!SHOULD_RUN)("AT0612: the update wizard's release notes", () => {
  test(
    "the notes render, a long one scrolls in its region, none means no region, and the link opens the releases page",
    () =>
      withUpdateDeck("at0612-update-tug-notes", async (app) => {
        // ---- No notes: no region, and the link still stands --------------
        await goIdle(app);
        await push(app, snapshot("available", { revealCount: nextReveal() }));
        await waitForWizard(app, "available");
        expect(await elementCount(app, NOTES)).toBe(0);
        expect(await elementCount(app, ALL_NOTES)).toBe(1);
        expect(await elementCount(app, cta("install"))).toBe(1);

        // ---- Notes that land while the wizard is up are drawn ------------
        await push(app, snapshot("available", { releaseNotes: "# Tug 0.9.0\n\nA **short** one." }));
        await ui(app).waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${NOTES} strong`)})?.textContent === "short"`,
          { timeoutMs: 10_000 },
        );

        // ---- A long note scrolls in its region ---------------------------
        await push(app, snapshot("available", { releaseNotes: LONG_NOTE }));
        await ui(app).waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(NOTES)})?.textContent ?? "").includes("Change 29 in the second part.")`,
          { timeoutMs: 10_000 },
        );
        const region = await ui(app).evalJS<{ client: number; scroll: number; moved: number; rem: number }>(
          `(function () {
             var el = document.querySelector(${JSON.stringify(NOTES)});
             el.scrollTop = 200;
             var moved = el.scrollTop;
             el.scrollTop = 0;
             return {
               client: el.clientHeight,
               scroll: el.scrollHeight,
               moved: moved,
               rem: parseFloat(getComputedStyle(document.documentElement).fontSize),
             };
           })()`,
        );
        note("at0612 notes region", JSON.stringify(region));
        expect(region.client).toBeGreaterThan(0);
        expect(region.client).toBeLessThanOrEqual(12 * region.rem);
        expect(region.scroll).toBeGreaterThan(region.client);
        expect(region.moved).toBeGreaterThan(0);

        const panel = await anchoredBox(app, WIZARD);
        note("at0612 panel with a long note", JSON.stringify(panel));
        expect(panel.top).toBeGreaterThanOrEqual(0);
        expect(panel.top + panel.height).toBeLessThanOrEqual(panel.windowHeight);
        const edges = await bottomEdges(app);
        expect(edges.rows).toBeLessThanOrEqual(edges.close);
        expect(edges.close).toBeLessThanOrEqual(edges.panel);
        await waitForClickable(app, CLOSE);
        await waitForClickable(app, cta("install"));

        // ---- The notes stay through the flow, and leave with the offer ---
        await push(app, snapshot("downloading", { releaseNotes: LONG_NOTE, cancellable: true }));
        await waitForWizard(app, "downloading");
        expect(await elementCount(app, NOTES)).toBe(1);

        // ---- The link opens the releases page ----------------------------
        await ui(app).evalJS<null>(
          `(function () {
             window.__at0612Opened = [];
             window.open = function (url) { window.__at0612Opened.push(String(url)); return null; };
             return null;
           })()`,
        );
        await waitForClickable(app, ALL_NOTES);
        await ui(app).click(ALL_NOTES);
        await ui(app).waitForCondition<boolean>(`window.__at0612Opened.length > 0`, { timeoutMs: 10_000 });
        expect(await ui(app).evalJS<string[]>(`window.__at0612Opened`)).toEqual([
          "https://github.com/kocienda/tug/releases",
        ]);
        await waitForWizard(app, "downloading");

        await push(app, snapshot("error", { releaseNotes: LONG_NOTE, message: "the feed did not answer" }));
        await waitForWizard(app, "error");
        expect(await elementCount(app, NOTES)).toBe(0);
        expect(await elementCount(app, ALL_NOTES)).toBe(0);

        await goIdle(app);
      }),
    TEST_TIMEOUT_MS,
  );
});
