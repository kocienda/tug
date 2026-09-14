/**
 * at0574-card-masthead-file-menu.test.ts — a document card's masthead answers a
 * right-click ANYWHERE on it with the file's own items.
 *
 * ## What this gates
 *
 * The tier shows three facts about one file — its name, its path, how it stands
 * — and until this it could act on none of them. The title line is a `TugLabel`
 * and a label is intrinsically copyable, so a press there offered a bare `Copy`
 * of the filename's characters; the path line and the tier's own ground claimed
 * nothing and fell through to the app's "No Actions". The surface showing a
 * path most plainly was the one surface that could not copy it.
 *
 * So the presses under test land on the TITLE and on the PATH: the run that
 * answered with the wrong menu, and the run that answered with none. Both have
 * to come back with the same three items, in the registry's order — Show in
 * Finder, then Copy Path and Copy as Atom under a rule — and with nothing else
 * answering the same press, which is what the `TugLabel`'s own menu would do if
 * the tier were not asked first (`onContextMenuCapture`).
 *
 * `Copy Path` is taken all the way to the pasteboard through the real gesture —
 * a native right-click, a native click on the item — rather than by calling the
 * writer: what this gates is that the menu REACHES the writer, which is the
 * half a hand-called writer cannot see. `Copy as Atom` is read the same way,
 * and its plain flavor is the file's `[name](<path>)` spelling, so the two
 * items are visibly two serializations of one entity rather than two copies of
 * one string.
 *
 * @covers tugdeck/src/components/tugways/file-identity-menu.tsx
 * @covers tugdeck/src/components/tugways/card-masthead.tsx
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const CARD = '[data-card-id="A"]';
const EDITOR_CONTENT = `${CARD} [data-slot="tug-text-card-editor"] .cm-content`;
// The masthead is the PANE's title bar, not a descendant of the card.
const PANE = '[data-pane-id="p1"]';
const MASTHEAD_TITLE = `${PANE} [data-testid="card-masthead-title"]`;
const MASTHEAD_DESCRIPTION = `${PANE} [data-testid="card-masthead-description"]`;
const MENU = '[data-slot="tug-editor-context-menu"]';

/** Distinguishes "the copy wrote this" from "the copy never happened". */
const SENTINEL = "at0574-sentinel-nothing-copied";

const FIXTURE_CONTENT = "masthead fixture\n";

function mkFixture(): { dir: string; file: string } {
  // `realpathSync` because `/var` is a symlink to `/private/var` on macOS and
  // the card resolves the path it was handed: what the menu copies is the real
  // one, and a fixture that kept the link would compare two spellings of one
  // file.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "at0574-")));
  const file = path.join(dir, "sample.txt");
  fs.writeFileSync(file, FIXTURE_CONTENT, "utf8");
  return { dir, file };
}

function setPasteboard(text: string): void {
  Bun.spawnSync(["pbcopy"], { stdin: Buffer.from(text) });
}

function readPasteboard(): string {
  return Bun.spawnSync(["pbpaste"]).stdout.toString();
}

/**
 * The clipboard write lands asynchronously — the handler runs inside the item's
 * mousedown and the promise settles after it — so the read is polled.
 */
async function pasteboardSettlesTo(want: string): Promise<string> {
  let pasted = readPasteboard();
  for (let tries = 0; tries < 20 && pasted !== want; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    pasted = readPasteboard();
  }
  return pasted;
}

/** Every row of the open menu, in the order it renders. */
function menuRows(): string {
  return `Array.prototype.map.call(
     document.querySelectorAll(${JSON.stringify(MENU)} + ' [role="menuitem"]'),
     function (item) {
       return {
         action: item.getAttribute("data-item-action") || "",
         label: (item.querySelector(".tug-menu-item-label") || item).textContent || "",
         disabled: item.getAttribute("aria-disabled") === "true",
       };
     })`;
}

async function seedTextCard(app: App, filePath: string): Promise<void> {
  await app.seedDeckState({
    state: {
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
    },
    cardStates: {
      A: { content: { path: filePath, anchor: { line: 1, ch: 0 }, scrollTop: 0 } },
    },
    focusCardId: "A",
  });
  await app.waitForCondition<boolean>(
    `(function(){
      var el = document.querySelector(${JSON.stringify(EDITOR_CONTENT)});
      return el !== null && el.innerText.indexOf("masthead fixture") !== -1;
    })()`,
    { timeoutMs: 15_000 },
  );
}

/**
 * Open the tier's menu on `selector` and read it back. A REAL right button,
 * not a dispatched `contextmenu`: the pane's drag takes pointer capture on the
 * frame at pointer-down and WebKit retargets every later event of that pointer
 * to the capture element, so a synthetic press skips the half of this that the
 * title bar's own guard exists for.
 */
async function openMenuAt(
  app: App,
  selector: string,
): Promise<ReadonlyArray<{ action: string; label: string; disabled: boolean }>> {
  await app.nativeRightClickAtElement(selector);
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(MENU)}) !== null`,
    { timeoutMs: 8_000 },
  );
  // And nothing else answered the same press — the label's own Copy menu is
  // the one this would otherwise stack under.
  expect(
    await app.evalJS<number>(`document.querySelectorAll('.tug-menu-content').length`),
  ).toBe(1);
  return await app.evalJS<
    ReadonlyArray<{ action: string; label: string; disabled: boolean }>
  >(menuRows());
}

async function closeMenu(app: App): Promise<void> {
  await app.nativeKey("Escape");
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(MENU)}) === null`,
    { timeoutMs: 8_000 },
  );
}

describe.skipIf(!SHOULD_RUN)("at0574 — the document masthead's own menu", () => {
  test(
    "the title and the path both answer with the file's items, and both copies reach the pasteboard",
    async () => {
      const { file } = mkFixture();
      const app = await launchTugApp({ testName: "at0574-card-masthead-file-menu" });
      try {
        await seedTextCard(app, file);

        // ---- The run that used to answer with the wrong menu. -------------
        const onTitle = await openMenuAt(app, MASTHEAD_TITLE);
        note("at0574 title menu", JSON.stringify(onTitle));
        expect(onTitle.map((r) => r.action)).toEqual([
          "reveal-in-finder",
          "copy-annotation-value",
          "copy-annotation-atom",
        ]);
        expect(onTitle.map((r) => r.label)).toEqual([
          "Show in Finder",
          "Copy Path",
          "Copy as Atom",
        ]);
        expect(onTitle.every((r) => !r.disabled)).toBe(true);
        await closeMenu(app);

        // ---- The run that used to answer with nothing. --------------------
        const onPath = await openMenuAt(app, MASTHEAD_DESCRIPTION);
        note("at0574 path menu", JSON.stringify(onPath));
        expect(onPath.map((r) => r.action)).toEqual(onTitle.map((r) => r.action));

        // ---- Copy Path carries the path itself. ---------------------------
        setPasteboard(SENTINEL);
        await app.nativeClickAtElement(`${MENU} [data-item-action="copy-annotation-value"]`);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(MENU)}) === null`,
          { timeoutMs: 8_000 },
        );
        const copiedPath = await pasteboardSettlesTo(file);
        note("at0574 Copy Path", JSON.stringify(copiedPath));
        expect(copiedPath).toBe(file);

        // ---- Copy as Atom carries the same file as an OBJECT. -------------
        // Its plain flavor is the file atom's own spelling — the name a reader
        // sees over the path a paste outside Tug needs.
        const atomText = `[${path.basename(file)}](<${file}>)`;
        setPasteboard(SENTINEL);
        await openMenuAt(app, MASTHEAD_DESCRIPTION);
        await app.nativeClickAtElement(`${MENU} [data-item-action="copy-annotation-atom"]`);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(MENU)}) === null`,
          { timeoutMs: 8_000 },
        );
        const copiedAtom = await pasteboardSettlesTo(atomText);
        note("at0574 Copy as Atom", JSON.stringify(copiedAtom));
        expect(copiedAtom).toBe(atomText);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
