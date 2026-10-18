/**
 * at0417-jot-annotation-links.test.ts — a file cited in a jot is followable
 * from inside the jot's editor.
 *
 * A jot is usually a passage lifted out of a transcript, and a transcript
 * passage cites files. The text survives that copy; the link did not, because
 * the annotator marks rendered ink and a jot is a CodeMirror document. The
 * editor now runs the same grammar and the same resolvers over its own
 * buffer, so the citation is ⌘-clickable where the user parked it.
 *
 * The point of driving this against the real app is that nothing here can be
 * faked into passing: the decoration appears only after a real
 * `POST /api/fs/stat` confirms a real file, and the ⌘-click opens through the
 * annotation registry's own `primaryClick` — the same gesture the transcript
 * fires.
 *
 * Scenario:
 *   1. Write a real file on disk; seed a jot whose prose cites it with a line.
 *   2. Open the Jots card, open the row's editor.
 *   3. The cited run gains `.cm-annotation-link` — the round trip landed.
 *      A sibling path that names nothing never does, however long we wait:
 *      verification, not grammar, is the gate.
 *   4. ⌘-click the marked run → the file opens in a Text card showing its
 *      content.
 *
 * The second test is the shape a copied transcript passage actually has: a
 * path spelled RELATIVE to the repo root, in backticks. Jots are
 * machine-global and carry no session binding, so that path can only resolve
 * against the frontmost bound card's project — this pins that it does, and
 * that the backticks around it are punctuation the grammar strips rather than
 * part of the name.
 *
 * Runs against an isolated jots file (`TUG_JOTS_PATH`) so the user's
 * machine-global jots.json is never touched.
 *
 * @covers tugdeck/src/components/tugways/tug-text-editor/annotation-links.ts
 * @covers tugdeck/src/components/tugways/tug-text-editor/follow-accelerator.ts
 * @covers tugdeck/src/components/tugways/tug-message-editor.tsx
 * @covers tugdeck/src/components/jots/jots-card.tsx
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp } from "./_harness";
import { kindBody } from "./_harness/card-reach";
import { holdModifier } from "./_harness/client";
import { priorCardDeck } from "./_harness/shapes";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 90_000;

const EDITOR = `.jots-list .jot-editor`;
const LINK = `${EDITOR} .cm-annotation-link`;

/** The word the opened Text card must be showing for the click to have worked. */
const MARKER = "flashDurationMs";

const FILE_BODY = [
  "export const knobs = {",
  "  // the one point of use",
  `  ${MARKER}: 1500,`,
  "};",
  "",
].join("\n");

/** The line the jot's citation names — the one the click should reveal. */
const CITED_LINE = 3;

/** A session card, so the second test has a project to bind onto. */
function sessionDeck() {
  return {
    cards: [
      { id: "A", componentId: "session", title: "Session", closable: true },
    ],
    panes: [
      {
        id: "pA",
        position: { x: 60, y: 60 },
        size: { width: 900, height: 700 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "pA",
    hasFocus: true,
  };
}

describe.skipIf(!SHOULD_RUN)("at0417 — jot annotation links", () => {
  test(
    "a confirmed path in a jot is marked, and ⌘-click opens it",
    async () => {
      const tugbankPath = mkTempTugbank();
      const dir = mkdtempSync(join(tmpdir(), "tug-at0417-"));
      const filePath = join(dir, "knobs.ts");
      const missingPath = join(dir, "absent.ts");
      writeFileSync(filePath, FILE_BODY);

      const jotsPath = join(dir, "jots.json");
      writeFileSync(
        jotsPath,
        `${JSON.stringify(
          {
            version: 1,
            jots: [
              {
                id: "s1",
                // Both citations are path-shaped and spelled identically;
                // only one of them is a file.
                text: `Tune ${filePath}:${CITED_LINE} not ${missingPath}:1`,
              },
            ],
          },
          null,
          2,
        )}\n`,
      );

      try {
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0417-jot-annotation-links",
          env: { TUGBANK_PATH: tugbankPath, TUG_JOTS_PATH: jotsPath },
          persistInTestMode: true,
        });
        const jots = kindBody(app, "jots");
        const textCard = kindBody(app, "text");
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: priorCardDeck({ size: { width: 900, height: 700 } }), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 5_000 },
          );

          // 1. Open the Jots card and the seeded row's editor.
          await app.dispatchControlAction("toggle-jots");
          await jots.waitForCondition<boolean>(
            `document.querySelector('.jots-card .jot-row-label') !== null`,
            { timeoutMs: 5_000 },
          );
          await jots.nativeClickAtElement(".jots-card .jot-row-label");
          await jots.waitForCondition<boolean>(
            `document.querySelector('.jots-card .jots-list[data-key-view-kbd]') !== null`,
            { timeoutMs: 3_000 },
          );
          await app.nativeKey("Return");
          await jots.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(EDITOR)}) !== null`,
            { timeoutMs: 3_000 },
          );

          // 2. The stat round trip lands and the cited run is marked. The
          //    resolver answers asynchronously, so this is a wait, not a read.
          await jots.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(LINK)}) !== null`,
            { timeoutMs: 12_000 },
          );

          // Exactly one run is marked — the file that exists, with its line
          // citation inside the mark (the click opens AT the line, so the
          // characters that spell it have to be part of the target).
          const marked = await jots.evalJS<string[]>(
            `Array.from(document.querySelectorAll(${JSON.stringify(LINK)}))
               .map((el) => el.textContent ?? '')`,
          );
          expect(marked.length).toBe(1);
          expect(marked[0].endsWith(`knobs.ts:${CITED_LINE}`)).toBe(true);
          expect(marked[0].includes("absent.ts")).toBe(false);

          // 3. ⌘-click the marked run. The point comes from the run's FIRST
          //    client rect rather than its bounding box: the editor soft-wraps
          //    and a wrapped inline box's union rect has a center that lands in
          //    neither fragment.
          const viewportPoint = await jots.evalJS<{ x: number; y: number }>(
            `(() => {
               const el = document.querySelector(${JSON.stringify(LINK)});
               const rect = el.getClientRects()[0];
               return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
             })()`,
          );
          await holdModifier(jots, ["cmd"], async (inner) => {
            await inner.rpcCall<void>("nativeClick", { viewportPoint });
          });

          // 4. The file opens in a Text card, showing its content.
          await textCard.waitForCondition<boolean>(
            `(() => {
 ed = document.querySelector('[data-slot="tug-text-card-editor"] .cm-content');
               return ed !== null && (ed.textContent ?? '').includes(${JSON.stringify(MARKER)});
             })()`,
            { timeoutMs: 12_000 },
          );

          process.stdout.write("VERDICT: PASS\n");
        } catch (err) {
          process.stdout.write("VERDICT: FAIL\n");
          const tail = app.tailLog(200);
          if (tail !== "") {
            process.stderr.write(`\n[at0417] log tail:\n${tail}\n`);
          }
          throw err;
        } finally {
          await app.close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a backticked relative path resolves against the frontmost bound project",
    async () => {
      const tugbankPath = mkTempTugbank();
      const dir = mkdtempSync(join(tmpdir(), "tug-at0417b-"));
      mkdirSync(join(dir, "src"), { recursive: true });
      const relative = `src/knobs.ts`;
      writeFileSync(join(dir, relative), FILE_BODY);

      const jotsPath = join(dir, "jots.json");
      writeFileSync(
        jotsPath,
        `${JSON.stringify(
          {
            version: 1,
            jots: [
              {
                id: "s1",
                text: `defaulted at its one point of use in \`${relative}:${CITED_LINE}\``,
              },
            ],
          },
          null,
          2,
        )}\n`,
      );

      try {
        seedTugbankForLaunch(tugbankPath);
        const app = await launchTugApp({
          testName: "at0417-jot-relative-path",
          env: { TUGBANK_PATH: tugbankPath, TUG_JOTS_PATH: jotsPath },
          persistInTestMode: true,
        });
        const jots = kindBody(app, "jots");
        const textCard = kindBody(app, "text");
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: sessionDeck(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 5_000 },
          );
          // The project the relative path is spelled against. Nothing binds
          // the Jots card itself — it reads whichever bound card is in front,
          // which is this one.
          await app.bindSession("A", {
            tugSessionId: "at0417-relative",
            projectDir: dir,
          });

          await app.dispatchControlAction("toggle-jots");
          await jots.waitForCondition<boolean>(
            `document.querySelector('.jots-card .jot-row-label') !== null`,
            { timeoutMs: 5_000 },
          );
          await jots.nativeClickAtElement(".jots-card .jot-row-label");
          await jots.waitForCondition<boolean>(
            `document.querySelector('.jots-card .jots-list[data-key-view-kbd]') !== null`,
            { timeoutMs: 3_000 },
          );
          await app.nativeKey("Return");
          await jots.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(EDITOR)}) !== null`,
            { timeoutMs: 3_000 },
          );

          await jots.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(LINK)}) !== null`,
            { timeoutMs: 12_000 },
          );
          // The backticks are punctuation around the reference, not part of
          // it: the mark covers the path and its line citation, nothing else.
          const marked = await jots.evalJS<string[]>(
            `Array.from(document.querySelectorAll(${JSON.stringify(LINK)}))
               .map((el) => el.textContent ?? '')`,
          );
          expect(marked).toEqual([`${relative}:${CITED_LINE}`]);

          const viewportPoint = await jots.evalJS<{ x: number; y: number }>(
            `(() => {
               const el = document.querySelector(${JSON.stringify(LINK)});
               const rect = el.getClientRects()[0];
               return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
             })()`,
          );
          await holdModifier(jots, ["cmd"], async (inner) => {
            await inner.rpcCall<void>("nativeClick", { viewportPoint });
          });

          await textCard.waitForCondition<boolean>(
            `(() => {
 ed = document.querySelector('[data-slot="tug-text-card-editor"] .cm-content');
               return ed !== null && (ed.textContent ?? '').includes(${JSON.stringify(MARKER)});
             })()`,
            { timeoutMs: 12_000 },
          );

          process.stdout.write("VERDICT: PASS\n");
        } catch (err) {
          process.stdout.write("VERDICT: FAIL\n");
          const tail = app.tailLog(200);
          if (tail !== "") {
            process.stderr.write(`\n[at0417] log tail:\n${tail}\n`);
          }
          throw err;
        } finally {
          await app.close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
