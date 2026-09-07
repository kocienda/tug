/**
 * at0419-join-receipt.test.ts — a landed join and a discarded arc render as
 * receipts, not as raw shell output ([P06]).
 *
 * The server formats both summaries (Specs S01 / S02), writes them to the
 * shell ledger, and returns them on the `_ok`; the deck appends the same
 * string as transcript ink and parses it back out for the receipt block. This
 * drives the deck half against the **exact bytes the Rust formatters assert**
 * — the literals below are copied from
 * `format_join_summary_carries_the_files_line`,
 * `format_join_summary_carries_the_arc_record_between_the_fit_and_the_files`
 * and `format_discard_summary_lists_the_round_subjects`, which is what keeps
 * the two ends pinned to one format.
 *
 * **A landing is two rows, and each carries its own kind** ([B01], [B02]). The
 * `Git Commit` entry carries the commit receipt exactly as a `/commit` does —
 * the sha atom and the squash subject on the header, the file and ± badges
 * beside them, the message and the expandable file rows beneath, expanded —
 * plus the one line a plain commit has no room for, `arc → base` and its fit.
 * The `Joined` boundary follows it at the transcript's edge, carrying the
 * event and the `N stages · N rounds` counts, with the arc's own record behind
 * its fold: the lifecycle strip, the document, the stages, the plan.
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
 * ## What left this file, and why
 *
 * The boundary's **flush wrap** — a long run returning to the event's own x on
 * every line — used to be measured here on a join whose squash subject sat on
 * the bar. **The join's bar carries no detail at all now** ([B02]), so no join
 * can exercise that rule, and the fixture is gone rather than retargeted at
 * the receipt's header — which wraps on `/commit`'s own long-standing terms
 * and is not what this file is about.
 *
 * The rule itself is still live: `StageDivider` passes a `detail`, so a stage
 * rotation's bar is the boundary that can still wrap one. **Nothing measures
 * it today** — that is a fixture owed to `session-boundary.css`, on a stage
 * boundary, and it is named here so the gap is a known one.
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
 * @covers tugdeck/src/components/tugways/cards/session-arc-receipt-block.tsx
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
/** The settled join row's boundary — one of the transcript's three. */
const JOIN_BOUNDARY = `${CARD} [data-boundary="join"]`;
/** The commit receipt, in the `Git Commit` entry's own body column. */
const JOIN_RECEIPT = `${CARD} [data-slot="join-receipt-block"]`;
/** The arc's record, behind the boundary's fold. */
const RECORD = '[data-slot="join-boundary-record"]';
const FOLD_CUE = '[data-slot="tool-call-header-disclosure"]';
const DISCARD_RECEIPT = `${CARD} [data-slot="discard-receipt-block"]`;
const SHELL_ROWS = `${CARD} [data-slot="session-transcript-shell-row"]`;
const FILE_LIST = '[data-slot="tug-commit-changes-list"]';

/**
 * The exact S01 bytes for a squash landing that carries its arc's record —
 * the shape every join written from here on has. Copied from
 * `format_join_summary_carries_the_arc_record_between_the_fit_and_the_files`.
 */
const JOIN_SUMMARY_WITH_RECORD =
  "joined 0123456789 · join-lane → main · 5 round(s)\n" +
  "fit: verified 3f0a1c9e2b onto 91c4de70f2\n" +
  "arc: opened on .tug/arcs/join-lane/brief.md\n" +
  "arc: devise · opus · sess-devise\n" +
  "arc: implement · account default · sess-implement\n" +
  'files: [{"path":"src/a.rs","status":"modified","added":16,"removed":1},' +
  '{"path":"src/b.rs","status":"created","added":4,"removed":0}]\n' +
  "tugarc(join-lane): land the join surface";
/**
 * The same landing with no record on it — a join written before the `arc: `
 * lines existed, and one whose arc log had nothing to say. Copied from
 * `format_join_summary_carries_the_files_line`.
 */
const JOIN_SUMMARY =
  "joined abcdef0123 · quiet-lane → main · 3 round(s)\n" +
  'files: [{"path":"src/a.rs","status":"modified","added":16,"removed":1},' +
  '{"path":"src/b.rs","status":"created","added":4,"removed":0}]\n' +
  "tugarc(quiet-lane): land without a record";
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

/** Find a mounted node by the arc name its text carries.
 *
 *  BY NAME, not by position: a restored row is seated where its turn is rather
 *  than at the end, so the last node in the document is not the row just
 *  driven in. Indexing here measured the wrong row for as long as it happened
 *  to look the same. */
function byArc(selector: string, arc: string): string {
  return `Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
     .find((n) => (n.textContent || "").includes(${JSON.stringify(arc)}))`;
}

/** Find a mounted commit receipt by the arc its IDENTITY line names.
 *
 *  Not by the block's whole text, which is what `byArc` reads: one row in this
 *  file expands a real commit's hunks, and the commit it expands is this
 *  checkout's `HEAD` — which, whenever `HEAD` last touched this file, carries
 *  every arc name written below as diff content. The identity line is the
 *  receipt's own claim about which arc it landed, and nothing else can put a
 *  name there. */
function byReceiptArc(arc: string): string {
  return `Array.from(document.querySelectorAll(${JSON.stringify(JOIN_RECEIPT)}))
     .find((n) => (n.querySelector(".join-receipt-identity")?.textContent || "")
       .includes(${JSON.stringify(arc)}))`;
}

describe.skipIf(!SHOULD_RUN)("AT0419: the join and discard receipts", () => {
  test(
    "a landing is a commit receipt in its entry and a boundary carrying the arc",
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

        // ── The commit, in the entry named for it ────────────────────────
        await receiptRow(app, "join-1", "/arc-join", JOIN_SUMMARY_WITH_RECORD);
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(JOIN_RECEIPT)}).length === 1`,
          { timeoutMs: 20000 },
        );
        const receipt = await app.evalJS<{
          sha: string;
          subject: string;
          summary: string;
          arcIdentity: string;
          rows: string[];
          terminals: number;
          inBodyColumn: boolean;
        }>(
          `(() => {
             const block = document.querySelector(${JSON.stringify(JOIN_RECEIPT)});
             const entry = block.closest(".tug-transcript-entry");
             return {
               sha: (block.querySelector(".commit-receipt-sha")?.textContent ?? "").trim(),
               subject: (block.querySelector(".commit-receipt-summary")?.textContent ?? "").trim(),
               summary: Array.from(
                 block.querySelectorAll('[data-slot="tool-call-header-summary"]'),
               ).map((s) => (s.textContent ?? "").trim()).join(" "),
               arcIdentity: (block.querySelector(".join-receipt-identity")?.textContent ?? "").trim(),
               rows: Array.from(
                 block.querySelectorAll('[data-testid="tug-changes-list-file-block"]'),
               ).map((r) => r.getAttribute("data-path") ?? ""),
               terminals: block.querySelectorAll(".tugx-term-content").length,
               // The receipt is body-column content, unlike the boundary
               // below it: it starts INSIDE the entry's inset rather than at
               // the entry's own left edge.
               inBodyColumn:
                 block.getBoundingClientRect().left - entry.getBoundingClientRect().left > 1,
             };
           })()`,
        );
        note(`at0419 join receipt: ${JSON.stringify(receipt)}`);
        // The sha atom and the squash subject lead the header, exactly as on a
        // `/commit`. That parity is what this row is for: the same act,
        // differently started, reads the same way.
        expect(receipt.sha).toContain("01234567");
        expect(receipt.subject).toBe("tugarc(join-lane): land the join surface");
        // Files and ± ride the header's trailing badges — the join's rounds do
        // not, because they are the arc's fact and ride the boundary.
        expect(receipt.summary).toContain("2 files");
        expect(receipt.summary).not.toContain("round");
        // The join's own facts — which branch it squashed, and what the last
        // green verify said about the tree.
        expect(receipt.arcIdentity).toContain("join-lane → main");
        expect(receipt.arcIdentity).toContain("fit verified 3f0a1c9e2b onto 91c4de70f2");
        // The landed files are rows, in the order the record froze them, and
        // they are mounted without a gesture.
        expect(receipt.rows).toEqual(["src/a.rs", "src/b.rs"]);
        // A receipt, not a terminal: the fenced output body is gone.
        expect(receipt.terminals).toBe(0);
        expect(receipt.inBodyColumn, "the receipt sits in the entry's body column").toBe(true);

        // ── The boundary, at the transcript's edge, folded ────────────────
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(JOIN_BOUNDARY)}).length === 1`,
          { timeoutMs: 20000 },
        );
        const bar = await app.evalJS<{
          event: string;
          detail: string;
          summary: string;
          records: number;
          registers: number;
          edge: number;
          rightEdge: number;
        }>(
          `(() => {
             const b = document.querySelector(${JSON.stringify(JOIN_BOUNDARY)});
             const entry = b.closest(".tug-transcript-entry");
             return {
               event: (b.querySelector(".session-boundary-event")?.textContent ?? "").trim(),
               // The whole detail run, less the event: empty is the claim.
               detail: (b.querySelector(".session-boundary-line")?.textContent ?? "")
                 .replace((b.querySelector(".session-boundary-event")?.textContent ?? ""), "")
                 .trim(),
               // One pipe-section per summary entry, so read them all.
               summary: Array.from(
                 b.querySelectorAll('[data-slot="tool-call-header-summary"]'),
               ).map((s) => (s.textContent ?? "").trim()).join(" "),
               records: document.querySelectorAll(${JSON.stringify(RECORD)}).length,
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
        // And nothing else on the bar. The receipt above names the commit;
        // naming it twice is the doubling this shape ends ([B02], [B06]).
        expect(bar.detail, "the bar carries no sha and no subject").toBe("");
        // The stages and the rounds — the arc's counts, not the commit's.
        expect(bar.summary).toContain("2 stages");
        expect(bar.summary).toContain("5 rounds");
        expect(bar.summary).not.toContain("file");
        // Folded: the record is not mounted at all until the bar is opened.
        expect(bar.records, "the record folds behind the boundary").toBe(0);
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

        // ── Opened: the arc's record is what is behind the fold ───────────
        await app.evalJS<null>(
          `(document.querySelector(${JSON.stringify(
            `${JOIN_BOUNDARY} ${FOLD_CUE}`,
          )}).click(), null)`,
        );
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(RECORD)}).length === 1`,
          { timeoutMs: 20000 },
        );
        const record = await app.evalJS<{
          strip: string;
          docs: string[];
          stages: string[][];
        }>(
          `(() => {
             const r = document.querySelector(${JSON.stringify(RECORD)});
             return {
               strip: (r.querySelector(".join-boundary-record-strip")?.textContent ?? "").trim(),
               docs: Array.from(r.querySelectorAll(".arc-receipt-doc")).map(
                 (p) => (p.textContent ?? "").trim(),
               ),
               stages: Array.from(r.querySelectorAll(".arc-receipt-stage")).map((li) => [
                 (li.querySelector(".arc-receipt-stage-word")?.textContent ?? "").trim(),
                 (li.querySelector(".arc-receipt-stage-model")?.textContent ?? "").trim(),
               ]),
             };
           })()`,
        );
        note(`at0419 arc record: ${JSON.stringify(record)}`);
        // The lifecycle strip leads it, in the arc's own vocabulary.
        expect(record.strip).toContain("Finished · 2 stages");
        expect(record.strip).toContain("join-lane");
        // The document it opened on; no plan on this fixture, so one line.
        expect(record.docs).toEqual(["opened on .tug/arcs/join-lane/brief.md"]);
        // One row per stage, with the model the server wrote — including the
        // literal `account default`, which is a word by the time it arrives.
        expect(record.stages).toEqual([
          ["devise", "opus"],
          ["implement", "account default"],
        ]);

        // ── A join with no record folds nothing ──────────────────────────
        await receiptRow(app, "join-quiet", "/arc-join", JOIN_SUMMARY);
        await app.waitForCondition<boolean>(
          `${byArc(JOIN_BOUNDARY, "quiet-lane")} !== undefined`,
          { timeoutMs: 20000 },
        );
        const quiet = await app.evalJS<{
          event: string;
          summary: string;
          cues: number;
          receipts: number;
        }>(
          `(() => {
             const b = ${byArc(JOIN_BOUNDARY, "quiet-lane")};
             return {
               event: (b.querySelector(".session-boundary-event")?.textContent ?? "").trim(),
               summary: Array.from(
                 b.querySelectorAll('[data-slot="tool-call-header-summary"]'),
               ).map((s) => (s.textContent ?? "").trim()).join(" "),
               cues: b.querySelectorAll(${JSON.stringify(FOLD_CUE)}).length,
               receipts: document.querySelectorAll(${JSON.stringify(JOIN_RECEIPT)}).length,
             };
           })()`,
        );
        note(`at0419 recordless join: ${JSON.stringify(quiet)}`);
        expect(quiet.event).toBe("Joined quiet-lane into main");
        // Rounds alone: no stages to count, and a `0 stages` would be a claim
        // the receipt cannot make.
        expect(quiet.summary).toContain("3 rounds");
        expect(quiet.summary).not.toContain("stage");
        // Nothing folds, so there is no chevron to offer.
        expect(quiet.cues, "a boundary with no record offers no fold").toBe(0);
        // Its commit still reads in full, which is the point: the record is
        // the arc's, and a join without one is still a commit.
        expect(quiet.receipts).toBe(2);

        // ── A row expands into the real commit's hunks ────────────────────
        // Against this checkout's own HEAD: the fetch is a genuine
        // `diff-tree` for a sha that exists, resolved at the row's
        // ledger-persisted cwd.
        expect(realAddedLine.length).toBeGreaterThan(0);
        await receiptRow(app, "join-real", "/arc-join", realJoinSummary, realRepoRoot);
        // The file rows are in the receipt, mounted without a gesture — no
        // fold to open first.
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
          `${byArc(JOIN_BOUNDARY, "old-lane")} !== undefined`,
          { timeoutMs: 20000 },
        );
        // Both halves of the row, before reading either: the boundary and the
        // receipt mount independently, and a read taken on the first alone
        // finds the second undefined often enough to be a flake.
        await app.waitForCondition<boolean>(
          `${byReceiptArc("old-lane")} !== undefined`,
          { timeoutMs: 20000 },
        );
        const historical = await app.evalJS<{
          event: string;
          subject: string;
          arcIdentity: string;
          lists: number;
        }>(
          `(() => {
             const b = ${byArc(JOIN_BOUNDARY, "old-lane")};
             const block = ${byReceiptArc("old-lane")};
             return {
               event: (b.querySelector(".session-boundary-event")?.textContent ?? "").trim(),
               subject: (block.querySelector(".commit-receipt-summary")?.textContent ?? "").trim(),
               arcIdentity: (block.querySelector(".join-receipt-identity")?.textContent ?? "").trim(),
               lists: block.querySelectorAll(${JSON.stringify(FILE_LIST)}).length,
             };
           })()`,
        );
        note(`at0419 historical join: ${JSON.stringify(historical)}`);
        expect(historical.event).toBe("Joined old-lane into main");
        expect(historical.subject).toBe("tugarc(old-lane): land what came before");
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
          `document.querySelectorAll(${JSON.stringify(SHELL_ROWS)}).length === 6`,
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
        // The four parseable joins became boundaries; this one did not.
        expect(fallback.boundaries).toBe(4);
        expect(fallback.raw).toContain(LEGACY_OUTPUT);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
