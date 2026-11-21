/**
 * at0859-arc-shade-surface.test.ts — the arc shade as a surface: it rises from
 * the bottom of the transcript, leaves a strip of transcript showing and
 * inert, takes the keyboard while it is up, and gives it back.
 *
 * The shade is raised and lowered here through its command
 * (`toggle-arc-shade`), which toggles the card's own store, and through the
 * command's two doors, the ARC status cell and ⌥⌘R. What is read:
 *
 *   1. Lowered, the shade is mounted, inert and out of sight below the slot.
 *   2. With no arc the raised shade is short: resting on the slot's bottom
 *      edge, as tall as its hint, and no taller than four fifths of the slot.
 *   3. While it is up the transcript pane is inert and the key view is inside
 *      the shade; the status row stays in view beneath it.
 *   4. Escape lowers it, the transcript takes input again, and the caret is
 *      back in the composer it was taken from.
 *   5. With an arc bound the raised shade holds the panels by the same rule:
 *      as tall as they need, never past four fifths of the slot, so at least
 *      a fifth of the transcript shows. It names the arc, and the footer's
 *      Done button lowers it.
 *   6. The shade and the History shade never stand together: either one
 *      rising takes the other down.
 *   7. A press on the ARC cell raises the shade and a second lowers it, and
 *      the cell's endcap wears the accent for exactly as long as it is up.
 *   8. ⌥⌘R raises it and lowers it, from the composer and from inside it.
 *
 * @covers tugdeck/src/components/tugways/cards/session-arc-shade.tsx
 * @covers tugdeck/src/components/tugways/cards/session-arc-shade.css
 * @covers tugdeck/src/components/tugways/cards/session-arc-shade-content.tsx
 * @covers tugdeck/src/components/tugways/cards/session-telemetry-cell.tsx
 * @covers tugdeck/src/components/tugways/cards/session-telemetry-cell.css
 * @covers tugdeck/src/lib/arc-shade-controller.ts
 * @covers tugdeck/src/components/tugways/cards/use-menu-state-publication.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import { sessionCardShape } from "./_harness/shapes";
import { restoreSettled } from "./overlay-fixture";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  bindArc,
  createArc,
  makeArcScratchRepo,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  type ArcScratchRepo,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000859";
const ARC_NAME = "at0859-shade";

const CARD = '[data-card-id="A"]';
const SHADE = `${CARD} [data-slot="session-arc-shade"]`;
const SLOT = `${CARD} .session-view-slot`;
const TRANSCRIPT_PANE = `${CARD} .session-view-pane[data-view="transcript"]`;
const STATUS_ROW = `${CARD} [data-slot="session-telemetry-status-row"]`;
const LOWER_BUTTON = `${SHADE} [data-slot="session-arc-shade-foot"] button:last-of-type`;
const COMPOSER = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const ARC_CELL = `${CARD} [data-slot="tug-status-cell"][data-priority="arc"]`;
const STATE_CELL = `${CARD} [data-slot="tug-status-cell"][data-priority="state"]`;

/** This checkout — the build under test, and never the tree an arc is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

let scratch: ArcScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({ prefix: "at0859", checkout: CHECKOUT });
  // A worktree and nothing else: the shade's form asks only whether the
  // session has an arc.
  createArc(projectDir(), ARC_NAME, "at0859 shade", scratch.cli);
  fixtureDir = seedScratchSession(projectDir(), SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmArcScratchRepo(scratch);
  rmScratchSession(fixtureDir);
});

interface ShadeReading {
  raised: string | null;
  /** The shade holds the arc's panels rather than the no-arc hint. */
  panels: boolean;
  /** How far the shade's body runs past its own box, down. */
  bodyScroll: number;
  shadeInert: boolean;
  transcriptInert: boolean;
  slotTop: number;
  slotBottom: number;
  slotHeight: number;
  shadeTop: number;
  shadeBottom: number;
  shadeHeight: number;
  rowTop: number;
  keyViewInShade: boolean;
  focusInComposer: boolean;
  /** Where DOM focus and the key view are, for a failure to say. */
  active: string;
  keyView: string;
  text: string;
}

const read = (app: App): Promise<ShadeReading> =>
  app.body("A").evalJS<ShadeReading>(
    `(() => {
       const shade = document.querySelector(${JSON.stringify(SHADE)});
       const slot = document.querySelector(${JSON.stringify(SLOT)});
       const pane = document.querySelector(${JSON.stringify(TRANSCRIPT_PANE)});
       const row = document.querySelector(${JSON.stringify(STATUS_ROW)});
       const composer = document.querySelector(${JSON.stringify(COMPOSER)});
       const round = (n) => Math.round(n * 100) / 100;
       const s = shade.getBoundingClientRect();
       const v = slot.getBoundingClientRect();
       const keyView = document.querySelector("[data-key-view]");
       const say = (el) => el === null ? "none" : el.tagName.toLowerCase()
         + (el.getAttribute("data-slot") ? "[" + el.getAttribute("data-slot") + "]" : "")
         + (el.className && typeof el.className === "string" ? "." + el.className.split(" ")[0] : "")
         + (el.hasAttribute("data-key-view-kbd") ? " kbd" : "");
       return {
         raised: shade.getAttribute("data-raised"),
         panels: shade.querySelector('[data-slot="session-arc-panels"]') !== null,
         bodyScroll: (() => {
           const body = shade.querySelector('[data-slot="session-arc-shade-body"]');
           return body === null ? 0 : body.scrollHeight - body.clientHeight;
         })(),
         shadeInert: shade.inert === true,
         transcriptInert: pane.inert === true,
         slotTop: round(v.top),
         slotBottom: round(v.bottom),
         slotHeight: round(v.height),
         shadeTop: round(s.top),
         shadeBottom: round(s.bottom),
         shadeHeight: round(s.height),
         rowTop: round(row.getBoundingClientRect().top),
         keyViewInShade: keyView !== null && shade.contains(keyView),
         focusInComposer: composer !== null && composer.contains(document.activeElement),
         active: say(document.activeElement),
         keyView: say(keyView),
         text: (shade.textContent ?? "").trim(),
       };
     })()`,
  );

interface CellReading {
  pressed: string | null;
  ariaPressed: string | null;
  /** The ARC cell's endcap tick and rule, as painted. */
  tick: string;
  rule: string;
  /** A neighbour's tick, which never wears the accent. */
  plainTick: string;
}

const readCell = (app: App): Promise<CellReading> =>
  app.body("A").evalJS<CellReading>(
    `(() => {
       const cell = document.querySelector(${JSON.stringify(ARC_CELL)});
       const plain = document.querySelector(${JSON.stringify(STATE_CELL)});
       const paint = (el) => {
         const s = getComputedStyle(el);
         return s.backgroundColor + " @" + s.opacity;
       };
       return {
         pressed: cell.getAttribute("data-pressed"),
         ariaPressed: cell.getAttribute("aria-pressed"),
         tick: paint(cell.querySelector(".session-telemetry-endcap-tick")),
         rule: paint(cell.querySelector(".session-telemetry-endcap-rule-fill")),
         plainTick: paint(plain.querySelector(".session-telemetry-endcap-tick")),
       };
     })()`,
  );

/** Wait for the shade to say it is raised or lowered and for its transform to have finished. */
const settled = async (app: App, raised: boolean): Promise<ShadeReading> => {
  await app.body("A").waitForCondition<boolean>(
    `(() => {
       const shade = document.querySelector(${JSON.stringify(SHADE)});
       const slot = document.querySelector(${JSON.stringify(SLOT)});
       if (shade === null || slot === null) return false;
       if (shade.getAttribute("data-raised") !== ${JSON.stringify(raised ? "true" : "false")}) return false;
       const s = shade.getBoundingClientRect();
       const v = slot.getBoundingClientRect();
       return ${raised ? "Math.abs(s.bottom - v.bottom) <= 1" : "s.top >= v.bottom - 1"};
     })()`,
    { timeoutMs: 10_000 },
  );
  return read(app);
};

describe.skipIf(!SHOULD_RUN)("AT0859: the arc shade over the transcript", () => {
  test(
    "it rises to its form's height, leaves an inert strip, holds the keyboard and gives it back",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0859-arc-shade-surface",
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
          `document.querySelector(${JSON.stringify(SHADE)}) !== null`,
          { timeoutMs: 20_000 },
        );

        // ── Lowered: mounted, inert, and below the slot ───────────────────
        const lowered = await settled(app, false);
        note("at0859 lowered", JSON.stringify(lowered));
        expect(lowered.shadeInert, "a lowered shade is inert").toBe(true);
        expect(lowered.transcriptInert, "the transcript is live with the shade down").toBe(false);
        expect(lowered.panels, "no arc, no panels").toBe(false);

        // The caret goes to the composer, so the raise has somewhere to take
        // the keyboard from and the lower somewhere to return it.
        await app.body("A").nativeClickAtElement(COMPOSER);
        await app.body("A").waitForCondition<boolean>(
          `(() => { const c = document.querySelector(${JSON.stringify(COMPOSER)}); return c !== null && c.contains(document.activeElement); })()`,
          { timeoutMs: 6_000 },
        );

        // ── Raised with no arc: as tall as the hint ───────────────────────
        await app.dispatchControlAction("toggle-arc-shade");
        const short = await settled(app, true);
        note("at0859 no arc raised", JSON.stringify(short));
        expect(short.panels).toBe(false);
        expect(short.shadeInert, "a raised shade is live").toBe(false);
        expect(short.transcriptInert, "the transcript strip is inert under a raised shade").toBe(true);
        expect(short.shadeHeight, "the shade is no taller than four fifths of the slot")
          .toBeLessThanOrEqual(short.slotHeight * 0.8 + 1);
        // Its content's height, well short of the cap: the hint, and the
        // footer that carries Done.
        expect(short.shadeHeight, "and it is short").toBeLessThan(short.slotHeight * 0.8 - 40);
        expect(short.bodyScroll, "and holds its hint whole").toBeLessThanOrEqual(0);
        expect(short.keyViewInShade, "the key view moved into the shade").toBe(true);
        expect(short.focusInComposer, "and the caret left the composer").toBe(false);
        expect(short.rowTop, "the status row stays in view beneath the shade")
          .toBeGreaterThanOrEqual(short.shadeBottom - 1);

        // ── Escape lowers it and returns the keyboard ─────────────────────
        await app.nativeKey("Escape");
        const afterEscape = await settled(app, false);
        note("at0859 after Escape", JSON.stringify(afterEscape));
        expect(afterEscape.shadeInert).toBe(true);
        expect(afterEscape.transcriptInert, "the transcript takes input again").toBe(false);
        expect(afterEscape.keyViewInShade).toBe(false);
        await app.body("A").waitForCondition<boolean>(
          `(() => { const c = document.querySelector(${JSON.stringify(COMPOSER)}); return c !== null && c.contains(document.activeElement); })()`,
          { timeoutMs: 6_000 },
        );

        // ── With an arc: the panels, by the same rule ─────────────────────
        bindArc(projectDir(), ARC_NAME, SID, {
          binaryRoot: CHECKOUT,
          env: scratch?.cli.env,
        });
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(`${SHADE} [data-slot="session-arc-panels"]`)}) !== null`,
          { timeoutMs: 30_000 },
        );
        // A session holds one arc, so Session ▸ New Arc is dimmed now.
        const deadline = Date.now() + 8_000;
        let newArc = await app.menuItemState("session.newArc");
        while (newArc.found && newArc.enabled !== false && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 100));
          newArc = await app.menuItemState("session.newArc");
        }
        expect(newArc.found, "the Session menu holds New Arc").toBe(true);
        expect(newArc.found ? newArc.enabled : undefined, "New Arc is dimmed once the session has an arc").toBe(false);
        await app.dispatchControlAction("toggle-arc-shade");
        const full = await settled(app, true);
        note("at0859 with an arc raised", JSON.stringify(full));
        expect(full.panels).toBe(true);
        expect(Math.abs(full.shadeBottom - full.slotBottom), "the shade rests on the slot's bottom edge")
          .toBeLessThanOrEqual(1);
        expect(full.shadeHeight, "it is no taller than four fifths of the slot")
          .toBeLessThanOrEqual(full.slotHeight * 0.8 + 1);
        expect(full.shadeTop, "so at least a fifth of the transcript shows above it")
          .toBeGreaterThanOrEqual(full.slotTop + full.slotHeight * 0.2 - 1);
        // Short of the cap, the shade is exactly as tall as the panels need.
        if (full.shadeHeight < full.slotHeight * 0.8 - 1) {
          expect(full.bodyScroll, "under the cap, the shade holds the panels whole").toBeLessThanOrEqual(0);
        }
        expect(full.transcriptInert).toBe(true);
        expect(full.text, "the header names the arc").toContain(ARC_NAME);

        // The footer's Done button lowers it.
        await app.body("A").nativeClickAtElement(LOWER_BUTTON);
        const afterButton = await settled(app, false);
        expect(afterButton.transcriptInert).toBe(false);

        // ── The arc shade and History never stand together ────────────────
        const historyUp = `document.querySelector('[data-shade-open="history"]') !== null`;
        await app.dispatchControlAction("toggle-arc-shade");
        await settled(app, true);
        await app.dispatchControlAction("toggle-history-view");
        await app.body("A").waitForCondition<boolean>(historyUp, { timeoutMs: 6_000 });
        const underHistory = await settled(app, false);
        expect(underHistory.raised, "History rising lowers the arc shade").toBe("false");
        await app.dispatchControlAction("toggle-arc-shade");
        await settled(app, true);
        await app.body("A").waitForCondition<boolean>(`!(${historyUp})`, { timeoutMs: 6_000 });
        await app.dispatchControlAction("toggle-arc-shade");
        await settled(app, false);

        // ── The ARC cell is the shade's door, and says when it is up ──────
        const cellDown = await readCell(app);
        note("at0859 cell, shade down", JSON.stringify(cellDown));
        expect(cellDown.pressed, "a cell whose shade is down is not pressed").toBeNull();
        expect(cellDown.ariaPressed).toBe("false");
        expect(cellDown.tick, "its endcap is the plain rule").toBe(cellDown.plainTick);
        await app.body("A").nativeClickAtElement(ARC_CELL);
        const byCell = await settled(app, true);
        expect(byCell.text, "the raised shade carries the arc's own reading").toContain(ARC_NAME);
        const cellUp = await readCell(app);
        note("at0859 cell, shade up", JSON.stringify(cellUp));
        expect(cellUp.pressed).toBe("true");
        expect(cellUp.ariaPressed).toBe("true");
        expect(cellUp.tick, "the tick takes the accent").not.toBe(cellDown.tick);
        expect(cellUp.rule, "and the rule with it").toBe(cellUp.tick);
        expect(cellUp.plainTick, "a neighbour's endcap is untouched").toBe(cellDown.plainTick);
        await app.body("A").nativeClickAtElement(ARC_CELL);
        await settled(app, false);
        expect((await readCell(app)).pressed, "a second press lowers it").toBeNull();

        // ── ⌥⌘R is the other door ─────────────────────────────────────────
        await app.body("A").nativeClickAtElement(COMPOSER);
        await app.body("A").waitForCondition<boolean>(
          `(() => { const c = document.querySelector(${JSON.stringify(COMPOSER)}); return c !== null && c.contains(document.activeElement); })()`,
          { timeoutMs: 6_000 },
        );
        await app.nativeKey("r", ["alt", "cmd"]);
        const byChord = await settled(app, true);
        expect(byChord.keyViewInShade, "the chord raises it from the composer").toBe(true);
        expect((await readCell(app)).pressed).toBe("true");
        await app.nativeKey("r", ["alt", "cmd"]);
        const chordDown = await settled(app, false);
        expect(chordDown.transcriptInert, "and lowers it from inside the shade").toBe(false);
        const composerText = await app.body("A").evalJS<string>(
          `(document.querySelector(${JSON.stringify(COMPOSER)})?.textContent ?? "")`,
        );
        expect(composerText, "the chord types nothing into the composer").not.toContain("®");
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
