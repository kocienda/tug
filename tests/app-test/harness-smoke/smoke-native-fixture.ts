/**
 * smoke-native-fixture.ts — the settle helper and overlay fixture the
 * smoke-native-* files drive the Phase A native-gesture pipeline through.
 *
 * ## What the split pins
 *
 * Every Phase A native verb that the AT-series rewrites (Step 3b and
 * onward) relies on. If any of these tests fails, the whole
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
 * Beside those, the two pid-mode files pin the background launch: the
 * app believes it is active and its window is really key, and a key on
 * the session tap never reaches it.
 *
 * ## Why an overlay instead of seedDeckState
 *
 * These tests target CGEvent wire fidelity, not tugdeck-specific
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
 * @module tests/app-test/harness-smoke/smoke-native-fixture
 */

import type { App } from "../_harness";

export const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

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

export async function waitForPaintSettled(app: App): Promise<void> {
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
export async function seedOverlay(
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
export async function removeOverlay(app: App, fixtureId: string): Promise<void> {
  const script = `
    (function() {
      var el = document.getElementById(${JSON.stringify(fixtureId)});
      if (el !== null) el.remove();
    })()
  `;
  await app.evalJS(script);
}
