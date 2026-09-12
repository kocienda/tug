/**
 * at0562-return-home-is-this-card.test.ts — Return's home is a button on the
 * card you are typing in, never one on a card you cannot see.
 *
 * ## The defect
 *
 * The default-button stack is process-global. An editor's submit Enter defers
 * to it ("a dialog above the editor owns Return"), and that defer was scoped
 * by PANE. A pane is too wide a scope to say what it was trying to say: a
 * pane's tab stack keeps EVERY card mounted and hides the inactive ones with
 * `display: none` (`card-host.tsx`), and the stack is last-registered-wins —
 * so the pane's topmost default button is whichever card acted most recently,
 * on screen or not. A `Shift+Return` in the visible composer then pressed
 * THAT, and the press the user made vanished: their prompt stayed in the
 * editor, their join never fired, and nothing on screen said why.
 *
 * The rule that replaces it: a button inside a card answers to that card
 * alone; only a button in no card at all (a pane-level sheet — a shade portals
 * into the pane frame, never into a card root) is the whole pane's to press.
 * A button that is not rendered is nobody's.
 *
 * ## The shape
 *
 * Two Session cards in one pane's tab stack. The second one is driven into
 * commit mode and then hidden behind the first, which is what puts a live,
 * off-screen Z5 on top of the stack — the ordering the bug needs and the one
 * the field produces constantly, since every Session card re-registers its Z5
 * whenever its submit mode flips. The key is then typed in the VISIBLE card's
 * composer, and the press visual (`data-pressing`, stamped by
 * `pressDefaultButton`) says which card took it. Nothing here submits: an
 * empty composer's Z5 no-ops, so the test reads the routing decision without
 * sending anything anywhere.
 *
 * @covers tugdeck/src/components/tugways/responder-chain.ts
 * @covers tugdeck/src/components/tugways/tug-text-editor.tsx
 * @covers tugdeck/src/components/tugways/responder-chain-provider.tsx
 * @covers tugdeck/src/components/tugways/tug-filter-field.tsx
 */

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { launchTugApp, note } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 180_000;

/** The worktree — the real repo tugcast serves as its bootstrap tree. */
const REPO = resolve(import.meta.dir, "..", "..");

const editorFor = (card: string): string =>
  `[data-card-id="${card}"] [data-slot="tug-text-editor"] .cm-content`;
const commitFor = (card: string): string =>
  `[data-card-id="${card}"] .tug-prompt-entry-commit-button`;
const tabFor = (card: string): string => `[data-testid="tug-tab-${card}"]`;

const settle = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/** One pane, two Session cards, the first one active. */
function deckShape() {
  return {
    cards: [
      { id: "D", componentId: "session", title: "Session D", closable: true },
      { id: "E", componentId: "session", title: "Session E", closable: true },
    ],
    panes: [
      {
        id: "pD",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 720 },
        cardIds: ["D", "E"],
        activeCardId: "D",
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "pD",
    hasFocus: true,
  };
}

describe.skipIf(!SHOULD_RUN)(
  "AT0562: Return's home is on the card you are typing in",
  () => {
    test(
      "a hidden card's live Z5 never takes the visible composer's Shift+Return",
      async () => {
        const tugbankPath = mkTempTugbank();
        seedTugbankForLaunch(tugbankPath, { sourceTreePath: REPO });
        const app = await launchTugApp({
          testName: "at0562-return-home-is-this-card",
          env: { TUGBANK_PATH: tugbankPath },
          persistInTestMode: true,
        });
        try {
          await app.waitForCondition<boolean>(
            `typeof window.__tug !== "undefined"`,
            { timeoutMs: 15_000 },
          );
          await app.seedDeckState({ state: deckShape(), focusCardId: "D" });
          await app.waitForCondition<boolean>(
            `window.__tug.assertHostRootRegistered("D")`,
            { timeoutMs: 15_000 },
          );
          await app.bindSession("D", { projectDir: REPO });
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(editorFor("D"))}) !== null`,
            { timeoutMs: 15_000 },
          );

          // ---- Put a live Z5 on the card that is about to be hidden ----
          //
          // Commit mode mounts E's own commit button, which registers LAST and
          // so tops the pane's stack. Then E goes behind D: mounted, its
          // button still registered, and not a pixel of it on screen.
          await app.nativeClickAtElement(tabFor("E"));
          await settle(500);
          await app.waitForCondition<boolean>(
            `window.__tug.assertHostRootRegistered("E")`,
            { timeoutMs: 15_000 },
          );
          await app.bindSession("E", { projectDir: REPO });
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(editorFor("E"))}) !== null`,
            { timeoutMs: 15_000 },
          );
          await app.nativeClickAtElement(editorFor("E"));
          await settle(300);
          note("before chord", await app.evalJS(
            `(function(){
              var active = document.querySelector("[data-card-host]:not([style*='none'])");
              var kv = document.querySelector("[data-key-view-kbd]");
              return {
                activeCard: active === null ? null : active.getAttribute("data-card-id"),
                keyView: kv === null ? null : (kv.getAttribute("data-slot") || kv.tagName),
              };
            })()`,
          ));
          await app.nativeKey("c", ["ctrl", "cmd"]);
          await settle(1500);
          note("after chord", await app.evalJS(
            `(function(){
              function card(sel){ var el = document.querySelector(sel); if (el === null) return null; var h = el.closest("[data-card-host]"); return h === null ? "no-card" : h.getAttribute("data-card-id"); }
              var act = document.activeElement;
              var actHost = act === null ? null : act.closest("[data-card-host]");
              return {
                commitButtons: Array.prototype.map.call(
                  document.querySelectorAll(".tug-prompt-entry-commit-button"),
                  function(b){ var h = b.closest("[data-card-host]"); return h === null ? "no-card" : h.getAttribute("data-card-id"); }),
                activeElementCard: actHost === null ? null : actHost.getAttribute("data-card-id"),
                shades: Array.prototype.map.call(
                  document.querySelectorAll("[data-shade-open]"),
                  function(e){ return e.getAttribute("data-shade-open"); }),
                editorCard: card(${JSON.stringify(editorFor("E"))}),
              };
            })()`,
          ));
          await app.waitForCondition<boolean>(
            `document.querySelector(${JSON.stringify(commitFor("E"))}) !== null`,
            { timeoutMs: 12_000 },
          );
          await settle(400);
          await app.nativeClickAtElement(tabFor("D"));
          await settle(600);

          const rival = await app.evalJS<{ mounted: boolean; visible: boolean }>(
            `(function(){
              var btn = document.querySelector(${JSON.stringify(commitFor("E"))});
              if (btn === null) return { mounted: false, visible: false };
              return {
                mounted: true,
                visible: typeof btn.checkVisibility === "function"
                  ? btn.checkVisibility()
                  : false,
              };
            })()`,
          );
          note("rival Z5", rival);
          expect(rival.mounted, "E's commit button is still mounted behind D").toBe(true);
          expect(rival.visible, "and not on screen").toBe(false);

          // ---- The key, typed where the user can see ----
          //
          // `pressDefaultButton` stamps `data-pressing` on whatever it decides
          // to press, so the observer reads the routing decision itself rather
          // than its downstream effect. D's composer is empty, so its own Z5
          // no-ops when pressed — nothing is sent anywhere.
          await app.evalJS<boolean>(
            `(function(){
              window.__at0562Pressed = null;
              var obs = new MutationObserver(function(records){
                for (var i = 0; i < records.length; i++) {
                  var el = records[i].target;
                  if (!(el instanceof Element)) continue;
                  if (!el.hasAttribute("data-pressing")) continue;
                  if (window.__at0562Pressed !== null) continue;
                  var host = el.closest("[data-card-host]");
                  window.__at0562Pressed = host === null
                    ? "no-card"
                    : host.getAttribute("data-card-id");
                }
              });
              obs.observe(document.body, {
                attributes: true,
                subtree: true,
                attributeFilter: ["data-pressing"],
              });
              return true;
            })()`,
          );

          await app.nativeClickAtElement(editorFor("D"));
          await settle(300);
          await app.nativeKey("Return", ["shift"]);
          await settle(700);

          const pressed = await app.evalJS<string | null>(
            `window.__at0562Pressed ?? null`,
          );
          note("pressed card", pressed);
          expect(
            pressed,
            "the press stayed on D — the card the keyboard is in",
          ).toBe("D");
        } finally {
          await app.close();
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
