/**
 * at0333-changes-hunk-ids.test.ts — hunk identity from git to the DOM.
 *
 * A hunk election is only as trustworthy as the id it names, and that id is
 * computed in Rust and nowhere else: the deck receives it alongside the diff
 * text and never re-derives one. This drives the whole path over the real
 * aggregate and a really-dirty checkout — edit one tracked file in two places
 * far enough apart that git emits two hunks, expand its row in the Changes
 * shade, and assert the rendered hunk bands carry distinct server-supplied
 * ids, one per hunk, in order.
 *
 * The dirty file is an existing *tracked* file, deliberately: the diff wire
 * serves no ids for a created file, whose chunk it synthesizes from
 * `--no-index` rather than reading out of the index — the landing engine
 * cannot address such a hunk, so the deck must not be handed one to offer.
 * The file's bytes are captured before the edit and restored afterwards.
 *
 * It then drives what those ids are *for* on this row: fold one band, make a
 * new hunk appear above it, and assert the fold stayed on the hunk the user
 * folded rather than migrating onto the slot its index now names — collapse
 * state keys by content id, not by position. A marker attribute stamped on the
 * live `data-slot="diff-body"` node before the edit says the diff body also
 * survived the transition without remounting.
 *
 * The recompose needs a second, newly-dirty file, not just the edit: an
 * entry's inline diff is requested once per *path set*, so editing an
 * already-dirty file's bytes does not refetch it. A file entering the entry
 * does — the production shape of "something else went dirty while the shade
 * was open".
 *
 * **What that mount assertion does and does not cover.** It pins `DiffBlock`'s
 * mount identity and the id-keyed collapse, both real things to hold. It is
 * **not** a regression guard on the one-diff-body unification: `election` is
 * `undefined` on every entry kind but `session`, so on the unattributed row
 * this harness can reach, `fileBlockBody` renders one component type both
 * before and after that change and a test here cannot fail on it. That fix is
 * guarded by the mount-identity triple stated in its commit body and by
 * at0334, which drives a seeded session-entry row. Do not read the assertion
 * as covering more than it does.
 *
 * **Not driven here:** the election checkbox and the partial landing. Those
 * render on *session-entry* rows, which this file does not seed — at0334 does,
 * via `app.seedLedger()`, and drives the checkbox, the `N of M hunks` badge,
 * and the stale-election signal there. The landing itself is covered at the
 * Rust round-trip layer (`commit.rs`: elected hunk lands alone, mixed
 * whole+partial landing, drift refusal, dirty-index refusal;
 * `feeds/changeset.rs`: the `changeset_commit` election round trip).
 *
 * @covers tugdeck/src/components/tugways/tug-changes-list.tsx
 * @covers tugdeck/src/components/tugways/body-kinds/diff-block.tsx
 * @covers tugdeck/src/lib/git-diff-store.ts
 * @covers tugrust/crates/tugcast/src/feeds/git.rs
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
const TEST_TIMEOUT_MS = 120_000;

const SID = "at0333-session";
const CARD = '[data-card-id="A"]';
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const USER_ROWS = `${CARD} [data-testid="session-card-transcript-user-body"]`;
const SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;

// As in at0332: the registry keys a workspace by the canonical project dir, so
// the dirty file has to live in this checkout — a synthetic temp repo never
// composes into the aggregate.
const PROJECT_DIR = realpathSync(resolve(import.meta.dir, "..", ".."));
// A long, stable doc with no runtime role. Two edits ~50 lines apart leave
// git's default context windows disjoint, so it emits two hunks.
const DIRTY_FILE = "tests/app-test/README.md";
const dirtyPath = join(PROJECT_DIR, DIRTY_FILE);
// A second file, dirtied later to re-request the entry's diff. The inline
// diff is fetched once per *path set*, so a file entering the entry is what
// re-composes it — the production path for "another file went dirty while the
// shade was open", and the only one that recomposes an already-open diff.
const SCRATCH_FILE = "tests/app-test/at0333-scratch.txt";
const scratchPath = join(PROJECT_DIR, SCRATCH_FILE);

let original = "";

const FILE_ROW =
  `${SHEET} [data-testid="tug-changes-list-file-block"][data-path="${DIRTY_FILE}"]`;

// Marker line indices into the *original* file. Wide gaps so git's default
// context windows stay disjoint and each marker is its own hunk; anchored to
// indices rather than content so the edit survives any rewording of the doc.
// The middle one is inserted later, to make a hunk appear *above* a collapsed
// band without disturbing either neighbour's body (and so without moving
// either neighbour's id, which excludes the `@@` header by design).
const FIRST_MARKER = 5;
const MIDDLE_MARKER = 65;
const LAST_MARKER = 125;

/** Rewrite the dirty file with the named markers spliced into the original. */
function writeMarkers(which: "outer" | "all"): void {
  const lines = original.split("\n");
  // Descending, so each splice leaves the lower indices valid.
  lines.splice(LAST_MARKER, 0, "<!-- at0333 last marker -->");
  if (which === "all") {
    lines.splice(MIDDLE_MARKER, 0, "<!-- at0333 middle marker -->");
  }
  lines.splice(FIRST_MARKER, 0, "<!-- at0333 first marker -->");
  writeFileSync(dirtyPath, lines.join("\n"));
}

beforeAll(() => {
  if (!SHOULD_RUN) return;
  original = readFileSync(dirtyPath, "utf8");
  writeMarkers("outer");
});

afterAll(() => {
  if (original.length > 0) writeFileSync(dirtyPath, original);
  rmSync(scratchPath, { force: true });
});

const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!SHOULD_RUN)("AT0333: hunk ids reach the rendered diff", () => {
  test(
    "a two-hunk tracked file renders one distinct server-supplied id per hunk band",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: PROJECT_DIR });
      const app = await launchTugApp({
        testName: "at0333-changes-hunk-ids",
        env: { TUGBANK_PATH: tugbankPath },
      });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: sessionCardShape(), focusCardId: "A" });
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
          decoded: { tug_session_id: SID, type: "turn_complete", seq: 0, msg_id: "m1", result: "success" },
        });
        await app.body("A").waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(USER_ROWS)}).length === 1`,
          { timeoutMs: 8000 },
        );

        // ── Raise the changes sheet ────────────────────────────────────────
        await app.body("A").nativeClickAtElement(PROMPT_INPUT);
        await app.nativeType("/commit");
        await settle();
        await app.nativeKey("Escape"); // dismiss the completion popup
        await settle();
        await app.nativeKey("Return", ["cmd"]);
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SHEET)}) !== null`,
          { timeoutMs: 8000 },
        );

        // ── The edited file arrives in the shade ───────────────────────────
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(FILE_ROW)}) !== null`,
          { timeoutMs: 20000 },
        );

        // Expand it. The fold cue is the row's own affordance, so click it
        // rather than the row hit area (which the trailing cluster masks).
        //
        // The click is retried against the row's own expanded bit rather than
        // fired once and trusted: an aggregate recompute can re-render the
        // list between finding the cue and hitting it, and on a loaded machine
        // that lands the click on nothing. Re-clicking only while still
        // collapsed can't toggle it back shut.
        const isExpanded = async (): Promise<boolean> =>
          app.body("A").evalJS<boolean>(
            `document.querySelector(${JSON.stringify(
              `${FILE_ROW}[data-expanded="true"]`,
            )}) !== null`,
          );
        for (let attempt = 0; attempt < 4; attempt += 1) {
          if (await isExpanded()) break;
          await app.body("A").nativeClickAtElement(
            `${FILE_ROW} [data-slot="tug-changes-list-fold"]`,
          );
          await settle(500);
        }
        expect(await isExpanded()).toBe(true);

        await app.body("A").waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(
            `${FILE_ROW} [data-slot="diff-hunk"]`,
          )}).length >= 2`,
          { timeoutMs: 25000 },
        );

        const ids = await app.body("A").evalJS<(string | null)[]>(
          `Array.from(
             document.querySelectorAll(${JSON.stringify(
               `${FILE_ROW} [data-slot="diff-hunk"]`,
             )}),
           ).map((el) => el.getAttribute("data-hunk-id"))`,
        );
        expect(ids.length).toBeGreaterThanOrEqual(2);
        // Every band carries an id — a missing one would mean the deck had to
        // invent identity, which is exactly what the wire exists to prevent.
        for (const id of ids) {
          expect(typeof id).toBe("string");
          expect(id).toMatch(/^[0-9a-f]{16}(#\d+)?$/);
        }
        expect(new Set(ids).size).toBe(ids.length);

        // ── The collapse follows its own hunk, not its slot ────────────────
        //
        // Collapse the *last* band, then make a new hunk appear above it. The
        // collapse is keyed by the hunk's content id, so it stays on the band
        // the user folded rather than migrating down onto the slot that index
        // now names. The diff body must also survive the transition without
        // remounting — a fresh mount would take the collapse with it, which is
        // why a marker attribute is stamped on the live node first.
        const lastId = ids[ids.length - 1];
        const BODY = `${FILE_ROW} [data-slot="diff-body"]`;
        await app.body("A").evalJS<boolean>(
          `document.querySelector(${JSON.stringify(BODY)})
             .setAttribute("data-at0333-mount", "before"), true`,
        );

        const bandFor = (id: string | null) =>
          `${FILE_ROW} [data-slot="diff-hunk"][data-hunk-id="${id}"]`;
        const isCollapsed = async (): Promise<boolean> =>
          app.body("A").evalJS<boolean>(
            `document.querySelector(${JSON.stringify(
              `${bandFor(lastId)}[data-collapsed="true"]`,
            )}) !== null`,
          );
        // The band has to be on screen before it can be clicked: the harness
        // clicks the centre of an element's rect and does not scroll, so a
        // band below the fold takes the click at a point outside the window.
        // Retried against the band's own collapsed bit for the same reason the
        // row's fold cue is — an aggregate recompute between the measure and
        // the hit lands the click on nothing, and re-clicking while still
        // expanded cannot toggle it back open.
        for (let attempt = 0; attempt < 4; attempt += 1) {
          if (await isCollapsed()) break;
          await app.body("A").evalJS<boolean>(
            `document.querySelector(${JSON.stringify(bandFor(lastId))})
               .scrollIntoView({ block: "center" }), true`,
          );
          await settle(300);
          await app.body("A").nativeClickAtElement(
            `${bandFor(lastId)} .tugx-diff-hunk-header`,
          );
          await settle(500);
        }
        expect(await isCollapsed()).toBe(true);

        writeMarkers("all");
        writeFileSync(scratchPath, "at0333 scratch\n");
        await app.body("A").waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(
            `${FILE_ROW} [data-slot="diff-hunk"]`,
          )}).length === 3`,
          { timeoutMs: 25000 },
        );

        // The folded band is still folded, and it is still the same hunk —
        // matched by id, which is now the third slot rather than the second.
        const after = await app.body("A").evalJS<{
          collapsed: string | null;
          index: string | null;
          mount: string | null;
        }>(
          `(() => {
             const band = document.querySelector(${JSON.stringify(
               bandFor(lastId),
             )});
             const body = document.querySelector(${JSON.stringify(BODY)});
             return {
               collapsed: band === null ? null : band.getAttribute("data-collapsed"),
               index: band === null ? null : band.getAttribute("data-hunk-index"),
               mount: body === null ? null : body.getAttribute("data-at0333-mount"),
             };
           })()`,
        );
        note("after recompose", after);
        // The stamp survives only on the original node — a remount would have
        // replaced it with a fresh one carrying no attribute ([L26]).
        expect(after.mount).toBe("before");
        expect(after.collapsed).toBe("true");
        expect(after.index).toBe("2");
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
