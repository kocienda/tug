/**
 * at0628-grab-dot-field.test.ts — the drag affordance on a content card's
 * title bar, and its absence from a rail.
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
 * gesture's duration, and the reading below proves the pin is what is doing it:
 * mid-drag the attribute is absent and the field is up regardless.
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
 * same.
 *
 * @covers tugdeck/src/components/tugways/tug-pane.css
 * @covers tugdeck/src/components/tugways/session-masthead.css
 * @covers tugdeck/src/components/tugways/card-masthead.css
 * @covers tugdeck/src/components/tugways/commit-masthead.css
 * @covers tugdeck/src/components/chrome/tug-pane.tsx
 * @covers tugdeck/src/components/tugways/tug-session-row.tsx
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { launchTugApp, note, type App } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

/** The worktree root — the real repo tugcast serves as its bootstrap tree. */
const REPO = resolve(import.meta.dir, "..", "..");

/** The settle window, with room for the imposition's landing tween. */
const AFTER_LAND_MS = 900;

/**
 * The derived block-size at the shipped setting: three rows, 4px pitch, 1px
 * dot. Written as the arithmetic rather than as `"9px"` so that a deliberate
 * retune of the pitch or the row count reads here as the one number it moves,
 * and an accidental restatement of the height still fails.
 */
const ROWS = 3;
const PITCH = 4;
const DOT = 1;
const FIELD_BLOCK_SIZE = `${(ROWS - 1) * PITCH + DOT}px`;

/**
 * The handle's FLOOR — the run the field keeps however long the title, so the
 * dots are always reserved. Counted in columns and derived the same way as the
 * block-size: eight columns on a 4px pitch is 29px.
 */
const MIN_COLUMNS = 8;
const FIELD_MIN_INLINE = (MIN_COLUMNS - 1) * PITCH + DOT;

/** The rail's trailing stripe band — three 1px lines on a 3px pitch. */
const STRIPE_BLOCK_SIZE = "7px";

const SESSION_FRAME = '[data-slot="session-masthead"]';
const DOC_FRAME = '[data-slot="card-masthead"]';
const COMMIT_CARD = '[data-slot="commit-card"]';

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/** What the field is, read off the browser rather than off the stylesheet. */
interface Field {
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

interface Line extends Field {
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

async function readLine(app: App, hostSel: string): Promise<Line | null> {
  return app.evalJS<Line | null>(`${READ}(${JSON.stringify(hostSel)})`);
}

/**
 * Read an element's own `::after`, for the one surface that still draws with
 * one: a RAIL's trailing racing-stripe band. "No field on a rail" is not "no
 * pseudo-element on a rail", so the stripes have to be read to be told apart
 * from the thing that replaced them elsewhere.
 */
async function readRailPseudo(
  app: App,
  hostSel: string,
): Promise<{ blockSize: string; mask: string; cursor: string } | null> {
  return app.evalJS<{ blockSize: string; mask: string; cursor: string } | null>(
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
 * Force the field up.
 *
 * The one property the trigger changes, and nothing else — so what is measured
 * afterwards differs from the rest state by exactly the field being painted.
 */
async function forceFieldVisible(app: App): Promise<void> {
  await app.evalJS<null>(
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
async function freezeFieldFade(app: App): Promise<void> {
  await app.evalJS<null>(
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
async function unforceFieldVisible(app: App): Promise<void> {
  await app.evalJS<null>(
    `(function () {
       var st = document.getElementById("at0628-force");
       if (st !== null && st.parentNode !== null) st.parentNode.removeChild(st);
       return null;
     })()`,
  );
}

/** Every claim that holds wherever the field is drawn. */
function expectTheField(what: string, line: Line | null): void {
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

const DECK = {
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

const UTILITY_BAR = '.tug-pane[data-pane-id="p3"] .tug-pane-title-bar';
/** The session tier's bar, the one content bar this deck leaves unoccluded. */
const SESSION_BAR = '.tug-pane[data-pane-id="p1"] .tug-pane-title-bar';
const RAIL_BAR = '.tug-pane[data-pane-id="pCards"] .tug-pane-title-bar';

describe.skipIf(!SHOULD_RUN)("at0628 — the grab-dot field", () => {
  test(
    "a content card wears it, at the derived geometry, and a rail does not",
    async () => {
      const app = await launchTugApp({ testName: "at0628-grab-dot-field" });
      try {
        await app.seedDeckState({ state: DECK, focusCardId: "A" });
        // An UNBOUND session card renders the project picker and wears no
        // masthead at all, so the session tier would never mount.
        await app.bindSession("A", {
          tugSessionId: "at0628-A",
          projectDir: "/tmp/at0628",
        });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SESSION_FRAME)}) !== null` +
            ` && document.querySelector(${JSON.stringify(DOC_FRAME)}) !== null` +
            ` && document.querySelector(${JSON.stringify(UTILITY_BAR)}) !== null` +
            ` && document.querySelector(${JSON.stringify(RAIL_BAR)}) !== null`,
          { timeoutMs: 15_000 },
        );
        await wait(AFTER_LAND_MS);

        // ---- 1. The utility tier: the field is a flex item in the bar itself.
        const utility = await readLine(app, UTILITY_BAR);
        note(`utility bar: ${JSON.stringify(utility)}`);
        expectTheField("the utility tier", utility);

        // The field FILLS the run, rather than halving it. `.tug-pane-title`
        // ships at `flex: 1` — basis 0, grow 1 — so a field at `flex: 1 1 0`
        // beside a title that kept its grow splits the free run evenly
        // whatever either needs, and a seven-letter name lands in a box two
        // hundred pixels wide. The grow moves to the field here for the same
        // reason it moves on the three masthead lead lines.
        expect(utility?.titleGrow, "the utility tier's grow moved to the field").toBe("0");

        // The close box still comes last. The handle is a real element mounted
        // BEFORE the controls, so its grow is what pushes them to the trailing
        // edge — no `order` needed, unlike the rail's `::after` stripe band,
        // which is last in document order and has to be reordered around.
        const barRun = await app.evalJS<Array<[string, number]>>(
          `(function () {
            var bar = document.querySelector(${JSON.stringify(UTILITY_BAR)});
            return Array.prototype.slice.call(bar.children).map(function (el) {
              return [el.className.split(" ")[0], Math.round(el.getBoundingClientRect().left)];
            });
          })()`,
        );
        note(`utility bar children: ${JSON.stringify(barRun)}`);
        const controls = barRun.find(([cls]) => cls === "tug-pane-title-bar-controls");
        expect(controls, "the bar has a control cluster").toBeDefined();
        if (controls !== undefined) {
          const others = barRun.filter(([cls]) => cls !== "tug-pane-title-bar-controls");
          for (const [cls, left] of others) {
            expect(left, `the controls come after ${cls}`).toBeLessThan(controls[1]);
          }
        }

        // ---- 2. The masthead tiers: the field is on the LEAD LINE, because
        // the bar's own run there belongs to the masthead frame.
        const session = await readLine(app, `${SESSION_FRAME} .tug-session-row-name-line`);
        const doc = await readLine(app, `${DOC_FRAME} .tug-session-row-name-line`);
        note(`session tier: ${JSON.stringify(session)}`);
        note(`document tier: ${JSON.stringify(doc)}`);
        expectTheField("the session tier", session);
        expectTheField("the document tier", doc);

        // The run between the title and the `…` was never a slot: it is slack
        // inside the title's own box, held by a `flex: 1 1 auto` title. So the
        // field can only fill it by taking the grow.
        expect(session?.titleGrow, "the session tier's grow moved to the field").toBe("0");
        expect(doc?.titleGrow, "the document tier's grow moved to the field").toBe("0");

        // The masthead BAR mounts no handle of its own — on that tier it lives on
        // the lead line, and a second copy on the bar would draw over the frame.
        // Read as a DIRECT child, because the lead line's handle is a descendant
        // of this bar and would otherwise answer for it.
        const mastheadBarOwn = await app.evalJS<number>(
          `document.querySelectorAll(
             '.tug-pane[data-pane-id="p1"] .tug-pane-title-bar > .tug-pane-grab-handle'
           ).length`,
        );
        expect(mastheadBarOwn, "the masthead's own bar mounts no handle").toBe(0);

        // ---- 2b. Only the handle drags. The bar used to carry `cursor: grab`
        // along its whole run, which is exactly the claim that is no longer
        // true: a press anywhere but the dots does not move a content card, so
        // nothing but the dots may say it does.
        const barCursors = await app.evalJS<Record<string, string>>(
          `(function () {
             function cur(sel) {
               var el = document.querySelector(sel);
               return el === null ? "" : getComputedStyle(el).cursor;
             }
             return {
               utilityBar: cur(${JSON.stringify(UTILITY_BAR)}),
               mastheadBar: cur('.tug-pane[data-pane-id="p1"] .tug-pane-title-bar'),
               railBar: cur(${JSON.stringify(RAIL_BAR)})
             };
           })()`,
        );
        note(`bar cursors: ${JSON.stringify(barCursors)}`);
        expect(barCursors.utilityBar, "a content bar no longer says grab").not.toBe("grab");
        expect(barCursors.mastheadBar, "nor does a masthead bar").not.toBe("grab");
        // The rail is the exception, and deliberately: it wears no handle, so its
        // whole bar is still its drag surface and still says so.
        expect(barCursors.railBar, "a rail's whole bar still says grab").toBe("grab");

        // ---- 3. The rail: its `::after` is still the racing stripes.
        const rail = await readRailPseudo(app, RAIL_BAR);
        note(`rail bar: ${JSON.stringify(rail)}`);
        expect(rail, "the rail is mounted").not.toBeNull();
        expect(rail?.blockSize, "the rail keeps its 7px stripe band").toBe(STRIPE_BLOCK_SIZE);
        expect(
          String(rail?.mask).startsWith("repeating-linear-gradient"),
          "and grows no stencil",
        ).toBe(false);

        // And no handle reached it either — the exclusion's first face.
        const railHandles = await app.evalJS<number>(
          `document.querySelectorAll(
             ${JSON.stringify(RAIL_BAR)} + ' .tug-pane-grab-handle'
           ).length`,
        );
        expect(railHandles, "a rail mounts no grab handle").toBe(0);

        // The other face of the exclusion: the Cards rail mounts the same
        // `TugSessionRow` the mastheads do, and neither half of the field
        // reached it.
        const cell = await app.evalJS<{ grow: string; handles: number } | null>(
          `(function () {
            var line = document.querySelector('.cards-row .tug-session-row-name-line');
            if (line === null) return null;
            var title = line.querySelector(".tug-list-row-title");
            return {
              grow: title === null ? "" : getComputedStyle(title).flexGrow,
              handles: line.querySelectorAll(".tug-pane-grab-handle").length
            };
          })()`,
        );
        note(`cards rail session cell: ${JSON.stringify(cell)}`);
        expect(cell, "the Cards rail lists the bound session").not.toBeNull();
        expect(cell?.handles, "a rail's session cell grows no handle").toBe(0);
        expect(cell?.grow, "and its title keeps its grow").toBe("1");

        // ---- 3b. THE POINTER LIGHTS IT, and a re-render does not put it out.
        //
        // The trigger is the bar's `data-pointer-within`, not `:hover`: the
        // pseudo-class is re-decided only when the physical cursor MOVES, so a
        // press in the masthead — which activates the card and re-renders the
        // bar beneath a pointer that has not moved — dropped the dots and left
        // them dropped until the hand jiggled the mouse. Reading the reveal
        // through the dispatched `pointerenter` is the guard: under `:hover`
        // this step is unreachable at all.
        const SESSION_LINE = `${SESSION_FRAME} .tug-session-row-name-line`;
        // The FADE is stood down first, and this is not cosmetic. The field
        // crosses to 1 over a 120ms `opacity` transition, and a transition is
        // driven by the document's animation timeline — which an OCCLUDED
        // harness window suspends along with `requestAnimationFrame`. Left on,
        // the computed value sits at the transition's start value for as long
        // as the window stays covered, and the reveal reads as a failure that
        // is really the compositor asleep. Stood down, the resolved value is
        // the cascade's own, which is what this step is about.
        await freezeFieldFade(app);
        await app.revealPaneControls('.tug-pane[data-pane-id="p1"]');
        await wait(200);
        const revealed = await readLine(app, SESSION_LINE);
        note(`pointer within the bar: opacity ${revealed?.opacity}`);
        expect(revealed?.opacity, "the pointer lights the field").toBe("1");

        // The activation the bug was reported from: a card focused under a
        // stationary pointer re-renders its bar, and the mark must still be up
        // afterwards. Focus is taken through the product's own door rather than
        // by a press, because a press in a background, non-key window does not
        // arrive as a `pointerdown` the page sees (see step 5).
        await app.evalJS<null>(
          `(function () { window.__tug.activateCard("B"); return null; })()`,
        );
        await wait(200);
        await app.evalJS<null>(
          `(function () { window.__tug.activateCard("A"); return null; })()`,
        );
        await wait(300);
        const afterActivate = await readLine(app, SESSION_LINE);
        note(`after re-activating the card: opacity ${afterActivate?.opacity}`);
        expect(
          afterActivate?.opacity,
          "and a re-render under a stationary pointer does not put it out",
        ).toBe("1");

        // Off the bar again, so the rest state the next step measures from is
        // the real one — and so the trigger is read in both directions.
        await app.concealPaneControls('.tug-pane[data-pane-id="p1"]');
        await wait(200);
        const concealed = await readLine(app, SESSION_LINE);
        expect(concealed?.opacity, "and leaving the bar puts it out").toBe("0");

        // ---- 4. The measure does not move when the field is drawn.
        await forceFieldVisible(app);
        await wait(300);

        const shownUtility = await readLine(app, UTILITY_BAR);
        const shownSession = await readLine(app, `${SESSION_FRAME} .tug-session-row-name-line`);
        const shownDoc = await readLine(app, `${DOC_FRAME} .tug-session-row-name-line`);
        note(
          `forced visible — utility ${shownUtility?.opacity}, session ${shownSession?.opacity}, doc ${shownDoc?.opacity}`,
        );

        // The fixture is only honest if it actually changed something.
        expect(shownSession?.opacity, "the field is up").toBe("1");

        for (const [what, before, after] of [
          ["the utility tier", utility, shownUtility],
          ["the session tier", session, shownSession],
          ["the document tier", doc, shownDoc],
        ] as Array<[string, Line | null, Line | null]>) {
          if (before === null || after === null) continue;
          expect(after.titleWidth, `${what}: the title's measure does not move`).toBe(
            before.titleWidth,
          );
          expect(after.titleRight, `${what}: nor its elision point`).toBe(before.titleRight);
        }

        // ---- 4b. THE FLOOR IS ALWAYS RESERVED. A title too long for its line
        // elides against the field's floor; it never squeezes the field away.
        // The title's content is forced wider than any line, which is the
        // longest name there could be, and every tier's handle must still hold
        // the floor, its field must still fill it, and it must still stop
        // short of the line's reserved trailing run.
        await app.evalJS<null>(
          `(function () {
             var st = document.createElement("style");
             st.id = "at0628-long-title";
             st.textContent =
               ".tug-list-row-title .tug-label-text > *, .tug-pane-title" +
               " { inline-size: 4000px !important; max-inline-size: none !important; }";
             document.head.appendChild(st);
             return null;
           })()`,
        );
        await wait(200);
        const floors = await app.evalJS<
          Array<{ what: string; handle: number; dots: number; overrun: number } | null>
        >(
          `(function (hosts) {
             return hosts.map(function (h) {
               var host = document.querySelector(h[1]);
               var handle = host === null ? null : host.querySelector(".tug-pane-grab-handle");
               if (handle === null) return null;
               var dots = handle.querySelector(".tug-pane-grab-dots");
               var hb = handle.getBoundingClientRect();
               var cs = getComputedStyle(host);
               var hostBox = host.getBoundingClientRect();
               var contentRight = hostBox.right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth);
               return {
                 what: h[0],
                 handle: +hb.width.toFixed(2),
                 dots: dots === null ? 0 : +dots.getBoundingClientRect().width.toFixed(2),
                 overrun: +(hb.right - contentRight).toFixed(2)
               };
             });
           })(${JSON.stringify([
             ["the utility tier", UTILITY_BAR],
             ["the session tier", `${SESSION_FRAME} .tug-session-row-name-line`],
             ["the document tier", `${DOC_FRAME} .tug-session-row-name-line`],
           ])})`,
        );
        note(`under a too-long title: ${JSON.stringify(floors)}`);
        for (const f of floors) {
          expect(f, "the handle is mounted under a long title").not.toBeNull();
          if (f === null) continue;
          expect(f.handle, `${f.what}: the handle keeps its floor`).toBeGreaterThanOrEqual(
            FIELD_MIN_INLINE - 0.5,
          );
          expect(f.dots, `${f.what}: and the field fills it`).toBeCloseTo(f.handle, 1);
          expect(f.overrun, `${f.what}: and it stops short of the reserve`).toBeLessThanOrEqual(
            0.5,
          );
        }
        await app.evalJS<null>(
          `(function () {
             var st = document.getElementById("at0628-long-title");
             if (st !== null && st.parentNode !== null) st.parentNode.removeChild(st);
             return null;
           })()`,
        );
        await wait(200);

        // ---- 5. Only the handle DRAGS, which is the claim the rest of this
        // file only describes.
        //
        // `data-gesture` on the FRAME is the observable: the drag writes it at
        // pointer-down, before any travel, so the attribute says whether the
        // gesture was allowed to begin rather than how far it got.
        //
        // A short DRAG rather than a bare press, and that is not a stylistic
        // choice: these tests run in a background, non-key window, where a
        // `nativeMouseDown` on its own never arrives as a `pointerdown` the page
        // sees. Travel is what delivers it, which is why every other drag in this
        // corpus reaches for `nativeDragWithoutRelease`. A synthetic `pointerdown`
        // is no use either — its made-up `pointerId` dies inside
        // `setPointerCapture` before proving anything about the gate above it.
        //
        // Driven against the SESSION pane rather than the utility one, and the
        // reason is the fixture rather than the feature: this deck imposes
        // three-up with the Cards rail on the right, so p3's title bar runs from
        // x≈1374 to the window's edge — behind the rail, whose own bar is still a
        // whole-bar drag surface. A press computed off p3's boxes lands on the
        // rail and starts the rail's gesture, which says nothing about this gate.
        // p1 stands clear at the left.
        //
        // Pressed a few pixels INSIDE the leading edge rather than at the centre,
        // because the handle runs out to the control cluster and its centre can
        // fall outside the webview's visible frame, which the native mouse refuses
        // rather than silently clicking the edge.
        // The forcing fixture comes off first: from here on the field's opacity
        // is read to learn what the CASCADE says, and an `!important` 1 would
        // answer for every rule under it.
        await unforceFieldVisible(app);
        await wait(120);

        /** The field's state, read while a gesture is in flight or after it. */
        const fieldNow = async (): Promise<{ opacity: string; within: boolean }> =>
          app.evalJS<{ opacity: string; within: boolean }>(
            `(function () {
               var bar = document.querySelector('.tug-pane[data-pane-id="p1"] [data-testid="tug-pane-title-bar"]');
               var dots = document.querySelector(
                 '.tug-pane[data-pane-id="p1"] .tug-pane-grab-dots'
               );
               return {
                 opacity: dots === null ? "" : getComputedStyle(dots).opacity,
                 within: bar !== null && bar.hasAttribute("data-pointer-within")
               };
             })()`,
          );

        interface Gesture {
          /** Which panes wore `data-gesture`, mid-flight. */
          held: string | null;
          /** The field, mid-flight. */
          mid: { opacity: string; within: boolean };
          /** The field, once the gesture has landed and the button is up. */
          after: { opacity: string; within: boolean };
        }

        const gestureAfterDragFrom = async (sel: string): Promise<Gesture> => {
          const at = await app.evalJS<{ x: number; y: number } | null>(
            `(function (s) {
               var el = document.querySelector(s);
               if (el === null) return null;
               var b = el.getBoundingClientRect();
               return { x: b.left + Math.min(6, b.width / 2), y: b.top + b.height / 2 };
             })(${JSON.stringify(sel)})`,
          );
          expect(at, `${sel} is on screen to be pressed`).not.toBeNull();
          if (at === null) throw new Error(`${sel} is not on screen`);
          const to = { x: at.x + 24, y: at.y };
          const under = await app.evalJS<string>(
            `(function (x, y) {
               var el = document.elementFromPoint(x, y);
               if (el === null) return "(nothing)";
               var chain = [];
               for (var n = el; n !== null && chain.length < 5; n = n.parentElement) {
                 chain.push(String(n.className || n.tagName).split(" ")[0]);
               }
               return chain.join(" < ");
             })(${at.x}, ${at.y})`,
          );
          note(`press point ${at.x.toFixed(0)},${at.y.toFixed(0)} hits: ${under}`);
          await app.nativeDragWithoutRelease(at, to);
          await wait(120);
          const held = await app.evalJS<string | null>(
            `(function () {
               var all = document.querySelectorAll(".tug-pane[data-gesture]");
               if (all.length === 0) return null;
               return Array.prototype.map.call(all, function (p) {
                 return p.getAttribute("data-pane-id") + "=" + p.getAttribute("data-gesture");
               }).join(",");
             })()`,
          );
          const mid = await fieldNow();
          note(`mid-gesture from ${sel}: ${JSON.stringify(mid)}`);
          await app.nativeMouseUp(to);
          await wait(400);
          const after = await fieldNow();
          note(`after release from ${sel}: ${JSON.stringify(after)}`);
          return { held, mid, after };
        };

        // The TITLE, a few pixels from the dots and squarely on the bar: the old
        // behaviour would have taken this press and moved the card.
        const onTitle = await gestureAfterDragFrom(`${SESSION_BAR} .tug-list-row-title`);
        note(`drag from the title: data-gesture=${JSON.stringify(onTitle.held)}`);
        expect(onTitle.held, "a drag from the title never begins").toBeNull();

        // The HANDLE: the one surface that does.
        const onHandle = await gestureAfterDragFrom(`${SESSION_BAR} .tug-pane-grab-handle`);
        note(`drag from the handle: data-gesture=${JSON.stringify(onHandle.held)}`);
        expect(onHandle.held, "a drag from the handle does").toBe("p1=true");

        // ---- 6. THE MARK THE HAND IS HOLDING STAYS LIT.
        //
        // A press on the handle takes POINTER CAPTURE on the frame, and capture
        // retargets the pointer's whole stream — so the bar's own
        // `pointerleave` fires as the capture is taken and no `pointerenter`
        // follows while the gesture runs. The reading below is the proof, and it
        // is why the pin is a second rule rather than a wider trigger: the
        // attribute the trigger reads is GONE mid-drag, and the field is up
        // anyway, off the frame's `data-gesture`.
        expect(onHandle.mid.within, "capture takes the bar's pointer-within away").toBe(
          false,
        );
        expect(onHandle.mid.opacity, "and the dots stay lit through the drag").toBe("1");

        // And the release hands the trigger back: the pointer is still on the
        // bar it was dragging, so the field stays up as the pin lets go rather
        // than blinking out at the drop.
        expect(onHandle.after.within, "the release restores pointer-within").toBe(true);
        expect(onHandle.after.opacity, "and the dots do not blink out at the drop").toBe(
          "1",
        );
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a commit card is content, so its masthead wears the field too",
    async () => {
      const sha = Bun.spawnSync(["git", "-C", REPO, "show", "-s", "--format=%H", "HEAD"])
        .stdout.toString()
        .trim();

      const tugbankPath = mkTempTugbank();
      try {
        seedTugbankForLaunch(tugbankPath, { sourceTreePath: REPO });
        const app = await launchTugApp({
          testName: "at0628-grab-dot-field-commit",
          env: { TUGBANK_PATH: tugbankPath },
          persistInTestMode: true,
        });
        try {
          await app.waitForCondition<boolean>(`typeof window.__tug !== "undefined"`, {
            timeoutMs: 15_000,
          });
          await app.seedDeckState({
            state: {
              cards: [{ id: "C", componentId: "commit", title: "Commit", closable: true }],
              panes: [
                {
                  id: "pC",
                  position: { x: 40, y: 40 },
                  size: { width: 720, height: 640 },
                  cardIds: ["C"],
                  activeCardId: "C",
                  title: "",
                  acceptsFamilies: ["maker"],
                },
              ],
              activePaneId: "pC",
              hasFocus: true,
            },
            cardStates: {
              C: { content: { target: { root: REPO, sha: sha.slice(0, 8) } } },
            },
            focusCardId: "C",
          });
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(COMMIT_CARD)}) !== null` +
              ` && document.querySelector('.commit-masthead-row .tug-session-row-name-line') !== null`,
            { timeoutMs: 15_000 },
          );
          await wait(AFTER_LAND_MS);

          const commit = await readLine(
            app,
            ".commit-masthead-row .tug-session-row-name-line",
          );
          note(`commit tier: ${JSON.stringify(commit)}`);

          // A commit card is CONTENT: the exclusion is a rail's, and a commit
          // card is dragged by its bar like any other document.
          expectTheField("the commit tier", commit);
          expect(commit?.titleGrow, "the commit tier's grow moved to the field").toBe("0");
        } finally {
          await app.close();
        }
      } finally {
        rmTempTugbank(tugbankPath);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the ink is the field's own, so a focus flip restyles nothing else in the pane",
    async () => {
      const app = await launchTugApp({ testName: "at0628-grab-dot-ink" });
      try {
        await app.seedDeckState({ state: DECK, focusCardId: "A" });
        await app.bindSession("A", {
          tugSessionId: "at0628-ink-A",
          projectDir: "/tmp/at0628",
        });
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SESSION_FRAME)}) !== null` +
            ` && document.querySelector(${JSON.stringify(DOC_FRAME)}) !== null` +
            ` && document.querySelector('.tug-pane[data-pane-id="p1"]')` +
            `.getAttribute("data-focused") === "true"`,
          { timeoutMs: 15_000 },
        );
        await wait(AFTER_LAND_MS);

        // Every element of the two content panes, the pane included, and what
        // each resolves `--tugx-pane-dot-ink` to. Read off the browser, so a
        // declaration anywhere above the field — on the pane, the bar, a
        // masthead frame — shows up as an element that resolves it.
        const read = (): Promise<InkReading> =>
          app.evalJS<InkReading>(
            `(function () {
              var out = { holders: [], fields: {}, count: 0 };
              ["p1", "p2"].forEach(function (id) {
                var pane = document.querySelector('.tug-pane[data-pane-id="' + id + '"]');
                if (pane === null) return;
                var els = [pane].concat(Array.prototype.slice.call(pane.querySelectorAll("*")));
                out.count += els.length;
                els.forEach(function (el) {
                  var ink = getComputedStyle(el).getPropertyValue("--tugx-pane-dot-ink").trim();
                  if (el.classList.contains("tug-pane-grab-dots")) {
                    (out.fields[id] = out.fields[id] || []).push(ink);
                  } else if (ink !== "") {
                    out.holders.push(id + " " + String(el.className || el.tagName).split(" ")[0]);
                  }
                });
              });
              return out;
            })()`,
          );

        const before = await read();
        note(
          `focus on A: ${before.count} elements, holders ${JSON.stringify(before.holders.slice(0, 5))}, fields ${JSON.stringify(before.fields)}`,
        );
        expect(before.count, "the panes are populated").toBeGreaterThan(50);
        // The ink resolves on the field and nowhere else. An element that
        // resolves it is one whose style a focus flip would change.
        expect(before.holders, "no element but a field holds the ink").toEqual([]);
        expect(before.fields.p1?.length ?? 0, "the focused pane has a field").toBeGreaterThan(0);
        expect(before.fields.p2?.length ?? 0, "the unfocused pane has a field").toBeGreaterThan(0);
        const focusedInk = before.fields.p1[0];
        const recededInk = before.fields.p2[0];
        expect(focusedInk, "the focused field is inked").not.toBe("");
        expect(recededInk, "the receded field is inked").not.toBe("");
        expect(recededInk, "the ink follows the pane's focus").not.toBe(focusedInk);

        // The flip, through the product's own door.
        await app.evalJS<null>(
          `(function () { window.__tug.activateCard("B"); return null; })()`,
        );
        await app.waitForCondition<boolean>(
          `document.querySelector('.tug-pane[data-pane-id="p2"]')` +
            `.getAttribute("data-focused") === "true"`,
          { timeoutMs: 5_000 },
        );
        await wait(300);

        const after = await read();
        note(`focus on B: fields ${JSON.stringify(after.fields)}`);
        expect(after.holders, "still no element but a field holds the ink").toEqual([]);
        // The dots look the same: each field took the other's ink.
        for (const ink of after.fields.p1 ?? []) {
          expect(ink, "the pane that lost focus wears the receded ink").toBe(recededInk);
        }
        for (const ink of after.fields.p2 ?? []) {
          expect(ink, "the pane that took focus wears the focused ink").toBe(focusedInk);
        }
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});

/** Where `--tugx-pane-dot-ink` resolves across the two content panes. */
interface InkReading {
  /** Elements other than a field that resolve the ink — `"<pane> <class>"`. */
  holders: string[];
  /** Each pane's fields, and the ink each resolves. */
  fields: Record<string, string[]>;
  /** How many elements were read, so an empty pane cannot pass vacuously. */
  count: number;
}
