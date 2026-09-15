/**
 * at0575-arc-document-delete.test.ts — a paperwork row can be deleted, behind
 * the card's confirm, and the delete destroys the documents and nothing else.
 *
 * ## Why this exists
 *
 * A `.tug/arcs/<name>/` outlives the arc that made it. A discard keeps the
 * documents on purpose — `arc run <name>` reopens on them — and a door
 * abandoned before it cut a branch leaves one too. Until now nothing could
 * remove either: `arc discard` refuses a name with no branch and no worktree,
 * and the Arcs card's paperwork row carried no verb at all. `rm -rf` was the
 * only remedy.
 *
 * This drives the remedy that replaced it, as one round trip against the real
 * app: the row wears a delete button beside its transport, the press arms the
 * card's one confirm rather than acting, the message says the brief is
 * destroyed permanently and is untracked so git will not give it back, and the
 * confirm removes the directory on disk while the arc beside it keeps its own.
 *
 * The delete is deliberately **not** a discard and does not route through one:
 * the frame is `changeset_delete_documents`, the op touches no branch, no
 * worktree and no arc-log record, and keeping the two apart is what stops the
 * destructive teardown path from acquiring a second meaning.
 *
 * The arcs live in a scratch repository this file owns — an arc is for
 * implementing a plan, not for running a test, so no fixture ever cuts one in
 * the checkout somebody is working in.
 *
 * @covers tugdeck/src/components/arcs/arcs-card.tsx
 * @covers tugdeck/src/components/arcs/arcs-card.css
 * @covers tugdeck/src/lib/changeset-verb-store.ts
 * @covers tugrust/crates/tugarc-core/src/ops.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { launchTugApp, note } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  arcBriefPath,
  arcTasksPath,
  makeArcScratchRepo,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  type ArcScratchRepo,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000575";
const SECTION = ".arcs-section";

/** The ghost: documents, no branch — the row this verb exists for. */
const ARC_NAME = "at0575-ghost";
/** Its neighbour, which the delete must leave entirely alone. */
const KEEPER = "at0575-keeper";

const rowFor = (arc: string): string =>
  `${SECTION} [data-slot="arc-document-row"][data-arc="${arc}"]`;
const ROW = rowFor(ARC_NAME);
const DELETE = `${ROW} [data-slot="arc-document-delete"]`;
const CONFIRM = '[data-slot="tug-confirm-popover"]';
const CONFIRM_MESSAGE = '[data-slot="tug-confirm-message"]';
const CONFIRM_BUTTON = '[data-slot="tug-confirm-confirm"]';

/**
 * Where an arc's documents live, **read rather than ensured**: the fixture's
 * `arcDocumentsDir` creates the directory it names, so a probe that asked it
 * would re-make the very directory the delete had just removed and read the
 * verb as having done nothing.
 */
const documentsDir = (arc: string): string =>
  join(projectDir(), ".tug", "arcs", arc);

/** This checkout — the build under test, and never the tree an arc is cut in. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
let scratch: ArcScratchRepo | null = null;
let fixtureDir = "";
const projectDir = (): string => scratch?.repo ?? "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({ prefix: "at0575", checkout: CHECKOUT });
  // Written after the repo's first commit and never through its `files` map:
  // `.tug/` is not tracked, and a committed brief would be a world that does
  // not exist — which is also exactly why the delete is unrecoverable.
  writeFileSync(
    arcBriefPath(projectDir(), ARC_NAME),
    "# A ghost\n\nThe brief a discard left standing.\n",
  );
  writeFileSync(
    arcTasksPath(projectDir(), ARC_NAME),
    "# Tasks\n\nSteps nobody will walk.\n",
  );
  writeFileSync(
    arcBriefPath(projectDir(), KEEPER),
    "# A keeper\n\nProse that must survive the delete beside it.\n",
  );
  fixtureDir = seedScratchSession(projectDir(), SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmArcScratchRepo(scratch);
  rmScratchSession(fixtureDir);
});

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 680 },
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

/** Poll a disk fact the app has no view of, until it settles or time runs out. */
async function pollUntil<T>(
  probe: () => T,
  settled: (value: T) => boolean,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = probe();
  while (!settled(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    last = probe();
  }
  return last;
}

describe.skipIf(!SHOULD_RUN)("AT0575: deleting a paperwork row's documents", () => {
  test(
    "the confirm says what it destroys, and the delete takes the documents and nothing else",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0575-arc-document-delete",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        // Spawning registers the scratch repo as a workspace, which is what
        // puts its arcs on the account-global aggregate the card reads.
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 30_000 });

        await app.dispatchControlAction("toggle-arcs");
        await app.evalJS<null>(`(window.__tug.activateCard("A"), null)`);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(ROW)}) !== null
             && document.querySelector(${JSON.stringify(rowFor(KEEPER))}) !== null`,
          { timeoutMs: 30_000 },
        );

        // ── The row wears a delete beside its transport ───────────────────
        const trailing = await app.evalJS<string>(
          `(() => {
             const row = document.querySelector(${JSON.stringify(ROW)});
             const del = row.querySelector('[data-slot="arc-document-delete"]');
             return JSON.stringify({
               transports: row.querySelectorAll('[data-slot="arc-transport"]').length,
               label: del === null ? null : del.getAttribute("aria-label"),
             });
           })()`,
        );
        note("at0575 the document row's trailing", trailing);
        const controls = JSON.parse(trailing) as {
          transports: number;
          label: string | null;
        };
        expect(controls.transports).toBe(1);
        expect(controls.label).toBe(`Delete the documents for arc ${ARC_NAME}`);

        // ── The press arms the confirm; it does not delete ────────────────
        await app.nativeClickAtElement(DELETE);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CONFIRM)}) !== null`,
          { timeoutMs: 30_000 },
        );
        const asked = await app.evalJS<string>(
          `(() => {
             const box = document.querySelector(${JSON.stringify(CONFIRM)});
             return JSON.stringify({
               message: box.querySelector(${JSON.stringify(CONFIRM_MESSAGE)}).textContent,
               confirmLabel: box.querySelector(${JSON.stringify(CONFIRM_BUTTON)}).textContent,
             });
           })()`,
        );
        note("at0575 the confirm", asked);
        const question = JSON.parse(asked) as {
          message: string;
          confirmLabel: string;
        };
        expect(question.confirmLabel).toBe("Delete");
        expect(question.message).toContain(ARC_NAME);
        // The sentence that earns the confirm: `.tug/` is untracked, so there
        // is no commit and no reflog to restore the brief from.
        expect(question.message).toContain("permanently");
        expect(question.message).toContain("git will not give them back");
        // Armed is not done.
        expect(existsSync(documentsDir(ARC_NAME))).toBe(true);

        // ── The confirm destroys the documents, and only those ────────────
        await app.nativeClickAtElement(CONFIRM_BUTTON);
        const gone = await pollUntil(
          () => existsSync(documentsDir(ARC_NAME)),
          (there) => !there,
        );
        note("at0575 documents after the confirm", String(gone));
        expect(gone).toBe(false);
        expect(existsSync(documentsDir(KEEPER))).toBe(true);

        // ── And the row leaves the card, off the recompute ────────────────
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(ROW)}) === null
             && document.querySelector(${JSON.stringify(rowFor(KEEPER))}) !== null`,
          { timeoutMs: 30_000 },
        );
        note("at0575 the card after the delete", (await app.screenshot()).path);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
