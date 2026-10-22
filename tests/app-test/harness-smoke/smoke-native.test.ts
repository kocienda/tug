/**
 * smoke-native.test.ts — Phase A native-gesture smoke test.
 *
 * ## What this file pins
 *
 * Every Phase A native verb that the AT-series rewrites (Step 3b and
 * onward) relies on. If any of these five tests fails, the whole
 * native-event pipeline is broken and the downstream M-test suite
 * cannot be trusted.
 *
 *   1. **trusted click** — `nativeClickAtElement(selector)`; a
 *      one-shot mousedown listener records `event.isTrusted`. The
 *      Phase A thesis is "synthesized mousedown returns isTrusted=false
 *      and misses WebKit's default-focus path; CGEvent-posted
 *      mousedown returns isTrusted=true and hits it." This test
 *      asserts `true`.
 *   2. **type** — click into an input to focus, `nativeType("hello")`,
 *      assert `input.value === "hello"`. Exercises the
 *      ASCII-to-keystroke translation and `CGEventSource` flag
 *      handling for Shift on shifted chars (the "!" in "hello!" test
 *      would need Shift; we pick plain-case to keep the assertion
 *      scope focused).
 *   3. **Cmd+A** — click into an input with pre-filled text,
 *      `nativeKey("a", ["cmd"])`, assert `selectionStart=0` and
 *      `selectionEnd=value.length`. This is the [Q05] resolution
 *      check — modifier flags must actually register for WebKit's
 *      editing handler.
 *   4. **endpoint drag** — seed a contentEditable with known text,
 *      `nativeDrag` from the char-0 bounding-rect to the char-5
 *      bounding-rect, assert the resulting selection length. The
 *      plan explicitly flags this as a possible WebKit-drag-fidelity
 *      risk; if endpoint-only drags do not paint selection, this
 *      test fails unambiguously and Phase A course-corrects before
 *      Step 3b.
 *   5. **double-click word** — seed an input with "hello world",
 *      `nativeDoubleClickAtElement`, assert WebKit's default double-
 *      click-to-select-word behavior produced "hello" as the
 *      selection.
 *
 * ## Why an overlay instead of seedDeckState
 *
 * These five tests target CGEvent wire fidelity, not tugdeck-specific
 * behaviors. A fixed-position overlay appended to `document.body`
 * with a high z-index sits on top of the tugdeck React root (whose
 * content is irrelevant for these probes), keeping the hit-target
 * deterministic. We clean the overlay up in a `finally` so repeat
 * runs stay isolated.
 *
 * ## AX preflight
 *
 * These tests need the macOS Accessibility grant — the harness's
 * `launchTugApp` preflight will surface an
 * `AccessibilityPermissionMissingError` before the first test runs
 * if the grant is missing. See
 * [scripts/setup-dev-signing.sh](../../scripts/setup-dev-signing.sh)
 * and the [harness README](./README.md) for setup.
 *
 * @covers tests/app-test/_harness/
 * @covers tugapp/Sources/TestHarness/
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, type App } from "../_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

// -----------------------------------------------------------------------------
// Settle helper
//
// The `launchTugApp` handshake returns as soon as `window.__tug` is
// attached, which happens early in `main.tsx`'s execution — before
// React's initial render commits and before WebKit has finished its
// first paint. Trusted `CGEvent` posts into a page that hasn't
// settled race against WebKit's hit-testing and selection setup
// (especially drag-selection, which the Phase A smoke test 4 found
// silently no-ops on an unsettled editor).
//
// `waitForPaintSettled` forces TWO `requestAnimationFrame` ticks —
// enough for layout + paint to finalize on every tested macOS
// version — then returns. Use it after `launchTugApp` and after any
// `evalJS` that mutates the DOM, before issuing native gestures.
// -----------------------------------------------------------------------------

async function waitForPaintSettled(app: App): Promise<void> {
  await app.waitForCondition(
    `document.readyState === "complete"`,
    { timeoutMs: 5000 },
  );
  await app.evalJS(`
    (function() {
      window.__tugSmokeSettle = false;
      requestAnimationFrame(function() {
        requestAnimationFrame(function() {
          window.__tugSmokeSettle = true;
        });
      });
    })();
  `);
  await app.waitForCondition(`window.__tugSmokeSettle === true`, {
    timeoutMs: 2000,
  });
}

// -----------------------------------------------------------------------------
// Fixture helpers
// -----------------------------------------------------------------------------

/**
 * Inject a fixed-position overlay on top of the tugdeck React root.
 * The overlay's ID is scoped per-test so concurrent tests within the
 * same Tug.app subprocess never collide on hit-targets.
 *
 * `innerHTML` is expected to include elements with predictable
 * selectors the test asserts on. The overlay itself is anchored at
 * `(40, 40)` with a generous size so its interior elements never
 * bleed off the WKWebView viewport (which can be narrow during
 * CI-like window sizes).
 */
async function seedOverlay(
  app: App,
  fixtureId: string,
  innerHTML: string,
): Promise<void> {
  // `JSON.stringify(innerHTML)` handles the embedded quotes / newlines
  // that plain string concatenation would mangle.
  const script = `
    (function() {
      var existing = document.getElementById(${JSON.stringify(fixtureId)});
      if (existing !== null) existing.remove();
      var host = document.createElement("div");
      host.id = ${JSON.stringify(fixtureId)};
      host.style.cssText = [
        "position: fixed",
        "top: 40px",
        "left: 40px",
        "width: 360px",
        "height: 220px",
        "z-index: 999999",
        "background: white",
        "border: 2px solid #c33",
        "padding: 16px",
        "box-sizing: border-box",
        "font-family: system-ui, sans-serif",
        "font-size: 14px",
        "color: black"
      ].join("; ");
      host.innerHTML = ${JSON.stringify(innerHTML)};
      document.body.appendChild(host);
    })()
  `;
  await app.evalJS(script);
}

/**
 * Remove a previously-seeded overlay. Run in the `finally` block
 * alongside `app.close()` so Tug.app's WebView returns to its
 * stock tugdeck state between tests.
 */
async function removeOverlay(app: App, fixtureId: string): Promise<void> {
  const script = `
    (function() {
      var el = document.getElementById(${JSON.stringify(fixtureId)});
      if (el !== null) el.remove();
    })()
  `;
  await app.evalJS(script);
}

describe.skipIf(!SHOULD_RUN)("phase A native-gesture smoke", () => {
  test("trusted click: nativeClickAtElement delivers isTrusted=true mousedown", async () => {
    const app = await launchTugApp({ testName: "smoke-native-trusted-click" });
    const fixtureId = "smoke-native-fx-click";
    try {
      await waitForPaintSettled(app);
      await seedOverlay(
        app,
        fixtureId,
        `<button id="smoke-click-btn" style="width: 180px; height: 48px;">click me</button>`,
      );
      await waitForPaintSettled(app);
      // Install a one-shot mousedown listener that stamps isTrusted
      // onto a global the test reads afterward. `{ once: true }` makes
      // the listener self-removing so a stray click later can't
      // overwrite the captured bit.
      await app.evalJS(`
        window.__smokeClickResult = null;
        document.getElementById("smoke-click-btn").addEventListener(
          "mousedown",
          function(e) {
            window.__smokeClickResult = {
              isTrusted: e.isTrusted,
              button: e.button,
              type: e.type,
            };
          },
          { once: true },
        );
      `);

      await app.nativeClickAtElement("#smoke-click-btn");

      // Poll until the listener fires — CGEvent.post delivery is
      // async to the RPC response, so the event may not have been
      // dispatched by the time nativeClickAtElement resolves.
      await app.waitForCondition("window.__smokeClickResult !== null");
      const result = await app.evalJS<{
        isTrusted: boolean;
        button: number;
        type: string;
      } | null>("window.__smokeClickResult");

      expect(result).not.toBeNull();
      expect(result?.type).toBe("mousedown");
      expect(result?.button).toBe(0);
      // This is the load-bearing assertion for the entire Phase A
      // rewrite: CGEvent.post must produce isTrusted=true.
      expect(result?.isTrusted).toBe(true);
    } finally {
      try {
        await removeOverlay(app, fixtureId);
      } catch {
        // best-effort cleanup
      }
      await app.close();
    }
  });

  test("type: nativeType inserts ASCII text into focused input", async () => {
    const app = await launchTugApp({ testName: "smoke-native-type" });
    const fixtureId = "smoke-native-fx-type";
    try {
      await waitForPaintSettled(app);
      await seedOverlay(
        app,
        fixtureId,
        `<input id="smoke-type-input" type="text" style="width: 300px; height: 32px; font-size: 16px;" />`,
      );
      await waitForPaintSettled(app);
      await app.nativeClickAtElement("#smoke-type-input");
      // Wait for focus to land — WebKit's focus-on-mousedown path is
      // async to our RPC response just like the mousedown dispatch.
      await app.waitForCondition(
        `document.activeElement === document.getElementById("smoke-type-input")`,
      );

      await app.nativeType("hello");

      // Poll on value rather than asserting immediately; keystroke
      // dispatch → InputEvent → `.value` write is also async.
      await app.waitForCondition(
        `document.getElementById("smoke-type-input").value === "hello"`,
      );
      const value = await app.getElementValue("#smoke-type-input");
      expect(value).toBe("hello");
    } finally {
      try {
        await removeOverlay(app, fixtureId);
      } catch {
        // best-effort cleanup
      }
      await app.close();
    }
  });

  test("pid mode: the app believes it is active and its window is really key, with the user's app and input source untouched", async () => {
    // The background launch never activates. AppKit refuses key status to
    // an inactive app's window, so the host's `TugApplication` has the app
    // believe it is active in this mode and the real `makeKey()` succeeds:
    // `isKeyWindow` is AppKit's own state, `NSApp.keyWindow` names the
    // window, and `isActive` reads true — what a foreground app is, which
    // is what gives chords the key window's view-then-menu order and lets
    // a nil-target Edit action resolve. The other half of the contract is
    // that none of it touched the user: the frontmost app and the keyboard
    // input source read the same now as before the host's `run()`, and the
    // frontmost app is not this one.
    const app = await launchTugApp({ testName: "smoke-native-key-window" });
    try {
      await waitForPaintSettled(app);
      const state = await app.windowState();
      const seen = JSON.stringify(state);
      expect(state.isActive, `the app must believe it is active; saw ${seen}`).toBe(true);
      expect(state.isKeyWindow, `the window must really be key; saw ${seen}`).toBe(true);
      expect(state.appKeyWindow, `NSApp.keyWindow must name the window; saw ${seen}`).toBe(true);
      expect(state.firstResponder, `the window must have a first responder; saw ${seen}`).not.toBeNull();
      expect(state.frontmostNow, `the user's frontmost app must not move across the launch; saw ${seen}`).toBe(state.frontmostAtLaunch);
      expect(state.frontmostNow, `this app must never be frontmost; saw ${seen}`).not.toBe("dev.tugapp.app.apptest");
      expect(state.inputSourceNow, `the keyboard input source must not change across the launch; saw ${seen}`).toBe(state.inputSourceAtLaunch);
      // WebKit reads the window active from the real key window, and the
      // host announced the activation in-process, so the page believes it
      // is in front the way a foreground app's does: the document has
      // focus, and the deck's own projection of the active bit agrees.
      const page = await app.evalJS<{ hasFocus: boolean; appActive: string | null }>(
        `({ hasFocus: document.hasFocus(), appActive: document.documentElement.getAttribute("data-app-active") })`,
      );
      expect(page.hasFocus, `the shell must read document.hasFocus() under the real key window; saw ${JSON.stringify(page)}`).toBe(true);
      expect(page.appActive, `the deck's data-app-active must agree with the announced activation; saw ${JSON.stringify(page)}`).toBe("true");
    } finally {
      await app.close();
    }
  });

  test("pid mode: a key on the session tap never reaches the app", async () => {
    // A real key window in an inactive app must not pull the user's
    // keyboard. The host posts a Shift down/up to the session event tap —
    // the user's keyboard as WindowServer routes it — and reports what its
    // own event monitor saw, which must be nothing (measured 2026-10-21 in a
    // throwaway accessory app with the same override). If this ever goes
    // red the fake-active regime is wrong and the fallback is the
    // accessor-only override. `trusted` must read true first: the system
    // drops a post from an untrusted process, and a dropped post proves
    // nothing.
    const app = await launchTugApp({ testName: "smoke-native-session-tap" });
    try {
      await waitForPaintSettled(app);
      const before = await app.windowState();
      expect(before.isKeyWindow, `the probe is only meaningful under a real key window; saw ${JSON.stringify(before)}`).toBe(true);
      const probe = await app.sessionTapProbe();
      const seen = JSON.stringify(probe);
      expect(probe.trusted, `the post must be deliverable for the probe to prove anything; saw ${seen}`).toBe(true);
      expect(probe.received, `a session-tap key must not arrive in the inactive app; saw ${seen}`).toEqual([]);
      expect(probe.frontmost, `the user's frontmost app must not move; saw ${seen}`).toBe(before.frontmostAtLaunch);
    } finally {
      await app.close();
    }
  });

  test("Cmd+A: nativeKey('a', ['cmd']) delivers trusted keydown with metaKey=true", async () => {
    // Phase-A fidelity thesis, modifier edition: the CGEvent-posted
    // keystroke must arrive at WebKit as
    // `{ isTrusted: true, metaKey: true, code: "KeyA" }`. We cannot
    // assert on *behavior* (select-all) because tugdeck owns a
    // document-level capture-phase keydown listener that matches
    // Cmd+A and calls `event.preventDefault()` before the browser's
    // native select-all runs (see
    // `tugdeck/src/components/tugways/keybinding-map.ts` and
    // `responder-chain-provider.tsx`). Fighting tugdeck's capture
    // listener from a smoke test would be fragile; asserting on the
    // *event shape* directly is the robust pipeline check. Step 3b's
    // AT0003 rewrite does assert on behavior, but there the test scenario
    // is designed around the deck's own bindings, not in conflict
    // with them.
    const app = await launchTugApp({ testName: "smoke-native-cmd-a" });
    const fixtureId = "smoke-native-fx-cmd-a";
    try {
      await waitForPaintSettled(app);
      await seedOverlay(
        app,
        fixtureId,
        `<input id="smoke-cmda-input" type="text" value="hello world" style="width: 300px; height: 32px; font-size: 16px;" />`,
      );
      await waitForPaintSettled(app);
      // Install a one-shot keydown listener in the capture phase on
      // the input itself. tugdeck's listener is on document (capture)
      // — it calls `preventDefault()` but only calls
      // `stopImmediatePropagation()` when a responder handles the
      // action. With no SELECT_ALL responder registered for our
      // overlay, propagation continues and the event reaches our
      // listener. The listener fires once and stamps `isTrusted` +
      // `metaKey` + `code` onto a global the test reads afterward.
      //
      // The listener also claims the key. A ⌘A nobody claims is handed
      // back to AppKit: WebKit reports the keydown unhandled, resends it,
      // Edit › Select All validates dark (no Tug responder for a bare
      // input), and the key falls off the responder chain into the
      // no-responder beep — a red under the harness's silence contract.
      // Every text control in Tug claims its own ⌘A through the text-input
      // substrate; this overlay input is the one that has none, so it
      // claims the key itself, the way the substrate would.
      await app.evalJS(`
        window.__smokeCmdAResult = null;
        document.getElementById("smoke-cmda-input").addEventListener(
          "keydown",
          function(e) {
            // The modifier keydown (code === "MetaLeft") fires before
            // the letter keydown; skip modifier events so we record
            // the 'a' keystroke with its fully-propagated flags.
            if (e.code === "MetaLeft" || e.code === "MetaRight" ||
                e.code === "ShiftLeft" || e.code === "ShiftRight" ||
                e.code === "AltLeft" || e.code === "AltRight" ||
                e.code === "ControlLeft" || e.code === "ControlRight") {
              return;
            }
            if (e.metaKey && e.code === "KeyA") e.preventDefault();
            if (window.__smokeCmdAResult !== null) return;
            window.__smokeCmdAResult = {
              isTrusted: e.isTrusted,
              metaKey: e.metaKey,
              code: e.code,
              key: e.key,
              ctrlKey: e.ctrlKey,
              shiftKey: e.shiftKey,
              altKey: e.altKey,
            };
          },
          { capture: true },
        );
      `);
      await app.nativeClickAtElement("#smoke-cmda-input");
      await app.waitForCondition(
        `document.activeElement === document.getElementById("smoke-cmda-input")`,
      );

      await app.nativeKey("a", ["cmd"]);

      await app.waitForCondition("window.__smokeCmdAResult !== null");
      const result = await app.evalJS<{
        isTrusted: boolean;
        metaKey: boolean;
        code: string;
        key: string;
        ctrlKey: boolean;
        shiftKey: boolean;
        altKey: boolean;
      } | null>("window.__smokeCmdAResult");

      expect(result).not.toBeNull();
      // Load-bearing modifier-flag assertion: Cmd must be set.
      expect(result?.metaKey).toBe(true);
      expect(result?.isTrusted).toBe(true);
      expect(result?.code).toBe("KeyA");
      // Sanity: no stray modifiers.
      expect(result?.ctrlKey).toBe(false);
      expect(result?.shiftKey).toBe(false);
      expect(result?.altKey).toBe(false);
    } finally {
      try {
        await removeOverlay(app, fixtureId);
      } catch {
        // best-effort cleanup
      }
      await app.close();
    }
  });

  test("endpoint drag: nativeDrag produces a painted selection", async () => {
    // User-facing assertion: after dragging from char-0 to char-5,
    // the selection actually reads "Hello" — the same outcome a real
    // user would see from a real mouse drag.
    //
    // Environmental setup: tugdeck's `selectionGuard` blocks
    // `selectstart` for any target outside a registered card
    // boundary (see
    // `tugdeck/src/components/tugways/selection-guard.ts`
    // `handleSelectStart`). Real user scenarios drag INSIDE a card
    // content area, which is always registered. To mirror that
    // environment in a smoke test without seeding a full deck + card
    // tree, we register our overlay element as an ad-hoc boundary
    // via `__tug.registerSelectionBoundary(cardId, selector)`. This
    // is a test-only surface method added in SURFACE_VERSION 1.1.0;
    // it is a thin wrapper over `selectionGuard.registerBoundary`,
    // the same call a mounting card makes.
    const app = await launchTugApp({ testName: "smoke-native-drag" });
    const fixtureId = "smoke-native-fx-drag";
    try {
      await waitForPaintSettled(app);
      await seedOverlay(
        app,
        fixtureId,
        `<div id="smoke-drag-editor" contenteditable="true" style="font-size: 18px; line-height: 1.5; padding: 8px; border: 1px solid #aaa; user-select: text;">Hello World</div>`,
      );
      // Register the overlay as a selection boundary — mirrors what
      // a mounting card's `useSelectionBoundary` hook does. Without
      // this, `selectionGuard.handleSelectStart` calls preventDefault
      // and WebKit never begins the selection.
      await app.registerSelectionBoundary("smoke-drag-fake-card", `#${fixtureId}`);
      await waitForPaintSettled(app);

      // Compute char-0 and char-5 viewport points via Range rects.
      // Range rects are the browser's authoritative per-character
      // geometry and survive font-metric variability.
      const points = await app.evalJS<{
        from: { x: number; y: number };
        to: { x: number; y: number };
      }>(`(function() {
        var editor = document.getElementById("smoke-drag-editor");
        var textNode = editor.firstChild;
        var fromRect = (function() {
          var r = document.createRange();
          r.setStart(textNode, 0); r.setEnd(textNode, 1);
          var rect = r.getBoundingClientRect();
          return { x: rect.left + 1, y: rect.top + rect.height / 2 };
        })();
        var toRect = (function() {
          var r = document.createRange();
          r.setStart(textNode, 0); r.setEnd(textNode, 5);
          var rect = r.getBoundingClientRect();
          return { x: rect.right - 1, y: rect.top + rect.height / 2 };
        })();
        return { from: fromRect, to: toRect };
      })()`);

      await app.nativeDrag(points.from, points.to, {
        mouseDownDelayMs: 40,
        mouseUpDelayMs: 40,
      });

      // Poll for the selection to appear. A successful drag produces
      // a non-collapsed selection of length 5 ("Hello"). WebKit
      // dispatches selection-change events asynchronously after
      // mouseUp.
      await app.waitForCondition(
        `(function() {
          var sel = window.getSelection();
          return sel !== null && !sel.isCollapsed && sel.toString().length === 5;
        })()`,
        { timeoutMs: 3000 },
      );
      const selectedText = await app.evalJS<string>(
        `String(window.getSelection() || "")`,
      );
      expect(selectedText).toBe("Hello");
    } finally {
      try {
        await app.unregisterSelectionBoundary("smoke-drag-fake-card");
      } catch {
        // best-effort cleanup
      }
      try {
        await removeOverlay(app, fixtureId);
      } catch {
        // best-effort cleanup
      }
      await app.close();
    }
  });

  test("double-click: nativeDoubleClickAtElement selects the clicked word", async () => {
    const app = await launchTugApp({ testName: "smoke-native-double-click" });
    const fixtureId = "smoke-native-fx-double";
    try {
      await waitForPaintSettled(app);
      // Input with two words; double-click near the start selects
      // the first word.
      await seedOverlay(
        app,
        fixtureId,
        `<input id="smoke-dblclick-input" type="text" value="hello world" style="width: 300px; height: 32px; font-size: 16px;" />`,
      );
      await waitForPaintSettled(app);

      // Text-inputs render their value inside a shadow DOM that's not
      // directly queryable for per-char rects, so the safe target is
      // a viewport point near the START of the input's content box
      // — well inside "hello", far from the "hello world" word break.
      // The previous approach of picking `width * 0.20` landed on
      // "world" because `<input style="width:300px">` is much wider
      // than 11 chars of 16px text; 10px in from the content edge is
      // robust against any readable font size.
      const firstWordTarget = await app.evalJS<{ x: number; y: number }>(`
        (function() {
          var el = document.getElementById("smoke-dblclick-input");
          var r = el.getBoundingClientRect();
          // Account for the input's padding (user-agent default ~2px
          // on the left). 10px further in lands on the first
          // character regardless of font metrics.
          return { x: r.left + 10, y: r.top + r.height / 2 };
        })()
      `);

      await app.nativeDoubleClick(firstWordTarget);

      // Poll on the input's selection range for "hello". The second
      // click's mouseup + dblclick events dispatch ~100ms after
      // nativeDoubleClick's RPC returns, so the condition is
      // observably-false at first; waitForCondition handles that.
      await app.waitForCondition(
        `(function() {
          var el = document.getElementById("smoke-dblclick-input");
          if (document.activeElement !== el) return false;
          return el.selectionStart === 0 && el.selectionEnd === 5;
        })()`,
      );
      const sel = await app.getSelection();
      expect(sel).not.toBeNull();
      expect(sel?.kind).toBe("input");
      if (sel?.kind === "input") {
        expect(sel.value).toBe("hello world");
        expect(sel.selectionStart).toBe(0);
        expect(sel.selectionEnd).toBe(5);
      }
    } finally {
      try {
        await removeOverlay(app, fixtureId);
      } catch {
        // best-effort cleanup
      }
      await app.close();
    }
  });
});
