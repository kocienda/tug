/**
 * at0804-style-census-landing-receipts.test.ts — the landing receipts' headers
 * and the repo notice look exactly as they did before their copies became one
 * component each.
 *
 * The commit, push, join and discard receipts each wrote the same identity
 * line from their own CSS (a block that takes the receipt's prose face, and a
 * code run inside it that takes the line's face rather than the code one);
 * those now live in `receipt-header.css`. The no-git and non-repo notices were
 * two files differing by one rule; they are now one `RepoNotice` with a
 * `kind`. The one claim worth pinning is that nothing a user can see moved.
 * This file appends one settled exchange of each landing verb to a bound
 * transcript, reads a fixed property list off each receipt's header, raises
 * the no-git notice in the Changes shade, reads it too, and compares the lot
 * with the baseline recorded before the CSS moved
 * (`style-census/landing-receipts.json`; `TUG_STYLE_CENSUS_RECORD=1` rewrites
 * it).
 *
 * The receipts are a family of their own rather than riding
 * `receipts-and-notices`: that file already spends its time budget on the
 * usage notice, the Cards badges and an Overview post.
 *
 * @covers tests/app-test/_harness/style-census.ts
 * @covers tugdeck/src/components/tugways/cards/receipt-header.tsx
 * @covers tugdeck/src/components/tugways/cards/receipt-header.css
 * @covers tugdeck/src/components/tugways/cards/session-commit-receipt-block.tsx
 * @covers tugdeck/src/components/tugways/cards/session-commit-receipt-block.css
 * @covers tugdeck/src/components/tugways/cards/session-push-receipt-block.tsx
 * @covers tugdeck/src/components/tugways/cards/session-push-receipt-block.css
 * @covers tugdeck/src/components/tugways/cards/session-join-receipt-block.tsx
 * @covers tugdeck/src/components/tugways/cards/session-join-receipt-block.css
 * @covers tugdeck/src/components/tugways/cards/repo-notice.tsx
 * @covers tugdeck/src/components/tugways/cards/repo-notice.css
 */

import { describe, test } from "bun:test";
import { resolve } from "node:path";

import { launchTugApp, type App } from "./_harness";
import { censusRead, expectCensus, type CensusEntry, type CensusReading } from "./_harness/style-census";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;
const CODE_OUTPUT_FEED = 0x40;
const SID = "at0804-session";
const REPO = resolve(import.meta.dir, "..", "..");
const SHA = "0123456789abcdef0123456789abcdef01234567";

const CARD = '[data-card-id="S"]';
const EDITOR = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const NO_GIT = '[data-testid="tug-no-git-notice"]';

const exists = (sel: string): string =>
  `document.querySelector(${JSON.stringify(sel)}) !== null`;

const RECEIPTS: Array<{ id: string; command: string; output: string; header: string; text: string }> = [
  {
    id: "at0804-commit",
    command: "/commit",
    output:
      `committed ${SHA} · 1 file(s) · +3 −1\n` +
      `files: [{"path":"tugdeck/src/lib/commit-format.ts","status":"modified","added":3,"removed":1}]\n` +
      "Land the census",
    header: '[data-slot="commit-receipt-block"] .commit-receipt-header',
    text: ".commit-receipt-summary",
  },
  {
    id: "at0804-push",
    command: "/push",
    output: `pushed main → origin/main · 1 commit(s) · 1111111..${SHA.slice(0, 7)}\nLand the census`,
    header: '[data-slot="push-receipt-block"] .push-receipt-header',
    text: ".push-receipt-route",
  },
  {
    id: "at0804-join",
    command: "/arc-join",
    output: `joined ${SHA} · census → main · 2 round(s)\nJoin the census`,
    header: '[data-slot="join-receipt-block"] .commit-receipt-header',
    text: ".commit-receipt-summary",
  },
  {
    id: "at0804-discard",
    command: "/arc-discard",
    output: "discarded census · 2 round(s)\nLand the census",
    header: '[data-slot="discard-receipt-block"] .join-receipt-header',
    text: ".join-receipt-summary",
  },
];

function deckShape(): Record<string, unknown> {
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

/** Bind the card and get past the restore veil with one committed turn. */
async function openBoundCard(app: App): Promise<void> {
  const ingest = (decoded: Record<string, unknown>) =>
    app.driveSession("S", {
      op: "ingestFrame",
      feedId: CODE_OUTPUT_FEED,
      decoded: { tug_session_id: SID, ...decoded },
    });
  await app.waitForCondition<boolean>(`typeof window.__tug !== "undefined"`, { timeoutMs: 20_000 });
  await app.seedDeckState({ state: deckShape(), focusCardId: "S" });
  await app.waitForCondition<boolean>(`window.__tug.assertHostRootRegistered("S")`, { timeoutMs: 20_000 });
  await app.bindSession("S", { tugSessionId: SID, projectDir: REPO, sessionMode: "resume" });
  await ingest({ type: "replay_started" });
  await ingest({ type: "add_user_message", content: [{ type: "text", text: "hello" }] });
  await ingest({ type: "assistant_text", status: "complete", msg_id: "m0", text: "Ready.", is_partial: false, rev: 0, seq: 1 });
  await ingest({ type: "turn_complete", seq: 0, msg_id: "m0", result: "success" });
  await ingest({
    type: "replay_complete",
    count: 1,
    firstLoadedTurnIndex: 0,
    totalTurns: 1,
    hasOlder: false,
  });
}

describe.skipIf(!SHOULD_RUN)("at0804 — style census: landing receipts", () => {
  test(
    "the four landing receipts' headers and the no-git notice match their recording",
    async () => {
      const app = await launchTugApp({ testName: "at0804-style-census-landing-receipts" });
      try {
        await openBoundCard(app);
        const body = app.body("S");
        const reading: CensusReading = {};

        let start = 1_700_000_000_000;
        for (const receipt of RECEIPTS) {
          await app.driveSession("S", {
            op: "shellExchange",
            exchangeId: receipt.id,
            command: receipt.command,
            output: receipt.output,
            cwd: REPO,
            exitCode: 0,
            startedAtMs: (start += 1_000),
          });
        }
        await body.waitForCondition<boolean>(
          RECEIPTS.map((r) => exists(r.header)).join(" && "),
          { timeoutMs: 10_000 },
        );
        const entries: CensusEntry[] = RECEIPTS.flatMap((r) => [
          { selector: r.header },
          { selector: `${r.header} ${r.text}` },
        ]);
        Object.assign(reading, await censusRead(body, entries));

        // The no-git notice, raised in the Changes shade the way at0443 does.
        await body.waitForCondition<boolean>(exists(EDITOR), { timeoutMs: 10_000 });
        await body.nativeClickAtElement(EDITOR);
        await app.nativeKey("c", ["ctrl", "cmd"]);
        await body.waitForCondition<boolean>(exists('[data-slot="session-changes-view"]'), { timeoutMs: 10_000 });
        await body.evalJS<null>(
          `(window.__tug.dispatchControlAction("host_tools_result", ${JSON.stringify({
            gitVersion: null,
            gitPath: null,
            developerDir: null,
            gitFloor: "2.23",
            usable: false,
          })}), null)`,
        );
        await body.waitForCondition<boolean>(exists(NO_GIT), { timeoutMs: 8_000 });
        Object.assign(reading, await censusRead(body, [
          { selector: NO_GIT },
          { selector: `${NO_GIT} > :nth-child(1)` },
          { selector: `${NO_GIT} > :nth-child(1) > :nth-child(1)` },
          { selector: `${NO_GIT} > :nth-child(1) > :nth-child(1) > :nth-child(1)` },
          { selector: `${NO_GIT} > :nth-child(1) > :nth-child(1) > :nth-child(2)` },
          { selector: `${NO_GIT} > :nth-child(1) > :nth-child(2)` },
        ]));

        expectCensus("landing-receipts", reading);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
