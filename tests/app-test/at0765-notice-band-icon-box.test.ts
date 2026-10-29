/**
 * at0765-notice-band-icon-box.test.ts — the progress wave sits in the icon
 * box every glyph sits in.
 *
 * A notice band's leading icon is a 14 px glyph, and its text starts one gap
 * past it. The live band's wave is narrower: three bars of about 11 px of ink
 * at its default size, in a box that wide, so with the same gap it pulled its
 * text a few pixels left of every other band's and sat its ink nearer the
 * text. Every notice icon now rides an icon-size box, centred in it. This
 * pins that: on the report's live band the icon box is the icon size, the
 * wave's ink is centred in it, and the text starts one icon box and one gap
 * from the band's content edge — the column a glyph band's text starts in.
 *
 * The run is real, held the way at0763 holds it: a scratch repository with one
 * genuine conflict and a resolver stub that reads its charter and then sleeps,
 * so the live band stands for as long as the test needs it.
 *
 * @covers tugdeck/src/components/tugways/blocks/block-notice.css
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-resolve-ledger.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import { sessionCardShape } from "./_harness/shapes";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  bindArc,
  makeJoinScratchRepo,
  rmJoinScratchRepo,
  rmScratchSession,
  seedScratchSession,
  silenceJoinPrompt,
  type JoinScratchRepo,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

/** Minted per run, for the reason at0683 gives. */
const SID = randomUUID();
const CARD = '[data-card-id="A"]';
const EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;
const LANE = `${SHEET} [data-slot="session-changes-arc-lane"]`;

const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
const ARC = "at0765-work";
const ROW = `${LANE} [data-slot="session-changes-arc-row"][data-arc="${ARC}"]`;
const FOLD = `${ROW} [data-slot="session-changes-arc-fold"]`;
const BAND = `${ROW} [data-slot="session-changes-ledger"] [data-slot="tool-block-notice"]:has([data-slot="tug-progress-wave"])`;

/** Holds the run: the charter is read, and the resolver then simply waits. */
const RESOLVER_STUB = "#!/bin/sh\nread -r _charter\nsleep 120\n";

let scratch: JoinScratchRepo | null = null;
const projectDir = (): string => scratch?.repo ?? "";
let fixtureDir = "";
let tugbankPath = "";
let arcId = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeJoinScratchRepo({
    prefix: "at0765",
    arc: ARC,
    description: "at0765 fixture (a live band to measure)",
    checkout: CHECKOUT,
    file: "subject.txt",
    fork: "at0765 the body both sides will rewrite\n",
    base: "at0765 base side — the whole file, rewritten\n",
    arcBody: "at0765 arc side — the whole file, rewritten\n",
    resolver: RESOLVER_STUB,
    // `built` hands the arc to the pilot, whose run is the one under test.
    built: true,
  });
  arcId = scratch.arcId;
  fixtureDir = seedScratchSession(projectDir(), SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmJoinScratchRepo(scratch);
  rmScratchSession(fixtureDir);
  if (tugbankPath !== "") rmTempTugbank(tugbankPath);
});

const settle = (ms = 200): Promise<unknown> => new Promise((r) => setTimeout(r, ms));

/** Open the Changes shade, retried until the lane shows the arc (at0683). */
async function openTheShade(app: App): Promise<void> {
  const deadline = Date.now() + 90_000;
  for (let attempt = 1; Date.now() < deadline; attempt += 1) {
    await app.body("A").nativeClickAtElement(EDITOR);
    await settle();
    await app.nativeKey("a", ["cmd"]);
    await app.nativeKey("Delete");
    await app.nativeType("/commit");
    await settle();
    await app.nativeKey("Escape");
    await settle();
    await app.nativeKey("Return", ["cmd"]);
    const attemptBy = Date.now() + 5_000;
    while (Date.now() < attemptBy) {
      if (await app.body("A").evalJS<boolean>(`document.querySelector(${JSON.stringify(ROW)}) !== null`)) return;
      await settle(100);
    }
    note(`at0765 the shade did not show the arc (attempt ${attempt})`);
  }
  throw new Error("at0765: the Changes shade never showed the arc");
}

/** The live band's wave, or null while the report shows none. */
const WAVE_PRESENT = `document.querySelector(${JSON.stringify(BAND)}) !== null`;

interface BandGeometry {
  iconSize: number;
  gap: number;
  padStart: number;
  bandLeft: number;
  boxLeft: number;
  boxWidth: number;
  inkLeft: number;
  inkRight: number;
  textLeft: number;
}

/** The band's measured geometry, with its tokens resolved off the band itself. */
const GEOMETRY = `(() => {
  const band = document.querySelector(${JSON.stringify(BAND)});
  const box = band.querySelector(".tool-block-notice-icon");
  const text = band.querySelector(".tool-block-notice-text");
  const bars = [...band.querySelectorAll(".tug-progress-wave-bar")].map((b) => b.getBoundingClientRect());
  const probe = document.createElement("span");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  band.appendChild(probe);
  probe.style.width = "var(--tugx-toolnotice-icon-size)";
  const iconSize = probe.getBoundingClientRect().width;
  probe.style.width = "var(--tugx-toolnotice-gap)";
  const gap = probe.getBoundingClientRect().width;
  probe.remove();
  const b = band.getBoundingClientRect();
  const r = box.getBoundingClientRect();
  return {
    iconSize,
    gap,
    padStart: parseFloat(getComputedStyle(band).paddingLeft),
    bandLeft: b.left,
    boxLeft: r.left,
    boxWidth: r.width,
    inkLeft: Math.min(...bars.map((x) => x.left)),
    inkRight: Math.max(...bars.map((x) => x.right)),
    textLeft: text.getBoundingClientRect().left,
  };
})()`;

describe.skipIf(!SHOULD_RUN)("AT0765: the progress wave sits in the icon box", () => {
  test(
    "the live band's wave is boxed to the icon size and centred, and its text holds the column",
    async () => {
      tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0765-notice-band-icon-box",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: sessionCardShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });
        // The pilot works only an arc somebody holds ([D147]).
        bindArc(projectDir(), ARC, SID, scratch?.cli ?? {});
        silenceJoinPrompt(projectDir(), ARC);
        await app.dispatchControlAction("bind_arc_ok", {
          tug_session_id: SID,
          arc_id: arcId,
          arc_name: ARC,
        });
        await openTheShade(app);

        // The run line says a run is live; the report's band is in the fold,
        // which the row opens with the shade — opened by hand if it did not.
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${ROW} [data-slot="session-changes-arc-run-line"]`)}) !== null`,
          { timeoutMs: 60000 },
        );
        if (!(await app.body("A").evalJS<boolean>(`document.querySelector(${JSON.stringify(`${ROW} [data-slot="session-changes-ledger"]`)}) !== null`))) {
          await app.body("A").nativeClickAtElement(FOLD);
        }
        await app.body("A").waitForCondition<boolean>(WAVE_PRESENT, { timeoutMs: 20000 });

        const g = await app.body("A").evalJS<BandGeometry>(GEOMETRY);
        note(`at0765 band geometry: ${JSON.stringify(g)}`);
        expect(g.boxWidth, "the wave's box is the icon size").toBeCloseTo(g.iconSize, 0);
        const inkMid = (g.inkLeft + g.inkRight) / 2;
        const boxMid = g.boxLeft + g.boxWidth / 2;
        expect(Math.abs(inkMid - boxMid), "the wave's ink is centred in its box").toBeLessThan(0.75);
        expect(g.inkRight - g.inkLeft, "the wave's ink is narrower than the box it sits in").toBeLessThan(g.iconSize);
        expect(
          g.textLeft - (g.bandLeft + g.padStart),
          "the text starts one icon box and one gap in, as a glyph band's does",
        ).toBeCloseTo(g.iconSize + g.gap, 0);
        process.stdout.write("VERDICT: PASS\n");
      } catch (err) {
        process.stdout.write("VERDICT: FAIL\n");
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0765] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
