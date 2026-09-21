/**
 * at0209-text-card-live-autosave.test.ts — Text card core loop
 * ([AT0209]): open a real file from disk, live autosave-in-place,
 * conflict adjudication, and quit-flush + relaunch restore.
 *
 * ## Scenarios
 *
 * 1. **Open → edit → autosave → conflict → reload.** Seeds a Text card
 *    bound to a real temp fixture, asserts the editor renders the disk
 *    content, types into the editor and asserts the edit lands ON DISK
 *    within the autosave window (no explicit save), then writes the
 *    file externally + types again and asserts the hash-conditional
 *    write raises the conflict banner instead of clobbering; "Reload
 *    from Disk" adopts the external content and clears the banner.
 *
 * 2. **Quit-flush + relaunch.** Types an edit and quits INSIDE the
 *    debounce window; asserts the deactivation/teardown flush landed
 *    the edit on disk after process exit. A second app process re-opens
 *    the file and shows the flushed content.
 *
 * 3b. **A reload that lands in the frame of the scroll.** The same
 *    viewport hold with no frame between the scroll and the reload, so
 *    CM6 has not measured the new offset when the change is dispatched.
 *    Carries a per-frame sampler of the top line, and asserts the text
 *    held on every frame rather than only on the last one — the hop
 *    used to happen and self-correct, which is what made Scenario 3
 *    marginal.
 *
 * 4. **Undo after a reload.** A reload is not an undo step: a clean
 *    buffer adopts an external change silently, and one ⌘Z afterwards
 *    removes the user's own typing and nothing else — the reloaded
 *    lines stay. The second case has nothing typed at all, so undo has
 *    nothing to offer and the buffer still equals disk. This is the
 *    guard on the automatic-mode hazard: an undo that resurrected the
 *    pre-reload text would be written straight back over the external
 *    editor's work.
 *
 * Everything drives real code paths on real files: the fixture is a
 * real temp file, autosave goes through tugcast's `/api/fs/write`, and
 * the assertions read disk with Bun's fs — no mocks anywhere.
 *
 * Input path: edits are driven by focusing CM6's contenteditable and
 * running `document.execCommand("insertText")`, which fires the REAL
 * beforeinput → CM6 input pipeline (the same handler keystrokes reach).
 * Native CGEvent typing needs the app frontmost, which unattended
 * sweeps can't guarantee; the editor's input handling itself is not
 * what this test gates — the autosave loop is.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/cards/text-card.tsx
 * @covers tugdeck/src/lib/text-card-store.ts
 * @covers tugdeck/src/lib/file-io.ts
 * @covers tugdeck/src/components/tugways/tug-text-card-editor/
 * @covers tugdeck/src/components/tugways/tug-text-card-editor.css
 * @covers tugdeck/src/components/tugways/tug-text-card-editor.tsx
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const TEST_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const FIXTURE_LINES: ReadonlyArray<string> = Array.from(
  { length: 24 },
  (_, i) => `fixture line ${String(i + 1).padStart(2, "0")} alpha beta gamma`,
);
const FIXTURE_CONTENT = FIXTURE_LINES.join("\n") + "\n";

function mkFixture(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "at0209-"));
  const file = path.join(dir, "sample.txt");
  fs.writeFileSync(file, FIXTURE_CONTENT, "utf8");
  return { dir, file };
}

function rmFixture(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Deck seeding
// ---------------------------------------------------------------------------

const EDITOR_CONTENT_SELECTOR =
  '[data-card-id="A"] [data-slot="tug-text-card-editor"] .cm-content';

const EDITOR_SCROLLER_SELECTOR =
  '[data-card-id="A"] [data-slot="tug-text-card-editor"] .cm-scroller';

// A tall fixture — enough lines to scroll well past the 560px pane so a
// nonzero scrollTop is a real viewport offset, not a rounding artifact.
const TALL_LINES: ReadonlyArray<string> = Array.from(
  { length: 200 },
  (_, i) => `tall line ${String(i + 1).padStart(3, "0")} alpha beta gamma delta`,
);
const TALL_CONTENT = TALL_LINES.join("\n") + "\n";

function mkTallFixture(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "at0209-tall-"));
  const file = path.join(dir, "tall.txt");
  fs.writeFileSync(file, TALL_CONTENT, "utf8");
  return { dir, file };
}

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "text", title: "File", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 760, height: 560 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["standard"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

/**
 * Seed the deck-wide save-mode default to "automatic" BEFORE the card
 * mounts. Manual is now the shipping default ([P01]); this test exercises
 * the retained automatic live-autosave path, so it opts in explicitly —
 * `setTugbankValue` populates the same client cache `readSaveMode` reads.
 */
async function seedAutomaticSaveMode(app: App): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.setTugbankValue("dev.tugapp.text-card","save-mode",{kind:"string",value:"automatic"}), null)`,
  );
}

async function seedTextCard(app: App, filePath: string): Promise<void> {
  await seedAutomaticSaveMode(app);
  await app.seedDeckState({
    state: deckShape(),
    cardStates: {
      A: {
        content: {
          path: filePath,
          anchor: { line: 1, ch: 0 },
          scrollTop: 0,
        },
      },
    },
    focusCardId: "A",
  });
}

/** Wait until the editor is mounted and renders a sentinel line. */
async function waitForEditorShowing(
  app: App,
  sentinel: string,
  timeoutMs = 8000,
): Promise<void> {
  await app.waitForCondition<boolean>(
    `(function(){
      var el = document.querySelector('${EDITOR_CONTENT_SELECTOR}');
      return el !== null && el.innerText.indexOf(${JSON.stringify(sentinel)}) !== -1;
    })()`,
    { timeoutMs },
  );
}

/**
 * Type into the editor through CM6's real input pipeline: focus the
 * contenteditable and insert via `execCommand("insertText")`, which
 * fires beforeinput exactly like a keystroke.
 */
async function typeIntoEditor(app: App, text: string): Promise<void> {
  const ok = await app.evalJS<boolean>(
    `(function(){
      var el = document.querySelector('${EDITOR_CONTENT_SELECTOR}');
      if (!el) return false;
      el.focus();
      return document.execCommand("insertText", false, ${JSON.stringify(text)});
    })()`,
  );
  if (!ok) {
    throw new Error("[at0209] typeIntoEditor: insertText was not handled");
  }
}

/**
 * Undo once through the control action, never the ⌘Z chord: CM6's keymap
 * eats the chord before the menu bar sees it (`at0174` records why), and
 * this file's own docblock rules out native key events unattended. The
 * editor is focused first so the action resolves to this card.
 */
async function undoOnce(app: App): Promise<void> {
  await app.evalJS<null>(
    `(function(){
      var el = document.querySelector('${EDITOR_CONTENT_SELECTOR}');
      if (el !== null) el.focus();
      return null;
    })()`,
  );
  await app.evalJS<void>(`window.__tug.dispatchControlAction("undo")`);
}

/** Poll the validated Edit ▸ Undo state until it matches, or time out. */
async function waitForUndoState(
  app: App,
  want: { enabled?: boolean; title?: string },
  timeoutMs = 8000,
): Promise<{ found: boolean; enabled?: boolean; title?: string }> {
  const deadline = Date.now() + timeoutMs;
  let last: { found: boolean; enabled?: boolean; title?: string } = {
    found: false,
  };
  while (Date.now() < deadline) {
    last = await app.menuItemState("edit.undo");
    const okEnabled = want.enabled === undefined || last.enabled === want.enabled;
    const okTitle = want.title === undefined || last.title === want.title;
    if (last.found && okEnabled && okTitle) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return last;
}

/** Poll the real file on disk until `predicate` holds. */
async function waitForDisk(
  file: string,
  predicate: (content: string) => boolean,
  timeoutMs = 8000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    last = fs.readFileSync(file, "utf8");
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `[at0209] disk predicate not satisfied within ${timeoutMs}ms; last content:\n${last.slice(0, 400)}`,
  );
}

// ---------------------------------------------------------------------------
// A fixture the FILESYSTEM watcher actually reaches
// ---------------------------------------------------------------------------
//
// Scenarios 1–3 drive their reloads by hand (the conflict banner's "Reload
// from Disk"), so their fixture can live anywhere. Scenario 4 needs the card
// to hear about an external write on its OWN — and a client only ever
// receives FILESYSTEM frames for the bootstrap workspace, which under the
// harness is this checkout. So the fixture has to sit inside it. `.tug/` is
// the one place that is both inside the watched root and invisible to git
// (it is gitignored — arc worktrees live there), so a fixture here leaves
// the checkout clean; the watcher does not gitignore-filter, so its events
// flow regardless. `at0460` establishes both facts.

const CHECKOUT = fs.realpathSync(path.resolve(import.meta.dir, "..", ".."));
const WATCHED_HOME = path.join(CHECKOUT, ".tug");

/** The autosave debounce the store arms on every keystroke. */
const AUTOSAVE_DEBOUNCE_MS = 1000;

const WARMUP_BODY = "WARMUP marker\n";

function mkWatchedFixture(prefix: string): { dir: string; file: string } {
  fs.mkdirSync(WATCHED_HOME, { recursive: true });
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(WATCHED_HOME, `${prefix}-`)),
  );
  const file = path.join(dir, "sample.txt");
  fs.writeFileSync(file, FIXTURE_CONTENT, "utf8");
  return { dir, file };
}

/**
 * Prove the FILESYSTEM feed reaches this card before anything depends on it.
 *
 * Being inside the bootstrap workspace gets the frames routed; it does not
 * say WHEN the watcher starts delivering. So wait on the card observing two
 * real changes to its own file — an external rewrite it adopts, and the
 * original body written back — and only then start the scenario. Until both
 * land there is nothing watching and every later assertion is vacuous.
 */
async function warmUpWatcher(app: App, file: string): Promise<void> {
  fs.writeFileSync(file, WARMUP_BODY, "utf8");
  await waitForEditorShowing(app, "WARMUP marker", 60_000);
  fs.writeFileSync(file, FIXTURE_CONTENT, "utf8");
  await app.waitForCondition<boolean>(
    `(function(){
      var el = document.querySelector('${EDITOR_CONTENT_SELECTOR}');
      if (el === null) return false;
      var t = el.innerText;
      return t.indexOf("fixture line 01") !== -1 && t.indexOf("WARMUP marker") === -1;
    })()`,
    { timeoutMs: 20_000 },
  );
}

/**
 * Launch on the checkout — the bootstrap workspace the fixture sits inside —
 * with a Text card open on the fixture in automatic save mode, and the
 * watcher proven to be delivering.
 */
async function launchOnWatchedFixture(
  file: string,
  testName: string,
): Promise<{ app: App; tugbankPath: string }> {
  const tugbankPath = mkTempTugbank();
  seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
  const app = await launchTugApp({
    testName,
    env: { TUGBANK_PATH: tugbankPath },
  });
  note(`at0209 watched fixture: ${file}`);
  await seedTextCard(app, file);
  await waitForEditorShowing(app, "fixture line 01");
  await warmUpWatcher(app, file);
  return { app, tugbankPath };
}

/** The rendered buffer text. */
function editorText(app: App): Promise<string> {
  return app.evalJS<string>(
    `document.querySelector('${EDITOR_CONTENT_SELECTOR}').innerText`,
  );
}

// ---------------------------------------------------------------------------
// Scenario 1: open → edit → autosave → conflict → reload
// ---------------------------------------------------------------------------

describe.skipIf(!SHOULD_RUN)("at0209: Text card live autosave", () => {
  test(
    "open, autosave-to-disk, conflict banner, reload-from-disk",
    async () => {
      const { dir, file } = mkFixture();
      const app = await launchTugApp({ testName: "at0209-core-loop" });
      try {
        await seedTextCard(app, file);
        await waitForEditorShowing(app, "fixture line 01");
        // The whole fixture is present (24 short lines all render).
        const rendered = await app.evalJS<string>(
          `document.querySelector('${EDITOR_CONTENT_SELECTOR}').innerText`,
        );
        expect(rendered).toContain("fixture line 24");

        // Type through CM6's real input pipeline, arming the autosave
        // debounce.
        await typeIntoEditor(app, "AUTOSAVED-EDIT ");

        // No explicit save: the debounce flush must land the edit on
        // the real file.
        const afterEdit = await waitForDisk(file, (c) =>
          c.includes("AUTOSAVED-EDIT"),
        );
        expect(afterEdit).toContain("fixture line 24");

        // External change + unflushed local edit → the conditional
        // write must 409 into the conflict banner, and the external
        // content must survive on disk untouched.
        const EXTERNAL = "EXTERNAL-WRITER CONTENT\n" + FIXTURE_CONTENT;
        fs.writeFileSync(file, EXTERNAL, "utf8");
        await typeIntoEditor(app, "LOCAL-EDIT ");
        // The conflict banner is a TugPaneBanner, portaled into the
        // pane chrome — outside the card-id subtree, so the probe is
        // document-wide.
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-testid="text-card-conflict-reload"]') !== null`,
          { timeoutMs: 8000 },
        );
        expect(fs.readFileSync(file, "utf8")).toBe(EXTERNAL);

        // Reload from disk: buffer adopts the external content, the
        // banner clears, autosave resumes cleanly.
        await app.click('[data-testid="text-card-conflict-reload"]');
        await waitForEditorShowing(app, "EXTERNAL-WRITER CONTENT");
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-testid="text-card-conflict-reload"]') === null`,
          { timeoutMs: 6000 },
        );
        expect(fs.readFileSync(file, "utf8")).toBe(EXTERNAL);
      } finally {
        await app.close();
        rmFixture(dir);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Scenario 2: quit inside the debounce window → flush lands → relaunch
  // -------------------------------------------------------------------------

  test(
    "quit-flush inside the debounce window, relaunch re-opens from disk",
    async () => {
      const { dir, file } = mkFixture();

      // Phase A: type and quit immediately — the teardown flush (not
      // the debounce timer) must land the edit.
      {
        const appA = await launchTugApp({ testName: "at0209-quit-A" });
        let closed = false;
        try {
          await seedTextCard(appA, file);
          await waitForEditorShowing(appA, "fixture line 01");
          await typeIntoEditor(appA, "QUIT-FLUSH-EDIT ");
          await appA.quitGracefully();
          closed = true;
        } finally {
          if (!closed) await appA.close();
        }
      }

      const afterQuit = await waitForDisk(
        file,
        (c) => c.includes("QUIT-FLUSH-EDIT"),
        10_000,
      );
      expect(afterQuit).toContain("fixture line 24");

      // Phase B: a fresh process re-opens the file and shows the
      // flushed content (disk is the only source of truth).
      {
        const appB = await launchTugApp({ testName: "at0209-quit-B" });
        try {
          await seedTextCard(appB, file);
          await waitForEditorShowing(appB, "QUIT-FLUSH-EDIT");
        } finally {
          await appB.close();
        }
      }

      rmFixture(dir);
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Scenario 3: in-place reload holds the reader's place
  // -------------------------------------------------------------------------
  //
  // An in-place disk reload (here the conflict-banner "Reload from Disk",
  // which routes through the store's `replaceText` bridge) must leave the
  // TEXT at the top of the viewport where it was. The external writer here
  // adds a line ABOVE the viewport, which is what tells the two possible
  // answers apart: holding the pixel `scrollTop` would slide every visible
  // line down by one row, and holding the text moves `scrollTop` by exactly
  // that row. `replaceText` dispatches the minimal change set, so CM6 maps
  // its own scroll anchor through the insertion and the text does not move.
  //
  // Only scroll is asserted here: CM6 owns the selection (it resets any
  // DOM-seated range back to its own state, and `window.getSelection()`
  // doesn't reflect the editor's selection through the harness), so a
  // multi-char selection can't be seated/read from an app-test. The selection
  // is mapped through the same change set by CM6 itself.
  test(
    "in-place reload holds the text at the viewport top",
    async () => {
      const { dir, file } = mkTallFixture();
      const app = await launchTugApp({ testName: "at0209-reload-restore" });
      try {
        await seedTextCard(app, file);
        await waitForEditorShowing(app, "tall line 001");

        // Drive to a conflict: flush a local edit to disk, change the file
        // externally, then edit again so the conditional write 409s into the
        // banner (the same setup Scenario 1 proves). The external content is
        // itself tall, so a mid-document scrollTop stays valid after reload.
        await typeIntoEditor(app, "EDIT1 ");
        await waitForDisk(file, (c) => c.includes("EDIT1"));
        const EXTERNAL = "EXTERNAL-WRITER LINE\n" + TALL_CONTENT;
        fs.writeFileSync(file, EXTERNAL, "utf8");
        await typeIntoEditor(app, "EDIT2 ");
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-testid="text-card-conflict-reload"]') !== null`,
          { timeoutMs: 8000 },
        );

        // Park the viewport at a real mid-document offset, then read WHICH
        // line sits at the viewport top and how far down its row starts.
        await app.evalJS<null>(
          `(document.querySelector('${EDITOR_SCROLLER_SELECTOR}').scrollTop = 900, null)`,
        );
        const readTop = `(function(){
          var scroller = document.querySelector('${EDITOR_SCROLLER_SELECTOR}');
          var box = scroller.getBoundingClientRect();
          var lines = scroller.querySelectorAll('.cm-line');
          for (var i = 0; i < lines.length; i++) {
            var r = lines[i].getBoundingClientRect();
            if (r.bottom > box.top + 1) {
              return { text: lines[i].textContent, delta: r.top - box.top, scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight };
            }
          }
          return null;
        })()`;
        await app.waitForCondition<boolean>(
          `(function(){ var t = ${readTop}; return t !== null && t.scrollTop > 200 && t.text.indexOf("tall line") === 0; })()`,
          { timeoutMs: 6000 },
        );
        const before = await app.evalJS<{ text: string; delta: number; scrollTop: number; scrollHeight: number }>(readTop);

        // Reload from disk (in-place) — adopts the external content.
        await app.click('[data-testid="text-card-conflict-reload"]');
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-testid="text-card-conflict-reload"]') === null`,
          { timeoutMs: 6000 },
        );

        // The reload landed (the added row made the content taller) and the
        // same text is still at the same place.
        await app.waitForCondition<boolean>(
          `document.querySelector('${EDITOR_SCROLLER_SELECTOR}').scrollHeight > ${before.scrollHeight} + 4`,
          { timeoutMs: 6000 },
        );
        const after = await app.evalJS<{ text: string; delta: number; scrollTop: number; scrollHeight: number }>(readTop);
        expect(after.text).toBe(before.text);
        expect(Math.abs(after.delta - before.delta)).toBeLessThanOrEqual(2);

        // And the disk content really is in the buffer.
        await app.evalJS<null>(
          `(document.querySelector('${EDITOR_SCROLLER_SELECTOR}').scrollTop = 0, null)`,
        );
        await waitForEditorShowing(app, "EXTERNAL-WRITER LINE");
      } finally {
        await app.close();
        rmFixture(dir);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Scenario 3b: the reload that lands in the frame of the scroll
  // -------------------------------------------------------------------------
  //
  // Scenario 3 above is the same behaviour with a frame to spare, and it has
  // been marginal — reading `tall line 044` where it expects `045`, off by
  // exactly one row, flipping between runs with nothing in between touching the
  // reload path. This scenario makes that window deterministic rather than
  // waiting for luck to expose it.
  //
  // The window is CM6's cached scroll offset. `ViewState.update` computes a
  // change's scroll anchor from `this.scrollOffset`, a cached copy that only a
  // measure pass refreshes, and `EditorView.measure` throws the anchor away
  // when the real offset has moved more than a pixel from the cached one. So a
  // change dispatched after a scroll but BEFORE CM6 has measured that scroll
  // gets no anchor at all: pixel `scrollTop` is held instead of the text, and
  // every visible line slides down by the inserted row. That is the `044`
  // signature exactly.
  //
  // Scenario 3 sets `scrollTop` and then clicks through the harness, which
  // costs several round trips and therefore several frames, so CM6 has usually
  // measured by the time the reload lands. Here the scroll, the reading of
  // which line is at the top, and the Reload click all happen in ONE JS task,
  // with no frame in between — `getBoundingClientRect()` flushes layout
  // synchronously, which is enough to read the DOM but is NOT a CM6 measure
  // pass. The product has the same window ([F04]): an agent writing while the
  // user scrolls takes this path, wide open for any programmatic scroll.
  //
  // A green run is not the evidence here. The scenario carries a per-frame
  // sampler of the top line's text and offset across the reload, so the trace
  // says whether the hop happened and was corrected or never happened at all,
  // and the fix is proven by a `tugtool file probe` reverting it and watching
  // this go red.
  test(
    "in-place reload holds the text when it lands in the scroll's own frame",
    async () => {
      const { dir, file } = mkTallFixture();
      const app = await launchTugApp({ testName: "at0209-reload-same-task" });
      try {
        await seedTextCard(app, file);
        await waitForEditorShowing(app, "tall line 001");

        // Same drive to a conflict banner as Scenario 3: the banner's Reload
        // button is a real in-place reload through the store's `replaceText`
        // bridge, and the external content is itself tall so a mid-document
        // scrollTop stays valid after the adopt.
        await typeIntoEditor(app, "EDIT1 ");
        await waitForDisk(file, (c) => c.includes("EDIT1"));
        const EXTERNAL = "EXTERNAL-WRITER LINE\n" + TALL_CONTENT;
        fs.writeFileSync(file, EXTERNAL, "utf8");
        await typeIntoEditor(app, "EDIT2 ");
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-testid="text-card-conflict-reload"]') !== null`,
          { timeoutMs: 8000 },
        );

        // A per-frame sampler of the top line, started BEFORE the scroll so the
        // trace covers the whole reload. Each frame records which line sits at
        // the viewport top, how far down its row starts, and the raw scrollTop
        // — enough to tell "never hopped" from "hopped and was corrected".
        await app.evalJS<null>(`(function(){
          var scroller = document.querySelector('${EDITOR_SCROLLER_SELECTOR}');
          window.__tugHopSamples = [];
          window.__tugHopStop = false;
          function topLine(){
            var box = scroller.getBoundingClientRect();
            var lines = scroller.querySelectorAll('.cm-line');
            for (var i = 0; i < lines.length; i++) {
              var r = lines[i].getBoundingClientRect();
              if (r.bottom > box.top + 1) {
                return { text: lines[i].textContent, delta: r.top - box.top, scrollTop: scroller.scrollTop };
              }
            }
            return null;
          }
          function tick(){
            if (window.__tugHopStop) return;
            var s = topLine();
            if (s !== null) window.__tugHopSamples.push(s);
            requestAnimationFrame(tick);
          }
          requestAnimationFrame(tick);
          return null;
        })()`);

        // ONE task: park the viewport, read the line at the top, and click
        // Reload — no frame, and therefore no CM6 measure pass, in between.
        const before = await app.evalJS<{
          text: string;
          delta: number;
          scrollTop: number;
          scrollHeight: number;
        }>(`(function(){
          var scroller = document.querySelector('${EDITOR_SCROLLER_SELECTOR}');
          scroller.scrollTop = 900;
          var box = scroller.getBoundingClientRect();
          var lines = scroller.querySelectorAll('.cm-line');
          var found = null;
          for (var i = 0; i < lines.length; i++) {
            var r = lines[i].getBoundingClientRect();
            if (r.bottom > box.top + 1) {
              found = { text: lines[i].textContent, delta: r.top - box.top, scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight };
              break;
            }
          }
          document.querySelector('[data-testid="text-card-conflict-reload"]').click();
          return found;
        })()`);
        expect(before).not.toBeNull();
        expect(before.text.indexOf("tall line")).toBe(0);
        expect(before.scrollTop).toBeGreaterThan(200);

        // The reload landed: banner gone and the added row made it taller.
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-testid="text-card-conflict-reload"]') === null`,
          { timeoutMs: 6000 },
        );
        await app.waitForCondition<boolean>(
          `document.querySelector('${EDITOR_SCROLLER_SELECTOR}').scrollHeight > ${before.scrollHeight} + 4`,
          { timeoutMs: 6000 },
        );

        const readTop = `(function(){
          var scroller = document.querySelector('${EDITOR_SCROLLER_SELECTOR}');
          var box = scroller.getBoundingClientRect();
          var lines = scroller.querySelectorAll('.cm-line');
          for (var i = 0; i < lines.length; i++) {
            var r = lines[i].getBoundingClientRect();
            if (r.bottom > box.top + 1) {
              return { text: lines[i].textContent, delta: r.top - box.top, scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight };
            }
          }
          return null;
        })()`;
        const after = await app.evalJS<{
          text: string;
          delta: number;
          scrollTop: number;
          scrollHeight: number;
        }>(readTop);

        // Stop the sampler and read the trace back. It is reported whether the
        // scenario passes or fails: a green run whose trace shows the top line
        // changing and changing back is a different fact from one that never
        // moved, and only the trace can tell them apart.
        const samples = await app.evalJS<
          Array<{ text: string; delta: number; scrollTop: number }>
        >(`(function(){ window.__tugHopStop = true; return window.__tugHopSamples; })()`);
        const distinct: string[] = [];
        for (const s of samples) {
          const label = `${s.text.slice(0, 14)}@${Math.round(s.delta)}/${Math.round(s.scrollTop)}`;
          if (distinct[distinct.length - 1] !== label) distinct.push(label);
        }
        note(
          `same-task reload: top line ${JSON.stringify(before.text.slice(0, 14))} → ` +
            `${JSON.stringify(after.text.slice(0, 14))}; ${samples.length} frames sampled; ` +
            `trace ${distinct.join(" | ")}`,
        );

        // The text held its place. Holding the pixel `scrollTop` instead would
        // read one row EARLIER in the document — `tall line 044` for `045` —
        // because the external write inserted a row above the viewport.
        expect(after.text).toBe(before.text);
        expect(Math.abs(after.delta - before.delta)).toBeLessThanOrEqual(2);

        // And it held its place on EVERY frame, which is the assertion the
        // final read cannot make. Before the measure-first fix the trace read
        // `045@900 | 044@900 | 045@920`: the hop happened, was visible for a
        // frame, and the next measure pass put it back — so a final read that
        // landed after the correction saw the right answer and a final read that
        // landed during the hop saw `044`, which is the whole of Scenario 3's
        // marginality. Every sampled frame after the viewport was parked must
        // show the same top line.
        const parked = samples.filter((s) => s.scrollTop > 200);
        // A floor on the sample count, so an occluded harness window — which
        // suspends `requestAnimationFrame` — cannot turn this into an assertion
        // over an empty list that passes by seeing nothing.
        expect(parked.length).toBeGreaterThanOrEqual(2);
        const hopped = parked.filter((s) => s.text !== before.text);
        expect(
          hopped.map((s) => `${s.text.slice(0, 14)}@${Math.round(s.scrollTop)}`),
        ).toEqual([]);
        // And the disk content really is in the buffer.
        await app.evalJS<null>(
          `(document.querySelector('${EDITOR_SCROLLER_SELECTOR}').scrollTop = 0, null)`,
        );
        await waitForEditorShowing(app, "EXTERNAL-WRITER LINE");
      } finally {
        await app.close();
        rmFixture(dir);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Scenario 4: a reload is not an undo step
  // -------------------------------------------------------------------------
  //
  // In automatic mode the buffer is written back to disk on its own, so an
  // undo that resurrected the pre-reload text would silently overwrite the
  // external editor's work with bytes the user never asked for. The reload
  // therefore goes in with `Transaction.addToHistory.of(false)`: ⌘Z steps
  // back through the user's typing only, and the reloaded lines stay put.

  test(
    "undo after reload removes only the user's typing",
    async () => {
      const TYPED_RUN = "UNDO-RUN-ONE ";
      const EXTERNAL_LINE = "EXTERNAL-WRITER LINE TWENTY";
      const { dir, file } = mkWatchedFixture("at0209-undo");
      const { app, tugbankPath } = await launchOnWatchedFixture(
        file,
        "at0209-undo-after-reload",
      );
      try {
        // One typed run, autosaved to disk. The buffer has to end CLEAN:
        // only a clean buffer adopts an external change silently — a dirty
        // automatic one leaves the verdict to its next conditional write.
        await typeIntoEditor(app, TYPED_RUN);
        await waitForDisk(file, (c) => c.includes(TYPED_RUN.trim()));
        // The write landing on disk is not the settle: the baseline moves on
        // the response, and a further keystroke-free debounce has to expire
        // before the store is quiet. Write externally before that and the
        // save races the external writer.
        await new Promise((resolve) =>
          setTimeout(resolve, AUTOSAVE_DEBOUNCE_MS + 500),
        );

        // External change FAR from the typed run — line 20, while the typed
        // run sits on line 1 — so "the typing went away" and "the reload
        // stayed" are two separate observations.
        const external = fs
          .readFileSync(file, "utf8")
          .replace(FIXTURE_LINES[19] as string, EXTERNAL_LINE);
        expect(external).toContain(EXTERNAL_LINE);
        fs.writeFileSync(file, external, "utf8");
        await waitForEditorShowing(app, EXTERNAL_LINE, 30_000);

        // The machine's own word for what the next ⌘Z does: the typing is
        // still one undo step, and the reload added none of its own.
        const undoState = await waitForUndoState(app, {
          enabled: true,
          title: "Undo Typing",
        });
        expect(undoState.found, "Edit ▸ Undo must exist").toBe(true);
        expect(
          undoState.title,
          "Undo names the user's typing, not the reload",
        ).toBe("Undo Typing");

        await undoOnce(app);
        await app.waitForCondition<boolean>(
          `(function(){
            var el = document.querySelector('${EDITOR_CONTENT_SELECTOR}');
            return el !== null && el.innerText.indexOf(${JSON.stringify(TYPED_RUN.trim())}) === -1;
          })()`,
          { timeoutMs: 8000 },
        );
        const afterUndo = await editorText(app);
        expect(afterUndo).toContain(EXTERNAL_LINE);
        expect(afterUndo).toContain("fixture line 01");
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
        rmFixture(dir);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "undo on a freshly reloaded buffer leaves it equal to disk",
    async () => {
      const EXTERNAL_LINE = "EXTERNAL-WRITER FRESH OPEN";
      const { dir, file } = mkWatchedFixture("at0209-undo-fresh");
      const { app, tugbankPath } = await launchOnWatchedFixture(
        file,
        "at0209-undo-fresh-open",
      );
      try {
        // Nothing typed here at all. The reloads this card has already seen
        // (the watcher warm-up, then this write) are the only transactions
        // it has ever dispatched, and none of them is undoable.
        const external = fs
          .readFileSync(file, "utf8")
          .replace(FIXTURE_LINES[19] as string, EXTERNAL_LINE);
        fs.writeFileSync(file, external, "utf8");
        await waitForEditorShowing(app, EXTERNAL_LINE, 30_000);

        const undoState = await waitForUndoState(app, { enabled: false });
        expect(undoState.found, "Edit ▸ Undo must exist").toBe(true);
        expect(
          undoState.enabled,
          "a buffer that was only ever reloaded has nothing to undo",
        ).toBe(false);

        await undoOnce(app);
        // An undo that DID fire would land within a frame or two; give it
        // that long before reading, or "nothing happened" is vacuous.
        await new Promise((resolve) => setTimeout(resolve, 750));
        const afterUndo = await editorText(app);
        expect(afterUndo).toContain(EXTERNAL_LINE);
        expect(afterUndo).not.toContain(FIXTURE_LINES[19] as string);
        // Nothing was written back either: disk is still the external bytes.
        expect(fs.readFileSync(file, "utf8")).toBe(external);
      } finally {
        await app.close();
        rmTempTugbank(tugbankPath);
        rmFixture(dir);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
