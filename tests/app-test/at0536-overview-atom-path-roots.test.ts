/**
 * at0536-overview-atom-path-roots.test.ts — a chip in the Overview's composer
 * is an object you can act on.
 *
 * ## What was inert
 *
 * An `@` mention's value comes from the FILETREE index, which reports paths
 * relative to the workspace root, while every gesture on a chip — Open in
 * Editor, Show in Finder — speaks absolute only. The Session entry closes that
 * gap by handing the substrate an `atomPathRoots` thunk; the Overview handed
 * it nothing. `payloadForAtom` returns `null` for a relative value with no
 * root, so the chip was stamped with no annotation at all: not a chip that
 * opened the wrong file, a chip that offered nothing and looked exactly like
 * one that would.
 *
 * ## The root, and where it comes from
 *
 * The Overview is app-wide and has no per-card project binding, so its `@`
 * queries carry no `root` and fall through to tugcast's bootstrap workspace.
 * The frontend is never told that directory's path any other way — so the
 * completion store learns it from the answers it is already reading, where
 * tugcast splices it in as `workspace_key`. The composer then addresses chips
 * against the same store its mentions were counted from, which is the point:
 * one root, not two guesses at one.
 *
 * ## Claims
 *
 *  1. **The chip carries an absolute path.** `@`-complete a real file at the
 *     root of this checkout and the placed atom is stamped as a `file-path`
 *     annotation whose `data-path` is absolute and ends at the file that was
 *     named. A relative `data-path`, or no annotation at all, is the old
 *     behaviour.
 *  2. **And the gestures are offered.** A right-click on the chip shows `Open
 *     in Editor` and `Show in Finder` — the registry's own entries for a
 *     file, reached because the payload now exists to key them off.
 *
 * @covers tugdeck/src/components/overview/overview-card.tsx
 * @covers tugdeck/src/lib/filetree-store.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 90_000;

const CARD = '[data-testid="overview-card"]';
const FIELD = '[data-testid="overview-composer-field"]';
const CONTENT = `${FIELD} .cm-content`;
const CHIP = `${CONTENT} img[data-atom-label]`;
const COMPLETION_MENU = '[data-slot="tug-completion-menu"]';
const MENU = '[data-slot="tug-editor-context-menu"]';

/** A real file at the root of this checkout, which the bootstrap index finds. */
const NAMED_FILE = "CLAUDE.md";

const ITEMS_JS = `Array.from(
  document.querySelectorAll(${JSON.stringify(`${COMPLETION_MENU} .tug-completion-menu-item`)}),
).map(function (el) { return (el.textContent || "").trim(); })`;

/**
 * Right-click the chip at its own center — a real `contextmenu`, so the menu
 * samples the annotation under the pointer rather than a smart-selected
 * neighbour.
 */
const OPEN_MENU_OVER_CHIP = `(function(){
  var el = document.querySelector(${JSON.stringify(CHIP)});
  if (el === null) return "__NO_CHIP__";
  var rect = el.getBoundingClientRect();
  var x = Math.round(rect.left + rect.width / 2);
  var y = Math.round(rect.top + rect.height / 2);
  el.dispatchEvent(new MouseEvent("contextmenu", {
    bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2,
  }));
  return "ok";
})()`;

describe.skipIf(!SHOULD_RUN)(
  "at0536 — the Overview's chips carry an address",
  () => {
    test(
      "an @-completed mention resolves to an absolute path and offers its gestures",
      async () => {
        const app = await launchTugApp({
          testName: "at0536-overview-atom-path-roots",
        });
        try {
          await app.nativeKey("o", ["cmd", "ctrl"]);
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(CARD)}) !== null`,
            { timeoutMs: 15_000 },
          );

          // The `@` provider is the live FILETREE one against the bootstrap
          // workspace, which is this checkout. Wait for the FILTERED list —
          // the popup shows the cached root listing while the answer is in
          // flight, and accepting then takes whatever came first.
          await app.nativeClickAtElement(FIELD);
          await app.nativeType(`@${NAMED_FILE.slice(0, 6)}`);
          await app.waitForCondition<boolean>(
            `(function () {
              var items = ${ITEMS_JS};
              return items.length > 0 && items[0] === ${JSON.stringify(NAMED_FILE)};
            })()`,
            { timeoutMs: 15_000 },
          );
          await app.nativeKey("Return");
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(CHIP)}) !== null`,
            { timeoutMs: 10_000 },
          );

          // ── 1. The chip carries an absolute path. ────────────────────────
          const stamped = await app.evalJS<{
            label: string | null;
            annotation: string | null;
            path: string | null;
          }>(`(function(){
            var el = document.querySelector(${JSON.stringify(CHIP)});
            return {
              label: el.getAttribute("data-atom-label"),
              annotation: el.getAttribute("data-tug-annotation"),
              path: el.getAttribute("data-path"),
            };
          })()`);
          note("the stamped chip", JSON.stringify(stamped));
          expect(stamped.label).toBe(NAMED_FILE);
          // No annotation is the old behaviour exactly: `payloadForAtom`
          // returned null for a relative value it had no root for, and the
          // chip was stamped with nothing.
          expect(stamped.annotation).toBe("file-path");
          expect(
            stamped.path !== null && stamped.path.startsWith("/"),
            `expected an absolute path, got ${JSON.stringify(stamped.path)}`,
          ).toBe(true);
          // And it is this file's address rather than some other root's: the
          // mention's own value is the tail.
          expect(stamped.path!.endsWith(`/${NAMED_FILE}`)).toBe(true);

          // ── 2. The gestures a file offers are there. ─────────────────────
          expect(await app.evalJS<string>(OPEN_MENU_OVER_CHIP)).toBe("ok");
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(`${MENU} [data-item-action="open-file"]`)}) !== null`,
            { timeoutMs: 8_000 },
          );
          const labels = await app.evalJS<string[]>(
            `Array.from(document.querySelectorAll(${JSON.stringify(`${MENU} [data-item-action]`)}))
              .map(function (el) { return (el.getAttribute("data-item-action") || ""); })`,
          );
          note("chip menu actions", JSON.stringify(labels));
          expect(labels).toContain("open-file");
          expect(labels).toContain("reveal-in-finder");
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
