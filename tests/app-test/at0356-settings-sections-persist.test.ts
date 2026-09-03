/**
 * at0356-settings-sections-persist.test.ts — the Settings card remembers
 * which section you were on ([AT0356]).
 *
 * Two claims, and the second is the one with teeth.
 *
 * **A fresh profile opens on General.** What is persisted is the selected
 * section, so a profile that has never stored anything lands on the first
 * section. The test starts from a genuinely absent key (DELETE, not "set to
 * empty") because those are different states and only the absent one is what
 * a new user has.
 *
 * **A selection outlives the card.** Settings is a singleton that is closed
 * and reopened constantly, and its card state is pruned along with it, so the
 * selection is kept in a standalone tugbank domain instead. Closing the card
 * and opening a new one has to bring the reader back to the section they were
 * on, or the memory is only a memory until the next ⌘W.
 *
 * Gating: `describe.skipIf(!SHOULD_RUN)`.
 *
 * @covers tugdeck/src/components/tugways/cards/settings-card.tsx
 * @covers tugdeck/src/components/tugways/tug-tab-view.tsx
 * @covers tugdeck/src/components/tugways/tug-tab-view.css
 * @covers tugdeck/src/lib/settings-sections-pref.ts
 */

import { describe, expect, test } from "bun:test";
import { launchTugApp } from "./_harness";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";

const NO_AX = { skipAccessibilityPreflight: true } as const;

const DOMAIN = "dev.tugapp.settings-card";
const KEY = "selectedSection";

const SETTINGS_CARD = '[data-testid="settings-card"]';

/** Expression: the section id currently showing (its panel carries the
 *  `settings-section-<id>` testid; only the selected one exists). */
const SHOWING_SECTION_ID = `(() => {
  const el = document.querySelector(
    ${JSON.stringify(`${SETTINGS_CARD} [data-testid^="settings-section-"]`)},
  );
  return el === null
    ? null
    : el.getAttribute("data-testid").replace("settings-section-", "");
})()`;

/** Expression: how many sidebar tabs the card renders. */
const TAB_COUNT = `document.querySelectorAll(
  ${JSON.stringify(`${SETTINGS_CARD} [data-testid^="tug-tab-view-tab-"]`)},
).length`;

const SHOW_SETTINGS = `window.__tug.dispatchControlAction("show-card", { component: "settings" })`;

describe.skipIf(!SHOULD_RUN)("at0356: Settings remembers the selected section", () => {
  test("opens on General with no stored value, and a selection survives close and reopen", async () => {
    const app = await launchTugApp({
      ...NO_AX,
      testName: "at0356-settings-sections-persist",
    });
    try {
      await app.waitForCondition<boolean>(
        `typeof window.__tug !== "undefined" && typeof window.tugdeck !== "undefined"`,
      );

      // ---- Start from "never set" — not "set to empty", which is a state a
      //      reader can reach but a new profile cannot.
      await app.evalJS(`(() => {
        window.__at0356_cleared = false;
        fetch("/api/defaults/${DOMAIN}/${KEY}", { method: "DELETE" })
          .then(() => { window.__at0356_cleared = true; })
          .catch(() => { window.__at0356_cleared = true; });
      })()`);
      await app.waitForCondition<boolean>(`window.__at0356_cleared === true`);

      // ---- First open: every section has a sidebar tab, General showing.
      await app.evalJS(SHOW_SETTINGS);
      await app.waitForCondition<boolean>(`${TAB_COUNT} === 4`, {
        timeoutMs: 8000,
      });
      await app.waitForCondition<boolean>(
        `${SHOWING_SECTION_ID} === "general"`,
        { timeoutMs: 8000 },
      );

      // ---- Select another section, by the gesture a reader makes: clicking
      //      its sidebar tab.
      await app.click('[data-testid="tug-tab-view-tab-textCard"]');
      await app.waitForCondition<boolean>(
        `${SHOWING_SECTION_ID} === "textCard"`,
        { timeoutMs: 8000 },
      );

      // The write landed in tugbank as the selected section.
      await app.evalJS(`(() => {
        window.__at0356_stored = undefined;
        const poll = () => {
          fetch("/api/defaults/${DOMAIN}/${KEY}")
            .then((r) => (r.ok ? r.json() : null))
            .then((j) => {
              if (j && j.kind === "string") { window.__at0356_stored = j; return; }
              window.setTimeout(poll, 100);
            })
            .catch((e) => {
              window.__at0356_stored = { kind: "error", value: String(e) };
            });
        };
        poll();
      })()`);
      const stored = await app.waitForCondition<{ kind: string; value: unknown }>(
        `window.__at0356_stored === undefined ? false : window.__at0356_stored`,
        { timeoutMs: 8000 },
      );
      expect(stored.kind).toBe("string");
      expect(stored.value).toBe("textCard");

      // ---- Close the card, then open a fresh one.
      const settingsPaneId = await app.evalJS<string>(
        `(() => {
          const s = window.tugdeck.diag.getDeckState();
          const card = s.cards.find((c) => c.componentId === "settings");
          return s.panes.find((p) => p.cardIds.includes(card.id)).id;
        })()`,
      );
      await app.evalJS(
        `window.__tug.closePane(${JSON.stringify(settingsPaneId)})`,
      );
      await app.waitForCondition<boolean>(
        `document.querySelector(${JSON.stringify(SETTINGS_CARD)}) === null`,
        { timeoutMs: 8000 },
      );

      await app.evalJS(SHOW_SETTINGS);
      await app.waitForCondition<boolean>(`${TAB_COUNT} === 4`, {
        timeoutMs: 8000,
      });

      // ---- The reader's place came back: Text Card showing, its tab marked
      //      active.
      await app.waitForCondition<boolean>(
        `${SHOWING_SECTION_ID} === "textCard"`,
        { timeoutMs: 8000 },
      );
      expect(
        await app.evalJS<string | null>(
          `document.querySelector(
            '[data-testid="tug-tab-view-tab-textCard"]',
          ).getAttribute("data-active")`,
        ),
      ).toBe("true");
    } finally {
      await app.close();
    }
  });
});
