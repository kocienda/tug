/**
 * at0420-case-transforms.test.ts — Edit ▸ Make Uppercase / Make Lowercase
 * on the two text substrates, and the menu gate they ride.
 *
 * The pair is a chain-action round-trip, like the paste variants: the host
 * sends `make-uppercase` / `make-lowercase` and the focused surface rewrites
 * its selection. So there are three claims worth pinning through the real
 * app, and each one is a way the feature can be wrong while the code reads
 * right:
 *
 *   - **Only the selection moves.** The transform replaces the selected run
 *     and nothing else — a handler that reached for the whole document would
 *     pass any test that selected everything.
 *   - **The selection survives the transform.** Pressing the pair twice in a
 *     row has to act on the same run, which means the replacement carries the
 *     selection with it rather than leaving a collapsed caret at its end.
 *     Uppercase-then-lowercase returning the original text is that assertion.
 *   - **Undo reverts the run whole.** The CM6 substrates rewrite in one
 *     transaction, so one ⌘Z takes back the whole transform rather than a
 *     character of it.
 *
 * Driven through `dispatchControlAction` — the same wire `AppDelegate`'s
 * `performMakeUppercase` sends — rather than through ⌥⌘U, so the test needs
 * no key window. The chords themselves are pinned as key equivalents in the
 * last case: both items are built with EMPTY key equivalents in Swift and
 * take their chord from the registry sweep, which is what keeps them
 * rebindable, so "the item carries ⌥⌘U" is a claim about the sweep and not
 * about a construction literal.
 *
 * Selection is made with ⇧← rather than ⌘A: shift-arrows are the substrate's
 * own keys, while ⌘A is an Edit-menu key equivalent that AppKit resolves
 * against a key window this instance does not have.
 *
 * Every card is a body, so its surface is reached through `app.body(id)`;
 * the menu and the control frames are the shell's, which hands an action to
 * the key card's body. A seed that changes a card's component under the same
 * id keeps the body it has, so the menu case seeds each surface under its own
 * id.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugapp/Sources/AppDelegate.swift
 * @covers tugdeck/src/components/tugways/tug-text-editor.tsx
 * @covers tugdeck/src/components/tugways/use-text-input-responder.tsx
 * @covers tugdeck/src/components/tugways/command-registry.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, type App, type BodyApp } from "./_harness";
import { waitForBodyReady } from "./_harness/card-reach";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 150_000;

const UPPERCASE = "edit.makeUppercase";
const LOWERCASE = "edit.makeLowercase";

/** `NSEvent.ModifierFlags` raw values, so an expectation reads as a chord. */
const OPTION = 1 << 19;
const COMMAND = 1 << 20;

const EDITOR = '[data-card-id="A"] [data-slot="tug-text-editor"] .cm-content';
const inputOf = (cardId: string): string => `[data-card-id="${cardId}"] input`;
const INPUT = inputOf("A");

/** One pane holding one gallery card of the given component. */
function paneOf(component: string, cardId: string) {
  return {
    cards: [{ id: cardId, componentId: component, title: `Card ${cardId}`, closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 60, y: 60 },
        size: { width: 720, height: 540 },
        cardIds: [cardId],
        activeCardId: cardId,
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

// Kept local: every file's `seed` builds its own deck and waits on its own
// readiness, so the name is shared and the function is not. Returns the
// card's body.
async function seed(app: App, component: string, cardId = "A"): Promise<BodyApp> {
  await app.enableDeckTrace(true);
  await app.seedDeckState({ state: paneOf(component, cardId), focusCardId: cardId });
  await app.waitForCondition<boolean>(
    `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered(${JSON.stringify(cardId)})`,
  );
  return waitForBodyReady(app, cardId);
}

/** Select the last `count` characters back from the caret. */
async function selectBack(app: App, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await app.nativeKey("ArrowLeft", ["shift"]);
    await new Promise((r) => setTimeout(r, 30));
  }
}

/** Wait for a surface's text to settle on `want`, and report what it held. */
async function waitText(
  page: BodyApp,
  script: string,
  want: string,
  timeoutMs = 4000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  let last: string | null = null;
  while (Date.now() < deadline) {
    last = await page.evalJS<string | null>(script);
    if (last === want) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  return last;
}

/** Poll the validated menu-item state until it matches `wantEnabled`. */
async function expectEnabled(app: App, identifier: string, want: boolean): Promise<void> {
  const deadline = Date.now() + 8000;
  let last: { found: boolean; enabled?: boolean } = { found: false };
  while (Date.now() < deadline) {
    last = await app.menuItemState(identifier);
    if (last.found && last.enabled === want) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(last.found, `${identifier} must exist`).toBe(true);
  expect(last.enabled, `${identifier} enabled=${want}`).toBe(want);
}

describe.skipIf(!SHOULD_RUN)("AT0420: Make Uppercase / Make Lowercase", () => {
  test(
    "CM6 editor: the selected run transforms, keeps its selection, and undoes whole",
    async () => {
      const app = await launchTugApp({ testName: "at0420-editor" });
      const readText = `(function(){
        var ed = document.querySelector(${JSON.stringify(EDITOR)});
        return ed === null ? null : ed.textContent;
      })()`;
      try {
        const body = await seed(app, "gallery-text-editor");
        await app.awaitEngineReady("A");
        await body.nativeClickAtElement(EDITOR);
        await body.waitForCondition<boolean>(
          `document.activeElement !== null && document.activeElement.matches(${JSON.stringify(EDITOR)})`,
          { timeoutMs: 2000 },
        );

        await app.nativeType("hello tug");
        expect(await waitText(body, readText, "hello tug")).toBe("hello tug");

        // Select "tug" — three characters back from the caret, so the
        // untouched "hello " in front of it is the control.
        await selectBack(app, 3);
        await app.dispatchControlAction("make-uppercase");
        expect(await waitText(body, readText, "hello TUG")).toBe("hello TUG");

        // The second press proves the first left the selection on the run it
        // rewrote: a collapsed caret here would leave "hello TUG" standing.
        await app.dispatchControlAction("make-lowercase");
        expect(await waitText(body, readText, "hello tug")).toBe("hello tug");

        // One transaction per transform — one undo takes the whole run back.
        await app.dispatchControlAction("undo");
        expect(await waitText(body, readText, "hello TUG")).toBe("hello TUG");
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0420-editor] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "native input: the selected run transforms and a bare caret is a no-op",
    async () => {
      const app = await launchTugApp({ testName: "at0420-input" });
      const readValue = `(function(){
        var el = document.querySelector(${JSON.stringify(INPUT)});
        return el === null ? null : el.value;
      })()`;
      try {
        const body = await seed(app, "gallery-input");
        await body.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(INPUT)}) !== null`,
          { timeoutMs: 6000 },
        );
        await body.nativeClickAtElement(INPUT);
        // The gallery input ships with sample text; clear it so the typed
        // string is the whole value and the assertions can name it.
        await body.evalJS(`(function(){
          var el = document.querySelector(${JSON.stringify(INPUT)});
          if (el !== null) { el.focus(); el.select(); }
        })()`);
        await app.nativeKey("Delete");
        await app.nativeType("hello tug");
        expect(await waitText(body, readValue, "hello tug")).toBe("hello tug");

        await selectBack(app, 3);
        await app.dispatchControlAction("make-uppercase");
        expect(await waitText(body, readValue, "hello TUG")).toBe("hello TUG");

        await app.dispatchControlAction("make-lowercase");
        expect(await waitText(body, readValue, "hello tug")).toBe("hello tug");

        // A collapsed caret is a no-op: the verb acts on a selection, and
        // nothing should land on the undo stack for it.
        await app.nativeKey("ArrowRight");
        await app.dispatchControlAction("make-uppercase");
        await new Promise((r) => setTimeout(r, 400));
        expect(await body.evalJS<string | null>(readValue)).toBe("hello tug");
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0420-input] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the menu items follow focus and take their chords from the sweep",
    async () => {
      const app = await launchTugApp({ testName: "at0420-menu" });
      try {
        // A card of labels and separators handles neither verb, so both items
        // are dark. Not `gallery-label`: its paired inputs answer both, and an
        // activated card's first responder is its default focus target's.
        await seed(app, "gallery-separator");
        await expectEnabled(app, UPPERCASE, false);
        await expectEnabled(app, LOWERCASE, false);

        // A writable text surface lights them. Enablement is focus-granular,
        // not caret-granular — the edit block republishes on focus and
        // registration changes, so a selection-granular gate would be stale
        // by the time the menu opened.
        const body = await seed(app, "gallery-input", "B");
        await body.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(inputOf("B"))}) !== null`,
          { timeoutMs: 6000 },
        );
        await body.nativeClickAtElement(inputOf("B"));
        await expectEnabled(app, UPPERCASE, true);
        await expectEnabled(app, LOWERCASE, true);

        // Both items are built with no key equivalent, so what they carry is
        // what `applyCommandChords` wrote from the registry.
        const upper = await app.menuItemState(UPPERCASE);
        expect(upper.found ? upper.keyEquivalent : undefined, "⌥⌘U").toBe("u");
        expect(upper.found ? upper.modifierMask : undefined).toBe(COMMAND | OPTION);
        const lower = await app.menuItemState(LOWERCASE);
        expect(lower.found ? lower.keyEquivalent : undefined, "⌥⌘L").toBe("l");
        expect(lower.found ? lower.modifierMask : undefined).toBe(COMMAND | OPTION);
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0420-menu] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
