/**
 * at0858-staged-stranger-unstage-and-commit.test.ts — **a commit the index
 * stands in the way of says which files, and one press clears them.**
 *
 * ## What this is
 *
 * The incident is from 2026-11-18. A `/commit` that landed part of a file was
 * refused because other paths sat in the index, and the card answered with a
 * title cut off at "Some files are already sta…", a centred paragraph, a
 * centred block of twenty-two monospace paths wrapped mid-filename, and a red
 * **Retry commit** button that could only earn the same refusal again. Nothing
 * on the card could fix what the card was complaining about.
 *
 * So this file makes the real refusal over a real press. The scratch repo gets
 * a three-hunk edit through the card's own shell, one hunk is unchecked in the
 * shade — which is what makes the landing a hunk election — and a second
 * tracked file is staged behind the card's back with plain `git add`. Nothing
 * is published and no frame is faked: the engine finds the stranger in the
 * index and tugcast relays it as `changeset_commit_err` with `staged`.
 *
 * ## The four things it proves
 *
 *   1. **The refusal names the paths as rows.** The band lists the staged file
 *      with what is staged for it, read from the wire's `staged` array rather
 *      than out of a sentence, and there is no folded block of git prose.
 *   2. **The title is whole.** It wraps rather than truncates, so its box is
 *      never narrower than its text, and the remedy under it is set left.
 *   3. **The act fits the cause.** The one filled button is Unstage and
 *      Commit. There is no Retry, because the same press again would be
 *      refused in the same words.
 *   4. **The press lands the election and nothing else.** HEAD takes the two
 *      elected hunks of the work file; the unelected hunk is still dirty; the
 *      stranger is no longer staged and its working-tree bytes are untouched.
 *
 * ## Why the stranger is staged after the claim
 *
 * Claim all takes every unattributed dirty file onto the card's line. A
 * stranger staged before it would be claimed with the rest, land whole as
 * part of the commit's own file set, and refuse nothing — which is the
 * narrowing this work made, and correct. So the stranger goes into the index
 * after the claim, a beat before the press, the way the lock does in `at0530`.
 *
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-notice.tsx
 * @covers tugdeck/src/components/tugways/cards/session-changes/session-changes-notice-face.ts
 * @covers tugdeck/src/lib/landing-notice.ts
 * @covers tugdeck/src/lib/commit-mode-controller.ts
 * @covers tugrust/crates/tugchanges-core/src/commit.rs
 * @covers tugrust/crates/tugcast/src/feeds/agent_supervisor/control/changeset.rs
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import { sessionCardShape } from "./_harness/shapes";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import {
  makeArcScratchRepo,
  rmArcScratchRepo,
  rmScratchSession,
  seedScratchSession,
  tugtoolPath,
  type ArcScratchRepo,
} from "./arc-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 300_000;

const SID = "a7c0d1ea-0000-4000-8000-000000000858";
const WORK_FILE = "at0858-work.txt";
const STRANGER_FILE = "at0858-stranger.txt";
const DIRTY_SCRIPT = "at0858-dirty.sh";
const SUBJECT = "at0858 land two hunks and leave the stranger";

const CARD = '[data-card-id="A"]';
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const COMMIT_BUTTON = `${CARD} [data-testid="tug-prompt-entry-commit-button"]`;
const COMMIT_SHEET = `${CARD} .session-view-pane[data-view="changes"] [data-slot="tug-sheet"]`;
const CLAIM_ALL = `${CARD} [data-testid="tug-changes-list-claim-all-unattributed"]`;
const WORK_ROW =
  `${COMMIT_SHEET} [data-entry-kind="session"] ` +
  `[data-testid="tug-changes-list-file-block"][data-path="${WORK_FILE}"]`;
const BOXES = `${WORK_ROW} [data-testid="tug-changes-list-hunk-elect"]`;
const PARTIAL_BADGE = `${WORK_ROW} [data-testid="tug-changes-list-file-partial"]`;
const NOTICE = `${CARD} [data-slot="session-changes-notice"]`;
const ERROR_NOTICE = `${NOTICE}[data-channel="error"]`;
const STAGED_ROWS = `${ERROR_NOTICE} [data-testid="session-landing-notice-staged"] li`;
const UNSTAGE = `${CARD} [data-testid="session-landing-notice-unstage"]`;
const RETRY = `${CARD} [data-testid="session-landing-notice-retry"]`;

/** This checkout — the build under test, never the tree the fixture dirties. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

let scratch: ArcScratchRepo | null = null;
let fixtureDir: string | null = null;
const projectDir = (): string => scratch?.repo ?? "";

const git = (...args: string[]): string =>
  execFileSync("git", args, { cwd: projectDir(), encoding: "utf8" });

beforeAll(() => {
  if (!SHOULD_RUN) return;
  scratch = makeArcScratchRepo({ prefix: "at0858", checkout: CHECKOUT });
  // Sixty lines, so three edits far apart are three hunks at any context
  // width, and a script that makes them — committed, so running it through
  // `file run` dirties the work file and nothing else.
  const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n");
  writeFileSync(join(projectDir(), WORK_FILE), `${lines}\n`);
  writeFileSync(join(projectDir(), STRANGER_FILE), "at0858 stranger baseline\n");
  writeFileSync(
    join(projectDir(), DIRTY_SCRIPT),
    `sed -i '' -e '3s/$/ at0858-A/' -e '30s/$/ at0858-B/' -e '57s/$/ at0858-C/' ${WORK_FILE}\n`,
  );
  git("add", WORK_FILE, STRANGER_FILE, DIRTY_SCRIPT);
  git("commit", "-m", "at0858: seed the work file, the stranger and the edit script");
  fixtureDir = seedScratchSession(projectDir(), SID);
});

afterAll(() => {
  if (!SHOULD_RUN) return;
  rmArcScratchRepo(scratch);
  if (fixtureDir !== null) rmScratchSession(fixtureDir);
});

const settle = (ms = 400): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll a read of the scratch repo until it holds, or throw with its own sentence. */
async function waitForRepo(
  what: string,
  holds: () => boolean,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!holds()) {
    if (Date.now() >= deadline) {
      throw new Error(`at0858: ${what} did not happen within ${timeoutMs}ms`);
    }
    await settle(250);
  }
}

/** Run a shell command on the card through its own `$` route. */
async function shell(app: App, command: string): Promise<void> {
  await app.body("A").nativeClickAtElement(PROMPT_INPUT);
  await app.nativeType(`/shell ${command}`);
  await settle(150);
  await app.nativeKey("Enter", ["cmd"]);
}

/** Raise the Changes shade in commit mode: type, dismiss the popup, ⌘⏎. */
async function openCommitShade(app: App): Promise<void> {
  await app.body("A").nativeClickAtElement(PROMPT_INPUT);
  await app.nativeType("/commit");
  await settle();
  await app.nativeKey("Escape");
  await settle();
  await app.nativeKey("Return", ["cmd"]);
  await app.body("A").waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(COMMIT_SHEET)}) !== null &&
     document.querySelector(${JSON.stringify(COMMIT_BUTTON)}) !== null`,
    { timeoutMs: 20_000 },
  );
}

describe.skipIf(!SHOULD_RUN)("AT0858: a staged stranger is named, and one press clears it", () => {
  test(
    "the band lists the staged file, offers Unstage and Commit, and the press lands the election",
    async () => {
      const tugbankPath = mkTempTugbank();
      seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
      const app = await launchTugApp({
        testName: "at0858-staged-stranger-unstage-and-commit",
        env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: scratch?.dataRoot ?? "" },
      });
      const cli = tugtoolPath(CHECKOUT);
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: sessionCardShape({ width: 980, height: 760 }), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
          { timeoutMs: 30_000 },
        );
        await app.spawnSessionResume("A", { tugSessionId: SID, projectDir: projectDir() });
        await app.awaitEngineReady("A", { timeoutMs: 30_000 });

        // ── Three hunks on the card's line ───────────────────────────────
        await shell(app, `${cli} file run -- sh ${DIRTY_SCRIPT}`);
        await waitForRepo("the in-app edit of the work file", () =>
          git("status", "--porcelain").includes(WORK_FILE),
        );

        await openCommitShade(app);
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CLAIM_ALL)}) !== null`,
          { timeoutMs: 20_000 },
        );
        await app.body("A").nativeClickAtElement(CLAIM_ALL);
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(WORK_ROW)}) !== null`,
          { timeoutMs: 30_000 },
        );

        // ── The election: uncheck the middle hunk ────────────────────────
        const isExpanded = (): Promise<boolean> =>
          app.body("A").evalJS<boolean>(
            `document.querySelector(${JSON.stringify(`${WORK_ROW}[data-expanded="true"]`)}) !== null`,
          );
        for (let attempt = 0; attempt < 4; attempt += 1) {
          if (await isExpanded()) break;
          await app.body("A").nativeClickAtElement(`${WORK_ROW} [data-slot="tug-changes-list-fold"]`);
          await settle(500);
        }
        expect(await isExpanded(), "the work file's row opened").toBe(true);
        await app.body("A").waitForCondition<boolean>(
          `document.querySelectorAll(${JSON.stringify(BOXES)}).length === 3`,
          { timeoutMs: 25_000 },
        );
        const middle =
          `${WORK_ROW} [data-slot="diff-hunk"]:nth-of-type(2) ` +
          `[data-testid="tug-changes-list-hunk-elect"]`;
        await app.body("A").evalJS<boolean>(
          `document.querySelector(${JSON.stringify(middle)}).scrollIntoView({ block: "center" }), true`,
        );
        await settle(300);
        await app.body("A").nativeClickAtElement(middle);
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(PARTIAL_BADGE)})?.textContent === "2 of 3 hunks"`,
          { timeoutMs: 15_000 },
        );

        await app.body("A").nativeClickAtElement(PROMPT_INPUT);
        await app.nativeType(SUBJECT);
        await settle(1_000);

        // ── The stranger, and the press ──────────────────────────────────
        writeFileSync(join(projectDir(), STRANGER_FILE), "at0858 stranger, edited and staged\n");
        git("add", STRANGER_FILE);
        await app.body("A").waitForCondition<boolean>(
          `(function(){
             const b = document.querySelector(${JSON.stringify(COMMIT_BUTTON)});
             return b !== null && !b.hasAttribute("data-land-blocked");
           })()`,
          { timeoutMs: 30_000 },
        );
        await app.body("A").nativeClickAtElement(COMMIT_BUTTON);
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(ERROR_NOTICE)}) !== null`,
          { timeoutMs: 30_000 },
        );
        // At rest: the failure re-enters the mode and the shade slides back in.
        await settle(1_200);
        note("at0858 the refusal in the shade", (await app.screenshot()).path);

        const band = await app.body("A").evalJS<{
          tone: string | null;
          title: string;
          titleFits: boolean;
          remedyAlign: string;
          rows: string[];
          unstage: string | null;
          retry: boolean;
          evidence: boolean;
        }>(
          `(function(){
             const root = document.querySelector(${JSON.stringify(ERROR_NOTICE)});
             const title = root.querySelector(".tug-inline-dialog-title");
             const remedy = root.querySelector(".tug-inline-dialog-description");
             return {
               tone: root.getAttribute("data-tone"),
               title: title.textContent || "",
               titleFits: title.scrollWidth <= title.clientWidth + 1,
               remedyAlign: remedy === null ? "(none)" : getComputedStyle(remedy).textAlign,
               rows: Array.from(document.querySelectorAll(${JSON.stringify(STAGED_ROWS)}))
                 .map(function(li){ return Array.from(li.children).map(function(c){ return c.textContent; }).join(" | "); }),
               unstage: document.querySelector(${JSON.stringify(UNSTAGE)})?.textContent ?? null,
               retry: document.querySelector(${JSON.stringify(RETRY)}) !== null,
               evidence: root.querySelector("details.session-changes-notice-evidence") !== null,
             };
           })()`,
        );
        note(`at0858 the band: ${JSON.stringify(band)}`);

        // 1. The paths are rows, read from data.
        expect(band.rows, "the staged file is a row, with what is staged for it").toEqual([
          `${STRANGER_FILE} | modified`,
        ]);
        expect(band.evidence, "no folded block of git prose stands in for the rows").toBe(false);
        // 2. The title is whole, and the remedy is set left.
        expect(band.title).toBe("1 staged file would ride along with this commit");
        expect(band.titleFits, "the title wraps rather than truncating").toBe(true);
        expect(["start", "left"]).toContain(band.remedyAlign);
        expect(band.tone, "nothing is broken: the commit waited").toBe("caution");
        // 3. The act fits the cause.
        expect(band.unstage?.toLowerCase()).toBe("unstage and commit");
        expect(band.retry, "no Retry where the same press earns the same refusal").toBe(false);
        expect(git("log", "-1", "--format=%s").trim(), "nothing was committed").not.toBe(SUBJECT);
        expect(git("diff", "--cached", "--name-only").trim(), "the refusal left the index alone").toBe(
          STRANGER_FILE,
        );

        // 4. The press lands the election and nothing else.
        await app.body("A").nativeClickAtElement(UNSTAGE);
        await waitForRepo("the unstage-and-commit landing", () =>
          git("log", "-1", "--format=%s").trim() === SUBJECT,
        );
        const landed = git("show", "--format=", "HEAD");
        expect(git("show", "--name-only", "--format=", "HEAD").trim(), "only the work file landed").toBe(
          WORK_FILE,
        );
        expect(landed).toContain("at0858-A");
        expect(landed).toContain("at0858-C");
        expect(landed, "the unelected hunk stayed out").not.toContain("at0858-B");
        expect(git("diff", "--cached", "--name-only").trim(), "nothing is left staged").toBe("");
        expect(git("diff", "--", WORK_FILE), "the unelected hunk is still dirty").toContain("at0858-B");
        expect(
          readFileSync(join(projectDir(), STRANGER_FILE), "utf8"),
          "unstaging never touched the stranger's bytes",
        ).toBe("at0858 stranger, edited and staged\n");
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(ERROR_NOTICE)}) === null`,
          { timeoutMs: 20_000 },
        );
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
