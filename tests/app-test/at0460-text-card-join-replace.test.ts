/**
 * at0460-text-card-join-replace.test.ts — git replacing a Text card's file
 * in place is a content change, never a delete dialog.
 *
 * ## Why this exists
 *
 * Joining a dash ran `git merge --squash` on the worktree a Text card had a
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
 *   3. **A joined dash worktree.** The worktree a card is bound inside is
 *      removed whole; the card re-anchors to the repo-root successor.
 *   4. **A real delete.** Still verdicts after the settle window — as the
 *      non-modal banner, because nothing was at risk — and the verdict clears
 *      by itself when the file comes back.
 *
 * @covers tugdeck/src/lib/text-card-store.ts
 * @covers tugdeck/src/lib/file-io.ts
 * @covers tugdeck/src/components/tugways/cards/text-card.tsx
 * @covers tugdeck/src/components/tugways/cards/text-card-save-sheets.tsx
 * @covers tugrust/crates/tugcast/src/feeds/file_watcher.rs
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";
import { gitRetry } from "./dash-fixture";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

/** This checkout — the build under test, never the tree the fixture mutates. */
const CHECKOUT = realpathSync(resolve(import.meta.dir, "..", ".."));

const DOC = "doc.txt";
const FORK_BODY = "fork line one\nfork line two\nfork line three\n";
const MERGED_BODY = "MERGED line one\nMERGED line two\nMERGED line three\n";
const WARMUP_BODY = "WARMUP marker\n";

const EDITOR = '[data-card-id="B"] [data-slot="tug-text-card-editor"] .cm-content';
const SAVE_SHEET = '[data-slot="file-save-sheet"]';
const CONFLICT_BANNER = '[data-testid="text-card-conflict-reload"]';
const MISSING_BANNER = '[data-testid="text-card-missing-close"]';

interface Fixture {
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
 * to git (it is gitignored — it is where dash worktrees live), so a repository
 * here leaves the checkout clean. The watcher does not gitignore-filter, so its
 * events flow regardless; only `FileTreeFeed`'s index walk respects gitignore.
 */
const FIXTURE_HOME = join(CHECKOUT, ".tug");

/**
 * A repository whose `main` holds the fork body and whose `feature` branch
 * holds the merged one — so the test itself performs the squash, with real git
 * doing the unlink-and-recreate the card has to survive.
 */
function mkFixture(prefix: string): Fixture {
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
function squashMerge(repo: string): void {
  gitRetry(repo, "merge", "--squash", "feature");
  gitRetry(repo, "commit", "-m", "at0460: the join lands");
}

function deckShape() {
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
async function launchOnFixture(
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
    `(window.__tug.setTugbankValue("dev.tugtool.text-card","save-mode",{kind:"string",value:"manual"}), null)`,
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
async function warmUpWatcher(
  app: App,
  file: string,
  body: string,
  sentinel: string,
): Promise<void> {
  writeFileSync(file, WARMUP_BODY);
  await waitForEditorShowing(app, "WARMUP marker", 60000);
  writeFileSync(file, body);
  await app.waitForCondition<boolean>(
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

async function waitForEditorShowing(
  app: App,
  sentinel: string,
  timeoutMs = 15000,
): Promise<void> {
  await app.waitForCondition<boolean>(
    `(function(){
      var el = document.querySelector('${EDITOR}');
      return el !== null && el.innerText.indexOf(${JSON.stringify(sentinel)}) !== -1;
    })()`,
    { timeoutMs },
  );
}

/** Every save sheet's title text, or "" when no sheet is up. */
async function sheetTitle(app: App): Promise<string> {
  return app.evalJS<string>(
    `(document.querySelector('${SAVE_SHEET} .tug-alert-title')?.textContent || "")`,
  );
}

async function anyVerdictShowing(app: App): Promise<boolean> {
  return app.evalJS<boolean>(
    `(document.querySelector('${SAVE_SHEET}') !== null
      || document.querySelector('${CONFLICT_BANNER}') !== null
      || document.querySelector('${MISSING_BANNER}') !== null)`,
  );
}

async function typeIntoEditor(app: App, text: string): Promise<void> {
  const ok = await app.evalJS<boolean>(
    `(function(){
      var el = document.querySelector('${EDITOR}');
      if (!el) return false;
      el.focus();
      return document.execCommand("insertText", false, ${JSON.stringify(text)});
    })()`,
  );
  if (!ok) throw new Error("[at0460] typeIntoEditor: insertText was not handled");
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

let openFixture: Fixture | null = null;
let openTugbank = "";

afterEach(() => {
  if (!SHOULD_RUN) return;
  if (openFixture !== null) {
    rmSync(openFixture.repo, { recursive: true, force: true });
    rmSync(openFixture.dataRoot, { recursive: true, force: true });
    openFixture = null;
  }
  if (openTugbank !== "") {
    rmTempTugbank(openTugbank);
    openTugbank = "";
  }
});

describe.skipIf(!SHOULD_RUN)("AT0460: a join replaces a card's file in place", () => {
  test(
    "a clean card adopts the merged content with no dialog",
    async () => {
      const fixture = mkFixture("at0460-clean");
      openFixture = fixture;
      const { app, tugbankPath } = await launchOnFixture(
        fixture,
        "at0460-join-replace-clean",
      );
      openTugbank = tugbankPath;
      try {
        squashMerge(fixture.repo);

        // Positive proof that a FILESYSTEM frame arrived and drove a reload:
        // the editor holds bytes only the merge could have put there.
        await waitForEditorShowing(app, "MERGED line one");
        expect(await anyVerdictShowing(app)).toBe(false);

        // And it stays quiet past the settle window, which is the only place
        // a deferred missing verdict could still surface.
        await settle(1500);
        expect(await anyVerdictShowing(app)).toBe(false);
        expect(readFileSync(fixture.file, "utf8")).toBe(MERGED_BODY);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a dirty card is asked about the hash, never told the file was deleted",
    async () => {
      const fixture = mkFixture("at0460-dirty");
      openFixture = fixture;
      const { app, tugbankPath } = await launchOnFixture(
        fixture,
        "at0460-join-replace-dirty",
      );
      openTugbank = tugbankPath;
      try {
        await typeIntoEditor(app, "UNSAVED-EDIT ");
        await app.waitForCondition<boolean>(
          `(function(){
            var el = document.querySelector('${EDITOR}');
            return el !== null && el.innerText.indexOf("UNSAVED-EDIT") !== -1;
          })()`,
          { timeoutMs: 8000 },
        );

        squashMerge(fixture.repo);

        await app.waitForCondition<boolean>(
          `document.querySelector('${SAVE_SHEET}') !== null`,
          { timeoutMs: 15000 },
        );
        const title = await sheetTitle(app);
        expect(title).toContain("was changed by another application");
        expect(title).not.toContain("was deleted");

        // The merge is still on disk — the sheet adjudicates, it never wrote.
        expect(readFileSync(fixture.file, "utf8")).toBe(MERGED_BODY);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a card inside a joined dash worktree re-anchors to the repo-root successor",
    async () => {
      // What a join does to a dash's own worktree is remove it whole
      // (`remove_dash_worktree`), which leaves a card bound inside it holding a
      // path that is genuinely gone. This drives that teardown directly rather
      // than through `tugtool dash join`: the join pipeline — resolver, tier
      // checks, candidate — is a different subject, and none of it is what the
      // card reacts to. The directory removal is the real event either way.
      const fixture = mkFixture("at0460-dash");
      openFixture = fixture;
      const worktree = join(fixture.repo, ".tug", "worktrees", "somedash");
      mkdirSync(join(worktree, "src"), { recursive: true });
      const inDash = join(worktree, "src", "work.txt");
      writeFileSync(inDash, "dash line one\ndash line two\n");
      // The successor: the same relative path under the repo root, holding the
      // joined content.
      mkdirSync(join(fixture.repo, "src"), { recursive: true });
      const successor = join(fixture.repo, "src", "work.txt");
      writeFileSync(successor, "SUCCESSOR line one\nSUCCESSOR line two\n");

      const { app, tugbankPath } = await launchOnFixture(
        fixture,
        "at0460-dash-successor",
        {
          openFile: inDash,
          sentinel: "dash line one",
          body: "dash line one\ndash line two\n",
        },
      );
      openTugbank = tugbankPath;
      try {
        rmSync(worktree, { recursive: true, force: true });

        // Positive proof again: the editor can only hold these bytes by having
        // re-anchored to the successor and read it.
        await waitForEditorShowing(app, "SUCCESSOR line one", 30000);
        expect(await anyVerdictShowing(app)).toBe(false);
        await settle(1500);
        expect(await anyVerdictShowing(app)).toBe(false);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a real delete under a clean buffer is a banner, and it clears when the file returns",
    async () => {
      const fixture = mkFixture("at0460-delete");
      openFixture = fixture;
      const { app, tugbankPath } = await launchOnFixture(
        fixture,
        "at0460-delete-banner",
      );
      openTugbank = tugbankPath;
      try {
        // A genuine delete still verdicts — the settle window defers it, it
        // never swallows it.
        rmSync(fixture.file);
        await app.waitForCondition<boolean>(
          `document.querySelector('${MISSING_BANNER}') !== null`,
          { timeoutMs: 20000 },
        );
        // Nothing was at risk, so it is the banner and not the modal sheet.
        expect(
          await app.evalJS<boolean>(
            `document.querySelector('${SAVE_SHEET}') !== null`,
          ),
        ).toBe(false);

        // Someone puts the file back. No gesture from the user.
        writeFileSync(fixture.file, "RESTORED line one\nRESTORED line two\n");
        await app.waitForCondition<boolean>(
          `document.querySelector('${MISSING_BANNER}') === null`,
          { timeoutMs: 20000 },
        );
        await waitForEditorShowing(app, "RESTORED line one");
        expect(await anyVerdictShowing(app)).toBe(false);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
