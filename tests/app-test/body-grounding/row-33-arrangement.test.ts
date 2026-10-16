/**
 * row-33-arrangement.test.ts — the Cards and Layout cards are bodies that read
 * the shell's arrangement and act on it through the shell.
 *
 * Each card reads the deck — every workspace, every card, their bindings and
 * titles — off the arrangement its card context carries, and what it does to
 * the deck goes back as a command the shell answers or a deck call the shell
 * runs. One leg per card, each also its kind check: it mounts as a body, shows
 * the shell's arrangement, its gestures reach the shell's deck and come back,
 * it paints the rail's surface, and its deck bridge was asked nothing only the
 * shell answers.
 *
 * - **Layout.** A press on the Layout row's Fit lands in the shell's
 *   imposition and comes back to the body's miniature; the time from the
 *   press to the miniature's change is noted. A drag of the miniature's window
 *   grip moves the shell's flow offset.
 * - **Cards.** A bound Session card's row names its session (the binding the
 *   shell mirrors); a card's row × closes it in the shell; the new-workspace
 *   button makes a workspace whose name is typed in the body; a click on the
 *   other workspace's header goes there; and the menu's Delete Workspace
 *   raises its confirm in the body, whose answer deletes the workspace in the
 *   shell.
 *
 * @foreground
 * @covers tugdeck/src/components/cards/cards-card-registration.tsx
 * @covers tugdeck/src/components/layout/layout-card-registration.tsx
 * @covers tugdeck/src/lib/card-close-commands.ts
 * @covers tugdeck/src/lib/body-arrangement.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App, type BodyApp } from "../_harness";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "../streaming-stub-fixture";
import { pollFor, sessionPane, spawnStub, waitForBody } from "./_bodies";
import { expectNoShellReads, expectRailSurface, standUpKind } from "./_kind-bodies";
import { cardKind } from "./_kinds";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;
const READ_MS = 8_000;

const present = (selector: string): string => `document.querySelector(${JSON.stringify(selector)}) !== null`;
const centreOf = (selector: string): string => `(function () {
  var el = document.querySelector(${JSON.stringify(selector)});
  if (el === null) return null;
  var r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`;

interface DeckRead {
  cards: { id: string }[];
  flowOffset?: number;
  imposition?: { layout?: string };
}
interface SpacesRead {
  activeSpaceId: string;
  spaces: { id: string; name: string }[];
}
const deckState = (app: App): Promise<DeckRead> => app.evalJS<DeckRead>("window.tugdeck.diag.getDeckState()");
const spaces = (app: App): Promise<SpacesRead> => app.evalJS<SpacesRead>("window.tugdeck.diag.getSpaces()");

/**
 * The body of the Cards card the workspace on screen shows. Each workspace
 * stands its own rails, so a workspace switch puts a different Cards card in
 * front.
 */
async function shownCards(app: App): Promise<BodyApp> {
  const shown = await pollFor(
    () => app.bodies(),
    (bodies) => bodies.some((b) => b.componentId === "cards" && b.state === "ready" && b.visible),
    READ_MS,
  );
  const id = shown.find((b) => b.componentId === "cards" && b.state === "ready" && b.visible)?.cardId;
  expect(id, "the workspace on screen shows a Cards body").toBeDefined();
  return app.body(id!);
}

async function clickIn(body: BodyApp, selector: string): Promise<void> {
  const at = await body.evalJS<{ x: number; y: number } | null>(centreOf(selector));
  expect(at, `${selector} stands in the body`).not.toBeNull();
  await body.nativeClick(at!);
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const LAYOUT = "r33-layout";
const MINI = '.layouts-plan-layer[data-plan-layer="committed"] .layout-mini';
const BLOCKS = '[data-plan-layer="committed"] .layout-mini-block';
const FIT = '[data-testid="layout-card-layout"] [data-choice-value="fit"]';
const FLOW = '[data-testid="layout-card-layout"] [data-choice-value="flow"]';
const GRIP = '[data-testid="layout-card-window-grip"]';

/** Six Hello cards in a six-up flow strip longer than its band, so the miniature draws a window. */
function layoutDeck(layout: "flow" | "fit"): Record<string, unknown> {
  const ids = ["A", "B", "C", "D", "E", "F"];
  return {
    cards: [
      ...ids.map((id) => ({ id, componentId: "hello", title: `Card ${id}`, closable: true })),
      { id: LAYOUT, componentId: "layout", title: "Layout", closable: true },
    ],
    panes: [
      ...ids.map((id, index) => ({
        id: `p${index + 1}`,
        position: { x: 40, y: 40 },
        size: { width: 675, height: 400 },
        cardIds: [id],
        activeCardId: id,
        title: "",
        acceptsFamilies: ["maker"],
        slot: index,
      })),
      { id: `${LAYOUT}-pane`, position: { x: 0, y: 0 }, size: { width: 420, height: 900 }, cardIds: [LAYOUT], activeCardId: LAYOUT, title: "", acceptsFamilies: [] },
    ],
    activePaneId: "p1",
    imposition: { kind: "six-up", sidebars: { layout: { side: "right" } }, layout },
    hasFocus: true,
  };
}

/** In the body: stamp the wall time of the next click (the press a row answers), and of the miniature's first `data-layout="fit"`. */
const ARM_ROUND_TRIP = `(function () {
  var rec = (window.__r33 = { press: null, arrived: null });
  window.addEventListener("click", function () { if (rec.press === null) rec.press = Date.now(); }, { capture: true, once: true });
  var seen = function () { return document.querySelector(${JSON.stringify(`${MINI}[data-layout="fit"]`)}) !== null; };
  var mo = new MutationObserver(function () { if (rec.arrived === null && seen()) { rec.arrived = Date.now(); mo.disconnect(); } });
  mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-layout"] });
  return true;
})()`;

// ---------------------------------------------------------------------------
// Cards
// ---------------------------------------------------------------------------

const CARDS = "r33-cards";
const A = "r33-a";
const H = "r33-h";
const H_TITLE = "r33 hello";
// A body holds one Cards card, so its selectors need no workspace layer to
// pick the shown one by: the shell's `[data-space-shown]` layers are not in it.
const NEW_SPACE = '[data-testid="cards-new-space"]';
const RENAME = '[data-testid="cards-space-rename"]';
const CONFIRM = '[data-slot="tug-confirm-popover"]';
const CONFIRM_OK = `${CONFIRM} [data-slot="tug-confirm-confirm"]`;
const NEW_NAME = "r33 elsewhere";

function cardsDeck(): Record<string, unknown> {
  return {
    cards: [
      { id: A, componentId: "session", title: "A", closable: true },
      { id: H, componentId: "hello", title: H_TITLE, closable: true },
      { id: CARDS, componentId: "cards", title: "Cards", closable: true },
    ],
    panes: [
      sessionPane(A, 0),
      { id: `${H}-pane`, position: { x: 40, y: 40 }, size: { width: 640, height: 480 }, cardIds: [H], activeCardId: H, title: "", acceptsFamilies: ["maker"], slot: 1 },
      { id: `${CARDS}-pane`, position: { x: 0, y: 0 }, size: { width: 420, height: 900 }, cardIds: [CARDS], activeCardId: CARDS, title: "", acceptsFamilies: [] },
    ],
    activePaneId: `${A}-pane`,
    imposition: { kind: "four-up", layout: "flow", sidebars: { cards: { side: "right" } } },
    hasFocus: true,
  };
}

/** In the body: the centre of the close box on the row whose title reads `title`. */
const closeBoxOf = (title: string): string => `(function () {
  var rows = Array.from(document.querySelectorAll(".cards-row"));
  var row = rows.find(function (r) { var t = r.querySelector(".tug-list-row-title"); return t !== null && (t.textContent || "").indexOf(${JSON.stringify(title)}) === 0; });
  var box = row === undefined ? null : row.querySelector(".cards-row-close");
  if (box === null) return null;
  var r = box.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`;

/** In the body: the centre of the workspace header whose name reads `name`. */
const headerOf = (name: string): string => `(function () {
  var names = Array.from(document.querySelectorAll('[data-testid="cards-space-name"]'));
  var el = names.find(function (n) { return (n.textContent || "") === ${JSON.stringify(name)}; });
  if (el === undefined) return null;
  var r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`;

describe.skipIf(!SHOULD_RUN)("body-grounding row 33: the arrangement cards", () => {
  test(
    "the Layout body reads the shell's arrangement, and its row press and window drag reach the shell's deck",
    async () => {
      const app = await launchTugApp({ testName: "body-grounding-row-33-layout", foreground: true, bodies: true });
      try {
        await app.seedDeckState({ state: layoutDeck("flow"), focusCardId: "A" });
        const body = await standUpKind(app, cardKind("layout"), LAYOUT);
        // card-dom: shell
        expect(await app.evalJS<boolean>(present('[data-testid="layout-card-section"]')), "the shell's document holds no Layout card").toBe(false);

        // ── Its data: the shell's six slots, drawn in the body ──────────
        const blocks = await pollFor(() => body.evalJS<number>(`document.querySelectorAll(${JSON.stringify(BLOCKS)}).length`), (n) => n > 0, READ_MS);
        expect(blocks, "the body's miniature draws the shell's arrangement").toBeGreaterThan(0);

        // ── A row press: Fit, to the shell and back ─────────────────────
        await body.evalJS<boolean>(ARM_ROUND_TRIP);
        // In the shell: the wall time its deck first reads `fit`, polled every
        // millisecond, to split the round trip at the shell.
        await app.evalJS<boolean>(`(function () {
          var rec = (window.__r33Shell = { committed: null });
          var id = setInterval(function () {
            var d = window.tugdeck.diag.getDeckState();
            if (d.imposition && d.imposition.layout === "fit") { rec.committed = Date.now(); clearInterval(id); }
          }, 1);
          return true;
        })()`);
        await clickIn(body, FIT);
        const imposed = await pollFor(() => deckState(app), (d) => d.imposition?.layout === "fit", READ_MS);
        expect(imposed.imposition?.layout, "the press set the shell's imposition").toBe("fit");
        const back = await pollFor(() => body.evalJS<boolean>(present(`${MINI}[data-layout="fit"]`)), (v) => v, READ_MS);
        expect(back, "the miniature in the body shows the shell's new layout").toBe(true);
        const rt = await body.evalJS<{ press: number | null; arrived: number | null }>("window.__r33");
        const shellAt = (await app.evalJS<{ committed: number | null }>("window.__r33Shell")).committed;
        note(
          `layout: row press to the arrangement's return in the body ${rt.press !== null && rt.arrived !== null ? `${rt.arrived - rt.press} ms` : JSON.stringify(rt)}` +
            (rt.press !== null && rt.arrived !== null && shellAt !== null ? ` (press → shell deck ${shellAt - rt.press} ms, shell deck → body ${rt.arrived - shellAt} ms)` : ""),
        );

        // ── The window grip: a drag moves the shell's flow offset ───────
        await clickIn(body, FLOW);
        await pollFor(() => deckState(app), (d) => d.imposition?.layout === "flow", READ_MS);
        // The miniature redraws the window when flow comes back; the grip is
        // read once it has landed, as `at0661` reads it.
        await Bun.sleep(900);
        // The grip is the window's frame: a drag starts on its edge, as the hand's would.
        const gripEdge = `(function () {
          var el = document.querySelector(${JSON.stringify(GRIP)});
          if (el === null) return null;
          var r = el.getBoundingClientRect();
          return { x: r.right - 1, y: r.top + r.height / 2 };
        })()`;
        const grip = await pollFor(() => body.evalJS<{ x: number; y: number } | null>(gripEdge), (g) => g !== null, READ_MS);
        expect(grip, "flow draws the window's grip in the body").not.toBeNull();
        const before = (await deckState(app)).flowOffset ?? 0;
        await body.nativeDrag(grip!, { x: grip!.x + 60, y: grip!.y }, { mouseDownDelayMs: 120, mouseUpDelayMs: 200, interpolationSteps: 16, interpolationDelayMs: 20 });
        const after = await pollFor(() => deckState(app), (d) => (d.flowOffset ?? 0) !== before, READ_MS);
        note(`layout: flow offset ${before} → ${after.flowOffset ?? 0}`);
        expect(after.flowOffset ?? 0, "the drag moved the shell's flow offset").not.toBe(before);

        await expectRailSurface(app, LAYOUT);
        await expectNoShellReads(app, LAYOUT);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the Cards body lists the shell's cards with their sessions, and its close, new workspace, go-there and delete reach the shell",
    async () => {
      const stubDir = stubDirectory();
      const app = await launchTugApp({ testName: "body-grounding-row-33-cards", foreground: true, bodies: true, env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir } });
      try {
        await app.seedDeckState({ state: cardsDeck(), focusCardId: A });
        await spawnStub(app, A, stubDir, 2, 1);
        await waitForBody(app, A);
        const body = await standUpKind(app, cardKind("cards"), CARDS);
        // card-dom: shell
        expect(await app.evalJS<boolean>(present(".cards-card")), "the shell's document holds no Cards card").toBe(false);

        // ── Its data: the Session card's row names its session ──────────
        const session = await pollFor(
          () => body.evalJS<string | null>(`(function () { var r = document.querySelector(".cards-row[data-session-id]"); return r === null ? null : r.getAttribute("data-session-id"); })()`),
          (s) => s !== null && s !== "",
          READ_MS,
        );
        note(`cards: session row ${JSON.stringify(session)}`);
        expect(session, "the bound Session card's row carries its session, mirrored from the shell").not.toBeNull();
        expect(await body.evalJS<boolean>(present('[data-testid="cards-unconnected-session-row"]')), "no row reads as unconnected").toBe(false);

        // ── A card's row ×: the shell closes it ─────────────────────────
        const box = await pollFor(() => body.evalJS<{ x: number; y: number } | null>(closeBoxOf(H_TITLE)), (b) => b !== null, READ_MS);
        expect(box, "the Hello card's row has its close box in the body").not.toBeNull();
        await body.nativeClick(box!);
        const closed = await pollFor(() => deckState(app), (d) => !d.cards.some((c) => c.id === H), READ_MS);
        expect(closed.cards.some((c) => c.id === H), "the row × closed the card in the shell's deck").toBe(false);

        // ── A new workspace, named in the body ──────────────────────────
        const home = (await spaces(app)).activeSpaceId;
        await clickIn(body, NEW_SPACE);
        const created = await pollFor(() => spaces(app), (s) => s.activeSpaceId !== home, READ_MS);
        expect(created.activeSpaceId, "the body's New Workspace made a workspace in the shell and went there").not.toBe(home);
        const fresh: BodyApp = await shownCards(app);
        const field = await pollFor(() => fresh.evalJS<boolean>(present(RENAME)), (v) => v, READ_MS);
        expect(field, "the new workspace's Cards body opened its name field").toBe(true);
        await app.nativeType(NEW_NAME);
        await app.nativeKey("Return");
        const named = await pollFor(() => spaces(app), (s) => s.spaces.some((x) => x.name === NEW_NAME), READ_MS);
        const createdId = named.spaces.find((x) => x.name === NEW_NAME)?.id ?? "";
        expect(createdId, "the shell holds the workspace named in the body").toBe(created.activeSpaceId);

        // ── Go there: the home workspace's header ───────────────────────
        const homeName = named.spaces.find((x) => x.id === home)?.name ?? "";
        const header = await pollFor(() => fresh.evalJS<{ x: number; y: number } | null>(headerOf(homeName)), (h) => h !== null, READ_MS);
        expect(header, `the ${homeName} header stands in the body`).not.toBeNull();
        await fresh.nativeClick(header!);
        const back = await pollFor(() => spaces(app), (s) => s.activeSpaceId === home, READ_MS);
        expect(back.activeSpaceId, "a click on the other workspace's header went there").toBe(home);

        // ── Delete Workspace: the confirm in the body, the delete in the shell ──
        const cardsBody: BodyApp = await shownCards(app);
        await app.dispatchControlAction("delete-space", { spaceId: createdId });
        const asked = await pollFor(() => cardsBody.evalJS<boolean>(present(CONFIRM_OK)), (v) => v, READ_MS);
        expect(asked, "the menu's delete raised its confirm in the Cards body").toBe(true);
        await clickIn(cardsBody, CONFIRM_OK);
        const gone = await pollFor(() => spaces(app), (s) => !s.spaces.some((x) => x.id === createdId), READ_MS);
        expect(gone.spaces.some((x) => x.id === createdId), "the confirmed delete removed the workspace in the shell").toBe(false);

        await expectRailSurface(app, CARDS);
        await expectNoShellReads(app, CARDS);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
