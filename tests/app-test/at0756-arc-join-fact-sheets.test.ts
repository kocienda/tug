/**
 * at0756-arc-join-fact-sheets.test.ts — a join blocker's fact sheet reads
 * left-aligned, and the join register paints whole.
 *
 * A blocker is a `TugInlineDialog`. The primitive centres a description and
 * caps its width, which is right for a permission prompt's one line and wrong
 * for a sheet of paths and sentences that is read rather than announced. So
 * the sheet rides the dialog's body slot, which the primitive already insets
 * to the title text's edge plus its own optical nudge — and the first path then
 * stands on that content edge, with no row inset or gutter of its own.
 *
 * No other file mounts a blocker sheet, so this one builds the state for
 * real: a scratch repository, an arc whose round edits a file, and an
 * uncommitted edit to that same file left in the base checkout. The join
 * preflight reports that as base work in the way, with a remedy, which is the
 * blocker the report section draws as a dialog.
 *
 * The register above the report is asserted in the same mount: its trailing
 * summary lies inside the register's own box. A clip on the register's root
 * used to cut it.
 *
 * Then the blocker's own act is pressed. The fold commits the base work, and
 * its receipt is answered rather than merely reported: an inline dialog whose
 * sheet rides the same body slot, offering Keep and Undo. Keep is the reader's
 * acknowledgement and hides the receipt on this page.
 *
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-arc-join.tsx
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-arc-fold.css
 * @covers tugdeck/src/components/tugways/arc-join-register.css
 * @covers tugdeck/src/components/tugways/arc-join-register.tsx
 * @covers tugdeck/src/lib/fold-receipt-keep-store.ts
 * @covers tugdeck/src/lib/resolve-ledger.ts
 * @covers tugrust/crates/tugarc-core/src/ops/join.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import { sessionCardShape } from "./_harness/shapes";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  commitRound,
  createArc,
  makeArcScratchRepo,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  type ArcScratchRepo,
} from "./arc-fixture";
import { kindBody, waitForNoBodyOfKind } from "./_harness/card-reach";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000756";
const CARD = '[data-card-id="A"]';
const EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;
const LANE = `${SHEET} [data-slot="session-changes-arc-lane"]`;

const ARC = "at0756-sheets";
const ROW = `${LANE} [data-slot="session-changes-arc-row"][data-arc="${ARC}"]`;
const JOIN_FACE = `${ROW} [data-slot="session-changes-arc-join"]`;
const BLOCKER = `${ROW} [data-blocker="base-dirt"] .session-changes-arc-join-blocker`;
const REGISTER = `${ROW} [data-slot="arc-join-register"]`;
const RESOLVE_BASE = `${BLOCKER} [data-slot="session-changes-arc-join-resolve-base"]`;
const RECEIPT = `${ROW} [data-slot="session-changes-arc-join-resolve-receipt"]`;
const KEEP = `${RECEIPT} [data-slot="session-changes-arc-join-keep-resolve-base"]`;
const UNDO = `${RECEIPT} [data-slot="session-changes-arc-join-undo-resolve-base"]`;

const ARCS_CARD = ".arcs-section";

/** This checkout — the build under test, and never the tree an arc is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
let scratch: ArcScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";

/** The file the arc's round edits and the base checkout leaves dirty. */
const SUBJECT_FILE = "at0756-subject.txt";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({
    prefix: "at0756",
    checkout: CHECKOUT,
    files: { [SUBJECT_FILE]: "at0756 first line\n" },
  });
  const created = createArc(projectDir(), ARC, "at0756 fact sheets", scratch.cli);
  writeFileSync(join(created.worktree, SUBJECT_FILE), "at0756 the arc's line\n");
  commitRound(projectDir(), ARC, `at0756(round): edit ${SUBJECT_FILE}`, scratch.cli);
  // The base checkout's own uncommitted edit to the same path: the join would
  // overwrite it, so the preflight reports it as base work in the way.
  writeFileSync(join(projectDir(), SUBJECT_FILE), "at0756 the base's own edit\n");
  fixtureDir = seedScratchSession(projectDir(), SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmArcScratchRepo(scratch);
  rmScratchSession(fixtureDir);
});

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

async function runCommand(app: App, line: string): Promise<void> {
  await app.body("A").nativeClickAtElement(EDITOR);
  await app.nativeType(line);
  await settle();
  // Dismiss the slash completion popup so Enter submits rather than accepting.
  await app.nativeKey("Escape");
  await settle();
  await app.nativeKey("Return", ["cmd"]);
}

interface SheetReading {
  bodyAlign: string;
  descriptions: number;
  pathText: string;
  pathLeft: number;
  titleLeft: number;
  /** The body slot's content edge: its box plus its own inline padding. */
  contentLeft: number;
  /** The primitive's optical nudge, resolved in px. */
  nudge: number;
  register: { left: number; top: number; right: number; bottom: number } | null;
  summary: { left: number; top: number; right: number; bottom: number } | null;
}

describe.skipIf(!SHOULD_RUN)("AT0756: a join blocker's fact sheet", () => {
  test(
    "the sheet rides the body slot on the title's edge, and the register paints whole",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0756-arc-join-fact-sheets",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: sessionCardShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        // Spawned, so the scratch repo is registered as a workspace and its
        // arc reaches the aggregate.
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });

        await app.dispatchControlAction("toggle-arcs");
        await kindBody(app, "dashes").waitForCondition<boolean>(
          `document.querySelector('${ARCS_CARD} [data-slot="arcs-row"][data-arc="${ARC}"]') !== null`,
          { timeoutMs: 30000 },
        );
        await app.dispatchControlAction("toggle-arcs");
        await waitForNoBodyOfKind(app, "dashes", { timeoutMs: 8000 });

        // Aim the join by name: the shade rises with the arc fronted, and its
        // report carries the blocker.
        await runCommand(app, `/arc-join ${ARC}`);
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(JOIN_FACE)})?.getAttribute("data-outcome") === "blocked"
             && document.querySelector(${JSON.stringify(BLOCKER)}) !== null`,
          { timeoutMs: 40000 },
        );

        const reading = await app.body("A").evalJS<SheetReading>(
          `(function(){
            var dialog = document.querySelector(${JSON.stringify(BLOCKER)});
            var body = dialog.querySelector('[data-slot="tug-inline-dialog-body"]');
            var title = dialog.querySelector('.tug-inline-dialog-title');
            var path = dialog.querySelector('[data-slot="session-changes-arc-join-paths"] .arc-fold-path');
            var register = document.querySelector(${JSON.stringify(REGISTER)});
            var summary = register === null ? null : register.querySelector('[data-slot="tool-call-header-summary"]');
            var box = function (el) {
              if (el === null) return null;
              var r = el.getBoundingClientRect();
              return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
            };
            return {
              bodyAlign: body === null ? "" : getComputedStyle(body).textAlign,
              descriptions: dialog.querySelectorAll('.tug-inline-dialog-description').length,
              pathText: path === null ? "" : (path.textContent || "").trim(),
              pathLeft: path === null ? -1 : path.getBoundingClientRect().left,
              titleLeft: title === null ? -1 : title.getBoundingClientRect().left,
              contentLeft: body === null ? -1
                : body.getBoundingClientRect().left + parseFloat(getComputedStyle(body).paddingInlineStart),
              nudge: (function(){
                var probe = document.createElement("span");
                probe.style.display = "block";
                probe.style.width = "var(--tugx-idialog-content-nudge)";
                dialog.appendChild(probe);
                var px = probe.getBoundingClientRect().width;
                probe.remove();
                return px;
              })(),
              register: box(register),
              summary: box(summary),
            };
          })()`,
        );
        note("at0756 sheet", JSON.stringify(reading));

        // ── The sheet rides the body slot, never the description ──────────
        expect(reading.descriptions).toBe(0);
        expect(reading.bodyAlign).toBe("start");
        expect(reading.pathText).toBe(SUBJECT_FILE);

        // ── The first path stands on the body slot's content edge ─────────
        // That edge is the primitive's: the title text's edge plus its optical
        // nudge. The path row adds no inset or gutter of its own, so it lands
        // there, and the sheet reads no dialog token to get there.
        expect(reading.titleLeft).toBeGreaterThan(0);
        expect(reading.nudge).toBeGreaterThan(0);
        expect(Math.abs(reading.pathLeft - reading.contentLeft)).toBeLessThanOrEqual(1);
        expect(Math.abs(reading.pathLeft - reading.titleLeft)).toBeLessThanOrEqual(reading.nudge + 1);

        // ── The register's trailing summary lies inside the register ──────
        expect(reading.register).not.toBeNull();
        expect(reading.summary).not.toBeNull();
        const reg = reading.register!;
        const sum = reading.summary!;
        expect(sum.left).toBeGreaterThanOrEqual(reg.left - 0.5);
        expect(sum.right).toBeLessThanOrEqual(reg.right + 0.5);
        expect(sum.top).toBeGreaterThanOrEqual(reg.top - 0.5);
        expect(sum.bottom).toBeLessThanOrEqual(reg.bottom + 0.5);
        note("at0756 blocker", (await app.screenshot()).path);

        // ── The fold is answered: Keep or Undo ────────────────────────────
        // The control can sit below the sheet's visible edge, and a native
        // click lands at the element's centre wherever that is — so bring it
        // into view, and record what is at that point, before pressing.
        note(
          "at0756 resolve-base target",
          await app.body("A").evalJS<string>(
            `(function(){
              var b = document.querySelector(${JSON.stringify(RESOLVE_BASE)});
              b.scrollIntoView({ block: "center" });
              var r = b.getBoundingClientRect();
              var x = r.left + r.width / 2, y = r.top + r.height / 2;
              var hit = document.elementFromPoint(x, y);
              return JSON.stringify({
                rect: [r.left, r.top, r.width, r.height],
                viewport: [innerWidth, innerHeight],
                hit: hit === null ? null : (hit.tagName + "." + (hit.className || "")),
                hitInside: hit !== null && b.contains(hit),
              });
            })()`,
          ),
        );
        await settle(200);
        const pressedAt = Date.now();
        await app.body("A").nativeClickAtElement(RESOLVE_BASE);
        const pressState = (): Promise<string> =>
          app.body("A").evalJS<string>(
            `JSON.stringify({
               button: (function(){
                 var b = document.querySelector(${JSON.stringify(RESOLVE_BASE)});
                 return b === null ? "gone" : (b.disabled ? "disabled" : "live");
               })(),
               folding: document.querySelector(${JSON.stringify(`${ROW} [data-slot="session-changes-arc-join-folding"]`)}) !== null,
               outcome: document.querySelector(${JSON.stringify(JOIN_FACE)})?.getAttribute("data-outcome") ?? null,
             })`,
          );
        await settle(300);
        note("at0756 just after press", await pressState());
        // The press ends one of three ways: the receipt, a refusal on screen,
        // or the blocker gone with no receipt. Waiting on all three, and
        // reading which one it was, is what lets a red here say why.
        try {
          await app.body("A").waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(RECEIPT)}) !== null
               || document.querySelector(${JSON.stringify(`${ROW} [data-slot="session-changes-arc-join-resolve-error"]`)}) !== null
               || document.querySelector(${JSON.stringify(BLOCKER)}) === null`,
            { timeoutMs: 40000 },
          );
        } finally {
          note("at0756 press settled after ms", String(Date.now() - pressedAt));
          note("at0756 press state", await pressState());
        }
        await settle(500);
        note(
          "at0756 after press",
          await app.body("A").evalJS<string>(
            `(document.querySelector(${JSON.stringify(JOIN_FACE)})?.textContent || "(no report section)")`,
          ),
        );
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(RECEIPT)}) !== null`,
          { timeoutMs: 8000 },
        );
        const receipt = await app.body("A").evalJS<{
          keep: boolean;
          undo: boolean;
          descriptions: number;
          bodyText: string;
          title: string;
        }>(
          `(function(){
            var root = document.querySelector(${JSON.stringify(RECEIPT)});
            var body = root.querySelector('[data-slot="tug-inline-dialog-body"]');
            var title = root.querySelector('.tug-inline-dialog-title');
            return {
              keep: document.querySelector(${JSON.stringify(KEEP)}) !== null,
              undo: document.querySelector(${JSON.stringify(UNDO)}) !== null,
              descriptions: root.querySelectorAll('.tug-inline-dialog-description').length,
              bodyText: body === null ? "" : (body.textContent || ""),
              title: title === null ? "" : (title.textContent || ""),
            };
          })()`,
        );
        note("at0756 receipt", JSON.stringify(receipt));
        expect(receipt.keep).toBe(true);
        expect(receipt.undo).toBe(true);
        expect(receipt.descriptions).toBe(0);
        expect(receipt.title).toContain(SUBJECT_FILE);
        expect(receipt.bodyText).toContain("Keep leaves the commit");
        note("at0756 receipt shot", (await app.screenshot()).path);

        await app.body("A").nativeClickAtElement(KEEP);
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(RECEIPT)}) === null`,
          { timeoutMs: 8000 },
        );
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
