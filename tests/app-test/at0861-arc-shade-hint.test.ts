/**
 * at0861-arc-shade-hint.test.ts — the arc shade's short form, for a session
 * with no arc: what it says, and where its help link goes.
 *
 * What is read:
 *
 *   1. A press on the ARC cell of a session with no arc raises the shade in
 *      its short form, and the shade holds no panels.
 *   2. The shade says the one word the cell reads, says how to start an arc
 *      by naming the `/arc` command, and carries a link written as a help
 *      link to the guide's section on arcs.
 *   3. Following the link opens the feature guide in a help card, scrolled to
 *      its Arcs heading.
 *
 * @covers tugdeck/src/components/tugways/cards/session-arc-shade-hint.tsx
 * @covers tugdeck/src/components/tugways/cards/session-arc-shade-hint.css
 * @covers tugdeck/src/components/tugways/cards/session-arc-shade-content.tsx
 * @covers docs/features.md
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { launchTugApp, note } from "./_harness";
import { kindBody } from "./_harness/card-reach";
import { sessionCardShape } from "./_harness/shapes";
import { restoreSettled } from "./overlay-fixture";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  makeArcScratchRepo,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  type ArcScratchRepo,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000861";

const CARD = '[data-card-id="A"]';
const SHADE = `${CARD} [data-slot="session-arc-shade"]`;
const HINT = `${SHADE} [data-slot="session-arc-shade-hint"]`;
const HELP_LINK = `${HINT} [data-slot="session-arc-shade-hint-help"]`;
const ARC_CELL = `${CARD} [data-slot="tug-status-cell"][data-priority="arc"]`;

/** This checkout — the build under test. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

let scratch: ArcScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  // A project and a session in it, and no arc anywhere.
  scratch = makeArcScratchRepo({ prefix: "at0861", checkout: CHECKOUT });
  fixtureDir = seedScratchSession(projectDir(), SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmArcScratchRepo(scratch);
  rmScratchSession(fixtureDir);
});

describe.skipIf(!SHOULD_RUN)("AT0861: the arc shade with no arc", () => {
  test(
    "the short shade says how to start an arc, and its link opens the guide at Arcs",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0861-arc-shade-hint",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.seedDeckState({ state: sessionCardShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 30_000 });
        await restoreSettled(app, "A");
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(HINT)}) !== null`,
          { timeoutMs: 20_000 },
        );

        // ── The cell raises the short form ────────────────────────────────
        await app.body("A").click(ARC_CELL);
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHADE)})?.getAttribute("data-raised") === "true"`,
          { timeoutMs: 10_000 },
        );
        const hint = await app.body("A").evalJS<{
          form: string | null;
          panels: boolean;
          none: string;
          text: string;
          code: string[];
          link: string;
          href: string | null;
        }>(
          `(() => {
             const shade = document.querySelector(${JSON.stringify(SHADE)});
             const hint = document.querySelector(${JSON.stringify(HINT)});
             const link = document.querySelector(${JSON.stringify(HELP_LINK)});
             const text = (el) => (el?.textContent ?? "").replace(/\\s+/g, " ").trim();
             return {
               form: shade.getAttribute("data-form"),
               panels: shade.querySelector('[data-slot="session-arc-panels"]') !== null,
               none: text(hint.querySelector('[data-slot="session-arc-shade-hint-none"]')),
               text: text(hint.querySelector(".session-arc-shade-hint-text")),
               code: Array.from(hint.querySelectorAll("code")).map(text),
               link: text(link),
               href: link?.getAttribute("href") ?? null,
             };
           })()`,
        );
        note("at0861 hint", JSON.stringify(hint));
        expect(hint.form).toBe("short");
        expect(hint.panels, "no arc, no panels").toBe(false);
        expect(hint.none, "the shade says the word the cell reads").toBe("None");
        expect(hint.text, "it says what an arc is").toContain("An arc is");
        expect(hint.code, "and names the command that starts one").toEqual(["/arc"]);
        expect(hint.link).toBe("What an arc is");
        expect(hint.href, "the link is a help link to the guide's Arcs section").toBe("features.md#arcs");

        // ── The link opens the guide at its Arcs heading ──────────────────
        await app.body("A").click(HELP_LINK);
        const help = await kindBody(app, "help").waitForCondition<{ title: string; top: number; height: number }>(
          `(() => {
             const card = document.querySelector('[data-slot="help-card"]');
             const title = card?.querySelector("h1");
             const arcs = Array.from(card?.querySelectorAll("h2") ?? []).find(
               (h) => (h.textContent ?? "").trim() === "Arcs",
             );
             if (!title || !arcs) return null;
             const top = arcs.getBoundingClientRect().top;
             if (top < 0 || top > window.innerHeight) return null;
             return { title: (title.textContent ?? "").trim(), top: Math.round(top), height: window.innerHeight };
           })()`,
          { timeoutMs: 20_000 },
        );
        note("at0861 help", JSON.stringify(help));
        expect(help.title).toBe("Tug: what it does and how to use it");
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
