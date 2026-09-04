/**
 * at0513-atom-surfaces-one-height.test.ts — one pill height, on five live
 * surfaces at once.
 *
 * The regression this pins is the whole of the arc it was written for ([F06]).
 * An identity atom was 22px tall on the arc receipt and 24px on three other
 * surfaces that show the same arc, because the box was a value each call site
 * chose rather than a fact about the mark: a `register` prop on the pill, a
 * `size` dial on the arc block, and a receipt that composed its own header out
 * of the parts instead of wearing the block. The user's own reading of it was
 * a 22 beside a 24 — the masthead's arc placard and a citation in the
 * transcript, two surfaces one glance apart, disagreeing by two pixels about a
 * mark that is the same mark.
 *
 * A unit test cannot hold that. Every one of those numbers was internally
 * consistent: the module agreed with itself, the stylesheet agreed with
 * itself, and the defect lived entirely in the *seam* — which surface asked
 * for which number. So the assertion has to be `getBoundingClientRect` on the
 * real elements, on every surface at once, in one running app.
 *
 * ## The five surfaces, and why each one
 *
 *   1. **The Arcs card's block** — the every-arc surface, and the one whose
 *      block carries two pills at once (the arc and its bound worker), so a
 *      skin that sized them differently shows up inside one row.
 *   2. **The ARC placard** — the masthead's, one of the two the user's report
 *      named. It heads with the same block on a popover rather than in a list.
 *   3. **The Changes shade's arc lane** — the same block again, in a sheet,
 *      where the surrounding type is the shade's rather than the rail's.
 *   4. **The arc receipt in the transcript** — the surface that was WRONG.
 *      It composed an arc atom and a lifecycle line by hand; it wears the
 *      block now, and this is what holds it there.
 *   5. **A citation standing in rendered prose** — the other half of the
 *      user's pair, and the one surface here that no arc block encloses. It is
 *      what keeps the guard from being a test about the arc block alone. It is
 *      an Overview post's rendered body, the way `at0368` puts a citation in
 *      prose, and the sentence names the card's own session by its uuid — the
 *      other of the two spellings `detect-session-ref` scans for, and the one
 *      that carries no project half. The `project/callsign` spelling is not
 *      usable here: `mkdtemp` gives the scratch repo an uppercase suffix, and
 *      the pair grammar's project half is lowercase, so the handle would never
 *      be a candidate. The uuid needs no such evidence and the ledger — where
 *      the spawn below put this session — is what confirms it.
 *
 * The declared number is never written down in this file. It is read off the
 * gallery's own published `--tugx-atom-height` before the deck is seeded (the
 * order `at0512` uses — seeding replaces the gallery), so a table that moved
 * moves this test with it and a table that fragmented fails it.
 *
 * @covers tugdeck/src/lib/atom-register.ts
 * @covers tugdeck/src/components/tugways/tug-session-identity.css
 * @covers tugdeck/src/components/tugways/tug-session-identity.tsx
 * @covers tugdeck/src/components/tugways/arc-lifecycle-block.tsx
 * @covers tugdeck/src/components/tugways/arc-lifecycle-block.css
 * @covers tugdeck/src/components/tugways/cards/session-arc-receipt-block.tsx
 * @covers tugdeck/src/components/tugways/tug-arc-atom.tsx
 * @covers tugdeck/src/components/tugways/arc-sigil.tsx
 * @covers tugdeck/src/components/tugways/tug-commit-atom.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  createArc,
  makeArcScratchRepo,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  shellAndSettle,
  tugtoolPath,
  type ArcScratchRepo,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000513";
const ARC_NAME = "at0513-heights";

const CARD = '[data-card-id="A"]';
const PROMPT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;

/**
 * The pill, by the class the skin's own rule is keyed on.
 *
 * NOT `[data-slot="tug-session-identity"]`: no arc surface answers to it.
 * `ArcSigil`'s wrapper carries no `data-slot` at all (the caller's slot rides
 * the run inside), `TugCommitAtom` wears its own, and `TugSessionIdentity`
 * spreads `{...rest}` after its slot, so a worker atom's slot overrides it.
 * The class is what every one of them shares, and it is what the pill's rule
 * in `tug-session-identity.css` selects.
 */
const PILL = '.tug-session-identity[data-tier="chip"]';

/** The gallery row that publishes the register's numbers. */
const GALLERY_HOST = '[data-testid="gallery-atom"] .gallery-atom-register .gallery-atom-row';

/** The Arcs card's block for this arc. */
const ARCS_BLOCK = `.arcs-section [data-slot="tug-arc-lifecycle-block"][data-arc="${ARC_NAME}"]`;
/** The Z2 work cell, and the placard its press opens. */
const CELL = `${CARD} [data-slot="tug-status-cell"][data-priority="tasks"]`;
const PLACARD_HEAD = '[data-slot="session-arc-popover-body"] .session-arc-popover-head';
/** The Changes shade, and the arc lane's row inside it. */
const SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;
const SHADE_ROW = `${SHEET} [data-slot="session-changes-arc-lane"] [data-slot="session-changes-arc-row"][data-arc="${ARC_NAME}"]`;
/** The arc receipt's own block, which it wears rather than composes. */
const RECEIPT_BLOCK = `${CARD} [data-slot="arc-receipt-block"] [data-slot="tug-arc-lifecycle-block"]`;
/** The resolved citation in the live transcript, as `at0368` selects one. */
const CITATION_RUN =
  '[data-testid="overview-card"] .overview-post-body [data-tug-annotation="session"]';

/** This checkout — the build under test, never the tree a fixture writes in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

let scratch: ArcScratchRepo | null = null;
let fixtureDir = "";
let tugbankPath = "";
const projectDir = (): string => scratch?.repo ?? "";

const settle = (ms = 200): Promise<unknown> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * A stop receipt in the server's own shape — the string
 * `format_arc_stop_receipt` writes, plus one stage line the parser's
 * `STAGE_RE` accepts. Written as the server writes it so the renderer under
 * test is the production one rather than a shape invented here.
 */
const RECEIPT = [
  `arc stopped · ${ARC_NAME} · in implement — you stopped it`,
  `implement · account default · ${SID}`,
].join("\n");

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({ prefix: "at0513", checkout: CHECKOUT });
  createArc(projectDir(), ARC_NAME, "at0513 fixture", scratch.cli);
  fixtureDir = seedScratchSession(projectDir(), SID);
  tugbankPath = mkTempTugbank();
  seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmArcScratchRepo(scratch);
  rmScratchSession(fixtureDir);
  if (tugbankPath !== "") rmTempTugbank(tugbankPath);
});

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 1100, height: 760 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

/**
 * Every pill on a surface, measured.
 *
 * `within` is a surface selector; `ancestor` says whether the anchor slot sits
 * on the pill or inside it. The arc block's name slot rides the run *inside*
 * the pill, so reaching it is `.closest()` — a descendant query would find
 * nothing and the wait would time out rather than measure.
 */
function heightsJS(within: string, ancestor: string | null): string {
  const find =
    ancestor === null
      ? `Array.from(host.querySelectorAll(${JSON.stringify(PILL)}))`
      : `Array.from(host.querySelectorAll(${JSON.stringify(ancestor)}))
           .map(function (n) { return n.closest(${JSON.stringify(PILL)}); })
           .filter(function (n) { return n !== null; })`;
  return `(function () {
    var host = document.querySelector(${JSON.stringify(within)});
    if (host === null) return [];
    var pills = ${find};
    return pills.map(function (p) {
      return Math.round(p.getBoundingClientRect().height);
    }).filter(function (h) { return h > 0; });
  })()`;
}

/** Wait until a surface has at least one laid-out pill, then measure them. */
async function measure(
  app: App,
  surface: string,
  within: string,
  ancestor: string | null = null,
): Promise<number[]> {
  const js = heightsJS(within, ancestor);
  await app.waitForCondition<boolean>(`${js}.length > 0`, { timeoutMs: 30_000 });
  const heights = await app.evalJS<number[]>(js);
  note(`at0513 ${surface}`, JSON.stringify({ surface, heights }));
  note(`at0513 ${surface}`, (await app.screenshot()).path);
  return heights;
}

describe.skipIf(!SHOULD_RUN)("AT0513: one pill height, on every surface", () => {
  test(
    "the identity atom measures the register's box wherever it stands",
    async () => {
      const app = await launchTugApp({
        testName: "at0513-atom-surfaces-one-height",
        env: {
          TUGBANK_PATH: tugbankPath,
          TUG_DATA_DIR: scratch?.dataRoot ?? "",
        },
        persistInTestMode: true,
      });
      try {
        // ── The declared number, off the gallery, before anything else ─────
        // Seeding the deck replaces the gallery, so this reading has to come
        // first. Reading it rather than writing it down is what makes this a
        // test about agreement rather than a second copy of the table.
        await app.waitForCondition<boolean>(
          `typeof window.__tug !== "undefined"`,
          { timeoutMs: 20_000 },
        );
        await app.dispatchControlAction("show-card", { component: "gallery-atom" });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(GALLERY_HOST)}) !== null`,
          { timeoutMs: 20_000 },
        );
        const declared = await app.evalJS<number>(
          `parseFloat(getComputedStyle(document.querySelector(${JSON.stringify(GALLERY_HOST)}))
             .getPropertyValue("--tugx-atom-height"))`,
        );
        note("at0513 declared height", JSON.stringify({ declared }));
        expect(Number.isFinite(declared), "the gallery publishes a height").toBe(
          true,
        );

        // ── A real arc, on a real session, on a scratch repo ───────────────
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        // Spawning is what registers the scratch repo as a workspace, which is
        // what puts its arc on the aggregate at all.
        await app.spawnSessionResume("A", {
          tugSessionId: SID,
          projectDir: projectDir(),
        });
        await app.awaitEngineReady("A", { timeoutMs: 15_000 });
        await shellAndSettle(app, `${tugtoolPath(CHECKOUT)} arc bind ${ARC_NAME}`, 0);

        // ── 1. The Arcs card's block ───────────────────────────────────────
        await app.dispatchControlAction("toggle-arcs");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(ARCS_BLOCK)}) !== null`,
          { timeoutMs: 30_000 },
        );
        const arcsCard = [
          // The arc's own pill — the name slot rides the run inside it.
          ...(await measure(app, "arcs-card-arc", ARCS_BLOCK, '[data-slot="tug-arc-lifecycle-name"]')),
          // And the bound worker's, where the slot IS the pill.
          ...(await measure(app, "arcs-card-worker", ARCS_BLOCK, null)),
        ];

        // ── 2. The ARC placard ─────────────────────────────────────────────
        await app.click(CELL);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PLACARD_HEAD)}) !== null`,
          { timeoutMs: 20_000 },
        );
        const placard = await measure(app, "arc-placard", PLACARD_HEAD, null);
        await app.nativeKey("Escape");
        await settle(400);

        // ── 3. The Changes shade's arc lane ────────────────────────────────
        await app.nativeClickAtElement(PROMPT);
        await app.nativeType("/commit");
        await settle();
        await app.nativeKey("Escape");
        await settle();
        await app.nativeKey("Return", ["cmd"]);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
          { timeoutMs: 20_000 },
        );
        const shade = await measure(app, "changes-shade", SHADE_ROW, null);

        // ── 4. The arc receipt in the transcript ───────────────────────────
        await app.driveSession("A", {
          op: "shellExchange",
          exchangeId: "at0513-arc",
          command: "/arc-run",
          output: RECEIPT,
          cwd: projectDir(),
          exitCode: 0,
          startedAtMs: 1_700_000_000_000,
        });
        const receipt = await measure(
          app,
          "arc-receipt",
          RECEIPT_BLOCK,
          '[data-slot="tug-arc-lifecycle-name"]',
        );

        // ── 5. A citation standing in rendered prose ───────────────────────
        // A ref is what makes the card acquire the post's workspace, and the
        // workspace is what mounts the annotation context its prose resolves
        // against — without one the sentence has nothing to resolve in
        // (`at0368`'s finding). The session verdict itself comes off the
        // instance ledger, where the spawn above put this session.
        const post = {
          id: 9513,
          at_ms: 1_754_600_000_000,
          author: "observer",
          body: `The work is on ${SID}, which is the card this row is about.`,
          refs: [{ kind: "file", target: "README.md" }],
          project_dir: projectDir(),
        };
        expect(
          await app.evalJS<boolean>(
            `window.__tug.publishOverviewPost(${JSON.stringify(JSON.stringify(post))})`,
          ),
          "the Overview took the post",
        ).toBe(true);
        await app.nativeKey("o", ["cmd", "ctrl"]);
        // What the Overview actually holds, before the measurement waits on
        // the mark: a citation that never resolved and a card that never
        // opened both end as one timeout otherwise, and they are different
        // faults.
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-testid="overview-card"]') !== null`,
          { timeoutMs: 20_000 },
        );
        await settle(2000);
        note(
          "at0513 overview",
          await app.evalJS<string>(
            `JSON.stringify((function () {
               var bodies = Array.from(document.querySelectorAll(
                 '[data-testid="overview-card"] .overview-post-body'));
               return {
                 bodies: bodies.length,
                 text: bodies.map(function (b) { return (b.textContent || "").trim(); }),
                 annotations: bodies.map(function (b) {
                   return Array.from(b.querySelectorAll("[data-tug-annotation]"))
                     .map(function (n) { return n.getAttribute("data-tug-annotation"); });
                 }),
                 pills: document.querySelectorAll(
                   '[data-testid="overview-card"] .tug-session-identity').length,
               };
             })())`,
          ),
        );
        const citation = await measure(app, "citation", CITATION_RUN, null);

        // ── One number, five surfaces ──────────────────────────────────────
        const measured = {
          declared,
          arcsCard,
          placard,
          shade,
          receipt,
          citation,
        };
        note("at0513 every surface", JSON.stringify(measured));

        // Every surface produced something to measure. Without this a surface
        // that stopped rendering its pill would pass by measuring nothing.
        for (const [surface, heights] of Object.entries({
          arcsCard,
          placard,
          shade,
          receipt,
          citation,
        })) {
          expect(
            heights.length,
            `${surface} has at least one pill to measure`,
          ).toBeGreaterThan(0);
          for (const height of heights) {
            expect(
              height,
              `${surface}'s pill is the register's declared box`,
            ).toBe(declared);
          }
        }
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
