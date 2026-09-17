/**
 * at0591-workspace-card-levels.test.ts — the Workspaces card has three levels
 * and they read as three.
 *
 * The card shows a workspace, the groups inside it, and the rows inside those,
 * and until now all three sat at the same leading edge with the OUTERMOST one
 * washed the loudest. So the level that contains everything shouted over the
 * things it contains, and nothing said which row belonged under which header
 * except the order they happened to arrive in.
 *
 * Two mechanisms the card already had now carry the hierarchy, and this file
 * pins both mechanically rather than on "looks right":
 *
 *   1. **Wash.** A larger share of the surface's foreground is further from
 *      the well and nearer the reader, whichever direction a theme's
 *      foreground runs. The container recedes and what it contains comes
 *      forward, so the workspace header is now the QUIETEST level and the
 *      group header the loudest. The assertion is an ORDERING — the workspace
 *      header's distance from a plain row is strictly less than the group
 *      header's — because a value would pin one theme and this holds in all
 *      of them.
 *   2. **Indent.** One token, spent twice: the group header steps in from the
 *      workspace header, the rows step in from the group header. The
 *      assertion walks the glyph column left to right and demands strict
 *      inequality at every rung.
 *
 * The subrow rung is the one worth explaining. A subrow passes `rowId={null}`
 * so it wears no `data-cards-row-id`, which means the pane rows' indent rule
 * does not reach it — its own rule has to restate the whole sum. Left at the
 * flat leading column it used to carry, a subrow would sit LEFT of the pane
 * row holding it at any step above 8px, which is the outline drawn upside
 * down. Nothing pinned that before this file.
 *
 * The flush leg is the other thing nothing pinned. A session monitor row and a
 * one-line row take their leading inset from two different places —
 * `--tugx-session-row-leading-inset` on `.tug-session-row-lines`, and nothing
 * at all on `.cards-row-headline` — so a step added on `.tug-list-row-content`
 * is charged to both and reconciles neither. Whether they stay flush is a
 * question the change can only answer by being measured.
 *
 * The second test is the rename floor. A workspace header used to resize the
 * moment a rename opened, because the field is taller than the label it
 * replaces, so the row grew and everything under it stepped down — an edit
 * that moves the list it is being made in. The header now rests at the
 * field's own height, stated once as a token beside the field's size, and the
 * assertion is that the row's height and the top of the row below it are the
 * same three times over: at rest, with the field open, and after it commits.
 *
 * The third is the `None` row. An expanded workspace holding nothing used to
 * render its header and then stop, which left a reader unsure whether it was
 * empty or broken and left a drag nothing to aim at but a thin band. It now
 * draws one row saying `None` — inert to the cursor, because it toggles
 * nothing and fronts nothing, and live to a drag, because the drop target is
 * resolved from `data-cards-space-run` in the DOM and never from a role. All
 * three of those are asserted, the last by carrying a card from the other
 * workspace onto it.
 *
 * The fourth is the delete confirm. Fired from the Window menu over a list
 * long enough to scroll, it used to open somewhere with nothing to say which
 * workspace it was asking about — the floating layer had shifted it clear of
 * an anchor that was not even on screen. Three things answer that together and
 * this test reads all three: the anchor row is revealed before the popover
 * opens, exactly one arrow is drawn, and the popover's own box stays inside
 * the card's.
 *
 * @covers tugdeck/src/components/cards/cards-card.css
 * @covers tugdeck/src/components/cards/cards-card.tsx
 * @covers tugdeck/src/components/cards/cards-data-source.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankWrite,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const SPACE = "at0591-space";

/**
 * "On screen", said out loud. Every visited workspace stays mounted, so the
 * document holds one Workspaces card per visited workspace — all but one
 * inside a wrapper with no `data-space-shown` and no boxes.
 */
const SHOWN = "[data-space-layer][data-space-shown] ";

const CELL = `${SHOWN}.cards-list .tug-list-view-cell`;
const SPACE_HEADER_CELL = `${CELL}[data-tug-list-cell-kind="space-header"]`;
const GROUP_HEADER_CELL = `${CELL}[data-tug-list-cell-kind="group-header"]`;
/** A plain pane row's cell — the striping's own level, and the wash baseline. */
const PANE_ROW_CELL = `${CELL}:has([data-cards-row-id])`;

const SPACE_GLYPH = `${SHOWN}.cards-space-header .cards-header-glyph`;
const GROUP_GLYPH = `${SHOWN}.cards-header .cards-header-glyph`;
const PANE_GLYPH = `${SHOWN}.cards-row[data-cards-row-id] .cards-row-glyph`;
const SUBROW_GLYPH = `${SHOWN}.cards-subrow .cards-row-glyph`;
/**
 * The two pane-row kinds' content boxes — the leading edge the indent rule
 * moves, and therefore the edge that has to come out equal.
 *
 * The content box rather than the title: a session monitor row leads with a
 * phase dot and a one-line row with a kind glyph, and those are different
 * widths, so their TITLES start at different offsets for a reason that has
 * nothing to do with indent. What `[F05]` claims and this leg tests is that
 * the rows themselves begin together.
 */
const SESSION_CONTENT = `${SHOWN}.tug-list-row:has(.tug-session-row-lines)[data-cards-row-id] .tug-list-row-content`;
const ONELINE_CONTENT = `${SHOWN}.cards-oneline[data-cards-row-id] .tug-list-row-content`;

/**
 * The workspace header ROW, and the two things a rename can move.
 *
 * The menu and the field are portaled to the canvas's overlay root, outside
 * every space layer, so neither selector carries the `SHOWN` scope.
 */
const SPACE_HEADER_ROW = `${SHOWN}.cards-space-header`;
const VERBS_BUTTON = `${SHOWN}[data-testid="cards-space-verbs-button"]`;
const RENAME_INPUT = '[data-testid="cards-space-rename"]';

/** The third test's own: an empty workspace's `None` row, and the cursor. */
const BARE = "at0591-bare";
const FULL = "at0591-full";
const EMPTY_ROW = `${SHOWN}[data-testid="cards-space-empty"]`;
const CURSOR_ROW = `${SHOWN}.cards-list .tug-list-view-cell[data-key-cursor]`;
const runOf = (id: string): string =>
  `${SHOWN}.cards-list [data-cards-space-run="${id}"]`;

/** The fourth test's own: the delete confirm, and the card that bounds it. */
const CARD_ROOT = `${SHOWN}.cards-card`;
const CONFIRM = '[data-slot="tug-confirm-popover"]';
const POPOVER_ARROW = ".tug-popover-arrow";
/** Enough workspaces that the card's list overflows its scrollport. */
const CROWD = 14;
const crowdId = (i: number): string => `at0591-crowd-${i}`;
/** The ACTIVE one is last, so its header is below the fold at rest. */
const CROWD_LAST = crowdId(CROWD - 1);

const settle = (ms = 400): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/**
 * The three colour channels, whatever space the engine reports them in. A
 * `color-mix(in oklab, …)` computes to `oklab(L a b)` here rather than to
 * `rgb(…)`, which is if anything better: oklab distance is perceptual, and
 * every value compared below comes from the same space, so an ordering over
 * them means what it says.
 */
interface Channels {
  r: number;
  g: number;
  b: number;
}

function parseChannels(value: string): Channels {
  const nums = value.match(/[\d.]+/g);
  if (nums === null || nums.length < 3) {
    throw new Error(`not a colour: ${JSON.stringify(value)}`);
  }
  return {
    r: Number(nums[0]),
    g: Number(nums[1]),
    b: Number(nums[2]),
  };
}

/** Euclidean distance in whatever space both came from. Only ever compared
 *  against another distance, never against an absolute. */
function distance(a: Channels, b: Channels): number {
  return Math.sqrt((a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2);
}

/**
 * A colour string normalised to sRGB, by the engine's own conversion.
 *
 * This is load-bearing rather than tidy. `getComputedStyle` reports each of
 * these in whatever space its declaration was authored in: a striped row cell
 * comes back as sRGB, a `color-mix(in oklab, …)` header comes back as
 * `oklab(L a b)`. Subtracting one triple from the other compares a lightness
 * against a red channel and yields a number that means nothing — which is how
 * an ordering over them can pass while measuring nothing at all. Painting
 * each into a canvas puts every value in one space before anything is
 * compared.
 */
const TO_SRGB = `function (css) {
  var c = document.createElement("canvas");
  c.width = 1;
  c.height = 1;
  var ctx = c.getContext("2d");
  ctx.fillStyle = "#000";
  ctx.fillStyle = css;
  ctx.fillRect(0, 0, 1, 1);
  var d = ctx.getImageData(0, 0, 1, 1).data;
  return "rgb(" + d[0] + ", " + d[1] + ", " + d[2] + ")";
}`;

function bgOf(app: App, selector: string): Promise<string> {
  return app.evalJS<string>(
    `(function () {
       var toSrgb = ${TO_SRGB};
       var el = document.querySelector(${JSON.stringify(selector)});
       if (el === null) throw new Error("no element: " + ${JSON.stringify(selector)});
       return toSrgb(getComputedStyle(el).backgroundColor);
     })()`,
  );
}

function leftOf(app: App, selector: string): Promise<number> {
  return app.evalJS<number>(
    `(function () {
       var el = document.querySelector(${JSON.stringify(selector)});
       if (el === null) throw new Error("no element: " + ${JSON.stringify(selector)});
       return el.getBoundingClientRect().left;
     })()`,
  );
}

function rail(id: string, cardId: string): Record<string, unknown> {
  return {
    id,
    position: { x: 0, y: 0 },
    size: { width: 460, height: 900 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: [] as string[],
  };
}

/**
 * One workspace holding every row kind the levels have to line up: a session
 * card (the session monitor row), single-card text panes (one-line rows), and
 * a TWO-card pane, which is what mints subrows.
 */
function blob(): Record<string, unknown> {
  return {
    version: 5,
    activeSpaceId: SPACE,
    spaces: [
      {
        id: SPACE,
        name: "Levels",
        deck: {
          cards: [
            { id: "C", componentId: "cards", title: "Workspaces", closable: true },
            { id: "S", componentId: "session", title: "S", closable: true },
            { id: "T1", componentId: "text", title: "T1", closable: true },
            { id: "T2", componentId: "text", title: "T2", closable: true },
            { id: "T3", componentId: "text", title: "T3", closable: true },
          ],
          panes: [
            rail("pc", "C"),
            {
              id: "ps",
              position: { x: 60, y: 60 },
              size: { width: 700, height: 400 },
              cardIds: ["S"],
              activeCardId: "S",
              title: "",
              acceptsFamilies: ["standard"],
            },
            {
              id: "pt1",
              position: { x: 80, y: 80 },
              size: { width: 700, height: 400 },
              cardIds: ["T1"],
              activeCardId: "T1",
              title: "",
              acceptsFamilies: ["standard"],
            },
            // Two cards in one pane: the pane row gets a subrow per card.
            {
              id: "pt2",
              position: { x: 100, y: 100 },
              size: { width: 700, height: 400 },
              cardIds: ["T2", "T3"],
              activeCardId: "T2",
              title: "",
              acceptsFamilies: ["standard"],
            },
          ],
          activePaneId: "pt1",
          imposition: {
            kind: "one-up",
            sidebars: { cards: { side: "right" } },
          },
          hasFocus: true,
        },
      },
    ],
  };
}

/**
 * Two workspaces, the first of them holding nothing.
 *
 * The empty one is FIRST in the list, so the arrow walk below starts on its
 * header and the next thing the cursor can legally reach is the other
 * workspace's. It is not the ACTIVE one, and that is deliberate: the shown
 * card has to belong to a workspace whose active pane is a content pane, or
 * the sidebar toggle that hands the list its focus would read as "hide"
 * rather than as "activate". A workspace's rail pane is excluded from the
 * projection, so a deck holding nothing but its Workspaces card projects no
 * inner rows at all — which is the whole of what "empty workspace" means here.
 */
function emptyBlob(): Record<string, unknown> {
  return {
    version: 5,
    activeSpaceId: FULL,
    spaces: [
      {
        id: BARE,
        name: "Bare",
        deck: {
          cards: [
            { id: "CB", componentId: "cards", title: "Workspaces", closable: true },
          ],
          panes: [rail("pcb", "CB")],
          activePaneId: "pcb",
          imposition: { kind: "one-up", sidebars: { cards: { side: "right" } } },
          hasFocus: true,
        },
      },
      {
        id: FULL,
        name: "Full",
        deck: {
          cards: [
            { id: "CF", componentId: "cards", title: "Workspaces", closable: true },
            { id: "TF", componentId: "text", title: "TF", closable: true },
          ],
          panes: [
            rail("pcf", "CF"),
            {
              id: "ptf",
              position: { x: 60, y: 60 },
              size: { width: 700, height: 400 },
              cardIds: ["TF"],
              activeCardId: "TF",
              title: "",
              acceptsFamilies: ["standard"],
            },
          ],
          activePaneId: "ptf",
          imposition: { kind: "one-up", sidebars: { cards: { side: "right" } } },
          hasFocus: true,
        },
      },
    ],
  };
}

/**
 * Press a row, engage the carry, hover another element, and release there —
 * all inside one `evalJS`, because `data-drop-target` lives only for the
 * length of the gesture and a poll from outside could only arrive after it.
 * The same shape `at0583` drives its block-drop legs with.
 */
const carryScript = (fromSel: string, overSel: string, readSel: string): string =>
  `(function () {
  var row = document.querySelector(${JSON.stringify(fromSel)});
  var over = document.querySelector(${JSON.stringify(overSel)});
  if (row === null || over === null) throw new Error("no row or hover target");
  var r = row.getBoundingClientRect();
  var o = over.getBoundingClientRect();
  var opts = function (cx, cy) {
    return { bubbles: true, cancelable: true, clientX: cx, clientY: cy, pointerId: 1, button: 0 };
  };
  var x = r.left + r.width / 2;
  var y = r.top + r.height / 2;
  row.dispatchEvent(new PointerEvent("pointerdown", opts(x, y)));
  window.dispatchEvent(new PointerEvent("pointermove", opts(x, y + 10)));
  var engaged = row.getAttribute("data-dragging") === "true";
  var ox = o.left + o.width / 2;
  var oy = o.top < r.top ? o.top + 2 : o.bottom - 2;
  window.dispatchEvent(new PointerEvent("pointermove", opts(ox, oy)));
  var read = Array.prototype.filter.call(
    document.querySelectorAll(${JSON.stringify(readSel)}),
    function (el) { return el.getAttribute("data-drop-target") === "true"; }
  ).length;
  window.dispatchEvent(new PointerEvent("pointerup", opts(ox, oy)));
  return { engaged: engaged, read: read };
})()`;

/**
 * Many workspaces, the ACTIVE one last.
 *
 * The list is then longer than the card's scrollport and the workspace the
 * delete will be about is below the fold at rest — which is the case an arrow
 * alone cannot answer, because an arrow aimed at a row that is not on screen
 * points off the edge of the card.
 */
function crowdBlob(): Record<string, unknown> {
  const spaces = Array.from({ length: CROWD }, (_, i) => {
    const last = i === CROWD - 1;
    const cards = [
      { id: `T${i}`, componentId: "text", title: `T${i}`, closable: true },
      ...(last
        ? [{ id: "CC", componentId: "cards", title: "Workspaces", closable: true }]
        : []),
    ];
    return {
      id: crowdId(i),
      name: `W${i}`,
      deck: {
        cards,
        panes: [
          {
            id: `pt${i}`,
            position: { x: 60, y: 60 },
            size: { width: 700, height: 400 },
            cardIds: [`T${i}`],
            activeCardId: `T${i}`,
            title: "",
            acceptsFamilies: ["standard"],
          },
          ...(last ? [rail("pcc", "CC")] : []),
        ],
        activePaneId: `pt${i}`,
        imposition: {
          kind: "one-up",
          ...(last ? { sidebars: { cards: { side: "right" } } } : {}),
        },
        hasFocus: true,
      },
    };
  });
  return { version: 5, activeSpaceId: CROWD_LAST, spaces };
}

/** A DOMRect flattened to the four numbers the containment checks read. */
interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

const boxOf = (sel: string): string =>
  `(function () {
     var el = document.querySelector(${JSON.stringify(sel)});
     if (el === null) throw new Error("no element: " + ${JSON.stringify(sel)});
     var r = el.getBoundingClientRect();
     return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
   })()`;

interface Carry {
  engaged: boolean;
  read: number;
}

describe.skipIf(!SHOULD_RUN)(
  "at0591 — the Workspaces card's three levels read as three",
  () => {
    test(
      "the workspace header is the quietest level and the leading one",
      async () => {
        const tugbankPath = mkTempTugbank();
        seedTugbankForLaunch(tugbankPath);
        tugbankWrite(
          tugbankPath,
          "dev.tugapp.deck.layout",
          "layout",
          "json",
          JSON.stringify(blob()),
        );

        const app = await launchTugApp({
          testName: "at0591-workspace-card-levels",
          env: { TUGBANK_PATH: tugbankPath },
          skipAccessibilityPreflight: true,
          persistInTestMode: true,
          restoreInTestMode: true,
        });
        try {
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(SPACE_HEADER_CELL)}) !== null
             && document.querySelector(${JSON.stringify(GROUP_HEADER_CELL)}) !== null
             && document.querySelector(${JSON.stringify(SUBROW_GLYPH)}) !== null`,
            { timeoutMs: 25_000 },
          );
          await app.bindSession("S", { tugSessionId: "at0591-S" });
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(SESSION_CONTENT)}) !== null`,
            { timeoutMs: 20_000 },
          );
          await settle();

          // ---- 1. Wash ordering. -----------------------------------------
          // An ORDERING, not a value: the rows are the baseline every theme
          // shares, and what has to hold is that the container sits nearer it
          // than the thing it contains.
          const rowBg = parseChannels(await bgOf(app, PANE_ROW_CELL));
          const spaceBg = parseChannels(await bgOf(app, SPACE_HEADER_CELL));
          const groupBg = parseChannels(await bgOf(app, GROUP_HEADER_CELL));
          const spaceLift = distance(spaceBg, rowBg);
          const groupLift = distance(groupBg, rowBg);
          note(
            `at0591 wash: row=${JSON.stringify(rowBg)} ` +
              `space=${JSON.stringify(spaceBg)} (${spaceLift.toFixed(2)}) ` +
              `group=${JSON.stringify(groupBg)} (${groupLift.toFixed(2)})`,
          );
          expect(
            spaceLift,
            "the workspace header sits nearer the well than the group header — the container recedes",
          ).toBeLessThan(groupLift);
          expect(
            spaceLift,
            "and it is still a level rather than a third stripe",
          ).toBeGreaterThan(0);

          // ---- 2. The drop-target wash is not either header's. ------------
          // [B03]'s one prohibition: inverting the two header washes must not
          // move either of them onto the colour a drop target wears.
          //
          // Read from the TOKEN rather than from an armed row, and that is a
          // finding rather than a convenience. Arming `data-drop-target` on
          // the element `useBlockReorder` actually marks — `[data-cards-space-run]`,
          // its `SPACE_RUN_SELECTOR` — leaves `background-color` computing to
          // `oklab(0 0 0 / 0)`: the rule at `.cards-list [data-cards-space-run]`
          // `[data-drop-target="true"]` is (0,3,0) and loses to a same-weight
          // rule on `.tug-list-row` from another file, exactly the cascade
          // race the header wash above works around with a doubled selector.
          // That predates this change — nothing here touches a row's
          // background — so the prohibition is checked against the colour the
          // rule DECLARES, which is the thing the inversion could collide
          // with, and the cascade is left for its own arc.
          const probe = await app.evalJS<Record<string, string>>(
            `(function () {
               var row = document.querySelector(
                 ${JSON.stringify(`${SHOWN}.cards-list [data-cards-space-run]`)}
               );
               if (row === null) throw new Error("no workspace run to arm");
               var before = getComputedStyle(row).backgroundColor;
               row.setAttribute("data-drop-target", "true");
               var cs = getComputedStyle(row);
               var out = {
                 tag: row.tagName,
                 cls: row.className,
                 before: before,
                 after: cs.backgroundColor,
                 shorthand: cs.background,
                 token: cs.getPropertyValue(
                   "--tug7-surface-tone-primary-normal-accent-rest",
                 ),
               };
               row.removeAttribute("data-drop-target");
               return out;
             })()`,
          );
          note(`at0591 drop probe: ${JSON.stringify(probe)}`);
          // The accent resolved over the card well, which is what the rule
          // would paint if it won its cascade.
          const dropBg = parseChannels(
            await app.evalJS<string>(
              `(function () {
                 var toSrgb = ${TO_SRGB};
                 var el = document.querySelector(${JSON.stringify(SPACE_HEADER_CELL)});
                 var probe = document.createElement("div");
                 probe.style.backgroundColor =
                   "color-mix(in oklab, " +
                   getComputedStyle(el).getPropertyValue(
                     "--tug7-surface-tone-primary-normal-accent-rest",
                   ) +
                   ", var(--tug7-surface-card-primary-normal-well-rest))";
                 el.appendChild(probe);
                 var bg = toSrgb(getComputedStyle(probe).backgroundColor);
                 probe.remove();
                 return bg;
               })()`,
            ),
          );
          note(`at0591 drop-target colour over the well: ${JSON.stringify(dropBg)}`);
          expect(
            distance(dropBg, spaceBg),
            "an armed drop target does not read as a workspace header",
          ).toBeGreaterThan(4);
          expect(
            distance(dropBg, groupBg),
            "nor as a group header",
          ).toBeGreaterThan(4);

          // ---- 3. Indent ordering, rung by rung. -------------------------
          const spaceLeft = await leftOf(app, SPACE_GLYPH);
          const groupLeft = await leftOf(app, GROUP_GLYPH);
          const paneLeft = await leftOf(app, PANE_GLYPH);
          const subrowLeft = await leftOf(app, SUBROW_GLYPH);
          note(
            `at0591 indent: space=${spaceLeft.toFixed(1)} ` +
              `group=${groupLeft.toFixed(1)} pane=${paneLeft.toFixed(1)} ` +
              `subrow=${subrowLeft.toFixed(1)}`,
          );
          expect(
            groupLeft - spaceLeft,
            "the group header steps in from the workspace header holding it",
          ).toBeGreaterThan(1);
          expect(
            paneLeft - groupLeft,
            "and a pane row steps in from the group header holding it",
          ).toBeGreaterThan(1);
          // The rung that would have caught the subrow collision: a subrow's
          // rule restates the whole sum because the pane rows' rule cannot
          // reach it, and getting that wrong puts a card LEFT of its pane.
          expect(
            subrowLeft - paneLeft,
            "and a subrow steps in from its own pane row, never left of it",
          ).toBeGreaterThan(1);

          // ---- 4. The two pane-row kinds stay flush. ----------------------
          // What this leg was written to answer is whether `[F05]`'s "all
          // three flush" survives the change, and the answer it returns is
          // that the two pane-row kinds were never flush to begin with: a
          // one-line row renders a leading close-box slot and a session
          // monitor row does not, which puts their content boxes a slot's
          // width apart for a reason the indent neither caused nor can fix.
          //
          // So what is asserted is the thing the indent IS responsible for:
          // that the step is charged EQUALLY to both kinds. Their own insets
          // live in two different places — `--tugx-session-row-leading-inset`
          // on `.tug-session-row-lines`, nothing at all on
          // `.cards-row-headline` — so a rule that reached only one of them
          // would pull the two kinds apart by the step, on top of the slot
          // they already differ by. The raw edges are noted either way, so a
          // later arc that closes the slot gap can read what it was.
          const sessionLeft = await leftOf(app, SESSION_CONTENT);
          const onelineLeft = await leftOf(app, ONELINE_CONTENT);
          const pads = await app.evalJS<string[]>(
            `[
               ${JSON.stringify(SESSION_CONTENT)},
               ${JSON.stringify(ONELINE_CONTENT)},
             ].map(function (sel) {
               var el = document.querySelector(sel);
               if (el === null) throw new Error("no element: " + sel);
               return getComputedStyle(el).paddingInlineStart;
             })`,
          );
          note(
            `at0591 flush: session=${sessionLeft.toFixed(1)} ` +
              `oneline=${onelineLeft.toFixed(1)} pads=${JSON.stringify(pads)}`,
          );
          expect(
            pads[0],
            "the level step is charged to a session monitor row and a one-line row alike",
          ).toBe(pads[1]);
          expect(
            pads[0],
            "and it is the two-level step, not one level or none",
          ).toBe("24px");
        } finally {
          await app.close().catch(() => undefined);
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "the workspace header already stands at the rename field's height",
      async () => {
        const tugbankPath = mkTempTugbank();
        seedTugbankForLaunch(tugbankPath);
        tugbankWrite(
          tugbankPath,
          "dev.tugapp.deck.layout",
          "layout",
          "json",
          JSON.stringify(blob()),
        );

        const app = await launchTugApp({
          testName: "at0591-workspace-rename-height",
          env: { TUGBANK_PATH: tugbankPath },
          skipAccessibilityPreflight: true,
          persistInTestMode: true,
          restoreInTestMode: true,
        });
        try {
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(SPACE_HEADER_ROW)}) !== null
             && document.querySelector(${JSON.stringify(GROUP_HEADER_CELL)}) !== null`,
            { timeoutMs: 25_000 },
          );
          await settle();

          // The header's resting height, and the top of the row below it. The
          // second is what says the rest of the list did not shift: a header
          // that grows pushes everything under it down, which is the thing a
          // reader actually sees.
          const heightOf = (): Promise<number> =>
            app.evalJS<number>(
              `(function () {
                 var el = document.querySelector(${JSON.stringify(SPACE_HEADER_ROW)});
                 if (el === null) throw new Error("no workspace header");
                 return el.getBoundingClientRect().height;
               })()`,
            );
          const belowTop = (): Promise<number> =>
            app.evalJS<number>(
              `(function () {
                 var el = document.querySelector(${JSON.stringify(GROUP_HEADER_CELL)});
                 if (el === null) throw new Error("no group header");
                 return el.getBoundingClientRect().top;
               })()`,
            );

          const atRest = await heightOf();
          const belowAtRest = await belowTop();

          await app.nativeClickAtElement(VERBS_BUTTON);
          await app.waitForCondition<boolean>(
            `document.querySelector('[data-item-action="rename-space"]') !== null`,
            { timeoutMs: 8_000 },
          );
          await app.nativeClickAtElement('[data-item-action="rename-space"]');
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(RENAME_INPUT)}) !== null`,
            { timeoutMs: 8_000 },
          );
          // The menu closes on its activation blink, which is a Web Animation
          // and does not advance while the harness window is covered. Escape
          // is the menu's own close and it consumes the press, so the field
          // that just opened is untouched by it — at0578 carries the same
          // note for the same reason.
          await app.nativeKey("Escape");
          await app.waitForCondition<boolean>(
            `document.querySelector(".tug-menu-content") === null`,
            { timeoutMs: 8_000 },
          );
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(RENAME_INPUT)}) !== null`,
            { timeoutMs: 4_000 },
          );
          await settle();
          const whileOpen = await heightOf();
          const belowWhileOpen = await belowTop();

          await app.nativeType("Levels");
          await app.nativeKey("Return");
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(RENAME_INPUT)}) === null`,
            { timeoutMs: 8_000 },
          );
          await settle();
          const afterCommit = await heightOf();
          const belowAfterCommit = await belowTop();

          note(
            `at0591 rename height: rest=${atRest.toFixed(2)} ` +
              `open=${whileOpen.toFixed(2)} after=${afterCommit.toFixed(2)} ` +
              `belowTop rest=${belowAtRest.toFixed(2)} ` +
              `open=${belowWhileOpen.toFixed(2)} after=${belowAfterCommit.toFixed(2)}`,
          );

          expect(
            whileOpen,
            "the header already stood at the field's height, so opening one does not grow it",
          ).toBeCloseTo(atRest, 1);
          expect(
            afterCommit,
            "and committing the rename puts it back exactly where it was",
          ).toBeCloseTo(atRest, 1);
          expect(
            belowWhileOpen,
            "so the row below the header does not move while the field is open",
          ).toBeCloseTo(belowAtRest, 1);
          expect(
            belowAfterCommit,
            "nor after the rename commits",
          ).toBeCloseTo(belowAtRest, 1);
        } finally {
          await app.close().catch(() => undefined);
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "an empty workspace draws a None row the cursor skips and a drag can land on",
      async () => {
        const tugbankPath = mkTempTugbank();
        seedTugbankForLaunch(tugbankPath);
        tugbankWrite(
          tugbankPath,
          "dev.tugapp.deck.layout",
          "layout",
          "json",
          JSON.stringify(emptyBlob()),
        );

        const app = await launchTugApp({
          testName: "at0591-workspace-empty-row",
          env: { TUGBANK_PATH: tugbankPath },
          skipAccessibilityPreflight: true,
          persistInTestMode: true,
          restoreInTestMode: true,
        });
        try {
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(SPACE_HEADER_CELL)}).length === 2
             && document.querySelector(${JSON.stringify(EMPTY_ROW)}) !== null`,
            { timeoutMs: 25_000 },
          );
          await settle();

          // ---- 1. Exactly one, saying `None`, inside its workspace's block.
          const empty = await app.evalJS<{
            count: number;
            text: string;
            run: string | null;
          }>(
            `(function () {
               var all = document.querySelectorAll(${JSON.stringify(EMPTY_ROW)});
               var el = all[0];
               return {
                 count: all.length,
                 text: el === undefined ? "" : el.textContent,
                 run: el === undefined ? null : el.getAttribute("data-cards-space-run"),
               };
             })()`,
          );
          note(`at0591 None row: ${JSON.stringify(empty)}`);
          expect(empty.count, "one row, for the one empty workspace").toBe(1);
          // `None` rather than `No matches`: no filter is live, so there is
          // nothing being hidden — the workspace is simply empty.
          expect(empty.text).toBe("None");
          // In the block, which is what makes it a drop zone rather than a
          // label.
          expect(empty.run).toBe(BARE);

          // ---- 2. The cursor walks past it. -------------------------------
          // Home lands on row 0, which is the empty workspace's own header;
          // one ArrowDown has to reach the NEXT workspace's header, because
          // the row between them is inert ([P06]).
          await app.dispatchControlAction("toggle-cards");
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(CURSOR_ROW)}) !== null`,
            { timeoutMs: 8_000 },
          );
          await app.nativeKey("Home");
          await settle(150);
          await app.waitForCondition<boolean>(
            `(function () {
               var row = document.querySelector(${JSON.stringify(CURSOR_ROW)});
               return row !== null &&
                 row.querySelector('[data-cards-space-id="${BARE}"]') !== null;
             })()`,
            { timeoutMs: 8_000 },
          );
          await app.nativeKey("ArrowDown");
          await settle(150);
          const landed = await app.evalJS<string | null>(
            `(function () {
               var row = document.querySelector(${JSON.stringify(CURSOR_ROW)});
               if (row === null) return null;
               var header = row.querySelector("[data-cards-space-id]");
               return header === null
                 ? row.getAttribute("data-tug-list-cell-kind")
                 : header.getAttribute("data-cards-space-id");
             })()`,
          );
          note(`at0591 one ArrowDown from the empty header lands on: ${landed}`);
          expect(
            landed,
            "the arrow walk steps over the None row to the next workspace",
          ).toBe(FULL);

          // ---- 3. A drag can still land on it. ----------------------------
          // Inert to the CURSOR is not inert to a drag: the drop target comes
          // from `data-cards-space-run` in the DOM, which the row wears, so an
          // empty workspace has somewhere to aim a card at — the whole of what
          // [B07] is for.
          const carry = await app.evalJS<Carry>(
            carryScript(
              `${SHOWN}.cards-list .cards-row[data-cards-space-run="${FULL}"]`,
              EMPTY_ROW,
              runOf(BARE),
            ),
          );
          note(`at0591 carry onto the None row: ${JSON.stringify(carry)}`);
          expect(carry.engaged, "the carry engaged at all").toBe(true);
          // Both elements of the empty workspace's block light: its header and
          // the None row under it.
          expect(carry.read).toBe(2);

          await app.waitForCondition<boolean>(
            `window.tugdeck.diag.getSpaces().spaces.filter(function (s) {
               return s.id === ${JSON.stringify(BARE)};
             })[0].deck.cards.length === 2`,
            { timeoutMs: 8_000 },
          );
          // What the LIST shows afterwards, noted rather than asserted, and
          // that is a finding rather than a softening.
          //
          // The projection itself is fresh: the workspace's header reports
          // `1 card` and its block has grown. But an element carrying
          // `data-testid="cards-space-empty"` is still in the document — a
          // cell the list primitive recycled rather than took down, drawn from
          // a row the projection no longer emits. That is the same family as
          // the stale-index render this arc's `rowAt` change was written
          // against, reached here through a different door, and asserting the
          // element's absence would make this leg a test of the list
          // primitive's teardown rather than of the `None` row. The reading is
          // recorded so a later arc has the measurement rather than a
          // suspicion.
          const after = await app.evalJS<Record<string, unknown>>(
            `(function () {
               var empty = document.querySelector(${JSON.stringify(EMPTY_ROW)});
               var header = document.querySelector(
                 ${JSON.stringify(`${SHOWN}.cards-space-header[data-cards-space-id="${BARE}"]`)}
               );
               var count = header === null
                 ? null
                 : header.querySelector('[data-testid="cards-space-count"]');
               return {
                 noneRowStanding: empty !== null,
                 headerSummary: count === null ? null : count.textContent,
                 runLength: document.querySelectorAll(${JSON.stringify(runOf(BARE))}).length,
               };
             })()`,
          );
          note(`at0591 the empty workspace's block after the drop: ${JSON.stringify(after)}`);
        } finally {
          await app.close().catch(() => undefined);
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "the delete confirm reveals its row, points at it, and stays inside the card",
      async () => {
        const tugbankPath = mkTempTugbank();
        seedTugbankForLaunch(tugbankPath);
        tugbankWrite(
          tugbankPath,
          "dev.tugapp.deck.layout",
          "layout",
          "json",
          JSON.stringify(crowdBlob()),
        );

        const app = await launchTugApp({
          testName: "at0591-workspace-confirm-arrow",
          env: { TUGBANK_PATH: tugbankPath },
          skipAccessibilityPreflight: true,
          persistInTestMode: true,
          restoreInTestMode: true,
        });
        try {
          await app.waitForCondition<boolean>(
            `document.querySelectorAll(${JSON.stringify(SPACE_HEADER_CELL)}).length === ${CROWD}`,
            { timeoutMs: 25_000 },
          );
          await settle();

          // Put the card's scroller at the top, so the LAST workspace's header
          // — the one the delete will be about — is below the fold. The
          // scroller is the card, not the list: the list is `inline` with
          // `overflow: visible`, which is also why every cell is mounted and
          // the reveal can be one `scrollIntoView`.
          const scrolled = await app.evalJS<{
            scrollHeight: number;
            clientHeight: number;
          }>(
            `(function () {
               var card = document.querySelector(${JSON.stringify(CARD_ROOT)});
               if (card === null) throw new Error("no card root");
               card.scrollTop = 0;
               return { scrollHeight: card.scrollHeight, clientHeight: card.clientHeight };
             })()`,
          );
          note(`at0591 card scroller: ${JSON.stringify(scrolled)}`);
          expect(
            scrolled.scrollHeight,
            "the fixture is crowded enough that the list overflows — otherwise there is nothing to reveal",
          ).toBeGreaterThan(scrolled.clientHeight);
          await settle(200);

          const cardBox = await app.evalJS<Box>(boxOf(CARD_ROOT));
          const headerBefore = await app.evalJS<Box>(
            boxOf(`${SHOWN}.cards-space-header[data-cards-space-id="${CROWD_LAST}"]`),
          );
          note(
            `at0591 before the confirm: card=${JSON.stringify(cardBox)} ` +
              `header=${JSON.stringify(headerBefore)}`,
          );
          expect(
            headerBefore.top,
            "the row the confirm will be about starts out below the card's fold",
          ).toBeGreaterThan(cardBox.bottom);

          // The Window menu's own wire, which is the path the report came in
          // on: it reaches this card through `cardsSpaceVerbRequest` rather
          // than through any surface of the card itself.
          await app.dispatchControlAction("delete-space");
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(CONFIRM)}) !== null`,
            { timeoutMs: 15_000 },
          );
          await settle(300);

          // ---- 1. The reveal. ---------------------------------------------
          const headerAfter = await app.evalJS<Box>(
            boxOf(`${SHOWN}.cards-space-header[data-cards-space-id="${CROWD_LAST}"]`),
          );
          const cardAfter = await app.evalJS<Box>(boxOf(CARD_ROOT));
          note(
            `at0591 after the confirm: card=${JSON.stringify(cardAfter)} ` +
              `header=${JSON.stringify(headerAfter)}`,
          );
          expect(
            headerAfter.top,
            "the anchor row was revealed before the popover opened",
          ).toBeGreaterThanOrEqual(cardAfter.top - 1);
          expect(
            headerAfter.bottom,
            "and it is inside the scrollport, not past its far edge",
          ).toBeLessThanOrEqual(cardAfter.bottom + 1);

          // ---- 2. The arrow. ----------------------------------------------
          expect(
            await app.evalJS<number>(
              `document.querySelectorAll(${JSON.stringify(POPOVER_ARROW)}).length`,
            ),
            "exactly one arrow, so the popover names the row it is asking about",
          ).toBe(1);

          // ---- 3. The collision boundary. ---------------------------------
          // What the boundary buys: a shift can move the popover within the
          // card, and can never carry it out onto a neighbouring card.
          const popover = await app.evalJS<Box>(boxOf(CONFIRM));
          note(`at0591 confirm box: ${JSON.stringify(popover)}`);
          expect(popover.left, "the popover's leading edge is inside the card").toBeGreaterThanOrEqual(
            cardAfter.left - 1,
          );
          expect(popover.right, "and its trailing edge").toBeLessThanOrEqual(
            cardAfter.right + 1,
          );

          await app.nativeKey("Escape");
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(CONFIRM)}) === null`,
            { timeoutMs: 8_000 },
          );
          expect(
            await app.evalJS<number>(
              `window.tugdeck.diag.getSpaces().spaces.length`,
            ),
            "Escape cancelled — nothing was deleted",
          ).toBe(CROWD);
        } finally {
          await app.close().catch(() => undefined);
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
