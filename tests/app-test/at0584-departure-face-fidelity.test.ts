/**
 * at0584-departure-face-fidelity.test.ts — the departure face is a picture of
 * the card, INSIDE as well as OUTSIDE.
 *
 * ## What this gates
 *
 * `at0582` pins the ghost's box and the face's box: both stand at the rect the
 * departing frame was measured at, on every frame of the fade. Neither of them
 * says anything at all about what is INSIDE the face, and the face is a
 * `cloneNode(true)` of a whole live `.tug-pane` — several thousand nodes whose
 * rendered state comes from four sources the clone does not carry:
 *
 * - **Scroll offsets.** `cloneNode` copies `scrollTop`/`scrollLeft` as nothing:
 *   a clone of a scroller is a scroller at the top. A card scrolled anywhere
 *   else shows different content the instant it is cloned, and a virtualized
 *   scroller shows the rendered window stranded against a spacer.
 * - **Attributes the identity strip takes off.** Sixty-seven CSS rules key on
 *   `[data-slot]`, and they are not all colour — `font-size`, `gap`,
 *   `justify-content` and `white-space` are in there. Stripping the attribute
 *   relays out everything under it.
 * - **Inherited context the re-parent drops.** The face is appended to the
 *   canvas container, not to the frame's own parent, so anything an ancestor
 *   between the two supplied — a custom property, a container query's
 *   container, a sibling-position selector — resolves differently.
 * - **Live element state that is not DOM.** `input.value`, `<canvas>` bitmaps,
 *   `:hover`, running animations. None of it survives a clone.
 *
 * ## The claim
 *
 * Read the live frame's whole subtree immediately before the close, read the
 * face's whole subtree on the first animation frame the ghost stands on, and
 * compare them node for node by structural path. The claim is that they agree:
 * every node stands at the same offset inside its root, within a pixel, and
 * carries the same scroll offset and the same layout-bearing computed style.
 *
 * The comparison is done in the page and only the summary crosses the wire —
 * a 50KB markdown card is thousands of nodes and the diff is the interesting
 * part, not the readings.
 *
 * ## Why this fixture
 *
 * `fixture-markdown-50kb` is the deck's densest deterministic card: a
 * virtualization-aware scroller with a real document under it, seeded rather
 * than driven, so the reading is the same on every run. It is scrolled well
 * off the top before the close, because the top is the one offset at which the
 * scroll defect is invisible.
 *
 * @covers tugdeck/src/components/chrome/departure-face.ts
 */
import { describe, expect, test } from "bun:test";

import { launchTugApp, note, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

/** Where the markdown card is scrolled to before it is closed. */
const SCROLL_TARGET = 1_200;
/** How long the sampler watches for the ghost to appear. */
const CENSUS_MS = 2_000;
/** Geometry tolerance, in px — sub-pixel rounding, never a real disagreement. */
const EPSILON = 1.0;
/** How many nodes the walk records before it gives up and says so. */
const NODE_CAP = 4_000;

const wait = (ms: number): Promise<void> =>
  new Promise<void>((r) => setTimeout(r, ms));

interface Offence {
  /** The node's structural path from the root, as child indices. */
  p: string;
  tag: string;
  cls: string;
  detail: string;
  /** How far it moved, in px, for the ones that moved. */
  d?: number;
}

interface Census {
  liveCount: number;
  faceCount: number;
  truncated: boolean;
  /** Set when the two walks disagreed structurally, which makes the rest moot. */
  structural: string;
  moved: Offence[];
  movedCount: number;
  worst: number;
  scrolled: Offence[];
  scrolledCount: number;
  styled: Offence[];
  styledCount: number;
  lost: Offence[];
  lostCount: number;
  liveAnimations: number;
  faceAnimations: number;
  /** The face's ancestor chain, and the live frame's, for the re-parent question. */
  liveParents: string;
  faceParents: string;
}

/**
 * The reader, the differ, and the sampler — one script, installed once.
 *
 * It lives as a string because both readings have to be taken in the page: the
 * live one synchronously on the far side of nothing, and the face's on the
 * animation frame the ghost first exists on. Marshalling two subtree walks of
 * a 50KB document across the wire to diff them here would cost more than the
 * fade lasts.
 */
const CENSUS_SCRIPT = `
  window.__at0584 = {
    live: null,
    face: null,
    result: null,
    liveParents: "",
    faceParents: "",
    liveAnimations: 0,
    faceAnimations: 0,
    truncated: false,
  };

  window.__at0584_chain = function (el) {
    var out = [];
    var n = el.parentElement;
    while (n !== null && out.length < 6) {
      out.push(
        n.tagName.toLowerCase() +
          (n.className && typeof n.className === "string" && n.className.length > 0
            ? "." + n.className.trim().split(/\\s+/).slice(0, 2).join(".")
            : ""),
      );
      n = n.parentElement;
    }
    return out.join(" < ");
  };

  window.__at0584_read = function (root) {
    var origin = root.getBoundingClientRect();
    var out = [];
    var truncated = false;
    var walk = function (el, path) {
      if (out.length >= ${NODE_CAP}) {
        truncated = true;
        return;
      }
      var r = el.getBoundingClientRect();
      var cs = getComputedStyle(el);
      var cls =
        typeof el.className === "string"
          ? el.className
          : el.className && el.className.baseVal !== undefined
            ? el.className.baseVal
            : "";
      out.push({
        p: path,
        tag: el.tagName,
        cls: cls,
        x: r.left - origin.left,
        y: r.top - origin.top,
        w: r.width,
        h: r.height,
        st: el.scrollTop,
        sl: el.scrollLeft,
        sh: el.scrollHeight,
        fs: cs.fontSize,
        pad: cs.paddingTop + " " + cs.paddingLeft,
        gap: cs.gap,
        disp: cs.display,
        pos: cs.position,
        td: cs.textDecorationLine,
        val:
          el.tagName === "INPUT" || el.tagName === "TEXTAREA"
            ? String(el.value || "")
            : "",
      });
      var kids = el.children;
      for (var i = 0; i < kids.length; i += 1) walk(kids[i], path + "/" + i);
    };
    walk(root, "");
    window.__at0584.truncated = window.__at0584.truncated || truncated;
    return out;
  };

  window.__at0584_diff = function () {
    var live = window.__at0584.live;
    var face = window.__at0584.face;
    var res = {
      liveCount: live === null ? 0 : live.length,
      faceCount: face === null ? 0 : face.length,
      truncated: window.__at0584.truncated,
      structural: "",
      moved: [],
      movedCount: 0,
      worst: 0,
      scrolled: [],
      scrolledCount: 0,
      styled: [],
      styledCount: 0,
      lost: [],
      lostCount: 0,
      liveAnimations: window.__at0584.liveAnimations,
      faceAnimations: window.__at0584.faceAnimations,
      liveParents: window.__at0584.liveParents,
      faceParents: window.__at0584.faceParents,
    };
    if (live === null || face === null) {
      res.structural = "one of the two readings was never taken";
      return res;
    }
    if (live.length !== face.length) {
      res.structural =
        "the clone has " + face.length + " nodes against the frame's " + live.length;
    }
    var n = Math.min(live.length, face.length);
    for (var i = 0; i < n; i += 1) {
      var a = live[i];
      var b = face[i];
      if (a.p !== b.p) {
        res.structural =
          res.structural ||
          "the walks diverged at " + a.p + " (live " + a.tag + ", face " + b.tag + ")";
        break;
      }
      var label = { p: a.p, tag: a.tag, cls: a.cls.slice(0, 60) };

      var d = Math.max(
        Math.abs(a.x - b.x),
        Math.abs(a.y - b.y),
        Math.abs(a.w - b.w),
        Math.abs(a.h - b.h),
      );
      if (d > ${EPSILON}) {
        res.movedCount += 1;
        if (d > res.worst) res.worst = d;
        res.moved.push({
          p: label.p,
          tag: label.tag,
          cls: label.cls,
          d: Math.round(d * 10) / 10,
          detail:
            "live " + Math.round(a.x) + "," + Math.round(a.y) + " " +
            Math.round(a.w) + "x" + Math.round(a.h) +
            "  face " + Math.round(b.x) + "," + Math.round(b.y) + " " +
            Math.round(b.w) + "x" + Math.round(b.h),
        });
      }

      if (Math.abs(a.st - b.st) > 1 || Math.abs(a.sl - b.sl) > 1) {
        res.scrolledCount += 1;
        res.scrolled.push({
          p: label.p,
          tag: label.tag,
          cls: label.cls,
          detail:
            "live scrollTop " + Math.round(a.st) + " / scrollLeft " + Math.round(a.sl) +
            "  face " + Math.round(b.st) + " / " + Math.round(b.sl) +
            "  (scrollHeight live " + Math.round(a.sh) + ", face " + Math.round(b.sh) + ")",
        });
      }

      var changed = [];
      if (a.fs !== b.fs) changed.push("font-size " + a.fs + " to " + b.fs);
      if (a.pad !== b.pad) changed.push("padding " + a.pad + " to " + b.pad);
      if (a.gap !== b.gap) changed.push("gap " + a.gap + " to " + b.gap);
      if (a.disp !== b.disp) changed.push("display " + a.disp + " to " + b.disp);
      if (a.pos !== b.pos) changed.push("position " + a.pos + " to " + b.pos);
      if (a.td !== b.td) changed.push("text-decoration " + a.td + " to " + b.td);
      if (changed.length > 0) {
        res.styledCount += 1;
        res.styled.push({
          p: label.p,
          tag: label.tag,
          cls: label.cls,
          detail: changed.join("; "),
        });
      }

      if (a.val !== "" && a.val !== b.val) {
        res.lostCount += 1;
        res.lost.push({
          p: label.p,
          tag: label.tag,
          cls: label.cls,
          detail: 'live value "' + a.val.slice(0, 40) + '" against face "' + b.val.slice(0, 40) + '"',
        });
      }
    }

    res.moved.sort(function (x, y) { return y.d - x.d; });
    res.moved = res.moved.slice(0, 12);
    res.scrolled = res.scrolled.slice(0, 8);
    res.styled = res.styled.slice(0, 12);
    res.lost = res.lost.slice(0, 6);
    return res;
  };
`;

/** Where the markdown card's scroller is, for a given card. */
const scrollSelector = (cardId: string): string =>
  `[data-card-id="${cardId}"] [data-tug-scroll-key="markdown-view"]`;

function deckShape() {
  const ids = ["C", "D", "E"];
  return {
    cards: ids.map((id) => ({
      id,
      componentId: "fixture-markdown-50kb",
      title: `MD ${id}`,
      closable: true,
    })),
    panes: ids.map((id, index) => ({
      id: `p${index + 1}`,
      position: { x: 40, y: 40 },
      size: { width: 560, height: 400 },
      cardIds: [id],
      activeCardId: id,
      title: "",
      acceptsFamilies: ["fixture"],
      slot: index + 1,
    })),
    activePaneId: "p2",
    imposition: { kind: "five-up", sidebars: {}, layout: "flow" },
    hasFocus: true,
  };
}

/**
 * Three `hello` panes in slots 2, 3 and 4, leaving slot 1 for the Session card
 * the case opens into — so the departure is a real arrangement change with
 * survivors moving into the room it gives up.
 */
function sessionDeckShape() {
  const ids = ["C", "D", "E"];
  return {
    cards: ids.map((id) => ({
      id,
      componentId: "hello",
      title: `Card ${id}`,
      closable: true,
    })),
    panes: ids.map((id, index) => ({
      id: `p${index + 1}`,
      position: { x: 40, y: 40 },
      size: { width: 560, height: 400 },
      cardIds: [id],
      activeCardId: id,
      title: "",
      acceptsFamilies: ["maker"],
      slot: index + 2,
    })),
    activePaneId: "p2",
    imposition: { kind: "five-up", sidebars: {}, layout: "flow" },
    hasFocus: true,
  };
}

describe.skipIf(!SHOULD_RUN)("AT0584: the departure face's interior", () => {
  test(
    "the face is a picture of the card inside as well as outside",
    async () => {
      const app = await launchTugApp({
        testName: "at0584-departure-face-fidelity",
      });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "D" });
        await app.waitForCondition<boolean>(
          `document.querySelector('.tug-pane[data-pane-id="p2"]') !== null`,
          { timeoutMs: 8_000 },
        );
        // The baked document has landed when the scroller can actually scroll.
        await app.waitForCondition<boolean>(
          `(function () {
            var el = document.querySelector(${JSON.stringify(scrollSelector("D"))});
            return el !== null && el.scrollHeight > el.clientHeight + 400;
          })()`,
          { timeoutMs: 12_000 },
        );
        await wait(1_200);

        // Off the top, because the top is the one offset at which a lost
        // scroll position looks exactly like a kept one.
        const landedAt = await app.evalJS<number>(
          `(function () {
            var el = document.querySelector(${JSON.stringify(scrollSelector("D"))});
            el.scrollTop = ${SCROLL_TARGET};
            return el.scrollTop;
          })()`,
        );
        note("scrolled to", `${landedAt}px of the markdown card's scroller`);
        expect(
          landedAt,
          "the card must actually be scrolled off the top for this census to mean anything",
        ).toBeGreaterThan(200);
        await wait(600);

        await app.evalJS<null>(
          `(function () { ${CENSUS_SCRIPT}; return null; })()`,
        );

        // Arm the sampler BEFORE the close: it latches the face on the first
        // animation frame a ghost stands on, which is the only moment both the
        // reading and the ghost exist.
        await app.evalJS<null>(
          `(function () {
            var t0 = performance.now();
            var tick = function () {
              var ghost = document.querySelector(".tug-pane-exit-ghost");
              if (ghost !== null && window.__at0584.face === null) {
                var face = ghost.querySelector(":scope > .tug-pane-exit-face");
                if (face !== null) {
                  window.__at0584.face = window.__at0584_read(face);
                  window.__at0584.faceParents = window.__at0584_chain(face);
                  window.__at0584.faceAnimations =
                    typeof face.getAnimations === "function"
                      ? face.getAnimations({ subtree: true }).length
                      : -1;
                }
              }
              if (performance.now() - t0 < ${CENSUS_MS}) requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
            return null;
          })()`,
        );

        // The live reading and the close, in ONE evaluation: the face is taken
        // on `cardWillBeginDestruction`, which `closePane` sends before the
        // removal commit, so any gap between the two is a gap in which the
        // frame could change.
        await app.evalJS<null>(
          `(function () {
            var frame = document.querySelector('.tug-pane[data-pane-id="p2"]');
            window.__at0584.live = window.__at0584_read(frame);
            window.__at0584.liveParents = window.__at0584_chain(frame);
            window.__at0584.liveAnimations =
              typeof frame.getAnimations === "function"
                ? frame.getAnimations({ subtree: true }).length
                : -1;
            window.__tug.closePane("p2");
            return null;
          })()`,
        );

        await wait(CENSUS_MS + 300);
        const c = await app.evalJS<Census>(`window.__at0584_diff()`);

        note(
          "walk",
          `${c.liveCount} live nodes, ${c.faceCount} cloned nodes${c.truncated ? ` (capped at ${NODE_CAP})` : ""}`,
        );
        note("live frame's ancestors", c.liveParents || "(none)");
        note("face's ancestors", c.faceParents || "(none)");
        note(
          "running animations",
          `live ${c.liveAnimations}, face ${c.faceAnimations}`,
        );
        expect(
          c.liveCount,
          "the census must have walked a real card, not an empty frame",
        ).toBeGreaterThan(20);
        expect(
          c.faceCount,
          "the census must have caught the face while the ghost stood",
        ).toBeGreaterThan(20);

        note(
          "scroll offsets lost",
          c.scrolledCount === 0
            ? "none"
            : `${c.scrolledCount} scroller(s):\n  ` +
                c.scrolled.map((o) => `${o.cls || o.tag} — ${o.detail}`).join("\n  "),
        );
        note(
          "layout-bearing style changes",
          c.styledCount === 0
            ? "none"
            : `${c.styledCount} node(s):\n  ` +
                c.styled.map((o) => `${o.cls || o.tag} — ${o.detail}`).join("\n  "),
        );
        note(
          "form values lost",
          c.lostCount === 0
            ? "none"
            : `${c.lostCount}:\n  ` +
                c.lost.map((o) => `${o.cls || o.tag} — ${o.detail}`).join("\n  "),
        );
        note(
          "interior nodes that moved",
          c.movedCount === 0
            ? "none"
            : `${c.movedCount} of ${c.liveCount}, worst ${c.worst.toFixed(1)}px:\n  ` +
                c.moved
                  .map((o) => `${o.d}px  ${o.cls || o.tag}  (${o.detail})`)
                  .join("\n  "),
        );

        expect(c.structural, "the clone has the frame's structure").toBe("");
        expect(
          c.scrolledCount,
          "every scroller in the face carries the offset the live one had",
        ).toBe(0);
        expect(
          c.styledCount,
          "no node in the face resolves a different layout-bearing style than the live one",
        ).toBe(0);
        expect(
          c.lostCount,
          "no live form value is dropped by the clone",
        ).toBe(0);
        expect(
          c.movedCount,
          `no interior node stands anywhere but where the live one stood (worst ${c.worst.toFixed(1)}px)`,
        ).toBe(0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  // The same census over a SESSION card, which is the card the reader
  // actually watches close and the one whose subtree is rich in
  // `[data-slot]`: the picker's radio group and file chooser both wear it,
  // and sixty-seven CSS rules key on it — `font-size`, `gap`,
  // `justify-content` and `white-space` among them. The markdown fixture has
  // no slotted nodes at all, so it cannot say whether the identity strip
  // moves a layout metric; this one can.
  test(
    "a Session card's face carries the same interior as the card",
    async () => {
      const app = await launchTugApp({
        testName: "at0584-departure-face-session",
      });
      try {
        await app.seedDeckState({
          state: sessionDeckShape(),
          focusCardId: "C",
        });
        await app.waitForCondition<boolean>(
          `document.querySelector('.tug-pane[data-pane-id="p2"]') !== null`,
          { timeoutMs: 8_000 },
        );
        await wait(1_200);
        await app.evalJS<null>(
          `(window.__tug.dispatchControlAction("show-card", { component: "session" }), null)`,
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(".session-card-picker-form") !== null`,
          { timeoutMs: 8_000 },
        );
        await wait(1_400);
        const paneId = await app.evalJS<string>(
          `(function () {
            var panes = window.tugdeck.diag.getDeckState().panes;
            for (var i = panes.length - 1; i >= 0; i -= 1) {
              if (["p1", "p2", "p3"].indexOf(panes[i].id) === -1) return panes[i].id;
            }
            return "";
          })()`,
        );
        expect(paneId, "the Session card opened into its own pane").not.toBe("");

        const slotted = await app.evalJS<number>(
          `document.querySelectorAll('.tug-pane[data-pane-id=${JSON.stringify(paneId)}] [data-slot]').length`,
        );
        note("slotted nodes in the live card", String(slotted));

        await app.evalJS<null>(
          `(function () { ${CENSUS_SCRIPT}; return null; })()`,
        );
        await app.evalJS<null>(
          `(function () {
            var t0 = performance.now();
            var tick = function () {
              var ghost = document.querySelector(".tug-pane-exit-ghost");
              if (ghost !== null && window.__at0584.face === null) {
                var face = ghost.querySelector(":scope > .tug-pane-exit-face");
                if (face !== null) {
                  window.__at0584.face = window.__at0584_read(face);
                  window.__at0584.faceParents = window.__at0584_chain(face);
                }
              }
              if (performance.now() - t0 < ${CENSUS_MS}) requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
            return null;
          })()`,
        );
        await app.evalJS<null>(
          `(function () {
            var frame = document.querySelector('.tug-pane[data-pane-id=${JSON.stringify(paneId)}]');
            window.__at0584.live = window.__at0584_read(frame);
            window.__at0584.liveParents = window.__at0584_chain(frame);
            window.__tug.closePane(${JSON.stringify(paneId)});
            return null;
          })()`,
        );
        await wait(CENSUS_MS + 300);
        const c = await app.evalJS<Census>(`window.__at0584_diff()`);

        note("walk", `${c.liveCount} live nodes, ${c.faceCount} cloned nodes`);
        note(
          "scroll offsets lost",
          c.scrolledCount === 0
            ? "none"
            : `${c.scrolledCount} scroller(s):\n  ` +
                c.scrolled.map((o) => `${o.cls || o.tag} — ${o.detail}`).join("\n  "),
        );
        note(
          "layout-bearing style changes",
          c.styledCount === 0
            ? "none"
            : `${c.styledCount} node(s):\n  ` +
                c.styled.map((o) => `${o.cls || o.tag} — ${o.detail}`).join("\n  "),
        );
        note(
          "interior nodes that moved",
          c.movedCount === 0
            ? "none"
            : `${c.movedCount} of ${c.liveCount}, worst ${c.worst.toFixed(1)}px:\n  ` +
                c.moved
                  .map((o) => `${o.d}px  ${o.cls || o.tag}  (${o.detail})`)
                  .join("\n  "),
        );

        expect(c.structural, "the clone has the frame's structure").toBe("");
        expect(
          c.styledCount,
          "no node in the face resolves a different layout-bearing style than the live one",
        ).toBe(0);
        expect(
          c.movedCount,
          `no interior node stands anywhere but where the live one stood (worst ${c.worst.toFixed(1)}px)`,
        ).toBe(0);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
