/**
 * at0769-gallery-chart-recipes.test.ts — the Chart Recipes gallery card draws
 * one live example per recipe over the frontmost project.
 *
 * A scratch repository holds three commits made now and one uncommitted edit.
 * A session card is bound to it beside a `gallery-chart-recipes` card, so the
 * card's project is the repository, and this holds:
 *
 *  - Eighteen sections appear and none is left pending.
 *  - The nine recipes that read git, all of which have data in the repository,
 *    are `rendered`.
 *  - Every other section is `rendered` or `no-data`, since `gaps` reads the
 *    machine's record and the other ledgers are keyed to a repository they
 *    have never seen. A read that failed would be neither.
 *
 * One screenshot per section, from the card's own body view, is copied to /tmp before the
 * harness sweeps them at quit.
 *
 * @covers tugdeck/src/lib/chart-recipes-store.ts
 * @covers tugdeck/src/components/tugways/cards/gallery-chart-recipes.tsx
 * @covers tugdeck/src/components/tugways/cards/gallery-chart-recipes.css
 * @covers tugrust/crates/tugcast/src/server.rs
 */

import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { note } from "./_harness";
import { bodyOfKind } from "./_harness/card-reach";
import { testTmpDir } from "./_harness/test-cleanup";
import { rmTempTugbank } from "./_harness/tugbank-helpers";
import { RAIL_WIDTH, SHOULD_RUN, SLIM_PX, blobFor, launch } from "./settle-frames-fixture";
import { STUB_TRANSCRIPT_DIR_ENV, bindStreamingStubs, stubDirectory } from "./streaming-stub-fixture";

const TEST_NAME = "at0769-gallery-chart-recipes";
const CARD = "at0622-c1";
const SECTIONS = 18;
const COMMIT_RECIPES = [
  "commits",
  "churn",
  "hotspots",
  "landed",
  "commit-kinds",
  "commit-hours",
  "commit-size",
  "commit-days",
  "velocity",
];
const SHOTS_DIR = "/tmp/chart-recipes";

/** Engine load (10 s horizon) plus faces (3 s) plus the recipes' reads. */
const SECTIONS_MS = 14_000;

function git(cwd: string, ...args: string[]): void {
  const run = Bun.spawnSync(["git", "-c", "user.name=at0769", "-c", "user.email=at0769@example.com", ...args], { cwd });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
}

/** Three commits made now, in the conventional shape, and one uncommitted edit. */
function scratchRepository(): string {
  const dir = realpathSync(testTmpDir("at0769-repo-"));
  git(dir, "init", "-q");
  const file = join(dir, "notes.txt");
  for (const line of ["one", "two", "three"]) {
    writeFileSync(file, `${line}\n`);
    git(dir, "add", "notes.txt");
    git(dir, "commit", "-q", "-m", `docs(notes): write ${line}`);
  }
  writeFileSync(file, "three\nfour\n");
  return dir;
}

/** The fixture's deck with a second slot holding the card under test. */
function deckWithRecipes(): Record<string, unknown> {
  const blob = blobFor(1) as { spaces: { deck: { cards: unknown[]; panes: unknown[] } }[] };
  const { deck } = blob.spaces[0];
  deck.cards.push({ id: "at0769-r1", componentId: "gallery-chart-recipes", title: "Chart Recipes", closable: true });
  deck.panes.splice(1, 0, {
    id: "at0769-p2",
    position: { x: 40 + RAIL_WIDTH, y: 40 },
    size: { width: SLIM_PX, height: 400 },
    cardIds: ["at0769-r1"],
    activeCardId: "at0769-r1",
    title: "",
    acceptsFamilies: ["maker"],
    slot: 1,
  });
  return blob;
}

const SECTION = '[data-testid="gallery-chart-recipes"] [data-tugx-recipe]';

/** Each section's name and where it has got to: a chart's own state, else the section's. */
const READ_SECTIONS = `(function(){
  return Array.from(document.querySelectorAll(${JSON.stringify(SECTION)})).map(function (s) {
    var state = s.getAttribute("data-tugx-recipe-state");
    if (state === "chart") {
      var figure = s.querySelector(".tugx-chart");
      state = figure === null ? "chart" : figure.getAttribute("data-tugx-chart-state");
    }
    return { name: s.getAttribute("data-tugx-recipe"), state: state, text: s.textContent };
  });
})()`;

interface SectionFacts {
  name: string;
  state: string;
  text: string;
}

const SETTLED = new Set(["rendered", "invalid", "no-data", "failed"]);

describe.skipIf(!SHOULD_RUN)("at0769 — the gallery card draws a live example per recipe", () => {
  test(
    "the commit recipes draw over the bound repository and no section is left waiting",
    async () => {
      const repo = scratchRepository();
      const stubDir = stubDirectory();
      const { app, tugbankPath } = await launch(1, deckWithRecipes(), TEST_NAME, {
        resumeCards: [],
        env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir },
      });
      try {
        await bindStreamingStubs(app, [CARD], stubDir, 1, 1, undefined, repo);
        const page = await bodyOfKind(app, "gallery-chart-recipes");
        await page.waitForCondition<boolean>(
          `(function(){
            var settled = ${JSON.stringify([...SETTLED])};
            var sections = ${READ_SECTIONS};
            return sections.length === ${SECTIONS} && sections.every(function (s) { return settled.indexOf(s.state) >= 0; });
          })()`,
          { timeoutMs: SECTIONS_MS },
        );

        mkdirSync(SHOTS_DIR, { recursive: true });
        const sections = await page.evalJS<SectionFacts[]>(READ_SECTIONS);
        for (const { name } of sections) {
          await page.evalJS<null>(
            `(document.querySelector(${JSON.stringify(`[data-tugx-recipe="${name}"]`)}).scrollIntoView({ block: "start" }), null)`,
          );
          copyFileSync((await page.screenshot()).path, join(SHOTS_DIR, `at0769-${name}.png`));
        }
        note(`at0769 screenshots: ${SHOTS_DIR}/at0769-<recipe>.png`);

        note(`at0769 sections: ${JSON.stringify(sections.map((s) => [s.name, s.state]))}`);
        expect(sections.length).toBe(SECTIONS);
        const stateOf = new Map(sections.map((s) => [s.name, s.state]));
        for (const name of COMMIT_RECIPES) {
          expect(stateOf.get(name), `${name} draws over the repository`).toBe("rendered");
        }
        for (const section of sections) {
          if (COMMIT_RECIPES.includes(section.name)) continue;
          expect(["rendered", "no-data"], `${section.name}: ${section.text}`).toContain(section.state);
        }
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    300_000,
  );
});
