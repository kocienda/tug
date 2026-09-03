/**
 * at0168-menu-structure.test.ts — the menu bar's structure contract.
 *
 * Asserts the full static menu structure through the harness's
 * `menuSnapshot`: every identifier present with its expected key
 * equivalent and modifier mask, the dead NSTextView find-panel items
 * gone, the flattened File menu (no New submenu shell), the Session
 * menu present, and the Maker menu hidden under default app-test
 * prefs (empty per-instance tugbank → maker mode reads false under
 * the harness).
 *
 * Assertions are by identifier only — titles localize and identity
 * never rides the title.
 *
 * Also pins the enablement that used to be written imperatively at build
 * time, where `autoenablesItems` silently overrode it: About / Settings,
 * the four View zoom items, and Open Recent. The zoom items live in the
 * dynamic View body, which the snapshot reaches because it runs each
 * menu's `menuNeedsUpdate` the way a real open would. The theme list and
 * `window.pane.*` are still not asserted here — their membership is
 * deck- and filesystem-derived, not a structure contract.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugapp/Sources/AppDelegate.swift
 * @covers tugdeck/src/lib/host-menu-state.ts
 * @foreground
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, type App } from "./_harness";

/**
 * The item's validated enabled state, asserting it exists first. Reading
 * `.enabled` off the raw result does not type-check: `menuItemState` returns
 * a discriminated union, and a missing item carries no state at all.
 */
async function itemEnabled(app: App, identifier: string): Promise<boolean> {
  const state = await app.menuItemState(identifier);
  expect(state.found, `${identifier} present in the menu`).toBe(true);
  return state.found ? state.enabled : false;
}

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

// NSEvent.ModifierFlags raw bits.
// AppKit's private-use characters for the arrow key equivalents —
// `NSUpArrowFunctionKey` / `NSDownArrowFunctionKey`, which is what
// `codeToKeyEquivalent` writes for "ArrowUp" / "ArrowDown".
const ARROW_UP = "\u{F700}";
const ARROW_DOWN = "\u{F701}";
const ARROW_LEFT = "\u{F702}";
const ARROW_RIGHT = "\u{F703}";

const MOD = {
  shift: 1 << 17,
  control: 1 << 18,
  option: 1 << 19,
  command: 1 << 20,
} as const;

/**
 * The six sidebar cards, by the component id their Window rows are addressed
 * with. The Arcs card's is `dashes` — a persistence key ([D141]), not a stale
 * name. One list, read by the contract table below and by the depth check
 * that says those rows are a submenu.
 */
const SIDEBAR_CARD_IDS = [
  "jots",
  "tripwires",
  "dashes",
  "cards",
  "layout",
  "overview",
] as const;

/**
 * The static structure contract: identifier → expected key equivalent
 * (+ exact modifier mask where the item carries a promoted chord).
 * Items with `key: ""` are mouse-only; their default mask is not
 * asserted.
 */
const STATIC_ITEMS: ReadonlyArray<{ id: string; key?: string; mods?: number }> = [
  // Tug (app) menu
  { id: "app.about" },
  { id: "app.configureTug", key: "" },
  { id: "app.logout", key: "" },
  { id: "app.settings", key: ",", mods: MOD.command },
  // ⌃⌘K, stamped onto the item by the registry's chord sweep.
  { id: "app.keyboardShortcuts", key: "k", mods: MOD.command | MOD.control },
  // File
  { id: "file.newSessionCard", key: "n", mods: MOD.command },
  { id: "file.closeCard", key: "w", mods: MOD.command },
  { id: "file.closeAllCardTabs", key: "w", mods: MOD.command | MOD.option },
  // ⌘J, stamped by the sweep — the item is built with no key equivalent so
  // the chord stays rebindable.
  { id: "file.newJot", key: "j", mods: MOD.command },
  { id: "file.exportTranscript", key: "" },
  // Edit
  { id: "edit.undo", key: "z", mods: MOD.command },
  { id: "edit.redo", key: "z", mods: MOD.command | MOD.shift },
  { id: "edit.cut" },
  { id: "edit.copy" },
  { id: "edit.paste" },
  { id: "edit.delete" },
  { id: "edit.selectAll" },
  { id: "edit.copyLastResponse", key: "" },
  { id: "edit.find", key: "f", mods: MOD.command },
  { id: "edit.findNext", key: "g", mods: MOD.command },
  { id: "edit.findPrevious", key: "g", mods: MOD.command | MOD.shift },
  { id: "edit.useSelectionForFind", key: "e", mods: MOD.command },
  // Session
  { id: "session.focusPrompt", key: "k", mods: MOD.command },
  { id: "session.stop", key: "" },
  // ⇧⌘I, not ⌃⌘I: the ⌃ seat on I went to AI Model below, and Insert File
  // kept the letter. Both are composer gestures; neither has a better initial.
  { id: "session.insertFile", key: "i", mods: MOD.command | MOD.shift },
  // Go in Transcript ▸ and Configure ▸ — submenu shells; the walk recurses, so
  // their children are found at depth 2.
  { id: "session.go" },
  { id: "session.previousTurn", key: "" },
  { id: "session.configure" },
  // Commit Changes is the LAND verb and carries no chord: in the only state
  // where it is enabled, the composer's own submit key already lands it.
  { id: "session.commit", key: "" },
  { id: "session.new" },
  { id: "session.resume" },
  { id: "session.rename" },
  // The slash bridges that carry a chord are menu-eligible, so the key
  // equivalent has to be ON the item — the sweep writing it here is the whole
  // mechanism, and an empty string would mean the chord reaches nothing.
  //
  // `session.ai` is one door for model, reasoning effort, AND permission mode.
  // The per-mode submenu (`session.permissionMode` + its four modes) is
  // RETIRED — the mixer sets the mode now. Cycle keeps its own row precisely
  // because it kept its chord, and a chord with no menu item is not
  // discoverable.
  { id: "session.ai", key: "i", mods: MOD.command | MOD.control },
  { id: "session.permissionMode.cycle", key: "p", mods: MOD.command | MOD.control | MOD.option },
  { id: "session.permissionRules" },
  { id: "session.rewind" },
  { id: "session.compact" },
  { id: "session.addDir" },
  { id: "session.diff" },
  { id: "session.context" },
  { id: "session.skills" },
  { id: "session.agents" },
  { id: "session.hooks" },
  { id: "session.memory" },
  // Window (static slice; window.pane.* is dynamic)
  { id: "window.minimize", key: "m", mods: MOD.command },
  { id: "window.zoom" },
  { id: "window.previousCard", key: "[", mods: MOD.command | MOD.shift },
  { id: "window.nextCard", key: "]", mods: MOD.command | MOD.shift },
  { id: "window.previousCardInStack", key: "[", mods: MOD.command | MOD.option },
  { id: "window.nextCardInStack", key: "]", mods: MOD.command | MOD.option },
  // Reveal Stack's ⌘R is deck state: attached only while the focused pane's
  // slot stack has somewhere to go, because a chord on a disabled item beeps
  // instead of falling through. This deck is a single pane, so it is bare
  // here — the depth ≤ 1 and depth > 1 halves both live in at0169. `key: ""`
  // says unattached, not "no opinion".
  { id: "window.revealStack", key: "" },
  // The column family, all five swept from the registry: ⌃⌘S and the ⌃⌘
  // arrows, with ⌃⇧⌘ for the two extremes. They are built with EMPTY key
  // equivalents, so a chord asserted here is one `applyCommandChords` wrote —
  // and it is written even on this single-pane deck, where every one of them
  // validates disabled, because the family holds its chords while dark
  // (`disabledChord: "keep"`). A `key: ""` here would mean the sweep never
  // reached them.
  { id: "window.columnSplit", key: "s", mods: MOD.command | MOD.control },
  { id: "window.columnMoveUp", key: ARROW_UP, mods: MOD.command | MOD.control },
  { id: "window.columnMoveDown", key: ARROW_DOWN, mods: MOD.command | MOD.control },
  { id: "window.columnMoveTop", key: ARROW_UP, mods: MOD.command | MOD.control | MOD.shift },
  { id: "window.columnMoveBottom", key: ARROW_DOWN, mods: MOD.command | MOD.control | MOD.shift },
  // One parent row per sidebar card, each holding a toggle and a Left /
  // Right pair — the depths are what makes them a submenu rather than six
  // flat groups, and the walk below flattens the tree so all three read here.
  // The toggles stay chord-less: an empty key is the assertion, since a sweep
  // that wrote one would mean the table still ships a default chord for them.
  ...SIDEBAR_CARD_IDS.flatMap((card) => [
    { id: `window.sidebar.${card}` },
    { id: `window.sidebar.${card}.show`, key: "" },
    { id: `window.sidebar.${card}.left`, key: "" },
    { id: `window.sidebar.${card}.right`, key: "" },
  ]),
  { id: "window.enterFullScreen", key: "f", mods: MOD.command | MOD.control },
  { id: "window.bringAllToFront" },
  // Maker (items exist in the hidden menu). The gallery / hello-world
  // / active-pane creators are gated on BuildInfo.profile == "debug";
  // the app-test bundle's profile is "apptest", so they are absent here
  // and not asserted.
  { id: "maker.reload", key: "r", mods: MOD.command | MOD.shift },
  // The rail pair, both swept: ⌃⌘← and ⌃⌘→. The six per-card toggles that
  // used to stand beside them are Window ▸ ⟨Card⟩ now, asserted above.
  { id: "maker.leftRail", key: ARROW_LEFT, mods: MOD.command | MOD.control },
  { id: "maker.rightRail", key: ARROW_RIGHT, mods: MOD.command | MOD.control },
  { id: "maker.sourceTree" },
  // Help
  { id: "help.shortcuts", key: "" },
  { id: "help.projectHome" },
  { id: "help.github" },
];

interface FlatItem {
  identifier?: string;
  action?: string;
  keyEquivalent: string;
  modifierMask: number;
  hidden: boolean;
  depth: number;
}

describe.skipIf(!SHOULD_RUN)("AT0168: menu structure contract", () => {
  test(
    "menuSnapshot matches the structure contract",
    async () => {
      const app = await launchTugApp({ testName: "at0168-structure" });
      try {
        const tree = await app.menuSnapshot();

        const flat: FlatItem[] = [];
        const walk = (items: typeof tree, depth: number) => {
          for (const it of items) {
            flat.push({ ...it, depth });
            if (it.submenu) walk(it.submenu, depth + 1);
          }
        };
        walk(tree, 0);
        const byId = new Map(
          flat.filter((i) => i.identifier !== undefined).map((i) => [i.identifier!, i]),
        );

        // Every contract item present, with its chord where promoted.
        for (const want of STATIC_ITEMS) {
          const got = byId.get(want.id);
          expect(got, `${want.id} present in snapshot`).toBeDefined();
          if (want.key !== undefined) {
            expect(got!.keyEquivalent, `${want.id} key equivalent`).toBe(want.key);
          }
          if (want.mods !== undefined) {
            expect(got!.modifierMask, `${want.id} modifier mask`).toBe(want.mods);
          }
        }

        // The dead NSTextView find-panel items are gone.
        const findPanel = flat.filter(
          (i) => i.action === "performFindPanelAction:",
        );
        expect(findPanel.length, "no NSTextView find-panel items remain").toBe(0);

        // AppKit's automatic window-tabbing items (Show Previous/Next Tab,
        // Move Tab to New Window, Merge All Windows) are suppressed via
        // NSWindow.allowsAutomaticWindowTabbing = false — Tug has no native
        // window tabbing.
        const TABBING_ACTIONS = new Set([
          "selectPreviousTab:",
          "selectNextTab:",
          "moveTabToNewWindow:",
          "mergeAllWindows:",
          "toggleTabBar:",
          "toggleTabOverview:",
        ]);
        const tabbing = flat.filter((i) => i.action !== undefined && TABBING_ACTIONS.has(i.action));
        expect(tabbing.length, "no automatic window-tabbing items remain").toBe(0);

        // File is flat: New Session Card sits directly inside a top-level
        // menu (bar item depth 0 → menu item depth 1), not behind a
        // New submenu shell.
        expect(byId.get("file.newSessionCard")!.depth, "File menu is flattened").toBe(1);

        // The sidebar rows are a submenu per card and not six flat groups,
        // which is the whole reason the toggle is not the parent's own click
        // — AppKit opens a submenu instead of firing its parent's action.
        // Depth is what says so: the parent sits in the Window menu, its
        // three rows one level further in.
        for (const card of SIDEBAR_CARD_IDS) {
          expect(
            byId.get(`window.sidebar.${card}`)!.depth,
            `window.sidebar.${card} sits in the Window menu`,
          ).toBe(1);
          for (const row of ["show", "left", "right"]) {
            expect(
              byId.get(`window.sidebar.${card}.${row}`)!.depth,
              `window.sidebar.${card}.${row} sits in its card's submenu`,
            ).toBe(2);
          }
        }

        // Maker is hidden under the app-test harness, which pins maker
        // mode off regardless of build profile. The gate lives on the
        // top-level bar item, located by its submenu's content.
        const makerBarItem = tree.find((it) =>
          it.submenu?.some((sub) => sub.identifier === "maker.reload"),
        );
        expect(makerBarItem, "Maker bar item exists").toBeDefined();
        expect(makerBarItem!.hidden, "Maker menu hidden by default").toBe(true);

        // Identifier uniqueness within our namespaces —
        // findByIdentifier addressing relies on it. AppKit injects its
        // own identified items (Start Dictation, Emoji & Symbols) and,
        // on modern macOS, clones the fullscreen item into its managed
        // window-tiling section — both outside our control, so the
        // check scopes to our `<menu>.` namespaces and tolerates
        // exactly the fullscreen clone.
        const OUR_ID = /^(app|file|edit|session|view|window|maker|help)\./;
        const ids = flat
          .filter((i) => i.identifier !== undefined)
          .map((i) => i.identifier!)
          .filter((id) => OUR_ID.test(id));
        const seen = new Set<string>();
        const dupes = ids
          .filter((id) => (seen.has(id) ? true : (seen.add(id), false)))
          .filter((id) => id !== "window.enterFullScreen");
        expect(dupes, "our identifiers are unique").toEqual([]);

        // Enablement that used to be written imperatively at build time and
        // silently overridden by the validator's permissive default. All of
        // it is validator-answered now, except Open Recent — that item has a
        // submenu and no action, so AppKit resolves no validation target and
        // its stored `isEnabled` is the answer.
        //
        // At the default page zoom: Actual Size has nowhere to go, Zoom In
        // and Zoom Out do. (No document surface is frontmost on a fresh
        // deck, so the page-zoom bounds are the live gate.)
        expect(await itemEnabled(app, "view.actualSize"), "Actual Size dark at 100%").toBe(false);
        expect(await itemEnabled(app, "view.zoomIn"), "Zoom In live at 100%").toBe(true);
        expect(await itemEnabled(app, "view.zoomOut"), "Zoom Out live at 100%").toBe(true);

        // The hidden ⌘= alias tracks its visible sibling.
        expect(
          await itemEnabled(app, "view.zoomInAlias"),
          "the ⌘= alias tracks Zoom In",
        ).toBe(true);

        // About, Settings, and Keyboard Shortcuts each open a card; the
        // harness only reaches this point on a live frontend, so all three
        // validate enabled here. Their build-time `isEnabled = false` never
        // gated anything.
        expect(await itemEnabled(app, "app.about"), "About live once ready").toBe(true);
        expect(await itemEnabled(app, "app.settings"), "Settings live once ready").toBe(true);
        expect(
          await itemEnabled(app, "app.keyboardShortcuts"),
          "Keyboard Shortcuts live once ready",
        ).toBe(true);

        // Open Recent is dark on a deck that has opened no files. The parent
        // carries AppKit's `submenuAction:`, so no validator answers for it —
        // its enablement is the submenu's contents, and an empty MRU builds
        // nothing but a disabled placeholder.
        expect(
          await itemEnabled(app, "file.openRecent"),
          "Open Recent dark with an empty MRU",
        ).toBe(false);
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0168-structure] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  /**
   * The close gate on promoting the column family (Spec S02).
   *
   * A promotion is not free: AppKit resolves a menu item's key equivalent
   * before the web view sees the keydown, so ⌃⌘↓ now leaves the JS funnel and
   * is claimed globally — above every surface, a text editor's caret included.
   * That is the whole reason to test it from inside an editor rather than from
   * an empty deck: the column has to act AND the caret has to hold, and only
   * one of those two is what the promotion put at risk.
   *
   * `foreground: true` because a menu chord dies silently in a background
   * app-test — AppKit's key-equivalent scan needs the app to be active.
   */
  test(
    "the promoted column chord acts on the deck without moving a caret",
    async () => {
      const app = await launchTugApp({
        testName: "at0168-column-editor-gate",
        foreground: true,
      });
      try {
        const pane = (id: string, cardId: string) => ({
          id,
          position: { x: 40, y: 40 },
          size: { width: 420, height: 400 },
          cardIds: [cardId],
          activeCardId: cardId,
          title: "",
          acceptsFamilies: ["maker"],
          slot: 0,
        });
        await app.seedDeckState({
          state: {
            cards: [
              { id: "A", componentId: "gallery-textarea", title: "A", closable: true },
              { id: "B", componentId: "gallery-textarea", title: "B", closable: true },
            ],
            panes: [pane("p1", "A"), pane("p2", "B")],
            activePaneId: "p1",
            imposition: { kind: "three-up", sidebars: {} },
            hasFocus: true,
          },
          focusCardId: "A",
        });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );

        const sel = `[data-card-id="A"] [data-tug-state-key="gallery-textarea/size/md"]`;
        await app.waitForCondition<boolean>(`!!document.querySelector(${JSON.stringify(sel)})`);

        // Trusted focus and trusted typing: the caret has to be real, or the
        // thing this test protects is not the thing under the user's hands.
        // The click also raises p1 to the front of the column, which is what
        // leaves ⌃⌘↓ (move away from the front) the enabled direction.
        await app.nativeClickAtElement(sel);
        await app.waitForCondition<boolean>(
          `document.activeElement && document.activeElement.matches(${JSON.stringify(sel)})`,
          { timeoutMs: 3000 },
        );
        await app.nativeType("hello");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(sel)}).value === "hello"`,
          { timeoutMs: 3000 },
        );

        const caret = (): Promise<{ start: number; end: number; value: string }> =>
          app.evalJS(
            `(function () { var el = document.querySelector(${JSON.stringify(sel)});
              return { start: el.selectionStart, end: el.selectionEnd, value: el.value }; })()`,
          );
        const zOrder = (): Promise<string[]> =>
          app.evalJS<string[]>(
            `window.tugdeck.diag.getDeckState().panes.map(function (p) { return p.id; })`,
          );

        const before = await caret();
        expect(before, "the caret is where the typing left it").toEqual({
          start: 5,
          end: 5,
          value: "hello",
        });
        expect(await zOrder(), "the clicked pane is frontmost").toEqual(["p2", "p1"]);

        expect(
          await itemEnabled(app, "window.columnMoveDown"),
          "Move Card Down in Column is live for the frontmost member",
        ).toBe(true);

        await app.nativeKey("ArrowDown", ["cmd", "ctrl"]);
        await app.waitForCondition<boolean>(
          `window.tugdeck.diag.getDeckState().panes[0].id === "p1"`,
          { timeoutMs: 3000 },
        );

        // The column moved; the caret did not. A chord AppKit claimed above
        // the web view must not reach the editor as an editing gesture, and a
        // chord that took focus with it would show up here as a lost caret.
        expect(await caret(), "the caret held through the column move").toEqual(before);
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "")
          process.stderr.write(`\n[at0168-column-editor-gate] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
