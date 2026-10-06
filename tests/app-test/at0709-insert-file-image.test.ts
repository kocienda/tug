/**
 * at0709-insert-file-image.test.ts — Session ▸ Insert File… attaches an
 * image as an image, the same thing dropping it does.
 *
 * ## The gap this pins
 *
 * Insert File used to mint a `file` atom for whatever the panel returned, so
 * choosing a PNG put a chip *naming its path* in the prompt where dropping the
 * same PNG attached the picture. Two doors, one file, two meanings. The door
 * now reads an image's bytes back through tugcast and runs them through the
 * drop pipeline, so the result is an `image-N` attachment; anything else is
 * still the `file` atom it always was.
 *
 * ## Shape
 *
 * One bound Session card. The `insert-file` control — the frame the host's
 * NSOpenPanel sends — is dispatched twice through the real control door:
 *
 *   **An image becomes an image atom.** A real PNG on disk lands as a
 *   `data-atom-type="image"` chip labelled `image-1`, and no `file` atom
 *   appears.
 *
 *   **Anything else stays a file atom.** A `.txt` path lands as a
 *   `data-atom-type="file"` chip whose value is the absolute path.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/tug-text-editor/insert-picked-file.ts
 * @covers tugdeck/src/components/tugways/tug-text-editor/drop-extension.ts
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchTugApp } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const TEST_TIMEOUT_MS = 120_000;

/** A valid 1×1 PNG — real bytes a real decoder has to handle. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

/** The composer's editable surface. */
const EDITOR_CONTENT = `[data-card-id="A"] [data-slot="tug-text-editor"] .cm-content`;

const atomOfType = (type: string): string =>
  `${EDITOR_CONTENT} img[data-atom-type="${type}"]`;

const DECK_STATE = {
  cards: [
    { id: "A", componentId: "session", title: "Session A", closable: true },
  ],
  panes: [
    {
      id: "p1",
      position: { x: 20, y: 20 },
      size: { width: 720, height: 520 },
      cardIds: ["A"],
      activeCardId: "A",
      title: "",
      acceptsFamilies: ["maker"],
    },
  ],
  activePaneId: "p1",
  hasFocus: true,
};

describe.skipIf(!SHOULD_RUN)(
  "at0709: Insert File attaches an image the way a drop does",
  () => {
    test(
      "an image path lands as an image atom, any other path as a file atom",
      async () => {
        const fixtureDir = mkdtempSync(join(tmpdir(), "at0709-insert-file-"));
        const pngPath = join(fixtureDir, "picked.png");
        const txtPath = join(fixtureDir, "notes.txt");
        writeFileSync(pngPath, PNG_1X1);
        writeFileSync(txtPath, "notes\n");

        try {
          const app = await launchTugApp({
            testName: "at0709-insert-file-image",
          });

          await app.seedDeckState({ state: DECK_STATE, focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          );
          await app.bindSession("A");
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(EDITOR_CONTENT)}) !== null`,
            { timeoutMs: 15_000 },
          );
          await app.nativeClickAtElement(EDITOR_CONTENT);

          // ── An image becomes an image atom ───────────────────────────
          await app.evalJS<void>(
            `(window.__tug.dispatchControlAction("insert-file", { path: ${JSON.stringify(pngPath)} }), null)`,
          );
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(atomOfType("image"))}) !== null`,
            { timeoutMs: 15_000 },
          );
          const image = await app.evalJS<{ label: string | null; files: number }>(
            `(function(){
              var img = document.querySelector(${JSON.stringify(atomOfType("image"))});
              return {
                label: img.getAttribute("data-atom-label"),
                files: document.querySelectorAll(${JSON.stringify(atomOfType("file"))}).length,
              };
            })()`,
          );
          expect(
            image.label,
            "axis image: an inserted PNG is an attachment named like a dropped one",
          ).toBe("image-1");
          expect(
            image.files,
            "axis image: an inserted PNG mints no file atom",
          ).toBe(0);

          // ── Anything else stays a file atom ──────────────────────────
          await app.evalJS<void>(
            `(window.__tug.dispatchControlAction("insert-file", { path: ${JSON.stringify(txtPath)} }), null)`,
          );
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(atomOfType("file"))}) !== null`,
            { timeoutMs: 15_000 },
          );
          const fileValue = await app.evalJS<string | null>(
            `document.querySelector(${JSON.stringify(atomOfType("file"))}).getAttribute("data-atom-value")`,
          );
          expect(
            fileValue,
            "axis file: a non-image path is a file atom carrying its absolute path",
          ).toBe(txtPath);
        } finally {
          rmSync(fixtureDir, { recursive: true, force: true });
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
