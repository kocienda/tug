/**
 * at0822-share-turns-bar-render.test.ts — the share bar's rendered outputs:
 * an image previewed from the bar, the gate it opens, and the refusal of an
 * image too tall to read in a message.
 *
 * ## What this gates
 *
 * The host's render itself is `at0821`'s; the scrub and the Markdown path are
 * `at0819`'s. What only the whole bar has is the wiring between them: the
 * Format choice reaching the store, Preview… rendering the scrubbed slice
 * through the host and showing the file in the preview sheet, the artifact
 * held for Save…, and the cap's refusal turned into a format change and a
 * bulletin.
 *
 *   A. Two short turns marked, Image chosen, Preview… renders them and shows
 *      the sheet; on its Done the store holds a `png` artifact whose file is
 *      on disk, and Save…, Copy and Share… open with it.
 *   B. Choosing PDF moves the signature: Save… closes until a new Preview….
 *   C. With the tall third turn marked too, Image and Preview… show
 *      "Rendering…" while the host renders, then refuse: no sheet, the
 *      format is PDF again, and the bulletin says why.
 *
 * Turns are marked through `__tug.shareMark`: the tall turn pushes the others
 * out of the windowed list, and a mark's click is `at0819`'s to gate.
 *
 * @covers tugdeck/src/lib/share-actions.ts
 * @covers tugdeck/src/components/tugways/cards/session-share-bar.tsx
 * @covers tugdeck/src/components/tugways/cards/session-share-bar.css
 * @covers tugdeck/src/lib/share-turns-store.ts
 * @covers tugdeck/src/lib/os-share.ts
 */

import { describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";

import { launchTugApp, note } from "./_harness";
import {
  BAR,
  BULLETIN,
  COPY,
  PREVIEW,
  RENDERING,
  SAVE,
  SHARE,
  chooseFormat,
  enabledJs,
  formatChoice,
  openSeededCard,
  previewAndDismiss,
  type SeedTurn,
} from "./share-probes";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SID = "at0822-session";

/** Two short turns, then one whose reply runs far past the image cap. */
const TURNS: SeedTurn[] = [
  { prompt: "what is here?", reply: "A small project with a README." },
  { prompt: "and the tests?", reply: "They live under `tests/`." },
  {
    prompt: "list every line",
    // Four hundred one-word paragraphs: about 1.2 KB on the wire — a large
    // payload through the harness's RPC does not arrive — standing well past
    // 8000 pixels in the 720-pixel column.
    reply: Array.from({ length: 400 }, (_, i) => `line${i + 1}`).join("\n\n"),
  },
];

interface ShareState {
  active: boolean;
  format: "markdown" | "pdf" | "png";
  rendering: boolean;
  canSend: boolean;
  lastArtifact: { format: string; path: string; htmlLength: number; markdownLength: number } | null;
}

describe.skipIf(!SHOULD_RUN)("AT0822: the share bar's rendered outputs", () => {
  test(
    "an image previews from the bar and opens Save…, a format change closes it, and a tall image is refused for PDF",
    async () => {
      const app = await launchTugApp({ testName: "at0822-share-turns-bar-render" });
      let projectDir = "";
      let imagePath = "";
      try {
        projectDir = await openSeededCard(app, SID, TURNS, false);
        const card = app.body("A");
        const state = () => card.evalJS<ShareState>(`window.__tug.shareState("A")`);

        await app.performMenuItem("file.shareTurns");
        await card.waitForCondition<boolean>(`!!document.querySelector(${JSON.stringify(BAR)})`, {
          timeoutMs: 6_000,
        });
        expect((await state()).format, "a share starts as a PDF").toBe("pdf");
        expect(await card.evalJS<number>(`window.__tug.shareMark("A", [0, 1])`)).toBe(2);

        // ── A. An image, previewed from the bar ────────────────────────────
        await chooseFormat(app, "png");
        await previewAndDismiss(app, 15_000);
        await card.waitForCondition<boolean>(
          `window.__tug.shareState("A").lastArtifact?.format === "png"`,
          { timeoutMs: 4_000 },
        );
        const previewed = await state();
        note(`at0822 previewed: ${JSON.stringify(previewed)}`);
        imagePath = previewed.lastArtifact!.path;
        expect(existsSync(imagePath), "the previewed image is on disk").toBe(true);
        expect(previewed.lastArtifact!.markdownLength, "the plain-text flavour rides with it").toBeGreaterThan(0);
        await card.waitForCondition<boolean>(enabledJs(SAVE), { timeoutMs: 4_000 });
        expect(await card.evalJS<boolean>(enabledJs(COPY)), "Copy opens with the image").toBe(true);
        expect(await card.evalJS<boolean>(enabledJs(SHARE)), "Share… opens with the image").toBe(true);

        // ── B. PDF moves the signature; Save… closes ───────────────────────
        await chooseFormat(app, "pdf");
        await card.waitForCondition<boolean>(`!(${enabledJs(SAVE)})`, { timeoutMs: 4_000 });
        expect((await state()).canSend).toBe(false);

        // ── C. A tall image is refused for PDF ──────────────────────────────
        await chooseFormat(app, "png");
        expect(await card.evalJS<number>(`window.__tug.shareMark("A", [2])`)).toBe(3);
        await card.nativeClickAtElement(PREVIEW);
        await card.waitForCondition<boolean>(`!!document.querySelector(${JSON.stringify(RENDERING)})`, {
          timeoutMs: 4_000,
        });
        await card.waitForCondition<boolean>(
          `Array.from(document.querySelectorAll(${JSON.stringify(BULLETIN)})).some(function (el) { return (el.textContent || "").indexOf("Too tall for an image") >= 0; })`,
          { timeoutMs: 15_000 },
        );
        const refused = await state();
        note(`at0822 refused: ${JSON.stringify(refused)}`);
        expect(refused.format, "the bar moved to PDF").toBe("pdf");
        expect(refused.rendering).toBe(false);
        expect(refused.canSend, "nothing new was previewed").toBe(false);
        expect(
          await card.evalJS<string | null>(
            `document.querySelector(${JSON.stringify(formatChoice("pdf"))})?.getAttribute("aria-checked") ?? null`,
          ),
          "the Format choice shows PDF",
        ).toBe("true");
        expect((await app.windowState()).isKeyWindow, "no preview sheet opened").toBe(true);
      } finally {
        await app.close();
        if (imagePath !== "") rmSync(imagePath, { force: true });
        if (projectDir !== "") rmSync(projectDir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
