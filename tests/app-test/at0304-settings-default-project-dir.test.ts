/**
 * at0304-settings-default-project-dir.test.ts — the Settings card's General
 * tab persists the default project directory ([AT0304]).
 *
 * Scenario:
 *
 *   Open the Settings card via the same `show-card` control action the Swift
 *   Settings… (⌘,) menu item sends. Select the leading "General" tab, type a
 *   temp directory into the Default Project Directory field, and move focus
 *   off the field. Verify the value reached tugbank by reading it back over
 *   `GET /api/defaults/dev.tugapp.app/default-project-path` — the same HTTP
 *   surface the field's PUT went through, so the assertion covers the real
 *   write path rather than in-process store state.
 *
 *   What comes back is the path's CANONICAL spelling, not the string typed:
 *   the setting is a persisted key, matched against project bindings and
 *   recents, so it routes through the server's canonicalization gateway before
 *   it is stored ([L29]). Under a symlinked tmpdir (`/var` → `/private/var`)
 *   the two differ, which is what makes this assertion worth making. The field
 *   then shows the stored spelling — a settled field displays what tugbank
 *   holds and nothing else.
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
 * @covers tugdeck/src/components/tugways/cards/settings-card.tsx
 * @covers tugdeck/src/components/tugways/tug-combo-box.tsx
 * @covers tugdeck/src/components/tugways/tug-file-chooser.tsx
 * @covers tugdeck/src/lib/dir-existence.ts
 * @covers tugdeck/src/settings-api.ts
 */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { launchTugApp } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const NO_AX = { skipAccessibilityPreflight: true } as const;

/**
 * Where focus goes to settle the field. Another section's sidebar tab is the
 * stable in-card destination — it is always present, it is not inside the
 * General panel, and *focusing* it (no click) neither edits nor navigates
 * anything, so the panel under the field stays mounted while the write lands.
 */
const BLUR_TARGET = '[data-testid="tug-tab-view-tab-textCard"]';
const FIELD_INPUT =
  '[data-testid="settings-default-project-dir-field"] input';

describe.skipIf(!SHOULD_RUN)(
  "at0304: Settings ▸ General persists the default project directory",
  () => {
    test("typing a path and leaving the field writes it to tugbank", async () => {
      const dir = mkdtempSync(`${tmpdir()}/at0304-projects-`);
      const app = await launchTugApp({
        ...NO_AX,
        testName: "at0304-settings-default-project-dir",
      });
      try {
        await app.evalJS(
          `window.__tug.dispatchControlAction("show-card", { component: "settings" })`,
        );
        // General is the selected section on a fresh profile, so its body is
        // rendered without a selection gesture.
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-testid="settings-general"]') !== null`,
        );

        // Type the path, then move focus to another section's header. Focus
        // leaving is one of the gestures that settles the field, so the write
        // happens without an Enter press.
        await app.focusElement(FIELD_INPUT);
        await app.type(FIELD_INPUT, dir);
        expect(await app.getElementValue(FIELD_INPUT)).toBe(dir);
        await app.focusElement(BLUR_TARGET);

        // Read the value back over the defaults API. The field's write is a
        // fire-and-forget PUT, so a single GET can beat it to the server and
        // latch a 404 — poll until the key is there (or the poll times out and
        // the assertion below reports the last answer).
        await app.evalJS(`(() => {
          window.__at0304 = undefined;
          const poll = () => {
            fetch("/api/defaults/dev.tugapp.app/default-project-path")
              .then((r) => (r.ok ? r.json() : { kind: "error", value: r.status }))
              .then((j) => {
                if (j.kind === "string") { window.__at0304 = j; return; }
                window.setTimeout(poll, 100);
              })
              .catch((e) => { window.__at0304 = { kind: "error", value: String(e) }; });
          };
          poll();
        })()`);
        const stored = await app.waitForCondition<{
          kind: string;
          value: unknown;
        }>(
          `window.__at0304 === undefined ? false : window.__at0304`,
          { timeoutMs: 5000 },
        );
        expect(stored.kind).toBe("string");
        expect(stored.value).toBe(realpathSync(dir));

        // The field settles on what tugbank holds — the canonical spelling it
        // just took, not the string that was typed at it.
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(FIELD_INPUT)}).value ===
             ${JSON.stringify(realpathSync(dir))}`,
          { timeoutMs: 8000 },
        );
      } finally {
        await app.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);
