/**
 * resize-scroll-preservation-fixture.ts — the decks and instruments the
 * at0430-resize-scroll-preservation-* files share: the resize episode's
 * stamp watch, the top-edge subject anchor, and the readings of pane width,
 * displacements and follow-bottom.
 *
 * The invariant every file asserts is the top edge: whatever row was at the
 * scroller's top edge is at the same offset from the top edge after a width
 * change. Not `scrollTop` — `scrollTop` is *expected* to move.
 *
 * @module tests/app-test/resize-scroll-preservation-fixture
 */

import type { App, BodyApp } from "./_harness";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
export const TEST_TIMEOUT_MS = 180_000;

/** The pane `fixtures/runner`'s deck shape puts the session card in. */
export const FRAME = '.tug-pane[data-pane-id="p1"]';

// Its own number, not `SCROLL_TOL_PX` (8) from `_harness/tolerances.ts`: a different
// tolerance is this file's decision, so the table does not flatten it.
/**
 * How far the anchored row's top edge may sit from where it was.
 *
 * The anchor resolves through measured row heights that the width change has
 * just invalidated and re-measured, so the arithmetic runs on sub-pixel box
 * heights rounded at two different widths. The failure this guards against is
 * not a pixel — it is tens or hundreds of them.
 */
export const ANCHOR_TOLERANCE_PX = 2;

// Its own number, not `SCROLL_TOL_PX` (8) from `_harness/tolerances.ts`: a different
// tolerance is this file's decision, so the table does not flatten it.
/**
 * The same bound for a soft-wrapped CodeMirror document, where the unit is a
 * wrapped row rather than a pixel: narrowing the card adds rows to the line
 * under the top edge, so how far into that line the viewport sits can only be
 * held to the row the re-wrap created.
 */
export const WRAPPED_ROW_TOLERANCE_PX = 24;

/** The settle window (`IMPOSITION_SETTLE_MS`) with room for the tween. */
export const AFTER_LAND_MS = 900;

export const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

/**
 * One gallery card in a pane short enough that its content overflows the
 * PANE's own content box — the scroller a card that never took over its
 * scrolling gets by default. Seeded wide, so narrowing it to slim is a real
 * reflow rather than a nudge.
 */
export function galleryDeck(): Record<string, unknown> {
  return {
    cards: [
      {
        id: "A",
        componentId: "gallery-accordion",
        title: "Accordion",
        closable: true,
      },
    ],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 1100, height: 420 },
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

/** One Text card, seeded wide so narrowing it to slim is a real re-wrap. */
export function textDeck(): Record<string, unknown> {
  return {
    cards: [{ id: "A", componentId: "text", title: "File", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 1100, height: 560 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["standard"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

/** A row at the scroller's top edge, and how far its top sits from that edge. */
export interface Anchor {
  /** The list view's absolute data-source index — stable across a re-render. */
  index: string;
  /** The row's top edge measured from the scroller's viewport top. Negative when partly scrolled past. */
  delta: number;
  scrollTop: number;
}

/** A page the episode is read in: the shell, or a card that draws its own chrome. */
type EpisodePage = Pick<App, "evalJS" | "waitForCondition">;

/**
 * Record every episode the frame raises, so a gesture that raised none is
 * distinguishable from one that raised one and did nothing.
 */
export async function armEpisodeWatch(app: EpisodePage, frame: string): Promise<void> {
  await app.evalJS<null>(
    `(function () {
      var frame = document.querySelector(${JSON.stringify(frame)});
      if (frame === null) throw new Error("frame not found: " + ${JSON.stringify(frame)});
      window.__at0430 = { seen: [] };
      var mo = new MutationObserver(function () {
        var v = frame.getAttribute("data-resize-episode");
        if (v !== null && window.__at0430.seen.indexOf(v) === -1) {
          window.__at0430.seen.push(v);
        }
      });
      mo.observe(frame, { attributes: true, attributeFilter: ["data-resize-episode"] });
      return null;
    })()`,
  );
}

export const episodeCount = (app: EpisodePage): Promise<number> =>
  app.evalJS<number>(`window.__at0430.seen.length`);

/** Wait until no episode is open on the frame, then let the settle finish. */
export async function waitForEpisodesClosed(app: EpisodePage, frame: string): Promise<void> {
  await app.waitForCondition<boolean>(
    `document.querySelector(${JSON.stringify(frame)}).getAttribute("data-resize-episode") === null`,
    { timeoutMs: 10_000 },
  );
  await wait(AFTER_LAND_MS);
}

/**
 * Claim the first paragraph-ish box fully inside the viewport as the subject,
 * and remember it on `window` so the same node is re-measured afterwards.
 *
 * The subject is chosen the way a reader would point at one — the first whole
 * block below the top edge — and deliberately NOT the way the implementation
 * chooses its anchor, so the assertion is a claim about the document rather
 * than a restatement of the mechanism. A block's top edge moves only when
 * content ABOVE it changes height, which is exactly the displacement the
 * episode exists to absorb.
 *
 * `page` is the page the scroller is in: the card's body
 * (`app.body("A")`) for a scroller inside the card, the shell for one that
 * is the pane's own. The same holds for every scroller reading below.
 */
export async function claimSubject(page: App | BodyApp, scroller: string): Promise<Anchor> {
  const anchor = await page.evalJS<Anchor | null>(
    `(function () {
      var el = document.querySelector(${JSON.stringify(scroller)});
      if (el === null) return null;
      var top = el.getBoundingClientRect().top;
      var walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT);
      var node = walker.nextNode();
      while (node !== null) {
        var r = node.getBoundingClientRect();
        if (r.top >= top && r.height > 4 && r.height < el.clientHeight && node.childElementCount === 0) {
          window.__at0430subject = node;
          var cell = node.closest("[data-tug-list-cell-index]");
          return {
            index: cell === null ? "?" : cell.getAttribute("data-tug-list-cell-index"),
            delta: Math.round(r.top - top),
            scrollTop: Math.round(el.scrollTop),
          };
        }
        node = walker.nextNode();
      }
      return null;
    })()`,
  );
  if (anchor === null) throw new Error(`no anchorable block in "${scroller}"`);
  return anchor;
}

/** Where the claimed subject sits now, or null if it has left the document. */
export async function readSubject(
  page: App | BodyApp,
  scroller: string,
): Promise<{ delta: number; scrollTop: number } | null> {
  return page.evalJS<{ delta: number; scrollTop: number } | null>(
    `(function () {
      var el = document.querySelector(${JSON.stringify(scroller)});
      var node = window.__at0430subject;
      if (el === null || node === undefined || !el.contains(node)) return null;
      return {
        delta: Math.round(node.getBoundingClientRect().top - el.getBoundingClientRect().top),
        scrollTop: Math.round(el.scrollTop),
      };
    })()`,
  );
}

export const paneWidth = (app: App, frame: string): Promise<number> =>
  app.evalJS<number>(
    `Math.round(document.querySelector(${JSON.stringify(frame)}).getBoundingClientRect().width)`,
  );

export const displacements = (page: App | BodyApp, scroller: string): Promise<number> =>
  page.evalJS<number>(
    `Number(document.querySelector(${JSON.stringify(scroller)}).getAttribute("data-scroll-displacements"))`,
  );

export const isAtBottom = (page: App | BodyApp, scroller: string): Promise<boolean> =>
  page.evalJS<boolean>(
    `(function () {
      var el = document.querySelector(${JSON.stringify(scroller)});
      return el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
    })()`,
  );
