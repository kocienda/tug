/**
 * at0419-join-receipt.test.ts — a landed join and a discarded dash render as
 * receipts, not as raw shell output ([P06]).
 *
 * The server formats both summaries (Specs S01 / S02), writes them to the
 * shell ledger, and returns them on the `_ok`; the deck appends the same
 * string as transcript ink and parses it back out for the receipt block. This
 * drives the deck half against the **exact bytes the Rust formatters assert**
 * — the literals below are copied from
 * `format_join_summary_names_the_dash_the_base_and_the_rounds` and
 * `format_discard_summary_lists_the_round_subjects`, which is what keeps the
 * two ends pinned to one format.
 *
 * ## What this cannot drive, and where that is covered
 *
 * A real land from the card is not reachable from an app-test in this
 * repository. A join squashes the dash onto its base **in the main checkout**,
 * which here is the developer's own working tree — a fixture commit on `main`,
 * mid-run, with their uncommitted work in the index. Pointing the card at a
 * scratch repository instead does not help: the changeset aggregate composes
 * exactly one project, this checkout (at0332 records the same constraint), so
 * a dash in `/tmp` never reaches the card for `/dash-join` to resolve.
 *
 * A **discard** has no such cost — it destroys a fixture dash and nothing
 * else — so the end-to-end path that this file cannot walk (card → server →
 * shell ledger → Maker ▸ Reload → the same bytes) is walked by the discard in
 * `at0418-join-outcomes.test.ts`, over the same formatter, the same ledger
 * writer, the same hook, and the same block module.
 *
 * @covers tugdeck/src/components/tugways/cards/session-join-receipt-block.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card-transcript.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "at0419-session";
const CARD = '[data-card-id="A"]';
const JOIN_RECEIPT = `${CARD} [data-slot="join-receipt-block"]`;
const DISCARD_RECEIPT = `${CARD} [data-slot="discard-receipt-block"]`;
const SHELL_ROWS = `${CARD} [data-slot="session-transcript-shell-row"]`;

/** The exact S01 bytes `format_join_summary` produces. */
const JOIN_SUMMARY =
  "joined 0123456789 · join-lane → main · 5 round(s)\n" +
  "tugdash(join-lane): land the join surface";
/** The exact S02 bytes `format_discard_summary` produces. */
const DISCARD_SUMMARY =
  "discarded spike · 2 round(s), 3 file(s)\n" +
  "first round\nsecond round";
/** A row from before the format existed: raw output, not a receipt. */
const LEGACY_OUTPUT = "joined join-lane into main";

let projectDir = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = mkdtempSync(join(tmpdir(), "at0419-proj-"));
});

afterAll(() => {
  if (projectDir !== "" && existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
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

/** Append one settled shell exchange — the shape a landing's receipt takes. */
async function receiptRow(
  app: App,
  exchangeId: string,
  command: string,
  output: string,
): Promise<void> {
  await app.driveSession("A", {
    op: "shellExchange",
    exchangeId,
    command,
    output,
    cwd: projectDir,
    exitCode: 0,
    startedAtMs: 1_700_000_000_000,
  });
}

describe.skipIf(!SHOULD_RUN)("AT0419: the join and discard receipts", () => {
  test(
    "the two landings render as receipts, and a row the format does not claim stays raw",
    async () => {
      const app = await launchTugApp({ testName: "at0419-join-receipt" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30000 },
        );
        await app.bindSession("A", {
          tugSessionId: SID,
          sessionMode: "resume",
          projectDir,
          workspaceKey: projectDir,
        });

        // ── The join receipt ──────────────────────────────────────────────
        await receiptRow(app, "join-1", "/dash-join", JOIN_SUMMARY);
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(JOIN_RECEIPT)}).length === 1`,
          { timeoutMs: 20000 },
        );
        const joined = await app.evalJS<{
          identity: string;
          body: string;
          summaries: string;
          terminals: number;
        }>(
          `(() => {
             const block = document.querySelector(${JSON.stringify(JOIN_RECEIPT)});
             return {
               identity: (block.querySelector(".join-receipt-header")?.textContent ?? "").trim(),
               body: (block.querySelector('[data-slot="join-receipt-detail"]')?.textContent ?? "").trim(),
               summaries: (block.querySelector(".tool-call-header-summary, [data-slot=\\"block-header-summary\\"]")?.textContent ?? "").trim(),
               terminals: block.querySelectorAll(".tugx-term-content").length,
             };
           })()`,
        );
        note(`at0419 join receipt: ${JSON.stringify(joined)}`);
        // The landing sha leads — as the `commit:<8>` atom every other commit
        // surface names a commit with — then the dash and the base.
        expect(joined.identity).toContain("01234567");
        expect(joined.identity).toContain("join-lane");
        expect(joined.identity).toContain("main");
        // The message is the squash message, verbatim.
        expect(joined.body).toBe("tugdash(join-lane): land the join surface");
        // A receipt, not a terminal: the fenced output body is gone.
        expect(joined.terminals).toBe(0);

        // ── The discard receipt ───────────────────────────────────────────
        await receiptRow(app, "discard-1", "/dash-discard", DISCARD_SUMMARY);
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(DISCARD_RECEIPT)}).length === 1`,
          { timeoutMs: 20000 },
        );
        const discarded = await app.evalJS<{ identity: string; body: string }>(
          `(() => {
             const block = document.querySelector(${JSON.stringify(DISCARD_RECEIPT)});
             return {
               identity: (block.querySelector(".join-receipt-header")?.textContent ?? "").trim(),
               body: (block.querySelector('[data-slot="discard-receipt-detail"]')?.textContent ?? "").trim(),
             };
           })()`,
        );
        note(`at0419 discard receipt: ${JSON.stringify(discarded)}`);
        // No sha to lead with — the dash IS the identity.
        expect(discarded.identity).toBe("spike");
        expect(discarded.body).toContain("first round");
        expect(discarded.body).toContain("second round");

        // ── A row the parser does not claim renders raw ───────────────────
        // The fallback is the whole reason a parse miss returns null: the
        // reader sees the output rather than an empty block.
        await receiptRow(app, "join-legacy", "/dash-join", LEGACY_OUTPUT);
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(SHELL_ROWS)}).length === 3`,
          { timeoutMs: 20000 },
        );
        const fallback = await app.evalJS<{ receipts: number; raw: string }>(
          `(() => {
             const rows = document.querySelectorAll(${JSON.stringify(SHELL_ROWS)});
             const last = rows[rows.length - 1];
             return {
               receipts: document.querySelectorAll(${JSON.stringify(JOIN_RECEIPT)}).length,
               raw: (last.textContent ?? "").trim(),
             };
           })()`,
        );
        expect(fallback.receipts).toBe(1);
        expect(fallback.raw).toContain(LEGACY_OUTPUT);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
