/**
 * at0596-commit-atom-opens-card.test.ts — a plain click on a commit atom shows
 * the commit's card.
 *
 * ## What this gates
 *
 * The user's rule, on both kinds of atom, in one live session bound to this
 * repository:
 *
 *   1. A commit MENTION in transcript prose — an annotator-resolved run — takes
 *      the registry's primary click, which now names the commit's card rather
 *      than the diff. The Diff card is what it used to open, so the assertion
 *      is that a `commit` card mounts and no `diff` card does: a test that only
 *      counted commit cards would pass with both open.
 *   2. A PLACED pill — the one in a History row — answers a click too, and the
 *      row underneath it does NOT fold. Placed pills used to swallow every
 *      pointer gesture, and a click that both raised the card and toggled the
 *      row would be the pill and its host answering one press.
 *   3. A second click on the same commit raises no second card: the open index
 *      matches the eight characters prose wrote against the forty the card
 *      holds.
 *
 * Both clicks go through the harness's full pointerdown → mouseup → click
 * sequence on the pill itself, so what is tested is the handler chain the app
 * really runs and not a dispatch the test made up. The sha is this repo's
 * HEAD, which the app's git feed can confirm.
 *
 * @covers tugdeck/src/lib/annotator/registry.ts
 * @covers tugdeck/src/lib/open-commit-in-card.ts
 * @covers tugdeck/src/lib/commit-card-open-registry.ts
 * @covers tugdeck/src/components/tugways/commit-sha-text.tsx
 * @covers tugdeck/src/components/tugways/use-annotation-menu.tsx
 * @covers tugdeck/src/components/tugways/commit-identity-menu.tsx
 * @covers tugdeck/src/action-dispatch.ts
 * @covers tugdeck/src/components/tugways/action-vocabulary.ts
 */

import { describe, expect, test } from "bun:test";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const CODE_OUTPUT_FEED = 0x40; // FeedId.CODE_OUTPUT
const SID = "test-session-S";

/** The worktree root — the real repo tugcast serves as its bootstrap tree. */
const REPO = resolve(import.meta.dir, "..", "..");

const HEAD_SHA = execSync("git rev-parse HEAD", { cwd: REPO }).toString().trim();
/** The short form prose uses — deliberately NOT the label's eight. */
const WRITTEN_SHA = HEAD_SHA.slice(0, 9);

const PILL = '[data-slot="tug-commit-atom"]';
const CARD = '[data-card-id="S"]';
const TRANSCRIPT = `${CARD} .session-card-transcript-code-body`;
const MENTION_PILL = `${TRANSCRIPT} [data-tug-annotation="commit-sha"] ${PILL}`;
const HISTORY_VIEW = '[data-slot="session-history-view"]';
const HISTORY_ROW = `${HISTORY_VIEW} [data-testid="session-history-commit"]`;
const HISTORY_PILL = `${HISTORY_ROW} ${PILL}`;
const COMMIT_CARD = '[data-slot="commit-card"]';

const SENTENCE = `Step 9 landed as \`${WRITTEN_SHA}\`.`;

/** Expression: count of deck cards with the given componentId. */
function countByComponent(componentId: string): string {
  return `window.tugdeck.diag.getDeckState().cards.filter(
    (c) => c.componentId === ${JSON.stringify(componentId)},
  ).length`;
}

function deckShape() {
  return {
    cards: [{ id: "S", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "pS",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 700 },
        cardIds: ["S"],
        activeCardId: "S",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "pS",
    hasFocus: true,
  };
}

const userMsg = (text: string) => ({
  type: "add_user_message",
  tug_session_id: SID,
  content: [{ type: "text", text }],
});
const asstText = (msgId: string, text: string) => ({
  type: "assistant_text",
  tug_session_id: SID,
  msg_id: msgId,
  text,
  is_partial: false,
  rev: 0,
  seq: 1,
});
const turnDone = (msgId: string) => ({
  type: "turn_complete",
  tug_session_id: SID,
  msg_id: msgId,
  result: "success",
});
const replayStarted = () => ({ type: "replay_started", tug_session_id: SID });
const replayComplete = () => ({
  type: "replay_complete",
  tug_session_id: SID,
  count: 1,
  firstLoadedTurnIndex: 0,
  totalTurns: 1,
  hasOlder: false,
});

/** Seed the deck, bind the card to this repo, and get past the restore veil. */
async function openBoundCard(app: App): Promise<void> {
  const ingest = (decoded: unknown) =>
    app.driveSession("S", { op: "ingestFrame", feedId: CODE_OUTPUT_FEED, decoded });
  await app.waitForCondition<boolean>(`typeof window.__tug !== "undefined"`, {
    timeoutMs: 20_000,
  });
  await app.seedDeckState({ state: deckShape(), focusCardId: "S" });
  await app.waitForCondition<boolean>(
    `window.__tug.assertHostRootRegistered("S")`,
    { timeoutMs: 20_000 },
  );
  // The binding is what gives the annotator a commit root: this repository,
  // where the sha resolves.
  await app.bindSession("S", {
    tugSessionId: SID,
    projectDir: REPO,
    sessionMode: "resume",
  });
  await ingest(replayStarted());
  await ingest(userMsg("hello"));
  await ingest(asstText("m0", "Ready."));
  await ingest(turnDone("m0"));
  await ingest(replayComplete());
}

describe.skipIf(!SHOULD_RUN)("at0596 — a click on a commit atom opens its card", () => {
  test(
    "a prose mention and a placed History pill both raise the Commit card, and it is one card",
    async () => {
      const tugbankPath = mkTempTugbank();
      try {
        seedTugbankForLaunch(tugbankPath, { sourceTreePath: REPO });
        const app = await launchTugApp({
          testName: "at0596-commit-atom-opens-card",
          env: { TUGBANK_PATH: tugbankPath },
          persistInTestMode: true,
        });
        try {
          await openBoundCard(app);

          // ---- 1. A prose mention's primary click.
          await app.driveSession("S", { op: "send", text: "how did step 9 go" });
          await app.driveSession("S", {
            op: "ingestFrame",
            feedId: CODE_OUTPUT_FEED,
            decoded: asstText("m1", SENTENCE),
          });
          // The label is a round trip to the git feed, so it is waited for.
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(MENTION_PILL)}) !== null`,
            { timeoutMs: 20_000 },
          );

          await app.click(MENTION_PILL);
          await app.waitForCondition<boolean>(
            `${countByComponent("commit")} === 1`,
            { timeoutMs: 15_000 },
          );
          // The click used to open a DIFF. That is the decision this changes,
          // so the absence is the assertion that matters.
          expect(await app.evalJS<number>(countByComponent("diff"))).toBe(0);

          const masthead = await app.evalJS<string | null>(
            `(() => {
               const card = document.querySelector(${JSON.stringify(COMMIT_CARD)});
               const pane = card === null ? null : card.closest(".tug-pane");
               const el = pane === null
                 ? null
                 : pane.querySelector('[data-testid="commit-masthead"]');
               return el === null ? null : el.innerText.replace(/\\s+/g, " ").trim();
             })()`,
          );
          note("at0596 card raised from prose", JSON.stringify(masthead));
          expect(masthead).toContain(HEAD_SHA.slice(0, 8));

          // ---- 2. The same commit again raises no second card.
          //
          // Prose wrote nine characters and the card holds forty; the open
          // index matches on either being a prefix of the other.
          await app.click(MENTION_PILL);
          expect(await app.evalJS<number>(countByComponent("commit"))).toBe(1);

          // ---- 3. A PLACED pill answers a click, and its row does not fold.
          //
          // The commit card the clicks just raised is the active one now, and
          // the History shade belongs to the Session card — so the session's
          // pane is activated first, by a click on its own title bar.
          await app.click('[data-pane-id="pS"] .tug-pane-title-bar');
          await app.dispatchControlAction("toggle-history-view");
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(HISTORY_ROW)}).length > 0`,
            { timeoutMs: 20_000 },
          );
          const foldedBefore = await app.evalJS<number>(
            `document.querySelectorAll('${HISTORY_VIEW} .tugx-commit-detail').length`,
          );
          await app.click(HISTORY_PILL);
          // The History shade's newest row is this repo's HEAD, the commit the
          // card is already showing — so the count holding at one is both the
          // placed pill's click working and the reuse holding.
          expect(await app.evalJS<number>(countByComponent("commit"))).toBe(1);
          const foldedAfter = await app.evalJS<number>(
            `document.querySelectorAll('${HISTORY_VIEW} .tugx-commit-detail').length`,
          );
          note(
            "at0596 History fold",
            JSON.stringify({ foldedBefore, foldedAfter }),
          );
          expect(
            foldedAfter,
            "the pill's click is not also the row's fold",
          ).toBe(foldedBefore);
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
