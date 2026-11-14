/**
 * at0628-grab-dot-field-content.test.ts — a content card wears the grab-dot
 * field, at the derived geometry, and a rail does not.
 *
 * One of the at0628-grab-dot-field split, a test to a file so each launch
 * fits its own budget. Why the field is drawn the way it is, the deck, the
 * readers and the fixtures are `grab-dot-field-fixture.ts`.
 *
 * @covers tugdeck/src/components/tugways/tug-pane.css
 * @covers tugdeck/src/components/tugways/session-masthead.css
 * @covers tugdeck/src/components/tugways/card-masthead.css
 * @covers tugdeck/src/components/tugways/commit-masthead.css
 * @covers tugdeck/src/components/chrome/tug-pane.tsx
 * @covers tugdeck/src/components/tugways/tug-session-row.tsx
 * @family at0628-grab-dot-field
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";
import {
  AFTER_LAND_MS,
  DECK,
  DOC_BAR,
  DOC_FRAME,
  FIELD_MIN_INLINE,
  RAIL_BAR,
  SESSION_FRAME,
  SESSION_PANE,
  SHOULD_RUN,
  STRIPE_BLOCK_SIZE,
  TEST_TIMEOUT_MS,
  UTILITY_BAR,
  chromePages,
  expectTheField,
  forceFieldVisible,
  freezeFieldFade,
  readLine,
  readRailPseudo,
  unforceFieldVisible,
  wait,
  type Line,
} from "./grab-dot-field-fixture";

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
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(SESSION_FRAME)}) !== null`,
          { timeoutMs: 15_000 },
        );
        await app.body("U").waitForCondition<boolean>(`document.querySelector(${JSON.stringify(UTILITY_BAR)}) !== null`, {
          timeoutMs: 15_000,
        });
        await app.body("B").waitForCondition<boolean>(`document.querySelector(${JSON.stringify(DOC_FRAME)}) !== null`, {
          timeoutMs: 15_000,
        });
        await app.body("L").waitForCondition<boolean>(`document.querySelector(${JSON.stringify(RAIL_BAR)}) !== null`, {
          timeoutMs: 15_000,
        });
        await wait(AFTER_LAND_MS);

        // ---- 1. The utility tier: the field is a flex item in the bar itself.
        const utility = await readLine(app.body("U"), UTILITY_BAR);
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
        const barRun = await app.body("U").evalJS<Array<[string, number]>>(
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
        const session = await readLine(app.body("A"), `${SESSION_FRAME} .tug-session-row-name-line`);
        const doc = await readLine(app.body("B"), `${DOC_FRAME} .tug-session-row-name-line`);
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
        const mastheadBarOwn = await app.body("A").evalJS<number>(
          `document.querySelectorAll(
             '${SESSION_PANE} .tug-pane-title-bar > .tug-pane-grab-handle'
           ).length`,
        );
        expect(mastheadBarOwn, "the masthead's own bar mounts no handle").toBe(0);

        // ---- 2b. Only the handle drags. The bar used to carry `cursor: grab`
        // along its whole run, which is exactly the claim that is no longer
        // true: a press anywhere but the dots does not move a content card, so
        // nothing but the dots may say it does.
        const cursorOf = (sel: string): string =>
          `(function () { var el = document.querySelector(${JSON.stringify(sel)}); return el === null ? "" : getComputedStyle(el).cursor; })()`;
        const barCursors: Record<string, string> = {
          utilityBar: await app.body("U").evalJS<string>(cursorOf(UTILITY_BAR)),
          railBar: await app.body("L").evalJS<string>(cursorOf(RAIL_BAR)),
        };
        barCursors.mastheadBar = await app.body("A").evalJS<string>(
          `(function () { var el = document.querySelector('${SESSION_PANE} .tug-pane-title-bar'); return el === null ? "" : getComputedStyle(el).cursor; })()`,
        );
        note(`bar cursors: ${JSON.stringify(barCursors)}`);
        expect(barCursors.utilityBar, "a content bar no longer says grab").not.toBe("grab");
        expect(barCursors.mastheadBar, "nor does a masthead bar").not.toBe("grab");
        // The rail is the exception, and deliberately: it wears no handle, so its
        // whole bar is still its drag surface and still says so.
        expect(barCursors.railBar, "a rail's whole bar still says grab").toBe("grab");

        // ---- 3. The rail: its `::after` is still the racing stripes.
        const rail = await readRailPseudo(app.body("L"), RAIL_BAR);
        note(`rail bar: ${JSON.stringify(rail)}`);
        expect(rail, "the rail is mounted").not.toBeNull();
        expect(rail?.blockSize, "the rail keeps its 7px stripe band").toBe(STRIPE_BLOCK_SIZE);
        expect(
          String(rail?.mask).startsWith("repeating-linear-gradient"),
          "and grows no stencil",
        ).toBe(false);

        // And no handle reached it either — the exclusion's first face.
        const railHandles = await app.body("L").evalJS<number>(
          `document.querySelectorAll(
             ${JSON.stringify(RAIL_BAR)} + ' .tug-pane-grab-handle'
           ).length`,
        );
        expect(railHandles, "a rail mounts no grab handle").toBe(0);

        // The other face of the exclusion: the Cards rail mounts the same
        // `TugSessionRow` the mastheads do, and neither half of the field
        // reached it. The row is in the Cards card's own body.
        const cell = await app.body("L").evalJS<{ grow: string; handles: number } | null>(
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
        await app.body("A").revealPaneControls(SESSION_PANE);
        await wait(200);
        const revealed = await readLine(app.body("A"), SESSION_LINE);
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
        const afterActivate = await readLine(app.body("A"), SESSION_LINE);
        note(`after re-activating the card: opacity ${afterActivate?.opacity}`);
        expect(
          afterActivate?.opacity,
          "and a re-render under a stationary pointer does not put it out",
        ).toBe("1");

        // Off the bar again, so the rest state the next step measures from is
        // the real one — and so the trigger is read in both directions.
        await app.body("A").concealPaneControls(SESSION_PANE);
        await wait(200);
        const concealed = await readLine(app.body("A"), SESSION_LINE);
        expect(concealed?.opacity, "and leaving the bar puts it out").toBe("0");

        // ---- 4. The measure does not move when the field is drawn.
        await forceFieldVisible(app);
        await wait(300);

        const shownUtility = await readLine(app.body("U"), UTILITY_BAR);
        const shownSession = await readLine(app.body("A"), `${SESSION_FRAME} .tug-session-row-name-line`);
        const shownDoc = await readLine(app.body("B"), `${DOC_FRAME} .tug-session-row-name-line`);
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
        // card-dom: shell — in every page that draws this deck's chrome.
        for (const page of chromePages(app)) await page.evalJS<null>(
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
        type Floor = { what: string; handle: number; dots: number; overrun: number } | null;
        const floorsIn = (page: Pick<App, "evalJS">, hosts: Array<[string, string]>): Promise<Floor[]> =>
          page.evalJS<Floor[]>(
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
           })(${JSON.stringify(hosts)})`,
          );
        const floors = [
          ...(await floorsIn(app.body("U"), [["the utility tier", UTILITY_BAR]])),
          ...(await floorsIn(app.body("B"), [["the document tier", `${DOC_FRAME} .tug-session-row-name-line`]])),
          ...(await floorsIn(app.body("A"), [["the session tier", `${SESSION_FRAME} .tug-session-row-name-line`]])),
        ];
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
        // card-dom: shell — in every page that draws this deck's chrome.
        for (const page of chromePages(app)) await page.evalJS<null>(
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
        // The Text card draws its chrome in its own page, and the host carries
        // its view while the hand holds it: the observable is the view's
        // presented frame standing off its placed one mid-drag, which says
        // whether the gesture was allowed to begin. The press and the travel
        // are the window's, at the page's points through the view's origin.
        //
        // A short DRAG rather than a bare press, and that is not a stylistic
        // choice: these tests run in a background, non-key window, where a
        // `nativeMouseDown` on its own never arrives as a `pointerdown` the page
        // sees. Travel is what delivers it, which is why every other drag in this
        // corpus reaches for `nativeDragWithoutRelease`. A synthetic `pointerdown`
        // is no use either — its made-up `pointerId` dies inside
        // `setPointerCapture` before proving anything about the gate above it.
        //
        // Driven against the DOCUMENT pane rather than the utility one, and the
        // reason is the fixture rather than the feature: this deck imposes
        // three-up with the Cards rail on the right, so p3's title bar runs from
        // x≈1374 to the window's edge — behind the rail, whose own bar is still a
        // whole-bar drag surface. A press computed off p3's boxes lands on the
        // rail and starts the rail's gesture, which says nothing about this gate.
        // p2 stands clear in the middle.
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
        const fieldNow = async (): Promise<{ opacity: string; within: boolean; gesture: string | null }> =>
          app.body("B").evalJS<{ opacity: string; within: boolean; gesture: string | null }>(
            `(function () {
               var bar = document.querySelector('.body-chrome-frame [data-testid="tug-pane-title-bar"]');
               var dots = document.querySelector('.body-chrome-frame .tug-pane-grab-dots');
               var frame = document.querySelector('.body-chrome-frame');
               return {
                 opacity: dots === null ? "" : getComputedStyle(dots).opacity,
                 within: bar !== null && bar.hasAttribute("data-pointer-within"),
                 gesture: frame === null ? null : frame.getAttribute("data-gesture")
               };
             })()`,
          );

        interface Gesture {
          /** `"carried"` when the host held the card's view off its place mid-flight, else null. */
          held: string | null;
          /** The field, mid-flight. */
          mid: { opacity: string; within: boolean; gesture: string | null };
          /** The field, once the gesture has landed and the button is up. */
          after: { opacity: string; within: boolean; gesture: string | null };
        }

        const gestureAfterDragFrom = async (sel: string): Promise<Gesture> => {
          const view = (await app.bodies()).find((b) => b.cardId === "B")!;
          const inPage = await app.body("B").evalJS<{ x: number; y: number } | null>(
            `(function (s) {
               var el = document.querySelector(s);
               if (el === null) return null;
               var b = el.getBoundingClientRect();
               return { x: b.left + Math.min(6, b.width / 2), y: b.top + b.height / 2 };
             })(${JSON.stringify(sel)})`,
          );
          expect(inPage, `${sel} is on screen to be pressed`).not.toBeNull();
          if (inPage === null) throw new Error(`${sel} is not on screen`);
          const at = { x: view.frame.x + inPage.x, y: view.frame.y + inPage.y };
          const to = { x: at.x + 24, y: at.y };
          const under = await app.body("B").evalJS<string>(
            `(function (x, y) {
               var el = document.elementFromPoint(x, y);
               if (el === null) return "(nothing)";
               var chain = [];
               for (var n = el; n !== null && chain.length < 5; n = n.parentElement) {
                 chain.push(String(n.className || n.tagName).split(" ")[0]);
               }
               return chain.join(" < ");
             })(${inPage.x}, ${inPage.y})`,
          );
          note(`press point ${at.x.toFixed(0)},${at.y.toFixed(0)} hits: ${under}`);
          await app.nativeDragWithoutRelease(at, to);
          await wait(120);
          const carried = (await app.bodies()).find((b) => b.cardId === "B")!;
          const held = carried.presentedFrame.x !== carried.frame.x || carried.presentedFrame.y !== carried.frame.y ? "carried" : null;
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
        const onTitle = await gestureAfterDragFrom(`${DOC_BAR} .tug-list-row-title`);
        note(`drag from the title: ${JSON.stringify(onTitle.held)}`);
        expect(onTitle.held, "a drag from the title never begins").toBeNull();

        // The HANDLE: the one surface that does.
        const onHandle = await gestureAfterDragFrom(`${DOC_BAR} .tug-pane-grab-handle`);
        note(`drag from the handle: ${JSON.stringify(onHandle.held)}`);
        expect(onHandle.held, "a drag from the handle does").toBe("carried");

        // ---- 6. THE MARK THE HAND IS HOLDING STAYS LIT.
        //
        // The view travels under the hand while the host carries it, so the
        // bar's own trigger flickers off at every step; the frame's
        // `data-gesture`, written at the press, is what holds the dots lit.
        expect(onHandle.mid.opacity, "the dots stay lit through the drag").toBe("1");

        // And the drop does not put them out: the pin holds until the page
        // hears the hand again, and the bar's own trigger answers from there.
        expect(onHandle.after.opacity, "the dots do not blink out at the drop").toBe(
          "1",
        );
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
