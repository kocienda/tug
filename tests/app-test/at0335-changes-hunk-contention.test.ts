/**
 * at0335-changes-hunk-contention.test.ts — SHARED only where the work really
 * overlaps, and the own-hunk default election that follows from it.
 *
 * The claim under test is the point of M03: two sessions editing *disjoint*
 * regions of one file are co-owners without contending, and each one's
 * landing defaults to its own regions rather than to the whole file. The
 * inverse has to hold too — the same region edited by both is still SHARED,
 * and the diff says which band the overlap is in.
 *
 * Both halves need a real session entry with real sub-file evidence, which
 * `app.seedLedger()` now writes: the spans ride the file event through the
 * same `SessionLedger` the server uses, so the ids the verdict computes and
 * the ids the deck's checkboxes are keyed by come from one contract (Spec
 * S06). Seeding runs *after* launch — tugcast demotes every `live` row to
 * `closed` once at startup, so a pre-launch seed surfaces as `orphaned`.
 *
 * Two files, one launch:
 *
 * - `DISJOINT_FILE` — session A anchored in the first band, session B in the
 *   last. No SHARED badge; A's row default-elects one of three hunks and says
 *   `1 of 3 hunks`; no band is marked contested.
 * - `SHARED_FILE` — both sessions anchored in the same band. SHARED, and that
 *   band alone carries `data-contested`.
 *
 * The landing itself is not driven here, for the reason at0334 records: the
 * only project the aggregate composes is this checkout, and a test that
 * really commits rewrites the developer's history. The commit side of the
 * default election is covered in `changes-route-controller`'s own tests and
 * against a temp repo in `feeds/changeset.rs`.
 *
 * @covers tugdeck/src/components/tugways/tug-changes-list.tsx
 * @covers tugdeck/src/components/tugways/body-kinds/diff-block.tsx
 * @covers tugdeck/src/lib/hunk-election.ts
 * @covers tugdeck/src/lib/changes-route-controller.ts
 * @covers tugrust/crates/tugchanges-core/src/contention.rs
 * @covers tugrust/crates/tugcast/src/feeds/changeset.rs
 * @covers tugrust/crates/tugcast/src/main.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { launchTugApp, note } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID_A = "at0335-session-a";
const SID_B = "at0335-session-b";
const CARD = '[data-card-id="A"]';
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const USER_ROWS = `${CARD} [data-testid="session-card-transcript-user-body"]`;
const SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;

// The registry keys a workspace by the canonical project dir, so the dirty
// files have to live in this checkout — the constraint at0332/at0333/at0334
// all record. Their bytes are captured before the edits and restored after.
const PROJECT_DIR = realpathSync(resolve(import.meta.dir, "..", ".."));
const DISJOINT_FILE = "tuglaws/app-test-harness.md";
const SHARED_FILE = "tuglaws/tracking-changes.md";

// Line indices far enough apart that git's default context windows stay
// disjoint, so each marker is its own hunk.
const MARKERS = [5, 65, 125];

const originals = new Map<string, string>();

function pathOf(file: string): string {
  return join(PROJECT_DIR, file);
}

/** The exact text of one marker — also the anchor's `new_head`, which is what
 *  places its session in the hunk that added it. */
function markerText(file: string, index: number): string {
  return `<!-- at0335 ${file === DISJOINT_FILE ? "d" : "s"} ${index} -->`;
}

/** Splice every marker into `file`, leaving three separate hunks. */
function writeMarkers(file: string): void {
  const lines = (originals.get(file) ?? "").split("\n");
  // Descending, so each splice leaves the lower indices valid.
  for (const index of [...MARKERS].reverse()) {
    lines.splice(index, 0, markerText(file, index));
  }
  writeFileSync(pathOf(file), lines.join("\n"));
}

/**
 * A content anchor placing its owner in whichever hunk added `text`.
 *
 * `new_hash` is deliberately a value that matches nothing: the verdict's
 * containment path — the capped head appearing in the hunk's added text, with
 * the added text at least as long as the anchor claims — is the one a real
 * `Edit` anchor normally takes, since an anchor's written text and a hunk's
 * added lines are byte-identical only in the simplest case.
 */
function anchorFor(text: string): { seq: number; kind: string; anchor: string } {
  return {
    seq: 0,
    kind: "insert",
    anchor: JSON.stringify({
      new_hash: "0000000000000000",
      new_head: text,
      new_len: text.length,
    }),
  };
}

function seedEvent(
  session: string,
  toolUseId: string,
  file: string,
  anchoredAt: number,
) {
  return {
    tug_session_id: session,
    tool_use_id: toolUseId,
    file_path: pathOf(file),
    tool_name: "Edit",
    op: "write",
    // Proof class: a `bash` row is a bracket hint and never makes an owner.
    origin: "exact",
    ambiguous: false,
    project_dir: PROJECT_DIR,
    // Past the path's liveness cut (its last commit).
    at: Date.now(),
    spans: [anchorFor(markerText(file, anchoredAt))],
  };
}

beforeAll(() => {
  if (!SHOULD_RUN) return;
  for (const file of [DISJOINT_FILE, SHARED_FILE]) {
    originals.set(file, readFileSync(pathOf(file), "utf8"));
    writeMarkers(file);
  }
});

afterAll(() => {
  for (const [file, text] of originals) writeFileSync(pathOf(file), text);
});

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 1000, height: 760 },
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

/** This card's own session entry — two session entries compose here, and both
 *  hold rows for the same paths. */
const OWN_ENTRY = `${SHEET} [data-entry-owner="${SID_A}"]`;
const rowFor = (file: string) =>
  `${OWN_ENTRY} [data-testid="tug-changes-list-file-block"][data-path="${file}"]`;

describe.skipIf(!SHOULD_RUN)("AT0335: hunk-aware contention", () => {
  test(
    "disjoint regions are not shared and default-elect their own hunks",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: PROJECT_DIR });
      const app = await launchTugApp({
        testName: "at0335-changes-hunk-contention",
        env: { TUGBANK_PATH: tugbankPath },
      });
      try {
        app.seedLedger({
          sessions: [
            {
              session_id: SID_A,
              workspace_key: PROJECT_DIR,
              project_dir: PROJECT_DIR,
              card_id: "A",
              name: "at0335 A",
            },
            {
              session_id: SID_B,
              workspace_key: PROJECT_DIR,
              project_dir: PROJECT_DIR,
              card_id: "B",
              name: "at0335 B",
            },
          ],
          file_events: [
            // Disjoint: A wrote the first band, B the last.
            seedEvent(SID_A, "at0335-d-a", DISJOINT_FILE, MARKERS[0]),
            seedEvent(SID_B, "at0335-d-b", DISJOINT_FILE, MARKERS[2]),
            // Contended: both wrote the same band.
            seedEvent(SID_A, "at0335-s-a", SHARED_FILE, MARKERS[1]),
            seedEvent(SID_B, "at0335-s-b", SHARED_FILE, MARKERS[1]),
          ],
        });
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A", {
          tugSessionId: SID_A,
          projectDir: PROJECT_DIR,
          workspaceKey: PROJECT_DIR,
        });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });

        // One committed turn so the card is a live, non-empty session.
        await app.driveSession("A", { op: "send", text: "hello" });
        await app.driveSession("A", {
          op: "ingestFrame",
          feedId: 0x40,
          decoded: { tug_session_id: SID_A, type: "prompt_anchor", promptUuid: "uuid-1" },
        });
        await app.driveSession("A", {
          op: "ingestFrame",
          feedId: 0x40,
          decoded: {
            tug_session_id: SID_A,
            type: "turn_complete",
            seq: 0,
            msg_id: "m1",
            result: "success",
          },
        });
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(USER_ROWS)}).length === 1`,
          { timeoutMs: 8000 },
        );

        // ── Raise the changes sheet ────────────────────────────────────────
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

        const disjointRow = rowFor(DISJOINT_FILE);
        const sharedRow = rowFor(SHARED_FILE);
        try {
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(disjointRow)}) !== null &&
             document.querySelector(${JSON.stringify(sharedRow)}) !== null`,
            { timeoutMs: 30000 },
          );
        } catch (err) {
          note(
            "at0335 shade contents when the session rows did not appear",
            await app.evalJS<unknown>(
              `(() => {
                 const sheet = document.querySelector(${JSON.stringify(SHEET)});
                 if (sheet === null) return "no sheet";
                 return {
                   owners: Array.from(
                     sheet.querySelectorAll("[data-entry-owner]"),
                   ).map((el) => el.getAttribute("data-entry-owner")),
                   entryKinds: Array.from(
                     sheet.querySelectorAll("[data-entry-kind]"),
                   ).map((el) => el.getAttribute("data-entry-kind")),
                   paths: Array.from(
                     sheet.querySelectorAll("[data-testid=\\"tug-changes-list-file-block\\"]"),
                   ).map((el) => el.getAttribute("data-path")).slice(0, 25),
                 };
               })()`,
            ),
          );
          throw err;
        }

        // ── The badges: shared only where the work overlaps ────────────────
        const sharedBadge = async (row: string): Promise<number> =>
          app.evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(
              `${row} .tug-changes-list-badge-shared`,
            )}).length`,
          );
        // The contended file is the control: if it is not SHARED, the seeded
        // co-ownership never composed and the disjoint assertion below would
        // pass for the wrong reason.
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(
            `${sharedRow} .tug-changes-list-badge-shared`,
          )}).length === 1`,
          { timeoutMs: 20000 },
        );
        expect(await sharedBadge(sharedRow)).toBe(1);
        expect(await sharedBadge(disjointRow)).toBe(0);
        note("at0335 shared badges", "contended yes, disjoint no");

        // ── The default election: this session's own hunk ──────────────────
        // The badge needs the row's diff (the ids the own-hunk set is
        // reconciled against), which arrives on its own schedule.
        const partialText = async (): Promise<string | null> =>
          app.evalJS<string | null>(
            `document.querySelector(${JSON.stringify(
              `${disjointRow} [data-testid="tug-changes-list-file-partial"]`,
            )})?.textContent ?? null`,
          );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(
            `${disjointRow} [data-testid="tug-changes-list-file-partial"]`,
          )}) !== null`,
          { timeoutMs: 25000 },
        );
        // One band of however many the file currently has: the total depends
        // on whatever else is uncommitted in this checkout, the elected count
        // does not — it is this session's single anchored region.
        expect(await partialText()).toMatch(/^1 of \d+ hunks$/);
        note("at0335 default-election badge", (await partialText()) ?? "<none>");

        // Expand it and confirm the boxes agree with the badge, on the band
        // this session actually wrote.
        const isExpanded = async (): Promise<boolean> =>
          app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(
              `${disjointRow}[data-expanded="true"]`,
            )}) !== null`,
          );
        for (let attempt = 0; attempt < 4; attempt += 1) {
          if (await isExpanded()) break;
          await app.nativeClickAtElement(
            `${disjointRow} [data-slot="tug-changes-list-fold"]`,
          );
          await settle(500);
        }
        expect(await isExpanded()).toBe(true);

        const boxes = `${disjointRow} [data-testid="tug-changes-list-hunk-elect"]`;
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(boxes)}).length >= 3`,
          { timeoutMs: 25000 },
        );
        // Asserted by content, not by slot: this checkout's other uncommitted
        // work adds hunks of its own, and a band index would pin the test to
        // whatever else the tree happens to be carrying.
        const checkedBands = await app.evalJS<string[]>(
          `Array.from(document.querySelectorAll(${JSON.stringify(
            `${disjointRow} [data-slot="diff-hunk"]`,
          )}))
             .filter((band) => band.querySelector(
               '[data-testid="tug-changes-list-hunk-elect"][aria-checked="true"]',
             ) !== null)
             .map((band) => band.textContent)`,
        );
        expect(checkedBands.length).toBe(1);
        expect(checkedBands[0]).toContain(markerText(DISJOINT_FILE, MARKERS[0]));
        note("at0335 default-elected band", "the one this session wrote");

        // No band of a file nobody contends is marked contested.
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(
              `${disjointRow} [data-slot="diff-hunk"][data-contested="true"]`,
            )}).length`,
          ),
        ).toBe(0);

        // ── The contended file marks the band, not the file ────────────────
        for (let attempt = 0; attempt < 4; attempt += 1) {
          if (
            await app.evalJS<boolean>(
              `document.querySelector(${JSON.stringify(
                `${sharedRow}[data-expanded="true"]`,
              )}) !== null`,
            )
          ) {
            break;
          }
          // The expanded row above pushes this one down the scroller, and the
          // harness clicks an element's rect centre without scrolling to it.
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(
              `${sharedRow} [data-slot="tug-changes-list-fold"]`,
            )})?.scrollIntoView({ block: "center" }), true`,
          );
          await settle(300);
          await app.nativeClickAtElement(
            `${sharedRow} [data-slot="tug-changes-list-fold"]`,
          );
          await settle(500);
        }
        try {
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(
              `${sharedRow} [data-slot="diff-hunk"][data-contested="true"]`,
            )}).length === 1`,
            { timeoutMs: 25000 },
          );
        } catch (err) {
          note(
            "at0335 contended row state",
            await app.evalJS<unknown>(
              `(() => {
                 const row = document.querySelector(${JSON.stringify(sharedRow)});
                 if (row === null) return "no row";
                 const hunks = Array.from(row.querySelectorAll('[data-slot="diff-hunk"]'));
                 return {
                   expanded: row.getAttribute("data-expanded"),
                   hunkCount: hunks.length,
                   ids: hunks.map((el) => el.getAttribute("data-hunk-id")),
                   contested: hunks.map((el) => el.getAttribute("data-contested")),
                   partial: row.querySelector('[data-testid="tug-changes-list-file-partial"]')?.textContent ?? null,
                 };
               })()`,
            ),
          );
          throw err;
        }
        const contestedBand = await app.evalJS<string | null>(
          `document.querySelector(${JSON.stringify(
            `${sharedRow} [data-slot="diff-hunk"][data-contested="true"]`,
          )})?.textContent ?? null`,
        );
        expect(contestedBand).toContain(markerText(SHARED_FILE, MARKERS[1]));
        note("at0335 contested band", "the one both sessions wrote");
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
