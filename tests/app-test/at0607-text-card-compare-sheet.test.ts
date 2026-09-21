/**
 * at0607-text-card-compare-sheet.test.ts — the disk-versus-buffer compare
 * sheet, driven in the real app ([AT0607]).
 *
 * "This file changed on disk while you were editing" is a claim the user has
 * no way to check, and both resolutions throw one side's work away. The card
 * answers that with a diff: `presentCompareSheet` renders the disk text
 * against the live buffer, and offers the same two resolutions the conflict
 * surface does so the decision can be made from inside the view.
 *
 * Every piece of that path — `openCompareSheet`, `buildTwoTextDiffPayload`,
 * the banner's Diff button, the conflict sheet's Diff… button, and the
 * re-present loop that makes Cancel come back to the question — was reachable
 * only by hand before this file existed. The unit suites cover the payload
 * builder; nothing drove the surface.
 *
 * ## Scenarios
 *
 * 1. **Automatic mode: the banner's Diff.** An automatic-mode conflict renders
 *    as the pane banner, so Diff is a banner button. Force a TOUCHING-line
 *    conflict, open the diff, read the `+` and `-` rows out of the rendered
 *    document, Cancel back to the banner, then resolve — Keep Mine on the
 *    first conflict and Reload from Disk on a second one, so both
 *    resolutions are driven through the sheet rather than only one.
 *
 * 2. **Manual mode: the conflict sheet's Diff….** Manual mode's verdict is
 *    modal, so the diff is a detour from a sheet rather than from a banner,
 *    and Cancel has something stronger to prove: the card's loop must
 *    RE-PRESENT the conflict sheet, because looking at a diff decides
 *    nothing. Same two resolutions, each from inside the sheet.
 *
 * ## Why the conflict is forced by TOUCHING lines
 *
 * An external write that lands away from the user's edit MERGES now — that is
 * what the disk-sync arc changed, and `at0602` scenario 3 is its pin. So a
 * conflict has to be provoked where a merge is genuinely impossible: both
 * sides move line 1. That reaches the conflict two ways — the watch's
 * `_mergeOrConflict` refusing, or automatic mode's conditional write 409ing —
 * and the scenarios assert the surface rather than which of the two got
 * there, because both are the same verdict and either is correct.
 *
 * ## Reading the diff out of the DOM
 *
 * `TugDiffDocument` renders through `DiffBlock`, which has two view modes and
 * remembers the user's choice, so the row shape is not fixed: inline rows are
 * `[data-slot="diff-line"]` and side-by-side cells are
 * `[data-slot="diff-sbs-cell"]`, both carrying `data-kind`. The reader below
 * accepts either and reports which it found, so a persisted view mode cannot
 * silently turn these assertions vacuous.
 *
 * ## What each scenario was proven able to fail on
 *
 * A reverse-diff probe, run against this file on the tree that added it — a
 * green test that cannot go red measures nothing:
 *
 * - `openCompareSheet` patched to return `"cancel"` without presenting
 *   anything, which is the shape the card takes when a disk read fails:
 *   **both scenarios red**, each on the wait for the compare sheet to mount.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/cards/text-card.tsx
 * @covers tugdeck/src/components/tugways/cards/text-card-save-sheets.tsx
 * @covers tugdeck/src/lib/diff/two-text-diff.ts
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const TEST_TIMEOUT_MS = 180_000;

/** The autosave debounce the store arms on every keystroke. */
const AUTOSAVE_DEBOUNCE_MS = 1000;

const CARD = '[data-card-id="A"]';
const EDITOR_CONTENT = `${CARD} [data-slot="tug-text-card-editor"] .cm-content`;

/** The banner lives in the pane chrome, outside the card subtree. */
const BANNER_RELOAD = '[data-testid="text-card-conflict-reload"]';
const BANNER_DIFF = '[data-testid="text-card-conflict-diff"]';
/** The manual-mode conflict sheet's four choices, `Diff…` among them. */
const SHEET_DIFF = '[data-testid="file-save-sheet-diff"]';
/** The compare sheet itself, and its three buttons. */
const COMPARE_SHEET = '[data-slot="text-card-compare-sheet"]';
const COMPARE_CANCEL = '[data-testid="text-card-compare-cancel"]';
const COMPARE_RELOAD = '[data-testid="text-card-compare-reload"]';
const COMPARE_KEEP_MINE = '[data-testid="text-card-compare-keep-mine"]';

const FIXTURE_LINES: ReadonlyArray<string> = Array.from(
  { length: 24 },
  (_, i) => `fixture line ${String(i + 1).padStart(2, "0")} alpha beta gamma`,
);
const FIXTURE_CONTENT = FIXTURE_LINES.join("\n") + "\n";

const WARMUP_BODY = "WARMUP marker\n";

/** `markerFor` in `diff-block.tsx`: a real minus sign, not a hyphen. */
const REMOVE_MARKER = "−";

function mkFixture(prefix: string): { dir: string; file: string } {
  // `realpathSync` because macOS hands back `/var/...` for a `/private/var`
  // temp directory, and the watch is keyed by the path the card holds.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const file = path.join(dir, "sample.txt");
  fs.writeFileSync(file, FIXTURE_CONTENT, "utf8");
  return { dir, file };
}

function rmFixture(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** The external write that CANNOT merge: line 1, the line the user is on. */
function touchingExternal(marker: string): string {
  return FIXTURE_CONTENT.replace(FIXTURE_LINES[0] as string, marker);
}

// ---------------------------------------------------------------------------
// Deck seeding
// ---------------------------------------------------------------------------

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "text", title: "File", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 600 },
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
 */
async function seedTextCard(
  app: App,
  filePath: string,
  mode: "automatic" | "manual",
): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.setTugbankValue("dev.tugapp.text-card","save-mode",{kind:"string",value:${JSON.stringify(mode)}}), null)`,
  );
  await app.seedDeckState({
    state: deckShape(),
    cardStates: {
      A: { content: { path: filePath, anchor: { line: 1, ch: 0 }, scrollTop: 0 } },
    },
    focusCardId: "A",
  });
}

async function waitForEditorShowing(
  app: App,
  sentinel: string,
  timeoutMs = 8000,
): Promise<void> {
  await app.waitForCondition<boolean>(
    `(function(){
      var el = document.querySelector('${EDITOR_CONTENT}');
      return el !== null && el.innerText.indexOf(${JSON.stringify(sentinel)}) !== -1;
    })()`,
    { timeoutMs },
  );
}

function editorText(app: App): Promise<string> {
  return app.evalJS<string>(
    `document.querySelector('${EDITOR_CONTENT}').innerText`,
  );
}

/**
 * Type through CM6's real input pipeline — `execCommand("insertText")` fires
 * beforeinput exactly like a keystroke (`at0209` records why the harness does
 * not synthesize keys here).
 */
async function typeIntoEditor(app: App, text: string): Promise<void> {
  const ok = await app.evalJS<boolean>(
    `(function(){
      var el = document.querySelector('${EDITOR_CONTENT}');
      if (!el) return false;
      el.focus();
      return document.execCommand("insertText", false, ${JSON.stringify(text)});
    })()`,
  );
  if (!ok) {
    throw new Error("[at0607] typeIntoEditor: insertText was not handled");
  }
}

/**
 * Prove the watch is live before anything depends on it. A `watch` request is
 * answered with the path's current state, so the subscription exists as soon
 * as the card mounts — but that says nothing about when the server's watcher
 * starts delivering CHANGES, and a conflict here is provoked by a change.
 */
async function proveWatchLive(app: App, file: string): Promise<void> {
  const started = Date.now();
  fs.writeFileSync(file, WARMUP_BODY, "utf8");
  await waitForEditorShowing(app, "WARMUP marker", 60_000);
  note(`at0607 first watch delivery: ${Date.now() - started}ms`);
  fs.writeFileSync(file, FIXTURE_CONTENT, "utf8");
  await app.waitForCondition<boolean>(
    `(function(){
      var el = document.querySelector('${EDITOR_CONTENT}');
      if (el === null) return false;
      var t = el.innerText;
      return t.indexOf("fixture line 01") !== -1 && t.indexOf("WARMUP marker") === -1;
    })()`,
    { timeoutMs: 20_000 },
  );
}

/**
 * Let the app settle between synthetic gestures: a sheet close, a portal
 * unmount and a focus transfer all have to commit before the next click, and
 * firing them back-to-back races those transitions (`at0212` records this).
 */
const settle = (ms = 450) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll the real file until `predicate` holds, and return what it last read. */
async function waitForDisk(
  file: string,
  predicate: (content: string) => boolean,
  timeoutMs = 15_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    last = fs.readFileSync(file, "utf8");
    if (predicate(last)) return last;
    await settle(150);
  }
  return last;
}

async function waitFor(app: App, selector: string, present: boolean): Promise<void> {
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(selector)}) ${present ? "!==" : "==="} null`,
    { timeoutMs: 15_000 },
  );
}

// ---------------------------------------------------------------------------
// Reading the rendered diff
// ---------------------------------------------------------------------------

interface DiffRead {
  /** Which row shape was found — the persisted view mode decides. */
  mode: "inline" | "side-by-side" | "none";
  added: string[];
  removed: string[];
  /** Every distinct marker glyph rendered beside an `add` row, and a `remove` one. */
  addMarkers: string[];
  removeMarkers: string[];
}

/**
 * Read the `+` / `-` rows out of the mounted compare sheet, from whichever of
 * the two row shapes `DiffBlock` rendered.
 */
function readDiff(app: App): Promise<DiffRead> {
  return app.evalJS<DiffRead>(`(function(){
    var out = { mode: "none", added: [], removed: [], addMarkers: [], removeMarkers: [] };
    var sheet = document.querySelector(${JSON.stringify(COMPARE_SHEET)});
    if (sheet === null) return out;
    var rows = sheet.querySelectorAll('[data-slot="diff-line"]');
    if (rows.length > 0) out.mode = "inline";
    else {
      rows = sheet.querySelectorAll('[data-slot="diff-sbs-cell"]');
      if (rows.length > 0) out.mode = "side-by-side";
    }
    for (var i = 0; i < rows.length; i++) {
      var kind = rows[i].getAttribute("data-kind");
      if (kind !== "add" && kind !== "remove") continue;
      var content = rows[i].querySelector('.tugx-diff-content');
      var marker = rows[i].querySelector('.tugx-diff-marker');
      var text = content === null ? "" : content.textContent;
      var glyph = marker === null ? "" : marker.textContent;
      if (kind === "add") {
        out.added.push(text);
        if (out.addMarkers.indexOf(glyph) === -1) out.addMarkers.push(glyph);
      } else {
        out.removed.push(text);
        if (out.removeMarkers.indexOf(glyph) === -1) out.removeMarkers.push(glyph);
      }
    }
    return out;
  })()`);
}

/**
 * The compare sheet is showing a real diff of the two texts: the disk's line
 * on the `-` side, the buffer's on the `+` side, each under its own marker.
 *
 * `before` is the disk text and `after` the buffer, so a reversed payload
 * would put each string on the wrong side and fail here rather than passing
 * on a symmetric "something differs".
 */
async function assertDiffShows(
  app: App,
  where: string,
  onDisk: string,
  inBuffer: string,
): Promise<void> {
  const diff = await readDiff(app);
  note(`at0607 ${where}: ${diff.mode}, +${diff.added.length} −${diff.removed.length}`);
  expect(diff.mode, `${where}: the diff rendered rows`).not.toBe("none");
  expect(
    diff.removed.some((line) => line.includes(onDisk)),
    `${where}: the disk's line is on the − side`,
  ).toBe(true);
  expect(
    diff.added.some((line) => line.includes(inBuffer)),
    `${where}: the buffer's line is on the + side`,
  ).toBe(true);
  expect(diff.addMarkers, `${where}: + marker`).toEqual(["+"]);
  expect(diff.removeMarkers, `${where}: − marker`).toEqual([REMOVE_MARKER]);
}

// ---------------------------------------------------------------------------

describe.skipIf(!SHOULD_RUN)("at0607: Text card compare sheet", () => {
  // -------------------------------------------------------------------------
  // Scenario 1: automatic mode — the banner's Diff button
  // -------------------------------------------------------------------------

  test(
    "automatic mode: the banner's Diff opens the sheet, cancels back, and resolves both ways",
    async () => {
      const TYPED_ONE = "KEEP-MINE-TYPING ";
      const TYPED_TWO = "DISCARDED-TYPING ";
      const EXTERNAL_ONE = "EXTERNAL-LINE-ONE marker";
      const EXTERNAL_TWO = "EXTERNAL-LINE-TWO marker";
      const { dir, file } = mkFixture("at0607-auto-");
      const app = await launchTugApp({ testName: "at0607-compare-automatic" });
      try {
        await seedTextCard(app, file, "automatic");
        await waitForEditorShowing(app, "fixture line 01");
        await proveWatchLive(app, file);

        // ---- The first conflict, resolved with Keep Mine ----
        //
        // Both sides move line 1, so there is nothing to merge: the verdict
        // arrives either from the watch's refused merge or from the autosave's
        // conditional write, and automatic mode renders it as the banner.
        await typeIntoEditor(app, TYPED_ONE);
        fs.writeFileSync(file, touchingExternal(EXTERNAL_ONE), "utf8");
        await waitFor(app, BANNER_RELOAD, true);
        await waitFor(app, BANNER_DIFF, true);
        expect(fs.readFileSync(file, "utf8")).toContain(EXTERNAL_ONE);

        await app.click(BANNER_DIFF);
        await waitFor(app, COMPARE_SHEET, true);
        await assertDiffShows(app, "automatic first diff", EXTERNAL_ONE, TYPED_ONE.trim());

        // Cancel decides nothing: the sheet goes and the question stays.
        await app.click(COMPARE_CANCEL);
        await waitFor(app, COMPARE_SHEET, false);
        await settle();
        await waitFor(app, BANNER_RELOAD, true);
        expect(await editorText(app), "the buffer is untouched by a look").toContain(
          TYPED_ONE.trim(),
        );
        expect(
          fs.readFileSync(file, "utf8"),
          "and so is the file on disk",
        ).toContain(EXTERNAL_ONE);

        // Keep Mine, from inside the sheet: the buffer wins and the write
        // lands, so the external line is gone from disk.
        await app.click(BANNER_DIFF);
        await waitFor(app, COMPARE_SHEET, true);
        await app.click(COMPARE_KEEP_MINE);
        await waitFor(app, COMPARE_SHEET, false);
        await waitFor(app, BANNER_RELOAD, false);
        const kept = await waitForDisk(file, (c) => c.includes(TYPED_ONE.trim()));
        expect(kept, "Keep Mine wrote the buffer to disk").toContain(
          TYPED_ONE.trim(),
        );
        expect(kept, "and the external line it replaced is gone").not.toContain(
          EXTERNAL_ONE,
        );

        // ---- A second conflict, resolved with Reload from Disk ----
        //
        // The write landing is not the settle: the baseline moves on the
        // response and a keystroke-free debounce has to expire after it.
        await settle(AUTOSAVE_DEBOUNCE_MS + 500);
        await typeIntoEditor(app, TYPED_TWO);
        fs.writeFileSync(file, touchingExternal(EXTERNAL_TWO), "utf8");
        await waitFor(app, BANNER_DIFF, true);

        await app.click(BANNER_DIFF);
        await waitFor(app, COMPARE_SHEET, true);
        await assertDiffShows(app, "automatic second diff", EXTERNAL_TWO, TYPED_TWO.trim());

        await app.click(COMPARE_RELOAD);
        await waitFor(app, COMPARE_SHEET, false);
        await waitFor(app, BANNER_RELOAD, false);
        await waitForEditorShowing(app, EXTERNAL_TWO, 15_000);
        const reloaded = await editorText(app);
        expect(reloaded, "Reload discarded the buffer's typing").not.toContain(
          TYPED_TWO.trim(),
        );
        expect(
          fs.readFileSync(file, "utf8"),
          "and left the disk exactly as the external writer left it",
        ).toBe(touchingExternal(EXTERNAL_TWO));
      } finally {
        await app.close();
        rmFixture(dir);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Scenario 2: manual mode — the conflict sheet's Diff…, and the loop
  // -------------------------------------------------------------------------
  //
  // Manual mode's verdict is modal, and that is what gives Cancel something
  // to prove here that it cannot prove on the banner: the card's conflict
  // effect runs a LOOP, so cancelling out of the diff has to come back to the
  // conflict sheet. A card that treated the compare sheet as a replacement
  // for the question would leave the user with no question at all and a
  // buffer still in conflict.

  test(
    "manual mode: the conflict sheet's Diff… detours and returns, and resolves both ways",
    async () => {
      const TYPED_ONE = "MANUAL-DISCARDED ";
      const TYPED_TWO = "MANUAL-KEPT ";
      const EXTERNAL_ONE = "EXTERNAL-MANUAL-ONE marker";
      const EXTERNAL_TWO = "EXTERNAL-MANUAL-TWO marker";
      const { dir, file } = mkFixture("at0607-manual-");
      const app = await launchTugApp({ testName: "at0607-compare-manual" });
      try {
        await seedTextCard(app, file, "manual");
        await waitForEditorShowing(app, "fixture line 01");
        await proveWatchLive(app, file);

        // ---- The first conflict, resolved with Reload from Disk ----
        await typeIntoEditor(app, TYPED_ONE);
        fs.writeFileSync(file, touchingExternal(EXTERNAL_ONE), "utf8");
        await waitFor(app, SHEET_DIFF, true);
        // Manual mode writes nothing on its own, so the modal is up over the
        // external bytes exactly as they were written.
        expect(fs.readFileSync(file, "utf8")).toBe(touchingExternal(EXTERNAL_ONE));

        await app.click(SHEET_DIFF);
        await waitFor(app, COMPARE_SHEET, true);
        await assertDiffShows(app, "manual first diff", EXTERNAL_ONE, TYPED_ONE.trim());

        // The loop: Cancel out of the diff and the QUESTION comes back.
        await app.click(COMPARE_CANCEL);
        await waitFor(app, COMPARE_SHEET, false);
        await waitFor(app, SHEET_DIFF, true);
        await settle();
        expect(
          await editorText(app),
          "looking at the diff changed nothing",
        ).toContain(TYPED_ONE.trim());

        await app.click(SHEET_DIFF);
        await waitFor(app, COMPARE_SHEET, true);
        await app.click(COMPARE_RELOAD);
        await waitFor(app, COMPARE_SHEET, false);
        // Both surfaces are gone: the conflict is resolved, not re-asked.
        await waitFor(app, SHEET_DIFF, false);
        await waitForEditorShowing(app, EXTERNAL_ONE, 15_000);
        const reloaded = await editorText(app);
        expect(reloaded, "Reload discarded the buffer's typing").not.toContain(
          TYPED_ONE.trim(),
        );
        expect(
          fs.readFileSync(file, "utf8"),
          "and manual mode still wrote nothing",
        ).toBe(touchingExternal(EXTERNAL_ONE));

        // ---- A second conflict, resolved with Keep Mine ----
        await settle();
        await typeIntoEditor(app, TYPED_TWO);
        fs.writeFileSync(file, touchingExternal(EXTERNAL_TWO), "utf8");
        await waitFor(app, SHEET_DIFF, true);

        await app.click(SHEET_DIFF);
        await waitFor(app, COMPARE_SHEET, true);
        await assertDiffShows(app, "manual second diff", EXTERNAL_TWO, TYPED_TWO.trim());

        // Keep Mine in manual mode routes to the real-file save, which is the
        // one gesture that puts the buffer on disk here.
        await app.click(COMPARE_KEEP_MINE);
        await waitFor(app, COMPARE_SHEET, false);
        await waitFor(app, SHEET_DIFF, false);
        const kept = await waitForDisk(file, (c) => c.includes(TYPED_TWO.trim()));
        expect(kept, "Keep Mine saved the buffer over the external write").toContain(
          TYPED_TWO.trim(),
        );
        expect(kept, "so the line it replaced is gone").not.toContain(EXTERNAL_TWO);
        expect(await editorText(app)).toContain(TYPED_TWO.trim());
      } finally {
        await app.close();
        rmFixture(dir);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
