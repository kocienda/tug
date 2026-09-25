/**
 * at0626-context-menu-scroll-referent.test.ts — a context menu lives as long
 * as the thing it is about is visible, and no longer.
 *
 * ## What this gates
 *
 * A right-click on a path in a Session card transcript opened the editor
 * context menu at the click point, and the menu positioned itself once and
 * never again. Scrolling the transcript slid the path out from under it while
 * the menu stayed put, leaving a list of verbs — Copy Path, Open in Editor —
 * armed against something no longer on screen.
 *
 * Three behaviors were on the table and the middle one is the rule. The menu
 * is never *chased*: a per-frame reposition would move it under a still
 * pointer and change the hovered item. It does not die on *any* scroll: a
 * phantom trackpad delta would kill a menu for nothing, and a deliberate peek
 * at something nearby is a thing a user does with a menu open. What it does
 * is live as long as its **referent** — the entity the press settled on, or
 * the range the selection covers — is drawn inside its scroller's visible
 * area, and close the moment that referent leaves. The referent scrolls with
 * the content, so it is the visible tether the menu itself lacks.
 *
 * A menu with only a **surface** referent is the other half of the rule. A
 * bare right-click with no selection and no entity offers Paste and Select
 * All, which act on a surface that is still there after any scroll — so that
 * menu has nothing to lose and gains no scroll-driven dismissal at all.
 *
 * The three cases, on one app launch and one card:
 *
 *   1. **A small scroll leaves the menu alone.** The path is centered, the
 *      menu opened over it, and a scroll of half the room above it keeps the
 *      path on screen. The menu is still open and its viewport rect has not
 *      moved by a pixel — the disconnect is the behavior, not a defect.
 *   2. **A scroll that takes the referent away closes the menu.** The same
 *      menu, scrolled by the shortest delta that clears the path from the
 *      scrollport — the row is still mounted, so this is the rect
 *      intersection [B02] rests on rather than the referent's host leaving
 *      the DOM — and then run to the transcript's end, where it stays closed.
 *   3. **A surface-only menu survives both.** A bare right-click in an empty
 *      composer — no selection, no entity — and the transcript scrolled from
 *      end to end underneath it. The menu is still open.
 *
 * Case 1's second assertion is the one that needs saying twice: the *path*
 * moved and the *menu* did not. A test that only asserted "still open" would
 * pass against a menu being dragged along behind the content, which is the
 * behavior this rule rejects.
 *
 * The scrolls are driven by writing `scrollTop` and waited on by counting
 * `scroll` events in the page — never by a frame count, because an occluded
 * harness window suspends `requestAnimationFrame`, and never by a timer,
 * which is banned here. The counter is registered before any menu opens, so
 * a tick means the browser dispatched the event that the menu's own
 * window-capture listener heard in the same dispatch.
 *
 * @covers tugdeck/src/components/tugways/tug-editor-context-menu.tsx
 * @covers tugdeck/src/components/tugways/use-text-surface-context-menu.tsx
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

const CODE_OUTPUT_FEED = 0x40; // FeedId.CODE_OUTPUT
const SID = "test-session-at0626";

const CARD = '[data-card-id="A"]';
const SCROLLER = `${CARD} [data-tug-scroll-key="session-card-transcript"]`;
const CODE_BODY = `${CARD} .session-card-transcript-code-body`;
const PATH_SPAN = `${CODE_BODY} code[data-tug-annotation="file-path"]`;
const COMPOSER = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const MENU = '[data-slot="tug-editor-context-menu"]';

/** How many filler turns it takes to make the transcript taller than the card. */
const FILLER_TURNS = 16;

const FILE_NAME = "referent.md";
const FILE_BODY = ["alpha", "bravo", "charlie"].join("\n");

let projectDir = "";
let realPath = "";

beforeAll(() => {
  if (!SHOULD_RUN) return;
  projectDir = mkdtempSync(join(tmpdir(), "at0626-referent-"));
  realPath = join(projectDir, FILE_NAME);
  writeFileSync(realPath, FILE_BODY, "utf8");
});
afterAll(() => {
  if (projectDir !== "" && existsSync(projectDir)) {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 640 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

const userMsg = (text: string) => ({
  type: "add_user_message",
  tug_session_id: SID,
  content: [{ type: "text", text }],
});
const asstText = (msgId: string, text: string, seq: number) => ({
  type: "assistant_text",
  tug_session_id: SID,
  msg_id: msgId,
  text,
  is_partial: false,
  rev: 0,
  seq,
});
const turnDone = (msgId: string) => ({
  type: "turn_complete",
  tug_session_id: SID,
  msg_id: msgId,
  result: "success",
});
const replayStarted = () => ({ type: "replay_started", tug_session_id: SID });
const replayComplete = (turns: number) => ({
  type: "replay_complete",
  tug_session_id: SID,
  count: turns,
  firstLoadedTurnIndex: 0,
  totalTurns: turns,
  hasOlder: false,
});

/**
 * A scroll counter on `window`, capture phase, installed once before any menu
 * opens. Every scroll wait below reads it: a tick is the browser having
 * dispatched the event, which is the same dispatch the menu's own listener
 * runs in. No frames, no timers.
 */
const INSTALL_SCROLL_COUNTER = `(function(){
  if (window.__at0626installed === true) return true;
  window.__at0626installed = true;
  window.__at0626scrolls = 0;
  window.addEventListener("scroll", function(){
    window.__at0626scrolls += 1;
  }, true);
  return true;
})()`;

/** The rect of one element, or `null` — in viewport coordinates. */
const rectJS = (selector: string) => `JSON.stringify((function(){
  var el = document.querySelector(${JSON.stringify(selector)});
  if (el === null) return null;
  var r = el.getBoundingClientRect();
  return {
    top: Math.round(r.top),
    left: Math.round(r.left),
    width: Math.round(r.width),
    height: Math.round(r.height),
  };
})())`;

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

async function rectOf(app: App, selector: string): Promise<Rect | null> {
  return JSON.parse(await app.evalJS<string>(rectJS(selector))) as Rect | null;
}

/**
 * Where the path sits inside the scrollport: how much room is above it, and
 * whether any of it is drawn inside. `room` is what a small scroll's delta is
 * chosen from, so the delta is derived from the geometry the app actually
 * laid out rather than from a number this file guessed.
 */
const PLACEMENT_JS = `JSON.stringify((function(){
  var port = document.querySelector(${JSON.stringify(SCROLLER)});
  var span = document.querySelector(${JSON.stringify(PATH_SPAN)});
  if (port === null || span === null) return { found: false };
  var pb = port.getBoundingClientRect();
  var top = pb.top + port.clientTop;
  var bottom = top + port.clientHeight;
  var sb = span.getBoundingClientRect();
  return {
    found: true,
    room: Math.round(sb.top - top),
    visible: sb.bottom > top && sb.top < bottom,
    spanTop: Math.round(sb.top),
    scrollTop: Math.round(port.scrollTop),
    scrollHeight: Math.round(port.scrollHeight),
    clientHeight: Math.round(port.clientHeight),
  };
})())`;

interface Placement {
  found: boolean;
  room?: number;
  visible?: boolean;
  spanTop?: number;
  scrollTop?: number;
  scrollHeight?: number;
  clientHeight?: number;
}

async function placement(app: App): Promise<Placement> {
  return JSON.parse(await app.evalJS<string>(PLACEMENT_JS)) as Placement;
}

/** Scroll events counted so far. */
function scrolls(app: App): Promise<number> {
  return app.evalJS<number>(`window.__at0626scrolls`);
}

/**
 * Write `scrollTop` and wait for the browser to have dispatched the scroll it
 * causes. `mutate` is JS over `el`, the scroller; it returns nothing. A write
 * the browser clamps to the same value dispatches nothing, so the caller's
 * delta must actually move the scroller.
 */
async function scrollAndSettle(app: App, mutate: string): Promise<void> {
  const before = await scrolls(app);
  await app.evalJS<boolean>(`(function(){
    var el = document.querySelector(${JSON.stringify(SCROLLER)});
    if (el === null) return false;
    ${mutate}
    return true;
  })()`);
  await app.waitForCondition<boolean>(
    `window.__at0626scrolls > ${before}`,
    { timeoutMs: 8_000 },
  );
}

/** True while the editor context menu stands. */
const menuPresentJS = `document.querySelector(${JSON.stringify(MENU)}) !== null`;

async function menuPresent(app: App): Promise<boolean> {
  return app.evalJS<boolean>(menuPresentJS);
}

describe.skipIf(!SHOULD_RUN)(
  "at0626 — a context menu lives as long as its referent is visible",
  () => {
    test(
      "a small scroll leaves it, a scroll past the referent closes it, and a surface-only menu survives both",
      async () => {
        const app = await launchTugApp({
          testName: "at0626-context-menu-scroll-referent",
        });
        const ingest = (decoded: unknown) =>
          app.driveSession("A", {
            op: "ingestFrame",
            feedId: CODE_OUTPUT_FEED,
            decoded,
          });

        try {
          await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
          await app.waitForCondition<boolean>(
            `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
            { timeoutMs: 30_000 },
          );
          await app.bindSession("A", {
            tugSessionId: SID,
            projectDir,
            sessionMode: "resume",
          });

          // The path's turn first, then enough filler to make the transcript
          // taller than the card — all of it inside the replay window, which
          // is the only window the transcript takes these frames in. The list
          // follows bottom, so the filler is also what puts the path out of
          // reach and makes the scroll back up to it a real one.
          await ingest(replayStarted());
          await ingest(userMsg("where does it live"));
          await ingest(asstText("m1", `It lives at \`${realPath}\`.`, 1));
          await ingest(turnDone("m1"));
          for (let i = 0; i < FILLER_TURNS; i += 1) {
            const id = `f${i}`;
            await ingest(userMsg(`and then ${i}`));
            await ingest(
              asstText(
                id,
                `Turn ${i}. ${"Some prose that takes a line or two of the transcript. ".repeat(4)}`,
                1,
              ),
            );
            await ingest(turnDone(id));
          }
          await ingest(replayComplete(FILLER_TURNS + 1));

          await app.waitForCondition<boolean>(
            `(function(){
              var el = document.querySelector(${JSON.stringify(SCROLLER)});
              return el !== null && el.scrollHeight > el.clientHeight + 400;
            })()`,
            { timeoutMs: 20_000 },
          );
          note(
            "at0626 transcript geometry",
            await app.evalJS<string>(`JSON.stringify((function(){
              var el = document.querySelector(${JSON.stringify(SCROLLER)});
              var host = document.querySelector('${CARD} [data-testid="session-card-transcript"]');
              return {
                scroller: el === null ? null : {
                  scrollHeight: Math.round(el.scrollHeight),
                  clientHeight: Math.round(el.clientHeight),
                },
                replaying: host === null ? null : host.hasAttribute("data-replaying"),
                codeBodies: document.querySelectorAll(${JSON.stringify(CODE_BODY)}).length,
                pathSpans: document.querySelectorAll(${JSON.stringify(PATH_SPAN)}).length,
              };
            })())`),
          );

          await app.evalJS<boolean>(INSTALL_SCROLL_COUNTER);

          // --- case 1: a small scroll leaves the menu alone ----------------

          // Back to the top, where the path's turn is, and then centered, so
          // there is room above it for a scroll that keeps it on screen.
          //
          // The list follows bottom and the path's row is virtualized out down
          // there, so arriving at the top and the row mounting are two things
          // that race: a single write can be undone by the follow before the
          // annotator has seen the row. The wait holds the scroller at the top
          // until the row is there, which is what a hand on the wheel does.
          await scrollAndSettle(app, `el.scrollTop = 0;`);
          await app.waitForCondition<boolean>(
            `(function(){
              var el = document.querySelector(${JSON.stringify(SCROLLER)});
              if (el === null) return false;
              if (el.scrollTop > 0) { el.scrollTop = 0; return false; }
              return document.querySelector(${JSON.stringify(PATH_SPAN)}) !== null;
            })()`,
            { timeoutMs: 20_000 },
          );
          await scrollAndSettle(
            app,
            `var span = document.querySelector(${JSON.stringify(PATH_SPAN)});
             if (span !== null) span.scrollIntoView({ block: "center" });`,
          );

          const centered = await placement(app);
          note("at0626 centered", JSON.stringify(centered));
          expect(centered.found, "the path is on screen to be pressed").toBe(true);
          expect(centered.visible, "the path is inside the scrollport").toBe(true);
          // The delta below is half of this, so the assertions that follow are
          // about a scroll that provably keeps the path on screen.
          expect(
            (centered.room ?? 0) > 60,
            "the path has room above it to scroll into",
          ).toBe(true);

          await app.nativeRightClickAtElement(PATH_SPAN);
          await app.waitForCondition<boolean>(menuPresentJS, { timeoutMs: 8_000 });

          const menuBefore = await rectOf(app, MENU);
          const spanBefore = await rectOf(app, PATH_SPAN);
          expect(menuBefore, "the menu opened over the path").not.toBeNull();
          expect(spanBefore, "the path is still drawn").not.toBeNull();

          const delta = Math.floor((centered.room ?? 0) / 2);
          await scrollAndSettle(app, `el.scrollTop = el.scrollTop + ${delta};`);

          const afterSmall = await placement(app);
          const menuAfter = await rectOf(app, MENU);
          const spanAfter = await rectOf(app, PATH_SPAN);
          note(
            "at0626 after a small scroll",
            JSON.stringify({ afterSmall, menuAfter, spanAfter, delta }),
          );

          expect(
            afterSmall.visible,
            "a small scroll keeps the path inside the scrollport",
          ).toBe(true);
          expect(menuAfter, "the menu is still open").not.toBeNull();
          // The referent moved and the menu did not: the disconnect is the
          // rule, and a menu chasing its referent would fail here.
          expect(
            (spanAfter as Rect).top,
            "the path moved under the menu",
          ).not.toBe((spanBefore as Rect).top);
          expect((menuAfter as Rect).top, "the menu did not move").toBe(
            (menuBefore as Rect).top,
          );
          expect((menuAfter as Rect).left, "the menu did not move").toBe(
            (menuBefore as Rect).left,
          );

          // --- case 2: a scroll past the referent closes the menu ----------

          // Bounded first, to the shortest scroll that puts the path above the
          // scrollport's top edge — room left above it, plus its own height,
          // plus a margin. This is the rect-intersection boundary [B02] names
          // and the shape of the report that started this: the row is still
          // mounted and the menu must still go. Running straight to the end
          // instead would close the menu by the referent's host leaving the
          // DOM, which is the same verdict reached down a different branch —
          // a green that would survive a broken intersection check. The note
          // below records which branch answered.
          const past =
            Math.max(afterSmall.room ?? 0, 0) +
            Math.ceil((spanAfter as Rect).height) +
            8;
          await scrollAndSettle(app, `el.scrollTop = el.scrollTop + ${past};`);
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(MENU)}) === null`,
            { timeoutMs: 8_000 },
          );
          const pastPlacement = await placement(app);
          note(
            "at0626 after the shortest scroll that clears the scrollport",
            JSON.stringify({ past, pastPlacement }),
          );
          if (pastPlacement.found === true) {
            expect(
              pastPlacement.visible,
              "the path is out of the scrollport with its row still mounted",
            ).toBe(false);
          }

          // And it stays closed with the transcript run to its end.
          await scrollAndSettle(app, `el.scrollTop = el.scrollHeight;`);
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(MENU)}) === null`,
            { timeoutMs: 8_000 },
          );
          note(
            "at0626 after the referent left",
            JSON.stringify(await placement(app)),
          );

          // --- case 3: a surface-only menu survives both ------------------

          // An empty composer: no selection to sample and no entity under the
          // press, so the menu is about the surface and takes no referent.
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(COMPOSER)}) !== null`,
            { timeoutMs: 20_000 },
          );
          // CodeMirror draws its placeholder only while the document is
          // empty, so the placeholder's presence is the surface's own word
          // that there is nothing here to select. `textContent` cannot say
          // it: the placeholder is a widget inside `.cm-content`.
          expect(
            await app.evalJS<boolean>(
              `document.querySelector(${JSON.stringify(`${COMPOSER} .cm-placeholder`)}) !== null`,
            ),
            "the composer is empty, so the press has nothing to select",
          ).toBe(true);

          await app.nativeRightClickAtElement(COMPOSER);
          await app.waitForCondition<boolean>(menuPresentJS, { timeoutMs: 8_000 });
          const surfaceMenu = await rectOf(app, MENU);
          expect(surfaceMenu, "the bare press opened a menu").not.toBeNull();

          await scrollAndSettle(app, `el.scrollTop = 0;`);
          expect(
            await menuPresent(app),
            "a scroll to the top leaves a surface-only menu standing",
          ).toBe(true);
          await scrollAndSettle(app, `el.scrollTop = el.scrollHeight;`);
          expect(
            await menuPresent(app),
            "a scroll to the end leaves a surface-only menu standing",
          ).toBe(true);
          // And it stayed where it opened while the transcript ran past it.
          expect((await rectOf(app, MENU))?.top, "and it did not move").toBe(
            (surfaceMenu as Rect).top,
          );

          await app.nativeKey("Escape");
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
