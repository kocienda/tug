/**
 * at0419-join-receipt.test.ts — a landed join and a discarded dash render as
 * receipts, not as raw shell output ([P06]).
 *
 * The server formats both summaries (Specs S01 / S02), writes them to the
 * shell ledger, and returns them on the `_ok`; the deck appends the same
 * string as transcript ink and parses it back out for the receipt block. This
 * drives the deck half against the **exact bytes the Rust formatters assert**
 * — the literals below are copied from
 * `format_join_summary_carries_the_files_line` and
 * `format_discard_summary_lists_the_round_subjects`, which is what keeps the
 * two ends pinned to one format.
 *
 * A join lands a commit on the base, so its receipt is the commit receipt:
 * the sha and squash subject lead, the file and ± badges ride the header, the
 * landed files are expandable rows, and one line — `dash → base` — carries the
 * identity a plain commit has no room for.
 *
 * The expansion is driven over **this checkout's own HEAD**, whose sha and
 * touched file are read from git at run time. A row's diff fetch resolves its
 * workspace from the row's cwd and falls back to the bootstrap one when that
 * path is not a registered workspace — which a scratch repo in `/tmp` never
 * is — so a synthetic commit would have its fetch answered by the app's real
 * checkout, find nothing, and expand into a notice. The test would then pin
 * the failure mode rather than the feature. The pinned-literal rows and the
 * real-repository row are therefore separate: the first pin the format's
 * bytes, the second pins that a row reaches real hunks.
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
 * @covers tugdeck/src/components/tugways/cards/session-commit-receipt-block.tsx
 * @covers tugdeck/src/components/tugways/cards/session-card-transcript.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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
const FILE_LIST = '[data-slot="tug-commit-changes-list"]';

/** The exact S01 bytes `format_join_summary` produces for a squash landing. */
const JOIN_SUMMARY =
  "joined 0123456789 · join-lane → main · 5 round(s)\n" +
  'files: [{"path":"src/a.rs","status":"modified","added":16,"removed":1},' +
  '{"path":"src/b.rs","status":"created","added":4,"removed":0}]\n' +
  "tugdash(join-lane): land the join surface";
/**
 * A join receipt written before the `files:` line existed — read forever,
 * written never. A non-squash join produces these same bytes today, because
 * the server omits the line rather than writing a partial list.
 */
const HISTORICAL_JOIN_SUMMARY =
  "joined fedcba9876 · old-lane → main · 2 round(s)\n" +
  "tugdash(old-lane): land what came before";
/** The exact S02 bytes `format_discard_summary` produces. */
const DISCARD_SUMMARY =
  "discarded spike · 2 round(s), 3 file(s)\n" +
  "first round\nsecond round";
/** A row the parser does not claim at all: raw output, not a receipt. */
const LEGACY_OUTPUT = "joined join-lane into main";

let projectDir = "";
/**
 * The real-repository row: this checkout's own HEAD, one file it touched, and
 * a line that file's diff adds. Read from git at runtime rather than pinned,
 * so the row keeps naming a commit that exists as the branch moves.
 *
 * It has to be THIS repository. `resolve_diff_target` falls back to the
 * bootstrap workspace whenever a request's root is not a registered one, and
 * a scratch repo in `/tmp` is never registered — binding a session to it does
 * not open a workspace. A synthetic repo therefore has its fetch quietly
 * answered by the app's own checkout, where the sha does not exist, and the
 * row expands into "No diff for this file." The temp `projectDir` above stays
 * for the pinned-literal rows, which assert presentation and never fetch.
 */
let realRepoRoot = "";
let realSha = "";
let realPath = "";
let realAddedLine = "";
let realJoinSummary = "";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = realpathSync(mkdtempSync(join(tmpdir(), "at0419-proj-")));

  realRepoRoot = git(import.meta.dir, ["rev-parse", "--show-toplevel"]);
  realSha = git(realRepoRoot, ["rev-parse", "HEAD"]);
  const touched = git(realRepoRoot, [
    "diff-tree",
    "--no-commit-id",
    "--root",
    "-r",
    "-M",
    "--name-only",
    realSha,
  ]).split("\n");
  realPath = touched[0] ?? "";
  const patch = git(realRepoRoot, [
    "diff-tree",
    "--no-commit-id",
    "--root",
    "-r",
    "-M",
    "-p",
    realSha,
    "--",
    realPath,
  ]).split("\n");
  // A substantial added line, so the assertion cannot pass on an empty `+`.
  realAddedLine = (
    patch.find((l) => l.startsWith("+") && !l.startsWith("+++") && l.trim().length > 12) ?? ""
  ).slice(1);
  const numstat = git(realRepoRoot, [
    "diff-tree",
    "--no-commit-id",
    "--root",
    "-r",
    "-M",
    "--numstat",
    realSha,
    "--",
    realPath,
  ]).split("\t");
  realJoinSummary =
    `joined ${realSha.slice(0, 10)} · real-lane → main · 1 round(s)\n` +
    `files: [{"path":"${realPath}","status":"modified",` +
    `"added":${numstat[0] ?? "0"},"removed":${numstat[1] ?? "0"}}]\n` +
    "tugdash(real-lane): land a real file";
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
  cwd: string = projectDir,
): Promise<void> {
  await app.driveSession("A", {
    op: "shellExchange",
    exchangeId,
    command,
    output,
    cwd,
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

        // ── The join receipt, on the commit skeleton ──────────────────────
        await receiptRow(app, "join-1", "/dash-join", JOIN_SUMMARY);
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(JOIN_RECEIPT)}).length === 1`,
          { timeoutMs: 20000 },
        );
        const joined = await app.evalJS<{
          identity: string;
          dashIdentity: string;
          body: string;
          rows: string[];
          terminals: number;
        }>(
          `(() => {
             const block = document.querySelector(${JSON.stringify(JOIN_RECEIPT)});
             return {
               identity: (block.querySelector(".join-receipt-header")?.textContent ?? "").trim(),
               dashIdentity: (block.querySelector(".join-receipt-identity")?.textContent ?? "").trim(),
               body: (block.querySelector('[data-slot="join-receipt-detail"]')?.textContent ?? "").trim(),
               rows: Array.from(
                 block.querySelectorAll('[data-testid="tug-changes-list-file-block"]'),
               ).map((r) => r.getAttribute("data-path") ?? ""),
               terminals: block.querySelectorAll(".tugx-term-content").length,
             };
           })()`,
        );
        note(`at0419 join receipt: ${JSON.stringify(joined)}`);
        // The landing sha leads — as the `commit:<8>` atom every other commit
        // surface names a commit with — and the SUBJECT takes the seat beside
        // it, exactly as on a `/commit`. That is the parity this receipt is
        // for: the header is a commit's header.
        expect(joined.identity).toContain("01234567");
        expect(joined.identity).toContain("tugdash(join-lane): land the join surface");
        // The join's own fact — the identity a plain commit cannot carry —
        // sits in the body, not the header.
        expect(joined.dashIdentity).toBe("join-lane → main");
        // The subject led the header, so the body carries only what follows
        // it; this squash message is a subject alone.
        expect(joined.body).toBe("");
        // The landed files are rows, in the order the record froze them.
        expect(joined.rows).toEqual(["src/a.rs", "src/b.rs"]);
        // A receipt, not a terminal: the fenced output body is gone.
        expect(joined.terminals).toBe(0);

        // ── A row expands into the real commit's hunks ────────────────────
        // Against this checkout's own HEAD: the fetch is a genuine
        // `diff-tree` for a sha that exists, resolved at the row's
        // ledger-persisted cwd.
        expect(realAddedLine.length).toBeGreaterThan(0);
        await receiptRow(app, "join-real", "/dash-join", realJoinSummary, realRepoRoot);
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(JOIN_RECEIPT)}).length === 2`,
          { timeoutMs: 20000 },
        );
        await app.waitForCondition<boolean>(
          `document.querySelectorAll('[data-path="${realPath}"] .tug-changes-list-row-hit').length === 1`,
          { timeoutMs: 20000 },
        );
        note(`at0419 expanding ${realPath} at ${realSha.slice(0, 10)}`);
        await app.click(`[data-path="${realPath}"] .tug-changes-list-row-hit`);
        await app.waitForCondition<boolean>(
          `document.querySelectorAll('[data-path="${realPath}"] [data-slot="tug-changes-list-file-diff"]').length === 1`,
          { timeoutMs: 20000 },
        );
        // The body mounts on the fold with a "Loading diff…" notice and swaps
        // to hunks when the fetch lands. Waiting past the notice is what makes
        // the assertion below about the diff rather than about timing — and a
        // timeout here still falls through to the note, so a failure says
        // WHICH notice it got stuck on.
        await app
          .waitForCondition<boolean>(
            `!(document.querySelector('[data-path="${realPath}"] [data-slot="tug-changes-list-file-diff"]')?.textContent ?? "").includes("Loading diff")`,
            { timeoutMs: 20000 },
          )
          .catch(() => undefined);
        const hunks = await app.evalJS<string>(
          `(document.querySelector('[data-path="${realPath}"] [data-slot="tug-changes-list-file-diff"]')?.textContent ?? "").trim()`,
        );
        note(`at0419 expanded diff body: ${JSON.stringify(hunks.slice(0, 300))}`);
        expect(hunks).toContain(realAddedLine);

        // ── A receipt written before the files line still renders ─────────
        // The parse-forever contract: a transcript replays from JSONL on every
        // reload, so a format change that orphaned these would turn every join
        // already recorded back into a raw shell row.
        await receiptRow(app, "join-historical", "/dash-join", HISTORICAL_JOIN_SUMMARY);
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(JOIN_RECEIPT)}).length === 3`,
          { timeoutMs: 20000 },
        );
        const historical = await app.evalJS<{
          identity: string;
          dashIdentity: string;
          lists: number;
        }>(
          `(() => {
             const blocks = document.querySelectorAll(${JSON.stringify(JOIN_RECEIPT)});
             const block = blocks[blocks.length - 1];
             return {
               identity: (block.querySelector(".join-receipt-header")?.textContent ?? "").trim(),
               dashIdentity: (block.querySelector(".join-receipt-identity")?.textContent ?? "").trim(),
               lists: block.querySelectorAll(${JSON.stringify(FILE_LIST)}).length,
             };
           })()`,
        );
        note(`at0419 historical join receipt: ${JSON.stringify(historical)}`);
        expect(historical.identity).toContain("fedcba98");
        expect(historical.identity).toContain("tugdash(old-lane): land what came before");
        expect(historical.dashIdentity).toBe("old-lane → main");
        // No files line, so no file list — degraded, never fabricated.
        expect(historical.lists).toBe(0);

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
          `document.querySelectorAll(${JSON.stringify(SHELL_ROWS)}).length === 5`,
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
        // The three parseable joins became receipts; this one did not.
        expect(fallback.receipts).toBe(3);
        expect(fallback.raw).toContain(LEGACY_OUTPUT);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
