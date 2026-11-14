/**
 * text-card-join-fixture.ts — the shared repository, launch and readers the
 * at0460-text-card-join-* files drive a Text card through a join with.
 *
 * Git replacing a Text card's file in place is a content change, never a
 * delete dialog.
 *
 * ## Why this exists
 *
 * Joining an arc ran `git merge --squash` on the worktree a Text card had a
 * file open in. Git replaces a file by unlinking and recreating it, which
 * FSEvents delivers as a same-path `Remove` + `Create` in one batch, and the
 * card read that pair as "the file was deleted by another application" — a
 * modal sheet whose default button would have written the pre-join buffer back
 * over the merged content.
 *
 * ## Why it cannot pass vacuously
 *
 * A Text card alone opens no workspace, and registering one is not enough
 * either: every `WorkspaceEntry` builds an `fs_watch_rx`, but `main.rs` hands
 * exactly one of them to the router — the bootstrap, i.e. the source tree — so
 * that workspace is the only one whose FILESYSTEM frames a client ever
 * receives. A fixture living anywhere else produces **no frames at all**, and a
 * test that asserted only "no dialog appeared" over that would pass while
 * proving nothing. Two things keep this honest: the fixture repo is built
 * inside the watched root (see FIXTURE_HOME), and a warm-up makes the card
 * observe two real changes to its own file before any scenario runs. The clean
 * scenario then asserts **positively** that the editor adopted the merged
 * bytes, so an absent feed fails this test rather than passing it.
 *
 * ## Test matrix
 *
 *   1. **Clean buffer, manual mode.** A real `git merge --squash` + commit
 *      under an open, unedited card: the editor shows the merged content and
 *      neither a sheet nor a banner appears.
 *   2. **Dirty buffer, manual mode.** The same merge with unsaved edits: the
 *      hash-conflict sheet ("was changed by another application"), never the
 *      "was deleted" one, and the merged bytes survive on disk.
 *   3. **A joined arc worktree.** The worktree a card is bound inside is
 *      removed whole; the card re-anchors to the repo-root successor.
 *   4. **A real delete.** Still verdicts after the settle window — as the
 *      non-modal banner, because nothing was at risk — and the verdict clears
 *      by itself when the file comes back.
 *
 * Each at0460-text-card-join file launches into its own app on its own
 * fixture repository; what they share is how that repository is built, how the
 * card is brought up on it, and how the card's verdicts are read.
 *
 * @module tests/app-test/text-card-join-fixture
 */

import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import { gitRetry } from "./arc-fixture";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 240_000;

/** This checkout — the build under test, never the tree the fixture mutates. */
export const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

export const DOC = "doc.txt";
export const FORK_BODY = "fork line one\nfork line two\nfork line three\n";
export const MERGED_BODY = "MERGED line one\nMERGED line two\nMERGED line three\n";
export const WARMUP_BODY = "WARMUP marker\n";

export const EDITOR = '[data-card-id="B"] [data-slot="tug-text-card-editor"] .cm-content';
export const SAVE_SHEET = '[data-slot="file-save-sheet"]';
export const CONFLICT_BANNER = '[data-testid="text-card-conflict-reload"]';
export const MISSING_BANNER = '[data-testid="text-card-missing-close"]';

export interface Fixture {
  repo: string;
  dataRoot: string;
  file: string;
}

/**
 * Where the fixture repository goes, and why it cannot go in `os.tmpdir()`.
 *
 * A client only ever receives FILESYSTEM frames for the bootstrap workspace —
 * `main.rs` hands the router exactly one `fs_watch_rx`, and it is the source
 * tree's. Under the app-test harness the source tree is this checkout, so the
 * fixture has to live inside it to be watched at all.
 *
 * `.tug/` is the one place that is both inside the watched root and invisible
 * to git (it is gitignored — it is where arc worktrees live), so a repository
 * here leaves the checkout clean. The watcher does not gitignore-filter, so its
 * events flow regardless; only `FileTreeFeed`'s index walk respects gitignore.
 */
export const FIXTURE_HOME = join(CHECKOUT, ".tug");

// Kept local: a git repository with a fork and a feature branch, not the
// one-file temp directory `mkTextFixture` in `_harness/fixtures.ts` makes.
/**
 * A repository whose `main` holds the fork body and whose `feature` branch
 * holds the merged one — so the test itself performs the squash, with real git
 * doing the unlink-and-recreate the card has to survive.
 */
export function mkFixture(prefix: string): Fixture {
  mkdirSync(FIXTURE_HOME, { recursive: true });
  const repo = realpathSync(mkdtempSync(join(FIXTURE_HOME, `${prefix}-`)));
  const dataRoot = realpathSync(mkdtempSync(join(tmpdir(), `${prefix}-data-`)));
  gitRetry(repo, "init", "-b", "main");
  gitRetry(repo, "config", "user.email", "app-test@tugtool.dev");
  gitRetry(repo, "config", "user.name", prefix);
  writeFileSync(join(repo, DOC), FORK_BODY);
  gitRetry(repo, "add", "-A");
  gitRetry(repo, "commit", "-m", `${prefix}: the fork`);
  gitRetry(repo, "checkout", "-b", "feature");
  writeFileSync(join(repo, DOC), MERGED_BODY);
  gitRetry(repo, "add", "-A");
  gitRetry(repo, "commit", "-m", `${prefix}: the feature rewrites it`);
  gitRetry(repo, "checkout", "main");
  return { repo, dataRoot, file: join(repo, DOC) };
}

/** The squash a join performs on the main worktree. */
export function squashMerge(repo: string): void {
  gitRetry(repo, "merge", "--squash", "feature");
  gitRetry(repo, "commit", "-m", "at0460: the join lands");
}

export function deckShape() {
  return {
    cards: [
      { id: "A", componentId: "session", title: "Session", closable: true },
      { id: "B", componentId: "text", title: "File", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 700, height: 520 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
      {
        id: "p2",
        position: { x: 780, y: 40 },
        size: { width: 700, height: 520 },
        cardIds: ["B"],
        activeCardId: "B",
        title: "",
        acceptsFamilies: ["standard"],
      },
    ],
    activePaneId: "p2",
    hasFocus: true,
  };
}

/**
 * Bring up the app on the checkout — the bootstrap workspace the fixture repo
 * sits inside — with a Text card open on the document, in manual save mode:
 * the shipping default, and the mode whose verdict is the modal sheet this
 * test is about.
 */
export async function launchOnFixture(
  fixture: Fixture,
  testName: string,
  opts?: { openFile?: string; sentinel?: string; body?: string },
) {
  const openFile = opts?.openFile ?? fixture.file;
  const sentinel = opts?.sentinel ?? "fork line one";
  const body = opts?.body ?? FORK_BODY;
  const tugbankPath = mkTempTugbank();
  // The source tree stays this checkout — it is the bootstrap workspace whose
  // FILESYSTEM frames reach the client, and the fixture repo lives inside it
  // (see FIXTURE_HOME). Pointing it at the fixture instead does not boot: the
  // deck never finishes mounting and `window.__tug` is never installed.
  seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
  const app = await launchTugApp({
    testName,
    env: { TUGBANK_PATH: tugbankPath, TUG_DATA_DIR: fixture.dataRoot },
  });
  await app.evalJS<null>(
    `(window.__tug.setTugbankValue("dev.tugapp.text-card","save-mode",{kind:"string",value:"manual"}), null)`,
  );
  await app.seedDeckState({
    state: deckShape(),
    cardStates: {
      B: {
        content: { path: openFile, anchor: { line: 1, ch: 0 }, scrollTop: 0 },
      },
    },
    focusCardId: "B",
  });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
  );
  note(`at0460 fixture repo: ${fixture.repo}`);
  await waitForEditorShowing(app, sentinel);
  await warmUpWatcher(app, openFile, body, sentinel);
  return { app, tugbankPath };
}

/**
 * Prove the FILESYSTEM feed actually reaches this card before the scenario
 * depends on it.
 *
 * Being the bootstrap workspace gets the frames routed, but it does not say
 * when the watcher is delivering. So this waits on the card observing two real
 * changes to its own file: an external rewrite it adopts, and the original
 * body written back. Until both land there is nothing watching, and every
 * assertion after this point would be vacuous.
 *
 * The restore writes identical bytes, so a tracked file ends the warm-up clean
 * in git's eyes and the scenario's merge has nothing to object to.
 */
export async function warmUpWatcher(
  app: App,
  file: string,
  body: string,
  sentinel: string,
): Promise<void> {
  writeFileSync(file, WARMUP_BODY);
  await waitForEditorShowing(app, "WARMUP marker", 60000);
  writeFileSync(file, body);
  await app.body("B").waitForCondition<boolean>(
    `(function(){
      var el = document.querySelector('${EDITOR}');
      if (el === null) return false;
      var t = el.innerText;
      return t.indexOf(${JSON.stringify(sentinel)}) !== -1
        && t.indexOf("WARMUP marker") === -1;
    })()`,
    { timeoutMs: 20000 },
  );
}

export async function waitForEditorShowing(
  app: App,
  sentinel: string,
  timeoutMs = 15000,
): Promise<void> {
  await app.body("B").waitForCondition<boolean>(
    `(function(){
      var el = document.querySelector('${EDITOR}');
      return el !== null && el.innerText.indexOf(${JSON.stringify(sentinel)}) !== -1;
    })()`,
    { timeoutMs },
  );
}

/** Every save sheet's title text, or "" when no sheet is up. */
export async function sheetTitle(app: App): Promise<string> {
  return app.body("B").evalJS<string>(
    `(document.querySelector('${SAVE_SHEET} .tug-alert-title')?.textContent || "")`,
  );
}

export async function anyVerdictShowing(app: App): Promise<boolean> {
  return app.body("B").evalJS<boolean>(
    `(document.querySelector('${SAVE_SHEET}') !== null
      || document.querySelector('${CONFLICT_BANNER}') !== null
      || document.querySelector('${MISSING_BANNER}') !== null)`,
  );
}

export async function typeIntoEditor(app: App, text: string): Promise<void> {
  const ok = await app.body("B").evalJS<boolean>(
    `(function(){
      var el = document.querySelector('${EDITOR}');
      if (!el) return false;
      el.focus();
      return document.execCommand("insertText", false, ${JSON.stringify(text)});
    })()`,
  );
  if (!ok) throw new Error("[at0460] typeIntoEditor: insertText was not handled");
}

export const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
