/**
 * at0619-session-dot-overlay.test.ts — the composer chip's phase dot is alive,
 * and the chip is still an atom.
 *
 * ## What this gates
 *
 * The session chip is a Canvas bake inside an `<img>` because `<img>` is one of
 * the few elements WebKit's editing engine treats as atomic — the caret steps
 * over it, a shift-arrow takes the whole thing, a backspace removes it whole.
 * Everything that could have carried live DOM instead loses that at the
 * keyboard. But a bake is a snapshot, and the phase dot is the one part of the
 * chip that has to keep moving.
 *
 * So the dot left the bitmap. The bake paints the pill, its hairline and its
 * label and skips the dot, recording where it would have gone; a CodeMirror
 * layer above the content seats the real `SessionPhaseDot` over that well. The
 * chip is byte-for-byte the `<img>` it always was, and the layer sits outside
 * `.cm-content` entirely.
 *
 * Every claim below needs the real app: a real layout to register against, a
 * real animation frame to register *in*, and WebKit's real editing engine to
 * take the chip away.
 *
 *   A. **The dot is seated on the well, at rest.** One chip, one host, one dot
 *      in it, centre-to-centre on the well the chip recorded.
 *
 *   B. **And it stays seated while the chip moves.** Typing in front of the
 *      chip pushes it along the line, and the host follows in the frame the
 *      text moved. Registration is judged **as painted**: a read taken
 *      synchronously after a keystroke lands between the DOM mutation and the
 *      layer's frame and is stale by design, so the sampler arms on each
 *      content mutation and reads in a task after the following frame has
 *      rendered. Sampling the other way is how a correct overlay reads broken.
 *
 *   C. **The chip is still an atom, and the host goes with it.** One
 *      ArrowRight crosses the chip as a unit; one Backspace takes the whole
 *      chip; and the host is gone in the next frame. A live mark that outlived
 *      its chip would be the whole design failing in the one way it can.
 *
 *   D. **A reference that resolves to nothing wears an inert dot.** The rule
 *      the mounted pill already applies, read off the overlay: a chip nothing
 *      can answer for gets a forced-idle mark in the muted ink rather than a
 *      phase this client cannot know — and rather than no mark at all, which
 *      is what `elsewhere` gets. Assertable here precisely because this
 *      harness binds synthetically and no server answers the verdict ask, so
 *      every composer chip in it resolves to nothing.
 *
 *   E. **The mark is bounded by the pill it stands in.** The enclosure did not
 *      go away when the dot left the bitmap — the 22px pill is still painted
 *      around the well — so the host publishes the same `ATOM_DOT_REACH` cap
 *      the live pill does. Uncapped, the ring is thrown past the opening and
 *      the halo crosses the hairline a moment after every beat.
 *
 *   F. **The selected face keeps the well empty.** A selection over the chip
 *      re-bakes it, and a re-bake that painted the dot would put a static mark
 *      back under the live one for as long as the selection covered it. The
 *      host takes the selected ink from outside the chip, where no cascade
 *      reaches it.
 *
 * What this does NOT gate is the breath itself. The dot is the same
 * `SessionPhaseDot` every other surface mounts, so a session mid-turn breathes
 * here too — but a verdict the harness cannot settle means no chip here ever
 * reaches a live phase, and the claim that matters anyway is that the breath
 * runs on the COMPOSITOR: checked by freezing the page's main thread and
 * photographing the dot at two points in the freeze, which is a human check
 * rather than an assertion.
 *
 * The paste is driven through a `ClipboardEvent` carrying the private
 * `application/x-tug-atoms` sidecar, which is the one path that puts a chip
 * naming a *chosen* session into the composer without a copy gesture in front
 * of it.
 *
 * Foreground: the typing and the editing gestures want a key window.
 *
 * @foreground
 *
 * @covers tugdeck/src/lib/session-dot-overlay.ts
 * @covers tugdeck/src/lib/tug-atom-img.ts
 * @covers tugdeck/src/lib/atom-register.ts
 * @covers tugdeck/src/components/tugways/tug-text-editor/session-dot-layer.tsx
 * @covers tugdeck/src/components/tugways/tug-text-editor/atom-decoration.ts
 * @covers tugdeck/src/components/tugways/tug-text-editor.tsx
 * @covers tugdeck/src/components/tugways/session-phase-dot.tsx
 */

import { describe, expect, test } from "bun:test";

import { launchTugApp, note } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const SESSION_ID = "aa11bb22-0000-4000-8000-0000000a0619";
const TAG = "brisk-lantern";
const PROJECT_DIR = "/Users/tester/src/tugtool";
const VALUE = `tugtool/${TAG}`;

const COMPOSER = '[data-card-id="A"] [data-slot="tug-text-editor"] .cm-content';
const LAYER = ".cm-tug-session-dot-layer";
const HOST = ".cm-tug-session-dot-host";
const CHIP = `${COMPOSER} img[data-atom-well-x]`;

/** The sidecar a copy of one session atom would have written. */
const SIDECAR = JSON.stringify({
  version: 1,
  text: "￼",
  atoms: [
    {
      position: 0,
      segment: {
        kind: "atom",
        type: "session",
        label: VALUE,
        value: VALUE,
        session: { id: SESSION_ID, projectDir: PROJECT_DIR },
      },
    },
  ],
});

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 20, y: 20 },
        size: { width: 760, height: 460 },
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

/**
 * The chip's well and its host's centre, in viewport coordinates.
 *
 * Written as source rather than a helper because it is evaluated inside the
 * app, both directly and from the sampler in B.
 */
const READ_OFFSET = `(function(){
  var img = document.querySelector(${JSON.stringify(CHIP)});
  var host = document.querySelector(${JSON.stringify(LAYER + " " + HOST)});
  if (img === null || host === null) return null;
  var ir = img.getBoundingClientRect();
  var hr = host.getBoundingClientRect();
  return {
    dx: hr.left + hr.width / 2
      - (ir.left + parseFloat(img.getAttribute('data-atom-well-x'))),
    dy: hr.top + hr.height / 2
      - (ir.top + parseFloat(img.getAttribute('data-atom-well-y'))),
  };
})()`;

describe.skipIf(!SHOULD_RUN)("at0619 — the live dot in the composer chip", () => {
  test(
    "the dot seats on the chip's well, follows it while typing, and leaves with it",
    async () => {
      const app = await launchTugApp({
        testName: "at0619-session-dot-overlay",
        foreground: true,
      });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.bindSession("A", {
          tugSessionId: SESSION_ID,
          projectDir: PROJECT_DIR,
        });
        await app.evalJS<boolean>(
          `window.__tug.publishSessionUpdated(${JSON.stringify(
            JSON.stringify({
              session_id: SESSION_ID,
              fields: { tag: TAG, name: null, name_user_set: false },
            }),
          )})`,
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(COMPOSER)}) !== null`,
          { timeoutMs: 20_000 },
        );

        // ---- The chip, pasted as a real sidecar paste. --------------------
        //
        // A `ClipboardEvent` carrying the private MIME is the branch a Tug-to-Tug
        // paste lands in when the pasteboard bridge is not in play, and it is
        // the one way to put a chip naming a CHOSEN session in the composer
        // without a copy gesture in front of it.
        await app.focusElement(COMPOSER);
        await app.evalJS<null>(`(function(){
          var cm = document.querySelector(${JSON.stringify(COMPOSER)});
          var dt = new DataTransfer();
          dt.setData("text/plain", ${JSON.stringify(VALUE)});
          dt.setData("application/x-tug-atoms", ${JSON.stringify(SIDECAR)});
          cm.dispatchEvent(new ClipboardEvent("paste", {
            bubbles: true, cancelable: true, clipboardData: dt,
          }));
          return null;
        })()`);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CHIP)}) !== null`,
          { timeoutMs: 8_000 },
        );

        // ---- A. Seated on the well, at rest. ------------------------------
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(LAYER + " " + HOST)}) !== null`,
          { timeoutMs: 8_000 },
        );
        const atRest = await app.evalJS<{
          hosts: number;
          dots: number;
          dx: number;
          dy: number;
          glyphDx: number;
          glyphDy: number;
        }>(
          `(function(){
            var layer = document.querySelector(${JSON.stringify(LAYER)});
            var host = layer.querySelector(${JSON.stringify(HOST)});
            var o = ${READ_OFFSET};
            // The glyph inside the host, against the well: the host can be
            // seated exactly and still show the mark low if the indicator
            // sits on a line box inside it rather than being centred.
            var img = document.querySelector(${JSON.stringify(CHIP)});
            var ir = img.getBoundingClientRect();
            var g = host.querySelector('[data-slot="tug-progress-pulsing-dot"]').getBoundingClientRect();
            return {
              hosts: layer.children.length,
              dots: host.childElementCount,
              dx: o.dx,
              dy: o.dy,
              glyphDx: g.left + g.width / 2
                - (ir.left + parseFloat(img.getAttribute('data-atom-well-x'))),
              glyphDy: g.top + g.height / 2
                - (ir.top + parseFloat(img.getAttribute('data-atom-well-y'))),
            };
          })()`,
        );
        note("at0619 at rest", JSON.stringify(atRest));
        // One chip in the composer, one host over it, one dot in the host.
        expect(atRest.hosts).toBe(1);
        expect(atRest.dots).toBe(1);
        // Seated on the well, not near it. Sub-pixel, because the well is a
        // CSS-px centre the bake computed and the host is placed from it.
        expect(Math.abs(atRest.dx)).toBeLessThan(0.5);
        expect(Math.abs(atRest.dy)).toBeLessThan(0.5);
        // And the MARK is seated, not just its host: the glyph's own box is
        // centred on the well too.
        expect(Math.abs(atRest.glyphDx)).toBeLessThan(0.5);
        expect(Math.abs(atRest.glyphDy)).toBeLessThan(0.5);

        // ---- D. The reference that resolves to nothing wears an inert dot. -
        //
        // The mounted pill's rule, applied to the overlay: a chip nothing can
        // answer for gets a forced-idle mark in the muted ink rather than a
        // phase it cannot know — and rather than no mark at all, which is what
        // `elsewhere` gets. This harness binds a session synthetically and no
        // server answers the verdict ask, so every composer chip here resolves
        // to nothing; that is what makes this the claim the harness can make,
        // and it is the one that would otherwise go unpinned.
        //
        // The other half — that a session IN a turn breathes, on the
        // compositor rather than the main thread — is not assertable here. It
        // is checked by freezing the page's main thread and photographing the
        // dot at two points in the freeze, which is a human check.
        await app.driveSession("A", { op: "send", text: "at0619 opening turn" });
        const breath = await app.evalJS<{
          phase: string;
          hostMissing: string;
          hostSession: string;
          chipVariant: string;
          masthead: string;
          breathing: string;
          animation: string;
        }>(
          `(function(){
            var host = document.querySelector(${JSON.stringify(LAYER + " " + HOST)});
            var root = host.querySelector('[data-slot="tug-progress-pulsing-dot"]');
            var inner = root === null
              ? null : root.querySelector('.tug-progress-pulsing-dot-dot');
            return {
              phase: host.firstElementChild.getAttribute('data-phase') || "",
              hostMissing: host.getAttribute('data-missing') || "",
              hostSession: host.getAttribute('data-session-id') || "",
              chipVariant: document.querySelector(
                ${JSON.stringify(CHIP)}).dataset.chipVariant || "",
              masthead: (function(){
                var m = document.querySelector(
                  '[data-slot="session-masthead"] [data-slot="tug-progress-indicator"]');
                return m === null ? "absent" : (m.getAttribute('data-phase') || "");
              })(),
              breathing: root === null
                ? "absent" : String(root.dataset.breathing !== undefined),
              animation: inner === null
                ? "no inner" : getComputedStyle(inner).animationName,
            };
          })()`,
        );
        note("at0619 breath", JSON.stringify(breath));
        // The chip resolves to nothing, so the host says so...
        expect(breath.chipVariant).toBe("missing");
        expect(breath.hostMissing).toBe("true");
        // ...and mounts a still mark rather than leaving the well empty.
        expect(breath.breathing).toBe("false");
        expect(breath.phase).toBe("idle");
        // While the card's own session is demonstrably mid-turn — which is
        // what makes the inert dot a decision rather than an absence of one.
        expect(breath.masthead).not.toBe("idle");

        // ---- E. The mark is bounded by the pill it stands in. ------------
        //
        // The enclosure did not go away when the dot left the bitmap: the
        // chip's 22px pill is still painted around the well, two pixels from
        // where the ring ends. The live pill publishes `ATOM_DOT_REACH` on its
        // own box for exactly that reason, and the host is the same bounded
        // caller — uncapped, the glyph throws its ring past the opening and
        // the halo crosses the hairline a moment after every beat.
        const bounded = await app.evalJS<{ reach: string; envelope: number }>(
          `(function(){
            var host = document.querySelector(${JSON.stringify(LAYER + " " + HOST)});
            var reach = getComputedStyle(host)
              .getPropertyValue('--tugx-progress-pulsing-dot-emit-reach').trim();
            return {
              reach: reach,
              envelope: parseFloat(host.style.width) * parseFloat(reach || "0"),
            };
          })()`,
        );
        note("at0619 mark bounds", JSON.stringify(bounded));
        // 4/3 — `(the pill's opening − 2 × clearance) ÷ box`, the number
        // `atom-register` derives and `atom-register.test` holds the
        // arithmetic for.
        expect(Number.parseFloat(bounded.reach)).toBeCloseTo(4 / 3, 4);
        // And what that comes to in pixels still clears the 22px pill's 20px
        // opening by the 2px of air the rule asks for.
        expect(bounded.envelope).toBeLessThanOrEqual(22 - 2 * 1 - 2 * 2);

        // ---- F. The selected face keeps the well empty. -------------------
        //
        // A selection over the chip re-bakes it, and a re-bake that painted
        // the dot would put a static mark back UNDER the live one for exactly
        // as long as the selection covered it. The `<img>`'s own well
        // attribute is the only memory of the resting bake's choice, and the
        // host takes the selected ink from outside the chip, where no cascade
        // reaches it.
        await app.nativeKey("a", ["cmd"]);
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CHIP)})
             .dataset.selected === "true"`,
          { timeoutMs: 8_000 },
        );
        const selected = await app.evalJS<{
          hostSelected: string;
          wellAlpha: number;
        }>(
          `(function(){
            var img = document.querySelector(${JSON.stringify(CHIP)});
            var host = document.querySelector(${JSON.stringify(LAYER + " " + HOST)});
            var c = document.createElement("canvas");
            c.width = img.naturalWidth; c.height = img.naturalHeight;
            var g = c.getContext("2d");
            g.drawImage(img, 0, 0);
            var device = img.naturalWidth / img.width;
            return {
              hostSelected: host.getAttribute('data-selected') || "",
              wellAlpha: g.getImageData(
                Math.round(
                  parseFloat(img.getAttribute('data-atom-well-x')) * device),
                Math.round(
                  parseFloat(img.getAttribute('data-atom-well-y')) * device),
                1, 1).data[3],
            };
          })()`,
        );
        note("at0619 selected face", JSON.stringify(selected));
        // The host wears the flag, so the theme paints the mark in the token
        // authored to stay legible over the blue wash.
        expect(selected.hostSelected).toBe("true");
        // And the selected bitmap's well is as empty as the resting one's.
        expect(selected.wellAlpha).toBeLessThan(16);
        // Collapse the selection to the start, which is where B types from.
        await app.nativeKey("ArrowLeft");

        // ---- B. Still seated while the chip moves. ------------------------
        //
        // The sampler arms on each content mutation and reads in a task AFTER
        // the following frame has rendered — which is the only read that
        // describes what anybody saw. A synchronous post-keystroke read lands
        // between the DOM mutation and the layer's measure frame and reports a
        // whole character of offset that never reached the screen.
        await app.evalJS<null>(`(function(){
          window.__at0619 = { samples: [], armed: false };
          var cm = document.querySelector(${JSON.stringify(COMPOSER)});
          var obs = new MutationObserver(function(){
            if (window.__at0619.armed) return;
            window.__at0619.armed = true;
            requestAnimationFrame(function(){
              setTimeout(function(){
                window.__at0619.armed = false;
                var o = ${READ_OFFSET};
                if (o !== null) window.__at0619.samples.push(o);
              }, 0);
            });
          });
          obs.observe(cm, { childList: true, subtree: true, characterData: true });
          window.__at0619.stop = function(){ obs.disconnect(); };
          return null;
        })()`);
        // Typed in FRONT of the chip: the caret is already at offset 0 of the
        // paste's line only if we put it there, so go home first.
        await app.nativeKey("Home");
        const TYPED = "registration";
        for (const ch of TYPED) {
          await app.nativeType(ch);
        }
        await app.waitForCondition<boolean>(
          `Array.from(document.querySelectorAll(
             ${JSON.stringify(COMPOSER)} + ' .cm-line'))
             .map(function(l){ return l.textContent || ""; }).join("")
             .indexOf(${JSON.stringify("registration")}) >= 0`,
          { timeoutMs: 8_000 },
        );
        await app.waitForCondition<boolean>(
          `window.__at0619.samples.length > 0`,
          { timeoutMs: 8_000 },
        );
        const samples = await app.evalJS<ReadonlyArray<{ dx: number; dy: number }>>(
          `(function(){ window.__at0619.stop(); return window.__at0619.samples; })()`,
        );
        note(
          "at0619 painted offsets",
          `${samples.length} samples, max |dx| ${Math.max(
            0,
            ...samples.map((s) => Math.abs(s.dx)),
          )}, max |dy| ${Math.max(0, ...samples.map((s) => Math.abs(s.dy)))}`,
        );
        // Every painted frame had the dot on the well. One sample off by a
        // character width is the stale read this sampler exists to avoid; one
        // off by anything else is a registration bug.
        for (const sample of samples) {
          expect(Math.abs(sample.dx)).toBeLessThan(0.5);
          expect(Math.abs(sample.dy)).toBeLessThan(0.5);
        }
        // And the text landed in front of the chip, which is what made it move.
        const line = await app.evalJS<string>(
          `Array.from(document.querySelectorAll(
             ${JSON.stringify(COMPOSER)} + ' .cm-line'))
             .map(function(l){ return l.textContent || ""; }).join("")`,
        );
        expect(line).toContain(TYPED);

        // ---- C. The chip is an atom, and the host leaves with it. ---------
        //
        // The caret is behind the typed text; one ArrowRight crosses the chip
        // as a unit (it is one document position), and one Backspace takes the
        // whole chip rather than a piece of it. That is the img-grade editing
        // contract this whole design exists to keep.
        await app.nativeKey("ArrowRight");
        await app.nativeKey("Backspace");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(CHIP)}) === null`,
          { timeoutMs: 8_000 },
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(LAYER + " " + HOST)}) === null`,
          { timeoutMs: 8_000 },
        );
        const after = await app.evalJS<{ chips: number; hosts: number; text: string }>(
          `(function(){
            var layer = document.querySelector(${JSON.stringify(LAYER)});
            return {
              chips: document.querySelectorAll(${JSON.stringify(CHIP)}).length,
              hosts: layer === null ? 0 : layer.children.length,
              text: Array.from(document.querySelectorAll(
                ${JSON.stringify(COMPOSER)} + ' .cm-line'))
                .map(function(l){ return l.textContent || ""; }).join(""),
            };
          })()`,
        );
        note("at0619 after delete", JSON.stringify(after));
        expect(after.chips).toBe(0);
        // The host went with it. A live mark left standing over nothing is the
        // one failure this design can produce that the chip alone cannot.
        expect(after.hosts).toBe(0);
        // And only the chip went: the text typed in front of it is untouched.
        expect(after.text).toContain(TYPED);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
