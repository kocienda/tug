/**
 * at0306-open-quickly-default-dir-settings.test.ts — choosing a new default
 * directory in Settings re-points Open Quickly ([AT0306]).
 *
 * One of the at0306-open-quickly-default-dir split, a test to a file so each
 * launch fits its own budget. Why Open Quickly falls back to the default
 * project directory, and the shared selectors and helpers, are
 * `open-quickly-default-dir-fixture.ts`.
 *
 * @covers tugdeck/src/components/chrome/open-quickly-overlay.tsx
 * @covers tugdeck/src/lib/overlay-shell.ts
 * @covers tugdeck/src/lib/default-workspace-store.ts
 * @covers tugdeck/src/lib/host-menu-state.ts
 * @covers tugdeck/src/lib/open-file-in-card.ts
 * @covers tugdeck/src/components/chrome/modal-input-dialog.tsx
 * @covers tugdeck/src/components/chrome/modal-input-dialog.css
 * @covers tugdeck/src/components/tugways/cards/settings-general-body.tsx
 * @covers tugdeck/src/components/tugways/tug-combo-box.tsx
 * @covers tugdeck/src/components/tugways/tug-combo-box.css
 * @covers tugdeck/src/components/tugways/tug-file-chooser.tsx
 * @covers tugdeck/src/lib/dir-existence.ts
 * @covers tugdeck/src/settings-api.ts
 * @family at0306-open-quickly-default-dir
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { launchTugApp } from "./_harness";
import { overlayReady } from "./overlay-fixture";
import { kindBody, waitForBodyPainted } from "./_harness/card-reach";
import {
  SHOULD_RUN,
  TEST_TIMEOUT_MS,
  PANEL,
  INPUT,
  ROWS,
  OVERLAY_ROOT,
  MARKER,
  OTHER_MARKER,
  typeIntoField,
} from "./open-quickly-default-dir-fixture";

describe.skipIf(!SHOULD_RUN)(
  "at0306: Open Quickly falls back to the default project directory",
  () => {
    test(
      "choosing a new default directory in Settings re-points Open Quickly",
      async () => {
        // The user's flow, end to end, with nothing synthesized in the middle:
        // type a partial path into Settings ▸ General, accept the completion
        // with a real Return, and open the dialog in the same breath.
        //
        // Accepting is the gesture that has to write. It is where the user
        // stops choosing, and a field that comes to rest there while tugbank
        // still holds the old path is the whole defect this test exists for —
        // the dialog went on naming a directory the user had visibly replaced.
        // So this asserts both halves: the store really changed (to the
        // CANONICAL spelling — the path is a persisted key, [L29]), and the
        // field shows exactly what the store holds.
        //
        // Then the dialog, immediately: until the server's DEFAULTS frame comes
        // back around, the only thing that knows the new path is the local
        // cache write `putDefaultProjectPath` makes once the PUT lands.
        const base = mkdtempSync(`${tmpdir()}/at0306-live-`);
        mkdirSync(`${base}/before`);
        writeFileSync(`${base}/before/${MARKER}`, "the old default\n");
        mkdirSync(`${base}/after`);
        writeFileSync(`${base}/after/${OTHER_MARKER}`, "the new default\n");

        const app = await launchTugApp({ testName: "at0306-open-quickly-live" });
        // Null-safe: the wait polls while the dialog is still mounting, and a
        // read that throws there is an exception, not a false.
        const placeholder = `(function () {
          var el = document.querySelector(${JSON.stringify(INPUT)});
          return el === null ? null : el.getAttribute("placeholder");
        })()`;
        const SETTINGS_FIELD =
          '[data-testid="settings-default-project-dir-field"] input';
        try {
          const ui = await overlayReady(app);
          await ui.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(OVERLAY_ROOT)}) !== null`,
            { timeoutMs: 20000 },
          );
          // Seeded over the same HTTP surface the Settings write below uses,
          // not set locally: a local set bumps this page's generation for the
          // domain, and the DEFAULTS frame that carries the Settings card's
          // write — made in the card's own page — would then lose to it here.
          await app.evalJS(`(() => {
            window.__at0306_seeded = undefined;
            fetch("/api/defaults/dev.tugapp.app/default-project-path", {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ kind: "string", value: ${JSON.stringify(`${base}/before`)} }),
            })
              .then((r) => { window.__at0306_seeded = r.ok; })
              .catch(() => { window.__at0306_seeded = false; });
          })()`);
          expect(await app.waitForCondition<boolean>(`window.__at0306_seeded`, { timeoutMs: 10000 })).toBe(true);
          await app.waitForCondition<boolean>(
            `(function () {
               var v = window.__tug.getTugbankValue("dev.tugapp.app", "default-project-path");
               return v !== null && typeof v.value === "string" && v.value.endsWith("/before");
             })()`,
            { timeoutMs: 10000 },
          );

          // Baseline: the dialog opens on the directory that is set now.
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("open-quickly"), null)`,
          );
          await ui.waitForCondition<boolean>(
            `${placeholder} === "Open Quickly in before"`,
            { timeoutMs: 10000 },
          );
          await app.nativeKey("Escape");
          await ui.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(PANEL)}) === null`,
            { timeoutMs: 8000 },
          );

          // Change it the way the user does — the Settings card's own field.
          await app.evalJS(
            `window.__tug.dispatchControlAction("show-card", { component: "settings" })`,
          );
          // The card's sections are all expanded on a fresh profile, so
          // General's body is rendered without a selection gesture.
          const settings = kindBody(app, "settings");
          await settings.waitForCondition<boolean>(
            `document.querySelector('[data-testid="settings-general"]') !== null`,
            { timeoutMs: 10000 },
          );
          // The field is reached with a real click, once the body is placed:
          // the body has to be the window's first responder for the Return
          // below to land in it.
          await waitForBodyPainted(app, "settings");
          await settings.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(SETTINGS_FIELD)}) !== null`,
            { timeoutMs: 10000 },
          );
          await settings.nativeClickAtElement(SETTINGS_FIELD);
          // Type a PARTIAL path — replacing the field's contents, since the
          // field already shows the stored path and `app.type` types after it.
          // Partial so the completion list has something to offer, which is
          // what the real gesture ends on.
          await settings.evalJS<null>(
            `(function(){
               var field = document.querySelector(${JSON.stringify(SETTINGS_FIELD)});
               var setter = Object.getOwnPropertyDescriptor(
                 window.HTMLInputElement.prototype, "value").set;
               setter.call(field, ${JSON.stringify(`${base}/aft`)});
               field.dispatchEvent(new Event("input", { bubbles: true }));
               return null;
             })()`,
          );
          await settings.waitForCondition<boolean>(
            `Array.from(document.querySelectorAll(".tug-combo-box-item"))
               .some((el) => (el.textContent || "").indexOf("after") !== -1)`,
            { timeoutMs: 8000 },
          );

          // Accept it with a real Return. This is the settle: the field stops
          // being an edit and the value has to reach tugbank.
          await app.nativeKey("Return");

          // tugbank really holds it, read back over the same HTTP surface the
          // write went through — and in the CANONICAL spelling, which under a
          // symlinked tmpdir (`/var` → `/private/var`) is not the string that
          // was typed. A write that skipped the gateway fails here ([L29]).
          // Polled on a window global because `evalJS` can't await.
          const canonicalAfter = `${realpathSync(base)}/after`;
          await app.evalJS(`(() => {
            window.__at0306 = undefined;
            const poll = () => {
              fetch("/api/defaults/dev.tugapp.app/default-project-path")
                .then((r) => (r.ok ? r.json() : { kind: "error", value: r.status }))
                .then((j) => {
                  if (j.kind === "string" && j.value !== ${JSON.stringify(`${base}/before`)}) {
                    window.__at0306 = j;
                    return;
                  }
                  window.setTimeout(poll, 100);
                })
                .catch((e) => { window.__at0306 = { kind: "error", value: String(e) }; });
            };
            poll();
          })()`);
          const stored = await app.waitForCondition<{ value: string }>(
            `window.__at0306`,
            { timeoutMs: 15000 },
          );
          expect(stored.value).toBe(canonicalAfter);

          // And the field shows what the store holds — no settled field ever
          // displays a path tugbank doesn't have.
          expect(
            await settings.evalJS<string>(
              `document.querySelector(${JSON.stringify(SETTINGS_FIELD)}).value`,
            ),
          ).toBe(canonicalAfter);

          // Open Quickly, right now — no waiting on the server round trip.
          await app.evalJS<null>(
            `(window.__tug.dispatchControlAction("open-quickly"), null)`,
          );
          await ui.waitForCondition<boolean>(
            `${placeholder} === "Open Quickly in after"`,
            { timeoutMs: 10000 },
          );

          // And the search root really moved, not just the label: the file
          // that only exists in the new directory is the one that comes back.
          await typeIntoField(ui, "at0306-");
          await ui.waitForCondition<boolean>(
            `Array.from(document.querySelectorAll(${JSON.stringify(ROWS)}))
               .some((el) => (el.textContent || "").indexOf(${JSON.stringify(OTHER_MARKER)}) !== -1)`,
            { timeoutMs: 10000 },
          );
        } finally {
          await app.close();
          rmSync(base, { recursive: true, force: true });
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
