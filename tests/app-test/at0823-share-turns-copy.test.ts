/**
 * at0823-share-turns-copy.test.ts — what Copy and Share… send for a rendered
 * share: the PDF as inline-styled HTML beside its Markdown, the image as a
 * PNG beside its Markdown, and the system share picker over the file.
 *
 * ## What this gates
 *
 *   A. A previewed PDF's Copy puts HTML on the system pasteboard that carries
 *      inline styles and the first turn's prompt, and plain text that is the
 *      Markdown — read back through the native bridge.
 *   B. A previewed Image's Copy puts a PNG there, and the Markdown as plain
 *      text. The bridge's read carries no image flavour, so the type list is
 *      read from this process with `osascript -e 'clipboard info'`, a read of
 *      the pasteboard and never an event into the app.
 *   C. Share… over the image answers `shown`. The picker's own UI is
 *      AppKit's; the Escape that closes it is cleanup, not an assertion.
 *
 * Each Copy is pressed with a native click on the bar's button; the share
 * picker is asked for through `__tug.sharePick`, which posts exactly what the
 * button posts and hands back the host's reply.
 *
 * @covers tugapp/Sources/ShareRenderer.swift
 * @covers tugapp/Sources/MainWindow.swift
 * @covers tugdeck/src/share/share-html.ts
 * @covers tugdeck/src/lib/share-actions.ts
 */

import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

import { launchTugApp, note } from "./_harness";
import {
  BAR,
  COPY,
  chooseFormat,
  enabledJs,
  openSeededCard,
  previewAndDismiss,
  readPasteboard,
  setPasteboard,
  type SeedTurn,
} from "./share-probes";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SID = "at0823-session";
const PROMPT = "what is here?";

const TURNS: SeedTurn[] = [
  { prompt: PROMPT, reply: "A small project with a README." },
  { prompt: "and the tests?", reply: "They live under `tests/`." },
];

interface ClipboardFacts {
  textLength: number;
  htmlLength: number;
  htmlStyled: boolean;
  textHas: boolean[];
  htmlHas: boolean[];
}

const SENTINEL = "at0823-sentinel";

/** The pasteboard's type list, read from this process. */
function clipboardInfo(): string {
  return Bun.spawnSync(["osascript", "-e", "clipboard info"]).stdout.toString();
}

describe.skipIf(!SHOULD_RUN)("AT0823: Copy and Share… for rendered shares", () => {
  test(
    "a PDF copies as styled HTML, an image as a PNG, each with its Markdown, and Share… shows the picker",
    async () => {
      const app = await launchTugApp({ testName: "at0823-share-turns-copy" });
      let projectDir = "";
      const paths: string[] = [];
      try {
        projectDir = await openSeededCard(app, SID, TURNS);
        const card = app.body("A");
        const artifactPath = () =>
          card.evalJS<string>(`window.__tug.shareState("A")?.lastArtifact?.path ?? ""`);

        // The shell's surface reads the app's pasteboard; the read is async
        // and `evalJS` cannot await, so it is parked and polled.
        // card-dom: shell — the app's pasteboard, read through the shell.
        const readFacts = async (): Promise<ClipboardFacts> => {
          await app.evalJS<null>(
            `(window.__at0823facts = undefined,
              window.__tug.readClipboardFacts(${JSON.stringify([PROMPT])}).then(function (f) {
                window.__at0823facts = JSON.stringify(f);
              }),
              null)`,
          );
          await app.waitForCondition<boolean>(`window.__at0823facts !== undefined`, { timeoutMs: 4_000 });
          return JSON.parse(await app.evalJS<string>(`window.__at0823facts`)) as ClipboardFacts;
        };

        await app.performMenuItem("file.shareTurns");
        await card.waitForCondition<boolean>(`!!document.querySelector(${JSON.stringify(BAR)})`, {
          timeoutMs: 6_000,
        });
        expect(await card.evalJS<number>(`window.__tug.shareMark("A", [0, 1])`)).toBe(2);

        // ── A. A PDF copies as styled HTML beside its Markdown ─────────────
        await previewAndDismiss(app, 15_000);
        await card.waitForCondition<boolean>(
          `window.__tug.shareState("A").lastArtifact?.format === "pdf"`,
          { timeoutMs: 4_000 },
        );
        paths.push(await artifactPath());
        await card.waitForCondition<boolean>(enabledJs(COPY), { timeoutMs: 4_000 });
        setPasteboard(SENTINEL);
        await card.nativeClickAtElement(COPY);
        const pdfDeadline = Date.now() + 4_000;
        while (readPasteboard() === SENTINEL && Date.now() < pdfDeadline) await Bun.sleep(100);
        const pdf = await readFacts();
        note(`at0823 pdf copy: ${JSON.stringify(pdf)}`);
        expect(pdf.htmlStyled, "the HTML carries inline styles").toBe(true);
        expect(pdf.htmlHas[0], "the HTML carries the first prompt").toBe(true);
        expect(pdf.textHas[0], "the plain text is the Markdown").toBe(true);
        expect(readPasteboard()).toContain(PROMPT);

        // ── B. An image copies as a PNG beside its Markdown ────────────────
        await chooseFormat(app, "png");
        await previewAndDismiss(app, 15_000);
        await card.waitForCondition<boolean>(
          `window.__tug.shareState("A").lastArtifact?.format === "png"`,
          { timeoutMs: 4_000 },
        );
        paths.push(await artifactPath());
        await card.waitForCondition<boolean>(enabledJs(COPY), { timeoutMs: 4_000 });
        setPasteboard(SENTINEL);
        await card.nativeClickAtElement(COPY);
        const pngDeadline = Date.now() + 4_000;
        while (!clipboardInfo().includes("PNGf") && Date.now() < pngDeadline) await Bun.sleep(100);
        const info = clipboardInfo();
        note(`at0823 image clipboard info: ${info.trim()}`);
        expect(info, "the pasteboard holds a PNG").toContain("«class PNGf»");
        const png = await readFacts();
        expect(png.textHas[0], "the plain text is the Markdown").toBe(true);
        expect(png.htmlLength, "an image carries no HTML").toBe(0);

        // ── C. Share… shows the picker ──────────────────────────────────────
        // Posted without awaiting: if the picker tracks a menu, the reply
        // arrives only after it closes, so the Escape goes once the reply
        // or a 2 s deadline arrives, and then the reply is awaited.
        await card.evalJS<null>(
          `(window.__at0823pick = undefined,
            window.__tug.sharePick("A").then(function (r) { window.__at0823pick = r; }),
            null)`,
        );
        const posted = Date.now();
        const early = Date.now() + 2_000;
        while (Date.now() < early && (await card.evalJS<string | null>(`window.__at0823pick ?? null`)) === null) {
          await Bun.sleep(100);
        }
        const answeredMs = Date.now() - posted;
        await app.nativeKey("Escape");
        await card.waitForCondition<boolean>(`window.__at0823pick !== undefined`, { timeoutMs: 4_000 });
        const pick = await card.evalJS<string | null>(`window.__at0823pick`);
        note(`at0823 share picker: ${pick} after ${answeredMs} ms`);
        expect(pick, "the host showed the picker").toBe("shown");
      } finally {
        await app.close();
        for (const path of paths) if (path !== "") rmSync(path, { force: true });
        if (projectDir !== "") rmSync(projectDir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
