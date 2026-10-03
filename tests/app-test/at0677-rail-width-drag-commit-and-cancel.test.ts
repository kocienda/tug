/**
 * at0677-rail-width-drag-commit-and-cancel.test.ts — a rail width drag lands
 * the whole rail, and a drag that loses its pointer gives everything back.
 *
 * A rail is as wide as its widest member: the deck reads a side's width as the
 * max of its members' widths, and every member stands at that one width. Two
 * claims follow, and the rail width drag has to keep both:
 *
 *  1. **The commit lands every member.** Narrow a three-member left rail by
 *     dragging one member's deck-facing edge, and every member stands at the
 *     new width. A commit that writes only the dragged pane's width leaves its
 *     two siblings at the old one, and the rail — as wide as its widest
 *     member — snaps straight back to where it started.
 *  2. **A drag that loses its pointer is cancelled, and releases everything it
 *     took.** A pointer capture can be lost mid-drag — the system takes the
 *     pointer, the window loses it — and the gesture never hears its
 *     `pointerup`; and the user can take it back themselves with Escape.
 *     Either way, everything acquired at pointer-down then has to be given
 *     back by the cancel: the `data-gesture` and `data-pointer-owned` marks,
 *     the scroll-preservation episodes on every frame, the occlusion bracket
 *     that keeps every pane revealed for the gesture's length, the pointer
 *     listeners themselves, and the width the drag previewed. The bracket is
 *     read through its one visible effect: a pane provably buried under
 *     another is revealed when the gesture begins and hidden again only once
 *     the bracket closes, so a leaked bracket leaves it revealed for good.
 *     The listeners are read through theirs: a `pointerup` arriving after the
 *     cancel finds nobody listening and commits nothing.
 *
 * The lost capture is the platform's own: the frame holding the capture is
 * asked to release it with the pointer id the press arrived on, which fires
 * `lostpointercapture` at it. WebKit may deliver that event only with the
 * next pointer event, and a held drag posts none, so when the release has not
 * delivered it the test dispatches the one event the platform owes — exactly
 * once, at the element that held the capture.
 *
 * The gesture's own code lives in `tug-pane.tsx`, `deck-canvas.tsx` and
 * `deck-manager.ts`, which are named by none of the lines below: each already
 * fans out past the selection budget, so a diff touching one selects nothing
 * by derivation and naming it here would only raise its recorded debt. Run
 * this file by name with any change to the rail width drag.
 *
 * @covers tugdeck/src/components/chrome/pane-occlusion-controller.ts
 * @covers tugdeck/src/lib/resize-episode.ts
 * @covers tugdeck/src/lib/layout-imposer.ts
 * @covers tugdeck/src/components/chrome/rail-width-draft.ts
 * @covers tugdeck/src/lib/rail-width.ts
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 90_000;

/** The width every rail member is seeded at. */
const RAIL_WIDTH = 420;
/** How far the drag narrows the rail: well past the move threshold and well
 *  clear of the members' 320px floors, so the drag lands where it was aimed. */
const NARROW_PX = 60;
/** Frames are measured in device pixels; a rounded width is within a pixel. */
const TOL = 1.5;
/** The settle window (`IMPOSITION_SETTLE_MS`), with room for the tween. */
const AFTER_LAND_MS = 900;
/** Long enough for a few animation frames to run after a pointer event. */
const FRAMES_MS = 250;

const MEMBERS = ["cards", "jots", "layout"] as const;
const PANE_OF: Record<(typeof MEMBERS)[number], string> = {
  cards: "pCards",
  jots: "pJots",
  layout: "pLayout",
};
/** The member whose edge the hand drags: the middle one, so neither the
 *  first nor the last member stands in for "the rail". */
const DRAGGED = "pJots";
const HANDLE = `.tug-pane[data-pane-id="${DRAGGED}"] .tug-pane-resize-e`;

const frame = (paneId: string): string =>
  `.tug-pane[data-pane-id="${paneId}"]`;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

function card(id: string, componentId: string, title: string) {
  return { id, componentId, title, closable: true };
}

function chainPane(id: string, cardId: string, slot: number) {
  return {
    id,
    position: { x: 40, y: 40 },
    size: { width: 400, height: 400 },
    cardIds: [cardId],
    activeCardId: cardId,
    title: "",
    acceptsFamilies: ["maker"],
    slot,
  };
}

function railPane(id: string, cardId: string, title: string) {
  return {
    id,
    position: { x: 0, y: 0 },
    size: { width: RAIL_WIDTH, height: 900 },
    cardIds: [cardId],
    activeCardId: cardId,
    title,
    acceptsFamilies: [],
  };
}

/**
 * Three sidebar cards on the left rail, all at `RAIL_WIDTH`, beside a
 * three-up chain. Slot 0 holds TWO panes of equal width — `pBuried` behind
 * `pFront` — so the buried one is provably covered and the occlusion
 * controller hides it at rest ([at0347]'s occluded shape).
 */
function deckShape() {
  return {
    cards: [
      card("C", "cards", "Cards"),
      card("J", "jots", "Jots"),
      card("L", "layout", "Layout"),
      card("Z", "hello", "Card Z"),
      card("A", "hello", "Card A"),
      card("B", "hello", "Card B"),
    ],
    panes: [
      chainPane("pBuried", "Z", 0),
      chainPane("pFront", "A", 0),
      chainPane("pSecond", "B", 2),
      railPane("pCards", "C", "Cards"),
      railPane("pJots", "J", "Jots"),
      railPane("pLayout", "L", "Layout"),
    ],
    activePaneId: "pFront",
    imposition: {
      kind: "three-up",
      layout: "fit",
      sidebars: {
        cards: { side: "left" },
        jots: { side: "left" },
        layout: { side: "left" },
      },
      rails: { left: { order: [...MEMBERS] } },
    },
    hasFocus: true,
  };
}

async function seed(app: App): Promise<void> {
  await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
  await app.waitForCondition<boolean>(
    `document.querySelectorAll('.tug-pane[data-rail-side="left"]').length === 3`,
    { timeoutMs: 15_000 },
  );
  await app.waitForCondition<boolean>(
    `document.querySelector("[data-imposer-settling]") === null`,
    { timeoutMs: 8_000 },
  );
  await wait(AFTER_LAND_MS);
}

/** Every left-rail member's rendered width, keyed by componentId. */
function memberWidths(app: App): Promise<Record<string, number>> {
  return app.evalJS<Record<string, number>>(
    `(function () {
      var out = {};
      document.querySelectorAll('.tug-pane[data-rail-side="left"]').forEach(function (el) {
        out[el.getAttribute("data-rail-member")] = el.getBoundingClientRect().width;
      });
      return out;
    })()`,
  );
}

/** Every left-rail member's stored width, keyed by componentId — what the
 *  commit wrote, as the live store holds it. */
function storedWidths(app: App): Promise<Record<string, number>> {
  return app.evalJS<Record<string, number>>(
    `(function () {
      var ids = ${JSON.stringify(PANE_OF)};
      var panes = window.tugdeck.diag.getDeckState().panes;
      var out = {};
      Object.keys(ids).forEach(function (member) {
        var pane = panes.filter(function (p) { return p.id === ids[member]; })[0];
        out[member] = pane === undefined ? -1 : pane.size.width;
      });
      return out;
    })()`,
  );
}

function expectEveryMember(
  widths: Record<string, number>,
  expected: number,
  phase: string,
): void {
  for (const member of MEMBERS) {
    expect(
      Math.abs((widths[member] ?? 0) - expected),
      `${phase}: ${member} stands at ${expected}px (read ${widths[member]?.toFixed(1)})`,
    ).toBeLessThanOrEqual(TOL);
  }
}

/** The centre of the dragged member's deck-facing handle. */
function grip(app: App): Promise<{ x: number; y: number }> {
  return app.evalJS<{ x: number; y: number }>(
    `(function () {
      var r = document.querySelector(${JSON.stringify(HANDLE)}).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`,
  );
}

function count(app: App, selector: string): Promise<number> {
  return app.evalJS<number>(
    `document.querySelectorAll(${JSON.stringify(selector)}).length`,
  );
}

describe.skipIf(!SHOULD_RUN)(
  "at0677 — a rail width drag lands the whole rail, and a lost pointer cancels it",
  () => {
    test(
      "narrowing a three-member rail lands every member at the new width",
      async () => {
        const app = await launchTugApp({ testName: "at0677-rail-width-commit" });
        try {
          await seed(app);
          expectEveryMember(await memberWidths(app), RAIL_WIDTH, "at rest");

          // A left rail's one handle is its east edge; leftward narrows it.
          const from = await grip(app);
          await app.nativeDrag(from, { x: from.x - NARROW_PX, y: from.y });
          await app.waitForCondition<boolean>(
            `document.querySelector("[data-imposer-settling]") === null`,
            { timeoutMs: 8_000 },
          );
          await wait(AFTER_LAND_MS);

          const target = RAIL_WIDTH - NARROW_PX;
          expectEveryMember(await storedWidths(app), target, "stored");
          expectEveryMember(await memberWidths(app), target, "rendered");
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a release with no move before it still commits the width it landed at",
      async () => {
        const app = await launchTugApp({ testName: "at0677-rail-width-bare-release" });
        try {
          await seed(app);
          // A press and a release 60px apart, with nothing between them —
          // what reaches the page when the event merger folds every move of a
          // quick drag into its release. The release travelled, so it is a
          // drag, and it commits.
          const from = await grip(app);
          await app.nativeMouseDown(from);
          await wait(FRAMES_MS);
          await app.nativeMouseUp({ x: from.x - NARROW_PX, y: from.y });
          await app.waitForCondition<boolean>(
            `document.querySelector("[data-imposer-settling]") === null`,
            { timeoutMs: 8_000 },
          );
          await wait(AFTER_LAND_MS);

          const target = RAIL_WIDTH - NARROW_PX;
          expectEveryMember(await storedWidths(app), target, "stored");
          expectEveryMember(await memberWidths(app), target, "rendered");
          expect(await count(app, "[data-pointer-owned]"), "no frame is still held").toBe(0);
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "a drag whose pointer capture is lost releases everything it took",
      async () => {
        const app = await launchTugApp({ testName: "at0677-rail-width-cancel" });
        try {
          await seed(app);
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(frame("pBuried"))}).getAttribute("data-occluded") === "true"`,
            { timeoutMs: 5_000 },
          );

          // The press's pointer id, caught on its way down, so the release
          // below names the capture the gesture actually took.
          await app.evalJS<null>(
            `(window.addEventListener("pointerdown", function (e) {
               window.__at0677PointerId = e.pointerId;
             }, { capture: true, once: true }), null)`,
          );

          const from = await grip(app);
          await app.nativeDragWithoutRelease(from, {
            x: from.x - NARROW_PX,
            y: from.y,
          });
          await wait(FRAMES_MS);

          // The gesture is under way: the frame is marked as held, and the
          // bracket has revealed the buried pane.
          expect(
            await count(app, `${frame(DRAGGED)}[data-pointer-owned]`),
            "the drag latched",
          ).toBe(1);
          expect(
            await app.evalJS<string | null>(
              `document.querySelector(${JSON.stringify(frame("pBuried"))}).getAttribute("data-occluded")`,
            ),
            "the gesture's bracket reveals every pane",
          ).not.toBe("true");

          // ── The moment: the capture is lost. ─────────────────────────────
          const delivery = await app.evalJS<string>(
            `(function () {
              var id = window.__at0677PointerId;
              if (typeof id !== "number") return "no-pointer-id";
              var holder = null;
              document.querySelectorAll(".tug-pane, .tug-pane *").forEach(function (el) {
                if (holder === null && el.hasPointerCapture(id)) holder = el;
              });
              if (holder === null) return "no-capture";
              var delivered = false;
              var mark = function () { delivered = true; };
              holder.addEventListener("lostpointercapture", mark);
              holder.releasePointerCapture(id);
              holder.removeEventListener("lostpointercapture", mark);
              if (delivered) return "platform";
              holder.dispatchEvent(new PointerEvent("lostpointercapture", {
                pointerId: id,
                pointerType: "mouse",
                isPrimary: true,
                bubbles: true,
              }));
              return "dispatched";
            })()`,
          );
          note(`lostpointercapture delivery: ${delivery}`);
          expect(["platform", "dispatched"]).toContain(delivery);
          await wait(FRAMES_MS);

          expect(
            await count(app, "[data-gesture]"),
            "no frame is still marked mid-gesture",
          ).toBe(0);
          expect(
            await count(app, "[data-pointer-owned]"),
            "no frame is still marked as held",
          ).toBe(0);
          expect(
            await count(app, "[data-resize-episode]"),
            "every scroll-preservation episode is closed",
          ).toBe(0);
          expectEveryMember(await memberWidths(app), RAIL_WIDTH, "rolled back");

          // The bracket closed, so the buried pane is hidden again once the
          // deck is quiet.
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(frame("pBuried"))}).getAttribute("data-occluded") === "true"`,
            { timeoutMs: 5_000 },
          );

          // The listeners are gone: a release arriving now commits nothing.
          await app.nativeMouseUp({ x: from.x - NARROW_PX, y: from.y });
          await wait(AFTER_LAND_MS);
          expectEveryMember(await storedWidths(app), RAIL_WIDTH, "after release");
          expectEveryMember(await memberWidths(app), RAIL_WIDTH, "after release");
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );

    test(
      "Escape mid-drag cancels it, and the release that follows commits nothing",
      async () => {
        const app = await launchTugApp({ testName: "at0677-rail-width-escape" });
        try {
          await seed(app);
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(frame("pBuried"))}).getAttribute("data-occluded") === "true"`,
            { timeoutMs: 5_000 },
          );

          const from = await grip(app);
          await app.nativeDragWithoutRelease(from, {
            x: from.x - NARROW_PX,
            y: from.y,
          });
          await wait(FRAMES_MS);
          expect(
            await count(app, `${frame(DRAGGED)}[data-pointer-owned]`),
            "the drag latched",
          ).toBe(1);

          // ── The moment: the user changes their mind. ─────────────────────
          await app.nativeKey("Escape");
          await wait(FRAMES_MS);

          expect(await count(app, "[data-gesture]"), "no frame is still mid-gesture").toBe(0);
          expect(await count(app, "[data-pointer-owned]"), "no frame is still held").toBe(0);
          expect(
            await count(app, "[data-resize-episode]"),
            "every scroll-preservation episode is closed",
          ).toBe(0);
          expectEveryMember(await memberWidths(app), RAIL_WIDTH, "rolled back");
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(frame("pBuried"))}).getAttribute("data-occluded") === "true"`,
            { timeoutMs: 5_000 },
          );

          // The button is still down; letting it go is not a second chance
          // at the commit the user just declined.
          await app.nativeMouseUp({ x: from.x - NARROW_PX, y: from.y });
          await wait(AFTER_LAND_MS);
          expectEveryMember(await storedWidths(app), RAIL_WIDTH, "after release");
          expectEveryMember(await memberWidths(app), RAIL_WIDTH, "after release");
        } finally {
          await app.close();
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
