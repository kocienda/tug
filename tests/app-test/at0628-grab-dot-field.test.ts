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
 * ── Why the pointer never appears below ──
 * The trigger is a real `:hover` pseudo-class, which WebKit decides by
 * hit-testing against the PHYSICAL cursor. A background app-test has no
 * business moving that cursor and, in a non-key window, could not usefully move
 * it anyway — which is why the harness's `revealPaneControls` dispatches
 * `pointerenter` instead, and why that door does nothing for a pseudo-class.
 *
 * It does not matter here, and that is the third claim restated: everything
 * about the field except its opacity is true at rest. So the geometry is read
 * at rest, and the measure claim is proven by forcing the one property the
 * trigger changes and re-measuring the title — which is a stricter reading than
 * a hover would give, because it isolates the field's paint from every other
 * thing a pointer entering a card would also do.
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
 * @covers tugdeck/src/components/tugways/tug-pane.css
 * @covers tugdeck/src/components/tugways/session-masthead.css
 * @covers tugdeck/src/components/tugways/card-masthead.css
 * @covers tugdeck/src/components/tugways/commit-masthead.css
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

/** The rail's trailing stripe band — three 1px lines on a 3px pitch. */
const STRIPE_BLOCK_SIZE = "7px";

const SESSION_FRAME = '[data-slot="session-masthead"]';
const DOC_FRAME = '[data-slot="card-masthead"]';
const COMMIT_CARD = '[data-slot="commit-card"]';

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/** What a `::after` is, read off the browser rather than off the stylesheet. */
interface Pseudo {
  content: string;
  blockSize: string;
  /** Truncated: only whether the stencil is there, never its whole text. */
  mask: string;
  composite: string;
  opacity: string;
  pointerEvents: string;
}

interface Line extends Pseudo {
  /** The title's grow — 1 where the title holds the run, 0 where the field does. */
  titleGrow: string | null;
  /** The title's box, for the measure claim. */
  titleWidth: number | null;
  titleRight: number | null;
}

/**
 * Read one `::after` and the title beside it.
 *
 * `hostSel` is the element carrying the pseudo — a title bar on the utility
 * tier, a masthead's lead line on the three masthead tiers.
 */
const READ = `(function (hostSel) {
  var host = document.querySelector(hostSel);
  if (host === null) return null;
  var s = getComputedStyle(host, "::after");
  var title = host.querySelector(".tug-list-row-title") || host.querySelector(".tug-pane-title");
  var r = title === null ? null : title.getBoundingClientRect();
  return {
    content: s.content,
    blockSize: s.blockSize,
    mask: String(s.maskImage).slice(0, 26),
    composite: s.maskComposite,
    opacity: s.opacity,
    pointerEvents: s.pointerEvents,
    titleGrow: title === null ? null : getComputedStyle(title).flexGrow,
    titleWidth: r === null ? null : +r.width.toFixed(2),
    titleRight: r === null ? null : +r.right.toFixed(2)
  };
})`;

async function readLine(app: App, hostSel: string): Promise<Line | null> {
  return app.evalJS<Line | null>(`${READ}(${JSON.stringify(hostSel)})`);
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
         '.tug-pane-title-bar:not([data-role="sidebar"])::after,' +
         '.tug-pane-title-bar:not([data-role="sidebar"]) .tug-session-row-name-line::after' +
         ' { opacity: 1 !important; }';
       document.head.appendChild(st);
       return null;
     })()`,
  );
}

/** Every claim that holds wherever the field is drawn. */
function expectTheField(what: string, line: Line | null): void {
  expect(line, `${what}: the surface is mounted`).not.toBeNull();
  if (line === null) return;
  expect(line.content, `${what}: the field is drawn`).not.toBe("none");
  expect(line.blockSize, `${what}: the block-size is derived, not stated`).toBe(
    FIELD_BLOCK_SIZE,
  );
  expect(
    line.mask.startsWith("repeating-linear-gradient"),
    `${what}: a masked solid, never a tiled background`,
  ).toBe(true);
  expect(line.composite, `${what}: two crossed gradients, intersected`).toBe("intersect");
  expect(line.pointerEvents, `${what}: the band under it is the drag surface`).toBe("none");
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

        // The close box still comes last. `::after` is the LAST item in
        // document order, so without `order: 1` on the controls the field
        // would lay out past the close box rather than before it — which is
        // the same adjustment the rail's own stripe rule makes.
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

        // The masthead BAR takes no field — on that tier it lives on the lead
        // line, and a second copy on the bar would draw over the frame.
        const mastheadBar = await readLine(
          app,
          '.tug-pane[data-pane-id="p1"] .tug-pane-title-bar',
        );
        expect(mastheadBar?.content, "the masthead's own bar draws no field").toBe("none");

        // ---- 3. The rail: its `::after` is still the racing stripes.
        const rail = await readLine(app, RAIL_BAR);
        note(`rail bar: ${JSON.stringify(rail)}`);
        expect(rail, "the rail is mounted").not.toBeNull();
        expect(rail?.blockSize, "the rail keeps its 7px stripe band").toBe(STRIPE_BLOCK_SIZE);
        expect(
          String(rail?.mask).startsWith("repeating-linear-gradient"),
          "and grows no stencil",
        ).toBe(false);

        // The other face of the exclusion: the Cards rail mounts the same
        // `TugSessionRow` the mastheads do, and neither half of the field
        // reached it.
        const cell = await app.evalJS<{ grow: string; content: string } | null>(
          `(function () {
            var line = document.querySelector('.cards-row .tug-session-row-name-line');
            if (line === null) return null;
            var title = line.querySelector(".tug-list-row-title");
            return {
              grow: title === null ? "" : getComputedStyle(title).flexGrow,
              content: getComputedStyle(line, "::after").content
            };
          })()`,
        );
        note(`cards rail session cell: ${JSON.stringify(cell)}`);
        expect(cell, "the Cards rail lists the bound session").not.toBeNull();
        expect(cell?.content, "a rail's session cell grows no field").toBe("none");
        expect(cell?.grow, "and its title keeps its grow").toBe("1");

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
});
