/**
 * at0840-share-diagram-locations.test.ts — a shared turn that holds a
 * ` ```tugdiagram ` fence draws its figure and its keyed table on the share
 * page, with each location shown as written.
 *
 * The share page has no connection, so it has nobody to ask whether a
 * location names a real file. In a live card a location nobody confirmed is
 * struck through and tagged "unresolved"; on the share page that mark would
 * land on every location in every table, true or not. This holds:
 *
 *  - The PDF render answers `ok`, and the page's HTML carries the figure's
 *    SVG: the render waited for the diagram engine, which loads lazily.
 *  - The HTML carries the keyed table, with each row's name, its `what` and
 *    its `where` as text.
 *  - No location is struck through. The page's HTML writes each element's
 *    computed line decoration inline, so a struck location would say so.
 *
 * @covers tugdeck/src/lib/markdown/enhance-chart.ts
 * @covers tugdeck/src/lib/markdown/pending-enhancements.ts
 * @covers tugdeck/src/components/tugways/use-annotation-context.ts
 * @covers tugdeck/src/lib/annotator/types.ts
 * @covers tugdeck/src/share/share-root.tsx
 * @covers tugdeck/src/share/share-page.css
 */

import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";

import { launchTugApp, note } from "./_harness";
import { openSeededCard, type SeedTurn } from "./share-probes";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SID = "at0840-session";

/** Two locations, neither of which the share page could confirm. */
const WHERE_ONE = "tugapp/Sources/MainWindow.swift";
const WHERE_TWO = "at0840/never-written.rs";

const SPEC = {
  tugdiagram: 1,
  form: "flow",
  title: "The window loads the deck from tugcast",
  columns: [
    [
      {
        id: "app",
        name: "Tug.app",
        rows: [{ key: 1, name: "MainWindow", what: "The window and its web views.", where: WHERE_ONE }],
      },
    ],
    [
      {
        id: "cast",
        name: "tugcast",
        rows: [{ key: 2, name: "Router", what: "Serves each client's feeds.", where: WHERE_TWO }],
      },
    ],
  ],
  edges: [{ from: "app.1", to: "cast.1", label: "loads" }],
};

const TURNS: SeedTurn[] = [
  {
    prompt: "how does the window load?",
    reply: `Here is the shape.\n\n\`\`\`tugdiagram\n${JSON.stringify(SPEC)}\n\`\`\`\n`,
  },
];

interface Rendered {
  result: "ok" | "failed";
  path: string;
  height: number;
  pages: number;
  html: string;
}

describe.skipIf(!SHOULD_RUN)("AT0840: a shared diagram shows its locations as written", () => {
  test(
    "the share page draws the figure and its table, and strikes no location through",
    async () => {
      const app = await launchTugApp({ testName: "at0840-share-diagram-locations" });
      let projectDir = "";
      try {
        projectDir = await openSeededCard(app, SID, TURNS);
        const card = app.body("A");
        // `evalJS` cannot return a promise: start the render, park its answer, poll.
        await card.evalJS<null>(
          `(window.__at0840 = undefined,
            window.__tug.shareRender("A", "pdf", "summaries").then(function (r) {
              window.__at0840 = JSON.stringify(r);
            }),
            null)`,
        );
        await card.waitForCondition<boolean>("window.__at0840 !== undefined", { timeoutMs: 15_000 });
        const pdf = JSON.parse(await card.evalJS<string>("window.__at0840")) as Rendered;
        note(`at0840 pdf: ${JSON.stringify({ ...pdf, html: pdf.html.length })}`);

        expect(pdf.result, "the render answers ok").toBe("ok");
        expect(pdf.html, "the figure was drawn before the page was read").toContain("<svg");
        expect(pdf.html, "the figure's title is on the page").toContain(SPEC.title);
        for (const said of ["MainWindow", "The window and its web views.", WHERE_ONE, "Router", WHERE_TWO]) {
          expect(pdf.html, `the keyed table carries: ${said}`).toContain(said);
        }
        expect(pdf.html, "no location is struck through").not.toContain("line-through");
        expect(pdf.html, "and the spec's source is not what was drawn").not.toContain('"tugdiagram"');
        rmSync(pdf.path, { force: true });
      } catch (err) {
        const lines = app
          .tugappLog()
          .split("\n")
          .filter((line) => /share|pageFault|fault/i.test(line));
        note(`at0840 tugapp.log share lines:\n${lines.slice(-40).join("\n")}`);
        throw err;
      } finally {
        await app.close();
        if (projectDir !== "") rmSync(projectDir, { recursive: true, force: true });
      }
    },
    TEST_TIMEOUT_MS,
  );
});
