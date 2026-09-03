/**
 * at0126-keyboard-ring-cold-boot.test.ts — the keyboard focus POSITION survives
 * a full reload / relaunch, carried on the focus axis (`bag.focus`).
 *
 * Two-phase cold-boot round-trip, modeled on at0014-cold-boot-scroll:
 *
 * | Phase | Action                                        | Assertion                                                  |
 * |-------|-----------------------------------------------|------------------------------------------------------------|
 * | A     | seed radio card → Tab (rings the group) → quit| tugbank disk holds `bag.focus = {kind:"dom", keyboard:true}`|
 * | B     | relaunch, re-inject bag → wait for ready      | the group wears `data-key-view` after restore — and NOT the ring |
 *
 * Phase A failure ⇒ the position was not captured onto the focus axis (focus
 * left the group before save, or the focus-key isn't emitted). Phase B failure
 * ⇒ `applyBagFocus` didn't re-place the key view on restore.
 *
 * **Why phase B asserts the key view and not the ring.** Under KBF mode
 * ([arc/kbf-mode.md]) `data-key-view-kbd` means "a ring is painted here",
 * and the mode bit is session-transient by design — a relaunched deck is in
 * mode OFF until the user asks for the mode again. So the restored key view is
 * correctly *unpainted*, and phase B asserts that too: what persists across a
 * cold boot is where the keyboard was, not what mode the user was in.
 *
 * @foreground
 * @covers tugdeck/src/components/tugways/focus-manager.ts
 * @covers tugdeck/src/serialization.ts
 * @covers tugdeck/src/keyboard-access-store.ts
 * @covers tugdeck/src/focus-ring-modality-store.ts
 * @covers tugdeck/src/components/tugways/cards/gallery-accordion.tsx
 * @covers tugdeck/src/components/tugways/cards/gallery-radio-group.tsx
 * @covers tugdeck/src/components/tugways/tug-accordion.tsx
 * @covers tugdeck/src/components/tugways/tug-radio-group.css
 * @covers tugdeck/src/components/tugways/tug-radio-group.tsx
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp } from "./_harness";
import {
  mkTempTugbank,
  rmTempTugbank,
  seedTugbankForLaunch,
  tugbankRead,
} from "./_harness/tugbank-helpers";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 90_000;

const CARD_ID = "A";
const CARD = `[data-card-id="${CARD_ID}"]`;

// Two components exercise the two restore paths: the radio group is in the DOM
// at restore time (synchronous resolve); the Radix accordion late-mounts, so it
// resolves as `deferred-dom` and re-lights via the engine's `armKeyboardRestore`
// when its focusable finally registers.
const VARIANTS = [
  {
    name: "radio (synchronous resolve)",
    componentId: "gallery-radio-group",
    title: `${CARD} [data-testid="radio-focus-title"]`,
    group: `${CARD} [data-testid="radio-focus-demo"] [data-slot="tug-radio-group"]`,
    focusKey: "gallery-radio-focus:0",
  },
  {
    name: "accordion (late-mount resolve)",
    componentId: "gallery-accordion",
    title: `${CARD} [data-testid="accordion-focus-title"]`,
    group: `${CARD} [data-testid="accordion-focus-demo"] [data-slot="tug-accordion"]`,
    focusKey: "gallery-accordion-focus:0",
  },
] as const;

function deckShape(componentId: string) {
  return {
    cards: [{ id: CARD_ID, componentId, title: "Card", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 560, height: 620 },
        cardIds: [CARD_ID],
        activeCardId: CARD_ID,
        title: "",
        acceptsFamilies: ["maker"],
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

interface FocusBag {
  focus?: { kind: string; focusKey?: string; keyboard?: boolean } | null;
}

describe.skipIf(!SHOULD_RUN)("AT0126: keyboard ring survives cold boot", () => {
  for (const v of VARIANTS) {
    // The KEY VIEW, not the ring. Under KBF mode ([arc/kbf-mode.md]) the
    // `-kbd` flavor means "a ring is painted here", and the mode bit is
    // session-transient by design — a cold boot lands in mode OFF, so the
    // restored key view is correctly unpainted. What this test is about is the
    // focus AXIS surviving the round trip, which is the unflavored attribute.
    const keyViewOf = (sel: string) => `(function(){
      var el = document.querySelector(${JSON.stringify(sel)});
      return el ? el.hasAttribute("data-key-view") : false;
    })()`;

    test(
      `${v.name}: ring captured to bag.focus and restored on relaunch`,
      async () => {
        const tugbankPath = mkTempTugbank();
        seedTugbankForLaunch(tugbankPath);

        try {
          // ── Phase A: ring the group, then quit (save → disk). ──
          {
            const app = await launchTugApp({
              testName: "at0126-keyboard-ring-A",
              env: { TUGBANK_PATH: tugbankPath },
              skipAccessibilityPreflight: true,
              persistInTestMode: true,
              // Foreground: the ring is captured on app resign, which only
              // fires for an app that is actually active.
              foreground: true,
            });

            await app.seedDeckState({ state: deckShape(v.componentId), focusCardId: CARD_ID });
            await app.waitForCondition<boolean>(
              `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered(${JSON.stringify(CARD_ID)})`,
            );
            await app.waitForCondition<boolean>(
              `document.querySelector(${JSON.stringify(v.group)}) !== null`,
              { timeoutMs: 8000 },
            );

            await app.nativeClickAtElement(v.title);
            await app.waitForCondition<boolean>(`document.hasFocus()`, { timeoutMs: 10000 });
            await new Promise((r) => setTimeout(r, 150));

            // Tab ENGAGES KBF and steps ([P07]), so this half still sees a
            // painted ring — the mode is on because the user just asked for it.
            await app.nativeKey("Tab");
            await app.waitForCondition<boolean>(keyViewOf(v.group), { timeoutMs: 6000 });
            expect(await app.evalJS<boolean>(keyViewOf(v.group))).toBe(true);

            await app.quitGracefully();
          }

          // ── Phase A assertion: bag.focus on disk carries the ring. ──
          const onDisk = tugbankRead<FocusBag>(
            tugbankPath,
            "dev.tugtool.deck.cardstate",
            CARD_ID,
          );
          expect(onDisk).not.toBeNull();
          expect(onDisk?.type).toBe("json");
          expect(onDisk?.value?.focus?.kind).toBe("dom");
          expect(onDisk?.value?.focus?.focusKey).toBe(v.focusKey);
          expect(onDisk?.value?.focus?.keyboard).toBe(true);

          // ── Phase B: relaunch, re-inject bag, assert ring restored. ──
          {
            const app = await launchTugApp({
              testName: "at0126-keyboard-ring-B",
              env: { TUGBANK_PATH: tugbankPath },
              skipAccessibilityPreflight: true,
              persistInTestMode: true,
              // Foreground: the ring is captured on app resign, which only
              // fires for an app that is actually active.
              foreground: true,
            });
            try {
              const bagRecord: Record<string, unknown> = {};
              bagRecord[CARD_ID] = onDisk!.value;

              await app.seedDeckState({
                state: deckShape(v.componentId),
                cardStates: bagRecord,
                focusCardId: CARD_ID,
              });
              await app.waitForCondition<boolean>(
                `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered(${JSON.stringify(CARD_ID)})`,
              );
              await app.waitForCondition<boolean>(
                `document.querySelector(${JSON.stringify(v.group)}) !== null`,
                { timeoutMs: 8000 },
              );

              // The key view should land back on the group with no Tab. The
              // RING does not come back with it, and should not: the KBF bit is
              // session-transient, so a relaunched deck is in mode OFF until the
              // user asks for the mode again. The focus axis is what persists.
              const restored = await app.waitForCondition<boolean>(keyViewOf(v.group), {
                timeoutMs: 6000,
              });
              expect(restored).toBe(true);
              expect(
                await app.evalJS<boolean>(
                  `document.documentElement.hasAttribute("data-kbf")`,
                ),
                "a cold boot restores the key view, not the mode",
              ).toBe(false);
            } finally {
              await app.quitGracefully();
            }
          }
        } finally {
          rmTempTugbank(tugbankPath);
        }
      },
      TEST_TIMEOUT_MS,
    );
  }
});
