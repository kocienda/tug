/**
 * at0414-asset-trash-undo.test.ts — ✕ on a strip tile removes the link *and*
 * the file, and one ⌘Z brings both back.
 *
 * ## What this pins
 *
 * A ✕ that only edited text would leave the file behind, accumulating
 * invisibly — assets are git-ignored, so nothing would ever surface it. A ✕
 * that unlinked the file would be an unrecoverable destructive act behind a
 * small glyph. So the file moves to the macOS Trash and the undo moves it back
 * from the URL the host reported, coupled to the document edit through CM6's
 * history rather than through bookkeeping beside it.
 *
 * ## Trash hygiene
 *
 * These tests trash **real files into the running machine's Trash**. A case
 * that trashes without restoring litters a developer's Trash a little more on
 * every run, and the harness cannot clean that up. So every case here closes on
 * its restore assertion — "the file is back in `assets/`" is not merely the
 * behavior under test, it is this file's cleanup contract.
 *
 * @covers tugdeck/src/components/tugways/tug-text-card-editor/asset-trash.ts
 * @covers tugdeck/src/lib/os-trash.ts
 * @covers tugdeck/src/components/tugways/cards/text-card.tsx
 * @covers tugdeck/src/components/tugways/cards/tug-attachment-preview.tsx
 * @covers tugapp/Sources/MainWindow.swift
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const TEST_TIMEOUT_MS = 120_000;

const REPO_PNG_FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "resources",
  "AppIcon-1024b.png",
);

const EDITOR_CONTENT_SELECTOR =
  '[data-card-id="A"] [data-slot="tug-text-card-editor"] .cm-content';
const STRIP_SELECTOR = '[data-testid="text-card-asset-strip"]';
const TILE_SELECTOR = `${STRIP_SELECTOR} [data-slot="tug-attachment-preview__tile"]`;
const DELETE_SELECTOR = `${STRIP_SELECTOR} [data-slot="tug-attachment-preview__delete"]`;

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "text", title: "doc.md", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 760, height: 620 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["standard"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

function docText(app: App): Promise<string> {
  return app.body("A").evalJS<string>(
    `Array.from(document.querySelectorAll(${JSON.stringify(`${EDITOR_CONTENT_SELECTOR} .cm-line`)}))
      .map(function(l){ return l.textContent || ""; })
      .join("\\n")`,
  );
}

/** Press the ✕ on the tile at `index`. */
async function pressDelete(app: App, index: number): Promise<void> {
  await app.body("A").evalJS<void>(
    `(function(){
      var buttons = document.querySelectorAll(${JSON.stringify(DELETE_SELECTOR)});
      var button = buttons[${index}];
      if (button) button.click();
    })()`,
  );
}

/** Wait until `file` exists (or stops existing). */
async function waitForFile(
  file: string,
  present: boolean,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file) === present) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(
    `[at0414] ${file} was expected to ${present ? "exist" : "be gone"} within ${timeoutMs}ms`,
  );
}

describe.skipIf(!SHOULD_RUN)(
  "at0414: removing an attachment takes the file, and undo brings it back",
  () => {
    test(
      "the link and the file go together, and one undo restores both",
      async () => {
        const dir = fs.realpathSync(
          fs.mkdtempSync(path.join(os.tmpdir(), "at0414-")),
        );
        const docPath = path.join(dir, "doc.md");
        const assetsDir = path.join(dir, "assets");
        const asset = path.join(assetsDir, "photo.png");
        fs.mkdirSync(assetsDir);
        fs.copyFileSync(REPO_PNG_FIXTURE, asset);
        const original = fs.readFileSync(asset);
        fs.writeFileSync(
          docPath,
          "# Notes\n\nSEEDED ![photo](assets/photo.png)\n",
          "utf8",
        );

        try {
          const app = await launchTugApp({ bodies: true, testName: "at0414-asset-trash-undo" });
          try {
            await app.seedDeckState({
              state: deckShape(),
              cardStates: {
                A: {
                  content: {
                    path: docPath,
                    anchor: { line: 1, ch: 0 },
                    scrollTop: 0,
                  },
                },
              },
              focusCardId: "A",
            });
            await app.body("A").waitForCondition<boolean>(
              `document.querySelectorAll(${JSON.stringify(TILE_SELECTOR)}).length === 1`,
              { timeoutMs: 20_000 },
            );

            // ── ✕ ──────────────────────────────────────────────────────────
            await pressDelete(app, 0);

            // The file is gone from `assets/` — moved, not unlinked.
            await waitForFile(asset, false);
            // And the link went with it, so the document does not name a file
            // that is no longer there.
            await app.body("A").waitForCondition<boolean>(
              `document.querySelectorAll(${JSON.stringify(TILE_SELECTOR)}).length === 0`,
              { timeoutMs: 20_000 },
            );
            expect(await docText(app)).not.toContain("assets/photo.png");

            // ── ⌘Z ─────────────────────────────────────────────────────────
            await app.body("A").click(EDITOR_CONTENT_SELECTOR);
            await app.nativeKey("z", ["cmd"]);

            // Both halves return, and the bytes are the ones that left.
            await waitForFile(asset, true);
            expect(fs.readFileSync(asset).equals(original)).toBe(true);
            await app.body("A").waitForCondition<boolean>(
              `document.querySelectorAll(${JSON.stringify(TILE_SELECTOR)}).length === 1`,
              { timeoutMs: 20_000 },
            );
            expect(await docText(app)).toContain("assets/photo.png");
          } finally {
            await app.close();
          }
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "two removals undo independently, in reverse order",
      async () => {
        const dir = fs.realpathSync(
          fs.mkdtempSync(path.join(os.tmpdir(), "at0414-two-")),
        );
        const docPath = path.join(dir, "doc.md");
        const assetsDir = path.join(dir, "assets");
        const first = path.join(assetsDir, "one.png");
        const second = path.join(assetsDir, "two.png");
        fs.mkdirSync(assetsDir);
        fs.copyFileSync(REPO_PNG_FIXTURE, first);
        fs.copyFileSync(REPO_PNG_FIXTURE, second);
        fs.writeFileSync(
          docPath,
          "SEEDED ![one](assets/one.png) ![two](assets/two.png)\n",
          "utf8",
        );

        try {
          const app = await launchTugApp({ bodies: true, testName: "at0414-two-removals" });
          try {
            await app.seedDeckState({
              state: deckShape(),
              cardStates: {
                A: {
                  content: {
                    path: docPath,
                    anchor: { line: 1, ch: 0 },
                    scrollTop: 0,
                  },
                },
              },
              focusCardId: "A",
            });
            await app.body("A").waitForCondition<boolean>(
              `document.querySelectorAll(${JSON.stringify(TILE_SELECTOR)}).length === 2`,
              { timeoutMs: 20_000 },
            );

            // Remove the second, then the first.
            await pressDelete(app, 1);
            await waitForFile(second, false);
            await pressDelete(app, 0);
            await waitForFile(first, false);
            await app.body("A").waitForCondition<boolean>(
              `document.querySelectorAll(${JSON.stringify(TILE_SELECTOR)}).length === 0`,
              { timeoutMs: 20_000 },
            );

            // Undo twice — each ✕ was its own history entry, so each undo
            // brings back exactly the file it took.
            await app.body("A").click(EDITOR_CONTENT_SELECTOR);
            await app.nativeKey("z", ["cmd"]);
            await waitForFile(first, true);
            await app.nativeKey("z", ["cmd"]);
            await waitForFile(second, true);

            await app.body("A").waitForCondition<boolean>(
              `document.querySelectorAll(${JSON.stringify(TILE_SELECTOR)}).length === 2`,
              { timeoutMs: 20_000 },
            );
            // Both are back on disk, which is also this file's cleanup
            // contract — nothing is left in the machine's Trash.
            expect(fs.existsSync(first)).toBe(true);
            expect(fs.existsSync(second)).toBe(true);
          } finally {
            await app.close();
          }
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
