/**
 * at0800-style-census-settings-groups.test.ts — the bordered settings groups
 * look exactly as they did before their four copies became one primitive.
 *
 * The Settings card's General, Session Card, Text Files and Viewers sections
 * each drew the same box — a bordered `TugBox` with its legend painted on the
 * border line, out of flow, over a left-packed column — from its own copy of
 * the same four rules. Those now live in `TugSettingsGroup`, and the one claim
 * worth pinning is that nothing a user can see moved. This file reads a fixed
 * property list off one group of each section (and the Text Files section's
 * one-line group, whose override now sits on the shared rule) and compares it
 * with the baseline recorded before the CSS moved
 * (`style-census/settings-groups.json`; `TUG_STYLE_CENSUS_RECORD=1` rewrites
 * it).
 *
 * @covers tests/app-test/_harness/style-census.ts
 * @covers tugdeck/src/components/tugways/tug-settings-group.tsx
 * @covers tugdeck/src/components/tugways/tug-settings-group.css
 * @covers tugdeck/src/components/tugways/tug-box.tsx
 * @covers tugdeck/src/components/tugways/tug-box.css
 * @covers tugdeck/src/components/tugways/cards/settings-general-body.css
 * @covers tugdeck/src/components/tugways/cards/settings-session-card-body.css
 * @covers tugdeck/src/components/tugways/cards/text-card-controls.tsx
 * @covers tugdeck/src/components/tugways/cards/text-card-controls.css
 * @covers tugdeck/src/components/tugways/cards/card-view-controls.css
 * @covers tugdeck/src/components/tugways/cards/image-card-controls.tsx
 * @covers tugdeck/src/components/tugways/cards/pdf-card-controls.tsx
 */

import { describe, test } from "bun:test";

import { launchTugApp } from "./_harness";
import { kindBody } from "./_harness/card-reach";
import { censusRead, expectCensus, type CensusEntry, type CensusReading } from "./_harness/style-census";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;

const exists = (sel: string): string =>
  `document.querySelector(${JSON.stringify(sel)}) !== null`;

/** One group's box, its legend and its body column. */
function group(sel: string): CensusEntry[] {
  return [
    { selector: sel },
    { selector: `${sel} > .tug-box-legend` },
    { selector: `${sel} > .tug-box-body` },
  ];
}

const SECTIONS: Array<{ tab: string; root: string; groups: string[] }> = [
  {
    tab: "general",
    root: '[data-testid="settings-general"]',
    groups: [".settings-general-group:nth-of-type(1)"],
  },
  {
    tab: "sessionCard",
    root: '[data-testid="settings-session-card"]',
    groups: [".settings-session-card-group:nth-of-type(1)"],
  },
  {
    tab: "textCard",
    root: '[data-testid="settings-text-card"]',
    groups: [
      ".text-card-controls-group:nth-of-type(1)",
      ".text-card-controls-group-inline",
    ],
  },
  {
    tab: "viewerCard",
    root: '[data-testid="settings-viewer-card"]',
    groups: ['[data-testid="image-card-controls"] > .card-view-controls-group:nth-of-type(1)'],
  },
];

describe.skipIf(!SHOULD_RUN)("at0800 — style census: settings groups", () => {
  test(
    "one group of each Settings section matches its recording",
    async () => {
      const app = await launchTugApp({ testName: "at0800-style-census-settings-groups" });
      try {
        await app.evalJS(
          `window.__tug.dispatchControlAction("show-card", { component: "settings" })`,
        );
        const settings = kindBody(app, "settings");
        const reading: CensusReading = {};
        for (const section of SECTIONS) {
          if (section.tab !== "general") {
            await settings.click(`[data-testid="tug-tab-view-tab-${section.tab}"]`);
          }
          await settings.waitForCondition<boolean>(exists(section.root), { timeoutMs: 10_000 });
          Object.assign(
            reading,
            await censusRead(
              settings,
              section.groups.flatMap((g) => group(`${section.root} ${g}`)),
            ),
          );
        }
        expectCensus("settings-groups", reading);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
