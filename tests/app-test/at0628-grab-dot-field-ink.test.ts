/**
 * at0628-grab-dot-field-ink.test.ts — the ink is the field's own, so a focus
 * flip restyles nothing else in the pane.
 *
 * One of the at0628-grab-dot-field split, a test to a file so each launch
 * fits its own budget. Why the field is drawn the way it is, the deck, the
 * readers and the fixtures are `grab-dot-field-fixture.ts`.
 *
 * @covers tugdeck/src/components/tugways/tug-pane.css
 * @covers tugdeck/src/components/tugways/session-masthead.css
 * @covers tugdeck/src/components/tugways/card-masthead.css
 * @covers tugdeck/src/components/tugways/commit-masthead.css
 * @covers tugdeck/src/components/chrome/tug-pane.tsx
 * @covers tugdeck/src/components/tugways/tug-session-row.tsx
 * @family at0628-grab-dot-field
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";
import {
  AFTER_LAND_MS,
  DECK,
  DOC_FRAME,
  SESSION_FRAME,
  SESSION_PANE,
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  wait,
  type InkReading,
} from "./grab-dot-field-fixture";

describe.skipIf(!SHOULD_RUN)("at0628 — the grab-dot field", () => {
  test(
    "the ink is the field's own, so a focus flip restyles nothing else in the pane",
    async () => {
      const app = await launchTugApp({ testName: "at0628-grab-dot-ink" });
      try {
        await app.seedDeckState({ state: DECK, focusCardId: "A" });
        await app.bindSession("A", {
          tugSessionId: "at0628-ink-A",
          projectDir: "/tmp/at0628",
        });
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SESSION_FRAME)}) !== null` +
            ` && document.querySelector(${JSON.stringify(SESSION_PANE)})` +
            `.getAttribute("data-focused") === "true"`,
          { timeoutMs: 15_000 },
        );
        await app.body("B").waitForCondition<boolean>(`document.querySelector(${JSON.stringify(DOC_FRAME)}) !== null`, {
          timeoutMs: 15_000,
        });
        await wait(AFTER_LAND_MS);

        // Every element of the two content panes, the pane included, and what
        // each resolves `--tugx-pane-dot-ink` to. Read off the browser, so a
        // declaration anywhere above the field — on the pane, the bar, a
        // masthead frame — shows up as an element that resolves it. Each pane
        // in the page that draws its chrome: each card's own.
        const inkIn = (page: Pick<App, "evalJS">, panes: Array<[string, string]>): Promise<InkReading> =>
          page.evalJS<InkReading>(
            `(function (panes) {
              var out = { holders: [], fields: {}, count: 0 };
              panes.forEach(function (entry) {
                var id = entry[0];
                var pane = document.querySelector(entry[1]);
                if (pane === null) return;
                var els = [pane].concat(Array.prototype.slice.call(pane.querySelectorAll("*")));
                out.count += els.length;
                els.forEach(function (el) {
                  var ink = getComputedStyle(el).getPropertyValue("--tugx-pane-dot-ink").trim();
                  if (el.classList.contains("tug-pane-grab-dots")) {
                    (out.fields[id] = out.fields[id] || []).push(ink);
                  } else if (ink !== "") {
                    out.holders.push(id + " " + String(el.className || el.tagName).split(" ")[0]);
                  }
                });
              });
              return out;
            })(${JSON.stringify(panes)})`,
          );
        const read = async (): Promise<InkReading> => {
          const own = await inkIn(app.body("A"), [["p1", SESSION_PANE]]);
          const shell = await inkIn(app.body("B"), [["p2", ".body-chrome-frame"]]);
          return {
            holders: [...own.holders, ...shell.holders],
            fields: { ...own.fields, ...shell.fields },
            count: own.count + shell.count,
          };
        };

        const before = await read();
        note(
          `focus on A: ${before.count} elements, holders ${JSON.stringify(before.holders.slice(0, 5))}, fields ${JSON.stringify(before.fields)}`,
        );
        expect(before.count, "the panes are populated").toBeGreaterThan(50);
        // The ink resolves on the field and nowhere else. An element that
        // resolves it is one whose style a focus flip would change.
        expect(before.holders, "no element but a field holds the ink").toEqual([]);
        expect(before.fields.p1?.length ?? 0, "the focused pane has a field").toBeGreaterThan(0);
        expect(before.fields.p2?.length ?? 0, "the unfocused pane has a field").toBeGreaterThan(0);
        const focusedInk = before.fields.p1[0];
        const recededInk = before.fields.p2[0];
        expect(focusedInk, "the focused field is inked").not.toBe("");
        expect(recededInk, "the receded field is inked").not.toBe("");
        expect(recededInk, "the ink follows the pane's focus").not.toBe(focusedInk);

        // The flip, through the product's own door.
        await app.evalJS<null>(
          `(function () { window.__tug.activateCard("B"); return null; })()`,
        );
        await app.body("B").waitForCondition<boolean>(
          `document.querySelector(".body-chrome-frame")` +
            `.getAttribute("data-focused") === "true"`,
          { timeoutMs: 5_000 },
        );
        await wait(300);

        const after = await read();
        note(`focus on B: fields ${JSON.stringify(after.fields)}`);
        expect(after.holders, "still no element but a field holds the ink").toEqual([]);
        // The dots look the same: each field took the other's ink.
        for (const ink of after.fields.p1 ?? []) {
          expect(ink, "the pane that lost focus wears the receded ink").toBe(recededInk);
        }
        for (const ink of after.fields.p2 ?? []) {
          expect(ink, "the pane that took focus wears the focused ink").toBe(focusedInk);
        }
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
