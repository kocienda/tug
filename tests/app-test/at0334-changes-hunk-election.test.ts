/**
 * at0334-changes-hunk-election.test.ts — the hunk-election affordance on a
 * real session-entry row.
 *
 * This file exists because the wall it walks through was recorded as
 * permanent. A `sessions` row is written by exactly one path in the product —
 * `session_init` arriving from a live tugcode subprocess — and `bindSession`
 * is a client-side binding the ledger knows nothing about, so an app-test
 * could compose *unattributed* changeset rows but never a session entry.
 * Everything hanging off one (the per-hunk election checkbox, the
 * `N of M hunks` badge, the drift signal) was therefore left to a manual
 * checklist. at0253 and at0332 both record the wall; this test retires it.
 *
 * The way through is `app.seedLedger()`: the harness runs `tugcast
 * --seed-ledger` out of the bundle under test, so the rows are written by the
 * same `SessionLedger` the server uses — real schema, real journal. A live
 * session plus one proof-class `file_events` row on a really dirty tracked
 * file is all the aggregate needs to compose a session entry. It runs *after*
 * launch: tugcast demotes every `live` row to `closed` once at startup, so a
 * row seeded before launch is swept and its files surface as `orphaned`.
 *
 * What it drives, in one launch:
 *
 * - the boxes render, one per hunk, all checked (a file with no election
 *   lands whole);
 * - unchecking one persists through the draft round trip — ledger, compose,
 *   snapshot — and the row's badge reads `2 of 3 hunks` against it;
 * - unchecking down to one disables the survivor and says why, because an
 *   election that selects nothing is a landing the engine refuses;
 * - an election whose hunks have all drifted out of the file renders as
 *   `stale election` rather than as a silent whole-file landing.
 *
 * The landing itself is deliberately **not** driven here: the only project the
 * aggregate composes is this checkout, and a test that really commits is a
 * test that rewrites the developer's history. Partial landing, drift refusal,
 * and whole-file landing are covered against a temp repo in
 * `feeds/changeset.rs`'s `m02a_verification`.
 *
 * @covers tugdeck/src/components/tugways/tug-changes-list.tsx
 * @covers tugdeck/src/lib/hunk-election.ts
 * @covers tugdeck/src/lib/changes-route-controller.ts
 * @covers tugrust/crates/tugcast/src/feeds/changeset.rs
 * @covers tugrust/crates/tugcast/src/main.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { launchTugApp, note } from "./_harness";
import { sessionCardShape } from "./_harness/shapes";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SID = "at0334-session";
const CARD = '[data-card-id="A"]';
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const USER_ROWS = `${CARD} [data-testid="session-card-transcript-user-body"]`;
const SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;

// The registry keys a workspace by the canonical project dir, so the dirty
// file has to live in this checkout — the same constraint at0332 and at0333
// record. Its bytes are captured before the edit and restored afterwards.
const PROJECT_DIR = realpathSync(resolve(import.meta.dir, "..", ".."));
const DIRTY_FILE = "tuglaws/app-test-harness.md";
const dirtyPath = join(PROJECT_DIR, DIRTY_FILE);
// A second file, seeded as owned but written only later. An entry's inline
// diff is requested once per *path set*, so a file entering the entry is what
// recomposes an already-open diff — editing an already-dirty file's bytes does
// not. It must be owned by this session, or it joins the unattributed entry
// and leaves this one's path set untouched.
const SCRATCH_FILE = "at0334-scratch.txt";
const scratchPath = join(PROJECT_DIR, SCRATCH_FILE);

const SESSION_ENTRY = `${SHEET} [data-entry-kind="session"]`;
const FILE_ROW =
  `${SESSION_ENTRY} [data-testid="tug-changes-list-file-block"][data-path="${DIRTY_FILE}"]`;
const BOXES = `${FILE_ROW} [data-testid="tug-changes-list-hunk-elect"]`;

let original = "";

// Three markers, far enough apart that git's default context windows stay
// disjoint and each is its own hunk.
const MARKERS = [5, 65, 125];

/** Rewrite the dirty file with `count` markers spliced into the original. */
function writeMarkers(count: number, tag = "marker"): void {
  const lines = original.split("\n");
  // Descending, so each splice leaves the lower indices valid.
  for (const index of MARKERS.slice(0, count).reverse()) {
    lines.splice(index, 0, `<!-- at0334 ${tag} ${index} -->`);
  }
  writeFileSync(dirtyPath, lines.join("\n"));
}

beforeAll(() => {
  if (!SHOULD_RUN) return;
  original = readFileSync(dirtyPath, "utf8");
  writeMarkers(3);
});

afterAll(() => {
  if (original.length > 0) writeFileSync(dirtyPath, original);
  rmSync(scratchPath, { force: true });
});

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!SHOULD_RUN)("AT0334: hunk election on a session entry", () => {
  test(
    "the boxes, the count, the protected last hunk, and a drifted election",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: PROJECT_DIR });
      const app = await launchTugApp({
        testName: "at0334-changes-hunk-election",
        env: { TUGBANK_PATH: tugbankPath },
      });
      try {
        // The wall, walked through: a live session that proof-owns the dirty
        // file is exactly what the aggregate needs to compose a session entry.
        //
        // After launch, not before — tugcast demotes every `live` row to
        // `closed` once at startup, so a pre-launch seed would be swept and
        // the file would surface as `orphaned` instead.
        app.seedLedger({
          sessions: [
            {
              session_id: SID,
              workspace_key: PROJECT_DIR,
              project_dir: PROJECT_DIR,
              card_id: "A",
              name: "at0334 work",
            },
          ],
          file_events: [
            {
              tug_session_id: SID,
              tool_use_id: "at0334-tu-1",
              file_path: join(PROJECT_DIR, DIRTY_FILE),
              tool_name: "Edit",
              op: "write",
              // Proof class: a `bash` row is a bracket hint and never makes an
              // owner, so the file would fall to unattributed instead.
              origin: "exact",
              ambiguous: false,
              project_dir: PROJECT_DIR,
              // Past the path's liveness cut (its last commit).
              at: Date.now(),
            },
            // The scratch file, owned from the start but not yet on disk. It
            // joins the entry only when it is written, which is what changes
            // the *session entry's* path set and makes its diff re-request —
            // an unowned file would land in the unattributed entry instead,
            // whose diff store is a different one entirely.
            {
              tug_session_id: SID,
              tool_use_id: "at0334-tu-2",
              file_path: join(PROJECT_DIR, SCRATCH_FILE),
              tool_name: "Write",
              op: "created",
              origin: "exact",
              ambiguous: false,
              project_dir: PROJECT_DIR,
              at: Date.now(),
            },
          ],
        });
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: sessionCardShape({ width: 1000, height: 760 }), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A", {
          tugSessionId: SID,
          projectDir: PROJECT_DIR,
          workspaceKey: PROJECT_DIR,
        });
        await app.awaitEngineReady("A", { timeoutMs: 15000 });

        // One committed turn so the card is a live, non-empty session.
        await app.driveSession("A", { op: "send", text: "hello" });
        await app.driveSession("A", {
          op: "ingestFrame",
          feedId: 0x40,
          decoded: { tug_session_id: SID, type: "prompt_anchor", promptUuid: "uuid-1" },
        });
        await app.driveSession("A", {
          op: "ingestFrame",
          feedId: 0x40,
          decoded: {
            tug_session_id: SID,
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

        // ── The seeded session composes as a SESSION entry ─────────────────
        // Everything below depends on this: an unattributed row is passed no
        // election at all, so not one of these affordances would render.
        try {
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(FILE_ROW)}) !== null`,
            { timeoutMs: 30000 },
          );
        } catch (err) {
          // Which bucket did it land in? `orphaned` means the seeded session
          // was not live (a pre-launch seed the startup demote swept);
          // `unattributed` means the file_event was not proof-class or its
          // path was not dirty.
          note(
            "at0334 shade contents when no session row appeared",
            await app.evalJS<unknown>(
              `(() => {
                 const sheet = document.querySelector(${JSON.stringify(SHEET)});
                 if (sheet === null) return "no sheet";
                 return {
                   entryKinds: Array.from(
                     sheet.querySelectorAll("[data-entry-kind]"),
                   ).map((el) => el.getAttribute("data-entry-kind")),
                   paths: Array.from(
                     sheet.querySelectorAll("[data-testid=\\"tug-changes-list-file-block\\"]"),
                   ).map((el) => el.getAttribute("data-path")).slice(0, 25),
                   text: sheet.textContent.slice(0, 400),
                 };
               })()`,
            ),
          );
          throw err;
        }
        note("at0334 reached a session-entry row", DIRTY_FILE);

        // Expand it. Retried against the row's own expanded bit: an aggregate
        // recompute can re-render the list between finding the cue and hitting
        // it, and re-clicking while still collapsed cannot toggle it shut.
        const isExpanded = async (): Promise<boolean> =>
          app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(
              `${FILE_ROW}[data-expanded="true"]`,
            )}) !== null`,
          );
        for (let attempt = 0; attempt < 4; attempt += 1) {
          if (await isExpanded()) break;
          await app.nativeClickAtElement(
            `${FILE_ROW} [data-slot="tug-changes-list-fold"]`,
          );
          await settle(500);
        }
        expect(await isExpanded()).toBe(true);

        // ── One box per hunk, all checked ─────────────────────────────────
        // A file with no election lands whole, and every box says so.
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(BOXES)}).length === 3`,
          { timeoutMs: 25000 },
        );
        const checkedCount = async (): Promise<number> =>
          app.evalJS<number>(
            `Array.from(document.querySelectorAll(${JSON.stringify(BOXES)}))
               .filter((el) => el.getAttribute("aria-checked") === "true").length`,
          );
        expect(await checkedCount()).toBe(3);
        // No badge while the file lands whole — a count here would be noise.
        expect(
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(
              `${FILE_ROW} [data-testid="tug-changes-list-file-partial"]`,
            )}) === null`,
          ),
        ).toBe(true);

        // ── HV2: unchecking one persists, and the row counts it ───────────
        // The band may be below the fold, and the harness clicks the centre of
        // an element's rect without scrolling — so bring it into view first.
        const boxIn = (index: number) =>
          `${FILE_ROW} [data-slot="diff-hunk"]:nth-of-type(${index + 1}) ` +
          `[data-testid="tug-changes-list-hunk-elect"]`;
        const uncheckAt = async (index: number): Promise<void> => {
          await app.evalJS<boolean>(
            `document.querySelector(${JSON.stringify(boxIn(index))})
               .scrollIntoView({ block: "center" }), true`,
          );
          await settle(300);
          await app.nativeClickAtElement(boxIn(index));
        };
        await uncheckAt(1);
        // The box is controlled by the persisted election, so it only flips
        // once the write has gone to the ledger and come back through the
        // composed snapshot. A box that stays checked here means the round
        // trip broke, not that the click missed.
        await app.waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(BOXES)})[1]
             ?.getAttribute("aria-checked") === "false"`,
          { timeoutMs: 15000 },
        );

        const badgeText = async (): Promise<string | null> =>
          app.evalJS<string | null>(
            `document.querySelector(${JSON.stringify(
              `${FILE_ROW} [data-testid="tug-changes-list-file-partial"]`,
            )})?.textContent ?? null`,
          );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(
            `${FILE_ROW} [data-testid="tug-changes-list-file-partial"]`,
          )}) !== null`,
          { timeoutMs: 15000 },
        );
        expect(await badgeText()).toBe("2 of 3 hunks");
        note("at0334 badge after one uncheck", (await badgeText()) ?? "<none>");

        // ── HV3: the last elected hunk is protected, and says why ─────────
        await uncheckAt(2);
        await app.waitForCondition<boolean>(
          `Array.from(document.querySelectorAll(${JSON.stringify(BOXES)}))
             .filter((el) => el.getAttribute("aria-checked") === "true").length === 1`,
          { timeoutMs: 15000 },
        );
        expect(await badgeText()).toBe("1 of 3 hunks");

        // The reason the box refuses is a real TugTooltip now, not a native
        // `title` — so it has to be hovered to exist. The disabled checkbox
        // swallows the pointer, which is exactly why the trigger is the
        // wrapper span around it.
        const survivorDisabled = await app.evalJS<boolean | null>(
          `(() => {
             const box = Array.from(
               document.querySelectorAll(${JSON.stringify(BOXES)}),
             ).find((el) => el.getAttribute("aria-checked") === "true");
             return box ? box.disabled === true : null;
           })()`,
        );
        expect(survivorDisabled).toBe(true);

        await app.evalJS<null>(
          `(function(){
             const el = document.querySelector(
               '[data-testid="tug-changes-list-hunk-elect-locked"]',
             );
             el.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false }));
             el.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));
             return null;
           })()`,
        );
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-slot="tug-tooltip"]') !== null`,
          { timeoutMs: 5000 },
        );
        const survivorReason = await app.getElementText('[data-slot="tug-tooltip"]');
        expect(survivorReason).toContain("At least one hunk must land");
        note("at0334 protected-hunk tooltip", survivorReason);

        // ── HV8: an election whose hunks have all drifted says so ─────────
        // Rewrite every marker so not one elected id survives, and dirty a
        // second file so the entry's path set changes and the diff really
        // re-requests (editing an already-dirty file's bytes does not).
        writeMarkers(3, "rewritten");
        writeFileSync(scratchPath, "at0334 scratch\n");

        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(
            `${FILE_ROW} [data-testid="tug-changes-list-file-stale-election"]`,
          )}) !== null`,
          { timeoutMs: 30000 },
        );
        const stale = await app.evalJS<{
          text: string | null;
          partialGone: boolean;
          allChecked: boolean;
        }>(
          `(() => {
             const badge = document.querySelector(${JSON.stringify(
               `${FILE_ROW} [data-testid="tug-changes-list-file-stale-election"]`,
             )});
             const boxes = Array.from(
               document.querySelectorAll(${JSON.stringify(BOXES)}),
             );
             return {
               text: badge?.textContent ?? null,
               partialGone: document.querySelector(${JSON.stringify(
                 `${FILE_ROW} [data-testid="tug-changes-list-file-partial"]`,
               )}) === null,
               allChecked:
                 boxes.length > 0 &&
                 boxes.every((el) => el.getAttribute("aria-checked") === "true"),
             };
           })()`,
        );
        expect(stale.text).toBe("stale election");
        // The badge's explanation is a TugTooltip, so it has to be hovered.
        await app.evalJS<null>(
          `(function(){
             const el = document.querySelector(${JSON.stringify(
               `${FILE_ROW} [data-testid="tug-changes-list-file-stale-election"]`,
             )});
             el.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false }));
             el.dispatchEvent(new PointerEvent("pointermove", { bubbles: true }));
             return null;
           })()`,
        );
        await app.waitForCondition<boolean>(
          `document.querySelector('.tug-tooltip-content') !== null`,
          { timeoutMs: 5000 },
        );
        const staleReason = await app.getElementText(".tug-tooltip-content");
        expect(staleReason).toContain("no longer in it");
        // The count is gone: there is nothing coherent to count.
        expect(stale.partialGone).toBe(true);
        // Every box checked is the only honest rendering of "nothing
        // addressable is elected" — the badge is what keeps it from reading
        // as a plain whole-file landing.
        expect(stale.allChecked).toBe(true);
        note("at0334 stale badge", `${stale.text} — ${staleReason}`);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
