/**
 * at0821-share-turns-render.test.ts — shared turns rendered to an image and a
 * PDF by the host, through a hidden share page that mounts the Session card's
 * own transcript cells.
 *
 * ## What this gates
 *
 * The pure pieces — the slice, the seeded paths, the document and its
 * decoder — have unit tests. What only the running app has is the page
 * itself: the host making a hidden view, the share page booting with no
 * connection, the real `UserMessageCell` and `AssistantTurnCell` mounting
 * outside any card, the theme applied by name, and the snapshot written to a
 * file. It is the verdict on whether the cells mount off a card at all.
 *
 *   A. The card's two seeded turns, rendered as an image with tool calls as
 *      summaries, answer `ok` with a PNG on disk 720 points wide at the
 *      window's backing scale, whose corner is the card's own surface.
 *   B. The same turns with tool calls in full render taller: the tool mode
 *      reaches the cells (a summary is a collapsed block, full an open one).
 *   C. The same turns as a PDF answer `ok` with a `%PDF` file of at least one
 *      page, and the page's inline-styled HTML — the rich flavour a PDF's
 *      Copy writes — carrying the first prompt's text.
 *   D. A document whose header runs past 8000 pixels answers `tooTall` as an
 *      image, and writes nothing.
 *
 * A document that does not decode is refused by `decodeShareRenderDocument`'s
 * pure test; waiting out the host's 60 s deadline would not fit a file's
 * budget.
 *
 * @covers tugapp/Sources/ShareRenderer.swift
 * @covers tugapp/Sources/ShareRenderOutput.swift
 * @covers tugdeck/src/share/share-main.ts
 * @covers tugdeck/src/share/share-root.tsx
 * @covers tugdeck/src/share/share-page.css
 * @covers tugdeck/src/lib/code-session-store.ts
 * @covers tugdeck/src/lib/markdown/pending-enhancements.ts
 * @covers tugdeck/src/share/share-html.ts
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";

import { launchTugApp, note, type App } from "./_harness";
import { decodePngFile } from "./_harness/png";
import { openSeededCard, type SeedTurn } from "./share-probes";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SID = "at0821-session";
/** Two channels within this of each other read as one colour. */
const NEAR = 8;

/** Two turns, the second carrying a Bash call whose open block shows its command and output. */
const TURNS: SeedTurn[] = [
  { prompt: "what is here?", reply: "A small project with a README." },
  {
    prompt: "list the files",
    reply: "Here they are.",
    tool: { name: "Bash", input: { command: "ls -la", description: "List the files" } },
  },
];

interface Rendered {
  result: "ok" | "failed" | "tooTall";
  path: string;
  height: number;
  pages: number;
  html: string;
}

/**
 * Render the card's turns through `__tug.shareRender` and await the host's
 * answer. `titleJs`, when given, is a script expression for the header's
 * title, evaluated in the page — a long title is built there rather than sent.
 */
async function render(
  app: App,
  format: "png" | "pdf",
  toolMode: "summaries" | "full",
  titleJs?: string,
): Promise<Rendered> {
  const card = app.body("A");
  const args = [JSON.stringify(format), JSON.stringify(toolMode)];
  if (titleJs !== undefined) args.push(titleJs);
  // `evalJS` cannot return a promise: start the render, park its answer, poll.
  await card.evalJS<null>(
    `(window.__at0821 = undefined,
      window.__tug.shareRender("A", ${args.join(", ")}).then(function (r) {
        window.__at0821 = JSON.stringify(r);
      }),
      null)`,
  );
  await card.waitForCondition<boolean>("window.__at0821 !== undefined", { timeoutMs: 15_000 });
  return JSON.parse(await card.evalJS<string>("window.__at0821")) as Rendered;
}

describe.skipIf(!SHOULD_RUN)("AT0821: share turns rendered to an image and a PDF", () => {
  test(
    "the card's cells render on the share page, on the card's surface, as an image and a PDF, and a tall image is refused",
    async () => {
      const app = await launchTugApp({ testName: "at0821-share-turns-render" });
      let projectDir = "";
      try {
        projectDir = await openSeededCard(app, SID, TURNS);
        const card = app.body("A");

        // The surface the card's transcript stands on, as sRGB bytes: through
        // a 2D canvas, since a computed style keeps the theme's oklch spelling.
        const surface = await card.evalJS<number[]>(`(function () {
          var probe = document.createElement("div");
          probe.style.backgroundColor = "var(--tugx-pane-bg)";
          document.body.appendChild(probe);
          var bg = getComputedStyle(probe).backgroundColor;
          probe.remove();
          var c = document.createElement("canvas").getContext("2d");
          c.fillStyle = bg; c.fillRect(0, 0, 1, 1);
          var d = c.getImageData(0, 0, 1, 1).data;
          return [d[0], d[1], d[2]];
        })()`);
        const scale = await card.evalJS<number>("window.devicePixelRatio");

        // ── A. An image, tool calls as summaries ──────────────────────────
        const startedAt = Date.now();
        const summaries = await render(app, "png", "summaries");
        note(`at0821 summaries render: ${Date.now() - startedAt} ms, ${JSON.stringify({ ...summaries, html: undefined })}`);
        expect(summaries.result, "the render answers ok").toBe("ok");
        expect(existsSync(summaries.path), "the PNG is on disk").toBe(true);
        expect(summaries.path).toContain("/tug-share/");
        expect(summaries.pages).toBe(1);
        const png = decodePngFile(summaries.path);
        expect(png.width, "720 points at the window's backing scale").toBe(Math.round(720 * scale));
        expect(png.height).toBeGreaterThan(0);
        const corner = (2 * png.width + 2) * 4;
        const pixel = [png.rgba[corner]!, png.rgba[corner + 1]!, png.rgba[corner + 2]!];
        note(`at0821 corner ${JSON.stringify(pixel)} vs surface ${JSON.stringify(surface)}`);
        expect(
          pixel.every((v, i) => Math.abs(v - surface[i]!) <= NEAR),
          `the image's ground ${JSON.stringify(pixel)} is the card's surface ${JSON.stringify(surface)}`,
        ).toBe(true);
        // The ground is not the whole picture: the cells drew on it.
        let inked = 0;
        for (let i = 0; i < png.rgba.length; i += 4 * 97) {
          if (Math.abs(png.rgba[i]! - surface[0]!) > NEAR * 4) inked += 1;
        }
        expect(inked, "the rows drew something on the ground").toBeGreaterThan(0);

        // ── B. Tool calls in full render taller ───────────────────────────
        const full = await render(app, "png", "full");
        note(`at0821 heights: summaries ${summaries.height}, full ${full.height}`);
        expect(full.result).toBe("ok");
        expect(full.height, "an open tool block is taller than its summary").toBeGreaterThan(summaries.height);

        // ── C. A PDF, with its HTML ───────────────────────────────────────
        const pdfStartedAt = Date.now();
        const pdf = await render(app, "pdf", "summaries");
        note(`at0821 pdf render: ${Date.now() - pdfStartedAt} ms, ${JSON.stringify({ ...pdf, html: pdf.html.length })}`);
        expect(pdf.result, "the PDF render answers ok").toBe("ok");
        expect(pdf.path.endsWith(".pdf")).toBe(true);
        expect(readFileSync(pdf.path).subarray(0, 4).toString("latin1"), "the file is a PDF").toBe("%PDF");
        expect(pdf.pages).toBeGreaterThanOrEqual(1);
        expect(pdf.html, "the HTML carries its look inline").toContain('style="');
        expect(pdf.html, "the HTML carries the first prompt").toContain(TURNS[0]!.prompt);
        expect(pdf.html.length, "the HTML writes only what differs from what the paste inherits").toBeLessThan(100_000);

        // ── D. An image past the cap is refused ───────────────────────────
        const tall = await render(app, "png", "summaries", `"tall ".repeat(6000)`);
        note(`at0821 tall: ${JSON.stringify({ ...tall, html: undefined })}`);
        expect(tall.result, "an image past 8000 pixels is too tall").toBe("tooTall");
        expect(tall.height).toBeGreaterThan(8000);
        expect(tall.path).toBe("");

        for (const path of [summaries.path, full.path, pdf.path]) rmSync(path, { force: true });
      } catch (err) {
        // A render that never answers leaves its reason in the app's log —
        // the renderer's lines and the share page's faults — which goes with
        // the instance at quit, so it is read here.
        const lines = app
          .tugappLog()
          .split("\n")
          .filter((line) => /share|pageFault|fault/i.test(line));
        note(`at0821 tugapp.log share lines:\n${lines.slice(-40).join("\n")}`);
        throw err;
      } finally {
        await app.close();
        if (projectDir !== "") rmSync(projectDir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
