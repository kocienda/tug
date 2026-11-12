/**
 * at0799-style-census-receipts-and-notices.test.ts — the notices, the
 * Overview's posts and the Cards badges look exactly as they did before their
 * reach-in CSS became primitive variants.
 *
 * Four features used to restyle a primitive from their own CSS: the usage-limit
 * notice rewrote `TugInlineAlert`'s border, icon and body; the Overview
 * restyled `TugTranscriptEntry`'s gutter, identifier, timestamp and glyph; the
 * Cards space tally stripped `TugBadge`'s padding; and the Cards column badge
 * overrode six of `TugColumnBadge`'s tokens. Those now live in the primitives
 * as variants the features pass, and the one claim worth pinning is that
 * nothing a user can see moved. This file reads a fixed property list off each
 * and compares it with the baseline recorded before the CSS moved
 * (`style-census/receipts-and-notices.json`; `TUG_STYLE_CENSUS_RECORD=1`
 * rewrites it).
 *
 * @covers tests/app-test/_harness/style-census.ts
 * @covers tugdeck/src/components/tugways/tug-inline-alert.tsx
 * @covers tugdeck/src/components/tugways/tug-inline-alert.css
 * @covers tugdeck/src/components/tugways/cards/session-usage-limit-notice.tsx
 * @covers tugdeck/src/components/tugways/cards/session-usage-limit-notice.css
 * @covers tugdeck/src/components/tugways/tug-transcript-entry.css
 * @covers tugdeck/src/components/overview/overview-card.css
 * @covers tugdeck/src/components/tugways/tug-badge.tsx
 * @covers tugdeck/src/components/tugways/tug-badge.css
 * @covers tugdeck/src/components/tugways/tug-column-badge.tsx
 * @covers tugdeck/src/components/tugways/tug-column-badge.css
 * @covers tugdeck/src/components/cards/cards-column-badge.tsx
 * @covers tugdeck/src/components/cards/cards-column-badge.css
 * @covers tugdeck/src/components/cards/cards-space-header.tsx
 */

import { describe, test } from "bun:test";

import { launchTugApp } from "./_harness";
import { kindBody } from "./_harness/card-reach";
import type { SessionDriveAction } from "./_harness/client";
import { censusRead, expectCensus, type CensusReading } from "./_harness/style-census";

const SHOULD_RUN = process.env.TUGAPP_APP_TEST === "1";
const TEST_TIMEOUT_MS = 60_000;
const FEED_CODE_OUTPUT = 0x40;
const SID = "at0799-A";
const MSG = `${SID}-m1`;

const NOTICE = ".session-usage-limit-notice";
const POST = '[data-testid="overview-transcript"] .tug-transcript-entry';
const TALLY = '[data-testid="cards-space-count"] .tug-badge';
const COLUMN_BADGE = '.cards-list [data-testid="cards-column-badge"]';

const COLUMN_BADGE_TOKENS = [
  "--tugx-column-badge-fg",
  "--tugx-column-badge-fill",
  "--tugx-column-badge-stroke",
  "--tugx-column-badge-lit-fill",
  "--tugx-column-badge-accent",
  "--tugx-column-badge-knockout",
  "color",
  "margin-left",
];
const SLICE_PAINT = ["fill", "stroke", "stroke-width", "opacity"];

/** One session card in a pane that holds a slot — a card in a slot is what
 *  the Cards row's column badge reports on. */
function deckShape(): Record<string, unknown> {
  return {
    cards: [{ id: "A", componentId: "session", title: "Session", closable: true }],
    panes: [
      {
        id: "p1",
        position: { x: 40, y: 40 },
        size: { width: 900, height: 700 },
        cardIds: ["A"],
        activeCardId: "A",
        title: "",
        acceptsFamilies: ["standard"],
        slot: 0,
      },
    ],
    activePaneId: "p1",
    hasFocus: true,
  };
}

function frame(decoded: Record<string, unknown>): SessionDriveAction {
  return { op: "ingestFrame", feedId: FEED_CODE_OUTPUT, decoded: { tug_session_id: SID, ...decoded } };
}

const exists = (sel: string): string =>
  `document.querySelector(${JSON.stringify(sel)}) !== null`;

describe.skipIf(!SHOULD_RUN)("at0799 — style census: receipts and notices", () => {
  test(
    "the usage-limit notice, an Overview post and the Cards badges match their recording",
    async () => {
      const app = await launchTugApp({ testName: "at0799-style-census-receipts-and-notices" });
      try {
        await app.seedDeckState({ state: deckShape(), focusCardId: "A" });
        await app.bindSession("A", { tugSessionId: SID });
        await app.awaitEngineReady("A", { timeoutMs: 15_000 });

        const reading: CensusReading = {};

        // ── The usage-limit notice, drawn from a refused turn. ──
        await app.driveSessionBatch("A", [
          { op: "send", text: "hi" },
          frame({
            type: "content_block_start",
            msg_id: MSG,
            block_index: 0,
            kind: "text",
            api_error: {
              error: "rate_limit",
              rate_limit_info: {
                status: "rejected",
                resetsAt: 1793074200,
                rateLimitType: "five_hour",
                overageStatus: "rejected",
                isUsingOverage: false,
              },
            },
          }),
          frame({
            type: "assistant_text",
            seq: 0,
            rev: 0,
            status: "complete",
            msg_id: MSG,
            block_index: 0,
            text: "You've hit your session limit · resets 9:10pm",
            is_partial: false,
          }),
          frame({ type: "turn_complete", seq: 0, msg_id: MSG, result: "success" }),
        ]);
        const card = app.body("A");
        await card.waitForCondition<boolean>(exists(NOTICE), { timeoutMs: 10_000 });
        Object.assign(reading, await censusRead(card, [
          { selector: NOTICE },
          { selector: `${NOTICE} .tug-inline-alert-body` },
          { selector: `${NOTICE} .tug-inline-alert-icon` },
          { selector: `${NOTICE} .tug-inline-alert-title` },
          { selector: `${NOTICE} .tug-inline-alert-message` },
        ]));

        // ── The Cards rail: the space tally and the session row's badge. ──
        await app.dispatchControlAction("toggle-cards");
        const cards = kindBody(app, "cards");
        await cards.waitForCondition<boolean>(exists(".cards-list .cards-row"), { timeoutMs: 10_000 });
        await cards.waitForCondition<boolean>(
          `${exists(TALLY)} && ${exists(COLUMN_BADGE)}`,
          { timeoutMs: 10_000 },
        );
        Object.assign(reading, await censusRead(cards, [
          { selector: TALLY },
          { selector: COLUMN_BADGE, properties: COLUMN_BADGE_TOKENS },
          { selector: `${COLUMN_BADGE} [data-region="top"]`, properties: SLICE_PAINT },
          { selector: `${COLUMN_BADGE} [data-region="middle"]`, properties: SLICE_PAINT },
          { selector: `${COLUMN_BADGE} [data-region="bottom"]`, properties: SLICE_PAINT },
        ]));

        // ── The Overview: one observer post. ──
        await app.nativeKey("o", ["cmd", "ctrl"]);
        const overview = kindBody(app, "overview");
        await overview.waitForCondition<boolean>(
          exists('[data-testid="overview-transcript"]'),
          { timeoutMs: 10_000 },
        );
        const post = { id: 7_990_001, at_ms: 1_754_600_000_000, author: "observer", body: "Post one: the census reads this.", refs: [] };
        await overview.evalJS<boolean>(
          `window.__tug.publishOverviewPost(${JSON.stringify(JSON.stringify(post))})`,
        );
        await overview.waitForCondition<boolean>(exists(POST), { timeoutMs: 10_000 });
        Object.assign(reading, await censusRead(overview, [
          {
            selector: POST,
            properties: [
              "--tugx-transcript-controls-margin-top",
              "--tugx-transcript-icon-column-width",
              "--tugx-transcript-icon-column-gap",
              "grid-template-columns",
              "column-gap",
              "font-size",
            ],
          },
          { selector: `${POST} .tug-transcript-entry__identifier` },
          { selector: `${POST} .tug-transcript-entry__timestamp`, properties: ["font-size", "font-variant-numeric", "color"] },
          { selector: `${POST} .tug-transcript-entry__icon svg`, properties: ["width", "height", "margin-top"] },
          { selector: `${POST} .tug-transcript-entry__controls`, properties: ["display", "flex-direction", "align-items", "gap", "margin-top"] },
        ]));

        expectCensus("receipts-and-notices", reading);
      } finally {
        await app.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
