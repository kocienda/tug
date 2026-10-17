/**
 * text-card-live-autosave-fixture.ts — the fixtures, deck shape and gestures
 * the at0209-text-card-live-autosave-* files share.
 *
 * Everything drives real code paths on real files: the fixture is a real temp
 * file, autosave goes through tugcast's `/api/fs/write`, and the assertions
 * read disk with Bun's fs — no mocks anywhere. Edits are driven by focusing
 * CM6's contenteditable and running `document.execCommand("insertText")`,
 * which fires the REAL beforeinput → CM6 input pipeline; native CGEvent
 * typing needs the app frontmost, which unattended sweeps can't guarantee.
 *
 * @module tests/app-test/text-card-live-autosave-fixture
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { launchTugApp, note, type App, type BodyApp } from "./_harness";
import {
  AUTOMATIC_SAVE_MODE,
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankWrite,
} from "./_harness/tugbank-helpers";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

export const TEST_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

export const FIXTURE_LINES: ReadonlyArray<string> = Array.from(
  { length: 24 },
  (_, i) => `fixture line ${String(i + 1).padStart(2, "0")} alpha beta gamma`,
);
export const FIXTURE_CONTENT = FIXTURE_LINES.join("\n") + "\n";

export function rmFixture(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Deck seeding
// ---------------------------------------------------------------------------

export const EDITOR_CONTENT_SELECTOR =
  '[data-card-id="A"] [data-slot="tug-text-card-editor"] .cm-content';

/** The Text card's own page: every editor reach below runs there. */
function editorPage(app: App): BodyApp {
  return app.body("A");
}

export const EDITOR_SCROLLER_SELECTOR =
  '[data-card-id="A"] [data-slot="tug-text-card-editor"] .cm-scroller';

// A tall fixture — enough lines to scroll well past the 560px pane so a
// nonzero scrollTop is a real viewport offset, not a rounding artifact.
export const TALL_LINES: ReadonlyArray<string> = Array.from(
  { length: 200 },
  (_, i) => `tall line ${String(i + 1).padStart(3, "0")} alpha beta gamma delta`,
);
export const TALL_CONTENT = TALL_LINES.join("\n") + "\n";

export function mkTallFixture(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "at0209-tall-"));
  const file = path.join(dir, "tall.txt");
  fs.writeFileSync(file, TALL_CONTENT, "utf8");
  return { dir, file };
}

export function deckShape() {
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
 * Seed the shell page's save-mode default to "automatic". Manual is the
 * shipping default ([P01]); these files exercise the retained automatic
 * live-autosave path. A Text card in its own page reads its own tugbank
 * snapshot, not the shell's client cache, so a body card's mode is seeded
 * into the tugbank the app launches on instead — `AUTOMATIC_SAVE_MODE`
 * through `mkSeededTugbank`, or `tugbankWrite` as `launchOnWatchedFixture`
 * does. This remains for a card the shell mounts.
 */
export async function seedAutomaticSaveMode(app: App): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.setTugbankValue("dev.tugapp.text-card","save-mode",{kind:"string",value:"automatic"}), null)`,
  );
}

export async function seedTextCard(app: App, filePath: string): Promise<void> {
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
export async function waitForEditorShowing(
  app: App,
  sentinel: string,
  timeoutMs = 8000,
): Promise<void> {
  await editorPage(app).waitForCondition<boolean>(
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
export async function typeIntoEditor(app: App, text: string): Promise<void> {
  const ok = await editorPage(app).evalJS<boolean>(
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
export async function undoOnce(app: App): Promise<void> {
  await editorPage(app).evalJS<null>(
    `(function(){
      var el = document.querySelector('${EDITOR_CONTENT_SELECTOR}');
      if (el !== null) el.focus();
      return null;
    })()`,
  );
  await app.evalJS<void>(`window.__tug.dispatchControlAction("undo")`);
}

/** Poll the validated Edit ▸ Undo state until it matches, or time out. */
export async function waitForUndoState(
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
export async function waitForDisk(
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

export const CHECKOUT = fs.realpathSync(path.resolve(import.meta.dir, "..", ".."));
export const WATCHED_HOME = path.join(CHECKOUT, ".tug");

/** The autosave debounce the store arms on every keystroke. */
export const AUTOSAVE_DEBOUNCE_MS = 1000;

export const WARMUP_BODY = "WARMUP marker\n";

export function mkWatchedFixture(prefix: string): { dir: string; file: string } {
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
export async function warmUpWatcher(app: App, file: string): Promise<void> {
  fs.writeFileSync(file, WARMUP_BODY, "utf8");
  await waitForEditorShowing(app, "WARMUP marker", 60_000);
  fs.writeFileSync(file, FIXTURE_CONTENT, "utf8");
  await editorPage(app).waitForCondition<boolean>(
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
export async function launchOnWatchedFixture(
  file: string,
  testName: string,
): Promise<{ app: App; tugbankPath: string }> {
  const tugbankPath = mkTempTugbank();
  seedTugbankForLaunch(tugbankPath, { sourceTreePath: CHECKOUT });
  tugbankWrite(tugbankPath, AUTOMATIC_SAVE_MODE.domain, AUTOMATIC_SAVE_MODE.key, AUTOMATIC_SAVE_MODE.type, AUTOMATIC_SAVE_MODE.value);
  const app = await launchTugApp({
    bodies: true,
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
export function editorText(app: App): Promise<string> {
  return editorPage(app).evalJS<string>(
    `document.querySelector('${EDITOR_CONTENT_SELECTOR}').innerText`,
  );
}
