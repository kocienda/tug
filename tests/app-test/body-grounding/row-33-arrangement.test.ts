/**
 * row-33-arrangement.test.ts — the Cards and Layout cards are bodies that read
 * the shell's arrangement and act on it through the shell.
 *
 * Each card reads the deck — every workspace, every card, their bindings and
 * titles — off the arrangement its card context carries, and what it does to
 * the deck goes back as a command the shell answers or a deck call the shell
 * runs. One leg per card, each also its kind check: it mounts as a body, shows
 * the shell's arrangement, its gestures reach the shell's deck and come back,
 * and it paints the rail's surface.
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
 * @covers tugdeck/src/components/cards/cards-card-registration.tsx
 * @covers tugdeck/src/components/layout/layout-card-registration.tsx
 * @covers tugdeck/src/lib/card-close-commands.ts
 * @covers tugdeck/src/lib/body-arrangement.ts
 * @covers tugdeck/src/components/tugways/tug-popover.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App, type BodyApp } from "../_harness";
import { STUB_TRANSCRIPT_DIR_ENV, stubDirectory } from "../streaming-stub-fixture";
import { pollFor, settleFor, sessionPane, spawnStub, waitForBody } from "./_bodies";
import { expectRailSurface, standUpKind } from "./_kind-bodies";
import { cardKind } from "./_kinds";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;
const READ_MS = 8_000;

const present = (selector: string): string => `document.querySelector(${JSON.stringify(selector)}) !== null`;

/**
 * In the body: `selector`'s centre, whether the element hit there is it or
 * inside it, what was hit, and the target's visibility — a popover the page
 * hid stands where it was and hits as its wrapper.
 */
const hitAtCentreOf = (selector: string): string => `(function () {
  var el = document.querySelector(${JSON.stringify(selector)});
  if (el === null) return null;
  var r = el.getBoundingClientRect();
  var x = r.left + r.width / 2, y = r.top + r.height / 2;
  var hit = document.elementFromPoint(x, y);
  var who = hit === null ? "nothing" : hit.tagName.toLowerCase() + Array.from(hit.attributes).filter(function (a) { return a.name.indexOf("data-") === 0; }).map(function (a) { return "[" + a.name + "]"; }).join("");
  return { x: x, y: y, hit: hit !== null && el.contains(hit), who: who, visibility: getComputedStyle(el).visibility };
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
  // The shown workspace's own Cards card: just after a switch the departing
  // workspace's Cards body can still read visible, and is not the one shown.
  const pick = async (): Promise<string | undefined> => {
    const own = new Set((await deckState(app)).cards.map((c) => c.id));
    return (await app.bodies()).find((b) => b.componentId === "cards" && b.cardId !== null && own.has(b.cardId) && b.state === "ready" && b.visible)?.cardId ?? undefined;
  };
  const id = await settleFor(pick, (v) => v !== undefined, READ_MS);
  expect(id, "the workspace on screen shows a Cards body").toBeDefined();
  // A popover raised in the page closes when the page's layout moves under
  // it, so the page is read once it stands: its frame and its view's size
  // the same across reads 100 ms apart. Compared as numbers in a fixed order:
  // the host serializes a frame from a dictionary whose key order is not
  // stable, so two reads of one frame stringify differently about half the
  // time, and a stringified compare never saw the body stand.
  let before = "";
  const rest = await settleFor(
    async () => {
      await Bun.sleep(100);
      const b = (await app.bodies()).find((x) => x.cardId === id);
      const now =
        b === undefined
          ? ""
          : [b.frame.x, b.frame.y, b.frame.width, b.frame.height, b.pageSize.width, b.pageSize.height].join(",");
      const still = now !== "" && now === before;
      before = now;
      return still;
    },
    (v) => v,
    READ_MS,
  );
  expect(rest, "the shown Cards body stands at its size").toBe(true);
  return app.body(id!);
}

async function clickIn(body: BodyApp, selector: string): Promise<void> {
  // A surface that has just mounted may not stand where it will: a popover
  // is placed after its first measure, and enters on a transform. Click its
  // centre once two reads 100 ms apart agree and the element there is it.
  let last: { x: number; y: number } | null = null;
  const at = await settleFor(
    async () => {
      await Bun.sleep(100);
      const now = await body.evalJS<{ x: number; y: number; hit: boolean; who: string; visibility: string } | null>(hitAtCentreOf(selector));
      const still = now !== null && last !== null && Math.abs(now.x - last.x) < 0.5 && Math.abs(now.y - last.y) < 0.5;
      last = now;
      return now === null ? null : { ...now, still };
    },
    (r) => r !== null && r.hit && r.still,
    READ_MS,
  );
  expect(at, `${selector} stands in the body`).not.toBeNull();
  expect(at!.hit && at!.still, `${selector} stands still and is what its centre hits (last: ${JSON.stringify(at)})`).toBe(true);
  await body.nativeClick({ x: at!.x, y: at!.y });
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

/**
 * In the shell: whether the Layout rail has landed — no settle on the canvas,
 * and its pane drawn at the width its deck state holds. A layout commit
 * retunes the rails, so the rail's pane, and the body's view with it, moves
 * on after the miniature has already read the commit back.
 */
const RAIL_LANDED = `(function () {
  if (document.querySelector("[data-deck-canvas-background]")?.hasAttribute("data-imposer-settling")) return false;
  var pane = window.tugdeck.diag.getDeckState().panes.find(function (p) { return p.id === ${JSON.stringify(`${LAYOUT}-pane`)}; });
  var el = document.querySelector('.tug-pane[data-pane-id=' + JSON.stringify(${JSON.stringify(`${LAYOUT}-pane`)}) + ']');
  if (pane === undefined || el === null) return false;
  return Math.abs(el.getBoundingClientRect().width - pane.size.width) < 1;
})()`;

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
      const app = await launchTugApp({ testName: "body-grounding-row-33-layout" });
      try {
        await app.seedDeckState({ state: layoutDeck("flow"), focusCardId: "A" });
        const body = await standUpKind(app, cardKind("layout"), LAYOUT);
        // card-dom: shell
        expect(await app.evalJS<boolean>(present('[data-testid="layout-card-section"]')), "the shell's document holds no Layout card").toBe(false);

        // ── Its data: the shell's six slots, drawn in the body ──────────
        const blocks = await settleFor(() => body.evalJS<number>(`document.querySelectorAll(${JSON.stringify(BLOCKS)}).length`), (n) => n > 0, READ_MS);
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
        const imposed = await settleFor(() => deckState(app), (d) => d.imposition?.layout === "fit", READ_MS);
        expect(imposed.imposition?.layout, "the press set the shell's imposition").toBe("fit");
        const back = await settleFor(() => body.evalJS<boolean>(present(`${MINI}[data-layout="fit"]`)), (v) => v, READ_MS);
        expect(back, "the miniature in the body shows the shell's new layout").toBe(true);
        const rt = await body.evalJS<{ press: number | null; arrived: number | null }>("window.__r33");
        const shellAt = (await app.evalJS<{ committed: number | null }>("window.__r33Shell")).committed;
        note(
          `layout: row press to the arrangement's return in the body ${rt.press !== null && rt.arrived !== null ? `${rt.arrived - rt.press} ms` : JSON.stringify(rt)}` +
            (rt.press !== null && rt.arrived !== null && shellAt !== null ? ` (press → shell deck ${shellAt - rt.press} ms, shell deck → body ${rt.arrived - shellAt} ms)` : ""),
        );

        // ── The window grip: a drag moves the shell's flow offset ───────
        // The press is made where the hand would make it, on a rail that
        // has stopped moving: a press while the body's view is still being
        // carried to its new frame takes its down and its up at two points of
        // the page, and lands on neither.
        // card-dom: shell — the rail's landing is its stand-in's width against the model, both the shell's.
        const settled = await settleFor(() => app.evalJS<boolean>(RAIL_LANDED), (v) => v, READ_MS);
        expect(settled, "the rail lands after the Fit commit").toBe(true);
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
        const grip = await settleFor(() => body.evalJS<{ x: number; y: number } | null>(gripEdge), (g) => g !== null, READ_MS);
        expect(grip, "flow draws the window's grip in the body").not.toBeNull();
        const before = (await deckState(app)).flowOffset ?? 0;
        await body.nativeDrag(grip!, { x: grip!.x + 60, y: grip!.y }, { mouseDownDelayMs: 120, mouseUpDelayMs: 200, interpolationSteps: 16, interpolationDelayMs: 20 });
        const after = await settleFor(() => deckState(app), (d) => (d.flowOffset ?? 0) !== before, READ_MS);
        note(`layout: flow offset ${before} → ${after.flowOffset ?? 0}`);
        expect(after.flowOffset ?? 0, "the drag moved the shell's flow offset").not.toBe(before);

        await expectRailSurface(app, LAYOUT);
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
      const app = await launchTugApp({ testName: "body-grounding-row-33-cards", env: { [STUB_TRANSCRIPT_DIR_ENV]: stubDir } });
      try {
        await app.seedDeckState({ state: cardsDeck(), focusCardId: A });
        await spawnStub(app, A, stubDir, 2, 1);
        await waitForBody(app, A);
        const body = await standUpKind(app, cardKind("cards"), CARDS);
        // card-dom: shell
        expect(await app.evalJS<boolean>(present(".cards-card")), "the shell's document holds no Cards card").toBe(false);

        // ── Its data: the Session card's row names its session ──────────
        const session = await settleFor(
          () => body.evalJS<string | null>(`(function () { var r = document.querySelector(".cards-row[data-session-id]"); return r === null ? null : r.getAttribute("data-session-id"); })()`),
          (s) => s !== null && s !== "",
          READ_MS,
        );
        note(`cards: session row ${JSON.stringify(session)}`);
        expect(session, "the bound Session card's row carries its session, mirrored from the shell").not.toBeNull();
        expect(await body.evalJS<boolean>(present('[data-testid="cards-unconnected-session-row"]')), "no row reads as unconnected").toBe(false);

        // ── A card's row ×: the shell closes it ─────────────────────────
        const box = await settleFor(() => body.evalJS<{ x: number; y: number } | null>(closeBoxOf(H_TITLE)), (b) => b !== null, READ_MS);
        expect(box, "the Hello card's row has its close box in the body").not.toBeNull();
        await body.nativeClick(box!);
        const closed = await settleFor(() => deckState(app), (d) => !d.cards.some((c) => c.id === H), READ_MS);
        expect(closed.cards.some((c) => c.id === H), "the row × closed the card in the shell's deck").toBe(false);

        // ── A new workspace, named in the body ──────────────────────────
        const home = (await spaces(app)).activeSpaceId;
        await clickIn(body, NEW_SPACE);
        const created = await settleFor(() => spaces(app), (s) => s.activeSpaceId !== home, READ_MS);
        expect(created.activeSpaceId, "the body's New Workspace made a workspace in the shell and went there").not.toBe(home);
        const fresh: BodyApp = await shownCards(app);
        const field = await settleFor(() => fresh.evalJS<boolean>(present(RENAME)), (v) => v, READ_MS);
        expect(field, "the new workspace's Cards body opened its name field").toBe(true);
        await app.nativeType(NEW_NAME);
        await app.nativeKey("Return");
        const named = await settleFor(() => spaces(app), (s) => s.spaces.some((x) => x.name === NEW_NAME), READ_MS);
        const createdId = named.spaces.find((x) => x.name === NEW_NAME)?.id ?? "";
        expect(createdId, "the shell holds the workspace named in the body").toBe(created.activeSpaceId);

        // ── Go there: the home workspace's header ───────────────────────
        const homeName = named.spaces.find((x) => x.id === home)?.name ?? "";
        const header = await settleFor(() => fresh.evalJS<{ x: number; y: number } | null>(headerOf(homeName)), (h) => h !== null, READ_MS);
        expect(header, `the ${homeName} header stands in the body`).not.toBeNull();
        await fresh.nativeClick(header!);
        const back = await settleFor(() => spaces(app), (s) => s.activeSpaceId === home, READ_MS);
        expect(back.activeSpaceId, "a click on the other workspace's header went there").toBe(home);

        // ── Delete Workspace: the confirm in the body, the delete in the shell ──
        const cardsBody: BodyApp = await shownCards(app);
        await app.dispatchControlAction("delete-space", { spaceId: createdId });
        const asked = await settleFor(() => cardsBody.evalJS<boolean>(present(CONFIRM_OK)), (v) => v, READ_MS);
        expect(asked, "the menu's delete raised its confirm in the Cards body").toBe(true);
        await clickIn(cardsBody, CONFIRM_OK);
        const gone = await settleFor(() => spaces(app), (s) => !s.spaces.some((x) => x.id === createdId), READ_MS);
        expect(gone.spaces.some((x) => x.id === createdId), "the confirmed delete removed the workspace in the shell").toBe(false);

        await expectRailSurface(app, CARDS);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
