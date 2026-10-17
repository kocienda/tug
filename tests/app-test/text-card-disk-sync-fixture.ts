/**
 * text-card-disk-sync-fixture.ts — the fixtures, deck shapes and instruments
 * the at0602-text-card-disk-sync-* files share.
 *
 * Every fixture those files write lives in an OS temp directory, outside
 * every workspace: the per-file watch is the only way a card hears about a
 * change to such a file, so the location is half of what each scenario
 * asserts. Each file launches its own app per scenario; what they share is
 * how a Text card is seeded onto a file, how the watch is proven live before
 * anything depends on it, and how the buffer, the disk and the aside record
 * are read.
 *
 * Input path and undo gesture follow `at0209`: edits go through
 * `document.execCommand("insertText")` so the real beforeinput → CM6
 * pipeline runs, and undo goes through `dispatchControlAction("undo")`
 * rather than a synthetic ⌘Z, which CM6's keymap eats before the menu bar
 * sees it.
 *
 * @module tests/app-test/text-card-disk-sync-fixture
 */

import { expect } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { note, type App, type BodyApp } from "./_harness";
import { waitForBodyReady } from "./_harness/card-reach";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

export const TEST_TIMEOUT_MS = 120_000;

/** The user's typing in the merge scenarios: line 1, at the caret the card opens with. */
export const TYPED_RUN = "MERGED-TYPING ";
/** The external edit in the merge scenarios: line 20, far from the typing. */
export const EXTERNAL_LINE = "EXTERNAL-WRITER LINE TWENTY";

/** The autosave debounce the store arms on every keystroke. */
export const AUTOSAVE_DEBOUNCE_MS = 1000;

// ---------------------------------------------------------------------------
// Fixtures — every one of them outside every workspace
// ---------------------------------------------------------------------------

export const FIXTURE_LINES: ReadonlyArray<string> = Array.from(
  { length: 24 },
  (_, i) => `fixture line ${String(i + 1).padStart(2, "0")} alpha beta gamma`,
);
export const FIXTURE_CONTENT = FIXTURE_LINES.join("\n") + "\n";

// Tall enough that a mid-document scrollTop is a real viewport offset
// rather than a rounding artifact against the 560px pane.
export const TALL_LINES: ReadonlyArray<string> = Array.from(
  { length: 200 },
  (_, i) => `tall line ${String(i + 1).padStart(3, "0")} alpha beta gamma delta`,
);
export const TALL_CONTENT = TALL_LINES.join("\n") + "\n";

export const WARMUP_BODY = "WARMUP marker\n";

/**
 * The body written while tugcast is down. A line PREPENDED to the fixture, so
 * the catch-up is visible as new text at the top and the old body is still
 * there to check — a wholesale replacement could not tell a reload from a
 * card that lost its file.
 */
export const OUTAGE_SENTINEL = "WRITTEN DURING THE OUTAGE";
export const OUTAGE_CONTENT = `${OUTAGE_SENTINEL}\n${FIXTURE_CONTENT}`;

export function rmFixture(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Deck seeding
// ---------------------------------------------------------------------------

export const EDITOR_CONTENT_SELECTOR =
  '[data-card-id="A"] [data-slot="tug-text-card-editor"] .cm-content';

export const EDITOR_SCROLLER_SELECTOR =
  '[data-card-id="A"] [data-slot="tug-text-card-editor"] .cm-scroller';

/** Card A's own page: every editor and conflict-surface reach below runs there. */
function editorPage(app: App): BodyApp {
  return app.body("A");
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
 * Two panes, both on screen, each with its own Text card. Card A holds the
 * watched fixture and card B is what focus sits on — the ordinary Tug shape
 * where an agent rewrites a file whose card the reader is not typing in.
 */
export function deckShapeTwoPanes() {
  return {
    cards: [
      { id: "A", componentId: "text", title: "Watched", closable: true },
      { id: "B", componentId: "text", title: "Other", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 700, height: 560 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["standard"],
      },
      {
        id: "p2",
        position: { x: 780, y: 40 },
        size: { width: 460, height: 560 },
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
 * One pane holding two stacked cards. The non-active one is mounted and alive
 * but hidden with `display: none` (`card-host.tsx`), which is the state a
 * background tab is in — no layout at all, so CM6 can neither measure nor
 * anchor while it is back there.
 */
export function deckShapeStacked() {
  return {
    cards: [
      { id: "A", componentId: "text", title: "Watched", closable: true },
      { id: "B", componentId: "text", title: "Other", closable: true },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 760, height: 560 },
        cardIds: ["A", "B"],
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
 * `setTugbankValue` populates the shell page's client cache, which is what
 * `readSaveMode` reads for a card the shell mounts. A Text card in its own
 * page reads its own tugbank snapshot instead, so an automatic scenario on a
 * body card also launches on a tugbank seeded with `AUTOMATIC_SAVE_MODE`
 * (`mkSeededTugbank`). Manual is the shipping default; the automatic
 * scenarios opt in.
 */
export async function seedSaveMode(app: App, mode: "automatic" | "manual"): Promise<void> {
  await app.evalJS<null>(
    `(window.__tug.setTugbankValue("dev.tugapp.text-card","save-mode",{kind:"string",value:${JSON.stringify(mode)}}), null)`,
  );
}

export async function seedTextCard(
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

/**
 * Seed a two-card deck. `shape` decides whether the cards sit in two panes
 * (both visible) or stacked in one (the non-active one hidden), and `focusCard`
 * decides where focus lands. Card A is bound to the watched fixture, card B to
 * a second file it never shares.
 */
export async function seedTwoTextCards(
  app: App,
  shape: ReturnType<typeof deckShapeTwoPanes> | ReturnType<typeof deckShapeStacked>,
  fileA: string,
  fileB: string,
  focusCard: "A" | "B",
  mode: "automatic" | "manual",
): Promise<void> {
  await seedSaveMode(app, mode);
  await app.seedDeckState({
    state: shape,
    cardStates: {
      A: { content: { path: fileA, anchor: { line: 1, ch: 0 }, scrollTop: 0 } },
      B: { content: { path: fileB, anchor: { line: 1, ch: 0 }, scrollTop: 0 } },
    },
    focusCardId: focusCard,
  });
}

/** Wait until the editor is mounted and renders a sentinel line. */
export async function waitForEditorShowing(
  app: App,
  sentinel: string,
  timeoutMs = 8000,
): Promise<void> {
  await (await waitForBodyReady(app, "A")).waitForCondition<boolean>(
    `(function(){
      var el = document.querySelector('${EDITOR_CONTENT_SELECTOR}');
      return el !== null && el.innerText.indexOf(${JSON.stringify(sentinel)}) !== -1;
    })()`,
    { timeoutMs },
  );
}

/** The rendered buffer text. */
export function editorText(app: App): Promise<string> {
  return editorPage(app).evalJS<string>(
    `document.querySelector('${EDITOR_CONTENT_SELECTOR}').innerText`,
  );
}

/**
 * Type into the editor through CM6's real input pipeline: focus the
 * contenteditable and insert via `execCommand("insertText")`, which fires
 * beforeinput exactly like a keystroke.
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
    throw new Error("[at0602] typeIntoEditor: insertText was not handled");
  }
}

/**
 * Undo once through the control action, never the ⌘Z chord: CM6's keymap
 * eats the chord before the menu bar sees it (`at0174` records why).
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
    `[at0602] disk predicate not satisfied within ${timeoutMs}ms; last content:\n${last.slice(0, 400)}`,
  );
}

/** Nothing on either conflict surface — the banner or the sheet. */
export async function assertNoConflictSurface(app: App): Promise<void> {
  const open = await editorPage(app).evalJS<string[]>(
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
 * The set-aside autosave directory. `~`-expanded by the fs endpoints the store
 * writes through, so the records land in the real one.
 */
export const ASIDES_DIR = path.join(
  os.homedir(),
  "Library/Application Support/Tug/Autosave Information",
);

/** The fields of an aside record this file reads. */
export interface AsideRecord {
  path: string | null;
  content: string;
  baselineSha256: string | null;
}

/**
 * The aside record the store has written for `file`, or null.
 *
 * Found by the record's OWN `path` field rather than by re-deriving
 * `asidePathFor`'s FNV-1a filename hash here: a reader that duplicated that
 * derivation would go silently stale the day the hash changed, and answer
 * "no aside" for a file that has one.
 */
export function readAsideFor(file: string): AsideRecord | null {
  if (!fs.existsSync(ASIDES_DIR)) return null;
  for (const name of fs.readdirSync(ASIDES_DIR)) {
    if (!name.startsWith("aside-") || !name.endsWith(".json")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(ASIDES_DIR, name), "utf8"));
    } catch {
      // A record caught mid-write, or one this test has no business reading.
      continue;
    }
    if (parsed === null || typeof parsed !== "object") continue;
    const rec = parsed as Partial<AsideRecord>;
    if (rec.path !== file || typeof rec.content !== "string") continue;
    return {
      path: rec.path,
      content: rec.content,
      baselineSha256: rec.baselineSha256 ?? null,
    };
  }
  return null;
}

/** Wait until `file`'s aside record satisfies `ready`, and answer with it. */
export async function waitForAside(
  file: string,
  ready: (rec: AsideRecord) => boolean,
  what: string,
  timeoutMs = 20_000,
): Promise<AsideRecord> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rec = readAsideFor(file);
    if (rec !== null && ready(rec)) return rec;
    if (Date.now() >= deadline) {
      throw new Error(
        `[at0602] timed out after ${timeoutMs}ms waiting for ${what}` +
          ` (aside ${rec === null ? "absent" : `${rec.content.length}b`})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Leave the user's real autosave directory as it was found. */
export function removeAsideFor(file: string): void {
  if (!fs.existsSync(ASIDES_DIR)) return;
  for (const name of fs.readdirSync(ASIDES_DIR)) {
    if (!name.startsWith("aside-") || !name.endsWith(".json")) continue;
    const full = path.join(ASIDES_DIR, name);
    try {
      const rec = JSON.parse(
        fs.readFileSync(full, "utf8"),
      ) as Partial<AsideRecord>;
      if (rec !== null && rec.path === file) fs.rmSync(full, { force: true });
    } catch {
      continue;
    }
  }
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
export async function proveWatchLive(
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
  await editorPage(app).waitForCondition<boolean>(
    `(function(){
      var el = document.querySelector('${EDITOR_CONTENT_SELECTOR}');
      if (el === null) return false;
      var t = el.innerText;
      return t.indexOf(${JSON.stringify(restoreSentinel)}) !== -1 && t.indexOf("WARMUP marker") === -1;
    })()`,
    { timeoutMs: 20_000 },
  );
}
