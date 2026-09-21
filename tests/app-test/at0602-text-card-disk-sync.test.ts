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
 * 5. **A card that is not in front: unfocused but visible.** Two panes,
 *    focus on the other card, nothing about the watched card touched.
 *    The reload lands and holds its reading position anyway, and takes
 *    no focus on the way in — nothing in the path is focus-gated.
 *
 * 6. **A card that is not in front: a hidden background tab.** The
 *    stacked non-active card carries `display: none`, so it has no
 *    layout and CM6 can neither measure nor anchor in it. Park the
 *    viewport in front, switch away, write the file from outside,
 *    switch back: the content must be the disk's AND the reading
 *    position must be where it was left.
 *
 * 7. **A write nothing was watching, healed on reconnect.** The
 *    harness puts this instance's tugcast down (`app.stopTugcast()`),
 *    the file is written while it is gone, and tugcast comes back:
 *    the buffer catches up with no interaction of any kind. The app,
 *    its window and the loaded page all survive the outage — the app
 *    re-authenticates in place rather than reloading — so what heals
 *    is the client's own `connectionDidOpen` re-`watch`, and the
 *    editor element the catch-up lands in is checked to be the same
 *    object it was before, which is what rules out a reload having
 *    re-read the file instead.
 *
 * 8. **A merge into a hidden DIRTY buffer.** The store keeps no copy of
 *    the buffer — every save path reads it back through the editor — so a
 *    reload held for a hidden card must still answer with the text it is
 *    holding. Read out of the aside record, which is the artifact a quit
 *    leaves behind: the merged text has to be in it, paired with the
 *    post-merge baseline hash it is written against.
 *
 * 9. **A card that is not in front: a hidden WORKSPACE.** Scenario 6's
 *    shape with the `display: none` several ancestors further up —
 *    `space-layer.css` hides a whole workspace the same way a stacked
 *    card host is hidden. The deferral observes the editor's scroller,
 *    not whatever went hidden, so this says whether the observer fires
 *    when the element that regains a box is an ancestor of the one
 *    being observed.
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
 * - The editor's hidden-card deferral removed, so `replaceText` dispatches
 *   into a `display: none` view the way it used to: **exactly scenario 6
 *   AND scenario 9 red, the other eight green** — including scenario 5,
 *   which is the same not-in-front case with layout. The discrimination is
 *   the hidden state itself and nothing adjacent to it, and the two reds are
 *   the two ancestors that can carry the `display: none`: the card host and
 *   the workspace layer.
 * - The deferral dispatched straight from the `ResizeObserver` callback with
 *   no extra frame and no hand-rolled `scrollTop` correction — the shape the
 *   editor now ships: **all green**. Both used to be load-bearing, and both
 *   stopped being so when `dispatchReplacement` began flushing CM6's measure
 *   on each side of the dispatch, which refreshes the stale metrics a hidden
 *   card leaves behind and applies the anchor before the callback returns.
 * - `onConnectionDidOpen` in `file-watch-client.ts` patched to forget its
 *   `seq` map and `reset` the server without re-`watch`ing: **exactly
 *   scenario 7 red**, on the catch-up wait, and green again with the
 *   re-`watch` restored. Nothing else in the file notices, because nothing
 *   else in the file ever loses a frame.
 * - The editor's bridge `getText` returned to `cmView.state.doc.toString()`,
 *   so a hidden view answers with its stale document rather than with the
 *   text the deferral is holding: **exactly scenario 8 red**, the aside
 *   carrying the pre-merge buffer under the post-merge hash. Every other
 *   scenario green, because no other one asks the buffer for its text while
 *   a deferral is outstanding.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/text-card-store.ts
 * @covers tugdeck/src/lib/file-watch-client.ts
 * @covers tugdeck/src/lib/three-way-merge.ts
 * @covers tugdeck/src/components/tugways/tug-text-card-editor.tsx
 * @covers tugdeck/src/components/tugways/cards/text-card.tsx
 * @covers tugrust/crates/tugcast/src/feeds/file_watch.rs
 * @covers tugdeck/src/components/chrome/space-layer.css
 * @covers tugdeck/src/components/chrome/space-layer.ts
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

/**
 * The body written while tugcast is down. A line PREPENDED to the fixture, so
 * the catch-up is visible as new text at the top and the old body is still
 * there to check — a wholesale replacement could not tell a reload from a
 * card that lost its file.
 */
const OUTAGE_SENTINEL = "WRITTEN DURING THE OUTAGE";
const OUTAGE_CONTENT = `${OUTAGE_SENTINEL}\n${FIXTURE_CONTENT}`;

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
 * Two panes, both on screen, each with its own Text card. Card A holds the
 * watched fixture and card B is what focus sits on — the ordinary Tug shape
 * where an agent rewrites a file whose card the reader is not typing in.
 */
function deckShapeTwoPanes() {
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
function deckShapeStacked() {
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

/**
 * Seed a two-card deck. `shape` decides whether the cards sit in two panes
 * (both visible) or stacked in one (the non-active one hidden), and `focusCard`
 * decides where focus lands. Card A is bound to the watched fixture, card B to
 * a second file it never shares.
 */
async function seedTwoTextCards(
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
 * The set-aside autosave directory. `~`-expanded by the fs endpoints the store
 * writes through, so the records land in the real one.
 */
const ASIDES_DIR = path.join(
  os.homedir(),
  "Library/Application Support/Tug/Autosave Information",
);

/** The fields of an aside record this file reads. */
interface AsideRecord {
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
function readAsideFor(file: string): AsideRecord | null {
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
async function waitForAside(
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
function removeAsideFor(file: string): void {
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

  // -------------------------------------------------------------------------
  // Scenario 5: a reload into an unfocused but visible card
  // -------------------------------------------------------------------------
  //
  // Every scenario above runs on the focused, visible card, and that is not the
  // Tug-common shape: the reader is typing in one card while an agent rewrites
  // a file open in another. This is that shape with both cards on screen —
  // card A holds the watched fixture in its own pane, focus sits on card B in a
  // second pane, and nothing about A is touched for the whole scenario. The
  // reload has to land and hold A's reading position anyway.
  //
  // Unfocused is a weaker condition than hidden: an unfocused card still has
  // layout, so CM6 can measure and anchor. What this pins is that nothing in
  // the reload path is gated on focus — a `hasFocus` check anywhere in the
  // anchor correction would show up here and nowhere else in this file.
  test(
    "an external write reloads an unfocused but visible card in place",
    async () => {
      const { dir, file } = mkFixture("at0602-unfocused-", TALL_CONTENT);
      const other = mkFixture("at0602-unfocused-other-", FIXTURE_CONTENT);
      const app = await launchTugApp({ testName: "at0602-unfocused-visible" });
      note(`at0602 out-of-workspace fixture: ${file}`);
      try {
        await seedTwoTextCards(
          app,
          deckShapeTwoPanes(),
          file,
          other.file,
          "B",
          "manual",
        );
        await waitForEditorShowing(app, "tall line 001");
        await proveWatchLive(app, file, TALL_CONTENT, "tall line 001");

        // Focus really is elsewhere, and card A really is on screen. Both have
        // to hold or the scenario is testing the focused case again under a
        // different name.
        const focused = await app.evalJS<string | null>(
          `window.__tug.getFocusedCardId()`,
        );
        expect(focused, "focus sits on the other card").toBe("B");
        const visible = await app.evalJS<boolean>(
          `(function(){
            var host = document.querySelector('[data-card-host][data-card-id="A"]');
            if (host === null) return false;
            return getComputedStyle(host).display !== "none"
              && document.querySelector('${EDITOR_SCROLLER_SELECTOR}').getBoundingClientRect().height > 100;
          })()`,
        );
        expect(visible, "card A is on screen with a laid-out editor").toBe(true);

        // Park A's viewport and read which line sits at its top.
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

        // The only gesture: a write from outside the app, with focus still on B.
        fs.writeFileSync(file, "EXTERNAL-WRITER LINE\n" + TALL_CONTENT, "utf8");
        await app.waitForCondition<boolean>(
          `document.querySelector('${EDITOR_SCROLLER_SELECTOR}').scrollHeight > ${before.scrollHeight} + 4`,
          { timeoutMs: 20_000 },
        );

        const after = await app.evalJS<{
          text: string;
          delta: number;
          scrollTop: number;
          scrollHeight: number;
        }>(readTop);
        note(
          `at0602 unfocused reload: top line ${JSON.stringify(before.text.slice(0, 14))} ` +
            `-> ${JSON.stringify(after.text.slice(0, 14))}, scrollTop ${Math.round(before.scrollTop)} -> ${Math.round(after.scrollTop)}`,
        );
        expect(after.text, "the same line is still at the viewport top").toBe(
          before.text,
        );
        expect(Math.abs(after.delta - before.delta)).toBeLessThanOrEqual(2);

        // The reload never stole focus on its way in.
        expect(
          await app.evalJS<string | null>(`window.__tug.getFocusedCardId()`),
        ).toBe("B");

        // And the disk content really is in the buffer.
        await app.evalJS<null>(
          `(document.querySelector('${EDITOR_SCROLLER_SELECTOR}').scrollTop = 0, null)`,
        );
        await waitForEditorShowing(app, "EXTERNAL-WRITER LINE");
      } finally {
        await app.close();
        rmFixture(dir);
        rmFixture(other.dir);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Scenario 6: a reload into a hidden tab, read when it is brought forward
  // -------------------------------------------------------------------------
  //
  // The harder half of the not-in-front case. A stacked card that is not the
  // active one is mounted and alive but carries `display: none`
  // (`card-host.tsx`), so it has NO layout: CM6 cannot measure it and cannot
  // anchor a change in it. `_applyDiskRead` calls `bridge.replaceText`
  // regardless of whether the bridge's view is visible, so the reload lands in
  // a view that cannot compute where to put the reader — and until this
  // scenario nothing said what the card shows when it comes forward.
  //
  // The shape: park the viewport while the card is in front, switch to the
  // other tab, write the file from outside, switch back, and read. Both answers
  // are asserted — the content must be the disk's, and the reading position
  // must be where it was left. A hidden editor that silently kept stale text,
  // or came forward at the top of the file, fails here.
  test(
    "an external write to a hidden card is current and in place when it is shown",
    async () => {
      const { dir, file } = mkFixture("at0602-hidden-", TALL_CONTENT);
      const other = mkFixture("at0602-hidden-other-", FIXTURE_CONTENT);
      const app = await launchTugApp({ testName: "at0602-hidden-then-shown" });
      note(`at0602 out-of-workspace fixture: ${file}`);
      try {
        await seedTwoTextCards(
          app,
          deckShapeStacked(),
          file,
          other.file,
          "A",
          "manual",
        );
        await waitForEditorShowing(app, "tall line 001");
        await proveWatchLive(app, file, TALL_CONTENT, "tall line 001");

        // Park the viewport while the card is still in front — the place the
        // reader is owed back has to be established while CM6 can measure it.
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

        // Send card A to the background and prove it is really hidden — the
        // whole premise is `display: none`, so a shape that left it visible
        // would make this a duplicate of Scenario 5.
        await app.evalJS<void>(`window.__tug.activateCard("B")`);
        await app.waitForCondition<boolean>(
          `(function(){
            var host = document.querySelector('[data-card-host][data-card-id="A"]');
            return host !== null && getComputedStyle(host).display === "none";
          })()`,
          { timeoutMs: 6000 },
        );
        const hiddenHeight = await app.evalJS<number>(
          `document.querySelector('${EDITOR_SCROLLER_SELECTOR}').getBoundingClientRect().height`,
        );
        expect(
          hiddenHeight,
          "a display:none editor has no layout to measure",
        ).toBe(0);

        // Write from outside the app while the card is in the background.
        fs.writeFileSync(file, "EXTERNAL-WRITER LINE\n" + TALL_CONTENT, "utf8");

        // Nothing observable is coming while the card is hidden: `innerText` is
        // empty for a `display: none` subtree, and CM6 renders no new viewport
        // without a measure pass. So wait the delivery out rather than polling
        // for it. `proveWatchLive` above measured the real latency for this
        // fixture and noted it — a few hundred milliseconds; this is an order of
        // magnitude more than that.
        await new Promise((resolve) => setTimeout(resolve, 6000));

        // Bring it forward. This is the moment the reader is owed both things.
        await app.evalJS<void>(`window.__tug.activateCard("A")`);
        await app.waitForCondition<boolean>(
          `(function(){
            var host = document.querySelector('[data-card-host][data-card-id="A"]');
            return host !== null && getComputedStyle(host).display !== "none"
              && document.querySelector('${EDITOR_SCROLLER_SELECTOR}').getBoundingClientRect().height > 100;
          })()`,
          { timeoutMs: 6000 },
        );

        // The deferred reload lands a frame after the box appears, so wait for
        // the content rather than assuming the show and the text are the same
        // tick. A deferral that never applied times out here and says so.
        await app.waitForCondition<boolean>(
          `document.querySelector('${EDITOR_SCROLLER_SELECTOR}').scrollHeight > ${before.scrollHeight} + 4`,
          { timeoutMs: 6000 },
        );

        const after = await app.evalJS<{
          text: string;
          delta: number;
          scrollTop: number;
          scrollHeight: number;
        } | null>(readTop);
        note(
          `at0602 hidden reload: top line ${JSON.stringify(before.text.slice(0, 14))} ` +
            `-> ${JSON.stringify(after === null ? null : after.text.slice(0, 14))}, scrollTop ` +
            `${Math.round(before.scrollTop)} -> ${after === null ? "none" : Math.round(after.scrollTop)}, ` +
            `scrollHeight ${Math.round(before.scrollHeight)} -> ${after === null ? "none" : Math.round(after.scrollHeight)}`,
        );
        expect(after, "the shown editor renders lines").not.toBeNull();
        if (after === null) throw new Error("unreachable");

        // The content is the disk's: the added row made the document taller.
        expect(
          after.scrollHeight,
          "the hidden card adopted the external write",
        ).toBeGreaterThan(before.scrollHeight + 4);
        // And the reading position survived the round trip through hidden.
        expect(after.text, "the same line is still at the viewport top").toBe(
          before.text,
        );
        expect(Math.abs(after.delta - before.delta)).toBeLessThanOrEqual(2);

        // The whole disk content really is in the buffer, not just its height.
        await app.evalJS<null>(
          `(document.querySelector('${EDITOR_SCROLLER_SELECTOR}').scrollTop = 0, null)`,
        );
        await waitForEditorShowing(app, "EXTERNAL-WRITER LINE");
      } finally {
        await app.close();
        rmFixture(dir);
        rmFixture(other.dir);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Scenario 7: a write nothing was watching, healed on reconnect
  // -------------------------------------------------------------------------
  //
  // The outage is the whole apparatus. `app.stopTugcast()` answers only once
  // the child is gone, so the write that follows is one no watcher on either
  // side of the wire ever saw — which is exactly the gap the client's
  // `connectionDidOpen` re-`watch` exists to close, and exactly the gap no
  // scenario above can produce.
  //
  // Two guards keep it from passing for the wrong reason. The buffer is read
  // DURING the outage and must still hold the old body — otherwise the write
  // was delivered normally and there was no gap to heal. And a marker is
  // stamped on the live `.cm-content` element before the outage and must
  // still be there after the catch-up — otherwise the page reloaded or the
  // card remounted, and a fresh read from disk would look identical from the
  // outside while proving nothing about the heal.
  test(
    "a write during a tugcast outage lands on reconnect with no interaction",
    async () => {
      const { dir, file } = mkFixture("at0602-outage-", FIXTURE_CONTENT);
      const app = await launchTugApp({ testName: "at0602-reconnect-heal" });
      note(`at0602 out-of-workspace fixture: ${file}`);
      try {
        await seedTextCard(app, file, "manual");
        await waitForEditorShowing(app, "fixture line 01");
        await proveWatchLive(app, file, FIXTURE_CONTENT, "fixture line 01");

        // Stamp the live editor element. A property, not an attribute: it
        // cannot survive serialization, so it is only still readable if this
        // is the same element object the outage started with.
        await app.evalJS<null>(
          `(document.querySelector('${EDITOR_CONTENT_SELECTOR}').__at0602Outage = "kept", null)`,
        );

        const downAt = Date.now();
        await app.stopTugcast();
        note(`at0602 tugcast down after ${Date.now() - downAt}ms`);

        // The write nothing is watching.
        fs.writeFileSync(file, OUTAGE_CONTENT, "utf8");

        // Wait out an ordinary delivery before claiming the gap is real.
        // `proveWatchLive` noted this fixture's real latency a moment ago —
        // a few hundred milliseconds — and this is an order of magnitude
        // more than that.
        await new Promise((resolve) => setTimeout(resolve, 5000));
        const during = await editorText(app);
        expect(
          during.includes(OUTAGE_SENTINEL),
          "nothing was watching: the write did not reach the buffer",
        ).toBe(false);
        expect(
          during.includes("fixture line 01"),
          "the buffer still holds the body it had before the outage",
        ).toBe(true);

        const upAt = Date.now();
        await app.startTugcast();
        // No interaction of any kind between here and the assertion: no
        // click, no focus, no keystroke, no scroll. The reconnect is the
        // only thing that happens.
        await waitForEditorShowing(app, OUTAGE_SENTINEL, 60_000);
        note(`at0602 buffer caught up ${Date.now() - upAt}ms after tugcast came back`);

        const marker = await app.evalJS<string | null>(
          `(function(){
            var el = document.querySelector('${EDITOR_CONTENT_SELECTOR}');
            return el === null ? null : (el.__at0602Outage || null);
          })()`,
        );
        expect(
          marker,
          "the same editor element caught up — no page reload, no remount",
        ).toBe("kept");

        const after = await editorText(app);
        expect(
          after.includes("fixture line 01"),
          "the whole disk body is in the buffer, not just its first line",
        ).toBe(true);
        await assertNoConflictSurface(app);
      } finally {
        await app.close();
        rmFixture(dir);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Scenario 8: a merge into a hidden DIRTY buffer, read out of the aside
  // -------------------------------------------------------------------------
  //
  // Scenario 6's card was clean, and a clean card is the easy half: the store
  // adopts the disk's text and nothing reads the buffer back until the card
  // comes forward. A DIRTY hidden card is the half with teeth, because the
  // store keeps no copy of the buffer — every path that needs the text asks
  // the editor for it, and while a reload is deferred the editor's document is
  // the PRE-merge text while the store's baseline and hash have already moved
  // to the disk's.
  //
  // The aside is where that shows, and it is the artifact that matters: it is
  // what a quit leaves behind and what a restore comes back as. A record
  // pairing the pre-merge text with the post-merge baseline hash is the
  // dangerous combination — the card would restore believing it is in step
  // with a disk it has never seen, and the next save would write over the
  // external editor's work with no conflict and no banner.
  //
  // Manual mode deliberately: nothing autosaves, so the buffer stays dirty for
  // as long as the scenario needs and there is no debounce to race. The aside
  // is found by its own `path` field rather than by re-deriving the filename
  // hash, so the reader cannot go quietly stale against `asidePathFor`.
  test(
    "a merge into a hidden dirty buffer sets the aside to the merged text",
    async () => {
      const { dir, file } = mkFixture("at0602-hidden-dirty-", FIXTURE_CONTENT);
      const other = mkFixture("at0602-hidden-dirty-other-", FIXTURE_CONTENT);
      const app = await launchTugApp({ testName: "at0602-hidden-dirty-merge" });
      note(`at0602 out-of-workspace fixture: ${file}`);
      try {
        await seedTwoTextCards(
          app,
          deckShapeStacked(),
          file,
          other.file,
          "A",
          "manual",
        );
        await waitForEditorShowing(app, "fixture line 01");
        await proveWatchLive(app, file, FIXTURE_CONTENT, "fixture line 01");

        // Dirty the buffer while the card is in front — the only way in, since
        // a `display: none` card cannot be typed into.
        await typeIntoEditor(app, TYPED_RUN);
        const typed = await waitForAside(
          file,
          (rec) => rec.content.includes(TYPED_RUN.trim()),
          "the typing reached the aside",
        );

        // Send the card to the background, and prove it really has no layout —
        // that is the whole premise, and a visible card would make this
        // scenario a duplicate of the merge scenarios above.
        await app.evalJS<void>(`window.__tug.activateCard("B")`);
        await app.waitForCondition<boolean>(
          `(function(){
            var host = document.querySelector('[data-card-host][data-card-id="A"]');
            return host !== null && getComputedStyle(host).display === "none";
          })()`,
          { timeoutMs: 6000 },
        );
        expect(
          await app.evalJS<number>(
            `document.querySelector('${EDITOR_SCROLLER_SELECTOR}').getBoundingClientRect().height`,
          ),
          "a display:none editor has no layout to measure",
        ).toBe(0);

        // The external write, distant from the typing, while nothing is in
        // front. The store merges it and re-captures the aside.
        const external = FIXTURE_CONTENT.replace(
          FIXTURE_LINES[19] as string,
          EXTERNAL_LINE,
        );
        fs.writeFileSync(file, external, "utf8");

        // The merge landed when the aside's baseline moved to the disk's new
        // hash. Waiting on THAT rather than on the content is what makes the
        // assertion below able to fail: a record written against the new
        // baseline is a record the store believes is current.
        const merged = await waitForAside(
          file,
          (rec) => rec.baselineSha256 !== typed.baselineSha256,
          "the merge re-captured the aside against the new disk hash",
        );
        note(
          `at0602 hidden dirty aside: baseline ${String(typed.baselineSha256).slice(0, 8)} -> ` +
            `${String(merged.baselineSha256).slice(0, 8)}, ${merged.content.length}b, ` +
            `typing ${merged.content.includes(TYPED_RUN.trim())}, external ${merged.content.includes(EXTERNAL_LINE)}`,
        );

        // Both edits, in the record that survives a quit. Without the merged
        // text reaching the aside this holds the pre-merge buffer under the
        // post-merge hash, which is the silent clobber.
        expect(
          merged.content.includes(TYPED_RUN.trim()),
          "the aside still holds the user's own typing",
        ).toBe(true);
        expect(
          merged.content.includes(EXTERNAL_LINE),
          "and the external edit the merge brought in",
        ).toBe(true);

        // Bringing the card forward lands the deferred text, so the editor
        // agrees with the record that was written while it could not.
        await app.evalJS<void>(`window.__tug.activateCard("A")`);
        await waitForEditorShowing(app, EXTERNAL_LINE, 10_000);
        const shown = await editorText(app);
        expect(shown, "the shown editor holds the user's typing too").toContain(
          TYPED_RUN.trim(),
        );
        await assertNoConflictSurface(app);

        // Manual mode writes nothing without being asked.
        expect(fs.readFileSync(file, "utf8")).toBe(external);
      } finally {
        await app.close();
        removeAsideFor(file);
        rmFixture(dir);
        rmFixture(other.dir);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Scenario 9: a reload into a card in a hidden WORKSPACE
  // -------------------------------------------------------------------------
  //
  // Scenario 6 hides the card with `display: none` on its own card host.
  // `space-layer.css` hides a whole workspace the same way, several ancestors
  // further up, and the deferral's `ResizeObserver` is attached to the
  // editor's scroller rather than to whatever went `display: none` — so the
  // question this answers is whether the observer fires when the element that
  // regains a box is an ANCESTOR of the one being observed.
  //
  // It should: an element inside a `display: none` subtree is skipped by
  // `ResizeObserver` and reported when it gets a box back, regardless of which
  // ancestor was hiding it. That is the reading; a scenario is what makes it a
  // fact. If this ever goes red the deferral has to re-arm on the workspace
  // transition as well — `useSpaceLayerShown()` is the condition that names it
  // — rather than on the scroller's own box alone.
  //
  // Otherwise the shape is scenario 6's exactly, so the two differ only in
  // which ancestor is hidden, which is the comparison worth having.
  test(
    "an external write to a card in a hidden workspace is current and in place",
    async () => {
      const { dir, file } = mkFixture("at0602-space-", TALL_CONTENT);
      const app = await launchTugApp({ testName: "at0602-hidden-workspace" });
      note(`at0602 out-of-workspace fixture: ${file}`);
      try {
        await seedTextCard(app, file, "manual");
        await waitForEditorShowing(app, "tall line 001");
        await proveWatchLive(app, file, TALL_CONTENT, "tall line 001");

        // Park the viewport while the workspace is on screen — the place the
        // reader is owed back has to be established while CM6 can measure it.
        await app.evalJS<null>(
          `(document.querySelector('${EDITOR_SCROLLER_SELECTOR}').scrollTop = 900, null)`,
        );
        const readTop = `(function(){
          var scroller = document.querySelector('${EDITOR_SCROLLER_SELECTOR}');
          if (scroller === null) return null;
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

        const home = await app.evalJS<string>(
          `window.tugdeck.diag.getSpaces().activeSpaceId`,
        );

        // A new workspace, through the real verb the Window menu sends. The
        // card is left mounted in a layer the canvas stops showing, which is
        // the state under test.
        await app.evalJS<null>(
          `(window.tugdeck.lab.dispatch("new-space"), null)`,
        );
        // Past the crossfade beat, and with the card's own layer confirmed
        // hidden — the premise is an ANCESTOR carrying `display: none`, so a
        // shape that left the card's host visible would prove nothing.
        await app.waitForCondition<boolean>(
          `(function(){
            if (document.querySelector('.tug-space-layer[data-space-crossing]') !== null) return false;
            var host = document.querySelector('[data-card-host][data-card-id="A"]');
            if (host === null) return false;
            var layer = host.closest('.tug-space-layer');
            return layer !== null && !layer.hasAttribute('data-space-shown')
              && getComputedStyle(host).display !== "none";
          })()`,
          { timeoutMs: 8000 },
        );
        const hiddenHeight = await app.evalJS<number>(
          `(function(){
            var s = document.querySelector('${EDITOR_SCROLLER_SELECTOR}');
            return s === null ? -1 : s.getBoundingClientRect().height;
          })()`,
        );
        expect(
          hiddenHeight,
          "a card in a hidden workspace has no layout to measure",
        ).toBe(0);

        // Write from outside the app while the workspace is off screen.
        fs.writeFileSync(file, "EXTERNAL-WRITER LINE\n" + TALL_CONTENT, "utf8");

        // Nothing observable arrives while the layer is hidden, for scenario
        // 6's reasons: no boxes, and no CM6 measure pass. Wait the delivery
        // out — `proveWatchLive` measured the real latency and noted it, and
        // this is an order of magnitude more.
        await new Promise((resolve) => setTimeout(resolve, 6000));

        // Back to the workspace the card is in. This is the moment the reader
        // is owed both things.
        await app.evalJS<null>(
          `(window.tugdeck.lab.dispatch("activate-space", { spaceId: ${JSON.stringify(home)} }), null)`,
        );
        await app.waitForCondition<boolean>(
          `(function(){
            var host = document.querySelector('[data-card-host][data-card-id="A"]');
            if (host === null) return false;
            var layer = host.closest('.tug-space-layer');
            if (layer === null || !layer.hasAttribute('data-space-shown')) return false;
            var s = document.querySelector('${EDITOR_SCROLLER_SELECTOR}');
            return s !== null && s.getBoundingClientRect().height > 100;
          })()`,
          { timeoutMs: 8000 },
        );

        await app.waitForCondition<boolean>(
          `(function(){
            var s = document.querySelector('${EDITOR_SCROLLER_SELECTOR}');
            return s !== null && s.scrollHeight > ${before.scrollHeight} + 4;
          })()`,
          { timeoutMs: 8000 },
        );

        const after = await app.evalJS<{
          text: string;
          delta: number;
          scrollTop: number;
          scrollHeight: number;
        } | null>(readTop);
        note(
          `at0602 hidden-workspace reload: top line ${JSON.stringify(before.text.slice(0, 14))} ` +
            `-> ${JSON.stringify(after === null ? null : after.text.slice(0, 14))}, scrollTop ` +
            `${Math.round(before.scrollTop)} -> ${after === null ? "none" : Math.round(after.scrollTop)}, ` +
            `scrollHeight ${Math.round(before.scrollHeight)} -> ${after === null ? "none" : Math.round(after.scrollHeight)}`,
        );
        expect(after, "the shown editor renders lines").not.toBeNull();
        if (after === null) throw new Error("unreachable");

        expect(
          after.scrollHeight,
          "the card in the hidden workspace adopted the external write",
        ).toBeGreaterThan(before.scrollHeight + 4);
        expect(
          after.text,
          "the same line is still at the viewport top",
        ).toBe(before.text);
        expect(Math.abs(after.delta - before.delta)).toBeLessThanOrEqual(2);

        // The whole disk content really is in the buffer, not just its height.
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

});
