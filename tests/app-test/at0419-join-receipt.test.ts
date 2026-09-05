/**
 * at0419-join-receipt.test.ts — a landed join and a discarded arc render as
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
 * landed files are expandable rows, and one line — `arc → base` — carries the
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
 * repository. A join squashes the arc onto its base **in the main checkout**,
 * which here is the developer's own working tree — a fixture commit on `main`,
 * mid-run, with their uncommitted work in the index. Pointing the card at a
 * scratch repository instead does not help: the changeset aggregate composes
 * exactly one project, this checkout (at0332 records the same constraint), so
 * a arc in `/tmp` never reaches the card for `/arc-join` to resolve.
 *
 * A **discard** has no such cost — it destroys a fixture arc and nothing
 * else — so the end-to-end path that this file cannot walk (card → server →
 * shell ledger → Maker ▸ Reload → the same bytes) is walked by the discard in
 * `at0418-join-outcomes.test.ts`, over the same formatter, the same ledger
 * writer, the same hook, and the same block module.
 *
 * @covers tugdeck/src/components/tugways/cards/session-join-receipt-block.tsx
 * @covers tugdeck/src/components/tugways/cards/session-boundary.tsx
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
/** The settled join row itself — one of the transcript's three boundaries. */
const JOIN_BOUNDARY = `${CARD} [data-boundary="join"]`;
/** The commit receipt, which is now the boundary's fold body. */
const JOIN_RECEIPT = `${CARD} [data-slot="join-receipt-block"]`;
const FOLD_CUE = '[data-slot="tool-call-header-disclosure"]';
const DISCARD_RECEIPT = `${CARD} [data-slot="discard-receipt-block"]`;
const SHELL_ROWS = `${CARD} [data-slot="session-transcript-shell-row"]`;
const FILE_LIST = '[data-slot="tug-commit-changes-list"]';

/** The exact S01 bytes `format_join_summary` produces for a squash landing. */
const JOIN_SUMMARY =
  "joined 0123456789 · join-lane → main · 5 round(s)\n" +
  'files: [{"path":"src/a.rs","status":"modified","added":16,"removed":1},' +
  '{"path":"src/b.rs","status":"created","added":4,"removed":0}]\n' +
  "tugarc(join-lane): land the join surface";
/**
 * A join receipt written before the `files:` line existed — read forever,
 * written never. A non-squash join produces these same bytes today, because
 * the server omits the line rather than writing a partial list.
 */
const HISTORICAL_JOIN_SUMMARY =
  "joined fedcba9876 · old-lane → main · 2 round(s)\n" +
  "tugarc(old-lane): land what came before";
/** The exact S02 bytes `format_discard_summary` produces. */
const DISCARD_SUMMARY =
  "discarded spike · 2 round(s), 3 file(s)\n" +
  "first round\nsecond round";
/** A row the parser does not claim at all: raw output, not a receipt. */
const LEGACY_OUTPUT = "joined join-lane into main";
/**
 * A landing whose squash subject cannot fit one line of the bar — the fixture
 * for [B03]'s flush wrap, which a short subject cannot exercise at all. Long
 * enough to wrap even though the run now has the bar's FULL width to spend:
 * the trailing badges no longer fence a column, so the fixture that used to
 * wrap against their left edge would fit on one line.
 */
const LONG_SUBJECT_JOIN_SUMMARY =
  "joined abcdef0123 · wrap-lane → main · 1 round(s)\n" +
  "tugarc(wrap-lane): give the three rows where the ground moves under the " +
  "transcript one anatomy, one seat at the transcript's own edge, and one " +
  "sentence that returns flush to its own left edge when it wraps, running " +
  "the whole width of the bar on every line beneath the first rather than " +
  "stopping where the badges above it happened to stop, because a receipt " +
  "is a paragraph and not a column in a fixed-width grid";

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
  // The fixture needs a file whose hunks contain a substantial added line, and
  // whether HEAD's *first* touched file is one is an accident of whatever the
  // checkout last committed: a deletions-only edit or a pure rename leads the
  // list often enough, and taking touched[0] on faith turned this file red on
  // an unrelated commit. So the file is chosen by the property the assertion
  // needs, over every path in the commit.
  const addedLineIn = (path: string): string =>
    (
      git(realRepoRoot, [
        "diff-tree",
        "--no-commit-id",
        "--root",
        "-r",
        "-M",
        "-p",
        realSha,
        "--",
        path,
      ])
        .split("\n")
        .find((l) => l.startsWith("+") && !l.startsWith("+++") && l.trim().length > 12) ?? ""
    ).slice(1);
  realPath = touched.find((p) => p !== "" && addedLineIn(p) !== "") ?? touched[0] ?? "";
  realAddedLine = realPath === "" ? "" : addedLineIn(realPath);
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
    "tugarc(real-lane): land a real file";
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

        // ── The settled join: a boundary, receipt folded behind it ───────
        await receiptRow(app, "join-1", "/arc-join", JOIN_SUMMARY);
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(JOIN_BOUNDARY)}).length === 1`,
          { timeoutMs: 20000 },
        );
        // The bar is the row a reader meets, and the receipt is BEHIND it:
        // nothing of the receipt's body is in the document until it is opened,
        // the way a compaction's recap is not.
        const bar = await app.evalJS<{
          event: string;
          detail: string;
          summary: string;
          receipts: number;
          registers: number;
          edge: number;
          rightEdge: number;
        }>(
          `(() => {
             const b = document.querySelector(${JSON.stringify(JOIN_BOUNDARY)});
             const entry = b.closest(".tug-transcript-entry");
             return {
               event: (b.querySelector(".session-boundary-event")?.textContent ?? "").trim(),
               detail: (b.querySelector(".join-boundary-detail")?.textContent ?? "").trim(),
               // One pipe-section per summary entry, so read them all.
               summary: Array.from(
                 b.querySelectorAll('[data-slot="tool-call-header-summary"]'),
               ).map((s) => (s.textContent ?? "").trim()).join(" "),
               receipts: document.querySelectorAll(${JSON.stringify(JOIN_RECEIPT)}).length,
               registers: document.querySelectorAll('[data-slot="arc-join-register"]').length,
               edge: Math.round(
                 b.getBoundingClientRect().left - entry.getBoundingClientRect().left,
               ),
               // The other end of the same claim: a pulled seat that gives up
               // its right edge is not full width, it is the same width shifted
               // left, and only measuring both ends can tell the two apart.
               rightEdge: Math.round(
                 b.getBoundingClientRect().right - entry.getBoundingClientRect().right,
               ),
             };
           })()`,
        );
        note(`at0419 join boundary: ${JSON.stringify(bar)}`);
        // The event is the register's own terminal sentence, in the boundary's
        // voice — the two branch names, derived off the receipt, not written.
        expect(bar.event).toBe("Joined join-lane into main");
        // The landing sha leads the detail — as the `commit:<8>` atom every
        // other commit surface names a commit with — and the SUBJECT takes the
        // seat beside it, exactly as on a `/commit`. That is the parity this
        // row is for.
        expect(bar.detail).toContain("01234567");
        expect(bar.detail).toContain("tugarc(join-lane): land the join surface");
        // Files, ± and rounds ride the trailing summary.
        expect(bar.summary).toContain("2 files");
        expect(bar.summary).toContain("5 rounds");
        // Folded: the receipt is not mounted at all until the bar is opened.
        expect(bar.receipts, "the receipt folds behind the boundary").toBe(0);
        // And no second register settles beside it. The live register keeps
        // narrating everywhere it mounts; what settles here is the boundary.
        expect(bar.registers, "no settled register beside the boundary").toBe(0);
        // A boundary belongs to the transcript, not to a speaker's column, so
        // it sits at the entry's own edge — the `$` cell renders it inside the
        // body column and the boundary pulls itself back out.
        expect(Math.abs(bar.edge), "the boundary sits at the transcript's edge").toBeLessThanOrEqual(1);
        expect(
          Math.abs(bar.rightEdge),
          "and runs the transcript's full width, not the body column's shifted left",
        ).toBeLessThanOrEqual(1);

        // ── Opened: the commit receipt is what is behind the fold ─────────
        await app.evalJS<null>(
          `(document.querySelector(${JSON.stringify(
            `${JOIN_BOUNDARY} ${FOLD_CUE}`,
          )}).click(), null)`,
        );
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(JOIN_RECEIPT)}).length === 1`,
          { timeoutMs: 20000 },
        );
        const joined = await app.evalJS<{
          arcIdentity: string;
          body: string;
          rows: string[];
          terminals: number;
        }>(
          `(() => {
             const block = document.querySelector(${JSON.stringify(JOIN_RECEIPT)});
             return {
               arcIdentity: (block.querySelector(".join-receipt-identity")?.textContent ?? "").trim(),
               body: (block.querySelector('[data-slot="join-receipt-detail"]')?.textContent ?? "").trim(),
               rows: Array.from(
                 block.querySelectorAll('[data-testid="tug-changes-list-file-block"]'),
               ).map((r) => r.getAttribute("data-path") ?? ""),
               terminals: block.querySelectorAll(".tugx-term-content").length,
             };
           })()`,
        );
        note(`at0419 join receipt: ${JSON.stringify(joined)}`);
        // The join's own fact — the identity a plain commit cannot carry —
        // sits in the fold body, beside the message and the file rows.
        expect(joined.arcIdentity).toBe("join-lane → main");
        // The subject led the bar, so the fold carries only what follows
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
        await receiptRow(app, "join-real", "/arc-join", realJoinSummary, realRepoRoot);
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(JOIN_BOUNDARY)}).length === 2`,
          { timeoutMs: 20000 },
        );
        // The file rows are behind this boundary's fold, as they are behind
        // every other one.
        await app.evalJS<null>(
          `(() => {
             const bs = document.querySelectorAll(${JSON.stringify(JOIN_BOUNDARY)});
             bs[bs.length - 1].querySelector(${JSON.stringify(FOLD_CUE)}).click();
             return null;
           })()`,
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
        await receiptRow(app, "join-historical", "/arc-join", HISTORICAL_JOIN_SUMMARY);
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(JOIN_BOUNDARY)}).length === 3`,
          { timeoutMs: 20000 },
        );
        // Its bar first, then what it folds — the same two reads as the first
        // join, so the degraded receipt is checked at both altitudes.
        const historicalBar = await app.evalJS<{ event: string; detail: string }>(
          `(() => {
             const bs = document.querySelectorAll(${JSON.stringify(JOIN_BOUNDARY)});
             const b = bs[bs.length - 1];
             return {
               event: (b.querySelector(".session-boundary-event")?.textContent ?? "").trim(),
               detail: (b.querySelector(".join-boundary-detail")?.textContent ?? "").trim(),
             };
           })()`,
        );
        note(`at0419 historical join bar: ${JSON.stringify(historicalBar)}`);
        expect(historicalBar.event).toBe("Joined old-lane into main");
        expect(historicalBar.detail).toContain("fedcba98");
        expect(historicalBar.detail).toContain("tugarc(old-lane): land what came before");
        await app.evalJS<null>(
          `(() => {
             const bs = document.querySelectorAll(${JSON.stringify(JOIN_BOUNDARY)});
             bs[bs.length - 1].querySelector(${JSON.stringify(FOLD_CUE)}).click();
             return null;
           })()`,
        );
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(JOIN_RECEIPT)}).length === 3`,
          { timeoutMs: 20000 },
        );
        const historical = await app.evalJS<{
          arcIdentity: string;
          lists: number;
        }>(
          `(() => {
             const blocks = document.querySelectorAll(${JSON.stringify(JOIN_RECEIPT)});
             const block = blocks[blocks.length - 1];
             return {
               arcIdentity: (block.querySelector(".join-receipt-identity")?.textContent ?? "").trim(),
               lists: block.querySelectorAll(${JSON.stringify(FILE_LIST)}).length,
             };
           })()`,
        );
        note(`at0419 historical join receipt: ${JSON.stringify(historical)}`);
        expect(historical.arcIdentity).toBe("old-lane → main");
        // No files line, so no file list — degraded, never fabricated.
        expect(historical.lists).toBe(0);

        // ── The discard receipt ───────────────────────────────────────────
        await receiptRow(app, "discard-1", "/arc-discard", DISCARD_SUMMARY);
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
        // No sha to lead with — the arc IS the identity.
        expect(discarded.identity).toBe("spike");
        expect(discarded.body).toContain("first round");
        expect(discarded.body).toContain("second round");

        // ── A row the parser does not claim renders raw ───────────────────
        // The fallback is the whole reason a parse miss returns null: the
        // reader sees the output rather than an empty block.
        await receiptRow(app, "join-legacy", "/arc-join", LEGACY_OUTPUT);
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(SHELL_ROWS)}).length === 5`,
          { timeoutMs: 20000 },
        );
        const fallback = await app.evalJS<{ boundaries: number; raw: string }>(
          `(() => {
             const rows = document.querySelectorAll(${JSON.stringify(SHELL_ROWS)});
             const last = rows[rows.length - 1];
             return {
               boundaries: document.querySelectorAll(${JSON.stringify(JOIN_BOUNDARY)}).length,
               raw: (last.textContent ?? "").trim(),
             };
           })()`,
        );
        // The three parseable joins became boundaries; this one did not.
        expect(fallback.boundaries).toBe(3);
        expect(fallback.raw).toContain(LEGACY_OUTPUT);

        // ── A long subject wraps FLUSH, and runs the bar's full width ─────
        // The correction the boundary exists for: the event and its detail are
        // one inline run, so a second line returns to the run's own left edge
        // rather than hanging under wherever the detail began. Seating the
        // event in the strip's name slot instead would look identical on every
        // one-line row above and break this silently, which is why the claim
        // is measured on a row long enough to wrap.
        //
        // And the right edge is the same argument. The trailing badges float
        // INSIDE the run rather than fencing a column beside it, so they
        // shorten the first line and nothing below it — a wrapped line that
        // stopped at their left edge would be a tab stop nobody set, on a
        // surface that is not a fixed-width grid.
        await receiptRow(app, "join-wrap", "/arc-join", LONG_SUBJECT_JOIN_SUMMARY);
        // Wait for the row ITSELF, not for a count of four: the boundaries do
        // not mount in the order they were driven in, so a count can be
        // satisfied while this row is still absent — which is a flake under a
        // loaded batch and a pass when run alone.
        await app.waitForCondition<boolean>(
          `Array.from(document.querySelectorAll(${JSON.stringify(JOIN_BOUNDARY)}))
             .some((n) => (n.textContent || "").includes("wrap-lane"))`,
          { timeoutMs: 20000 },
        );
        const wrap = await app.evalJS<{
          lines: number;
          indents: number[];
          past: number;
          width: number;
        }>(
          `(() => {
             const bs = document.querySelectorAll(${JSON.stringify(JOIN_BOUNDARY)});
             // BY NAME, not by position: a restored boundary is seated where
             // its turn is rather than at the end, so the last node in the
             // document is the historical join rather than the row just driven
             // in. Indexing here measured that row for as long as it happened
             // to wrap too.
             const b = Array.from(bs).find(
               (n) => (n.textContent || "").includes("wrap-lane"),
             );
             const run = b.querySelector(".session-boundary-line");
             // One client rect per line box the run occupies, in order.
             const rects = Array.from(run.getClientRects());
             const first = rects.length === 0 ? 0 : rects[0].left;
             // The floated badge cluster's own left edge: the x every line
             // used to stop at, and which every line below the first is now
             // free to cross.
             const cluster = b.querySelector(".tool-call-header-trailing");
             const fence = cluster.getBoundingClientRect().left;
             return {
               lines: rects.length,
               indents: rects.map((r) => Math.round(r.left - first)),
               past: rects.filter((r) => r.right > fence).length,
               // The width the run had to spend, so a future failure says
               // whether the fixture stopped wrapping or the layout did.
               width: Math.round(
                 b.querySelector(".tool-call-header-detail").getBoundingClientRect().width,
               ),
             };
           })()`,
        );
        note(`at0419 wrapped run: ${JSON.stringify(wrap)}`);
        expect(wrap.lines, "the fixture subject is long enough to wrap").toBeGreaterThan(1);
        for (const indent of wrap.indents) {
          expect(Math.abs(indent), "every line of the run begins at the event's x").toBeLessThanOrEqual(1);
        }
        // The first line stops short of the badges; at least one line beneath
        // it does not. Counted rather than indexed, because which line runs
        // longest is the text's business.
        expect(
          wrap.past,
          "a wrapped line runs past the badges the first line stopped at",
        ).toBeGreaterThan(0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
