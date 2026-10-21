/**
 * at0748-paste-over-selected-atom.test.ts — Paste replaces a selected atom.
 *
 * A chip selected in a prompt entry is a selection like any other: Edit ▸
 * Paste (⌘V) replaces it with what the pasteboard holds. The menu item sends
 * AppKit's `paste:` to the card's web view, so WebKit runs its own paste and
 * the editor answers the DOM `paste` event it fires — the whole route a real
 * ⌘V takes, which is why the item is performed rather than an event
 * dispatched by hand. The chip is selected by the hand's own gestures, a
 * double-click and Shift-→, since how a selection is made is what decides
 * where WebKit thinks the selection is.
 *
 * The control is the same paste over a selected run of plain text, so a red
 * here is about the atom, not about paste.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @foreground
 *
 * @covers tugdeck/src/components/tugways/tug-text-editor.tsx
 * @covers tugdeck/src/components/tugways/tug-text-editor/clipboard-filters.ts
 * @covers tugdeck/src/components/tugways/tug-text-editor/atom-decoration.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 90_000;

const ATOM_CHAR = "￼";
const ROUTE = "❯";
const SEED_TEXT = `hello ${ATOM_CHAR} and ${ATOM_CHAR} world`;
const PASTED = "PASTED";
const SESSION_ID = "f6e43925-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const COMPOSER = '[data-card-id="A"] [data-slot="tug-text-editor"] .cm-content';
const CHIP = `${COMPOSER} img:not(.cm-widgetBuffer)`;
/** The composer's own view, in its page. */
const VIEW = `document.querySelector(${JSON.stringify(COMPOSER)}).cmTile.root.view`;

function setPasteboard(text: string): void {
  Bun.spawnSync(["pbcopy"], { stdin: Buffer.from(text) });
}

function fileAtom(position: number, name: string) {
  return { position, type: "file", label: name, value: `/path/to/${name}` };
}

interface Draft {
  text: string;
  atoms: ReturnType<typeof fileAtom>[];
}

const TWO_CHIPS: Draft = {
  text: SEED_TEXT,
  atoms: [fileAtom(SEED_TEXT.indexOf(ATOM_CHAR), "one.ts"), fileAtom(SEED_TEXT.lastIndexOf(ATOM_CHAR), "two.ts")],
};

/** The composer holding nothing but a chip, at the document's first position. */
const LONE_CHIP: Draft = { text: ATOM_CHAR, atoms: [fileAtom(0, "lone.ts")] };

async function seed(app: App, draft: Draft): Promise<void> {
  await app.seedDeckState({
    state: {
      cards: [{ id: "A", componentId: "gallery-prompt-entry", title: "Prompt A", closable: true }],
      panes: [
        {
          id: "p1",
          position: { x: 40, y: 40 },
          size: { width: 720, height: 540 },
          cardIds: ["A"],
          activeCardId: "A",
          title: "",
          acceptsFamilies: ["maker"],
        },
      ],
      activePaneId: "p1",
      hasFocus: true,
    },
    cardStates: {
      A: {
        content: {
          route: ROUTE,
          draft: {
            text: draft.text,
            atoms: draft.atoms,
            selection: null,
          },
          maximized: false,
        },
      },
    },
    focusCardId: "A",
  });
  await app.awaitEngineReady("A");
  await app.body("A").waitForCondition<boolean>(
    `(function(){
      var s = window.__tug.getEmCardState("A");
      return s !== null && s.text === ${JSON.stringify(draft.text)};
    })()`,
    { timeoutMs: 4_000 },
  );
}

/**
 * Make A's view the window's first responder — where the menu's `paste:`
 * goes — and focus its composer.
 */
async function focusComposer(app: App): Promise<void> {
  await app.dispatchControlAction("focus-session-card", { cardId: "A" });
  const deadline = Date.now() + 5_000;
  while (!(await app.bodies()).some((b) => b.cardId === "A" && b.firstResponder === true)) {
    if (Date.now() > deadline) throw new Error("A's view never became the first responder");
    await Bun.sleep(50);
  }
  await app.body("A").focusElement(COMPOSER);
}

/** Set the composer's selection to `[from, to)` through its own view. */
async function select(app: App, from: number, to: number): Promise<void> {
  await app.body("A").evalJS<null>(
    `(function(){ var view = ${VIEW}; view.focus(); view.dispatch({ selection: { anchor: ${from}, head: ${to} } }); return null; })()`,
  );
}

/** The composer's main selection, as the editor holds it. */
async function selection(app: App): Promise<{ from: number; to: number }> {
  return app.body("A").evalJS<{ from: number; to: number }>(
    `(function(){ var s = ${VIEW}.state.selection.main; return { from: s.from, to: s.to }; })()`,
  );
}

async function docText(app: App): Promise<string> {
  return app.body("A").evalJS<string>(`${VIEW}.state.doc.toString()`);
}

/** The composer's chips' types, in document order, read off the chips it draws. */
async function atomTypes(app: App): Promise<string[]> {
  return app.body("A").evalJS<string[]>(
    `Array.from(document.querySelectorAll(${JSON.stringify(CHIP)})).map(function (c) { return c.getAttribute("data-atom-type"); })`,
  );
}

/** A session atom on the pasteboard, written by the chip's own copy (`writeSessionAtomToClipboard`). */
async function copySessionAtom(app: App): Promise<void> {
  // card-dom: shell — `copySessionAtom` is the shell's surface; the pasteboard is the app's.
  const wrote = await app.evalJS<boolean>(`window.__tug.copySessionAtom(${JSON.stringify(SESSION_ID)})`);
  expect(wrote, "the session atom is on the pasteboard").toBe(true);
}

/**
 * Edit ▸ Paste — AppKit's `paste:` into the view, which is where ⌘V goes
 * (`paste` is a native command) — then what the composer holds once it holds
 * `expected` or has had time to.
 */
async function pasteAndRead(app: App, expected: string): Promise<string> {
  const performed = await app.performMenuItem("edit.paste");
  expect(performed.found && performed.performed, "Edit ▸ Paste performs").toBe(true);
  try {
    await app.body("A").waitForCondition<boolean>(`${VIEW}.state.doc.toString() === ${JSON.stringify(expected)}`, {
      timeoutMs: 3_000,
    });
  } catch {
    // The read below says what landed instead.
  }
  return docText(app);
}

describe.skipIf(!SHOULD_RUN)("at0748 — paste over a selected atom", () => {
  test(
    "Edit ▸ Paste replaces a chip the hand selected, as it replaces selected text",
    async () => {
      const app = await launchTugApp({ testName: "at0748-paste-over-atom", foreground: true });
      try {
        await seed(app, TWO_CHIPS);
        setPasteboard(PASTED);
        await focusComposer(app);

        // The control: selected text is replaced.
        await select(app, 0, "hello".length);
        let expected = `${PASTED} ${ATOM_CHAR} and ${ATOM_CHAR} world`;
        const overText = await pasteAndRead(app, expected);
        note(`over text: ${JSON.stringify(overText)}`);
        expect(overText, "Paste replaces selected text").toBe(expected);

        // The first chip, selected by a double-click.
        await app.body("A").nativeDoubleClickAtElement(CHIP);
        const first = overText.indexOf(ATOM_CHAR);
        const byDoubleClick = await selection(app);
        note(`double-click selects ${JSON.stringify(byDoubleClick)}`);
        expect(byDoubleClick, "a double-click selects the chip").toEqual({ from: first, to: first + 1 });
        expected = `${PASTED} ${PASTED} and ${ATOM_CHAR} world`;
        const overDoubleClicked = await pasteAndRead(app, expected);
        note(`over the double-clicked chip: ${JSON.stringify(overDoubleClicked)}`);
        expect(overDoubleClicked, "Paste replaces a double-clicked chip").toBe(expected);

        // The second chip, selected by Shift-→ from the caret before it.
        const second = overDoubleClicked.indexOf(ATOM_CHAR);
        await select(app, second, second);
        await app.nativeKey("ArrowRight", ["shift"]);
        // The key is posted to the window; the page handles it a beat later.
        try {
          await app.body("A").waitForCondition<boolean>(`${VIEW}.state.selection.main.to === ${second + 1}`, {
            timeoutMs: 2_000,
          });
        } catch {
          // The read below says where the selection stands instead.
        }
        const byShiftArrow = await selection(app);
        note(`Shift-→ selects ${JSON.stringify(byShiftArrow)}`);
        expect(byShiftArrow, "Shift-→ selects the chip").toEqual({ from: second, to: second + 1 });
        expected = `${PASTED} ${PASTED} and ${PASTED} world`;
        const overShiftSelected = await pasteAndRead(app, expected);
        note(`over the Shift-→ chip: ${JSON.stringify(overShiftSelected)}`);
        expect(overShiftSelected, "Paste replaces a Shift-→ selected chip").toBe(expected);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "plain text pasted over a lone session chip replaces it",
    async () => {
      const app = await launchTugApp({ testName: "at0748-text-over-session-chip", foreground: true });
      try {
        await seed(app, { text: "", atoms: [] });
        await focusComposer(app);
        // The chip arrives the way a reader's does: a session atom copied,
        // and pasted into the empty composer.
        await copySessionAtom(app);
        await pasteAndRead(app, ATOM_CHAR);
        expect(await atomTypes(app), "the composer holds one session chip").toEqual(["session"]);

        setPasteboard(PASTED);
        await app.body("A").nativeDoubleClickAtElement(CHIP);
        const selected = await selection(app);
        note(`double-click selects ${JSON.stringify(selected)}`);
        expect(selected, "a double-click selects the session chip").toEqual({ from: 0, to: 1 });
        const pasted = await pasteAndRead(app, PASTED);
        note(`over the session chip: ${JSON.stringify(pasted)}`);
        expect(pasted, "Paste replaces the session chip").toBe(PASTED);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a session atom pasted over a lone chip replaces it",
    async () => {
      const app = await launchTugApp({ testName: "at0748-session-over-chip", foreground: true });
      try {
        await seed(app, LONE_CHIP);
        await focusComposer(app);
        await copySessionAtom(app);
        await app.body("A").nativeDoubleClickAtElement(CHIP);
        const selected = await selection(app);
        note(`double-click selects ${JSON.stringify(selected)}`);
        expect(selected, "a double-click selects the chip").toEqual({ from: 0, to: 1 });
        await app.performMenuItem("edit.paste");
        try {
          await app.body("A").waitForCondition<boolean>(
            `JSON.stringify(Array.from(document.querySelectorAll(${JSON.stringify(CHIP)})).map(function (c) { return c.getAttribute("data-atom-type"); })) === '["session"]'`,
            { timeoutMs: 3_000 },
          );
        } catch {
          // The reads below say what landed instead.
        }
        const text = await docText(app);
        const types = await atomTypes(app);
        note(`over the chip: ${JSON.stringify({ text, types })}`);
        expect({ text, types }, "the session chip stands where the chip was, alone").toEqual({
          text: ATOM_CHAR,
          types: ["session"],
        });
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
