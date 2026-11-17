/**
 * at0851-figure-copy-picture.test.ts — a diagram's header Copy puts the
 * drawn figure on the system pasteboard as a PNG, with the spec as its
 * plain-text flavour.
 *
 * ## What this gates
 *
 * The header's choice of actions and its labels have unit tests. What only
 * the running app has is the press itself: the host rendering the figure
 * through its hidden share page in picture mode, the PNG reaching the
 * pasteboard through `shareCopy`, and the button wearing its busy state
 * while the render is out. This holds:
 *
 *   - In the app the figure's Copy button is labelled "Copy diagram", and a
 *     Share button stands beside it.
 *   - A native click on Copy puts a PNG on the pasteboard whose width is a
 *     plausible figure's — wider than the keyed-table floor, at the window's
 *     backing scale — and not the share column's 720 points.
 *   - The pasteboard's plain text is the spec: it parses as JSON and carries
 *     the figure's title.
 *   - The button wore `aria-busy` while the render was out and sheds it when
 *     the copy lands.
 *
 * The pasteboard is read from this process — `clipboard info` and `pbpaste`
 * — never through an event into the app.
 *
 * @covers tugdeck/src/lib/chart/render-chart.ts
 * @covers tugdeck/src/lib/chart/figure-export.ts
 * @covers tugdeck/src/lib/markdown/enhance-block-chrome.ts
 * @covers tugdeck/src/share/share-main.ts
 * @covers tugapp/Sources/ShareRenderer.swift
 * @covers tugapp/Sources/SharePreviewSheet.swift
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { note } from "./_harness";
import { decodePngFile } from "./_harness/png";
import { rmTempTugbank } from "./_harness/tugbank-helpers";
import { SHOULD_RUN } from "./settle-frames-fixture";
import { CHART, launchWithCharts } from "./tugchart-fixture";

const TEST_NAME = "at0851-figure-copy-picture";
const TITLE = "A request is checked before it reaches the store";
const SENTINEL = "at0851-sentinel";
/** A diagram with a keyed table draws no narrower than this (`PICTURE_KEYED_FLOOR`). */
const KEYED_FLOOR = 560;

const SPEC = {
  tugdiagram: 1,
  form: "flow",
  title: TITLE,
  columns: [
    [{ id: "client", name: "Client", sub: "sends a request" }],
    [
      {
        id: "api",
        name: "API server",
        rows: [
          { key: 1, name: "Authenticate", what: "Rejects an expired token.", where: "src/server/auth.ts" },
          { key: 2, name: "Validate", what: "Parses the body against the schema.", where: "src/server/validate.ts" },
        ],
      },
    ],
    [{ id: "store", name: "Store", sub: "Postgres" }],
  ],
  edges: [
    { from: "client", to: "api" },
    { from: "api.2", to: "store", tone: "good", label: "writes" },
  ],
};

const COPY = `${CHART} .tugx-md-chrome-copy`;
const SHARE = `${CHART} .tugx-chart-share`;

/** The pasteboard's type list, read from this process. */
function clipboardInfo(): string {
  return Bun.spawnSync(["osascript", "-e", "clipboard info"]).stdout.toString();
}

/** Write the pasteboard's PNG flavour to `path`, through AppleScript. */
function savePasteboardPng(path: string): void {
  Bun.spawnSync([
    "osascript",
    "-e",
    `set f to open for access POSIX file ${JSON.stringify(path)} with write permission`,
    "-e",
    "write (the clipboard as «class PNGf») to f",
    "-e",
    "close access f",
  ]);
}

describe.skipIf(!SHOULD_RUN)("at0851 — a diagram's Copy puts the picture on the pasteboard", () => {
  test(
    "Copy renders a PNG and writes it with the spec as text",
    async () => {
      const { app, tugbankPath, page } = await launchWithCharts(TEST_NAME, [SPEC], "tugdiagram");
      const dir = mkdtempSync(join(tmpdir(), "at0851-"));
      try {
        const labels = await page.evalJS<{ copy: string; share: string; busy: string }>(`(function(){
          var copy = document.querySelector(${JSON.stringify(COPY)});
          var share = document.querySelector(${JSON.stringify(SHARE)});
          return {
            copy: copy === null ? "" : (copy.getAttribute("aria-label") || ""),
            share: share === null ? "" : (share.getAttribute("aria-label") || ""),
            busy: copy === null ? "" : (copy.getAttribute("aria-busy") || "")
          };
        })()`);
        expect(labels.copy, "in the app, Copy copies the picture").toBe("Copy diagram");
        expect(labels.share, "and Share stands beside it").toBe("Share diagram");
        expect(labels.busy, "at rest the button is not busy").toBe("");
        const scale = await page.evalJS<number>("window.devicePixelRatio");

        Bun.spawnSync(["pbcopy"], { stdin: Buffer.from(SENTINEL) });
        // The busy state is read by the page itself from the press on, since
        // a render is a third of a second and a poll from here could miss it.
        await page.evalJS<null>(`(function(){
          var copy = document.querySelector(${JSON.stringify(COPY)});
          window.__at0851busy = false;
          new MutationObserver(function () {
            if (copy.getAttribute("aria-busy") === "true") window.__at0851busy = true;
          }).observe(copy, { attributes: true, attributeFilter: ["aria-busy"] });
          return null;
        })()`);
        const pressed = Date.now();
        await page.nativeClickAtElement(COPY);
        const deadline = Date.now() + 15_000;
        while (!clipboardInfo().includes("PNGf") && Date.now() < deadline) await Bun.sleep(100);
        const info = clipboardInfo();
        note(`at0851 clipboard after ${Date.now() - pressed} ms: ${info.trim()}`);
        expect(info, "the pasteboard holds a PNG").toContain("«class PNGf»");

        await page.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(COPY)}).getAttribute("aria-busy") !== "true"`,
          { timeoutMs: 4_000 },
        );
        const sawBusy = await page.evalJS<boolean>("window.__at0851busy === true");
        expect(sawBusy, "the button was busy while the render was out").toBe(true);

        const text = Bun.spawnSync(["pbpaste"]).stdout.toString();
        expect(text, "the plain text is no longer the sentinel").not.toBe(SENTINEL);
        const parsed = JSON.parse(text) as { title?: string; tugdiagram?: number };
        expect(parsed.tugdiagram, "the plain text is the spec").toBe(1);
        expect(parsed.title).toBe(TITLE);

        const pngPath = join(dir, "copied.png");
        savePasteboardPng(pngPath);
        const png = decodePngFile(pngPath);
        note(`at0851 png ${png.width}×${png.height} at scale ${scale}`);
        expect(png.width, "a keyed diagram is at least the keyed floor plus its margin").toBeGreaterThanOrEqual(
          Math.round(KEYED_FLOOR * scale),
        );
        expect(png.width, "not the share column's width").not.toBe(Math.round(720 * scale));
        expect(png.height, "the figure and its table have height").toBeGreaterThan(Math.round(200 * scale));
      } catch (err) {
        const lines = app
          .tugappLog()
          .split("\n")
          .filter((line) => /share|pageFault|fault/i.test(line));
        note(`at0851 tugapp.log share lines:\n${lines.slice(-30).join("\n")}`);
        throw err;
      } finally {
        await app.close();
        rmSync(dir, { recursive: true, force: true });
        rmTempTugbank(tugbankPath);
      }
    },
    120_000,
  );
});
