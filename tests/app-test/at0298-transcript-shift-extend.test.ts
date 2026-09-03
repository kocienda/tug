/**
 * at0298-transcript-shift-extend.test.ts — shift-click extends a transcript
 * selection from a fixed base, in both directions, at the granularity the
 * establishing press set.
 *
 * ## What this audits
 *
 * A selection has a **base** (the end the gesture started from) and an
 * **extent** (the end that moves). `selection-extension.ts` owns that pair
 * for the transcript: an unshifted press re-places both, a shifted press
 * re-places only the extent. Before it, a shift-click re-derived the base
 * from whatever end the normalized `Range` happened to start at, so a
 * shift-click BEHIND an existing selection flipped which end was pinned and
 * the previous selection was lost.
 *
 * Every gesture here is a trusted native click on a real resumed transcript
 * — the fixture session replays real JSONL through the production picker →
 * spawn → reveal path, and the assertions read `window.getSelection()`.
 *
 * ## Legs
 *
 *   1. **Forward extension.** Plain click, then shift-click further along
 *      the same line. The selection spans the two points.
 *   2. **Base holds across a direction flip.** Shift-click BEFORE the base.
 *      The anchor offset is unchanged from leg 1 and the selection now runs
 *      backward from it — the base did not move.
 *   3. **A plain press moves the base.** A fresh unshifted click re-bases;
 *      the following shift-click pivots on the new point, not the old one.
 *   4. **Granularity sticks.** Double-click a word, then shift-click into
 *      the middle of a later word: both ends of the resulting selection sit
 *      on word boundaries rather than mid-word.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/selection-extension.ts
 * @covers tugdeck/src/components/tugways/cards/session-card-transcript.tsx
 * @covers tugdeck/src/components/tugways/selection-guard.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankWrite,
} from "./_harness/tugbank-helpers";
import { seedFixtureSession } from "./fixtures/resolve";
import {
  openFixtureSession,
  SCROLLER,
  TRANSCRIPT,
  waitForTranscriptSettled,
} from "./fixtures/runner";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

/** Minimum characters a probe line needs to hold four distinct hit points. */
const MIN_PROBE_LENGTH = 60;

/** Let the selection settle between trusted gestures. */
const GESTURE_SETTLE_MS = 220;

function settle(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

interface ProbeLine {
  /** Full text of the chosen text node. */
  text: string;
  /** Character offset each named hit point resolves to. */
  offsets: Record<string, number>;
}

interface HitPoint {
  x: number;
  y: number;
  /** True when the document hit-tests these coordinates back to the probe. */
  hitsProbe: boolean;
}

interface SelectionState {
  /** True when there is no selection, or it is collapsed to a caret. */
  empty: boolean;
  /** Index path from the transcript root to the anchor (base) node. */
  anchorKey: string;
  anchorOffset: number;
  /** Index path from the transcript root to the focus (extent) node. */
  focusKey: string;
  focusOffset: number;
  /** True when the extent precedes the base in document order. */
  backward: boolean;
  text: string;
  /** The character immediately before the selection, "" at a text edge. */
  charBefore: string;
  /** The character immediately after the selection, "" at a text edge. */
  charAfter: string;
  /** Human-readable state, surfaced in failure messages. */
  detail: string;
}

/** Named hit points, in ascending character order within the probe node. */
const HIT_NAMES = ["back", "base", "rebase", "mid", "far"] as const;

/**
 * Pick an on-screen prose text node in the transcript and name one character
 * offset per entry of {@link HIT_NAMES}, each inside a distinct word.
 *
 * Word interiors matter: leg 4 double-clicks a hit point and expects a word
 * to be selected, and a point on whitespace would select nothing.
 *
 * Only the node and its offsets are fixed here — viewport points are derived
 * per click by {@link pointForOffsetScript}, because the transcript keeps
 * settling its row heights after the first paint and a point measured earlier
 * can land on different content by the time the gesture is posted.
 *
 * The chosen node is stashed on `window.__probeNode` so later reads can name
 * it without re-walking the tree.
 */
function findProbeScript(): string {
  return `(function(){
    var root = document.querySelector(${JSON.stringify(TRANSCRIPT)});
    if (root === null) return "__NO_ROOT__";
    var names = ${JSON.stringify(HIT_NAMES)};
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    var examined = 0;
    while (walker.nextNode() !== null) {
      var candidate = walker.currentNode;
      var content = candidate.textContent || "";
      if (content.trim().length < ${MIN_PROBE_LENGTH}) continue;
      examined += 1;

      // Interior offset of each word long enough to hit reliably.
      var wordRe = /[A-Za-z][A-Za-z]{3,}/g;
      var interiors = [];
      var m;
      while ((m = wordRe.exec(content)) !== null) {
        interiors.push(m.index + Math.floor(m[0].length / 2));
      }
      if (interiors.length < names.length) continue;

      var offsets = {};
      for (var n = 0; n < names.length; n++) offsets[names[n]] = interiors[n];
      window.__probeNode = candidate;
      return { text: content, offsets: offsets };
    }
    return "__NO_PROBE__ examined=" + examined;
  })()`;
}

/**
 * Live viewport point for one probe offset, measured now, plus the hit test
 * that point resolves to. `hitsProbe` is the guard against a stale
 * measurement: it re-asks the document what is actually at those coordinates.
 *
 * The probe is re-centered when it has drifted out of the scrollport — the
 * transcript keeps re-pinning its bottom as the card settles, and a DOM
 * position stays valid across a scroll even though its coordinates do not.
 */
function pointForOffsetScript(offset: number): string {
  return `(function(){
    var node = window.__probeNode;
    var scroller = document.querySelector(${JSON.stringify(SCROLLER)});
    if (node === undefined || node === null || !node.isConnected) return "__PROBE_GONE__";
    if (scroller === null) return "__NO_SCROLLER__";
    var r = document.createRange();
    r.setStart(node, ${offset});
    r.setEnd(node, ${offset} + 1);
    function measure() {
      var view = scroller.getBoundingClientRect();
      var cr = r.getBoundingClientRect();
      if (cr.width <= 0 || cr.height <= 0) return null;
      if (cr.top < view.top + 4 || cr.bottom > view.bottom - 4) return null;
      if (cr.left < view.left + 4 || cr.right > view.right - 4) return null;
      return cr;
    }
    var cr = measure();
    if (cr === null) {
      var host = node.parentElement;
      if (host !== null) host.scrollIntoView({ block: "center" });
      cr = measure();
    }
    if (cr === null) return "__OFF_SCREEN__";
    var x = Math.round(cr.left + cr.width / 2);
    var y = Math.round(cr.top + cr.height / 2);
    var hitNode = null;
    if (typeof document.caretPositionFromPoint === "function") {
      var pos = document.caretPositionFromPoint(x, y);
      if (pos !== null) hitNode = pos.offsetNode;
    } else if (typeof document.caretRangeFromPoint === "function") {
      var hr = document.caretRangeFromPoint(x, y);
      if (hr !== null) hitNode = hr.startContainer;
    }
    return { x: x, y: y, hitsProbe: hitNode === node };
  })()`;
}

const READ_SELECTION = `(function(){
  var root = document.querySelector(${JSON.stringify(TRANSCRIPT)});
  var sel = window.getSelection();
  function key(node) {
    if (node === null || root === null || !root.contains(node)) return "__outside__";
    var path = [];
    var cur = node;
    while (cur !== null && cur !== root) {
      var parent = cur.parentNode;
      if (parent === null) return "__detached__";
      path.unshift(Array.prototype.indexOf.call(parent.childNodes, cur));
      cur = parent;
    }
    return path.join("/");
  }
  if (sel === null || sel.rangeCount === 0) {
    return { empty: true, anchorKey: "", anchorOffset: -1, focusKey: "", focusOffset: -1,
             backward: false, text: "", charBefore: "", charAfter: "", detail: "no-range" };
  }
  var r = sel.getRangeAt(0);
  var backward =
    sel.anchorNode !== null && sel.focusNode !== null &&
    (sel.anchorNode === sel.focusNode
      ? sel.focusOffset < sel.anchorOffset
      : (sel.anchorNode.compareDocumentPosition(sel.focusNode) & Node.DOCUMENT_POSITION_PRECEDING) !== 0);
  function charAt(node, offset, delta) {
    if (node === null || node.nodeType !== Node.TEXT_NODE) return "";
    var text = node.textContent || "";
    var i = delta < 0 ? offset - 1 : offset;
    return i >= 0 && i < text.length ? text.charAt(i) : "";
  }
  var state = {
    empty: sel.isCollapsed,
    anchorKey: key(sel.anchorNode),
    anchorOffset: sel.anchorOffset,
    focusKey: key(sel.focusNode),
    focusOffset: sel.focusOffset,
    backward: backward,
    text: sel.toString(),
    charBefore: charAt(r.startContainer, r.startOffset, -1),
    charAfter: charAt(r.endContainer, r.endOffset, 1),
    detail: "",
  };
  state.detail =
    "anchor=" + state.anchorKey + ":" + state.anchorOffset +
    " focus=" + state.focusKey + ":" + state.focusOffset +
    " backward=" + state.backward +
    " text=" + JSON.stringify(state.text.slice(0, 48));
  return state;
})()`;

/** Read the live selection, relative to the probe text node. */
function readSelection(
  app: Awaited<ReturnType<typeof launchTugApp>>,
): Promise<SelectionState> {
  return app.evalJS<SelectionState>(READ_SELECTION);
}

/** Word boundary set mirrored from `selection-extension.ts`. */
function isWordBoundary(ch: string): boolean {
  if (ch === "") return true;
  return /[\s!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(ch);
}

describe.skipIf(!SHOULD_RUN)(
  "at0298: shift-click extends a transcript selection from a fixed base",
  () => {
    test(
      "base holds across direction flips and granularity sticks",
      async () => {
        const tugbankPath = mkTempTugbank();
        seedTugbankForLaunch(tugbankPath);
        const seeded = await seedFixtureSession(
          "session-transcript-basic",
          "at0298",
        );
        tugbankWrite(
          tugbankPath,
          "dev.tugapp.dev",
          "recent-projects",
          "json",
          JSON.stringify({ paths: [seeded.projectDir] }),
        );

        const app = await launchTugApp({
          testName: "at0298-transcript-shift-extend",
          env: { TUGBANK_PATH: tugbankPath },
          skipAccessibilityPreflight: true,
        });
        try {
          await openFixtureSession(app, seeded);
          await waitForTranscriptSettled(app);

          const probe = await app.evalJS<ProbeLine | string>(findProbeScript());
          if (typeof probe === "string") {
            throw new Error(`no usable probe text in the transcript: ${probe}`);
          }
          const line = probe;
          expect(line.text.length).toBeGreaterThanOrEqual(MIN_PROBE_LENGTH);

          /**
           * Measure `name`'s point, retrying until two consecutive reads
           * agree. The transcript re-pins its bottom as the card settles, and
           * a point measured during that motion is stale by the time the
           * trusted click is posted.
           */
          const pointFor = async (
            name: (typeof HIT_NAMES)[number],
          ): Promise<{ x: number; y: number }> => {
            let previous: HitPoint | null = null;
            for (let attempt = 0; attempt < 12; attempt++) {
              const measured = await app.evalJS<HitPoint | string>(
                pointForOffsetScript(line.offsets[name]!),
              );
              if (typeof measured !== "string" && measured.hitsProbe) {
                if (
                  previous !== null &&
                  previous.x === measured.x &&
                  previous.y === measured.y
                ) {
                  return { x: measured.x, y: measured.y };
                }
                previous = measured;
              } else {
                previous = null;
              }
              await settle(150);
            }
            throw new Error(`probe point "${name}" never settled`);
          };

          const click = async (
            name: (typeof HIT_NAMES)[number],
            shift: boolean,
          ): Promise<void> => {
            const viewportPoint = await pointFor(name);
            if (shift) {
              await app.holdModifier(["shift"], async (inner) => {
                await inner.rpcCall<void>("nativeClick", { viewportPoint });
              });
            } else {
              await app.nativeClick(viewportPoint);
            }
            await settle(GESTURE_SETTLE_MS);
          };

          // Absorb the card-activation click: the first press into a
          // background card activates it, and the layout settles afterwards.
          await click("base", false);
          await settle(GESTURE_SETTLE_MS);

          // ── Leg 1: forward extension from a plain-click base. ──
          await click("base", false);
          const afterPlain = await readSelection(app);
          // The unshifted press leaves a caret, not a range — the base the
          // shifted press pivots on comes from the controller, not from a
          // leftover selection.
          expect(afterPlain.empty, afterPlain.detail).toBe(true);
          await click("far", true);

          const forward = await readSelection(app);
          expect(forward.empty, forward.detail).toBe(false);
          expect(forward.backward, forward.detail).toBe(false);
          const baseKey = forward.anchorKey;
          const baseOffset = forward.anchorOffset;
          expect(baseKey).not.toBe("__outside__");

          // ── Leg 2: shift-click BEHIND the base keeps the base pinned. ──
          await click("back", true);

          const backward = await readSelection(app);
          expect(backward.empty, backward.detail).toBe(false);
          // The load-bearing assertion: the base did not move when the extent
          // crossed to the other side of it.
          expect(backward.anchorKey, backward.detail).toBe(baseKey);
          expect(backward.anchorOffset, backward.detail).toBe(baseOffset);
          expect(backward.backward, backward.detail).toBe(true);

          // ── Leg 3: a plain press re-bases. ──
          await click("rebase", false);
          await click("far", true);

          const rebased = await readSelection(app);
          expect(rebased.empty, rebased.detail).toBe(false);
          expect(
            rebased.anchorKey !== baseKey || rebased.anchorOffset !== baseOffset,
            `base should have moved: ${rebased.detail}`,
          ).toBe(true);

          // ── Leg 4: word granularity survives the extension. ──
          const wordPoint = await pointFor("mid");
          await app.nativeDoubleClick(wordPoint);
          await settle(GESTURE_SETTLE_MS);
          const word = await readSelection(app);
          expect(word.empty, `double-click selected nothing: ${word.detail}`).toBe(false);
          await click("far", true);

          const granular = await readSelection(app);
          expect(granular.empty, granular.detail).toBe(false);
          // Both ends sit on word boundaries: the character just outside each
          // end is whitespace or punctuation (or the edge of its text node).
          expect(isWordBoundary(granular.charBefore), `start: ${granular.detail}`).toBe(true);
          expect(isWordBoundary(granular.charAfter), `end: ${granular.detail}`).toBe(true);
        } finally {
          await app.quitGracefully();
          seeded.cleanup();
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
