/**
 * at0616-push-receipt.test.ts — `/push` end to end, against a real remote.
 *
 * A landing that never leaves the machine is half a landing, and this is the
 * other half driven for real: a scratch repository with a bare sibling as its
 * `origin`, one commit ahead of it, and the whole `/push` path from the typed
 * command to the receipt row and back out of the ledger on a reload.
 *
 * The remote is a bare repo on disk rather than a mock. A file-path remote is a
 * real remote to git — it negotiates, moves refs and reports through the same
 * porcelain — so what runs here is the push that ships, with nothing about the
 * network faked. The assertion that the *remote moved* is read with git, from
 * the bare repo, because a receipt saying a push happened is exactly the thing
 * a broken push would also say.
 *
 * Three things are pinned, and each one is a separate seam:
 *
 * - **The shade counts the push before it happens.** `ahead` has ridden the
 *   changeset feed all along with nothing reading it; the banner's `N ahead` is
 *   its first consumer, and the number has to be the real one.
 * - **The receipt is a receipt, not fenced output.** `/push` lands as a shell
 *   exchange whose `output` is the server-formatted summary (Spec S01), and the
 *   push receipt block claims it — so what appears is the parsed row rather
 *   than `ShellExchangeBlock`'s generic fence.
 * - **The badge spends itself.** A successful push bumps the aggregate, the
 *   next recompute reads `ahead: 0`, and the affordance goes without anybody
 *   dismissing it. A badge that survived its own push is the failure this
 *   assertion exists for.
 *
 * Then the reload: the receipt row is the shell ledger's, exempt from the
 * chatter cap, so it comes back. That is the same durability the `/commit`
 * receipt has, and the reason the push's summary is formatted server-side at
 * all — the live row and the restored one are the same bytes.
 *
 * The project is a scratch repository this file owns, registered as a workspace
 * by spawning a real session on it. Nothing here touches the checkout, and in
 * particular nothing here pushes anything anywhere real.
 *
 * @covers tugdeck/src/lib/changeset-verb-store.ts
 * @covers tugdeck/src/components/tugways/cards/use-landing-receipts.ts
 * @covers tugdeck/src/components/tugways/cards/session-push-receipt-block.tsx
 * @covers tugdeck/src/components/tugways/cards/session-push-receipt-block.css
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-view.tsx
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-view.css
 * @covers tugdeck/src/components/tugways/cards/session-commit-receipt-block.tsx
 * @covers tugdeck/src/lib/slash-commands.ts
 * @covers tugrust/crates/tugcast/src/feeds/changeset.rs
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor.rs
 * @covers tugrust/crates/tugcast/src/shell_ledger.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { launchTugApp, note } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  gitRetry,
  makeArcScratchRepo,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  type ArcScratchRepo,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000616";
const CARD = '[data-card-id="A"]';
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const USER_ROWS = `${CARD} [data-testid="session-card-transcript-user-body"]`;
const SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;

const AHEAD = `${SHEET} [data-testid="session-changes-ahead"]`;
const SHADE_PUSH = `${SHEET} [data-testid="session-changes-push"]`;
const RECEIPT = `${CARD} [data-testid="session-push-receipt"]`;
/** The composer's own submit — how a local slash command is run ([at0360]). */
const SUBMIT_BTN = `${CARD} .tug-prompt-entry-submit-button`;

/** This checkout — the build under test, and never the tree that gets pushed. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));
/** The scratch repository this fixture owns, and the only tree it touches. */
let scratch: ArcScratchRepo | null = null;
let fixtureDir = "";
/** The bare repo standing in for `origin`. */
let originDir = "";
/** HEAD after the one commit the push is expected to send. */
let expectedHead = "";
const projectDir = (): string => scratch?.repo ?? "";

const AHEAD_FILE = "at0616-ahead.txt";
const AHEAD_SUBJECT = "at0616: the one commit the push sends";

/** Read a ref out of the bare origin — the ground truth a receipt cannot fake. */
function originRef(ref: string): string {
  return execFileSync("git", ["-C", originDir, "rev-parse", ref], {
    encoding: "utf8",
  }).trim();
}

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({ prefix: "at0616", checkout: CHECKOUT });
  const repo = projectDir();

  // The bare sibling, wired up as `origin`, with `main` already on it — so the
  // branch has an upstream and the push under test is an ordinary ahead-by-one
  // push rather than a `--set-upstream` first push.
  originDir = realpathSync(scratch.dataRoot);
  originDir = join(originDir, "origin.git");
  mkdirSync(originDir, { recursive: true });
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", originDir]);
  gitRetry(repo, "remote", "add", "origin", originDir);
  gitRetry(repo, "push", "-q", "-u", "origin", "main");

  // One commit ahead. This is the whole of what the push should move, and the
  // number the shade's badge should read.
  writeFileSync(join(repo, AHEAD_FILE), "at0616 ahead\n");
  gitRetry(repo, "add", "-A");
  gitRetry(repo, "commit", "-m", AHEAD_SUBJECT);
  expectedHead = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();

  fixtureDir = seedScratchSession(repo, SID);
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

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!SHOULD_RUN)("AT0616: /push leaves a durable receipt", () => {
  test(
    "the shade counts the push, the verb moves the remote, and the receipt survives a reload",
    async () => {
      const tugbankPath = mkTempTugbank();
      try {
        seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
        const app = await launchTugApp({
          testName: "at0616-push-receipt",
          env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
        });
        try {
          await app.enableDeckTrace(true);
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          );
          // A *spawned* session, not a bound one: spawning registers the scratch
          // repo as a workspace, so its changeset — and its `ahead` — reach the
          // aggregate the shade reads.
          await app.spawnSessionResume("A", {
            tugSessionId: SID,
            projectDir: projectDir(),
          });
          await app.awaitEngineReady("A", { timeoutMs: 15000 });
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(USER_ROWS)}).length === 1`,
            { timeoutMs: 8000 },
          );

          // ── The shade counts the push before it happens ──────────────────
          await app.nativeClickAtElement(PROMPT_INPUT);
          await app.nativeType("/commit");
          await settle();
          await app.nativeKey("Escape"); // dismiss the completion popup
          await settle();
          await app.nativeKey("Return", ["cmd"]);
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
            { timeoutMs: 8000 },
          );

          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(AHEAD)}) !== null`,
            { timeoutMs: 10000 },
          );
          const aheadText = await app.evalJS<string>(
            `(document.querySelector(${JSON.stringify(AHEAD)})?.textContent ?? "").trim()`,
          );
          note(`shade ahead badge: ${aheadText}`);
          expect(aheadText).toBe("1 ahead");
          // The badge and its Push travel together — a count with no act beside
          // it is a number the reader can do nothing about.
          expect(
            await app.evalJS<boolean>(
              `document.querySelector(${JSON.stringify(SHADE_PUSH)}) !== null`,
            ),
          ).toBe(true);

          // The remote has not moved yet, which is what makes the assertion
          // after the push mean something.
          expect(originRef("main")).not.toBe(expectedHead);

          // ── Push ─────────────────────────────────────────────────────────
          await app.nativeKey("Escape"); // leave the shade for the composer
          await settle();
          await app.nativeClickAtElement(PROMPT_INPUT);
          await app.nativeType("/push");
          await settle();
          await app.nativeClickAtElement(SUBMIT_BTN);

          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(RECEIPT)}) !== null`,
            { timeoutMs: 30000 },
          );
          const receiptText = await app.evalJS<string>(
            `(document.querySelector(${JSON.stringify(RECEIPT)})?.textContent ?? "")`,
          );
          note(`push receipt: ${receiptText.slice(0, 200)}`);
          // The parsed receipt, not the generic fence: the block's own words.
          expect(receiptText).toContain("pushed");
          expect(receiptText).toContain("origin/main");
          // The subject that went — the receipt's own list, from the summary.
          expect(receiptText).toContain(AHEAD_SUBJECT);

          // ── The remote really moved ──────────────────────────────────────
          expect(originRef("main")).toBe(expectedHead);

          // ── The badge spends itself ──────────────────────────────────────
          // The push bumped the aggregate; the next recompute reads `ahead: 0`
          // and the affordance goes without anybody dismissing it.
          await app.nativeClickAtElement(PROMPT_INPUT);
          await app.nativeType("/commit");
          await settle();
          await app.nativeKey("Escape");
          await settle();
          await app.nativeKey("Return", ["cmd"]);
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
            { timeoutMs: 8000 },
          );
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(AHEAD)}) === null`,
            { timeoutMs: 15000 },
          );
          expect(
            await app.evalJS<boolean>(
              `document.querySelector(${JSON.stringify(SHADE_PUSH)}) === null`,
            ),
          ).toBe(true);
          await app.nativeKey("Escape");
          await settle();

          // ── The receipt is the ledger's, so a reload brings it back ──────
          await app.appReload();
          // A reload drops the seeded deck and the resumed session with it, so
          // both are re-established before the ledger's row is looked for —
          // the restore is what is under test, not the re-seat ([at0461]).
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 20000 },
          );
          await app.spawnSessionResume("A", {
            tugSessionId: SID,
            projectDir: projectDir(),
          });
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(RECEIPT)}) !== null`,
            { timeoutMs: 30000 },
          );
          const restored = await app.evalJS<string>(
            `(document.querySelector(${JSON.stringify(RECEIPT)})?.textContent ?? "")`,
          );
          // The same bytes, because the summary is formatted server-side once
          // and both the live append and the restore ingest it verbatim.
          expect(restored).toContain("pushed");
          expect(restored).toContain(AHEAD_SUBJECT);
        } finally {
          await app.close();
        }
      } finally {
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
