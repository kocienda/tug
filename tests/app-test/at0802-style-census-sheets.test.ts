/**
 * at0802-style-census-sheets.test.ts — the read-only sheets' headers and
 * notices look exactly as they did before their copies became one header.
 *
 * The hooks and skills sheets wrote the same header (a summary column and a
 * trailing action cluster) and the same centred notice from their own CSS;
 * the memory sheet repeated the header with its own alignment; the usage and
 * data-visualization sheets repeated one muted notice line. Those now live in
 * `sheet-header.css`, and the one claim worth pinning is that nothing a user
 * can see moved. This file opens each sheet through its slash command, reads
 * a fixed property list off its header or notice, and compares it with the
 * baseline recorded before the CSS moved (`style-census/sheets.json`;
 * `TUG_STYLE_CENSUS_RECORD=1` rewrites it).
 *
 * The session's usage store is left unseeded, so the usage sheet draws its
 * notice line; the data-visualization sheet wears the same one, and in this
 * fixture finds its recipes and draws none, so the usage sheet's is the
 * reading for both.
 *
 * @covers tests/app-test/_harness/style-census.ts
 * @covers tugdeck/src/components/tugways/cards/sheet-header.tsx
 * @covers tugdeck/src/components/tugways/cards/sheet-header.css
 * @covers tugdeck/src/components/tugways/cards/hooks-sheet.css
 * @covers tugdeck/src/components/tugways/cards/skills-sheet.css
 * @covers tugdeck/src/components/tugways/cards/memory-sheet.css
 * @covers tugdeck/src/components/tugways/cards/usage-sheet.css
 * @covers tugdeck/src/components/tugways/cards/data-visualization-sheet.tsx
 */

import { describe, test } from "bun:test";

import { launchTugApp, type App } from "./_harness";
import { waitForBodyReady } from "./_harness/card-reach";
import { sessionCardShape } from "./_harness/shapes";
import { censusRead, expectCensus, type CensusEntry, type CensusReading } from "./_harness/style-census";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;
const SID = "at0802-session";

const CARD = '[data-card-id="A"]';
const PROMPT_INPUT = `${CARD} [data-slot="tug-text-editor"] .cm-content`;
const SUBMIT_BTN = `${CARD} .tug-prompt-entry-submit-button`;
const SHEET = '[data-slot="tug-sheet"]';

const exists = (sel: string): string =>
  `document.querySelector(${JSON.stringify(sel)}) !== null`;

/** A sheet's header: the strip, its text column, its actions and its summary. */
function header(sheet: string, parts: string[]): CensusEntry[] {
  return [
    { selector: `${SHEET} .${sheet}-sheet .tug-sheet-scaffold-header` },
    ...parts.map((part) => ({ selector: `${SHEET} .${sheet}-sheet-${part}` })),
  ];
}

const SHEETS: Array<{ command: string; ready: string; entries: CensusEntry[] }> = [
  {
    command: "/hooks",
    ready: `${SHEET} .hooks-sheet-header`,
    entries: header("hooks", ["header", "header-text", "header-actions"]),
  },
  {
    command: "/skills",
    ready: `${SHEET} .skills-sheet-header`,
    entries: header("skills", ["header", "header-text", "header-actions"]),
  },
  {
    command: "/memory",
    ready: `${SHEET} .memory-sheet-header`,
    entries: header("memory", ["header", "summary"]),
  },
  {
    command: "/usage",
    ready: `${SHEET} .usage-sheet-notice`,
    entries: [{ selector: `${SHEET} .usage-sheet-notice` }],
  },
];

async function run(app: App, command: string): Promise<void> {
  await app.body("A").nativeClickAtElement(PROMPT_INPUT);
  await app.nativeType(command);
  await app.body("A").nativeClickAtElement(SUBMIT_BTN);
}

describe.skipIf(!SHOULD_RUN)("at0802 — style census: sheets", () => {
  test(
    "the read-only sheets' headers and notices match their recording",
    async () => {
      const app = await launchTugApp({ testName: "at0802-style-census-sheets" });
      try {
        await app.seedDeckState({ state: sessionCardShape({ width: 675, height: 680 }), focusCardId: "A" });
        await app.waitForCondition<boolean>(
          `(typeof window.__tug !== "undefined") && window.__tug.assertHostRootRegistered("A")`,
        );
        await app.bindSession("A", { tugSessionId: SID });
        await app.awaitEngineReady("A");
        const body = await waitForBodyReady(app, "A");

        const reading: CensusReading = {};
        for (const sheet of SHEETS) {
          await run(app, sheet.command);
          await body.waitForCondition<boolean>(exists(sheet.ready), { timeoutMs: 8_000 });
          Object.assign(reading, await censusRead(body, sheet.entries));
          await app.nativeKey("Escape");
          await body.waitForCondition<boolean>(`!(${exists(SHEET)})`, { timeoutMs: 5_000 });
        }
        expectCensus("sheets", reading);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
