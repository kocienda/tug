/**
 * at0182-keymap-override.test.ts — a user keymap override, end to end.
 *
 * The claim this file exists to pin is the one a user actually makes: I
 * changed a chord, and the menu bar changed with it, without restarting the
 * app. Everything in between — a tugbank write, the override store, the
 * keymap registry, the menu-state push, the host's chord sweep — is only
 * interesting because that sentence has to come out true, so this test drives
 * the whole chain rather than any link in it.
 *
 * The override is written the way another process writes one, through the
 * DEFAULTS path, so what is exercised is the real remote-write route and not
 * a private setter the pane happens to share.
 *
 * `view.zoomOut` is the subject because it is unconditionally present, holds
 * a chord the registry states, and lives in the View menu — which
 * `removeAllItems()`s and rebuilds on every open, so a chord that survives
 * being read here has survived a rebuild too.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/keymap-override-store.ts
 * @covers tugdeck/src/components/tugways/keymap-registry.ts
 * @covers tugdeck/src/components/tugways/chord-capture-state.ts
 * @covers tugdeck/src/settings-api.ts
 * @covers tugdeck/src/lib/smart-scroll.ts
 * @covers tugdeck/src/lib/host-menu-state.ts
 * @covers tugdeck/src/components/tugways/cards/keyboard-card.tsx
 * @covers tugdeck/src/components/tugways/cards/settings-keymap-body.tsx
 * @covers tugdeck/src/components/tugways/cards/settings-keymap-rows.ts
 * @covers tugapp/Sources/AppDelegate.swift
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp, type App } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 120_000;

const KEYMAP_DOMAIN = "dev.tugapp.keymap";
/** `NSEvent.ModifierFlags` raw values, so an expectation reads as a chord. */
const CONTROL = 1 << 18;
const OPTION = 1 << 19;
const COMMAND = 1 << 20;

function singleCardDeck() {
  return {
    cards: [{ id: "C0", componentId: "gallery-input", title: "Card C0", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 60, y: 60 },
        size: { width: 640, height: 480 },
        cardIds: ["C0"],
        activeCardId: "C0",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

/** Write one command's override the way any other process would. */
async function writeOverride(app: App, commandId: string, bindings: unknown[]): Promise<void> {
  const args = JSON.stringify([
    KEYMAP_DOMAIN,
    commandId,
    { kind: "string", value: JSON.stringify(bindings) },
  ]);
  await app.evalJS<void>(`window.__tug.setTugbankValue(...${args})`);
}

/**
 * Drop the override — the reset gesture, which is a deletion rather than a
 * write of the default. Persisting the default would freeze it, so absence is
 * what "use whatever ships" is spelled as.
 */
async function resetOverride(app: App, commandId: string): Promise<void> {
  const args = JSON.stringify([KEYMAP_DOMAIN, commandId]);
  await app.evalJS<void>(`window.__tug.deleteTugbankValue(...${args})`);
}

async function waitKeyEquivalent(
  app: App,
  identifier: string,
  want: string,
  timeoutMs = 8000,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  let last: string | undefined;
  while (Date.now() < deadline) {
    const state = await app.menuItemState(identifier);
    last = state.found ? state.keyEquivalent : undefined;
    if (last === want) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  return last;
}

describe.skipIf(!SHOULD_RUN)("AT0182: a user keymap override moves the native chord", () => {
  test(
    "rebind, then reset, with the menu bar following both without a restart",
    async () => {
      const app = await launchTugApp({ testName: "at0182-override" });
      try {
        await app.seedDeckState({ state: singleCardDeck(), focusCardId: "C0" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("C0")`,
        );

        // The shipped chord, swept from the registry's default.
        expect(
          await waitKeyEquivalent(app, "view.zoomOut", "-"),
          "Zoom Out starts on ⌘-",
        ).toBe("-");

        // Rebind to ⌥⌘- and watch the menu bar follow. No restart: the store
        // notifies the registry, the registry republishes the menu-state
        // block, and the host re-sweeps.
        await writeOverride(app, "zoom-out", [
          { chord: { key: "Minus", meta: true, alt: true, label: "-" }, scope: { kind: "global" } },
        ]);
        expect(
          await waitKeyEquivalent(app, "view.zoomOut", "-"),
          "the character is unchanged",
        ).toBe("-");
        const rebound = await app.menuItemState("view.zoomOut");
        expect(
          rebound.found ? rebound.modifierMask : undefined,
          "⌥ joined the mask",
        ).toBe(COMMAND | OPTION);

        // Rebind again to a different key entirely, so the assertion is about
        // the chord and not about one modifier flag. ⌘Y is chosen because the
        // free pool says it is unclaimed: a rebind onto a chord some other
        // command's menu item already states is a different question than the
        // one this test asks, and answering it here would make the assertion
        // about collision policy rather than about propagation.
        await writeOverride(app, "zoom-out", [
          { chord: { key: "KeyY", meta: true, label: "y" }, scope: { kind: "global" } },
        ]);
        expect(
          await waitKeyEquivalent(app, "view.zoomOut", "y"),
          "the whole chord moved",
        ).toBe("y");

        // Explicitly unbound: an empty list is a real answer, and the item
        // ends up with no key equivalent at all rather than its default back.
        await writeOverride(app, "zoom-out", []);
        expect(
          await waitKeyEquivalent(app, "view.zoomOut", ""),
          "an empty override releases the chord",
        ).toBe("");

        // Reset — the override deleted, the table's default restored.
        await resetOverride(app, "zoom-out");
        expect(
          await waitKeyEquivalent(app, "view.zoomOut", "-"),
          "reset restores the registry default",
        ).toBe("-");
        const restored = await app.menuItemState("view.zoomOut");
        expect(restored.found ? restored.modifierMask : undefined).toBe(COMMAND);
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0182-override] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "the Keyboard Shortcuts card rebinds a command and resets it, and the menu bar follows",
    async () => {
      // The pane's *rendering* is not asserted — the project bans DOM-render
      // assertions and they would pin the wrong thing anyway. What is asserted
      // is the effect: the gesture a user performs in the pane moves the
      // native key equivalent, and the pane's reset puts it back.
      const app = await launchTugApp({ testName: "at0182-pane" });
      try {
        await app.waitForCondition<boolean>(
          `typeof window.__tug !== "undefined" && typeof window.tugdeck !== "undefined"`,
        );
        // The configurator is its own card now, opened by the app menu's
        // Keyboard Shortcuts… item — the same command that item sends.
        await app.evalJS(
          `window.__tug.dispatchControlAction("show-keyboard-shortcuts", {})`,
        );
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-testid="keyboard-card"]') !== null`,
          { timeoutMs: 8000 },
        );
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-testid="settings-keymap"]') !== null`,
          { timeoutMs: 8000 },
        );

        // Narrow to the row, so the click below cannot land on a neighbour.
        await app.type('[data-testid="settings-keymap-filter"] input', "Zoom Out");
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-testid="keymap-arm-zoom-out"]') !== null`,
          { timeoutMs: 8000 },
        );

        expect(await waitKeyEquivalent(app, "view.zoomOut", "-")).toBe("-");

        // Arm the capture. While it is armed the surface owns every chord:
        // the host parks the whole menu bar's key equivalents (AppKit would
        // otherwise resolve a bound chord before the web view saw it), and
        // stage 1 of the key pipeline stands down. The parked menu is the
        // observable half of that claim, so wait for it before pressing
        // anything — the push is a message hop, not a synchronous write.
        await app.click('[data-testid="keymap-arm-zoom-out"]');
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-testid="keymap-capture"]') !== null`,
          { timeoutMs: 6000 },
        );
        expect(
          await waitKeyEquivalent(app, "view.zoomOut", ""),
          "arming parks the menu bar's key equivalents",
        ).toBe("");

        // A chord that currently MEANS something is recorded, not fired:
        // ⌘- is Zoom Out's own live chord, and pressing it mid-capture has
        // to land in the recorder rather than zooming the page.
        await app.nativeKey("-", ["cmd"]);
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-testid="keymap-capture"] [data-pending="true"]') !== null`,
          { timeoutMs: 6000 },
        );
        const recorded = await app.evalJS<string>(
          `document.querySelector('[data-testid="keymap-capture"] [data-pending="true"]')?.textContent ?? ""`,
        );
        expect(recorded, "the bound chord was read, not dispatched").toContain("-");

        // Overwrite the pending chord with the one this test commits — an
        // unclaimed chord, for the reason the first test states.
        await app.nativeKey("y", ["cmd", "ctrl"]);
        await app.waitForCondition<boolean>(
          `(document.querySelector('[data-testid="keymap-capture"] [data-pending="true"]')?.textContent ?? "").includes("Y")`,
          { timeoutMs: 6000 },
        );
        await app.click('[data-testid="keymap-capture-use"]');

        expect(
          await waitKeyEquivalent(app, "view.zoomOut", "y"),
          "the menu bar took the chord the pane recorded",
        ).toBe("y");
        const rebound = await app.menuItemState("view.zoomOut");
        expect(rebound.found ? rebound.modifierMask : undefined).toBe(COMMAND | CONTROL);

        // Disarming restored what parking took: an item the capture never
        // touched has its own chord back, not a chordless ghost.
        expect(
          await waitKeyEquivalent(app, "view.zoomIn", "+"),
          "a parked bystander item got its chord back on disarm",
        ).toBe("+");

        // Reset from the pane's own per-row affordance. Addressed by its
        // accessible name, which is the label the user reads — an icon button
        // has no text, so the name IS the control.
        const RESET = '[aria-label="Reset Zoom Out to its default chord"]';
        await app.waitForCondition<boolean>(
          `document.querySelector(${JSON.stringify(RESET)}) !== null`,
          { timeoutMs: 6000 },
        );
        await app.click(RESET);
        expect(
          await waitKeyEquivalent(app, "view.zoomOut", "-"),
          "reset gave the item its shipped chord back",
        ).toBe("-");
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0182-pane] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "arming a row grows it without moving anything the user is looking at",
    async () => {
      // A row that arms grows by the height of the capture strip, and the
      // list must absorb that growth underneath it: the title stays on its
      // line and the scroll position does not change, so the Change button
      // does not slide out from under the pointer that just pressed it.
      //
      // The sharp case is a scroller parked at its own scroll maximum, where
      // `SmartScroll.maybePinToBottom` used to read an idle-at-bottom list as
      // a reader waiting on the next append and re-engage follow-bottom —
      // which then pinned the bottom edge and yanked every row above it up by
      // the 40px the armed row had gained. A list built with
      // `followBottom: false` has no live edge to return to, so that route is
      // closed to it now.
      const app = await launchTugApp({ testName: "at0182-arm-still" });
      try {
        await app.waitForCondition<boolean>(
          `typeof window.__tug !== "undefined" && typeof window.tugdeck !== "undefined"`,
        );
        await app.evalJS(`window.__tug.dispatchControlAction("show-keyboard-shortcuts", {})`);
        await app.waitForCondition<boolean>(
          `document.querySelector('[data-testid="settings-keymap"]') !== null`,
          { timeoutMs: 8000 },
        );

        const SCROLLER = `document.querySelector('[data-testid="settings-keymap"] .tug-list-view')`;
        await app.evalJS(`(() => { const s = ${SCROLLER}; s.scrollTop = s.scrollHeight; })()`);
        await new Promise((r) => setTimeout(r, 600));

        // The bottom-most armable rows, which is where the growth has least
        // room and the retired pin route used to fire.
        const ids = await app.evalJS<string[]>(`(() => {
          const s = ${SCROLLER};
          const r = s.getBoundingClientRect();
          return [...document.querySelectorAll('[data-testid^="keymap-arm-"]')]
            .filter((a) => { const b = a.getBoundingClientRect();
                             return b.top >= r.top && b.bottom <= r.bottom; })
            .map((a) => a.getAttribute("data-testid"))
            .slice(-6);
        })()`);
        expect(ids.length, "the list offered rows to arm").toBeGreaterThan(0);

        const probe = async (id: string) =>
          await app.evalJS<{ top: number; rowTop: number }>(`(() => {
            const s = ${SCROLLER};
            const a = document.querySelector('[data-testid="${id}"]');
            return { top: s.scrollTop, rowTop: Math.round(a.getBoundingClientRect().top) };
          })()`);

        const moved: string[] = [];
        for (const id of ids) {
          const before = await probe(id);
          await app.click(`[data-testid="${id}"]`);
          await app.waitForCondition<boolean>(
            `document.querySelector('[data-testid="keymap-capture"]') !== null`,
            { timeoutMs: 6000 },
          );
          await new Promise((r) => setTimeout(r, 250));
          const after = await probe(id);
          if (after.top !== before.top || after.rowTop !== before.rowTop) {
            moved.push(
              `${id}: scrollTop ${before.top}->${after.top}, row top ${before.rowTop}->${after.rowTop}`,
            );
          }
          await app.click('[data-testid="keymap-capture-cancel"]');
          await new Promise((r) => setTimeout(r, 200));
        }
        expect(moved, "arming moved nothing").toEqual([]);
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0182-arm-still] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a locked command refuses the override and keeps its chord",
    async () => {
      const app = await launchTugApp({ testName: "at0182-locked" });
      try {
        await app.seedDeckState({ state: singleCardDeck(), focusCardId: "C0" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("C0")`,
        );

        expect(await waitKeyEquivalent(app, "edit.selectAll", "a")).toBe("a");

        // The mechanism could do it; the policy says no ([P12]). Enforced on
        // read as well as on write, so a value written from a shell — which
        // is exactly what this is — cannot get around it.
        await writeOverride(app, "select-all", [
          { chord: { key: "KeyY", meta: true, label: "y" }, scope: { kind: "global" } },
        ]);
        // Give the push a beat to be ignored, then assert nothing moved.
        await new Promise((r) => setTimeout(r, 500));
        const state = await app.menuItemState("edit.selectAll");
        expect(state.found ? state.keyEquivalent : undefined, "⌘A stands").toBe("a");
        expect(state.found ? state.modifierMask : undefined).toBe(COMMAND);
      } catch (err) {
        const tail = app.tailLog(200);
        if (tail !== "") process.stderr.write(`\n[at0182-locked] log tail:\n${tail}\n`);
        throw err;
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
