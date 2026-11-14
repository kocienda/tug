/**
 * at0822-share-turns-bar-render.test.ts — the Share shade's rendered outputs:
 * an image previewed from the shade, a very tall image previewed like any
 * other, and Save… raising the save panel directly, with no preview first.
 *
 * ## What this gates
 *
 * The host's render itself is `at0821`'s; the scrub and the Markdown path are
 * `at0819`'s. What only the whole shade has is the wiring between them: the
 * Format choice reaching the store, Preview… rendering the scrubbed slice
 * through the host and showing the file in the preview sheet, the artifact
 * held for the next action, and Save… making its own artifact and going
 * straight to the save panel.
 *
 *   A. Two short turns selected, Image chosen, Preview… renders them and
 *      shows the sheet; on its Done the store holds a `png` artifact whose
 *      file is on disk, current for this selection.
 *   B. Choosing PDF makes the held artifact stale; the action stays open.
 *   C. With the tall third turn selected too, Image and Preview… render and
 *      show it as they did the short one: an image has no height cap, the
 *      format stays Image, and the store holds a `png` taller than the two
 *      short turns' was.
 *   D. PDF chosen again, Save… on that PDF — which nobody has previewed —
 *      renders it and raises the share's save panel at once: no preview
 *      sheet stands between the press and the panel. The
 *      panel is the system's remote view, out of the app's process, so no
 *      window state shows it: the host logs each panel it raises, and the
 *      test reads that line. It runs last, since the panel stays attached.
 *
 * Entries are selected through `__tug.shareMark`, by index — a turn's prompt
 * and its answer are two: the tall turn pushes the others out of the windowed
 * list, and a mark's click is `at0819`'s to gate.
 *
 * @covers tugdeck/src/lib/share-actions.ts
 * @covers tugdeck/src/components/tugways/cards/session-share-view.tsx
 * @covers tugdeck/src/components/tugways/cards/session-share-view.css
 * @covers tugdeck/src/lib/share-turns-store.ts
 * @covers tugdeck/src/lib/os-share.ts
 * @covers tugapp/Sources/SharePreviewSheet.swift
 * @covers tugapp/Sources/ExportChoice.swift
 */

import { describe, expect, test } from "bun:test";
import { existsSync, rmSync, statSync } from "node:fs";

import { launchTugApp, note } from "./_harness";
import {
  GO,
  SHADE,
  chooseFormat,
  enabledJs,
  openSeededCard,
  previewAndDismiss,
  pressAction,
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
  held: boolean;
  lastArtifact: { format: string; path: string; htmlLength: number; markdownLength: number } | null;
}

describe.skipIf(!SHOULD_RUN)("AT0822: the Share shade's rendered outputs", () => {
  test(
    "an image previews from the shade, a very tall one does too, and Save… on an unpreviewed PDF goes straight to the save panel",
    async () => {
      const app = await launchTugApp({ testName: "at0822-share-turns-bar-render" });
      let projectDir = "";
      let imagePath = "";
      let tallPath = "";
      try {
        projectDir = await openSeededCard(app, SID, TURNS, false);
        const card = app.body("A");
        const state = () => card.evalJS<ShareState>(`window.__tug.shareState("A")`);

        await app.performMenuItem("file.shareTurns");
        await card.waitForCondition<boolean>(`!!document.querySelector(${JSON.stringify(SHADE)})`, {
          timeoutMs: 6_000,
        });
        expect((await state()).format, "a share starts as a PDF").toBe("pdf");
        expect(await card.evalJS<number>(`window.__tug.shareMark("A", [0, 1, 2, 3])`)).toBe(4);

        // ── A. An image, previewed from the shade ──────────────────────────
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
        expect(previewed.held, "the image is held for this selection").toBe(true);
        expect(await card.evalJS<boolean>(enabledJs(GO)), "the action button is open").toBe(true);

        // ── B. PDF makes the held image stale; the action stays open ───────
        await chooseFormat(app, "pdf");
        await card.waitForCondition<boolean>(`window.__tug.shareState("A").held === false`, {
          timeoutMs: 4_000,
        });
        expect(await card.evalJS<boolean>(enabledJs(GO)), "the action button stays open").toBe(true);

        // ── C. A very tall image previews like any other ───────────────────
        await chooseFormat(app, "png");
        expect(await card.evalJS<number>(`window.__tug.shareMark("A", [4, 5])`)).toBe(6);
        await previewAndDismiss(app, 20_000);
        await card.waitForCondition<boolean>(`window.__tug.shareState("A").held === true`, {
          timeoutMs: 4_000,
        });
        const tall = await state();
        note(`at0822 tall: ${JSON.stringify(tall)}`);
        expect(tall.format, "the format stays Image").toBe("png");
        expect(tall.lastArtifact?.format).toBe("png");
        tallPath = tall.lastArtifact!.path;
        expect(tallPath, "a new image, not the short one").not.toBe(imagePath);
        expect(statSync(tallPath).size, "the tall image is the larger file").toBeGreaterThan(statSync(imagePath).size);
        await chooseFormat(app, "pdf");

        // ── D. Save… goes straight to the save panel ───────────────────────
        const panelShown = (): boolean =>
          app
            .tugappLog()
            .split("\n")
            .some((line) => line.includes("save panel shown") && line.includes("Save Shared Turns"));
        expect(panelShown(), "no save panel before the press").toBe(false);
        await pressAction(app, "save");
        const panelDeadline = Date.now() + 15_000;
        while (!panelShown() && Date.now() < panelDeadline) await Bun.sleep(100);
        expect(panelShown(), "Save… raised the share's save panel").toBe(true);
        // Begun is not standing: a sheet begun while the window still holds
        // another is queued behind it and never shown. The host says which.
        const attachedLine = (): string | undefined =>
          app
            .tugappLog()
            .split("\n")
            .find((line) => line.includes("save panel attached") && line.includes("Save Shared Turns"));
        const attachDeadline = Date.now() + 5_000;
        while (attachedLine() === undefined && Date.now() < attachDeadline) await Bun.sleep(100);
        note(`at0822 ${attachedLine() ?? "no attached line"}`);
        expect(attachedLine() ?? "", "the save panel is the window's attached sheet").toContain("attached=true");
        const saved = await state();
        expect(saved.lastArtifact?.format, "the PDF it made is held").toBe("pdf");
        expect(saved.held, "and is of this selection").toBe(true);
      } finally {
        await app.close();
        if (imagePath !== "") rmSync(imagePath, { force: true });
        if (tallPath !== "") rmSync(tallPath, { force: true });
        if (projectDir !== "") rmSync(projectDir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
