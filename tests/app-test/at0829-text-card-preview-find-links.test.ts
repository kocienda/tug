/**
 * at0829-text-card-preview-find-links.test.ts — Find, links and images in
 * the Text card's Markdown preview ([AT0829]).
 *
 * Scenario: seed a Text card on a Markdown file that embeds an image from its
 * own `assets/` directory, links the file next door, and says one word three
 * times. Press the Preview toggle.
 *
 *  - The image is fetched from the file beside the document, not from the
 *    page's origin, and it loads.
 *  - ⌘F opens the card's find bar over the preview: the query counts the
 *    rendered text's matches, Return steps to the next, the bar offers no
 *    replace row, and Escape takes the bar and its match paint away.
 *  - A click on the relative link opens the neighbouring file in a Text card
 *    of its own, and this card's page is still the preview: the click did not
 *    navigate it.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/cards/text-card.tsx
 * @covers tugdeck/src/components/tugways/cards/text-card-find-bar.tsx
 * @covers tugdeck/src/lib/markdown-preview-links.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";
import { launchTugApp, type App } from "./_harness";
import { mkTextFixture } from "./_harness/fixtures";
import { AUTOMATIC_SAVE_MODE, mkSeededTugbank } from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CARD = '[data-card-id="A"]';
const EDITOR_CONTENT = `${CARD} [data-slot="tug-text-card-editor"] .cm-content`;
const PREVIEW = `${CARD} [data-testid="text-card-preview"]`;
const TOGGLE = `${CARD} [data-testid="text-card-status-preview"]`;
const BAR = `${CARD} [data-slot="text-card-find-bar"]`;
const FIND_INPUT = `${BAR} [data-testid="text-card-find-input"] .cm-content`;
const REPLACE_INPUT = `${BAR} [data-testid="text-card-replace-input"]`;
const CHIP = `${BAR} [data-slot="find-count"] [data-slot="find-count-value"]`;

const FIXTURE_CONTENT = [
  "# Linked Notes",
  "",
  "![shot](assets/shot.png)",
  "",
  "First meridian. See [the neighbour](other.md) for more.",
  "",
  "Second meridian, and a third meridian.",
  "",
].join("\n");

const NEIGHBOUR_MARKER = "OPENEDNEIGHBOUR";

/** A 1 × 1 PNG. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const HIGHLIGHTS_PAINTED = `(CSS.highlights.has("document-find-active") || CSS.highlights.has("document-find-match"))`;

async function seedTextCard(app: App, filePath: string): Promise<void> {
  await app.seedDeckState({
    state: {
      cards: [{ id: "A", componentId: "text", title: "File", closable: true }],
      panes: [
        {
          id: "p1",
          position: { x: 40, y: 40 },
          size: { width: 760, height: 560 },
          cardIds: ["A"],
          activeCardId: "A",
          title: "",
          acceptsFamilies: ["standard"],
        },
      ],
      activePaneId: "p1",
      hasFocus: true,
    },
    cardStates: {
      A: { content: { path: filePath, anchor: { line: 1, ch: 0 }, scrollTop: 0 } },
    },
    focusCardId: "A",
  });
}

/** Whether some Text card other than A shows `marker` in its editor. */
async function neighbourOpened(app: App, marker: string): Promise<boolean> {
  for (const held of await app.bodies()) {
    if (held.componentId !== "text" || held.cardId === null || held.cardId === "A") continue;
    try {
      const showing = await app.body(held.cardId).evalJS<boolean>(
        `Array.from(document.querySelectorAll('[data-slot="tug-text-card-editor"] .cm-content'))
          .some((el) => (el.textContent ?? "").includes(${JSON.stringify(marker)}))`,
      );
      if (showing) return true;
    } catch {
      // A body still arriving answers nothing yet; the next poll reads it.
    }
  }
  return false;
}

describe.skipIf(!SHOULD_RUN)("at0829: Find, links and images in the Markdown preview", () => {
  test(
    "the preview loads a relative image, finds in the rendered text, and opens a relative link",
    async () => {
      const { dir, file } = mkTextFixture("at0829-", FIXTURE_CONTENT, {
        name: "notes.md",
        realpath: true,
      });
      fs.writeFileSync(path.join(dir, "other.md"), `# Other\n\n${NEIGHBOUR_MARKER}\n`, "utf8");
      fs.mkdirSync(path.join(dir, "assets"));
      const png = path.join(dir, "assets", "shot.png");
      fs.writeFileSync(png, Buffer.from(PNG_BASE64, "base64"));

      const app = await launchTugApp({
        testName: "at0829-text-card-preview-find-links",
        env: { TUGBANK_PATH: mkSeededTugbank([AUTOMATIC_SAVE_MODE]) },
      });
      try {
        await seedTextCard(app, file);
        const body = app.body("A");
        await body.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(EDITOR_CONTENT)})?.textContent ?? "").includes("Linked Notes")`,
          { timeoutMs: 15000 },
        );
        await body.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(TOGGLE)}) !== null`,
          { timeoutMs: 5000 },
        );

        await body.nativeClickAtElement(TOGGLE);
        await body.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${PREVIEW} h1`)}) !== null`,
          { timeoutMs: 5000 },
        );

        // --- The image comes from the file beside the document. ---
        expect(
          await body.evalJS<string | null>(
            `document.querySelector(${JSON.stringify(`${PREVIEW} img`)})?.getAttribute("src") ?? null`,
          ),
          "a relative image is pointed at the file in the document's directory",
        ).toBe(`/api/fs/blob?path=${encodeURIComponent(png)}`);
        await body.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(`${PREVIEW} img`)})?.naturalWidth ?? 0) > 0`,
          { timeoutMs: 5000 },
        );

        // --- Find searches the rendered text. ---
        await app.nativeKey("f", ["cmd"]);
        await body.waitForCondition<boolean>(
          `(() => {
            const input = document.querySelector(${JSON.stringify(FIND_INPUT)});
            return input !== null && document.activeElement !== null &&
              (input === document.activeElement || input.contains(document.activeElement));
          })()`,
          { timeoutMs: 5000 },
        );
        await app.nativeType("meridian");
        await body.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(CHIP)})?.textContent ?? "").trim() === "1 of 3"`,
          { timeoutMs: 6000 },
        );
        expect(
          await body.evalJS<boolean>(HIGHLIGHTS_PAINTED),
          "the matches are painted on the rendered text",
        ).toBe(true);
        expect(
          await body.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(REPLACE_INPUT)}) === null`,
          ),
          "the bar offers no replace row over the preview",
        ).toBe(true);
        await app.nativeKey("Return");
        await body.waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(CHIP)})?.textContent ?? "").trim() === "2 of 3"`,
          { timeoutMs: 5000 },
        );
        await app.nativeKey("Escape");
        await body.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(BAR)}) === null && !${HIGHLIGHTS_PAINTED}`,
          { timeoutMs: 5000 },
        );

        // --- A relative link opens the file next door. ---
        await body.nativeClickAtElement(`${PREVIEW} a[href="other.md"]`);
        const deadline = Date.now() + 10_000;
        let opened = false;
        while (!opened && Date.now() < deadline) {
          opened = await neighbourOpened(app, NEIGHBOUR_MARKER);
          if (!opened) await Bun.sleep(100);
        }
        expect(opened, "the linked file opened in a Text card of its own").toBe(true);
        expect(
          await body.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(`${PREVIEW} h1`)})?.textContent === "Linked Notes"`,
          ),
          "the click did not navigate this card's page",
        ).toBe(true);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
