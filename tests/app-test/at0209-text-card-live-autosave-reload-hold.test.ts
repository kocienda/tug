/**
 * at0209-text-card-live-autosave-reload-hold.test.ts — an in-place reload of
 * a Text card holds the text at the viewport top ([AT0209]).
 *
 * One piece of the at0209 split; the fixtures, deck shape and gestures are
 * `text-card-live-autosave-fixture.ts`.
 *
 * 3. **A reload holds the reader's place.** A tall file scrolled to a real
 *    mid-document offset; the conflict banner's reload adopts an external
 *    write that inserts a line above the viewport, and the line at the top
 *    does not move.
 *
 * 3b. **A reload that lands in the frame of the scroll.** The same viewport
 *    hold with no frame between the scroll and the reload, so CM6 has not
 *    measured the new offset when the change is dispatched. Carries a
 *    per-frame sampler of the top line, and asserts the text held on every
 *    frame rather than only on the last one — the hop used to happen and
 *    self-correct, which is what made Scenario 3 marginal.
 *
 * 3c. **A reload with the page's frames held.** The same one-task reload,
 *    with `requestAnimationFrame` replaced by one that holds its callbacks —
 *    so the interval between CM6's synchronous DOM write and its
 *    frame-scheduled scroll-anchor correction is held open and the top line
 *    is read inside it. With no frame callback having run the text must
 *    ALREADY be at the top, which is the flash of 3b's trace made
 *    deterministic rather than load-dependent.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/cards/text-card.tsx
 * @covers tugdeck/src/lib/text-card-store.ts
 * @covers tugdeck/src/lib/file-io.ts
 * @covers tugdeck/src/components/tugways/tug-text-card-editor/
 * @covers tugdeck/src/components/tugways/tug-text-card-editor.css
 * @covers tugdeck/src/components/tugways/tug-text-card-editor.tsx
 * @family at0209-text-card-live-autosave
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { launchTugApp, note } from "./_harness";
import { AUTOMATIC_SAVE_MODE, mkSeededTugbank } from "./_harness/tugbank-helpers";
import {
  EDITOR_SCROLLER_SELECTOR,
  SHOULD_RUN,
  TALL_CONTENT,
  TEST_TIMEOUT_MS,
  mkTallFixture,
  rmFixture,
  seedTextCard,
  typeIntoEditor,
  waitForDisk,
  waitForEditorShowing,
} from "./text-card-live-autosave-fixture";

describe.skipIf(!SHOULD_RUN)("at0209: Text card live autosave", () => {
  // -------------------------------------------------------------------------
  // Scenario 3: in-place reload holds the reader's place
  // -------------------------------------------------------------------------
  //
  // An in-place disk reload (here the conflict-banner "Reload from Disk",
  // which routes through the store's `replaceText` bridge) must leave the
  // TEXT at the top of the viewport where it was. The external writer here
  // adds a line ABOVE the viewport, which is what tells the two possible
  // answers apart: holding the pixel `scrollTop` would slide every visible
  // line down by one row, and holding the text moves `scrollTop` by exactly
  // that row. `replaceText` dispatches the minimal change set, so CM6 maps
  // its own scroll anchor through the insertion and the text does not move.
  //
  // Only scroll is asserted here: CM6 owns the selection (it resets any
  // DOM-seated range back to its own state, and `window.getSelection()`
  // doesn't reflect the editor's selection through the harness), so a
  // multi-char selection can't be seated/read from an app-test. The selection
  // is mapped through the same change set by CM6 itself.
  test(
    "in-place reload holds the text at the viewport top",
    async () => {
      const { dir, file } = mkTallFixture();
      const app = await launchTugApp({ testName: "at0209-reload-restore", env: { TUGBANK_PATH: mkSeededTugbank([AUTOMATIC_SAVE_MODE]) } });
      try {
        await seedTextCard(app, file);
        await waitForEditorShowing(app, "tall line 001");

        // Drive to a conflict: flush a local edit to disk, change the file
        // externally, then edit again so the conditional write 409s into the
        // banner (the same setup Scenario 1 proves). The external content is
        // itself tall, so a mid-document scrollTop stays valid after reload.
        await typeIntoEditor(app, "EDIT1 ");
        await waitForDisk(file, (c) => c.includes("EDIT1"));
        const EXTERNAL = "EXTERNAL-WRITER LINE\n" + TALL_CONTENT;
        fs.writeFileSync(file, EXTERNAL, "utf8");
        await typeIntoEditor(app, "EDIT2 ");
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector('[data-testid="text-card-conflict-reload"]') !== null`,
          { timeoutMs: 8000 },
        );

        // Park the viewport at a real mid-document offset, then read WHICH
        // line sits at the viewport top and how far down its row starts.
        await app.body("A").evalJS<null>(
          `(document.querySelector('${EDITOR_SCROLLER_SELECTOR}').scrollTop = 900, null)`,
        );
        const readTop = `(function(){
          var scroller = document.querySelector('${EDITOR_SCROLLER_SELECTOR}');
          var box = scroller.getBoundingClientRect();
          var lines = scroller.querySelectorAll('.cm-line');
          for (var i = 0; i < lines.length; i++) {
            var r = lines[i].getBoundingClientRect();
            if (r.bottom > box.top + 1) {
              return { text: lines[i].textContent, delta: r.top - box.top, scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight };
            }
          }
          return null;
        })()`;
        await app.body("A").waitForCondition<boolean>(
          `(function(){ var t = ${readTop}; return t !== null && t.scrollTop > 200 && t.text.indexOf("tall line") === 0; })()`,
          { timeoutMs: 6000 },
        );
        const before = await app.body("A").evalJS<{ text: string; delta: number; scrollTop: number; scrollHeight: number }>(readTop);

        // Reload from disk (in-place) — adopts the external content.
        await app.body("A").click('[data-testid="text-card-conflict-reload"]');
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector('[data-testid="text-card-conflict-reload"]') === null`,
          { timeoutMs: 6000 },
        );

        // The reload landed (the added row made the content taller) and the
        // same text is still at the same place.
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector('${EDITOR_SCROLLER_SELECTOR}').scrollHeight > ${before.scrollHeight} + 4`,
          { timeoutMs: 6000 },
        );
        const after = await app.body("A").evalJS<{ text: string; delta: number; scrollTop: number; scrollHeight: number }>(readTop);
        expect(after.text).toBe(before.text);
        expect(Math.abs(after.delta - before.delta)).toBeLessThanOrEqual(2);

        // And the disk content really is in the buffer.
        await app.body("A").evalJS<null>(
          `(document.querySelector('${EDITOR_SCROLLER_SELECTOR}').scrollTop = 0, null)`,
        );
        await waitForEditorShowing(app, "EXTERNAL-WRITER LINE");
      } finally {
        await app.close();
        rmFixture(dir);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Scenario 3b: the reload that lands in the frame of the scroll
  // -------------------------------------------------------------------------
  //
  // Scenario 3 above is the same behaviour with a frame to spare, and it has
  // been marginal — reading `tall line 044` where it expects `045`, off by
  // exactly one row, flipping between runs with nothing in between touching the
  // reload path. This scenario makes that window deterministic rather than
  // waiting for luck to expose it.
  //
  // The window is CM6's cached scroll offset. `ViewState.update` computes a
  // change's scroll anchor from `this.scrollOffset`, a cached copy that only a
  // measure pass refreshes, and `EditorView.measure` throws the anchor away
  // when the real offset has moved more than a pixel from the cached one. So a
  // change dispatched after a scroll but BEFORE CM6 has measured that scroll
  // gets no anchor at all: pixel `scrollTop` is held instead of the text, and
  // every visible line slides down by the inserted row. That is the `044`
  // signature exactly.
  //
  // Scenario 3 sets `scrollTop` and then clicks through the harness, which
  // costs several round trips and therefore several frames, so CM6 has usually
  // measured by the time the reload lands. Here the scroll, the reading of
  // which line is at the top, and the Reload click all happen in ONE JS task,
  // with no frame in between — `getBoundingClientRect()` flushes layout
  // synchronously, which is enough to read the DOM but is NOT a CM6 measure
  // pass. The product has the same window ([F04]): an agent writing while the
  // user scrolls takes this path, wide open for any programmatic scroll.
  //
  // A green run is not the evidence here. The scenario carries a per-frame
  // sampler of the top line's text and offset across the reload, so the trace
  // says whether the hop happened and was corrected or never happened at all,
  // and the fix is proven by a `tugtool file probe` reverting it and watching
  // this go red.
  test(
    "in-place reload holds the text when it lands in the scroll's own frame",
    async () => {
      const { dir, file } = mkTallFixture();
      const app = await launchTugApp({ testName: "at0209-reload-same-task", env: { TUGBANK_PATH: mkSeededTugbank([AUTOMATIC_SAVE_MODE]) } });
      try {
        await seedTextCard(app, file);
        await waitForEditorShowing(app, "tall line 001");

        // Same drive to a conflict banner as Scenario 3: the banner's Reload
        // button is a real in-place reload through the store's `replaceText`
        // bridge, and the external content is itself tall so a mid-document
        // scrollTop stays valid after the adopt.
        await typeIntoEditor(app, "EDIT1 ");
        await waitForDisk(file, (c) => c.includes("EDIT1"));
        const EXTERNAL = "EXTERNAL-WRITER LINE\n" + TALL_CONTENT;
        fs.writeFileSync(file, EXTERNAL, "utf8");
        await typeIntoEditor(app, "EDIT2 ");
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector('[data-testid="text-card-conflict-reload"]') !== null`,
          { timeoutMs: 8000 },
        );

        // A per-frame sampler of the top line, started BEFORE the scroll so the
        // trace covers the whole reload. Each frame records which line sits at
        // the viewport top, how far down its row starts, and the raw scrollTop
        // — enough to tell "never hopped" from "hopped and was corrected".
        await app.body("A").evalJS<null>(`(function(){
          var scroller = document.querySelector('${EDITOR_SCROLLER_SELECTOR}');
          window.__tugHopSamples = [];
          window.__tugHopStop = false;
          function topLine(){
            var box = scroller.getBoundingClientRect();
            var lines = scroller.querySelectorAll('.cm-line');
            for (var i = 0; i < lines.length; i++) {
              var r = lines[i].getBoundingClientRect();
              if (r.bottom > box.top + 1) {
                return { text: lines[i].textContent, delta: r.top - box.top, scrollTop: scroller.scrollTop };
              }
            }
            return null;
          }
          function tick(){
            if (window.__tugHopStop) return;
            var s = topLine();
            if (s !== null) window.__tugHopSamples.push(s);
            requestAnimationFrame(tick);
          }
          requestAnimationFrame(tick);
          return null;
        })()`);

        // ONE task: park the viewport, read the line at the top, and click
        // Reload — no frame, and therefore no CM6 measure pass, in between.
        const before = await app.body("A").evalJS<{
          text: string;
          delta: number;
          scrollTop: number;
          scrollHeight: number;
        }>(`(function(){
          var scroller = document.querySelector('${EDITOR_SCROLLER_SELECTOR}');
          scroller.scrollTop = 900;
          var box = scroller.getBoundingClientRect();
          var lines = scroller.querySelectorAll('.cm-line');
          var found = null;
          for (var i = 0; i < lines.length; i++) {
            var r = lines[i].getBoundingClientRect();
            if (r.bottom > box.top + 1) {
              found = { text: lines[i].textContent, delta: r.top - box.top, scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight };
              break;
            }
          }
          document.querySelector('[data-testid="text-card-conflict-reload"]').click();
          return found;
        })()`);
        expect(before).not.toBeNull();
        expect(before.text.indexOf("tall line")).toBe(0);
        expect(before.scrollTop).toBeGreaterThan(200);

        // The reload landed: banner gone and the added row made it taller.
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector('[data-testid="text-card-conflict-reload"]') === null`,
          { timeoutMs: 6000 },
        );
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector('${EDITOR_SCROLLER_SELECTOR}').scrollHeight > ${before.scrollHeight} + 4`,
          { timeoutMs: 6000 },
        );

        const readTop = `(function(){
          var scroller = document.querySelector('${EDITOR_SCROLLER_SELECTOR}');
          var box = scroller.getBoundingClientRect();
          var lines = scroller.querySelectorAll('.cm-line');
          for (var i = 0; i < lines.length; i++) {
            var r = lines[i].getBoundingClientRect();
            if (r.bottom > box.top + 1) {
              return { text: lines[i].textContent, delta: r.top - box.top, scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight };
            }
          }
          return null;
        })()`;
        const after = await app.body("A").evalJS<{
          text: string;
          delta: number;
          scrollTop: number;
          scrollHeight: number;
        }>(readTop);

        // Stop the sampler and read the trace back. It is reported whether the
        // scenario passes or fails: a green run whose trace shows the top line
        // changing and changing back is a different fact from one that never
        // moved, and only the trace can tell them apart.
        const samples = await app.body("A").evalJS<
          Array<{ text: string; delta: number; scrollTop: number }>
        >(`(function(){ window.__tugHopStop = true; return window.__tugHopSamples; })()`);
        const distinct: string[] = [];
        for (const s of samples) {
          const label = `${s.text.slice(0, 14)}@${Math.round(s.delta)}/${Math.round(s.scrollTop)}`;
          if (distinct[distinct.length - 1] !== label) distinct.push(label);
        }
        note(
          `same-task reload: top line ${JSON.stringify(before.text.slice(0, 14))} → ` +
            `${JSON.stringify(after.text.slice(0, 14))}; ${samples.length} frames sampled; ` +
            `trace ${distinct.join(" | ")}`,
        );

        // The text held its place. Holding the pixel `scrollTop` instead would
        // read one row EARLIER in the document — `tall line 044` for `045` —
        // because the external write inserted a row above the viewport.
        expect(after.text).toBe(before.text);
        expect(Math.abs(after.delta - before.delta)).toBeLessThanOrEqual(2);

        // And it held its place on EVERY frame, which is the assertion the
        // final read cannot make. Before the measure-first fix the trace read
        // `045@900 | 044@900 | 045@920`: the hop happened, was visible for a
        // frame, and the next measure pass put it back — so a final read that
        // landed after the correction saw the right answer and a final read that
        // landed during the hop saw `044`, which is the whole of Scenario 3's
        // marginality. Every sampled frame after the viewport was parked must
        // show the same top line.
        const parked = samples.filter((s) => s.scrollTop > 200);
        // A floor on the sample count, so an occluded harness window — which
        // suspends `requestAnimationFrame` — cannot turn this into an assertion
        // over an empty list that passes by seeing nothing.
        expect(parked.length).toBeGreaterThanOrEqual(2);
        const hopped = parked.filter((s) => s.text !== before.text);
        expect(
          hopped.map((s) => `${s.text.slice(0, 14)}@${Math.round(s.scrollTop)}`),
        ).toEqual([]);
        // And the disk content really is in the buffer.
        await app.body("A").evalJS<null>(
          `(document.querySelector('${EDITOR_SCROLLER_SELECTOR}').scrollTop = 0, null)`,
        );
        await waitForEditorShowing(app, "EXTERNAL-WRITER LINE");
      } finally {
        await app.close();
        rmFixture(dir);
      }
    },
    TEST_TIMEOUT_MS,
  );

  // -------------------------------------------------------------------------
  // Scenario 3c: the reload with the frames held
  // -------------------------------------------------------------------------
  //
  // Scenario 3b makes the window deterministic; it does not make the FLASH
  // deterministic. The hop it traced — `045@900 | 044@900 | 045@920` — was
  // seen exactly once, on a loaded machine, and every quiet run traces the
  // single state. A bug reproducible one run in several is not a bug under
  // test, and waiting for load is not a test plan.
  //
  // So this scenario removes the luck. CM6 applies a change's DOM write
  // synchronously in `EditorView.update` and then only calls `requestMeasure()`
  // — the scroll-anchor correction, `scroll.scrollTop += diff`, lives inside
  // `measure()`, which is scheduled on `requestAnimationFrame`. Anything that
  // paints between those two beats shows the new text at the old offset. Here
  // the page's `requestAnimationFrame` is REPLACED before the reload with one
  // that holds its callbacks, so the interval between the DOM write and the
  // frame callback is held open for as long as the test likes, and the top
  // line is read inside it.
  //
  // The assertion is therefore the whole of the fix: with the frames held and
  // no frame callback having run, the text must ALREADY be at the top. A
  // correction that arrives on a frame callback cannot satisfy it, which is
  // what makes this red before the post-dispatch measure flush and green after.
  // That is measured, not argued: a `tugtool file probe` reverting ONLY the
  // post-dispatch flush reads `tall line 044` at the microtask — the wrong row
  // at the top — where the tree as it stands reads `045`. (The raw `scrollTop`
  // in that same sample is 900 on some runs and 920 on others even when the
  // text is right, so WHICH LINE is at the top is the reading to trust and the
  // one asserted on; the offset check below is against the row's own position,
  // which is stable.)
  // Scenario 3b traced the single settled state `045 @-18/920` under that same
  // probe — which is the whole reason this scenario exists beside it, and why a
  // green run of 3b is not evidence about the flash. The stall is released
  // afterwards and the settled state is read again, so a fix that merely moved
  // the flash later still fails here.
  test(
    "in-place reload holds the text with the page's frames held",
    async () => {
      const { dir, file } = mkTallFixture();
      const app = await launchTugApp({ testName: "at0209-reload-frames-held", env: { TUGBANK_PATH: mkSeededTugbank([AUTOMATIC_SAVE_MODE]) } });
      try {
        await seedTextCard(app, file);
        await waitForEditorShowing(app, "tall line 001");

        // Same drive to the conflict banner as 3b: its Reload button is a real
        // in-place reload through the store's `replaceText` bridge.
        await typeIntoEditor(app, "EDIT1 ");
        await waitForDisk(file, (c) => c.includes("EDIT1"));
        const EXTERNAL = "EXTERNAL-WRITER LINE\n" + TALL_CONTENT;
        fs.writeFileSync(file, EXTERNAL, "utf8");
        await typeIntoEditor(app, "EDIT2 ");
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector('[data-testid="text-card-conflict-reload"]') !== null`,
          { timeoutMs: 8000 },
        );

        // Let two real frames pass first, so anything already scheduled — a
        // CM6 measure from the typing above, most of all — has run and drained.
        // What the stall holds is then the reload's own callbacks and nothing
        // that was pending before it.
        await app.body("A").evalJS<null>(`(function(){
          window.__tugFrames = 0;
          requestAnimationFrame(function(){
            window.__tugFrames++;
            requestAnimationFrame(function(){ window.__tugFrames++; });
          });
          return null;
        })()`);
        await app.body("A").waitForCondition<boolean>(`window.__tugFrames >= 2`, {
          timeoutMs: 6000,
        });

        // Install the stall. Held ids start well above any the platform is
        // handing out, so a `cancelAnimationFrame` for a pre-stall id is
        // forwarded to the real one instead of evicting a held callback by
        // collision.
        await app.body("A").evalJS<null>(`(function(){
          var stall = {
            raf: window.requestAnimationFrame.bind(window),
            cancel: window.cancelAnimationFrame.bind(window),
            held: new Map(),
            next: 1000000,
            requested: 0,
          };
          window.__tugFrameStall = stall;
          window.requestAnimationFrame = function(cb){
            var id = stall.next++;
            stall.requested++;
            stall.held.set(id, cb);
            return id;
          };
          window.cancelAnimationFrame = function(id){
            if (id >= 1000000) stall.held.delete(id);
            else stall.cancel(id);
          };
          return null;
        })()`);

        // And arm the capture of the flash window itself, from inside the
        // page. The harness's round trips are whole tasks, so a read driven
        // from the test side can only ever see the state some tasks later —
        // which is how the first draft of this scenario read a corrected top
        // line with nothing held. A `MutationObserver` on the scroller runs as
        // a MICROTASK, when the dispatch's own call stack empties: that is the
        // earliest instant the browser could paint the new text, and therefore
        // the flash window exactly. Whatever it records is what a frame landing
        // there would have shown.
        await app.body("A").evalJS<null>(`(function(){
          var scroller = document.querySelector('${EDITOR_SCROLLER_SELECTOR}');
          window.__tugFlashSample = null;
          var obs = new MutationObserver(function(){
            if (window.__tugFlashSample !== null) return;
            var box = scroller.getBoundingClientRect();
            var lines = scroller.querySelectorAll('.cm-line');
            for (var i = 0; i < lines.length; i++) {
              var r = lines[i].getBoundingClientRect();
              if (r.bottom > box.top + 1) {
                window.__tugFlashSample = { text: lines[i].textContent, delta: r.top - box.top, scrollTop: scroller.scrollTop };
                break;
              }
            }
            obs.disconnect();
          });
          obs.observe(scroller, { childList: true, subtree: true, characterData: true });
          return null;
        })()`);

        // ONE task, exactly as 3b: park the viewport, read the line at the top,
        // and click Reload. From here until the release below, no frame
        // callback can run.
        const before = await app.body("A").evalJS<{
          text: string;
          delta: number;
          scrollTop: number;
          scrollHeight: number;
        }>(`(function(){
          var scroller = document.querySelector('${EDITOR_SCROLLER_SELECTOR}');
          scroller.scrollTop = 900;
          var box = scroller.getBoundingClientRect();
          var lines = scroller.querySelectorAll('.cm-line');
          var found = null;
          for (var i = 0; i < lines.length; i++) {
            var r = lines[i].getBoundingClientRect();
            if (r.bottom > box.top + 1) {
              found = { text: lines[i].textContent, delta: r.top - box.top, scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight };
              break;
            }
          }
          document.querySelector('[data-testid="text-card-conflict-reload"]').click();
          return found;
        })()`);
        expect(before).not.toBeNull();
        expect(before.text.indexOf("tall line")).toBe(0);
        expect(before.scrollTop).toBeGreaterThan(200);

        // The reload landed — banner gone and the inserted row made the
        // document taller. Both are synchronous consequences of CM6's DOM
        // write, so neither needs a frame to become true.
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector('[data-testid="text-card-conflict-reload"]') === null`,
          { timeoutMs: 6000 },
        );
        await app.body("A").waitForCondition<boolean>(
          `document.querySelector('${EDITOR_SCROLLER_SELECTOR}').scrollHeight > ${before.scrollHeight} + 4`,
          { timeoutMs: 6000 },
        );

        const readTop = `(function(){
          var scroller = document.querySelector('${EDITOR_SCROLLER_SELECTOR}');
          var box = scroller.getBoundingClientRect();
          var lines = scroller.querySelectorAll('.cm-line');
          for (var i = 0; i < lines.length; i++) {
            var r = lines[i].getBoundingClientRect();
            if (r.bottom > box.top + 1) {
              return { text: lines[i].textContent, delta: r.top - box.top, scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight };
            }
          }
          return null;
        })()`;

        // Read the top line INSIDE the held interval, and count what is being
        // held while reading it.
        const held = await app.body("A").evalJS<{
          top: { text: string; delta: number; scrollTop: number } | null;
          pending: number;
        }>(`(function(){
          return { top: ${readTop}, pending: window.__tugFrameStall.held.size };
        })()`);
        const flash = await app.body("A").evalJS<{
          text: string;
          delta: number;
          scrollTop: number;
        } | null>(`(function(){ return window.__tugFlashSample; })()`);
        const stallState = await app.body("A").evalJS<{ requested: number }>(
          `(function(){ return { requested: window.__tugFrameStall.requested }; })()`,
        );
        note(
          `flash window: ${stallState.requested} frame(s) requested and held; ` +
            `top line at the microtask ` +
            `${JSON.stringify(flash === null ? "(none)" : flash.text.slice(0, 14))}` +
            `@${flash === null ? "-" : Math.round(flash.scrollTop)}`,
        );
        expect(flash).not.toBeNull();

        note(
          `frames held: ${held.pending} callback(s) pending; top line ` +
            `${JSON.stringify(before.text.slice(0, 14))} → ` +
            `${JSON.stringify(held.top === null ? "(none)" : held.top.text.slice(0, 14))}` +
            `@${held.top === null ? "-" : Math.round(held.top.scrollTop)}`,
        );

        // A stall that was never asked for a frame proves nothing: the reload's
        // own measure pass is what must have been scheduled into it.
        expect(stallState.requested).toBeGreaterThanOrEqual(1);
        expect(held.top).not.toBeNull();

        // THE assertion. The sample was taken with no frame callback having
        // run and no task having intervened, so a correction visible in it
        // landed in the dispatch's own task. Holding the pixel `scrollTop`
        // instead reads one row EARLIER — `tall line 044` for `045` — because
        // the external write inserted a row above the viewport.
        expect(flash!.text).toBe(before.text);
        expect(Math.abs(flash!.delta - before.delta)).toBeLessThanOrEqual(2);

        // And it still holds after the harness's round trips with the frames
        // still held, which catches a correction that arrived from a later
        // task — the assertion above is the sharper one, and catches a
        // correction that arrived from any task at all.
        expect(held.top!.text).toBe(before.text);
        expect(Math.abs(held.top!.delta - before.delta)).toBeLessThanOrEqual(2);

        // Release the stall and run what it held, then read the settled state.
        // A fix that only moved the flash later would pass the read above and
        // fail here.
        const ran = await app.body("A").evalJS<number>(`(function(){
          var stall = window.__tugFrameStall;
          window.requestAnimationFrame = stall.raf;
          window.cancelAnimationFrame = stall.cancel;
          var cbs = [];
          stall.held.forEach(function(cb){ cbs.push(cb); });
          stall.held.clear();
          var t = performance.now();
          for (var i = 0; i < cbs.length; i++) {
            try { cbs[i](t); } catch (e) {}
          }
          return cbs.length;
        })()`);
        note(`stall released: ${ran} held callback(s) run`);

        const after = await app.body("A").evalJS<{
          text: string;
          delta: number;
          scrollTop: number;
          scrollHeight: number;
        }>(readTop);
        expect(after.text).toBe(before.text);
        expect(Math.abs(after.delta - before.delta)).toBeLessThanOrEqual(2);

        // And the disk content really is in the buffer.
        await app.body("A").evalJS<null>(
          `(document.querySelector('${EDITOR_SCROLLER_SELECTOR}').scrollTop = 0, null)`,
        );
        await waitForEditorShowing(app, "EXTERNAL-WRITER LINE");
      } finally {
        await app.close();
        rmFixture(dir);
      }
    },
    TEST_TIMEOUT_MS,
  );
});
