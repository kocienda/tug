/**
 * at0860-arc-cycle-of-one.test.ts — a bound arc on no cycle is shown as the
 * cycle of one it is about to be, and that cycle holds everything the arc's
 * own shade showed: its record, its brief, its reading and its verbs.
 *
 * The arc has a brief and a record of where the work came from, and no cycle
 * holds it: the moment the `/arc` door spends between binding the arc and
 * attaching it to its cycle. What is read:
 *
 *   1. The raised shade's body is the cycle body, named by the brief's title:
 *      the map reads seal `A` to tile `1`, and the list holds the sketch and
 *      the entry, both closed. The entry is headed by the brief's title and
 *      names the arc beneath it.
 *   2. Opening the sketch shows the arc's record as written, without its
 *      heading or its `Source:` line: what is wanted leads, in the text's
 *      full ink, and the approach and its list under it are quieter.
 *   3. Opening the entry shows the brief as a file atom and the arc's own
 *      reading, with its verb row whole.
 *   4. Discard arms a confirm that stands on the entry, and Cancel dismisses
 *      it with the arc untouched.
 *   5. The brief's atom opens the brief's file, and leaves the entry open.
 *   6. Changes opens the Changes shade over the arc shade, which stays
 *      raised and inert beneath it.
 *
 * @covers tugdeck/src/components/tugways/cards/session-cycle-shade-model.ts
 * @covers tugdeck/src/components/tugways/cards/use-session-cycle.ts
 * @covers tugdeck/src/components/tugways/cards/session-cycle-shade.tsx
 * @covers tugdeck/src/components/tugways/cards/session-cycle-shade.css
 * @covers tugdeck/src/components/tugways/cards/session-arc-record.tsx
 * @covers tugdeck/src/components/tugways/cards/session-arc-shade-content.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import { kindBody } from "./_harness/card-reach";
import { sessionCardShape } from "./_harness/shapes";
import { restoreSettled } from "./overlay-fixture";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  arcBriefPath,
  bindArc,
  createArc,
  makeArcScratchRepo,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  type ArcScratchRepo,
} from "./arc-fixture";
import { ARC_ENTRY, ARC_ENTRY_POPOVER, openArcEntry } from "./arc-entry-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000860";
const ARC_NAME = "at0860-cycle-of-one";
const BRIEF_TITLE = "The cycle of one brief";
const WANT_TEXT = "Show where an arc came from in one short account.";
const APPROACH_TEXT = "The want leads the sketch, and the entry stands under it.";
const PART_TEXT = "The arc opens inside its entry";

const CARD = '[data-card-id="A"]';
const SHADE = `${CARD} [data-slot="session-arc-shade"]`;
const SLOT = `${CARD} .session-view-slot`;
const BODY = `${SHADE} [data-slot="session-cycle-shade"]`;
const MAP = `${BODY} [data-slot="tug-cycle-map"]`;
const LIST = `${BODY} [data-slot="session-cycle-shade-list"]`;
const SKETCH_ROW = `${LIST} [data-asset="sA"] .session-cycle-shade-sketch-label`;
const BRIEF_ATOM = `${ARC_ENTRY} .session-cycle-shade-facts [data-slot="tug-atom-ref"]`;
const arcVerb = (kind: string): string => `${ARC_ENTRY_POPOVER} [data-slot="arc-verb"][data-verb="${kind}"]`;
const CONFIRM = '[data-slot="tug-confirm-popover"]';
const CHANGES_SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;

/** This checkout — the build under test, and never the tree an arc is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

let scratch: ArcScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({ prefix: "at0860", checkout: CHECKOUT });
  // An arc's documents are files at its own address and are never tracked.
  writeFileSync(
    arcBriefPath(projectDir(), ARC_NAME),
    [`# ${BRIEF_TITLE}`, "", "**[B01] An arc on no cycle is a cycle of one.** And nothing else.", ""].join("\n"),
  );
  // The record the door writes beside the brief: what is wanted, then the
  // approach and its parts.
  writeFileSync(
    join(dirname(arcBriefPath(projectDir(), ARC_NAME)), "sketch.md"),
    ["# Sketch", "", WANT_TEXT, "", APPROACH_TEXT, "", `- ${PART_TEXT}`, "", `Source: session ${SID}, turns 1–2`, ""].join(
      "\n",
    ),
  );
  createArc(projectDir(), ARC_NAME, "at0860 cycle of one", scratch.cli);
  fixtureDir = seedScratchSession(projectDir(), SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmArcScratchRepo(scratch);
  rmScratchSession(fixtureDir);
});

interface Box {
  l: number;
  t: number;
  r: number;
  b: number;
}

const overlaps = (a: Box, b: Box): boolean => a.l < b.r - 0.5 && a.r > b.l + 0.5 && a.t < b.b - 0.5 && a.b > b.t + 0.5;

/** Wait for the shade to say it is raised and for its transform to have finished. */
const shadeRaised = (app: App): Promise<boolean> =>
  app.body("A").waitForCondition<boolean>(
    `(() => {
       const shade = document.querySelector(${JSON.stringify(SHADE)});
       const slot = document.querySelector(${JSON.stringify(SLOT)});
       if (shade === null || slot === null || shade.getAttribute("data-raised") !== "true") return false;
       return Math.abs(shade.getBoundingClientRect().bottom - slot.getBoundingClientRect().bottom) <= 1
         && shade.getAnimations().length === 0;
     })()`,
    { timeoutMs: 10_000 },
  );

interface RestReading {
  form: string | null;
  name: string;
  seals: string[];
  tiles: string[];
  assets: string[];
  opened: string[];
  headline: string;
  arcChip: string;
}

const readRest = (app: App): Promise<RestReading> =>
  app.body("A").evalJS<RestReading>(
    `(() => {
       const text = (el) => (el?.textContent ?? "").replace(/\\s+/g, " ").trim();
       const shade = document.querySelector(${JSON.stringify(SHADE)});
       const map = document.querySelector(${JSON.stringify(MAP)});
       const list = document.querySelector(${JSON.stringify(LIST)});
       const assets = Array.from(list?.querySelectorAll('[data-slot="session-cycle-shade-asset"]') ?? []);
       const entry = list?.querySelector('[data-asset="e1"]');
       return {
         form: shade.getAttribute("data-form"),
         name: text(document.querySelector(${JSON.stringify(`${BODY} [data-slot="session-cycle-shade-name"]`)})),
         seals: Array.from(map?.querySelectorAll(".tug-cycle-map-seal") ?? []).map(text),
         tiles: Array.from(map?.querySelectorAll(".tug-cycle-map-tile") ?? []).map((el) => el.getAttribute("aria-label") ?? ""),
         assets: assets.map((el) => el.getAttribute("data-asset")),
         opened: assets.filter((el) => el.hasAttribute("data-open")).map((el) => el.getAttribute("data-asset")),
         headline: text(entry?.querySelector('[data-slot="session-cycle-shade-headline"]')),
         arcChip: text(entry?.querySelector(".session-cycle-shade-facts .tug-arc-atom")),
       };
     })()`,
  );

describe.skipIf(!SHOULD_RUN)("AT0860: a bound arc on no cycle is its cycle of one", () => {
  test(
    "the cycle of one holds the arc's record, its brief, its reading and its verbs",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0860-arc-cycle-of-one",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        // A tall card, so the open entry and its verbs stand inside the cap.
        await app.seedDeckState({ state: sessionCardShape({ width: 900, height: 900 }), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 30_000 });
        await restoreSettled(app, "A");
        bindArc(projectDir(), ARC_NAME, SID, {
          binaryRoot: CHECKOUT,
          env: scratch?.cli.env,
        });
        // The stand-in is drawn once the frame carries the arc's brief title.
        await app.body("A").waitForCondition<boolean>(
          `(document.querySelector(${JSON.stringify(`${BODY} [data-slot="session-cycle-shade-name"]`)})?.textContent ?? "").includes(${JSON.stringify(BRIEF_TITLE)})`,
          { timeoutMs: 30_000 },
        );
        await app.dispatchControlAction("toggle-arc-shade");
        await shadeRaised(app);

        // ── The cycle body, named by the brief, reading A to 1 ────────────
        const rest = await readRest(app);
        note("at0860 at rest", JSON.stringify(rest));
        expect(rest.form, "the shade draws the cycle body").toBe("several");
        expect(rest.name, "named by the brief's title").toBe(BRIEF_TITLE);
        expect(rest.seals, "the map reads its sketch").toEqual(["A"]);
        expect(rest.tiles, "and its one entry, running here").toEqual([`1, ${BRIEF_TITLE} · Running in this session`]);
        expect(rest.assets, "the list holds the sketch and the entry").toEqual(["sA", "e1"]);
        expect(rest.opened, "both closed").toEqual([]);
        expect(rest.headline, "the entry is headed by the brief's title").toBe(BRIEF_TITLE);
        expect(rest.arcChip, "and names its arc beneath it, behind its sigil").toBe(`^${ARC_NAME}`);

        // ── The sketch shows the record as written ────────────────────────
        await app.body("A").click(SKETCH_ROW);
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${LIST} [data-asset="sA"] [data-slot="session-arc-record-text"]`)}) !== null`,
          { timeoutMs: 6_000 },
        );
        const sketch = await app.body("A").evalJS<{ paragraphs: string[]; items: string[]; ink: string[] }>(
          `(() => {
             const text = (node) => (node?.textContent ?? "").trim();
             const record = document.querySelector(${JSON.stringify(`${LIST} [data-asset="sA"] [data-slot="session-arc-record-text"]`)});
             const paragraphs = Array.from(record.querySelectorAll(":scope > p"));
             return {
               paragraphs: paragraphs.map(text),
               items: Array.from(record.querySelectorAll(":scope > ul > li")).map(text),
               ink: [getComputedStyle(record).color, ...paragraphs.map((p) => getComputedStyle(p).color)],
             };
           })()`,
        );
        note("at0860 sketch", JSON.stringify(sketch));
        expect(sketch.paragraphs, "the record as written, the want first").toEqual([WANT_TEXT, APPROACH_TEXT]);
        expect(sketch.items, "and its parts").toEqual([PART_TEXT]);
        const [textInk, wantInk, approachInk] = sketch.ink;
        expect(wantInk, "the want is in the text's full ink").toBe(textInk);
        expect(approachInk, "and the approach under it is quieter").not.toBe(textInk);

        // ── The entry opens on the brief and the arc's reading ────────────
        await openArcEntry(app);
        const opened = await app.body("A").evalJS<{ brief: string; verbs: string[] }>(
          `(() => ({
             brief: (document.querySelector(${JSON.stringify(BRIEF_ATOM)})?.textContent ?? "").trim(),
             verbs: Array.from(document.querySelectorAll(${JSON.stringify(`${ARC_ENTRY_POPOVER} [data-slot="arc-verb"]`)}))
               .map((el) => el.getAttribute("data-verb")),
           }))()`,
        );
        note("at0860 entry opened", JSON.stringify(opened));
        expect(opened.brief, "the brief is a file atom").toBe("brief.md");
        expect(opened.verbs, "the arc's verbs are in its entry").toContain("changes");
        expect(opened.verbs).toContain("discard");

        // ── Discard's confirm stands on the entry ─────────────────────────
        await app.body("A").click(arcVerb("discard"));
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CONFIRM)}) !== null`,
          { timeoutMs: 6_000 },
        );
        const confirm = await app.body("A").evalJS<{ popover: Box; entry: Box }>(
          `(() => {
             const box = (el) => {
               const r = el.getBoundingClientRect();
               return { l: r.left, t: r.top, r: r.right, b: r.bottom };
             };
             return {
               popover: box(document.querySelector(${JSON.stringify(CONFIRM)})),
               entry: box(document.querySelector(${JSON.stringify(ARC_ENTRY)})),
             };
           })()`,
        );
        note("at0860 confirm", JSON.stringify(confirm));
        expect(confirm.popover.r - confirm.popover.l, "the confirm is drawn").toBeGreaterThan(0);
        expect(overlaps(confirm.popover, confirm.entry), "the confirm stands on the entry").toBe(true);
        await app.body("A").click(`${CONFIRM} [data-slot="tug-confirm-cancel"]`);
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CONFIRM)}) === null`,
          { timeoutMs: 6_000 },
        );
        expect(
          await app.body("A").evalJS<boolean>(`document.querySelector(${JSON.stringify(ARC_ENTRY_POPOVER)}) !== null`),
          "Cancel leaves the arc bound",
        ).toBe(true);

        // ── The brief's atom opens the brief's own file ───────────────────
        // The proof is the document's bytes on screen: a Text card carrying
        // the brief's heading is the file, opened.
        await app.body("A").click(BRIEF_ATOM);
        await kindBody(app, "text").waitForCondition<boolean>(
          `Array.from(document.querySelectorAll('[data-slot="text-card"]'))
             .some((card) => (card.textContent ?? "").includes(${JSON.stringify(BRIEF_TITLE)}))`,
          { timeoutMs: 20_000 },
        );
        expect(
          await app.body("A").evalJS<boolean>(`document.querySelector(${JSON.stringify(`${ARC_ENTRY}[data-open]`)}) !== null`),
          "and the press leaves the entry open: one press, one act",
        ).toBe(true);

        // ── Changes opens the Changes shade over the arc shade ────────────
        await app.body("A").click(arcVerb("changes"));
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHADE)})?.inert === true &&
           document.querySelector(${JSON.stringify(CHANGES_SHEET)}) !== null`,
          { timeoutMs: 6_000 },
        );
        expect(
          await app.body("A").evalJS<string | null>(
            `document.querySelector(${JSON.stringify(SHADE)})?.getAttribute("data-raised") ?? null`,
          ),
          "the arc shade stays raised under Changes",
        ).toBe("true");
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
