/**
 * at0602-text-card-disk-sync.test.ts — a Text card stays in sync with
 * disk from outside the app ([AT0602]).
 *
 * This is the headline pin for the per-file watch. Every fixture here
 * lives in an OS temp directory, **outside every workspace**: before the
 * per-file watch there was no way for a card to hear about a change to
 * such a file at all, because the only disk stream a client received was
 * the bootstrap workspace's. So the location of the fixture is itself
 * half of what each scenario asserts — `at0209` had to put its watched
 * fixture inside the checkout's `.tug/` to be heard, and this file does
 * not.
 *
 * ## Scenarios
 *
 * 1. **A reload holds the reader's place.** A tall file scrolled to a
 *    real mid-document offset, an external write that inserts a line
 *    ABOVE the viewport, and NO input event of any kind: the buffer
 *    adopts the change on the watch alone, and the text at the top of
 *    the viewport does not move.
 *
 * 2. **A burst converges on the last write.** Twenty external writes
 *    about 10 ms apart — faster than any debounce in the path — and the
 *    buffer ends showing the last of them and none of the other
 *    nineteen. The trailing read is what this measures: a path that
 *    coalesced by dropping the pending look would settle on an
 *    intermediate write.
 *
 * 3. **A dirty buffer merges instead of conflicting.** The user's
 *    typing and an external edit in a distant region both survive, with
 *    no conflict banner and no conflict sheet — in automatic mode
 *    (where the merged text then autosaves, proving the baseline moved
 *    with it and the next conditional write is not a 409) and in
 *    manual mode, the shipping default.
 *
 * 4. **A reload is not an undo step.** The `at0209` pin, re-run against
 *    a file outside every workspace: after the card adopts an external
 *    change on its own, Edit ▸ Undo still names the user's typing, and
 *    one undo removes that typing and leaves the reloaded lines.
 *
 * Input path and undo gesture follow `at0209` for the reasons recorded
 * there: edits go through `document.execCommand("insertText")` so the
 * real beforeinput → CM6 pipeline runs, and undo goes through
 * `dispatchControlAction("undo")` rather than a synthetic ⌘Z, which
 * CM6's keymap eats before the menu bar sees it.
 *
 * Scenario 3 types at the caret the card opens with — line 1 — and puts
 * the external edit near the BOTTOM. The plan's shape is the mirror of
 * that; the merge is symmetric in the two sides, and CM6 owns its own
 * selection (it resets a DOM-seated range straight back), so the caret
 * the harness can actually seat is the one the scenario uses.
 *
 * ## What each scenario was proven able to fail on
 *
 * Reverse-diff probes, run against this file on the tree that added it —
 * a green test that cannot go red measures nothing:
 *
 * - `_syncWatch` patched to never subscribe: **all five red.** Without the
 *   per-file watch nothing here even starts, which is the point of the
 *   fixture living outside every workspace.
 * - `_mergeOrConflict` patched to always conflict: **exactly the two
 *   scenario-3 tests red**, the other three green — the discrimination is
 *   the merge itself and nothing adjacent to it.
 * - `_lookAtDisk` patched to drop its pending look: **green, three runs
 *   out of three.** That is a real reading rather than a weak test: the
 *   server's own `FileWatchService` debounces and reads the file after it
 *   settles, so a twenty-write burst reaches the client as one or two
 *   frames and the client never has a look pending during another. The
 *   client-side trailing look is the backstop for a burst slow enough to
 *   cross frames, and no app-test can produce one without racing the
 *   server's debounce; `file_watch.rs`'s own burst tests cover that side.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/text-card-store.ts
 * @covers tugdeck/src/lib/file-watch-client.ts
 * @covers tugdeck/src/lib/three-way-merge.ts
 * @covers tugdeck/src/components/tugways/tug-text-card-editor.tsx
 * @covers tugdeck/src/components/tugways/cards/text-card.tsx
 * @covers tugrust/crates/tugcast/src/feeds/file_watch.rs
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const TEST_TIMEOUT_MS = 120_000;

/** The autosave debounce the store arms on every keystroke. */
const AUTOSAVE_DEBOUNCE_MS = 1000;

// ---------------------------------------------------------------------------
// Fixtures — every one of them outside every workspace
// ---------------------------------------------------------------------------

const FIXTURE_LINES: ReadonlyArray<string> = Array.from(
  { length: 24 },
  (_, i) => `fixture line ${String(i + 1).padStart(2, "0")} alpha beta gamma`,
);
const FIXTURE_CONTENT = FIXTURE_LINES.join("\n") + "\n";

// Tall enough that a mid-document scrollTop is a real viewport offset
// rather than a rounding artifact against the 560px pane.
const TALL_LINES: ReadonlyArray<string> = Array.from(
  { length: 200 },
  (_, i) => `tall line ${String(i + 1).padStart(3, "0")} alpha beta gamma delta`,
);
const TALL_CONTENT = TALL_LINES.join("\n") + "\n";

const WARMUP_BODY = "WARMUP marker\n";

function mkFixture(prefix: string, content: string): { dir: string; file: string } {
  // `realpathSync` because macOS hands back `/var/...` for a `/private/var`
  // temp directory, and the watch is keyed by the path the card holds.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const file = path.join(dir, "sample.txt");
  fs.writeFileSync(file, content, "utf8");
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
 * Seed the deck-wide save-mode default BEFORE the card mounts —
 * `setTugbankValue` populates the same client cache `readSaveMode` reads.
 * Manual is the shipping default; the automatic scenarios opt in.
 */
async function seedSaveMode(app: App, mode: "automatic" | "manual"): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.setTugbankValue("dev.tugapp.text-card","save-mode",{kind:"string",value:${JSON.stringify(mode)}}), null)`,
  );
}

async function seedTextCard(
  app: App,
  filePath: string,
  mode: "automatic" | "manual",
): Promise<void> {
  await seedSaveMode(app, mode);
  await app.seedDeckState({
    state: deckShape(),
    cardStates: {
      A: {
        content: { path: filePath, anchor: { line: 1, ch: 0 }, scrollTop: 0 },
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

/** The rendered buffer text. */
function editorText(app: App): Promise<string> {
  return app.evalJS<string>(
    `document.querySelector('${EDITOR_CONTENT_SELECTOR}').innerText`,
  );
}

/**
 * Type into the editor through CM6's real input pipeline: focus the
 * contenteditable and insert via `execCommand("insertText")`, which fires
 * beforeinput exactly like a keystroke.
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
    throw new Error("[at0602] typeIntoEditor: insertText was not handled");
  }
}

/**
 * Undo once through the control action, never the ⌘Z chord: CM6's keymap
 * eats the chord before the menu bar sees it (`at0174` records why).
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
  let last: { found: boolean; enabled?: boolean; title?: string } = { found: false };
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
    `[at0602] disk predicate not satisfied within ${timeoutMs}ms; last content:\n${last.slice(0, 400)}`,
  );
}

/** Nothing on either conflict surface — the banner or the sheet. */
async function assertNoConflictSurface(app: App): Promise<void> {
  const open = await app.evalJS<string[]>(
    `(function(){
      var ids = ["text-card-conflict-reload","text-card-conflict-diff","file-save-sheet-reload","file-save-sheet-save-anyway"];
      var found = [];
      for (var i = 0; i < ids.length; i++) {
        if (document.querySelector('[data-testid="' + ids[i] + '"]') !== null) found.push(ids[i]);
      }
      return found;
    })()`,
  );
  expect(open, "a merged edit raises no conflict surface").toEqual([]);
}

/**
 * Prove the watch is live before anything depends on it.
 *
 * A `watch` request is answered with the path's current state, so the
 * subscription exists as soon as the card mounts — but that says nothing
 * about when the server's watcher starts delivering CHANGES. So drive one
 * real round trip (an external rewrite the card adopts, then the original
 * body back) and only then start the scenario. Until both land there is
 * nothing watching and every later assertion is vacuous.
 */
async function proveWatchLive(
  app: App,
  file: string,
  restore: string,
  restoreSentinel: string,
): Promise<void> {
  const started = Date.now();
  fs.writeFileSync(file, WARMUP_BODY, "utf8");
  await waitForEditorShowing(app, "WARMUP marker", 60_000);
  note(`at0602 first watch delivery: ${Date.now() - started}ms`);
  fs.writeFileSync(file, restore, "utf8");
  await app.waitForCondition<boolean>(
    `(function(){
      var el = document.querySelector('${EDITOR_CONTENT_SELECTOR}');
      if (el === null) return false;
      var t = el.innerText;
      return t.indexOf(${JSON.stringify(restoreSentinel)}) !== -1 && t.indexOf("WARMUP marker") === -1;
    })()`,
    { timeoutMs: 20_000 },
  );
}

// ---------------------------------------------------------------------------

describe.skipIf(!SHOULD_RUN)("at0602: Text card disk sync", () => {
  // -------------------------------------------------------------------------
  // Scenario 1: the watch reloads in place and holds the reader's place
  // -------------------------------------------------------------------------
  //
  // The external writer adds a line ABOVE the viewport, which is what tells
  // the two possible answers apart: holding the pixel `scrollTop` would slide
  // every visible line down by one row, and holding the TEXT moves `scrollTop`
  // by exactly that row. The reload goes in as a minimal change set, so CM6
  // maps its own scroll anchor through the insertion.
  test(
    "an external write reloads in place with no input event",
    async () => {
      const { dir, file } = mkFixture("at0602-hold-", TALL_CONTENT);
      const app = await launchTugApp({ testName: "at0602-viewport-hold" });
      note(`at0602 out-of-workspace fixture: ${file}`);
      try {
        await seedTextCard(app, file, "manual");
        await waitForEditorShowing(app, "tall line 001");
        await proveWatchLive(app, file, TALL_CONTENT, "tall line 001");

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
        const before = await app.evalJS<{
          text: string;
          delta: number;
          scrollTop: number;
          scrollHeight: number;
        }>(readTop);

        // The only gesture in this scenario: a write from outside the app.
        const started = Date.now();
        fs.writeFileSync(file, "EXTERNAL-WRITER LINE\n" + TALL_CONTENT, "utf8");
        await app.waitForCondition<boolean>(
          `document.querySelector('${EDITOR_SCROLLER_SELECTOR}').scrollHeight > ${before.scrollHeight} + 4`,
          { timeoutMs: 20_000 },
        );
        note(`at0602 event-to-reload: ${Date.now() - started}ms`);

        const after = await app.evalJS<{
          text: string;
          delta: number;
          scrollTop: number;
          scrollHeight: number;
        }>(readTop);
        expect(after.text, "the same line is still at the viewport top").toBe(
          before.text,
        );
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
  // Scenario 2: a burst of writes converges on the last one
  // -------------------------------------------------------------------------

  test(
    "a burst of external writes settles on the last of them",
    async () => {
      const BURSTS = 20;
      const body = (i: number) => `BURST-MARKER-${String(i).padStart(2, "0")}\n${FIXTURE_CONTENT}`;
      const { dir, file } = mkFixture("at0602-burst-", FIXTURE_CONTENT);
      const app = await launchTugApp({ testName: "at0602-burst" });
      try {
        await seedTextCard(app, file, "manual");
        await waitForEditorShowing(app, "fixture line 01");
        await proveWatchLive(app, file, FIXTURE_CONTENT, "fixture line 01");

        const started = Date.now();
        for (let i = 0; i < BURSTS; i++) {
          fs.writeFileSync(file, body(i), "utf8");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const last = `BURST-MARKER-${String(BURSTS - 1).padStart(2, "0")}`;
        await waitForEditorShowing(app, last, 20_000);
        note(`at0602 burst-to-settled: ${Date.now() - started}ms`);

        // Settled means settled: give any straggling read the time it would
        // need to land, then assert the buffer carries the LAST write and
        // none of the nineteen before it.
        await new Promise((resolve) => setTimeout(resolve, 2000));
        const text = await editorText(app);
        expect(text).toContain(last);
        for (let i = 0; i < BURSTS - 1; i++) {
          expect(text).not.toContain(`BURST-MARKER-${String(i).padStart(2, "0")}`);
        }
        expect(text).toContain("fixture line 24");
        expect(fs.readFileSync(file, "utf8")).toBe(body(BURSTS - 1));
      } finally {
        await app.close();
        rmFixture(dir);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Scenario 3: a dirty buffer merges, in both save modes
  // -------------------------------------------------------------------------

  const TYPED_RUN = "MERGED-TYPING ";
  const EXTERNAL_LINE = "EXTERNAL-WRITER LINE TWENTY";

  test(
    "automatic mode merges a distant external edit into a dirty buffer",
    async () => {
      const { dir, file } = mkFixture("at0602-merge-auto-", FIXTURE_CONTENT);
      const app = await launchTugApp({ testName: "at0602-merge-automatic" });
      try {
        await seedTextCard(app, file, "automatic");
        await waitForEditorShowing(app, "fixture line 01");
        await proveWatchLive(app, file, FIXTURE_CONTENT, "fixture line 01");

        // Dirty the buffer at the caret the card opened with — line 1 — and
        // put the external edit on line 20, far enough away that the two
        // sides never touch.
        await typeIntoEditor(app, TYPED_RUN);
        const external = FIXTURE_CONTENT.replace(
          FIXTURE_LINES[19] as string,
          EXTERNAL_LINE,
        );
        fs.writeFileSync(file, external, "utf8");

        await waitForEditorShowing(app, EXTERNAL_LINE, 20_000);
        const merged = await editorText(app);
        expect(merged, "the user's typing survived the merge").toContain(
          TYPED_RUN.trim(),
        );
        expect(merged).toContain("fixture line 01");
        await assertNoConflictSurface(app);

        // Automatic mode writes the merged text back on its own — and that
        // write is conditional on the baseline, so its landing is the proof
        // that the baseline moved to the disk's when the merge applied.
        const onDisk = await waitForDisk(
          file,
          (c) => c.includes(TYPED_RUN.trim()),
          15_000,
        );
        expect(onDisk, "the external edit is still on disk too").toContain(
          EXTERNAL_LINE,
        );
        await assertNoConflictSurface(app);
      } finally {
        await app.close();
        rmFixture(dir);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "manual mode merges a distant external edit into a dirty buffer",
    async () => {
      const { dir, file } = mkFixture("at0602-merge-manual-", FIXTURE_CONTENT);
      const app = await launchTugApp({ testName: "at0602-merge-manual" });
      try {
        await seedTextCard(app, file, "manual");
        await waitForEditorShowing(app, "fixture line 01");
        await proveWatchLive(app, file, FIXTURE_CONTENT, "fixture line 01");

        await typeIntoEditor(app, TYPED_RUN);
        const external = FIXTURE_CONTENT.replace(
          FIXTURE_LINES[19] as string,
          EXTERNAL_LINE,
        );
        fs.writeFileSync(file, external, "utf8");

        await waitForEditorShowing(app, EXTERNAL_LINE, 20_000);
        const merged = await editorText(app);
        expect(merged, "the user's typing survived the merge").toContain(
          TYPED_RUN.trim(),
        );
        expect(merged).toContain("fixture line 01");
        await assertNoConflictSurface(app);

        // Manual mode writes nothing without being asked, so the external
        // bytes are still exactly what is on disk.
        expect(fs.readFileSync(file, "utf8")).toBe(external);
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
  // external editor's work with bytes the user never asked for.

  test(
    "undo after an external reload removes only the user's typing",
    async () => {
      const UNDO_RUN = "UNDO-RUN-ONE ";
      const { dir, file } = mkFixture("at0602-undo-", FIXTURE_CONTENT);
      const app = await launchTugApp({ testName: "at0602-undo-after-reload" });
      try {
        await seedTextCard(app, file, "automatic");
        await waitForEditorShowing(app, "fixture line 01");
        await proveWatchLive(app, file, FIXTURE_CONTENT, "fixture line 01");

        // One typed run, autosaved to disk. The buffer has to end CLEAN:
        // only a clean buffer adopts an external change silently.
        await typeIntoEditor(app, UNDO_RUN);
        await waitForDisk(file, (c) => c.includes(UNDO_RUN.trim()));
        // The write landing on disk is not the settle: the baseline moves on
        // the response, and a further keystroke-free debounce has to expire
        // before the store is quiet.
        await new Promise((resolve) =>
          setTimeout(resolve, AUTOSAVE_DEBOUNCE_MS + 500),
        );

        const external = fs
          .readFileSync(file, "utf8")
          .replace(FIXTURE_LINES[19] as string, EXTERNAL_LINE);
        expect(external).toContain(EXTERNAL_LINE);
        fs.writeFileSync(file, external, "utf8");
        await waitForEditorShowing(app, EXTERNAL_LINE, 20_000);

        // The machine's own word for what the next undo does: the typing is
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
            return el !== null && el.innerText.indexOf(${JSON.stringify(UNDO_RUN.trim())}) === -1;
          })()`,
          { timeoutMs: 8000 },
        );
        const afterUndo = await editorText(app);
        expect(afterUndo).toContain(EXTERNAL_LINE);
        expect(afterUndo).toContain("fixture line 01");
      } finally {
        await app.close();
        rmFixture(dir);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
