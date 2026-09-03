/**
 * at0141-picker-keys.test.ts — the session picker is a PERSISTENT keyboard-focus
 * cycle ([P13] persistent, [#step-picker-keys]).
 *
 * ## What this gates (failure modes, not busywork)
 *
 * The picker (the "Choose Session" sheet) authors its controls into the sheet's
 * already-trapped engine focus mode as one group — Browse folder button (-0.5) →
 * path combo box (0) → Sessions filter field (1) → Sessions (2) →
 * Move-all-to-Trash (3) → Cancel (4) → Open (5) — so the engine's Tab walk owns
 * navigation. `armKeyboardRestore` seeds the ring on the Sessions list (its
 * cursor rests on the "New session" row, so one Return falls through to the
 * persistent-default Open). Each assertion below fails loudly if a seam breaks:
 *
 *   - **Seed (A):** the ring rests on the Sessions list at open ([P12] Picker →
 *     New session via the focus-key seed). Fails if the smart-latch
 *     `.focus()`→`armKeyboardRestore` swap regressed or the list wasn't authored.
 *   - **Walk owns Tab + wraps (B):** Tab from Open (the last stop) wraps to the
 *     Browse button (the first stop, order -0.5), then Tab lands DOM focus on the
 *     path field's real `<input>` (order 0). Fails if the engine walk didn't take
 *     over Tab in the sheet, the field isn't a stop, or the wrap is wrong.
 *   - **Path field releases Tab when its dropdown is closed (C):** Tab leaves the
 *     field — for the Sessions filter field (order 1), then the list. The Browse
 *     button now LEADS the path field, so it is no longer between the field and
 *     the list (and there is NO Recents stop). Fails if the
 *     `data-tug-tab-consume` marker is stuck on (Tab would be eaten and stay on
 *     the field), or a stale Recents stop reappeared.
 *   - **Combo box dropdown is keyboard-driven (D):** on the path field, ArrowDown
 *     opens the dropdown seeded with the recent projects; ArrowDown moves the
 *     highlight; Enter commits the highlighted recent into the field and closes
 *     the dropdown, with the key view still resting on the field. Fails if the
 *     dropdown didn't open, didn't rove, or Enter didn't commit the pick.
 *
 * ## Why synthetic keystrokes here (not `nativeKey`)
 *
 * The keystrokes are dispatched as real `keydown` events on the focused element,
 * which travel the SAME document-level capture pipeline a hardware key does — the
 * engine's Tab-walk listener, `focusNext`, the combo box's own key handler, and
 * the act dispatch all run for real. What this skips is only the OS→WebView
 * delivery layer (exercised by at0140's `nativeKey`), which this step does not
 * touch. Native delivery is also impractical here: the picker form scrolls its
 * seeded commit-home (Open) into view, which pushes the top field off-screen, and
 * a native click to take OS key focus would land on an off-screen target.
 *
 * The filesystem-completion half of the dropdown (typing completes real paths)
 * needs a live `/api/fs/complete` backend the bare harness lacks, so it is
 * verified by-eye; the seed (recents) half — the testable one — is what (D)
 * drives, and it is the regression that actually bites.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/lib/session-picker-data-source.ts
 * @covers tugdeck/src/components/tugways/tug-list-view.tsx
 * @covers tugdeck/src/components/tugways/focus-manager.ts
 * @covers tugdeck/src/components/tugways/hooks/
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

// Picker stops addressed by their stable authored focus-key (`group:order`) —
// the same attribute the engine lands `data-key-view-kbd` on, so it doubles as
// the key-view probe target and is immune to DOM-structure churn.
const PATH = '[data-tug-focus-key="session-picker-cycle:0"]';
// The native "Browse…" folder button LEADS the path field, at a negative
// fractional order so it slots before PATH while the stops below keep their
// stable keys.
const BROWSE = '[data-tug-focus-key="session-picker-cycle:-0.5"]';
const CHEVRON = '[data-tug-focus-key="session-picker-cycle:0.5"]';
const FILTER = '[data-tug-focus-key="session-picker-cycle:1"]';
const SESSIONS = '[data-tug-focus-key="session-picker-cycle:2"]';
const OPEN = '[data-tug-focus-key="session-picker-cycle:5"]';
const PICKER_FORM = ".session-card-picker-form";
// The portaled combo-box dropdown and its keyboard-highlighted row.
const DROPDOWN = ".tug-combo-box-menu";

// Real directories that exist on the macOS test host, so the path-seed (first
// recent) leaves Open ENABLED whether or not a tugcast backend answers the
// directory-existence check — the seed lands on Open either way.
const SEED_RECENTS = ["/", "/tmp", "/usr"];

function hasKeyView(selector: string): string {
  return `(function(){
    var el = document.querySelector(${JSON.stringify(selector)});
    return el ? el.hasAttribute("data-key-view-kbd") : false;
  })()`;
}

// Dispatch a real `keydown` on the focused element. It travels the document
// capture pipeline exactly as a hardware key would (the engine's listeners are
// document-capture), so the focus walk / list rove / Escape ladder all run.
function pressKey(app: { evalJS<T>(s: string): Promise<T> }, key: string): Promise<null> {
  return app.evalJS<null>(
    `(function(){
      var el = document.activeElement || document.body;
      el.dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }));
      return null;
    })()`,
  );
}

// Tab forward until `selector` wears the key view. Bounded: the walk crosses
// stops whose presence is host-dependent (Move-all-to-Trash drops out of the
// cycle when the typed path has no sessions), so the hop count between two
// named stops is not a constant this test should hard-code.
async function tabUntil(
  app: {
    evalJS<T>(s: string): Promise<T>;
    waitForCondition<T>(s: string, opts?: { timeoutMs?: number }): Promise<T>;
  },
  selector: string,
  maxTabs: number,
): Promise<void> {
  for (let i = 0; i < maxTabs; i++) {
    await pressKey(app, "Tab");
    try {
      await app.waitForCondition<boolean>(hasKeyView(selector), { timeoutMs: 1_500 });
      return;
    } catch {
      // Not this stop — keep walking.
    }
  }
  throw new Error(`tab walk never reached ${selector} within ${maxTabs} tabs`);
}

// The `data-recent-path` of the dropdown row currently highlighted (the
// keyboard-selected `.tug-completion-menu-item-selected`), or null. Proves the
// highlight roves within the open dropdown.
const ACTIVE_RECENT = `(function(){
  var row = document.querySelector('${DROPDOWN} .tug-completion-menu-item-selected');
  return row ? row.getAttribute('data-recent-path') : null;
})()`;

// DOM focus is on the path field's real <input> (the engine landed the caret on
// the editable, not a wrapper).
const PATH_INPUT_FOCUSED = `(function(){
  var el = document.querySelector(${JSON.stringify(PATH)});
  return el !== null && document.activeElement === el && el.tagName === "INPUT";
})()`;

const PICKER_OPEN = `document.querySelector(${JSON.stringify(PICKER_FORM)}) !== null`;

function deckShape() {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 760, height: 600 },
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

describe.skipIf(!SHOULD_RUN)("AT0141: the session picker is a persistent keyboard cycle", () => {
  test(
    "seeds Open, Tab wraps to the path field then Recents, Recents is one roving stop, and the path field releases Tab when its menu is closed",
    async () => {
      const app = await launchTugApp({ testName: "at0141-picker-keys" });
      try {
        await app.enableDeckTrace(true);
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );

        // An UNBOUND session card presents its picker. Do NOT bind a session.
        await app.waitForCondition<boolean>(PICKER_OPEN, { timeoutMs: 8000 });

        // Populate Recents in-process so they seed the path combo box's dropdown
        // and the path-seed fills the field (→ Open enabled → seed lands on the
        // Sessions list). Wait on the field carrying a seeded value.
        await app.evalJS<null>(
          `(window.__tug.setTugbankValue(${JSON.stringify("dev.tugapp.dev")}, ${JSON.stringify("recent-projects")}, { kind: "json", value: { paths: ${JSON.stringify(SEED_RECENTS)} } }), null)`,
        );
        await app.waitForCondition<boolean>(
          `(function(){ var el = document.querySelector(${JSON.stringify(PATH)}); return el !== null && el.value.length > 0; })()`,
          { timeoutMs: 8000 },
        );

        // (A) Seed: the ring rests on the Sessions list ([P12] Picker → New
        // session) once the path seed settles Open enabled and the sessions
        // ledger is ready — via the engine key view (armKeyboardRestore), not a
        // bare `.focus()`. The seed also focuses the list in the DOM, so the
        // walk below starts there.
        await app.waitForCondition<boolean>(hasKeyView(SESSIONS), { timeoutMs: 8000 });

        // The seed is the SINGLE focus authority: exactly one element in the
        // picker wears the keyboard ring, and it is the Sessions list — the
        // path <input> holds neither the ring nor DOM focus. Regression pin
        // for the double-focus (ring on the Sessions list AND caret+ring on
        // the path field at once), which happened when the engine parked the
        // sink for the native input instead of granting it focus, leaving the
        // sheet's Radix FocusScope mount-autofocus as a second authority on
        // the field.
        expect(
          await app.evalJS<number>(
            `document.querySelectorAll(${JSON.stringify(PICKER_FORM)} + " [data-key-view-kbd], " + ${JSON.stringify(PICKER_FORM)} + "[data-key-view-kbd]").length`,
          ),
        ).toBe(1);
        expect(await app.evalJS<boolean>(hasKeyView(SESSIONS))).toBe(true);
        expect(
          await app.evalJS<boolean>(
            `(function(){
              var input = document.querySelector(${JSON.stringify(PATH)});
              return input !== null &&
                input.hasAttribute("data-key-view-kbd") === false &&
                document.activeElement !== input;
            })()`,
          ),
        ).toBe(true);

        // Walk forward to Open (the last stop). Between Sessions and Open sit
        // Move-all-to-Trash (present only when the path has sessions) and
        // Cancel, so the hop count is host-dependent — walk, don't count.
        await tabUntil(app, OPEN, 4);

        // (B) The engine walk owns Tab inside the sheet, and Open (last) wraps to
        // the Browse button (the first stop, order -0.5); one more Tab lands the
        // key view on the path field (order 0).
        //
        // It lands PARKED, not with a caret. The sheet's trap engages KBF, and a
        // text stop the engine MOVED to wears the ring while the key sink holds
        // DOM focus ([P12]) — this used to assert the <input> held focus, from
        // before the mode restored the parked state. The seed assertion above
        // already reads it this way for the Sessions landing; this is the same
        // rule one stop along.
        await pressKey(app, "Tab");
        await app.waitForCondition<boolean>(hasKeyView(BROWSE), { timeoutMs: 6000 });
        await pressKey(app, "Tab");
        await app.waitForCondition<boolean>(hasKeyView(PATH), { timeoutMs: 6000 });
        expect(
          await app.evalJS<boolean>(PATH_INPUT_FOCUSED),
          "a walked-to text stop parks — ring, no caret",
        ).toBe(false);

        // (C) The dropdown is closed, so the path field does NOT own Tab: Tab
        // leaves it — first for the combo box's chevron (order 0.5, the
        // keyboard door to the recents dropdown), then the Sessions filter
        // field (order 1), then the list. If the tab-consume marker were stuck
        // on, the key view would stay on the field.
        await pressKey(app, "Tab");
        await app.waitForCondition<boolean>(hasKeyView(CHEVRON), { timeoutMs: 6000 });
        await pressKey(app, "Tab");
        await app.waitForCondition<boolean>(hasKeyView(FILTER), { timeoutMs: 6000 });
        await pressKey(app, "Tab");
        await app.waitForCondition<boolean>(hasKeyView(SESSIONS), { timeoutMs: 6000 });
        expect(await app.evalJS<boolean>(hasKeyView(PATH))).toBe(false);

        // (D) The recents live in the path combo box's own dropdown. Return to the
        // path field, then ArrowDown opens the dropdown (seeded with the recents)
        // and a second ArrowDown moves the highlight to a DIFFERENT row.
        await tabUntil(app, PATH, 6);
        // Walking here parks the stop, so take the caret before driving the
        // field's own keys: `Return` at a parked text stop grants it without
        // typing ([P12]). With the caret live the field owns ↑/↓ through its
        // attached-list contract, which is what opens and drives the dropdown.
        await pressKey(app, "Enter");
        await app.waitForCondition<boolean>(PATH_INPUT_FOCUSED, { timeoutMs: 6000 });
        await pressKey(app, "ArrowDown");
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(DROPDOWN)}) !== null`,
          { timeoutMs: 6000 },
        );
        await app.waitForCondition<boolean>(`${ACTIVE_RECENT} !== null`, { timeoutMs: 6000 });
        const firstActive = await app.evalJS<string | null>(ACTIVE_RECENT);
        await pressKey(app, "ArrowDown");
        await app.waitForCondition<boolean>(
          `${ACTIVE_RECENT} !== null && ${ACTIVE_RECENT} !== ${JSON.stringify(firstActive)}`,
          { timeoutMs: 6000 },
        );

        // Enter commits the highlighted recent into the field and closes the
        // dropdown — the keyboard equivalent of clicking the row. The key view
        // stays on the path field (Enter committed the pick, it did not leave).
        const rovedRecent = await app.evalJS<string | null>(ACTIVE_RECENT);
        await pressKey(app, "Enter");
        await app.waitForCondition<boolean>(
          `(function(){
            var el = document.querySelector(${JSON.stringify(PATH)});
            return el !== null && el.value === ${JSON.stringify(rovedRecent)};
          })()`,
          { timeoutMs: 6000 },
        );
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(DROPDOWN)}) === null`,
          { timeoutMs: 6000 },
        );
        // The UNFLAVORED key-view mark: the field holds a granted caret here,
        // and a granted caret stands the mode's paint down — `data-key-view-kbd`
        // is withheld while the route is dom-granted, so reading the ring
        // flavor would assert paint the engine correctly is not showing. The
        // claim is positional (Enter committed the pick without leaving), and
        // `data-key-view` is the positional mark.
        expect(
          await app.evalJS<boolean>(
            `(function(){
              var el = document.querySelector(${JSON.stringify(PATH)});
              return el !== null && el.hasAttribute("data-key-view");
            })()`,
          ),
          "Enter committed the pick with the key view still on the field",
        ).toBe(true);
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") {
          process.stderr.write(`\n[at0141-picker-keys] log tail:\n${tail}\n`);
        }
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
