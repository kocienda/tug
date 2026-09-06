/**
 * at0526-settings-briefs-dir.test.ts — the Settings card's General tab
 * persists the briefs directory ([AT0526]).
 *
 * Scenario:
 *
 *   Open the Settings card the way the Settings… (⌘,) menu item does, type a
 *   template into the Briefs Directory field, and move focus off the field.
 *   Verify the value reached tugbank by reading it back over
 *   `GET /api/defaults/dev.tugapp.app/briefs-path` — the same HTTP surface the
 *   field's PUT went through.
 *
 *   What comes back is the string **verbatim**, and that is the point of the
 *   test. This value is a template rather than a path: `{project_dir}` stands
 *   for whichever project a brief is being written in, and `tugtool brief dir`
 *   is what resolves it. Canonicalizing it — the neighbouring row's regime,
 *   under [L29] — would refuse it outright, since a template names no
 *   directory that exists. So there is no `realpathSync` here.
 *
 *   The read is a fetch parked on a window global and polled by
 *   `waitForCondition`, because the harness's `evalJS` is synchronous and
 *   cannot await a promise.
 *
 * Gating
 * ------
 * `describe.skipIf(!SHOULD_RUN)`. CI and `bun x tsc --noEmit` runs without
 * `TUGAPP_APP_TEST=1` skip every test.
 *
 * @covers tugdeck/src/components/tugways/cards/settings-general-body.tsx
 * @covers tugdeck/src/components/tugways/tug-file-chooser.tsx
 * @covers tugdeck/src/settings-api.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const NO_AX = { skipAccessibilityPreflight: true } as const;

/** Another section's sidebar tab — focusing it settles the field without
 *  unmounting the panel the field lives in. */
const BLUR_TARGET = '[data-testid="tug-tab-view-tab-textCard"]';
const FIELD_INPUT = '[data-testid="settings-briefs-dir-field"] input';

/** A template, not a path: the placeholder is what makes it one. */
const TEMPLATE = "{project_dir}/docs/briefs";

describe.skipIf(!SHOULD_RUN)(
  "at0526: Settings ▸ General persists the briefs directory",
  () => {
    test("typing a template and leaving the field stores it verbatim", async () => {
      const app = await launchTugApp({
        ...NO_AX,
        testName: "at0526-settings-briefs-dir",
      });
      try {
        await app.evalJS(
          `window.__tug.dispatchControlAction("show-card", { component: "settings" })`,
        );
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-testid="settings-general"]') !== null`,
        );

        await app.focusElement(FIELD_INPUT);
        await app.type(FIELD_INPUT, TEMPLATE);
        expect(await app.getElementValue(FIELD_INPUT)).toBe(TEMPLATE);
        await app.focusElement(BLUR_TARGET);

        // The write is a fire-and-forget PUT, so a single GET can beat it to
        // the server and latch a 404 — poll until the key is there.
        await app.evalJS(`(() => {
          window.__at0526 = undefined;
          const poll = () => {
            fetch("/api/defaults/dev.tugapp.app/briefs-path")
              .then((r) => (r.ok ? r.json() : { kind: "error", value: r.status }))
              .then((j) => {
                if (j.kind === "string") { window.__at0526 = j; return; }
                window.setTimeout(poll, 100);
              })
              .catch((e) => { window.__at0526 = { kind: "error", value: String(e) }; });
          };
          poll();
        })()`);
        const stored = await app.waitForCondition<{
          kind: string;
          value: unknown;
        }>(`window.__at0526 === undefined ? false : window.__at0526`, {
          timeoutMs: 5000,
        });
        expect(stored.kind).toBe("string");
        expect(stored.value).toBe(TEMPLATE);

        // The field settles on what tugbank holds, which here is what was typed.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(FIELD_INPUT)}).value ===
             ${JSON.stringify(TEMPLATE)}`,
          { timeoutMs: 8000 },
        );
      } finally {
        await app.close();
      }
    });
  },
);
