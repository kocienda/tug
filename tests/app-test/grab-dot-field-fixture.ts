/**
 * grab-dot-field-fixture.ts — the deck, the readers and the fixtures the
 * at0628-grab-dot-field-* files share: the drag affordance on a content
 * card's title bar, and its absence from a rail.
 *
 * A content card is dragged by its chrome along the bar's whole run, and until
 * this mark nothing said so: you found the handle by trying it. The mark is a
 * field of 1px dots, three rows deep on a 4px pitch, filling the run between
 * the title and the control cluster and fading up when the pointer is on that
 * bar.
 *
 * ── Why this is a test and not a comment ──
 * Three of the claims the field rests on are claims about RASTERIZATION and
 * LAYOUT that prose cannot hold:
 *
 *   1. THE GEOMETRY IS DERIVED. The block-size is `(rows - 1) × pitch + dot`,
 *      never stated — 9px at three rows on a 4px pitch. The vertical stencil
 *      opens at 0 and again every pitch, so a box of exactly that height closes
 *      under the last row it wants and cuts no partial one. A height stated
 *      independently of the pitch would sooner or later cut a partial row and
 *      hand the `…` button back the argument the field exists to win: the field
 *      is a BLOCK of dots where the button is a LINE of them.
 *
 *   2. THE FIELD IS A MASKED SOLID, NOT A TILED BACKGROUND. Drawn the ordinary
 *      way — a repeating radial-gradient tile with a disc in it — the dots
 *      render at visibly different sizes, because a repeated background is
 *      composited tile by tile with each tile's device rect rounded
 *      independently, and a 1px circle is a curve whose rasterization is
 *      entirely antialiasing. The shipped technique is a solid ink box masked
 *      to 1px SQUARES by two crossed hard-edged gradients under
 *      `mask-composite: intersect`, each painted once across the whole box. A
 *      future edit that "simplifies" this back into a background is exactly the
 *      regression to catch, and `maskComposite` is what catches it.
 *
 *   3. THE MEASURE DOES NOT MOVE. The field holds its flex space at all times
 *      and only `opacity` changes, so a title's elision point is identical
 *      whether or not the field is drawn. A name that reflowed under the
 *      pointer would be a worse problem than the one the mark solves.
 *
 * ── The trigger, and why the pointer CAN appear below ──
 * The trigger is `[data-pointer-within]` on the bar — the attribute the pane
 * derives from `pointerenter`/`pointerleave` — and not the `:hover`
 * pseudo-class it shipped as. WebKit decides a pseudo-class by hit-testing
 * against the PHYSICAL cursor and only re-decides it when that cursor moves, so
 * a press in the masthead, which activates the card and re-renders the bar
 * under a stationary pointer, put the dots out and left them out until the hand
 * jiggled the mouse. The attribute is React's own half of hover and survives
 * the re-render.
 *
 * The DRAG is the trigger's other blind spot, and it has a rule of its own. A
 * press on the handle takes pointer capture on the frame, which retargets the
 * whole pointer stream and fires the bar's `pointerleave` on the way — so the
 * attribute goes out at the instant of the grab and the mark the hand is
 * holding went dark with it. The frame's `data-gesture` pins the field for the
 * gesture's duration, and the reading in `-content` proves the pin is what is
 * doing it: mid-drag the attribute is absent and the field is up regardless.
 *
 * That is also what makes the reveal readable here: the harness's
 * `revealPaneControls` dispatches the same `pointerenter` the product listens
 * on, and a dispatched event reaches the listener a real one does — where no
 * dispatch can move a pseudo-class.
 *
 * The geometry is still read at REST, which is the third claim restated:
 * everything about the field except its opacity is true there. And the measure
 * claim is proven by forcing the one property the trigger changes and
 * re-measuring the title — a stricter reading than the reveal gives, because it
 * isolates the field's paint from every other thing a pointer entering a card
 * also does.
 *
 * ── Two pages ──
 * A Session card draws its pane's chrome, masthead and all, in its own page,
 * so the session tier is read there and every other tier in the shell's; a
 * fixture that forces a style is laid in both. The drag that proves only the
 * handle begins a gesture is pressed on the Text card's bar, whose chrome is
 * still the shell's: a Session card's drag is the host's (`at0744` reads it).
 *
 * ── The absence is half the subject ──
 * A rail is pinned to a deck edge and is not dragged by its bar, so a drag
 * affordance on one would advertise a gesture that does not exist. The rail's
 * bar carries its own `::after` — the trailing racing-stripe band, 7px of three
 * hairlines — so "no field on a rail" is not "no pseudo-element on a rail": it
 * is that pseudo-element still being the stripes. Reading its height and the
 * absence of a mask is what tells the two apart.
 *
 * The same exclusion has a second face the rail's bar cannot show. The masthead
 * tiers hang the field off `.tug-session-row-name-line`, which belongs to
 * `TugSessionRow` — and the Cards rail mounts that same component for its
 * session cells. Keyed off the shared class the field would have appeared on
 * every one of them and taken the grow away from their titles; keyed off the
 * three masthead row classes it does not. The rail's session cell is checked
 * for both halves of that: it grows no field, and its title keeps its grow.
 *
 * ── The ink reaches the field and nothing else ──
 * The field's ink differs by the pane's focus, and it is a custom property, so
 * where it is declared decides what a focus flip restyles. Declared on the
 * pane, it inherited into every element the pane holds and a flip restyled the
 * whole subtree — 15 ms on a session pane and about 50 on the Overview, inside
 * the commit a flow slide runs over. Declared on the field, a flip restyles the
 * field. The pin is structural rather than a duration: across a real focus
 * flip, no element of either pane but a field resolves the ink at all, and each
 * field's own ink still follows its pane's focus, which is the dots looking the
 * same (`-ink`).
 *
 * Split out of `at0628-grab-dot-field.test.ts` when that file was cut one
 * test to a file so each launch fits its own budget.
 *
 * @module tests/app-test/grab-dot-field-fixture
 */

import { expect } from "bun:test";
import { resolve } from "node:path";

import { type App } from "./_harness";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 180_000;

/** The worktree root — the real repo tugcast serves as its bootstrap tree. */
export const REPO = resolve(import.meta.dir, "..", "..");

/** The settle window, with room for the imposition's landing tween. */
export const AFTER_LAND_MS = 900;

/**
 * The derived block-size at the shipped setting: three rows, 4px pitch, 1px
 * dot. Written as the arithmetic rather than as `"9px"` so that a deliberate
 * retune of the pitch or the row count reads here as the one number it moves,
 * and an accidental restatement of the height still fails.
 */
const ROWS = 3;
const PITCH = 4;
const DOT = 1;
export const FIELD_BLOCK_SIZE = `${(ROWS - 1) * PITCH + DOT}px`;

/**
 * The handle's FLOOR — the run the field keeps however long the title, so the
 * dots are always reserved. Counted in columns and derived the same way as the
 * block-size: eight columns on a 4px pitch is 29px.
 */
const MIN_COLUMNS = 8;
export const FIELD_MIN_INLINE = (MIN_COLUMNS - 1) * PITCH + DOT;

/** The rail's trailing stripe band — three 1px lines on a 3px pitch. */
export const STRIPE_BLOCK_SIZE = "7px";

export const SESSION_FRAME = '[data-slot="session-masthead"]';
export const DOC_FRAME = '[data-slot="card-masthead"]';
export const COMMIT_CARD = '[data-slot="commit-card"]';

export const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/** What the field is, read off the browser rather than off the stylesheet. */
export interface Field {
  /** Whether the dot box is mounted at all. */
  present: boolean;
  blockSize: string;
  /** Truncated: only whether the stencil is there, never its whole text. */
  mask: string;
  composite: string;
  opacity: string;
  pointerEvents: string;
  /** The HANDLE's cursor — the half of "grab here" that speaks before a press. */
  handleCursor: string | null;
}

export interface Line extends Field {
  /** The title's grow — 1 where the title holds the run, 0 where the field does. */
  titleGrow: string | null;
  /** The title's box, for the measure claim. */
  titleWidth: number | null;
  titleRight: number | null;
}

/**
 * Read one handle-and-field and the title beside it.
 *
 * `hostSel` is the element carrying the handle — a title bar on the utility
 * tier, a masthead's lead line on the three masthead tiers. The dots are a REAL
 * element rather than the `::after` they began as, because they are now the only
 * drag surface and a pseudo-element cannot be hit-tested apart from its owner.
 */
const READ = `(function (hostSel) {
  var host = document.querySelector(hostSel);
  if (host === null) return null;
  var handle = host.querySelector(".tug-pane-grab-handle");
  var dots = handle === null ? null : handle.querySelector(".tug-pane-grab-dots");
  var s = dots === null ? null : getComputedStyle(dots);
  var title = host.querySelector(".tug-list-row-title") || host.querySelector(".tug-pane-title");
  var r = title === null ? null : title.getBoundingClientRect();
  return {
    present: dots !== null,
    blockSize: s === null ? "" : s.blockSize,
    mask: s === null ? "" : String(s.maskImage).slice(0, 26),
    composite: s === null ? "" : s.maskComposite,
    opacity: s === null ? "" : s.opacity,
    pointerEvents: s === null ? "" : s.pointerEvents,
    handleCursor: handle === null ? null : getComputedStyle(handle).cursor,
    titleGrow: title === null ? null : getComputedStyle(title).flexGrow,
    titleWidth: r === null ? null : +r.width.toFixed(2),
    titleRight: r === null ? null : +r.right.toFixed(2)
  };
})`;

/** The field on `hostSel`, in the page that draws that tier's chrome. */
export async function readLine(page: Pick<App, "evalJS">, hostSel: string): Promise<Line | null> {
  // card-dom: shell — in whichever page the caller names, the shell's included.
  return page.evalJS<Line | null>(`${READ}(${JSON.stringify(hostSel)})`);
}

/**
 * Read an element's own `::after`, for the one surface that still draws with
 * one: a RAIL's trailing racing-stripe band. "No field on a rail" is not "no
 * pseudo-element on a rail", so the stripes have to be read to be told apart
 * from the thing that replaced them elsewhere.
 */
export async function readRailPseudo(
  page: Pick<App, "evalJS">,
  hostSel: string,
): Promise<{ blockSize: string; mask: string; cursor: string } | null> {
  return page.evalJS<{ blockSize: string; mask: string; cursor: string } | null>(
    `(function (sel) {
       var el = document.querySelector(sel);
       if (el === null) return null;
       var s = getComputedStyle(el, "::after");
       return {
         blockSize: s.blockSize,
         mask: String(s.maskImage).slice(0, 26),
         cursor: getComputedStyle(el).cursor
       };
     })(${JSON.stringify(hostSel)})`,
  );
}

/**
 * The pages that draw this deck's chrome: the utility card's, the Session
 * card's, the Text card's and the Cards rail's, each of which draws its pane's
 * chrome in its own.
 */
export function chromePages(app: App): Array<Pick<App, "evalJS">> {
  return [app.body("U"), app.body("A"), app.body("B"), app.body("L")];
}

/** The Session card's pane, in its own page. */
export const SESSION_PANE = ".body-chrome-frame";

/**
 * Force the field up.
 *
 * The one property the trigger changes, and nothing else — so what is measured
 * afterwards differs from the rest state by exactly the field being painted.
 */
export async function forceFieldVisible(app: App): Promise<void> {
  // card-dom: shell — in every page that draws this deck's chrome.
  for (const page of chromePages(app)) await page.evalJS<null>(
    `(function () {
       var st = document.createElement("style");
       st.id = "at0628-force";
       st.textContent =
         '.tug-pane-title-bar:not([data-role="sidebar"]) .tug-pane-grab-dots' +
         ' { opacity: 1 !important; }';
       document.head.appendChild(st);
       return null;
     })()`,
  );
}

/**
 * Stand the field's fade down, so its opacity resolves rather than animates.
 *
 * Nothing about what is asserted changes: the fade is 120ms of easing on the
 * one property the trigger moves, and an occluded harness window suspends the
 * timeline that would advance it. See the call site.
 */
export async function freezeFieldFade(app: App): Promise<void> {
  // card-dom: shell — in every page that draws this deck's chrome.
  for (const page of chromePages(app)) await page.evalJS<null>(
    `(function () {
       var st = document.createElement("style");
       st.id = "at0628-no-fade";
       st.textContent = ".tug-pane-grab-dots { transition: none !important; }";
       document.head.appendChild(st);
       return null;
     })()`,
  );
}

/** Take the forcing fixture back off, so a later step reads the real cascade. */
export async function unforceFieldVisible(app: App): Promise<void> {
  // card-dom: shell — in every page that draws this deck's chrome.
  for (const page of chromePages(app)) await page.evalJS<null>(
    `(function () {
       var st = document.getElementById("at0628-force");
       if (st !== null && st.parentNode !== null) st.parentNode.removeChild(st);
       return null;
     })()`,
  );
}

/** Every claim that holds wherever the field is drawn. */
export function expectTheField(what: string, line: Line | null): void {
  expect(line, `${what}: the surface is mounted`).not.toBeNull();
  if (line === null) return;
  expect(line.present, `${what}: the field is drawn`).toBe(true);
  expect(line.blockSize, `${what}: the block-size is derived, not stated`).toBe(
    FIELD_BLOCK_SIZE,
  );
  expect(
    line.mask.startsWith("repeating-linear-gradient"),
    `${what}: a masked solid, never a tiled background`,
  ).toBe(true);
  expect(line.composite, `${what}: two crossed gradients, intersected`).toBe("intersect");
  // The FIELD takes no pointer events: the HANDLE around it is what the press
  // lands on, and paint intercepting its own parent's `pointerdown` is the one
  // unambiguous failure here.
  expect(line.pointerEvents, `${what}: the paint never takes the press`).toBe("none");
  // And the handle says so before the press, which is the whole reason the dots
  // are a real element: a pseudo takes no `cursor` of its own.
  expect(line.handleCursor, `${what}: the handle says grab`).toBe("grab");
  expect(line.opacity, `${what}: nothing at rest`).toBe("0");
}

export const DECK = {
  cards: [
    { id: "A", componentId: "session", title: "Session A", closable: true },
    { id: "B", componentId: "text", title: "File", closable: true },
    { id: "U", componentId: "gallery-accordion", title: "Utility", closable: true },
    { id: "L", componentId: "cards", title: "Cards", closable: true },
  ],
  panes: [
    {
      id: "p1",
      position: { x: 40, y: 40 },
      size: { width: 640, height: 420 },
      cardIds: ["A"],
      activeCardId: "A",
      title: "",
      acceptsFamilies: ["standard"],
      slot: 0,
    },
    {
      id: "p2",
      position: { x: 80, y: 40 },
      size: { width: 640, height: 420 },
      cardIds: ["B"],
      activeCardId: "B",
      title: "",
      acceptsFamilies: ["standard"],
      slot: 1,
    },
    {
      id: "p3",
      position: { x: 40, y: 500 },
      size: { width: 640, height: 300 },
      cardIds: ["U"],
      activeCardId: "U",
      title: "",
      acceptsFamilies: ["maker"],
      slot: 2,
    },
    {
      id: "pCards",
      position: { x: 0, y: 0 },
      size: { width: 400, height: 900 },
      cardIds: ["L"],
      activeCardId: "L",
      title: "cards",
      acceptsFamilies: [],
    },
  ],
  activePaneId: "p1",
  imposition: {
    kind: "three-up",
    sidebars: { cards: { side: "right" } },
    rails: { right: { mode: "split", order: ["cards"] } },
  },
  hasFocus: true,
};

/** The utility tier's bar, in the utility card's own page. */
export const UTILITY_BAR = ".body-chrome-frame .tug-pane-title-bar";
/**
 * The document tier's bar, in the Text card's own page: a content bar this
 * deck leaves unoccluded, so a drag from it is the card's to begin.
 */
export const DOC_BAR = ".body-chrome-frame .tug-pane-title-bar";
/** The Cards rail's bar, in its own page. */
export const RAIL_BAR = ".body-chrome-frame .tug-pane-title-bar";

/** Where `--tugx-pane-dot-ink` resolves across the two content panes. */
export interface InkReading {
  /** Elements other than a field that resolve the ink — `"<pane> <class>"`. */
  holders: string[];
  /** Each pane's fields, and the ink each resolves. */
  fields: Record<string, string[]>;
  /** How many elements were read, so an empty pane cannot pass vacuously. */
  count: number;
}
