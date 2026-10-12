/**
 * at0729-overview-pinned-header.test.ts — the Overview draws one pinned
 * header for the column, where each post's sticky pin used to sit, and each
 * post carries one stacking context.
 *
 * A sticky attribution pin per post was a stacking context and a
 * compositing-overlap candidate per post. The column now leaves every pin in
 * flow and draws one copy of the top post's attribution over the scrollport.
 * The claim is that nothing a reader sees moved, so the header is checked
 * against the sticky arithmetic it replaces at five scroll positions:
 *
 * | Position       | What the header must do                                 |
 * |----------------|---------------------------------------------------------|
 * | rest on a top  | stay hidden: the post's own pin is in place             |
 * | mid-post       | show at the top, over the post it names                 |
 * | push-up        | ride up with the post's bottom edge                     |
 * | between posts  | stay hidden: the next post's pin is below the top       |
 * | in a code block| show, with the block's own sticky header pinned just    |
 * |                | under it, as it pinned under the sticky pin             |
 *
 * Body chrome — a code block's header — stays sticky and keeps its stacking
 * context: it pins while its block is in view, which is a thing a reader
 * sees. Every other post carries exactly one stacking context, its entry
 * root's containment, counted by the compositing walk's own rule. That is
 * the harness's dark theme; on a light theme the speaker icon's halo is a
 * `filter`, and a second context the brief keeps on purpose.
 *
 * Posts go in one per `evalJS` call: a single call carrying a large script
 * is the shape that has hung the harness.
 *
 * @covers tugdeck/src/components/overview/overview-card.tsx
 * @covers tugdeck/src/components/overview/overview-card.css
 * @covers tugdeck/src/components/overview/overview-window.ts
 * @covers tugdeck/src/components/tugways/tug-transcript-entry.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 240_000;

const CARD = '[data-testid="overview-card"]';
const TRANSCRIPT = '[data-testid="overview-transcript"]';
const HEADER = '[data-testid="overview-pinned-header"]';
const CELL = `${CARD} .overview-cell`;

const POST_COUNT = 150;
const CODE_POST = 40;
const LONG_POST = 63;
const AT_MS = 1_754_600_000_000;

const SENTENCE =
  "The session finished a turn and left a note about what it did, long enough to wrap the rail.";

/** at0728's posts, with one whose body is a code block taller than the column. */
function wirePost(id: number): Record<string, unknown> {
  let body: string;
  if (id === CODE_POST) {
    const lines = Array.from({ length: 90 }, (_, i) => `let line${i} = ${i};`).join("\n");
    body = `Post ${id}: a code block follows.\n\n\`\`\`ts\n${lines}\n\`\`\`\n\nAfter the block.`;
  } else {
    const paragraphs = [`Post ${id}: ${Array(1 + (id % 4)).fill(SENTENCE).join(" ")}`];
    if (id % 7 === 0) paragraphs.push(`A second paragraph for post ${id}.`);
    body = paragraphs.join("\n\n");
  }
  return { id: 7_290_000 + id, at_ms: AT_MS + id * 1_000, author: "observer", body, refs: [] };
}

/** The number in a post's "Post N:" body, read off a mounted cell. */
const POST_NUMBER_JS = `function (cell) {
  var body = cell.querySelector(".overview-post-body");
  var m = /Post (\\d+):/.exec(body === null ? "" : body.textContent || "");
  return m === null ? -1 : Number(m[1]);
}`;

async function frames(): Promise<void> {
  await new Promise((r) => setTimeout(r, 400));
}

async function setScrollTop(app: App, top: number): Promise<void> {
  await app.evalJS<boolean>(`(function () {
  var el = document.querySelector(${JSON.stringify(TRANSCRIPT)});
  el.scrollTop = ${top};
  el.dispatchEvent(new Event("scroll"));
  return true;
})()`);
  await frames();
}

/** A post's cell geometry in scroll coordinates, or null when it is not mounted. */
interface CellAt {
  top: number;
  height: number;
  pinH: number;
}

async function cellAt(app: App, n: number): Promise<CellAt | null> {
  return app.evalJS<CellAt | null>(`(function () {
  var postNumber = ${POST_NUMBER_JS};
  var el = document.querySelector(${JSON.stringify(TRANSCRIPT)});
  var cell = Array.from(document.querySelectorAll(${JSON.stringify(CELL)}))
    .filter(function (c) { return postNumber(c) === ${n}; })[0];
  if (cell === undefined) return null;
  var port = el.getBoundingClientRect();
  var entry = cell.querySelector(".tug-transcript-entry").getBoundingClientRect();
  var pin = cell.querySelector(".tug-transcript-entry__pin").getBoundingClientRect();
  return { top: el.scrollTop + entry.top - port.top, height: entry.height, pinH: pin.height };
})()`);
}

/** Scroll until post `n` is mounted, then return where it sits. */
async function findPost(app: App, n: number): Promise<CellAt> {
  for (let tries = 0; tries < 60; tries++) {
    const at = await cellAt(app, n);
    if (at !== null) return at;
    const range = await app.evalJS<{ lo: number; hi: number; top: number; page: number }>(`(function () {
  var postNumber = ${POST_NUMBER_JS};
  var el = document.querySelector(${JSON.stringify(TRANSCRIPT)});
  var ns = Array.from(document.querySelectorAll(${JSON.stringify(CELL)})).map(postNumber);
  return { lo: Math.min.apply(null, ns), hi: Math.max.apply(null, ns), top: el.scrollTop, page: el.clientHeight };
})()`);
    await setScrollTop(app, range.top + (n < range.lo ? -range.page : range.page));
  }
  throw new Error(`post ${n} never mounted`);
}

/** What the header shows and where, against the sticky arithmetic for the top post. */
interface HeaderReading {
  topPost: number;
  expectedVisible: boolean;
  visible: boolean;
  headerText: string;
  postText: string;
  headerTop: number;
  expectedTop: number;
  headerLeft: number;
  pinLeft: number;
  headerWidth: number;
  pinWidth: number;
}

const HEADER_JS = `(function () {
  var postNumber = ${POST_NUMBER_JS};
  var el = document.querySelector(${JSON.stringify(TRANSCRIPT)});
  var header = document.querySelector(${JSON.stringify(HEADER)});
  var portTop = el.getBoundingClientRect().top;
  var top = Array.from(document.querySelectorAll(${JSON.stringify(CELL)}))
    .filter(function (c) { return c.getBoundingClientRect().bottom > portTop; })[0];
  var entry = top.querySelector(".tug-transcript-entry").getBoundingClientRect();
  var pinEl = top.querySelector(".tug-transcript-entry__pin");
  var pin = pinEl.getBoundingClientRect();
  var headerPin = header.querySelector(".tug-transcript-entry__pin");
  var h = header.getBoundingClientRect();
  return {
    topPost: postNumber(top),
    expectedVisible: entry.top < portTop - 1,
    visible: header.dataset.visible === "true" && getComputedStyle(header).visibility === "visible",
    headerText: headerPin === null ? "" : headerPin.querySelector(".tug-transcript-entry__header").textContent,
    postText: pinEl.querySelector(".tug-transcript-entry__header").textContent,
    headerTop: h.top,
    expectedTop: portTop + Math.min(0, entry.bottom - portTop - pin.height),
    headerLeft: h.left,
    pinLeft: pin.left,
    headerWidth: h.width,
    pinWidth: pin.width,
  };
})()`;

async function readHeader(app: App, label: string): Promise<HeaderReading> {
  const r = await app.evalJS<HeaderReading>(HEADER_JS);
  note(`header ${label}`, JSON.stringify(r));
  return r;
}

function expectHeaderPlaced(r: HeaderReading, expectVisible: boolean): void {
  expect(r.expectedVisible).toBe(expectVisible);
  expect(r.visible).toBe(r.expectedVisible);
  if (!r.visible) return;
  expect(r.headerText).toBe(r.postText);
  expect(Math.abs(r.headerTop - r.expectedTop)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(r.headerLeft - r.pinLeft)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(r.headerWidth - r.pinWidth)).toBeLessThanOrEqual(0.5);
}

/** Per mounted post: its pins' positions, body-chrome stickies, and its stacking contexts. */
interface CellCensus {
  post: number;
  stickyPins: number;
  stickyOutsideBody: number;
  hasBodyChrome: boolean;
  contexts: string[];
}

const CENSUS_JS = `(function () {
  var postNumber = ${POST_NUMBER_JS};
  // The compositing walk's rule, from deck_motion_walk.js.
  var CONTAINMENT_VALUES = ["paint", "layout", "strict", "content"];
  function establishesStackingContext(element, style) {
    if (style.display === "none") return false;
    if (element === document.documentElement) return true;
    var position = style.position;
    if ((position === "absolute" || position === "relative") && style.zIndex !== "auto") return true;
    if (position === "fixed" || position === "sticky") return true;
    if (style.opacity !== "" && Number(style.opacity) < 1) return true;
    if (style.transform !== "none") return true;
    if (style.filter !== "none") return true;
    if (style.perspective !== "none") return true;
    if (style.mixBlendMode !== "normal") return true;
    if (style.isolation === "isolate") return true;
    if (style.willChange !== "auto" && style.willChange !== "") {
      var hinted = style.willChange.split(",").map(function (v) { return v.trim(); });
      var layered = ["transform", "opacity", "filter", "perspective"];
      if (hinted.some(function (v) { return layered.indexOf(v) >= 0; })) return true;
    }
    if (CONTAINMENT_VALUES.some(function (v) { return style.contain.indexOf(v) >= 0; })) return true;
    return false;
  }
  return Array.from(document.querySelectorAll(${JSON.stringify(CELL)})).map(function (cell) {
    var els = [cell].concat(Array.from(cell.querySelectorAll("*")));
    var out = { post: postNumber(cell), stickyPins: 0, stickyOutsideBody: 0, hasBodyChrome: false, contexts: [] };
    els.forEach(function (e) {
      var s = getComputedStyle(e);
      var inBody = e.closest(".overview-post-body") !== null;
      if (s.position === "sticky") {
        if (e.classList.contains("tug-transcript-entry__pin")) out.stickyPins += 1;
        else if (inBody) out.hasBodyChrome = true;
        else out.stickyOutsideBody += 1;
      }
      if (establishesStackingContext(e, s)) {
        out.contexts.push(e.tagName.toLowerCase() + "." + Array.from(e.classList).slice(0, 2).join("."));
      }
    });
    return out;
  });
})()`;

function expectOneContextPerPost(census: CellCensus[]): void {
  for (const c of census) {
    expect(c.stickyPins, `post ${c.post}'s pin is in flow`).toBe(0);
    expect(c.stickyOutsideBody, `post ${c.post} pins nothing of its own`).toBe(0);
    if (!c.hasBodyChrome) {
      expect(c.contexts, `post ${c.post}`).toEqual(["div.tug-transcript-entry.overview-post"]);
    }
  }
}

describe.skipIf(!SHOULD_RUN)("at0729 — the Overview's one pinned header", () => {
  test(
    "the header sits where each post's sticky pin sat, and each post is one stacking context",
    async () => {
      const app = await launchTugApp({ testName: "at0729-overview-pinned-header" });
      try {
        await app.nativeKey("o", ["cmd", "ctrl"]);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(TRANSCRIPT)}) !== null`,
          { timeoutMs: 10_000 },
        );
        for (let id = 0; id < POST_COUNT; id++) {
          expect(
            await app.evalJS<boolean>(
              `window.__tug.publishOverviewPost(${JSON.stringify(JSON.stringify(wirePost(id)))})`,
            ),
          ).toBe(true);
        }
        await app.waitForCondition<boolean>(
          `(window.__tug.overviewPosts() || []).length === ${POST_COUNT} &&
            Array.from(document.querySelectorAll(${JSON.stringify(`${CELL} .overview-post-body`)}))
              .some(function (b) { return (b.textContent || "").indexOf("Post ${POST_COUNT - 1}:") === 0; })`,
          { timeoutMs: 30_000 },
        );
        await frames();

        // ── One stacking context per post, at the live edge.
        const edgeCensus = await app.evalJS<CellCensus[]>(CENSUS_JS);
        note("census at the live edge", JSON.stringify(edgeCensus.slice(0, 3)));
        expect(edgeCensus.length).toBeGreaterThan(0);
        expectOneContextPerPost(edgeCensus);

        // ── Resting on a post's top: the post's own pin is in place.
        const long = await findPost(app, LONG_POST);
        expect(long.height, "the post is tall enough to push a header").toBeGreaterThan(2 * long.pinH);
        await setScrollTop(app, Math.round(long.top));
        expectHeaderPlaced(await readHeader(app, "rest on a top"), false);

        // ── Mid-post: the header shows at the top.
        await setScrollTop(app, Math.round(long.top + long.height / 2));
        const mid = await readHeader(app, "mid-post");
        expect(mid.topPost).toBe(LONG_POST);
        expectHeaderPlaced(mid, true);

        // ── The post's bottom edge pushing the header up.
        await setScrollTop(app, Math.round(long.top + long.height - long.pinH / 2));
        const push = await readHeader(app, "push-up");
        expect(push.topPost).toBe(LONG_POST);
        expectHeaderPlaced(push, true);
        expect(push.expectedTop, "the header is pushed up past the top").toBeLessThan(mid.expectedTop - 1);

        // ── Between two posts: the next post's head is below the top.
        const gap = await app.evalJS<number>(
          `parseFloat(getComputedStyle(document.querySelector(${JSON.stringify(TRANSCRIPT)})).rowGap) || 0`,
        );
        await setScrollTop(app, Math.round(long.top + long.height + gap / 2));
        const between = await readHeader(app, "between posts");
        expect(between.topPost).toBe(LONG_POST + 1);
        expectHeaderPlaced(between, false);

        // ── Inside a code block: the header shows, and the block's own
        // sticky header pins directly under it.
        const code = await findPost(app, CODE_POST);
        await setScrollTop(app, Math.round(code.top + 300));
        const inBlock = await readHeader(app, "in a code block");
        expect(inBlock.topPost).toBe(CODE_POST);
        expectHeaderPlaced(inBlock, true);
        const chrome = await app.evalJS<{ chromeTop: number; portTop: number; stackTop: number; position: string }>(`(function () {
  var postNumber = ${POST_NUMBER_JS};
  var el = document.querySelector(${JSON.stringify(TRANSCRIPT)});
  var cell = Array.from(document.querySelectorAll(${JSON.stringify(CELL)}))
    .filter(function (c) { return postNumber(c) === ${CODE_POST}; })[0];
  var head = cell.querySelector(".tugx-md-chrome-header");
  return {
    chromeTop: head.getBoundingClientRect().top,
    portTop: el.getBoundingClientRect().top,
    stackTop: parseFloat(getComputedStyle(el).getPropertyValue("--tugx-pin-stack-top")),
    position: getComputedStyle(head).position,
  };
})()`);
        note("code block header", JSON.stringify(chrome));
        expect(chrome.position).toBe("sticky");
        expect(Math.abs(chrome.chromeTop - (chrome.portTop + chrome.stackTop))).toBeLessThanOrEqual(0.5);

        const blockCensus = await app.evalJS<CellCensus[]>(CENSUS_JS);
        const codeCell = blockCensus.find((c) => c.post === CODE_POST);
        note("census around the code block", JSON.stringify(codeCell));
        expect(codeCell?.hasBodyChrome).toBe(true);
        expectOneContextPerPost(blockCensus);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
