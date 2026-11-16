/**
 * at0841-chart-refs-table.test.ts — a chart's refs resolve through the
 * annotator and stand as atoms in its Table view.
 *
 * A ` ```tugchart ` fence in a streamed turn names, beside its three rows,
 * what each row is about: a file written to a temp directory, a sibling that
 * was never written, and this checkout's HEAD. The card is bound to this
 * checkout, which is the annotator's commit root, so the card's own git feed
 * can confirm the sha (the footing `at0526` and `at0459` stand on). Then:
 *
 *  - The existing file's atom is stamped as a file reference
 *    (`data-tug-annotation="file-path"`), its cell's own text untouched.
 *  - The missing file's atom carries no annotation and reads as written:
 *    the resolver is the gate, and a ref that names nothing links nothing.
 *  - The commit's atom holds a commit pill, the same one prose gets.
 *  - The table carries `data-tugx-no-scan`, and no prose path run was
 *    wrapped inside it.
 *  - Transcript Find counts the existing file's row label once. The atom
 *    beside it repeats the label, and an atom is Tug's words over the spec's
 *    refs, which the index never projects: were it counted, the chip would
 *    read `1 of 2`, the painter and the index disagreeing.
 *
 * @covers tugdeck/src/lib/chart/render-chart.ts
 * @covers tugdeck/src/lib/chart/chart-table-refs.ts
 * @covers tugdeck/src/lib/annotator/chart-refs.ts
 * @covers tugdeck/src/lib/annotator/wrap-matches.ts
 * @covers tugdeck/src/lib/markdown/enhance-chart.ts
 * @covers tugdeck/src/components/tugways/body-kinds/chart-block.tsx
 * @covers tugdeck/src/components/tugways/tug-markdown-block.tsx
 * @covers tugdeck/src/components/tugways/transcript-find-highlighter.ts
 * @covers tugdeck/src/components/tugways/commit-tip-portals.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { note } from "./_harness";
import { rmTempTugbank } from "./_harness/tugbank-helpers";
import { openFindBar, sessionSelectors } from "./find-probes";
import { SHOULD_RUN } from "./settle-frames-fixture";
import { CARD, CHART, launchWithCharts } from "./tugchart-fixture";

const TEST_NAME = "at0841-chart-refs-table";

/** This repository — a real git repo whose HEAD the card's git feed confirms. */
const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const HEAD_SHA = execSync("git rev-parse HEAD", { cwd: REPO_ROOT }).toString().trim();

/** How long the refs may take: `fs/stat` and a round trip to the git feed. */
const RESOLVE_MS = 20_000;

/** The row labels; the first is a word found nowhere else in the transcript. */
const REAL = "kookaburra.rs";
const MISSING = "never-written.rs";
const HEAD_LABEL = "head";

let dir = "";
let realPath = "";
let missingPath = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  dir = realpathSync(mkdtempSync(join(tmpdir(), "at0841-")));
  realPath = join(dir, REAL);
  missingPath = join(dir, MISSING);
  writeFileSync(realPath, "fn kookaburra() {}\n", "utf8");
});
afterAll(() => {
  if (dir !== "" && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

function spec(): unknown {
  return {
    tugchart: 1,
    form: "bar",
    title: "Lines changed by file",
    categories: [REAL, MISSING, HEAD_LABEL],
    series: [{ name: "lines", values: [12, 4, 30] }],
    refs: [`file:${realPath}`, `file:${missingPath}`, `commit:${HEAD_SHA.slice(0, 12)}`],
  };
}

interface Atom {
  annotation: string;
  text: string;
  pill: boolean;
  cell: string;
}

interface TableFacts {
  noScan: boolean;
  wrapped: number;
  atoms: Atom[];
}

const ATOMS_JS = `(function(){
  var fig = document.querySelector(${JSON.stringify(CHART)});
  if (fig === null) return null;
  var table = fig.querySelector("table.tugx-chart-table");
  if (table === null) return null;
  return {
    noScan: table.hasAttribute("data-tugx-no-scan"),
    wrapped: table.querySelectorAll("[data-tugx-wrapped]").length,
    atoms: Array.from(table.querySelectorAll("tbody .tugx-chart-ref")).map(function (a) {
      var cell = a.parentElement;
      return {
        annotation: a.getAttribute("data-tug-annotation") || "",
        text: (a.textContent || "").trim(),
        pill: a.querySelector('[data-slot="tug-commit-atom"]') !== null,
        cell: cell === null || cell.firstChild === null ? "" : (cell.firstChild.textContent || "")
      };
    })
  };
})()`;

const SETTLED_JS = `(function(){
  var f = ${ATOMS_JS};
  return f !== null && f.atoms.length === 3 && f.atoms[0].annotation === "file-path" && f.atoms[2].pill;
})()`;

describe.skipIf(!SHOULD_RUN)("at0841 — a chart's refs are atoms in its Table view", () => {
  test(
    "only the refs that resolve link, the commit wears its pill, and Find counts the label once",
    async () => {
      const { app, tugbankPath } = await launchWithCharts(TEST_NAME, [spec()], "tugchart", REPO_ROOT);
      const page = app.body(CARD);
      try {
        await page.waitForCondition<boolean>(SETTLED_JS, { timeoutMs: RESOLVE_MS });
        const facts = await page.evalJS<TableFacts>(ATOMS_JS);
        note(`at0841 atoms: ${JSON.stringify(facts.atoms)}`);

        expect(facts.noScan, "the chart's table is read only through its refs").toBe(true);
        expect(facts.wrapped, "no prose run was wrapped in the table").toBe(0);
        expect(facts.atoms.length, "one atom per row ref").toBe(3);

        const [real, missing, commit] = facts.atoms;
        expect(real.annotation, "the existing file is a file reference").toBe("file-path");
        expect(real.cell, "its cell's text is untouched").toBe(REAL);
        expect(missing.annotation, "the missing file is never a reference").toBe("");
        expect(missing.text, "and reads as written").toBe(MISSING);
        expect(commit.annotation, "the commit is a commit reference").toBe("commit-sha");
        expect(commit.pill, "and holds the commit pill").toBe(true);

        const sel = sessionSelectors(CARD);
        await openFindBar(app, CARD);
        await app.nativeType(REAL);
        // The chip passes through other counts while the query is typed, so
        // the wait is for the answer; a miss is read and named below.
        await page
          .waitForCondition<boolean>(
            `(document.querySelector(${JSON.stringify(sel.chip)})?.textContent || "").trim() === "1 of 1"`,
            { timeoutMs: 15_000 },
          )
          .catch(() => undefined);
        const chip = await page.evalJS<string>(`(document.querySelector(${JSON.stringify(sel.chip)})?.textContent || "").trim()`);
        note(`at0841 find chip for ${JSON.stringify(REAL)}: ${JSON.stringify(chip)}`);
        expect(chip, "the row label counts once; its atom is not counted").toBe("1 of 1");
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    300_000,
  );
});
